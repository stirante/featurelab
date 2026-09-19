// render-entry.mjs -- the ONLY browser-side code this pipeline runs. Bundled by esbuild
// (see generate-images.mjs) into a single script and injected into a blank Playwright page
// via addScriptTag. Imports featurelab-frontend's own built output (frontend/dist/index.js)
// as a library -- the same public surface apps/vscode's webview uses (frontend/src/index.ts)
// -- rather than re-implementing any rendering. This file does not modify, wrap, or fork
// VoxelViewer; it only calls its existing public methods.
//
// Deliberately NOT the apps/vscode panel shell (previewPanel.ts / ui/panel.ts): that shell
// drives the whole extension sidebar (pickers, diagnostics list, budget controls, splitter --
// see apps/vscode/scripts/capture-screenshots.mjs's own doc comment for why THAT harness
// exists). A wiki illustration wants exactly the opposite: a bare canvas, nothing else,
// cropped to just the rendered volume.
import { VoxelViewer, decodeGenerateResult } from '../../../frontend/dist/index.js'

/**
 * Renders one `generate` result into the page's #canvas and reports readiness on
 * `window.__flReady`. Called from Node via `page.evaluate(render, {raw, slice, envMode})` --
 * see generate-images.mjs. `slice`, when given, is `{minY, maxY}` in absolute world Y -- see
 * the setSlice() call below for why an ore-style buried feature needs it and a surface
 * feature doesn't. `envMode` defaults to `'ghost'` (see below) and can be overridden per image
 * (images.manifest.mjs) to `'solid'` for a feature that reads clearer embedded in fully
 * opaque surroundings. The single-image path always frames on content; `__flRenderPanels`
 * below is the multi-panel variant, and paintInto() is what the two share.
 *
 * Rendering choices, and why they're fixed rather than left at VoxelViewer's own defaults:
 *  - environment mode 'ghost': the point of these images is "what did THIS feature generate",
 *    not "what does the preset terrain look like". Ghost mode renders every cell the feature
 *    itself changed at full opacity and everything else (including decorative terrain detail
 *    a preset's own Build() function adds, e.g. underground_stone's baseline ore blobs --
 *    see env/environment.go) as faint translucent context, so a viewer's eye is never asked to
 *    guess which blocks came from the JSON on the page and which came from the environment
 *    preset. VoxelViewer's own default ('solid') would render both the same way.
 *  - grid off: the sidebar-less isolated shot this pipeline produces has no other frame of
 *    reference for scale, but the grid/bounds wireframe reads as UI chrome, not part of "what
 *    this feature generates" -- left on it would visually compete with the actual blocks.
 *  - slice (optional): face-culled meshing (frontend/src/mesher.ts) never draws a face whose
 *    neighbour is solid -- correct for an ordinary view, but it means a feature entirely
 *    buried in a solid environment (an ore vein inside underground_stone's unbroken stone
 *    fill, say) renders as literally zero triangles: every one of its faces is occluded by
 *    the solid rock around it, same as it would be if you could really see through rock and
 *    found nothing but more rock. VoxelViewer's setSlice(minY, maxY) (the same "cut from top"
 *    control the extension's own slider drives) excludes cells outside that Y range from
 *    meshing entirely, so a slice ending just above the feature exposes its top face instead
 *    of walling it off -- a strip-mine cutaway, not a modification of what the feature itself
 *    produced.
 *  - frameContent(), not frameAll(): fits the camera to the occupied cells, not the full,
 *    mostly-empty request volume (a plains request is 32x48x32; a typical feature's own output
 *    is a handful of cells to a few dozen). An ordinary VoxelViewer.frameContent() call counts
 *    EVERY visible environment cell as "occupied" too, though (see contentBounds.ts's own
 *    `environmentVisible` param -- true whenever environment mode isn't 'hidden', ghost
 *    included), so with the environment on screen -- even ghosted -- frameContent() fits the
 *    whole terrain slab, not the feature: exactly the "diamond vein is a handful of pixels on a
 *    dark slab" bug this pipeline exists to avoid. A wiki illustration wants the opposite of the
 *    viewer's own default: the feature IS the subject, the environment is only context, so the
 *    camera must fit the feature's own written cells (`ViewerVolume.changed`), not everything
 *    drawn. There is no public "fit to changed cells only" method, so this gets there with two
 *    ordinary, already-public calls: force environment mode to 'hidden' (contentBounds.ts's
 *    `environmentVisible` becomes false, so only `changed` cells -- plus any carved-away cells,
 *    still governed by showCarved, on by default -- count as occupied), call frameContent() to
 *    fit the camera to THAT tighter box, then switch environment mode to what this image
 *    actually wants to render. setEnvironmentMode() only flips the ALREADY-BUILT environment
 *    mesh's visibility/material (see viewer.ts) -- it never touches the camera and never
 *    triggers a remesh, so restoring it after frameContent() cannot undo the framing just
 *    computed, and the environment still renders (ghosted or solid) around the now-tightly-framed
 *    feature for context. Both fitting calls go through the same deterministic corner-fit math
 *    (cameraFit.ts) -- the same decoded volume always fits to the same camera position, with no
 *    user interaction and no randomness anywhere in the framing path.
 */
window.__flRender = function render({ raw, slice, envMode }) {
  paintInto(document.getElementById('canvas'), { raw, slice, envMode, framing: 'content' })
  window.__flReady = true
}

/**
 * Renders several `generate` results into one figure -- one viewer per `#view-<i>` canvas, one
 * label per `#label-<i>` canvas -- for a manifest entry with `panels` (see images.manifest.mjs,
 * and generate-images.mjs's own doc comment on the figure layout). Every panel goes through the
 * SAME paintInto() as a single image, with the same slice and environment mode, so the only
 * thing that differs between panels is the result each one was handed.
 *
 * `framing: 'volume'` is the option a comparison figure needs and a single image does not:
 * frameContent() fits the camera to the cells a run wrote, which is right for one picture and
 * wrong for six side by side -- a distribution that clusters in the middle would be zoomed in
 * tighter than one that fills its extent, and the figure would show the camera moving rather
 * than the distribution changing. frameAll() fits the request volume instead, which is the same
 * `--size` for every panel, so every panel shares one camera (frameAll and frameContent both
 * go through the same deterministic corner fit; only the box differs).
 */
window.__flRenderPanels = function renderPanels({ panels, slice, envMode, framing }) {
  panels.forEach((panel, i) => {
    paintInto(document.getElementById(`view-${i}`), { raw: panel.raw, slice, envMode, framing })
    drawLabel(document.getElementById(`label-${i}`), panel.label)
  })
  window.__flReady = true
}

function paintInto(canvas, { raw, slice, envMode, framing }) {
  const viewer = new VoxelViewer(canvas)
  viewer.setShowGrid(false)
  // Flat block colours, pinned, on every machine.
  //
  // This is the ONE place in this repository where textures being off is a requirement rather
  // than a default. Every image under docs/wiki/images/ is committed, and a committed image
  // must not change appearance depending on whether the machine that regenerated it happens to
  // have a block atlas built -- so this asks for flat colours explicitly instead of relying on
  // VoxelViewer's own default, which the interactive hosts now turn ON as soon as an atlas
  // exists (see apps/vscode/src/previewPanel.ts's ensureTextures and apps/desktop's
  // setUpTextures). Nothing in this pipeline ever calls setAtlas, so this is belt and braces --
  // and it is asserted below rather than assumed, because "the pipeline happens not to supply
  // an atlas" is exactly the kind of property that stops being true by accident.
  viewer.setTexturesEnabled(false)
  if (viewer.hasAtlas() || viewer.getTexturesEnabled()) {
    throw new Error('wiki image pipeline: textures must be off -- these images are committed and must render identically everywhere')
  }
  const decoded = decodeGenerateResult(raw)
  viewer.setVolume(decoded.volume, decoded.palette)
  if (slice) viewer.setSlice(slice.minY, slice.maxY)
  viewer.resize()
  // Frame on the feature's own cells first (see doc comment above), THEN switch to the
  // environment mode this image actually wants rendered -- order matters, framing while
  // environment mode is still 'hidden' is the whole trick. A 'volume' framing (comparison
  // figures only -- see __flRenderPanels) fits the whole request volume instead and needs no
  // trick, since frameAll() never looks at what is drawn.
  viewer.setEnvironmentMode('hidden')
  if (framing === 'volume') viewer.frameAll()
  else viewer.frameContent()
  viewer.setEnvironmentMode(envMode || 'ghost')
  return viewer
}

// A 5x7 bitmap font, drawn with fillRect. Panel labels are the only text this pipeline ever
// puts INSIDE a committed image, and they must not depend on which fonts the machine that
// regenerated the image happens to have: headless Chromium ships no fonts of its own, so a
// `font-family` label would resolve to DejaVu on one CI image, Liberation on another and
// Segoe UI on a Windows laptop, and the figure would stop reproducing byte for byte for a
// reason that has nothing to do with what it shows. Rectangles are the same everywhere.
// Lowercase, digits and the few punctuation marks a distribution kind or a field name needs.
const GLYPHS = {
  a: ['.....', '.###.', '....#', '.####', '#...#', '.####', '.....'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '####.', '.....'],
  c: ['.....', '.###.', '#....', '#....', '#....', '.###.', '.....'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '.####', '.....'],
  e: ['.....', '.###.', '#...#', '#####', '#....', '.###.', '.....'],
  f: ['..##.', '.#..#', '.#...', '###..', '.#...', '.#...', '.....'],
  g: ['.....', '.####', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '.....'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '.###.', '.....'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '#..#.', '.##..'],
  k: ['#....', '#....', '#..#.', '#.#..', '##.#.', '#..#.', '.....'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '.###.', '.....'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '.....'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '.....'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '.###.', '.....'],
  p: ['.....', '.....', '####.', '#...#', '####.', '#....', '#....'],
  q: ['.....', '.....', '.####', '#...#', '.####', '....#', '....#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '.....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['.#...', '.#...', '###..', '.#...', '.#...', '..##.', '.....'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '.####', '.....'],
  v: ['.....', '.....', '#...#', '#...#', '.#.#.', '..#..', '.....'],
  w: ['.....', '.....', '#...#', '#.#.#', '#.#.#', '.#.#.', '.....'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  // Added for the search_feature figure, whose panel labels ARE the six enum values (-x, +x,
  // -y, +y, -z, +z) -- a label of "plus x" would not be the string the file has to contain.
  '+': ['.....', '.....', '..#..', '.###.', '..#..', '.....', '.....'],
  ':': ['.....', '..#..', '.....', '.....', '..#..', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}
const GLYPH_SCALE = 2
const GLYPH_ADVANCE = 6 // 5 columns plus one of spacing, in glyph pixels

function drawLabel(canvas, text) {
  const g = canvas.getContext('2d')
  g.fillStyle = '#14161a'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.fillStyle = '#d8dde6'
  const x0 = 8
  const y0 = Math.floor((canvas.height - 7 * GLYPH_SCALE) / 2)
  ;[...text].forEach((ch, n) => {
    const rows = GLYPHS[ch]
    if (!rows) throw new Error(`wiki image pipeline: no glyph for ${JSON.stringify(ch)} in label ${JSON.stringify(text)} -- labels are lowercase, digits, "_", "-", "+", ":" and space`)
    rows.forEach((row, r) => {
      ;[...row].forEach((cell, c) => {
        if (cell === '#') g.fillRect(x0 + (n * GLYPH_ADVANCE + c) * GLYPH_SCALE, y0 + r * GLYPH_SCALE, GLYPH_SCALE, GLYPH_SCALE)
      })
    })
  })
}
