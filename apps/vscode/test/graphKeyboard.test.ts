// graphKeyboard.test.ts -- what it COSTS to use this canvas without a mouse, counted in
// keypresses.
//
// WHY A SEPARATE FILE, and why it counts rather than asserts shapes. An accessibility audit of
// this panel found every control correctly labelled and every one of them reachable, and
// concluded the canvas was unusable anyway: 57 cards, 57 connector handles and 29 edge chips all
// carried `tabindex=0`, so Tab walked 127 stops to cross one screen of a pack, and the sixth of
// those stops was a card at world {x:-281, y:-463} -- outside the viewport, with the camera
// still where it started and not one `:focus-visible` element on screen.
//
// None of that is visible from a shape assertion. "Is the card focusable" was true the whole
// time. The only honest measurement is the one a person makes: press the key, count the presses,
// look at where the focus ring actually is. So every test here drives the REAL bundle in real
// Chromium under the real Content-Security-Policy -- the same rig graphAccess.test.ts uses, for
// the same reason its header gives -- presses real keys through the browser's own input
// pipeline, and reads the result off `document.activeElement` and the element's box.
//
// The numbers are asserted as CEILINGS, not as exact counts: a ceiling still fails when a
// regression puts the tab stops back, and does not fail when somebody adds a legitimate control
// to the toolbar.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(here, '..')
const cssPath = path.join(appRoot, 'media', 'graph.css')
const webviewPath = path.join(appRoot, 'webview', 'graph.ts')

/** Dark Modern, trimmed to what this file needs -- nothing here measures a colour. */
const THEME: Record<string, string> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

async function bundleWebview(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [webviewPath],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling webview/graph.ts')
  return (
    `globalThis.__posted = [];\n` +
    `globalThis.acquireVsCodeApi = () => ({\n` +
    `  postMessage: (m) => { globalThis.__posted.push(m) },\n` +
    `  getState: () => undefined,\n` +
    `  setState: () => undefined,\n` +
    `});\n` +
    output.text
  )
}

/** What has the keyboard, and where it is. Everything in this file is read off this. */
interface Focus {
  /** A short human name for the stop, for the failure message and for the trace. */
  what: string
  tag: string
  className: string
  nodeId: string
  /** True when the focused element's box lies inside the canvas's own box. */
  inViewport: boolean
  /** True when the focused element IS a card -- not merely something inside one. The first
   * version of this file asked whether the class contained `flg-node`, and `flg-node-fan-in`
   * does: it walked straight past the distinction it was written to measure. */
  isCard: boolean
  /** True when the element is inside the canvas. */
  inCanvas: boolean
  /** True when the element is inside the inspector column. */
  inSide: boolean
  /** True when the browser would paint a focus ring on it. */
  focusVisible: boolean
  label: string
}

const READ_FOCUS = function (): Focus {
  const el = document.activeElement as HTMLElement | null
  const canvas = document.getElementById('flg-canvas')
  const side = document.getElementById('flg-side')
  if (el === null || el === document.body) {
    return { what: 'body', tag: 'BODY', className: '', nodeId: '', isCard: false, inViewport: false, inCanvas: false, inSide: false, focusVisible: false, label: '' }
  }
  const box = el.getBoundingClientRect()
  const view = canvas?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0)
  const inViewport =
    box.width > 0 && box.height > 0 && box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom
  const nodeId = el.dataset['nodeId'] ?? el.closest<HTMLElement>('.flg-node')?.dataset['nodeId'] ?? ''
  const cls = el.className
  const className = typeof cls === 'string' ? cls : ''
  let focusVisible = false
  try {
    focusVisible = el.matches(':focus-visible')
  } catch {
    focusVisible = false
  }
  const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').slice(0, 40)
  const what = className.split(/\s+/).find((c) => c.startsWith('flg-') || c.startsWith('fls-')) ?? el.id ?? el.tagName
  return {
    what: what === '' ? el.tagName : what,
    tag: el.tagName,
    className,
    nodeId,
    isCard: el.classList.contains('flg-node'),
    inViewport,
    inCanvas: canvas !== null && canvas.contains(el),
    inSide: side !== null && side.contains(el),
    focusVisible,
    label,
  }
}

const PANEL_TIMEOUT_MS = 90_000

describe('the node editor from the keyboard, counted in keypresses', { timeout: PANEL_TIMEOUT_MS }, () => {
  let browser: Browser
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const script = await bundleWebview()
    const css = readFileSync(cssPath, 'utf-8')
    const { renderGraphShellHtml } = await import('../src/graphPanel.js')
    const httpServer = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/graph.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(script)
        return
      }
      if (url === '/graph.css') {
        res.setHeader('Content-Type', 'text/css')
        res.end(css)
        return
      }
      if (url.startsWith('/theme-')) {
        res.setHeader('Content-Type', 'text/css')
        res.end(`:root {\n${Object.entries(THEME).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`)
        return
      }
      const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
      res.setHeader('Content-Type', 'text/html')
      res.end(
        renderGraphShellHtml({ nonce: 'testnonce', cspSource: origin, scriptUri: '/graph.js', styleUri: '/graph.css', packLabel: 'fixture' }),
      )
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  /** A booted panel with the fixture pack's 57-node graph in it, exactly as graphAccess opens
   * one: the real shell, the real bundle, the theme served through the CSP rather than around
   * it. */
  async function open(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.evaluate(() => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = '/theme-dark.css'
      document.head.append(link)
    })
    await page.waitForFunction(() => (document.getElementById('flg-toolbar')?.children.length ?? 0) > 0, undefined, { timeout: 20_000 })
    const graph = JSON.parse(readFileSync(path.join(here, 'fixtures', 'graph-sample.json'), 'utf-8')) as unknown
    const types = JSON.parse(readFileSync(path.join(here, 'fixtures', 'types-sample.json'), 'utf-8')) as { types?: unknown[] }
    await page.evaluate(
      ({ wire, rows }) => {
        window.postMessage({ type: 'types', coverage: rows }, '*')
        window.postMessage({ type: 'graph', graph: wire }, '*')
      },
      { wire: graph, rows: types.types ?? [] },
    )
    await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
    expect(errors, `the panel threw while booting: ${errors.join(' | ')}`).toEqual([])
    return page
  }

  function focus(page: Page): Promise<Focus> {
    return page.evaluate(`(${READ_FOCUS})()`) as Promise<Focus>
  }

  /** Presses `key` until `done` says stop, counting the presses. Gives up at `max` and reports
   * the trail it walked, which is the only useful failure message here. */
  async function pressUntil(
    page: Page,
    key: string,
    done: (f: Focus) => boolean,
    max = 300,
  ): Promise<{ presses: number; trail: string[]; last: Focus }> {
    const trail: string[] = []
    let last = await focus(page)
    for (let presses = 1; presses <= max; presses++) {
      await page.keyboard.press(key)
      last = await focus(page)
      trail.push(`${presses}: ${last.what}${last.nodeId === '' ? '' : ` [${last.nodeId}]`}${last.inViewport ? '' : ' (off screen)'}`)
      if (done(last)) return { presses, trail, last }
    }
    return { presses: -1, trail, last }
  }

  /** The audit's own headline number: how many elements inside the canvas the browser would
   * paint a focus ring on AND the reader could see. It reported 0 with a card focused, which is
   * the whole finding in one integer -- Chromium's accessibility tree said something had focus
   * and there was nothing on screen to show for it.
   *
   * Read off `document.activeElement` rather than by querying `:focus-visible`, because only one
   * element can have focus and `querySelectorAll(':focus-visible')` does not reliably answer for
   * it in Chromium: it returned an empty list for an element whose own `matches(':focus-visible')`
   * answers true. */
  async function visibleRings(page: Page): Promise<number> {
    return page.evaluate(() => {
      const canvas = document.getElementById('flg-canvas')
      const el = document.activeElement as HTMLElement | null
      if (canvas === null || el === null || !canvas.contains(el)) return 0
      if (!el.matches(':focus-visible')) return 0
      const view = canvas.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      const seen =
        box.width > 0 && box.height > 0 && box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom
      return seen ? 1 : 0
    })
  }

  // -- 1. Tab enters the canvas ---------------------------------------------

  describe('Tab entering the canvas', () => {
    it('lands on a card that is ON SCREEN, and the canvas is one tab stop wide', async () => {
      const page = await open()
      try {
        // (a) FROM A COLD OPEN TO A CARD YOU CAN SEE.
        const toCard = await pressUntil(page, 'Tab', (f) => f.isCard)
        // eslint-disable-next-line no-console
        console.log(`[keypresses] cold open -> a focused card: ${String(toCard.presses)}`)
        expect(toCard.presses, `never reached a card. Trail:\n${toCard.trail.join('\n')}`).toBeGreaterThan(0)
        // THE FINDING, and it is read HERE, before anything else presses a key: the ring has to
        // be on the screen at the moment the card takes focus, not at the end of the test.
        // Eight Tabs used to land on a card at world {x:-281, y:-463} with the camera where it
        // started -- focusable, labelled, correctly announced, and not on the screen.
        const rings = await visibleRings(page)
        expect(toCard.last.inViewport, `focus landed on ${toCard.last.nodeId} but it is off screen`).toBe(true)
        expect(rings, 'nothing inside the viewport is wearing a focus ring').toBeGreaterThanOrEqual(1)

        // (b) CROSSING THE CANVAS. 128 stops before: every card, every connector handle, every
        // edge chip and every "N use this" button was its own. The canvas is a composite widget
        // and the DRAWING gets one.
        const across = await pressUntil(page, 'Tab', (f) => f.inSide || f.what === 'body' || !f.inCanvas)
        // eslint-disable-next-line no-console
        console.log(`[keypresses] a focused card -> out of the canvas: ${String(across.presses)}`)
        expect(across.presses, `never left the canvas. Trail:\n${across.trail.slice(0, 20).join('\n')}`).toBeGreaterThan(0)
        // ONE stop for the DRAWING, and the rest is the canvas's own furniture: the key to the
        // glyphs, the overview map's fold and the map itself. Those are three ordinary buttons
        // that happen to sit over the drawing, they were always three, and taking them out of
        // the tab order would make them unreachable rather than cheap. What was 128 is 4.
        expect(across.presses).toBeLessThanOrEqual(4)
      } finally {
        await page.close()
      }
    })

    it('arrow keys walk from card to card and the camera comes with them', async () => {
      const page = await open()
      try {
        await pressUntil(page, 'Tab', (f) => f.isCard)
        const first = await focus(page)
        const cameraBefore = await page.evaluate(() => (window as never as { __flgView: { getCamera(): { x: number; y: number } } }).__flgView.getCamera())

        const seen = new Set<string>([first.nodeId])
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press('ArrowRight')
          const f = await focus(page)
          expect(f.isCard, `an arrow key left the cards and landed on ${f.what}`).toBe(true)
          expect(f.inViewport, `ArrowRight put focus on ${f.nodeId}, which is off screen`).toBe(true)
          seen.add(f.nodeId)
        }
        // eslint-disable-next-line no-console
        console.log(`[keypresses] 12 ArrowRights visited ${String(seen.size)} distinct cards`)
        expect(seen.size).toBeGreaterThan(3)
        const cameraAfter = await page.evaluate(() => (window as never as { __flgView: { getCamera(): { x: number; y: number } } }).__flgView.getCamera())
        expect(cameraAfter, 'the camera never followed the focus').not.toEqual(cameraBefore)
      } finally {
        await page.close()
      }
    })
  })

  // -- 2. search to the form ------------------------------------------------

  describe('search to the first inspector field', () => {
    it('costs the query and nothing else', async () => {
      const page = await open()
      try {
        const QUERY = 'geode'
        let presses = 0
        await page.keyboard.press('Control+f')
        presses += 1
        await page.waitForFunction(() => document.activeElement?.classList.contains('fls-input') === true, undefined, { timeout: 10_000 })
        await page.keyboard.type(QUERY)
        presses += QUERY.length
        await page.waitForFunction(() => document.querySelectorAll('.fls-row').length > 0, undefined, { timeout: 10_000 })
        await page.keyboard.press('ArrowDown')
        presses += 1
        await page.keyboard.press('Enter')
        presses += 1

        const landed = await focus(page)
        // eslint-disable-next-line no-console
        console.log(`[keypresses] Ctrl+F to a chosen result: ${String(presses)} (focus now on ${landed.what})`)

        if (!landed.inSide) {
          const toForm = await pressUntil(page, 'Tab', (f) => f.inSide)
          // eslint-disable-next-line no-console
          console.log(`[keypresses] chosen result -> first inspector control: ${String(toForm.presses)} more`)
          presses += toForm.presses
        }
        // eslint-disable-next-line no-console
        console.log(`[keypresses] whole journey, Ctrl+F -> first inspector control: ${String(presses)}`)
        // Ctrl+F, the query, Down, Enter. Nothing between the result and the form.
        expect(presses).toBeLessThanOrEqual(QUERY.length + 3)
        expect(landed.inSide, `Enter on a result left focus on ${landed.what}`).toBe(true)
      } finally {
        await page.close()
      }
    })

    it('leaves the combobox exactly as it was -- focus in the box while typing', async () => {
      const page = await open()
      try {
        await page.keyboard.press('Control+f')
        await page.waitForFunction(() => document.activeElement?.classList.contains('fls-input') === true, undefined, { timeout: 10_000 })
        await page.keyboard.type('geo')
        await page.waitForFunction(() => document.querySelectorAll('.fls-row').length > 0, undefined, { timeout: 10_000 })
        await page.keyboard.press('ArrowDown')
        // Arrowing still moves `aria-activedescendant` and leaves real focus in the input: that
        // is what makes the next character go where it was typed.
        const typing = await focus(page)
        expect(typing.className).toContain('fls-input')
        expect(await page.evaluate(() => document.querySelector('.fls-input')?.getAttribute('aria-activedescendant') ?? '')).not.toBe('')
      } finally {
        await page.close()
      }
    })
  })

  // -- 3. keyboard multi-select --------------------------------------------

  describe('building a selection without a mouse', () => {
    it('Ctrl+Space adds the focused card to the selection, and three of them can be grouped', async () => {
      const page = await open()
      try {
        let presses = 0
        const toCard = await pressUntil(page, 'Tab', (f) => f.isCard)
        presses += toCard.presses

        // Card one.
        await page.keyboard.press('Control+Space')
        presses += 1
        // Card two.
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Control+Space')
        presses += 2
        // Card three.
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Control+Space')
        presses += 2

        const picked = await page.evaluate(() => {
          const sel = (window as never as { __flgView: { getSelection(): unknown } }).__flgView.getSelection() as { kind?: string; nodeIds?: string[] } | null
          return { kind: sel?.kind ?? 'null', count: sel?.nodeIds?.length ?? 0 }
        })
        // eslint-disable-next-line no-console
        console.log(`[keypresses] cold open -> three cards selected: ${String(presses)} (selection: ${picked.kind}, ${String(picked.count)})`)
        expect(picked.kind).toBe('nodes')
        expect(picked.count).toBe(3)

        // And the rest of the group life cycle, which already worked, now has its step one.
        await page.keyboard.press('Control+g')
        presses += 1
        await page.waitForFunction(() => document.activeElement?.id === 'flg-group-name', undefined, { timeout: 10_000 })
        // eslint-disable-next-line no-console
        console.log(`[keypresses] cold open -> naming a group of three: ${String(presses)}`)
        // Seven of these are the TOOLBAR -- the search box, New feature and four view buttons --
        // and they were always seven. The canvas's own share is six: three Ctrl+Spaces, two
        // arrows between the cards, and Ctrl+G. Before this there was no number at all: every
        // chord tried against a second card (Ctrl+Enter, Shift+Enter, Ctrl+Space, Shift+Space,
        // Alt+Enter) left the selection at one id, so the group life cycle could not be started.
        expect(presses).toBeLessThanOrEqual(14)
      } finally {
        await page.close()
      }
    })

    it('Ctrl+Space toggles: a second press takes the card back out', async () => {
      const page = await open()
      try {
        await pressUntil(page, 'Tab', (f) => f.isCard)
        await page.keyboard.press('Control+Space')
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Control+Space')
        expect(await page.evaluate(() => ((window as never as { __flgView: { getSelection(): { nodeIds?: string[] } | null } }).__flgView.getSelection()?.nodeIds ?? []).length)).toBe(2)
        await page.keyboard.press('Control+Space')
        const after = await page.evaluate(() => {
          const sel = (window as never as { __flgView: { getSelection(): { kind?: string } | null } }).__flgView.getSelection()
          return sel?.kind ?? 'null'
        })
        // Two or more, or one, or nothing -- selectionOfNodes' rule, unchanged.
        expect(after).toBe('node')
      } finally {
        await page.close()
      }
    })
  })

  // -- 4. ports and chips are off the tab sequence but not gone -------------

  describe('the connector handles and the edge chips', () => {
    it('are out of the tab order, and reachable from the card they belong to', async () => {
      const page = await open()
      try {
        const tabbables = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('#flg-canvas .flg-node, #flg-canvas .flg-node-port, #flg-canvas .flg-chip')].filter(
            (el) => el.tabIndex >= 0,
          ).length,
        )
        // eslint-disable-next-line no-console
        console.log(`[tab stops] cards + handles + chips still in the tab order: ${String(tabbables)}`)
        expect(tabbables).toBeLessThanOrEqual(1)

        await pressUntil(page, 'Tab', (f) => f.isCard)
        const card = await focus(page)
        await page.keyboard.press('F2')
        const stepped = await focus(page)
        expect(stepped.className, `F2 on ${card.nodeId} did not reach its connector handle`).toContain('flg-node-port')
        expect(stepped.inViewport).toBe(true)
        await page.keyboard.press('Escape')
        const back = await focus(page)
        expect(back.isCard).toBe(true)
        expect(back.nodeId).toBe(card.nodeId)
      } finally {
        await page.close()
      }
    })
  })
})
