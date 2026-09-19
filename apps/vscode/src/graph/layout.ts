// layout.ts -- automatic geometry for the feature graph (featurelab/wire's Graph): nodes, edges
// and roots in, an `{id -> {x, y}}` map out. Deliberately pure -- no VS Code, no filesystem, no
// dependencies -- so the same function runs in the extension host, in the webview, and in a test
// against a literal graph.
//
// ALGORITHM: layered (Sugiyama-style), drawn left to right, in four phases -- break cycles,
// assign layers, order within each layer, assign coordinates. Chosen over the two obvious
// alternatives for reasons that come straight out of the contract:
//
//   - NOT a tree walk. wire/graph.go says it in as many words: features are addressed by
//     "namespace:id" and shared, so one node can be the target of many edges. A tree walk has to
//     either duplicate a shared feature -- which lies about identity, since editing one copy
//     would have to somehow edit the other -- or keep one parent and silently drop the rest.
//     Real packs share heavily (one leaf block placement reached from five tree features), so
//     this is the common case, not a corner.
//   - NOT force-directed. A spring layout of thirty feature boxes photographs well and is
//     useless in an editor: it relaxes iteratively from a seed, so it settles somewhere slightly
//     different every reload and the whole drawing shifts when one node is added. "The editor
//     must not jitter on reload" rules out the entire family on its own.
//   - LAYERED, because delegation IS a depth relation. "This rule places that feature, which
//     places those three" is exactly what a reader is trying to see, and a layered drawing shows
//     it as distance along one axis with every edge pointing the same way.
//
// Left to right (layer -> x, order within layer -> y) rather than top to bottom, for two
// reasons. Node labels are "namespace:some_long_feature_name", so boxes are several times wider
// than they are tall and columns pack where rows would waste a screen of whitespace. And it puts
// ordinal order downwards: a `sequence` feature's children run in list order, that order IS
// execution order and therefore part of the RNG contract (see EdgeKind's own comment in
// wire/graph.go), so they are constrained to appear top-to-bottom by ordinal -- the reading
// order of the language, rather than something the reader has to reconstruct from edge labels.
//
// DISCONNECTED COMPONENTS get a fifth phase of their own, and it is the one phase that is not
// Sugiyama. A pack's feature_rules are mutually independent by construction, so a whole pack is
// dozens -- in a large pack, thousands -- of small unrelated drawings, and stacking them in one
// column makes a strip forty components tall and four node-widths wide. Fit-to-window then has to
// zoom out until every node is a few pixels high, which is the difference between a graph and a
// hairline. So the components are laid out exactly as before, their bounding boxes measured, and
// the BOXES arranged in two dimensions (see packBoxes) for the aspect ratio of the viewport they
// are about to be fitted into. Nothing in phases 1-4 knows this happens.
//
// TERMINATION on cyclic input is structural rather than a guard. Phase 1 runs one DFS and marks
// every back edge; phase 2 lays out only the remaining, provably acyclic, edge set; phases 3 and
// 4 run a fixed number of passes. Nothing here loops until convergence, so no input can hang it.
// Note that `Graph.cycles` is an input this module does not need: it finds its own back edges, so
// a cycle the engine failed to report is still laid out rather than hung on, and a `cycles` list
// that is stale or over-eager cannot corrupt the drawing. It is accepted in the input type only
// because callers pass whole Graph values.
//
// DETERMINISM is a hard requirement, and every phase is written for it: node iteration follows
// `roots` then `nodes` array order, every sort is stable with an explicit index tie-break, the
// sweep counts are constants, and no phase consults a clock, a hash iteration order, or a random
// number. The same Graph value in gives a byte-identical map out, forever.

/** One node's placement: the TOP-LEFT corner of its box, in the same units as
 * LayoutOptions.nodeWidth/nodeHeight. Top-left rather than centre because that is what a DOM or
 * canvas renderer needs without doing arithmetic, and because the caller already knows the box
 * size -- it passed it in. */
export interface LayoutPosition {
  readonly x: number
  readonly y: number
}

export type LayoutPositions = Record<string, LayoutPosition>

/** The `layout` editor directive's name, as it appears in an Annotation (which carries the name
 * with the `@featurelab:` prefix already stripped -- see wire/graph.go's Annotation). */
const LAYOUT_ANNOTATION = 'layout'

/** Wire EdgeKind. Only `sequence` changes what this module does (its ordinals are constrained to
 * read in order); every other kind lays out identically, so the union is here for callers and
 * for the one comparison below rather than as a dispatch table. Widened to `| string` at the use
 * site for the same reason: a kind added to the contract later must lay out, not fail to type. */
export type LayoutEdgeKind =
  | 'rule'
  | 'aggregate'
  | 'sequence'
  | 'weighted'
  | 'conditional'
  | 'scatter'
  | 'filter'
  | 'child'

/** The subset of wire.Annotation this module reads. */
export interface LayoutGraphAnnotation {
  readonly name: string
  readonly args?: readonly string[] | undefined
}

/** The subset of wire.GraphNode this module reads. Deliberately a structural subset rather than
 * a copy of the full node: a real GraphNode (with typeId, fields, coverage and the rest) is
 * assignable to this, but so is a two-field literal in a test, and this module never has to be
 * touched when a non-geometric field is added to the contract. */
export interface LayoutGraphNode {
  readonly id: string
  readonly annotations?: readonly LayoutGraphAnnotation[] | undefined
}

/** The subset of wire.GraphEdge this module reads. `ordinal` is not optional in the contract but
 * is optional here, because an edge kind that does not use it may one day omit it from the JSON
 * and a missing ordinal must not silently read as 0. */
export interface LayoutGraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: LayoutEdgeKind | string
  readonly ordinal?: number | undefined
}

/** The subset of wire.Graph this module reads. A decoded Graph is structurally assignable. */
export interface LayoutGraph {
  readonly nodes: readonly LayoutGraphNode[]
  readonly edges: readonly LayoutGraphEdge[]
  /** Node ids nothing delegates to. Used only as the tie-break order -- which root's subgraph is
   * drawn first and topmost, which node a DFS starts from -- never as a correctness input,
   * because a caller may not have it and an unreachable node still has to be placed. */
  readonly roots?: readonly string[] | undefined
  /** Accepted and ignored: see the module comment on why this module finds its own back edges. */
  readonly cycles?: readonly (readonly string[])[] | undefined
}

/** Box and spacing metrics, in the caller's own units (CSS pixels, typically). This module has
 * no opinion about them beyond needing them finite, because it cannot measure a rendered label. */
export interface LayoutOptions {
  nodeWidth?: number | undefined
  nodeHeight?: number | undefined
  /** Horizontal whitespace between one layer's right edge and the next layer's left edge. */
  layerGap?: number | undefined
  /** Minimum vertical whitespace between two boxes stacked in the same layer. */
  rowGap?: number | undefined
  /** Whitespace between two disconnected components. Wider than rowGap on purpose: the gap is the
   * only thing telling a reader "these two drawings are unrelated".
   *
   * Used verbatim between two stacked rows of components, and with `layerGap` ADDED to it between
   * two components sitting side by side. The asymmetry is not arbitrary: the widest whitespace
   * that occurs INSIDE a drawing is `layerGap` horizontally and `rowGap` vertically, and a
   * boundary gap has to beat it or the boundary stops reading as one. componentGap already beats
   * rowGap several times over, but at the default metrics it is SMALLER than layerGap (96 vs 110)
   * -- so used bare it would put two unrelated drawings closer together than two layers of one. */
  componentGap?: number | undefined
  /** Width/height the finished drawing aims for, used only to decide how disconnected components
   * are arranged relative to each other -- see packBoxes. Defaults to 16/9.
   *
   * An option rather than a constant because the number that actually matters is the aspect of
   * the viewport the drawing is about to be fitted into, and this module cannot measure one: it
   * runs in the extension host as well as the webview, and in tests with no viewport at all. A
   * caller that knows its canvas size should pass `width / height`; 16/9 is the shape of a
   * maximised editor panel and errs wide, which suits a left-to-right drawing whose components
   * are each wider than they are tall. */
  viewportAspect?: number | undefined
  /** How disconnected components are arranged. 'shelf' (the default) packs them into rows sized
   * for `viewportAspect`; 'column' stacks every component under the last one, which is what this
   * module did before shelf packing existed and is kept as an escape hatch for a caller that
   * wants one long strip (printing it, or diffing against an older drawing). */
  componentPacking?: ComponentPacking | undefined
  originX?: number | undefined
  originY?: number | undefined
}

export type ComponentPacking = 'shelf' | 'column'

interface ResolvedOptions {
  nodeWidth: number
  nodeHeight: number
  layerGap: number
  rowGap: number
  componentGap: number
  viewportAspect: number
  componentPacking: ComponentPacking
  originX: number
  originY: number
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  nodeWidth: 220,
  nodeHeight: 72,
  layerGap: 110,
  rowGap: 28,
  componentGap: 96,
  viewportAspect: 16 / 9,
  componentPacking: 'shelf',
  originX: 0,
  originY: 0,
}

/** How many width limits packBoxes tries before picking one. A CONSTANT, like every other pass
 * count here, so packing terminates in bounded time and gives the same answer every run; 32
 * candidates spread geometrically over the whole plausible range put successive widths about 10%
 * apart on a forty-component graph, which is finer than the boxes themselves are quantised. */
const PACK_WIDTH_CANDIDATES = 32

/** A box taller than this many times the MEDIAN box height is a candidate for a row of its own.
 * Three, because the case this exists for is not subtle -- one deep rule among forty single-node
 * features -- and a threshold that tripped on merely above-average heights would break rows up
 * for no gain.
 *
 * This is the one rule here that COSTS score rather than earning it, and it is the most expensive
 * thing in the packer: a soloed box gives up the whole width of the arrangement beside it, and
 * nothing may be tucked underneath it either. It is paid anyway, ONCE (see OVERSIZE_OUTLIER_LIMIT),
 * because the gap is not the only thing a reader groups by -- boxes sharing a band share a top
 * edge, and seven isolated single-node features strung along the top edge of a 1272-tall rule read
 * as part of that rule however wide the gap between them is. Whitespace does not cover that
 * pairing; a band of its own does. */
const OVERSIZE_HEIGHT_FACTOR = 3

/** ...but only while the oversized box really is AN OUTLIER: at most this many boxes may be
 * soloed, and if more than that qualify the rule is switched off entirely rather than applied to
 * a subset (which subset would be an arbitrary choice, and an unstable one).
 *
 * This guard is not defensive tidying, it is load-bearing, and the numbers say so. A solo costs a
 * whole band of the arrangement's width -- the entire row beside the tall box is given up -- and
 * "three times the median" is a test against the TYPICAL box, not against the rest, so on a skewed
 * distribution it fires on a whole tier and gives up a band per member.
 *
 * ONE, not a share of the input, and the measurement that moved it there is the 3531-node pack
 * fixture: 41 components, median height 1595, five of them at or above 4785. Five qualifies under
 * the old one-in-eight allowance (41/8 = 5), so five bands roughly 6,000 units tall were handed
 * out -- 33,000 of the finished drawing's 52,272 units of height, for 41 drawings whose boxes come
 * to 369M units of area in a world of 1,623M. That is the rule paying for itself four times over
 * out of the reader's pocket. Measured, on that fixture, as a fraction of the node area actually
 * on screen ("ink"):
 *
 *   one deep rule among 39 single features   1 solo   the case the rule exists for, unchanged
 *   the 41-component pack fixture            5 -> OFF   ink 4.4% -> 7.1% from this change alone
 *   20 singles, 8 four-deep, 3 huge          3 -> OFF   (already off under the old share)
 *
 * One is also what the rule's own premise says in as many words: "ONE component much larger than
 * the rest". Two boxes three times the median are a tier, not an outlier, and a tier is what the
 * whitespace between components is already there to separate. The known cost is that a pack with
 * two genuinely huge components protects neither; that is accepted, because they then sit beside
 * each other rather than beside singletons, which is where the misreading barely arises. */
const OVERSIZE_OUTLIER_LIMIT = 1

/** How many median/transpose sweeps the ordering phase runs. Eight is what graphviz's dot uses
 * for the same heuristic, and it is a CONSTANT rather than a convergence test on purpose -- a
 * fixed pass count is half of what makes this terminate on any input, cyclic or not. */
const ORDERING_SWEEPS = 8

/** How many times the transpose step may re-scan a layer for an improving adjacent swap before
 * giving up. Bounded for the same reason as ORDERING_SWEEPS. */
const TRANSPOSE_ROUNDS = 4

/** How many barycentre passes the coordinate phase runs. */
const COORDINATE_PASSES = 6

/** Lays the graph out from scratch, ignoring any saved positions -- see layoutSidecar.ts for the
 * merge with explicit ones. Never throws: a graph with dangling edges, duplicate node ids, self
 * delegations or no nodes at all is laid out as best it can be rather than rejected, because
 * every one of those states occurs mid-edit while someone is typing in the JSON. */
export function autoLayout(graph: LayoutGraph, options: LayoutOptions = {}): LayoutPositions {
  const opts = resolveOptions(options)
  const model = buildModel(graph)
  const positions: LayoutPositions = {}
  if (model.ids.length === 0) return positions

  const backEdge = findBackEdges(model)
  const layer = assignLayers(model, backEdge)

  // Components are laid out one at a time and then placed, rather than laid out together, so
  // that two unrelated rules can never interleave in a shared layer. Interleaving is not a
  // cosmetic problem: it makes a reader trace an edge to find out which drawing a box belongs
  // to, which is precisely the work the layout was supposed to have already done.
  //
  // WHERE they are placed is a second, separate question, and deliberately a post-pass: each
  // component is drawn in its own coordinates first, its bounding box measured, and only then are
  // the boxes arranged (see packBoxes). Nothing above this line knows or cares which arrangement
  // was chosen, so the arrangement can be changed -- or, with componentPacking, turned off --
  // without touching a line of the layered algorithm or any test of it.
  const columnPitch = opts.nodeWidth + opts.layerGap
  const drawings: Array<{ tops: Array<[number, number]>; left: number; width: number; height: number }> = []
  for (const component of findComponents(model)) {
    const placed = layoutComponent(model, component, layer, backEdge, opts)
    // Measured from the nodes actually placed rather than assumed to start at layer 0. It does
    // start at layer 0 in every graph the layering can produce -- each weakly connected component
    // contains a node with no forward parent -- but measuring costs one pass and means a change
    // to the layering phase cannot silently reintroduce a column of leading whitespace.
    let left = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    for (const [nodeIndex] of placed.tops) {
      const x = (layer[nodeIndex] ?? 0) * columnPitch
      left = Math.min(left, x)
      right = Math.max(right, x + opts.nodeWidth)
    }
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      left = 0
      right = 0
    }
    // Height comes from the drawing rather than from the boxes: it is what the stacking has
    // always used, it already covers the lanes reserved for long edges leaving the topmost or
    // bottommost box, and it is never smaller than the boxes' own extent.
    drawings.push({ tops: placed.tops, left, width: right - left, height: placed.height })
  }

  const packed = packBoxes(drawings, {
    gapX: opts.componentGap + opts.layerGap,
    gapY: opts.componentGap,
    targetAspect: opts.viewportAspect,
    packing: opts.componentPacking,
  })

  for (let c = 0; c < drawings.length; c++) {
    const drawing = drawings[c]
    const at = packed[c]
    if (drawing === undefined || at === undefined) continue
    for (const [nodeIndex, y] of drawing.tops) {
      const id = model.ids[nodeIndex]
      if (id === undefined) continue
      const nodeLayer = layer[nodeIndex] ?? 0
      positions[id] = {
        x: Math.round(opts.originX + at.x + nodeLayer * columnPitch - drawing.left),
        y: Math.round(opts.originY + at.y + y),
      }
    }
  }
  return positions
}

/** Positions written into the pack itself as `// @featurelab:layout <x> <y>` comments (see
 * wire/graph.go's Annotation). Separate from the sidecar on purpose: an annotation is committed
 * with the pack and is the author's intent for everyone who opens it, while the sidecar is one
 * machine's working state. Both outrank auto-layout; layoutSidecar.ts decides between them.
 *
 * A directive whose arguments are not two finite numbers is skipped rather than raised as an
 * error, because it is a hand-written comment in someone's JSON -- the cost of a typo should be
 * that one node auto-places, not that the graph refuses to open.
 *
 * A PIN INSIDE A COMPONENT THE PACKER MOVES is a real conflict, and it is resolved by autoLayout
 * not knowing these positions exist. The pinned node stays exactly where its author put it; the
 * rest of its component is packed wherever the packing puts it. Three reasons that is the right
 * way round, rather than anchoring the whole component on its pin:
 *
 *   - Anchoring would move nodes the author did NOT place. That is the outcome to avoid: a pin is
 *     a decision about one box, and honouring it by dragging its unpinned siblings to coordinates
 *     nobody chose is a bigger silent move than the one it was meant to prevent. It is also what
 *     layoutSidecar.resolveLayout already promises in as many words -- "pinning a node here moves
 *     exactly that node, and nothing else" -- and this module must not contradict it.
 *   - There are two pin mechanisms and this module can only see one. Annotations arrive on the
 *     nodes; the sidecar is a file layoutSidecar.ts reads and applies AFTERWARDS. An autoLayout
 *     that anchored on annotations would reshape the drawing for one kind of pin and not the
 *     other, so the same arrangement would depend on which mechanism a user happened to use.
 *   - An anchored component cannot be packed at all: the packer would have to treat its box as
 *     immovable, and immovable boxes either overlap the packed ones or force the packing around
 *     them, which is the "dragging one node rearranges the drawing" failure again.
 *
 * What the author does give up is that a pinned node can be drawn over a packed component's box,
 * exactly as it could be drawn over a stacked one before. An absolute coordinate in a drawing
 * whose other coordinates are computed has always had that property; it is not new here, and the
 * place to fix it, if it ever needs fixing, is resolveLayout -- which is the only function that
 * sees both kinds of pin and the automatic positions at once. */
export function positionsFromAnnotations(graph: LayoutGraph): LayoutPositions {
  const positions: LayoutPositions = {}
  for (const node of graph.nodes ?? []) {
    if (typeof node?.id !== 'string' || node.id.length === 0) continue
    if (positions[node.id] !== undefined) continue // duplicate id: first wins, as everywhere else here
    for (const annotation of node.annotations ?? []) {
      if (annotation?.name !== LAYOUT_ANNOTATION) continue
      const args = annotation.args ?? []
      if (args.length < 2) continue
      const x = Number(args[0])
      const y = Number(args[1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      positions[node.id] = { x, y }
      break // the first `layout` directive on a node wins; a second one is a mistake, not an override
    }
  }
  return positions
}

/** One already-drawn thing with a size but not yet a place: in practice one disconnected
 * component's bounding box, measured after `autoLayout` has laid its nodes out. */
export interface LayoutBox {
  readonly width: number
  readonly height: number
}

/** Where packBoxes put one box: the TOP-LEFT corner of its bounding box, relative to the packed
 * arrangement's own top-left, in the same units as the box sizes. */
export interface PackedBox {
  readonly x: number
  readonly y: number
}

export interface PackBoxesOptions {
  /** Minimum whitespace between two boxes standing side by side. */
  gapX?: number | undefined
  /** Minimum whitespace between two rows of boxes. */
  gapY?: number | undefined
  /** Width/height the packed arrangement aims for. See LayoutOptions.viewportAspect. */
  targetAspect?: number | undefined
  /** 'shelf' (default) packs boxes into rows; 'column' gives every box its own row. */
  packing?: ComponentPacking | undefined
}

/** Arranges finished drawings in two dimensions. Pure geometry -- it never sees a node, an edge
 * or an id -- which is the whole reason it is a separate pass: the per-component layout above is
 * hard to reason about and this is not, so keeping them apart means each can be wrong on its own.
 *
 * WHAT IT OPTIMISES, exactly: the zoom factor a fit-to-window gets. Framing a drawing of `W x H`
 * in a viewport of aspect `T` zooms by `min(T/W, 1/H)` (up to a scale factor), so the arrangement
 * that makes the boxes biggest on screen is the one minimising `max(W / T, H)`. That is the score
 * below, and it is a better target than "aspect ratio closest to T" on its own, because it also
 * counts the whitespace a bad arrangement wastes -- two arrangements can share an aspect and one
 * of them be twice the size. It is also exactly the number the reported failure is about: forty
 * components in a column zoom to a few pixels a node, and nothing else here changes that.
 *
 * HOW: a SKYLINE pass -- each box goes at the lowest place it fits, leftmost among equals --
 * run once per candidate width limit, keeping the best-scoring result. It used to be plain shelf
 * packing (fill a row, break, start the next row at the tallest box's bottom edge) and the reason
 * it is not any more is measured. On the 3531-node pack fixture the component boxes come to 369M
 * square units; shelves arranged them over 1,623M, so 77% of the finished drawing was the dead
 * space under short boxes in tall rows. A skyline fills that space -- the same 41 boxes come to
 * 611M -- because a box that is half the height of its neighbour no longer forces the next row
 * down past the neighbour's bottom edge; the next box simply sits under it.
 *
 * ORDER IS NEVER CHANGED, and that is the difference between this and a textbook 2-D bin packer.
 * Boxes come out in the order they went in, the caller feeds them in seedOrder, and READING ORDER
 * is enforced as a hard constraint on the placement itself: no box is ever put above an earlier
 * box, or to the left of one it shares a top edge with. So `roots` order still decides which
 * drawing is top-left and a reader still meets the components in the order the pack declares them.
 * That constraint costs real density -- an unconstrained skyline reaches 69% fill on the fixture
 * against this one's 60% -- and it is paid, because a packer that buries the rule the user came
 * for in the middle of the canvas to save a tenth of the area has made the drawing worse. Sorting
 * the boxes by descending height, the other textbook refinement (71% fill), is not done for the
 * same reason.
 *
 * Total and deterministic on any input: no box is ever dropped, one wider than every candidate
 * limit is simply placed at x = 0 at full size (nothing here scales a box down -- a squeezed
 * drawing is not a smaller drawing, it is a different one), a non-finite or negative size reads
 * as 0, and every loop is bounded by a constant or by the input length. */
export function packBoxes(boxes: readonly LayoutBox[], options: PackBoxesOptions = {}): PackedBox[] {
  const gapX = nonNegative(options.gapX, 0)
  const gapY = nonNegative(options.gapY, 0)
  const targetAspect = positive(options.targetAspect, DEFAULT_OPTIONS.viewportAspect)
  const packing = packingOf(options.packing, 'shelf')

  const sizes = boxes.map((box) => ({
    width: Math.max(0, finite(box?.width, 0)),
    height: Math.max(0, finite(box?.height, 0)),
  }))
  if (sizes.length === 0) return []
  if (sizes.length === 1) return [{ x: 0, y: 0 }]
  if (packing === 'column') return stackBoxes(sizes, gapY)

  // A box this tall gets a band to itself rather than stretching a row of small ones around it.
  // The median rather than the mean for the same reason the ordering phase uses one: the single
  // huge component this rule exists for would drag a mean up far enough to hide itself. And the
  // rule only applies while such a box is the exception -- see OVERSIZE_OUTLIER_LIMIT, which is
  // where the measurements behind that are written down.
  const median = medianOf(sizes.map((size) => size.height))
  const oversize = median > 0 ? median * OVERSIZE_HEIGHT_FACTOR : Number.POSITIVE_INFINITY
  let outliers = 0
  for (const size of sizes) {
    if (size.height >= oversize) outliers++
  }
  const soloHeight = outliers > 0 && outliers <= OVERSIZE_OUTLIER_LIMIT ? oversize : Number.POSITIVE_INFINITY

  let widest = 0
  let strip = -gapX
  for (const size of sizes) {
    widest = Math.max(widest, size.width)
    strip += size.width + gapX
  }

  let best: PackedBox[] | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let k = 0; k < PACK_WIDTH_CANDIDATES; k++) {
    // Geometric rather than linear from `widest` (one box per row) to `strip` (all in one row),
    // because the score is a ratio: a linear sweep would spend most of its candidates in the wide
    // half, where they are interchangeable, and skip over the narrow half where they are not.
    const t = k / (PACK_WIDTH_CANDIDATES - 1)
    const limit = widest > 0 && strip > widest ? widest * Math.pow(strip / widest, t) : strip
    const placed = skyline(sizes, gapX, gapY, limit, soloHeight)
    const score = scorePacking(sizes, placed, targetAspect)
    // Strictly better, so the narrowest of several equally good widths wins -- the same
    // earliest-wins tie-break the ordering phase uses, and the reason this is reproducible.
    if (score < bestScore) {
      bestScore = score
      best = placed
    }
  }
  return best ?? skyline(sizes, gapX, gapY, strip, soloHeight)
}

/** Every box under the last one, in one column: what `componentPacking: 'column'` asks for. */
function stackBoxes(sizes: ReadonlyArray<{ width: number; height: number }>, gapY: number): PackedBox[] {
  const placed: PackedBox[] = []
  let top = 0
  for (const size of sizes) {
    placed.push({ x: 0, y: top })
    top += size.height + gapY
  }
  return placed
}

/** The packed profile, as a staircase: `edges[i]` is where a step starts and `tops[i]` is the
 * first free y from there to the next step (the last step runs to infinity). Two parallel arrays
 * rather than a list of objects, mutated in place rather than rebuilt, because this is the hot
 * loop of the whole packing pass -- once per box, per candidate width, 32 times over. */
interface Skyline {
  edges: number[]
  tops: number[]
}

/** One skyline pass at a fixed width limit.
 *
 * Each box is reserved as `width + gapX` by `height + gapY`, so two boxes whose reservations are
 * disjoint are either gapX apart horizontally or gapY apart vertically -- which is exactly the
 * separation guarantee the caller needs, obtained without a single pairwise test.
 *
 * THE TWO CONSTRAINTS, both of which are what make this a drawing rather than a bin:
 *   - READING ORDER. `floorY` is the top of the box placed last and nothing may go above it;
 *     `floorX` is that box's left edge and nothing sharing its top edge may go left of it. So the
 *     sequence of placements runs down the page, and the boxes sharing any one y run left to
 *     right, in input order. See packBoxes on what this costs.
 *   - AN OVERSIZED BOX GETS ITS OWN BAND: it starts a fresh line below everything placed so far,
 *     and the next box starts below IT, so nothing is ever strung along its top or tucked under
 *     its skirt. See OVERSIZE_HEIGHT_FACTOR.
 *
 * Candidate positions are the staircase's own steps, which is the standard skyline argument: an
 * optimal placement can always be slid left until it rests against a step, so the steps are the
 * only x values worth trying.
 *
 * COST. Every box is one walk of the staircase, not one walk per candidate position: the window
 * a box covers, `[x, x + width)`, only ever moves RIGHT as the candidate x does, so the highest
 * step under it is a sliding-window maximum and a monotonic queue answers all of them in one
 * pass. The naive "for each candidate, scan the steps it covers" is the same answer squared in
 * the step count, and at 400 components that difference measured 557 ms against 8. What keeps the
 * staircase itself short is `flatten`: steps at or below `floorY` can never be reached again -- a
 * placement there would be lifted to `floorY` anyway -- so they are merged into it after every
 * box, and the profile stays roughly as long as the number of boxes still poking above the last
 * placement rather than one step per box. */
function skyline(
  sizes: ReadonlyArray<{ width: number; height: number }>,
  gapX: number,
  gapY: number,
  limit: number,
  soloHeight: number,
): PackedBox[] {
  const placed: PackedBox[] = []
  const sky: Skyline = { edges: [0], tops: [0] }
  // Indices into the staircase, kept in increasing order with strictly decreasing tops, so the
  // front is always the highest step in the current window. Allocated once for the whole pass.
  const queue: number[] = []
  let floorY = 0
  let floorX = Number.NEGATIVE_INFINITY
  let afterSolo = false
  let highest = 0
  for (const size of sizes) {
    const width = size.width + gapX
    const height = size.height + gapY
    const solo = size.height >= soloHeight
    let atX = 0
    let atY = floorY
    if (placed.length === 0) {
      atX = 0
      atY = 0
    } else if (solo || afterSolo) {
      // A band of its own, below everything: either this box is the oversized one, or the last
      // box was and this one must not be tucked under it.
      atX = 0
      atY = highest
    } else {
      let bestX = Number.NaN
      let bestY = Number.POSITIVE_INFINITY
      const steps = sky.edges.length
      queue.length = 0
      let head = 0
      let ahead = 0
      // Nothing may be placed above the floor, so a candidate that reaches it cannot be beaten
      // and the walk stops there. That is the common case -- the next box along a part-filled
      // band rests on the floor beside the last one -- and it is what keeps this pass close to
      // linear on the inputs that occur rather than at its quadratic worst case.
      for (let step = 0; step < steps && bestY > floorY; step++) {
        const x = sky.edges[step] ?? 0
        const right = x + width
        // Extend the window rightwards to every step this box would cover...
        while (ahead < steps && (sky.edges[ahead] ?? 0) < right) {
          const value = sky.tops[ahead] ?? 0
          while (queue.length > head && (sky.tops[queue[queue.length - 1] ?? 0] ?? 0) <= value) queue.pop()
          queue.push(ahead)
          ahead++
        }
        // ...and drop the steps left of this candidate, which it no longer covers.
        while (queue.length > head && (queue[head] ?? 0) < step) head++
        // A box wider than the limit cannot be refused -- nothing here scales one down -- so the
        // x = 0 candidate is always allowed and the limit only turns away boxes that have a
        // leftward alternative.
        if (x > 0 && right > limit) continue
        const under = queue.length > head ? sky.tops[queue[head] ?? 0] ?? 0 : 0
        const y = under > floorY ? under : floorY
        if (y === floorY && x <= floorX) continue // would break reading order
        if (y < bestY) {
          bestY = y
          bestX = x
        }
      }
      if (Number.isNaN(bestX)) {
        // Every step was refused, which can only happen when the whole current line is spoken for.
        // A fresh line below everything is always legal: the last box's own reservation puts the
        // profile strictly below floorY.
        atX = 0
        atY = highest > floorY ? highest : floorY
      } else {
        atX = bestX
        atY = bestY
      }
    }
    placed.push({ x: atX, y: atY })
    const top = atY + height
    if (top > highest) highest = top
    raise(sky, atX, width, top)
    floorY = atY
    floorX = atX
    afterSolo = solo
    flatten(sky, floorY)
  }
  return placed
}

/** Raises `[x, x + width)` to `top`, splitting the steps it lands across. In place: the staircase
 * is a few entries long and this runs once per box per candidate width. */
function raise(sky: Skyline, x: number, width: number, top: number): void {
  if (!(width > 0)) return // a box with no horizontal extent covers nothing and hides nothing
  const { edges, tops } = sky
  const right = x + width
  let first = edges.length - 1
  while (first > 0 && (edges[first] ?? 0) > x) first-- // the step x lands in
  let last = first
  while (last + 1 < edges.length && (edges[last + 1] ?? 0) < right) last++ // the last step covered
  const tail = tops[last] ?? 0
  const tailStartsAt = last + 1 < edges.length ? edges[last + 1] ?? right : Number.POSITIVE_INFINITY
  const nextEdges: number[] = []
  const nextTops: number[] = []
  if ((edges[first] ?? 0) < x) {
    nextEdges.push(edges[first] ?? 0)
    nextTops.push(tops[first] ?? 0)
  }
  nextEdges.push(x)
  nextTops.push(top)
  if (tailStartsAt > right) {
    nextEdges.push(right)
    nextTops.push(tail)
  }
  edges.splice(first, last - first + 1, ...nextEdges)
  tops.splice(first, last - first + 1, ...nextTops)
}

/** Flattens every step at or below `floorY` into it and coalesces the result, in place. Nothing
 * below the floor can be used again (reading order forbids it), so this loses no placement, and
 * it is what keeps the staircase short enough for the pass above to stay cheap. */
function flatten(sky: Skyline, floorY: number): void {
  const { edges, tops } = sky
  let kept = 0
  for (let step = 0; step < edges.length; step++) {
    const value = Math.max(tops[step] ?? 0, floorY)
    if (kept > 0 && tops[kept - 1] === value) continue
    edges[kept] = edges[step] ?? 0
    tops[kept] = value
    kept++
  }
  edges.length = kept
  tops.length = kept
}

/** `max(W / targetAspect, H)` over the packed bounding box: the reciprocal of the zoom a
 * fit-to-window would settle on, so smaller is a bigger drawing on screen. */
function scorePacking(
  sizes: ReadonlyArray<{ width: number; height: number }>,
  placed: readonly PackedBox[],
  targetAspect: number,
): number {
  let width = 0
  let height = 0
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i]
    const at = placed[i]
    if (size === undefined || at === undefined) continue
    width = Math.max(width, at.x + size.width)
    height = Math.max(height, at.y + size.height)
  }
  return Math.max(width / targetAspect, height)
}

function resolveOptions(options: LayoutOptions): ResolvedOptions {
  return {
    nodeWidth: positive(options.nodeWidth, DEFAULT_OPTIONS.nodeWidth),
    nodeHeight: positive(options.nodeHeight, DEFAULT_OPTIONS.nodeHeight),
    layerGap: nonNegative(options.layerGap, DEFAULT_OPTIONS.layerGap),
    rowGap: nonNegative(options.rowGap, DEFAULT_OPTIONS.rowGap),
    componentGap: nonNegative(options.componentGap, DEFAULT_OPTIONS.componentGap),
    viewportAspect: positive(options.viewportAspect, DEFAULT_OPTIONS.viewportAspect),
    componentPacking: packingOf(options.componentPacking, DEFAULT_OPTIONS.componentPacking),
    originX: finite(options.originX, DEFAULT_OPTIONS.originX),
    originY: finite(options.originY, DEFAULT_OPTIONS.originY),
  }
}

function packingOf(value: ComponentPacking | undefined, fallback: ComponentPacking): ComponentPacking {
  return value === 'shelf' || value === 'column' ? value : fallback
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

interface ModelEdge {
  from: number
  to: number
  kind: string
  ordinal: number
}

/** The graph reduced to integer indices, which is what every phase below actually works on. Ids
 * are resolved exactly once, here, so a dangling edge is dropped in one place instead of being
 * re-checked in four. */
interface Model {
  /** Node ids in input order, de-duplicated. */
  ids: string[]
  indexOf: Map<string, number>
  edges: ModelEdge[]
  /** Edge indices leaving / entering each node, in input order. */
  out: number[][]
  in: number[][]
  /** Every node index exactly once: declared roots first (in `roots` order), then the remaining
   * nodes in `nodes` order. This is THE tie-break order for the whole module -- DFS start order,
   * component order, initial layer order -- so that "an editor opens on the roots" also means the
   * roots' own subgraphs are the ones drawn first and topmost. */
  seedOrder: number[]
}

function buildModel(graph: LayoutGraph): Model {
  const ids: string[] = []
  const indexOf = new Map<string, number>()
  for (const node of graph.nodes ?? []) {
    const id = node?.id
    // A duplicate id cannot be honoured -- the contract says ids are unique, and two boxes with
    // the same id would make every edge to it ambiguous -- so the first occurrence wins and the
    // second folds into it, which at least keeps its edges drawn.
    if (typeof id !== 'string' || id.length === 0 || indexOf.has(id)) continue
    indexOf.set(id, ids.length)
    ids.push(id)
  }

  const edges: ModelEdge[] = []
  const out: number[][] = ids.map(() => [])
  const incoming: number[][] = ids.map(() => [])
  for (const edge of graph.edges ?? []) {
    const from = indexOf.get(edge?.from ?? '')
    const to = indexOf.get(edge?.to ?? '')
    // An edge to a node that is not in `nodes` is dropped. Per the contract this should not
    // happen -- an unresolved target is still a node, flagged Unresolved -- but a half-written
    // graph from a caller that assembled it by hand should draw the nodes it does have rather
    // than throw.
    if (from === undefined || to === undefined) continue
    const index = edges.length
    edges.push({
      from,
      to,
      kind: typeof edge.kind === 'string' ? edge.kind : '',
      ordinal: typeof edge.ordinal === 'number' && Number.isFinite(edge.ordinal) ? edge.ordinal : 0,
    })
    out[from]?.push(index)
    incoming[to]?.push(index)
  }

  const seen = new Set<number>()
  const seedOrder: number[] = []
  for (const rootId of graph.roots ?? []) {
    const index = indexOf.get(rootId)
    if (index === undefined || seen.has(index)) continue
    seen.add(index)
    seedOrder.push(index)
  }
  for (let i = 0; i < ids.length; i++) {
    if (seen.has(i)) continue
    seen.add(i)
    seedOrder.push(i)
  }

  return { ids, indexOf, edges, out, in: incoming, seedOrder }
}

const WHITE = 0
const GRAY = 1
const BLACK = 2

/** Phase 1. One depth-first sweep in seedOrder, marking every edge that points back at a node
 * still on the current DFS path. Removing exactly those edges leaves a DAG -- the standard
 * property of a DFS forest -- and that is what lets every later phase be written as if the input
 * were acyclic.
 *
 * Iterative rather than recursive: a deep pack (a chain of wrapper features, each delegating to
 * the next) is not hypothetical, and blowing the JS stack inside the editor's layout pass would
 * be a far worse failure than the deep graph itself.
 *
 * A self delegation (from === to -- a feature that places itself, which the engine permits and
 * guards at run time) falls out as a back edge here with no special case. */
function findBackEdges(model: Model): boolean[] {
  const state = new Uint8Array(model.ids.length)
  const back = new Array<boolean>(model.edges.length).fill(false)
  const stack: number[] = []
  const cursor: number[] = []
  for (const start of model.seedOrder) {
    if (state[start] !== WHITE) continue
    state[start] = GRAY
    stack.push(start)
    cursor.push(0)
    while (stack.length > 0) {
      const node = stack[stack.length - 1] ?? 0
      const next = cursor[cursor.length - 1] ?? 0
      const outgoing = model.out[node] ?? []
      if (next >= outgoing.length) {
        state[node] = BLACK
        stack.pop()
        cursor.pop()
        continue
      }
      cursor[cursor.length - 1] = next + 1
      const edgeIndex = outgoing[next] ?? 0
      const target = model.edges[edgeIndex]?.to ?? 0
      if (state[target] === GRAY) {
        back[edgeIndex] = true // points at an ancestor on the current path: this edge closes a cycle
        continue
      }
      if (state[target] === BLACK) continue // already finished elsewhere: a cross or forward edge
      state[target] = GRAY
      stack.push(target)
      cursor.push(0)
    }
  }
  return back
}

/** Phase 2. Longest-path layering over the non-back edges: every node sits one layer to the
 * right of its DEEPEST parent, so every forward edge spans at least one layer and always points
 * rightwards. Longest-path rather than a network simplex that would minimise total edge length,
 * because it is linear, has nothing to tune, and puts a shared feature to the right of EVERY
 * feature that places it -- which is the reading a pack author wants ("nothing places this until
 * here"). The cost is that a leaf shared by a shallow and a deep parent is drawn as deep as the
 * deeper one, which is the right trade for a delegation graph. */
function assignLayers(model: Model, backEdge: boolean[]): number[] {
  const count = model.ids.length
  const layer = new Array<number>(count).fill(0)
  const remaining = new Array<number>(count).fill(0)
  for (let e = 0; e < model.edges.length; e++) {
    if (backEdge[e]) continue
    const to = model.edges[e]?.to
    if (to !== undefined) remaining[to] = (remaining[to] ?? 0) + 1
  }

  const queue: number[] = model.seedOrder.filter((node) => (remaining[node] ?? 0) === 0)
  const settled = new Array<boolean>(count).fill(false)
  for (const node of queue) settled[node] = true
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] ?? 0
    for (const e of model.out[node] ?? []) {
      if (backEdge[e]) continue
      const to = model.edges[e]?.to
      if (to === undefined) continue
      const candidate = (layer[node] ?? 0) + 1
      if ((layer[to] ?? 0) < candidate) layer[to] = candidate
      remaining[to] = (remaining[to] ?? 0) - 1
      if ((remaining[to] ?? 0) <= 0 && !settled[to]) {
        settled[to] = true
        queue.push(to)
      }
    }
  }

  // Defensive, and the other half of the termination guarantee: if back-edge removal somehow left
  // a cycle, the queue above drains before every node is settled. Rather than loop looking for
  // one, force the stragglers in seedOrder -- each gets a layer that respects its settled parents
  // and ignores its unsettled ones, which is a slightly worse drawing of a graph that should not
  // exist, reached in bounded time.
  for (const node of model.seedOrder) {
    if (settled[node]) continue
    settled[node] = true
    let best = 0
    for (const e of model.in[node] ?? []) {
      if (backEdge[e]) continue
      const from = model.edges[e]?.from
      if (from === undefined || !settled[from]) continue
      best = Math.max(best, (layer[from] ?? 0) + 1)
    }
    layer[node] = best
  }
  return layer
}

/** Weakly connected components, in seedOrder. Disconnected input is the normal case, not an edge
 * case: a pack's feature_rules are mutually independent by construction, so a whole pack's graph
 * is usually one component per rule. */
function findComponents(model: Model): number[][] {
  const componentOf = new Array<number>(model.ids.length).fill(-1)
  const components: number[][] = []
  for (const start of model.seedOrder) {
    if (componentOf[start] !== -1) continue
    const members: number[] = []
    const queue = [start]
    componentOf[start] = components.length
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] ?? 0
      members.push(node)
      for (const e of model.out[node] ?? []) {
        const to = model.edges[e]?.to
        if (to === undefined || componentOf[to] !== -1) continue
        componentOf[to] = components.length
        queue.push(to)
      }
      for (const e of model.in[node] ?? []) {
        const from = model.edges[e]?.from
        if (from === undefined || componentOf[from] !== -1) continue
        componentOf[from] = components.length
        queue.push(from)
      }
    }
    components.push(members)
  }
  return components
}

/** One item in a layer's ordering: either a real node, or a "dummy" standing in for one layer of
 * a long edge.
 *
 * Dummies are what stop a three-layer edge being drawn straight through an unrelated box in the
 * layer between. They take part in ordering and in coordinate assignment exactly like nodes,
 * reserving a lane for the edge, and are then thrown away -- the caller never sees them. They
 * cost a little vertical space and buy the single biggest readability win in the algorithm,
 * because long edges are common in a feature graph (a rule delegating straight to a leaf feature
 * that other features reach through three wrappers). */
interface OrderItem {
  /** Model node index, or -1 for a dummy. */
  node: number
  layer: number
  /** Item ids in the adjacent layers. */
  up: number[]
  down: number[]
}

interface ComponentLayout {
  /** Node index -> y of the box's TOP edge, relative to this component's own top. */
  tops: Array<[number, number]>
  height: number
}

function layoutComponent(
  model: Model,
  members: number[],
  layer: number[],
  backEdge: boolean[],
  opts: ResolvedOptions,
): ComponentLayout {
  const memberSet = new Set(members)
  const items: OrderItem[] = []
  const itemOfNode = new Map<number, number>()
  let maxLayer = 0
  // Nodes are created in seedOrder, not in member order, so that the initial ordering -- and
  // every stable-sort tie-break downstream -- follows the one order the whole module uses.
  const ordered = model.seedOrder.filter((node) => memberSet.has(node))
  for (const node of ordered) {
    const nodeLayer = layer[node] ?? 0
    itemOfNode.set(node, items.length)
    items.push({ node, layer: nodeLayer, up: [], down: [] })
    maxLayer = Math.max(maxLayer, nodeLayer)
  }

  // Chain every edge through dummies. A back edge is chained in its REVERSED direction (from its
  // deeper endpoint back to its shallower one) so that it still reserves a lane and still counts
  // as a crossing -- a cycle a reader cannot see is worse than one drawn as a long edge running
  // backwards.
  const chainOf = new Map<number, Array<[number, number]>>() // edge index -> [layer, item id] per layer it spans
  for (let e = 0; e < model.edges.length; e++) {
    const edge = model.edges[e]
    if (edge === undefined || !memberSet.has(edge.from) || !memberSet.has(edge.to)) continue
    const forward = !backEdge[e]
    const head = forward ? edge.from : edge.to
    const tail = forward ? edge.to : edge.from
    const headLayer = layer[head] ?? 0
    const tailLayer = layer[tail] ?? 0
    // Same layer (or worse) means the edge has no horizontal span to route: a self delegation, or
    // a back edge between two nodes the layering happened to put in one column. Nothing to order,
    // and nothing that can cross.
    if (headLayer >= tailLayer) continue
    let previous = itemOfNode.get(head)
    const tailItem = itemOfNode.get(tail)
    if (previous === undefined || tailItem === undefined) continue
    const chain: Array<[number, number]> = []
    for (let l = headLayer + 1; l < tailLayer; l++) {
      const dummy = items.length
      items.push({ node: -1, layer: l, up: [], down: [] })
      link(items, previous, dummy)
      chain.push([l, dummy])
      previous = dummy
    }
    link(items, previous, tailItem)
    chain.push([tailLayer, tailItem])
    chainOf.set(e, chain)
  }

  const layers: number[][] = []
  for (let l = 0; l <= maxLayer; l++) layers.push([])
  seedInitialOrder(items, layers)

  const pos = new Array<number>(items.length).fill(0)
  const reindex = (): void => {
    for (const line of layers) {
      for (let i = 0; i < line.length; i++) {
        const item = line[i]
        if (item !== undefined) pos[item] = i
      }
    }
  }
  reindex()

  const constraints = buildSequenceConstraints(model, ordered, chainOf)
  applySequenceConstraints(layers, pos, constraints)
  reindex()

  let best = layers.map((line) => line.slice())
  let bestCrossings = countCrossings(items, layers, pos)
  for (let sweep = 0; sweep < ORDERING_SWEEPS && bestCrossings > 0; sweep++) {
    medianSweep(items, layers, pos, sweep % 2 === 0)
    reindex()
    transposeSweep(items, layers, pos)
    applySequenceConstraints(layers, pos, constraints)
    reindex()
    const crossings = countCrossings(items, layers, pos)
    // Strictly fewer, so the earliest ordering wins a tie -- another small piece of determinism,
    // and it means an already-good input ordering is never churned for no gain.
    if (crossings < bestCrossings) {
      bestCrossings = crossings
      best = layers.map((line) => line.slice())
    }
  }
  for (let l = 0; l < layers.length; l++) layers[l] = best[l] ?? []
  reindex()

  return assignCoordinates(items, layers, opts)
}

function link(items: OrderItem[], upper: number, lower: number): void {
  items[upper]?.down.push(lower)
  items[lower]?.up.push(upper)
}

/** The initial per-layer ordering: a depth-first walk forwards from the layer-0 items, appending
 * each item to its layer the first time it is reached. For the tree-shaped majority of a feature
 * graph this alone is close to crossing-free -- siblings land adjacent and a subtree stays in one
 * horizontal band -- which matters because the median sweeps below improve an ordering but cannot
 * rescue a bad one. */
function seedInitialOrder(items: OrderItem[], layers: number[][]): void {
  const placed = new Array<boolean>(items.length).fill(false)
  const visit = (start: number): void => {
    const stack = [start]
    while (stack.length > 0) {
      const item = stack.pop() ?? 0
      if (placed[item]) continue
      placed[item] = true
      layers[items[item]?.layer ?? 0]?.push(item)
      const down = items[item]?.down ?? []
      // Pushed in reverse so the stack pops them in their own order -- a sequence feature's
      // children therefore start out in ordinal order for free, before any constraint is applied.
      for (let i = down.length - 1; i >= 0; i--) {
        const next = down[i]
        if (next !== undefined && !placed[next]) stack.push(next)
      }
    }
  }
  for (let item = 0; item < items.length; item++) {
    if (items[item]?.layer === 0) visit(item)
  }
  // Anything a forward walk could not reach (a node whose only incoming edge was a back edge).
  for (let item = 0; item < items.length; item++) {
    if (!placed[item]) {
      placed[item] = true
      layers[items[item]?.layer ?? 0]?.push(item)
    }
  }
}

/** Per sequence parent, the item ids that must appear in this order within a given layer. Built
 * from the edge CHAINS rather than from the child nodes, so that a sequence child the layering
 * pushed further right still constrains the lane its edge passes through -- otherwise a sequence
 * whose children ended up in different layers would only be half-ordered, and half an execution
 * order on screen is worse than none. */
type SequenceConstraints = Array<Map<number, number[]>>

function buildSequenceConstraints(
  model: Model,
  ordered: number[],
  chainOf: Map<number, Array<[number, number]>>,
): SequenceConstraints {
  const constraints: SequenceConstraints = []
  for (const parent of ordered) {
    const sequenceEdges = (model.out[parent] ?? []).filter((e) => model.edges[e]?.kind === 'sequence')
    if (sequenceEdges.length < 2) continue
    // Stable sort by ordinal, tie-broken by the edge's own position in the wire `edges` array, so
    // two entries that (wrongly) share an ordinal still get a fixed order rather than a coin flip.
    const sorted = sequenceEdges
      .map((e, i) => ({ e, i, ordinal: model.edges[e]?.ordinal ?? 0 }))
      .sort((a, b) => a.ordinal - b.ordinal || a.i - b.i)
    const byLayer = new Map<number, number[]>()
    for (const { e } of sorted) {
      for (const [itemLayer, item] of chainOf.get(e) ?? []) {
        const line = byLayer.get(itemLayer) ?? []
        // A sequence that delegates to the same feature twice yields one item with two ordinals;
        // it can only be in one place, so the earlier ordinal is the one that positions it.
        if (!line.includes(item)) line.push(item)
        byLayer.set(itemLayer, line)
      }
    }
    for (const [itemLayer, line] of byLayer) {
      if (line.length < 2) byLayer.delete(itemLayer) // a lone item constrains nothing
    }
    if (byLayer.size > 0) constraints.push(byLayer)
  }
  return constraints
}

/** Re-imposes ordinal order on each sequence parent's children WITHOUT changing which slots in
 * the layer they occupy: the constrained items' current positions are collected, sorted, and the
 * items dealt back into them in ordinal order. Done this way the constraint costs almost no
 * crossings -- the ordering heuristic already chose good slots, this only decides who sits in
 * which -- whereas moving the children into a contiguous block would undo the sweep's work.
 *
 * Two sequence parents sharing a child can of course disagree about where it goes. They are
 * applied in seedOrder and the last one wins: a deliberate "some order is shown, and it is the
 * same one every time" rather than an attempt to satisfy an unsatisfiable pair of constraints. */
function applySequenceConstraints(layers: number[][], pos: number[], constraints: SequenceConstraints): void {
  for (const byLayer of constraints) {
    for (const [layerIndex, wanted] of byLayer) {
      const line = layers[layerIndex]
      if (line === undefined) continue
      const slots = wanted.map((item) => pos[item] ?? 0).sort((a, b) => a - b)
      for (let i = 0; i < wanted.length; i++) {
        const slot = slots[i]
        const item = wanted[i]
        if (slot === undefined || item === undefined) continue
        line[slot] = item
      }
      for (let i = 0; i < line.length; i++) {
        const item = line[i]
        if (item !== undefined) pos[item] = i
      }
    }
  }
}

/** One median-heuristic pass: each item moves to the median position of its neighbours in the
 * layer just laid out, and the layer is re-sorted. The median rather than the mean is the
 * standard choice because it is insensitive to one far-away neighbour dragging a node across the
 * whole drawing -- and a feature graph has exactly that shape, with shared leaves reached from
 * the top and the bottom of a layer at once. */
function medianSweep(items: OrderItem[], layers: number[][], pos: number[], downward: boolean): void {
  const indices = layers.map((_, i) => i)
  const order = downward ? indices.slice(1) : indices.slice(0, -1).reverse()
  for (const layerIndex of order) {
    const line = layers[layerIndex]
    if (line === undefined || line.length < 2) continue
    const keyed = line.map((item, index) => {
      const neighbours = (downward ? items[item]?.up : items[item]?.down) ?? []
      // An item with no neighbours keys on its own current index, so it holds still relative to
      // the items around it instead of being swept to the top of the layer.
      return { item, index, key: neighbours.length === 0 ? index : medianOf(neighbours.map((n) => pos[n] ?? 0)) }
    })
    keyed.sort((a, b) => a.key - b.key || a.index - b.index)
    for (let i = 0; i < keyed.length; i++) {
      const entry = keyed[i]
      if (entry !== undefined) line[i] = entry.item
    }
    for (let i = 0; i < line.length; i++) {
      const item = line[i]
      if (item !== undefined) pos[item] = i
    }
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** The transpose step: swap adjacent pairs whenever the swap strictly reduces the crossings they
 * are involved in. This is what takes a median-sorted drawing from "mostly untangled" to
 * "untangled", and each check is local, so it is cheap. Bounded rounds and strict improvement
 * only -- so it cannot oscillate between two equally good orderings, which would be a
 * non-determinism bug rather than merely slow. */
function transposeSweep(items: OrderItem[], layers: number[][], pos: number[]): void {
  for (let round = 0; round < TRANSPOSE_ROUNDS; round++) {
    let improved = false
    for (const line of layers) {
      for (let i = 0; i + 1 < line.length; i++) {
        const left = line[i]
        const right = line[i + 1]
        if (left === undefined || right === undefined) continue
        if (localCrossings(items, pos, right, left) < localCrossings(items, pos, left, right)) {
          line[i] = right
          line[i + 1] = left
          pos[right] = i
          pos[left] = i + 1
          improved = true
        }
      }
    }
    if (!improved) break
  }
}

/** Crossings contributed by the pair (first above second) in that vertical order, counting both
 * the edges leaving them upwards and the edges leaving them downwards. */
function localCrossings(items: OrderItem[], pos: number[], first: number, second: number): number {
  let count = 0
  for (const side of ['up', 'down'] as const) {
    const above = items[first]?.[side] ?? []
    const below = items[second]?.[side] ?? []
    for (const x of above) {
      for (const y of below) {
        if ((pos[y] ?? 0) < (pos[x] ?? 0)) count++
      }
    }
  }
  return count
}

/** Total edge crossings in the current ordering. Counted as inversions: walk a layer top to
 * bottom, emit each item's down-neighbour positions in order, and every out-of-order pair in the
 * resulting sequence is exactly one crossing. Merge-sort counting rather than the obvious double
 * loop, because this runs on every sweep and one wide layer (a scatter with fifty entries) would
 * make the quadratic version the slowest thing in the editor. */
function countCrossings(items: OrderItem[], layers: number[][], pos: number[]): number {
  let total = 0
  for (const line of layers) {
    const sequence: number[] = []
    for (const item of line) {
      const down = (items[item]?.down ?? []).map((n) => pos[n] ?? 0).sort((a, b) => a - b)
      for (const value of down) sequence.push(value)
    }
    total += countInversions(sequence)
  }
  return total
}

function countInversions(values: number[]): number {
  if (values.length < 2) return 0
  const work = values.slice()
  const buffer = new Array<number>(values.length).fill(0)
  return mergeCount(work, buffer, 0, work.length)
}

function mergeCount(a: number[], buffer: number[], lo: number, hi: number): number {
  if (hi - lo < 2) return 0
  const mid = (lo + hi) >> 1
  let count = mergeCount(a, buffer, lo, mid) + mergeCount(a, buffer, mid, hi)
  let i = lo
  let j = mid
  let k = lo
  while (i < mid && j < hi) {
    if ((a[i] ?? 0) <= (a[j] ?? 0)) buffer[k++] = a[i++] ?? 0
    else {
      count += mid - i // every item still in the left half is an inversion with this one
      buffer[k++] = a[j++] ?? 0
    }
  }
  while (i < mid) buffer[k++] = a[i++] ?? 0
  while (j < hi) buffer[k++] = a[j++] ?? 0
  for (let t = lo; t < hi; t++) a[t] = buffer[t] ?? 0
  return count
}

/** Phase 4. Turns the per-layer ORDER into per-layer y coordinates: repeatedly pull each item
 * towards the average of its neighbours in the adjacent layer, then push the layer back apart to
 * the minimum spacing. The push-apart is an exact solve, not a nudge (see solveSeparation), so
 * boxes cannot end up overlapping however strongly the averages pull them together -- an overlap
 * is the one layout defect a reader cannot work around. */
function assignCoordinates(items: OrderItem[], layers: number[][], opts: ResolvedOptions): ComponentLayout {
  // A dummy has no box, so it has no height: it claims only the rowGap on either side of it,
  // which is exactly the lane its edge needs and no more.
  const heightOf = (item: number): number => ((items[item]?.node ?? -1) >= 0 ? opts.nodeHeight : 0)
  const centre = new Array<number>(items.length).fill(0)
  for (const line of layers) {
    let cursor = 0
    for (const item of line) {
      const h = heightOf(item)
      centre[item] = cursor + h / 2
      cursor += h + opts.rowGap
    }
  }

  for (let pass = 0; pass < COORDINATE_PASSES; pass++) {
    const downward = pass % 2 === 0
    const indices = layers.map((_, i) => i)
    const order = downward ? indices.slice(1) : indices.slice(0, -1).reverse()
    for (const layerIndex of order) {
      const line = layers[layerIndex]
      if (line === undefined || line.length === 0) continue
      const desired = line.map((item) => {
        const neighbours = (downward ? items[item]?.up : items[item]?.down) ?? []
        if (neighbours.length === 0) return centre[item] ?? 0
        let sum = 0
        for (const n of neighbours) sum += centre[n] ?? 0
        return sum / neighbours.length
      })
      const gaps = line.map((item, i) => {
        if (i === 0) return 0
        const previous = line[i - 1]
        return (heightOf(previous ?? item) + heightOf(item)) / 2 + opts.rowGap
      })
      const solved = solveSeparation(desired, gaps)
      for (let i = 0; i < line.length; i++) {
        const item = line[i]
        if (item !== undefined) centre[item] = solved[i] ?? 0
      }
    }
  }

  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const line of layers) {
    for (const item of line) {
      const h = heightOf(item)
      const c = centre[item] ?? 0
      top = Math.min(top, c - h / 2)
      bottom = Math.max(bottom, c + h / 2)
    }
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
    top = 0
    bottom = 0
  }

  const tops: Array<[number, number]> = []
  for (const line of layers) {
    for (const item of line) {
      const node = items[item]?.node ?? -1
      if (node < 0) continue // dummies did their work in the ordering; they are never drawn
      tops.push([node, (centre[item] ?? 0) - opts.nodeHeight / 2 - top])
    }
  }
  return { tops, height: bottom - top }
}

/** Places `desired.length` items on a line, in the given order, at least `gaps[i]` apart, as
 * close to `desired` as that allows -- exactly, in the least-squares sense, in linear time.
 *
 * This is pool-adjacent-violators (isotonic regression) after substituting the gaps out: with
 * `z[i] = y[i] - sum(gaps[0..i])` the "at least gaps apart" constraint becomes plain "z is
 * non-decreasing", which PAVA solves optimally by merging adjacent out-of-order blocks and
 * placing each merged block at its members' mean.
 *
 * Worth the twenty lines over the usual "walk down the layer pushing overlaps apart": that greedy
 * version only ever pushes one way, so every pass drifts the whole layer downwards, and a node
 * whose neighbours are all above it still gets shoved below one that has no preference at all.
 * This puts each block exactly where its members collectively want it, which is what makes a
 * parent sit centred on its children rather than level with the first of them. */
function solveSeparation(desired: number[], gaps: number[]): number[] {
  const n = desired.length
  const offsets = new Array<number>(n).fill(0)
  let running = 0
  for (let i = 0; i < n; i++) {
    running += gaps[i] ?? 0
    offsets[i] = running
  }
  // Block b starts at starts[b]; sums/counts give its members' mean position in the shifted space.
  const starts: number[] = []
  const sums: number[] = []
  const counts: number[] = []
  for (let i = 0; i < n; i++) {
    starts.push(i)
    sums.push((desired[i] ?? 0) - (offsets[i] ?? 0))
    counts.push(1)
    while (starts.length > 1) {
      const last = starts.length - 1
      const meanLast = (sums[last] ?? 0) / (counts[last] ?? 1)
      const meanPrevious = (sums[last - 1] ?? 0) / (counts[last - 1] ?? 1)
      if (meanPrevious <= meanLast) break
      sums[last - 1] = (sums[last - 1] ?? 0) + (sums[last] ?? 0)
      counts[last - 1] = (counts[last - 1] ?? 0) + (counts[last] ?? 0)
      starts.pop()
      sums.pop()
      counts.pop()
    }
  }
  const out = new Array<number>(n).fill(0)
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b] ?? 0
    const to = b + 1 < starts.length ? starts[b + 1] ?? n : n
    const mean = (sums[b] ?? 0) / (counts[b] ?? 1)
    for (let i = from; i < to; i++) out[i] = mean + (offsets[i] ?? 0)
  }
  return out
}
