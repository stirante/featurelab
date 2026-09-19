// previewRevive.test.ts -- whether the two panels are still talking to each other after a window
// reload, driven through the REAL extension.ts webview serializer rather than by constructing a
// PreviewPanel by hand.
//
// That distinction is the whole point of this file. The link between a preview and a graph is
// built in extension.ts, once per entry point, and there are two entry points: the command/graph
// route and VS Code reviving a tab. For as long as only the first of them built one, a preview
// constructed by hand in a test looked perfectly wired while the one a person actually got after
// pressing Ctrl+R was deaf and mute. Measured: 2 `runStats` posts from a graph-opened preview, 0
// from a revived one, and nothing at all told the graph when a revived one closed -- so "Preview
// on select" stayed armed and re-opened the panel the author had just shut.
//
// PreviewController is stubbed at the module boundary, because extension.ts builds its own from
// featurelab.binaryPath and this file is about the wiring, not about the engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

/** Every `generate` the extension's OWN controller was asked for, in order. Hoisted, because
 * extension.ts builds its controller itself from featurelab.binaryPath -- which is precisely the
 * code path under test -- so there is no instance a test could spy on after the fact. */
const { calls } = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock('../src/previewController.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/previewController.js')>()
  const profile = {
    featureIdentifiers: ['wiki:poplar_tree'],
    features: [{ identifier: 'wiki:poplar_tree', entered: 1, blocksWritten: 7, delegations: 0, selfMs: 1, inclusiveMs: 1 }],
  }
  class StubController {
    constructor(readonly binaryPath: string) {}
    graph = vi.fn(async () => ({ nodes: [{ id: 'wiki:poplar_tree', file: 'features/thing.json' }], edges: [], roots: [] }))
    listTypes = vi.fn(async () => ({ types: [] }))
    loadPackSummary = vi.fn(async () => ({ warnings: [], fileCounts: {}, diagnostics: [] }))
    generate = vi.fn(async (_root: string, params: unknown) => {
      calls.push(params)
      return { diagnostics: [], profile, origin: { x: 0, y: 63, z: 0 } }
    })
    generateGrown = vi.fn(async (_root: string, params: unknown) => {
      calls.push(params)
      return { diagnostics: [], profile }
    })
    reloadPack = vi.fn(async () => ({ warnings: [] }))
    reloadPackFile = vi.fn(async () => ({ warnings: [] }))
    listEnvironments = vi.fn(async () => [])
    dispose = vi.fn()
  }
  return { ...actual, PreviewController: StubController }
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { activate, deactivate } from '../src/extension.js'
import { GraphPanel, previewOnSelectKey, setGraphPanelState } from '../src/graphPanel.js'
import { PreviewPanel, PREVIEW_PARAMS_VERSION, previewParamsKey } from '../src/previewPanel.js'
import { forgetEngineProbes } from '../src/engineCheck.js'

const FEATURE_JSON = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:tree_feature': { description: { identifier: 'wiki:poplar_tree' } },
})

const temporary: string[] = []

function makePack(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-revive-'))
  temporary.push(root)
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"format_version":2}', 'utf8')
  fs.mkdirSync(path.join(root, 'features'), { recursive: true })
  const file = path.join(root, 'features', 'thing.json')
  fs.writeFileSync(file, FEATURE_JSON, 'utf8')
  return { root, file }
}

function makeDocument(fsPath: string, text = FEATURE_JSON): import('vscode').TextDocument {
  return {
    uri: { fsPath, scheme: 'file', toString: () => `file://${fsPath.replace(/\\/g, '/')}` },
    fileName: fsPath,
    getText: () => text,
    lineCount: 1,
    lineAt: () => ({ text: '' }),
  } as unknown as import('vscode').TextDocument
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 10))
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

function posted(webview: vscodeMock.MockWebview, type: string): Record<string, unknown>[] {
  return webview.postedMessages.filter((m) => (m as { type?: string })?.type === type) as Record<string, unknown>[]
}

let store: vscodeMock.MockMemento

/** Activates the real extension and brings the GRAPH back through its own serializer too --
 * which is the situation this file is about: a window reload revives both panels, and neither of
 * them was opened by a command this time round. Reviving it (rather than calling GraphPanel.show
 * directly) is what gets extension.ts's real `onPreviewFile` wired to it, and that callback is
 * half of the link being tested. */
async function activateWithGraph(packRoot: string): Promise<vscodeMock.MockWebview> {
  vscodeMock.mockConfig['binaryPath'] = process.execPath
  activate({
    subscriptions: [],
    extensionPath: '/ext',
    extensionUri: vscodeMock.Uri.file('/ext'),
    workspaceState: store,
  } as unknown as import('vscode').ExtensionContext)
  const tab = new vscodeMock.MockWebviewPanel()
  const serializer = vscodeMock.registeredSerializers.get(GraphPanel.VIEW_TYPE)
  if (!serializer) throw new Error('activate() registered no graph serializer')
  await serializer.deserializeWebviewPanel(tab, { key: packRoot })
  await settle()
  tab.webview.simulateMessage({ type: 'ready' })
  await settle()
  return tab.webview
}

/** Hands a saved `{key}` blob to the real preview serializer, exactly as VS Code does after a
 * window reload, and returns the tab it took over. */
async function revive(file: string): Promise<vscodeMock.MockWebviewPanel> {
  const tab = new vscodeMock.MockWebviewPanel()
  const serializer = vscodeMock.registeredSerializers.get(PreviewPanel.VIEW_TYPE)
  if (!serializer) throw new Error('activate() registered no preview serializer')
  await serializer.deserializeWebviewPanel(tab, { key: makeDocument(file).uri.toString() })
  await settle()
  return tab
}

beforeEach(() => {
  vscodeMock.resetMock()
  forgetEngineProbes()
  calls.length = 0
  store = new vscodeMock.MockMemento()
  setGraphPanelState(store as unknown as import('vscode').Memento)
  vscodeMock.workspace.openTextDocument = vi.fn((target: unknown) => {
    const fsPath = String((target as { fsPath?: string })?.fsPath ?? target).replace(/^file:\/\//, '')
    if (!fs.existsSync(fsPath)) return Promise.reject(new Error(`cannot open ${fsPath}`))
    return Promise.resolve(makeDocument(fsPath, fs.readFileSync(fsPath, 'utf8')))
  }) as never
})

afterEach(() => {
  deactivate()
  for (const panel of GraphPanel.openPanels()) panel.dispose()
  setGraphPanelState(null)
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vscodeMock.mockConfig['binaryPath'] = ''
  vi.clearAllMocks()
})

describe('a preview VS Code revived after a window reload', () => {
  it('reports its run to the graph, exactly as a graph-opened preview does', async () => {
    const { root, file } = makePack()
    const graphWebview = await activateWithGraph(root)
    const before = posted(graphWebview, 'runStats').length

    const tab = await revive(file)
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()
    tab.webview.simulateMessage({ type: 'generate', params: { feature: 'wiki:poplar_tree' } })
    await settle()

    const stats = posted(graphWebview, 'runStats')
    expect(stats.length).toBeGreaterThan(before)
    // And it is a real measurement, not an empty shape: the cards have something to wear.
    const last = stats.at(-1)!['stats'] as { previewed?: string; profile?: { features?: unknown[] } }
    expect(last.previewed).toBe('wiki:poplar_tree')
    expect(last.profile?.features).toHaveLength(1)
  })

  it('tells the graph when it closes, once the graph is driving it', async () => {
    // The sequence that was reported: reload the window, click a node with "Preview on select"
    // on, close the preview -- and the toggle stayed armed, so the next click re-opened the panel
    // the author had just shut. Nothing in the revive path ever called previewClosed().
    const { root, file } = makePack()
    await store.update(previewOnSelectKey(root), true)
    const graphWebview = await activateWithGraph(root)

    const tab = await revive(file)
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()
    // The graph follows a selection into the panel that is already open on that document, which
    // is how a revived tab becomes the graph-driven one.
    graphWebview.simulateMessage({ type: 'previewNode', nodeId: 'wiki:poplar_tree', attribute: true })
    await settle()

    graphWebview.postedMessages.length = 0
    tab.dispose()
    await settle()

    expect(posted(graphWebview, 'previewClosed')).toHaveLength(1)
    // …followed straight away by the authoritative value of the toggle, which is what makes a
    // webview that clears it on `previewClosed` correct anyway.
    expect(posted(graphWebview, 'previewOnSelect').at(-1)).toEqual({ type: 'previewOnSelect', value: true })
  })

  it('replays a remembered bench but not a name the file no longer has', async () => {
    // The freshness decision, end to end: the seed/origin/repeat/size are the author's setup and
    // come back; the feature identifier is checked against the file and dropped when the file has
    // moved on. See freshPreviewParams for why nothing here consults an mtime.
    const { root, file } = makePack()
    const key = makeDocument(file).uri.toString()
    await store.update(previewParamsKey(key), {
      version: PREVIEW_PARAMS_VERSION,
      identifier: 'wiki:poplar_tree_OLD',
      params: { feature: 'wiki:poplar_tree_OLD', seed: 42, originX: 8, repeat: 3, sizeX: 64 },
      grown: false,
    })
    await activateWithGraph(root)

    const tab = await revive(file)
    tab.webview.simulateMessage({ type: 'ready' })
    await settle()

    // What it actually asked the engine for: the bench, and the file's OWN identifier rather
    // than the remembered one.
    expect(calls.at(-1)).toMatchObject({ feature: 'wiki:poplar_tree', seed: 42, originX: 8, repeat: 3, sizeX: 64 })
    expect(posted(tab.webview, 'init').at(-1)).toEqual({ type: 'init', kind: 'feature', identifier: 'wiki:poplar_tree' })
  })
})
