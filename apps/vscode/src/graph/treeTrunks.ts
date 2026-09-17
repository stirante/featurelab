// treeTrunks.ts -- the inner key sets of `minecraft:tree_feature`'s eight trunk variants, as
// FieldSpec data the node property form can render, plus a DocEntry for every key added.
//
// WHY THIS FILE EXISTS. typeCatalog.ts models the tree feature's trunk choice correctly -- one of
// several mutually exclusive `<shape>_trunk` keys -- and then gives up at the variant body, handing
// the author a raw-JSON box because the variants' own key sets had never been written down. That
// was the right call while the keys were unknown; it is the wrong one now that they are. The eight
// bodies are described here instead, so that choosing a trunk shape produces a form.
//
// EIGHT, NOT NINE. The engine registers eight independent sibling trunk keys: `trunk`,
// `acacia_trunk`, `cherry_trunk`, `fallen_trunk`, `fancy_trunk`, `mangrove_trunk`, `mega_trunk`
// and `poplar_trunk`. The key NAME alone picks the shape -- there is no structural matching over
// the value, so nothing inside a variant body can select a different variant.
//
// THE BARE `trunk` KEY IS THE SIMPLE TRUNK. It is not a default that turns into some other shape
// once you write the right sub-keys, and `can_be_submerged` is not a selector -- it is an option ON
// the simple trunk that sets one number, the maximum depth the column may descend to. This is the
// single fact about tree feature most likely to be got wrong, it was got wrong once here already,
// and TREE_TRUNK_VARIANTS/the test file pin it deliberately.
//
// THE VARIANTS DO NOT SHARE A SUB-SCHEMA. `trunk_height` is a RANGE on the plain trunk and on the
// poplar trunk, an object of `{base, intervals}` on the acacia, mega and cherry trunks, an object
// of `{base, variance, scale}` on the fancy trunk, and an object of
// `{base, height_rand_a, height_rand_b}` on the mangrove trunk. `branches` is four different
// objects under one name. Nothing below is shared between variants except where it is written as a
// shared helper, and each of those is a shape the engine genuinely reuses (the attachable
// decoration, and the fraction form of a chance value).
//
// RANGES READ range_min / range_max, NOT min / max. Every field below whose kind is 'range' is one
// of the engine's range objects, and an object spelling of one is asked only for `range_min` and
// `range_max`. Given `{min, max}` instead the engine does not refuse the file: it reports the two
// members as missing and carries on with a zero-width range of {0, 0}, so the file loads in game
// and the field does nothing. The one place below that genuinely DOES take `min` and `max` is
// `mega_trunk.branches.branch_altitude_factor`, which is a plain two-member object rather than a
// range -- which is exactly why it is worth naming.
//
// WHAT `min` AND `max` MEAN HERE. They are the bounds below or above which this tool refuses to
// load the file, so a form that enforces them produces a file that loads. Where a bound is a
// consequence of the shape rather than a stated schema limit, the field's documentation says what
// goes wrong rather than leaning on the number alone.
//
// DELEGATIONS ARE NOT FIELDS. `log_decoration_feature` -- on `fallen_trunk` and `poplar_trunk` --
// names another feature to place, so it is an edge in the graph and not a control in this form.
// Its two paths are exported as TREE_TRUNK_DELEGATION_PATHS so a consumer can assert it stayed out
// rather than discovering it drawn as a text box.
//
// BRANCH CANOPIES ARE LEFT AS JSON ON PURPOSE. Three variants nest a whole canopy inside their
// `branches` object. A canopy is its own twelve-variant vocabulary and describing it is not this
// module's job, so `branch_canopy` keeps kind 'json' with a reason attached, and its paths are
// exported as TREE_TRUNK_BRANCH_CANOPY_PATHS so that whoever describes the canopy variants can
// graft them in at exactly those three points.

import type { FieldSpec } from './typeCatalog'
import type { DocEntry } from './docs/catalog'

// ---------------------------------------------------------------------------
// The variant vocabulary
// ---------------------------------------------------------------------------

/** The eight trunk keys, in the engine's own order. Exactly one may appear in a tree
 * feature's body; the type does not load with none of them and reports an error with two. */
export const TREE_TRUNK_VARIANTS = [
  'acacia_trunk',
  'cherry_trunk',
  'fallen_trunk',
  'fancy_trunk',
  'mangrove_trunk',
  'mega_trunk',
  'trunk',
  'poplar_trunk',
] as const

export type TreeTrunkVariant = (typeof TREE_TRUNK_VARIANTS)[number]

/** The bare key, called out because it is the one every reader assumes is a fallback. It is the
 * SIMPLE trunk shape -- a straight vertical column -- and nothing written inside it changes that. */
export const SIMPLE_TRUNK_KEY: TreeTrunkVariant = 'trunk'

/** Paths where a trunk nests a whole canopy body inside its own `branches` object. Left as raw
 * JSON here; a consumer that models the canopy variants can replace the spec at these paths. */
export const TREE_TRUNK_BRANCH_CANOPY_PATHS: readonly string[] = [
  'acacia_trunk.branches.branch_canopy',
  'cherry_trunk.branches.branch_canopy',
  'mega_trunk.branches.branch_canopy',
]

/** Keys inside a trunk body that place another feature. These are edges, so they are deliberately
 * absent from TREE_TRUNK_FIELDS. */
export const TREE_TRUNK_DELEGATION_PATHS: readonly string[] = [
  'fallen_trunk.log_decoration_feature',
  'poplar_trunk.log_decoration_feature',
]

// ---------------------------------------------------------------------------
// Shared shapes -- written once because the engine genuinely reuses them
// ---------------------------------------------------------------------------

/** The object spelling of a chance value: `{numerator, denominator}`. The scalar spelling is a
 * plain percent, which the 'chance' control offers alongside these two. */
const CHANCE_FRACTION: readonly FieldSpec[] = [
  { key: 'numerator', kind: 'integer', required: true, source: 'builder' },
  { key: 'denominator', kind: 'integer', required: true, source: 'builder' },
]

/** One element of `decoration_blocks_sequence`. */
const DECORATION_SEQUENCE_ENTRY: readonly FieldSpec[] = [
  { key: 'block', kind: 'block', required: true, source: 'builder' },
  {
    key: 'count',
    kind: 'range',
    required: false,
    default: '{1, 1} -- a single block, placed at the cell next to the log',
    source: 'builder',
  },
]

/** `trunk_decoration`, the attachable decoration. Six of the eight variants register it and all six
 * take the identical shape, so it is built once. Sub-fields are in the schema's own
 * order. */
function trunkDecorationField(): FieldSpec {
  return {
    key: 'trunk_decoration',
    kind: 'group',
    required: false,
    default: 'no decoration -- logs are placed bare',
    entry: [
      {
        key: 'decoration_chance',
        kind: 'chance',
        required: false,
        default: '0, which decorates nothing at all',
        entry: CHANCE_FRACTION,
        source: 'builder',
      },
      {
        key: 'decoration_blocks_sequence',
        kind: 'groupList',
        required: false,
        entry: DECORATION_SEQUENCE_ENTRY,
        source: 'builder',
      },
      { key: 'decoration_block', kind: 'block', required: false, source: 'builder' },
      { key: 'num_steps', kind: 'integer', required: false, source: 'builder' },
      {
        key: 'step_direction',
        kind: 'enum',
        required: false,
        values: ['down', 'up', 'out', 'away'],
        default: 'down',
        source: 'builder',
      },
    ],
    source: 'builder',
  }
}

/** A nested canopy body inside a trunk's `branches`. */
function branchCanopyField(): FieldSpec {
  return {
    key: 'branch_canopy',
    kind: 'json',
    required: false,
    default: 'no canopy is grown at the branch tips',
    unsourced:
      'A whole canopy body: exactly one canopy variant key, from the same set the tree\'s own canopy ' +
      'offers, and every one of those variants is described elsewhere in this panel. What is missing ' +
      'here is the control, not the knowledge -- a choice of one nested inside another field is not ' +
      'something this editor can draw yet, so it is edited as JSON. Writing two canopy keys here, or ' +
      'none, is reported rather than ignored.',
    source: 'builder',
  }
}

/** `intervals`: a list of bare whole numbers, each one an extra random step added to `base`. */
function intervalsField(): FieldSpec {
  return {
    key: 'intervals',
    kind: 'groupList',
    required: false,
    default: 'no intervals -- the height is exactly `base`, with no draw at all',
    entry: [{ key: '', kind: 'integer', required: true, min: 1, source: 'builder' }],
    source: 'builder',
  }
}

const TRUNK_BLOCK_FIELD: FieldSpec = { key: 'trunk_block', kind: 'block', required: true, source: 'builder' }

// ---------------------------------------------------------------------------
// The eight variant bodies
// ---------------------------------------------------------------------------

/** The plain `trunk` key: the SIMPLE trunk. Five keys, and no `trunk_width`, no `trunk_lean` and no
 * `branches` -- a body carrying those is not a differently-configured simple trunk, it is a body
 * the engine reads against this five-key schema and drops the extras from. */
const SIMPLE_TRUNK_BODY: readonly FieldSpec[] = [
  { key: 'trunk_height', kind: 'range', required: true, source: 'builder' },
  {
    key: 'height_modifier',
    kind: 'range',
    required: false,
    default: '{0, 0} -- adds nothing, and costs no draw',
    source: 'builder',
  },
  {
    key: 'can_be_submerged',
    kind: 'group',
    required: false,
    default: 'no descent: the column starts at the origin',
    doc: 'Also accepts a bare `true`, which means a maximum depth of 255, and a bare `false`, which means the same as leaving the key out.',
    entry: [{ key: 'max_depth', kind: 'integer', required: true, source: 'builder' }],
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
  trunkDecorationField(),
]

const ACACIA_TRUNK_BODY: readonly FieldSpec[] = [
  {
    key: 'trunk_height',
    kind: 'group',
    required: true,
    entry: [
      { key: 'base', kind: 'integer', required: true, source: 'builder' },
      intervalsField(),
      {
        key: 'min_height_for_canopy',
        kind: 'integer',
        required: false,
        default: '3',
        source: 'builder',
      },
    ],
    source: 'builder',
  },
  { key: 'trunk_width', kind: 'integer', required: true, min: 1, source: 'builder' },
  {
    key: 'trunk_lean',
    kind: 'group',
    required: true,
    entry: [
      { key: 'allow_diagonal_growth', kind: 'boolean', required: true, source: 'builder' },
      { key: 'lean_height', kind: 'range', required: true, source: 'builder' },
      { key: 'lean_steps', kind: 'range', required: true, source: 'builder' },
      {
        key: 'lean_length',
        kind: 'range',
        required: false,
        default: '{0, 0} -- no sideways run past the top of the trunk',
        source: 'builder',
      },
    ],
    source: 'builder',
  },
  {
    key: 'branches',
    kind: 'group',
    required: false,
    default: 'no branch is grown -- but see the note: the branch pass still runs',
    entry: [
      { key: 'branch_length', kind: 'range', required: true, source: 'builder' },
      { key: 'branch_position', kind: 'range', required: true, source: 'builder' },
      { key: 'branch_chance', kind: 'chance', required: true, entry: CHANCE_FRACTION, source: 'builder' },
      branchCanopyField(),
    ],
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
  trunkDecorationField(),
]

const CHERRY_TRUNK_BODY: readonly FieldSpec[] = [
  {
    key: 'trunk_height',
    kind: 'group',
    required: true,
    entry: [
      { key: 'base', kind: 'integer', required: true, min: 2, source: 'builder' },
      intervalsField(),
    ],
    source: 'builder',
  },
  {
    key: 'branches',
    kind: 'group',
    required: true,
    entry: [
      {
        key: 'tree_type_weights',
        kind: 'group',
        required: false,
        default: 'all three weights 0, which always grows the single-branch shape',
        entry: [
          { key: 'one_branch', kind: 'integer', required: true, min: 0, source: 'builder' },
          { key: 'two_branches', kind: 'integer', required: true, min: 0, source: 'builder' },
          { key: 'two_branches_and_trunk', kind: 'integer', required: true, min: 0, source: 'builder' },
        ],
        source: 'builder',
      },
      { key: 'branch_horizontal_length', kind: 'range', required: true, min: 2, source: 'builder' },
      { key: 'branch_start_offset_from_top', kind: 'range', required: true, max: 0, source: 'builder' },
      { key: 'branch_end_offset_from_top', kind: 'range', required: true, source: 'builder' },
      branchCanopyField(),
    ],
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
]

const FALLEN_TRUNK_BODY: readonly FieldSpec[] = [
  { key: 'log_length', kind: 'range', required: true, source: 'builder' },
  {
    key: 'height_modifier',
    kind: 'range',
    required: false,
    default: '{0, 0} -- the log is log_length minus 2 blocks long',
    source: 'builder',
  },
  {
    key: 'stump_height',
    kind: 'range',
    required: false,
    default: '{1, 1} -- a single stump block',
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
  trunkDecorationField(),
]

const FANCY_TRUNK_BODY: readonly FieldSpec[] = [
  {
    key: 'trunk_height',
    kind: 'group',
    required: true,
    entry: [
      { key: 'base', kind: 'integer', required: true, source: 'builder' },
      { key: 'variance', kind: 'integer', required: true, min: 1, source: 'builder' },
      { key: 'scale', kind: 'number', required: true, source: 'builder' },
    ],
    source: 'builder',
  },
  { key: 'trunk_width', kind: 'integer', required: true, min: 1, source: 'builder' },
  { key: 'width_scale', kind: 'number', required: true, source: 'builder' },
  { key: 'foliage_altitude_factor', kind: 'number', required: true, source: 'builder' },
  {
    key: 'branches',
    kind: 'group',
    required: true,
    entry: [
      { key: 'slope', kind: 'number', required: true, source: 'builder' },
      { key: 'density', kind: 'number', required: true, source: 'builder' },
      { key: 'min_altitude_factor', kind: 'number', required: true, source: 'builder' },
    ],
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
]

const MANGROVE_TRUNK_BODY: readonly FieldSpec[] = [
  { key: 'trunk_width', kind: 'integer', required: false, source: 'builder' },
  {
    key: 'trunk_height',
    kind: 'group',
    required: true,
    entry: [
      { key: 'base', kind: 'integer', required: true, source: 'builder' },
      { key: 'height_rand_a', kind: 'integer', required: true, min: 0, source: 'builder' },
      { key: 'height_rand_b', kind: 'integer', required: true, min: 0, source: 'builder' },
    ],
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
  {
    key: 'branches',
    kind: 'group',
    required: false,
    default: 'branch_length and branch_steps both {0, 0} -- see the note, the branch pass still runs',
    entry: [
      { key: 'branch_length', kind: 'range', required: false, default: '{0, 0}', source: 'builder' },
      { key: 'branch_steps', kind: 'range', required: false, default: '{0, 0}', source: 'builder' },
      { key: 'branch_chance', kind: 'chance', required: false, entry: CHANCE_FRACTION, source: 'builder' },
    ],
    source: 'builder',
  },
  trunkDecorationField(),
]

const MEGA_TRUNK_BODY: readonly FieldSpec[] = [
  {
    key: 'trunk_height',
    kind: 'group',
    required: true,
    entry: [
      { key: 'base', kind: 'integer', required: true, source: 'builder' },
      intervalsField(),
    ],
    source: 'builder',
  },
  { key: 'trunk_width', kind: 'integer', required: true, min: 1, source: 'builder' },
  TRUNK_BLOCK_FIELD,
  {
    key: 'branches',
    kind: 'group',
    required: false,
    default: 'no branches at all -- the trunk is a bare column',
    entry: [
      { key: 'branch_length', kind: 'integer', required: true, source: 'builder' },
      { key: 'branch_slope', kind: 'number', required: true, source: 'builder' },
      { key: 'branch_interval', kind: 'range', required: true, source: 'builder' },
      {
        key: 'branch_altitude_factor',
        kind: 'group',
        required: true,
        doc: 'A plain two-member object, NOT a range: this one really is spelled `min` and `max`.',
        entry: [
          { key: 'min', kind: 'number', required: true, source: 'builder' },
          { key: 'max', kind: 'number', required: true, source: 'builder' },
        ],
        source: 'builder',
      },
      branchCanopyField(),
    ],
    source: 'builder',
  },
  trunkDecorationField(),
]

const POPLAR_TRUNK_BODY: readonly FieldSpec[] = [
  { key: 'trunk_height', kind: 'range', required: true, source: 'builder' },
  {
    key: 'remaining_trunk_height_above_branches',
    kind: 'range',
    required: false,
    default: '{4, 4} -- four blocks of bare trunk above the branch ring, with no draw',
    source: 'builder',
  },
  {
    key: 'amount_of_foliage_support_branches',
    kind: 'range',
    required: false,
    default: '{1, 4} -- one to four branches',
    source: 'builder',
  },
  TRUNK_BLOCK_FIELD,
  trunkDecorationField(),
]

const VARIANT_BODIES: Readonly<Record<TreeTrunkVariant, readonly FieldSpec[]>> = {
  acacia_trunk: ACACIA_TRUNK_BODY,
  cherry_trunk: CHERRY_TRUNK_BODY,
  fallen_trunk: FALLEN_TRUNK_BODY,
  fancy_trunk: FANCY_TRUNK_BODY,
  mangrove_trunk: MANGROVE_TRUNK_BODY,
  mega_trunk: MEGA_TRUNK_BODY,
  trunk: SIMPLE_TRUNK_BODY,
  poplar_trunk: POPLAR_TRUNK_BODY,
}

/** The variant key itself, as the exclusive-group member typeCatalog registers, carrying its body
 * as `entry` instead of the raw-JSON box it used to carry. */
function variantField(key: TreeTrunkVariant): FieldSpec {
  const spec: FieldSpec = {
    key,
    kind: 'group',
    required: false,
    exclusiveGroup: 'trunk',
    entry: VARIANT_BODIES[key],
    source: 'builder',
  }
  if (key === 'poplar_trunk') {
    return { ...spec, introducedInBuild: '1.26.50.24' }
  }
  return spec
}

/** The eight trunk variant keys with their bodies. Drop-in replacement for the raw-JSON trunk
 * entries in the tree feature's TypeSpec; the exclusive group name is unchanged. */
export const TREE_TRUNK_FIELDS: readonly FieldSpec[] = TREE_TRUNK_VARIANTS.map(variantField)

/** One variant's body, for a consumer that wants a single shape rather than all eight. */
export function trunkVariantFields(key: string): readonly FieldSpec[] | undefined {
  return (VARIANT_BODIES as Readonly<Record<string, readonly FieldSpec[] | undefined>>)[key]
}

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------
//
// Keyed by the dotted path under `minecraft:tree_feature`, the shape TYPE_FIELD_DOCS uses. Every
// field above has an entry here and nothing here names a path that is not a field -- the test file
// asserts both directions, because either half drifting is a broken hover.
//
// LANGUAGE. Every string below is rendered into a hover card a pack author reads. It says what the
// engine DOES and never how that is known.

/** `trunk_decoration`'s six entries, for one variant, with the one sentence that differs per
 * variant folded into the parent entry. */
function decorationDocs(variant: string, attachesTo: string): Record<string, DocEntry> {
  const p = `${variant}.trunk_decoration`
  return {
    [p]: {
      summary: 'Blocks hung off the sides of the logs, such as vines.',
      detail:
        `On this shape it is offered ${attachesTo}. Each enabled side rolls decoration_chance ` +
        `independently, and only a side that wins its roll and finds a free cell gets anything. ` +
        `Up and down are never offered, on any trunk shape.`,
    },
    [`${p}.decoration_chance`]: {
      summary: 'How often one side of one log gets decorated.',
      detail:
        'Either a percent -- 100 always, 0 never -- or a {numerator, denominator} fraction. Mind ' +
        'the default: a trunk_decoration written without this key rolls 0 and therefore places ' +
        'nothing, so the decoration looks silently ignored rather than sparse.',
    },
    [`${p}.decoration_chance.numerator`]: {
      summary: 'The top half of a fractional decoration chance.',
      detail:
        'Used only when decoration_chance is written as an object. A numerator equal to the ' +
        'denominator always succeeds; anything else is compared against a draw below the ' +
        'denominator.',
    },
    [`${p}.decoration_chance.denominator`]: {
      summary: 'The bottom half of a fractional decoration chance.',
      detail:
        'A denominator of 0 never succeeds, and costs no draw. Otherwise the chance is numerator ' +
        'in denominator, drawn fresh for each side of each log.',
    },
    [`${p}.decoration_blocks_sequence`]: {
      summary: 'A stack of decoration blocks placed outward from the log, in order.',
      detail:
        'The entries share one running position: the first entry\'s run starts at the cell next ' +
        'to the log and each later entry continues from where the previous one stopped, rather ' +
        'than restarting. That is what lets a sequence spell "two of block A, then block B". ' +
        'Write this OR decoration_block, not both -- a sequence wins and the single block is ignored.',
    },
    [`${p}.decoration_blocks_sequence.block`]: {
      summary: 'The block this run of the sequence places.',
      detail:
        'Accepted as a bare name string, as `{name, states}`, or as `{tags: "<Molang query>"}`. It ' +
        'is turned to face the log before it is written, so a vine-like block attaches the right way.',
    },
    [`${p}.decoration_blocks_sequence.count`]: {
      summary: 'How many blocks this entry of the sequence places.',
      detail:
        'A range, so it can differ per log. The run stops early at the first cell that is not ' +
        'free, and the next entry carries on from wherever it stopped.',
    },
    [`${p}.decoration_block`]: {
      summary: 'One block hung on the log, the short form.',
      detail:
        'Exactly the same as a decoration_blocks_sequence of one entry with a count of 1, and this ' +
        'is the spelling most trees use. Ignored when decoration_blocks_sequence is also present.',
    },
    [`${p}.num_steps`]: {
      summary: 'Accepted here, but it changes nothing on a trunk decoration.',
      detail:
        'The number of blocks placed comes from each sequence entry\'s own count, and nothing ' +
        'reads this key while placing them. It is accepted rather than refused so that a pack ' +
        'that already writes it still loads.',
    },
    [`${p}.step_direction`]: {
      summary: 'Which way a run of decoration blocks stacks from the log.',
      detail:
        'Only visible on a run longer than one block: the first block of every entry lands in the ' +
        'same cell whatever this says. Mind the default -- it is `down`, not outward.',
    },
  }
}

/** The four `step_direction` values, identical wherever the key appears. */
const STEP_DIRECTION_VALUE_DOCS: Readonly<Record<string, DocEntry>> = {
  down: {
    summary: 'Each run hangs downward from the log.',
    detail: 'The default, and what a vine-like decoration wants: the run grows toward the ground one cell at a time.',
  },
  up: {
    summary: 'Each run climbs upward from the log.',
    detail: 'The run grows toward the sky one cell at a time, alongside the trunk rather than away from it.',
  },
  out: {
    summary: 'Each run grows away from the log, horizontally.',
    detail: 'It follows the same direction that chose the cell -- so a run on the north side keeps going north.',
  },
  away: {
    summary: 'The same as `out`, spelled differently.',
    detail: 'Both spellings are accepted and behave identically; there is no reason to prefer one over the other.',
  },
}

const BRANCH_CANOPY_DOC: DocEntry = {
  summary: 'A canopy grown at the tip of each branch this trunk makes.',
  detail:
    'Separate from the tree\'s own canopy key and shaped independently of it -- the branch tips ' +
    'always ask for a canopy one block wide, whatever trunk_width says. Write exactly one canopy ' +
    'variant key inside it; none and two are both reported.',
}

const INTERVALS_DOC: DocEntry = {
  summary: 'Extra random height added on top of `base`, one draw per entry.',
  detail:
    'Each entry adds a draw between 0 and that entry\'s own value, so `[3, 3]` adds nought to four ' +
    'and `[5]` adds nought to four in one lumpier step. Leaving the list out makes the height ' +
    'exactly `base` every time, with no variation at all.',
}

const TRUNK_BLOCK_DOC: DocEntry = {
  summary: 'The log the trunk column is built out of.',
  detail:
    'Required on every trunk shape. Several shapes place sideways logs too -- branches, and a ' +
    'fallen log -- and those are this same block turned to lie along the direction they run in, ' +
    'so there is no second key for them.',
}

/** Documentation for every field TREE_TRUNK_FIELDS adds, keyed by dotted path. Slots straight into
 * TYPE_FIELD_DOCS['minecraft:tree_feature']. The eight variant keys themselves are included and
 * are meant to REPLACE the existing entries for them, which say the sub-keys are not catalogued. */
export const TREE_TRUNK_DOCS: Readonly<Record<string, DocEntry>> = {
  // ---- the plain trunk ----
  trunk: {
    summary: 'The plain trunk: one straight column of logs, and nothing else.',
    detail:
      'The bare key is the SIMPLE shape, not a default that becomes something else once you fill ' +
      'it in. It takes five keys -- trunk_height and trunk_block are required, height_modifier, ' +
      'can_be_submerged and trunk_decoration are optional -- and has no trunk_width, no ' +
      'trunk_lean and no branches. It also hands its canopy an empty list of trunk positions, so ' +
      'pairing it with a canopy that scatters leaves over those positions grows a bare pole.',
  },
  'trunk.trunk_height': {
    summary: 'How many logs tall the column is, drawn once per tree.',
    detail:
      'A range, so write a number for a fixed height or `{range_min, range_max}` for a varying ' +
      'one. A range object spelled `{min, max}` is not read: the engine reports the two members ' +
      'as missing and uses a height of 0, which loads and grows nothing.',
  },
  'trunk.height_modifier': {
    summary: 'A second draw added to the trunk height.',
    detail:
      'Drawn separately from trunk_height and added to it, so the two ranges compose. Leaving it ' +
      'out adds nothing and costs no draw at all, which keeps everything placed after this tree ' +
      'in the same spot.',
  },
  'trunk.can_be_submerged': {
    summary: 'Lets the trunk start below the surface instead of at the origin.',
    detail:
      'Before building, the column walks downward through blocks listed in may_grow_through and ' +
      'starts from where it stops. This is an option ON the plain trunk and never a choice of ' +
      'trunk shape -- the bare key is the plain trunk with or without it.',
  },
  'trunk.can_be_submerged.max_depth': {
    summary: 'The furthest down the trunk may start, in blocks.',
    detail:
      'Required inside the object form. Writing the whole key as `true` instead means a maximum ' +
      'depth of 255, and writing `false`, or leaving it out, means no descent at all.',
  },
  'trunk.trunk_block': TRUNK_BLOCK_DOC,
  ...decorationDocs('trunk', 'on all four sides of every log the column places'),

  // ---- acacia ----
  acacia_trunk: {
    summary: 'A column that leans off to one side near the top, then branches.',
    detail:
      'A different key set from the plain trunk: trunk_width, an object-shaped trunk_height and ' +
      'trunk_lean are all required, and there is no can_be_submerged. The lean begins a drawn ' +
      'number of blocks BELOW the top of the trunk, not above the ground.',
  },
  'acacia_trunk.trunk_height': {
    summary: 'The height of the column, as a base plus optional random steps.',
    detail:
      'An object, not a range: `base` is the fixed part and `intervals` adds the variation. ' +
      'Writing a plain number here is refused, which is the quickest way to tell this shape apart ' +
      'from the plain trunk.',
  },
  'acacia_trunk.trunk_height.base': {
    summary: 'The fixed part of the trunk height, in blocks.',
    detail: 'Everything `intervals` draws is added on top of this, so it is the shortest the tree can be.',
  },
  'acacia_trunk.trunk_height.intervals': INTERVALS_DOC,
  'acacia_trunk.trunk_height.min_height_for_canopy': {
    summary: 'How far up the trunk must reach before a canopy may sit on it.',
    detail:
      'It gates where the canopy may ANCHOR, never where logs are placed: a trunk that never gets ' +
      'this high still builds its column, but hands the canopy nowhere to grow and comes out bare. ' +
      'It lives inside trunk_height rather than trunk_lean, which is easy to get wrong.',
  },
  'acacia_trunk.trunk_width': {
    summary: 'How many blocks across the trunk column is.',
    detail:
      'The column is a square of this many logs on each side, so 2 is a four-log column. It also ' +
      'decides which logs count as being on an edge, and only edge logs can carry a decoration.',
  },
  'acacia_trunk.trunk_lean': {
    summary: 'The sideways step the top of the trunk takes.',
    detail:
      'Required. A single horizontal direction is picked at random, and from lean_height blocks ' +
      'below the top the column starts stepping that way once per block for lean_steps blocks.',
  },
  'acacia_trunk.trunk_lean.allow_diagonal_growth': {
    summary: 'Picks which of two completely different branch routines runs.',
    detail:
      'Required, and getting it wrong does not shift the shape slightly, it swaps it: true grows ' +
      'at most ONE branch off a random side, false sweeps the trunk perimeter and can grow one ' +
      'per cell. The two even draw branch_length and branch_position in opposite orders, and only ' +
      'the true path decorates its branch logs.',
  },
  'acacia_trunk.trunk_lean.lean_height': {
    summary: 'How far below the top of the trunk the lean starts.',
    detail:
      'Counted DOWN from the top, not up from the ground: a draw of 1 leans over the last block, ' +
      'and a draw as large as the height leans from the very bottom.',
  },
  'acacia_trunk.trunk_lean.lean_steps': {
    summary: 'How many blocks the trunk steps sideways once it starts leaning.',
    detail:
      'One step per block of height, all in the same direction, so this is also how far the top ' +
      'of the tree ends up from its base.',
  },
  'acacia_trunk.trunk_lean.lean_length': {
    summary: 'Extra logs laid sideways at the very top of the lean.',
    detail:
      'It extends the column past trunk_height while the height stops rising, so it grows a ' +
      'horizontal run at the top rather than a taller tree. Left out it adds nothing and costs no ' +
      'draw.',
  },
  'acacia_trunk.branches': {
    summary: 'The branch grown off the side of the trunk.',
    detail:
      'Optional, but leaving it out is not the same as switching branches off: the branch pass ' +
      'runs on every acacia trunk and still spends its direction draw, it simply rolls a chance ' +
      'of 0 and places nothing. All three of branch_length, branch_position and branch_chance are ' +
      'required once the object is present.',
  },
  'acacia_trunk.branches.branch_length': {
    summary: 'How far the branch reaches out from the trunk.',
    detail:
      'Counted in steps, not in logs placed: a step into a blocked cell still moves the branch ' +
      'along and still uses up one of its length, it just leaves no log there.',
  },
  'acacia_trunk.branches.branch_position': {
    summary: 'How far below the start of the lean the branch leaves the trunk.',
    detail:
      'Subtracted from where the lean begins. A value that puts the branch above the top of the ' +
      'trunk grows no branch at all, and the draws are still spent.',
  },
  'acacia_trunk.branches.branch_chance': {
    summary: 'How often a branch is grown at all.',
    detail:
      'Required inside `branches`. Either a percent or a {numerator, denominator} fraction. The ' +
      'random direction is drawn BEFORE this is rolled, and a branch pointing the same way the ' +
      'trunk leans is dropped, so even 100 does not mean every tree gets one.',
  },
  'acacia_trunk.branches.branch_chance.numerator': {
    summary: 'The top half of a fractional branch chance.',
    detail: 'Used only when branch_chance is written as an object rather than as a percent.',
  },
  'acacia_trunk.branches.branch_chance.denominator': {
    summary: 'The bottom half of a fractional branch chance.',
    detail: 'A denominator of 0 never grows a branch, and costs no draw.',
  },
  'acacia_trunk.branches.branch_canopy': BRANCH_CANOPY_DOC,
  'acacia_trunk.trunk_block': TRUNK_BLOCK_DOC,
  ...decorationDocs(
    'acacia_trunk',
    'on the outward sides of every edge log of the column, and on all four sides of each branch log',
  ),

  // ---- cherry ----
  cherry_trunk: {
    summary: 'A trunk that forks into one, two, or two branches plus a stem.',
    detail:
      'The shape is drawn from tree_type_weights, and each resulting tip grows its own canopy. ' +
      'This is the one trunk with no canopy key of its own at tree level -- write the canopy ' +
      'inside branches.branch_canopy instead.',
  },
  'cherry_trunk.trunk_height': {
    summary: 'The height of the stem, as a base plus optional random steps.',
    detail:
      'An object of `base` and `intervals`, like the acacia and mega trunks, not a range. The base ' +
      'must be at least 2, because a fork needs a stem under it to leave from.',
  },
  'cherry_trunk.trunk_height.base': {
    summary: 'The fixed part of the stem height, at least 2 blocks.',
    detail: 'Anything `intervals` draws is added on top. Below 2 there is no stem for the branches to fork from.',
  },
  'cherry_trunk.trunk_height.intervals': INTERVALS_DOC,
  'cherry_trunk.branches': {
    summary: 'The fork: how many branches, how long, and where they leave the stem.',
    detail:
      'Required -- unlike the acacia and mega trunks, a cherry trunk without this object does not ' +
      'load. branch_horizontal_length, branch_start_offset_from_top and ' +
      'branch_end_offset_from_top are each required inside it.',
  },
  'cherry_trunk.branches.tree_type_weights': {
    summary: 'The weighted choice between the three fork shapes.',
    detail:
      'All three weights are required once the object is written, and they are relative rather ' +
      'than percentages. Leaving the whole object out leaves every weight at 0, which always ' +
      'produces the single-branch shape.',
  },
  'cherry_trunk.branches.tree_type_weights.one_branch': {
    summary: 'Weight of the shape with a single branch off the stem.',
    detail: 'One tip, so one canopy. The stem stops where the branch leaves it.',
  },
  'cherry_trunk.branches.tree_type_weights.two_branches': {
    summary: 'Weight of the shape with two branches on opposite sides.',
    detail: 'Two tips and two canopies. The second branch always leaves in the direction opposite the first.',
  },
  'cherry_trunk.branches.tree_type_weights.two_branches_and_trunk': {
    summary: 'Weight of the shape with two branches and a stem that keeps going.',
    detail: 'Three canopies: one at each branch tip and one on top of the stem, which runs the full height.',
  },
  'cherry_trunk.branches.branch_horizontal_length': {
    summary: 'How far out from the stem each branch reaches.',
    detail:
      'Both ends of the range must be at least 2 -- a branch shorter than that has nowhere to put ' +
      'its bend, and the file is refused rather than silently straightened.',
  },
  'cherry_trunk.branches.branch_start_offset_from_top': {
    summary: 'How far below the top of the stem a branch leaves it.',
    detail:
      'Counted downward, so both ends of the range must be 0 or negative; -4 leaves the stem four ' +
      'blocks below its top. The two branches draw this separately and can start at different heights.',
  },
  'cherry_trunk.branches.branch_end_offset_from_top': {
    summary: 'How high the branch tip finishes, relative to the top of the stem.',
    detail:
      'Together with the start offset this is what makes a branch rise or fall along its length, ' +
      'and it is where the canopy for that branch is anchored.',
  },
  'cherry_trunk.branches.branch_canopy': BRANCH_CANOPY_DOC,
  'cherry_trunk.trunk_block': TRUNK_BLOCK_DOC,

  // ---- fallen ----
  fallen_trunk: {
    summary: 'A log lying on the ground, with a short stump beside it.',
    detail:
      'It is the one trunk shape that needs no canopy at all. The log drops to the ground first, ' +
      'then the whole run is checked before anything is written: if any cell is blocked, or three ' +
      'cells in a row have nothing under them, no log is placed -- though the stump is still built.',
  },
  'fallen_trunk.log_length': {
    summary: 'How long the fallen log is before modifiers.',
    detail:
      'The log actually written is log_length plus height_modifier minus 2 blocks long, so a ' +
      'log_length of 5 lays 3 blocks unless height_modifier adds more.',
  },
  'fallen_trunk.height_modifier': {
    summary: 'A second draw added to the fallen log\'s length.',
    detail: 'Drawn separately and added to log_length. Left out it adds nothing and costs no draw.',
  },
  'fallen_trunk.stump_height': {
    summary: 'How many blocks of upright stump stand next to the log.',
    detail:
      'Mind the default: it is a single block, not none. The stump is also what decides success -- ' +
      'a fallen tree whose stump placed nothing counts as failed even when the log itself went down.',
  },
  'fallen_trunk.trunk_block': TRUNK_BLOCK_DOC,
  ...decorationDocs('fallen_trunk', 'on all four sides of each block of the upright stump, and not on the fallen log'),

  // ---- fancy ----
  fancy_trunk: {
    summary: 'The big branching oak: scattered foliage clusters with limbs drawn out to them.',
    detail:
      'Not a leaning trunk with a crown on top. It picks foliage positions around the tree, grows ' +
      'a canopy at each, and draws a limb from the trunk out to every one high enough to qualify. ' +
      'All of trunk_height, trunk_width, width_scale, foliage_altitude_factor, branches and ' +
      'trunk_block are required.',
  },
  'fancy_trunk.trunk_height': {
    summary: 'The height of the tree, as a base, a variance and a trunk scale.',
    detail:
      'An object with all three members required. Note that the tree height and the COLUMN height ' +
      'are different numbers here -- see `scale`.',
  },
  'fancy_trunk.trunk_height.base': {
    summary: 'The fixed part of the overall tree height.',
    detail:
      'Also the floor under which a blocked trunk is not shortened: a trunk blocked above this ' +
      'height simply comes out shorter, and one blocked below it fails to grow at all.',
  },
  'fancy_trunk.trunk_height.variance': {
    summary: 'How much the tree height varies from tree to tree.',
    detail: 'Must be at least 1. One draw between 0 and this value is added to `base` for each tree.',
  },
  'fancy_trunk.trunk_height.scale': {
    summary: 'The fraction of the tree height the log column actually reaches.',
    detail:
      'Below 1 the column stops short of the top of the tree, which is normal here and not a ' +
      'defect: foliage routinely sits above the last log. A short height draw can leave the ' +
      'foliage overlapping the trunk, which is also what the game does.',
  },
  'fancy_trunk.trunk_width': {
    summary: 'How many blocks across the log column is.',
    detail: 'A square of this many logs per side, the same as on the acacia and mega trunks.',
  },
  'fancy_trunk.width_scale': {
    summary: 'How far out from the trunk the foliage clusters sit.',
    detail:
      'It scales the radius of the ring of foliage positions, so a larger value spreads the crown ' +
      'wider and makes the limbs reaching out to it longer.',
  },
  'fancy_trunk.foliage_altitude_factor': {
    summary: 'How the foliage spread changes with height up the tree.',
    detail:
      'The crown is shaped along a curved profile rather than a cylinder, and this is what bends ' +
      'it: it decides how wide the ring of foliage positions is at each height.',
  },
  'fancy_trunk.branches': {
    summary: 'The limbs drawn from the trunk out to the foliage clusters.',
    detail:
      'Required on this shape, unlike the acacia and mega trunks where the branches object is ' +
      'optional. All three of slope, density and min_altitude_factor are required inside it.',
  },
  'fancy_trunk.branches.slope': {
    summary: 'How steeply a limb climbs as it reaches outward.',
    detail: 'It sets where on the trunk a limb starts, so a steeper slope attaches it lower down.',
  },
  'fancy_trunk.branches.density': {
    summary: 'How many foliage clusters, and so how many limbs, the tree gets.',
    detail: 'Scaled by the height of the tree, so a taller tree with the same density carries more clusters.',
  },
  'fancy_trunk.branches.min_altitude_factor': {
    summary: 'How high up a cluster must be before a limb is drawn to it.',
    detail:
      'Clusters below it still grow their canopy -- they simply float, with no limb connecting ' +
      'them to the trunk. Limbs are also written without checking may_replace, so they overwrite ' +
      'whatever they cross.',
  },
  'fancy_trunk.trunk_block': TRUNK_BLOCK_DOC,

  // ---- mangrove ----
  mangrove_trunk: {
    summary: 'The mangrove trunk: a thin column that sprouts short angled branches.',
    detail:
      'The shape that pairs with the top-level mangrove_roots key, though the roots run for every ' +
      'trunk shape. Its trunk_height is an object of base plus two random terms, which is unlike ' +
      'every other trunk shape.',
  },
  'mangrove_trunk.trunk_width': {
    summary: 'Accepted here, but it changes nothing on this shape.',
    detail:
      'The mangrove column is always one block across whatever this says. It is accepted rather ' +
      'than refused so a pack that already writes it still loads.',
  },
  'mangrove_trunk.trunk_height': {
    summary: 'The height, as a fixed base plus two independent random terms.',
    detail:
      'An object, and all three members are required. Two separate draws are added to `base`, ' +
      'which piles the result toward the middle instead of spreading it evenly like a range would.',
  },
  'mangrove_trunk.trunk_height.base': {
    summary: 'The fixed part of the mangrove trunk height.',
    detail: 'Both random terms are added on top of it, so it is the shortest the column can be.',
  },
  'mangrove_trunk.trunk_height.height_rand_a': {
    summary: 'The first random term added to the mangrove height.',
    detail: 'One draw from 0 up to and including this value. A 0 here contributes nothing.',
  },
  'mangrove_trunk.trunk_height.height_rand_b': {
    summary: 'The second random term added to the mangrove height.',
    detail:
      'Drawn separately from the first and added as well, so the two together bunch the height ' +
      'around the middle of their combined span rather than spreading it evenly.',
  },
  'mangrove_trunk.trunk_block': TRUNK_BLOCK_DOC,
  'mangrove_trunk.branches': {
    summary: 'The short angled branches that come off the mangrove column.',
    detail:
      'Optional, and leaving it out is not the same as switching branches off: every non-final log ' +
      'flips a coin either way, and on a win a branch is grown using lengths of 0, which places ' +
      'nothing. Writing the object simply gives those draws something to work with.',
  },
  'mangrove_trunk.branches.branch_length': {
    summary: 'How far a mangrove branch reaches out.',
    detail:
      'Drawn TWICE per branch, and both draws are used: the difference between them decides where ' +
      'along the branch the logs actually start, so a wide range makes a ragged tree rather than ' +
      'just a longer branch.',
  },
  'mangrove_trunk.branches.branch_steps': {
    summary: 'How many times a mangrove branch steps upward as it goes out.',
    detail: 'Drawn once per branch. It is what tilts the branch up rather than leaving it flat.',
  },
  'mangrove_trunk.branches.branch_chance': {
    summary: 'Accepted here, but it changes nothing on this shape.',
    detail:
      'Whether a mangrove branch is grown is decided by a plain coin flip that this key does not ' +
      'feed. A malformed value is still reported, so it has to be written correctly even though ' +
      'nothing reads it.',
  },
  'mangrove_trunk.branches.branch_chance.numerator': {
    summary: 'The top half of a fraction that nothing here reads.',
    detail: 'Present because branch_chance accepts the fraction spelling; it has no effect on this shape.',
  },
  'mangrove_trunk.branches.branch_chance.denominator': {
    summary: 'The bottom half of a fraction that nothing here reads.',
    detail: 'Present because branch_chance accepts the fraction spelling; it has no effect on this shape.',
  },
  ...decorationDocs('mangrove_trunk', 'on all four sides of every log, the topmost one included, and of every branch log'),

  // ---- mega ----
  mega_trunk: {
    summary: 'The wide trunk of a giant tree, with long sweeping branches.',
    detail:
      'trunk_width is required and is usually 2 or more, which is what makes it "mega". It is the ' +
      'only trunk shape that builds the tree\'s top-level base_cluster -- written next to any ' +
      'other shape, that key is read and then never used.',
  },
  'mega_trunk.trunk_height': {
    summary: 'The height of the column, as a base plus optional random steps.',
    detail: 'An object of `base` and `intervals`, the same shape the acacia and cherry trunks use, not a range.',
  },
  'mega_trunk.trunk_height.base': {
    summary: 'The fixed part of the mega trunk height.',
    detail: 'Everything `intervals` draws is added on top of this. Giant trees need a tall preview volume to fit.',
  },
  'mega_trunk.trunk_height.intervals': INTERVALS_DOC,
  'mega_trunk.trunk_width': {
    summary: 'How many blocks across the wide column is.',
    detail:
      'A square of this many logs per side. It also decides which logs are on an edge, and only ' +
      'edge logs carry a decoration -- and the topmost layer never does, whatever its width.',
  },
  'mega_trunk.trunk_block': TRUNK_BLOCK_DOC,
  'mega_trunk.branches': {
    summary: 'The long branches that sweep out from the column.',
    detail:
      'Optional, and here absence really does mean no branches at all. The branches are built ' +
      'BEFORE the column, so a log of the trunk placed afterwards can overwrite a branch log that ' +
      'crossed it. branch_length, branch_slope, branch_interval and branch_altitude_factor are all ' +
      'required once the object is present.',
  },
  'mega_trunk.branches.branch_length': {
    summary: 'How many logs long each branch is.',
    detail:
      'A plain whole number, not a range, so every branch on the tree is the same length. The logs ' +
      'are written without checking may_replace, so a branch goes straight through whatever is there.',
  },
  'mega_trunk.branches.branch_slope': {
    summary: 'How steeply each branch climbs as it reaches out.',
    detail: 'Applied per log, so it also decides how far below the branch\'s anchor height the branch starts.',
  },
  'mega_trunk.branches.branch_interval': {
    summary: 'The vertical gap between one branch and the next.',
    detail:
      'Drawn fresh for each gap, so the branches are unevenly spaced up the trunk. Branches keep ' +
      'being added downward until the next gap would take them below where branches are allowed.',
  },
  'mega_trunk.branches.branch_altitude_factor': {
    summary: 'The band of the trunk, top and bottom, that carries branches.',
    detail:
      'Both members are fractions of the tree height: `max` is where the topmost branch may sit ' +
      'and `min` is the lowest. This object is the one place in a trunk body that really is ' +
      'spelled `min` and `max` -- everywhere else those two names are the wrong spelling of a range.',
  },
  'mega_trunk.branches.branch_altitude_factor.min': {
    summary: 'The lowest point on the trunk that may carry a branch.',
    detail: 'A fraction of the tree height, so 0.4 means branches stop about two fifths of the way up.',
  },
  'mega_trunk.branches.branch_altitude_factor.max': {
    summary: 'The highest point on the trunk that may carry a branch.',
    detail: 'A fraction of the tree height, and where the first branch is placed before the gaps walk downward.',
  },
  'mega_trunk.branches.branch_canopy': BRANCH_CANOPY_DOC,
  ...decorationDocs(
    'mega_trunk',
    'on the outward sides of every edge log below the top layer -- the topmost layer of logs is never decorated',
  ),

  // ---- poplar ----
  poplar_trunk: {
    summary: 'A tall narrow column with a small ring of branches near the top.',
    detail:
      'Added in game version 1.26.50. The branches are short stubs that support the crown rather ' +
      'than limbs of their own, and the canopy is anchored just above them rather than on top of ' +
      'the column.',
  },
  'poplar_trunk.trunk_height': {
    summary: 'How many logs tall the poplar column is.',
    detail:
      'A range, like the plain trunk and unlike the acacia, mega, cherry, fancy and mangrove ' +
      'trunks, all of which want an object here. Required, even though the shape has a height of ' +
      'its own it would otherwise fall back on.',
  },
  'poplar_trunk.remaining_trunk_height_above_branches': {
    summary: 'How much bare trunk is left standing above the branch ring.',
    detail:
      'Measured down from the top, so a larger value pushes the branches and the canopy lower ' +
      'without making the tree shorter. The default of four blocks is a fixed number and costs no draw.',
  },
  'poplar_trunk.amount_of_foliage_support_branches': {
    summary: 'How many short branches ring the trunk under the crown.',
    detail:
      'The directions are shuffled first, so a count of 2 picks two different sides at random. ' +
      'There are only four sides, so anything above 4 behaves exactly like 4.',
  },
  'poplar_trunk.trunk_block': TRUNK_BLOCK_DOC,
  ...decorationDocs('poplar_trunk', 'on all four sides of every log of the column and of every branch stub'),
}

/** The enum-value documentation for every enum field TREE_TRUNK_FIELDS adds, keyed by dotted path
 * then by value. Slots straight into TYPE_VALUE_DOCS['minecraft:tree_feature'].
 *
 * `step_direction` is the only enum in a trunk body, and it appears at the six variants that
 * register a trunk_decoration. The four values mean the same thing at every one of them, so the
 * same entries are shared across all six paths rather than reworded per variant. */
export const TREE_TRUNK_VALUE_DOCS: Readonly<Record<string, Readonly<Record<string, DocEntry>>>> =
  Object.fromEntries(
    TREE_TRUNK_VARIANTS.filter((key) =>
      (VARIANT_BODIES[key]).some((f) => f.key === 'trunk_decoration'),
    ).map((key) => [`${key}.trunk_decoration.step_direction`, STEP_DIRECTION_VALUE_DOCS]),
  )
