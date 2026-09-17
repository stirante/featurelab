// splitterLayout.test.ts -- real-Chromium-layout coverage for the resizable/collapsible
// sidebar splitter (frontend/src/ui/splitter.ts, createSplitter -- called from webview/
// main.ts exactly like the real extension) added for the "preview is tiny" fix: the sidebar
// used to be a hardcoded `flex: 0 0 320px`/`340px` in each host's own CSS regardless of how
// narrow the actual host window/column/side-panel was (measured, not guessed -- see
// splitter.ts's own header comment for the exact before/after numbers). This file drives the SAME real webview bundle panelLayout.test.ts does (see
// that file's own header comment on why jsdom cannot catch this class of bug at all -- it
// reports zero for every layout measurement) and asserts on real pixel geometry: the drag
// clamp bounds, the collapse/expand toggle, persistence across a reload, and the
// container-width-aware live clamp that keeps the canvas from being squeezed below
// MIN_CANVAS_WIDTH even without a drag (e.g. the VS Code panel itself being dragged narrower,
// or this view being moved from the editor area to a narrow side panel).
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import { createReadStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_CANVAS_WIDTH } from 'featurelab-frontend'
import { loadRenderShellHtml, type RenderShellHtml } from './fixtures/shellHtml.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')

// Served HTML comes from the REAL apps/vscode/src/previewPanel.ts::renderShellHtml() (see
// test/fixtures/shellHtml.ts and panelLayout.test.ts's own comment on the same setup) --
// webview.js's module-scope code calls the real createSplitter() against these exact ids the
// moment it loads, exactly like the real extension host page does, and this harness now
// genuinely enforces the real CSP meta tag the same way real VS Code does.
const NONCE = 'test-harness-nonce'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

function startServer(renderShellHtml: RenderShellHtml): Promise<{ port: number; close: () => void }> {
  let port = 0
  const server = http.createServer((req, res) => {
    if (!req.url || req.url === '/') {
      const cspSource = `http://127.0.0.1:${port}`
      const html = renderShellHtml({
        nonce: NONCE,
        cspSource,
        scriptUri: `${cspSource}/webview.js`,
        styleUri: `${cspSource}/webview.css`,
      })
      const withBootstrap = html.replace(
        '</body>',
        `<script nonce="${NONCE}">window.acquireVsCodeApi = function () { return { postMessage: function () {} }; };</script></body>`,
      )
      res.setHeader('Content-Type', 'text/html')
      res.end(withBootstrap)
      return
    }
    const filePath = path.join(distDir, req.url.split('?')[0]!)
    const ext = path.extname(filePath)
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
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

async function sidebarWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementById('fl-sidebar')!.getBoundingClientRect().width)
}
async function canvasWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementById('fl-canvas')!.getBoundingClientRect().width)
}

/** Drags the splitter by `dxPixels` (positive = right = shrink the sidebar, since the sidebar
 * sits to its right -- see splitter.ts's own pointermove comment). Grabs the handle well away
 * from its vertically-centered collapse/expand toggle button (which visually overflows the
 * splitter's own narrow track), the same care camera_survives.mjs's own manual verification
 * needs. */
async function dragSplitter(page: Page, dxPixels: number): Promise<void> {
  const box = (await page.locator('.fl-splitter').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 80
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dxPixels, y, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(100)
}

describe('splitter.ts real-layout: resizable/collapsible sidebar', () => {
  let browser: Browser
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const renderShellHtml = await loadRenderShellHtml()
    server = await startServer(renderShellHtml)
    browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] })
  }, 60_000)

  afterAll(async () => {
    await browser.close()
    server.close()
  })

  async function freshPage(viewport: { width: number; height: number } = { width: 1400, height: 900 }): Promise<Page> {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForSelector('.fl-splitter', { timeout: 10_000 })
    return page
  }

  it('defaults to DEFAULT_SIDEBAR_WIDTH on a first-ever run (nothing persisted)', async () => {
    const page = await freshPage()
    try {
      expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_SIDEBAR_WIDTH, 0)
    } finally {
      await page.close()
    }
  }, 20_000)

  it('a drag past the floor clamps to MIN_SIDEBAR_WIDTH, never below it', async () => {
    const page = await freshPage()
    try {
      await dragSplitter(page, 5000) // absurdly large shrink drag
      expect(await sidebarWidth(page)).toBeCloseTo(MIN_SIDEBAR_WIDTH, 0)
    } finally {
      await page.close()
    }
  }, 20_000)

  it('a drag past the ceiling clamps to MAX_SIDEBAR_WIDTH, never above it', async () => {
    const page = await freshPage()
    try {
      await dragSplitter(page, -5000) // absurdly large grow drag (negative dx = left = grow)
      expect(await sidebarWidth(page)).toBeCloseTo(MAX_SIDEBAR_WIDTH, 0)
    } finally {
      await page.close()
    }
  }, 20_000)

  it('the canvas never shrinks below MIN_CANVAS_WIDTH even in a very narrow host window, without any drag at all', async () => {
    // A host window narrow enough that DEFAULT_SIDEBAR_WIDTH alone would leave less than
    // MIN_CANVAS_WIDTH for the canvas if nothing re-clamped it live -- this is the exact "VS
    // Code panel dragged narrow" / "view moved to a narrow side panel" case, reproduced without ever touching the splitter.
    const page = await freshPage({ width: 420, height: 700 })
    try {
      expect(await canvasWidth(page)).toBeGreaterThanOrEqual(MIN_CANVAS_WIDTH - 1)
      expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH - 1)
    } finally {
      await page.close()
    }
  }, 20_000)

  it('clicking the toggle collapses the sidebar to full-width canvas, and clicking again restores it', async () => {
    const page = await freshPage()
    try {
      const widthBefore = await sidebarWidth(page)
      await page.locator('.fl-splitter-toggle').click()
      await page.waitForTimeout(100)
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('fl-sidebar')!).display)).toBe('none')
      const canvasWhenCollapsed = await canvasWidth(page)
      const rootWidth = await page.evaluate(() => document.getElementById('fl-root')!.getBoundingClientRect().width)
      expect(canvasWhenCollapsed).toBeGreaterThan(rootWidth - 40) // full width minus just the slim splitter strip

      await page.locator('.fl-splitter-toggle').click()
      await page.waitForTimeout(100)
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('fl-sidebar')!).display)).not.toBe('none')
      expect(await sidebarWidth(page)).toBeCloseTo(widthBefore, 0)
    } finally {
      await page.close()
    }
  }, 20_000)

  it('persists a dragged width and a collapsed state across a full page reload, same as panel.ts persists section-open/closed state', async () => {
    const page = await freshPage()
    try {
      await dragSplitter(page, 60) // shrink by a modest, unclamped amount
      const draggedWidth = await sidebarWidth(page)
      await page.locator('.fl-splitter-toggle').click() // collapse
      await page.waitForTimeout(100)

      await page.reload()
      await page.waitForSelector('.fl-splitter', { timeout: 10_000 })

      expect(await page.evaluate(() => getComputedStyle(document.getElementById('fl-sidebar')!).display)).toBe('none')
      await page.locator('.fl-splitter-toggle').click() // expand again
      await page.waitForTimeout(100)
      expect(await sidebarWidth(page)).toBeCloseTo(draggedWidth, 0)
    } finally {
      await page.close()
    }
  }, 20_000)
})
