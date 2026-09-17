#!/usr/bin/env node
// generate-texture-figure.mjs -- the one wiki image that is a BEFORE and AFTER.
//
// Every other image in docs/wiki/images/ is made by generate-images.mjs, which renders flat
// block colours and asserts that it did (see render-entry.mjs's own comment on why: those
// images are committed, and a committed image must not change appearance depending on whether
// the machine that regenerated it happens to have a block atlas). Textured rendering is the one
// subject a flat-colour picture cannot illustrate, so it gets its own script rather than a flag
// on that one -- the assertion over there stays exactly as strict as it is.
//
// What this produces: ONE PNG, two renders of the SAME generate result side by side at the same
// size and the same camera. Left half flat, right half textured. Nothing else differs -- same
// feature, same seed, same environment mode, same viewport, same frameContent() fit -- so every
// difference in the picture is the atlas and only the atlas.
//
// Usage (from anywhere -- paths resolve from this file, not the working directory):
//
//   node docs/wiki/tools/generate-texture-figure.mjs
//
// Requirements, on top of generate-images.mjs's own (Go toolchain, `npm install` at the repo
// root so frontend/dist exists, playwright's Chromium):
//
//   - Mojang's sample resource pack must ALREADY be on this machine, either cached by an
//     earlier `featurelab textures --download` or pointed at by FEATURELAB_VANILLA_PACK.
//     This script never passes -download and never will: an image pipeline that fetches
//     150 MB from the network on its own is exactly the behaviour `featurelab textures`
//     exists to prevent. If the assets are not here, it says so and exits without writing.
//
// The atlas is built into bin/ (gitignored) rather than into the user's own atlas cache, so
// running this never changes what an editor or the desktop app on the same machine is drawing.
//
// Determinism: same as generate-images.mjs -- an explicit --seed, a fixed viewport with
// deviceScaleFactor 1, and VoxelViewer's own frameContent(). One extra source of variation
// exists here and is worth knowing about: the right-hand render samples Mojang's own texture
// files, so it is reproducible against a PINNED bedrock-samples tag
// (vanillaassets.PinnedTag) and not across tags. Bumping that pin is expected to change this
// image, and is the one image in the set that a pin bump legitimately moves.
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(toolsDir, '..', '..', '..')
const fixturesPack = path.join(toolsDir, 'fixtures')
const imagesDir = path.resolve(toolsDir, '..', 'images')
const binPath = path.join(repoRoot, 'bin', process.platform === 'win32' ? 'featurelab.exe' : 'featurelab')
const atlasDir = path.join(repoRoot, 'bin', 'wiki-atlas')
const frontendDist = path.join(repoRoot, 'frontend', 'dist', 'index.js')

// Half the width of a generate-images.mjs shot each, so the pair is the same 1000x650 as every
// other image on the wiki and drops into a page beside them without looking oversized.
const HALF_WIDTH = 499
const DIVIDER = 2
const CANVAS_HEIGHT = 650
const FULL_WIDTH = HALF_WIDTH * 2 + DIVIDER

// The subject. wiki:plain_trunk_tree is already the tree-feature page's `trunk` illustration
// (images.manifest.mjs, id tree-plain-trunk), which is the point of reusing it: a reader who
// has seen that picture flat sees the same tree here textured. It is also, by luck of what it
// places, the densest demonstration in the fixture pack of what the textured renderer actually
// does -- a log column whose pillar_axis puts end grain on the right faces, cutout biome-tinted
// leaves, vines rolled onto all four sides of every log (the one `attached` shape), and the
// grass blocks underneath it, whose sides are a fringe overlay composited over dirt.
const ENTRY = {
  feature: 'wiki:plain_trunk_tree',
  env: 'plains',
  seed: 3,
  out: 'block-textures-flat-vs-textured.png',
}

function run(args, opts = {}) {
  return execFileSync(binPath, args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

function buildEngine() {
  console.log(`[1/4] go build -o ${path.relative(repoRoot, binPath)} ./cmd/featurelab`)
  execFileSync('go', ['build', '-o', binPath, './cmd/featurelab'], { cwd: repoRoot, stdio: 'inherit' })
}

// buildAtlas gets an atlas into atlasDir without ever permitting a download. `featurelab
// textures` reports "nothing was downloaded" and exits 0 when it cannot proceed, which is right
// for a build script and wrong for this one: an image silently rendered flat on both halves is
// worse than no image, so the state is checked explicitly afterwards.
function buildAtlas() {
  console.log(`[2/4] featurelab textures --out ${path.relative(repoRoot, atlasDir)} --pack docs/wiki/tools/fixtures`)
  run(['textures', '--out', atlasDir, '--pack', fixturesPack, '--rebuild'], { stdio: ['ignore', 'inherit', 'inherit'] })
  const status = JSON.parse(run(['textures', '--out', atlasDir, '--pack', fixturesPack, '--status', '--json']))
  if (status.state !== 'ready') {
    throw new Error(
      `no block atlas, so there is no textured half to render.\n\n  ${status.detail}\n\n` +
        `This script never downloads anything on its own. Run "featurelab textures --download" once, ` +
        `or point FEATURELAB_VANILLA_PACK at a bedrock-samples resource_pack directory you already have, ` +
        `and run this again. Nothing was written.`
    )
  }
  const table = JSON.parse(fs.readFileSync(path.join(atlasDir, 'atlas.json'), 'utf-8'))
  const png = fs.readFileSync(path.join(atlasDir, 'atlas.png')).toString('base64')
  console.log(`       ok -- bedrock-samples ${table.tag}, ${table.cells.length} cells, ${table.width}x${table.height}`)
  return { table, png }
}

function generateFeature() {
  const args = ['generate', '--pack', fixturesPack, '--feature', ENTRY.feature, '--env', ENTRY.env, '--seed', String(ENTRY.seed)]
  console.log(`[3/4] featurelab ${args.join(' ')}`)
  const result = JSON.parse(run(args))
  const errors = (result.diagnostics ?? []).filter((d) => d.level === 'error')
  if (errors.length > 0) {
    throw new Error(`featurelab generate reported error diagnostics:\n${JSON.stringify(errors, null, 2)}`)
  }
  return result
}

async function bundleRenderEntry() {
  const result = await esbuild.build({
    entryPoints: [path.join(toolsDir, 'render-texture-figure-entry.mjs')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
    absWorkingDir: toolsDir,
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling render-texture-figure-entry.mjs')
  return output.text
}

// The divider is a background stripe on the flex row rather than an element between the two
// canvases, so neither canvas' own size is affected by it and the two halves stay identical.
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #14161a; }
  #figure { display: flex; gap: ${DIVIDER}px; background: #2b2f36; width: ${FULL_WIDTH}px; height: ${CANVAS_HEIGHT}px; }
  canvas { display: block; width: ${HALF_WIDTH}px; height: ${CANVAS_HEIGHT}px; }
</style></head><body>
<div id="figure"><canvas id="flat"></canvas><canvas id="textured"></canvas></div>
</body></html>`

class BlankFrameError extends Error {}

// Counts distinct colours in a screenshot BUFFER, never by reading the live canvas. Same rule
// and same reason as generate-images.mjs: the WebGL canvases here are created without
// preserveDrawingBuffer, so drawImage() on one returns an empty image once the frame has been
// composited, and an earlier version of that check called every good render blank.
async function distinctColours(page, shot) {
  return page.evaluate(async (dataUri) => {
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
    for (let i = 0; i < data.length; i += 4 * 37) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
      if (seen.size > 64) break
    }
    return seen.size
  }, `data:image/png;base64,${shot.toString('base64')}`)
}

async function captureOnce(browser, bundledScript, payload, attempt) {
  const settle = 500 * attempt
  const page = await browser.newPage({ viewport: { width: FULL_WIDTH, height: CANVAS_HEIGHT }, deviceScaleFactor: 1 })
  try {
    await page.setContent(PAGE_HTML)
    await page.addScriptTag({ content: bundledScript })
    // SwiftShader restores its context asynchronously on startup; render before it settles and
    // the first paint can land mid-restore. Same wait, same reason, as the other pipeline.
    await page.waitForTimeout(settle)
    await page.evaluate((p) => window.__flRenderFigure(p), payload)
    await page.waitForFunction(() => window.__flReady === true, { timeout: 20_000 })
    await page.waitForTimeout(300 * attempt)

    const figure = await page.$('#figure')
    const shot = await figure.screenshot()
    const colours = await distinctColours(page, shot)
    if (colours < 8) {
      throw new BlankFrameError(`the rendered figure has only ${colours} distinct colour(s) after ${attempt} attempt(s) -- blank or half-drawn`)
    }
    // Both halves must be genuinely different. A textured half that silently fell back to flat
    // colours produces a perfectly plausible, perfectly useless picture: two identical renders
    // of the same tree captioned "before" and "after". Compare the two halves' own pixels.
    const halvesDiffer = await page.evaluate(
      async ({ dataUri, half, gap }) => {
        const img = new Image()
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = () => reject(new Error('could not decode the screenshot'))
          img.src = dataUri
        })
        const off = document.createElement('canvas')
        off.width = img.width
        off.height = img.height
        off.getContext('2d').drawImage(img, 0, 0)
        const g = off.getContext('2d')
        const left = g.getImageData(0, 0, half, off.height).data
        const right = g.getImageData(half + gap, 0, half, off.height).data
        let differing = 0
        for (let i = 0; i < left.length; i += 4) {
          if (left[i] !== right[i] || left[i + 1] !== right[i + 1] || left[i + 2] !== right[i + 2]) differing++
        }
        return differing / (left.length / 4)
      },
      { dataUri: `data:image/png;base64,${shot.toString('base64')}`, half: HALF_WIDTH, gap: DIVIDER }
    )
    if (halvesDiffer < 0.02) {
      throw new Error(
        `the two halves of this figure are ${(halvesDiffer * 100).toFixed(2)}% different -- the textured ` +
          `half did not render textured. A before/after picture whose two halves are the same picture is ` +
          `worse than no picture, so nothing was written.`
      )
    }

    fs.mkdirSync(imagesDir, { recursive: true })
    const outPath = path.join(imagesDir, ENTRY.out)
    fs.writeFileSync(outPath, shot)
    console.log(
      `       wrote ${path.relative(repoRoot, outPath)} ` +
        `(${colours >= 64 ? '64+' : colours} colours, halves ${(halvesDiffer * 100).toFixed(1)}% different)`
    )
  } finally {
    await page.close()
  }
}

async function main() {
  if (!fs.existsSync(frontendDist)) {
    throw new Error(`${frontendDist} does not exist -- run "npm run build" under frontend/ first`)
  }
  buildEngine()
  const atlas = buildAtlas()
  const result = generateFeature()

  console.log('[4/4] rendering flat + textured, and screenshotting the pair')
  const bundledScript = await bundleRenderEntry()
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
  try {
    const payload = { raw: result, atlas }
    for (let attempt = 1; ; attempt++) {
      try {
        await captureOnce(browser, bundledScript, payload, attempt)
        break
      } catch (err) {
        if (attempt >= 3 || !(err instanceof BlankFrameError)) throw err
        console.log(`       blank frame on attempt ${attempt}, retrying with a longer settle`)
      }
    }
  } finally {
    await browser.close()
  }
  console.log('\ndone')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
