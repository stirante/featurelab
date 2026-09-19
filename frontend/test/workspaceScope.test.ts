// @vitest-environment jsdom
// workspaceScope.test.ts -- the WEBVIEW half of "the panel's persisted state must not cross
// projects". apps/vscode/test/workspaceScope.test.ts covers the host half (deriving a workspace
// id and stamping it onto <body>); until now the half that actually reads that attribute and
// keys storage by it had nothing but a typecheck behind it, which is the wrong way round: the
// host half is a pure function of a path list, while this half is where the reported bug lived.
//
// The bug: a VS Code webview's localStorage is scoped per EXTENSION, not per panel, window or
// workspace. With one global key, a pack biome picked in a window open on one behaviour pack
// became the selection in a window open on a different one, where that biome does not exist --
// the user saw "biome id ... is not defined by any loaded biome file" for an id they had never
// chosen there.
//
// That original symptom is now impossible twice over: a biome id is generation config, and
// generation config no longer survives a panel at all (see panel.ts's PersistedState). Keying is
// still load-bearing, though, and these tests still have to prove it -- so they probe with the
// SUBJECT (the feature/rule under test), which DOES cross panels by design and is every bit as
// pack-specific as a biome id was. The two stale-biome cases at the bottom keep the other half
// of that original story, moved to where it can still happen: the same session, after a reload.
//
// panel.ts reads the id at MODULE LOAD time (STORAGE_KEY is a module-level const, deliberately:
// it is needed during createPanel, before any host message could arrive). So every case here
// re-imports the module with a different <body> attribute via vi.resetModules() -- importing it
// once and mutating the attribute afterwards would test nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecodedResult } from '../src/protocol.js'
import type { EnvironmentMode, VoxelViewer } from '../src/viewer.js'

const BASE_KEY = 'featurelab.panel.v1'

/** Loads a FRESH copy of panel.ts with `id` stamped on <body>, the way previewPanel.ts's shell
 * HTML does before the webview's script runs. Pass null for a host with no workspace concept
 * (the Wails desktop app) or a VS Code window with no folder open. */
async function loadPanelModuleFor(id: string | null) {
  if (id === null) delete document.body.dataset.flWorkspace
  else document.body.dataset.flWorkspace = id
  vi.resetModules()
  return import('../src/ui/panel.js')
}

/** The subset of VoxelViewer createPanel actually drives. Deliberately hand-written rather than
 * imported from panel.test.ts: that file's stub belongs to its own tests, and a shared one would
 * couple two suites that assert on completely different things. */
function makeViewerStub(): VoxelViewer {
  const state = { environmentMode: 'solid' as EnvironmentMode, showCarved: true, showHeatmap: false, showOverflow: true, hasAtlas: false, texturesEnabled: false }
  return {
    setVolume: vi.fn(),
    setSlice: vi.fn(),
    getSlice: vi.fn(() => ({ minY: 0, maxY: 0 })),
    setEnvironmentMode: vi.fn((m: EnvironmentMode) => {
      state.environmentMode = m
    }),
    getEnvironmentMode: vi.fn(() => state.environmentMode),
    setShowGrid: vi.fn(),
    setShowCarved: vi.fn(),
    getShowCarved: vi.fn(() => state.showCarved),
    setShowHeatmap: vi.fn(),
    getShowHeatmap: vi.fn(() => state.showHeatmap),
    setShowOverflow: vi.fn(),
    getShowOverflow: vi.fn(() => state.showOverflow),
    getMaxTouchCount: vi.fn(() => 0),
    frameAll: vi.fn(),
    frameContent: vi.fn(),
    highlightCell: vi.fn(),
    clearHighlight: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    setBusy: vi.fn(),
    // Cancel wiring: panel.ts arms (or explicitly disarms) the viewport pill's Cancel button on
    // every panel, so this stub needs the method even in tests that never pass an onCancel.
    setCancelHandler: vi.fn(),
    canCancel: vi.fn(() => false),
    hasFramed: vi.fn(() => false),
    setProjection: vi.fn(),
    getProjection: vi.fn(() => 'perspective' as const),
    // Textures: panel.ts applies its remembered preference on construction and asks the viewer
    // what it is ACTUALLY drawing whenever it renders the texture row, so both are needed even by
    // a test that never touches textures. The stub answers "no atlas", which is every host that
    // has not fetched one -- the state the row is inert in.
    setTexturesEnabled: vi.fn((v: boolean) => {
      state.texturesEnabled = v
    }),
    getTexturesEnabled: vi.fn(() => state.hasAtlas && state.texturesEnabled),
    getTextureReport: vi.fn(() => ({ hasAtlas: state.hasAtlas, enabled: state.hasAtlas && state.texturesEnabled, blocks: 0, unresolved: [] as string[] })),
    hasAtlas: vi.fn(() => state.hasAtlas),
    setNotice: vi.fn(),
    setAttributionCells: vi.fn(),
    setAttributionGroups: vi.fn(),
    onTexturesChanged: null,
    onPick: null,
    onViewChange: null,
  } as unknown as VoxelViewer
}

function makeResult(overrides: Partial<DecodedResult> = {}): DecodedResult {
  const cells = 4 * 4 * 4
  return {
    volume: {
      minX: 0,
      minY: 10,
      minZ: 0,
      sizeX: 4,
      sizeY: 4,
      sizeZ: 4,
      data: new Uint32Array(cells),
      baseline: new Uint32Array(cells),
      changed: new Uint8Array(cells),
      removed: new Uint8Array(cells),
    },
    palette: [],
    counts: { changed: 0, placed: 0, carved: 0, replaced: 0, writesOutOfBounds: 0 },
    placementDurationMs: 1,
    libraryBuildDurationMs: 0,
    totalDurationMs: 1,
    partial: false,
    diagnostics: [],
    featureSeed: 1,
    environmentSeed: 12345,
    profile: null,
    origin: { x: 0, y: 17, z: 0 },
    entries: [],
    ruleEntries: [],
    biomeEntries: [],
    environmentBiome: null,
    overflowBlocks: [],
    grown: false,
    preGrowBounds: null,
    ...overrides,
  }
}

/** Picks the pack-biome <select> out of a rendered panel. */
function packBiomeSelectOf(root: HTMLElement): HTMLSelectElement {
  const biomeRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Pack biome')
  return biomeRow!.querySelector('select') as HTMLSelectElement
}

/** Picks the Feature <select> out of a rendered panel. */
function featureSelectOf(root: HTMLElement): HTMLSelectElement {
  const featureRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Feature')
  return featureRow!.querySelector('select') as HTMLSelectElement
}

/** Renders a panel in workspace `id` that has `featureIdentifier` as its subject, which writes
 * that choice to storage -- the pack-specific state this file is about. Uses seedOpenedDocument
 * because that is how a real host puts a subject there (previewPanel.ts, on opening a file). */
async function openFeatureIn(id: string | null, featureIdentifier: string): Promise<void> {
  const { createPanel } = await loadPanelModuleFor(id)
  const root = document.createElement('div')
  const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn() })
  panel.seedOpenedDocument('feature', featureIdentifier)
}

/** Renders a panel in workspace `id`, gives it a subject and a loaded pack containing `biomeId`,
 * and selects that biome -- the starting point for the two stale-biome cases below, which are
 * about a pack RELOAD within one session (the only way a selected biome can go stale now). */
async function panelWithSelectedBiome(id: string | null, biomeId: string) {
  const { createPanel } = await loadPanelModuleFor(id)
  const root = document.createElement('div')
  const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn() })
  panel.seedOpenedDocument('feature', 'pack_a:something')
  panel.setResult(makeResult({ biomeEntries: [{ fileId: 'b.json', identifier: biomeId, biome: null }] }))
  const select = packBiomeSelectOf(root)
  select.value = biomeId
  select.dispatchEvent(new Event('change'))
  return { panel, root }
}

describe('panel state is keyed by workspace', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.body.dataset.flWorkspace
  })

  it('suffixes the storage key with the id the host stamped on <body>', async () => {
    await openFeatureIn('abc123', 'pack_a:something')
    expect(localStorage.getItem(`${BASE_KEY}.abc123`)).not.toBeNull()
    expect(localStorage.getItem(BASE_KEY)).toBeNull()
  })

  it('uses the unsuffixed key when no id is stamped (the desktop app, or a window with no folder)', async () => {
    await openFeatureIn(null, 'pack_a:something')
    expect(localStorage.getItem(BASE_KEY)).not.toBeNull()
  })

  it('does not restore one project’s subject into another project', async () => {
    // The reported bug, end to end, in the terms that still apply: open a feature in project A,
    // then open project B. B's panel must come up with nothing selected -- not with an identifier
    // that only exists in A's pack, which would preview a feature the user is not looking at and
    // then report it as missing from the pack.
    await openFeatureIn('workspace-a', 'pack_a:something')

    const { createPanel } = await loadPanelModuleFor('workspace-b')
    const rootB = document.createElement('div')
    const panelB = createPanel(rootB, { viewer: makeViewerStub(), onConfigChange: vi.fn() })

    expect(panelB.getGenerateParams()).toBeNull() // no subject at all -- nothing to request yet
    expect(featureSelectOf(rootB).value).toBe('')
    // A's own state is still there, untouched -- scoping must isolate, not discard.
    expect(localStorage.getItem(`${BASE_KEY}.workspace-a`)).toContain('pack_a:something')
  })

  it('does restore the subject when the same project is reopened', async () => {
    // The other half of the same rule, and the reason the subject is exempt from the "generation
    // config resets" policy at all: the desktop app never reports an opened document, so this is
    // the only thing that saves a user from re-picking their feature on every launch.
    await openFeatureIn('workspace-a', 'pack_a:something')

    const { createPanel } = await loadPanelModuleFor('workspace-a')
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn() })

    expect(panel.getGenerateParams()?.feature).toBe('pack_a:something')
  })

  it('drops a selected biome the RELOADED pack no longer defines', async () => {
    // A selected biome can no longer go stale between sessions (it does not persist), but it can
    // still go stale inside one: "Reload files" after the biome file is renamed or deleted leaves
    // the selection pointing at something the pack no longer has. The request that reloaded the
    // pack is also what reveals that, so what matters is that it is corrected before any LATER
    // request rather than failing forever with "biome id ... is not defined by any loaded biome
    // file".
    const { panel, root } = await panelWithSelectedBiome('workspace-a', 'pack_a:volcano')
    expect(panel.getGenerateParams()?.biomeId).toBe('pack_a:volcano')

    panel.setResult(makeResult({ biomeEntries: [{ fileId: 'b.json', identifier: 'pack_a:renamed_volcano', biome: null }] }))

    expect(panel.getGenerateParams()?.biomeId).toBeUndefined()
    expect(packBiomeSelectOf(root).value).toBe('') // and the dropdown agrees -- back to "(preset default)"
    // Belt and braces on the policy this file's header describes: the id was never written to
    // storage in the first place, so no later panel can resurrect it either.
    expect(localStorage.getItem(`${BASE_KEY}.workspace-a`)).not.toContain('pack_a:volcano')
  })

  it('keeps a selected biome the reloaded pack still defines', async () => {
    const { panel } = await panelWithSelectedBiome('workspace-a', 'pack_a:volcano')

    panel.setResult(makeResult({ biomeEntries: [{ fileId: 'b.json', identifier: 'pack_a:volcano', biome: null }] }))

    expect(panel.getGenerateParams()?.biomeId).toBe('pack_a:volcano')
  })
})
