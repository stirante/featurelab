// graphDiagnostics.test.ts -- does a file the engine refused reach the webview at all?
//
// The bug this is about had no symptom to see: an author adds a feature rule file by hand, gets
// one nesting level wrong, and the engine refuses the whole file. `check` says so at error level.
// The graph editor drew a correct graph of everything that DID load, with no node for the file,
// no message, and no way to find out why -- the file simply was not there.
//
// So there are two things worth pinning on this side, and they are different things:
//
//   1. The payload the webview is handed carries the diagnostics. That is the plumbing, and it is
//      what the renderer (someone else's change, in webview/graph.ts) will read.
//   2. The extraction survives an engine that does not send them. The extension resolves whatever
//      `featurelab` binary it finds, which can be older than the extension itself; a panel that
//      threw on a missing field would turn an out-of-date binary into a broken editor.
//
// Runs against fixtures/vscodeMock.ts with a stub controller, so it is about the host's plumbing
// and nothing else -- the engine's own half is pinned in cmd/featurelab/graph_test.go.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { GraphPanel } from '../src/graphPanel.js'
import { graphDiagnostics, type GraphDiagnostic, type PreviewController } from '../src/previewController.js'

/** A pack root that does not exist on disk. Deliberate: refresh() reads a layout sidecar from
 * there, and "no sidecar" is the normal case for a pack nobody has arranged yet. */
const PACK_ROOT = '/pack'

const REFUSED_FILE_DIAGNOSTIC: GraphDiagnostic = {
  level: 'error',
  fileId: 'buried.json',
  message: '"description" is required by the engine\'s schema and must be an object',
}

/** A graph response shaped like the engine's: the nodes that loaded, plus what it refused. */
function graphResponse(diagnostics: unknown): unknown {
  return {
    nodes: [{ id: 'test:alpha', typeId: 'minecraft:single_block_feature', file: 'features/alpha.json' }],
    edges: [],
    roots: ['test:alpha'],
    diagnostics,
  }
}

function makeController(graph: unknown): PreviewController {
  return {
    graph: vi.fn(async () => graph),
    listTypes: vi.fn(async () => ({ types: [] })),
  } as unknown as PreviewController
}

/** Opens a panel and lets it do what it does when the webview announces itself: send the type
 * table, then the graph. Returns the messages the host posted. */
async function openAndReady(controller: PreviewController): Promise<unknown[]> {
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
  // 'ready' is handled asynchronously (types, then the graph round trip).
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const posted = [...created.webview.postedMessages]
  panel.dispose()
  return posted
}

function graphMessage(posted: unknown[]): Record<string, unknown> {
  const message = posted.find((m) => (m as { type?: string })?.type === 'graph')
  expect(message, `no 'graph' message was posted; got ${JSON.stringify(posted.map((m) => (m as { type?: string })?.type))}`).toBeDefined()
  return message as Record<string, unknown>
}

beforeEach(() => {
  vscodeMock.createdPanels.length = 0
})

afterEach(() => {
  for (const panel of GraphPanel.openPanels()) panel.dispose()
  vi.clearAllMocks()
})

describe('the graph payload', () => {
  it('carries the diagnostics for a file the engine refused', async () => {
    const posted = await openAndReady(makeController(graphResponse([REFUSED_FILE_DIAGNOSTIC])))
    const message = graphMessage(posted)

    expect(message.diagnostics).toEqual([REFUSED_FILE_DIAGNOSTIC])
  })

  it('carries an empty list for a pack that loaded cleanly', async () => {
    // Not "no field": a renderer that has to tell `undefined` from `[]` before it can decide
    // whether to show anything is a renderer with a reason to get it wrong.
    const posted = await openAndReady(makeController(graphResponse([])))
    expect(graphMessage(posted).diagnostics).toEqual([])
  })

  it('still sends the graph itself, unchanged, beside them', async () => {
    // A refused file must not cost the author the graph of everything that did load -- that
    // would trade one silence for a worse one.
    const posted = await openAndReady(makeController(graphResponse([REFUSED_FILE_DIAGNOSTIC])))
    const message = graphMessage(posted)
    expect((message.graph as { nodes: unknown[] }).nodes).toHaveLength(1)
    expect(message.positions).toBeDefined()
  })

  it('posts an empty list when the engine is too old to send any', async () => {
    const posted = await openAndReady(makeController({ nodes: [], edges: [], roots: [] }))
    expect(graphMessage(posted).diagnostics).toEqual([])
  })
})

describe('graphDiagnostics', () => {
  it('reads the engine\'s array through', () => {
    expect(graphDiagnostics(graphResponse([REFUSED_FILE_DIAGNOSTIC]))).toEqual([REFUSED_FILE_DIAGNOSTIC])
  })

  it('answers [] for a response without the field, rather than throwing', () => {
    expect(graphDiagnostics({ nodes: [], edges: [], roots: [] })).toEqual([])
    expect(graphDiagnostics(null)).toEqual([])
    expect(graphDiagnostics(undefined)).toEqual([])
  })

  it('drops entries that are not diagnostics and keeps the ones that are', () => {
    // Per entry, not per response: one malformed entry must not discard a real error beside it.
    const mixed = graphDiagnostics(
      graphResponse([null, 'not an object', { level: 'error' }, REFUSED_FILE_DIAGNOSTIC, { level: 1, fileId: 2, message: 3 }]),
    )
    expect(mixed).toEqual([REFUSED_FILE_DIAGNOSTIC])
  })
})
