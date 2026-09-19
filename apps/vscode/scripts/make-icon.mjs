// make-icon.mjs -- draws apps/vscode/media/icon.png, the Marketplace listing's icon.
//
// The icon is GENERATED, not hand-drawn and dropped in, so that changing it is an edit to this
// file rather than an opaque binary nobody can reproduce. It renders the SVG below in the same
// headless Chromium the capture scripts already use (playwright is a devDependency; nothing new
// is installed for this) and screenshots it at exactly 128x128, which is the size the VS Code
// Marketplace asks for.
//
// What it draws, and why: Feature Lab is a worldgen feature GRAPH over voxel TERRAIN, so the mark
// is three connected nodes above a blocky landform. Flat shapes, no gradients, no text, no
// outlines finer than 4px at 128 -- the listing renders it at 128 but the editor's own extensions
// list renders it at 32, and at 32 a thin line is a grey smudge. Run with `--check` to write a
// 32px copy into the temp directory so that claim can be looked at rather than assumed.
//
// It uses the graph editor's OWN palette: media/graph.css's `--flg-kind-*` fallbacks, which are
// VS Code's categorical chart colours. The terrain is deliberately slate rather than
// green-over-brown: the mark must not borrow Minecraft's trade dress, and a grass-topped dirt
// block is exactly that. No Mojang asset, font or texture is used or referenced here.
//
// Usage: node scripts/make-icon.mjs [--out <file>] [--check]   (run from apps/vscode/)

import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag === -1 ? path.join(root, 'media', 'icon.png') : path.resolve(process.argv[outFlag + 1] ?? '')
const check = process.argv.includes('--check')

const SIZE = 128

/** media/graph.css's own fallback values for the tokens named beside each one. */
const C = {
  tile: '#1b1f24', // a shade under --flg-bg (#1e1e1e), so the rounded corners read as a tile
  edge: '#8b96a3', // --flg-kind-child, lightened: at 32px the CSS value sank into the tile
  scatter: '#29b8db', // --flg-kind-scatter
  rule: '#4e94ce', // --flg-kind-rule
  aggregate: '#89d185', // --flg-kind-aggregate
  terrain: '#46525f', // the landform's body: slate, not soil
  terrainTop: '#6d7d8f', // its lit top face
}

/** The four terrain columns, as [x, width, topY]. Four wide columns rather than eight narrow
 * ones: at 32px an eight-column skyline is a dotted line, and the shape stops reading as ground.
 * They occupy the bottom 40% -- the first draft gave them 20% and the landform read as two
 * stripes at the edge of the tile rather than as ground the graph sits over. */
const COLUMNS = [
  [0, 32, 102],
  [32, 32, 88],
  [64, 32, 80],
  [96, 32, 94],
]
/** How much of each column is its lit top face. */
const TOP_FACE = 10

/** The graph: one parent delegating to two children, which is the smallest drawing that is
 * recognisably a feature graph rather than three unrelated dots. */
const NODES = [
  { cx: 64, cy: 26, r: 15, fill: C.scatter },
  { cx: 31, cy: 58, r: 13, fill: C.rule },
  { cx: 97, cy: 58, r: 13, fill: C.aggregate },
]
const EDGES = [
  [64, 26, 31, 58],
  [64, 26, 97, 58],
]

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <!-- The terrain columns are square and run to the bottom edge, so without this they punch
         square corners back out of the tile's rounded ones. -->
    <clipPath id="tile"><rect x="0" y="0" width="128" height="128" rx="22" ry="22"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
  <rect x="0" y="0" width="128" height="128" fill="${C.tile}"/>
  ${COLUMNS.map(
    ([x, w, top]) => `
  <rect x="${x}" y="${top}" width="${w}" height="${128 - top}" fill="${C.terrain}"/>
  <rect x="${x}" y="${top}" width="${w}" height="${TOP_FACE}" fill="${C.terrainTop}"/>`,
  ).join('')}
  ${EDGES.map(
    ([x1, y1, x2, y2]) =>
      `\n  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.edge}" stroke-width="9" stroke-linecap="round"/>`,
  ).join('')}
  ${NODES.map(
    // Each node is ringed in the tile colour so an edge running under it does not visually fuse
    // with it once the whole thing is a third of this size.
    (n) =>
      `\n  <circle cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="${n.fill}" stroke="${C.tile}" stroke-width="5"/>`,
  ).join('')}
  </g>
</svg>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewportSize: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
  await page.setContent(
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent}` +
      `svg{display:block}</style>${svg}`,
  )
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  await page.screenshot({ path: outPath, omitBackground: true })

  if (check) {
    // The legibility claim in this file's header, as an artefact somebody can open. Rendered by
    // downscaling the real 128px drawing, which is what the editor's extensions list does.
    const small = await browser.newPage({ viewportSize: { width: 32, height: 32 }, deviceScaleFactor: 1 })
    await small.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;width:32px;height:32px;background:#f3f3f3}` +
        `svg{display:block;width:32px;height:32px}</style>${svg}`,
    )
    // Into the temp directory, not next to the icon: media/ ships inside the VSIX, and a
    // legibility check is not a shipped asset.
    const checkPath = path.join(os.tmpdir(), 'featurelab-icon-32.png')
    await small.screenshot({ path: checkPath })
    console.log(`wrote ${checkPath} (the 32px legibility check)`)
  }
  console.log(`wrote ${outPath}`)
} finally {
  await browser.close()
}
