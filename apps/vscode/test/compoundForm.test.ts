// compoundForm.test.ts -- covers src/graph/compounds/form.ts, the settings panel a COLLAPSED
// compound node is edited through.
//
// Two halves, the split graphInspector.test.ts uses and for the same reasons:
//
//   1. PURE. Reading a parameter object into a draft, writing one back, moving a list element, and
//      the two couplings -- which axis a loop's step script lands in, and which column fields an
//      order can carry -- are plain functions and are tested as plain functions, in node. That is
//      where "the order IS the semantics" and "levelVariable belongs to one shape only" are
//      actually pinned, so a later restyling cannot quietly unpick them.
//   2. REAL BROWSER. The rest is DOM and paint, and jsdom answers none of it: does a `column`
//      really draw the author's own bounds instead of the generated counter script, is a count
//      really free text rather than a spin-box, does changing the evaluation order really move the
//      step script's label, does a refused edit really stay on screen, does every control really
//      take its colours from a `--vscode-*` property.
//
// THE FIXTURE IS REAL DATA. test/fixtures/graph-compound-sample.json is graph output over a pack
// holding a `column` with its annotation. `demo:vine_column` is the case this module exists for:
// its own fields are a generated `iterations` string holding
// `v.level = -1; v.vine_column__min = 0; ... return v.vine_column__iterations;`, and what its
// author wrote is a feature, a bound, an order and a level variable. If this file tested only
// hand-made parameters it would be testing a fiction.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  columnFieldsFor,
  columnOrderSwitchLoss,
  columnWithOrder,
  describeStepMove,
  describeStepPosition,
  effectiveEvalOrder,
  moveInList,
  readColumnDraft,
  readGuardDraft,
  readLoopDraft,
  readStepsDraft,
  stepAxisOf,
  writeColumnDraft,
  writeGuardDraft,
  writeLoopDraft,
  writeStepsDraft,
  COMPOUND_FORM_STYLESHEET,
  type CompoundFormSource,
} from '../src/graph/compounds/form.js'
import { columnCompound } from '../src/graph/compounds/column.js'
import { loopCompound } from '../src/graph/compounds/loop.js'
import { stepsCompound } from '../src/graph/compounds/steps.js'
import { placementGuardSpec } from '../src/graph/compounds/placementGuard.js'
import { DEFAULT_COORDINATE_EVAL_ORDER } from '../src/graph/compounds/loop.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const samplePath = path.join(dir, 'fixtures', 'graph-compound-sample.json')

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

interface SampleAnnotation {
  name: string
  args?: string[]
  text?: string
  jsonPath: string
}

interface SampleNode {
  id: string
  typeId?: string
  file?: string
  formatVersion?: string
  fields?: Record<string, unknown>
  annotations?: SampleAnnotation[]
}

const SAMPLE = JSON.parse(readFileSync(samplePath, 'utf-8')) as { nodes: SampleNode[] }

function sampleNode(id: string): SampleNode {
  const node = SAMPLE.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`${id} is not in graph-compound-sample.json`)
  return node
}

/** The parameters the pack actually recorded on a node, straight out of the annotation body. */
function recordedParams(id: string): unknown {
  const node = sampleNode(id)
  const annotation = (node.annotations ?? []).find((each) => each.name === 'idiom')
  if (annotation?.text === undefined) throw new Error(`${id} carries no compound annotation`)
  return JSON.parse(annotation.text) as unknown
}

const COLUMN_PARAMS = recordedParams('demo:vine_column')

// ---------------------------------------------------------------------------
// 1. Pure: drafts, list order, and the two couplings
// ---------------------------------------------------------------------------

describe('a collapsed compound shows the author their own inputs, not the generated machinery', () => {
  it('shows none of the generated counter script, which is what the node is actually made of', () => {
    // The node's own `fields` are what a generic schema-driven form would put in front of the
    // author: an `iterations` string seeding generated variables and a per-axis script that
    // increments the level. None of it appears in the draft.
    const generated = JSON.stringify(sampleNode('demo:vine_column').fields)
    expect(generated).toContain('v.vine_column__iterations')
    expect(generated).toContain('return v.vine_column__iterations;')

    const shown = JSON.stringify(readColumnDraft(COLUMN_PARAMS))
    expect(shown).not.toContain('vine_column__')
    expect(shown).not.toContain('return')
  })

  it("reads a real column's recorded parameters, order and level variable included", () => {
    const draft = readColumnDraft(COLUMN_PARAMS)
    expect(draft).toEqual({
      places: 'demo:vine_block',
      maxY: '6',
      minY: '',
      setup: '',
      order: 'bottom-up',
      levelVariable: 'v.level',
      step: '',
    })
  })

  it('round-trips every kind through its own spec unchanged', () => {
    // A draft that silently dropped or invented a key would be a draft that rewrote the author's
    // annotation on the next save, so the round trip is checked against the spec's own validate.
    expect(columnCompound.validate(COLUMN_PARAMS).ok).toBe(true)
    expect(writeColumnDraft(readColumnDraft(COLUMN_PARAMS))).toEqual(COLUMN_PARAMS)

    const loop = { count: 'math.random_integer(2, 5)', places: 'example:rock', step: 'v.i = v.i + 1;' }
    expect(writeLoopDraft(readLoopDraft(loop))).toEqual(loop)
    const steps = { steps: ['example:a', 'example:b'], setup: 'v.n = 0;' }
    expect(writeStepsDraft(readStepsDraft(steps))).toEqual(steps)
    const guard = { places: 'example:vine', probeBlock: 'minecraft:bedrock', mayReplace: ['minecraft:air'] }
    expect(writeGuardDraft(readGuardDraft(guard))).toEqual(guard)
  })

  it('writes a cleared optional as an absent key rather than an empty string', () => {
    // "Not written" and "written empty" are different files, and only one of them is what clearing
    // a box means.
    const draft = readLoopDraft({ count: '2', places: 'example:rock', setup: 'v.i = 0;', step: 'v.i = v.i + 1;' })
    const cleared = writeLoopDraft({ ...draft, step: '   ', setup: '' }) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(cleared, 'step')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(cleared, 'setup')).toBe(false)
  })

  it('reads a parameter object the spec has already refused, so a broken one can still be repaired', () => {
    const draft = readStepsDraft({ steps: [42, null, 'example:a'], setup: 7 })
    expect(draft.steps).toEqual(['', '', 'example:a'])
    expect(draft.setup).toBe('')
  })
})

describe('order is semantics, so it is movable and said out loud', () => {
  it('moves a list element and leaves the rest in order', () => {
    expect(moveInList(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveInList(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveInList(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
    expect(moveInList(['a', 'b', 'c'], -1, 1)).toEqual(['a', 'b', 'c'])
    expect(moveInList(['a', 'b', 'c'], 0, 9)).toEqual(['a', 'b', 'c'])
  })

  it('says what a step position means as execution order', () => {
    expect(describeStepPosition(0, 3)).toBe('Runs first.')
    expect(describeStepPosition(2, 3)).toBe('Runs last.')
    expect(describeStepPosition(1, 4)).toBe('Runs 2nd.')
  })

  it('moving a step reorders the parameters and nothing else', () => {
    const draft = readStepsDraft({ steps: ['example:a', 'example:b'], setup: 'v.n = 0;' })
    const moved = writeStepsDraft({ ...draft, steps: moveInList(draft.steps, 1, 0) })
    expect(moved).toEqual({ steps: ['example:b', 'example:a'], setup: 'v.n = 0;' })
    // And it is still a steps node the spec accepts, which is what makes the reorder applyable.
    expect(stepsCompound.validate(moved).ok).toBe(true)
  })
})

describe('the loop coupling: the step script lives in whichever axis is evaluated first', () => {
  it("takes the axis from loop.ts's own rule, including the schema default for an absent order", () => {
    expect(stepAxisOf('')).toBe(DEFAULT_COORDINATE_EVAL_ORDER.charAt(0))
    expect(stepAxisOf('')).toBe('x')
    expect(stepAxisOf('zyx')).toBe('z')
    expect(stepAxisOf('yxz')).toBe('y')
    expect(effectiveEvalOrder('')).toBe(DEFAULT_COORDINATE_EVAL_ORDER)
    expect(effectiveEvalOrder('yzx')).toBe('yzx')
  })

  it('spells out the move when the order changes under a script', () => {
    expect(describeStepMove('', 'zyx', true)).toBe('Evaluate the coordinates zyx -- the step script moves from x to z')
    // Same first axis: nothing moved, so nothing is claimed to have moved.
    expect(describeStepMove('xyz', 'xzy', true)).toBe('Evaluate the coordinates xzy')
    // No script: there is nothing to move.
    expect(describeStepMove('', 'zyx', false)).toBe('Evaluate the coordinates zyx')
  })

  it("expands the step into the new first axis once the order changed, which is what the label promised", () => {
    const params = { count: '4', places: 'example:rock', step: 'v.i = v.i + 1;', coordinateEvalOrder: 'zyx' }
    const expanded = loopCompound.expand('example:tower', params, '1.21.110')
    expect(expanded.ok).toBe(true)
    if (!expanded.ok) return
    const contents = expanded.expansion.operations.map((op) => (op.op === 'createFile' ? op.contents : '')).join('\n')
    // The script is in z, not x -- which is the whole reason the two controls are one control.
    expect(contents).toContain('"z": "v.i = v.i + 1;return 0;"')
    expect(contents).not.toContain('"x": "v.i = v.i + 1;')
  })
})

describe('the column coupling: two fields that exist in one shape only', () => {
  it('offers the counter fields only in the shape that has a counter', () => {
    expect(columnFieldsFor('bottom-up')).toEqual({ levelVariable: true, step: true })
    expect(columnFieldsFor('top-down')).toEqual({ levelVariable: false, step: false })
    // Absent reads as top-down, which is the spec's default and not a third state.
    expect(columnFieldsFor('')).toEqual({ levelVariable: false, step: false })
  })

  it('names exactly what a switch to top-down would discard', () => {
    const draft = readColumnDraft(COLUMN_PARAMS)
    expect(columnOrderSwitchLoss(draft, 'top-down')).toEqual(['levelVariable'])
    expect(columnOrderSwitchLoss({ ...draft, step: 'v.n = v.n + 1;' }, 'top-down')).toEqual(['levelVariable', 'step'])
    // The other direction discards nothing, so it needs no ceremony.
    expect(columnOrderSwitchLoss({ ...draft, order: 'top-down', levelVariable: '' }, 'bottom-up')).toEqual([])
  })

  it('produces parameters the spec accepts in both directions, which a silent switch would not', () => {
    const draft = readColumnDraft(COLUMN_PARAMS)
    // Keeping the level variable while flipping the order is exactly the file the spec refuses,
    // and the reason the panel takes a second click for it.
    const naive = writeColumnDraft({ ...draft, order: 'top-down' })
    const refused = columnCompound.validate(naive)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.code).toBe('order-sensitive')

    const honest = writeColumnDraft(columnWithOrder(draft, 'top-down'))
    expect(columnCompound.validate(honest).ok).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(honest as object, 'levelVariable')).toBe(false)
  })
})

describe('the stylesheet', () => {
  it('reads every colour through a --vscode-* custom property', () => {
    // A literal colour below the variable block is a colour that will not follow the theme.
    const body = COMPOUND_FORM_STYLESHEET.slice(COMPOUND_FORM_STYLESHEET.indexOf('font-family: var(--flcf-font)'))
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(body).not.toMatch(/\brgba?\(/)
    for (const name of ['--flcf-input-bg', '--flcf-input-fg', '--flcf-bg', '--flcf-error']) {
      expect(COMPOUND_FORM_STYLESHEET).toContain(`${name}: var(--vscode-`)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Real browser
// ---------------------------------------------------------------------------

/** A trimmed but real Dark+ palette, injected as `--vscode-*` on <html> as the webview host does. */
const DARK_THEME: Record<string, string> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-input-placeholderForeground': '#989898',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-textPreformat-foreground': '#d7ba7d',
  '--vscode-textCodeBlock-background': '#2a2a2a',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-charts-blue': '#4e94ce',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

/** Every property the stylesheet reads, given a colour no palette would produce. */
function sentinelTheme(): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  for (const name of Object.keys(DARK_THEME)) {
    if (name.endsWith('-family') || name.endsWith('-size')) {
      out[name] = DARK_THEME[name] as string
      continue
    }
    const n = i * 7 + 11
    out[name] = `rgb(${((n * 13) % 200) + 20}, ${((n * 29) % 200) + 20}, ${((n * 53) % 200) + 20})`
    i++
  }
  return out
}

/**
 * The module and the four specs in one bundle.
 *
 * Through an esbuild stdin entry rather than a checked-in shim: the specs are what `validate` and
 * `expand` are called on, so a browser harness that stubbed them would be testing a form wired to
 * something no host has.
 */
async function bundleForm(): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export * from './src/graph/compounds/form.ts'
        export { loopCompound } from './src/graph/compounds/loop.ts'
        export { stepsCompound } from './src/graph/compounds/steps.ts'
        export { columnCompound } from './src/graph/compounds/column.ts'
        export { placementGuardSpec } from './src/graph/compounds/placementGuard.ts'
      `,
      resolveDir: path.join(dir, '..'),
      sourcefile: 'compound-form-harness.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling the compound form')
  return output.text
}

interface EmittedChange {
  label: string
  kind: string
  identifier: string
  params: unknown
}

describe('compound settings form: real Chromium DOM, interaction and theming', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string

  beforeAll(async () => {
    moduleSource = await bundleForm()
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/form.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><meta charset="utf-8">
<style nonce="test-nonce">html,body{height:100%;margin:0}#host{position:absolute;inset:0;display:flex}#host>*{flex:1}</style>
</head><body><div id="host"></div>
<script type="module">
import * as m from '/form.js'
window.FLCF = m
window.__ready = true
</script>
</body></html>`)
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  const SPEC_NAMES: Record<string, string> = {
    loop: 'loopCompound',
    steps: 'stepsCompound',
    column: 'columnCompound',
    'placement-guard': 'placementGuardSpec',
  }

  /** Loads the harness and draws one compound's form, wired to that compound's real spec. */
  async function load(
    source: CompoundFormSource,
    opts: { theme?: Record<string, string>; formatVersion?: string } = {},
  ): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 460, height: 1600 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 10_000 })
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    }, opts.theme ?? DARK_THEME)
    await page.evaluate(
      ({ payload, specName, formatVersion }) => {
        const api = (window as unknown as { FLCF: Record<string, unknown> }).FLCF
        const create = api['createCompoundForm'] as (source: unknown, options: unknown) => { element: HTMLElement }
        const changes: unknown[] = []
        const refusals: unknown[] = []
        ;(window as unknown as { changes: unknown[]; refusals: unknown[] }).changes = changes
        ;(window as unknown as { refusals: unknown[] }).refusals = refusals
        const view = create(payload, {
          spec: api[specName],
          ...(formatVersion === null ? {} : { formatVersion }),
          onChange: (change: { kind: string; identifier: string; params: unknown; label: string }) => {
            changes.push({ kind: change.kind, identifier: change.identifier, params: change.params, label: change.label })
          },
          onRefuse: (refusal: { code: string; reason: string }) => refusals.push({ code: refusal.code, reason: refusal.reason }),
        })
        ;(window as unknown as { view: unknown }).view = view
        document.getElementById('host')!.append(view.element)
      },
      {
        payload: JSON.parse(JSON.stringify(source)) as unknown,
        specName: SPEC_NAMES[source.kind] as string,
        formatVersion: opts.formatVersion ?? null,
      },
    )
    return page
  }

  async function changesOf(page: Page): Promise<EmittedChange[]> {
    return (await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { changes: unknown[] }).changes)))) as EmittedChange[]
  }

  async function refusalsOf(page: Page): Promise<{ code: string; reason: string }[]> {
    return (await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { refusals: unknown[] }).refusals)))) as {
      code: string
      reason: string
    }[]
  }

  const columnSource: CompoundFormSource = {
    kind: 'column',
    identifier: 'demo:vine_column',
    title: columnCompound.title,
    summary: columnCompound.summary,
    formParams: COLUMN_PARAMS,
  }

  const loopSource: CompoundFormSource = {
    kind: 'loop',
    identifier: 'example:boulder_field',
    title: loopCompound.title,
    summary: loopCompound.summary,
    formParams: { count: 'math.random_integer(2, 5)', places: 'example:boulder', step: 'v.i = v.i + 1;' },
  }

  const guardSource: CompoundFormSource = {
    kind: 'placement-guard',
    identifier: 'example:ceiling_vines',
    title: placementGuardSpec.title,
    summary: placementGuardSpec.summary,
    formParams: { places: 'example:vine_patch', mayAttachTo: { top: ['minecraft:stone'] } },
  }

  const stepsSource: CompoundFormSource = {
    kind: 'steps',
    identifier: 'example:camp',
    title: stepsCompound.title,
    summary: stepsCompound.summary,
    formParams: { steps: ['example:fire_pit', 'example:tent', 'example:log_seat'] },
  }

  it("draws a column as the author's own settings, and the generated counter script nowhere at all", async () => {
    const page = await load(columnSource)
    try {
      expect(await page.locator('[data-field="places"] input').inputValue()).toBe('demo:vine_block')
      expect(await page.locator('[data-field="maxY"] input').inputValue()).toBe('6')
      expect(await page.locator('[data-field="levelVariable"] input').inputValue()).toBe('v.level')

      // The failure this module exists for: a generic form over the underlying scatter shows the
      // generated counter script. Not one character of it is on this panel.
      const shown = await page.evaluate(() => document.body.innerText)
      expect(shown).not.toContain('vine_column__')
      expect(shown).not.toContain('return v.')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('reorders steps, and reports the reordered parameters rather than a redraw', async () => {
    const page = await load(stepsSource, { formatVersion: '1.21.110' })
    try {
      await page.locator('[aria-label="Move step 1 after step 2"]').click()
      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.identifier).toBe('example:camp')
      expect(changes[0]!.label).toContain('Move step 1')
      expect(changes[0]!.params).toEqual({ steps: ['example:tent', 'example:fire_pit', 'example:log_seat'] })

      // The panel redrew from the new parameters, so the arrows moved with the step.
      const steps = await page.$$eval('[data-field^="step."] input', (els) => els.map((el) => (el as HTMLInputElement).value))
      expect(steps).toEqual(['example:tent', 'example:fire_pit', 'example:log_seat'])

      // The ends of the list cannot move further out, and say so to a screen reader as well.
      expect(await page.locator('[aria-label="Move step 1 before step 0"]').isDisabled()).toBe(true)
      expect(await page.locator('[aria-label="Move step 3 after step 4"]').isDisabled()).toBe(true)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('adds a step, shows the refusal it is in the meantime, and reports nothing until it is answered', async () => {
    const page = await load(stepsSource, { formatVersion: '1.21.110' })
    try {
      await page.locator('button', { hasText: 'Add a step' }).click()

      // The half-written step stays on screen -- throwing it away would delete the click that made
      // it -- and the refusal is the spec's own words, not a swallowed failure.
      expect(await page.locator('[data-field^="step."] input').count()).toBe(4)
      expect(await page.locator('.flcf-refusal').count()).toBe(1)
      expect(await page.locator('.flcf-refusal').innerText()).toContain('step 3 is not a feature reference')
      expect(await changesOf(page)).toHaveLength(0)

      // A box commits on `change`, which is a blur and not a keystroke.
      await page.locator('[data-field="step.3"] input').fill('example:lantern')
      await page.locator('[data-field="step.3"] input').blur()

      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      const params = changes[0]!.params as { steps: string[] }
      expect(params.steps).toHaveLength(4)
      expect(params.steps[3]).toBe('example:lantern')
      expect(await page.locator('.flcf-refusal').count()).toBe(0)

      // Every refusal along the way was reported as well as drawn.
      expect((await refusalsOf(page)).length).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('keeps the evaluation order and the step script in one control, and moves the script with the order', async () => {
    const page = await load(loopSource, { formatVersion: '1.21.110' })
    try {
      // They are one fieldset, not two fields on opposite sides of the panel.
      const together = await page.evaluate(() => {
        const select = document.querySelector('[data-fkey="coordinateEvalOrder"]')
        const step = document.querySelector('[data-fkey="step"]')
        const box = select?.closest('.flcf-coupled') ?? null
        return box !== null && box === (step?.closest('.flcf-coupled') ?? null)
      })
      expect(together).toBe(true)

      // With no order written the script is in x, and the panel says so in the label rather than
      // leaving the author to work it out from the schema's default.
      expect(await page.locator('label[for]', { hasText: 'Per-iteration script' }).innerText()).toContain('runs in x')
      expect(await page.locator('[data-carries="step"]').getAttribute('data-field')).toBe('axis.x')

      await page.selectOption('[data-fkey="coordinateEvalOrder"]', 'zyx')

      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.label).toBe('Evaluate the coordinates zyx -- the step script moves from x to z')
      expect(changes[0]!.params).toMatchObject({ coordinateEvalOrder: 'zyx', step: 'v.i = v.i + 1;' })

      // And the panel now shows the script where it actually is.
      expect(await page.locator('label[for]', { hasText: 'Per-iteration script' }).innerText()).toContain('runs in z')
      expect(await page.locator('[data-carries="step"]').getAttribute('data-field')).toBe('axis.z')
      expect(await page.locator('.flcf-carries').innerText()).toContain('runs in z')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('never offers the column fields that belong to the other shape, and never drops them silently', async () => {
    const page = await load(columnSource, { formatVersion: '1.21.110' })
    try {
      // bottom-up: both counter fields are here.
      expect(await page.locator('[data-field="levelVariable"]').count()).toBe(1)
      expect(await page.locator('[data-field="step"]').count()).toBe(1)
      expect(await page.locator('[data-field="levelVariable"] input').inputValue()).toBe('v.level')

      // The half-open range is labelled so nobody expects the top level.
      const maxHint = await page.locator('[data-field="maxY"] .flcf-hint').innerText()
      expect(maxHint).toContain('NOT included')
      expect(maxHint).toContain('half-open')

      // Choosing the other order does NOT switch: it says what would be lost and waits.
      await page.locator('[data-fkey="order.top-down"]').click()
      expect(await changesOf(page)).toHaveLength(0)
      const warning = await page.locator('.flcf-note-warning[role="alert"]').innerText()
      expect(warning).toContain('levelVariable')
      expect(warning).toContain('nothing here can put')
      expect(await page.locator('[data-field="levelVariable"] input').inputValue()).toBe('v.level')

      // The second, deliberate click. Now it happens, and the emitted parameters are the ones the
      // spec accepts rather than the ones it refuses.
      await page.locator('button', { hasText: 'Switch to top-down and drop levelVariable' }).click()
      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.params).toEqual({ places: 'demo:vine_block', maxY: '6', order: 'top-down' })
      expect(columnCompound.validate(changes[0]!.params).ok).toBe(true)

      // And in the top-down shape the two fields are not drawn at all -- a control that exists only
      // to bounce teaches people to distrust the panel.
      expect(await page.locator('[data-field="levelVariable"]').count()).toBe(0)
      expect(await page.locator('[data-field="step"]').count()).toBe(0)
      expect(await page.locator('.flcf-hint-strong').first().innerText()).toContain('Nothing runs per level')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('backs out of an order change without touching anything', async () => {
    const page = await load(columnSource, { formatVersion: '1.21.110' })
    try {
      await page.locator('[data-fkey="order.top-down"]').click()
      await page.locator('button', { hasText: 'Keep it as it is' }).click()
      expect(await changesOf(page)).toHaveLength(0)
      expect(await page.locator('[data-fkey="order.bottom-up"]').isChecked()).toBe(true)
      expect(await page.locator('[data-field="levelVariable"] input').inputValue()).toBe('v.level')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('draws the guard as a test, never as a block it builds', async () => {
    const page = await load(guardSource, { formatVersion: '1.21.110' })
    try {
      const shown = await page.evaluate(() => document.body.innerText)
      expect(shown).toContain('removed immediately afterwards')
      expect(shown).toContain('nothing it writes survives')
      // The probe is not written, and the panel says what that means rather than inventing a value.
      expect(await page.locator('[data-field="probeBlock"]').count()).toBe(0)
      expect(shown).toContain('default probe block')

      // The attachment test is a face with blocks, not a text box holding JSON.
      expect(await page.locator('[data-field="mayAttachTo.top.0"] input').first().inputValue()).toBe('minecraft:stone')
      expect(await page.locator('textarea').filter({ hasText: '{' }).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('reorders steps as execution order', async () => {
    const page = await load(stepsSource, { formatVersion: '1.21.110' })
    try {
      const positions = await page.$$eval('.flcf-position', (els) => els.map((el) => el.textContent ?? ''))
      expect(positions).toEqual(['Runs first.', 'Runs 2nd.', 'Runs last.'])

      await page.locator('[aria-label="Move step 3 before step 2"]').click()
      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.params).toEqual({ steps: ['example:fire_pit', 'example:log_seat', 'example:tent'] })
    } finally {
      await page.close()
    }
  }, 45_000)

  it('makes every Molang parameter free text, so an expression is still writable', async () => {
    for (const source of [loopSource, columnSource, stepsSource]) {
      const page = await load(source)
      try {
        // Not one spin-box anywhere. `count`, a bound, a condition and a coordinate are all full
        // expressions, and a number input makes every one of them unwritable.
        expect(await page.locator('input[type="number"]').count()).toBe(0)
        const kinds = await page.$$eval('input', (els) => [...new Set(els.map((el) => (el as HTMLInputElement).type))])
        expect(kinds.every((kind) => kind === 'text' || kind === 'radio')).toBe(true)
      } finally {
        await page.close()
      }
    }

    // And an expression really survives the round trip through the panel.
    const page = await load(columnSource, { formatVersion: '1.21.110' })
    try {
      await page.locator('[data-field="maxY"] input').fill('q.above_top_solid - v.base')
      await page.locator('[data-field="maxY"] input').blur()
      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      expect((changes[0]!.params as { maxY: string }).maxY).toBe('q.above_top_solid - v.base')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('shows a refusal the file already had, rather than an empty panel', async () => {
    const page = await load({
      kind: 'column',
      identifier: 'demo:broken_column',
      title: columnCompound.title,
      formParams: null,
      // What the spec refused: the counter field in the shape that has no counter.
      rawParams: { places: 'demo:vine_block', maxY: '6', order: 'top-down', levelVariable: 'v.level' },
    })
    try {
      expect(await page.locator('.flcf-refusal').count()).toBe(1)
      expect(await page.locator('.flcf-refusal').innerText()).toContain('bottom-up')
      // The author's own text is still in front of them, which is what makes it repairable.
      expect(await page.locator('[data-field="places"] input').inputValue()).toBe('demo:vine_block')
      expect(await page.locator('[data-field="maxY"] input').inputValue()).toBe('6')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('is labelled and reachable from the keyboard', async () => {
    const page = await load(stepsSource)
    try {
      const unnamed = await page.$$eval('input, select, textarea, button', (els) =>
        els
          .filter((el) => {
            const id = el.getAttribute('id')
            const labelled = el.getAttribute('aria-label') !== null || (id !== null && document.querySelector(`label[for="${id}"]`) !== null)
            return !labelled && el.closest('label') === null
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
      )
      expect(unnamed).toEqual([])

      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? '')
      expect(['input', 'select', 'textarea', 'button']).toContain(focused)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('takes every colour from the theme, in the panel and in the form controls', async () => {
    const sentinel = sentinelTheme()
    const page = await load(stepsSource, { theme: sentinel })
    try {
      const painted = await page.evaluate(() => {
        const pick = (selector: string): Record<string, string> => {
          const el = document.querySelector(selector)
          if (el === null) return {}
          const style = getComputedStyle(el)
          return { color: style.color, background: style.backgroundColor, border: style.borderTopColor }
        }
        return {
          panel: pick('.flcf-form'),
          input: pick('.flcf-input'),
          area: pick('.flcf-area'),
          button: pick('.flcf-button:not(.flcf-button-quiet)'),
          hint: pick('.flcf-hint'),
        }
      })
      // The exact injected value: a control that renders as a white native widget in a dark panel
      // is the specific bug this pins.
      expect(painted.input.background).toBe(sentinel['--vscode-input-background'])
      expect(painted.input.color).toBe(sentinel['--vscode-input-foreground'])
      expect(painted.area.background).toBe(sentinel['--vscode-input-background'])
      expect(painted.panel.background).toBe(sentinel['--vscode-editorWidget-background'])
      expect(painted.hint.color).toBe(sentinel['--vscode-descriptionForeground'])
      expect(painted.button.background).toBe(sentinel['--vscode-button-secondaryBackground'])
      for (const value of [painted.input.background, painted.panel.background]) {
        expect(value).not.toBe('rgba(0, 0, 0, 0)')
      }
    } finally {
      await page.close()
    }
  }, 45_000)

  it('copies the served nonce onto the stylesheet it installs', async () => {
    // Without this the panel renders as unstyled text under the panel's Content-Security-Policy,
    // and nothing is logged anywhere the author would look.
    const page = await load(stepsSource)
    try {
      const nonce = await page.evaluate(() => {
        const style = document.getElementById('flcf-compound-form-styles') as HTMLStyleElement | null
        return style?.nonce ?? null
      })
      expect(nonce).toBe('test-nonce')
      // Installed once, however many panels are drawn.
      expect(await page.locator('#flcf-compound-form-styles').count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('redraws for freshly recorded parameters, and disposes without leaving its element behind', async () => {
    const page = await load(stepsSource)
    try {
      await page.evaluate((payload) => {
        ;(window as unknown as { view: { update(next: unknown): void } }).view.update(payload)
      }, JSON.parse(JSON.stringify({ ...stepsSource, formParams: { steps: ['example:sapling'] } })) as unknown)
      const steps = await page.$$eval('[data-field^="step."] input', (els) => els.map((el) => (el as HTMLInputElement).value))
      expect(steps).toEqual(['example:sapling'])
      // A redraw is not an edit.
      expect(await changesOf(page)).toHaveLength(0)

      const removed = await page.evaluate(() => {
        const view = (window as unknown as { view: { element: HTMLElement; dispose(): void } }).view
        view.dispose()
        return { attached: document.body.contains(view.element), children: view.element.childElementCount }
      })
      expect(removed.attached).toBe(false)
      expect(removed.children).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)
})
