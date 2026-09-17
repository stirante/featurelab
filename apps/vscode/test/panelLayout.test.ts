// panelLayout.test.ts -- the regression test for the section-clipping bug (panel.css:
// .fl-panel was `height: 100%; overflow-y: auto` with .fl-section flex children whose own
// `overflow: hidden` made the flexbox spec resolve their automatic minimum size to 0, so
// instead of the sidebar growing and its OUTER host container scrolling, flexbox silently
// shrank every section to fit, clipping the bottom rows of each one -- see panel.css's own
// header comment on `.fl-panel` and `.fl-section` for the full mechanism).
//
// jsdom (vitest's default DOM environment, used by frontend/test/panel.test.ts) reports zero
// for every layout measurement (getBoundingClientRect, offsetHeight, scrollHeight all read 0 --
// jsdom does not implement layout at all), so it CANNOT catch this class of bug: the previous
// port's panel.test.ts suite passed in full with the clipping bug still in place, because every
// one of its assertions is about DOM STRUCTURE/wire-payload content, never rendered geometry.
// This file instead drives a REAL Chromium layout via Playwright, against the actual built
// webview bundle (dist/webview.js/.css -- run `npm run compile` first, or via this package's own
// `pretest` script), and asserts on real pixel geometry: with every section expanded, every
// control row's bounding rect must be entirely within its own section's bounding rect. Before
// the panel.css fix, this failed for every section past the first.
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import { createReadStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from 'featurelab-frontend'
import { loadRenderShellHtml, type RenderShellHtml } from './fixtures/shellHtml.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')
const fixturePath = path.join(dir, '..', '..', '..', 'frontend', 'test', 'fixtures', 'wiki-ceiling-patch-with-entries.json')

// Served HTML comes from the REAL apps/vscode/src/previewPanel.ts::renderShellHtml() (see
// test/fixtures/shellHtml.ts), not a hand-copied duplicate -- a hand-copy is exactly what let
// the CSP bug (previewPanel.ts's real style-src had no nonce, so real VS Code silently dropped
// the whole inline <style> block) survive this suite passing in full; see
// webviewShell.test.ts's own header comment for the dedicated CSP regression coverage. This
// harness still needs its own window.acquireVsCodeApi bootstrap (real VS Code injects that
// global itself), stamped with the SAME nonce renderShellHtml was called with so the meta CSP
// tag's script-src -- which this harness genuinely enforces, same as real VS Code -- doesn't
// block it either.
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

/** Builds a raw generate-result wire payload rich enough to populate every section with real
 * rows. Almost all of it is the fixture's own real capture (see its provenance comment in
 * frontend/test/protocol.test.ts): 44 features and 2 rules for the Feature/Rule section, and two
 * diagnostics that between them cover BOTH diagnostic wire shapes -- the OLD one
 * ({level,fileId,message}, proving decodeGenerateResult's backward-compat fallback still renders
 * sensibly) and the NEW one (identifier/typeId/chain/count/position) --
 * so this layout check exercises both, and so the docs screenshots taken from the same fixture
 * show a real chain and a real count, not just plain text. Only biomeEntries is grafted on: the
 * wiki example pack ships no biomes/ directory at all, so the Pack biome picker would otherwise
 * have no row to lay out. */
function loadAugmentedFixture(): unknown {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>
  raw.biomeEntries = [
    {
      fileId: 'volcano.json',
      identifier: 'example:volcano',
      biome: {
        identifier: 'example:volcano',
        fileId: 'volcano.json',
        tags: ['volcano', 'monster', 'overworld'],
        surfaceBuilder: { topMaterial: 'minecraft:magma_block', midMaterial: 'minecraft:netherrack', foundationMaterial: 'minecraft:basalt', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:lava', seaFloorDepth: 0 },
        surfaceBuilderType: null,
        climate: null,
        replaceBiomes: [],
      },
    },
  ]
  raw.environmentBiome = null
  return raw
}

describe('panel.ts real-layout: expanded sections never clip a control row', () => {
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

  /** Loads the harness, posts a real (augmented) result, expands every section, then FORCES
   * the sidebar to `sidebarWidthPx` -- directly setting the same `flex` shorthand
   * frontend/src/ui/splitter.ts's own `applySidebarWidth()` sets, so this exercises the exact
   * CSS state a real drag (or a persisted narrow width restored on a narrow host) would
   * produce, without needing to simulate a pointer drag pixel-for-pixel. Returns the page with
   * the width already applied and every section expanded, ready for the two assertions below. */
  async function loadExpandedAt(sidebarWidthPx: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 10_000 })

    const fixture = loadAugmentedFixture()
    await page.evaluate((result) => {
      window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
      window.postMessage({ type: 'result', result }, '*')
    }, fixture)
    await page.waitForTimeout(300)

    await page.evaluate((width) => {
      const sidebar = document.getElementById('fl-sidebar')!
      sidebar.style.flex = `0 0 ${width}px`
    }, sidebarWidthPx)

    // Expand every section -- the whole point is proving nothing clips once a user opens
    // everything, which is exactly the state panel-sidebar-expanded.png documents.
    await page.evaluate(() => {
      document.querySelectorAll('.fl-section.fl-collapsed .fl-section-header').forEach((el) => (el as HTMLElement).click())
    })
    await page.waitForTimeout(150)
    return page
  }

  /** The two clipping assertions this suite has always made (see this file's header comment),
   * factored out so both the default-width and narrowest-allowed-width cases below run
   * identical checks. */
  async function assertNoClipping(page: Page): Promise<void> {
    const violations = await page.evaluate(() => {
      const EPSILON = 0.5 // sub-pixel layout rounding, not a real clip
      const out: string[] = []
      for (const section of document.querySelectorAll<HTMLElement>('.fl-section:not(.fl-collapsed)')) {
        const sectionRect = section.getBoundingClientRect()
        const sectionId = section.dataset.sectionId ?? '(unknown)'
        const body = section.querySelector('.fl-section-body')
        if (!body) continue
        // Every direct child of the body is one control row/button/note/paragraph -- the
        // section's own content, not a nested scroll region (the profiler table is the one
        // deliberate exception, see panel.css's own doc comment on .fl-profiler-table; it is
        // allowed to exceed the section bound because IT scrolls internally by design).
        for (const child of Array.from(body.children)) {
          if (child.classList.contains('fl-profiler-table')) continue
          const r = (child as HTMLElement).getBoundingClientRect()
          if (r.height === 0 && r.width === 0) continue // e.g. a hidden .fl-row (fl-hidden)
          if (r.bottom > sectionRect.bottom + EPSILON) {
            out.push(`section "${sectionId}": a row (${child.className}, text="${(child.textContent ?? '').trim().slice(0, 40)}") bottom=${r.bottom.toFixed(1)} exceeds section bottom=${sectionRect.bottom.toFixed(1)}`)
          }
          if (r.top < sectionRect.top - EPSILON) {
            out.push(`section "${sectionId}": a row (${child.className}) top=${r.top.toFixed(1)} is above section top=${sectionRect.top.toFixed(1)}`)
          }
        }
      }
      return out
    })

    expect(violations).toEqual([])

    // Belt-and-braces sanity check on the mechanism itself, not just the symptom: every
    // section's rendered height must equal its own natural content height (scrollHeight) --
    // proving nothing was flex-shrunk below what it contains, which is the actual bug this
    // guards against (see this file's header comment).
    const shrunk = await page.evaluate(() => {
      const out: string[] = []
      for (const section of document.querySelectorAll<HTMLElement>('.fl-section:not(.fl-collapsed)')) {
        const rect = section.getBoundingClientRect()
        if (rect.height + 0.5 < section.scrollHeight) {
          out.push(`section "${section.dataset.sectionId}": rendered height ${rect.height.toFixed(1)} < natural content height ${section.scrollHeight}`)
        }
      }
      return out
    })
    expect(shrunk).toEqual([])
  }

  it('every control row is fully within its own section bounds, with every section expanded, at the default sidebar width', async () => {
    const page = await loadExpandedAt(DEFAULT_SIDEBAR_WIDTH)
    try {
      await assertNoClipping(page)
    } finally {
      await page.close()
    }
  }, 30_000)

  // The resizable sidebar (frontend/src/ui/splitter.ts) can be dragged down
  // to MIN_SIDEBAR_WIDTH -- exactly the condition that could reintroduce the clipping bug this
  // whole file guards against (a narrower sidebar leaves less room per control row), so this
  // suite has to prove it explicitly at that width too, not just at the roomier default.
  it('every control row is fully within its own section bounds, with every section expanded, at the narrowest allowed sidebar width', async () => {
    const page = await loadExpandedAt(MIN_SIDEBAR_WIDTH)
    try {
      await assertNoClipping(page)
    } finally {
      await page.close()
    }
  }, 30_000)

  // -------------------------------------------------------------------------
  // No prose in the panel -- the node inspector's contract (test/graphInspector.test.ts pins
  // the same four things for src/graph/inspector.ts), applied to the preview sidebar: a row is
  // one line with its one-sentence explanation as a native tooltip; the long form is behind
  // one `?` per section head, in a panel beside the sidebar; reading the panel never moves it;
  // nothing that documents a control ever covers that control. Structural assertions (which
  // sentence went where) are in frontend/test/panel.test.ts; these are the ones only a real
  // layout can hold.
  // -------------------------------------------------------------------------

  interface Box {
    x: number
    y: number
    width: number
    height: number
  }

  function overlaps(a: Box, b: Box): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  }

  /** Every visible control in the sidebar, with its box. */
  async function controlBoxes(page: Page): Promise<{ name: string; box: Box }[]> {
    return page.$$eval('#fl-sidebar input, #fl-sidebar select, #fl-sidebar button', (els) =>
      els
        .map((el) => {
          const rect = el.getBoundingClientRect()
          const label = el.closest('.fl-row')?.querySelector('.fl-row-label')?.textContent ?? el.textContent ?? ''
          return { name: `${el.tagName.toLowerCase()}[${label.trim()}]`, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        })
        .filter((entry) => entry.box.width > 0 && entry.box.height > 0),
    )
  }

  it('contains no explanatory prose: labels, controls, and what is about this run, nothing else', async () => {
    const page = await loadExpandedAt(DEFAULT_SIDEBAR_WIDTH)
    try {
      // Sticky grow on, so the one status banner that used to be a paragraph is showing.
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Grow every run')!
        const checkbox = row.querySelector('input') as HTMLInputElement
        checkbox.checked = true
        checkbox.dispatchEvent(new Event('change'))
      })
      // None of the old prose surfaces exists, by element or by sentence.
      expect(await page.locator('#fl-sidebar .fl-section-body p').count()).toBe(0)
      expect(await page.locator('#fl-sidebar .fl-env-description').count()).toBe(0)
      const text = (await page.locator('#fl-sidebar').textContent()) ?? ''
      expect(text).not.toMatch(/GROW-TO-FIT IS ON/)
      expect(text).not.toMatch(/do nothing under/)
      expect(text).not.toMatch(/not permanent settings/)
      // Every visible text run that is not about this run is a label, a button's word or a
      // number -- never a sentence. Forty characters is well past the longest label.
      const long = await page.$$eval('#fl-sidebar', (els) => {
        const out: string[] = []
        const walker = document.createTreeWalker(els[0]!, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = (node as Text).parentElement
          if (parent === null || parent.closest('.fl-diag-item, .fl-banner, .fl-info, .fl-note, .fl-profiler-summary, .fl-badge-partial, option') !== null) continue
          const value = (node.textContent ?? '').trim()
          if (value.length > 40) out.push(value)
        }
        return out
      })
      expect(long).toEqual([])
      // And the status lines that remain are one line tall each.
      const tall = await page.$$eval('#fl-sidebar .fl-banner, #fl-sidebar .fl-note, #fl-sidebar .fl-info', (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetHeight > 0)
          .map((el) => ({ text: (el.textContent ?? '').slice(0, 40), lines: el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).fontSize) * 1.4) }))
          .filter((entry) => entry.lines >= 2),
      )
      expect(tall).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('carries the one-sentence explanation as a native tooltip on every row, inherited by the control', async () => {
    const page = await loadExpandedAt(DEFAULT_SIDEBAR_WIDTH)
    try {
      const rows = await page.$$eval('#fl-sidebar .fl-row', (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetHeight > 0)
          .map((el) => ({
            label: el.querySelector('.fl-row-label')?.textContent ?? '',
            title: el.getAttribute('title') ?? '',
            labelTitle: el.querySelector('.fl-row-label')?.getAttribute('title'),
          })),
      )
      expect(rows.length).toBeGreaterThan(20)
      for (const row of rows) {
        expect(row.title.length, row.label).toBeGreaterThan(10)
        expect(row.title.includes('\n'), row.label).toBe(false)
        expect(row.labelTitle, row.label).toBeNull()
      }
      // The inert sea slots under Plains (which builds no sea): dimmed, and the disabled input's
      // own tooltip says why -- the reason is ON the control, not under it. The list is what the
      // host posts from the engine's `environments` method; the panel acts on nothing less.
      await page.evaluate(() => {
        const defaults = { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 }
        const materials = { topMaterial: 'minecraft:grass_block', midMaterial: 'minecraft:dirt', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 0 }
        window.postMessage(
          {
            type: 'environments',
            environments: [
              { id: 'plains', label: 'Plains', description: 'Gently rolling grass over dirt and stone.', defaults, materials, buildsSea: false, biome: 'plains', biomeTags: ['plains'] },
              { id: 'ocean', label: 'Ocean floor', description: 'Seabed under a full water column.', defaults, materials, buildsSea: true, biome: 'ocean', biomeTags: ['ocean'] },
            ],
          },
          '*',
        )
      })
      await page.waitForTimeout(100)
      const inert = await page.$$eval('#fl-sidebar .fl-row.fl-row-inert', (els) =>
        els.map((el) => ({
          label: el.querySelector('.fl-row-label')?.textContent,
          opacity: parseFloat(getComputedStyle(el.querySelector('.fl-row-label')!).opacity),
          title: el.querySelector('input')?.getAttribute('title') ?? '',
          disabled: (el.querySelector('input') as HTMLInputElement).disabled,
        })),
      )
      expect(inert.map((r) => r.label)).toEqual(['Sea floor material', 'Sea material', 'Sea floor depth'])
      for (const row of inert) {
        expect(row.disabled).toBe(true)
        expect(row.opacity).toBeLessThan(0.6)
        expect(row.title).toMatch(/^Not sent: Plains builds no sea/)
      }
    } finally {
      await page.close()
    }
  }, 30_000)

  it('changes no geometry anywhere when a row or a control is hovered', async () => {
    const page = await loadExpandedAt(DEFAULT_SIDEBAR_WIDTH)
    try {
      // In the sidebar's own scroll coordinates: Playwright scrolls a row into view to hover
      // it, and the sidebar is taller than the viewport -- a scroll is not a geometry change.
      const snapshot = async (): Promise<string> =>
        page.evaluate(() => {
          const scrollTop = document.getElementById('fl-sidebar')!.scrollTop
          return JSON.stringify(
            [...document.querySelectorAll('#fl-sidebar .fl-row, #fl-sidebar .fl-section, #fl-sidebar input, #fl-sidebar select, #fl-sidebar button')]
              .map((el) => el.getBoundingClientRect())
              .filter((rect) => rect.width > 0 && rect.height > 0) // a hidden element has no geometry to keep
              .map((rect) => [Math.round(rect.x), Math.round(rect.y + scrollTop), Math.round(rect.width), Math.round(rect.height)]),
          )
        })
      const before = await snapshot()
      const heightBefore = await page.evaluate(() => document.getElementById('fl-sidebar')!.scrollHeight)
      const rows = page.locator('#fl-sidebar .fl-row:visible')
      const count = await rows.count()
      expect(count).toBeGreaterThan(20)
      for (let i = 0; i < count; i++) {
        await rows.nth(i).hover({ position: { x: 4, y: 2 } })
        expect(await snapshot()).toBe(before)
      }
      for (const selector of ['#fl-sidebar select', '#fl-sidebar input[type=number]', '#fl-sidebar input[type=checkbox]', '#fl-sidebar .fl-help', '#fl-sidebar .fl-section-header']) {
        await page.locator(selector).first().hover()
        expect(await snapshot()).toBe(before)
      }
      expect(await page.evaluate(() => document.getElementById('fl-sidebar')!.scrollHeight)).toBe(heightBefore)
    } finally {
      await page.close()
    }
  }, 60_000)

  it('has exactly one `?` per section head, at its right end, and the documentation it opens never covers a control or moves the sidebar', async () => {
    const page = await loadExpandedAt(DEFAULT_SIDEBAR_WIDTH)
    try {
      const sections = await page.locator('#fl-sidebar .fl-section').count()
      expect(await page.locator('#fl-sidebar .fl-help').count()).toBe(sections)
      expect(await page.locator('#fl-sidebar .fl-row .fl-help').count()).toBe(0)
      const head = await page.locator('#fl-sidebar .fl-section-head').first().boundingBox()
      const help = await page.locator('#fl-sidebar .fl-section-head .fl-help').first().boundingBox()
      expect(help!.x + help!.width).toBeGreaterThan(head!.x + head!.width - 30)

      // Row boxes in the sidebar's own scroll coordinates: clicking a `?` low in the sidebar
      // scrolls it into view, and a scroll is not the sidebar moving.
      const rowBoxes = (): Promise<string[]> =>
        page.$$eval('#fl-sidebar .fl-row', (els) => {
          const scrollTop = document.getElementById('fl-sidebar')!.scrollTop
          return els
            .map((el) => el.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => JSON.stringify([Math.round(rect.x), Math.round(rect.y + scrollTop), Math.round(rect.width), Math.round(rect.height)]))
        })
      const rowsBefore = await rowBoxes()
      const sidebarBefore = await page.locator('#fl-sidebar').boundingBox()
      const helps = page.locator('#fl-sidebar .fl-help')
      for (let i = 0; i < sections; i++) {
        await helps.nth(i).click()
        const docs = page.locator('body > .fl-docs')
        expect(await docs.count()).toBe(1)
        expect(await docs.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
        expect(await helps.nth(i).getAttribute('aria-expanded')).toBe('true')
        // The inspector's shape: close, back, a large title.
        expect(await docs.locator('.fl-docs-bar > button').first().getAttribute('aria-label')).toMatch(/Close/)
        expect(await docs.locator('.fl-docs-back').count()).toBe(1)
        expect(((await docs.locator('.fl-docs-title').textContent()) ?? '').length).toBeGreaterThan(0)
        const box = await docs.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.width).toBeGreaterThan(300)
        // Beside the sidebar, over the preview's side, never over a control -- and the sidebar
        // did not move a pixel to make room.
        expect(box!.x + box!.width).toBeLessThanOrEqual(sidebarBefore!.x + 1)
        const controls = await controlBoxes(page)
        expect(controls.length).toBeGreaterThan(20)
        expect(controls.filter((control) => overlaps(control.box, box!)).map((control) => control.name), `documentation for section ${i} covers controls`).toEqual([])
        expect(await rowBoxes()).toEqual(rowsBefore)
        expect(await page.locator('#fl-sidebar').boundingBox()).toEqual(sidebarBefore)
        // Every entry is the inspector's shape too: a glyph, a name, a summary.
        const entries = await docs.locator('.fl-doc').count()
        if (entries > 0) {
          expect(await docs.locator('.fl-doc .fl-doc-glyph').count()).toBe(entries)
          expect(await docs.locator('.fl-doc .fl-doc-name').count()).toBe(entries)
          expect(await docs.locator('.fl-doc .fl-doc-p').count()).toBeGreaterThanOrEqual(entries)
        }
      }
      // Escape closes it, with focus back on the `?` that opened it.
      await page.locator('body > .fl-docs').focus()
      await page.keyboard.press('Escape')
      expect(await page.locator('.fl-docs').count()).toBe(0)
      expect(await page.evaluate(() => document.activeElement?.classList.contains('fl-help') ?? false)).toBe(true)
      // The status lines never cover a control either.
      const notes = await page.$$eval('#fl-sidebar .fl-note, #fl-sidebar .fl-info, #fl-sidebar .fl-banner', (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetHeight > 0)
          .map((el) => {
            const rect = el.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          }),
      )
      const controls = await controlBoxes(page)
      for (const note of notes) {
        // A banner holds its own button (Grow to fit & regenerate); that button is inside the
        // note by design, not covered by it.
        const covered = controls.filter((control) => overlaps(control.box, note) && !(control.box.x >= note.x && control.box.x + control.box.width <= note.x + note.width + 1 && control.box.y >= note.y && control.box.y + control.box.height <= note.y + note.height + 1))
        expect(covered.map((control) => control.name)).toEqual([])
      }
    } finally {
      await page.close()
    }
  }, 90_000)
})
