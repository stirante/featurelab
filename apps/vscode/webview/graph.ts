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
  nodeGroupWarnings,
  planAdd,
  planCreate,
  planRemove,
  planRename,
  planSetCollapsed,
  planUngroup,
  readGroups,
  withDirectives,
  type AnnotateOp,
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
  type LineageEntry,
  type NodeInspector,
  type NodeLineage,
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
  classifyEdit,
  ejectWarning,
  type CompoundRegistry,
  type CompoundView,
  type EjectWarning,
} from '../src/graph/compounds/collapse.js'
import { installTooltips, TOOLTIP_STYLESHEET } from '../src/graph/docs/tooltip.js'
import { loopCompound } from '../src/graph/compounds/loop.js'
import { stepsCompound } from '../src/graph/compounds/steps.js'
import { placementGuardSpec } from '../src/graph/compounds/placementGuard.js'
import { columnCompound } from '../src/graph/compounds/column.js'
import type { CoverageRow } from '../src/graph/typeCatalog.js'
import { emptyGraphMessage, graphCancelledMessage, graphErrorMessage, type EmptyStatePackContents } from '../src/graph/emptyState.js'
import { describeEmptyGraphKinds } from '../src/packContents.js'
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

const view = createGraphView(canvasHost, {
  ariaLabel: 'Feature graph',
  // The status line is a statement about the CAMERA, so it is recomputed when the camera moves
  // and not once when the pack arrives. It used to be once: pressing Fit on a 57-node pack framed
  // all 22 of its groups and left the line underneath still saying "Showing one of 22 separate
  // groups. Fit shows them all." -- a sentence that had been true for exactly as long as it took
  // to press the button it was describing. Coalesced to one call per frame by the view itself.
  onCamera: () => {
    refreshExtentStatus()
    persistView()
  },
  // "20 use this" on a card is a question, and the answer is a list this canvas cannot draw: the
  // twenty lines arrive inside the card's own height and most of the twenty parents are off
  // screen at any zoom where the card is readable. The card has already moved the selection, so
  // the inspector is showing this node; all that is left is to put the reader on the list.
  onFanIn: (nodeId) => {
    renderInspector(view.getSelection())
    if (inspector !== null && inspectorNode === nodeId && inspector.revealLineage('parents')) return
    setStatus('The features that delegate to this one are listed under "Used by" in the panel.')
  },
})
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
  noteLostMembers()
  // Counted here, once per graph, because the status line reads it on every camera frame. See
  // componentCount.
  componentCount = countComponents()
  extentDrawn = -1
}

/** Compares each group's membership with what it was, and remembers whoever left unasked.
 *
 * A departure this panel asked for -- a Remove, an Ungroup, a move into another group -- is
 * expected and spends its entry here. See lostMembers.
 *
 * A GROUP THAT VANISHED ENTIRELY IS THE LOUDEST CASE, NOT THE ONE TO SKIP. This used to
 * `continue` on it, reasoning that the group's own panel is gone with it and there is nowhere to
 * put the note -- which made the one detector in this file unable to fire on the single most
 * likely way a person loses grouping work. Two files carrying `@featurelab:group pumpkins
 * expanded Pumpkins`, VS Code's own Format Document over each, save: the formatter re-encodes
 * through JSON.parse/stringify, comments do not survive that, and a group lives in a comment.
 * Groups drawn before: one. After: none -- status line unchanged, no notice anywhere, and no undo
 * entry, because this panel did not write it and cannot put it back. Formatting a JSON file is a
 * completely ordinary thing to do.
 *
 * So it is reported like any other lost member, by name, on the canvas -- which is the one
 * surface left when the thing that would have carried the note is what went missing. */
function noteLostMembers(): void {
  const now = new Map<string, readonly string[]>()
  for (const group of groupsView.groups) now.set(group.id, group.memberIds)
  const vanished: { name: string; members: readonly string[] }[] = []
  for (const [groupId, was] of lastMembership) {
    const still = now.get(groupId)
    if (still === undefined) {
      // An ungroup or a remove-the-last-member this panel ASKED for leaves every member in
      // expectedDepartures, exactly as a partial departure does, and spends them the same way.
      // Anything left is a group that went without being asked.
      const asked = was.every((id) => expectedDepartures.has(id))
      for (const id of was) expectedDepartures.delete(id)
      if (!asked) vanished.push({ name: lastGroupNames.get(groupId) ?? groupId, members: was })
      continue
    }
    const present = new Set(still)
    for (const id of was) {
      if (present.has(id)) continue
      if (expectedDepartures.delete(id)) continue
      const list = lostMembers.get(groupId) ?? []
      if (!list.includes(id)) list.push(id)
      lostMembers.set(groupId, list)
    }
  }
  // Whatever is left in expectedDepartures is a write still in flight, and is deliberately kept:
  // a graph can arrive for an unrelated reason between the ask and the answer. A write the host
  // REFUSED clears it, where it is already known that no graph is coming (see `editError`).
  lastMembership = now
  lastGroupNames = new Map(groupsView.groups.map((g) => [g.id, g.name]))
  if (vanished.length > 0) noteVanishedGroups(vanished)
}

/** Says, by name, which groups are gone and which features were in them.
 *
 * NAMES THE MEMBERS, not just the group. "Pumpkins is gone" is a fact somebody can already see;
 * the list of ids is what tells them which files to look in, and -- because a formatter rewrote
 * those files whole -- which files their editor's own undo has to reach. This panel's Undo
 * deliberately does not offer to fix it: it did not write the change, so it has nothing to put
 * back, and a button claiming otherwise would be worse than the silence it replaces. */
function noteVanishedGroups(vanished: readonly { name: string; members: readonly string[] }[]): void {
  const named = vanished.map((v) => `"${v.name}" (${v.members.join(', ')})`).join('; ')
  const one = vanished.length === 1
  const text =
    `${one ? 'The group' : 'The groups'} ${named} ${one ? 'is' : 'are'} gone from this pack: ` +
    `${one ? 'its' : 'their'} @featurelab:group directive is no longer in any of those files. ` +
    'A group is written in a comment, and anything that rewrites a JSON file through a parser -- ' +
    "VS Code's own Format Document does -- drops every comment in it. This panel did not make the " +
    "change and cannot put it back; the text editor's own Undo in those files can."
  setBannerNote('lost-groups', { text, level: 'warning' })
  setStatus(`${one ? 'The group' : 'The groups'} ${named} ${one ? 'is' : 'are'} no longer in this pack.`, 'error')
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

// The engine's own pack-level warnings, as the host forwards them. Only the empty state reads
// them, and only to tell "a new pack" apart from "the wrong folder" -- a directory that is not a
// pack root loads with zero features, zero rules and zero diagnostics, and used to be greeted
// with an invitation to create its first feature there. An older host sends no such field, so
// this stays an empty list and the empty state answers exactly as it always did.
let packWarnings: readonly string[] = []
/** What the engine says it READ off disk, and what it refused, as of the last message that
 * carried it.
 *
 * Kept beside packWarnings and read the same defensive way, because it answers the same question
 * better: the warnings tell a missing directory from an empty one, and this tells a pack whose
 * files were refused from a pack that has none -- by name, with the line and column, rather than
 * by counting diagnostics and guessing. A host that does not send it leaves this empty, and
 * emptyState.ts falls back to exactly the sentences it wrote before. */
let packContents: EmptyStatePackContents = {}

/** The contents block off a message, if it sent one. Shape-checked rather than cast: this is the
 * one input to the empty state that comes from outside the panel, and the empty state's whole job
 * is to be right on the day something else is wrong. */
function readPackContents(message: unknown): EmptyStatePackContents | null {
  const sent = (message as { packContents?: unknown }).packContents
  return typeof sent === 'object' && sent !== null ? (sent as EmptyStatePackContents) : null
}

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
  // "Error: " IS PART OF THE SENTENCE, not a style on it. The error state used to be a colour
  // and only a colour -- and for a long time not even that, because `.flg-status-error` (0-1-0)
  // was losing to `#flg-status`'s own `color` (1-0-0) and a refusal rendered pixel-identical to
  // "Saved." in both themes. The selector is fixed in graph.css, but a one-line region that is
  // read out by a live region and distinguished by hue alone is still a region where a refusal
  // and a progress note sound the same. The word goes in the text, where a screen reader, a
  // screenshot and a colour-blind reader all get it.
  statusHost!.textContent = kind === 'error' ? `Error: ${text}` : text
  statusHost!.className = kind === 'error' ? 'flg-status flg-status-error' : 'flg-status'
  // Anything said through here is a message with a moment attached -- a refusal, a write in
  // flight, a count of what a filter left. The camera must not overwrite it on the next pan; see
  // statusIsExtent. setExtentStatus turns the flag back on for the one sentence that may.
  statusIsExtent = false
}

/** The sentence in the middle of the canvas when there is nothing drawn on it, or null to take
 * it away.
 *
 * An empty canvas is what a pack with nothing in it looks like, and it is also what a broken
 * editor, a pack that failed to load and a webview whose script never ran all look like. The
 * status line alone is not enough: it is one line of small text at the bottom edge, which is
 * exactly where somebody who thinks the editor is broken is not looking. So the canvas says it
 * itself, in the middle, in words.
 *
 * textContent, never innerHTML: this text can carry an engine message, which can carry a
 * feature identifier out of somebody's pack. */
function setEmptyState(text: string | null): void {
  const host = document.getElementById('flg-empty')
  if (host === null) return
  if (text === null) {
    host.hidden = true
    host.textContent = ''
    return
  }
  const line = document.createElement('span')
  line.textContent = text
  host.replaceChildren(line)
  host.hidden = false
}

// ---------------------------------------------------------------------------
// The standing notes over the canvas
// ---------------------------------------------------------------------------

/** WHY THERE IS A SECOND PLACE ON THE CANVAS FOR WORDS.
 *
 * `setEmptyState` answers the canvas that drew NOTHING. Three separate reports are the opposite
 * shape -- the canvas drew confidently, the status line agreed with it, and the fact that would
 * have changed the reader's mind was on no surface at all:
 *
 *   - Run Format Document over two files carrying a group directive and every group in the pack
 *     is gone. The formatter re-encodes through JSON.parse/stringify, which drops comments, which
 *     is where a group lives. Groups drawn before: one. After: none, status line unchanged, no
 *     notice, and no undo entry because this panel did not write it. Formatting a JSON file is an
 *     ordinary thing to do, so this is the likeliest way somebody loses grouping work.
 *   - Reopen a panel whose saved selection has since been deleted or renamed and the selection is
 *     dropped, correctly, while the camera it belonged to is restored anyway -- pointing at a
 *     hole, with the name of the thing that is missing nowhere on the page.
 *   - Move a pack's features/ away and the graph draws the feature rules and the references they
 *     dangle at: 3 cards of 57, under "Showing the whole graph."
 *
 * None of them fit the status line, which is one line that the camera is entitled to overwrite on
 * the next pan (see statusIsExtent). These are STANDING conditions: true until something changes
 * them, and each one is about the drawing, so they go over the drawing.
 *
 * Every note is dismissible and each dismissal is remembered against the note's TEXT, so a redraw
 * does not resurrect one somebody has read, and a note that says something new is shown again. */
type BannerId = 'lost-groups' | 'dead-selection' | 'empty-kind'

interface BannerNote {
  readonly text: string
  readonly level: 'warning' | 'error'
}

const bannerNotes = new Map<BannerId, BannerNote>()
/** Note id -> the exact text that was dismissed. */
const bannerDismissed = new Map<BannerId, string>()

/** Puts a note on the canvas, or takes one off. */
function setBannerNote(id: BannerId, note: BannerNote | null): void {
  if (note === null) bannerNotes.delete(id)
  else bannerNotes.set(id, note)
  renderBanner()
}

function renderBanner(): void {
  const host = document.getElementById('flg-banner')
  if (host === null) return
  const shown = [...bannerNotes.entries()].filter(([id, note]) => bannerDismissed.get(id) !== note.text)
  if (shown.length === 0) {
    host.replaceChildren()
    host.hidden = true
    return
  }
  host.replaceChildren(
    ...shown.map(([id, note]) => {
      const box = notice(note.text, note.level)
      box.classList.add('flg-banner-note')
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'flg-tool flg-banner-dismiss'
      dismiss.textContent = 'Got it'
      dismiss.title = 'Stop showing this. Nothing is written either way, and nothing about the pack changes.'
      dismiss.addEventListener('click', () => {
        bannerDismissed.set(id, note.text)
        renderBanner()
      })
      box.append(dismiss)
      return box
    }),
  )
  host.hidden = false
}

/** Draws the graph and frames it, but only frames it the FIRST time: a refresh after an edit
 * must not throw away the camera someone positioned, which is the difference between a live
 * editor and a page that reloads. */
let framed = false
function draw(): void {
  if (!graph) return
  view.render(graph, positions, frames)
  // Both are facts about what was just drawn, so both are forgotten here and re-asked on demand.
  extentFitsAll = null
  extentDrawn = -1
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
 *
 * AND WHEN THE COMPONENT ITSELF DOES NOT FIT, WHICH IS EVERY REAL PACK. The rule above has a
 * corner it fell off. When the largest component needs a zoom well below READABLE_ZOOM, the
 * readable zoom is used anyway -- correctly, a smudge is not a view -- and the camera was then put
 * at the TOP-LEFT CORNER OF ITS BOUNDING BOX. A bounding box corner is not a place: the card with
 * the smallest x and the card with the smallest y are two different cards, usually thousands of
 * units apart, and the corner between them is empty. Measured, at four pack sizes, cards actually
 * on screen after opening: 57 nodes -> 12, 600 -> 11, 1500 -> 2, 3531 -> ZERO. The editor opened a
 * real pack on a blank canvas and said "Showing one of 41 separate groups" underneath it.
 *
 * So the camera landed on the DENSEST SCREENFUL of that component instead (`densestScreenful`) --
 * the place where there is most to look at. It is still one drawing, still at a zoom where the
 * text can be read; what changed is that the first thing anybody sees is cards.
 *
 * AND THE DENSEST SCREENFUL IS NOT WHAT ANYBODY CAME FOR. That rule answers "is there anything
 * here" and nothing else, and on a real pack the answer it gives is a wall: the 3531-node pack
 * opens on a slab of near-identical `pack:feature_2503` cards, every one a leaf, with no visible
 * reason for any of them to be there. Dense is the WORST place to start reading a delegation
 * graph -- the interesting structure is at the entry points, where one rule fans out into the
 * things it places, and the sidebar is at that moment offering exactly that list under
 * "Starts here".
 *
 * So it opens on a ROOT: a feature nothing delegates to, the same set `graph.roots` puts in the
 * sidebar and the same place the layout is built to be read from. Which root is still chosen for
 * density -- the one whose own screenful holds the most cards (`openingRoot`) -- so this narrows
 * where the old rule aimed rather than replacing one bad frame with another: the camera lands on
 * a thing somebody can start reading from, with the rest of a screenful around it, instead of in
 * the middle of a crowd of leaves. The dense screenful remains the fallback for a component with
 * no root in it at all (every node in a cycle, which a pack can genuinely be).
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
  const centres: { x: number; y: number }[] = []
  for (const id of component) {
    const at = positions.get(id)
    if (!at) continue
    minX = Math.min(minX, at.x)
    minY = Math.min(minY, at.y)
    maxX = Math.max(maxX, at.x + GRAPH_NODE_WIDTH)
    maxY = Math.max(maxY, at.y + GRAPH_NODE_HEIGHT)
    centres.push({ x: at.x + GRAPH_NODE_WIDTH / 2, y: at.y + GRAPH_NODE_HEIGHT / 2 })
  }
  if (!Number.isFinite(minX) || centres.length === 0) return

  const box = canvasHost!.getBoundingClientRect()
  const margin = 48
  const fit = Math.min((box.width - margin) / (maxX - minX), (box.height - margin) / (maxY - minY))
  const zoom = Math.max(READABLE_ZOOM, Math.min(fit, 1))

  if (fit >= zoom) {
    // The whole component is on screen at this zoom. Anchored on its top-left rather than its
    // centre: a drawing read left to right starts at the left, and centring a component taller
    // than the viewport would cut off the roots, which are the entry points and the only place a
    // reader can start. The corner is safe here precisely because everything is inside the frame.
    view.setCamera({ zoom, x: minX - margin / 2 / zoom, y: minY - margin / 2 / zoom })
    return
  }

  // It does not fit. Land on an entry point, and on the entry point with the most around it.
  const vw = box.width / zoom
  const vh = box.height / zoom
  // SCORED AGAINST EVERY CARD, not only this component's. What a reader sees out of the window is
  // whatever is drawn there, and a neighbouring component half a screen away is on screen whether
  // or not it belongs to the drawing that was chosen -- the old rule already framed them that
  // way. The ROOT is still taken from the component; only the counting is wider.
  const everyCentre: { x: number; y: number }[] = []
  for (const at of positions.values()) everyCentre.push({ x: at.x + GRAPH_NODE_WIDTH / 2, y: at.y + GRAPH_NODE_HEIGHT / 2 })
  // TWO CANDIDATE FRAMES, AND THE ROOT ONE HAS TO EARN IT.
  //
  // An entry point is where reading starts, so a root-anchored frame is preferred -- but it used
  // to be preferred UNCONDITIONALLY, with the densest screenful reached for only when the
  // component had no root at all. That is a rule with a viewport baked into it, and it fails at
  // the viewports nobody measured. The frame is the CANVAS, not the window -- the inspector
  // column is a fixed 320px -- so a 900x700 panel gives the drawing 580px, which is two and a
  // half cards across. Measured on the 600-node pack, card centres inside the frame the aim
  // chooses:
  //
  //     canvas 1280x940 (window 1600x1000)   root frame 18   densest 36
  //     canvas  780x740 (window 1100x800)    root frame  2   densest 19
  //     canvas  580x640 (window  900x700)    root frame  2   densest 12
  //
  // The run-up in front of the entry point (OPENING_FRAMES' `lead`) and the band of layout above
  // or below it are a fixed FRACTION of the frame, so they cost the same share everywhere -- but
  // what is left over stops being a screenful once the frame is small, and the rule went on
  // spending it. Two cards is the defect the opening budget exists to catch, arrived at by the
  // aim rather than by the snap.
  //
  // So the two candidates are scored the same way, on the same cards, and the root frame is taken
  // unless it is markedly emptier than what is actually available. The test is a SHARE rather
  // than a count, which is what makes it mean the same thing at every size: "nearly as full as it
  // gets" does not need to know how full that is.
  const grid = centreGrid(everyCentre, vw, vh)
  const rooted = openingRoot(component, grid, vw, vh)
  const dense = densestScreenful(everyCentre, vw, vh)
  const at =
    rooted !== null && rooted.n >= countCentresIn(grid, dense.x, dense.y, vw, vh) * OPENING_ROOT_MIN_SHARE ? rooted.at : dense
  view.setCamera({ zoom, x: at.x, y: at.y })
  // AND THEN LINE THE FRAME UP WITH WHAT IS IN IT. densestScreenful answers "where is there
  // something to look at" and has no opinion about where the edges of the screen fall, so they
  // fell mid-card: nineteen cards intersecting the 57-node fixture's opening view and only eleven
  // of them whole, five sharing a left edge 48px outside the frame, each missing the start of the
  // identifier that says which feature it is. The snap moves the frame to the nearest real
  // boundary of whatever it was cutting -- see render.ts's snapCameraToWholeCards.
  view.snapCameraToWholeCards()
}

/** Where the opening root's card is put in the frame, as fractions of the viewport.
 *
 * NOT CENTRED, and the difference is a third of a screen's worth of cards. This layout is built
 * to be read left to right -- a root is on the left and everything it delegates to is to the
 * right of it -- so a root in the middle of the frame spends the whole left half on the empty
 * space UPSTREAM of an entry point, which by definition has nothing in it. Measured on a 57-card
 * shelf-packed graph with a single root: six cards on screen centred, ten with the root set near
 * the left edge. `lead` is a small run-up rather than flush, so the card does not read as cut off
 * by the window.
 *
 * `band` is where the card sits vertically, and there are three of them because a root's subtree
 * is as often above or below it as level with it -- the layout stacks siblings, and a root at the
 * top of a tall fan sees none of it when the frame is centred on the root itself. All three keep
 * the entry point on screen and on the left; the fullest is taken, and the centred one is listed
 * first so it wins a tie. */
const OPENING_FRAMES: readonly { lead: number; band: number }[] = [
  { lead: 0.12, band: 0.5 },
  { lead: 0.12, band: 0.25 },
  { lead: 0.12, band: 0.75 },
]

/** The camera position that frames `at`'s card as an entry point under one of OPENING_FRAMES. */
function frameForRoot(at: { x: number; y: number }, vw: number, vh: number, frame: { lead: number; band: number }): { x: number; y: number } {
  return { x: at.x - vw * frame.lead, y: at.y + GRAPH_NODE_HEIGHT / 2 - vh * frame.band }
}

/** Where to put the camera so the reader lands on an entry point of `component`, or null when it
 * has none -- the camera's own top-left, in world units, ready for setCamera.
 *
 * A ROOT, which is this editor's word for a feature nothing else delegates to -- read off the
 * same `graph.roots` the sidebar heads with under "Starts here", so the camera and the sidebar
 * cannot disagree about where a pack begins. Restricted to the component being framed, because
 * the whole point of choosing a component was that nothing arrives from off screen.
 *
 * AND THE ONE WITH THE MOST AROUND IT, which is what keeps this from trading one bad opening for
 * another. A root is where reading starts, but on a shelf-packed layout plenty of roots are a
 * lone card with one child and a screen of nothing beside it -- and "the editor opens on the pack
 * rather than beside it" is a promise with a number on it (scale.test.ts: at least eight cards on
 * screen, against the two and the zero the bounding-box corner used to produce). So every
 * candidate frame is scored by how many cards fall inside it (`OPENING_FRAMES`, `frameForRoot`),
 * and the fullest wins. The scan is in a fixed order and only a STRICTLY fuller frame displaces
 * the one it is holding, so one pack always opens in one place.
 *
 * COUNTED THROUGH A GRID, not by a pass over the component per root. `centres` is bucketed into
 * half-viewport cells once, and each root then looks at only the cells its own screenful can
 * reach -- at most sixteen -- testing the points in them exactly. That is what keeps this linear
 * enough to sit on the open path of a 3531-card pack; the honest quadratic answer is roots x
 * cards, and this pack has hundreds of the first and thousands of the second. */
function openingRoot(
  component: ReadonlySet<string>,
  grid: CentreGrid,
  vw: number,
  vh: number,
): { at: { x: number; y: number }; n: number } | null {
  if (!graph) return null

  let best: { id: string; at: { x: number; y: number }; n: number } | null = null
  for (const id of graph.roots) {
    if (!component.has(id)) continue
    const at = positions.get(id)
    if (!at) continue
    for (const frame of OPENING_FRAMES) {
      // THE FRAME THAT WOULD ACTUALLY BE USED, not a window centred on the card: scoring one
      // rectangle and then showing a different one is how a "densest" rule ends up picking a
      // frame that is not dense.
      const { x: left, y: top } = frameForRoot(at, vw, vh, frame)
      const n = countCentresIn(grid, left, top, vw, vh)
      if (best === null || n > best.n) best = { id, at: { x: left, y: top }, n }
    }
  }
  return best === null ? null : { at: best.at, n: best.n }
}

/** How full a root-anchored opening frame has to be, as a share of the fullest frame available at
 * all, before being preferred to that one.
 *
 * THE POINT OF A SHARE. Every constant in this camera used to be a count, and a count is a
 * statement about one viewport: a rule tuned where a screenful is eighteen cards says nothing
 * about a canvas where it is two, and duly failed there. See the call site for the measurements,
 * and render.ts's SNAP_LEADING_FULL_CAPACITY for the same lesson learnt on the snap that follows
 * it. A share needs no such tuning.
 *
 * Three fifths, which keeps the entry point whenever the two frames are comparable and gives it up
 * when the root is standing on its own beside the pack -- the case above, where the root frame
 * held a ninth of what was available. */
const OPENING_ROOT_MIN_SHARE = 0.6

/** Card centres bucketed into half-viewport cells, so a frame can be scored by looking at the few
 * cells it reaches rather than at every card. Built once per opening and shared by both
 * candidates, which is also what makes their scores comparable at all. */
interface CentreGrid {
  readonly cells: ReadonlyMap<string, { x: number; y: number }[]>
  readonly cw: number
  readonly ch: number
}

function centreGrid(centres: readonly { x: number; y: number }[], vw: number, vh: number): CentreGrid {
  const cw = Math.max(1, vw / 2)
  const ch = Math.max(1, vh / 2)
  const cells = new Map<string, { x: number; y: number }[]>()
  for (const p of centres) {
    const key = `${String(Math.floor(p.x / cw))}:${String(Math.floor(p.y / ch))}`
    const cell = cells.get(key)
    if (cell === undefined) cells.set(key, [p])
    else cell.push(p)
  }
  return { cells, cw, ch }
}

/** How many card centres fall inside the frame at `left`/`top`. At most sixteen cells are looked
 * at, and the points in them are tested exactly. */
function countCentresIn(grid: CentreGrid, left: number, top: number, vw: number, vh: number): number {
  let n = 0
  for (let gx = Math.floor(left / grid.cw); gx <= Math.floor((left + vw) / grid.cw); gx++) {
    for (let gy = Math.floor(top / grid.ch); gy <= Math.floor((top + vh) / grid.ch); gy++) {
      for (const p of grid.cells.get(`${String(gx)}:${String(gy)}`) ?? []) {
        if (p.x >= left && p.x <= left + vw && p.y >= top && p.y <= top + vh) n++
      }
    }
  }
  return n
}

/** The top-left corner, in world units, of the `vw` x `vh` window with the most cards in it.
 *
 * WHY A HISTOGRAM AND NOT A SEARCH. The honest answer -- try a window anchored at every card and
 * keep the best -- is quadratic, and this runs on the open path for a pack of three and a half
 * thousand cards. So the plane is cut into HALF-viewport cells, every card is dropped into one
 * (one pass), and the best 2x2 block of adjacent cells is taken: a 2x2 block of half-cells is
 * exactly one viewport, so every block considered is a window that really could be framed. It is
 * an approximation -- an optimal window can straddle three half-cells in a direction and no block
 * holds all of it -- and that is accepted, because the question being answered is "is there
 * anything here", not "which pixel is densest". Two passes, one map, no sorting.
 *
 * The window is then CENTRED on the mean position of the cards in the winning block rather than
 * hung off the block's own corner. The block is a grid artefact and its corner is arbitrary; the
 * cards inside it are the thing the camera is being aimed at, and a cluster sitting in one corner
 * of its cell would otherwise be framed with three quarters of a screen of nothing beside it. */
function densestScreenful(centres: readonly { x: number; y: number }[], vw: number, vh: number): { x: number; y: number } {
  const cw = Math.max(1, vw / 2)
  const ch = Math.max(1, vh / 2)
  const cells = new Map<string, { n: number; sx: number; sy: number }>()
  for (const p of centres) {
    const key = `${String(Math.floor(p.x / cw))}:${String(Math.floor(p.y / ch))}`
    const cell = cells.get(key)
    if (cell === undefined) cells.set(key, { n: 1, sx: p.x, sy: p.y })
    else {
      cell.n++
      cell.sx += p.x
      cell.sy += p.y
    }
  }

  let best: { n: number; sx: number; sy: number } | null = null
  for (const key of cells.keys()) {
    const [left, top] = key.split(':')
    const cx = Number(left)
    const cy = Number(top)
    let n = 0
    let sx = 0
    let sy = 0
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const cell = cells.get(`${String(cx + dx)}:${String(cy + dy)}`)
        if (cell === undefined) continue
        n += cell.n
        sx += cell.sx
        sy += cell.sy
      }
    }
    if (best === null || n > best.n) best = { n, sx, sy }
  }

  // Unreachable while `centres` is non-empty -- every card put at least one cell in the map -- but
  // a camera is not the place to find that out, so the first card stands in.
  if (best === null || best.n === 0) {
    const first = centres[0] ?? { x: 0, y: 0 }
    return { x: first.x - vw / 2, y: first.y - vh / 2 }
  }
  return { x: best.sx / best.n - vw / 2, y: best.sy / best.n - vh / 2 }
}

/** What the status line says about how much of the graph is on screen, AS OF NOW.
 *
 * It is a sentence about the camera, so every word of it is recomputed from the camera. The old
 * one was computed once, when the pack loaded, from the number of connected components alone --
 * "Showing one of 22 separate groups. Fit shows them all." -- and then never again. It was
 * therefore wrong the moment anybody moved: still wrong after a pan, still wrong after a zoom,
 * and most visibly wrong right after pressing the Fit it was recommending, which had just put all
 * 22 groups on screen.
 *
 * IT COUNTS WHAT IS ON SCREEN, AND NOTHING ELSE. It used to count `nodesDrawn` -- the cards the
 * renderer has ATTACHED, which is the viewport grown half a screen per side, about four times its
 * area -- and hedged the difference with the word "about". The hedge did not cover it. On the
 * 57-node fixture the line said "about 22" over a screen holding seventeen cards, ten of them
 * readable; on a 3531-node pack it said "about 79" over sixteen. And because the kept set is only
 * recomputed when the viewport leaves the band it was computed for, a viewport that SHRINKS never
 * leaves it: eight notches of zoom in, ending on a screen with nothing whole on it, and the line
 * still said "about 22 of 57".
 *
 * So it reads `nodesInView`, which render.ts recomputes from the camera on every frame, and it
 * states the number plainly. An honest count that stops being true is worse than no count at all,
 * which is why graphRender.test.ts pins the number to the camera rather than to the cull band. */
/** CARDS, not features, and the word is load-bearing.
 *
 * This line counts what is DRAWN, and what is drawn is every card on the canvas: the rules,
 * the dangling references the pack points at, the stand-in a collapsed group draws as. The
 * overview a few pixels above it counts FEATURES, which deliberately excludes all three (see
 * overviewPanel). Calling both of them features put two different numbers for the same word on
 * one screen -- 22 of 57 here against 55 there, 3446 against 3531 at pack size -- and a reader
 * can only conclude that one of them is wrong.
 *
 * They are not made to agree, because they are not the same question. What is on screen cannot
 * be reported as a count of features without either lying about the rules that are drawn or
 * walking the visible set to classify it on every camera frame. Naming them honestly is free.
 */
function describeExtent(): string {
  if (!graph) return ''
  const total = graph.nodes.length
  if (total === 0) return 'This pack has nothing to draw.'
  const drawn = Math.min(view.getRenderStats().nodesInView, total)
  const groups = componentCount
  const spread = groups > 1 ? ` The pack is ${String(groups)} separate groups.` : ''
  if (drawn >= total) {
    const whole = groups > 1 ? `Showing all ${String(total)} cards, in ${String(groups)} separate groups.` : 'Showing the whole graph.'
    // "The whole graph" is a claim about the GRAPH and was being read as a claim about the pack.
    // With features/ moved away the engine still reads feature_rules/, so the graph is three
    // nodes, every one of them is on screen, and the most confident sentence in the panel said
    // so -- for 57 cards' worth of pack. The graph is still whole; what it is the whole OF is
    // the part that was missing. See packContents.describeEmptyGraphKinds, which is what put the
    // note on the canvas this points at.
    return partialPack ? `${whole} That is the whole of what loaded -- see the note on the canvas.` : whole
  }
  // A zoom deep enough to push every card off the edges is a real state and says so, rather than
  // reporting "0 of 3531" as though it were a count of something.
  // "in this pack" was the one branch that broke the rule above it: `total` is the number of CARDS
  // in this drawing, and naming it the pack put a card count next to the overview's feature count
  // under the same word again. It counts what is drawn, so it says what is drawn.
  if (drawn === 0) return `No cards are on screen. This graph draws ${String(total)}; Fit shows ${groups > 1 ? 'what it can' : 'them all'}.`
  // "Fit shows them all" is a PROMISE, so it is only made when the view says it can keep it. On a
  // pack that needs a zoom below the floor where a card still paints, fit frames the largest
  // component and says so (GraphFitReport.fitsAll), and repeating the promise there would be the
  // same lie in a different place.
  const fits = fitsAllNow() ? ' Fit shows them all.' : ' Fit shows as much as can be drawn at once.'
  return `Showing ${String(drawn)} of ${String(total)} cards.${spread}${fits}`
}

/** How many separate drawings the current graph is, counted ONCE when it arrives.
 *
 * Cached rather than counted on demand because the line it feeds is now recomputed whenever the
 * camera moves, and a breadth-first walk of every edge on every frame of every pan is exactly the
 * per-frame whole-graph pass the rest of this editor spent its effort removing. It is a fact about
 * the GRAPH, and the graph does not change when the camera does. */
let componentCount = 0

/** Whether the engine read NO file at all of one of the kinds this graph is drawn from, as of the
 * last graph. Read by describeExtent, so the one sentence that claims completeness stops claiming
 * it the moment the pack cannot support the claim. */
let partialPack = false

/** Whether Fit would really put everything on screen, asked ONCE per drawing for the same reason
 * componentCount is counted once: getFitReport walks every component and measures the canvas, and
 * the answer is a fact about the drawing and the panel rather than about where the camera is
 * pointed. The one thing that can change it without a redraw is the panel being resized, and a
 * stale "Fit shows them all" for the moments between a drag of the window edge and the next
 * redraw is a far smaller lie than the one this whole change is removing.
 *
 * LAZY, and that is not micro-optimisation. getFitReport walks every component and measures the
 * canvas -- a forced layout -- and the sentence only needs it in the branch where something is off
 * screen. Computing it eagerly after each render put that walk on the path between a file being
 * written and the panel being rebuilt from the graph that came back, which is a path with a real
 * race on the end of it: two journeys that act the moment the file lands started catching the
 * panel still holding its previous model. Nothing the status line says is worth widening that
 * window. `null` means "not asked yet for this drawing". */
let extentFitsAll: boolean | null = null

function fitsAllNow(): boolean {
  if (extentFitsAll === null) extentFitsAll = view.getFitReport().fitsAll
  return extentFitsAll
}

/** Whether the status line is currently showing `describeExtent()` rather than something somebody
 * needs to read.
 *
 * The camera moves under errors, confirmations and "Deleting x..." as freely as it moves under
 * nothing at all -- a pan while a refusal is on screen is an ordinary thing to do -- and a status
 * line that rewrote itself on every frame would take those away mid-sentence. So the extent line
 * is the only thing that repaints itself, and only while it is what is there. */
let statusIsExtent = false

/** How many cards were on screen when the line was last written. The camera fires every frame of
 * every gesture and the sentence only changes when this number does, so this is what stops a pan
 * rewriting the same string sixty times a second. */
let extentDrawn = -1

/** Re-states the extent, if the extent is what the line is saying. Bound to the view's camera.
 *
 * KEPT CHEAP ON PURPOSE. It runs inside the view's own animation frame, beside the transform, so
 * everything it does is paid on every frame of every pan: one counter read, one integer compare,
 * and on the frames where the count really moved, one string. Nothing here may walk the graph --
 * see componentCount for the pass that used to be here and where it went instead. */
function refreshExtentStatus(): void {
  if (!statusIsExtent || !graph) return
  const drawn = view.getRenderStats().nodesInView
  if (drawn === extentDrawn) return
  extentDrawn = drawn
  const text = describeExtent()
  if (statusHost !== null && statusHost.textContent !== text) statusHost.textContent = text
}

/** Says how much of the graph is on screen, and marks the line as re-statable. */
function setExtentStatus(): void {
  extentDrawn = view.getRenderStats().nodesInView
  setStatus(describeExtent())
  statusIsExtent = true
}

/** How many separate drawings this graph is. A pack whose features are mostly unreferenced is
 * dozens of them, and saying so is what stops the opening view looking like the whole pack. */

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

  // WHERE TO START COMES FIRST, AHEAD OF WHAT IS WRONG.
  //
  // The problems used to lead, and on a real pack that is three stacked warning boxes -- 27
  // dangling references, 17 the game provides, 4 loops -- before a word about the pack itself.
  // Measured on the 3531-node pack at the shipped panel width: "Starts here" began at y=523 of a
  // 696px column with 165px of it scrolled off the bottom, so the first list a newcomer can act
  // on was the one they could not see. They did not open the editor to read a fault report; they
  // opened it to look at a pack, and the roots are the only list that answers "where do I look".
  //
  // The diagnostics lose nothing by moving down. They are still here, still first among the
  // problems, and the ones attached to a file are repeated on that node's own panel (see
  // renderInspector), which is nearer the key they are about than this column ever was.
  if (graph.roots.length > 0) {
    wrap.append(sectionLabel('Starts here'))
    const shown = graph.roots.slice(0, 12)
    const list = jumpList(`Starts here: ${String(shown.length)} of ${String(graph.roots.length)} features nothing else delegates to`)
    for (const id of shown) list.append(listItem(jumpTo(id)))
    wrap.append(list)
    if (graph.roots.length > 12) wrap.append(hint(`and ${graph.roots.length - 12} more`))
  }

  // The author's own brackets around the pack, each one a click away. Listed after the roots
  // because a group is a way of reading the pack, and the roots are where reading starts.
  if (groupsView.groups.length > 0) {
    wrap.append(sectionLabel('Groups'))
    const shown = groupsView.groups.slice(0, 12)
    const list = jumpList(`Groups: ${String(shown.length)} of ${String(groupsView.groups.length)} brackets this pack's author put round its features`)
    for (const group of shown) list.append(listItem(groupJump(group.id)))
    wrap.append(list)
    if (groupsView.groups.length > 12) wrap.append(hint(`and ${groupsView.groups.length - 12} more`))
  }

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
    const shown = unresolved.slice(0, 8)
    const list = jumpList(`${String(shown.length)} reference${shown.length === 1 ? '' : 's'} pointing at a feature this pack does not define`)
    for (const node of shown) list.append(listItem(jumpTo(node.id, 'flg-jump-unresolved')))
    wrap.append(list)
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
  // With the group list itself moved above the problems, its warnings stay down here with the
  // other problems rather than travelling with it: a malformed group directive is a fault, and
  // the list of groups is navigation.
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
  // "Ores (1)" is what the remains of a group look like in this list, and it read exactly like a
  // group somebody meant to have one member in it. The count was already right; what was missing
  // is that a bracket round one thing is not a bracket. Said in the face rather than in the
  // tooltip because this list is scanned, not hovered.
  const lone = group !== undefined && group.memberIds.length === 1
  const face = group ? `${group.name} (${String(group.memberIds.length)}${lone ? ', on its own' : ''})` : groupId
  button.textContent = face
  button.title = group
    ? `${group.collapsed ? 'Collapsed' : 'Expanded'} group of ${String(group.memberIds.length)}: ${group.memberIds.join(', ')}` +
      (lone ? '\nDown to one member. The others were deleted, or their directives were removed.' : '')
    : ''
  // The face is the whole of the accessible name's beginning, which is what keeps "click the
  // thing that says X" true for anybody driving this by voice; what the press DOES is added
  // after it, because a bare name in a list of bare names says nothing about what pressing it
  // is for. See jumpTo for the same shape.
  button.setAttribute(
    'aria-label',
    group
      ? `${face}. ${group.collapsed ? 'Collapsed' : 'Expanded'} group of ${String(group.memberIds.length)}. Go to it on the canvas.`
      : `${face}. Go to it on the canvas.`,
  )
  button.addEventListener('click', () => revealGroup(groupId))
  return button
}

/** A named list of jump buttons.
 *
 * The overview's three lists -- the roots, the groups, the dangling references -- were runs of
 * loose buttons under a heading that was bound to nothing: read out of order, or out of the
 * accessibility tree, "wiki:ceiling_slab_block" arrived with no indication of which of the three
 * questions it was an answer to. A named list says so once, for every row in it. */
function jumpList(name: string): HTMLElement {
  const list = document.createElement('div')
  list.className = 'flg-jump-list'
  list.setAttribute('role', 'list')
  list.setAttribute('aria-label', name)
  return list
}

/** One row of a `jumpList`. `display: contents`, so the wrapper is a fact about the
 * accessibility tree and changes nothing about the layout: the button is still a direct flex
 * child of the overview column as far as CSS is concerned. */
function listItem(child: HTMLElement): HTMLElement {
  const item = document.createElement('div')
  item.className = 'flg-listitem'
  item.setAttribute('role', 'listitem')
  item.append(child)
  return item
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
  // The id first, so the visible text is the start of the accessible name, then what pressing it
  // does. An id on its own is the name of a thing, not a description of a control; a list of
  // twelve of them announced nothing but twelve names.
  button.setAttribute(
    'aria-label',
    extraClass === 'flg-jump-unresolved'
      ? `${id}. Not defined in this pack. Go to what refers to it.`
      : `${id}. Go to this feature on the canvas.`,
  )
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
  setStatus(`${id} is inside the collapsed group "${group.name}". Expand it to see the card.`)
  return true
}

/** Moves the keyboard into the inspector, onto the first control it can actually be used on.
 *
 * NEVER OVER AN EDIT IN FLIGHT. `renderInspector` holds and restores the focus -- and, since a
 * later fix, the uncommitted VALUE and the caret with it -- whenever the panel it is rebuilding
 * is the one already on screen. So if anything inside the sidebar has the keyboard by the time
 * this runs, that restore is what put it there, and taking it away would be this function
 * undoing the very mechanism that exists to stop the panel stealing somebody's half-typed
 * number. Searching for the node you are already editing is exactly that case.
 *
 * Returns whether it moved. Nothing depends on the answer today; it is there so a caller that
 * wants to say something when the panel has no controls at all can. */
function focusInspector(): boolean {
  if (sideHost === null) return false
  if (sideHost.contains(document.activeElement)) return false
  const candidates = sideHost.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex]')
  for (const el of candidates) {
    if (el.hasAttribute('disabled') || el.hidden || el.tabIndex < 0) continue
    // `offsetParent` is null for anything display:none, which is how the panel hides a collapsed
    // section's contents -- a control in one of those is a stop nobody can see.
    if (el.offsetParent === null) continue
    el.focus()
    return true
  }
  return false
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
/** Repaints the edge panel in place, or null when one is not on screen. Set by edgePanel.
 *
 * In place, and not by rebuilding: a new graph arriving while somebody is typing in the
 * expression must not take the control out of the document, which is the caret. */
let edgeRepaint: (() => void) | null = null

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

/** The one-slot cache's key: which edge, and which of its two Molang slots.
 *
 * ONE SPELLING, because there are now two callers -- the cache itself and the re-seed that runs
 * when a new graph arrives -- and the second one was written with a different separator. It
 * compared equal to nothing, so the re-seed silently did not happen and the data loss it exists
 * to prevent went on happening, with a passing-looking guard in the way. The separator is NUL
 * for the reason it is everywhere else in this file: a feature id and a JSON path may both
 * contain anything a person can type, and a separator they can type is not a separator. */
function edgeEditorKeyFor(edge: { from: string; jsonPath: string }, field: MolangEdgeField): string {
  return `${edge.from} ${edge.jsonPath} ${field}`
}

/** The Molang editor for one edge's slot, from the one-slot cache.
 *
 * Shared by the edge panel and by a node's own panel, which draws the same editor for a scatter's
 * `iterations` inside its distribution section. One editor, so one draft: a value typed in either
 * place is the value the other shows, and there is never a second copy of the count to disagree
 * with the first. The sidebar shows one panel at a time, which is what makes one slot enough. */
function edgeEditorFor(edge: GraphEdgeWire, slot: { field: MolangEdgeField; value: string | null; path: string }): MolangEdgeEditor {
  const key = edgeEditorKeyFor(edge, slot.field)
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
      // NO ENGINE VALIDATOR, and this is a statement about the engine rather than a shortcut.
      // `featurelab serve` dispatches loadPack, reloadFile, generate, generateGrown, regenerate,
      // renameFeature, deleteFeature, createFiles, applyEdits, annotate, annotateBatch, graph,
      // types, environments and atlas. Not one of them compiles a Molang expression, so there is
      // no method to call: a validator wired here would be a request the engine answers with
      // "unknown method", and an editor that reported THAT beside every expression would be
      // worse than the silence it replaced.
      //
      // What fills the gap until that method exists is molangHints.structuralProblems -- brackets,
      // quotes, trailing operators, a string used as a number -- which are the checks whose answer
      // does not depend on the pack and so cannot be wrong for a reason the engine would know
      // about. The two things genuinely needing the engine, "this reads a name nothing writes"
      // and "this is what it evaluates to at your origin", are still unanswered and still say so
      // by being absent rather than by being guessed at.
      { validator: { validate: async () => ({}) }, schedule: (run) => (run(), () => {}) },
    )
    edgeEditorKey = key
    return edgeEditor
  }
  // THE CACHED EDITOR IS RE-SEEDED, EVERY TIME.
  //
  // This is the whole of the fix for a silent overwrite. The cache is keyed by edge and field and
  // never looked at the value again, so an editor built when the file said `14` went on saying
  // `14` after a text-editor save, an undo or another panel's write made the file say `999` --
  // while the chip on the very same edge, rebuilt from the new graph, read `999` correctly. One
  // keystroke in the box then posted `142` and the 999 was gone, with nothing said. See
  // MolangEdgeEditor.reseed for what happens when the box is dirty; it is not "the file wins".
  edgeEditor.reseed(slot.value)
  return edgeEditor
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
    // The diagnostics themselves are the FIELD's now, drawn under the box with their long form
    // and their actions -- see MolangFieldOptions.problems. They used to be flattened to one
    // line each here, which is how `detail`, `span` and every `actions` entry the editor has
    // ever produced came to be computed, tested and never drawn.
    //
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
  // is what the PANEL owns: turning the editor's change events into the host messages that
  // actually touch the file.
  const field = createMolangField(editor, {
    label: slot.field === 'iterations' ? 'iterations' : 'condition',
    onChanged: paint,
    fill: true,
    problems: true,
    // What the last profiled run measured about THIS key, under the key. It was nowhere on this
    // panel at all: the edge panel is the one place in the editor with a real expression editor
    // in it and it was the one place the engine's answer to "why did this place nothing" never
    // reached.
    engineNote: () => stopNoteFor(edge.from, slot.field),
  })
  edgeField = field
  host.append(field.element, problems)
  paint()
  // The panel repaints itself when a NEW GRAPH arrives for the edge it is showing -- see the
  // `graph` message handler, which reseeds this editor rather than rebuilding the panel around
  // the caret.
  edgeRepaint = () => {
    field.refresh()
    paint()
  }

  listenToEdgeEditor(editor, edge, slot)

  return host
}

/** What the last profiled run said about one node's own Molang key, in nodeStats.ts's words.
 *
 * `iterations_zero` and `condition_false` are the two stop reasons that ARE this expression --
 * "iterations = 0 (from 0.1251)" is the engine answering the question the box is asking. It was
 * being drawn 389px up the panel, above Places / Used by / Delegates to, and on the edge panel
 * not at all. */
function stopNoteFor(nodeId: string, field: MolangEdgeField): string | null {
  if (!runWire?.profile || runTotals === null) return null
  const row = nodeRunStats(runWire.profile, nodeId, runOptions(), runTotals)
  const want = field === 'iterations' ? 'iterations_zero' : 'condition_false'
  const stop = row.stops.find((s) => s.reason === want)
  return stop === undefined ? null : describeStop(stop).label
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
        setStatus('This card has no file to write to.', 'error')
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
  return [{ key: 'iterations', editor, engineNote: () => stopNoteFor(nodeId, 'iterations') }]
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
  // And for a held eject, which is a question about one edit to one node. Walking away from it
  // abandons the edit -- which is the safe half of the answer, and the half that costs nothing.
  if (pendingEject !== null && (selection === null || selection.kind !== 'node' || selection.nodeId !== inspectorNode)) {
    pendingEject = null
  }
  // A held multi-selection delete is a question about a LIST. Changing the list answers it.
  if (pendingMultiDelete !== null && (selection === null || selection.kind !== 'nodes' || !sameIds(selection.nodeIds, pendingMultiDelete))) {
    pendingMultiDelete = null
  }
  // WHERE THE KEYBOARD IS, noted before the panel is emptied.
  //
  // Everything below takes the inspector's element out of the document and puts it back, and
  // a focused control that is removed leaves the keyboard on <body>. That happens on every
  // redraw, and a redraw follows every edit -- so committing a value with Tab ended with the
  // focus outside the sidebar altogether, and the next Tab landed on the rename box at the top
  // of the form. Tuning five numbers on one feature meant five trips back to the mouse.
  //
  // Only for the panel that is about to be REUSED. A selection that moved somewhere else took
  // the keyboard with it deliberately, and putting it back would be this panel taking focus
  // from wherever its reader actually went.
  if (inspector !== null && selection !== null && selection.kind === 'node' && selection.nodeId === inspectorNode) {
    inspector.holdFocus()
  }
  // The edge panel is about to go, whatever replaces it. A repaint hook pointing at a control
  // that is no longer in the document would paint into nothing on the next graph.
  edgeRepaint = null
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

  // The eject question, above the form whose control raised it, for the same reason.
  if (pendingEject !== null) sideHost!.append(ejectConfirmPanel(pendingEject))

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
    // Put back in the document BEFORE it is updated, because update() redraws the form and
    // then puts the keyboard back into it -- and focus cannot be given to an element that is
    // not in the document yet.
    sideHost!.append(inspector.element)
    inspector.setLineage(lineageOf(selection.nodeId))
    inspector.update(form, edgeFields)
    return
  }
  inspector?.dispose()
  inspector = createNodeInspector(form, {
    lineage: lineageOf(selection.nodeId),
    onNavigate: (id) => {
      revealNode(id)
    },
    // No `nodeId`. The identifier is already in the lifecycle bar's rename box directly above,
    // and that is the copy that can do something with it; a heading repeating it a line later was
    // the same string twice in the narrowest column on screen.
    file,
    // The documentation panel fills the canvas rather than floating over it. Without a host it
    // positions itself `fixed` from the measured host box, which works and is one resize away
    // from not working.
    docsHost: canvasHost ?? undefined,
    edgeFields,
    // "Show the JSON", offered beside "Use the file's version" and "Keep mine" when a file changes
    // underneath a box somebody is typing in. The other two resolve the conflict without a host;
    // this one needs one, and without it the button was drawn and did nothing.
    //
    // It opens the node's own FILE. The host's `openFile` resolves a node id to a document (see
    // graphPanel.ts's openNodeFile) and takes no position, so the path is not yet used to put the
    // caret on the row -- the reader lands in the right file with the conflict still on screen
    // beside it, which is the question they were asking. Naming the node rather than a path also
    // keeps the panel's standing rule: the webview names things, the host resolves them.
    onRevealJson: () => {
      vscode.postMessage({ type: 'openFile', nodeId: selection.nodeId })
    },
    onChange: (change) => onInspectorChange(file, typeId, change),
  })
  inspectorNode = selection.nodeId
  sideHost!.append(inspector.element)
}

/** WHERE ONE NODE SITS IN THE CHAIN, as the inspector's lineage strip wants it.
 *
 * Built from `graph.edges` on every selection rather than kept as an index: a selection happens
 * at human speed and the pack's 4,580 edges are one flat pass, so an index would be a second copy
 * of the graph to keep in step with the first for no measurable gain.
 *
 * Parallel edges between the same pair COLLAPSE to one row carrying a count. A scatter that
 * places the same feature four times is four edges and one relationship, and four identical rows
 * would be four identical destinations -- which reads as a bug in the list rather than as a fact
 * about the pack. */
function lineageOf(nodeId: string): NodeLineage | undefined {
  if (!graph) return undefined
  const collect = (pick: (edge: GraphEdgeWire) => string | null): LineageEntry[] => {
    const byId = new Map<string, { id: string; kind: string; count: number }>()
    for (const edge of graph!.edges) {
      const other = pick(edge)
      if (other === null) continue
      const seen = byId.get(other)
      if (seen === undefined) byId.set(other, { id: other, kind: edge.kind, count: 1 })
      else {
        seen.count++
        // Two kinds between one pair is real and rare; naming neither is better than naming one.
        if (seen.kind !== edge.kind) seen.kind = 'mixed'
      }
    }
    return [...byId.values()].map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      count: entry.count,
      title: `${entry.id}\n${entry.count === 1 ? `one ${entry.kind} delegation` : `${String(entry.count)} ${entry.kind} delegations`}. Click to go there.`,
    }))
  }
  return {
    parents: collect((edge) => (edge.to === nodeId ? edge.from : null)),
    children: collect((edge) => (edge.from === nodeId ? edge.to : null)),
  }
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

/** The toolbar's `Add` button, so its `aria-expanded` can be flipped from wherever the menu is
 * actually opened and closed rather than guessed at from the click that opened it.
 *
 * DECLARED HERE, ABOVE THE TOOLBAR BUILDER, and not down beside `menu` where it is also read.
 * This module does its work at top level: the toolbar is built while the module is still
 * evaluating, so a `let` further down the file is still in its temporal dead zone when the
 * builder assigns to it, and the whole panel dies on load with nothing drawn. */
let addButton: HTMLButtonElement | null = null

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
  // THE ONE-WAY DOOR, asked about before it is walked through.
  //
  // Editing the body of a node that belongs to a collapsed compound -- the compound itself, or
  // any of the features it generated -- discards the recorded parameters and leaves a plain
  // graph. Nothing can put them back: they are not in the JSON, and re-adding the annotation
  // does not recover them. src/graph/compounds/collapse.ts has carried `classifyEdit` for
  // exactly this moment, with the comment "this is what the command layer asks before it decides
  // whether to prompt" -- and the command layer never asked. What the panel did instead was
  // print an amber paragraph next to the form and then let the first keystroke through, which is
  // a warning in the same sense that a sign is a lock.
  //
  // So: classified first, and an ejecting edit is HELD, not sent, until somebody says yes.
  if (inspectorNode !== null && compoundView !== null) {
    const consequence = classifyEdit(compoundView, { what: 'node-body', identifier: inspectorNode })
    if (consequence.effect === 'eject') {
      pendingEject = { warning: consequence.warning, send: () => sendInspectorEdits(file, typeId, change), label: change.label }
      renderInspectorFor(inspectorNode)
      setStatus(`${change.label} would turn ${consequence.identifier} back into ordinary cards. Confirm below.`, 'error')
      return
    }
  }
  sendInspectorEdits(file, typeId, change)
}

/** The write itself, separated from the question so that answering the question "yes" replays
 * exactly the edit that raised it rather than a reconstruction of it. */
function sendInspectorEdits(file: string, typeId: string, change: InspectorChange): void {
  vscode.postMessage({
    type: 'applyEdits',
    file,
    // The sentence the author would use for what they just did -- "Set iterations to 3" -- which
    // is the one Undo offers back to them. Without it the host has to fall back on a generic
    // phrase, and an undo stack of "Undo edit" five times deep is a stack nobody dares use.
    label: change.label,
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
  // A SENTENCE, because this is the confirmation somebody's FIRST edit gets.
  //
  // It used to be `setStatus(change.label)`, and change.label is a field name: type 2 into
  // `extent` and press Enter and the status line read "extent 2". No verb, no file, no tense --
  // nothing saying whether that was a request, a result or a refusal -- and with the host still
  // writing, nothing else on the panel moved either: measured at +5.6 s with the field still
  // editable and no spinner anywhere. Every neighbouring path in this file already says a
  // sentence ("Writing extent...", "Renaming x to y...", "Deleting x...", "Creating x as y..."),
  // so this one says one too, and names the file, which is the part the reader cannot see.
  // The host answers with `saved` the moment the bytes land; see the message handler.
  setStatus(`Writing ${change.label} to ${file}...`)
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
  if (keep) toolbarHost!.prepend(keep)

  // ONE button, not one per compound.
  //
  // There used to be a labelled row of them -- Loop, Steps, Placement guard, Column -- and every
  // single one opened the SAME menu at the same place: the full category list, nothing
  // preselected, no trace of which button had been pressed. Four buttons that differ in their
  // label and in nothing else are four promises the menu then breaks, and the reviews read them
  // as broken rather than as shortcuts. (Reviewers counted five, because two comments in this
  // file still described a compound called `switch` that CompoundKind has not had for some time.
  // There were four buttons and there are four compounds.)
  //
  // The menu itself is what reviewers liked: it has categories, coverage counts and a search box,
  // and Patterns -- the compounds -- is its first category. So the honest control is one button
  // that opens it.
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'flg-add'
  add.textContent = ADD_BUTTON_LABEL
  add.title = `Add a feature, a placement rule, or one of the ${String(COMPOUND_KINDS.length)} patterns. Right-clicking the canvas opens the same menu where you clicked.`
  // THE CARET IS NOT ENOUGH ON ITS OWN. "Add ▾" says "this opens something" to a reader who
  // can see the glyph; to anything reading the accessibility tree it was a plain button with no
  // hint that a dialog was about to take the focus, and nothing that ever changed when one did.
  // `aria-haspopup="dialog"` matches what actually opens (palette.ts's root is role="dialog"),
  // and `aria-expanded` is driven from the menu's own open/close so the two can never disagree.
  add.setAttribute('aria-haspopup', 'dialog')
  add.setAttribute('aria-expanded', 'false')
  addButton = add
  add.addEventListener('click', (event) => {
    // The toolbar is a shortcut into the same menu, not a second way to create things: one
    // path means one set of rules about what may be created and why something is refused.
    if (!ensureMenu(packFormatVersion())) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    menu?.openAt({ x: rect.left, y: rect.bottom + 2 })
    add.setAttribute('aria-expanded', menu?.isOpen() === true ? 'true' : 'false')
  })
  toolbarHost!.append(add)

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
    // The host remembers it per pack. Posted from the CLICK rather than from
    // setPreviewOnSelect, because that function is also how the host's own answer is applied
    // and a panel that echoed it would write back what it had just been told.
    vscode.postMessage({ type: 'previewOnSelect', value: previewOnSelect })
    const selection = view.getSelection()
    if (previewOnSelect && selection && selection.kind === 'node') previewFor(selection.nodeId)
  })
  previewToggle = link
  setPreviewOnSelect(previewOnSelect)
  toolbarHost!.append(link)

  toolbarHost!.append(historyHost())
  renderHistory()

  const fit = document.createElement('button')
  fit.type = 'button'
  fit.className = 'flg-tool'
  fit.textContent = 'Fit'
  // Two words on a button is not a description of what it does to the view. It had no tooltip at
  // all, next to controls carrying four hundred characters of it.
  // CARDS, the same word the status line beside it uses (see describeExtent). A button that
  // promises "every node" over a line that counts "cards" asks the reader to decide whether the
  // two are the same thing.
  fit.title = 'Zoom out until every card is on screen at once.'
  fit.addEventListener('click', () => view.zoomToFit())
  toolbarHost!.append(fit)
}

/** The label on the one creation button. The caret says it opens something rather than doing
 * something, which is the entire difference between this and a button that creates a node. */
export const ADD_BUTTON_LABEL = 'Add \u25be'

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** What Undo and Redo would do, by name, as the host last said.
 *
 * THE HOST WAS ALREADY SENDING ALL OF THIS AND THE PANEL THREW IT AWAY. `postHistory` has always
 * posted `{type:'history', undo, redo}` after every write and every history move, and `undone` and
 * `redone` after each one lands -- three messages the dispatcher had no branch for. Meanwhile the
 * toolbar read "Clear / Add / Preview on select / Fit", so the only route to an undo was a
 * keybinding over a canvas that never mentioned it, and the only confirmation that one had
 * happened was the graph quietly changing. Every edit here writes a file with no save step; an
 * editor like that has to show its history. */
let historyState: { undo: string | null; redo: string | null } = { undo: null, redo: null }

/** The entry an undo has refused over, or null. Set from the host's refusal (see historyStep) and
 * cleared the moment the history moves at all, because a refusal is about one entry on one stack
 * and both change together. */
let historyBlocked: string | null = null

/** Whether this panel is one that has been open on this pack before -- set by the arrival of a
 * saved view from the host. See renderHistory for the one sentence it buys. */
let revived = false

/** Whether the reader has dismissed the "the journal starts over" line. Per session and nowhere
 * else: it is a note about THIS session's history, so remembering it across sessions would be
 * remembering it across the only thing it is about. */
let revivedNoteDismissed = false

/** The toolbar's history control, created once and refilled. Its own element so `renderHistory`
 * can update the labels without rebuilding the toolbar, which would take the caret out of the
 * search box beside it. */
function historyHost(): HTMLElement {
  const existing = document.getElementById('flg-history')
  if (existing) return existing
  const host = document.createElement('div')
  host.id = 'flg-history'
  host.className = 'flg-history'
  // THREE SLOTS, AND THE MIDDLE ONE IS NEVER REPLACED.
  //
  // The label is a live region (see renderHistory), and a live region only announces when its
  // OWN contents change -- a region that is torn down and rebuilt on every redraw is a new
  // region every time, and a new region says nothing. So the element that carries `aria-live`
  // is created once, here, and every later render writes its `textContent`. The buttons around
  // it are rebuilt freely because they are not live; they sit in wrappers that are
  // `display: contents`, so the flex row is laid out exactly as it was when all four children
  // were direct.
  const buttons = document.createElement('span')
  buttons.id = 'flg-history-buttons'
  buttons.className = 'flg-history-slot'
  const line = document.createElement('span')
  line.className = 'flg-history-label'
  line.id = HISTORY_LABEL_ID
  line.setAttribute('role', 'status')
  line.setAttribute('aria-live', 'polite')
  const extras = document.createElement('span')
  extras.id = 'flg-history-extras'
  extras.className = 'flg-history-slot'
  // The fourth child, and the only one that is not on the row: it is positioned under the pair
  // (graph.css), because the toolbar is one line high and a second line inside it would push the
  // canvas down every time this note appeared. See renderHistory.
  const note = document.createElement('span')
  note.id = 'flg-history-note'
  host.append(buttons, line, extras, note)
  return host
}

/** Draws the pair and the line that says what they are about.
 *
 * The labels are NOT on the buttons. "Undo" is what the control does and the entry's own sentence
 * -- 'Collapsing "Markers".' -- is what it would do it to, and putting the second on the face of
 * the button gives a control whose width changes on every edit, in a toolbar. So the buttons stay
 * two words wide, the sentence goes in the line beside them and in the tooltip, and a disabled
 * button says in its tooltip why it is disabled. */
function renderHistory(): void {
  const host = historyHost()
  const buttons = host.querySelector<HTMLElement>('#flg-history-buttons')!
  const extras = host.querySelector<HTMLElement>('#flg-history-extras')!
  buttons.replaceChildren()
  extras.replaceChildren()

  // THE LINE IS WRITTEN, NOT REBUILT, BECAUSE THE BUTTONS POINT AT IT.
  //
  // "Undo" announced as "Undo" and nothing else. What it would actually put back --
  // `distribution.x: 3` -- lived in a `title`, which a screen reader may or may not read
  // depending on the user's verbosity settings, and in this span, which was next to the buttons
  // on screen and attached to nothing in the accessibility tree. `aria-describedby` makes the
  // sentence part of each button's own description, so "Undo, distribution.x: 3" is what the
  // control is called wherever it is read.
  //
  // And it is a LIVE REGION, because the fact it carries changes without anybody touching it:
  // typing in an inspector field writes a file, which pushes an entry, which flips this line
  // from "Nothing to undo" to the name of what was just written. That transition was completely
  // silent. `polite` rather than `assertive`: it is a report about something the reader just
  // did, not an interruption.
  const line = host.querySelector<HTMLElement>(`#${HISTORY_LABEL_ID}`)!
  const said = historyState.undo === null ? 'Nothing to undo' : historyState.undo
  // Written only when it actually differs, so a redraw that changes nothing does not announce
  // the same sentence again.
  if (line.textContent !== said) line.textContent = said
  line.title = said

  const undo = document.createElement('button')
  undo.type = 'button'
  undo.className = 'flg-tool flg-history-undo'
  undo.textContent = 'Undo'
  // `aria-disabled`, NOT `disabled`. A disabled button is not in the tab order, so the state
  // this pair is in most of the time -- nothing to redo -- was a control the keyboard could not
  // reach in order to be told why. The button stays reachable, says it is unavailable, explains
  // it in its tooltip, and refuses the click below.
  setUnavailable(undo, historyState.undo === null)
  undo.setAttribute('aria-describedby', HISTORY_LABEL_ID)
  undo.title =
    historyState.undo === null
      ? // WORD FOR WORD what the journal raises for the same state (changeJournal.ts's
        // NOTHING_TO_UNDO), because Ctrl+Z reaches that empty stack by the other road and a panel
        // that describes one state two ways describes two states. Copied rather than imported:
        // this bundle has no `node:fs`, so the pair is pinned by changeJournal.test.ts instead.
        'Nothing this panel has written is waiting to be put back.'
      : `Put back: ${historyState.undo} (Ctrl+Z)`
  undo.addEventListener('click', () => {
    if (historyState.undo === null) return
    vscode.postMessage({ type: 'undo' })
  })

  const redo = document.createElement('button')
  redo.type = 'button'
  redo.className = 'flg-tool flg-history-redo'
  redo.textContent = 'Redo'
  setUnavailable(redo, historyState.redo === null)
  redo.setAttribute('aria-describedby', HISTORY_LABEL_ID)
  redo.title =
    historyState.redo === null
      ? // changeJournal.ts's NOTHING_TO_REDO, for the reason the Undo tooltip above gives.
        'Nothing has been undone here yet.'
      : `Do again: ${historyState.redo} (Ctrl+Shift+Z)`
  redo.addEventListener('click', () => {
    if (historyState.redo === null) return
    vscode.postMessage({ type: 'redo' })
  })

  buttons.append(undo, redo)

  // The way out of a refusal that will never stop being one. Offered only after the host has said
  // so, never in advance: this is not a second undo button, it is the answer to a sentence the
  // author has just read. See ChangeJournal.drop.
  if (historyBlocked !== null) {
    const forget = document.createElement('button')
    forget.type = 'button'
    forget.className = 'flg-tool flg-history-forget'
    forget.textContent = 'Skip this step'
    forget.title =
      `Leave "${historyBlocked}" out of the history, so Undo can reach what came before it. ` +
      'Nothing is written and nothing is put back.'
    forget.addEventListener('click', () => {
      vscode.postMessage({ type: 'forgetUndo' })
    })
    extras.append(forget)
  }

  renderHistoryNote(host)
}

/** The line under the buttons on a panel that has been open on this pack before.
 *
 * WHAT IT IS FOR. The journal lives in the panel, so it starts over when the panel does. Before a
 * reload Undo reads "Put back: places_block: block name (Ctrl+Z)"; after one it is
 * `aria-disabled` and reads "Nothing to undo" -- which is pixel-for-pixel what a panel that has
 * never written anything says, while the edit it is no longer offering to put back is still
 * sitting on disk. Two completely different situations, one appearance, and the appearance is the
 * reassuring one: the reader is told there is nothing to undo at the exact moment there is
 * something they might want to.
 *
 * It is not a bug in the journal and this does not pretend to fix one. Re-offering entries whose
 * files may have been edited by three other hands since the reload is how "cannot be undone: X
 * has changed since then" becomes the ordinary case. What was missing was the SENTENCE, and one
 * line is enough for it.
 *
 * Shown only when both halves are true: the panel was revived AND the journal is empty. Once
 * anything is written this session the line is about nothing and goes. */
function renderHistoryNote(host: HTMLElement): void {
  const note = host.querySelector<HTMLElement>('#flg-history-note')
  if (note === null) return
  const wanted = revived && historyState.undo === null && historyState.redo === null && !revivedNoteDismissed
  if (!wanted) {
    note.replaceChildren()
    note.hidden = true
    return
  }
  const line = document.createElement('span')
  line.className = 'flg-history-note-text'
  line.textContent =
    'This panel reopened, so its Undo list starts over. Edits made here before the reload are ' +
    "already saved in the files -- open the file and use the editor's own Undo to reach them."
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'flg-tool flg-history-note-dismiss'
  dismiss.textContent = 'Got it'
  dismiss.title = 'Stop showing this for the rest of this session. Nothing is written either way.'
  dismiss.addEventListener('click', () => {
    revivedNoteDismissed = true
    renderHistory()
  })
  note.replaceChildren(line, dismiss)
  note.hidden = false
}

/** The id the history buttons point their `aria-describedby` at. One line, one id: there is only
 * ever one history control in the toolbar. */
const HISTORY_LABEL_ID = 'flg-history-label'

/** Marks a control unavailable without taking it out of the tab order.
 *
 * `disabled` is the wrong tool for a control whose whole job, while unavailable, is to be found
 * and to explain itself: it removes the element from the tab order and from the accessibility
 * tree's interactive set, so a keyboard reader tabbing along the toolbar simply never meets it.
 * `aria-disabled` keeps it reachable and announced as dimmed; graph.css draws it with a dashed
 * border rather than the 50% opacity it used to use, which measured 2.67:1 in Light Modern. */
function setUnavailable(el: HTMLElement, unavailable: boolean): void {
  if (unavailable) el.setAttribute('aria-disabled', 'true')
  else el.removeAttribute('aria-disabled')
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
/** A box about the pack, at one of three levels.
 *
 * THE LEVEL IS A WORD, NOT A BORDER COLOUR. The three used to differ by the hue of a 2px stripe
 * and by nothing else: a reader who cannot name the hue -- or who is reading a screenshot, or
 * listening -- got three identical boxes. The marker is ordinary text inside the box, so it is
 * announced, copied and searched with the rest of the sentence; graph.css widens and doubles the
 * stripe by level as well, so the three are still distinguishable with the colour removed. Info
 * gets no word: it is the unmarked case, and "Info: " in front of every neutral sentence is
 * noise rather than a signal. */
function notice(text: string, level: 'info' | 'warning' | 'error'): HTMLElement {
  const el = document.createElement('div')
  el.className = `flg-notice flg-notice-${level}`
  const word = NOTICE_MARK[level]
  if (word !== undefined) {
    const mark = document.createElement('span')
    mark.className = 'flg-notice-mark'
    mark.textContent = `${word}: `
    el.append(mark)
  }
  el.append(document.createTextNode(text))
  return el
}

/** The word each level puts in front of its sentence. */
const NOTICE_MARK: Partial<Record<'info' | 'warning' | 'error', string>> = {
  warning: 'Warning',
  error: 'Error',
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

/** The directives this panel has asked for and not yet seen come back, in the order it asked.
 * Empty whenever nothing is in flight, which is almost always -- see withDirectives, which
 * says what they are for and what they are deliberately NOT for. */
let sentGroupOps: readonly AnnotateOp[] = []

/** Nodes this panel has asked to take out of a group and not yet seen leave. Consumed by
 * noteLostMembers, which is about the departures nobody asked for. */
const expectedDepartures = new Set<string>()

/** What each group held the last time a graph arrived, so the next one can be compared with it. */
let lastMembership = new Map<string, readonly string[]>()

/** What each group was CALLED the last time a graph arrived.
 *
 * Kept beside the membership because a group that has gone takes its name with it, and a note
 * reading `pumpkins is gone` -- the slug -- is a note about something the author never typed. The
 * name is what they wrote in the directive and what the sidebar said back to them. */
let lastGroupNames = new Map<string, string>()

/** Group id -> members that have vanished from it without this panel asking, newest last.
 *
 * LOSING A MEMBER WAS INVISIBLE. Deleting a feature that was in a group is refused for undo by
 * name, correctly and loudly -- and then the group's panel simply read "Members (1)" where it had
 * read "Members (2)", with nothing anywhere saying which one had gone or that anything had. The
 * same silence covered a file deleted outside the editor, and a directive somebody took out by
 * hand. A group is a statement the author wrote down; a statement that quietly loses a clause is
 * worse than one that fails loudly. */
const lostMembers = new Map<string, string[]>()

/** Sends a plan to the host, or says why there is none. Every group change goes through here:
 * one batch message, one status line, one thing to select when it comes back.
 *
 * Returns whether anything was sent, so a control that asked for the plan can tell a write from a
 * refusal without re-deriving the plan to look at it.
 *
 * THE LABEL IS THE PLAN'S OWN SUMMARY. Without it the host wrote "Annotate 2 file(s)" into the
 * journal, and that string then became the name of the operation everywhere it is ever said
 * again: the Undo command in the palette, the undo button's tooltip, and -- worst -- the refusal
 * sentence, where "\"Annotate 2 file(s)\" cannot be undone: .../rng_marker.json has changed since
 * then" is a sentence about nothing the author did. `plan.summary` is already the author's own
 * words for it ("Collapsing \"Markers\"."), and it was already computed. */
function applyGroupPlan(plan: GroupPlan, select: 'group' | 'none' = 'group'): boolean {
  if (!plan.ok) {
    setStatus(plan.reason, 'error')
    return false
  }
  if (plan.ops.length === 0) return false
  pendingGroupSelect = { groupId: select === 'group' ? plan.groupId : null }
  sentGroupOps = [...sentGroupOps, ...plan.ops]
  // Departures this panel ASKED for, so the graph that comes back is not read as a group that
  // lost members behind the author's back. See noteLostMembers.
  for (const id of plan.moved) expectedDepartures.add(id)
  for (const id of plan.leaving) expectedDepartures.add(id)
  vscode.postMessage({ type: 'annotateBatch', ops: plan.ops, label: plan.summary })
  setStatus(plan.moved.length > 0 ? `${plan.summary} ${plan.moved.join(', ')} moved from another group.` : plan.summary)
  return true
}

/** The graph plans are made against: the last one drawn, plus the directives already asked
 * for. Never null once a graph has arrived; the empty graph is what a plan refuses over
 * before then. */
function planGraph(): GroupGraph {
  const drawn = (groupSource ?? { nodes: [], edges: [], roots: [] }) as unknown as GroupGraph
  return withDirectives(drawn, sentGroupOps)
}

/** The groups plans are made against -- the drawn ones while nothing is in flight, which is
 * the same object, and the ones this panel has asked for while something is. Read here rather
 * than kept beside groupsView: what is DRAWN must go on being the graph the host sent, and
 * two views of the same groups that both get drawn from is the bug this is fixing. */
function planGroups(): GroupsView {
  return sentGroupOps.length === 0 ? groupsView : readGroups(planGraph())
}

/** A name box and the ONE way to spend what is in it.
 *
 * `commit` is exported alongside the element because every other control that means "use this
 * name" has to go through it rather than reading `.value` and planning its own write. A button
 * beside the box that did that posted a SECOND batch -- the click blurs the input, the blur
 * commits, and then the handler committed the same text again against a graph that already had
 * the first write folded into it, so the second batch carried a different group id and overwrote
 * the first one in every member's file. See createGroupForm. */
interface NameInput {
  readonly el: HTMLInputElement
  /** Spends the box's contents, once. `explicit` marks a press of a button whose label says what
   * it does, which is the one case where an empty box deserves an answer rather than silence. */
  commit(explicit?: boolean): void
}

/** A one-line text input that commits on Enter and on blur, and restores itself on Escape. The
 * shape both the group name and the new-group name use.
 *
 * `onCommit` RETURNS WHETHER THE NAME WAS SPENT, and the box only closes itself when it was. It
 * used to latch shut before asking: type an invalid name, read the refusal, correct it, press
 * Enter -- and nothing happened, because `done` had been set on the way into the refused attempt
 * and every later press returned early. The box kept the good text, the status line kept the old
 * refusal, and the only way out was to select the group again. A refusal is not a completion. */
function nameInput(initial: string, label: string, onCommit: (value: string) => boolean, onCancel?: () => void): NameInput {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'flg-input flg-group-name'
  input.value = initial
  input.placeholder = 'Group name'
  input.spellcheck = false
  input.setAttribute('aria-label', label)
  let done = false
  const commit = (explicit = false): void => {
    if (done) return
    const next = input.value.trim()
    if (next === '') {
      input.value = initial
      // A button whose label is "Group" must not do nothing in silence. The plan's own refusal is
      // the sentence -- "A group needs a name." -- so it is asked for rather than written twice.
      if (explicit) onCommit('')
      return
    }
    if (next === initial) {
      input.value = initial
      return
    }
    // Latched only once the write is actually on its way. See the header.
    if (onCommit(next)) done = true
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
  input.addEventListener('change', () => {
    commit()
  })
  return { el: input, commit }
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

/** What was copied, as the data a new file is written from rather than as a reference.
 *
 * Copied nodes survive the graph they came from: deleting the original after a copy must not
 * turn the paste into a silent no-op, and re-reading the fields at paste time is how it would. */
let clipboard: readonly { typeId: string; fields: Record<string, unknown> }[] = []

/** The selection whose "Delete" has been pressed once and not yet confirmed.
 *
 * ASKING IS NOT OPTIONAL HERE. Deleting one feature already asks whenever anything delegates to
 * it; deleting twenty-nine at once is a bigger action with a smaller gesture behind it, and the
 * panel has no undo of its own to fall back on. The host is growing a confirmation of its own --
 * when it lands, this is the call site that should defer to it. Until then, the panel asks, in
 * the shape the two questions beside it already use. */
let pendingMultiDelete: readonly string[] | null = null

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** The selected nodes that are real files this editor can write -- what every action below
 * actually operates on.
 *
 * A marquee catches whatever is under it, including the three kinds of node that are not a file:
 * a dangling reference, a feature the GAME provides, and a collapsed group's card. Acting on
 * those is not possible, and quietly including them in a count is how "12 duplicated" comes back
 * as nine files. */
function writableSelection(nodeIds: readonly string[]): { id: string; typeId: string; fields: Record<string, unknown> }[] {
  const out: { id: string; typeId: string; fields: Record<string, unknown> }[] = []
  for (const id of nodeIds) {
    const node = graph?.nodes.find((n) => n.id === id)
    if (!node || node.unresolved || node.external || node.group) continue
    // A placement rule's file is rooted at a different key from its node's type and its body is
    // not the node's fields, so writing one from here would write a file the engine refuses.
    if (node.typeId === undefined || node.typeId === 'minecraft:feature_rule') continue
    out.push({ id, typeId: node.typeId, fields: node.fields ?? {} })
  }
  return out
}

/** Says how many of the selection an action left alone, or '' when it took all of them. */
function skippedNote(nodeIds: readonly string[], taken: number): string {
  const skipped = nodeIds.length - taken
  if (skipped === 0) return ''
  const isAre = skipped === 1 ? 'is' : 'are'
  const wasWere = skipped === 1 ? 'was' : 'were'
  return ` ${String(skipped)} of the selection ${isAre} not a file this editor writes, and ${wasWere} left alone.`
}

/** Writes copies of `entries` as new files, in ONE message.
 *
 * One message, not one per node: the other end is a file write and a refresh, and N of those is
 * N redraws of a graph that is only finished after the last one. */
function createCopiesOf(
  entries: readonly { typeId: string; fields: Record<string, unknown> }[],
  verb: string,
  from: readonly string[],
  // Imperative, because this one is read in the Undo menu rather than in the status line: "Undo
  // Duplicating 5 features" is not a sentence anybody writes.
  undoLabel: string,
): void {
  if (entries.length === 0) {
    setStatus('Nothing in the selection is a file this editor can copy.', 'error')
    return
  }
  const formatVersion = packFormatVersion() ?? '1.21.10'
  // Names are reserved as they are handed out. freeIdentifier only knows what the GRAPH is using,
  // and the graph does not yet contain any of the files this batch is about to write -- so
  // without this every duplicate in one batch proposes the same name.
  const taken = new Set<string>()
  const files = entries.map((entry) => {
    const identifier = freeIdentifier(entry.typeId.replace('minecraft:', '').replace(/_feature$/, ''), taken)
    taken.add(identifier.toLowerCase())
    return { path: featureFilePath(identifier), contents: featureFileContents(entry.typeId, identifier, formatVersion, entry.fields) }
  })
  vscode.postMessage({ type: 'create', files, label: `${undoLabel} ${String(files.length)} feature${files.length === 1 ? '' : 's'}` })
  setStatus(`${verb} ${String(files.length)} feature${files.length === 1 ? '' : 's'}.${skippedNote(from, files.length)}`)
}

/** The row of things to do to all of them. */
function multiActionRow(nodeIds: readonly string[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'flg-confirm-buttons flg-multi-actions'

  const writable = writableSelection(nodeIds)

  const duplicate = document.createElement('button')
  duplicate.type = 'button'
  duplicate.className = 'flg-tool flg-multi-duplicate'
  duplicate.textContent = 'Duplicate'
  duplicate.title = `Write ${String(writable.length)} new feature file${writable.length === 1 ? '' : 's'} with the same settings and new names. Nothing that delegates to the originals is re-pointed at the copies.`
  duplicate.disabled = writable.length === 0
  duplicate.addEventListener('click', () => {
    createCopiesOf(writable, 'Duplicating', nodeIds, 'Duplicate')
  })
  row.append(duplicate)

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'flg-tool flg-multi-copy'
  copy.textContent = 'Copy'
  copy.title = 'Remember these features, so Paste can write them again. Copying writes nothing.'
  copy.disabled = writable.length === 0
  copy.addEventListener('click', () => {
    clipboard = writable.map((entry) => ({ typeId: entry.typeId, fields: entry.fields }))
    setStatus(`Copied ${String(clipboard.length)} feature${clipboard.length === 1 ? '' : 's'}.${skippedNote(nodeIds, clipboard.length)}`)
    renderInspector(view.getSelection())
  })
  row.append(copy)

  const paste = document.createElement('button')
  paste.type = 'button'
  paste.className = 'flg-tool flg-multi-paste'
  paste.textContent = 'Paste'
  paste.title =
    clipboard.length === 0
      ? 'Nothing has been copied yet.'
      : `Write ${String(clipboard.length)} new feature file${clipboard.length === 1 ? '' : 's'} from what was copied.`
  paste.disabled = clipboard.length === 0
  paste.addEventListener('click', () => {
    createCopiesOf(clipboard, 'Pasting', clipboard.map(() => ''), 'Paste')
  })
  row.append(paste)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'flg-tool flg-remove flg-multi-delete'
  remove.textContent = 'Delete'
  remove.title = `Delete ${String(nodeIds.length)} features and their files. You are asked first.`
  remove.addEventListener('click', () => {
    pendingMultiDelete = [...nodeIds]
    renderInspector(view.getSelection())
  })
  row.append(remove)

  return row
}

/** Deleting more than one thing asks HERE, once, whatever the plans say.
 *
 * Here rather than in the host's modal, and once rather than per file: the host confirms each
 * `deleteFeature` it is sent, so a batch of twelve answered there would be twelve dialogs for one
 * drag -- which is not twelve times the safety, it is a dialog nobody reads by the third one. The
 * question a batch needs is about the COUNT anyway, and the count is a fact this panel has and
 * the host, receiving the deletes one at a time, does not. So this asks, naming every id, and the
 * deletes go out `confirmed`. */
function multiDeleteConfirmPanel(pending: readonly string[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-confirm'
  wrap.append(
    notice(
      `Delete ${String(pending.length)} features and their files? Anything still delegating to them will be left pointing at nothing.`,
      'error',
    ),
  )
  wrap.append(hint(pending.join(', ')))

  const buttons = document.createElement('div')
  buttons.className = 'flg-confirm-buttons'

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'flg-tool flg-remove flg-multi-delete-confirm'
  go.textContent = `Delete ${String(pending.length)}`
  go.addEventListener('click', () => {
    const ids = pending
    pendingMultiDelete = null
    let sent = 0
    for (const id of ids) {
      const plan = deleteFeature(fileGraph(), { target: id, detachReferences: true })
      if (!plan.ok) continue
      sendDelete(plan.plan, true)
      sent++
    }
    setStatus(sent === ids.length ? `Deleting ${String(sent)} features.` : `Deleting ${String(sent)} of ${String(ids.length)} features; the rest were refused.`)
  })
  buttons.append(go)

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'flg-tool'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => {
    const count = pending.length
    pendingMultiDelete = null
    setStatus(`${String(count)} features were left alone.`)
    renderInspector(view.getSelection())
  })
  buttons.append(cancel)
  wrap.append(buttons)
  return wrap
}

/** Align and distribute: the cheap half of "do something to all of them".
 *
 * Cheap because the positions are already here and each button is one batch of the same moveNode
 * the drag path sends -- no new message, no new host code, no new failure mode. */
function multiArrangeRow(nodeIds: readonly string[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'flg-confirm-buttons flg-multi-arrange'

  function placed(): { id: string; x: number; y: number }[] {
    const out: { id: string; x: number; y: number }[] = []
    for (const id of nodeIds) {
      const at = positions.get(id)
      if (at) out.push({ id, x: at.x, y: at.y })
    }
    return out
  }

  function commit(moved: readonly { id: string; x: number; y: number }[], what: string): void {
    for (const move of moved) {
      positions.set(move.id, { x: move.x, y: move.y })
      vscode.postMessage({ type: 'moveNode', nodeId: move.id, x: move.x, y: move.y })
    }
    draw()
    setStatus(`${what} ${String(moved.length)} cards.`)
  }

  function button(label: string, title: string, className: string, enabled: boolean, onClick: () => void): void {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `flg-tool ${className}`
    el.textContent = label
    el.title = title
    el.disabled = !enabled
    el.addEventListener('click', onClick)
    row.append(el)
  }

  const count = placed().length

  button('Align left', 'Give every selected node the same x -- the leftmost one they already have.', 'flg-multi-align-x', count >= 2, () => {
    const at = placed()
    if (at.length < 2) return
    const x = Math.min(...at.map((n) => n.x))
    commit(at.map((n) => ({ id: n.id, x, y: n.y })), 'Aligned')
  })

  button('Align top', 'Give every selected node the same y -- the topmost one they already have.', 'flg-multi-align-y', count >= 2, () => {
    const at = placed()
    if (at.length < 2) return
    const y = Math.min(...at.map((n) => n.y))
    commit(at.map((n) => ({ id: n.id, x: n.x, y })), 'Aligned')
  })

  button('Space out', 'Even the vertical gaps between them, leaving the top and bottom ones where they are.', 'flg-multi-distribute', count >= 3, () => {
    const at = placed().sort((a, b) => a.y - b.y)
    if (at.length < 3) return
    const first = at[0]!
    const last = at[at.length - 1]!
    const step = (last.y - first.y) / (at.length - 1)
    commit(at.map((n, i) => ({ id: n.id, x: n.x, y: Math.round(first.y + step * i) })), 'Spaced out')
  })

  return row
}

/** The panel for several selected nodes: what they are, and what can be done to all of them.
 *
 * A MARQUEE IS A VERB WITH NO OBJECT UNTIL THIS PANEL GIVES IT ONE. Dragging a box around
 * twenty-nine nodes is a gesture people make because they intend to do something to
 * twenty-nine nodes, and for a long time the only thing on offer here was "Group" -- on a pack
 * with no groups in it yet, literally one button. Everything else the editor can do it could
 * only do to one node at a time, so the selection had to be thrown away to use it, which makes
 * the marquee a way of counting things rather than a way of choosing them.
 *
 * The additions are the four that a selection is usually FOR -- duplicate, copy, paste, delete --
 * plus align and distribute, which are cheap here because the canvas positions are already in
 * hand and each one is a batch of the same moveNode the drag path sends.
 */
function multiSelectionPanel(nodeIds: readonly string[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-group-panel'
  wrap.append(heading(`${String(nodeIds.length)} selected`))

  wrap.append(multiActionRow(nodeIds))
  // The delete question, directly under the button that raised it.
  if (pendingMultiDelete !== null) wrap.append(multiDeleteConfirmPanel(pendingMultiDelete))
  wrap.append(multiArrangeRow(nodeIds))

  wrap.append(createGroupForm(nodeIds))

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
      applyGroupPlan(planAdd(planGraph(), planGroups(), add.value, nodeIds))
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

/** The name box and the Group button, as ONE control with one way to spend what is typed.
 *
 * THIS IS WHERE A GROUP WAS WRITTEN TWICE AND THE SECOND WRITE WON. The box committed on `change`
 * and the button planned again from `.value`, and a click does both: pressing Group blurs the
 * input, the blur fires `change`, the first batch goes out -- and then the handler runs, plans a
 * SECOND create against planGraph(), which now has the first batch's directives folded into it, so
 * slugForGroup sees the id taken and makes another. Two batches, two ids, both writing the same
 * two files, the second landing on top; the panel showed one group with the name the author typed,
 * because the name is all that is drawn, while the files said something else entirely.
 *
 * The keyboard route (Ctrl+G, type, Enter) never did this, which is why it survived review: Enter
 * commits once and the blur that follows finds the box already spent.
 *
 * The fix is that the button has no path of its own. It asks the box to commit, the box's own
 * guard decides whether there is anything to spend, and the blur that the click causes has already
 * been through the same guard. */
function createGroupForm(nodeIds: readonly string[]): HTMLElement {
  const form = document.createElement('div')
  form.className = 'flg-group-form'
  const name = nameInput('', 'Group name', (value) => applyGroupPlan(planCreate(planGraph(), planGroups(), nodeIds, value)))
  name.el.id = 'flg-group-name'
  name.el.title = 'Name the group and press Enter. Written into each member’s file as a comment.'
  const make = document.createElement('button')
  make.type = 'button'
  make.className = 'flg-tool flg-group-make'
  make.textContent = 'Group'
  make.title = 'Group the selected features under this name (Ctrl+G).'
  make.addEventListener('click', () => {
    name.commit(true)
  })
  form.append(name.el, make)
  return form
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
  const name = nameInput(group.name, 'Group name', (value) => applyGroupPlan(planRename(planGraph(), planGroups(), group.id, value)))
  name.el.title = 'Rename the group. Enter or Tab to apply; rewrites every member’s directive.'
  const fold = document.createElement('button')
  fold.type = 'button'
  fold.className = 'flg-tool flg-group-fold'
  fold.textContent = group.collapsed ? 'Expand' : 'Collapse'
  fold.title = group.collapsed
    ? 'Show the members as their own cards again. Written to their files.'
    : 'Fold the members into one card. Written to their files, so everyone opening the pack sees it folded.'
  fold.addEventListener('click', () => applyGroupPlan(planSetCollapsed(planGraph(), planGroups(), group.id, !group.collapsed)))
  head.append(name.el, fold)
  wrap.append(head)

  for (const warning of group.warnings) wrap.append(notice(warning, 'warning'))

  // What is left of a group, said on the group's own panel as well as on its frame and in the
  // sidebar -- this is the one of the three with room for what to do about it.
  if (group.memberIds.length === 1) {
    wrap.append(
      notice(
        `"${group.name}" is down to one member. A group is a bracket round several features; the others were ` +
          'deleted, or their directives were removed outside this editor. Ungroup it, or add features to it.',
        'info',
      ),
    )
  }

  // What the group has LOST since this panel was opened, named. See lostMembers for why a group
  // that quietly shrinks is worse than one that fails out loud.
  const lost = lostMembers.get(group.id) ?? []
  if (lost.length > 0) {
    // Built through `notice` so it carries the same "Warning: " marker every other warning box
    // does; it was the one that did not, purely because it needed a button underneath.
    const gone = notice(
      `${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} no longer in "${group.name}". ` +
        'Deleting a feature, or removing its directive outside this editor, takes it out of the group ' +
        'as well, and neither can be undone from here.',
      'warning',
    )
    gone.classList.add('flg-group-lost')
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'flg-tool flg-group-lost-dismiss'
    dismiss.textContent = 'Got it'
    dismiss.title = 'Stop showing this. Nothing is written either way.'
    dismiss.addEventListener('click', () => {
      lostMembers.delete(group.id)
      renderInspector(view.getSelection())
    })
    gone.append(dismiss)
    wrap.append(gone)
  }

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
      applyGroupPlan(planUngroup(planGraph(), planGroups(), group.id), 'none')
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
    remove.addEventListener('click', () => applyGroupPlan(planRemove(planGraph(), planGroups(), group.id, [id])))
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
      (value) => applyGroupPlan(planCreate(planGraph(), planGroups(), [nodeId], value)),
      () => renderInspectorFor(nodeId),
    )
    input.el.title = 'Name the new group and press Enter.'
    select.replaceWith(input.el)
    input.el.focus()
  }
  select.addEventListener('change', () => {
    const next = select.value
    if (next === '+new') {
      startNaming()
      return
    }
    if (next === current) return
    if (next === '') {
      // Out of EVERY group, not out of the first directive. planRemove now takes them all off --
      // see removeOps -- and this says so, because a file that carried two of them is about to
      // stop belonging to a group the row never showed.
      const extra = nodeGroupWarnings(groupsView, nodeId).length > 0
      if (applyGroupPlan(planRemove(planGraph(), planGroups(), current, [nodeId]), 'none') && extra) {
        setStatus(`${nodeId} carried more than one group directive; all of them are being removed.`)
      }
      return
    }
    applyGroupPlan(planAdd(planGraph(), planGroups(), next, [nodeId]))
  })
  row.append(select)

  // WHERE THE PERSON IS LOOKING. "carries 2 group directives" is a fact about this file, and it
  // used to be said only on the panel of whichever group happened to win the majority -- a panel
  // nobody opens while they are standing on the node deciding what group it is in.
  const warnings = nodeGroupWarnings(groupsView, nodeId)
  if (warnings.length === 0) return row
  const wrap = document.createElement('div')
  wrap.append(row)
  for (const warning of warnings) wrap.append(notice(warning, 'warning'))
  return wrap
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
  // ALWAYS a sentence. Running a feature takes seconds and opens a panel that is not this one, so
  // a press that said nothing was indistinguishable from a press that did nothing -- which is the
  // state the per-node Preview button would have shipped in, since most nodes worth previewing
  // are features rather than rules and the rule branch was the only one that spoke.
  setStatus(rule !== null && rule !== nodeId ? `Previewing ${rule}, the rule that places this.` : `Previewing ${nodeId}...`)
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

// ---------------------------------------------------------------------------
// What this panel is left looking at
// ---------------------------------------------------------------------------
//
// A graph panel is a PLACE: a camera somewhere over a pack, a node being worked on, a search
// somebody typed, compounds they opened, a key and a map they arranged. All of it was thrown
// away every time the tab was closed, so reopening a pack put the reader back at the beginning
// of a canvas they had spent a minute getting to the middle of.
//
// The blob is OPAQUE to the host: it stores it and hands it back, and the shape below is this
// file's own business. Read defensively for exactly that reason -- a blob written by an older
// version of this panel is the ordinary case, not a corrupt one, and a missing field means
// "this panel did not remember that yet" rather than an error worth saying anything about.
//
// Deliberately NOT in here: the seed, origin, repeat, preset and sizes. Those belong to the
// preview and the host already remembers them; a second copy would be a second answer.

interface SavedView {
  camera?: { x: number; y: number; zoom: number }
  /** The selected node, or a group by id. An edge is not kept: its identity is a JSON path into
   * a file that may well have been edited between one session and the next. */
  selectedNode?: string
  selectedGroup?: string
  search?: string
  expandedCompounds?: string[]
  legendOpen?: boolean
  minimapCollapsed?: boolean
}

/** The key the host gave this panel for its own state. Written into setState() as well, because
 * on a window reload VS Code hands the HOST the webview's saved blob and nothing else, and this
 * is then the only thing that can say which pack the revived tab was showing. */
let stateKey: string | null = null

/** What arrived before there was a graph to apply it to. `restoreState` is posted on `ready`,
 * ahead of the first graph, so the camera and the selection it describes have nothing to point
 * at yet -- they are applied once, after the first graph draws. */
let pendingRestore: SavedView | null = null

function applyRestoredState(message: { key?: unknown; state?: unknown }): void {
  if (typeof message.key === 'string') {
    stateKey = message.key
    vscode.setState({ key: message.key })
  }
  const state = message.state
  if (typeof state !== 'object' || state === null) return
  // THIS PANEL HAS BEEN HERE BEFORE. The host only sends a state blob it actually had, so its
  // arrival is the one signal that distinguishes a revived panel from a fresh one -- which is
  // exactly the distinction the history control could not make. See renderHistory.
  revived = true
  renderHistory()
  pendingRestore = state as SavedView
  // The two that need no graph are applied at once, so the panel is already arranged the way it
  // was left while the first graph is still being built.
  if (typeof pendingRestore.legendOpen === 'boolean') view.setLegendOpen(pendingRestore.legendOpen)
  if (typeof pendingRestore.minimapCollapsed === 'boolean') view.setMinimapCollapsed(pendingRestore.minimapCollapsed)
  for (const id of pendingRestore.expandedCompounds ?? []) {
    if (typeof id === 'string') expandedCompounds.add(id)
  }
}

/** Puts back what needed a drawn graph. Runs once, after the first one arrives.
 *
 * The camera is set AFTER the selection, not before: selecting a node is what the rest of this
 * file does by centring on it, and a restore that selected and then let that centring stand
 * would put the reader somewhere they never were. */
function finishRestore(): void {
  const saved = pendingRestore
  if (saved === null || !graph) return
  pendingRestore = null
  // What the saved view pointed at and this graph does not have. A deleted feature, a renamed
  // one -- from here the two are the same event and the same sentence covers both, because the
  // rename left an id nobody can go back to just as surely as the delete did.
  let missing: { id: string; what: 'feature' | 'group' } | null = null
  if (typeof saved.selectedNode === 'string') {
    const node = graph.nodes.find((n) => n.id === saved.selectedNode)
    if (node) view.setSelection({ kind: 'node', nodeId: node.id, node })
    else missing = { id: saved.selectedNode, what: 'feature' }
  } else if (typeof saved.selectedGroup === 'string') {
    if (groupsView.byId.has(saved.selectedGroup)) view.setSelection({ kind: 'group', groupId: saved.selectedGroup })
    else missing = { id: saved.selectedGroup, what: 'group' }
  }
  renderInspector(view.getSelection())
  if (typeof saved.search === 'string' && saved.search !== '') {
    ensureSearch()
    search?.setQuery(saved.search)
  }
  const camera = saved.camera
  // THE CAMERA GOES WITH THE SELECTION IT BELONGED TO.
  //
  // A saved camera is not a place somebody chose to look at; it is where they happened to be
  // standing when they were looking at the thing they had selected. Restoring it after refusing
  // to restore that selection used to put the reader at {-498.4, -234.4, 0.9} pointing at the
  // gap the feature had been cut out of: eight cards where there had been eleven, nothing
  // selected, and the string `wiki:diamond_vein` nowhere on the page -- not in the sidebar, not
  // in the status line, not in a notice. The panel had every fact needed to say "the thing you
  // were on is gone" and said none of them, while arranging itself to look exactly as though
  // nothing had happened.
  //
  // So when the selection resolves to nothing, the saved camera is dropped with it and the
  // opening camera `draw()` already chose (openOnSomethingReadable) is left standing -- the same
  // view a first-time open of this pack would get, which is the honest answer to "where should I
  // put somebody who cannot go back to where they were". And the reason is said, by name.
  if (missing === null && camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.zoom)) {
    view.setCamera(camera)
    // The opening camera is chosen by openOnSomethingReadable for a panel with nowhere to go
    // back to. This one HAS somewhere, so that choice is already spent.
    framed = true
  }
  if (missing !== null) {
    const text =
      `${missing.id} is not in this pack any more, so this panel could not go back to what it was ` +
      `left on. It may have been deleted, or renamed${missing.what === 'group' ? ' or ungrouped' : ''}. ` +
      'The saved view went with it: this is where a first open of this pack would put you, not where ' +
      'you were.'
    setBannerNote('dead-selection', { text, level: 'warning' })
  }
  setExtentStatus()
}

/** What this panel is looking at, right now. */
function currentView(): SavedView {
  const selection = view.getSelection()
  return {
    camera: view.getCamera(),
    ...(selection?.kind === 'node' ? { selectedNode: selection.nodeId } : {}),
    ...(selection?.kind === 'group' ? { selectedGroup: selection.groupId } : {}),
    search: search?.result().query.raw ?? '',
    expandedCompounds: [...expandedCompounds],
    legendOpen: view.isLegendOpen(),
    minimapCollapsed: view.isMinimapCollapsed(),
  }
}

/** Hands the host the blob, at most once a beat.
 *
 * DEBOUNCED because the loudest thing in it is the camera, which changes on every frame of every
 * pan: a message per frame would be a workspace-state write per frame, for a value only the next
 * open will ever read. The delay costs nothing -- there is no reader waiting -- and a panel
 * closed mid-pan loses at most the last fraction of a second of a camera move.
 */
const PERSIST_DEBOUNCE_MS = 400
let persistTimer = 0
function persistView(): void {
  if (persistTimer !== 0) return
  persistTimer = window.setTimeout(() => {
    persistTimer = 0
    if (!graph) return
    vscode.postMessage({ type: 'persistState', state: currentView() })
  }, PERSIST_DEBOUNCE_MS)
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
  persistView()
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
  applyGroupPlan(planSetCollapsed(planGraph(), planGroups(), groupId, collapsed))
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
    // The host has answered, so the directives this panel was carrying on its own account are
    // spent: what came back is what the files say. Dropped BEFORE the view is rebuilt, so the
    // groups planned against are the ones just drawn. See withDirectives.
    sentGroupOps = []
    rebuildView()
    if (!graph) return
    // An engine that predates the field sends nothing; an empty list is then the honest answer
    // rather than a claim that the pack is clean.
    const sentDiagnostics = (message as unknown as { diagnostics?: GraphDiagnosticWire[] }).diagnostics
    diagnostics = Array.isArray(sentDiagnostics) ? sentDiagnostics : []
    // Same shape check, same reason: a host that does not send pack warnings is not a host that
    // is claiming the pack has none.
    const sentWarnings = (message as unknown as { packWarnings?: unknown }).packWarnings
    packWarnings = Array.isArray(sentWarnings) ? sentWarnings.filter((w): w is string => typeof w === 'string') : []
    packContents = readPackContents(message) ?? {}
    // A whole KIND missing is a standing fact about the pack, so it is decided here, once per
    // graph, beside the other facts the graph carried. Null when every kind the canvas draws
    // from has files in it, and null for an engine that sends no counts at all -- which is not
    // the same as an engine reporting zeros, and must not read as one.
    const emptyKinds = describeEmptyGraphKinds(packContents.fileCounts)
    partialPack = emptyKinds !== null
    setBannerNote('empty-kind', emptyKinds === null ? null : { text: emptyKinds, level: 'warning' })
    // Positions come from the host, which merges three sources the webview cannot see: the
    // automatic layout, positions annotated in the pack files, and the sidecar this editor
    // writes. Recomputing them here would silently discard the two that are someone's own work.
    const sent = (message as unknown as { positions?: Record<string, GraphPoint> }).positions
    positions = sent ? new Map(Object.entries(sent)) : layout(graph)
    placeGroupCards()
    const problem = (message as unknown as { layoutProblem?: string }).layoutProblem
    if (problem) setStatus(`The saved arrangement could not be read: ${problem}`, 'error')
    draw()
    // Once, on the first graph: the camera and the selection this panel was left with need
    // something drawn to point at, and `restoreState` arrives before there is any. A no-op on
    // every graph after it.
    finishRestore()
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
      setExtentStatus()
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
    } else if (current.kind === 'edge') {
      // THE EDGE PANEL IS NOT REBUILT -- it is RE-SEEDED. Rebuilding would take the control out
      // of the document and the caret with it, which is why this branch used to do nothing at
      // all; but doing nothing left the cached editor holding a value the file no longer had,
      // and the next commit wrote it back over whatever had replaced it.
      //
      // reseed() adopts the new value when the box is clean and raises a conflict when it is
      // not; either way the panel repaints in place, so the diagnostics and the "not saved yet"
      // line follow the file without the box moving.
      const fresh = lastGraph?.edges.find(
        (e) => e.from === current.edge.from && e.jsonPath === current.edge.jsonPath,
      )
      const slot = fresh === undefined ? null : molangSlotOf(fresh)
      if (fresh !== undefined && slot !== null && edgeEditor !== null && edgeEditorKey === edgeEditorKeyFor(fresh, slot.field)) {
        edgeEditor.reseed(slot.value)
        edgeRepaint?.()
      }
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
    // Before the status line, because this is the one that gets read: a graph that drew nothing
    // has to say so on the canvas, where somebody who thinks the panel is broken is looking.
    setEmptyState(emptyGraphMessage(graph.nodes.length, diagnostics.length, packWarnings, packContents))
    setExtentStatus()
    return
  }
  // THE WRITE LANDED. One line, once, in the gap between the bytes reaching the disk and the
  // rebuilt graph arriving -- which is an engine round trip wide and was previously silent. The
  // graph message that follows replaces this with the card count, so nothing here has to expire
  // on a timer or be cleared by hand.
  if (message.type === 'saved') {
    const what = (message as unknown as { what?: string }).what
    setStatus(what === undefined || what === '' ? 'Saved.' : `Saved ${what}.`)
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
        : `Deleted ${id}. ${waiting.length} cards now need a feature: ${waiting.join(', ')}. Showing ${first.id}.`,
    )
    return
  }
  if (message.type === 'previewClosed') {
    // Closing the preview is an answer: "I am done looking". It used to turn the toggle off
    // HERE -- which was right until the toggle started being remembered per pack, at which
    // point two places decided it and the panel could reopen reading "pressed" over a feature
    // the host had stored as off. The host now sends the authoritative value straight after
    // this message, so this one only says what happened.
    return
  }
  if (message.type === 'previewOnSelect') {
    // AUTHORITATIVE, and never echoed back: this is the host telling the panel what the
    // remembered value is, and posting it again from here would write back what was just read.
    setPreviewOnSelect((message as unknown as { value?: boolean }).value === true)
    return
  }
  if (message.type === 'restoreState') {
    applyRestoredState(message as unknown as { key?: unknown; state?: unknown })
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
  if (message.type === 'history') {
    const sent = message as unknown as { undo?: unknown; redo?: unknown }
    historyState = {
      undo: typeof sent.undo === 'string' ? sent.undo : null,
      redo: typeof sent.redo === 'string' ? sent.redo : null,
    }
    renderHistory()
    return
  }
  if (message.type === 'undone' || message.type === 'redone') {
    // The history moved, so whatever it was stuck on is no longer what it is stuck on.
    historyBlocked = null
    const sent = message as unknown as { label?: string; files?: string[] }
    const label = sent.label ?? 'that change'
    const files = sent.files ?? []
    // The FILES are named. This is the one operation in the panel that writes bytes the author
    // never typed, and "which files did that touch" is the only question it raises.
    const what = files.length === 0 ? '' : ` ${files.join(', ')} ${files.length === 1 ? 'is' : 'are'} back to what they were.`
    setStatus(message.type === 'undone' ? `Undid ${label}.${what}` : `Redid ${label}.${what}`)
    renderHistory()
    return
  }
  if (message.type === 'historyForgotten') {
    historyBlocked = null
    const label = (message as unknown as { label?: string | null }).label
    setStatus(
      label === null || label === undefined
        ? 'There was nothing left in the history to leave out.'
        : `"${label}" was left out of the history. Nothing was written; Undo now reaches what came before it.`,
    )
    renderHistory()
    return
  }
  if (message.type === 'createError' || message.type === 'editError') {
    // A refused group operation produces no graph, so the selection it was holding for one must
    // not wait around to be applied to the next unrelated redraw.
    pendingGroupSelect = null
    // Nor may a refused write go on counting as written. No graph is coming for it, so this is
    // the only place either half of that hears about it.
    sentGroupOps = []
    expectedDepartures.clear()
    inspector?.forgetSentEdits()
    // A refused UNDO comes through here too, and it carries the entry it refused over. The
    // sentence goes on the status line like every other refusal; the label turns the toolbar's
    // "Skip this step" on, because this particular refusal is permanent until somebody says so.
    const blocked = (message as unknown as { blockedUndo?: unknown }).blockedUndo
    if (typeof blocked === 'string') {
      historyBlocked = blocked
      renderHistory()
    }
    setStatus((message as unknown as { message: string }).message, 'error')
    return
  }
  if (message.type === 'deleteCancelled') {
    // The host now asks about every delete in a modal of its own, and this is somebody answering
    // it "no". Without this the status line keeps saying "Deleting wiki:oak..." for a file that
    // is still there -- which is the one thing a status line must never do.
    const id = (message as unknown as { id?: string }).id ?? 'It'
    setStatus(`${id} was left alone.`)
    return
  }
  if (message.type === 'graphCancelled') {
    // The user pressed Cancel. Said on the canvas AND in the status line, exactly like a failure
    // -- because the state it leaves behind looks identical to one -- but worded as the ordinary
    // outcome it is, and NOT styled as an error: an angry red line for something somebody chose
    // is how a panel teaches people to ignore its red lines.
    setStatus('Building the feature graph was cancelled.')
    setEmptyState(graphCancelledMessage())
    return
  }
  if (message.type === 'graphError') {
    const why = message.message ?? 'The pack could not be read.'
    setStatus(why, 'error')
    // The SIDEBAR is drawn from the graph, and a failed load never brings one -- so it kept
    // whatever it had, which on a first load is "Loading the pack...". A panel that says the pack
    // could not be read on the canvas and that it is still loading beside it has contradicted
    // itself, and the half somebody believes is the half that promises the wait will end.
    //
    // A pack that could not be read has no selection in it either, so the selection goes too.
    // Otherwise the sidebar offers Delete and Rename for a node the engine has just said it
    // cannot see.
    lastGraph = null
    graph = null
    view.setSelection(null)
    pendingDelete = null
    pendingEject = null
    pendingMultiDelete = null
    renderInspector(null)
    // Any warnings that came with the failure, kept for the empty state the way a successful
    // load's are -- a load that failed BECAUSE the directories are not there should say so.
    const sentWarnings = (message as unknown as { packWarnings?: unknown }).packWarnings
    if (Array.isArray(sentWarnings)) packWarnings = sentWarnings.filter((w): w is string => typeof w === 'string')
    // Kept for the same reason, and only when it was sent: a failed load that DID read the pack
    // far enough to name the files it refused should still be able to name them on the next draw.
    const sentContents = readPackContents(message)
    if (sentContents !== null) packContents = sentContents
    // On the canvas as well as in the status line. A pack that will not load leaves this panel
    // with nothing drawn, and a blank canvas plus one line of small text at the bottom edge is
    // the state this whole panel was reported as being broken in.
    setEmptyState(graphErrorMessage(why))
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
      // Whatever opened it, it is shut now. Set unconditionally rather than only when the menu
      // was opened from this button, so a right-click open followed by a toolbar open can never
      // leave the button claiming to be expanded over a menu that is gone.
      addButton?.setAttribute('aria-expanded', 'false')
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
// There used to be a `canvasFilter` here, described as being kept "so a reload can re-apply
// it". Nothing ever read it, and nothing needed to: SearchBox.setSource keeps the query and
// re-runs it, which calls onFilter again by itself, so a reload re-applies the filter without
// anything on this side remembering one. A variable that is only ever written is a promise to
// the next reader that something depends on it.

/** Builds the search box, or points it at a freshly loaded graph.
 *
 * Rebuilt rather than kept because the index describes the pack, and the pack changes under it on
 * every save -- but the QUERY is kept, so a save does not throw away what somebody was looking
 * for. That is `setSource`'s whole job. */
/** Node id -> the name of the group it is in, for the search index. Empty when the pack has no
 * groups, which is what buildSearchIndex costs nothing for. */
function searchableGroupNames(): Map<string, string> {
  const out = new Map<string, string>()
  for (const group of groupsView.groups) {
    for (const id of group.memberIds) out.set(id, group.name)
  }
  return out
}

function ensureSearch(): void {
  if (!graph) return
  // Indexed over the graph BEFORE groups fold, so a feature inside a collapsed group is still
  // findable -- search is how somebody finds a thing they cannot see, and a collapsed group is
  // the one place on this canvas a thing can be without being seen. Revealing a hit that is
  // hidden selects the group's card instead (revealNode).
  const source = groupSource ?? graph
  // The group NAMES go in with it. A group's name is the one name on this canvas an author chose
  // for themselves, and searching for it used to answer "nothing in this pack matches" -- while
  // searching for a member of that very group worked, which makes the box look as though it knows
  // about groups and has decided this one does not exist. See SearchEntry.groupName.
  const index = buildSearchIndex(source, { groupNames: searchableGroupNames() })
  if (search) {
    search.setSource(index, source)
    return
  }
  search = createSearchBox({
    index,
    graph: source,
    container: searchHost(),
    onReveal: (hit) => {
      if (!revealNode(hit.nodeId)) return
      // AND THE KEYBOARD GOES WITH IT.
      //
      // Choosing a result already selected the node, centred the camera on it and drew its form
      // -- and left the keyboard in the search box, with the whole canvas between it and the
      // form. Measured on the fixture pack: Ctrl+F, five characters, Down and Enter cost eight
      // presses and found the node in 0.4 s; the first field of the panel it had just opened was
      // ninety-nine Tabs further on. Search is how somebody gets to a node they mean to EDIT, so
      // the edit is where the keyboard belongs.
      //
      // The box keeps its query and Ctrl+F comes straight back to it, which is what makes this
      // affordable: the cost of changing your mind about the query is one chord, and the cost of
      // acting on the answer was a hundred keys.
      //
      // The MOUSE path is unchanged, and not by accident: search.ts's own row handler puts focus
      // back in the input after calling this, because somebody who clicked a row is still at the
      // list. Only Enter moves the keyboard on.
      focusInspector()
    },
    // Every match, quieted on the canvas and dimmed on the overview map in one call -- which is
    // the whole point of wiring it: the map is the only thing on screen that can answer "where
    // are my hits" for a pack whose matches are mostly off camera, and it was already able to
    // and simply never asked. Null when the box is empty, so an unsearched canvas is untouched.
    onResults: (matched) => {
      view.setHighlight(matched)
      persistView()
    },
    // Escape on an empty box gives the canvas back. The highlight is already null by then --
    // clearing the query reports it -- but the box can also be closed with something typed in
    // it, and a canvas left half-quieted by a panel that is gone reads as a rendering fault.
    onClose: () => {
      view.setHighlight(null)
    },
    // Deliberately NOT bound: the active row changes on every keystroke, so a camera that
    // followed it would fly around the pack while somebody is still typing.
    onFilter: (filter) => {
      if (!graph) return
      // The same positions are reused, so filtering hides boxes without moving the ones that
      // stay. A filter that re-laid the graph out would answer the question and lose the place
      // the reader had. A filtered view is of the source graph, groups unfolded, so no frames.
      view.render(filter ? filter.graph : graph, positions, filter ? [] : frames)
      // A filter's own count is a fact about the FILTER, not about the camera, so it is said with
      // setStatus and stays put while somebody pans around what it left. Dropping the filter hands
      // the line back to the camera.
      if (filter) setStatus(`Showing ${filter.graph.nodes.length} of ${graph.nodes.length}. Escape puts the rest back.`)
      else setExtentStatus()
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
  // ENTER, AND ONLY ENTER.
  //
  // This box moves a FILE. It used to commit on `change`, which fires on BLUR -- so any stray
  // character that landed in it renamed the feature and its file the moment the reader clicked
  // away, with nothing asked and a red Delete button sitting beside it. And stray characters
  // do land in it: the view shortcuts are canvas keys, so pressing `0` to fit the graph while
  // the panel has focus types a nought into the first input on the panel, which is this one.
  // Measured, on the fixture pack: one keystroke produced a feature called
  // `wiki:aggregate0_pumpkin_pair`, and the file with it.
  //
  // So blur RESTORES rather than commits, and Escape does the same on purpose. An edit nobody
  // confirmed is not an instruction, and this is the one control in the panel where being
  // wrong is not undoable by typing the old value back -- the file has already moved.
  let renaming = false
  const commitRename = (): void => {
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
    // Held until the graph that carries the new name arrives, so the blur that follows -- the
    // panel is rebuilt out from under this element -- does not put the old name back on screen
    // over a rename that is already on its way to the file.
    renaming = true
    vscode.postMessage({ type: 'renameFeature', from: nodeId, to: next })
    setStatus(`Renaming ${nodeId} to ${next}...`)
  }
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename()
      return
    }
    if (event.key === 'Escape') {
      // Stopped here: Escape in a field the reader is typing in means "undo what I typed",
      // not "deselect the node", and letting it through would do both at once.
      event.preventDefault()
      event.stopPropagation()
      name.value = nodeId
    }
  })
  name.addEventListener('blur', () => {
    if (!renaming) name.value = nodeId
  })
  wrap.append(name)

  // THE ONLY THING ON A NODE THAT SAYS A 3D PREVIEW EXISTS.
  //
  // Selecting a card is the whole of what a newcomer came to do, and until this button there was
  // nothing on the node, in this panel or on the canvas that mentioned the other half of the
  // product. The one affordance was a toolbar toggle reading "Preview on select", off by default
  // -- a setting, not an action, phrased as a condition on something the reader has not been told
  // about. `previewFor` had two call sites and neither was a button on a node.
  //
  // It says what it will actually DO, which is usually not "run this feature": previewFor walks
  // up to the nearest feature rule, because a feature on its own is one object at one position
  // and the rule is what decides where and how often it is placed. Promising the node and running
  // its rule would be a third thing for the reader to reconcile.
  const preview = document.createElement('button')
  preview.type = 'button'
  preview.className = 'flg-tool flg-preview'
  preview.textContent = 'Preview'
  const rule = ruleReaching(nodeId)
  preview.title =
    rule !== null && rule !== nodeId
      ? `Generate terrain from ${rule}, the rule that places this feature, and highlight the blocks this node put there.`
      : 'Generate terrain from this feature and highlight the blocks it put there.'
  preview.addEventListener('click', () => previewFor(nodeId))
  wrap.append(preview)

  const remove = document.createElement('button')
  remove.type = 'button'
  // `flg-destructive` is the shared class the canvas stylesheet paints every irreversible
  // button with, so this one is not a second opinion about what "dangerous" looks like.
  remove.className = 'flg-tool flg-remove flg-destructive'
  remove.textContent = 'Delete'
  // The most consequential button in the panel had nothing to say about itself. What it needs to
  // say is what happens to the file, because that is the part that is not undoable from here.
  remove.title = 'Delete this feature and its file. Anything that delegates to it is named first, and nothing is written until you confirm.'
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
      setStatus('This card has no file to write the choice into.', 'error')
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

/** Posts the plan's own request, rather than a second derivation of it.
 *
 * `asked` IS THE WHOLE ANSWER TO "HOW MANY TIMES DOES A DELETE ASK". The host confirms every
 * delete in a modal dialog naming the files (graphPanel.ts's confirmDelete), which is right for
 * the ordinary case: one click on a button in a sidebar should not take a file off disk. But this
 * panel ALSO asks, in two cases the host's dialog cannot put the same question in --
 *
 *   - a feature something still delegates to, where the refusal names every referrer with its
 *     file and its json path, and that list is the entire thing the author decides from;
 *   - a batch, where the question is about a count that came from one drag.
 *
 * -- and two dialogs for one decision is worse than either: the second one is answered without
 * being read, which is how a confirmation stops being a safeguard. So the panel that asked says
 * it asked, and the host does not ask again. This is not a way to skip the question; it is the
 * same question, asked once, in the place that can show the most of it. */
function sendDelete(plan: LifecyclePlan, asked = false): void {
  if (plan.request.method !== 'deleteFeature') return
  const params = plan.request.params
  vscode.postMessage({
    type: 'deleteFeature',
    id: params.id,
    detachReferences: params.detachReferences,
    retarget: params.retarget,
    // The group it is in, for the host's question to name. A delete takes the feature out of its
    // group as surely as it takes it off disk, and the group is a thing the author wrote down --
    // so it belongs in the sentence they are about to say yes to, not discovered afterwards as a
    // member count that went down by one. Display only, like `files`; this panel is reading its
    // own last graph, and the host does not act on it.
    group: groupNameOf(params.id),
    // Set only where an author has clicked a button whose label says what it destroys. Never set
    // on the path where this panel found nothing to warn about -- that delete has been asked
    // about nowhere yet, and the host's dialog is the only question it will get.
    confirmed: asked,
    // The plan's own title -- "One line, imperative, suitable for a confirmation button or an
    // undo entry", which is what it is used as at the other end.
    label: plan.title,
  })
  setStatus(`Deleting ${params.id}...`)
}

/** The name of the group a node is in, or undefined. */
function groupNameOf(nodeId: string): string | undefined {
  const id = groupsView.memberOf.get(nodeId)
  return id === undefined ? undefined : groupsView.byId.get(id)?.name
}

/** The question a `referenced` refusal turns into: what it would touch, and a button to go ahead.
 *
 * The refusal's own sentence is kept whole at the top. It names up to six referrers with their
 * files and paths, and that list is the entire reason the refusal exists -- replacing it with
 * "this is referenced, continue?" would take away the only thing the author can decide from.
 *
 * IT IS THE ONLY QUESTION THIS DELETE ASKS. "Delete anyway" goes straight to the write: it posts
 * with `confirmed`, and the host's own modal stands down. See sendDelete for why one question in
 * the place that can show the referrer list beats two questions of which only one can. */
function deleteConfirmPanel(pending: NonNullable<typeof pendingDelete>): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-confirm'
  wrap.append(notice(pending.reason, 'error'))

  // The other thing this destroys, which the referrer list does not mention: a group the author
  // declared loses a member, and that cannot be undone from here either.
  const group = groupNameOf(pending.nodeId)
  if (group !== undefined) {
    wrap.append(hint(`This feature is in "${group}". Deleting it takes it out of that group too.`))
  }

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
      sendDelete(plan, true)
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

/** An edit that would eject a compound, held until somebody says yes.
 *
 * Holding the CLOSURE rather than the edit's parts is what makes "yes" replay exactly the write
 * that raised the question. Rebuilding the message from remembered fragments is how a
 * confirmation ends up sending something subtly different from what it described. */
let pendingEject: { warning: EjectWarning; send: () => void; label: string } | null = null

/** The question an ejecting edit turns into.
 *
 * `ejectWarning` already writes the sentence, so it is repeated here verbatim rather than
 * paraphrased: it names the compound, says the parameters are discarded, and says nothing can
 * recover them. The list of what stops being one node is spelled out because "3 features" is a
 * number and "these three, by name" is a decision. */
function ejectConfirmPanel(pending: NonNullable<typeof pendingEject>): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flg-confirm'
  wrap.append(notice(pending.warning.reason, 'warning'))
  wrap.append(hint(`Becoming ordinary nodes: ${pending.warning.nodesBecomingPlain.join(', ')}.`))

  const buttons = document.createElement('div')
  buttons.className = 'flg-confirm-buttons'

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'flg-tool flg-remove flg-eject-confirm'
  go.textContent = 'Edit and lose the settings'
  go.addEventListener('click', () => {
    const held = pending
    pendingEject = null
    held.send()
  })
  buttons.append(go)

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'flg-tool'
  cancel.textContent = 'Keep it as a pattern'
  cancel.addEventListener('click', () => {
    const identifier = pending.warning.identifier
    pendingEject = null
    setStatus(`${identifier} is still a ${pending.warning.kind}. The edit was not made.`)
    if (inspectorNode !== null) renderInspectorFor(inspectorNode)
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
  // The same sentence as an ordinary field edit, for the same reason -- see sendInspectorEdits.
  // "Rebuilding" rather than "Writing" because a compound parameter rewrites every file the
  // compound generated, not the one the form is drawn from, and saying "writing" of one file
  // would understate what is about to happen to the pack.
  setStatus(`Rebuilding ${change.identifier} from ${change.label}...`)
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
    persistView()
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
            'being one node. You are asked to confirm before the first such edit is written. ' +
            'Moving them on the canvas is not an edit and changes nothing.',
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
function freeIdentifier(base: string, alsoTaken: ReadonlySet<string> = new Set()): string {
  const taken = new Set((graph?.nodes ?? []).map((n) => n.id.toLowerCase()))
  // Names already handed out in this batch but not yet in any graph -- see createCopiesOf.
  for (const name of alsoTaken) taken.add(name)
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
  // The documentation column is a CHILD of the canvas, so a right-click in it used to bubble here
  // and open the creation menu on top of the prose -- a second overlay, floating over the first,
  // anchored to nothing either of them had to do with. Reading is not a gesture that means "add a
  // node here".
  if (target && target.closest('.flg-ins-docs')) return
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
installStylesheet('flg-tooltip-styles', TOOLTIP_STYLESHEET)

// ONE hover card for the whole panel, installed once, here.
//
// Everything in this editor writes its one-sentence explanation as a native `title`, which is the
// right place for it -- the sentence stays where the language guards can read it and where a test
// can assert it without hovering. What was wrong was the DELIVERY: the operating system's own
// tooltip, in a font the theme does not reach, appearing over the control it describes and
// carrying paragraphs of up to five hundred characters. This lifts the attribute off an element
// only while the pointer is on it, draws the sentence in a themed card beside the control, and
// caps it at two lines with a pointer to the ? panel for anything longer.
installTooltips(document)

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
   .flg-jump-group::before { content: '▣ '; opacity: 0.7; }
   /* A group that has lost a member says so, with the one control that answers it: stop saying
      so. The button sits under the sentence rather than beside it because the sentence is two
      lines wide in a sidebar and a trailing button would be off the end of them. */
   .flg-group-lost { display: block; }
   .flg-group-lost .flg-tool { display: block; margin-top: 6px; }`,
)

/** Whether the keystroke belongs to something the author is typing into.
 *
 * Load-bearing for Delete: without it, deleting a character in the rename box or in a Molang
 * expression would delete the NODE. A shortcut that destroys a file while you are editing text is
 * worse than no shortcut, which is why this is checked before the key is looked at rather than
 * after. `isContentEditable` is in there for the highlighted Molang field. */
/** Whether the keystroke started inside the canvas, which serves the view keys itself. */
function inCanvas(target: EventTarget | null): boolean {
  return target instanceof Node && view.element.contains(target)
}

function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (el === null || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

/** WHERE THE KEYBOARD IS, told to the host, because a `when` clause cannot look inside a webview.
 *
 * The workbench binds `featurelab.undo`/`featurelab.redo` to Ctrl+Z and Ctrl+Y for this panel,
 * and VS Code's own webview shim forwards those keys to the workbench rather than letting the
 * text box have them -- so Ctrl+Z in the middle of a Molang expression undid the last WRITE TO
 * THE PACK instead of the typing. The host now gates those keybindings on a
 * `featurelab.graphTyping` context key; this is the only thing that can set it, because there is
 * no context key for "a textarea inside that iframe has focus" and no way for the host to derive
 * one.
 *
 * ONLY ON A CHANGE. The canvas's tab stop roves -- the arrow keys walk the keyboard from card to
 * card, and each move is a focusin -- so posting unconditionally would be a message per arrow
 * press, all of them saying `false`, all of them a round trip to the extension host. Held as one
 * boolean and posted when it flips, which also makes the answer after a card takes focus plainly
 * `false` rather than a stale `true` left behind by the box the reader came from.
 *
 * The focusout is deferred by a turn on purpose: focus moving from one text control to another
 * fires focusout before focusin, and reading `document.activeElement` in between gives <body>.
 * A tick later it has settled, and the dedupe above means the pair costs nothing. */
let lastTypingFocus: boolean | null = null
function postTypingFocus(): void {
  const typing = typingInto(document.activeElement)
  if (typing === lastTypingFocus) return
  lastTypingFocus = typing
  vscode.postMessage({ type: 'typingFocus', typing })
}
window.addEventListener('focusin', postTypingFocus)
window.addEventListener('focusout', () => {
  setTimeout(postTypingFocus, 0)
})

/**
 * CTRL+Z INSIDE A TEXT BOX IS NOT THE GRAPH'S UNDO, and stopping it here is the only place it
 * can be stopped.
 *
 * package.json binds `featurelab.undo` to ctrl+z with `when: activeWebviewPanelId ==
 * 'featurelab.graph'` and no guard for where the keyboard is -- and a `when` clause cannot have
 * one, because a webview is opaque to the workbench: there is no context key for "a textarea
 * inside that iframe has focus". Meanwhile VS Code's own webview shim (vs/workbench/contrib/
 * webview/browser/pre/main.js) treats undo and redo as keys the HOST owns: it calls
 * preventDefault on them -- so the textarea's own undo never happens -- and forwards the keydown
 * to the workbench, which runs the keybinding. The result, before this, is that Ctrl+Z while
 * typing an expression did not undo the typing; it undid the last write to the pack.
 *
 * The shim's listener is on the webview document, in the bubble phase. This one is on the window
 * in the CAPTURE phase, so it runs first, and stopping propagation there means the shim never
 * sees the key: nothing is forwarded, nothing calls preventDefault, and the browser's own undo
 * inside the text box works the way it does in every other text box.
 *
 * Only while the keyboard is in something you can type into. Ctrl+Z on the canvas still reaches
 * the workbench and still undoes the last change to the pack, which is what it is for.
 *
 * THIS IS A BELT, AND THE BRACES BELONG IN THE MANIFEST. It depends on where the shim attaches
 * its listener, which is an implementation detail of VS Code; a version that moves it to the
 * window in the capture phase takes this with it. The manifest change, which does not:
 *
 *   package.json, contributes.keybindings, the featurelab.undo / featurelab.redo entries:
 *     "when": "activeWebviewPanelId == 'featurelab.graph' && !featurelab.graphTyping"
 *
 *   and the host sets that context key from a message this panel posts when focus enters and
 *   leaves a text control:
 *     vscode.commands.executeCommand('setContext', 'featurelab.graphTyping', typing)
 *
 * A `when` clause cannot work this out for itself -- the webview is opaque to the workbench and
 * there is no context key for "a textarea inside that iframe has focus" -- so the panel has to
 * say so, which is why the change is two files and not one line.
 */
window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    const isUndoRedo = key === 'z' || (key === 'y' && !event.shiftKey)
    if (!isUndoRedo || !typingInto(event.target)) return
    event.stopPropagation()
  },
  true,
)

window.addEventListener('keydown', (event) => {
  // Ctrl+F focuses the search box, which is where anybody who has used an editor will reach first.
  //
  // NOT while somebody is typing. It was the one shortcut in this file with no `typingInto`
  // guard, so Ctrl+F in the middle of an expression threw the keyboard out to the feature search
  // -- and leaving the box is what commits, so the half-written expression went into the file on
  // the way past.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !typingInto(event.target)) {
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
      if (selection?.kind === 'group') applyGroupPlan(planUngroup(planGraph(), planGroups(), selection.groupId), 'none')
      return
    }
    startGrouping()
    return
  }
  // THE VIEW KEYS, PANEL-WIDE.
  //
  // The canvas has handled 0 / + / - / ? since it was written, but only while the canvas or a
  // card had focus -- and the moment somebody clicks into the form, which is what they are
  // here to do, the keys stop working. What they did instead was worse than nothing: the
  // keystroke went to whatever control had focus, so `0` pressed to fit the graph typed a
  // nought into a field.
  //
  // Handled here only for a keystroke that did NOT start inside the canvas -- the canvas's own
  // handler is still the one that serves it there, and two handlers for one press would zoom
  // twice -- and never while somebody is typing, which is the same rule every other shortcut
  // in this file follows.
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !typingInto(event.target) && !inCanvas(event.target)) {
    switch (event.key) {
      case '0':
        view.zoomToFit()
        event.preventDefault()
        return
      case '+':
      case '=':
        view.zoomBy(1.2)
        event.preventDefault()
        return
      case '-':
      case '_':
        view.zoomBy(1 / 1.2)
        event.preventDefault()
        return
      case '?':
        view.toggleLegend()
        persistView()
        event.preventDefault()
        return
      default:
        break
    }
  }
  // Delete removes the selected node, the same way the panel's own button does -- including the
  // refusal when something still delegates to it. Backspace is deliberately NOT bound: on a
  // canvas it is the key people press expecting "go back", and the two are one keystroke apart.
  if (event.key === 'Delete' && !typingInto(event.target)) {
    const selection = view.getSelection()
    if (selection === null) return
    if (selection.kind === 'node') {
      event.preventDefault()
      requestDelete(selection.nodeId)
      return
    }
    // A marquee selection used to ignore this key entirely, which reads as a broken keyboard
    // rather than as a decision. It raises the same question the panel's Delete raises -- and
    // raises it rather than answering it, because the key is one keystroke and the files are many.
    if (selection.kind === 'nodes') {
      event.preventDefault()
      pendingMultiDelete = [...selection.nodeIds]
      renderInspector(selection)
    }
    return
  }
  // Copy and paste for a selection, in the keys everything else uses for them. Both go through
  // the same two functions the buttons do: a second path would be a second set of rules about
  // what may be copied.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !typingInto(event.target)) {
    const selection = view.getSelection()
    if (event.key === 'c' && selection !== null && selection.kind === 'nodes') {
      event.preventDefault()
      clipboard = writableSelection(selection.nodeIds).map((entry) => ({ typeId: entry.typeId, fields: entry.fields }))
      setStatus(`Copied ${String(clipboard.length)} feature${clipboard.length === 1 ? '' : 's'}.${skippedNote(selection.nodeIds, clipboard.length)}`)
      renderInspector(selection)
      return
    }
    if (event.key === 'v' && clipboard.length > 0) {
      event.preventDefault()
      createCopiesOf(clipboard, 'Pasting', clipboard.map(() => ''), 'Paste')
    }
  }
})

renderToolbar()
renderInspector(null)
// The FIRST thing written to the canvas, and it is written before anything is asked of the host.
// The shell ships a static sentence in this element saying the script did not load (see
// graphPanel.ts's WEBVIEW_DID_NOT_START); replacing it is how this script proves it ran, and
// leaving something in its place is what keeps the canvas from being blank during the round trip
// that follows.
setEmptyState('Loading the pack…')
setStatus('Loading the pack...')
vscode.postMessage({ type: 'ready' })
