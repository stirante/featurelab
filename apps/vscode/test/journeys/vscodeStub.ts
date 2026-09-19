// vscodeStub.ts -- the `vscode` module, for a journey test.
//
// It exists so the journeys can drive the REAL src/graphPanel.ts. That file is half of what
// these tests are about: it owns the node->file table, the pending drop position, the layout
// merge and every refusal message the panel shows. A harness that re-implemented its message
// switch would be asserting against a copy of the code under test, which is the exact failure
// mode this whole directory was written to avoid.
//
// Only the surface GraphPanel touches is here. It is NOT a general-purpose vscode mock, and it
// deliberately fakes as little as possible:
//
//   - The webview is a PIPE, not a fake. postMessage and onDidReceiveMessage are wired to a
//     real Chromium page running the real dist/graph.js (see harness.ts). Nothing inspects the
//     messages; they are carried.
//   - `asWebviewUri` and `cspSource` are the one genuinely synthetic part, because the real
//     values name a `vscode-webview://` origin no browser outside VS Code can serve. They are
//     replaced by a local http origin, and the CSP the panel builds from that origin is then
//     enforced for real by Chromium.
//   - openTextDocument/showTextDocument are stubs that RECORD. There is no text editor here to
//     open a file in, so a journey that ends "and the file opens beside the graph" can only
//     assert which path was asked for. That limit is real and is reported as such.
//
// It grew a second panel's worth of surface when the attribution journey arrived: src/
// previewPanel.ts is now driven here too, for the same reason -- the graph telling the preview
// which node to highlight, and the preview telling the graph what placed a block, are a
// conversation BETWEEN the two real panels, and a harness that mocked either end would be
// asserting against a copy of the thing under test. The additions (a real document with text and
// lines, an output channel, a progress runner, the Diagnostic/Range/Position types) are all
// things PreviewPanel touches on the ordinary path; none of them is a behaviour.
import * as fs from 'node:fs'
import * as path from 'node:path'

export class MockUri {
  static file(p: string): MockUri {
    return new MockUri(p)
  }
  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri(path.join(base.fsPath, ...segments))
  }
  constructor(public fsPath: string) {}
  toString(): string {
    return this.fsPath
  }
}

export const ViewColumn = { Active: 1, Beside: 2, One: 1 }

export const ProgressLocation = { Notification: 15 }

/** Real enough for diagnostics.ts, which is the only thing here that builds one. */
export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}
export class Range {
  constructor(
    public startLine: number,
    public startCharacter: number,
    public endLine: number,
    public endCharacter: number,
  ) {}
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 }
export class Diagnostic {
  source?: string
  constructor(
    public range: Range,
    public message: string,
    public severity?: number,
  ) {}
}

/** How a webview URI is spelled for the harness's own http server, and what the CSP names.
 * Set by harness.ts before the panel is created -- the shell HTML is built in GraphPanel's
 * constructor, so a value set afterwards would arrive too late to appear in the document. */
export const webviewOrigin = { value: 'http://127.0.0.1:0' }

export class MockWebview {
  html = ''
  get cspSource(): string {
    return webviewOrigin.value
  }
  /** Where a host->webview message goes. harness.ts replaces this with "post it into the page". */
  onPost: (message: unknown) => void = () => {}
  private handler: ((message: unknown) => void) | null = null

  postMessage(message: unknown): Promise<boolean> {
    this.onPost(message)
    return Promise.resolve(true)
  }
  onDidReceiveMessage(handler: (message: unknown) => void): { dispose(): void } {
    this.handler = handler
    return { dispose: () => (this.handler = null) }
  }
  /** A webview asset URI. Both files the shell links are served by the harness under their own
   * basename, which is unambiguous: the panel links exactly dist/graph.js and media/graph.css. */
  asWebviewUri(uri: MockUri): MockUri {
    return new MockUri(`${webviewOrigin.value}/${path.basename(uri.fsPath)}`)
  }
  /** The page's half of the pipe: deliver a message the webview posted to the host. */
  deliverFromWebview(message: unknown): void {
    this.handler?.(message)
  }
}

export class MockWebviewPanel {
  webview = new MockWebview()
  disposed = false
  revealed = 0
  private onDispose: (() => void) | null = null

  onDidDispose(handler: () => void): { dispose(): void } {
    this.onDispose = handler
    return { dispose: () => {} }
  }
  reveal(): void {
    this.revealed++
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.onDispose?.()
  }
}

/** Every panel created during a test, newest last. */
export const createdPanels: MockWebviewPanel[] = []

export interface OpenedDocument {
  fsPath: string
  /** Whether it was shown in an editor, and where. Undefined means it was only opened -- which
   * is what the preview path does. */
  shownIn?: number
}

/** Files the host asked VS Code to open, in order. The only thing a journey can observe about
 * "open this node's file beside the graph" without a real editor. */
export const openedDocuments: OpenedDocument[] = []

/** A text document backed by the file on disk.
 *
 * The graph half of these journeys only ever needed a path. PreviewPanel needs the CONTENTS --
 * it parses the open file's own identifier to decide what to generate (identifier.ts's
 * parseDocumentIdentifier) -- and it needs line counts, because a diagnostic is reported over a
 * range covering the document. Read at construction, like VS Code's own: a document is a
 * snapshot, and a journey that edits a file re-opens it. */
export class MockTextDocument {
  readonly uri: MockUri
  readonly fileName: string
  private readonly lines: string[]

  constructor(fsPath: string) {
    this.uri = new MockUri(fsPath)
    this.fileName = fsPath
    this.lines = fs.readFileSync(fsPath, 'utf8').split(/\r?\n/)
  }
  getText(): string {
    return this.lines.join('\n')
  }
  get lineCount(): number {
    return this.lines.length
  }
  lineAt(line: number): { text: string } {
    return { text: this.lines[line] ?? '' }
  }
}

/** Everything appended to the "Feature Lab" output channel, in order. The one place this
 * extension says something long-form that is not an error -- the per-block texture notes, and
 * the single line a malformed attribution table earns -- so a journey can assert that a
 * degradation was RECORDED rather than merely silent. */
export const outputLines: string[] = []

/** Every warning notification the host raised, newest last, with the options object's `detail` and
 * `modal` -- because the graph panel's delete confirmation puts the files it is about to write in
 * `detail`, and a dialog that names nothing is the thing that confirmation exists to replace. */
export const shownWarnings: { message: string; detail?: string; modal: boolean; actions: string[] }[] = []

/** What showWarningMessage answers next.
 *
 * DEFAULTS TO CONFIRMING, and this is the one place in this file where the stub decides something
 * rather than carrying it. These journeys are about the CANVAS: a journey about pressing Delete on
 * a node is not also a journey about a modal dialog, and every one of them predates the dialog
 * existing. The confirmation ITSELF -- that it is asked every time, that it names the files, that
 * cancelling writes nothing -- is tested directly against the real GraphPanel in
 * test/graphHistory.test.ts, where an answer can be chosen per case instead of per file. A journey
 * that wants the other answer sets this to undefined. */
export const messageAnswers: { warning?: string } = { warning: 'Delete' }

export function resetStub(): void {
  createdPanels.length = 0
  openedDocuments.length = 0
  outputLines.length = 0
  statusBarItems.length = 0
  shownWarnings.length = 0
  messageAnswers.warning = 'Delete'
}

export const window = {
  createWebviewPanel(..._args: unknown[]): MockWebviewPanel {
    const panel = new MockWebviewPanel()
    createdPanels.push(panel)
    return panel
  },
  showTextDocument(document: { uri: MockUri }, options?: { viewColumn?: number }): Promise<unknown> {
    const entry = openedDocuments.find((d) => d.fsPath === document.uri.fsPath)
    if (entry) entry.shownIn = options?.viewColumn ?? 1
    return Promise.resolve({})
  },
  showErrorMessage(..._args: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined)
  },
  showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    const options = rest.find((r): r is { detail?: string; modal?: boolean } => typeof r === 'object' && r !== null)
    shownWarnings.push({
      message,
      detail: options?.detail,
      modal: options?.modal === true,
      actions: rest.filter((r): r is string => typeof r === 'string'),
    })
    return Promise.resolve(messageAnswers.warning)
  },
  showInformationMessage(..._args: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined)
  },
  createOutputChannel(_name: string): { appendLine(line: string): void; show(preserveFocus?: boolean): void; dispose(): void } {
    return { appendLine: (line: string) => outputLines.push(line), show: () => {}, dispose: () => {} }
  },
  /** Runs the task immediately and reports progress nowhere. The token never fires: nothing in
   * these journeys cancels, and a stub that cancelled would be testing the stub. */
  withProgress<T>(
    _options: unknown,
    task: (progress: { report(value: unknown): void }, token: MockCancellationToken) => Promise<T>,
  ): Promise<T> {
    return task({ report: () => {} }, new MockCancellationToken())
  },
  /** The status-bar spinner src/progress.ts shows while any engine request is in flight.
   * Recorded rather than faked: a journey can ask whether the editor ever said it was busy. */
  createStatusBarItem(_alignment?: number, _priority?: number): MockStatusBarItem {
    const item = new MockStatusBarItem()
    statusBarItems.push(item)
    return item
  },
}

export const StatusBarAlignment = { Left: 1, Right: 2 }

export class MockCancellationToken {
  isCancellationRequested = false
  onCancellationRequested(_listener: () => void): { dispose(): void } {
    return { dispose: () => {} }
  }
}

/** Every status-bar item created during a test. The spinner is the only thing on screen while a
 * background regenerate runs, so "did the editor say it was working" is decidable here. */
export const statusBarItems: MockStatusBarItem[] = []

export class MockStatusBarItem {
  text = ''
  tooltip = ''
  command = ''
  visible = false
  /** Every text this item ever showed, so a test can assert it was busy at some point even
   * though the run has since finished and hidden it. */
  readonly shown: string[] = []
  show(): void {
    this.visible = true
    this.shown.push(this.tooltip === '' ? this.text : this.tooltip)
  }
  hide(): void {
    this.visible = false
  }
  dispose(): void {
    this.visible = false
  }
}

export const workspace = {
  openTextDocument(target: string | MockUri): Promise<MockTextDocument> {
    const fsPath = typeof target === 'string' ? target : target.fsPath
    // Real openTextDocument rejects for a path that is not there, and a journey depends on
    // that: deleting a node's file and then asking the panel to open it has to fail the way it
    // would in VS Code rather than silently succeed.
    if (!fs.existsSync(fsPath)) return Promise.reject(new Error(`cannot open ${fsPath}`))
    openedDocuments.push({ fsPath })
    return Promise.resolve(new MockTextDocument(fsPath))
  },
  getConfiguration(): { get: <T>(key: string, fallback: T) => T } {
    return { get: <T>(_key: string, fallback: T): T => fallback }
  },
  /** No folder is open. previewPanel.ts's workspaceIdFrom takes `?? []` for exactly this, and
   * the resulting empty workspace id is what a VS Code window with no folder really produces. */
  workspaceFolders: undefined as { uri: MockUri }[] | undefined,
}

export const Uri = MockUri
