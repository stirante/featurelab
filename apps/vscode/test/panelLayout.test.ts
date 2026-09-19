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
import { contrastOfImage, decodePng, requiredRatio, DARK_MODERN as PX_DARK, LIGHT_MODERN as PX_LIGHT } from '../../../frontend/test/fixtures/pixelContrast.js'

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
   * identical checks.
   *
   * IT HAS TWO AXES AND IT WALKS INTO CHILDREN NOW, which is what it should always have had.
   * The first version tested `r.bottom`/`r.top` only, against `body.children` only -- so it
   * proved a great deal about vertical clipping in the direction the sidebar can actually grow,
   * and nothing whatsoever about the direction it cannot. A `.fl-row` is `display: flex` and
   * therefore always exactly as wide as its section; its CONTENTS are what overflow it, and the
   * contents are one level down. That blind spot passed a sidebar whose Mode radios ran 67.9px
   * past the section's own `overflow: hidden` edge at MIN_SIDEBAR_WIDTH and 27.9px past it at
   * the default, with `scrollWidth === clientWidth` so no scroll could bring them back: the
   * second half of "Feature / Rule" was simply cut off the side of the panel and unreachable.
   *
   * The horizontal bound is the section's CONTENT box, not its border box: a section is
   * `overflow: hidden`, so anything past its padding edge is what gets cut. */
  async function assertNoClipping(page: Page): Promise<void> {
    const violations = await page.evaluate(() => {
      const EPSILON = 0.5 // sub-pixel layout rounding, not a real clip
      const out: string[] = []
      for (const section of document.querySelectorAll<HTMLElement>('.fl-section:not(.fl-collapsed)')) {
        const sectionRect = section.getBoundingClientRect()
        const sectionId = section.dataset.sectionId ?? '(unknown)'
        const body = section.querySelector('.fl-section-body')
        if (!body) continue
        // The clipping edge horizontally is the section's own content box -- its border box less
        // its border and padding -- because that is the box `overflow: hidden` cuts against.
        const style = getComputedStyle(section)
        const px = (v: string): number => parseFloat(v) || 0
        const leftEdge = sectionRect.left + px(style.borderLeftWidth) + px(style.paddingLeft)
        const rightEdge = sectionRect.right - px(style.borderRightWidth) - px(style.paddingRight)

        // Every direct child of the body is one control row/button/note/paragraph -- the
        // section's own content, not a nested scroll region (the profiler table is the one
        // deliberate exception, see panel.css's own doc comment on .fl-profiler-table; it is
        // allowed to exceed the section bound because IT scrolls internally by design). Each
        // row's own descendants are walked too: a row is as wide as the section by construction,
        // so a row that fits proves nothing about the controls inside it.
        const walk = (el: Element): void => {
          if (el.classList.contains('fl-profiler-table')) return
          const r = el.getBoundingClientRect()
          if (r.height === 0 && r.width === 0) return // e.g. a hidden .fl-row (fl-hidden)
          const where = `${el.className || el.tagName.toLowerCase()}, text="${(el.textContent ?? '').trim().slice(0, 40)}"`
          const overhangs = r.right > rightEdge + EPSILON || r.left < leftEdge - EPSILON
          if (r.bottom > sectionRect.bottom + EPSILON) {
            out.push(`section "${sectionId}": a row (${where}) bottom=${r.bottom.toFixed(1)} exceeds section bottom=${sectionRect.bottom.toFixed(1)}`)
          }
          if (r.top < sectionRect.top - EPSILON) {
            out.push(`section "${sectionId}": a row (${where}) top=${r.top.toFixed(1)} is above section top=${sectionRect.top.toFixed(1)}`)
          }
          if (r.right > rightEdge + EPSILON) {
            out.push(`section "${sectionId}": (${where}) right=${r.right.toFixed(1)} overhangs the section's content edge=${rightEdge.toFixed(1)} by ${(r.right - rightEdge).toFixed(1)}px`)
          }
          if (r.left < leftEdge - EPSILON) {
            out.push(`section "${sectionId}": (${where}) left=${r.left.toFixed(1)} is left of the section's content edge=${leftEdge.toFixed(1)} by ${(leftEdge - r.left).toFixed(1)}px`)
          }
          // One report per offending subtree: once a container overhangs, every descendant of it
          // does too, and a hundred duplicates of one fact is not a hundred facts.
          if (overhangs) return
          for (const child of Array.from(el.children)) walk(child)
        }
        for (const child of Array.from(body.children)) walk(child)
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

  // The one status line in the sidebar whose whole job is a REASON, and every version of it was
  // cut in half. `.fl-texture-note` set `white-space: normal`, but the generic `.fl-note` rule
  // set `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` at the same specificity
  // and later in the file, so `.fl-note` won all three. In a 266px row, the setting-off reason
  // needs 866px -- 69% of it hidden, "Turn that setting on…" never once on screen -- with an
  // EMPTY `title` for the ellipsis to hide behind. The unresolved-block list fared worse: 54%
  // hidden, and its `title` is a different sentence, so the block names it exists to give were
  // unrecoverable by any means.
  it('lets the texture reason wrap instead of ellipsising it, at every sidebar width', async () => {
    const reason =
      'Block textures are switched off for this workspace (featurelab.blockTextures is false), so the preview draws one flat colour per block. Turn that setting on to build an atlas from the vanilla resource pack.'
    for (const width of [MIN_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH]) {
      const page = await loadExpandedAt(width)
      try {
        await page.evaluate((text) => window.postMessage({ type: 'textureStatus', available: false, reason: text }, '*'), reason)
        await page.waitForTimeout(150)
        const note = page.locator('#fl-sidebar .fl-texture-note')
        expect(await note.isVisible()).toBe(true)
        expect(await note.textContent()).toBe(reason)

        const measured = await note.evaluate((el) => {
          const style = getComputedStyle(el)
          return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height, lineHeight: parseFloat(style.fontSize) * 1.4 }
        })
        expect(measured.whiteSpace).toBe('normal')
        expect(measured.textOverflow).toBe('clip')
        // Nothing hidden sideways: the whole sentence is laid out inside the box.
        expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1)
        // ...which for a sentence this long in a sidebar this narrow means several lines.
        expect(measured.height).toBeGreaterThan(measured.lineHeight * 2)
      } finally {
        await page.close()
      }
    }
  }, 60_000)

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
          // .fl-sr-status is the outcome announcement -- a status about THIS run by definition,
          // and one that is never painted (see panel.css). Skipped for the same reason .fl-banner
          // is. .fl-sr-only joins it: that is an inert control's REASON, parked where a screen
          // reader can reach it precisely because this rule forbids writing it into the panel as
          // a visible paragraph. Neither is text on screen, which is what this test is about.
          if (parent === null || parent.closest('.fl-diag-item, .fl-banner, .fl-info, .fl-note, .fl-profiler-summary, .fl-badge-partial, .fl-sr-status, .fl-sr-only, option') !== null) continue
          const value = (node.textContent ?? '').trim()
          if (value.length > 40) out.push(value)
        }
        return out
      })
      expect(long).toEqual([])
      // And the status lines that remain are one line tall each -- except .fl-texture-note,
      // which is the ONE line in this panel deliberately allowed to wrap, and whose own rule in
      // panel.css says why: it carries the reason "Block textures" is inert (and is now that
      // checkbox's accessible description), and a reason ellipsised mid-sentence loses exactly
      // the actionable half. It is a wrapped sentence, not a paragraph: still one statement,
      // still about this run.
      const tall = await page.$$eval('#fl-sidebar .fl-banner, #fl-sidebar .fl-note, #fl-sidebar .fl-info', (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetHeight > 0 && !el.classList.contains('fl-texture-note'))
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
      // A normal row's label, to compare the inert ones against: "this row is dimmed" has to be
      // a VISIBLE difference, and after the dimming stopped being an `opacity` the only way to
      // say that is to read both colours and check they differ.
      const liveLabelColor = await page.$eval('#fl-sidebar .fl-row:not(.fl-row-inert) .fl-row-label', (el) => getComputedStyle(el).color)
      const inert = await page.$$eval('#fl-sidebar .fl-row.fl-row-inert', (els) =>
        els.map((el) => ({
          label: el.querySelector('.fl-row-label')?.textContent,
          opacity: parseFloat(getComputedStyle(el.querySelector('.fl-row-label')!).opacity),
          color: getComputedStyle(el.querySelector('.fl-row-label')!).color,
          readOnly: (el.querySelector('input') as HTMLInputElement).readOnly,
          title: el.querySelector('input')?.getAttribute('title') ?? '',
          // The row's own sentence, which a control carrying no title of its own inherits (see
          // dom.ts::row) -- where the texture row puts its reason.
          rowTitle: el.getAttribute('title') ?? '',
          disabled: (el.querySelector('input') as HTMLInputElement).disabled,
          ariaDisabled: el.querySelector('input')?.getAttribute('aria-disabled') ?? null,
        })),
      )
      // In sidebar order: the three sea slots in Materials, then View's "Block textures" row,
      // which is inert here for its own unrelated reason -- this harness's host posts no atlas,
      // and that row's promise is "draw textures when there are any" (see panel.ts's own comment
      // on it), so with none it dims and says which of the two reasons it is dim for rather than
      // offering a checkbox that would change nothing.
      // "Show heatmap" joined the list: it was always inert without a profiled run and always
      // carried its reason on the row, but it did not dim with the others until it stopped using
      // `disabled` (see dom.ts's setInert).
      expect(inert.map((r) => r.label)).toEqual(['Sea floor material', 'Sea material', 'Sea floor depth', 'Block textures', 'Show heatmap'])
      for (const row of inert) {
        // INERT, NOT REMOVED -- now for all five. The three sea slots WERE still `disabled`, on
        // the reasoning that a text input has no aria-disabled equivalent that keeps it
        // uneditable; `readonly` is that equivalent, and it keeps the control in the tab order
        // (which `disabled` does not) along with the sentence saying the value is being kept.
        // See dom.ts's setInert/setInertReason.
        expect(row.disabled, row.label ?? '').toBe(false)
        expect(row.ariaDisabled, row.label ?? '').toBe('true')
        expect(row.readOnly || row.label?.startsWith('Show') === true || row.label === 'Block textures', row.label ?? '').toBe(true)
        // DIMMED WITH A COLOUR, NOT AN OPACITY. This used to read `opacity < 0.6`, and 0.45 was
        // what it got -- multiplied by the 0.85 every row label already carried, which painted
        // the label of an inert control at 2.40:1 in Light Modern. The look is the same and the
        // contrast is now a number the stylesheet states (see panel.css's --fl-fg-dim and
        // panelLayout's own pixel-measured suite at the end of this file).
        expect(row.opacity, row.label ?? '').toBe(1)
        expect(row.color, row.label ?? '').not.toBe(liveLabelColor)
        // Sea slot: the reason is on the disabled control itself. Texture row: on the row, which
        // its untitled checkbox inherits -- either way it is reachable from the control, and in
        // both cases it names the reason instead of leaving a dead checkbox to be puzzled over.
        if (row.label === 'Block textures') {
          expect(row.title).toBe('')
          expect(row.rowTitle).toMatch(/^No block texture atlas is available on this machine/)
        } else if (row.label === 'Show heatmap') {
          expect(row.title).toBe('')
          expect(row.rowTitle.length).toBeGreaterThan(10)
        } else {
          expect(row.title).toMatch(/^Not sent: Plains builds no sea/)
        }
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
      expect(await page.locator('#fl-sidebar .fl-section-head .fl-help').count()).toBe(sections)
      // Exactly ONE `?` outside a section head: the "Grow every run" row, whose five permanent
      // lines of explanation moved behind it. A `?` beside the control it explains is the
      // pattern; a `?` on every row would be the pattern used as wallpaper.
      const rowHelps = page.locator('#fl-sidebar .fl-row .fl-help')
      expect(await rowHelps.count()).toBe(1)
      expect(await rowHelps.first().evaluate((el) => el.closest('.fl-row')!.querySelector('.fl-row-label')!.textContent)).toBe('Grow every run')
      expect(await page.locator('#fl-sidebar .fl-help').count()).toBe(sections + 1)
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
      const helps = page.locator('#fl-sidebar .fl-section-head .fl-help')
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


// ==============================================================================================
// ---- accessibility: contrast, live regions and inert controls --------------------------------
// ==============================================================================================
// Every assertion below is one a jsdom suite cannot make, for the same reason the clipping
// assertions above are: they need a real cascade (custom properties, color-mix, media queries),
// real computed colours and a real accessibility-relevant focus order. They run against the same
// built bundle, under the same CSP, with the two token sets a real VS Code webview injects.
//
// CONTRAST IS COMPUTED, NOT COMPARED TO A HEX. `contrastOf` below resolves whatever the cascade
// actually produced, composites the foreground's alpha over the first opaque ancestor background
// (which is how rgba(204,204,204,0.5) becomes #727272 on #181818), and runs the WCAG relative-
// luminance formula. It would therefore still fail if a token were changed to a different colour
// that happens to be equally unreadable, which a hex comparison would not.

/** The colour tokens VS Code injects into a webview, as Dark Modern and Light Modern actually
 * ship them. Only the ones panel.css reads are listed; anything absent falls through to the
 * stylesheet's own literal, exactly as it does in a real webview that omits a token. */
const DARK_MODERN: Record<string, string> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-disabledForeground': '#9d9d9d',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-sideBar-background': '#181818',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-editorWidget-foreground': '#cccccc',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-errorForeground': '#f85149',
  '--vscode-inputValidation-warningBackground': '#352a05',
  '--vscode-inputValidation-warningBorder': '#966c1e',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-textLink-foreground': '#4daafc',
}
const LIGHT_MODERN: Record<string, string> = {
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': 'rgba(59, 59, 59, 0.6)',
  '--vscode-disabledForeground': 'rgba(59, 59, 59, 0.5)',
  '--vscode-editor-background': '#ffffff',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-editorWidget-foreground': '#3b3b3b',
  '--vscode-widget-border': '#e5e5e5',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-input-border': '#cecece',
  '--vscode-list-hoverBackground': '#f2f2f2',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-errorForeground': '#f85149',
  '--vscode-inputValidation-warningBackground': '#f6f5d2',
  '--vscode-inputValidation-warningBorder': '#b89500',
  '--vscode-badge-background': '#cccccc',
  '--vscode-badge-foreground': '#3b3b3b',
  '--vscode-textLink-foreground': '#005fb8',
}

/** One measured element: what the browser actually painted, and what WCAG asks of it. */
interface Measured {
  selector: string
  text: string
  fg: string
  bg: string
  size: number
  weight: string
  ratio: number
  need: number
  pass: boolean
}

/** Measures every element matching `selectors` the way the critic's harness did -- see this
 * block's header comment. Runs entirely in the page, so nothing here depends on this file
 * knowing which token produced which colour. */
async function measureContrast(page: Page, selectors: readonly string[]): Promise<Measured[]> {
  return page.evaluate((sels: readonly string[]) => {
    /** rgb()/rgba() come back in 0..255; a color-mix() result comes back as
     * `color(srgb 0.96 0.96 0.82 / 0.25)`, in 0..1. Both are what this stylesheet produces, and
     * reading the second as if it were the first is how a pale yellow becomes near-black. */
    const parse = (value: string): [number, number, number, number] => {
      const nums = (value.match(/[\d.]+/g) ?? []).map(Number)
      if (value.startsWith('color(')) {
        const [r = 0, g = 0, b = 0, a = 1] = nums
        return [r * 255, g * 255, b * 255, a]
      }
      const [r = 0, g = 0, b = 0, a = 1] = nums
      return [r, g, b, value.startsWith('rgba') ? a : 1]
    }
    const channel = (v: number): number => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const luminance = (rgb: [number, number, number]): number => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    const over = (fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    ]
    const hex = (rgb: readonly number[]): string => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
    /** The first ancestor that actually paints something, with every translucent layer above it
     * composited back down -- which is what the eye sees and what a `color` has to beat. */
    const backdrop = (el: Element): [number, number, number] => {
      const layers: [number, number, number, number][] = []
      for (let node: Element | null = el; node !== null; node = node.parentElement) {
        const bg = parse(getComputedStyle(node).backgroundColor)
        if (bg[3] === 0) continue
        layers.push(bg)
        if (bg[3] === 1) break
      }
      let out: [number, number, number] = [255, 255, 255]
      for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i]!, out)
      return out
    }
    const out: Measured[] = []
    for (const selector of sels) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const style = getComputedStyle(el)
        const bg = backdrop(el)
        const fg = over(parse(style.color), bg)
        const l1 = luminance(fg)
        const l2 = luminance(bg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        const size = parseFloat(style.fontSize)
        const weight = style.fontWeight
        const bold = Number(weight) >= 700 || weight === 'bold'
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
        out.push({
          selector,
          text: (el.textContent ?? '').trim().slice(0, 44),
          fg: hex(fg),
          bg: hex(bg),
          size,
          weight,
          ratio: Math.round(ratio * 100) / 100,
          need,
          pass: ratio >= need,
        })
      }
    }
    return out
  }, selectors) as Promise<Measured[]>
}

function failures(measured: readonly Measured[]): string[] {
  return measured.filter((m) => !m.pass).map((m) => `${m.selector} "${m.text}" ${m.fg} on ${m.bg} = ${m.ratio}:1 (needs ${m.need}:1)`)
}

describe('panel.ts accessibility: the theme, the announcements and the inert controls', () => {
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

  /** A loaded webview wearing one of VS Code's real token sets, with a result on screen and the
   * Diagnostics section open (its rows are where most of the warning-coloured text lives).
   *
   * The tokens are set through the CSSOM rather than as a <style> block or a `style` attribute:
   * the shell's CSP is real here (see this file's header), and CSSOM writes are the one way to
   * add custom properties that a nonce-based style-src does not block -- the same route
   * viewportOverlay.ts's adoptStatus already takes. */
  async function loadThemed(tokens: Record<string, string>, scheme: 'dark' | 'light'): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: scheme })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
    await page.evaluate((vars: Record<string, string>) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
      // VS Code's own webview stylesheet paints the body with editor.background; the shell HTML
      // does not, because in production it never has to. Without it every backdrop walk would
      // bottom out on the white this harness's page happens to be, which is a fact about the
      // harness rather than about the panel.
      document.body.style.backgroundColor = vars['--vscode-editor-background'] ?? ''
    }, tokens)
    await page.evaluate((result) => {
      window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
      window.postMessage({ type: 'result', result }, '*')
    }, loadAugmentedFixture())
    await page.waitForTimeout(350)
    await page.evaluate(() => {
      const head = document.querySelector('.fl-section[data-section-id="diagnostics"].fl-collapsed .fl-section-header')
      if (head instanceof HTMLElement) head.click()
    })
    await page.waitForTimeout(150)
    return page
  }

  // ---------------------------------------------------------------------------------------
  // panel.css's `@media (prefers-color-scheme: light)` block redeclared --fl-bg/--fl-fg/... as
  // LITERALS, and a custom property does not fall through: a later declaration at the same
  // specificity simply wins. The comment above it claimed "a real VS Code webview never reaches
  // this block", which was the exact opposite of what the cascade does. Every light theme the
  // user had chosen -- high-contrast ones included -- was painted over with one hardcoded white.
  // ---------------------------------------------------------------------------------------
  it('wears the light theme the editor gave it, instead of its own white', async () => {
    const page = await loadThemed(LIGHT_MODERN, 'light')
    try {
      const painted = await page.evaluate(() => {
        const panel = document.querySelector('.fl-panel')!
        const style = getComputedStyle(panel)
        return { bg: style.backgroundColor, fg: style.color }
      })
      // The tokens, not #ffffff / #1e1e1e. This is the measurement that failed.
      expect(painted.bg).toBe('rgb(248, 248, 248)')
      expect(painted.fg).toBe('rgb(59, 59, 59)')

      // And with NO tokens at all -- the Wails/standalone case the block exists for -- the light
      // literals still take over, which is the behaviour that had to survive the fix.
      await page.evaluate(() => {
        for (const name of Array.from(document.documentElement.style)) {
          if (name.startsWith('--vscode-')) document.documentElement.style.removeProperty(name)
        }
      })
      const bare = await page.evaluate(() => getComputedStyle(document.querySelector('.fl-panel')!).backgroundColor)
      expect(bare).toBe('rgb(255, 255, 255)')
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // --fl-warning-fg is editorWarning.foreground, whose contract is a squiggle -- #bf8803 in
  // Light Modern, which is 3.12:1 painted as text on this panel's white, and 2.79:1 for the
  // Diagnostics section title on its own tinted head. Eighteen light failures, none in dark,
  // from one token used for a job it never promised to do.
  // ---------------------------------------------------------------------------------------
  const WARNING_TEXT = [
    '.fl-diag-warning .fl-diag-text',
    '.fl-diag-warning .fl-diag-chain-seg',
    '.fl-diag-warning .fl-diag-type',
    '.fl-diag-warning .fl-diag-file',
    '.fl-diag-warning .fl-diag-chain-sep',
    '.fl-section-header-warning .fl-section-title-text',
  ]

  for (const [name, tokens, scheme] of [
    ['Light Modern', LIGHT_MODERN, 'light'],
    ['Dark Modern', DARK_MODERN, 'dark'],
  ] as const) {
    it(`paints warning diagnostics as readable text in ${name}`, async () => {
      const page = await loadThemed(tokens, scheme)
      try {
        const measured = await measureContrast(page, WARNING_TEXT)
        // The fixture has to actually contain warning rows, or this proves nothing.
        expect(measured.length).toBeGreaterThan(4)
        expect(failures(measured)).toEqual([])

        // The ⚠ is an icon and owes only 3:1, but the raw token does not clear even that on the
        // row's own tint (2.90:1 measured), so it takes the same text colour the row does.
        const icon = await measureContrast(page, ['.fl-diag-warning .fl-diag-icon'])
        expect(icon.length).toBeGreaterThan(0)
        expect(failures(icon)).toEqual([])
      } finally {
        await page.close()
      }
    }, 90_000)

    // The graph panel's dim treatment -- color-mix toward the theme's own background -- never
    // reached panel.css: the inert stat figure used disabledForeground (rgba(...,0.4)) and the
    // overlay's quiet text used descriptionForeground, measured at 2.46:1 / 3.69:1 and 3.48:1.
    it(`keeps quieted text readable in ${name}`, async () => {
      const page = await loadThemed(tokens, scheme)
      try {
        // A run that carved nothing is what quiets the CARVED figure.
        await page.evaluate(() => {
          const el = document.querySelector('.fl-stat-carved')
          return el?.getAttribute('aria-disabled')
        })
        const measured = await measureContrast(page, ['.fl-stat[aria-disabled="true"] .fl-stat-value', '.fl-vp-scale', '.fl-vp-keys'])
        expect(measured.length).toBeGreaterThan(1)
        expect(failures(measured)).toEqual([])
      } finally {
        await page.close()
      }
    }, 90_000)
  }

  // ---------------------------------------------------------------------------------------
  // A run that FAILED had a role=alert banner; a run that placed NOTHING had a role=status line;
  // a run that simply worked announced nothing at all. The three live regions that mutate at
  // that instant were all hidden, so the readout a screen reader user most wants -- what the run
  // did -- was the one thing never spoken.
  // ---------------------------------------------------------------------------------------
  it('announces what a successful run produced, in a polite status', async () => {
    const page = await loadThemed(DARK_MODERN, 'dark')
    try {
      const status = page.locator('.fl-sr-status')
      expect(await status.getAttribute('role')).toBe('status')
      expect(await status.getAttribute('aria-live')).toBe('polite')
      // It carries the same three figures the chips do, plus the duration.
      const said = (await status.textContent()) ?? ''
      expect(said).toMatch(/^\d[\d,]* placed, [\d,]+ carved, [\d,]+ replaced, in \d+\.\d ms\.$/)
      const placed = (await page.locator('.fl-stat-placed .fl-stat-value').textContent()) ?? ''
      expect(said.startsWith(`${placed} placed,`)).toBe(true)
      // Off screen, not merely visually quiet: the same figures are already on the chips.
      const box = await status.boundingBox()
      expect(box === null || box.width <= 1).toBe(true)

      // The busy pill is NOT a live region any more -- its text is a clock, and a polite region
      // holding a clock reads out the past (30 mutations in three seconds, measured).
      await page.evaluate(() => window.postMessage({ type: 'busy', busy: true }, '*'))
      await page.waitForTimeout(400)
      const pillIsLive = await page.evaluate(() => {
        const pill = document.querySelector('.fl-vp-pill')!
        return pill.hasAttribute('role') || pill.hasAttribute('aria-live')
      })
      expect(pillIsLive).toBe(false)
      expect(await page.locator('.fl-vp-announce').getAttribute('aria-live')).toBe('polite')
      expect(await page.locator('.fl-vp-announce').textContent()).toBe('Generating\u2026')
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // Four controls were `disabled`, and on every one of them the accessible name IS the reason
  // they are inert -- so the sentence became unreadable at exactly the moment it was worth
  // reading. The fifth finding in the same family: the sidebar checkbox and the toolbar button
  // reported opposite states for one setting.
  // ---------------------------------------------------------------------------------------
  it('keeps every inert control reachable, and lets no two controls disagree about one state', async () => {
    const page = await loadThemed(DARK_MODERN, 'dark')
    try {
      const inert = await page.evaluate(() => {
        const rowCheckbox = (label: string): HTMLInputElement =>
          [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === label)!.querySelector('input') as HTMLInputElement
        const carved = document.querySelector('.fl-stat-carved') as HTMLButtonElement
        const textures = [...document.querySelectorAll('.fl-vp-btn')].find((b) => /texture|flat colours/i.test(b.getAttribute('aria-label') ?? '')) as HTMLButtonElement
        return [carved, rowCheckbox('Block textures'), rowCheckbox('Show heatmap'), textures].map((el) => ({
          what: el.className,
          disabled: (el as HTMLButtonElement).disabled,
          ariaDisabled: el.getAttribute('aria-disabled'),
          // A tab stop of its own, or -- for the toolbar's roving set -- reachable within it.
          tabbable: el.tabIndex >= 0 || el.getAttribute('tabindex') === '-1',
          why: (el.getAttribute('aria-label') ?? el.title ?? '').length,
        }))
      })
      for (const control of inert) {
        expect(control.disabled, control.what).toBe(false)
        expect(control.ariaDisabled, control.what).toBe('true')
        expect(control.tabbable, control.what).toBe(true)
      }
      // The carved chip and the texture button carry their reason as their own name.
      expect(inert[0]!.why).toBeGreaterThan(20)
      expect(inert[3]!.why).toBeGreaterThan(20)

      // ...and activating one does nothing, rather than nothing-that-looks-like-something.
      // dispatchEvent, not click(): Playwright's own actionability check treats aria-disabled as
      // disabled and would wait forever -- which is itself a small proof the attribute reads the
      // way it is meant to.
      await page.locator('.fl-stat-carved').dispatchEvent('click')
      expect(await page.locator('.fl-stat-carved').getAttribute('aria-pressed')).toBe('false')
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Block textures')!
        ;(row.querySelector('input') as HTMLInputElement).click()
      })
      await page.waitForTimeout(100)

      // ONE STATE, ONE ANSWER. With the preference on and no atlas, the sidebar checkbox read
      // checked=true while the toolbar button read pressed=false, for the same setting.
      const agreement = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Block textures')!
        const checkbox = row.querySelector('input') as HTMLInputElement
        const button = [...document.querySelectorAll('.fl-vp-btn')].find((b) => /texture|flat colours/i.test(b.getAttribute('aria-label') ?? ''))!
        return { checked: checkbox.checked, pressed: button.getAttribute('aria-pressed') }
      })
      expect(String(agreement.checked)).toBe(agreement.pressed)
    } finally {
      await page.close()
    }
  }, 90_000)

  // ---------------------------------------------------------------------------------------
  // panel.css had no forced-colors block at all, and .fl-vp-btn-on's only marker is an
  // `inset 0 -2px` box-shadow, which computes to `none` under forced colors: Grid, Textures and
  // Projection all looked identical on and off. aria-pressed survived; the picture did not.
  // ---------------------------------------------------------------------------------------
  it('still shows which viewport toggles are on under forced colors', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, forcedColors: 'active' })
    try {
      await page.goto(`http://127.0.0.1:${server.port}/`)
      await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
      await page.evaluate((result) => {
        window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
        window.postMessage({ type: 'result', result }, '*')
      }, loadAugmentedFixture())
      await page.waitForTimeout(350)

      const grid = page.locator('.fl-vp-btn[aria-label^="Grid"]')
      expect(await grid.getAttribute('aria-pressed')).toBe('true')
      const on = await grid.evaluate((el) => {
        const style = getComputedStyle(el)
        return { boxShadow: style.boxShadow, background: style.backgroundColor, color: style.color }
      })
      // The box-shadow is gone (forced colors drops it) -- so the on-state has to be said with
      // something forced colors keeps. A system-colour fill is that something.
      await grid.click()
      await page.waitForTimeout(150)
      const off = await grid.evaluate((el) => {
        const style = getComputedStyle(el)
        return { boxShadow: style.boxShadow, background: style.backgroundColor, color: style.color }
      })
      expect(await grid.getAttribute('aria-pressed')).toBe('false')
      // Whatever the system palette is, ON and OFF must not paint the same.
      expect(`${on.background}|${on.color}`).not.toBe(`${off.background}|${off.color}`)
    } finally {
      await page.close()
    }
  }, 90_000)
})

// ---- accessibility, measured off the pixels and off the accessibility tree --------------------
// ==============================================================================================
// THE SUITE ABOVE PASSED WHILE THREE OF ITS SURFACES WERE UNREADABLE, and the reason is worth
// keeping: `measureContrast` resolves getComputedStyle(el).color and composites it over the
// nearest opaque ancestor background. An element's own `opacity` appears in NEITHER of those --
// it is a compositing step applied after both -- so .fl-diag-type (`opacity: 0.7`) and
// .fl-diag-file (`opacity: 0.55`) were reported at their row's 5.06:1 while they were painting
// 2.89:1 and 2.23:1. The same blindness hid .fl-vp-scale, which sits on a <canvas> that has no
// CSS background for an ancestor walk to find (see viewport.test.ts for that one).
//
// Everything below is therefore measured from a SCREENSHOT of the element -- see
// frontend/test/fixtures/pixelContrast.ts for the decoder, the modal-background rule, and why
// the capture is at deviceScaleFactor 2 -- and the ratio is COMPUTED with the WCAG formula
// rather than compared against a remembered hex.

/** A preset list with one entry that builds no sea, so the three Materials sea slots go inert.
 * Posted rather than assumed: presetBuildsSea() answers "yes" while the list is empty, so a
 * panel that has not been told which presets build a sea greys nothing out. */
const NO_SEA_ENVIRONMENTS = [
  {
    id: 'solid',
    label: 'Solid',
    description: 'A solid block of stone.',
    defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 0 },
    materials: { topMaterial: 'minecraft:grass_block', midMaterial: 'minecraft:dirt', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 3 },
    buildsSea: false,
    biomeTags: [],
  },
  {
    id: 'ocean',
    label: 'Ocean',
    description: 'An ocean.',
    defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 0 },
    materials: { topMaterial: 'minecraft:sand', midMaterial: 'minecraft:sand', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 3 },
    buildsSea: true,
    biomeTags: [],
  },
]

interface Painted {
  selector: string
  text: string
  fg: string
  bg: string
  size: number
  ratio: number
  need: number
  pass: boolean
}

/** Screenshots every element matching `selectors` and reads the contrast out of its own pixels.
 * Playwright scrolls each element into view for its screenshot, which is what lets this reach
 * the Diagnostics rows at the far end of a scrolling sidebar -- a whole-page screenshot clipped
 * to a bounding box silently measures NOTHING for anything below the fold, and an empty
 * measurement trivially has no failures in it. */
async function measurePainted(page: Page, selectors: readonly string[]): Promise<Painted[]> {
  const out: Painted[] = []
  for (const selector of selectors) {
    for (const handle of await page.locator(selector).elementHandles()) {
      const meta = await handle.evaluate((node: Node) => {
        const el = node as Element
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return { width: rect.width, height: rect.height, text: (el.textContent ?? '').trim().slice(0, 44), size: parseFloat(style.fontSize), weight: style.fontWeight }
      })
      if (meta.width === 0 || meta.height === 0) continue
      const measured = contrastOfImage(decodePng(await handle.screenshot({ type: 'png' })))
      if (measured === null) continue
      const need = requiredRatio(meta.size, meta.weight)
      out.push({ selector, text: meta.text, fg: measured.fg, bg: measured.bg, size: meta.size, ratio: measured.ratio, need, pass: measured.ratio >= need })
    }
  }
  return out
}

function paintFailures(painted: readonly Painted[]): string[] {
  return painted.filter((p) => !p.pass).map((p) => `${p.selector} "${p.text}" ${p.fg} on ${p.bg} = ${String(p.ratio)}:1 (needs ${String(p.need)}:1 at ${String(p.size)}px)`)
}

describe('panel.ts accessibility, measured off rendered pixels', () => {
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

  /** A loaded webview in one of VS Code's real token sets, every section open, and every control
   * this panel can make inert actually inert. */
  async function loadInert(tokens: Readonly<Record<string, string>>, scheme: 'dark' | 'light'): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 15_000 })
    // CSSOM writes, not a <style> block: the shell's CSP is real here, and this is the one route
    // for custom properties that a nonce-based style-src does not block.
    await page.evaluate((vars: Record<string, string>) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
      document.body.style.backgroundColor = vars['--vscode-editor-background'] ?? ''
    }, tokens as Record<string, string>)
    await page.evaluate((result) => {
      window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
      window.postMessage({ type: 'result', result }, '*')
    }, loadAugmentedFixture())
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      document.querySelectorAll('.fl-section.fl-collapsed .fl-section-header').forEach((el) => (el as HTMLElement).click())
    })
    await page.evaluate((envs) => { window.postMessage({ type: 'environments', environments: envs }, '*') }, NO_SEA_ENVIRONMENTS)
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const rowWith = (label: string): Element | undefined => [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === label)
      const preset = rowWith('Preset')?.querySelector('select')
      if (preset) {
        preset.value = 'solid'
        preset.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const profiling = rowWith('Enable profiling')?.querySelector('input')
      if (profiling?.checked === true) profiling.click()
    })
    // Changing the preset asks the HOST to regenerate, and this harness is not a host: with no
    // answer the readout keeps its busy pulse (@keyframes fl-pulse-dim), and every chip measured
    // below would be a snapshot of an ANIMATION rather than of a stylesheet -- the same figure
    // read 1.56:1, 1.75:1 and 2.02:1 on three consecutive runs before this line existed.
    // Re-posting the result lands the panel back on a finished run.
    await page.evaluate((result) => { window.postMessage({ type: 'result', result }, '*') }, loadAugmentedFixture())
    await page.waitForFunction(() => document.querySelector('.fl-readout-busy') === null, null, { timeout: 15_000 })
    await page.waitForTimeout(300)
    return page
  }

  for (const [name, tokens, scheme] of [
    ['Light Modern', PX_LIGHT, 'light'],
    ['Dark Modern', PX_DARK, 'dark'],
  ] as const) {
    // -------------------------------------------------------------------------------------
    // A DIAGNOSTIC ROW HAS ALREADY SPENT ITS CONTRAST BUDGET ON HUE. --fl-warning-text-fg is
    // 5.06:1 on the row's own tint in Light Modern -- which passes, and leaves nothing over.
    // Quieting the second-rank text inside that row with `opacity: 0.7` / `0.55` took the type
    // to 2.89:1 and the file to 2.23:1, the chain to 3.15:1 and its `>` separator to 1.53:1.
    // Rank inside these rows is now said with the font sizes that were always there -- see
    // panel.css's --fl-diag-quiet-fg.
    // -------------------------------------------------------------------------------------
    it(`paints every part of a diagnostic row as readable text in ${name}`, async () => {
      const page = await loadInert(tokens, scheme)
      try {
        const painted = await measurePainted(page, ['.fl-diag-text', '.fl-diag-type', '.fl-diag-file', '.fl-diag-chain-seg', '.fl-diag-chain-sep', '.fl-section-header-warning .fl-section-title-text'])
        // The fixture has to actually contain rows with a type, a file and a chain, or this
        // proves nothing: a selector that matches nothing has no failures in it.
        expect(painted.filter((p) => p.selector === '.fl-diag-type').length).toBeGreaterThan(0)
        expect(painted.filter((p) => p.selector === '.fl-diag-file').length).toBeGreaterThan(0)
        expect(painted.filter((p) => p.selector === '.fl-diag-chain-sep').length).toBeGreaterThan(0)
        expect(paintFailures(painted)).toEqual([])
      } finally {
        await page.close()
      }
    }, 120_000)

    // -------------------------------------------------------------------------------------
    // QUIET IS NOT UNREADABLE, and `opacity` is how "quiet" becomes "gone": it composites, so
    // two quieting rules on one element MULTIPLY. An inert row's label carried 0.85 (every row
    // label) times 0.45 (the inert rule) and measured 2.40:1 light / 3.23:1 dark -- on the label
    // of the very control whose explanation the reader had been sent to find.
    // -------------------------------------------------------------------------------------
    it(`keeps every quieted and inert surface readable in ${name}`, async () => {
      const page = await loadInert(tokens, scheme)
      try {
        const painted = await measurePainted(page, [
          '.fl-stat[aria-disabled="true"] .fl-stat-value',
          '.fl-row-inert > .fl-row-label',
          '.fl-row-inert .fl-text-input',
          '.fl-row-inert .fl-num-input',
          '.fl-note',
          '.fl-vp-btn[aria-disabled="true"]',
        ])
        // Five inert rows (three sea slots, Block textures, Show heatmap), one inert toolbar
        // button and the texture note. Without these counts, a `loadInert` that stopped reaching
        // the inert state would measure nothing and pass.
        expect(painted.filter((p) => p.selector === '.fl-row-inert > .fl-row-label').length).toBe(5)
        expect(painted.filter((p) => p.selector === '.fl-note').length).toBeGreaterThan(0)
        expect(painted.filter((p) => p.selector === '.fl-vp-btn[aria-disabled="true"]').length).toBe(1)
        expect(paintFailures(painted)).toEqual([])
      } finally {
        await page.close()
      }
    }, 120_000)
  }

  // ---------------------------------------------------------------------------------------
  // THE POINT OF aria-disabled IS THAT THE REASON STAYS READABLE, and half the change had not
  // landed. Measured on the built bundle: the three Materials sea slots were still `disabled`
  // and so still out of the tab order; "Show heatmap" and "Block textures" had become
  // aria-disabled but their computed accessible DESCRIPTION was the empty string, because the
  // sentence lived in a `title` on the wrapping row <div> -- which is neither their name nor
  // their description -- and the texture note that holds the real sentence had no `id` for
  // anything to point at. Both groups were unreadable, in opposite ways.
  // ---------------------------------------------------------------------------------------
  it('leaves every inert control focusable AND carrying the reason it is inert', async () => {
    const page = await loadInert(PX_DARK, 'dark')
    try {
      const inert = await page.evaluate(() => {
        const labelled = (label: string): HTMLInputElement =>
          [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === label)!.querySelector('input')!
        /** aria-describedby resolved the way an AT resolves it: a target that is display:none
         * contributes NOTHING, which is the state both checkboxes were in. */
        const description = (el: HTMLElement): string =>
          (el.getAttribute('aria-describedby') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => {
              const target = document.getElementById(id)
              if (target === null || target.hidden || getComputedStyle(target).display === 'none') return ''
              return (target.textContent ?? '').trim()
            })
            .join(' ')
            .trim()
        const accName = (el: HTMLElement): string =>
          el.getAttribute('aria-label') ?? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '').trim()
        // Everything actually in the document's tab order right now.
        const tabOrder = [...document.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href], [tabindex]')].filter(
          (el) => el.tabIndex >= 0 && !(el as HTMLInputElement).disabled && el.offsetParent !== null,
        )
        return ['Sea floor material', 'Sea material', 'Sea floor depth', 'Block textures', 'Show heatmap'].map((label) => {
          const el = labelled(label)
          return {
            label,
            disabled: el.disabled,
            ariaDisabled: el.getAttribute('aria-disabled'),
            readOnly: el.readOnly,
            reachable: tabOrder.includes(el),
            name: accName(el),
            description: description(el),
          }
        })
      })
      expect(inert.length).toBe(5)
      for (const control of inert) {
        // Inert says so with ARIA; it does not leave the page.
        expect(control.disabled, control.label).toBe(false)
        expect(control.ariaDisabled, control.label).toBe('true')
        expect(control.reachable, control.label).toBe(true)
        expect(control.name, control.label).toBe(control.label)
        // A SENTENCE, not a word: every one of these reasons is prose, and an empty string -- or
        // a description pointing at a display:none element -- is exactly what was shipping.
        expect(control.description.length, `${control.label} has no accessible description`).toBeGreaterThan(20)
      }
      // The texture checkbox is described FROM the visible note, so what an AT reads out and what
      // a sighted reader sees are one sentence rather than two that can drift apart.
      const note = await page.evaluate(() => {
        const el = document.getElementById('fl-texture-note')
        const checkbox = [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Block textures')!.querySelector('input')!
        return { onScreen: el !== null && getComputedStyle(el).display !== 'none', text: (el?.textContent ?? '').trim(), describedby: checkbox.getAttribute('aria-describedby') }
      })
      expect(note.onScreen).toBe(true)
      expect(note.describedby).toBe('fl-texture-note')
      expect(note.text).toContain('flat colour')

      // ...and the three sea slots, which the panel deliberately writes no paragraph for, refuse
      // an edit without going silent: readonly, not disabled. aria-disabled alone would announce
      // "unavailable" over a box that still accepted typing.
      const kept = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.fl-row-label')?.textContent === 'Sea material')!.querySelector('input')!
        el.focus()
        return { focused: document.activeElement === el, readOnly: el.readOnly, value: el.value }
      })
      expect(kept.focused).toBe(true)
      expect(kept.readOnly).toBe(true)
      // The reason promises the value is KEPT; an empty box would make that a lie.
      expect(kept.value.length).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  }, 120_000)
})
