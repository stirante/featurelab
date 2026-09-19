// capture-graph-screenshots.mjs -- captures apps/vscode/docs/graph-*.png against the REAL built
// graph webview: the same dist/graph.js the extension loads, the same media/graph.css, and the
// same shell HTML renderGraphShellHtml serves, Content-Security-Policy included.
//
// Serving the real CSP is the whole point, and it is not paranoia. previewPanel.ts's header
// records what a hand-copied, CSP-free shell cost on the preview panel: several rounds of
// "verified by screenshot" over a document that could not possibly exercise the bug that was
// shipping, while real VS Code silently dropped an inline <style> block and collapsed the
// layout. A screenshot taken over a different document than the one that ships is not evidence.
//
// EVERY SHOT GETS ITS OWN PAGE, and every shot declares which overlay surfaces it is supposed to
// show. Both rules are here because of a real failure, not for tidiness. The previous version
// drove all eight captures from one long-lived page and closed each transient surface by pressing
// Escape. Escape does not close the documentation aside unless the aside itself has focus, so the
// docs pane stayed open over the canvas for the rest of the run -- and graph-palette.png and
// graph-compound.png shipped as photographs of the docs pane. Worse, nothing failed: the
// right-click that was meant to open the creation menu landed on the overlay, the menu never
// opened, and the script cheerfully announced that it had captured it. So:
//
//   1. `openGraphPage()` per shot. A leak cannot outlive a page that does not outlive the shot.
//   2. `shot()` asserts the surfaces the filename claims ARE open and every other one is NOT.
//      A capture that photographs the wrong state now fails the run instead of being committed.
//   3. `shot()` MEASURES the PNG it just wrote and refuses one that is not VIEWPORT-sized.
//
// The third rule is here because of the same failure in a quieter form. This script asked for a
// 1440x900 page by passing `viewportSize` to `browser.newPage()`. Playwright's option is called
// `viewport`, and an unknown key in that bag is discarded without a word -- so every graph-*.png
// ever committed was Chromium's 1280x720 default while the script and the reviews around it
// believed 1440x900. Nothing in the page was wrong; the page was simply a different page from the
// one described. An option a function does not take is the same class of fault as a screenshot
// taken over the wrong document: it changes what was photographed and reports nothing. The
// measurement below is the check that a claim about the image's size is a claim about the image.
//
// Usage: node scripts/capture-graph-screenshots.mjs [--out <dir>]
//        (run from apps/vscode/; --out writes elsewhere, for checking a change without
//         overwriting the committed images)

import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outFlag = process.argv.indexOf('--out')
const docsDir = outFlag === -1 ? path.join(root, 'docs') : path.resolve(process.argv[outFlag + 1] ?? '')
const NONCE = 'capture-graph-nonce'

/** The page size every shot in this script is taken at, and the size every written PNG is checked
 * against. One constant, so the number in the assertion cannot drift from the number the page was
 * opened with -- the previous version had the size written down in one place and honoured in
 * none. Wide enough that the 320px inspector and the canvas are both worth looking at. */
const VIEWPORT = { width: 1440, height: 900 }

/** The size a PNG actually is, read off its IHDR chunk.
 *
 * Deliberately measured from the FILE rather than asked of the page. `page.viewportSize()` reports
 * what Playwright was told, which is exactly the thing that was wrong; the bytes on disk are the
 * thing the docs will ship. 8-byte signature, then a 4-byte length and the 'IHDR' tag, then width
 * and height as big-endian uint32 at offsets 16 and 20. */
function pngSize(file) {
  const head = Buffer.alloc(24)
  const fd = fs.openSync(file, 'r')
  try {
    if (fs.readSync(fd, head, 0, 24, 0) < 24) throw new Error(`${file} is too short to be a PNG`)
  } finally {
    fs.closeSync(fd)
  }
  if (head.toString('latin1', 1, 8) !== 'PNG\r\n\n' || head.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error(`${file} is not a PNG`)
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

// The built webview, not the sources. A capture taken against a stale bundle photographs a build
// nobody is running; the toolbar in the previously committed images still had a button that had
// been deleted from webview/graph.ts, which is exactly this failure.
const bundlePath = path.join(root, 'dist', 'graph.js')
if (!fs.existsSync(bundlePath)) {
  throw new Error('capture-graph-screenshots: dist/graph.js is missing. Run `npm run compile` first.')
}

/** The newest modification time under a directory, .ts files only. */
function newestSource(dir) {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(full))
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs)
  }
  return newest
}

// ...and not a bundle older than the sources it was built from. `existsSync` alone is not the
// check the comment above describes, and the difference is not theoretical: a compile that failed
// leaves the PREVIOUS dist/graph.js in place, exit code and all, so a run of `npm run compile &&
// node scripts/capture-graph-screenshots.mjs` that is interrupted by a build error in one file
// still produces nine confident screenshots -- of the build before it. That happened while this
// check was being written, and the image it produced showed a half-styled control that no longer
// existed in that form. Age is a coarse signal and a stale bundle is a coarse mistake.
{
  const built = fs.statSync(bundlePath).mtimeMs
  const newest = Math.max(newestSource(path.join(root, 'src')), newestSource(path.join(root, 'webview')))
  if (newest > built) {
    throw new Error(
      'capture-graph-screenshots: dist/graph.js is older than the sources it is built from, so every shot ' +
        'would photograph a build nobody is running. Run `npm run compile` and check that it SUCCEEDS -- a ' +
        'failed compile leaves the previous bundle in place.',
    )
  }
}

// The graph the page is shown. Real output of `featurelab graph` over this repo's own fixture
// pack, not a hand-written sample: a screenshot of invented data proves the renderer can draw
// invented data.
const graphPath = path.join(root, 'test', 'fixtures', 'graph-sample.json')
if (!fs.existsSync(graphPath)) {
  throw new Error(
    `capture-graph-screenshots: ${graphPath} is missing. Regenerate it with:\n` +
      '  go build -o featurelab ./cmd/featurelab && ./featurelab graph --pack docs/wiki/tools/fixtures',
  )
}
const graphJson = fs.readFileSync(graphPath, 'utf8')

// The compound graph. NOT optional: the compound is the half of this editor neither the overview
// nor the inspector shot can show, so a run that silently skipped it (which the previous version
// did, behind an existsSync) left graph-compound.png at whatever it happened to contain.
const compoundPath = path.join(root, 'test', 'fixtures', 'graph-compound-sample.json')
if (!fs.existsSync(compoundPath)) {
  throw new Error(
    `capture-graph-screenshots: ${compoundPath} is missing, so graph-compound.png cannot be captured.`,
  )
}
const compoundJson = fs.readFileSync(compoundPath, 'utf8')
const compoundGraph = JSON.parse(compoundJson)

/** The compound's own identifier, READ OFF THE FIXTURE rather than hard-coded.
 *
 * The old script looked for a node called `biome_choice`. The fixture had not contained one for
 * some time; the lookup quietly found nothing, the click never happened, and the shot named for
 * the compound never had a compound in it. A compound root is the node carrying an `@featurelab:
 * idiom` annotation, so ask the fixture. */
const compoundNodeId = (() => {
  const node = (compoundGraph.nodes ?? []).find((n) =>
    (n.annotations ?? []).some((a) => a.name === 'idiom'),
  )
  if (!node) {
    throw new Error(
      `capture-graph-screenshots: ${compoundPath} contains no node with an 'idiom' annotation, ` +
        'so there is no compound to photograph. Regenerate the fixture from a pack that has one.',
    )
  }
  return node.id
})()

// The same pack, re-exported by an engine that reports the two Molang PATHS (`iterationsPath`,
// `conditionPath`). graph-sample.json predates them, and the webview will not draw a Molang
// control for a slot whose path it was not told (molangSlotOf returns null) -- so on that fixture
// the feature is not merely unphotographed, it is absent. Every graph-*.png above therefore shows
// an editor with no Molang in it at all, which is not what the editor is.
//
// A SECOND file rather than a replacement: graph-sample.json is what the journey tests and the
// other captures are pinned to, and re-cutting it under them is a different change from adding
// the shot that was missing. The two are otherwise the same pack, node for node and edge for
// edge; the diff is exactly the paths.
const molangPath = path.join(root, 'test', 'fixtures', 'graph-molang-sample.json')
if (!fs.existsSync(molangPath)) {
  throw new Error(
    `capture-graph-screenshots: ${molangPath} is missing, so graph-molang.png cannot be captured. Regenerate it with:\n` +
      '  go build -o featurelab ./cmd/featurelab && ./featurelab graph --pack docs/wiki/tools/fixtures',
  )
}
const molangJson = fs.readFileSync(molangPath, 'utf8')

/** The scatter whose `iterations` graph-molang.png is about, READ OFF THE FIXTURE.
 *
 * Same reasoning as compoundNodeId below: a hard-coded feature name is a lookup that can quietly
 * stop matching, and the shot named for the Molang editor would then be a shot of something else.
 * The node that has the control is the source of a scatter edge carrying an `iterationsPath`, so
 * ask the fixture for one -- and fail here, naming the regeneration command, if the fixture turns
 * out to be as Molang-blind as the one this exists to supplement. */
const molangNodeId = (() => {
  const edge = (JSON.parse(molangJson).edges ?? []).find(
    (e) => e.kind === 'scatter' && typeof e.iterationsPath === 'string' && e.iterationsPath !== '',
  )
  if (!edge) {
    throw new Error(
      `capture-graph-screenshots: ${molangPath} has no scatter edge carrying an 'iterationsPath', so the ` +
        'Molang control it is supposed to show would never be drawn. Regenerate it with an engine that ' +
        'reports the Molang paths:\n' +
        '  go build -o featurelab ./cmd/featurelab && ./featurelab graph --pack docs/wiki/tools/fixtures',
    )
  }
  return edge.from
})()

// The engine's own coverage table, real output of `featurelab types --json`. The creation menu
// refuses to open without it -- correctly, since it decides what may be created at all -- so a
// capture that omitted it would photograph the refusal rather than the menu.
const typesPath = path.join(root, 'test', 'fixtures', 'types-sample.json')
if (!fs.existsSync(typesPath)) {
  throw new Error(
    `capture-graph-screenshots: ${typesPath} is missing. Regenerate it with:\n` +
      '  ./featurelab types --json > apps/vscode/test/fixtures/types-sample.json',
  )
}
const typesJson = JSON.stringify(JSON.parse(fs.readFileSync(typesPath, 'utf8')).types)

// The shell comes from the REAL src/graphPanel.ts, bundled here with esbuild and its `vscode`
// import stubbed -- renderGraphShellHtml never touches that import, being a pure function of
// its params. This is the same mechanism test/fixtures/shellHtml.ts uses for the preview panel,
// and for the same reason: a harness that hand-copies the shell cannot exercise a bug in the
// real one, which is how a CSP fault survived several "verified by screenshot" rounds.
const VSCODE_STUB = 'export default {}; export const Uri = {}; export const window = {}; export const ViewColumn = {}; export const workspace = {};'
const vscodeStubPlugin = {
  name: 'vscode-stub',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'vscode-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'vscode-stub' }, () => ({ contents: VSCODE_STUB, loader: 'js' }))
  },
}

const bundled = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'graphPanel.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [vscodeStubPlugin],
  logLevel: 'silent',
})
const tmpFile = path.join(os.tmpdir(), `graphPanel-shell-${process.pid}-${Date.now()}.mjs`)
fs.writeFileSync(tmpFile, bundled.outputFiles[0].text, 'utf8')
const { renderGraphShellHtml } = await import(pathToFileURL(tmpFile).href)
fs.rmSync(tmpFile, { force: true })
if (typeof renderGraphShellHtml !== 'function') {
  throw new Error('bundled graphPanel.ts did not export renderGraphShellHtml')
}
const shellHtml = renderGraphShellHtml


// Real VS Code stamps its theme onto the webview's root as --vscode-* custom properties, and
// media/graph.css is written entirely against them. Without them the page renders as unstyled
// black-on-white, which is not what anyone will see -- so the capture supplies them, exactly as
// the host does. These are Dark Modern's values; the point is to photograph the product, not a
// stylesheet with its variables missing.
const THEME = `:root{
  --vscode-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: "Cascadia Mono", Consolas, monospace;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-editorWidget-background: #202020;
  --vscode-panel-border: #2b2b2b;
  --vscode-widget-border: #313131;
  --vscode-focusBorder: #0078d4;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-editorIndentGuide-background: #2a2a2a;
  --vscode-editorError-foreground: #f14c4c;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-textCodeBlock-background: #2a2a2a;
  --vscode-textPreformat-foreground: #d7ba7d;
  --vscode-input-foreground: #cccccc;
  --vscode-input-background: #313131;
  --vscode-input-border: #3c3c3c;
  --vscode-charts-foreground: #cccccc;
  --vscode-charts-lines: #5a5a5a;
  --vscode-charts-blue: #4fc1ff;
  --vscode-charts-green: #89d185;
  --vscode-charts-orange: #d18616;
  --vscode-charts-purple: #b180d7;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-yellow: #cca700;
}`

const files = {
  '/graph.js': [bundlePath, 'text/javascript'],
  '/graph.css': [path.join(root, 'media', 'graph.css'), 'text/css'],
}

/** The theme is served as its own stylesheet from the same origin, so it goes through the real
 * CSP rather than around it. An inline <style> would need the nonce and would then be testing a
 * different thing than the one the extension actually does. */
const THEME_PATH = '/theme.css'

// The document is built AFTER the port is known, because the CSP names the origin the
// stylesheet is served from. Rendering it first with a placeholder port produced a policy for
// http://127.0.0.1:0 and the real stylesheet was blocked -- caught by this script's own error
// check, which is the whole reason that check exists.
let html = ''

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }
  if (url === THEME_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/css' })
    res.end(THEME)
    return
  }
  const entry = files[url]
  if (!entry) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'Content-Type': entry[1] })
  res.end(fs.readFileSync(entry[0]))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

/** Which graph a freshly opened page is handed. Read by the bootstrap below, set per page.
 * A query parameter rather than a postMessage after load, so the page is never briefly showing
 * the wrong pack: the compound shot used to be produced by posting a second graph over the first
 * one, which meant the camera, the selection and every open surface carried over from the pack
 * before it. */
function documentFor(graphLiteral) {
  return shellHtml({
    nonce: NONCE,
    cspSource: origin,
    scriptUri: '/graph.js',
    styleUri: '/graph.css',
    packLabel: 'fixtures',
  })
    .replace(
      '<link rel="stylesheet" href="/graph.css" />',
      `<link rel="stylesheet" href="${THEME_PATH}" /><link rel="stylesheet" href="/graph.css" />`,
    )
    .replace(
      '</body>',
      // The VS Code API bootstrap, under the SAME nonce the shell was rendered with -- so if the
      // CSP is wrong this stub dies exactly the way the real webview's script would.
      `<script nonce="${NONCE}">
     window.acquireVsCodeApi = function () {
       return {
         postMessage: function (message) {
           if (message && message.type === 'ready') {
             window.postMessage({ type: 'types', coverage: ${typesJson} }, '*')
             window.postMessage({ type: 'graph', graph: ${graphLiteral} }, '*')
           }
         },
         getState: function () { return undefined },
         setState: function () {},
       }
     }
   </script></body>`,
    )
}

/** The transient surfaces that can cover the canvas, by the name a shot refers to them by.
 *
 * This list is the contract `shot()` enforces. Anything that can sit over the canvas and outlive
 * the step that opened it belongs here -- if it is not listed, a leak of it is invisible again. */
const SURFACES = {
  docs: '.flg-ins-docs',
  menu: '.flp-menu',
  results: '#flg-search .fls-list',
  // The Molang editor on a scatter's `iterations`, named by what it IS rather than by the class
  // it is currently built from: an expression box whose accessible name is the slot it edits. The
  // control is being rewritten as this is written, and `.flg-molang-input` is the kind of detail a
  // rewrite is free to change; the fact that editing `iterations` means typing into a labelled
  // multi-line expression box is the contract, and it is what these two selectors say.
  molang: 'textarea[aria-label="iterations"]',
  // Its completion list, addressed through the combobox state the field publishes rather than
  // through the popup's own class -- `aria-expanded` is false unless the list is really up, so
  // this reports the surface and not merely the markup that can hold it.
  completions: 'textarea[aria-label="iterations"][aria-expanded="true"]',
}

fs.mkdirSync(docsDir, { recursive: true })
const browser = await chromium.launch()

/** A page showing `graphLiteral`, with a drawn node on it, failing loudly on any script or CSP
 * error. One page per shot: see this file's header for the leak this prevents. */
async function openGraphPage(graphLiteral) {
  html = documentFor(graphLiteral)
  // `viewport`, NOT `viewportSize`. Playwright names the page option `viewport` and drops keys it
  // does not know without complaining, so the misspelling this line used to carry left every shot
  // at Chromium's 1280x720 default -- see this file's header. Asked for here, checked here, and
  // checked again on the written file in `shot()`.
  const page = await browser.newPage({ viewport: VIEWPORT })
  const applied = page.viewportSize()
  if (applied?.width !== VIEWPORT.width || applied?.height !== VIEWPORT.height) {
    throw new Error(
      `capture-graph-screenshots: asked for a ${VIEWPORT.width}x${VIEWPORT.height} page and got ` +
        `${applied?.width}x${applied?.height}. The option name Playwright wants has changed; every shot ` +
        'from this run would be the wrong size.',
    )
  }
  const problems = []
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`)
  })
  page.__problems = problems
  await page.goto(`${origin}/`)
  // Wait for a drawn node, not for a status message. The first version waited on the text
  // "N nodes" in the status line, so rewording that line broke the capture -- a readiness signal
  // should be the thing you are waiting FOR, not a sentence that happens to appear beside it.
  await page.waitForSelector('.flg-node', { timeout: 15_000 })
  return page
}

/** Is this surface actually on screen? Present-but-hidden counts as closed: `.flp-menu` is built
 * once and toggled with [hidden], so existence alone would report the creation menu as open for
 * the whole run after the first time it was used. */
async function isOpen(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    if (el.hasAttribute('hidden')) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }, selector)
}

/** Writes `name`.png, having first checked that the page is in the state `name` claims.
 *
 * `open` names the surfaces this shot is FOR. Every surface not named must be closed. This is the
 * check whose absence shipped two screenshots of the documentation pane under other names.
 */
async function shot(page, name, { open = [] } = {}) {
  for (const key of open) {
    if (!(await isOpen(page, SURFACES[key]))) {
      throw new Error(`capture-graph-screenshots: ${name}.png is supposed to show the ${key} surface, but it is not open.`)
    }
  }
  for (const [key, selector] of Object.entries(SURFACES)) {
    if (open.includes(key)) continue
    if (await isOpen(page, selector)) {
      throw new Error(
        `capture-graph-screenshots: ${name}.png has the ${key} surface open over it, left behind by an earlier step. ` +
          'Close it before capturing, or add it to this shot\'s `open` list if it belongs there.',
      )
    }
  }
  const file = path.join(docsDir, `${name}.png`)
  await page.screenshot({ path: file })
  // The size of the thing that was actually written, not the size that was asked for. Every image
  // this script has ever committed was 1280x720 under a script that said 1440x900, and nothing
  // noticed because nothing ever looked at the file.
  const size = pngSize(file)
  if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) {
    throw new Error(
      `capture-graph-screenshots: ${name}.png came out ${size.width}x${size.height}, not the ` +
        `${VIEWPORT.width}x${VIEWPORT.height} this script captures at. Something between the viewport ` +
        'and the file is not doing what it is told; the image is not of the page that was described.',
    )
  }
  if (page.__problems.length) {
    throw new Error(`capture-graph-screenshots: the page reported errors before ${name}.png:\n  ${page.__problems.join('\n  ')}`)
  }
}

/** Brings the card whose label contains `text` into view, and returns its locator. */
async function reveal(page, text, { zoom } = {}) {
  const found = await page.evaluate(
    ({ text, zoom }) => {
      const view = window.__flgView
      const el = [...document.querySelectorAll('.flg-node')].find((n) => (n.textContent || '').includes(text))
      if (!view || !el) return false
      if (zoom !== undefined) view.setCamera({ zoom })
      view.focusNode(el.getAttribute('data-node-id') || '')
      return true
    },
    { text, zoom },
  )
  if (!found) {
    throw new Error(`capture-graph-screenshots: no card on the canvas is labelled '${text}', so the shot that needs it cannot be taken.`)
  }
  await page.waitForTimeout(150)
  return page.locator('.flg-node').filter({ hasText: text }).first()
}

/** The same, by identifier rather than by label text.
 *
 * `reveal()` matches a SUBSTRING of a card's text, which is fine for a name no other card
 * contains and wrong for one that is a prefix of its neighbour's: this pack holds both
 * `wiki:pumpkin_patch` and `wiki:pumpkin_patch_block`, and asking for the first by text can
 * centre and click the second. An identifier is exact, and the renderer already puts it on the
 * card as `data-node-id`. */
async function revealById(page, id, { zoom } = {}) {
  const found = await page.evaluate(
    ({ id, zoom }) => {
      const view = window.__flgView
      if (!view || !document.querySelector(`.flg-node[data-node-id="${id}"]`)) return false
      if (zoom !== undefined) view.setCamera({ zoom })
      view.focusNode(id)
      return true
    },
    { id, zoom },
  )
  if (!found) {
    throw new Error(`capture-graph-screenshots: no card on the canvas has the identifier '${id}', so the shot that needs it cannot be taken.`)
  }
  await page.waitForTimeout(150)
  return page.locator(`.flg-node[data-node-id="${id}"]`)
}

try {
  // 1. graph-full.png -- the overview, as the panel opens it.
  {
    const page = await openGraphPage(graphJson)
    await shot(page, 'graph-full')
    await page.close()
  }

  // 2. graph-selected.png -- a node selected, so the inspector has something in it. Clicking is
  //    what a user does, so this clicks -- but it clicks a node the renderer actually drew, found
  //    in the DOM, rather than a guessed fraction of the canvas. The guessed version landed in the
  //    gap between two components and captured an empty inspector twice without anything
  //    reporting a problem. The card is brought into view first: the panel opens readable on the
  //    busiest node rather than zoomed out over everything, so a node picked by name can be off
  //    screen, exactly as it would be for a person who had not panned to it yet.
  {
    const page = await openGraphPage(graphJson)
    const node = await reveal(page, 'wiki:')
    await node.click({ force: true })
    // The third argument is the options bag; the SECOND is the value handed to the page function.
    // `waitForFunction(fn, { timeout })` therefore passes the timeout into the browser as an
    // unused argument and waits the default 30s instead -- the same silent-drop this file's header
    // is about, in the one call whose whole purpose is to give up early. `undefined` is the arg.
    await page.waitForFunction(
      () => !/Select a node/.test(document.getElementById('flg-side')?.textContent ?? ''),
      undefined,
      { timeout: 5_000 },
    )
    await shot(page, 'graph-selected')
    await page.close()
  }

  // 3. graph-close.png -- a close shot. zoomToFit on a 57-node pack lands around 0.1, which is the
  //    renderer's "far" band by design -- text is dropped and a card becomes a solid block,
  //    because a 12px label at that scale is a smudge. A screenshot taken only at fit zoom
  //    therefore photographs the abbreviation and none of the card design. Centred on the busiest
  //    node rather than the origin: this pack's shape is dozens of parents sharing a few children,
  //    so the hub is where the design has to hold up.
  {
    const page = await openGraphPage(graphJson)
    await reveal(page, 'pumpkin_patch_block', { zoom: 1 })
    await shot(page, 'graph-close')
    await page.close()
  }

  // 4. graph-tree.png -- the tree node, the hardest type this editor has: eight mutually exclusive
  //    trunk variants and twelve canopies. Its own page, so it cannot end up sharing a frame with
  //    graph-close.png -- the two used to be byte-identical and the one named for the tree did not
  //    show it.
  {
    const page = await openGraphPage(graphJson)
    await reveal(page, 'acacia_branching_tree', { zoom: 1 })
    await shot(page, 'graph-tree')
    await page.close()
  }

  // 5. graph-search.png -- search, mid-query. At rest the box is only an input, so a screenshot of
  //    it idle shows nothing of what it does.
  {
    const page = await openGraphPage(graphJson)
    const searchInput = page.locator('#flg-search .fls-input')
    if ((await searchInput.count()) === 0) {
      throw new Error('capture-graph-screenshots: the toolbar has no search input, so graph-search.png cannot be captured.')
    }
    await searchInput.fill('pumpkin')
    await page.waitForSelector('#flg-search .fls-list', { timeout: 5_000 })
    await page.waitForTimeout(200)
    await shot(page, 'graph-search', { open: ['results'] })
    await page.close()
  }

  // 6. graph-docs.png -- the documentation panel, open over the canvas. Each section of the
  //    inspector has one `?` at the end of its heading, and that button is the only trace of this
  //    surface in a closed-state screenshot, so a capture that never presses one photographs
  //    nothing of it. It needs a selected node first, because the button lives in the inspector.
  {
    const page = await openGraphPage(graphJson)
    const node = await reveal(page, 'acacia_branching_tree', { zoom: 1 })
    await node.click({ force: true })
    const docButton = page.locator('.flg-ins-help').first()
    await docButton.waitFor({ timeout: 5_000 })
    await docButton.click()
    await page.waitForSelector('.flg-ins-docs', { timeout: 5_000 })
    await page.waitForTimeout(200)
    await shot(page, 'graph-docs', { open: ['docs'] })
    await page.close()
  }

  // 7. graph-palette.png -- the creation menu, opened the way a person opens it: right-click on
  //    empty canvas. Captured because it is the half of the editor that is not visible in any
  //    other shot.
  //    An EMPTY point, found rather than guessed. Right-clicking a card deliberately does not open
  //    the creation menu -- "add a node here" is not what a right-click on an existing node means
  //    -- so a fixed fraction of the canvas silently stopped opening it the moment the default
  //    camera changed and that spot landed on a card.
  {
    const page = await openGraphPage(graphJson)
    const canvas = await page.locator('#flg-canvas').boundingBox()
    const empty = await page.evaluate((box) => {
      const cards = [...document.querySelectorAll('.flg-node')].map((n) => n.getBoundingClientRect())
      for (let fy = 0.75; fy > 0.15; fy -= 0.05) {
        for (let fx = 0.7; fx > 0.2; fx -= 0.05) {
          const x = box.x + box.width * fx
          const y = box.y + box.height * fy
          if (!cards.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return { x, y }
        }
      }
      return null
    }, canvas)
    if (empty === null) throw new Error('capture-graph-screenshots: no empty canvas point to open the menu at')
    await page.mouse.click(empty.x, empty.y, { button: 'right' })
    await page.waitForTimeout(250)
    await shot(page, 'graph-palette', { open: ['menu'] })
    await page.close()
  }

  // 8. graph-compound.png -- the compound story, on a pack that has compounds: the fixture pack
  //    has none, so no shot above can show the feature the whole design is about. This graph is
  //    real output of `featurelab graph` over a pack whose features the editor itself created.
  //    The compound is SELECTED, because a collapsed compound's card looks like any other card --
  //    what makes it a compound is the parameter form the inspector puts up for it, so a shot
  //    that did not select it would not show a compound even with one on screen.
  {
    const page = await openGraphPage(compoundJson)
    const node = await reveal(page, compoundNodeId, { zoom: 1 })
    await node.click({ force: true })
    await page.waitForSelector('.flg-compound', { timeout: 5_000 })
    await page.waitForTimeout(200)
    await shot(page, 'graph-compound')
    await page.close()
  }

  // 9. graph-molang.png -- the Molang editor, on the slot it exists for.
  //
  //    A scatter's `iterations` is the one expression the graph carries on an EDGE rather than in
  //    the node's own JSON, and it is the reason the editor has a Molang mode at all. It appears
  //    on none of the eight shots above, because graph-sample.json predates the `iterationsPath`
  //    the webview needs before it will draw the control -- so those images are not an editor with
  //    the Molang off screen, they are an editor with no Molang in it. Hence the second fixture.
  //
  //    The scatter is selected as a NODE, which is where an author meets this field: the count
  //    lives in the `distribution` section beside the axes it belongs with, drawn from the edge's
  //    own editor. Then the field is typed into, because a Molang editor sitting idle is a text
  //    box -- what makes it the thing it is, is the completion list over the catalogue and the
  //    highlighting under the caret, and neither is visible until someone types. `math.ra` is a
  //    caret in the middle of a name, which is the only place completion is offered.
  {
    const page = await openGraphPage(molangJson)
    const node = await revealById(page, molangNodeId, { zoom: 1 })
    await node.click({ force: true })
    const field = page.locator(SURFACES.molang)
    await field.waitFor({ timeout: 5_000 })
    await field.click()
    await field.fill('')
    await field.pressSequentially('math.ra', { delay: 20 })
    await page.waitForSelector(SURFACES.completions, { timeout: 5_000 })
    await page.waitForTimeout(200)
    // The list is genuinely populated, not merely announced: the field points at its active row
    // by id, so follow the pointer and check something visible is on the other end. Asked through
    // ARIA rather than through the popup's class, so the control's rewrite can move the markup
    // without moving the meaning.
    const active = await page.evaluate((sel) => {
      const input = document.querySelector(sel)
      const id = input?.getAttribute('aria-activedescendant') ?? ''
      const row = id === '' ? null : document.getElementById(id)
      if (!row || row.getAttribute('role') !== 'option') return null
      const box = row.getBoundingClientRect()
      return box.width > 0 && box.height > 0 ? (row.textContent ?? '').trim() : null
    }, SURFACES.molang)
    if (active === null) {
      throw new Error(
        'capture-graph-screenshots: the iterations field says its completion list is open but has no visible ' +
          'active option, so graph-molang.png would show an empty popup rather than the editor.',
      )
    }
    await shot(page, 'graph-molang', { open: ['molang', 'completions'] })
    await page.close()
  }

  console.log(
    'captured graph-full, graph-selected, graph-close, graph-tree, graph-search, graph-docs, ' +
      `graph-palette, graph-compound and graph-molang into ${docsDir}`,
  )
} finally {
  await browser.close()
  server.close()
}
