// treeCanopies.ts -- the twelve canopy variant bodies of `minecraft:tree_feature`, as data the
// node property form can render.
//
// WHY THIS FILE EXISTS. typeCatalog.ts models a tree's canopy as a single mutually-exclusive
// choice between twelve keys, and then hands every one of them a raw-JSON text box: the variant
// NAMES were known, the keys INSIDE each variant were not. Picking `spruce_canopy` in the editor
// therefore dropped the author straight back into hand-writing JSON, which is the one place a
// visual editor has nothing to offer. This module fills that in.
//
// THREE THINGS ABOUT THE SHAPE OF THE DATA, because each of them is a trap that has already been
// walked into somewhere in this catalogue:
//
//   1. THE VARIANTS DO NOT SHARE A SUB-SCHEMA. `leaf_block` is on ten of the twelve and absent
//      from the other two. `canopy_height` is an integer on one variant and a range on four
//      others. `canopy_decoration` exists on two variants and is a DIFFERENT object on each.
//      Nothing below is copied from a neighbouring variant because the two looked alike; every
//      key on every variant follows where that variant's own body is parsed.
//
//   2. RANGE-TYPED KEYS READ `range_min`/`range_max`, NOT `min`/`max`. Given the wrong pair the
//      engine logs an error and substitutes a zero-width range -- the file loads and the field
//      does nothing. Those keys are kind 'range' here so the form says so. The exception is the
//      bare canopy's `canopy_offset`, which is NOT a range at all but a plain object whose two
//      members really are named `min` and `max`; it is a 'group' for exactly that reason.
//
//   3. A KEY THAT COULD NOT BE SOURCED IS NOT GUESSED. The engine drops an unrecognised key
//      without reporting anything an author can see from inside this editor, so a confidently
//      wrong control is worse than a text box. Nothing here is inferred from a name.
//
// REQUIRED VS OPTIONAL IS LOAD-BEARING. A handful of keys below are optional in the game's own
// schema but are still marked required here, because what the game does with them ABSENT has not
// been established -- offering a control that can be left empty would silently produce a tree
// with a shape nobody chose. Each one says so in its `default` prose. That direction is the safe
// one: asking for a value the game would have defaulted costs an author one entry, where guessing
// the default wrong costs them a shape they cannot explain.
//
// NO CANOPY VARIANT CARRIES A DELEGATION KEY. Nothing under any of the twelve names another
// feature, so none of these keys is an edge in the graph -- the tree feature's one such key
// (`log_decoration_feature`) sits under a trunk, not a canopy.

import type { DocEntry } from './docs/catalog'
import type { FieldSpec } from './typeCatalog'

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** `leaf_block`, which ten of the twelve variants carry and spell identically. The two that do
 * not -- `random_spread_canopy` and `mangrove_canopy` -- take a weighted `leaf_blocks` list
 * instead and have no singular form at all. */
function leafBlockField(): FieldSpec {
  return { key: 'leaf_block', kind: 'block', required: true, source: 'builder' }
}

/** `leaf_blocks`, the weighted list the two scattering canopies take in place of `leaf_block`.
 * Each entry is a two-element `[block, weight]` pair; the list may not be empty. */
function leafBlocksField(): FieldSpec {
  return { key: 'leaf_blocks', kind: 'weightedBlockList', required: true, source: 'builder' }
}

/** `leaf_placement_attempts`, shared by the two scattering canopies under the same spelling and
 * the same meaning: how many leaves are attempted per trunk position. */
function leafPlacementAttemptsField(): FieldSpec {
  return { key: 'leaf_placement_attempts', kind: 'integer', required: true, min: 0, source: 'builder' }
}

/** `core_width`, on the three canopies that are sized from the trunk rather than independently.
 * It is not a free parameter: it has to equal the width of the trunk this canopy is attached to,
 * and the feature is refused when it does not. */
function coreWidthField(): FieldSpec {
  return { key: 'core_width', kind: 'integer', required: true, source: 'builder' }
}

/** The attachable-decoration object, as `mangrove_canopy.canopy_decoration` spells it.
 *
 * This is NOT the same object as the bare canopy's `canopy_decoration`, despite the identical key
 * name -- different members, different spellings, different behaviour. Kept as its own builder so
 * the two cannot be accidentally unified later. */
function attachableDecorationEntry(): readonly FieldSpec[] {
  return [
    { key: 'decoration_block', kind: 'block', required: false, default: 'no block, unless decoration_blocks_sequence supplies one', source: 'builder' },
    {
      key: 'decoration_blocks_sequence',
      kind: 'groupList',
      required: false,
      default: 'the single decoration_block is used instead',
      entry: [
        { key: 'block', kind: 'block', required: true, source: 'builder' },
        { key: 'count', kind: 'range', required: false, default: 'one block', source: 'builder' },
      ],
      source: 'builder',
    },
    { key: 'decoration_chance', kind: 'chance', required: true, source: 'builder' },
    { key: 'num_steps', kind: 'integer', required: false, default: 'nothing -- the value is accepted and never read', source: 'builder-header' },
    {
      key: 'step_direction',
      kind: 'enum',
      required: false,
      values: ['down', 'up', 'out', 'away'],
      default: 'down',
      source: 'builder',
    },
  ]
}

// ---------------------------------------------------------------------------
// The twelve variants
// ---------------------------------------------------------------------------

/** The keys of every variant, in the engine's own order for the canopy variants. `canopy`
 * sorts where it does because that order is alphabetical on the bare name. */
export const TREE_CANOPY_VARIANT_KEYS: readonly string[] = [
  'acacia_canopy',
  'canopy',
  'cherry_canopy',
  'fancy_canopy',
  'mangrove_canopy',
  'mega_canopy',
  'mega_pine_canopy',
  'pine_canopy',
  'poplar_canopy',
  'roofed_canopy',
  'spruce_canopy',
  'random_spread_canopy',
]

/** The body of each variant, keyed by the variant's own JSON key. Every entry is complete: there
 * is no variant here with keys left out and no placeholder among them. */
const VARIANT_ENTRIES: Readonly<Record<string, readonly FieldSpec[]>> = {
  // The generic shape. Written as the bare word `canopy`, it is a real variant with its own key
  // set -- not a default that resolves to one of the others.
  canopy: [
    leafBlockField(),
    {
      key: 'canopy_offset',
      kind: 'group',
      required: true,
      entry: [
        { key: 'min', kind: 'integer', required: true, source: 'builder' },
        { key: 'max', kind: 'integer', required: true, source: 'builder' },
      ],
      source: 'builder',
    },
    { key: 'min_width', kind: 'integer', required: false, default: '0', source: 'builder' },
    {
      key: 'canopy_slope',
      kind: 'group',
      required: false,
      default: 'a 1-to-1 slope -- one step of radius per layer',
      entry: [
        { key: 'rise', kind: 'integer', required: false, default: '1', source: 'builder' },
        { key: 'run', kind: 'integer', required: false, default: '1', source: 'builder' },
      ],
      source: 'builder',
    },
    {
      key: 'variation_chance',
      kind: 'json',
      required: false,
      default: 'no corner is ever removed, and no random number is drawn for one',
      unsourced:
        'This key accepts three spellings and a single control cannot offer all three: a percent number, a ' +
        '{numerator, denominator} object, or an array of either with exactly one entry per canopy layer, ordered ' +
        'from canopy_offset.min upward. An array of the wrong length is refused. Write it as JSON.',
      source: 'builder',
    },
    {
      key: 'canopy_decoration',
      kind: 'group',
      required: false,
      default: 'nothing hangs off the canopy, and no random number is drawn for it',
      entry: [
        { key: 'decoration_block', kind: 'block', required: true, source: 'builder' },
        { key: 'decoration_chance', kind: 'chance', required: true, source: 'builder' },
        { key: 'num_steps', kind: 'range', required: true, source: 'builder' },
        { key: 'step_direction', kind: 'enum', required: true, values: ['down'], source: 'builder' },
      ],
      source: 'builder',
    },
  ],

  acacia_canopy: [
    leafBlockField(),
    { key: 'canopy_size', kind: 'integer', required: true, source: 'builder' },
    { key: 'simplify_canopy', kind: 'boolean', required: false, default: 'false', source: 'builder' },
  ],

  cherry_canopy: [
    leafBlockField(),
    { key: 'height', kind: 'range', required: true, min: 4, source: 'builder' },
    { key: 'radius', kind: 'range', required: true, min: 3, source: 'builder' },
    {
      key: 'trunk_width',
      kind: 'integer',
      required: false,
      min: 1,
      max: 1,
      default: '1',
      source: 'builder',
    },
    { key: 'wide_bottom_layer_hole_chance', kind: 'chance', required: true, source: 'builder' },
    { key: 'corner_hole_chance', kind: 'chance', required: true, source: 'builder' },
    { key: 'hanging_leaves_chance', kind: 'chance', required: true, source: 'builder' },
    { key: 'hanging_leaves_extension_chance', kind: 'chance', required: true, source: 'builder' },
  ],

  fancy_canopy: [
    leafBlockField(),
    { key: 'height', kind: 'integer', required: true, min: 0, source: 'builder' },
    {
      key: 'radius',
      kind: 'integer',
      required: true,
      min: 1,
      default: 'the game treats this key as optional, but what it falls back to has not been established, so a value is asked for here rather than guessed',
      source: 'builder',
    },
  ],

  mangrove_canopy: [
    { key: 'canopy_height', kind: 'range', required: true, source: 'builder' },
    { key: 'canopy_radius', kind: 'range', required: true, source: 'builder' },
    leafPlacementAttemptsField(),
    leafBlocksField(),
    { key: 'hanging_block', kind: 'block', required: true, source: 'builder' },
    { key: 'hanging_block_placement_chance', kind: 'chance', required: true, source: 'builder' },
    {
      key: 'canopy_decoration',
      kind: 'group',
      required: false,
      default: 'nothing is attached to the scattered leaves, and no random number is drawn for it',
      entry: attachableDecorationEntry(),
      source: 'builder',
    },
  ],

  mega_canopy: [
    leafBlockField(),
    { key: 'canopy_height', kind: 'range', required: true, source: 'builder' },
    { key: 'base_radius', kind: 'integer', required: false, min: 0, default: '2', source: 'builder' },
    coreWidthField(),
    { key: 'simplify_canopy', kind: 'boolean', required: false, default: 'false', source: 'builder' },
  ],

  mega_pine_canopy: [
    leafBlockField(),
    { key: 'canopy_height', kind: 'range', required: true, source: 'builder' },
    { key: 'base_radius', kind: 'integer', required: false, min: 0, default: '2', source: 'builder' },
    { key: 'radius_step_modifier', kind: 'number', required: false, default: '3.5', source: 'builder' },
    coreWidthField(),
  ],

  pine_canopy: [
    leafBlockField(),
    { key: 'canopy_height', kind: 'range', required: true, source: 'builder' },
    { key: 'base_radius', kind: 'integer', required: true, source: 'builder' },
  ],

  poplar_canopy: [
    leafBlockField(),
    { key: 'branch_block', kind: 'block', required: true, source: 'builder' },
    {
      key: 'radius',
      kind: 'groupList',
      required: true,
      entry: [
        { key: 'value', kind: 'integer', required: true, source: 'builder' },
        { key: 'weight', kind: 'integer', required: false, default: '1', source: 'builder' },
      ],
      source: 'builder',
    },
    { key: 'height', kind: 'range', required: true, source: 'builder' },
    { key: 'side_hole_chance', kind: 'number', required: false, default: '0 -- no cell is pitted, though the roll is still spent on every cell', source: 'builder' },
    { key: 'trunk_width', kind: 'integer', required: false, default: '1', source: 'builder' },
  ],

  roofed_canopy: [
    leafBlockField(),
    { key: 'canopy_height', kind: 'integer', required: true, min: 0, source: 'builder' },
    coreWidthField(),
    {
      key: 'outer_radius',
      kind: 'integer',
      required: true,
      min: -1,
      default: 'the game treats this key as optional, but what it falls back to has not been established, so a value is asked for here rather than guessed',
      source: 'builder',
    },
    {
      key: 'inner_radius',
      kind: 'integer',
      required: true,
      min: 0,
      default: 'the game treats this key as optional, but what it falls back to has not been established, so a value is asked for here rather than guessed',
      source: 'builder',
    },
  ],

  spruce_canopy: [
    leafBlockField(),
    { key: 'lower_offset', kind: 'range', required: true, source: 'builder' },
    {
      key: 'upper_offset',
      kind: 'range',
      required: true,
      default: 'the game treats this key as optional, but what it falls back to has not been established, so a value is asked for here rather than guessed',
      source: 'builder',
    },
    { key: 'max_radius', kind: 'range', required: true, source: 'builder' },
  ],

  random_spread_canopy: [
    { key: 'canopy_height', kind: 'range', required: true, source: 'builder' },
    { key: 'canopy_radius', kind: 'range', required: true, source: 'builder' },
    leafPlacementAttemptsField(),
    leafBlocksField(),
  ],
}

/** The twelve canopy variants as FieldSpecs, ready to replace the raw-JSON placeholders in
 * `minecraft:tree_feature`. Each is a 'group' carrying its own key set, and each belongs to the
 * `canopy` exclusive group -- at most one may be written, and writing two is an error. */
export const TREE_CANOPY_FIELDS: readonly FieldSpec[] = TREE_CANOPY_VARIANT_KEYS.map((key): FieldSpec => {
  const entry = VARIANT_ENTRIES[key]
  if (entry === undefined) throw new Error(`treeCanopies: no body for canopy variant "${key}"`)
  const base: FieldSpec = {
    key,
    kind: 'group',
    required: false,
    exclusiveGroup: 'canopy',
    entry,
    source: 'builder',
  }
  return key === 'poplar_canopy'
    ? {
        ...base,
        introducedInBuild:
          'game build 1.26.50.24 -- whether the schema gates this key on format_version was NOT established, so it is offered at every version rather than hidden below one',
      }
    : base
})

/** `branch_canopy` is NOT a thirteenth canopy variant, and it is not a feature reference either.
 *
 * It appears inside a trunk's `branches` object -- on `acacia_trunk`, `mega_trunk` and
 * `cherry_trunk` -- and its value is an object that must itself carry exactly one of the twelve
 * keys above. So it is a HOST for this group rather than a member of it, and a form rendering it
 * should offer the same twelve-way choice, not a thirteenth shape.
 *
 * One thing differs at a branch tip: the canopy is always built against a trunk one block wide,
 * whatever the trunk's own `trunk_width` says. That matters for the three variants that check
 * `core_width` against the trunk, which at a branch tip must be 1. */
export const BRANCH_CANOPY_HOST_KEY = 'branch_canopy'

/** The trunk keys whose `branches` object accepts `branch_canopy`. */
export const BRANCH_CANOPY_HOST_TRUNKS: readonly string[] = ['acacia_trunk', 'cherry_trunk', 'mega_trunk']

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

/** One entry for every field above, keyed by its dotted path under `minecraft:tree_feature`.
 * Spread straight into that type's table in the hover catalogue. */
export const TREE_CANOPY_DOCS: Readonly<Record<string, DocEntry>> = {
  // -- canopy (the generic shape) -------------------------------------------
  canopy: {
    summary: 'The generic canopy: a stack of filled squares over the trunk, widest at the bottom.',
    detail:
      'The bare word is a real shape with its own key set, not a default that turns into one of the ' +
      'others. Each layer\'s half-width is min_width plus the drop from the top layer\'s slope to this ' +
      'one\'s, so with the default 1-to-1 slope and canopy_offset {min: -3, max: 0} the radii run 3, 2, ' +
      '1, 0 from the bottom up -- the familiar oak crown.',
  },
  'canopy.leaf_block': {
    summary: 'The block every layer of the crown is built from.',
    detail: 'One block for the whole shape; this canopy has no second block and no weighting.',
  },
  'canopy.canopy_offset': {
    summary: 'Which heights the layers occupy, measured from the top of the trunk.',
    detail:
      'Mind the spelling: this is a plain object with members named min and max, NOT a range, so ' +
      'range_min and range_max do not work here and neither does the two-element array form. A ' +
      'negative min puts layers BELOW the point the trunk handed over.',
  },
  'canopy.canopy_offset.min': {
    summary: 'The lowest layer, as an offset from the trunk top.',
    detail: 'Usually negative, because the crown normally starts below the trunk top and builds upward.',
  },
  'canopy.canopy_offset.max': {
    summary: 'The highest layer, as an offset from the trunk top.',
    detail:
      'Also the layer the whole taper is measured from: every other layer\'s width is worked out as its ' +
      'distance below this one, so moving max changes the width of every layer at once, not just the top.',
  },
  'canopy.min_width': {
    summary: 'A half-width added to every layer, including the topmost.',
    detail: 'It widens the crown uniformly rather than changing its taper; canopy_slope is what changes the taper.',
  },
  'canopy.canopy_slope': {
    summary: 'How fast the layers narrow going up, as a rise over a run.',
    detail:
      'A run of 2 makes the crown lose half a step of width per layer, so it tapers half as fast and ends ' +
      'up taller for the same width. A run of zero is refused rather than divided by.',
  },
  'canopy.canopy_slope.rise': { summary: 'The numerator of the taper: how much width is lost per run of layers.', detail: 'Raising it narrows the crown faster and leaves a smaller top.' },
  'canopy.canopy_slope.run': { summary: 'The denominator of the taper: how many layers one step of width is spread over.', detail: 'Raising it makes a taller, more column-like crown. Zero is refused.' },
  'canopy.variation_chance': {
    summary: 'Chance to leave out each of the four corners of a layer, which is what rounds the square off.',
    detail:
      'Four cells per layer -- where the horizontal and vertical distances from the centre both equal that ' +
      'layer\'s half-width -- are each rolled once. This is the only part of this canopy that draws random ' +
      'numbers at all. There is no guard for a one-cell layer: on a layer of half-width 0 that single centre ' +
      'cell IS all four corners, so a chance that always succeeds deletes the layer outright -- which is how ' +
      'a crown gets capped flat instead of ending in one leaf poking out of the top.',
  },
  'canopy.canopy_decoration': {
    summary: 'Hangs a block off the sides of the crown -- vines, typically.',
    detail:
      'Each leaf the canopy places rolls once per horizontal neighbour; a success on a neighbour that is ' +
      'air writes a run of cells straight down from it, stopping at the first cell that is not air. Note ' +
      'that this object is NOT the same shape as the object of the same name on mangrove_canopy.',
  },
  'canopy.canopy_decoration.decoration_block': { summary: 'The block written down the side of the crown.', detail: 'The whole run is this one block; there is no sequence form here.' },
  'canopy.canopy_decoration.decoration_chance': { summary: 'Chance that any one horizontal neighbour of a leaf starts a run.', detail: 'Rolled per leaf per neighbour, so a dense crown spends a great many rolls.' },
  'canopy.canopy_decoration.num_steps': {
    summary: 'How many cells long a run is, drawn per run.',
    detail:
      'A range, so it wants range_min and range_max. The run stops early at the first cell that is not air, ' +
      'so a long range does not guarantee a long strand.',
  },
  'canopy.canopy_decoration.step_direction': {
    summary: 'Which way the run grows. Only downward is accepted here.',
    detail:
      'That is the direction vanilla\'s own definitions use and the only one whose behaviour has been ' +
      'established for this object, so any other spelling is refused rather than guessed at.',
  },

  // -- acacia_canopy --------------------------------------------------------
  acacia_canopy: {
    summary: 'The flat, spreading acacia crown: one wide octagonal ring with a smaller layer on top.',
    detail: 'Entirely fixed -- this shape draws no random numbers at all, so two acacias with the same settings get identical crowns.',
  },
  'acacia_canopy.leaf_block': {
    summary: 'The block both layers of the crown are built from.',
    detail: 'One block for the whole crown -- this shape takes no second block and no weighted list, so the two layers always match.',
  },
  'acacia_canopy.canopy_size': {
    summary: 'The half-width of the lower ring.',
    detail:
      'The lower layer is a square of this half-width minus its four exact corners. That corner cut has no ' +
      'guard for a size of 0: at 0 the single centre cell is itself a corner, so the lower layer comes out ' +
      'completely empty and only the upper layer is placed.',
  },
  'acacia_canopy.simplify_canopy': {
    summary: 'Replaces the upper layer\'s four protruding arms with a plain square.',
    detail:
      'With it off, the upper layer is a narrower square with four single cells poking out along the axes. ' +
      'With it on, it is one filled square and nothing sticks out -- a cleaner, slightly smaller silhouette.',
  },

  // -- cherry_canopy --------------------------------------------------------
  cherry_canopy: {
    summary: 'The cherry crown: a rounded block of leaves with a fringe hanging below it.',
    detail:
      'Built as a stack of square layers that widen toward the bottom, then two more layers below the ' +
      'anchor that also trail leaves downward. The cherry trunk grows one of these at each branch tip ' +
      'rather than one for the whole tree.',
  },
  'cherry_canopy.leaf_block': { summary: 'The block the crown and its hanging fringe are built from.', detail: 'The fringe is the same block as the body; there is no separate hanging block on this shape.' },
  'cherry_canopy.height': {
    summary: 'How tall the crown is, drawn per crown. At least 4.',
    detail:
      'A range, so it wants range_min and range_max. The bottom four layers are fixed in shape and the ' +
      'remainder stack above them at full width, so raising this makes the crown taller without making it ' +
      'wider. Values below 4 leave the shape with no layers to build and are refused.',
  },
  'cherry_canopy.radius': {
    summary: 'How wide the crown is, drawn per crown. At least 3.',
    detail:
      'A range, so it wants range_min and range_max. The widest layers sit at this half-width; the top two ' +
      'step in by one and two cells. Values below 3 make the topmost layer inside-out and are refused.',
  },
  'cherry_canopy.trunk_width': {
    summary: 'The trunk footprint the crown is built around. Must be 1.',
    detail:
      'Every trunk that can carry this crown hands it a one-block footprint, so any other value is refused ' +
      'rather than silently building a crown around a trunk that is not there.',
  },
  'cherry_canopy.wide_bottom_layer_hole_chance': {
    summary: 'Chance to punch a hole in the outer edge of the widest bottom layer.',
    detail: 'Rolled per edge cell of that one layer. It is what stops the underside reading as a solid slab.',
  },
  'cherry_canopy.corner_hole_chance': {
    summary: 'Chance to leave out a corner cell of a layer.',
    detail:
      'Which cells count as corners changes with the layer\'s width: a narrow layer rolls its four square ' +
      'corners, a wide one has its corners cut outright and instead rolls a ring just inside the edge.',
  },
  'cherry_canopy.hanging_leaves_chance': {
    summary: 'Chance to trail a leaf one cell below the crown\'s bottom edge.',
    detail: 'Rolled along the four straight edges of the two lowest layers -- the fringe that gives a cherry its drooping look.',
  },
  'cherry_canopy.hanging_leaves_extension_chance': {
    summary: 'Chance to extend a trailing leaf by a second cell.',
    detail: 'Rolled only where the first leaf was actually placed, so this is a chance on a chance and a small value thins the fringe quickly.',
  },

  // -- fancy_canopy ---------------------------------------------------------
  fancy_canopy: {
    summary: 'A stack of round discs, full width in the middle and pulled in at the top and bottom.',
    detail:
      'Each layer is a disc rather than a square, which is what makes this the roundest of the twelve. It ' +
      'draws no random numbers, so its shape is entirely fixed by its two numbers.',
  },
  'fancy_canopy.leaf_block': {
    summary: 'The block every disc is built from.',
    detail: 'One block for the whole crown -- this shape takes no second block and no weighted list, so the discs come out a single solid colour.',
  },
  'fancy_canopy.height': {
    summary: 'How many discs are stacked.',
    detail: 'A height of 0 is legal and places nothing at all. A height of 1 gives a single pulled-in disc, since that one layer is both the top cap and the bottom.',
  },
  'fancy_canopy.radius': {
    summary: 'The half-width of the middle discs.',
    detail: 'The top and bottom discs are one cell narrower than this. A radius below 1 would make those caps inside-out, so it is refused.',
  },

  // -- mangrove_canopy ------------------------------------------------------
  mangrove_canopy: {
    summary: 'A scattered crown of leaves with blocks hanging beneath it.',
    detail:
      'Unlike the layered shapes, this scatters individual leaves around EVERY log the trunk placed, not ' +
      'just the top one. Pair it with a trunk that collects its logs -- with the plain trunk or the cherry ' +
      'trunk it is handed an empty list, places nothing and draws nothing, leaving a bare pole.',
  },
  'mangrove_canopy.canopy_height': {
    summary: 'How far up and down a scattered leaf may land, drawn once for the whole crown.',
    detail: 'A range, so it wants range_min and range_max. One value is drawn per tree and then reused for every attempt.',
  },
  'mangrove_canopy.canopy_radius': {
    summary: 'How far sideways a scattered leaf may land, drawn once for the whole crown.',
    detail: 'A range, so it wants range_min and range_max. Like the height, drawn once and shared by every attempt.',
  },
  'mangrove_canopy.leaf_placement_attempts': {
    summary: 'How many leaves are attempted around each trunk log.',
    detail:
      'Multiplied by the number of logs the trunk collected, so this number and the trunk height together ' +
      'decide how dense the crown is. An attempt that lands somewhere it may not build is simply lost.',
  },
  'mangrove_canopy.leaf_blocks': {
    summary: 'The blocks the scattered leaves are picked from, with weights.',
    detail:
      'Write each entry as a two-element pair: the block first, then its weight. The list may not be empty. ' +
      'One pick is made per leaf, so the weights decide the mix within a single crown rather than between trees.',
  },
  'mangrove_canopy.hanging_block': {
    summary: 'The block hung beneath the crown -- propagules, in vanilla.',
    detail: 'Placed in a separate pass after every leaf is down, so it hangs from the finished shape rather than from a partial one.',
  },
  'mangrove_canopy.hanging_block_placement_chance': {
    summary: 'Chance that any one candidate position below the crown gets a hanging block.',
    detail: 'This is the only gate on that pass: at zero the crown is leaves alone, and the hanging block never appears.',
  },
  'mangrove_canopy.canopy_decoration': {
    summary: 'Attaches a block to the sides of the hanging positions.',
    detail:
      'Runs before the hanging blocks themselves, once per candidate, with all four horizontal sides ' +
      'eligible. Note that this object is a DIFFERENT shape from the object of the same name on the ' +
      'generic canopy: it takes a block sequence and a four-way step direction, where that one takes a ' +
      'single block and only accepts downward.',
  },
  'mangrove_canopy.canopy_decoration.decoration_block': {
    summary: 'A single block to attach.',
    detail: 'An alternative to decoration_blocks_sequence, not an addition to it -- when the sequence is present this is not read.',
  },
  'mangrove_canopy.canopy_decoration.decoration_blocks_sequence': {
    summary: 'An ordered list of block runs to attach, one after another from the same starting cell.',
    detail: 'Each run stops early the moment its next cell is not air, so a later run can be cut short by what an earlier one built.',
  },
  'mangrove_canopy.canopy_decoration.decoration_blocks_sequence.block': { summary: 'The block this run is made of.', detail: 'Required on every entry; an entry without one has nothing to place.' },
  'mangrove_canopy.canopy_decoration.decoration_blocks_sequence.count': {
    summary: 'How many cells long this run is, drawn per run.',
    detail: 'A range, so it wants range_min and range_max. Leaving it out gives a run of exactly one block.',
  },
  'mangrove_canopy.canopy_decoration.decoration_chance': { summary: 'Chance that any one eligible side is decorated.', detail: 'Rolled per side per candidate position. At zero nothing is attached and the whole object has no effect.' },
  'mangrove_canopy.canopy_decoration.num_steps': {
    summary: 'Accepted and then ignored -- this key has no effect.',
    detail:
      'The game reads the key and stores it, and the code that places the decoration never looks at it. It ' +
      'is listed so that finding it in an existing file is not mistaken for a setting that stopped working. ' +
      'Use the count on each sequence entry to control run length instead.',
  },
  'mangrove_canopy.canopy_decoration.step_direction': {
    summary: 'Which way a run of more than one block grows.',
    detail: 'Only runs longer than one cell can tell the difference, so on a single-block decoration this changes nothing.',
  },

  // -- mega_canopy ----------------------------------------------------------
  mega_canopy: {
    summary: 'A broad cone for a wide trunk, flaring outward toward the bottom.',
    detail: 'Each layer is one cell wider than the one above it, so the crown reads as a solid downward-flaring cone rather than a ball.',
  },
  'mega_canopy.leaf_block': {
    summary: 'The block every layer of the cone is built from.',
    detail: 'One block for the whole cone. Unlike the two scattering canopies there is no weighted list here, so a mega crown cannot be mixed from several leaf types.',
  },
  'mega_canopy.canopy_height': {
    summary: 'How many layers the cone has, drawn per tree.',
    detail: 'A range, so it wants range_min and range_max. A drawn value of 0 places nothing. This is the shape\'s only random draw.',
  },
  'mega_canopy.base_radius': {
    summary: 'The half-width of the narrowest layer, at the very top.',
    detail: 'Every layer below widens by one from here, so this sets the whole cone\'s width, not just the tip\'s.',
  },
  'mega_canopy.core_width': {
    summary: 'The width of the trunk this crown is built around. Must match it.',
    detail:
      'Not a free setting: the feature is refused when it disagrees with the trunk\'s own width. At a ' +
      'branch tip the trunk is always one block wide, so a crown grown there needs 1.',
  },
  'mega_canopy.simplify_canopy': {
    summary: 'Uses a strict circle for each layer instead of a relaxed one.',
    detail:
      'With it off -- the default -- the corners of each layer are allowed through and the crown is fuller. ' +
      'With it on, every cell must fall inside the circle, which visibly shrinks each layer.',
  },

  // -- mega_pine_canopy -----------------------------------------------------
  mega_pine_canopy: {
    summary: 'A tall conical crown for a wide trunk, widening in steps rather than one cell per layer.',
    detail: 'The same cone idea as mega_canopy but with the rate of widening under its own control, which is what makes it read as a pine rather than a jungle crown.',
  },
  'mega_pine_canopy.leaf_block': {
    summary: 'The block every layer of the cone is built from.',
    detail: 'One block for the whole cone, tiers included -- the widening is a change of shape, never a change of block.',
  },
  'mega_pine_canopy.canopy_height': {
    summary: 'How many layers the cone has, drawn per tree.',
    detail: 'A range, so it wants range_min and range_max. This is the shape\'s only random draw.',
  },
  'mega_pine_canopy.base_radius': { summary: 'The half-width of the topmost layer.', detail: 'Every layer below is this plus whatever radius_step_modifier has added by then.' },
  'mega_pine_canopy.radius_step_modifier': {
    summary: 'How fast the cone widens going down. Larger means a wider, blunter cone.',
    detail:
      'It scales the distance below the top before that distance is rounded down to whole cells, so a value ' +
      'below 1 makes several layers share a width and gives the crown visible tiers rather than a smooth ' +
      'flare.',
  },
  'mega_pine_canopy.core_width': {
    summary: 'The width of the trunk this crown is built around. Must match it.',
    detail: 'The feature is refused when it disagrees with the trunk\'s own width.',
  },

  // -- pine_canopy ----------------------------------------------------------
  pine_canopy: {
    summary: 'The narrow conical pine crown: diamond rings that shrink going up.',
    detail: 'One random draw jitters how far up the widest part sits, so two pines with identical settings still differ.',
  },
  'pine_canopy.leaf_block': {
    summary: 'The block every ring of the cone is built from.',
    detail: 'One block for the whole crown; this shape takes no second block, so the rings differ from each other only in width.',
  },
  'pine_canopy.canopy_height': {
    summary: 'How tall the cone is, drawn per tree.',
    detail:
      'A range, so it wants range_min and range_max. It also sets the size of the second draw that jitters ' +
      'the cone vertically, so a taller cone is also a more variable one.',
  },
  'pine_canopy.base_radius': { summary: 'The half-width the cone is allowed to reach at its widest.', detail: 'Where along the cone that width lands is what the jitter draw decides.' },

  // -- poplar_canopy --------------------------------------------------------
  poplar_canopy: {
    summary: 'A tall rounded crown of stacked diamonds with a cross of logs buried inside it.',
    detail:
      'One coin flip per tree bulges a diagonal pair of quadrants outward by a cell, which is what gives a ' +
      'poplar its slightly lopsided silhouette. The top two layers have their outermost row and column ' +
      'trimmed so the crown rounds off instead of ending in a slab.',
  },
  'poplar_canopy.leaf_block': { summary: 'The block the diamond layers are built from.', detail: 'The buried cross is branch_block instead; everything else is this.' },
  'poplar_canopy.branch_block': {
    summary: 'The log used for the cross buried inside the crown.',
    detail:
      'Placed four cells below the crown\'s top layer, reaching out along both horizontal axes with each ' +
      'arm\'s log turned to follow it. On a small crown the cross has no room and this block is never ' +
      'placed at all.',
  },
  'poplar_canopy.radius': {
    summary: 'The crown widths to choose between, with weights.',
    detail:
      'One entry is picked per tree in proportion to its weight, and the crown it builds is one cell ' +
      'narrower than the entry says -- a value of 3 gives half-width-2 layers. Below a value of 5 the ' +
      'buried cross disappears entirely.',
  },
  'poplar_canopy.radius.value': { summary: 'One candidate width. The crown built is one cell narrower than this.', detail: 'That offset by one is easy to lose: writing 5 here is what a crown of half-width 4 needs.' },
  'poplar_canopy.radius.weight': { summary: 'How often this width is picked, relative to the other entries.', detail: 'Weights are relative, not percentages, so doubling every entry changes nothing.' },
  'poplar_canopy.height': {
    summary: 'How tall the crown is, drawn per tree.',
    detail: 'A range, so it wants range_min and range_max. Unlike most ranges in this feature it includes its maximum.',
  },
  'poplar_canopy.side_hole_chance': {
    summary: 'Chance to pull any one surface cell in by a block, pitting the crown.',
    detail:
      'Mind the default, which is 0: no cell is ever pitted, and the crown comes out smooth. Worth knowing ' +
      'either way is that the roll happens for every candidate cell whether or not this key is written, so ' +
      'raising it changes the crown\'s look without changing how many random numbers the tree spends.',
  },
  'poplar_canopy.trunk_width': {
    summary: 'Checked against the trunk\'s own width. It does not change the crown\'s shape.',
    detail:
      'Every trunk that can carry a poplar crown hands it a one-block footprint, so the geometry is the ' +
      'same whatever is written here. Listed so that finding it in an existing file is not mistaken for a ' +
      'width setting that stopped working.',
  },

  // -- roofed_canopy --------------------------------------------------------
  roofed_canopy: {
    summary: 'The thick flat-topped crown of a dark forest: a solid floor, a hipped roof above it, and a peak.',
    detail:
      'The floor below the anchor is a full solid square; the roof at the top is that same square with its ' +
      'corners chamfered off. One coin flip decides whether a single cell is placed on top as a peak, and ' +
      'that flip is spent on every tree whatever the other settings say.',
  },
  'roofed_canopy.leaf_block': {
    summary: 'The block the floor, the filling and the roof are all built from.',
    detail: 'One block for all three parts -- there is no way to give the roof a different block from the floor on this shape.',
  },
  'roofed_canopy.canopy_height': {
    summary: 'How far above the anchor the roof sits, and how many layers of leaves fill the gap.',
    detail:
      'A height of 0 is legal and is not the same as placing nothing: the floor, the roof and the ' +
      'coin-flipped peak are all still placed, and only the filling between them is skipped.',
  },
  'roofed_canopy.core_width': {
    summary: 'The width of the trunk this crown is built around. Must match it.',
    detail: 'The feature is refused when it disagrees with the trunk\'s own width.',
  },
  'roofed_canopy.outer_radius': {
    summary: 'The half-width of the floor and the roof.',
    detail:
      'A value of -1 is legal and means exactly one thing: skip the floor and the roof entirely. The coin ' +
      'flip and its peak still happen. Anything below -1 is refused.',
  },
  'roofed_canopy.inner_radius': {
    summary: 'The half-width of the solid block of leaves stacked between the floor and the roof.',
    detail:
      'Filled, not hollow, with its four corners cut. Set it below the outer radius and the floor and roof ' +
      'overhang it like a brim; set it to 0 and the two slabs are joined by a single column.',
  },

  // -- spruce_canopy --------------------------------------------------------
  spruce_canopy: {
    summary: 'The layered spruce crown: bands that grow wide, snap back to nothing and grow again.',
    detail:
      'That grow-and-reset is the whole shape -- it is what gives a spruce its alternating full and skinny ' +
      'bands instead of the single smooth taper every other conical shape here has.',
  },
  'spruce_canopy.leaf_block': {
    summary: 'The block every band of the crown is built from.',
    detail: 'One block for the whole crown; the alternating bands are a change of width, not of block, so they read as one material throughout.',
  },
  'spruce_canopy.lower_offset': {
    summary: 'How far below the trunk top the crown reaches, drawn per tree.',
    detail: 'A range, so it wants range_min and range_max. Together with the upper offset it sets how many bands there is room for.',
  },
  'spruce_canopy.upper_offset': {
    summary: 'How far above the trunk top the crown starts, drawn per tree.',
    detail: 'A range, so it wants range_min and range_max. The crown is built downward from here.',
  },
  'spruce_canopy.max_radius': {
    summary: 'The widest a band may get before it snaps back, drawn per tree.',
    detail:
      'It is doing two jobs at once: the drawn value caps each band, and the SPAN between the two ends of ' +
      'the range decides how wide the first band is allowed to get before the first reset. So widening the ' +
      'range changes the banding pattern, not just the maximum width.',
  },

  // -- random_spread_canopy -------------------------------------------------
  random_spread_canopy: {
    summary: 'Leaves scattered at random around the trunk rather than arranged in layers.',
    detail:
      'Like mangrove_canopy it works from every log the trunk placed, not just the top one. Paired with ' +
      'the plain trunk or the cherry trunk it is handed an empty list, places nothing and draws nothing, ' +
      'leaving a bare pole -- pair it with the acacia, mega or mangrove trunk instead.',
  },
  'random_spread_canopy.canopy_height': {
    summary: 'How far up and down a scattered leaf may land, drawn once for the whole crown.',
    detail: 'A range, so it wants range_min and range_max. Drawn once per tree and then reused for every attempt.',
  },
  'random_spread_canopy.canopy_radius': {
    summary: 'How far sideways a scattered leaf may land, drawn once for the whole crown.',
    detail: 'A range, so it wants range_min and range_max. Drawn once per tree, like the height.',
  },
  'random_spread_canopy.leaf_placement_attempts': {
    summary: 'How many leaves are attempted around each trunk log.',
    detail:
      'Multiplied by the number of logs the trunk collected, so a tall trunk makes a much denser crown for ' +
      'the same number here. An attempt that lands somewhere it may not build is lost rather than retried.',
  },
  'random_spread_canopy.leaf_blocks': {
    summary: 'The blocks the scattered leaves are picked from, with weights.',
    detail:
      'Write each entry as a two-element pair: the block first, then its weight. The list may not be empty. ' +
      'A fresh pick is made for every leaf, so a mixed list gives one tree a mixed crown.',
  },
}

/** What each value of a canopy enum means. Only two keys here are enums, and both are the step
 * direction of a decoration -- spelled differently, because the two decoration objects are not
 * the same object. */
export const TREE_CANOPY_VALUE_DOCS: Readonly<Record<string, Readonly<Record<string, DocEntry>>>> = {
  'canopy.canopy_decoration.step_direction': {
    down: {
      summary: 'Grows the run straight down from the leaf it started at.',
      detail: 'The only value accepted for this object, and the one vanilla\'s own hanging vines use.',
    },
  },
  'mangrove_canopy.canopy_decoration.step_direction': {
    down: { summary: 'Grows each run downward from its starting cell.', detail: 'The default, and what a hanging decoration wants.' },
    up: { summary: 'Grows each run upward from its starting cell.', detail: 'The mirror of down; a run still stops at the first cell that is not air.' },
    out: { summary: 'Grows each run outward, away from the block it is attached to.', detail: 'The run reaches sideways into open space rather than along the crown.' },
    away: { summary: 'The same as out -- a second spelling of the outward direction.', detail: 'Written either way it behaves identically, so pick whichever reads better in your file.' },
  },
}
