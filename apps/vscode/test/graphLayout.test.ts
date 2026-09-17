// graphLayout.test.ts -- covers src/graph/layout.ts and src/graph/layoutSidecar.ts: the
// properties a node editor actually depends on, rather than the exact coordinates the heuristics
// happen to produce today.
//
// The distinction matters, because the ordering and coordinate phases are heuristics and their
// output is expected to change when they are tuned. What must NOT change is: the same graph gives
// the same answer twice (the editor must not jitter on reload), boxes never overlap, delegation
// always runs left to right, a `sequence` feature's children always read top-to-bottom in
// execution order, cyclic input terminates, and a damaged sidecar costs the user nothing but the
// positions that were damaged. Those are what is asserted here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  autoLayout,
  packBoxes,
  positionsFromAnnotations,
  type LayoutBox,
  type LayoutGraph,
  type LayoutGraphEdge,
  type LayoutGraphNode,
  type LayoutPosition,
  type LayoutPositions,
} from '../src/graph/layout.js'
import {
  SIDECAR_FILENAME,
  SIDECAR_VERSION,
  emptySidecar,
  loadLayout,
  parseSidecar,
  prunePositions,
  readSidecar,
  resolveLayout,
  serializeSidecar,
  sidecarPath,
  withPosition,
  withoutPosition,
  writeSidecar,
  type LayoutSidecar,
} from '../src/graph/layoutSidecar.js'

/** The metrics every geometric assertion below is written against, so a change to the module's
 * own defaults cannot quietly invalidate a test that asserts "boxes are 80 apart". */
const METRICS = { nodeWidth: 200, nodeHeight: 60, layerGap: 100, rowGap: 20, componentGap: 200 }

function node(id: string, annotations?: LayoutGraphNode['annotations']): LayoutGraphNode {
  return annotations === undefined ? { id } : { id, annotations }
}

function edge(from: string, to: string, kind = 'aggregate', ordinal = 0): LayoutGraphEdge {
  return { from, to, kind, ordinal }
}

function graphOf(ids: string[], edges: LayoutGraphEdge[], roots: string[] = []): LayoutGraph {
  return { nodes: ids.map((id) => node(id)), edges, roots }
}

/** Layer index a position sits in, derived from x rather than asserted directly -- the module
 * promises "layer -> x", not a particular pixel. */
function layerOf(positions: LayoutPositions, id: string): number {
  const position = positions[id]
  expect(position, `${id} was not placed`).toBeDefined()
  return Math.round((position?.x ?? 0) / (METRICS.nodeWidth + METRICS.layerGap))
}

function yOf(positions: LayoutPositions, id: string): number {
  const position = positions[id]
  expect(position, `${id} was not placed`).toBeDefined()
  return position?.y ?? 0
}

/** Every pair of boxes that share a column must be at least a box apart vertically. This is the
 * one defect a reader cannot work around by squinting, so it is checked on every non-trivial
 * graph in this file rather than in one dedicated test. */
function expectNoOverlaps(positions: LayoutPositions): void {
  const byColumn = new Map<number, Array<{ id: string; y: number }>>()
  for (const [id, position] of Object.entries(positions)) {
    const column = byColumn.get(position.x) ?? []
    column.push({ id, y: position.y })
    byColumn.set(position.x, column)
  }
  for (const column of byColumn.values()) {
    column.sort((a, b) => a.y - b.y)
    for (let i = 1; i < column.length; i++) {
      const above = column[i - 1]
      const below = column[i]
      if (above === undefined || below === undefined) continue
      expect(below.y - above.y, `${above.id} and ${below.id} overlap`).toBeGreaterThanOrEqual(METRICS.nodeHeight)
    }
  }
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function boxAt(position: LayoutPosition): Box {
  return {
    left: position.x,
    top: position.y,
    right: position.x + METRICS.nodeWidth,
    bottom: position.y + METRICS.nodeHeight,
  }
}

function unionBox(boxes: readonly Box[]): Box {
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  }
}

/** The whitespace between two boxes: how far apart they are on the axis that separates them, or a
 * negative number if they overlap on both axes. Two boxes that miss each other on either axis are
 * separated by that axis's gap, which is the number a reader sees. */
function separation(a: Box, b: Box): number {
  const x = Math.max(a.left - b.right, b.left - a.right)
  const y = Math.max(a.top - b.bottom, b.top - a.bottom)
  return Math.max(x, y)
}

/** Real two-dimensional disjointness. expectNoOverlaps only compares boxes that share an x, which
 * was enough while every drawing lived in one column; once components are placed side by side, a
 * box can overlap a neighbour it does not share a column with. */
function expectBoxesDisjoint(boxes: readonly Box[]): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a === undefined || b === undefined) continue
      expect(separation(a, b), `boxes ${i} and ${j} overlap`).toBeGreaterThanOrEqual(0)
    }
  }
}

/** Weakly connected components, worked out from the graph itself rather than asked of the module
 * under test -- the assertions about components have to mean something even if findComponents is
 * the thing that broke. Returns one bounding box per component, in no particular order. */
function componentBoxes(graph: LayoutGraph, positions: LayoutPositions): Box[] {
  const neighbours = new Map<string, string[]>()
  const placed = new Set(Object.keys(positions))
  for (const id of placed) neighbours.set(id, [])
  for (const e of graph.edges ?? []) {
    if (!placed.has(e.from) || !placed.has(e.to)) continue
    neighbours.get(e.from)?.push(e.to)
    neighbours.get(e.to)?.push(e.from)
  }
  const seen = new Set<string>()
  const boxes: Box[] = []
  for (const start of [...placed].sort()) {
    if (seen.has(start)) continue
    seen.add(start)
    const queue = [start]
    const members: Box[] = []
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head] ?? ''
      const position = positions[id]
      if (position !== undefined) members.push(boxAt(position))
      for (const next of neighbours.get(id) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    if (members.length > 0) boxes.push(unionBox(members))
  }
  return boxes
}

/** How far a fit-to-window would have to zoom OUT to show the whole drawing, in the units the
 * failure was reported in. render.ts's zoomToFit picks `min(viewW/w, viewH/h)`, so for a viewport
 * of aspect T this is proportional to `max(w / T, h)` -- smaller is a bigger drawing on screen. */
function fitCost(box: Box, targetAspect: number): number {
  return Math.max((box.right - box.left) / targetAspect, box.bottom - box.top)
}

/** Counts places where two edges, drawn as straight lines between the node positions, actually
 * cross. Edges that merely share an endpoint do not count -- they meet, they do not cross. This
 * measures the finished drawing rather than the algorithm's internal estimate, which is the
 * number a reader experiences. */
function countEdgeCrossings(graph: LayoutGraph, positions: LayoutPositions): number {
  const segments = graph.edges.map((e) => ({
    ax: positions[e.from]?.x ?? 0,
    ay: positions[e.from]?.y ?? 0,
    bx: positions[e.to]?.x ?? 0,
    by: positions[e.to]?.y ?? 0,
  }))
  const side = (ox: number, oy: number, px: number, py: number, qx: number, qy: number): number =>
    (px - ox) * (qy - oy) - (py - oy) * (qx - ox)
  let total = 0
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i]
      const b = segments[j]
      if (a === undefined || b === undefined) continue
      const shares =
        (a.ax === b.ax && a.ay === b.ay) ||
        (a.bx === b.bx && a.by === b.by) ||
        (a.ax === b.bx && a.ay === b.by) ||
        (a.bx === b.ax && a.by === b.ay)
      if (shares) continue
      const d1 = side(a.ax, a.ay, a.bx, a.by, b.ax, b.ay)
      const d2 = side(a.ax, a.ay, a.bx, a.by, b.bx, b.by)
      const d3 = side(b.ax, b.ay, b.bx, b.by, a.ax, a.ay)
      const d4 = side(b.ax, b.ay, b.bx, b.by, a.bx, a.by)
      if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) total++
    }
  }
  return total
}

/** A graph the shape of a real pack's rule: one rule, a weighted pick between three biome
 * variants, each an aggregate of scatters and sequences, with a handful of leaf features shared
 * between them. Twenty-six nodes and thirty-four edges, which is the size the readability bar is
 * set at. */
function packShapedGraph(): LayoutGraph {
  const nodes: string[] = ['wiki:forest_rule']
  const edges: LayoutGraphEdge[] = []
  nodes.push('wiki:forest_pick')
  edges.push(edge('wiki:forest_rule', 'wiki:forest_pick', 'rule'))

  const shared = ['wiki:mossy_boulder', 'wiki:fallen_log', 'wiki:mushroom_cluster']
  nodes.push(...shared)

  for (let v = 0; v < 3; v++) {
    const variant = `wiki:variant_${v}`
    nodes.push(variant)
    edges.push({ from: 'wiki:forest_pick', to: variant, kind: 'weighted', ordinal: v })

    const canopy = `wiki:canopy_${v}`
    const floor = `wiki:floor_${v}`
    nodes.push(canopy, floor)
    edges.push({ from: variant, to: canopy, kind: 'aggregate', ordinal: 0 })
    edges.push({ from: variant, to: floor, kind: 'aggregate', ordinal: 1 })

    const scatter = `wiki:scatter_${v}`
    const tree = `wiki:tree_${v}`
    nodes.push(scatter, tree)
    edges.push({ from: canopy, to: scatter, kind: 'scatter', ordinal: 0 })
    edges.push({ from: scatter, to: tree, kind: 'filter', ordinal: 0 })

    // The floor of each variant is a sequence: soil, then grass, then one of the shared props.
    const soil = `wiki:soil_${v}`
    const grass = `wiki:grass_${v}`
    nodes.push(soil, grass)
    edges.push({ from: floor, to: soil, kind: 'sequence', ordinal: 0 })
    edges.push({ from: floor, to: grass, kind: 'sequence', ordinal: 1 })
    edges.push({ from: floor, to: shared[v] ?? 'wiki:mossy_boulder', kind: 'sequence', ordinal: 2 })

    // ... and every variant also reaches every shared prop, which is what makes this a DAG and
    // not a tree.
    for (const prop of shared) {
      edges.push({ from: canopy, to: prop, kind: 'aggregate', ordinal: 0 })
    }
  }
  return { nodes: nodes.map((id) => node(id)), edges, roots: ['wiki:forest_rule'] }
}

describe('autoLayout: degenerate input', () => {
  it('an empty graph lays out to an empty map', () => {
    expect(autoLayout({ nodes: [], edges: [] }, METRICS)).toEqual({})
  })

  it('a single node is placed at the origin', () => {
    const positions = autoLayout(graphOf(['wiki:only'], []), METRICS)
    expect(positions).toEqual({ 'wiki:only': { x: 0, y: 0 } })
  })

  it('a single node honours originX/originY', () => {
    const positions = autoLayout(graphOf(['wiki:only'], []), { ...METRICS, originX: 40, originY: 25 })
    expect(positions).toEqual({ 'wiki:only': { x: 40, y: 25 } })
  })

  it('nodes with no edges at all are spread out, not piled on one spot', () => {
    // UPDATED when component packing landed. This used to also assert every x was 0, which pinned
    // the one-column stacking rather than the property it is named for: three unrelated nodes are
    // now arranged in two dimensions (2 + 1 here), so their x values differ on purpose. What the
    // test is actually for -- three boxes, three distinct places, nothing on top of anything -- is
    // asserted directly instead.
    const positions = autoLayout(graphOf(['a', 'b', 'c'], []), METRICS)
    expectNoOverlaps(positions)
    expect(new Set(Object.values(positions).map((p) => `${p.x},${p.y}`)).size).toBe(3)
    expectBoxesDisjoint(Object.values(positions).map((p) => boxAt(p)))
  })

  it('an edge naming a node the graph does not contain is ignored, not fatal', () => {
    const positions = autoLayout(graphOf(['a'], [edge('a', 'ghost'), edge('ghost', 'a')]), METRICS)
    expect(Object.keys(positions)).toEqual(['a'])
  })

  it('a duplicate node id is folded into the first occurrence', () => {
    const graph: LayoutGraph = { nodes: [node('a'), node('a'), node('b')], edges: [edge('a', 'b')] }
    const positions = autoLayout(graph, METRICS)
    expect(Object.keys(positions).sort()).toEqual(['a', 'b'])
  })

  it('zero and negative metrics fall back to the defaults rather than collapsing the drawing', () => {
    const positions = autoLayout(graphOf(['a', 'b'], [edge('a', 'b')]), { nodeWidth: 0, nodeHeight: -5 })
    expect(positions.b?.x).toBeGreaterThan(0)
  })
})

describe('autoLayout: delegation reads left to right', () => {
  it('a chain puts each node exactly one layer right of the last', () => {
    const positions = autoLayout(graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')], ['a']), METRICS)
    expect(layerOf(positions, 'a')).toBe(0)
    expect(layerOf(positions, 'b')).toBe(1)
    expect(layerOf(positions, 'c')).toBe(2)
  })

  it('a shared child sits right of EVERY parent, not just the first (longest-path layering)', () => {
    // The diamond the contract warns about: `leaf` is reached directly from the root and through
    // two wrappers. A tree walk would draw it twice; a shortest-path layering would draw it in
    // layer 1, with two edges running backwards into it.
    const graph = graphOf(
      ['root', 'mid', 'deep', 'leaf'],
      [edge('root', 'mid'), edge('mid', 'deep'), edge('deep', 'leaf'), edge('root', 'leaf')],
      ['root'],
    )
    const positions = autoLayout(graph, METRICS)
    expect(layerOf(positions, 'leaf')).toBeGreaterThan(layerOf(positions, 'deep'))
    expect(layerOf(positions, 'leaf')).toBeGreaterThan(layerOf(positions, 'root'))
  })

  it('an edge kind this module has no special case for still lays out as a delegation', () => {
    // `child` (a tree_feature's log_decoration_feature, say) and `filter` are single-child slots
    // that only `sequence` differs from here. The point of the assertion is that the kind string
    // is not a dispatch table: a kind added to the contract after this module was written must
    // still be drawn, not dropped.
    const graph = graphOf(
      ['tree', 'decoration', 'invented'],
      [edge('tree', 'decoration', 'child'), edge('decoration', 'invented', 'some_future_kind')],
      ['tree'],
    )
    const positions = autoLayout(graph, METRICS)
    expect(layerOf(positions, 'decoration')).toBe(1)
    expect(layerOf(positions, 'invented')).toBe(2)
  })

  it('a node nothing declares as a root still gets laid out', () => {
    // `roots` is a hint, not the node set: an orphan feature nobody places is still in the graph
    // and still has to be editable.
    const positions = autoLayout(graphOf(['a', 'b', 'orphan'], [edge('a', 'b')], ['a']), METRICS)
    expect(positions.orphan).toBeDefined()
  })
})

describe('autoLayout: cyclic input terminates', () => {
  it('a two-node cycle is laid out, not hung on', () => {
    const graph: LayoutGraph = {
      ...graphOf(['a', 'b'], [edge('a', 'b'), edge('b', 'a')], ['a']),
      cycles: [['a', 'b']],
    }
    const positions = autoLayout(graph, METRICS)
    expect(Object.keys(positions).sort()).toEqual(['a', 'b'])
    expect(layerOf(positions, 'b')).toBe(1)
  })

  it('a self-delegating feature is laid out', () => {
    const positions = autoLayout(graphOf(['a'], [edge('a', 'a')], ['a']), METRICS)
    expect(positions).toEqual({ a: { x: 0, y: 0 } })
  })

  it('a long cycle with no root at all terminates and places every node', () => {
    // No node has in-degree zero, so nothing here is a root and the seed order is the only thing
    // that gets the DFS started.
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`)
    const edges = ids.map((id, i) => edge(id, ids[(i + 1) % ids.length] ?? id))
    const positions = autoLayout(graphOf(ids, edges), METRICS)
    expect(Object.keys(positions).sort()).toEqual([...ids].sort())
    expectNoOverlaps(positions)
  })

  it('a cycle hanging off a root, plus a tail out of it, is laid out in one drawing', () => {
    const graph = graphOf(
      ['rule', 'a', 'b', 'c', 'tail'],
      [edge('rule', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'tail')],
      ['rule'],
    )
    const positions = autoLayout(graph, METRICS)
    expect(Object.keys(positions)).toHaveLength(5)
    expect(layerOf(positions, 'tail')).toBeGreaterThan(layerOf(positions, 'rule'))
    expectNoOverlaps(positions)
  })

  it('a cycles list that is wrong (or missing) changes nothing -- back edges are found here', () => {
    const edges = [edge('a', 'b'), edge('b', 'a')]
    const withCycles: LayoutGraph = { ...graphOf(['a', 'b'], edges, ['a']), cycles: [['a', 'b']] }
    const withLies: LayoutGraph = { ...graphOf(['a', 'b'], edges, ['a']), cycles: [['nonsense']] }
    expect(autoLayout(withLies, METRICS)).toEqual(autoLayout(withCycles, METRICS))
  })
})

describe('autoLayout: determinism', () => {
  it('the same graph value laid out twice gives byte-identical JSON', () => {
    const graph = packShapedGraph()
    expect(JSON.stringify(autoLayout(graph, METRICS))).toBe(JSON.stringify(autoLayout(graph, METRICS)))
  })

  it('two separately built but equal graphs give the same positions', () => {
    // Guards against any dependence on object identity, insertion-order hashing, or a cached
    // value surviving between calls.
    expect(autoLayout(packShapedGraph(), METRICS)).toEqual(autoLayout(packShapedGraph(), METRICS))
  })

  it('laying out a graph does not mutate it', () => {
    const graph = packShapedGraph()
    const before = JSON.stringify(graph)
    autoLayout(graph, METRICS)
    expect(JSON.stringify(graph)).toBe(before)
  })

  it('every coordinate is a finite integer', () => {
    // Non-integers are not wrong on their own, but a float that drifts in the last bit between
    // two runs is exactly the reload jitter this module exists to avoid.
    for (const position of Object.values(autoLayout(packShapedGraph(), METRICS))) {
      expect(Number.isInteger(position.x)).toBe(true)
      expect(Number.isInteger(position.y)).toBe(true)
    }
  })
})

describe('autoLayout: sequence children read in execution order', () => {
  it('four sequence children run top to bottom by ordinal, whatever order the edges arrive in', () => {
    // The edges are deliberately shuffled relative to their ordinals: ordinal is load-bearing
    // (it IS the execution order, and therefore part of the RNG contract), the array order is not.
    const graph = graphOf(
      ['seq', 'c0', 'c1', 'c2', 'c3'],
      [
        edge('seq', 'c2', 'sequence', 2),
        edge('seq', 'c0', 'sequence', 0),
        edge('seq', 'c3', 'sequence', 3),
        edge('seq', 'c1', 'sequence', 1),
      ],
      ['seq'],
    )
    const positions = autoLayout(graph, METRICS)
    const ys = ['c0', 'c1', 'c2', 'c3'].map((id) => yOf(positions, id))
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    expectNoOverlaps(positions)
  })

  it('holds under the crossing-minimisation sweeps, which actively prefer the other order', () => {
    // Built so that every heuristic in the module, left alone, produces the REVERSE of execution
    // order: the edges arrive reversed, so the initial ordering is reversed, and each child has
    // its own grandchild in the layer beyond, so the median sweeps then find the reversed order
    // already crossing-free and have no reason to disturb it. Only the sequence constraint can
    // produce the right answer here, and getting it wrong is not a cosmetic defect -- it would
    // show the reader the wrong execution order, which is part of the RNG contract.
    const nodes = ['p', 'a0', 'a1', 'a2', 'z0', 'z1', 'z2']
    const edges: LayoutGraphEdge[] = [
      edge('p', 'a2', 'sequence', 2),
      edge('p', 'a1', 'sequence', 1),
      edge('p', 'a0', 'sequence', 0),
      edge('a2', 'z2'),
      edge('a1', 'z1'),
      edge('a0', 'z0'),
    ]
    const positions = autoLayout(graphOf(nodes, edges, ['p']), METRICS)
    expect(yOf(positions, 'a0')).toBeLessThan(yOf(positions, 'a1'))
    expect(yOf(positions, 'a1')).toBeLessThan(yOf(positions, 'a2'))
  })

  it('children left in the same layer keep their order when a sibling is pushed deeper', () => {
    // `c1` is also reached through a wrapper, so longest-path layering puts it a column further
    // right than its siblings. The two that remain must still read in ordinal order.
    const graph = graphOf(
      ['seq', 'c0', 'c1', 'c2', 'wrap'],
      [
        edge('seq', 'c0', 'sequence', 0),
        edge('seq', 'c1', 'sequence', 1),
        edge('seq', 'c2', 'sequence', 2),
        edge('seq', 'wrap'),
        edge('wrap', 'c1'),
      ],
      ['seq'],
    )
    const positions = autoLayout(graph, METRICS)
    expect(layerOf(positions, 'c1')).toBeGreaterThan(layerOf(positions, 'c0'))
    expect(yOf(positions, 'c0')).toBeLessThan(yOf(positions, 'c2'))
  })

  it('a sequence that delegates to the same feature twice places it once', () => {
    const graph = graphOf(
      ['seq', 'once'],
      [edge('seq', 'once', 'sequence', 0), edge('seq', 'once', 'sequence', 1)],
      ['seq'],
    )
    expect(Object.keys(autoLayout(graph, METRICS)).sort()).toEqual(['once', 'seq'])
  })
})

describe('autoLayout: disconnected components', () => {
  it('two unrelated rules are drawn apart, never interleaved', () => {
    // REWRITTEN when component packing landed. The old version asserted that every node of the
    // second rule sat BELOW every node of the first, which pinned the one-column stacking; two
    // components may now sit side by side. The property it was really protecting -- a reader can
    // tell which drawing a box belongs to without tracing an edge -- is that the two bounding
    // boxes are disjoint and separated by at least a component gap, which is asserted directly.
    const graph = graphOf(
      ['r1', 'a1', 'b1', 'r2', 'a2', 'b2'],
      [edge('r1', 'a1'), edge('r1', 'b1'), edge('r2', 'a2'), edge('r2', 'b2')],
      ['r1', 'r2'],
    )
    const positions = autoLayout(graph, METRICS)
    const first = unionBox(['r1', 'a1', 'b1'].map((id) => boxAt(positions[id] ?? { x: 0, y: 0 })))
    const second = unionBox(['r2', 'a2', 'b2'].map((id) => boxAt(positions[id] ?? { x: 0, y: 0 })))
    expect(separation(first, second)).toBeGreaterThanOrEqual(METRICS.componentGap)
    expectNoOverlaps(positions)
  })

  it('components are placed in root order, so the first root opens top-left', () => {
    // REWRITTEN for the same reason: "topmost" was the one-column spelling of "first in reading
    // order". In two dimensions that is "no lower, and no further right on the same row".
    const graph = graphOf(['second', 'first'], [], ['first', 'second'])
    const positions = autoLayout(graph, METRICS)
    const a = positions.first
    const b = positions.second
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect((a?.y ?? 0) < (b?.y ?? 0) || ((a?.y ?? 0) === (b?.y ?? 0) && (a?.x ?? 0) < (b?.x ?? 0))).toBe(true)
  })

  it('an isolated node is its own component and does not land on top of another', () => {
    const positions = autoLayout(graphOf(['r', 'a', 'lonely'], [edge('r', 'a')], ['r']), METRICS)
    expectNoOverlaps(positions)
  })
})

// ---------------------------------------------------------------------------
// packBoxes -- the component arrangement, tested as the pure geometry it is
// ---------------------------------------------------------------------------

/** Sizes standing in for a pack's worth of components: mostly single features, a few small rules,
 * one deep one. Written out rather than generated, so a failure names a shape a reader can see.
 * Exactly ONE box is an outlier by height, which is what keeps the oversize rule in play here --
 * see the outlier-guard test below for the other side of that. */
const MIXED_BOXES: LayoutBox[] = [
  { width: 200, height: 60 },
  { width: 500, height: 140 },
  { width: 200, height: 60 },
  { width: 200, height: 60 },
  { width: 800, height: 60 },
  { width: 200, height: 60 },
  { width: 500, height: 1200 },
  { width: 200, height: 60 },
  { width: 200, height: 60 },
  { width: 300, height: 140 },
  { width: 200, height: 60 },
  { width: 200, height: 60 },
]

const PACK_GAP_X = 120
const PACK_GAP_Y = 90

function placedBoxes(sizes: readonly LayoutBox[], packed: ReadonlyArray<{ x: number; y: number }>): Box[] {
  return sizes.map((size, i) => {
    const at = packed[i] ?? { x: 0, y: 0 }
    return { left: at.x, top: at.y, right: at.x + size.width, bottom: at.y + size.height }
  })
}

describe('packBoxes: total on any input', () => {
  it('no boxes at all pack to no placements', () => {
    expect(packBoxes([])).toEqual([])
  })

  it('one box is placed at the origin, whatever the target asks for', () => {
    expect(packBoxes([{ width: 900, height: 20 }])).toEqual([{ x: 0, y: 0 }])
    expect(packBoxes([{ width: 900, height: 20 }], { targetAspect: 0.01 })).toEqual([{ x: 0, y: 0 }])
  })

  it('a zero-sized, negative or non-finite box is placed rather than rejected', () => {
    const sizes = [
      { width: 0, height: 0 },
      { width: -50, height: -50 },
      { width: Number.NaN, height: Number.POSITIVE_INFINITY },
      { width: 200, height: 60 },
    ]
    const packed = packBoxes(sizes, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y })
    expect(packed).toHaveLength(4)
    for (const at of packed) {
      expect(Number.isFinite(at.x)).toBe(true)
      expect(Number.isFinite(at.y)).toBe(true)
    }
  })

  it('nonsense options fall back to the defaults instead of collapsing the arrangement', () => {
    const bad = packBoxes(MIXED_BOXES, {
      gapX: Number.NaN,
      gapY: -10,
      targetAspect: 0,
      packing: 'sideways' as unknown as 'shelf',
    })
    expect(bad).toHaveLength(MIXED_BOXES.length)
    expectBoxesDisjoint(placedBoxes(MIXED_BOXES, bad))
  })

  it('every box comes back, in the order it went in', () => {
    const packed = packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y })
    expect(packed).toHaveLength(MIXED_BOXES.length)
    // Reading order: nothing is ever placed above, or left of on the same row, something earlier.
    for (let i = 1; i < packed.length; i++) {
      const previous = packed[i - 1]
      const current = packed[i]
      if (previous === undefined || current === undefined) continue
      expect(current.y >= previous.y).toBe(true)
      if (current.y === previous.y) expect(current.x).toBeGreaterThan(previous.x)
    }
  })
})

describe('packBoxes: the arrangement itself', () => {
  const packed = packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y })
  const boxes = placedBoxes(MIXED_BOXES, packed)

  it('never overlaps two boxes', () => {
    expectBoxesDisjoint(boxes)
  })

  it('leaves at least the requested gap between every pair', () => {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (a === undefined || b === undefined) continue
        expect(separation(a, b), `boxes ${i} and ${j} are too close`).toBeGreaterThanOrEqual(
          Math.min(PACK_GAP_X, PACK_GAP_Y),
        )
      }
    }
  })

  it('gets closer to the target shape than one box per row would', () => {
    const column = placedBoxes(MIXED_BOXES, packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y, packing: 'column' }))
    expect(fitCost(unionBox(boxes), 16 / 9)).toBeLessThan(fitCost(unionBox(column), 16 / 9))
  })

  it('aims at the target it is given, not a constant', () => {
    // A tall target has to produce a taller arrangement than a wide one, or the option is decoration.
    const tall = placedBoxes(
      MIXED_BOXES,
      packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y, targetAspect: 0.3 }),
    )
    const wide = placedBoxes(
      MIXED_BOXES,
      packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y, targetAspect: 6 }),
    )
    const aspect = (list: Box[]): number => {
      const u = unionBox(list)
      return (u.right - u.left) / (u.bottom - u.top)
    }
    expect(aspect(tall)).toBeLessThan(aspect(wide))
  })

  it('gives the one huge component a row of its own', () => {
    // The 500x1200 box is the deep rule among the single features. Nothing may share its row --
    // a strip of unrelated singletons along its top edge reads as part of it.
    const index = MIXED_BOXES.findIndex((box) => box.height === 1200)
    const big = packed[index]
    expect(big).toBeDefined()
    for (let i = 0; i < packed.length; i++) {
      if (i === index) continue
      expect(packed[i]?.y, `box ${i} shares the big component's row`).not.toBe(big?.y)
    }
  })

  it('stops giving out private rows once tall boxes stop being the exception', () => {
    // The guard on the rule above, and the reason it is not just "3x the median". That test is
    // against the TYPICAL box, so on a pack whose components come in tiers it fires on a whole
    // tier -- and since each private row costs a row, soloing a quarter of the components rebuilds
    // the tall-thin drawing the packing exists to prevent. Measured at 3.1x the fit cost before
    // the guard. So: many tall boxes are a tier, not outliers, and the rule switches itself off.
    const tiered: LayoutBox[] = [
      ...Array.from({ length: 12 }, () => ({ width: 200, height: 60 })),
      ...Array.from({ length: 8 }, () => ({ width: 300, height: 400 })),
    ]
    const packed = packBoxes(tiered, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y })
    const rows = new Set(packed.map((at) => at.y))
    expect(rows.size).toBeLessThan(8)
    expectBoxesDisjoint(placedBoxes(tiered, packed))
    // ...and the result stays near the target rather than degenerating into a column.
    const box = unionBox(placedBoxes(tiered, packed))
    expect((box.right - box.left) / (box.bottom - box.top)).toBeGreaterThan(0.8)
  })

  it('never scales a box down to make it fit', () => {
    // A box wider than anything else still occupies its full width; the arrangement grows instead.
    const sizes: LayoutBox[] = [{ width: 200, height: 60 }, { width: 9000, height: 60 }, { width: 200, height: 60 }]
    const placed = placedBoxes(sizes, packBoxes(sizes, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y }))
    expect((placed[1]?.right ?? 0) - (placed[1]?.left ?? 0)).toBe(9000)
    expectBoxesDisjoint(placed)
  })

  it("'column' puts every box under the last one, in one column", () => {
    const column = packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y, packing: 'column' })
    expect(new Set(column.map((at) => at.x))).toEqual(new Set([0]))
    let expected = 0
    for (let i = 0; i < MIXED_BOXES.length; i++) {
      expect(column[i]?.y).toBe(expected)
      expected += (MIXED_BOXES[i]?.height ?? 0) + PACK_GAP_Y
    }
  })

  it('is deterministic: the same sizes pack the same way every time', () => {
    const once = packBoxes(MIXED_BOXES, { gapX: PACK_GAP_X, gapY: PACK_GAP_Y })
    const again = packBoxes(MIXED_BOXES.map((box) => ({ ...box })), { gapX: PACK_GAP_X, gapY: PACK_GAP_Y })
    expect(JSON.stringify(again)).toBe(JSON.stringify(once))
  })
})

// ---------------------------------------------------------------------------
// autoLayout over many components -- the reported failure, measured
// ---------------------------------------------------------------------------

/** The actual output of `featurelab graph --pack docs/wiki/tools/fixtures`: 57 nodes, 40 edges
 * and 40 roots, so most of it is small unrelated drawings. This is the file the "unreadable
 * hairline down the middle of an empty canvas" screenshot was taken from. */
const SAMPLE_GRAPH: LayoutGraph = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/graph-sample.json', import.meta.url)), 'utf-8'),
) as LayoutGraph

describe('autoLayout: many components are arranged in two dimensions', () => {
  const packedPositions = autoLayout(SAMPLE_GRAPH, METRICS)
  const columnPositions = autoLayout(SAMPLE_GRAPH, { ...METRICS, componentPacking: 'column' })

  it('the fixture really is the many-roots case this exists for', () => {
    expect(SAMPLE_GRAPH.nodes).toHaveLength(57)
    expect(SAMPLE_GRAPH.roots ?? []).toHaveLength(40)
    expect(componentBoxes(SAMPLE_GRAPH, columnPositions).length).toBeGreaterThan(20)
  })

  it('places every node exactly once', () => {
    expect(Object.keys(packedPositions)).toHaveLength(SAMPLE_GRAPH.nodes.length)
  })

  it('fits a viewport far better than one column does', () => {
    // The measurement the change was made for. A column is ~0.15 wide-to-tall; the packing brings
    // it back towards 1, and the fit cost -- how far zoom-to-fit has to zoom out -- drops with it.
    const packedBox = unionBox(Object.values(packedPositions).map((p) => boxAt(p)))
    const columnBox = unionBox(Object.values(columnPositions).map((p) => boxAt(p)))
    const aspect = (b: Box): number => (b.right - b.left) / (b.bottom - b.top)
    expect(Math.abs(Math.log(aspect(packedBox) / (16 / 9)))).toBeLessThan(
      Math.abs(Math.log(aspect(columnBox) / (16 / 9))),
    )
    expect(fitCost(packedBox, 16 / 9)).toBeLessThan(fitCost(columnBox, 16 / 9) / 1.5)
  })

  it('never overlaps two components', () => {
    expectBoxesDisjoint(componentBoxes(SAMPLE_GRAPH, packedPositions))
  })

  it('never overlaps two boxes', () => {
    expectBoxesDisjoint(Object.values(packedPositions).map((p) => boxAt(p)))
  })

  it('keeps at least a component gap between every pair of components', () => {
    // The "these two drawings are unrelated" signal. It has to survive being arranged in a grid --
    // a grid that let two components touch would have traded the whole point away.
    const boxes = componentBoxes(SAMPLE_GRAPH, packedPositions)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (a === undefined || b === undefined) continue
        expect(separation(a, b), `components ${i} and ${j} are too close`).toBeGreaterThanOrEqual(
          METRICS.componentGap,
        )
      }
    }
  })

  it('separates side-by-side components by more than one layer of the same drawing', () => {
    // layerGap is the widest whitespace that occurs INSIDE a drawing. Two unrelated drawings that
    // were only layerGap apart horizontally would read as one drawing with an extra column.
    const boxes = componentBoxes(SAMPLE_GRAPH, packedPositions)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (a === undefined || b === undefined) continue
        const sideBySide = a.top < b.bottom && b.top < a.bottom
        if (!sideBySide) continue
        expect(Math.max(a.left - b.right, b.left - a.right)).toBeGreaterThan(METRICS.layerGap)
      }
    }
  })

  it('is byte-identical across two runs', () => {
    expect(JSON.stringify(autoLayout(SAMPLE_GRAPH, METRICS))).toBe(JSON.stringify(packedPositions))
  })

  it('every coordinate is a finite integer', () => {
    for (const position of Object.values(packedPositions)) {
      expect(Number.isInteger(position.x)).toBe(true)
      expect(Number.isInteger(position.y)).toBe(true)
    }
  })

  it('still draws every delegation left to right', () => {
    // Packing moves whole drawings, so it must not be able to disturb what is inside one.
    for (const e of SAMPLE_GRAPH.edges) {
      const from = packedPositions[e.from]
      const to = packedPositions[e.to]
      if (from === undefined || to === undefined) continue
      expect(to.x, `${e.from} -> ${e.to}`).toBeGreaterThan(from.x)
    }
  })

  it('does not mutate the graph it was given', () => {
    const before = JSON.stringify(SAMPLE_GRAPH)
    autoLayout(SAMPLE_GRAPH, METRICS)
    expect(JSON.stringify(SAMPLE_GRAPH)).toBe(before)
  })
})

describe('autoLayout: packing changes nothing it should not', () => {
  it('a graph that is entirely one component is laid out exactly as it always was', () => {
    // The guarantee that lets every other test in this file stay as it was: with one component
    // there is nothing to arrange, so the packing pass must be a no-op to the byte.
    const graph = packShapedGraph()
    expect(componentBoxes(graph, autoLayout(graph, METRICS))).toHaveLength(1)
    expect(JSON.stringify(autoLayout(graph, METRICS))).toBe(
      JSON.stringify(autoLayout(graph, { ...METRICS, componentPacking: 'column' })),
    )
  })

  it('an empty graph is still an empty map, whatever the packing', () => {
    expect(autoLayout({ nodes: [], edges: [] }, METRICS)).toEqual({})
    expect(autoLayout({ nodes: [], edges: [] }, { ...METRICS, componentPacking: 'column' })).toEqual({})
    expect(autoLayout({ nodes: [], edges: [] }, { ...METRICS, viewportAspect: 42 })).toEqual({})
  })

  it('originX/originY still translate the whole drawing and nothing else', () => {
    const at00 = autoLayout(SAMPLE_GRAPH, METRICS)
    const moved = autoLayout(SAMPLE_GRAPH, { ...METRICS, originX: 1000, originY: -250 })
    for (const [id, position] of Object.entries(at00)) {
      expect(moved[id]).toEqual({ x: position.x + 1000, y: position.y - 250 })
    }
  })

  it('viewportAspect changes the arrangement and never the drawings', () => {
    // Same components, same internal shape; only where the boxes sit may differ.
    const wide = autoLayout(SAMPLE_GRAPH, { ...METRICS, viewportAspect: 4 })
    const tall = autoLayout(SAMPLE_GRAPH, { ...METRICS, viewportAspect: 0.4 })
    expect(Object.keys(wide).sort()).toEqual(Object.keys(tall).sort())
    const shape = (positions: LayoutPositions): string[] =>
      componentBoxes(SAMPLE_GRAPH, positions)
        .map((b) => `${b.right - b.left}x${b.bottom - b.top}`)
        .sort()
    expect(shape(wide)).toEqual(shape(tall))
    expectBoxesDisjoint(componentBoxes(SAMPLE_GRAPH, wide))
    expectBoxesDisjoint(componentBoxes(SAMPLE_GRAPH, tall))
  })

  it('a hand-pinned position does not move the component it sits in', () => {
    // The documented resolution of the pin/packing conflict: autoLayout is a function of the graph
    // alone, so adding a `@featurelab:layout` directive moves exactly the node it is written on.
    // Anchoring the whole component on the pin would drag the author's UNPINNED nodes to
    // coordinates nobody chose, which is the outcome worth avoiding here.
    const plain = graphOf(['r1', 'a1', 'r2', 'a2'], [edge('r1', 'a1'), edge('r2', 'a2')], ['r1', 'r2'])
    const pinned: LayoutGraph = {
      ...plain,
      nodes: [node('r1'), node('a1'), node('r2', [{ name: 'layout', args: ['-900', '-900'] }]), node('a2')],
    }
    expect(autoLayout(pinned, METRICS)).toEqual(autoLayout(plain, METRICS))
    expect(positionsFromAnnotations(pinned)).toEqual({ r2: { x: -900, y: -900 } })
  })
})

describe('autoLayout: a pack-sized rule', () => {
  const positions = autoLayout(packShapedGraph(), METRICS)

  it('places every node exactly once', () => {
    expect(Object.keys(positions)).toHaveLength(packShapedGraph().nodes.length)
  })

  it('never overlaps two boxes', () => {
    expectNoOverlaps(positions)
  })

  it('draws every delegation left to right', () => {
    // With no cycles in this graph, every edge must span at least one column -- which is what
    // lets a reader follow the drawing without ever backtracking.
    for (const e of packShapedGraph().edges) {
      expect(layerOf(positions, e.to), `${e.from} -> ${e.to}`).toBeGreaterThan(layerOf(positions, e.from))
    }
  })

  it('keeps each variant floor sequence in execution order', () => {
    for (let v = 0; v < 3; v++) {
      expect(yOf(positions, `wiki:soil_${v}`)).toBeLessThan(yOf(positions, `wiki:grass_${v}`))
    }
  })

  it('keeps crossings down to what the sharing makes unavoidable', () => {
    // A tripwire, not a target. Twelve edges converge on the three shared props, so a fair number
    // of crossings is forced by the graph itself and no ordering can remove them; what this
    // catches is the ordering phase silently stopping working. For reference, the same graph with
    // the median/transpose sweeps disabled -- initial DFS order only -- crosses 57 times.
    expect(countEdgeCrossings(packShapedGraph(), positions)).toBeLessThan(45)
  })
})

describe('autoLayout: a tree-shaped rule is drawn without a single crossing', () => {
  it('twenty-six nodes, five sequences, nothing shared: zero crossings', () => {
    // The common case by count, and the one where anything but a clean drawing is indefensible.
    // Also the case the ordering phase must not damage: the initial DFS order is already perfect
    // here, so a sweep that "improved" it would show up as a non-zero count.
    const ids: string[] = ['r']
    const edges: LayoutGraphEdge[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(`m${i}`)
      edges.push(edge('r', `m${i}`, 'aggregate', i))
      for (let j = 0; j < 4; j++) {
        ids.push(`l${i}_${j}`)
        edges.push(edge(`m${i}`, `l${i}_${j}`, 'sequence', j))
      }
    }
    const graph = graphOf(ids, edges, ['r'])
    const positions = autoLayout(graph, METRICS)
    expect(countEdgeCrossings(graph, positions)).toBe(0)
    expectNoOverlaps(positions)
  })
})

describe('positionsFromAnnotations', () => {
  it('reads a @featurelab:layout directive off a node', () => {
    const graph: LayoutGraph = { nodes: [node('a', [{ name: 'layout', args: ['340', '120'] }])], edges: [] }
    expect(positionsFromAnnotations(graph)).toEqual({ a: { x: 340, y: 120 } })
  })

  it('ignores other directives, and a layout directive that is not two numbers', () => {
    const graph: LayoutGraph = {
      nodes: [
        node('a', [{ name: 'ignore', args: ['inactive-branch'] }]),
        node('b', [{ name: 'layout', args: ['left'] }]),
        node('c', [{ name: 'layout', args: ['1', 'NaN'] }]),
        node('d', [{ name: 'layout', args: [] }]),
      ],
      edges: [],
    }
    expect(positionsFromAnnotations(graph)).toEqual({})
  })

  it('takes the first layout directive when a node carries two', () => {
    const graph: LayoutGraph = {
      nodes: [
        node('a', [
          { name: 'layout', args: ['1', '2'] },
          { name: 'layout', args: ['9', '9'] },
        ]),
      ],
      edges: [],
    }
    expect(positionsFromAnnotations(graph)).toEqual({ a: { x: 1, y: 2 } })
  })
})

describe('sidecar: parsing tolerates whatever is on disk', () => {
  it('round-trips through serialize/parse', () => {
    const sidecar: LayoutSidecar = { version: SIDECAR_VERSION, nodes: { 'wiki:a': { x: 10, y: 20 } } }
    expect(parseSidecar(serializeSidecar(sidecar))).toEqual({ sidecar, problem: null })
  })

  it('writes keys sorted and ends the file with a newline', () => {
    const text = serializeSidecar({ version: 1, nodes: { b: { x: 1, y: 1 }, a: { x: 2, y: 2 } } })
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'))
  })

  it('an empty file is not a problem, just empty', () => {
    expect(parseSidecar('')).toEqual({ sidecar: emptySidecar(), problem: null })
    expect(parseSidecar('   \n ')).toEqual({ sidecar: emptySidecar(), problem: null })
  })

  it('invalid JSON reports a problem and yields no positions', () => {
    const result = parseSidecar('{ "nodes": ')
    expect(result.sidecar.nodes).toEqual({})
    expect(result.problem).toContain(SIDECAR_FILENAME)
  })

  it('a JSON array, or a bare value, reports a problem', () => {
    expect(parseSidecar('[]').problem).not.toBeNull()
    expect(parseSidecar('42').problem).not.toBeNull()
    expect(parseSidecar('null').problem).not.toBeNull()
  })

  it('an object with no usable "nodes" reports a problem', () => {
    expect(parseSidecar('{"version":1}').problem).not.toBeNull()
    expect(parseSidecar('{"version":1,"nodes":[]}').problem).not.toBeNull()
  })

  it('one damaged entry does not discard the others', () => {
    const result = parseSidecar(
      JSON.stringify({
        version: 1,
        nodes: {
          good: { x: 1, y: 2 },
          stringy: { x: '1', y: 2 },
          partial: { x: 5 },
          notAnObject: 7,
          nulled: null,
          infinite: { x: 1, y: 1e400 },
        },
      }),
    )
    expect(result.sidecar.nodes).toEqual({ good: { x: 1, y: 2 } })
    expect(result.problem).toContain('5 unusable node positions')
  })

  it('accepts a version it has never heard of rather than throwing the positions away', () => {
    // A newer editor's file still has positions in it, and discarding someone's whole arrangement
    // because of an unrecognised version number is the more destructive choice.
    const result = parseSidecar('{"version":99,"nodes":{"a":{"x":1,"y":2}},"future":{"anything":true}}')
    expect(result.sidecar.nodes).toEqual({ a: { x: 1, y: 2 } })
    expect(result.problem).toBeNull()
  })
})

describe('sidecar: on disk', () => {
  let packRoot: string

  beforeEach(() => {
    packRoot = mkdtempSync(path.join(tmpdir(), 'featurelab-layout-'))
  })

  afterEach(() => {
    rmSync(packRoot, { recursive: true, force: true })
  })

  it('writes and reads back the same positions', () => {
    const sidecar: LayoutSidecar = { version: SIDECAR_VERSION, nodes: { 'wiki:a': { x: 3, y: 4 } } }
    writeSidecar(packRoot, sidecar)
    const read = readSidecar(packRoot)
    expect(read.sidecar).toEqual(sidecar)
    expect(read.problem).toBeNull()
    expect(read.existed).toBe(true)
  })

  it('writes to .featurelab-layout.json at the pack root', () => {
    writeSidecar(packRoot, emptySidecar())
    expect(sidecarPath(packRoot)).toBe(path.join(packRoot, SIDECAR_FILENAME))
    expect(readFileSync(sidecarPath(packRoot), 'utf-8')).toContain('"nodes"')
  })

  it('a missing file reads as empty, with no problem to report', () => {
    const read = readSidecar(packRoot)
    expect(read.sidecar).toEqual(emptySidecar())
    expect(read.problem).toBeNull()
    expect(read.existed).toBe(false)
  })

  it('a malformed file reads as empty, WITH a problem to report', () => {
    writeFileSync(sidecarPath(packRoot), 'this is not json', 'utf-8')
    const read = readSidecar(packRoot)
    expect(read.sidecar.nodes).toEqual({})
    expect(read.problem).not.toBeNull()
    expect(read.existed).toBe(true)
  })

  it('a directory where the file should be is reported, not thrown', () => {
    // The shape a badly-behaved sync tool leaves behind. Anything other than a clean read has to
    // come back as a problem string, because opening the graph must still work.
    mkdirSync(sidecarPath(packRoot), { recursive: true })
    const read = readSidecar(packRoot)
    expect(read.sidecar.nodes).toEqual({})
    expect(read.problem).not.toBeNull()
  })

  it('loadLayout falls back to pure auto-layout when the file is nonsense', () => {
    writeFileSync(sidecarPath(packRoot), '{{{', 'utf-8')
    const graph = packShapedGraph()
    const loaded = loadLayout(packRoot, graph, METRICS)
    expect(loaded.problem).not.toBeNull()
    expect(loaded.positions).toEqual(autoLayout(graph, METRICS))
    expect(loaded.pinned).toEqual([])
  })

  it('loadLayout applies the positions a previous session saved', () => {
    writeSidecar(packRoot, { version: SIDECAR_VERSION, nodes: { 'wiki:forest_rule': { x: -5, y: -5 } } })
    const loaded = loadLayout(packRoot, packShapedGraph(), METRICS)
    expect(loaded.positions['wiki:forest_rule']).toEqual({ x: -5, y: -5 })
    expect(loaded.pinned).toEqual(['wiki:forest_rule'])
  })
})

describe('sidecar: editing helpers', () => {
  it('withPosition returns a new sidecar and leaves the old one alone', () => {
    const before = emptySidecar()
    const after = withPosition(before, 'a', { x: 1, y: 2 })
    expect(before.nodes).toEqual({})
    expect(after.nodes).toEqual({ a: { x: 1, y: 2 } })
  })

  it('withoutPosition un-pins a node so it goes back to auto-layout', () => {
    const sidecar = withPosition(emptySidecar(), 'a', { x: 1, y: 2 })
    expect(withoutPosition(sidecar, 'a').nodes).toEqual({})
    expect(sidecar.nodes).toEqual({ a: { x: 1, y: 2 } })
  })

  it('prunePositions drops only the ids not in the keep set', () => {
    const sidecar: LayoutSidecar = {
      version: 1,
      nodes: { keep: { x: 1, y: 1 }, drop: { x: 2, y: 2 } },
    }
    expect(prunePositions(sidecar, ['keep']).nodes).toEqual({ keep: { x: 1, y: 1 } })
    expect(prunePositions(sidecar, new Set(['keep', 'unrelated'])).nodes).toEqual({ keep: { x: 1, y: 1 } })
  })
})

describe('resolveLayout: merging saved positions with automatic ones', () => {
  const graph = graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')], ['a'])

  it('an explicit position wins over the automatic one', () => {
    const sidecar = withPosition(emptySidecar(), 'b', { x: 999, y: -40 })
    const resolved = resolveLayout(graph, sidecar, METRICS)
    expect(resolved.positions.b).toEqual({ x: 999, y: -40 })
    expect(resolved.sources.b).toBe('sidecar')
    expect(resolved.pinned).toEqual(['b'])
  })

  it('a graph node the sidecar has never seen keeps its automatic position', () => {
    const sidecar = withPosition(emptySidecar(), 'b', { x: 999, y: -40 })
    const auto = autoLayout(graph, METRICS)
    const resolved = resolveLayout(graph, sidecar, METRICS)
    expect(resolved.positions.a).toEqual(auto.a)
    expect(resolved.positions.c).toEqual(auto.c)
    expect(resolved.sources.a).toBe('auto')
  })

  it('pinning one node does not move any other node', () => {
    // The property that makes dragging feel like dragging: a pin is not a constraint the rest of
    // the drawing re-flows around.
    const auto = autoLayout(graph, METRICS)
    const resolved = resolveLayout(graph, withPosition(emptySidecar(), 'b', { x: 5, y: 5 }), METRICS)
    expect({ ...resolved.positions, b: auto.b }).toEqual(auto)
  })

  it('a sidecar entry for a node no longer in the graph is reported, not drawn', () => {
    const sidecar: LayoutSidecar = {
      version: 1,
      nodes: { b: { x: 1, y: 1 }, 'wiki:deleted': { x: 2, y: 2 }, 'wiki:also_gone': { x: 3, y: 3 } },
    }
    const resolved = resolveLayout(graph, sidecar, METRICS)
    expect(resolved.orphaned).toEqual(['wiki:also_gone', 'wiki:deleted'])
    expect(resolved.positions['wiki:deleted']).toBeUndefined()
    expect(Object.keys(resolved.positions).sort()).toEqual(['a', 'b', 'c'])
  })

  it('resolving does not delete the orphan -- the sidecar it was given is untouched', () => {
    // The node is usually missing because its file is mid-edit, not because it was deleted, so
    // losing the position here would destroy work over a typo.
    const sidecar: LayoutSidecar = { version: 1, nodes: { 'wiki:deleted': { x: 2, y: 2 } } }
    resolveLayout(graph, sidecar, METRICS)
    expect(sidecar.nodes).toEqual({ 'wiki:deleted': { x: 2, y: 2 } })
  })

  it('a null or empty sidecar resolves to pure auto-layout', () => {
    const auto = autoLayout(graph, METRICS)
    expect(resolveLayout(graph, null, METRICS).positions).toEqual(auto)
    expect(resolveLayout(graph, emptySidecar(), METRICS).positions).toEqual(auto)
  })

  it('an @featurelab:layout annotation outranks auto-layout', () => {
    const annotated: LayoutGraph = {
      nodes: [node('a'), node('b', [{ name: 'layout', args: ['12', '34'] }])],
      edges: [edge('a', 'b')],
      roots: ['a'],
    }
    const resolved = resolveLayout(annotated, emptySidecar(), METRICS)
    expect(resolved.positions.b).toEqual({ x: 12, y: 34 })
    expect(resolved.sources.b).toBe('annotation')
  })

  it('the sidecar outranks an annotation -- the last drag on this machine is the newest word', () => {
    const annotated: LayoutGraph = {
      nodes: [node('a'), node('b', [{ name: 'layout', args: ['12', '34'] }])],
      edges: [edge('a', 'b')],
      roots: ['a'],
    }
    const resolved = resolveLayout(annotated, withPosition(emptySidecar(), 'b', { x: 7, y: 7 }), METRICS)
    expect(resolved.positions.b).toEqual({ x: 7, y: 7 })
    expect(resolved.sources.b).toBe('sidecar')
  })

  it('is deterministic across repeated resolves', () => {
    const sidecar = withPosition(emptySidecar(), 'wiki:variant_1', { x: 11, y: 22 })
    const pack = packShapedGraph()
    expect(JSON.stringify(resolveLayout(pack, sidecar, METRICS))).toBe(
      JSON.stringify(resolveLayout(pack, sidecar, METRICS)),
    )
  })
})
