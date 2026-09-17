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
 * opaque surroundings.
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
  const canvas = document.getElementById('canvas')
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
  // environment mode is still 'hidden' is the whole trick.
  viewer.setEnvironmentMode('hidden')
  viewer.frameContent()
  viewer.setEnvironmentMode(envMode || 'ghost')
  window.__flReady = true
}
