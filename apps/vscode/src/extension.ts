// extension.ts -- activation entry point. Wires: the "Feature Lab: Preview Feature" command,
// a save listener that reloads-and-regenerates every open preview whose pack the saved file
// belongs to, a background pack pre-warm keyed on the active editor (see maybePrewarm),
// go-to-definition for feature references (featureDefinitionProvider.ts), and a single
// PreviewController (one live engine process) shared across every preview panel for this
// extension session ("load the pack once and keep the process alive across regenerations;
// do not restart the binary per save").
import * as vscode from 'vscode'
import { BinaryNotFoundError, resolveBinaryPath } from './binaryResolver.js'
import { PreviewController } from './previewController.js'
import { PreviewPanel } from './previewPanel.js'
import { createDiagnosticCollection } from './diagnostics.js'
import { parseDocumentIdentifier, resolvePackRoot } from './identifier.js'
import { FeatureDefinitionProvider } from './featureDefinitionProvider.js'
import { GraphPanel } from './graphPanel.js'

let controller: PreviewController | undefined
const panelsByUri = new Map<string, PreviewPanel>()
/** The preview the GRAPH is driving, if any.
 *
 * Held separately from panelsByUri because that map is keyed by document and this panel's
 * document changes every time the author selects another node. Cleared when the panel closes, so
 * a preview that has been shut is not silently revived -- see the dispose callback. */
let graphDrivenPanel: PreviewPanel | null = null
let diagnosticCollection: vscode.DiagnosticCollection

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = createDiagnosticCollection()
  context.subscriptions.push(diagnosticCollection)

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.previewFeature', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        void vscode.window.showErrorMessage('Feature Lab: open a feature JSON file first.')
        return
      }
      openOrRevealPreview(context, editor.document)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('featurelab.openGraph', () => {
      // The graph is a property of the PACK, not of one file, so it is resolved from whatever
      // document is in front of the user rather than being about that document. Opening it
      // from a feature file and from a feature rule in the same pack must reach one panel.
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        void vscode.window.showErrorMessage('Feature Lab: open a file inside the pack first.')
        return
      }
      const packRoot = resolvePackRoot(editor.document.uri.fsPath)
      if (!packRoot) {
        void vscode.window.showErrorMessage(
          'Feature Lab: this file is not inside a behaviour pack -- no manifest.json was found above it.',
        )
        return
      }
      const ctl = getController(context)
      if (!ctl) return
      const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
      GraphPanel.show(
        context.extensionUri,
        ctl,
        packRoot,
        timeoutMs,
        // The node id rides along: previewing a node from the graph is the one gesture that also
        // asks the preview to highlight that node's own blocks -- and, per previewPanel.ts's
        // header, the ONLY thing that ever makes a preview ask the engine for a profile.
        (document, attributeNodeId) => openOrRevealPreview(context, document, attributeNodeId),
        (absPath) => void notifyPreviewsOfWrite(absPath),
      )
    }),
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
      [
        { language: 'json', scheme: 'file' },
        { language: 'jsonc', scheme: 'file' },
      ],
      definitionProvider,
    ),
  )
}

/** Kicks off a background pack load for `document`'s pack iff the document is plausibly a
 * previewable feature/rule file. Every failure here is deliberately silent -- a missing binary,
 * an unparseable file, no pack root -- because at "the user merely focused a JSON file" time
 * none of that is actionable; the SAME failures surface loudly (and with better context) if and
 * when the user actually invokes the preview command. */
function maybePrewarm(context: vscode.ExtensionContext, document: vscode.TextDocument | undefined): void {
  if (!document || document.uri.scheme !== 'file') return
  if (document.languageId !== 'json' && document.languageId !== 'jsonc') return
  const text = document.getText()
  // Feature files are a few KB; a megabyte-plus JSON (package-lock and friends) is never one,
  // and not worth a JSON.parse on every editor focus just to prove it.
  if (text.length > 1_000_000) return
  try {
    parseDocumentIdentifier(text)
    const packRoot = resolvePackRoot(document.uri.fsPath)
    const ctl = resolveController(context)
    const timeoutMs = vscode.workspace.getConfiguration('featurelab').get<number>('requestTimeoutMs', 30_000)
    void ctl.ensurePackLoaded(packRoot, timeoutMs).catch(() => {})
  } catch {
    // Not previewable / no pack / no binary -- see this function's own doc comment.
  }
}

/** Throwing flavour of controller resolution -- the command path wraps it in a toast
 * (getController), the pre-warm path swallows it (maybePrewarm). */
function resolveController(context: vscode.ExtensionContext): PreviewController {
  if (controller) return controller
  const binaryPath = resolveBinaryPath(context)
  controller = new PreviewController(binaryPath)
  return controller
}

function getController(context: vscode.ExtensionContext): PreviewController | null {
  try {
    return resolveController(context)
  } catch (err) {
    const message = err instanceof BinaryNotFoundError ? err.message : String(err)
    void vscode.window.showErrorMessage(`Feature Lab: ${message}`)
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
function openOrRevealPreview(context: vscode.ExtensionContext, document: vscode.TextDocument, attributeNodeId?: string): void {
  const key = document.uri.toString()
  const existing = panelsByUri.get(key)
  if (existing) {
    existing.reveal()
    existing.notifyDocumentChanged(document)
    if (attributeNodeId !== undefined) {
      existing.attributeNode(attributeNodeId)
      graphDrivenPanel = existing
    }
    return
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
    return
  }
  const ctl = getController(context)
  if (!ctl) return
  const panel = new PreviewPanel(
    context,
    ctl,
    diagnosticCollection,
    document,
    (disposed) => {
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
    },
    undefined,
    {
      // Handed to the constructor rather than set right after it, so a preview opened FROM the
      // graph asks for its profile on its very first run instead of paying for an unprofiled one
      // and immediately repeating it. attributeNode() above is for a panel that already exists.
      attributeNodeId: attributeNodeId ?? null,
      // Both return legs fan out over the OPEN graph panels rather than being remembered per
      // preview, because the graph an answer belongs in is decided by the PACK, and either panel
      // can be closed and reopened while the other stays put.
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
    },
  )
  panelsByUri.set(key, panel)
}

/** Tells every open preview that a pack file changed underneath it.
 *
 * The preview reloads on `onDidSaveTextDocument`, and an edit made in the graph panel never fires
 * one: the engine writes the file directly, so as far as VS Code is concerned nothing was saved.
 * Without this the preview goes on showing the pack as it was before the edit, with nothing on
 * screen to suggest it is out of date -- which is worse than showing nothing.
 *
 * The document is OPENED but not shown. That is what the preview's own API takes, and opening one
 * is also what makes VS Code re-read a file it may already have in memory.
 */
async function notifyPreviewsOfWrite(absPath: string): Promise<void> {
  if (panelsByUri.size === 0) return
  try {
    const document = await vscode.workspace.openTextDocument(absPath)
    for (const panel of panelsByUri.values()) panel.notifyPackFileSaved(document)
  } catch {
    // A path that is not a document any more -- a deleted feature, most likely. The graph has
    // already been rebuilt from disk; a preview that cannot be told is not worth an error.
  }
}

export function deactivate(): void {
  for (const panel of panelsByUri.values()) panel.dispose()
  panelsByUri.clear()
  controller?.dispose()
  controller = undefined
}
