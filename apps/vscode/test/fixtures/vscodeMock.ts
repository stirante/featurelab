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
  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri([base.fsPath, ...segments].join('/'))
  }
  constructor(public fsPath: string) {}
  toString(): string {
    return this.fsPath
  }
}

export const ViewColumn = { Beside: 2 }

/** Every webview panel created by createWebviewPanel() during a test -- previewPanel.test.ts
 * reads the most recently created one to drive its message handlers and assert on
 * postMessage/html output, mirroring how a real vscode.WebviewPanel would be inspected. */
export const createdPanels: MockWebviewPanel[] = []

export class MockWebview {
  html = ''
  cspSource = 'vscode-webview://mock'
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
  private disposeHandler: (() => void) | null = null
  disposed = false

  onDidDispose(handler: () => void): { dispose(): void } {
    this.disposeHandler = handler
    return { dispose: () => {} }
  }
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
export const messageAnswers: { information?: string } = {}

export const ProgressLocation = { Notification: 15 }

export const window = {
  createWebviewPanel: vi.fn((..._args: unknown[]) => {
    const panel = new MockWebviewPanel()
    createdPanels.push(panel)
    return panel
  }),
  showWarningMessage: vi.fn((_message: string, ..._rest: unknown[]) => Promise.resolve(undefined)),
  showInformationMessage: vi.fn((_message: string, ..._rest: unknown[]) => Promise.resolve(messageAnswers.information)),
  showErrorMessage: vi.fn((_message: string, ..._rest: unknown[]) => Promise.resolve(undefined)),
  withProgress: vi.fn(<T>(_options: unknown, task: (progress: { report(v: unknown): void }) => Promise<T>): Promise<T> => task({ report: () => {} })),
  createOutputChannel: vi.fn((_name: string) => ({
    appendLine: (line: string) => outputLines.push(line),
    append: (text: string) => outputLines.push(text),
    show: () => {},
    dispose: () => {},
  })),
}

/** Test-only helper: what `workspace.getConfiguration('featurelab')` returns -- mutate this
 * directly from a test before constructing a PreviewPanel to control env/requestTimeoutMs. */
// blockTextures is pinned OFF here even though the extension's own default is ON: a test that
// is not about textures must not have PreviewPanel spawn `featurelab textures` at it. A test
// that IS about them sets mockConfig.blockTextures = true and passes PreviewPanel its own
// TextureBuilder stub -- see previewTextures.test.ts.
export const mockConfig: Record<string, unknown> = { env: 'plains', requestTimeoutMs: 5000, blockTextures: false }

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: <T>(key: string, fallback: T): T => (key in mockConfig ? (mockConfig[key] as T) : fallback),
  })),
}

export const languages = {
  createDiagnosticCollection: vi.fn(() => ({
    set: vi.fn(),
    delete: vi.fn(),
    dispose: vi.fn(),
  })),
}

export const Uri = MockUri
export const Diagnostic = MockDiagnostic
export const Range = MockRange
