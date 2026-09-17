// scale.test.ts -- does this editor work at the size of the pack it is for?
//
// ============================================================================
// READ THIS BEFORE "FIXING" A FAILURE HERE
// ============================================================================
// Nothing here is a feature test. A failure in this file does not mean the graph editor is
// broken; it means something got slower than the product can afford, or a shape assumption about
// the pack stopped holding. Those are debugged completely differently from a broken feature, so
// every test says in its name which of three kinds it is:
//
//   [budget]           A promise about the product, met today. Measure on this machine, set the
//                      threshold at 3-5x, round it to something memorable. 3-5x because CI and a
//                      loaded laptop routinely run 2x slower than an idle desktop and a budget
//                      that flakes gets deleted -- and because the regression this catches is an
//                      accidental O(n^2), which at these sizes does not arrive as +40%, it
//                      arrives as +1000%.
//
//   [budget] + it.fails  A promise about the product NOT met today. `it.fails` asserts the body
//                      throws, so the test is green while the defect stands and goes RED the day
//                      somebody fixes it -- which is when the budget should be promoted to a
//                      plain `it` and its ratchet deleted. Writing an unmet promise as a passing
//                      test with a number the product cannot meet would be a budget that
//                      certifies the defect.
//
//   [regression guard] NOT a promise. A ratchet at ~2x a KNOWN BAD measurement, there only to
//                      stop a defect getting worse while somebody fixes it. Each one names the
//                      [budget] it is standing in for. When that budget starts passing, DELETE
//                      the guard -- do not relax it.
//
// The measured numbers are written next to every threshold so the headroom is visible rather
// than implied, and every run prints the whole table. If something fails by 10%, suspect the
// machine. If it fails by 5x, suspect the diff.
//
// THE ONE RULE: do not widen a budget to make it pass. If the product genuinely needs to be
// slower, that is a decision with a reason, and the reason goes next to the new number.
//
// WHAT IS MEASURED, AND WHERE
//   - Node (this process): autoLayout, packBoxes, and the JSON/structured-clone cost of the
//     8.8 MB document -- all of which run in the EXTENSION HOST, where they block the host's
//     event loop, not a canvas.
//   - Chromium (Playwright): first render, pan, zoom, select, drag and reload memory, against
//     the REAL dist/graph.js under the REAL Content-Security-Policy from graphPanel.ts's own
//     renderGraphShellHtml -- the same arrangement scripts/capture-graph-screenshots.mjs uses,
//     and for the same reason: a harness that hand-copies the shell cannot exercise a bug in
//     the real one.
//
// TWO CAVEATS ABOUT THE BROWSER HALF, because they decide which numbers to trust:
//   1. Playwright's Chromium is HEADLESS and rasterises in software (SwiftShader). Main-thread
//      numbers -- script, style recalculation, layout, all of which come from CDP's Performance
//      domain -- are the work the CODE causes and are comparable to a real machine. FRAME
//      INTERVALS are not: a real VS Code webview composites on a GPU and will do better. So every
//      budget in this file is set on MAIN-THREAD cost, and frame intervals are recorded as
//      diagnostics only. Where a frame interval is quoted in a finding it is quoted as "at least
//      this bad", never as the number a user will see.
//   2. Synthetic PointerEvents have no live pointer behind them, so this file no-ops
//      setPointerCapture -- see the comment where it does. Nothing else about the gestures is
//      simulated: they are dispatched at the real elements, and every gesture measurement is
//      gated on having actually changed something.
//
// The fixture is GENERATED (test/fixtures/bigGraph.ts) rather than committed. Its header says
// how faithfully it matches the target shape and where it does not.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { EngineProcess } from '../src/engineProcess.js'
import { autoLayout, packBoxes, type LayoutBox, type LayoutGraph } from '../src/graph/layout.js'
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, type GraphWire } from '../src/graph/render.js'
import {
  buildBigGraph,
  FIXTURE_TYPE_IDS,
  MANY_COMPONENT_SHAPE,
  ONE_COMPONENT_SHAPE,
  PACK_SHAPE,
} from './fixtures/bigGraph.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dir, '..')

/** Every number this file measures, printed as one table at the end. A budget that fails tells
 * you one number; the table tells you which of the others moved with it, which is usually the
 * difference between a diagnosis and a guess. */
const measured: Array<[label: string, value: string]> = []
function record(label: string, value: number, unit = 'ms'): number {
  measured.push([label, `${value.toFixed(1)} ${unit}`])
  return value
}

/** Median of `runs` timings, not the best or the mean: the best hides a cost that is paid most
 * of the time, and the mean is dragged around by whichever run collided with a GC. */
function timeIt(runs: number, fn: () => void): number {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    samples.push(performance.now() - t)
  }
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]!
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

let pack: GraphWire
let packJson: string
let positions: Record<string, { x: number; y: number }>

beforeAll(() => {
  pack = buildBigGraph()
  packJson = JSON.stringify(pack)
  positions = autoLayout(pack as unknown as LayoutGraph, { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT })
}, 120_000)

afterAll(() => {
  const width = Math.max(...measured.map(([label]) => label.length))
  const lines = measured.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)
  console.log(`\n--- scale.test.ts: measured on this machine ---\n${lines.join('\n')}\n`)
})

describe('the fixture really is pack-shaped', () => {
  it('matches the target shape: 3531 nodes, 4580 edges, 41 roots, ~8.8 MB', () => {
    expect(pack.nodes).toHaveLength(PACK_SHAPE.nodes)
    expect(pack.edges).toHaveLength(PACK_SHAPE.edges)
    expect(pack.roots).toHaveLength(PACK_SHAPE.roots)
    record('document size', packJson.length / 1e6, 'MB')
    // Within 5% of 8.8 MB. Tight, because this number is the input to three other budgets below
    // and a fixture that quietly shrank would make all three look better than they are.
    expect(packJson.length).toBeGreaterThan(PACK_SHAPE.targetBytes * 0.95)
    expect(packJson.length).toBeLessThan(PACK_SHAPE.targetBytes * 1.05)
  })

  it('spans all 27 feature types plus feature_rule, and all 8 edge kinds', () => {
    const types = new Set(pack.nodes.map((n) => n.typeId).filter(Boolean))
    // 27 feature types + minecraft:feature_rule. A fixture missing a type is a renderer branch
    // nobody measured.
    expect(FIXTURE_TYPE_IDS).toHaveLength(28)
    for (const typeId of FIXTURE_TYPE_IDS) expect(types).toContain(typeId)
    const kinds = new Set(pack.edges.map((e) => e.kind))
    expect([...kinds].sort()).toEqual(['aggregate', 'child', 'conditional', 'filter', 'rule', 'scatter', 'sequence', 'weighted'])
  })

  it('has the fan-in, the stubs and the cycles a real pack has', () => {
    const inDegree = new Map<string, number>()
    for (const edge of pack.edges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
    const shared = [...inDegree.values()].filter((d) => d > 1).length
    const busiest = Math.max(...inDegree.values())
    record('nodes with >1 parent', shared, 'nodes')
    record('busiest node fan-in', busiest, 'parents')
    // "Many parents sharing a handful of children" has to actually be true of the fixture, or
    // the port-assignment and crossing-minimisation costs below are measured on a forest.
    expect(shared).toBeGreaterThan(300)
    expect(busiest).toBeGreaterThan(8)

    const unresolved = pack.nodes.filter((n) => n.unresolved)
    expect(unresolved.length).toBeGreaterThan(20)
    expect(unresolved.some((n) => (n as { external?: boolean }).external)).toBe(true)
    expect((pack.cycles ?? []).length).toBeGreaterThan(0)
  })

  it('has real depth, so the layered pass is actually exercised', () => {
    const layers = autoLayout(pack as unknown as LayoutGraph, { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT })
    const columnPitch = GRAPH_NODE_WIDTH + 110
    const depth = Math.max(...Object.values(layers).map((p) => p.x)) / columnPitch
    expect(depth).toBeGreaterThan(4)
  })
})

// ---------------------------------------------------------------------------
// Layout -- runs in the EXTENSION HOST, on every refresh, blocking it
// ---------------------------------------------------------------------------

describe('layout at pack size', () => {
  it('places every node, at a finite coordinate, with no id lost', () => {
    expect(Object.keys(positions)).toHaveLength(pack.nodes.length)
    for (const [id, at] of Object.entries(positions)) {
      expect(Number.isFinite(at.x), `${id}.x`).toBe(true)
      expect(Number.isFinite(at.y), `${id}.y`).toBe(true)
    }
  })

  it('does not stack two cards on top of each other', () => {
    // Sweep by x-band rather than all-pairs: 3531^2 is 12.5M comparisons and this is a test, not
    // a benchmark. Cards share an x only if they share a layer, which is where an overlap can
    // actually happen.
    const byColumn = new Map<number, Array<{ id: string; y: number }>>()
    for (const [id, at] of Object.entries(positions)) {
      const list = byColumn.get(at.x) ?? []
      list.push({ id, y: at.y })
      byColumn.set(at.x, list)
    }
    const overlaps: string[] = []
    for (const list of byColumn.values()) {
      list.sort((a, b) => a.y - b.y)
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.y - list[i - 1]!.y < GRAPH_NODE_HEIGHT) overlaps.push(`${list[i - 1]!.id} / ${list[i]!.id}`)
      }
    }
    expect(overlaps.slice(0, 5)).toEqual([])
  })

  it('[budget] autoLayout of the whole pack stays under 250 ms', () => {
    const ms = record('autoLayout (41 components)', timeIt(3, () => autoLayout(pack as unknown as LayoutGraph, { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT })))
    // Measured ~55 ms. Budget 250 ms ~= 4.5x.
    //
    // WHY 250 AND NOT 60: this runs in the extension host on every refresh, i.e. on every file
    // save, and the host is single-threaded -- while it runs, VS Code's own UI does not. 250 ms
    // is the point at which a save starts to feel like it stopped the editor. The headroom is
    // wide because 55 ms is an idle fast desktop and this suite must not flake on CI; it is
    // still 6x tighter than the cost of the accidental quadratic it exists to catch.
    expect(ms).toBeLessThan(250)
  })

  it('[budget] autoLayout over hundreds of components stays under 250 ms', () => {
    const many = buildBigGraph(MANY_COMPONENT_SHAPE)
    const ms = record('autoLayout (400 components)', timeIt(3, () => autoLayout(many as unknown as LayoutGraph, { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT })))
    // The component packer's own comments cite a 40-component graph. This is the same node and
    // edge budget spread over 400, which is the input its 32 candidate widths and its
    // median/outlier pass were never measured on. Measured ~57 ms -- statistically the same as
    // 41 components, which is the finding: the packer is not where the money goes. Same budget
    // as the 41-component case on purpose, so a packer that became super-linear shows up here
    // and not only in the ratio test below.
    expect(ms).toBeLessThan(250)
  })

  it('[budget] autoLayout of one giant component stays under 1 s', () => {
    const one = buildBigGraph(ONE_COMPONENT_SHAPE)
    const ms = record('autoLayout (1 component)', timeIt(2, () => autoLayout(one as unknown as LayoutGraph, { nodeWidth: GRAPH_NODE_WIDTH, nodeHeight: GRAPH_NODE_HEIGHT })))
    // The worst case: component splitting is what keeps each Sugiyama pass small, so a pack whose
    // rules all share features collapses into one component and every pass runs at full size.
    // Measured ~250 ms, i.e. ~5x the 41-component case for the same nodes and edges. A looser
    // budget (1 s, ~4x) than the others on purpose -- this is a pathological shape, not the
    // measured one -- but it is here because "it degrades gracefully" is a claim, and an
    // unmeasured claim is a guess.
    expect(ms).toBeLessThan(1000)
  })

  it('[budget] packBoxes stays linear-ish in the number of components', () => {
    const box = (i: number): LayoutBox => ({ width: 400 + ((i * 137) % 2200), height: 200 + ((i * 89) % 1400) })
    const small = Array.from({ length: 40 }, (_, i) => box(i))
    const large = Array.from({ length: 400 }, (_, i) => box(i))
    // Timed as a BATCH of 200, not as a median of single calls: one call is well under the
    // resolution of performance.now() here, and a ratio of two sub-millisecond numbers is noise
    // wearing a measurement's clothes.
    const fortyMs = timeIt(3, () => {
      for (let i = 0; i < 200; i++) packBoxes(small, { gapX: 206, gapY: 96, targetAspect: 16 / 9 })
    })
    const fourHundredMs = timeIt(3, () => {
      for (let i = 0; i < 200; i++) packBoxes(large, { gapX: 206, gapY: 96, targetAspect: 16 / 9 })
    })
    record('packBoxes x200, 40 boxes', fortyMs)
    record('packBoxes x200, 400 boxes', fourHundredMs)
    // 10x the boxes must not cost more than 30x the time. packBoxes is 32 shelf passes, each a
    // single walk, so it is linear by construction -- this test exists to notice if somebody
    // reintroduces the sort-the-candidates-per-box shape it used to have.
    const ratio = fourHundredMs / Math.max(fortyMs, 0.001)
    record('packBoxes 400/40 ratio', ratio, 'x')
    expect(ratio).toBeLessThan(30)
    // 200 packs of 400 boxes. Measured ~80 ms; budget 400 ms. autoLayout calls packBoxes ONCE,
    // so the absolute number is a rounding error in a refresh -- the ratio is what this test is
    // really for.
    expect(fourHundredMs).toBeLessThan(400)
  })
})

// ---------------------------------------------------------------------------
// The 8.8 MB message -- paid on every refresh, which is every save
// ---------------------------------------------------------------------------

describe('moving the document around', () => {
  it('[budget] receiving the reply from a REAL child process stays under 900 ms', async () => {
    // The whole path, not a piece of it: a child process writes the 8.8 MB reply down a real
    // pipe and the real EngineProcess reassembles and parses it. That reassembly is the part
    // JSON.parse's 15 ms does not cover, and it is the largest single cost on the extension
    // host's refresh path -- larger than the layout.
    //
    // The stand-in engine is written to a temp file rather than added to test/fixtures, because
    // it is a working file of this measurement and not a fixture anybody should reuse.
    const script = path.join(os.tmpdir(), `flg-scale-engine-${process.pid}.mjs`)
    const payload = path.join(os.tmpdir(), `flg-scale-graph-${process.pid}.json`)
    fs.writeFileSync(payload, packJson, 'utf8')
    fs.writeFileSync(
      script,
      [
        `import * as readline from 'node:readline'`,
        `import fs from 'node:fs'`,
        `const body = fs.readFileSync(${JSON.stringify(payload)}, 'utf8')`,
        `readline.createInterface({ input: process.stdin }).on('line', (line) => {`,
        `  const id = JSON.parse(line).id`,
        `  process.stdout.write('{"id":' + id + ',"result":' + body + '}\\n')`,
        `})`,
      ].join('\n'),
      'utf8',
    )
    const proc = new EngineProcess(process.execPath, [script])
    try {
      proc.start()
      // One warm-up round trip, so neither the child's module loading nor its file read lands
      // inside the measurement.
      await proc.request('graph', undefined, 60_000)
      const samples: number[] = []
      for (let i = 0; i < 3; i++) {
        const t = performance.now()
        const reply = (await proc.request('graph', undefined, 60_000)) as { nodes?: unknown[] }
        samples.push(performance.now() - t)
        expect(reply.nodes).toHaveLength(PACK_SHAPE.nodes)
      }
      samples.sort((a, b) => a - b)
      const ms = record('engine reply over a real pipe', samples[1]!)
      // Measured ~200 ms, of which JSON.parse is 15. The rest is EngineProcess.handleStdout
      // reassembling the line, and it is QUADRATIC in the number of chunks the pipe delivers --
      // see the findings. Budget 900 ms: about 4.5x, and deliberately wide, because the thing
      // that moves this number is the operating system's pipe chunk size, which differs between
      // this machine and a user's. That sensitivity is exactly the defect.
      expect(ms).toBeLessThan(900)
    } finally {
      proc.dispose()
      fs.rmSync(script, { force: true })
      fs.rmSync(payload, { force: true })
    }
  }, 120_000)

  it('[budget] JSON.parse of the engine reply stays under 150 ms', () => {
    const ms = record('JSON.parse 8.8 MB', timeIt(3, () => JSON.parse(packJson)))
    // Measured ~15 ms, which is the surprise: V8 parses this document faster than the layout
    // lays it out. Budget 150 ms = 10x, because this is a V8 primitive and the only way it
    // regresses is if the DOCUMENT grows -- which is exactly the regression worth catching, and
    // a 10x document is a different product.
    expect(ms).toBeLessThan(150)
  })

  it('[budget] structured-cloning the document out of the host stays under 300 ms', () => {
    const ms = record('structuredClone 8.8 MB', timeIt(3, () => structuredClone(pack)))
    // Measured ~40 ms in node, ~10 ms in Chromium (see the browser half). This is the cost
    // postMessage pays, and it is paid on every refresh, i.e. on every save. Budget 300 ms.
    // It is nowhere near the dominant cost of a refresh, which was worth establishing: the
    // 8.8 MB message is not the problem, the 3531 cards are.
    expect(ms).toBeLessThan(300)
  })
})

// ---------------------------------------------------------------------------
// The real thing, in real Chromium, under the real CSP
// ---------------------------------------------------------------------------

/** The extension's own shell, bundled out of src/graphPanel.ts with `vscode` stubbed -- the same
 * mechanism scripts/capture-graph-screenshots.mjs uses. renderGraphShellHtml is a pure function
 * of its params and never touches that import. */
async function loadShellRenderer(): Promise<(p: Record<string, string>) => string> {
  const stub = 'export default {}; export const Uri = {}; export const window = {}; export const ViewColumn = {}; export const workspace = {};'
  const bundled = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'graphPanel.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vscode-stub',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'vscode-stub' }))
          build.onLoad({ filter: /.*/, namespace: 'vscode-stub' }, () => ({ contents: stub, loader: 'js' as const }))
        },
      },
    ],
  })
  const tmp = path.join(os.tmpdir(), `flg-scale-shell-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(tmp, bundled.outputFiles[0]!.text, 'utf8')
  try {
    const mod = (await import(pathToFileURL(tmp).href)) as { renderGraphShellHtml?: unknown }
    if (typeof mod.renderGraphShellHtml !== 'function') throw new Error('graphPanel.ts did not export renderGraphShellHtml')
    return mod.renderGraphShellHtml as (p: Record<string, string>) => string
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Dark Modern, as real VS Code stamps it onto the webview root. Served as its own stylesheet so
 * it goes THROUGH the CSP rather than around it -- an inline <style> would need the nonce and
 * would then be testing a different page than the one that ships. */
const THEME_CSS = `:root{
  --vscode-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, monospace;
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

const NONCE = 'flg-scale-nonce'

interface Harness {
  browser: Browser
  close: () => Promise<void>
  open: () => Promise<Page>
}

/** Frame timings while `drive` runs. Reported as a median and a p90 rather than an average,
 * because a drag that is smooth nine frames in ten and stalls on the tenth is not smooth --
 * a stall is exactly what a user feels. */
interface FrameStats {
  median: number
  p90: number
  worst: number
  frames: number
}

describe('graph editor at 3531 nodes, in Chromium, under the real CSP', () => {
  let harness: Harness
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const graphJs = path.join(root, 'dist', 'graph.js')
    if (!fs.existsSync(graphJs)) {
      throw new Error(`scale.test.ts needs the real bundle. Run \`npm run compile\` in apps/vscode first (missing ${graphJs}).`)
    }
    const shell = await loadShellRenderer()
    const files: Record<string, [string, string]> = {
      '/graph.js': [graphJs, 'text/javascript'],
      '/graph.css': [path.join(root, 'media', 'graph.css'), 'text/css'],
    }
    let html = ''
    const httpServer = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!
      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
        return
      }
      if (url === '/theme.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' })
        res.end(THEME_CSS)
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
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, '127.0.0.1', () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    const origin = `http://127.0.0.1:${server.port}`
    html = shell({ nonce: NONCE, cspSource: origin, scriptUri: '/graph.js', styleUri: '/graph.css', packLabel: 'scale' })
      .replace('<link rel="stylesheet" href="/graph.css" />', `<link rel="stylesheet" href="/theme.css" /><link rel="stylesheet" href="/graph.css" />`)
      .replace(
        '</body>',
        // The VS Code API bootstrap, under the SAME nonce the shell was rendered with, so a
        // wrong CSP kills this stub exactly the way it would kill the real webview's script.
        // It deliberately does NOT answer `ready` with a graph: this test posts the graph itself
        // so it can time the post.
        `<script nonce="${NONCE}">
           window.__flgPosted = [];
           window.acquireVsCodeApi = function () {
             return {
               postMessage: function (m) { window.__flgPosted.push(m) },
               getState: function () { return undefined },
               setState: function () {},
             }
           }
         </script></body>`,
      )
    const browser = await chromium.launch({
      args: [
        // gc() is how the memory test gets a number that means something: without a forced
        // collection, "the heap grew" only says a collection has not happened yet.
        '--js-flags=--expose-gc',
        // WITHOUT THIS THE MEMORY TEST IS A LIE. Chrome quantises performance.memory to 100 KB
        // buckets AND caches the value for twenty minutes, so eight refreshes in a row report
        // byte-identical heaps and "0% growth" -- which is what this test reported before the
        // flag was added, and it would have reported it just as confidently over a leak.
        '--enable-precise-memory-info',
      ],
    })
    harness = {
      browser,
      close: () => browser.close(),
      open: async () => {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
        const problems: string[] = []
        page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
        page.on('console', (msg) => {
          if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`)
        })
        ;(page as unknown as { __problems: string[] }).__problems = problems
        await page.goto(origin)
        await page.waitForFunction(() => Boolean((window as unknown as { __flgView?: unknown }).__flgView), undefined, { timeout: 20_000 })
        // Hand the document in and install the timing helpers. Everything below this line runs
        // against a page that already holds the object, so no measurement includes transport.
        //
        // Handed in through evaluate rather than fetched from the harness server, because the
        // real CSP is `default-src 'none'` with no connect-src: the page CANNOT fetch. That is
        // not a harness limitation, it is the shipped policy -- worth knowing, because it means
        // the 8.8 MB document has exactly one way into the webview, and that way is postMessage.
        await page.evaluate(({ json, positionsIn }) => {
          const w = window as unknown as Record<string, unknown>
          w.__graph = JSON.parse(json)
          w.__positions = positionsIn
          // Runs AFTER the app's own 'message' listener (registered at module load, i.e. before
          // this one), so its timestamp is "the app has finished handling the message".
          w.__handled = 0
          window.addEventListener('message', () => {
            ;(window as unknown as { __handled: number }).__handled = performance.now()
          })
          // A SYNTHETIC PointerEvent has no live pointer behind it, so setPointerCapture throws
          // NotFoundError -- which would abort beginDrag/onPointerDown halfway and leave this
          // file measuring a gesture that never started. Capture exists to keep moves flowing to
          // one element after the pointer leaves it; nothing here moves the pointer off the
          // element, so a no-op changes no measured work. Documented rather than hidden: it is
          // the one place this harness is not the real browser.
          for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
            ;(Element.prototype as unknown as Record<string, unknown>)[name] = function (): void {}
          }
          Element.prototype.hasPointerCapture = function (): boolean {
            return false
          }
        }, { json: packJson, positionsIn: positions })
        return page
      },
    }
  }, 180_000)

  afterAll(async () => {
    await harness?.close()
    server?.close()
  })

  /** Posts the graph exactly as graphPanel.ts does and waits until every card is in the DOM.
   * Returns the split: how long the message took to be delivered and handled, and how long until
   * the browser had actually painted a frame containing cards. */
  async function postGraph(page: Page): Promise<{ handled: number; painted: number; nodes: number }> {
    return page.evaluate(async () => {
      const w = window as unknown as { __graph: unknown; __positions: unknown; __handled: number }
      w.__handled = 0
      const start = performance.now()
      window.postMessage({ type: 'graph', graph: w.__graph, positions: w.__positions }, '*')
      await new Promise<void>((resolve) => {
        const poll = (): void => (w.__handled > 0 ? resolve() : void setTimeout(poll, 0))
        poll()
      })
      const handled = w.__handled - start
      // Two frames: the first is scheduled during the handler, the second cannot run until the
      // browser has produced a frame, so its timestamp is after paint.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { handled, painted: performance.now() - start, nodes: document.querySelectorAll('.flg-node').length }
    })
  }

  /** Script / style / layout time the browser itself attributes to a gesture, from CDP's own
   * Performance domain. This is the half the CODE controls, and separating it from the frame
   * interval is the difference between "the renderer is doing too much work per frame" and "the
   * browser cannot raster a scene this big" -- which have completely different fixes.
   *
   * Compositing and rasterisation are NOT in these numbers: they happen off the main thread and
   * CDP does not attribute them here. That is deliberate -- it is exactly what makes the
   * remainder (frame interval minus this) readable as raster cost. */
  interface MainThreadCost {
    script: number
    style: number
    layout: number
    layouts: number
  }

  async function mainThreadCost(page: Page, run: () => Promise<unknown>): Promise<MainThreadCost> {
    const client = await page.context().newCDPSession(page)
    await client.send('Performance.enable')
    const read = async (): Promise<Record<string, number>> => {
      const { metrics } = await client.send('Performance.getMetrics')
      return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
    }
    const before = await read()
    await run()
    const after = await read()
    const diff = (name: string): number => (after[name] ?? 0) - (before[name] ?? 0)
    await client.detach()
    return {
      script: diff('ScriptDuration') * 1000,
      style: diff('RecalcStyleDuration') * 1000,
      layout: diff('LayoutDuration') * 1000,
      layouts: diff('LayoutCount'),
    }
  }

  /** Pumps one synthetic gesture frame per animation frame and reports the frame intervals. This
   * is the only honest way to ask "does it feel smooth": the renderer coalesces work into a rAF,
   * so the thing a user experiences is the gap between frames, not the duration of any one call. */
  async function frameStats(page: Page, drive: string, frames = 45): Promise<FrameStats> {
    return page.evaluate(
      async ({ drive, frames }) => {
        const step = new Function('i', drive) as (i: number) => void
        const times: number[] = []
        await new Promise<void>((resolve) => {
          let i = 0
          let last = performance.now()
          const tick = (): void => {
            step(i)
            const now = performance.now()
            if (i > 3) times.push(now - last) // the first few frames include the gesture's own setup
            last = now
            if (++i >= frames) resolve()
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        times.sort((a, b) => a - b)
        return {
          median: times[times.length >> 1] ?? 0,
          p90: times[Math.floor(times.length * 0.9)] ?? 0,
          worst: times[times.length - 1] ?? 0,
          frames: times.length,
        }
      },
      { drive, frames },
    )
  }

  it('[budget] draws the whole pack: handled under 3 s, on screen under 4 s', async () => {
    const page = await harness.open()
    try {
      const first = await postGraph(page)
      expect(first.nodes).toBe(PACK_SHAPE.nodes)
      record('first render: message handled', first.handled)
      record('first render: painted', first.painted)
      // Measured ~0.7-1.1 s to handle, ~0.9-1.4 s to paint. Budgets 3 s / 4 s, a little over 3x.
      //
      // This is what someone waits through after `Feature Lab: Open Feature Graph`. A second to
      // open a 3531-node editor is a price worth paying once; the same second on every save is
      // not, which is what the refresh test below is really about. The budget is set where the
      // wait stops reading as "it is working" and starts reading as "it has hung".
      expect(first.handled).toBeLessThan(3000)
      expect(first.painted).toBeLessThan(4000)
      const problems = (page as unknown as { __problems: string[] }).__problems
      expect(problems).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[budget] a refresh -- which is every save -- redraws in under 1.5 s', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const second = await postGraph(page)
      record('refresh: message handled', second.handled)
      record('refresh: painted', second.painted)
      // Measured ~0.3 s to handle, ~0.9 s to paint -- cheaper than the first render because the
      // camera is already framed, but a full teardown and rebuild of 3531 cards and 4580 edges
      // all the same. This happens on EVERY FILE SAVE, so the budget is tighter than the first
      // render's: 1.5 s handled (~5x measured, wide because the measurement is noisy) and 3 s to
      // paint. See the findings note on render(): nothing here is incremental.
      expect(second.handled).toBeLessThan(1500)
      expect(second.painted).toBeLessThan(3000)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[budget] a structured clone of the document inside the webview stays under 200 ms', async () => {
    const page = await harness.open()
    try {
      const ms = await page.evaluate(async () => {
        const graph = (window as unknown as { __graph: unknown }).__graph
        const samples: number[] = []
        for (let i = 0; i < 3; i++) {
          const channel = new MessageChannel()
          const t = performance.now()
          await new Promise<void>((resolve) => {
            channel.port2.onmessage = () => resolve()
            channel.port1.postMessage(graph)
          })
          samples.push(performance.now() - t)
        }
        samples.sort((a, b) => a - b)
        return samples[1]!
      })
      record('postMessage clone (browser)', ms)
      // Measured ~10 ms. Budget 200 ms = 20x, because the thing that would move this is the
      // document growing, and it would move a long way.
      expect(ms).toBeLessThan(200)
    } finally {
      await page.close()
    }
  }, 120_000)

  /** The card these gestures grab. Index 1200 rather than 0: the first cards are a rule and its
   * immediate children, which have few edges, and a drag whose card has three edges measures
   * three edges. 1200 is well into the body of the drawing. */
  const DRAG_TARGET = 1200

  const PAN_START = `const host = document.querySelector('.flg-graph');
     host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, clientX: 800, clientY: 500 }));
     host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, buttons: 1, clientX: 812, clientY: 508 }));`
  const PAN_GESTURE = `const host = document.querySelector('.flg-graph');
     host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, buttons: 1, clientX: 812 + i * 9, clientY: 508 + i * 5 }));`

  // One wheel notch is exp(-deltaY * 0.002), so +-60 is a 12.7% step that lands back where it
  // started every other frame. WHICH BAND those two zooms fall in is the whole experiment, so
  // both are pinned by setting the camera explicitly rather than by trusting wherever
  // openOnSomethingReadable happened to leave it -- the first version of this test did trust it,
  // measured 0.1 ms a frame, and was measuring the one case that costs nothing.
  //
  // render.ts: ZOOM_BAND_FAR = 0.55, ZOOM_BAND_NEAR = 0.9.
  // The drive alternates -60 then +60, so the camera oscillates between Z and 1.1275 * Z.
  // Every frame records the band that was in force when it started, and each test asserts on
  // the set of bands it saw: the first attempt at this test set a start zoom whose oscillation
  // never left one band and reported the expensive case as costing nothing.
  const zoomDrive = `window.__bands.add(document.querySelector('.flg-graph').dataset.zoomBand);
     document.querySelector('.flg-graph').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: (i % 2 ? 60 : -60), clientX: 800, clientY: 500 }));`
  const zoomStart = (zoom: number): string => `window.__bands = new Set(); window.__flgView.setCamera({ zoom: ${zoom} })`

  // 1.60 <-> 1.804: both above ZOOM_BAND_NEAR, so the band attribute never changes.
  const ZOOM_IN_BAND_START = zoomStart(1.6)
  const ZOOM_IN_BAND = zoomDrive
  // 0.52 <-> 0.586: straddles ZOOM_BAND_FAR, so data-zoom-band flips on every single frame.
  const ZOOM_CROSS_START = zoomStart(0.52)
  const ZOOM_CROSS = zoomDrive
  const BANDS_SEEN = `[...window.__bands].sort().join(',')`

  // The press, plus one move past DRAG_THRESHOLD_PX so the gesture has become a drag (and the
  // `flg-dragging` classes are already on) before the steady state is measured.
  const DRAG_START = `const box = document.querySelectorAll('.flg-node')[${DRAG_TARGET}];
     const rect = box.getBoundingClientRect();
     window.__dragOrigin = { x: rect.x, y: rect.y };
     box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, button: 0, clientX: rect.x + 10, clientY: rect.y + 10 }));
     box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 5, buttons: 1, clientX: rect.x + 30, clientY: rect.y + 30 }));`
  const DRAG_GESTURE = `const box = document.querySelectorAll('.flg-node')[${DRAG_TARGET}];
     const origin = window.__dragOrigin;
     box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 5, buttons: 1, clientX: origin.x + 30 + (i % 2 ? 9 : -9), clientY: origin.y + 30 + (i % 2 ? 6 : -6) }));`

  /** Runs one script in the page and waits two animation frames, so whatever it caused has been
   * through style, layout and a produced frame before anything is measured. */
  async function settleScript(page: Page, src: string): Promise<void> {
    await page.evaluate(async (source) => {
      // eslint-disable-next-line no-new-func
      await (new Function(source) as () => unknown)()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    }, src)
  }

  /** Runs a gesture and reports its cost, having first checked the gesture actually DID
   * something. A synthetic-event harness that silently no-ops produces beautifully fast numbers,
   * so every gesture measurement here is gated on its own effect.
   *
   * `prime` is the START of the gesture -- the press, and the first move -- and is measured
   * SEPARATELY from the steady state. That split is not bookkeeping: pressing adds a class to
   * the canvas root (`flg-panning`, `flg-dragging-node`), and a class on the root of a document
   * holding 3531 cards is a whole-document style recalculation. Averaged into the per-frame
   * number it looks like the gesture is expensive every frame, which is the wrong diagnosis and
   * would send someone into rerouteEdges to fix a selector. */
  async function gesture(
    page: Page,
    prime: string,
    drive: string,
    effect: string,
  ): Promise<{ frames: FrameStats; cost: MainThreadCost; start: MainThreadCost; before: unknown; after: unknown }> {
    const read = (): Promise<unknown> => page.evaluate(effect)
    const before = await read()
    const start = await mainThreadCost(page, () => settleScript(page, prime))
    let frames!: FrameStats
    const cost = await mainThreadCost(page, async () => {
      frames = await frameStats(page, drive)
    })
    return { frames, cost, start, before, after: await read() }
  }

  function totalCost(cost: MainThreadCost): number {
    return cost.script + cost.style + cost.layout
  }

  /** Per-frame main-thread cost, from the totals CDP reports over the whole gesture. */
  function perFrame(cost: MainThreadCost, frames: number): number {
    return (cost.script + cost.style + cost.layout) / Math.max(1, frames)
  }

  it('[budget] panning costs almost no main-thread work, however big the graph', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const idle = await frameStats(page, 'return')
      record('idle frame interval', idle.median)

      const pan = await gesture(page, PAN_START, PAN_GESTURE, 'JSON.stringify(window.__flgView.getCamera())')
      expect(pan.after, 'the pan gesture did not move the camera -- this measured nothing').not.toEqual(pan.before)
      record('pan frame interval (median)', pan.frames.median)
      record('pan frame interval (p90)', pan.frames.p90)
      record('pan main-thread per frame', perFrame(pan.cost, pan.frames.frames))
      record('pan: cost of the press itself', totalCost(pan.start))

      // THE PROMISE: panning is ONE transform on ONE element (render.ts's applyCamera), so the
      // main thread should barely notice it at any graph size. 2 ms a frame is an eighth of a
      // 60 fps budget and roughly 20x what this measures; a failure means something started
      // doing per-node work on the camera path, which is the regression that matters here.
      //
      // NOTE this is NOT the same question as "does panning feel smooth". It does not, at this
      // size, and the frame interval recorded above says so -- but the reason is compositing a
      // scene of 30,000 elements, not anything this code does per frame. See the findings.
      expect(perFrame(pan.cost, pan.frames.frames)).toBeLessThan(2)

      // The PRESS, separately, because it is a different defect with a different fix: adding
      // `flg-panning` to the canvas root restyles every element under it. Measured ~140 ms at
      // this size -- a sixth of a second of dead air before a pan starts moving. Budget 500 ms:
      // a ratchet on a known cost, not an endorsement of it.
      expect(totalCost(pan.start)).toBeLessThan(500)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[budget] zooming WITHIN one detail band costs almost no main-thread work', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const zoom = await gesture(page, ZOOM_IN_BAND_START, ZOOM_IN_BAND, 'window.__flgView.getCamera().zoom')
      expect(zoom.after, 'the zoom gesture did not change the zoom -- this measured nothing').not.toEqual(zoom.before)
      expect(await page.evaluate(BANDS_SEEN), 'this gesture was supposed to stay in one band').toBe('near')
      record('zoom in-band frame interval (median)', zoom.frames.median)
      record('zoom in-band main-thread per frame', perFrame(zoom.cost, zoom.frames.frames))
      // Measured ~0.1 ms. The same promise as panning: zooming is one transform on one element,
      // so the main thread should barely notice it at any graph size.
      expect(perFrame(zoom.cost, zoom.frames.frames)).toBeLessThan(2)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[regression guard] crossing a zoom detail band does not get worse than it already is', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const zoom = await gesture(page, ZOOM_CROSS_START, ZOOM_CROSS, 'window.__flgView.getCamera().zoom')
      expect(zoom.after).not.toEqual(zoom.before)
      expect(await page.evaluate(BANDS_SEEN), 'this gesture was supposed to cross a band boundary').toBe('far,mid')
      record('zoom band-crossing frame interval (median)', zoom.frames.median)
      record('zoom band-crossing main-thread per frame', perFrame(zoom.cost, zoom.frames.frames))
      record('  ...of which script', zoom.cost.script / zoom.frames.frames)
      record('  ...of which style', zoom.cost.style / zoom.frames.frames)
      record('  ...of which layout', zoom.cost.layout / zoom.frames.frames)
      record('  ...layouts per frame', zoom.cost.layouts / zoom.frames.frames, 'layouts')

      // READ THIS BEFORE TOUCHING THE NUMBER. ~215 ms of main-thread work per frame -- 125 ms of
      // style recalculation and 90 ms of layout -- is a wheel that answers three times a second.
      // That is not acceptable, and the [budget] test below says so and is expected to fail.
      // This is a RATCHET on a known defect: `data-zoom-band` is ONE attribute on the canvas
      // root, and the rules keyed off it toggle `display` on descendants, so flipping it
      // restyles AND RELAYS OUT everything under it -- roughly 40,000 elements at this size.
      // 600 ms is about 2.8x the measured value: tight enough that a second whole-document
      // invalidation trips it, loose enough for a busy machine (a run of this file with a tsc
      // alongside it measured everything here 1.5x slower). When the defect is fixed, remove
      // this test rather than relaxing it.
      expect(perFrame(zoom.cost, zoom.frames.frames)).toBeLessThan(600)
    } finally {
      await page.close()
    }
  }, 180_000)

  // KNOWN FAILING, ON PURPOSE -- see the note above the drag budget for why `it.fails` rather
  // than a relaxed threshold. THE PROMISE: 25 ms leaves room for a 30 fps wheel. Which detail
  // band to draw is a decision about 3531 cards, and there is no reason a user should feel it.
  it.fails('[budget] crossing a zoom detail band leaves room for 30 fps -- NOT MET at 3531 nodes', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const zoom = await gesture(page, ZOOM_CROSS_START, ZOOM_CROSS, 'window.__flgView.getCamera().zoom')
      expect(zoom.after).not.toEqual(zoom.before)
      expect(perFrame(zoom.cost, zoom.frames.frames)).toBeLessThan(25)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[budget] selecting a card responds in under 250 ms', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      // Three different cards, median -- one click is a noisy sample and this budget has less
      // headroom than the others, because a click is the one interaction with a hard perceptual
      // ceiling rather than a negotiable one.
      const ms = await page.evaluate(async () => {
        const samples: number[] = []
        let selected = 0
        for (const index of [400, 1200, 2600]) {
          const box = document.querySelectorAll('.flg-node')[index] as HTMLElement
          const rect = box.getBoundingClientRect()
          const t = performance.now()
          box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, button: 0, clientX: rect.x + 4, clientY: rect.y + 4 }))
          box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, button: 0, clientX: rect.x + 4, clientY: rect.y + 4 }))
          box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          samples.push(performance.now() - t)
          selected = document.querySelectorAll('.flg-node.flg-selected').length
        }
        samples.sort((a, b) => a - b)
        return { ms: samples[1]!, selected }
      })
      record('select a card (median of 3)', ms.ms)
      // Exactly one card selected at the end: a selection that lit up two cards would also be a
      // faster measurement, and a fast wrong answer is the easiest budget to pass by accident.
      expect(ms.selected).toBe(1)
      // Measured ~120 ms. Selecting lights up a card, every edge that touches it and every one of
      // their chips, and rebuilds the inspector for the node. 250 ms is roughly 2x measured --
      // less headroom than anything else here, deliberately: a click is the one interaction with
      // a hard perceptual ceiling (about a tenth of a second before it stops feeling connected to
      // the cursor), so there is nowhere to put more headroom without the budget ceasing to mean
      // anything. 120 ms is already AT that ceiling; this budget says "and no worse".
      expect(ms.ms).toBeLessThan(250)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[regression guard] dragging a card does not get slower than it already is', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const drag = await gesture(page, DRAG_START, DRAG_GESTURE, `document.querySelectorAll('.flg-node')[${DRAG_TARGET}].style.left`)
      expect(drag.after, 'the drag gesture did not move the card -- this measured nothing').not.toEqual(drag.before)
      record('drag frame interval (median)', drag.frames.median)
      record('drag frame interval (p90)', drag.frames.p90)
      record('drag frame interval (worst)', drag.frames.worst)
      record('drag main-thread per frame', perFrame(drag.cost, drag.frames.frames))
      record('  ...of which script', drag.cost.script / drag.frames.frames)
      record('  ...of which style', drag.cost.style / drag.frames.frames)
      record('  ...of which layout', drag.cost.layout / drag.frames.frames)
      record('drag: cost of the press itself', totalCost(drag.start))

      // The PRESS, separately: `flg-dragging` on the card and `flg-dragging-node` on the canvas
      // root, the second of which restyles the whole document -- the same defect as the zoom
      // band, reached a different way. Measured ~215 ms of dead air between pressing a card and
      // it starting to follow the pointer -- 410 ms on a loaded machine. Budget 700 ms: a
      // ratchet, not an endorsement.
      expect(totalCost(drag.start)).toBeLessThan(700)

      // READ THIS BEFORE TOUCHING THE NUMBER. The ~22 ms a frame this measures is NOT an
      // acceptable drag -- see the [budget] test immediately below, which states what an
      // acceptable one is and is currently expected to fail. This is a RATCHET on a known
      // defect: it stops the reroute path getting worse while somebody fixes it, and nothing
      // more.
      //
      // 50 ms is calibrated against two runs: 21.5 ms idle and 32.4 ms with a tsc alongside. It
      // therefore survives a loaded machine while still tripping on the regression it exists for
      // -- rerouteEdges already runs assignPorts over EVERY edge every frame, and adding a
      // second whole-graph pass beside it would roughly double this. When the defect is fixed,
      // DELETE this test; do not relax it.
      expect(perFrame(drag.cost, drag.frames.frames)).toBeLessThan(50)
    } finally {
      await page.close()
    }
  }, 180_000)

  // KNOWN FAILING, ON PURPOSE. `it.fails` asserts the body throws -- so this test is green while
  // dragging is too slow and goes RED the day somebody makes it fast enough, which is exactly
  // when the budget should be promoted to a plain `it` and the ratchet above deleted. Writing
  // the promise down as a passing test with a number the product cannot meet would be the
  // opposite: a budget that certifies the defect.
  //
  // THE PROMISE: 12 ms of main-thread work per frame -- a third of a 30 fps frame, leaving the
  // browser the other two thirds to style, lay out and actually paint. 30 rather than 60 because
  // a drag on a graph this size is a heavy operation and 30 fps still tracks a pointer; below
  // about 20 fps the card stops following the cursor and starts arriving in jumps.
  //
  // Measured ~21.5 ms, so this misses by about 1.8x -- a wide enough margin that the test cannot
  // flip to passing by luck on a fast machine, which for an `it.fails` matters: a spurious flip
  // reads as "somebody fixed it".
  //
  // NOTE that the gesture's own sanity check below is load-bearing in the RATCHET above, not
  // here: inside an `it.fails`, a gesture that silently did nothing would throw and look like
  // the known failure. The ratchet is a plain `it` over the same gesture, so a broken harness
  // fails there and cannot hide in this test.
  it.fails('[budget] dragging a card leaves room for 30 fps -- NOT MET at 3531 nodes', async () => {
    const page = await harness.open()
    try {
      await postGraph(page)
      const drag = await gesture(page, DRAG_START, DRAG_GESTURE, `document.querySelectorAll('.flg-node')[${DRAG_TARGET}].style.left`)
      expect(drag.after).not.toEqual(drag.before)
      expect(perFrame(drag.cost, drag.frames.frames)).toBeLessThan(12)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('[budget] eight refreshes do not leak: the heap does not grow without bound', async () => {
    const page = await harness.open()
    try {
      const heaps = await page.evaluate(async () => {
        const w = window as unknown as { __graph: unknown; __positions: unknown; gc?: () => void }
        const used = (): number => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
        const settle = async (): Promise<number> => {
          w.gc?.()
          await new Promise<void>((resolve) => setTimeout(resolve, 120))
          w.gc?.()
          await new Promise<void>((resolve) => setTimeout(resolve, 120))
          return used()
        }
        const series: number[] = []
        for (let i = 0; i < 8; i++) {
          window.postMessage({ type: 'graph', graph: w.__graph, positions: w.__positions }, '*')
          await new Promise<void>((resolve) => setTimeout(resolve, 400))
          series.push(await settle())
        }
        return series
      })
      if (heaps.every((h) => h === 0)) {
        // performance.memory is non-standard. If this Chromium build does not expose it the test
        // says so rather than passing on no evidence.
        throw new Error('performance.memory is unavailable in this Chromium build -- the memory budget measured nothing')
      }
      for (let i = 0; i < heaps.length; i++) record(`heap after refresh ${i + 1}`, heaps[i]! / 1e6, 'MB')
      // The claim being tested is "repeated refreshes do not accumulate", so the comparison is
      // between the SECOND refresh (by which point every lazily-built cache exists) and the
      // last. A per-refresh leak of one whole document would show as ~8.8 MB a round, i.e. 60%+
      // growth over six rounds; 40% is comfortably above the noise of a collector that does not
      // return every page and comfortably below a real leak.
      const settled = heaps[1]!
      const final = heaps[heaps.length - 1]!
      record('heap growth, refresh 2 -> 8', ((final - settled) / settled) * 100, '%')
      expect(final).toBeLessThan(settled * 1.4)
    } finally {
      await page.close()
    }
  }, 240_000)
})

// ---------------------------------------------------------------------------
// WHAT THIS FILE FOUND, the first time it was run
// ---------------------------------------------------------------------------
//
// The headline: the editor WORKS at 3531 nodes. It opens in about a second, it draws every card,
// it does not leak, and the two things everyone expected to be the problem -- the Sugiyama layout
// and the 8.8 MB message -- are not the problem. What hurts is narrower and more fixable than
// that, and it is written down here so the numbers above have somewhere to point.
//
// Ranked by how much it hurts at this size. NONE of it is fixed here; every item names the file
// it lives in so the fix can be made by whoever owns that file.
//
//  1. CROSSING A ZOOM DETAIL BAND: ~215 ms of main thread, every frame it happens.
//     render.ts applyCamera writes `root.dataset.zoomBand`, and media/graph.css keys `display`
//     rules off it. Flipping one attribute on the canvas root therefore restyles (125 ms) and
//     RELAYS OUT (86 ms) every one of the ~40,000 elements below it. A wheel held across 0.55 or
//     0.9 answers about three times a second. Note `display` is what makes this a LAYOUT cost as
//     well as a style one -- `visibility`/`opacity`/`content-visibility` would not be.
//
//  2. RECEIVING THE ENGINE REPLY: ~200 ms, and quadratic in the pipe's chunk size.
//     engineProcess.ts handleStdout does `this.stdoutBuffer += chunk` and then scans the WHOLE
//     accumulated buffer for a newline on every chunk. At the 64 KB chunks this machine's pipe
//     delivers that is ~150 ms of rescanning; simulated at 8 KB chunks the same 8.8 MB costs
//     1.1 s. JSON.parse of the same document is 15 ms, so essentially all of it is the
//     reassembly. Remembering how far the buffer has already been scanned removes most of it.
//
//  3. A DRAG COSTS THE WHOLE GRAPH, EVERY FRAME: ~22 ms of main thread per frame.
//     render.ts rerouteEdges calls assignPorts over all 4580 edges on every frame of a one-card
//     drag, and rebuilds the RectGrid over all 3531 rects. Roughly 10 ms of that is script and
//     13 ms is layout. Within the script half, assignPorts uses JSON.stringify as a map key six
//     times per edge -- measured at 3.15 ms per frame for 4580 edges, against 0.14 ms for the
//     same keys built as template strings. That one substitution is a seventh of the frame.
//
//  4. THE PRESS THAT STARTS A GESTURE: 140 ms (pan) to 250 ms (drag) of dead air.
//     Same mechanism as (1): `flg-panning` / `flg-dragging-node` go on the canvas ROOT, so the
//     whole document restyles before the gesture moves at all.
//
//  5. A REFRESH REBUILDS EVERYTHING: ~280 ms to handle, ~920 ms to paint, on every file save.
//     render.ts render() is a full teardown -- replaceChildren on every layer -- and graphPanel.ts
//     re-runs autoLayout (51 ms) over the whole pack each time. Nothing is incremental, so
//     editing one field costs the same as opening the editor.
//
// NOT PROBLEMS, measured rather than assumed:
//   - autoLayout: 51 ms for the pack, 57 ms over 400 components, 213 ms for one giant component.
//     The component packing is linear in the boxes and is not where the money goes.
//   - The 8.8 MB message: 39 ms to structured-clone in node, 10 ms in the browser.
//   - Memory: eight refreshes, 46.3 MB every time. No leak.
//   - Panning and zooming WITHIN a band: 0.1 ms of main thread per frame, at any graph size.
//     Frame intervals are poor here (~56 ms) but that is this harness's software rasteriser
//     redrawing a 30,000-element scene, not anything the code does.
