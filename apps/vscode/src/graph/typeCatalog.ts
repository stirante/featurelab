// typeCatalog.ts -- what JSON keys each `minecraft:*_feature` type accepts, and at which
// `format_version` bands, expressed as data the node property form can render without
// knowing anything about feature types itself.
//
// WHY THIS IS A SEPARATE MODULE FROM forms.ts. The form is generic: it knows how to draw a
// block descriptor, a range, an enum. This file is the only place that knows a
// `minecraft:geode_feature` has `max_outer_wall_distance` and a
// `minecraft:multiface_feature` does not. Splitting them means a catalogue correction is a
// data edit, and it means the catalogue can be tested against the engine independently of any
// rendering.
//
// WHERE EVERY FIELD BELOW COMES FROM, because a form that confidently offers a key the engine
// does not have produces a file the game refuses to load, and that failure is silent from
// inside the editor. Each FieldSpec carries a `source` saying which of these it came from:
//
//   'builder'         -- the key is read by name in this repo's own Go builder for that type
//                        (featurelab-go/features/<type>.go). This is the strongest evidence
//                        available in-tree: the builder IS the parser, so a key it reads is a
//                        key a real pack can write, and a key it does not read is one this
//                        tool would drop. Required/optional, the numeric bounds and the
//                        absent-key defaults are read from the same code.
//   'builder-header'  -- the schema table in a builder's own file header (e.g.
//                        sculk_patch.go's `cursor_count  int, REQUIRED validated range
//                        [0, 32]`). Those tables document the type's schema
//                        and carry bounds the parsing code does not re-state.
//   'coverage-note'   -- features/coverage.go's own per-type Note, which is the user-facing
//                        prose and states several version gates and defaults outright.
//
// Nothing here is invented. Where a type's real sub-schema could not be sourced -- tree
// feature's eight trunk and twelve canopy variant bodies are the whole of that category -- the
// field is kind 'json' with an explicit `unsourced` reason, so the author gets a free-text box
// and a sentence saying why, rather than a confident set of wrong keys.
//
// ONE ENTRY HERE IS NOT A FEATURE TYPE. `minecraft:feature_rule` is the other half of a pack --
// the file that decides WHERE a feature is placed -- and it is catalogued alongside the feature
// types because this file is what the property form is built from and a rule has settings worth
// editing. Everything that makes it different from the 27 registered feature types is written on
// its own entry at the bottom of TYPE_SPECS.
//
// DELEGATION KEYS ARE NOT HERE. `places_feature`, `conditional_features`, the aggregate and
// sequence lists, scatter's `iterations`, the filter types' single children
// (`feature_to_snap`, `feature_to_place`, `feature_to_scan`) and the wire.EdgeChild pair
// (`vegetation_patch_feature.vegetation_feature`, `tree_feature`'s `log_decoration_feature`)
// are all edges in wire.Graph, not fields: wire/graph.go's GraphNode.Fields is defined as "the
// node's own JSON body minus the delegation keys". DELEGATION_KEYS below exists only so a
// stray one arriving in Fields is reported as a contract violation instead of drawn as a text
// box.

/** A parsed `format_version`, deliberately the same three-part shape featurelab-go's own
 * features/formatversion.go uses -- `present` is not redundant with an empty `parts`, because
 * "the file declared no format_version" and "the file declared something" are different
 * situations and every gate below branches on the difference. */
import { TREE_TRUNK_FIELDS } from './treeTrunks.js'
import { TREE_CANOPY_FIELDS } from './treeCanopies.js'
import { TREE_GROUND_FIELDS } from './treeGroundAndRoots.js'

export interface FormatVersion {
  /** Dotted components, most significant first. Length 2, 3 or 4; a missing component compares
   * as 0, so "1.21" and "1.21.0" are equal. */
  parts: readonly number[]
  /** Exactly as the author wrote it, for diagnostics -- echoing our normalisation back at
   * someone is markedly less useful than echoing their own text. */
  raw: string
  present: boolean
}

export class FormatVersionError extends Error {}

/** The absent version. Distinct from "1.0.0" -- see FormatVersion.present. */
export const ABSENT_FORMAT_VERSION: FormatVersion = { parts: [], raw: '', present: false }

/** The five schema bands the engine builds, lowest first -- from
 * features/typeavailability.go's `featureSchemaBands`. A file declaring a version below the
 * first matches no band at all and does not load. Exported because the palette wants to offer
 * the author a band to author against, and because these are the only five values a version
 * gate in this file can meaningfully compare to. */
export const FEATURE_SCHEMA_BANDS: readonly string[] = ['1.13.0', '1.21.10', '1.21.40', '1.26.40', '1.26.50']

/** The oldest format_version that matches any band -- features/typeavailability.go's
 * FeatureSchemaFloor. */
export const FEATURE_SCHEMA_FLOOR = '1.13.0'

/** The types the engine registers ABOVE the floor, so a file declaring an older version may not
 * name them at all -- features/typeavailability.go's `typeMinFormatVersion`. This is the
 * coarsest gate and the only one that can make a whole file fail rather than one key. Note the
 * asymmetry that file calls out explicitly: `minecraft:horizontal_tree_decoration_feature` is
 * also new in the 1.26.50 game build but is registered at the floor, so it is NOT gated and is
 * deliberately absent from this table. */
const TYPE_MIN_FORMAT_VERSION: Readonly<Record<string, string>> = {
  'minecraft:multi_block_feature': '1.26.40',
  'minecraft:multipart_block_column_feature': '1.26.40',
}

/** Keys that belong to edges rather than to a node's form. Consulted only to explain a key the
 * graph builder should have stripped -- see this file's header. */
export const DELEGATION_KEYS: ReadonlySet<string> = new Set([
  'places_feature',
  'feature',
  'features',
  'conditional_features',
  'feature_to_snap',
  'feature_to_place',
  'feature_to_scan',
  'vegetation_feature',
  'log_decoration_feature',
  'iterations',
])

// ---------------------------------------------------------------------------
// Format-version arithmetic -- a direct port of features/formatversion.go, which is
// deliberately NOT semver: Bedrock's format_version is a dotted numeric 2-to-4-tuple with no
// pre-release or build metadata, written as a string ("1.21.0") or as an array of numbers
// ([1, 21, 0]) -- both forms appear in Mojang's own packs, so both parse here.
// ---------------------------------------------------------------------------

/** Parses a `format_version` as it arrives from wire.GraphNode.FormatVersion (a string), or as
 * it appears in a raw pack file (a string or an array of numbers). Nullish and empty yield the
 * ABSENT version and no error, because absence is a real state; a value that is PRESENT and
 * unparseable throws, because silently reading it as absent would open every gate in this file
 * on a typo. */
export function parseFormatVersion(raw: string | readonly number[] | null | undefined): FormatVersion {
  if (raw === null || raw === undefined) return ABSENT_FORMAT_VERSION
  if (Array.isArray(raw)) {
    if (raw.length < 2 || raw.length > 4) {
      throw new FormatVersionError(`format_version array must have 2 to 4 elements, got ${raw.length}`)
    }
    const parts: number[] = []
    for (const [i, el] of raw.entries()) {
      if (typeof el !== 'number' || !Number.isInteger(el) || el < 0) {
        throw new FormatVersionError(`format_version[${i}] must be a non-negative whole number, got ${String(el)}`)
      }
      parts.push(el)
    }
    return { parts, raw: parts.join('.'), present: true }
  }
  if (typeof raw !== 'string') {
    throw new FormatVersionError(`format_version must be a string or an array of numbers, got ${typeof raw}`)
  }
  const text = raw.trim()
  if (text.length === 0) return ABSENT_FORMAT_VERSION
  const fields = text.split('.')
  if (fields.length < 2 || fields.length > 4) {
    throw new FormatVersionError(`format_version "${text}" must have 2 to 4 dotted components`)
  }
  const parts: number[] = []
  for (const field of fields) {
    const n = Number(field.trim())
    if (!Number.isInteger(n) || n < 0) {
      throw new FormatVersionError(`format_version "${text}" has a non-numeric component "${field}"`)
    }
    parts.push(n)
  }
  return { parts, raw: text, present: true }
}

/** -1 / 0 / +1, component-wise, missing components counting as 0. `present` plays no part:
 * ordering an absent version is the caller's decision, not something to bake into a compare. */
export function compareFormatVersions(a: FormatVersion, b: FormatVersion): number {
  const n = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < n; i++) {
    const x = a.parts[i] ?? 0
    const y = b.parts[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The gate predicate every version-gated key in this file uses, and the reason it exists
 * rather than each call site writing `!present || atLeast(...)` is that the choice has to be
 * argued once. It is the same argument features/formatversion.go makes:
 *
 * A file with no `format_version` does not load in the game AT ALL -- the key is a required
 * child of every band's schema root. So for such a file there is no "what would the engine do
 * with this key": both branches of every gate are equally counterfactual, and picking the older
 * one buys no fidelity. What it does buy is a second, quieter punishment for an omission the
 * author has already been told about, with the modern keys silently missing from their form and
 * nothing saying why. So a declared version is honoured exactly; an undeclared one is read as
 * "unversioned -- judge the keys on their own terms". */
export function atLeastOrUnversioned(version: FormatVersion, min: string): boolean {
  if (!version.present) return true
  return compareFormatVersions(version, parseFormatVersion(min)) >= 0
}

/** The oldest format_version at which this build's schema registers `typeId`. An unknown id
 * gets the floor, which is the honest answer -- TYPE_MIN_FORMAT_VERSION says nothing about
 * types the engine does not register, and an unknown id is somebody else's diagnostic. */
export function minFormatVersionForType(typeId: string): string {
  return TYPE_MIN_FORMAT_VERSION[typeId] ?? FEATURE_SCHEMA_FLOOR
}

/** Whether a file declaring `declared` may name `typeId` at all. Absent returns true, for the
 * same reason atLeastOrUnversioned does. */
export function typeAvailableAt(typeId: string, declared: FormatVersion): boolean {
  if (!declared.present) return true
  return compareFormatVersions(declared, parseFormatVersion(minFormatVersionForType(typeId))) >= 0
}

// ---------------------------------------------------------------------------
// Field kinds
// ---------------------------------------------------------------------------

/** The editor kinds that actually occur across the 29 registered types.
 *
 * `block`/`blockList` are block DESCRIPTORS, which the engine accepts in three spellings (see
 * features/shared.go's AsBlockDescriptor): a bare name string, `{name, states?}`, or
 * `{tags: "<molang query>"}`. The form must accept all three, because real packs write all
 * three, and a control that only offers a name box silently loses the other two.
 *
 * `range` is the engine's Range type, whose object spelling is `{range_min, range_max}` and NOT
 * `{min, max}`. That distinction is load-bearing rather than pedantic: given `{min, max}` the
 * engine does not reject the field, it logs `Missing member(s): "range_min", "range_max" ...`
 * and carries on with a DEGENERATE {0,0} range -- so a carver silently digs nothing. A bare
 * number and a 2-element array are the other two legal spellings.
 *
 * `molangOrNumber` is the "several keys accept either" case: a plain number or a Molang
 * expression string, both legal, parsed through the one entry point
 * (features/distribution.go's ParseMolangValue). The form must not force one.
 *
 * The composite kinds (`group`, `groupList`, `weightedBlockList`, `chance`, `coordinate`) are
 * built out of the primitives above and carry their own `entry` field sets.
 *
 * `json` is the deliberate escape hatch: a free-text raw-JSON box, used only where this
 * catalogue could not source the real sub-schema. Every one of them carries `unsourced`
 * saying what is missing and where it would have to come from. */
export type FieldKind =
  | 'block'
  | 'blockList'
  | 'weightedBlockList'
  | 'range'
  | 'enum'
  | 'boolean'
  | 'number'
  | 'integer'
  | 'molangOrNumber'
  | 'chance'
  | 'string'
  | 'group'
  | 'groupList'
  | 'coordinate'
  | 'json'

/** Where a FieldSpec's claim came from. See this file's header for what each means and why the
 * distinction is recorded rather than flattened. */
export type FieldSource = 'builder' | 'builder-header' | 'coverage-note'

export interface FieldSpec {
  key: string
  kind: FieldKind
  /** Required by the engine's schema for this type. A form must not let a create-from-scratch
   * node be saved without these, because the game refuses the file rather than defaulting. */
  required: boolean
  /** Optional to the engine and set by almost every author who creates this type -- a scatter's
   * three axes, a rule's iteration count. The form draws a primary field as a row even when the
   * file has not written it, an empty control with the documented default as its placeholder,
   * where an ordinary optional key waits behind "Add a field". Drawing the row writes nothing.
   *
   * The test is "an author creating this type sets it almost every time", not "it is important":
   * a section that is nothing but "Add a field" reads as broken, and a section that draws every
   * key the type has is the other way to bury the ones that matter. A key the file's
   * format_version does not accept is never drawn on the strength of this flag. */
  primary?: boolean
  /** Enum values in the engine's own order, for kind 'enum'. */
  values?: readonly string[]
  /** Inclusive bounds the engine's schema validates, for the numeric kinds. */
  min?: number
  max?: number
  /** What the engine does when the key is absent, as prose -- shown next to the control so an
   * author can tell "leave this out" from "write the default explicitly". Several of these are
   * the opposite of the obvious guess (sculk_patch's `central_block_placement_chance` defaults
   * to 0.0, not 1.0; single_block's `may_attach_to.auto_rotate` defaults to true), which is
   * exactly why they are carried rather than left implicit. */
  default?: string
  /** One or two sentences of help. Present only where it changes what an author would write. */
  doc?: string
  /** Lowest format_version at which this key exists in the schema. Below it the key is not in
   * the schema at all: the engine logs "this member was found in the input, but is not present
   * in the Schema" and drops the value. */
  since?: string
  /** First format_version at which this key STOPPED existing (exclusive). Used for the older
   * half of a rename and for scatter's flat parameter keys. */
  until?: string
  /** The other spelling of the same key across a rename. No version accepts both. */
  renamedTo?: string
  renamedFrom?: string
  /** A game BUILD in which this key appeared, where whether the schema gates it on
   * format_version was NOT established. The form shows this as a caveat rather than as a gate,
   * because asserting a gate that is not established is how a form starts refusing keys the game
   * accepts. */
  introducedInBuild?: string
  /** Sub-fields, for kinds 'group', 'groupList' and 'coordinate'. */
  entry?: readonly FieldSpec[]
  /** For kind 'groupList': the exact number of elements the engine accepts, where that number is
   * fixed -- a scatter axis's `extent` is [min, max] and nothing else. Absent means any length. */
  length?: number
  /** For kind 'blockList': the key also takes ONE bare block descriptor as shorthand for a
   * one-element list. Only the attach-map face keys (features/single_block.go's parseAttachMap)
   * and a tree's `base_block` do; every other block list is read by AsBlockDescriptorList, which
   * refuses anything but an array ("must be an array"). */
  acceptsSingle?: boolean
  /** For kind 'json': what could not be sourced, and where it would have to come from. Shown
   * verbatim next to the free-text box. */
  unsourced?: string
  /** Names a set of keys of which exactly one may be present -- see TypeSpec.exclusiveGroups. */
  exclusiveGroup?: string
  source: FieldSource
}

export interface ExclusiveGroup {
  name: string
  /** Whether the type fails to load with none of the group's keys present. */
  required: boolean
  doc: string
}

export interface TypeSpec {
  typeId: string
  fields: readonly FieldSpec[]
  /** Sets of mutually exclusive keys (tree's trunk and canopy variants). */
  exclusiveGroups?: readonly ExclusiveGroup[]
}

// ---------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------

/** The four carver fields every `*_cave_carver_feature` shares, read from features/cave.go's
 * `floatRange` call sites. All four are Range-typed and all four default to a zero-width
 * {0, 0} when absent, which for a carver means that dimension contributes nothing. */
const CARVER_RANGES: readonly FieldSpec[] = [
  { key: 'y_scale', kind: 'range', required: false, default: '{0, 0}', source: 'builder' },
  { key: 'horizontal_radius_multiplier', kind: 'range', required: false, default: '{0, 0}', source: 'builder' },
  { key: 'vertical_radius_multiplier', kind: 'range', required: false, default: '{0, 0}', source: 'builder' },
  { key: 'floor_level', kind: 'range', required: false, default: '{0, 0}', source: 'builder' },
]

/** The carver keys shared by cave / nether_cave / underwater_cave, minus each type's own
 * extras. `width_modifier` is one of the handful of genuinely Molang-or-number fields: a plain
 * number is read directly with no evaluation and no RNG draw, a string is compiled. */
const CARVER_COMMON: readonly FieldSpec[] = [
  { key: 'fill_with', kind: 'block', required: false, default: 'no fill (the carve leaves the cell empty)', source: 'builder' },
  {
    key: 'width_modifier',
    kind: 'molangOrNumber',
    required: false,
    default: '0.0',
    doc: 'A number is read directly. A Molang string is compiled and evaluated per carve -- and because the engine evaluates it against a generator that is not derived from the world seed, a non-constant expression previews a faithful EXAMPLE of the shape rather than the shape the game will produce for this seed.',
    source: 'builder',
  },
  { key: 'skip_carve_chance', kind: 'integer', required: false, default: '0', source: 'builder' },
  { key: 'height_limit', kind: 'integer', required: false, default: '0', source: 'builder' },
  ...CARVER_RANGES,
]

/** A weighted block choice -- `{block: <descriptor>, weight: <number>}`. single_block's
 * places_block array (at 1.21.40 and above) and growing_plant's body/head block lists are the
 * two shapes built from it. */
const WEIGHTED_BLOCK_ENTRY: readonly FieldSpec[] = [
  { key: 'block', kind: 'block', required: true, source: 'builder' },
  { key: 'weight', kind: 'number', required: true, source: 'builder' },
]

/** single_block's attach map. The nine direction keys are read from single_block.go's own
 * ordered list; `all`, `sides` and `diagonal` are GROUP keys that expand to several directions
 * at once, not directions of their own. */
const ATTACH_DIRECTIONS = ['top', 'bottom', 'north', 'east', 'south', 'west', 'all', 'sides'] as const

function attachMapFields(includeDiagonal: boolean): FieldSpec[] {
  const fields: FieldSpec[] = ATTACH_DIRECTIONS.map((key) => ({
    key,
    kind: 'blockList' as const,
    required: false,
    acceptsSingle: true,
    source: 'builder' as const,
  }))
  if (includeDiagonal) {
    fields.push({
      key: 'diagonal',
      kind: 'blockList',
      required: false,
      acceptsSingle: true,
      since: '1.21.40',
      doc: 'A group key covering the diagonal attachment directions. Registered only at format_version 1.21.40 and above.',
      source: 'builder',
    })
  }
  fields.push(
    {
      key: 'min_sides_must_attach',
      kind: 'integer',
      required: false,
      default: '4',
      doc: 'Only the four CARDINAL sides are counted against this. Top, bottom and the diagonals are hard gates checked individually, and a direction you did not configure counts as attached for free.',
      source: 'builder',
    },
    {
      key: 'auto_rotate',
      kind: 'boolean',
      required: false,
      default: 'true',
      doc: 'Defaults to TRUE, so a bare `may_attach_to: {}` rotates. With all four sides matching for free the LAST one wins, which is why such a file always comes out facing west.',
      source: 'coverage-note',
    },
  )
  return fields
}

/** One axis of a scatter `distribution`. The scalar spelling (a number or a Molang string) and
 * the object spelling are both legal for the same key, which is why this is its own kind rather
 * than a plain group -- see features/distribution.go's ParseCoordinateRange. */
const COORDINATE_ENTRY: readonly FieldSpec[] = [
  {
    key: 'distribution',
    kind: 'enum',
    required: true,
    values: ['uniform', 'gaussian', 'inverse_gaussian', 'fixed_grid', 'jittered_grid', 'triangle'],
    source: 'builder',
  },
  {
    key: 'extent',
    kind: 'groupList',
    required: true,
    doc: 'A 2-element [min, max] array. Both ends are Molang-or-number.',
    length: 2,
    entry: [{ key: '', kind: 'molangOrNumber', required: true, source: 'builder' }],
    source: 'builder',
  },
  {
    key: 'step_size',
    kind: 'number',
    required: false,
    default: '1 -- NOT established; 1 is the only value that makes a bare fixed_grid/jittered_grid axis non-degenerate',
    source: 'builder',
  },
  { key: 'grid_offset', kind: 'number', required: false, default: '0', source: 'builder' },
]

/** scatter's `scatter_chance`, which accepts a percent (number or Molang string) OR a
 * `{numerator, denominator}` fraction object. Worth the author knowing, and stated on the
 * control rather than buried: a CONSTANT percent outside (0, 100] is content-logged by the
 * engine and then replaced with 100, so `scatter_chance: 0` -- which reads like "never" --
 * always scatters. */
const CHANCE_ENTRY: readonly FieldSpec[] = [
  { key: 'numerator', kind: 'integer', required: true, source: 'builder' },
  { key: 'denominator', kind: 'integer', required: true, source: 'builder' },
]

const SCATTER_CHANCE_FIELD: FieldSpec = {
  key: 'scatter_chance',
  kind: 'chance',
  required: false,
  default: '100 (always scatters)',
  doc: 'Either a percent -- a number or a Molang string -- or a {numerator, denominator} fraction. A CONSTANT percent outside (0, 100] is rewritten to 100 by the engine, so `scatter_chance: 0` always scatters; use iterations 0 for "never". numerator and denominator are 32-bit integers, so {1.5, 4} runs as 2/4.',
  source: 'builder',
}

const COORDINATE_EVAL_ORDER_FIELD: FieldSpec = {
  key: 'coordinate_eval_order',
  kind: 'enum',
  required: false,
  values: ['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'],
  default: 'xzy',
  // No `doc` here, deliberately. What this key does is the one explanation six values all rest
  // on, so it is written ONCE in docs/catalog.ts -- as the field's own entry, which both the page
  // and the `?` panel render immediately above the list of values. A copy here would be the same
  // paragraph a second time, directly under the first, on every surface that shows both.
  source: 'builder',
}

function coordinateField(key: 'x' | 'y' | 'z'): FieldSpec {
  return {
    key,
    kind: 'coordinate',
    required: false,
    // Primary on every type that has one: the axes are what a scatter IS, and a rule with no
    // spread is a rule that places everything at the chunk corner.
    primary: true,
    default: 'a zero-width axis at the origin',
    doc: 'A number, a Molang string, or a {distribution, extent} object.',
    entry: COORDINATE_ENTRY,
    source: 'builder',
  }
}

// ---------------------------------------------------------------------------
// Placement passes -- a CLOSED enum, and the reason it has to be one
// ---------------------------------------------------------------------------

/** The game's decoration passes, in order -- rules/schema.go's
 * `placementPasses`.
 *
 * ORDER IS PART OF THE DATA. Chunk decoration walks exactly these, in exactly this order, so the
 * list doubles as "when in the chunk's life does my rule run", and re-sorting it alphabetically
 * for a dropdown would throw that away.
 *
 * AND IT IS CLOSED, which is the whole reason this is an enum and not a text box. A rule naming
 * a pass outside this list still LOADS: the engine logs an unknown-pass line and then KEEPS the
 * string verbatim -- no substitution, no fallback to a default. Decoration only ever visits the
 * passes it knows, so such a rule is inserted, attached to every biome it matches, and then
 * never reached. It places nothing, in every chunk, forever, and the only sign is one line in a
 * log nobody has open. A typo in a free-text field would cost exactly that. */
export const PLACEMENT_PASSES = [
  'first_pass',
  'before_underground_pass',
  'underground_pass',
  'after_underground_pass',
  'before_surface_pass',
  'surface_pass',
  'after_surface_pass',
  'before_sky_pass',
  'sky_pass',
  'after_sky_pass',
  'final_pass',
] as const

export type PlacementPass = (typeof PLACEMENT_PASSES)[number]

/** The twelfth pass the engine accepts, kept apart from the eleven because it is not
 * interchangeable with them: a feature's placement-legality test lets exactly ONE type run here
 * and refuses every other with a log line and no placement (rules/schema.go's
 * `PregenerationPassAllows`). It is offered, because a cave-carver rule needs it and hiding it
 * would make that rule unwritable from this editor -- and its doc says what it costs. */
export const PREGENERATION_PASS = 'pregeneration_pass'

/** The one feature type that may be placed in `pregeneration_pass`. */
export const PREGENERATION_PASS_TYPE = 'minecraft:cave_carver_feature'

/** Every value `conditions.placement_pass` accepts, in the engine's own order. */
export const PLACEMENT_PASS_VALUES: readonly string[] = [...PLACEMENT_PASSES, PREGENERATION_PASS]

/** The pass a rule created from scratch starts in.
 *
 * `surface_pass` rather than the enum's first member: the first member is `first_pass`, which
 * runs before the terrain a decoration usually wants to sit on has been shaped, so a new rule
 * defaulted there would place into a world that is not there yet and read as broken. This is the
 * one place in this catalogue that states a PLAUSIBLE value rather than a shape, and it does so
 * because a rule with no pass does not load at all -- there is no "leave it out" to fall back
 * on. */
export const DEFAULT_PLACEMENT_PASS: PlacementPass = 'surface_pass'

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const TYPE_SPECS: readonly TypeSpec[] = [
  // ---- delegation-only types: their whole JSON surface except these is edges ----
  {
    typeId: 'minecraft:aggregate_feature',
    fields: [
      {
        key: 'early_out',
        kind: 'enum',
        required: false,
        values: ['none', 'first_success', 'first_failure'],
        default: 'none',
        doc: 'Unrelated to conditional_list\'s `early_out_scheme` despite the shared word -- two different engine enums with different strings and values.',
        source: 'builder',
      },
    ],
  },
  {
    // sequence_feature's schema has NO `early_out` key at all (features/aggregate.go says so
    // explicitly). An empty field set is a real answer, not a gap: everything this type has is
    // edges.
    typeId: 'minecraft:sequence_feature',
    fields: [],
  },
  {
    typeId: 'minecraft:conditional_list',
    fields: [
      {
        key: 'early_out_scheme',
        kind: 'enum',
        required: false,
        values: ['condition_success', 'placement_success', 'none'],
        default: 'none',
        doc: 'The default CHANGED to `none` -- a file that relied on the old default behaves differently now. Under `none` every entry whose condition passes places, and the list reports the last placement that succeeded.',
        source: 'coverage-note',
      },
    ],
  },
  {
    typeId: 'minecraft:weighted_random_feature',
    // Weights live on the edges (wire.GraphEdge.Weight), so nothing is left here.
    fields: [],
  },
  {
    typeId: 'minecraft:scan_surface',
    fields: [],
  },

  // ---- everything else ----
  {
    typeId: 'minecraft:ore_feature',
    fields: [
      { key: 'count', kind: 'integer', required: true, source: 'builder' },
      { key: 'discard_chance_on_air_exposure', kind: 'number', required: false, source: 'builder' },
      {
        key: 'replace_rules',
        kind: 'groupList',
        required: false,
        // Primary: optional to the schema, and a vein without it places nothing, so nobody
        // creating an ore leaves it out on purpose.
        primary: true,
        doc: 'Omitting this is legal and the file loads -- and the feature then places NOTHING. It is not free either: the emptiness check happens AFTER three RNG draws, so a rules-less vein still shifts whatever is placed after it in the same chain. An explicitly EMPTY array is refused by the engine (minimum size 1); omit the key instead.',
        entry: [
          { key: 'places_block', kind: 'block', required: true, source: 'builder' },
          { key: 'may_replace', kind: 'blockList', required: false, source: 'builder' },
        ],
        source: 'builder',
      },
    ],
  },
  {
    typeId: 'minecraft:scatter_feature',
    fields: [
      { key: 'project_input_to_floor', kind: 'boolean', required: false, source: 'builder' },
      {
        key: 'distribution',
        kind: 'group',
        required: true,
        since: '1.21.10',
        doc: 'The nested parameter object. Registered only at format_version 1.21.10 and above; below that the same parameters are flat keys on the feature body. The two shapes are mutually exclusive -- writing this key in an older-versioned file has the engine drop it unread and then fail on the missing flat `iterations`.',
        // scatter_chance is primary HERE and not on a feature rule: a scatter is the thing an
        // author gates, and the chance is set alongside the axes almost every time.
        entry: [{ ...SCATTER_CHANCE_FIELD, primary: true }, COORDINATE_EVAL_ORDER_FIELD, coordinateField('x'), coordinateField('y'), coordinateField('z')],
        source: 'builder',
      },
      // The flat spelling, for files below 1.21.10. `iterations` is the sixth legacy key and is
      // deliberately absent: it is carried on the scatter EDGE (wire.GraphEdge.Iterations),
      // where wire/graph.go argues at length that modelling it as a spin-box would make its two
      // real idioms -- condition, and variable setup -- harder to write than plain text does.
      // The inspector still shows it beside these keys, as the edge's own editor handed in by
      // the host (inspector.ts, `edgeFields`), so the value the file holds is reachable from
      // the section the file holds it in.
      { ...SCATTER_CHANCE_FIELD, primary: true, until: '1.21.10' },
      { ...COORDINATE_EVAL_ORDER_FIELD, until: '1.21.10' },
      { ...coordinateField('x'), until: '1.21.10' },
      { ...coordinateField('y'), until: '1.21.10' },
      { ...coordinateField('z'), until: '1.21.10' },
    ],
  },
  {
    typeId: 'minecraft:search_feature',
    fields: [
      {
        key: 'search_volume',
        kind: 'group',
        required: true,
        doc: 'This field really does use `min`/`max` -- it is not a Range object, just a struct whose two members happen to be named that way.',
        entry: [
          { key: 'min', kind: 'groupList', required: true, doc: 'A 3-element [x, y, z] array.', entry: [{ key: '', kind: 'integer', required: true, source: 'builder' }], source: 'builder' },
          { key: 'max', kind: 'groupList', required: true, doc: 'A 3-element [x, y, z] array.', entry: [{ key: '', kind: 'integer', required: true, source: 'builder' }], source: 'builder' },
        ],
        source: 'builder',
      },
      { key: 'search_axis', kind: 'enum', required: true, values: ['-x', '+x', '-y', '+y', '-z', '+z'], source: 'builder' },
      {
        key: 'required_successes',
        kind: 'integer',
        required: false,
        default: '1',
        doc: '0 loads and warns: the engine compares the success counter for EQUALITY after incrementing, so a counter tested only at 1 or more never matches 0 and the search exhausts. Whether the engine\'s own test is == or >= has NOT been established.',
        source: 'builder',
      },
    ],
  },
  {
    typeId: 'minecraft:single_block_feature',
    fields: [
      {
        key: 'places_block',
        kind: 'weightedBlockList',
        required: true,
        since: '1.21.40',
        doc: 'A block name, a {name, states} object, a {tags} object, or a non-empty array of {block, weight} objects. The array is what format_version 1.21.40 added; the three single-block spellings work at every version. Below 1.21.40 an array is rejected outright, which leaves this required key unset and the file does not load.',
        entry: WEIGHTED_BLOCK_ENTRY,
        source: 'builder',
      },
      {
        key: 'places_block',
        kind: 'block',
        required: true,
        until: '1.21.40',
        doc: 'A single block descriptor. The weighted-array form arrives at format_version 1.21.40.',
        source: 'builder',
      },
      {
        key: 'enforce_placement_rules',
        kind: 'boolean',
        required: true,
        doc: 'Required by the schema, and a no-op during world generation -- the engine\'s own checks always pass there.',
        source: 'builder',
      },
      { key: 'enforce_survivability_rules', kind: 'boolean', required: true, doc: 'Required by the schema, and a no-op during world generation.', source: 'builder' },
      { key: 'randomize_rotation', kind: 'boolean', required: false, since: '1.21.40', source: 'builder' },
      { key: 'may_replace', kind: 'blockList', required: false, source: 'builder' },
      { key: 'may_attach_to', kind: 'group', required: false, entry: attachMapFields(true), source: 'builder' },
      { key: 'may_not_attach_to', kind: 'group', required: false, since: '1.21.40', entry: attachMapFields(true), source: 'builder' },
    ],
  },
  {
    typeId: 'minecraft:snap_to_surface_feature',
    fields: [
      {
        key: 'search_range',
        kind: 'number',
        required: true,
        since: '1.26.50',
        renamedFrom: 'vertical_search_range',
        doc: 'The scan reaches a surface at exactly this many blocks; a range below 2 checks the block NEXT TO the origin rather than the origin itself.',
        source: 'builder',
      },
      {
        key: 'vertical_search_range',
        kind: 'number',
        required: true,
        until: '1.26.50',
        renamedTo: 'search_range',
        doc: 'Renamed to `search_range` at format_version 1.26.50. Both spellings set the same value, so it is one key with two names -- and no version accepts both.',
        source: 'builder',
      },
      {
        key: 'surface',
        kind: 'enum',
        required: false,
        values: ['floor', 'ceiling', 'wall', 'random_horizontal'],
        default: 'floor',
        doc: 'The default is FLOOR, not ceiling -- this tool said ceiling until 2026-08-15 and was wrong about it in every build. `wall` tries the four horizontal directions in a random order.',
        introducedInBuild: '`wall` is new in game build 1.26.50.24',
        source: 'coverage-note',
      },
      {
        key: 'allowed_surface_blocks',
        kind: 'blockList',
        required: false,
        doc: 'With no allow-list the surface test is the real per-face one: the game asks whether the candidate can support something on the face the scan arrived at, which is not the same as asking whether it is solid. A {"tags": ...} entry matches NOTHING in the real game -- the preview will look like it works and the feature will place nothing in the world.',
        source: 'builder',
      },
      { key: 'allow_air_placement', kind: 'boolean', required: false, source: 'builder' },
      { key: 'allow_underwater_placement', kind: 'boolean', required: false, source: 'builder' },
      { key: 'embed_in_surface', kind: 'boolean', required: false, source: 'builder' },
      {
        key: 'allow_non_air_placement',
        kind: 'boolean',
        required: false,
        default: 'false',
        doc: 'Lets a snap that starts inside a solid block escape outwards instead of failing.',
        introducedInBuild: 'game build 1.26.50.24 -- whether the schema gates this key on format_version was NOT established, so it is offered at every version rather than hidden below one',
        source: 'coverage-note',
      },
    ],
  },
  {
    typeId: 'minecraft:structure_template_feature',
    fields: [
      { key: 'structure_name', kind: 'string', required: true, source: 'builder' },
      {
        key: 'facing_direction',
        kind: 'enum',
        required: false,
        values: ['south', 'west', 'north', 'east', 'random'],
        default: 'south',
        source: 'builder',
      },
      { key: 'rotate_around_center', kind: 'boolean', required: false, source: 'builder' },
      { key: 'ground_level', kind: 'integer', required: false, min: 0, doc: 'A negative value is refused -- the schema minimum is 0, and nothing in the engine clamps it.', source: 'builder' },
      {
        key: 'adjustment_radius',
        kind: 'integer',
        required: false,
        min: 0,
        max: 16,
        doc: 'Outside [0, 16] the engine refuses the file; nothing clamps it.',
        source: 'builder',
      },
      {
        key: 'constraints',
        kind: 'group',
        required: false,
        entry: [
          { key: 'grounded', kind: 'group', required: false, entry: [], doc: 'An empty object. Sampled at the ground row; a VOID cell and an explicit minecraft:air both count as empty.', source: 'builder' },
          { key: 'unburied', kind: 'group', required: false, entry: [], doc: 'An empty object. Samples the fixed top row of the structure.', source: 'builder' },
          {
            key: 'block_intersection',
            kind: 'group',
            required: false,
            entry: [
              {
                key: 'block_allowlist',
                kind: 'blockList',
                required: true,
                doc: 'Required by the schema -- a block_intersection without it is refused, as it is in game. `block_whitelist` is the accepted alias.',
                source: 'builder',
              },
              {
                key: 'only_check_intersection_for_motion_blocking_blocks',
                kind: 'boolean',
                required: false,
                default: 'true',
                doc: 'The engine default is TRUE, so a file that never mentions it gets the NARROW check.',
                source: 'builder',
              },
            ],
            source: 'builder',
          },
          {
            key: 'leveled',
            kind: 'group',
            required: false,
            entry: [
              {
                key: 'max_steepness',
                kind: 'integer',
                required: false,
                default: '2',
                doc:
                  'Scans from this far below each point to one MORE than this above it for a solid-over-air ' +
                  'transition, and refuses the whole placement if any point lacks one. The window is a row ' +
                  'taller on top than underneath, which is why 0 still finds flat ground rather than nothing.',
                source: 'builder',
              },
            ],
            source: 'builder',
          },
        ],
        source: 'builder',
      },
    ],
  },
  {
    typeId: 'minecraft:surface_relative_threshold_feature',
    fields: [
      {
        key: 'minimum_distance_below_surface',
        kind: 'integer',
        required: false,
        default: '0',
        doc: 'Stored as an int32, so a fractional value truncates. `min_distance_below_surface` is NOT an alias -- it is a spelling an earlier revision of this port invented, and a file using it is refused.',
        source: 'builder',
      },
    ],
  },
  {
    typeId: 'minecraft:height_difference_filter_feature',
    fields: [
      { key: 'search_radius', kind: 'integer', required: true, source: 'builder-header' },
      { key: 'min_required_upward_height_diff', kind: 'integer', required: false, source: 'builder-header' },
      { key: 'min_required_downward_height_diff', kind: 'integer', required: false, source: 'builder-header' },
      { key: 'max_allowed_upward_height_diff', kind: 'integer', required: false, source: 'builder-header' },
      { key: 'max_allowed_downward_height_diff', kind: 'integer', required: false, source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:partially_exposed_blob_feature',
    fields: [
      { key: 'places_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'placement_radius_around_floor', kind: 'integer', required: true, min: 1, max: 8, source: 'builder-header' },
      { key: 'placement_probability_per_valid_position', kind: 'number', required: true, min: 0, max: 1, source: 'builder-header' },
      { key: 'exposed_face', kind: 'enum', required: false, values: ['up', 'down', 'north', 'south', 'east', 'west'], default: 'up', source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:tree_feature',
    exclusiveGroups: [
      { name: 'trunk', required: true, doc: 'Exactly one trunk variant. The type does not load without one, and two is an error.' },
      { name: 'canopy', required: false, doc: 'At most one canopy variant. `canopy` (bare) is the generic/default shape.' },
    ],
    fields: [
      // The eight trunk variants, with the keys each one accepts -- see treeTrunks.ts. They used
      // to be eight raw-JSON boxes carrying a note that their key sets had never been
      // described, which is what made editing a tree the weakest thing in this editor: the
      // choice of variant was a real control and its entire contents were a text area.
      // Ordered for reading, with the bare key first. That is a PRESENTATION decision and not
      // the engine's own order: `trunk` is the simple shape, it is what someone reaches for
      // before knowing the others exist, and the canopy group's doc already introduces its own
      // bare key as the generic one. Nothing downstream depends on this order -- unlike an
      // aggregate's list, where order is semantics.
      ...[...TREE_TRUNK_FIELDS].sort((a, b) => (a.key === 'trunk' ? -1 : b.key === 'trunk' ? 1 : 0)),
      // The twelve canopy variants, with the keys each one accepts -- see treeCanopies.ts. Like
      // the trunks above, these were twelve raw-JSON boxes. They genuinely do not share a
      // sub-schema: leaf_block is on ten of the twelve, canopy_height is a plain integer on one
      // variant and a range on four others, and canopy_decoration is a DIFFERENT object on each
      // of the two variants that have it.
      ...[...TREE_CANOPY_FIELDS].sort((a, b) => (a.key === 'canopy' ? -1 : b.key === 'canopy' ? 1 : 0)),
      { key: 'base_block', kind: 'blockList', required: false, acceptsSingle: true, doc: 'A single descriptor or a list; both are accepted.', source: 'builder' },
      { key: 'may_grow_on', kind: 'blockList', required: false, source: 'builder' },
      { key: 'may_grow_through', kind: 'blockList', required: false, source: 'builder' },
      { key: 'may_replace', kind: 'blockList', required: false, source: 'builder' },
      ...TREE_GROUND_FIELDS,
    ],
  },
  {
    typeId: 'minecraft:vegetation_patch_feature',
    fields: [
      { key: 'replaceable_blocks', kind: 'blockList', required: true, doc: 'Must be non-empty.', source: 'builder' },
      { key: 'ground_block', kind: 'block', required: true, source: 'builder' },
      { key: 'depth', kind: 'range', required: true, source: 'builder' },
      { key: 'horizontal_radius', kind: 'range', required: true, source: 'builder' },
      { key: 'vertical_range', kind: 'number', required: true, min: 1, source: 'builder' },
      { key: 'surface', kind: 'enum', required: false, values: ['floor', 'ceiling'], default: 'floor', source: 'builder' },
      { key: 'vegetation_chance', kind: 'number', required: false, default: '0.0', source: 'builder' },
      { key: 'extra_deep_block_chance', kind: 'number', required: false, default: '0.0', source: 'builder' },
      { key: 'extra_edge_column_chance', kind: 'number', required: false, default: '0.0', source: 'builder' },
      { key: 'waterlogged', kind: 'boolean', required: false, default: 'false', source: 'builder' },
    ],
  },
  {
    typeId: 'minecraft:sculk_patch_feature',
    fields: [
      { key: 'can_place_sculk_patch_on', kind: 'blockList', required: true, source: 'builder' },
      { key: 'central_block', kind: 'block', required: false, default: 'no central block is placed', source: 'builder' },
      {
        key: 'central_block_placement_chance',
        kind: 'number',
        required: false,
        default: '0.0 -- NOT 1.0, which is the guess this field usually gets',
        source: 'builder-header',
      },
      { key: 'charge_amount', kind: 'integer', required: true, min: 1, max: 1000, source: 'builder-header' },
      { key: 'cursor_count', kind: 'integer', required: true, min: 0, max: 32, source: 'builder-header' },
      { key: 'spread_attempts', kind: 'integer', required: true, min: 1, max: 4, doc: 'The schema bounds this to [1, 4], so it is not a way to switch the spread off.', source: 'builder-header' },
      { key: 'growth_rounds', kind: 'integer', required: true, min: 0, max: 8, source: 'builder-header' },
      { key: 'spread_rounds', kind: 'integer', required: true, min: 0, max: 8, source: 'builder-header' },
      { key: 'extra_growth_chance', kind: 'range', required: false, default: '{0, 0}', source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:growing_plant_feature',
    fields: [
      {
        key: 'height_distribution',
        kind: 'groupList',
        required: true,
        doc: 'A non-empty array of [<int range>, <weight>] pairs.',
        entry: [
          { key: '0', kind: 'range', required: true, source: 'builder-header' },
          { key: '1', kind: 'number', required: true, source: 'builder-header' },
        ],
        source: 'builder-header',
      },
      {
        key: 'growth_direction',
        kind: 'enum',
        required: true,
        values: ['up', 'down'],
        doc: 'Matched case-insensitively here, because the sibling face field lowercases its value before matching -- so "Down" and "UP" almost certainly load in the real game too.',
        source: 'builder',
      },
      { key: 'body_blocks', kind: 'weightedBlockList', required: true, doc: 'Non-empty.', entry: WEIGHTED_BLOCK_ENTRY, source: 'builder-header' },
      { key: 'head_blocks', kind: 'weightedBlockList', required: true, doc: 'Non-empty.', entry: WEIGHTED_BLOCK_ENTRY, source: 'builder-header' },
      { key: 'age', kind: 'range', required: false, default: '{0, 0}', source: 'builder-header' },
      { key: 'allow_water', kind: 'boolean', required: false, default: 'false', source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:geode_feature',
    fields: [
      { key: 'filler', kind: 'block', required: true, source: 'builder' },
      { key: 'inner_layer', kind: 'block', required: true, source: 'builder' },
      { key: 'alternate_inner_layer', kind: 'block', required: true, source: 'builder' },
      { key: 'middle_layer', kind: 'block', required: true, source: 'builder' },
      { key: 'outer_layer', kind: 'block', required: true, source: 'builder' },
      { key: 'inner_placements', kind: 'blockList', required: false, source: 'builder' },
      { key: 'min_outer_wall_distance', kind: 'integer', required: true, min: 1, max: 10, source: 'builder' },
      { key: 'max_outer_wall_distance', kind: 'integer', required: true, min: 1, max: 20, source: 'builder' },
      { key: 'min_distribution_points', kind: 'integer', required: true, min: 1, max: 10, source: 'builder' },
      { key: 'max_distribution_points', kind: 'integer', required: true, min: 1, max: 20, source: 'builder' },
      { key: 'min_point_offset', kind: 'integer', required: true, min: 0, max: 10, source: 'builder' },
      { key: 'max_point_offset', kind: 'integer', required: true, min: 0, max: 10, source: 'builder' },
      { key: 'max_radius', kind: 'integer', required: true, source: 'builder' },
      { key: 'crack_point_offset', kind: 'integer', required: true, min: 0, max: 10, source: 'builder' },
      {
        key: 'generate_crack_chance',
        kind: 'number',
        required: true,
        min: 0,
        max: 1,
        doc: 'Schema-required and validated, but not read anywhere in the engine\'s placement routine that has been located -- the crack roll it looks like it controls is a hardcoded 0.95 compare.',
        source: 'builder',
      },
      { key: 'base_crack_size', kind: 'number', required: true, min: 0, max: 5, doc: 'Schema-required and validated, but not read during placement -- see generate_crack_chance.', source: 'builder' },
      { key: 'noise_multiplier', kind: 'number', required: true, source: 'builder' },
      { key: 'use_potential_placements_chance', kind: 'number', required: true, min: 0, max: 1, source: 'builder' },
      { key: 'use_alternate_layer0_chance', kind: 'number', required: true, min: 0, max: 1, source: 'builder' },
      { key: 'placements_require_layer0_alternate', kind: 'boolean', required: true, source: 'builder' },
      { key: 'invalid_blocks_threshold', kind: 'integer', required: true, source: 'builder' },
    ],
  },
  {
    typeId: 'minecraft:cave_carver_feature',
    fields: CARVER_COMMON,
  },
  {
    typeId: 'minecraft:nether_cave_carver_feature',
    fields: CARVER_COMMON,
  },
  {
    typeId: 'minecraft:underwater_cave_carver_feature',
    fields: [...CARVER_COMMON, { key: 'replace_air_with', kind: 'block', required: false, source: 'builder' }],
  },
  {
    typeId: 'minecraft:multiface_feature',
    fields: [
      { key: 'places_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'search_range', kind: 'integer', required: true, min: 1, max: 64, source: 'builder-header' },
      { key: 'can_place_on_floor', kind: 'boolean', required: true, source: 'builder-header' },
      { key: 'can_place_on_ceiling', kind: 'boolean', required: true, source: 'builder-header' },
      { key: 'can_place_on_wall', kind: 'boolean', required: true, source: 'builder-header' },
      { key: 'chance_of_spreading', kind: 'number', required: true, min: 0, max: 1, source: 'builder-header' },
      { key: 'can_place_on', kind: 'blockList', required: false, doc: 'Optional, minimum 1 entry when written.', source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:fossil_feature',
    fields: [
      { key: 'ore_block', kind: 'block', required: true, source: 'builder' },
      { key: 'max_empty_corners', kind: 'integer', required: true, source: 'builder' },
    ],
  },
  {
    typeId: 'minecraft:horizontal_tree_decoration_feature',
    fields: [
      { key: 'places_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'allow_adjacent', kind: 'boolean', required: false, default: 'false', source: 'builder-header' },
      { key: 'bark_side_only', kind: 'boolean', required: false, default: 'false', source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:multi_block_feature',
    fields: [
      { key: 'places_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'enforce_placement_rules', kind: 'boolean', required: false, default: 'false', source: 'builder-header' },
      { key: 'randomize_rotation', kind: 'boolean', required: false, default: 'false', source: 'builder-header' },
      { key: 'may_replace', kind: 'blockList', required: false, source: 'builder-header' },
    ],
  },
  {
    typeId: 'minecraft:multipart_block_column_feature',
    fields: [
      { key: 'tip_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'frustum_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'middle_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'base_block', kind: 'block', required: true, source: 'builder-header' },
      { key: 'height_range', kind: 'range', required: false, default: '{-1, -1}', source: 'builder-header' },
      {
        key: 'weighted_heights',
        kind: 'groupList',
        required: false,
        entry: [
          { key: 'value', kind: 'integer', required: true, source: 'builder' },
          { key: 'weight', kind: 'number', required: true, source: 'builder' },
        ],
        source: 'builder-header',
      },
      {
        key: 'direction',
        kind: 'enum',
        required: false,
        values: ['down', 'up', 'north', 'south', 'west', 'east'],
        default: 'up',
        doc: 'An unrecognised value falls back to the default silently in the engine.',
        source: 'builder',
      },
      { key: 'may_place_on', kind: 'blockList', required: false, source: 'builder-header' },
      { key: 'may_replace', kind: 'blockList', required: false, source: 'builder-header' },
    ],
  },

  // -------------------------------------------------------------------------
  // The one entry here that is not a feature type
  // -------------------------------------------------------------------------
  //
  // `minecraft:feature_rule` is the other half of a pack: a pack of fifty features and no rules
  // generates nothing, because a rule is the only thing that attaches a feature to a biome and a
  // decoration pass. It is catalogued here, beside the feature types, because this file is what
  // the property form is built from and a rule has settings worth editing -- but four things
  // about it are different from everything above, and each one is a trap if it is missed:
  //
  //   1. THE NODE'S TYPE AND THE FILE'S ROOT KEY ARE DIFFERENT STRINGS. The graph gives a rule
  //      the synthetic SINGULAR `minecraft:feature_rule` because the node names one rule; the
  //      file is rooted at the PLURAL `minecraft:feature_rules` because that key names the
  //      collection. Neither is derived from the other by trimming an `s`, and a JSONPath built
  //      from the node's type addresses nothing. compounds/spec.ts holds both constants.
  //   2. IT HAS NO COVERAGE ROW, and correctly gets none: the engine's coverage table is a table
  //      of FEATURE types. So it is not offered by `buildTypePalette`, which walks that table --
  //      palette.ts adds it as its own entry, next to the compounds, for the same reason.
  //   3. ITS AUTHORITY IS NOT A features/*.go BUILDER. The whole schema -- the accepted key set,
  //      the pass list, the identifier checks -- is the rule loader's, which is why
  //      catalogueAgainstEngine.test.ts (a sweep over the 27 registered feature builders)
  //      excludes it and featureRuleCatalogue.test.ts pins it against the rule loader instead.
  //   4. THERE ARE NO VERSION BANDS. One schema, registered once, with no per-key format_version
  //      gates and no legacy flat spellings -- so unlike scatter, whose identical `distribution`
  //      object moved out of five flat keys at 1.21.10, nothing below carries `since` or
  //      `until`. A rule file's format_version decides nothing about which keys it may write.
  //
  // `description` is deliberately absent, exactly as it is for every feature type: its
  // `identifier` is the node's own identity and belongs to the rename control, and its
  // `places_feature` is an EDGE on the canvas (wire/graphbuild.go cuts it out of Fields where it
  // sits). Modelling either here would give the editor two ways to set one thing.
  {
    typeId: 'minecraft:feature_rule',
    fields: [
      {
        key: 'conditions',
        kind: 'group',
        required: true,
        doc: 'Required. A rule with no `conditions` fails a required field and the game refuses the whole file, so the rule is never inserted and places nothing at all.',
        entry: [
          {
            key: 'placement_pass',
            kind: 'enum',
            required: true,
            values: PLACEMENT_PASS_VALUES,
            doc: 'Required, and a CLOSED list. A pass outside it still loads -- the engine logs the unknown name and keeps it verbatim, with no substitution -- and chunk decoration only visits the passes it knows, so such a rule attaches to its biomes and is then never reached: it places nothing, in every chunk, forever.',
            source: 'builder',
          },
          {
            key: 'minecraft:biome_filter',
            kind: 'json',
            required: false,
            // Primary: a rule that applies in every biome is the rare one.
            primary: true,
            default: 'no filter -- the rule applies in every biome that the pass reaches',
            unsourced:
              'The shape IS known -- `{}` matches everything, `{"test": "has_biome_tag", "value": "..."}` is the form almost every real rule uses, and `{"all_of": [...]}`, `{"any_of": [...]}` and `{"none_of": [...]}` combine child filters -- but it is RECURSIVE, and a field in this catalogue is a fixed set of sub-fields with no way to nest into itself. A raw-JSON box that accepts all four shapes is the honest control; a fixed one would refuse the nested spelling that real packs write.',
            source: 'builder',
          },
        ],
        source: 'builder',
      },
      {
        key: 'distribution',
        kind: 'group',
        required: false,
        // Primary, and so is its iteration count: a rule without them is live and inert, which
        // is the one outcome nobody creating a rule wants.
        primary: true,
        default:
          'the default-constructed parameters: iterations 0 and scatter_chance 100 -- the rule LOADS, attaches to its pass and its biomes, and then places nothing every chunk',
        doc: 'Optional to the schema and load-bearing in practice: leaving it out is the one way to get a rule that is live, correct and completely inert. The same parameter object a scatter uses, with one addition -- `iterations` is a plain field here, because a rule has no feature-placing edge to carry it.',
        entry: [
          {
            key: 'iterations',
            kind: 'molangOrNumber',
            required: false,
            primary: true,
            default: '0 -- which means the rule places nothing',
            doc: 'How many times the rule places its feature per chunk. A number or a Molang string. This is the key that decides whether a rule does anything at all: absent, or 0, and every other setting on the rule is moot. On a scatter the same parameter is drawn on the connection instead, because only there can it also carry the setup script real packs write into it.',
            source: 'builder',
          },
          coordinateField('x'),
          coordinateField('y'),
          coordinateField('z'),
          SCATTER_CHANCE_FIELD,
          COORDINATE_EVAL_ORDER_FIELD,
        ],
        source: 'builder',
      },
    ],
  },
]

const SPECS_BY_TYPE: ReadonlyMap<string, TypeSpec> = new Map(TYPE_SPECS.map((spec) => [spec.typeId, spec]))

/** The catalogued field set for a type, or undefined for a type this catalogue does not model.
 * Undefined is a real answer -- `minecraft:beards_and_shavers` and `minecraft:rect_layout` are
 * out of scope and have no builder to source from -- and the form renders it as "every key is
 * free-text JSON" rather than as an empty form. */
export function typeSpec(typeId: string): TypeSpec | undefined {
  return SPECS_BY_TYPE.get(typeId)
}

/** Every type id this catalogue models. */
export function catalogedTypeIds(): string[] {
  return TYPE_SPECS.map((spec) => spec.typeId)
}

// ---------------------------------------------------------------------------
// Version resolution -- the answer to "which keys does THIS file's version accept"
// ---------------------------------------------------------------------------

/** Why a field is or is not offered. The three states are deliberately distinct from each other
 * and from simple absence, because the form treats them differently: a key the file WROTE and
 * this version does not accept is drawn in place with its note, since the engine drops it and
 * the author is looking at a setting that does nothing; a key nobody wrote and this version does
 * not accept is not part of the form at all. See inspector.ts's splitRows, which is where that
 * decision is made and argued -- this file only says which state a key is in. */
export type FieldAvailability =
  | 'available'
  /** The key exists in the engine, but only at a HIGHER format_version than this file declares. */
  | 'too-new'
  /** The key existed at a LOWER format_version and is gone at this one -- the older half of a
   * rename, or scatter's flat parameter keys. */
  | 'superseded'

export interface ResolvedField extends FieldSpec {
  /** Sub-fields, resolved in turn -- the gate reaches inside a group
   * (`may_attach_to.diagonal` is registered only at 1.21.40 and above while its parent is not
   * gated at all), so a caller reading `entry` must get the tagged form, not the raw spec. */
  entry?: readonly ResolvedField[]
  availability: FieldAvailability
  /** A sentence for the form to show whenever availability is not 'available'. Says what the
   * engine does with the key at this version, which is never "nothing": it logs
   * "this member was found in the input, but is not present in the Schema" and drops it. */
  availabilityNote?: string
}

function resolveOne(spec: FieldSpec, declared: FormatVersion): ResolvedField {
  const versionText = declared.present ? declared.raw : '(absent)'
  // Resolve sub-fields first, and unconditionally: the gate reaches inside a group, and a
  // caller walking `entry` must find the tagged form there whatever the parent's own state is.
  const base = { ...spec, entry: spec.entry?.map((sub) => resolveOne(sub, declared)) }
  if (spec.since !== undefined && !atLeastOrUnversioned(declared, spec.since)) {
    return {
      ...base,
      availability: 'too-new',
      availabilityNote:
        `"${spec.key}" is registered only from format_version ${spec.since} onward, and this file declares ${versionText}. ` +
        `Writing it here has the engine log it by name as not present in the schema and drop the value` +
        (spec.renamedFrom !== undefined ? `; at this version the key is spelled "${spec.renamedFrom}"` : '') +
        '.',
    }
  }
  if (spec.until !== undefined && atLeastOrUnversioned(declared, spec.until)) {
    return {
      ...base,
      availability: 'superseded',
      availabilityNote:
        `"${spec.key}" is not registered at format_version ${versionText} -- it was dropped at ${spec.until}` +
        (spec.renamedTo !== undefined ? `, renamed to "${spec.renamedTo}"` : '') +
        '. The engine logs it by name as not present in the schema and drops the value.',
    }
  }
  return { ...base, availability: 'available' }
}

/** The type's fields, each tagged with whether this file's version accepts it. Nothing is
 * filtered out HERE: what a form does with an unaccepted key depends on whether the file wrote
 * it, which is not a question the catalogue can answer. It is answered in inspector.ts's
 * splitRows, against the real body, and every caller gets the whole tagged list.
 *
 * Nested `entry` fields are resolved too, because the gate reaches inside them --
 * `may_attach_to.diagonal` is registered only at 1.21.40 and above while its parent is not
 * gated at all. */
export function resolveFields(typeId: string, declared: FormatVersion): ResolvedField[] {
  const spec = typeSpec(typeId)
  if (spec === undefined) return []
  return spec.fields.map((field) => resolveOne(field, declared))
}

// ---------------------------------------------------------------------------
// The create palette
// ---------------------------------------------------------------------------

export type CoverageStatus = 'implemented' | 'partial' | 'missing' | 'out_of_scope'

/** One row of featurelab-go's own coverage table, as it arrives on the wire -- the same shape
 * `featurelab types --json` and the "types" JSON-RPC method produce, and the same two values
 * wire.GraphNode carries per node as Coverage/CoverageNote. Passed IN rather than fetched: this
 * module renders, it does not talk to the engine. */
export interface CoverageRow {
  typeId: string
  status: CoverageStatus | string
  note?: string
}

export interface PaletteEntry {
  typeId: string
  status: CoverageStatus
  /** The coverage note verbatim. Always shown for a partial type -- `approximations` is a
   * highlight of it, never a replacement, because a keyword scan cannot be trusted to have
   * caught every caveat in prose written by hand. */
  note: string
  /** The sentences of `note` that state a gap or an approximation. For a partial type this is
   * what the author is signing up for at the moment they pick the type, which is the only
   * moment it is cheap to pick a different one. */
  approximations: readonly string[]
  /** False when the file's declared format_version is below the version at which the engine
   * registers this type -- such a file names a type that, as far as its schema band is
   * concerned, does not exist. */
  availableAtVersion: boolean
  minFormatVersion: string
  /** Whether this catalogue has a field set for the type. False means the form falls back to
   * raw JSON, which is worth knowing before creating one. */
  modelled: boolean
}

/** Markers featurelab-go's coverage notes actually use to open a gap statement. Sourced by
 * reading the Notes of the five StatusPartial entries rather than invented: they are written to
 * a house style that shouts the caveat in caps ("WHY THIS IS STILL PARTIAL", "STILL
 * APPROXIMATE", "STATED GAP", "ONE REMAINING GAP", "WHAT IS STILL ASSUMED", "REFUSED rather
 * than repaired"). The lowercase entries catch the same statements written in ordinary prose. */
const GAP_MARKERS: readonly string[] = [
  'WHY THIS IS PARTIAL',
  'WHY THIS IS STILL PARTIAL',
  'STILL APPROXIMATE',
  'STATED GAP',
  'REMAINING GAP',
  'WHAT IS STILL ASSUMED',
  'REFUSED',
  'not supported by this tool',
  'refuses at build time',
  'approximate',
  'assumed',
  'has NOT been established',
  'no way to close',
]

/** Splits a coverage note into sentences and keeps the ones that state a gap.
 *
 * Deliberately a HIGHLIGHT and not a filter: the caller shows the whole note as well. A
 * keyword scan over hand-written prose will miss caveats, and a UI that showed only the
 * extracted sentences would quietly promise that everything it left out is fine. When nothing
 * matches, the whole note comes back, because a partial type with no recognised marker is the
 * case where reading all of it matters most. */
export function extractApproximations(note: string): string[] {
  if (note.trim().length === 0) return []
  // Split on sentence ends, keeping the terminator. The notes are prose with abbreviations and
  // embedded JSON, so this is approximate by nature -- which is fine for a highlight.
  const sentences = note
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const hits = sentences.filter((sentence) => GAP_MARKERS.some((marker) => sentence.includes(marker)))
  return hits.length > 0 ? hits : sentences
}

/** Builds the create-a-node palette from the engine's own coverage table.
 *
 * Two non-negotiable rules, implemented here rather than left to the UI:
 * a type marked `missing` or `out_of_scope` is NEVER offered -- it is dropped from the result
 * entirely, so there is no state in which a click can reach it -- and a `partial` one carries
 * its coverage note and the extracted approximations, because the author is authoring against
 * a port with known gaps and the moment they choose the type is when that is cheapest to know.
 *
 * `declared` additionally marks types the file's own format_version cannot name. Those stay in
 * the list, flagged: hiding them would leave an author wondering why
 * `minecraft:multi_block_feature` is missing, where saying "your file declares 1.21.10 and this
 * type is registered at 1.26.40" tells them exactly which one line to change. */
export function buildTypePalette(coverage: readonly CoverageRow[], declared: FormatVersion): PaletteEntry[] {
  const modelled = new Set(catalogedTypeIds())
  const out: PaletteEntry[] = []
  for (const row of coverage) {
    if (row.status === 'missing' || row.status === 'out_of_scope') continue
    const note = row.note ?? ''
    out.push({
      typeId: row.typeId,
      status: row.status as CoverageStatus,
      note,
      approximations: row.status === 'partial' ? extractApproximations(note) : [],
      availableAtVersion: typeAvailableAt(row.typeId, declared),
      minFormatVersion: minFormatVersionForType(row.typeId),
      modelled: modelled.has(row.typeId),
    })
  }
  return out
}
