// webview/main.ts -- the webview-side script, bundled by esbuild.config.mjs into
// dist/webview.js (three.js and the rest of featurelab-frontend included, per this
// package's "bundle three.js locally, no CDN" requirement -- see esbuild's own --bundle).
// Talks to the extension host purely via postMessage; owns the VoxelViewer/panel instances
// for this webview's whole lifetime so regenerating never rebuilds them (that's what
// preserves camera position and every view control across a save-triggered regenerate).
import { VoxelViewer, createPanel, createSplitter, decodeAtlas, decodeGenerateResult } from 'featurelab-frontend'
import type { AtlasWire, EnvironmentOptionWire, GenerateParamsWire, Mode } from 'featurelab-frontend'
import 'featurelab-frontend/panel.css'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

interface HostMessage {
  type: 'result' | 'error' | 'stale' | 'init' | 'environments' | 'timeoutInfo' | 'busy' | 'atlas' | 'attribution' | 'attributionCell'
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
   * this webview's localResourceRoots cannot reach. Sent at most once per panel, and only when
   * featurelab.blockTextures is on (see previewPanel.ts's tryPostAtlas). */
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
  /** 'attributionCell' -- what the block the user just clicked turned out to belong to. EVERY
   * feature that wrote the cell, never narrowed to one; see graph/attribution.ts's header on why
   * no single writer can honestly be called the placer. */
  cell?: number
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

/** True once the first result has been shown -- frameContent() (reset the camera to look at
 * what's actually occupied, see that method's own doc comment) only happens automatically on
 * THIS first result. Every subsequent result (a save-triggered regenerate) leaves the camera
 * exactly where the user left it -- this is the "without losing camera position" requirement,
 * enforced here rather than in viewer.ts itself (setVolume never touches the camera at all,
 * see that file). */
let framedOnce = false

// --- write attribution ------------------------------------------------------------------
//
// Two directions, one selection, and this half of it owns neither end of the decision. The host
// says which cells to paint; the host says what a clicked block belongs to. This file turns a
// gesture into a POSITION and a message into a picture, and knows nothing about nodes, files or
// profiles -- see previewPanel.ts's header for where all three are decided.

/** The shell's readout (see renderShellHtml in previewPanel.ts). Hidden, and empty, for every
 * preview nobody has asked this question of -- which is every preview until the graph does. */
const attributionReadout = document.getElementById('fl-attribution')

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

// The gesture. The left button is also how OrbitControls orbits, so a press that MOVED the
// camera must not also pick -- otherwise every rotation ends by selecting whatever happened to
// be under the pointer when the hand stopped. So a pick is a press and a release within a few
// pixels of each other, which is what "a click" means to a hand, and what no single DOM event
// can tell you on its own (a `click` fires after a drag too).
const PICK_SLOP_PX = 4
let pressedAt: { x: number; y: number } | null = null

canvas.addEventListener('pointerdown', (event: PointerEvent) => {
  pressedAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null
})
canvas.addEventListener('pointerup', (event: PointerEvent) => {
  const down = pressedAt
  pressedAt = null
  if (!attributionActive || down === null || event.button !== 0) return
  if (Math.abs(event.clientX - down.x) > PICK_SLOP_PX || Math.abs(event.clientY - down.y) > PICK_SLOP_PX) return
  const cell = viewer.pickCell(event.clientX, event.clientY)
  if (cell === null) return
  // Marked WITHOUT framing: the block is under the user's pointer, so it is already on screen,
  // and moving the camera onto it would throw away the view they chose in order to show them
  // what they were already looking at.
  viewer.highlightCell(cell.x, cell.y, cell.z, { frame: false })
  // A POSITION, and nothing else. The host owns the index, the bounds and the node ids.
  vscodeApi.postMessage({ type: 'pickCell', x: cell.x, y: cell.y, z: cell.z })
})

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'result': {
      try {
        const decoded = decodeGenerateResult(msg.result)
        panel.setResult(decoded)
        if (!framedOnce) {
          viewer.frameContent()
          framedOnce = true
        }
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
        //
        // The picked-block marker is cleared only if THIS feature is what put one there.
        // highlightCell is also the Diagnostics section's "show me where" (panel.ts), and taking
        // somebody's diagnostic marker away because an unrelated regenerate came back unprofiled
        // would be this feature reaching outside itself.
        if (attributionActive) viewer.clearHighlight()
        attributionActive = false
        viewer.setAttributionCells(null)
        showAttribution(null)
        break
      }
      attributionActive = true
      viewer.setAttributionCells(msg.cells ?? [])
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
          await viewer.setAtlas(decodeAtlas(msg.atlas))
          viewer.setTexturesEnabled(true)
        } catch (err) {
          console.warn('featurelab: block textures unavailable, staying on flat colours --', err)
        }
      })()
      break
    }
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
