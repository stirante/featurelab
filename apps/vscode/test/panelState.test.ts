// panelState.test.ts -- what survives a panel, and where a panel lands.
//
// Everything here is about the same complaint from opposite directions: the editor forgot where
// you were. Closing the preview disarmed "Preview on select" although nobody asked for that;
// re-running "Open Feature Graph" MOVED an already-placed graph on top of whatever had focus;
// and closing a window threw the lot away, because nothing anywhere called setState, getState or
// registerWebviewPanelSerializer.
//
// The host half is what is pinned here. The camera, the search query and which compounds are
// open are the WEBVIEW's to remember -- this side only promises it a durable place to put them
// (`persistState`), hands it back on the next panel (`restoreState`), and gives it the key it
// must write into its own setState so a revived tab can say which pack or document it was about.
// So these tests assert on the MESSAGES and on the store, never on a camera.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import {
  GraphPanel,
  graphViewStateKey,
  previewOnSelectKey,
  setGraphPanelState,
} from '../src/graphPanel.js'
import { PREVIEW_PARAMS_VERSION, PreviewPanel, previewParamsKey, previewViewStateKey } from '../src/previewPanel.js'
import type { PreviewController } from '../src/previewController.js'

const PACK_ROOT = '/pack'
const DOCUMENT_PATH = '/pack/features/thing.json'
const DOCUMENT_URI = `file://${DOCUMENT_PATH}`

const FEATURE_JSON = JSON.stringify({
  format_version: '1.19.0',
  'minecraft:tree_feature': { description: { identifier: 'wiki:poplar_tree' } },
})

function makeDocument(text = FEATURE_JSON, fsPath = DOCUMENT_PATH) {
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    fileName: fsPath,
    getText: () => text,
    lineCount: 1,
    lineAt: () => ({ text: '' }),
  } as unknown as import('vscode').TextDocument
}

function makeGraphController(): PreviewController {
  return {
    graph: vi.fn(async () => ({ nodes: [], edges: [], roots: [] })),
    listTypes: vi.fn(async () => ({ types: [] })),
    loadPackSummary: vi.fn(async () => ({ warnings: [], fileCounts: {}, diagnostics: [] })),
  } as unknown as PreviewController
}

function makePreviewController(): PreviewController {
  return {
    generate: vi.fn(async () => ({ diagnostics: [] })),
    generateGrown: vi.fn(async () => ({ diagnostics: [] })),
    reloadPack: vi.fn(async () => ({ warnings: [] })),
    reloadPackFile: vi.fn(async () => ({ warnings: [] })),
    listEnvironments: vi.fn(async () => []),
  } as unknown as PreviewController
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Opens a graph panel and plays the part of the webview announcing itself. */
async function openGraph(controller = makeGraphController()): Promise<{
  panel: GraphPanel
  webview: vscodeMock.MockWebview
}> {
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
  await settle()
  return { panel, webview: created.webview }
}

function posted(webview: vscodeMock.MockWebview, type: string): Record<string, unknown>[] {
  return webview.postedMessages.filter((m) => (m as { type?: string })?.type === type) as Record<string, unknown>[]
}

let state: vscodeMock.MockMemento

beforeEach(() => {
  vscodeMock.resetMock()
  state = new vscodeMock.MockMemento()
  setGraphPanelState(state as unknown as import('vscode').Memento)
})

afterEach(() => {
  for (const panel of GraphPanel.openPanels()) panel.dispose()
  setGraphPanelState(null)
  vi.clearAllMocks()
})

describe('where the graph panel opens, and where it stays', () => {
  it('opens beside the editor rather than taking the group the editor is in', async () => {
    await openGraph()
    const call = vscodeMock.createdPanelCalls.at(-1)!
    expect(call.viewType).toBe(GraphPanel.VIEW_TYPE)
    // Active is the group with focus, which when the command is run from a file is the file's.
    expect(call.column).toBe(vscodeMock.ViewColumn.Beside)
    expect(call.column).not.toBe(vscodeMock.ViewColumn.Active)
  })

  it('re-opening an already-open graph reveals it WHERE IT IS, naming no column', async () => {
    // `reveal(ViewColumn.Active)` does not mean "show it" -- it means "move it into whichever
    // group has focus", so running the command again dragged the graph on top of whatever was
    // there, routinely the preview. The preview panel was taught this rule; this is the graph's
    // half of it.
    await openGraph()
    const tab = vscodeMock.createdPanels.at(-1)!
    const before = vscodeMock.createdPanels.length

    GraphPanel.show(
      vscodeMock.Uri.file('/ext') as unknown as import('vscode').Uri,
      makeGraphController(),
      PACK_ROOT,
      5000,
      () => {},
      () => {},
    )

    // The same panel, not a second one.
    expect(vscodeMock.createdPanels).toHaveLength(before)
    expect(tab.reveal).toHaveBeenCalledTimes(1)
    expect(tab.reveal.mock.calls[0]![0]).toBeUndefined()
  })
})

describe('"Preview on select" is the author’s decision, and it is remembered', () => {
  it('is restored on every open from what the author last chose', async () => {
    await state.update(previewOnSelectKey(PACK_ROOT), true)
    const { webview } = await openGraph()
    expect(posted(webview, 'previewOnSelect').at(-1)).toEqual({ type: 'previewOnSelect', value: true })
  })

  it('is off on a pack nobody has ever turned it on for', async () => {
    const { webview } = await openGraph()
    expect(posted(webview, 'previewOnSelect').at(-1)).toEqual({ type: 'previewOnSelect', value: false })
  })

  it('records the author toggling it, per pack', async () => {
    const { webview } = await openGraph()
    webview.simulateMessage({ type: 'previewOnSelect', value: true })
    await settle()
    expect(state.get(previewOnSelectKey(PACK_ROOT))).toBe(true)
    // Another pack in the same window is unaffected: the toggle says something about how somebody
    // works on ONE pack.
    expect(state.get(previewOnSelectKey('/other-pack'))).toBeUndefined()

    webview.simulateMessage({ type: 'previewOnSelect', value: false })
    await settle()
    expect(state.get(previewOnSelectKey(PACK_ROOT))).toBe(false)
  })

  it('is NOT turned off just because the preview panel closed', async () => {
    // Closing the preview used to force-clear the toggle, so a panel closed for any of the
    // ordinary reasons silently disarmed a mode the author had switched on, and they had to find
    // and press the button again. "The preview is gone" and "stop previewing on select" are two
    // facts and the author only stated one of them.
    await state.update(previewOnSelectKey(PACK_ROOT), true)
    const { panel, webview } = await openGraph()
    webview.postedMessages.length = 0

    panel.previewClosed()
    await settle()

    // It still SAYS the preview closed -- the webview has a panel-gone state to draw -- and the
    // authoritative value of the toggle follows it, unchanged.
    expect(posted(webview, 'previewClosed')).toHaveLength(1)
    expect(posted(webview, 'previewOnSelect').at(-1)).toEqual({ type: 'previewOnSelect', value: true })
    expect(state.get(previewOnSelectKey(PACK_ROOT))).toBe(true)
  })
})

describe('the state channel, both ways', () => {
  it('hands the graph webview its own blob back, with the key it must save', async () => {
    await state.update(graphViewStateKey(PACK_ROOT), { camera: { x: 4, y: 9, zoom: 2 }, legendOpen: true, search: 'boulder' })
    const { webview } = await openGraph()

    const restore = posted(webview, 'restoreState').at(-1)!
    // The key is what makes a revived tab able to say WHICH PACK it was showing: VS Code hands
    // the host the webview's saved state and nothing else.
    expect(restore.key).toBe(PACK_ROOT)
    // Opaque with ONE named exception: `search` is stripped, here and on the way in. A filter is
    // a question somebody typed, not a place they were, and restoring it brings the pack back
    // with most of its cards missing for reasons nothing on screen explains -- see
    // crossPanel.test.ts, and withoutSearch's own doc comment. This blob was saved before that
    // rule existed, which is the case the strip-on-read half exists for.
    expect(restore.state).toEqual({ camera: { x: 4, y: 9, zoom: 2 }, legendOpen: true })
  })

  it('stores whatever the graph webview sends, opaquely', async () => {
    const { webview } = await openGraph()
    const blob = { key: PACK_ROOT, camera: { x: 1, y: 2, zoom: 0.5 }, openCompounds: ['wiki:grove'], minimap: false }
    webview.simulateMessage({ type: 'persistState', state: blob })
    await settle()
    expect(state.get(graphViewStateKey(PACK_ROOT))).toEqual(blob)
  })

  it('does the same for the preview, keyed on the document', async () => {
    const store = new vscodeMock.MockMemento()
    await store.update(previewViewStateKey(DOCUMENT_URI), { camera: { distance: 40 } })
    const controller = makePreviewController()
    new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext'), workspaceState: store } as unknown as import('vscode').ExtensionContext,
      controller,
      { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection,
      makeDocument(),
      () => {},
    )
    await settle()
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    webview.simulateMessage({ type: 'ready' })
    await settle()

    const restore = posted(webview, 'restoreState').at(-1)!
    expect(restore.key).toBe(DOCUMENT_URI)
    expect(restore.state).toEqual({ camera: { distance: 40 } })

    webview.simulateMessage({ type: 'persistState', state: { key: DOCUMENT_URI, camera: { distance: 12 } } })
    await settle()
    expect(store.get(previewViewStateKey(DOCUMENT_URI))).toEqual({ key: DOCUMENT_URI, camera: { distance: 12 } })
  })

  it('a preview with nowhere to remember anything still works exactly as it did', async () => {
    // Most of this suite's siblings construct PreviewPanel with a two-field stand-in for the
    // extension context. A missing store must cost the remembering and nothing else.
    const controller = makePreviewController()
    new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection,
      makeDocument(),
      () => {},
    )
    await settle()
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    webview.simulateMessage({ type: 'ready' })
    webview.simulateMessage({ type: 'persistState', state: { anything: true } })
    await settle()

    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(posted(webview, 'restoreState').at(-1)!.state).toBeNull()
  })
})

describe('coming back after a window reload', () => {
  it('activation registers a serializer for BOTH panels, which is what makes reviving possible at all', async () => {
    // Without these there is no reviving to test: VS Code throws a restored webview away when
    // nothing has claimed its view type, so a window reload left no graph and no preview -- and
    // the activation events have to name the same two view types, or the extension is not even
    // running when VS Code goes looking for the serializer.
    const { activate, deactivate } = await import('../src/extension.js')
    activate({
      subscriptions: [],
      extensionPath: '/ext',
      extensionUri: vscodeMock.Uri.file('/ext'),
      workspaceState: new vscodeMock.MockMemento(),
    } as unknown as import('vscode').ExtensionContext)
    try {
      expect([...vscodeMock.registeredSerializers.keys()].sort()).toEqual([GraphPanel.VIEW_TYPE, PreviewPanel.VIEW_TYPE].sort())
    } finally {
      deactivate()
    }
  })


  it('remembers what the preview was generating, and a revived panel picks it up', async () => {
    const store = new vscodeMock.MockMemento()
    const context = { extensionUri: vscodeMock.Uri.file('/ext'), workspaceState: store } as unknown as import('vscode').ExtensionContext
    const controller = makePreviewController()
    new PreviewPanel(context, controller, { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection, makeDocument(), () => {})
    await settle()
    const webview = vscodeMock.createdPanels.at(-1)!.webview
    // Everything the author set -- seed, origin, repeat, preset, sizes -- is a field of the params
    // they are generating with, so remembering those is remembering all of it.
    const chosen = { feature: 'wiki:poplar_tree', env: 'desert', seed: 7, originX: 4, repeat: 3, sizeX: 48 }
    webview.simulateMessage({ type: 'generate', params: chosen })
    await settle()
    // Stamped with the shape version and with what the file declared at the time -- the two
    // things freshPreviewParams needs to decide, on the next window, whether any of this still
    // means what it meant. See its own doc comment for what is deliberately NOT stamped.
    expect(store.get(previewParamsKey(DOCUMENT_URI))).toEqual({
      version: PREVIEW_PARAMS_VERSION,
      identifier: 'wiki:poplar_tree',
      params: chosen,
      grown: false,
    })

    // VS Code recreates the tab itself, in the group the author had put it in, and the extension
    // takes it over rather than opening a second one.
    const revivedTab = new vscodeMock.MockWebviewPanel()
    const revivedController = makePreviewController()
    const madeBefore = vscodeMock.createdPanels.length
    new PreviewPanel(
      context,
      revivedController,
      { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection,
      makeDocument(),
      () => {},
      undefined,
      {},
      { panel: revivedTab as unknown as import('vscode').WebviewPanel, params: chosen, grown: false },
    )
    await settle()

    expect(vscodeMock.createdPanels).toHaveLength(madeBefore)
    // The SAME run the author was looking at, not a fresh preview of the file at default
    // everything.
    expect(revivedController.generate).toHaveBeenCalledWith(expect.any(String), chosen, expect.any(Number), expect.anything())
    // A restored webview comes back with its scripts off -- VS Code does not persist webview
    // options -- and a graph or preview without them is a blank grey rectangle.
    expect((revivedTab.webview.options as { enableScripts?: boolean }).enableScripts).toBe(true)
  })

  it('a revived graph adopts the tab instead of opening a second one', async () => {
    const revivedTab = new vscodeMock.MockWebviewPanel()
    const madeBefore = vscodeMock.createdPanels.length

    const panel = GraphPanel.revive(
      revivedTab as unknown as import('vscode').WebviewPanel,
      vscodeMock.Uri.file('/ext') as unknown as import('vscode').Uri,
      makeGraphController(),
      PACK_ROOT,
      5000,
      () => {},
      () => {},
    )

    expect(vscodeMock.createdPanels).toHaveLength(madeBefore)
    expect(panel.pack).toBe(PACK_ROOT)
    expect(revivedTab.webview.html).toContain('flg-root')
    expect((revivedTab.webview.options as { enableScripts?: boolean }).enableScripts).toBe(true)
    // And it is the panel a command with no argument means, exactly as an opened one would be.
    expect(GraphPanel.activePanel()).toBe(panel)
  })

  it('drops a revived graph tab for a pack that already has a live panel', async () => {
    await openGraph()
    const live = GraphPanel.activePanel()
    const duplicate = new vscodeMock.MockWebviewPanel()

    const panel = GraphPanel.revive(
      duplicate as unknown as import('vscode').WebviewPanel,
      vscodeMock.Uri.file('/ext') as unknown as import('vscode').Uri,
      makeGraphController(),
      PACK_ROOT,
      5000,
      () => {},
      () => {},
    )

    // One panel per pack is the rule everywhere else in that class; two would be two graphs
    // fighting over one undo journal.
    expect(panel).toBe(live)
    expect(duplicate.disposed).toBe(true)
  })
})
