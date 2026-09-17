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
import { computeClipPlanes, fitBoxToView, type Box3, type Vec3 } from './cameraFit.js'
import { buildMesh, buildOverflowMesh, compileAtlas, concatMeshBuffers, EMPTY_MESH_BUFFERS, PASS_TRANSLUCENT, type CompiledAtlas, type MeshBuffers, type OverflowBlockMesh } from './mesher.js'
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

const BACKGROUND_COLOR = 0x14161a
const GHOST_OPACITY = 0.22

// Carved-out cells (ViewerVolume.removed) render translucent, tinted a distinct hue -- reads
// as "absence" (a hole where terrain used to be), not ordinary placed geometry, and must not
// visually occlude solid feature blocks. A warm red/orange tint keeps each cell's own
// per-face-shaded colour (dirt still reads as dirt-ish) while unmistakably marking it as a
// ghost of removed material.
const CARVED_OPACITY = 0.35
const CARVED_TINT = 0xff5a3c

// Touch-count heatmap overlay: cool teal (touched once) through yellow to hot red (the
// cell's own maximum touch count this run) -- see `heatColor` below. Rendered as its own
// opaque mesh drawn after the feature/environment/carved passes (renderOrder) so a
// heavily-rewritten cell reads unambiguously, rather than as a translucent tint blended with
// whatever material happens to be under it.
const HEAT_COLD: readonly [number, number, number] = [0.1, 0.55, 0.55]
const HEAT_MID: readonly [number, number, number] = [0.95, 0.85, 0.15]
const HEAT_HOT: readonly [number, number, number] = [0.85, 0.1, 0.1]

// Out-of-bounds capture overlay (ViewerVolume.overflowBlocks -- see that field's own doc
// comment): a vivid magenta/pink tint blended over each captured block's OWN real palette
// colour (not a flat replacement -- see buildOverflowMesh, mesher.ts), so a captured block still
// reads as roughly the material it is, while being unmistakably distinct from ordinary feature
// geometry (its own real colour, untinted), the carved overlay (warm red/orange, CARVED_TINT
// above) and the heatmap overlay (teal-to-red, HEAT_* above) -- three different overlays this
// viewer already draws, none of which this one may be confused with. Opaque, like the heatmap
// overlay, for the same reason: a block that escaped the bench should read unambiguously, not
// blend translucently with whatever happens to be behind it.
const OVERFLOW_TINT: readonly [number, number, number] = [1.0, 0.15, 0.85]
const OVERFLOW_TINT_STRENGTH = 0.55

// Write-attribution overlay (see `setAttributionCells`): the cells ONE named feature wrote,
// handed down by a host that has a profiled run and an AttributionIndex over it. Painted as a
// flat, opaque colour rather than a tint blended over each cell's own material, for the same
// "read unambiguously" reason the heatmap is: the question this answers is "which blocks are
// this node's", and a blend would make the answer depend on what the block happened to be.
//
// The colour is chosen against the four overlays already here and must stay distinguishable
// from every one of them: carved is warm orange, overflow is magenta/pink, the heatmap runs
// teal -> yellow -> red, and highlightCell's marker is yellow. A vivid blue-violet is the one
// corner of that space nothing else occupies.
const ATTRIBUTION_COLOR: readonly [number, number, number] = [0.42, 0.45, 1.0]

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

/** Maps a touch count's position within `[1, maxCount]` (t=0 at the coldest end) to an RGB
 * triple via a two-segment teal -> yellow -> red ramp -- see the constants above. */
function heatColor(t: number): readonly [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t))
  const [a, b, u] = clamped < 0.5 ? [HEAT_COLD, HEAT_MID, clamped / 0.5] : [HEAT_MID, HEAT_HOT, (clamped - 0.5) / 0.5]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
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
  /** Highest `ViewerVolume.touchCounts` value in the current volume, computed once per
   * `setVolume` (not per `remesh`, since slice/toggle changes don't change the data) -- the
   * heatmap's colour ramp is normalized against this run's own maximum, not a fixed scale.
   * 0 when the current volume has no `touchCounts`. */
  private maxTouchCount = 0
  /** Toggles the touch-count heatmap overlay (see `ViewerVolume.touchCounts`'s doc comment
   * and `heatColor`). Defaults to off -- only meaningful once a profiled run exists. */
  private showHeatmap = false
  /** Toggles the out-of-bounds capture overlay (see `ViewerVolume.overflowBlocks`'s doc
   * comment). Defaults to ON, unlike carved/heatmap above -- this is the "capture and display"
   * behaviour's whole point: a captured block shows up automatically, with no action required,
   * the moment a result carries any. */
  private showOverflow = true

  /** One byte per cell of the CURRENT volume, 1 for a cell the attributed node wrote -- null
   * whenever no host has asked for the overlay, which is the state this viewer starts in and
   * returns to on every `setVolume` (a fresh run re-interns cell indices against fresh bounds,
   * so last run's mask names other cells; the host re-sends one if it still has an answer).
   * A mask rather than the cell list itself because `remesh` asks the question per cell index,
   * and a list would mean a set lookup per cell of the whole volume. */
  private attributionMask: Uint8Array | null = null
  /** How many cells `attributionMask` marks -- reported by `getAttributionCellCount` so a host
   * can say "1 284 blocks" without walking the mask itself. */
  private attributionCells = 0
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BACKGROUND_COLOR)

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000)
    this.camera.position.set(28, 34, 28)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(BACKGROUND_COLOR, 1)

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
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

    this.resize()
    this.controls.update()
    this.rafHandle = requestAnimationFrame(this.animate)
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
    this.attributionMask = null
    this.attributionCells = 0
    this.attributionMesh.visible = false
    this.maxTouchCount = 0
    if (volume.touchCounts) {
      for (let i = 0; i < volume.touchCounts.length; i++) {
        const v = volume.touchCounts[i] as number
        if (v > this.maxTouchCount) this.maxTouchCount = v
      }
    }
    this.remesh()
    this.rebuildGridAndBounds()
    // Re-tighten the dolly limit (see the constructor's own comment) to this specific volume's
    // own size now that one exists -- generous enough that framing/highlighting never bumps
    // into it, but no longer the constructor's unconditional 2000 for a volume much smaller
    // (or larger) than that.
    const { radius } = this.computeBounds()
    this.controls.maxDistance = Math.max(500, radius * 40)
  }

  setSlice(minY: number, maxY: number): void {
    this.sliceMinY = minY
    this.sliceMaxY = maxY
    this.remesh()
  }

  getSlice(): { minY: number; maxY: number } {
    return { minY: this.sliceMinY, maxY: this.sliceMaxY }
  }

  setEnvironmentMode(mode: EnvironmentMode): void {
    this.environmentMode = mode
    this.applyMaterials()
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
  }

  getTexturesEnabled(): boolean {
    return this.texturesActive()
  }

  getEnvironmentMode(): EnvironmentMode {
    return this.environmentMode
  }

  setShowGrid(show: boolean): void {
    this.showGrid = show
    this.gridHelper.visible = show
    this.boundsBox.visible = show
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
    return this.maxTouchCount
  }

  /** Toggles a "pending" visual treatment on the canvas itself (a CSS class -- see panel.css's
   * `.fl-canvas-busy` rule) -- the preview half of this repo's "no indication that anything is
   * happening" fix (panel.ts's own setBusy dims the stat tiles/readout, this is its counterpart
   * for the 3D view). Never touches geometry, camera, or any THREE.js scene state -- purely a
   * host-visible affordance so a slow generate reads as "still working" rather than looking
   * identical to an already-finished, empty result. */
  setBusy(busy: boolean): void {
    this.canvas.classList.toggle('fl-canvas-busy', busy)
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

  /** Frames the camera to what is actually occupied right now -- the feature's own changed
   * cells, plus whatever environment/carved geometry is currently visible (see
   * `computeContentBounds`) -- instead of the full volume bounds `frameAll()` uses. This is
   * the fix for the reported bug: a typical volume is 32x48x32 with terrain only in the lower
   * part, so framing the whole box left ~40% empty wireframe above the terrain. Falls back to
   * `frameAll()` when nothing is currently visible (e.g. a placement refusal with the
   * environment hidden and carved overlay off) so the view is never left pointed at nothing.
   * This is what the default "R" key and the panel's "Frame view (R)" button call now --
   * `frameAll()` (whole volume, air included) is still reachable via Shift+R / the secondary
   * button for understanding where a feature sits relative to its volume. */
  frameContent(): void {
    const bounds = this.computeContentBounds()
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
    const volume = this.currentVolume
    if (cells === null || volume === null) {
      this.attributionMask = null
      this.attributionCells = 0
      this.attributionMesh.visible = false
      this.remesh()
      return
    }
    const total = volume.sizeX * volume.sizeY * volume.sizeZ
    const mask = new Uint8Array(total)
    let marked = 0
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as number
      if (cell < 0 || cell >= total) continue
      if (mask[cell] === 1) continue
      mask[cell] = 1
      marked++
    }
    this.attributionMask = mask
    this.attributionCells = marked
    this.attributionMesh.visible = marked > 0
    this.remesh()
  }

  /** How many distinct in-range cells the current attribution overlay marks. 0 both for "no
   * host has asked" and for "the node wrote nothing"; see setAttributionCells on why this class
   * does not pretend to tell those apart. */
  getAttributionCellCount(): number {
    return this.attributionCells
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
    this.raycaster.setFromCamera(ndc, this.camera)
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
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle)
    window.removeEventListener('keydown', this.handleKeyDown)
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
  private computeContentBounds(): Box3 | null {
    const v = this.currentVolume
    if (!v) return null
    const bounds = computeOccupiedBounds(v, this.currentPalette, {
      sliceMinY: this.sliceMinY,
      sliceMaxY: this.sliceMaxY,
      environmentVisible: this.environmentMode !== 'hidden',
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
  }

  private remesh(): void {
    const volume = this.currentVolume
    if (!volume) return
    const palette = this.currentPalette
    const changed = volume.changed

    // Flat mode meshes exactly two passes, as it always has. Textured mode splits each of them
    // in two by the atlas' per-block render mode: everything opaque or cutout into the
    // alpha-tested pass, everything translucent into its own blended pass drawn afterwards.
    // The split is done through `accept` alone, so face CULLING is unaffected -- buildMesh
    // always occludes against the true neighbour data regardless of which pass is being built,
    // which is what keeps the inside of a lake unmeshed rather than turning into a stack of
    // overlapping water quads the moment water gets its own pass.
    const compiled = this.texturesActive() ? this.compiledAtlas : null
    const atlas = compiled?.mesher
    const translucentPass = compiled?.pass
    const isTranslucent = (id: number): boolean => translucentPass !== undefined && translucentPass[id] === PASS_TRANSLUCENT
    // A ghosted environment draws everything through one blended material, so routing its water
    // into a second blended pass would double-blend it -- see applyMaterials.
    const splitEnvironment = compiled !== null && this.environmentMode !== 'ghost'

    const featureBuf = buildMesh(volume, palette, {
      minY: this.sliceMinY,
      maxY: this.sliceMaxY,
      accept: (index: number, id: number) => changed[index] === 1 && !isTranslucent(id),
      atlas,
    })
    const envBuf = buildMesh(volume, palette, {
      minY: this.sliceMinY,
      maxY: this.sliceMaxY,
      accept: (index: number, id: number) => changed[index] !== 1 && (!splitEnvironment || !isTranslucent(id)),
      atlas,
    })

    updateGeometry(this.featureGeometry, featureBuf)
    updateGeometry(this.environmentGeometry, envBuf)

    if (compiled !== null) {
      updateGeometry(
        this.featureTranslucentGeometry,
        buildMesh(volume, palette, {
          minY: this.sliceMinY,
          maxY: this.sliceMaxY,
          accept: (index: number, id: number) => changed[index] === 1 && isTranslucent(id),
          atlas,
        }),
      )
      updateGeometry(
        this.environmentTranslucentGeometry,
        splitEnvironment
          ? buildMesh(volume, palette, {
              minY: this.sliceMinY,
              maxY: this.sliceMaxY,
              accept: (index: number, id: number) => changed[index] !== 1 && isTranslucent(id),
              atlas,
            })
          : EMPTY_MESH_BUFFERS,
      )
    } else {
      updateGeometry(this.featureTranslucentGeometry, EMPTY_MESH_BUFFERS)
      updateGeometry(this.environmentTranslucentGeometry, EMPTY_MESH_BUFFERS)
    }

    const removed = volume.removed
    const baseline = volume.baseline
    if (this.showCarved && removed.length > 0) {
      // Mesh the BASELINE volume (not the current one -- the current id at every removed
      // cell is air and carries no shape), restricted to cells `removed` marks. Neighbour
      // occlusion is therefore also evaluated against the baseline, which is what keeps
      // this cheap for a large contiguous carved region: two adjacent removed cells occlude
      // each other's shared face exactly like two adjacent solid blocks normally would, so
      // only the carved region's outer boundary is meshed, not its full interior.
      const baselineVolume: ViewerVolume = { ...volume, data: baseline }
      const carvedBuf = buildMesh(baselineVolume, palette, {
        minY: this.sliceMinY,
        maxY: this.sliceMaxY,
        accept: (index: number) => removed[index] === 1,
      })
      updateGeometry(this.carvedGeometry, carvedBuf)
    } else {
      updateGeometry(this.carvedGeometry, EMPTY_MESH_BUFFERS)
    }

    const touchCounts = volume.touchCounts
    if (this.showHeatmap && touchCounts !== undefined && this.maxTouchCount > 0) {
      const denom = Math.max(1, this.maxTouchCount - 1)
      const colorOverride = (index: number): readonly [number, number, number] => heatColor(((touchCounts[index] ?? 0) - 1) / denom)
      // Pass 1: cells whose CURRENT id is non-air -- buildMesh already skips air cells on
      // its own before calling `accept` (see mesher.ts), so this pass needs no extra air
      // check of its own.
      const currentBuf = buildMesh(volume, palette, {
        minY: this.sliceMinY,
        maxY: this.sliceMaxY,
        accept: (index: number) => (touchCounts[index] ?? 0) > 0,
        colorOverride,
      })
      // Pass 2: cells a feature touched but that ended up air in the CURRENT result
      // (written, then carved away again) -- meshed against baseline for shape, exactly
      // like the carved-volume overlay above, so a heavily-rewritten column that happens to
      // net out to "nothing here" doesn't silently vanish from the heatmap, which would
      // defeat its whole purpose.
      const isCurrentlyAir = (index: number): boolean => (this.paletteById.get(volume.data[index] as number)?.kind ?? 'air') === 'air'
      const baselineVolume: ViewerVolume = { ...volume, data: baseline }
      const baselineBuf = buildMesh(baselineVolume, palette, {
        minY: this.sliceMinY,
        maxY: this.sliceMaxY,
        accept: (index: number) => (touchCounts[index] ?? 0) > 0 && isCurrentlyAir(index),
        colorOverride,
      })
      updateGeometry(this.heatmapGeometry, concatMeshBuffers(currentBuf, baselineBuf))
    } else {
      updateGeometry(this.heatmapGeometry, EMPTY_MESH_BUFFERS)
    }

    const attributionMask = this.attributionMask
    if (attributionMask !== null && this.attributionCells > 0) {
      const attributionColor = (): readonly [number, number, number] => ATTRIBUTION_COLOR
      // Two passes, exactly as the heatmap above and for exactly the same reason: a feature that
      // wrote a cell and then had it carved away again ends up air in the CURRENT result, and
      // buildMesh skips air before it ever calls `accept`. Meshing the baseline for those cells
      // is what keeps "this node wrote here" visible for a node whose work was later undone --
      // which is precisely the case somebody is clicking a node to understand.
      const currentBuf = buildMesh(volume, palette, {
        minY: this.sliceMinY,
        maxY: this.sliceMaxY,
        accept: (index: number) => attributionMask[index] === 1,
        colorOverride: attributionColor,
      })
      const isCurrentlyAir = (index: number): boolean => (this.paletteById.get(volume.data[index] as number)?.kind ?? 'air') === 'air'
      const baselineVolume: ViewerVolume = { ...volume, data: baseline }
      const baselineBuf = buildMesh(baselineVolume, palette, {
        minY: this.sliceMinY,
        maxY: this.sliceMaxY,
        accept: (index: number) => attributionMask[index] === 1 && isCurrentlyAir(index),
        colorOverride: attributionColor,
      })
      updateGeometry(this.attributionGeometry, concatMeshBuffers(currentBuf, baselineBuf))
    } else {
      updateGeometry(this.attributionGeometry, EMPTY_MESH_BUFFERS)
    }

    const overflowBlocks = volume.overflowBlocks
    if (this.showOverflow && overflowBlocks !== undefined && overflowBlocks.length > 0) {
      const overflowBuf = buildOverflowMesh(overflowBlocks, palette, OVERFLOW_TINT, OVERFLOW_TINT_STRENGTH)
      updateGeometry(this.overflowGeometry, overflowBuf)
    } else {
      updateGeometry(this.overflowGeometry, EMPTY_MESH_BUFFERS)
    }
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
    this.boundsBox.visible = this.showGrid
    this.scene.add(this.boundsBox)
  }

  private readonly handleKeyDown = (ev: KeyboardEvent): void => {
    const target = ev.target
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }
    switch (ev.key) {
      // Plain 'r' tightly frames what's actually occupied (see frameContent's doc comment);
      // Shift+R ('R' -- the browser already folds the modifier into ev.key for a letter, no
      // separate ev.shiftKey check needed) frames the full volume bounds instead, for seeing
      // where a feature sits relative to the box it was asked to fill.
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
    this.rafHandle = requestAnimationFrame(this.animate)
    this.controls.update()
    this.updateClipPlanes()
    this.renderer.render(this.scene, this.camera)
  }
}
