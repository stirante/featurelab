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
// Usage: node scripts/capture-graph-screenshots.mjs   (run from apps/vscode/)

import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const docsDir = path.join(root, 'docs')
const NONCE = 'capture-graph-nonce'

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

// The engine's own coverage table, real output of `featurelab types --json`. The creation menu
// refuses to open without it -- correctly, since it decides what may be created at all -- so a
// capture that omitted it would photograph the refusal rather than the menu.
const typesPath = path.join(root, 'test', 'fixtures', 'types-sample.json')
if (!fs.existsSync(typesPath)) {
  throw new Error(
    `capture-graph-screenshots: ${typesPath} is missing. Regenerate it with:
` +
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
  '/graph.js': [path.join(root, 'dist', 'graph.js'), 'text/javascript'],
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

html = shellHtml({
  nonce: NONCE,
  cspSource: origin,
  scriptUri: '/graph.js',
  styleUri: '/graph.css',
  packLabel: 'fixtures',
}).replace(
  '<link rel="stylesheet" href="/graph.css" />',
  `<link rel="stylesheet" href="${THEME_PATH}" /><link rel="stylesheet" href="/graph.css" />`,
).replace(
  '</body>',
  // The VS Code API bootstrap, under the SAME nonce the shell was rendered with -- so if the
  // CSP is wrong this stub dies exactly the way the real webview's script would.
  `<script nonce="${NONCE}">
     window.acquireVsCodeApi = function () {
       return {
         postMessage: function (message) {
           if (message && message.type === 'ready') {
             window.postMessage({ type: 'types', coverage: ${typesJson} }, '*')
             window.postMessage({ type: 'graph', graph: ${graphJson} }, '*')
           }
         },
         getState: function () { return undefined },
         setState: function () {},
       }
     }
   </script></body>`,
)


fs.mkdirSync(docsDir, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewportSize: { width: 1440, height: 900 } })

  // Fail loudly on a CSP violation or a script error. A screenshot of a blank page is still a
  // screenshot, and this script's job is to make that impossible to mistake for success.
  const problems = []
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`)
  })

  await page.goto(`http://127.0.0.1:${port}/`)
  // Wait for a drawn node, not for a status message. The first version waited on the text
  // "N nodes" in the status line, so rewording that line broke the capture -- a readiness signal
  // should be the thing you are waiting FOR, not a sentence that happens to appear beside it.
  await page.waitForSelector('.flg-node', { timeout: 15_000 })

  await page.screenshot({ path: path.join(docsDir, 'graph-full.png') })

  // Select a node so the inspector has something in it. Clicking is what a user does, so this
  // clicks -- but it clicks a node the renderer actually drew, found in the DOM, rather than a
  // guessed fraction of the canvas. The guessed version landed in the gap between two
  // components and captured an empty inspector twice without anything reporting a problem.
  // Bring the node into view before clicking it. The panel no longer opens zoomed out over the
  // whole graph -- it opens readable, on the busiest node -- so a node picked by name can be off
  // screen, exactly as it would be for a person who had not panned to it yet.
  await page.evaluate(() => {
    const view = window.__flgView
    const el = [...document.querySelectorAll('.flg-node')].find((n) => (n.textContent || '').includes('wiki:'))
    if (view && el) view.focusNode(el.getAttribute('data-node-id') || '')
  })
  await page.waitForTimeout(120)
  const node = page.locator('.flg-node').filter({ hasText: 'wiki:' }).first()
  await node.click({ force: true })
  await page.waitForFunction(
    () => !/Select a node/.test(document.getElementById('flg-side')?.textContent ?? ''),
    { timeout: 5_000 },
  )
  await page.screenshot({ path: path.join(docsDir, 'graph-selected.png') })

  // A close shot. zoomToFit on a 57-node pack lands around 0.1, which is the renderer's "far"
  // band by design -- text is dropped and a card becomes a solid block, because a 12px label at
  // that scale is a smudge. A screenshot taken only at fit zoom therefore photographs the
  // abbreviation and none of the card design, which is what the two shots above were doing.
  await page.evaluate(() => {
    const view = window.__flgView
    if (!view) return
    // Centre on the busiest node rather than on the origin: this pack's shape is dozens of
    // parents sharing a few children, so the hub is where the design has to hold up.
    const el = [...document.querySelectorAll('.flg-node')].find((n) =>
      (n.textContent || '').includes('pumpkin_patch_block'),
    )
    view.setCamera({ zoom: 1 })
    if (el) view.focusNode(el.getAttribute('data-node-id') || '')
  })
  await page.waitForTimeout(150)
  await page.screenshot({ path: path.join(docsDir, 'graph-close.png') })

  // The tree node, which is the hardest type this editor has: eight mutually exclusive trunk
  // variants and twelve canopies. Its own card is brought into view first -- this used to be
  // taken from the same frame as graph-close.png, so the two files were byte-identical and the
  // one named for the tree did not show it.
  await page.evaluate(() => {
    const view = window.__flgView
    const el = [...document.querySelectorAll('.flg-node')].find((n) =>
      (n.textContent || '').includes('acacia_branching_tree'),
    )
    if (view && el) view.focusNode(el.getAttribute('data-node-id') || '')
  })
  await page.waitForTimeout(150)
  await page.screenshot({ path: path.join(docsDir, 'graph-tree.png') })

  // Search, mid-query. At rest the box is only an input, so a screenshot of it idle shows
  // nothing of what it does.
  const searchInput = page.locator('#flg-search .fls-input')
  if ((await searchInput.count()) > 0) {
    await searchInput.fill('pumpkin')
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(docsDir, 'graph-search.png') })
    await searchInput.fill('')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
  }

  // The documentation panel, open over the canvas. Each section of the inspector has one `?`
  // at the end of its heading, and that button is the only trace of this surface in a
  // closed-state screenshot, so a capture that never presses one photographs nothing of it.
  const docButton = page.locator('.flg-ins-help').first()
  if ((await docButton.count()) > 0) {
    await docButton.click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(docsDir, 'graph-docs.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
  }

  // The creation menu, opened the way a person opens it: right-click on empty canvas. Captured
  // because it is the half of the editor that is not visible in either other shot.
  // An EMPTY point, found rather than guessed. Right-clicking a card deliberately does not open
  // the creation menu -- "add a node here" is not what a right-click on an existing node means --
  // so a fixed fraction of the canvas silently stopped opening it the moment the default camera
  // changed and that spot landed on a card.
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
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(docsDir, 'graph-palette.png') })

  // The compound story, on a pack that has compounds: the fixture pack has none, so the two
  // shots above cannot show the feature the whole design is about. This graph is real output of
  // `featurelab graph` over a pack whose features the editor itself created.
  const compoundPath = path.join(root, 'test', 'fixtures', 'graph-compound-sample.json')
  if (fs.existsSync(compoundPath)) {
    const compoundJson = fs.readFileSync(compoundPath, 'utf8')
    await page.evaluate((graph) => {
      window.postMessage({ type: 'graph', graph }, '*')
    }, JSON.parse(compoundJson))
    await page.waitForTimeout(250)
    await page.evaluate(() => {
      const view = window.__flgView
      const el = [...document.querySelectorAll('.flg-node')].find((n) =>
        (n.textContent || '').includes('biome_choice'),
      )
      if (view && el) {
        view.setCamera({ zoom: 1 })
        view.focusNode(el.getAttribute('data-node-id') || '')
      }
    })
    await page.waitForTimeout(120)
    const node = page.locator('.flg-node').filter({ hasText: 'biome_choice' }).first()
    if ((await node.count()) > 0) {
      await node.click({ force: true })
      await page.waitForTimeout(200)
    }
    await page.screenshot({ path: path.join(docsDir, 'graph-compound.png') })
  }

  if (problems.length) {
    throw new Error(`capture-graph-screenshots: the page reported errors:\n  ${problems.join('\n  ')}`)
  }
  console.log(`captured graph-full.png, graph-selected.png and graph-close.png, graph-palette.png, graph-docs.png, graph-search.png and graph-compound.png into ${docsDir}`)
} finally {
  await browser.close()
  server.close()
}
