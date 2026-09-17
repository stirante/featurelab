// render-texture-figure-entry.mjs -- the browser-side half of generate-texture-figure.mjs.
//
// Sibling of render-entry.mjs and deliberately NOT the same file: that one pins textures OFF
// and throws if an atlas ever reaches it, which is a property every committed flat-colour image
// needs and which this figure exists to violate on purpose, on one half of one picture.
// Splitting them keeps that assertion unconditional over there instead of turning it into a
// flag somebody can pass by accident.
//
// Both halves go through the same public VoxelViewer surface (frontend/dist, a library import,
// the same one apps/vscode's webview uses) with the same volume, the same environment mode and
// the same frameContent() fit. The ONLY difference between them is setAtlas + setTexturesEnabled
// on the right-hand viewer.
import { VoxelViewer, decodeGenerateResult, decodeAtlas } from '../../../frontend/dist/index.js'

/**
 * Renders `raw` twice into #flat and #textured and reports readiness on `window.__flReady`.
 *
 * The framing dance is render-entry.mjs's, for its reasons: frameContent() counts every visible
 * environment cell as occupied, so fitting the camera to the FEATURE means hiding the
 * environment, fitting, then putting the environment back (setEnvironmentMode only flips the
 * already-built mesh's material -- it never touches the camera). Both viewers run it
 * identically, so both halves end up on the same camera and the two trees line up pixel for
 * pixel where the atlas has not changed them.
 */
window.__flRenderFigure = async function render({ raw, atlas }) {
  const decoded = decodeGenerateResult(raw)
  const decodedAtlas = decodeAtlas(atlas)

  async function paint(canvasId, textured) {
    const viewer = new VoxelViewer(document.getElementById(canvasId))
    viewer.setShowGrid(false)
    if (textured) {
      await viewer.setAtlas(decodedAtlas)
      viewer.setTexturesEnabled(true)
      if (!viewer.hasAtlas() || !viewer.getTexturesEnabled()) {
        throw new Error('texture figure: the textured half has no atlas -- it would render flat, and the figure would show nothing')
      }
    } else {
      // Explicit, not assumed: the viewer's own default is what the interactive hosts now
      // change, and the left half of this picture is the thing being compared against.
      viewer.setTexturesEnabled(false)
      if (viewer.hasAtlas() || viewer.getTexturesEnabled()) {
        throw new Error('texture figure: the flat half must be flat')
      }
    }
    viewer.setVolume(decoded.volume, decoded.palette)
    viewer.resize()
    viewer.setEnvironmentMode('hidden')
    viewer.frameContent()
    viewer.setEnvironmentMode('ghost')
    return viewer
  }

  await paint('flat', false)
  await paint('textured', true)
  window.__flReady = true
}
