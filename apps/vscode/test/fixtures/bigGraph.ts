// bigGraph.ts -- generates a pack-sized graph document, rather than committing one.
//
// WHY A GENERATOR AND NOT A FILE. The document this stands in for -- the graph of a large pack -- is 8.8 MB. Committing it
// would put a 9 MB blob in every clone and every diff of a repository whose entire other
// fixture is 108 KB, and it would freeze one pack's shape into the tree forever. A generator
// costs ~1 s to run, is deterministic (a seeded PRNG, no Math.random anywhere), and takes the
// shape as parameters -- so the same code answers "what does a large pack cost" and "where
// does this fall over", which is the question test/scale.test.ts is actually asking.
//
// WHAT IT IS MODELLED ON. The target shape of a large pack:
//
//     3531 nodes, 4580 edges, 41 roots, 8.8 MB of JSON
//
// plus the qualitative shape of test/fixtures/graph-sample.json (this repo's real `featurelab
// graph` output over the wiki fixture pack), which is where the per-node byte budget, the field
// shapes and the coverage-note prose come from. graph-sample.json is 57 nodes / 108 KB, i.e.
// ~1.9 KB a node, of which 70% is coverageNote and 12% is fields. The target is ~2.5 KB a
// node. Both of those are reproduced here; see FIDELITY at the bottom of this file for an
// honest accounting of what is and is not faithful.
//
// A NOTE ON "hundreds of disconnected components". wire/graphbuild.go computes Roots as every
// node with NO INCOMING EDGE, so a disconnected component contributes at least one root unless
// every node in it sits on a cycle. 41 roots therefore caps such a pack at ~41 weakly
// connected components, not hundreds. The default shape here honours the three measured numbers
// (41 roots => 41 components); MANY_COMPONENT_SHAPE exists separately so the component packer
// can still be measured at the fan-out it was accused of being bad at.

import type { GraphEdgeWire, GraphNodeWire, GraphWire } from '../../src/graph/render.js'

/** The wire carries `external` on a node (wire/graph.go: `External bool`); render.ts's
 * GraphNodeWire does not model it yet. It is emitted anyway -- the fixture's job is to look like
 * what the engine sends, not like what the renderer currently reads. */
export type BigGraphNode = GraphNodeWire & { external?: boolean }

export interface BigGraphShape {
  /** Total nodes, including roots and unresolved stubs. */
  nodes: number
  /** Total edges. Must be >= nodes - roots (every non-root needs one). */
  edges: number
  /** Nodes with no incoming edge. Each seeds one weakly connected component. */
  roots: number
  /** Pad coverage notes until JSON.stringify(graph).length is about this. 0 disables padding. */
  targetBytes: number
  /** Leaf nodes turned into unresolved stubs (no typeId, no file, no fields). */
  unresolved: number
  /** How many of those are game-provided identifiers (`external: true`). */
  external: number
  /** Back edges added from a deep container to one of its ancestors. */
  cycles: number
  /** Deepest layer a generated chain reaches. */
  maxDepth: number
  seed: number
}

/** The target shape of a large pack. */
export const PACK_SHAPE: BigGraphShape = {
  nodes: 3531,
  edges: 4580,
  roots: 41,
  targetBytes: 8_800_000,
  unresolved: 44,
  external: 17,
  cycles: 4,
  maxDepth: 9,
  seed: 0x5eed,
}

/** Same node and edge budget, spread over 400 components instead of 41. Not the default shape --
 * it cannot be, see the note at the top -- but it is the input the shelf packer's 32 candidate
 * widths and its median/outlier pass were written for, and the only way to measure them at
 * something other than the 40-component case their comments cite. */
export const MANY_COMPONENT_SHAPE: BigGraphShape = {
  ...PACK_SHAPE,
  roots: 400,
  edges: 4100,
  cycles: 6,
  seed: 0xc0117,
}

/** One giant component: every node reachable from a single rule. The worst case for the layered
 * half of autoLayout, because component splitting is what keeps each Sugiyama pass small. */
export const ONE_COMPONENT_SHAPE: BigGraphShape = {
  ...PACK_SHAPE,
  roots: 1,
  edges: 4580,
  cycles: 2,
  seed: 0x1b16,
}

// ---------------------------------------------------------------------------
// Types, in the proportions a worldgen pack actually has
// ---------------------------------------------------------------------------

/** A type that can delegate, and the edge kind its delegations carry. Every one of the eight
 * wire EdgeKinds is produced by something in this table, so no renderer branch goes unexercised
 * at scale. */
const CONTAINERS: ReadonlyArray<readonly [type: string, kind: GraphEdgeWire['kind'], weight: number]> = [
  ['minecraft:scatter_feature', 'scatter', 30],
  ['minecraft:aggregate_feature', 'aggregate', 18],
  ['minecraft:weighted_random_feature', 'weighted', 10],
  ['minecraft:conditional_list', 'conditional', 8],
  ['minecraft:sequence_feature', 'sequence', 7],
  ['minecraft:snap_to_surface_feature', 'filter', 7],
  ['minecraft:search_feature', 'filter', 5],
  ['minecraft:surface_relative_threshold_feature', 'filter', 4],
  ['minecraft:height_difference_filter_feature', 'filter', 3],
  ['minecraft:vegetation_patch_feature', 'child', 3],
  ['minecraft:tree_feature', 'child', 3],
  ['minecraft:growing_plant_feature', 'child', 2],
]

/** Types that never delegate. The long tail of a pack: most files are one of these. */
const LEAVES: ReadonlyArray<readonly [type: string, weight: number]> = [
  ['minecraft:single_block_feature', 60],
  ['minecraft:ore_feature', 14],
  ['minecraft:tree_feature', 12],
  ['minecraft:multiface_feature', 6],
  ['minecraft:structure_template_feature', 5],
  ['minecraft:multipart_block_column_feature', 4],
  ['minecraft:multi_block_feature', 4],
  ['minecraft:horizontal_tree_decoration_feature', 3],
  ['minecraft:geode_feature', 3],
  ['minecraft:sculk_patch_feature', 3],
  ['minecraft:fossil_feature', 2],
  ['minecraft:partially_exposed_blob_feature', 2],
  ['minecraft:cave_carver_feature', 2],
  ['minecraft:nether_cave_carver_feature', 1],
  ['minecraft:underwater_cave_carver_feature', 1],
  ['minecraft:scan_surface', 1],
  ['minecraft:growing_plant_feature', 1],
  ['minecraft:vegetation_patch_feature', 1],
]

/** All 27 feature types plus `minecraft:feature_rule`, so a test can assert the fixture really
 * does span the catalogue rather than trusting the two tables above to stay in step with it. */
export const FIXTURE_TYPE_IDS: readonly string[] = [
  'minecraft:feature_rule',
  ...new Set([...CONTAINERS.map(([t]) => t), ...LEAVES.map(([t]) => t)]),
]

const BLOCKS = [
  'minecraft:stone', 'minecraft:deepslate', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:sand',
  'minecraft:oak_log', 'minecraft:spruce_log', 'minecraft:birch_log', 'minecraft:acacia_log',
  'minecraft:oak_leaves', 'minecraft:azalea_leaves', 'minecraft:moss_block', 'minecraft:clay',
  'minecraft:gravel', 'minecraft:packed_ice', 'minecraft:red_sand', 'minecraft:mud', 'minecraft:tuff',
]

const BIOME_TAGS = ['swamp', 'jungle', 'taiga', 'desert', 'mesa', 'ocean', 'mountains', 'plains', 'nether', 'the_end']

const COVERAGES = ['implemented', 'implemented', 'implemented', 'implemented', 'partial', 'out_of_scope'] as const

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

/** mulberry32. Small, fast, and -- the only property that matters here -- the same sequence on
 * every machine and every run, so a budget measured today means the same thing tomorrow. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!
}

function pickWeighted<T extends readonly [unknown, ...unknown[]]>(random: () => number, table: readonly T[], weightAt: number): T {
  let total = 0
  for (const row of table) total += row[weightAt] as number
  let roll = random() * total
  for (const row of table) {
    roll -= row[weightAt] as number
    if (roll <= 0) return row
  }
  return table[table.length - 1]!
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface Built {
  id: string
  typeId: string
  kind: GraphEdgeWire['kind'] | null
  depth: number
  component: number
  childCount: number
}

/**
 * Builds a graph with exactly `shape.nodes` nodes, `shape.edges` edges and `shape.roots` nodes
 * of in-degree zero.
 *
 * The construction is a spanning forest first (one edge per non-root, so the root count is
 * exact by construction and not by luck), then the surplus edges as re-references. That order is
 * deliberate: the surplus is where "many parents share a handful of children" comes from, and
 * keeping it separate means the ratio can be dialled without disturbing anything else.
 */
export function buildBigGraph(shape: Partial<BigGraphShape> = {}): GraphWire {
  const s: BigGraphShape = { ...PACK_SHAPE, ...shape }
  if (s.roots < 1) throw new Error('bigGraph: need at least one root')
  if (s.nodes < s.roots) throw new Error('bigGraph: nodes must be at least roots')
  if (s.edges < s.nodes - s.roots) throw new Error(`bigGraph: ${s.nodes - s.roots} edges are needed just to give every non-root a parent`)

  const random = rng(s.seed)
  const built: Built[] = []
  const nodes: BigGraphNode[] = []
  const edges: GraphEdgeWire[] = []
  const roots: string[] = []

  // Per component: the containers that may still take a child, and the handful of leaves that
  // everything points at. A pack has both -- one shared `pumpkin_patch_block` with nine parents,
  // and a hundred single-use blocks -- and the hubs are what make fan-in non-trivial for the
  // port assignment and the layering.
  const containersOf: number[][] = []
  const hubsOf: number[][] = []

  for (let c = 0; c < s.roots; c++) {
    const id = `pack:rule_${String(c).padStart(4, '0')}`
    built.push({ id, typeId: 'minecraft:feature_rule', kind: 'rule', depth: 0, component: c, childCount: 0 })
    nodes.push(makeNode(id, 'minecraft:feature_rule', random, c))
    roots.push(id)
    containersOf.push([built.length - 1])
    hubsOf.push([])
  }

  // Component sizes. Lumpy on purpose: a pack has a couple of big rules and a long tail of
  // one-feature ones, and a uniform split would hide both the deep-layering cost and the
  // many-tiny-boxes cost that the packer pays.
  const remaining = s.nodes - s.roots
  const weights: number[] = []
  let weightTotal = 0
  for (let c = 0; c < s.roots; c++) {
    const w = Math.pow(random(), 2.2) * 9 + 0.25
    weights.push(w)
    weightTotal += w
  }
  const quota: number[] = []
  let assigned = 0
  for (let c = 0; c < s.roots; c++) {
    const n = Math.floor((weights[c]! / weightTotal) * remaining)
    quota.push(n)
    assigned += n
  }
  for (let c = 0; assigned < remaining; c = (c + 1) % s.roots) {
    quota[c] = quota[c]! + 1
    assigned++
  }

  // 1. The spanning forest: one edge per non-root node.
  for (let c = 0; c < s.roots; c++) {
    for (let k = 0; k < quota[c]!; k++) {
      const parents = containersOf[c]!
      // Bias towards the frontier so components get DEEP rather than star-shaped: the layered
      // algorithm's cost is in the layers, and a two-layer component would measure nothing.
      let parentIndex = parents[parents.length - 1]!
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = random() < 0.6
          ? parents[parents.length - 1 - Math.floor(Math.pow(random(), 2) * Math.min(parents.length, 12))]!
          : pick(random, parents)
        const node = built[candidate]!
        if (node.depth < s.maxDepth && node.childCount < 24) {
          parentIndex = candidate
          break
        }
        parentIndex = parents[0]!
      }
      const parent = built[parentIndex]!
      const container = parent.depth + 1 < s.maxDepth && random() < containerShare(parent.depth, s.maxDepth)
      const id = `pack:${container ? 'group' : 'feature'}_${String(built.length).padStart(4, '0')}`
      let typeId: string
      let kind: GraphEdgeWire['kind'] | null
      if (container) {
        const row = pickWeighted(random, CONTAINERS, 2)
        typeId = row[0]
        kind = row[1]
      } else {
        typeId = pickWeighted(random, LEAVES, 1)[0]
        kind = null
      }
      const child: Built = { id, typeId, kind, depth: parent.depth + 1, component: c, childCount: 0 }
      built.push(child)
      nodes.push(makeNode(id, typeId, random, c))
      edges.push(makeEdge(parent, child, parent.childCount, random))
      parent.childCount++
      if (container) containersOf[c]!.push(built.length - 1)
      else if (hubsOf[c]!.length < 8 && random() < 0.25) hubsOf[c]!.push(built.length - 1)
    }
    if (hubsOf[c]!.length === 0) {
      // Every component gets at least one shared child, or the surplus edges below have nowhere
      // faithful to go in the small components -- which is most of them.
      const leaves = built.filter((b) => b.component === c && b.kind === null)
      if (leaves.length > 0) hubsOf[c]!.push(built.indexOf(leaves[0]!))
    }
  }

  // 2. Deliberate cycles, before the surplus is spent, so they are never squeezed out.
  const cycleGroups: string[][] = []
  for (let i = 0; i < s.cycles && edges.length < s.edges; i++) {
    const c = Math.floor((i + 1) * (s.roots / (s.cycles + 1))) % s.roots
    const deep = [...built].filter((b) => b.component === c && b.kind !== null && b.depth >= 3).sort((a, b) => b.depth - a.depth)[0]
    if (!deep) continue
    const ancestor = built.filter((b) => b.component === c && b.kind !== null && b.depth === 1)[0]
    if (!ancestor || ancestor.id === deep.id) continue
    edges.push(makeEdge(deep, ancestor, deep.childCount++, random))
    cycleGroups.push([ancestor.id, deep.id])
  }

  // 3. The surplus: re-references, mostly at the hubs. This is the "many parents sharing a
  // handful of children" half of the shape, and it is what turns the drawing from a forest into
  // something with real fan-in -- which is what assignPorts and the crossing minimiser cost
  // money on.
  const parallelSeen = new Set<string>()
  let guard = 0
  while (edges.length < s.edges && guard++ < s.edges * 40) {
    const c = Math.floor(random() * s.roots)
    const parents = containersOf[c]!
    const hubs = hubsOf[c]!
    if (parents.length < 2 || hubs.length === 0) continue
    const parent = built[pick(random, parents)]!
    const target = built[random() < 0.82 ? pick(random, hubs) : pick(random, parents)]!
    if (target.id === parent.id) continue
    if (roots.includes(target.id)) continue // a surplus edge into a root would change the root count
    const key = `${parent.id}>${target.id}`
    // At most one duplicate of any pair: parallel edges are real (an aggregate listing the same
    // feature twice) but a pack is not made of them.
    if (parallelSeen.has(key + '#2')) continue
    parallelSeen.add(parallelSeen.has(key) ? key + '#2' : key)
    edges.push(makeEdge(parent, target, parent.childCount++, random))
  }
  if (edges.length !== s.edges) {
    throw new Error(`bigGraph: wanted ${s.edges} edges, produced ${edges.length} -- the shape is not satisfiable`)
  }

  // 4. Unresolved stubs. Chosen from leaves that something points at, which is what an
  // unresolved reference IS: a name in someone's JSON with no file behind it.
  const leafIndices: number[] = []
  for (let i = s.roots; i < built.length; i++) if (built[i]!.kind === null) leafIndices.push(i)
  for (let i = 0; i < Math.min(s.unresolved, leafIndices.length); i++) {
    const at = leafIndices[Math.floor((i * leafIndices.length) / Math.max(1, s.unresolved))]!
    const node = nodes[at]!
    const external = i < s.external
    nodes[at] = external
      ? { id: `minecraft:${node.id.split('_').pop()}_feature_${i}`, unresolved: true, external: true }
      : { id: node.id, unresolved: true }
    if (external) {
      // Re-point every edge that named it, or the stub is orphaned and the root count moves.
      const was = node.id
      const now = nodes[at]!.id
      built[at]!.id = now
      for (const edge of edges) {
        if (edge.from === was) edge.from = now
        if (edge.to === was) edge.to = now
      }
    }
  }

  const graph: GraphWire = { nodes: nodes as GraphNodeWire[], edges, roots, cycles: cycleGroups }
  if (s.targetBytes > 0) padTo(graph, s.targetBytes, rng(s.seed ^ 0x9e37))
  return graph
}

/** How likely a node at `depth` is to be a container. Falls off with depth so chains end rather
 * than running to maxDepth every time, which is what makes the layer histogram lopsided the way
 * a real pack's is (most files are one or two layers down; a few are eight). */
function containerShare(depth: number, maxDepth: number): number {
  return Math.max(0.08, 0.62 - (depth / maxDepth) * 0.5)
}

function makeEdge(parent: Built, child: Built, ordinal: number, random: () => number): GraphEdgeWire {
  const kind = parent.kind ?? 'child'
  const edge: GraphEdgeWire = {
    from: parent.id,
    to: child.id,
    kind,
    jsonPath: jsonPathFor(parent.typeId, kind, ordinal),
    ordinal,
    required: kind === 'rule' || kind === 'filter' || kind === 'child',
  }
  // Only the kinds that carry data carry it, and only sometimes -- the contract's whole point
  // is that "not written" and "written as 1" are different, so a fixture where every weight is
  // present would never exercise the defaulted path.
  if (kind === 'weighted' && random() < 0.78) edge.weight = 1 + Math.floor(random() * 9)
  if (kind === 'conditional' && random() < 0.65) {
    edge.condition = `query.get_biome_has_any_tag('${pick(random, BIOME_TAGS)}') && variable.density > ${(random() * 0.9).toFixed(2)}`
  }
  if (kind === 'scatter') {
    edge.iterations = random() < 0.5 ? String(1 + Math.floor(random() * 96)) : `math.random_integer(1, ${2 + Math.floor(random() * 12)})`
  }
  return edge
}

function jsonPathFor(typeId: string, kind: GraphEdgeWire['kind'], ordinal: number): string {
  switch (kind) {
    case 'rule': return '$.minecraft:feature_rules.description.places_feature'
    case 'aggregate': return `$.${typeId}.features[${ordinal}]`
    case 'sequence': return `$.${typeId}.features[${ordinal}]`
    case 'weighted': return `$.${typeId}.features[${ordinal}][0]`
    case 'conditional': return `$.${typeId}.conditional_features[${ordinal}].places_feature`
    case 'scatter': return `$.${typeId}.places_feature`
    case 'filter': return `$.${typeId}.feature_to_snap`
    case 'child': return `$.${typeId}.${typeId.includes('tree') ? 'log_decoration_feature' : 'vegetation_feature'}`
  }
}

function makeNode(id: string, typeId: string, random: () => number, component: number): BigGraphNode {
  const coverage = pick(random, COVERAGES)
  const node: BigGraphNode = {
    id,
    typeId,
    file: `${typeId === 'minecraft:feature_rule' ? 'feature_rules' : 'features'}/${id.split(':')[1]}.json`,
    formatVersion: pick(random, ['1.13.0', '1.16.0', '1.21.110', '1.21.110', '1.21.110']),
    coverage,
    coverageNote: noteFor(typeId, coverage, random),
    fields: fieldsFor(typeId, id, random, component),
  }
  if (random() < 0.02) {
    node.annotations = [{ name: 'note', text: 'kept for parity with the 1.20 pack', jsonPath: '$', line: 1 + Math.floor(random() * 40) }]
  }
  return node
}

/** The shape of a real `fields` blob: the node's own JSON minus whatever became an edge. Sized
 * from graph-sample.json, where fields run 59..1039 bytes with a median of 190. */
function fieldsFor(typeId: string, id: string, random: () => number, component: number): Record<string, unknown> {
  const description = { identifier: id }
  switch (typeId) {
    case 'minecraft:feature_rule':
      return {
        description: { identifier: id, places_feature: `pack:group_${component}` },
        conditions: {
          placement_pass: pick(random, ['first_pass', 'before_surface_pass', 'surface_pass', 'after_surface_pass', 'underground_pass']),
          'minecraft:biome_filter': [{ any_of: BIOME_TAGS.slice(0, 2 + Math.floor(random() * 4)).map((t) => ({ test: 'has_biome_tag', operator: '==', value: t })) }],
        },
        distribution: {
          iterations: 1 + Math.floor(random() * 32),
          scatter_chance: { numerator: 1, denominator: 2 + Math.floor(random() * 60) },
          x: { distribution: 'uniform', extent: ['0', '16'] },
          y: { distribution: 'uniform', extent: [-64, 320] },
          z: { distribution: 'uniform', extent: ['0', '16'] },
        },
      }
    case 'minecraft:scatter_feature':
      return {
        description,
        iterations: String(1 + Math.floor(random() * 90)),
        project_input_to_floor: random() < 0.4,
        scatter_chance: `${(random() * 100).toFixed(1)}`,
        x: { distribution: 'uniform', extent: [-8, 8] },
        y: { distribution: pick(random, ['uniform', 'gaussian', 'inverse_gaussian']), extent: [-4, 4] },
        z: { distribution: 'uniform', extent: [-8, 8] },
      }
    case 'minecraft:ore_feature':
      return {
        description,
        count: 4 + Math.floor(random() * 28),
        replace_rules: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
          places_block: pick(random, BLOCKS),
          may_replace: [{ name: pick(random, BLOCKS) }, { name: pick(random, BLOCKS) }],
        })),
      }
    case 'minecraft:tree_feature':
      return {
        description,
        base_block: [pick(random, BLOCKS)],
        base_cluster: { may_replace: [{ name: pick(random, BLOCKS) }], num_clusters: 1 + Math.floor(random() * 4), cluster_radius: 1 + Math.floor(random() * 3) },
        may_grow_on: BLOCKS.slice(0, 3 + Math.floor(random() * 5)).map((name) => ({ name })),
        may_replace: BLOCKS.slice(2, 6).map((name) => ({ name })),
        may_grow_through: [{ name: 'minecraft:dirt' }, { name: 'minecraft:grass_block' }],
        acacia_trunk: {
          trunk_width: 1,
          trunk_height: { base: 4 + Math.floor(random() * 4), 'minecraft:random_spread': { range_min: 1, range_max: 4 } },
          trunk_block: pick(random, BLOCKS),
          trunk_lean: { allow_diagonal_growth: true, lean_height: { range_min: 2, range_max: 4 }, lean_steps: { range_min: 2, range_max: 3 }, lean_length: { range_min: 1, range_max: 3 } },
        },
        acacia_canopy: {
          canopy_size: 2 + Math.floor(random() * 4),
          simplify_canopy: random() < 0.5,
          leaf_blocks: [[pick(random, BLOCKS), 3], [pick(random, BLOCKS), 1]],
        },
      }
    case 'minecraft:vegetation_patch_feature':
      return {
        description,
        replaceable_blocks: BLOCKS.slice(0, 6).map((name) => ({ name })),
        ground_block: { name: pick(random, BLOCKS) },
        vegetation_chance: Number(random().toFixed(2)),
        horizontal_radius: 2 + Math.floor(random() * 6),
        extra_deep_block_chance: Number(random().toFixed(2)),
        vertical_range: 2 + Math.floor(random() * 5),
        extra_edge_column_chance: Number(random().toFixed(2)),
        waterlogged: random() < 0.2,
      }
    case 'minecraft:single_block_feature':
      return {
        description,
        places_block: pick(random, BLOCKS),
        enforce_placement_rules: random() < 0.8,
        enforce_survivability_rules: random() < 0.7,
        may_attach_to: {
          min_sides_must_attach: 1 + Math.floor(random() * 3),
          auto_rotate: random() < 0.5,
          top: [{ name: pick(random, BLOCKS) }],
          bottom: [{ name: pick(random, BLOCKS) }],
        },
        may_replace: [{ name: 'minecraft:air' }, { name: 'minecraft:water' }],
      }
    default:
      return {
        description,
        places_block: pick(random, BLOCKS),
        may_replace: BLOCKS.slice(0, 2 + Math.floor(random() * 4)).map((name) => ({ name })),
        search_volume: { min: [-4, -4, -4], max: [4, 4, 4] },
        search_axis: pick(random, ['-y', '+y', '-x', '+x']),
        required_successes: 1 + Math.floor(random() * 4),
      }
  }
}

/** Coverage prose. 70% of graph-sample.json's bytes are these notes, so they are 70% of what a
 * structured clone of a full-size document has to copy -- getting their weight right is most of
 * getting the 8.8 MB right. */
const NOTE_PIECES = [
  'Every documented key of this type is read and placed, including the ones the wiki does not list.',
  'APPROXIMATED: the engine decides this per block type, and this tool uses a fixed list of the blocks vanilla treats that way.',
  'The placement order inside one call is the order the file lists, which is load-bearing for anything that overwrites.',
  'Order is not load-bearing here -- the engine shuffles before placing -- so the drawing deliberately shows no ordinal.',
  'New in 1.26.50.24 and implemented here, along with the two keys that changed meaning in the same build.',
  'Survivability is evaluated against the block below after placement, not before, which is why a column can end one block short.',
  'NOT PORTED: the structure pipeline owns this, and nothing in the placement path can stand in for it.',
  'Weights are normalised across siblings at run time, so an unwritten weight is not the same as a written 1.',
  'The condition is Molang and is evaluated per attempt, not per feature, which is what makes a low chance cheap.',
  'Waterlogging follows the block state rather than the feature, so a waterlogged variant needs no separate entry here.',
]

function noteFor(typeId: string, coverage: string, random: () => number): string {
  const head = coverage === 'partial'
    ? `Partially ported. ${typeId.replace('minecraft:', '')} places, but not every branch of it does.`
    : coverage === 'out_of_scope'
      ? `Out of scope: ${typeId.replace('minecraft:', '')} is handled elsewhere in the pipeline.`
      : `Implemented. ${typeId.replace('minecraft:', '')} is placed exactly as the engine places it.`
  const pieces = [head]
  const count = 2 + Math.floor(random() * 4)
  for (let i = 0; i < count; i++) pieces.push(pick(random, NOTE_PIECES))
  return pieces.join(' ')
}

/** Grows the coverage notes until the document is about `target` bytes.
 *
 * Padding the NOTES rather than adding filler keys, because that is where the real document's
 * bytes are, and because the cost this fixture exists to measure -- a structured clone, a
 * JSON.parse, a webview postMessage -- is paid per byte of string just the same. It does mean
 * the padded tail is repetitive prose; see FIDELITY. */
function padTo(graph: GraphWire, target: number, random: () => number): void {
  const current = JSON.stringify(graph).length
  if (current >= target) return
  const withNotes = graph.nodes.filter((n) => typeof n.coverageNote === 'string')
  if (withNotes.length === 0) return
  const perNode = Math.floor((target - current) / withNotes.length)
  if (perNode <= 0) return
  for (const node of withNotes) {
    let extra = ''
    while (extra.length < perNode) extra += ' ' + pick(random, NOTE_PIECES)
    node.coverageNote = (node.coverageNote ?? '') + extra.slice(0, perNode)
  }
}

// ---------------------------------------------------------------------------
// FIDELITY -- what this is and is not
// ---------------------------------------------------------------------------
//
// FAITHFUL, because it is measured or structural:
//   - node count, edge count, root count, and the resulting ~1.31 average in-degree
//   - document size in bytes, and its split across node metadata / coverage prose / fields /
//     edges, taken from graph-sample.json's own proportions
//   - all 27 feature types plus minecraft:feature_rule, in plausible pack proportions (most
//     files are single_block or ore; scatter dominates the containers)
//   - all 8 edge kinds, with weight/condition/iterations present on some edges and absent on
//     others -- the distinction the wire contract exists to preserve
//   - fan-in: a handful of shared children per component carry most of the surplus edges
//   - unresolved stubs, some of them external (game-provided) identifiers
//   - a few genuine cycles, reported in `cycles` as the engine reports them
//
// APPROXIMATE, and known to be:
//   - COMPONENT COUNT. The default is 41 components because 41 roots forces it (see the header).
//     If a pack truly has hundreds of components, then it has hundreds of roots and the
//     "41 roots" measurement means something else; MANY_COMPONENT_SHAPE covers that case.
//   - DEPTH DISTRIBUTION. Chains here run to at most 9 layers with a falling container share.
//     A real pack's deepest chain is whatever its author wrote; if the pack has a 30-layer
//     wrapper chain, the layered pass will cost more than measured here.
//   - PADDED PROSE. Past the first few sentences the coverage notes repeat. Byte-for-byte that
//     is the same cost to clone, parse and hold; it is NOT the same cost to render, because the
//     renderer only ever shows a note in a title attribute and in the inspector. Nothing in
//     these budgets depends on note CONTENT, only on note SIZE.
//   - NO COMPOUNDS. The fixture carries no `@featurelab:` compound annotations, so
//     buildCompoundView walks a graph with nothing to collapse. A pack that uses compounds
//     heavily would pay more per refresh than measured here, and that is untested.
//   - FIELD REALISM. Field blobs are plausible rather than copied. The renderer does not read
//     them (the inspector does, one node at a time), so their shape matters to size and not to
//     speed.
