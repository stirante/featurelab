// render.ts -- draws a wire.Graph (see wire/graph.go, the frozen contract) into a VS Code
// webview, and handles pan/zoom/selection. Rendering and interaction ONLY: it fetches nothing,
// writes nothing, registers no commands, and never acts on a selection -- it emits the
// selection and lets its host decide what that means (open the file, focus the form, jump to
// the JSONPath). See GraphView.onSelect's own doc comment for why acting on it here would be
// the wrong layer.
//
// The same division holds for the one gesture here that CHANGES something: dragging a connection
// from one node to another (see beginLink). This file draws the line, hit-tests the drop and
// shows whether it is legal -- and what a connection MEANS is connect.ts's, which it asks. A
// completed connection is reported and nothing is drawn for it; the new edge arrives on the next
// render(), from a graph the host rebuilt after writing the file.
//
// # Why HTML nodes over an SVG-only scene
//
// Edges are SVG (paths, arrowheads, curvature) because they are geometry; nodes and edge chips
// are plain HTML because they are TEXT -- a node shows an id, a type and a coverage status, all
// of which need ellipsis truncation, a real font stack, and `--vscode-*` theming, none of which
// SVG <text> gives without reimplementing them. Both layers live inside ONE transformed
// container (see applyCamera), so pan/zoom is a single CSS transform on a single element rather
// than a re-layout, and the two layers cannot drift apart.
//
// # What the drawing is trying to make answerable
//
// The graph is NOT a tree and it converges hard: the contract addresses features by
// "namespace:id" and shares them, and on this repo's own fixture pack forty roots reach
// seventeen children, one of which has eleven parents. Three decisions here follow from that,
// and none of them is styling:
//
//   - EDGES ATTACH AT PORTS (assignPorts), not at node centres. Eleven lines drawn to one box's
//     centre arrive as a blot; eleven drawn to eleven points down its border arrive as a fan
//     that can be counted and traced back. The curve leaves horizontally and arrives
//     horizontally, matching the layered left-to-right layout, so a bundle reads as a bundle.
//   - SELECTING A NODE QUIETS THE REST (paintIncidence). Drawing those eleven lines better does
//     not answer "which one is mine" -- the thirty-nine other lines crossing them are the
//     problem. Opacity only, on elements that stay exactly where they are and stay clickable.
//   - THE CARD CHANGES WITH ZOOM, not just its size (ZOOM_BAND_FAR). A framed fifty-seven-node
//     pack puts a card at thirty pixels wide, where a label is a smear; out there the card is a
//     solid block in its category's colour, because the shape of the pack is the only question
//     that scale can answer.
//
// A node's CATEGORY -- and therefore its colour and its glyph -- is derived from its own
// outgoing edge kinds (summariseNodes), never from a table of `minecraft:*` type names. The edge
// kinds are the frozen contract; a type list would be a second copy of the engine's knowledge,
// would go stale, and would have nothing to say about a type it had not heard of.
//
// # Moving a node, and why a move is not a re-render
//
// An automatic layout produces a starting arrangement; arranging it by hand is how the drawing
// comes to mean something, so dragging a node is the primary gesture here and not a nicety. Three
// things follow.
//
//   - THE GESTURES DO NOT FIGHT. A primary-button press on a card drags the CARD; the same press
//     on the background pans the CAMERA; the middle button pans from anywhere, card included.
//     There is no mode and no modifier to remember, because the thing under the pointer already
//     says which of the two is meant.
//   - A MOVE RE-ROUTES, IT DOES NOT REDRAW (rerouteEdges). Edges attach at ports computed from
//     node positions, so moving a card has to move its edges -- but calling render() for that
//     rebuilds every element on the canvas, and it was MEASURED at about 10 ms for this repo's
//     own 57-node fixture pack and 144 ms at 900 nodes, in Chromium, for the scripting alone.
//     144 ms is nine dropped frames per pointermove; 10 ms is most of a frame's budget spent
//     re-creating elements that did not change. So a drag writes `left`/`top` on the one card
//     that moved and then re-runs only the PURE geometry (assignPorts, which is where a port's
//     slot is decided and therefore cannot be done per-edge), touching the `d` of an edge only
//     when its ports actually came out somewhere new. On the same 900-node graph that is about
//     3 ms, and on the fixture pack it is a fraction of a millisecond. The whole thing is
//     rAF-coalesced, so a trackpad emitting moves faster than the compositor paints still costs
//     one pass per frame.
//   - THE VIEW REPORTS A MOVE AND PERSISTS NOTHING (onNodeMove). Where positions are stored is
//     the host's business, exactly as what a selection MEANS is -- see onSelect. The report
//     fires once per finished gesture rather than per frame, because on the other end of it is a
//     file being written.
//
// # Cycles, and why nothing here can hang on one
//
// wire.Graph.Cycles exists because the graph is NOT a tree -- features are shared by
// "namespace:id" and a delegation cycle is legal (the engine guards recursion at run time
// instead of forbidding it). Nothing in this file walks the graph recursively or transitively:
// every pass is a flat iteration over `nodes` and `edges`, so a cycle costs exactly as much as
// the same number of acyclic edges. resolvePositions() -- the one place that infers anything
// from graph SHAPE -- is deliberately single-pass for the same reason (see its own doc
// comment). The camera is rAF-coalesced and schedules a frame only when it actually changes,
// so there is no permanently-running draw loop to hang in the first place.
//
// # Untrusted text
//
// Every string here (node ids, type ids, Molang conditions, coverage notes) comes out of a
// pack's own JSON files. Nothing is ever assigned through innerHTML -- only textContent and
// setAttribute -- so a feature named `<img onerror=...>` is text, not markup.

import { connectSourcePreview, previewConnection } from './connect.js'

/** The `minecraft:*` feature type namespace, stripped from a node's type line for display --
 * see renderNode's own comment for why (the full value is kept in the title/dataset). */
const MINECRAFT_NS = 'minecraft:'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Node box size, in layout (world) units.
 *
 * FIXED, not content-derived, and exported so the layout module someone else owns can place
 * boxes it does not itself render without guessing their extent -- a layout that has to measure
 * the DOM to lay out the DOM is a circular dependency, and one that assumes a size this file
 * later changes silently overlaps every node. media/graph.css hard-codes the same two numbers
 * on `.flg-node` and says so; they must move together. */
export const GRAPH_NODE_WIDTH = 232
export const GRAPH_NODE_HEIGHT = 86

/** How far a node's edges attach outside its box, so an arrowhead tip lands just off the
 * border rather than under it. */
const EDGE_GAP = 4

/** How far a routed edge's control point reaches horizontally out of its port, as a fraction of
 * the horizontal span, clamped between these two. This is what makes an edge leave a node
 * HORIZONTALLY and arrive at the next one horizontally: the layout is layered left to right, so
 * every edge that shares a direction also shares a departure angle, and a bundle of them reads
 * as a bundle instead of as a starburst. The floor keeps a short hop from collapsing into a
 * corner; the ceiling keeps a long one from ballooning across two layers. */
const EDGE_REACH_FRACTION = 0.45
const EDGE_REACH_MIN = 34
const EDGE_REACH_MAX = 190
/** Extra reach per pixel of vertical travel: an edge that has to climb four rows needs a longer
 * horizontal run before it turns, or it leaves its port at a near-vertical angle and the whole
 * point of porting is lost. */
const EDGE_REACH_PER_DROP = 0.14

/** Bounds on resolvePositions' fallback placement -- see that function's own doc comment. A
 * fallback slot is tried against everything already occupied, and a BOUNDED number of slots is
 * tried before the node drops to the strand grid, so no graph can turn placement into a search.
 * FALLBACK_CLEARANCE is the gap a fallback box keeps from its neighbours; without one, two boxes
 * sharing an edge read as a single wider box. */
const FALLBACK_SLOTS = 24
const FALLBACK_SLOT_ROWS = 6
const FALLBACK_STRAND_COLUMNS = 8
const FALLBACK_CLEARANCE = 12

/** Separation between parallel edges joining the SAME pair of nodes. Real packs do delegate to
 * the same feature twice from one parent (an aggregate listing a feature in two slots), and a
 * 2-cycle draws A->B and B->A between the same pair; without a per-edge bow they stack into one
 * line and one of the two chips -- one of the two MEANINGS -- is invisible.
 *
 * Ports (see assignPorts) already separate such a pair at both ENDS; the bow is what separates
 * them in the MIDDLE, which is where their chips sit. */
const EDGE_BOW_STEP = 30

/** Arrowheads are kept small on purpose. They sit at the ports, and a node with eleven parents
 * has eleven of them seven pixels apart -- a head much wider than that fuses the fan into one
 * wedge and destroys the count the ports exist to make visible. */
const ARROW_LENGTH = 10
const ARROW_HALF_WIDTH = 4

/** The three levels of detail, keyed off the `data-zoom-band` attribute this file stamps on the
 * root (media/graph.css does the hiding). Purely a CSS visibility switch -- no re-render, so
 * zooming back in cannot lose anything.
 *
 *   far  -- chips gone, every line of node text gone, cards drawn as solid category-coloured
 *           blocks. This is not a degraded view, it is the RIGHT one at that scale: a
 *           fifty-seven-node pack framed in a panel puts a card at about thirty pixels wide, and
 *           an 11px label there is a smear. Colour and position still carry the shape of the
 *           pack, which is the only question answerable from that far out, and every block still
 *           answers `title` on hover.
 *   mid  -- identifier, type and the state badges. No fan-out line, no coverage note: those are
 *           sentences, and a sentence at 60% scale is not read, it is squinted at.
 *   near -- everything.
 *
 * The thresholds are where the SMALLEST text in each band stops being readable: the 11px type
 * line at 0.55 is 6px, and the 10px fan/note lines at 0.9 are 9px. ZOOM_BAND_NEAR sits just
 * BELOW 1 on purpose -- the default camera is zoom 1, and a threshold above it would mean the
 * view someone opens on is the abbreviated one. */
const ZOOM_BAND_FAR = 0.55
const ZOOM_BAND_NEAR = 0.9

const DEFAULT_MIN_ZOOM = 0.1
const DEFAULT_MAX_ZOOM = 4

/** How far a pointer must travel, in SCREEN pixels, before a press on a card stops being a click
 * and becomes a drag.
 *
 * This number is the whole difference between a canvas you can select things on and one you
 * cannot. A mouse moves one or two pixels under an ordinary click -- more on a trackpad, more
 * again on a touchscreen -- and a view that treats any movement at all as a drag registers no
 * clicks, silently, for the people whose hands are least steady. Screen pixels rather than world
 * units on purpose: the tremor is in the hand, not in the drawing, so the threshold must not
 * shrink as the user zooms in. */
const DRAG_THRESHOLD_PX = 3

/** How close, in SCREEN pixels, a dragged card's edge or centre has to come to another card's
 * before it snaps into line with it.
 *
 * Alignment snapping rather than a fixed grid, because a grid is the wrong tool for this drawing:
 * the automatic layout does not place anything on a round number, so a card snapped to a 16- or
 * 48-unit grid lines up with the grid and with nothing the user can see. Snapping to the cards
 * that are ALREADY THERE is what actually produces a tidy column, which is the thing someone
 * rearranging a layered graph is trying to make. Held ALT defeats it -- see applyDrag -- and a
 * guide line is drawn at whatever the card locked onto, so the snap is never a mystery. */
const SNAP_PX = 6

/** Arrow-key nudge, in world units; SHIFT takes the larger one. A node that can only be moved
 * with a mouse cannot be moved by everyone, and these are the numbers a nudge is useful at on a
 * canvas whose cards are 232 units wide: one unit per press would be unusable, and a whole card
 * width per press is not a nudge. */
const NUDGE_STEP = 8
const NUDGE_STEP_LARGE = 40

/** How long after the last arrow-key nudge the move is reported.
 *
 * A drag has an obvious end -- the release. A keyboard nudge does not, and reporting each press
 * would turn holding an arrow key down into a file write per repeat. So presses are coalesced
 * into one gesture the same way a drag is, and the settle window is short enough that the save
 * still feels immediate. */
const NUDGE_SETTLE_MS = 300

/** An expanded group's frame: how far it reaches outside its members' boxes, and how tall the
 * header strip above them is. media/graph.css sizes `.flg-frame-head` to FRAME_HEAD and says so. */
const FRAME_PAD = 14
const FRAME_HEAD = 24

/** How much Molang (a condition, a scatter's iterations) fits on a chip face before it is
 * elided. The full expression always survives in the chip's `title`, and this file never
 * pretends the short form is the expression -- see truncate(). */
const MOLANG_CHIP_CHARS = 24

// ---------------------------------------------------------------------------
// The wire contract, as TypeScript
// ---------------------------------------------------------------------------

/** Mirrors wire.GraphNode (wire/graph.go). Optional-vs-required here follows Go's `omitempty`
 * exactly: a field Go omits when empty is optional here, and a field it always emits is not. */
export interface GraphNodeWire {
  id: string
  typeId?: string
  file?: string
  formatVersion?: string
  coverage?: string
  coverageNote?: string
  fields?: Record<string, unknown>
  annotations?: GraphAnnotationWire[]
  unresolved?: boolean
  /** Mirrors wire.GraphNode.External: an unresolved reference the GAME provides, rather than one
   * the pack forgot.
   *
   * The distinction is not a nicety, and drawing it is the difference between a warning people
   * read and one they stop seeing. In practice, almost every unresolved reference is one of
   * these -- `minecraft:bush_feature` and friends, in the game's own namespace, resolving
   * perfectly well at run time -- and every one of them was being drawn hatched, dashed and
   * error-coloured, telling the author to check the spelling of a name that was spelled
   * correctly. So an external node is drawn as a node that is FINE and simply lives elsewhere:
   * present, quiet, with nothing to open, and never in the error palette. See renderNode. */
  external?: boolean
  /** Set on the ONE synthetic node a collapsed feature group draws as -- see graph/groups.ts's
   * collapseGroups, which makes these. Not on the wire from the engine: a group is presentation
   * the author declared, folded into a card by the webview before the graph reaches here. A node
   * carrying this is drawn as a group card rather than a feature card, and its `id` is the
   * group's node id (`group:<groupId>`), which is what the selection and a drag report. */
  group?: GraphNodeGroupWire
}

/** What a collapsed group's card is drawn from. Mirrors graph/groups.ts's GroupNodeSummary. */
export interface GraphNodeGroupWire {
  readonly id: string
  readonly name: string
  /** How many members the card stands for. */
  readonly count: number
}

/** An EXPANDED group, as the renderer draws it: a frame behind its members' cards, sized to their
 * bounding box, with a header carrying the name. The renderer draws the frame from the member
 * rects it already has and moves it with them; what a group IS stays in graph/groups.ts. */
export interface GraphFrameWire {
  readonly groupId: string
  readonly name: string
  readonly memberIds: readonly string[]
}

/** Mirrors wire.Annotation. Carried through to the selection payload untouched -- this file
 * renders one marker for "this node has annotations" and leaves reading them to the host. */
export interface GraphAnnotationWire {
  name: string
  args?: string[]
  text?: string
  jsonPath: string
  line: number
}

/** Mirrors wire.EdgeKind -- all EIGHT values, each rendered as its own kind.
 *
 * Six of them carry per-edge data (ordinal, weight, condition, iterations). The other two are
 * structural and are NOT folded into a neighbour, because folding them is what makes a graph
 * lie: `rule` is the entry point an editor opens on, and `child` is a named single-child slot
 * whose parent neither filters nor scatters (`vegetation_patch_feature.vegetation_feature`,
 * `tree_feature.log_decoration_feature`). A renderer that has no `child` draws those parents
 * with no outgoing edges at all -- which, on this repo's own vanilla-trees fixture, is 5 of 24
 * files silently showing as leaves. */
export type GraphEdgeKind = 'rule' | 'aggregate' | 'sequence' | 'weighted' | 'conditional' | 'scatter' | 'filter' | 'child'

/** Mirrors wire.GraphEdge.
 *
 * `weight`, `condition` and `iterations` are `T | null | undefined` rather than `T | undefined`
 * on purpose. Go's pointer-with-omitempty omits the key when nil, so `undefined` is what
 * actually arrives -- but the DISTINCTION the contract exists to preserve ("the author wrote no
 * condition" vs "the author wrote 1.0"; "the author wrote no weight" vs "the author wrote 1")
 * must not depend on a decoder somewhere upstream happening to normalise an absent key to
 * `null` instead. Both spellings mean "not written" here; see describeEdge(). */
export interface GraphEdgeWire {
  from: string
  to: string
  kind: GraphEdgeKind
  jsonPath: string
  ordinal: number
  weight?: number | null
  condition?: string | null
  iterations?: string | null
  /** Where `condition` / `iterations` actually live, for an editor writing one back.
   *
   * Neither is derivable from `jsonPath`, which names the `places_feature` the edge was read
   * from -- the Molang sits BESIDE that key, so `jsonPath + '.iterations'` addresses a member of
   * a string. A scatter's `iterations` is worse still: it is legal nested under `distribution`
   * and flat on the body, and only the engine knows which one the file used. Absent when the
   * engine predates the field or the edge kind has no such slot. */
  conditionPath?: string
  iterationsPath?: string
  required: boolean
}

/** Mirrors wire.Graph. */
export interface GraphWire {
  nodes: GraphNodeWire[]
  edges: GraphEdgeWire[]
  roots: string[]
  cycles?: string[][]
}

// ---------------------------------------------------------------------------
// Public geometry / camera / selection types
// ---------------------------------------------------------------------------

export interface GraphPoint {
  x: number
  y: number
}

export interface GraphRect {
  x: number
  y: number
  w: number
  h: number
}

export interface GraphCamera {
  /** World-space point drawn at the host's top-left, in world units. */
  x: number
  y: number
  /** World units per CSS pixel. */
  zoom: number
}

/** What a click/keyboard activation reports. `null` is a real value (the user clicked empty
 * canvas), not "nothing happened". */
export type GraphSelection =
  | { kind: 'node'; nodeId: string; node: GraphNodeWire }
  | { kind: 'edge'; edgeKey: string; edgeIndex: number; edge: GraphEdgeWire }
  /** Several nodes at once -- ctrl/cmd+click added to a selection, or a shift+drag marquee.
   * Always two or more: one node is a `node` selection, and every consumer that handles one
   * keeps working unchanged. Ids only, in the order they were picked; a consumer with the graph
   * can look the nodes up, and a payload of N node objects would be N stale copies the moment
   * the graph was redrawn. */
  | { kind: 'nodes'; nodeIds: readonly string[] }
  /** A feature group, by its own id -- whether it is drawn as a frame (expanded) or as one card
   * (collapsed). The header of the frame and the card both select this. */
  | { kind: 'group'; groupId: string }
  | null

/** What ONE RUN measured about one node, as the card draws it.
 *
 * Three counters and a sentence, and the three counters stay three. graph/nodeStats.ts's header
 * argues the case and this interface is where that argument becomes structural: there is no
 * "cost" field here to collapse them into, because a wrapper that delegates 900 000 times
 * without writing a block and a leaf that writes 900 000 blocks are different problems, and one
 * blended number would present them as the same one.
 *
 * This module deliberately does NOT know what a profile is. It is handed a finished row per node
 * and draws it -- the caller (webview/graph.ts) owns nodeStats.ts, the phrasing and the decision
 * about which nodes get a row at all. A renderer that read a profile would be a renderer with an
 * opinion about what a run means. */
export interface NodeCardStats {
  /** Times this feature's own Place ran. */
  readonly entered: number
  /** Blocks it wrote while it was the INNERMOST feature executing -- a leaf's writes are the
   * leaf's, not its outermost ancestor's. */
  readonly blocksWritten: number
  /** Hand-offs to sub-features, including ones whose target ultimately wrote nothing. */
  readonly delegations: number
  /** One sentence about this run, for the card's own tooltip. Written by the caller so the
   * wording lives with the module that owns it. */
  readonly summary: string
  /** Where this run stopped short inside the node -- an iterations of 0, a failed chance, a false
   * condition -- as the caller phrased it. `ordinal` names the outgoing edge (its GraphEdge
   * ordinal) the stop applies to; absent means the whole node, and every edge leaving it. */
  readonly stops?: readonly NodeCardStop[]
}

export interface NodeCardStop {
  readonly label: string
  readonly title: string
  readonly ordinal?: number
}

export interface GraphViewOptions {
  /** What a layout's `{x, y}` names on a node box. `'topLeft'` by default: the layout module
   * computes positions WITHOUT rendering, so the only anchor it can produce with no knowledge
   * of the rendered box is a corner -- and GRAPH_NODE_WIDTH/HEIGHT are exported precisely so a
   * layout that prefers centres can opt into `'center'` and still agree with what is drawn. */
  positionAnchor?: 'topLeft' | 'center'
  /** What a bare mouse wheel does. `'pan'` by default, matching the editor this webview is
   * docked next to: VS Code's own text editor scrolls on a bare wheel and zooms on ctrl+wheel,
   * and a canvas that instead flies toward the pointer on a stray scroll is the single most
   * common complaint about embedded graph views. `'zoom'` is offered for a host that wants the
   * standalone-graph-editor idiom. ctrl/cmd+wheel ALWAYS zooms regardless, because that is also
   * what a trackpad pinch sends. */
  wheelBehavior?: 'pan' | 'zoom'
  minZoom?: number
  maxZoom?: number
  /** Accessible name for the canvas as a whole. */
  ariaLabel?: string
  /** What a connection MEANS. Omitted, the view uses connect.ts's own answer, which reads the
   * graph it was handed and knows the format's delegation keys; `false` turns the gesture off
   * entirely and draws no connector handles.
   *
   * A host overrides it when it knows something the canvas cannot -- a file already open with
   * unsaved edits, a pack it is not allowed to write to. It never overrides it to make a
   * connection mean something else: what an edit does belongs in one place, and connect.ts is
   * that place. */
  connectPolicy?: GraphConnectPolicy | false
}

/** One node the user moved, as onNodeMove reports it.
 *
 * `position` and `from` are in GRAPH coordinates and follow GraphViewOptions.positionAnchor
 * exactly -- they are in the same space, and name the same point on the box, as the `positions`
 * map render() was handed. A host can therefore write one straight back without arithmetic, and
 * a host that opted into `'center'` is not silently handed a corner. */
export interface GraphNodeMove {
  nodeId: string
  node: GraphNodeWire
  /** Where the node is now. */
  position: GraphPoint
  /** Where it was when the gesture started -- not where it was one frame ago. A host that wants
   * an undo entry needs the start of the gesture, and a host that does not can ignore it. */
  from: GraphPoint
}

/** The DOM events this view dispatches on its host element, in addition to the onSelect/
 * onActivate/onNodeMove subscriptions. All bubble and are `composed`, so a host can listen once
 * on an ancestor instead of holding the GraphView reference -- which is what lets the
 * message-handling half of a webview stay decoupled from the rendering half. `detail` is the
 * GraphSelection, except on GRAPH_MOVE_EVENT where it is the `readonly GraphNodeMove[]`. */
export const GRAPH_SELECT_EVENT = 'flg-select'
export const GRAPH_ACTIVATE_EVENT = 'flg-activate'
export const GRAPH_MOVE_EVENT = 'flg-move'
export const GRAPH_CONNECT_EVENT = 'flg-connect'

/** What a proposed connection would do, in the few words a label at the pointer can hold.
 *
 * Structurally what connect.ts's `ConnectPreview` returns, so the default policy hands one
 * straight through -- the view asks the question and does not answer it. */
export interface GraphConnectVerdict {
  readonly allowed: boolean
  /** Three or four words. Shown on the chip that follows the pointer. */
  readonly label: string
  /** One sentence: what it will do, or why it will not. */
  readonly detail: string
  /** Values the author will be asked for after the drop, if any. A connection that will open a
   * form is still legal, and saying so BEFORE the drop is the difference between a question and
   * a surprise. */
  readonly asks?: readonly string[]
  /** The delegation the drop would overwrite, when it overwrites one. */
  readonly replaces?: string | undefined
}

/** Where the meaning of a connection comes from. The view draws the gesture and knows nothing
 * about feature types; this answers both halves of "may I", and its answers are what the line,
 * the target card and the chip at the pointer are drawn from.
 *
 * Both methods must be CHEAP and PURE: `check` is called on every pointer move that changes which
 * card is under the cursor, and `canStart` once per card per render. */
export interface GraphConnectPolicy {
  /** Whether this node can hold another feature at all, asked before there is a target. A drag
   * from a feature that places blocks itself has to refuse at the moment it starts, not after the
   * author has hauled a line across the canvas. */
  canStart(nodeId: string): GraphConnectVerdict
  check(from: string, to: string): GraphConnectVerdict
}

/** A connection the user actually completed. The view has changed NOTHING -- exactly as it
 * reports a move and persists nothing, and emits a selection and acts on nothing. Turning this
 * into an edit is the host's business, and connect.ts's `planConnection` is what turns it into
 * one. */
export interface GraphConnectRequest {
  readonly from: string
  readonly to: string
  /** The verdict the user was shown while the line was in their hand, so the host can tell
   * whether it is about to open a form and does not have to re-derive it. */
  readonly verdict: GraphConnectVerdict
}

export interface GraphView {
  /** The element this view owns, appended to the host. Exposed for a caller that needs to size
   * or style the canvas; do not reparent it. */
  readonly element: HTMLElement
  /** Draws `graph` with node boxes placed by `positions`. Idempotent and safe to call on every
   * update: the camera is NOT reset (a re-render after an edit must not throw away where the
   * user was looking), and a selection whose node/edge still exists survives. */
  render(graph: GraphWire, positions: ReadonlyMap<string, GraphPoint>, frames?: readonly GraphFrameWire[]): void
  /** Applies a selection WITHOUT emitting -- for a host driving selection from outside (the
   * text editor's cursor moved onto a feature, say). Emitting here instead would make every
   * host that both listens and sets have to break its own feedback loop. */
  setSelection(selection: GraphSelection): void
  getSelection(): GraphSelection
  /** Fires for a USER selection only. Returns an unsubscribe. */
  onSelect(listener: (selection: GraphSelection) => void): () => void
  /** Fires on double-click / Enter -- "open this", as distinct from "select this". Same
   * payload; the host decides what opening means. */
  onActivate(listener: (selection: GraphSelection) => void): () => void
  /** Fires when the user finishes MOVING one or more nodes -- a drag released, or a burst of
   * arrow-key nudges settled. Returns an unsubscribe.
   *
   * Once per gesture, never per frame. On the other end of this is a file: positions have
   * nowhere to live in the vanilla schema, so a host persists them in a sidecar, and a
   * subscription that fired on every pointermove would ask it to write that file sixty times a
   * second. This view itself stores NOTHING -- the next render() is authoritative about where a
   * node sits, exactly as it always was, so a host that drops the report on the floor gets a
   * node that snaps back on the next redraw. That is the honest outcome, not a bug: this module
   * draws, and where a drawing is saved is not a rendering decision.
   *
   * An ARRAY rather than a single move, even though a drag moves one node today: the host's job
   * is a file write, and a write per node is the wrong shape for a gesture that may move
   * several. Nudging two nodes inside one settle window already delivers two. */
  onNodeMove(listener: (moves: readonly GraphNodeMove[]) => void): () => void
  /** Fires when the user finishes a CONNECTION gesture on a target the policy allowed. Returns
   * an unsubscribe.
   *
   * Nothing is drawn as a result: the new edge appears on the next render(), from a graph the
   * host rebuilt after writing the file, exactly as every other change to the pack does. A view
   * that drew the edge optimistically would be showing a delegation that does not exist yet, and
   * would still be showing it after the write failed. */
  onConnect(listener: (request: GraphConnectRequest) => void): () => void
  /** Fires when the user asks a group to fold or unfold -- the chevron on a frame's header, the
   * chevron or a double-click on a collapsed card. `collapsed` is the state ASKED FOR. Nothing is
   * redrawn here: the state lives in the pack files, the host writes it, and the next render()
   * brings the group back in its new shape -- exactly as a connection is reported and not drawn. */
  onGroupToggle(listener: (groupId: string, collapsed: boolean) => void): () => void
  /** Starts a connection from `nodeId` with the KEYBOARD -- the same state the connector handle
   * enters on Enter. Exposed so a host can offer it from a menu or a command. No-op for an
   * unknown id, and for a node the policy will not let a connection start from. */
  beginConnection(nodeId: string): void
  /** Abandons a connection gesture in flight, pointer or keyboard. No-op when there is none. */
  cancelConnection(): void
  getCamera(): GraphCamera
  setCamera(camera: Partial<GraphCamera>): void
  /** Frames everything currently drawn, including the dangling stubs of unresolved nodes.
   * No-op on an empty graph. */
  zoomToFit(paddingPx?: number): void
  /** Centres the camera on one node without changing zoom. No-op for an unknown id. */
  focusNode(nodeId: string): void
  /** Puts one run's measurements on the cards it has rows for, and takes them off every other
   * card. `null` takes them off all of them -- which is the state this view starts in and
   * returns to whenever there is no profile, and it leaves a card byte-for-byte the card it was
   * before anything measured anything.
   *
   * A node with NO entry is left alone rather than given an empty row. "This run did not enter
   * it" is a real and frequent state (a preview runs one feature; every other node in the pack
   * is in it), and stamping fifty-six cards with a nought would teach a reader to stop looking
   * at the row on the one card where it matters.
   *
   * Applied in place, without re-rendering: a result arriving while somebody is mid-drag must
   * not cancel their drag, which is what render() does by design. The stats are also re-applied
   * by render() itself, so a redraw after an edit keeps them. */
  setNodeStats(stats: ReadonlyMap<string, NodeCardStats> | null): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Pure helpers -- no DOM, exported so they can be tested (and reused) directly
// ---------------------------------------------------------------------------

/** A stable identity for an edge. wire.GraphEdge has no id field, so one has to be derived:
 * `from` plus `jsonPath` is exactly it, because JSONPath "locates this edge inside From's file"
 * (wire/graph.go) and a file cannot have two different edges at one path. The array index is
 * reported alongside it in the selection for a host that would rather index than match, but the
 * index is NOT the identity -- it changes whenever the engine re-walks the pack. */
export function edgeKey(edge: GraphEdgeWire): string {
  // JSON.stringify rather than a joined string: there is no separator character to pick,
  // and so none to pick badly. An earlier version of this file joined the halves with an
  // invisible byte, a caller re-spelled that byte as an ordinary space, and every lookup
  // missed without raising anything.
  return JSON.stringify([edge.from, edge.jsonPath])
}

/** What a `weighted` edge's weight actually is when the engine picks.
 *
 * The contract keeps Weight nil when the file wrote none, and is explicit that the 1.0 default
 * "is the engine's to apply, not this graph's" -- an editor that renders an absent weight as a
 * written 1.0 will write that 1.0 back, turning merely opening a pack into a diff. So the
 * default is applied HERE, for ARITHMETIC only: the share a chip shows has to be the share the
 * engine will actually roll, and treating an absent weight as 0 would report a perfectly
 * ordinary entry as one that never gets picked. describeEdge still renders "wrote 1" and "wrote
 * nothing" differently -- the same distinction, for the same reason, as a nil Condition. */
const DEFAULT_WEIGHT = 1

export function effectiveWeight(edge: GraphEdgeWire): number {
  return typeof edge.weight === 'number' ? edge.weight : DEFAULT_WEIGHT
}

/** Per-`from`, per-kind sibling groups. A weight and an ordinal are both meaningless in
 * isolation -- "weight 5" says nothing without the other weights, and "step 2" says nothing
 * without the length -- so every chip that shows one of those needs its siblings first. */
export interface EdgeSiblings {
  /** Every edge leaving the same node with the same kind, in `graph.edges` order. */
  group: readonly GraphEdgeWire[]
  /** Sum of effectiveWeight() across the group -- see that function for why an absent weight
   * counts as 1 here and still renders as "not written" on the chip. */
  weightTotal: number
  /** Ordinals seen more than once in this group. Only interesting for `sequence`, where a
   * duplicate ordinal means the execution order -- and therefore the generated world -- is not
   * actually determined by what is on screen. */
  duplicateOrdinals: ReadonlySet<number>
}

/** The composite key shape is PRIVATE -- callers hand siblingsFor() an edge rather than
 * building a key. That is not ceremony: an earlier version joined the two halves with an
 * invisible separator byte, a caller re-spelled it as an ordinary space, and every lookup
 * missed in silence. A key nobody outside this module can spell cannot be misspelled, and
 * JSON.stringify has no separator to collide with a feature id in the first place. */
function siblingKey(edge: GraphEdgeWire): string {
  return JSON.stringify([edge.from, edge.kind])
}

export function buildSiblingIndex(edges: readonly GraphEdgeWire[]): Map<string, EdgeSiblings> {
  const groups = new Map<string, GraphEdgeWire[]>()
  for (const edge of edges) {
    const key = siblingKey(edge)
    const existing = groups.get(key)
    if (existing) existing.push(edge)
    else groups.set(key, [edge])
  }
  const out = new Map<string, EdgeSiblings>()
  for (const [key, group] of groups) {
    let weightTotal = 0
    const seen = new Set<number>()
    const duplicateOrdinals = new Set<number>()
    for (const edge of group) {
      weightTotal += effectiveWeight(edge)
      if (seen.has(edge.ordinal)) duplicateOrdinals.add(edge.ordinal)
      seen.add(edge.ordinal)
    }
    out.set(key, { group, weightTotal, duplicateOrdinals })
  }
  return out
}

/** The group `edge` belongs to, or a one-edge group standing in for it. Exported because
 * describeEdge needs an EdgeSiblings and the key shape that finds one is deliberately not
 * spellable from outside -- see siblingKey. */
export function siblingsFor(index: ReadonlyMap<string, EdgeSiblings>, edge: GraphEdgeWire): EdgeSiblings {
  return index.get(siblingKey(edge)) ?? { group: [edge], weightTotal: effectiveWeight(edge), duplicateOrdinals: new Set() }
}

/** The chip an edge draws, as data. Pure, so the "does a sequence edge actually show its
 * ordinal / does a null condition actually read differently from a written one" questions are
 * answerable in a test without a browser. */
export interface EdgeBadge {
  /** Leading glyph. Kind-identifying at a glance and never the only signal -- the line's dash
   * pattern and the chip's own modifier classes carry the same information, because colour and
   * a single glyph both fail in a high-contrast theme. */
  mark: string
  /** The chip's face text. Short by construction. */
  label: string
  /** Smaller trailing text, or '' for none. */
  detail: string
  /** Modifier suffixes the chip element gets as `flg-chip-<modifier>` classes. */
  modifiers: string[]
  /** 0..1 when the chip draws a proportional bar (weighted edges only), else null. */
  share: number | null
  /** The un-elided truth, shown on hover/focus. Every chip has one, and every chip whose face
   * is truncated says the whole thing here. */
  title: string
}

/** The property key an edge was written under, read off its JSONPath -- `$.minecraft:
 * vegetation_patch_feature.vegetation_feature` gives `vegetation_feature`. This is what a
 * `child` edge is labelled with, on the contract's own instruction: the kind deliberately says
 * nothing about what such a child MEANS, because the meaning is type-specific, and the key is
 * "the only honest label". Returns '' for a path that ends in an array index or that this
 * cannot read, which the caller falls back on. */
export function jsonPathKey(jsonPath: string): string {
  // Trailing subscripts first: a child slot is never an array element, but being robust about
  // it costs one regex and avoids labelling an edge "[2]".
  const withoutIndex = jsonPath.replace(/\[\d+\]$/, '')
  const bracketed = /\[['"]([^'"]+)['"]\]$/.exec(withoutIndex)
  if (bracketed?.[1]) return bracketed[1]
  const segments = withoutIndex.split('.')
  const last = segments[segments.length - 1] ?? ''
  return last === '$' ? '' : last
}

/** What one edge should say. This is where "the kinds are not interchangeable" is actually
 * decided, so the reasoning per kind is written out rather than left to the reader:
 *
 *   - `sequence` gets a filled NUMBER and nothing else on its face. The ordinal is execution
 *     order, and execution order is part of the RNG contract, so it is the one edge label that
 *     must be legible at a glance from across the canvas.
 *   - `aggregate` therefore gets NO number on its face at all -- it says "unordered". Its
 *     ordinal is only "the order the keys appear in the file" (wire/graph.go), and putting that
 *     number on a chip is exactly how someone comes to believe an aggregate runs in order.
 *     Confusing the two silently changes a world, so they are made to not even share a shape.
 *   - `weighted` shows its weight AND its share of the sibling total, because a weight alone is
 *     not a probability -- "5" means 50% next to one 5 and 5% next to a 95. An UNWRITTEN weight
 *     is shown as the engine's default and marked as defaulted, never as a written 1.
 *   - `child` is labelled with the key it was written under, because the contract says the kind
 *     itself cannot say what the child means and the key is the only honest label available.
 *   - `conditional` distinguishes a null condition ("always", muted, plain type) from a written
 *     one (the Molang, in the code font). The contract models the absent case as nil rather
 *     than a synthesised "1.0" precisely so this distinction is renderable; synthesising "1.0"
 *     back into the chip would throw away the only thing that was preserved.
 *   - `scatter` shows `iterations` in the CODE font, and flags it as an expression when it
 *     isn't a bare number -- it is full Molang evaluated in a scope shared with the child, and
 *     real packs use it as a condition (evaluate to 0) and as a setup step (assign
 *     `variable.*`). A chip that renders it as a plain count teaches the wrong model of it.
 *   - `filter` says which of the two things a wrapping type decides -- whether to delegate, and
 *     where -- rather than naming a count it does not have.
 *   - `rule` is the entry point: one per rule, always required.
 */
export function describeEdge(edge: GraphEdgeWire, siblings: EdgeSiblings): EdgeBadge {
  const modifiers: string[] = [edge.kind]
  if (edge.required) modifiers.push('required')
  const requiredNote = edge.required ? '\nRequired: the type cannot load without this edge, so removing it is an error rather than an edit.' : ''
  const at = `\n${edge.from} -> ${edge.to}\nat ${edge.jsonPath}`

  switch (edge.kind) {
    case 'sequence': {
      const count = siblings.group.length
      const step = edge.ordinal + 1
      const duplicated = siblings.duplicateOrdinals.has(edge.ordinal)
      if (duplicated) modifiers.push('suspect')
      return {
        mark: '',
        label: String(step),
        detail: `/${count}`,
        modifiers,
        share: null,
        title:
          `sequence: runs ${ordinalWord(step)} of ${count}.\n` +
          'Order is load-bearing -- it decides what the generated world looks like, not just how the file reads.\n' +
          `JSON index ${edge.ordinal} (0-based); this chip counts from 1.` +
          (duplicated ? `\nWARNING: another entry in this sequence also claims index ${edge.ordinal}, so the order shown here is not actually determined.` : '') +
          requiredNote +
          at,
      }
    }
    case 'aggregate':
      return {
        mark: '≡',
        label: 'unordered',
        detail: '',
        modifiers,
        share: null,
        title:
          `aggregate: one entry of an unordered list of ${siblings.group.length}.\n` +
          'Deliberately shows no step number: an aggregate entry\'s ordinal is only the order the keys appear in the file, not an execution order.\n' +
          `File position ${edge.ordinal + 1} of ${siblings.group.length}.` +
          requiredNote +
          at,
      }
    case 'weighted': {
      const wasWritten = typeof edge.weight === 'number'
      const weight = effectiveWeight(edge)
      const total = siblings.weightTotal
      const share = total > 0 ? weight / total : null
      // "Defaulted", not "suspect": an omitted weight is perfectly ordinary authoring, and the
      // chip's job is to say the number came from the engine rather than from the file, so
      // nobody edits a 1 that was never there. Contrast a WRITTEN 0, which is a real problem.
      if (!wasWritten) modifiers.push('defaulted')
      if (total <= 0) modifiers.push('suspect')
      else if (wasWritten && weight === 0) modifiers.push('suspect')
      return {
        mark: 'w',
        label: formatNumber(weight),
        detail: share === null ? 'of 0' : `${(share * 100).toFixed(share * 100 < 10 ? 1 : 0)}%`,
        modifiers,
        share,
        title:
          (wasWritten
            ? `weighted_random: weight ${formatNumber(weight)}`
            : `weighted_random: NO weight written -- the engine defaults an absent weight to ${formatNumber(DEFAULT_WEIGHT)}, and that ${formatNumber(DEFAULT_WEIGHT)} is shown here so the share is the one the engine will actually roll.\nThe file does not contain this number; editing it would add a key the file never had.\nEffective weight ${formatNumber(weight)}`) +
          ` of ${formatNumber(total)} across ${siblings.group.length} sibling(s)` +
          (share === null
            ? '.\nWARNING: the sibling weights sum to zero, so no share can be computed and this entry has no meaningful chance.'
            : ` -- about ${(share * 100).toFixed(1)}% of picks.` + (wasWritten && weight === 0 ? '\nWARNING: weight 0 was written explicitly -- this entry is never picked.' : '')) +
          '\nA weight is only meaningful against its siblings; the percentage is this edge\'s share of the group.' +
          requiredNote +
          at,
      }
    }
    case 'conditional': {
      const written = typeof edge.condition === 'string'
      if (!written) {
        modifiers.push('always')
        return {
          mark: '?',
          label: 'always',
          detail: '',
          modifiers,
          share: null,
          title:
            'conditional_list entry with NO condition written.\n' +
            'The JSON omits `condition` entirely, which the engine reads as the constant 1.0 -- always eligible.\n' +
            'This is shown differently from a written condition on purpose: "the author wrote nothing" and "the author wrote 1.0" are different edits to make.' +
            requiredNote +
            at,
        }
      }
      const expression = edge.condition ?? ''
      modifiers.push('molang')
      return {
        mark: '?',
        label: truncate(expression, MOLANG_CHIP_CHARS),
        detail: '',
        modifiers,
        share: null,
        title: `conditional_list entry, condition as written:\n${expression}` + requiredNote + at,
      }
    }
    case 'scatter': {
      const written = typeof edge.iterations === 'string' ? edge.iterations : ''
      const numeric = written !== '' && Number.isFinite(Number(written))
      modifiers.push('molang')
      if (!numeric && written !== '') modifiers.push('expression')
      return {
        mark: '×',
        label: written === '' ? '?' : truncate(written, MOLANG_CHIP_CHARS),
        detail: numeric || written === '' ? '' : 'molang',
        modifiers,
        share: null,
        title:
          'scatter_feature: `iterations`, as written:\n' +
          (written === '' ? '(absent)' : written) +
          '\n\nThis is a full Molang expression, not a count. It is evaluated against a scope SHARED with everything the scatter delegates to, so real packs also use it as a condition (evaluating to 0 stops placement, which the engine diagnoses specifically) and as a setup step (assigning `variable.*` the placed feature then reads).' +
          requiredNote +
          at,
      }
    }
    case 'filter':
      return {
        mark: '▽',
        label: 'filter',
        detail: '',
        modifiers,
        share: null,
        title:
          'The single child of a wrapping type (snap_to_surface, surface_relative_threshold, height_difference_filter, scan_surface, search).\n' +
          'The parent decides WHETHER to delegate and WHERE -- the child is placed somewhere the parent chose, or not at all.' +
          requiredNote +
          at,
      }
    case 'child': {
      // The kind says nothing about meaning because the meaning is type-specific
      // (`vegetation_patch_feature.vegetation_feature` and `tree_feature`'s
      // `log_decoration_feature` do quite different things). The KEY is what the contract
      // names as the only honest label, so that is what the chip shows -- and when the path
      // yields no key, the chip says "child" rather than inventing a meaning.
      const key = jsonPathKey(edge.jsonPath)
      return {
        mark: '↳',
        label: key ? truncate(key, MOLANG_CHIP_CHARS) : 'child',
        detail: '',
        modifiers,
        share: null,
        title:
          (key ? `A named single-child slot, written under \`${key}\`.\n` : 'A named single-child slot.\n') +
          'The parent neither filters nor scatters -- it simply has a feature in a field. What that means is specific to the parent type, so this chip names the key rather than guessing at a meaning.' +
          requiredNote +
          at,
      }
    }
    case 'rule':
      return {
        mark: '▶',
        label: 'places',
        detail: '',
        modifiers,
        share: null,
        title: 'A feature rule\'s places_feature -- the graph\'s entry point. Exactly one per rule.' + requiredNote + at,
      }
    default: {
      // An edge kind added to the contract after this file was written. Rendering it as an
      // unlabelled line would be indistinguishable from an aggregate; saying "unknown kind" is
      // the only honest thing a renderer can do about a meaning it does not know.
      const unknown = String((edge as GraphEdgeWire).kind)
      return {
        mark: '!',
        label: unknown || 'unknown',
        detail: '',
        modifiers: ['unknown'],
        share: null,
        title: `Unrecognised edge kind "${unknown}" -- this renderer predates it and cannot say what it means.` + at,
      }
    }
  }
}

/** Coverage, as the node renders it. `implemented` gets no badge: a badge on every node is a
 * badge on none, and the point of the row is to make the exceptions findable. */
export interface CoverageBadge {
  /** '' when nothing should be drawn. */
  label: string
  /** Modifier suffix for `flg-coverage-<tone>`. */
  tone: 'missing' | 'out-of-scope' | 'unresolved' | 'external' | 'none'
  title: string
}

export function describeCoverage(node: GraphNodeWire): CoverageBadge {
  // BEFORE the unresolved branch, because an external node is unresolved too and the two say
  // opposite things. "The pack does not define this" is a fault with an action attached; "the
  // game provides this" is not a fault at all, and putting the second one in the first one's
  // words is how a warning stops being read.
  if (node.external) {
    return {
      label: 'from the game',
      tone: 'external',
      title:
        `"${node.id}" is provided by the game, not by this pack. The delegation resolves when the world generates, so there is nothing to fix here -- ` +
        'and nothing to open either, because no file in this pack defines it.\n' +
        'Nothing appears for it in a preview: this tool does not simulate the features the game itself supplies. That is a fact about the preview, not about the pack.',
    }
  }
  if (node.unresolved) {
    return {
      label: 'unresolved',
      tone: 'unresolved',
      title: `Something delegates to "${node.id}" and this pack does not define it. The edge is drawn dangling rather than dropped, so the broken reference is visible instead of silent.`,
    }
  }
  const note = node.coverageNote ? `\n${node.coverageNote}` : ''
  switch (node.coverage) {
    case 'partial':
      // No badge. Most types in a real pack are partial, identically on every node of the type
      // and whatever the author writes, so the badge was on most of the canvas and said nothing
      // about any one node. The note is in the documentation panel behind the section `?`.
      return { label: '', tone: 'none', title: '' }
    case 'missing':
      return { label: 'missing', tone: 'missing', title: `This feature type is not implemented by this tool.${note}` }
    case 'out_of_scope':
      return { label: 'out of scope', tone: 'out-of-scope', title: `This feature type is deliberately out of scope for this tool.${note}` }
    default:
      return { label: '', tone: 'none', title: node.coverageNote ?? '' }
  }
}

/** What a node IS, for the purpose of colouring and marking it.
 *
 * Derived from the node's OUTGOING EDGE KINDS, never from a table of type ids. That is the whole
 * point: a node whose children are `sequence` edges is a sequence feature, and the graph already
 * says so. A type list here would be a second copy of the engine's knowledge, would be wrong the
 * day a type is added, and would have nothing to say about a type it had not heard of -- whereas
 * the edge kinds are the frozen contract and cannot drift.
 *
 * The payoff on the canvas is that a node and the edges leaving it share one hue, so a chain
 * reads as a chain: an orange box with orange lines running out of it into the boxes it
 * sequences. `leaf` is a node with no outgoing edges at all -- the thing that actually places
 * blocks -- and is deliberately the quietest category, because on a real pack it is most of
 * them. */
export type NodeCategory = GraphEdgeKind | 'leaf' | 'unresolved' | 'external'

/** Leading glyph per category. Present so the category is never carried by colour alone: these
 * are the same marks the matching edge chips use, so "the ▽ box" and "the ▽ chips leaving it"
 * are the same statement twice. */
const CATEGORY_MARK: Record<NodeCategory, string> = {
  rule: '▶',
  sequence: '↓',
  aggregate: '≡',
  weighted: 'w',
  conditional: '?',
  scatter: '×',
  filter: '▽',
  child: '↳',
  leaf: '■',
  unresolved: '!',
  // A hollow diamond, and deliberately not a variant of the unresolved '!': the glyph is the
  // half of this distinction that survives a grayscale print and a high-contrast theme, so the
  // two states must not share a shape. '!' says something is wrong; '◇' says the thing is
  // somewhere else.
  external: '◇',
}

/** The per-node facts a card can show that its FIELDS cannot. A tree feature with fifteen trunk
 * variants has no room to show them, but "delegates to 3, and 11 things delegate to it" fits and
 * is what someone tracing a pack actually needs -- this graph's real shape is dozens of parents
 * sharing a handful of children, so fan-IN is the number that tells you a box is load-bearing. */
export interface NodeSummary {
  category: NodeCategory
  mark: string
  /** Outgoing edge count, and incoming edge count. */
  out: number
  in: number
  /** Outgoing edge kinds, most frequent first, ties broken by first appearance. */
  outByKind: ReadonlyArray<readonly [GraphEdgeKind, number]>
}

const EMPTY_SUMMARY: NodeSummary = { category: 'leaf', mark: CATEGORY_MARK.leaf, out: 0, in: 0, outByKind: [] }

/** One flat pass over `edges` -- no traversal, so a cycle costs exactly what the same number of
 * acyclic edges costs. Exported so "does a node with only `filter` children read as a filter"
 * is answerable without a browser. */
export function summariseNodes(graph: GraphWire): Map<string, NodeSummary> {
  const outKinds = new Map<string, Map<GraphEdgeKind, number>>()
  const outCount = new Map<string, number>()
  const inCount = new Map<string, number>()
  for (const edge of graph.edges) {
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1)
    inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1)
    let kinds = outKinds.get(edge.from)
    if (!kinds) {
      kinds = new Map()
      outKinds.set(edge.from, kinds)
    }
    kinds.set(edge.kind, (kinds.get(edge.kind) ?? 0) + 1)
  }

  const out = new Map<string, NodeSummary>()
  const ids = new Set<string>()
  for (const node of graph.nodes) ids.add(node.id)
  for (const edge of graph.edges) {
    ids.add(edge.from)
    ids.add(edge.to)
  }
  const unresolved = new Set<string>()
  const external = new Set<string>()
  for (const node of graph.nodes) {
    if (node.external) external.add(node.id)
    else if (node.unresolved) unresolved.add(node.id)
  }

  for (const id of ids) {
    const kinds = outKinds.get(id)
    const byKind: Array<readonly [GraphEdgeKind, number]> = kinds ? [...kinds.entries()] : []
    // Descending by count; insertion order (which is graph.edges order, and therefore
    // deterministic per the contract) breaks ties, so the same pack always colours the same.
    byKind.sort((a, b) => b[1] - a[1])
    const dominant = byKind[0]?.[0]
    const category: NodeCategory = external.has(id) ? 'external' : unresolved.has(id) ? 'unresolved' : (dominant ?? 'leaf')
    out.set(id, {
      category,
      mark: CATEGORY_MARK[category] ?? CATEGORY_MARK.leaf,
      out: outCount.get(id) ?? 0,
      in: inCount.get(id) ?? 0,
      outByKind: byKind,
    })
  }
  return out
}

/** The meta line a card shows under its type: how many children, of what kind, and how many
 * things point AT it. Returns '' for either half that has nothing worth saying -- a leaf nobody
 * shares is the common case and does not need a row telling it so. */
export function describeFanOut(summary: NodeSummary): { label: string; title: string } {
  if (summary.out === 0) return { label: '', title: '' }
  const parts = summary.outByKind.map(([kind, n]) => `${n} ${kind}`)
  const label = summary.outByKind.length === 1 ? `${summary.out} ${summary.outByKind[0]![0]}` : `${summary.out} children`
  return { label, title: `Delegates to ${summary.out}: ${parts.join(', ')}.` }
}

export function describeFanIn(summary: NodeSummary): { label: string; title: string } {
  // One parent is unremarkable; two or more means the node is SHARED, and editing it changes
  // every one of them. That is the fact worth a row.
  if (summary.in < 2) return { label: '', title: '' }
  return {
    label: String(summary.in),
    title: `${summary.in} features delegate to this one -- editing it changes all ${summary.in}.`,
  }
}

/** Places every node box, in world units, keyed by id.
 *
 * `positions` is the layout module's output and is authoritative wherever it has an entry. This
 * function exists for the entries it does NOT have, which is not a hypothetical: an unresolved
 * node is a reference the pack does not define, and a layout that walks from the roots can
 * legitimately produce no position for one. The contract is explicit that such a node "exists so
 * a broken reference is a visible dangling edge rather than a missing node", so dropping it for
 * want of a coordinate would defeat the one thing it is for.
 *
 * The fallback is deliberately dumb and SINGLE-PASS: a node with a known-positioned predecessor
 * is parked near that predecessor, and everything else lands in a grid below the placed content.
 * It never follows an edge out of a node it placed in this same pass, so it cannot chase a cycle
 * and cannot be made to loop by any input -- which is the property that matters here, far more
 * than the placement being pretty.
 *
 * It does, however, have to AVOID what the layout already placed, and that is not cosmetic. The
 * first version parked a dangling node at a fixed offset from its parent and landed it exactly
 * on top of a real node in the layout's own grid -- which hid that node and, because the
 * dangling box is on top, made it unclickable. A stub drawn to prove nothing is hidden must not
 * itself hide something. So each fallback slot is checked against everything already occupied,
 * over a BOUNDED candidate list (FALLBACK_SLOTS); if every candidate collides, the node drops to
 * the strand grid, which is below all placed content and therefore always free. Bounded, so no
 * input can turn placement into a search.
 *
 * `ghosts` reports ids that appear only as an edge endpoint and not in `graph.nodes` at all.
 * The contract says that cannot happen (an unresolved reference is materialised as a node), but
 * an edge silently vanishing is the worst possible failure for a view whose job is showing
 * delegations, so those endpoints are materialised here instead. */
export function resolvePositions(
  graph: GraphWire,
  positions: ReadonlyMap<string, GraphPoint>,
  anchor: 'topLeft' | 'center' = 'topLeft',
): { rects: Map<string, GraphRect>; ghosts: Set<string> } {
  const rects = new Map<string, GraphRect>()
  const ghosts = new Set<string>()

  const toRect = (p: GraphPoint): GraphRect =>
    anchor === 'center'
      ? { x: p.x - GRAPH_NODE_WIDTH / 2, y: p.y - GRAPH_NODE_HEIGHT / 2, w: GRAPH_NODE_WIDTH, h: GRAPH_NODE_HEIGHT }
      : { x: p.x, y: p.y, w: GRAPH_NODE_WIDTH, h: GRAPH_NODE_HEIGHT }

  const known = new Set<string>()
  for (const node of graph.nodes) known.add(node.id)
  for (const edge of graph.edges) {
    if (!known.has(edge.from)) ghosts.add(edge.from)
    if (!known.has(edge.to)) ghosts.add(edge.to)
  }

  const allIds: string[] = []
  for (const node of graph.nodes) allIds.push(node.id)
  for (const id of ghosts) allIds.push(id)

  let maxBottom = 0
  let minLeft = 0
  const unplaced: string[] = []
  const placedByLayout: GraphRect[] = []
  for (const id of allIds) {
    const p = positions.get(id)
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      unplaced.push(id)
      continue
    }
    const rect = toRect(p)
    rects.set(id, rect)
    placedByLayout.push(rect)
    maxBottom = Math.max(maxBottom, rect.y + rect.h)
    minLeft = Math.min(minLeft, rect.x)
  }
  if (unplaced.length === 0) return { rects, ghosts }

  // Everything a fallback slot must not land on: the layout's own boxes, plus the fallback
  // boxes already handed out in this pass. Collision only -- no edge is followed out of it, so
  // this is not a traversal and cannot revisit anything.
  const occupied: GraphRect[] = [...placedByLayout]
  const collides = (rect: GraphRect): boolean => {
    for (const other of occupied) {
      if (
        rect.x < other.x + other.w + FALLBACK_CLEARANCE &&
        other.x < rect.x + rect.w + FALLBACK_CLEARANCE &&
        rect.y < other.y + other.h + FALLBACK_CLEARANCE &&
        other.y < rect.y + rect.h + FALLBACK_CLEARANCE
      ) {
        return true
      }
    }
    return false
  }
  const take = (id: string, rect: GraphRect): void => {
    rects.set(id, rect)
    occupied.push(rect)
    maxBottom = Math.max(maxBottom, rect.y + rect.h)
  }

  const strandTop = maxBottom + GRAPH_NODE_HEIGHT
  let strandSlot = 0

  for (const id of unplaced) {
    // First incoming edge from a node the LAYOUT placed. Deliberately not from a node this loop
    // placed: following a fallback node's own parent is the step that could walk a cycle, and
    // the adjacency it would buy is worth nothing next to a guarantee of termination.
    let source: GraphRect | undefined
    for (const edge of graph.edges) {
      if (edge.to !== id) continue
      const candidate = rects.get(edge.from)
      if (candidate && placedByLayout.includes(candidate)) {
        source = candidate
        break
      }
    }

    let placed = false
    if (source) {
      for (let slot = 0; slot < FALLBACK_SLOTS; slot++) {
        const candidate: GraphRect = {
          x: source.x + GRAPH_NODE_WIDTH * 1.6 + Math.floor(slot / FALLBACK_SLOT_ROWS) * (GRAPH_NODE_WIDTH + 32),
          y: source.y + (slot % FALLBACK_SLOT_ROWS) * (GRAPH_NODE_HEIGHT + 16),
          w: GRAPH_NODE_WIDTH,
          h: GRAPH_NODE_HEIGHT,
        }
        if (collides(candidate)) continue
        take(id, candidate)
        placed = true
        break
      }
    }
    if (placed) continue

    // The strand grid: below everything the layout placed, so it is free by construction and
    // needs no collision check of its own.
    take(id, {
      x: minLeft + (strandSlot % FALLBACK_STRAND_COLUMNS) * (GRAPH_NODE_WIDTH + 32),
      y: strandTop + Math.floor(strandSlot / FALLBACK_STRAND_COLUMNS) * (GRAPH_NODE_HEIGHT + 24),
      w: GRAPH_NODE_WIDTH,
      h: GRAPH_NODE_HEIGHT,
    })
    strandSlot++
  }
  return { rects, ghosts }
}

/** Thousands-separated, with an explicit separator rather than toLocaleString -- the same choice
 * and the same reason as graph/nodeStats.ts's formatCount: a count that reads "1.234" on one
 * machine and "1,234" on another is a bug waiting for a bug report, and a webview's locale is
 * the user's. Duplicated rather than imported so this module keeps knowing nothing about
 * profiles; it is six lines of digit grouping, not a shared policy. */
function formatStatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const digits = Math.abs(Math.trunc(value)).toString()
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return value < 0 ? `-${out}` : out
}

function ordinalWord(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/** Elides the MIDDLE, not the tail. Molang is routinely `query.x > 3 && variable.y == 1`, where
 * the operator and the right-hand side are what distinguishes two conditions from each other --
 * tail truncation would render a whole conditional_list as a column of identical `query.`
 * prefixes. The full text is always on the element's title. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${flat.slice(0, head)}…${flat.slice(flat.length - tail)}`
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function centerOf(r: GraphRect): GraphPoint {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/** A point on a cubic Bezier, used to find where a chip should sit on its own edge. */
function cubicPoint(p0: GraphPoint, c1: GraphPoint, c2: GraphPoint, p1: GraphPoint, t: number): GraphPoint {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y }
}

function arrowPath(tip: GraphPoint, from: GraphPoint): string {
  const dx = tip.x - from.x
  const dy = tip.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const bx = tip.x - ux * ARROW_LENGTH
  const by = tip.y - uy * ARROW_LENGTH
  const nx = -uy * ARROW_HALF_WIDTH
  const ny = ux * ARROW_HALF_WIDTH
  return `M ${round(tip.x)} ${round(tip.y)} L ${round(bx + nx)} ${round(by + ny)} L ${round(bx - nx)} ${round(by - ny)} Z`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

interface EdgeGeometry {
  path: string
  arrow: string
  label: GraphPoint
  /** The cubic, kept so the chip can be slid along it -- see chipAnchor. Absent for a self
   * loop, whose label point is already clear of its own box by construction. */
  curve?: readonly [GraphPoint, GraphPoint, GraphPoint, GraphPoint]
}

/** Where along an edge its chip sits.
 *
 * The midpoint is the natural answer and is usually right: with horizontal tangents at both
 * ends, an edge between adjacent layers has its midpoint in the whitespace between them. It is
 * WRONG for an edge that spans several layers, whose midpoint lands squarely on whatever card
 * happens to sit in between -- and a label lying across another node's identifier is worse than
 * no label, because it damages two things at once.
 *
 * So the midpoint is tried first and the chip slides along its own curve until it is off every
 * card. The candidate list is FIXED and short, and the boxes are looked up in a coarse grid, so
 * this is a constant number of cheap tests per edge no matter how large the pack is -- the same
 * rule the fallback placement in resolvePositions follows, and for the same reason. */
const CHIP_ANCHOR_CANDIDATES = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82] as const
/** How far outside a card counts as "on" it, so a chip does not tuck against a border. */
const CHIP_CLEARANCE = 5
/** Chips are centred on their anchor and are wider than they are tall, so a bare point test
 * passes for a chip whose ENDS are lying across a card. Half a typical chip is tested either
 * side instead. Not the widest possible chip -- a long Molang condition would then never find a
 * gap between two layers at all -- but enough that the short, repeated ones stay clear. */
const CHIP_HALF_WIDTH = 22

/** A coarse bucket index over node rects: "which boxes are near this point", without scanning
 * every box for every candidate. Cell size is one node width, so a point's own cell plus its
 * eight neighbours covers everything that could possibly contain it. */
class RectGrid {
  private readonly cells = new Map<string, GraphRect[]>()
  private readonly cell = Math.max(GRAPH_NODE_WIDTH, GRAPH_NODE_HEIGHT)

  constructor(rects: Iterable<GraphRect>) {
    for (const rect of rects) {
      const x0 = Math.floor(rect.x / this.cell)
      const x1 = Math.floor((rect.x + rect.w) / this.cell)
      const y0 = Math.floor(rect.y / this.cell)
      const y1 = Math.floor((rect.y + rect.h) / this.cell)
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${x}|${y}`
          const list = this.cells.get(key)
          if (list) list.push(rect)
          else this.cells.set(key, [rect])
        }
      }
    }
  }

  covers(point: GraphPoint): boolean {
    const cx = Math.floor(point.x / this.cell)
    const cy = Math.floor(point.y / this.cell)
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const rect of this.cells.get(`${x}|${y}`) ?? []) {
          if (
            point.x >= rect.x - CHIP_CLEARANCE &&
            point.x <= rect.x + rect.w + CHIP_CLEARANCE &&
            point.y >= rect.y - CHIP_CLEARANCE &&
            point.y <= rect.y + rect.h + CHIP_CLEARANCE
          ) {
            return true
          }
        }
      }
    }
    return false
  }
}

function chipAnchor(geometry: EdgeGeometry, grid: RectGrid): GraphPoint {
  const curve = geometry.curve
  if (!curve) return geometry.label
  for (const t of CHIP_ANCHOR_CANDIDATES) {
    const point = cubicPoint(curve[0], curve[1], curve[2], curve[3], t)
    if (grid.covers(point)) continue
    if (grid.covers({ x: point.x - CHIP_HALF_WIDTH, y: point.y })) continue
    if (grid.covers({ x: point.x + CHIP_HALF_WIDTH, y: point.y })) continue
    return point
  }
  // Every candidate was over a card. Keeping the midpoint is the honest failure: the chip is
  // still on its own edge, which is what makes it readable as belonging to that edge at all.
  return geometry.label
}

/** A self-delegation loops above its own node instead of collapsing to a zero-length line.
 * These are real -- a cycle of length one is a feature that delegates to itself -- and a
 * zero-length line has no direction, so every downstream calculation (border intersection,
 * arrow tangent) divides by zero and the edge disappears exactly when it matters most. */
function selfLoopGeometry(rect: GraphRect, fanIndex: number): EdgeGeometry {
  const c = centerOf(rect)
  const height = 52 + fanIndex * 22
  const spread = 20 + fanIndex * 6
  const top = rect.y - EDGE_GAP
  const start = { x: c.x - spread, y: top }
  const end = { x: c.x + spread, y: top }
  const c1 = { x: c.x - spread * 2.2, y: top - height }
  const c2 = { x: c.x + spread * 2.2, y: top - height }
  return {
    path: `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`,
    arrow: arrowPath(end, c2),
    label: { x: c.x, y: top - height * 0.75 },
  }
}

/** Which side of a node an edge uses, and where on that side.
 *
 * PORTS ARE THE ANSWER TO CONVERGENCE, and convergence is this graph's normal state -- the
 * contract says features are shared by "namespace:id", and on this repo's own fixture pack forty
 * roots reach seventeen children, one of which has eleven parents. Eleven lines drawn to one
 * box's CENTRE arrive as a single blot: which line ends where is unanswerable, and so is "how
 * many are there". Eleven lines drawn to eleven distinct points spread down that box's left
 * border arrive as a fan that can be counted and followed back.
 *
 * The side is chosen by direction, not by proximity: an edge whose target is further right
 * leaves the RIGHT border and enters the target's LEFT border, which is the direction the
 * layered layout runs. An edge that goes backwards (a cycle's closing leg, a hand-pinned node
 * dragged behind its parent) leaves the LEFT and enters the target's RIGHT, so it visibly swims
 * upstream instead of pretending to be a forward edge.
 *
 * Slots on one side are ordered by the OTHER endpoint's vertical position, so a bundle of edges
 * between two layers keeps its reading order and crosses itself as little as the port model
 * allows. */
function portPoint(rect: GraphRect, right: boolean, index: number, count: number): GraphPoint {
  return {
    x: right ? rect.x + rect.w + EDGE_GAP : rect.x - EDGE_GAP,
    y: rect.y + (rect.h * (index + 1)) / (count + 1),
  }
}

/** A cubic with HORIZONTAL tangents at both ends: it leaves its port going sideways and arrives
 * going sideways, which is what makes a fan of edges into one node read as a fan rather than as
 * a starburst. `bow` displaces both control points vertically and is what separates two edges
 * that join the same pair of nodes in the MIDDLE, where their chips sit. */
function routedGeometry(start: GraphPoint, startRight: boolean, end: GraphPoint, endRight: boolean, bow: number): EdgeGeometry {
  const span = Math.abs(end.x - start.x)
  const drop = Math.abs(end.y - start.y)
  const reach = Math.min(EDGE_REACH_MAX, Math.max(EDGE_REACH_MIN, span * EDGE_REACH_FRACTION + drop * EDGE_REACH_PER_DROP))
  const c1 = { x: start.x + (startRight ? reach : -reach), y: start.y + bow }
  const c2 = { x: end.x + (endRight ? reach : -reach), y: end.y + bow }
  const label = cubicPoint(start, c1, c2, end, 0.5)
  // Tangent of a cubic at t=1 is 3*(P3-P2); the arrow only needs a point behind the tip on that
  // line, and C2 itself is on it.
  return {
    path: `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`,
    arrow: arrowPath(end, c2),
    label,
    curve: [start, c1, c2, end],
  }
}

/** Which side each end of each edge attaches to, and its slot in that side's fan.
 *
 * One flat pass to classify, one sort per side, one flat pass to number -- no traversal, so a
 * cycle costs what the same number of acyclic edges costs, exactly as everything else in this
 * file does. Self-edges are excluded: they have their own geometry (selfLoopGeometry) and no
 * direction to classify. */
interface EdgePorts {
  fromRight: boolean
  toRight: boolean
  from: GraphPoint
  to: GraphPoint
}

function assignPorts(edges: readonly GraphEdgeWire[], rects: ReadonlyMap<string, GraphRect>): Map<number, EdgePorts> {
  interface Slot {
    edgeIndex: number
    end: 'from' | 'to'
    sortY: number
  }
  const sides = new Map<string, Slot[]>()
  // A template string, not JSON.stringify. These are built six times per edge on every frame of
  // a drag, and at 4580 edges that measured 3.15ms of a 10ms frame -- against 0.14ms for the
  // same keys built this way, so a seventh of the frame was spent serialising two values into a
  // string nobody reads.
  //
  // The separator is safe here in a way it would not be for an arbitrary pair: the second half
  // is a boolean, so no id can collide with it whatever it contains.
  const sideKey = (id: string, right: boolean): string => `${id} ${right ? 'r' : 'l'}`
  const add = (id: string, right: boolean, slot: Slot): void => {
    const key = sideKey(id, right)
    const list = sides.get(key)
    if (list) list.push(slot)
    else sides.set(key, [slot])
  }

  const classified = new Map<number, { fromRight: boolean; toRight: boolean; fromRect: GraphRect; toRect: GraphRect; from: string; to: string }>()
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]
    if (!edge || edge.from === edge.to) continue
    const fromRect = rects.get(edge.from)
    const toRect = rects.get(edge.to)
    if (!fromRect || !toRect) continue
    const forward = toRect.x + toRect.w / 2 >= fromRect.x + fromRect.w / 2
    classified.set(index, { fromRight: forward, toRight: !forward, fromRect, toRect, from: edge.from, to: edge.to })
    add(edge.from, forward, { edgeIndex: index, end: 'from', sortY: centerOf(toRect).y })
    add(edge.to, !forward, { edgeIndex: index, end: 'to', sortY: centerOf(fromRect).y })
  }

  const slotOf = new Map<string, { index: number; count: number }>()
  for (const list of sides.values()) {
    list.sort((a, b) => a.sortY - b.sortY || a.edgeIndex - b.edgeIndex || (a.end < b.end ? -1 : 1))
    for (let i = 0; i < list.length; i++) {
      const slot = list[i]
      if (!slot) continue
      // Both halves are known-shaped -- a number and a side -- so a separator cannot be
      // ambiguous, and this runs once per slot per drag frame. See sideKey above for the
      // measurement that made this worth changing.
      slotOf.set(`${slot.edgeIndex} ${slot.end}`, { index: i, count: list.length })
    }
  }

  const out = new Map<number, EdgePorts>()
  for (const [index, info] of classified) {
    const fromSlot = slotOf.get(`${index} from`) ?? { index: 0, count: 1 }
    const toSlot = slotOf.get(`${index} to`) ?? { index: 0, count: 1 }
    out.set(index, {
      fromRight: info.fromRight,
      toRight: info.toRight,
      from: portPoint(info.fromRect, info.fromRight, fromSlot.index, fromSlot.count),
      to: portPoint(info.toRect, info.toRight, toSlot.index, toSlot.count),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  node.setAttribute('class', className)
  return node
}

export function createGraphView(host: HTMLElement, options: GraphViewOptions = {}): GraphView {
  const anchor = options.positionAnchor ?? 'topLeft'
  const wheelBehavior = options.wheelBehavior ?? 'pan'
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
  const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM

  const root = el('div', 'flg-graph')
  root.tabIndex = 0
  root.setAttribute('role', 'application')
  root.setAttribute('aria-label', options.ariaLabel ?? 'Feature delegation graph')
  const world = el('div', 'flg-world')
  const edgeLayer = svg('svg', 'flg-edges')
  const chipLayer = el('div', 'flg-chips')
  const nodeLayer = el('div', 'flg-nodes')
  // Alignment guides, between the edges and the cards: a guide has to be visible over the lines
  // it is helping to line up, and must never be mistaken for one of them, so it gets its own
  // layer rather than being appended into the edge SVG (which render() replaces wholesale).
  // Two <line>s, reused for the life of the view -- a guide appears and disappears many times in
  // one drag, and creating an element for each would be the one allocation in the drag loop.
  const guideLayer = svg('svg', 'flg-guides')
  const guideVertical = svg('line', 'flg-guide')
  const guideHorizontal = svg('line', 'flg-guide')
  guideLayer.append(guideVertical, guideHorizontal)
  // The connection being dragged. In WORLD space, above the cards, and reused for the life of the
  // view: a link is drawn on most frames of a gesture and creating two elements per frame would
  // be the one allocation in that loop. Drawn by the same router real edges use (routedGeometry),
  // so the line in the user's hand leaves its port at the same angle the finished delegation
  // will -- a preview drawn differently from the thing it previews is a preview that lies.
  const linkLayer = svg('svg', 'flg-links')
  const linkLine = svg('path', 'flg-link-line')
  const linkArrow = svg('path', 'flg-link-arrow')
  linkLayer.append(linkLine, linkArrow)
  // Group frames go FIRST, under everything: a frame is a background for its members, and an
  // edge between two members has to draw over it or the frame reads as covering the connection.
  // Its body is `pointer-events: none` (graph.css), so a press on the frame's empty interior is a
  // press on the canvas -- pans, marquees -- and only the header is a control.
  const frameLayer = el('div', 'flg-frames')
  world.append(frameLayer, edgeLayer, guideLayer, nodeLayer, chipLayer, linkLayer)
  // The marquee, in SCREEN space on the host: it is a gesture, not a thing in the drawing, and a
  // rectangle in the world would scale with the camera under a pointer that did not move.
  const marqueeBox = el('div', 'flg-marquee')
  marqueeBox.hidden = true
  // The verdict, in SCREEN space on the static host rather than in the world: it is a label about
  // the gesture, not a thing in the drawing, so it must not scale with the camera or slide when
  // the view pans under a held pointer.
  const linkTip = el('div', 'flg-link-tip')
  const linkTipLabel = el('div', 'flg-link-tip-label')
  const linkTipDetail = el('div', 'flg-link-tip-detail')
  linkTip.append(linkTipLabel, linkTipDetail)
  linkTip.setAttribute('role', 'status')
  linkTip.hidden = true
  root.append(world, marqueeBox, linkTip)
  host.append(root)

  let camera: GraphCamera = { x: 0, y: 0, zoom: 1 }
  let selection: GraphSelection = null
  let graph: GraphWire = { nodes: [], edges: [], roots: [] }
  let rects = new Map<string, GraphRect>()
  let contentBounds: GraphRect = { x: 0, y: 0, w: 0, h: 0 }
  /** Every selectable element, keyed by the same string the selection carries, so setSelection
   * is a map lookup rather than a DOM query over a few hundred nodes on every arrow-key press.
   * `Element`, not `HTMLElement`: an edge registers its SVG <g> here (so the CSS can restyle the
   * line and the arrowhead together) alongside the HTML chip that labels it, and both light up
   * from the one key. */
  const selectable = new Map<string, Element[]>()
  /** Every edge group and edge chip that touches a node, keyed by node id. Selecting a node
   * lights these and dims the rest -- the single thing that makes a graph where one child has
   * eleven parents traceable, because the problem there is not how the eleven lines are drawn
   * but the thirty-nine others drawn across them. */
  const edgeGroupsByNode = new Map<string, Element[]>()
  /** Every node box in draw order, so the incidence pass is an array walk rather than a DOM
   * query per neighbour, and whatever it lit last time so clearing costs the same. */
  const nodeBoxes: HTMLElement[] = []
  const litElements: Element[] = []
  const nodeById = new Map<string, GraphNodeWire>()
  const edgeByKey = new Map<string, { edge: GraphEdgeWire; index: number }>()
  /** Node id -> its card, so moving a node is a map lookup and a style write rather than a DOM
   * query. The same reason `selectable` exists. */
  const nodeElements = new Map<string, HTMLElement>()
  /** Everything a moved edge needs re-written, plus the geometry it was LAST drawn with.
   *
   * The cached ports are what make a drag cheap: assignPorts has to run over the whole graph
   * (a port's slot depends on how many other edges share that side, so it is not a per-edge
   * question), but the answer for almost every edge is identical to last frame, and comparing
   * six numbers is far cheaper than building a path string and handing it to the SVG parser. */
  interface EdgeVisual {
    edge: GraphEdgeWire
    index: number
    casing: SVGPathElement
    line: SVGPathElement
    arrow: SVGPathElement
    hit: SVGPathElement
    chip: HTMLElement
    /** The per-pair displacement this edge was drawn with -- see EDGE_BOW_STEP. Fixed for the
     * life of the render, since it depends on edge ORDER and not on any position. */
    bow: number
    /** Which of its node's self-loops this is, for selfLoopGeometry's fan. */
    selfIndex: number
    fromRight: boolean
    toRight: boolean
    fromX: number
    fromY: number
    toX: number
    toY: number
  }
  const edgeVisuals: EdgeVisual[] = []
  /** The expanded groups this view was last handed, and the frame drawn for each. A frame's
   * geometry is derived from its members' rects (layoutFrames) rather than stored, so moving a
   * member moves the frame by construction. */
  let frames: readonly GraphFrameWire[] = []
  const frameElements = new Map<string, { frame: HTMLElement; head: HTMLElement }>()
  /** Group id -> the card a COLLAPSED group is drawn as, so a group selection can find its box. */
  const groupCards = new Map<string, HTMLElement>()

  const selectListeners = new Set<(selection: GraphSelection) => void>()
  const activateListeners = new Set<(selection: GraphSelection) => void>()
  const moveListeners = new Set<(moves: readonly GraphNodeMove[]) => void>()
  const connectListeners = new Set<(request: GraphConnectRequest) => void>()
  const groupToggleListeners = new Set<(groupId: string, collapsed: boolean) => void>()

  /** Where "may I connect these two, and what would it do" is answered.
   *
   * The DEFAULT reads the graph this view was last handed and asks connect.ts, which knows the
   * format's delegation keys. That is not the view knowing about feature types -- it is the view
   * asking the one module whose job that is, and the answer it gets back is the same answer the
   * apply path will get, which is the only way a preview can be trusted. `null` here means the
   * gesture is off and no handles are drawn. */
  const policy: GraphConnectPolicy | null =
    options.connectPolicy === false
      ? null
      : (options.connectPolicy ?? {
          canStart: (nodeId) => connectSourcePreview(graph, nodeId),
          check: (from, to) => previewConnection(graph, from, to),
        })

  let frame = 0
  let disposed = false

  function applyCamera(): void {
    frame = 0
    // ONE transform on ONE element repositions the whole scene -- edges, nodes and chips all
    // live under `world`, so a pan or a zoom never re-reads the graph, never re-measures, and
    // never rebuilds an element. That is what makes panning around a large pack cost the same
    // as panning around a small one.
    world.style.transform = `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`
    root.dataset.zoomBand = camera.zoom < ZOOM_BAND_FAR ? 'far' : camera.zoom < ZOOM_BAND_NEAR ? 'mid' : 'near'
    // Whether the selection is on screen changes as the camera moves, and the quieting depends on
    // it -- so the class has to be re-decided here rather than only when the selection changes.
    // Cheap: one getBoundingClientRect against one element, no traversal.
    if (selection?.kind === 'node') {
      root.classList.toggle('flg-has-focus', isOnScreen(selection.nodeId))
    }
  }

  function scheduleCamera(): void {
    if (disposed || frame !== 0) return
    // Coalesced to one frame: a trackpad emits wheel events faster than the compositor paints,
    // and writing `transform` per event is how a smooth pan turns into a stuttering one. There
    // is no standing loop here -- a frame is requested only when something actually moved, so
    // an idle view costs nothing.
    frame = requestAnimationFrame(applyCamera)
  }

  function clampZoom(z: number): number {
    if (!Number.isFinite(z)) return camera.zoom
    return Math.min(maxZoom, Math.max(minZoom, z))
  }

  function emitSelect(next: GraphSelection): void {
    selection = next
    paintSelection()
    for (const listener of selectListeners) listener(next)
    root.dispatchEvent(new CustomEvent<GraphSelection>(GRAPH_SELECT_EVENT, { detail: next, bubbles: true, composed: true }))
  }

  function emitActivate(target: GraphSelection): void {
    for (const listener of activateListeners) listener(target)
    root.dispatchEvent(new CustomEvent<GraphSelection>(GRAPH_ACTIVATE_EVENT, { detail: target, bubbles: true, composed: true }))
  }

  function emitConnect(request: GraphConnectRequest): void {
    for (const listener of connectListeners) listener(request)
    root.dispatchEvent(new CustomEvent<GraphConnectRequest>(GRAPH_CONNECT_EVENT, { detail: request, bubbles: true, composed: true }))
  }

  function emitMove(moves: readonly GraphNodeMove[]): void {
    if (moves.length === 0) return
    for (const listener of moveListeners) listener(moves)
    root.dispatchEvent(new CustomEvent<readonly GraphNodeMove[]>(GRAPH_MOVE_EVENT, { detail: moves, bubbles: true, composed: true }))
  }

  function emitGroupToggle(groupId: string, collapsed: boolean): void {
    for (const listener of groupToggleListeners) listener(groupId, collapsed)
  }

  /** A rect as the point the CALLER names it by -- the inverse of resolvePositions' toRect. A
   * host that laid out in centres gets centres back; anything else would hand it a number it
   * would have to know to correct, which is exactly the mistake positionAnchor exists to
   * prevent. */
  function anchorPoint(x: number, y: number): GraphPoint {
    return anchor === 'center' ? { x: x + GRAPH_NODE_WIDTH / 2, y: y + GRAPH_NODE_HEIGHT / 2 } : { x, y }
  }

  /** The registry keys a selection lights. One for a node, an edge or a group; one per node for a
   * multi-selection, which is what lets every picked card carry the same class the single case
   * does. */
  function selectionKeys(sel: GraphSelection): Set<string> {
    const keys = new Set<string>()
    if (!sel) return keys
    switch (sel.kind) {
      case 'node':
        keys.add(JSON.stringify(['node', sel.nodeId]))
        break
      case 'edge':
        keys.add(JSON.stringify(['edge', sel.edgeKey]))
        break
      case 'nodes':
        for (const id of sel.nodeIds) keys.add(JSON.stringify(['node', id]))
        break
      case 'group':
        keys.add(JSON.stringify(['group', sel.groupId]))
        break
    }
    return keys
  }

  function paintSelection(): void {
    const keys = selectionKeys(selection)
    root.classList.toggle('flg-has-multi', selection?.kind === 'nodes')
    for (const [entryKey, elements] of selectable) {
      const on = keys.has(entryKey)
      for (const element of elements) {
        element.classList.toggle('flg-selected', on)
        // Only the focusable HTML controls carry aria-pressed -- an SVG <g> registered purely so
        // the line restyles with its chip is decoration, and announcing it as a second pressed
        // button would double every edge in a screen reader's control list.
        if (element instanceof HTMLElement) element.setAttribute('aria-pressed', String(on))
      }
    }
    paintIncidence()
  }

  /** Marks everything that touches the selected node, and tells the stylesheet a node is
   * selected so it can quiet everything that does not.
   *
   * NOTHING MOVES. Emphasis here is opacity and weight only -- no reflow, no re-layout, no
   * animation of position -- because the moment a selection nudges a box the user loses the
   * mental map they were building, and on a canvas this dense that map is the whole product.
   * Purely additive classes over elements that already exist, so it costs one pass over the
   * edges of one node rather than a re-render. */
  /** Whether a node's box currently overlaps the visible canvas.
   *
   * Measured off the rendered element rather than recomputed from the camera: the element is
   * where the node actually IS, transforms and all, so this cannot drift from what is drawn. */
  function isOnScreen(nodeId: string): boolean {
    const box = nodeElements.get(nodeId)
    if (!box) return false
    const node = box.getBoundingClientRect()
    const view = host.getBoundingClientRect()
    return node.right > view.left && node.left < view.right && node.bottom > view.top && node.top < view.bottom
  }

  function paintIncidence(): void {
    const focus = selection?.kind === 'node' ? selection.nodeId : null
    for (const element of litElements) element.classList.remove('flg-incident', 'flg-node-focus')
    litElements.length = 0
    // Quieting is a way of ANSWERING "what is this connected to", so it is only worth anything
    // while the thing it answers about is on screen. Pan away from a selection and every rule
    // below would fire with nothing lit to contrast against: the whole canvas dims and reads as a
    // disabled panel, with no hint that the cause is a selection somewhere off in the distance.
    root.classList.toggle('flg-has-focus', focus !== null && isOnScreen(focus))
    if (focus === null) return

    for (const element of edgeGroupsByNode.get(focus) ?? []) {
      element.classList.add('flg-incident')
      litElements.push(element)
    }
    // The NEIGHBOURS are lit too, not only the lines: a delegation is a statement about two
    // nodes, and highlighting only the line between them leaves the reader to work out which box
    // it landed on -- which is exactly the question they had. Flat over `edges`; no traversal,
    // so a cycle through the selected node costs nothing extra.
    const neighbours = new Set<string>([focus])
    for (const edge of graph.edges) {
      if (edge.from === focus) neighbours.add(edge.to)
      else if (edge.to === focus) neighbours.add(edge.from)
    }
    for (const box of nodeBoxes) {
      const id = (box as HTMLElement).dataset.nodeId
      if (id === undefined || !neighbours.has(id)) continue
      box.classList.add('flg-node-focus')
      litElements.push(box)
    }
  }

  // -- interaction ---------------------------------------------------------

  let panPointer: number | null = null
  let panOrigin = { x: 0, y: 0, camX: 0, camY: 0 }
  let panMoved = false

  /** A marquee in flight: SHIFT held on a primary press on the background. Plain drag on the
   * background keeps panning -- that gesture is older and more frequent, and taking it for
   * selection would make the canvas fly nowhere when somebody reaches to move it. The rectangle
   * is kept in CLIENT pixels while it is drawn and converted to world units once, on release. */
  let marquee: { pointerId: number; startX: number; startY: number; lastX: number; lastY: number } | null = null

  function onPointerDown(event: PointerEvent): void {
    // Middle button pans from anywhere (including over a node); primary pans only from the
    // background, so dragging is never ambiguous with clicking a node.
    const fromBackground = event.target === root || event.target === world || event.target === edgeLayer || event.target === frameLayer
    if (event.button === 0 && fromBackground && event.shiftKey) {
      marquee = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY }
      root.setPointerCapture(event.pointerId)
      root.classList.add('flg-marqueeing')
      drawMarquee()
      event.preventDefault()
      return
    }
    const isPanButton = event.button === 1 || (event.button === 0 && fromBackground)
    if (!isPanButton) return
    panPointer = event.pointerId
    panMoved = false
    panOrigin = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y }
    root.setPointerCapture(event.pointerId)
    root.classList.add('flg-panning')
    event.preventDefault()
  }

  function drawMarquee(): void {
    const state = marquee
    if (!state) {
      marqueeBox.hidden = true
      return
    }
    const box = root.getBoundingClientRect()
    const left = Math.min(state.startX, state.lastX) - box.left
    const top = Math.min(state.startY, state.lastY) - box.top
    marqueeBox.hidden = false
    marqueeBox.style.left = `${Math.round(left)}px`
    marqueeBox.style.top = `${Math.round(top)}px`
    marqueeBox.style.width = `${Math.round(Math.abs(state.lastX - state.startX))}px`
    marqueeBox.style.height = `${Math.round(Math.abs(state.lastY - state.startY))}px`
  }

  /** Ends the marquee and selects what it touched. TOUCHED, not enclosed: a card half inside the
   * rectangle is one the user dragged across on purpose, and enclosure would demand a rectangle
   * larger than the thing being picked, which on a dense canvas sweeps up its neighbours. Only
   * feature cards and group cards are picked -- a frame is not a node -- and one hit is an
   * ordinary node selection, so nothing downstream meets a multi-selection of one. */
  function endMarquee(commit: boolean): void {
    const state = marquee
    marquee = null
    root.classList.remove('flg-marqueeing')
    drawMarquee()
    if (!state || !commit) return
    if (Math.abs(state.lastX - state.startX) <= DRAG_THRESHOLD_PX && Math.abs(state.lastY - state.startY) <= DRAG_THRESHOLD_PX) {
      // A shift+click on the background, which is not a marquee at all. Nothing changes -- a
      // click that selected nothing would clear the selection somebody was holding shift to add to.
      return
    }
    const a = worldFromClient(Math.min(state.startX, state.lastX), Math.min(state.startY, state.lastY))
    const b = worldFromClient(Math.max(state.startX, state.lastX), Math.max(state.startY, state.lastY))
    const picked: string[] = []
    for (const box of nodeBoxes) {
      const id = box.dataset.nodeId
      if (id === undefined) continue
      const rect = rects.get(id)
      if (!rect) continue
      if (rect.x < b.x && rect.x + rect.w > a.x && rect.y < b.y && rect.y + rect.h > a.y) picked.push(id)
    }
    emitSelect(selectionOfNodes(picked))
  }

  /** The selection `ids` amount to: nothing, one node, or several. The one place the "a
   * multi-selection is always two or more" rule is enforced, so the two gestures that build one
   * (marquee, ctrl+click) cannot disagree about it. A group's card is a group selection when it is
   * the only thing picked, and a member of a multi-selection otherwise -- as a card it can be
   * moved with the others, and moving it is what picking it with them is for. */
  function selectionOfNodes(ids: readonly string[]): GraphSelection {
    const first = ids[0]
    if (first === undefined) return null
    if (ids.length === 1) {
      const node = nodeById.get(first)
      if (!node) return null
      return node.group ? { kind: 'group', groupId: node.group.id } : { kind: 'node', nodeId: first, node }
    }
    return { kind: 'nodes', nodeIds: [...ids] }
  }

  function onPointerMove(event: PointerEvent): void {
    if (marquee !== null && marquee.pointerId === event.pointerId) {
      marquee.lastX = event.clientX
      marquee.lastY = event.clientY
      drawMarquee()
      return
    }
    if (panPointer !== event.pointerId) return
    const dx = event.clientX - panOrigin.x
    const dy = event.clientY - panOrigin.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panMoved = true
    camera = { ...camera, x: panOrigin.camX - dx / camera.zoom, y: panOrigin.camY - dy / camera.zoom }
    scheduleCamera()
  }

  function onPointerUp(event: PointerEvent): void {
    if (marquee !== null && marquee.pointerId === event.pointerId) {
      marquee.lastX = event.clientX
      marquee.lastY = event.clientY
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId)
      endMarquee(event.type !== 'pointercancel')
      return
    }
    if (panPointer !== event.pointerId) return
    panPointer = null
    // Guarded: releasePointerCapture throws NotFoundError for a pointer that is no longer
    // captured, which is exactly the state a pointercancel leaves us in.
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId)
    root.classList.remove('flg-panning')
    // A drag that moved is a pan, not a click on the background -- clearing the selection
    // because someone dragged the canvas would silently lose whatever they had selected.
    if (!panMoved && event.button === 0 && selection !== null) emitSelect(null)
  }

  // -- moving nodes --------------------------------------------------------

  /** How far above its own card a node's self-loops reach, per node.
   *
   * Only zoomToFit cares, and only because a self-delegation is drawn as an arc ABOVE the box
   * rather than inside it -- frame the boxes alone and the loop is cropped off the top. render()
   * folds this into its bounds as it draws; recomputeBounds needs it again after a move, and
   * re-deriving it would mean re-walking the edges for a number that cannot change without a
   * re-render. */
  const selfLoopOverhang = new Map<string, number>()

  function sizeLayers(maxX: number, maxY: number): void {
    // The SVG layers are sized to the content's far corner and left `overflow: visible`
    // (graph.css) so a layout that emits negative coordinates still paints. Sizing rather than
    // relying on overflow alone keeps the elements' own boxes honest for anything that measures
    // them.
    const width = String(Math.max(1, maxX + GRAPH_NODE_WIDTH))
    const height = String(Math.max(1, maxY + GRAPH_NODE_HEIGHT))
    edgeLayer.setAttribute('width', width)
    edgeLayer.setAttribute('height', height)
    guideLayer.setAttribute('width', width)
    guideLayer.setAttribute('height', height)
  }

  /** Re-derives what zoomToFit frames, after a move changed it. Arithmetic over the rects and no
   * DOM at all, but still once per FINISHED gesture rather than once per frame: nothing on
   * screen depends on it mid-drag, and a node dragged far off to one side would otherwise make
   * every intermediate frame do work only the release can use. */
  function recomputeBounds(): void {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [id, rect] of rects) {
      minX = Math.min(minX, rect.x)
      minY = Math.min(minY, rect.y - (selfLoopOverhang.get(id) ?? 0))
      maxX = Math.max(maxX, rect.x + rect.w)
      maxY = Math.max(maxY, rect.y + rect.h)
    }
    if (!Number.isFinite(minX)) return
    contentBounds = { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) }
    sizeLayers(maxX, maxY)
  }

  /** Puts one card at one place. The rect is mutated rather than replaced because the geometry
   * pass, the chip grid and zoomToFit all read the SAME rect objects -- handing out a new one
   * would leave three stale copies of where the node used to be. */
  function placeNode(nodeId: string, x: number, y: number): void {
    const rect = rects.get(nodeId)
    const box = nodeElements.get(nodeId)
    if (!rect || !box) return
    rect.x = x
    rect.y = y
    box.style.left = `${round(x)}px`
    box.style.top = `${round(y)}px`
  }

  /** Re-attaches every edge whose ports actually moved, and leaves the rest of the canvas alone.
   *
   * This is the function that makes dragging viable, so what it deliberately does NOT do is the
   * point. It does not call render(): rebuilding every card, chip, casing, line, arrowhead and
   * hit path was measured at roughly 10 ms of scripting for this repo's own 57-node fixture pack
   * and 144 ms at 900 nodes, and 144 ms per pointermove is not a drag, it is a slideshow. It
   * also does not try to work out which edges are "near" the moved node, because that question
   * has a wrong-looking answer: a port's slot on one side of a card is decided by how many other
   * edges share that side and in what vertical order (assignPorts), so moving one node can
   * renumber the ports of edges that do not touch it.
   *
   * So the PURE half runs whole -- assignPorts over every edge, which is arithmetic, a sort per
   * side and no DOM -- and the expensive half is gated on the result: an edge whose six cached
   * port numbers came back identical is skipped before a path string is ever built. On a
   * one-node drag that is a handful of edges out of hundreds. */
  function rerouteEdges(): void {
    if (edgeVisuals.length === 0) return
    const ports = assignPorts(graph.edges, rects)
    // Built on first use, not up front: the chip-placement grid is the only O(nodes) allocation
    // in this function, and a reroute where nothing actually moved should cost nothing.
    let grid: RectGrid | null = null
    for (const visual of edgeVisuals) {
      const fromRect = rects.get(visual.edge.from)
      const toRect = rects.get(visual.edge.to)
      if (!fromRect || !toRect) continue
      const port = visual.edge.from === visual.edge.to ? undefined : ports.get(visual.index)
      let geometry: EdgeGeometry
      if (!port) {
        if (fromRect.x === visual.fromX && fromRect.y === visual.fromY) continue
        visual.fromX = fromRect.x
        visual.fromY = fromRect.y
        geometry = selfLoopGeometry(fromRect, visual.selfIndex)
      } else {
        if (
          port.fromRight === visual.fromRight &&
          port.toRight === visual.toRight &&
          port.from.x === visual.fromX &&
          port.from.y === visual.fromY &&
          port.to.x === visual.toX &&
          port.to.y === visual.toY
        ) {
          continue
        }
        visual.fromRight = port.fromRight
        visual.toRight = port.toRight
        visual.fromX = port.from.x
        visual.fromY = port.from.y
        visual.toX = port.to.x
        visual.toY = port.to.y
        geometry = routedGeometry(port.from, port.fromRight, port.to, port.toRight, visual.bow)
      }
      visual.casing.setAttribute('d', geometry.path)
      visual.line.setAttribute('d', geometry.path)
      visual.arrow.setAttribute('d', geometry.arrow)
      visual.hit.setAttribute('d', geometry.path)
      if (grid === null) grid = new RectGrid(rects.values())
      const at = chipAnchor(geometry, grid)
      visual.chip.style.left = `${round(at.x)}px`
      visual.chip.style.top = `${round(at.y)}px`
    }
  }

  /** Where a dragged card wants to be, once it has been allowed to line up with its neighbours.
   * `guideX`/`guideY` are the world coordinates the card locked onto, or null for the axis that
   * did not lock -- a snap the user cannot see is a canvas that feels sticky for no reason. */
  interface SnapResult {
    x: number
    y: number
    guideX: number | null
    guideY: number | null
  }

  /** Snaps a dragged card's left/centre/right to another card's left/centre/right, and the same
   * three horizontals, whichever is nearest within SNAP_PX.
   *
   * The tolerance is divided by the zoom so it is a constant number of SCREEN pixels: a snap
   * radius fixed in world units grabs from half a screen away when zoomed out and is
   * unreachable when zoomed in. Six comparisons per node and no allocation, so this stays a
   * rounding error next to the reroute it precedes even on a graph of a thousand boxes. */
  function snapToNeighbours(moving: ReadonlySet<string>, x: number, y: number): SnapResult {
    const tolerance = SNAP_PX / camera.zoom
    let bestX = tolerance
    let bestY = tolerance
    let offsetX = 0
    let offsetY = 0
    let guideX: number | null = null
    let guideY: number | null = null
    const considerX = (mine: number, theirs: number): void => {
      const distance = Math.abs(theirs - mine)
      if (distance >= bestX) return
      bestX = distance
      offsetX = theirs - mine
      guideX = theirs
    }
    const considerY = (mine: number, theirs: number): void => {
      const distance = Math.abs(theirs - mine)
      if (distance >= bestY) return
      bestY = distance
      offsetY = theirs - mine
      guideY = theirs
    }
    for (const [otherId, rect] of rects) {
      if (moving.has(otherId)) continue
      considerX(x, rect.x)
      considerX(x + GRAPH_NODE_WIDTH / 2, rect.x + rect.w / 2)
      considerX(x + GRAPH_NODE_WIDTH, rect.x + rect.w)
      considerY(y, rect.y)
      considerY(y + GRAPH_NODE_HEIGHT / 2, rect.y + rect.h / 2)
      considerY(y + GRAPH_NODE_HEIGHT, rect.y + rect.h)
    }
    return { x: x + offsetX, y: y + offsetY, guideX, guideY }
  }

  function showGuide(line: SVGLineElement, vertical: boolean, at: number | null): void {
    if (at === null) {
      line.classList.remove('flg-guide-on')
      return
    }
    // Spanning the content rather than the viewport: the guide is a statement about the DRAWING
    // ("these two are in one column"), and the world layer is what the camera moves, so a guide
    // measured in screen space would slide off its own alignment the moment the view panned.
    const pad = GRAPH_NODE_HEIGHT * 2
    const from = vertical ? contentBounds.y - pad : contentBounds.x - pad
    const to = vertical ? contentBounds.y + contentBounds.h + pad : contentBounds.x + contentBounds.w + pad
    line.setAttribute('x1', String(round(vertical ? at : from)))
    line.setAttribute('y1', String(round(vertical ? from : at)))
    line.setAttribute('x2', String(round(vertical ? at : to)))
    line.setAttribute('y2', String(round(vertical ? to : at)))
    line.classList.add('flg-guide-on')
  }

  /** One gesture moving one OR SEVERAL cards. Several is the ordinary case for a group: dragging
   * a frame's header carries every member, and dragging a card that is part of a multi-selection
   * carries the rest of it. The primary card is the one under the pointer -- it is what snaps,
   * and the others follow it by the same offset, so a group dragged into line lines up as a
   * unit instead of each card snapping to something different. */
  interface DragState {
    pointerId: number
    /** The card the pointer is on, or the frame's first member when a frame is being carried. */
    nodeId: string
    /** Every node this gesture moves, `nodeId` included. */
    nodeIds: readonly string[]
    /** The element holding pointer capture: the card, or a frame's header. */
    box: HTMLElement
    /** Where the primary card was when the press landed, in world units, top-left. */
    startX: number
    startY: number
    /** Where every carried card was, so the gesture can be cancelled and reported per node. */
    starts: ReadonlyMap<string, GraphPoint>
    /** The press, and the most recent move, in client pixels. */
    pressX: number
    pressY: number
    lastX: number
    lastY: number
    /** ALT as of the last move: held, it defeats snapping. Read per move rather than per press,
     * so it can be pressed and released mid-drag. */
    snapping: boolean
    /** Whether DRAG_THRESHOLD_PX has been passed. Until it has, nothing has moved and the
     * gesture is still a click. */
    moved: boolean
  }
  let drag: DragState | null = null
  let dragFrame = 0
  /** A gesture that became a drag still ends in a synthesised `click`, and that click must not
   * also change the selection -- releasing a card you spent two seconds positioning should not
   * quietly re-point the inspector at it. Set on release, consumed by the click that follows,
   * and cleared by the next press in case no click ever arrives (a drag released off the card). */
  let dragConsumedClick = false

  /** What a press on `nodeId` carries: the whole multi-selection when the card is part of one,
   * and the card alone otherwise. A card OUTSIDE the selection drags alone and leaves the
   * selection as it is, which is what every desktop does. */
  function dragSetFor(nodeId: string): string[] {
    if (selection?.kind === 'nodes' && selection.nodeIds.includes(nodeId)) return [...selection.nodeIds]
    return [nodeId]
  }

  function beginDrag(event: PointerEvent, nodeId: string, box: HTMLElement, nodeIds: readonly string[] = [nodeId]): void {
    // Primary button only. The middle button is the canvas's pan-from-anywhere gesture and is
    // let through to the root deliberately; the secondary button belongs to whatever menu the
    // host puts on the canvas.
    if (event.button !== 0 || drag !== null) return
    const rect = rects.get(nodeId)
    if (!rect) return
    const starts = new Map<string, GraphPoint>()
    for (const id of nodeIds) {
      const r = rects.get(id)
      if (r) starts.set(id, { x: r.x, y: r.y })
    }
    if (!starts.has(nodeId)) return
    dragConsumedClick = false
    drag = {
      pointerId: event.pointerId,
      nodeId,
      nodeIds: [...starts.keys()],
      box,
      startX: rect.x,
      startY: rect.y,
      starts,
      pressX: event.clientX,
      pressY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      snapping: !event.altKey,
      moved: false,
    }
    // Captured on the CARD, so a fast drag that outruns the pointer -- or one that leaves the
    // panel entirely -- still delivers its moves and its release here instead of stranding the
    // card mid-gesture.
    box.setPointerCapture(event.pointerId)
    // Deliberately no preventDefault(): the press still has to focus the card (or the arrow keys
    // have nothing to move) and still has to produce the click that selects it when the gesture
    // turns out to be a click. Text selection, the other thing a press would start, is already
    // off -- `user-select: none` on the canvas in graph.css.
  }

  function onDragMove(event: PointerEvent): void {
    const state = drag
    if (!state || state.pointerId !== event.pointerId) return
    state.lastX = event.clientX
    state.lastY = event.clientY
    state.snapping = !event.altKey
    if (!state.moved) {
      if (Math.abs(event.clientX - state.pressX) <= DRAG_THRESHOLD_PX && Math.abs(event.clientY - state.pressY) <= DRAG_THRESHOLD_PX) return
      state.moved = true
      state.box.classList.add('flg-dragging')
      for (const id of state.nodeIds) nodeElements.get(id)?.classList.add('flg-dragging')
      root.classList.add('flg-dragging-node')
    }
    // Coalesced to one frame, for the same reason the camera is: a mouse emits moves faster than
    // the compositor paints, and re-routing per event does the work several times for one
    // picture.
    if (dragFrame === 0 && !disposed) dragFrame = requestAnimationFrame(applyDrag)
  }

  function applyDrag(): void {
    dragFrame = 0
    const state = drag
    if (!state || !state.moved) return
    // Client pixels over zoom: the card has to stay under the pointer, and a world unit is only
    // a screen pixel at zoom 1.
    const x = state.startX + (state.lastX - state.pressX) / camera.zoom
    const y = state.startY + (state.lastY - state.pressY) / camera.zoom
    const snapped = state.snapping ? snapToNeighbours(new Set(state.nodeIds), x, y) : { x, y, guideX: null, guideY: null }
    showGuide(guideVertical, true, snapped.guideX)
    showGuide(guideHorizontal, false, snapped.guideY)
    // Every carried card moves by the primary's displacement, snap included, so the set keeps
    // its own shape.
    const dx = snapped.x - state.startX
    const dy = snapped.y - state.startY
    for (const [id, start] of state.starts) placeNode(id, start.x + dx, start.y + dy)
    rerouteEdges()
    layoutFrames()
  }

  /** Ends the gesture. `commit: false` is a CANCEL -- Escape, or a pointer the browser took away
   * -- and puts the card back where it was picked up rather than leaving it wherever the
   * interruption happened to land it. Nothing is reported for a cancelled drag, because a host
   * would write the file. */
  function endDrag(commit: boolean): void {
    const state = drag
    if (!state) return
    if (dragFrame !== 0) {
      cancelAnimationFrame(dragFrame)
      dragFrame = 0
    }
    if (state.moved) {
      // The last pointermove may not have had a frame yet: the card must land where the pointer
      // left it, not where the last painted frame put it.
      if (commit) applyDrag()
      else {
        for (const [id, start] of state.starts) placeNode(id, start.x, start.y)
        rerouteEdges()
        layoutFrames()
      }
    }
    drag = null
    if (state.box.hasPointerCapture(state.pointerId)) state.box.releasePointerCapture(state.pointerId)
    state.box.classList.remove('flg-dragging')
    for (const id of state.nodeIds) nodeElements.get(id)?.classList.remove('flg-dragging')
    root.classList.remove('flg-dragging-node')
    showGuide(guideVertical, true, null)
    showGuide(guideHorizontal, false, null)
    if (!state.moved) return
    dragConsumedClick = true
    if (!commit) return
    // A drag that ended exactly where it started -- picked up, moved, put back -- is not a move,
    // and reporting it would be a file write with an empty diff in it. Every carried card moved
    // by the same offset, so one of them moving means all of them did.
    const moves: GraphNodeMove[] = []
    for (const [id, start] of state.starts) {
      const rect = rects.get(id)
      const node = nodeById.get(id)
      if (!rect || !node) continue
      if (rect.x === start.x && rect.y === start.y) continue
      moves.push({ nodeId: id, node, position: anchorPoint(rect.x, rect.y), from: anchorPoint(start.x, start.y) })
    }
    if (moves.length === 0) return
    recomputeBounds()
    emitMove(moves)
  }

  function onDragEnd(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return
    endDrag(true)
  }

  function onDragCancel(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return
    endDrag(false)
  }

  // -- connecting nodes ----------------------------------------------------

  /** THE GESTURE, AND WHY IT IS A HANDLE RATHER THAN A MODIFIER.
   *
   * This canvas already spends both of its primary-button gestures: a press on a card drags the
   * CARD, a press on the background pans the CAMERA, and the thing under the pointer is what says
   * which -- no mode, no modifier, nothing to remember. Starting a connection from the card body
   * would have to break that, either by taking a modifier (invisible, undiscoverable, and ALT is
   * already the "no snapping" key) or by inventing a mode (a toolbar state that makes the same
   * press mean two things on different days).
   *
   * So a connection starts from its own target: a small PORT on the card's right border, which
   * appears on hover, focus and selection. Three things follow from that choice and they are the
   * whole argument for it.
   *
   *   - IT CANNOT COLLIDE. The port is a different element from the card, so pressing it is not
   *     ambiguous with pressing the card, and neither gesture needs to know the other exists.
   *   - IT IS WHERE THE EDGE COMES OUT. Edges leave a node's RIGHT border going forward (see
   *     assignPorts) and the handle sits exactly there, so the line the user pulls starts where
   *     the finished delegation will start.
   *   - IT IS A CONTROL, SO IT IS REACHABLE. A handle is focusable and answers Enter, which is
   *     what makes this gesture available to someone who is not holding a mouse -- see
   *     armConnection. A modifier-drag has no keyboard equivalent at all.
   *
   * What a connection MEANS is not decided here. The policy answers "may I, and what would it
   * do", and the answer is drawn: a legal drop lights its target and says what will happen, an
   * illegal one is struck through and says why, BEFORE the button comes up. An error that arrives
   * after the release is an error about work already done. */
  interface LinkState {
    /** null while the gesture is being driven by the keyboard. */
    pointerId: number | null
    from: string
    port: HTMLElement | null
    /** Where the line starts, in world units -- the source card's right-hand port. */
    anchor: GraphPoint
    /** The card currently under the pointer (or focused, when armed), and what dropping on it
     * would do. */
    target: string | null
    verdict: GraphConnectVerdict | null
  }
  let link: LinkState | null = null
  let linkFrame = 0
  let linkPointerX = 0
  let linkPointerY = 0
  /** Cards currently wearing a legality class, so clearing costs what lighting cost. */
  const litLinkBoxes: HTMLElement[] = []
  /** A refusal shown at a handle that could not start, cleared by the next gesture or by time.
   * A message that never goes away becomes furniture. */
  let linkTipTimer = 0

  function worldFromClient(clientX: number, clientY: number): GraphPoint {
    const box = root.getBoundingClientRect()
    return { x: camera.x + (clientX - box.left) / camera.zoom, y: camera.y + (clientY - box.top) / camera.zoom }
  }

  /** Puts the verdict chip at a point in CLIENT coordinates, offset clear of the cursor. */
  function showLinkTip(clientX: number, clientY: number, verdict: GraphConnectVerdict): void {
    const box = root.getBoundingClientRect()
    linkTipLabel.textContent = verdict.label
    linkTipDetail.textContent = verdict.detail
    linkTip.classList.toggle('flg-link-tip-bad', !verdict.allowed)
    linkTip.classList.toggle('flg-link-tip-asks', verdict.allowed && (verdict.asks?.length ?? 0) > 0)
    linkTip.hidden = false
    // Clamped inside the host, so a verdict at the right-hand edge of the panel is still readable
    // rather than half off it -- which is exactly where a drop onto the last column happens.
    const width = linkTip.offsetWidth || 220
    const height = linkTip.offsetHeight || 44
    const x = Math.min(Math.max(6, clientX - box.left + 16), Math.max(6, box.width - width - 6))
    const y = Math.min(Math.max(6, clientY - box.top + 16), Math.max(6, box.height - height - 6))
    linkTip.style.left = `${Math.round(x)}px`
    linkTip.style.top = `${Math.round(y)}px`
  }

  function hideLinkTip(): void {
    linkTip.hidden = true
    linkTip.classList.remove('flg-link-tip-bad', 'flg-link-tip-asks')
    if (linkTipTimer !== 0) {
      window.clearTimeout(linkTipTimer)
      linkTipTimer = 0
    }
  }

  function clearLinkTargets(): void {
    for (const box of litLinkBoxes) box.classList.remove('flg-link-ok', 'flg-link-bad')
    litLinkBoxes.length = 0
  }

  function markLinkTarget(nodeId: string, allowed: boolean): void {
    const box = nodeElements.get(nodeId)
    if (!box) return
    box.classList.add(allowed ? 'flg-link-ok' : 'flg-link-bad')
    litLinkBoxes.push(box)
  }

  /** The card under a client point, if any. `elementFromPoint` rather than arithmetic over the
   * rects: the cards are real elements with real borders and the browser already knows which one
   * is on top, and a hand-rolled hit test would disagree with what the user can see the moment a
   * card overlaps another. The link layer and the chip at the pointer are `pointer-events: none`
   * in graph.css precisely so they cannot answer this question about themselves. */
  function nodeUnder(clientX: number, clientY: number): string | null {
    const element = document.elementFromPoint(clientX, clientY)
    const card = element instanceof Element ? element.closest('.flg-node') : null
    return card instanceof HTMLElement ? (card.dataset.nodeId ?? null) : null
  }

  function linkAnchor(nodeId: string): GraphPoint | null {
    const rect = rects.get(nodeId)
    if (!rect) return null
    return { x: rect.x + rect.w + EDGE_GAP, y: rect.y + rect.h / 2 }
  }

  function beginLink(event: PointerEvent, nodeId: string, port: HTMLElement): void {
    if (policy === null || event.button !== 0 || link !== null || drag !== null) return
    // The press belongs to the handle and to nothing else: not to the card under it (which would
    // start a move) and not to the canvas (which would start a pan).
    //
    // Deliberately no preventDefault(), for the same reason beginDrag has none: the press has to
    // FOCUS something inside the canvas, or the keydown that abandons the gesture lands on the
    // document and never reaches this view's own handler -- Escape would silently do nothing for
    // the whole of a connection drag. Text selection, the other thing a press would start, is
    // already off (`user-select: none` in graph.css).
    event.stopPropagation()
    port.focus()
    hideLinkTip()
    const start = policy.canStart(nodeId)
    if (!start.allowed) {
      // REFUSED AT THE SOURCE, AND SAID. A type that holds no other feature cannot be connected
      // from at all, and the moment to learn that is the moment the handle is pressed.
      port.classList.add('flg-node-port-refused')
      showLinkTip(event.clientX, event.clientY, start)
      linkTipTimer = window.setTimeout(() => {
        port.classList.remove('flg-node-port-refused')
        hideLinkTip()
      }, 6000)
      return
    }
    const anchor = linkAnchor(nodeId)
    if (!anchor) return
    link = { pointerId: event.pointerId, from: nodeId, port, anchor, target: null, verdict: null }
    linkPointerX = event.clientX
    linkPointerY = event.clientY
    port.setPointerCapture(event.pointerId)
    root.classList.add('flg-linking')
    nodeElements.get(nodeId)?.classList.add('flg-link-source')
    showLinkTip(event.clientX, event.clientY, start)
    drawLink()
  }

  function onLinkMove(event: PointerEvent): void {
    if (!link || link.pointerId !== event.pointerId) return
    event.stopPropagation()
    linkPointerX = event.clientX
    linkPointerY = event.clientY
    // Coalesced to one frame, for the same reason the camera and the card drag are: a pointer
    // emits moves faster than the compositor paints, and the policy question only has one answer
    // per picture.
    if (linkFrame === 0 && !disposed) linkFrame = requestAnimationFrame(drawLink)
  }

  function drawLink(): void {
    linkFrame = 0
    const state = link
    if (!state || policy === null) return
    const end = worldFromClient(linkPointerX, linkPointerY)
    const forward = end.x >= state.anchor.x
    const geometry = routedGeometry(state.anchor, true, end, !forward, 0)
    linkLine.setAttribute('d', geometry.path)
    linkArrow.setAttribute('d', geometry.arrow)

    // Only re-ask when the answer could have changed. The policy is pure and cheap, but it walks
    // the graph, and asking it sixty times a second about the same pair is work with one answer.
    if (state.pointerId !== null) {
      const over = nodeUnder(linkPointerX, linkPointerY)
      if (over !== state.target) {
        clearLinkTargets()
        state.target = over
        state.verdict = over === null ? null : policy.check(state.from, over)
        if (over !== null && state.verdict !== null) markLinkTarget(over, state.verdict.allowed)
      }
      const verdict = state.verdict ?? policy.canStart(state.from)
      linkLine.classList.toggle('flg-link-bad', state.verdict !== null && !state.verdict.allowed)
      linkArrow.classList.toggle('flg-link-bad', state.verdict !== null && !state.verdict.allowed)
      showLinkTip(linkPointerX, linkPointerY, verdict)
    }
  }

  function onLinkEnd(event: PointerEvent): void {
    if (!link || link.pointerId !== event.pointerId) return
    event.stopPropagation()
    // The last move may not have had a frame yet, and the drop has to be judged where the pointer
    // actually is rather than where the last painted frame put it.
    linkPointerX = event.clientX
    linkPointerY = event.clientY
    if (linkFrame !== 0) {
      cancelAnimationFrame(linkFrame)
      linkFrame = 0
    }
    drawLink()
    const state = link
    const target = state.target
    const verdict = state.verdict
    endLink()
    if (target === null || verdict === null || !verdict.allowed) return
    emitConnect({ from: state.from, to: target, verdict })
  }

  function onLinkCancel(event: PointerEvent): void {
    if (!link || link.pointerId !== event.pointerId) return
    endLink()
  }

  /** Puts everything back. Reports nothing: a connection the user did not finish is a connection
   * the host was not asked about. */
  function endLink(): void {
    const state = link
    link = null
    if (linkFrame !== 0) {
      cancelAnimationFrame(linkFrame)
      linkFrame = 0
    }
    clearLinkTargets()
    hideLinkTip()
    root.classList.remove('flg-linking', 'flg-linking-armed')
    linkLine.classList.remove('flg-link-bad')
    linkArrow.classList.remove('flg-link-bad')
    linkLine.removeAttribute('d')
    linkArrow.removeAttribute('d')
    if (!state) return
    nodeElements.get(state.from)?.classList.remove('flg-link-source')
    if (state.port) {
      state.port.classList.remove('flg-node-port-refused')
      if (state.pointerId !== null && state.port.hasPointerCapture(state.pointerId)) {
        state.port.releasePointerCapture(state.pointerId)
      }
    }
  }

  /** The keyboard half of the gesture.
   *
   * A canvas whose one new verb needs a mouse is a canvas that got worse for the people who do
   * not use one, so Enter on a connector handle ARMS a connection: every other card is marked
   * legal or illegal on the spot, the user Tabs to the one they want, and Enter completes it.
   * Escape abandons it. That is a mode, and a mode is a cost -- but it is entered deliberately,
   * it says so on every card while it lasts, and it is the only shape this gesture has that works
   * without a pointing device. */
  function armConnection(nodeId: string): void {
    if (policy === null) return
    endLink()
    const start = policy.canStart(nodeId)
    const port = nodeElements.get(nodeId)?.querySelector('.flg-node-port')
    if (!start.allowed) {
      const box = nodeElements.get(nodeId)?.getBoundingClientRect()
      if (box) showLinkTip(box.right, box.top + box.height / 2, start)
      if (port instanceof HTMLElement) {
        port.classList.add('flg-node-port-refused')
        linkTipTimer = window.setTimeout(() => {
          port.classList.remove('flg-node-port-refused')
          hideLinkTip()
        }, 6000)
      }
      return
    }
    const anchor = linkAnchor(nodeId)
    if (!anchor) return
    link = { pointerId: null, from: nodeId, port: port instanceof HTMLElement ? port : null, anchor, target: null, verdict: null }
    root.classList.add('flg-linking', 'flg-linking-armed')
    nodeElements.get(nodeId)?.classList.add('flg-link-source')
    // Every card answered at once. O(nodes) and once per arming, not per frame -- and it is the
    // whole point of the mode: without it the keyboard user would be tabbing blind through cards
    // that may or may not accept what they are carrying.
    for (const box of nodeBoxes) {
      const id = box.dataset.nodeId
      if (id === undefined || id === nodeId) continue
      markLinkTarget(id, policy.check(nodeId, id).allowed)
    }
    const box = nodeElements.get(nodeId)?.getBoundingClientRect()
    if (box) {
      showLinkTip(box.right, box.top + box.height / 2, {
        allowed: true,
        label: `connecting from ${nodeId}`,
        detail: 'Move to the feature it should place and press Enter. Escape cancels.',
      })
    }
  }

  /** Enter and Escape while a connection is armed, taken in the CAPTURE phase.
   *
   * Capture rather than bubble because a card's own Enter already means "open this" (see
   * makeSelectable), and while a connection is in the user's hand that is not what Enter means.
   * Intercepting here is what lets the card keep its ordinary behaviour the rest of the time
   * instead of learning about a mode it is not part of. */
  function onLinkKeyCapture(event: KeyboardEvent): void {
    if (!link || link.pointerId !== null) return
    if (event.key === 'Escape') {
      endLink()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key !== 'Enter' || policy === null) return
    const found = event.target instanceof Element ? event.target.closest('.flg-node') : null
    const card = found instanceof HTMLElement ? found : null
    const id = card?.dataset.nodeId
    if (card === null || id === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const from = link.from
    const verdict = policy.check(from, id)
    if (!verdict.allowed) {
      const box = card.getBoundingClientRect()
      showLinkTip(box.right, box.top + box.height / 2, verdict)
      return
    }
    endLink()
    emitConnect({ from, to: id, verdict })
  }

  /** Where each nudged node was before the current burst of arrow keys, so the burst reports one
   * move per node rather than one per keypress. */
  const nudgeOrigins = new Map<string, GraphPoint>()
  let nudgeTimer = 0

  function nudgeNode(nodeId: string, dx: number, dy: number): void {
    const rect = rects.get(nodeId)
    if (!rect) return
    if (!nudgeOrigins.has(nodeId)) nudgeOrigins.set(nodeId, { x: rect.x, y: rect.y })
    placeNode(nodeId, rect.x + dx, rect.y + dy)
    rerouteEdges()
    layoutFrames()
    if (nudgeTimer !== 0) window.clearTimeout(nudgeTimer)
    nudgeTimer = window.setTimeout(flushNudges, NUDGE_SETTLE_MS)
  }

  function flushNudges(): void {
    nudgeTimer = 0
    if (nudgeOrigins.size === 0) return
    const moves: GraphNodeMove[] = []
    for (const [nodeId, origin] of nudgeOrigins) {
      const rect = rects.get(nodeId)
      const node = nodeById.get(nodeId)
      if (!rect || !node) continue
      if (rect.x === origin.x && rect.y === origin.y) continue
      moves.push({ nodeId, node, position: anchorPoint(rect.x, rect.y), from: anchorPoint(origin.x, origin.y) })
    }
    nudgeOrigins.clear()
    if (moves.length === 0) return
    recomputeBounds()
    emitMove(moves)
  }

  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const box = root.getBoundingClientRect()
    const px = clientX - box.left
    const py = clientY - box.top
    // Keep the world point under the cursor fixed: solve worldBefore == worldAfter for the new
    // camera origin. Without this, zooming walks the scene off screen and the user spends the
    // whole session re-centering.
    const worldX = camera.x + px / camera.zoom
    const worldY = camera.y + py / camera.zoom
    const zoom = clampZoom(camera.zoom * factor)
    camera = { x: worldX - px / zoom, y: worldY - py / zoom, zoom }
    scheduleCamera()
  }

  function onWheel(event: WheelEvent): void {
    // ctrl/cmd ALWAYS zooms: that is both the VS Code editor's own convention and what a
    // trackpad pinch actually sends (a wheel event with ctrlKey set, from no physical ctrl key).
    const zooming = event.ctrlKey || event.metaKey || wheelBehavior === 'zoom'
    event.preventDefault()
    if (zooming) {
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.002))
      return
    }
    camera = { ...camera, x: camera.x + event.deltaX / camera.zoom, y: camera.y + event.deltaY / camera.zoom }
    scheduleCamera()
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Escape during a drag abandons the drag, and does NOT also clear the selection: one Escape,
    // one undo, and the one the user means is the gesture still in their hand.
    if (event.key === 'Escape' && drag !== null) {
      endDrag(false)
      event.preventDefault()
      return
    }
    if (event.key === 'Escape' && marquee !== null) {
      if (root.hasPointerCapture(marquee.pointerId)) root.releasePointerCapture(marquee.pointerId)
      endMarquee(false)
      event.preventDefault()
      return
    }
    // The same rule for a connection in flight: one Escape, one undo, and the one the user means
    // is the line still in their hand -- not the selection they made a minute ago. (An ARMED,
    // keyboard-driven connection is taken earlier, in onLinkKeyCapture, because the key event is
    // on a card rather than on the canvas.)
    if (event.key === 'Escape' && link !== null) {
      endLink()
      event.preventDefault()
      return
    }
    const step = event.shiftKey ? 240 : 60
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        // Arrows on a focused node belong to that node's host (move focus with Tab); only the
        // canvas itself pans.
        if (event.target !== root) return
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        camera = { ...camera, x: camera.x + dx / camera.zoom, y: camera.y + dy / camera.zoom }
        scheduleCamera()
        event.preventDefault()
        break
      }
      case '+':
      case '=': {
        const box = root.getBoundingClientRect()
        zoomAt(box.left + box.width / 2, box.top + box.height / 2, 1.2)
        event.preventDefault()
        break
      }
      case '-':
      case '_': {
        const box = root.getBoundingClientRect()
        zoomAt(box.left + box.width / 2, box.top + box.height / 2, 1 / 1.2)
        event.preventDefault()
        break
      }
      case '0':
        zoomToFit()
        event.preventDefault()
        break
      case 'Escape':
        if (selection !== null) {
          emitSelect(null)
          event.preventDefault()
        }
        break
      default:
        break
    }
  }

  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerup', onPointerUp)
  root.addEventListener('pointercancel', onPointerUp)
  root.addEventListener('wheel', onWheel, { passive: false })
  root.addEventListener('keydown', onKeyDown)
  root.addEventListener('keydown', onLinkKeyCapture, true)

  /** Wires one selectable element (a node box or an edge chip) to the selection it stands for.
   * Registered under the SAME key setSelection looks up, so host-driven and user-driven
   * selection cannot get out of step. */
  function makeSelectable(element: HTMLElement, key: string, build: () => GraphSelection, activates = true): void {
    element.tabIndex = 0
    element.setAttribute('role', 'button')
    element.setAttribute('aria-pressed', 'false')
    const existing = selectable.get(key)
    if (existing) existing.push(element)
    else selectable.set(key, [element])
    element.addEventListener('pointerdown', (event) => {
      // Every new press starts a new gesture, so the previous one's swallowed click cannot
      // linger and eat this one. It normally clears itself -- a drag's release produces the
      // click that consumes it -- but "normally" is not a guarantee worth resting a whole
      // canvas's clickability on.
      dragConsumedClick = false
      // The MIDDLE button is the canvas's pan-from-anywhere gesture and is let through on
      // purpose -- "including over a node" is what onPointerDown promises, and swallowing every
      // button here was quietly making that false. A primary press is still stopped, so
      // pressing a card never also starts a pan.
      if (event.button === 1) return
      event.stopPropagation()
    })
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      // A drag is not a selection. The browser synthesises a click when a press and its release
      // share an element, which after a drag they usually do -- the cards are 232px wide -- so
      // dropping a node would otherwise re-point the inspector at it as a side effect of
      // arranging the drawing. A few pixels of movement is still a click, though: see
      // DRAG_THRESHOLD_PX, which is what decides which of the two happened.
      if (dragConsumedClick) {
        dragConsumedClick = false
        return
      }
      emitSelect(withModifier(build(), event))
    })
    // `activates` is off for a group's card and header: a group has no file to open, so
    // double-click and Enter mean "expand" there (the card wires that itself) and never "open".
    element.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      if (activates) emitActivate(build())
    })
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        emitSelect(build())
        if (activates) emitActivate(build())
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        emitSelect(build())
      }
    })
  }

  /** A click's selection, once the modifier keys have had their say.
   *
   * Ctrl (Cmd on a Mac) TOGGLES a card in the selection, which is the convention every file
   * manager and every drawing tool shares and so needs no learning: click adds, click again
   * removes, and what is left is whatever the rule in selectionOfNodes says it is. A group card
   * joins a multi-selection as a card, the way it joins a marquee. Edges and frame headers take
   * no modifier -- a multi-selection is of things that can be moved together, and neither can. */
  function withModifier(next: GraphSelection, event: MouseEvent): GraphSelection {
    if (!(event.ctrlKey || event.metaKey)) return next
    const clicked = next?.kind === 'node' ? next.nodeId : next?.kind === 'group' ? groupCardNodeId(next.groupId) : null
    if (clicked === null) return next
    const held = selection?.kind === 'group' ? groupCardNodeId(selection.groupId) : null
    const current: string[] = selection?.kind === 'nodes' ? [...selection.nodeIds] : selection?.kind === 'node' ? [selection.nodeId] : held === null ? [] : [held]
    const without = current.filter((id) => id !== clicked)
    return selectionOfNodes(without.length === current.length ? [...current, clicked] : without)
  }

  /** The node id of a collapsed group's card, or null while the group is expanded (a frame is not
   * a node and cannot join a multi-selection). */
  function groupCardNodeId(groupId: string): string | null {
    return groupCards.get(groupId)?.dataset.nodeId ?? null
  }

  // -- drawing -------------------------------------------------------------

  /** Sizes and places every frame around its members' rects. Pure geometry over `rects`, no
   * graph walk, so it is cheap enough to run on every drag frame -- which it does, because a
   * frame that lagged its members would read as the members having left it. */
  function layoutFrames(): void {
    for (const frame of frames) {
      const drawn = frameElements.get(frame.groupId)
      if (!drawn) continue
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const id of frame.memberIds) {
        const rect = rects.get(id)
        if (!rect) continue
        minX = Math.min(minX, rect.x)
        minY = Math.min(minY, rect.y)
        maxX = Math.max(maxX, rect.x + rect.w)
        maxY = Math.max(maxY, rect.y + rect.h)
      }
      if (!Number.isFinite(minX)) {
        drawn.frame.hidden = true
        continue
      }
      drawn.frame.hidden = false
      drawn.frame.style.left = `${round(minX - FRAME_PAD)}px`
      drawn.frame.style.top = `${round(minY - FRAME_PAD - FRAME_HEAD)}px`
      drawn.frame.style.width = `${round(maxX - minX + FRAME_PAD * 2)}px`
      drawn.frame.style.height = `${round(maxY - minY + FRAME_PAD * 2 + FRAME_HEAD)}px`
    }
  }

  /** The chevron both a frame's header and a collapsed card carry. A `div` with a button role,
   * for the same reason the connector handle is one: it sits inside an element that is already a
   * button. */
  function chevron(groupId: string, collapsed: boolean, name: string): HTMLElement {
    const button = el('div', collapsed ? 'flg-group-chevron flg-group-chevron-expand' : 'flg-group-chevron flg-group-chevron-collapse')
    button.tabIndex = 0
    button.setAttribute('role', 'button')
    button.setAttribute('aria-label', collapsed ? `Expand ${name}` : `Collapse ${name}`)
    button.title = collapsed ? 'Expand: show the members again. Written to their files.' : 'Collapse: fold the members into one card. Written to their files.'
    button.textContent = collapsed ? '▸' : '▾'
    button.addEventListener('pointerdown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      emitGroupToggle(groupId, !collapsed)
    })
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      emitGroupToggle(groupId, !collapsed)
    })
    return button
  }

  /** One expanded group's frame: a bordered box behind its members and a header that names it.
   * The header is the control -- it selects the group and drags every member; the body is inert
   * so the canvas under it still pans and marquees. */
  function renderFrame(frame: GraphFrameWire): HTMLElement {
    const box = el('div', 'flg-frame')
    box.dataset.groupId = frame.groupId
    const head = el('div', 'flg-frame-head')
    const name = el('span', 'flg-frame-name')
    name.textContent = frame.name
    name.title = `${frame.name}\n${String(frame.memberIds.length)} member${frame.memberIds.length === 1 ? '' : 's'}. Drag the header to move them together.`
    head.append(name, chevron(frame.groupId, false, frame.name))
    head.setAttribute('aria-label', `Group ${frame.name}, ${String(frame.memberIds.length)} members`)
    head.setAttribute('aria-keyshortcuts', 'Enter')
    makeSelectable(head, JSON.stringify(['group', frame.groupId]), () => ({ kind: 'group', groupId: frame.groupId }), false)
    const first = frame.memberIds[0]
    if (first !== undefined) {
      head.addEventListener('pointerdown', (event) => beginDrag(event, first, head, frame.memberIds))
      head.addEventListener('pointermove', onDragMove)
      head.addEventListener('pointerup', onDragEnd)
      head.addEventListener('pointercancel', onDragCancel)
    }
    box.append(head)
    frameElements.set(frame.groupId, { frame: box, head })
    return box
  }

  /** A COLLAPSED group's card: what a folded group draws as, in the place of its members.
   *
   * Deliberately a different shape from a feature card -- stacked, with the count on it and no
   * type line -- because it stands for several files and none of a feature card's rows would be
   * true of it. It is a node to everything that moves and connects: edges attach to it, a drag
   * carries it (the host moves the members), and it sits in the same selection registry, so
   * selecting it is selecting the GROUP. */
  function renderGroupCard(node: GraphNodeWire, group: GraphNodeGroupWire, rect: GraphRect, isRoot: boolean): HTMLElement {
    const box = el('div', 'flg-node flg-node-group')
    box.style.left = `${rect.x}px`
    box.style.top = `${rect.y}px`
    box.dataset.nodeId = node.id
    box.dataset.groupId = group.id
    box.dataset.category = 'group'
    if (isRoot) box.classList.add('flg-node-root')

    const head = el('div', 'flg-node-head')
    const icon = el('span', 'flg-node-icon')
    icon.textContent = '▣'
    icon.setAttribute('aria-hidden', 'true')
    const idLine = el('div', 'flg-node-id')
    idLine.textContent = group.name
    idLine.title = group.name
    head.append(icon, idLine)
    box.append(head)

    const body = el('div', 'flg-node-body')
    const countLine = el('div', 'flg-node-type flg-node-group-count')
    countLine.textContent = `${String(group.count)} feature${group.count === 1 ? '' : 's'}`
    body.append(countLine)
    const badges = el('div', 'flg-node-badges')
    if (isRoot) {
      const badge = el('span', 'flg-badge flg-badge-root')
      badge.textContent = 'root'
      badge.title = 'Nothing outside this group delegates into it.'
      badges.append(badge)
    }
    body.append(badges)
    box.append(body)
    box.append(chevron(group.id, true, group.name))

    box.title = `${group.name}\nA group of ${String(group.count)} feature${group.count === 1 ? '' : 's'}, collapsed. Double-click or use the chevron to expand it.`
    box.setAttribute('aria-label', `Group ${group.name}, collapsed, ${String(group.count)} features${isRoot ? ', root' : ''}`)
    box.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight')
    makeSelectable(box, JSON.stringify(['group', group.id]), () => ({ kind: 'group', groupId: group.id }), false)
    // Double-click expands rather than "opens": a group has no file of its own to open, and the
    // one thing somebody double-clicking a folded thing wants is to see inside it.
    box.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      emitGroupToggle(group.id, false)
    })
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      event.stopPropagation()
      emitGroupToggle(group.id, false)
    })
    box.addEventListener('pointerdown', (event) => beginDrag(event, node.id, box, dragSetFor(node.id)))
    box.addEventListener('pointermove', onDragMove)
    box.addEventListener('pointerup', onDragEnd)
    box.addEventListener('pointercancel', onDragCancel)
    box.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      if (dx === 0 && dy === 0) return
      event.preventDefault()
      event.stopPropagation()
      nudgeNode(node.id, dx, dy)
    })
    groupCards.set(group.id, box)
    return box
  }

  /** One node card.
   *
   * THE SHAPE IS A HEADER OVER A BODY, and the header carries the IDENTIFIER. That is the whole
   * correction over the first version of this file, which set the type in the only emphasised
   * style on the box and left the id as a thin grey line: the id is the thing a person is
   * looking for -- it is what the pack's other files delegate by, what the inspector titles
   * itself with, and what someone types into a search -- while the type is context for it. A
   * card whose loudest text is `scatter_feature` is a card you have to read twice to find
   * `example:oak_on_grass` in.
   *
   * The header is tinted by the node's CATEGORY (see summariseNodes), so a card and the edges
   * leaving it share a hue and a chain reads as a chain. The tint is never alone: the same
   * category is stated by the glyph beside the id, by the type name written out in the body, and
   * by the fan-out line naming the edge kind in words. */
  function renderNode(node: GraphNodeWire, rect: GraphRect, isRoot: boolean, inCycle: boolean, isGhost: boolean, summary: NodeSummary): HTMLElement {
    const box = el('div', 'flg-node')
    box.style.left = `${rect.x}px`
    box.style.top = `${rect.y}px`
    box.dataset.nodeId = node.id
    box.dataset.coverage = node.coverage ?? (node.external ? 'external' : node.unresolved ? 'unresolved' : 'unknown')
    box.dataset.category = summary.category
    // EXTERNAL AND UNRESOLVED ARE MUTUALLY EXCLUSIVE ON THE CARD, even though the contract sets
    // both flags on the same node. They are opposite claims -- "the game has this" against "the
    // pack is missing this" -- and a card wearing both would read as the second one, which is
    // exactly the wrong error.
    if (node.external) box.classList.add('flg-node-external')
    else if (node.unresolved) box.classList.add('flg-node-unresolved')
    if (inCycle) box.classList.add('flg-node-cycle')
    if (isRoot) box.classList.add('flg-node-root')

    const head = el('div', 'flg-node-head')
    const icon = el('span', 'flg-node-icon')
    icon.textContent = summary.mark
    icon.setAttribute('aria-hidden', 'true')
    head.append(icon)

    const idLine = el('div', 'flg-node-id')
    idLine.textContent = node.id
    idLine.title = node.id
    head.append(idLine)

    box.append(head)

    const body = el('div', 'flg-node-body')

    const typeLine = el('div', 'flg-node-type')
    if (node.external) {
      // The type line is the card's one line of prose, and on an external node it is the whole
      // explanation: this is a feature the game ships, it works, and the reason there is no file
      // to open is not that one is missing.
      typeLine.textContent = 'provided by the game'
      typeLine.title =
        `"${node.id}" is one of the game's own features. This pack delegates to it and does not define it, which is correct -- it resolves when the world generates.\n` +
        'Nothing appears for it in a preview here: this tool does not simulate the features the game itself supplies.'
      typeLine.classList.add('flg-node-type-external')
    } else if (node.unresolved) {
      typeLine.textContent = isGhost ? 'referenced, not in this graph' : 'not defined in this pack'
      typeLine.title = `"${node.id}" is delegated to but never defined. The edge into it is drawn dangling on purpose.`
      typeLine.classList.add('flg-node-type-absent')
    } else {
      const typeId = node.typeId ?? ''
      // The `minecraft:` prefix is on every single type and costs ten characters of a box that
      // has about thirty -- dropping it is the difference between reading
      // "vegetation_patch_feature" and reading "minecraft:vegetation_pa...". The full value
      // stays on the title and in the dataset, so nothing that needs the exact string loses it.
      typeLine.textContent = typeId.startsWith(MINECRAFT_NS) ? typeId.slice(MINECRAFT_NS.length) : typeId || '(no type)'
      typeLine.title = typeId ? `${typeId}${node.formatVersion ? `\nformat_version ${node.formatVersion}` : ''}${node.file ? `\n${node.file}` : ''}` : 'no type id'
      if (typeId) box.dataset.typeId = typeId
    }
    body.append(typeLine)

    // What the card can say that its FIELDS cannot. A tree feature with fifteen trunk variants
    // has no room for them; "3 scatter out, 11 in" fits, and on a graph whose real shape is
    // dozens of parents sharing a handful of children the fan-IN is what tells you which box is
    // load-bearing before you click anything.
    const fanOut = describeFanOut(summary)
    const fanIn = describeFanIn(summary)
    if (fanOut.label || fanIn.label) {
      const meta = el('div', 'flg-node-meta')
      if (fanOut.label) {
        const out = el('span', 'flg-node-fan flg-node-fan-out')
        out.textContent = `→ ${fanOut.label}`
        out.title = fanOut.title
        meta.append(out)
      }
      if (fanIn.label) {
        const into = el('span', 'flg-node-fan flg-node-fan-in')
        into.textContent = `← ${fanIn.label}`
        into.title = fanIn.title
        meta.append(into)
      }
      body.append(meta)
    }

    const badges = el('div', 'flg-node-badges')
    const coverage = describeCoverage(node)
    if (coverage.label) {
      const badge = el('span', `flg-badge flg-coverage flg-coverage-${coverage.tone}`)
      badge.textContent = coverage.label
      badge.title = coverage.title
      badges.append(badge)
    }
    if (isRoot) {
      const badge = el('span', 'flg-badge flg-badge-root')
      badge.textContent = 'root'
      badge.title = 'A root: nothing delegates to this node. An editor opens on these.'
      badges.append(badge)
    }
    if (inCycle) {
      const badge = el('span', 'flg-badge flg-badge-cycle')
      badge.textContent = 'cycle'
      badge.title = 'This node is part of a delegation cycle. Cycles are legal -- the engine\'s recursion guard stops them at run time -- but they are worth knowing about.'
      badges.append(badge)
    }
    if (node.annotations && node.annotations.length > 0) {
      const badge = el('span', 'flg-badge flg-badge-annotated')
      badge.textContent = `@${node.annotations.length}`
      badge.title = node.annotations.map((a) => `@featurelab:${a.name}${a.args && a.args.length ? ` ${a.args.join(' ')}` : ''}${a.text ? `\n  ${a.text}` : ''}`).join('\n')
      badges.append(badge)
    }
    body.append(badges)

    box.append(body)

    // On the BOX, so the far zoom band -- where every line of text is hidden because at that
    // scale it is a smear rather than a word -- still answers "what is this block" on hover.
    // The one line that stands in for the type, per state. A screen reader and a hover at far
    // zoom both read this, so an external node must not be announced as an unresolved one.
    const standing = node.external ? 'provided by the game' : node.unresolved ? 'not defined in this pack' : node.typeId || 'no type'
    box.title =
      `${node.id}\n${standing}` +
      (fanOut.title ? `\n${fanOut.title}` : '') +
      (fanIn.title ? `\n${fanIn.title}` : '') +
      (coverage.label ? `\n${coverage.label}` : '')

    box.setAttribute(
      'aria-label',
      `${node.id}, ${node.external ? 'provided by the game' : node.unresolved ? 'unresolved reference' : node.typeId || 'no type'}${coverage.label ? `, coverage ${coverage.label}` : ''}${isRoot ? ', root' : ''}${inCycle ? ', in a cycle' : ''}${fanOut.label ? `, ${fanOut.label} out` : ''}${fanIn.label ? `, ${fanIn.label} in` : ''}`,
    )
    // Announced rather than written into the label: every card would otherwise carry the same
    // sentence about the arrow keys, which on a fifty-seven-card pack is fifty-seven repetitions
    // of one fact. `aria-keyshortcuts` is the attribute for exactly this -- available when asked
    // for, silent when not.
    box.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight')
    // Whatever the last run said about this node, if anything. Here rather than in `render` so a
    // redraw after an edit keeps the row instead of dropping it until the next preview.
    applyNodeStatsTo(box, node.id)
    makeSelectable(box, JSON.stringify(['node', node.id]), () => ({ kind: 'node', nodeId: node.id, node }))

    // Pointer events, not HTML5 drag-and-drop. DnD gives a drag image instead of the real card,
    // fires no usable coordinates during the drag, and is unreliable inside a webview -- three
    // reasons that each on their own would rule it out for a canvas whose whole job is "this
    // box, exactly here".
    box.addEventListener('pointerdown', (event) => beginDrag(event, node.id, box, dragSetFor(node.id)))
    box.addEventListener('pointermove', onDragMove)
    box.addEventListener('pointerup', onDragEnd)
    box.addEventListener('pointercancel', onDragCancel)

    // A node that can only be moved with a mouse cannot be moved by everyone. The arrows already
    // pan the canvas when the canvas itself has focus (see onKeyDown, which checks its target
    // for exactly this reason); on a focused CARD they move the card, which is the conventional
    // division and needs nothing learned.
    box.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
      let dx = 0
      let dy = 0
      switch (event.key) {
        case 'ArrowLeft':
          dx = -step
          break
        case 'ArrowRight':
          dx = step
          break
        case 'ArrowUp':
          dy = -step
          break
        case 'ArrowDown':
          dy = step
          break
        default:
          return
      }
      event.preventDefault()
      event.stopPropagation()
      nudgeNode(node.id, dx, dy)
    })

    // THE CONNECTOR HANDLE. On the card's right border, where its outgoing edges already attach,
    // and rendered only when a policy exists to answer for it -- see beginLink for why this is a
    // handle and not a modifier-drag.
    //
    // A `div` with `role="button"` rather than a real <button>: the CARD is already a button (see
    // makeSelectable), and a button inside a button is not markup a browser or a screen reader
    // handles -- one of the two stops being announced. The role and the tab stop are what a
    // control actually needs.
    if (policy !== null) {
      const port = el('div', 'flg-node-port')
      port.dataset.portFor = node.id
      port.tabIndex = 0
      port.setAttribute('role', 'button')
      port.setAttribute('aria-label', `Connect a delegation from ${node.id}`)
      port.setAttribute('aria-keyshortcuts', 'Enter')
      // Asked once, at render, so every handle carries its own answer before it is touched --
      // including the refusal, which is the whole tooltip on a type that holds no other feature.
      const start = policy.canStart(node.id)
      port.title = start.allowed
        ? `Drag from here to the feature ${node.id} should place.\n${start.detail}`
        : `${node.id} cannot place another feature.\n${start.detail}`
      if (!start.allowed) port.dataset.refuses = 'true'
      port.addEventListener('pointerdown', (event) => beginLink(event, node.id, port))
      port.addEventListener('pointermove', onLinkMove)
      port.addEventListener('pointerup', onLinkEnd)
      port.addEventListener('pointercancel', onLinkCancel)
      // The press was already swallowed; the click the browser synthesises after it must be too,
      // or finishing a connection would also re-point the inspector at the node it started from.
      port.addEventListener('click', (event) => event.stopPropagation())
      port.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        armConnection(node.id)
      })
      box.append(port)
    }
    return box
  }

  function renderChip(badge: EdgeBadge, at: GraphPoint, edge: GraphEdgeWire, index: number, inCycle: boolean): HTMLElement {
    const chip = el('div', `flg-chip flg-chip-${edge.kind}`)
    for (const modifier of badge.modifiers) chip.classList.add(`flg-chip-${modifier}`)
    if (inCycle) chip.classList.add('flg-chip-cycle')
    chip.style.left = `${round(at.x)}px`
    chip.style.top = `${round(at.y)}px`
    chip.title = badge.title
    chip.dataset.edgeKind = edge.kind

    if (badge.mark) {
      const mark = el('span', 'flg-chip-mark')
      mark.textContent = badge.mark
      mark.setAttribute('aria-hidden', 'true')
      chip.append(mark)
    }
    const label = el('span', 'flg-chip-label')
    label.textContent = badge.label
    chip.append(label)
    if (badge.detail) {
      const detail = el('span', 'flg-chip-detail')
      detail.textContent = badge.detail
      chip.append(detail)
    }
    if (badge.share !== null) {
      // A weight is only a probability relative to its siblings, so the share gets a shape as
      // well as a number -- a row of bars is comparable at a glance in a way a row of
      // percentages is not.
      const bar = el('span', 'flg-chip-bar')
      const fill = el('span', 'flg-chip-bar-fill')
      fill.style.width = `${Math.max(0, Math.min(1, badge.share)) * 100}%`
      bar.append(fill)
      chip.append(bar)
    }
    chip.setAttribute('aria-label', `${edge.kind} edge from ${edge.from} to ${edge.to}: ${badge.label}${badge.detail ? ` ${badge.detail}` : ''}`)
    makeSelectable(chip, JSON.stringify(['edge', edgeKey(edge)]), () => ({ kind: 'edge', edgeKey: edgeKey(edge), edgeIndex: index, edge }))
    return chip
  }

  function render(next: GraphWire, positions: ReadonlyMap<string, GraphPoint>, nextFrames: readonly GraphFrameWire[] = []): void {
    graph = next
    frames = nextFrames
    selectable.clear()
    nodeById.clear()
    edgeByKey.clear()
    nodeElements.clear()
    frameElements.clear()
    groupCards.clear()
    edgeVisuals.length = 0
    selfLoopOverhang.clear()
    if (marquee !== null) {
      if (root.hasPointerCapture(marquee.pointerId)) root.releasePointerCapture(marquee.pointerId)
      endMarquee(false)
    }
    // `positions` is authoritative, so a redraw ends whatever gesture was in flight rather than
    // finishing it against a scene that no longer exists. Nothing is reported: a move the host
    // has not seen the end of is a move the host did not ask to be told about.
    if (drag !== null) endDrag(false)
    // Likewise a connection: the cards it was drawn between are about to be replaced, and a line
    // anchored to an element that no longer exists is a line pointing at nothing.
    if (link !== null) endLink()
    hideLinkTip()
    litLinkBoxes.length = 0
    if (nudgeTimer !== 0) {
      window.clearTimeout(nudgeTimer)
      nudgeTimer = 0
    }
    nudgeOrigins.clear()

    const resolved = resolvePositions(next, positions, anchor)
    rects = resolved.rects

    const roots = new Set(next.roots)
    // Flat over `cycles`; never a traversal. A cycle list is at most a few entries on a real
    // pack, and the contract's own warning -- "an editor must not lay out or walk the graph as
    // if [cycles] cannot happen" -- is satisfied by not walking it at all.
    const cycleNodes = new Set<string>()
    const cycleEdges = new Set<string>()
    for (const cycle of next.cycles ?? []) {
      for (let i = 0; i < cycle.length; i++) {
        const from = cycle[i]
        const to = cycle[(i + 1) % cycle.length]
        if (from === undefined || to === undefined) continue
        cycleNodes.add(from)
        // Keyed on the pair rather than on an edge identity: `cycles` reports node ids, not
        // which of several parallel edges between them closed the loop, so every edge along the
        // pair is marked. Over-marking is the safe direction -- the alternative is a cycle
        // nobody can see on the canvas.
        cycleEdges.add(JSON.stringify([from, to]))
      }
    }

    const summaries = summariseNodes(next)
    nodeBoxes.length = 0
    litElements.length = 0
    const nodesFragment = document.createDocumentFragment()
    const chipsFragment = document.createDocumentFragment()

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const track = (r: GraphRect): void => {
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.w)
      maxY = Math.max(maxY, r.y + r.h)
    }

    for (const node of next.nodes) {
      nodeById.set(node.id, node)
      const rect = rects.get(node.id)
      if (!rect) continue
      track(rect)
      const box = node.group
        ? renderGroupCard(node, node.group, rect, roots.has(node.id))
        : renderNode(node, rect, roots.has(node.id), cycleNodes.has(node.id), false, summaries.get(node.id) ?? EMPTY_SUMMARY)
      nodeBoxes.push(box)
      nodeElements.set(node.id, box)
      nodesFragment.append(box)
    }
    for (const id of resolved.ghosts) {
      const rect = rects.get(id)
      if (!rect) continue
      // Synthesised, not from the wire -- see resolvePositions' own doc comment. Marked
      // unresolved so it reads exactly like the contract's own unresolved node, because to the
      // person looking at it the situation is identical: a delegation whose target is not here.
      const ghost: GraphNodeWire = { id, unresolved: true }
      nodeById.set(id, ghost)
      track(rect)
      const box = renderNode(ghost, rect, false, cycleNodes.has(id), true, { ...(summaries.get(id) ?? EMPTY_SUMMARY), category: 'unresolved', mark: CATEGORY_MARK.unresolved })
      nodeBoxes.push(box)
      nodeElements.set(id, box)
      nodesFragment.append(box)
    }

    // Parallel edges are fanned apart by their position within the PAIR they join (unordered,
    // so a 2-cycle's two directions share one fan and separate), see EDGE_BOW_STEP.
    const pairCounts = new Map<string, number>()
    const pairSeen = new Map<string, number>()
    for (const edge of next.edges) {
      const key = edge.from <= edge.to ? JSON.stringify([edge.from, edge.to]) : JSON.stringify([edge.to, edge.from])
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
    }

    const siblingIndex = buildSiblingIndex(next.edges)
    // Where each edge attaches to each of its two nodes. Computed once for the whole graph,
    // because a port's position depends on how many OTHER edges share that side -- see
    // assignPorts for why a shared child with eleven parents is unreadable without this.
    const ports = assignPorts(next.edges, rects)
    // Which boxes a chip must not land on -- see chipAnchor.
    const boxGrid = new RectGrid(rects.values())
    const edgeParts: SVGElement[] = []
    edgeGroupsByNode.clear()
    const remember = (id: string, element: Element): void => {
      const list = edgeGroupsByNode.get(id)
      if (list) list.push(element)
      else edgeGroupsByNode.set(id, [element])
    }

    for (let index = 0; index < next.edges.length; index++) {
      const edge = next.edges[index]
      if (!edge) continue
      edgeByKey.set(edgeKey(edge), { edge, index })
      const fromRect = rects.get(edge.from)
      const toRect = rects.get(edge.to)
      if (!fromRect || !toRect) continue

      const pairKey = edge.from <= edge.to ? JSON.stringify([edge.from, edge.to]) : JSON.stringify([edge.to, edge.from])
      const count = pairCounts.get(pairKey) ?? 1
      const seen = pairSeen.get(pairKey) ?? 0
      pairSeen.set(pairKey, seen + 1)

      const port = ports.get(index)
      // The bow only has work to do for a pair joined more than once: ports already separate
      // every other edge at both ends, and bowing a lone edge would just make it wander.
      const bow = count > 1 ? (seen - (count - 1) / 2) * EDGE_BOW_STEP : 0
      const geometry =
        edge.from === edge.to || !port
          ? selfLoopGeometry(fromRect, seen)
          : routedGeometry(port.from, port.fromRight, port.to, port.toRight, bow)
      if (edge.from === edge.to) {
        track({ x: fromRect.x, y: geometry.label.y - 20, w: fromRect.w, h: 20 })
        // Remembered so recomputeBounds can put it back after a move, without re-walking the
        // edges for a number that only a re-render can change.
        selfLoopOverhang.set(edge.from, Math.max(selfLoopOverhang.get(edge.from) ?? 0, fromRect.y - (geometry.label.y - 20)))
      }

      const badge = describeEdge(edge, siblingsFor(siblingIndex, edge))
      const inCycle = cycleEdges.has(JSON.stringify([edge.from, edge.to]))
      const key = JSON.stringify(['edge', edgeKey(edge)])
      // An edge into a feature the GAME provides is not dangling. It is a delegation that
      // resolves, drawn to a box that simply lives outside this pack -- so it gets its own
      // quieter treatment rather than the broken-reference fade, which would put a red line on
      // every one of the working references a typical pack has.
      const external = nodeById.get(edge.to)?.external ?? false
      const dangling = !external && ((nodeById.get(edge.to)?.unresolved ?? false) || resolved.ghosts.has(edge.to))

      const group = svg('g', `flg-edge flg-edge-${edge.kind}${inCycle ? ' flg-edge-cycle' : ''}${dangling ? ' flg-edge-dangling' : ''}${external ? ' flg-edge-external' : ''}${edge.required ? ' flg-edge-required' : ''}`)
      group.setAttribute('data-edge-key', edgeKey(edge))
      group.setAttribute('data-edge-kind', edge.kind)

      // A casing: the same path, drawn first, wider, in the canvas background colour. Where two
      // edges cross at a shallow angle -- which is most crossings in a layered drawing -- two
      // bare strokes merge into an X nobody can trace through. A casing makes the later edge
      // pass visibly OVER the earlier one, the way a road atlas draws a flyover, and costs one
      // extra path per edge and no layout.
      const casing = svg('path', 'flg-edge-casing')
      casing.setAttribute('d', geometry.path)
      const line = svg('path', 'flg-edge-line')
      line.setAttribute('d', geometry.path)
      const head = svg('path', 'flg-edge-arrow')
      head.setAttribute('d', geometry.arrow)
      // A transparent fat stroke over the thin visible one: an edge drawn at 1.5px is nearly
      // impossible to hit with a mouse, and "select an edge" has to work without the user
      // hunting for the exact pixel. It carries no paint of its own.
      const hit = svg('path', 'flg-edge-hit')
      hit.setAttribute('d', geometry.path)
      group.append(casing, line, head, hit)
      edgeParts.push(group)

      const chipElement = renderChip(badge, chipAnchor(geometry, boxGrid), edge, index, inCycle)
      chipsFragment.append(chipElement)
      // Everything a move has to re-write, plus the ports it was drawn with. rerouteEdges reads
      // both; see its own comment for why the cached ports are the cheap half of a drag.
      edgeVisuals.push({
        edge,
        index,
        casing,
        line,
        arrow: head,
        hit,
        chip: chipElement,
        bow,
        selfIndex: seen,
        fromRight: port?.fromRight ?? false,
        toRight: port?.toRight ?? false,
        fromX: port ? port.from.x : fromRect.x,
        fromY: port ? port.from.y : fromRect.y,
        toX: port ? port.to.x : 0,
        toY: port ? port.to.y : 0,
      })
      // Both ends, so selecting a node can light up everything that touches it -- see
      // paintSelection. A node with eleven parents is the case this exists for: the eleven lines
      // are drawn and fanned, but picking YOURS out of them is a matter of dimming the other
      // thirty-nine edges on the canvas, not of drawing the eleven better.
      remember(edge.from, group)
      remember(edge.from, chipElement)
      remember(edge.to, group)
      remember(edge.to, chipElement)
      // Clicking the LINE selects the same edge its chip does -- a chip is a small target on a
      // long edge, and someone tracing a delegation reaches for the line. The listeners go on
      // the fat invisible hit path, but the GROUP is what gets registered under the selection
      // key: the class has to land on an ancestor of both the visible line and the arrowhead
      // for `.flg-edge.flg-selected .flg-edge-line` to restyle them together.
      const existing = selectable.get(key)
      if (existing) existing.push(group)
      else selectable.set(key, [group])
      hit.addEventListener('pointerdown', (event) => event.stopPropagation())
      hit.addEventListener('click', (event) => {
        event.stopPropagation()
        emitSelect({ kind: 'edge', edgeKey: edgeKey(edge), edgeIndex: index, edge })
      })
      hit.addEventListener('dblclick', (event) => {
        event.stopPropagation()
        emitActivate({ kind: 'edge', edgeKey: edgeKey(edge), edgeIndex: index, edge })
      })
    }

    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }
    contentBounds = { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) }

    edgeLayer.replaceChildren(...edgeParts)
    applyEdgeStops()
    sizeLayers(maxX, maxY)

    nodeLayer.replaceChildren(nodesFragment)
    chipLayer.replaceChildren(chipsFragment)

    // The frames, from the member rects just placed. A frame whose members are all absent is
    // hidden by layoutFrames rather than skipped here, so the count of frames stays what the host
    // said and the selection registry can still find the group.
    const framesFragment = document.createDocumentFragment()
    for (const frame of nextFrames) framesFragment.append(renderFrame(frame))
    frameLayer.replaceChildren(framesFragment)
    layoutFrames()

    // A re-render after an edit must not silently drop a selection whose subject still exists,
    // and must not keep one whose subject is gone.
    selection = resolveSelection(selection)
    paintSelection()
    applyCamera()
  }

  /** A selection re-read against what is drawn now: the same subject, or null when it is gone.
   * A multi-selection keeps the survivors and steps down to a single node -- or nothing -- when
   * fewer than two remain, so the "two or more" rule holds after a delete as well as before. */
  function resolveSelection(next: GraphSelection): GraphSelection {
    if (!next) return null
    switch (next.kind) {
      case 'node': {
        const node = nodeById.get(next.nodeId)
        if (!node) return null
        // A card that now stands for a group is the group.
        return node.group ? { kind: 'group', groupId: node.group.id } : { kind: 'node', nodeId: next.nodeId, node }
      }
      case 'edge': {
        const found = edgeByKey.get(next.edgeKey)
        return found ? { kind: 'edge', edgeKey: next.edgeKey, edgeIndex: found.index, edge: found.edge } : null
      }
      case 'nodes':
        return selectionOfNodes(next.nodeIds.filter((id) => nodeElements.has(id)))
      case 'group':
        return frameElements.has(next.groupId) || groupCards.has(next.groupId) ? next : null
    }
  }

  function zoomToFit(paddingPx = 40): void {
    const box = root.getBoundingClientRect()
    const width = box.width || host.clientWidth
    const height = box.height || host.clientHeight
    if (contentBounds.w <= 0 || contentBounds.h <= 0 || width <= 0 || height <= 0) return
    const zoom = clampZoom(Math.min((width - paddingPx * 2) / contentBounds.w, (height - paddingPx * 2) / contentBounds.h))
    camera = {
      zoom,
      x: contentBounds.x + contentBounds.w / 2 - width / (2 * zoom),
      y: contentBounds.y + contentBounds.h / 2 - height / (2 * zoom),
    }
    scheduleCamera()
  }

  // -- one run's measurements, on the cards -------------------------------
  //
  // Held here rather than passed through render(), because the two change on completely
  // different clocks: the graph changes when a FILE changes, the stats when a PREVIEW finishes,
  // and neither should make the other redraw.
  let nodeStats: ReadonlyMap<string, NodeCardStats> | null = null

  /** The run row, built once and used by both the incremental pass and renderNode.
   *
   * Three separate spans, each with its own title. Not one string: they are three different
   * questions (see NodeCardStats), and a reader hovering the delegation count should be told
   * about delegations rather than about the run in general. */
  function statsRow(stats: NodeCardStats): HTMLElement {
    const wrap = el('span', 'flg-node-stats')
    wrap.title = stats.summary

    const wrote = el('span', 'flg-node-stat flg-node-stat-writes')
    wrote.textContent = `${formatStatCount(stats.blocksWritten)} blk`
    wrote.title = 'Blocks this feature wrote in this run while it was the innermost one executing. A sub-feature\u2019s writes are its own, not this one\u2019s.'
    wrap.append(wrote)

    const ran = el('span', 'flg-node-stat flg-node-stat-entered')
    ran.textContent = `\u00d7${formatStatCount(stats.entered)}`
    ran.title = 'Times this feature\u2019s own placement ran in this run.'
    wrap.append(ran)

    // Always drawn, including at nought. This is the counter the whole row exists for: a wrapper
    // that hands off relentlessly and writes nothing looks identical to an idle one if the
    // number only appears once it is interesting, and "0 delegations" is itself the answer for a
    // composite somebody expected to be delegating.
    const passed = el('span', 'flg-node-stat flg-node-stat-delegations')
    passed.textContent = `\u2192${formatStatCount(stats.delegations)}`
    passed.title = 'Hand-offs to a sub-feature in this run, including hand-offs whose target wrote nothing.'
    wrap.append(passed)

    return wrap
  }

  /** Puts the current run's row on one card, or takes it off.
   *
   * It goes in the FAN LINE, which is the one row on a 232x86 card with spare width -- and the
   * card's budget is five rows with a few pixels over (media/graph.css says so beside the size).
   * A sixth row would overflow, and a row that appeared when a preview finished would change
   * what the card shows under a pointer that had not moved.
   *
   * A card with no fan labels has no fan line at all, so one is created -- and removed again with
   * the stats, so taking the row off leaves the card exactly as it was. */
  function applyNodeStatsTo(box: HTMLElement, nodeId: string): void {
    box.querySelector('.flg-node-stats')?.remove()
    box.querySelector('.flg-badge-stop')?.remove()
    delete box.dataset['stopped']
    const stats = nodeStats?.get(nodeId)
    // The stop goes in the badge row, not the fan line: that line is already five rows' worth of
    // budget spent, and a stop is the one thing a run can say about a node that needs words.
    const stops = stats?.stops ?? []
    if (stops.length > 0) {
      const badge = el('span', 'flg-badge flg-badge-stop')
      badge.textContent = stops.length > 1 ? `${stops[0]!.label} +${stops.length - 1}` : stops[0]!.label
      badge.title = stops.map((stop) => stop.title).join('\n')
      box.querySelector('.flg-node-badges')?.prepend(badge)
      if (stats!.blocksWritten === 0 && stats!.delegations === 0) box.dataset['stopped'] = 'yes'
    }
    if (stats === undefined) {
      // Only a row THIS function created, never one the card drew for its own fan labels.
      box.querySelector('.flg-node-meta-stats-only')?.remove()
      return
    }
    let meta = box.querySelector('.flg-node-meta') as HTMLElement | null
    if (meta === null) {
      meta = el('div', 'flg-node-meta flg-node-meta-stats-only')
      // After the type line, which is where the fan line sits when there is one. Appending to the
      // body instead would land it below the badges: those carry `margin-top: auto`.
      const typeLine = box.querySelector('.flg-node-type')
      if (typeLine === null) return
      typeLine.after(meta)
    }
    meta.append(statsRow(stats))
  }

  /** Marks every drawn edge a stop applies to: the edge whose ordinal the stop names, or every
   * edge leaving the node for a stop about the whole node. The mark is a class and an SVG title,
   * so hovering the line says why nothing went down it. */
  function applyEdgeStops(): void {
    for (const group of edgeLayer.querySelectorAll('.flg-edge-stopped')) {
      group.classList.remove('flg-edge-stopped')
      group.querySelector(':scope > title.flg-edge-stop-title')?.remove()
    }
    if (nodeStats === null) return
    for (const edge of graph.edges) {
      const stops = nodeStats.get(edge.from)?.stops
      if (stops === undefined || stops.length === 0) continue
      const applying = stops.filter((stop) => stop.ordinal === undefined || stop.ordinal === edge.ordinal)
      if (applying.length === 0) continue
      const group = edgeLayer.querySelector(`[data-edge-key="${CSS.escape(edgeKey(edge))}"]`)
      if (group === null) continue
      group.classList.add('flg-edge-stopped')
      const title = svg('title', 'flg-edge-stop-title')
      title.textContent = applying.map((stop) => stop.title).join('\n')
      group.prepend(title)
    }
  }

  function focusNode(nodeId: string): void {
    const rect = rects.get(nodeId)
    if (!rect) return
    const box = root.getBoundingClientRect()
    const width = box.width || host.clientWidth
    const height = box.height || host.clientHeight
    const c = centerOf(rect)
    camera = { ...camera, x: c.x - width / (2 * camera.zoom), y: c.y - height / (2 * camera.zoom) }
    scheduleCamera()
  }

  applyCamera()

  return {
    element: root,
    render,
    setSelection(next: GraphSelection): void {
      // No emit -- see GraphView.setSelection's own doc comment.
      selection = resolveSelection(next)
      paintSelection()
    },
    getSelection: () => selection,
    onSelect(listener) {
      selectListeners.add(listener)
      return () => selectListeners.delete(listener)
    },
    onActivate(listener) {
      activateListeners.add(listener)
      return () => activateListeners.delete(listener)
    },
    onNodeMove(listener) {
      moveListeners.add(listener)
      return () => moveListeners.delete(listener)
    },
    onConnect(listener) {
      connectListeners.add(listener)
      return () => connectListeners.delete(listener)
    },
    onGroupToggle(listener) {
      groupToggleListeners.add(listener)
      return () => groupToggleListeners.delete(listener)
    },
    beginConnection(nodeId: string): void {
      if (!nodeElements.has(nodeId)) return
      armConnection(nodeId)
    },
    cancelConnection(): void {
      endLink()
    },
    getCamera: () => ({ ...camera }),
    setCamera(next) {
      camera = {
        x: Number.isFinite(next.x) ? (next.x as number) : camera.x,
        y: Number.isFinite(next.y) ? (next.y as number) : camera.y,
        zoom: next.zoom === undefined ? camera.zoom : clampZoom(next.zoom),
      }
      scheduleCamera()
    },
    zoomToFit,
    focusNode,
    setNodeStats(next: ReadonlyMap<string, NodeCardStats> | null): void {
      nodeStats = next
      // In place, over the cards that are already drawn -- see the interface's own doc comment
      // for why this is not a re-render.
      for (const [nodeId, box] of nodeElements) applyNodeStatsTo(box, nodeId)
      applyEdgeStops()
    },
    dispose(): void {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      if (dragFrame !== 0) cancelAnimationFrame(dragFrame)
      dragFrame = 0
      // A gesture in flight when the view goes away reports nothing: the listeners are about to
      // be dropped, and a host that is tearing the panel down has not asked to be told where a
      // node ended up.
      drag = null
      if (linkFrame !== 0) cancelAnimationFrame(linkFrame)
      linkFrame = 0
      link = null
      if (linkTipTimer !== 0) window.clearTimeout(linkTipTimer)
      linkTipTimer = 0
      litLinkBoxes.length = 0
      connectListeners.clear()
      if (nudgeTimer !== 0) window.clearTimeout(nudgeTimer)
      nudgeTimer = 0
      nudgeOrigins.clear()
      root.removeEventListener('keydown', onLinkKeyCapture, true)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerUp)
      root.removeEventListener('pointercancel', onPointerUp)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('keydown', onKeyDown)
      selectListeners.clear()
      activateListeners.clear()
      moveListeners.clear()
      groupToggleListeners.clear()
      marquee = null
      selectable.clear()
      edgeGroupsByNode.clear()
      nodeElements.clear()
      frameElements.clear()
      groupCards.clear()
      edgeVisuals.length = 0
      selfLoopOverhang.clear()
      nodeBoxes.length = 0
      litElements.length = 0
      root.remove()
    },
  }
}
