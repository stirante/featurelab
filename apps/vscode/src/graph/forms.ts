// forms.ts -- the node property form: the panel that edits ONE node's fields.
//
// This module is headless on purpose. It turns a wire.GraphNode into a serializable
// description of the controls to draw, validates and normalizes what comes back, and emits a
// change event carrying the new Fields object. It does not touch the DOM, it does not write
// files, and it does not fetch anything -- the webview renders the description, and whoever
// owns the round-trip writer takes the emitted Fields. Keeping it that way is what makes the
// interesting parts (the version gates, the typed editors, the create path) testable in plain
// node, which is the environment apps/vscode/test runs in.
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT. The engine gates which JSON keys a feature type
// accepts on the file's `format_version` band (see typeCatalog.ts, and
// featurelab-go/features/formatversion.go for the mechanism). A form that offers a key the
// pack's version does not accept produces a file the GAME refuses to load -- and the refusal
// happens at world-load time, far from the editor, with nothing tying it back to the field the
// author filled in. So the field set here is a function of (typeId, formatVersion), and a key
// that exists only above the file's version is SHOWN AND DISABLED with the reason, never
// silently hidden and never silently offered. Both of the quiet options teach the author
// something false.
//
// WHAT THIS FORM DOES NOT COVER: the delegation keys. `places_feature`,
// `conditional_features`, the aggregate/sequence/weighted lists, scatter's `iterations` and the
// single-child references are EDGES in wire.Graph -- wire/graph.go defines GraphNode.Fields as
// "the node's own JSON body minus the delegation keys" -- and they are owned by the graph
// canvas, not by this panel. One arriving in Fields anyway is a contract violation, and is
// reported as one rather than drawn as a stray text box.
/** Keys that are the node's IDENTITY rather than its settings, and so belong to no form.
 *
 * `description` holds the identifier (the rename control's business) and, on the types that
 * delegate from it, `places_feature` (an edge). Neither is editable here, so drawing it as an
 * uncatalogued extra was a permanent false alarm on every node in every pack. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['description'])

import {
  DELEGATION_KEYS,
  type CoverageRow,
  type FieldSpec,
  type FormatVersion,
  type PaletteEntry,
  type ResolvedField,
  ABSENT_FORMAT_VERSION,
  buildTypePalette,
  parseFormatVersion,
  resolveFields,
  typeAvailableAt,
  typeSpec,
} from './typeCatalog.js'

// ---------------------------------------------------------------------------
// The control descriptions the webview renders
// ---------------------------------------------------------------------------

/** What to draw for one field. A discriminated union rather than a kind string plus a bag of
 * optional props, so the renderer's switch is exhaustive and a new kind cannot be forgotten.
 *
 * `block` and `blockList` deliberately carry no "name" affordance in their description: a block
 * descriptor has THREE legal spellings in the engine (a bare name, `{name, states}`, and
 * `{tags: "<query>"}`) and a control that only offers a name box silently loses the other two,
 * both of which appear in real packs. `spellings` names them so the renderer offers a switch. */
export type Editor =
  | { control: 'block'; spellings: readonly ['name', 'name-and-states', 'tags'] }
  | { control: 'block-list'; spellings: readonly ['name', 'name-and-states', 'tags'] }
  /** A weighted block list. The engine has TWO entry spellings and they are NOT
   * interchangeable at a given key: growing_plant's `body_blocks`/`head_blocks` are arrays of
   * `[block, weight]` PAIRS and refuse anything else, while single_block's `places_block`
   * array is made of `{block, weight}` OBJECTS. `entrySpellings` names the one(s) this key
   * accepts, so the renderer offers the shape the game will load rather than the other one.
   *
   * `scalar` is whether the key ALSO accepts a single block descriptor written in place of the
   * array -- `places_block` does, at every version; the growing-plant lists never do. A control
   * that only offers array rows silently loses the spelling almost every real pack uses. */
  | { control: 'weighted-block-list'; entrySpellings: readonly WeightedEntrySpelling[]; scalar: boolean }
  /** The engine's Range type. `objectKeys` is `range_min`/`range_max` and NOT `min`/`max`, and
   * the renderer must label it that way -- given `{min, max}` the engine does not reject the
   * field, it logs a missing-member error and carries on with a degenerate {0, 0} range, so
   * the file loads in game and then does nothing. */
  | { control: 'range'; objectKeys: readonly ['range_min', 'range_max']; spellings: readonly ['number', 'array', 'object'] }
  | { control: 'select'; options: readonly string[] }
  | { control: 'checkbox' }
  | { control: 'number'; integer: boolean; min?: number; max?: number }
  /** A number OR a Molang expression string, both legal for the same key. The control must not
   * force one: a spin-box would make the string form unreachable, and several of these keys are
   * written as expressions in real packs. */
  | { control: 'molang-or-number' }
  /** A percent (number or Molang) or a `{numerator, denominator}` fraction. */
  | { control: 'chance'; fraction: readonly FormRow[] }
  /** A number, a Molang string, or a `{distribution, extent}` object -- scatter's per-axis
   * parameter. */
  | { control: 'coordinate'; object: readonly FormRow[] }
  | { control: 'text' }
  | { control: 'group'; rows: readonly FormRow[] }
  | { control: 'group-list'; entry: readonly FormRow[] }
  /** The escape hatch: a raw-JSON text box, used only where the real sub-schema could not be
   * sourced. `reason` is shown verbatim, because "this is not described yet" is a far more
   * useful thing to tell an author than an empty panel. */
  | { control: 'json'; reason: string }

/** One row of the form: the spec, the current value, the control, and anything wrong with it. */
export interface FormRow {
  spec: ResolvedField
  /** Path into GraphNode.Fields. A change event carries this so the writer knows where to put
   * the value without re-deriving it from the label. */
  path: readonly (string | number)[]
  /** The value as it sits in Fields today; undefined when the key is absent. Absent and
   * `null` are different -- the first means "the engine's default applies", the second means
   * the author wrote null -- so they are not collapsed. */
  value: unknown
  present: boolean
  editor: Editor
  /** Validation messages for THIS row's current value. Empty when the value is fine or absent. */
  problems: readonly string[]
}

/** Something the author needs told about the form as a whole, rather than about one field. */
export interface FormNotice {
  level: 'error' | 'warning' | 'info'
  message: string
  /** The field or key the notice is about, when there is one. */
  key?: string
}

export interface NodeFormInput {
  /** wire.GraphNode.TypeID. Empty for an unresolved node, which has no form. */
  typeId: string
  /** wire.GraphNode.FormatVersion -- the file's own declared version, which is what decides the
   * field set. A string as it arrives on the wire, or the array spelling as it appears in a
   * raw pack file. */
  formatVersion?: string | readonly number[]
  /** wire.GraphNode.Fields. */
  fields?: Readonly<Record<string, unknown>>
  /** wire.GraphNode.Coverage / CoverageNote. Shown on the form for a partial type, for the same
   * reason the palette shows it at create time: the author is authoring against a port with
   * known gaps. */
  coverage?: string
  coverageNote?: string
}

export interface NodeForm {
  typeId: string
  formatVersion: FormatVersion
  coverage?: string
  coverageNote?: string
  /** Every catalogued field, in catalogue order, including the ones this file's version does
   * not accept (those carry availability !== 'available' and an availabilityNote).
   *
   * ONE EXCEPTION, and it is a deliberate narrowing of what this array used to mean. Where the
   * catalogue holds SEVERAL specs under the SAME KEY -- which is how it records a key whose
   * accepted spellings widen at a version, as opposed to a key that was renamed -- only the
   * spec this file's version accepts appears here. The engine has one key there, not two, and
   * two identically-labelled rows of which one silently does nothing is a worse lie than
   * anything else this module guards against. The fact of the split is stated instead as an
   * info notice keyed on that key.
   *
   * A genuine RENAME is untouched, because a rename has two DIFFERENT keys: both rows appear,
   * and the superseded one carries its availabilityNote naming the spelling that works. */
  rows: readonly FormRow[]
  /** Keys present in Fields that the catalogue does not know. Rendered as raw JSON rather than
   * dropped: the catalogue being incomplete must never silently delete an author's data. */
  extras: readonly FormRow[]
  notices: readonly FormNotice[]
}

// ---------------------------------------------------------------------------
// Value helpers -- the spellings the engine actually accepts
// ---------------------------------------------------------------------------

/** Reads a text box for a Molang-or-number field. A value that parses cleanly as a number
 * becomes a NUMBER; anything else stays a string, which is exactly the engine's own split (a
 * JSON number is a constant with no compile step, a JSON string is compiled as Molang). The
 * empty string yields undefined, meaning "remove the key", rather than the string "" -- which
 * would compile to a Molang program and is never what clearing a box means. */
export function parseMolangOrNumber(text: string): number | string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  // Number() accepts "" and whitespace as 0, which is why the emptiness test comes first, and
  // accepts "0x10" and "1e3" -- both of which JSON.parse would also accept as numbers, so
  // agreeing with it here keeps the round-trip honest.
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber) && /^[-+]?(\d|\.\d)/u.test(trimmed)) return asNumber
  return trimmed
}

/** The three legal spellings of the engine's Range type, normalized to a [min, max] pair, or
 * null when the value is not a range at all. `{min, max}` is deliberately NOT accepted: the
 * engine reads only `range_min`/`range_max`, and given min/max it logs a missing-member error
 * and substitutes a degenerate {0, 0} -- so a file spelled that way loads in game and silently
 * does nothing. Reporting it is the whole point of having a typed range editor. */
export function readRange(value: unknown): { min: number; max: number } | null {
  if (typeof value === 'number') return { min: value, max: value }
  if (Array.isArray(value)) {
    if (value.length !== 2) return null
    const [lo, hi] = value
    if (typeof lo !== 'number' || typeof hi !== 'number') return null
    return { min: lo, max: hi }
  }
  if (isPlainObject(value)) {
    const lo = value['range_min']
    const hi = value['range_max']
    if (typeof lo === 'number' && typeof hi === 'number') return { min: lo, max: hi }
  }
  return null
}

/** Whether `value` is one of the three block-descriptor spellings AsBlockDescriptor accepts. */
export function isBlockDescriptor(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (!isPlainObject(value)) return false
  if (typeof value['tags'] === 'string') return true
  if (typeof value['name'] !== 'string') return false
  const states = value['states']
  return states === undefined || states === null || isPlainObject(states)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** How ONE entry of a weighted block list is written. Both spellings are real and neither is a
 * relaxation of the other -- each belongs to a different key. */
export type WeightedEntrySpelling = 'pair' | 'object'

/** What one weighted-block-list key accepts, read off that key's own parser rather than guessed
 * from the shared `weightedBlockList` kind. The two keys the catalogue gives that kind do NOT
 * accept the same shapes, and a validator that takes their union is loose in both directions
 * while a validator that picks one is wrong for the other. */
export interface WeightedListRule {
  /** Entry spellings accepted inside the array, in the order to offer them. */
  entrySpellings: readonly WeightedEntrySpelling[]
  /** Whether a single block descriptor may stand in place of the array entirely. */
  scalar: boolean
  /** Whether an entry written in the object spelling must carry `weight`. */
  weightRequired: boolean
  /** Whether a negative weight is refused. One key checks the sign, the other does not. */
  negativeWeightRejected: boolean
}

const ENTRY_SHAPE: Readonly<Record<WeightedEntrySpelling, { one: string; many: string }>> = {
  pair: { one: 'a [block, weight] pair', many: '[block, weight] pairs' },
  object: { one: 'a {block, weight} object', many: '{block, weight} objects' },
}

/** The per-key rules, each read out of the key's own parser in featurelab-go/features:
 *
 *  - `places_block` (single_block): the value may be a bare block descriptor, an object
 *    descriptor, or an ARRAY whose entries are `{block, weight}`. A nested `[block, weight]`
 *    pair is not one of the shapes that parser reads. `weight` inside an entry is required by
 *    the schema -- the engine's own loader refuses a file whose entry omits it -- and a
 *    negative weight is refused outright. The array spelling is the only part of this that is
 *    gated on format_version (1.21.40); the descriptor spellings work at every version, which
 *    is why a bare block name is NOT a problem at a modern version.
 *  - `body_blocks` / `head_blocks` (growing_plant): the value must be a non-empty ARRAY, and
 *    every entry must be a `[block, weight]` pair of exactly two values. There is no descriptor
 *    shorthand, no object entry, and no default for an absent weight -- a one-element entry is
 *    simply the wrong length. The weight's sign is not checked.
 *
 * A key that is not in this table gets the permissive default below: a rule that is not established
 * must never turn into a red mark on an author's file. */
const WEIGHTED_LIST_RULES: Readonly<Record<string, WeightedListRule>> = {
  places_block: { entrySpellings: ['object'], scalar: true, weightRequired: true, negativeWeightRejected: true },
  body_blocks: { entrySpellings: ['pair'], scalar: false, weightRequired: true, negativeWeightRejected: false },
  head_blocks: { entrySpellings: ['pair'], scalar: false, weightRequired: true, negativeWeightRejected: false },
}

const PERMISSIVE_WEIGHTED_LIST_RULE: WeightedListRule = {
  entrySpellings: ['pair', 'object'],
  scalar: true,
  weightRequired: false,
  negativeWeightRejected: false,
}

/** The spellings `key` accepts as a weighted block list. */
export function weightedBlockListRule(key: string): WeightedListRule {
  return WEIGHTED_LIST_RULES[key] ?? PERMISSIVE_WEIGHTED_LIST_RULE
}

/** The engine reads a weight through one number helper, and that helper takes a JSON number OR
 * a boolean (true is 1, false is 0). Nothing else. Rejecting the boolean here would be a red
 * mark on a file that loads. */
function isEngineNumber(value: unknown): boolean {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function entryShapes(rule: WeightedListRule, count: 'one' | 'many'): string {
  const parts = rule.entrySpellings.map((spelling) => ENTRY_SHAPE[spelling][count])
  return parts.length <= 1 ? (parts[0] ?? ENTRY_SHAPE.object[count]) : parts.join(' or ')
}

const DESCRIPTOR_SPELLINGS = 'a block name string, {name, states?}, or {tags}'
/** The same three spellings, without the trailing comma-or, for use in front of another "or". */
const DESCRIPTOR_SPELLINGS_INLINE = 'a block name string, {name, states?} or {tags}'

/** Everything wrong with a weighted block list, judged against THIS key's own rule. */
function validateWeightedBlockList(key: string, value: unknown): string[] {
  const rule = weightedBlockListRule(key)
  const problems: string[] = []
  if (!Array.isArray(value)) {
    if (rule.scalar && isBlockDescriptor(value)) return problems
    problems.push(
      rule.scalar
        ? `"${key}" must be ${DESCRIPTOR_SPELLINGS_INLINE}, or a non-empty array of ${entryShapes(rule, 'many')}.`
        : `"${key}" must be a non-empty array of ${entryShapes(rule, 'many')}.`,
    )
    return problems
  }
  if (value.length === 0) {
    problems.push(`"${key}" must not be an empty array -- the engine refuses a list with no entries, and the file does not load.`)
    return problems
  }
  for (const [i, entry] of value.entries()) {
    const at = `"${key}[${i}]"`
    if (Array.isArray(entry)) {
      if (!rule.entrySpellings.includes('pair')) {
        problems.push(`${at} is a [block, weight] pair, but entries of this key are written as ${entryShapes(rule, 'many')}.`)
        continue
      }
      if (entry.length !== 2) {
        problems.push(`${at} must be ${ENTRY_SHAPE.pair.one} of exactly two values -- a block and its weight.`)
        continue
      }
      if (!isBlockDescriptor(entry[0])) problems.push(`${at}[0] is not ${DESCRIPTOR_SPELLINGS}.`)
      if (!isEngineNumber(entry[1])) problems.push(`${at}[1] (weight) must be a number.`)
      else if (rule.negativeWeightRejected && typeof entry[1] === 'number' && entry[1] < 0) {
        problems.push(`${at}[1] (weight) must not be negative.`)
      }
      continue
    }
    if (isPlainObject(entry) && 'block' in entry) {
      if (!rule.entrySpellings.includes('object')) {
        problems.push(`${at} is a {block, weight} object, but entries of this key are written as ${entryShapes(rule, 'many')}.`)
        continue
      }
      if (!isBlockDescriptor(entry['block'])) problems.push(`${at}.block is not ${DESCRIPTOR_SPELLINGS}.`)
      const weight = entry['weight']
      if (weight === undefined) {
        if (rule.weightRequired) {
          problems.push(`${at} has no weight. The schema requires one on this spelling, and the game refuses a file that leaves it out.`)
        }
      } else if (!isEngineNumber(weight)) {
        problems.push(`${at}.weight must be a number.`)
      } else if (rule.negativeWeightRejected && typeof weight === 'number' && weight < 0) {
        problems.push(`${at}.weight must not be negative.`)
      }
      continue
    }
    problems.push(
      isBlockDescriptor(entry)
        ? `${at} is a bare block descriptor. Every entry of this array carries its own weight, so write it as ${entryShapes(rule, 'one')}; the game refuses the bare form here.`
        : `${at} must be ${entryShapes(rule, 'one')}.`,
    )
  }
  return problems
}

/** What `spec` accepts at the version it was resolved against, as prose for a notice. Used
 * where the catalogue splits one key across a version boundary and the form has to say, in one
 * sentence, what the surviving row will take. */
function acceptedSpellingText(spec: ResolvedField): string {
  if (spec.kind === 'weightedBlockList') {
    const rule = weightedBlockListRule(spec.key)
    const arrayText = `a non-empty array of ${entryShapes(rule, 'many')}`
    return rule.scalar ? `${DESCRIPTOR_SPELLINGS_INLINE}, or ${arrayText}` : arrayText
  }
  if (spec.kind === 'block') {
    return `${DESCRIPTOR_SPELLINGS_INLINE} -- and only that: an array is refused here, which leaves the required key unset so the file does not load`
  }
  return `the ${spec.kind} spelling`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** What is wrong with `value` for `spec`, as messages fit to show next to the control. Only
 * checks this catalogue can actually source -- kind, the schema's own numeric bounds, and enum
 * membership. It deliberately does NOT invent constraints: a bound that is not established,
 * enforced here, costs the author a file the game would have accepted. */
export function validateValue(spec: FieldSpec, value: unknown): string[] {
  if (value === undefined) {
    return spec.required ? [`"${spec.key}" is required by the engine's schema for this type.`] : []
  }
  const problems: string[] = []
  switch (spec.kind) {
    case 'block':
      if (!isBlockDescriptor(value)) {
        problems.push(`"${spec.key}" must be a block name string, {name, states?}, or {tags}.`)
      }
      break
    case 'blockList':
      // The engine has two list readers: one that takes a bare descriptor as shorthand for a
      // one-element list, and one that takes an array and nothing else. `acceptsSingle` marks the
      // keys read by the first; every other key is refused unless it is an array.
      if (!Array.isArray(value)) {
        if (spec.acceptsSingle === true && isBlockDescriptor(value)) break
        problems.push(
          isBlockDescriptor(value)
            ? `"${spec.key}" must be a list of blocks. The game refuses a single block here, so write it as a one-entry list.`
            : `"${spec.key}" must be a list of blocks.`,
        )
        break
      }
      for (const [i, el] of value.entries()) {
        if (!isBlockDescriptor(el)) problems.push(`"${spec.key}[${i}]" is not a block name string, {name, states?}, or {tags}.`)
      }
      break
    case 'weightedBlockList':
      // The two keys the catalogue gives this kind accept DIFFERENT shapes, so the rule is read
      // per key rather than from the kind. See WEIGHTED_LIST_RULES for each one's source.
      problems.push(...validateWeightedBlockList(spec.key, value))
      break
    case 'range': {
      if (readRange(value) === null) {
        const usesMinMax = isPlainObject(value) && ('min' in value || 'max' in value)
        problems.push(
          usesMinMax
            ? `"${spec.key}" uses {min, max}, but this field is a range and the engine reads only {range_min, range_max}. Given min/max it logs an error and silently substitutes a zero-width range, so the file would load in game and then do nothing.`
            : `"${spec.key}" must be a number, a 2-element [min, max] array, or a {range_min, range_max} object.`,
        )
      }
      break
    }
    case 'enum':
      if (typeof value !== 'string' || (spec.values !== undefined && !spec.values.includes(value))) {
        problems.push(`"${spec.key}" must be one of: ${(spec.values ?? []).join(', ')}.`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`"${spec.key}" must be true or false.`)
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`"${spec.key}" must be a number.`)
        break
      }
      if (spec.kind === 'integer' && !Number.isInteger(value)) problems.push(`"${spec.key}" must be a whole number.`)
      if (spec.min !== undefined && value < spec.min) problems.push(`"${spec.key}" must be at least ${spec.min} (the game's own schema bound).`)
      if (spec.max !== undefined && value > spec.max) problems.push(`"${spec.key}" must be at most ${spec.max} (the game's own schema bound).`)
      break
    case 'molangOrNumber':
      // `null` is accepted because the engine reads it as the constant 0 rather than refusing
      // it. Flagging it would paint a red mark on a file that loads and works, which is the
      // failure this validator has to avoid above all others: a panel that is wrong about a
      // correct file teaches its author to stop reading what it says.
      if (
        value !== null &&
        typeof value !== 'number' &&
        typeof value !== 'string' &&
        typeof value !== 'boolean'
      ) {
        problems.push(`"${spec.key}" must be a number or a Molang expression string.`)
      }
      break
    case 'chance':
      if (isPlainObject(value)) {
        if (typeof value['numerator'] !== 'number' || typeof value['denominator'] !== 'number') {
          problems.push(`"${spec.key}" as an object must be {numerator, denominator}.`)
        }
      } else if (typeof value !== 'number' && typeof value !== 'string') {
        problems.push(`"${spec.key}" must be a percent (number or Molang string) or a {numerator, denominator} object.`)
      }
      break
    case 'string':
      if (typeof value !== 'string') problems.push(`"${spec.key}" must be a string.`)
      break
    case 'group':
      if (!isPlainObject(value)) problems.push(`"${spec.key}" must be an object.`)
      break
    case 'groupList':
      if (!Array.isArray(value)) problems.push(`"${spec.key}" must be an array.`)
      break
    case 'coordinate':
      if (isPlainObject(value)) {
        if (typeof value['distribution'] !== 'string') problems.push(`"${spec.key}" as an object needs a "distribution" kind.`)
        const extent = value['extent']
        if (!Array.isArray(extent) || extent.length !== 2) problems.push(`"${spec.key}.extent" must be a 2-element [min, max] array.`)
      } else if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
        problems.push(`"${spec.key}" must be a number, a Molang string, or a {distribution, extent} object.`)
      }
      break
    case 'json':
      // Nothing to check: the shape was never sourced, so any assertion here would be invented.
      break
  }
  return problems
}

// ---------------------------------------------------------------------------
// Building the form
// ---------------------------------------------------------------------------

const BLOCK_SPELLINGS = ['name', 'name-and-states', 'tags'] as const
const RANGE_OBJECT_KEYS = ['range_min', 'range_max'] as const
const RANGE_SPELLINGS = ['number', 'array', 'object'] as const

function editorFor(spec: ResolvedField, value: unknown, path: readonly (string | number)[]): Editor {
  switch (spec.kind) {
    case 'block':
      return { control: 'block', spellings: BLOCK_SPELLINGS }
    case 'blockList':
      return { control: 'block-list', spellings: BLOCK_SPELLINGS }
    case 'weightedBlockList': {
      const rule = weightedBlockListRule(spec.key)
      return { control: 'weighted-block-list', entrySpellings: rule.entrySpellings, scalar: rule.scalar }
    }
    case 'range':
      return { control: 'range', objectKeys: RANGE_OBJECT_KEYS, spellings: RANGE_SPELLINGS }
    case 'enum':
      return { control: 'select', options: spec.values ?? [] }
    case 'boolean':
      return { control: 'checkbox' }
    case 'number':
    case 'integer':
      return { control: 'number', integer: spec.kind === 'integer', ...(spec.min === undefined ? {} : { min: spec.min }), ...(spec.max === undefined ? {} : { max: spec.max }) }
    case 'molangOrNumber':
      return { control: 'molang-or-number' }
    case 'chance':
      return { control: 'chance', fraction: subRows(spec.entry, isPlainObject(value) ? value : {}, path) }
    case 'coordinate':
      return { control: 'coordinate', object: subRows(spec.entry, isPlainObject(value) ? value : {}, path) }
    case 'string':
      return { control: 'text' }
    case 'group':
      return { control: 'group', rows: subRows(spec.entry, isPlainObject(value) ? value : {}, path) }
    case 'groupList':
      // The entry rows describe the SHAPE of one element, so they are built against an empty
      // object: a list editor adds and removes elements, and each element is rendered from this
      // template rather than from a row per existing element.
      return { control: 'group-list', entry: subRows(spec.entry, {}, [...path, 0]) }
    case 'json':
      return {
        control: 'json',
        reason: spec.unsourced ?? 'This key\'s shape is not described by this editor yet, so it is edited as raw JSON rather than as a set of possibly-wrong controls.',
      }
  }
}

/** Sub-fields always arrive already resolved -- resolveFields tags a group's `entry` in the same
 * pass as its parent, because the version gate reaches inside (may_attach_to.diagonal is the
 * live case). */
function subRows(
  entry: readonly ResolvedField[] | undefined,
  parentValue: Readonly<Record<string, unknown>>,
  parentPath: readonly (string | number)[],
): FormRow[] {
  if (entry === undefined) return []
  return entry.map((sub) => makeRow(sub, parentValue, parentPath))
}

function makeRow(spec: ResolvedField, container: Readonly<Record<string, unknown>>, parentPath: readonly (string | number)[]): FormRow {
  // An empty key is the "this list holds bare values, not objects" marker used by extent and
  // search_volume.min/max -- the row addresses the container itself.
  const path = spec.key === '' ? [...parentPath] : [...parentPath, spec.key]
  const present = spec.key === '' ? true : Object.prototype.hasOwnProperty.call(container, spec.key)
  const value = spec.key === '' ? undefined : container[spec.key]
  return {
    spec,
    path,
    value,
    present,
    editor: editorFor(spec, value, path),
    // A key the file's version does not accept is not validated against: complaining that a
    // disabled field has the wrong type is noise on top of the one message that matters.
    problems: spec.availability === 'available' ? validateValue(spec, present ? value : undefined) : [],
  }
}

/** Collapses the catalogue's several specs for ONE KEY down to the row this file's version
 * accepts, and says so once as a notice.
 *
 * The catalogue records two different things with the same mechanism, and only one of them
 * should reach the panel as two rows:
 *
 *   A RENAME is two DIFFERENT keys -- `vertical_search_range` becoming `search_range`. No
 *   version accepts both names, the author has to change the spelling in the file, and both
 *   rows must be drawn so the old one can carry the note naming the new one. Untouched here.
 *
 *   A VERSION-SPLIT SPELLING is one key written twice -- `places_block`, which is a single
 *   block descriptor at every version and ALSO accepts a weighted array from 1.21.40 onward.
 *   The key was never renamed and never went away. Drawing it as two rows puts two controls
 *   under one label, one of which writes nothing the author can see, and the older one carries
 *   a note saying the key "was dropped", which is not what happened.
 *
 * So: where several rows share a key and exactly one of them is available, the available one is
 * the row. The other is not hidden information -- what it carried was the version boundary, and
 * that is stated instead as an info notice on the key, together with what the surviving row
 * actually accepts. Where the group does NOT have exactly one available member, nothing is
 * collapsed: picking a winner there would be inventing one. */
function collapseVersionSplitKeys(
  rows: readonly FormRow[],
  versionText: string,
  notices: FormNotice[],
): FormRow[] {
  const byKey = new Map<string, FormRow[]>()
  for (const candidate of rows) {
    const group = byKey.get(candidate.spec.key)
    if (group === undefined) byKey.set(candidate.spec.key, [candidate])
    else group.push(candidate)
  }
  const dropped = new Set<FormRow>()
  for (const [key, group] of byKey) {
    if (group.length < 2) continue
    const live = group.filter((candidate) => candidate.spec.availability === 'available')
    if (live.length !== 1) continue
    const keep = live[0] as FormRow
    for (const candidate of group) {
      if (candidate !== keep) dropped.add(candidate)
    }
    const boundary =
      keep.spec.since ??
      keep.spec.until ??
      group.map((candidate) => candidate.spec.since ?? candidate.spec.until).find((v) => v !== undefined)
    notices.push({
      level: 'info',
      key,
      message:
        `"${key}" is ONE key, not two: what changes ${boundary === undefined ? 'across a format_version boundary' : `at format_version ${boundary}`} ` +
        `is which spellings it accepts, not the name. This file declares ${versionText}, where the key accepts ` +
        `${acceptedSpellingText(keep.spec)}. The form shows a single row for it, so there is no second control ` +
        `under the same label that quietly does nothing.`,
    })
  }
  if (dropped.size === 0) return [...rows]
  return rows.filter((candidate) => !dropped.has(candidate))
}

/** Builds the whole panel for one node.
 *
 * Throws nothing on a malformed format_version -- an unparseable version is reported as a
 * notice and the form falls back to the unversioned reading, which is what
 * FormatVersion.AtLeastOrUnversioned argues for: the file already has one loud problem, and
 * deleting every modern field from the author's form is a second, quieter punishment for it. */
export function buildNodeForm(input: NodeFormInput): NodeForm {
  const notices: FormNotice[] = []
  let formatVersion: FormatVersion = ABSENT_FORMAT_VERSION
  try {
    formatVersion = parseFormatVersion(input.formatVersion ?? null)
  } catch (err) {
    notices.push({
      level: 'error',
      message: `This file's format_version could not be read (${err instanceof Error ? err.message : String(err)}). Fields are shown as if the file declared no version; fix format_version before trusting which keys are offered.`,
      key: 'format_version',
    })
  }
  if (!formatVersion.present && input.formatVersion !== undefined) {
    // Distinguished from "the key was never passed": a file that declares nothing does not load
    // in the game at all, and saying so once here is cheaper than letting the author discover it
    // from a world that generates nothing.
    notices.push({
      level: 'warning',
      message: 'This file declares no format_version. The game requires the key and refuses the file without it. Fields are offered on their own terms rather than as if the file were older than everything.',
      key: 'format_version',
    })
  }

  const fields: Readonly<Record<string, unknown>> = input.fields ?? {}
  const spec = typeSpec(input.typeId)
  if (spec === undefined) {
    notices.push({
      level: 'warning',
      message: `"${input.typeId}" has no field catalogue in this editor, so every key is edited as raw JSON. That is a gap in the catalogue, not a statement that the type has no fields.`,
      key: input.typeId,
    })
  }
  if (!typeAvailableAt(input.typeId, formatVersion)) {
    notices.push({
      level: 'error',
      message: `"${input.typeId}" is not registered at format_version ${formatVersion.raw}. A file declaring this version names a type that, as far as its schema band is concerned, does not exist, and the file does not load.`,
      key: input.typeId,
    })
  }
  // The coverage note is deliberately NOT a notice.
  //
  // It is a fact about how much of the engine this tool reproduces, not about the author's file:
  // identical on every node of the type, unchanged by anything they write, and on some types it
  // runs to a page and a half. As a notice it sat at the top of the panel above the controls, in
  // the narrowest column on screen, on every single selection -- which is how a reader learns to
  // skip whatever is at the top of this panel, including the notices under it that ARE about
  // their file and are worth reading.
  //
  // It is still carried on the form (`coverage` / `coverageNote`) and still reaches the author
  // where it costs nothing: the documentation panel behind the section `?`. And the palette still
  // refuses to CREATE a type the engine cannot build, which is the one moment the fact changes a
  // decision rather than describing one.

  const catalogued = resolveFields(input.typeId, formatVersion).map((field) => makeRow(field, fields, []))

  // A key can legitimately appear twice in the catalogue when a version gate splits it -- two
  // spellings of places_block, two of the snap search range. Only one of those is ever
  // available, so the "known keys" set is the union of both spellings and an extra is anything
  // outside it. Built from the UNCOLLAPSED rows, so that the older spelling of a key still
  // counts as known even when the form no longer draws a row for it.
  const known = new Set(catalogued.map((row) => row.spec.key))

  const rows = collapseVersionSplitKeys(catalogued, formatVersion.present ? formatVersion.raw : '(absent)', notices)
  const extras: FormRow[] = []
  for (const key of Object.keys(fields)) {
    if (known.has(key)) continue
    if (IDENTITY_KEYS.has(key)) {
      // Silently, and that is the point. `description` reached the form on EVERY node of every
      // type, where it drew a raw-JSON box plus a paragraph explaining that the catalogue might
      // be missing it -- a standing "there is something wrong here" on a pack where nothing is
      // wrong. It is not a field the catalogue forgot: it is the node's identity. The identifier
      // belongs to the rename control, and `places_feature` inside it is an edge. Nothing in it
      // is editable here, so there is nothing to say about it either, and saying it anyway on
      // every node is how an author learns to stop reading this panel.
      continue
    }
    if (DELEGATION_KEYS.has(key)) {
      notices.push({
        level: 'warning',
        message: `"${key}" is a delegation key and belongs to an edge, not to this form (wire.GraphNode.Fields is the body MINUS the delegation keys). It is being left alone here; edit it on the graph instead.`,
        key,
      })
      continue
    }
    const extraSpec: ResolvedField = {
      key,
      kind: 'json',
      required: false,
      source: 'builder',
      availability: 'available',
      unsourced: `"${key}" is not in this editor's catalogue for ${input.typeId}. It may be a key the catalogue is missing, or one the engine does not have -- this editor cannot tell which, so the value is shown as raw JSON and left untouched rather than dropped.`,
    }
    extras.push(makeRow(extraSpec, fields, []))
  }

  // Exactly-one-of groups (tree's trunk and canopy variants). The engine fails the build for
  // both violations, so these are errors rather than warnings.
  for (const group of spec?.exclusiveGroups ?? []) {
    const members = (spec?.fields ?? []).filter((field) => field.exclusiveGroup === group.name)
    const written = members.filter((field) => Object.prototype.hasOwnProperty.call(fields, field.key)).map((field) => field.key)
    if (written.length > 1) {
      notices.push({ level: 'error', message: `Only one ${group.name} variant may be present, found: ${written.join(', ')}.` })
    } else if (written.length === 0 && group.required) {
      notices.push({ level: 'error', message: `One ${group.name} variant is required. ${group.doc}` })
    }
  }

  return {
    typeId: input.typeId,
    formatVersion,
    ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
    ...(input.coverageNote === undefined ? {} : { coverageNote: input.coverageNote }),
    rows,
    extras,
    notices,
  }
}

// ---------------------------------------------------------------------------
// The create path
// ---------------------------------------------------------------------------

/** The palette of types a new node may be created as, built from the engine's own coverage
 * table. Re-exported through this module so a caller building the create UI has one import.
 *
 * Types marked `missing` or `out_of_scope` are dropped -- never offered, in any state -- and a
 * `partial` one carries what its coverage note says is approximated. The author is authoring
 * against a port with known gaps, and the point of choosing is the one moment where knowing
 * that is free. */
export function createPalette(coverage: readonly CoverageRow[], formatVersion?: string | readonly number[]): PaletteEntry[] {
  let version: FormatVersion = ABSENT_FORMAT_VERSION
  try {
    version = parseFormatVersion(formatVersion ?? null)
  } catch {
    // An unreadable version is reported by buildNodeForm, not twice here; the palette falls
    // back to the unversioned reading, which offers everything rather than nothing.
  }
  return buildTypePalette(coverage, version)
}

/** Seeds the Fields of a node being created from scratch: every key this type's schema REQUIRES
 * at this format_version, and nothing else.
 *
 * Required keys get a placeholder of the right SHAPE rather than a plausible value -- `0` for a
 * number, `""` for a block descriptor, the first enum member for an enum. That is deliberate:
 * the file is invalid until the author fills them in, the form's own validation says so
 * immediately, and a placeholder that looked like a real value would let a half-written node
 * read as finished. Optional keys are left absent, because absence and an explicitly written
 * default are not the same thing to the engine (features/coverage.go has several entries whose
 * whole point is that distinction) and the author should choose. */
export function seedNewNodeFields(typeId: string, formatVersion?: string | readonly number[]): Record<string, unknown> {
  let version: FormatVersion = ABSENT_FORMAT_VERSION
  try {
    version = parseFormatVersion(formatVersion ?? null)
  } catch {
    // Fall through to the unversioned reading -- see buildNodeForm.
  }
  const seeded: Record<string, unknown> = {}
  for (const field of resolveFields(typeId, version)) {
    if (!field.required || field.availability !== 'available') continue
    if (field.exclusiveGroup !== undefined) continue // one-of groups are a choice, not a default
    seeded[field.key] = placeholderFor(field)
  }
  return seeded
}

function placeholderFor(spec: ResolvedField): unknown {
  switch (spec.kind) {
    case 'block':
      return ''
    case 'blockList':
    case 'weightedBlockList':
    case 'groupList':
      return []
    case 'range':
      return { range_min: 0, range_max: 0 }
    case 'enum':
      return spec.values?.[0] ?? ''
    case 'boolean':
      return false
    case 'number':
    case 'integer':
      // Clamp into the schema's own bound when there is one, so the seeded file does not start
      // with a value the engine would reject outright (several bounds start at 1).
      return spec.min ?? 0
    case 'molangOrNumber':
    case 'chance':
    case 'coordinate':
      return 0
    case 'string':
      return ''
    case 'group':
      return Object.fromEntries((spec.entry ?? []).filter((sub) => sub.required).map((sub) => [sub.key, placeholderFor(sub)]))
    case 'json':
      return {}
  }
}

// ---------------------------------------------------------------------------
// Editing -- immutable updates plus a change event
// ---------------------------------------------------------------------------

export interface FieldChange {
  /** The top-level key of GraphNode.Fields this touched, which is what a round-trip writer
   * keys on. */
  key: string
  /** The full path, so a nested edit can be written back without re-deriving it. */
  path: readonly (string | number)[]
  previous: unknown
  value: unknown
  /** The whole Fields object after the edit. */
  fields: Readonly<Record<string, unknown>>
}

export type FieldChangeListener = (change: FieldChange) => void

/** Writes `value` at `path` in a COPY of `root`, cloning only the containers along the path.
 * `undefined` deletes the key (or splices the array element), which is how a form clears an
 * optional field back to "absent" -- distinct from writing null, which the engine reads as a
 * value the author wrote. */
export function setAtPath(
  root: Readonly<Record<string, unknown>>,
  path: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) throw new Error('setAtPath needs a non-empty path')
  const head = path[0]
  if (typeof head !== 'string') throw new Error('the first path segment must be a key of Fields')
  const clone: Record<string, unknown> = { ...root }
  if (path.length === 1) {
    if (value === undefined) delete clone[head]
    else clone[head] = value
    return clone
  }
  const child = clone[head]
  clone[head] = setIn(child, path.slice(1), value)
  return clone
}

function setIn(container: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const head = path[0]
  if (head === undefined) return value
  if (typeof head === 'number') {
    const arr = Array.isArray(container) ? [...(container as unknown[])] : []
    if (path.length === 1) {
      if (value === undefined) arr.splice(head, 1)
      else arr[head] = value
      return arr
    }
    arr[head] = setIn(arr[head], path.slice(1), value)
    return arr
  }
  const obj: Record<string, unknown> = isPlainObject(container) ? { ...container } : {}
  if (path.length === 1) {
    if (value === undefined) delete obj[head]
    else obj[head] = value
    return obj
  }
  obj[head] = setIn(obj[head], path.slice(1), value)
  return obj
}

/** The panel's live state: a form, the Fields behind it, and a change event.
 *
 * Deliberately not an EventEmitter subclass. src/engineProcess.ts extends EventEmitter because
 * it is a process with many event kinds; this has exactly one, and a typed listener list means
 * a caller cannot mistype the event name -- which is the failure mode an untyped emitter has
 * and no test catches. */
export class NodeFormController {
  private input: NodeFormInput
  private fields: Record<string, unknown>
  private current: NodeForm
  private listeners: FieldChangeListener[] = []

  constructor(input: NodeFormInput) {
    this.input = input
    this.fields = { ...(input.fields ?? {}) }
    this.current = buildNodeForm({ ...input, fields: this.fields })
  }

  /** The form as it stands. Rebuilt on every edit, because a value change can change what else
   * is valid (a `may_attach_to` appearing brings its own sub-rows with it). */
  get form(): NodeForm {
    return this.current
  }

  /** The Fields object as it stands -- what a writer serializes back into the file. */
  get value(): Readonly<Record<string, unknown>> {
    return this.fields
  }

  /** Writes a value and emits a change. Passing `undefined` removes the key, which is how an
   * optional field returns to "absent" rather than to its default written out. */
  setValue(path: readonly (string | number)[], value: unknown): FieldChange {
    const head = path[0]
    if (typeof head !== 'string') throw new Error('the first path segment must be a key of Fields')
    const previous = readAtPath(this.fields, path)
    this.fields = setAtPath(this.fields, path, value)
    this.current = buildNodeForm({ ...this.input, fields: this.fields })
    const change: FieldChange = { key: head, path, previous, value, fields: this.fields }
    for (const listener of this.listeners) listener(change)
    return change
  }

  /** Registers a change listener. Returns a disposer, matching the shape VS Code's own
   * subscriptions use so a caller can push it straight into context.subscriptions. */
  onChange(listener: FieldChangeListener): { dispose: () => void } {
    this.listeners.push(listener)
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((candidate) => candidate !== listener)
      },
    }
  }
}

/** Reads the value at `path`, or undefined when any container along the way is missing. */
export function readAtPath(root: Readonly<Record<string, unknown>>, path: readonly (string | number)[]): unknown {
  let cursor: unknown = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) return undefined
      cursor = (cursor as unknown[])[segment]
      continue
    }
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}
