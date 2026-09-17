// webviewShell.test.ts -- the CSP regression test for the "webview layout collapses in real
// VS Code" bug. previewPanel.ts's real HTML generator (renderShellHtml, see that export's own
// doc comment in src/previewPanel.ts) used to emit `style-src ${cspSource}` with no
// 'unsafe-inline' and no nonce on the inline <style> element that lays #fl-root out as a flex
// row (#fl-canvas flexing to fill the remaining width, #fl-sidebar beside it at a fixed basis).
// Real VS Code's CSP enforcement silently drops that whole <style> block when it isn't covered
// by the policy, so #fl-root falls back to being a plain block-level div: #fl-canvas renders at
// a bare <canvas> element's intrinsic 300x150 in the top-left corner, and #fl-sidebar stacks
// below it as a full-width block instead of sitting beside it. The user photographed exactly
// this in real VS Code.
//
// This suite gets its HTML from the REAL renderShellHtml() (test/fixtures/shellHtml.ts bundles
// src/previewPanel.ts directly, stubbing only its 'vscode' import) with a genuine
// `<meta http-equiv="Content-Security-Policy">` tag, which Playwright's Chromium actually
// enforces -- unlike the hand-copied HARNESS_HTML duplicates panelLayout.test.ts and
// splitterLayout.test.ts used to each carry (no CSP tag at all), which is exactly how this bug
// survived several rounds of "verified by screenshot": nothing in the old harnesses could ever
// have exercised a CSP violation in the first place.
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import { createReadStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { loadRenderShellHtml, type RenderShellHtml } from './fixtures/shellHtml.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

// The nonce is a value WE choose and pass into the real renderShellHtml() (it's a pure function
// of its params -- see that export's own doc comment), so we can also stamp the SAME nonce onto
// the one bit of glue script this harness needs that a real VS Code webview would never need
// (window.acquireVsCodeApi -- real VS Code injects that global itself; nothing here is exempt
// from the meta CSP tag's script-src, so without a matching nonce this bootstrap script would
// be blocked exactly like the unnonced <style> block used to be).
const NONCE = 'test-harness-nonce'

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

describe('webview shell (real renderShellHtml): CSP does not collapse the #fl-root layout', () => {
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

  async function freshPage(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForTimeout(300)
    return page
  }

  it('the inline layout <style> block actually applied: #fl-root is a flex row', async () => {
    const page = await freshPage()
    try {
      const display = await page.evaluate(() => getComputedStyle(document.getElementById('fl-root')!).display)
      expect(display).toBe('flex')
    } finally {
      await page.close()
    }
  }, 20_000)

  it('the canvas fills its share of the viewport width, not a bare <canvas>\'s intrinsic 300x150', async () => {
    const page = await freshPage()
    try {
      const canvasRect = await page.evaluate(() => document.getElementById('fl-canvas')!.getBoundingClientRect())
      // Before the CSP fix this is exactly {width: 300, height: 150} -- the browser's built-in
      // fallback size for a <canvas> with no layout applied to it at all.
      expect(canvasRect.width).toBeGreaterThan(900) // viewport (1400) minus the ~300px sidebar, generously bounded
      expect(canvasRect.height).toBeGreaterThan(800) // viewport (900) minus rounding/scrollbar slack
    } finally {
      await page.close()
    }
  }, 20_000)

  it('the sidebar sits beside the canvas (same row), not stacked below it as a full-width block', async () => {
    const page = await freshPage()
    try {
      const [canvasRect, sidebarRect] = await page.evaluate(() => {
        const c = document.getElementById('fl-canvas')!.getBoundingClientRect()
        const s = document.getElementById('fl-sidebar')!.getBoundingClientRect()
        return [
          { top: c.top, left: c.left, width: c.width, height: c.height },
          { top: s.top, left: s.left, width: s.width, height: s.height },
        ]
      })
      // "Beside" == same top, sidebar's left starts at (or after) the canvas's right edge, and
      // the sidebar is NOT full viewport width. Before the fix, #fl-sidebar stacks below
      // #fl-canvas (its top is pushed down by the canvas's own height) and spans the full width.
      expect(sidebarRect.top).toBeCloseTo(canvasRect.top, 0)
      expect(sidebarRect.left).toBeGreaterThanOrEqual(canvasRect.left + canvasRect.width - 1)
      expect(sidebarRect.width).toBeLessThan(500)
    } finally {
      await page.close()
    }
  }, 20_000)
})
