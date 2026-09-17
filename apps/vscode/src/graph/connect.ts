// connect.ts -- what DRAGGING a line from one node to another would actually do to the JSON.
//
// The canvas can now draw a connection gesture (render.ts), and the gesture is the easy half. The
// hard half is that "connect A to B" is not one operation. It is at least eight, they are written
// at different keys in different shapes, three of them need a value from the author that has no
// defensible default, one of them silently destroys the delegation that was already there, and
// most feature types cannot take a child at all. A canvas that ran the same edit for all of them
// would be a canvas that quietly changes the world.
//
// SO THIS MODULE ANSWERS, IT DOES NOT ACT. Given a graph and a proposed (from, to) it returns one
// of exactly three things:
//
//   - a PLAN: the edits, the edge kind they produce, what they overwrite, what the author should
//     read before applying them. Operations are idioms.ts's `PlanOperation`, so the bytes land
//     through the same single apply path every other action here uses -- two writers means two
//     chances to rewrite a file somebody has in version control.
//   - an ASK: the connection is legal and this module refuses to guess the one thing it is
//     missing. A weight, a condition, or which of two slots was meant.
//   - a REFUSAL: idioms.ts's `Refusal`, a whole sentence saying why, addressed to the author.
//
// WHY ASKING IS THE POINT, AND NOT A GAP. Each of the three asks below is a value where a
// plausible default is WORSE than a prompt, because the times the default is wrong are silent:
//
//   - A weighted pick's entry is a [feature, weight] pair, and the pair has no absent state --
//     a one-element pair is not a shorter entry, it is a refused file. Worse, a weight means
//     nothing on its own: adding an entry at weight 1 beside a 9 makes it a tenth of the picks,
//     and beside a 1 makes it half. There is no number that is "no change".
//   - A conditional entry's `condition` may be written or left out, and those are DIFFERENT
//     edits with the same eventual behaviour: an absent condition is always-eligible, and so is
//     a written "1.0". The graph contract goes out of its way to keep the two apart, so writing
//     either one on the author's behalf throws away the distinction it preserved.
//   - A tree's log decoration hangs off the trunk variant, and a tree may be written with a
//     fallen trunk, a poplar trunk, or neither. Picking one is picking which trunk the author
//     meant.
//
// WHERE THE PER-TYPE TABLE COMES FROM. Not from a list invented here: every entry below is the
// key the ENGINE reads for that type, and test/graphConnect.test.ts checks the whole table
// against the engine's own delegation tables in Go, so a type that gains or loses a child slot
// fails this module's tests rather than silently getting the wrong edit. The eight edge kinds are
// the frozen graph contract; the keys are what produces them.
//
// EVERYTHING USER-VISIBLE SAYS WHAT THE ENGINE DOES. A reason, a summary or a note here is read
// by a pack author in a tooltip, so it talks about features, keys and what gets placed -- never
// about where any of it was established.
import {
  formatJsonPath,
  isIndexSegment,
  parseJsonPath,
  type EdgeKind,
  type IdiomGraphEdge,
  type IdiomGraphNode,
  type PathSegment,
  type PlanNote,
  type PlanOperation,
  type Refusal,
  type RefusalCode,
} from './idioms.js'
import { localProblems } from './molangHints.js'

// ---------------------------------------------------------------------------
// The graph, narrowed
// ---------------------------------------------------------------------------

/** wire.GraphNode as this module reads it -- idioms.ts's narrowing plus `external`, which marks
 * an unresolved reference the GAME provides rather than one the pack forgot. The two are opposite
 * answers to "may I delegate to this": a name nothing defines is a broken pack, and
 * `minecraft:bush_feature` resolves perfectly well at run time. */
export interface ConnectGraphNode extends IdiomGraphNode {
  readonly external?: boolean | undefined
}

/** The subset of wire.Graph this module reads. A decoded Graph is structurally assignable, as is
 * render.ts's GraphWire. */
export interface ConnectGraph {
  readonly nodes: readonly ConnectGraphNode[]
  readonly edges: readonly IdiomGraphEdge[]
}

const RULE_TYPE_ID = 'minecraft:feature_rule'
/** The key a feature RULE's file is rooted at. Deliberately not the node's TypeID: the graph
 * gives a rule the synthetic singular "minecraft:feature_rule" because it names one rule and not
 * the file's collection, so the root key cannot be rebuilt from it. Only ever used as a fallback
 * -- see bodyPath, which prefers the path an existing edge already reports. */
const RULE_ROOT_KEY = 'minecraft:feature_rules'

// ---------------------------------------------------------------------------
// What each type can hold, and where it writes it
// ---------------------------------------------------------------------------

/** One named single-feature slot: the type holds exactly ONE child here, and connecting a second
 * time overwrites the first.
 *
 * `path` is relative to the type's body (the object under the file's root key), so a rule's
 * slot is two segments deep and everything else's is one. `aliases` are the other spellings the
 * engine reads at the same position, in the order it reads them -- it takes the first one the
 * file actually wrote, so an existing reference is rewritten where it sits and a new one is
 * written under the canonical name. */
export interface SingleSlot {
  readonly kind: EdgeKind
  /** Body-relative segments to the reference string. */
  readonly path: readonly string[]
  readonly aliases?: readonly string[]
  /** Whether the type refuses to load without this reference. */
  readonly required: boolean
  /** Names the slot when there is more than one to choose between. */
  readonly label: string
  /** What the parent does with the child, in the author's terms. */
  readonly doc: string
}

/** One list of children. `entry` is the shape of ONE element, which is what decides whether the
 * author is asked for anything. */
export interface ListSlot {
  readonly kind: EdgeKind
  /** The body-relative key the list is written under. */
  readonly key: string
  readonly entry: 'reference' | 'weighted' | 'conditional'
  /** Whether an entry's position in the list is EXECUTION ORDER. True for exactly one type, and
   * it is the difference between a file that reads differently and a world that generates
   * differently. */
  readonly ordered: boolean
  readonly doc: string
}

/** Every type that holds exactly one feature, and the key it holds it under.
 *
 * The keys are not a family resemblance and cannot be guessed from each other: snap_to_surface
 * reads `feature_to_snap`, surface_relative_threshold reads `feature_to_place` and refuses
 * `places_feature`, and the other three filters read `places_feature`. A file using the wrong
 * spelling does not fail loudly -- the key is dropped unread and the type then fails on the
 * required reference it does not have. */
const SINGLE_SLOTS: Readonly<Record<string, readonly SingleSlot[]>> = {
  [RULE_TYPE_ID]: [
    {
      kind: 'rule',
      path: ['description', 'places_feature'],
      required: true,
      label: 'places_feature',
      doc: 'The one feature this rule places. A rule has exactly one, and it is the point the whole chain hangs from.',
    },
  ],
  'minecraft:scatter_feature': [
    {
      kind: 'scatter',
      path: ['places_feature'],
      required: true,
      label: 'places_feature',
      doc: 'The feature this scatter places, once per iteration, at each point it draws.',
    },
  ],
  'minecraft:snap_to_surface_feature': [
    {
      kind: 'filter',
      path: ['feature_to_snap'],
      required: true,
      label: 'feature_to_snap',
      doc: 'The feature placed at the surface this type finds. Written under `feature_to_snap`; this type does not read `places_feature`.',
    },
  ],
  'minecraft:surface_relative_threshold_feature': [
    {
      kind: 'filter',
      path: ['feature_to_place'],
      required: true,
      label: 'feature_to_place',
      doc: 'The feature placed where the origin is deep enough below the surface. Written under `feature_to_place`; this type does not read `places_feature`.',
    },
  ],
  'minecraft:height_difference_filter_feature': [
    {
      kind: 'filter',
      path: ['places_feature'],
      required: true,
      label: 'places_feature',
      doc: 'The feature placed where the terrain relief is inside the given bounds.',
    },
  ],
  'minecraft:scan_surface': [
    {
      kind: 'filter',
      path: ['places_feature'],
      // The engine reads the first of these three the file wrote. A new reference goes under the
      // first; an existing one is rewritten wherever it already is.
      aliases: ['feature', 'feature_to_scan'],
      required: true,
      label: 'places_feature',
      doc: 'The feature placed on each surface block of the placement volume.',
    },
  ],
  'minecraft:search_feature': [
    {
      kind: 'filter',
      path: ['places_feature'],
      required: true,
      label: 'places_feature',
      doc: 'The feature this type searches a volume for a spot for, stopping after enough successes.',
    },
  ],
  'minecraft:vegetation_patch_feature': [
    {
      kind: 'child',
      path: ['vegetation_feature'],
      required: true,
      label: 'vegetation_feature',
      doc: 'The feature grown on each block of the patch this type lays down.',
    },
  ],
}

/** The two trunk shapes that can carry a log decoration, and the key they carry it under.
 *
 * A tree holds its decoration inside the trunk, not on the body, and only these two trunk shapes
 * have the slot -- so which slot a connection means depends on which trunk the tree is written
 * with. Exactly one trunk key may be present in a file; a tree written with both does not load,
 * which is why both are offered rather than the first one silently taken. */
const TREE_TYPE_ID = 'minecraft:tree_feature'
const TREE_TRUNKS = ['fallen_trunk', 'poplar_trunk'] as const
const TREE_DECORATION_KEY = 'log_decoration_feature'

/** Every type that holds a LIST of children. */
const LIST_SLOTS: Readonly<Record<string, ListSlot>> = {
  'minecraft:aggregate_feature': {
    kind: 'aggregate',
    key: 'features',
    entry: 'reference',
    ordered: false,
    doc: 'Places every entry. The list has an order in the file and that order is not an execution order.',
  },
  'minecraft:sequence_feature': {
    kind: 'sequence',
    key: 'features',
    entry: 'reference',
    ordered: true,
    doc: 'Runs its entries in order, each one from where the last one finished. The position in this list decides what gets generated, not just how the file reads.',
  },
  'minecraft:weighted_random_feature': {
    kind: 'weighted',
    key: 'features',
    entry: 'weighted',
    ordered: false,
    doc: 'Picks exactly ONE entry per placement, by weight.',
  },
  'minecraft:conditional_list': {
    kind: 'conditional',
    key: 'conditional_features',
    entry: 'conditional',
    ordered: false,
    doc: 'Walks its entries and places each one whose condition passes.',
  },
}

/** Every type this module knows holds no feature at all -- it places blocks, carves, or copies a
 * structure, and has no key a delegation could be written at.
 *
 * Listed rather than inferred from "not in the two tables above", so that a type nobody has
 * classified refuses differently from one that is genuinely childless: "this type places blocks
 * itself" is a fact, and "this tool does not know what this type holds" is an admission, and an
 * author needs to be able to tell them apart. */
const NO_CHILD_TYPES: ReadonlySet<string> = new Set([
  'minecraft:ore_feature',
  'minecraft:single_block_feature',
  'minecraft:structure_template_feature',
  'minecraft:partially_exposed_blob_feature',
  'minecraft:sculk_patch_feature',
  'minecraft:growing_plant_feature',
  'minecraft:geode_feature',
  'minecraft:cave_carver_feature',
  'minecraft:nether_cave_carver_feature',
  'minecraft:underwater_cave_carver_feature',
  'minecraft:multiface_feature',
  'minecraft:fossil_feature',
  'minecraft:horizontal_tree_decoration_feature',
  'minecraft:multi_block_feature',
  'minecraft:multipart_block_column_feature',
])

/** Every type id this module has an answer for, so a test can hold it against the engine's own
 * tables and a palette can grey out what cannot be connected. */
export function connectableTypeIds(): string[] {
  return [...Object.keys(SINGLE_SLOTS), TREE_TYPE_ID, ...Object.keys(LIST_SLOTS)].sort()
}

export function childlessTypeIds(): string[] {
  return [...NO_CHILD_TYPES].sort()
}

/** The single slots `node` can actually take, which for a tree depends on what it is written
 * with. Empty means "this type has single slots but this node has none available". */
export function singleSlotsFor(node: ConnectGraphNode): readonly SingleSlot[] {
  if (node.typeId === TREE_TYPE_ID) {
    const slots: SingleSlot[] = []
    for (const trunk of TREE_TRUNKS) {
      const written = node.fields?.[trunk]
      if (typeof written !== 'object' || written === null || Array.isArray(written)) continue
      slots.push({
        kind: 'child',
        path: [trunk, TREE_DECORATION_KEY],
        required: false,
        label: `${trunk}.${TREE_DECORATION_KEY}`,
        doc: `The feature placed along the logs of this tree's ${trunk.replace('_', ' ')}. Optional -- a trunk without it simply places no decoration.`,
      })
    }
    return slots
  }
  return SINGLE_SLOTS[node.typeId ?? ''] ?? []
}

export function listSlotFor(node: ConnectGraphNode): ListSlot | undefined {
  return LIST_SLOTS[node.typeId ?? '']
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** The codes idioms.ts already names, plus the two situations none of them describes.
 *
 * `Refusal` itself is reused verbatim for everything else, because a refusal's whole user-visible
 * product is its `reason` and a host that renders one renders both. The two additions are
 * genuinely new: every code in idioms.ts describes an action over an existing graph, and neither
 * "this type holds no feature" nor "this tool has never heard of this type" is one of them. They
 * are kept apart from each other on purpose -- the first is a fact about the format the author
 * can act on, the second is this tool admitting a gap. */
export type ConnectRefusalCode = RefusalCode | 'no-delegation' | 'unknown-type'

export interface ConnectRefusal extends Omit<Refusal, 'code'> {
  readonly code: ConnectRefusalCode
}

/** The delegation an edit overwrites. Present only when the edit overwrites one. */
export interface ConnectReplacement {
  readonly to: string
  readonly kind: EdgeKind
  readonly jsonPath: string
}

export interface ConnectPlan {
  readonly from: string
  readonly to: string
  /** The edge kind the connection becomes. */
  readonly kind: EdgeKind
  /** One line, imperative -- an undo entry or a confirmation button. */
  readonly title: string
  /** A few sentences: what changes, and what it does to what gets generated. */
  readonly summary: string
  /** Where the reference lands, in the same dialect wire.GraphEdge.JSONPath uses. */
  readonly jsonPath: string
  readonly operations: readonly PlanOperation[]
  readonly files: readonly string[]
  readonly notes: readonly PlanNote[]
  /** What this edit overwrites. A single slot holds one feature, so connecting a second one is a
   * REPLACEMENT, and it is the one outcome of this gesture an author can lose work to. */
  readonly replaces?: ConnectReplacement
  /** Whether applying destroys or reorders something that was already there. A host must put
   * `summary` in front of the author before applying a plan with this set. */
  readonly destructive: boolean
}

/** The values a connection needs and will not guess. */
export type ConnectInputKey = 'weight' | 'condition' | 'slot'

export interface ConnectSlotOption {
  /** Pass back as `inputs.slot`. */
  readonly slot: string
  readonly label: string
  readonly doc: string
  /** Whether this slot already holds a feature, and which. */
  readonly occupiedBy?: string
}

export interface ConnectWeightSibling {
  readonly to: string
  /** What the engine will roll with. */
  readonly weight: number
  /** Whether the file actually wrote that number, or the engine is supplying its own default. */
  readonly written: boolean
}

export type ConnectQuestion =
  | {
      readonly input: 'weight'
      readonly prompt: string
      readonly detail: string
      /** The entries the new one competes with, so a number can be chosen against something. */
      readonly siblings: readonly ConnectWeightSibling[]
    }
  | {
      readonly input: 'condition'
      readonly prompt: string
      readonly detail: string
    }
  | {
      readonly input: 'slot'
      readonly prompt: string
      readonly detail: string
      readonly options: readonly ConnectSlotOption[]
    }

export interface ConnectAsk {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
  readonly title: string
  readonly summary: string
  readonly questions: readonly ConnectQuestion[]
}

export type ConnectResult =
  | { readonly outcome: 'plan'; readonly plan: ConnectPlan }
  | { readonly outcome: 'ask'; readonly ask: ConnectAsk }
  | { readonly outcome: 'refuse'; readonly refusal: ConnectRefusal }

export type ConnectCondition = { readonly kind: 'always' } | { readonly kind: 'molang'; readonly expression: string }

export interface ConnectInputs {
  /** weighted only. No default: see this file's header. */
  readonly weight?: number | undefined
  /** conditional only. `always` writes no `condition` key at all, which is not the same edit as
   * writing a constant that is always true. */
  readonly condition?: ConnectCondition | undefined
  /** Which single slot was meant, as a `ConnectSlotOption.slot`. Only asked for when a type has
   * more than one available. */
  readonly slot?: string | undefined
  /** Where in a list the entry lands. Omitted appends. Only aggregate and sequence accept a
   * position other than the end -- see planListConnection. */
  readonly index?: number | undefined
}

export interface ConnectRequest {
  readonly from: string
  readonly to: string
  readonly inputs?: ConnectInputs | undefined
}

function refuse(code: ConnectRefusalCode, reason: string, nodes?: readonly string[]): ConnectResult {
  return { outcome: 'refuse', refusal: nodes === undefined ? { code, reason } : { code, reason, nodes } }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The path of a node's BODY -- the object under its file's root key.
 *
 * Taken from an edge the node already reports wherever there is one, because the producer has
 * already spelled it and a prefix of a real path cannot be wrong. The fallback matters, though:
 * a node with a slot and nothing in it has no edge to read, and that is exactly the node a first
 * connection is being dragged from. For a feature the root key IS the type id, which is how every
 * feature file in the format is shaped; for a rule it is not -- the graph gives a rule a
 * synthetic singular type id precisely because the file is rooted at the plural collection key. */
function bodyPath(graph: ConnectGraph, node: ConnectGraphNode): string | null {
  for (const edge of graph.edges) {
    if (edge.from !== node.id) continue
    const segments = parseJsonPath(edge.jsonPath)
    if (segments === null || segments.length < 2) continue
    const root = segments[0]!
    if (isIndexSegment(root)) continue
    return formatJsonPath([root])
  }
  if (node.typeId === RULE_TYPE_ID) return formatJsonPath([{ key: RULE_ROOT_KEY }])
  if (node.typeId !== undefined && node.typeId !== '') return formatJsonPath([{ key: node.typeId }])
  return null
}

function joinPath(body: string, segments: readonly (string | number)[]): string {
  const parsed = parseJsonPath(body) ?? []
  const all: PathSegment[] = [...parsed]
  for (const segment of segments) all.push(typeof segment === 'number' ? { index: segment } : { key: segment })
  return formatJsonPath(all)
}

function setOperation(file: string, path: string, value: unknown): PlanOperation {
  // `json` is the authority and `value` is there for a caller that wants to assert on the change
  // without re-parsing -- the same split idioms.ts makes, for the same reason: re-serialising on
  // the far side would hand key order to a marshaller that sorts.
  return { op: 'set', file, path, json: JSON.stringify(value), value }
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

function nodeById(graph: ConnectGraph, id: string): ConnectGraphNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}

function edgesFrom(graph: ConnectGraph, id: string): IdiomGraphEdge[] {
  return graph.edges.filter((e) => e.from === id)
}

/** Whether `from` is reachable from `to`, i.e. whether adding this delegation closes a loop.
 *
 * Flat BFS with a visited set, so an input that ALREADY contains a cycle costs the same as one
 * that does not -- the graph contract is explicit that a consumer must not assume a tree, and a
 * recursive walk here would hang on exactly the packs this most needs to answer for. */
function reaches(graph: ConnectGraph, start: string, target: string): boolean {
  if (start === target) return true
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from)
    if (list === undefined) adjacency.set(edge.from, [edge.to])
    else list.push(edge.to)
  }
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of adjacency.get(id) ?? []) {
      if (next === target) return true
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** What dragging a connection from `from` to `to` would do.
 *
 * Pure: nothing is read from disk, nothing is written, and the returned plan is a description
 * a caller hands to the single apply path. Call it as often as you like -- render.ts calls it
 * on every pointer move to decide what the line under the cursor should look like. */
export function planConnection(graph: ConnectGraph, request: ConnectRequest): ConnectResult {
  const inputs = request.inputs ?? {}
  const source = nodeById(graph, request.from)
  // THE SOURCE IS CHECKED FIRST, AND COMPLETELY, before anything is asked about the target. A
  // feature that places blocks itself cannot hold a child whatever is dropped on it, and being
  // told about the target instead ("nothing can delegate to a rule") answers a question the
  // author did not ask.
  const sourceProblem = sourceRefusal(source, request.from) ?? slotRefusal(source)
  if (sourceProblem !== null) return { outcome: 'refuse', refusal: sourceProblem }
  // sourceRefusal returns non-null for an absent node, so this cannot be undefined here. Bound
  // to a name the compiler can narrow rather than asserted at each of the six uses below.
  if (source === undefined) return refuse('unknown-node', `"${request.from}" is not in this graph.`, [request.from])

  const target = nodeById(graph, request.to)
  if (target === undefined) {
    return refuse('unknown-node', `"${request.to}" is not in this graph.`, [request.to])
  }
  if (target.typeId === RULE_TYPE_ID) {
    return refuse(
      'node-is-rule',
      `"${target.id}" is a feature RULE, not a feature. Nothing in the format can delegate to a rule -- a rule is where a chain starts, not something another feature places.`,
      [target.id],
    )
  }
  if (target.unresolved === true && target.external !== true) {
    return refuse(
      'unresolved-node',
      `"${target.id}" is a name nothing in this pack defines. Delegating to it would add a second broken reference rather than fix the first.`,
      [target.id],
    )
  }
  if (source.id === target.id) {
    return refuse(
      'cycle',
      `"${source.id}" cannot place itself. The engine's recursion guard stops the loop at run time, so the feature would place nothing and report nothing.`,
      [source.id],
    )
  }

  const listSlot = listSlotFor(source)
  if (listSlot !== undefined) return planListConnection(graph, source, target, listSlot, inputs)
  return planSingleConnection(graph, source, target, singleSlotsFor(source), inputs)
}

/** Everything wrong with the node a connection is being dragged FROM, before any target is
 * involved: it is not here, it is not ours to edit, or it reports no file to write into. */
function sourceRefusal(source: ConnectGraphNode | undefined, id: string): ConnectRefusal | null {
  if (source === undefined) {
    return { code: 'unknown-node', reason: `"${id}" is not in this graph, so there is nothing to add a delegation to.`, nodes: [id] }
  }
  if (source.external === true) {
    return {
      code: 'unresolved-node',
      reason: `"${source.id}" is provided by the game rather than by this pack. There is no file here to write a delegation into.`,
      nodes: [source.id],
    }
  }
  if (source.unresolved === true) {
    return {
      code: 'unresolved-node',
      reason: `"${source.id}" is a dangling reference -- something delegates to it and no file defines it. There is nothing here to add a child to.`,
      nodes: [source.id],
    }
  }
  if (source.file === undefined || source.file === '') {
    return {
      code: 'unresolved-node',
      reason: `"${source.id}" does not report a file, so a delegation cannot be written anywhere.`,
      nodes: [source.id],
    }
  }
  return null
}

/** Whether this node's TYPE holds another feature anywhere. The three answers are kept apart on
 * purpose: it does; it does not, and that is a fact about the format; and this tool does not
 * know, which is an admission and not the same thing. */
function slotRefusal(source: ConnectGraphNode | undefined): ConnectRefusal | null {
  if (source === undefined) return null
  if (listSlotFor(source) !== undefined) return null
  if (singleSlotsFor(source).length > 0) return null
  if (source.typeId === TREE_TYPE_ID) {
    return {
      code: 'no-delegation',
      reason:
        `${source.id} is a tree, and the only feature a tree holds is the decoration placed along a fallen or poplar trunk's logs. ` +
        'This one is written with neither of those trunk shapes, so there is nowhere for a delegation to go. Give it a `fallen_trunk` or a `poplar_trunk` first.',
      nodes: [source.id],
    }
  }
  if (source.typeId !== undefined && NO_CHILD_TYPES.has(source.typeId)) {
    return {
      code: 'no-delegation',
      reason:
        `${source.id} is a ${short(source.typeId)}, which places what it places itself and holds no other feature. ` +
        'To put something above it, wrap it -- a scatter, a filter, a weighted pick or a conditional list can all hold a feature.',
      nodes: [source.id],
    }
  }
  return {
    code: 'unknown-type',
    reason:
      `this tool does not know whether ${short(source.typeId ?? '(no type)')} can hold another feature, so it will not write a key into ${source.id} and hope. ` +
      'Add the reference in the file itself if the type takes one.',
    nodes: [source.id],
  }
}

/** A type id without the `minecraft:` prefix, which is on every one of them and carries nothing. */
function short(typeId: string): string {
  return typeId.startsWith('minecraft:') ? typeId.slice('minecraft:'.length) : typeId
}

// ---------------------------------------------------------------------------
// Single-slot types
// ---------------------------------------------------------------------------

function planSingleConnection(
  graph: ConnectGraph,
  source: ConnectGraphNode,
  target: ConnectGraphNode,
  slots: readonly SingleSlot[],
  inputs: ConnectInputs,
): ConnectResult {
  const outgoing = edgesFrom(graph, source.id)
  const slotKey = (slot: SingleSlot): string => slot.path.join('.')

  // Which slot is already holding what. An existing edge is matched to a slot by the KEY it was
  // written under rather than by position, so a spelling the file chose from a type's aliases
  // (scan_surface reads three) is recognised as filling that slot.
  const occupant = new Map<string, IdiomGraphEdge>()
  for (const slot of slots) {
    const spellings = new Set<string>([slot.path[slot.path.length - 1]!, ...(slot.aliases ?? [])])
    const found = outgoing.find((edge) => {
      const segments = parseJsonPath(edge.jsonPath)
      if (segments === null || segments.length === 0) return false
      const last = segments[segments.length - 1]!
      if (isIndexSegment(last)) return false
      if (!spellings.has(last.key)) return false
      // A slot nested under a parent (a rule's `description`, a tree's trunk) must match that
      // parent too, or a tree's two trunks would both claim the first decoration they see.
      if (slot.path.length < 2) return true
      const parent = segments[segments.length - 2]
      return parent !== undefined && !isIndexSegment(parent) && parent.key === slot.path[slot.path.length - 2]
    })
    if (found !== undefined) occupant.set(slotKey(slot), found)
  }

  // A delegation this node already has, of a kind one of these slots produces, that could not be
  // matched to any of them by the key it was written under. Refusing is the only safe answer:
  // the slot LOOKS empty, so a connection would write the canonical key and leave whatever is
  // actually there beside it -- two references where the type reads one, with the engine taking
  // whichever it reads first. A path this cannot read is a path it must not write around.
  const slotKinds = new Set(slots.map((s) => s.kind))
  const matched = new Set([...occupant.values()])
  const stray = outgoing.find((e) => slotKinds.has(e.kind as EdgeKind) && !matched.has(e))
  if (stray !== undefined) {
    return refuse(
      'path-shape',
      `${source.id} already delegates to ${stray.to} at "${stray.jsonPath}", and that is not a place this recognises as one of its ` +
        `${slots.length === 1 ? 'slot' : 'slots'} (${slots.map((s) => s.label).join(', ')}). Writing a second reference beside it would leave the file with two, ` +
        'so nothing is planned. Change it where it is written.',
      [source.id],
    )
  }

  let slot: SingleSlot | undefined
  if (slots.length === 1) {
    slot = slots[0]
  } else if (inputs.slot !== undefined) {
    slot = slots.find((s) => slotKey(s) === inputs.slot)
    if (slot === undefined) {
      return refuse(
        'params-malformed',
        `"${inputs.slot}" is not one of the slots ${source.id} has (${slots.map(slotKey).join(', ')}).`,
        [source.id],
      )
    }
  } else {
    // MORE THAN ONE SLOT AND NO ANSWER. This is the ask the header argues for: a tree written
    // with two trunk shapes has two places a decoration could go, they do different things, and
    // taking the first one would be right about half the time and silent the other half.
    return {
      outcome: 'ask',
      ask: {
        from: source.id,
        to: target.id,
        kind: slots[0]!.kind,
        title: `Which part of ${source.id} places ${target.id}?`,
        summary: `${source.id} has ${slots.length} slots that hold one feature each, and they do different things. Pick the one you meant.`,
        questions: [
          {
            input: 'slot',
            prompt: 'Place it under',
            detail: 'Each of these holds one feature. Connecting fills the one you pick and leaves the others alone.',
            options: slots.map((s) => {
              const held = occupant.get(slotKey(s))
              const option: ConnectSlotOption = held === undefined
                ? { slot: slotKey(s), label: s.label, doc: s.doc }
                : { slot: slotKey(s), label: s.label, doc: s.doc, occupiedBy: held.to }
              return option
            }),
          },
        ],
      },
    }
  }

  if (slot === undefined) {
    // Unreachable: slotRefusal has already refused a source with no slots, and each branch above
    // either assigns one or returns. Stated rather than asserted, so a later branch that forgets
    // to assign refuses instead of writing a delegation at an undefined key.
    return refuse('no-delegation', `${source.id} has no slot that holds one feature.`, [source.id])
  }
  const held = occupant.get(slotKey(slot))
  if (held !== undefined && held.to === target.id) {
    return refuse(
      'duplicate-entry',
      `${source.id} already places ${target.id} here. This connection already exists, so there is nothing to change.`,
      [source.id, target.id],
    )
  }

  const body = bodyPath(graph, source)
  if (body === null) {
    return refuse(
      'path-shape',
      `${source.id} reports no type, so this cannot tell which key its file is written under and will not guess at one.`,
      [source.id],
    )
  }

  // An occupied slot is rewritten WHERE IT SITS, not at the canonical key: a file that wrote one
  // of a type's alternative spellings keeps it, and a file that wrote the canonical one keeps
  // that. Writing the canonical key beside an existing alternative would leave two keys, the
  // engine would read whichever it reads first, and the edit might change nothing at all.
  const path = held !== undefined ? held.jsonPath : joinPath(body, slot.path)
  const notes: PlanNote[] = []
  const operations: PlanOperation[] = [setOperation(source.file!, path, target.id)]

  if (held !== undefined) {
    notes.push({
      level: 'warning',
      message:
        `${source.id} holds exactly one feature here, so ${held.to} is REPLACED, not joined. ` +
        `Nothing will place ${held.to} through ${source.id} any more.`,
    })
  } else if (slot.required) {
    notes.push({
      level: 'info',
      message: `${source.id} cannot load without this reference, and had none. This fills it.`,
    })
  }
  if (held === undefined && (slot.aliases?.length ?? 0) > 0) {
    notes.push({
      level: 'info',
      message:
        `Written under \`${slot.path[slot.path.length - 1]}\`. This type also reads ` +
        `${(slot.aliases ?? []).map((a) => `\`${a}\``).join(' and ')}, and takes whichever it finds first; the file uses none of them yet.`,
    })
  }
  addSharedNotes(graph, source, target, notes)

  const replacement: ConnectReplacement | undefined =
    held === undefined ? undefined : { to: held.to, kind: (held.kind as EdgeKind) ?? slot.kind, jsonPath: held.jsonPath }

  return {
    outcome: 'plan',
    plan: {
      from: source.id,
      to: target.id,
      kind: slot.kind,
      title: held === undefined ? `Place ${target.id} from ${source.id}` : `Replace ${held.to} with ${target.id}`,
      summary:
        (held === undefined
          ? `${source.id} places ${target.id}. ${slot.doc}`
          : `${source.id} places ${target.id} instead of ${held.to}. ${slot.doc} It holds one feature, so the old reference is gone.`),
      jsonPath: path,
      operations,
      files: [source.file!],
      notes,
      ...(replacement === undefined ? {} : { replaces: replacement }),
      destructive: held !== undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// List types
// ---------------------------------------------------------------------------

/** What this module can see of a parent's list: the entries it reports as edges, and the length
 * those entries prove the list has. */
interface ListState {
  /** The parent's entries in the list, sorted by their position in it. */
  readonly entries: readonly IdiomGraphEdge[]
  /** One past the highest position seen, i.e. the index an append lands at. 0 when the graph
   * reports no entries at all, which also means the list may not exist in the file yet. */
  readonly length: number
  /** Whether every position from 0 to length-1 is accounted for by exactly one readable entry.
   * False means the file holds something in this list this tool could not read, and a plan that
   * rewrites the whole list would drop it. */
  readonly complete: boolean
}

function readList(graph: ConnectGraph, source: ConnectGraphNode, slot: ListSlot): ListState {
  const entries = edgesFrom(graph, source.id)
    .filter((e) => e.kind === slot.kind)
    .slice()
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
  let length = 0
  const seen = new Set<number>()
  let duplicated = false
  for (const edge of entries) {
    const ordinal = edge.ordinal ?? 0
    if (seen.has(ordinal)) duplicated = true
    seen.add(ordinal)
    length = Math.max(length, ordinal + 1)
  }
  return { entries, length, complete: !duplicated && seen.size === length }
}

function planListConnection(
  graph: ConnectGraph,
  source: ConnectGraphNode,
  target: ConnectGraphNode,
  slot: ListSlot,
  inputs: ConnectInputs,
): ConnectResult {
  const state = readList(graph, source, slot)
  const body = bodyPath(graph, source)
  if (body === null) {
    return refuse(
      'path-shape',
      `${source.id} reports no type, so this cannot tell which key its file is written under and will not guess at one.`,
      [source.id],
    )
  }

  const index = inputs.index ?? state.length
  if (!Number.isInteger(index) || index < 0 || index > state.length) {
    return refuse(
      'params-malformed',
      `position ${String(inputs.index)} is not a place in ${source.id}'s list, which has ${state.length} ${state.length === 1 ? 'entry' : 'entries'}. ` +
        `Positions run from 0 to ${state.length}, where ${state.length} adds one at the end.`,
      [source.id],
    )
  }

  // The value of ONE entry, which is where the two asks live.
  const built = buildListEntry(graph, source, target, slot, state, inputs)
  if ('outcome' in built) return built

  const notes: PlanNote[] = [...built.notes]
  const duplicate = state.entries.filter((e) => e.to === target.id)
  if (duplicate.length > 0) {
    notes.push({
      level: 'warning',
      message:
        `${source.id} already lists ${target.id} ${duplicate.length === 1 ? 'once' : `${duplicate.length} times`}. ` +
        (slot.kind === 'weighted'
          ? 'A second entry for the same feature is legal and adds its weight to the same outcome.'
          : 'A second entry places it a second time.'),
    })
  }

  const operations: PlanOperation[] = []
  let jsonPath: string
  let destructive = false

  if (index === state.length && state.length > 0) {
    // The ordinary case: one new element at the end of a list that exists.
    jsonPath = joinPath(body, [slot.key, index])
    operations.push(setOperation(source.file!, jsonPath, built.value))
  } else if (state.length === 0) {
    // Nothing readable in the list, so this cannot append into it -- the whole key is written
    // instead, which also creates it when the file has none. The warning is the honest half: if
    // the file holds entries this tool could not read, they are inside the value being replaced.
    jsonPath = joinPath(body, [slot.key, 0])
    operations.push(setOperation(source.file!, joinPath(body, [slot.key]), [built.value]))
    notes.push({
      level: 'warning',
      message:
        `${source.id} reports no entries in \`${slot.key}\`, so the whole list is written with this one entry in it. ` +
        `If the file has entries here that could not be read, they are replaced.`,
    })
  } else {
    // A position in the MIDDLE. jsonc can insert only at the end of an array, so this rewrites
    // the list -- which is only safe where every entry is a plain reference this module can put
    // back byte for byte.
    if (slot.entry !== 'reference') {
      return refuse(
        'path-shape',
        `an entry of ${source.id}'s list carries more than the feature it names, and inserting before the end would mean rewriting every entry from what this can see of it. ` +
          'Add it at the end instead, and move it in the file.',
        [source.id],
      )
    }
    if (!state.complete) {
      return refuse(
        'path-shape',
        `${source.id}'s list has ${state.length} positions and this can read ${state.entries.length} of them, so rewriting it to insert at position ${index} could drop what it cannot see. ` +
          'Add it at the end instead.',
        [source.id],
      )
    }
    const rebuilt = state.entries.map((e) => e.to)
    rebuilt.splice(index, 0, target.id)
    jsonPath = joinPath(body, [slot.key, index])
    operations.push(setOperation(source.file!, joinPath(body, [slot.key]), rebuilt))
    destructive = true
    notes.push({
      level: 'warning',
      message:
        `Inserting before the end rewrites all ${rebuilt.length} entries of \`${slot.key}\`, because a list can only be added to at its end. ` +
        'Anything written inside those entries other than the feature names is not preserved.',
    })
  }

  if (slot.ordered) {
    const total = Math.max(state.length + 1, index + 1)
    const before = index > 0 ? state.entries.find((e) => (e.ordinal ?? 0) === index - 1)?.to : undefined
    notes.push({
      level: 'info',
      message:
        `Runs step ${index + 1} of ${total}${before === undefined ? ' -- first' : `, after ${before}`}. ` +
        'In a sequence the position is execution order: each step starts from where the last one finished, so moving an entry changes what gets generated.',
    })
  } else if (index !== state.length) {
    notes.push({
      level: 'info',
      message: `Position ${index} of ${state.length + 1} in the file. This type's list has no execution order, so the position changes how the file reads and not what is placed.`,
    })
  }
  addSharedNotes(graph, source, target, notes)

  return {
    outcome: 'plan',
    plan: {
      from: source.id,
      to: target.id,
      kind: slot.kind,
      title: `Add ${target.id} to ${source.id}`,
      summary: `${source.id} gains ${target.id} as ${built.described}. ${slot.doc}`,
      jsonPath,
      operations,
      files: [source.file!],
      notes,
      destructive,
    },
  }
}

interface BuiltEntry {
  readonly value: unknown
  /** Names the entry in a summary: "its 3rd entry", "an entry at weight 5". */
  readonly described: string
  readonly notes: readonly PlanNote[]
}

function buildListEntry(
  graph: ConnectGraph,
  source: ConnectGraphNode,
  target: ConnectGraphNode,
  slot: ListSlot,
  state: ListState,
  inputs: ConnectInputs,
): BuiltEntry | ConnectResult {
  if (slot.entry === 'reference') {
    return { value: target.id, described: 'an entry', notes: [] }
  }

  if (slot.entry === 'weighted') {
    const siblings: ConnectWeightSibling[] = state.entries.map((e) => ({
      to: e.to,
      weight: typeof e.weight === 'number' ? e.weight : 1,
      written: typeof e.weight === 'number',
    }))
    if (inputs.weight === undefined) {
      const total = siblings.reduce((sum, s) => sum + s.weight, 0)
      return {
        outcome: 'ask',
        ask: {
          from: source.id,
          to: target.id,
          kind: slot.kind,
          title: `What weight should ${target.id} have in ${source.id}?`,
          summary: `${source.id} picks exactly one of its entries per placement, by weight. A new entry needs a number, and there is no number that leaves the others alone.`,
          questions: [
            {
              input: 'weight',
              prompt: 'Weight',
              detail:
                siblings.length === 0
                  ? 'This will be the only entry, so it is picked every time whatever number it carries. An entry is written as a [feature, weight] pair and there is no pair without a weight.'
                  : `A weight is only a chance next to its siblings, which currently total ${formatNumber(total)}. ` +
                    `Adding a ${formatNumber(1)} here would make this ${percent(1 / (total + 1))} of picks and shrink every other entry by the same amount.`,
              siblings,
            },
          ],
        },
      }
    }
    if (!Number.isFinite(inputs.weight) || inputs.weight < 0) {
      return refuse(
        'params-malformed',
        `a weight must be a number of zero or more; the engine refuses a negative one. "${String(inputs.weight)}" is not one.`,
        [source.id],
      )
    }
    const weight = inputs.weight
    const notes: PlanNote[] = []
    const total = siblings.reduce((sum, s) => sum + s.weight, 0) + weight
    if (weight === 0) {
      notes.push({
        level: 'warning',
        message: `Weight 0 is never picked. The entry loads and ${target.id} is never placed through ${source.id}.`,
      })
    } else if (total > 0) {
      notes.push({
        level: 'info',
        message:
          `${target.id} takes ${percent(weight / total)} of picks` +
          (siblings.length === 0
            ? ' -- it is the only entry, so it is picked every time.'
            : `, and every entry that was there drops to ${percent(1 - weight / total)} of what it had.`),
      })
    }
    const spelling = weightedSpelling(state)
    if (spelling.key === null) {
      return { value: [target.id, weight], described: `a pick at weight ${formatNumber(weight)}`, notes }
    }
    notes.push({
      level: 'info',
      message: `Written in the same shape as the entries beside it -- an object with \`${spelling.key}\` and \`weight\`.`,
    })
    return {
      value: { [spelling.key]: target.id, weight },
      described: `a pick at weight ${formatNumber(weight)}`,
      notes,
    }
  }

  // conditional
  if (inputs.condition === undefined) {
    return {
      outcome: 'ask',
      ask: {
        from: source.id,
        to: target.id,
        kind: slot.kind,
        title: `When should ${source.id} place ${target.id}?`,
        summary:
          `Each entry of this list carries a condition, and an entry with NO condition is always eligible. ` +
          'Leaving the key out and writing a constant that is always true behave the same way and are different edits, so this will not pick one for you.',
        questions: [
          {
            input: 'condition',
            prompt: 'Condition',
            detail:
              'Either write a Molang expression -- the entry is placed wherever it is true -- or choose to write no condition at all, which places it every time the list runs.',
          },
        ],
      },
    }
  }
  if (inputs.condition.kind === 'always') {
    return {
      value: { places_feature: target.id },
      described: 'an entry with no condition, so it is placed every time the list runs',
      notes: [
        {
          level: 'info',
          message: 'No `condition` key is written. The entry is always eligible, and the file says so by saying nothing.',
        },
      ],
    }
  }
  const expression = inputs.condition.expression.trim()
  if (expression === '') {
    return refuse(
      'params-malformed',
      'a condition cannot be empty. Write an expression, or choose to write no condition at all -- those are different things and an empty string is neither.',
      [source.id],
    )
  }
  const notes: PlanNote[] = []
  for (const problem of localProblems(expression, 'condition')) {
    notes.push({ level: problem.severity === 'info' ? 'info' : 'warning', message: problem.message })
  }
  return { value: { places_feature: target.id, condition: expression }, described: `an entry conditional on \`${expression}\``, notes }
}

/** Which spelling a weighted list's existing entries use, so a new one matches its neighbours.
 *
 * The `[feature, weight]` pair is the shape the format's own files use and is what a list with
 * nothing in it gets (`key: null`). The object spelling is read too, under either of two key
 * names, and a file that uses it should not end up with one entry of each shape. */
function weightedSpelling(state: ListState): { key: 'feature' | 'places_feature' | null } {
  // The LAST entry rather than the first: a new one lands beside it.
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const segments = parseJsonPath(state.entries[i]!.jsonPath)
    if (segments === null || segments.length === 0) continue
    const last = segments[segments.length - 1]!
    if (isIndexSegment(last)) continue
    if (last.key === 'feature' || last.key === 'places_feature') return { key: last.key }
  }
  return { key: null }
}

/** The notes that are about the pair rather than about the slot: a cycle being closed, and a
 * target the game provides rather than this pack. */
function addSharedNotes(graph: ConnectGraph, source: ConnectGraphNode, target: ConnectGraphNode, notes: PlanNote[]): void {
  if (target.external === true) {
    notes.push({
      level: 'info',
      message:
        `${target.id} is provided by the game, not by this pack. It resolves when the world generates; nothing appears for it in a preview here, ` +
        'because this tool does not simulate the features the game supplies.',
    })
  }
  if (reaches(graph, target.id, source.id)) {
    notes.push({
      level: 'warning',
      message:
        `This closes a loop: ${target.id} already leads back to ${source.id}. Loops are legal and the engine stops the recursion at run time, ` +
        'but a feature inside one places less than it looks like it should.',
    })
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

function percent(fraction: number): string {
  const value = fraction * 100
  return `${value.toFixed(value < 10 ? 1 : 0)}%`
}

// ---------------------------------------------------------------------------
// The cheap question, for a gesture in flight
// ---------------------------------------------------------------------------

/** What a drop would do, in the few words a label following the pointer can hold.
 *
 * The same code path as planConnection, deliberately -- a preview that answered "legal" through
 * different reasoning than the apply would be a preview that lies at exactly the moment it
 * matters. `asks` is what makes an ask visible BEFORE the drop rather than as a surprise form
 * afterwards. */
export interface ConnectPreview {
  readonly allowed: boolean
  readonly kind?: EdgeKind | undefined
  /** Three or four words, for a chip at the pointer. */
  readonly label: string
  /** One sentence: what it will do, or why it will not. */
  readonly detail: string
  /** Values the author will be asked for on the drop. */
  readonly asks: readonly ConnectInputKey[]
  /** The delegation the drop would overwrite. */
  readonly replaces?: string | undefined
}

export function previewConnection(graph: ConnectGraph, from: string, to: string): ConnectPreview {
  const result = planConnection(graph, { from, to })
  if (result.outcome === 'refuse') {
    return { allowed: false, label: 'cannot connect', detail: result.refusal.reason, asks: [] }
  }
  if (result.outcome === 'ask') {
    const asks = result.ask.questions.map((q) => q.input)
    return {
      allowed: true,
      kind: result.ask.kind,
      label: asks.includes('slot') ? 'asks which slot' : asks.includes('weight') ? 'asks for a weight' : 'asks for a condition',
      detail: result.ask.summary,
      asks,
    }
  }
  const plan = result.plan
  const replaced = plan.replaces?.to
  return {
    allowed: true,
    kind: plan.kind,
    label: replaced === undefined ? `${plan.kind} edge` : `replaces ${replaced}`,
    detail: plan.summary,
    asks: [],
    ...(replaced === undefined ? {} : { replaces: replaced }),
  }
}

/** Whether a node can hold ANOTHER feature at all, asked without a target.
 *
 * The gesture needs this before there is anything to drop on: a drag started from a feature that
 * places blocks itself has to say so at the moment it is started, not after the author has hauled
 * a line across the canvas.
 *
 * Exactly the checks planConnection runs before it looks at a target, and no more -- so this is
 * O(1) in the graph's size and can be asked for every card on the canvas without turning a render
 * into a sweep. Anything it cannot see refuses on the drop instead, with the same codes and the
 * same sentences. */
export function connectSourcePreview(graph: ConnectGraph, from: string): ConnectPreview {
  const source = nodeById(graph, from)
  const problem = sourceRefusal(source, from) ?? slotRefusal(source)
  if (problem !== null) return { allowed: false, label: 'cannot connect', detail: problem.reason, asks: [] }
  const list = listSlotFor(source!)
  if (list !== undefined) {
    return { allowed: true, kind: list.kind, label: `add to ${list.key}`, detail: list.doc, asks: [] }
  }
  const slots = singleSlotsFor(source!)
  return {
    allowed: true,
    kind: slots[0]!.kind,
    label: slots.length === 1 ? `set ${slots[0]!.label}` : 'choose a slot',
    detail: slots.length === 1 ? slots[0]!.doc : `${source!.id} has ${slots.length} slots that each hold one feature.`,
    asks: slots.length === 1 ? [] : ['slot'],
  }
}
