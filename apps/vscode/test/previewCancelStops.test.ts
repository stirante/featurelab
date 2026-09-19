// previewCancelStops.test.ts -- two things the preview panel owes the person watching it: a run
// they can stop, and an answer when it places nothing.
//
// WHY THIS SUITE EXISTS.
//
//   - CANCEL. The engine has had request cancellation for a while and the viewport now draws a
//     Cancel pill, but the pill posts a message and nothing on the host had a case for it -- so
//     the button was drawn, pressed, and did nothing, which is worse than not offering it. And
//     "cancelled" is not "failed": nothing went wrong, the pack was not touched, and the very next
//     regenerate has to work as if the cancel had never happened.
//   - STOPS. "Placed nothing" and "placed nothing because iterations evaluated to 0, 412 times"
//     are the same picture and completely different answers. The rows saying which used to ride
//     the PROFILE, and a profile is only requested when the graph has put this panel into
//     attribution mode -- so the explanation was missing in exactly the default case it exists
//     for. They now travel at the top level of a generate response and this host must carry them
//     through untouched, including the difference between "none" and "this engine cannot say".
//
// Runs against fixtures/vscodeMock.ts, like previewPanel.test.ts, and drives the real
// src/previewPanel.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { CANCEL_MESSAGE_TYPE, PREVIEW_CANCELLED, PreviewPanel } from '../src/previewPanel.js'
import { RequestCancelledError } from '../src/engineProcess.js'
import type { PreviewController } from '../src/previewController.js'
import type { RunStatsWire } from '../src/graphPanel.js'

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

/** A controller whose generate honours the AbortSignal the panel hands it, the way the real one
 * does through EngineProcess -- a cancel that the fake simply ignored would make every assertion
 * below a statement about the fake. */
function makeController(results: unknown[] = [{ diagnostics: [] }]) {
  let next = 0
  const signals: (AbortSignal | undefined)[] = []
  const generate = vi.fn(
    (_packRoot: string, _params: unknown, _timeoutMs: number, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        signals.push(signal)
        const answer = results[Math.min(next++, results.length - 1)]
        // Deferred a tick, so a test has somewhere to press Cancel from.
        const timer = setTimeout(() => resolve(answer), 5)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new RequestCancelledError('generate'))
          },
          { once: true },
        )
      }),
  )
  const controller = {
    generate,
    generateGrown: vi.fn(async () => ({ diagnostics: [] })),
    reloadPack: vi.fn(async () => ({ warnings: [], featureCount: 0, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    reloadPackFile: vi.fn(async () => ({ warnings: [], featureCount: 0, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    listEnvironments: vi.fn(async () => []),
  }
  return { controller: controller as unknown as PreviewController, generate, signals }
}

function makePanel(controller: PreviewController, graphLink?: Record<string, unknown>): PreviewPanel {
  const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
  return new PreviewPanel(
    { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
    controller,
    diagCollection,
    makeDocument(),
    () => {},
    undefined,
    graphLink as never,
  )
}

/** Lets the panel's promise chain -- and the fake engine's 5ms answer -- run to a standstill. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2))
}

function posted(webview: vscodeMock.MockWebview, type: string): Record<string, unknown>[] {
  return webview.postedMessages.filter((m): m is Record<string, unknown> => (m as { type?: string })?.type === type)
}

beforeEach(() => {
  vscodeMock.resetMock()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('pressing Cancel on the busy pill', () => {
  it('stops the run in flight and leaves the panel saying so, not erroring', async () => {
    const { controller } = makeController()
    const panel = makePanel(controller)
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })

    // What webview/main.ts posts when the pill's Cancel is clicked.
    webview.simulateMessage({ type: CANCEL_MESSAGE_TYPE })
    await settle()

    // The spinner comes down...
    const busy = posted(webview, 'busy')
    expect(busy[busy.length - 1]?.['busy']).toBe(false)
    // ...and something is on screen saying what happened. An empty viewer with no spinner is
    // also what a broken panel looks like.
    const stale = posted(webview, 'stale').filter((m) => m['stale'] === true)
    expect(stale[stale.length - 1]?.['reason']).toBe(PREVIEW_CANCELLED)
    // Nothing failed, so nothing is reported as a failure.
    expect(vscodeMock.errorMessages).toEqual([])
    expect(posted(webview, 'error')).toEqual([])
    panel.dispose()
  })

  it('leaves the next regenerate working, as if the cancel had never happened', async () => {
    const { controller, generate } = makeController([{ diagnostics: [], blocks: 1 }])
    const panel = makePanel(controller)
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    webview.simulateMessage({ type: CANCEL_MESSAGE_TYPE })
    await settle()
    expect(posted(webview, 'result')).toEqual([])

    // The user changes a control. This is the whole point of cancelling rather than closing.
    webview.simulateMessage({ type: 'generate', params: { feature: 'wiki:poplar_tree', env: 'plains' } })
    await settle()

    expect(generate).toHaveBeenCalledTimes(2)
    expect(posted(webview, 'result')).toHaveLength(1)
    // And the second request got a FRESH signal -- reusing the aborted one would cancel the new
    // run before it was sent, which is a Cancel button that permanently breaks the panel.
    const stale = posted(webview, 'stale')
    expect(stale[stale.length - 1]?.['stale']).toBe(false)
    panel.dispose()
  })

  it('is harmless when nothing is running', async () => {
    const { controller } = makeController()
    const panel = makePanel(controller)
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()
    const before = posted(webview, 'result').length

    // By the time somebody reaches the button the answer may already have arrived.
    webview.simulateMessage({ type: CANCEL_MESSAGE_TYPE })
    await settle()

    expect(posted(webview, 'result')).toHaveLength(before)
    expect(posted(webview, 'stale').filter((m) => m['reason'] === PREVIEW_CANCELLED)).toEqual([])
    expect(vscodeMock.errorMessages).toEqual([])
    panel.dispose()
  })

  it('stops the run when the panel is closed, rather than leaving it running for nobody', async () => {
    const { controller, signals } = makeController()
    const panel = makePanel(controller)
    vscodeMock.createdPanels[0]!.webview.simulateMessage({ type: 'ready' })

    panel.dispose()
    await settle()

    expect(signals[0]?.aborted).toBe(true)
  })
})

describe('the stop reasons a run reports', () => {
  const STOPS = [{ identifier: 'wiki:poplar_tree', reason: 'iterations_zero', detail: 'iterations = 0', count: 412 }]

  it('reach the webview with profiling off, which is the case they exist for', async () => {
    // No graph link, so nothing arms profiling: the ordinary preview somebody opens on a file.
    const { controller, generate } = makeController([{ diagnostics: [], stops: STOPS }])
    const panel = makePanel(controller)
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()

    expect(generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, expect.any(Number), expect.anything())
    const result = posted(webview, 'result')[0]?.['result'] as { stops?: unknown[] }
    expect(result.stops).toEqual(STOPS)
    panel.dispose()
  })

  it('survive as an EMPTY array, which is a different answer from having none to give', async () => {
    // "This engine reports stops and there were none" must not be flattened into "this engine
    // cannot say" -- the viewer phrases those two differently on purpose.
    const { controller } = makeController([{ diagnostics: [], stops: [] }])
    const panel = makePanel(controller)
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()

    const result = posted(webview, 'result')[0]?.['result'] as Record<string, unknown>
    expect('stops' in result).toBe(true)
    expect(result['stops']).toEqual([])
    panel.dispose()
  })

  it('are simply absent for an engine that predates the field, rather than invented', async () => {
    const { controller } = makeController([{ diagnostics: [] }])
    const panel = makePanel(controller)
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()

    const result = posted(webview, 'result')[0]?.['result'] as Record<string, unknown>
    expect('stops' in result).toBe(false)
    panel.dispose()
  })
})

describe('the numbers a graph-driven preview sends back', () => {
  it('are reported even when the panel is not attributing anything, so stale ones come off', async () => {
    // The early return this replaces meant a graph-driven preview that was not in attribution
    // mode never told the graph anything -- so the cards went on wearing measurements from some
    // earlier run, indefinitely, with nothing to say they were about a different run.
    const told: (RunStatsWire | null)[] = []
    const { controller } = makeController([{ diagnostics: [] }])
    const panel = makePanel(controller, {
      attributeNodeId: null,
      onRunStats: (_packRoot: string, stats: RunStatsWire | null) => told.push(stats),
    })
    vscodeMock.createdPanels[0]!.webview.simulateMessage({ type: 'ready' })
    await settle()

    expect(told).toHaveLength(1)
    // Null profile: the run had none, and null is what takes the old numbers off the cards.
    expect(told[0]?.profile).toBeNull()
    expect(told[0]?.previewed).toBe('wiki:poplar_tree')
    panel.dispose()
  })
})
