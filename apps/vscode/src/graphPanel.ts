// graphPanel.ts -- one webview panel per pack, showing that pack's feature graph as a node
// editor. Sibling of previewPanel.ts and deliberately built the same way: the shell HTML is a
// pure function so a test harness and the screenshot capture script serve the byte-identical
// document, CSP included, that the real extension does.
//
// That is not symmetry for its own sake. previewPanel.ts's header records what hand-copied
// shell HTML cost: several rounds of "verified by screenshot" over a document that had no CSP
// at all, while the real one was silently dropping an inline <style> block and collapsing the
// layout. A second panel that re-derived its own HTML would re-open exactly that hole.
//
// The host side owns talking to the engine and reading and writing files. The webview side
// (webview/graph.ts) owns the canvas, the forms and the camera, and holds no authority over
// anything on disk -- it asks, and this class decides.

import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { graphDiagnostics, type AnnotateOp, type GraphDiagnostic, type PreviewController } from './previewController.js'
import { RequestCancelledError } from './engineProcess.js'
import { ChangeJournal, snapshot, UndoRefused, type FileBytes, type JournalEntry } from './changeJournal.js'
import { loadLayout, readSidecar, withPosition, writeSidecar } from './graph/layoutSidecar.js'
import { GRAPH_NODE_WIDTH, GRAPH_NODE_HEIGHT } from './graph/render.js'
// The stand-in this editor writes wherever it has to name a feature and does not know one yet.
// It is the host that writes it, not the webview: the webview says WHICH delegations cannot be
// removed, and what they are pointed at is not a value it gets to name.
import { PLACEHOLDER_FEATURE } from './graph/compounds/spec.js'
import { brokenFiles, describeBrokenFiles, describePackContents, diagnosticLocation } from './packContents.js'
import type { EmptyStatePackContents } from './graph/emptyState.js'
import type { LayoutGraph } from './graph/layout.js'
import { describeError, log } from './log.js'

/** What the first graph turned out to contain -- the answer GraphPanel.whenFirstGraph gives the
 * command that opened the panel, so the command can log what it drew instead of assuming it drew
 * anything. */
export interface GraphSummary {
  readonly packRoot: string
  readonly nodes: number
  readonly diagnostics: number
  /** How many files of this pack the engine REFUSED -- distinct from `diagnostics`, which counts
   * every message including warnings about files that loaded fine. It is the number the user
   * cares about ("something of mine is missing from this picture") and the one the command that
   * opened the panel turns into a notification. */
  readonly brokenFiles: number
}

/** What the canvas says before the panel's own script has run a single line.
 *
 * SHIPPED IN THE STATIC HTML, and the only message here that is. Every other sentence this panel
 * shows is written by webview/graph.ts, which cannot say anything at all in the one case this
 * covers: the script did not load. A stylesheet or script excluded from the VSIX, a
 * Content-Security-Policy that rejects the bundle, a corrupted install -- all of them produce a
 * panel that opens, occupies a tab, and is a blank grey rectangle forever, with nothing anywhere
 * to distinguish it from an editor that is merely slow.
 *
 * graph.ts replaces it with its own "loading" line as its first act, so this text being on
 * screen is itself the diagnosis. Plain text, no interpolation: it is a constant.
 *
 * Deliberately NOT hidden by default. Hidden-by-default is what made the blank panel possible in
 * the first place. */
const WEBVIEW_DID_NOT_START =
  'Starting the feature graph&hellip; If this message stays here, this panel&#39;s script did not load &mdash; ' +
  'run &quot;Feature Lab: Show Log&quot; for the reason.'

/** How long to wait for the webview to report that its script is running, before telling the
 * command that opened this panel that it never will.
 *
 * Without it, a panel whose bundle does not load leaves the command's progress notification
 * spinning forever: the webview posts no `ready`, so nothing ever asks for a graph, so the first
 * graph never arrives. Generous, because the webview also has to lay out its own shell on a
 * machine that may be doing several other things -- this is a backstop for a panel that is never
 * coming, not a performance budget. */
const WEBVIEW_READY_TIMEOUT_MS = 15_000

/** The only affirmative button on the delete dialog. One spelling, in one place, because it is
 * also the string the tests press. */
export const DELETE_CONFIRM = 'Delete'

/** The question a delete asks, EVERY time.
 *
 * Every time, and not only when something still refers to the feature, which is what it used to
 * be: a delete removes a file from disk and rewrites others, the panel offers no undo for it (see
 * changeJournal.ts's recordBarrier), and "nothing referred to it" is a statement about the graph
 * rather than about how much work the file was.
 *
 * The files are NAMED. A dialog that says "this cannot be undone" without saying what it is about
 * to write asks the author to confirm something they cannot check. */
export function deleteConfirmation(
  id: string,
  files: readonly string[],
  detachReferences: boolean,
  group?: string,
): { message: string; detail: string } {
  const list = files.length > 0 ? files.join(', ') : 'no file this panel can name'
  const also = detachReferences
    ? ' Every other file that refers to it is rewritten to stop doing so; this panel cannot list those in advance.'
    : ''
  // THE GROUP IS PART OF WHAT IS BEING DESTROYED. A group is a statement the author wrote into
  // these very files, and a delete silently takes a clause out of it: the group simply reads
  // "Members (1)" afterwards, with no undo and nothing having said so. Named here because this is
  // the last moment anybody can say no.
  const inGroup = group !== undefined && group.length > 0 ? ` This feature is in "${group}", and deleting it takes it out of that group.` : ''
  return {
    message: `Delete ${id}?`,
    detail:
      `This writes ${String(files.length)} file(s) in this pack: ${list}.${also}${inGroup} ` +
      'Deleting a feature cannot be undone from Feature Lab -- recover it from version control or from a backup.',
  }
}

/** What a pack root with no `features/` directory earns, as a pack-load warning.
 *
 * THE POINT IS THAT IT IS NOT "no features yet". A directory that is not there and a directory
 * that is empty both produce a pack with zero features, and the panel used to say the same
 * encouraging sentence about both -- "this pack declares no features yet. Right-click to create
 * one" -- to somebody who had simply opened the wrong folder. Those are different problems and
 * only one of them is fixed by right-clicking.
 *
 * A warning, not a refusal: a pack somebody is about to put a features/ directory into is real,
 * and refusing to draw it would take away the view that explains itself. Null when the directory
 * is there, which is the ordinary answer. */
export function missingFeaturesDirectoryWarning(packRoot: string): string | null {
  const dir = path.join(packRoot, 'features')
  try {
    if (fs.statSync(dir).isDirectory()) return null
  } catch {
    // Not there, or not readable -- both are the case below.
  }
  return (
    `There is no "features" directory under ${packRoot}, so no feature could be read from this pack. ` +
    'If you expected features here, the path is probably not the pack you meant.'
  )
}

/** Everything the shell needs, as opaque strings -- see renderGraphShellHtml. */
export interface GraphShellParams {
  nonce: string
  cspSource: string
  scriptUri: string
  /** The graph stylesheet, apps/vscode/media/graph.css. */
  styleUri: string
  /** Shown in the header so a window with two packs open is not a guessing game. */
  packLabel?: string
}

/**
 * Renders the graph webview's shell.
 *
 * A pure function of its inputs, with no dependency on a live `vscode.Webview` or `vscode.Uri`,
 * so tests and `scripts/capture-screenshots.mjs` obtain the same HTML the extension serves --
 * including the real Content-Security-Policy, which is the part that has historically differed
 * between what was tested and what shipped.
 *
 * The CSP repeats previewPanel.ts's shape for the same reasons, and the nonce on the inline
 * <style> is load-bearing rather than decorative: a stylesheet's origin permission does NOT
 * also cover inline style text, and without its own nonce the whole block is dropped in real
 * VS Code with no error anywhere.
 */
export function renderGraphShellHtml(params: GraphShellParams): string {
  const { nonce, cspSource, scriptUri, styleUri } = params
  const packLabel = params.packLabel ?? ''
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
  #flg-root { display: flex; flex-direction: column; height: 100%; width: 100%; }
  #flg-body { display: flex; flex: 1 1 auto; min-height: 0; }
  #flg-canvas { flex: 1 1 auto; min-width: 0; position: relative; overflow: hidden; }
  #flg-side { flex: 0 0 320px; min-width: 0; overflow-y: auto; }
  /* The search box is a block with its own internal layout -- input, notes, results, footer --
     dropped into a flex toolbar. Left alone it spans the row, pushes every button onto a second
     line, and grows the toolbar downwards over the canvas as results arrive.
     The slot keeps its place in the row; the box floats out of flow and stacks downward over the
     canvas from there. Positioning the parts individually does not work: they are four siblings
     with no wrapper, so each would land on top of the last. */
  #flg-toolbar { position: relative; }
  #flg-search { flex: 0 1 280px; min-width: 120px; position: relative; align-self: stretch; }
  #flg-search > * { position: absolute; top: 0; left: 0; right: 0; z-index: 20; }
  #flg-search .fls-list { max-height: 60vh; overflow-y: auto; }
  /* What the canvas says when there is nothing on it.
     An empty canvas and a broken editor look exactly alike, which is most of what "I could not
     get the node editor to open" turned out to mean. So a graph with no nodes, and a pack that
     could not be read at all, both leave a sentence in the middle of the canvas rather than a
     void -- pointer-events:none so it never gets in the way of the right-click that creates the
     first node. Its text is set by webview/graph.ts; it is [hidden] the rest of the time. */
  #flg-empty[hidden] { display: none; }
  #flg-empty {
    position: absolute; inset: 0; z-index: 4; pointer-events: none;
    display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 0 48px; box-sizing: border-box;
    font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.6;
    color: var(--vscode-descriptionForeground);
  }
  #flg-empty > span { max-width: 44em; }
  /* What the canvas says when there IS something on it and something else is nonetheless wrong.
     Three findings share this strip, and they share it because they share a shape: the canvas
     draws confidently, the status line agrees with it, and the thing that would change the
     reader's mind is not on the screen at all. A group that a comment-blind formatter deleted
     out of every file; a saved selection that no longer names anything, whose camera was
     restored over a hole anyway; a pack whose whole features/ directory has moved, drawing 3
     cards of 57 under "Showing the whole graph."
     It is over the canvas rather than in the sidebar because the sidebar is the INSPECTOR the
     moment anything is selected, and each of these is read by somebody looking at the drawing.
     pointer-events is none on the strip and auto on its rows, so the canvas under it still pans,
     marquees and right-clicks everywhere the words are not. */
  #flg-banner[hidden] { display: none; }
  #flg-banner {
    position: absolute; top: 0; left: 0; right: 0; z-index: 6; pointer-events: none;
    display: flex; flex-direction: column; gap: 4px;
    padding: 6px 8px; box-sizing: border-box;
    font-family: var(--vscode-font-family); font-size: 12px; line-height: 1.5;
  }
  #flg-banner > * { pointer-events: auto; max-width: 62em; }
</style>
</head>
<body data-fl-pack="${escapeAttribute(packLabel)}">
  <div id="flg-root">
    <div id="flg-toolbar" role="toolbar" aria-label="Graph"></div>
    <div id="flg-body">
      <div id="flg-canvas"><div id="flg-empty" role="status" aria-live="polite">${WEBVIEW_DID_NOT_START}</div><div id="flg-banner" role="status" aria-live="polite" hidden></div></div>
      <div id="flg-side"></div>
    </div>
    <div id="flg-status" role="status" aria-live="polite"></div>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`
}

/** Escapes a value going into a double-quoted HTML attribute. A pack label is a filesystem path
 * and can legitimately contain a quote on every platform this runs on, so it cannot be
 * interpolated raw -- and `&` has to go first or it would double-escape the entities below. */
export function escapeAttribute(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('"').join('&quot;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
}

/** A cryptographically random nonce, fresh per load. Mirrors previewPanel.ts's own. */
function getNonce(): string {
  const bytes = new Uint8Array(16)
  ;(globalThis.crypto as Crypto).getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Messages the webview sends here. Anything else is ignored rather than trusted: the webview
 * is the least privileged half of this pair and must not be able to name an arbitrary path. */
export type GraphHostMessage =
  | { type: 'ready' }
  | { type: 'requestGraph' }
  // Re-runs the load the panel is showing a failure for. The host's half of the Retry button:
  // a panel whose first load failed used to be dead until the window was reloaded.
  | { type: 'retry' }
  // The panel's own history, for a toolbar button. The same thing the keybinding and the two
  // commands reach -- see GraphPanel.undoLastChange.
  | { type: 'undo' }
  | { type: 'redo' }
  // "Leave that step out of the history": the answer to an undo this journal will never perform,
  // asked for by the author after the refusal has been put in front of them. Writes nothing. See
  // GraphPanel.forgetLastChange.
  | { type: 'forgetUndo' }
  | { type: 'openFile'; nodeId?: string; file?: string }
  // `file` is NOT an arbitrary path. See GraphPanel.diagnosticFiles: the host only honours a
  // path it has itself just reported as belonging to a file in this pack, which keeps the rule
  // above -- the webview names things, the host resolves them -- intact for a file that has no
  // node to be named by.
  // `label` is one line in the AUTHOR'S words -- "gaussian: extent 1" -- and is what the undo
  // command says it is about. Optional on every mutating message, because several webview modules
  // already produce one (InspectorChange.label, LifecyclePlan.title, ConnectPlan.summary) and
  // several do not yet; the host writes a plainer one from the operation itself when it is absent,
  // so a missing label costs a nice sentence and never costs the undo entry.
  | { type: 'applyEdits'; file: string; edits: readonly { path: string; json: string | null }[]; label?: string }
  // Records a `@featurelab:` directive in `file`'s comments. A sibling of applyEdits and not a
  // case of it: a directive lives in a comment, is placed from the path rather than at it, and is
  // rewritten in place when one of that name is already there. `path` names what the directive is
  // about, and is subject to the same rule as every other path the webview sends -- the engine
  // resolves it inside the loaded pack and refuses anything that escapes.
  | { type: 'annotate'; file: string; path: string; name: string; args?: readonly string[]; label?: string }
  // Several directives across several files as ONE change -- what a feature group is, since
  // every member's file carries the group's name and state. Each op names its file under the
  // same rule as `annotate`; the engine validates the whole batch before writing any of it.
  | { type: 'annotateBatch'; ops: readonly AnnotateOp[]; label?: string }
  | {
      type: 'create'
      files: readonly { path: string; contents: string }[]
      select?: string
      position?: { x: number; y: number }
      label?: string
    }
  | { type: 'moveNode'; nodeId: string; x: number; y: number }
  // The author turned "Preview on select" on or off. The host does not act on it -- selecting a
  // node still previews or does not entirely inside the webview -- it REMEMBERS it, so the next
  // panel opens the way this one was left. See previewOnSelectKey.
  | { type: 'previewOnSelect'; value: boolean }
  // The author's keyboard entered or left something they can type into. NOT acted on in this
  // panel: what it changes is a context key in the WORKBENCH, `featurelab.graphTyping`, which is
  // the only thing package.json's `when` clauses can see -- a webview is opaque to them, so
  // "a textarea inside that iframe has focus" has to be said out loud. It is what stops Ctrl+Z
  // in a Molang field reverting the last write to the pack. See onGraphTypingChanged.
  | { type: 'typingFocus'; typing: boolean }
  // The webview's own view state, opaque to this host -- see graphViewStateKey. Sent by the
  // webview whenever it decides something worth keeping changed; the webview is expected to
  // debounce, because this crosses the wire and then goes to disk.
  | { type: 'persistState'; state?: unknown }
  // `attribute` is the node the AUTHOR selected; `nodeId` is what should actually be previewed,
  // which is usually the feature RULE above it (see webview/graph.ts's previewFor -- a feature
  // alone previews as one object, the rule previews the thing being built). They are different
  // ids on purpose: the run to make is the rule's, and the blocks to highlight are the selected
  // node's own. Absent for a webview that predates this, in which case the previewed node is
  // also the attributed one, which is what it always was.
  | { type: 'previewNode'; nodeId: string; attribute?: string }
  | { type: 'renameFeature'; from: string; to: string }
  // `retarget` names the delegations that are to be pointed at the placeholder BEFORE the delete
  // -- the ones whose file cannot load without them, which the engine's own deleteFeature refuses
  // over. By NODE, never by path: the node->file table below is the only thing that turns a name
  // from the webview into a file, and this message is not the place to start making an exception.
  | {
      type: 'deleteFeature'
      id: string
      detachReferences: boolean
      retarget?: readonly { nodeId: string; path: string }[]
      // Every file the webview's own plan says will be written, for the confirmation to name.
      // DISPLAY ONLY, and filtered against the node->file table before a word of it is shown: a
      // path this host has never reported is not one it will repeat back to the author as fact.
      files?: readonly string[]
      /** The name of the author-declared group this feature is in, as the panel last read it.
       * DISPLAY ONLY and not checked, because there is nothing to check it against: a group lives
       * in the pack files' comments and the host does not parse them. It is in the message because
       * a delete destroys the membership as surely as the file, and the confirmation is the last
       * place anybody can be told so. */
      group?: string
      /** The panel has already put this delete to the author and been told to go ahead, so the
       * modal below stands down. See confirmDelete for the two cases that set it and why the
       * alternative is worse. Absent means "nobody has asked yet", which is the ordinary case. */
      confirmed?: boolean
    }
  | {
      type: 'regenerate'
      owner: string
      files: readonly { path: string; contents: string }[]
      remove: readonly string[]
      label?: string
    }

/** One run's profile, on its way from the preview that made it to the graph that draws it.
 *
 * The RAW rows, not rows this host has already turned into per-node verdicts. graph/nodeStats.ts
 * is headless on purpose and runs equally well in the webview, and the webview is where the
 * phrasing, the card and the inspector all are -- so shipping it a profile and letting it ask
 * nodeStats its own questions keeps one module answering them, instead of a host that pre-chews
 * half the answers and a webview that improvises the other half.
 *
 * It is small: one row per feature ENTERED, which is tens to low hundreds even on a large pack.
 * The per-cell arrays are NOT here; `profile.attribution` and `profile.touchCounts` stay on the
 * host, where the preview panel already indexes them.
 *
 * Every field is about ONE RUN AT ONE ORIGIN, which is why `origin` and `partial` travel with
 * the numbers rather than being left for the reader to assume. */
export interface RunStatsWire {
  /** profiler.ProfileResult's own rows, verbatim. Null when the run carried no profile -- which
   * is the ordinary state, and which clears whatever the graph was showing. */
  readonly profile: { readonly featureIdentifiers?: readonly string[]; readonly features?: readonly unknown[] } | null
  /** The feature or rule the run placed. Named so the graph can say whose run these numbers are
   * rather than presenting them as a property of the pack. */
  readonly previewed: string
  /** GenerateOutput.origin -- the position this run actually placed at. A feature gated on chunk
   * position runs at one origin and not another, so "did not run" is only ever true of an origin. */
  readonly origin: { readonly x: number; readonly y: number; readonly z: number } | null
  /** GenerateParams.writeBudget, when the request set one. */
  readonly writeBudget: number | null
  /** GenerateOutput.partial: a budget cut the run off, so every count is a floor. */
  readonly partial: boolean
}

/** The fallback undo label for a field edit whose webview did not send one.
 *
 * Plainer than "gaussian: extent 1" on purpose: this is a description of the WRITE, because the
 * intention behind it is exactly what is missing. Several webview modules already produce the good
 * sentence (InspectorChange.label and its siblings); until every one of them forwards it, a plain
 * label is the difference between an undo entry and no undo entry. */
export function editLabel(file: string, edits: readonly { path: string }[]): string {
  const first = edits[0]?.path ?? ''
  const field = first.split('.').filter((s) => s.length > 0).pop() ?? ''
  const where = field === '' ? '' : ` (${field})`
  return edits.length > 1 ? `Edit ${file}${where} and ${String(edits.length - 1)} more` : `Edit ${file}${where}`
}

/** Told whenever the number of open graph panels changes. extension.ts uses it to keep the
 * `featurelab.graphOpen` context key -- and therefore the palette -- honest, without this file
 * having to know that context keys exist. */
let openCountListener: ((count: number) => void) | null = null

export function onGraphPanelCountChanged(listener: ((count: number) => void) | null): void {
  openCountListener = listener
}

/** Told whenever "the author is typing into a text control in a graph panel" changes.
 *
 * extension.ts turns it into the `featurelab.graphTyping` context key, which package.json's
 * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y bindings are negated against. WHY IT HAS TO EXIST: VS Code's
 * webview shim treats undo and redo as keys the HOST owns -- it calls preventDefault on them and
 * forwards the keydown to the workbench -- so Ctrl+Z pressed in a rename box or a Molang field
 * ran `featurelab.undo` and reverted the last write to the pack instead of undoing the typing.
 * A `when` clause cannot work that out for itself, so the panel says so.
 *
 * The failure mode this is written around is a key left STUCK ON: `graphTyping: true` with
 * nothing to clear it disables undo everywhere, which is worse than the bug. Every way out of a
 * text box therefore clears it -- the webview's own focusout, the panel ceasing to be the active
 * one, a webview that has just (re)started, the panel being disposed, and deactivate. */
let typingListener: ((typing: boolean) => void) | null = null

export function onGraphTypingChanged(listener: ((typing: boolean) => void) | null): void {
  typingListener = listener
}

/** Where a graph panel remembers the few things that must outlive it.
 *
 * A `vscode.Memento` -- extension.ts hands over `context.workspaceState` at activation -- rather
 * than a constructor argument, for the same reason openCountListener above is a module-level
 * setter: GraphPanel.show is called positionally from several tests and from one command, and
 * threading a store through all of them to reach two `get` calls would be a worse trade than one
 * injection point next to the one that is already here.
 *
 * Null until extension.ts sets it, and null in a test that does not care -- every read below
 * falls back to the same default the panel had before any of this existed, so an unset store
 * costs the remembering and nothing else. */
let panelState: vscode.Memento | null = null

export function setGraphPanelState(store: vscode.Memento | null): void {
  panelState = store
}

/** Where "Preview on select" is remembered, PER PACK.
 *
 * Per pack and not per window: the toggle says something about how somebody works on one pack,
 * and a window with two packs open is exactly the case where one answer for both would be wrong.
 * Exported so the tests name the same key this file writes. */
export function previewOnSelectKey(packRoot: string): string {
  return `featurelab.graph.previewOnSelect:${packRoot}`
}

/** Where the WEBVIEW's own view state is kept between one panel and the next -- the camera, the
 * selection, the search query, which compounds are expanded, the legend and minimap.
 *
 * The host does not read a byte of it. It is an opaque blob the webview hands over
 * (`persistState`) and is handed back (`restoreState`), which is the only arrangement that lets
 * the side that knows what a camera is be the side that decides what is worth keeping. */
export function graphViewStateKey(packRoot: string): string {
  return `featurelab.graph.viewState:${packRoot}`
}

/** The graph's view state minus its `search` field -- the one key in that otherwise opaque blob
 * this host declines to carry.
 *
 * A SEARCH IS A QUESTION, NOT A SETTING. The camera, the selection, which compounds are expanded:
 * those describe where somebody was, and putting them back is the whole reason the blob exists.
 * A filter query is the opposite -- it is a thing you type, read the answer to, and are done
 * with. Restored, it comes back as a pack with most of its cards missing and a filter nobody
 * remembers typing, which reads as "half my features failed to load" rather than as a search:
 * measured as `search: 'pumpkin'` surviving a window reload and hiding 44 of 57 cards, in a panel
 * whose author had closed it days earlier. Every other way of hiding a node in this editor is
 * visible in the UI that hid it; this one arrived silently on open.
 *
 * ONE KEY, NAMED, and everything else passed through untouched -- this host still does not read
 * the blob, and a field the webview adds tomorrow still needs no change here. Non-objects
 * (including null, which is what "nothing saved" looks like) go straight through. */
function withoutSearch(state: unknown): unknown {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return state
  if (!('search' in state)) return state
  const { search: _search, ...rest } = state as Record<string, unknown>
  return rest
}

export class GraphPanel {
  /** The webview panel's view type, which is also what `activeWebviewPanelId` equals while the
   * graph has focus -- the `when` clause package.json's Ctrl+Z binding is written against. Exported
   * so the manifest and this file cannot drift apart silently. */
  static readonly VIEW_TYPE = 'featurelab.graph'
  private static readonly viewType = GraphPanel.VIEW_TYPE
  /** One panel per pack root. Opening the graph for a pack that already has one reveals it
   * rather than stacking a second copy of the same thing. */
  private static readonly open = new Map<string, GraphPanel>()

  private readonly disposables: vscode.Disposable[] = []
  /** Host->webview messages held until the webview's script has registered its listener. A
   * message posted before then is silently dropped by VS Code, which previewPanel.ts learned
   * the same way. */
  private pending: unknown[] = []
  private ready = false
  /** Where a just-created node was dropped, until the graph that contains it arrives. */
  private readonly pendingPositions = new Map<string, { x: number; y: number }>()
  /** Node id to pack-relative file, from the last graph. The webview names a node; only the
   * host turns that into a path, so a message from the webview can never name a file. */
  private readonly filesByNode = new Map<string, string>()
  /** Pack-relative paths the host reported diagnostics for, from the last graph, each mapped to
   * WHERE in that file the problem is when the engine knew.
   *
   * The webview may ask to open one of these by path. That is the only path it may name, and
   * the allow-list is what keeps `openFile` from becoming "open anything you like": a refused
   * file has no node, so `filesByNode` cannot vouch for it, and without this the alternative
   * was to trust a string from the least privileged half of the pair.
   *
   * A Map rather than a Set so the SAME lookup that authorises the path also answers where to put
   * the cursor -- the engine sends a 1-based line/column for anything the JSON loader placed, and
   * opening `features/x.json` at the top when the host already knows the problem is at 4:57 is a
   * fact thrown away between two lines of code. Null for a file with no single place to point at.
   * First diagnostic wins: a file can raise several and the first is where reading stopped. */
  private diagnosticFiles = new Map<string, { line: number; column: number } | null>()

  /** Every file write this panel has caused, newest last -- see changeJournal.ts.
   *
   * Per panel, because the entries are about one pack and a panel is how a pack is open. It is
   * dropped with the panel: a history kept across a close would offer to revert a file the author
   * has since been editing by hand for an hour, which is not an undo anybody asked for. */
  private readonly journal = new ChangeJournal({
    // The one thing the journal is allowed to ask about the editor. A buffer with unsaved changes
    // is newer than the disk, so restoring bytes underneath it would be overwritten by the next
    // save -- and what would be lost is the author's typing, not this panel's edit.
    isDirty: (file: string) =>
      vscode.workspace.textDocuments?.some((d) => d.uri.fsPath === file && d.isDirty) ?? false,
  })

  /** The panel a command with no argument means.
   *
   * A webview panel does not tell an extension that it is the focused one in any way a command
   * body can query, so this is tracked from onDidChangeViewState and falls back to the most
   * recently opened panel. With one graph open -- overwhelmingly the common case -- both answers
   * are the same panel. */
  private static lastActive: GraphPanel | null = null

  /** Settles the first time a graph arrives, or the first time one cannot be built.
   *
   * The command that opened this panel awaits it, which is what lets "Feature Lab: Open Feature
   * Graph" hold its progress notification up until there is something on the canvas, and report
   * a failure as a notification rather than as small text at the bottom of a panel the user is
   * not looking at yet. A panel that is closed before the first graph arrives settles too --
   * otherwise the command would hold a progress notification open forever over a panel that no
   * longer exists. */
  private settleFirstGraph: ((summary: GraphSummary) => void) | null = null
  private rejectFirstGraph: ((err: Error) => void) | null = null
  private readonly firstGraph: Promise<GraphSummary>
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  /** Cancels the graph request currently in flight, if there is one. Owned by the panel rather
   * than passed in because the request is not started by whoever wants to cancel it: the WEBVIEW
   * asks for the graph (a `requestGraph` message), while Cancel is pressed on the command's
   * notification. The panel is the only thing that sees both. */
  private inflightGraph: AbortController | null = null

  /** Every open panel, so a save anywhere in a pack can reach the one showing it. */
  static openPanels(): readonly GraphPanel[] {
    return [...GraphPanel.open.values()]
  }

  /** The panel the Undo/Redo/Retry commands act on, or null when no graph is open.
   *
   * Null is an answer the commands phrase rather than a state they crash on: those commands are
   * visible in the palette only while `featurelab.graphOpen` is set (see extension.ts), and a
   * palette context key is a hint, not a lock -- a keybinding or a task can still run them. */
  static activePanel(): GraphPanel | null {
    const active = GraphPanel.lastActive
    if (active !== null && GraphPanel.open.get(active.packRoot) === active) return active
    const all = [...GraphPanel.open.values()]
    return all[all.length - 1] ?? null
  }

  /** How many graph panels are open. What extension.ts turns into the `featurelab.graphOpen`
   * context key, so the history commands appear in the palette exactly when they can work. */
  static openCount(): number {
    return GraphPanel.open.size
  }

  /** Whether the author's keyboard is in a text control in THIS panel -- see onGraphTypingChanged.
   * Private to the class rather than the instance because the context key is one key for the
   * window, so the answer is taken across every open panel. */
  private typing = false

  private setTyping(typing: boolean): void {
    if (this.typing === typing) return
    this.typing = typing
    GraphPanel.publishTyping()
  }

  /** Pushes "is anybody typing in a graph panel" out to whoever owns the context key.
   *
   * Across ALL open panels and not just this one, because two graphs can be open at once and the
   * key is global; a panel that is not the active one has already cleared its own flag (see the
   * onDidChangeViewState handler), so in practice this is the active panel's answer. */
  private static publishTyping(): void {
    let typing = false
    for (const open of GraphPanel.open.values()) {
      if (open.typing) {
        typing = true
        break
      }
    }
    typingListener?.(typing)
  }

  /** Whether this panel is showing the pack `filePath` belongs to. Compared on the resolved
   * path rather than on the string, because the same pack reaches here spelled several ways --
   * a workspace folder, a symlink, and on Windows in either case. */
  showsFile(filePath: string): boolean {
    const rel = path.relative(this.packRoot, filePath)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  /** Whether this panel is showing the pack rooted at `packRoot` -- compared on the resolved
   * path, like showsFile above, because the same pack reaches here spelled several ways.
   *
   * Separate from showsFile and not a special case of it: showsFile asks "is this file INSIDE my
   * pack", and deliberately answers false for the pack root itself (an empty relative path), so
   * routing a pack root through it would silently find nothing. */
  showsPack(packRoot: string): boolean {
    return path.relative(this.packRoot, packRoot) === ''
  }

  static show(
    extensionUri: vscode.Uri,
    controller: PreviewController,
    packRoot: string,
    timeoutMs: number,
    onPreviewFile: (document: vscode.TextDocument, attributeNodeId: string) => void,
    onPackFileWritten: (absPath: string) => void,
  ): GraphPanel {
    const existing = GraphPanel.open.get(packRoot)
    if (existing) {
      // WHERE IT IS, and the column is deliberately not named -- the same rule PreviewPanel.reveal
      // records, for the same reason. `reveal(ViewColumn.Active)` does not mean "show it": it means
      // "move it into whichever group has focus", so running the command again from the editor
      // dragged an already-open graph on top of whatever was there -- routinely the preview, since
      // that is what somebody has open beside a graph. Someone who has placed this panel has said
      // where they want it more clearly than any default can.
      existing.panel.reveal(undefined)
      GraphPanel.lastActive = existing
      return existing
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Feature Graph',
      // Beside, not Active: Active is the group the EDITOR is in, so opening the graph replaced
      // the file the author ran the command from.
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // media/ carries graph.css. Without it here the <link> resolves to a URI the webview
        // is not permitted to load, and the page renders unstyled with no error shown.
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media'),
        ],
      },
    )
    return GraphPanel.adopt(panel, extensionUri, controller, packRoot, timeoutMs, onPreviewFile, onPackFileWritten)
  }

  /** Takes over a panel VS Code has just brought back after a window reload.
   *
   * The panel already exists -- VS Code recreated the tab, in the group the author had put it in,
   * before this extension was even activated -- so there is nothing to create and nothing to
   * place. All that is missing is everything behind it: the shell HTML, the message wiring, the
   * engine. That is exactly what the private constructor does, which is why it takes a panel
   * rather than making one.
   *
   * `packRoot` comes from the webview's own saved state (see extension.ts's serializer), because
   * the host has no other way to know which pack a revived tab was showing.
   *
   * A pack that somehow already has a live panel wins and the revived tab is dropped: one panel
   * per pack is the rule everywhere else in this class, and a duplicate would be two graphs
   * fighting over one journal. */
  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    controller: PreviewController,
    packRoot: string,
    timeoutMs: number,
    onPreviewFile: (document: vscode.TextDocument, attributeNodeId: string) => void,
    onPackFileWritten: (absPath: string) => void,
  ): GraphPanel {
    const existing = GraphPanel.open.get(packRoot)
    if (existing) {
      panel.dispose()
      return existing
    }
    // Restored panels come back with their SCRIPTS OFF and no resource roots -- VS Code does not
    // persist webview options, and a revived graph without these is the blank grey rectangle
    // WEBVIEW_DID_NOT_START exists to explain.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    }
    return GraphPanel.adopt(panel, extensionUri, controller, packRoot, timeoutMs, onPreviewFile, onPackFileWritten)
  }

  private static adopt(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    controller: PreviewController,
    packRoot: string,
    timeoutMs: number,
    onPreviewFile: (document: vscode.TextDocument, attributeNodeId: string) => void,
    onPackFileWritten: (absPath: string) => void,
  ): GraphPanel {
    const created = new GraphPanel(panel, extensionUri, controller, packRoot, timeoutMs, onPreviewFile, onPackFileWritten)
    GraphPanel.open.set(packRoot, created)
    GraphPanel.lastActive = created
    openCountListener?.(GraphPanel.open.size)
    return created
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: PreviewController,
    private readonly packRoot: string,
    private readonly timeoutMs: number,
    // Injected rather than imported: opening a preview is extension.ts's wiring, and a panel
    // reaching for another panel directly is how two things that should not know about each
    // other end up depending on each other's lifetimes.
    // `attributeNodeId` rides along so the preview can highlight the blocks THAT node wrote --
    // see PreviewPanel.attributeNode, and previewPanel.ts's header for why it is this message,
    // and only this message, that ever makes a preview ask the engine for a profile. It is a
    // NODE ID, not a path: this panel never lets the webview name a file (see filesByNode), and
    // an id the pack does not have simply attributes nothing.
    private readonly onPreviewFile: (document: vscode.TextDocument, attributeNodeId: string) => void,
    // Called after this panel writes a pack file. The live preview learns about a change through
    // vscode.workspace.onDidSaveTextDocument, and an edit made HERE never goes through a document
    // save -- the engine writes the file directly -- so without this the preview keeps showing
    // what the pack looked like before the edit, indefinitely, with nothing to suggest it is
    // stale.
    private readonly onPackFileWritten: (absPath: string) => void,
  ) {
    this.firstGraph = new Promise<GraphSummary>((resolve, reject) => {
      this.settleFirstGraph = resolve
      this.rejectFirstGraph = reject
    })
    // A rejection handler is attached HERE, at creation, so a panel opened by something that
    // never awaits whenFirstGraph (a second command reusing an open panel, a test) cannot raise
    // an unhandled-rejection warning. It is not a swallow: the handler logs, and the promise
    // whenFirstGraph hands out is the original, so a real awaiter still sees the rejection.
    void this.firstGraph.catch((err: unknown) => log(`Graph for ${packRoot} could not be built: ${describeError(err)}`))
    // The backstop for a webview whose script never runs -- see WEBVIEW_READY_TIMEOUT_MS.
    this.readyTimer = setTimeout(() => {
      if (this.ready) return
      this.failFirstGraph(
        new Error(
          `the graph panel's script did not start within ${String(WEBVIEW_READY_TIMEOUT_MS)}ms. ` +
            'The panel is open; if it is blank, its bundle did not load.',
        ),
      )
    }, WEBVIEW_READY_TIMEOUT_MS)
    // Node keeps the process alive for a pending timer, which matters for the tests that drive
    // this class outside an extension host; unref where the runtime offers it.
    this.readyTimer.unref?.()
    log(`Graph panel opened for ${packRoot}`)
    panel.webview.html = buildGraphHtml(panel.webview, extensionUri, packRoot)
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: GraphHostMessage) => {
        // The rejection handler is the point of the wrapper. `void this.onMessage(message)` let
        // any throw inside a handler become an unhandled rejection: nothing on screen, nothing
        // in a log, and a button in the editor that simply did nothing.
        void this.onMessage(message).catch((err: unknown) => {
          const detail = describeError(err)
          log(`Graph message "${String((message as { type?: unknown } | null)?.type)}" failed: ${detail}`)
          this.post({ type: 'editError', message: detail })
        })
      }),
    )
    // Optional because the two test stubs for `vscode.WebviewPanel` do not fake view state and
    // have no need to: with one graph open, activePanel() answers the same panel either way.
    panel.onDidChangeViewState?.(() => {
      if (panel.active) GraphPanel.lastActive = this
      // A panel that no longer has the keyboard cannot be the one being typed into -- and a
      // webview that has been hidden may never deliver the focusout it would otherwise report
      // with. Clearing here is what stops `featurelab.graphTyping` sticking on and taking Ctrl+Z
      // away from every panel in the window. `!== true` rather than `!panel.active` because the
      // two test stubs for WebviewPanel do not fake view state at all.
      if (panel.active !== true) this.setTyping(false)
    }, null, this.disposables)
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  private async onMessage(message: GraphHostMessage): Promise<void> {
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        this.ready = true
        // A script that has just started has nothing focused, whatever the last page said before
        // it was torn down. Without this a panel hidden mid-edit and then brought back comes up
        // with the typing key still set and no undo anywhere.
        this.setTyping(false)
        if (this.readyTimer !== null) clearTimeout(this.readyTimer)
        this.readyTimer = null
        for (const held of this.pending) void this.panel.webview.postMessage(held)
        this.pending = []
        // Everything the last panel on this pack was left holding, BEFORE the graph: the webview
        // restores a camera and a search query onto the graph it is about to be handed, and
        // arriving afterwards would mean one frame drawn at the default zoom and then a jump.
        this.postRestoreState()
        this.postPreviewOnSelect()
        // The coverage table goes first: the creation menu cannot decide what may be created
        // without it, and it never changes for the life of the process.
        await this.sendTypes()
        await this.refresh()
        return
      case 'requestGraph':
        await this.refresh()
        return
      case 'retry':
        await this.retry()
        return
      case 'undo':
        await this.undoLastChange()
        return
      case 'redo':
        await this.redoLastChange()
        return
      case 'forgetUndo':
        this.forgetLastChange()
        return
      case 'openFile':
        await this.openNodeFile(message.nodeId, message.file)
        return
      case 'applyEdits':
        await this.applyEdits(message)
        return
      case 'annotate':
        await this.annotate(message)
        return
      case 'annotateBatch':
        await this.annotateBatch(message.ops, message.label)
        return
      case 'create':
        await this.create(message)
        return
      case 'moveNode':
        this.moveNode(message)
        return
      case 'previewOnSelect':
        // REMEMBERED, not acted on. Whether selecting a node previews it is decided in the
        // webview, where the selection is; this host's only part in it is that the answer
        // survives the panel being closed.
        void panelState?.update(previewOnSelectKey(this.packRoot), message.value === true)
        return
      case 'typingFocus':
        // PUSHED, not acted on -- see onGraphTypingChanged. The keystroke itself is the webview's
        // own business; all this side does is tell the workbench whether its undo keybinding
        // applies right now.
        this.setTyping(message.typing === true)
        return
      case 'persistState':
        void panelState?.update(graphViewStateKey(this.packRoot), withoutSearch(message.state ?? null))
        return
      case 'previewNode':
        await this.previewNode(message.nodeId, message.attribute)
        return
      case 'renameFeature':
        // A barrier rather than a journal entry: a rename rewrites every file that referred to the
        // old name, and this panel cannot list those in advance. See ChangeJournal.recordBarrier
        // for why an unlistable operation is recorded instead of skipped.
        this.journal.recordBarrier(`Rename ${message.from} to ${message.to}`)
        this.postHistory()
        await this.lifecycle(
          () => this.controller.renameFeature(this.packRoot, message.from, message.to, this.timeoutMs),
          message.to,
          'renamed',
        )
        return
      case 'deleteFeature':
        await this.deleteFeature(message)
        return
      case 'regenerate':
        await this.regenerate(message)
        return
      default:
        // Deliberately silent. An unknown message is a webview and host that have drifted out
        // of step, which a user can do nothing about and a dialog would only interrupt.
        return
    }
  }

  /** Asks the engine for the graph and hands it to the webview.
   *
   * An error is POSTED rather than thrown or shown as a modal: the graph panel is where someone
   * goes to find out why a pack is broken, so a pack that fails to load has to leave a readable
   * panel behind, not an empty one plus a toast that vanishes. */
  async refresh(): Promise<void> {
    const started = Date.now()
    const { warnings: packWarnings, contents: packContents } = await this.packState()
    // A refresh that starts while another is in flight supersedes it: the older answer is about a
    // pack state nobody is waiting to see any more, and leaving it running holds the engine's one
    // worker against the redraw somebody IS waiting for.
    this.inflightGraph?.abort()
    const inflight = new AbortController()
    this.inflightGraph = inflight
    try {
      const graph = await this.controller.graph(this.packRoot, this.timeoutMs, inflight.signal)
      // The layout is resolved HERE, not in the webview, because it merges three sources and
      // two of them are on disk: the automatic layout, positions annotated in the pack files,
      // and the sidecar the editor writes. The webview has no filesystem.
      const resolved = loadLayout(this.packRoot, graph as LayoutGraph, {
        nodeWidth: GRAPH_NODE_WIDTH,
        nodeHeight: GRAPH_NODE_HEIGHT,
      })
      // A node dropped a moment ago outranks all of it: the author put it there.
      const positions: Record<string, { x: number; y: number }> = { ...resolved.positions }
      for (const [id, at] of this.pendingPositions) positions[id] = at
      this.pendingPositions.clear()
      this.filesByNode.clear()
      for (const node of (graph as { nodes?: { id: string; file?: string }[] }).nodes ?? []) {
        if (node.file) this.filesByNode.set(node.id, node.file)
      }
      // Diagnostics ride ALONGSIDE the graph, not only inside it. They are already a field of
      // the engine's response, and the webview is handed that response whole -- but a renderer
      // reaching into `graph.diagnostics` would be reading a field that an older engine simply
      // does not send, and would have to re-do the shape checking every time. Lifted to the top
      // of the payload once, here, it is always an array and always well-formed, which is what
      // lets the thing that draws them be about drawing them.
      const diagnostics: readonly GraphDiagnostic[] = graphDiagnostics(graph)
      // The allow-list AND the positions, in one pass -- see diagnosticFiles' own comment.
      this.diagnosticFiles = new Map()
      for (const d of diagnostics) {
        if (this.diagnosticFiles.has(d.fileId)) continue
        const at = typeof d.line === 'number' && d.line > 0 ? { line: d.line, column: typeof d.column === 'number' && d.column > 0 ? d.column : 1 } : null
        this.diagnosticFiles.set(d.fileId, at)
      }
      const nodes = (graph as { nodes?: unknown[] }).nodes?.length ?? 0
      log(
        `Graph for ${this.packRoot}: ${String(nodes)} node(s), ${String(diagnostics.length)} diagnostic(s), ` +
          `built in ${String(Date.now() - started)}ms`,
      )
      // The LOCATION, not just the file. A log line that says which file would not parse and not
      // where is one the reader has to take back to the editor and search in by hand.
      for (const d of diagnostics) log(`  ${d.level} in ${diagnosticLocation(d)}: ${d.message}`)
      if (nodes === 0) {
        // Not an error and not a silence. A pack can legitimately have nothing in it, and the
        // canvas cannot say so by being blank -- blank is also what a broken editor looks like.
        // The webview draws the sentence; this line is what a log reader sees.
        log(`Graph for ${this.packRoot} has no nodes. The panel says so on the canvas.`)
      }
      for (const warning of packWarnings) log(`Pack warning for ${this.packRoot}: ${warning}`)
      this.post({
        type: 'graph',
        graph,
        diagnostics,
        // What the LOAD said about this pack -- the loaded-vs-read file counts and the pack-scoped
        // diagnostics naming every file the engine refused, positions included. It rides with the
        // graph because the canvas is where somebody looks when the graph is missing something,
        // and because a count of nodes cannot tell "this pack has 55 features" from "this pack has
        // 56 features and one of the files is broken" -- which is exactly the pair that used to be
        // indistinguishable. Empty far more often than not.
        packContents,
        positions,
        // What was wrong with the PACK rather than with any one file, in the engine's own words
        // plus this host's own path check. It rides with every graph, empty far more often than
        // not, so the canvas can say "no features here BECAUSE..." instead of guessing.
        packWarnings,
        undo: this.journal.undoLabel(),
        redo: this.journal.redoLabel(),
        // A sidecar that could not be parsed is reported rather than silently ignored: the
        // arrangement is someone's work, and quietly laying the graph out afresh looks like
        // the editor threw it away -- which, if they then save, it has.
        layoutProblem: resolved.problem ?? undefined,
        orphanedPositions: resolved.orphaned.length,
      })
      this.finishFirstGraph({
        packRoot: this.packRoot,
        nodes,
        diagnostics: diagnostics.length,
        brokenFiles: brokenFiles(packContents.diagnostics).length,
      })
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        // NOT a failure, and the canvas must not read like one. A cancelled graph leaves the
        // panel saying it was cancelled, with the same Retry button a failure offers, because
        // "stop" and "never mind, go on" are one keystroke apart and the second must not require
        // closing and reopening the panel.
        log(`Graph for ${this.packRoot} was cancelled after ${String(Date.now() - started)}ms.`)
        this.post({ type: 'graphCancelled', retry: true, packWarnings, packContents })
        this.failFirstGraph(err)
        return
      }
      const message = describeError(err)
      log(`Graph for ${this.packRoot} failed after ${String(Date.now() - started)}ms: ${message}`)
      // `retry` is the whole of the recovery affordance on this side. A panel whose load failed
      // used to be dead until the window was reloaded: nothing on it re-ran anything, and the
      // command that opened it had already returned. The webview draws a button; this flag is the
      // host promising that pressing it does something (see GraphPanel.retry).
      //
      // `packWarnings` rides the FAILURE too, and that is not symmetry for its own sake: the
      // commonest reason a graph will not build is that the path is not the pack somebody meant,
      // and that is exactly what these sentences say.
      this.post({ type: 'graphError', message, retry: true, packWarnings, packContents })
      this.failFirstGraph(err instanceof Error ? err : new Error(message))
    }
  }

  /** What is wrong with the PACK, as opposed to with any one file in it.
   *
   * Two sources, deliberately. The engine's own loadPack warnings are the authority on what it
   * could and could not read; this host adds the one check the engine's success answer cannot
   * express -- a pack root with no features/ directory loads perfectly and contains nothing, which
   * is indistinguishable from an empty pack unless somebody says so.
   *
   * Never throws. These are sentences to draw beside a graph, and a graph that failed to build
   * because its warning list failed to build would be the worse outcome by far.
   *
   * It now returns the load's CONTENTS beside the warnings, from the same one call: how many
   * files of each kind were read against how many built, and the pack-scoped diagnostics naming
   * every file the engine refused. Those are the facts the canvas needs to tell a pack with
   * nothing in it from a pack with a broken file in it, and they used to be unavailable at this
   * point -- which is why the canvas was reduced to counting diagnostics and the warnings were
   * asked to carry a question they were never written to answer. */
  private async packState(): Promise<{ warnings: string[]; contents: EmptyStatePackContents }> {
    const warnings: string[] = []
    const missing = missingFeaturesDirectoryWarning(this.packRoot)
    if (missing !== null) warnings.push(missing)
    let contents: EmptyStatePackContents = {}
    try {
      // Never issues a second load for a pack that is already loaded -- see
      // PreviewController.loadPackSummary -- so this costs nothing on the refresh path.
      const summary = await this.controller.loadPackSummary(this.packRoot, this.timeoutMs)
      for (const warning of summary.warnings ?? []) {
        if (!warnings.includes(warning)) warnings.push(warning)
      }
      contents = { fileCounts: summary.fileCounts, diagnostics: summary.diagnostics }
      log(`Pack at ${this.packRoot}: ${describePackContents(summary)}`)
      // Said in the LOG as well as on the canvas, and said as a count plus a naming rather than
      // only a count: this is the one line that explains a graph missing a feature the author can
      // see in their own editor.
      const broken = describeBrokenFiles(summary.diagnostics)
      if (broken !== null) log(`Pack at ${this.packRoot}: ${broken}`)
    } catch (err) {
      log(`Pack warnings for ${this.packRoot} could not be read: ${describeError(err)}`)
    }
    return { warnings, contents }
  }

  /** Re-runs the load and redraws -- the Retry command, and the button the webview draws on a
   * failed panel.
   *
   * A full reloadPack rather than a bare refresh(), because the failures worth retrying are the
   * ones where the pack itself is the problem: a file fixed in another editor, a path created, a
   * permission changed. Rebuilding the graph from the pack the engine parsed BEFORE any of that
   * would fail again, identically, and look like a button that does nothing.
   *
   * The reload's own failure is not thrown here: refresh() runs either way and reports whatever it
   * then finds, so a retry always ends with the panel saying something current. */
  async retry(): Promise<void> {
    log(`Retrying the feature graph for ${this.packRoot}.`)
    try {
      await this.controller.reloadPack(this.packRoot, this.timeoutMs)
    } catch (err) {
      log(`Retry: reloading ${this.packRoot} failed, rebuilding the graph anyway: ${describeError(err)}`)
    }
    await this.refresh()
  }

  /** Stops the graph request this panel currently has in flight, if any -- what the "Open Feature
   * Graph" command calls when the user presses Cancel on its notification.
   *
   * A no-op when nothing is running, which is the ordinary case for a panel that has already
   * drawn: the button is pressed by somebody who is watching a spinner, and by then the answer
   * may already have arrived. */
  cancelGraph(): void {
    if (this.inflightGraph === null) return
    log(`Cancelling the feature graph for ${this.packRoot} at the user's request.`)
    this.inflightGraph.abort()
  }

  /** Resolves when this panel has drawn its first graph; rejects with the reason it could not.
   *
   * What "Feature Lab: Open Feature Graph" holds its progress notification against, so the
   * command reports a pack that will not load as a notification with a "Show log" button rather
   * than leaving a blank panel and a sentence in its status line. Settles once; every call
   * afterwards gets the same already-settled answer, including a second command reusing an open
   * panel. */
  whenFirstGraph(): Promise<GraphSummary> {
    return this.firstGraph
  }

  private finishFirstGraph(summary: GraphSummary): void {
    const settle = this.settleFirstGraph
    this.settleFirstGraph = null
    this.rejectFirstGraph = null
    settle?.(summary)
  }

  private failFirstGraph(err: Error): void {
    const reject = this.rejectFirstGraph
    this.settleFirstGraph = null
    this.rejectFirstGraph = null
    reject?.(err)
  }

  /** Sends the engine's coverage table once. A failure here is not fatal to the panel -- the
   * graph still draws and is still readable; only creating new nodes is unavailable, which the
   * menu says for itself rather than pretending the list is empty. */
  private async sendTypes(): Promise<void> {
    try {
      const types = (await this.controller.listTypes(this.timeoutMs)) as { types?: unknown }
      this.post({ type: 'types', coverage: types?.types ?? [] })
    } catch (err) {
      const message = describeError(err)
      log(`The engine's feature-type table could not be fetched, so the creation menu is unavailable: ${message}`)
      this.post({ type: 'typesError', message })
    }
  }

  /** Rewrites a compound after its parameters changed.
   *
   * The selection is restored afterwards, because editing a setting must not move the author
   * somewhere else -- and the node they were editing is, from the graph's point of view, a
   * different object after every one of its files was rewritten. */
  private async regenerate(message: {
    owner: string
    files: readonly { path: string; contents: string }[]
    remove: readonly string[]
    label?: string
  }): Promise<void> {
    const touched = [...message.files.map((f) => f.path), ...(message.remove ?? [])]
    try {
      await this.journalled(message.label ?? `Rebuild ${message.owner}`, touched, () =>
        this.controller.regenerate(this.packRoot, message.owner, message.files, message.remove ?? [], this.timeoutMs),
      )
      for (const f of message.files) this.onPackFileWritten(path.join(this.packRoot, f.path))
      // Same acknowledgement as applyEdits, for the same gap: a compound is rewritten as several
      // files and the reader is looking at the form they just typed into, not at the disk.
      this.post({ type: 'saved', what: message.owner })
      await this.refresh()
      this.post({ type: 'created', nodeId: message.owner })
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Runs one write and records what it did to the files it was going to touch.
   *
   * THE SNAPSHOT IS TAKEN BEFORE, AND RECORDED IN A `finally`. Before, because afterwards there is
   * nothing left to read; in a finally, because an operation the engine refused is indistinguishable
   * from one it accepted until the files are compared -- and a refusal that changed nothing records
   * nothing (ChangeJournal.record returns null for an empty diff), so the caller never has to know
   * which happened.
   *
   * `files` are PACK-RELATIVE, the way every message spells them, and are resolved here. This is
   * the same rule the rest of the class obeys: the webview names things, the host turns names into
   * paths. */
  private journalled<T>(label: string, files: Iterable<string>, run: () => Promise<T>): Promise<T> {
    return this.serialised(async () => {
      const absolute = [...new Set([...files].map((f) => path.join(this.packRoot, f)))]
      const before: ReadonlyMap<string, FileBytes> = snapshot(absolute)
      try {
        return await run()
      } finally {
        const entry = this.journal.record(label, before, snapshot(absolute))
        if (entry !== null) log(`Recorded for undo: ${entry.label} (${String(entry.files.length)} file(s))`)
        this.postHistory()
      }
    })
  }

  /** The tail of the chain every operation that reads or writes pack files waits behind. */
  private writes: Promise<unknown> = Promise.resolve()

  /** Runs `job` only once every job handed here before it has finished.
   *
   * A JOURNAL ENTRY WHOSE `before` WAS READ MID-WRITE IS CORRUPTION, NOT A RACE TO NARROW.
   * `onDidReceiveMessage` is fire-and-forget -- VS Code offers no way to await a handler -- so two
   * messages arriving in the same tick run their handlers CONCURRENTLY. When both are journalled
   * writes over the same files, the second one's snapshot is taken while the first one's engine
   * call is part way through them, and what it records as "what this file was before" is a file
   * halfway between two states that nobody ever authored.
   *
   * What that cost, exactly, in the double-post the webview used to make (see createGroupForm):
   * the first Ctrl+Z put back a one-member group that had never existed, and the second refused --
   * "... has changed since then" -- and went on refusing forever, because `undo` refuses BEFORE
   * popping and the bytes it wants back are never coming. The panel's whole history was unusable
   * from that point on.
   *
   * The webview's half of that is fixed and this is the half that makes it unreachable: a
   * `before` cannot be read while another write is in flight, whatever the panel is asked to do
   * and however fast. The queue is per panel, which is the scope that matters -- a panel is how a
   * pack is open, and the journal is per panel for the same reason.
   *
   * THE CHAIN NEVER BREAKS. A rejected job is the ordinary outcome of an engine refusal, and a
   * chain that stopped there would hang every later write; the tail swallows failures while the
   * caller still sees its own. */
  private serialised<T>(job: () => Promise<T>): Promise<T> {
    const next = this.writes.then(job)
    this.writes = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Tells the webview what Undo and Redo would do, by name, or null when they would do nothing.
   *
   * Posted on its own as well as riding every graph, because the history changes on writes that do
   * not redraw and on undos that do -- and a Undo button whose tooltip names a change the author
   * already reverted is worse than no button. */
  private postHistory(): void {
    this.post({ type: 'history', undo: this.journal.undoLabel(), redo: this.journal.redoLabel() })
  }

  /** Puts the last change this panel made back, and redraws to what the files now say.
   *
   * THROWS an UndoRefused, rather than posting it, when there is nothing to undo or when the file
   * moved on underneath the entry. Both commands and the webview button reach this, and the two
   * want it phrased in different places -- a notification for the command, the panel's own error
   * line for the button -- so the sentence is raised here and worded once in changeJournal.ts.
   *
   * The engine is told to re-read the WHOLE pack afterwards, not the files that changed. An undo
   * can put back a file the engine had deleted, and a per-file reload of a path that did not exist
   * a moment ago is the one thing the incremental path cannot express. */
  async undoLastChange(): Promise<JournalEntry> {
    return this.serialised(async () => {
      const entry = this.historyStep(() => this.journal.undo())
      log(`Undid: ${entry.label} (${String(entry.files.length)} file(s))`)
      await this.afterHistoryMove(entry)
      // AFTER the redraw, not before it. The graph that a history move produces ends with the
      // canvas describing its own extent on the status line, so a sentence posted first is
      // overwritten by "Showing about 34 of 57 cards" before anybody reads it -- and what was
      // overwritten is the only report the panel makes of a write the author did not type.
      this.post({ type: 'undone', label: entry.label, files: entry.files.map((f) => path.relative(this.packRoot, f.file)) })
      return entry
    })
  }

  /** Re-applies what undoLastChange reverted, under the same guard and with the same redraw. */
  async redoLastChange(): Promise<JournalEntry> {
    return this.serialised(async () => {
      const entry = this.historyStep(() => this.journal.redo())
      log(`Redid: ${entry.label} (${String(entry.files.length)} file(s))`)
      await this.afterHistoryMove(entry)
      // After the redraw, for the reason undoLastChange gives.
      this.post({ type: 'redone', label: entry.label, files: entry.files.map((f) => path.relative(this.packRoot, f.file)) })
      return entry
    })
  }

  /** Takes one step through the history, PUTTING ANY REFUSAL ON THE CANVAS on the way past.
   *
   * A REFUSED UNDO USED TO BE INVISIBLE FROM THE PANEL. The sentence was raised here and caught by
   * whichever command had asked, which showed a VS Code notification -- and a notification is not
   * where somebody who just pressed Ctrl+Z over a canvas is looking. The canvas said nothing at
   * all: not the status line, not the card, nothing. So the refusal goes to the panel as an
   * `editError`, which is the one channel the canvas already turns into a red status line, and it
   * is STILL rethrown, because the command that asked still wants to say it its own way.
   *
   * `blockedUndo` is what makes the refusal escapable. `undo` refuses before popping, on purpose,
   * so the entry stays and every later press hits the same wall -- see ChangeJournal.drop. The
   * label rides along so the panel can offer to forget that one step, by name. */
  private historyStep(step: () => JournalEntry): JournalEntry {
    try {
      return step()
    } catch (err) {
      if (err instanceof UndoRefused) {
        const blocked = this.journal.undoLabel()
        this.post({
          type: 'editError',
          message: err.message,
          // Only when something really is stuck on the stack. "There is nothing to undo" is a
          // refusal too, and offering to forget an entry that is not there would be nonsense.
          blockedUndo: blocked === null ? undefined : blocked,
        })
      }
      throw err
    }
  }

  /** Takes the top entry off the history without writing anything -- the way out of a refusal
   * that will never stop being one. See ChangeJournal.drop; the author asks for this, having been
   * shown the refusal. */
  forgetLastChange(): JournalEntry | null {
    const entry = this.journal.drop()
    if (entry !== null) log(`Left out of the history at the author's request: ${entry.label}`)
    this.post({
      type: 'historyForgotten',
      label: entry?.label ?? null,
    })
    this.postHistory()
    return entry
  }

  private async afterHistoryMove(entry: JournalEntry): Promise<void> {
    try {
      await this.controller.reloadPack(this.packRoot, this.timeoutMs)
    } catch (err) {
      // The bytes are already back. A pack the engine then could not re-read is worth a line and
      // is not worth undoing the undo -- refresh() below reports whatever it finds.
      log(`Reloading ${this.packRoot} after "${entry.label}" failed: ${describeError(err)}`)
    }
    // Every referrer may have moved, so the whole pack is declared stale rather than one path --
    // the same rule the lifecycle operations follow.
    this.onPackFileWritten(this.packRoot)
    await this.refresh()
    this.postHistory()
  }

  /** What the Undo command would revert, by name, or null. Lets the command say "undid X" without
   * reaching into the journal itself. */
  pendingUndoLabel(): string | null {
    return this.journal.undoLabel()
  }

  pendingRedoLabel(): string | null {
    return this.journal.redoLabel()
  }

  /** The pack this panel is showing -- for a command that has to name it in a sentence. */
  get pack(): string {
    return this.packRoot
  }

  /** Runs one lifecycle operation and redraws.
   *
   * A refusal is posted rather than thrown, because the refusals here are the most useful thing
   * these operations produce: "three features still delegate to this one, and here they are" is
   * an answer, and a modal that vanishes is not.
   *
   * `select` is the node to land on afterwards -- the new name after a rename. Null after a
   * delete: there is nothing to select, and picking a neighbour would move somebody somewhere
   * they did not ask to be. */
  private async lifecycle(
    run: () => Promise<unknown>,
    select: string | null,
    what: 'created' | 'renamed' = 'created',
  ): Promise<void> {
    try {
      await run()
      // A rename or a delete touches files this panel cannot name in advance -- every referrer --
      // so the whole pack is declared stale rather than one path.
      this.onPackFileWritten(this.packRoot)
      await this.refresh()
      // `what` is not decoration: this path serves create, rename and the compound rewrite, and
      // without it a rename reported "Created wiki:x" -- naming an operation the author did not
      // perform, about a node that already existed.
      if (select !== null) this.post({ type: 'created', nodeId: select, what })
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Removes a feature, pointing whatever cannot live without it at the placeholder first.
   *
   * TWO ENGINE CALLS, IN THIS ORDER, AND THE ORDER IS THE SAFETY. `deleteFeature` on the engine
   * side refuses outright over a delegation the referring type cannot load without -- that
   * contract is frozen and is not being worked around here. The retarget is what makes the
   * refusal inapplicable: once those references name the placeholder instead, nothing required
   * points at the feature and the delete is the ordinary detach-and-remove it already supports.
   *
   * Every intermediate state is a pack that loads. After the retargets the parent places a
   * stand-in and the canvas says so; if the delete then fails, the author is left with a whole
   * pack, a message, and a node wearing "needs a feature" -- which is the state they asked for
   * minus the deletion, not a broken pack.
   *
   * A node this panel cannot resolve to a file stops the whole thing BEFORE anything is written.
   * That is the same rule every other message obeys: the webview names a node, the host decides
   * whether it knows a file for it, and a name it has never reported is not one it will invent a
   * path for.
   *
   * `select` afterwards is the first retargeted node rather than nothing. A delete used to land
   * the author back on an empty panel, which is right when the deletion is finished business --
   * but a retarget is unfinished business, and the node that now needs a feature is precisely
   * where they should be standing. */
  private async deleteFeature(message: {
    id: string
    detachReferences: boolean
    retarget?: readonly { nodeId: string; path: string }[]
    files?: readonly string[]
    confirmed?: boolean
  }): Promise<void> {
    const retarget = message.retarget ?? []
    // Already asked, in the panel, with more of the answer on screen than a modal detail line
    // holds -- see confirmDelete. Logged, because "who agreed to this write" is the one thing a
    // log of a destructive operation has to be able to say.
    if (message.confirmed === true) log(`Deleting ${message.id}: the panel asked and was told to go ahead.`)
    else if (!(await this.confirmDelete(message))) {
      log(`Delete of ${message.id} was cancelled at the confirmation. Nothing was written.`)
      // Said back to the panel as well as logged: the webview has already put the node into its
      // "deleting" state, and a cancel that left it there would look like a delete that hung.
      this.post({ type: 'deleteCancelled', id: message.id })
      return
    }
    // Recorded BEFORE the write, and as a barrier rather than an entry: a delete rewrites every
    // file that referred to the feature and this panel cannot list those in advance, so there is
    // no honest `before` to keep. See ChangeJournal.recordBarrier for why the alternative --
    // recording nothing -- is worse: the next Ctrl+Z would silently revert an unrelated edit.
    this.journal.recordBarrier(`Delete ${message.id}`)
    this.postHistory()
    // Grouped per file, because two slots of one compound are one write, and because a per-slot
    // call would be a per-slot chance of stopping half way through one file.
    const perFile = new Map<string, { path: string; value: string }[]>()
    for (const slot of retarget) {
      const file = this.filesByNode.get(slot.nodeId)
      if (!file) {
        this.post({
          type: 'editError',
          message:
            `${slot.nodeId} delegates to ${message.id} and this panel has no file for it, so that delegation cannot be ` +
            'pointed anywhere. Nothing was written.',
        })
        return
      }
      const edits = perFile.get(file) ?? []
      edits.push({ path: slot.path, value: JSON.stringify(PLACEHOLDER_FEATURE) })
      perFile.set(file, edits)
    }
    try {
      for (const [file, edits] of perFile) {
        await this.controller.applyEdits(this.packRoot, file, edits, this.timeoutMs)
        this.onPackFileWritten(path.join(this.packRoot, file))
      }
      await this.controller.deleteFeature(this.packRoot, message.id, message.detachReferences, this.timeoutMs)
      // A delete touches files this panel cannot name in advance -- every referrer -- so the
      // whole pack is declared stale rather than one path.
      this.onPackFileWritten(this.packRoot)
      await this.refresh()
      this.post({ type: 'deleted', id: message.id, retargeted: [...new Set(retarget.map((slot) => slot.nodeId))] })
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
      // A retarget that landed before the delete failed is a real change to the pack, and a
      // panel still drawing the graph from before it would be lying about a file on disk.
      if (perFile.size > 0) await this.refresh()
    }
  }

  /** Asks, in a modal dialog naming the files, before anything is written. Every time a delete
   * has not already been put to the author and agreed to, which is every ordinary delete.
   *
   * ASKING AT ALL is the change this was. The panel used to confirm only when something still
   * referred to the feature, so deleting an unreferenced node -- which is most nodes, and is
   * exactly the node somebody clicks by accident -- removed a file from disk on a single click,
   * with no dialog, no undo and no styling to say the button was any different from the others.
   *
   * ASKING TWICE IS NOT TWICE THE SAFETY, which is the change since. Two of the webview's paths
   * put the same decision to the author first and can show more of it than a dialog's detail line
   * can: the referrer list behind a `referenced` refusal -- every referrer with its file and its
   * json path, which is the only thing the author can decide from -- and a multi-select delete,
   * whose question is about a count this host never sees because it receives the deletes one at a
   * time. Those arrive with `confirmed` set and this dialog stands down. A second dialog on top of
   * a question already answered is a dialog that gets dismissed without being read, and the one
   * that matters -- the accidental single click, which sets nothing -- still stops here.
   *
   * `confirmed` IS NOT A BACK DOOR, and is worth being clear about because it looks like one. It
   * is set by this extension's own webview bundle, on a click on a button whose label names what
   * it destroys, and the panel it came from is drawn by this same host. Everything factual in the
   * message is still checked the way it always was: `retarget` and `files` are matched against the
   * node->file table below, and nothing is written for a node this host cannot resolve to a file.
   *
   * DEFAULT-CANCEL. The affirmative is the only button passed; VS Code supplies Cancel and it is
   * what Escape and a dismissed dialog both produce, so every way of not answering means "do not
   * delete". Nothing here treats a dismissal as consent.
   *
   * The file list is the host's own -- the node's file from the node->file table, plus the files of
   * the delegations being retargeted. A list the webview sent is merged in only after every path in
   * it has been matched against that same table: the confirmation is the one place this panel makes
   * a factual claim about what it is about to write, and a path it has never reported is not a fact
   * it has. */
  private async confirmDelete(message: {
    id: string
    detachReferences: boolean
    retarget?: readonly { nodeId: string; path: string }[]
    files?: readonly string[]
    group?: string
  }): Promise<boolean> {
    const known = new Set(this.filesByNode.values())
    const files = new Set<string>()
    const own = this.filesByNode.get(message.id)
    if (own !== undefined) files.add(own)
    for (const slot of message.retarget ?? []) {
      const file = this.filesByNode.get(slot.nodeId)
      if (file !== undefined) files.add(file)
    }
    for (const claimed of message.files ?? []) {
      if (known.has(claimed)) files.add(claimed)
    }
    const { message: title, detail } = deleteConfirmation(message.id, [...files].sort(), message.detachReferences, message.group)
    log(`Asking before deleting ${message.id}: ${detail}`)
    const answer = await vscode.window.showWarningMessage(title, { modal: true, detail }, DELETE_CONFIRM)
    return answer === DELETE_CONFIRM
  }

  /** Shows the selected feature in the live preview, beside the graph.
   *
   * It opens the node's own FILE and hands it to the existing preview, rather than growing a
   * second renderer here: that preview already owns the textures, the environment presets and
   * the placement budget, and a second one would be a second set of all three to keep in step.
   *
   * A node with no file behind it is a reference nothing defines. Saying so beats previewing
   * nothing, which reads as the preview being broken. */
  private async previewNode(nodeId: string, attribute?: string): Promise<void> {
    const file = this.filesByNode.get(nodeId)
    if (!file) {
      this.post({ type: 'editError', message: `${nodeId} has no file to preview -- nothing in this pack defines it.` })
      return
    }
    try {
      const document = await vscode.workspace.openTextDocument(path.join(this.packRoot, file))
      this.onPreviewFile(document, attribute ?? nodeId)
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Selects a node in this panel's graph, on somebody else's behalf -- what "click a block in
   * the preview and find out what placed it" ends in.
   *
   * The other half of the loop graph/attribution.ts's AttributionBridge describes: the webview
   * applies this with GraphView.setSelection, which does NOT fire onSelect, so the selection
   * stops here instead of bouncing straight back out as a fresh preview request. Without that
   * asymmetry the two panels would hand one selection to each other forever.
   *
   * `writers` is EVERY feature the preview found at that cell, in the profile's own order, and
   * it is passed whole rather than narrowed here: a cell written by two features is the normal
   * case, and which of them the viewer is actually looking at is not in the engine's contract.
   * The webview selects the first and says how many others there were, which is an honest
   * summary of an ambiguous answer rather than a confident wrong one. An empty list is also an
   * answer -- the block is environment -- and is passed through as such. */
  selectNodes(writers: readonly string[]): void {
    this.post({ type: 'attributionSelect', nodeIds: [...writers] })
  }

  /** Tells the graph that the preview it was driving has been closed.
   *
   * WHAT THIS IS NOT, ANY MORE: a way of turning "Preview on select" off. It used to be exactly
   * that -- closing the preview force-cleared the toggle -- which made the toggle unusable the
   * other way round: a panel closed for any of the ordinary reasons (tidying the editor, a window
   * reload, closing it to open something else) silently disarmed a mode the author had switched
   * on, and they had to find and press the button again. "The preview is gone" and "stop
   * previewing on select" are two different facts and the author only stated one of them.
   *
   * So this now says only what happened, and the AUTHORITATIVE value of the toggle is re-sent
   * straight after it -- which is what makes a webview that still clears the toggle on this
   * message correct anyway: it clears, then the value it was left with arrives and puts it back.
   * The webview draws whatever it is told; nothing here decides for it. */
  previewClosed(): void {
    this.post({ type: 'previewClosed' })
    this.postPreviewOnSelect()
  }

  /** The remembered "Preview on select" value, as the webview should restore it. See
   * previewOnSelectKey: false whenever nothing has been remembered, which is exactly the default
   * the toggle has always had. */
  private postPreviewOnSelect(): void {
    this.post({ type: 'previewOnSelect', value: panelState?.get<boolean>(previewOnSelectKey(this.packRoot), false) ?? false })
  }

  /** Hands the webview back its own blob -- see graphViewStateKey. `key` travels with it because
   * the webview has to write it into its own `setState`: on a window reload VS Code hands this
   * host the webview's saved state and nothing else, so that key is the only thing that can say
   * WHICH PACK a revived tab was showing (see extension.ts's serializer). */
  private postRestoreState(): void {
    this.post({
      type: 'restoreState',
      key: this.packRoot,
      // Stripped on the way OUT as well as on the way in, because a blob written before this
      // rule existed is still sitting in workspaceState on every machine that has used the
      // graph, and it would go on hiding most of the pack until somebody searched again.
      state: withoutSearch(panelState?.get<unknown>(graphViewStateKey(this.packRoot), null) ?? null),
    })
  }

  /** Hands the graph what one run measured, per feature -- or `null` to take it back off.
   *
   * `null` is not an error path and is sent often: a regenerate with no profile, a preview that
   * closed. The numbers describe a run, so when the run is gone so are they, and a card left
   * wearing measurements from a preview nobody has open any more would be the worst of both --
   * a fact about nothing, phrased as a fact about a node.
   *
   * Sent only by a preview that is ALREADY profiling, which is a preview the graph itself asked
   * to profile (see previewPanel.ts's header). Nothing here widens that. */
  showRunStats(stats: RunStatsWire | null): void {
    this.post({ type: 'runStats', stats })
  }

  /** Records a node's new position in the sidecar.
   *
   * The sidecar and NOT the pack file, which is the whole reason moving a node is free: a
   * position is not something the game reads, so writing it into a feature would put a key in a
   * file the engine then has to ignore, and would make rearranging the canvas show up as a
   * change to the pack in version control.
   *
   * The file is re-read before each write rather than kept in memory, because a person can edit
   * it, and another window can be open on the same pack. Losing someone's arrangement to a
   * stale copy is a poor trade for saving a small read.
   *
   * Failures are reported and not retried. The sidecar is a convenience; a pack whose layout
   * cannot be saved is still entirely editable, and a modal about it would interrupt the work
   * it is describing. */
  private moveNode(message: { nodeId: string; x: number; y: number }): void {
    try {
      const current = readSidecar(this.packRoot).sidecar
      writeSidecar(this.packRoot, withPosition(current, message.nodeId, { x: message.x, y: message.y }))
    } catch (err) {
      this.post({
        type: 'layoutError',
        message: `The arrangement could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /** Creates the files a new node means, then refreshes and selects it.
   *
   * The position the author dropped it at is remembered BEFORE the write, so a node that lands
   * successfully is where they put it rather than wherever the automatic layout decides. It is
   * kept even if the write fails, which costs nothing and means a retry after fixing a name
   * collision still lands in the right place.
   *
   * A refusal is posted to the panel rather than thrown as a modal: the commonest one by far is
   * a name that is already taken, and that is something to read next to the graph showing the
   * node that has it. */
  private async create(message: {
    files: readonly { path: string; contents: string }[]
    select?: string
    position?: { x: number; y: number }
    label?: string
  }): Promise<void> {
    if (!message.files || message.files.length === 0) return
    if (message.select && message.position) {
      this.pendingPositions.set(message.select, message.position)
    }
    try {
      await this.journalled(
        message.label ?? `Create ${message.select ?? message.files[0]?.path ?? 'a node'}`,
        message.files.map((f) => f.path),
        () => this.controller.createFiles(this.packRoot, message.files, this.timeoutMs),
      )
      for (const f of message.files) this.onPackFileWritten(path.join(this.packRoot, f.path))
      await this.refresh()
      if (message.select) this.post({ type: 'created', nodeId: message.select })
    } catch (err) {
      this.post({ type: 'createError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Writes a batch of field edits through the engine, then refreshes.
   *
   * A batch, not one call per edit, because some actions are inherently plural: swapping a
   * feature's exclusive variant removes one key and writes another, and applied separately the
   * file would exist for a moment with neither variant or with both. The engine applies a batch
   * all-or-nothing against the original bytes.
   *
   * The refresh is not an optimisation. The file on disk is the source of truth, so the panel
   * must show what the round-trip writer actually produced rather than what the webview assumed
   * it would; and if an edit is refused, the graph comes back unchanged with a message saying
   * why, which beats a panel displaying an edit the file never received.
   *
   * `json: null` means the key is being removed. That is a different file from writing a null,
   * and the two must not be conflated -- absent and null are distinguishable to the engine. */
  private async applyEdits(message: {
    file: string
    edits: readonly { path: string; json: string | null }[]
    label?: string
  }): Promise<void> {
    if (!message.file) {
      this.post({ type: 'editError', message: 'That node has no file behind it, so there is nothing to write.' })
      return
    }
    if (!message.edits || message.edits.length === 0) return
    try {
      await this.journalled(message.label ?? editLabel(message.file, message.edits), [message.file], () =>
        this.controller.applyEdits(
          this.packRoot,
          message.file,
          message.edits.map((e) => (e.json === null ? { path: e.path, delete: true } : { path: e.path, value: e.json })),
          this.timeoutMs,
        ),
      )
      this.onPackFileWritten(path.join(this.packRoot, message.file))
      // BEFORE the refresh, not after it, and that is the whole point of the message.
      //
      // The webview says "Writing ... to <file>..." when it sends the edit and then has nothing
      // to go on until the rebuilt graph arrives -- which is an engine round trip and a full
      // redraw away, measured at several seconds on a real pack. For all of that time the panel
      // looked identical to one where nothing had happened. This is the acknowledgement that the
      // bytes reached the disk, sent the moment they did; the graph that follows replaces it with
      // the card count, so it costs no screen time that was carrying anything else.
      this.post({ type: 'saved', what: message.file })
      await this.refresh()
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Records one directive in a file's comments, then redraws.
   *
   * The redraw is the point, not a courtesy. Annotations are part of the graph the webview is
   * handed (wire.GraphNode.Annotations) and are what the Molang editor reads its "this author
   * already decided that" state back out of -- so a panel that wrote one without refreshing would
   * keep drawing a graph in which the directive it had just written did not exist, and the next
   * thing anybody touched would be rendered from that stale answer. */
  private async annotate(message: {
    file: string
    path: string
    name: string
    args?: readonly string[]
    label?: string
  }): Promise<void> {
    if (!message.file) {
      this.post({ type: 'editError', message: 'That node has no file behind it, so there is nothing to annotate.' })
      return
    }
    try {
      await this.journalled(message.label ?? `Note @featurelab:${message.name} in ${message.file}`, [message.file], () =>
        this.controller.annotate(this.packRoot, message.file, message.path, message.name, message.args ?? [], this.timeoutMs),
      )
      this.onPackFileWritten(path.join(this.packRoot, message.file))
      await this.refresh()
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Records or removes several directives at once, then redraws once.
   *
   * The refresh is the same one `annotate` needs and for the same reason; here it also matters
   * that there is ONE of it. A group operation touches every member's file, and a redraw per file
   * would draw the group in every intermediate state -- half renamed, half collapsed -- on the
   * way to the one the author asked for. */
  private async annotateBatch(ops: readonly AnnotateOp[], label?: string): Promise<void> {
    if (!ops || ops.length === 0) return
    if (ops.some((op) => !op.file)) {
      this.post({ type: 'editError', message: 'One of those nodes has no file behind it, so the group could not be written.' })
      return
    }
    const files = [...new Set(ops.map((op) => op.file))]
    try {
      await this.journalled(label ?? `Annotate ${String(files.length)} file(s)`, files, () =>
        this.controller.annotateBatch(this.packRoot, ops, this.timeoutMs),
      )
      for (const file of new Set(ops.map((op) => op.file))) this.onPackFileWritten(path.join(this.packRoot, file))
      await this.refresh()
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Opens the file a node came from, beside the graph.
   *
   * Beside rather than on top: the graph is how someone found the file, and replacing it with
   * the file takes away the thing that gave the file meaning. An unresolved node has no file,
   * and says so rather than doing nothing, which would read as a broken double-click. */
  /** Opens a node's file, or a pack-relative path directly.
   *
   * The direct path is not a convenience. A file the engine REFUSED produces no node, so it has
   * no entry in `filesByNode` -- and that is exactly the file an author most needs to open,
   * because a message about a file you cannot reach from the message is most of the way to no
   * message at all. */
  private async openNodeFile(nodeId: string | undefined, directFile?: string): Promise<void> {
    if (directFile !== undefined && !this.diagnosticFiles.has(directFile)) {
      // Not an error the author can act on, so it is not shown as one: it means the webview
      // asked for something this host never offered, which is a bug here rather than in a pack.
      this.post({ type: 'editError', message: 'That file is not one this pack reported a problem in.' })
      return
    }
    const file = directFile ?? (nodeId === undefined ? undefined : this.filesByNode.get(nodeId))
    if (!file) {
      if (nodeId === undefined) {
        this.post({ type: 'editError', message: 'That message named no file to open.' })
        return
      }
      this.post({
        type: 'editError',
        message: `${nodeId} has no file in this pack -- something delegates to it, but nothing defines it.`,
      })
      return
    }
    try {
      const document = await vscode.workspace.openTextDocument(path.join(this.packRoot, file))
      // AT the problem, not merely at the file, whenever the engine said where it is. The engine
      // counts lines and columns from 1 and VS Code counts from 0; that conversion is the only
      // arithmetic here and it is done once. A position past the end of the file -- a diagnostic
      // from before an edit that shortened it -- is clamped by VS Code itself rather than
      // refusing to open the file, which would trade a slightly wrong cursor for no file at all.
      const at = this.diagnosticFiles.get(file) ?? null
      const selection =
        at === null ? undefined : new vscode.Range(at.line - 1, Math.max(0, at.column - 1), at.line - 1, Math.max(0, at.column - 1))
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection })
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Re-reads the pack and redraws, for a file saved in a text editor.
   *
   * The JSON is the source of truth, so an edit made outside this panel is as real as one made
   * inside it, and a graph that quietly disagreed with the file someone just saved would be
   * worse than no graph. */
  async notifyFileSaved(filePath: string): Promise<void> {
    // Re-read the saved file BEFORE rebuilding the graph. refresh() alone is not enough and the
    // reason is easy to miss: the engine builds a graph from the pack it parsed at load time, and
    // ensurePackLoaded returns immediately for a pack that is already loaded, so nothing on that
    // path ever touches the disk. An edit made in a text editor simply never appeared.
    //
    // It hid because both panels share one engine process: with a preview open beside the graph,
    // the preview's own reload refreshed the pack and the graph got the change by accident.
    try {
      await this.controller.reloadPackFile(this.packRoot, filePath, this.timeoutMs)
    } catch (err) {
      // A file the engine cannot re-read is worth saying so about, and the graph is still worth
      // rebuilding from what it does have.
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
    await this.refresh()
  }

  private post(message: unknown): void {
    if (!this.ready) {
      this.pending.push(message)
      return
    }
    void this.panel.webview.postMessage(message)
  }

  dispose(): void {
    // BEFORE the panel leaves the table, so publishTyping still counts it and settles on the
    // truth for whatever is left open. A closed panel that was mid-edit is the easiest way to
    // strand `featurelab.graphTyping` on, and a stranded key means no undo at all.
    this.setTyping(false)
    GraphPanel.open.delete(this.packRoot)
    if (GraphPanel.lastActive === this) GraphPanel.lastActive = null
    openCountListener?.(GraphPanel.open.size)
    if (this.readyTimer !== null) clearTimeout(this.readyTimer)
    this.readyTimer = null
    // Closing the panel cancels its graph for real, not just this side's interest in it: there is
    // nothing left to draw the answer on, and the engine has better things to do than finish it.
    this.inflightGraph?.abort()
    this.inflightGraph = null
    // A panel shut before its first graph arrived has to settle, or the command that opened it
    // holds a progress notification over a panel that is no longer there.
    this.failFirstGraph(new Error('the graph panel was closed before the pack finished loading'))
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}

function buildGraphHtml(webview: vscode.Webview, extensionUri: vscode.Uri, packRoot: string): string {
  return renderGraphShellHtml({
    nonce: getNonce(),
    cspSource: webview.cspSource,
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'graph.js')).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.css')).toString(),
    packLabel: packRoot,
  })
}
