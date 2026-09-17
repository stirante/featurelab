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
import * as path from 'node:path'
import * as vscode from 'vscode'
import { EngineCrashedError, MalformedResponseError, RequestTimeoutError, RpcError } from './engineProcess.js'
import { DocumentParseError, PackRootError, isEngineLoadedPackFile, parseDocumentIdentifier, resolvePackRoot } from './identifier.js'
import type { PreviewController } from './previewController.js'
import { updateDiagnostics, type DiagnosticWireLike } from './diagnostics.js'
import {
  AttributionIndex,
  createAttributionBridge,
  type AttributionBridge,
  type AttributionSelection,
  type CellBounds,
  type ProfileWire,
} from './graph/attribution.js'
import type { RunStatsWire } from './graphPanel.js'
import { TextureBuilder, notesForPalette, notesFromAtlas, type TextureStatusWire } from './textures.js'
import { ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS } from 'featurelab-frontend'
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

/** One "Feature Lab" output channel for the whole extension session, shared by every panel --
 * three previews open on three files should not mean three channels with the same name in the
 * Output dropdown. Created lazily; see PreviewPanel.textureOutput. */
let outputChannel: vscode.OutputChannel | undefined

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

interface WebviewToHostMessage {
  type: 'ready' | 'generate' | 'reloadFiles' | 'growRegenerate' | 'pickCell'
  params?: GenerateParamsWire
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
  generateGrown(packRoot: string, params: GenerateParamsWire, timeoutMs: number): Promise<unknown>
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

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
</style>
</head>
<body data-fl-workspace="${workspaceId}">
  <div id="fl-root">
    <canvas id="fl-canvas"></canvas>
    <div id="fl-attribution" role="status" aria-live="polite" hidden></div>
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

export class PreviewPanel {
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
  ) {
    this.document = document
    try {
      this.packRoot = resolvePackRoot(document.uri.fsPath)
    } catch (err) {
      this.packRoot = null
      this.packRootError = err instanceof PackRootError ? err.message : String(err)
    }

    this.panel = vscode.window.createWebviewPanel(
      'featurelab.preview',
      `Feature Lab: ${path.basename(document.fileName)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    )
    this.panel.webview.html = buildHtml(this.panel.webview, context.extensionUri)
    this.panel.onDidDispose(() => {
      this.disposed = true
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
        this.flushOutbox()
        void this.tryPostEnvironments()
        void this.ensureTextures()
        break
      case 'generate':
        if (message.params) {
          this.lastParams = message.params
          // An ordinary (non-grow) request -- see lastRequestWasGrow's own doc comment for why
          // this needs recording, not just used once here: it's what keeps a LATER save-
          // triggered regenerate honoring "sticky grow is currently off" too.
          this.lastRequestWasGrow = false
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
          this.pending = this.pending.then(() => this.growRegenerate())
        }
        break
      case 'reloadFiles':
        this.pending = this.pending.then(() => this.reloadFiles())
        break
      case 'pickCell':
        this.pickCell(message)
        break
      default:
        break
    }
  }

  private tryPostInit(): void {
    try {
      // kind matters here, not just identifier -- see parseDocumentIdentifier's own doc comment
      // for the bug this fixes: a rule file's identifier posted under a feature-only message
      // used to seed panel.ts's Feature picker, where it could only ever match nothing.
      const { kind, identifier } = parseDocumentIdentifier(this.document.getText())
      this.post({ type: 'init', kind, identifier })
    } catch {
      // Not previewable yet (e.g. mid-edit, invalid JSON) -- regenerate()'s own error path
      // already surfaces this; nothing more to seed the picker with.
    }
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
    } catch {
      // See this method's own doc comment -- not fatal, nothing to surface.
    }
  }

  /** The first run: get this machine to a state where the preview can draw real block
   * textures, then post the atlas to the webview.
   *
   * ON BY DEFAULT, which is a deliberate change and the whole point of the feature. What must
   * not depend on whether a machine happens to have an atlas is a COMMITTED IMAGE -- and the
   * images this repository commits are produced by docs/wiki/tools/, which drives the viewer
   * directly and pins textures off explicitly, and by scripts/capture-screenshots.mjs, which
   * never posts an atlas message at all. Neither goes through this class, so the guarantee
   * those images need is held where it belongs rather than by leaving the feature switched off
   * for everyone. featurelab.blockTextures = false turns it off for someone who wants flat
   * colours back, and is also what stops this ever asking anything.
   *
   * THE ASK HAPPENS EXACTLY ONCE, and only when a download is what is being asked for. A
   * machine with Mojang's assets already cached (or FEATURELAB_VANILLA_PACK pointing at a
   * checkout) is never interrupted: the question exists because of the network, and that path
   * has none. A "no" is recorded by the engine, next to the atlas directory, so neither this
   * extension nor the desktop app nor the CLI asks again.
   *
   * EVERY OTHER OUTCOME IS EXPLAINED, once per panel. "The preview draws flat colours" with
   * nothing said is indistinguishable from a broken feature, and offline or proxied machines
   * are a normal case here, not an edge one. */
  private async ensureTextures(): Promise<void> {
    const config = vscode.workspace.getConfiguration('featurelab')
    if (!config.get<boolean>('blockTextures', true)) return
    const timeoutMs = config.get<number>('requestTimeoutMs', 30_000)
    try {
      // The pack under test goes in: its own blocks are drawn from the same sheet vanilla's
      // are, and on a large pack they can be 40% of the distinct block names a preview places.
      const packRoot = this.packRoot ?? undefined
      let status = await this.textures.status(packRoot)
      if (this.disposed) return
      if (status.state === 'declined') return
      if (status.state === 'missing' || status.state === 'stale') {
        if (status.needsDownload && !(await this.offerTextureDownload(status))) return
        if (this.disposed) return
        status = (await this.buildTextures(packRoot, status.needsDownload)).status
        if (this.disposed) return
      }
      if (status.state !== 'ready') {
        this.explainNoTextures(status.detail)
        return
      }
      const atlas = await this.controller.loadAtlas(timeoutMs)
      if (this.disposed) return
      this.blockNotes = notesFromAtlas(atlas)
      this.post({ type: 'atlas', atlas })
      // The atlas usually arrives after the first result (the constructor fires a generate
      // immediately, and this path may have had a download in front of it), so the notes for
      // what is already on screen are reported here rather than waiting for the next run.
      this.reportBlockNotes(this.lastResult)
    } catch (err) {
      if (this.disposed) return
      const message = err instanceof Error ? err.message : String(err)
      this.explainNoTextures(`block textures could not be prepared -- ${message}`)
    }
  }

  /** Puts the question, with the engine's own notice as the body: what is fetched, from where,
   * how large it is, whose it is, where it lands, and how to avoid it entirely. Returns true
   * only for an explicit yes. "Never" records the decline so nothing asks again; dismissing the
   * message decides nothing and the question comes back with the next preview, which is the
   * right reading of a notification nobody answered. */
  private async offerTextureDownload(status: TextureStatusWire): Promise<boolean> {
    const answer = await vscode.window.showInformationMessage(
      'Feature Lab can draw real Minecraft block textures in the preview.',
      { modal: true, detail: status.notice ?? status.detail },
      'Download',
      'Never',
    )
    if (answer === 'Download') return true
    if (answer === 'Never') {
      await this.textures.decline()
      this.explainNoTextures('block textures were declined; the preview draws flat block colours. Run "featurelab textures -download" to change that.')
    }
    return false
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
          this.textureOutput().appendLine(
            `This pack defines ${String(result.pack.blocks)} block(s): ${String(result.pack.fully)} draw exactly as declared, ` +
              `${String(result.pack.shapeCube)} as a textured cube (their geometry is a resource-pack model), ` +
              `${String(result.pack.untextured)} with an unresolved texture.`,
          )
        }
        return result
      },
    )
  }

  /** Says, once per panel, why the preview is not textured. Never an error dialog: textures
   * are an enhancement and nothing here stops the tool working. */
  private explainNoTextures(detail: string): void {
    if (this.warnedAboutAtlas) return
    this.warnedAboutAtlas = true
    this.textureOutput().appendLine(detail)
    void vscode.window.showWarningMessage(`Feature Lab: ${detail}`)
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
   * the pack summary, the sentence behind a warning. Created on first use so a session that
   * never has anything to say never adds a channel to the user's Output dropdown. */
  private textureOutput(): vscode.OutputChannel {
    outputChannel ??= vscode.window.createOutputChannel('Feature Lab')
    return outputChannel
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
    if (this.packRootError !== null || this.packRoot === null) {
      this.postError(`cannot preview this file: ${this.packRootError}`)
      return
    }
    const packRoot = this.packRoot
    const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
    this.postBusy()
    try {
      await (savedFile === undefined
        ? this.controller.reloadPack(packRoot, timeoutMs)
        : this.controller.reloadPackFile(packRoot, savedFile, timeoutMs))
      if (this.disposed) return
      await this.regenerate()
    } catch (err) {
      if (this.disposed) return
      this.handleGenerateError(err)
    }
  }

  get documentUri(): vscode.Uri {
    return this.document.uri
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
    this.pending = this.pending.then(() => this.regenerate())
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
    const invalidatesPack =
      isOwnDocument || (this.packRoot !== null && isEngineLoadedPackFile(this.packRoot, document.uri.fsPath))
    if (!invalidatesPack) return
    // The saved document's own path goes down with the reload: this method is the ONE place
    // that knows which file changed, and throwing that away here is what used to make every
    // save pay a full re-read of the pack to rediscover it. See reloadFiles's own comment for
    // why the button next door deliberately does not pass it.
    this.pending = this.pending.then(() => this.reloadFiles(document.uri.fsPath))
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
    let requested: GenerateParamsWire
    if (this.lastParams) {
      requested = this.lastParams
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
      requested = parsed.kind === 'rule' ? { rule: parsed.identifier, env: envId } : { feature: parsed.identifier, env: envId }
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
    try {
      // useGrown always re-runs generateGrown() with THIS call's own current `params` -- the
      // engine itself refits the grow bounds fresh from THIS run's own overflow every time
      // (wire.RunGenerateGrown's own doc comment: two ordinary generate calls, the second only
      // when the first actually captured overflow) rather than reusing a size computed by an
      // earlier grow. That is what satisfies "refit on every run, never freeze the bounds from
      // the first grow" for panel.ts's sticky toggle with no extra bookkeeping needed here.
      const result = useGrown ? await (this.controller as unknown as GrowCapablePreviewController).generateGrown(packRoot, params, timeoutMs) : await this.controller.generate(packRoot, params, timeoutMs)
      if (this.disposed) return
      this.postResult(result)
      this.lastResult = result
      this.reportBlockNotes(result)
      // AFTER the result is posted, never before: the webview's viewer has to be holding this
      // run's own volume before a mask indexed against it can mean anything, and the two
      // messages are delivered in the order they are sent.
      this.applyAttribution(result)
      this.reportRunStats(result, params)
      const wireDiagnostics = extractDiagnostics(result)
      // Both ids, because the engine fills fileId with the basename for build-time diagnostics
      // and with the requested identifier for placement-time ones -- see updateDiagnostics's own
      // doc comment. `params` is what we actually asked for, so its feature/rule id is exactly
      // the identifier the engine will report as the placement root.
      const requestedId = params.feature ?? params.rule ?? ''
      updateDiagnostics(this.diagnosticCollection, this.document, [path.basename(this.document.fileName), requestedId], wireDiagnostics)
    } catch (err) {
      if (this.disposed) return
      this.handleGenerateError(err)
    }
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
    if (this.attributionNodeId === null || this.packRoot === null) return
    const report = this.graphLink.onRunStats
    if (report === undefined) return
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
      this.post({
        type: 'attribution',
        available: true,
        nodeId: selection.nodeId,
        // Array.from over a SUBARRAY, not over the whole view: this is what crosses the wire.
        cells: Array.from(selection.cells.subarray(0, shown)),
        cellCount: total,
        shown,
        writes: selection.writes,
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
    if (err instanceof EngineCrashedError) {
      this.postStale(true, `The featurelab engine process crashed: ${err.message}`)
      return
    }
    if (err instanceof MalformedResponseError) {
      this.postStale(true, `The featurelab engine sent an unreadable response: ${err.message}`)
      return
    }
    if (err instanceof RequestTimeoutError) {
      this.postStale(true, err.message)
      return
    }
    if (err instanceof RpcError) {
      this.postError(err.message)
      return
    }
    this.postError(err instanceof Error ? err.message : String(err))
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

  private postResult(result: unknown): void {
    this.post({ type: 'result', result })
  }

  private postError(message: string): void {
    this.post({ type: 'error', message })
  }

  private postStale(stale: boolean, reason?: string): void {
    this.post({ type: 'stale', stale, reason })
  }

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
