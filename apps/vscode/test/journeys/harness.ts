// harness.ts -- an end-to-end rig for the graph editor: the real webview, the real host, the
// real engine, over a real pack on disk.
//
// WHY THIS EXISTS. webview/graph.ts is where every graph module meets, and it is the one file
// under webview/ and src/graph/ with no tests. The modules it wires together each have thorough
// ones and all of them pass while saying nothing about whether the editor works: this repo has
// already shipped a compound that expanded into files and could not be collapsed again, three
// separate causes, every unit test on both halves green throughout. Nothing covered the join.
//
// WHAT IS REAL HERE, in the order it matters:
//
//   1. THE PAGE. dist/graph.js and media/graph.css, the very files the extension loads, served
//      inside Chromium under the Content-Security-Policy the REAL src/graphPanel.ts emits --
//      the shell HTML is not written here, it is read off `panel.webview.html` after the real
//      panel set it. This follows scripts/capture-graph-screenshots.mjs, whose own header
//      explains the cost of getting it wrong: a hand-copied CSP-free shell survived several
//      rounds of "verified by screenshot" while real VS Code silently dropped an inline <style>
//      block. A harness that serves a different document than the one that ships has caught
//      nothing in this repo, twice.
//
//   2. THE HOST. src/graphPanel.ts itself, not a mirror of it. `vscode` is stubbed (see
//      vscodeStub.ts) and the stubbed webview is a pipe into the page, so the panel's real
//      message switch, its real node->file table, its real pending-drop-position rule and its
//      real refusal messages are the ones under test.
//
//   3. THE ENGINE. `featurelab serve`, the actual binary, driven through the actual
//      src/previewController.ts, over a per-test COPY of docs/wiki/tools/fixtures. A click
//      really does end in a file on disk, and the graph that comes back really was re-read from
//      it. Nothing here asserts that a message was posted.
//
//   4. THE PREVIEW, when a journey asks for it (`withPreview`). dist/webview.js and the real
//      src/previewPanel.ts, in a SECOND Chromium page under previewPanel.ts's own shell and CSP,
//      created the way the extension creates one: by the graph panel asking for it. That is what
//      makes the write-attribution round trip -- select a node, watch the preview highlight its
//      blocks; click a block, watch the graph point back -- testable at all. Both halves of that
//      conversation are between two REAL panels; neither end is a mock, because a mock of either
//      end would be a copy of the code under test.
//
//      The 3D view is real too: headless Chromium gives the viewer a WebGL context, so a click
//      on the canvas raycasts against the geometry a real run produced. There is no way to fake
//      that half and still be testing "click a block".
//
// WHAT IS NOT REAL: VS Code's own editor (openTextDocument/showTextDocument record a path and
// stop -- see vscodeStub.ts), and the webview asset origin, which has to be http because no
// browser outside VS Code can serve `vscode-webview://`. The theme variables are supplied as a
// stylesheet from that same origin, through the real CSP rather than around it, exactly as the
// capture script does.
//
// EVERY WAIT IS ON A CONDITION. There are no sleeps standing in for one: a node appearing, a
// status line changing, the graph message count going up. A journey is slower than a unit test
// and says so in its own timeout rather than by guessing at a duration.
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { PreviewController } from '../../src/previewController.js'
import { GraphPanel } from '../../src/graphPanel.js'
import { PreviewPanel } from '../../src/previewPanel.js'
import type { TextureBuilder } from '../../src/textures.js'
import * as vscodeStub from './vscodeStub.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/** apps/vscode */
const appRoot = path.resolve(here, '..', '..')
/** the repository root */
const repoRoot = path.resolve(appRoot, '..', '..')
/** The pack every journey starts from. NEVER written to -- each journey copies it. */
export const FIXTURE_PACK = path.join(repoRoot, 'docs', 'wiki', 'tools', 'fixtures')

/** How long a journey step may take. Generous on purpose: a step here can include an engine
 * round trip, a pack reload and a full redraw, and a tight timeout on that buys nothing but
 * flakes. */
export const JOURNEY_TIMEOUT_MS = 90_000
/** How long any single wait inside the harness may take. Shorter than the test timeout on
 * purpose: a wait that gives up first fails with the condition it was waiting for, and a test
 * that merely times out says nothing about which step stopped. */
const WAIT_MS = 20_000
const ENGINE_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// The engine binary
// ---------------------------------------------------------------------------

let cachedBinary: string | null = null

/** The `featurelab` executable these journeys drive.
 *
 * Prefers whatever is already built (apps/vscode/bin, what `npm run build:binary` produces and
 * what a developer running the extension already has) and builds it once if it is not there.
 * A missing Go toolchain is reported as itself rather than as a spawn failure forty lines into
 * a test. */
export function engineBinaryPath(): string {
  if (cachedBinary !== null) return cachedBinary
  const override = process.env['FEATURELAB_BINARY']
  if (override !== undefined && override.length > 0) {
    if (!fs.existsSync(override)) throw new Error(`FEATURELAB_BINARY is set to ${override}, which does not exist`)
    cachedBinary = override
    return override
  }
  const name = process.platform === 'win32' ? 'featurelab.exe' : 'featurelab'
  const built = path.join(appRoot, 'bin', name)
  if (fs.existsSync(built)) {
    cachedBinary = built
    return built
  }
  fs.mkdirSync(path.dirname(built), { recursive: true })
  const result = spawnSync('go', ['build', '-o', built, './cmd/featurelab'], { cwd: repoRoot, encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `these journeys drive the real engine and could not build it. Run "npm run build:binary" in apps/vscode first.\n` +
        `  go build said: ${result.error?.message ?? result.stderr ?? `exit ${String(result.status)}`}`,
    )
  }
  cachedBinary = built
  return built
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

let bundleBuilt = false

/** Rebuilds dist/ from source before the first journey of the process.
 *
 * Not a convenience. These journeys assert about dist/graph.js and about nothing else, so a
 * stale dist/ does not make them fail -- it makes them PASS while describing a build nobody has
 * any more. That is worse than no suite at all: "the editor wires the Molang editor in" would go
 * green off a bundle built before the wiring was removed, which is precisely the class of lie
 * this directory exists to make impossible.
 *
 * `npm run compile` itself, through its own esbuild config, so what is built here is what
 * `npm run package` ships. Once per process, because three bundles take about half a second and
 * a per-test rebuild would pay it thirty times over for no extra truth. Set
 * FEATURELAB_SKIP_BUILD=1 while iterating on a test against a bundle you built by hand. */
export function ensureBundleBuilt(): void {
  if (bundleBuilt) return
  bundleBuilt = true
  if (process.env['FEATURELAB_SKIP_BUILD'] === '1') return
  const result = spawnSync(process.execPath, ['esbuild.config.mjs'], { cwd: appRoot, encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `journey harness: the webview bundle would not build, so there is nothing honest to test.\n` +
        `  ${result.error?.message ?? result.stderr ?? `exit ${String(result.status)}`}`,
    )
  }
}

/** Refuses to run a preview journey against a stale featurelab-frontend build.
 *
 * ensureBundleBuilt rebuilds apps/vscode's OWN dist, but the preview bundle is esbuild over
 * `featurelab-frontend`, and that package resolves to frontend/dist -- tsc output this repo does
 * not check in and this harness does not build. So an edit to frontend/src/viewer.ts is invisible
 * here until somebody runs `npm run build` in frontend/, and a journey that ran anyway would
 * describe a viewer nobody has: the exact false green ensureBundleBuilt's own doc comment exists
 * to prevent, one package over.
 *
 * Checked rather than built, because building it is a tsc run plus an asset copy and belongs in
 * the command a developer already types, not once per test process. The message says which.
 *
 * Compared on mtime, which is the only signal available without reproducing tsc's own staleness
 * logic. A clock-skewed checkout could false-positive; being told to run a build you have already
 * run is a far better failure than a green test over a viewer from before your change. */
function requireFreshFrontend(): void {
  const frontendRoot = path.join(repoRoot, 'frontend')
  const built = path.join(frontendRoot, 'dist', 'index.js')
  if (!fs.existsSync(built)) {
    throw new Error('journey harness: frontend/dist is missing. Run "npm run build" in frontend/ first.')
  }
  const builtAt = fs.statSync(built).mtimeMs
  const newer: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (fs.statSync(full).mtimeMs > builtAt) newer.push(path.relative(frontendRoot, full))
    }
  }
  walk(path.join(frontendRoot, 'src'))
  if (newer.length > 0) {
    throw new Error(
      `journey harness: frontend/dist is older than ${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ` (and ${String(newer.length - 3)} more)` : ''}, ` +
        `so this preview would run an old viewer and say nothing about your change. ` +
        `Run "npm run build" in frontend/ first.`,
    )
  }
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

let browser: Browser | null = null

async function sharedBrowser(): Promise<Browser> {
  if (browser === null) browser = await chromium.launch()
  return browser
}

/** Closes the browser this file's journeys shared. Call it from an afterAll. */
export async function closeSharedBrowser(): Promise<void> {
  const open = browser
  browser = null
  if (open !== null) await open.close()
}

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

/** Real VS Code stamps its theme onto the webview root as --vscode-* custom properties, and
 * media/graph.css is written entirely against them. Without them the page renders unstyled,
 * which is not what anyone sees -- and a layout assertion over an unstyled page is an assertion
 * about a page that does not exist. These are Dark Modern's values, the same set
 * scripts/capture-graph-screenshots.mjs supplies, for the same reason.
 *
 * Served as its own stylesheet from the harness's origin, so it goes THROUGH the real CSP
 * rather than around it. An inline <style> would need the nonce and would then be exercising
 * something the extension never does. */
const THEME_CSS = `:root{
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

// ---------------------------------------------------------------------------
// A journey
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

export interface OpenJourneyOptions {
  /** Runs against the COPIED pack before the panel opens, for a journey that needs the pack to
   * start in a particular state -- a file with a comment in it, say. The fixture pack itself is
   * never touched. */
  prepare?: (packRoot: string) => void
  /** Viewport size. Bigger than a default page so a graph of this size has empty canvas to
   * right-click on. */
  viewport?: { width: number; height: number }
  /** Opens a REAL PreviewPanel, in its own page, the moment the graph asks for one -- which is
   * what the graph's "Preview on select" toggle does. Off by default: a preview costs a WebGL
   * context, a generate against the real engine and a second browser page, and the journeys that
   * are about the node editor need none of the three. */
  withPreview?: boolean
}

/** The live preview panel a journey opened, and the handful of things it can be asked.
 *
 * Deliberately thin. The preview's own controls are covered by its own suites; what a journey
 * needs from it is what the GRAPH made it do -- so this exposes the attribution readout, the
 * overlay's own cell count, and clicking a block, and nothing else. */
export interface PreviewJourney {
  /** The live page running dist/webview.js. */
  readonly page: Page
  /** The real PreviewPanel driving it. */
  readonly panel: PreviewPanel
  /** Every message this webview posted to its host, in order. */
  readonly posted: readonly HostMessage[]
  /** Every `generate`/`generateGrown` params object the panel actually sent to the engine, in
   * order -- the surface on which "does this preview ask for a profile, and when" is decidable.
   * Recorded on the way past, so the request is still made and its result still rendered. */
  readonly requests: readonly Record<string, unknown>[]
  /** The text of the shell's attribution readout, or '' while it is hidden. */
  attributionText(): Promise<string>
  waitForAttribution(match: RegExp): Promise<string>
  /** How many cells the viewer's attribution overlay is currently painting. */
  attributionCellCount(): Promise<number>
  /** Sets the View section's Environment radio to "hidden" -- by clicking it, in the real
   * sidebar. What somebody does when they want to see their feature and not the terrain it was
   * placed into, and what leaves the feature's own blocks as the only geometry on screen. */
  hideEnvironment(): Promise<void>
  /** Presses R, the viewer's own "frame what is actually occupied" key. */
  frameContent(): Promise<void>
  /** Clicks blocks in the 3D view -- real mouse presses on the canvas, at points chosen by
   * walking outward from the centre -- until one of them lands on a block the profile has a
   * writer for. Returns the readout the host answered with.
   *
   * Points are TRIED rather than computed, because "click a block" is a gesture and the only
   * honest way to know whether a pixel is over one is to click it. The walk is bounded; a
   * give-up says how many points were tried and what the last answer was. */
  clickUntilAttributed(): Promise<string>
  problems(): readonly string[]
  /** Closes this preview's page and panel. Called by the journey's own dispose -- the asset
   * server will not shut down while a page still holds a keep-alive socket open to it, so a
   * preview left running hangs the teardown rather than merely leaking. */
  close(): Promise<void>
}

/** One message the webview posted to the host, as the host received it.
 *
 * The host contract is the editor's only way to change anything on disk, so it is the surface on
 * which "this control is wired up at all" is decidable. Most journeys should still assert on the
 * FILE -- a posted message is a mechanism and can keep arriving after the feature stops working
 * -- but a control that posts nothing has certainly not been wired, and saying which message was
 * expected is a far better failure than "the file did not change". */
export interface HostMessage {
  type: string
  [key: string]: unknown
}

/** One editable control on the page, found by being editable rather than by a selector somebody
 * invented. See Journey.editables. */
export interface Editable {
  /** 'input', 'textarea', 'select', or the tag of a contenteditable element. */
  tag: string
  /** `type` for an <input>, otherwise ''. */
  inputType: string
  /** What it currently holds: `.value`, or the text of a contenteditable. */
  value: string
  /** A person can type into it: not disabled, not readonly, and it has a box on screen. */
  editable: boolean
  /** Its accessible name, when it has one -- aria-label, or the text of its <label>. */
  label: string
  /** A selector that finds this one element again, for clicking and typing. */
  selector: string
}

export interface Journey {
  /** The live page running dist/graph.js. */
  readonly page: Page
  /** The temp copy of the fixture pack this journey owns. */
  readonly packRoot: string
  /** The real GraphPanel driving it. */
  readonly panel: GraphPanel
  /** Files the host asked VS Code to open, in order. */
  readonly openedDocuments: readonly vscodeStub.OpenedDocument[]
  /** Files the host handed to the live preview -- what "Preview on select" ends in. Recorded
   * rather than acted on: there is no preview panel here, and building one would be testing a
   * second renderer rather than this one's wiring. */
  readonly previewedFiles: readonly string[]
  /** Every message the webview posted to the host, in order. */
  readonly posted: readonly HostMessage[]

  // -- the pack on disk ----------------------------------------------------
  file(rel: string): string
  read(rel: string): string
  write(rel: string, contents: string): void
  exists(rel: string): boolean
  remove(rel: string): void
  /** The pack-relative paths of every feature file, sorted. */
  featureFiles(): string[]
  /** What extension.ts does when a document in this pack is saved. */
  notifySaved(rel: string): Promise<void>

  // -- what the panel is showing -------------------------------------------
  status(): Promise<string>
  statusIsError(): Promise<boolean>
  nodeIds(): Promise<string[]>
  selectedNodeId(): Promise<string | null>
  /** The text of the side panel -- the inspector, or the overview when nothing is selected. */
  sideText(): Promise<string>
  /** Every drawn edge, as [from, jsonPath] pairs. */
  edges(): Promise<{ from: string; jsonPath: string }[]>
  /** Which edge, if any, is drawn as selected -- the `[from, jsonPath]` pair of the one carrying
   * the selected class. Null when no edge is selected. */
  selectedEdge(): Promise<{ from: string; jsonPath: string } | null>
  /** Every editable control inside `scope` (the side panel by default), found by BEING editable
   * -- an <input>, a <textarea>, a <select> or a contenteditable element -- rather than by an id
   * or a class this test invented.
   *
   * This is how a journey asks "can a person change this?" without knowing what the control that
   * lets them will be called. A test that looked for `#flg-molang-input` would be asserting that
   * somebody named a thing the way the test's author guessed, and would go red on a rename and
   * green on a control that is disabled, invisible or read-only. */
  editables(scope?: string): Promise<Editable[]>

  // -- waiting, on conditions -----------------------------------------------
  waitForNode(id: string): Promise<void>
  waitForNodeGone(id: string): Promise<void>
  waitForStatus(match: RegExp): Promise<string>
  /** How many graphs the page has received. Paired with waitForRedraw to wait out a round trip
   * that leaves the visible state unchanged. */
  graphCount(): Promise<number>
  waitForRedraw(since: number): Promise<void>
  /** Waits for the webview to post a message the predicate accepts, and returns it. `what`
   * describes what was being waited for, so a give-up says which promise went unkept rather than
   * "timed out". */
  waitForPost(what: string, match: (message: HostMessage) => boolean): Promise<HostMessage>

  // -- acting ---------------------------------------------------------------
  /** A point on the canvas with no node under it. */
  emptyCanvasPoint(): Promise<Point>
  /** Right-clicks empty canvas and waits for the creation menu. Returns the point clicked. */
  openCreationMenu(at?: Point): Promise<Point>
  /** Clicks a row in the creation menu by its visible name. */
  clickMenuRow(name: string): Promise<void>
  /** Drags the named menu row onto a canvas point, with real pointer events. */
  dragMenuRowTo(name: string, target: Point): Promise<void>
  /** Clicks a node on the canvas, bringing it into view first. */
  clickNode(id: string): Promise<void>
  /** Clicks the LINE of one edge, the way somebody tracing a delegation reaches for it: on the
   * fat transparent hit path the renderer draws over the thin visible one. Both ends are brought
   * into view first, because an edge whose nodes are off screen has no on-screen line. */
  clickEdge(from: string, jsonPath: string): Promise<void>
  /** Double-clicks a node, which is "open this node's file". */
  activateNode(id: string): Promise<void>
  /** The on-screen box of a node. */
  nodeBox(id: string): Promise<{ x: number; y: number; width: number; height: number }>
  /** A node's position in GRAPH coordinates -- what the layout, the drop and the sidecar all
   * speak. Read off the drawn card, which is where the renderer puts it. Screen coordinates
   * cannot answer "did it land where it was dropped", because creating a node also moves the
   * camera onto it. */
  graphPosition(id: string): Promise<Point>
  /** The camera and the canvas's screen origin, for converting a pointer position into the
   * graph coordinates a drop is recorded in. */
  viewportState(): Promise<{ camera: { x: number; y: number; zoom: number }; origin: Point }>

  /** The preview the graph opened, waited for. Throws for a journey opened without
   * `withPreview`, and for one where nothing has asked for a preview yet -- both of which are a
   * test asking for something it did not set up, not a product failure. */
  preview(): Promise<PreviewJourney>

  /** Page errors and console errors seen so far. A CSP fault lands here and nowhere else. */
  problems(): readonly string[]
  dispose(): Promise<void>
}

/** Opens the graph editor over a fresh copy of the fixture pack. */
export async function openJourney(options: OpenJourneyOptions = {}): Promise<Journey> {
  ensureBundleBuilt()
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flg-journey-'))
  fs.cpSync(FIXTURE_PACK, packRoot, { recursive: true })
  options.prepare?.(packRoot)

  // -- the asset server ----------------------------------------------------
  // Built AFTER the port is known, because the CSP names the origin the stylesheets come from.
  // Rendering first against a placeholder port produces a policy for 127.0.0.1:0 and the real
  // stylesheet is then blocked -- which the capture script learned the same way.
  let html = ''
  let previewHtml = ''
  const assets: Record<string, [string, string]> = {
    '/graph.js': [path.join(appRoot, 'dist', 'graph.js'), 'text/javascript'],
    '/graph.css': [path.join(appRoot, 'media', 'graph.css'), 'text/css'],
  }
  if (options.withPreview === true) {
    requireFreshFrontend()
    // The preview's own two files, the ones previewPanel.ts links. Both come out of dist/, which
    // ensureBundleBuilt just rebuilt -- webview.css is generated from featurelab-frontend's
    // panel.css by the same esbuild run, not checked in.
    assets['/webview.js'] = [path.join(appRoot, 'dist', 'webview.js'), 'text/javascript']
    assets['/webview.css'] = [path.join(appRoot, 'dist', 'webview.css'), 'text/css']
  }
  for (const [name, [file]] of Object.entries(assets)) {
    // ensureBundleBuilt() just built dist/; media/graph.css is checked in. A miss here is a
    // renamed or moved asset, not a forgotten build.
    if (!fs.existsSync(file)) throw new Error(`journey harness: ${file} is missing (${name})`)
  }
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
      return
    }
    if (url === '/preview') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(previewHtml)
      return
    }
    if (url === '/theme.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' })
      res.end(THEME_CSS)
      return
    }
    const entry = assets[url]
    if (entry === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': entry[1] })
    res.end(fs.readFileSync(entry[0]))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('journey harness: the asset server did not bind')
  const origin = `http://127.0.0.1:${address.port}`

  // -- the host ------------------------------------------------------------
  vscodeStub.webviewOrigin.value = origin
  const controller = new PreviewController(engineBinaryPath())
  const previewed: string[] = []
  let openPreview: Promise<PreviewJourney> | null = null
  let startPreview: ((document: unknown, attributeNodeId: string) => void) | null = null
  const before = vscodeStub.createdPanels.length
  const panel = GraphPanel.show(
    new vscodeStub.MockUri(appRoot) as unknown as import('vscode').Uri,
    controller,
    packRoot,
    ENGINE_TIMEOUT_MS,
    (document, attributeNodeId) => {
      previewed.push((document as unknown as { uri: { fsPath: string } }).uri.fsPath)
      // Without `withPreview` this is still only RECORDED, exactly as it was: a journey about
      // the node editor should not pay for a WebGL context and a second engine run.
      startPreview?.(document, attributeNodeId)
    },
      // The preview is not part of these journeys; the write notice goes nowhere.
      () => {},
    )
  const mockPanel = vscodeStub.createdPanels[before]
  if (mockPanel === undefined) throw new Error('journey harness: GraphPanel did not create a webview panel')

  // The shell HTML the REAL panel produced, with two additions and no rewriting: the theme
  // stylesheet, and the acquireVsCodeApi bootstrap under the SAME nonce the panel generated --
  // so if the policy is wrong the bootstrap dies exactly the way the editor's own script would.
  const shell = mockPanel.webview.html
  const nonce = /<style nonce="([^"]+)"/.exec(shell)?.[1]
  if (nonce === undefined) throw new Error('journey harness: could not find the shell nonce')
  html = shell
    .replace(`<link rel="stylesheet" href="${origin}/graph.css" />`, `<link rel="stylesheet" href="${origin}/theme.css" /><link rel="stylesheet" href="${origin}/graph.css" />`)
    .replace(
      '</body>',
      `<script nonce="${nonce}">
         window.acquireVsCodeApi = function () {
           return {
             postMessage: function (message) { window.__flHostPost(message) },
             getState: function () { return undefined },
             setState: function () {},
           }
         }
       </script></body>`,
    )
  if (!html.includes('theme.css')) throw new Error('journey harness: the shell no longer links graph.css the way this harness expects')

  // -- the page ------------------------------------------------------------
  const context = await (await sharedBrowser()).newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  const problems: string[] = []
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`)
  })

  // The pipe. Webview -> host through an exposed binding; host -> webview through the page's
  // own window.postMessage, which is how VS Code delivers one too. Host posts are chained so
  // they arrive in the order the panel sent them.
  // Everything the webview asks the host to do, recorded on the way past. Recorded rather than
  // intercepted: the message is still delivered and still acted on, so a journey can read the
  // request AND the file it produced, and the two disagreeing is itself a finding.
  const posted: HostMessage[] = []
  await page.exposeFunction('__flHostPost', (message: unknown) => {
    if (message !== null && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string') {
      posted.push(message as HostMessage)
    }
    mockPanel.webview.deliverFromWebview(message)
  })
  let chain: Promise<unknown> = Promise.resolve()
  let closed = false
  mockPanel.webview.onPost = (message) => {
    chain = chain
      .then(() => (closed ? undefined : page.evaluate((m) => window.postMessage(m, '*'), message as never)))
      .catch(() => undefined)
  }

  await page.goto(`${origin}/`)
  // Wait for a drawn node, not for a sentence in the status line: a readiness signal should be
  // the thing you are waiting FOR, not prose that happens to appear beside it.
  await page.waitForSelector('.flg-node', { timeout: WAIT_MS })

  // A graph counter, registered AFTER graph.ts registered its own listener, so it can only
  // increment once the editor has already handled and drawn that graph.
  await page.evaluate(() => {
    const w = window as unknown as { __flGraphs: number }
    w.__flGraphs = 0
    window.addEventListener('message', (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'graph') w.__flGraphs++
    })
  })

  // -- the preview -----------------------------------------------------------
  // Opened the way the extension opens one -- because the GRAPH asked for it -- rather than up
  // front. These three lines are extension.ts's openOrRevealPreview, reproduced for the same
  // reason notifySaved below reproduces its save handler: the real one is wired to VS Code's own
  // command and workspace events, and there is neither here. Everything they construct is real.
  if (options.withPreview === true) {
    startPreview = (document, attributeNodeId) => {
      // One preview per journey. A second `previewNode` for another file would open another
      // panel in the real extension; here it would mean a second page nothing is waiting on, and
      // every journey in this file previews one thing.
      if (openPreview !== null) return
      openPreview = openPreviewPanel({
        origin,
        controller,
        document,
        attributeNodeId,
        setHtml: (built) => {
          previewHtml = built
        },
        browser: sharedBrowser,
      })
    }
  }

  const file = (rel: string): string => path.join(packRoot, rel)

  const journey: Journey = {
    page,
    packRoot,
    panel,
    openedDocuments: vscodeStub.openedDocuments,
    previewedFiles: previewed,
    posted,

    file,
    read: (rel) => fs.readFileSync(file(rel), 'utf8'),
    write: (rel, contents) => {
      fs.mkdirSync(path.dirname(file(rel)), { recursive: true })
      fs.writeFileSync(file(rel), contents, 'utf8')
    },
    exists: (rel) => fs.existsSync(file(rel)),
    remove: (rel) => fs.rmSync(file(rel), { force: true }),
    featureFiles: () =>
      fs
        .readdirSync(path.join(packRoot, 'features'))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => `features/${name}`),
    // extension.ts's own save handler, which is three lines: every open panel showing this
    // pack re-reads it. Reproduced rather than driven because the real one is wired to
    // vscode.workspace.onDidSaveTextDocument and there is no workspace here.
    notifySaved: async (rel) => {
      for (const open of GraphPanel.openPanels()) {
        if (open.showsFile(file(rel))) await open.notifyFileSaved(file(rel))
      }
    },

    status: async () => (await page.textContent('#flg-status')) ?? '',
    statusIsError: async () => ((await page.getAttribute('#flg-status', 'class')) ?? '').includes('flg-status-error'),
    nodeIds: () => page.$$eval('.flg-node', (nodes) => nodes.map((n) => (n as HTMLElement).dataset['nodeId'] ?? '')),
    selectedNodeId: async () => {
      const found = await page.$$eval('.flg-node.flg-selected', (nodes) => nodes.map((n) => (n as HTMLElement).dataset['nodeId'] ?? ''))
      return found[0] ?? null
    },
    sideText: async () => (await page.textContent('#flg-side')) ?? '',
    edges: () =>
      page.$$eval('[data-edge-key]', (groups) =>
        groups.map((g) => {
          const parsed = JSON.parse(g.getAttribute('data-edge-key') ?? '["",""]') as [string, string]
          return { from: parsed[0], jsonPath: parsed[1] }
        }),
      ),

    selectedEdge: async () => {
      const keys = await page.$$eval('.flg-edge.flg-selected[data-edge-key]', (groups) =>
        groups.map((g) => g.getAttribute('data-edge-key') ?? ''),
      )
      const first = keys[0]
      if (first === undefined) return null
      const parsed = JSON.parse(first) as [string, string]
      return { from: parsed[0], jsonPath: parsed[1] }
    },

    editables: (scope = '#flg-side') =>
      page.evaluate((root: string) => {
        const host = document.querySelector(root)
        if (host === null) return []
        const found = [
          ...host.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]'),
        ] as HTMLElement[]
        return found.map((el, index) => {
          const tag = el.tagName.toLowerCase()
          const form = el as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement
          const isField = tag === 'input' || tag === 'textarea' || tag === 'select'
          const value = isField ? (form.value ?? '') : (el.textContent ?? '')
          const box = el.getBoundingClientRect()
          // "A person could type into it." Disabled, readonly and zero-sized all fail that in
          // the same way, so they are one flag rather than three a test would have to remember.
          const usable = isField ? !form.disabled && !form.readOnly : el.isContentEditable
          const labelled = el.getAttribute('aria-label') ?? ''
          const labelFor = el.id === '' ? null : document.querySelector(`label[for=${JSON.stringify(el.id)}]`)
          const label = labelled !== '' ? labelled : (labelFor?.textContent ?? el.closest('label')?.textContent ?? '')
          // An index-based selector, because the point of this whole function is to find
          // controls whose markup nobody has agreed on yet.
          el.setAttribute('data-journey-editable', String(index))
          return {
            tag,
            inputType: tag === 'input' ? (form.type ?? '') : '',
            value,
            editable: usable && box.width > 0 && box.height > 0,
            label: label.trim(),
            selector: `${root} [data-journey-editable="${index}"]`,
          }
        })
      }, scope),

    waitForNode: async (id) => {
      await page.waitForSelector(`.flg-node[data-node-id=${JSON.stringify(id)}]`, { timeout: WAIT_MS })
    },
    waitForNodeGone: async (id) => {
      await page.waitForSelector(`.flg-node[data-node-id=${JSON.stringify(id)}]`, { state: 'detached', timeout: WAIT_MS })
    },
    waitForStatus: async (match) => {
      await page.waitForFunction(
        (source: string) => new RegExp(source).test(document.getElementById('flg-status')?.textContent ?? ''),
        match.source,
        { timeout: WAIT_MS },
      )
      return (await page.textContent('#flg-status')) ?? ''
    },
    waitForPost: async (what, match) => {
      const deadline = Date.now() + WAIT_MS
      for (;;) {
        const hit = posted.find((m) => match(m))
        if (hit !== undefined) return hit
        if (Date.now() > deadline) {
          throw new Error(
            `journey harness: waited ${WAIT_MS}ms for ${what} and it never arrived. ` +
              `The webview posted: ${JSON.stringify(posted.map((m) => m.type))}`,
          )
        }
        await page.waitForTimeout(50)
      }
    },

    graphCount: () => page.evaluate(() => (window as unknown as { __flGraphs: number }).__flGraphs),
    waitForRedraw: async (since) => {
      await page.waitForFunction((n: number) => (window as unknown as { __flGraphs: number }).__flGraphs > n, since, {
        timeout: WAIT_MS,
      })
    },

    emptyCanvasPoint: async () => {
      const point = await page.evaluate(() => {
        const canvas = document.getElementById('flg-canvas')
        if (canvas === null) return null
        const box = canvas.getBoundingClientRect()
        const taken = [...document.querySelectorAll('.flg-node')].map((n) => n.getBoundingClientRect())
        const pad = 40
        for (let row = 0; row < 24; row++) {
          for (let col = 0; col < 24; col++) {
            const x = box.left + pad + ((col + 0.5) * (box.width - 2 * pad)) / 24
            const y = box.top + pad + ((row + 0.5) * (box.height - 2 * pad)) / 24
            const clear = taken.every((r) => x < r.left - 24 || x > r.right + 24 || y < r.top - 24 || y > r.bottom + 24)
            if (clear) return { x: Math.round(x), y: Math.round(y) }
          }
        }
        return null
      })
      if (point === null) throw new Error('journey harness: no empty canvas to right-click on')
      return point
    },

    openCreationMenu: async (at) => {
      const point = at ?? (await journey.emptyCanvasPoint())
      await page.mouse.click(point.x, point.y, { button: 'right' })
      await page.waitForSelector('.flp-menu:not([hidden])', { timeout: WAIT_MS })
      return point
    },

    clickMenuRow: async (name) => {
      const row = menuRow(page, name)
      await row.waitFor({ state: 'visible', timeout: WAIT_MS })
      await row.click()
    },

    dragMenuRowTo: async (name, target) => {
      const row = menuRow(page, name)
      await row.waitFor({ state: 'visible', timeout: WAIT_MS })
      const box = await row.boundingBox()
      if (box === null) throw new Error(`journey harness: menu row ${name} has no box`)
      const from = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      // Past the menu's 5px threshold first, so the gesture becomes a drag rather than a click,
      // then onto the target in steps, as a hand would.
      await page.mouse.move(from.x + 12, from.y + 12)
      await page.waitForSelector('.flp-ghost', { timeout: WAIT_MS })
      await page.mouse.move(target.x, target.y, { steps: 8 })
      await page.mouse.up()
    },

    clickNode: async (id) => {
      await journey.waitForNode(id)
      // Bring it into view the way a person would by panning: the panel opens readable rather
      // than fitted, so a node named by id can legitimately be off screen.
      await page.evaluate((nodeId: string) => {
        const view = (window as unknown as { __flgView?: { focusNode(id: string): void } }).__flgView
        view?.focusNode(nodeId)
      }, id)
      const node = page.locator(`.flg-node[data-node-id=${JSON.stringify(id)}]`)
      await node.click({ timeout: WAIT_MS })
    },

    clickEdge: async (from, jsonPath) => {
      const key = JSON.stringify([from, jsonPath])
      await page.waitForSelector(`[data-edge-key=${JSON.stringify(key)}]`, { timeout: WAIT_MS })
      // Bring the whole graph into the viewport, then pan onto the source node. An edge is a
      // line between two boxes; centring on one end is the closest thing to "look at this edge"
      // the view offers, and fitting first keeps a long edge's midpoint on screen.
      await page.evaluate((nodeId: string) => {
        const view = (window as unknown as { __flgView?: { zoomToFit(p?: number): void; focusNode(id: string): void } })
          .__flgView
        view?.zoomToFit(80)
        view?.focusNode(nodeId)
      }, from)

      // Attempted up to four times, and VERIFIED each time. Two things go wrong here and both
      // produce a click that quietly selects something other than the edge asked for, which is
      // far worse than a failure: the journey then asserts about the wrong edge.
      //
      //   - An edge is a curve, so the centre of its bounding box is frequently empty canvas
      //     beside it, and a click there DESELECTS.
      //   - A dense graph draws edges over each other, and the fat invisible hit paths overlap
      //     much more than the thin visible lines do.
      //
      // So candidate points along the path are offered to elementFromPoint and only one this
      // edge actually owns is clicked; and because the camera move and the click are separate
      // round trips into a page that is also laying out fifty node boxes, a press can still land
      // a frame out of date when the machine is loaded. That is what the retry is for.
      let why = 'it was never attempted'
      for (let attempt = 0; attempt < 4; attempt++) {
        const at = await page.evaluate((edgeKey: string) => {
          const group = document.querySelector(`[data-edge-key=${JSON.stringify(edgeKey)}]`)
          const hit = group?.querySelector('.flg-edge-hit') as SVGPathElement | null
          if (hit === null || hit === undefined) return { point: null, why: 'the edge is not drawn as a line' }
          const ctm = hit.getScreenCTM()
          if (ctm === null) return { point: null, why: 'the edge has no screen transform' }
          const canvas = document.getElementById('flg-canvas')?.getBoundingClientRect()
          if (canvas === undefined) return { point: null, why: 'the canvas is not there' }
          const total = hit.getTotalLength()
          let offScreen = 0
          let covered = 0
          for (const fraction of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.45, 0.55, 0.35, 0.65, 0.25, 0.75]) {
            const screen = hit.getPointAtLength(total * fraction).matrixTransform(ctm)
            const x = Math.round(screen.x)
            const y = Math.round(screen.y)
            if (x < canvas.left || x > canvas.right || y < canvas.top || y > canvas.bottom) {
              offScreen++
              continue
            }
            if (document.elementFromPoint(x, y) !== hit) {
              covered++
              continue
            }
            return { point: { x, y }, why: '' }
          }
          return {
            point: null,
            why: `no point along it is clickable (${offScreen} sampled points off screen, ${covered} covered by something drawn over it)`,
          }
        }, key)
        if (at.point === null) {
          why = at.why
        } else {
          await page.mouse.click(at.point.x, at.point.y)
          const selected = await page.$$eval('.flg-edge.flg-selected[data-edge-key]', (groups) =>
            groups.map((g) => g.getAttribute('data-edge-key') ?? ''),
          )
          if (selected.includes(key)) return
          why = `the click at ${at.point.x},${at.point.y} selected ${selected.length === 0 ? 'nothing' : JSON.stringify(selected)}`
        }
        await page.waitForTimeout(120)
      }
      throw new Error(`journey harness: cannot click edge ${key}: ${why}`)
    },
    activateNode: async (id) => {
      await journey.clickNode(id)
      await page.locator(`.flg-node[data-node-id=${JSON.stringify(id)}]`).dblclick({ timeout: WAIT_MS })
    },

    nodeBox: async (id) => {
      const box = await page.locator(`.flg-node[data-node-id=${JSON.stringify(id)}]`).boundingBox()
      if (box === null) throw new Error(`journey harness: node ${id} is not drawn`)
      return box
    },

    graphPosition: async (id) => {
      const at = await page.$eval(`.flg-node[data-node-id=${JSON.stringify(id)}]`, (el) => ({
        x: parseFloat((el as HTMLElement).style.left),
        y: parseFloat((el as HTMLElement).style.top),
      }))
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error(`journey harness: node ${id} has no drawn position`)
      return at
    },

    viewportState: async () => {
      const state = await page.evaluate(() => {
        const view = (window as unknown as { __flgView?: { getCamera(): { x: number; y: number; zoom: number } } }).__flgView
        const canvas = document.getElementById('flg-canvas')
        if (view === undefined || canvas === null) return null
        const box = canvas.getBoundingClientRect()
        return { camera: view.getCamera(), origin: { x: box.left, y: box.top } }
      })
      if (state === null) throw new Error('journey harness: the canvas is not there')
      return state
    },

    preview: async () => {
      if (options.withPreview !== true) {
        throw new Error('journey harness: this journey was opened without withPreview, so there is no preview panel')
      }
      // Waits for the graph to have ASKED, rather than opening one here: "the graph opens the
      // preview" is half of what the attribution journey is about, and a harness that opened one
      // on its own would make that half untestable.
      const deadline = Date.now() + WAIT_MS
      while (openPreview === null) {
        if (Date.now() > deadline) {
          throw new Error(
            `journey harness: waited ${WAIT_MS}ms for the graph to ask for a preview and it never did. ` +
              `The webview posted: ${JSON.stringify(posted.map((m) => m.type))}`,
          )
        }
        await page.waitForTimeout(50)
      }
      return openPreview
    },

    problems: () => problems,

    dispose: async () => {
      closed = true
      try {
        await context.close()
      } catch {
        // A page that already went away is not a failure of the test that used it.
      }
      if (openPreview !== null) {
        try {
          await (await openPreview).close()
        } catch {
          // Same: a preview that already went away is not this test's failure.
        }
      }
      panel.dispose()
      controller.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(packRoot, { recursive: true, force: true, maxRetries: 5 })
    },
  }
  return journey
}

// ---------------------------------------------------------------------------
// The preview panel
// ---------------------------------------------------------------------------

/** How far apart the points clickUntilAttributed tries are, and how many rings out it goes. A
 * feature framed to fill the view is hundreds of pixels across, so a 40px lattice lands several
 * points on it; the ring count bounds the walk at a few dozen clicks rather than a few hundred. */
const PICK_STEP_PX = 24
const PICK_RINGS = 6
/** How long one click is given to come back with an answer. A pick is a postMessage to the host,
 * a binary search in an already-built index, and a postMessage back -- there is no engine, no
 * disk and no network on that path, so this is generous rather than tuned. A click that hits
 * nothing sends no message at all and simply spends it. */
const PICK_ANSWER_MS = 400

interface OpenPreviewOptions {
  origin: string
  controller: PreviewController
  document: unknown
  attributeNodeId: string
  setHtml: (html: string) => void
  browser: () => Promise<Browser>
}

/** Builds the real PreviewPanel, serves the shell IT produced, and puts a page on the other end
 * of its webview -- the same three moves openJourney makes for the graph, for the same reasons.
 *
 * The texture flow is stubbed at its first question and nowhere else: `status` answers
 * 'declined', which is a real state a real machine reports (somebody said no once, and the
 * engine recorded it), and it is the one that makes ensureTextures return before it can reach a
 * network, a download prompt or a 150 MB fetch. Nothing else about the panel is faked. */
async function openPreviewPanel(options: OpenPreviewOptions): Promise<PreviewJourney> {
  // NOT destructured as `document`: this function also runs code inside the page, where that
  // name is the DOM's own and shadowing it silently breaks every query there.
  const { origin, controller, attributeNodeId } = options
  const textDocument = options.document

  // Every params object the panel actually sends, recorded on the way past. The request is still
  // made and its result still rendered -- this is a tap, not a substitute -- so a journey can
  // assert BOTH that a profile was asked for and that the preview drew what came back.
  const requests: Record<string, unknown>[] = []
  const tapped = new Proxy(controller, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if ((property !== 'generate' && property !== 'generateGrown') || typeof value !== 'function') return value
      return (packRoot: string, params: Record<string, unknown>, timeoutMs: number) => {
        requests.push(params)
        return (value as (...args: unknown[]) => unknown).call(target, packRoot, params, timeoutMs)
      }
    },
  })

  const textures = {
    status: () => Promise.resolve({ state: 'declined', dir: '', wantTag: '', needsDownload: false, detail: 'declined' }),
  } as unknown as TextureBuilder

  const before = vscodeStub.createdPanels.length
  const panel = new PreviewPanel(
    { extensionUri: new vscodeStub.MockUri(appRoot) } as unknown as import('vscode').ExtensionContext,
    tapped,
    { set: () => {}, delete: () => {} } as unknown as import('vscode').DiagnosticCollection,
    textDocument as import('vscode').TextDocument,
    () => {},
    textures,
    // The graph link, exactly as extension.ts wires it: a block clicked in the preview goes back
    // to whichever graph panel is showing that pack, and so does what the run measured.
    {
      attributeNodeId,
      onSelectNodes: (packRoot, nodeIds) => {
        for (const graph of GraphPanel.openPanels()) {
          if (graph.showsPack(packRoot)) graph.selectNodes(nodeIds)
        }
      },
      onRunStats: (packRoot, stats) => {
        for (const graph of GraphPanel.openPanels()) {
          if (graph.showsPack(packRoot)) graph.showRunStats(stats)
        }
      },
    },
  )
  const mockPanel = vscodeStub.createdPanels[before]
  if (mockPanel === undefined) throw new Error('journey harness: PreviewPanel did not create a webview panel')

  // The shell the REAL panel produced, with the same two additions the graph page gets and no
  // rewriting: the theme stylesheet, and the acquireVsCodeApi bootstrap under the panel's own
  // nonce -- so a wrong policy kills the bootstrap exactly the way it would kill the editor's.
  const shell = mockPanel.webview.html
  const nonce = /<style nonce="([^"]+)"/.exec(shell)?.[1]
  if (nonce === undefined) throw new Error('journey harness: could not find the preview shell nonce')
  const built = shell
    .replace(`<link rel="stylesheet" href="${origin}/webview.css" />`, `<link rel="stylesheet" href="${origin}/theme.css" /><link rel="stylesheet" href="${origin}/webview.css" />`)
    .replace(
      '</body>',
      `<script nonce="${nonce}">
         window.acquireVsCodeApi = function () {
           return {
             postMessage: function (message) { window.__flPreviewPost(message) },
             getState: function () { return undefined },
             setState: function () {},
           }
         }
       </script></body>`,
    )
  if (!built.includes('theme.css')) {
    throw new Error('journey harness: the preview shell no longer links webview.css the way this harness expects')
  }
  options.setHtml(built)

  const context = await (await options.browser()).newContext({ viewport: { width: 900, height: 700 } })
  const page = await context.newPage()
  const problems: string[] = []
  page.on('pageerror', (err) => problems.push(`preview page error: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`preview console error: ${msg.text()}`)
  })

  const posted: HostMessage[] = []
  await page.exposeFunction('__flPreviewPost', (message: unknown) => {
    if (message !== null && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string') {
      posted.push(message as HostMessage)
    }
    mockPanel.webview.deliverFromWebview(message)
  })
  let chain: Promise<unknown> = Promise.resolve()
  let closed = false
  mockPanel.webview.onPost = (message) => {
    chain = chain
      .then(() => (closed ? undefined : page.evaluate((m) => window.postMessage(m, '*'), message as never)))
      .catch(() => undefined)
  }

  await page.goto(`${origin}/preview`)
  // The viewer, not a sentence about it: this page's readiness is "the 3D view exists", and a
  // WebGL context that failed to come up fails HERE rather than forty lines into a click.
  await page.waitForFunction(() => (window as unknown as { __flViewer?: unknown }).__flViewer !== undefined, undefined, {
    timeout: WAIT_MS,
  })

  const readout = async (): Promise<string> => {
    const hidden = await page.getAttribute('#fl-attribution', 'hidden')
    if (hidden !== null) return ''
    return (await page.textContent('#fl-attribution')) ?? ''
  }

  const preview: PreviewJourney = {
    page,
    panel,
    posted,
    requests,
    attributionText: readout,
    waitForAttribution: async (match) => {
      await page.waitForFunction(
        (source: string) => {
          const el = document.getElementById('fl-attribution')
          if (el === null || el.hidden) return false
          return new RegExp(source).test(el.textContent ?? '')
        },
        match.source,
        { timeout: WAIT_MS },
      )
      return readout()
    },
    attributionCellCount: () =>
      page.evaluate(() => {
        const viewer = (window as unknown as { __flViewer?: { getAttributionCellCount(): number } }).__flViewer
        return viewer === undefined ? 0 : viewer.getAttributionCellCount()
      }),

    hideEnvironment: async () => {
      // The radio, not a viewer call: this is a control a person uses, and a harness that
      // reached past it into the viewer would leave the control itself untested.
      const radio = page.locator('#fl-sidebar input[name="fl-env-mode"][value="hidden"]')
      await radio.waitFor({ state: 'visible', timeout: WAIT_MS })
      await radio.check({ timeout: WAIT_MS })
    },

    frameContent: async () => {
      // R is bound on the document, and the sidebar's inputs deliberately swallow it (see
      // panel.ts's own handler), so the press has to land on the canvas -- which is where a
      // person's pointer already is when they reach for it.
      await page.locator('#fl-canvas').click({ position: { x: 2, y: 2 } })
      await page.keyboard.press('r')
    },

    clickUntilAttributed: async () => {
      const box = await page.locator('#fl-canvas').boundingBox()
      if (box === null) throw new Error('journey harness: the preview canvas has no box')
      const cx = Math.round(box.x + box.width / 2)
      const cy = Math.round(box.y + box.height / 2)
      // Outward from the centre, because that is where the first-result auto-frame puts the
      // content. Every point is a REAL press and release on the canvas; there is no other honest
      // way to find out whether a pixel is over a block.
      const points: { x: number; y: number }[] = [{ x: cx, y: cy }]
      for (let ring = 1; ring <= PICK_RINGS; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
            const x = cx + dx * PICK_STEP_PX
            const y = cy + dy * PICK_STEP_PX
            if (x < box.x + 4 || x > box.x + box.width - 4) continue
            if (y < box.y + 4 || y > box.y + box.height - 4) continue
            points.push({ x: Math.round(x), y: Math.round(y) })
          }
        }
      }
      if (points.length < 2) throw new Error('journey harness: the preview canvas is too small to click around in')
      let last = ''
      for (const point of points) {
        await page.mouse.click(point.x, point.y)
        // The answer is a round trip -- page to host, host through the index, host back to page
        // -- so the readout is polled rather than read once.
        const deadline = Date.now() + PICK_ANSWER_MS
        for (;;) {
          last = await readout()
          if (/Placed/.test(last)) return last
          if (Date.now() > deadline) break
          await page.waitForTimeout(25)
        }
      }
      throw new Error(
        `journey harness: clicked ${points.length} points on the preview canvas and none of them ` +
          `landed on an attributed block. The readout last said: ${JSON.stringify(last)}`,
      )
    },

    problems: () => problems,

    close: async () => {
      closed = true
      panel.dispose()
      try {
        await context.close()
      } catch {
        // A page that already went away is not a failure of the test that used it.
      }
    },
  }
  return preview
}

/** A creation-menu row by its visible name. Matched on the name element rather than on the row
 * text, so a summary mentioning another entry's word cannot pick the wrong row. */
function menuRow(page: Page, name: string) {
  return page.locator('.flp-row').filter({ has: page.locator('.flp-row-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) }).first()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** An inspector row's controls, by the key it edits. `data-key` is the field name the form
 * built the row for, which is what a person reads off the label beside it. */
export function inspectorRow(page: Page, key: string) {
  return page.locator(`#flg-side .flg-ins-row[data-key=${JSON.stringify(key)}]`).first()
}
