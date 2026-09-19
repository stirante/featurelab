// webview/main.ts -- the webview-side script, bundled by esbuild.config.mjs into
// dist/webview.js (three.js and the rest of featurelab-frontend included, per this
// package's "bundle three.js locally, no CDN" requirement -- see esbuild's own --bundle).
// Talks to the extension host purely via postMessage; owns the VoxelViewer/panel instances
// for this webview's whole lifetime so regenerating never rebuilds them (that's what
// preserves camera position and every view control across a save-triggered regenerate).
import { VoxelViewer, createPanel, createSplitter, decodeAtlas, decodeGenerateResult } from 'featurelab-frontend'
import type { AtlasWire, EnvironmentOptionWire, GenerateParamsWire, Mode } from 'featurelab-frontend'
import 'featurelab-frontend/panel.css'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void; getState(): unknown }

interface HostMessage {
  type: 'result' | 'error' | 'stale' | 'init' | 'environments' | 'timeoutInfo' | 'busy' | 'atlas' | 'textureStatus' | 'attribution' | 'attributionCell' | 'restoreState'
  result?: unknown
  message?: string
  stale?: boolean
  reason?: string
  /** 'busy' only -- the host started a request THIS webview didn't initiate (the panel's very
   * first regenerate, a save-triggered one), so the local setBusy(true)-on-send in the
   * onConfigChange/onReloadFiles/onGrowRegenerate callbacks below never ran for it. Cleared the
   * same way as every other request: panel.ts's own setResult/setError/setStale(true) safety
   * net, never an explicit busy:false message. */
  busy?: boolean
  /** 'init' only -- the kind+identifier previewPanel.ts is already generating from (parsed from
   * the just-opened document -- see identifier.ts's parseDocumentIdentifier), so panel.ts's
   * Feature OR Rule picker (and mode) can show it from the start instead of guessing, and so an
   * explicit open always wins over whatever a PREVIOUS preview panel's session left in
   * localStorage -- see PanelHandle.seedOpenedDocument's own doc comment for the full "why". */
  kind?: Mode
  identifier?: string
  /** 'environments' only -- the engine's own environment preset list (cmd/featurelab's
   * `environments` method), fed straight to PanelHandle.setEnvironments so the Preset dropdown
   * populates itself from live engine data instead of a hardcoded mirror -- see that method's
   * own doc comment. */
  environments?: EnvironmentOptionWire[]
  /** 'timeoutInfo' only -- the request-timeout / placement-budget coupling previewPanel.ts's
   * regenerate() computes on every request, fed straight to PanelHandle.setTimeoutInfo so the
   * Budget section can say so whenever it had to raise the extension's own wait -- see that
   * method's own doc comment. */
  configuredMs?: number
  effectiveMs?: number
  /** 'atlas' only -- the block-texture atlas (table + base64 PNG), fetched by the host over the
   * engine's own JSON-RPC channel because the atlas lives in the user's cache directory, which
   * this webview's localResourceRoots cannot reach. Sent at most once per panel, as soon as
   * there is one to send -- it does NOT mean "draw textures", which is the panel's own switch
   * and the preference behind it (see previewPanel.ts's ensureTextures).
   *
   * 'textureStatus' is its counterpart in words: `available` plus, when there is no atlas, the
   * host's own honest `reason` for that -- nothing built here yet, a build that failed, a
   * download declined, the setting switched off. The panel can already tell WHETHER it can draw
   * textures; only a host can say why not (PanelHandle.setTextureStatus). */
  atlas?: AtlasWire
  /** 'attribution' -- the cells ONE graph node wrote in the run currently on screen, resolved
   * host-side against graph/attribution.ts's AttributionIndex (see previewPanel.ts's own header
   * for when a profile is asked for, and why it is not asked for the rest of the time).
   *
   * `available: false` is the ordinary, expected state, not an error: an engine too old to send
   * the table, a run that produced none, a regenerate that landed before the graph asked. It
   * clears the overlay and hides the readout, which leaves this webview drawing exactly what it
   * drew before any of this existed.
   *
   * `cells` may be SHORTER than `cellCount` -- see previewPanel.ts's ATTRIBUTION_CELL_LIMIT. The
   * readout reports the real total either way and names the shortfall rather than showing a
   * partial number as if it were the answer. */
  available?: boolean
  nodeId?: string | null
  cells?: number[]
  cellCount?: number
  shown?: number
  writes?: number
  /** 'attribution' -- EVERY feature that wrote in the run on screen, one entry per writer, in
   * the order their colours should be assigned (the selected node first, then by size; see
   * previewPanel.ts's attributionGroupsFor). `cells` above is the selected node's share of this
   * same list and stays on the wire as the single-writer shim: a frontend build that predates
   * VoxelViewer.setAttributionGroups still paints the node somebody selected rather than
   * nothing at all. */
  groups?: { id: string; label: string; cells: number[] }[]
  /** 'attributionCell' -- what the block the user just clicked turned out to belong to. EVERY
   * feature that wrote the cell, never narrowed to one; see graph/attribution.ts's header on why
   * no single writer can honestly be called the placer. */
  cell?: number
  /** 'restoreState' only -- which DOCUMENT this panel is previewing, plus whatever blob this
   * webview last handed the host. The key has to be written into this webview's own
   * setState(): on a window reload VS Code hands the HOST the webview's saved state and
   * nothing else, so it is the only thing that can say which document a revived tab was for
   * (see previewPanel.ts's postRestoreState and extension.ts's serializer). */
  key?: string
  state?: unknown
  position?: { x: number; y: number; z: number } | null
  writers?: { nodeId: string | null; writes: number }[]
}

const vscodeApi = acquireVsCodeApi()

const root = document.getElementById('fl-root') as HTMLElement | null
const canvas = document.getElementById('fl-canvas') as HTMLCanvasElement | null
const sidebar = document.getElementById('fl-sidebar') as HTMLElement | null

if (!root || !canvas || !sidebar) {
  throw new Error('featurelab webview: expected #fl-root, #fl-canvas and #fl-sidebar in the document')
}

// The shell ships a visible "if this stays here, this script did not load" sentence over the
// canvas (previewPanel.ts's PREVIEW_DID_NOT_START). Taking it down is this script's first act, so
// that the sentence being on screen is itself the diagnosis -- and it is done HERE, before the
// viewer is built, because a failure after this point has a panel that can report it in words
// while a failure before it has nothing at all.
document.getElementById('fl-boot')?.remove()

// Owns the sidebar's width (drag-resizable, collapsible, persisted) from here on -- created
// before the viewer so the canvas already has its real, restored size for the very first
// render/frameContent instead of briefly showing whatever width the host's own fallback CSS
// happened to declare. Never touches the viewer/camera itself -- see createSplitter's own doc
// comment for why a resize or collapse/expand can never reset camera position.
createSplitter({ container: root, sidebar })

const viewer = new VoxelViewer(canvas)
const panel = createPanel(sidebar, {
  viewer,
  // Every generation-config control change (Feature/Rule/Preset/Size/Materials/Biome/Origin/
  // Repeat -- see panel.ts's own header comment) round-trips through the extension host, which
  // owns the one live engine process (previewController.ts) -- this webview never talks to the
  // engine directly.
  //
  // Each of these three dispatch points marks the panel busy (so there is always an indication
  // that something is happening) the moment a request is actually SENT to the host -- not on some
  // later ack, since previewPanel.ts's own reply ('result'/'error', or 'stale' with stale:true)
  // is the only round trip this webview ever sees. panel.setBusy(false) is deliberately NOT
  // called anywhere in this file: panel.ts's own setResult/setError/setStale(true) already
  // clear it as a safety net (see applyBusy's doc comment there), so a message this switch
  // doesn't have a case for, or a request that never resolves at all (e.g. the extension host
  // itself crashes), can never leave this stuck showing "Generating…" forever.
  onConfigChange: (params: GenerateParamsWire) => {
    panel.setBusy(true)
    vscodeApi.postMessage({ type: 'generate', params })
  },
  onReloadFiles: () => {
    panel.setBusy(true)
    vscodeApi.postMessage({ type: 'reloadFiles' })
  },
  // previewPanel.ts now has the host-side 'growRegenerate' message case and growRegenerate()
  // method (calling PreviewController.generateGrown, added alongside this) -- see this repo's
  // task notes for why this callback was deliberately left unwired until both sides existed:
  // wiring it earlier would have made this button look live while silently doing nothing.
  onGrowRegenerate: (params: GenerateParamsWire) => {
    panel.setBusy(true)
    vscodeApi.postMessage({ type: 'growRegenerate', params })
  },
  // SEAM -- see CANCEL_MESSAGE_TYPE below. Deliberately NOT conditional: the message is posted,
  // and a host that has no case for it ignores it, exactly as this webview ignores host messages
  // it has no case for. The busy state is not cleared here on purpose: cancelling is a REQUEST to
  // the host, and only the host's own reply ('result', 'error', or 'stale') ends a request --
  // clearing it optimistically would show a finished-looking panel over a run still in flight.
  //
  // The CLICK is acknowledged regardless, by the pill itself: it reads "Cancelling…", stops
  // counting and stops offering to ask again the moment this fires (see viewportOverlay.ts), so a
  // host that has not yet grown a case for this message produces a request that visibly went
  // somewhere rather than a button that visibly did nothing.
  onCancel: () => {
    vscodeApi.postMessage({ type: CANCEL_MESSAGE_TYPE })
  },
})

const resizeObserver = new ResizeObserver(() => viewer.resize())
resizeObserver.observe(canvas)
window.addEventListener('resize', () => viewer.resize())

/** The live viewer, for a harness driving this page from outside it.
 *
 * scripts/capture-screenshots.mjs re-captures the committed apps/vscode/docs/panel-*.png
 * against this very bundle, and those images must render in flat-colour mode on any machine --
 * so it asserts getTexturesEnabled() is false rather than trusting that it never posted an
 * `atlas` message. An assertion that cannot see the thing it is asserting about is not an
 * assertion, which is why this hook exists. Read-only in practice; nothing in the extension
 * reads it. */
;(window as unknown as { __flViewer?: VoxelViewer }).__flViewer = viewer

/** The message this webview posts when the user clicks Cancel on the viewport's busy pill.
 *
 * A SEAM, named once so it is greppable from both sides. The engine's own `serve` protocol has
 * had request cancellation since cmd/featurelab/serve.go gained its `cancel` method
 * ({"method":"cancel","params":{"id":N}} -> {"cancelled":true|false}); what sits between that and
 * this line is the extension host, which owns the one live engine process and therefore the one
 * request id worth cancelling. Until previewPanel.ts has a case for this type, clicking Cancel
 * posts a message nobody listens to, which is inert rather than wrong -- and the moment that case
 * exists, this needs no change. If the host lands on a different name, change the constant here
 * and nothing else. */
const CANCEL_MESSAGE_TYPE = 'cancelGenerate'

// --- write attribution ------------------------------------------------------------------
//
// Two directions, one selection, and this half of it owns neither end of the decision. The host
// says which cells to paint; the host says what a clicked block belongs to. This file turns a
// gesture into a POSITION and a message into a picture, and knows nothing about nodes, files or
// profiles -- see previewPanel.ts's header for where all three are decided.

/** The shell's readout (see renderShellHtml in previewPanel.ts). Hidden, and empty, for every
 * preview nobody has asked this question of -- which is every preview until the graph does. */
const attributionReadout = document.getElementById('fl-attribution')

// INTO THE OVERLAY'S OWN COLUMN, not floating in the corner it already occupies. The shell
// styles this readout as `position: absolute; top: 8px; left: 8px; z-index: 5` -- which is the
// same corner as `.fl-vp-controls` (the Frame/Environment/Grid/Camera/Textures toolbar), one
// z-index above it. Whenever the readout was showing it covered the whole toolbar: 152x25px of
// overlap, the toolbar's full width and most of its height, two legible things making each other
// illegible. The buttons still took their clicks, which is exactly why it read as a rendering
// fault rather than as a layout bug.
//
// The overlay already stacks the busy pill, the one-line notice and the legend in a flex column
// that cannot overlap itself, so the readout joins it -- see ViewportOverlayHandle.adoptStatus.
// The element, its id, its role=status and its aria-live stay the shell's; only where it sits
// changes.
if (attributionReadout !== null) viewer.adoptOverlayStatus(attributionReadout)

/** True once the host has posted an attribution answer it could actually resolve. The ONLY
 * thing that arms click-to-pick: without it a left click in the 3D view does what it has always
 * done, which is nothing at all, and this webview posts no message the host would ignore. */
let attributionActive = false

function showAttribution(text: string | null): void {
  if (attributionReadout === null) return
  if (text === null) {
    attributionReadout.textContent = ''
    attributionReadout.hidden = true
    return
  }
  attributionReadout.textContent = text
  attributionReadout.hidden = false
}

/** Back to the preview this was before anybody asked the attribution question: no overlay, no
 * readout, no armed click.
 *
 * The picked-block marker is cleared only if THIS feature is what put one there. highlightCell
 * is also the Diagnostics section's "show me where" (panel.ts), and taking somebody's diagnostic
 * marker away would be this feature reaching outside itself. */
function clearAttribution(): void {
  showAttribution(null)
  if (!attributionActive) return
  attributionActive = false
  viewer.clearHighlight()
  viewer.setAttributionCells(null)
}

function describeWriters(msg: HostMessage): string {
  const writers = msg.writers ?? []
  const at = msg.position ? ` at ${String(msg.position.x)}, ${String(msg.position.y)}, ${String(msg.position.z)}` : ''
  if (writers.length === 0) {
    // A cell nothing placed is an ANSWER -- it is environment, or it is outside the volume --
    // and saying so beats a readout that goes blank and reads as a click that missed.
    return `Nothing in this pack placed the block${at}. It is environment, or outside the bench.`
  }
  // All of them, in the index's own deterministic order, and deliberately NOT labelled first or
  // last: the engine's table carries counts and no sequence, so which write a viewer is actually
  // looking at is not recoverable. Two features fighting over one cell is exactly the case
  // somebody clicks a block to understand, and picking one would answer it wrongly.
  const named = writers.map((w) => `${w.nodeId ?? '(unknown feature)'} (${String(w.writes)}x)`).join(', ')
  return writers.length === 1 ? `Placed${at} by ${named}.` : `Placed${at} by ${String(writers.length)} features: ${named}.`
}

// THE GESTURE LIVES IN THE VIEWER NOW (VoxelViewer.onPick), and this is what used to be a second
// copy of it. Both were live at once: the viewer's own pointerdown/pointerup pair -- which is
// also what drives the panel's "what did I just click on" readout, always armed since clicking a
// block started answering in every preview -- and an identical press-and-release-within-a-few-
// pixels handler on the same canvas here, so one click ran the whole pick twice (two raycasts,
// two highlightCell calls) and the two could only ever drift apart on the slop, the button or the
// depth rule. There is one now, and it is the one the frontend owns.
//
// CHAINED, NOT REPLACED. panel.ts has already installed its own onPick by the time this runs, so
// assigning over it would silently take the readout away from every preview -- including the
// ordinary ones this feature never touches. The host's message goes out after it, and only while
// the host is actually attributing something.
const panelPick = viewer.onPick
viewer.onPick = (pick) => {
  // The viewer has already marked the cell WITHOUT framing: the block is under the user's
  // pointer, so it is on screen, and moving the camera onto it would throw away the view they
  // chose in order to show them what they were already looking at.
  panelPick?.(pick)
  if (!attributionActive) return
  // A POSITION, and nothing else. The host owns the index, the bounds and the node ids.
  vscodeApi.postMessage({ type: 'pickCell', x: pick.x, y: pick.y, z: pick.z })
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'result': {
      try {
        const decoded = decodeGenerateResult(msg.result)
        // A NEW RUN IS A NEW SET OF CELLS, so last run's answer is not this run's answer.
        // The viewer already drops the overlay itself (setVolume clears the mask and the
        // legend), but this file's own half of the state did not go with it: the readout went
        // on naming a writer from a run that is no longer on screen, and `attributionActive`
        // stayed true, so every click in the 3D view kept posting `pickCell` for an index the
        // host had already replaced. The host re-posts `attribution` whenever it still has an
        // answer, exactly as it does after any other regenerate, so clearing here costs a live
        // selection nothing and costs a dead one its ghost.
        clearAttribution()
        panel.setResult(decoded)
        // The first result frames itself; every later one leaves the camera where the user left
        // it. That LATCH used to live here as a `framedOnce` boolean, which is precisely why
        // framing happened exactly once and never again -- a run that later placed its content
        // somewhere else left the camera pointed at empty space. The viewer now owns both halves
        // of the rule (hasFramed() for the first result, and its own re-frame when a result
        // escapes the framed box -- see reframeIfContentEscaped), so the two can no longer
        // disagree about what has been framed.
        if (!viewer.hasFramed()) viewer.frameContent()
      } catch (err) {
        panel.setError(err instanceof Error ? err.message : String(err))
      }
      break
    }
    case 'error':
      panel.setError(msg.message ?? 'unknown error')
      break
    case 'stale':
      panel.setStale(Boolean(msg.stale), msg.reason)
      break
    case 'restoreState':
      // THE KEY IS THE PART THAT MATTERS HERE, and it is written down whether or not there is
      // a blob to go with it: a revived tab with no key is a preview of nothing.
      //
      // The blob itself is not applied yet. What this webview would want back -- where the
      // camera was, and how the sidebar's view controls were set -- is not readable from
      // outside `featurelab-frontend` today: VoxelViewer exposes no camera get/set and
      // PanelHandle exposes no state at all. Guessing at it from the setters that do exist
      // would put the viewer and the sidebar's own controls into two different states, which
      // is a worse answer than not restoring. The round trip is wired; the contents wait on
      // that package.
      if (typeof msg.key === 'string') vscodeApi.setState({ key: msg.key })
      break
    case 'init':
      if (msg.kind && msg.identifier) panel.seedOpenedDocument(msg.kind, msg.identifier)
      break
    case 'environments':
      if (msg.environments) panel.setEnvironments(msg.environments)
      break
    case 'timeoutInfo':
      if (typeof msg.configuredMs === 'number' && typeof msg.effectiveMs === 'number') {
        panel.setTimeoutInfo({ configuredMs: msg.configuredMs, effectiveMs: msg.effectiveMs })
      }
      break
    case 'busy':
      if (msg.busy) panel.setBusy(true)
      break
    case 'attribution': {
      if (msg.available !== true) {
        // The expected, ordinary "no answer" state -- see the field's own doc comment. Back to
        // exactly the preview this was before anybody asked.
        clearAttribution()
        break
      }
      attributionActive = true
      // ONE COLOUR PER WRITER when the host sent the full set and this viewer can paint it;
      // the selected node alone otherwise. The fallback is not dead code: `setAttributionGroups`
      // is newer than `setAttributionCells`, and a bundle built against an older
      // featurelab-frontend has only the second -- in which case the host's own `cells` field is
      // exactly what it always was and the preview behaves exactly as it always did.
      const groups = msg.groups
      if (groups !== undefined && typeof viewer.setAttributionGroups === 'function') viewer.setAttributionGroups(groups)
      else viewer.setAttributionCells(msg.cells ?? [])
      const total = msg.cellCount ?? 0
      const shown = msg.shown ?? total
      const writes = msg.writes ?? 0
      const node = msg.nodeId ?? 'that node'
      if (total === 0) {
        // A node that ran and wrote nothing is an answer, and a common one -- a filter, an
        // aggregate, a feature whose placement was refused. Saying so is the difference between
        // "it placed nothing" and "the highlight is broken", which look identical on screen.
        showAttribution(`${node} placed no blocks in this run.`)
      } else {
        const shortfall = shown < total ? ` (showing the first ${shown.toLocaleString()})` : ''
        showAttribution(`${node}: ${total.toLocaleString()} block(s)${shortfall}, ${writes.toLocaleString()} write(s). Click a block to find what placed it.`)
      }
      break
    }
    case 'attributionCell':
      if (attributionActive) showAttribution(describeWriters(msg))
      break
    case 'atlas': {
      // Textures are an enhancement, never a requirement: anything that goes wrong here leaves
      // the viewer exactly where it already was, drawing flat per-block colours. The host has
      // already warned the user that the setting they turned on could not be honoured, so this
      // does not surface a second error into the panel's own error slot -- that slot is for a
      // failed GENERATE, and filling it with a texture problem would hide the result.
      if (!msg.atlas) break
      void (async () => {
        try {
          // DELIVERED, NOT SWITCHED ON. setTexturesEnabled(true) used to sit here, which made an
          // arriving atlas overrule whatever the user had chosen in the panel's own "Block
          // textures" row -- a preference they set in the sidebar, that the panel persists, and
          // that panel.ts re-applies for itself the moment an atlas lands (its
          // onTexturesChanged). The host's job ends at handing over the sheet.
          await viewer.setAtlas(decodeAtlas(msg.atlas))
        } catch (err) {
          console.warn('featurelab: block textures unavailable, staying on flat colours --', err)
          // The one texture failure the HOST cannot know about: it delivered an atlas and this
          // side could not decode or upload it. The row would otherwise keep the host's cheerful
          // "available" over a checkbox that can never be ticked.
          panel.setTextureStatus({ available: false, reason: `The block texture atlas could not be read here, so the preview draws one flat colour per block: ${err instanceof Error ? err.message : String(err)}` })
        }
      })()
      break
    }
    case 'textureStatus':
      // Straight through -- the host's own sentence, or nothing. See PanelHandle.setTextureStatus
      // for why a host that cannot say WHY is better off saying nothing than guessing: the panel
      // has neutral wording of its own for that.
      if (typeof msg.available === 'boolean') panel.setTextureStatus({ available: msg.available, ...(msg.reason === undefined ? {} : { reason: msg.reason }) })
      break
    default:
      break
  }
})

// The very first `generate` for this panel is triggered host-side (previewPanel.ts's
// constructor calls regenerate() itself, before this webview even exists to ask for it via
// onConfigChange above) -- mark busy here too so that initial load also reads as pending rather
// than a silent, indefinite blank sidebar. Cleared the same way every other request is (panel.
// ts's own setResult/setError/setStale(true) safety net), never explicitly here.
panel.setBusy(true)
vscodeApi.postMessage({ type: 'ready' })
