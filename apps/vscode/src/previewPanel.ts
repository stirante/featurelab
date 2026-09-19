// previewPanel.ts -- one webview panel per previewed feature file. Owns posting fresh
// generate results / errors / staleness to the webview, and mirroring engine diagnostics
// onto the VS Code Diagnostics API for the underlying document. Never touches the webview's
// camera/view state directly -- that state lives entirely on the webview side
// (frontend/src/viewer.ts, frontend/src/ui/panel.ts), which is what makes "regenerate on
// save without losing camera position or settings" hold: this class only ever posts a new
// `result` message, it never recreates the webview or its viewer.
//
// # Who decides what a regenerate asks for
//
// panel.ts (frontend/src/ui/panel.ts) owns a full set of generation-config controls
// (Feature/Rule/Preset/Size/Materials/Biome/Origin/Repeat). Whenever the user changes one, the
// webview posts `{type: 'generate', params}` (see webview/main.ts) and this class remembers it
// as `lastParams`. Every regenerate() call -- whether triggered by a document save or by that
// message -- sends `lastParams` if it has one, and otherwise falls back to `{feature: <parsed
// from the open file>, env: <the featurelab.env setting>}`, exactly this file's original,
// pre-panel behaviour. This is what keeps "preview this file, update it on save"
// working out of the box while still letting the panel's controls take over once the user
// actually touches one -- see regenerate()'s own comment for the exact fallback rule.
//
// # Write attribution, and who pays for it
//
// This panel can also answer "which blocks did THAT node place" and "which node placed THIS
// block", in both directions, against graph/attribution.ts's AttributionIndex. Both need the
// engine's per-cell attribution table, which only exists on a run made with GenerateParams
// .profile set -- and profiling is not free, which is the whole reason it is a request field
// rather than always-on.
//
// SO IT IS NEVER ASKED FOR ON ITS OWN. A panel asks for a profile if, and only if, it is in
// attribution mode, which it enters exactly once: when the GRAPH panel hands this one a node to
// attribute (GraphPanel.previewNode -> extension.ts -> attributeNode below). That is a person
// having turned the graph's own "Preview on select" on and picked a node -- an explicit request
// for this feature, by someone already being told that running a feature is not free. A preview
// opened the ordinary way (the command, the keybinding, a save-triggered regenerate on a panel
// nobody asked this of) sends byte-for-byte the request it always sent, and pays nothing.
//
// AND IT IS NEVER REQUIRED. An engine too old to send `profile.attribution`, a run that failed
// to produce one, a node that ran and wrote nothing -- every one of those leaves the preview
// doing exactly what it does today, with the overlay off and no message anywhere. Attribution
// is an enhancement on top of a preview, never a precondition for one; see applyAttribution.
//
// The same profile pays for a second thing at no extra cost: the per-feature rows (entered /
// blocksWritten / delegations) go back to the graph so it can put them on its node cards, which
// is graph/nodeStats.ts's job. Same gate, same message, same run -- nothing about that widens
// who asks the engine for a profile.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { EngineCrashedError, MalformedResponseError, RequestCancelledError, RequestTimeoutError, RpcError } from './engineProcess.js'
import { DocumentParseError, PackRootError, isEngineLoadedPackFile, parseDocumentIdentifier, resolvePackRoot } from './identifier.js'
import { EngineDisposedError, type PreviewController } from './previewController.js'
import { updateDiagnostics, type DiagnosticWireLike } from './diagnostics.js'
import { brokenFiles, describeBrokenFiles, describePackContents, diagnosticLocation, scopedForPreview } from './packContents.js'
import {
  AttributionIndex,
  createAttributionBridge,
  type AttributionBridge,
  type AttributionSelection,
  type CellBounds,
  type ProfileWire,
} from './graph/attribution.js'
import type { RunStatsWire } from './graphPanel.js'
import {
  TextureBuilder,
  TextureCommandError,
  notesForPalette,
  notesFromAtlas,
  summarizeUnresolved,
  unresolvedFromAtlas,
  unresolvedRows,
  unresolvedTotal,
  type TextureStatusWire,
  type UnresolvedTextureWire,
} from './textures.js'
import { describeError, fail, log, output, warn } from './log.js'
import { showBusy } from './progress.js'
import { ATTRIBUTION_SERIES_LENGTH, ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS } from 'featurelab-frontend'
import type { EnvironmentOptionWire, GenerateParamsWire } from 'featurelab-frontend'

// How much headroom to add above whatever placement time limit a `generate` request will
// actually run with (the request's own placementTimeLimitMs, or the engine's built-in default
// when the request left it unset -- see ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS's own doc
// comment) when computing how long THIS extension waits for a response. The placement budget
// only bounds the engine's own placement loop -- it does not account for library-build time
// (only present on... actually irrelevant here, `generate` reuses an already-loaded Workspace,
// see wire's own "Duration fields" doc comment), JSON-encoding a potentially large volume, or
// plain process-scheduling/IPC latency, all of which sit OUTSIDE the budget the engine is
// timing itself against. 10s is generous slack for that overhead without being so large that a
// genuinely dead engine takes forever to report as stale.
const REQUEST_TIMEOUT_MARGIN_MS = 10_000

/** The most attributed cells this panel will ship to its webview for one selection.
 *
 * Not a rendering limit -- the viewer meshes a mask and does not care how full it is -- but a
 * MESSAGE limit: a cell list crosses the host/webview boundary as JSON, so a feature that
 * rewrote a whole 96x384x96 volume would be three and a half million numbers, about 25 MB,
 * serialised and parsed on every selection. A quarter of a million cells is roughly 1.7 MB and
 * is already an order of magnitude past anything a real feature writes (a large tree is in the
 * thousands), so this can only fire on a node that covers most of a volume -- where the
 * difference between "all of it" and "the first quarter million of it" is not what somebody is
 * looking at anyway.
 *
 * When it fires the panel says so rather than quietly drawing a partial answer: the count the
 * webview shows is the REAL total, with the shortfall named. */
const ATTRIBUTION_CELL_LIMIT = 250_000

/** How many writers this panel gives a colour of their own before it groups the rest.
 *
 * The viewer's own ceiling, imported rather than retyped (frontend/src/colors.ts's attribution
 * series): past the end of that series the colours repeat, and a seventh writer drawn in the
 * first one's colour is a legend that lies. So the largest few get a colour each and everything
 * behind them becomes one honest "+N more features" band -- see attributionGroupsFor. */
const ATTRIBUTION_GROUP_LIMIT = ATTRIBUTION_SERIES_LENGTH

/** The id of the "everything past the palette" band -- see attributionGroupsFor. Deliberately
 * not a node id, and deliberately not spellable as one: a host reading getAttributionGroups()
 * back must not be able to mistake the band for a feature it can select. */
export const ATTRIBUTION_TAIL_GROUP_ID = 'featurelab.attribution.more'

/** What the host tells the panel when block textures are switched off in settings.
 *
 * The row in the sidebar is otherwise inert with no explanation, which is the one shape a
 * setting must never take: a control that cannot be turned on and does not say why. Exported
 * because it is a sentence somebody reads. */
export const TEXTURES_DISABLED_REASON =
  'Block textures are switched off by the featurelab.blockTextures setting, so the preview draws one flat colour per block. Turn that setting on to have Feature Lab prepare an atlas.'

/** What the host tells the panel (and says once in a notification) after "Never". */
export const TEXTURES_DECLINED_REASON =
  'Block textures were declined on this machine, so the preview draws flat block colours. Run "Feature Lab: Refresh Block Textures" from the Command Palette to be asked again.'

/** The one gesture that undoes a decline from inside the editor -- named here rather than in
 * extension.ts because this file is what has to TELL somebody about it (see
 * TEXTURES_DECLINED_REASON), and a command id spelled twice is a sentence that goes stale the
 * first time the id moves. Registered in extension.ts; contributed in package.json. */
export const REFRESH_TEXTURES_COMMAND = 'featurelab.refreshBlockTextures'

/** Which of the three reasons a panel is asking about block textures.
 *
 * They differ in exactly two things -- whether the user may be INTERRUPTED with the download
 * question, and whether a recorded "no" is taken as final -- and both of those are decisions
 * only the caller can make:
 *
 *   - 'initial': the webview just came up. One question at most, and a decline is respected in
 *     silence.
 *   - 'refresh': a regenerate just finished. NEVER asks anything and never reaches the network;
 *     it exists so that an atlas that went stale while this panel was open (a texture repainted,
 *     a block file edited -- the engine detects both by content hash) is rebuilt from assets
 *     already on the machine instead of the panel drawing last week's sheet for the rest of the
 *     session. Says nothing at all when nothing changed.
 *   - 'user': somebody ran the refresh command. This is the ONLY mode that reopens a recorded
 *     decline, because it is the only one where the user asked. */
type TextureCheckMode = 'initial' | 'refresh' | 'user'

/** The wait THIS extension should actually use for a `generate` request carrying `params`,
 * given the user's configured featurelab.requestTimeoutMs -- comfortably above whatever
 * placement budget the request will run with (see REQUEST_TIMEOUT_MARGIN_MS's own doc comment),
 * never below it. This fixes a coupling between the two settings: without
 * it, raising placementTimeLimitMs in the panel's Budget section above the extension's own
 * request-timeout setting would make a successful-but-slow run get reported as a dead engine
 * partway through, even though the engine was still working. Exported so previewPanel.test.ts
 * can assert on it directly rather than only through PreviewPanel's own side effects. */
export function effectiveGenerateTimeoutMs(configuredTimeoutMs: number, params: GenerateParamsWire): number {
  const placementBudget = params.placementTimeLimitMs ?? ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS
  return Math.max(configuredTimeoutMs, placementBudget + REQUEST_TIMEOUT_MARGIN_MS)
}

/** What the webview posts when the user clicks Cancel on the viewport's busy pill.
 *
 * The other half of webview/main.ts's CANCEL_MESSAGE_TYPE, spelled here rather than imported
 * because the two halves are a PROTOCOL: this file is bundled for Node and that one for the
 * browser, and a shared constant would be a build-time dependency between them where what
 * actually exists is a message on a wire. Named so both sides are greppable from either. */
export const CANCEL_MESSAGE_TYPE = 'cancelGenerate'

/** Where the webview's own view state is kept between one panel and the next -- the 3D camera
 * above all, and whatever else panel.ts decides is worth keeping that this class does not already
 * hold in `lastParams`.
 *
 * Per DOCUMENT, because a preview is about a file. Opaque to this host: the webview hands a blob
 * over (`persistState`) and is handed it back (`restoreState`), so the side that knows what a
 * camera is decides what is worth keeping. Exported so the tests name the same key. */
export function previewViewStateKey(documentUri: string): string {
  return `featurelab.preview.viewState:${documentUri}`
}

/** Where THIS class's own state is kept -- the generation params (which is the seed, the origin,
 * the repeat count, the environment preset and the sizes, all of them already fields of
 * GenerateParamsWire) plus whether the last request was a grown one.
 *
 * Deliberately separate from previewViewStateKey: this half is the host's, it is read by the host
 * on revival, and folding it into an opaque webview blob would mean the host could only recover
 * its own state by parsing something it does not own. */
export function previewParamsKey(documentUri: string): string {
  return `featurelab.preview.params:${documentUri}`
}

/** The shape stamp on what previewParamsKey holds. Bump it whenever the blob's meaning changes;
 * a blob of any other version is discarded rather than interpreted, which is the whole point of
 * having one -- workspaceState survives an extension update, so the code that reads this is
 * routinely NOT the code that wrote it. */
export const PREVIEW_PARAMS_VERSION = 1

/** What previewParamsKey holds. Every field optional because this is read off disk: a blob
 * written by an older build, by a newer one, or by a hand-edited workspace file is an ordinary
 * thing to find here, not an error. */
export interface RememberedPreviewParams {
  version?: number
  /** The identifier the previewed document declared WHEN THESE PARAMS WERE SAVED. The freshness
   * check -- see freshPreviewParams. */
  identifier?: string | null
  params?: GenerateParamsWire | null
  grown?: boolean
}

/** What a revived tab should actually generate, from what was remembered and what the file says
 * NOW.
 *
 * # The freshness question, and what was decided
 *
 * A reload replayed `{feature, seed, originX, repeat, sizeX}` verbatim with nothing checked at
 * all: no version, no hash, no mtime. Between the two windows a feature can be renamed, deleted,
 * or replaced by a different one at the same path, and the tab would come back confidently
 * previewing a name the pack no longer has.
 *
 * NO mtime AND NO CONTENT HASH. Both would answer a question nobody asked. The bench settings --
 * the seed, the origin, the sizes, the repeat count, the preset -- are the author's deliberate
 * setup, they are expensive to retype, and they do not go stale when a file is edited: a run at
 * seed 42 in a 64-wide bench is exactly as meaningful against the new bytes as against the old.
 * Throwing them away on every edit (which is what an mtime check does -- the previewed file is
 * saved constantly) would be a reload that silently reset the author's work, traded for nothing.
 *
 * WHAT CAN GO STALE IS THE NAME, and only the name. So this checks the ONE field that can be
 * wrong -- the identifier the params name -- against the one authority on it, the file itself,
 * remembered alongside the params so the comparison needs no filesystem, no clock and no engine.
 * A file that still declares what it declared keeps everything. A file that now declares
 * something else keeps its bench and loses its feature/rule, dropping back to the file-derived
 * fallback this panel opens with -- which is "preview what this file is about", the correct
 * answer for a tab whose file was renamed underneath it.
 *
 * A blob with no version is a pre-stamp one: its params are dropped whole, because it carries no
 * identifier to check them against and guessing is what this function exists to stop. */
export function freshPreviewParams(
  remembered: RememberedPreviewParams | null | undefined,
  currentIdentifier: string | null,
): { params: GenerateParamsWire | null; grown: boolean } {
  const grown = remembered?.grown === true
  if (remembered?.version !== PREVIEW_PARAMS_VERSION) return { params: null, grown: false }
  const params = remembered.params
  if (params === null || params === undefined || typeof params !== 'object') return { params: null, grown }
  const was = remembered.identifier
  // Nothing was remembered to compare against (the file did not parse when the params were
  // saved), or it still says the same thing. Either way there is no evidence of a rename.
  if (typeof was !== 'string' || was.length === 0 || currentIdentifier === null || was === currentIdentifier) {
    return { params, grown }
  }
  const { feature: _feature, rule: _rule, ...bench } = params as GenerateParamsWire & { rule?: string }
  return { params: bench as GenerateParamsWire, grown }
}

/** What a preview panel needs handed back when VS Code revives its tab after a window reload --
 * see extension.ts's serializer, and PreviewPanel's own constructor.
 *
 * The panel is ALREADY THERE: VS Code recreated the tab, in the group the author had put it in,
 * before this extension was activated. So there is nothing to create and nothing to place, and
 * the constructor takes this one over instead of making its own. */
export interface RevivedPreview {
  readonly panel: vscode.WebviewPanel
  /** The params the panel was last generating with, off previewParamsKey. Null restores the
   * ordinary "preview the open file's own identifier" fallback. */
  readonly params?: GenerateParamsWire | null
  readonly grown?: boolean
}

interface WebviewToHostMessage {
  type: 'ready' | 'generate' | 'reloadFiles' | 'growRegenerate' | 'pickCell' | 'cancelGenerate' | 'persistState'
  params?: GenerateParamsWire
  /** 'persistState' only -- the webview's own opaque blob. See previewViewStateKey. */
  state?: unknown
  /** 'pickCell' only -- a WORLD POSITION the user clicked in the 3D view, which this host turns
   * into a cell index and then into the node(s) that wrote it.
   *
   * Three numbers and nothing else, deliberately. The webview is the least privileged half of
   * this pair: it names what the user pointed at, and the host decides what that means. A
   * message carrying a node id, a file or a cell index would be the webview deciding one of
   * those three for itself -- and a position outside the previewed volume is an ordinary thing
   * for a click to be (entryAt answers cell -1 for it), not something to validate against. */
  x?: number
  y?: number
  z?: number
}

/** The surface previewController.ts's PreviewController is expected to grow a `generateGrown`
 * method onto, for "grow to fit and regenerate" (expand the bench bounds to cover blocks a
 * feature wrote outside them, then generate again at the larger size). Declared locally --
 * rather than adding it directly to PreviewController's own class -- because previewController.
 * ts is a different, concurrently-in-progress change this file doesn't own; this interface is a
 * compile-time description of that method's expected shape, not a stand-in implementation, so
 * growRegenerate() below can be wired now without inventing or stubbing generateGrown itself.
 * Once previewController.ts actually adds a real generateGrown matching this signature, the
 * cast in growRegenerate() below resolves to exactly what it already reads: a plain method
 * call -- nothing else needs to change on this side. */
interface GrowCapablePreviewController {
  generateGrown(packRoot: string, params: GenerateParamsWire, timeoutMs: number, signal?: AbortSignal): Promise<unknown>
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/** What the preview says before its own script has run a single line.
 *
 * SHIPPED IN THE STATIC HTML, and the only sentence in this panel that is. Every other thing a
 * preview ever says -- the error slot, the stale banner, "no blocks were placed" -- is written by
 * dist/webview.js, which cannot say anything at all in the one case this covers: the script did
 * not load. A file excluded from the VSIX, a Content-Security-Policy that rejects the bundle, a
 * corrupted install -- each produces a panel that opens, takes a tab, and is a blank rectangle
 * forever, indistinguishable from an editor that is merely slow. The graph panel has had this
 * sentence and its 15-second backstop since the identical report was made about it
 * (graphPanel.ts's WEBVIEW_DID_NOT_START); the preview shipped with neither.
 *
 * webview/main.ts removes it as its first act, so this text still being on screen IS the
 * diagnosis. Deliberately NOT hidden by default -- hidden-by-default is what makes a blank panel
 * possible in the first place. */
export const PREVIEW_DID_NOT_START =
  'Starting the preview&hellip; If this message stays here, this panel&#39;s script did not load &mdash; ' +
  'run &quot;Feature Lab: Show Log&quot; for the reason.'

/** How long to wait for the webview to say its script is running, before telling the command that
 * opened this panel that it never will.
 *
 * The SAME 15 seconds and the same reasoning as the graph's WEBVIEW_READY_TIMEOUT_MS: without it,
 * a preview whose bundle does not load leaves the command's progress notification spinning
 * forever, because the first result is only ever posted to a webview that reported `ready`.
 * Generous on purpose -- a backstop for a panel that is never coming, not a performance budget. */
const WEBVIEW_READY_TIMEOUT_MS = 15_000

export interface ShellHtmlParams {
  nonce: string
  cspSource: string
  scriptUri: string
  styleUri: string
  /** Identifies the workspace this panel belongs to, so the webview can scope its persisted
   * state. A VS Code webview's localStorage is per EXTENSION -- not per panel, per window or
   * per workspace -- so without this, two windows on two different packs share one blob of
   * state and a biome picked in one shows up (and fails to resolve) in the other. Delivered
   * as a body attribute rather than the `init` message because panel.ts reads storage while
   * constructing, before any message can arrive. Empty string when no folder is open. */
  workspaceId: string
}

/** A short, stable id for a workspace, derived from its folder path.
 *
 * Hashed rather than used raw: this string ends up in the DOM and in localStorage keys, and a
 * full filesystem path there is needless exposure. Collisions only cost a shared panel state
 * between two unrelated projects, which is the bug we already have, so a cheap 32-bit hash is
 * proportionate. Multi-root workspaces key on the FIRST folder: the panel previews one pack at
 * a time, and the first folder is what VS Code itself treats as the primary root. */
export function workspaceIdFrom(folderPaths: readonly string[]): string {
  const first = folderPaths[0] ?? ''
  if (!first) return ''
  let h = 2166136261
  for (let i = 0; i < first.length; i++) {
    h ^= first.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Renders the webview shell HTML -- a pure function of its inputs, with no dependency on a
 * live `vscode.Webview`/`vscode.Uri`, so a test harness (apps/vscode/test/fixtures/shellHtml.ts,
 * used by panelLayout.test.ts, splitterLayout.test.ts, and the CSP regression test) and
 * scripts/capture-screenshots.mjs can all obtain the EXACT same HTML -- including the real CSP
 * meta tag -- that the real extension serves, instead of each hand-copying their own duplicate
 * of it. Those hand-copied duplicates (all served over plain HTTP with no CSP at all) are what
 * let the "inline <style> silently dropped by real VS Code's CSP" bug survive several rounds of
 * "verified by screenshot": none of them could ever have exercised a CSP bug in the first
 * place. buildHtml() below is the only caller inside the real extension; it supplies the real
 * webview.cspSource / webview.asWebviewUri() values this function treats as opaque strings. */
export function renderShellHtml(params: ShellHtmlParams): string {
  // Default rather than trust the caller: test/fixtures/shellHtml.ts declares its own
  // structural copy of ShellHtmlParams, so a new required field here does NOT break it at
  // compile time -- it would just render data-fl-workspace="undefined" at runtime.
  const { nonce, cspSource, scriptUri, styleUri } = params
  const workspaceId = params.workspaceId ?? ''
  // No remote resources anywhere: default-src 'none', script execution gated on a per-load
  // nonce, style similarly gated -- cspSource covers the <link rel="stylesheet"> (a real
  // resource fetch, so it needs the origin) while the SAME nonce covers the inline <style>
  // block below (a resource fetch's origin permission does not also cover inline style text --
  // that needs its own 'unsafe-inline' or, as here, a nonce; see this function's own header
  // comment for what omitting this nonce did in real VS Code: the entire inline block was
  // silently dropped, collapsing #fl-root out of its flex layout entirely). three.js and the
  // rest of featurelab-frontend are bundled INTO webview.js at build time (see
  // esbuild.config.mjs) -- there is no CDN <script src> to forbid in the first place.
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  #fl-root { display: flex; height: 100%; width: 100%; position: relative; }
  #fl-canvas { flex: 1 1 auto; min-width: 0; display: block; }
  /* The write-attribution readout -- which node's blocks are highlighted, and what a clicked
     block turned out to belong to. Lives HERE, in the shell, rather than in the shared panel
     (frontend/src/ui/panel.ts): it describes a conversation between two VS CODE panels, which
     is this extension's own concern and not the viewer's.

     [hidden] until the host says otherwise, which is the whole "degrade to today's behaviour"
     rule made structural: a preview nobody asked this of renders an empty, display:none div and
     is otherwise the document it has always been. Absolutely positioned over the canvas so
     showing it cannot move the canvas or the sidebar a pixel -- #fl-root carries the
     position:relative above for exactly this and nothing else. */
  #fl-attribution[hidden] { display: none; }
  #fl-attribution {
    position: absolute; top: 8px; left: 8px; max-width: 60%; z-index: 5;
    padding: 4px 8px; border-radius: 3px; pointer-events: none;
    font-family: var(--vscode-font-family); font-size: 11px; line-height: 1.5;
    color: var(--vscode-foreground); background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border);
  }
  /* flex-basis here is only a fallback for the instant before webview.js's own createSplitter
     call (frontend/src/ui/splitter.ts) takes over the sidebar's real, resizable, persisted
     width -- see that module's own doc comment. The splitter itself supplies the divider line
     (.fl-splitter's border-left in panel.css), so no border here. */
  #fl-sidebar { flex: 0 0 300px; overflow-y: auto; }
  /* The one sentence this shell says on its own -- see PREVIEW_DID_NOT_START. Over the canvas,
     never in the layout, and pointer-events:none so it can never intercept a drag of the 3D
     view in the instant before the script removes it. */
  #fl-boot[hidden] { display: none; }
  #fl-boot {
    position: absolute; top: 0; left: 0; right: 300px; bottom: 0; z-index: 4; pointer-events: none;
    display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 0 48px; box-sizing: border-box;
    font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.6;
    color: var(--vscode-descriptionForeground);
  }
  #fl-boot > span { max-width: 44em; }
</style>
</head>
<body data-fl-workspace="${workspaceId}">
  <div id="fl-root">
    <canvas id="fl-canvas"></canvas>
    <div id="fl-attribution" role="status" aria-live="polite" hidden></div>
    <div id="fl-boot" role="status" aria-live="polite"><span>${PREVIEW_DID_NOT_START}</span></div>
    <div id="fl-sidebar"></div>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce()
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')).toString()
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css')).toString()
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
  return renderShellHtml({
    nonce,
    cspSource: webview.cspSource,
    scriptUri,
    styleUri,
    workspaceId: workspaceIdFrom(folders),
  })
}

/** The graph panel this preview answers to, as three things and no object reference.
 *
 * Injected for the same reason GraphPanel's own onPreviewFile is: a panel reaching for another
 * panel directly is how two things that should not know about each other end up depending on
 * each other's lifetimes. Every field is optional, and the whole thing is optional -- which is
 * the state of every preview the command, the keybinding or a save opens. Such a preview
 * attributes nothing, profiles nothing and reports to nobody. */
export interface GraphLink {
  /** The node to attribute from the VERY FIRST run, for a preview the graph opened. A field here
   * rather than a call afterwards, because the constructor dispatches a `generate` before it
   * returns: setting it later would make the panel pay for one unprofiled run and then
   * immediately re-run the same thing with the profile on. */
  readonly attributeNodeId?: string | null
  /** "this block was placed by these node(s)" -- the return leg of a click in the 3D view. */
  readonly onSelectNodes?: (packRoot: string, nodeIds: readonly string[]) => void
  /** "here is what this run measured, per feature", or null when there is nothing to report any
   * more. Called on every result while this panel is profiling, and once when it closes. */
  readonly onRunStats?: (packRoot: string, stats: RunStatsWire | null) => void
}

/** What the preview panel says after the user cancels a run.
 *
 * It rides the "stale" banner, which is the panel's existing way of saying "what you are looking
 * at is not current, and here is why" -- exactly the situation a cancelled run leaves behind.
 * Phrased as a fact and a next step, never as a failure: nothing went wrong, and the pack was not
 * touched. Exported because it is a sentence somebody reads, and those are worth testing by their
 * words. */
export const PREVIEW_CANCELLED =
  'The preview was cancelled, so nothing here is from this run. Change a setting or save the file to generate again.'

export class PreviewPanel {
  /** The webview panel's view type -- also what extension.ts registers a serializer against, so
   * the manifest, the serializer and this class cannot drift apart silently. */
  static readonly VIEW_TYPE = 'featurelab.preview'
  private readonly panel: vscode.WebviewPanel
  private disposed = false
  private document: vscode.TextDocument
  /** Null when resolvePackRoot() threw a PackRootError for the document this panel was opened
   * on -- see packRootError's own doc comment for how that's surfaced instead of silently
   * handing loadPack a wrong directory. */
  private packRoot: string | null
  /** Set instead of packRoot when resolvePackRoot() couldn't find a pack root for this
   * document (see identifier.ts's own doc comment on PackRootError for when that happens).
   * regenerate()/reloadFiles() check this before touching packRoot so a genuinely-outside-a-
   * pack file gets one clear error message instead of controller.generate() being handed an
   * empty/wrong directory and failing confusingly downstream. */
  private packRootError: string | null = null
  /** Serializes regenerate() calls -- a rapid-fire save (or save immediately followed by the
   * user re-invoking the command) must not let two `generate` requests race on the same
   * engine and post their results out of order. */
  private pending: Promise<void> = Promise.resolve()
  /** The most recent GenerateParamsWire the webview's panel.ts has asked for (via a
   * `{type:'generate', params}` message -- see this file's header comment), or null before the
   * user has touched any generation-config control. Every regenerate() sends this when present,
   * falling back to `{feature: <parsed from the open file>, env: <setting>}` otherwise -- see
   * regenerate()'s own comment. */
  private lastParams: GenerateParamsWire | null = null
  /** Host->webview messages held back until the webview's script has actually loaded and
   * reported 'ready'. vscode.Webview.postMessage only delivers to a live, loaded page -- a
   * message posted before webview/main.ts has registered its listener is silently dropped.
   * The constructor fires regenerate() immediately, so any FAST first outcome -- a pack-root
   * or parse error (milliseconds), or a generate against an already-loaded pack (the pre-warm
   * in extension.ts makes this the COMMON case, ~10ms measured) -- used to race the webview's
   * own ~300ms boot and lose, leaving the panel stuck on "Generating…" with the result/error
   * discarded. Only the initial loadPack being slow (~730ms) ever hid this. */
  private readonly outbox: unknown[] = []
  private webviewReady = false
  /** True when the LAST request the webview actually drove (a 'generate' or 'growRegenerate'
   * message -- see handleWebviewMessage) used generateGrown() rather than generate() --
   * i.e. whether panel.ts's own "grow to fit" sticky toggle (frontend/src/ui/panel.ts) was on at
   * the time. regenerate() (see its own doc comment) reads this to decide which of the two the
   * NEXT request should use, including one this class drives entirely on its own with no webview
   * round trip at all -- a document save (notifyDocumentChanged). Without this, sticky mode
   * would visibly work for anything routed through the webview (an edited control) but silently
   * stop being sticky the moment a save fired a regenerate instead -- exactly the bug report this
   * mode exists to fix, just moved one level up (the bench staying grown across an EXPLICIT
   * re-click, rather than across any regenerate at all). Deliberately NOT reset by reloadFiles()
   * -- a reload is not a mode change, it's "the same mode, fresh files". */
  private lastRequestWasGrow = false

  /** Set the first time the texture flow fails with featurelab.blockTextures on, so the
   * explanation is shown once per panel rather than on every webview reload. */
  private warnedAboutAtlas = false

  /** Block name -> what it actually draws as, for the blocks this pack declares and this
   * renderer cannot draw exactly (a resource-pack model geometry, drawn as a textured cube).
   * Read out of the atlas table itself, so it is available whether the atlas was built a
   * moment ago or a week ago. Filtered to the blocks a preview actually PLACED before anything
   * is said about it -- a pack with two hundred blocks and two dozen notes has nothing to say
   * about a preview that placed neither. */
  private blockNotes: ReadonlyMap<string, string> = new Map()
  /** Set once the placed-block notes have been reported for this panel, so a save-triggered
   * regenerate does not repeat them on every run. */
  private reportedBlockNotes = false
  /** Set once the unresolved-texture rows have been reported for this panel -- see
   * reportUnresolved for why two routes can carry the same rows. */
  private reportedUnresolved = false
  /** The most recent generate response, kept only so the block notes can be reported against
   * it when the atlas arrives AFTER the first result -- which is the ordinary order: the
   * constructor fires a generate immediately and the texture flow may have a download in front
   * of it. Without this the notes would wait for whatever regenerate happened next. */
  private lastResult: unknown = null

  /** The node this panel is currently attributing, or null -- which is also the single switch
   * for the whole feature: null means no `generate` this panel sends carries `profile`, no
   * overlay is ever posted, and a `pickCell` message is ignored. Set only by attributeNode(),
   * which only the graph panel reaches (see this file's header). */
  private attributionNodeId: string | null = null
  /** The identifier the webview's picker was last seeded with, so a reload can tell a rename
   * apart from an ordinary save -- see tryPostInit's `whenChanged`. */
  private seededIdentifier: string | null = null
  /** graph/attribution.ts's own selection bridge over that index. The two directions of this
   * feature are ONE object because they are one selection: a node picked in the graph and a
   * block picked in the preview are two ways of setting it, and the bridge is what makes the
   * side being driven from outside apply without emitting -- which is what stops the two panels
   * handing a selection back and forth forever. Rebuilt with every index, because a bridge is
   * bound to the index it resolves against. */
  private attributionBridge: AttributionBridge | null = null
  /** Set once per panel when a profiled run came back with no attribution table at all. Keeps
   * the output-channel note to one line rather than one per regenerate. */
  private warnedAboutAttribution = false
  /** The block-texture state this panel last observed, so a background re-check can tell "the
   * atlas went stale under an open panel" from "nothing has changed since the last save". Null
   * until the first check; see ensureTextures. */
  private lastTextureState: TextureStatusWire['state'] | null = null
  /** One texture check at a time. A check spawns a process and hashes the pack's block files,
   * and the post-regenerate check fires on every save -- see ensureTextures. */
  private textureCheckInFlight = false

  /** Settles on this panel's FIRST outcome -- a result, or the reason there wasn't one.
   *
   * The preview command awaits it, which is what lets the command hold a progress notification
   * up until there is something to look at, and report a first run that failed as a notification
   * with a "Show log" button. Without it the command returned the instant the panel object
   * existed, so "nothing happened" and "it is generating" were the same experience, and a first
   * run that failed while the webview was still booting put its message into an outbox nobody
   * was reading yet.
   *
   * Only the FIRST run. Every regenerate after it reports itself -- see reportFailure. */
  private settleFirstResult: (() => void) | null = null
  private rejectFirstResult: ((err: Error) => void) | null = null
  private readonly firstResult: Promise<void>
  /** The backstop for a webview whose script never runs -- see WEBVIEW_READY_TIMEOUT_MS.
   * Cleared the moment the webview says `ready`, which is the only thing that proves it did. */
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  /** Cancels the generate this panel currently has in flight, if any. Owned by the panel because
   * nothing else can be: a regenerate is started by a save, by a control in the webview, or by
   * the graph following a selection, while Cancel is pressed on the command's notification. */
  private inflightGenerate: AbortController | null = null

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: PreviewController,
    private readonly diagnosticCollection: vscode.DiagnosticCollection,
    document: vscode.TextDocument,
    private readonly onDisposed: (panel: PreviewPanel) => void,
    /** The first-run flow, spawning `featurelab textures` (see textures.ts for why it is a
     * second process and not a request on the live engine). Injected so a test drives it
     * without a binary; defaults to the same engine binary this panel's controller runs. */
    private readonly textures: TextureBuilder = new TextureBuilder(controller.binaryPath),
    /** The graph panel that opened this preview, if one did. See GraphLink: an empty link -- the
     * default, and what every command-opened preview gets -- means this panel attributes
     * nothing, asks for no profile and reports to nobody. */
    private readonly graphLink: GraphLink = {},
    /** Set only by extension.ts's webview serializer, for a tab VS Code brought back after a
     * window reload -- see RevivedPreview. Absent for every panel a person opens. */
    revived?: RevivedPreview,
  ) {
    this.document = document
    if (revived !== undefined) {
      this.lastParams = revived.params ?? null
      this.lastRequestWasGrow = revived.grown === true
    }
    this.firstResult = new Promise<void>((resolve, reject) => {
      this.settleFirstResult = resolve
      this.rejectFirstResult = reject
    })
    // A handler attached at creation, so a panel nobody awaits (one the graph opened, one a
    // test made) cannot raise an unhandled rejection. Not a swallow -- it logs, and
    // whenFirstResult() hands out the original promise, so a real awaiter still sees it.
    void this.firstResult.catch((err: unknown) => log(`Preview first run failed: ${describeError(err)}`))
    // A first result is only ever DELIVERED to a webview that reported `ready` (see the outbox in
    // post()), so a bundle that never loads left the command's notification spinning forever with
    // a blank panel beside it. The graph has had this backstop; this is the preview's.
    this.readyTimer = setTimeout(() => this.reportWebviewNeverStarted(), WEBVIEW_READY_TIMEOUT_MS)
    // Node keeps the process alive for a pending timer, which matters for the tests that drive
    // this class outside an extension host.
    this.readyTimer.unref?.()
    try {
      this.packRoot = resolvePackRoot(document.uri.fsPath)
      log(`Preview panel opened for ${document.uri.fsPath} (pack root ${this.packRoot})`)
    } catch (err) {
      this.packRoot = null
      this.packRootError = err instanceof PackRootError ? err.message : String(err)
      log(`Preview panel opened for ${document.uri.fsPath} with no pack root: ${this.packRootError}`)
    }

    const webviewOptions: vscode.WebviewOptions = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    }
    if (revived !== undefined) {
      // A revived panel comes back with its SCRIPTS OFF and no resource roots -- VS Code does not
      // persist webview options -- and is already placed where the author left it, so nothing here
      // names a column.
      this.panel = revived.panel
      this.panel.webview.options = webviewOptions
    } else {
      this.panel = vscode.window.createWebviewPanel(
        PreviewPanel.VIEW_TYPE,
        `Feature Lab: ${path.basename(document.fileName)}`,
        vscode.ViewColumn.Beside,
        { ...webviewOptions, retainContextWhenHidden: true },
      )
    }
    this.panel.webview.html = buildHtml(this.panel.webview, context.extensionUri)
    this.panel.onDidDispose(() => {
      this.disposed = true
      if (this.readyTimer !== null) clearTimeout(this.readyTimer)
      this.readyTimer = null
      // Closing the preview stops its run for real. Nothing is left to draw the answer on, and
      // the engine's one worker is better spent on a panel that still exists.
      this.inflightGenerate?.abort()
      this.inflightGenerate = null
      // A panel closed before its first run finished has to settle, or the command that opened
      // it holds a progress notification over a panel that is no longer there.
      const pending = this.rejectFirstResult
      this.settleFirstResult = null
      this.rejectFirstResult = null
      pending?.(new Error('the preview was closed before it finished generating'))
      this.attributionBridge?.dispose()
      this.attributionBridge = null
      // The graph's cards are showing THIS run's numbers. The run is now unreachable -- there is
      // no preview to regenerate it, no overlay, nothing to click -- so leaving the numbers up
      // would leave a fact about nothing phrased as a fact about a node.
      if (this.attributionNodeId !== null && this.packRoot !== null) {
        this.graphLink.onRunStats?.(this.packRoot, null)
      }
      this.diagnosticCollection.delete(this.document.uri)
      this.onDisposed(this)
    })
    this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => this.handleWebviewMessage(message))

    this.attributionNodeId = graphLink.attributeNodeId ?? null
    void this.regenerate()
  }

  private handleWebviewMessage(message: WebviewToHostMessage): void {
    if (this.disposed) return
    switch (message.type) {
      case 'ready':
        this.webviewReady = true
        if (this.readyTimer !== null) clearTimeout(this.readyTimer)
        this.readyTimer = null
        // Seeds panel.ts's Feature OR Rule dropdown (and switches mode to match) with the
        // kind+identifier THIS regenerate() call is already about to request (or already
        // requested, if 'ready' arrives after the first result -- order between the initial
        // regenerate() and the webview's own load is not guaranteed) -- see
        // PanelHandle.seedOpenedDocument's own doc comment for why this can't just be inferred
        // from the result alone in feature mode, and for the "opened file always wins over
        // persisted" contract this is now the entry point for. Posted BEFORE the flush so a
        // buffered first result lands on an already-seeded picker, the same order the
        // ready-before-result case has always had.
        this.tryPostInit()
        // Whatever the last panel on this document was left holding, before the flush for the
        // same reason `init` is: the webview restores a camera onto the result it is about to be
        // handed, and arriving afterwards would mean one frame at the default view and a jump.
        this.postRestoreState()
        this.flushOutbox()
        // THE LAST RESULT, AGAIN, for a webview that has booted a SECOND time.
        //
        // `ready` is not a once-per-panel event. A webview without retainContextWhenHidden is
        // torn down when its tab is hidden and rebuilt -- from the static HTML, with nothing in
        // it -- when the tab comes back, and it says `ready` again on the way in. The outbox is
        // empty by then (it was flushed the first time round) and nothing else re-sends, so
        // hiding and re-showing a preview left a SEEDED SIDEBAR OVER AN EMPTY CANVAS: the
        // restored params, the picker and the controls all came back, and the picture did not.
        //
        // A panel this extension creates asks for retainContextWhenHidden and so never reaches
        // this; a panel VS Code REVIVES after a window reload cannot -- retainContextWhenHidden
        // lives on WebviewPanelOptions, which is fixed at creation and readonly afterwards, so a
        // revived tab is stuck with whatever the reload gave it. Re-posting is the fix that works
        // for both, and it costs a first boot nothing (lastResult is null until a run lands).
        //
        // AFTER the flush, so a result still sitting in the outbox is delivered first and this is
        // the redundant copy rather than the out-of-order one.
        if (this.lastResult !== null) {
          this.postResult(this.lastResult)
          // The overlay went with the page. Re-resolving the current selection against the index
          // this panel still holds puts it back, and posts "unavailable" when there is nothing to
          // put back -- which is what the webview draws as the plain preview it already is.
          this.applyAttribution(this.lastResult)
        }
        void this.tryPostEnvironments()
        void this.ensureTextures()
        break
      case 'persistState':
        void this.stateStore()?.update(previewViewStateKey(this.document.uri.toString()), message.state ?? null)
        break
      case 'generate':
        if (message.params) {
          this.lastParams = message.params
          // An ordinary (non-grow) request -- see lastRequestWasGrow's own doc comment for why
          // this needs recording, not just used once here: it's what keeps a LATER save-
          // triggered regenerate honoring "sticky grow is currently off" too.
          this.lastRequestWasGrow = false
          this.rememberParams()
          this.pending = this.pending.then(() => this.regenerate())
        }
        break
      case 'growRegenerate':
        // Fires for two different reasons panel.ts's own UI distinguishes but this class does
        // not need to: an explicit one-off "Grow to fit & regenerate" click, OR every config
        // change while panel.ts's sticky "grow every run" toggle is on (see that toggle's own
        // doc comment, frontend/src/ui/panel.ts) -- panel.ts redirects notifyConfigChanged() to
        // fire onGrowRegenerate instead of onConfigChange in the sticky case, so this message
        // type is ALREADY exactly "the next request should be grown", regardless of which of the
        // two reasons produced it. Recording lastRequestWasGrow = true here is what lets sticky
        // mode survive a save (regenerate() below reads it), not just an explicit re-click.
        if (message.params) {
          this.lastParams = message.params
          this.lastRequestWasGrow = true
          this.rememberParams()
          this.pending = this.pending.then(() => this.growRegenerate())
        }
        break
      case 'reloadFiles':
        this.pending = this.pending.then(() => this.reloadFiles())
        break
      case 'pickCell':
        this.pickCell(message)
        break
      case CANCEL_MESSAGE_TYPE:
        // NOT queued behind `this.pending`. Every other message here takes its turn in that
        // chain, which is right for requests -- two generates must not interleave. A cancel is
        // the opposite kind of thing: queueing it behind the run it is meant to stop would mean
        // it could only ever arrive after that run had finished, which is precisely never doing
        // anything at all.
        this.cancelGenerate()
        break
      default:
        break
    }
  }

  /** Seeds panel.ts's Feature/Rule picker from what THIS document currently declares.
   *
   * `whenChanged` is for the one caller that is not an open: a RELOAD. `init` overrides whatever
   * the picker is showing (seedOpenedDocument's "opened file always wins"), which is right when a
   * panel is opened or re-pointed and wrong on every save -- an author who picked a different
   * feature out of the dropdown would have their choice snatched back to the open file's
   * identifier once per save. So a reload re-seeds only when the file now declares a DIFFERENT
   * identifier from the one last posted, which is exactly the rename case: rename a feature in
   * the editor, save, and the picker was left holding a name the pack no longer has, reading
   * `"wiki:fancy_oak_tree" not found in loaded files` under a legend naming the new one. */
  private tryPostInit(whenChanged = false): void {
    try {
      // kind matters here, not just identifier -- see parseDocumentIdentifier's own doc comment
      // for the bug this fixes: a rule file's identifier posted under a feature-only message
      // used to seed panel.ts's Feature picker, where it could only ever match nothing.
      const { kind, identifier } = parseDocumentIdentifier(this.document.getText())
      if (whenChanged && identifier === this.seededIdentifier) return
      this.seededIdentifier = identifier
      this.post({ type: 'init', kind, identifier })
    } catch (err) {
      // Not previewable yet (e.g. mid-edit, invalid JSON) -- regenerate()'s own error path
      // already surfaces this to the user; nothing more to seed the picker with. Logged rather
      // than dropped, because an empty Feature picker with no explanation anywhere is one of the
      // shapes "the extension is broken" takes.
      log(`Could not seed the preview's picker from ${path.basename(this.document.fileName)}: ${describeError(err)}`)
    }
  }

  /** Where the two halves of this panel's state are kept -- see previewViewStateKey and
   * previewParamsKey.
   *
   * Optional-chained through, because `context` here is an ExtensionContext in the extension and
   * a two-field stand-in in most of the tests. A missing store costs the remembering and nothing
   * else: every read falls back to exactly what this class did before any of it existed. */
  private stateStore(): vscode.Memento | undefined {
    return (this.context as { workspaceState?: vscode.Memento } | undefined)?.workspaceState
  }

  /** Records what this panel is currently generating, so a tab VS Code revives after a window
   * reload comes back showing the same thing rather than resetting to the file's own identifier
   * at the default size, seed and origin. Written on the two messages that set `lastParams` and
   * on a retarget, which are the only three things that ever change it. */
  private rememberParams(): void {
    const blob: RememberedPreviewParams = {
      // Stamped and dated, so the side that reads this back can tell whether it still means what
      // it meant -- see freshPreviewParams for what each of these two is for.
      version: PREVIEW_PARAMS_VERSION,
      identifier: this.currentDocumentIdentifier(),
      params: this.lastParams,
      grown: this.lastRequestWasGrow,
    }
    void this.stateStore()?.update(previewParamsKey(this.document.uri.toString()), blob)
  }

  /** What this panel's document declares right now, or null when it does not parse -- which is
   * most of the time somebody is typing in it, and is therefore an ordinary answer rather than a
   * failure. */
  private currentDocumentIdentifier(): string | null {
    try {
      return parseDocumentIdentifier(this.document.getText()).identifier
    } catch {
      return null
    }
  }

  /** Hands the webview back its own blob. `key` travels with it because the webview has to write
   * that key into its own `setState`: on a window reload VS Code hands this host the webview's
   * saved state and nothing else, so it is the only thing that can say WHICH DOCUMENT a revived
   * tab was previewing (see extension.ts's serializer). */
  private postRestoreState(): void {
    const uri = this.document.uri.toString()
    this.post({ type: 'restoreState', key: uri, state: this.stateStore()?.get<unknown>(previewViewStateKey(uri), null) ?? null })
  }

  /** Fetches the engine's environment preset list and posts it to the webview's panel.ts (see
   * PanelHandle.setEnvironments) -- static, pack-independent data (see PreviewController.
   * listEnvironments's own doc comment), so unlike tryPostInit's feature identifier this never
   * depends on the just-opened document. Best-effort: a failure here (e.g. the engine hasn't
   * finished starting) just leaves the Preset dropdown empty a little longer -- the SAME
   * "no data yet" posture the Feature/Rule pickers already have before their first result,
   * not a fatal error for the whole preview. */
  private async tryPostEnvironments(): Promise<void> {
    const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
    try {
      const environments: EnvironmentOptionWire[] = await this.controller.listEnvironments(timeoutMs)
      if (this.disposed) return
      this.post({ type: 'environments', environments })
    } catch (err) {
      // See this method's own doc comment -- not fatal, so nothing is shown. Logged, because an
      // empty Preset dropdown is otherwise indistinguishable from a broken one.
      log(`The environment preset list could not be fetched, so the Preset dropdown stays empty: ${describeError(err)}`)
    }
  }

  /** The first run: get this machine to a state where the preview can draw real block
   * textures, then post the atlas to the webview.
   *
   * WHAT THE SETTING MEANS NOW. featurelab.blockTextures governs PREPARATION -- whether this
   * host looks for an atlas, offers to fetch one, and builds it. It no longer decides whether
   * textures are DRAWN, because that switch now exists where the person looking at flat colours
   * actually is: the preview panel's own "Block textures" row (frontend/src/ui/panel.ts), which
   * remembers their answer per workspace. So the atlas goes over as soon as there is one,
   * whatever this panel's own preference happens to be, and nothing here ever calls
   * setTexturesEnabled: a host turning textures on behind the user's back would undo a choice
   * they made in the sidebar two minutes ago.
   *
   * ON BY DEFAULT, which is a deliberate change and the whole point of the feature. What must
   * not depend on whether a machine happens to have an atlas is a COMMITTED IMAGE -- and the
   * images this repository commits are produced by docs/wiki/tools/, which drives the viewer
   * directly and pins textures off explicitly, and by scripts/capture-screenshots.mjs, which
   * never posts an atlas message at all. Neither goes through this class, so the guarantee
   * those images need is held where it belongs rather than by leaving the feature switched off
   * for everyone. featurelab.blockTextures = false stops this ever fetching, building or asking
   * anything -- and SAYS SO to the panel, so the row reads as a setting somebody switched off
   * rather than as a control that is broken.
   *
   * THE ASK HAPPENS EXACTLY ONCE, and only when a download is what is being asked for. A
   * machine with Mojang's assets already cached (or FEATURELAB_VANILLA_PACK pointing at a
   * checkout) is never interrupted: the question exists because of the network, and that path
   * has none. A "no" is recorded by the engine, next to the atlas directory, so neither this
   * extension nor the desktop app nor the CLI asks again.
   *
   * EVERY OTHER OUTCOME IS EXPLAINED, once per panel. "The preview draws flat colours" with
   * nothing said is indistinguishable from a broken feature, and offline or proxied machines
   * are a normal case here, not an edge one.
   *
   * IT IS NOT ONLY THE FIRST RUN ANY MORE. This used to have exactly one caller -- the webview's
   * `ready` message -- which made the atlas a fact settled in the first second of a panel's life
   * and never revisited. Repainting a texture with the preview open changed nothing for the rest
   * of the session, and a "no" given once could only be taken back by running a CLI flag nobody
   * had heard of. It now also runs after every generate ('refresh') and on demand ('user'); see
   * TextureCheckMode for what each is allowed to do. */
  private async ensureTextures(mode: TextureCheckMode = 'initial'): Promise<void> {
    const config = vscode.workspace.getConfiguration('featurelab')
    if (!config.get<boolean>('blockTextures', true)) {
      // Said, not warned. Somebody switched this off on purpose; a notification about a setting
      // working as configured is how people learn to dismiss notifications unread. The panel row
      // carries it instead, which is where the question gets asked.
      this.postTextureStatus(false, TEXTURES_DISABLED_REASON)
      // ...except when they ASKED. A command that does nothing and says nothing is a command a
      // user reports as broken, so the one mode with a person waiting on an answer gets one.
      if (mode === 'user') void warn(`Feature Lab: ${TEXTURES_DISABLED_REASON}`)
      return
    }
    // A background check has nothing to do until there is an answer for it to differ from. This
    // is not only an optimisation: the constructor's own first generate finishes while the
    // webview's `ready` check is still running, so without it the very first refresh would race
    // the very first check and the panel's state would depend on which won.
    if (mode === 'refresh' && this.lastTextureState === null) return
    // A status check spawns a process and hashes this pack's block files (~55ms on a 200-block
    // pack), and 'refresh' fires on every regenerate -- including a burst of saves. One at a
    // time is enough: the next regenerate re-checks anyway, and a queue of identical probes
    // would be the one thing that made this cost visible.
    if (this.textureCheckInFlight) return
    this.textureCheckInFlight = true
    const timeoutMs = config.get<number>('requestTimeoutMs', 30_000)
    let rebuilt = false
    try {
      // The pack under test goes in: its own blocks are drawn from the same sheet vanilla's
      // are, and on a large pack they can be 40% of the distinct block names a preview places.
      const packRoot = this.packRoot ?? undefined
      let status = await this.textures.status(packRoot)
      if (this.disposed) return
      // Whether this is NEWS. A background re-check that reports the same state it reported last
      // time would repost a row the panel is already showing on every single save; what it is
      // here for is the state that CHANGED underneath an open panel.
      const changed = status.state !== this.lastTextureState
      this.lastTextureState = status.state
      if (status.state === 'declined' && mode !== 'user') {
        // No warning: this machine was asked once and answered, and repeating the answer back at
        // somebody is not news. The row still says it, and says how to undo it -- which is now a
        // command in this editor rather than a CLI flag (see TEXTURES_DECLINED_REASON).
        if (mode === 'initial' || changed) this.postTextureStatus(false, TEXTURES_DECLINED_REASON)
        return
      }
      // 'user' mode takes ANY not-ready state into the build branch, `declined` included. That is
      // the whole of the way back: blocktextures.Ensure deletes the decline record on a
      // successful build ("building is the answer to the question a decline postponed"), so a
      // person who said no once and changed their mind never has to find a terminal.
      if (status.state === 'missing' || status.state === 'stale' || (mode === 'user' && status.state !== 'ready')) {
        if (status.needsDownload) {
          if (mode === 'refresh') {
            // A background re-check never puts a modal in front of somebody who was editing, and
            // never reaches the network. The question belongs to the panel's own first run and to
            // the command; this one only reports, and only when the answer moved.
            if (changed) this.postTextureStatus(false, status.detail)
            return
          }
          const answer = await this.offerTextureDownload(status)
          if (this.disposed) return
          if (answer !== 'download') {
            // "Never" has already said its piece, in a notification and in the row. A dismissed
            // notification decided nothing -- the question comes back with the next preview --
            // but the row still has to say why it is inert right now.
            if (answer === 'dismissed') this.postTextureStatus(false, status.detail)
            return
          }
        }
        status = (await this.buildTextures(packRoot, status.needsDownload)).status
        if (this.disposed) return
        this.lastTextureState = status.state
        rebuilt = true
      }
      if (status.state !== 'ready') {
        this.noTextures(status.detail)
        return
      }
      // A ready atlas that was ready last time too is the SAME SHEET, and it is a base64 PNG:
      // re-sending it after every save would put a megabyte-ish message on the wire per
      // keystroke-burst for a picture the webview is already holding. Only a background check
      // is held to this -- 'initial' has nothing delivered yet, and 'user' is somebody asking to
      // be handed it again.
      if (mode === 'refresh' && !rebuilt && !changed) return
      const atlas = await this.controller.loadAtlas(timeoutMs)
      if (this.disposed) return
      this.blockNotes = notesFromAtlas(atlas)
      this.post({ type: 'atlas', atlas })
      // "I have delivered one" -- NOT "draw them". Whether they are drawn is the panel's own
      // switch and the preference behind it; see this method's own doc comment.
      this.postTextureStatus(true)
      // Which of the pack's own faces the atlas could not answer for, from the atlas ITSELF --
      // so a machine that built it last week and built nothing today still gets the list. A
      // no-op when the build above already reported the same rows, and when the engine is too
      // old to carry them at all. See unresolvedFromAtlas.
      const unresolved = unresolvedFromAtlas(atlas)
      this.reportUnresolved(unresolved.rows, unresolved.total)
      // The atlas usually arrives after the first result (the constructor fires a generate
      // immediately, and this path may have had a download in front of it), so the notes for
      // what is already on screen are reported here rather than waiting for the next run.
      this.reportBlockNotes(this.lastResult)
    } catch (err) {
      if (this.disposed) return
      // The engine prints ONE COMPLETE SENTENCE for every way this can fail -- offline, a proxy
      // that broke TLS, an unwritable cache -- and TextureCommandError carries it as `detail`
      // precisely so a host can show it. Reading only `message` off it, which is what this used
      // to do, threw that sentence away and left "block textures could not be built" as the whole
      // of what somebody was told about a problem they could have fixed.
      this.noTextures(
        err instanceof TextureCommandError
          ? `${err.message} -- ${err.detail}`
          : `block textures could not be prepared -- ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      this.textureCheckInFlight = false
    }
  }

  /** "Check the block textures again, and ask me again if you have to" -- the whole of
   * featurelab.refreshBlockTextures, and the answer to two things this panel could not do at all
   * before it existed.
   *
   * A texture repainted while the panel is open now reaches the preview (the engine restales the
   * atlas by CONTENT, so an edit that preserved the file's size and mtime still counts), and a
   * "no" given once is a decision a person can reverse where they made it, rather than by
   * discovering a CLI flag. Both were permanent for the life of the session. */
  async refreshTextures(): Promise<void> {
    await this.ensureTextures('user')
  }

  /** Tells this panel that the engine it was built against has been shut down -- the host
   * replaced the controller because `featurelab.binaryPath` changed.
   *
   * Said HERE rather than waiting for the next generate to fail, because the gap between the two
   * is exactly the window in which somebody believes they have switched engines. Checks the
   * controller's own tombstone rather than trusting the caller, so a panel that already holds the
   * NEW controller is left alone. */
  notifyEngineDisposed(): void {
    if (this.disposed || !this.controller.isDisposed()) return
    this.engineLevelFailure = true
    this.postStale(true, new EngineDisposedError(this.controller.binaryPath).message)
  }

  /** Puts the question, with the engine's own notice as the body: what is fetched, from where,
   * how large it is, whose it is, where it lands, and how to avoid it entirely.
   *
   * THREE ANSWERS, not two, because the caller has to tell them apart. "Never" records the
   * decline so nothing asks again and has already explained itself; dismissing the message
   * decides nothing at all and the question comes back with the next preview, which is the right
   * reading of a notification nobody answered -- but the panel still has to be told where it
   * stands in the meantime, and only the caller knows it has not been told yet. */
  private async offerTextureDownload(status: TextureStatusWire): Promise<'download' | 'never' | 'dismissed'> {
    const answer = await vscode.window.showInformationMessage(
      'Feature Lab can draw real Minecraft block textures in the preview.',
      { modal: true, detail: status.notice ?? status.detail },
      'Download',
      'Never',
    )
    if (answer === 'Download') return 'download'
    if (answer === 'Never') {
      await this.textures.decline()
      this.noTextures(TEXTURES_DECLINED_REASON)
      return 'never'
    }
    return 'dismissed'
  }

  /** Runs the build behind a progress notification, forwarding the engine's own progress lines
   * into it. A 150 MB fetch with no sign of life reads as a hang. */
  private async buildTextures(packRoot: string | undefined, download: boolean) {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Feature Lab: preparing block textures', cancellable: false },
      async (progress) => {
        const result = await this.textures.build({
          packRoot,
          download,
          onProgress: (line) => progress.report({ message: line }),
        })
        if (result.pack && result.pack.blocks > 0) {
          const output = this.textureOutput()
          output.appendLine(
            `This pack defines ${String(result.pack.blocks)} block(s): ${String(result.pack.fully)} draw exactly as declared, ` +
              `${String(result.pack.shapeCube)} as a textured cube (their geometry is a resource-pack model), ` +
              `${String(result.pack.untextured)} with an unresolved texture.`,
          )
          if (result.pack.resourcePack) {
            output.appendLine(`Textures resolved through ${result.pack.resourcePack}${result.pack.how ? ` (found by ${result.pack.how})` : ''}.`)
          } else {
            // The single most likely reason a whole pack draws flat: the behaviour pack's own
            // resource pack was never located, so not one texture key could be resolved. Silence
            // here is what makes that indistinguishable from the feature being broken.
            output.appendLine(
              'No resource pack was found for this pack, so none of its own block textures could be resolved; ' +
                'its blocks draw as flat colours. Link it from the behaviour pack manifest\'s "dependencies", ' +
                'or keep the two directories side by side with matching _bp/_rp names.',
            )
          }
          // Read through the same two helpers the atlas route uses, for the same reason: the
          // build's `unresolved` is capped at blocktextures.UnresolvedLimit too, so its length
          // is not the count anybody wants to read.
          const unresolved = unresolvedRows(result.pack.unresolved)
          this.reportUnresolved(unresolved, unresolvedTotal(result.pack.unresolvedTotal, unresolved.length))
        }
        return result
      },
    )
  }

  /** Which faces did not resolve, and what to do about them. "N blocks with an unresolved
   * texture" is a number an author cannot act on: a key missing from terrain_texture.json and a
   * PNG that was never exported look identical in the preview and have different fixes.
   *
   * The wording is summarizeUnresolved's -- the headline carries the ENGINE's total rather than
   * the length of its capped sample, and the sample is grouped by code rather than by prose.
   *
   * ONCE PER PANEL, and from whichever route got there first -- a build that just ran, or the
   * atlas a build ran last week left behind (see unresolvedFromAtlas). The two carry the same
   * rows, so the second is a no-op rather than the list printed twice. */
  private reportUnresolved(rows: readonly UnresolvedTextureWire[], total: number): void {
    if (this.reportedUnresolved) return
    const lines = summarizeUnresolved(rows, total)
    if (lines.length === 0) return
    this.reportedUnresolved = true
    const output = this.textureOutput()
    for (const line of lines) output.appendLine(line)
  }

  /** Tells the panel where it stands on block textures -- PanelHandle.setTextureStatus.
   *
   * The panel already knows WHETHER it can draw them (it asks the viewer, which knows whether an
   * atlas decoded). What it cannot know is WHY not, and the answers need different actions:
   * nothing built on this machine, a build that failed, a download declined, a setting switched
   * off. This is the only place this host claims to know one, and it never says more than it
   * does: `available: true` means "an atlas is on its way", not "textures are on". */
  private postTextureStatus(available: boolean, reason?: string): void {
    this.post({ type: 'textureStatus', available, ...(reason === undefined ? {} : { reason }) })
  }

  /** The two halves of "this preview is not textured, and here is why": the panel row says it
   * every time, and a notification says it once per panel. Kept together so a new exit from the
   * texture flow cannot warn somebody without also telling the row -- which is how the row ends
   * up inert with a neutral message over a failure the user was interrupted about. */
  private noTextures(detail: string): void {
    this.postTextureStatus(false, detail)
    this.explainNoTextures(detail)
  }

  /** Says, once per panel, why the preview is not textured. Never an error dialog: textures
   * are an enhancement and nothing here stops the tool working. */
  private explainNoTextures(detail: string): void {
    if (this.warnedAboutAtlas) return
    this.warnedAboutAtlas = true
    void warn(`Feature Lab: ${detail}`)
  }

  /** Reports the notes for the blocks THIS preview actually placed -- a pack block whose
   * geometry is a resource-pack model draws as a textured cube, which is worth knowing once
   * and is noise every run after that. Deliberately not routed into the diagnostics list:
   * using a model geometry is not a defect in a pack, and putting a hundred such lines where
   * the real diagnostics go is what that list must never become. */
  private reportBlockNotes(result: unknown): void {
    if (this.reportedBlockNotes || this.blockNotes.size === 0) return
    const placed = notesForPalette(this.blockNotes, (result as { palette?: unknown } | null)?.palette)
    if (placed.length === 0) return
    this.reportedBlockNotes = true
    const output = this.textureOutput()
    for (const note of placed) output.appendLine(`${note.block}: ${note.message}`)
    void vscode.window.showInformationMessage(
      `Feature Lab: ${String(placed.length)} block(s) in this preview draw as a textured cube because their geometry is a resource-pack model. See the Feature Lab output channel.`,
    )
  }

  /** The output channel everything long-form about textures goes to -- the per-block notes,
   * the pack summary, the sentence behind a warning.
   *
   * The SAME channel every other part of this extension writes to (log.ts). It used to be a
   * second one created here, which meant a user told to "see the Feature Lab output channel"
   * could be looking at either of two things with that name in the Output dropdown. */
  private textureOutput(): vscode.OutputChannel {
    return output()
  }

  /** Re-reads the pack, then regenerates.
   *
   * `savedFile` is the whole difference between the two callers. A save knows exactly which
   * file changed, so it passes that path and the controller re-reads only it (falling back to
   * a full load whenever the engine can't -- see PreviewController.reloadPackFile), turning a
   * ~690ms save-to-preview into a ~80ms one. The "Reload files" BUTTON passes nothing and gets
   * the full re-read of every file on purpose: it exists for the moment the user does not
   * trust what they are looking at, and an incremental picture is precisely what they are
   * asking to be rid of. */
  private async reloadFiles(savedFile?: string): Promise<void> {
    if (this.disposed) return
    // The file this panel IS ABOUT may be the thing that changed, by going away. Every reload
    // route ends up here -- a save, a burst of writes, the pack root named after a delete or a
    // rename -- so this is the one place that sees all of them.
    if (this.disposeIfDocumentGone()) return
    if (this.packRootError !== null || this.packRoot === null) {
      this.postError(`cannot preview this file: ${this.packRootError}`)
      return
    }
    const packRoot = this.packRoot
    const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
    this.postBusy()
    const busy = showBusy(savedFile === undefined ? 'reloading the pack' : 'reloading the saved file')
    const started = Date.now()
    log(savedFile === undefined ? `Reloading every file in ${packRoot}` : `Reloading ${savedFile}`)
    try {
      const summary = await (savedFile === undefined
        ? this.controller.reloadPack(packRoot, timeoutMs)
        : this.controller.reloadPackFile(packRoot, savedFile, timeoutMs))
      // The reload's own answer, in the changed vocabulary: `featureCount` is what BUILT and
      // `fileCounts.features` is what was read, so a save that breaks the file being edited now
      // shows up here as the number going down rather than as nothing at all.
      log(`Reload finished in ${String(Date.now() - started)}ms: ${describePackContents(summary)}`)
      for (const warning of summary.warnings ?? []) log(`  pack warning: ${warning}`)
      // NOT a notification and not a stale banner. This fires on every save, and a file is
      // unparseable for most of the time somebody is typing in it; interrupting them per keystroke
      // is how people learn to dismiss notifications unread. The regenerate that follows carries
      // the same fact to the place they are actually looking -- the panel's Diagnostics section,
      // where every pack-scoped problem now arrives as one expandable row (see postResult).
      const broken = describeBrokenFiles(summary.diagnostics)
      if (broken !== null) log(`  ${broken}`)
      for (const d of brokenFiles(summary.diagnostics)) log(`    ${diagnosticLocation(d)}: ${d.message}`)
      if (this.disposed) return
      // The reload is what makes an identifier RENAMED IN THE EDITOR real to the engine, so this
      // is where the picker finds out about it -- see tryPostInit's `whenChanged` for why an
      // ordinary save deliberately re-seeds nothing.
      this.tryPostInit(true)
      await this.regenerate()
    } catch (err) {
      if (this.disposed) return
      this.handleGenerateError(err)
    } finally {
      busy.dispose()
    }
  }

  /** Closes this panel when the file it previews is no longer on disk, answering `true` when it
   * did.
   *
   * A TAB POINTING AT A DELETED FILE IS NOT A PREVIEW OF ANYTHING. Deleting the previewed feature
   * (from the graph's own Delete, or from the Explorer) left the panel open, blank, saying
   * `"wiki:..." not found in loaded files` -- while `documentUri` went on naming the deleted file,
   * so the panel still claimed every save of that path, still counted as the open preview for it,
   * and a re-open of a file recreated at the same path found this corpse and revealed it instead
   * of making a live one.
   *
   * The same answer extension.ts's serializer already gives a revived tab whose document cannot
   * be opened: the tab goes. There is nothing the author can do from inside a panel about a file
   * that is not there, and a permanent error where a preview used to be is worse than the tab
   * closing when the thing it was about did.
   *
   * ONLY for a file this panel could have expected to find -- an untitled or otherwise
   * non-file-scheme document has no path to test and is left exactly alone. A stat that fails for
   * any reason other than "not there" (a permission, a disconnected share) also leaves the panel
   * up: "I could not look" is not "it is gone". */
  private disposeIfDocumentGone(): boolean {
    if (this.disposed) return false
    if (this.document.uri.scheme !== 'file') return false
    const fsPath = this.document.uri.fsPath
    if (typeof fsPath !== 'string' || fsPath.length === 0) return false
    try {
      fs.accessSync(fsPath)
      return false
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    log(`The preview of ${fsPath} is closing: that file no longer exists.`)
    this.dispose()
    return true
  }

  get documentUri(): vscode.Uri {
    return this.document.uri
  }

  /** Stops the generate this panel currently has in flight -- what the "Preview Feature" command
   * calls when the user presses Cancel on its notification.
   *
   * A no-op when nothing is running: by the time somebody reaches the button the answer may have
   * already arrived, and cancelling a finished request has to be as harmless here as it is on
   * the engine. */
  cancelGenerate(): void {
    if (this.inflightGenerate === null) return
    log(`Cancelling the preview of ${path.basename(this.document.fileName)} at the user's request.`)
    this.inflightGenerate.abort()
  }

  /** Brings the panel forward WHERE IT IS.
   *
   * The column is deliberately not named. `reveal(ViewColumn.Beside)` does not mean "show it" --
   * it means "put it beside the active editor", which MOVES a panel the author had dragged into
   * a window of its own back into the main one. Someone who has given the preview its own window
   * has said where they want it more clearly than any default can. */
  reveal(): void {
    this.panel.reveal(undefined, true)
  }

  /** Re-points this panel at another file, for the graph's follow-the-selection preview.
   *
   * Without it every selected node got a panel of its own -- previews are keyed by document, and
   * a different node is a different file -- so following a selection opened a stack of previews
   * instead of updating one. */
  retargetTo(document: vscode.TextDocument): void {
    this.document = document
    this.panel.title = `Preview: ${path.basename(document.uri.fsPath)}`
    // THE PARAMS DESCRIBE THE FILE THIS PANEL IS NO LONGER ABOUT, so they are dropped here.
    //
    // This was a silent wrong answer, and it is worth writing down exactly. `lastParams` is
    // populated the moment the author touches ANY control in the panel -- a seed, a size, the
    // origin -- and from then on regenerate() prefers it over the open file's own identifier (see
    // its own comment). Nothing used to clear it. So with "Preview on select" on: click node A,
    // set a seed, click node B. The tab renames itself to B, the graph says it is previewing B,
    // and the run that actually happens is `{feature: A, seed: ...}` -- A's blocks, under B's
    // name, with nothing anywhere saying so. The first retarget of a panel nobody had touched
    // worked, which is what made it look fine.
    //
    // Clearing them puts this panel back into the state it opens in: the next regenerate previews
    // whatever the NEW document declares. The author's size/seed/origin are lost with them, which
    // is the honest trade -- those were chosen for a different feature -- and the webview is free
    // to re-post a `generate` off its own restored controls if it would rather keep them.
    this.lastParams = null
    this.rememberParams()
    // And the picker is re-seeded, which is the other half: `init` is posted from the 'ready'
    // handler and nowhere else, so a panel that had already booted went on showing the previous
    // feature in its own Feature/Rule dropdown and in the sidebar -- disagreeing with its own tab
    // title. See tryPostInit and PanelHandle.seedOpenedDocument's "opened file always wins".
    this.tryPostInit()
    // AND THE OVERLAY, which described the run this panel is no longer about.
    //
    // For roughly the second it takes the new run to come back, the 3D view went on painting the
    // PREVIOUS node's cells -- 88 of them, measured -- under a readout that retargetTo had
    // already emptied and a tab that had already renamed itself, while the graph was naming the
    // new node. Coloured cells nothing on screen accounts for is the worst of the three states
    // this can be in: "no highlight yet" is legible, "last run's highlight, labelled" is at least
    // honest, and "last run's highlight, labelled with nothing" reads as a bug in the renderer.
    //
    // The index goes with it rather than being kept until the next one replaces it: it is keyed
    // to cells of a volume that is about to be thrown away, so every click resolved against it in
    // the meantime would answer about the wrong run. attributeNode() re-arms this the moment the
    // caller says which node the new file is being previewed for -- which, on the follow-the-
    // selection path this method exists for, is the very next call.
    this.clearAttributionOverlay()
    this.pending = this.pending.then(() => this.regenerate())
  }

  /** Takes the write-attribution highlight, its index and its readout off the screen, leaving the
   * plain preview. Safe on a panel that never had one. */
  private clearAttributionOverlay(): void {
    this.attributionBridge?.dispose()
    this.attributionBridge = null
    this.postAttributionUnavailable()
  }

  /** Called when the preview command is re-invoked on this panel's document -- queues a plain
   * regenerate behind whatever is already in flight. No pack reload: nothing on disk changed,
   * this is "show me again". Disk changes go through notifyPackFileSaved below instead. */
  notifyDocumentChanged(document: vscode.TextDocument): void {
    this.document = document
    this.pending = this.pending.then(() => this.regenerate())
  }

  /** Called for EVERY document save anywhere (extension.ts fans each save out to every open
   * panel); decides locally whether it invalidates THIS panel's loaded pack, and if so queues
   * reload-then-regenerate. This replaces the old save wiring, which queued a plain
   * regenerate() and only for the previewed document itself -- a regenerate against an engine
   * Workspace still holding the PRE-save file contents, so the core edit-save-look loop showed
   * the previous result and the save appeared to do nothing (only the panel's manual "Reload
   * files" button actually picked the edit up). Relevance is "the previewed file itself, or any
   * file the engine loads from this panel's pack" (isEngineLoadedPackFile's own doc comment) --
   * the second half is what makes editing a REFERENCED sub-feature refresh the preview of its
   * parent, which previously went silently stale.
   *
   * What this does NOT see, and never did, is a file appearing or disappearing without a save:
   * a delete or rename in the Explorer fires no save event for the file that went away. Before
   * the reload became incremental, the NEXT save of any other pack file happened to re-walk
   * the pack and notice, which was luck rather than design; now it does not. The escape hatch
   * is the one that was always the answer to "I don't trust this picture" -- the "Reload
   * files" button, which re-reads everything. */
  notifyPackFileSaved(document: vscode.TextDocument): void {
    const isOwnDocument = document.uri.toString() === this.document.uri.toString()
    if (isOwnDocument) this.document = document
    const invalidatesPack = isOwnDocument || this.invalidatedBy(document.uri.fsPath)
    if (!invalidatesPack) return
    // The saved document's own path goes down with the reload: this method is the ONE place
    // that knows which file changed, and throwing that away here is what used to make every
    // save pay a full re-read of the pack to rediscover it. See reloadFiles's own comment for
    // why the button next door deliberately does not pass it.
    this.pending = this.pending.then(() => this.reloadFiles(document.uri.fsPath))
  }

  /** Whether a write to `filePath` makes this panel's loaded pack out of date. The pack ROOT
   * itself counts: the graph panel declares a whole pack stale after an operation whose referrers
   * it cannot list in advance (a rename, a delete), and it does that by naming the root. */
  private invalidatedBy(filePath: string): boolean {
    if (this.packRoot === null) return false
    if (path.relative(this.packRoot, filePath) === '') return true
    return isEngineLoadedPackFile(this.packRoot, filePath)
  }

  /** A BURST of pack writes, as one reload -- what extension.ts hands over after it has collapsed
   * a run of them (see its own PACK_WRITE_DEBOUNCE_MS).
   *
   * One reload for the whole burst, not one per path. Ten quick edits in the node editor used to
   * be ten full reload-and-regenerate cycles per open preview: serialised, so they could not race,
   * but not collapsed, so the author watched nine answers they had already moved past go by before
   * the one they were waiting for.
   *
   * INCREMENTAL ONLY FOR A SINGLE FILE. reloadFiles' fast path re-reads exactly the file it is
   * given (see its own comment), which is right when one file changed and wrong the moment two
   * did; a burst that touched several -- or that named the pack root, which is how a rename or a
   * delete declares "every referrer moved" -- gets the full re-read.
   *
   * `documents` are the freshly-opened copies of whatever paths VS Code could open, so a panel
   * whose OWN document is in the burst is left holding the new bytes rather than the pre-write
   * ones. That is the one thing this needs a document for at all. */
  notifyPackFilesWritten(documents: readonly vscode.TextDocument[], paths: readonly string[]): void {
    if (this.disposed) return
    for (const document of documents) {
      if (document.uri.toString() === this.document.uri.toString()) this.document = document
    }
    const own = this.document.uri.fsPath
    const relevant = paths.filter((p) => p === own || this.invalidatedBy(p))
    if (relevant.length === 0) return
    const single = relevant.length === 1 && this.packRoot !== null && path.relative(this.packRoot, relevant[0]!) !== '' ? relevant[0] : undefined
    this.pending = this.pending.then(() => this.reloadFiles(single))
  }

  /** Runs a fresh `generate` and posts its result/error to the webview -- see this class's own
   * header comment for the lastParams-vs-file-derived fallback rule.
   *
   * # The request-timeout / placement-budget coupling
   *
   * featurelab.requestTimeoutMs (this extension's own setting -- how long it waits for a
   * response before declaring the engine stale) and placementTimeLimitMs (a per-request field
   * on `params`, driven by the webview panel's Budget section -- how long the ENGINE spends
   * placing before cutting the run off as partial) are two independent knobs that happen to
   * measure overlapping things. Left uncoupled, a user raising placementTimeLimitMs above their
   * configured requestTimeoutMs would see a run that is still legitimately working reported as
   * a dead engine partway through -- the RPC layer times out and gives up while the engine is
   * still placing. effectiveGenerateTimeoutMs (above) computes a wait that's always at least the
   * placement budget plus headroom, and this method never sends less than that for a `generate`
   * call specifically -- loadPack/environments calls elsewhere in this file are unaffected, they
   * have no placement budget to exceed. When that raises the wait above what the user actually
   * configured, this posts a `timeoutInfo` message so panel.ts's Budget section can say so
   * (PanelHandle.setTimeoutInfo) -- never a silent override.
   *
   * # Sticky grow-to-fit
   *
   * Whether THIS call uses generate() or generateGrown() is `this.lastRequestWasGrow` -- see
   * that field's own doc comment. This is what makes panel.ts's sticky "grow every run" toggle
   * apply even to a save-triggered regenerate, which never round-trips through the webview at
   * all: the toggle's effect is remembered here, not re-derived from anything webview-side each
   * time. */
  private async regenerate(): Promise<void> {
    return this.runGenerateOrGrown(this.lastRequestWasGrow)
  }

  /** "Grow to fit and regenerate": expands the bench bounds to cover blocks a feature wrote
   * outside them, then generates again at the larger size -- always generateGrown(), regardless
   * of `this.lastRequestWasGrow` (that field is about what a FUTURE regenerate() should inherit,
   * not a gate on this explicit call). See runGenerateOrGrown for the shared implementation both
   * this and regenerate() above drive. */
  private async growRegenerate(): Promise<void> {
    return this.runGenerateOrGrown(true)
  }

  /** Shared body of regenerate()/growRegenerate() above -- same lastParams-vs-file-derived
   * params resolution, same effectiveGenerateTimeoutMs/timeoutInfo handling, same postStale/
   * try-catch-into-handleGenerateError, differing only in which controller method actually runs
   * the request. No new webview-bound message type is needed for a grown result: the grown
   * response is a superset of the normal `generate` response (adds `grown` and `preGrowBounds`;
   * the frontend decoder tolerates the extra fields), so this posts it via the same
   * postResult()/updateDiagnostics() pair either way.
   *
   * generateGrown() itself lives on PreviewController (previewController.ts), a file this class
   * doesn't own -- see GrowCapablePreviewController's own doc comment for why this reads
   * `this.controller` through that local interface instead of PreviewController's real, narrower
   * type. */
  private async runGenerateOrGrown(useGrown: boolean): Promise<void> {
    if (this.disposed) return
    if (this.packRootError !== null || this.packRoot === null) {
      this.postError(`cannot preview this file: ${this.packRootError}`)
      return
    }
    const packRoot = this.packRoot
    const config = vscode.workspace.getConfiguration('featurelab')
    const configuredTimeoutMs = config.get<number>('requestTimeoutMs', 30_000)

    // Once the user has touched a generation-config control in the panel, lastParams is what
    // drives every regenerate from then on (including a plain document save) -- see this
    // file's header comment. Only while it's still null (nothing touched yet, including right
    // after this panel was first created) does a save fall back to "preview the saved file's
    // own identifier" -- kind-aware (see parseDocumentIdentifier's own doc comment): a rule
    // file falls back to `{rule: id}`, never the `{feature: id}` every request used to send
    // regardless of which kind of file was actually open.
    //
    // A THIRD CASE SITS BETWEEN THOSE TWO: params that describe a bench but name nothing to put
    // in it. That is what freshPreviewParams hands a revived tab whose file was renamed between
    // windows -- the seed, the origin and the sizes are still the author's, the feature name is
    // not the file's any more and was dropped. Those keep the bench and take the identifier from
    // the file, which is the whole point of dropping it; without this they would be sent as they
    // are and the engine would be asked to generate nothing in particular.
    const remembered = this.lastParams
    const namesTarget =
      remembered !== null && (typeof remembered.feature === 'string' || typeof (remembered as { rule?: unknown }).rule === 'string')
    let requested: GenerateParamsWire
    if (remembered !== null && namesTarget) {
      requested = remembered
    } else {
      const envId = config.get<string>('env', 'plains')
      let parsed: ReturnType<typeof parseDocumentIdentifier>
      try {
        parsed = parseDocumentIdentifier(this.document.getText())
      } catch (err) {
        const message = err instanceof DocumentParseError ? err.message : String(err)
        this.postError(`cannot preview this file: ${message}`)
        return
      }
      const derived = parsed.kind === 'rule' ? { rule: parsed.identifier } : { feature: parsed.identifier }
      // The bench first so anything it says (its own `env`, above all) wins over the setting,
      // and the file-derived identifier last so it wins over nothing at all.
      requested = remembered === null ? { ...derived, env: envId } : { env: envId, ...remembered, ...derived }
    }

    // The ONE place a profile is ever asked for, and only while this panel is attributing a
    // node -- see this file's header on why that is the whole rule. A COPY, never a mutation of
    // `lastParams`: that object is the webview panel's own control state, including the user's
    // own "Enable profiling" checkbox, and writing into it would leave profiling switched on in
    // their UI because the graph asked this panel a question. When they have already ticked it
    // themselves, this changes nothing -- the run was already profiled.
    const params = this.attributionNodeId !== null && requested.profile !== true ? { ...requested, profile: true } : requested

    const timeoutMs = effectiveGenerateTimeoutMs(configuredTimeoutMs, params)
    this.postTimeoutInfo(configuredTimeoutMs, timeoutMs)

    this.postBusy()
    this.postStale(false)
    // A regenerate that starts while one is in flight supersedes it. The engine runs one request
    // at a time, so an abandoned run is not free -- it is the thing standing between the user and
    // the run they are actually waiting for.
    this.inflightGenerate?.abort()
    const inflight = new AbortController()
    this.inflightGenerate = inflight
    // The status-bar spinner, and not a progress notification: this method is also what a SAVE
    // runs, and a notification per save is how people learn to dismiss notifications without
    // reading them. The command that opens a preview raises its own notification once, around
    // the first run (see whenFirstResult).
    const busy = showBusy(useGrown ? 'growing and regenerating the preview' : 'generating the preview')
    const started = Date.now()
    log(
      `Generate${useGrown ? ' (grown)' : ''} in ${packRoot}: ` +
        `${params.feature !== undefined ? `feature ${params.feature}` : `rule ${String(params.rule)}`}, ` +
        `env ${String(params.env ?? 'default')}, wait ${String(timeoutMs)}ms`,
    )
    try {
      // useGrown always re-runs generateGrown() with THIS call's own current `params` -- the
      // engine itself refits the grow bounds fresh from THIS run's own overflow every time
      // (wire.RunGenerateGrown's own doc comment: two ordinary generate calls, the second only
      // when the first actually captured overflow) rather than reusing a size computed by an
      // earlier grow. That is what satisfies "refit on every run, never freeze the bounds from
      // the first grow" for panel.ts's sticky toggle with no extra bookkeeping needed here.
      const result = useGrown
        ? await (this.controller as unknown as GrowCapablePreviewController).generateGrown(packRoot, params, timeoutMs, inflight.signal)
        : await this.controller.generate(packRoot, params, timeoutMs, inflight.signal)
      if (this.disposed) return
      if (this.superseded(inflight)) return
      log(`Generate finished in ${String(Date.now() - started)}ms`)
      this.postResult(result)
      this.lastResult = result
      this.reportBlockNotes(result)
      // AFTER the result is posted, never before: the webview's viewer has to be holding this
      // run's own volume before a mask indexed against it can mean anything, and the two
      // messages are delivered in the order they are sent.
      this.dropAttributionIfNodeGone(result)
      this.applyAttribution(result)
      this.reportRunStats(result, params)
      const wireDiagnostics = extractDiagnostics(result)
      // `params` is what we actually asked for, so its feature/rule id is exactly the identifier
      // the engine will report as the placement root. See documentFileIds for the rest.
      const requestedId = params.feature ?? params.rule ?? ''
      updateDiagnostics(this.diagnosticCollection, this.document, this.documentFileIds(requestedId), wireDiagnostics)
      // AND ASK ABOUT THE BLOCK TEXTURES AGAIN. Not awaited, so it never sits between a finished
      // run and the picture: this run is already on screen by the line above, and a repainted
      // texture arrives a beat later as a fresh atlas. Until this existed the atlas was settled
      // in the panel's first second and never revisited, so editing a texture with the preview
      // open did nothing at all for the rest of the session. See TextureCheckMode's 'refresh'
      // for everything this is forbidden from doing (asking, downloading, or speaking up when
      // nothing moved).
      void this.ensureTextures('refresh')
    } catch (err) {
      if (this.disposed) return
      if (this.superseded(inflight)) return
      this.handleGenerateError(err)
    } finally {
      busy.dispose()
      // Only if it is still OURS. A regenerate that superseded this one has already put its own
      // controller here, and clearing that would leave the newer run uncancellable -- the Cancel
      // pill would be on screen over a run nothing could reach.
      if (this.inflightGenerate === inflight) this.inflightGenerate = null
    }
  }

  /** Whether a newer regenerate has already taken this panel over, so `inflight`'s outcome --
   * result OR error -- must not reach the screen.
   *
   * Both halves matter and neither is theoretical. A superseded run that WON the race (the engine
   * answered it just as the next request went out) would post an older volume over a newer one:
   * the picture on screen would be a run the pack has moved past, with nothing saying so. A
   * superseded run that was cancelled -- which is what runGenerateOrGrown does to it, on purpose,
   * to stop it holding the engine's one worker -- comes back as a RequestCancelledError, and
   * handleCancelled's whole job is to raise the "the preview was cancelled" banner. Nobody
   * cancelled anything: the panel is mid-regenerate and about to draw. Letting that through is
   * how a burst of edits ends with a stale banner over a perfectly current picture.
   *
   * `inflightGenerate` is the identity: runGenerateOrGrown writes its own controller there before
   * awaiting, and only the newest run's is still in place. */
  private superseded(inflight: AbortController): boolean {
    if (this.inflightGenerate === inflight) return false
    log('A newer regenerate took over, so this run\'s outcome is dropped rather than drawn.')
    return true
  }

  /** Every spelling the engine might use for THIS panel's own document in a diagnostic's
   * `fileId`, plus the identifier this run actually requested. Handed to updateDiagnostics,
   * which keeps whatever matches any of them and drops the rest.
   *
   * THREE SPELLINGS, AND ALL THREE ARE LIVE AT ONCE. The engine's loader used to key a file by
   * its BASENAME ("tree_acacia_branching.json") and now keys it PACK-RELATIVE, with forward
   * slashes ("features/tree_acacia_branching.json"); placement-time diagnostics are keyed by the
   * requested identifier instead (see updateDiagnostics's own doc comment). Passing only the
   * basename matched 0 of 4 real diagnostics against a current engine, and because a list that
   * matches nothing is indistinguishable here from a run with nothing to say, the collection was
   * simply DELETED -- VS Code's Problems view went blank with no message, while the panel's own
   * Diagnostics section (which never filtered) went on showing all four. That is the shape this
   * bug takes and the reason it survived: the in-panel list self-heals.
   *
   * Both file spellings go over on every run rather than one being chosen, because the engine is
   * not ours to pin: `featurelab.binaryPath` can point at an older build than the one this
   * extension shipped with, and the two must both work from the same code. They cannot collide --
   * a diagnostic carries one fileId, and a basename and a pack-relative path are only ever equal
   * for a file sitting in the pack root, where they are the same file anyway.
   *
   * The pack-relative form is skipped for a document OUTSIDE the pack root (path.relative
   * escaping upwards), which is not a spelling the engine can produce for a file it never
   * loaded. */
  private documentFileIds(requestedId: string): string[] {
    const ids = [path.basename(this.document.fileName), requestedId]
    if (this.packRoot !== null) {
      const relative = path.relative(this.packRoot, this.document.uri.fsPath)
      if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        // Forward slashes always: the engine's own file ids are pack-relative POSIX paths, and
        // on Windows path.relative answers with backslashes.
        ids.push(relative.split(path.sep).join('/'))
      }
    }
    return ids
  }

  // -------------------------------------------------------------------------
  // Write attribution
  // -------------------------------------------------------------------------

  /** Puts this panel into attribution mode for `nodeId` -- "highlight the blocks THIS node
   * placed", and from here on "tell the graph which node placed the block I clicked".
   *
   * The only entry point into the feature, and the only thing that ever makes this panel ask
   * for a profile. See this file's header for why that gate is where it is.
   *
   * TWO PATHS OUT, and the difference is whether an engine round trip is needed at all:
   *
   *   - This panel already holds an index -- the last run was profiled, because this panel was
   *     already attributing something, or because the user ticked "Enable profiling" themselves.
   *     Then selecting another node is a lookup, not a run: the answer for EVERY node is already
   *     in the table, so clicking through a graph with "Preview on select" on re-highlights
   *     instantly instead of regenerating once per click.
   *   - There is no index. Then a regenerate is queued, and it is that regenerate -- not this
   *     call -- that asks for the profile.
   *
   * Selecting the node this panel is ALREADY attributing still re-resolves rather than returning
   * early, because the graph re-sends on every selection and the index may have been rebuilt
   * underneath by a save in between. The bridge itself drops the duplicate emit. */
  attributeNode(nodeId: string): void {
    if (this.disposed) return
    this.attributionNodeId = nodeId
    if (this.attributionBridge !== null) {
      this.attributionBridge.selectNode(nodeId)
      return
    }
    this.pending = this.pending.then(() => this.regenerate())
  }

  /** Stops attributing a node the loaded pack no longer defines.
   *
   * THE CONTRADICTION THIS ENDS. Rename an identifier in the text editor and save: the reload
   * makes the new name real, the regenerate runs it, and 79 blocks appear -- but this panel was
   * still attributing the OLD name, so the bridge resolved it to nothing and the readout said
   * `wiki:fancy_oak_tree placed no blocks in this run` directly above a legend reading
   * `wiki:fancy_oak_tree_renamed  79 blocks`. Two sentences about one run, on one screen,
   * disagreeing -- while the graph, which rebuilds from the files, was already right.
   *
   * "Placed no blocks" is a true and useful thing to say about a node that ran and wrote nothing,
   * which is why it cannot simply be suppressed: a filter, an aggregate, a refused placement all
   * land there legitimately. The difference is whether the pack still HAS the node, and the
   * result's own `entries` -- the identifier list the Feature picker is built from, and the same
   * list whose absence produces panel.ts's `not found in loaded files` -- is exactly that answer,
   * from the same run, with no second round trip.
   *
   * SILENT WHEN THERE IS NO EVIDENCE. A response with no `entries` array is what
   * GenerateParams.omitEntries asks for and what an older engine may send; "the list is not here"
   * is not "the node is not in it", and tearing the highlight down on that would break
   * attribution for every host that asks for the smaller response. */
  private dropAttributionIfNodeGone(result: unknown): void {
    const nodeId = this.attributionNodeId
    if (nodeId === null) return
    const wire = result as { entries?: unknown; ruleEntries?: unknown } | null
    const entries = wire?.entries
    if (!Array.isArray(entries)) return
    const has = (list: unknown): boolean =>
      Array.isArray(list) && list.some((e) => (e as { identifier?: unknown } | null)?.identifier === nodeId)
    if (has(entries) || has(wire?.ruleEntries)) return
    log(`No longer attributing ${nodeId}: the loaded pack does not define it any more.`)
    this.attributionNodeId = null
    this.clearAttributionOverlay()
  }

  /** Rebuilds the index from a fresh result and re-resolves the current selection.
   *
   * EVERY FAILURE HERE IS SILENT, and that is the point. A response with no `profile` is what an
   * engine older than the field sends, and what a run whose placement was refused sends, and
   * what this panel itself gets on a regenerate that happens to land before attributeNode was
   * ever called. None of those is a thing a user can act on, and a preview that started showing
   * an error because a highlight was unavailable would have traded a working preview for a
   * broken one. So the overlay is cleared, the webview is told the answer is unavailable -- which
   * it renders as nothing at all -- and the preview goes on being exactly the preview it was.
   *
   * The one case that gets a line in the output channel is a table that cannot mean anything:
   * fromProfile throws only on parallel arrays of differing lengths, which is a broken response
   * rather than a possible run. Still not a dialog, and still degraded rather than surfaced --
   * but silently swallowing it would leave nothing anywhere to trace a missing highlight to. */
  private applyAttribution(result: unknown): void {
    if (this.attributionNodeId === null) return
    const profile = (result as { profile?: ProfileWire | null } | null)?.profile ?? null
    const bounds = (result as { bounds?: CellBounds } | null)?.bounds ?? null

    let index: AttributionIndex | null = null
    if (profile !== null && profile !== undefined && profile.attribution !== null && profile.attribution !== undefined) {
      try {
        index = AttributionIndex.fromProfile(profile, bounds)
      } catch (err) {
        this.warnAboutAttribution(
          `the engine's write-attribution table could not be read -- ${err instanceof Error ? err.message : String(err)}`,
        )
        index = null
      }
    }

    this.attributionBridge?.dispose()
    this.attributionBridge = null
    if (index === null) {
      this.postAttributionUnavailable()
      return
    }
    const bridge = createAttributionBridge(index)
    // The bridge emits; this listener is the only thing that acts on what it emits, in BOTH
    // directions. That is the asymmetry graph/attribution.ts's own header describes: this side
    // emits, the graph side applies without emitting (render.ts's setSelection does not fire
    // onSelect), so a selection travelling between the two panels stops rather than circulating.
    bridge.onSelect((selection) => this.onAttributionSelection(selection))
    this.attributionBridge = bridge
    bridge.selectNode(this.attributionNodeId)
  }

  /** Sends the graph what this run measured, per feature -- or null when it measured nothing.
   *
   * Gated on the SAME switch attribution is, and on nothing else: a panel that is not attributing
   * a node has no profile to report and never asked for one. This method is why that profile
   * pays for two features instead of one.
   *
   * The rows go over RAW (see RunStatsWire). What a number means for a given node -- did it run,
   * is a rule even measurable, is a zero a finding or the normal state of a filter -- is
   * graph/nodeStats.ts's question, and it gets asked once, on the side that also draws the
   * answer.
   *
   * `origin` and `partial` travel with them because they change what the numbers MEAN: a count
   * from a truncated run is a floor, and "did not run" is only ever true of one origin. */
  private reportRunStats(result: unknown, params: GenerateParamsWire): void {
    if (this.packRoot === null) return
    const report = this.graphLink.onRunStats
    if (report === undefined) return
    // NOT gated on attribution any more, and that was the bug. `onRunStats` exists only on a
    // panel the GRAPH opened, so "is there anybody to tell" is already answered by the callback
    // being there at all -- adding "and is it attributing something" on top meant a graph-driven
    // preview that was not in attribution mode went on showing the numbers from some earlier run,
    // indefinitely, with nothing to say they were stale. A run with no profile reports `null`
    // below, which is what takes them back off the cards.
    const wire = result as {
      profile?: { featureIdentifiers?: string[]; features?: unknown[] } | null
      origin?: { x: number; y: number; z: number }
      partial?: boolean
    } | null
    const profile = wire?.profile ?? null
    report(this.packRoot, {
      // A profile with no `features` array is the same nothing as no profile at all, and saying
      // so here keeps the graph from having to tell two shapes of absence apart.
      profile: profile && Array.isArray(profile.features) ? { featureIdentifiers: profile.featureIdentifiers, features: profile.features } : null,
      previewed: params.feature ?? params.rule ?? '',
      origin: wire?.origin ?? null,
      writeBudget: params.writeBudget ?? null,
      partial: wire?.partial === true,
    })
  }

  /** The one place a resolved selection turns into messages -- one to this panel's own webview,
   * one to the graph. Both directions come through here because both directions ARE one
   * selection; splitting them would be two code paths that have to agree about what is currently
   * selected, which is the bug the bridge exists to make impossible. */
  private onAttributionSelection(selection: AttributionSelection): void {
    if (this.disposed || selection === null) return
    if (selection.kind === 'node') {
      const total = selection.cells.length
      const shown = Math.min(total, ATTRIBUTION_CELL_LIMIT)
      // Array.from over a SUBARRAY, not over the whole view: this is what crosses the wire.
      const cells = Array.from(selection.cells.subarray(0, shown))
      this.post({
        type: 'attribution',
        available: true,
        nodeId: selection.nodeId,
        cells,
        cellCount: total,
        shown,
        writes: selection.writes,
        // EVERY writer this run had, one colour each -- see attributionGroupsFor. The `cells`
        // field above stays exactly what it was, which is what keeps a frontend that only knows
        // setAttributionCells drawing the selected node alone rather than nothing at all.
        groups: this.attributionGroupsFor(selection.nodeId, cells),
      })
      return
    }
    // A block was clicked. The preview marks it; the GRAPH is where the answer is read, because
    // "which node placed this" is a question about the graph, and the node card is what carries
    // the node's name, its type and its file.
    this.post({
      type: 'attributionCell',
      cell: selection.cell,
      position: selection.position,
      writers: selection.writers.map((w) => ({ nodeId: w.nodeId, writes: w.writes })),
      writes: selection.writes,
    })
    // EVERY writer, never the first one. A cell written by two features is the normal case, and
    // graph/attribution.ts's header is explicit that which of them a viewer is actually looking
    // at is not recoverable from this contract -- so naming one of them here would be a guess
    // dressed as an answer, in exactly the case somebody clicked the block to understand.
    const nodeIds = selection.writers.map((w) => w.nodeId).filter((id): id is string => id !== null)
    if (this.packRoot !== null) this.graphLink.onSelectNodes?.(this.packRoot, nodeIds)
  }

  /** Every feature that wrote anything in the run currently on screen, as the viewer's own
   * per-writer overlay groups (VoxelViewer.setAttributionGroups).
   *
   * WHY ALL OF THEM AND NOT JUST THE SELECTED ONE. One colour can only answer "is this block one
   * of that node's". The question somebody actually has in front of a preview is "which of these
   * is whose", and its interesting answer is nearly always more than one feature: a scatter and
   * the tree it delegates to, two features fighting over the same column. The engine's table
   * already names every writer -- the host was throwing that away and shipping one node's cells.
   *
   * THE SELECTED NODE IS FIRST, always. Colours are assigned by position from the viewer's own
   * series, whose first entry is the blue-violet the single-writer overlay has always used, so
   * the node somebody clicked keeps a stable colour no matter who else wrote this run, and a
   * preview with one writer looks exactly as it did. The rest follow by size, largest first,
   * with ties broken by name so the same run always paints the same picture.
   *
   * PAST THE SERIES THE TAIL IS GROUPED rather than wrapped: a seventh writer drawn in the first
   * one's colour is a legend that lies about which blocks are whose. The band says how many
   * features it stands for.
   *
   * ONE BUDGET FOR THE WHOLE MESSAGE. The selected node's cells are already on the wire under
   * `cells` (this is what pays for the shim), so what they cost comes off the same
   * ATTRIBUTION_CELL_LIMIT the rest of the groups draw from -- a message cannot grow by a factor
   * of the number of writers just because a run had several. Whatever the budget cannot cover is
   * simply not painted, and the viewer's legend then reports what it actually painted rather
   * than a number nothing on screen backs up. */
  private attributionGroupsFor(selectedNodeId: string, selectedCells: readonly number[]): { id: string; label: string; cells: readonly number[] }[] {
    const index = this.attributionBridge?.index
    if (index === undefined) return []
    const groups: { id: string; label: string; cells: readonly number[] }[] = [
      { id: selectedNodeId, label: selectedNodeId, cells: selectedCells },
    ]
    let budget = ATTRIBUTION_CELL_LIMIT - selectedCells.length

    const seen = new Set<string>([selectedNodeId])
    const others: { id: string; cells: number }[] = []
    for (const id of index.nodeIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const cells = index.distinctCellsWrittenBy(id)
      // A feature that ran and wrote nothing is an ANSWER, but it is not a colour: an empty
      // legend row spends one of six distinguishable colours on a band with nothing under it.
      if (cells > 0) others.push({ id, cells })
    }
    others.sort((a, b) => b.cells - a.cells || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const take = (ids: readonly string[]): number[] => {
      const out: number[] = []
      for (const id of ids) {
        if (budget <= 0) break
        const cells = index.cellsWrittenBy(id)
        const n = Math.min(cells.length, budget)
        for (let i = 0; i < n; i++) out.push(cells[i] as number)
        budget -= n
      }
      return out
    }

    // A writer the budget could not reach is left OFF, rather than sent as a band with nothing
    // under it: the legend is read as "this colour, these blocks", and a row standing over no
    // blocks at all is the one thing it must not say. The selected node keeps its place either
    // way -- its cells are the first thing the budget pays for.
    const push = (id: string, label: string, ids: readonly string[]): void => {
      const cells = take(ids)
      if (cells.length > 0) groups.push({ id, label, cells })
    }
    const ownColours = others.length <= ATTRIBUTION_GROUP_LIMIT - 1 ? others.length : ATTRIBUTION_GROUP_LIMIT - 2
    for (const writer of others.slice(0, ownColours)) push(writer.id, writer.id, [writer.id])
    const tail = others.slice(ownColours)
    if (tail.length > 0) push(ATTRIBUTION_TAIL_GROUP_ID, `${String(tail.length)} more features`, tail.map((w) => w.id))
    return groups
  }

  /** A click in the 3D view, resolved here rather than there -- the webview named a position,
   * and nothing else.
   *
   * Ignored outright unless this panel is attributing something AND has an index to attribute
   * against. A webview posting this without either has drifted out of step with its host, which
   * is a bug here and not something a user can act on. */
  private pickCell(message: WebviewToHostMessage): void {
    const bridge = this.attributionBridge
    if (bridge === null || this.attributionNodeId === null) return
    const { x, y, z } = message
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    // selectPosition clears the selection for a position outside the previewed volume, which is
    // an ordinary thing for a click to be rather than an error -- see AttributionIndex.entryAt.
    bridge.selectPosition({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) })
  }

  /** Tells the webview there is no answer, which it renders as no overlay and no readout -- i.e.
   * as the preview it already was. Posted rather than skipped so a panel that HAD a highlight and
   * then regenerated into an unprofiled result clears it, instead of leaving a highlight
   * describing a run that no longer exists. */
  private postAttributionUnavailable(): void {
    this.post({ type: 'attribution', available: false, nodeId: this.attributionNodeId, cells: [], cellCount: 0, shown: 0, writes: 0 })
  }

  /** One line, once per panel, in the shared output channel. Never a dialog and never the panel's
   * error slot -- that slot is for a failed generate, and filling it with a missing highlight
   * would hide a result that is perfectly good. */
  private warnAboutAttribution(detail: string): void {
    if (this.warnedAboutAttribution) return
    this.warnedAboutAttribution = true
    this.textureOutput().appendLine(`Feature Lab: ${detail}`)
  }

  private handleGenerateError(err: unknown): void {
    if (err instanceof RequestCancelledError) {
      this.handleCancelled(err)
      return
    }
    if (err instanceof EngineDisposedError) {
      // This panel is bound to a controller the host has already replaced. There is no recovery
      // inside the panel -- the remedy is to reopen it -- so it says exactly that and stays
      // stale. Before the tombstone existed this branch could not be reached, because the
      // controller simply restarted the OLD binary and the run succeeded against an engine the
      // user believed they had stopped using. See EngineDisposedError.
      this.engineLevelFailure = true
      this.postStale(true, err.message)
      return
    }
    if (err instanceof EngineCrashedError) {
      // The engine's own last words, verbatim and whole -- the tail it collected is the only
      // direct evidence there is about why the process died, and it is far longer than a
      // notification can carry.
      if (err.stderrTail.length > 0) log(`Engine stderr before it exited:\n    ${err.stderrTail.split('\n').join('\n    ')}`)
      this.engineLevelFailure = true
      this.postStale(true, `The featurelab engine process crashed: ${err.message}`)
      return
    }
    if (err instanceof MalformedResponseError) {
      log(`Engine sent this unreadable line: ${err.rawLine}`)
      this.engineLevelFailure = true
      this.postStale(true, `The featurelab engine sent an unreadable response: ${err.message}`)
      return
    }
    if (err instanceof RequestTimeoutError) {
      this.engineLevelFailure = true
      this.postStale(true, err.message)
      return
    }
    if (err instanceof RpcError) {
      // The engine answered, and its answer was "no". That is about the PACK, not about the
      // engine -- see reportFailure for why those two are told to the user differently.
      this.postError(err.message)
      return
    }
    this.engineLevelFailure = true
    this.postError(describeError(err))
  }

  /** The single host->webview send funnel: buffers while the webview hasn't reported 'ready'
   * yet (see outbox's own doc comment for the dropped-message race this exists for), sends
   * directly ever after. Every postX helper below MUST go through this, not
   * panel.webview.postMessage -- a direct call reintroduces the race for exactly that one
   * message type. */
  private post(message: unknown): void {
    if (!this.webviewReady) {
      this.outbox.push(message)
      return
    }
    void this.panel.webview.postMessage(message)
  }

  private flushOutbox(): void {
    for (const message of this.outbox) void this.panel.webview.postMessage(message)
    this.outbox.length = 0
  }

  /** Marks the webview busy for a request THIS class initiates on its own (the constructor's
   * first regenerate, a save-triggered one) -- the webview can't know those started, unlike its
   * own control-driven requests, which set busy locally before posting (webview/main.ts).
   * Never pairs with an explicit un-busy: panel.ts's setResult/setError/setStale(true) already
   * clear busy as a safety net (see applyBusy's doc comment there), and every path out of
   * runGenerateOrGrown/reloadFiles ends in one of those. */
  private postBusy(): void {
    this.post({ type: 'busy', busy: true })
  }

  /** Hands the webview the engine's answer, WHOLE.
   *
   * Whole is the contract, and the part of it that has actually been got wrong is `stops`: the
   * rows saying where a feature's work ended early -- "iterations = 0, 412 times" -- which are the
   * answer to "why is this preview empty". They used to reach the viewer only by riding the
   * PROFILE, and a profile is only asked for when the graph has put this panel into attribution
   * mode (see regenerate's `profile: true` splice). So the one case the explanation exists for --
   * somebody watching an empty preview, with profiling off, which is the default -- was the one
   * case it never arrived in, and the panel fell back to "no stop reasons from this engine".
   *
   * The engine now carries them at the TOP LEVEL of a generate response, and nothing here filters,
   * rewrites or gates them. Three states, and they are three different things:
   *   - absent: an engine that predates the field. The viewer says so rather than implying that
   *     nothing stopped (frontend/src/protocol.ts's `stopsKnown`).
   *   - present and empty: this engine reports stops and there were none. A real answer.
   *   - present and populated: the reasons, named.
   * An empty array must therefore never be normalised into absence, nor absence into an empty
   * array. The safest way to hold that is to forward the object untouched, which is what this
   * does; the log line is the only thing added, and only so a reader can tell the three apart.
   *
   * THERE IS NOW EXACTLY ONE EXCEPTION, and it is written out rather than folded in quietly.
   * `diagnostics` is re-ordered and the PACK-scoped half is folded into a single row (see
   * packContents.ts's scopedForPreview). The engine emits pack diagnostics first because that is
   * the order it builds libraries in, so every preview of every feature opened with two to four
   * several-hundred-character paragraphs about files the author was not looking at, and the one
   * line explaining why THIS preview was empty sat underneath them. Nothing is dropped -- the
   * summary row carries every pack-scoped message whole, and the panel's own "Show more"
   * disclosure reveals them, which is what makes the fold safe to do at all. Nothing else in the
   * response is touched, and the VS Code Problems view is fed from the UNSUMMARISED list (see
   * regenerate): a problems list is the durable place a pack-wide problem belongs, and a folded
   * row there would hide the file it is about. */
  private postResult(result: unknown): void {
    this.post({ type: 'result', result: withPreviewDiagnostics(result) })
    const stops = (result as { stops?: unknown } | null)?.stops
    if (Array.isArray(stops)) log(`Run reported ${String(stops.length)} stop reason(s).`)
    this.finishFirstResult()
  }

  private postError(message: string): void {
    this.post({ type: 'error', message })
    this.reportFailure(message)
  }

  private postStale(stale: boolean, reason?: string): void {
    this.post({ type: 'stale', stale, reason })
    if (stale) this.reportFailure(reason ?? 'the preview went stale')
  }

  /** Resolves when this panel's first run produced something to look at; rejects with the reason
   * it did not. See firstResult's own doc comment. */
  whenFirstResult(): Promise<void> {
    return this.firstResult
  }

  /** What happens when the webview has said nothing for WEBVIEW_READY_TIMEOUT_MS.
   *
   * It has to say it TWICE OVER, because there are two different situations by then and only one
   * of them has anybody listening:
   *
   *   - The first run has not finished. A command is holding a progress notification over this
   *     panel, so the reason goes back through whenFirstResult and the command phrases it. That is
   *     the graph panel's case exactly (failFirstGraph).
   *   - The first run already finished. This is the commoner one here and the one the finding is
   *     about: `postResult` settles whether or not the webview ever loaded, because a result is
   *     buffered for a webview that has not reported ready. So the command returned happy, and the
   *     author is looking at a blank rectangle with nothing anywhere to say why. Nobody is left to
   *     hand a reason to, so it is said out loud -- with the "Show log" button every other message
   *     in this extension carries.
   *
   * Either way the panel STAYS OPEN. Its own static sentence (PREVIEW_DID_NOT_START) is still on
   * screen saying the same thing, and closing somebody's tab to make a point would take away the
   * evidence. */
  private reportWebviewNeverStarted(): void {
    if (this.webviewReady || this.disposed) return
    const detail =
      `The preview webview for ${this.document.uri.fsPath} did not report that its script was running ` +
      `within ${String(WEBVIEW_READY_TIMEOUT_MS)}ms. The panel is open; if it is blank, dist/webview.js did not load ` +
      '(an asset missing from the package, or a Content-Security-Policy that rejected it).'
    const reject = this.rejectFirstResult
    if (reject !== null) {
      this.settleFirstResult = null
      this.rejectFirstResult = null
      reject(
        new Error(
          `the preview panel's script did not start within ${String(WEBVIEW_READY_TIMEOUT_MS)}ms. ` +
            'The panel is open; if it is blank, its bundle did not load.',
        ),
      )
      log(detail)
      return
    }
    void warn(
      `Feature Lab: the preview of ${path.basename(this.document.fileName)} is open but its script never started, so it will stay blank.`,
      detail,
    )
  }

  private finishFirstResult(): void {
    const settle = this.settleFirstResult
    this.settleFirstResult = null
    this.rejectFirstResult = null
    settle?.()
  }

  /** The one place a failed run becomes words.
   *
   * WHO SAYS IT DEPENDS ON WHEN IT HAPPENED, and that is deliberate rather than a compromise.
   * The FIRST run has a command waiting on it, so the reason is handed back through
   * whenFirstResult and the command puts it in one notification -- two would be the same failure
   * reported twice. Every run after that has nobody waiting: a save fired it, and the only thing
   * on screen is a panel the user may not be looking at. Those are logged always, and raised as a
   * notification when the failure is about the ENGINE (it crashed, it timed out, it sent
   * something unreadable) rather than about the pack.
   *
   * The pack-level ones -- "no such feature", a placement the engine refused -- stay in the panel
   * and in the Problems view, where they already are. They are ordinary while somebody edits a
   * feature, they arrive on every keystroke-then-save, and a notification per save for a file
   * that is mid-edit is how people learn to ignore notifications. */
  /** What a preview the USER stopped leaves behind.
   *
   * Three things have to be true afterwards and none of them is the default. The spinner has to
   * stop -- a preview that looks like it is still working after Cancel is the exact complaint
   * this feature answers. Something has to be ON SCREEN saying what happened, because an empty
   * viewer is also what a broken panel looks like. And whatever was waiting on the first result
   * has to settle, or the command that opened this panel holds its notification forever.
   *
   * It does NOT go through reportFailure: nothing failed, so nothing writes "failed" to the log
   * and nothing raises a notification. The panel is left in a state the user can act on -- change
   * a control, save the file -- and the very next regenerate replaces all of this.
   */
  private handleCancelled(err: RequestCancelledError): void {
    log(`Preview of ${path.basename(this.document.fileName)} was cancelled at the user's request.`)
    this.post({ type: 'busy', busy: false })
    this.post({ type: 'stale', stale: true, reason: PREVIEW_CANCELLED })
    const pending = this.rejectFirstResult
    if (pending === null) return
    this.settleFirstResult = null
    this.rejectFirstResult = null
    pending(err)
  }

  private reportFailure(message: string): void {
    const pending = this.rejectFirstResult
    log(`Preview of ${path.basename(this.document.fileName)} failed: ${message}`)
    if (pending !== null) {
      this.settleFirstResult = null
      this.rejectFirstResult = null
      pending(new Error(message))
      return
    }
    if (this.engineLevelFailure) {
      this.engineLevelFailure = false
      void fail(`Feature Lab: the preview stopped updating -- ${message}`)
    }
  }

  /** Set by handleGenerateError just before it posts, for the failures that are about the engine
   * rather than about the pack. Read and cleared by reportFailure, which is the only thing that
   * decides whether a failure is worth interrupting somebody over. */
  private engineLevelFailure = false

  /** Feeds panel.ts's Budget section (PanelHandle.setTimeoutInfo) the before/after of the
   * request-timeout coupling this class's regenerate() computes -- see that method's own doc
   * comment. Posted on every regenerate() so the note tracks whichever params (and therefore
   * whichever placementTimeLimitMs) the CURRENT run actually used, not a stale one from an
   * earlier request. */
  private postTimeoutInfo(configuredMs: number, effectiveMs: number): void {
    this.post({ type: 'timeoutInfo', configuredMs, effectiveMs })
  }

  dispose(): void {
    this.panel.dispose()
  }
}

function extractDiagnostics(result: unknown): DiagnosticWireLike[] {
  if (typeof result !== 'object' || result === null) return []
  const diagnostics = (result as Record<string, unknown>).diagnostics
  if (!Array.isArray(diagnostics)) return []
  return diagnostics as DiagnosticWireLike[]
}

/** The generate response as the PANEL should see it: this run's diagnostics first, the pack's
 * standing ones folded into one expandable row behind them. See postResult for why this is the
 * one field that is not forwarded untouched, and packContents.ts's scopedForPreview for what the
 * fold actually does.
 *
 * A SHALLOW COPY, never a mutation: the caller keeps the engine's own object as `lastResult` and
 * hands it to other readers (reportBlockNotes, applyAttribution), and rewriting a field in place
 * would make what those see depend on whether the result had been posted yet. A response with no
 * diagnostics array at all -- an engine that predates the field, or something unparseable -- is
 * returned exactly as it arrived rather than gaining an empty one. */
export function withPreviewDiagnostics(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const diagnostics = (result as Record<string, unknown>).diagnostics
  if (!Array.isArray(diagnostics)) return result
  return { ...(result as Record<string, unknown>), diagnostics: scopedForPreview(diagnostics as DiagnosticWireLike[]) }
}
