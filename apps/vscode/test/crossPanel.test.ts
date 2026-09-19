// crossPanel.test.ts -- the places where the preview panel and the graph panel have to agree
// about one run, one file and one selection, and the ways they were found not to.
//
// Everything here was reproduced by driving both real webview bundles against the real engine,
// and every test is written against what a PERSON would see rather than against which method was
// called: a Problems panel that goes blank, a readout that contradicts the legend under it, a
// filter nobody typed, coloured cells nothing names. That is deliberate -- most of these bugs
// were silent, and a test asserting "updateDiagnostics was invoked" would pass on every one of
// them.
//
// The engine spelling half (see the first describe) is the only one that needs real files: it is
// about a path, and a path has to be a real one for path.relative to mean anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { PREVIEW_PARAMS_VERSION, PreviewPanel, freshPreviewParams, previewParamsKey } from '../src/previewPanel.js'
import { GraphPanel, graphViewStateKey, setGraphPanelState } from '../src/graphPanel.js'
import type { PreviewController } from '../src/previewController.js'

const FEATURE_JSON = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:tree_feature': { description: { identifier: 'wiki:fancy_oak_tree' } },
})
const RENAMED_JSON = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:tree_feature': { description: { identifier: 'wiki:fancy_oak_tree_renamed' } },
})

/** Every temp directory a test made, removed afterwards. */
const temporary: string[] = []

/** A behaviour pack on disk -- real files, because resolvePackRoot and the pack-relative
 * spelling this suite is about both walk the real filesystem. */
function makePack(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-cross-'))
  temporary.push(root)
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"format_version":2}', 'utf8')
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }
  return root
}

/** A stand-in TextDocument. `scheme` is 'file' only when a test asks for it, because
 * disposeIfDocumentGone deliberately leaves a non-file document alone. */
function makeDocument(fsPath: string, text = FEATURE_JSON, scheme?: string): import('vscode').TextDocument {
  const lines = text.split('\n')
  return {
    uri: { fsPath, scheme, toString: () => `file://${fsPath.replace(/\\/g, '/')}` },
    fileName: fsPath,
    getText: () => text,
    lineCount: lines.length,
    lineAt: (i: number) => ({ text: lines[i] ?? '' }),
  } as unknown as import('vscode').TextDocument
}

interface FakeController extends PreviewController {
  generate: ReturnType<typeof vi.fn>
  generateGrown: ReturnType<typeof vi.fn>
  reloadPack: ReturnType<typeof vi.fn>
  reloadPackFile: ReturnType<typeof vi.fn>
  listEnvironments: ReturnType<typeof vi.fn>
}

function makeController(result: unknown = { diagnostics: [] }): FakeController {
  let next = result
  const ctl = {
    generate: vi.fn(async () => next),
    generateGrown: vi.fn(async () => next),
    reloadPack: vi.fn(async () => ({ warnings: [] })),
    reloadPackFile: vi.fn(async () => ({ warnings: [] })),
    listEnvironments: vi.fn(async () => []),
    binaryPath: '/fake/featurelab',
    setNextResult: (r: unknown) => {
      next = r
    },
  }
  return ctl as unknown as FakeController
}

function collection(): import('vscode').DiagnosticCollection & { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  return { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection & {
    set: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
}

function context(store = new vscodeMock.MockMemento()): import('vscode').ExtensionContext {
  return {
    extensionUri: vscodeMock.Uri.file('/ext'),
    workspaceState: store,
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 5))
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function posted(webview: vscodeMock.MockWebview, type: string): Record<string, unknown>[] {
  return webview.postedMessages.filter((m) => (m as { type?: string })?.type === type) as Record<string, unknown>[]
}

/** The warning the real engine emits about this very fixture, under whichever `fileId` spelling
 * the build in use happens to produce. */
function warningFor(fileId: string): { level: string; fileId: string; message: string } {
  return { level: 'warning', fileId, message: 'may_grow_through is set, but this trunk kind does not consult it in this tool' }
}

/** A profiled run in which `identifier` wrote three cells -- enough for AttributionIndex to build
 * a real table, which is what makes "the old name resolves to nothing against it" a genuine
 * state rather than the ordinary no-profile one. */
function profileFor(identifier: string): unknown {
  return {
    featureIdentifiers: [identifier],
    features: [{ identifier, entered: 1, blocksWritten: 3, delegations: 0, selfMs: 1, inclusiveMs: 1 }],
    attribution: { cell: [0, 1, 2], feature: [0, 0, 0], count: [1, 1, 1] },
  }
}

beforeEach(() => {
  vscodeMock.resetMock()
})

afterEach(() => {
  for (const panel of GraphPanel.openPanels()) panel.dispose()
  setGraphPanelState(null)
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('the Problems panel and the engine’s file spelling', () => {
  // THE REGRESSION. The engine's loader moved from keying a file by its basename
  // ("tree_acacia_branching.json") to keying it pack-relative ("features/tree_acacia_branching
  // .json"); the preview went on filtering by basename alone, matched 0 of 4 real diagnostics,
  // and -- because "matched nothing" is indistinguishable here from "nothing to say" -- DELETED
  // the collection. VS Code's Problems view went blank with no message, while the panel's own
  // Diagnostics section (which never filtered) went on listing all four. That self-healing list
  // is why this survived: only the half nobody was looking at broke.
  //
  // Both spellings are asserted because both are live: featurelab.binaryPath can point at an
  // older engine than the one this extension shipped with.
  async function run(diagnostics: unknown[]): Promise<{ diags: ReturnType<typeof collection>; ctl: FakeController }> {
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const diags = collection()
    const ctl = makeController({ diagnostics })
    new PreviewPanel(context(), ctl, diags, makeDocument(documentPath), () => {})
    await settle()
    return { diags, ctl }
  }

  it('keeps a diagnostic the CURRENT engine keys pack-relative', async () => {
    const { diags } = await run([warningFor('features/tree_fancy_oak.json')])
    expect(diags.delete).not.toHaveBeenCalled()
    expect(diags.set).toHaveBeenCalledTimes(1)
    expect((diags.set.mock.calls[0]![1] as unknown[]).length).toBe(1)
  })

  it('keeps a diagnostic an OLDER engine keys by basename', async () => {
    const { diags } = await run([warningFor('tree_fancy_oak.json')])
    expect(diags.delete).not.toHaveBeenCalled()
    expect((diags.set.mock.calls[0]![1] as unknown[]).length).toBe(1)
  })

  it('keeps a placement-time diagnostic, which is keyed by the requested identifier instead', async () => {
    const { diags } = await run([warningFor('wiki:fancy_oak_tree')])
    expect((diags.set.mock.calls[0]![1] as unknown[]).length).toBe(1)
  })

  it('takes all three at once and drops only what is genuinely about another file', async () => {
    const { diags } = await run([
      warningFor('features/tree_fancy_oak.json'),
      warningFor('tree_fancy_oak.json'),
      warningFor('wiki:fancy_oak_tree'),
      warningFor('features/tree_acacia_branching.json'),
      warningFor('(blocks)'),
    ])
    // Three kept; the acacia warning and the pack-wide block note belong on other files and are
    // shown in the panel's own Diagnostics section, not squiggled onto this document.
    expect((diags.set.mock.calls[0]![1] as unknown[]).length).toBe(3)
  })

  it('still clears the collection when the run really has nothing to say about this file', async () => {
    const { diags } = await run([warningFor('features/something_else.json')])
    expect(diags.set).not.toHaveBeenCalled()
    expect(diags.delete).toHaveBeenCalledTimes(1)
  })
})

describe('a feature renamed in the editor', () => {
  /** Opens a preview attributing a node, lets it settle, then re-runs it against a pack in which
   * that identifier has been renamed -- i.e. a save, a reload and a regenerate. */
  async function renameRun(): Promise<{ webview: vscodeMock.MockWebview; panel: PreviewPanel; document: import('vscode').TextDocument }> {
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const ctl = makeController({
      diagnostics: [],
      entries: [{ identifier: 'wiki:fancy_oak_tree', fileId: 'features/tree_fancy_oak.json', typeId: 'minecraft:tree_feature' }],
      profile: profileFor('wiki:fancy_oak_tree'),
    })
    const panel = new PreviewPanel(context(), ctl, collection(), makeDocument(documentPath), () => {}, undefined, {
      attributeNodeId: 'wiki:fancy_oak_tree',
    })
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()

    // The rename, as the author makes it: the file's own text changes and the pack no longer
    // defines the old identifier.
    // The new run is a REAL, PROFILED, SUCCESSFUL one -- 79 cells attributed to the new name.
    // That is what made this a contradiction rather than an empty panel: without dropping the
    // old name the bridge resolves it against this table, finds nothing, and the host posts
    // `available: true, cellCount: 0`, which the webview renders as "placed no blocks in this
    // run" beside a legend built from the very same table naming the new node.
    ;(ctl as unknown as { setNextResult(r: unknown): void }).setNextResult({
      diagnostics: [],
      entries: [{ identifier: 'wiki:fancy_oak_tree_renamed', fileId: 'features/tree_fancy_oak.json', typeId: 'minecraft:tree_feature' }],
      profile: profileFor('wiki:fancy_oak_tree_renamed'),
    })
    const renamed = makeDocument(documentPath, RENAMED_JSON)
    webview.postedMessages.length = 0
    panel.notifyPackFileSaved(renamed)
    await settle()
    return { webview, panel, document: renamed }
  }

  it('stops attributing a node the pack no longer defines, instead of saying it "placed no blocks"', async () => {
    // THE CONTRADICTION. The readout said `wiki:fancy_oak_tree placed no blocks in this run`
    // directly above a legend reading `wiki:fancy_oak_tree_renamed  79 blocks` -- two sentences
    // about one run, on one screen, disagreeing, while the graph was already right.
    const { webview } = await renameRun()
    const attribution = posted(webview, 'attribution')
    expect(attribution.length).toBeGreaterThan(0)
    // "Unavailable" is what the webview draws as no overlay and no readout at all -- which is
    // honest. "available: true with a count of nought" is the sentence that was wrong.
    expect(attribution.at(-1)!['available']).toBe(false)
  })

  it('re-seeds the Feature picker from the file’s NEW identifier', async () => {
    // Left alone, the picker held the old name and said `"wiki:fancy_oak_tree" not found in
    // loaded files` under a legend naming the new one.
    const { webview } = await renameRun()
    const init = posted(webview, 'init')
    expect(init.at(-1)).toEqual({ type: 'init', kind: 'feature', identifier: 'wiki:fancy_oak_tree_renamed' })
  })

  it('does NOT re-seed on an ordinary save, so a feature the author picked by hand survives', async () => {
    // `init` overrides whatever the picker shows ("opened file always wins"), which is right on
    // an open and wrong once per save: an author previewing a DIFFERENT feature from the dropdown
    // would have their choice snatched back every time they pressed Ctrl+S.
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const panel = new PreviewPanel(context(), makeController(), collection(), makeDocument(documentPath), () => {})
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()
    webview.postedMessages.length = 0

    panel.notifyPackFileSaved(makeDocument(documentPath))
    await settle()

    expect(posted(webview, 'init')).toHaveLength(0)
  })
})

describe('following a selection from the graph', () => {
  it('takes the previous node’s overlay off the screen the moment the panel is re-pointed', async () => {
    // MID-RACE, 88 cells were painted under an empty readout for about a second, while the graph
    // had already moved on and named the new node. Coloured cells nothing on screen accounts for
    // read as a rendering fault; "no highlight yet" reads as what it is.
    const packRoot = makePack({
      'features/tree_fancy_oak.json': FEATURE_JSON,
      'features/tree_poplar.json': RENAMED_JSON,
    })
    const first = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const second = path.join(packRoot, 'features', 'tree_poplar.json')
    const panel = new PreviewPanel(context(), makeController(), collection(), makeDocument(first), () => {}, undefined, {
      attributeNodeId: 'wiki:fancy_oak_tree',
    })
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()
    webview.postedMessages.length = 0

    panel.retargetTo(makeDocument(second, RENAMED_JSON))

    // SYNCHRONOUSLY, before the queued regenerate has had a chance to run -- the whole failure
    // was the gap between the tab renaming itself and the new result arriving.
    const attribution = posted(webview, 'attribution')
    expect(attribution.at(-1)?.['available']).toBe(false)
  })
})

describe('a preview whose file was deleted', () => {
  it('closes its tab instead of standing there blank, still claiming the path', async () => {
    // The panel blanked and said `not found in loaded files` while `documentUri` went on naming
    // the deleted file -- so it still claimed every save of that path, still counted as THE
    // preview for it, and re-opening a file recreated there revealed this corpse.
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    let disposedWith: PreviewPanel | null = null
    const panel = new PreviewPanel(
      context(),
      makeController(),
      collection(),
      makeDocument(documentPath, FEATURE_JSON, 'file'),
      (p) => {
        disposedWith = p
      },
    )
    const tab = vscodeMock.createdPanels.at(-1)!
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()
    expect(tab.disposed).toBe(false)

    fs.rmSync(documentPath)
    // How the graph announces a delete: it cannot list the referrers, so it names the pack root.
    panel.notifyPackFilesWritten([], [packRoot])
    await settle()

    expect(tab.disposed).toBe(true)
    expect(disposedWith).toBe(panel)
  })

  it('leaves a panel alone when the file is merely unreadable rather than gone', async () => {
    // A non-file document (untitled, a virtual scheme) has no path to test. "I could not look"
    // is not "it is gone", and closing somebody's panel on that would be worse than the bug.
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const panel = new PreviewPanel(context(), makeController(), collection(), makeDocument(documentPath), () => {})
    const tab = vscodeMock.createdPanels.at(-1)!
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()

    fs.rmSync(documentPath)
    panel.notifyPackFilesWritten([], [packRoot])
    await settle()

    expect(tab.disposed).toBe(false)
  })
})

describe('a webview that boots a second time', () => {
  it('is handed the last result again, so a hidden-then-shown tab is not a seeded sidebar over an empty canvas', async () => {
    // A revived tab cannot have retainContextWhenHidden -- it lives on WebviewPanelOptions, fixed
    // at creation and readonly afterwards -- so hiding it tears the page down and showing it
    // rebuilds it from the static HTML and a second `ready`. The outbox was long since flushed,
    // and nothing re-sent: the controls and the picker came back, and the picture did not.
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const tab = new vscodeMock.MockWebviewPanel()
    new PreviewPanel(
      context(),
      makeController({ diagnostics: [], counts: { placed: 79, carved: 0, replaced: 0 } }),
      collection(),
      makeDocument(documentPath),
      () => {},
      undefined,
      {},
      { panel: tab as unknown as import('vscode').WebviewPanel, params: null, grown: false },
    )
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()
    expect(posted(tab.webview, 'result')).toHaveLength(1)

    // The tab is hidden and shown again: same panel object, new page, second `ready`.
    tab.webview.postedMessages.length = 0
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()

    const again = posted(tab.webview, 'result')
    expect(again).toHaveLength(1)
    expect((again[0]!['result'] as { counts?: unknown }).counts).toEqual({ placed: 79, carved: 0, replaced: 0 })
    // And no second run was paid for to produce it.
    expect(posted(tab.webview, 'result')).toHaveLength(1)
  })

  it('posts nothing extra on a first boot that has no result yet', async () => {
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const ctl = makeController()
    ctl.generate.mockImplementation(() => new Promise(() => {})) // never settles
    const tab = new vscodeMock.MockWebviewPanel()
    new PreviewPanel(context(), ctl, collection(), makeDocument(documentPath), () => {}, undefined, {}, {
      panel: tab as unknown as import('vscode').WebviewPanel,
      params: null,
      grown: false,
    })
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()
    expect(posted(tab.webview, 'result')).toHaveLength(0)
  })
})

describe('what a revived tab is allowed to replay', () => {
  // THE FRESHNESS DECISION, stated as tests. The bench (seed, origin, sizes, repeat, preset) is
  // the author's deliberate setup and does not go stale when a file is edited, so no mtime and no
  // content hash: both would answer a question nobody asked, and an mtime check in particular
  // would reset the author's work on every save. The one field that CAN be wrong is the name, and
  // that is checked against the file itself.
  const bench = { seed: 42, originX: 8, repeat: 3, sizeX: 64 }

  it('replays everything when the file still declares what it declared', () => {
    const remembered = {
      version: PREVIEW_PARAMS_VERSION,
      identifier: 'wiki:fancy_oak_tree',
      params: { feature: 'wiki:fancy_oak_tree', ...bench },
      grown: true,
    }
    expect(freshPreviewParams(remembered, 'wiki:fancy_oak_tree')).toEqual({ params: remembered.params, grown: true })
  })

  it('keeps the bench and drops the NAME when the file was renamed between windows', () => {
    const remembered = {
      version: PREVIEW_PARAMS_VERSION,
      identifier: 'wiki:fancy_oak_tree',
      params: { feature: 'wiki:fancy_oak_tree', ...bench },
      grown: false,
    }
    const fresh = freshPreviewParams(remembered, 'wiki:fancy_oak_tree_renamed')
    expect(fresh.params).toEqual(bench)
    expect(fresh.params).not.toHaveProperty('feature')
  })

  it('does the same for a rule', () => {
    const fresh = freshPreviewParams(
      { version: PREVIEW_PARAMS_VERSION, identifier: 'wiki:old_rule', params: { rule: 'wiki:old_rule', ...bench }, grown: false },
      'wiki:new_rule',
    )
    expect(fresh.params).toEqual(bench)
  })

  it('discards a blob written before the stamp existed, rather than guessing about it', () => {
    // No version means no remembered identifier to check against, and the whole point of the
    // stamp is that the code reading workspaceState is routinely not the code that wrote it.
    expect(freshPreviewParams({ params: { feature: 'wiki:gone', ...bench }, grown: true }, 'wiki:fancy_oak_tree')).toEqual({
      params: null,
      grown: false,
    })
    expect(freshPreviewParams(null, 'wiki:fancy_oak_tree')).toEqual({ params: null, grown: false })
    expect(freshPreviewParams({ version: 999, params: { feature: 'x' } }, 'x')).toEqual({ params: null, grown: false })
  })

  it('replays a file that does not parse right now, because a file mid-edit is not a rename', () => {
    const remembered = {
      version: PREVIEW_PARAMS_VERSION,
      identifier: 'wiki:fancy_oak_tree',
      params: { feature: 'wiki:fancy_oak_tree', ...bench },
      grown: false,
    }
    expect(freshPreviewParams(remembered, null).params).toEqual(remembered.params)
  })

  it('stamps what it writes with the version and the identifier of the moment', async () => {
    const packRoot = makePack({ 'features/tree_fancy_oak.json': FEATURE_JSON })
    const documentPath = path.join(packRoot, 'features', 'tree_fancy_oak.json')
    const store = new vscodeMock.MockMemento()
    const document = makeDocument(documentPath)
    new PreviewPanel(context(store), makeController(), collection(), document, () => {})
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    webview.simulateMessage({ type: 'ready' })
    const chosen = { feature: 'wiki:fancy_oak_tree', ...bench }
    webview.simulateMessage({ type: 'generate', params: chosen })
    await settle()

    expect(store.get(previewParamsKey(document.uri.toString()))).toEqual({
      version: PREVIEW_PARAMS_VERSION,
      identifier: 'wiki:fancy_oak_tree',
      params: chosen,
      grown: false,
    })
  })
})

describe('the graph’s remembered view state', () => {
  function openGraph(): { panel: GraphPanel; webview: vscodeMock.MockWebview } {
    const panel = GraphPanel.show(
      vscodeMock.Uri.file('/ext') as unknown as import('vscode').Uri,
      {
        graph: vi.fn(async () => ({ nodes: [], edges: [], roots: [] })),
        listTypes: vi.fn(async () => ({ types: [] })),
        loadPackSummary: vi.fn(async () => ({ warnings: [], fileCounts: {}, diagnostics: [] })),
      } as unknown as PreviewController,
      '/pack',
      5000,
      () => {},
      () => {},
    )
    return { panel, webview: vscodeMock.createdPanels.at(-1)!.webview }
  }

  it('does not keep the search query', async () => {
    // A SEARCH IS A QUESTION, NOT A SETTING. Restored, `search: 'pumpkin'` came back as a pack
    // with 44 of its 57 cards missing and a filter nobody remembered typing -- which reads as
    // "half my features failed to load". Every other way of hiding a node in this editor is
    // visible in the UI that hid it; this one arrived silently on open.
    const store = new vscodeMock.MockMemento()
    setGraphPanelState(store as unknown as import('vscode').Memento)
    const { panel, webview } = openGraph()
    webview.simulateMessage({ type: 'ready' })
    await settle()
    webview.simulateMessage({
      type: 'persistState',
      state: { camera: { x: 999, y: 999, zoom: 4 }, selectedNode: 'wiki:pumpkin_patch', search: 'pumpkin' },
    })
    await settle()

    const kept = store.get(graphViewStateKey('/pack')) as Record<string, unknown>
    expect(kept).not.toHaveProperty('search')
    // And nothing else was thrown away with it -- the camera and the selection are exactly what
    // this blob exists for.
    expect(kept['camera']).toEqual({ x: 999, y: 999, zoom: 4 })
    expect(kept['selectedNode']).toBe('wiki:pumpkin_patch')
    panel.dispose()
  })

  it('strips a search out of a blob saved before this rule existed', async () => {
    // Those are sitting in workspaceState on every machine that has used the graph, and would go
    // on hiding most of the pack until somebody searched again.
    const store = new vscodeMock.MockMemento()
    await store.update(graphViewStateKey('/pack'), { camera: { x: 1, y: 2, zoom: 1 }, search: 'pumpkin' })
    setGraphPanelState(store as unknown as import('vscode').Memento)
    const { panel, webview } = openGraph()
    webview.simulateMessage({ type: 'ready' })
    await settle()

    const restore = posted(webview, 'restoreState').at(-1)!
    expect(restore['state']).toEqual({ camera: { x: 1, y: 2, zoom: 1 } })
    panel.dispose()
  })

  it('passes a state with no search through untouched, including nothing at all', async () => {
    const store = new vscodeMock.MockMemento()
    setGraphPanelState(store as unknown as import('vscode').Memento)
    const { panel, webview } = openGraph()
    webview.simulateMessage({ type: 'ready' })
    await settle()
    expect(posted(webview, 'restoreState').at(-1)!['state']).toBeNull()

    webview.simulateMessage({ type: 'persistState', state: { camera: { x: 0, y: 0, zoom: 1 }, legendOpen: true } })
    await settle()
    expect(store.get(graphViewStateKey('/pack'))).toEqual({ camera: { x: 0, y: 0, zoom: 1 }, legendOpen: true })
    panel.dispose()
  })
})
