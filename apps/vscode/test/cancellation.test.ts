// cancellation.test.ts -- what happens when somebody presses Cancel.
//
// The behaviour under test is deliberately end-to-end-ish rather than structural: a real child
// process for the protocol half (fixtures/fake-engine.mjs, which honours `cancel` the way
// cmd/featurelab/serve.go does), and real panels driven through the vscode mock for the UI half.
// The assertions are things a person can see -- the engine is told to stop, the panel says it was
// cancelled instead of spinning, no error notification appears, and the next thing they ask for
// still works -- because every one of those was separately broken while "Cancel" was only ever a
// way to stop waiting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { EngineProcess, RequestCancelledError, RpcError } from '../src/engineProcess.js'
import { PreviewPanel, PREVIEW_CANCELLED } from '../src/previewPanel.js'
import { GraphPanel } from '../src/graphPanel.js'
import { graphCancelledMessage } from '../src/graph/emptyState.js'
import { CancelledError, disposeProgress, runWithProgress } from '../src/progress.js'
import { disposeLog } from '../src/log.js'
import type { PreviewController } from '../src/previewController.js'

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url))

let engine: EngineProcess | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
})

function startFakeEngine(): EngineProcess {
  const proc = new EngineProcess(process.execPath, [FAKE_ENGINE])
  proc.start()
  engine = proc
  return proc
}

// ---------------------------------------------------------------------------
// The protocol half
// ---------------------------------------------------------------------------

describe('EngineProcess: cancelling a request', () => {
  it('tells the engine to stop, and settles as cancelled rather than as a failure', async () => {
    const proc = startFakeEngine()
    const controller = new AbortController()
    // Long enough that nothing could finish on its own inside this test.
    const inflight = proc.request('slow', { delayMs: 30_000 }, 0, controller.signal)
    // Let the request reach the child before cancelling it, so this exercises stopping work that
    // is under way rather than a request that was never sent.
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()

    await expect(inflight).rejects.toBeInstanceOf(RequestCancelledError)
    // Not an RpcError: the difference between "you stopped this" and "the engine refused" is what
    // decides whether a user gets an error notification.
    await expect(inflight).rejects.not.toBeInstanceOf(RpcError)
  })

  it('sends "cancel" naming that request’s own id, so the engine stops the right one', async () => {
    const proc = startFakeEngine()
    // Two slow requests, so a cancel that named the wrong id (or every id) would show up as the
    // wrong one settling.
    const keepRunning = proc.request('slow', { delayMs: 300 }, 0)
    const controller = new AbortController()
    const doomed = proc.request('slow', { delayMs: 30_000 }, 0, controller.signal)
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()

    await expect(doomed).rejects.toBeInstanceOf(RequestCancelledError)
    // The engine really did stop only the one named: the other still answers, on time, with its
    // own result.
    await expect(keepRunning).resolves.toEqual({ waited: 300 })
  })

  it('a request after a cancelled one still works -- the engine is not left wedged', async () => {
    const proc = startFakeEngine()
    const controller = new AbortController()
    const cancelled = proc.request('slow', { delayMs: 30_000 }, 0, controller.signal)
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    await expect(cancelled).rejects.toBeInstanceOf(RequestCancelledError)

    await expect(proc.request('echo', { after: 'cancel' })).resolves.toEqual({ after: 'cancel' })
  })

  it('a signal that already fired sends nothing at all', async () => {
    const proc = startFakeEngine()
    const controller = new AbortController()
    controller.abort()
    await expect(proc.request('echo', {}, 0, controller.signal)).rejects.toBeInstanceOf(RequestCancelledError)
    // And the engine is untouched by it.
    await expect(proc.request('echo', { still: 'here' })).resolves.toEqual({ still: 'here' })
  })

  it('an engine-reported cancellation reaching a caller who is still waiting is a cancellation, not an error', async () => {
    // The race the code has to survive: something else cancelled this id (a second panel, a
    // cancel that crossed the response), so the {"code":"cancelled"} error arrives with a caller
    // still holding the promise. Simulated by cancelling through a SECOND request rather than
    // through this one's signal, which is exactly the shape that race has on the wire.
    const proc = startFakeEngine()
    // The outcome is captured the moment the request is made, not awaited later: this rejection
    // arrives on its own schedule, and a handler attached afterwards is an unhandled rejection in
    // between.
    const settled = proc.request('slow', { delayMs: 30_000 }, 0).then(
      () => null,
      (err: unknown) => err,
    )
    await new Promise((r) => setTimeout(r, 50))
    // The fake engine numbers ids the same way the real one does -- the slow request above got 1.
    await proc.request('cancel', { id: 1 })
    expect(await settled).toBeInstanceOf(RequestCancelledError)
  })
})

// ---------------------------------------------------------------------------
// The notification half
// ---------------------------------------------------------------------------

describe('runWithProgress: pressing Cancel', () => {
  beforeEach(() => {
    vscodeMock.resetMock()
    disposeLog()
    disposeProgress()
  })

  it('hands the step a signal and fires it when Cancel is pressed', async () => {
    let seen: AbortSignal | null = null
    let aborted = false
    const never = new Promise<never>(() => {})
    const run = runWithProgress(
      'building the graph',
      (_report, signal) => {
        seen = signal
        signal.addEventListener('abort', () => {
          aborted = true
        })
        return never
      },
      { cancellable: true },
    )
    expect(seen).not.toBeNull()
    expect(aborted).toBe(false)

    vscodeMock.progressTokens[vscodeMock.progressTokens.length - 1]!.cancel()
    await expect(run).rejects.toBeInstanceOf(CancelledError)
    // The step's own signal fired, which is what carries the cancel to the engine. Without this,
    // Cancel is back to being nothing but a way to stop watching.
    expect(aborted).toBe(true)
  })

  it('a step that is not cancellable still gets a signal, and it never fires', async () => {
    let aborted = false
    const result = await runWithProgress('reloading the pack', (_report, signal) => {
      signal.addEventListener('abort', () => {
        aborted = true
      })
      return Promise.resolve('done')
    })
    expect(result).toBe('done')
    expect(aborted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The panel half
// ---------------------------------------------------------------------------

const FEATURE_JSON = JSON.stringify({
  format_version: '1.19.0',
  'minecraft:tree_feature': { description: { identifier: 'wiki:poplar_tree' } },
})

function makeDocument(fsPath = '/pack/features/thing.json') {
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    fileName: fsPath,
    getText: () => FEATURE_JSON,
    lineCount: 1,
    lineAt: () => ({ text: '' }),
  } as unknown as import('vscode').TextDocument
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('PreviewPanel: a cancelled run', () => {
  beforeEach(() => {
    vscodeMock.createdPanels.length = 0
    disposeLog()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A controller whose generate hangs until the request's own signal fires, then rejects the way
   * the real one does -- which is the only behaviour the panel is entitled to assume. */
  function makeHangingController(): PreviewController & { generate: ReturnType<typeof vi.fn> } {
    const generate = vi.fn(
      (_root: string, _params: unknown, _timeout: number, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new RequestCancelledError('generate')), { once: true })
        }),
    )
    return {
      generate,
      generateGrown: vi.fn(),
      reloadPack: vi.fn(async () => ({ warnings: [], featureCount: 1, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
      reloadPackFile: vi.fn(async () => ({ warnings: [], featureCount: 1, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
      listEnvironments: vi.fn(async () => []),
    } as unknown as PreviewController & { generate: ReturnType<typeof vi.fn> }
  }

  /** A panel whose webview has reported `ready`, so host->webview messages are sent rather than
   * held in the outbox -- otherwise every assertion below would be about a buffer instead of
   * about what the panel actually said. */
  function makePanel(controller: PreviewController): PreviewPanel {
    const diagnostics = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagnostics,
      makeDocument(),
      () => {},
    )
    vscodeMock.createdPanels[0]!.webview.simulateMessage({ type: 'ready' })
    return panel
  }

  it('stops spinning and says it was cancelled, rather than leaving a spinner or a stale result', async () => {
    const controller = makeHangingController()
    const panel = makePanel(controller)
    await flush()
    // The panel really is mid-run: the first regenerate went out and has not come back.
    expect(controller.generate).toHaveBeenCalledTimes(1)

    panel.cancelGenerate()
    await flush()

    const posted = vscodeMock.createdPanels[0]!.webview.postedMessages as { type?: string; busy?: boolean; reason?: string }[]
    // The spinner is taken down. A preview that still looks busy after Cancel is the complaint
    // this whole feature answers.
    expect(posted.some((m) => m.type === 'busy' && m.busy === false)).toBe(true)
    // And there is a sentence on screen saying so -- an empty viewer is also what a broken panel
    // looks like.
    expect(posted.some((m) => m.reason === PREVIEW_CANCELLED)).toBe(true)
    // Never an error notification: the user chose this.
    expect(vscodeMock.errorMessages.length).toBe(0)
  })

  it('a later regenerate works, and its result is shown', async () => {
    const controller = makeHangingController()
    const panel = makePanel(controller)
    await flush()
    panel.cancelGenerate()
    await flush()

    // The next run answers normally -- the panel is not left in a cancelled state it cannot
    // leave, which is the other half of "Cancel did not break anything".
    controller.generate.mockImplementation(async () => ({ diagnostics: [] }))
    panel.notifyDocumentChanged(makeDocument())
    await flush()
    await flush()

    expect(controller.generate).toHaveBeenCalledTimes(2)
    const posted = vscodeMock.createdPanels[0]!.webview.postedMessages as { type?: string }[]
    expect(posted.some((m) => m.type === 'result')).toBe(true)
  })

  it('cancelling when nothing is running is harmless', async () => {
    const controller = makeHangingController()
    const panel = makePanel(controller)
    await flush()
    panel.cancelGenerate()
    await flush()
    const before = vscodeMock.createdPanels[0]!.webview.postedMessages.length
    // Twice more, after it has already settled. The engine treats a cancel for a finished id as a
    // no-op and so must this side.
    panel.cancelGenerate()
    panel.cancelGenerate()
    await flush()
    expect(vscodeMock.createdPanels[0]!.webview.postedMessages.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// The graph panel
// ---------------------------------------------------------------------------

describe('GraphPanel: a cancelled graph', () => {
  const PACK_ROOT = '/pack'

  beforeEach(() => {
    vscodeMock.createdPanels.length = 0
    disposeLog()
  })

  afterEach(() => {
    for (const panel of GraphPanel.openPanels()) panel.dispose()
    vi.clearAllMocks()
  })

  /** A controller whose `graph` hangs until the request's signal fires, then rejects the way the
   * real one does once the engine has acknowledged the cancel. */
  function makeHangingController(): PreviewController & { graph: ReturnType<typeof vi.fn> } {
    const graph = vi.fn(
      (_root: string, _timeout: number, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new RequestCancelledError('graph')), { once: true })
        }),
    )
    return {
      graph,
      listTypes: vi.fn(async () => ({ types: [] })),
      reloadPack: vi.fn(async () => ({ warnings: [], featureCount: 1, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    } as unknown as PreviewController & { graph: ReturnType<typeof vi.fn> }
  }

  async function openReadyPanel(controller: PreviewController): Promise<{ panel: GraphPanel; posted: unknown[] }> {
    const panel = GraphPanel.show(
      vscodeMock.Uri.file('/ext') as unknown as import('vscode').Uri,
      controller,
      PACK_ROOT,
      5000,
      () => {},
      () => {},
    )
    const created = vscodeMock.createdPanels.at(-1)
    if (!created) throw new Error('GraphPanel.show created no webview panel')
    created.webview.simulateMessage({ type: 'ready' })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    return { panel, posted: created.webview.postedMessages }
  }

  it('leaves the canvas saying it was cancelled, with a way back, rather than on a spinner', async () => {
    const controller = makeHangingController()
    const { panel, posted } = await openReadyPanel(controller)
    expect(controller.graph).toHaveBeenCalledTimes(1)

    panel.cancelGraph()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const cancelled = posted.find((m) => (m as { type?: string })?.type === 'graphCancelled') as
      | { retry?: boolean }
      | undefined
    expect(cancelled, `posted: ${JSON.stringify(posted.map((m) => (m as { type?: string })?.type))}`).toBeDefined()
    // Retry is the way back. Without it a cancelled panel is a dead panel, and the only route to a
    // graph is closing it and running the command again.
    expect(cancelled?.retry).toBe(true)
    // Not reported as a failure anywhere: no graphError, no notification.
    expect(posted.some((m) => (m as { type?: string })?.type === 'graphError')).toBe(false)
    expect(vscodeMock.errorMessages.length).toBe(0)
  })

  it('and the sentence on the canvas says so without calling it an error', () => {
    const message = graphCancelledMessage()
    expect(message).toMatch(/cancelled/i)
    expect(message).toMatch(/retry/i)
    expect(message).not.toMatch(/fail|error/i)
  })

  it('a retry after a cancellation builds the graph and draws it', async () => {
    const controller = makeHangingController()
    const { panel, posted } = await openReadyPanel(controller)
    panel.cancelGraph()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    controller.graph.mockImplementation(async () => ({ nodes: [{ id: 'test:alpha', typeId: 'minecraft:single_block_feature', file: 'features/alpha.json' }], edges: [], roots: ['test:alpha'], diagnostics: [] }))
    await panel.retry()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(posted.some((m) => (m as { type?: string })?.type === 'graph')).toBe(true)
  })
})
