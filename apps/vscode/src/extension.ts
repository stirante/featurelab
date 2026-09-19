// extension.ts -- activation entry point. Wires: the "Feature Lab: Preview Feature" command,
// the "Feature Lab: Open Feature Graph" command, "Feature Lab: Show Log", a save listener that
// reloads-and-regenerates every open preview whose pack the saved file belongs to, a background
// pack pre-warm keyed on the active editor (see maybePrewarm), go-to-definition for feature
// references (featureDefinitionProvider.ts), and a single PreviewController (one live engine
// process) shared across every preview panel for this extension session ("load the pack once and
// keep the process alive across regenerations; do not restart the binary per save").
//
// # What a command owes the person who ran it
//
// Both commands go through runCommand() below, and the shape is the same for both because the
// complaint that produced it was the same for both: "I ran it and nothing happened."
//
//   1. SAY IT STARTED. One progress notification for the whole command, whose detail line names
//      the step it is on (checking the engine, loading the pack, building the graph). A command
//      that takes 700ms with no notification and one that is wedged are indistinguishable.
//   2. CHECK THE ENGINE BEFORE NEEDING IT. resolveBinaryPath only proves a file is there;
//      engineCheck.ts proves it runs. Both failures name the path they tried.
//   3. END IN WORDS. Every exit from a command is a result or a `fail()` -- a short sentence,
//      a "Show log" button, and the long form in the channel. Nothing is swallowed, and nothing
//      is left to a webview that may not have loaded.
//
// The bug that made this necessary was two lines long: openGraph called resolvePackRoot, which
// THROWS for a file outside a pack, and then tested its result for null. A JSON file opened
// anywhere else in a workspace therefore threw straight past the handler, and VS Code's own
// "command failed" notice names the command and nothing else. That is the "could not get the
// node editor to open, with nothing on screen telling him why" report, exactly.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  BinaryNotFoundError,
  extensionVersion,
  resolveBinaryPath,
  resolveEngineBinary,
  staleSiblingNote,
  type ResolvedBinary,
} from './binaryResolver.js'
import { bundledEngineFreshness, probeEngine, type EngineProbe } from './engineCheck.js'
import { PreviewController, type LoadPackResult } from './previewController.js'
import {
  PreviewPanel,
  REFRESH_TEXTURES_COMMAND,
  freshPreviewParams,
  previewParamsKey,
  type GraphLink,
  type RememberedPreviewParams,
  type RevivedPreview,
} from './previewPanel.js'
import { createDiagnosticCollection } from './diagnostics.js'
import { brokenFiles, describeBrokenFiles, describePackContents, diagnosticLocation } from './packContents.js'
import { DocumentParseError, PackRootError, parseDocumentIdentifier, resolvePackRoot } from './identifier.js'
import { FeatureDefinitionProvider } from './featureDefinitionProvider.js'
import { GraphPanel, onGraphPanelCountChanged, onGraphTypingChanged, setGraphPanelState } from './graphPanel.js'
import { UndoRefused } from './changeJournal.js'
import { RETRY, describeError, disposeLog, fail, log, logVerbatim, output, showLog, warn, type FailAction } from './log.js'
import { CancelledError, disposeProgress, reportEngineProgress, runWithProgress } from './progress.js'
import { RequestCancelledError } from './engineProcess.js'

let controller: PreviewController | undefined
const panelsByUri = new Map<string, PreviewPanel>()
/** The preview the GRAPH is driving, if any.
 *
 * Held separately from panelsByUri because that map is keyed by document and this panel's
 * document changes every time the author selects another node. Cleared when the panel closes, so
 * a preview that has been shut is not silently revived -- see the dispose callback. */
let graphDrivenPanel: PreviewPanel | null = null
let diagnosticCollection: vscode.DiagnosticCollection

/** A failure a command already knows how to phrase: one short sentence for the notification and
 * the long form for the log. Thrown from inside a command's progress body and turned into a
 * `fail()` by runCommand, so the notification appears AFTER the progress closes rather than
 * behind it. */
class CommandFailure extends Error {
  constructor(
    readonly userMessage: string,
    readonly detail: string,
    /** An extra button on the notification -- "Retry", where retrying is a thing that exists. */
    readonly action?: FailAction,
  ) {
    super(userMessage)
    this.name = 'CommandFailure'
  }
}

/** The "Retry" button a graph failure carries, and the one place that decides what it does. */
const retryGraphAction: FailAction = {
  label: RETRY,
  run: () => void vscode.commands.executeCommand('featurelab.retryGraph'),
}

/** The extension context, for the command bodies. Set by activate(); a command cannot run
 * before it. Held rather than closed over so runCommand can report the (impossible) early call
 * as a sentence rather than dereference undefined. */
let activeContext: vscode.ExtensionContext | undefined

/** The language ids a pack file plausibly has.
 *
 * `json` alone is what this extension activated on, and it was not enough twice over: pack JSON
 * routinely carries comments (so people map it to `jsonc`, or write `.json5`), and a window opened
 * on a pack FOLDER with nothing yet in the editor has no language at all -- which is why
 * package.json also activates on the shape of the workspace. Kept here, next to the code that
 * tests it, and repeated in the manifest's `activationEvents` and `when` clauses because VS Code
 * has nowhere to share one list between the two. */
export const PACK_LANGUAGE_IDS = ['json', 'jsonc', 'json5']

export function activate(context: vscode.ExtensionContext): void {
  activeContext = context
  // Created here rather than on first use so that a command failing before it can open anything
  // still has somewhere to write, and so "Show Log" always has something to show.
  context.subscriptions.push(output())
  log('Feature Lab activated.')

  diagnosticCollection = createDiagnosticCollection()
  context.subscriptions.push(diagnosticCollection)

  // Where both panels remember the handful of things that have to outlive them -- "Preview on
  // select", the graph's camera and search, the preview's params, each webview's own view state.
  // workspaceState and not globalState: every one of them is about a pack, and a pack is what a
  // workspace is open on.
  setGraphPanelState(context.workspaceState)
  context.subscriptions.push({ dispose: () => setGraphPanelState(null) })
  registerPanelSerializers(context)

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.showLog', () => {
      showLog()
    }),
  )

  // `featurelab.graphOpen` is what package.json's commandPalette entries are written against, so
  // Undo, Redo and Retry are offered exactly while there is a graph for them to act on. A palette
  // full of commands that answer "there is no feature graph open" is a palette that has to be read
  // twice; this is the cheapest way to make the list mean something.
  setGraphOpenContext(GraphPanel.openCount() > 0)
  onGraphPanelCountChanged((count) => setGraphOpenContext(count > 0))
  context.subscriptions.push({ dispose: () => onGraphPanelCountChanged(null) })

  // `featurelab.graphTyping` is the other half of the undo keybinding -- see the comment on
  // setGraphTypingContext. Set to false here rather than left unset, so a window that has never
  // opened a graph has a key with a value rather than one a `when` clause has to guess at.
  setGraphTypingContext(false)
  onGraphTypingChanged(setGraphTypingContext)
  context.subscriptions.push({ dispose: () => onGraphTypingChanged(null) })

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.undo', () =>
      runHistoryCommand('undo', (panel) => panel.undoLastChange()),
    ),
    vscode.commands.registerCommand('featurelab.redo', () =>
      runHistoryCommand('redo', (panel) => panel.redoLastChange()),
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.retryGraph', () =>
      runCommand('retrying the feature graph', async (_context, report) => {
        const panel = GraphPanel.activePanel()
        if (panel === null) {
          throw new CommandFailure(
            'Feature Lab: there is no feature graph open to retry. Run "Feature Lab: Open Feature Graph" first.',
            'featurelab.retryGraph ran with no open graph panel.',
          )
        }
        report('reloading the pack')
        await panel.retry()
      }),
    ),
  )

  // The way back into block textures from inside the editor, and the only one there is.
  //
  // Two things were unreachable without it. An atlas is checked when a preview's webview comes
  // up; before the post-regenerate re-check existed, repainting a texture with the panel open
  // changed nothing for the rest of the session. And a "no" to the download question is recorded
  // by the ENGINE, beside the atlas, so that no host asks twice -- which left the only way to
  // take it back being a CLI flag a user of this extension has no reason to have heard of. A
  // decision somebody can only reverse in a terminal is not a reversible decision.
  //
  // It acts on every open preview, not the active one: they all draw from the same machine-wide
  // atlas, so refreshing "this" one and leaving its neighbour on the old sheet would be an
  // answer nobody could explain.
  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_TEXTURES_COMMAND, () =>
      runCommand('refreshing block textures', async (_context, report) => {
        const panels = [...panelsByUri.values()]
        if (panels.length === 0) {
          throw new CommandFailure(
            'Feature Lab: there is no preview open to refresh the block textures for. Run "Feature Lab: Preview Feature" first.',
            `${REFRESH_TEXTURES_COMMAND} ran with no open preview panel.`,
          )
        }
        report('checking the block atlas')
        // Sequential: each one spawns `featurelab textures` and may build the same atlas
        // directory, and two builds racing over one directory is not a thing to find out about
        // in a user's cache.
        for (const panel of panels) await panel.refreshTextures()
      }),
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.previewFeature', () =>
      runCommand(
        'opening the preview',
        async (context_, report, signal) => {
          const editor = requireEditor(
            'Feature Lab: open a feature JSON file in the editor first, then run this command. ' +
              'To see the whole pack instead, run "Feature Lab: Open Feature Graph".',
          )
          log(`Preview Feature: asked about ${editor.document.uri.fsPath}`)
          // Resolved HERE as well as inside the panel, so that the one failure a user cannot act
          // on from inside a webview -- the file is not in a pack, so no panel is worth opening --
          // is reported as a notification instead of as text inside a panel nobody asked for.
          const packRoot = requirePackRoot(editor.document.uri.fsPath)
          report('checking the engine')
          const ctl = await requireController(context_)
          report('loading the pack')
          const contents = await reportPackContents(ctl, packRoot)
          if (contents.featureCount === 0 && contents.ruleCount === 0) {
            // The preview has no canvas of its own to write this on -- it will ask the engine for
            // a feature that is not there and show the engine's refusal, which is true but reads
            // as a mistake in the file rather than as "there is nothing in this pack". Said here,
            // once, before the panel opens.
            void warn(`Feature Lab: the pack at ${packRoot} declares no features and no feature rules yet.`)
          }
          report('generating the preview')
          const panel = openOrRevealPreview(context_, ctl, editor.document)
          // Cancel on the notification stops the ENGINE's placement, not just this wait. The
          // panel owns the request (a regenerate is also started by a save and by the webview's
          // own controls), so the signal is forwarded to it rather than threaded through the
          // call.
          signal.addEventListener('abort', () => panel.cancelGenerate(), { once: true })
          try {
            await panel.whenFirstResult()
          } catch (err) {
            if (err instanceof RequestCancelledError) {
              // The user cancelled. The panel already says so on its own face (see
              // PREVIEW_CANCELLED) and runCommand is about to log the cancellation; turning this
              // into a "could not preview" notification would report somebody's own decision back
              // to them as a failure.
              return
            }
            // The panel shows this too, in its own error slot. It is repeated as a notification
            // because a panel that has just opened is not necessarily where the user is looking,
            // and because a first run that fails while the webview is still booting puts its
            // message into an outbox nobody is reading yet.
            throw new CommandFailure(
              `Feature Lab: could not preview ${path.basename(editor.document.uri.fsPath)}.`,
              `The first run for ${editor.document.uri.fsPath} failed: ${describeError(err)}`,
            )
          }
        },
        // The wait is abandonable AND the engine is told: a preview of a heavy feature can run
        // for seconds, and until now pressing Cancel left it running with nobody waiting.
        { cancellable: true },
      ),
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.openGraph', () =>
      runCommand(
        'opening the feature graph',
        async (context_, report, signal) => {
          // The graph is a property of the PACK, not of one file, so it is resolved from whatever
          // document is in front of the user rather than being about that document. Opening it
          // from a feature file and from a feature rule in the same pack must reach one panel.
          const packRoot = requireGraphPackRoot()
          report('checking the engine')
          const ctl = await requireController(context_)
          report('loading the pack')
          await reportPackContents(ctl, packRoot)
          report('building the graph')
          const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
          const panel = GraphPanel.show(
            context_.extensionUri,
            ctl,
            packRoot,
            timeoutMs,
            // The node id rides along: previewing a node from the graph is the one gesture that
            // also asks the preview to highlight that node's own blocks -- and, per
            // previewPanel.ts's header, the ONLY thing that ever makes a preview ask the engine
            // for a profile.
            (document, attributeNodeId) => {
              const live = getController(context_)
              if (live !== null) openOrRevealPreview(context_, live, document, attributeNodeId)
            },
            (absPath) => notifyPreviewsOfWrite(absPath),
          )
          // Cancel on the notification stops the engine's graph build. The panel owns the
          // request -- the WEBVIEW is what asks for a graph, on its own `requestGraph` message --
          // so the signal is handed to the panel rather than passed down the call.
          signal.addEventListener('abort', () => panel.cancelGraph(), { once: true })
          let summary
          try {
            summary = await panel.whenFirstGraph()
          } catch (err) {
            if (err instanceof RequestCancelledError) {
              // Cancelled on purpose. The canvas says so itself (see graphCancelledMessage) and
              // offers Retry; a notification calling it a failure would contradict the panel.
              return
            }
            // The panel says this on its own canvas as well (see graph/emptyState.ts). Said here
            // too, because the command is what the user ran and a notification is what they are
            // waiting for -- and because a panel whose script never loaded cannot say anything.
            // The panel is still open and still has a pack root, so this failure is one the user
            // can act on without reloading the window -- which is what "Retry" is for. The same
            // recovery is on the panel itself (the webview's Retry button posts `retry`) and in
            // the palette as "Feature Lab: Retry Loading the Feature Graph"; a notification is
            // simply where the user already is at the moment it fails.
            throw new CommandFailure(
              `Feature Lab: the feature graph for ${packRoot} could not be built.`,
              `Graph for ${packRoot} failed: ${describeError(err)}`,
              retryGraphAction,
            )
          }
          log(
            `Open Feature Graph: drew ${String(summary.nodes)} node(s) and ${String(summary.diagnostics)} diagnostic(s) ` +
              `for ${summary.packRoot}, ${String(summary.brokenFiles)} file(s) the engine could not read`,
          )
        },
        // Cancel reaches the engine: it sends a `cancel` for the in-flight graph request, the
        // build stops, and the panel says so on its own canvas with a Retry button. The panel
        // stays open either way.
        { cancellable: true },
      ),
    ),
  )

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      // A graph panel showing this pack redraws from the saved file. The JSON is the source of
      // truth, so an edit made in a text editor is as real as one made in the panel, and a
      // graph that quietly disagreed with what someone just saved would be worse than none.
      for (const panel of GraphPanel.openPanels()) {
        if (panel.showsFile(document.uri.fsPath)) void panel.notifyFileSaved(document.uri.fsPath)
      }
      // Every open panel, not just the one previewing the saved document: a save anywhere in a
      // pack the engine loaded invalidates that pack's Workspace, and each panel knows its own
      // pack root -- see PreviewPanel.notifyPackFileSaved's doc comment for the stale-preview
      // bug the old previewed-document-only wiring caused. Concurrent reloads for panels
      // sharing a pack coalesce in PreviewController.
      for (const panel of panelsByUri.values()) panel.notifyPackFileSaved(document)
    }),
  )

  // Pre-warm: the measured cost of the FIRST preview was almost entirely the engine's initial
  // loadPack (~730ms on a 3.5k-feature pack with a warm FS cache; the generate itself is
  // ~10ms), paid at the moment the user invoked the command. But the command requires the
  // feature file to already be the active editor -- so the pack root is knowable, and the load
  // startable, the moment such a file becomes active, seconds before the user typically asks
  // for a preview. By then ensurePackLoaded is a no-op (or the command's own generate rides the
  // in-flight load -- see PreviewController.inflightLoads).
  maybePrewarm(context, vscode.window.activeTextEditor?.document)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => maybePrewarm(context, editor?.document)),
  )

  // Ctrl+click / F12 on a feature reference jumps to the file declaring that identifier.
  // Registration is cheap; the provider's workspace index builds lazily on the first actual
  // definition request (see FeatureDefinitionProvider's own doc comments), never at activation.
  // Both json and jsonc: Bedrock pack JSON commonly carries comments, and users map it to
  // jsonc via files.associations.
  const definitionProvider = new FeatureDefinitionProvider()
  context.subscriptions.push(
    definitionProvider,
    vscode.languages.registerDefinitionProvider(
      PACK_LANGUAGE_IDS.map((language) => ({ language, scheme: 'file' })),
      definitionProvider,
    ),
  )
}

/** Runs one command body behind a single progress notification, and guarantees it ends in
 * WORDS: a result, a cancellation noted in the log, or a `fail()` with a short sentence and a
 * button to the log.
 *
 * The one funnel both commands go through, because the failure this whole file was rewritten
 * for was a command body throwing past its handler. An unexpected exception is caught here and
 * reported as itself rather than as VS Code's own "Running the contributed command ... failed",
 * which names the command and nothing about the cause. */
async function runCommand(
  step: string,
  body: (context: vscode.ExtensionContext, report: (message: string) => void, signal: AbortSignal) => Promise<void>,
  options: { cancellable?: boolean } = {},
): Promise<void> {
  const context = activeContext
  if (context === undefined) {
    await fail('Feature Lab: the extension is not ready yet. Try again in a moment.', 'A command ran before activate() finished.')
    return
  }
  try {
    await runWithProgress(step, (report, signal) => body(context, report, signal), options)
  } catch (err) {
    if (err instanceof CancelledError) {
      // Not a failure and not silent: the log records it, the engine was told to stop (see
      // progress.ts's raceCancellation), and the panel -- if one opened -- says on its own face
      // that it was cancelled rather than sitting on a spinner.
      log(`${step}: stopped at the user's request.`)
      return
    }
    if (err instanceof CommandFailure) {
      await fail(err.userMessage, err.detail, err.action)
      return
    }
    await fail(
      `Feature Lab: ${step} failed unexpectedly.`,
      `Unhandled error while ${step}: ${describeError(err)}\n${err instanceof Error ? (err.stack ?? '') : ''}`,
    )
  }
}

/** Keeps the `featurelab.graphOpen` context key in step with the open panels.
 *
 * Optional-called because `executeCommand` is the one piece of the API a stubbed activation test
 * has no reason to fake, and a context key is a hint to the palette rather than anything the
 * extension's behaviour depends on. */
function setGraphOpenContext(open: boolean): void {
  void vscode.commands.executeCommand?.('setContext', 'featurelab.graphOpen', open)
}

/** Keeps `featurelab.graphTyping` in step with whether the author's keyboard is in a text control
 * inside a graph panel.
 *
 * THE POINT OF THE KEY. package.json binds Ctrl+Z to `featurelab.undo` while the graph panel is
 * the active one, and VS Code's webview shim forwards undo and redo to the workbench after
 * calling preventDefault on them -- so Ctrl+Z halfway through typing a Molang expression did not
 * undo the typing, it reverted the last write to the pack. The binding's `when` cannot see inside
 * the iframe, so the panel reports focus (a `typingFocus` message) and this turns it into
 * something a `when` clause can negate.
 *
 * Optional-called for the same reason as setGraphOpenContext: `executeCommand` is the one piece
 * of the API a stubbed activation test has no reason to fake. */
function setGraphTypingContext(typing: boolean): void {
  void vscode.commands.executeCommand?.('setContext', 'featurelab.graphTyping', typing)
}

/** Undo and Redo: the same shape, differing only in which way they move.
 *
 * Separate from runCommand's ordinary path in one respect, and it is the point of the whole
 * feature: a REFUSAL is not a failure of the command. "The file changed underneath" means the
 * journal did exactly its job and wrote nothing, so it is reported as its own sentence, with the
 * log button every other message has, rather than as "undoing the last change failed unexpectedly".
 */
async function runHistoryCommand(
  what: 'undo' | 'redo',
  act: (panel: GraphPanel) => Promise<{ label: string }>,
): Promise<void> {
  const panel = GraphPanel.activePanel()
  if (panel === null) {
    await warn(
      `Feature Lab: there is no feature graph open to ${what} in.`,
      `featurelab.${what} ran with no open graph panel.`,
    )
    return
  }
  const pending = what === 'undo' ? panel.pendingUndoLabel() : panel.pendingRedoLabel()
  await runCommand(what === 'undo' ? 'undoing the last change' : 'redoing the last change', async () => {
    try {
      const entry = await act(panel)
      log(`${what === 'undo' ? 'Undid' : 'Redid'} "${entry.label}" in ${panel.pack}.`)
    } catch (err) {
      if (err instanceof UndoRefused) {
        // AN EMPTY HISTORY IS NOT A FAILED COMMAND. Ctrl+Z over a panel that has written nothing
        // used to raise an error notification with a Show log button -- the full apparatus of
        // something having gone wrong, for a key press that asked for nothing and got it. The
        // toolbar has already said so, in this same sentence, in the tooltip of an Undo button
        // that is marked unavailable; the panel says it again on its own status line (see
        // GraphPanel.historyStep). A third telling, and the loudest of the three, is what teaches
        // people to stop reading this editor's notifications. It goes to the log and stops there.
        if (err.empty) {
          log(`${what} in ${panel.pack}: ${err.message}`)
          return
        }
        // The journal's own sentence, unaltered. It names the file and says nothing was written,
        // which is the whole of what somebody needs; a paraphrase here would be a second place to
        // keep that wording right.
        throw new CommandFailure(
          `Feature Lab: ${err.message}`,
          `${what} refused in ${panel.pack}${pending === null ? '' : ` (pending: ${pending})`}: ${err.message}`,
        )
      }
      throw err
    }
  })
}

/** The active editor, or a phrased refusal. */
function requireEditor(message: string): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) {
    throw new CommandFailure(message, 'There is no active text editor, so there is no file to work out a pack from.')
  }
  return editor
}

/** The pack root for `filePath`, or a phrased refusal naming the file.
 *
 * resolvePackRoot THROWS for a file outside a pack -- see this file's header for what happened
 * when that was treated as a null return. */
function requirePackRoot(filePath: string): string {
  try {
    const packRoot = resolvePackRoot(filePath)
    log(`Pack root: ${packRoot}`)
    return packRoot
  } catch (err) {
    const detail = err instanceof PackRootError ? err.message : describeError(err)
    throw new CommandFailure(`Feature Lab: "${filePath}" is not inside a behaviour pack, so there is nothing to open.`, detail)
  }
}

/** The pack the FEATURE GRAPH should be opened on, from the editor if there is one and from the
 * window's own folders if there is not.
 *
 * THE NO-EDITOR CASE IS THE POINT, and it is the other half of the report that "Feature Lab"
 * offered nothing but "Show Log". Somebody who opens a pack folder has, at that moment, no editor
 * at all -- and the graph is a property of the PACK, not of any one file, so there was never
 * anything an open file was needed FOR here. It only ever read one to find the pack root, which
 * the folder answers just as well.
 *
 * The preview command is genuinely different and deliberately still asks for an editor: a preview
 * is of one feature, and no folder can say which. */
function requireGraphPackRoot(): string {
  const editor = vscode.window.activeTextEditor
  if (editor !== undefined) {
    log(`Open Feature Graph: asked about ${editor.document.uri.fsPath}`)
    return requirePackRoot(editor.document.uri.fsPath)
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
  const candidates = workspacePackRoots(folders)
  const packRoot = candidates[0]
  if (packRoot === undefined) {
    throw new CommandFailure(
      folders.length === 0
        ? 'Feature Lab: open your behaviour pack folder (or a file from it) first, then run this command.'
        : `Feature Lab: no behaviour pack was found in ${folders.join(', ')}. Open the pack folder itself -- the one with a manifest.json or a features/ directory in it.`,
      `Open Feature Graph ran with no editor open and found no pack among: ${folders.join(', ') || '(no folder open)'}`,
    )
  }
  if (candidates.length > 1) {
    // Named rather than chosen silently: the panel's own header shows which pack it drew, so a
    // window holding two packs is recoverable by opening a file from the other one, and the log
    // says what the alternatives were.
    log(`Open Feature Graph: this window holds ${String(candidates.length)} packs (${candidates.join(', ')}).`)
  }
  log(`Open Feature Graph: no editor is open, so the graph is for the pack this window holds: ${packRoot}`)
  return packRoot
}

/** Every behaviour pack among `folders` -- each folder itself, and failing that its immediate
 * subdirectories.
 *
 * One level down and no further, because that is the shape people actually have: a repository with
 * `BP/` and `RP/` side by side is the common layout the extension's own README warns about ("open
 * the pack folder itself, not the parent"), and recursing further would turn opening a monorepo
 * into a filesystem walk. */
function workspacePackRoots(folders: readonly string[]): string[] {
  const found: string[] = []
  const add = (root: string | null): void => {
    if (root !== null && !found.includes(root)) found.push(root)
  }
  for (const folder of folders) {
    const direct = packRootOf(folder)
    if (direct !== null) {
      add(direct)
      continue
    }
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (child.isDirectory()) add(packRootOf(path.join(folder, child.name)))
    }
  }
  return found
}

/** `dir` itself, if `dir` is a pack root -- null otherwise.
 *
 * resolvePackRoot answers for a FILE and walks upwards, so it is asked about a notional file in
 * `dir` and its answer is only accepted when it IS `dir`. Without that equality a folder opened
 * anywhere beneath a pack would claim that pack, and a folder opened beside one would claim its
 * neighbour's -- both of which are a graph of something the user did not point at. */
function packRootOf(dir: string): string | null {
  try {
    return resolvePackRoot(path.join(dir, 'manifest.json')) === dir ? dir : null
  } catch {
    return null
  }
}

/** A controller whose engine binary has been resolved AND shown to run, or a phrased refusal
 * naming the path that was tried. */
async function requireController(context: vscode.ExtensionContext): Promise<PreviewController> {
  let resolved: ResolvedBinary
  try {
    resolved = resolveEngineBinary(context)
  } catch (err) {
    if (err instanceof BinaryNotFoundError) {
      throw new CommandFailure(`Feature Lab: the engine executable is missing at ${err.triedPath}.`, err.detail)
    }
    throw new CommandFailure('Feature Lab: the engine executable could not be resolved.', describeError(err))
  }
  const binaryPath = resolved.path
  log(`Engine binary: ${binaryPath} (${resolved.source === 'setting' ? 'featurelab.binaryPath' : 'bundled with this extension'})`)
  const probe = await probeEngine(binaryPath)
  log(probe.detail)
  if (!probe.ok) {
    throw new CommandFailure(
      `Feature Lab: the engine at ${binaryPath} would not run. Set "featurelab.binaryPath" to a working featurelab executable.`,
      probe.detail,
    )
  }
  reportEngineFreshness(context, probe, resolved)
  return controllerFor(binaryPath)
}

/** Every bundled engine already reported as not being the one this extension shipped, so the
 * notification is put once per path rather than once per command. */
const staleEnginesReported = new Set<string>()

/** Forgets which stale engines have been reported. Called by tests; nothing in the product needs
 * it -- a window's answer to this question does not change while it is open. */
export function forgetStaleEngineReports(): void {
  staleEnginesReported.clear()
}

/** Says so when the engine in bin/ is not the one this extension shipped with.
 *
 * WHY IT EXISTS. bin/ is picked by `process.platform` alone, and a checkout opened on two kinds
 * of host builds two differently-spelled binaries into the same directory -- so a Remote-WSL
 * window would pick up whatever an old Linux build left behind, run it, and say nothing. Every
 * symptom after that is a missing engine feature reported as a broken editor.
 *
 * A NOTIFICATION, NOT A REFUSAL, and only for a BUNDLED engine: see bundledEngineFreshness for
 * both rules and for what "too old" is defined to mean. A `featurelab.binaryPath` pointing at an
 * older build is the documented purpose of the setting and is never questioned here. */
function reportEngineFreshness(context: vscode.ExtensionContext, probe: EngineProbe, resolved: ResolvedBinary): void {
  if (resolved.source !== 'bundled') return
  const freshness = bundledEngineFreshness(probe, extensionVersion(context))
  if (!freshness.stale) return
  // The sibling note is only ever extra context on a binary already found wanting -- there is
  // nothing to report about a bin/ with two spellings in it while the one in use is current.
  const sibling = staleSiblingNote(resolved.path)
  const detail = sibling === null ? freshness.detail : `${freshness.detail}\n${sibling}`
  log(detail)
  if (staleEnginesReported.has(resolved.path)) return
  staleEnginesReported.add(resolved.path)
  void warn(
    `Feature Lab: the bundled engine at ${resolved.path} is not the one this extension shipped with, so some features may be missing. It is being used anyway.`,
    detail,
  )
}

/** Loads the pack (or confirms it is loaded) and writes what it contains to the log, so that a
 * pack with nothing in it is a recorded fact rather than an empty panel.
 *
 * Deliberately NOT a refusal. A pack with no features is a real state somebody is working
 * towards -- a new pack, a pack whose files all failed to load -- and the place to say so is the
 * panel they asked for, in words, next to what it does contain. Refusing to open it would take
 * away the one view that shows the load diagnostics explaining why it is empty. */
async function reportPackContents(ctl: PreviewController, packRoot: string): Promise<LoadPackResult> {
  const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
  let summary: LoadPackResult
  try {
    summary = await ctl.loadPackSummary(packRoot, timeoutMs)
  } catch (err) {
    throw new CommandFailure(`Feature Lab: the pack at ${packRoot} could not be loaded.`, `loadPack failed: ${describeError(err)}`)
  }
  // LOADED AGAINST READ, always both. These four numbers used to mean "files found on disk" and
  // now mean "items that actually built"; printing only the first half again would restore, in the
  // log, exactly the reassurance that made a truncated feature file invisible. See
  // packContents.ts's describeFilesLoaded for why the word is "of".
  log(`Pack loaded: ${describePackContents(summary)}`)
  for (const warning of summary.warnings ?? []) log(`  pack warning: ${warning}`)
  for (const d of brokenFiles(summary.diagnostics)) log(`  could not read ${diagnosticLocation(d)}: ${d.message}`)
  // A file the engine refused is not a smaller pack, it is a pack missing something the author
  // wrote and can still see in their own editor. It is worth interrupting them over exactly once,
  // here, before the panel opens -- the panel says it too, and the log has the list, but neither
  // is where somebody is looking at the moment they run the command.
  const broken = describeBrokenFiles(summary.diagnostics)
  if (broken !== null) {
    void warn(
      `Feature Lab: ${broken} What they define is missing from the graph and from previews.`,
      `Pack at ${packRoot}: ${broken}`,
    )
  }
  if (summary.featureCount === 0 && summary.ruleCount === 0) {
    log(`Pack at ${packRoot} declares no features and no feature rules. The panel will say so.`)
  }
  return summary
}

/** Kicks off a background pack load for `document`'s pack iff the document is plausibly a
 * previewable feature/rule file.
 *
 * Nothing here is shown to the user, because at "the user merely focused a JSON file" time none
 * of it is actionable -- the SAME failures surface loudly, with better context, if and when the
 * user actually invokes a command. But nothing here is SILENT either any more: every reason a
 * pre-warm gave up goes to the log, which is the difference between "the extension did nothing"
 * and "the extension decided not to, and here is why". */
function maybePrewarm(context: vscode.ExtensionContext, document: vscode.TextDocument | undefined): void {
  if (!document || document.uri.scheme !== 'file') return
  // The three language ids a pack's JSON realistically arrives under. A Bedrock pack routinely
  // carries comments, and "files.associations" mapping *.json to jsonc -- or a .json5 file -- is
  // common enough that an extension which only knows "json" appears, to those users, not to exist.
  if (!PACK_LANGUAGE_IDS.includes(document.languageId)) return
  const text = document.getText()
  // Feature files are a few KB; a megabyte-plus JSON (package-lock and friends) is never one,
  // and not worth a JSON.parse on every editor focus just to prove it.
  if (text.length > 1_000_000) return
  let packRoot: string
  try {
    parseDocumentIdentifier(text)
    packRoot = resolvePackRoot(document.uri.fsPath)
  } catch (err) {
    // Not a feature/rule file, or not in a pack. Ordinary; one line, at the level of detail
    // somebody reading the log after a command misbehaved would want.
    if (err instanceof DocumentParseError || err instanceof PackRootError) {
      log(`Pre-warm skipped for ${document.uri.fsPath}: ${err.message}`)
    } else {
      log(`Pre-warm skipped for ${document.uri.fsPath}: ${describeError(err)}`)
    }
    return
  }
  let ctl: PreviewController
  try {
    ctl = controllerFor(resolveBinaryPath(context))
  } catch (err) {
    log(`Pre-warm skipped for ${packRoot}: ${describeError(err)}`)
    return
  }
  const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
  void ctl.ensurePackLoaded(packRoot, timeoutMs).then(
    () => log(`Pre-warm: ${packRoot} is loaded.`),
    (err: unknown) => log(`Pre-warm of ${packRoot} failed (the command will report this properly if you run one): ${describeError(err)}`),
  )
}

/** The one controller for this session, rebuilt if the resolved binary path has changed.
 *
 * The rebuild is not theoretical: `featurelab.binaryPath` is the setting a developer edits to
 * point at a locally built engine, and a controller cached for the session held the old path
 * until the window was reloaded -- so changing the setting appeared to do nothing. */
function controllerFor(binaryPath: string): PreviewController {
  if (controller !== undefined && controller.binaryPath === binaryPath) return controller
  const replaced = controller
  if (replaced !== undefined) {
    log(`Engine binary changed to ${binaryPath}; restarting the engine.`)
    replaced.dispose()
  }
  // The engine's own stderr goes STRAIGHT to the log, as it arrives and unaltered. It is the
  // only direct evidence there is about why the engine refused something, it is far longer than
  // any notification can carry, and until this was wired it was collected into a buffer that was
  // read only if the process died -- so an engine that complained loudly and then went on
  // working said its piece to nobody.
  controller = new PreviewController(
    binaryPath,
    (text) => logVerbatim('engine', text),
    // The engine's own progress, onto whatever notification is up -- see progress.ts's
    // reportEngineProgress. Until this was wired, every progress line the engine wrote was
    // discarded by the protocol client and a 45-second pack load showed one sentence that never
    // changed.
    (note) => reportEngineProgress(note),
  )
  // A PANEL CANNOT CHANGE ENGINES. It captured its controller at construction and nothing
  // re-binds it, so every panel still holding the one just disposed is now showing a preview of
  // the OLD binary's work -- and used to go on producing more of it, because dispose() was
  // undoable by accident (see EngineDisposedError). The tombstone makes the next request fail
  // properly; this makes the panels say so NOW, which is while the user is looking at the
  // setting they just changed rather than several minutes later. Each panel checks its own
  // controller, so one already holding the NEW one is untouched.
  if (replaced !== undefined) {
    for (const panel of panelsByUri.values()) panel.notifyEngineDisposed()
  }
  return controller
}

/** Non-throwing controller resolution for the paths that are not a command -- the graph asking
 * for a preview, where the engine has already been checked once. Returns null having logged. */
function getController(context: vscode.ExtensionContext): PreviewController | null {
  try {
    return controllerFor(resolveBinaryPath(context))
  } catch (err) {
    void fail('Feature Lab: the engine executable is missing.', describeError(err))
    return null
  }
}

/** Opens (or reveals) the preview for `document`.
 *
 * `attributeNodeId` is set only by the graph panel, and is the whole of this extension's
 * write-attribution wiring: it puts the preview into attribution mode for that node, which is
 * what makes it highlight that node's blocks and, from then on, answer "what placed this block"
 * for a click in the 3D view. Absent for the preview COMMAND, the keybinding and every
 * save-triggered regenerate -- so a preview opened any other way behaves exactly as it always
 * has and never asks the engine for a profile. See previewPanel.ts's own header. */
function openOrRevealPreview(
  context: vscode.ExtensionContext,
  ctl: PreviewController,
  document: vscode.TextDocument,
  attributeNodeId?: string,
): PreviewPanel {
  const key = document.uri.toString()
  const existing = panelsByUri.get(key)
  if (existing) {
    existing.reveal()
    existing.notifyDocumentChanged(document)
    if (attributeNodeId !== undefined) {
      existing.attributeNode(attributeNodeId)
      graphDrivenPanel = existing
    }
    return existing
  }
  // A preview the GRAPH drives follows the selection: one panel, re-pointed, rather than one per
  // node. Previews are keyed by document and every node is a different file, so without this,
  // clicking through a pack opened a preview per node -- and each new one appeared wherever the
  // default put it, which is how a preview the author had dragged into its own window was
  // apparently replaced by a fresh one back in the main window.
  //
  // Only for the graph: a preview opened by the command or the keybinding is ABOUT the file the
  // author named, so re-pointing one of those at something else would take away the thing they
  // asked to look at.
  if (attributeNodeId !== undefined && graphDrivenPanel !== null) {
    const reused = graphDrivenPanel
    for (const [k, v] of panelsByUri) {
      if (v === reused) panelsByUri.delete(k)
    }
    panelsByUri.set(key, reused)
    reused.reveal()
    reused.retargetTo(document)
    reused.attributeNode(attributeNodeId)
    return reused
  }
  const panel = new PreviewPanel(
    context,
    ctl,
    diagnosticCollection,
    document,
    previewDisposed,
    undefined,
    // Handed to the constructor rather than set right after it, so a preview opened FROM the
    // graph asks for its profile on its very first run instead of paying for an unprofiled one
    // and immediately repeating it. attributeNode() above is for a panel that already exists.
    graphLink(attributeNodeId ?? null),
  )
  panelsByUri.set(key, panel)
  return panel
}

/** The two return legs from a preview to the graph, as one object both entry points build.
 *
 * ONE BUILDER, because there are two ways a preview panel comes into existence -- the command/
 * graph route above, and VS Code reviving a tab after a window reload -- and for as long as only
 * the first of them built a link, a window reload SEVERED THE PAIR. A revived preview posted no
 * `runStats` at all (measured: 2 from an opened panel, 0 from a revived one), so the graph's
 * cards sat wearing whatever the last window had measured, or nothing; and closing one told the
 * graph nothing, so "Preview on select" stayed armed and re-opened the panel the author had just
 * closed, which is the exact complaint previewClosed() was added for.
 *
 * Both legs fan out over the OPEN graph panels rather than being remembered per preview, because
 * the graph an answer belongs in is decided by the PACK, and either panel can be closed and
 * reopened while the other stays put. That is also why a revived preview can be wired to a graph
 * it has never heard of: it does not name one.
 *
 * `attributeNodeId` is null for a revived panel, and that is not an omission. Attribution mode is
 * something the graph asks for by selecting a node; nothing selected it during a window reload,
 * and turning it on unasked would make a restored tab request a profiled run nobody wants to pay
 * for. The link is live either way -- the moment the author clicks a node, attributeNode() arms
 * it and the stats start flowing. */
function graphLink(attributeNodeId: string | null): GraphLink {
  return {
    attributeNodeId,
    onSelectNodes: (packRoot, nodeIds) => {
      for (const graph of GraphPanel.openPanels()) {
        if (graph.showsPack(packRoot)) graph.selectNodes(nodeIds)
      }
    },
    onRunStats: (packRoot, stats) => {
      for (const graph of GraphPanel.openPanels()) {
        if (graph.showsPack(packRoot)) graph.showRunStats(stats)
      }
    },
  }
}

/** What happens when any preview panel closes, whoever opened it -- see graphLink for why a
 * revived panel gets exactly the same treatment as one the command opened. */
function previewDisposed(disposed: PreviewPanel): void {
  for (const [k, v] of panelsByUri) {
    if (v === disposed) panelsByUri.delete(k)
  }
  if (graphDrivenPanel === disposed) {
    graphDrivenPanel = null
    // Closing the preview is an answer: the author is done looking. Without telling the
    // graph, "Preview on select" stayed on and every subsequent click opened the panel they
    // had just shut -- reported as "nawet po zamknięciu podglądu on wciąż wraca".
    for (const graph of GraphPanel.openPanels()) graph.previewClosed()
  }
}

/** How long a burst of pack writes is allowed to keep arriving before the previews are told about
 * it.
 *
 * The SAME 350ms the preview panel's own text inputs already debounce on, and for the same
 * reason: an author dragging a slider or typing in a form is producing one intention, not one per
 * event. Every edit made in the node editor is a real write to disk, and each one used to reload
 * the pack and regenerate every open preview -- serialised, so they could not race, but not
 * collapsed, so ten quick edits were ten full regenerations and the author watched nine answers
 * they had already moved past go by before the one they were waiting for.
 *
 * Short enough that a single edit still feels immediate, long enough that a burst is one run. */
const PACK_WRITE_DEBOUNCE_MS = 350

/** Paths written since the last flush, oldest first, deduplicated when the burst is drained. */
let pendingPackWrites: string[] = []
let packWriteTimer: ReturnType<typeof setTimeout> | null = null

/** Tells every open preview that a pack file changed underneath it -- collapsing a burst of them
 * into one notification.
 *
 * The preview reloads on `onDidSaveTextDocument`, and an edit made in the graph panel never fires
 * one: the engine writes the file directly, so as far as VS Code is concerned nothing was saved.
 * Without this the preview goes on showing the pack as it was before the edit, with nothing on
 * screen to suggest it is out of date -- which is worse than showing nothing.
 */
function notifyPreviewsOfWrite(absPath: string): void {
  pendingPackWrites.push(absPath)
  // Restarted, not extended: a burst ends when the writes stop, and an author holding a key down
  // should get one run afterwards rather than one every 350ms while they are still typing.
  if (packWriteTimer !== null) clearTimeout(packWriteTimer)
  packWriteTimer = setTimeout(() => {
    packWriteTimer = null
    void flushPackWrites()
  }, PACK_WRITE_DEBOUNCE_MS)
  // Node keeps the process alive for a pending timer, which matters for the tests that drive
  // this outside an extension host.
  packWriteTimer.unref?.()
}

/** Hands one burst of writes to every open preview, as one burst.
 *
 * The documents are OPENED but not shown, which is what makes VS Code re-read a file it may
 * already have in memory -- a preview whose OWN file is in the burst has to end up holding the
 * new bytes. A path that is no longer a document (a feature that was just deleted, most likely)
 * is logged and dropped from the document list; its PATH still goes over, because "this file is
 * gone" invalidates the loaded pack every bit as much as a rewrite does. */
async function flushPackWrites(): Promise<void> {
  const paths = [...new Set(pendingPackWrites)]
  pendingPackWrites = []
  if (paths.length === 0 || panelsByUri.size === 0) return
  if (paths.length > 1) log(`${String(paths.length)} pack writes collapsed into one preview refresh.`)
  const documents: vscode.TextDocument[] = []
  for (const absPath of paths) {
    try {
      documents.push(await vscode.workspace.openTextDocument(absPath))
    } catch (err) {
      // Worth a line: a preview that stopped updating after an edit is exactly the kind of thing
      // somebody comes to the log about.
      log(`Could not re-read ${absPath} for the open previews: ${describeError(err)}`)
    }
  }
  for (const panel of panelsByUri.values()) panel.notifyPackFilesWritten(documents, paths)
}

/** Brings both panels back after a window reload.
 *
 * WITHOUT THIS, closing a window threw away everything about where the author was: a reopened
 * window had no graph and no preview, and even reopening them by hand started from the default
 * camera, no selection, no search, no seed. VS Code's own mechanism for this is a serializer --
 * it recreates the TAB, in the group the author had put it in, and hands back whatever the
 * webview saved with `setState`; the extension supplies everything behind it.
 *
 * WHICH pack, or which document, a revived tab was showing is the one thing the host cannot know
 * on its own: VS Code hands over the webview's state and nothing else. So both webviews are asked
 * to write the `key` they were given (the `restoreState` message -- see GraphPanel.postRestoreState
 * and PreviewPanel.postRestoreState) into their own `setState` blob, and that key is what is read
 * back here. A tab whose state carries no key cannot be restored to anything, so it is closed
 * rather than left as an empty panel pretending to be a graph.
 *
 * Registration is guarded because the two test stubs for `vscode.window` do not fake it and have
 * no need to: nothing in a unit test reloads a window. */
function registerPanelSerializers(context: vscode.ExtensionContext): void {
  const register = vscode.window.registerWebviewPanelSerializer as
    | ((viewType: string, serializer: vscode.WebviewPanelSerializer) => vscode.Disposable)
    | undefined
  if (typeof register !== 'function') return
  context.subscriptions.push(
    register(GraphPanel.VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => {
        reviveGraphPanel(context, panel, state)
        return Promise.resolve()
      },
    }),
    register(PreviewPanel.VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        await revivePreviewPanel(context, panel, state)
      },
    }),
  )
}

/** The key a webview wrote into its own saved state, or null when it saved none. Everything about
 * a webview's state is untrusted: it is written by the least privileged half of the pair, it
 * survives an extension update, and it is a plain string on disk. So it is shape-checked here and
 * then validated by whatever it names -- a pack root that no longer exists simply fails to load,
 * with the panel saying so, which is the same thing that happens to a pack deleted while open. */
function reviveKey(state: unknown): string | null {
  const key = (state as { key?: unknown } | null | undefined)?.key
  return typeof key === 'string' && key.length > 0 ? key : null
}

function reviveGraphPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, state: unknown): void {
  const packRoot = reviveKey(state)
  if (packRoot === null) {
    log('A feature graph panel was restored with no pack in its saved state, so it cannot be brought back.')
    panel.dispose()
    return
  }
  const ctl = getController(context)
  if (ctl === null) {
    panel.dispose()
    return
  }
  const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
  log(`Restoring the feature graph for ${packRoot} after a window reload.`)
  GraphPanel.revive(
    panel,
    context.extensionUri,
    ctl,
    packRoot,
    timeoutMs,
    (document, attributeNodeId) => {
      const live = getController(context)
      if (live !== null) openOrRevealPreview(context, live, document, attributeNodeId)
    },
    (absPath) => notifyPreviewsOfWrite(absPath),
  )
}

async function revivePreviewPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, state: unknown): Promise<void> {
  const uri = reviveKey(state)
  if (uri === null) {
    log('A preview panel was restored with no document in its saved state, so it cannot be brought back.')
    panel.dispose()
    return
  }
  const ctl = getController(context)
  if (ctl === null) {
    panel.dispose()
    return
  }
  let document: vscode.TextDocument
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
  } catch (err) {
    // The file went away between the two windows. Nothing to preview and nothing the author can
    // do from inside the panel, so the tab goes rather than becoming a permanent error.
    log(`A preview panel was restored for ${uri}, which cannot be opened: ${describeError(err)}`)
    panel.dispose()
    return
  }
  const key = document.uri.toString()
  if (panelsByUri.has(key)) {
    panel.dispose()
    return
  }
  // What this panel was last generating -- the seed, the origin, the repeat count, the preset and
  // the sizes are all fields of it. Read here rather than inside the panel because a panel that
  // somebody OPENS must not inherit them: the whole point of the file-derived fallback is that a
  // fresh preview is about the file it was opened on.
  const remembered = context.workspaceState.get<RememberedPreviewParams>(previewParamsKey(key), {})
  // CHECKED, not replayed. See freshPreviewParams for the whole of the freshness decision and
  // what it deliberately does not check.
  const fresh = freshPreviewParams(remembered, currentIdentifierOf(document))
  if (fresh.params === null && remembered?.params) {
    log(`The remembered preview settings for ${document.uri.fsPath} no longer apply, so it comes back previewing the file itself.`)
  }
  const revived: RevivedPreview = { panel, params: fresh.params, grown: fresh.grown }
  log(`Restoring the preview of ${document.uri.fsPath} after a window reload.`)
  const restored = new PreviewPanel(
    context,
    ctl,
    diagnosticCollection,
    document,
    // The SAME disposal and the SAME graph link a command-opened preview gets -- see graphLink
    // for the window reload that used to sever the two panels.
    previewDisposed,
    undefined,
    graphLink(null),
    revived,
  )
  panelsByUri.set(key, restored)
}

/** The identifier a document declares right now, or null when it does not parse -- which a file
 * mid-edit legitimately does not. */
function currentIdentifierOf(document: vscode.TextDocument): string | null {
  try {
    return parseDocumentIdentifier(document.getText()).identifier
  } catch {
    return null
  }
}

export function deactivate(): void {
  onGraphPanelCountChanged(null)
  onGraphTypingChanged(null)
  setGraphPanelState(null)
  // A burst that had not flushed yet is dropped rather than firing into disposed panels.
  if (packWriteTimer !== null) clearTimeout(packWriteTimer)
  packWriteTimer = null
  pendingPackWrites = []
  setGraphOpenContext(false)
  // Last, so a window whose extension is being torn down mid-edit does not leave the workbench
  // holding `graphTyping: true` -- which would disable Ctrl+Z for whatever comes back.
  setGraphTypingContext(false)
  for (const panel of panelsByUri.values()) panel.dispose()
  panelsByUri.clear()
  controller?.dispose()
  controller = undefined
  activeContext = undefined
  disposeProgress()
  disposeLog()
}
