// @vitest-environment jsdom
// panel.test.ts -- exercises createPanel()'s generation-config side: building a
// GenerateParamsWire from control state, the "never send a value the user has not touched"
// rule the task this port was built against calls out explicitly, and the always-visible
// counts/diagnostics readouts. Runs against real DOM APIs (jsdom, see vitest.config.ts) and a
// minimal hand-written VoxelViewer stub (see makeViewerStub) -- the real VoxelViewer needs a
// WebGL context jsdom does not provide, and panel.ts only ever calls a handful of its methods.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPanel, parseBudgetDiagnostic } from '../src/ui/panel.js'
import type { PanelHandle } from '../src/ui/panel.js'
import type { BiomeEntryWire, DecodedDiagnostic, DecodedResult, EnvironmentOptionWire, FeatureEntryWire, GenerateParamsWire, RuleEntryWire } from '../src/protocol.js'
import type { EnvironmentMode, VoxelViewer } from '../src/viewer.js'

// The REAL stylesheet, loaded into jsdom's own CSSOM once for the whole file -- most of this
// file's tests only assert on DOM structure/classList (CSS-independent by design), but one
// regression ("Rule mode still shows the feature's type") was a pure CSS bug: panel.ts already
// toggled the right classes, a stylesheet gap just meant nothing hid the element on screen. A
// DOM-only assertion (classList.contains('fl-hidden')) would have passed even before that fix,
// so proving it stays fixed needs the real rules applied -- see the "Feature/Rule mode
// visibility" describe block below.
//
// Resolved via process.cwd(), NOT `new URL(..., import.meta.url)` -- see vitest.config.ts's own
// comment: this file's `@vitest-environment jsdom` pragma gives import.meta.url a non-file
// jsdom `location`, which fileURLToPath then rejects ("The URL must be of scheme file").
// process.cwd() is this package's own root (vitest always runs from there) regardless of
// environment, so it isn't affected.
const PANEL_CSS = readFileSync(join(process.cwd(), 'src/ui/panel.css'), 'utf8')
const styleEl = document.createElement('style')
styleEl.textContent = PANEL_CSS
document.head.append(styleEl)

function makeViewerStub(): VoxelViewer {
  const state = { environmentMode: 'solid' as EnvironmentMode, showCarved: true, showHeatmap: false, showOverflow: true }
  return {
    setVolume: vi.fn(),
    setSlice: vi.fn(),
    getSlice: vi.fn(() => ({ minY: 0, maxY: 0 })),
    setEnvironmentMode: vi.fn((m: EnvironmentMode) => {
      state.environmentMode = m
    }),
    getEnvironmentMode: vi.fn(() => state.environmentMode),
    setShowGrid: vi.fn(),
    setShowCarved: vi.fn((v: boolean) => {
      state.showCarved = v
    }),
    getShowCarved: vi.fn(() => state.showCarved),
    setShowHeatmap: vi.fn((v: boolean) => {
      state.showHeatmap = v
    }),
    getShowHeatmap: vi.fn(() => state.showHeatmap),
    setShowOverflow: vi.fn((v: boolean) => {
      state.showOverflow = v
    }),
    getShowOverflow: vi.fn(() => state.showOverflow),
    getMaxTouchCount: vi.fn(() => 0),
    frameAll: vi.fn(),
    frameContent: vi.fn(),
    highlightCell: vi.fn(),
    clearHighlight: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    // Busy state: panel.ts's own applyBusy forwards every busy transition to the
    // viewer so the 3D preview dims/undims alongside the sidebar's stat tiles -- every existing
    // setResult/setError/setStale(true) call already exercises this via panel.ts's own safety
    // net (see applyBusy's doc comment there), so this stub needs the method even in tests that
    // never call panel.setBusy() themselves.
    setBusy: vi.fn(),
  } as unknown as VoxelViewer
}

/** Minimal DecodedDiagnostic builder -- fills in the new identifier/typeId/chain/count/position
 * fields with sane single-element/no-op defaults so a test
 * only needs to override what it's actually asserting on. */
function makeDiagnostic(overrides: Partial<DecodedDiagnostic> & Pick<DecodedDiagnostic, 'level' | 'fileId' | 'message'>): DecodedDiagnostic {
  return {
    identifier: overrides.fileId,
    typeId: '',
    chain: [overrides.fileId],
    count: 1,
    position: null,
    ...overrides,
  }
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
    counts: { changed: 12, placed: 8, carved: 3, replaced: 1, writesOutOfBounds: 0 },
    placementDurationMs: 1.5,
    libraryBuildDurationMs: 0,
    totalDurationMs: 1.5,
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

/** Minimal `environments` method fixture -- just enough presets (mirroring their real
 * env/environment.go values) for the Preset-change/Biome-tags-default tests below, which need
 * setEnvironments() to have delivered SOMETHING before touching the Preset <select> (see
 * panel.ts's renderEnvironmentOptions -- an empty list means no <option>s exist at all).
 *
 * Includes 'ocean' specifically because it is the one preset with buildsSea: true -- the sea-slot
 * tests below need BOTH sides of that flag present in the same list, and the note the panel
 * writes names the sea-building presets by reading them back out of it. */
function makeEnvironments(): EnvironmentOptionWire[] {
  return [
    {
      id: 'plains',
      label: 'Plains',
      description: 'Gently rolling grass over dirt and stone.',
      defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 },
      materials: { topMaterial: 'minecraft:grass_block', midMaterial: 'minecraft:dirt', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 0 },
      buildsSea: false,
      biome: 'plains',
      biomeTags: ['animal', 'monster', 'overworld', 'plains', 'bee_habitat'],
    },
    {
      id: 'desert',
      label: 'Desert',
      description: 'Sand over sandstone over stone.',
      defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 },
      materials: { topMaterial: 'minecraft:sand', midMaterial: 'minecraft:sand', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 0 },
      buildsSea: false,
      biome: 'desert',
      biomeTags: ['desert', 'monster', 'overworld'],
    },
    {
      id: 'ocean',
      label: 'Ocean floor',
      description: 'Sand and gravel seabed under a full water column, for underwater features.',
      defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 30 },
      materials: { topMaterial: 'minecraft:sand', midMaterial: 'minecraft:sand', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 0 },
      buildsSea: true,
      biome: 'ocean',
      biomeTags: ['ocean', 'monster', 'overworld'],
    },
  ]
}

/** One loaded pack biome (wiki:crater) whose surfaceBuilder differs from every preset above --
 * fixture for the "selecting a Pack biome changes materials" tests, mirroring the real engine
 * behaviour this port was verified against (grass_block/stone counts shifting when
 * `--biome-id <a pack biome>` is set, see this repo's biomes/session tests). */
function makeCraterBiomeEntry(): BiomeEntryWire {
  return {
    fileId: 'crater.json',
    identifier: 'wiki:crater',
    biome: {
      identifier: 'wiki:crater',
      fileId: 'crater.json',
      tags: ['crater', 'monster', 'overworld'],
      surfaceBuilder: {
        topMaterial: 'minecraft:magma_block',
        midMaterial: 'minecraft:netherrack',
        foundationMaterial: 'minecraft:basalt',
        seaFloorMaterial: 'minecraft:gravel',
        seaMaterial: 'minecraft:lava',
        seaFloorDepth: 0,
      },
      surfaceBuilderType: null,
      climate: null,
      replaceBiomes: [],
    },
  }
}

beforeEach(() => {
  localStorage.clear()
})

// Regression: "Rule mode still shows the feature's type" -- panel.ts already toggled 'fl-hidden' on
// featureInfoEl/ruleInfoEl correctly; the bug was that panel.css only ever matched
// `.fl-row.fl-hidden`, and featureInfoEl/ruleInfoEl are plain `.fl-info` divs, not `.fl-row`s --
// so the class landed but nothing hid the element. Uses getComputedStyle against the REAL
// stylesheet (loaded into document.head above) specifically so this can't pass the way a
// classList-only assertion would have passed even before the fix -- see this block's own
// setup comment.
describe('createPanel: Feature/Rule mode visibility', () => {
  it('switching to Rule mode hides the Feature picker AND its "type ... · file" info line, not just the picker', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(
      makeResult({
        entries: [{ fileId: 'poplar_tree.json', identifier: 'wiki:poplar_tree', typeId: 'minecraft:tree_feature' }],
      }),
    )
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')

    const featureInfo = [...root.querySelectorAll('.fl-info')].find((el) => (el.textContent ?? '').includes('minecraft:tree_feature'))!
    expect(featureInfo).toBeDefined()
    expect(getComputedStyle(featureInfo).display).not.toBe('none') // feature mode: visible

    const ruleRadio = root.querySelector('input[type=radio][name=fl-preview-mode][value=rule]') as HTMLInputElement
    ruleRadio.checked = true
    ruleRadio.dispatchEvent(new Event('change'))

    // The actual reported bug: this must be display:none, not just carry the class.
    expect(featureInfo.classList.contains('fl-hidden')).toBe(true)
    expect(getComputedStyle(featureInfo).display).toBe('none')
  })

  it('the Environment section’s "Min Y" and the View section’s "Min Y (cut)" are two different controls with two different labels', () => {
    const root = document.createElement('div')
    document.body.append(root)
    createPanel(root, { viewer: makeViewerStub() })
    const minYLabels = [...root.querySelectorAll('.fl-row-label')].filter((l) => (l.textContent ?? '').startsWith('Min Y'))
    expect(minYLabels.map((l) => l.textContent)).toEqual(['Min Y', 'Min Y (cut)'])
  })
})

// Regression: opening a rule file (e.g. crater_shrub.fr.json) kept showing whatever
// feature/rule a PREVIOUS preview panel had persisted (the floating-isle feature), in both mode and picker --
// there was no rule path from previewPanel.ts's tryPostInit() through webview/main.ts's 'init'
// handler at all, so a rule file's own identifier got posted and seeded as if it were a
// feature's. seedOpenedDocument (the fixed, kind-aware replacement for the old feature-only
// seedInitialFeature) must make the OPENED document win over whatever localStorage restored --
// persisted selection is a fallback for "nothing was opened", never an override of an explicit
// open. These tests deliberately persist the OPPOSITE kind/identifier first, so a pass actually
// proves the open won rather than merely being consistent with an empty/default state.
describe('createPanel: seedOpenedDocument -- the opened document wins over persisted state', () => {
  // THE load-bearing assertion for the "always override" behaviour.
  it('opening a RULE file switches to Rule mode with that rule selected, even though a FEATURE was persisted', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub() })
    panel1.seedOpenedDocument('feature', 'wiki:floating_isle.waterfall') // persists feature mode + this identifier

    const root2 = document.createElement('div')
    document.body.append(root2)
    const panel2 = createPanel(root2, { viewer: makeViewerStub() }) // restores mode: 'feature', featureIdentifier: 'wiki:floating_isle.waterfall'
    expect(panel2.getGenerateParams()?.feature).toBe('wiki:floating_isle.waterfall') // sanity: the stale state really did restore

    panel2.seedOpenedDocument('rule', 'wiki:crater_shrub')

    const ruleRadio = root2.querySelector('input[type=radio][name=fl-preview-mode][value=rule]') as HTMLInputElement
    expect(ruleRadio.checked).toBe(true)
    const ruleSelect = [...root2.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Rule')!.querySelector('select') as HTMLSelectElement
    expect(ruleSelect.value).toBe('wiki:crater_shrub')
    const params = panel2.getGenerateParams()!
    expect(params.rule).toBe('wiki:crater_shrub')
    expect(params.feature).toBeUndefined() // the stale feature must not still be sent alongside it

    // The Feature picker's own info line must not still be showing the stale floating-isle feature
    // either -- it's hidden in Rule mode (see above), but check it's not lurking un-hidden by CSS.
    const featureRow = [...root2.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Feature')!
    expect(getComputedStyle(featureRow).display).toBe('none')
  })

  it('opening a FEATURE file switches to Feature mode with that feature selected, even though a RULE was persisted', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub() })
    panel1.seedOpenedDocument('rule', 'wiki:floating_isle.main') // persists rule mode + this identifier

    const root2 = document.createElement('div')
    document.body.append(root2)
    const panel2 = createPanel(root2, { viewer: makeViewerStub() }) // restores mode: 'rule', ruleIdentifier: 'wiki:floating_isle.main'
    expect(panel2.getGenerateParams()?.rule).toBe('wiki:floating_isle.main') // sanity: the stale state really did restore

    panel2.seedOpenedDocument('feature', 'wiki:crater_shrub')

    const featureRadio = root2.querySelector('input[type=radio][name=fl-preview-mode][value=feature]') as HTMLInputElement
    expect(featureRadio.checked).toBe(true)
    const featureSelect = [...root2.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Feature')!.querySelector('select') as HTMLSelectElement
    expect(featureSelect.value).toBe('wiki:crater_shrub')
    const params = panel2.getGenerateParams()!
    expect(params.feature).toBe('wiki:crater_shrub')
    expect(params.rule).toBeUndefined()
  })

  it('an opened identifier absent from the loaded pack still selects it (never silently keeps the stale selection), and says so plainly once a result arrives', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('rule', 'wiki:typo.dose_not_exist')

    // Selected immediately, before any result -- not left on whatever was there before (nothing,
    // here, but the point is it's THIS identifier showing, not a blank/stale one).
    const ruleSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Rule')!.querySelector('select') as HTMLSelectElement
    expect(ruleSelect.value).toBe('wiki:typo.dose_not_exist')

    // A result arrives whose ruleEntries don't include it -- the pack genuinely doesn't define
    // it. The info line must say so plainly (this repo's existing "not found in loaded rule
    // files" text), not paper over it by falling back to something else.
    panel.setResult(makeResult({ ruleEntries: [{ fileId: 'main.json', identifier: 'wiki:floating_isle.main', rule: null }] }))
    const ruleInfo = [...root.querySelectorAll('.fl-info')].find((el) => (el.textContent ?? '').includes('not found in loaded rule files'))
    expect(ruleInfo).toBeDefined()
    expect(ruleInfo!.textContent).toContain('wiki:typo.dose_not_exist')
  })

  // What this has always been protecting: seedOpenedDocument is allowed to override the SUBJECT
  // and nothing else -- a host telling the panel "this file is now open" must not double as a
  // reset of everything the user configured. It used to prove that across two panels, which no
  // longer isolates the claim now that a fresh panel resets the generation config on its own
  // (see panel.ts's PersistedState): the budget would come back blank either way, and the test
  // would be asserting the persistence policy rather than seedOpenedDocument's own restraint.
  // So it now stays within ONE session, where the distinction is real: everything below is
  // live, in-panel state at the moment the host reports a newly opened file.
  it('changes only the subject -- a live budget, view toggle, sticky-grow and section state all survive it in the same session', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onGrowRegenerate: vi.fn() })
    panel.seedOpenedDocument('feature', 'wiki:floating_isle.waterfall')
    const writeBudgetRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Write budget')!
    const budgetInput = writeBudgetRow.querySelector('input') as HTMLInputElement
    budgetInput.value = '10000000'
    budgetInput.dispatchEvent(new Event('change'))
    growStickyCheckboxOf(root).checked = true
    growStickyCheckboxOf(root).dispatchEvent(new Event('change'))
    const heatmapCheckbox = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Show heatmap')!.querySelector('input') as HTMLInputElement
    heatmapCheckbox.checked = true
    heatmapCheckbox.dispatchEvent(new Event('change'))
    const profilerSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'profiler')! as HTMLElement
    profilerSection.querySelector('.fl-section-header')!.dispatchEvent(new Event('click'))
    expect(profilerSection.classList.contains('fl-collapsed')).toBe(true)

    panel.seedOpenedDocument('rule', 'wiki:crater_shrub') // a DIFFERENT subject -- only this should change

    const params = panel.getGenerateParams()!
    expect(params.rule).toBe('wiki:crater_shrub')
    expect(params.feature).toBeUndefined()
    expect(params.writeBudget).toBe(10000000)
    expect(growStickyCheckboxOf(root).checked).toBe(true)
    expect(heatmapCheckbox.checked).toBe(true)
    expect(profilerSection.classList.contains('fl-collapsed')).toBe(true)
  })
})

describe('createPanel: layout', () => {
  it('renders all eight required collapsible sections, in order', () => {
    const root = document.createElement('div')
    createPanel(root, { viewer: makeViewerStub() })
    const ids = [...root.querySelectorAll('.fl-section')].map((s) => (s as HTMLElement).dataset.sectionId)
    expect(ids).toEqual(['feature', 'environment', 'materials', 'biome', 'budget', 'view', 'diagnostics', 'profiler'])
  })

  it('exposes the placed/carved/replaced readout as three distinct, prominent stat tiles', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult())
    const values = [...root.querySelectorAll('.fl-stat-value')].map((el) => el.textContent)
    expect(values).toEqual(['8', '3', '1']) // placed, carved, replaced -- distinct, not merged
  })
})

// --- out-of-bounds capture banner / grow-and-regenerate button / grown re-run banner --------
describe('createPanel: out-of-bounds capture and grow-and-regenerate', () => {
  it('the overflow banner is hidden when nothing spilled', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ counts: { changed: 0, placed: 0, carved: 0, replaced: 0, writesOutOfBounds: 0 } }))
    const banner = root.querySelector('.fl-banner-overflow') as HTMLElement
    expect(banner.style.display).toBe('none')
  })

  it('the overflow banner appears and reports both the write count and the captured block count', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(
      makeResult({
        counts: { changed: 0, placed: 0, carved: 0, replaced: 0, writesOutOfBounds: 5 },
        overflowBlocks: [
          { x: 10, y: 0, z: 0, id: 1 },
          { x: 11, y: 0, z: 0, id: 1 },
        ],
      }),
    )
    const banner = root.querySelector('.fl-banner-overflow') as HTMLElement
    expect(banner.style.display).not.toBe('none')
    expect(banner.textContent).toContain('5')
    expect(banner.textContent).toContain('2')
  })

  it('the "Grow to fit & regenerate" button is disabled with an explanatory title when no onGrowRegenerate host hook is provided', () => {
    const root = document.createElement('div')
    createPanel(root, { viewer: makeViewerStub() })
    const growButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Grow to fit & regenerate') as HTMLButtonElement
    expect(growButton.disabled).toBe(true)
    expect(growButton.title.length).toBeGreaterThan(0)
  })

  it('the grow button is enabled once a host provides onGrowRegenerate, and fires it with the current GenerateParamsWire', () => {
    const root = document.createElement('div')
    const onGrowRegenerate = vi.fn()
    const panel = createPanel(root, { viewer: makeViewerStub(), onGrowRegenerate })
    // A feature must be selected for buildGenerateParams to produce a non-null params object --
    // seed one the same way other tests in this file do.
    panel.setResult(makeResult({ entries: [{ fileId: 'a.json', identifier: 'test:a', typeId: 'minecraft:single_block_feature' }] }))
    const featureSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Feature')!.querySelector('select') as HTMLSelectElement
    featureSelect.value = 'test:a'
    featureSelect.dispatchEvent(new Event('change'))

    const growButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Grow to fit & regenerate') as HTMLButtonElement
    expect(growButton.disabled).toBe(false)
    growButton.click()
    expect(onGrowRegenerate).toHaveBeenCalledTimes(1)
    expect(onGrowRegenerate.mock.calls[0]![0]).toMatchObject({ feature: 'test:a' })
  })

  it('the grown re-run banner is hidden for an ordinary (non-grown) result', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ grown: false, preGrowBounds: null }))
    const banner = root.querySelector('.fl-banner-grown') as HTMLElement
    expect(banner.style.display).toBe('none')
  })

  it('the grown re-run banner appears as one line about this run, with "a different run" as its tooltip rather than its text', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(
      makeResult({
        grown: true,
        preGrowBounds: { minX: -16, minY: 44, minZ: -16, sizeX: 32, sizeY: 48, sizeZ: 32 },
        volume: { minX: -32, minY: 44, minZ: -32, sizeX: 64, sizeY: 48, sizeZ: 64, data: new Uint32Array(0), baseline: new Uint32Array(0), changed: new Uint8Array(0), removed: new Uint8Array(0) },
      }),
    )
    const banner = root.querySelector('.fl-banner-grown') as HTMLElement
    expect(banner.style.display).not.toBe('none')
    expect(banner.textContent).toContain('32×48×32')
    expect(banner.textContent).toContain('64×48×64')
    // The standing fact about every grown run is the tooltip, not a sentence in the banner: the
    // banner's own text stays one short line about this run.
    expect(banner.textContent).not.toMatch(/different/i)
    expect(banner.title).toMatch(/different placement/i)
    expect(banner.textContent!.length).toBeLessThan(80)
  })

  it('a later ordinary result clears a previously-shown grown banner', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ grown: true, preGrowBounds: { minX: 0, minY: 0, minZ: 0, sizeX: 8, sizeY: 8, sizeZ: 8 } }))
    expect((root.querySelector('.fl-banner-grown') as HTMLElement).style.display).not.toBe('none')

    panel.setResult(makeResult({ grown: false, preGrowBounds: null }))
    expect((root.querySelector('.fl-banner-grown') as HTMLElement).style.display).toBe('none')
  })

  it('the View section’s "Show overflow" toggle defaults to on and drives VoxelViewer.setShowOverflow', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    createPanel(root, { viewer })
    expect(viewer.getShowOverflow()).toBe(true)

    const overflowCheckbox = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Show overflow')!.querySelector('input') as HTMLInputElement
    expect(overflowCheckbox.checked).toBe(true)
    overflowCheckbox.checked = false
    overflowCheckbox.dispatchEvent(new Event('change'))
    expect(viewer.setShowOverflow).toHaveBeenCalledWith(false)
  })

  // THE load-bearing assertions for the intent-vs-display split. Reproduces the reported bug: a user-chosen slice cut must survive a
  // temporary NARROWER result (e.g. a shorter preset) and come back once a WIDER one arrives
  // (e.g. "Grow to fit & regenerate") -- not stay ratcheted at whatever the narrow one clamped
  // it down to.
  it('a user-chosen slice cut survives a narrower result and is restored by a later wider one, not ratcheted', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })

    const minRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Min Y (cut)')!
    const maxRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Max Y (cut)')!
    const sliceMinInput = minRow.querySelector('input[type=range]') as HTMLInputElement
    const sliceMaxInput = maxRow.querySelector('input[type=range]') as HTMLInputElement

    // A tall first result (world Y 0..47) -- the user explicitly cuts it down to [20, 40].
    panel.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 48 } }))
    sliceMinInput.min = '0'
    sliceMinInput.max = '47'
    sliceMinInput.value = '20'
    sliceMinInput.dispatchEvent(new Event('input'))
    sliceMaxInput.min = '0'
    sliceMaxInput.max = '47'
    sliceMaxInput.value = '40'
    sliceMaxInput.dispatchEvent(new Event('input'))
    expect(viewer.setSlice).toHaveBeenLastCalledWith(20, 40)

    // A much SHORTER result arrives (world Y 0..9, e.g. a shorter preset) -- [20,40] doesn't
    // fit, so the display must clamp into what's actually available...
    panel.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 10 } }))
    expect(sliceMinInput.value).toBe('9')
    expect(sliceMaxInput.value).toBe('9')
    expect(viewer.setSlice).toHaveBeenLastCalledWith(9, 9)

    // ...but a TALLER result right after (world Y 0..47 again, e.g. "Grow to fit & regenerate")
    // must restore the user's ORIGINAL [20, 40] cut -- not stay pinned at [9, 9] (the ratchet
    // bug) or silently revert to "no cut" ([0, 47]).
    panel.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 48 } }))
    expect(sliceMinInput.value).toBe('20')
    expect(sliceMaxInput.value).toBe('40')
    expect(viewer.setSlice).toHaveBeenLastCalledWith(20, 40)
  })

  it('a slice the user has never touched always tracks the full range of whatever result just arrived', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })

    panel.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 48 } }))
    expect(viewer.setSlice).toHaveBeenLastCalledWith(0, 47)

    // Narrower, then wider again -- untouched, this should track EACH result's own full range,
    // never clamp-and-stick like a touched slice temporarily does.
    panel.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 10 } }))
    expect(viewer.setSlice).toHaveBeenLastCalledWith(0, 9)
    panel.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 48 } }))
    expect(viewer.setSlice).toHaveBeenLastCalledWith(0, 47)
  })

  it('a touched slice cut survives a fresh createPanel call (persisted as intent, not the clamped artefact)', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub() })
    panel1.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 48 } }))
    const minRow1 = [...root1.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Min Y (cut)')!
    const sliceMinInput1 = minRow1.querySelector('input[type=range]') as HTMLInputElement
    sliceMinInput1.min = '0'
    sliceMinInput1.max = '47'
    sliceMinInput1.value = '15'
    sliceMinInput1.dispatchEvent(new Event('input'))

    const root2 = document.createElement('div')
    const viewer2 = makeViewerStub()
    const panel2 = createPanel(root2, { viewer: viewer2 })
    panel2.setResult(makeResult({ volume: { ...makeResult().volume, minY: 0, sizeY: 48 } }))
    expect(viewer2.setSlice).toHaveBeenLastCalledWith(15, 47)
  })

  it('the Environment section’s "Min Y" (bench floor) and the View section’s "Min Y (cut)" (display slice) are distinctly labelled', () => {
    // Regression guard for the bug report this fed: two unrelated controls sharing the exact
    // same "Min Y" label, two sections apart.
    const root = document.createElement('div')
    createPanel(root, { viewer: makeViewerStub() })
    const labels = [...root.querySelectorAll('.fl-row-label')].map((l) => l.textContent)
    expect(labels).toContain('Min Y')
    expect(labels).toContain('Min Y (cut)')
  })
})

function growStickyCheckboxOf(root: HTMLElement): HTMLInputElement {
  return [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Grow every run')!.querySelector('input') as HTMLInputElement
}

// Sticky grow-to-fit: the one-shot "Grow to fit & regenerate" button only ever
// applied to a single request; any regenerate right after (a save included) silently reverted to
// the ungrown bench with nothing telling the user. The sticky toggle fixes that: while on, every
// regenerate this panel drives is redirected to onGrowRegenerate, and the RE-RUN banner stays
// visible for as long as the mode is on, not just for the one run that actually grew.
describe('createPanel: sticky grow-to-fit', () => {
  it('the sticky checkbox is disabled with an explanatory title when this host has no onGrowRegenerate, and never checked', () => {
    const root = document.createElement('div')
    createPanel(root, { viewer: makeViewerStub() })
    const checkbox = growStickyCheckboxOf(root)
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.checked).toBe(false)
  })

  it('while sticky is off, a config change fires onConfigChange; once turned on, the SAME kind of change fires onGrowRegenerate instead', () => {
    const root = document.createElement('div')
    const onConfigChange = vi.fn()
    const onGrowRegenerate = vi.fn()
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange, onGrowRegenerate })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const sizeX = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Size X')!.querySelector('input') as HTMLInputElement

    sizeX.value = '40'
    sizeX.dispatchEvent(new Event('change'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    expect(onGrowRegenerate).not.toHaveBeenCalled()

    const growCheckbox = growStickyCheckboxOf(root)
    growCheckbox.checked = true
    growCheckbox.dispatchEvent(new Event('change'))
    expect(onGrowRegenerate).toHaveBeenCalledTimes(1) // turning it on itself fires a request

    onConfigChange.mockClear()
    onGrowRegenerate.mockClear()
    sizeX.value = '50'
    sizeX.dispatchEvent(new Event('change'))
    expect(onGrowRegenerate).toHaveBeenCalledTimes(1)
    expect(onConfigChange).not.toHaveBeenCalled()
  })

  // THE load-bearing assertions for renderGrownBanner's sticky branch. Reproduces the reported bug directly: a run that needed no
  // growth must not hide the banner while sticky is still on, and the banner must be visible
  // from the moment the mode is switched on, not only after a grown result arrives.
  it('the RE-RUN banner stays visible for as long as sticky mode is on, even across a run that needed no growth', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onGrowRegenerate: vi.fn() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const banner = () => root.querySelector('.fl-banner-grown') as HTMLElement
    expect(banner().style.display).toBe('none') // off by default, nothing grown yet

    const growCheckbox = growStickyCheckboxOf(root)
    growCheckbox.checked = true
    growCheckbox.dispatchEvent(new Event('change'))
    expect(banner().style.display).not.toBe('none') // visible the instant it's turned on
    expect(banner().textContent).toContain('Grow every run: on')
    expect(banner().textContent).toContain('waiting for the next run')

    panel.setResult(makeResult({ grown: true, preGrowBounds: { minX: 0, minY: 0, minZ: 0, sizeX: 8, sizeY: 8, sizeZ: 8 } }))
    expect(banner().style.display).not.toBe('none')
    expect(banner().textContent).toContain('grown 8×8×8 → 4×4×4 this run')

    // The actual bug report: a later run that needed NO growth (grown: false) must not hide the
    // banner while sticky is still active -- and it says so in one line, not a paragraph.
    panel.setResult(makeResult({ grown: false, preGrowBounds: null }))
    expect(banner().style.display).not.toBe('none')
    expect(banner().textContent).toBe('Grow every run: on · no growth needed this run')

    // The obvious off switch: unchecking reverts to the old, single-result-only behaviour.
    growCheckbox.checked = false
    growCheckbox.dispatchEvent(new Event('change'))
    expect(banner().style.display).toBe('none')
  })

  it('a persisted sticky "on" does not resurrect on a fresh host instance that has no onGrowRegenerate', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onGrowRegenerate: vi.fn() })
    panel1.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const growCheckbox1 = growStickyCheckboxOf(root1)
    growCheckbox1.checked = true
    growCheckbox1.dispatchEvent(new Event('change'))

    // A DIFFERENT panel instance sharing the same localStorage -- e.g. a host build that cannot
    // wire onGrowRegenerate yet (see PanelOptions.onGrowRegenerate's own doc comment for why its
    // absence is meaningful, not just "not implemented yet").
    const root2 = document.createElement('div')
    const onConfigChange2 = vi.fn()
    const panel2 = createPanel(root2, { viewer: makeViewerStub(), onConfigChange: onConfigChange2 })
    const growCheckbox2 = growStickyCheckboxOf(root2)
    expect(growCheckbox2.checked).toBe(false)
    expect(growCheckbox2.disabled).toBe(true)

    panel2.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const sizeX2 = [...root2.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Size X')!.querySelector('input') as HTMLInputElement
    sizeX2.value = '33'
    sizeX2.dispatchEvent(new Event('change'))
    expect(onConfigChange2).toHaveBeenCalledTimes(1) // ordinary path, not a dead attempt to grow
  })

  it('a persisted sticky "on" DOES restore on a fresh host instance that can perform a grow', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onGrowRegenerate: vi.fn() })
    panel1.seedOpenedDocument('feature', 'wiki:poplar_tree')
    growStickyCheckboxOf(root1).checked = true
    growStickyCheckboxOf(root1).dispatchEvent(new Event('change'))

    const root2 = document.createElement('div')
    const onConfigChange2 = vi.fn()
    const onGrowRegenerate2 = vi.fn()
    const panel2 = createPanel(root2, { viewer: makeViewerStub(), onConfigChange: onConfigChange2, onGrowRegenerate: onGrowRegenerate2 })
    expect(growStickyCheckboxOf(root2).checked).toBe(true)

    panel2.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const sizeX2 = [...root2.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Size X')!.querySelector('input') as HTMLInputElement
    sizeX2.value = '33'
    sizeX2.dispatchEvent(new Event('change'))
    expect(onGrowRegenerate2).toHaveBeenCalledTimes(1)
    expect(onConfigChange2).not.toHaveBeenCalled()
  })

  it('each sticky-driven request carries the CURRENT config, not bounds frozen from an earlier grow -- refit happens fresh every time', () => {
    const root = document.createElement('div')
    const onGrowRegenerate = vi.fn()
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onGrowRegenerate })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const growCheckbox = growStickyCheckboxOf(root)
    growCheckbox.checked = true
    growCheckbox.dispatchEvent(new Event('change'))

    const sizeX = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Size X')!.querySelector('input') as HTMLInputElement
    sizeX.value = '60'
    sizeX.dispatchEvent(new Event('change'))
    const lastParams = onGrowRegenerate.mock.calls.at(-1)![0] as GenerateParamsWire
    expect(lastParams.size).toMatch(/^60x/)
  })
})

describe('createPanel: buildGenerateParams / onConfigChange', () => {
  it('never fires onConfigChange while neither a feature nor a rule is selected', () => {
    const root = document.createElement('div')
    const onConfigChange = vi.fn()
    createPanel(root, { viewer: makeViewerStub(), onConfigChange })
    const sizeX = root.querySelector('input[type=number]') as HTMLInputElement
    sizeX.value = '40'
    sizeX.dispatchEvent(new Event('change'))
    expect(onConfigChange).not.toHaveBeenCalled()
  })

  it('getGenerateParams() is null until seedOpenedDocument (or a selection) supplies a feature/rule', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    expect(panel.getGenerateParams()).toBeNull()
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    expect(panel.getGenerateParams()?.feature).toBe('wiki:poplar_tree')
  })

  it('always includes feature/env/size/minY/repeat/profile once a feature is selected', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const params = panel.getGenerateParams()!
    expect(params.feature).toBe('wiki:poplar_tree')
    expect(params.rule).toBeUndefined()
    expect(params.env).toBe('plains')
    expect(params.size).toBe('32x48x32')
    expect(params.minY).toBe(44)
    expect(params.repeat).toBe(1)
    expect(params.profile).toBe(false)
  })

  // THE load-bearing assertion for origin handling.
  it('never sends "origin" until Origin X or Origin Z has actually been edited', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    expect(panel.getGenerateParams()!.origin).toBeUndefined()

    const originXInput = [...root.querySelectorAll('.fl-row')]
      .find((r) => r.querySelector('.fl-row-label')?.textContent === 'Origin X')!
      .querySelector('input') as HTMLInputElement
    originXInput.value = '100'
    originXInput.dispatchEvent(new Event('change'))

    expect(panel.getGenerateParams()!.origin).toBe('100,0,0') // resolvedOriginY defaults to 0 pre-first-result
  })

  it('composes origin Y from the last resolved result.origin.y, not a fixed placeholder', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setResult(makeResult({ origin: { x: 0, y: 63, z: 0 } }))

    const originZInput = [...root.querySelectorAll('.fl-row')]
      .find((r) => r.querySelector('.fl-row-label')?.textContent === 'Origin Z')!
      .querySelector('input') as HTMLInputElement
    originZInput.value = '-20'
    originZInput.dispatchEvent(new Event('change'))

    expect(panel.getGenerateParams()!.origin).toBe('0,63,-20')
  })

  it('resets size/minY to the new preset defaults on Preset change, and includes them unconditionally', () => {
    const root = document.createElement('div')
    const onConfigChange = vi.fn()
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setEnvironments(makeEnvironments())

    const presetSelect = [...root.querySelectorAll('.fl-row')]
      .find((r) => r.querySelector('.fl-row-label')?.textContent === 'Preset')!
      .querySelector('select') as HTMLSelectElement
    presetSelect.value = 'desert'
    presetSelect.dispatchEvent(new Event('change'))

    const params = panel.getGenerateParams()!
    expect(params.env).toBe('desert')
    expect(params.size).toBe('32x48x32')
    expect(params.minY).toBe(44)
    expect(onConfigChange).toHaveBeenCalled()
  })

  it('the Preset <select> is populated from setEnvironments, not a hardcoded list', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    const presetSelect = [...root.querySelectorAll('.fl-row')]
      .find((r) => r.querySelector('.fl-row-label')?.textContent === 'Preset')!
      .querySelector('select') as HTMLSelectElement
    expect(presetSelect.options.length).toBe(0) // nothing yet -- no hardcoded fallback list

    panel.setEnvironments(makeEnvironments())
    expect([...presetSelect.options].map((o) => o.value)).toEqual(['plains', 'desert', 'ocean'])
  })

  function packBiomeSelectOf(root: HTMLElement): HTMLSelectElement {
    return [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Pack biome')!.querySelector('select') as HTMLSelectElement
  }
  function biomeTagsInputOf(root: HTMLElement): HTMLInputElement {
    return [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Biome tags')!.querySelector('input') as HTMLInputElement
  }

  it('"Pack biome" is a real <select> populated from lastResult.biomeEntries, gating on entry.biome !== null', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    const brokenEntry: BiomeEntryWire = { fileId: 'broken.json', identifier: 'wiki:broken_biome', biome: null }
    panel.setResult(makeResult({ biomeEntries: [makeCraterBiomeEntry(), brokenEntry] }))

    const select = packBiomeSelectOf(root)
    // Leading "(preset default)" option (value "") plus one per biome entry.
    expect([...select.options].map((o) => o.value)).toEqual(['', 'wiki:crater', 'wiki:broken_biome'])
    const brokenOpt = [...select.options].find((o) => o.value === 'wiki:broken_biome')!
    expect(brokenOpt.disabled).toBe(true) // biome: null -- file failed to parse, cannot be selected
    const craterOpt = [...select.options].find((o) => o.value === 'wiki:crater')!
    expect(craterOpt.disabled).toBe(false)
  })

  it('sends biomeId only once a Pack biome is selected, independent of biomeTags', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setResult(makeResult({ biomeEntries: [makeCraterBiomeEntry()] }))
    expect(panel.getGenerateParams()!.biomeId).toBeUndefined()
    expect(panel.getGenerateParams()!.biomeTags).toBeUndefined()

    const select = packBiomeSelectOf(root)
    select.value = 'wiki:crater'
    select.dispatchEvent(new Event('change'))

    expect(panel.getGenerateParams()!.biomeId).toBe('wiki:crater')
    expect(panel.getGenerateParams()!.biomeTags).toBeUndefined() // selecting a biome alone never arms the tags override

    const clearBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Clear (use preset defaults)')!
    clearBtn.dispatchEvent(new Event('click'))
    expect(panel.getGenerateParams()!.biomeId).toBeUndefined()
  })

  it('biomeTags is an independent override -- can be set without ever selecting a Pack biome', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')

    const tagsInput = biomeTagsInputOf(root)
    tagsInput.value = 'crater, monster'
    tagsInput.dispatchEvent(new Event('change'))

    const params = panel.getGenerateParams()!
    expect(params.biomeTags).toEqual(['crater', 'monster'])
    expect(params.biomeId).toBeUndefined() // tags override alone never selects a pack biome
  })

  it('selecting a Pack biome layers its own materials over the preset, and an explicit Materials override still wins', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setEnvironments(makeEnvironments()) // 'plains' preset materials: minecraft:grass_block/dirt/stone
    panel.setResult(makeResult({ biomeEntries: [makeCraterBiomeEntry()] }))

    const topMaterialInputOf = (r: HTMLElement) => [...r.querySelectorAll('.fl-row')].find((row) => row.querySelector('.fl-row-label')?.textContent === 'Top material')!.querySelector('input') as HTMLInputElement

    // No biome selected yet -- Materials section shows the PRESET's own native top material.
    expect(topMaterialInputOf(root).value).toBe('minecraft:grass_block')

    packBiomeSelectOf(root).value = 'wiki:crater'
    packBiomeSelectOf(root).dispatchEvent(new Event('change'))

    // Biome selected -- Materials section now shows the BIOME's own top material (source 2 over
    // source 1), and biomeId is sent, but materials itself is NOT (nothing explicitly overridden
    // in the Materials section -- the engine applies the biome's materials on its own).
    expect(topMaterialInputOf(root).value).toBe('minecraft:magma_block')
    expect(panel.getGenerateParams()!.biomeId).toBe('wiki:crater')
    expect(panel.getGenerateParams()!.materials).toBeUndefined()

    // An explicit per-slot override in the Materials section still wins over the selected biome.
    topMaterialInputOf(root).value = 'minecraft:diamond_block'
    topMaterialInputOf(root).dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()!.materials).toEqual({ topMaterial: 'minecraft:diamond_block' })
  })

  it('the Biome section explains the real materials behaviour, not the old "does not yet load" gap notice', () => {
    const root = document.createElement('div')
    createPanel(root, { viewer: makeViewerStub() })
    expect(root.textContent).not.toMatch(/does not yet load/i)
  })

  it('never sends "materials" until a material field is actually edited, and per-field only', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    expect(panel.getGenerateParams()!.materials).toBeUndefined()

    const topMaterialInput = [...root.querySelectorAll('.fl-row')]
      .find((r) => r.querySelector('.fl-row-label')?.textContent === 'Top material')!
      .querySelector('input') as HTMLInputElement
    topMaterialInput.value = 'minecraft:grass_block'
    topMaterialInput.dispatchEvent(new Event('change'))

    const params = panel.getGenerateParams()!
    expect(params.materials).toEqual({ topMaterial: 'minecraft:grass_block' }) // only the touched field
    expect(params.materials?.midMaterial).toBeUndefined()

    const resetBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Reset to preset materials')!
    resetBtn.dispatchEvent(new Event('click'))
    expect(panel.getGenerateParams()!.materials).toBeUndefined()
  })

  // ---- the three sea slots, gated on the selected preset's own buildsSea -----------------------
  //
  // env.EnvironmentPreset.BuildsSea is true for "ocean" alone: everywhere else sea_floor_material/
  // sea_material/sea_floor_depth change nothing, and env.InertSeaSlotOverrides warns about it
  // AFTER the run. These pin the panel saying it BEFORE the run instead -- and pin the round trip
  // ocean -> plains -> ocean being lossless, which is the part a naive "just clear it" fix breaks.
  function materialInputOf(root: HTMLElement, label: string): HTMLInputElement {
    return [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === label)!.querySelector('input') as HTMLInputElement
  }
  const SEA_LABELS = ['Sea floor material', 'Sea material', 'Sea floor depth']
  function selectPreset(root: HTMLElement, id: string): void {
    const presetSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Preset')!.querySelector('select') as HTMLSelectElement
    presetSelect.value = id
    presetSelect.dispatchEvent(new Event('change'))
  }

  it('disables the three sea material controls under a preset that builds no sea, and enables them under one that does', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setEnvironments(makeEnvironments()) // default preset is 'plains' -- buildsSea: false

    for (const label of SEA_LABELS) expect(materialInputOf(root, label).disabled).toBe(true)
    // The other three are never gated -- every preset has a top/mid/foundation identity.
    for (const label of ['Top material', 'Mid material', 'Foundation material']) {
      expect(materialInputOf(root, label).disabled).toBe(false)
    }

    selectPreset(root, 'ocean')
    for (const label of SEA_LABELS) expect(materialInputOf(root, label).disabled).toBe(false)

    selectPreset(root, 'desert')
    for (const label of SEA_LABELS) expect(materialInputOf(root, label).disabled).toBe(true)
  })

  it('shows WHY the sea controls are inert -- dimmed row, the reason as the input\'s own tooltip -- with no sentence written into the panel', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setEnvironments(makeEnvironments())

    // A disabled input with no reason is its own kind of silence; a paragraph under it is the
    // wall of text this panel no longer has. The control itself carries the reason: the row is
    // marked inert (panel.css dims it) and the disabled input's tooltip names this preset and
    // where the slots do work -- read off the live list, not hardcoded.
    for (const label of SEA_LABELS) {
      const input = materialInputOf(root, label)
      expect(input.closest('.fl-row')!.classList.contains('fl-row-inert')).toBe(true)
      expect(input.title).toContain('Plains')
      expect(input.title).toContain('Ocean floor')
      expect(input.title).toMatch(/kept/)
      expect(input.title.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 0)).toHaveLength(1) // one sentence
    }
    expect(root.textContent).not.toMatch(/builds no sea/)
    expect(root.querySelector('.fl-note:not([style*="display: none"])')).toBeNull()

    selectPreset(root, 'ocean')
    for (const label of SEA_LABELS) {
      const input = materialInputOf(root, label)
      expect(input.closest('.fl-row')!.classList.contains('fl-row-inert')).toBe(false)
      expect(input.hasAttribute('title')).toBe(false) // falls back to the row's own explanation
      expect(input.closest('.fl-row')!.getAttribute('title')).toMatch(/surface_builder/)
    }
  })

  it('holds the three sea slots back from the request under a preset with no sea, but keeps the typed value and sends it again on switching back', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setEnvironments(makeEnvironments())
    selectPreset(root, 'ocean')

    materialInputOf(root, 'Sea material').value = 'minecraft:lava'
    materialInputOf(root, 'Sea material').dispatchEvent(new Event('change'))
    materialInputOf(root, 'Sea floor depth').value = '4'
    materialInputOf(root, 'Sea floor depth').dispatchEvent(new Event('change'))
    materialInputOf(root, 'Top material').value = 'minecraft:diamond_block'
    materialInputOf(root, 'Top material').dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()!.materials).toEqual({ seaMaterial: 'minecraft:lava', seaFloorDepth: 4, topMaterial: 'minecraft:diamond_block' })

    // Switch to a preset with no sea: the two sea slots stop being sent (the engine would only
    // warn about them), the non-sea override is untouched...
    selectPreset(root, 'plains')
    expect(panel.getGenerateParams()!.materials).toEqual({ topMaterial: 'minecraft:diamond_block' })
    // ...and the value is KEPT, not cleared -- still shown in the (now disabled) input.
    expect(materialInputOf(root, 'Sea material').value).toBe('minecraft:lava')
    expect(materialInputOf(root, 'Sea floor depth').value).toBe('4')

    // Switching back costs the author no retyping: the same request comes back exactly.
    selectPreset(root, 'ocean')
    expect(panel.getGenerateParams()!.materials).toEqual({ seaMaterial: 'minecraft:lava', seaFloorDepth: 4, topMaterial: 'minecraft:diamond_block' })
  })

  it('drops "materials" entirely when the only overrides are sea slots and the preset has no sea', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setEnvironments(makeEnvironments())
    selectPreset(root, 'ocean')

    materialInputOf(root, 'Sea floor material').value = 'minecraft:magma_block'
    materialInputOf(root, 'Sea floor material').dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()!.materials).toEqual({ seaFloorMaterial: 'minecraft:magma_block' })

    // An empty object is not a request for "no materials" -- the field has to disappear, same as
    // the never-edited case above.
    selectPreset(root, 'plains')
    expect(panel.getGenerateParams()!.materials).toBeUndefined()
  })

  it('leaves the sea controls alone until the environments list has actually arrived', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')

    // No setEnvironments yet: nothing has told this panel whether 'plains' builds a sea. Greying
    // the controls out (or dropping a value) on that guess would be asserting a fact it does not
    // have -- see panel.ts's presetBuildsSea.
    for (const label of SEA_LABELS) expect(materialInputOf(root, label).disabled).toBe(false)
    materialInputOf(root, 'Sea material').value = 'minecraft:lava'
    materialInputOf(root, 'Sea material').dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()!.materials).toEqual({ seaMaterial: 'minecraft:lava' })

    // The list lands and the panel acts on the real answer, without a preset change to prompt it.
    panel.setEnvironments(makeEnvironments())
    for (const label of SEA_LABELS) expect(materialInputOf(root, label).disabled).toBe(true)
    expect(panel.getGenerateParams()!.materials).toBeUndefined()
    expect(materialInputOf(root, 'Sea material').value).toBe('minecraft:lava') // still kept
  })

  it('switches to rule mode and sends "rule" instead of "feature"', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')

    const ruleRadio = [...root.querySelectorAll('input[type=radio][name=fl-preview-mode]')].find((r) => (r as HTMLInputElement).value === 'rule') as HTMLInputElement
    ruleRadio.checked = true
    ruleRadio.dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()).toBeNull() // no rule chosen yet -- feature mode's selection doesn't carry over

    const ruleSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Rule')!.querySelector('select') as HTMLSelectElement
    const opt = document.createElement('option')
    opt.value = 'wiki:floating_isle.main'
    ruleSelect.append(opt)
    ruleSelect.value = 'wiki:floating_isle.main'
    ruleSelect.dispatchEvent(new Event('change'))

    const params = panel.getGenerateParams()!
    expect(params.rule).toBe('wiki:floating_isle.main')
    expect(params.feature).toBeUndefined()
  })
})

describe('createPanel: Feature/Rule pickers populated from a real result', () => {
  const entries: FeatureEntryWire[] = [
    { fileId: 'poplar_tree.json', identifier: 'wiki:poplar_tree', typeId: 'minecraft:tree_feature' },
    { fileId: 'mossy_boulder_replace.json', identifier: 'wiki:mossy_boulder_replace', typeId: 'minecraft:single_block_feature' },
  ]
  const ruleEntries: RuleEntryWire[] = [
    { fileId: 'floating_isle.main.json', identifier: 'wiki:floating_isle.main', rule: { identifier: 'wiki:floating_isle.main', placesFeature: 'wiki:floating_isle.chain', placementPass: null, biomeFilter: null } },
    { fileId: 'broken.json', identifier: 'wiki:broken_rule', rule: null },
  ]

  it('populates both selects from setResult, disabling a rule entry whose rule failed to build', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ entries, ruleEntries }))

    const featureSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Feature')!.querySelector('select') as HTMLSelectElement
    expect([...featureSelect.options].map((o) => o.value)).toEqual(entries.map((e) => e.identifier))

    const ruleSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Rule')!.querySelector('select') as HTMLSelectElement
    const brokenOpt = [...ruleSelect.options].find((o) => o.value === 'wiki:broken_rule')!
    expect(brokenOpt.disabled).toBe(true)
    const okOpt = [...ruleSelect.options].find((o) => o.value === 'wiki:floating_isle.main')!
    expect(okOpt.disabled).toBe(false)
  })

  it('the Filter control narrows the visible Feature options by substring', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ entries }))

    const filterInput = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Filter')!.querySelector('input') as HTMLInputElement
    filterInput.value = 'boulder'
    filterInput.dispatchEvent(new Event('input'))

    const featureSelect = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Feature')!.querySelector('select') as HTMLSelectElement
    expect([...featureSelect.options].map((o) => o.value)).toEqual(['wiki:mossy_boulder_replace'])
  })
})

describe('createPanel: diagnostics readability', () => {
  it('separates error and warning counts in the section header and applies distinct severity classes', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    const diagnostics: DecodedDiagnostic[] = [
      makeDiagnostic({ level: 'error', fileId: 'a.json', message: 'boom' }),
      makeDiagnostic({ level: 'warning', fileId: 'b.json', message: 'careful' }),
      makeDiagnostic({ level: 'warning', fileId: 'c.json', message: 'also careful' }),
    ]
    panel.setResult(makeResult({ diagnostics }))

    const diagSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'diagnostics')!
    expect(diagSection.querySelector('.fl-section-title-text')?.textContent).toBe('Diagnostics  (1 error, 2 warnings)')
    expect(diagSection.querySelectorAll('.fl-diag-error').length).toBe(1)
    expect(diagSection.querySelectorAll('.fl-diag-warning').length).toBe(2)
  })

  it('shows the failing feature’s own identifier/type prominently, not the run feature’s', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    const diagnostics: DecodedDiagnostic[] = [
      makeDiagnostic({
        level: 'warning',
        fileId: 'floating_isle_waterfall.json',
        identifier: 'wiki:floating_isle.waterfall',
        typeId: 'minecraft:single_block_feature',
        chain: ['wiki:floating_isle.main', 'wiki:floating_isle.patch', 'wiki:floating_isle.waterfall'],
        message: 'Target does not contain a block from the replace list',
      }),
    ]
    panel.setResult(makeResult({ diagnostics }))

    const diagSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'diagnostics')!
    expect(diagSection.querySelector('.fl-diag-heading')?.textContent).toContain('wiki:floating_isle.waterfall')
    expect(diagSection.querySelector('.fl-diag-heading')?.textContent).toContain('minecraft:single_block_feature')
    expect(diagSection.querySelector('.fl-diag-heading')?.textContent).not.toContain('wiki:floating_isle.main')
    const chainText = diagSection.querySelector('.fl-diag-chain')?.textContent ?? ''
    expect(chainText).toContain('wiki:floating_isle.main')
    expect(chainText).toContain('wiki:floating_isle.patch')
    expect(chainText).toContain('wiki:floating_isle.waterfall')
  })

  // Regression: "feature X / X / not defined by the loaded pack..." -- an engine-level diagnostic
  // with no real file of its own (session/unresolved.go's "not defined by the loaded pack" is
  // the concrete case) sets FileID to the identifier itself, so the heading showed the same
  // string twice back to back with nothing between them before reaching anything informative.
  // THE load-bearing assertion for the fileId suppression.
  it('suppresses the redundant fileId when it is textually identical to the identifier', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    // Mirrors session/unresolved.go's own wire shape exactly: FileID is literally the
    // identifier (there is no real file to point at), and no separate Identifier field is set
    // on the wire -- normalizeDiagnostic falls back to fileId, so identifier === fileId here
    // just like the real "not defined by the loaded pack" diagnostic.
    panel.setResult(
      makeResult({
        diagnostics: [
          makeDiagnostic({
            level: 'error',
            fileId: 'wiki:crater_shrub.fr',
            message:
              'feature "wiki:crater_shrub.fr" is not defined by the loaded pack (3526 feature(s) loaded, 3526 built successfully) -- did you mean "wiki:crater_shrub.f"?',
          }),
        ],
      }),
    )
    const diagSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'diagnostics')!
    const heading = diagSection.querySelector('.fl-diag-heading')!
    expect(heading.querySelector('.fl-diag-file')).toBeNull() // suppressed -- would just repeat the heading's own identifier
    // The identifier itself must still appear -- exactly once, not zero: suppressing fileId
    // must never also drop the identifier.
    const occurrences = (heading.textContent ?? '').split('wiki:crater_shrub.fr').length - 1
    expect(occurrences).toBe(1)
  })

  it('still shows BOTH identifier and fileId when they genuinely differ -- suppression is only for the identical case', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(
      makeResult({
        diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'floating_isle_waterfall.json', identifier: 'wiki:floating_isle.waterfall', message: 'oops' })],
      }),
    )
    const diagSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'diagnostics')!
    const heading = diagSection.querySelector('.fl-diag-heading')!
    expect(heading.querySelector('.fl-diag-file')).not.toBeNull()
    expect(heading.textContent).toContain('wiki:floating_isle.waterfall')
    expect(heading.textContent).toContain('floating_isle_waterfall.json')
  })

  it('collapses a repeated diagnostic into one line with a count instead of a wall of duplicates', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'a.json', count: 428, message: 'oops' })] }))
    const diagSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'diagnostics')!
    expect(diagSection.querySelectorAll('.fl-diag-item').length).toBe(1)
    expect(diagSection.querySelector('.fl-diag-count')?.textContent).toBe('×428')

    // count: 1 (the common case) shows no badge at all -- not a redundant "×1" on every line.
    const root2 = document.createElement('div')
    const panel2 = createPanel(root2, { viewer: makeViewerStub() })
    panel2.setResult(makeResult({ diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'a.json', count: 1, message: 'oops' })] }))
    expect(root2.querySelector('.fl-diag-count')).toBeNull()
  })

  // THE load-bearing assertion for the click-to-locate handler.
  it('clicking a diagnostic’s position moves the camera to that cell and highlights it', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })
    panel.setResult(makeResult({ diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'a.json', position: { x: 3, y: 70, z: -2 }, message: 'oops' })] }))

    const posBtn = root.querySelector('.fl-diag-position') as HTMLButtonElement
    expect(posBtn).not.toBeNull()
    posBtn.dispatchEvent(new Event('click'))
    expect(viewer.highlightCell).toHaveBeenCalledWith(3, 70, -2)
  })

  it('a null position renders no clickable position control -- {0,0,0} is a real coordinate and does render one', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })
    panel.setResult(makeResult({ diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'a.json', position: null, message: 'no position here' })] }))
    expect(root.querySelector('.fl-diag-position')).toBeNull()

    const root2 = document.createElement('div')
    const viewer2 = makeViewerStub()
    const panel2 = createPanel(root2, { viewer: viewer2 })
    panel2.setResult(makeResult({ diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'a.json', position: { x: 0, y: 0, z: 0 }, message: 'origin is real' })] }))
    const posBtn = root2.querySelector('.fl-diag-position') as HTMLButtonElement
    expect(posBtn).not.toBeNull()
    posBtn.dispatchEvent(new Event('click'))
    expect(viewer2.highlightCell).toHaveBeenCalledWith(0, 0, 0)
  })

  it('a chain segment matching a loaded feature is clickable and selects it in the Feature picker; an unmatched one (e.g. a rule) is not', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    const entries = [{ fileId: 'waterfall.json', identifier: 'wiki:floating_isle.waterfall', typeId: 'minecraft:single_block_feature' }]
    panel.setResult(
      makeResult({
        entries,
        diagnostics: [
          makeDiagnostic({
            level: 'warning',
            fileId: 'floating_isle_waterfall.json',
            identifier: 'wiki:floating_isle.waterfall',
            chain: ['wiki:floating_isle.main', 'wiki:floating_isle.waterfall'],
            message: 'oops',
          }),
        ],
      }),
    )

    // Two clickable buttons for the same selectable leaf identifier: one in the prominent
    // heading, one as the chain breadcrumb's own last segment -- both are the SAME identifier,
    // deliberately (see renderDiagnostics). The rule identifier earlier in the chain is not in
    // `entries`, so it renders as plain, non-clickable text.
    const buttons = [...root.querySelectorAll('.fl-diag-chain-link')] as HTMLButtonElement[]
    expect(buttons.map((b) => b.textContent)).toEqual(['wiki:floating_isle.waterfall', 'wiki:floating_isle.waterfall'])
    const plainSegments = [...root.querySelectorAll('.fl-diag-chain .fl-diag-chain-seg:not(.fl-diag-chain-link)')].map((s) => s.textContent)
    expect(plainSegments).toContain('wiki:floating_isle.main') // the rule identifier -- not in entries, not clickable

    buttons[0]!.dispatchEvent(new Event('click'))
    expect(panel.getGenerateParams()?.feature).toBe('wiki:floating_isle.waterfall')
  })
})

describe('createPanel: Budget section', () => {
  it('sends no budget fields until the user enters one, and shows the engine default as each field’s placeholder', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const params = panel.getGenerateParams()!
    expect(params.writeBudget).toBeUndefined()
    expect(params.delegationBudget).toBeUndefined()
    expect(params.placementTimeLimitMs).toBeUndefined()

    const budgetSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'budget')!
    const placeholders = [...budgetSection.querySelectorAll('input')].map((i) => i.placeholder)
    expect(placeholders).toEqual(['4,000,000', '2,000,000', '8,000'])
  })

  it('entering a budget value sends it and shows the override badge; clearing it back to blank removes both', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')

    const placementRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Time limit (ms)')!
    const input = placementRow.querySelector('input') as HTMLInputElement
    const badge = placementRow.querySelector('.fl-budget-badge') as HTMLElement
    expect(badge.classList.contains('fl-hidden')).toBe(true)

    input.value = '60000'
    input.dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()!.placementTimeLimitMs).toBe(60000)
    expect(badge.classList.contains('fl-hidden')).toBe(false)

    input.value = ''
    input.dispatchEvent(new Event('change'))
    expect(panel.getGenerateParams()!.placementTimeLimitMs).toBeUndefined()
    expect(badge.classList.contains('fl-hidden')).toBe(true)
  })

  // The inverse of what this test used to assert, and deliberately so: a raised budget outliving
  // the panel it was raised in is the failure, not the feature. Everything about this control
  // says "for one heavy run, while you watch" -- the section's own intro text, the "override"
  // badge, GenerationConfig's doc comment -- and none of that survives contact with a limit that
  // is quietly still raised next week, when the run it was raised for is long forgotten and an
  // accidental infinite recursion grinds for a minute instead of failing fast. It still lives in
  // the Budget section's own describe (not the persistence block below) because it is a fact
  // about THIS control: the input, the badge and the wire field must all come back clean.
  it('a raised budget is gone in a fresh createPanel call -- a per-run override is not a saved setting', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub() })
    panel1.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const writeBudgetRowOf = (r: HTMLElement) => [...r.querySelectorAll('.fl-row')].find((row) => row.querySelector('.fl-row-label')?.textContent === 'Write budget')!
    const input = writeBudgetRowOf(root1).querySelector('input') as HTMLInputElement
    input.value = '10000000'
    input.dispatchEvent(new Event('change'))
    expect(panel1.getGenerateParams()!.writeBudget).toBe(10000000) // sanity: it really was raised

    const root2 = document.createElement('div')
    const panel2 = createPanel(root2, { viewer: makeViewerStub() })
    panel2.seedOpenedDocument('feature', 'wiki:poplar_tree')
    expect(panel2.getGenerateParams()!.writeBudget).toBeUndefined() // no opinion sent -- engine default
    const input2 = writeBudgetRowOf(root2).querySelector('input') as HTMLInputElement
    expect(input2.value).toBe('') // blank, so the placeholder shows the engine default again
    expect((writeBudgetRowOf(root2).querySelector('.fl-budget-badge') as HTMLElement).classList.contains('fl-hidden')).toBe(true)
  })
})

describe('createPanel: setTimeoutInfo', () => {
  it('is hidden by default, and by a host that never calls it', () => {
    const root = document.createElement('div')
    createPanel(root, { viewer: makeViewerStub() })
    const note = [...root.querySelectorAll('.fl-note')].find((n) => (n.textContent ?? '').includes('Extension wait'))
    expect(note).toBeUndefined()
  })

  it('shows the raised-wait note only when effectiveMs actually exceeds configuredMs, and hides again on null', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })

    panel.setTimeoutInfo({ configuredMs: 30000, effectiveMs: 30000 })
    expect([...root.querySelectorAll('.fl-note')].some((n) => (n.textContent ?? '').includes('Extension wait'))).toBe(false)

    panel.setTimeoutInfo({ configuredMs: 5000, effectiveMs: 18000 })
    const note = [...root.querySelectorAll('.fl-note')].find((n) => (n.textContent ?? '').includes('Extension wait'))!
    expect(note.textContent).toContain('18,000')
    expect(note.textContent).toContain('5,000')
    expect((note as HTMLElement).style.display).not.toBe('none')

    panel.setTimeoutInfo(null)
    expect((note as HTMLElement).style.display).toBe('none')
  })
})

// The node inspector's contract (apps/vscode/src/graph/inspector.ts, pinned by
// test/graphInspector.test.ts there), applied to this panel: a row is one line, its one-sentence
// explanation is a native tooltip, the long form is behind one `?` per section head, and what
// the panel says in its own body is only what is about this run. Geometry-level assertions
// (hover moves nothing, the documentation covers no control) live in apps/vscode's real-Chromium
// suite; these are the structural half jsdom can hold.
describe('createPanel: no prose in the panel -- tooltips and one `?` per section instead', () => {
  /** Every text run in the panel that is not a status about this run: a label, a button's word,
   * a number, never a sentence. Forty characters is well past the longest label. */
  function longTextRuns(root: HTMLElement): string[] {
    const out: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = (node as Text).parentElement
      if (parent === null) continue
      // The allowed exceptions are all about THIS run or THIS selection: diagnostics, the banners
      // (stale/error/busy/overflow/grown), the feature/rule info line, a status line, the
      // profiler's summary, the partial badge, and <option> text.
      if (parent.closest('.fl-diag-item, .fl-banner, .fl-info, .fl-note, .fl-profiler-summary, .fl-badge-partial, option') !== null) continue
      const text = (node.textContent ?? '').trim()
      if (text.length > 40) out.push(text)
    }
    return out
  }

  it('contains no explanatory paragraph: labels, controls, and what is about this run, nothing else', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onReloadFiles: vi.fn(), onGrowRegenerate: vi.fn() })
    panel.setEnvironments(makeEnvironments())
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setResult(makeResult({ entries: [{ fileId: 'a.json', identifier: 'wiki:poplar_tree', typeId: 'minecraft:tree_feature' }], biomeEntries: [makeCraterBiomeEntry()] }))
    panel.setTimeoutInfo({ configuredMs: 5000, effectiveMs: 18000 })
    growStickyCheckboxOf(root).checked = true
    growStickyCheckboxOf(root).dispatchEvent(new Event('change'))

    // None of the old prose surfaces exists, by element or by sentence.
    expect(root.querySelectorAll('.fl-section-body p').length).toBe(0)
    expect(root.querySelectorAll('.fl-env-description').length).toBe(0)
    expect(root.textContent).not.toMatch(/GROW-TO-FIT IS ON/)
    expect(root.textContent).not.toMatch(/do nothing under/)
    expect(root.textContent).not.toMatch(/not permanent settings/)
    expect(longTextRuns(root)).toEqual([])
    // Every section body is rows, buttons, and status lines -- a child that is none of those is
    // a paragraph by another name. (The Diagnostics and Profiler bodies hold their own lists.)
    for (const body of root.querySelectorAll('.fl-section-body')) {
      for (const child of body.children) {
        expect(child.matches('.fl-row, button, .fl-info, .fl-note, .fl-diag-item, .fl-diag-empty, .fl-profiler-summary, .fl-profiler-table'), child.className).toBe(true)
      }
    }
  })

  it('carries every row\'s one-sentence explanation as a native tooltip on the row, inherited by its control', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onGrowRegenerate: vi.fn() })
    panel.setEnvironments(makeEnvironments())
    const rows = [...root.querySelectorAll<HTMLElement>('.fl-row')].filter((r) => !r.classList.contains('fl-hidden'))
    expect(rows.length).toBeGreaterThan(20)
    for (const r of rows) {
      const title = r.getAttribute('title') ?? ''
      const label = r.querySelector('.fl-row-label')?.textContent ?? '(no label)'
      expect(title.length, label).toBeGreaterThan(10)
      expect(title.split('\n').length, label).toBe(1)
      // The label carries no tooltip of its own and neither does a live control: hovering
      // either shows the row's sentence, and nothing about the row changes.
      expect(r.querySelector('.fl-row-label')!.hasAttribute('title'), label).toBe(false)
    }
    // The Preset row's tooltip IS the selected preset's own description, read off the live list.
    const presetRow = rows.find((r) => r.querySelector('.fl-row-label')?.textContent === 'Preset')!
    expect(presetRow.title).toBe('Plains: Gently rolling grass over dirt and stone.')
    const presetSelect = presetRow.querySelector('select') as HTMLSelectElement
    presetSelect.value = 'ocean'
    presetSelect.dispatchEvent(new Event('change'))
    expect(presetRow.title).toContain('Ocean floor: Sand and gravel seabed')
  })

  it('has exactly one `?` per section head and none per row; it opens the section\'s documentation beside the sidebar', () => {
    const root = document.createElement('div')
    document.body.append(root)
    try {
      const onConfigChange = vi.fn()
      const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange })
      panel.setEnvironments(makeEnvironments())
      panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
      const sections = root.querySelectorAll('.fl-section')
      expect(root.querySelectorAll('.fl-help').length).toBe(sections.length)
      expect(root.querySelectorAll('.fl-section-head .fl-help').length).toBe(sections.length)
      expect(root.querySelectorAll('.fl-row .fl-help').length).toBe(0)
      expect(document.querySelector('.fl-docs')).toBeNull()

      const materialsHelp = root.querySelector<HTMLButtonElement>('.fl-section[data-section-id="materials"] .fl-help')!
      materialsHelp.click()
      const docs = document.querySelector<HTMLElement>('body > .fl-docs')!
      expect(docs).not.toBeNull()
      expect(materialsHelp.getAttribute('aria-expanded')).toBe('true')
      // The inspector's shape: close, back, a large title, one entry per control.
      expect(docs.querySelector('.fl-docs-bar > button')!.getAttribute('aria-label')).toMatch(/Close/)
      expect(docs.querySelector('.fl-docs-back')!.textContent).toMatch(/Back to overview/)
      expect(docs.querySelector('.fl-docs-title')!.textContent).toBe('Materials')
      const entries = [...docs.querySelectorAll('.fl-doc')].map((e) => (e as HTMLElement).dataset.key)
      expect(entries).toEqual(['Top material', 'Mid material', 'Foundation material', 'Sea floor material', 'Sea material', 'Sea floor depth', 'Reset to preset materials'])
      expect(docs.querySelector('.fl-doc[data-key="Sea material"] .fl-doc-glyph')!.textContent).toBe('Aa')
      expect(docs.querySelector('.fl-doc[data-key="Sea material"] .fl-doc-badge')!.textContent).toBe('sea presets only')
      // This is where the sea-slot rule went, naming the live presets and the selected one.
      const text = docs.textContent ?? ''
      expect(text).toContain('do nothing under a preset that builds no sea')
      expect(text).toContain('only Ocean floor does')
      expect(text).toContain('Selected now: Plains (builds no sea)')
      expect(text).toContain('kept and sent again')

      // Back to the overview: every section, the readout included, then another section.
      docs.querySelector<HTMLButtonElement>('.fl-docs-back')!.click()
      const overview = document.querySelector<HTMLElement>('body > .fl-docs')!
      expect([...overview.querySelectorAll('.fl-docs-item-name')].map((e) => e.textContent)).toEqual([
        'Result',
        'Feature / Rule',
        'Environment',
        'Materials',
        'Biome',
        'Budget',
        'View',
        'Diagnostics',
        'Profiler',
      ])
      expect(materialsHelp.getAttribute('aria-expanded')).toBe('false')
      ;[...overview.querySelectorAll<HTMLButtonElement>('.fl-docs-item')].find((b) => b.textContent!.includes('Budget'))!.click()
      const budgetDocs = document.querySelector<HTMLElement>('body > .fl-docs')!
      expect(budgetDocs.querySelector('.fl-docs-title')!.textContent).toBe('Budget')
      expect(budgetDocs.textContent).toContain('not permanent settings') // the deleted intro paragraph
      expect(root.querySelector('.fl-section[data-section-id="budget"] .fl-help')!.getAttribute('aria-expanded')).toBe('true')

      // Clicking the same `?` again closes; Escape closes too; reading is never a request.
      root.querySelector<HTMLButtonElement>('.fl-section[data-section-id="budget"] .fl-help')!.click()
      expect(document.querySelector('.fl-docs')).toBeNull()
      materialsHelp.click()
      document.querySelector<HTMLElement>('.fl-docs')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(document.querySelector('.fl-docs')).toBeNull()
      expect(document.activeElement).toBe(materialsHelp)
      expect(onConfigChange).not.toHaveBeenCalled()
    } finally {
      document.querySelector('.fl-docs')?.remove()
      root.remove()
    }
  })

  it('the Result documentation holds the grow-every-run rule the banner used to spell out, and marks a host that cannot grow', () => {
    const root = document.createElement('div')
    document.body.append(root)
    try {
      createPanel(root, { viewer: makeViewerStub() }) // no onGrowRegenerate
      root.querySelector<HTMLButtonElement>('.fl-section[data-section-id="view"] .fl-help')!.click()
      document.querySelector<HTMLButtonElement>('.fl-docs-back')!.click()
      ;[...document.querySelectorAll<HTMLButtonElement>('.fl-docs-item')].find((b) => b.textContent!.includes('Result'))!.click()
      const docs = document.querySelector<HTMLElement>('.fl-docs')!
      const entry = docs.querySelector('.fl-doc[data-key="Grow every run"]')!
      expect(entry.textContent).toContain('not the same result seen wider')
      expect(entry.querySelector('.fl-doc-badge[data-badge="host"]')!.textContent).toBe('not in this host')
    } finally {
      document.querySelector('.fl-docs')?.remove()
      root.remove()
    }
  })
})

describe('createPanel: view state persists section-open/closed across regenerations', () => {
  it('a collapsed section stays collapsed across a setResult call', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    const profilerSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'profiler')! as HTMLElement
    profilerSection.querySelector('.fl-section-header')!.dispatchEvent(new Event('click'))
    expect(profilerSection.classList.contains('fl-collapsed')).toBe(true)

    panel.setResult(makeResult())
    expect(profilerSection.classList.contains('fl-collapsed')).toBe(true)
  })

  it('persists collapsed sections and the selected subject across a fresh createPanel call (new webview instance)', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub() })
    panel1.seedOpenedDocument('feature', 'wiki:poplar_tree')
    const envSection = [...root1.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'environment')! as HTMLElement
    envSection.querySelector('.fl-section-header')!.dispatchEvent(new Event('click'))

    const root2 = document.createElement('div')
    const panel2 = createPanel(root2, { viewer: makeViewerStub() })
    const envSection2 = [...root2.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'environment')! as HTMLElement
    expect(envSection2.classList.contains('fl-collapsed')).toBe(true)
    expect(panel2.getGenerateParams()?.feature).toBe('wiki:poplar_tree')
  })
})

// The reported bug behind this block: settings bleeding between runs -- a biome remembered from
// a pack that no longer had it, a preset shown but not applied, material overrides outliving the
// biome reset that should have cleared them, a budget raised for one heavy run still raised days
// later. The split panel.ts settled on is by what a value DEPENDS on: how you look at a result
// (the Y cut, the lenses, the grid, which sections you keep collapsed) depends on neither pack
// nor feature, so it follows you; what a run is MADE of depends on both, so it starts clean. The
// subject is the one deliberate exception -- see panel.ts's PersistedState for why forgetting it
// would cost the desktop app a feature re-pick on every launch and cost VS Code nothing.
describe('createPanel: persistence policy -- view state follows you, generation config starts clean', () => {
  it('a raised budget, an edited size, a selected pack biome and a material override are all gone in a fresh panel', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub(), onConfigChange: vi.fn() })
    panel1.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel1.setResult(makeResult({ entries: [{ fileId: 'poplar.json', identifier: 'wiki:poplar_tree', typeId: 'minecraft:tree_feature' }], biomeEntries: [makeCraterBiomeEntry()] }))

    const rowInput = (root: HTMLElement, label: string) => [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === label)!.querySelector('input') as HTMLInputElement
    const sizeX = rowInput(root1, 'Size X')
    sizeX.value = '96'
    sizeX.dispatchEvent(new Event('change'))
    const packBiome = [...root1.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Pack biome')!.querySelector('select') as HTMLSelectElement
    packBiome.value = 'wiki:crater'
    packBiome.dispatchEvent(new Event('change'))
    const topMaterial = rowInput(root1, 'Top material')
    topMaterial.value = 'minecraft:bedrock'
    topMaterial.dispatchEvent(new Event('change'))
    const budget = rowInput(root1, 'Write budget')
    budget.value = '10000000'
    budget.dispatchEvent(new Event('change'))

    // Sanity: all four really are in the request this panel would send, so the assertions on the
    // fresh panel below are about them being FORGOTTEN, not about them never having been set.
    const before = panel1.getGenerateParams()!
    expect(before.size).toBe('96x48x32')
    expect(before.biomeId).toBe('wiki:crater')
    expect(before.materials).toMatchObject({ topMaterial: 'minecraft:bedrock' })
    expect(before.writeBudget).toBe(10000000)

    const root2 = document.createElement('div')
    const panel2 = createPanel(root2, { viewer: makeViewerStub(), onConfigChange: vi.fn() })
    const after = panel2.getGenerateParams()!
    expect(after.size).toBe('32x48x32') // defaultConfig()'s own bootstrap size, not the edited one
    expect(after.biomeId).toBeUndefined()
    expect(after.materials).toBeUndefined()
    expect(after.writeBudget).toBeUndefined()
    // ...and the controls themselves show the clean state, not just the wire: a blank budget with
    // its "override" badge hidden, and Top material back to prefill text it never sends.
    expect(rowInput(root2, 'Write budget').value).toBe('')
    expect(rowInput(root2, 'Size X').value).toBe('32')
  })

  it('the view toggles, the collapsed-section set and the selected subject all survive a fresh panel', () => {
    const root1 = document.createElement('div')
    const panel1 = createPanel(root1, { viewer: makeViewerStub(), onConfigChange: vi.fn(), onGrowRegenerate: vi.fn() })
    panel1.seedOpenedDocument('rule', 'wiki:crater_shrub')
    const checkbox = (root: HTMLElement, label: string) => [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === label)!.querySelector('input') as HTMLInputElement
    for (const [label, value] of [
      ['Show heatmap', true],
      ['Show carved', false],
      ['Show grid', false],
    ] as const) {
      const el = checkbox(root1, label)
      el.checked = value
      el.dispatchEvent(new Event('change'))
    }
    growStickyCheckboxOf(root1).checked = true
    growStickyCheckboxOf(root1).dispatchEvent(new Event('change'))
    const materialsSection = [...root1.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'materials')! as HTMLElement
    materialsSection.querySelector('.fl-section-header')!.dispatchEvent(new Event('click'))

    const root2 = document.createElement('div')
    const viewer2 = makeViewerStub()
    const panel2 = createPanel(root2, { viewer: viewer2, onConfigChange: vi.fn(), onGrowRegenerate: vi.fn() })

    expect(checkbox(root2, 'Show heatmap').checked).toBe(true)
    expect(checkbox(root2, 'Show carved').checked).toBe(false)
    expect(checkbox(root2, 'Show grid').checked).toBe(false)
    expect(growStickyCheckboxOf(root2).checked).toBe(true)
    // Restored into the VIEWER too, not just the checkboxes -- a toggle that reads as on while
    // the preview is drawn as if it were off would be worse than not persisting it at all.
    expect(viewer2.setShowHeatmap).toHaveBeenCalledWith(true)
    expect(viewer2.setShowCarved).toHaveBeenCalledWith(false)
    expect(viewer2.setShowGrid).toHaveBeenCalledWith(false)
    const materialsSection2 = [...root2.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'materials')! as HTMLElement
    expect(materialsSection2.classList.contains('fl-collapsed')).toBe(true)
    // The subject: the one generation-config field that deliberately still persists, mode and all.
    const params = panel2.getGenerateParams()!
    expect(params.rule).toBe('wiki:crater_shrub')
    expect(params.feature).toBeUndefined()
    expect((root2.querySelector('input[type=radio][name=fl-preview-mode][value=rule]') as HTMLInputElement).checked).toBe(true)
  })

  it('a blob written by an older build still loads: its view half is honoured and its config half ignored', () => {
    // Requirement on the storage key itself: it is NOT versioned per policy change, so the very
    // first panel after this change reads a blob whose `config` is the OLD fat shape. Nothing may
    // throw, the view half must still work, and the config half must be read past in silence --
    // the point of the change is that it stops being applied, not that it becomes an error.
    localStorage.setItem(
      'featurelab.panel.v1',
      JSON.stringify({
        config: {
          mode: 'feature',
          featureIdentifier: 'wiki:poplar_tree',
          ruleIdentifier: null,
          env: 'desert',
          sizeX: 128,
          sizeY: 200,
          sizeZ: 128,
          minY: 4,
          originX: 7,
          originZ: 9,
          originTouched: true,
          seed: 1234,
          repeatCount: 5,
          profiling: true,
          biomeId: 'pack_gone:crater',
          biomeTagsOverrideEnabled: true,
          biomeTagsText: 'crater, monster',
          materialOverride: { topMaterial: 'minecraft:bedrock' },
          writeBudget: 10000000,
          delegationBudget: 999,
          placementTimeLimitMs: 600000,
        },
        view: { sliceMinY: null, sliceMaxY: null, sliceTouched: false, growSticky: false, environmentMode: 'ghost', showGrid: false, showCarved: true, showHeatmap: true, showOverflow: true },
        collapsed: ['profiler'],
      }),
    )

    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn() })

    // The view half: honoured exactly as before this change.
    expect(root.querySelector('input[type=radio][name=fl-env-mode][value=ghost]')).toBeDefined()
    expect((root.querySelector('input[type=radio][name=fl-env-mode][value=ghost]') as HTMLInputElement).checked).toBe(true)
    const profilerSection = [...root.querySelectorAll('.fl-section')].find((s) => (s as HTMLElement).dataset.sectionId === 'profiler')! as HTMLElement
    expect(profilerSection.classList.contains('fl-collapsed')).toBe(true)
    // The subject half: still restored, which is what keeps the desktop app from re-picking.
    const params = panel.getGenerateParams()!
    expect(params.feature).toBe('wiki:poplar_tree')
    // The config half: every last field ignored -- including the stale pack biome that produced
    // "biome id ... is not defined by any loaded biome file" for an id the user never chose here.
    expect(params.env).toBe('plains')
    expect(params.size).toBe('32x48x32')
    expect(params.minY).toBe(44)
    expect(params.repeat).toBe(1)
    expect(params.profile).toBe(false)
    expect(params.seed).toBeUndefined()
    expect(params.origin).toBeUndefined()
    expect(params.biomeId).toBeUndefined()
    expect(params.biomeTags).toBeUndefined()
    expect(params.materials).toBeUndefined()
    expect(params.writeBudget).toBeUndefined()
    expect(params.delegationBudget).toBeUndefined()
    expect(params.placementTimeLimitMs).toBeUndefined()
  })

  it('a hand-edited blob whose subject fields are the wrong type degrades to "nothing selected" rather than sending junk', () => {
    localStorage.setItem('featurelab.panel.v1', JSON.stringify({ config: { mode: 'feture', featureIdentifier: 42, ruleIdentifier: '' }, view: {}, collapsed: [] }))
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange: vi.fn() })
    // Unknown mode falls back to 'feature' (a radio actually matches it), and neither identifier
    // is usable -- so there is no request to build at all, which is the honest answer.
    expect((root.querySelector('input[type=radio][name=fl-preview-mode][value=feature]') as HTMLInputElement).checked).toBe(true)
    expect(panel.getGenerateParams()).toBeNull()
  })
})

// Busy state (never "no indication that anything is happening") -- setBusy() drives a visible pending
// state (a banner, plus a class the stat tiles/viewer respond to), and setResult/setError/
// setStale(true) must ALWAYS clear it even if a host never calls setBusy(false) itself (the
// "cannot get stuck" requirement).
describe('createPanel: busy state', () => {
  it('setBusy(true) shows a busy indicator, dims the stat tiles, and tells the viewer; setBusy(false) reverses all three', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })
    const readout = root.querySelector('.fl-readout') as HTMLElement
    const busyBanner = root.querySelector('.fl-banner-busy') as HTMLElement
    expect(busyBanner.style.display).toBe('none')
    expect(readout.classList.contains('fl-readout-busy')).toBe(false)

    panel.setBusy(true)
    expect(busyBanner.style.display).not.toBe('none')
    expect(readout.classList.contains('fl-readout-busy')).toBe(true)
    expect(viewer.setBusy).toHaveBeenLastCalledWith(true)

    panel.setBusy(false)
    expect(busyBanner.style.display).toBe('none')
    expect(readout.classList.contains('fl-readout-busy')).toBe(false)
    expect(viewer.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('setResult clears busy on its own, even if the host never calls setBusy(false)', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })
    panel.setBusy(true)
    panel.setResult(makeResult())
    expect((root.querySelector('.fl-banner-busy') as HTMLElement).style.display).toBe('none')
    expect(viewer.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('setError(message) clears busy on its own -- a failed request must never leave the busy indicator stuck on', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })
    panel.setBusy(true)
    panel.setError('engine exploded')
    expect((root.querySelector('.fl-banner-busy') as HTMLElement).style.display).toBe('none')
    expect(viewer.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('setStale(true) clears busy on its own -- a dead engine must never leave the busy indicator stuck on', () => {
    const root = document.createElement('div')
    const viewer = makeViewerStub()
    const panel = createPanel(root, { viewer })
    panel.setBusy(true)
    panel.setStale(true, 'engine crashed')
    expect((root.querySelector('.fl-banner-busy') as HTMLElement).style.display).toBe('none')
    expect(viewer.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('setStale(false) does NOT clear busy -- a host sends this at the START of every request, clearing a PREVIOUS stale banner, not signalling this one finished', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setBusy(true)
    panel.setStale(false)
    expect((root.querySelector('.fl-banner-busy') as HTMLElement).style.display).not.toBe('none')
  })
})

// The budget diagnostic gets a one-click fix: parseBudgetDiagnostic recognizes
// session.go's own three budget-exceeded messages (see that function's own doc comment for
// exactly which text it matches), and the Diagnostics section renders a quick-fix button that
// doubles the run's own effective budget and regenerates.
describe('parseBudgetDiagnostic', () => {
  it('recognizes a write-budget-exceeded message and extracts the effective budget', () => {
    const hit = parseBudgetDiagnostic('write budget hit at 100001 of 100000 block writes; 3 repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result')
    expect(hit).toEqual({ kind: 'write', effective: 100000, label: 'write budget', unit: '' })
  })

  it('recognizes a delegation-budget-exceeded message and extracts the effective budget', () => {
    const hit = parseBudgetDiagnostic('delegation budget hit at 2000001 of 2000000 nested feature placements; 1 repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result')
    expect(hit).toEqual({ kind: 'delegation', effective: 2000000, label: 'delegation budget', unit: '' })
  })

  it('recognizes a placement-time-limit-exceeded message and extracts the configured limit', () => {
    const hit = parseBudgetDiagnostic('placement wall-clock time limit of 8000ms hit after 4 nested placements; 0 repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result')
    expect(hit).toEqual({ kind: 'time', effective: 8000, label: 'time limit', unit: 'ms' })
  })

  it('returns null for an ordinary, non-budget diagnostic message', () => {
    expect(parseBudgetDiagnostic('placement refused: no valid site found within budget of 64 attempts')).toBeNull()
    expect(parseBudgetDiagnostic('missing required molang variable "query.foo"')).toBeNull()
  })
})

describe('createPanel: Diagnostics budget quick-fix', () => {
  it('renders a quick-fix button on a write-budget diagnostic that doubles the budget, updates the Budget section, and regenerates', () => {
    const root = document.createElement('div')
    const onConfigChange = vi.fn()
    const panel = createPanel(root, { viewer: makeViewerStub(), onConfigChange })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setResult(
      makeResult({
        diagnostics: [
          makeDiagnostic({
            level: 'error',
            fileId: 'a.json',
            message: 'write budget hit at 4000001 of 4000000 block writes; 2 repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result',
          }),
        ],
      }),
    )

    const fixBtn = [...root.querySelectorAll('button.fl-diag-budget-fix')][0] as HTMLButtonElement
    expect(fixBtn).toBeDefined()
    expect(fixBtn.textContent).toContain('8,000,000') // doubled from the run's own 4,000,000
    expect(fixBtn.textContent).toContain('write budget')

    onConfigChange.mockClear()
    fixBtn.dispatchEvent(new Event('click'))

    // Budget section's own input/badge reflect the fix, not just GenerationConfig internally.
    const writeBudgetRow = [...root.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Write budget')!
    const input = writeBudgetRow.querySelector('input') as HTMLInputElement
    const badge = writeBudgetRow.querySelector('.fl-budget-badge') as HTMLElement
    expect(input.value).toBe('8000000')
    expect(badge.classList.contains('fl-hidden')).toBe(false)

    // And it actually regenerated with the new value.
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    expect(onConfigChange.mock.calls[0]![0].writeBudget).toBe(8000000)
    expect(panel.getGenerateParams()?.writeBudget).toBe(8000000)
  })

  it('doubles the delegation budget and the time limit correctly too, with the right units in the button label', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.seedOpenedDocument('feature', 'wiki:poplar_tree')
    panel.setResult(
      makeResult({
        diagnostics: [
          makeDiagnostic({ level: 'error', fileId: 'a.json', identifier: 'a', message: 'delegation budget hit at 2000001 of 2000000 nested feature placements; 0 repeat placement(s) completed', count: 1 }),
          makeDiagnostic({ level: 'error', fileId: 'b.json', identifier: 'b', message: 'placement wall-clock time limit of 8000ms hit after 4 nested placements; 0 repeat placement(s) completed', count: 1 }),
        ],
      }),
    )
    const fixButtons = [...root.querySelectorAll('button.fl-diag-budget-fix')] as HTMLButtonElement[]
    expect(fixButtons).toHaveLength(2)
    expect(fixButtons.map((b) => b.textContent).some((t) => t?.includes('4,000,000') && t.includes('delegation budget'))).toBe(true)
    expect(fixButtons.map((b) => b.textContent).some((t) => t?.includes('16,000ms') && t.includes('time limit'))).toBe(true)

    const timeFixBtn = fixButtons.find((b) => b.textContent?.includes('time limit'))!
    timeFixBtn.dispatchEvent(new Event('click'))
    expect(panel.getGenerateParams()?.placementTimeLimitMs).toBe(16000)
  })

  it('renders no quick-fix button for an ordinary (non-budget) diagnostic', () => {
    const root = document.createElement('div')
    const panel = createPanel(root, { viewer: makeViewerStub() })
    panel.setResult(makeResult({ diagnostics: [makeDiagnostic({ level: 'warning', fileId: 'a.json', message: 'placement refused: site occupied' })] }))
    expect(root.querySelector('button.fl-diag-budget-fix')).toBeNull()
  })
})

describe('parseBudgetDiagnostic against the messages the engine really emits', () => {
  // The time-limit pattern never matched for as long as it existed, because it was written
  // without the word the engine actually uses ("wall-clock"), and the only test of it fed the
  // regex a message someone had written by hand. A test that supplies its own input to the thing
  // under test is testing the input.
  //
  // These three strings are copied from the format strings in features/shared.go and
  // session/session.go. If one of them is reworded, this fails here rather than in a quick-fix
  // nobody notices is missing.
  it('matches the engine wording for all three budgets', () => {
    const time = parseBudgetDiagnostic(
      'placement wall-clock time limit of 8000ms hit while geode max_radius column scan ' +
        '(0 nested placement(s) deep -- this is one feature\'s own loop, not a delegation chain) ' +
        '-- TRUNCATED BY THE CLOCK, NOT REPRODUCIBLE',
    )
    expect(time).toEqual({ kind: 'time', effective: 8000, label: 'time limit', unit: 'ms' })

    const write = parseBudgetDiagnostic(
      'write budget hit at 4000000 of 4000000 block writes; 0 repeat placement(s) completed',
    )
    expect(write?.kind).toBe('write')
    expect(write?.effective).toBe(4000000)

    const delegation = parseBudgetDiagnostic(
      'delegation budget hit at 2000000 of 2000000 nested feature placements; 0 repeat placement(s) completed',
    )
    expect(delegation?.kind).toBe('delegation')
    expect(delegation?.effective).toBe(2000000)
  })

  it('still returns null for an ordinary diagnostic', () => {
    expect(parseBudgetDiagnostic('wiki:x: Block could not attach to the given location')).toBeNull()
  })
})
