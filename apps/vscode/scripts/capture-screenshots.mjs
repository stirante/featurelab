// capture-screenshots.mjs -- re-captures apps/vscode/docs/panel-*.png against the REAL built
// webview bundle (dist/webview.js/.css -- run `npm run compile` first) via a real Chromium page,
// the same harness apps/vscode/test/panelLayout.test.ts already drives for its layout/clipping
// assertions -- this script exists so "re-capture the screenshots" is a repeatable command
// instead of a one-off manual process no later change can easily reproduce.
//
// Usage: node scripts/capture-screenshots.mjs [--out <dir>]   (run from apps/vscode/)
//        --out writes elsewhere, for checking a change without overwriting the committed images.
//
// Each shot gets its OWN page (see loadReady/page.close below) and there is no shared browser
// state between them. That is deliberate and worth keeping: the sibling script
// capture-graph-screenshots.mjs drove every shot from one long-lived page, an overlay that
// refused to close on Escape stayed up for the rest of the run, and two of its images shipped
// showing a surface that belonged to an earlier step.
//
// Every shot is MEASURED after it is written, against the viewport for a page shot and against
// the element's own box for a cropped one (shotPage/shotElement below). That sibling script had
// spelled Playwright's `viewport` option `viewportSize`; the key is unknown, unknown keys in that
// bag are discarded in silence, and so every graph-*.png ever committed was Chromium's 1280x720
// default under a script that said 1440x900. This script's own option name happened to be right,
// which is not the same as being checked -- and the shot most at risk here is a different one:
// panel-sidebar-expanded.png is an ELEMENT screenshot of a scrollable box, and an element
// screenshot silently crops to the rendered box, so the one thing worth failing on is the image
// coming out shorter than the content the viewport was grown to fit.
import { chromium } from 'playwright'
import * as esbuild from 'esbuild'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import { createReadStream } from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(dir, '..', 'dist')
const outFlag = process.argv.indexOf('--out')
const docsDir = outFlag === -1 ? path.join(dir, '..', 'docs') : path.resolve(process.argv[outFlag + 1] ?? '')
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

/** The size a PNG actually is, read off its IHDR chunk: 8-byte signature, a length and the 'IHDR'
 * tag, then width and height as big-endian uint32 at offsets 16 and 20.
 *
 * Measured from the FILE, not asked of the page. `page.viewportSize()` reports what Playwright was
 * told, and being told the wrong thing is the failure this exists to catch. */
function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24)
  if (head.length < 24 || head.toString('latin1', 1, 8) !== 'PNG\r\n\n' || head.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error(`capture-screenshots: ${file} is not a PNG`)
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/** A full-page shot, checked against the size that was ASKED FOR.
 *
 * Not against `page.viewportSize()`, which is the trap this check exists to avoid. That reports
 * the viewport the page ended up with -- so when the option is dropped and the page is 1280x720,
 * the file is 1280x720 too and the two agree perfectly about the wrong number. Verified the hard
 * way: with the `viewportSize` typo deliberately reintroduced, the viewportSize()-based version of
 * this function passed all five shots. `loadReady` records what the caller asked for, and that is
 * the only number here with any independence from the fault. */
async function shotPage(page, name) {
  const file = path.join(docsDir, `${name}.png`)
  await page.screenshot({ path: file })
  const want = page.__wantedViewport
  const got = pngSize(file)
  if (got.width !== want.width || got.height !== want.height) {
    throw new Error(
      `capture-screenshots: ${name}.png came out ${got.width}x${got.height}, not the ${want.width}x${want.height} ` +
        'viewport it was taken at. The image is not of the page this script describes.',
    )
  }
}

/** A cropped shot of one element, checked against that element's own rendered box.
 *
 * The box is the right yardstick rather than the viewport: these two shots are deliberately not
 * viewport-sized. What they must not be is SHORTER than the element -- an element screenshot
 * captures the rendered box and nothing behind an internal scroll, so a sidebar that stopped
 * being grown to its content would come out quietly truncated and look like nothing had changed.
 * A pixel of rounding is allowed; a cropped section is not. */
async function shotElement(page, selector, name) {
  const el = await page.$(selector)
  if (el === null) throw new Error(`capture-screenshots: ${name}.png needs ${selector}, which is not on the page.`)
  const box = await el.boundingBox()
  const file = path.join(docsDir, `${name}.png`)
  await el.screenshot({ path: file })
  const got = pngSize(file)
  if (Math.abs(got.width - box.width) > 1 || Math.abs(got.height - box.height) > 1) {
    throw new Error(
      `capture-screenshots: ${name}.png came out ${got.width}x${got.height} for a ${selector} whose box is ` +
        `${Math.round(box.width)}x${Math.round(box.height)}. The image is a crop of the element, not the element.`,
    )
  }
}

async function loadReady(browser, viewport) {
  // `viewport`, NOT `viewportSize`: Playwright discards an unknown key in this bag without a word,
  // and the sibling graph script spent its whole life capturing at 1280x720 through that typo.
  // Asked for here, confirmed here, and confirmed again on each written file.
  const page = await browser.newPage({ viewport })
  const applied = page.viewportSize()
  if (applied?.width !== viewport.width || applied?.height !== viewport.height) {
    throw new Error(
      `capture-screenshots: asked for a ${viewport.width}x${viewport.height} page and got ` +
        `${applied?.width}x${applied?.height}. The option Playwright wants has changed name; every shot from ` +
        'this run would be the wrong size.',
    )
  }
  // What was ASKED for, carried on the page so shotPage can check the written file against a
  // number that does not come from the browser. See shotPage.
  page.__wantedViewport = viewport
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

/** The newest modification time under a directory, .ts files only. */
function newestSource(where) {
  let newest = 0
  for (const entry of readdirSync(where, { withFileTypes: true })) {
    const full = path.join(where, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(full))
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}

/** Refuses to photograph a build older than the sources it came from.
 *
 * "Run `npm run compile` first" is in this file's header, and a header is not a check. A compile
 * that FAILS leaves the previous dist/webview.js exactly where it was, so the obvious
 * `npm run compile && node scripts/capture-screenshots.mjs` still yields five confident
 * screenshots of the build before the one being reviewed -- which is the same fault as
 * photographing the wrong document, arrived at from the other end. */
function requireFreshBundle() {
  const bundle = path.join(distDir, 'webview.js')
  if (!existsSync(bundle)) {
    throw new Error('capture-screenshots: dist/webview.js is missing. Run `npm run compile` first.')
  }
  const newest = Math.max(newestSource(path.join(dir, '..', 'src')), newestSource(path.join(dir, '..', 'webview')))
  if (newest > statSync(bundle).mtimeMs) {
    throw new Error(
      'capture-screenshots: dist/webview.js is older than the sources it is built from, so every shot would ' +
        'photograph a build nobody is running. Run `npm run compile` and check that it SUCCEEDS -- a failed ' +
        'compile leaves the previous bundle in place.',
    )
  }
}

async function main() {
  requireFreshBundle()
  await fsPromises.mkdir(docsDir, { recursive: true })
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
      await shotPage(page, 'panel-full-view')
      await page.close()
    }

    // 2. panel-sidebar-hidden.png -- splitter collapsed (canvas full-width).
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await page.click('.fl-splitter-toggle')
      await page.waitForTimeout(150)
      await shotPage(page, 'panel-sidebar-hidden')
      await page.close()
    }

    // 3. panel-sidebar-collapsed.png -- every SECTION collapsed (not the splitter), cropped to
    //    just the #fl-sidebar element.
    {
      const page = await loadReady(browser, { width: 1400, height: 900 })
      await setAllSections(page, true)
      await shotElement(page, '#fl-sidebar', 'panel-sidebar-collapsed')
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
      await shotElement(page, '#fl-sidebar', 'panel-sidebar-expanded')
      await page.close()
    }

    // 5. panel-narrow-width.png -- a narrower overall window, default section state.
    {
      const page = await loadReady(browser, { width: 700, height: 800 })
      await shotPage(page, 'panel-narrow-width')
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
