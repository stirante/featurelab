// previewPanel.test.ts -- exercises PreviewPanel's message handling and the "lastParams
// fallback" rule its own header comment describes: a plain document save previews the saved
// file's own feature identifier UNTIL the user touches a generation-config control in the
// panel (a `{type:'generate', params}` message from the webview), after which every
// regenerate -- including a later save -- uses that params object instead. Runs against
// fixtures/vscodeMock.ts (see that file's own doc comment) rather than a running VS Code host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { ATTRIBUTION_TAIL_GROUP_ID, PreviewPanel, effectiveGenerateTimeoutMs } from '../src/previewPanel.js'
import { EngineDisposedError, type PreviewController } from '../src/previewController.js'
import { SHOW_LOG } from '../src/log.js'

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

  // The fourth argument every generate/generateGrown assertion below allows for is the panel's
  // own AbortSignal -- what carries a user's Cancel down to the engine (see
  // PreviewPanel.cancelGenerate). Matched loosely here because these tests are about the
  // PARAMS; that the signal is real and does something is cancellation.test.ts's subject.

  it('the very first regenerate previews the open file’s own parsed feature identifier', async () => {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel({ extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext, controller, diagCollection, makeDocument(FEATURE_JSON), () => {})
    await flush()

    expect(controller.generate).toHaveBeenCalledTimes(1)
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, EXPECTED_TIMEOUT_MS, expect.anything())
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
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), customParams, EXPECTED_TIMEOUT_MS, expect.anything())

    // A later document save must NOT revert to the file's own identifier -- see this file's
    // header comment for why.
    controller.generate.mockClear()
    panel.notifyDocumentChanged(document)
    await flush()
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), customParams, EXPECTED_TIMEOUT_MS, expect.anything())
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
    expect(controller.generateGrown).toHaveBeenCalledWith(expect.any(String), stickyParams, EXPECTED_TIMEOUT_MS, expect.anything())
    expect(controller.generate).not.toHaveBeenCalled()

    // THE load-bearing assertion: a save right
    // after must inherit the SAME grown behaviour, not silently revert to a plain generate() --
    // the reported bug (grow-to-fit not surviving a reload/save) moved one level up.
    controller.generateGrown.mockClear()
    panel.notifyDocumentChanged(document)
    await flush()
    expect(controller.generateGrown).toHaveBeenCalledTimes(1)
    expect(controller.generateGrown).toHaveBeenCalledWith(expect.any(String), stickyParams, EXPECTED_TIMEOUT_MS, expect.anything())
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

    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { rule: 'wiki:crater_shrub', env: 'plains' }, EXPECTED_TIMEOUT_MS, expect.anything())

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
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), customParams, 70000, expect.anything())
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
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, EXPECTED_TIMEOUT_MS, expect.anything())

    // ...and a save-triggered regenerate does not quietly acquire one later either.
    controller.generate.mockClear()
    panel.notifyDocumentChanged(makeDocument(FEATURE_JSON))
    await flush()
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { feature: 'wiki:poplar_tree', env: 'plains' }, EXPECTED_TIMEOUT_MS, expect.anything())
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
      expect.anything(),
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
      expect.anything(),
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
    expect(controller.generate).toHaveBeenCalledWith(expect.any(String), { ...userParams, profile: true }, EXPECTED_TIMEOUT_MS, expect.anything())
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

  /** The overlay's per-writer groups off the last `attribution` message -- what the viewer is
   * asked to paint one colour each. */
  function groups(webview: { postedMessages: unknown[] }): { id: string; label: string; cells: number[] }[] {
    const attribution = (webview.postedMessages as { type: string; groups?: { id: string; label: string; cells: number[] }[] }[])
      .filter((m) => m.type === 'attribution')
      .pop()
    return attribution?.groups ?? []
  }

  /** Opens a graph-driven preview whose run attributed `cell`/`feature`/`count` across
   * `identifiers` -- the same table shape every other test in this file uses. */
  async function attributedRun(identifiers: string[], attribution: { cell: number[]; feature: number[]; count: number[] }, attribute = identifiers[0]!) {
    const controller = makeController()
    controller.generate.mockImplementation(async () => ({
      diagnostics: [],
      bounds: { minX: 0, minY: 0, minZ: 0, sizeX: 8, sizeY: 8, sizeZ: 8 },
      profile: { featureIdentifiers: identifiers, features: [], attribution },
    }))
    makePanel(controller, attribute)
    await flush()
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    return webview
  }

  it('sends EVERY writer in the run, the selected one first', async () => {
    // Three features wrote: the selected one (two cells), one that wrote three, one that wrote
    // one. The overlay's colours are assigned by POSITION, so this order is the answer to "which
    // of these is whose" -- and the selected node leading keeps it in the same blue-violet the
    // single-writer overlay has always used, whoever else turns out to have written this run.
    const webview = await attributedRun(
      ['wiki:poplar_tree', 'wiki:big', 'wiki:small'],
      { cell: [1, 2, 10, 11, 12, 20], feature: [0, 0, 1, 1, 1, 2], count: [1, 1, 1, 1, 1, 1] },
    )

    expect(groups(webview)).toEqual([
      { id: 'wiki:poplar_tree', label: 'wiki:poplar_tree', cells: [1, 2] },
      // ...then by size, largest first: a legend read top to bottom is then also a ranking.
      { id: 'wiki:big', label: 'wiki:big', cells: [10, 11, 12] },
      { id: 'wiki:small', label: 'wiki:small', cells: [20] },
    ])
  })

  it('keeps the single-writer shim on the wire underneath the groups', async () => {
    const webview = await attributedRun(['wiki:poplar_tree', 'wiki:other'], { cell: [1, 9], feature: [0, 1], count: [1, 1] })

    const attribution = (webview.postedMessages as { type: string; cells?: number[] }[]).filter((m) => m.type === 'attribution').pop()
    // `cells` is still exactly what it always was -- the selected node alone. A webview built
    // against a frontend that has no setAttributionGroups paints that, rather than nothing.
    expect(attribution?.cells).toEqual([1])
    expect(groups(webview)[0]).toEqual({ id: 'wiki:poplar_tree', label: 'wiki:poplar_tree', cells: [1] })
  })

  it('groups the tail rather than handing out a colour that is already taken', async () => {
    // Eight writers against a six-colour series. A seventh band drawn in the first one's colour
    // is a legend that lies about which blocks are whose, so everything past the palette becomes
    // one honest band that says how many features it stands for.
    const ids = ['wiki:poplar_tree', 'a', 'b', 'c', 'd', 'e', 'f', 'g']
    const cell = ids.map((_id, i) => i)
    const webview = await attributedRun(ids, { cell, feature: cell.map((_c, i) => i), count: cell.map(() => 1) })

    const sent = groups(webview)
    expect(sent).toHaveLength(6)
    expect(sent[0]?.id).toBe('wiki:poplar_tree')
    const tail = sent[5]!
    expect(tail.id).toBe(ATTRIBUTION_TAIL_GROUP_ID)
    expect(tail.label).toBe('3 more features')
    // Nothing is lost -- the band carries the cells of all three.
    expect(tail.cells).toHaveLength(3)
    expect(new Set(sent.flatMap((g) => g.cells)).size).toBe(8)
  })

  it('leaves a feature that wrote nothing out of the colours, without pretending it did not run', async () => {
    // A filter, an aggregate, a feature whose placement was refused: entering and writing nothing
    // is an ordinary answer, but it is not a colour -- an empty legend row spends one of six
    // distinguishable colours on a band with nothing under it.
    const webview = await attributedRun(['wiki:poplar_tree', 'wiki:silent'], { cell: [3], feature: [0], count: [1] })

    expect(groups(webview).map((g) => g.id)).toEqual(['wiki:poplar_tree'])
  })
})

describe('what the preview panel is handed about diagnostics', () => {
  // A generate response carries the PACK's whole build-diagnostic set ahead of the run's own,
  // because that is the order the engine builds libraries in. So every preview of every feature
  // opened with two to four several-hundred-character paragraphs about files the author was not
  // looking at, and the one line explaining why THIS preview was empty sat underneath them.

  /** A file the pack cannot parse -- pack-scoped, with the position the loader stopped at. */
  // `thing.json` because that is this suite's document: a build-time diagnostic carries the pack
  // loader's own spelling of the file, and the panel matches it against the open document's
  // basename (see diagnostics.ts's updateDiagnostics).
  const PACK_TRUNCATED = {
    level: 'error',
    fileId: 'thing.json',
    scope: 'pack',
    line: 4,
    column: 57,
    message: 'invalid JSON at line 4, column 57: unexpected end of JSON input',
  }
  /** A second pack-scoped paragraph, of the length that actually causes the problem. */
  const PACK_ODD = {
    level: 'warning',
    fileId: 'mossy_boulder.json',
    scope: 'pack',
    message:
      'places_block[0] carries a directional state, which this preview draws unrotated because the block geometry ' +
      'is a resource-pack model rather than a full cube, so the face the state selects cannot be resolved here.',
  }
  /** The one line that explains the run being looked at. */
  const RUN_STOPPED = {
    level: 'warning',
    fileId: 'wiki:poplar_tree',
    scope: 'run',
    message: 'iterations evaluated to zero, so nothing was placed',
  }

  function postedResult(webview: { postedMessages: unknown[] }): { diagnostics: { fileId: string; message: string }[] } {
    const message = [...webview.postedMessages].reverse().find((m) => (m as { type?: string })?.type === 'result')
    expect(message, 'no "result" message was posted').toBeDefined()
    return (message as { result: { diagnostics: { fileId: string; message: string }[] } }).result
  }

  /** The open file, with enough lines for a range to land on the wrong one visibly. `makeDocument`
   * reports a single empty line, which would send every positioned diagnostic down the
   * whole-document fallback and quietly prove nothing. */
  // Line 4 is deliberately longer than column 57, so the assertion below is about the position
  // and not about the clamp that catches a column past the end of its line.
  const LINES = [
    '{',
    '  "format_version": "1.19.0",',
    '  "minecraft:tree_feature": {',
    '    "description": { "identifier": "wiki:poplar_tree" }, "places_block": "minecraft:stone"',
  ]
  function multilineDocument(): import('vscode').TextDocument {
    return {
      ...(makeDocument(FEATURE_JSON) as unknown as Record<string, unknown>),
      lineCount: LINES.length,
      lineAt: (n: number) => ({ text: LINES[n] ?? '' }),
    } as unknown as import('vscode').TextDocument
  }

  async function previewWith(diagnostics: unknown[]): Promise<{ webview: { postedMessages: unknown[] }; diagCollection: { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } }> {
    const controller = makeController()
    controller.generate.mockImplementation(async () => ({ diagnostics }))
    const diagCollection = { set: vi.fn(), delete: vi.fn() }
    new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection as unknown as import('vscode').DiagnosticCollection,
      multilineDocument(),
      () => {},
    )
    await flush()
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()
    return { webview, diagCollection }
  }

  it('shows this run\'s diagnostics first, not under the pack\'s', async () => {
    const { webview } = await previewWith([PACK_TRUNCATED, PACK_ODD, RUN_STOPPED])
    const result = postedResult(webview)
    expect(result.diagnostics[0]!.message).toBe(RUN_STOPPED.message)
  })

  it('collapses the pack-wide ones into one labelled row carrying their count', async () => {
    const { webview } = await previewWith([PACK_TRUNCATED, PACK_ODD, RUN_STOPPED])
    const result = postedResult(webview)
    // Two rows, not three: the run's own, and one standing in for both pack-wide paragraphs.
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[1]!.message.split('\n')[0]).toContain('2 pack-wide problem(s)')
  })

  it('still carries every pack-wide message, so the panel can reveal them on demand', async () => {
    // Nothing is DROPPED. Dropping the pack's half would recreate, inside the preview, exactly
    // the silence this change removes everywhere else. The newline is what makes the panel clamp
    // the row to a line and offer "Show more" (frontend/src/ui/panel.ts's isLongDiagnostic).
    const { webview } = await previewWith([PACK_TRUNCATED, PACK_ODD, RUN_STOPPED])
    const summary = postedResult(webview).diagnostics[1]!
    expect(summary.message).toContain('\n')
    expect(summary.message).toContain('thing.json 4:57 -- invalid JSON at line 4, column 57: unexpected end of JSON input')
    expect(summary.message).toContain(PACK_ODD.message)
  })

  it('adds no row at all for a pack with nothing wrong with it', async () => {
    const { webview } = await previewWith([RUN_STOPPED])
    expect(postedResult(webview).diagnostics).toEqual([RUN_STOPPED])
  })

  it('feeds the Problems view the UNSUMMARISED list, with the engine\'s own position', async () => {
    // The Problems view is the durable place a pack-wide problem belongs, and a folded row there
    // would hide the file it is about -- which is the one thing the reader needs to act.
    const { diagCollection } = await previewWith([PACK_TRUNCATED, RUN_STOPPED])
    expect(diagCollection.set).toHaveBeenCalledTimes(1)
    const marked = diagCollection.set.mock.calls[0]![1] as { range: { startLine: number; startChar: number }; message: string }[]
    // Both: the pack's problem in this file (matched on the basename) and the run's (matched on
    // the requested identifier).
    expect(marked).toHaveLength(2)
    const parse = marked.find((d) => d.message.includes('invalid JSON'))!
    expect(parse.range.startLine).toBe(3)
    expect(parse.range.startChar).toBe(56)
  })
})

// ---------------------------------------------------------------------------
// Re-pointing one panel at another file -- the graph's follow-the-selection preview.
// ---------------------------------------------------------------------------
//
// THE BUG THIS BLOCK EXISTS FOR was a silent wrong answer, which is the worst kind this panel
// can give: with "Preview on select" on, clicking node B after having touched ANY control while
// looking at node A renamed the tab to B, told the graph it was previewing B, and generated A.
// Nothing on screen disagreed with anything else, so there was no way to notice except by
// knowing what A and B were supposed to look like.
//
// It survived because it needed two steps to appear. `lastParams` is empty on a fresh panel, so
// the FIRST retarget of a panel nobody had touched worked perfectly; only a seed (or a size, or
// an origin -- anything that posts a `generate`) armed it.
describe('PreviewPanel: re-pointing at another file', () => {
  const EXPECTED_TIMEOUT_MS = 18000

  const OTHER_FEATURE_JSON = JSON.stringify({
    format_version: '1.19.0',
    'minecraft:single_block_feature': { description: { identifier: 'wiki:crater_boulder' } },
  })

  /** A panel on a.json whose author has already set a seed -- i.e. one with lastParams armed,
   * which is the state the bug needed. */
  async function panelWithTouchedControls(): Promise<{
    panel: PreviewPanel
    controller: ReturnType<typeof makeController>
    webview: { simulateMessage(m: unknown): void; postedMessages: unknown[] }
    tab: { title: string }
  }> {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON, '/pack/features/a.json'),
      () => {},
    )
    await flush()
    const created = vscodeMock.createdPanels[0]!
    created.webview.simulateMessage({ type: 'ready' })
    await flush()
    // The gesture that arms it: one control touched, which is all it takes.
    created.webview.simulateMessage({ type: 'generate', params: { feature: 'wiki:poplar_tree', env: 'plains', seed: 42 } })
    await flush()
    controller.generate.mockClear()
    created.webview.postedMessages.length = 0
    return { panel, controller, webview: created.webview, tab: created }
  }

  it('regenerates the NEW feature, not the previous one, even after the panel’s own controls were touched', async () => {
    const { panel, controller } = await panelWithTouchedControls()

    panel.retargetTo(makeDocument(OTHER_FEATURE_JSON, '/pack/features/b.json'))
    await flush()

    expect(controller.generate).toHaveBeenCalledTimes(1)
    // The NEW file's own identifier, at the fallback env -- i.e. the params a freshly opened
    // preview of b.json would have used. Previously this was `{feature: 'wiki:poplar_tree',
    // env: 'plains', seed: 42}`: A's feature, under B's name.
    expect(controller.generate).toHaveBeenCalledWith(
      expect.any(String),
      { feature: 'wiki:crater_boulder', env: 'plains' },
      EXPECTED_TIMEOUT_MS,
      expect.anything(),
    )
  })

  it('re-seeds the picker, so the sidebar names the same feature as the tab', async () => {
    // `init` used to be posted from the 'ready' handler and nowhere else, so a panel that had
    // already booted went on showing the PREVIOUS feature in its own Feature/Rule dropdown --
    // disagreeing with its own tab title and with the graph.
    const { panel, webview, tab } = await panelWithTouchedControls()

    panel.retargetTo(makeDocument(OTHER_FEATURE_JSON, '/pack/features/b.json'))
    await flush()

    expect(webview.postedMessages).toContainEqual({ type: 'init', kind: 'feature', identifier: 'wiki:crater_boulder' })
    expect(tab.title).toBe('Preview: b.json')
  })

  it('does not fall back to a stale identifier when the new file cannot be parsed', async () => {
    // Clearing lastParams means the file is now the only source of truth, so a file that is
    // mid-edit has to produce the ordinary "cannot preview this file" error rather than quietly
    // regenerating whatever was previewed before it.
    const { panel, controller, webview } = await panelWithTouchedControls()

    panel.retargetTo(makeDocument('{ not json', '/pack/features/b.json'))
    await flush()

    expect(controller.generate).not.toHaveBeenCalled()
    expect(webview.postedMessages.some((m) => (m as { type?: string }).type === 'error')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A burst of writes, and the run that loses the race
// ---------------------------------------------------------------------------
describe('PreviewPanel: pack writes arriving in bursts', () => {
  function openPanel(): { panel: PreviewPanel; controller: ReturnType<typeof makeController> } {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
    )
    return { panel, controller }
  }

  it('reloads and regenerates ONCE for ten files written together', async () => {
    // Ten quick edits in the node editor used to be ten full reload-and-regenerate cycles per
    // open preview: serialised, so they could not race, but not collapsed, so the author watched
    // nine answers they had already moved past go by before the one they were waiting for.
    const { panel, controller } = openPanel()
    await flush()
    controller.generate.mockClear()

    panel.notifyPackFilesWritten([], Array.from({ length: 10 }, (_, i) => `/pack/features/f${String(i)}.json`))
    await flush()

    expect(controller.reloadPack).toHaveBeenCalledTimes(1)
    expect(controller.generate).toHaveBeenCalledTimes(1)
    // A burst that touched several files gets the FULL re-read: reloadPackFile's fast path
    // re-reads exactly the one file it is given, which is wrong the moment two changed.
    expect(controller.reloadPackFile).not.toHaveBeenCalled()
  })

  it('still re-reads only the one file when only one was written', async () => {
    const { panel, controller } = openPanel()
    await flush()

    panel.notifyPackFilesWritten([], ['/pack/features/f0.json'])
    await flush()

    expect(controller.reloadPackFile).toHaveBeenCalledWith(expect.any(String), '/pack/features/f0.json', expect.any(Number))
    expect(controller.reloadPack).not.toHaveBeenCalled()
  })

  it('ignores a burst that touched nothing this panel’s pack loads', async () => {
    const { panel, controller } = openPanel()
    await flush()
    controller.generate.mockClear()

    panel.notifyPackFilesWritten([], ['/somewhere/else/notes.txt'])
    await flush()

    expect(controller.reloadPack).not.toHaveBeenCalled()
    expect(controller.reloadPackFile).not.toHaveBeenCalled()
    expect(controller.generate).not.toHaveBeenCalled()
  })

  it('never draws the result of a run a newer regenerate has already superseded', async () => {
    // The superseded run is CANCELLED on purpose, to stop it holding the engine's one worker --
    // but a cancel is a request, not a guarantee, and an engine that had already answered comes
    // back with a perfectly valid result for a pack state nobody is waiting to see any more.
    // Posting it would put an older volume on screen, after the newer one, with nothing saying so.
    const controller = makeController()
    let releaseFirst: (value: unknown) => void = () => {}
    controller.generate
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
      .mockImplementationOnce(async () => ({ diagnostics: [], marker: 'second' }))
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
    )
    await flush()
    const webview = vscodeMock.createdPanels[0]!.webview
    webview.simulateMessage({ type: 'ready' })
    await flush()

    // The second run supersedes the first, which is still in flight.
    webview.simulateMessage({ type: 'generate', params: { feature: 'wiki:poplar_tree', env: 'plains', seed: 1 } })
    await flush()
    // ...and only now does the engine answer the first one.
    releaseFirst({ diagnostics: [], marker: 'first' })
    await flush()

    const results = webview.postedMessages.filter((m) => (m as { type?: string }).type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { result: { marker?: string } }).result.marker).toBe('second')
  })
})

// ---------------------------------------------------------------------------
// A preview whose bundle never loads.
//
// The graph panel has had both halves of this since the identical report was made about it: a
// sentence shipped in the static HTML (WEBVIEW_DID_NOT_START) and a 15-second backstop that tells
// the command its panel is never coming. The preview shipped with NEITHER -- a CSP that rejected
// the bundle, an asset left out of the VSIX, a corrupted install, and the result was a tab holding
// a blank grey rectangle beside a progress notification that span forever. Nothing on screen, in
// either place, distinguished it from an editor that was merely slow.
// ---------------------------------------------------------------------------
describe('PreviewPanel: a webview that never starts', () => {
  beforeEach(() => {
    // These two accumulate across the whole file, so without clearing them the assertions below
    // would be about whatever an earlier test happened to say.
    vscodeMock.warningMessages.length = 0
    vscodeMock.outputLines.length = 0
  })

  function openPanel(): PreviewPanel {
    const controller = makeController()
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    return new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
    )
  }

  it('ships the sentence in the static HTML, visible, so a blank panel is never silent', () => {
    openPanel()
    const html = vscodeMock.createdPanels[0]?.webview.html ?? ''

    expect(html).toContain('fl-boot')
    expect(html).toMatch(/script did not load/i)
    // It points at the one place the reason really is. "Something went wrong" with no next step
    // is the same dead end with better manners.
    expect(html).toMatch(/Show Log/i)
    // NOT hidden by default. Hidden-by-default is what makes a blank panel possible in the first
    // place -- the element is removed by the script that proves it ran, never revealed by one.
    expect(html).not.toMatch(/id="fl-boot"[^>]*hidden/)
  })

  it('says so out loud once the first run has already settled, which is the usual case', async () => {
    // The trap this finding is really about. A result is BUFFERED for a webview that has not
    // reported ready, and postResult settles the first run regardless -- so the command returned
    // happy while the author sat looking at a blank rectangle. There is nobody left to hand a
    // reason to by then, so it has to be said, with the log button every other message carries.
    vi.useFakeTimers()
    try {
      const panel = openPanel()
      await vi.advanceTimersByTimeAsync(0)
      await panel.whenFirstResult()

      await vi.advanceTimersByTimeAsync(15_000)

      const said = vscodeMock.warningMessages.map((m) => m.message).join(' ')
      expect(said).toMatch(/script never started/i)
      expect(said).toMatch(/blank/i)
      expect(vscodeMock.warningMessages[0]?.actions).toContain(SHOW_LOG)
      // And the long form -- which file, and the two things that really cause it -- is in the log.
      expect(vscodeMock.outputLines.join(' ')).toMatch(/Content-Security-Policy|dist\/webview\.js/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the reason to the command instead, while the command is still waiting', async () => {
    vi.useFakeTimers()
    try {
      // A controller whose generate never answers: the first run is still outstanding, so a
      // command IS holding a notification over this panel and the reason belongs to it.
      const controller = makeController()
      controller.generate.mockImplementation(() => new Promise(() => {}))
      const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
      const panel = new PreviewPanel(
        { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
        controller,
        diagCollection,
        makeDocument(FEATURE_JSON),
        () => {},
      )
      const outcome = panel.whenFirstResult().then(
        () => null,
        (err: unknown) => err,
      )
      await vi.advanceTimersByTimeAsync(15_000)

      const err = await outcome
      expect(err).toBeInstanceOf(Error)
      expect(String((err as Error).message)).toMatch(/script did not start/i)
      expect(String((err as Error).message)).toMatch(/bundle did not load/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stands down the moment the webview says it is running', async () => {
    vi.useFakeTimers()
    try {
      const panel = openPanel()
      const settled: string[] = []
      void panel.whenFirstResult().then(
        () => settled.push('resolved'),
        () => settled.push('rejected'),
      )
      vscodeMock.createdPanels[0]?.webview.simulateMessage({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(60_000)

      // A working panel must never be told it failed, however long the user leaves it open.
      expect(settled).not.toContain('rejected')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// WHEN THE ENGINE IS SWAPPED UNDER AN OPEN PANEL.
//
// A panel captures its PreviewController at construction and nothing re-binds it. Changing
// `featurelab.binaryPath` makes extension.ts dispose that controller and build a new one -- so
// from that moment the panel is holding the PREVIOUS engine, and it used to go on using it: the
// controller's dispose() only nulled its process, and its ensureEngine() read that as "never
// started" and spawned the old binary again. The run succeeded, the picture updated, and the
// engine that answered was the one the user believed they had stopped using.
//
// The controller now refuses instead (previewController.test.ts pins that). What this file pins
// is the other half: the panel has to turn that refusal into something a person can act on,
// rather than a raw error string, and it has to say it when the swap happens rather than
// whenever the next save comes along.
// ---------------------------------------------------------------------------
describe('PreviewPanel: an engine replaced underneath it', () => {
  /** The stale-banner reasons the webview was handed, in order. */
  function staleReasons(panel: vscodeMock.MockWebviewPanel): string[] {
    return panel.webview.postedMessages
      .filter((m): m is { type: string; stale?: boolean; reason?: string } => (m as { type: string }).type === 'stale')
      .filter((m) => m.stale === true)
      .map((m) => m.reason ?? '')
  }

  function lastPanel(): vscodeMock.MockWebviewPanel {
    const panel = vscodeMock.createdPanels[vscodeMock.createdPanels.length - 1]
    if (!panel) throw new Error('no webview panel was created')
    return panel
  }

  function openPanel(controller: PreviewController): PreviewPanel {
    const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
    const panel = new PreviewPanel(
      { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
      controller,
      diagCollection,
      makeDocument(FEATURE_JSON),
      () => {},
    )
    // The webview has to have reported `ready`, or every message below sits in the panel's
    // outbox instead of on the wire -- see PreviewPanel.post. mockConfig.blockTextures is off in
    // this suite, so `ready` costs nothing else.
    lastPanel().webview.simulateMessage({ type: 'ready' })
    return panel
  }

  it('reports a generate answered by a disposed controller as an actionable failure', async () => {
    const controller = makeController()
    controller.generate.mockRejectedValue(new EngineDisposedError('/old/featurelab'))
    const panel = openPanel(controller)
    await flush()
    await flush()

    const reasons = staleReasons(lastPanel())
    expect(reasons.join('\n')).toContain('/old/featurelab')
    expect(reasons.join('\n')).toMatch(/binaryPath/)
    // The instruction, not just the diagnosis. A panel cannot rebind its own controller, so
    // "reopen it" is the only thing there is to do and has to be said.
    expect(reasons.join('\n')).toMatch(/open it again|reopen/i)
    panel.dispose()
  })

  it('says so as soon as the host tells it, rather than waiting for the next save', async () => {
    // The gap between the swap and the next regenerate is exactly the window in which somebody
    // believes they have changed engines. It can be minutes.
    const controller = makeController()
    let disposed = false
    ;(controller as unknown as { isDisposed(): boolean; binaryPath: string }).isDisposed = () => disposed
    ;(controller as unknown as { binaryPath: string }).binaryPath = '/old/featurelab'
    const panel = openPanel(controller)
    await flush()
    expect(staleReasons(lastPanel())).toHaveLength(0)

    disposed = true
    panel.notifyEngineDisposed()

    expect(staleReasons(lastPanel()).join('\n')).toContain('/old/featurelab')
    panel.dispose()
  })

  it('leaves a panel whose controller is still live completely alone', async () => {
    // The host tells every open panel; only the ones actually holding the replaced controller
    // are concerned. A panel opened against the NEW engine must not be told its engine is gone.
    const controller = makeController()
    ;(controller as unknown as { isDisposed(): boolean }).isDisposed = () => false
    const panel = openPanel(controller)
    await flush()

    panel.notifyEngineDisposed()

    expect(staleReasons(lastPanel())).toHaveLength(0)
    panel.dispose()
  })
})
