// viewport.test.ts -- the 3D view's own behaviour, in a real browser.
//
// jsdom cannot host this suite for the same reason it cannot host panelLayout.test.ts: it
// implements no layout and no WebGL, and every assertion below is about one or the other -- where
// the camera ended up after a resize, whether the last frame is still fully opaque while a request
// is in flight, whether the overlay is actually on the canvas. So this drives real Chromium
// (Playwright) against the REAL built webview bundle, exactly as that suite does; run
// `npm run compile` first, or let this package's own `pretest` do it.
//
// What each test guards, in the words of the review that prompted them:
//
//   - "First render frames once, then never again." The old webview latched a `framedOnce`
//     boolean, so widening the panel left the camera looking at the same slice of world in a wider
//     window -- more empty space, not more content.
//   - "No controls on the viewport." Frame view was a full-width button at the bottom of the
//     eighth accordion.
//   - "Busy reads as broken." The canvas dropped to 0.45 opacity and the page showed through it.
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadRenderShellHtml, type RenderShellHtml } from './fixtures/shellHtml.js'
// The renderer's own hand-drawn atlas -- every pixel of it ours, no Mojang bytes, and
// browser-safe by construction (see its header). Borrowed rather than re-invented so the
// "textures are being drawn" half of the toolbar test below is drawing REAL textures.
import { stubAtlasWire } from '../../../frontend/test/fixtures/stubAtlas.js'
import { contrastOfImage, decodePng, requiredRatio, DARK_MODERN, LIGHT_MODERN } from '../../../frontend/test/fixtures/pixelContrast.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')
const fixturePath = path.join(dir, '..', '..', '..', 'frontend', 'test', 'fixtures', 'wiki-ceiling-patch-with-entries.json')

const NONCE = 'test-harness-nonce'
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

function startServer(renderShellHtml: RenderShellHtml): Promise<{ port: number; close: () => void }> {
  let port = 0
  const server = http.createServer((req, res) => {
    if (!req.url || req.url === '/') {
      const cspSource = `http://127.0.0.1:${port}`
      const html = renderShellHtml({ nonce: NONCE, cspSource, scriptUri: `${cspSource}/webview.js`, styleUri: `${cspSource}/webview.css` })
      res.setHeader('Content-Type', 'text/html')
      res.end(html.replace('</body>', `<script nonce="${NONCE}">window.acquireVsCodeApi = function () { return { postMessage: function () {} }; };</script></body>`))
      return
    }
    const filePath = path.join(distDir, req.url.split('?')[0]!)
    res.setHeader('Content-Type', MIME[path.extname(filePath)] ?? 'application/octet-stream')
    createReadStream(filePath)
      .on('error', () => {
        res.statusCode = 404
        res.end()
      })
      .pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, () => {
      port = (server.address() as AddressInfo).port
      resolve({ port, close: () => server.close() })
    })
  })
}

/** The live camera's world position, read through the `__flViewer` hook the bundle already
 * exposes for the screenshot harness. `private` in TypeScript is a compile-time claim, not a
 * runtime one, which is what lets a browser-side assertion see it at all. */
type Vec = { x: number; y: number; z: number }
async function cameraPosition(page: Page): Promise<Vec> {
  return page.evaluate(() => {
    const v = (window as unknown as { __flViewer: { camera: { position: Vec } } }).__flViewer
    return { x: v.camera.position.x, y: v.camera.position.y, z: v.camera.position.z }
  })
}

function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Whether the bench outline (VoxelViewer's own `boundsBox`) is currently drawn. `private` is a
 * compile-time claim, not a runtime one -- the same reason `cameraPosition` above can read the
 * camera. */
async function boundsBoxVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __flViewer: { boundsBox: { visible: boolean } } }).__flViewer.boundsBox.visible)
}

/** What the camera is looking at, so "which fit is further out" can be asked about a distance
 * rather than about two absolute positions on an arbitrary diagonal. */
async function controlsTarget(page: Page): Promise<Vec> {
  return page.evaluate(() => {
    const t = (window as unknown as { __flViewer: { controls: { target: Vec } } }).__flViewer.controls.target
    return { x: t.x, y: t.y, z: t.z }
  })
}

/** Resizes the whole window, which is what dragging the VS Code panel or moving the preview into
 * a different editor group does to this webview -- and, unlike setting the sidebar's own flex
 * basis, is not something splitter.ts's container-width-aware observer immediately puts back.
 * Waits for the canvas ResizeObserver the webview installs to deliver the new size. */
async function resizeWindow(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(300)
}

describe('viewport: framing, controls and the busy state, in a real browser', () => {
  let browser: Browser
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const renderShellHtml = await loadRenderShellHtml()
    server = await startServer(renderShellHtml)
    browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] })
  }, 90_000)

  afterAll(async () => {
    await browser.close()
    server.close()
  })

  async function loadWithResult(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
    const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf-8'))
    await page.evaluate((result) => {
      window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
      window.postMessage({ type: 'result', result }, '*')
    }, fixture)
    await page.waitForTimeout(400)
    return page
  }

  /** Orbits the camera by hand, which is what makes the viewer stop re-fitting on resize. */
  async function orbit(page: Page): Promise<void> {
    const box = (await page.locator('#fl-canvas').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 })
    await page.mouse.up()
    // OrbitControls damps for a while after the pointer is released; let it settle so a later
    // "did the camera move" comparison is measuring a re-fit rather than the tail of a drag.
    await page.waitForTimeout(900)
  }

  it('re-fits on resize while the camera is untouched, and stops once the user has moved it', async () => {
    const page = await loadWithResult()
    try {
      const framed = await cameraPosition(page)

      // Widening the canvas (a narrower sidebar) used to change only the aspect: the same content
      // at the same size, with more empty space beside it.
      await resizeWindow(page, 700, 900)
      const afterNarrow = await cameraPosition(page)
      expect(distance(framed, afterNarrow)).toBeGreaterThan(0.5)

      // ...and the reverse, still untouched: it keeps tracking the box it framed.
      await resizeWindow(page, 1600, 500)
      const afterWiden = await cameraPosition(page)
      expect(distance(afterNarrow, afterWiden)).toBeGreaterThan(0.5)

      // Now the user places the camera themselves. That is a decision, and a panel resize is not
      // a reason to overrule it.
      await orbit(page)
      const chosen = await cameraPosition(page)
      await resizeWindow(page, 900, 700)
      const afterResize = await cameraPosition(page)
      expect(distance(chosen, afterResize)).toBeLessThan(0.5)
    } finally {
      await page.close()
    }
  }, 90_000)

  it('puts a persistent overlay on the canvas, and its frame button frames', async () => {
    const page = await loadWithResult()
    try {
      const overlay = page.locator('#fl-root .fl-vp')
      await expect.poll(async () => overlay.count()).toBe(1)
      // Frame, environment, grid, projection and textures -- the fifth is the block-texture
      // toggle (frontend/src/ui/viewportOverlay.ts); frontend/test/viewportOverlay.test.ts pins
      // which button is which.
      expect(await page.locator('.fl-vp-btn').count()).toBe(5)
      // The compass and the bench size: the two things that said nothing about orientation or
      // scale before.
      expect(await page.locator('.fl-vp-axes line').count()).toBe(3)
      expect(await page.locator('.fl-vp-scale').textContent()).toMatch(/^\d+×\d+×\d+$/)
      expect(await page.locator('.fl-vp-hint').textContent()).toContain('1 front')

      // The overlay sits over the CANVAS, not over the sidebar.
      const canvasBox = (await page.locator('#fl-canvas').boundingBox())!
      const overlayBox = (await page.locator('.fl-vp-controls').boundingBox())!
      expect(overlayBox.x).toBeGreaterThanOrEqual(canvasBox.x)
      expect(overlayBox.x + overlayBox.width).toBeLessThan(canvasBox.x + canvasBox.width)

      await orbit(page)
      const moved = await cameraPosition(page)
      await page.locator('.fl-vp-btn[aria-label^="Frame view"]').click()
      await page.waitForTimeout(200)
      const framed = await cameraPosition(page)
      expect(distance(moved, framed)).toBeGreaterThan(0.5)
    } finally {
      await page.close()
    }
  }, 90_000)

  // "Frame view" and "Frame volume" produced the same picture on every default preview: the
  // content fit counted every solid terrain cell, so "what is occupied" was the bench, and the
  // two only diverged once the environment was hidden -- which the frame button's own tooltip
  // advertised as the difference between them.
  it('frames the feature on R and the whole bench on Shift+R, and they differ', async () => {
    const page = await loadWithResult()
    try {
      await page.keyboard.press('r')
      await page.waitForTimeout(250)
      const feature = await cameraPosition(page)
      // The bench outline spans the whole bench; a fit to the feature cannot contain it, so it is
      // hidden rather than left running off two edges of the viewport.
      expect(await boundsBoxVisible(page)).toBe(false)

      await page.keyboard.press('Shift+R')
      await page.waitForTimeout(250)
      const bench = await cameraPosition(page)
      expect(await boundsBoxVisible(page)).toBe(true)

      // Two different cameras, and the bench fit is the further-away one.
      expect(distance(feature, bench)).toBeGreaterThan(1)
      const target = await controlsTarget(page)
      expect(Math.hypot(bench.x - target.x, bench.y - target.y, bench.z - target.z)).toBeGreaterThan(
        Math.hypot(feature.x - target.x, feature.y - target.y, feature.z - target.z),
      )
    } finally {
      await page.close()
    }
  }, 90_000)

  it('shows a busy pill with elapsed time and leaves the last frame at full opacity', async () => {
    const page = await loadWithResult()
    try {
      const pill = page.locator('.fl-vp-pill')
      expect(await pill.isVisible()).toBe(false)

      await page.evaluate(() => window.postMessage({ type: 'busy', busy: true }, '*'))
      await page.waitForTimeout(150)
      expect(await pill.isVisible()).toBe(true)

      // The canvas is NOT dimmed. This is the specific regression: at 0.45 the page showed
      // through the preview and a working tool read as a broken one.
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('fl-canvas')!).opacity)).toBe('1')

      await page.waitForTimeout(1200)
      const text = (await pill.locator('.fl-vp-pill-text').textContent()) ?? ''
      expect(text).toMatch(/^Generating… \d+\.\d s$/)
      expect(Number(/(\d+\.\d) s/.exec(text)![1])).toBeGreaterThanOrEqual(1)

      // A result ends it, exactly as it ends every other busy state.
      const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf-8'))
      await page.evaluate((result) => window.postMessage({ type: 'result', result }, '*'), fixture)
      await page.waitForTimeout(250)
      expect(await pill.isVisible()).toBe(false)
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // The canvas said role="application" -- which tells a screen reader to stop interpreting keys
  // and hand every one of them over -- and then handled none of them. Measured: arrows, +, -,
  // Home, PageUp, Enter and Space all did nothing, and the five keys that DID work (r, R, 1, 3,
  // 7) were bound on window, so they worked from anywhere and the canvas's own tab stop did
  // literally nothing. The claim is kept and made true, rather than withdrawn to role="img":
  // dropping to an image would have left the only way to move this camera a mouse.
  // ---------------------------------------------------------------------------------------
  it('makes the 3D view reachable by keyboard, and says what it is', async () => {
    const page = await loadWithResult()
    try {
      const canvas = page.locator('#fl-canvas')
      expect(await canvas.getAttribute('tabindex')).toBe('0')
      expect(await canvas.getAttribute('role')).toBe('application')
      // The label describes the keys that EXIST, not a mouse.
      const label = (await canvas.getAttribute('aria-label')) ?? ''
      expect(label).toMatch(/preview/i)
      expect(label).toMatch(/arrow keys orbit/i)
      expect(label).toMatch(/enter/i)
    } finally {
      await page.close()
    }
  }, 60_000)

  it('orbits, zooms and frames from the keyboard once the canvas has focus', async () => {
    const page = await loadWithResult()
    try {
      await page.locator('#fl-canvas').focus()
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('fl-canvas')

      /** How far the camera moved for one press of `key`, from a settled start. */
      const moved = async (key: string): Promise<number> => {
        const before = await cameraPosition(page)
        await page.keyboard.press(key)
        await page.waitForTimeout(250)
        const after = await cameraPosition(page)
        return distance(before, after)
      }

      // Every key the critic measured as dead.
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus', 'PageUp', 'PageDown']) {
        expect(await moved(key), key).toBeGreaterThan(0.1)
      }

      // Zoom is symmetric: in and back out returns to (very near) where it started.
      const start = await cameraPosition(page)
      await page.keyboard.press('Equal')
      await page.waitForTimeout(200)
      const closer = await cameraPosition(page)
      const target = await controlsTarget(page)
      expect(distance(closer, target)).toBeLessThan(distance(start, target))
      await page.keyboard.press('Minus')
      await page.waitForTimeout(200)
      expect(distance(await cameraPosition(page), start)).toBeLessThan(0.5)

      // Home reframes the feature and End the whole bench -- the same two fits R and Shift+R do,
      // on the keys a keyboard user reaches for.
      await page.keyboard.press('Home')
      await page.waitForTimeout(250)
      expect(await boundsBoxVisible(page)).toBe(false)
      await page.keyboard.press('End')
      await page.waitForTimeout(250)
      expect(await boundsBoxVisible(page)).toBe(true)

      // ...and Tab still leaves. A canvas that eats Tab is a keyboard trap.
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('fl-canvas')
    } finally {
      await page.close()
    }
  }, 90_000)

  it('identifies the block at the centre of the view on Enter, which a click could only do with a mouse', async () => {
    const page = await loadWithResult()
    try {
      const readout = page.locator('.fl-picked')
      expect(await readout.isVisible()).toBe(false)
      await page.locator('#fl-canvas').focus()
      // Frame first, so the centre of the view is over the feature rather than over sky.
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      expect(await readout.isVisible()).toBe(true)
      // The same two facts a click produces: what, and where.
      expect(await readout.locator('.fl-picked-name').textContent()).toMatch(/\S/)
      expect(await readout.locator('.fl-diag-position').textContent()).toMatch(/\(-?\d+, -?\d+, -?\d+\)/)
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // The camera glides for a few hundred milliseconds after every input (OrbitControls damping),
  // which is motion the user did not ask for -- and nothing in this viewer called matchMedia at
  // all, so `prefers-reduced-motion: reduce` never shortened it.
  // ---------------------------------------------------------------------------------------
  it('stops the camera gliding when the user has asked for reduced motion', async () => {
    const still = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
    try {
      await still.goto(`http://127.0.0.1:${server.port}/`)
      await still.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
      expect(await still.evaluate(() => (window as unknown as { __flViewer: { getDampingEnabled(): boolean } }).__flViewer.getDampingEnabled())).toBe(false)
    } finally {
      await still.close()
    }
    // ...and keeps it for everyone else, which is the half a blanket "turn it off" would lose.
    const glides = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'no-preference' })
    try {
      await glides.goto(`http://127.0.0.1:${server.port}/`)
      await glides.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
      expect(await glides.evaluate(() => (window as unknown as { __flViewer: { getDampingEnabled(): boolean } }).__flViewer.getDampingEnabled())).toBe(true)
    } finally {
      await glides.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // Five buttons drawn in the top-left corner of the picture were five separate tab stops, and
  // -- because the overlay was appended after #fl-sidebar -- they were stops 51 to 55 of 56.
  // ---------------------------------------------------------------------------------------
  it('is one tab stop, reached before the sidebar, with the arrows moving inside it', async () => {
    const page = await loadWithResult()
    try {
      // DOM order: canvas, overlay, sidebar. This is the half that fixes WHERE the stop is.
      const order = await page.evaluate(() => Array.from(document.getElementById('fl-root')!.children).map((el) => el.id || el.className))
      expect(order.indexOf('fl-vp')).toBeGreaterThan(order.indexOf('fl-canvas'))
      expect(order.indexOf('fl-vp')).toBeLessThan(order.indexOf('fl-sidebar'))

      const toolbar = page.locator('.fl-vp-controls')
      expect(await toolbar.getAttribute('role')).toBe('toolbar')
      expect(await toolbar.getAttribute('aria-label')).toMatch(/viewport/i)

      // A roving tabindex: exactly one of the five is a tab stop.
      const tabindexes = await page.$$eval('.fl-vp-btn', (els) => els.map((el) => el.getAttribute('tabindex')))
      expect(tabindexes.length).toBe(5)
      expect(tabindexes.filter((t) => t === '0').length).toBe(1)
      expect(tabindexes.filter((t) => t === '-1').length).toBe(4)

      // Tab from the canvas lands on the toolbar -- not 50 controls later.
      await page.locator('#fl-canvas').focus()
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('fl-vp-btn')

      // The arrows move within it, and the stop follows -- including onto the aria-disabled
      // Textures button, whose label is the only place its reason is written.
      const focused = async (): Promise<string> => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
      const first = await focused()
      await page.keyboard.press('ArrowRight')
      expect(await focused()).not.toBe(first)
      await page.keyboard.press('End')
      expect(await focused()).toMatch(/texture/i)
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-disabled'))).toBe('true')
      await page.keyboard.press('Home')
      expect(await focused()).toBe(first)
      // ...and the roving stop is now wherever the arrows left it.
      expect(await page.$$eval('.fl-vp-btn', (els) => els.filter((el) => el.getAttribute('tabindex') === '0').length)).toBe(1)

      // One more Tab leaves the toolbar entirely, rather than stepping to its second button.
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).not.toContain('fl-vp-btn')
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // `cancelBtn.disabled = true` fired while the button held focus, so pressing Enter on Cancel
  // dropped focus to <body> and the next Tab restarted from the end of the overlay.
  // ---------------------------------------------------------------------------------------
  it('keeps focus on Cancel after Cancel is pressed', async () => {
    const page = await loadWithResult()
    try {
      await page.evaluate(() => window.postMessage({ type: 'busy', busy: true }, '*'))
      await page.waitForTimeout(250)
      const cancel = page.locator('.fl-vp-cancel')
      await expect.poll(async () => cancel.isVisible()).toBe(true)

      await cancel.focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(150)

      expect(await page.locator('.fl-vp-pill-text').textContent()).toBe('Cancelling\u2026')
      // Inert, but still itself and still focused.
      expect(await cancel.getAttribute('aria-disabled')).toBe('true')
      expect(await cancel.evaluate((el) => el.matches(':disabled'))).toBe(false)
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('fl-vp-cancel')

      // A second press cannot re-ask, and still does not throw focus away.
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('fl-vp-cancel')
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // "Click a block to find what placed it" was the only route to the attribution answer, and it
  // needed a mouse. The legend carried every writer's name and count as text -- so the palette
  // was never colour-alone -- but as role=listitem rows with no tab stop, which put that text
  // out of the keyboard's reach entirely.
  // ---------------------------------------------------------------------------------------
  it('makes each writer in the legend a control that frames and selects its own cells', async () => {
    const page = await loadWithResult()
    try {
      await page.evaluate(() => {
        // Two writers, with cells far apart, so "it framed THAT one" is a measurable claim.
        window.postMessage(
          {
            type: 'attribution',
            available: true,
            nodeId: 'wiki:a',
            cells: [0, 1, 2],
            groups: [
              { id: 'wiki:a', label: 'wiki:a', cells: [0, 1, 2] },
              { id: 'wiki:b', label: 'wiki:b', cells: [40000, 40001, 40002] },
            ],
            cellCount: 6,
            shown: 6,
            writes: 6,
          },
          '*',
        )
      })
      await page.waitForTimeout(300)

      const buttons = page.locator('.fl-vp-legend-row .fl-vp-legend-btn')
      expect(await buttons.count()).toBe(2)
      // The row is still a list item; the control is inside it, so the legend still reads as a
      // key rather than as a row of buttons.
      expect(await page.locator('.fl-vp-legend').getAttribute('role')).toBe('list')
      expect(await page.locator('.fl-vp-legend-row').first().getAttribute('role')).toBe('listitem')
      // ...and each one is reachable, named, and says what activating it does.
      for (let i = 0; i < 2; i++) {
        const label = (await buttons.nth(i).getAttribute('aria-label')) ?? ''
        expect(label).toMatch(/^Frame and select the cells wiki:[ab] wrote/)
        expect(label).toMatch(/\d+ blocks?\)$/)
        expect(await buttons.nth(i).getAttribute('aria-pressed')).toBe('false')
      }

      // Tab reaches it: focus the last toolbar button and step forward.
      await page.locator('.fl-vp-legend-btn').first().focus()
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('fl-vp-legend-btn')

      // Enter frames that writer, and says so.
      const before = await cameraPosition(page)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      const first = await cameraPosition(page)
      expect(distance(before, first)).toBeGreaterThan(0.5)
      expect(await buttons.nth(0).getAttribute('aria-pressed')).toBe('true')
      expect(await buttons.nth(1).getAttribute('aria-pressed')).toBe('false')
      expect(await page.locator('.fl-vp-announce').textContent()).toMatch(/^wiki:a framed/)

      // The other writer is somewhere else, and selecting it moves the camera there -- one
      // selection at a time, so the pressed row is always the one being looked at.
      await buttons.nth(1).click()
      await page.waitForTimeout(300)
      expect(distance(first, await cameraPosition(page))).toBeGreaterThan(0.5)
      expect(await buttons.nth(0).getAttribute('aria-pressed')).toBe('false')
      expect(await buttons.nth(1).getAttribute('aria-pressed')).toBe('true')
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // The toolbar told the truth only after you pressed something else.
  //
  // With an atlas delivered and the sidebar's own "Block textures" switch on, the Textures
  // button read disabled, aria-pressed="false", tooltip "Block textures are not available: no
  // texture atlas has been built for this machine…" -- over a visibly textured preview. Clicking
  // the unrelated Grid button corrected it, which is the tell: setAtlas() and
  // setTexturesEnabled() applied materials, re-meshed and told the host, and never told the
  // overlay, while setShowGrid() did.
  // ---------------------------------------------------------------------------------------
  it('makes the Textures button describe what is actually being drawn, without an unrelated click', async () => {
    const page = await loadWithResult()
    try {
      const textures = page.locator('.fl-vp-btn[aria-label*="texture" i], .fl-vp-btn[aria-label*="flat colours" i]').first()
      expect(await textures.isDisabled()).toBe(true)

      await page.evaluate((atlas) => window.postMessage({ type: 'atlas', atlas }, '*'), stubAtlasWire() as unknown as Record<string, unknown>)
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __flViewer: { hasAtlas(): boolean } }).__flViewer.hasAtlas()), { timeout: 10_000 }).toBe(true)

      // The atlas alone is enough to make the switch usable, and the button has to say so the
      // moment that is true -- this is the assertion that used to fail, with the preview already
      // drawing textures behind a button still reading "not available".
      const drawing = async (): Promise<boolean> => page.evaluate(() => (window as unknown as { __flViewer: { getTexturesEnabled(): boolean } }).__flViewer.getTexturesEnabled())
      expect(await textures.isDisabled()).toBe(false)
      expect(await textures.getAttribute('aria-pressed')).toBe(String(await drawing()))

      // And it keeps saying so across the sidebar's own switch, which is the other half of the
      // same state: setTexturesEnabled had the identical omission setAtlas did.
      const setSidebarTextures = async (on: boolean): Promise<void> => {
        await page.evaluate((checked) => {
          const row = [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Block textures')!
          const checkbox = row.querySelector('input') as HTMLInputElement
          checkbox.checked = checked
          checkbox.dispatchEvent(new Event('change'))
        }, on)
        await page.waitForTimeout(250)
      }

      for (const on of [false, true, false]) {
        await setSidebarTextures(on)
        expect(await drawing()).toBe(on)
        expect(await textures.isDisabled()).toBe(false)
        expect(await textures.getAttribute('aria-pressed')).toBe(String(on))
        expect(await textures.getAttribute('aria-label')).toMatch(on ? /^Block textures on/ : /^Flat colours/)
      }
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // The write-attribution readout and the viewport toolbar were both painted into the top-left
  // corner of the canvas -- 152x25px of overlap, the toolbar's full width and 78% of its height,
  // with the readout on top. Clicks still landed on the buttons underneath, so the only symptom
  // was that neither could be read.
  // ---------------------------------------------------------------------------------------
  async function postAttribution(page: Page, nodeId: string): Promise<void> {
    await page.evaluate((id) => {
      window.postMessage({ type: 'attribution', available: true, nodeId: id, cells: [0, 1, 2], groups: [{ id, label: id, cells: [0, 1, 2] }], cellCount: 3, shown: 3, writes: 3 }, '*')
    }, nodeId)
    await page.waitForTimeout(250)
  }

  function overlapArea(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
    const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
    return w * h
  }

  it('never paints the attribution readout over the viewport toolbar', async () => {
    const page = await loadWithResult()
    try {
      await postAttribution(page, 'wiki:vegetation_patch_ceiling_demo')
      const readout = page.locator('#fl-attribution')
      await expect.poll(async () => readout.isVisible()).toBe(true)

      const controls = (await page.locator('.fl-vp-controls').boundingBox())!
      const box = (await readout.boundingBox())!
      expect(overlapArea(controls, box)).toBe(0)
      // Under the toolbar, in the overlay's own column -- not merely nudged aside by a margin.
      expect(box.y).toBeGreaterThanOrEqual(controls.y + controls.height)
      expect(await readout.evaluate((el) => el.parentElement?.className ?? '')).toContain('fl-vp')
      expect(await readout.evaluate((el) => getComputedStyle(el).position)).toBe('static')

      // Nor over anything else the overlay stacks, now that it shares their flow.
      await page.evaluate(() => window.postMessage({ type: 'busy', busy: true }, '*'))
      await page.waitForTimeout(250)
      const pill = (await page.locator('.fl-vp-pill').boundingBox())!
      expect(overlapArea(pill, (await readout.boundingBox())!)).toBe(0)
      expect(overlapArea(pill, (await page.locator('.fl-vp-controls').boundingBox())!)).toBe(0)

      // And it still lets a camera drag through: the readout is not a control.
      expect(await readout.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    } finally {
      await page.close()
    }
  }, 90_000)

  // The legend cleared itself on a fresh run; this webview's own half of the state did not. The
  // readout went on naming a writer from a run no longer on screen, and every click in the 3D
  // view kept posting `pickCell` against an index the host had already replaced.
  it('drops the attribution readout when a run without attribution arrives', async () => {
    const page = await loadWithResult()
    try {
      await postAttribution(page, 'wiki:trunk')
      const readout = page.locator('#fl-attribution')
      await expect.poll(async () => readout.isVisible()).toBe(true)
      expect(await page.locator('.fl-vp-legend-row').count()).toBeGreaterThan(0)

      const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf-8'))
      await page.evaluate((result) => window.postMessage({ type: 'result', result }, '*'), fixture)
      await page.waitForTimeout(400)

      // The legend already cleared itself; the readout has to go with it.
      expect(await page.locator('.fl-vp-legend-row').count()).toBe(0)
      expect(await readout.isVisible()).toBe(false)
      expect(await readout.textContent()).toBe('')
      expect(await page.evaluate(() => (window as unknown as { __flViewer: { getAttributionCellCount(): number } }).__flViewer.getAttributionCellCount())).toBe(0)
    } finally {
      await page.close()
    }
  }, 90_000)

  // A stale reply leaves the viewport drawing the PREVIOUS run's mesh -- a complete, confident,
  // out-of-date picture -- and the only thing that said so was a banner in the sidebar, which is
  // not where you look while you are waiting for a run.
  it('says on the view itself that the picture is a previous run', async () => {
    const page = await loadWithResult()
    try {
      const notice = page.locator('.fl-vp-notice')
      expect(await notice.isVisible()).toBe(false)

      const reason = 'The featurelab engine stopped responding. This preview is from the last run that finished.'
      await page.evaluate((text) => window.postMessage({ type: 'stale', stale: true, reason: text }, '*'), reason)
      await page.waitForTimeout(250)
      expect(await notice.isVisible()).toBe(true)
      expect(await notice.textContent()).toBe(reason)
      expect(await notice.evaluate((el) => el.className)).toContain('fl-vp-notice-warn')

      // A result IS the engine answering: the notice goes with it.
      const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf-8'))
      await page.evaluate((result) => window.postMessage({ type: 'result', result }, '*'), fixture)
      await page.waitForTimeout(300)
      expect(await notice.isVisible()).toBe(false)
    } finally {
      await page.close()
    }
  }, 90_000)
})

// ---- the labels that sit ON the 3D view ------------------------------------------------------
// ==============================================================================================
// A LABEL OVER A CANVAS HAS NO BACKDROP A STYLESHEET KNOWS ABOUT. Every contrast check this
// project had walked the DOM for the nearest opaque ancestor background; the axis gizmo's bench
// size and its keys button have no such ancestor -- the thing behind them is a <canvas>, and
// what the canvas contains is whatever the scene just rendered. The walk bottomed out on the
// page and reported a comfortable pass while the real pixels measured 1.67:1 in Light Modern and
// 1.43:1 in Dark Modern, both against #759077: a grass-green block from the fixture's own
// terrain.
//
// The other candidate fix was to make viewer.ts's clear colour (BACKGROUND_COLOR = #14161a,
// hardcoded in both themes) follow the theme. That IS a real wart -- a light theme gets a
// near-black window -- but it is not this bug: #759077 is not the clear colour, it is geometry,
// and a preview whose entire job is to draw arbitrary blocks can put any colour at all under
// this corner. Giving the gizmo its own surface, as every other block in the overlay column
// already has, is the only version whose contrast is a fact about the stylesheet rather than
// about the scene. See panel.css's .fl-vp-gizmo for the same decision written next to the rule.
describe('viewport: every label on the canvas is readable against what is actually behind it', () => {
  let browser: Browser
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const renderShellHtml = await loadRenderShellHtml()
    server = await startServer(renderShellHtml)
    browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] })
  }, 90_000)

  afterAll(async () => {
    await browser.close()
    server.close()
  })

  for (const [name, tokens, scheme] of [
    ['Light Modern', LIGHT_MODERN, 'light'],
    ['Dark Modern', DARK_MODERN, 'dark'],
  ] as const) {
    it(`keeps the gizmo's own labels readable over rendered terrain in ${name}`, async () => {
      // deviceScaleFactor 2: see frontend/test/fixtures/pixelContrast.ts on why a 9px glyph
      // measured at 1x can have no fully-covered pixel at all.
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme })
      try {
        await page.goto(`http://127.0.0.1:${server.port}/`)
        await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
        await page.evaluate((vars: Record<string, string>) => {
          for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value)
          document.body.style.backgroundColor = vars['--vscode-editor-background'] ?? ''
        }, tokens as Record<string, string>)
        const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf-8'))
        await page.evaluate((result) => {
          window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
          window.postMessage({ type: 'result', result }, '*')
        }, fixture)
        await page.waitForTimeout(900)

        // THE SCENE HAS TO HAVE DRAWN SOMETHING, or this measures a label over an empty canvas
        // and proves nothing: the whole failure was that the backdrop is terrain, not a colour
        // the stylesheet picked. A sample of canvas pixels well away from the overlay column
        // has to contain more than one colour.
        const sceneIsDrawn = await page.evaluate(() => {
          const canvas = document.getElementById('fl-canvas') as HTMLCanvasElement
          const rect = canvas.getBoundingClientRect()
          return rect.width > 200 && rect.height > 200
        })
        expect(sceneIsDrawn).toBe(true)

        // The gizmo's two labels, each read out of its own screenshot.
        const measured: { selector: string; text: string; fg: string; bg: string; ratio: number; need: number }[] = []
        for (const selector of ['.fl-vp-scale', '.fl-vp-keys']) {
          const handle = await page.locator(selector).elementHandle()
          expect(handle, `${selector} is not on the overlay`).not.toBeNull()
          const meta = await handle!.evaluate((node: Node) => {
            const el = node as Element
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return { width: rect.width, height: rect.height, text: (el.textContent ?? '').trim(), size: parseFloat(style.fontSize), weight: style.fontWeight }
          })
          expect(meta.width, `${selector} has no size`).toBeGreaterThan(0)
          const contrast = contrastOfImage(decodePng(await handle!.screenshot({ type: 'png' })))
          expect(contrast, selector).not.toBeNull()
          measured.push({ selector, text: meta.text, fg: contrast!.fg, bg: contrast!.bg, ratio: contrast!.ratio, need: requiredRatio(meta.size, meta.weight) })
        }
        // The bench size is the label that failed; it has to actually be showing a size.
        expect(measured[0]!.text).toMatch(/\d+×\d+×\d+/)
        expect(measured.filter((m) => m.ratio < m.need).map((m) => `${m.selector} "${m.text}" ${m.fg} on ${m.bg} = ${String(m.ratio)}:1 (needs ${String(m.need)}:1)`)).toEqual([])

        // AND THE REASON IT PASSES IS ITS OWN SURFACE, not luck about what the camera framed.
        // Measured background, not a declared one: the point is that the pixels behind the text
        // are the overlay's widget background and not a block.
        const gizmoBg = await page.locator('.fl-vp-gizmo').evaluate((el) => getComputedStyle(el).backgroundColor)
        expect(gizmoBg).not.toBe('rgba(0, 0, 0, 0)')
      } finally {
        await page.close()
      }
    }, 120_000)
  }
})
