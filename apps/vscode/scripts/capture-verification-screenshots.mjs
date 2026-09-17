// capture-verification-screenshots.mjs -- ad hoc verification screenshots for this repo's five
// (now six) UI fixes, captured against the REAL apps/vscode/src/previewPanel.ts::renderShellHtml
// shell (genuine CSP meta, real dist/webview.js bundle) via a real Chromium page -- same harness
// scripts/capture-screenshots.mjs and test/panelLayout.test.ts already use. NOT part of the
// regular docs/panel-*.png set; written to verify panel fixes by eye and left here as a
// repeatable command rather than a one-off manual process.
//
// Usage: node scripts/capture-verification-screenshots.mjs   (run from apps/vscode/, after
// `npm run compile`)
import { chromium } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import { createReadStream } from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')
const outDir = path.join(dir, '..', 'docs', 'verification')
const fixturePath = path.join(dir, '..', '..', '..', 'frontend', 'test', 'fixtures', 'wiki-ceiling-patch-with-entries.json')
const previewPanelPath = path.join(dir, '..', 'src', 'previewPanel.ts')

const VSCODE_STUB = `
  export const window = {};
  export const workspace = { getConfiguration: () => ({ get: (_k, d) => d }) };
  export const languages = {};
  export class Uri {
    static file(p) { return { fsPath: p } }
    static joinPath(base, ...segments) { return { fsPath: [base.fsPath, ...segments].join('/') } }
  }
  export const ViewColumn = { Beside: 2 };
  export class Diagnostic {}
  export const DiagnosticSeverity = { Error: 0, Warning: 1 };
  export class Range {}
`

const vscodeStubPlugin = {
  name: 'vscode-stub',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'vscode-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'vscode-stub' }, () => ({ contents: VSCODE_STUB, loader: 'js' }))
  },
}

async function loadRenderShellHtml() {
  const result = await esbuild.build({
    entryPoints: [previewPanelPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [vscodeStubPlugin],
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling previewPanel.ts')
  const tmpFile = path.join(os.tmpdir(), `previewPanel-shell-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await fsPromises.writeFile(tmpFile, output.text, 'utf-8')
  try {
    const mod = await import(pathToFileURL(tmpFile).href)
    if (typeof mod.renderShellHtml !== 'function') {
      throw new Error('bundled previewPanel.ts did not export renderShellHtml')
    }
    return mod.renderShellHtml
  } finally {
    await fsPromises.unlink(tmpFile).catch(() => {})
  }
}

const NONCE = 'capture-verification-nonce'
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

function startServer(renderShellHtml) {
  let port = 0
  const server = http.createServer((req, res) => {
    if (!req.url || req.url === '/') {
      const cspSource = `http://127.0.0.1:${port}`
      const html = renderShellHtml({ nonce: NONCE, cspSource, scriptUri: `${cspSource}/webview.js`, styleUri: `${cspSource}/webview.css` })
      const withBootstrap = html.replace(
        '</body>',
        `<script nonce="${NONCE}">window.acquireVsCodeApi = function () { return { postMessage: function () {} }; };</script></body>`,
      )
      res.setHeader('Content-Type', 'text/html')
      res.end(withBootstrap)
      return
    }
    const filePath = path.join(distDir, req.url.split('?')[0])
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
      port = server.address().port
      resolve({ port, close: () => server.close() })
    })
  })
}

/** Same augmented fixture capture-screenshots.mjs/panelLayout.test.ts use (the capture's own
 * real diagnostics, one in each wire shape, plus the synthetic Pack biome entry the wiki example
 * pack cannot supply), PLUS a third, SYNTHETIC diagnostic whose text matches session.go's own
 * write-budget-exceeded message (the budget quick-fix button) so that control has something to
 * render against -- no feature in the wiki example pack diverges hard enough to blow the default
 * write budget, so this one cannot come from a capture. */
function loadAugmentedFixture() {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8'))
  raw.diagnostics = [
    ...raw.diagnostics,
    {
      level: 'error',
      fileId: 'vegetation_patch_ceiling_demo.json',
      identifier: 'wiki:vegetation_patch_ceiling_demo',
      typeId: 'minecraft:aggregate_feature',
      chain: ['wiki:vegetation_patch_ceiling_demo'],
      count: 1,
      position: null,
      message:
        'write budget hit at 4000001 of 4000000 block writes; 2 repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result',
    },
  ]
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

async function loadReady(browser, viewport, opts = {}) {
  const page = await browser.newPage({ viewport, colorScheme: opts.colorScheme ?? 'dark' })
  await page.goto(`http://127.0.0.1:${globalThis.__port}/`)
  await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 10_000 })
  await page.waitForTimeout(500)
  const fixture = loadAugmentedFixture()
  const environments = [
    {
      id: 'plains',
      label: 'Plains',
      description: 'Gently rolling grass over dirt and stone.',
      defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 },
      materials: { topMaterial: 'minecraft:grass_block', midMaterial: 'minecraft:dirt', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 0 },
      biome: 'plains',
      biomeTags: ['animal', 'monster', 'overworld', 'plains', 'bee_habitat'],
    },
  ]
  await page.evaluate(
    ({ result, environments }) => {
      window.postMessage({ type: 'init', kind: 'feature', identifier: 'wiki:vegetation_patch_ceiling_demo' }, '*')
      window.postMessage({ type: 'environments', environments }, '*')
      window.postMessage({ type: 'result', result }, '*')
    },
    { result: fixture, environments },
  )
  await page.waitForTimeout(900)
  return page
}

async function expandSection(page, sectionId) {
  await page.evaluate((id) => {
    const section = document.querySelector(`.fl-section[data-section-id="${id}"]`)
    if (section && section.classList.contains('fl-collapsed')) section.querySelector('.fl-section-header').click()
  }, sectionId)
  await page.waitForTimeout(100)
}

async function main() {
  await fsPromises.mkdir(outDir, { recursive: true })
  const renderShellHtml = await loadRenderShellHtml()
  const server = await startServer(renderShellHtml)
  globalThis.__port = server.port
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })

  try {
    // 1. Rule mode showing the RULE as the active thing, feature metadata hidden.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await page.click('input[type=radio][name="fl-preview-mode"][value=rule]')
      await page.waitForTimeout(150)
      const el = await page.$('.fl-section[data-section-id="feature"]')
      await el.screenshot({ path: path.join(outDir, '1-rule-mode.png') })
      await page.close()
    }

    // 2. Busy state: fire a config change (no reply ever arrives from this harness's
    //    no-op postMessage stub, exactly like a request that's still in flight) and screenshot
    //    the dimmed/pending stat tiles + busy banner + dimmed canvas, all at once.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await page.evaluate(() => {
        const sizeInputs = [...document.querySelectorAll('.fl-row')].filter((r) => r.querySelector('.fl-row-label')?.textContent === 'Size X')
        const input = sizeInputs[0].querySelector('input')
        input.value = '40'
        input.dispatchEvent(new Event('change'))
      })
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(outDir, '2-busy-state.png') })
      await page.close()
    }

    // 3. The budget diagnostic's quick-fix button, showing which budget and to what
    //    value, in the Diagnostics section.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await expandSection(page, 'diagnostics')
      const el = await page.$('.fl-section[data-section-id="diagnostics"]')
      await el.screenshot({ path: path.join(outDir, '3-budget-quick-fix.png') })
      await page.close()
    }

    // 4a/4b. The position button's text, dark theme then light theme.
    for (const [scheme, name] of [
      ['dark', '4a-position-button-dark.png'],
      ['light', '4b-position-button-light.png'],
    ]) {
      const page = await loadReady(browser, { width: 1400, height: 900 }, { colorScheme: scheme })
      await expandSection(page, 'diagnostics')
      const el = await page.$('.fl-section[data-section-id="diagnostics"]')
      await el.screenshot({ path: path.join(outDir, name) })
      await page.close()
    }

    // 5. Dolly the camera way out (large repeated wheel scroll on the canvas) and
    //    confirm the scene is STILL visible, not vanished past a stale far plane.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      const canvas = await page.$('#fl-canvas')
      const box = await canvas.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      // Large repeated scroll -- OrbitControls' wheel-to-dolly, well past the original framing
      // distance (the exact scenario the old fixed-far-plane code broke).
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, 400)
        await page.waitForTimeout(10)
      }
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(outDir, '5-zoomed-out.png') })
      await page.close()
    }

    // 6. The Min Y (cut) / Max Y (cut) labels, and the ratchet fix: cut narrow, force
    //    a narrower-then-wider pair of results, confirm the cut is restored not stuck.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await expandSection(page, 'view')
      // Drag the Max Y (cut) slider down to demonstrate a real user cut.
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.fl-row')]
        const maxRow = rows.find((r) => r.querySelector('.fl-row-label')?.textContent === 'Max Y (cut)')
        const input = maxRow.querySelector('input[type=range]')
        input.value = String(Number(input.min) + 5)
        input.dispatchEvent(new Event('input'))
      })
      await page.waitForTimeout(150)
      const el = await page.$('.fl-section[data-section-id="view"]')
      await el.screenshot({ path: path.join(outDir, '6-slice-labels.png') })
      await page.close()
    }

    // 7. Sticky grow-to-fit: turn it on (banner appears immediately, before any grown
    //    result), then feed a NON-grown result and confirm the banner stays up rather than
    //    hiding (the reported bug, one level up from the single-request grow button).
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.fl-row')]
        const growRow = rows.find((r) => r.querySelector('.fl-row-label')?.textContent === 'Grow every run')
        const checkbox = growRow.querySelector('input')
        checkbox.checked = true
        checkbox.dispatchEvent(new Event('change'))
      })
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(outDir, '7a-grow-sticky-on-before-result.png') })

      // Feed a result that needed no growth at all -- this is the exact scenario the old code
      // silently hid the banner for.
      const nonGrownResult = { ...loadAugmentedFixture(), grown: false, preGrowBounds: null }
      await page.evaluate((result) => {
        window.postMessage({ type: 'result', result }, '*')
      }, nonGrownResult)
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(outDir, '7b-grow-sticky-on-nongrown-result.png') })
      await page.close()
    }

    console.log('Verification screenshots written to', outDir)
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
