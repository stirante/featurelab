// inspector.ts -- the node inspector: the sidebar that EDITS one feature's settings.
//
// forms.ts already decided what control every field gets (see its `Editor` union). This file is
// the other half of that contract: it draws each of those cases for real. A renderer that
// switches on `editor.control` and falls through to `JSON.stringify` for everything composite
// throws the whole catalogue away.
//
// WHAT THIS FILE OWNS, AND WHAT IT DOES NOT. It owns DOM. It does not own state: it mutates no
// value, keeps no copy of the node's fields to write back later, and never touches disk. Every
// edit leaves here as an InspectorChange -- a path plus a value, `undefined` meaning "remove the
// key" -- and the host writes the file, re-reads it, and calls update() with a freshly built
// NodeForm. The file on disk is the source of truth.
//
// THE SHAPE OF THE PANEL, which is the part that was rebuilt and the part worth stating:
//
//   1. A ROW IS `label | control`, ONE LINE. A right-aligned key in a fixed gutter, then the
//      control filling the rest, then the remove glyph. Nested groups indent and keep the shape.
//      Rows carry NO prose: no hint under the control, no default spelled out, no note about how
//      the value is written. The panel is labels and controls.
//   2. THE ONE-SENTENCE EXPLANATION IS A TOOLTIP. Every row carries its key and the catalogue's
//      `summary` as a native `title`, which shows after the usual hover delay, costs no height,
//      is never mispositioned and cannot cover the control it describes. An earlier design
//      painted explanatory paragraphs over the form on hover; it hid the controls it was
//      explaining, twice, and is gone.
//   3. ONE `?` PER SECTION opens the documentation PANEL: a third region over the canvas side of
//      the editor, beside the form rather than inside it, holding every field of that section --
//      its detail, its defaults, its version band, and every value of every enum. The form does
//      not move when it opens. See "The documentation panel" below.
//   4. PROBLEMS STAY. A diagnostic about the author's own file -- a value the engine refuses, a
//      key this format_version drops -- is the one thing worth a line, and it gets one line,
//      under the row it is about.
//
// THREE DECISIONS THAT PREDATE THE LAYOUT AND STILL HOLD:
//
//   - AN EXCLUSIVE GROUP IS ONE CHOICE, NOT N FIELDS. tree_feature's eight trunk keys are one
//     `variant` select, whose answer's body is edited underneath. Switching removes the old key
//     and starts the new one, which is two writes, which is why a change carries a LIST.
//   - AN UNSET OPTIONAL FIELD IS NOT A ROW. What is drawn is what is SET, what is REQUIRED, what
//     the catalogue marks PRIMARY, and anything carrying a problem. The rest is behind an "Add a
//     field" select at the foot of the section; choosing one reveals its control and writes
//     NOTHING until a value is typed. A primary field (FieldSpec.primary -- a scatter's axes, a
//     rule's iteration count) is the one the author sets almost every time, so it is drawn even
//     when absent: an empty control whose placeholder is the documented default. Drawing it is
//     not an edit either; the key is written when a value is typed and removed when it is cleared.
//   - A VALUE THE GRAPH CARRIES ON AN EDGE IS STILL SHOWN WHERE THE FILE KEEPS IT. A scatter's
//     `iterations` is not in the catalogue on purpose -- it lives on the edge to the placed
//     feature, whose chip on the canvas opens a full Molang editor -- but the author does not
//     know to click an edge, and the one value their `distribution` holds was invisible in the
//     section named after it. So the host hands the edge's OWN MolangEdgeEditor in (`edgeFields`)
//     and this panel draws the same control over it, in the section the file's shape puts the
//     key in: one value, two places to reach it, never two values. The write goes through the
//     editor, to the path the graph builder reported, and this panel never derives that path.
//   - ABSENT IS NOT DEFAULT. Every control has a reachable "not written" state and reaching it
//     emits `undefined`. A boolean is three pills, not a checkbox: `may_attach_to.auto_rotate`
//     absent behaves as TRUE, and an author who cannot tell the states apart cannot write either
//     file on purpose.
//
// COLOUR. Every colour comes from a `--vscode-*` custom property through the `--fli-*` variables
// INSPECTOR_STYLESHEET declares, form controls included -- an `<input>` that sets no colours
// renders as a white native widget in a dark panel.
//
// UNTRUSTED TEXT. Every string drawn here comes out of a pack's own JSON. Nothing is assigned
// through innerHTML -- textContent and setAttribute only.
import {
  isBlockDescriptor,
  parseMolangOrNumber,
  readAtPath,
  readRange,
  validateValue,
  type Editor,
  type FormNotice,
  type FormRow,
  type NodeForm,
  type WeightedEntrySpelling,
} from './forms.js'
import { typeSpec, type ExclusiveGroup, type FieldKind } from './typeCatalog.js'
import { lookupFieldDoc, lookupValueDoc, type DocEntry } from './docs/catalog.js'
import { createMolangField, type MolangField } from './molangField.js'
import type { MolangEdgeEditor } from './molangEdge.js'

// ---------------------------------------------------------------------------
// What an edit is
// ---------------------------------------------------------------------------

/** One write. `path` is a FormRow.path -- a path into wire.GraphNode.Fields exactly as the row
 * carries it, so the host never re-derives a location from a label.
 *
 * `undefined` REMOVES the key (or splices the array element). It is not the same edit as writing
 * null: the engine reads a written null as a value the author chose and an absent key as "the
 * default applies", and several of those defaults are the opposite of null's effect. */
export interface FieldEdit {
  path: readonly (string | number)[]
  value: unknown
}

/** One user action, which is usually one write and occasionally two.
 *
 * The list exists for the exclusive-group swap: choosing `acacia_trunk` while `trunk` is written
 * has to remove one key and add the other, and those two writes are one intention. */
export interface InspectorChange {
  edits: readonly FieldEdit[]
  /** The control the action came from, for a host that wants to log it or re-focus it. */
  path: readonly (string | number)[]
  /** One line saying what the user did, fit for a status line or an undo entry. */
  label: string
}

export type InspectorChangeListener = (change: InspectorChange) => void

// ---------------------------------------------------------------------------
// Pure model -- nothing below here touches the DOM until the stylesheet
// ---------------------------------------------------------------------------

/** A stable string for a path, used to key the local UI state. JSON.stringify rather than a
 * join, because there is no separator character a block state or a feature id cannot contain. */
export function pathKey(path: readonly (string | number)[]): string {
  return JSON.stringify(path)
}

/** The dotted path the documentation catalogue is keyed by: array indices dropped, because it
 * documents `replace_rules.may_replace` once rather than once per entry. */
export function docPathOf(path: readonly (string | number)[]): string {
  return path.filter((segment): segment is string => typeof segment === 'string').join('.')
}

// ---------------------------------------------------------------------------
// The catalogue's Markdown
// ---------------------------------------------------------------------------
//
// docs/catalog.ts writes a four-construct subset: paragraphs, inline code spans, `**strong**`
// (exactly two uses, both the "Not established." lead), and whole-paragraph `_emphasis_` for the
// schema-facts line. Parsed here rather than with a library because the panel's
// Content-Security-Policy forbids remote code and the subset is this small.
//
// Two rules are not negotiable. EMPHASIS IS A PROPERTY OF THE PARAGRAPH, never of a run inside
// one: the prose is ABOUT a snake_case schema, so a CommonMark `_..._` rule would italicise the
// middle of `min_sides_must_attach`. And AN UNPAIRED DELIMITER IS TEXT: `can_place_on_*` stays
// the three words it looks like.

/** One run inside a paragraph. `text` is literal and is written to the DOM with textContent. */
export interface DocSpan {
  readonly kind: 'text' | 'code' | 'strong'
  readonly text: string
}

/** One paragraph of documentation. */
export interface DocBlock {
  /** The whole paragraph was wrapped in underscores -- the catalogue's schema-facts line. */
  readonly emphasis: boolean
  readonly spans: readonly DocSpan[]
}

/** The runs of one paragraph. A code span binds before a strong run, as CommonMark has it. An
 * opener with no closer is not markup and stays in the text. */
export function parseDocSpans(text: string): DocSpan[] {
  const spans: DocSpan[] = []
  let plain = ''
  const flush = (): void => {
    if (plain !== '') spans.push({ kind: 'text', text: plain })
    plain = ''
  }
  let at = 0
  while (at < text.length) {
    const char = text[at] as string
    if (char === '`') {
      const end = text.indexOf('`', at + 1)
      if (end > at + 1) {
        flush()
        spans.push({ kind: 'code', text: text.slice(at + 1, end) })
        at = end + 1
        continue
      }
    } else if (char === '*' && text.startsWith('**', at)) {
      const end = text.indexOf('**', at + 2)
      if (end > at + 2) {
        flush()
        spans.push({ kind: 'strong', text: text.slice(at + 2, end) })
        at = end + 2
        continue
      }
    }
    plain += char
    at += 1
  }
  flush()
  return spans
}

/** The paragraphs of one catalogue string. A single newline inside a paragraph is a wrap, not a
 * break, and collapses to a space the way Markdown does. */
export function parseDocMarkdown(source: string): DocBlock[] {
  const blocks: DocBlock[] = []
  for (const chunk of source.split(/\n[^\S\n]*\n/u)) {
    const text = chunk.replace(/\s*\n\s*/gu, ' ').trim()
    if (text === '') continue
    const wrapped = text.length > 1 && text.startsWith('_') && text.endsWith('_')
    blocks.push({ emphasis: wrapped, spans: parseDocSpans(wrapped ? text.slice(1, -1) : text) })
  }
  return blocks
}

/** A catalogue string split into a title and its body: every string renderFieldDoc produces
 * opens with the key as a lone code span, and that is a heading rather than a first line. */
export function readDocMarkdown(source: string): { title: string | null; blocks: DocBlock[] } {
  const blocks = parseDocMarkdown(source)
  const first = blocks[0]
  const only = first?.spans.length === 1 ? first.spans[0] : undefined
  if (first !== undefined && !first.emphasis && only !== undefined && only.kind === 'code') {
    return { title: only.text, blocks: blocks.slice(1) }
  }
  return { title: null, blocks }
}

/** A catalogue sentence with its markup removed, for a `title` attribute -- which renders none
 * of it and would otherwise show the author literal backticks. */
export function plainDocText(source: string): string {
  return parseDocMarkdown(source)
    .map((block) => block.spans.map((span) => span.text).join(''))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Rebuilds the node's Fields object out of the form's own rows. A group LIST needs the whole
 * array to draw its elements while the form carries a template for one element only, and every
 * top-level row does carry its full value, so the object is recoverable here. */
export function fieldsOf(form: NodeForm): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of [...form.rows, ...form.extras]) {
    const key = row.path[0]
    if (typeof key !== 'string' || !row.present) continue
    out[key] = row.value
  }
  return out
}

/** Whether this row's key is actually written in the file. `present` is the answer for every
 * ordinary row; the empty-key rows forms.ts uses for bare-value lists address their container
 * rather than a key of it, and for those the value decides. */
export function isSet(row: FormRow): boolean {
  return row.spec.key === '' ? row.value !== undefined : row.present
}

/** One exclusive group, resolved: the members, which one is written, and whether more than one
 * is. `required` and `doc` come from the type's own TypeSpec. */
export interface ExclusiveChoice extends ExclusiveGroup {
  members: readonly FormRow[]
  /** The single written member, or null when none is. */
  selected: string | null
  /** Every written member when there is more than one -- a state the engine refuses. */
  conflicts: readonly string[]
}

/** The exclusive groups of `typeId`, each carrying its rows in catalogue order. */
export function exclusiveChoices(rows: readonly FormRow[], typeId: string): ExclusiveChoice[] {
  const declared = new Map((typeSpec(typeId)?.exclusiveGroups ?? []).map((group) => [group.name, group]))
  const byName = new Map<string, FormRow[]>()
  const order: string[] = []
  for (const row of rows) {
    const name = row.spec.exclusiveGroup
    if (name === undefined) continue
    const existing = byName.get(name)
    if (existing !== undefined) {
      existing.push(row)
      continue
    }
    byName.set(name, [row])
    order.push(name)
  }
  return order.map((name) => {
    const members = byName.get(name) ?? []
    const written = members.filter(isSet).map((row) => row.spec.key)
    const group = declared.get(name)
    return {
      name,
      required: group?.required ?? false,
      doc: group?.doc ?? '',
      members,
      selected: written[0] ?? null,
      conflicts: written.length > 1 ? written : [],
    }
  })
}

/** The writes that switch an exclusive group from one variant to another. The old key is
 * REMOVED and the new one starts as an empty body: the variants do not share a sub-schema, and
 * a body moved across would be dropped by the engine unread. */
export function variantSwapEdits(previous: string | null, next: string | null): FieldEdit[] {
  const edits: FieldEdit[] = []
  if (previous !== null && previous !== next) edits.push({ path: [previous], value: undefined })
  if (next !== null && next !== previous) edits.push({ path: [next], value: {} })
  return edits
}

// ---- the engine's spellings, read and written -----------------------------

export type RangeSpelling = 'number' | 'array' | 'object'

/** Which of the three legal Range spellings a value is written in, or null when it is not a range
 * at all. Read rather than assumed: an editor that always writes the object spelling turns every
 * `[1, 3]` in a pack into a diff nobody asked for. */
export function rangeSpellingOf(value: unknown): RangeSpelling | null {
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return readRange(value) === null ? null : 'array'
  if (readRange(value) !== null) return 'object'
  return null
}

/** A range written back in `spelling`. The object spelling is `{range_min, range_max}` and NEVER
 * `{min, max}`: given min/max the engine reports the members as missing and carries on with a
 * zero-width range, so the file loads in the game and the feature then does nothing. */
export function writeRangeValue(min: number, max: number, spelling: RangeSpelling): unknown {
  if (spelling === 'number' && min === max) return min
  if (spelling === 'array') return [min, max]
  return { range_min: min, range_max: max }
}

export type BlockSpelling = 'name' | 'name-and-states' | 'tags'

/** A block descriptor taken apart into the three spellings the engine accepts. */
export interface BlockView {
  spelling: BlockSpelling
  name: string
  states: readonly (readonly [string, unknown])[]
  tags: string
}

export function readBlockValue(value: unknown): BlockView {
  if (typeof value === 'string') return { spelling: 'name', name: value, states: [], tags: '' }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const tags = record['tags']
    if (typeof tags === 'string') return { spelling: 'tags', name: '', states: [], tags }
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    const states = record['states']
    const pairs: (readonly [string, unknown])[] =
      typeof states === 'object' && states !== null && !Array.isArray(states)
        ? Object.entries(states as Record<string, unknown>).map(([key, entry]) => [key, entry] as const)
        : []
    return {
      spelling: pairs.length > 0 || Object.prototype.hasOwnProperty.call(record, 'states') ? 'name-and-states' : 'name',
      name,
      states: pairs,
      tags: '',
    }
  }
  return { spelling: 'name', name: '', states: [], tags: '' }
}

/** The descriptor a BlockView writes, or undefined when it is empty -- an empty control means "no
 * block", which removes the key rather than writing `""`. */
export function writeBlockValue(view: BlockView): unknown {
  if (view.spelling === 'tags') return view.tags.trim() === '' ? undefined : { tags: view.tags }
  if (view.spelling === 'name-and-states') {
    const states: Record<string, unknown> = {}
    for (const [key, value] of view.states) {
      if (key.trim() === '') continue
      states[key] = value
    }
    if (view.name.trim() === '' && Object.keys(states).length === 0) return undefined
    return Object.keys(states).length > 0 ? { name: view.name, states } : { name: view.name }
  }
  return view.name.trim() === '' ? undefined : view.name
}

/** A block state's value, typed the way the engine's own states are: a boolean, an integer or a
 * string. A box that only produced strings would write `"upside_down_bit": "true"`. */
export function parseStateValue(text: string): string | number | boolean {
  const trimmed = text.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^[-+]?\d+$/u.test(trimmed)) return Number(trimmed)
  return text
}

export function formatStateValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

/** One entry of a weighted block list, in either spelling real packs write: the `{block, weight}`
 * object, and the `[block, weight]` pair growing_plant's lists are written as. */
export interface WeightedEntryView {
  spelling: 'object' | 'pair'
  block: unknown
  weight: number | undefined
}

export function readWeightedEntry(value: unknown): WeightedEntryView {
  if (Array.isArray(value)) {
    const weight = value[1]
    return { spelling: 'pair', block: value[0], weight: typeof weight === 'number' ? weight : undefined }
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const weight = record['weight']
    return { spelling: 'object', block: record['block'], weight: typeof weight === 'number' ? weight : undefined }
  }
  return { spelling: 'object', block: undefined, weight: undefined }
}

/** The spelling a newly ADDED entry is written in: whatever this list is ALREADY written in, when
 * the key accepts it, and otherwise the first spelling the key itself offers. A rejected spelling
 * is never reachable from the Add button. */
export function newWeightedSpelling(accepted: readonly WeightedEntrySpelling[], lastEntry: unknown): WeightedEntrySpelling {
  const fallback = accepted[0] ?? 'object'
  if (lastEntry === undefined) return fallback
  const existing = readWeightedEntry(lastEntry).spelling
  return accepted.includes(existing) ? existing : fallback
}

/** A fresh entry of a weighted block list, written in `spelling` and holding `block`. */
export function newWeightedEntry(spelling: WeightedEntrySpelling, block: unknown = ''): unknown {
  return spelling === 'pair' ? [block, 1] : { block, weight: 1 }
}

export type ChanceSpelling = 'percent' | 'fraction'

export function chanceSpellingOf(value: unknown): ChanceSpelling {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? 'fraction' : 'percent'
}

export type CoordinateSpelling = 'scalar' | 'object'

export function coordinateSpellingOf(value: unknown): CoordinateSpelling {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? 'object' : 'scalar'
}

// ---- paths into real data -------------------------------------------------

function stepInto(container: unknown, segment: string | number): unknown {
  if (Array.isArray(container)) return typeof segment === 'number' ? container[segment] : undefined
  if (typeof container === 'object' && container !== null) return (container as Record<string, unknown>)[String(segment)]
  return undefined
}

/** A path with each all-digit segment turned into a NUMBER wherever the container it addresses is
 * an array. `height_distribution`'s entries are catalogued with the keys "0" and "1" and a pack
 * writes that pair as a JSON array; a write addressed at the STRING "0" of an array turns the
 * array into an object, and the file stops loading. */
export function resolvePath(root: unknown, path: readonly (string | number)[]): (string | number)[] {
  const out: (string | number)[] = []
  let cursor: unknown = root
  for (const segment of path) {
    const resolved = Array.isArray(cursor) && typeof segment === 'string' && /^\d+$/u.test(segment) ? Number(segment) : segment
    out.push(resolved)
    cursor = stepInto(cursor, resolved)
  }
  return out
}

/** Whether `path` names a key (or an index) that actually exists in `root`. */
/**
 * The edit to send so that `value` ends up at `path`, building any container on the way that the
 * file has not got.
 *
 * THE WRITER WILL NOT DO THIS, on purpose: an edit whose path does not exist inserts only ONE
 * level deep, because guessing whether a missing `$.a.b` wants an object or an array is the guess
 * that silently produces a file the game refuses. That reasoning is right, and it is right
 * precisely because the WRITER cannot know. This module can: forms.ts hands over every segment,
 * so a number is an index and a string is a key, and nothing is guessed.
 *
 * Without it, editing anything under an unwritten parent did nothing at all -- a whole class of
 * "the button does not work", reported twice from opposite ends. Adding the first block to a list
 * nobody had written was one. The other shows the size of it: on a fresh scatter `distribution`
 * is absent until something is put in it, so every axis, the chance and the eval order all failed
 * to write and the section looked inert.
 *
 * A REMOVAL is never materialised. Taking a key out of a container that is not there is already
 * done, and creating the container in order to delete from it would write the file to say
 * something the author never said.
 */
export function materialisedEdit(
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): { path: readonly (string | number)[]; value: unknown } {
  if (value === undefined || path.length === 0 || existsAt(root, path.slice(0, -1))) {
    return { path, value }
  }
  // Down to the deepest ancestor the file HAS, then the rest as one value written there.
  let cut = path.length - 1
  while (cut > 0 && !existsAt(root, path.slice(0, cut))) cut--
  let built = value
  for (let i = path.length - 1; i > cut; i--) {
    const segment = path[i] as string | number
    built = typeof segment === 'number' ? [built] : { [segment]: built }
  }
  return { path: path.slice(0, cut + 1), value: built }
}

export function existsAt(root: unknown, path: readonly (string | number)[]): boolean {
  if (path.length === 0) return true
  let parent: unknown = root
  for (const segment of path.slice(0, -1)) parent = stepInto(parent, segment)
  const last = path[path.length - 1] as string | number
  if (Array.isArray(parent)) return typeof last === 'number' && last >= 0 && last < parent.length
  if (typeof parent === 'object' && parent !== null) return Object.prototype.hasOwnProperty.call(parent, String(last))
  return false
}

/** Re-points a template row (and everything nested under it) from one path prefix to another,
 * re-reading value, presence and problems from the real data as it goes. forms.ts builds a
 * group-list's `entry` rows ONCE, against an empty object at index 0; drawing element 3 means
 * re-pointing those rows at `[...listPath, 3]`. */
export function rebindRow(
  row: FormRow,
  oldPrefix: readonly (string | number)[],
  newPrefix: readonly (string | number)[],
  root: Readonly<Record<string, unknown>>,
): FormRow {
  const tail = row.path.slice(oldPrefix.length)
  const path = resolvePath(root, [...newPrefix, ...tail])
  const value = readAtPath(root, path)
  const present = existsAt(root, path)
  return {
    spec: row.spec,
    path,
    value,
    present,
    editor: rebindEditor(row.editor, oldPrefix, newPrefix, root),
    // Same rule forms.ts applies: a key the file's version does not accept is not validated
    // against, because a type complaint on top of "this key does nothing here" is noise.
    problems: row.spec.availability === 'available' ? validateValue(row.spec, present ? value : undefined) : [],
  }
}

function rebindEditor(
  editor: Editor,
  oldPrefix: readonly (string | number)[],
  newPrefix: readonly (string | number)[],
  root: Readonly<Record<string, unknown>>,
): Editor {
  const rebind = (rows: readonly FormRow[]): FormRow[] => rows.map((row) => rebindRow(row, oldPrefix, newPrefix, root))
  switch (editor.control) {
    case 'group':
      return { control: 'group', rows: rebind(editor.rows) }
    case 'group-list':
      return { control: 'group-list', entry: rebind(editor.entry) }
    case 'chance':
      return { control: 'chance', fraction: rebind(editor.fraction) }
    case 'coordinate':
      return { control: 'coordinate', object: rebind(editor.object) }
    default:
      return editor
  }
}

/** The rows for element `index` of the group list rooted at `listPath`. */
export function elementRows(
  template: readonly FormRow[],
  listPath: readonly (string | number)[],
  index: number,
  root: Readonly<Record<string, unknown>>,
): FormRow[] {
  return template.map((row) => rebindRow(row, [...listPath, 0], [...listPath, index], root))
}

export function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** The value a freshly added list element starts as: the empty shape, never a plausible-looking
 * body. An empty object trips the entry's own required-key validation immediately, which is this
 * panel saying "now fill this in" in the only place that can. */
export function newElementValue(template: readonly FormRow[]): unknown {
  const first = template[0]
  if (template.length !== 1 || first === undefined || first.spec.key !== '') return {}
  return first.spec.kind === 'string' || first.spec.kind === 'block' ? '' : 0
}

// ---- what goes where ------------------------------------------------------

/** The field list, split into what is drawn, what is offered, and what this file's version
 * settles so completely that it is not part of the form at all.
 *
 * `shown` is every key that is SET, every key the engine REQUIRES (set or not), every key the
 * catalogue marks PRIMARY (set or not -- see FieldSpec.primary), and anything carrying a
 * problem. `addable` is the rest of the available catalogue, offered by name.
 *
 * `hidden` IS NOT RENDERED ANYWHERE. A key the file did not write and this version does not
 * accept is not a fact about this file; it is a fact about the catalogue, and the place for it is
 * the documentation panel, not a row. The exception: a key that IS WRITTEN and is not accepted is
 * a genuine problem -- the engine logs it by name and drops it -- and is shown in place with its
 * `availabilityNote`. Absent and inapplicable is invisible; present and inapplicable is loud. */
export interface RowSplit {
  shown: readonly FormRow[]
  addable: readonly FormRow[]
  hidden: readonly FormRow[]
}

export function splitRows(rows: readonly FormRow[], revealed: ReadonlySet<string>): RowSplit {
  const shown: FormRow[] = []
  const addable: FormRow[] = []
  const hidden: FormRow[] = []
  for (const row of rows) {
    if (row.spec.exclusiveGroup !== undefined) continue // drawn by its group's chooser instead
    if (row.spec.availability !== 'available') {
      // Primary does not reach in here: a key this version does not accept is not drawn on the
      // strength of being the usual one to set at some other version.
      if (isSet(row)) shown.push(row)
      else hidden.push(row)
      continue
    }
    if (isSet(row) || row.spec.required || row.spec.primary === true || row.problems.length > 0 || revealed.has(pathKey(row.path))) shown.push(row)
    else addable.push(row)
  }
  return { shown, addable, hidden }
}

/** Whether a group list's elements are BARE values small enough to be chips on one line -- a
 * scatter axis's `extent`, a trunk's `intervals`. forms.ts spells a bare-value list as a one-row
 * template with an empty key. */
export function isScalarList(entry: readonly FormRow[]): boolean {
  const only = entry.length === 1 ? entry[0] : undefined
  if (only === undefined || only.spec.key !== '') return false
  switch (only.editor.control) {
    case 'number':
    case 'text':
    case 'molang-or-number':
    case 'select':
      return true
    default:
      return false
  }
}

/** The word for a kind, as a pack author would say it rather than as the catalogue spells it. */
export function kindLabel(kind: FieldKind): string {
  switch (kind) {
    case 'block':
      return 'block'
    case 'blockList':
      return 'blocks'
    case 'weightedBlockList':
      return 'weighted blocks'
    case 'range':
      return 'range'
    case 'enum':
      return 'choice'
    case 'boolean':
      return 'true / false'
    case 'number':
      return 'number'
    case 'integer':
      return 'whole number'
    case 'molangOrNumber':
      return 'number or Molang'
    case 'chance':
      return 'chance'
    case 'string':
      return 'text'
    case 'group':
      return 'group'
    case 'groupList':
      return 'list'
    case 'coordinate':
      return 'axis'
    case 'json':
      return 'raw JSON'
  }
}

/** The glyph the documentation panel marks a kind with. Text, never an image: it inherits the
 * theme's colour and needs no asset. A closed set, one per shape the form distinguishes. */
export function kindGlyph(kind: FieldKind): string {
  switch (kind) {
    case 'enum':
      return '≡'
    case 'boolean':
      return '✓'
    case 'number':
    case 'integer':
      return '#'
    case 'molangOrNumber':
    case 'chance':
    case 'coordinate':
      return 'ƒ'
    case 'range':
      return '↔'
    case 'block':
    case 'blockList':
    case 'weightedBlockList':
      return '▦'
    case 'string':
      return 'Aa'
    case 'group':
      return '{}'
    case 'groupList':
      return '[]'
    case 'json':
      return '⋯'
  }
}

/** Whether a kind takes a Molang expression as well as a number -- the badge the documentation
 * panel shows, because it changes what an author can write. */
export function acceptsMolang(kind: FieldKind): boolean {
  return kind === 'molangOrNumber' || kind === 'chance' || kind === 'coordinate'
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
//
// The panel is a column of SECTIONS, each a heading with one `?` at its right end. What is a
// section is decided here, from the form alone, so it is testable without a browser:
//
//   - GENERAL: every top-level row that is not one of the below -- the scalars, the lists.
//   - one per top-level GROUP row that is drawn (`may_attach_to`, `distribution`): the heading
//     is the key, the rows are its members.
//   - one per EXCLUSIVE CHOICE (`trunk`, `canopy`): a `variant` select, then the written
//     variant's members.
//   - EXTRAS: keys the catalogue does not model, as raw JSON.

export type SectionKind = 'general' | 'group' | 'choice' | 'extras'

export interface InspectorSection {
  /** Stable across redraws; what the open documentation panel is keyed by. */
  key: string
  title: string
  kind: SectionKind
  /** The section's own rows: general's shown rows, a group's members, a choice's written
   * variant's members, the extras. Split with splitRows by the caller that draws them. */
  rows: readonly FormRow[]
  /** The group row itself, for a group section. */
  row?: FormRow
  choice?: ExclusiveChoice
}

/** Whether a top-level row is drawn as a section of its own rather than as a row of General. */
export function isSectionRow(row: FormRow): boolean {
  return row.editor.control === 'group' && row.editor.rows.length > 0
}

export function sectionsOf(form: NodeForm, revealed: ReadonlySet<string>): InspectorSection[] {
  const split = splitRows(form.rows, revealed)
  const choices = exclusiveChoices(form.rows, form.typeId)
  const general: InspectorSection = {
    key: 'general',
    title: 'General',
    kind: 'general',
    // Every non-exclusive row, shown or offered: the drawer splits them again, and the
    // documentation lists the offered ones too.
    rows: form.rows.filter((row) => row.spec.exclusiveGroup === undefined && !(isSectionRow(row) && split.shown.includes(row))),
  }
  const out: InspectorSection[] = [general]
  // Groups and choices interleave in the catalogue's own order, which is the file's.
  const placed = new Set<string>()
  for (const row of form.rows) {
    if (row.spec.exclusiveGroup !== undefined) {
      const choice = choices.find((candidate) => candidate.name === row.spec.exclusiveGroup)
      if (choice === undefined || placed.has(`choice:${choice.name}`)) continue
      placed.add(`choice:${choice.name}`)
      const selected = choice.members.find((member) => member.spec.key === choice.selected)
      out.push({
        key: `choice:${choice.name}`,
        title: choice.name,
        kind: 'choice',
        rows: selected?.editor.control === 'group' ? selected.editor.rows : [],
        choice,
      })
      continue
    }
    if (isSectionRow(row) && split.shown.includes(row) && row.editor.control === 'group') {
      out.push({ key: `group:${pathKey(row.path)}`, title: row.spec.key, kind: 'group', rows: row.editor.rows, row })
    }
  }
  if (form.extras.length > 0) out.push({ key: 'extras', title: 'Keys this editor does not model', kind: 'extras', rows: form.extras })
  return out
}

// ---------------------------------------------------------------------------
// Values the graph carries on an edge
// ---------------------------------------------------------------------------
//
// A scatter's `iterations` is deliberately not in the type catalogue: wire/graph.go carries it on
// the edge to the placed feature, and the canvas draws it as a chip that opens a Molang editor
// with formatting, highlighting and completion. That editor is the ONLY writer of the value --
// the graph builder reports where the expression lives (`iterationsPath`, nested under
// `distribution` or flat on the body, whichever the FILE used) and the editor writes there.
//
// The panel still has to show it. An author who has never clicked an edge opens a fresh scatter,
// sees a `distribution` section, and the one key their file holds in it is not there. So the host
// hands the edge's editor in and this panel draws the same control -- `createMolangField` over the
// same `MolangEdgeEditor` -- as a row of the section the key belongs to. Editing it here IS
// editing it on the edge; nothing is copied and no second write path exists.

/** One expression the graph carries on an edge of this node, handed in by the host. */
export interface InspectorEdgeField {
  /** The key as the file spells it. Only `iterations` today. */
  key: 'iterations'
  /** The edge's live editor -- the SAME instance the canvas's edge panel uses, so the draft, the
   * caret and the committed value are one. The host owns its change subscription and its
   * lifetime; this panel neither subscribes for writes nor disposes it. */
  editor: MolangEdgeEditor
}

/** Which section an edge-borne key is drawn in: the `distribution` section when the form draws
 * one -- the nested shape, format_version 1.21.10 and above -- and General otherwise, where the
 * flat axes sit in an older file. Decided from the form, which is the same thing that decided
 * where the axes went, so the count and the axes are always together. */
export function edgeFieldHome(sections: readonly InspectorSection[]): string {
  const nested = sections.find((section) => section.kind === 'group' && section.row?.spec.key === 'distribution')
  return nested?.key ?? 'general'
}

/** What the panel says about an edge-borne key: its tooltip and its documentation entry. Kept
 * here rather than in docs/catalog.ts, which is keyed by the type catalogue's own paths and
 * checks that every entry is reachable from one -- and this key is, by design, not in it. */
export const EDGE_FIELD_DOCS: Readonly<Record<InspectorEdgeField['key'], { summary: string; detail: string }>> = {
  iterations: {
    summary: 'How many placements this scatter attempts each time it runs.',
    detail:
      'A number, or a Molang expression evaluated once per run. This is the value the connection to the placed feature carries: ' +
      'this box and the chip on the canvas edit one key, in the place the file keeps it. A statement sequence needs a ' +
      '`return <count>` at the end, and zero places nothing.',
  },
}

export function edgeFieldTooltip(key: InspectorEdgeField['key']): string {
  return `${key}\n${plainDocText(EDGE_FIELD_DOCS[key].summary)}`
}

export function edgeFieldDocEntry(key: InspectorEdgeField['key']): DocEntryView {
  const doc = EDGE_FIELD_DOCS[key]
  return {
    name: key,
    parent: '',
    glyph: kindGlyph('molangOrNumber'),
    kindLabel: kindLabel('molangOrNumber'),
    badges: [
      { kind: 'required', label: 'required', title: 'The engine refuses the file without this key.' },
      { kind: 'molang', label: 'Molang', title: 'A number, or a Molang expression evaluated when the feature runs.' },
    ],
    blocks: [...parseDocMarkdown(doc.summary), ...parseDocMarkdown(doc.detail)],
    facts: [],
    values: [],
  }
}

// ---------------------------------------------------------------------------
// The documentation model
// ---------------------------------------------------------------------------
//
// What the panel shows for one section, computed without the DOM. One entry per field, in
// catalogue order, parents before their members; an enum's values are listed under the field,
// every one of them. Version-gated keys the form hides are listed here WITH their band -- this is
// documentation of the type, and the panel is the place a version note belongs.

export interface DocBadge {
  kind: 'required' | 'molang' | 'version' | 'unestablished'
  label: string
  /** A sentence for the badge's own tooltip, where the label alone is terse. */
  title?: string
}

export interface DocValueView {
  name: string
  blocks: readonly DocBlock[]
}

export interface DocEntryView {
  /** The key, or a name for what is being explained. */
  name: string
  /** The dotted path above the key, `x.` for `distribution.x.extent` listed under
   * `distribution`. Empty at the section's own level. */
  parent: string
  glyph: string
  kindLabel: string
  badges: readonly DocBadge[]
  /** Summary, then detail, then the fact sheet's own line, as paragraphs. */
  blocks: readonly DocBlock[]
  /** Plain-text facts: what absent means, the accepted range. */
  facts: readonly string[]
  values: readonly DocValueView[]
}

function entryBlocks(entry: DocEntry | undefined): DocBlock[] {
  if (entry === undefined) return []
  const lead = entry.unestablished === true ? `**Not established.** ${entry.summary}` : entry.summary
  return [...parseDocMarkdown(lead), ...parseDocMarkdown(entry.detail ?? '')]
}

function versionBadges(row: FormRow): DocBadge[] {
  const out: DocBadge[] = []
  const spec = row.spec
  if (spec.since !== undefined) out.push({ kind: 'version', label: `${spec.since}+`, title: `Read from format_version ${spec.since}.` })
  if (spec.until !== undefined) out.push({ kind: 'version', label: `before ${spec.until}`, title: `Dropped at format_version ${spec.until}.` })
  if (spec.introducedInBuild !== undefined) {
    out.push({ kind: 'version', label: `build ${spec.introducedInBuild}`, title: `Appeared in this game build; whether format_version gates it is not established.` })
  }
  return out
}

/** The documentation entry for one row. */
export function docEntryOf(typeId: string, row: FormRow, parent = ''): DocEntryView {
  const doc = lookupFieldDoc(typeId, docPathOf(row.path))
  const spec = row.spec
  const badges: DocBadge[] = []
  if (spec.required) badges.push({ kind: 'required', label: 'required', title: 'The engine refuses the file without this key.' })
  if (acceptsMolang(spec.kind)) badges.push({ kind: 'molang', label: 'Molang', title: 'A number, or a Molang expression evaluated when the feature runs.' })
  badges.push(...versionBadges(row))
  if (doc?.entry?.unestablished === true) badges.push({ kind: 'unestablished', label: 'not established', title: 'What the engine does here was checked and could not be settled.' })

  const blocks: DocBlock[] = entryBlocks(doc?.entry)
  if (spec.doc !== undefined) blocks.push(...parseDocMarkdown(spec.doc))
  if (spec.unsourced !== undefined) blocks.push(...parseDocMarkdown(spec.unsourced))
  if (blocks.length === 0) blocks.push(...parseDocMarkdown('Nothing is written down about this key yet.'))

  const facts: string[] = []
  if (spec.default !== undefined) facts.push(`Absent: ${spec.default}`)
  if (spec.min !== undefined || spec.max !== undefined) facts.push(`Accepted: ${spec.min ?? 'any'} to ${spec.max ?? 'any'}`)

  const values: DocValueView[] =
    row.editor.control === 'select'
      ? row.editor.options.map((option) => ({
          name: option,
          blocks: entryBlocks(lookupValueDoc(typeId, docPathOf(row.path), option)?.entry),
        }))
      : []

  return {
    name: spec.key === '' ? 'each entry' : spec.key,
    parent,
    glyph: kindGlyph(spec.kind),
    kindLabel: kindLabel(spec.kind),
    badges,
    blocks,
    facts,
    values,
  }
}

/** The entries for a list of rows and everything nested under them, parents first. */
export function docEntriesFor(typeId: string, rows: readonly FormRow[], parent = ''): DocEntryView[] {
  const out: DocEntryView[] = []
  for (const row of rows) {
    out.push(docEntryOf(typeId, row, parent))
    const below = row.spec.key === '' ? parent : `${parent}${row.spec.key}.`
    const editor = row.editor
    switch (editor.control) {
      case 'group':
        out.push(...docEntriesFor(typeId, editor.rows, below))
        break
      case 'group-list':
        out.push(...docEntriesFor(typeId, editor.entry, below))
        break
      case 'coordinate':
        out.push(...docEntriesFor(typeId, editor.object, below))
        break
      case 'chance':
        out.push(...docEntriesFor(typeId, editor.fraction, below))
        break
      default:
        break
    }
  }
  return out
}

/** The documentation of one section: for a choice, the choice itself with every variant as a
 * value, then the written variant's fields; for the rest, the section's rows. */
export function sectionDocEntries(form: NodeForm, section: InspectorSection): DocEntryView[] {
  if (section.kind === 'choice' && section.choice !== undefined) {
    const choice = section.choice
    const head: DocEntryView = {
      name: choice.name,
      parent: '',
      glyph: kindGlyph('enum'),
      kindLabel: 'one of these keys',
      badges: choice.required ? [{ kind: 'required', label: 'required', title: 'The type does not load without one of these.' }] : [],
      blocks: choice.doc === '' ? parseDocMarkdown('Exactly one of these keys may be written.') : parseDocMarkdown(choice.doc),
      facts: [],
      values: choice.members.map((member) => ({
        name: member.spec.key,
        blocks: entryBlocks(lookupFieldDoc(form.typeId, docPathOf(member.path))?.entry),
      })),
    }
    const selected = choice.members.find((member) => member.spec.key === choice.selected)
    const selectedIsGroup = selected !== undefined && selected.editor.control === 'group'
    return [head, ...(selected !== undefined && !selectedIsGroup ? [docEntryOf(form.typeId, selected)] : []), ...docEntriesFor(form.typeId, section.rows)]
  }
  if (section.kind === 'group' && section.row !== undefined) {
    return [docEntryOf(form.typeId, section.row), ...docEntriesFor(form.typeId, section.rows)]
  }
  return docEntriesFor(form.typeId, section.rows)
}

/** The row's tooltip: its key on the first line -- the label may be cut short in the gutter --
 * then the catalogue's one sentence, with the Markdown taken out. No sentence, just the key. */
export function tooltipFor(typeId: string, row: FormRow): string {
  const key = row.spec.key === '' ? 'value' : row.spec.key
  const doc = lookupFieldDoc(typeId, docPathOf(row.path))
  const entry = doc?.entry
  const sentence = entry !== undefined ? (entry.unestablished === true ? `Not established: ${entry.summary}` : entry.summary) : (row.spec.doc ?? doc?.spec?.doc)
  return sentence === undefined ? key : `${key}\n${plainDocText(sentence)}`
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

/** Exported as a string rather than added to media/graph.css so this module is one file to add
 * and one file to remove, and so a host that renders the inspector somewhere else gets the
 * styling with the module.
 *
 * Every semantic variable is declared ONCE, on the two root classes, as
 * `var(--vscode-<name>, <fallback>)`, and every rule below reads only `--fli-*`. Inside a webview
 * the host injects the `--vscode-*` properties and updates them live on a theme switch, so the
 * panel follows the theme with no JavaScript. Nothing below the variable block names a colour.
 *
 * Form controls get their colours EXPLICITLY, including the `<select>`'s own option list. A
 * control that inherits nothing renders as a white native widget in a dark panel. */
export const INSPECTOR_STYLESHEET = `
.flg-inspector,
.flg-ins-docs {
  --fli-fg: var(--vscode-foreground, #cccccc);
  --fli-fg-muted: var(--vscode-descriptionForeground, rgba(204, 204, 204, 0.7));
  --fli-bg: var(--vscode-editorWidget-background, #252526);
  --fli-input-bg: var(--vscode-input-background, #3c3c3c);
  --fli-input-fg: var(--vscode-input-foreground, #cccccc);
  --fli-input-border: var(--vscode-input-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  --fli-placeholder: var(--vscode-input-placeholderForeground, rgba(204, 204, 204, 0.5));
  --fli-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
  --fli-focus: var(--vscode-focusBorder, #007fd4);
  --fli-accent: var(--vscode-charts-blue, #4e94ce);
  --fli-button-bg: var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.08));
  --fli-button-fg: var(--vscode-button-secondaryForeground, #cccccc);
  --fli-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
  --fli-code-fg: var(--vscode-textPreformat-foreground, #ce9178);
  --fli-code-bg: var(--vscode-textCodeBlock-background, rgba(255, 255, 255, 0.06));
  --fli-doc-bg: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
  --fli-doc-border: var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  --fli-shadow: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
  --fli-error: var(--vscode-editorError-foreground, #f14c4c);
  --fli-warning: var(--vscode-editorWarning-foreground, #cca700);
  --fli-info: var(--vscode-charts-blue, #4e94ce);
  --fli-font: var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --fli-mono: var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Consolas, monospace);
  --fli-font-size: var(--vscode-font-size, 13px);
  font-family: var(--fli-font);
  font-size: var(--fli-font-size);
  line-height: 1.4;
  color: var(--fli-fg);
}

/* ---- the panel ---------------------------------------------------------------
   The host's column already pads the sidebar, so the panel spends nothing on its own sides: a
   320px column with 12px on each side twice over is 272px of form, and that is where a range
   stops fitting on a line. */
.flg-inspector {
  --flg-ins-gutter: 116px;
  background: var(--fli-bg);
  padding: 0 0 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-x: hidden;
  min-width: 0;
}

.flg-ins-header { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.flg-ins-title {
  margin: 0;
  font-size: 1.05em;
  font-weight: 600;
  /* An identifier has no spaces and will not wrap on its own. */
  overflow-wrap: anywhere;
}
.flg-ins-meta {
  color: var(--fli-fg-muted);
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.flg-ins-type { font-family: var(--fli-mono); color: var(--fli-code-fg); }

/* ---- diagnostics about the author's file ---------------------------------------
   One line each. The level is spelled out as well as coloured: a high-contrast theme flattens
   the palette, and "error" and "note" must not differ by hue alone. A long one folds to its first
   sentence and opens on a click; the whole text is its tooltip either way. */
.flg-ins-notice {
  margin: 0;
  padding: 2px 8px;
  border-left: 2px solid var(--fli-border);
  background: var(--fli-code-bg);
  font-size: 0.92em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.flg-ins-notice-info { border-left-color: var(--fli-info); }
.flg-ins-notice-warning { border-left-color: var(--fli-warning); }
.flg-ins-notice-error { border-left-color: var(--fli-error); }
.flg-ins-notice-label { font-weight: 600; }
details.flg-ins-notice > summary { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
details.flg-ins-notice > summary:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
details.flg-ins-notice > p { margin: 3px 0 2px; white-space: normal; overflow-wrap: anywhere; }

/* ---- sections ------------------------------------------------------------------ */
.flg-ins-section { display: flex; flex-direction: column; min-width: 0; }
.flg-ins-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 2px;
  padding-left: 6px;
  font-size: 0.82em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fli-fg-muted);
  min-width: 0;
}
.flg-ins-section-head > .flg-ins-section-name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.flg-ins-section-head > .flg-ins-x { margin-right: 2px; }
/* The one "?" a section has, at the right end of its heading. */
.flg-ins-help {
  font: inherit;
  font-family: var(--fli-font);
  font-size: 0.95em;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  line-height: 1;
  color: var(--fli-fg-muted);
  background: transparent;
  border: 1px solid var(--fli-border);
  border-radius: 50%;
  width: 1.6em;
  height: 1.6em;
  padding: 0;
  flex: 0 0 auto;
  cursor: pointer;
}
.flg-ins-help:hover { background: var(--fli-hover); color: var(--fli-fg); }
.flg-ins-help:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-help[aria-expanded='true'] { color: var(--fli-fg); border-color: var(--fli-accent); background: var(--fli-code-bg); }

/* ---- one field, one line -------------------------------------------------------
   A row is a grid of three columns: the key, right-aligned in a gutter; the control, filling
   the rest; the remove glyph. Nothing wraps -- a long key is cut short and the tooltip carries
   it whole. The set/unset difference is a left edge rather than a colour on the text, because
   an edge survives a high-contrast theme. */
.flg-ins-row {
  display: grid;
  grid-template-columns: var(--flg-ins-gutter) minmax(0, 1fr) 16px;
  column-gap: 6px;
  align-items: center;
  min-height: 26px;
  padding-left: 4px;
  border-left: 2px solid transparent;
  min-width: 0;
}
/* display:grid on the class would otherwise beat the user agent's [hidden] rule, and a hidden
   diagnostic would paint. */
.flg-ins-row[hidden] { display: none; }
.flg-ins-row[data-state='set'] { border-left-color: var(--fli-accent); }
.flg-ins-row[data-state='unavailable'] { opacity: 0.75; }
.flg-ins-row[data-problem='yes'] { border-left-color: var(--fli-error); }
.flg-ins-row-note { min-height: 18px; }
/* Nesting: the container is a rule, the rows inside it give up as much gutter as the rule and
   its margin took, so every control in the panel starts on the same vertical line. */
.flg-ins-nest {
  display: flex;
  flex-direction: column;
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid var(--fli-border);
  min-width: 0;
}
.flg-ins-row[data-depth='1'] { --flg-ins-gutter: 104px; }
.flg-ins-row[data-depth='2'] { --flg-ins-gutter: 92px; }
.flg-ins-row[data-depth='3'] { --flg-ins-gutter: 80px; }
.flg-ins-row[data-depth='4'] { --flg-ins-gutter: 68px; }
.flg-ins-row[data-depth='5'] { --flg-ins-gutter: 56px; }

.flg-ins-key {
  text-align: right;
  font-size: 0.93em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  color: var(--fli-fg);
}
label.flg-ins-key { cursor: pointer; }
.flg-ins-row[data-state='unset'] > .flg-ins-key { color: var(--fli-fg-muted); }
.flg-ins-row-head > .flg-ins-key { font-weight: 600; }
.flg-ins-req { color: var(--fli-error); margin-left: 1px; }

.flg-ins-control { display: flex; align-items: center; gap: 4px; min-width: 0; }

.flg-ins-input,
.flg-ins-select,
.flg-ins-area {
  font: inherit;
  font-family: var(--fli-mono);
  font-size: 0.95em;
  color: var(--fli-input-fg);
  background: var(--fli-input-bg);
  border: 1px solid var(--fli-input-border);
  border-radius: 2px;
  padding: 0 5px;
  height: 22px;
  box-sizing: border-box;
  min-width: 3ch;
  flex: 1 1 4ch;
  width: auto;
}
.flg-ins-input::placeholder { color: var(--fli-placeholder); }
.flg-ins-input[type='number'] { padding-right: 2px; }
.flg-ins-select option { color: var(--fli-input-fg); background: var(--fli-input-bg); }
.flg-ins-area { height: auto; min-height: 3.2em; padding: 2px 5px; resize: vertical; }
.flg-ins-input:focus-visible,
.flg-ins-select:focus-visible,
.flg-ins-area:focus-visible,
.flg-ins-button:focus-visible {
  outline: 1px solid var(--fli-focus);
  outline-offset: 1px;
}
.flg-ins-input[aria-invalid='true'],
.flg-ins-area[aria-invalid='true'] { border-color: var(--fli-error); }
.flg-ins-input[disabled],
.flg-ins-select[disabled] { opacity: 0.6; }

/* A label that is read but not drawn: the range's two ends keep their names in the
   accessibility tree while the boxes show the names as placeholders. */
.flg-ins-offscreen {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ---- the mode menu ---------------------------------------------------------------
   "How is this value written" -- a range's three spellings, a block's, a chance's -- is a
   secondary question, and it costs one glyph at the end of the row. The native <select> is
   still there, over the glyph, at zero opacity: it takes the click, the keyboard and the
   screen reader, and its option list opens with the full spellings written out. */
.flg-ins-mode {
  position: relative;
  flex: 0 0 auto;
  width: 16px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fli-fg-muted);
  border-radius: 3px;
  font-size: 0.95em;
}
.flg-ins-mode:hover { background: var(--fli-hover); color: var(--fli-fg); }
/* The word for a mode whose value is the rows underneath rather than a box on this line. */
.flg-ins-modeword { color: var(--fli-fg-muted); font-size: 0.88em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.flg-ins-mode:focus-within { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-mode > .flg-ins-spell {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  font: inherit;
}
.flg-ins-spell option { color: var(--fli-input-fg); background: var(--fli-input-bg); }

/* ---- pills: a boolean's three states, a written/unset object, nothing else ------
   The native radio is inside the label and off screen: it keeps arrow-key navigation and the
   announced group, and the label paints the state. */
.flg-ins-seg { display: flex; gap: 2px; min-width: 0; flex: 0 1 auto; }
.flg-ins-seg-option {
  position: relative;
  border: 1px solid var(--fli-border);
  border-radius: 3px;
  padding: 0 6px;
  height: 20px;
  line-height: 20px;
  font-size: 0.85em;
  color: var(--fli-fg-muted);
  cursor: pointer;
  white-space: nowrap;
}
.flg-ins-seg-option:hover { background: var(--fli-hover); }
.flg-ins-seg-option[data-checked='yes'] { color: var(--fli-fg); border-color: var(--fli-accent); background: var(--fli-code-bg); }
.flg-ins-seg-option:focus-within { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-seg-option > input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }

/* ---- buttons ------------------------------------------------------------------- */
.flg-ins-button {
  font: inherit;
  font-size: 0.88em;
  color: var(--fli-button-fg);
  background: var(--fli-button-bg);
  border: 1px solid var(--fli-border);
  border-radius: 3px;
  height: 22px;
  padding: 0 8px;
  cursor: pointer;
  flex: 0 0 auto;
  white-space: nowrap;
}
.flg-ins-button:hover { background: var(--fli-hover); }
/* Add, as a dashed affordance: it is the one button that starts something rather than editing
   what is there. */
.flg-ins-add {
  font: inherit;
  font-size: 0.85em;
  line-height: 1;
  color: var(--fli-accent);
  background: transparent;
  border: 1px dashed var(--fli-border);
  border-radius: 3px;
  height: 20px;
  padding: 0 7px;
  flex: 0 0 auto;
  cursor: pointer;
  white-space: nowrap;
}
.flg-ins-add:hover { background: var(--fli-hover); }
.flg-ins-add:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
/* "Add a field": the offer of every optional key a section is not showing, as one select. */
.flg-ins-addfield {
  font: inherit;
  font-size: 0.88em;
  color: var(--fli-fg-muted);
  background: transparent;
  border: 1px dashed var(--fli-border);
  border-radius: 3px;
  height: 22px;
  padding: 0 4px;
  flex: 0 1 auto;
  width: auto;
  min-width: 0;
  cursor: pointer;
}
.flg-ins-addfield:hover { color: var(--fli-fg); background: var(--fli-hover); }
.flg-ins-addfield:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-addfield option { color: var(--fli-input-fg); background: var(--fli-input-bg); }

/* Remove, as a glyph. In the DOM, in the tab order and carrying "Remove <key>" as its name at
   all times; transparent until the pointer or the keyboard is on the row. */
.flg-ins-x {
  font: inherit;
  font-size: 1em;
  line-height: 1;
  color: var(--fli-fg-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  width: 16px;
  height: 18px;
  padding: 0;
  flex: 0 0 auto;
  cursor: pointer;
  opacity: 0;
}
.flg-ins-row:hover > .flg-ins-x,
.flg-ins-row:focus-within > .flg-ins-x,
.flg-ins-section-head:hover > .flg-ins-x,
.flg-ins-section-head:focus-within > .flg-ins-x,
.flg-ins-chip:hover > .flg-ins-x,
.flg-ins-chip:focus-within > .flg-ins-x,
.flg-ins-x:focus-visible { opacity: 1; }
.flg-ins-x:hover { background: var(--fli-hover); color: var(--fli-fg); }
.flg-ins-x:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }

/* ---- chips: a list of bare numbers on one line ----------------------------------- */
.flg-ins-chips { display: flex; align-items: center; gap: 3px; min-width: 0; flex: 1 1 auto; flex-wrap: wrap; }
.flg-ins-chip { display: flex; align-items: center; min-width: 0; flex: 1 1 3ch; max-width: 9ch; }
.flg-ins-chip > .flg-ins-input { flex: 1 1 3ch; min-width: 3ch; padding: 0 3px; }
.flg-ins-chip > .flg-ins-x { width: 12px; }
.flg-ins-chips > .flg-ins-add { padding: 0 5px; }

/* ---- an expression the graph carries on an edge ----------------------------------------
   The control is molangField.ts's own (its stylesheet is installed by the host beside this
   one), drawn bare: no caption, no checkbox, no note. It is the one control allowed to be
   taller than a row -- it grows to its content up to the ceiling that stylesheet sets, and
   scrolls past it -- so the key sits on its first line rather than floating at its middle.
   The min-height is overridden on the SHARED class, which both painted layers carry, so the
   two stay in the same metrics; see molangField.ts on why that matters. */
.flg-ins-row[data-kind='molang'] { align-items: start; }
.flg-ins-row[data-kind='molang'] > .flg-ins-key { padding-top: 4px; }
.flg-ins-row[data-kind='molang'] > .flg-ins-control { align-items: flex-start; }
.flg-ins-row[data-kind='molang'] > .flg-ins-x { margin-top: 2px; }
.flg-ins-control > .flg-molang-field { flex: 1 1 auto; min-width: 0; }
.flg-inspector .flg-edge-molang { min-height: calc(1.45em + 10px); }
.flg-ins-notes { display: flex; flex-direction: column; min-width: 0; }

/* ---- problems: one line, under the row it is about ---------------------------------- */
.flg-ins-problem,
.flg-ins-warn {
  margin: 0;
  font-size: 0.88em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.flg-ins-problem { color: var(--fli-error); }
.flg-ins-warn { color: var(--fli-warning); }

/* ---- the documentation panel ----------------------------------------------------
   A third region, over the canvas side of the editor: the form stays where it is, full size,
   and the reader compares a value against its explanation with both on screen. Hosted, it
   fills the element it was given; floated, it is fixed over the area to the left of the form. */
.flg-ins-docs {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--fli-bg);
  border-right: 1px solid var(--fli-border);
  box-sizing: border-box;
  overflow: hidden;
  min-width: 0;
}
.flg-ins-docs[data-float='yes'] { position: fixed; box-shadow: 0 0 12px var(--fli-shadow); }
.flg-ins-docs:focus-visible { outline: none; }
.flg-ins-docs-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px 0; flex: 0 0 auto; }
.flg-ins-docs-close {
  font: inherit;
  font-size: 1.05em;
  line-height: 1;
  color: var(--fli-fg-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  width: 26px;
  height: 26px;
  padding: 0;
  cursor: pointer;
  flex: 0 0 auto;
}
.flg-ins-docs-close:hover { background: var(--fli-hover); color: var(--fli-fg); }
.flg-ins-docs-close:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-docs-back {
  font: inherit;
  color: var(--fli-accent);
  background: transparent;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.flg-ins-docs-back:hover { background: var(--fli-hover); }
.flg-ins-docs-back:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-docs-title { margin: 6px 14px 0; font-size: 1.5em; font-weight: 600; overflow-wrap: anywhere; flex: 0 0 auto; }
.flg-ins-docs-sub { margin: 0 14px; color: var(--fli-fg-muted); font-size: 0.92em; overflow-wrap: anywhere; flex: 0 0 auto; }
.flg-ins-docs-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.flg-ins-docs-body > * { max-width: 720px; }

/* The overview: one button per section. */
.flg-ins-docs-item {
  font: inherit;
  text-align: left;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--fli-border);
  border-radius: 4px;
  background: transparent;
  color: var(--fli-fg);
  cursor: pointer;
}
.flg-ins-docs-item:hover { background: var(--fli-hover); }
.flg-ins-docs-item:focus-visible { outline: 1px solid var(--fli-focus); outline-offset: 1px; }
.flg-ins-docs-item > .flg-ins-docs-item-name { font-weight: 600; flex: 1 1 auto; overflow-wrap: anywhere; }
.flg-ins-docs-item > .flg-ins-docs-item-count { color: var(--fli-fg-muted); font-size: 0.9em; flex: 0 0 auto; }
.flg-ins-docs-list { display: flex; flex-direction: column; gap: 6px; }

/* One field. */
.flg-ins-doc { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.flg-ins-doc-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.flg-ins-doc-glyph {
  font-family: var(--fli-mono);
  font-size: 0.8em;
  line-height: 1.6;
  color: var(--fli-fg-muted);
  border: 1px solid var(--fli-border);
  border-radius: 3px;
  min-width: 1.8em;
  padding: 0 3px;
  text-align: center;
  flex: 0 0 auto;
  box-sizing: border-box;
}
.flg-ins-doc-name {
  margin: 0;
  font-family: var(--fli-mono);
  font-size: 1.05em;
  font-weight: 600;
  color: var(--fli-code-fg);
  overflow-wrap: anywhere;
}
.flg-ins-doc-parent { color: var(--fli-fg-muted); font-weight: 400; }
.flg-ins-doc-badges { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 0.85em; color: var(--fli-fg-muted); }
.flg-ins-badge {
  border: 1px solid var(--fli-border);
  border-radius: 3px;
  padding: 0 6px;
  line-height: 1.6;
  font-weight: 600;
  font-size: 0.92em;
}
.flg-ins-badge[data-badge='required'] { color: var(--fli-error); border-color: var(--fli-error); }
.flg-ins-badge[data-badge='molang'] { color: var(--fli-accent); border-color: var(--fli-accent); }
.flg-ins-badge[data-badge='version'] { color: var(--fli-warning); border-color: var(--fli-warning); }
.flg-ins-badge[data-badge='unestablished'] { color: var(--fli-warning); border-color: var(--fli-warning); border-style: dashed; }
.flg-ins-doc-p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
.flg-ins-doc-facts { color: var(--fli-fg-muted); font-style: italic; }
.flg-ins-doc-fact { margin: 0; color: var(--fli-fg-muted); font-size: 0.92em; }
.flg-ins-doc-code {
  font-family: var(--fli-mono);
  color: var(--fli-code-fg);
  background: var(--fli-code-bg);
  border-radius: 2px;
  padding: 0 3px;
}
.flg-ins-doc-p strong { font-weight: 600; color: var(--fli-fg); }
.flg-ins-doc-values {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 0 10px;
  padding-left: 10px;
  border-left: 2px solid var(--fli-border);
}
.flg-ins-doc-value { display: flex; flex-direction: column; gap: 2px; }
.flg-ins-doc-vname { font-family: var(--fli-mono); font-weight: 600; color: var(--fli-fg); overflow-wrap: anywhere; }
`

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface NodeInspectorOptions {
  /** Where every edit goes. Called once per user action; see InspectorChange. */
  onChange: InspectorChangeListener
  /** Shown as the panel's heading -- the node's own id. */
  nodeId?: string
  /** The file the node came from, shown under the heading. */
  file?: string
  /** Accessible name for the panel as a whole. */
  ariaLabel?: string
  /** Where the documentation panel goes when a section's `?` is pressed. It fills this element
   * (`position: absolute; inset: 0`, so the host should be positioned), which is meant to be the
   * canvas-side region the form sits beside. Left out, the inspector floats the panel over the
   * area to the LEFT of its own host element, measured from the host's box -- which in the graph
   * editor's layout is the canvas. */
  docsHost?: HTMLElement
  /** Expressions the graph carries on this node's edges, each with its live editor, so the panel
   * can draw them in the section the file keeps them in. See InspectorEdgeField. The host is
   * expected to build the editor exactly as its edge panel does -- same edge, same
   * `iterationsPath` as `fieldPath`, same annotations -- and to keep its one `onChange`
   * subscription that turns a commit into the file write. */
  edgeFields?: readonly InspectorEdgeField[]
}

export interface NodeInspector {
  /** The element this inspector owns, appended to the host. Do not reparent it. */
  readonly element: HTMLElement
  /** Redraws for a freshly built form. Which optional fields were revealed, which spelling each
   * control is showing and which documentation is open all SURVIVE, because those are the
   * reader's place in the panel.
   *
   * `edgeFields` replaces the set given at construction when passed; left out, the current set
   * is kept -- unless the form is for a different type, whose edges these were not. */
  update(form: NodeForm, edgeFields?: readonly InspectorEdgeField[]): void
  /** The form currently drawn. */
  readonly form: NodeForm
  dispose(): void
}

let instanceCounter = 0

interface SegOption {
  value: string
  label: string
  title?: string
  disabled?: boolean
}

/** Builds the inspector for one node's form. ONE entry point, taking the form and a change
 * callback, returning `element` and `dispose` -- the same shape createGraphView uses. */
export function createNodeInspector(initial: NodeForm, options: NodeInspectorOptions): NodeInspector {
  const uid = `fli${++instanceCounter}`
  const root = document.createElement('div')
  root.className = 'flg-inspector'
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', options.ariaLabel ?? 'Node settings')

  let form = initial
  let fields: Record<string, unknown> = fieldsOf(form)
  let disposed = false
  let ids = 0

  /** Optional fields the author asked for from "Add a field". Local to this panel and NOT a
   * write: revealing a control and writing a key are different acts. */
  const revealed = new Set<string>()
  /** Which notices are unfolded, and which spelling each multi-spelling control is showing. */
  const openSections = new Set<string>()
  const spellings = new Map<string, string>()
  /** The documentation panel: closed, the overview, or one section. */
  let docsView: { section: string | null } | null = null
  let docsEl: HTMLElement | null = null
  let sections: InspectorSection[] = []
  /** The edge-borne expressions the host handed in, the section they are drawn in, and the
   * controls drawn over them this redraw. The controls are this panel's to dispose; the editors
   * are not. */
  let edgeFields: readonly InspectorEdgeField[] = options.edgeFields ?? []
  let edgeHome = 'general'
  let molangViews: MolangField[] = []

  const nextId = (): string => `${uid}-${++ids}`
  const docsId = `${uid}-docs`

  function emit(edits: readonly FieldEdit[], path: readonly (string | number)[], label: string): void {
    if (disposed || edits.length === 0) return
    options.onChange({ edits, path, label })
  }

  /**
   * Writes `value` at `path`, creating whatever containers along the way the file does not have.
   *
   * THE WRITER WILL NOT DO THIS, on purpose: an edit whose path does not exist inserts only ONE
   * level deep, because guessing whether a missing `$.a.b` wants an object or an array is the
   * guess that silently produces a file the game refuses. That reasoning is right, and it is
   * right precisely because the WRITER cannot know. This module can: `forms.ts` hands over every
   * segment's kind, so a number is an index and a string is a key, and nothing is guessed.
   *
   * Without this, editing anything under an unwritten parent did nothing at all. It is a whole
   * class of "the button does not work", and it was reported twice from opposite ends: adding the
   * first block to a list nobody had written, and -- the one that hurts more -- a fresh scatter,
   * where `distribution` is absent until something is put in it, so every axis, the chance and
   * the eval order all failed to write and the section looked inert.
   *
   * Deletes are left alone. Removing a key from a container that is not there is already done.
   */
  function commit(path: readonly (string | number)[], value: unknown, label: string): void {
    const edit = materialisedEdit(fields, path, value)
    emit([edit], path, label)
  }

  /** Adds one entry to a list, creating the list itself when the file has not written it yet. */
  function addToList(row: FormRow, index: number, entry: unknown, label: string): void {
    commit(row.present ? [...row.path, index] : row.path, row.present ? entry : [entry], label)
  }

  // ---- small DOM helpers --------------------------------------------------

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className !== undefined) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function removeButton(ariaLabel: string, onClick: () => void): HTMLButtonElement {
    const node = el('button', 'flg-ins-x', '×')
    node.type = 'button'
    node.setAttribute('aria-label', ariaLabel)
    node.title = ariaLabel
    node.addEventListener('click', onClick)
    return node
  }

  function addButton(label: string, ariaLabel: string, onClick: () => void): HTMLButtonElement {
    const node = el('button', 'flg-ins-add', label)
    node.type = 'button'
    node.setAttribute('aria-label', ariaLabel)
    node.title = ariaLabel
    node.addEventListener('click', onClick)
    return node
  }

  function button(label: string, ariaLabel: string, onClick: () => void, className = 'flg-ins-button'): HTMLButtonElement {
    const node = el('button', className, label)
    node.type = 'button'
    node.setAttribute('aria-label', ariaLabel)
    node.addEventListener('click', onClick)
    return node
  }

  /** The mode menu: a glyph with the native select over it. See the stylesheet. */
  function modeMenu(opts: { ariaLabel: string; options: readonly SegOption[]; selected: string; onPick: (value: string) => void }): HTMLElement {
    const wrap = el('span', 'flg-ins-mode', '▾')
    const select = el('select', 'flg-ins-spell')
    select.setAttribute('aria-label', opts.ariaLabel)
    for (const option of opts.options) {
      const item = el('option', undefined, option.label)
      item.value = option.value
      if (option.disabled === true) item.disabled = true
      if (option.title !== undefined) item.title = option.title
      select.append(item)
    }
    select.value = opts.selected
    const current = opts.options.find((option) => option.value === opts.selected)
    wrap.title = current === undefined ? opts.ariaLabel : `${opts.ariaLabel}: ${current.label}`
    select.addEventListener('change', () => opts.onPick(select.value))
    wrap.append(select)
    return wrap
  }

  /** A text or number box. `onCommit` fires on `change` -- on blur or Enter, not per keystroke:
   * every commit round-trips through the host and comes back as a fresh form. */
  function textBox(opts: {
    value: string
    kind?: 'text' | 'number'
    placeholder?: string
    ariaLabel: string
    title?: string
    invalid?: boolean
    step?: string
    min?: number
    max?: number
    id?: string
    onCommit: (text: string) => void
  }): HTMLInputElement {
    const input = el('input', 'flg-ins-input')
    input.type = opts.kind ?? 'text'
    input.value = opts.value
    input.spellcheck = false
    if (opts.id !== undefined) input.id = opts.id
    if (opts.placeholder !== undefined) input.placeholder = opts.placeholder
    input.setAttribute('aria-label', opts.ariaLabel)
    if (opts.title !== undefined) input.title = opts.title
    if (opts.invalid === true) input.setAttribute('aria-invalid', 'true')
    if (opts.step !== undefined) input.step = opts.step
    if (opts.min !== undefined) input.min = String(opts.min)
    if (opts.max !== undefined) input.max = String(opts.max)
    input.addEventListener('change', () => opts.onCommit(input.value))
    return input
  }

  /** A row of pills backed by native radios -- arrow-key navigable and announced as a group for
   * free. Used where the choice IS the value: a boolean's three states, written / unset. */
  function pills(opts: { ariaLabel: string; options: readonly SegOption[]; selected: string | null; onPick: (value: string) => void }): HTMLElement {
    const group = el('div', 'flg-ins-seg')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', opts.ariaLabel)
    const name = nextId()
    for (const option of opts.options) {
      const label = el('label', 'flg-ins-seg-option')
      const input = el('input')
      input.type = 'radio'
      input.name = name
      input.value = option.value
      input.checked = opts.selected === option.value
      if (option.disabled === true) input.disabled = true
      label.dataset['checked'] = input.checked ? 'yes' : 'no'
      if (option.title !== undefined) label.title = option.title
      input.addEventListener('change', () => {
        if (input.checked) opts.onPick(option.value)
      })
      label.append(input, el('span', undefined, option.label))
      group.append(label)
    }
    return group
  }

  /** The spelling a multi-spelling control is showing: what the author last picked here, else
   * what the file is written in. */
  function spellingFor<T extends string>(path: readonly (string | number)[], written: T): T {
    const chosen = spellings.get(pathKey(path))
    return (chosen as T | undefined) ?? written
  }

  function setSpelling(path: readonly (string | number)[], value: string): void {
    spellings.set(pathKey(path), value)
    rebuild()
  }

  // ---- rows ---------------------------------------------------------------

  /** One line of the grid: the key in the gutter, the control, the remove glyph. */
  function rowEl(opts: {
    label: string
    forId?: string
    control: HTMLElement | null
    tail?: HTMLElement | null
    depth: number
    title?: string
    required?: boolean
    heading?: boolean
  }): HTMLElement {
    const wrap = el('div', opts.heading === true ? 'flg-ins-row flg-ins-row-head' : 'flg-ins-row')
    wrap.dataset['depth'] = String(Math.min(opts.depth, 5))
    if (opts.title !== undefined) wrap.title = opts.title
    const key = el(opts.forId === undefined ? 'span' : 'label', 'flg-ins-key', opts.label)
    if (opts.forId !== undefined && key instanceof HTMLLabelElement) key.htmlFor = opts.forId
    if (opts.required === true) key.append(el('span', 'flg-ins-req', '*'))
    wrap.append(key, opts.control ?? el('div', 'flg-ins-control'), opts.tail ?? el('span'))
    return wrap
  }

  /** A one-line diagnostic under the row it is about, in the control column. */
  function noteRow(text: string, depth: number, level: 'error' | 'warning'): HTMLElement {
    const wrap = el('div', 'flg-ins-row flg-ins-row-note')
    wrap.dataset['depth'] = String(Math.min(depth, 5))
    const line = el('p', level === 'error' ? 'flg-ins-problem' : 'flg-ins-warn', text)
    line.title = text
    if (level === 'error') line.setAttribute('role', 'alert')
    wrap.append(el('span'), line, el('span'))
    return wrap
  }

  function nest(children: readonly HTMLElement[]): HTMLElement {
    const box = el('div', 'flg-ins-nest')
    box.append(...children)
    return box
  }

  function control(...children: HTMLElement[]): HTMLElement {
    const box = el('div', 'flg-ins-control')
    box.append(...children)
    return box
  }

  // ---- controls -----------------------------------------------------------

  interface Built {
    /** What sits beside the label. Null for a heading row. */
    line: HTMLElement | null
    /** Rows drawn under the row, nested one level in. */
    below: HTMLElement[]
  }

  /** A block descriptor, in whichever of its three spellings is showing. Takes a path and a value
   * rather than a FormRow, because the same control serves a `block` row, an element of a block
   * list and the block half of a weighted entry. `extra` adds a mode the key offers on top of the
   * three spellings -- "make this a list", for the keys that take one. */
  function blockControl(
    path: readonly (string | number)[],
    value: unknown,
    name: string,
    depth: number,
    id?: string,
    extra?: { label: string; onPick: () => void },
  ): Built {
    const view = readBlockValue(value)
    const spelling = spellingFor<BlockSpelling>(path, view.spelling)
    const menu = modeMenu({
      ariaLabel: `${name}: how this block is written`,
      selected: spelling,
      options: [
        { value: 'name', label: 'block name', title: 'A block name on its own.' },
        { value: 'name-and-states', label: 'name + states', title: 'A block name plus the block states to place it in.' },
        { value: 'tags', label: 'tag query', title: "A Molang query over the block's tags instead of a name." },
        ...(extra === undefined ? [] : [{ value: 'list', label: extra.label }]),
      ],
      onPick: (picked) => {
        if (picked === 'list') extra?.onPick()
        else setSpelling(path, picked)
      },
    })
    const box =
      spelling === 'tags'
        ? textBox({
            value: view.tags,
            ...(id === undefined ? {} : { id }),
            ariaLabel: `${name}: tag query`,
            placeholder: "q.any_tag('stone')",
            onCommit: (text) => commit(path, writeBlockValue({ ...view, spelling: 'tags', tags: text }), `${name}: tag query`),
          })
        : textBox({
            value: view.name,
            ...(id === undefined ? {} : { id }),
            ariaLabel: `${name}: block name`,
            placeholder: 'example:block_name',
            onCommit: (text) => commit(path, writeBlockValue({ ...view, spelling, name: text }), `${name}: block name`),
          })
    const below = spelling === 'name-and-states' ? stateRows(path, view, name, depth + 1) : []
    return { line: control(box, menu), below }
  }

  /** The block-states map: one row per state, a name and a value, and an add row. States are not
   * catalogued -- they are per block -- but the SHAPE is known: a flat map of names to booleans,
   * whole numbers or strings, which is enough to build a real control from. */
  function stateRows(path: readonly (string | number)[], view: BlockView, name: string, depth: number): HTMLElement[] {
    const key = pathKey(path)
    const blanks = pendingStates.get(key) ?? 0
    const pairs: [string, unknown][] = [
      ...view.states.map(([stateKey, value]): [string, unknown] => [stateKey, value]),
      ...Array.from({ length: blanks }, (): [string, unknown] => ['', '']),
    ]
    const write = (): void => {
      // The blank rows are dropped by writeBlockValue and the named one comes back from the
      // host, so the on-screen blanks are spent here.
      pendingStates.delete(key)
      commit(path, writeBlockValue({ ...view, spelling: 'name-and-states', states: pairs }), `${name}: block states`)
    }
    const rows: HTMLElement[] = pairs.map(([key, value], index) => {
      const nameId = nextId()
      const line = control(
        textBox({
          id: nameId,
          value: key,
          ariaLabel: `${name}: state ${index + 1} name`,
          placeholder: 'state_name',
          onCommit: (text) => {
            const entry = pairs[index]
            if (entry === undefined) return
            entry[0] = text
            write()
          },
        }),
        textBox({
          value: formatStateValue(value),
          ariaLabel: `${name}: state ${index + 1} value`,
          placeholder: 'value',
          onCommit: (text) => {
            const entry = pairs[index]
            if (entry === undefined) return
            entry[1] = parseStateValue(text)
            write()
          },
        }),
      )
      return rowEl({
        label: `state ${index + 1}`,
        forId: nameId,
        control: line,
        depth,
        tail: removeButton(`Remove state ${index + 1} from ${name}`, () => {
          if (index >= view.states.length) {
            // A blank row that was never written: taking it away is not a write either.
            pendingStates.set(key, Math.max(0, blanks - 1))
            rebuild()
            return
          }
          pairs.splice(index, 1)
          write()
        }),
      })
    })
    rows.push(
      rowEl({
        label: '',
        control: control(
          addButton('+ state', `Add a block state to ${name}`, () => {
            // Adding an empty row writes nothing -- writeBlockValue drops nameless states -- so
            // the key is written when the state is actually named. Drawn without a round trip.
            pendingStates.set(key, blanks + 1)
            rebuild()
          }),
        ),
        depth,
      }),
    )
    return rows
  }
  /** Blank state rows the author added and has not named yet, per block path. They exist only
   * on screen: nothing is written until one of them is named. */
  const pendingStates = new Map<string, number>()

  /** A range: two number boxes on one line, named `range_min` and `range_max` in the
   * accessibility tree and as placeholders, then the mode menu. */
  function rangeControl(row: FormRow, editor: Extract<Editor, { control: 'range' }>, id?: string): Built {
    const written = rangeSpellingOf(row.value)
    const current = readRange(row.value) ?? { min: 0, max: 0 }
    const spelling = spellingFor<RangeSpelling>(row.path, written ?? 'object')
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const [minKey, maxKey] = editor.objectKeys
    const write = (min: number, max: number): void => {
      commit(row.path, writeRangeValue(min, max, spelling === 'number' && min !== max ? 'object' : spelling), `${keyName}: range`)
    }
    const boxes: HTMLElement[] = []
    for (const [label, isMin] of [
      [minKey, true],
      [maxKey, false],
    ] as const) {
      const boxId = isMin && id !== undefined ? id : nextId()
      const caption = el('label', 'flg-ins-offscreen flg-ins-sublabel', label)
      caption.htmlFor = boxId
      boxes.push(
        caption,
        textBox({
          id: boxId,
          kind: 'number',
          value: written === null && !isSet(row) ? '' : String(isMin ? current.min : current.max),
          ariaLabel: `${keyName}: ${label}`,
          placeholder: label,
          title: label,
          onCommit: (text) => {
            if (text.trim() === '') {
              // A range needs both ends. Clearing one removes the key rather than writing half
              // a range or inventing a zero the author did not type.
              commit(row.path, undefined, `${keyName}: removed`)
              return
            }
            const n = Number(text)
            if (!Number.isFinite(n)) return
            write(isMin ? n : current.min, isMin ? current.max : n)
          },
        }),
      )
    }
    const menu = modeMenu({
      ariaLabel: `${keyName}: how this range is written`,
      selected: spelling,
      options: [
        { value: 'number', label: 'one number', disabled: current.min !== current.max, title: 'A single number, read as a range whose ends are equal.' },
        { value: 'array', label: '[min, max]', title: 'A two-element array.' },
        { value: 'object', label: `{${minKey}, ${maxKey}}`, title: 'An object with the two keys the engine reads. {min, max} is not refused but reads as a zero-width range.' },
      ],
      onPick: (picked) => setSpelling(row.path, picked),
    })
    return { line: control(...boxes, menu), below: [] }
  }

  /** A list of blocks: an add button beside the key, one row per block underneath. A key that
   * accepts a single descriptor as well (tree_feature's `base_block`) is edited as itself, with
   * "make this a list" in its mode menu rather than a silent promotion. */
  function blockListControl(row: FormRow, depth: number, id?: string): Built {
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const value = Array.isArray(row.value) || isSet(row) || row.spec.acceptsSingle === true ? row.value : []
    // A key that takes only a list starts as an empty list, never as a lone block box: the box
    // would write the one spelling the game refuses there. A single block already in the file
    // keeps the block control, whose "list of blocks" pick converts it.
    if (!Array.isArray(value)) {
      return blockControl(row.path, value, keyName, depth, id, {
        label: 'list of blocks',
        onPick: () => commit(row.path, isSet(row) ? [value] : [], `${keyName}: list`),
      })
    }
    const below: HTMLElement[] = []
    value.forEach((entry, index) => {
      const entryId = nextId()
      const built = blockControl([...row.path, index], entry, `${keyName} ${index + 1}`, depth + 1, entryId)
      const line = rowEl({
        label: String(index + 1),
        forId: entryId,
        control: built.line,
        depth: depth + 1,
        tail: removeButton(`Remove block ${index + 1} from ${keyName}`, () => commit([...row.path, index], undefined, `${keyName}: removed entry ${index + 1}`)),
      })
      line.dataset['path'] = pathKey([...row.path, index])
      below.push(line)
      if (built.below.length > 0) below.push(nest(built.below))
    })
    const line = control(addButton('+ block', `Add a block to ${keyName}`, () => addToList(row, value.length, '', `${keyName}: added a block`)))
    return { line, below }
  }

  /** A weighted block list: a block and a weight per row, in whichever spelling the file uses.
   * Which spellings are offered is the KEY's decision -- forms.ts hands it over as
   * `entrySpellings` and `scalar`. */
  function weightedListControl(row: FormRow, editor: Extract<Editor, { control: 'weighted-block-list' }>, depth: number, id?: string): Built {
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const accepted = editor.entrySpellings
    if (!Array.isArray(row.value) && editor.scalar) {
      return blockControl(row.path, row.value, keyName, depth, id, {
        label: 'weighted list',
        onPick: () => {
          const written = isSet(row) && isBlockDescriptor(row.value)
          commit(row.path, written ? [newWeightedEntry(newWeightedSpelling(accepted, undefined), row.value)] : [], `${keyName}: list`)
        },
      })
    }
    const value = Array.isArray(row.value) ? row.value : []
    const below: HTMLElement[] = []
    value.forEach((entry, index) => {
      const view = readWeightedEntry(entry)
      const blockPath = view.spelling === 'pair' ? [...row.path, index, 0] : [...row.path, index, 'block']
      const weightPath = view.spelling === 'pair' ? [...row.path, index, 1] : [...row.path, index, 'weight']
      const entryId = nextId()
      const built = blockControl(blockPath, view.block, `${keyName} ${index + 1} block`, depth + 1, entryId)
      const weightId = nextId()
      const weightLabel = el('label', 'flg-ins-offscreen flg-ins-sublabel', 'weight')
      weightLabel.htmlFor = weightId
      const weight = textBox({
        id: weightId,
        kind: 'number',
        value: view.weight === undefined ? '' : String(view.weight),
        ariaLabel: `${keyName} ${index + 1}: weight`,
        placeholder: 'weight',
        title: 'weight: this entry\'s share of the total, not a percentage',
        onCommit: (text) => {
          if (text.trim() === '') return
          const n = Number(text)
          if (Number.isFinite(n)) commit(weightPath, n, `${keyName} ${index + 1}: weight`)
        },
      })
      weight.style.flex = '0 1 5ch'
      built.line?.append(weightLabel, weight)
      const line = rowEl({
        label: String(index + 1),
        forId: entryId,
        control: built.line,
        depth: depth + 1,
        tail: removeButton(`Remove entry ${index + 1} from ${keyName}`, () => commit([...row.path, index], undefined, `${keyName}: removed entry ${index + 1}`)),
      })
      line.dataset['path'] = pathKey([...row.path, index])
      below.push(line)
      if (built.below.length > 0) below.push(nest(built.below))
    })
    const spelling = newWeightedSpelling(accepted, value[value.length - 1])
    const line = control(addButton('+ block', `Add an entry to ${keyName}`, () => addToList(row, value.length, newWeightedEntry(spelling), `${keyName}: added an entry`)))
    return { line, below }
  }

  /** A chance: a percent (number or Molang) or a `{numerator, denominator}` fraction, both on
   * one line. */
  function chanceControl(row: FormRow, editor: Extract<Editor, { control: 'chance' }>, id?: string): Built {
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const written = chanceSpellingOf(row.value)
    const spelling = spellingFor<ChanceSpelling>(row.path, isSet(row) ? written : 'percent')
    const menu = modeMenu({
      ariaLabel: `${keyName}: how this chance is written`,
      selected: spelling,
      options: [
        { value: 'percent', label: 'percent', title: 'A number, or a Molang expression that produces one.' },
        { value: 'fraction', label: 'numerator / denominator', title: 'A {numerator, denominator} fraction object.' },
      ],
      onPick: (picked) => setSpelling(row.path, picked),
    })
    if (spelling === 'percent') {
      const box = textBox({
        value: typeof row.value === 'number' || typeof row.value === 'string' ? String(row.value) : '',
        ...(id === undefined ? {} : { id }),
        ariaLabel: `${keyName}: percent`,
        placeholder: '100',
        onCommit: (text) => commit(row.path, parseMolangOrNumber(text), `${keyName}: percent`),
      })
      return { line: control(box, menu), below: [] }
    }
    // The two members are the fraction's own catalogued rows, so each box writes its own path.
    const parts: HTMLElement[] = []
    editor.fraction.forEach((member, index) => {
      const boxId = index === 0 && id !== undefined ? id : nextId()
      const caption = el('label', 'flg-ins-offscreen flg-ins-sublabel', member.spec.key)
      caption.htmlFor = boxId
      if (index > 0) parts.push(el('span', undefined, '/'))
      parts.push(
        caption,
        textBox({
          id: boxId,
          kind: 'number',
          value: typeof member.value === 'number' ? String(member.value) : '',
          ariaLabel: `${keyName}: ${member.spec.key}`,
          placeholder: member.spec.key,
          title: member.spec.key,
          invalid: member.problems.length > 0,
          onCommit: (text) => {
            if (text.trim() === '') {
              commit(member.path, undefined, `${member.spec.key}: removed`)
              return
            }
            const n = Number(text)
            if (Number.isFinite(n)) commit(member.path, n, member.spec.key)
          },
        }),
      )
    })
    return { line: control(...parts, menu), below: [] }
  }

  /** A scatter axis: a number, a Molang expression, or a `{distribution, extent}` object whose
   * members are rows underneath. */
  function coordinateControl(row: FormRow, editor: Extract<Editor, { control: 'coordinate' }>, depth: number, id?: string): Built {
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const written = coordinateSpellingOf(row.value)
    const spelling = spellingFor<CoordinateSpelling>(row.path, isSet(row) ? written : 'scalar')
    const menu = modeMenu({
      ariaLabel: `${keyName}: how this axis is written`,
      selected: spelling,
      options: [
        { value: 'scalar', label: 'one value', title: 'One value, used for every placement on this axis.' },
        { value: 'object', label: 'distribution', title: 'A distribution kind and the extent it draws over.' },
      ],
      onPick: (picked) => setSpelling(row.path, picked),
    })
    if (spelling === 'scalar') {
      const box = textBox({
        value: typeof row.value === 'number' || typeof row.value === 'string' ? String(row.value) : '',
        ...(id === undefined ? {} : { id }),
        ariaLabel: `${keyName}: value`,
        placeholder: '0',
        onCommit: (text) => commit(row.path, parseMolangOrNumber(text), `${keyName}: value`),
      })
      return { line: control(box, menu), below: [] }
    }
    return { line: control(el('span', 'flg-ins-modeword', 'distribution'), menu), below: objectRows(editor.object, row.path, depth + 1) }
  }

  /** A list of bare values as chips on one line, with one shared add button.
   *
   * A list of fixed length (`extent` is [min, max]) is one value, not a list an author grows: the
   * add button fills it to that length in one step and goes away once it is full, and a single
   * chip cannot be removed from a full list, because every length but the fixed one is a file the
   * engine refuses. A file that already has the wrong length keeps its remove buttons, since
   * removing is how it gets fixed. */
  function chipList(row: FormRow, editor: Extract<Editor, { control: 'group-list' }>, depth: number, id?: string): Built {
    const wrap = el('div', 'flg-ins-chips')
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', keyName)
    const count = listLength(row.value)
    const fixed = row.spec.length
    for (let index = 0; index < count; index++) {
      const rows = elementRows(editor.entry, row.path, index, fields)
      const only = rows[0]
      if (only === undefined) continue
      const chip = el('div', 'flg-ins-chip')
      chip.dataset['path'] = pathKey([...row.path, index])
      const built = controlFor({ ...only, spec: { ...only.spec, key: `${keyName} ${index + 1}` } }, { id: index === 0 ? id : undefined, depth })
      const box = built.line?.querySelector<HTMLElement>('input, select')
      if (box !== null && box !== undefined) chip.append(box)
      if (fixed !== count) {
        chip.append(removeButton(`Remove entry ${index + 1} from ${keyName}`, () => commit([...row.path, index], undefined, `${keyName}: removed entry ${index + 1}`)))
      }
      wrap.append(chip)
    }
    if (fixed === undefined) {
      wrap.append(addButton('+', `Add an entry to ${keyName}`, () => addToList(row, count, newElementValue(editor.entry), `${keyName}: added an entry`)))
    } else if (count < fixed) {
      const existing = Array.isArray(row.value) ? row.value : []
      const filled = [...existing, ...Array.from({ length: fixed - count }, () => newElementValue(editor.entry))]
      wrap.append(addButton('+', `Fill ${keyName} with ${fixed} entries`, () => commit(row.path, filled, `${keyName}: added ${fixed - count} entries`)))
    }
    return { line: wrap, below: [] }
  }

  /** A list of objects: an add button beside the key, then one numbered heading per element
   * with its members as rows under it. A list whose element is a single bare value that is not a
   * chip (a range, a block) draws that value on the numbered line itself. */
  function groupListControl(row: FormRow, editor: Extract<Editor, { control: 'group-list' }>, depth: number): Built {
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const count = listLength(row.value)
    const below: HTMLElement[] = []
    for (let index = 0; index < count; index++) {
      const rows = elementRows(editor.entry, row.path, index, fields)
      const only = rows.length === 1 && rows[0]?.spec.key === '' ? rows[0] : undefined
      const remove = removeButton(`Remove entry ${index + 1} from ${keyName}`, () => commit([...row.path, index], undefined, `${keyName}: removed entry ${index + 1}`))
      if (only !== undefined) {
        below.push(...renderRow(only, depth + 1, { label: String(index + 1), tail: remove }))
        continue
      }
      const head = rowEl({ label: String(index + 1), control: null, depth: depth + 1, heading: true, tail: remove })
      head.dataset['path'] = pathKey([...row.path, index])
      below.push(head, nest(objectRows(rows, [...row.path, index], depth + 2)))
    }
    const line = control(addButton('+ entry', `Add an entry to ${keyName}`, () => addToList(row, count, newElementValue(editor.entry), `${keyName}: added an entry`)))
    return { line, below }
  }

  /** The raw-JSON escape hatch, and the only one. `reason` -- why this shape is not modelled --
   * is the row's tooltip and is in the documentation panel. */
  function jsonControl(row: FormRow, editor: Extract<Editor, { control: 'json' }>, depth: number, id?: string): Built {
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const area = el('textarea', 'flg-ins-area')
    if (id !== undefined) area.id = id
    area.spellcheck = false
    area.rows = 3
    area.value = row.value === undefined ? '' : JSON.stringify(row.value, null, 2)
    area.setAttribute('aria-label', `${keyName}: raw JSON`)
    area.title = editor.reason
    const invalid = noteRow('Not valid JSON, so nothing was written. The box keeps what you typed.', depth, 'error')
    invalid.hidden = true
    area.addEventListener('change', () => {
      if (area.value.trim() === '') {
        invalid.hidden = true
        area.removeAttribute('aria-invalid')
        commit(row.path, undefined, `${keyName}: removed`)
        return
      }
      try {
        const parsed: unknown = JSON.parse(area.value)
        invalid.hidden = true
        area.removeAttribute('aria-invalid')
        commit(row.path, parsed, `${keyName}: raw JSON`)
      } catch {
        // A half-typed object is not worth discarding: the box keeps the text, nothing is written.
        invalid.hidden = false
        area.setAttribute('aria-invalid', 'true')
      }
    })
    return { line: control(area), below: [invalid] }
  }

  /** The control for one row. Which control is forms.ts's decision, never this file's. */
  function controlFor(row: FormRow, opts: { id?: string | undefined; depth: number }): Built {
    const editor = row.editor
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const disabled = row.spec.availability !== 'available'
    const depth = opts.depth
    const id = opts.id

    const built = ((): Built => {
      switch (editor.control) {
        case 'checkbox':
          // Three states, not two. A checkbox cannot say "not written", and for several of these
          // keys the absent state is neither true nor false in effect.
          return {
            line: control(
              pills({
                ariaLabel: keyName,
                selected: row.value === true ? 'true' : row.value === false ? 'false' : isSet(row) ? null : 'absent',
                options: [
                  { value: 'true', label: 'true' },
                  { value: 'false', label: 'false' },
                  { value: 'absent', label: 'unset', title: row.spec.default === undefined ? 'Leave the key out.' : `Leave the key out: ${row.spec.default}` },
                ],
                onPick: (picked) => commit(row.path, picked === 'absent' ? undefined : picked === 'true', keyName),
              }),
            ),
            below: [],
          }
        case 'select': {
          const select = el('select', 'flg-ins-select')
          if (id !== undefined) select.id = id
          select.setAttribute('aria-label', keyName)
          const blank = el('option', undefined, row.spec.required ? 'choose a value' : 'not written')
          blank.value = ''
          select.append(blank)
          for (const option of editor.options) {
            const item = el('option', undefined, option)
            item.value = option
            select.append(item)
          }
          if (typeof row.value === 'string' && !editor.options.includes(row.value)) {
            // The file's own value, even when the catalogue does not list it: a select that
            // silently showed blank would hide what is written.
            const item = el('option', undefined, row.value)
            item.value = row.value
            select.append(item)
          }
          select.value = typeof row.value === 'string' ? row.value : ''
          select.addEventListener('change', () => commit(row.path, select.value === '' ? undefined : select.value, keyName))
          return { line: control(select), below: [] }
        }
        case 'number':
          return {
            line: control(
              textBox({
                kind: 'number',
                ...(id === undefined ? {} : { id }),
                value: typeof row.value === 'number' ? String(row.value) : '',
                ariaLabel: keyName,
                step: editor.integer ? '1' : 'any',
                ...(editor.min === undefined ? {} : { min: editor.min }),
                ...(editor.max === undefined ? {} : { max: editor.max }),
                invalid: row.problems.length > 0,
                onCommit: (text) => {
                  if (text.trim() === '') {
                    commit(row.path, undefined, `${keyName}: removed`)
                    return
                  }
                  const n = Number(text)
                  if (Number.isFinite(n)) commit(row.path, n, keyName)
                },
              }),
            ),
            below: [],
          }
        case 'molang-or-number':
          // Free text, deliberately: a spin box would make the expression spelling unreachable.
          return {
            line: control(
              textBox({
                value: row.value === undefined || row.value === null ? '' : String(row.value),
                ...(id === undefined ? {} : { id }),
                ariaLabel: keyName,
                placeholder: '0  or  math.random(0, 1)',
                invalid: row.problems.length > 0,
                onCommit: (text) => commit(row.path, parseMolangOrNumber(text), keyName),
              }),
            ),
            below: [],
          }
        case 'text':
          return {
            line: control(
              textBox({
                value: typeof row.value === 'string' ? row.value : '',
                ...(id === undefined ? {} : { id }),
                ariaLabel: keyName,
                invalid: row.problems.length > 0,
                onCommit: (text) => commit(row.path, text === '' ? undefined : text, keyName),
              }),
            ),
            below: [],
          }
        case 'block':
          return blockControl(row.path, row.value, keyName, depth, id)
        case 'block-list':
          return blockListControl(row, depth, id)
        case 'weighted-block-list':
          return weightedListControl(row, editor, depth, id)
        case 'range':
          return rangeControl(row, editor, id)
        case 'chance':
          return chanceControl(row, editor, id)
        case 'coordinate':
          return coordinateControl(row, editor, depth, id)
        case 'group':
          if (editor.rows.length === 0) {
            // An object with no keys of its own -- structure_template's `grounded`. Writing it
            // IS the setting, so the control is exactly that question.
            return {
              line: control(
                pills({
                  ariaLabel: keyName,
                  selected: isSet(row) ? 'written' : 'absent',
                  options: [
                    { value: 'written', label: 'written' },
                    { value: 'absent', label: 'unset' },
                  ],
                  onPick: (picked) => commit(row.path, picked === 'written' ? {} : undefined, keyName),
                }),
              ),
              below: [],
            }
          }
          return { line: null, below: objectRows(editor.rows, row.path, depth + 1) }
        case 'group-list':
          return isScalarList(editor.entry) ? chipList(row, editor, depth, id) : groupListControl(row, editor, depth)
        case 'json':
          return jsonControl(row, editor, depth, id)
      }
    })()

    if (disabled) {
      for (const node of [built.line, ...built.below]) {
        for (const item of node?.querySelectorAll('input, select, textarea, button') ?? []) (item as HTMLInputElement).disabled = true
      }
    }
    return built
  }

  /** One row of the form: the grid line, any diagnostic under it, and whatever nests below. */
  function renderRow(row: FormRow, depth: number, override: { label?: string; tail?: HTMLElement } = {}): HTMLElement[] {
    const rowKey = pathKey(row.path)
    const set = isSet(row)
    const keyName = row.spec.key === '' ? 'value' : row.spec.key
    const isGroup = row.editor.control === 'group' && row.editor.rows.length > 0
    const controlId = nextId()
    const built = controlFor(row, { id: controlId, depth })
    const bound = built.line?.querySelector(`[id="${controlId}"]`) !== null && built.line !== null

    let tail: HTMLElement | null = override.tail ?? null
    if (tail === null && set) {
      tail = removeButton(`Remove ${row.spec.key === '' ? 'this value' : row.spec.key}`, () => commit(row.path, undefined, `${row.spec.key}: removed`))
    } else if (tail === null && revealed.has(rowKey)) {
      tail = removeButton(`Hide ${keyName} again`, () => {
        revealed.delete(rowKey)
        rebuild()
      })
    }

    const line = rowEl({
      label: override.label ?? keyName,
      ...(bound ? { forId: controlId } : {}),
      control: built.line,
      tail,
      depth,
      title: tooltipFor(form.typeId, row),
      required: row.spec.required,
      heading: isGroup,
    })
    line.dataset['path'] = rowKey
    line.dataset['key'] = row.spec.key
    line.dataset['kind'] = row.spec.kind
    line.dataset['state'] = row.spec.availability !== 'available' ? 'unavailable' : set ? 'set' : 'unset'
    if (row.problems.length > 0) line.dataset['problem'] = 'yes'
    if (isGroup) {
      line.setAttribute('role', 'group')
      line.setAttribute('aria-label', keyName)
    }

    const out: HTMLElement[] = [line]
    if (row.spec.availability !== 'available' && row.spec.availabilityNote !== undefined) out.push(noteRow(row.spec.availabilityNote, depth, 'warning'))
    for (const message of row.problems) out.push(noteRow(message, depth, 'error'))
    if (built.below.length > 0) out.push(nest(built.below))
    return out
  }

  /** The rows of one object: what is shown, then the offer of what is not. */
  function objectRows(rows: readonly FormRow[], path: readonly (string | number)[], depth: number): HTMLElement[] {
    const split = splitRows(rows, revealed)
    const out: HTMLElement[] = []
    for (const row of split.shown) out.push(...renderRow(row, depth))
    if (split.addable.length > 0) out.push(addFieldRow(split.addable, path, depth))
    return out
  }

  /** "Add a field": every optional key that is not set, as one select. Picking one reveals its
   * control and writes NOTHING; the key is written when a value is typed. */
  function addFieldRow(rows: readonly FormRow[], path: readonly (string | number)[], depth: number): HTMLElement {
    const select = el('select', 'flg-ins-addfield')
    select.setAttribute('aria-label', path.length === 0 ? 'Add a field' : `Add a field to ${docPathOf(path)}`)
    const head = el('option', undefined, `+ Add a field (${rows.length})`)
    head.value = ''
    select.append(head)
    for (const row of rows) {
      const item = el('option', undefined, row.spec.key)
      item.value = pathKey(row.path)
      item.title = tooltipFor(form.typeId, row)
      select.append(item)
    }
    select.value = ''
    select.addEventListener('change', () => {
      const key = select.value
      if (key === '') return
      revealed.add(key)
      rebuild()
      root.querySelector<HTMLElement>(`[data-path=${JSON.stringify(key)}] input, [data-path=${JSON.stringify(key)}] select, [data-path=${JSON.stringify(key)}] textarea`)?.focus()
    })
    const line = rowEl({ label: '', control: control(select), depth })
    line.classList.add('flg-ins-row-add')
    return line
  }

  // ---- an expression the graph carries on an edge ---------------------------

  /** One edge-borne key as a row: the key in the gutter, the edge's own Molang control filling
   * the line (taller than one when the expression is, up to its ceiling), the format choice as
   * the row's mode menu, and the editor's problems as one-line notes under it -- repainted in
   * place as the author types, because a redraw mid-keystroke would take the caret with it.
   *
   * THE WRITE IS THE EDITOR'S. On blur the control commits, the editor emits, and the host's
   * subscription writes the file at the path the graph builder reported. Nothing here emits an
   * InspectorChange: the value is not in Fields, and there is no path of this panel's to write. */
  function renderEdgeField(field: InspectorEdgeField, depth: number): HTMLElement[] {
    const editor = field.editor
    const notes = el('div', 'flg-ins-notes')
    const paintNotes = (): void => {
      const view = editor.view()
      notes.replaceChildren(...view.problems.map((problem) => noteRow(problem.message, depth, problem.severity === 'error' ? 'error' : 'warning')))
      line.dataset['state'] = view.text.trim() === '' ? 'unset' : 'set'
      if (view.problems.some((problem) => problem.severity === 'error')) line.dataset['problem'] = 'yes'
      else delete line.dataset['problem']
    }
    const molang = createMolangField(editor, { label: field.key, chrome: 'bare', onChanged: paintNotes })
    molang.input.id = nextId()
    molangViews.push(molang)
    const menu = modeMenu({
      ariaLabel: `${field.key}: how this expression is written`,
      selected: editor.view().keepFormatted ? 'keep' : 'minify',
      options: [
        { value: 'minify', label: 'one compact line', title: 'The file gets the expression on one line; the box shows it laid out.' },
        { value: 'keep', label: 'keep the line breaks', title: 'The file keeps the layout the box shows.' },
      ],
      onPick: (picked) => {
        // Recorded in the file's comments by the host, exactly as the edge panel's checkbox is;
        // the expression itself reaches the file in the new spelling on its next commit.
        editor.setKeepFormatted(picked === 'keep')
        molang.refresh()
      },
    })
    const line = rowEl({
      label: field.key,
      forId: molang.input.id,
      control: control(molang.element, menu),
      depth,
      title: edgeFieldTooltip(field.key),
      required: true,
    })
    line.dataset['path'] = `edge:${field.key}`
    line.dataset['key'] = field.key
    line.dataset['kind'] = 'molang'
    paintNotes()
    return [line, notes]
  }

  /** The edge-borne rows of `section`, which is the rows for the one section they live in and
   * nothing for every other. */
  function edgeRowsFor(section: InspectorSection): HTMLElement[] {
    if (section.key !== edgeHome) return []
    return edgeFields.flatMap((field) => renderEdgeField(field, 0))
  }

  // ---- sections -----------------------------------------------------------

  function sectionEl(section: InspectorSection, children: readonly HTMLElement[], tail?: HTMLElement | null, title?: string): HTMLElement {
    const box = el('section', 'flg-ins-section')
    box.dataset['section'] = section.key
    if (section.choice !== undefined) box.dataset['group'] = section.choice.name
    box.setAttribute('aria-label', section.title)
    const head = el('h3', 'flg-ins-section-head')
    const name = el('span', 'flg-ins-section-name', section.title)
    if (title !== undefined) name.title = title
    head.append(name)
    if (tail != null) head.append(tail)
    const help = el('button', 'flg-ins-help', '?')
    help.type = 'button'
    help.setAttribute('aria-label', `Explain ${section.title}`)
    help.title = `Explain ${section.title}`
    help.setAttribute('aria-controls', docsId)
    help.setAttribute('aria-expanded', docsView?.section === section.key ? 'true' : 'false')
    help.addEventListener('click', () => {
      if (docsView?.section === section.key) closeDocs(true)
      else openDocs(section.key)
    })
    head.append(help)
    box.append(head, ...children)
    return box
  }

  function renderGeneral(section: InspectorSection): HTMLElement {
    return sectionEl(section, [...edgeRowsFor(section), ...objectRows(section.rows, [], 0)])
  }

  function renderGroupSection(section: InspectorSection): HTMLElement {
    const row = section.row as FormRow
    const remove = removeButton(`Remove ${row.spec.key}`, () => commit(row.path, undefined, `${row.spec.key}: removed`))
    const children: HTMLElement[] = []
    if (row.spec.availability !== 'available' && row.spec.availabilityNote !== undefined) children.push(noteRow(row.spec.availabilityNote, 0, 'warning'))
    for (const message of row.problems) children.push(noteRow(message, 0, 'error'))
    // The count first, then the axes: the order the file is usually written in, and the order
    // an author thinks in -- how many, then where.
    children.push(...edgeRowsFor(section), ...objectRows(section.rows, row.path, 0))
    const box = sectionEl(section, children, isSet(row) ? remove : null, tooltipFor(form.typeId, row))
    box.dataset['path'] = pathKey(row.path)
    box.dataset['key'] = row.spec.key
    if (row.spec.availability !== 'available') {
      for (const item of box.querySelectorAll('input, select, textarea, button:not(.flg-ins-help)')) (item as HTMLInputElement).disabled = true
    }
    return box
  }

  /** An exclusive group: one `variant` select, then that variant's body. */
  function renderChoiceSection(section: InspectorSection): HTMLElement {
    const choice = section.choice as ExclusiveChoice
    const selectId = nextId()
    const select = el('select', 'flg-ins-select')
    select.id = selectId
    select.setAttribute('aria-label', `${choice.name}: which one`)
    if (!choice.required) {
      const none = el('option', undefined, 'none')
      none.value = ''
      none.title = 'Leave every one of these keys out.'
      select.append(none)
    } else if (choice.selected === null) {
      const blank = el('option', undefined, 'choose a variant')
      blank.value = ''
      blank.disabled = true
      select.append(blank)
    }
    for (const member of choice.members) {
      const item = el('option', undefined, member.spec.key)
      item.value = member.spec.key
      if (member.spec.availability !== 'available') item.disabled = true
      const doc = lookupFieldDoc(form.typeId, docPathOf(member.path))
      if (doc?.entry !== undefined) item.title = plainDocText(doc.entry.summary)
      select.append(item)
    }
    select.value = choice.selected ?? ''
    select.addEventListener('change', () => {
      const next = select.value === '' ? null : select.value
      emit(variantSwapEdits(choice.selected, next), next === null ? [choice.name] : [next], `${choice.name}: ${next ?? 'none'}`)
    })
    const children: HTMLElement[] = [
      rowEl({
        label: 'variant',
        forId: selectId,
        control: control(select),
        depth: 0,
        required: choice.required,
        title: choice.doc === '' ? choice.name : `${choice.name}\n${plainDocText(choice.doc)}`,
      }),
    ]
    const variantRow = children[0] as HTMLElement
    variantRow.dataset['path'] = pathKey([choice.name])
    variantRow.dataset['key'] = choice.name
    variantRow.dataset['state'] = choice.selected === null ? 'unset' : 'set'

    if (choice.conflicts.length > 1) {
      children.push(noteRow(`${choice.conflicts.join(' and ')} are both written; the engine refuses the file with two. Remove one.`, 0, 'error'))
      for (const member of choice.members.filter((row) => choice.conflicts.includes(row.spec.key))) children.push(...renderRow(member, 0))
    } else {
      const selected = choice.members.find((member) => member.spec.key === choice.selected)
      if (selected !== undefined) {
        if (selected.editor.control === 'group' && selected.editor.rows.length > 0) {
          for (const message of selected.problems) children.push(noteRow(message, 0, 'error'))
          children.push(...objectRows(selected.editor.rows, selected.path, 0))
        } else {
          children.push(...renderRow(selected, 0))
        }
      }
    }
    return sectionEl(section, children)
  }

  function renderExtras(section: InspectorSection): HTMLElement {
    return sectionEl(
      section,
      section.rows.flatMap((row) => renderRow(row, 0)),
    )
  }

  // ---- notices ------------------------------------------------------------

  /** How much of a notice is shown before it folds to its first sentence. */
  const NOTICE_FOLD_CHARS = 120

  function renderNotice(item: FormNotice): HTMLElement {
    const label = item.level === 'error' ? 'Error: ' : item.level === 'warning' ? 'Warning: ' : 'Note: '
    if (item.message.length <= NOTICE_FOLD_CHARS) {
      const node = el('p', `flg-ins-notice flg-ins-notice-${item.level}`)
      node.append(el('span', 'flg-ins-notice-label', label), document.createTextNode(item.message))
      node.title = item.message
      return node
    }
    const stop = item.message.indexOf('. ')
    const head = stop > 0 && stop < NOTICE_FOLD_CHARS ? item.message.slice(0, stop + 1) : `${item.message.slice(0, NOTICE_FOLD_CHARS)}...`
    const details = el('details', `flg-ins-notice flg-ins-notice-${item.level}`)
    const key = `notice:${item.key ?? label}`
    details.open = openSections.has(key)
    const summary = el('summary')
    summary.append(el('span', 'flg-ins-notice-label', label), document.createTextNode(head))
    summary.title = item.message
    details.append(summary, el('p', undefined, item.message))
    details.addEventListener('toggle', () => {
      if (details.open) openSections.add(key)
      else openSections.delete(key)
    })
    return details
  }

  // ---- the documentation panel --------------------------------------------
  //
  // One element, created on first open, filled for the overview or for one section, and placed
  // either in the host the options named or floated over the area left of the form. Opening and
  // closing it writes nothing and moves no row: the form is not rebuilt for it.

  function appendSpans(target: Node, spans: readonly DocSpan[]): void {
    for (const span of spans) {
      if (span.kind === 'code') target.appendChild(el('code', 'flg-ins-doc-code', span.text))
      else if (span.kind === 'strong') target.appendChild(el('strong', undefined, span.text))
      else target.appendChild(document.createTextNode(span.text))
    }
  }

  function docParagraph(block: DocBlock): HTMLElement {
    const node = el('p', block.emphasis ? 'flg-ins-doc-p flg-ins-doc-facts' : 'flg-ins-doc-p')
    appendSpans(node, block.spans)
    return node
  }

  function docEntryEl(entry: DocEntryView): HTMLElement {
    const article = el('article', 'flg-ins-doc')
    article.dataset['key'] = entry.name
    const head = el('div', 'flg-ins-doc-head')
    const glyph = el('span', 'flg-ins-doc-glyph', entry.glyph)
    glyph.setAttribute('role', 'img')
    glyph.setAttribute('aria-label', entry.kindLabel)
    glyph.title = entry.kindLabel
    const name = el('h3', 'flg-ins-doc-name')
    if (entry.parent !== '') name.append(el('span', 'flg-ins-doc-parent', entry.parent))
    name.append(document.createTextNode(entry.name))
    head.append(glyph, name)
    article.append(head)
    if (entry.badges.length > 0) {
      const badges = el('div', 'flg-ins-doc-badges')
      for (const badge of entry.badges) {
        const pill = el('span', 'flg-ins-badge', badge.label)
        pill.dataset['badge'] = badge.kind
        if (badge.title !== undefined) pill.title = badge.title
        badges.append(pill)
      }
      badges.append(el('span', undefined, entry.kindLabel))
      article.append(badges)
    }
    for (const block of entry.blocks) article.append(docParagraph(block))
    for (const fact of entry.facts) article.append(el('p', 'flg-ins-doc-fact', fact))
    if (entry.values.length > 0) {
      const list = el('div', 'flg-ins-doc-values')
      for (const value of entry.values) {
        const item = el('div', 'flg-ins-doc-value')
        item.append(el('b', 'flg-ins-doc-vname', value.name))
        for (const block of value.blocks) item.append(docParagraph(block))
        list.append(item)
      }
      article.append(list)
    }
    return article
  }

  function shortTypeName(): string {
    const at = form.typeId.indexOf(':')
    return at < 0 ? form.typeId : form.typeId.slice(at + 1)
  }

  /** A section's documentation, with the edge-borne keys drawn in it listed too -- after the
   * group's own heading entry, before its members, which is where their rows are. */
  function docEntriesForSection(section: InspectorSection): DocEntryView[] {
    const entries = sectionDocEntries(form, section)
    if (section.key !== edgeHome || edgeFields.length === 0) return entries
    const extra = edgeFields.map((field) => edgeFieldDocEntry(field.key))
    const at = section.kind === 'group' ? 1 : 0
    return [...entries.slice(0, at), ...extra, ...entries.slice(at)]
  }

  function renderDocs(): void {
    if (docsEl === null || docsView === null) return
    const scrollTop = docsEl.querySelector('.flg-ins-docs-body')?.scrollTop ?? 0
    const section = docsView.section === null ? undefined : sections.find((candidate) => candidate.key === docsView?.section)
    docsEl.replaceChildren()

    const bar = el('div', 'flg-ins-docs-bar')
    const close = button('✕', 'Close the documentation', () => closeDocs(true), 'flg-ins-docs-close')
    bar.append(close)
    if (section !== undefined) bar.append(button('‹ Back to overview', 'Back to the overview of every section', () => openDocs(null), 'flg-ins-docs-back'))
    docsEl.append(bar)

    const body = el('div', 'flg-ins-docs-body')
    if (section === undefined) {
      docsEl.append(el('h2', 'flg-ins-docs-title', shortTypeName()))
      docsEl.append(
        el('p', 'flg-ins-docs-sub', `${form.typeId}${form.formatVersion.present ? ` · format_version ${form.formatVersion.raw}` : ''}`),
      )
      const list = el('div', 'flg-ins-docs-list')
      for (const candidate of sections) {
        const item = button('', `Explain ${candidate.title}`, () => openDocs(candidate.key), 'flg-ins-docs-item')
        item.append(el('span', 'flg-ins-docs-item-name', candidate.title))
        const count = docEntriesForSection(candidate).length
        item.append(el('span', 'flg-ins-docs-item-count', `${count} ${count === 1 ? 'field' : 'fields'}`))
        list.append(item)
      }
      body.append(list)
      body.append(
        el(
          'p',
          'flg-ins-doc-fact',
          'Clearing a box removes its key. A key that is not written is not the same as one written with its default: the engine applies its own, and each section lists what that is under "Absent".',
        ),
      )
    } else {
      docsEl.append(el('h2', 'flg-ins-docs-title', section.title))
      docsEl.append(el('p', 'flg-ins-docs-sub', shortTypeName()))
      for (const entry of docEntriesForSection(section)) body.append(docEntryEl(entry))
    }
    docsEl.append(body)
    body.scrollTop = scrollTop
  }

  /** Where a floated panel goes: the area to the left of the form's host, or -- with no room
   * there -- over the host itself. Measured from the box the host draws around this element. */
  function placeDocs(): void {
    if (docsEl === null || options.docsHost !== undefined) return
    const host = root.parentElement ?? root
    const rect = host.getBoundingClientRect()
    const roomLeft = rect.left
    const style = docsEl.style
    if (roomLeft >= 240) {
      style.left = '0px'
      style.width = `${Math.round(roomLeft)}px`
    } else {
      style.left = `${Math.round(rect.left)}px`
      style.width = `${Math.round(rect.width)}px`
    }
    style.top = `${Math.round(rect.top)}px`
    style.height = `${Math.round(rect.height)}px`
  }

  function onResize(): void {
    placeDocs()
  }

  function openDocs(section: string | null): void {
    docsView = { section }
    if (docsEl === null) {
      docsEl = el('aside', 'flg-ins-docs')
      docsEl.id = docsId
      docsEl.setAttribute('role', 'complementary')
      docsEl.setAttribute('aria-label', 'Documentation')
      docsEl.tabIndex = -1
      docsEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        closeDocs(true)
      })
      if (options.docsHost !== undefined) {
        options.docsHost.append(docsEl)
      } else {
        docsEl.dataset['float'] = 'yes'
        document.body.append(docsEl)
        window.addEventListener('resize', onResize)
      }
    }
    placeDocs()
    renderDocs()
    for (const help of root.querySelectorAll<HTMLElement>('.flg-ins-help')) {
      help.setAttribute('aria-expanded', help.closest<HTMLElement>('[data-section]')?.dataset['section'] === section ? 'true' : 'false')
    }
  }

  function closeDocs(refocus: boolean): void {
    const was = docsView?.section ?? null
    docsView = null
    if (docsEl !== null) {
      docsEl.remove()
      docsEl = null
      window.removeEventListener('resize', onResize)
    }
    for (const help of root.querySelectorAll<HTMLElement>('.flg-ins-help')) help.setAttribute('aria-expanded', 'false')
    if (refocus) {
      const target = was === null ? root.querySelector<HTMLElement>('.flg-ins-help') : root.querySelector<HTMLElement>(`[data-section=${JSON.stringify(was)}] .flg-ins-help`)
      target?.focus()
    }
  }

  // ---- the whole panel ----------------------------------------------------

  /** Which control had focus, so a redraw does not throw the person typing out of the panel.
   * Matched on the row path plus the control's index within that row. */
  function captureFocus(): { path: string; index: number; start: number | null; end: number | null } | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null
    const rowEl = active.closest<HTMLElement>('[data-path]')
    const path = rowEl?.dataset['path']
    if (rowEl === null || rowEl === undefined || path === undefined) return null
    const controls = [...rowEl.querySelectorAll('input, select, textarea, button')]
    const index = controls.indexOf(active)
    if (index < 0) return null
    const start = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null
    const end = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null
    return { path, index, start, end }
  }

  function restoreFocus(target: { path: string; index: number; start: number | null; end: number | null } | null): void {
    if (target === null) return
    const rowEl = root.querySelector<HTMLElement>(`[data-path=${JSON.stringify(target.path)}]`)
    if (rowEl === null) return
    const control = [...rowEl.querySelectorAll('input, select, textarea, button')][target.index]
    if (!(control instanceof HTMLElement)) return
    control.focus()
    if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && target.start !== null) {
      try {
        control.setSelectionRange(target.start, target.end ?? target.start)
      } catch {
        // A number input refuses a selection range in some browsers; the focus is what matters.
      }
    }
  }

  function rebuild(): void {
    if (disposed) return
    const focus = captureFocus()
    // The controls drawn over the edge editors are remade below; the editors themselves keep
    // the draft and the caret position, which is why the new control shows what was there.
    for (const view of molangViews) view.dispose()
    molangViews = []
    fields = fieldsOf(form)
    // Anything revealed and then actually written is a normal set row now, so the reveal is
    // spent. Left in place it would leak into the "hide" affordance on a row that has a value.
    for (const key of [...revealed]) {
      const path = JSON.parse(key) as (string | number)[]
      if (existsAt(fields, path)) revealed.delete(key)
    }

    const parts: HTMLElement[] = []
    const header = el('header', 'flg-ins-header')
    if (options.nodeId !== undefined) header.append(el('h2', 'flg-ins-title', options.nodeId))
    const meta = el('div', 'flg-ins-meta')
    meta.append(el('span', 'flg-ins-type', form.typeId))
    const version = form.formatVersion.present ? `format_version ${form.formatVersion.raw}` : 'no format_version'
    meta.append(document.createTextNode(` · ${version}`))
    meta.title = options.file === undefined ? `${form.typeId} · ${version}` : `${options.file} · ${version}`
    header.append(meta)
    parts.push(header)

    for (const item of form.notices) parts.push(renderNotice(item))
    // The "this type is partially implemented" coverage note is deliberately NOT shown. It is a
    // fact about how much of the engine this TOOL reproduces, not about the author's pack.

    sections = sectionsOf(form, revealed)
    edgeHome = edgeFieldHome(sections)
    for (const section of sections) {
      switch (section.kind) {
        case 'general':
          parts.push(renderGeneral(section))
          break
        case 'group':
          parts.push(renderGroupSection(section))
          break
        case 'choice':
          parts.push(renderChoiceSection(section))
          break
        case 'extras':
          parts.push(renderExtras(section))
          break
      }
    }

    root.replaceChildren(...parts)
    restoreFocus(focus)
    if (docsView !== null) {
      if (docsView.section !== null && !sections.some((section) => section.key === docsView?.section)) docsView = { section: null }
      renderDocs()
    }
  }

  rebuild()

  return {
    element: root,
    get form(): NodeForm {
      return form
    },
    update(next: NodeForm, nextEdgeFields?: readonly InspectorEdgeField[]): void {
      // A different node keeps none of the reader's place: a revealed key from the old node
      // would show an empty box on the new one, and documentation about a tree means nothing on
      // a geode. Nor its edges: an editor for the old node's connection would write the old
      // node's file.
      if (next.typeId !== form.typeId) {
        revealed.clear()
        openSections.clear()
        spellings.clear()
        pendingStates.clear()
        closeDocs(false)
        edgeFields = nextEdgeFields ?? []
      } else if (nextEdgeFields !== undefined) {
        edgeFields = nextEdgeFields
      }
      form = next
      rebuild()
    },
    dispose(): void {
      disposed = true
      for (const view of molangViews) view.dispose()
      molangViews = []
      closeDocs(false)
      root.replaceChildren()
      root.remove()
    },
  }
}
