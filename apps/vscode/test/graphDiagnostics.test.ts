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
import { describePackContents } from '../src/packContents.js'
import { emptyGraphMessage } from '../src/graph/emptyState.js'
import { graphDiagnostics, type GraphDiagnostic, type PreviewController } from '../src/previewController.js'

/** A pack root that does not exist on disk. Deliberate: refresh() reads a layout sidecar from
 * there, and "no sidecar" is the normal case for a pack nobody has arranged yet. */
const PACK_ROOT = '/pack'

const REFUSED_FILE_DIAGNOSTIC: GraphDiagnostic = {
  level: 'error',
  fileId: 'buried.json',
  message: '"description" is required by the engine\'s schema and must be an object',
}

/** The same thing from the current engine: pack-relative path, scope, and the 1-based place the
 * JSON loader stopped reading at. This is what a file cut off mid-write actually produces. */
const TRUNCATED_FILE_DIAGNOSTIC: GraphDiagnostic = {
  level: 'error',
  fileId: 'features/poplar_tree.json',
  scope: 'pack',
  line: 4,
  column: 57,
  message: 'invalid JSON at line 4, column 57: unexpected end of JSON input',
}

/** What `loadPack` answers for a pack of 56 feature files, one of which will not parse. The pair
 * of numbers is the whole fix: `featureCount` is what BUILT, `fileCounts.features` is what was
 * read off disk, and before they were separated both of them said 56. */
const ONE_BROKEN_OF_FIFTY_SIX = {
  warnings: [],
  featureCount: 55,
  structureCount: 0,
  ruleCount: 0,
  biomeCount: 0,
  fileCounts: { features: 56, structures: 0, rules: 0, biomes: 0 },
  diagnostics: [TRUNCATED_FILE_DIAGNOSTIC],
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

function makeController(graph: unknown, summary?: unknown): PreviewController {
  return {
    graph: vi.fn(async () => graph),
    listTypes: vi.fn(async () => ({ types: [] })),
    // Deliberately REJECTS when a test does not supply one. The panel asks for it to learn what
    // the load said about the pack, and "the summary could not be read" has to leave a drawable
    // graph behind -- so the tests that are not about the summary prove that too, for free.
    loadPackSummary: vi.fn(async () => {
      if (summary === undefined) throw new Error('vscodeMock: loadPackSummary is not wired')
      return summary
    }),
  } as unknown as PreviewController
}

/** Opens a panel and lets it do what it does when the webview announces itself: send the type
 * table, then the graph. Returns the messages the host posted. */
async function openAndReady(controller: PreviewController): Promise<unknown[]> {
  const { posted, panel } = await openLive(controller)
  panel.dispose()
  return posted
}

/** openAndReady's "leave it open" form, for a test that then sends the panel another message.
 * The caller disposes -- or lets the suite's afterEach do it. */
async function openLive(controller: PreviewController): Promise<{ posted: unknown[]; panel: GraphPanel; webview: { simulateMessage(m: unknown): void; postedMessages: unknown[] } }> {
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
  for (let i = 0; i < 20; i++) await Promise.resolve()
  return { posted: [...created.webview.postedMessages], panel, webview: created.webview as unknown as { simulateMessage(m: unknown): void; postedMessages: unknown[] } }
}

function graphMessage(posted: unknown[]): Record<string, unknown> {
  const message = posted.find((m) => (m as { type?: string })?.type === 'graph')
  expect(message, `no 'graph' message was posted; got ${JSON.stringify(posted.map((m) => (m as { type?: string })?.type))}`).toBeDefined()
  return message as Record<string, unknown>
}

beforeEach(() => {
  vscodeMock.resetMock()
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

describe('a pack with one truncated file', () => {
  // THE CASE THE WHOLE CHANGE IS FOR. 56 feature files on disk, one of them cut off mid-write.
  // The engine used to answer `featureCount: 56` -- indistinguishable from the pack intact -- and
  // the graph simply drew one node fewer with nothing anywhere saying why.

  it('hands the canvas the loaded-against-read counts, so the pack reads as 55 of 56', async () => {
    const posted = await openAndReady(makeController(graphResponse([TRUNCATED_FILE_DIAGNOSTIC]), ONE_BROKEN_OF_FIFTY_SIX))
    const contents = graphMessage(posted).packContents as { fileCounts?: { features?: number } }
    expect(contents).toBeDefined()
    // BOTH numbers, in the one payload. Either alone is a number the reader cannot check: 55 on
    // its own is the pack looking healthy and smaller, 56 on its own is the original bug.
    expect(contents.fileCounts?.features).toBe(56)
    expect(describePackContents(ONE_BROKEN_OF_FIFTY_SIX)).toContain('55 of 56 feature file(s) loaded')
  })

  it('names the file and its line and column on the canvas', async () => {
    const posted = await openAndReady(makeController(graphResponse([TRUNCATED_FILE_DIAGNOSTIC]), ONE_BROKEN_OF_FIFTY_SIX))
    const contents = graphMessage(posted).packContents as Parameters<typeof emptyGraphMessage>[3]
    // The canvas composes the sentence from exactly this payload, so asserting the payload
    // through the function that reads it is asserting what a person actually sees.
    const said = emptyGraphMessage(0, 1, [], contents)
    expect(said).toContain('features/poplar_tree.json 4:57')
    expect(said).toMatch(/could not be read/i)
  })

  it('writes the position into the log too, not just the file', async () => {
    await openAndReady(makeController(graphResponse([TRUNCATED_FILE_DIAGNOSTIC]), ONE_BROKEN_OF_FIFTY_SIX))
    const lines = vscodeMock.outputLines.join('\n')
    expect(lines).toContain('features/poplar_tree.json 4:57')
    expect(lines).toContain('55 of 56 feature file(s) loaded')
  })

  it('still draws the graph, and still sends packContents, when the summary cannot be read', async () => {
    // An engine that refuses loadPack, or one too old to answer it -- the graph is the thing the
    // user asked for and must not be lost to a failure in the sentence beside it.
    const posted = await openAndReady(makeController(graphResponse([REFUSED_FILE_DIAGNOSTIC])))
    const message = graphMessage(posted)
    expect((message.graph as { nodes: unknown[] }).nodes).toHaveLength(1)
    // Present and empty, never absent: a renderer that has to tell undefined from {} before it
    // can decide whether to show anything is a renderer with a reason to get it wrong.
    expect(message.packContents).toEqual({})
  })

  it('omits fileCounts rather than inventing zeros when the engine does not send them', async () => {
    const posted = await openAndReady(
      makeController(graphResponse([]), { warnings: [], featureCount: 3, structureCount: 0, ruleCount: 0, biomeCount: 0 }),
    )
    const contents = graphMessage(posted).packContents as { fileCounts?: unknown; diagnostics?: unknown }
    // Zeros here would read as "your pack is empty", which is the exact wrong answer and the one
    // an older binary would have produced on every load.
    expect(contents.fileCounts).toBeUndefined()
    expect(contents.diagnostics).toBeUndefined()
  })
})

describe('opening the file a diagnostic names', () => {
  it('puts the cursor on the problem when the engine said where it is', async () => {
    const { panel, webview } = await openLive(makeController(graphResponse([TRUNCATED_FILE_DIAGNOSTIC]), ONE_BROKEN_OF_FIFTY_SIX))
    vscodeMock.workspace.openTextDocument.mockResolvedValueOnce({ uri: vscodeMock.Uri.file('/pack/features/poplar_tree.json') })
    webview.simulateMessage({ type: 'openFile', file: 'features/poplar_tree.json' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    panel.dispose()

    expect(vscodeMock.shownDocuments).toHaveLength(1)
    const selection = (vscodeMock.shownDocuments[0]!.options as { selection?: { startLine: number; startChar: number } }).selection
    // 1-based on the wire, 0-based in VS Code. The off-by-one is the only arithmetic on this path
    // and the only way it can go wrong silently: a squiggle one line above the problem looks
    // authoritative and is worse than no squiggle at all.
    expect(selection).toBeDefined()
    expect(selection!.startLine).toBe(3)
    expect(selection!.startChar).toBe(56)
  })

  it('opens the file with no selection when there is no position to open it at', async () => {
    const { panel, webview } = await openLive(
      makeController(graphResponse([REFUSED_FILE_DIAGNOSTIC]), { ...ONE_BROKEN_OF_FIFTY_SIX, diagnostics: [REFUSED_FILE_DIAGNOSTIC] }),
    )
    vscodeMock.workspace.openTextDocument.mockResolvedValueOnce({ uri: vscodeMock.Uri.file('/pack/buried.json') })
    webview.simulateMessage({ type: 'openFile', file: 'buried.json' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    panel.dispose()

    expect(vscodeMock.shownDocuments).toHaveLength(1)
    expect((vscodeMock.shownDocuments[0]!.options as { selection?: unknown }).selection).toBeUndefined()
  })

  it('still refuses a path this host never reported a problem in', async () => {
    // The allow-list became a Map to carry the positions; it is still an allow-list, and that is
    // the only thing standing between `openFile` and "open anything you like".
    const { panel, webview } = await openLive(makeController(graphResponse([TRUNCATED_FILE_DIAGNOSTIC]), ONE_BROKEN_OF_FIFTY_SIX))
    webview.simulateMessage({ type: 'openFile', file: '../../../etc/passwd' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const refusal = webview.postedMessages.find((m) => (m as { type?: string })?.type === 'editError')
    panel.dispose()
    expect(refusal).toBeDefined()
    expect(vscodeMock.shownDocuments).toHaveLength(0)
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
