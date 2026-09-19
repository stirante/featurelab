// treeGroundAndRoots.ts -- the last two tree keys that were still raw-JSON boxes.
//
// `base_cluster` and `mangrove_roots` sit beside the trunk and canopy variants on
// `minecraft:tree_feature` and were left undescribed when those were catalogued. They are small
// enough to have been easy to guess at and are exactly the wrong candidates for it: two of the
// three facts below contradict what a reasonable guess would produce.
//
// Both key sets follow this repo's engine port. Code references stay in comments, never in a
// string an author sees.

import type { FieldSpec } from './typeCatalog'
import type { DocEntry } from './docs/catalog'

/**
 * `base_cluster` -- a patch of ground laid under a wide trunk.
 *
 * OPTIONAL as a whole, and all three of its members are REQUIRED once it is present, which is a
 * distinction the form has to carry: leaving the object out is fine, and writing a half of it is
 * not.
 *
 * `num_clusters` and `cluster_radius` are PLAIN INTEGERS and not the ranges nearly everything else
 * in this type uses. The engine port records that explicitly, and calls it out as having
 * contradicted what the project's own conventions led it to expect -- so a form modelling them as
 * ranges would ask for `range_min`/`range_max`, the engine would find neither, and the cluster
 * would silently never be laid.
 */
const BASE_CLUSTER_ENTRY: readonly FieldSpec[] = [
  {
    key: 'may_replace',
    kind: 'blockList',
    required: true,
    source: 'builder',
  },
  {
    key: 'num_clusters',
    kind: 'integer',
    required: true,
    source: 'builder',
  },
  {
    key: 'cluster_radius',
    kind: 'integer',
    required: true,
    source: 'builder',
  },
]

/** `above_root` -- the optional block placed on top of a finished root. */
const ABOVE_ROOT_ENTRY: readonly FieldSpec[] = [
  {
    key: 'above_root_chance',
    kind: 'chance',
    required: false,
    default: 'never placed',
    source: 'builder',
  },
  {
    key: 'above_root_block',
    kind: 'block',
    required: false,
    source: 'builder',
  },
]

/**
 * `mangrove_roots` -- the stilt roots a mangrove stands on.
 *
 * Present only on a tree that asks for it; absent means no roots at all rather than default ones.
 */
const MANGROVE_ROOTS_ENTRY: readonly FieldSpec[] = [
  {
    key: 'max_root_width',
    kind: 'integer',
    required: true,
    source: 'builder',
  },
  {
    key: 'max_root_length',
    kind: 'integer',
    required: true,
    source: 'builder',
  },
  {
    key: 'y_offset',
    kind: 'range',
    required: true,
    source: 'builder',
  },
  { key: 'root_block', kind: 'block', required: true, source: 'builder' },
  {
    key: 'muddy_root_block',
    kind: 'block',
    required: true,
    source: 'builder',
  },
  { key: 'mud_block', kind: 'block', required: true, source: 'builder' },
  {
    key: 'roots_may_grow_through',
    kind: 'blockList',
    required: true,
    source: 'builder',
  },
  {
    key: 'above_root',
    kind: 'group',
    required: false,
    default: 'nothing is placed on top of a root',
    entry: ABOVE_ROOT_ENTRY,
    source: 'builder',
  },
  {
    key: 'root_decoration',
    kind: 'json',
    required: false,
    default: 'roots are left undecorated',
    // NOT a delegation, which the catalogue previously said it was. It is a decoration object of
    // the same shape a trunk's own decoration takes, and the graph builder does not treat it as an
    // edge -- so an editor that left it out as "that is an edge" simply hid a key.
    unsourced:
      'A decoration attached to the finished roots, in the same shape a trunk decoration takes. ' +
      'This editor does not describe its keys at this path yet, so it is edited as JSON.',
    source: 'builder',
  },
]

/** The two fields, ready to sit beside the trunk and canopy variants. */
export const TREE_GROUND_FIELDS: readonly FieldSpec[] = [
  {
    key: 'base_cluster',
    kind: 'group',
    required: false,
    default: 'no ground patch is laid',
    entry: BASE_CLUSTER_ENTRY,
    // No `doc` here: the documentation catalogue carries this key's explanation, and a second copy
    // beside it would be shown twice in the panel -- which a test forbids for that reason.
    source: 'builder',
  },
  {
    key: 'mangrove_roots',
    kind: 'group',
    required: false,
    default: 'the tree stands on no roots',
    entry: MANGROVE_ROOTS_ENTRY,
    source: 'builder',
  },
]

/** Documentation for every path the two fields add, keyed as docs/catalog.ts keys them.
 *
 * The FieldSpecs above carry no `doc` of their own. That field is meant to be sparse -- present
 * only where it changes what an author would write -- and the panel shows both, so an entry here
 * plus a `doc` beside it is the same sentence twice in one row. A test forbids the pair, which is
 * how this was caught rather than shipped. */
export const TREE_GROUND_DOCS: Readonly<Record<string, DocEntry>> = {
  base_cluster: {
    summary: 'A patch of ground laid under a wide trunk.',
    detail:
      'Only the wide-trunk shape reads it; on any other trunk it is accepted and does nothing. The ' +
      'whole object is optional, but all three of its keys are required once it is there -- half of ' +
      'it is refused, not defaulted.',
  },
  'base_cluster.may_replace': {
    summary: 'The blocks a patch may overwrite.',
    detail: 'An empty list is not the same as leaving the key out: with nothing listed, no patch is ever laid.',
  },
  'base_cluster.num_clusters': {
    summary: 'How many patches to lay.',
    detail:
      'A whole number, not a range -- unlike most sizes on this type. Writing `{range_min, range_max}` ' +
      'here is refused rather than read as a range. Nothing enforces a minimum: 0 or less loads ' +
      'clean and lays no patch at all.',
  },
  'base_cluster.cluster_radius': {
    summary: 'How far a patch reaches from its own centre.',
    detail:
      'A whole number, not a range, for the same reason as the count beside it. Nothing enforces a ' +
      'minimum here either: at 0 or less every patch comes out empty, so no ground is replaced.',
  },
  mangrove_roots: {
    summary: 'The stilt roots a mangrove stands on.',
    detail: 'Leaving it out means no roots at all, not roots of some default shape.',
  },
  'mangrove_roots.max_root_width': {
    summary: 'How far the roots may spread from the trunk.',
    detail:
      'Nothing enforces a minimum: 0 or less loads clean and behaves the same either way -- the ' +
      'roots never step sideways, they only drop straight down under the trunk.',
  },
  'mangrove_roots.max_root_length': {
    summary: 'How long one root may grow before it stops.',
    detail:
      'Nothing enforces a minimum, but 0 or less is fatal rather than inert: the root pass fails ' +
      'on the first direction and the whole tree is abandoned -- no roots, no trunk, no canopy.',
  },
  'mangrove_roots.y_offset': {
    summary: 'How far above or below the trunk base the roots start.',
    detail: 'Drawn once per tree, so two trees from the same settings can start their roots at different heights.',
  },
  'mangrove_roots.root_block': { summary: 'The block a root is built from in open air.' },
  'mangrove_roots.muddy_root_block': { summary: 'The block a root is built from where it passes through mud.' },
  'mangrove_roots.mud_block': { summary: 'The block laid as mud around the roots.' },
  'mangrove_roots.roots_may_grow_through': {
    summary: 'The blocks a root may pass through.',
    detail: 'A root that meets a block not listed here stops there; the rest of the roots carry on.',
  },
  'mangrove_roots.above_root': {
    summary: 'An optional block placed on top of a finished root.',
    detail: 'Both of its keys are optional; with neither set, nothing is placed.',
  },
  'mangrove_roots.above_root.above_root_chance': { summary: 'How often a finished root gets a block on top of it.' },
  'mangrove_roots.above_root.above_root_block': { summary: 'The block placed on top of a root.' },
  'mangrove_roots.root_decoration': {
    summary: 'A decoration attached to the finished roots.',
    detail:
      'The same shape a trunk decoration takes. Its own keys are not described at this path yet, so it ' +
      'is edited as JSON.',
  },
}
