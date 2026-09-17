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
import * as path from 'node:path'
import { graphDiagnostics, type AnnotateOp, type GraphDiagnostic, type PreviewController } from './previewController.js'
import { loadLayout, readSidecar, withPosition, writeSidecar } from './graph/layoutSidecar.js'
import { GRAPH_NODE_WIDTH, GRAPH_NODE_HEIGHT } from './graph/render.js'
// The stand-in this editor writes wherever it has to name a feature and does not know one yet.
// It is the host that writes it, not the webview: the webview says WHICH delegations cannot be
// removed, and what they are pointed at is not a value it gets to name.
import { PLACEHOLDER_FEATURE } from './graph/compounds/spec.js'
import type { LayoutGraph } from './graph/layout.js'

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
</style>
</head>
<body data-fl-pack="${escapeAttribute(packLabel)}">
  <div id="flg-root">
    <div id="flg-toolbar" role="toolbar" aria-label="Graph"></div>
    <div id="flg-body">
      <div id="flg-canvas"></div>
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
  | { type: 'openFile'; nodeId?: string; file?: string }
  // `file` is NOT an arbitrary path. See GraphPanel.diagnosticFiles: the host only honours a
  // path it has itself just reported as belonging to a file in this pack, which keeps the rule
  // above -- the webview names things, the host resolves them -- intact for a file that has no
  // node to be named by.
  | { type: 'applyEdits'; file: string; edits: readonly { path: string; json: string | null }[] }
  // Records a `@featurelab:` directive in `file`'s comments. A sibling of applyEdits and not a
  // case of it: a directive lives in a comment, is placed from the path rather than at it, and is
  // rewritten in place when one of that name is already there. `path` names what the directive is
  // about, and is subject to the same rule as every other path the webview sends -- the engine
  // resolves it inside the loaded pack and refuses anything that escapes.
  | { type: 'annotate'; file: string; path: string; name: string; args?: readonly string[] }
  // Several directives across several files as ONE change -- what a feature group is, since
  // every member's file carries the group's name and state. Each op names its file under the
  // same rule as `annotate`; the engine validates the whole batch before writing any of it.
  | { type: 'annotateBatch'; ops: readonly AnnotateOp[] }
  | {
      type: 'create'
      files: readonly { path: string; contents: string }[]
      select?: string
      position?: { x: number; y: number }
    }
  | { type: 'moveNode'; nodeId: string; x: number; y: number }
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
    }
  | {
      type: 'regenerate'
      owner: string
      files: readonly { path: string; contents: string }[]
      remove: readonly string[]
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

export class GraphPanel {
  private static readonly viewType = 'featurelab.graph'
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
  /** Pack-relative paths the host reported diagnostics for, from the last graph.
   *
   * The webview may ask to open one of these by path. That is the only path it may name, and
   * the allow-list is what keeps `openFile` from becoming "open anything you like": a refused
   * file has no node, so `filesByNode` cannot vouch for it, and without this the alternative
   * was to trust a string from the least privileged half of the pair. */
  private diagnosticFiles = new Set<string>()

  /** Every open panel, so a save anywhere in a pack can reach the one showing it. */
  static openPanels(): readonly GraphPanel[] {
    return [...GraphPanel.open.values()]
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
      existing.panel.reveal(vscode.ViewColumn.Active)
      return existing
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Feature Graph',
      vscode.ViewColumn.Active,
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
    const created = new GraphPanel(panel, extensionUri, controller, packRoot, timeoutMs, onPreviewFile, onPackFileWritten)
    GraphPanel.open.set(packRoot, created)
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
    panel.webview.html = buildGraphHtml(panel.webview, extensionUri, packRoot)
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: GraphHostMessage) => {
        void this.onMessage(message)
      }),
    )
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  private async onMessage(message: GraphHostMessage): Promise<void> {
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        this.ready = true
        for (const held of this.pending) void this.panel.webview.postMessage(held)
        this.pending = []
        // The coverage table goes first: the creation menu cannot decide what may be created
        // without it, and it never changes for the life of the process.
        await this.sendTypes()
        await this.refresh()
        return
      case 'requestGraph':
        await this.refresh()
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
        await this.annotateBatch(message.ops)
        return
      case 'create':
        await this.create(message)
        return
      case 'moveNode':
        this.moveNode(message)
        return
      case 'previewNode':
        await this.previewNode(message.nodeId, message.attribute)
        return
      case 'renameFeature':
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
    try {
      const graph = await this.controller.graph(this.packRoot, this.timeoutMs)
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
      this.diagnosticFiles = new Set(diagnostics.map((d) => d.fileId))
      this.post({
        type: 'graph',
        graph,
        diagnostics,
        positions,
        // A sidecar that could not be parsed is reported rather than silently ignored: the
        // arrangement is someone's work, and quietly laying the graph out afresh looks like
        // the editor threw it away -- which, if they then save, it has.
        layoutProblem: resolved.problem ?? undefined,
        orphanedPositions: resolved.orphaned.length,
      })
    } catch (err) {
      this.post({ type: 'graphError', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Sends the engine's coverage table once. A failure here is not fatal to the panel -- the
   * graph still draws and is still readable; only creating new nodes is unavailable, which the
   * menu says for itself rather than pretending the list is empty. */
  private async sendTypes(): Promise<void> {
    try {
      const types = (await this.controller.listTypes(this.timeoutMs)) as { types?: unknown }
      this.post({ type: 'types', coverage: types?.types ?? [] })
    } catch (err) {
      this.post({ type: 'typesError', message: err instanceof Error ? err.message : String(err) })
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
  }): Promise<void> {
    try {
      await this.controller.regenerate(this.packRoot, message.owner, message.files, message.remove ?? [], this.timeoutMs)
      for (const f of message.files) this.onPackFileWritten(path.join(this.packRoot, f.path))
      await this.refresh()
      this.post({ type: 'created', nodeId: message.owner })
    } catch (err) {
      this.post({ type: 'editError', message: err instanceof Error ? err.message : String(err) })
    }
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
  }): Promise<void> {
    const retarget = message.retarget ?? []
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
   * Closing the panel is an answer, not an accident: the author is done looking. Until this
   * existed, "Preview on select" stayed on afterwards and the next click reopened the panel they
   * had just shut, again and again -- there was no way to stop it short of closing the graph. */
  previewClosed(): void {
    this.post({ type: 'previewClosed' })
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
  }): Promise<void> {
    if (!message.files || message.files.length === 0) return
    if (message.select && message.position) {
      this.pendingPositions.set(message.select, message.position)
    }
    try {
      await this.controller.createFiles(this.packRoot, message.files, this.timeoutMs)
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
  private async applyEdits(message: { file: string; edits: readonly { path: string; json: string | null }[] }): Promise<void> {
    if (!message.file) {
      this.post({ type: 'editError', message: 'That node has no file behind it, so there is nothing to write.' })
      return
    }
    if (!message.edits || message.edits.length === 0) return
    try {
      await this.controller.applyEdits(
        this.packRoot,
        message.file,
        message.edits.map((e) => (e.json === null ? { path: e.path, delete: true } : { path: e.path, value: e.json })),
        this.timeoutMs,
      )
      this.onPackFileWritten(path.join(this.packRoot, message.file))
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
  private async annotate(message: { file: string; path: string; name: string; args?: readonly string[] }): Promise<void> {
    if (!message.file) {
      this.post({ type: 'editError', message: 'That node has no file behind it, so there is nothing to annotate.' })
      return
    }
    try {
      await this.controller.annotate(this.packRoot, message.file, message.path, message.name, message.args ?? [], this.timeoutMs)
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
  private async annotateBatch(ops: readonly AnnotateOp[]): Promise<void> {
    if (!ops || ops.length === 0) return
    if (ops.some((op) => !op.file)) {
      this.post({ type: 'editError', message: 'One of those nodes has no file behind it, so the group could not be written.' })
      return
    }
    try {
      await this.controller.annotateBatch(this.packRoot, ops, this.timeoutMs)
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
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false })
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
    GraphPanel.open.delete(this.packRoot)
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
