// graphDocsTooltip.test.ts -- covers src/graph/docs/tooltip.ts, the editor's one hover card.
//
// THE COUNT THAT MADE THIS NECESSARY. The rendered panel carried 348 native `title` attributes
// across about 1,026 elements, the longest 563 characters -- a paragraph delivered by the
// operating system, in a font the theme does not reach, in a box that routinely covers the
// control it is describing. The two controls somebody is most likely to hesitate over, `Delete`
// and `Fit`, had none at all.
//
// TWO HALVES, the split every file in this directory uses:
//
//   1. PURE, in node: the two-line cap and where the card goes. Placement is arithmetic over four
//      rectangles, and asserting it as arithmetic means it can be checked at viewport sizes a
//      browser test would never be run at -- including the ones where nothing fits.
//   2. REAL BROWSER: the delay, the dismissal, and the one rule that cannot be argued from
//      numbers -- that the card does not overlap the control, and that showing it moves nothing.
//      jsdom measures nothing, so it could answer none of these.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  TOOLTIP_BODY_LIMIT,
  TOOLTIP_DELAY_MS,
  TOOLTIP_GAP_PX,
  TOOLTIP_MORE,
  TOOLTIP_STYLESHEET,
  placeTooltip,
  tooltipBody,
} from '../src/graph/docs/tooltip.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const tooltipPath = path.join(dir, '..', 'src', 'graph', 'docs', 'tooltip.ts')

// ---------------------------------------------------------------------------
// 1. The words
// ---------------------------------------------------------------------------

describe('a hover card is two lines, and says where the rest is', () => {
  it('leaves a sentence that already fits completely alone', () => {
    const short = 'Zoom out until every card is on screen at once.'
    expect(tooltipBody(short)).toBe(short)
  })

  it('cuts a paragraph at a word and names the panel that has the rest', () => {
    // The real worst case: the longest title in the panel was 563 characters.
    const long = `${'A sentence about what this key does. '.repeat(20)}`
    const body = tooltipBody(long)
    expect(body.length).toBeLessThan(TOOLTIP_BODY_LIMIT + TOOLTIP_MORE.length + 8)
    expect(body).toContain(TOOLTIP_MORE)
    // Cut at a WORD boundary: the head must be a prefix of the original that ends where the
    // original has a space, not in the middle of a word. A card ending mid-word reads as a bug.
    const head = body.slice(0, body.indexOf('... '))
    expect(long.startsWith(head)).toBe(true)
    expect(long[head.length]).toBe(' ')
    // The beginning is the author's own words, unaltered.
    expect(long.startsWith(body.slice(0, 30))).toBe(true)
  })

  it('does not end a card with a dangling comma or dash before the pointer', () => {
    const body = tooltipBody(`${'word '.repeat(22)}, and then some more text that will not fit at all`)
    expect(body).not.toContain(', ...')
    expect(body).toContain(TOOLTIP_MORE)
  })

  it('collapses the whitespace a template literal leaves in a title', () => {
    expect(tooltipBody('  two   words\n  here  ')).toBe('two words here')
  })

  it('says nothing for nothing', () => {
    expect(tooltipBody('')).toBe('')
    expect(tooltipBody('   ')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2. Where it goes
// ---------------------------------------------------------------------------

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('a hover card never covers the control it describes', () => {
  const card = { width: 200, height: 40 }
  const viewport = { width: 900, height: 700 }

  it('sits under the control when there is room, with a gap', () => {
    const control = { x: 100, y: 100, width: 60, height: 24 }
    const at = placeTooltip(control, card, viewport)
    expect(at.side).toBe('below')
    expect(at.top).toBe(control.y + control.height + TOOLTIP_GAP_PX)
    expect(overlaps({ ...at, ...card, x: at.left, y: at.top }, control)).toBe(false)
  })

  it('flips above a control at the bottom edge rather than sitting on it', () => {
    const control = { x: 100, y: 660, width: 60, height: 24 }
    const at = placeTooltip(control, card, viewport)
    expect(at.side).toBe('above')
    expect(at.top + card.height).toBe(control.y - TOOLTIP_GAP_PX)
    expect(overlaps({ x: at.left, y: at.top, ...card }, control)).toBe(false)
  })

  it('goes beside a control that is taller than the room above and below it', () => {
    const control = { x: 10, y: 0, width: 40, height: 700 }
    const at = placeTooltip(control, card, viewport)
    expect(at.side).toBe('right')
    expect(overlaps({ x: at.left, y: at.top, ...card }, control)).toBe(false)
  })

  it('goes to the left when the right is off screen too', () => {
    const control = { x: 700, y: 0, width: 200, height: 700 }
    const at = placeTooltip(control, card, viewport)
    expect(at.side).toBe('left')
    expect(overlaps({ x: at.left, y: at.top, ...card }, control)).toBe(false)
  })

  it('stays on screen for a control against the right edge', () => {
    const control = { x: 880, y: 100, width: 20, height: 24 }
    const at = placeTooltip(control, card, viewport)
    expect(at.left).toBeGreaterThanOrEqual(0)
    expect(at.left + card.width).toBeLessThanOrEqual(viewport.width)
  })

  it('never puts the card at a negative coordinate, whatever it is given', () => {
    // A panel dragged to nothing, a card taller than the window. There is no good answer here,
    // only answers that keep the card reachable.
    for (const viewportSize of [{ width: 120, height: 60 }, { width: 10, height: 10 }]) {
      const at = placeTooltip({ x: 0, y: 0, width: 40, height: 20 }, card, viewportSize)
      expect(at.left).toBeGreaterThanOrEqual(0)
      expect(at.top).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('the stylesheet', () => {
  it('takes every colour from the theme rather than naming one', () => {
    // The same guard every stylesheet in this directory carries: a literal colour is a card that
    // is unreadable in half the themes people use.
    const declarations = [...TOOLTIP_STYLESHEET.matchAll(/(?:^|\s)(?:color|background|border|border-color|box-shadow)\s*:\s*([^;]+);/g)].map((m) => m[1] ?? '')
    expect(declarations.length).toBeGreaterThan(3)
    for (const value of declarations) {
      if (value.includes('none') || value.includes('transparent')) continue
      expect(value).toContain('var(--vscode-')
    }
  })

  it('cannot move the layout or eat a click', () => {
    expect(TOOLTIP_STYLESHEET).toContain('position: fixed')
    expect(TOOLTIP_STYLESHEET).toContain('pointer-events: none')
  })
})

// ---------------------------------------------------------------------------
// 3. Real Chromium: the delay, the dismissal, the overlap
// ---------------------------------------------------------------------------

async function bundleTooltip(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [tooltipPath],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling src/graph/docs/tooltip.ts')
  return output.text
}

const LONG_TITLE =
  'How many times the rule places its feature per chunk. A number or a Molang string. This is the key that decides whether a rule does anything at all: absent, or 0, and every other setting on the rule is moot.'

describe('hover card: real Chromium timing and geometry', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string

  beforeAll(async () => {
    moduleSource = await bundleTooltip()
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/tooltip.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      res.setHeader('Content-Type', 'text/html')
      // A toolbar at the top and a control near the bottom edge, which is the pair of positions
      // that produced the "the tooltip is on top of the button" reports.
      res.end(`<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{height:100%;margin:0;font-family:sans-serif}
#bar{position:absolute;left:20px;top:20px;display:flex;gap:8px}
#low{position:absolute;left:20px;bottom:10px}
button{font:inherit}
</style>
</head><body>
<div id="bar">
  <button id="fit" title="Zoom out until every card is on screen at once.">Fit</button>
  <button id="long" title="${LONG_TITLE}">iterations</button>
  <button id="bare">No title</button>
</div>
<div id="low"><button id="bottom" title="A control at the very bottom of the window.">Delete</button></div>
<script type="module">
import * as m from '/tooltip.js'
window.FLT = m
const style = document.createElement('style')
style.textContent = m.TOOLTIP_STYLESHEET
document.head.append(style)
window.ctl = m.installTooltips(document)
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
  }, 30_000)

  async function load(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 10_000 })
    return page
  }

  const cardVisible = (page: Page) => page.locator('.flg-tip:not([hidden])').count()

  it('says nothing until the pointer has rested, then says it', async () => {
    const page = await load()
    try {
      await page.hover('#fit')
      // Well inside the delay. A card here is a card that flashes at somebody crossing a toolbar.
      await page.waitForTimeout(Math.round(TOOLTIP_DELAY_MS / 3))
      expect(await cardVisible(page)).toBe(0)

      await page.waitForTimeout(TOOLTIP_DELAY_MS)
      expect(await cardVisible(page)).toBe(1)
      expect(await page.locator('.flg-tip').textContent()).toBe('Zoom out until every card is on screen at once.')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('never covers the control it is describing, at the top or at the bottom of the window', async () => {
    const page = await load()
    try {
      for (const id of ['fit', 'bottom']) {
        await page.evaluate((target) => {
          const ctl = (window as unknown as { ctl: { show(el: HTMLElement): void } }).ctl
          ctl.show(document.getElementById(target) as HTMLElement)
        }, id)
        const boxes = await page.evaluate((target) => {
          const control = (document.getElementById(target) as HTMLElement).getBoundingClientRect()
          const card = (document.querySelector('.flg-tip') as HTMLElement).getBoundingClientRect()
          return {
            control: { x: control.x, y: control.y, width: control.width, height: control.height },
            card: { x: card.x, y: card.y, width: card.width, height: card.height },
          }
        }, id)
        expect(overlaps(boxes.card, boxes.control)).toBe(false)
        // And on screen: a card placed off the bottom is a card nobody reads either.
        expect(boxes.card.y).toBeGreaterThanOrEqual(0)
        expect(boxes.card.y + boxes.card.height).toBeLessThanOrEqual(400 + 1)
      }
    } finally {
      await page.close()
    }
  }, 45_000)

  it('moves nothing on the page when it appears', async () => {
    const page = await load()
    try {
      const before = await page.evaluate(() => {
        const out: Record<string, number> = {}
        for (const el of document.querySelectorAll('button')) out[el.id] = Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().y)
        return out
      })
      await page.evaluate(() => {
        const ctl = (window as unknown as { ctl: { show(el: HTMLElement): void } }).ctl
        ctl.show(document.getElementById('long') as HTMLElement)
      })
      const after = await page.evaluate(() => {
        const out: Record<string, number> = {}
        for (const el of document.querySelectorAll('button')) out[el.id] = Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().y)
        return out
      })
      expect(after).toEqual(before)
      // Nor can it be clicked instead of what is under it.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.flg-tip') as HTMLElement).pointerEvents)).toBe('none')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('caps a 200-character title at two lines and points at the panel', async () => {
    const page = await load()
    try {
      await page.evaluate(() => {
        const ctl = (window as unknown as { ctl: { show(el: HTMLElement): void } }).ctl
        ctl.show(document.getElementById('long') as HTMLElement)
      })
      const text = (await page.locator('.flg-tip').textContent()) ?? ''
      expect(text).toContain(TOOLTIP_MORE)
      // Two lines at the card's REAL width, measured rather than counted in characters -- the
      // padding is taken off first, because a budget of "two lines" is about the text.
      const lines = await page.evaluate(() => {
        const card = document.querySelector('.flg-tip') as HTMLElement
        const style = getComputedStyle(card)
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        return Math.round((card.getBoundingClientRect().height - padding) / parseFloat(style.lineHeight))
      })
      expect(lines).toBeLessThanOrEqual(2)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('goes away when the pointer moves on, and when Escape is pressed', async () => {
    const page = await load()
    try {
      await page.hover('#fit')
      await page.waitForTimeout(TOOLTIP_DELAY_MS + 250)
      expect(await cardVisible(page)).toBe(1)
      // A hesitation that has ended. The card is not a label, and leaving it up is leaving
      // something in the way.
      await page.mouse.move(400, 300)
      expect(await cardVisible(page)).toBe(0)

      await page.hover('#fit')
      await page.waitForTimeout(TOOLTIP_DELAY_MS + 250)
      expect(await cardVisible(page)).toBe(1)
      await page.keyboard.press('Escape')
      expect(await cardVisible(page)).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('suppresses the native tooltip while hovering, and puts the attribute back afterwards', async () => {
    const page = await load()
    try {
      // Two tooltips for one control is the failure this whole module is avoiding, so the native
      // one is lifted off for exactly as long as the pointer is there.
      await page.hover('#fit')
      expect(await page.locator('#fit').getAttribute('title')).toBeNull()
      await page.mouse.move(400, 300)
      // And it is the author's own sentence, byte for byte -- the text lives on the element,
      // where the language guards and the other tests read it.
      expect(await page.locator('#fit').getAttribute('title')).toBe('Zoom out until every card is on screen at once.')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('has nothing to say about a control with nothing written on it', async () => {
    const page = await load()
    try {
      await page.hover('#bare')
      await page.waitForTimeout(TOOLTIP_DELAY_MS + 250)
      expect(await cardVisible(page)).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)
})
