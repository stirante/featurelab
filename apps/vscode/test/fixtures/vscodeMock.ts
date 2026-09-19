// vscodeMock.ts -- a minimal stand-in for the 'vscode' module, covering only the surface
// previewPanel.ts and diagnostics.ts actually touch, so previewPanel.test.ts can drive real
// PreviewPanel logic (message handling, the lastParams fallback rule) without a running VS
// Code host. Not a general-purpose vscode mock -- extend it if a future test needs more of the
// API surface.
import { vi } from 'vitest'

export class MockDiagnostic {
  source?: string
  constructor(
    public range: unknown,
    public message: string,
    public severity: number,
  ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1 }

export class MockRange {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number,
  ) {}
}

export class MockUri {
  static file(p: string): MockUri {
    return new MockUri(p)
  }
  static parse(p: string): MockUri {
    return new MockUri(p)
  }
  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri([base.fsPath, ...segments].join('/'))
  }
  constructor(public fsPath: string) {}
  toString(): string {
    return this.fsPath
  }
}

export const ViewColumn = { One: 1, Beside: 2, Active: -1 }

/** Every command activate() registered, by id. commandFeedback.test.ts drives the real
 * command bodies through these, which is the only way to test what a person sees between
 * pressing a key and getting an answer -- the thing the commands were reported as saying
 * nothing about. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>()

export const commands = {
  registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
    registeredCommands.set(id, handler)
    return { dispose: () => registeredCommands.delete(id) }
  }),
  executeCommand: vi.fn((id: string, ...args: unknown[]) => Promise.resolve(registeredCommands.get(id)?.(...args))),
}

const noopDisposable = { dispose: () => {} }

/** Every webview panel created by createWebviewPanel() during a test -- previewPanel.test.ts
 * reads the most recently created one to drive its message handlers and assert on
 * postMessage/html output, mirroring how a real vscode.WebviewPanel would be inspected. */
export const createdPanels: MockWebviewPanel[] = []

export class MockWebview {
  html = ''
  cspSource = 'vscode-webview://mock'
  /** The panel re-asserts these on a REVIVED webview: VS Code does not persist webview options,
   * so a restored panel comes back with its scripts off. "Did the host switch them back on" is
   * the difference between a graph and a blank grey rectangle. */
  options: unknown = {}
  postedMessages: unknown[] = []
  private messageHandler: ((msg: unknown) => void) | null = null

  postMessage(message: unknown): Thenable<boolean> {
    this.postedMessages.push(message)
    return Promise.resolve(true)
  }
  onDidReceiveMessage(handler: (msg: unknown) => void): { dispose(): void } {
    this.messageHandler = handler
    return { dispose: () => {} }
  }
  asWebviewUri(uri: MockUri): MockUri {
    return uri
  }
  /** Test-only helper: simulates the webview posting `message` to the host. */
  simulateMessage(message: unknown): void {
    this.messageHandler?.(message)
  }
}

export class MockWebviewPanel {
  webview = new MockWebview()
  title = ''
  private disposeHandler: (() => void) | null = null
  disposed = false

  onDidDispose(handler: () => void): { dispose(): void } {
    this.disposeHandler = handler
    return { dispose: () => {} }
  }
  /** Every reveal, with the arguments it was given. The ARGUMENTS are the point: `reveal()` with
   * no column brings a panel forward where it is, and `reveal(ViewColumn.Active)` MOVES it into
   * whichever group has focus -- which is a panel landing on top of the one next to it. */
  reveal = vi.fn()
  dispose(): void {
    this.disposed = true
    this.disposeHandler?.()
  }
}

/** Every line any test wrote to an output channel, newest last -- the texture flow's long-form
 * detail (per-block notes, the pack summary, the sentence behind a warning) goes here. */
export const outputLines: string[] = []

/** What showInformationMessage returns next, for the tests that drive the "download Mojang's
 * textures?" question. Set to the button label a test wants clicked; undefined is a dismissed
 * notification, which decides nothing. */
export const messageAnswers: { information?: string; error?: string; warning?: string } = {}

/** Every error notification shown, in order, as the user would read it: the sentence plus the
 * buttons on it. The surface the command tests assert against -- what a person SEES, rather
 * than which function was called. */
export const errorMessages: ShownMessage[] = []
/** The same, for warnings. */
export const warningMessages: ShownMessage[] = []

/** One notification as a person would meet it.
 *
 * `detail` and `modal` come from the options object VS Code takes between the message and the
 * buttons, and they are recorded because a MODAL confirmation is a different thing from a toast:
 * the graph panel's delete dialog puts the files it is about to write in `detail`, and "did the
 * user actually see which files" is not decidable from the headline alone. */
export interface ShownMessage {
  message: string
  actions: string[]
  detail?: string
  modal?: boolean
}

/** Pulls the options object out of a showXMessage call's rest arguments, if there was one. */
function messageOptions(rest: readonly unknown[]): { detail?: string; modal?: boolean } {
  const options = rest.find((r): r is { detail?: string; modal?: boolean } => typeof r === 'object' && r !== null)
  return { detail: options?.detail, modal: options?.modal }
}

export const ProgressLocation = { Notification: 15 }

export const StatusBarAlignment = { Left: 1, Right: 2 }

/** Every status-bar item created during a test, and every tooltip it ever showed. src/progress.
 * ts puts the spinner up for as long as any engine request is in flight, so this is where "did
 * the editor say it was working" is decidable without a real status bar. */
export const statusBarItems: MockStatusBarItem[] = []

export class MockStatusBarItem {
  text = ''
  tooltip = ''
  command = ''
  visible = false
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

/** A cancellation token that never fires. A test that wants to cancel sets `cancel` on the one
 * it is holding -- see progressTokens. */
export class MockCancellationToken {
  isCancellationRequested = false
  private listeners: (() => void)[] = []
  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.push(listener)
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) }
  }
  /** Test-only: fires the token, the way a user pressing Cancel would. */
  cancel(): void {
    this.isCancellationRequested = true
    for (const listener of [...this.listeners]) listener()
  }
}

/** Every token handed to a withProgress task, newest last, so a test can cancel the run it just
 * started. */
export const progressTokens: MockCancellationToken[] = []

/** Every `{location, title, cancellable}` a withProgress call was made with, newest last -- the
 * surface on which "did this command say what it was doing" is decidable. */
export const progressCalls: { title?: string; cancellable?: boolean }[] = []

/** Every detail line a running step reported into its notification, in order. */
export const progressReports: string[] = []

/** What each createWebviewPanel call asked for, newest last. The COLUMN is the reason this
 * exists: a panel opened at ViewColumn.Active takes the group the editor is in, which is how the
 * graph replaced the file somebody ran the command from. */
export const createdPanelCalls: { viewType: string; title: string; column: unknown }[] = []

/** Every webview serializer activate() registered, by view type -- what a test drives to stand in
 * for VS Code bringing a panel back after a window reload. */
export const registeredSerializers = new Map<string, { deserializeWebviewPanel(panel: unknown, state: unknown): Thenable<void> }>()

/** A stand-in for vscode.Memento, backed by a plain Map. Both panels keep the few things that
 * outlive them in `context.workspaceState`, and "did it actually come back" is not decidable
 * against a store that forgets. */
export class MockMemento {
  readonly store = new Map<string, unknown>()
  keys(): readonly string[] {
    return [...this.store.keys()]
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.store.delete(key)
    else this.store.set(key, value)
    return Promise.resolve()
  }
}

export const window = {
  createWebviewPanel: vi.fn((viewType?: unknown, title?: unknown, column?: unknown, ..._rest: unknown[]) => {
    const panel = new MockWebviewPanel()
    panel.title = typeof title === 'string' ? title : ''
    createdPanelCalls.push({ viewType: String(viewType), title: panel.title, column })
    createdPanels.push(panel)
    return panel
  }),
  registerWebviewPanelSerializer: vi.fn((viewType: string, serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Thenable<void> }) => {
    registeredSerializers.set(viewType, serializer)
    return { dispose: () => registeredSerializers.delete(viewType) }
  }),
  showWarningMessage: vi.fn((message: string, ...rest: unknown[]) => {
    warningMessages.push({
      message,
      actions: rest.filter((r): r is string => typeof r === 'string'),
      ...messageOptions(rest),
    })
    return Promise.resolve(messageAnswers.warning)
  }),
  showInformationMessage: vi.fn((_message: string, ..._rest: unknown[]) => Promise.resolve(messageAnswers.information)),
  showErrorMessage: vi.fn((message: string, ...rest: unknown[]) => {
    errorMessages.push({
      message,
      actions: rest.filter((r): r is string => typeof r === 'string'),
      ...messageOptions(rest),
    })
    return Promise.resolve(messageAnswers.error)
  }),
  withProgress: vi.fn(
    <T>(
      options: { title?: string; cancellable?: boolean },
      task: (progress: { report(v: { message?: string }): void }, token: MockCancellationToken) => Promise<T>,
    ): Promise<T> => {
      progressCalls.push({ title: options?.title, cancellable: options?.cancellable })
      const token = new MockCancellationToken()
      progressTokens.push(token)
      return task(
        {
          report: (v: { message?: string }) => {
            if (typeof v?.message === 'string') progressReports.push(v.message)
          },
        },
        token,
      )
    },
  ),
  createOutputChannel: vi.fn((_name: string) => ({
    appendLine: (line: string) => outputLines.push(line),
    append: (text: string) => outputLines.push(text),
    show: (..._args: unknown[]) => {
      outputShown.count++
    },
    dispose: () => {},
  })),
  createStatusBarItem: vi.fn((_alignment?: number, _priority?: number) => {
    const item = new MockStatusBarItem()
    statusBarItems.push(item)
    return item
  }),
  /** What the command bodies read to find out which file they were run on. A test sets it to
   * the document it wants the command to be about; undefined is a window with no editor open,
   * which is a state both commands have to have an answer for. */
  activeTextEditor: undefined as { document: unknown } | undefined,
  onDidChangeActiveTextEditor: vi.fn(() => noopDisposable),
  /** Records every "open this file for the user" the host performs, options included. The
   * OPTIONS are the point: the host now opens a refused pack file AT the line and column the
   * engine reported, and "did it open the file" and "did it put the cursor on the problem" are
   * two different questions with two different regressions behind them. */
  showTextDocument: vi.fn((document: unknown, options?: unknown) => {
    shownDocuments.push({ document, options })
    return Promise.resolve({ document })
  }),
}

/** What `window.showTextDocument` was asked to open, in order -- see its own comment above. */
export const shownDocuments: { document: unknown; options?: unknown }[] = []

/** How many times the output channel was revealed -- what "Show log" actually does, and the
 * only way to tell a button that works from one that is merely drawn. */
export const outputShown = { count: 0 }

/** Test-only helper: what `workspace.getConfiguration('featurelab')` returns -- mutate this
 * directly from a test before constructing a PreviewPanel to control env/requestTimeoutMs. */
// blockTextures is pinned OFF here even though the extension's own default is ON: a test that
// is not about textures must not have PreviewPanel spawn `featurelab textures` at it. A test
// that IS about them sets mockConfig.blockTextures = true and passes PreviewPanel its own
// TextureBuilder stub -- see previewTextures.test.ts.
export const mockConfig: Record<string, unknown> = {
  env: 'plains',
  requestTimeoutMs: 5000,
  blockTextures: false,
  // The featurelab.binaryPath override. Empty is "use the bundled copy", which is what
  // binaryResolver.ts falls back to; a command test sets it to whatever engine (or absence of
  // one) that test is about.
  binaryPath: '',
}

/** Clears everything the mock accumulates. Call it from beforeEach: these arrays are module
 * state, so a test that did not reset them asserts against the previous test's notifications. */
export function resetMock(): void {
  createdPanels.length = 0
  createdPanelCalls.length = 0
  registeredSerializers.clear()
  outputLines.length = 0
  errorMessages.length = 0
  warningMessages.length = 0
  statusBarItems.length = 0
  progressCalls.length = 0
  progressReports.length = 0
  progressTokens.length = 0
  registeredCommands.clear()
  shownDocuments.length = 0
  outputShown.count = 0
  delete messageAnswers.information
  delete messageAnswers.error
  delete messageAnswers.warning
  window.activeTextEditor = undefined
  // A window with no folder open. Reset here for the same reason activeTextEditor is: the
  // commands now read it (a graph is about a PACK, and a window opened on a pack folder has no
  // editor to learn one from), so a test that set it would otherwise decide the next one's answer.
  workspace.workspaceFolders = undefined
}

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: <T>(key: string, fallback: T): T => (key in mockConfig ? (mockConfig[key] as T) : fallback),
  })),
  onDidSaveTextDocument: vi.fn(() => noopDisposable),
  // FeatureDefinitionProvider watches from construction, by design -- see its ctor.
  createFileSystemWatcher: vi.fn(() => ({
    dispose: () => {},
    onDidCreate: () => noopDisposable,
    onDidChange: () => noopDisposable,
    onDidDelete: () => noopDisposable,
  })),
  // The return type is spelled out because vitest otherwise infers it from the rejecting default
  // as `Promise<never>`, and a test that wires a document in with mockResolvedValueOnce then
  // cannot pass one: the fallback's type would be the contract.
  openTextDocument: vi.fn((_target?: unknown): Promise<unknown> => Promise.reject(new Error('vscodeMock: openTextDocument is not wired'))),
  workspaceFolders: undefined as { uri: MockUri }[] | undefined,
}

export const languages = {
  createDiagnosticCollection: vi.fn(() => ({
    set: vi.fn(),
    delete: vi.fn(),
    dispose: vi.fn(),
  })),
  registerDefinitionProvider: vi.fn(() => noopDisposable),
}

export const Uri = MockUri
export const Diagnostic = MockDiagnostic
export const Range = MockRange
export const Position = class MockPosition {
  constructor(
    public line: number,
    public character: number,
  ) {}
}
