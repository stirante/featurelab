// webview/graph.ts -- the node editor's webview half.
//
// It owns the canvas, the inspector and the camera, and it owns NOTHING on disk. Every change
// leaves here as a request and comes back as a fresh graph, so the file on disk stays the
// single source of truth and this side can never believe in a node the pack does not have.
//
// The modules it wires together were each written and tested on their own:
//   graph/render.ts        the canvas, selection, panning, zooming
//   graph/layout.ts        where the boxes go
//   graph/typeCatalog.ts   what each feature type's schema accepts at a format_version
//   graph/forms.ts         the inspector's controls, built from that catalogue
//   graph/compounds/*      the four compound nodes the palette can place
//
// This file is the only place they meet, and it deliberately contains no rules of its own about
// features: anything it needed to know it asks one of those modules.

import {
  createGraphView,
  GRAPH_NODE_WIDTH,
  GRAPH_NODE_HEIGHT,
  type GraphFrameWire,
  type GraphWire,
  type GraphPoint,
  type GraphSelection,
} from '../src/graph/render.js'
import {
  collapseGroups,
  expandedFrames,
  groupCardPositions,
  groupIdOfNode,
  groupNodeId,
  planAdd,
  planCreate,
  planRemove,
  planRename,
  planSetCollapsed,
  planUngroup,
  readGroups,
  type GroupGraph,
  type GroupPlan,
  type GroupsView,
} from '../src/graph/groups.js'
import { autoLayout, positionsFromAnnotations, type LayoutGraph } from '../src/graph/layout.js'
import { buildNodeForm, type NodeForm } from '../src/graph/forms.js'
import {
  createNodeInspector,
  INSPECTOR_STYLESHEET,
  type InspectorChange,
  type InspectorEdgeField,
  type NodeInspector,
} from '../src/graph/inspector.js'
import { typeSpec } from '../src/graph/typeCatalog.js'
import {
  buildNodeStats,
  describeNodeRun,
  describeStop,
  explainNodeRun,
  nodeRunStats,
  summarizeRun,
  type NodeStatsOptions,
  type RunTotals,
} from '../src/graph/nodeStats.js'
import type { ProfileWire } from '../src/graph/attribution.js'
import type { NodeCardStats } from '../src/graph/render.js'
import { lookupFieldDoc, lookupValueDoc, renderFieldDoc, renderValueDoc } from '../src/graph/docs/catalog.js'
import { COMPOUND_KINDS, COMPOUND_KIND_NOTES, type CompoundKind } from '../src/graph/compounds/spec.js'
import { formatJsonPath, featureFileContents } from '../src/graph/idioms.js'
import { deleteFeature, renameFeature, type LifecyclePlan } from '../src/graph/lifecycle.js'
import { planConnection, type ConnectGraph } from '../src/graph/connect.js'
import {
  SEARCH_STYLESHEET,
  buildSearchIndex,
  createSearchBox,
  type GraphFilter,
  type SearchBox,
} from '../src/graph/search.js'
import { MolangEdgeEditor, type MolangEdgeField } from '../src/graph/molangEdge.js'
import { MOLANG_FIELD_STYLESHEET, createMolangField, type MolangField } from '../src/graph/molangField.js'
import { createSplitter } from 'featurelab-frontend'
import { describeMissing, viewWithoutPlaceholders, withPlaceholderDelegations, withScatterIterations, type MissingSlot } from '../src/graph/incomplete.js'
import type { GraphEdgeWire } from '../src/graph/render.js'
import type { IdiomGraph } from '../src/graph/idioms.js'
import {
  featureFilePath,
  nodeBodyKey,
  ruleFileContents,
  ruleFilePath,
  type CompoundSpec,
} from '../src/graph/compounds/spec.js'
import { hasCompoundAnnotation, withCompoundAnnotation } from '../src/graph/compounds/annotate.js'
import {
  COMPOUND_FORM_STYLESHEET,
  createCompoundForm,
  type CompoundForm,
  type CompoundParamsChange,
} from '../src/graph/compounds/form.js'
import {
  buildCompoundView,
  ejectWarning,
  type CompoundRegistry,
  type CompoundView,
} from '../src/graph/compounds/collapse.js'
import { loopCompound } from '../src/graph/compounds/loop.js'
import { stepsCompound } from '../src/graph/compounds/steps.js'
import { placementGuardSpec } from '../src/graph/compounds/placementGuard.js'
import { columnCompound } from '../src/graph/compounds/column.js'
import type { CoverageRow } from '../src/graph/typeCatalog.js'
import {
  buildPaletteModel,
  installPaletteStyles,
  createPaletteMenu,
  paletteCamera,
  type NodeCreationRequest,
  type PaletteMenu,
} from '../src/graph/palette.js'

interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

const canvasHost = document.getElementById('flg-canvas')
const sideHost = document.getElementById('flg-side')
const toolbarHost = document.getElementById('flg-toolbar')
const statusHost = document.getElementById('flg-status')

if (!canvasHost || !sideHost || !toolbarHost || !statusHost) {
  throw new Error('graph shell is missing an element')
}

const view = createGraphView(canvasHost, { ariaLabel: 'Feature graph' })
// Exposed for the screenshot capture, which needs to photograph the graph at a readable zoom
// as well as at fit. Read-only use by a tool; nothing in the panel reads it back.
;(window as unknown as Record<string, unknown>).__flgView = view

let graph: GraphWire | null = null
/** The graph exactly as the host sent it, before compounds were collapsed. Kept so expanding
 * one is a redraw rather than a request. */
let lastGraph: GraphWire | null = null
let positions: Map<string, GraphPoint> = new Map()

/** The graph groups are read from and written against: compounds collapsed, groups NOT yet
 * folded. A member of a collapsed group is not in `graph` (its card stands for it) but is in
 * here, which is what lets the panel list it, the search find it, and a plan name its file. */
let groupSource: GraphWire | null = null
/** Every group the pack's files declare, as of the last graph. */
let groupsView: GroupsView = readGroups({ nodes: [], edges: [], roots: [] })
/** The frames the renderer draws for the expanded ones. */
let frames: readonly GraphFrameWire[] = []

/** Rebuilds the drawn graph from the host's, in the order that makes each step's input honest:
 * compounds fold first (a compound's hidden children are not there to be grouped), groups fold
 * over that (a group of compounds is one card), and the placeholder ghost goes last (an edge
 * re-pointed from a hidden member to the placeholder is still an edge into the placeholder). */
function rebuildView(): void {
  if (!lastGraph) return
  const compounds = collapseCompounds(lastGraph)
  groupSource = compounds
  groupsView = readGroups(compounds as unknown as GroupGraph)
  graph = withoutPlaceholderGhosts(collapseGroups(compounds, groupsView))
  frames = expandedFrames(groupsView, graph)
}

/** Puts each collapsed group's card where its members were. The host knows nothing about group
 * cards -- they are not files -- so their positions are derived here, after the host's arrive. */
function placeGroupCards(): void {
  for (const [id, at] of groupCardPositions(groupsView, positions)) positions.set(id, at)
}

/** What the engine said about files it could not fully read, as of the last graph.
 *
 * Kept beside the graph rather than inside it because a refused file has no node to hang it on
 * -- that is the entire reason the channel exists. */
interface GraphDiagnosticWire {
  level: string
  fileId: string
  message: string
}
let diagnostics: readonly GraphDiagnosticWire[] = []

// ---------------------------------------------------------------------------
// What one run measured
// ---------------------------------------------------------------------------

/** The last profile the live preview sent, with the context that makes its numbers mean
 * something. Null whenever there is no profiled run to describe -- no preview open, a preview
 * that is not profiling, a regenerate that came back without one -- and that is the ordinary
 * state: nothing here draws anything until a run has actually measured something.
 *
 * A preview asks the engine for a profile only when the GRAPH asked it to (the "Preview on
 * select" toggle), so this arriving at all is already an explicit request by the author. Nothing
 * on this side widens that. */
interface RunStatsWire {
  profile: ProfileWire | null
  previewed: string
  origin: { x: number; y: number; z: number } | null
  writeBudget: number | null
  partial: boolean
}
let runWire: RunStatsWire | null = null
/** Run-wide denominators, computed once per run rather than per node. */
let runTotals: RunTotals | null = null

/** What nodeStats.ts needs to answer honestly about a node.
 *
 * Rebuilt per call rather than cached with the run, because `typeIdOf` has to read the CURRENT
 * graph: it is the only thing that lets a feature RULE be reported as unmeasured instead of as
 * not having run, and a graph reloaded by a save must not leave that lookup pointing at the old
 * one. No index is supplied, so `distinctCells` is null -- the per-cell table stays on the host,
 * where the preview already indexes it, rather than crossing the wire a second time. */
function runOptions(): NodeStatsOptions {
  return {
    writeBudget: runWire?.writeBudget ?? null,
    partial: runWire?.partial ?? false,
    origin: runWire?.origin ?? null,
    typeIdOf: (nodeId: string) => graph?.nodes.find((n) => n.id === nodeId)?.typeId,
  }
}

/** Takes a run's profile and puts it on the cards.
 *
 * ONLY the nodes the profile has a row for get one. A preview runs one feature; every other node
 * in the pack was not entered, and stamping fifty-six cards with a nought would teach a reader to
 * stop looking at the row on the one card where it matters -- which is nodeStats.ts's own
 * argument about its empty cases, applied to where they are drawn rather than to how they are
 * worded. "Not entered in this run" is still available, in full, on the card a person selects.
 *
 * `null` takes every row back off. Sent when a preview closes or comes back unprofiled, because
 * these numbers describe a run and a run that is gone describes nothing. */
function applyRunStats(next: RunStatsWire | null): void {
  runWire = next?.profile ? next : null
  if (!runWire?.profile) {
    runTotals = null
    view.setNodeStats(null)
    renderInspector(view.getSelection())
    return
  }
  const options = runOptions()
  const totals = summarizeRun(runWire.profile, options)
  runTotals = totals
  const cards = new Map<string, NodeCardStats>()
  for (const [nodeId, row] of buildNodeStats(runWire.profile, options)) {
    cards.set(nodeId, {
      // Three counters, forwarded as three. The renderer has no field to collapse them into.
      entered: row.entered,
      blocksWritten: row.blocksWritten,
      delegations: row.delegations,
      // The sentence comes from nodeStats.ts, not from here: the phrasing of what a run did and
      // did not do is that module's, and a second set of words invented on this side is how two
      // descriptions of one state drift apart.
      summary: describeNodeRun(row, totals, options),
      stops: row.stops.map((stop) => ({ ...describeStop(stop), ...(stop.ordinal === undefined ? {} : { ordinal: stop.ordinal }) })),
    })
  }
  view.setNodeStats(cards)
  // The selected node's own panel is showing the previous run's numbers (or none); redraw it.
  renderInspector(view.getSelection())
}

/** The selected node's own account of the run, in nodeStats.ts's words.
 *
 * Null when no run has been measured -- the panel is then exactly the panel it was. Unlike the
 * card, this is built for ANY node, including one the profile has no row for: somebody who
 * selected a node and wants to know what it did is owed "not entered in this run, at origin
 * x,y,z" rather than silence, and owed the rule case ("feature rules are not measured") rather
 * than a falsehood about it not having run. */
function runPanel(nodeId: string): HTMLElement | null {
  const wire = runWire
  const totals = runTotals
  if (!wire?.profile || totals === null) return null
  const options = runOptions()
  const row = nodeRunStats(wire.profile, nodeId, options, totals)

  const block = document.createElement('div')
  block.className = 'flg-run'

  // The heading names the run before any number is read. These are a measurement of one
  // placement at one origin, not a property of the feature, and a panel that opened with the
  // numbers and left that to be inferred would be inviting the inference.
  const head = document.createElement('div')
  head.className = 'flg-run-head'
  const at = wire.origin ? ` at origin ${String(wire.origin.x)},${String(wire.origin.y)},${String(wire.origin.z)}` : ''
  head.textContent = wire.previewed ? `This run \u2014 ${wire.previewed}${at}` : `This run${at}`
  head.title = 'What the live preview measured on its last run. Numbers here describe that one run at that one origin, not the pack.'
  block.append(head)

  for (const line of explainNodeRun(row, totals, options)) {
    const el = document.createElement('div')
    el.className = 'flg-run-line'
    el.textContent = line
    block.append(el)
  }
  return block
}

/**
 * Lays the graph out.
 *
 * Annotated positions win over the automatic layout, because a position someone placed by hand
 * is a decision and the layout is only a guess. `positionsFromAnnotations` returns whatever the
 * file recorded and `autoLayout` fills the rest, so a partly-arranged pack keeps its
 * arrangement instead of being reflowed the moment one node is added.
 */
function layout(g: GraphWire): Map<string, GraphPoint> {
  const layoutGraph = g as unknown as LayoutGraph
  // The renderer's own box size is passed in rather than left to the layout's default. The two
  // modules had disagreed silently -- layout reserving 220x72 while render drew 232x86 -- which
  // does not overlap anything but eats most of the gap between rows, and reads as a canvas that
  // is simply too tight.
  const auto = autoLayout(layoutGraph, { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT })
  const pinned = positionsFromAnnotations(layoutGraph)
  const merged = new Map<string, GraphPoint>()
  for (const [id, p] of Object.entries(auto)) merged.set(id, { x: p.x, y: p.y })
  for (const [id, p] of Object.entries(pinned)) merged.set(id, { x: p.x, y: p.y })
  return merged
}

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  statusHost!.textContent = text
  statusHost!.className = kind === 'error' ? 'flg-status flg-status-error' : 'flg-status'
}

/** Draws the graph and frames it, but only frames it the FIRST time: a refresh after an edit
 * must not throw away the camera someone positioned, which is the difference between a live
 * editor and a page that reloads. */
let framed = false
function draw(): void {
  if (!graph) return
  view.render(graph, positions, frames)
  if (!framed) {
    openOnSomethingReadable()
    framed = true
  }
}

/** Where the camera starts.
 *
 * NOT zoomToFit. On this repo's own fixture pack that lands around 0.15, which is inside the
 * renderer's "far" band: text is dropped by design, because a 12px label at that scale is a
 * smudge. So the first thing anybody saw was fifty-seven coloured rectangles and no way to tell
 * one from another -- a view that fits everything and says nothing.
 *
 * And not the busiest node either, which was the first attempt. Centring the hub of a pack shaped
 * like this one -- dozens of parents sharing a handful of children -- drops you into the middle of
 * a convergence with eleven edges arriving from off screen and half-cut cards at both margins. You
 * can read where you are and still have no idea what you are looking at.
 *
 * It opens on ONE CONNECTED COMPONENT, fitted, at a zoom that keeps text legible. A component is a
 * self-contained drawing: a rule and everything it reaches, with no edge crossing its boundary, so
 * nothing is arriving from somewhere you cannot see. The biggest one is chosen because it is the
 * one with structure worth reading, and the camera lands at its left edge -- where the roots are,
 * which is the direction the whole layout is built to be read in.
 *
 * A graph that fits whole AND stays readable is fitted whole, because then there is no trade.
 */
function openOnSomethingReadable(): void {
  if (!graph || graph.nodes.length === 0) return

  view.zoomToFit()
  if (view.getCamera().zoom >= READABLE_ZOOM) return

  const component = largestComponent()
  if (component.size === 0) return

  // The component's own box, from the positions already laid out.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of component) {
    const at = positions.get(id)
    if (!at) continue
    minX = Math.min(minX, at.x)
    minY = Math.min(minY, at.y)
    maxX = Math.max(maxX, at.x + GRAPH_NODE_WIDTH)
    maxY = Math.max(maxY, at.y + GRAPH_NODE_HEIGHT)
  }
  if (!Number.isFinite(minX)) return

  const box = canvasHost!.getBoundingClientRect()
  const margin = 48
  const fit = Math.min((box.width - margin) / (maxX - minX), (box.height - margin) / (maxY - minY))
  const zoom = Math.max(READABLE_ZOOM, Math.min(fit, 1))

  // Anchored on the component's top-left rather than its centre. A drawing read left to right
  // starts at the left; centring a component taller than the viewport would cut off the roots,
  // which are the entry points and the only place a reader can start.
  view.setCamera({ zoom, x: minX - margin / 2 / zoom, y: minY - margin / 2 / zoom })
}

/** How many separate drawings this graph is. A pack whose features are mostly unreferenced is
 * dozens of them, and saying so is what stops the opening view looking like the whole pack. */
/** What the status line says about how much of the graph is on screen. */
function describeExtent(): string {
  const groups = countComponents()
  return groups > 1
    ? `Showing one of ${groups} separate groups. Fit shows them all.`
    : 'Showing the whole graph.'
}

function countComponents(): number {
  if (!graph) return 0
  const seen = new Set<string>()
  const neighbours = new Map<string, string[]>()
  for (const edge of graph.edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to])
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from])
  }
  let count = 0
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue
    count++
    const queue = [node.id]
    while (queue.length > 0) {
      const id = queue.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const next of neighbours.get(id) ?? []) if (!seen.has(next)) queue.push(next)
    }
  }
  return count
}

/** The largest set of nodes reachable from one another, ignoring edge direction.
 *
 * Undirected on purpose: two rules sharing one child are one drawing to a reader, whatever way the
 * arrows point. Ties break on the lowest id so two runs open identically -- a view that started
 * somewhere different each time would be its own kind of disorienting.
 */
function largestComponent(): Set<string> {
  if (!graph) return new Set()
  const neighbours = new Map<string, string[]>()
  const link = (a: string, b: string): void => {
    const list = neighbours.get(a)
    if (list) list.push(b)
    else neighbours.set(a, [b])
  }
  for (const edge of graph.edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }

  const seen = new Set<string>()
  let best = new Set<string>()
  for (const node of [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (seen.has(node.id)) continue
    const here = new Set<string>()
    const queue = [node.id]
    while (queue.length > 0) {
      const id = queue.pop() as string
      if (here.has(id)) continue
      here.add(id)
      seen.add(id)
      for (const next of neighbours.get(id) ?? []) if (!here.has(next)) queue.push(next)
    }
    if (here.size > best.size) best = here
  }
  return best
}

/** The zoom at or above which a card still shows its text -- the renderer's own near band. */
const READABLE_ZOOM = 0.9

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

/** Re-renders the inspector for a node id, using the live edited fields when there are any.
 * Separate from renderInspector so a commit can refresh the panel without a selection event --
 * the selection did not change, only the values did. */
function renderInspectorFor(nodeId: string): void {
  if (!graph) return
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (node) renderInspector({ kind: 'node', nodeId, node })
}

/** What the panel shows when nothing is selected.
 *
 * It used to be one sentence -- "Select a node to see what it accepts." -- in a column a third of
 * the panel wide, which is a lot of screen to spend saying nothing. Worse, the state it described
 * is the state the editor OPENS in, so that sentence was the first and sometimes only thing
 * anybody read.
 *
 * What goes here instead is the two questions somebody actually has on opening a pack they did not
 * write: what is in it, and what is wrong with it. Both answers are things to click.
 */
/** What the engine said about a file, as a row you can act on.
 *
 * The file name leads, because the author's first question about a refused file is which one --
 * and for a file that produced no node it is the only handle there is. Clicking opens it: a
 * message about a file you cannot reach from the message is most of the way to no message. */
function diagnosticRow(d: GraphDiagnosticWire): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  // The level is in the class and in the role, not only in the colour. A row that reads as a
  // problem to someone looking at it has to read as one to a screen reader and to a test too --
  // and the two levels mean genuinely different things here: an error is a file that did not
  // load at all, a warning is one that loaded with something in it ignored.
  const severe = d.level === 'error'
  row.className = `flg-diagnostic-row ${severe ? 'flg-diagnostic-error' : 'flg-diagnostic-warning'}`
  row.setAttribute('role', severe ? 'alert' : 'status')
  const name = document.createElement('span')
  name.className = 'flg-diagnostic-file'
  name.textContent = d.fileId
  const text = document.createElement('span')
  text.className = 'flg-diagnostic-message'
  text.textContent = d.message
  row.append(name, text)
  row.addEventListener('click', () => {
    // By path, not by node id: the file this is about may well have produced no node, which is
    // the case that needs the link most.
    vscode.postMessage({ type: 'openFile', file: d.fileId })
  })
  return row
}

function overviewPanel(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-overview'
  if (!graph) {
    wrap.append(hint('Loading the pack...'))
    return wrap
  }

  // A reference the GAME provides is not a problem, and counting it as one was wrong on every
  // real pack: a pack with no broken references at all would open the overview by reporting
  // every game-provided reference as a fault.
  const external = graph.nodes.filter((n) => n.unresolved && (n as { external?: boolean }).external)
  const unresolved = graph.nodes.filter((n) => n.unresolved && !(n as { external?: boolean }).external)
  const rules = graph.nodes.filter((n) => n.typeId === 'minecraft:feature_rule').length
  // Features EXCLUDING the rules and the dangling references. The first version counted every
  // node and then named the rules again on the next line, so the headline number double-counted
  // them -- in the first sentence anybody reads. A collapsed group's card is not a feature
  // either; its members are counted in the source graph below.
  const cards = graph.nodes.filter((n) => n.group).length
  const folded = groupsView.groups.filter((g) => g.collapsed).reduce((n, g) => n + g.memberIds.length, 0)
  const features = graph.nodes.length - rules - unresolved.length - external.length - cards + folded
  const cycles = graph.cycles?.length ?? 0

  wrap.append(heading(`${features} feature${features === 1 ? '' : 's'}`))
  wrap.append(
    hint(
      `${rules} rule${rules === 1 ? '' : 's'} decide where they are placed. ` +
        `${graph.edges.length} connection${graph.edges.length === 1 ? '' : 's'}.`,
    ),
  )

  // Refused files come FIRST, ahead of every other problem, because they are the only kind the
  // graph cannot show any other way. A dangling reference still draws a node; a file the engine
  // refused produces no node, no edge and no root, so before this the whole of it -- and any
  // mistake in it -- was simply absent. An author who hand-wrote a file and could not find it
  // had nothing at all to read.
  const refused = diagnostics.filter((d) => d.level === 'error')
  const flagged = diagnostics.filter((d) => d.level !== 'error')
  if (refused.length > 0) {
    wrap.append(
      notice(
        `${refused.length} file${refused.length === 1 ? '' : 's'} the engine refused to load. ` +
          'Nothing in them is in this graph, and nothing in them will generate.',
        'error',
      ),
    )
    for (const d of refused.slice(0, 8)) wrap.append(diagnosticRow(d))
  }
  if (flagged.length > 0) {
    wrap.append(
      notice(
        `${flagged.length} file${flagged.length === 1 ? ' has' : 's have'} something the engine reads ` +
          'past. They load, but not everything written in them takes effect.',
        'warning',
      ),
    )
    for (const d of flagged.slice(0, 8)) wrap.append(diagnosticRow(d))
  }

  // Problems first and stated as what they MEAN, not as a count of a word nobody has met yet.
  // These are the reason somebody opens a graph of a pack that is misbehaving.
  if (unresolved.length > 0) {
    wrap.append(
      notice(
        `${unresolved.length} reference${unresolved.length === 1 ? ' points' : 's point'} at a feature ` +
          'this pack does not define. Nothing will be placed where they are used.',
        'warning',
      ),
    )
    for (const node of unresolved.slice(0, 8)) wrap.append(jumpTo(node.id, 'flg-jump-unresolved'))
  }
  if (external.length > 0) {
    // Stated as information, and stated as what it means for the PREVIEW rather than for the
    // pack -- the pack is correct and these resolve in game.
    wrap.append(
      notice(
        `${external.length} reference${external.length === 1 ? ' points' : 's point'} at a feature ` +
          'the game provides rather than this pack. They work in game; the preview cannot show them, ' +
          'because this tool does not simulate the features the game itself provides.',
        'info',
      ),
    )
  }
  if (cycles > 0) {
    wrap.append(
      notice(
        `${cycles} loop${cycles === 1 ? '' : 's'} where a feature eventually delegates back to itself. ` +
          'The engine stops these at run time, but they are rarely deliberate.',
        'warning',
      ),
    )
  }

  // Roots are the entry points -- the features nothing else delegates to -- so they are where
  // reading a pack starts, and they are the one list worth offering before anything is selected.
  if (graph.roots.length > 0) {
    wrap.append(sectionLabel('Starts here'))
    for (const id of graph.roots.slice(0, 12)) wrap.append(jumpTo(id))
    if (graph.roots.length > 12) wrap.append(hint(`and ${graph.roots.length - 12} more`))
  }

  // The author's own brackets around the pack, each one a click away. Listed after the roots
  // because a group is a way of reading the pack, and the roots are where reading starts.
  if (groupsView.groups.length > 0) {
    wrap.append(sectionLabel('Groups'))
    for (const group of groupsView.groups.slice(0, 12)) wrap.append(groupJump(group.id))
    if (groupsView.groups.length > 12) wrap.append(hint(`and ${groupsView.groups.length - 12} more`))
  }
  for (const warning of groupsView.warnings) wrap.append(notice(warning, 'warning'))

  wrap.append(hint('Right-click the canvas to add a feature. Drag a card to move it. Ctrl+click or Shift+drag selects several; Ctrl+G groups them.'))
  return wrap
}

/** A group you can click to select it. Named, with the count, because that is how it is told
 * from a feature in the same list. */
function groupJump(groupId: string): HTMLElement {
  const group = groupsView.byId.get(groupId)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'flg-jump flg-jump-group'
  button.textContent = group ? `${group.name} (${String(group.memberIds.length)})` : groupId
  button.title = group ? `${group.collapsed ? 'Collapsed' : 'Expanded'} group of ${String(group.memberIds.length)}: ${group.memberIds.join(', ')}` : ''
  button.addEventListener('click', () => revealGroup(groupId))
  return button
}

/** A node id you can click to go to it. */
/** A section label. Deliberately not `subheading`, which is styled as a type identifier -- it is
 * monospaced and coloured like code, so using it for prose made "Starts here" read as the name of
 * something. */
function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'flg-section'
  el.textContent = text
  return el
}

function jumpTo(id: string, extraClass?: string): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = extraClass ? `flg-jump ${extraClass}` : 'flg-jump'
  button.textContent = id
  button.addEventListener('click', () => {
    revealNode(id)
  })
  return button
}

/** Selects and centres a node by id, wherever it is drawn.
 *
 * A node hidden inside a collapsed group has no card of its own; what stands for it is the
 * group's card, so THAT is selected and centred, and the status line says which group holds it.
 * The alternative -- selecting nothing, or an id with no box -- would blank the inspector while
 * appearing to have done something, which is how search results come to be distrusted. */
function revealNode(id: string): boolean {
  if (!graph) return false
  const node = graph.nodes.find((n) => n.id === id)
  if (node) {
    view.setSelection(node.group ? { kind: 'group', groupId: node.group.id } : { kind: 'node', nodeId: id, node })
    view.focusNode(id)
    renderInspector(view.getSelection())
    return true
  }
  const groupId = groupsView.memberOf.get(id)
  const group = groupId === undefined ? undefined : groupsView.byId.get(groupId)
  if (group === undefined || !group.collapsed) return false
  view.setSelection({ kind: 'group', groupId: group.id })
  view.focusNode(groupNodeId(group.id))
  renderInspector(view.getSelection())
  setStatus(`${id} is inside the collapsed group "${group.name}". Expand it to see the node.`)
  return true
}

/** Selects a group and centres on it: its card when collapsed, its first member otherwise. */
function revealGroup(groupId: string): void {
  const group = groupsView.byId.get(groupId)
  if (!group) return
  view.setSelection({ kind: 'group', groupId })
  view.focusNode(group.collapsed ? groupNodeId(groupId) : (group.memberIds[0] ?? ''))
  renderInspector(view.getSelection())
}

/** The live Molang editor, and which edge it is showing.
 *
 * Kept between renders for the same reason the inspector is: rebuilding on every repaint would
 * throw away the caret and the uncommitted draft, and a text field that loses your cursor is
 * one people stop typing into. */
let edgeEditor: MolangEdgeEditor | null = null
let edgeEditorKey: string | null = null
/** The control drawn for that editor, and this panel's subscription to it.
 *
 * BOTH ARE DISPOSED ON EVERY RENDER, including a render of the same edge. The editor outlives the
 * panel (it holds the draft and the caret, which is why it is cached at all), so a fresh
 * `onChange` per render would stack listeners on one editor: select the same edge twice and every
 * commit posts twice, every tick of the format box writes the directive twice. One listener, held
 * here, replaced rather than added to. */
let edgeField: MolangField | null = null
let edgeEditorOff: (() => void) | null = null

/** Which Molang slot an edge kind carries, and where it lives.
 *
 * Returns null for the kinds that carry none -- aggregate, sequence, weighted and the wrapping
 * types delegate unconditionally, and inventing a control for a slot the schema has no key for
 * would teach the author a field exists that the engine would refuse. */
function molangSlotOf(
  edge: GraphEdgeWire,
): { field: MolangEdgeField; value: string | null; path: string } | null {
  if (edge.kind === 'scatter') {
    // `iterations` is required on a scatter, so an absent one is a broken file rather than a
    // slot to leave alone -- offering the control is how the author fixes it.
    if (edge.iterationsPath === undefined) return null
    return { field: 'iterations', value: edge.iterations ?? null, path: edge.iterationsPath }
  }
  if (edge.kind === 'conditional') {
    if (edge.conditionPath === undefined) return null
    return { field: 'condition', value: edge.condition ?? null, path: edge.conditionPath }
  }
  return null
}

/** The Molang editor for one edge's slot, from the one-slot cache.
 *
 * Shared by the edge panel and by a node's own panel, which draws the same editor for a scatter's
 * `iterations` inside its distribution section. One editor, so one draft: a value typed in either
 * place is the value the other shows, and there is never a second copy of the count to disagree
 * with the first. The sidebar shows one panel at a time, which is what makes one slot enough. */
function edgeEditorFor(edge: GraphEdgeWire, slot: { field: MolangEdgeField; value: string | null; path: string }): MolangEdgeEditor {
  const key = `${edge.from} ${edge.jsonPath} ${slot.field}`
  if (edgeEditor === null || edgeEditorKey !== key) {
    edgeEditor?.dispose()
    edgeEditor = new MolangEdgeEditor(
      {
        edge: {
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          jsonPath: edge.jsonPath,
          required: edge.required,
        },
        field: slot.field,
        value: slot.value,
        // Where the EXPRESSION lives, which is a different member of a different object from the
        // delegation this edge is drawn for -- see MolangEdgeInput.fieldPath. It is the path a
        // directive about this expression attaches to, and the same one the value edit below
        // writes through.
        fieldPath: slot.path,
        // The directives the engine parsed out of this file's comments. They were being decoded
        // off the wire and dropped right here: an author's `@featurelab:ignore inactive-branch`
        // and their `@featurelab:idiom` reached the webview and then reached nothing, because
        // this was the only place that could have handed them to the editor and it did not.
        annotations: (graph?.nodes.find((n) => n.id === edge.from)?.annotations ?? []).map((a) => ({
          name: a.name,
          ...(a.args === undefined ? {} : { args: a.args }),
          ...(a.text === undefined ? {} : { text: a.text }),
          jsonPath: a.jsonPath,
          line: a.line,
        })),
        // The webview tracks no preview origin of its own yet. That is why no validator is
        // supplied below either: without an origin an evaluation would be a claim about a
        // position nobody chose, and this module's whole contract is that a zero is never
        // called dead. The offline half -- arity, unreachable names, the idiom analysis -- needs
        // neither and is what is wired here.
        origin: { x: 0, y: 0, z: 0 },
      },
      { validator: { validate: async () => ({}) }, schedule: (run) => (run(), () => {}) },
    )
    edgeEditorKey = key
  }
  return edgeEditor!
}

/** Points the cached editor's ONE subscription at this edge's file.
 *
 * Replaced, never added to -- see edgeEditorOff. Both the node panel and the edge panel call this,
 * and a listener stacked per render is how a single commit came to be written twice. */
function listenToEdgeEditor(editor: MolangEdgeEditor, edge: GraphEdgeWire, slot: { field: MolangEdgeField; path: string }): void {
  edgeEditorOff?.()
  edgeEditorOff = editor.onChange((change) => {
    const file = graph?.nodes.find((n) => n.id === edge.from)?.file
    if (file === undefined || file === '') {
      setStatus('That edge has no file behind it to write to.', 'error')
      return
    }
    if (change.kind === 'value') {
      vscode.postMessage({
        type: 'applyEdits',
        file,
        edits: [{ path: slot.path, json: change.value === null ? null : JSON.stringify(change.value) }],
      })
      setStatus(`Writing ${slot.field}...`)
      return
    }
    if (change.kind === 'annotate') {
      // Into the FILE'S COMMENTS, through the host. A choice kept only in this session is a
      // choice that is gone the next time the pack is opened -- and the next person to open it
      // would find the expression re-flattened by an editor that had forgotten they asked it not
      // to. EVERY annotate change goes this way, not only the format one: the "known: gated, not
      // dead" action has emitted the same kind since this module was written and had nowhere to
      // send it.
      vscode.postMessage({
        type: 'annotate',
        file,
        path: change.jsonPath ?? edge.jsonPath,
        name: change.annotation.name,
        args: change.annotation.args,
      })
      setStatus(`Noting @featurelab:${change.annotation.name} in ${file}...`)
      return
    }
    if (change.kind === 'reveal' && change.target === 'json') {
      vscode.postMessage({ type: 'openFile', nodeId: edge.from })
    }
  })
}

/** The panel for a selected edge.
 *
 * This exists because selecting an edge used to fall through to the overview panel: the Molang
 * editor module was complete and tested and nothing in the product ever constructed it, so the
 * expression on every scatter in every pack was readable in a tooltip and editable nowhere. */
function edgePanel(selection: Extract<GraphSelection, { kind: 'edge' }>): HTMLElement {
  const host = document.createElement('div')
  host.className = 'flg-edge-panel'

  const edge = selection.edge
  const head = document.createElement('div')
  head.className = 'flg-edge-head'
  head.textContent = `${edge.from} → ${edge.to}`
  host.append(head)

  const kindLine = document.createElement('div')
  kindLine.className = 'flg-edge-kind'
  kindLine.textContent = edge.kind
  host.append(kindLine)

  const slot = molangSlotOf(edge)
  if (slot === null) {
    host.append(
      hint(
        `A ${edge.kind} delegation carries no Molang of its own -- it runs its children ` +
          'unconditionally. Select one of the nodes to edit what it places.',
      ),
    )
    return host
  }

  edgeField?.dispose()
  edgeField = null
  const editor = edgeEditorFor(edge, slot)

  const problems = document.createElement('div')
  problems.className = 'flg-edge-problems'

  const paint = (): void => {
    const view = editor.view()
    problems.replaceChildren()
    if (view.absent) problems.append(hint('No condition written -- this branch is always taken.'))
    for (const p of view.problems) {
      problems.append(notice(p.message, p.severity === 'error' ? 'error' : 'warning'))
    }
    // What a setup script writes is a TOOLTIP, not a paragraph. On a real script that list runs
    // to fifteen names and sat under the field on every selection -- the same wall of text this
    // panel was rebuilt to get rid of, reintroduced by me in the one place the rebuild did not
    // reach. It is worth having: the names are what the placed feature can read, and there is
    // nowhere else to see them. It is not worth a paragraph.
    const writes = view.writes.length === 0 ? '' : view.writes.map((w) => `variable.${w}`).join(', ')
    host.title = writes === '' ? '' : `Sets ${writes} for the placed feature.`
  }

  // The CONTROL is molangField.ts's -- the highlighted layer behind the text, the completion
  // list, the format choice, and the commit-on-blur this panel has always done. What stays here
  // is what the PANEL owns: the diagnostics beside the field, and turning the editor's change
  // events into the host messages that actually touch the file.
  const field = createMolangField(editor, {
    label: slot.field === 'iterations' ? 'iterations' : 'condition',
    onChanged: paint,
    fill: true,
  })
  edgeField = field
  host.append(field.element, problems)
  paint()

  listenToEdgeEditor(editor, edge, slot)

  return host
}

/** The "places" controls: every feature this node hands off to, each one re-pointable.
 *
 * A text box with a list of what exists, rather than a closed dropdown: a reference to a feature
 * this pack does not define yet is legal and useful -- a freshly created rule starts as one on
 * purpose -- so refusing to accept an unknown name would forbid naming the thing you are about
 * to make. */
function delegationRows(edges: readonly GraphEdgeWire[], file: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-delegations'
  wrap.append(heading(edges.length === 1 ? 'Places' : `Places (${edges.length})`))

  const listId = 'flg-known-features'
  const list = document.createElement('datalist')
  list.id = listId
  for (const n of graph?.nodes ?? []) {
    if (n.unresolved || n.typeId === 'minecraft:feature_rule') continue
    const option = document.createElement('option')
    option.value = n.id
    list.append(option)
  }
  wrap.append(list)

  for (const edge of edges) {
    const row = document.createElement('label')
    row.className = 'flg-delegation-row'
    const name = document.createElement('span')
    name.className = 'flg-delegation-label'
    // The ordinal matters on a list type -- for a sequence it is execution order, so "features
    // 2" is a different thing from "features 1" rather than a duplicate of it.
    name.textContent = edges.filter((e) => e.kind === edge.kind).length > 1 ? `${edge.kind} ${edge.ordinal}` : edge.kind
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'flg-delegation-input'
    input.value = edge.to
    input.spellcheck = false
    input.setAttribute('list', listId)
    input.addEventListener('change', () => {
      const next = input.value.trim()
      if (next === '' || next === edge.to) {
        input.value = edge.to
        return
      }
      if (file === '') {
        setStatus('This node has no file to write to.', 'error')
        input.value = edge.to
        return
      }
      vscode.postMessage({
        type: 'applyEdits',
        file,
        edits: [{ path: edge.jsonPath, json: JSON.stringify(next) }],
      })
      setStatus(`Pointing ${edge.kind} at ${next}...`)
    })
    row.append(name, input)
    wrap.append(row)
  }
  return wrap
}

/** The edge-carried fields a node's own panel should draw, for the node being shown.
 *
 * Today that is exactly one: a scatter's `iterations`. The editor comes from the same one-slot
 * cache the edge panel uses and gets the same single subscription, so a value typed here is written
 * through the same path and shown in the same draft as a value typed on the edge.
 *
 * The edge panel's own control is disposed first. Only one panel is on screen, and a control left
 * alive over an editor that is now being drawn somewhere else would keep answering its events. */
function scatterEdgeFields(nodeId: string): InspectorEdgeField[] {
  // From the graph as the ENGINE sent it, not the drawn one. A fresh scatter places the stand-in
  // feature, and withoutPlaceholderGhosts removes edges into that stand-in from what is drawn --
  // which took the scatter's only edge, and with it the one place its `iterations` is carried, so
  // the count could not be shown on exactly the node an author has just created. The edge is still
  // a real edge in the file; only its drawing is suppressed.
  const edge = lastGraph?.edges.find((e) => e.from === nodeId && e.kind === 'scatter')
  if (edge === undefined) return []
  const slot = molangSlotOf(edge)
  if (slot === null || slot.field !== 'iterations') return []
  edgeField?.dispose()
  edgeField = null
  const editor = edgeEditorFor(edge, slot)
  listenToEdgeEditor(editor, edge, slot)
  return [{ key: 'iterations', editor }]
}

function renderInspector(selection: GraphSelection): void {
  // A pending delete is a question about ONE node. Selecting anything else answers it by walking
  // away, which is an answer -- and leaving the buttons on screen under a different node's name
  // would be an invitation to delete the wrong thing.
  if (pendingDelete !== null && (selection === null || selection.kind !== 'node' || selection.nodeId !== pendingDelete.nodeId)) {
    pendingDelete = null
  }
  // The same rule for a pending ungroup: it is a question about one group.
  if (pendingUngroup !== null && (selection === null || selection.kind !== 'group' || selection.groupId !== pendingUngroup)) {
    pendingUngroup = null
  }
  sideHost!.replaceChildren()
  if (!graph || !selection) {
    sideHost!.append(overviewPanel())
    return
  }
  if (selection.kind === 'edge') {
    sideHost!.append(edgePanel(selection))
    return
  }
  if (selection.kind === 'nodes') {
    sideHost!.append(multiSelectionPanel(selection.nodeIds))
    return
  }
  if (selection.kind === 'group') {
    sideHost!.append(groupPanel(selection.groupId))
    return
  }
  const node = selection.node

  if (node.unresolved) {
    // A dangling reference is a first-class node in this contract, and saying so plainly beats
    // an empty panel that looks like a bug in the editor.
    sideHost!.append(
      notice(
        'Nothing in this pack defines this feature. Something delegates to it, so it is drawn ' +
          'as a node rather than left out -- but there is no file behind it yet.',
        'warning',
      ),
    )
    return
  }

  // The lifecycle bar goes in BEFORE the catalogue check, and that ordering is load-bearing.
  // Renaming and deleting are properties of the FILE, not of how well this editor happens to
  // describe its type -- so hanging them off the catalogue meant a type with no entry (a feature
  // rule, for one) lost rename, delete and the file header together, to a single early return
  // that looked like it was only declining to draw a form.
  sideHost!.append(lifecycleBar(selection.nodeId, node))

  // Directly under the Delete button that raised it, because that is where the author is
  // looking. Above the diagnostics and everything else: it is a question, and a question waits.
  if (pendingDelete !== null && pendingDelete.nodeId === selection.nodeId) {
    sideHost!.append(deleteConfirmPanel(pendingDelete))
  }

  // Which group this node is in, and a way to change that. One row: the panel is the narrowest
  // column on screen and a group is one fact about the node.
  sideHost!.append(groupRow(selection.nodeId))

  // What the engine said about THIS node's file, on the node. A file that loaded with something
  // in it ignored has a card to be shown on, so showing it only in the overview would put it
  // furthest from the person editing the very key it is about. The join is by pack-relative
  // path, which is the same spelling on both sides -- it was not always, and until it was this
  // matched nothing and failed silently.
  if (node.file) {
    for (const d of diagnostics.filter((entry) => entry.fileId === node.file)) {
      sideHost!.append(notice(d.message, d.level === 'error' ? 'error' : 'warning'))
    }
  }

  // What the last profiled run measured about THIS node -- before the form, because "did it even
  // run, and what did it do" is the question somebody has before they start changing fields, and
  // after the diagnostics, because a file that would not load outranks a measurement of it.
  // Absent entirely when nothing has been profiled, which is the panel exactly as it was.
  const run = runPanel(selection.nodeId)
  if (run) sideHost!.append(run)

  // What this node delegates to, as editable controls.
  //
  // These are edges, so `buildNodeForm` has never drawn them -- the graph builder cuts a
  // delegation key out of `Fields` precisely because it became an edge. The result was that the
  // one thing a feature rule is FOR, the feature it places, had no control anywhere: you could
  // drag a connection on the canvas and nothing else. The same hole existed on every type with a
  // delegation, it was just less obvious on those.
  //
  // Written through `edge.jsonPath`, which is exactly what that field is for -- it addresses the
  // reference string itself, and is the one path here that needs no assembling.
  const outgoing = graph.edges.filter((e) => e.from === selection.nodeId)
  if (outgoing.length > 0) sideHost!.append(delegationRows(outgoing, node.file ?? ''))

  // Whatever this node is still waiting for. An affordance rather than a label: the slot knows
  // the path the chosen feature is written to, so "pick one" is a button and not an instruction.
  const waiting = missingSlots.get(selection.nodeId) ?? []
  for (const slot of waiting) {
    sideHost!.append(missingSlotRow(slot, node.file ?? ''))
  }

  const spec = node.typeId ? typeSpec(node.typeId) : undefined
  if (!spec) {
    sideHost!.append(
      hint(
        `This editor has no field catalogue for ${node.typeId ?? 'this type'} yet, so its settings ` +
          'are not shown here. Opening the file edits it as JSON; renaming and deleting work as usual.',
      ),
    )
    return
  }
  const form: NodeForm = buildNodeForm({
    typeId: node.typeId!,
    formatVersion: node.formatVersion,
    fields: node.fields,
    coverage: node.coverage,
    coverageNote: node.coverageNote,
  })
  const file = node.file ?? ''
  const typeId = node.typeId!
  const compoundHeader = compoundPanel(selection.nodeId)
  if (compoundHeader) {
    sideHost!.append(compoundHeader)
    // A compound's settings are the author's own parameters, not the schema of the feature it
    // happens to expand into. Showing the scatter's `distribution` and an `iterations` string
    // holding a generated ternary chain would be showing the machinery instead of the thought,
    // which is the one thing this design exists to avoid.
    const form = compoundFormFor(selection.nodeId)
    if (form) {
      sideHost!.append(form)
      return
    }
  }
  // A scatter's `iterations` is carried on its EDGE, and drawn here too, inside the distribution
  // section -- as the same cached editor the edge panel uses, not a second copy of the count. The
  // inspector never works out the path: the engine reported it on the edge as `iterationsPath`,
  // following the shape the file actually uses. A guessed path is what once wrote Molang into the
  // middle of a string.
  const edgeFields = scatterEdgeFields(selection.nodeId)
  if (inspector && inspectorNode === selection.nodeId) {
    inspector.update(form, edgeFields)
    sideHost!.append(inspector.element)
    return
  }
  inspector?.dispose()
  inspector = createNodeInspector(form, {
    // No `nodeId`. The identifier is already in the lifecycle bar's rename box directly above,
    // and that is the copy that can do something with it; a heading repeating it a line later was
    // the same string twice in the narrowest column on screen.
    file,
    // The documentation panel fills the canvas rather than floating over it. Without a host it
    // positions itself `fixed` from the measured host box, which works and is one resize away
    // from not working.
    docsHost: canvasHost ?? undefined,
    edgeFields,
    onChange: (change) => onInspectorChange(file, typeId, change),
  })
  inspectorNode = selection.nodeId
  sideHost!.append(inspector.element)
}

/** The live inspector, and which node it is showing.
 *
 * One instance, updated in place rather than rebuilt per selection: rebuilding would throw away
 * focus mid-typing and collapse every disclosure the author had opened. */
/** Adds a stylesheet the same way palette.ts does, and for the same reason: a <style> created
 * at runtime carries no nonce, and this page is served under a policy whose style-src IS a
 * nonce, so an element without one is refused and the panel renders as unstyled text with
 * nothing logged where anyone would look. The nonce is copied off a style the document was
 * served with -- the browser blanks the content attribute after load but the element still
 * hands the value back through the property. */
function installStylesheet(id: string, css: string): void {
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  const served = document.querySelector('style[nonce]') as HTMLStyleElement | null
  if (served?.nonce) style.nonce = served.nonce
  style.textContent = css
  document.head.append(style)
}

let inspector: NodeInspector | null = null
let inspectorNode: string | null = null
/** The compound parameter form, when the selected node is a compound. */
let compoundForm: CompoundForm | null = null
let compoundFormNode: string | null = null

/** Sends one field edit to the host, which owns writing.
 *
 * The path is prefixed with the node's own type key, because a JSONPath here is rooted at the
 * FILE while the fields live under that key. Getting this wrong is not cosmetic: a body-rooted
 * path does not address the wrong thing, it addresses nothing, and the write fails with
 * "$.<key> does not exist".
 *
 * A change can carry more than one edit -- swapping an exclusive variant removes one key and
 * adds another -- and they go in ONE message so the engine applies them as one batch. Applied
 * separately the file would exist, briefly, with neither variant or with both. */
function onInspectorChange(file: string, typeId: string, change: InspectorChange): void {
  vscode.postMessage({
    type: 'applyEdits',
    file,
    edits: change.edits.map((edit) => ({
      path: formatJsonPath([
        // The file's ROOT key, which is not always the node's type. A feature rule's node
        // reports the singular `minecraft:feature_rule` while its file is rooted at the plural
        // `minecraft:feature_rules` -- so rooting an edit at the type made every field on every
        // rule fail with "does not exist", including the ones the form had just drawn.
        { key: nodeBodyKey(typeId) },
        ...edit.path.map((seg) => (typeof seg === 'number' ? { index: seg } : { key: seg })),
      ]),
      // `undefined` means remove the key, which is a different file from writing null.
      json: edit.value === undefined ? null : JSON.stringify(edit.value),
    })),
  })
  setStatus(change.label)
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** The compound palette. These are the nodes that make clicking competitive with writing a
 * script, so they are offered first and by name, not buried under the vanilla type list. */
function renderToolbar(): void {
  // The search box is preserved across a toolbar rebuild: it holds a query somebody typed, and
  // throwing that away because a button list was redrawn would be its own small betrayal.
  const keep = document.getElementById('flg-search')
  toolbarHost!.replaceChildren()
  if (keep) toolbarHost!.append(keep)
  // Re-prepended below, after the label, so the row reads: search, then what you can add.
  const label = document.createElement('span')
  label.className = 'flg-toolbar-label'
  label.textContent = 'Add'
  toolbarHost!.append(label)
  if (keep) toolbarHost!.prepend(keep)

  for (const kind of COMPOUND_KINDS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'flg-add'
    button.textContent = compoundTitle(kind)
    button.title = COMPOUND_KIND_NOTES[kind]
    button.addEventListener('click', (event) => {
      // The toolbar is a shortcut into the same menu, not a second way to create things: one
      // path means one set of rules about what may be created and why something is refused.
      if (!ensureMenu(packFormatVersion())) return
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      menu?.openAt({ x: rect.left, y: rect.bottom + 2 })
    })
    toolbarHost!.append(button)
  }

  // The search box lives in the toolbar rather than behind a shortcut, because it is the answer
  // to "I cannot find anything", and a feature somebody reaches for when lost should not itself
  // need to be found. Ctrl+F focuses it.
  if (graph) ensureSearch()

  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'flg-tool'
  link.textContent = 'Preview on select'
  link.title = 'Show the selected feature in the live preview. Running a feature is not free, so this is off until asked for.'
  link.addEventListener('click', () => {
    setPreviewOnSelect(!previewOnSelect)
    const selection = view.getSelection()
    if (previewOnSelect && selection && selection.kind === 'node') previewFor(selection.nodeId)
  })
  previewToggle = link
  setPreviewOnSelect(previewOnSelect)
  toolbarHost!.append(link)

  const fit = document.createElement('button')
  fit.type = 'button'
  fit.className = 'flg-tool'
  fit.textContent = 'Fit'
  fit.addEventListener('click', () => view.zoomToFit())
  toolbarHost!.append(fit)
}

function compoundTitle(kind: CompoundKind): string {
  switch (kind) {
    case 'loop': return 'Loop'
    case 'steps': return 'Steps'
    case 'placement-guard': return 'Placement guard'
    case 'column': return 'Column'
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function heading(text: string): HTMLElement {
  const el = document.createElement('h2')
  el.className = 'flg-heading'
  el.textContent = text
  return el
}
function subheading(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'flg-subheading'
  el.textContent = text
  return el
}
function hint(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'flg-hint'
  el.textContent = text
  return el
}
function notice(text: string, level: 'info' | 'warning' | 'error'): HTMLElement {
  const el = document.createElement('div')
  el.className = `flg-notice flg-notice-${level}`
  el.textContent = text
  return el
}
function required(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'flg-required'
  el.textContent = ' *'
  el.title = 'The engine refuses the file without this key.'
  return el
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** The group whose "Ungroup" has been pressed once and not yet confirmed. Cleared when the
 * selection leaves the group, for the reason pendingDelete is. */
let pendingUngroup: string | null = null

/** What to select once the graph a group operation produced arrives: the group, by id, or
 * nothing. Held across the round trip because the group does not exist -- or has a different
 * shape -- until the host has written the files and re-read them. */
let pendingGroupSelect: { groupId: string | null } | null = null

/** Sends a plan to the host, or says why there is none. Every group change goes through here:
 * one batch message, one status line, one thing to select when it comes back. */
function applyGroupPlan(plan: GroupPlan, select: 'group' | 'none' = 'group'): void {
  if (!plan.ok) {
    setStatus(plan.reason, 'error')
    return
  }
  if (plan.ops.length === 0) return
  pendingGroupSelect = { groupId: select === 'group' ? plan.groupId : null }
  vscode.postMessage({ type: 'annotateBatch', ops: plan.ops })
  setStatus(plan.moved.length > 0 ? `${plan.summary} ${plan.moved.join(', ')} moved from another group.` : plan.summary)
}

/** The graph plans are made against. Never null once a graph has arrived; the empty graph is
 * what a plan refuses over before then. */
function planGraph(): GroupGraph {
  return (groupSource ?? { nodes: [], edges: [], roots: [] }) as unknown as GroupGraph
}

/** A one-line text input that commits on Enter and on blur, and restores itself on Escape. The
 * shape both the group name and the new-group name use. */
function nameInput(initial: string, label: string, onCommit: (value: string) => void, onCancel?: () => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'flg-input flg-group-name'
  input.value = initial
  input.placeholder = 'Group name'
  input.spellcheck = false
  input.setAttribute('aria-label', label)
  let done = false
  const commit = (): void => {
    if (done) return
    const next = input.value.trim()
    if (next === '' || next === initial) {
      input.value = initial
      return
    }
    done = true
    onCommit(next)
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      input.value = initial
      onCancel?.()
    }
  })
  input.addEventListener('change', commit)
  return input
}

/** The member list a group's panel and a multi-selection's panel share: one row per node, the
 * id as a jump, and whatever trailing control the caller wants on it. */
function memberRow(nodeId: string, trailing?: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.className = 'flg-group-member'
  const jump = document.createElement('button')
  jump.type = 'button'
  jump.className = 'flg-jump'
  jump.textContent = nodeId
  jump.title = 'Select just this one.'
  jump.addEventListener('click', () => {
    revealNode(nodeId)
  })
  row.append(jump)
  if (trailing) row.append(trailing)
  return row
}

/** The panel for several selected nodes: what they are, and the two things to do with them --
 * make a group of them, or add them to one. */
function multiSelectionPanel(nodeIds: readonly string[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-group-panel'
  wrap.append(heading(`${String(nodeIds.length)} selected`))

  const form = document.createElement('div')
  form.className = 'flg-group-form'
  const name = nameInput('', 'Group name', (value) => applyGroupPlan(planCreate(planGraph(), groupsView, nodeIds, value)))
  name.id = 'flg-group-name'
  name.title = 'Name the group and press Enter. Written into each member’s file as a comment.'
  const make = document.createElement('button')
  make.type = 'button'
  make.className = 'flg-tool flg-group-make'
  make.textContent = 'Group'
  make.title = 'Group the selected features under this name (Ctrl+G).'
  make.addEventListener('click', () => applyGroupPlan(planCreate(planGraph(), groupsView, nodeIds, name.value)))
  form.append(name, make)
  wrap.append(form)

  if (groupsView.groups.length > 0) {
    const add = document.createElement('select')
    add.className = 'flg-input flg-group-select'
    add.setAttribute('aria-label', 'Add to group')
    add.title = 'Add the selected features to an existing group.'
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'Add to group…'
    add.append(placeholder)
    for (const group of groupsView.groups) {
      const option = document.createElement('option')
      option.value = group.id
      option.textContent = group.name
      add.append(option)
    }
    add.addEventListener('change', () => {
      if (add.value === '') return
      applyGroupPlan(planAdd(planGraph(), groupsView, add.value, nodeIds))
      add.value = ''
    })
    wrap.append(add)
  }

  const grouped = nodeIds.filter((id) => groupsView.memberOf.has(id))
  if (grouped.length > 0) {
    wrap.append(hint(`${String(grouped.length)} of these ${grouped.length === 1 ? 'is' : 'are'} in a group already and would move.`))
  }

  wrap.append(sectionLabel('Selected'))
  for (const id of nodeIds) wrap.append(memberRow(id))
  return wrap
}

/** The panel for one group: its name, its state, its members, and the way out. */
function groupPanel(groupId: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-group-panel'
  const group = groupsView.byId.get(groupId)
  if (!group) {
    wrap.append(notice('That group is no longer in the pack.', 'warning'))
    return wrap
  }

  const head = document.createElement('div')
  head.className = 'flg-group-form'
  const name = nameInput(group.name, 'Group name', (value) => applyGroupPlan(planRename(planGraph(), groupsView, group.id, value)))
  name.title = 'Rename the group. Enter or Tab to apply; rewrites every member’s directive.'
  const fold = document.createElement('button')
  fold.type = 'button'
  fold.className = 'flg-tool flg-group-fold'
  fold.textContent = group.collapsed ? 'Expand' : 'Collapse'
  fold.title = group.collapsed
    ? 'Show the members as their own cards again. Written to their files.'
    : 'Fold the members into one card. Written to their files, so everyone opening the pack sees it folded.'
  fold.addEventListener('click', () => applyGroupPlan(planSetCollapsed(planGraph(), groupsView, group.id, !group.collapsed)))
  head.append(name, fold)
  wrap.append(head)

  for (const warning of group.warnings) wrap.append(notice(warning, 'warning'))

  const tools = document.createElement('div')
  tools.className = 'flg-confirm-buttons'
  const ungroup = document.createElement('button')
  ungroup.type = 'button'
  ungroup.className = 'flg-tool flg-remove flg-group-ungroup'
  ungroup.textContent = 'Ungroup'
  ungroup.title = 'Remove the group. The features stay exactly where they are (Ctrl+Shift+G).'
  ungroup.addEventListener('click', () => {
    pendingUngroup = group.id
    renderInspector(view.getSelection())
  })
  tools.append(ungroup)
  wrap.append(tools)

  // The question, directly under the button that raised it -- the same shape as a delete.
  if (pendingUngroup === group.id) {
    const confirm = document.createElement('div')
    confirm.className = 'flg-confirm'
    confirm.append(hint(`Ungroup "${group.name}"? Its ${String(group.memberIds.length)} member${group.memberIds.length === 1 ? '' : 's'} stay where they are.`))
    const buttons = document.createElement('div')
    buttons.className = 'flg-confirm-buttons'
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'flg-tool flg-remove flg-group-ungroup-confirm'
    go.textContent = 'Ungroup'
    go.addEventListener('click', () => {
      pendingUngroup = null
      applyGroupPlan(planUngroup(planGraph(), groupsView, group.id), 'none')
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'flg-tool'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => {
      pendingUngroup = null
      renderInspector(view.getSelection())
    })
    buttons.append(go, cancel)
    confirm.append(buttons)
    wrap.append(confirm)
  }

  wrap.append(sectionLabel(`Members (${String(group.memberIds.length)})`))
  for (const id of group.memberIds) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'flg-group-member-remove'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Remove ${id} from group`)
    remove.title = 'Take this one out of the group.'
    remove.addEventListener('click', () => applyGroupPlan(planRemove(planGraph(), groupsView, group.id, [id])))
    wrap.append(memberRow(id, remove))
  }
  return wrap
}

/** The one row on a node's panel about groups: which one it is in, as a select that can also
 * take it out or start a new one. */
function groupRow(nodeId: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'flg-group-row'
  const label = document.createElement('span')
  label.className = 'flg-group-row-label'
  label.textContent = 'Group'
  row.append(label)

  const current = groupsView.memberOf.get(nodeId) ?? ''
  const select = document.createElement('select')
  select.className = 'flg-input flg-group-select'
  select.setAttribute('aria-label', 'Group')
  select.title = 'The group this feature belongs to. Stored in its file as a comment.'
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'None'
  select.append(none)
  for (const group of groupsView.groups) {
    const option = document.createElement('option')
    option.value = group.id
    option.textContent = group.name
    select.append(option)
  }
  // A value no group id can be: ids are [a-z0-9_-] only.
  const fresh = document.createElement('option')
  fresh.value = '+new'
  fresh.textContent = 'New group…'
  select.append(fresh)
  select.value = current

  const startNaming = (): void => {
    // The select becomes a name box in place: one row, still.
    const input = nameInput(
      '',
      'New group name',
      (value) => applyGroupPlan(planCreate(planGraph(), groupsView, [nodeId], value)),
      () => renderInspectorFor(nodeId),
    )
    input.title = 'Name the new group and press Enter.'
    select.replaceWith(input)
    input.focus()
  }
  select.addEventListener('change', () => {
    const next = select.value
    if (next === '+new') {
      startNaming()
      return
    }
    if (next === current) return
    if (next === '') {
      applyGroupPlan(planRemove(planGraph(), groupsView, current, [nodeId]), 'none')
      return
    }
    applyGroupPlan(planAdd(planGraph(), groupsView, next, [nodeId]))
  })
  row.append(select)
  return row
}

/** Ctrl+G: name a group of what is selected. Opens the naming control rather than inventing a
 * name -- a group called "Group 3" is a group nobody will recognise next week. */
function startGrouping(): void {
  const selection = view.getSelection()
  if (selection === null) return
  if (selection.kind === 'nodes') {
    renderInspector(selection)
    const input = sideHost!.querySelector('#flg-group-name')
    if (input instanceof HTMLInputElement) input.focus()
    return
  }
  if (selection.kind === 'node') {
    renderInspector(selection)
    const select = sideHost!.querySelector('.flg-group-row select')
    if (select instanceof HTMLSelectElement) {
      select.value = '+new'
      select.dispatchEvent(new Event('change'))
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Asks the host to preview the rule this node belongs to, or the node itself when none does.
 *
 * A feature on its own is previewed at one position. A RULE is what decides where that feature
 * goes and how often across a chunk, so previewing the rule is what shows the thing somebody is
 * actually building -- and it is what makes an edit to a node deep in the tree visible as a
 * change in the terrain rather than as one object moving.
 *
 * Walked upward rather than guessed: follow incoming edges to a node whose type is the synthetic
 * feature rule. Breadth-first so the NEAREST rule wins when several reach the same feature, and
 * ids break ties so the same selection always previews the same thing.
 */
function previewFor(nodeId: string): void {
  const rule = ruleReaching(nodeId)
  // Two ids, and they are not the same question. What to RUN is the rule; whose blocks to
  // highlight is the node the author actually selected, which is somewhere inside that run. The
  // host keeps them apart all the way down (GraphPanel.previewNode -> PreviewPanel.attributeNode)
  // so previewing the rule and attributing the feature happen together rather than one instead
  // of the other.
  vscode.postMessage({ type: 'previewNode', nodeId: rule ?? nodeId, attribute: nodeId })
  if (rule !== null && rule !== nodeId) {
    setStatus(`Previewing ${rule}, the rule that places this.`)
  }
}

/** The nearest feature rule that reaches `nodeId`, or null. */
function ruleReaching(nodeId: string): string | null {
  if (!graph) return null
  const parents = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = parents.get(edge.to)
    if (list) list.push(edge.from)
    else parents.set(edge.to, [edge.from])
  }
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.typeId]))
  const seen = new Set<string>([nodeId])
  let frontier = [nodeId]
  // Bounded by the node count: a cycle cannot make this run forever, because `seen` is only
  // ever added to.
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of [...frontier].sort()) {
      for (const parent of parents.get(id) ?? []) {
        if (seen.has(parent)) continue
        if (typeOf.get(parent) === 'minecraft:feature_rule') return parent
        seen.add(parent)
        next.push(parent)
      }
    }
    frontier = next
  }
  return null
}

/** Whether selecting a node also shows it in the live preview.
 *
 * Off by default and remembered for the session. Previewing runs the feature, which is not
 * free, so it is something to ask for rather than something that happens while someone is
 * merely looking around the graph. */
let previewOnSelect = false

/** The toolbar button that shows it, once the toolbar has been drawn. */
let previewToggle: HTMLButtonElement | null = null

/** Sets the toggle and makes the button say so.
 *
 * ONE place that decides what "on" looks like. There are two things that turn it off -- the
 * author clicking the button, and the preview panel being closed out from under it -- and a
 * second copy of the two attribute writes would be a second copy to keep in step, which is
 * exactly how a button ends up reading "pressed" over a feature that is off. */
function setPreviewOnSelect(value: boolean): void {
  previewOnSelect = value
  previewToggle?.setAttribute('aria-pressed', String(value))
  previewToggle?.classList.toggle('flg-tool-on', value)
}

view.onSelect((selection) => {
  renderInspector(selection)
  if (previewOnSelect && selection && selection.kind === 'node') {
    previewFor(selection.nodeId)
  }
})
// A move is reported once, on drop -- or once per settle for a burst of keyboard nudges -- and
// the host writes it to the sidecar, never into the pack file, since a canvas position is not
// something the game reads.
//
// The payload is a LIST even though one drag moves one card. The other end of this is a file
// write, and a write per node is the wrong shape; two nudges inside one settle window already
// arrive together.
//
// A collapsed group's card is not a file and has no line in the sidecar. Moving it moves its
// MEMBERS: each one is shifted by the card's own displacement and reported as itself, so the
// card comes back where it was dropped on the next graph -- its position is the members'
// bounding box -- and expanding the group later finds the members where the card was.
view.onNodeMove((moves) => {
  for (const move of moves) {
    const groupId = groupIdOfNode(move.nodeId)
    if (groupId !== null) {
      const dx = move.position.x - move.from.x
      const dy = move.position.y - move.from.y
      positions.set(move.nodeId, move.position)
      for (const member of groupsView.byId.get(groupId)?.memberIds ?? []) {
        const at = positions.get(member)
        if (!at) continue
        const next = { x: at.x + dx, y: at.y + dy }
        positions.set(member, next)
        vscode.postMessage({ type: 'moveNode', nodeId: member, x: next.x, y: next.y })
      }
      continue
    }
    positions.set(move.nodeId, move.position)
    vscode.postMessage({ type: 'moveNode', nodeId: move.nodeId, x: move.position.x, y: move.position.y })
  }
})

// Folding and unfolding are edits to the members' files, so they go the same way every other
// group change does and the canvas redraws from what came back.
view.onGroupToggle((groupId, collapsed) => {
  applyGroupPlan(planSetCollapsed(planGraph(), groupsView, groupId, collapsed))
})

// Dragging a connection from one card to another. The gesture reports what the author did; what
// that MEANS is decided by connect.ts, which reads the same per-type rules the graph check does,
// so a preview shown while the line is in somebody's hand cannot disagree with the edit that
// follows.
view.onConnect((request) => {
  if (!graph) return
  const result = planConnection(graph as unknown as ConnectGraph, { from: request.from, to: request.to })
  if (result.outcome === 'refuse') {
    setStatus(result.refusal.reason, 'error')
    return
  }
  if (result.outcome === 'ask') {
    // A weight, a condition, or which of two slots -- none has a defensible default, and the
    // module refuses to invent one. Until the panel can put the question to somebody, saying
    // what is needed beats writing a guess into their pack.
    setStatus(`${result.ask.title} ${result.ask.summary}`, 'error')
    return
  }
  const plan = result.plan
  const edits = plan.operations
    .filter((op): op is Extract<typeof op, { op: 'set' }> => op.op === 'set')
    .map((op) => ({ path: op.path, json: op.json }))
  if (edits.length === 0) {
    setStatus('That connection produced nothing to write.', 'error')
    return
  }
  // One file: a connection is written into the SOURCE feature, and connect.ts refuses anything
  // it cannot express as edits to that one file.
  const file = plan.files[0]
  if (file === undefined) {
    setStatus('That connection named no file to write.', 'error')
    return
  }
  vscode.postMessage({ type: 'applyEdits', file, edits })
  setStatus(plan.destructive ? `${plan.summary} (this replaces what was there)` : plan.summary)
})

view.onActivate((selection) => {
  if (selection && selection.kind === 'node') vscode.postMessage({ type: 'openFile', nodeId: selection.nodeId })
})

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; graph?: unknown; message?: string }
  if (!message || typeof message.type !== 'string') return
  if (message.type === 'graph') {
    lastGraph = message.graph as GraphWire
    rebuildView()
    if (!graph) return
    // An engine that predates the field sends nothing; an empty list is then the honest answer
    // rather than a claim that the pack is clean.
    const sentDiagnostics = (message as unknown as { diagnostics?: GraphDiagnosticWire[] }).diagnostics
    diagnostics = Array.isArray(sentDiagnostics) ? sentDiagnostics : []
    // Positions come from the host, which merges three sources the webview cannot see: the
    // automatic layout, positions annotated in the pack files, and the sidecar this editor
    // writes. Recomputing them here would silently discard the two that are someone's own work.
    const sent = (message as unknown as { positions?: Record<string, GraphPoint> }).positions
    positions = sent ? new Map(Object.entries(sent)) : layout(graph)
    placeGroupCards()
    const problem = (message as unknown as { layoutProblem?: string }).layoutProblem
    if (problem) setStatus(`The saved arrangement could not be read: ${problem}`, 'error')
    draw()
    // A group operation's own answer: the group it made or changed, now that it exists in the
    // graph -- or nothing, after an ungroup. Takes precedence over refreshing whatever was
    // selected, because what was selected was the thing the operation replaced.
    if (pendingGroupSelect !== null) {
      const wanted = pendingGroupSelect.groupId
      pendingGroupSelect = null
      if (wanted !== null && groupsView.byId.has(wanted)) {
        view.setSelection({ kind: 'group', groupId: wanted })
      } else {
        view.setSelection(null)
      }
      renderInspector(view.getSelection())
      ensureSearch()
      setStatus(describeExtent())
      return
    }
    // The panel is rebuilt from the NEW graph whenever one arrives -- for a selected node as much
    // as for the overview.
    //
    // It used to do that only when nothing was selected. With a node selected, the inspector
    // kept the form it had built from the node as it was when somebody CLICKED it, so every edit
    // after the first in a session was computed against a file that no longer existed. Most of
    // the time that only looked stale. Where it did real damage was an edit under a parent the
    // snapshot said was missing: the edit then wrote the parent whole, and whatever the author had
    // just put in it was replaced. Reported as "I picked gaussian, clicked + beside extent, and
    // nothing happens" -- what happened was that + erased gaussian, and the next + erased
    // nothing new because it was still reading the same old snapshot.
    //
    // setSelection re-resolves the node against the graph the view now holds and does not emit,
    // so this refreshes what is selected without re-running a preview on every edit. An edge
    // selection is deliberately left alone: its panel writes through the cached Molang editor,
    // not through a form, and rebuilding it here would take the caret out of the expression the
    // author is typing.
    const current = view.getSelection()
    if (current === null) {
      // The overview describes the graph, so it has to be redrawn when one arrives.
      renderInspector(null)
    } else if (current.kind === 'node') {
      view.setSelection({ kind: 'node', nodeId: current.nodeId, node: current.node })
      // Null when the node went away with the new graph, which renders the overview -- right,
      // since what was selected no longer exists.
      renderInspector(view.getSelection())
    } else if (current.kind === 'nodes' || current.kind === 'group') {
      // Re-resolved the same way: survivors kept, a group that is gone deselected.
      view.setSelection(current)
      renderInspector(view.getSelection())
    }
    // A pending delete was computed from the graph that has just been replaced -- by somebody
    // saving a file, by another window, by an edit made here. Its list of referrers and its
    // account of which files it would touch may now be wrong, and a stale question with a
    // "Delete anyway" button on it is the worst possible thing to leave on screen. Asked again
    // from the new graph is one extra click; answered from the old one is a file nobody meant.
    if (pendingDelete !== null) {
      const asking = pendingDelete.nodeId
      pendingDelete = null
      renderInspectorFor(asking)
    }
    // The totals moved to the overview, so repeating them here would be the same sentence twice
    // on one screen. What the status line can say that the overview cannot is how much of the
    // graph is in front of you -- which matters because the view no longer opens fitted, so there
    // is always more off screen than on it.
    ensureSearch()
    setStatus(describeExtent())
    return
  }
  if (message.type === 'types') {
    coverage = (message as unknown as { coverage: CoverageRow[] }).coverage ?? []
    return
  }
  if (message.type === 'created') {
    const id = (message as unknown as { nodeId: string }).nodeId
    const what = (message as unknown as { what?: string }).what === 'renamed' ? 'Renamed to' : 'Created'
    const node = graph?.nodes.find((n) => n.id === id)
    if (node) {
      // Select and centre it. A node created off-screen that nobody is shown is
      // indistinguishable from one that was never created.
      view.setSelection({ kind: 'node', nodeId: id, node })
      view.focusNode(id)
      renderInspector({ kind: 'node', nodeId: id, node })
      setStatus(`${what} ${id}.`)
      // Keep the chain going. A rule needs a feature, that feature may itself need one, and
      // asking for each in turn is the difference between building a pack by clicking and
      // building one by clicking then hunting for what is still unfinished.
      //
      // Only on a CREATE: a rename ends here. And it stops on its own, because the menu only
      // reopens while the new node still has an empty slot -- a single_block_feature has none,
      // so picking one finishes the sequence without anybody having to say so.
      const waiting = what === 'Created' ? (missingSlots.get(id) ?? [])[0] : undefined
      if (waiting !== undefined && node.file) {
        pendingAttach = { jsonPath: waiting.jsonPath, file: node.file }
        setStatus(`${describeMissing([waiting])} for ${id}.`)
        openPaletteAt()
      }
    }
    return
  }
  if (message.type === 'deleted') {
    // What a delete LEFT BEHIND, which is the half nobody could see before. A feature that was
    // required somewhere is not simply gone: one or more nodes are now placing a stand-in, and
    // being told "deleted" while three cards quietly start saying "needs a feature" is how an
    // author loses track of their own pack.
    //
    // So the nodes are named, and the first one is selected and centred -- its panel is the one
    // with "Choose a feature" on it, so the author lands on the fix rather than on a description
    // of it. The graph that contains them has already arrived: the host refreshes before it says
    // this, which is what makes the node findable here at all.
    const id = (message as unknown as { id: string }).id
    const waiting = (message as unknown as { retargeted?: string[] }).retargeted ?? []
    const drawn = waiting.map((nodeId) => graph?.nodes.find((n) => n.id === nodeId)).filter((n): n is NonNullable<typeof n> => n !== undefined)
    const first = drawn[0]
    if (first === undefined) {
      setStatus(`Deleted ${id}.`)
      return
    }
    view.setSelection({ kind: 'node', nodeId: first.id, node: first })
    view.focusNode(first.id)
    renderInspector({ kind: 'node', nodeId: first.id, node: first })
    setStatus(
      waiting.length === 1
        ? `Deleted ${id}. ${first.id} needs a feature to place -- it is selected.`
        : `Deleted ${id}. ${waiting.length} nodes now need a feature: ${waiting.join(', ')}. Showing ${first.id}.`,
    )
    return
  }
  if (message.type === 'previewClosed') {
    // Closing the preview is an answer: "I am done looking". It turns the toggle off and does
    // nothing else -- the selection stays, the graph does not redraw, nothing is written. Until
    // this existed the next click reopened the panel that had just been shut.
    setPreviewOnSelect(false)
    return
  }
  if (message.type === 'runStats') {
    applyRunStats((message as unknown as { stats?: RunStatsWire | null }).stats ?? null)
    return
  }
  if (message.type === 'attributionSelect') {
    // The preview found what placed a block somebody clicked, and this is where that answer is
    // read: on the card, with the node's name, its type and its file on it.
    //
    // setSelection and NOT a synthetic click. GraphView.setSelection does not fire onSelect,
    // which is precisely why this cannot loop: a selection arriving from the preview does not
    // turn straight back into another `previewNode` request, the way one the author made does.
    // That asymmetry is graph/attribution.ts's AttributionBridge design, held up from this end.
    const ids = (message as unknown as { nodeIds?: string[] }).nodeIds ?? []
    if (!graph) return
    // Only writers this graph actually draws, or that a collapsed group's card stands for. A
    // feature can be attributed and still have no card -- a compound collapsed its parts into one
    // node, or a filter hid it -- and selecting an id with no box would blank the inspector while
    // appearing to have done something.
    const drawn = ids.filter((id) => graph?.nodes.some((n) => n.id === id) || groupsView.memberOf.has(id))
    const first = drawn[0]
    if (first === undefined) {
      setStatus(
        ids.length === 0
          ? 'Nothing in this pack placed that block -- it is environment, or outside the bench.'
          : `That block was placed by ${ids.join(', ')}, which this view is not currently drawing.`,
      )
      return
    }
    revealNode(first)
    // ALL of them named, never just the one selected. A cell written by two features is the
    // ordinary case and the engine's table carries no order, so "this one placed it" would be a
    // guess -- see graph/attribution.ts's header. The card shows one; the line says how many.
    setStatus(
      drawn.length === 1
        ? `That block was placed by ${first}.`
        : `That block was placed by ${String(drawn.length)} features: ${drawn.join(', ')}. Showing ${first}.`,
    )
    return
  }
  if (message.type === 'createError' || message.type === 'editError') {
    // A refused group operation produces no graph, so the selection it was holding for one must
    // not wait around to be applied to the next unrelated redraw.
    pendingGroupSelect = null
    setStatus((message as unknown as { message: string }).message, 'error')
    return
  }
  if (message.type === 'graphError') {
    setStatus(message.message ?? 'The pack could not be read.', 'error')
  }
})

// ---------------------------------------------------------------------------
// The creation menu
// ---------------------------------------------------------------------------

let menu: PaletteMenu | null = null
/** The engine's coverage table, which decides what the menu may offer. Empty until it arrives;
 * the menu is not built before then rather than being built over a guess. */
let coverage: readonly CoverageRow[] = []

/** Builds the menu, or rebuilds it when the pack's format_version changes.
 *
 * The model is rebuilt rather than filtered in place because the version decides which types
 * exist at all: a type below the pack's declared band is not merely unavailable, it is absent
 * from the schema, and the engine drops the key unread rather than complaining. */
function ensureMenu(formatVersion: string | undefined): boolean {
  if (coverage.length === 0) {
    setStatus('The feature type list has not arrived from the engine yet.', 'error')
    return false
  }
  const model = buildPaletteModel({ coverage, formatVersion })
  if (menu) {
    menu.setModel(model)
    return true
  }
  menu = createPaletteMenu({
    model,
    viewport: paletteCamera(view),
    formatVersion,
    onCreate: (request) => onCreate(request),
    // A menu dismissed without picking ends the chain. Without this, pressing Escape would leave
    // the next unrelated node the author creates, minutes later, silently attached to whatever
    // slot was open when they changed their mind.
    onClose: () => {
      pendingAttach = null
    },
  })
  return true
}

/** Hands a creation request to the host. Nothing is drawn here in response: the node exists
 * once its file does, and the next graph brings it back. Optimistically drawing a node the
 * write might refuse is how an editor starts showing a pack that does not exist. */
/** The version a new node should be seeded for: the one the pack's own files declare.
 *
 * Taken from the graph rather than assumed, and from the FIRST node that declares one, because
 * the version decides which keys a type even has -- seeding a node for a band the pack does not
 * use produces a file the engine reads with keys it drops unread. */
function packFormatVersion(): string | undefined {
  return graph?.nodes.find((n) => n.formatVersion)?.formatVersion
}

/** The search box's own slot in the toolbar. It needs a bounded block of its own -- dropped
 * straight into the flex row it spans the width and pushes every button onto a second line. */
function searchHost(): HTMLElement {
  const existing = document.getElementById('flg-search')
  if (existing) return existing
  const host = document.createElement('div')
  host.id = 'flg-search'
  // FIRST in the toolbar, not last. The box floats out of flow so its results can stack over the
  // canvas without moving the buttons -- and on the right of a full-width toolbar that float
  // landed over the sidebar, covering the controls of whatever node was selected.
  toolbarHost!.prepend(host)
  return host
}

let search: SearchBox | null = null
/** The filter currently applied to the canvas, so a reload can re-apply it. */
let canvasFilter: GraphFilter | null = null

/** Builds the search box, or points it at a freshly loaded graph.
 *
 * Rebuilt rather than kept because the index describes the pack, and the pack changes under it on
 * every save -- but the QUERY is kept, so a save does not throw away what somebody was looking
 * for. That is `setSource`'s whole job. */
function ensureSearch(): void {
  if (!graph) return
  // Indexed over the graph BEFORE groups fold, so a feature inside a collapsed group is still
  // findable -- search is how somebody finds a thing they cannot see, and a collapsed group is
  // the one place on this canvas a thing can be without being seen. Revealing a hit that is
  // hidden selects the group's card instead (revealNode).
  const source = groupSource ?? graph
  const index = buildSearchIndex(source)
  if (search) {
    search.setSource(index, source)
    return
  }
  search = createSearchBox({
    index,
    graph: source,
    container: searchHost(),
    onReveal: (hit) => {
      revealNode(hit.nodeId)
    },
    // Deliberately NOT bound: the active row changes on every keystroke, so a camera that
    // followed it would fly around the pack while somebody is still typing.
    onFilter: (filter) => {
      canvasFilter = filter
      if (!graph) return
      // The same positions are reused, so filtering hides boxes without moving the ones that
      // stay. A filter that re-laid the graph out would answer the question and lose the place
      // the reader had. A filtered view is of the source graph, groups unfolded, so no frames.
      view.render(filter ? filter.graph : graph, positions, filter ? [] : frames)
      setStatus(
        filter
          ? `Showing ${filter.graph.nodes.length} of ${graph.nodes.length}. Escape puts the rest back.`
          : describeExtent(),
      )
    },
  })
}

/** Rename and delete, on the node they are about.
 *
 * Rename sits here rather than in a menu because the name is what the panel is headed with, and
 * a name you can see but not change is the state every node created in this editor starts in --
 * creation has to invent one, and until now that invention was permanent.
 *
 * Both are PLANNED locally first, so the reason a thing cannot be done is shown before the
 * author commits to it rather than after. The engine re-derives and re-checks everything anyway;
 * this is about telling somebody early, not about trusting the plan.
 */
function lifecycleBar(nodeId: string, node: { unresolved?: boolean; external?: boolean }): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-lifecycle'
  if (node.unresolved) {
    // Nothing here defines it, so there is nothing to rename or delete. The file that POINTS at
    // it is what to change, and saying so beats two disabled buttons.
    wrap.append(
      hint(
        node.external
          ? 'The game provides this one. Nothing in this pack defines it, so there is nothing here to rename or remove.'
          : 'Nothing in this pack defines this. To fix it, change the feature that points at it.',
      ),
    )
    return wrap
  }

  const name = document.createElement('input')
  name.type = 'text'
  name.className = 'flg-input flg-rename'
  name.value = nodeId
  name.spellcheck = false
  name.setAttribute('aria-label', 'Identifier')
  name.addEventListener('change', () => {
    const next = name.value.trim()
    if (next === '' || next === nodeId) {
      name.value = nodeId
      return
    }
    const plan = renameFeature(graph as unknown as IdiomGraph, { target: nodeId, newId: next })
    if (!plan.ok) {
      setStatus(plan.refusal.reason, 'error')
      name.value = nodeId
      return
    }
    vscode.postMessage({ type: 'renameFeature', from: nodeId, to: next })
    setStatus(`Renaming ${nodeId} to ${next}...`)
  })
  wrap.append(name)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'flg-tool flg-remove'
  remove.textContent = 'Delete'
  remove.addEventListener('click', () => requestDelete(nodeId))
  wrap.append(remove)
  return wrap
}

/** The slot the next created node should be written into, while a chain is running.
 *
 * Set when the author picks "Choose a feature" on a missing slot, or when a node they just
 * created still has one. Cleared when the menu closes without a pick, which is how Escape ends
 * the chain rather than leaving the next unrelated create secretly attached to something. */
let pendingAttach: { jsonPath: string; file: string } | null = null

/** One "this node is still waiting for something" row, with the button that fills it. */
function missingSlotRow(slot: MissingSlot, file: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-missing'

  const line = document.createElement('div')
  line.className = 'flg-missing-line'
  const mark = document.createElement('span')
  mark.className = 'flg-missing-mark'
  mark.textContent = '!'
  mark.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span')
  text.textContent = describeMissing([slot]) ?? ''
  line.append(mark, text)
  wrap.append(line)

  if (slot.doc !== '') {
    const doc = document.createElement('p')
    doc.className = 'flg-missing-doc'
    doc.textContent = slot.doc
    wrap.append(doc)
  }

  const pick = document.createElement('button')
  pick.type = 'button'
  pick.className = 'flg-tool'
  pick.textContent = 'Choose a feature'
  pick.addEventListener('click', (event) => {
    if (file === '') {
      setStatus('This node has no file to write the choice into.', 'error')
      return
    }
    pendingAttach = { jsonPath: slot.jsonPath, file }
    openPaletteAt(event as PointerEvent)
  })
  wrap.append(pick)
  return wrap
}

/** Opens the creation menu, positioned at the pointer when there is one. */
function openPaletteAt(event?: PointerEvent): void {
  if (!ensureMenu(packFormatVersion())) return
  const at = event ? { x: event.clientX, y: event.clientY } : { x: window.innerWidth / 2, y: window.innerHeight / 3 }
  menu?.openAt(at)
}

/** A delete the author has been shown the cost of and has not yet agreed to.
 *
 * Held here rather than drawn on the spot so it survives a redraw and so the panel has ONE place
 * that decides what a pending delete looks like. Cleared the moment the selection moves off the
 * node it is about: a question about one feature must not still be on screen while another one
 * is selected. */
let pendingDelete: {
  nodeId: string
  /** The refusal that named every referrer -- the thing the author is deciding from. */
  reason: string
  /** What going ahead would actually do, planned before the question is asked so the button can
   * say which files it touches, or say that it still cannot be done. */
  ahead: ReturnType<typeof deleteFeature>
} | null = null

/** The graph of FILES, which is what a lifecycle plan is about.
 *
 * `graph` is the DRAWING: compounds are collapsed, and an edge leaving one of their hidden
 * children has been re-pointed at the compound that stands for it while keeping the child's own
 * jsonPath. That is right for a picture and wrong for a plan -- it would name one node's file
 * alongside another node's path, and retargeting through that pair would write the placeholder
 * into a file nobody asked about. `lastGraph` is the host's graph, untouched. */
function fileGraph(): IdiomGraph {
  return (lastGraph ?? graph) as unknown as IdiomGraph
}

/** Asks the host to delete a node, putting the consequences to the author first.
 *
 * Lifted out of the Delete button so the keyboard can reach the same behaviour. It had to be:
 * pressing Delete on a selected node did nothing at all, because `Delete` existed only as text on
 * a button and no key was bound to anything.
 *
 * Planned WITHOUT detaching first, because that refusal is where the list of referrers comes
 * from and the author needs it to decide. What has changed is what happens next: the list used to
 * be printed to the status line and that was the end of it -- the panel always asked with
 * `detachReferences: false` and never offered the other answer, so a referenced feature simply
 * could not be deleted from here. Now the refusal becomes a question with a button on it, and
 * `detachReferences` stops being something the author has to know exists. */
function requestDelete(nodeId: string): void {
  const plan = deleteFeature(fileGraph(), { target: nodeId })
  if (plan.ok) {
    sendDelete(plan.plan)
    return
  }
  if (plan.refusal.code !== 'referenced') {
    // Every other refusal is about the feature itself -- it is dangling, it has no file, a path
    // does not have the shape its kind requires. None of those is a decision to put to anybody.
    setStatus(plan.refusal.reason, 'error')
    return
  }
  pendingDelete = { nodeId, reason: plan.refusal.reason, ahead: deleteFeature(fileGraph(), { target: nodeId, detachReferences: true }) }
  setStatus(plan.refusal.reason, 'error')
  renderInspectorFor(nodeId)
}

/** Posts the plan's own request, rather than a second derivation of it. */
function sendDelete(plan: LifecyclePlan): void {
  if (plan.request.method !== 'deleteFeature') return
  const params = plan.request.params
  vscode.postMessage({
    type: 'deleteFeature',
    id: params.id,
    detachReferences: params.detachReferences,
    retarget: params.retarget,
  })
  setStatus(`Deleting ${params.id}...`)
}

/** The question a `referenced` refusal turns into: what it would touch, and a button to go ahead.
 *
 * The refusal's own sentence is kept whole at the top. It names up to six referrers with their
 * files and paths, and that list is the entire reason the refusal exists -- replacing it with
 * "this is referenced, continue?" would take away the only thing the author can decide from. */
function deleteConfirmPanel(pending: NonNullable<typeof pendingDelete>): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-confirm'
  wrap.append(notice(pending.reason, 'error'))

  const buttons = document.createElement('div')
  buttons.className = 'flg-confirm-buttons'

  if (pending.ahead.ok) {
    const plan = pending.ahead.plan
    wrap.append(hint(plan.summary))
    wrap.append(hint(`Files this changes: ${plan.files.join(', ')}.`))
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'flg-tool flg-remove'
    go.textContent = 'Delete anyway'
    go.addEventListener('click', () => {
      pendingDelete = null
      sendDelete(plan)
    })
    buttons.append(go)
  } else {
    // Found now rather than after a click: a list the engine will not load empty, or a path whose
    // shape cannot be trusted, is still a refusal, and saying so here is one message instead of
    // an inviting button that produces one.
    wrap.append(hint(`Deleting it anyway is not possible either: ${pending.ahead.refusal.reason}`))
  }

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'flg-tool'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => {
    const nodeId = pending.nodeId
    pendingDelete = null
    setStatus(`${nodeId} was left alone.`)
    renderInspectorFor(nodeId)
  })
  buttons.append(cancel)
  wrap.append(buttons)
  return wrap
}

/** The parameter form for a collapsed compound, or null when this node is not one.
 *
 * Rebuilt when the selection moves and updated in place otherwise, so editing one field does
 * not throw away focus in the next. */
function compoundFormFor(nodeId: string): HTMLElement | null {
  if (!compoundView) return null
  const compound = compoundView.compounds.find((c) => c.identifier === nodeId)
  if (!compound) return null
  const spec = COMPOUNDS[compound.kind]
  if (!spec) return null

  if (compoundForm && compoundFormNode === nodeId) {
    compoundForm.update(compound)
    return compoundForm.element
  }
  compoundForm?.dispose()
  compoundForm = createCompoundForm(compound, {
    spec: spec as never,
    formatVersion: compound.formatVersion,
    onChange: (change) => onCompoundParams(change),
  })
  compoundFormNode = nodeId
  return compoundForm.element
}

/** Re-expands a compound from edited parameters and asks the host to write the result.
 *
 * The expansion is run here rather than trusted from the form, because `expand` is the thing
 * the compound's own tests cover and a second path producing files would be a second thing to
 * keep correct. Children the new parameters no longer produce are named for removal -- a steps
 * compound that loses a step leaves an item feature behind otherwise, delegated to by nothing and
 * indistinguishable from one somebody wrote.
 */
function onCompoundParams(change: CompoundParamsChange): void {
  const spec = COMPOUNDS[change.kind]
  const previous = compoundView?.compounds.find((c) => c.identifier === change.identifier)
  const formatVersion = previous?.formatVersion ?? packFormatVersion() ?? '1.21.10'
  const result = spec.expand(change.identifier, change.params as never, formatVersion)
  if (!result.ok) {
    setStatus(`${change.label}: ${result.refusal.reason}`, 'error')
    return
  }
  const files = result.expansion.operations
    .filter((op): op is Extract<typeof op, { op: 'createFile' }> => op.op === 'createFile')
    .map((op) => ({
      path: op.file,
      contents:
        op.identifier === change.identifier && !hasCompoundAnnotation(op.contents)
          ? withCompoundAnnotation(op.contents, change.kind, change.params)
          : op.contents,
    }))
  const keeping = new Set(result.expansion.creates)
  const remove = (previous?.childIds ?? []).filter((id) => !keeping.has(id)).map((id) => featureFilePath(id))

  vscode.postMessage({ type: 'regenerate', owner: change.identifier, files, remove })
  setStatus(change.label)
}

/** The panel shown above a compound's own form: what it is, and the one-way door.
 *
 * Returns null for an ordinary node, which is most of them.
 *
 * The expand button is deliberately not a toggle on the canvas. Opening a compound is a
 * statement about how you want to READ it, and the cost of getting it wrong is asymmetric --
 * collapsing again is free, while editing what you opened is not reversible at all. So the
 * warning is attached to the action that cannot be undone, before it, rather than to the one
 * that can.
 */
function compoundPanel(nodeId: string): HTMLElement | null {
  if (!compoundView) return null
  const compound = compoundView.compounds.find((c) => c.identifier === nodeId)
  if (!compound) return null

  const wrap = document.createElement('div')
  wrap.className = 'flg-compound'

  const title = document.createElement('div')
  title.className = 'flg-compound-title'
  title.textContent = compound.title || compound.kind
  wrap.append(title)
  if (compound.summary) wrap.append(hint(compound.summary))

  // Drift: the annotation says one thing and the files say another, which happens when somebody
  // edits them in a text editor -- legitimate, since the JSON is the source of truth. Reported,
  // not resolved: dropping the annotation would punish editing a file that is meant to be
  // editable, and trusting it would show a form that does not describe what is on disk.
  if (compound.presentation === 'compound' && compound.drift.length > 0) {
    wrap.append(
      notice(
        `This ${compound.title || compound.kind} no longer matches what its recorded settings ` +
          `produce -- ${compound.drift.length} difference${compound.drift.length === 1 ? '' : 's'}. ` +
          'Something edited the files directly. The settings below are what was recorded, not ' +
          'what is on disk.',
        'warning',
      ),
    )
  }

  const expanded = expandedCompounds.has(nodeId)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'flg-add'
  toggle.textContent = expanded ? 'Hide what it produced' : 'Show what it produced'
  toggle.disabled = !compound.collapsible && !expanded
  if (toggle.disabled) {
    toggle.title = 'The features this produced cannot be identified, so they are all shown already.'
  }
  toggle.addEventListener('click', () => {
    if (expanded) expandedCompounds.delete(nodeId)
    else expandedCompounds.add(nodeId)
    // Re-collapse from the graph the host last sent. Nothing is re-read: expanding is a way of
    // looking, not a change, so it must not cost a round trip or touch a file.
    if (lastGraph) {
      rebuildView()
      if (graph) positions = layout(graph)
      placeGroupCards()
      draw()
      renderInspectorFor(nodeId)
    }
  })
  wrap.append(toggle)

  if (expanded) {
    const warning = ejectWarning(compoundView, nodeId)
    if (warning) {
      wrap.append(
        notice(
          `Editing any of the ${warning.nodesBecomingPlain.length} features below turns this back ` +
            'into ordinary nodes, permanently. The settings above stop being a form and this stops ' +
            'being one node. Moving them on the canvas is not an edit and changes nothing.',
          'warning',
        ),
      )
    }
  }
  return wrap
}

/** The four compound implementations, by kind.
 *
 * An exhaustive Record rather than a lookup that can miss: a fifth compound added to
 * CompoundKind fails to compile here instead of silently becoming a menu entry that does
 * nothing when clicked. */
const COMPOUNDS: Record<CompoundKind, CompoundSpec<never>> = {
  loop: loopCompound as unknown as CompoundSpec<never>,
  steps: stepsCompound as unknown as CompoundSpec<never>,
  'placement-guard': placementGuardSpec as unknown as CompoundSpec<never>,
  column: columnCompound as unknown as CompoundSpec<never>,
}

/** The same four specs, in the shape the collapse view wants them. */
const COMPOUND_REGISTRY: CompoundRegistry = COMPOUNDS

/** Hides the features a compound generated, so a compound draws as ONE node.
 *
 * Which nodes belong to a compound is answered by re-running its own `expand` on the recorded
 * parameters and reading what that CREATES -- the generator's own answer, not an observer's
 * reconstruction. Names like `__condition_0` are a strong hint and are deliberately not used:
 * a hand-written feature that happens to be called that would be swallowed, and a renamed child
 * would be missed, and either way the editor hides a node the author never grouped.
 *
 * Anything that cannot be resolved -- no annotation, unparseable parameters, no spec registered,
 * an expansion that refuses -- leaves the subgraph exactly as it is. Showing the raw nodes is
 * always honest; guessing is not.
 */
/** Compounds the author has opened up to look inside. Session state, not written anywhere:
 * looking at the machinery is free, and a pack should not remember that somebody once looked. */
const expandedCompounds = new Set<string>()

/** The last built view, so the inspector can ask what a selected node IS without rebuilding. */
let compoundView: CompoundView | null = null

/** What each node is still waiting for, from the last graph. Empty for a finished pack. */
let missingSlots: ReadonlyMap<string, readonly MissingSlot[]> = new Map()

/** Drops the shared placeholder's dangling node, and remembers who was pointing at it.
 *
 * Runs AFTER collapseCompounds, not before: a compound's seeded children reference the
 * placeholder too, and collapsing hides those children behind one card. Removing the ghost first
 * would leave the compound's own view with edges into a node that no longer exists. */
function withoutPlaceholderGhosts(g: GraphWire): GraphWire {
  const view = viewWithoutPlaceholders(g as never)
  missingSlots = view.missing
  if (view.graph.nodes.length === g.nodes.length) return g
  // Spread the ORIGINAL, replacing only what changed. Returning just `{nodes, edges}` dropped
  // `roots` and `cycles` -- and the overview reads both, so the whole panel died on a graph that
  // had ever contained a placeholder. A transform that narrows a contract has to say so in its
  // return type or preserve it; this one preserves it.
  const remaining = new Set(view.graph.nodes.map((n) => n.id))
  return {
    ...g,
    nodes: view.graph.nodes as GraphWire['nodes'],
    edges: view.graph.edges as unknown as GraphWire['edges'],
    roots: (g.roots ?? []).filter((id) => remaining.has(id)),
  }
}

function collapseCompounds(g: GraphWire): GraphWire {
  const view = buildCompoundView({ graph: g as never, registry: COMPOUND_REGISTRY, expanded: expandedCompounds })
  compoundView = view
  if (view.hiddenNodeIds.length === 0) return g
  const hidden = new Set(view.hiddenNodeIds)
  // Which compound owns each hidden node, so an edge leaving one can be re-pointed at the node
  // that now stands for it.
  const ownerOf = new Map<string, string>()
  for (const compound of view.compounds) {
    for (const child of compound.childIds) {
      if (hidden.has(child)) ownerOf.set(child, compound.identifier)
    }
  }

  // An edge is kept and re-pointed rather than dropped, and this matters more than it sounds.
  // A steps compound's items delegate to the author's own features, and those edges leave the
  // generated item scatters -- all of which are hidden. Dropping them left the compound
  // drawn as an island with no connection to the features it chooses between, which is a
  // worse drawing than showing the machinery would have been: the whole reason to collapse is
  // to see the shape of the pack, and the shape IS those connections.
  //
  // An edge WITHIN one compound is dropped: both ends are the same node afterwards, and a
  // self-loop on a collapsed compound would draw the machinery as a decoration.
  const edges: typeof g.edges = []
  const seen = new Set<string>()
  for (const edge of g.edges) {
    const from = ownerOf.get(edge.from) ?? edge.from
    const to = ownerOf.get(edge.to) ?? edge.to
    if (hidden.has(from) || hidden.has(to)) continue
    if (from === to && (ownerOf.has(edge.from) || ownerOf.has(edge.to))) continue
    // Several items of one steps compound can reach the same feature. Re-pointed, they become the
    // same edge, and drawing it four times is four arrowheads on one line.
    const key = `${from} ${to} ${edge.kind}`
    if (from !== edge.from || to !== edge.to) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    edges.push(from === edge.from && to === edge.to ? edge : { ...edge, from, to })
  }

  return { ...g, nodes: g.nodes.filter((n) => !hidden.has(n.id)), edges }
}

/** A name nothing in the pack is using yet.
 *
 * Creation has to propose one, because a node needs an identifier before it can be a file and
 * the author has not been asked for one yet. Colliding would be the worst outcome: the engine
 * matches identifiers without regard to case and would silently pick one of the two files. */
function freeIdentifier(base: string): string {
  const taken = new Set((graph?.nodes ?? []).map((n) => n.id.toLowerCase()))
  const namespace = (graph?.nodes ?? []).find((n) => n.id.includes(':'))?.id.split(':')[0] ?? 'example'
  for (let n = 1; n < 1000; n++) {
    const candidate = `${namespace}:${base}_${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${namespace}:${base}_${Date.now()}`
}

/** Turns a creation request into the files it means, and sends them.
 *
 * A compound is expanded through its own spec rather than through anything written here: the
 * spec is what the compound's tests cover, and a second expansion path would be a second thing
 * to keep correct. A compound that refuses -- because its default parameters cannot be
 * expressed -- says so instead of writing a partial subgraph.
 *
 * Nothing is drawn in response. The node exists once its file does, and the next graph brings
 * it back; drawing it optimistically is how an editor starts showing a pack that is not there. */
function onCreate(request: NodeCreationRequest): void {
  const formatVersion = packFormatVersion() ?? '1.21.10'
  if (request.kind === 'compound') {
    const spec = COMPOUNDS[request.compound]
    const identifier = freeIdentifier(request.compound.replace('-', '_'))
    const seeded = spec.validate(compoundSeed(request.compound))
    if (!seeded.ok) {
      setStatus(`${request.item.title}: ${seeded.refusal.reason}`, 'error')
      return
    }
    const result = spec.expand(identifier, seeded.params, formatVersion)
    if (!result.ok) {
      setStatus(`${request.item.title}: ${result.refusal.reason}`, 'error')
      return
    }
    const files = result.expansion.operations
      .filter((op): op is Extract<typeof op, { op: 'createFile' }> => op.op === 'createFile')
      .map((op) => ({
        path: op.file,
        // The compound's OWN file carries the provenance; its generated children do not, and
        // must not -- a child carrying an idiom directive would read as a compound of its own.
        contents:
          op.identifier === identifier && !hasCompoundAnnotation(op.contents)
            ? withCompoundAnnotation(op.contents, request.compound, seeded.params)
            : op.contents,
      }))
    vscode.postMessage({ type: 'create', files, select: identifier, position: request.position })
    attachToPending(identifier)
    setStatus(`Creating ${request.item.title} as ${identifier}...`)
    return
  }

  if (request.kind === 'rule') {
    // A rule is created UNATTACHED but loadable: it names a placeholder feature no pack owns, so
    // it draws as a visible dangling edge the canvas already knows how to explain. Refusing to
    // make one until a feature exists would forbid rule-first authoring, which is exactly the
    // trip back to a text editor this panel exists to end.
    const identifier = freeIdentifier('rule')
    vscode.postMessage({
      type: 'create',
      files: [{ path: ruleFilePath(identifier), contents: ruleFileContents(identifier, formatVersion) }],
      select: identifier,
      position: request.position,
    })
    attachToPending(identifier)
    setStatus(`Creating ${request.item.title} as ${identifier}...`)
    return
  }

  const identifier = freeIdentifier(request.typeId.replace('minecraft:', '').replace(/_feature$/, ''))
  vscode.postMessage({
    type: 'create',
    files: [
      {
        path: featureFilePath(identifier),
        // Required references pointed at the stand-in, the way a rule and a compound already are.
        // Without it a new scatter had no `places_feature`: a file the engine refuses, no edge, so
        // no "Needs a feature" and nowhere for its `iterations` to be shown.
        contents: featureFileContents(request.typeId, identifier, formatVersion, withScatterIterations(request.typeId, withPlaceholderDelegations(request.typeId, request.fields))),
      },
    ],
    select: identifier,
    position: request.position,
  })
  attachToPending(identifier)
  setStatus(`Creating ${request.item.title} as ${identifier}...`)
}

/** Writes a just-created identifier into the slot that was waiting for one, if any.
 *
 * Posted as a separate edit to a DIFFERENT file than the create, which is why it can go now
 * rather than after the graph comes back: the host applies messages in order, and the parent's
 * file is not the one being created. Waiting for the round trip would mean holding the intent
 * across a reload and re-finding the node, for no gain. */
function attachToPending(identifier: string): void {
  const target = pendingAttach
  pendingAttach = null
  if (target === null) return
  vscode.postMessage({
    type: 'applyEdits',
    file: target.file,
    edits: [{ path: target.jsonPath, json: JSON.stringify(identifier) }],
  })
}

/** Starting parameters for a new compound.
 *
 * Deliberately minimal and deliberately NOT clever. A loop's count is Molang and a steps
 * compound's steps are a list of features; there is no defensible default for either, so each gets the
 * smallest thing its own validator accepts and the author fills in the rest in the inspector.
 * `example:` is used for the placeholder target because it is a namespace no real pack owns,
 * so an unfinished node is a visible dangling reference rather than a silent wrong one. */
function compoundSeed(kind: CompoundKind): unknown {
  const places = 'example:replace_me'
  switch (kind) {
    case 'loop': return { count: '1', places }
    case 'steps': return { steps: [places] }
    case 'placement-guard': return { places, mayReplace: ['minecraft:air'] }
    case 'column': return { places, maxY: '1' }
  }
}

// Right-click on empty canvas opens it, at the pointer. On a NODE the browser's own menu is
// left alone -- "add a node here" is not what a right-click on an existing node means.
canvasHost.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement | null
  if (target && target.closest('.flg-node')) return
  event.preventDefault()
  if (!ensureMenu(packFormatVersion())) return
  menu?.openAt({ x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY })
})

// Both stylesheets go in at startup, not when the thing that needs them first appears. The
// inspector's used to be installed from the palette's setup path, so selecting a node before
// ever opening the menu rendered the whole panel unstyled.
installPaletteStyles(document)
installStylesheet('flg-inspector-styles', INSPECTOR_STYLESHEET)
installStylesheet('flg-compound-form-styles', COMPOUND_FORM_STYLESHEET)
installStylesheet('flg-search-styles', SEARCH_STYLESHEET)

// The sidebar is draggable, and its width is remembered.
//
// Not a second splitter: this is the one the preview panel has used since "the preview is tiny"
// was fixed, with its drag clamp, collapse toggle, remembered width, and the live clamp that
// keeps the canvas usable when the HOST window is dragged narrow rather than the divider. Its
// styles are in media/graph.css under the same class names, so both panels answer the pointer
// the same way.
//
// The key is this panel's own. The module used one global key, which meant the graph's useful
// width and the preview's useful width were the same number and each opening overwrote the
// other's.
{
  const body = document.getElementById('flg-body')
  if (body !== null && sideHost !== null) {
    createSplitter({ container: body, sidebar: sideHost, storageKey: 'featurelab.graph.layout.v1' })
  }
}
installStylesheet('flg-molang-field-styles', MOLANG_FIELD_STYLESHEET)
installStylesheet(
  'flg-edge-panel-styles',
  `.flg-edge-panel { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; height: 100%; box-sizing: border-box; }
   .flg-edge-head { font-weight: 600; word-break: break-all; }
   .flg-edge-kind { opacity: 0.7; text-transform: uppercase; font-size: 0.85em; letter-spacing: 0.04em; }
   /* .flg-edge-molang is NOT here. It is the class both halves of the highlighted field carry,
      and every metric on it has to be the same for both, so it lives in exactly one place --
      MOLANG_FIELD_STYLESHEET, installed below. A second copy here would be two stylesheets
      racing to own the one property that must not differ between the two layers. */
   .flg-edge-problems { display: flex; flex-direction: column; gap: 6px; }
   .flg-diagnostic-row {
     display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
     width: 100%; box-sizing: border-box; text-align: left; cursor: pointer;
     background: none; border: none; border-left: 2px solid transparent;
     padding: 4px 8px; margin: 2px 0; color: inherit; font: inherit;
   }
   .flg-diagnostic-error { border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
   .flg-diagnostic-warning { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
   .flg-diagnostic-row:hover { background: var(--vscode-list-hoverBackground); }
   .flg-diagnostic-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
   .flg-diagnostic-file { font-weight: 600; word-break: break-all; }
   .flg-diagnostic-message { opacity: 0.85; }
   .flg-delegations { display: flex; flex-direction: column; gap: 4px; padding: 6px 12px; }
   .flg-delegation-row { display: flex; align-items: center; gap: 8px; }
   .flg-delegation-label { flex: 0 0 auto; opacity: 0.75; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; }
   .flg-delegation-input {
     flex: 1 1 auto; min-width: 0;
     color: var(--vscode-input-foreground); background: var(--vscode-input-background);
     border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 6px;
     font-family: var(--vscode-editor-font-family, monospace);
   }
   .flg-delegation-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
   .flg-missing {
     display: flex; flex-direction: column; gap: 6px; align-items: flex-start;
     margin: 6px 12px; padding: 8px 10px;
     border-left: 2px solid var(--vscode-editorWarning-foreground, #cca700);
     background: var(--vscode-inputValidation-warningBackground, transparent);
   }
   .flg-missing-line { display: flex; align-items: center; gap: 8px; font-weight: 600; }
   .flg-missing-mark {
     flex: 0 0 auto; width: 16px; height: 16px; border-radius: 50%;
     display: inline-flex; align-items: center; justify-content: center;
     background: var(--vscode-editorWarning-foreground, #cca700);
     color: var(--vscode-editor-background, #1e1e1e); font-size: 11px; font-weight: 700;
   }
   .flg-missing-doc { margin: 0; opacity: 0.85; font-size: 0.9em; }
   /* The question a refusal turns into. Bordered in the error colour because it IS the refusal
      -- the buttons are what is new about it -- and laid out as a column so the referrer list,
      which can run to six files and their paths, wraps rather than squeezing the buttons off. */
   .flg-confirm {
     display: flex; flex-direction: column; gap: 6px;
     margin: 6px 12px; padding: 8px 10px;
     border-left: 2px solid var(--vscode-editorError-foreground, #f14c4c);
   }
   .flg-confirm-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
   /* Groups. Compact on purpose: one row per fact, tooltips for the reasons. */
   .flg-group-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; }
   .flg-group-form { display: flex; gap: 6px; align-items: center; }
   .flg-group-form .flg-group-name { flex: 1 1 auto; min-width: 0; }
   .flg-group-name, .flg-group-select {
     color: var(--vscode-input-foreground); background: var(--vscode-input-background);
     border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 6px;
     font: inherit;
   }
   .flg-group-name:focus, .flg-group-select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
   .flg-group-member { display: flex; align-items: center; gap: 4px; }
   .flg-group-member .flg-jump { flex: 1 1 auto; min-width: 0; }
   .flg-group-member-remove {
     flex: 0 0 auto; width: 20px; height: 20px; border-radius: 3px; border: none; padding: 0;
     background: none; color: inherit; font: inherit; opacity: 0.7; cursor: pointer;
   }
   .flg-group-member-remove:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
   .flg-group-member-remove:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
   .flg-group-row { display: flex; align-items: center; gap: 8px; padding: 4px 12px; }
   .flg-group-row-label { flex: 0 0 auto; opacity: 0.75; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; }
   .flg-group-row .flg-group-select, .flg-group-row .flg-group-name { flex: 1 1 auto; min-width: 0; }
   .flg-jump-group::before { content: '▣ '; opacity: 0.7; }`,
)

/** Whether the keystroke belongs to something the author is typing into.
 *
 * Load-bearing for Delete: without it, deleting a character in the rename box or in a Molang
 * expression would delete the NODE. A shortcut that destroys a file while you are editing text is
 * worse than no shortcut, which is why this is checked before the key is looked at rather than
 * after. `isContentEditable` is in there for the highlighted Molang field. */
function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (el === null || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

window.addEventListener('keydown', (event) => {
  // Ctrl+F focuses the search box, which is where anybody who has used an editor will reach first.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    ensureSearch()
    search?.focus()
    return
  }
  // Ctrl+G groups what is selected -- it opens the naming control, and the group is made on
  // Enter -- and Ctrl+Shift+G takes the selected group apart. The chord is deliberate enough not
  // to ask again; the panel's own Ungroup button asks, because a button is one slip away.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g' && !typingInto(event.target)) {
    event.preventDefault()
    const selection = view.getSelection()
    if (event.shiftKey) {
      if (selection?.kind === 'group') applyGroupPlan(planUngroup(planGraph(), groupsView, selection.groupId), 'none')
      return
    }
    startGrouping()
    return
  }
  // Delete removes the selected node, the same way the panel's own button does -- including the
  // refusal when something still delegates to it. Backspace is deliberately NOT bound: on a
  // canvas it is the key people press expecting "go back", and the two are one keystroke apart.
  if (event.key === 'Delete' && !typingInto(event.target)) {
    const selection = view.getSelection()
    if (selection === null || selection.kind !== 'node') return
    event.preventDefault()
    requestDelete(selection.nodeId)
  }
})

renderToolbar()
renderInspector(null)
setStatus('Loading the pack...')
vscode.postMessage({ type: 'ready' })
