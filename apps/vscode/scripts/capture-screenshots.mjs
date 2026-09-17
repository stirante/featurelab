// capture-screenshots.mjs -- re-captures apps/vscode/docs/panel-*.png against the REAL built
// webview bundle (dist/webview.js/.css -- run `npm run compile` first) via a real Chromium page,
// the same harness apps/vscode/test/panelLayout.test.ts already drives for its layout/clipping
// assertions -- this script exists so "re-capture the screenshots" is a repeatable command
// instead of a one-off manual process no later change can easily reproduce.
//
// Usage: node scripts/capture-screenshots.mjs   (run from apps/vscode/)
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
const docsDir = path.join(dir, '..', 'docs')
const fixturePath = path.join(dir, '..', '..', '..', 'frontend', 'test', 'fixtures', 'wiki-ceiling-patch-with-entries.json')
const previewPanelPath = path.join(dir, '..', 'src', 'previewPanel.ts')

// The served HTML comes from the REAL apps/vscode/src/previewPanel.ts::renderShellHtml() --
// see that export's own doc comment -- bundled with esbuild here exactly the way
// test/fixtures/shellHtml.ts does for the vitest suites (panelLayout.test.ts,
// splitterLayout.test.ts, webviewShell.test.ts), stubbing only its 'vscode' import (which
// renderShellHtml itself never touches). This is what keeps the screenshots this script
// produces provably faithful to what real VS Code renders: a hand-copied duplicate of the shell
// HTML -- what this script used to embed -- is exactly what let the CSP bug (no nonce on the
// inline layout <style>, silently dropped by real VS Code) go unnoticed through repeated
// "verified by screenshot" rounds.
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
  const tmpFile = path.join(os.tmpdir(), `previewPanel-shell-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

// See test/webviewShell.test.ts's own NONCE comment for why this harness still needs its own
// window.acquireVsCodeApi bootstrap, stamped with the same nonce renderShellHtml is called
// with (real VS Code injects that global itself; nothing here is exempt from the meta CSP tag's
// script-src, which this harness genuinely enforces the same as real VS Code).
const NONCE = 'capture-screenshots-nonce'

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

function startServer(renderShellHtml) {
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

/** Same augmented fixture panelLayout.test.ts's own loadAugmentedFixture() builds (kept in
 * sync by hand -- see that function's own doc comment for why the one addition is there): the
 * fixture's own real 44 features / 2 rules / 2 diagnostics (one in each diagnostic wire shape,
 * see the fixture's provenance comment in frontend/test/protocol.test.ts), plus a synthetic Pack
 * biome entry -- the wiki example pack ships no biomes/ directory at all, so that section has no
 * real row this capture could show otherwise. */
function loadAugmentedFixture() {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8'))
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

async function loadReady(browser, viewport) {
  const page = await browser.newPage({ viewport })
  await page.goto(`http://127.0.0.1:${globalThis.__port}/`)
  await page.waitForSelector('#fl-sidebar .fl-section', { timeout: 10_000 })
  // SwiftShader (software WebGL, see this script's launch args) loses its context on startup
  // and auto-restores shortly after -- give it time to settle BEFORE posting a result, or the
  // very first render can land mid-restore and paint nothing.
  await page.waitForTimeout(500)
  const fixture = loadAugmentedFixture()
  // Mirrors env/environment.go's real 'plains' preset defaults (same fixture
  // frontend/test/panel.test.ts's makeEnvironments() uses) -- without this the Environment/
  // Materials sections show their "nothing loaded yet" placeholder state, which is accurate for
  // this synthetic harness but less representative of what a real preview looks like.
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
  // Flat block colours, asserted rather than assumed. These PNGs are committed, so what they
  // look like must not depend on whether the machine re-capturing them happens to have a block
  // atlas built. Nothing here posts an `atlas` message and the webview only turns textures on
  // when it receives one (webview/main.ts) -- but that is a property worth failing loudly on
  // if it ever stops holding, rather than discovering as five screenshots that quietly changed.
  const textured = await page.evaluate(() => Boolean(window.__flViewer?.getTexturesEnabled?.()))
  if (textured) {
    throw new Error('capture-screenshots: the webview is rendering with block textures; these screenshots are committed and must render identically everywhere')
  }
  return page
}

async function setAllSections(page, collapsed) {
  await page.evaluate((wantCollapsed) => {
    document.querySelectorAll('.fl-section').forEach((el) => {
      const isCollapsed = el.classList.contains('fl-collapsed')
      if (isCollapsed !== wantCollapsed) el.querySelector('.fl-section-header').click()
    })
  }, collapsed)
  await page.waitForTimeout(150)
}

async function main() {
  const renderShellHtml = await loadRenderShellHtml()
  const server = await startServer(renderShellHtml)
  globalThis.__port = server.port
  // --enable-unsafe-swiftshader: modern Chromium refuses software WebGL without this flag
  // (SwiftShader alone, as panelLayout.test.ts's own launch args use, is enough for THAT
  // suite because it never actually renders/screenshots the canvas -- only DOM layout). This
  // script needs the canvas to really paint, so it needs the extra flag.
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })

  try {
    // 1. panel-full-view.png -- default state (nothing collapsed, nothing scrolled), full page.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await page.screenshot({ path: path.join(docsDir, 'panel-full-view.png') })
      await page.close()
    }

    // 2. panel-sidebar-hidden.png -- splitter collapsed (canvas full-width).
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await page.click('.fl-splitter-toggle')
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(docsDir, 'panel-sidebar-hidden.png') })
      await page.close()
    }

    // 3. panel-sidebar-collapsed.png -- every SECTION collapsed (not the splitter), cropped to
    //    just the #fl-sidebar element.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await setAllSections(page, true)
      const el = await page.$('#fl-sidebar')
      await el.screenshot({ path: path.join(docsDir, 'panel-sidebar-collapsed.png') })
      await page.close()
    }

    // 4. panel-sidebar-expanded.png -- every section expanded, cropped to the full (scrollable)
    //    height of #fl-sidebar. #fl-sidebar's own box is `height: 100%` of the (viewport-sized)
    //    #fl-root flex row with `overflow-y: auto` -- an element screenshot only captures an
    //    element's own rendered BOX, not content hidden behind its internal scroll, so this
    //    grows the viewport to the content's natural scrollHeight first (removing the need for
    //    internal scrolling entirely) rather than taking an element screenshot at the normal
    //    900px viewport height, which would silently crop to whatever fit on screen.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await setAllSections(page, false)
      const contentHeight = await page.evaluate(() => document.getElementById('fl-sidebar').scrollHeight)
      await page.setViewportSize({ width: 1400, height: contentHeight + 20 })
      await page.waitForTimeout(150)
      const el = await page.$('#fl-sidebar')
      await el.screenshot({ path: path.join(docsDir, 'panel-sidebar-expanded.png') })
      await page.close()
    }

    // 5. panel-narrow-width.png -- a narrower overall window, default section state.
    {
      const page = await loadReady(browser, { width: 700, height: 800 })
      await page.screenshot({ path: path.join(docsDir, 'panel-narrow-width.png') })
      await page.close()
    }

    console.log('Screenshots written to', docsDir)
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
