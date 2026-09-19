// previewWebview.test.ts -- the webview half of the preview (apps/vscode/webview/main.ts), in a
// real browser, against the REAL built bundle. Run `npm run compile` first, or let this
// package's own `pretest` do it -- exactly as viewport.test.ts and panelLayout.test.ts do, and
// for the same reason: every assertion here is about something jsdom does not have (a pointer
// landing on WebGL geometry, a raycast, a panel built by the frontend package).
//
// What each test guards:
//
//   - "One click, one pick." The gesture lives in VoxelViewer.onPick now, and main.ts carried a
//     second, identical press-and-release handler on the same canvas. Both fired, so one click
//     ran the whole pick twice -- two raycasts, two highlight moves -- and left two places for
//     the slop, the button and the depth rule to drift apart. The viewer's is the one that
//     survived. What a test can see of that is the two ends: the panel's own "what did I just
//     click on" readout, which hangs off that same callback and must still run (chained, not
//     assigned over), and the single message to the host -- a second handler put back on this
//     canvas would show up here as a second `pickCell`.
//   - "A click says nothing when nobody is listening." The host is told about a pick only while
//     it is actually attributing a node; otherwise this webview posts a message the host would
//     ignore, from a preview that never asked the question.
//   - "Which of these is whose." The host now sends every writer in the run, one colour each; the
//     single-writer `cells` field stays on the wire as the shim underneath it.
//   - "Why there are no textures." The panel can tell WHETHER it can draw them and not why not,
//     so the host says it (PanelHandle.setTextureStatus) -- including for the atlas that arrives
//     and then cannot be decoded, which is the one texture failure the host cannot see.
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadRenderShellHtml, type RenderShellHtml } from './fixtures/shellHtml.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')
const fixturePath = path.join(dir, '..', '..', '..', 'frontend', 'test', 'fixtures', 'wiki-ceiling-patch-with-entries.json')

const NONCE = 'test-harness-nonce'
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

/** The bootstrap real VS Code injects, except that this one REMEMBERS. Every other browser
 * harness in this package stubs postMessage as a no-op, which is enough for suites that only
 * look at the page; this one is about what the webview says back to the host, so the messages
 * have to land somewhere a test can read. */
const BOOTSTRAP = `<script nonce="${NONCE}">
  window.__flPosted = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { window.__flPosted.push(m); },
      setState: function () {},
      getState: function () { return null; },
    };
  };
</script>`

function startServer(renderShellHtml: RenderShellHtml): Promise<{ port: number; close: () => void }> {
  let port = 0
  const server = http.createServer((req, res) => {
    if (!req.url || req.url === '/') {
      const cspSource = `http://127.0.0.1:${port}`
      const html = renderShellHtml({ nonce: NONCE, cspSource, scriptUri: `${cspSource}/webview.js`, styleUri: `${cspSource}/webview.css` })
      res.setHeader('Content-Type', 'text/html')
      res.end(html.replace('</body>', `${BOOTSTRAP}</body>`))
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

type Posted = { type: string; x?: number; y?: number; z?: number }

async function posted(page: Page, type: string): Promise<Posted[]> {
  return page.evaluate((t) => (window as unknown as { __flPosted: Posted[] }).__flPosted.filter((m) => m.type === t), type)
}

/** What the overlay is actually painting, per writer -- the viewer's own answer, read through the
 * `__flViewer` hook the bundle already exposes for the screenshot harness. */
type GroupState = { id: string; label: string; cells: number; colorIndex: number }
async function attributionGroups(page: Page): Promise<GroupState[]> {
  return page.evaluate(() =>
    (window as unknown as { __flViewer: { getAttributionGroups(): GroupState[] } }).__flViewer.getAttributionGroups().map((g) => ({
      id: g.id,
      label: g.label,
      cells: g.cells,
      colorIndex: g.colorIndex,
    })),
  )
}

describe('preview webview: picking, attribution colours and texture status', () => {
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

  /** A loaded preview with a real result in it -- the same fixture viewport.test.ts drives, whose
   * environment is solid, so a click anywhere on the canvas lands on a block. */
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

  /** A click, as a hand makes one: a press and a release in the same place. */
  async function clickCanvas(page: Page): Promise<void> {
    const box = (await page.locator('#fl-canvas').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(200)
  }

  /** Arms attribution the way the host does: an answer it could actually resolve. */
  async function armAttribution(page: Page): Promise<void> {
    await page.evaluate(() =>
      window.postMessage(
        { type: 'attribution', available: true, nodeId: 'wiki:thing', cells: [0, 1, 2], cellCount: 3, shown: 3, writes: 3 },
        '*',
      ),
    )
    await page.waitForTimeout(100)
  }

  it('a click picks exactly once, and still fills the panel’s own readout', async () => {
    const page = await loadWithResult()
    try {
      await armAttribution(page)
      await clickCanvas(page)

      // The precondition first: a pick actually happened. The readout is the panel's, installed
      // on viewer.onPick before this file's own callback -- so its being filled is the proof that
      // chaining kept it rather than assigning over it.
      await expect.poll(async () => (await page.locator('.fl-picked').innerText()).trim().length).toBeGreaterThan(0)
      // ONE message, from one handler. A second press-and-release handler on this canvas -- what
      // this file used to carry -- picks the same cell again and says so again.
      expect(await posted(page, 'pickCell')).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 90_000)

  it('says nothing to the host while no node is being attributed', async () => {
    const page = await loadWithResult()
    try {
      await clickCanvas(page)

      // The readout still answers -- clicking a block identifies it in every preview...
      await expect.poll(async () => (await page.locator('.fl-picked').innerText()).trim().length).toBeGreaterThan(0)
      // ...and nothing goes to a host that never asked the attribution question.
      expect(await posted(page, 'pickCell')).toEqual([])
    } finally {
      await page.close()
    }
  }, 90_000)

  it('paints one colour per writer when the host sends them, and the shim alone when it does not', async () => {
    const page = await loadWithResult()
    try {
      await page.evaluate(() =>
        window.postMessage(
          {
            type: 'attribution',
            available: true,
            nodeId: 'wiki:selected',
            cells: [0, 1, 2],
            cellCount: 3,
            shown: 3,
            writes: 3,
            groups: [
              { id: 'wiki:selected', label: 'wiki:selected', cells: [0, 1, 2] },
              { id: 'wiki:other', label: 'wiki:other', cells: [3, 4] },
            ],
          },
          '*',
        ),
      )
      await page.waitForTimeout(150)

      // Colours are assigned BY POSITION, so the selected node keeps index 0 -- the blue-violet
      // the single-writer overlay has always used -- and the legend cannot disagree with the
      // geometry about which colour is whose.
      expect(await attributionGroups(page)).toEqual([
        { id: 'wiki:selected', label: 'wiki:selected', cells: 3, colorIndex: 0 },
        { id: 'wiki:other', label: 'wiki:other', cells: 2, colorIndex: 1 },
      ])

      // A host that sends no groups at all -- or an older one -- still paints the selected node,
      // through the same single-writer shim as before.
      await page.evaluate(() =>
        window.postMessage({ type: 'attribution', available: true, nodeId: 'wiki:selected', cells: [0, 1], cellCount: 2, shown: 2, writes: 2 }, '*'),
      )
      await page.waitForTimeout(150)
      const shim = await attributionGroups(page)
      expect(shim).toHaveLength(1)
      expect(shim[0]?.cells).toBe(2)
    } finally {
      await page.close()
    }
  }, 90_000)

  it('shows the host’s own reason for having no textures, and its own when the atlas will not decode', async () => {
    const page = await loadWithResult()
    try {
      const reason = 'Block textures are switched off by the featurelab.blockTextures setting.'
      await page.evaluate((r) => window.postMessage({ type: 'textureStatus', available: false, reason: r }, '*'), reason)
      await expect.poll(async () => page.locator('.fl-texture-note').innerText()).toContain('featurelab.blockTextures')

      // And the one failure the host cannot know about: it delivered an atlas, and this side
      // could not read it. Leaving the host's "available" up would put a cheerful message over a
      // checkbox that can never be ticked.
      await page.evaluate(() => window.postMessage({ type: 'atlas', atlas: { table: { version: 1 }, png: 'not-a-png' } }, '*'))
      await expect.poll(async () => page.locator('.fl-texture-note').innerText()).toContain('could not be read')
    } finally {
      await page.close()
    }
  }, 90_000)
})
