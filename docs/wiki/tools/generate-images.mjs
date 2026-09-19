#!/usr/bin/env node
// generate-images.mjs -- the wiki's image pipeline. Regenerates every screenshot listed in
// images.manifest.mjs from scratch: builds the featurelab CLI, runs `featurelab check` and
// `featurelab generate` against the committed fixtures/ pack, then renders each result through
// the REAL featurelab-frontend voxel viewer (frontend/dist -- built output, a library import,
// not a fork) in a headless Chromium page and screenshots it.
//
// Usage (from the repo root, or anywhere -- paths below are all resolved from this file's own
// location, not the current working directory):
//
//   node docs/wiki/tools/generate-images.mjs
//   node docs/wiki/tools/generate-images.mjs --only ore-coal-vein   # regenerate one image
//
// Requirements already satisfied by this repo's own workspace, nothing extra to install:
//   - Go toolchain on PATH (builds cmd/featurelab fresh every run -- see buildEngine below)
//   - `npm install` at the repo root (or `npm run build` under frontend/) already run at least
//     once, so frontend/dist/index.js exists -- this script imports that BUILT output, exactly
//     like apps/vscode's webview does, and does not build the frontend itself
//   - playwright's Chromium browser installed (`npx playwright install chromium` under
//     apps/vscode/, where the playwright devDependency lives)
//
// Determinism: every image is produced from an explicit --seed in images.manifest.mjs (no
// preset default, no wall-clock, no environment RNG left to chance), a fixed 1000x650 viewport
// with deviceScaleFactor pinned to 1, and VoxelViewer's own frameContent() -- a pure function
// of the decoded volume (see render-entry.mjs's own doc comment on why: no orbiting, no
// animation settling on a random frame, one deterministic camera fit per volume). Re-running
// this exact command against an unchanged fixtures/ pack reproduces byte-identical PNGs.
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import { IMAGES } from './images.manifest.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(toolsDir, '..', '..', '..')
const fixturesPack = path.join(toolsDir, 'fixtures')
const imagesDir = path.resolve(toolsDir, '..', 'images')
const binPath = path.join(repoRoot, 'bin', process.platform === 'win32' ? 'featurelab.exe' : 'featurelab')
const frontendDist = path.join(repoRoot, 'frontend', 'dist', 'index.js')

const CANVAS_WIDTH = 1000
const CANVAS_HEIGHT = 650

function buildEngine() {
  console.log(`[1/4] go build -o ${path.relative(repoRoot, binPath)} ./cmd/featurelab`)
  execFileSync('go', ['build', '-o', binPath, './cmd/featurelab'], { cwd: repoRoot, stdio: 'inherit' })
}

function runCLI(args) {
  // featurelab writes its JSON result to stdout and warnings/errors to stderr -- see
  // cmd/featurelab/main.go's own doc comment ("Subcommands"). execFileSync throws on a
  // non-zero exit, which is exactly the "did this actually run cleanly" gate this pipeline
  // wants: an example whose `check`/`generate` call fails stops the whole run rather than
  // silently producing a stale or misleading image.
  const stdout = execFileSync(binPath, args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout)
}

function checkFixturePack() {
  console.log(`[2/4] featurelab check --pack ${path.relative(repoRoot, fixturesPack)} --json`)
  // --json is required, not decoration: `check` prints a human table by default and only this
  // flag gives back the array runCLI parses. Without it this step reads a text summary as JSON
  // and dies one line later on a brace it never found.
  const diagnostics = runCLI(['check', '--pack', fixturesPack, '--json'])
  const errors = diagnostics.filter((d) => d.level === 'error')
  if (errors.length > 0) {
    throw new Error(`featurelab check reported ${errors.length} error diagnostic(s):\n${JSON.stringify(errors, null, 2)}`)
  }
  console.log(`       ok -- ${diagnostics.length} diagnostic(s), none at error level`)
}

function generateFeature(entry) {
  // An entry names EITHER a feature or a rule. A rule goes through the CLI's own --rule mode,
  // which runs it once per chunk the bench covers from that chunk's corner (see
  // docs/wiki/feature-rules.md) rather than once at an origin -- so a rule entry usually wants a
  // --size spanning more than one chunk, and its `minY` matters more than a feature's does.
  const subject = entry.rule ? ['--rule', entry.rule] : ['--feature', entry.feature]
  const args = ['generate', '--pack', fixturesPack, ...subject, '--env', entry.env, '--seed', String(entry.seed)]
  // A couple of entries float the origin above the surface on purpose (see
  // images.manifest.mjs's own doc comment) -- everything else relies on the CLI's own default
  // (x=0,z=0, preset auto Y).
  if (entry.origin) args.push('--origin', entry.origin)
  // A couple of entries (buried features -- see images.manifest.mjs) deliberately shrink the
  // preview volume so its own boundary sits right next to the feature, turning face culling's
  // ordinary "no neighbour past the edge -> draw the face" rule into a real cutaway wall instead
  // of just a horizontal slice -- a Y-only slice alone can't do
  // that for a feature buried on all sides.
  if (entry.size) args.push('--size', entry.size)
  if (entry.minY !== undefined) args.push('--min-y', String(entry.minY))
  if (entry.biomeTags) args.push('--biome-tags', entry.biomeTags)
  console.log(`       featurelab ${args.join(' ')}`)
  const result = runCLI(args)
  const errors = (result.diagnostics ?? []).filter((d) => d.level === 'error')
  if (errors.length > 0) {
    throw new Error(`featurelab generate --feature ${entry.feature} reported error diagnostics:\n${JSON.stringify(errors, null, 2)}`)
  }
  return result
}

async function bundleRenderEntry() {
  const result = await esbuild.build({
    entryPoints: [path.join(toolsDir, 'render-entry.mjs')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
    absWorkingDir: toolsDir,
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling render-entry.mjs')
  return output.text
}

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #14161a; }
  canvas { display: block; width: ${CANVAS_WIDTH}px; height: ${CANVAS_HEIGHT}px; }
</style></head><body><canvas id="canvas"></canvas></body></html>`

// captureOne renders one entry, RETRYING a blank frame rather than writing it.
//
// The render is usually deterministic -- the whole set regenerates byte-identically run after run
// -- but not always, and the entry that goes wrong is almost always the FIRST one, because it is
// the one that meets SwiftShader's asynchronous context restore before anything has warmed up.
// Each attempt gets a fresh page and a longer settle, so a retry is a genuinely different
// attempt rather than the same race run again.
async function captureOne(browser, bundledScript, entry, rawResult) {
  const attempts = 3
  for (let attempt = 1; ; attempt++) {
    try {
      return await captureOnce(browser, bundledScript, entry, rawResult, attempt)
    } catch (err) {
      if (attempt >= attempts || !(err instanceof BlankFrameError)) throw err
      console.log(`       ${entry.id}: blank frame on attempt ${attempt}, retrying with a longer settle`)
    }
  }
}

// BlankFrameError is the one failure captureOne retries. Anything else -- a missing feature, a
// bundling failure, a timeout waiting for __flReady -- is a real problem and propagates.
class BlankFrameError extends Error {}

async function captureOnce(browser, bundledScript, entry, rawResult, attempt) {
  const settle = 500 * attempt
  const page = await browser.newPage({ viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, deviceScaleFactor: 1 })
  try {
    await page.setContent(PAGE_HTML)
    await page.addScriptTag({ content: bundledScript })
    // See apps/vscode/scripts/capture-screenshots.mjs's own comment on this same wait: SwiftShader
    // (software WebGL, see the launch args below) loses its context on startup and auto-restores
    // shortly after -- give it time to settle before rendering, or the first paint can land
    // mid-restore.
    await page.waitForTimeout(settle)
    await page.evaluate((payload) => window.__flRender(payload), { raw: rawResult, slice: entry.slice ?? null, envMode: entry.envMode ?? null })
    await page.waitForFunction(() => window.__flReady === true, { timeout: 10_000 })
    // A couple of animate() frames so OrbitControls' damping settles and the just-set camera
    // position has actually been rendered at least once (see viewer.ts's animate loop).
    await page.waitForTimeout(300 * attempt)
    const canvas = await page.$('#canvas')
    const outPath = path.join(imagesDir, entry.out)

    // Refuse to write a blank frame.
    //
    // This pipeline is USUALLY deterministic -- all 24 images regenerate byte-identically run
    // after run -- but not always. One run in a batch produced a completely empty canvas for
    // single-block-feature-pumpkin.png: the feature had placed its block (verified separately
    // from the CLI), the render just did not happen. SwiftShader's context is restored
    // asynchronously on startup and the fixed waits above are a heuristic, not a guarantee.
    //
    // The failure mode is what makes this worth a check rather than a comment: a blank PNG is a
    // valid PNG. It writes without error, `git status` shows one modified image among two dozen,
    // and a documentation page quietly loses its picture. It was caught here only because the
    // whole set was being hashed against a previous run, which is not something a maintainer
    // regenerating one image would do.
    //
    // The test is deliberately crude and cheap: count distinct colours in the rendered canvas. A
    // real render of a voxel scene has dozens at minimum; a blank frame has one (the clear
    // colour), or two with an antialiased edge. Anything under the threshold is a failed render,
    // not a legitimately plain image -- no entry in the manifest is a solid colour.
    // Screenshot to a buffer first, then decide whether it is worth writing.
    //
    // The blankness check CANNOT read the live canvas. It is a WebGL canvas created without
    // preserveDrawingBuffer, so `drawImage(canvasEl, 0, 0)` into a 2D context returns an empty
    // image once the frame has been composited -- which is most of the time, and which made an
    // earlier version of this check report every entry as blank while the PNGs it refused to
    // write were perfectly good. Playwright's own screenshot path does not go through
    // drawImage and does capture the real pixels, so the buffer it returns is the thing to
    // examine.
    const shot = await canvas.screenshot()

    // Why this check exists at all: a run of this script produced a completely empty canvas for
    // single-block-feature-pumpkin.png while the feature itself had placed its block (verified
    // from the CLI). A blank PNG is a valid PNG -- it writes without error, `git status` shows
    // one modified image among two dozen, and a page quietly loses its picture. It was caught
    // only because the whole set was being hashed against a previous run, which is not something
    // a maintainer regenerating one image would do.
    //
    // The test is crude and cheap on purpose: count distinct colours. A voxel render has dozens
    // at minimum; a blank frame has one, or two with an antialiased edge. No entry in the
    // manifest is a solid colour, so there is no legitimate image this can reject.
    const distinctColours = await page.evaluate(async (dataUri) => {
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('could not decode the screenshot'))
        img.src = dataUri
      })
      const off = document.createElement('canvas')
      off.width = img.width
      off.height = img.height
      const g = off.getContext('2d')
      g.drawImage(img, 0, 0)
      const { data } = g.getImageData(0, 0, off.width, off.height)
      const seen = new Set()
      // Every 37th pixel: coprime with any plausible row width, so the sample walks the whole
      // frame rather than one column, and a 37th of ~900k pixels is still ~24k samples.
      for (let i = 0; i < data.length; i += 4 * 37) {
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
        if (seen.size > 64) break
      }
      return seen.size
    }, `data:image/png;base64,${shot.toString('base64')}`)

    if (distinctColours < 8) {
      throw new BlankFrameError(
        `${entry.id}: the rendered frame has only ${distinctColours} distinct colour(s) after ` +
          `${attempt} attempt(s) -- blank or half-drawn, not a picture. Nothing was written. If ` +
          `this persists for one entry specifically, check that its feature still places anything ` +
          `at all: featurelab generate --pack docs/wiki/tools/fixtures --feature ${entry.feature}`
      )
    }

    fs.writeFileSync(outPath, shot)
    console.log(`       wrote ${path.relative(repoRoot, outPath)} (${distinctColours >= 64 ? '64+' : distinctColours} colours)`)
  } finally {
    await page.close()
  }
}

async function main() {
  const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
  const images = onlyArg ? IMAGES.filter((e) => e.id === onlyArg) : IMAGES
  if (images.length === 0) {
    throw new Error(`--only ${onlyArg} matched no entry in images.manifest.mjs`)
  }

  if (!fs.existsSync(frontendDist)) {
    throw new Error(`${frontendDist} does not exist -- run "npm run build" under frontend/ first (this pipeline imports frontend/dist as a library, it does not build it)`)
  }

  buildEngine()
  checkFixturePack()

  console.log(`[3/4] featurelab generate (${images.length} image${images.length === 1 ? '' : 's'})`)
  const results = images.map((entry) => ({ entry, result: generateFeature(entry) }))

  console.log('[4/4] rendering + screenshotting')
  const bundledScript = await bundleRenderEntry()
  fs.mkdirSync(imagesDir, { recursive: true })
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
  try {
    for (const { entry, result } of results) {
      await captureOne(browser, bundledScript, entry, result)
    }
  } finally {
    await browser.close()
  }

  console.log(`\ndone -- ${images.length} image(s) written to ${path.relative(repoRoot, imagesDir)}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
