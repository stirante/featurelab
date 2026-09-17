// previewPanel.test.ts -- exercises PreviewPanel's message handling and the "lastParams
// fallback" rule its own header comment describes: a plain document save previews the saved
// file's own feature identifier UNTIL the user touches a generation-config control in the
// panel (a `{type:'generate', params}` message from the webview), after which every
// regenerate -- including a later save -- uses that params object instead. Runs against
// fixtures/vscodeMock.ts (see that file's own doc comment) rather than a running VS Code host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { PreviewPanel, effectiveGenerateTimeoutMs } from '../src/previewPanel.js'
import type { PreviewController } from '../src/previewController.js'

function makeDocument(text: string, fsPath = '/pack/features/thing.json') {
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    fileName: fsPath,
    getText: () => text,
    lineCount: 1,
    lineAt: () => ({ text: '' }),
  } as unknown as import('vscode').TextDocument
}

const FEATURE_JSON = JSON.stringify({
  format_version: '1.19.0',
  'minecraft:tree_feature': { description: { identifier: 'wiki:poplar_tree' } },
})

// A minecraft:feature_rules document -- the file kind the reported bug
// (rule file, feature picker) was actually about.
const RULE_JSON = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:feature_rules': { description: { identifier: 'wiki:crater_shrub', places_feature: 'wiki:crater_shrub_single' } },
})

function makeController(): PreviewController & { generate: ReturnType<typeof vi.fn>; generateGrown: ReturnType<typeof vi.fn>; reloadPack: ReturnType<typeof vi.fn>; reloadPackFile: ReturnType<typeof vi.fn>; listEnvironments: ReturnType<typeof vi.fn> } {
  return {
    generate: vi.fn(async () => ({ diagnostics: [] })),
    // Mirrors app.go/previewController.ts's real contract: a GrownGenerateOutput is a normal
    // GenerateOutput plus grown/preGrowBounds -- see GrowCapablePreviewController's own doc
    // comment in previewPanel.ts.
    generateGrown: vi.fn(async () => ({ diagnostics: [], grown: true, preGrowBounds: { minX: 0, minY: 0, minZ: 0, sizeX: 8, sizeY: 8, sizeZ: 8 } })),
    reloadPack: vi.fn(async () => ({ warnings: [], featureCount: 0, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    // The save path's counterpart -- same result shape as reloadPack (the engine answers both
    // with the same object; see cmd/featurelab/serve.go's packResult), differing only in how
    // much of the pack it re-reads.
    reloadPackFile: vi.fn(async () => ({ warnings: [], featureCount: 0, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    listEnvironments: vi.fn(async () => [{ id: 'plains', label: 'Plains', description: '', defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 }, materials: { topMaterial: 'minecraft:grass_block', midMaterial: '', foundationMaterial: '', seaFloorMaterial: '', seaMaterial: '', seaFloorDepth: 0 }, buildsSea: false, biome: 'plains', biomeTags: [] }]),
  } as unknown as PreviewController & { generate: ReturnType<typeof vi.fn>; generateGrown: ReturnType<typeof vi.fn>; reloadPack: ReturnType<typeof vi.fn>; reloadPackFile: ReturnType<typeof vi.fn>; listEnvironments: ReturnType<typeof vi.fn> }
}

async function flush(): Promise<void> {
  // Lets any queued `.then()` continuations (PreviewPanel's `pending` chain) run.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vscodeMock.createdPanels.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PreviewPanel: lastParams fallback', () => {
  // mockConfig.requestTimeoutMs is 5000 (see fixtures/vscodeMock.ts), which is BELOW the
  // engine's own default placement budget (ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS = 8000) plus
  // this file's own REQUEST_TIMEOUT_MARGIN_MS (10000) -- so every regenerate() call in this
  // describe block exercises the request-timeout/placement-budget coupling fix (previewPanel.ts's
  // effectiveGenerateTimeoutMs) even though none of these params ever set placementTimeLimitMs
  // explicitly: the engine's own IMPLICIT default budget is always in effect, and the wait this
  // extension imposes has to comfortably exceed it regardless of whether the user touched the
  // Budget section. 18000 = 8000 (engine default) + 10000 (margin).
  const EXPECTED_TIMEOUT_MS = 18000

  it('the very first regenerate previews the open file’s own parsed feature identifier', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()

    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, EXPECTED_TIMEOUT_MS)
  })

  it('a "generate" message from the webview overrides the file-derived params for every later regenerate', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const document = makeDocument(FEATURE_JSON)
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, document, () => {})
    await flush()
    controller.generate.mockClear()

    const webview = vscodeMock.createdPanels[0]!.webview
    const customParams = { feature: 'wiki:mossy_boulder_replace', env: 'desert', minY: -10, biomeId: 'wiki:crater' }
    webview.simulateMessage({ type: 'generate', params: customParams })
    await flush()

    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), customParams, EXPECTED_TIMEOUT_MS)

    // A later document save must NOT revert to the file's own identifier -- see this file's
    // header comment for why.
    controller.generate.mockClear()
    panel.notifyDocumentChanged(document)
    await flush()
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), customParams, EXPECTED_TIMEOUT_MS)
  })

  // Sticky grow-to-fit: a 'growRegenerate' message -- fired for panel.ts's sticky
  // toggle just as much as for the one-shot button, see that message case's own comment --
  // must make EVERY later regenerate, including a save-triggered one that never touches the
  // webview at all, keep using generateGrown() instead of generate() until an ordinary
  // 'generate' message says otherwise. This is lastRequestWasGrow's whole reason to exist.
  it('a "growRegenerate" message makes a LATER save-triggered regenerate keep using generateGrown(), not generate()', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const document = makeDocument(FEATURE_JSON)
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, document, () => {})
    await flush()
    controller.generate.mockClear()

    const webview = vscodeMock.createdPanels[0]!.webview
    const stickyParams = { feature: 'wiki:mossy_boulder_replace', env: 'desert' }
    webview.simulateMessage({ type: 'growRegenerate', params: stickyParams })
    await flush()
    expect(controller.generateGrown).toHaveBeenCalledTimes(1)
    expect(controller.generateGrown).toHaveBeenCalledWith(expect.any(String), stickyParams, EXPECTED_TIMEOUT_MS)
    expect(controller.generate).not.toHaveBeenCalled()

    // THE load-bearing assertion: a save right
    // after must inherit the SAME grown behaviour, not silently revert to a plain generate() --
    // the reported bug (grow-to-fit not surviving a reload/save) moved one level up.
    controller.generateGrown.mockClear()
    panel.notifyDocumentChanged(document)
    await flush()
    expect(controller.generateGrown).toHaveBeenCalledTimes(1)
    expect(controller.generateGrown).toHaveBeenCalledWith(expect.any(String), stickyParams, EXPECTED_TIMEOUT_MS)
    expect(controller.generate).not.toHaveBeenCalled()
  })

  it('an ordinary "generate" message after a "growRegenerate" one turns sticky back off for later saves too', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const document = makeDocument(FEATURE_JSON)
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, document, () => {})
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'growRegenerate', params: { feature: 'a', env: 'plains' } })
    await flush()
    webview.simulateMessage({ type: 'generate', params: { feature: 'a', env: 'plains' } })
    await flush()

    controller.generate.mockClear()
    controller.generateGrown.mockClear()
    panel.notifyDocumentChanged(document)
    await flush()
    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(controller.generateGrown).not.toHaveBeenCalled()
  })

  it('posts an "init" message with the file’s parsed kind + identifier when the webview reports ready', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()

    expect(webview.postedMessages).toContainEqual({ type: 'init', kind: 'feature', identifier: 'wiki:poplar_tree' })
  })

  // A rule file (minecraft:feature_rules) must post kind: 'rule', never be silently
  // treated as a feature -- see identifier.ts's parseDocumentIdentifier for the bug this fixes.
  it('posts kind: "rule" for a minecraft:feature_rules document, and falls back to {rule: id} (not {feature: id}) with no lastParams yet', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const document = makeDocument(RULE_JSON, '/pack/feature_rules/crater_shrub.fr.json')
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, document, () => {})
    await flush()

    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { rule: 'wiki:crater_shrub', env: 'plains' }, EXPECTED_TIMEOUT_MS)

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    expect(webview.postedMessages).toContainEqual({ type: 'init', kind: 'rule', identifier: 'wiki:crater_shrub' })
  })

  it('posts an "environments" message from controller.listEnvironments() when the webview reports ready', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()

    expect(controller.listEnvironments).toHaveBeenCalledTimes(1)
    const posted = webview.postedMessages.find((m) => (m as { type: string }).type === 'environments') as { environments: Array<{ id: string }> } | undefined
    expect(posted?.environments.map((e) => e.id)).toEqual(['plains'])
  })

  // The save path (extension.ts fans every save out to notifyPackFileSaved) must RELOAD the
  // pack before regenerating -- the engine's Workspace still holds the pre-save file contents,
  // so the old plain-regenerate save wiring showed the previous result and made the save look
  // like a no-op (the core edit-save-look loop, broken until the manual "Reload files" click).
  it('notifyPackFileSaved for the previewed document itself re-reads THAT file, then regenerates', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const document = makeDocument(FEATURE_JSON)
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, document, () => {})
    await flush()
    controller.generate.mockClear()

    panel.notifyPackFileSaved(document)
    await flush()
    // The saved document's own path has to reach the controller: it is the only thing that
    // lets the engine skip re-reading the other few thousand files, and this panel is the only
    // place that knows it.
    expect(controller.reloadPackFile).toHaveBeenCalledTimes(1)
    expect(controller.reloadPackFile.mock.calls[0]?.[1]).toBe('/pack/features/thing.json')
    expect(controller.reloadPack).not.toHaveBeenCalled()
    expect(controller.generate).toHaveBeenCalledTimes(1)
  })

  it('notifyPackFileSaved for a SIBLING pack file (a referenced sub-feature) also reloads and regenerates', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()
    controller.generate.mockClear()

    // Same pack root as makeDocument's default ('/pack'), different file under features/.
    panel.notifyPackFileSaved(makeDocument(FEATURE_JSON, '/pack/features/other_feature.json'))
    await flush()
    // The SIBLING's path, not the previewed document's -- re-reading the previewed file would
    // pick up nothing at all here, and the whole point of this case is that editing a
    // referenced sub-feature refreshes its parent's preview.
    expect(controller.reloadPackFile).toHaveBeenCalledTimes(1)
    expect(controller.reloadPackFile.mock.calls[0]?.[1]).toBe('/pack/features/other_feature.json')
    expect(controller.generate).toHaveBeenCalledTimes(1)
  })

  it('notifyPackFileSaved ignores a save outside the pack (and one the engine never loads)', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()
    controller.generate.mockClear()

    panel.notifyPackFileSaved(makeDocument('{}', '/elsewhere/notes.json'))
    panel.notifyPackFileSaved(makeDocument('{}', '/pack/manifest.json'))
    await flush()
    expect(controller.reloadPack).not.toHaveBeenCalled()
    expect(controller.reloadPackFile).not.toHaveBeenCalled()
    expect(controller.generate).not.toHaveBeenCalled()
  })

  // The "Reload files" BUTTON keeps re-reading everything, deliberately: it is the control a
  // user reaches for when they do not trust what the incremental save path has left on screen,
  // so routing it through the single-file path would remove the only way out of a wrong
  // picture.
  it('a "reloadFiles" message calls controller.reloadPack() -- the FULL reload -- then regenerates', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()
    controller.generate.mockClear()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'reloadFiles' })
    await flush()

    expect(controller.reloadPack).toHaveBeenCalledTimes(1)
    expect(controller.reloadPackFile).not.toHaveBeenCalled()
    expect(controller.generate).toHaveBeenCalledTimes(1)
  })

  it('surfaces a parse error visibly instead of silently doing nothing when the file is not previewable', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument('not json'), () => {})
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    expect(controller.generate).not.toHaveBeenCalled()
    webview.simulateMessage({ type: 'ready' })
    await flush()
    expect(webview.postedMessages.some((m) => (m as { type: string }).type === 'error')).toBe(true)
  })

  // vscode.Webview.postMessage silently drops messages posted before the webview's script has
  // loaded and registered its listener -- see PreviewPanel's outbox doc comment. These two pin
  // the whole contract: NOTHING is delivered pre-'ready' (not even a fast error), and
  // everything buffered lands, in order, once 'ready' arrives.
  it('holds every outbound message until the webview reports ready, then delivers them in order', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    // The mock controller resolves generate() immediately -- exactly the post-pre-warm timing
    // (~10ms measured against a loaded pack) that loses the race against a real webview's boot.
    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(webview.postedMessages).toEqual([])

    webview.simulateMessage({ type: 'ready' })
    await flush()
    const types = webview.postedMessages.map((m) => (m as { type: string }).type)
    // init first (seeds the picker), then the buffered request lifecycle in the order it was
    // produced: busy -> timeoutInfo/stale bookkeeping -> the result itself.
    expect(types[0]).toBe('init')
    expect(types.indexOf('busy')).toBeGreaterThan(-1)
    expect(types.indexOf('result')).toBeGreaterThan(types.indexOf('busy'))
  })

  it('posts directly (no buffering) once ready has been seen', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    webview.postedMessages.length = 0

    panel.notifyDocumentChanged(makeDocument(FEATURE_JSON))
    await flush()
    expect(webview.postedMessages.some((m) => (m as { type: string }).type === 'result')).toBe(true)
  })
})

describe('effectiveGenerateTimeoutMs: the request-timeout / placement-budget coupling', () => {
  it('never goes below the configured timeout', () => {
    expect(effectiveGenerateTimeoutMs(30000, {})).toBe(30000)
  })

  it('raises the wait above the ENGINE default placement budget even when the request never sets placementTimeLimitMs explicitly', () => {
    // 8000 (ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS) + 10000 (margin) = 18000 -- the engine's own
    // built-in budget is always in effect, whether or not a request names one.
    expect(effectiveGenerateTimeoutMs(5000, {})).toBe(18000)
  })

  it('raises the wait above an explicit placementTimeLimitMs the user set in the Budget section', () => {
    expect(effectiveGenerateTimeoutMs(5000, { placementTimeLimitMs: 60000 })).toBe(70000)
  })

  it('leaves the configured timeout untouched when it already comfortably exceeds the placement budget', () => {
    expect(effectiveGenerateTimeoutMs(30000, { placementTimeLimitMs: 8000 })).toBe(30000)
  })
})

describe('PreviewPanel: posts timeoutInfo so the panel can surface an override, never silently', () => {
  it('posts an overridden timeoutInfo on the very first regenerate (configured 5000 < engine default budget + margin)', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    const posted = webview.postedMessages.find((m) => (m as { type: string }).type === 'timeoutInfo') as { configuredMs: number; effectiveMs: number } | undefined
    expect(posted).toEqual({ type: 'timeoutInfo', configuredMs: 5000, effectiveMs: 18000 })
  })

  it('posts a not-overridden timeoutInfo (effectiveMs === configuredMs) once the configured timeout already covers the request’s own placementTimeLimitMs', async () => {
    const previous = vscodeMock.mockConfig.requestTimeoutMs
    vscodeMock.mockConfig.requestTimeoutMs = 30000
    try {
      const controller = makeController()
      const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
      new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
      await flush()

      const webview = vscodeMock.createdPanels[0]!.webview
      webview.simulateMessage({ type: 'ready' })
      await flush()
      const posted = webview.postedMessages.find((m) => (m as { type: string }).type === 'timeoutInfo') as { configuredMs: number; effectiveMs: number } | undefined
      expect(posted).toEqual({ type: 'timeoutInfo', configuredMs: 30000, effectiveMs: 30000 })
    } finally {
      vscodeMock.mockConfig.requestTimeoutMs = previous
    }
  })

  it('raises the actual generate() timeout to match a user-set placementTimeLimitMs from the panel', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()
    controller.generate.mockClear()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    const customParams = { feature: 'wiki:poplar_tree', env: 'plains', placementTimeLimitMs: 60000 }
    webview.simulateMessage({ type: 'generate', params: customParams })
    await flush()

    // 60000 + 10000 margin = 70000, well above the 5000ms configured in this test's mock.
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), customParams, 70000)
    const posted = webview.postedMessages.filter((m) => (m as { type: string }).type === 'timeoutInfo').pop() as { configuredMs: number; effectiveMs: number } | undefined
    expect(posted).toEqual({ type: 'timeoutInfo', configuredMs: 5000, effectiveMs: 70000 })
  })
})

// Write attribution's cost gate. The journey (test/journeys/attribution.test.ts) shows the
// feature working end to end, and it can only show the half where somebody ASKED for it: the
// graph has no path to a preview that is not attributing something. This is the other half --
// that a preview opened any other way never asks the engine for a profile, and never starts
// doing so because a panel somewhere else did.
describe('PreviewPanel: a profile is asked for only when attribution was', () => {
  const EXPECTED_TIMEOUT_MS = 18000

  function makePanel(controller: ReturnType<typeof makeController>, attributeNodeId: string | null = null) {
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    return new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
      undefined,
      { attributeNodeId },
    )
  }

  it('an ordinary preview sends the request it always sent, with no profile field at all', async () => {
    const controller = makeController()
    const panel = makePanel(controller)
    await flush()

    // Not `profile: false` -- ABSENT. A field the engine never sees is the only version of this
    // that cannot cost anything, and an explicit false would also overwrite a user who ticked
    // "Enable profiling" in the panel themselves.
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, EXPECTED_TIMEOUT_MS)

    // ...and a save-triggered regenerate does not quietly acquire one later either.
    controller.generate.mockClear()
    panel.notifyDocumentChanged(makeDocument(FEATURE_JSON))
    await flush()
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, EXPECTED_TIMEOUT_MS)
  })

  it('a preview the graph opened for a node asks for the profile on its very first run', async () => {
    const controller = makeController()
    makePanel(controller, 'wiki:poplar_tree')
    await flush()

    // ONE call, not two. The node is a constructor parameter precisely so the panel does not pay
    // for an unprofiled run and then immediately repeat it with the profile on.
    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(controller.generate).toHaveBeenCalledWith(
      expect.any(String),
      { feature: 'wiki:poplar_tree', env: 'plains', profile: true },
      EXPECTED_TIMEOUT_MS,
    )
  })

  it('attributing a node on an already-open preview turns the profile on from then on', async () => {
    const controller = makeController()
    const panel = makePanel(controller)
    await flush()
    controller.generate.mockClear()

    panel.attributeNode('wiki:poplar_tree')
    await flush()

    expect(controller.generate).toHaveBeenCalledWith(
      expect.any(String),
      { feature: 'wiki:poplar_tree', env: 'plains', profile: true },
      EXPECTED_TIMEOUT_MS,
    )
  })

  it('the user’s own params object is never mutated -- their profiling checkbox stays theirs', async () => {
    const controller = makeController()
    const panel = makePanel(controller)
    await flush()

    const userParams = { feature: 'wiki:mossy_boulder_replace', env: 'desert' }
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'generate', params: userParams })
    await flush()
    controller.generate.mockClear()

    panel.attributeNode('wiki:mossy_boulder_replace')
    await flush()

    // The REQUEST carries the profile...
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { ...userParams, profile: true }, EXPECTED_TIMEOUT_MS)
    // ...and the panel's own control state does not. Writing into it would leave "Enable
    // profiling" ticked in somebody's sidebar because the graph asked a question.
    expect(userParams).toEqual({ feature: 'wiki:mossy_boulder_replace', env: 'desert' })
  })

  it('a result with no profile clears the highlight instead of erroring, and the preview goes on', async () => {
    // What an engine too old to send profile.attribution produces, and what a run whose placement
    // was refused produces. makeController's generate answers `{diagnostics: []}` -- no profile
    // field at all -- which is exactly that case.
    const controller = makeController()
    makePanel(controller, 'wiki:poplar_tree')
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()

    const posted = webview.postedMessages as { type: string; available?: boolean }[]
    // The result still went out -- the preview is unaffected...
    expect(posted.some((m) => m.type === 'result')).toBe(true)
    // ...and nothing anywhere says "error". The attribution message reports the honest
    // "no answer", which the webview renders as no overlay and no readout.
    expect(posted.some((m) => m.type === 'error')).toBe(false)
    const attribution = posted.filter((m) => m.type === 'attribution').pop()
    expect(attribution).toMatchObject({ type: 'attribution', available: false })
  })

  it('a profiled result resolves the node’s own cells and posts them', async () => {
    const controller = makeController()
    // One feature, three cells, one of them written twice. Cell indices are flat and
    // bounds-relative -- the same scheme every per-cell array on the response uses.
    controller.generate.mockImplementation(async () => ({
      diagnostics: [],
      bounds: { minX: 0, minY: 0, minZ: 0, sizeX: 4, sizeY: 4, sizeZ: 4 },
      profile: {
        featureIdentifiers: ['wiki:poplar_tree', 'wiki:other'],
        features: [],
        attribution: { cell: [5, 1, 9, 2], feature: [0, 0, 1, 0], count: [1, 2, 7, 1] },
      },
    }))
    makePanel(controller, 'wiki:poplar_tree')
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()

    const attribution = (webview.postedMessages as { type: string }[]).filter((m) => m.type === 'attribution').pop()
    expect(attribution).toMatchObject({
      type: 'attribution',
      available: true,
      nodeId: 'wiki:poplar_tree',
      // Ascending, and only this node's -- cell 9 belongs to wiki:other.
      cells: [1, 2, 5],
      cellCount: 3,
      // Writes, not cells: cell 1 was written twice.
      writes: 4,
    })
  })

  it('a click in the 3D view answers with EVERY feature that wrote the cell, and tells the graph', async () => {
    const controller = makeController()
    controller.generate.mockImplementation(async () => ({
      diagnostics: [],
      bounds: { minX: 0, minY: 0, minZ: 0, sizeX: 4, sizeY: 4, sizeZ: 4 },
      profile: {
        featureIdentifiers: ['wiki:poplar_tree', 'wiki:other'],
        features: [],
        // Cell 5 -- world (1, 0, 1) in these bounds -- was written by both.
        attribution: { cell: [5, 5], feature: [0, 1], count: [1, 3] },
      },
    }))
    const told: { packRoot: string; nodeIds: readonly string[] }[] = []
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
      undefined,
      { attributeNodeId: 'wiki:poplar_tree', onSelectNodes: (packRoot, nodeIds) => told.push({ packRoot, nodeIds }) },
    )
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    webview.simulateMessage({ type: 'pickCell', x: 1, y: 0, z: 1 })
    await flush()

    const answer = (webview.postedMessages as { type: string }[]).filter((m) => m.type === 'attributionCell').pop()
    expect(answer).toMatchObject({
      type: 'attributionCell',
      cell: 5,
      position: { x: 1, y: 0, z: 1 },
      // BOTH of them. Which one a viewer is actually looking at is not in the engine's contract,
      // so narrowing to one here would be a guess dressed as an answer.
      writers: [
        { nodeId: 'wiki:poplar_tree', writes: 1 },
        { nodeId: 'wiki:other', writes: 3 },
      ],
      writes: 4,
    })
    expect(told).toHaveLength(1)
    expect(told[0]!.nodeIds).toEqual(['wiki:poplar_tree', 'wiki:other'])
  })

  it('a click outside the previewed volume is an ordinary miss, not an error', async () => {
    const controller = makeController()
    controller.generate.mockImplementation(async () => ({
      diagnostics: [],
      bounds: { minX: 0, minY: 0, minZ: 0, sizeX: 4, sizeY: 4, sizeZ: 4 },
      profile: {
        featureIdentifiers: ['wiki:poplar_tree'],
        features: [],
        attribution: { cell: [5], feature: [0], count: [1] },
      },
    }))
    const told: unknown[] = []
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
      undefined,
      { attributeNodeId: 'wiki:poplar_tree', onSelectNodes: (_packRoot, nodeIds) => told.push(nodeIds) },
    )
    await flush()

    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    const before = (webview.postedMessages as { type: string }[]).length
    webview.simulateMessage({ type: 'pickCell', x: 99, y: 99, z: 99 })
    await flush()

    // Nothing posted, nothing told, nothing thrown. A click past the bench is a thing a camera
    // can see, not a fault.
    expect((webview.postedMessages as { type: string }[]).length).toBe(before)
    expect(told).toEqual([])
  })
})
