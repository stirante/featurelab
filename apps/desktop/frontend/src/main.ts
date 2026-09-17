// main.ts -- the desktop app's webview entry point. Owns the VoxelViewer/panel instances for
// the whole window lifetime (never recreated by a regenerate, exactly like
// apps/vscode/webview/main.ts's own instances) plus the toolbar that drives them, so
// regenerating on save never resets camera position or view settings -- see toolbar.ts and
// featurelab-frontend/src/ui/panel.ts's own doc comments for how that separation holds.
import './style.css'
import 'featurelab-frontend/panel.css'
import { VoxelViewer, createPanel, createSplitter, decodeAtlas, decodeGenerateResult } from 'featurelab-frontend'
import { createToolbar } from './toolbar.js'
import { toLoadPackResult, type GenerateParams } from './types.js'
import {
  AskForTextureDownload,
  BlockTexturesEnabled,
  DeclineTextures,
  EnsureTextures,
  Generate,
  GenerateGrown,
  ListEnvironments,
  LoadAtlas,
  LoadPack,
  SelectPackDirectory,
  TextureStatus,
} from '../wailsjs/go/main/App.js'
import { EventsOn } from '../wailsjs/runtime/runtime.js'

const main = document.getElementById('fl-main') as HTMLElement | null
const canvas = document.getElementById('fl-canvas') as HTMLCanvasElement | null
const sidebar = document.getElementById('fl-sidebar') as HTMLElement | null
const toolbarRoot = document.getElementById('fl-toolbar') as HTMLElement | null
if (!main || !canvas || !sidebar || !toolbarRoot) {
  throw new Error('featurelab desktop: expected #fl-main, #fl-canvas, #fl-sidebar and #fl-toolbar in the document')
}

// Owns the sidebar's width (drag-resizable, collapsible, persisted) from here on -- same
// shared module apps/vscode's webview uses, see createSplitter's own doc comment (frontend/src
// /ui/splitter.ts) for why this never touches the viewer/camera.
createSplitter({ container: main, sidebar })

const viewer = new VoxelViewer(canvas)
const panel = createPanel(sidebar, { viewer })

const resizeObserver = new ResizeObserver(() => viewer.resize())
resizeObserver.observe(canvas)
window.addEventListener('resize', () => viewer.resize())

/** True once the first result has been shown -- frameContent() (reset the camera to look at
 * what's actually occupied, see that method's own doc comment on VoxelViewer) only happens
 * automatically on THIS first result, exactly like the VS Code webview's own framedOnce.
 * Every subsequent result (a manual param change or a save-triggered regenerate) leaves the
 * camera exactly where the user left it. */
let framedOnce = false

/** Serializes regenerate() calls, exactly like apps/vscode's previewPanel.ts -- a rapid
 * sequence of toolbar edits (or an edit immediately followed by a "pack:changed" event) must
 * not let two Generate calls race and post their results out of order. */
let pending: Promise<void> = Promise.resolve()

function regenerate(params: GenerateParams): void {
  pending = pending.then(() => runGenerate(params))
}

/** Fires the "grow to fit and regenerate" action -- see toolbar.ts's ToolbarOptions.
 * onGrowRegenerate doc comment for why the toolbar (not featurelab-frontend's own panel.ts
 * Feature/Rule pickers) is what drives this in the desktop app. Serialized behind the same
 * `pending` queue as an ordinary regenerate, so the two can never race and post results out of
 * order. */
function regenerateGrown(params: GenerateParams): void {
  pending = pending.then(() => runGenerate(params, true))
}

async function runGenerate(params: GenerateParams, grow = false): Promise<void> {
  toolbar.setBusy(true)
  // panel.ts's own busy state (so a run never shows "no indication that anything is happening") -- distinct
  // from toolbar.setBusy above (which only disables the Regenerate button): this dims the stat
  // tiles and the 3D preview itself so a slow run reads as pending, not as a fresh/empty
  // result. The explicit setBusy(false) in `finally` below is belt-and-suspenders -- panel.ts's
  // own setResult/setError already clear it as a safety net on either outcome (see that
  // method's own doc comment), so this can never get stuck even if a future change to this
  // function's control flow skipped the `finally`.
  panel.setBusy(true)
  try {
    // Generate/GenerateGrown both return an already-JSON-encoded string, not a typed object --
    // see app.go's Generate doc comment for why (Wails' TS codegen cannot fully model
    // GenerateOutput's cross-package embedded fields, and GrownGenerateOutput embeds one too).
    // decodeGenerateResult validates the parsed shape itself, and already reads the extra
    // `grown`/`preGrowBounds` fields a GenerateGrown response carries (see protocol.ts) -- no
    // separate decode path needed for the grown case.
    //
    // The cast below is this file's own header-comment tradeoff paying off: `params` is a
    // plain object satisfying this file's own GenerateParams interface, not an instance of
    // wailsjs/go/models' generated `wire.GenerateParams` class -- and since that class now
    // has a nested field (materials), Wails' codegen gave it a `convertValues` method, which
    // a plain object structurally lacks. The wire shape (JSON field names) is identical
    // either way; only the outbound TS call needs telling.
    const call = grow ? GenerateGrown : Generate
    const raw = JSON.parse(await call(params as Parameters<typeof Generate>[0]))
    const decoded = decodeGenerateResult(raw)
    panel.setResult(decoded)
    lastPalette = decoded.palette
    reportBlockNotes(decoded.palette)
    panel.setStale(false)
    if (!framedOnce) {
      viewer.frameContent()
      framedOnce = true
    }
  } catch (err) {
    // Never leave a silently frozen preview: any failure -- the engine rejecting the
    // request, or decodeGenerateResult finding the response malformed -- surfaces as a
    // visible error banner, exactly like apps/vscode's previewPanel.ts does for the
    // equivalent failure modes.
    panel.setError(err instanceof Error ? err.message : String(err))
  } finally {
    toolbar.setBusy(false)
    panel.setBusy(false)
  }
}

const toolbar = createToolbar(toolbarRoot, {
  onOpenPack: () => {
    void (async () => {
      try {
        const dir = await SelectPackDirectory()
        if (!dir) return // user cancelled
        toolbar.setPackError(null)
        const result = await LoadPack(dir)
        toolbar.setPackInfo(toLoadPackResult(result))
        // A pack's OWN blocks are drawn from the same atlas vanilla's are, so opening one
        // makes whatever was built before out of date -- 40% of the distinct block names a
        // real preview places are the pack's own, and without this they stay hash colours.
        // Rebuilding needs no network once the vanilla assets are cached, so this is not a
        // second question: it just happens, with a line in the notice bar saying so.
        void setUpTextures()
      } catch (err) {
        toolbar.setPackError(err instanceof Error ? err.message : String(err))
      }
    })()
  },
  onGenerate: (params) => regenerate(params),
  onGrowRegenerate: (params) => regenerateGrown(params),
})

void (async () => {
  try {
    const envs = await ListEnvironments()
    toolbar.setEnvironments(envs)
    // panel.ts's OWN Environment section also has a Preset <select> (populated via
    // PanelHandle.setEnvironments, same live-engine-data contract apps/vscode's
    // previewPanel.ts feeds it from cmd/featurelab's `environments` serve method) -- this app
    // does not drive generation from that control today (toolbar.ts above is what
    // onGenerate/regenerate actually listens to, see panel.ts's own header comment, "Known
    // gaps" / desktop-toolbar note), but leaving it permanently empty would be a visible dead
    // control in this app's sidebar. Feed it from the SAME envs this call already fetched,
    // adapted to the richer wire shape -- materials/biome/biomeTags are blank because
    // app.go's own EnvironmentOption (unlike cmd/featurelab/environments.go's) does not carry
    // them; only Size X/Y/Z/Min Y resync on a Preset change here, not materials/biome
    // placeholders. Filling those in too is tracked alongside the rest of "unify this app's
    // toolbar and panel.ts" (see panel.ts's header comment) -- not done here.
    panel.setEnvironments(
      envs.map((e) => ({
        id: e.id,
        label: e.label,
        description: e.description,
        defaults: { sizeX: e.defaultSizeX, sizeY: e.defaultSizeY, sizeZ: e.defaultSizeZ, minY: e.defaultMinY },
        materials: { topMaterial: '', midMaterial: '', foundationMaterial: '', seaFloorMaterial: '', seaMaterial: '', seaFloorDepth: 0 },
        biome: '',
        biomeTags: [],
        // Forwarded, unlike the three blanks above, because it is the flag that DISABLES them.
        // app.go carries buildsSea precisely so a client can grey out sea_floor_material /
        // sea_material / sea_floor_depth under a preset that ignores them, instead of showing
        // three live-looking inputs that do nothing until the run comes back with a warning
        // saying so. It was added to the wire and never forwarded here, so this app had exactly
        // the dead controls the flag exists to prevent.
        buildsSea: e.buildsSea,
      })),
    )
  } catch (err) {
    toolbar.setPackError(err instanceof Error ? err.message : String(err))
  }
})()

// Block textures -- the first run, and every run after it.
//
// The whole flow lives in Go (featurelab/blocktextures) so the three hosts ask the same
// question, fetch the same thing into the same place and say the same words about it. This
// function is only the desktop app's share: when to run it, and where its sentences go.
//
// ON WHENEVER AN ATLAS CAN EXIST, which is the point of the feature: the switch that must stay
// off is the one in the committed-image pipeline (docs/wiki/tools/ pins textures off
// explicitly), not the one in front of a person using the app. FEATURELAB_BLOCK_TEXTURES=0
// turns them off here for someone who wants flat colours back.
//
// Never routed into setPackError: none of this is a problem with the user's pack, and none of
// it stops the preview working. It goes in the notice line, because a preview that quietly
// looks exactly as it did before is indistinguishable from a broken feature.
let texturesRunning = false

/** Block name -> what it actually draws as, for this pack's own blocks that this renderer
 * cannot draw exactly (a resource-pack model geometry, drawn as a textured cube). Mined out of
 * the atlas table, which carries the note per block precisely so a host can show only the ones
 * a given preview PLACED -- a pack with two hundred blocks and two dozen notes has nothing to
 * say about a preview that placed neither. */
let blockNotes = new Map<string, string>()
let reportedBlockNotes = false
let lastPalette: readonly { name: string }[] = []

function notesFromAtlas(atlas: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const blocks = (atlas as { table?: { blocks?: unknown } } | null)?.table?.blocks
  if (!blocks || typeof blocks !== 'object') return out
  for (const [name, entry] of Object.entries(blocks as Record<string, unknown>)) {
    const note = (entry as { note?: unknown })?.note
    if (typeof note === 'string' && note !== '') out.set(name, note)
  }
  return out
}

/** Says, once, how many of the blocks THIS preview placed are drawn as something other than
 * what the pack declared. Not an error and not a diagnostic: using a resource-pack model
 * geometry is a perfectly ordinary thing for a pack to do, and this renderer draws those as a
 * textured cube. */
function reportBlockNotes(palette: readonly { name: string }[]): void {
  if (reportedBlockNotes || blockNotes.size === 0) return
  const placed = [...new Set(palette.map((p) => p.name))].filter((name) => blockNotes.has(name)).sort()
  if (placed.length === 0) return
  reportedBlockNotes = true
  toolbar.setNotice(
    `${placed.length} block(s) here draw as a textured cube because their geometry is a resource-pack model: ${placed.join(', ')}.`,
  )
}

async function setUpTextures(): Promise<void> {
  if (texturesRunning) return
  texturesRunning = true
  // A different pack means a different set of notes, and the ones already shown were about the
  // pack that is no longer open.
  reportedBlockNotes = false
  try {
    if (!(await BlockTexturesEnabled())) return
    let status = JSON.parse(await TextureStatus()) as { state: string; detail: string; needsDownload: boolean }
    if (status.state === 'declined') return
    if (status.state === 'missing' || status.state === 'stale') {
      // The ask, and the only thing that can lead to a download. A machine that already has
      // Mojang's assets (a cache, or FEATURELAB_VANILLA_PACK) is never asked: the question is
      // about the network, and that path has none.
      let download = false
      if (status.needsDownload) {
        download = await AskForTextureDownload()
        if (!download) {
          await DeclineTextures()
          toolbar.setNotice(
            'Block textures were declined; the preview draws flat block colours. ' +
              'Run "featurelab textures -download" to change that.',
          )
          return
        }
      }
      toolbar.setNotice('Building block textures…')
      const result = JSON.parse(await EnsureTextures(download)) as { status: { state: string; detail: string } }
      status = { ...result.status, needsDownload: false }
    }
    if (status.state !== 'ready') {
      toolbar.setNotice(status.detail)
      return
    }
    const atlas = JSON.parse(await LoadAtlas()) as unknown
    await viewer.setAtlas(decodeAtlas(atlas))
    viewer.setTexturesEnabled(true)
    blockNotes = notesFromAtlas(atlas)
    toolbar.setNotice(null)
    // The atlas usually arrives after the first result, so what is already on screen is
    // reported here rather than waiting for the next regenerate.
    reportBlockNotes(lastPalette)
  } catch (err) {
    // Offline, a proxy that breaks TLS, an unwritable cache, a PNG this webview cannot
    // decode: one sentence, once, and the preview carries on in flat colours.
    const message = err instanceof Error ? err.message : String(err)
    toolbar.setNotice(`Block textures are unavailable (${message}); the preview draws flat block colours.`)
  } finally {
    texturesRunning = false
  }
}

void setUpTextures()

/** The first line of a multi-line progress notice -- Piece A's download announcement is a
 * dozen lines of prose meant for a terminal, and the notice bar is one line high. The whole
 * text is what the dialog already showed before anything was fetched. */
function firstLine(text: string): string {
  const cut = text.indexOf('\n')
  return cut < 0 ? text : text.slice(0, cut)
}

// What the download and the build are doing, while they are doing it. A 150 MB fetch with no
// sign of life reads as a hang.
EventsOn('textures:progress', (line: string) => {
  if (!texturesRunning) return
  toolbar.setNotice(firstLine(line))
})

// The core loop: a file under the watched pack root changed on disk (apps/desktop/watcher.go,
// debounced) and app.go has already reloaded the pack from disk by the time this event
// fires -- regenerate with whatever the user currently has configured. If nothing is
// selected yet, getParams() returns null and there is nothing to do.
EventsOn('pack:changed', () => {
  panel.setStale(true, 'Pack changed on disk -- regenerating…')
  const params = toolbar.getParams()
  if (params) regenerate(params)
  else panel.setStale(false)
})

EventsOn('pack:reloadError', (message: string) => {
  panel.setStale(true, `Failed to reload the pack after a file change: ${message}`)
})
