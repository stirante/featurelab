// viewer.ts -- the three.js voxel viewer.
// Face-culled meshing, orbit + a max-Y "cut from top" slider, environment solid/ghost/hidden,
// and the translucent carved-volume overlay have been here from the start; the touch-count
// heatmap arrived once the Go wire format grew per-cell write counts (session.Result
// .Profile, profiler/profiler.go) -- see setShowHeatmap below.
// Click-to-pick arrived with attribution (see `setAttributionCells`/`pickCell` below): the
// editor's "which node placed this block" direction needs a world cell from a screen point, and
// nothing else can turn a pixel back into a cell. It is a QUERY, not a mode -- this viewer binds
// no pointer handler of its own and owns no notion of a selected block; a host decides which
// gesture counts as a pick and what a picked cell means.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { computeOccupiedBounds } from './contentBounds.js'
import { boxContains, computeClipPlanes, fitBoxToView, maxDollyDistance, type Box3, type Vec3 } from './cameraFit.js'
import { createViewportOverlay, type OverlayNotice, type OverlayProjection, type ViewportOverlayHandle } from './ui/viewportOverlay.js'
import { compileAtlas, type CompiledAtlas, type MeshBuffers, type OverflowBlockMesh } from './mesher.js'
import { buildScenePasses, describeCellAt, describeLegend, internAttributionGroups, summarizeVolume, type AttributionState, type CellBox, type VolumeSummary } from './remesh.js'
import type { AtlasTableWire, DecodedAtlas } from './protocol.js'
import { compileShapes } from './shapes.js'

export type BlockKind = 'air' | 'solid' | 'liquid' | 'plant' | 'glass'

export interface ViewerPaletteEntry {
  id: number
  name: string
  /** packed 0xRRGGBB */
  color: number
  kind: BlockKind
  /** The block's states, exactly as the engine interned them (`block.Entry.States`) -- null or
   * absent for a stateless block, which is most of them. Read only by a TEXTURED pass, to work
   * out a block's shape and how its texture maps onto it (`shapes.ts`); flat-colour mode has
   * never looked at states and still does not. Optional so a caller that builds a palette by
   * hand -- every test in this repo, and any host older than this field -- keeps compiling and
   * gets exactly today's behaviour. */
  states?: Readonly<Record<string, unknown>> | null
}

export interface ViewerVolume {
  minX: number
  minY: number
  minZ: number
  sizeX: number
  sizeY: number
  sizeZ: number
  /** Block ids. index = (y-minY)*sizeX*sizeZ + (z-minZ)*sizeX + (x-minX) */
  data: Uint32Array
  /** Same indexing as `data`. 1 = written by the feature under test (baseline id differs
   * from the result id at this cell). */
  changed: Uint8Array
  /** Same indexing as `data`. 1 = this cell was non-air before the feature ran and is air
   * now -- carved out. Rendered as a distinct translucent "carved" volume (see
   * `VoxelViewer.setShowCarved`) since a plain air cell draws nothing on its own. */
  removed: Uint8Array
  /** Same indexing as `data`. Block ids as they were before the feature ran -- the
   * shape/colour source for `removed` cells, whose current `data` id is air. */
  baseline: Uint32Array
  /** Optional, same indexing as `data`. Per-cell write count while the profiler was active
   * (session.Config.Profiling, profiler/profiler.go) -- 0 for a cell no feature ever wrote
   * to. Drives the touch-count heatmap overlay (see `VoxelViewer.setShowHeatmap`); undefined
   * entirely when profiling was off for the run that produced this volume. */
  touchCounts?: Uint32Array
  /** Out-of-bounds writes the engine's overflow store captured instead of dropping (session.
   * Result.OverflowBlocks, volume.Volume.Overflow) -- world positions OUTSIDE [minX,minX+sizeX)/
   * [minY,minY+sizeY)/[minZ,minZ+sizeZ), so unlike every other field here, these CANNOT be
   * indexed into `data`'s flat cell-index scheme; a consumer renders each entry at its own
   * absolute world position instead (see `buildOverflowMesh`, mesher.ts). Empty/undefined when
   * nothing spilled or the wire response predates this field -- rendered as a visibly distinct
   * overlay (see `VoxelViewer.setShowOverflow`), on by default: this is the "capture and
   * display" half of out-of-bounds handling, automatic and non-destructive to what the bench
   * itself shows. The separate "grow to fit and regenerate" action is NOT this. */
  overflowBlocks?: readonly OverflowBlockMesh[]
}

export type EnvironmentMode = 'solid' | 'ghost' | 'hidden'

/** One writer's share of the write-attribution overlay -- see `setAttributionGroups`. */
export interface AttributionGroup {
  /** The host's own name for this writer (a graph node id). Never shown; carried back out
   * through `getAttributionGroups` so a host can match a legend row to its own selection. */
  id: string
  /** What the legend shows for this writer. A single unnamed group (what `setAttributionCells`
   * produces) may leave this empty, and the legend then says "written by the selected node"
   * rather than inventing a name. */
  label: string
  /** Flat cell indices under the current volume's own indexing. */
  cells: Uint32Array | readonly number[]
}

/** What the overlay ended up painting for one group. */
export interface AttributionGroupState {
  id: string
  label: string
  /** Cells this group actually owns on screen. */
  cells: number
  /** Cells this group named that an EARLIER group had already claimed -- see
   * `setAttributionGroups` on why overlap goes to the first claimant and is reported rather than
   * silently resolved. */
  overlapped: number
  /** Index into colors.ts's attribution series. */
  colorIndex: number
  /** World-cell extent of the cells this group OWNS on screen, or null when it owns none --
   * what `frameAttributionGroup` fits the camera to. Cells an earlier group already claimed are
   * not in it, for the same reason they are not in this group's colour. */
  bounds: CellBox | null
}

/** What a click on the preview turned out to have hit -- see `onPick`. */
export interface PickedCell {
  x: number
  y: number
  z: number
  /** Flat cell index under the current volume's indexing, so a host can look the cell up in a
   * profile/attribution table without redoing the arithmetic. */
  cell: number
  /** The palette id currently at that cell, and its name/kind. `name` is '' for an id the
   * palette does not carry, which should not happen and is not worth throwing over. */
  blockId: number
  blockName: string
  kind: BlockKind
  /** Whether this run wrote this cell (`changed`), and whether it emptied it (`removed`) -- the
   * difference between "the feature put this here", "the feature took something from here" and
   * "this is the terrain it was placed into", which is the first thing anybody wants to know
   * about a block they just clicked. */
  placed: boolean
  carved: boolean
}

/** What this viewer can currently say about block textures -- see `getTextureReport`. */
export interface TextureReport {
  /** Whether a usable atlas has been decoded (`setAtlas` succeeded). */
  hasAtlas: boolean
  /** Whether textures are actually being drawn right now: an atlas AND the host's switch on. */
  enabled: boolean
  /** How many palette entries the current result has. */
  blocks: number
  /** The block names the atlas could not fully texture, which are drawn as flat colour inside
   * the textured pass -- see CompiledAtlas.unresolved. Empty in flat-colour mode, because
   * nothing was asked of the atlas. */
  unresolved: readonly string[]
}

const BACKGROUND_COLOR = 0x14161a
const GHOST_OPACITY = 0.22

// Carved-out cells (ViewerVolume.removed) render translucent, tinted a distinct hue -- reads
// as "absence" (a hole where terrain used to be), not ordinary placed geometry, and must not
// visually occlude solid feature blocks. A warm red/orange tint keeps each cell's own
// per-face-shaded colour (dirt still reads as dirt-ish) while unmistakably marking it as a
// ghost of removed material.
const CARVED_OPACITY = 0.35
const CARVED_TINT = 0xff5a3c

// The touch-count heatmap ramp and the out-of-bounds tint moved to remesh.ts, alongside the
// passes they colour -- see that module's own header. What stays here is only what a three.js
// MATERIAL needs (CARVED_TINT above, the highlight colours below).
//
// Write-attribution overlay (see `setAttributionGroups`): the cells each named feature wrote,
// handed down by a host that has a profiled run and an AttributionIndex over it. Painted as a
// flat, opaque colour rather than a tint blended over each cell's own material, for the same
// "read unambiguously" reason the heatmap is: the question this answers is "which blocks are
// this node's", and a blend would make the answer depend on what the block happened to be. The
// colours themselves are colors.ts's ATTRIBUTION series -- one per writer, chosen against every
// other overlay this viewer draws; see that table's own comment.

// How far INTO a face pickCell steps before flooring to a cell. Half a block: the face it hit is
// a cell boundary, so the point itself is exactly on the integer plane and floors either way
// depending on floating-point noise. Half a block along the inward normal lands on the cell's own
// centre plane, which is the furthest a step can be from any boundary and therefore the most
// robust value there is -- not a fudge factor to tune.
const PICK_DEPTH = 0.5

// Camera framing (frameAll/frameContent, both via the private frameToBox helper -- see
// cameraFit.ts for the fitting math this replaced a bounding-sphere-at-a-fixed-multiplier
// approach with, and why that approach clipped an elongated box's far corners). The diagonal
// "isometric-ish" direction is unchanged from before this fix -- only the DISTANCE math changed.
const DEFAULT_FRAME_DIR: Vec3 = { x: 1, y: 0.85, z: 1 }
// 1.0 would be a mathematically exact fit (content touches the frame edges pixel-for-pixel);
// this leaves a little breathing room so nothing reads as cropped tight against the viewport.
const FRAME_MARGIN = 1.08
// Floors each axis's half-extent before fitting (see fitBoxToView's own doc comment) -- without
// this, a single-cell diagnostic position or a near-empty result would fit a near-zero box and
// put the camera uncomfortably close to it.
const FRAME_MIN_HALF_EXTENT = 2

// highlightCell()'s marker: a bright, translucent cube overlay plus a slightly larger wireframe
// outline, both drawn on top of everything else (renderOrder) so the highlighted cell reads
// unambiguously regardless of what's already drawn there. Framed with its own, tighter padding
// (HIGHLIGHT_FRAME_PADDING) than frameContent's whole-result fit -- the point of clicking a
// diagnostic's position is to see THAT cell clearly, with just enough surrounding terrain for
// context, not to reframe the whole preview.
const HIGHLIGHT_FILL_COLOR = 0xffcc00
const HIGHLIGHT_FILL_OPACITY = 0.55
const HIGHLIGHT_EDGE_COLOR = 0xfff2b0
const HIGHLIGHT_FRAME_PADDING = 6

// ---- the canvas as a keyboard application ------------------------------------------------
// role="application" tells a screen reader to stop interpreting keys and hand every one of them
// to this element. The canvas claimed that and then handled nothing: the five keys it did have
// (r, R, 1, 3, 7) were bound on WINDOW, so they worked from anywhere in the panel and the
// canvas's own tab stop did literally nothing -- arrows, +, -, Home, PageUp, Enter and Space
// were all measured as dead. The claim is now true instead of withdrawn: a 3D view is the one
// control in this tool a screen reader's own navigation keys have nothing useful to do inside,
// and the alternative (role="img") would have made the only way to move the camera a mouse.
//
// One press is 7.5 degrees -- 48 presses for a full turn, coarse enough to get somewhere and
// fine enough to line a face up -- and one zoom press is 12%, about a sixth of a doubling.
const KEY_ORBIT_RADIANS = Math.PI / 24
const KEY_DOLLY_FACTOR = 1.12
/** PageUp/PageDown are the same gesture, four presses' worth, for crossing a big bench. */
const KEY_DOLLY_PAGE = KEY_DOLLY_FACTOR ** 4
/** Keeps an orbit from reaching either pole, where the camera's up vector flips and the view
 * rolls unpredictably -- the same guard OrbitControls' own min/maxPolarAngle provides. */
const KEY_POLAR_EPSILON = 0.02

/** How far outside the last framed box a fresh result's content may land before the camera
 * follows it, as a fraction of that box's longest edge. A quarter of the view is the point at
 * which "it grew a bit" stops being a fair description and "it is somewhere else now" starts:
 * below it, a save-triggered regenerate must not move a camera the user placed; above it, the
 * camera is pointed at empty space and the preview is lying about the run. */
const REFRAME_SLACK_FRACTION = 0.25

/** How far the bench outline may extend beyond the framed box and still be drawn, as a fraction
 * of that box's longest edge -- see `syncBoundsBoxVisibility`. FRAME_MARGIN already leaves ~8%
 * of slack around a fit, so a bench a hair larger than what was framed really is on screen;
 * anything past this is not. */
const OUTLINE_FIT_SLACK_FRACTION = 0.08

/** How often the axis gizmo is redrawn, in milliseconds. The camera basis only has to be right
 * enough to say which way is up; redrawing six SVG attributes at display rate would cost more
 * layout work than the whole scene does. */
const GIZMO_UPDATE_INTERVAL_MS = 100

/** How often the busy pill's elapsed time ticks. Tenths are what the readout shows, so anything
 * finer would be recomputing a string that cannot change. */
const BUSY_TICK_MS = 100

// --- textured rendering ---------------------------------------------------------------------
//
// OFF BY DEFAULT, and reachable only by a host that has an atlas and asks for it (setAtlas +
// setTexturesEnabled). Flat colours are what this viewer draws until both of those happen: they
// are the fallback whenever the vanilla assets could not be fetched, and they are what every
// committed wiki image and every apps/vscode/docs/panel-*.png renders with. Making textures the
// default would silently regenerate all of those, which is a separate and deliberate decision.
//
// The composition is `texel * tint * shade`, in that order and all three of them:
//   - texel   -- the atlas cell for THIS face of THIS block (mesher.ts's per-vertex UVs)
//   - tint    -- the runtime biome multiply vanilla bakes grass/foliage/water greyscale for, or
//                the block's flat palette colour when the atlas table has never heard of it
//                (see MesherAtlas' doc comment); rides on the same vertex-colour attribute the
//                flat mode already uses, so both modes feed one shader
//   - shade   -- the unchanged per-face SHADE_* constants in mesher.ts, which are what make the
//                preview readable as three-dimensional at all
//
// Filtering is NEAREST in both directions with mipmaps OFF. Minecraft textures are pixel art and
// linear filtering turns them to mush; mipmaps are off because every mip level below the top
// averages across cell boundaries, which is exactly the bleeding the atlas' border/inset exists
// to prevent. The cost is some shimmer on blocks far from the camera, which is the right trade
// for a preview whose subject is usually a dozen metres away.
const ALPHA_TEST = 0.5
// Vanilla applies a per-block alpha to water and ice that their TEXTURES do not carry (the
// texture itself is fully opaque). Rather than guess a per-block value, the translucent pass
// applies one flat multiplier to everything in it. This is an approximation and it is the
// visible one: two panes of glass behind each other do not darken the way they do in-game.
const TRANSLUCENT_OPACITY = 0.8
// Translucent geometry is drawn with depthWrite OFF, after the opaque pass (renderOrder 0) and
// before the carved overlay (5). That gives correct occlusion BY opaque blocks -- the opaque
// pass has already filled the depth buffer -- and leaves ordering AMONG translucent faces to
// three.js' per-object sort, which is per-mesh, not per-triangle. For a bench volume that is
// almost always right: the mesher already culls liquid-against-liquid faces, so a lake is a
// shell rather than a stack of overlapping quads. Two separate bodies of water seen through
// each other can composite in the wrong order; documented, not fixed.
const TRANSLUCENT_RENDER_ORDER = 2

/** An atlas ready to draw with: the uploaded texture, the table the renderer should actually
 * index against (which may not be the one that arrived -- see prepareAtlas), and the cell index
 * of the all-white cell everything unresolved falls back to. */
interface PreparedAtlas {
  texture: THREE.Texture
  table: AtlasTableWire
  white: number
}

/** Configures a decoded image as a pixel-art texture.
 *
 * `flipY = false` is load-bearing and pairs with mesher.ts's UV convention: the atlas builder
 * lays cells out in reading order, top row first, so v must grow downward. Flipping the image
 * instead would put row 0 at the bottom and silently mirror every cell lookup vertically.
 *
 * Filtering is NEAREST both ways with mipmaps OFF -- see the "textured rendering" comment block
 * above for why, and what it costs. */
function configureAtlasTexture(source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): THREE.Texture {
  const texture = new THREE.Texture(source as unknown as HTMLImageElement)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.flipY = false
  texture.premultiplyAlpha = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * Turns the atlas' PNG bytes into a texture, guaranteeing a white cell exists on the way.
 *
 * Decoding goes through a Blob and `createImageBitmap`, NOT a `data:` URI on an `<img>`. That is
 * not a style preference: apps/vscode's webview runs under `default-src 'none'` with no
 * `img-src` at all (previewPanel.ts's renderShellHtml), so an `<img src="data:...">` would be
 * blocked outright, and widening that CSP to deliver a texture would be a poor trade.
 * `createImageBitmap` on a Blob performs no fetch and so is not subject to it.
 *
 * THE WHITE CELL. The renderer needs one all-white opaque cell so that a block the table says
 * nothing about -- a pack's own block, an id newer than the atlas, a face whose texture the
 * builder could not resolve -- can be drawn in the SAME draw call as everything else, sampling
 * white and multiplying by its flat palette colour. That reproduces flat-colour mode exactly for
 * that block, which is what makes "textures on" a strict improvement rather than a trade.
 *
 * If the table names one, it is used as-is. If it does not -- which is the case for the atlas
 * builder as it stands -- one row of cells is appended to the image here and its first cell
 * painted white. That costs one canvas composite per atlas load, once per session, and it means
 * the renderer never has to refuse an otherwise good atlas over a missing 16x16 square. A
 * builder that packs its own white cell and names it skips all of this.
 */
async function prepareAtlas(atlas: DecodedAtlas): Promise<PreparedAtlas> {
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; Blob?: typeof Blob }
  if (typeof g.createImageBitmap !== 'function' || g.Blob === undefined) {
    throw new Error('this environment cannot decode the block atlas (no createImageBitmap/Blob) -- staying in flat-colour mode')
  }
  // Copied into its own ArrayBuffer: `png` may be a view onto a larger decode buffer, and Blob
  // would otherwise take the whole thing.
  const bitmap = await g.createImageBitmap(new g.Blob([atlas.png.slice().buffer as ArrayBuffer], { type: 'image/png' }))
  const table = atlas.table
  if (bitmap.width !== table.width || bitmap.height !== table.height) {
    throw new Error(`atlas image is ${bitmap.width}x${bitmap.height}, but its table describes ${table.width}x${table.height}`)
  }
  if (table.white !== undefined) {
    return { texture: configureAtlasTexture(bitmap), table, white: table.white }
  }

  const border = table.border ?? 0
  const stride = table.stride ?? table.cell + 2 * border
  const height = table.height + stride
  const canvas = createCanvas(table.width, height)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
  if (ctx === null) {
    throw new Error('cannot add a white cell to the block atlas (no 2d canvas context) -- staying in flat-colour mode')
  }
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0)
  // The whole stride, border included, so a sample that rounds outward is still white.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, table.height, stride, stride)
  return {
    texture: configureAtlasTexture(canvas),
    table: {
      ...table,
      height,
      rows: table.rows + 1,
      cells: [...table.cells, { x: border, y: table.height + border, render: 'opaque', color: '#ffffff' }],
    },
    white: table.cells.length,
  }
}

/** An OffscreenCanvas where one exists (a webview, a worker), a DOM canvas otherwise. */
function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas; document?: Document }
  if (typeof g.OffscreenCanvas === 'function') return new g.OffscreenCanvas(width, height)
  if (g.document !== undefined) {
    const canvas = g.document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  throw new Error('cannot add a white cell to the block atlas (no canvas available) -- staying in flat-colour mode')
}

/** Copies `array` into an existing same-length attribute buffer, otherwise allocates a new one. */
function setFloatAttribute(geometry: THREE.BufferGeometry, name: string, array: Float32Array, itemSize: number): void {
  const existing = geometry.getAttribute(name) as THREE.BufferAttribute | undefined
  if (existing && existing.array.length === array.length) {
    ;(existing.array as Float32Array).set(array)
    existing.needsUpdate = true
  } else {
    geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
  }
}

function setIndexAttribute(geometry: THREE.BufferGeometry, array: Uint32Array): void {
  const existing = geometry.getIndex()
  if (existing && existing.array.length === array.length) {
    ;(existing.array as Uint32Array).set(array)
    existing.needsUpdate = true
  } else {
    geometry.setIndex(new THREE.BufferAttribute(array, 1))
  }
}

function updateGeometry(geometry: THREE.BufferGeometry, buf: MeshBuffers): void {
  setFloatAttribute(geometry, 'position', buf.positions, 3)
  setFloatAttribute(geometry, 'normal', buf.normals, 3)
  setFloatAttribute(geometry, 'color', buf.colors, 3)
  // A flat-colour pass emits no UVs at all (MeshBuffers.uvs is zero-length). Deleting the
  // attribute rather than leaving the previous, textured remesh's buffer in place is what stops
  // a toggle back to flat mode from feeding stale coordinates to a geometry that is about to be
  // drawn with a different material -- and what keeps a flat-mode geometry byte-identical to
  // what it was before this file learned about textures.
  if (buf.uvs.length > 0) {
    setFloatAttribute(geometry, 'uv', buf.uvs, 2)
  } else if (geometry.getAttribute('uv')) {
    geometry.deleteAttribute('uv')
  }
  setIndexAttribute(geometry, buf.indices)
  if (buf.positions.length > 0) {
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
  } else {
    geometry.boundingSphere = null
    geometry.boundingBox = null
  }
}

type ViewSnap = 'front' | 'side' | 'top'

export class VoxelViewer {
  private readonly canvas: HTMLCanvasElement
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls

  private readonly featureGeometry = new THREE.BufferGeometry()
  private readonly environmentGeometry = new THREE.BufferGeometry()
  // The translucent halves of the feature/environment passes -- always present, always empty in
  // flat-colour mode (nothing is ever routed to them without an atlas that names a block
  // `translucent`), so their existence costs one empty draw call each and changes nothing about
  // what flat mode draws.
  private readonly featureTranslucentGeometry = new THREE.BufferGeometry()
  private readonly environmentTranslucentGeometry = new THREE.BufferGeometry()
  private readonly carvedGeometry = new THREE.BufferGeometry()
  private readonly heatmapGeometry = new THREE.BufferGeometry()
  private readonly overflowGeometry = new THREE.BufferGeometry()
  private readonly attributionGeometry = new THREE.BufferGeometry()
  private readonly featureMaterial: THREE.MeshLambertMaterial
  private readonly environmentSolidMaterial: THREE.MeshLambertMaterial
  private readonly environmentGhostMaterial: THREE.MeshLambertMaterial
  private readonly carvedMaterial: THREE.MeshLambertMaterial
  private readonly heatmapMaterial: THREE.MeshLambertMaterial
  private readonly overflowMaterial: THREE.MeshLambertMaterial
  private readonly attributionMaterial: THREE.MeshLambertMaterial
  // Textured counterparts of the three materials above, created up front but only ever assigned
  // to a mesh while an atlas is active (see applyMaterials). `map` is null until setAtlas
  // supplies one.
  private readonly texturedOpaqueMaterial: THREE.MeshLambertMaterial
  private readonly texturedGhostMaterial: THREE.MeshLambertMaterial
  private readonly texturedTranslucentMaterial: THREE.MeshLambertMaterial
  private readonly featureMesh: THREE.Mesh
  private readonly environmentMesh: THREE.Mesh
  private readonly featureTranslucentMesh: THREE.Mesh
  private readonly environmentTranslucentMesh: THREE.Mesh
  private readonly carvedMesh: THREE.Mesh
  private readonly heatmapMesh: THREE.Mesh
  private readonly overflowMesh: THREE.Mesh
  private readonly attributionMesh: THREE.Mesh

  // highlightCell()'s marker -- see HIGHLIGHT_* constants' doc comment. Built once (like every
  // other mesh above) and just repositioned/toggled per call, not recreated.
  private readonly highlightGeometry = new THREE.BoxGeometry(1.02, 1.02, 1.02)
  private readonly highlightMaterial = new THREE.MeshBasicMaterial({ color: HIGHLIGHT_FILL_COLOR, transparent: true, opacity: HIGHLIGHT_FILL_OPACITY, depthWrite: false })
  private readonly highlightMesh = new THREE.Mesh(this.highlightGeometry, this.highlightMaterial)
  private readonly highlightEdgesGeometry = new THREE.EdgesGeometry(this.highlightGeometry)
  private readonly highlightEdgesMaterial = new THREE.LineBasicMaterial({ color: HIGHLIGHT_EDGE_COLOR })
  private readonly highlightEdges = new THREE.LineSegments(this.highlightEdgesGeometry, this.highlightEdgesMaterial)

  private gridHelper: THREE.GridHelper = new THREE.GridHelper(1, 1)
  private boundsBox: THREE.LineSegments = new THREE.LineSegments()

  private currentVolume: ViewerVolume | null = null
  private currentPalette: readonly ViewerPaletteEntry[] = []
  private paletteById: Map<number, ViewerPaletteEntry> = new Map()

  private sliceMinY = -Infinity
  private sliceMaxY = Infinity
  private environmentMode: EnvironmentMode = 'solid'
  private showGrid = true
  /** Defaults to on -- without it, a terraform-style feature that works mostly by
   * excavation (baseline non-air -> result air) previews as if it did almost nothing, since
   * a plain air cell draws no geometry. */
  private showCarved = true
  /** Toggles the touch-count heatmap overlay (see `ViewerVolume.touchCounts`'s doc comment
   * and `heatColor`). Defaults to off -- only meaningful once a profiled run exists. */
  private showHeatmap = false
  /** Toggles the out-of-bounds capture overlay (see `ViewerVolume.overflowBlocks`'s doc
   * comment). Defaults to ON, unlike carved/heatmap above -- this is the "capture and display"
   * behaviour's whole point: a captured block shows up automatically, with no action required,
   * the moment a result carries any. */
  private showOverflow = true

  /** The write-attribution overlay's current answer: one byte per cell of the CURRENT volume
   * naming which GROUP owns it (0 = none, n = `attributionGroups[n - 1]`), the total marked, and
   * the box they sit in. Null mask whenever no host has asked for the overlay, which is the
   * state this viewer starts in and returns to on every `setVolume` (a fresh run re-interns cell
   * indices against fresh bounds, so last run's mask names other cells; the host re-sends one if
   * it still has an answer). A mask rather than the cell lists themselves because the mesher
   * asks the question per cell index, and a list would mean a set lookup per cell. */
  private attribution: AttributionState = { mask: null, cells: 0, bounds: null }
  /** What the current mask's group bytes MEAN: label and per-group cell count, in the order the
   * host supplied them (which is the order the colours are assigned in). Empty whenever the
   * overlay is off. */
  private attributionGroups: AttributionGroupState[] = []
  /** Everything about the current volume that a re-mesh needs and no re-mesh should recompute --
   * see remesh.ts's VolumeSummary. Recomputed once per `setVolume`. */
  private summary: VolumeSummary = { changedBounds: null, carvedBounds: null, touchedBounds: null, maxTouchCount: 0 }
  /** Reused by `pickCell`, which can be called on every click. */
  private readonly raycaster = new THREE.Raycaster()

  /** The atlas texture currently uploaded, or null when no atlas has been supplied (the state
   * this viewer starts in and stays in unless a host calls setAtlas). Owned here and disposed
   * on replacement/dispose. */
  private atlasTexture: THREE.Texture | null = null
  /** The atlas table last handed to setAtlas -- kept so a NEW palette (every setVolume) can be
   * recompiled against it without another round trip. */
  private atlasTable: AtlasTableWire | null = null
  /** The table compiled against the CURRENT palette; null whenever textures are not actually in
   * use, which `texturesActive()` is the single test for. */
  private compiledAtlas: CompiledAtlas | null = null
  /** The cell every unresolved block/face falls back to -- the table's own white cell, or the
   * one prepareAtlas appended when it had none. */
  private atlasWhiteCell = 0
  /** The host's own on/off switch, independent of whether an atlas exists. Defaults to FALSE:
   * flat colours are what this viewer draws until a host explicitly opts in -- see the
   * "textured rendering" comment block above for why the default is not negotiable here. */
  private texturesRequested = false

  private rafHandle = 0

  // ---- framing memory ------------------------------------------------------------------------
  /** The box the camera was last programmatically fitted to, or null before the first framing
   * call ever. Two things read it: `resize()` (re-fit the SAME box to the new aspect, so widening
   * the panel widens the view of the content rather than of the empty space beside it) and
   * `setVolume()` (a fresh result whose content escapes this box is content the camera is no
   * longer pointed at -- see `boxContains`). */
  private lastFramedBox: Box3 | null = null
  /** True once the user has orbited/panned/dollied since the last programmatic framing. This is
   * what keeps "a regenerate never moves the camera" true while still allowing the automatic
   * re-fits above: a camera the user placed by hand is a decision, and resizing the panel must
   * not overrule it. Cleared by every frameToBox/setView, set by OrbitControls' own `start`. */
  private cameraTouched = false

  // ---- projection ----------------------------------------------------------------------------
  /** The orthographic twin of `camera`. It is never driven by OrbitControls: the perspective
   * camera stays the one source of position/target (so orbit, pan and dolly keep working exactly
   * as they always have) and this one is re-derived from it every frame while active -- dolly
   * distance becomes frustum height, which is what "zoom" means without a perspective divide. */
  private readonly orthoCamera: THREE.OrthographicCamera
  private projection: OverlayProjection = 'perspective'

  /** The on-canvas controls/gizmo/busy pill. Null when the canvas has no parent to hang them off
   * (a headless/test canvas) -- every call site below tolerates that rather than requiring a host
   * to provide a container it may not have. */
  private overlay: ViewportOverlayHandle | null = null
  private busyStartedAt = 0
  private busyTimer = 0
  /** Set by a host that can actually stop an in-flight request (see `setCancelHandler`). */
  private cancelHandler: (() => void) | null = null
  /** False while the page is hidden -- the rAF loop is genuinely stopped, not just idling, so a
   * preview in a background tab/panel stops costing a GPU frame every 16 ms. */
  private running = false

  /** Fired whenever something OTHER than the sidebar changes a view setting the sidebar also
   * shows -- i.e. the on-canvas overlay. The panel assigns this so its own radio/checkbox rows
   * follow along; a host that never assigns it simply gets an overlay that works on its own. */
  onViewChange: ((state: { environmentMode: EnvironmentMode; showGrid: boolean; projection: OverlayProjection }) => void) | null = null

  /** Fired whenever an atlas arrives or leaves, or the texture switch is flipped -- so a host
   * that remembers a preference can apply it the moment textures become possible, instead of
   * having to decide at the one instant `setAtlas` resolves. */
  onTexturesChanged: ((report: TextureReport) => void) | null = null

  /**
   * Fired when the user CLICKS a block in the preview -- not merely when `pickCell` is called.
   *
   * This class used to bind no pointer handler at all and leave the gesture to each host, on the
   * grounds that only the host knows what a click means. That was true of the MEANING and false
   * of the GESTURE: every host has to reimplement the same press-and-release-without-orbiting
   * test (the left button is also how OrbitControls rotates, so a plain `click` fires after a
   * drag too), and the one host that did so armed it only in attribution mode -- which made
   * clicking a block do nothing at all in an ordinary preview, in a tool whose entire subject is
   * which blocks ended up where. The gesture lives here now; what a picked cell MEANS is still
   * entirely the listener's business.
   *
   * Fires only for a click that actually hit a cell inside the bench. A click that hits nothing
   * -- the background, or a captured out-of-bounds block, which has no cell index -- fires
   * nothing rather than a null, because "I clicked past the model" is not a request to clear
   * anything: the marker a listener may have put on screen could equally be a diagnostic's.
   *
   * The clicked cell is marked (`highlightCell` with `frame: false`) before this fires. It is
   * under the pointer by definition, so moving the camera onto it would throw away the view the
   * user chose in order to show them what they were already looking at.
   */
  onPick: ((pick: PickedCell) => void) | null = null

  /** Where the current left-button press started, for the gesture above. Null between presses. */
  private pressedAt: { x: number; y: number } | null = null

  /** The OS "reduce motion" preference, watched live. Null in an environment with no matchMedia
   * at all, which is treated as "no preference expressed" rather than as "reduce". */
  private readonly reducedMotion: MediaQueryList | null = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null

  /** Scratch vectors for the keyboard camera moves, so a held arrow key allocates nothing. */
  private readonly keyOffset = new THREE.Vector3()
  private readonly keySpherical = new THREE.Spherical()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    // Reachable by keyboard, and announced: without a tabindex the 3D view is the one part of
    // this tool a keyboard user cannot reach at all, which also means the 1/3/7/R shortcuts have
    // nowhere to be focused from.
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0
    // The label now describes the keys that EXIST -- see KEY_ORBIT_RADIANS' comment for why the
    // old one described a mouse to a keyboard user and then advertised an application that
    // handled no keys at all.
    if (!canvas.hasAttribute('aria-label')) {
      canvas.setAttribute(
        'aria-label',
        'Feature preview, 3D. Arrow keys orbit, plus and minus zoom, Home frames the feature, End frames the bench, Enter identifies the block at the centre of the view. 1, 3 and 7 look from the front, the side and the top.',
      )
    }
    if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'application')

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BACKGROUND_COLOR)

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000)
    this.camera.position.set(28, 34, 28)
    // Extents are placeholders; syncOrthoCamera() recomputes them from the perspective camera's
    // own distance every frame the orthographic projection is active.
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(BACKGROUND_COLOR, 1)

    this.controls = new OrbitControls(this.camera, this.canvas)
    // Damping is a glide: the camera keeps moving for a few hundred milliseconds after the hand
    // stops. That is motion the user did not ask for, so it is the one thing in this viewer
    // `prefers-reduced-motion` has to switch off -- and nothing here called matchMedia at all,
    // so it never did. Applied here and re-applied whenever the preference changes, because a
    // preference set after the preview opened is still the preference.
    this.controls.dampingFactor = 0.08
    this.applyMotionPreference()
    this.reducedMotion?.addEventListener('change', this.handleMotionPreferenceChange)
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    }
    // A dolly limit is a complement to the near/far fix below (updateClipPlanes), not a
    // substitute for it -- see that method's own doc comment. This only guards against the
    // camera being scrolled out to a distance so extreme that world-space float precision
    // itself starts to suffer; re-tightened once real content exists (setVolume below) to a
    // multiple of that content's own size, which stays generous without being unbounded.
    this.controls.maxDistance = 2000
    // Every user-initiated camera move goes through here. `start` fires on the first orbit/pan/
    // dolly gesture of an interaction, which is exactly the moment the camera stops being
    // something this class chose and starts being something the user chose.
    this.controls.addEventListener('start', () => {
      this.cameraTouched = true
    })

    // Lighting: hemisphere + directional, no shadows -- faces are already shaded
    // per-direction via baked vertex colours in the mesher.
    const hemiLight = new THREE.HemisphereLight(0xc7dcff, 0x2b2620, 1.15)
    this.scene.add(hemiLight)
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85)
    dirLight.position.set(0.6, 1, 0.4)
    dirLight.castShadow = false
    this.scene.add(dirLight)
    this.scene.add(dirLight.target)

    this.featureMaterial = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.environmentSolidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.environmentGhostMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    })
    this.carvedMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: CARVED_TINT,
      transparent: true,
      opacity: CARVED_OPACITY,
      depthWrite: false,
    })
    // Opaque, unlike the ghost/carved materials above -- a heavily-rewritten cell should
    // read as unambiguously "this one" against its neighbours, not blend translucently.
    this.heatmapMaterial = new THREE.MeshLambertMaterial({ vertexColors: true })
    // Opaque too, for the same "read unambiguously" reason as the heatmap material -- see
    // OVERFLOW_TINT's own doc comment.
    this.overflowMaterial = new THREE.MeshLambertMaterial({ vertexColors: true })
    // Opaque as well -- see ATTRIBUTION_COLOR's own comment.
    this.attributionMaterial = new THREE.MeshLambertMaterial({ vertexColors: true })

    // Opaque + cutout in one material: `alphaTest` discards a fragment below the threshold
    // without any blending or sort, so leaves/plants/panes cut out correctly while ordinary
    // opaque blocks (alpha 1 everywhere) are unaffected. vertexColors carries tint * shade.
    this.texturedOpaqueMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, alphaTest: ALPHA_TEST })
    this.texturedGhostMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
      // Not alpha-tested: the ghost pass is already blending, and discarding cutout fragments
      // AND blending the rest would make a ghosted leaf canopy read as two different materials.
    })
    this.texturedTranslucentMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: TRANSLUCENT_OPACITY,
      depthWrite: false,
    })

    this.featureMesh = new THREE.Mesh(this.featureGeometry, this.featureMaterial)
    this.featureMesh.renderOrder = 0
    this.environmentMesh = new THREE.Mesh(this.environmentGeometry, this.environmentSolidMaterial)
    this.environmentMesh.renderOrder = 0
    this.featureTranslucentMesh = new THREE.Mesh(this.featureTranslucentGeometry, this.texturedTranslucentMaterial)
    this.featureTranslucentMesh.renderOrder = TRANSLUCENT_RENDER_ORDER
    this.environmentTranslucentMesh = new THREE.Mesh(this.environmentTranslucentGeometry, this.texturedTranslucentMaterial)
    this.environmentTranslucentMesh.renderOrder = TRANSLUCENT_RENDER_ORDER
    this.carvedMesh = new THREE.Mesh(this.carvedGeometry, this.carvedMaterial)
    this.carvedMesh.renderOrder = 5
    this.heatmapMesh = new THREE.Mesh(this.heatmapGeometry, this.heatmapMaterial)
    this.heatmapMesh.renderOrder = 6
    this.heatmapMesh.visible = false
    // renderOrder 7 -- drawn after every other pass (feature/environment 0, carved 5, heatmap
    // 6) so a captured out-of-bounds block always reads clearly, the same "draw last, read
    // unambiguously" treatment the heatmap overlay gets, one step further out.
    this.overflowMesh = new THREE.Mesh(this.overflowGeometry, this.overflowMaterial)
    this.overflowMesh.renderOrder = 7
    // renderOrder 8 -- after the overflow overlay, one step further out again. Hidden until a
    // host supplies a mask, so a preview nobody asked this question of draws exactly what it
    // always drew, down to the draw call: an empty geometry on an invisible mesh.
    this.attributionMesh = new THREE.Mesh(this.attributionGeometry, this.attributionMaterial)
    this.attributionMesh.renderOrder = 8
    this.attributionMesh.visible = false
    this.scene.add(this.featureMesh)
    this.scene.add(this.environmentMesh)
    this.scene.add(this.featureTranslucentMesh)
    this.scene.add(this.environmentTranslucentMesh)
    this.scene.add(this.carvedMesh)
    this.scene.add(this.heatmapMesh)
    this.scene.add(this.overflowMesh)
    this.scene.add(this.attributionMesh)

    this.highlightMesh.renderOrder = 20
    this.highlightMesh.visible = false
    this.highlightEdges.renderOrder = 21
    this.highlightEdges.visible = false
    this.scene.add(this.highlightMesh)
    this.scene.add(this.highlightEdges)

    this.rebuildGridAndBounds()

    window.addEventListener('keydown', this.handleKeyDown)
    // The camera keys are bound on the CANVAS, not on window: they are what the canvas's own tab
    // stop is for, and an arrow key pressed in the sidebar belongs to whatever control has focus
    // there. (The five view-snap keys above stay on window, where they always were -- they are a
    // shortcut for the whole preview, not a camera nudge.)
    this.canvas.addEventListener('keydown', this.handleCanvasKeyDown)
    this.canvas.addEventListener('pointerdown', this.handlePointerDown)
    this.canvas.addEventListener('pointerup', this.handlePointerUp)

    this.overlay = this.createOverlay()
    this.syncOverlay()

    document.addEventListener('visibilitychange', this.handleVisibilityChange)

    this.resize()
    this.controls.update()
    this.start()
  }

  /** Builds the on-canvas overlay, or returns null when there is nowhere to put it. The canvas's
   * own parent is the anchor (both app shells give it a `position: relative` flex row -- see
   * previewPanel.ts's `#fl-root`), so no shell HTML has to change for this to appear. */
  private createOverlay(): ViewportOverlayHandle | null {
    const host = this.canvas.parentElement
    if (host === null) return null
    try {
      const overlay = createViewportOverlay(host, {
        // Immediately after the canvas, which in both shells puts it BEFORE #fl-sidebar -- see
        // ViewportOverlayOptions.anchor. Appended (the old behaviour) it landed after the
        // sidebar, and its toolbar became tab stops 51-55 of 56.
        anchor: this.canvas,
        onFrame: () => this.frameContent(),
        onCycleEnvironment: () => {
          const next: EnvironmentMode = this.environmentMode === 'solid' ? 'ghost' : this.environmentMode === 'ghost' ? 'hidden' : 'solid'
          this.setEnvironmentMode(next)
          this.emitViewChange()
        },
        onToggleGrid: () => {
          this.setShowGrid(!this.showGrid)
          this.emitViewChange()
        },
        onToggleProjection: () => {
          this.setProjection(this.projection === 'perspective' ? 'orthographic' : 'perspective')
          this.emitViewChange()
        },
        // Textures are the one thing on this toolbar whose control used to live nowhere a person
        // looking at flat colours would find it -- see panel.ts's own texture row, which this
        // mirrors. Inert (and says why) until an atlas exists, like every other control here.
        onToggleTextures: () => {
          if (!this.hasAtlas()) return
          this.setTexturesEnabled(!this.texturesActive())
          this.syncOverlay()
        },
      })
      return overlay
    } catch {
      // An overlay is an affordance, never a requirement: a host whose DOM cannot take one still
      // gets the preview it always had.
      return null
    }
  }

  private emitViewChange(): void {
    this.onViewChange?.({ environmentMode: this.environmentMode, showGrid: this.showGrid, projection: this.projection })
  }

  private syncOverlay(): void {
    this.overlay?.sync({
      environmentMode: this.environmentMode,
      showGrid: this.showGrid,
      projection: this.projection,
      texturesEnabled: this.texturesActive(),
      texturesAvailable: this.hasAtlas(),
    })
  }

  /** Rebuilds the on-canvas legend from what is ACTUALLY being drawn right now.
   *
   * The rule that keeps this from becoming a permanent block of furniture over the scene: an
   * entry exists only while its overlay has geometry on screen. The carved overlay is listed
   * when this run carved something, the overflow overlay when something spilled, the heatmap
   * when it is on, and one row per attribution writer when a host has asked that question. A
   * default preview of a feature that only places blocks therefore has no legend at all, which
   * is right -- nothing on screen is in a colour that needs explaining. */
  private syncLegend(): void {
    const overlay = this.overlay
    if (overlay === null) return
    overlay.setLegend(
      describeLegend({
        onSelectWriter: (index) => this.frameAttributionGroup(index),
        attributionGroups: this.attributionGroups,
        showCarved: this.showCarved,
        hasCarved: this.summary.carvedBounds !== null,
        showOverflow: this.showOverflow,
        overflowCount: this.currentVolume?.overflowBlocks?.length ?? 0,
        showHeatmap: this.showHeatmap,
        maxTouchCount: this.summary.maxTouchCount,
        carvedTint: CARVED_TINT,
      }),
    )
  }

  /** Puts one short line on the viewport itself -- the answer to "what did this run do", where
   * the run is. Null clears it. The panel is what decides there IS an answer worth promoting
   * (see panel.ts's renderEmptyResult); this class only carries it to the overlay, so a host
   * without a panel still gets a preview and no empty banner. */
  setNotice(notice: OverlayNotice | null): void {
    this.overlay?.setNotice(notice)
  }

  /** Moves a status line the HOST owns into the viewport overlay's own flex column, so it stacks
   * with the pill, the notice and the legend instead of floating over them -- see
   * ViewportOverlayHandle.adoptStatus for the collision this exists to end. A no-op when there
   * is no overlay (a host whose DOM could not take one), which leaves the element exactly where
   * the host put it. */
  adoptOverlayStatus(el: HTMLElement): void {
    this.overlay?.adoptStatus(el)
  }

  /** Perspective or orthographic. Orthographic is what makes two equal runs of blocks measure
   * equal on screen, which is the whole reason a voxel tool offers it -- judging "is this trunk
   * five or six tall" under perspective is guesswork at any distance. */
  setProjection(projection: OverlayProjection): void {
    if (this.projection === projection) return
    this.projection = projection
    this.syncOrthoCamera()
    this.syncOverlay()
  }

  getProjection(): OverlayProjection {
    return this.projection
  }

  /** The camera actually rendered/picked against this frame. */
  private activeCamera(): THREE.Camera {
    return this.projection === 'orthographic' ? this.orthoCamera : this.camera
  }

  /** Re-derives the orthographic frustum from the perspective camera's current position, target
   * and aspect. Cheap enough to run every frame, and running it every frame is what keeps the two
   * cameras from ever disagreeing after an orbit or a dolly. */
  private syncOrthoCamera(): void {
    if (this.projection !== 'orthographic') return
    const distance = this.camera.position.distanceTo(this.controls.target)
    // The height the perspective camera sees at the orbit target's depth -- matching it is what
    // makes toggling projection look like a lens change rather than a jump cut.
    const height = 2 * distance * Math.tan(((this.camera.fov / 2) * Math.PI) / 180)
    const width = height * this.camera.aspect
    this.orthoCamera.position.copy(this.camera.position)
    this.orthoCamera.quaternion.copy(this.camera.quaternion)
    this.orthoCamera.left = -width / 2
    this.orthoCamera.right = width / 2
    this.orthoCamera.top = height / 2
    this.orthoCamera.bottom = -height / 2
    const { radius } = this.computeBounds()
    // An orthographic frustum has no perspective divide, so `near` can sit close without costing
    // depth precision the way it would on the perspective camera (see computeClipPlanes).
    this.orthoCamera.near = 0.1
    this.orthoCamera.far = distance + radius * 4 + 200
    this.orthoCamera.updateProjectionMatrix()
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) this.stop()
    else this.start()
  }

  /** Starts the render loop if it is not already running. */
  private start(): void {
    if (this.running) return
    this.running = true
    this.rafHandle = requestAnimationFrame(this.animate)
  }

  /** Stops the render loop outright. The previous loop ran forever, including while the whole
   * webview was hidden behind another editor tab -- a frame every 16 ms rendering something
   * nobody can see. */
  private stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.rafHandle)
    this.rafHandle = 0
  }

  /** Replaces the displayed volume. Camera/controls are untouched -- a caller iterating on a
   * feature file (regenerate-on-save) must not have its orbit position reset just because a
   * fresh result arrived. Call `frameAll()` explicitly when a reset IS wanted (first load). */
  setVolume(volume: ViewerVolume, palette: readonly ViewerPaletteEntry[]): void {
    this.currentVolume = volume
    this.currentPalette = palette
    this.paletteById = new Map(palette.map((entry) => [entry.id, entry]))
    // Block ids are interned per RUN, so the same name can be a different id in the next
    // result -- the compiled atlas is indexed BY id and is therefore only valid for the palette
    // it was built against. Recompiling here (a few thousand array writes, no string work in
    // the hot path afterwards) is what stops a regenerate from painting stone with grass.
    if (this.atlasTable !== null) this.compiledAtlas = compileAtlas(this.atlasTable, palette, this.atlasWhiteCell, compileShapes(this.atlasTable, palette))
    // A fresh run re-interns cell indices against fresh bounds, so a mask built for the last
    // one names other cells. Dropped rather than remapped: only the host knows whether it still
    // has an attributed node, and it re-sends whenever it does.
    this.attribution = { mask: null, cells: 0, bounds: null }
    this.attributionGroups = []
    this.attributionMesh.visible = false
    // ONCE per result, not once per re-mesh: which overlays have anything to draw, where they
    // would draw it, and how hot the hottest cell is are all facts about the DATA, and a slice
    // drag changes none of them. See remesh.ts's own header for what that buys.
    this.summary = summarizeVolume(volume)
    this.remesh()
    this.rebuildGridAndBounds()
    // Re-tighten the dolly limit (see the constructor's own comment) to this specific volume's
    // own size now that one exists -- generous enough that framing/highlighting never bumps
    // into it, but no longer the constructor's unconditional 2000 for a volume much smaller
    // (or larger) than that. See maxDollyDistance for why this is no longer forty radii.
    const { radius } = this.computeBounds()
    this.controls.maxDistance = maxDollyDistance(radius)
    this.overlay?.setScale(`${volume.sizeX}×${volume.sizeY}×${volume.sizeZ}`)
    this.reframeIfContentEscaped()
  }

  /** Re-frames when the result that just arrived put its content outside the box the camera was
   * last fitted to.
   *
   * The rule this replaces framed the first result and then never again, so a run that placed
   * somewhere else -- a changed origin, a taller preset, a feature that moved -- left the camera
   * staring at where the LAST result used to be. On screen that is indistinguishable from a run
   * that placed nothing, which is the one thing this preview must never be ambiguous about.
   *
   * Deliberately narrow: only content that genuinely escaped the framed box counts (see
   * `boxContains`'s slack), and a result still inside it never moves the camera, which is what
   * keeps "regenerate on save without losing camera position" true for the ordinary case. */
  private reframeIfContentEscaped(): void {
    const framed = this.lastFramedBox
    if (framed === null) return
    // The same box frameContent() would fit, so "the content escaped what we framed" is asked
    // about the thing that was framed -- not about the terrain, which never moves.
    const content = this.computeContentBounds({ includeEnvironment: false }) ?? this.computeContentBounds({ includeEnvironment: true })
    if (content === null) return
    const slack = Math.max(framed.maxX - framed.minX, framed.maxY - framed.minY, framed.maxZ - framed.minZ) * REFRAME_SLACK_FRACTION
    if (boxContains(framed, content, slack)) return
    this.frameToBox(content)
  }

  /** Whether the camera has ever been framed at all -- a host uses this instead of its own
   * "framed once" latch, so the LATCH is gone while the "first result frames itself" behaviour
   * it was there for stays. */
  hasFramed(): boolean {
    return this.lastFramedBox !== null
  }

  /** Sets the Y cut. The VALUES land immediately (getSlice is never stale), the re-mesh they
   * imply is coalesced to one per animation frame.
   *
   * A slider drag fires `input` on every pixel of travel, and each one used to walk the whole
   * volume and rebuild every buffer -- work the display could not show more than once per frame
   * anyway. Coalescing belongs here rather than in each caller: this is the only place that knows
   * the cost is a re-mesh, and a host should not have to schedule around a method's internals. */
  setSlice(minY: number, maxY: number): void {
    this.sliceMinY = minY
    this.sliceMaxY = maxY
    this.scheduleRemesh()
  }

  /** Coalescing wrapper around remesh(). Falls back to an immediate re-mesh where there is no
   * requestAnimationFrame at all, so a non-browser host still gets correct geometry rather than
   * none. */
  private remeshHandle = 0
  private scheduleRemesh(): void {
    if (typeof requestAnimationFrame !== 'function') {
      this.remesh()
      return
    }
    if (this.remeshHandle !== 0) return
    this.remeshHandle = requestAnimationFrame(() => {
      this.remeshHandle = 0
      this.remesh()
    })
  }

  getSlice(): { minY: number; maxY: number } {
    return { minY: this.sliceMinY, maxY: this.sliceMaxY }
  }

  setEnvironmentMode(mode: EnvironmentMode): void {
    const before = this.environmentMode
    this.environmentMode = mode
    this.applyMaterials()
    // The environment pass is only BUILT while the environment is drawn (see remesh.ts), so
    // entering or leaving 'hidden' is the one mode change that has to re-mesh rather than just
    // re-point a material. Ghost <-> solid still does not: the same geometry is drawn either way.
    // Textured mode splits the environment's translucent blocks out of it except under ghost, so
    // that transition re-meshes too, exactly as it did before.
    if (before !== mode && (before === 'hidden' || mode === 'hidden' || ((before === 'ghost' || mode === 'ghost') && this.texturesActive()))) {
      this.remesh()
    }
    this.syncOverlay()
  }

  /** Points every mesh at the right material for the current (environment mode, textures
   * active) pair, and hides what should not draw. Single place, because the two axes multiply:
   * environment solid/ghost/hidden times flat/textured is six combinations, and having
   * setEnvironmentMode and setAtlas each set materials on their own is how one of the six ends
   * up drawing a ghosted environment with the opaque material. */
  private applyMaterials(): void {
    const textured = this.texturesActive()
    const ghost = this.environmentMode === 'ghost'
    const visible = this.environmentMode !== 'hidden'

    this.featureMesh.material = textured ? this.texturedOpaqueMaterial : this.featureMaterial
    this.featureTranslucentMesh.visible = textured

    this.environmentMesh.visible = visible
    if (ghost) {
      this.environmentMesh.material = textured ? this.texturedGhostMaterial : this.environmentGhostMaterial
      this.environmentMesh.renderOrder = 10
    } else {
      this.environmentMesh.material = textured ? this.texturedOpaqueMaterial : this.environmentSolidMaterial
      this.environmentMesh.renderOrder = 0
    }
    // A ghosted environment's translucent blocks (water under a ghost overlay) would be
    // translucency on top of translucency with no depth writes on either -- unreadable. The
    // ghost pass already draws them, since a ghosted environment routes everything through the
    // one blended material, so the dedicated translucent mesh stays empty in that mode (see
    // remesh) and is hidden here too.
    this.environmentTranslucentMesh.visible = textured && visible && !ghost
  }

  /** True exactly when geometry is being meshed and drawn with textures right now -- a host has
   * both supplied a usable atlas AND switched textures on. Everything else in this class asks
   * this rather than testing the two halves separately. */
  private texturesActive(): boolean {
    return this.texturesRequested && this.compiledAtlas !== null && this.atlasTexture !== null
  }

  /**
   * Supplies (or clears, with null) the block-texture atlas. Decodes the PNG bytes into a GPU
   * texture, so this is async; awaiting it is optional -- a caller that does not is simply in
   * flat-colour mode until it resolves, which is the same state it was already in.
   *
   * REJECTS RATHER THAN LIMPS. A PNG the browser cannot decode, a missing `createImageBitmap`,
   * an atlas whose dimensions do not match its own table: all leave the viewer exactly as it
   * was, in flat-colour mode, and throw so the host can say why once. Textures are an
   * enhancement to a tool that has to keep working without them.
   *
   * Calling this does NOT turn textures on -- `setTexturesEnabled(true)` does. The two are
   * separate so a host can fetch the atlas once at startup and let the user toggle without
   * another round trip.
   */
  async setAtlas(atlas: DecodedAtlas | null): Promise<void> {
    if (atlas === null) {
      this.atlasTexture?.dispose()
      this.atlasTexture = null
      this.atlasTable = null
      this.compiledAtlas = null
      this.applyMaterials()
      this.remesh()
      // THE BUTTON IS PART OF THE STATE, not a separate opinion about it -- see the syncOverlay
      // call at the end of this method.
      this.syncOverlay()
      this.emitTexturesChanged()
      return
    }

    const prepared = await prepareAtlas(atlas)

    this.atlasTexture?.dispose()
    this.atlasTexture = prepared.texture
    this.atlasTable = prepared.table
    this.atlasWhiteCell = prepared.white
    this.texturedOpaqueMaterial.map = prepared.texture
    this.texturedGhostMaterial.map = prepared.texture
    this.texturedTranslucentMaterial.map = prepared.texture
    this.texturedOpaqueMaterial.needsUpdate = true
    this.texturedGhostMaterial.needsUpdate = true
    this.texturedTranslucentMaterial.needsUpdate = true
    this.compiledAtlas = compileAtlas(prepared.table, this.currentPalette, prepared.white, compileShapes(prepared.table, this.currentPalette))
    this.applyMaterials()
    this.remesh()
    // THE OVERLAY'S TEXTURE BUTTON IS A READOUT OF hasAtlas()/texturesActive(), so every path
    // that changes either has to push the new answer at it. Leaving this out is what made the
    // button keep saying "Block textures are not available: no texture atlas has been built for
    // this machine" over a visibly textured preview, until an unrelated click on Grid (which
    // does call syncOverlay) corrected it -- an overlay that only tells the truth after you
    // press something else is worse than one that says nothing.
    this.syncOverlay()
    // A host whose only signal that textures became POSSIBLE was this promise resolving had to
    // decide on the spot whether to turn them on; one that listens here can instead keep its own
    // remembered preference and apply it whenever an atlas turns up. See panel.ts's texture row.
    this.emitTexturesChanged()
  }

  /** Whether an atlas has been supplied and decoded -- i.e. whether `setTexturesEnabled(true)`
   * would actually change what is drawn. A host uses this to enable or hide its own toggle. */
  hasAtlas(): boolean {
    return this.atlasTexture !== null && this.compiledAtlas !== null
  }

  /** Switches textured rendering on or off. Defaults to OFF and has no effect until an atlas
   * has been supplied -- see `setAtlas` and the "textured rendering" comment block above. */
  setTexturesEnabled(enabled: boolean): void {
    if (this.texturesRequested === enabled) return
    this.texturesRequested = enabled
    this.applyMaterials()
    this.remesh()
    // Same rule as setAtlas above: the overlay button shows what is being drawn, so it is told.
    this.syncOverlay()
    this.emitTexturesChanged()
  }

  getTexturesEnabled(): boolean {
    return this.texturesActive()
  }

  /** What this viewer can currently say about textures -- whether it has an atlas, whether it is
   * drawing with it, and which blocks that atlas could not answer for.
   *
   * THE UNRESOLVED LIST IS THE HONEST HALF, and it is measured against THIS result's palette
   * rather than against the pack as a whole: a block the atlas has never heard of still draws,
   * in its flat palette colour, inside the textured pass (see compileAtlas), so nothing on
   * screen distinguishes "this block's texture is a flat colour" from "we could not find this
   * block's texture". A preview that quietly mixes the two is the one way turning textures on
   * can mislead, and this is what lets a panel say so in one line instead. */
  getTextureReport(): TextureReport {
    return {
      hasAtlas: this.hasAtlas(),
      enabled: this.texturesActive(),
      blocks: this.currentPalette.length,
      unresolved: this.texturesActive() ? (this.compiledAtlas?.unresolved ?? []) : [],
    }
  }

  private emitTexturesChanged(): void {
    this.onTexturesChanged?.(this.getTextureReport())
  }

  getEnvironmentMode(): EnvironmentMode {
    return this.environmentMode
  }

  setShowGrid(show: boolean): void {
    this.showGrid = show
    this.gridHelper.visible = show
    this.syncBoundsBoxVisibility()
    this.syncOverlay()
  }

  /** Draws the bench outline only when the current framing actually contains the bench.
   *
   * Two white edges ran off the top of every preview: the camera fits the CONTENT and the
   * outline spans the whole bench, so its far corners were always outside the frame. A wireframe
   * box with two sides missing does not read as a box that continues past the viewport; it reads
   * as a rendering fault, and it is the first thing in the picture. Now framing the feature hides
   * it and framing the bench (Shift+R, "Frame bench") brings it back -- which also makes the
   * outline a readout of which of the two framings is in effect.
   *
   * `showGrid` still has the last word: this can only take the outline away, never put it back
   * when the user asked for no grid. The floor grid itself is untouched -- a grid running off the
   * edge of the view is what a grid does. */
  private syncBoundsBoxVisibility(): void {
    this.boundsBox.visible = this.showGrid && this.benchFitsFraming()
  }

  /** Whether the whole bench is inside the box the camera was last fitted to. True when there is
   * no volume or nothing has been framed yet -- neither is a reason to hide anything. */
  private benchFitsFraming(): boolean {
    const framed = this.lastFramedBox
    const v = this.currentVolume
    if (framed === null || !v) return true
    const slack = Math.max(framed.maxX - framed.minX, framed.maxY - framed.minY, framed.maxZ - framed.minZ) * OUTLINE_FIT_SLACK_FRACTION
    const bench: Box3 = { minX: v.minX, minY: v.minY, minZ: v.minZ, maxX: v.minX + v.sizeX, maxY: v.minY + v.sizeY, maxZ: v.minZ + v.sizeZ }
    return boxContains(framed, bench, slack)
  }

  /** Toggles the translucent "carved" overlay for cells the feature removed (baseline
   * non-air -> result air). Defaults to on -- see `showCarved`'s doc comment. */
  setShowCarved(show: boolean): void {
    this.showCarved = show
    this.remesh()
  }

  getShowCarved(): boolean {
    return this.showCarved
  }

  /** Toggles the touch-count heatmap overlay (see `ViewerVolume.touchCounts`'s doc comment
   * and `heatColor` above). Defaults to off -- see `showHeatmap`'s doc comment. */
  setShowHeatmap(show: boolean): void {
    this.showHeatmap = show
    this.heatmapMesh.visible = show
    this.remesh()
  }

  getShowHeatmap(): boolean {
    return this.showHeatmap
  }

  /** Toggles the out-of-bounds capture overlay (see `ViewerVolume.overflowBlocks`'s doc
   * comment and `showOverflow`'s own doc comment for why this defaults to true). */
  setShowOverflow(show: boolean): void {
    this.showOverflow = show
    this.remesh()
  }

  getShowOverflow(): boolean {
    return this.showOverflow
  }

  /** Highest touch count in the current volume, or 0 when there is none -- what the
   * heatmap's colour ramp is normalized against. Exposed for a host UI to show alongside the
   * `setShowHeatmap` toggle (e.g. "hottest cell: N touches"). */
  getMaxTouchCount(): number {
    return this.summary.maxTouchCount
  }

  /** Marks a request as in flight.
   *
   * The LAST FRAME STAYS AT FULL OPACITY. This used to drop the canvas to 0.45, which let the
   * page show through the preview and made a working tool read as a broken one -- a result
   * already on screen is still a true result while the next one is computed, and greying it out
   * says the opposite. What changes instead is the corner pill: what is happening, how long it
   * has been happening (`BUSY_TICK_MS`), and -- when a host has armed one, see
   * `setCancelHandler` -- the way out.
   *
   * Never touches geometry, camera, or any THREE.js scene state. */
  setBusy(busy: boolean): void {
    this.canvas.classList.toggle('fl-canvas-busy', busy)
    if (this.busyTimer !== 0) {
      clearInterval(this.busyTimer)
      this.busyTimer = 0
    }
    this.overlay?.setBusy(busy)
    if (!busy) return
    this.busyStartedAt = Date.now()
    this.overlay?.setElapsed(0)
    this.busyTimer = setInterval(() => this.overlay?.setElapsed(Date.now() - this.busyStartedAt), BUSY_TICK_MS) as unknown as number
  }

  /** Arms the busy pill's Cancel button with `fn`, or disarms it with null.
   *
   * A HOST DECIDES WHETHER THIS EXISTS, and its absence is meaningful: a preview host with no way
   * to stop an in-flight request shows no Cancel at all, rather than a button that looks live and
   * silently does nothing -- the same rule panel.ts's own `onGrowRegenerate`/`onReloadFiles`
   * already follow. */
  setCancelHandler(fn: (() => void) | null): void {
    this.cancelHandler = fn
    this.overlay?.setCancelHandler(fn)
  }

  /** Whether a cancel path is currently armed -- for a host that wants to say so elsewhere. */
  canCancel(): boolean {
    return this.cancelHandler !== null
  }

  /** Frames the camera to the full VOLUME bounds -- the wireframe box (see `boundsBox` /
   * `rebuildGridAndBounds`), air included. Useful for seeing where a feature sits relative to
   * the volume it was asked to fill, but a typical volume is mostly air above/around the
   * terrain (e.g. 32x48x32 with a feature only in the lower third), so this is usually a much
   * looser fit than `frameContent()` below. Bound to Shift+R (see `handleKeyDown`) and a
   * secondary panel button -- `frameContent()` is what "Frame view (R)" and the first-result
   * auto-frame call by default now, see that method's own doc comment for why. */
  frameAll(): void {
    const v = this.currentVolume
    const box: Box3 = v
      ? { minX: v.minX, minY: v.minY, minZ: v.minZ, maxX: v.minX + v.sizeX, maxY: v.minY + v.sizeY, maxZ: v.minZ + v.sizeZ }
      : { minX: -8, minY: 0, minZ: -8, maxX: 8, maxY: 16, maxZ: 8 }
    this.frameToBox(box)
  }

  /** Frames the camera to THE FEATURE -- the cells this run placed, carved or overwrote, plus
   * any out-of-bounds writes currently drawn -- respecting the Y cut.
   *
   * This used to frame "everything occupied", which with the default solid environment means
   * every terrain cell: the occupied box WAS the bench, so a 53-block feature was framed as a
   * postage stamp in the middle of it and this method and `frameAll()` produced the same picture
   * until the terrain was hidden -- which the overlay button's own tooltip advertised as the
   * difference between them. Framing the feature is what "frame view" was always taken to mean.
   *
   * Two fallbacks, in order, so the camera is never left pointed at nothing: the visible
   * terrain when this run touched nothing at all (a refusal, a filter), then `frameAll()` when
   * even that is empty (terrain hidden, carved overlay off). `frameAll()` -- the whole bench,
   * air included -- stays on Shift+R and the panel's second button. */
  frameContent(): void {
    const bounds = this.computeContentBounds({ includeEnvironment: false }) ?? this.computeContentBounds({ includeEnvironment: true })
    if (!bounds) {
      this.frameAll()
      return
    }
    this.frameToBox(bounds)
  }

  /** Moves the camera to look at world cell (x,y,z) and marks it with a bright highlight
   * overlay (see HIGHLIGHT_* constants' doc comment) -- the click-to-locate behaviour a
   * diagnostic's `position` drives (see featurelab-frontend's panel.ts Diagnostics section).
   * Frames a small padded neighbourhood around the cell (HIGHLIGHT_FRAME_PADDING), not just the
   * 1x1x1 cell itself, so the highlighted block is seen in its surrounding context instead of
   * filling the whole viewport with nothing to orient against. Camera/controls state is
   * otherwise untouched by anything else (setVolume, a regenerate) -- exactly like every other
   * framing call, this only ever fires in response to an explicit user action. */
  highlightCell(x: number, y: number, z: number, options: { frame?: boolean } = {}): void {
    const cx = x + 0.5
    const cy = y + 0.5
    const cz = z + 0.5
    this.highlightMesh.position.set(cx, cy, cz)
    this.highlightEdges.position.set(cx, cy, cz)
    // Back to one cell, whatever size the last selection box left behind -- see
    // `frameAttributionGroup`.
    this.highlightMesh.scale.set(1, 1, 1)
    this.highlightEdges.scale.set(1, 1, 1)
    this.highlightMesh.visible = true
    this.highlightEdges.visible = true

    // Framing is the DEFAULT and stays so: every existing caller is a diagnostic's position,
    // where the whole point is that the cell is somewhere the user cannot currently see.
    // `frame: false` is for the opposite case -- marking a cell the user just clicked, which is
    // by definition already on screen and under their pointer. Moving the camera there would
    // throw away the view they chose in order to show them what they were already looking at.
    if (options.frame === false) return
    const p = HIGHLIGHT_FRAME_PADDING
    this.frameToBox({ minX: cx - p, minY: cy - p, minZ: cz - p, maxX: cx + p, maxY: cy + p, maxZ: cz + p })
  }

  /** Frames AND SELECTS one writer's own cells -- what a legend row does when it is activated
   * (see viewportOverlay.ts's LegendEntry.onActivate, and describeLegend's `onSelectWriter`).
   *
   * Until this existed, "which of these writers put that block there" could only be asked with a
   * mouse, by clicking the block: the legend named every writer and counted its blocks in plain
   * text, but as list items no tab stop could reach. This is the same answer from the other
   * direction -- pick the writer, and the camera goes to its cells and outlines them.
   *
   * The marker is the WIREFRAME only, not highlightCell's translucent fill: a fill scaled over a
   * writer's whole extent would paint out the very geometry it is pointing at. Returns false
   * when the index names no group, or a group that owns no cells on screen -- there is nothing
   * to frame, and moving the camera anyway would be worse than doing nothing.
   */
  frameAttributionGroup(index: number): boolean {
    const bounds = this.attributionGroups[index]?.bounds ?? null
    if (bounds === null) return false
    const sizeX = bounds.maxX - bounds.minX + 1
    const sizeY = bounds.maxY - bounds.minY + 1
    const sizeZ = bounds.maxZ - bounds.minZ + 1
    const box: Box3 = { minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ, maxX: bounds.minX + sizeX, maxY: bounds.minY + sizeY, maxZ: bounds.minZ + sizeZ }
    this.highlightMesh.visible = false
    this.highlightEdges.position.set(bounds.minX + sizeX / 2, bounds.minY + sizeY / 2, bounds.minZ + sizeZ / 2)
    this.highlightEdges.scale.set(sizeX, sizeY, sizeZ)
    this.highlightEdges.visible = true
    this.frameToBox(box)
    return true
  }

  /** Hides highlightCell()'s marker without otherwise touching the camera. */
  clearHighlight(): void {
    this.highlightMesh.visible = false
    this.highlightEdges.visible = false
  }

  /** Paints the cells ONE feature wrote, from a host that has a profiled run behind it.
   *
   * `cells` are flat cell indices under this volume's OWN indexing -- the same scheme
   * `ViewerVolume.data`/`changed`/`touchCounts` use, and the same one profiler.CellAttribution
   * emits -- so a host hands over an AttributionIndex's `cellsWrittenBy` result unchanged, with
   * no coordinate work anywhere between the engine and here.
   *
   * `null` clears the overlay. So does an EMPTY array, but the two mean different things to the
   * host and this method deliberately does not collapse them: a node that ran and wrote nothing
   * has an empty answer, which is an answer, and `getAttributionCellCount()` reporting 0 after a
   * successful call is how a host tells that apart from never having asked.
   *
   * Out-of-range indices are skipped rather than throwing. A cell index is only meaningful
   * against the bounds it was computed for, and a host posting a result and its attribution as
   * two messages can legitimately race a regenerate -- a stale index landing on a fresh volume
   * should paint nothing, not take the preview down. */
  setAttributionCells(cells: Uint32Array | readonly number[] | null): void {
    this.setAttributionGroups(cells === null ? null : [{ id: 'attributed', label: '', cells }])
  }

  /**
   * Paints the cells SEVERAL features wrote, one colour per feature.
   *
   * The multi-writer form of `setAttributionCells`, and the reason the overlay grew a legend.
   * One colour could only ever answer "is this block one of that node's" -- but the question a
   * person actually has in front of a preview is "which of these is whose", and the interesting
   * answer to it is almost always more than one node: a scatter and the tree it delegates to, two
   * features fighting over the same column. Handing over several groups says that; handing over
   * the winner of an argument the engine's own table does not record would not (see
   * graph/attribution.ts's own header on why no single writer can honestly be called the placer).
   *
   * Each group's `cells` are flat cell indices under this volume's OWN indexing -- the same
   * scheme `ViewerVolume.data`/`changed`/`touchCounts` use, and the same one
   * profiler.CellAttribution emits -- so a host hands over an AttributionIndex's result unchanged.
   *
   * COLOURS ARE ASSIGNED BY POSITION, from colors.ts's ATTRIBUTION series, so the host controls
   * them by controlling the order (most writes first is the obvious one) and the legend and the
   * geometry can never disagree about which colour is whose. Past the end of the series they
   * repeat; a host with more writers than that should group the tail rather than show a seventh
   * that looks like the first.
   *
   * OVERLAP GOES TO THE FIRST GROUP THAT CLAIMS IT, and the legend says how many cells that cost
   * each later group (`getAttributionGroups().overlapped`). A cell cannot be painted twice, and
   * quietly letting the last writer win would make the picture depend on list order without
   * saying so.
   *
   * `null` clears the overlay. So does an EMPTY list, and so does a list whose groups are all
   * empty -- but the three mean different things to the host and this method deliberately does
   * not collapse them: a node that ran and wrote nothing has an empty answer, which is an answer,
   * and `getAttributionGroups()` reporting a group with 0 cells is how a host tells that apart
   * from never having asked.
   *
   * Out-of-range indices are skipped rather than throwing. A cell index is only meaningful
   * against the bounds it was computed for, and a host posting a result and its attribution as
   * two messages can legitimately race a regenerate -- a stale index landing on a fresh volume
   * should paint nothing, not take the preview down.
   */
  setAttributionGroups(groups: readonly AttributionGroup[] | null): void {
    const volume = this.currentVolume
    if (groups === null || volume === null) {
      this.attribution = { mask: null, cells: 0, bounds: null }
      this.attributionGroups = []
      this.attributionMesh.visible = false
      this.remesh()
      this.syncLegend()
      return
    }
    const interned = internAttributionGroups(volume, groups)
    this.attribution = interned.attribution
    this.attributionGroups = interned.groups
    this.attributionMesh.visible = interned.attribution.cells > 0
    this.remesh()
    this.syncLegend()
  }

  /** How many distinct in-range cells the current attribution overlay marks, across every group.
   * 0 both for "no host has asked" and for "the node wrote nothing"; see setAttributionGroups on
   * why this class does not pretend to tell those apart. */
  getAttributionCellCount(): number {
    return this.attribution.cells
  }

  /** What the overlay is currently painting, per writer, in the order the host supplied -- the
   * same order the colours and the legend are in. Empty when the overlay is off. */
  getAttributionGroups(): readonly AttributionGroupState[] {
    return this.attributionGroups
  }

  /** The world cell under a screen point, or null when the ray hits nothing drawn.
   *
   * A QUERY, not a mode: this viewer binds no pointer handler and remembers no picked cell. The
   * host decides which gesture is a pick -- which matters, because the left button is also how
   * OrbitControls orbits, so "a click" here has to mean "a press and release that did not
   * rotate the camera", and only the host sees the whole gesture.
   *
   * Coordinates are CLIENT coordinates (a PointerEvent's clientX/clientY), converted against the
   * canvas's own box here so a caller never has to know where the canvas sits on the page.
   *
   * The cell is derived from the hit POINT stepped half a block along the inward face normal
   * (see PICK_DEPTH), not from any per-face index: every pass here is a merged, face-culled
   * buffer with no cell identity left in it, and rebuilding one purely to answer this would
   * multiply the memory a preview costs. The step is exact for the boxy geometry this viewer
   * draws -- every face lies on an integer plane -- so this is not an approximation.
   *
   * Only cells INSIDE the current volume are returned. The overflow overlay draws captured
   * blocks at world positions outside the bench on purpose (see ViewerVolume.overflowBlocks),
   * and those have no cell index for a caller to look anything up by, so a pick that lands on
   * one answers null rather than a number that indexes the wrong cell. */
  pickCell(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
    const volume = this.currentVolume
    if (volume === null) return null
    const box = this.canvas.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return null
    const ndc = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -(((clientY - box.top) / box.height) * 2 - 1))
    this.raycaster.setFromCamera(ndc, this.activeCamera())
    // Every pass that can be on screen, ghosted environment included: a person clicking a block
    // they can see expects an answer regardless of which overlay happens to be drawing it.
    const targets = [
      this.featureMesh,
      this.environmentMesh,
      this.featureTranslucentMesh,
      this.environmentTranslucentMesh,
      this.carvedMesh,
      this.heatmapMesh,
      this.attributionMesh,
    ].filter((mesh) => mesh.visible)
    const hits = this.raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      if (hit.face === null || hit.face === undefined) continue
      const inward = hit.face.normal
      const x = Math.floor(hit.point.x - inward.x * PICK_DEPTH)
      const y = Math.floor(hit.point.y - inward.y * PICK_DEPTH)
      const z = Math.floor(hit.point.z - inward.z * PICK_DEPTH)
      if (x < volume.minX || x >= volume.minX + volume.sizeX) continue
      if (y < volume.minY || y >= volume.minY + volume.sizeY) continue
      if (z < volume.minZ || z >= volume.minZ + volume.sizeZ) continue
      return { x, y, z }
    }
    return null
  }

  /** Describes the cell at (x, y, z) from the current volume and palette -- what `onPick` hands
   * a listener. Null when the cell is outside the bench, which `pickCell` has already excluded
   * but a direct caller might not have. */
  describeCell(x: number, y: number, z: number): PickedCell | null {
    const v = this.currentVolume
    if (v === null) return null
    return describeCellAt(v, this.paletteById, x, y, z)
  }

  // The pick gesture -- see `onPick`. A pick is a press and a release within a few pixels of each
  // other, which is what "a click" means to a hand and what no single DOM event can report on its
  // own.
  private static readonly PICK_SLOP_PX = 4

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pressedAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const down = this.pressedAt
    this.pressedAt = null
    if (this.onPick === null || down === null || event.button !== 0) return
    const slop = VoxelViewer.PICK_SLOP_PX
    if (Math.abs(event.clientX - down.x) > slop || Math.abs(event.clientY - down.y) > slop) return
    const cell = this.pickCell(event.clientX, event.clientY)
    if (cell === null) return
    const described = this.describeCell(cell.x, cell.y, cell.z)
    if (described === null) return
    this.highlightCell(cell.x, cell.y, cell.z, { frame: false })
    this.onPick(described)
  }

  /** Shared by frameAll/frameContent/highlightCell -- fits the camera to `box` along the fixed
   * diagonal DEFAULT_FRAME_DIR via fitBoxToView (see cameraFit.ts), replacing the old bounding-
   * sphere-at-a-fixed-multiplier math that clipped an elongated box's far corners (see that
   * module's own header comment for the full "why"). */
  private frameToBox(box: Box3): void {
    const fit = fitBoxToView(box, DEFAULT_FRAME_DIR, this.camera.fov, this.camera.aspect, FRAME_MARGIN, FRAME_MIN_HALF_EXTENT)
    this.camera.position.set(fit.center.x + fit.direction.x * fit.distance, fit.center.y + fit.direction.y * fit.distance, fit.center.z + fit.direction.z * fit.distance)
    const dx = box.maxX - box.minX
    const dy = box.maxY - box.minY
    const dz = box.maxZ - box.minZ
    const boxRadius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
    // Gives the very first rendered frame a correct near/far immediately, rather than one
    // frame's worth of whatever the camera previously had -- updateClipPlanes() (called every
    // frame from animate(), see its own doc comment) recomputes this continuously from here on,
    // including the moment the user starts dollying, which is the actual fix for the reported
    // "zoom out and the preview disappears" bug (this call alone, like the code it replaces,
    // only ever ran again on the NEXT frame/highlight action -- never on a plain scroll-to-zoom).
    const { near, far } = computeClipPlanes(fit.distance, boxRadius)
    this.camera.near = near
    this.camera.far = far
    this.camera.updateProjectionMatrix()
    this.controls.target.set(fit.center.x, fit.center.y, fit.center.z)
    this.controls.update()
    // Remembered for resize() and reframeIfContentEscaped(); `cameraTouched` goes back to false
    // because THIS class just chose where the camera is, so nothing here is overruling a user.
    this.lastFramedBox = { ...box }
    this.cameraTouched = false
    this.syncBoundsBoxVisibility()
    this.syncOrthoCamera()
  }

  /** Re-fits the renderer, both cameras and -- when the user has not moved the camera since the
   * last framing -- the framed box itself to the new aspect.
   *
   * The re-fit is the point. `resize()` used to change only `camera.aspect`, which for a
   * PerspectiveCamera keeps the VERTICAL field of view fixed and widens horizontally: dragging
   * the sidebar narrower gave the preview more empty space on either side of content that stayed
   * exactly the size it was. Re-running the fit uses the extra width on the content instead.
   *
   * Gated on `cameraTouched` for the reason that flag exists: a camera the user placed by hand is
   * a decision, and a panel resize is not a reason to overrule it. */
  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    if (!this.cameraTouched && this.lastFramedBox !== null) this.frameToBox(this.lastFramedBox)
    else this.syncOrthoCamera()
  }

  dispose(): void {
    this.stop()
    if (this.remeshHandle !== 0) {
      cancelAnimationFrame(this.remeshHandle)
      this.remeshHandle = 0
    }
    if (this.busyTimer !== 0) {
      clearInterval(this.busyTimer)
      this.busyTimer = 0
    }
    this.overlay?.dispose()
    this.overlay = null
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('keydown', this.handleKeyDown)
    this.canvas.removeEventListener('keydown', this.handleCanvasKeyDown)
    this.reducedMotion?.removeEventListener('change', this.handleMotionPreferenceChange)
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.controls.dispose()

    this.featureGeometry.dispose()
    this.environmentGeometry.dispose()
    this.featureTranslucentGeometry.dispose()
    this.environmentTranslucentGeometry.dispose()
    this.texturedOpaqueMaterial.dispose()
    this.texturedGhostMaterial.dispose()
    this.texturedTranslucentMaterial.dispose()
    this.atlasTexture?.dispose()
    this.carvedGeometry.dispose()
    this.heatmapGeometry.dispose()
    this.attributionGeometry.dispose()
    this.overflowGeometry.dispose()
    this.featureMaterial.dispose()
    this.environmentSolidMaterial.dispose()
    this.environmentGhostMaterial.dispose()
    this.carvedMaterial.dispose()
    this.heatmapMaterial.dispose()
    this.attributionMaterial.dispose()
    this.overflowMaterial.dispose()
    this.highlightGeometry.dispose()
    this.highlightMaterial.dispose()
    this.highlightEdgesGeometry.dispose()
    this.highlightEdgesMaterial.dispose()

    this.gridHelper.geometry.dispose()
    ;(this.gridHelper.material as THREE.Material).dispose()
    this.boundsBox.geometry.dispose()
    ;(this.boundsBox.material as THREE.Material).dispose()

    this.renderer.dispose()
  }

  private computeBounds(): { center: THREE.Vector3; radius: number } {
    const v = this.currentVolume
    if (!v) return { center: new THREE.Vector3(0, 0, 0), radius: 10 }
    const center = new THREE.Vector3(v.minX + v.sizeX / 2, v.minY + v.sizeY / 2, v.minZ + v.sizeZ / 2)
    const radius = Math.max(4, Math.sqrt(v.sizeX * v.sizeX + v.sizeY * v.sizeY + v.sizeZ * v.sizeZ) / 2)
    return { center, radius }
  }

  /** Bounding box of cells actually worth looking at right now -- what `frameContent()` fits
   * the camera to, via `computeOccupiedBounds` (contentBounds.ts -- pulled into its own module
   * so it's unit-testable without a WebGL context; see that module's own doc comment for
   * exactly which cells count as occupied and why). Returns null when nothing is occupied (a
   * placement refusal with the environment hidden and the carved overlay off, or an empty
   * slice range) -- `frameContent()` falls back to `frameAll()` in that case. Returns the box
   * directly (not a center/radius sphere) -- frameToBox's exact corner-fit needs the box's own
   * shape, not a sphere that circumscribes it (see cameraFit.ts's header comment for why that
   * distinction is exactly what fixed the reported clipping bug). */
  private computeContentBounds(opts: { includeEnvironment: boolean }): Box3 | null {
    const v = this.currentVolume
    if (!v) return null
    const bounds = computeOccupiedBounds(v, this.currentPalette, {
      sliceMinY: this.sliceMinY,
      sliceMaxY: this.sliceMaxY,
      environmentVisible: this.environmentMode !== 'hidden',
      includeEnvironment: opts.includeEnvironment,
      showCarved: this.showCarved,
      showOverflow: this.showOverflow,
      overflowBlocks: v.overflowBlocks,
    })
    if (!bounds) return null
    return { minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ, maxX: bounds.maxX, maxY: bounds.maxY, maxZ: bounds.maxZ }
  }

  private setView(kind: ViewSnap): void {
    const { center, radius } = this.computeBounds()
    const dist = radius * 2.2
    const dir =
      kind === 'front'
        ? new THREE.Vector3(0, 0.001, 1)
        : kind === 'side'
          ? new THREE.Vector3(1, 0.001, 0)
          : new THREE.Vector3(0.0001, 1, 0.0001)
    dir.normalize()
    this.camera.position.copy(center).addScaledVector(dir, dist)
    // See frameToBox's own comment on computeClipPlanes -- same reasoning, same continuous
    // per-frame follow-up via updateClipPlanes().
    const { near, far } = computeClipPlanes(dist, radius)
    this.camera.near = near
    this.camera.far = far
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(center)
    this.controls.update()
    // A snap is a framing like any other -- see frameToBox's own comment on these two lines.
    this.lastFramedBox = { minX: center.x - radius, minY: center.y - radius, minZ: center.z - radius, maxX: center.x + radius, maxY: center.y + radius, maxZ: center.z + radius }
    this.cameraTouched = false
    this.syncBoundsBoxVisibility()
    this.syncOrthoCamera()
  }

  private remesh(): void {
    const volume = this.currentVolume
    if (!volume) return
    // WHAT to mesh is remesh.ts's decision and nothing here second-guesses it; what is left for
    // this method is the three.js half -- pushing eight buffers into eight geometries.
    const passes = buildScenePasses({
      volume,
      palette: this.currentPalette,
      summary: this.summary,
      sliceMinY: this.sliceMinY,
      sliceMaxY: this.sliceMaxY,
      environmentMode: this.environmentMode,
      showCarved: this.showCarved,
      showHeatmap: this.showHeatmap,
      showOverflow: this.showOverflow,
      attribution: this.attribution,
      atlas: this.texturesActive() ? this.compiledAtlas : null,
    })
    updateGeometry(this.featureGeometry, passes.feature)
    updateGeometry(this.featureTranslucentGeometry, passes.featureTranslucent)
    updateGeometry(this.environmentGeometry, passes.environment)
    updateGeometry(this.environmentTranslucentGeometry, passes.environmentTranslucent)
    updateGeometry(this.carvedGeometry, passes.carved)
    updateGeometry(this.heatmapGeometry, passes.heatmap)
    updateGeometry(this.attributionGeometry, passes.attribution)
    updateGeometry(this.overflowGeometry, passes.overflow)
    this.syncLegend()
  }


  private rebuildGridAndBounds(): void {
    this.scene.remove(this.gridHelper)
    this.gridHelper.geometry.dispose()
    ;(this.gridHelper.material as THREE.Material).dispose()

    this.scene.remove(this.boundsBox)
    this.boundsBox.geometry.dispose()
    ;(this.boundsBox.material as THREE.Material).dispose()

    const v = this.currentVolume
    const sizeX = v ? v.sizeX : 16
    const sizeY = v ? v.sizeY : 16
    const sizeZ = v ? v.sizeZ : 16
    const minX = v ? v.minX : -8
    const minY = v ? v.minY : 0
    const minZ = v ? v.minZ : -8

    const gridSize = Math.max(sizeX, sizeZ)
    this.gridHelper = new THREE.GridHelper(gridSize, gridSize, 0x5a6675, 0x2c3138)
    this.gridHelper.position.set(minX + sizeX / 2, minY, minZ + sizeZ / 2)
    this.gridHelper.visible = this.showGrid
    this.scene.add(this.gridHelper)

    const boxGeom = new THREE.BoxGeometry(sizeX, sizeY, sizeZ)
    const edges = new THREE.EdgesGeometry(boxGeom)
    boxGeom.dispose()
    this.boundsBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x7d8896 }))
    this.boundsBox.position.set(minX + sizeX / 2, minY + sizeY / 2, minZ + sizeZ / 2)
    this.scene.add(this.boundsBox)
    this.syncBoundsBoxVisibility()
  }

  /** Turns damping on or off from the current `prefers-reduced-motion` value. */
  private applyMotionPreference(): void {
    this.controls.enableDamping = this.reducedMotion?.matches !== true
  }

  private readonly handleMotionPreferenceChange = (): void => {
    this.applyMotionPreference()
  }

  /** Whether the camera glides after an input -- what `prefers-reduced-motion` switches off.
   * Exposed so the browser harness can assert the preference is actually honoured. */
  getDampingEnabled(): boolean {
    return this.controls.enableDamping
  }

  /** Orbits the camera around `controls.target` by whole radians, the keyboard's equivalent of a
   * drag. Clamped short of both poles (see KEY_POLAR_EPSILON) and marked as a camera the USER
   * chose, exactly as a drag is -- a resize must not undo it. */
  private orbitBy(dTheta: number, dPhi: number): void {
    const target = this.controls.target
    this.keyOffset.copy(this.camera.position).sub(target)
    this.keySpherical.setFromVector3(this.keyOffset)
    this.keySpherical.theta += dTheta
    this.keySpherical.phi = Math.min(Math.max(this.keySpherical.phi + dPhi, KEY_POLAR_EPSILON), Math.PI - KEY_POLAR_EPSILON)
    this.keyOffset.setFromSpherical(this.keySpherical)
    this.camera.position.copy(target).add(this.keyOffset)
    this.cameraTouched = true
    this.controls.update()
  }

  /** Dollies in (factor < 1) or out (factor > 1), within the same distance limits a scroll
   * gesture obeys -- including the maxDistance setVolume re-tightens to the content's own size. */
  private dollyBy(factor: number): void {
    const target = this.controls.target
    this.keyOffset.copy(this.camera.position).sub(target)
    const length = this.keyOffset.length()
    if (length === 0) return
    this.keyOffset.setLength(Math.min(Math.max(length * factor, this.controls.minDistance), this.controls.maxDistance))
    this.camera.position.copy(target).add(this.keyOffset)
    this.cameraTouched = true
    this.controls.update()
  }

  /** Enter/Space: the keyboard's pick. Answers the same question a click answers -- "what is
   * this block and did this run put it there" -- about the cell in the middle of the view, which
   * is the only cell a keyboard user can aim at. Silent when the centre of the view is empty
   * sky, exactly as a click on empty sky is. */
  private pickCenter(): void {
    if (this.onPick === null) return
    const box = this.canvas.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return
    const cell = this.pickCell(box.left + box.width / 2, box.top + box.height / 2)
    if (cell === null) return
    const described = this.describeCell(cell.x, cell.y, cell.z)
    if (described === null) return
    this.highlightCell(cell.x, cell.y, cell.z, { frame: false })
    this.onPick(described)
  }

  /** The canvas's own keys -- see KEY_ORBIT_RADIANS' comment for why `role="application"` had to
   * either grow these or be given up. */
  private readonly handleCanvasKeyDown = (ev: KeyboardEvent): void => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return
    switch (ev.key) {
      case 'ArrowLeft':
        this.orbitBy(-KEY_ORBIT_RADIANS, 0)
        break
      case 'ArrowRight':
        this.orbitBy(KEY_ORBIT_RADIANS, 0)
        break
      case 'ArrowUp':
        this.orbitBy(0, -KEY_ORBIT_RADIANS)
        break
      case 'ArrowDown':
        this.orbitBy(0, KEY_ORBIT_RADIANS)
        break
      // '=' is the unshifted key '+' lives on, and every 3D tool accepts it as zoom-in.
      case '+':
      case '=':
        this.dollyBy(1 / KEY_DOLLY_FACTOR)
        break
      case '-':
      case '_':
        this.dollyBy(KEY_DOLLY_FACTOR)
        break
      case 'PageUp':
        this.dollyBy(1 / KEY_DOLLY_PAGE)
        break
      case 'PageDown':
        this.dollyBy(KEY_DOLLY_PAGE)
        break
      case 'Home':
        this.frameContent()
        break
      case 'End':
        this.frameAll()
        break
      case 'Enter':
      case ' ':
        this.pickCenter()
        break
      default:
        return
    }
    // Only for a key this actually handled: Tab, Escape and everything else must still reach the
    // page, or the canvas becomes a keyboard trap.
    ev.preventDefault()
    ev.stopPropagation()
  }

  private readonly handleKeyDown = (ev: KeyboardEvent): void => {
    const target = ev.target
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }
    switch (ev.key) {
      // Plain 'r' frames THE FEATURE -- the cells this run touched (see frameContent's doc
      // comment); Shift+R ('R' -- the browser already folds the modifier into ev.key for a
      // letter, no separate ev.shiftKey check needed) frames the full volume bounds instead, for
      // seeing where a feature sits relative to the box it was asked to fill. The two used to
      // land in the same place whenever the environment was solid, which is the default.
      case 'r':
        this.frameContent()
        break
      case 'R':
        this.frameAll()
        break
      case '1':
        this.setView('front')
        break
      case '3':
        this.setView('side')
        break
      case '7':
        this.setView('top')
        break
      default:
        break
    }
  }

  /** Recomputes near/far every frame from the camera's CURRENT distance to `controls.target`
   * (not the distance at the last frame/highlight call) -- the actual fix for the reported
   * "preview vanishes when you zoom out" bug: frameToBox/setView above only ever set far from
   * their own fit distance, once, so a plain scroll-to-zoom dolly (which OrbitControls handles
   * entirely on its own, no hook back into this class) could push the camera arbitrarily far
   * past a far plane that was never updated to match. Called from `animate()` every frame,
   * which is already running unconditionally (the OrbitControls damping loop needs it) and is
   * cheap enough (one sqrt, two comparisons, an updateProjectionMatrix only when something
   * actually changed) not to matter next to the render call it precedes. `computeClipPlanes`
   * (cameraFit.ts) is the same near/far formula frameToBox/setView use at framing time, kept in
   * one place so both stay consistent. */
  private updateClipPlanes(): void {
    const distance = this.camera.position.distanceTo(this.controls.target)
    const { radius } = this.computeBounds()
    const { near, far } = computeClipPlanes(distance, radius)
    if (this.camera.near !== near || this.camera.far !== far) {
      this.camera.near = near
      this.camera.far = far
      this.camera.updateProjectionMatrix()
    }
  }

  private readonly animate = (): void => {
    if (!this.running) return
    this.rafHandle = requestAnimationFrame(this.animate)
    this.controls.update()
    this.updateClipPlanes()
    this.syncOrthoCamera()
    this.updateGizmo()
    this.renderer.render(this.scene, this.activeCamera())
  }

  private lastGizmoAt = 0

  /** Projects the three world axes into screen directions for the overlay's compass. Rate-limited
   * (GIZMO_UPDATE_INTERVAL_MS) because six SVG attribute writes per frame is more DOM work than
   * the scene itself costs, and the gizmo only has to be right, not smooth. */
  private updateGizmo(): void {
    const overlay = this.overlay
    if (overlay === null) return
    const now = Date.now()
    if (now - this.lastGizmoAt < GIZMO_UPDATE_INTERVAL_MS) return
    this.lastGizmoAt = now
    const cam = this.camera
    // The camera's own basis, inverted: a world axis's screen direction is its projection onto
    // the camera right/up vectors. Screen y grows DOWNWARD, hence the negation on the up term.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion)
    const project = (axis: THREE.Vector3): { x: number; y: number } => ({ x: axis.dot(right), y: -axis.dot(up) })
    overlay.setAxes({
      x: project(new THREE.Vector3(1, 0, 0)),
      y: project(new THREE.Vector3(0, 1, 0)),
      z: project(new THREE.Vector3(0, 0, 1)),
    })
  }
}
