// mesher.ts -- face-culled voxel meshing. Measured at ~1% of total generation+render cost
// (19ms against 1608ms of Go-side generation for a representative volume) -- do not redesign
// this for speed, per this package's own charter.
import type { BlockKind, ViewerPaletteEntry, ViewerVolume } from './viewer.js'
import type { AtlasBlockWire, AtlasTableWire } from './protocol.js'
import { indexStatedAtlasBlocks, lookupAtlasBlock, parseHexColor } from './protocol.js'
import { tintColorForChannel } from './colors.js'
// TYPE-ONLY, and deliberately so: shapes.ts imports FACES and faceST from this file, and a
// value import back the other way would make that a runtime cycle. The shapes themselves are
// compiled by the caller (viewer.ts) and handed to compileAtlas.
import type { CompiledShape, ShapeQuad } from './shapes.js'

export interface MeshBuffers {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** Per-vertex block id, for picking/inspection by a caller. */
  blockIds: Uint32Array
  /** Per-vertex atlas texture coordinate (2 floats per vertex), or a ZERO-LENGTH array when
   * this mesh was built without an atlas -- flat-colour mode, which is still the default and
   * still what every overlay pass (carved/heatmap/overflow) uses. A consumer must branch on
   * `uvs.length > 0` rather than assuming the attribute exists; viewer.ts's `updateGeometry`
   * deletes the geometry's `uv` attribute entirely in that case, so a textured material can
   * never sample a stale buffer from a previous, textured remesh. */
  uvs: Float32Array
  quadCount: number
}

/** How many faces a cube has, and the stride of MesherAtlas' per-(id,face) tables. Faces are
 * indexed by their position in FACES below, NOT by any wire ordering -- see `FaceDef.key` for
 * the atlas-table name each index corresponds to. */
export const FACE_COUNT = 6

/**
 * The atlas, compiled down to exactly what the inner meshing loop needs: flat typed arrays
 * indexed by block id and face, with every string lookup (block name -> table entry, texture
 * key -> cell, tint channel -> colour) already resolved. viewer.ts builds one of these per
 * (atlas, palette) pair -- see `compileAtlas` below -- so that this loop, which runs
 * once per exposed face of every cell in the volume, never touches a Map or a string.
 *
 * `tintForFace` deliberately carries the FLAT PALETTE COLOUR for a block the atlas table says
 * nothing about, with that block's cells pointed at the atlas' white cell. That collapses two
 * cases into one multiply: a textured face is `texel * tint * shade`, and an unknown block is
 * `white * paletteColour * shade`, which is what flat-colour mode already draws (to within the
 * float32 rounding flat mode applies to its palette lookup and this path does not -- a gap of
 * ~4e-9, six orders of magnitude below one step of an 8-bit channel). It is why a pack's own
 * custom blocks (Piece E's territory, not yet resolved to textures) keep looking exactly as they
 * do today while everything around them gains a texture.
 */
export interface MesherAtlas {
  /** Four floats per atlas cell -- u0, v0, u1, v1, already inset (or already inside a padded
   * cell's duplicated border) so that sampling can never bleed into a neighbouring cell. `v0`
   * is the cell's TOP edge in image space: the texture is uploaded with `flipY = false`, so v
   * grows downward and matches how the atlas builder laid its rows out. */
  readonly cellUV: Float32Array
  /** `cellForFace[id * FACE_COUNT + face]` -- the atlas cell this block's face samples. */
  readonly cellForFace: Int32Array
  /** `tintForFace[id * FACE_COUNT + face]` -- packed 0xRRGGBB multiplied into the sampled
   * texel (0xffffff for an untinted vanilla face). See this interface's own doc comment for
   * why an unknown block's entry is its flat palette colour rather than white. */
  readonly tintForFace: Uint32Array
  /** `shapes[id]` -- the block's geometry when it is not a plain full cube, else null.
   *
   * Null is the common case (65 of the 99 vanilla block names a large sample of packs places, plus
   * all ten leaves) and it keeps that block on the original six-faces-of-a-cube code path,
   * byte for byte. A non-null entry replaces those six faces with the compiled quad list --
   * see shapes.ts, which also explains why this only ever exists for a textured pass. */
  readonly shapes: readonly (CompiledShape | null)[]
}

/** Which draw pass a block belongs to, compiled from the atlas table's per-block `render` mode.
 * `opaque` and `cutout` share the alpha-tested pass -- an opaque texel's alpha is 1, so the
 * alpha test never rejects it, and one pass is one draw call instead of two. */
export const PASS_ALPHA_TESTED = 0
export const PASS_TRANSLUCENT = 1

/** The atlas compiled against one specific palette: the flat tables buildMesh consumes, plus
 * the per-id pass assignment viewer.ts needs to split the geometry into an alpha-tested pass
 * and a blended one. Valid only for the palette it was built from -- block ids are interned per
 * run, so a fresh result needs a fresh compile. */
export interface CompiledAtlas {
  mesher: MesherAtlas
  /** `pass[id]` -- PASS_ALPHA_TESTED or PASS_TRANSLUCENT. */
  pass: Uint8Array
  /** Every block NAME in this palette the atlas could not fully texture -- no row at all, or a
   * row missing at least one face -- in palette order, each named once.
   *
   * Recorded because "textures are on" and "this block is textured" are different claims, and
   * only the second one is worth a sentence. An unresolved block still draws (its flat palette
   * colour, through the white cell -- see this function's own doc comment), so nothing on screen
   * distinguishes it from a block whose texture genuinely is a flat colour. A preview that
   * silently mixes the two is the one way "textures on" can mislead, so the renderer counts
   * them and lets a host say so once (viewer.ts's `getTextureReport`). Air is excluded: it is
   * never drawn, so an atlas having nothing to say about it is not a gap. */
  unresolved: readonly string[]
}

/** Per-cell UV rectangles, as `u0, v0, u1, v1` quadruples with `v0` the cell's TOP edge (the
 * texture is uploaded flipY=false, so v grows downward and matches the order the atlas builder
 * laid its rows out in).
 *
 * A cell's position comes from the table's own `x`/`y`, not from arithmetic on its index: the
 * builder is free to pack cells however it likes, and a consumer that re-derived the position
 * from cols/rows would silently drift the moment that packing changed.
 *
 * The inset is the table's if it names one, and otherwise the two schemes the contract allows,
 * chosen by whether there is a border: with duplicated edge pixels around each cell the rect is
 * the cell's exact content rectangle (a sample that rounds outward lands on a copy of the edge
 * pixel), and without one it is inset by half a texel so a corner sample is centred on the
 * outermost real texel instead of on the seam between two cells. */
function buildCellUV(table: AtlasTableWire): Float32Array {
  const inset = typeof table.inset === 'number' ? table.inset : (table.border ?? 0) > 0 ? 0 : 0.5
  const out = new Float32Array(table.cells.length * 4)
  for (let i = 0; i < table.cells.length; i++) {
    const cell = table.cells[i] as { x: number; y: number }
    out[i * 4] = (cell.x + inset) / table.width
    out[i * 4 + 1] = (cell.y + inset) / table.height
    out[i * 4 + 2] = (cell.x + table.cell - inset) / table.width
    out[i * 4 + 3] = (cell.y + table.cell - inset) / table.height
  }
  return out
}

/** The colour a face's texel is multiplied by, in the order the three sources should be trusted.
 *
 *  1. The table's own MEASURED `tint_color` for that face -- the atlas builder sampled the
 *     block's pre-tinted carried texture and worked out what multiplier reproduces vanilla's
 *     default-biome appearance. Nothing this renderer could hard-code beats a measurement.
 *  2. The channel's documented `default` in the table's `tints` map.
 *  3. colors.ts's own channel table, for a table that carries neither.
 *
 * Falling off the end is white, i.e. the texel unchanged -- which is right for the "none"
 * channel and is the least-wrong answer for a channel name newer than this renderer. The one
 * case that is knowingly imperfect is the builder's "grey" channel: it means "this texture
 * measures greyscale and nothing in the pack says what to multiply it by", so there is no
 * colour to use and the face draws grey, exactly as it does today in flat-colour mode. */
function tintForChannel(table: AtlasTableWire, block: AtlasBlockWire, face: string): number {
  const measured = parseHexColor(block.tint_color?.[face])
  if (measured !== null) return measured
  const channel = block.tint?.[face] ?? block.tint?.['*']
  if (channel === undefined || channel === 'none') return 0xffffff
  const documented = parseHexColor(table.tints?.[channel]?.default)
  if (documented !== null) return documented
  return tintColorForChannel(channel)
}

/** Resolves the atlas table against one palette into the flat per-(id, face) tables the mesher
 * indexes directly. Every string lookup in the whole textured path happens here, once per
 * (atlas, palette) pair, rather than once per exposed face.
 *
 * `white` is the cell index to use for anything the table cannot answer for. A palette entry the
 * table says nothing about -- a pack's own block, an id newer than the atlas -- is pointed at it
 * and given its FLAT palette colour as its tint, which reproduces today's flat-colour rendering
 * for that block exactly, inside the same draw call. So is an individual FACE the builder could
 * not resolve, which its `faces` map simply omits.
 *
 * The row a palette entry resolves to is its STATE-specific one when the table carries one --
 * a behaviour pack can make a block's textures depend on a block state, and the entry already
 * carries the states the engine interned it with. `lookupAtlasBlock` falls back to the block's
 * name-only row for everything else, which is every block that renders today. */
export function compileAtlas(
  table: AtlasTableWire,
  palette: readonly ViewerPaletteEntry[],
  white: number,
  shapes: readonly (CompiledShape | null)[] = [],
): CompiledAtlas {
  let maxId = 0
  for (const entry of palette) if (entry.id > maxId) maxId = entry.id
  const cellForFace = new Int32Array((maxId + 1) * FACE_COUNT).fill(white)
  const tintForFace = new Uint32Array((maxId + 1) * FACE_COUNT).fill(0xffffff)
  const pass = new Uint8Array(maxId + 1)
  const cellCount = table.cells.length
  const stated = indexStatedAtlasBlocks(table)
  const unresolved: string[] = []
  const seenUnresolved = new Set<string>()
  const noteUnresolved = (entry: ViewerPaletteEntry): void => {
    if (entry.kind === 'air' || seenUnresolved.has(entry.name)) return
    seenUnresolved.add(entry.name)
    unresolved.push(entry.name)
  }

  for (const entry of palette) {
    const block = lookupAtlasBlock(table, stated, entry.name, entry.states)
    const base = entry.id * FACE_COUNT
    if (block === undefined) {
      for (let f = 0; f < FACE_COUNT; f++) tintForFace[base + f] = entry.color
      noteUnresolved(entry)
      continue
    }
    pass[entry.id] = block.render === 'translucent' ? PASS_TRANSLUCENT : PASS_ALPHA_TESTED
    for (let f = 0; f < FACE_COUNT; f++) {
      const key = (FACES[f] as FaceDef).key
      // An absent face is the builder saying it could not resolve that texture. Drawing it with
      // the block's flat colour is the honest answer; drawing it with a neighbouring cell would
      // be a confident wrong one.
      const cell = block.faces?.[key] ?? block.faces?.['*']
      if (cell === undefined || !Number.isInteger(cell) || cell < 0 || cell >= cellCount) {
        cellForFace[base + f] = white
        tintForFace[base + f] = entry.color
        noteUnresolved(entry)
        continue
      }
      cellForFace[base + f] = cell
      tintForFace[base + f] = tintForChannel(table, block, key)
    }
  }
  return { mesher: { cellUV: buildCellUV(table), cellForFace, tintForFace, shapes }, pass, unresolved }
}

interface MesherOpts {
  minY: number
  maxY: number
  accept: (index: number, id: number) => boolean
  /** Overrides the per-cell base colour (0..1 RGB, still multiplied by the per-face shade
   * below) instead of the palette's own colour for that block id -- used by the touch-count
   * heatmap overlay (viewer.ts's setShowHeatmap), which colours by write count rather than
   * by material. */
  colorOverride?: (index: number, id: number) => readonly [number, number, number]
  /** Present only for a TEXTURED pass. Absent (the default, and what every overlay pass uses)
   * means flat-colour mode: no `uvs` are emitted at all and the vertex colour is the palette
   * colour times the per-face shade, exactly as before this file learned about textures. */
  atlas?: MesherAtlas
  /** An inclusive WORLD-space box the walk is restricted to, on top of the `[minY, maxY]` slice.
   *
   * Purely a cost control, never a visual one: a pass whose `accept` can only ever be true inside
   * a known box (the feature pass, whose cells are the run's own writes; the carved and
   * attribution overlays, likewise) has no reason to visit the rest of the bench, and on a
   * 48x48x48 bench that is the difference between visiting 110 000 cells and visiting the two
   * thousand that can answer. The geometry is IDENTICAL either way, because face culling still
   * reads neighbours straight out of `volume.data` and is bounded by the VOLUME, not by this --
   * so a face on the box's own edge is still hidden by the block outside it, exactly as before.
   *
   * Callers pass a box that genuinely contains every cell their `accept` can admit; a box that
   * is too small silently drops geometry, which is why nothing here derives one on its own (see
   * remesh.ts's `summarizeVolume`, which computes them once per result from the same arrays
   * `accept` tests). */
  bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
}

interface FaceDef {
  readonly normal: readonly [number, number, number]
  readonly u: readonly [number, number, number]
  readonly v: readonly [number, number, number]
  readonly base: readonly [number, number, number]
  readonly shade: number
  /** The name this face has in the atlas table's per-block `faces`/`tint` maps. Bedrock's own
   * spelling: up/down for +Y/-Y, and north/south/east/west for the four sides. */
  readonly key: 'east' | 'west' | 'up' | 'down' | 'south' | 'north'
  /** Where each of the four quad vertices lands inside its atlas cell, in the SAME k order the
   * meshing loop below emits them (base, base+u, base+u+v, base+v). Each entry is `[s, t]` in
   * the unit cell, `t` measured DOWNWARD from the cell's top edge.
   *
   * These are not arbitrary. For each face, take a viewer outside the cube looking straight at
   * it with the block's top upward (for +Y/-Y, with north -- -Z -- upward, which is the
   * convention every top-down Minecraft texture is authored to); `s` runs along that viewer's
   * right, `t` along their down. Get one of them backwards and the geometry still meshes, the
   * tests still pass, and every asymmetric texture in the game renders mirrored. */
  readonly uv: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]]
  /** The same mapping as `uv`, as a rule rather than four corners: `[sAxis, sSign, tAxis, tSign]`,
   * where axis 0/1/2 is x/y/z and a sign of -1 means the coordinate runs backwards. See `faceST`.
   *
   * `uv` answers "where does corner k of a FULL cube face land"; this answers "where does an
   * ARBITRARY point on this face land", which is what a shape smaller than the cell needs -- a
   * carpet's north face is the bottom row of its texture, a torch's is the middle two columns.
   * The two are the same statement, and `faceST` is asserted against `uv` at all four corners of
   * every face precisely so they can never drift apart. */
  readonly st: readonly [number, number, number, number]
}

/** Where a point on face `face` of the unit cube lands inside that face's atlas cell: `[s, t]`
 * in the unit cell, `t` measured DOWNWARD from the cell's top edge, matching `FaceDef.uv`.
 *
 * Compile-time only (shapes.ts calls it once per quad corner when it builds a shape); the
 * meshing loop consumes the precomputed result and never calls this. */
export function faceST(face: number, x: number, y: number, z: number): [number, number] {
  const def = FACES[face] as FaceDef
  const p = [x, y, z] as const
  const s = p[def.st[0] as 0 | 1 | 2] as number
  const t = p[def.st[2] as 0 | 1 | 2] as number
  return [def.st[1] > 0 ? s : 1 - s, def.st[3] > 0 ? t : 1 - t]
}

// Per-face shading baked into vertex colours: top brightest, N/S sides, E/W sides, bottom
// darkest. Bedrock convention: X is east/west, Z is north/south.
const SHADE_TOP = 1.0
const SHADE_NORTH_SOUTH = 0.86
const SHADE_EAST_WEST = 0.72
const SHADE_BOTTOM = 0.58

/** The one zero-length UV array a flat-colour pass hands back -- shared rather than allocated
 * per call, since it is never written to. */
const EMPTY_UVS = new Float32Array(0)

// Each face is a base corner of the unit cube plus two tangent vectors (u, v) with u x v ==
// normal, guaranteeing counter-clockwise winding (viewed from outside the cube) for the
// [base, base+u, base+u+v, base+v] vertex quad.
export const FACES: readonly FaceDef[] = [
  // +X east: quad corners (y0z0, y1z0, y1z1, y0z1); looking west, right is -Z and down is -Y.
  { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], base: [1, 0, 0], shade: SHADE_EAST_WEST, key: 'east', uv: [[1, 1], [1, 0], [0, 0], [0, 1]], st: [2, -1, 1, -1] },
  // -X west: quad corners (z0y0, z1y0, z1y1, z0y1); looking east, right is +Z and down is -Y.
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], base: [0, 0, 0], shade: SHADE_EAST_WEST, key: 'west', uv: [[0, 1], [1, 1], [1, 0], [0, 0]], st: [2, 1, 1, -1] },
  // +Y top: quad corners (x0z0, x0z1, x1z1, x1z0); looking down with north up, right is +X and
  // down is +Z.
  { normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], base: [0, 1, 0], shade: SHADE_TOP, key: 'up', uv: [[0, 0], [0, 1], [1, 1], [1, 0]], st: [0, 1, 2, 1] },
  // -Y bottom: quad corners (x0z0, x1z0, x1z1, x0z1); looking UP with north still up, right is
  // -X (the mirror of the top face) and down is +Z.
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], base: [0, 0, 0], shade: SHADE_BOTTOM, key: 'down', uv: [[1, 0], [0, 0], [0, 1], [1, 1]], st: [0, -1, 2, 1] },
  // +Z south: quad corners (x0y0, x1y0, x1y1, x0y1); looking north, right is +X and down is -Y.
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], base: [0, 0, 1], shade: SHADE_NORTH_SOUTH, key: 'south', uv: [[0, 1], [1, 1], [1, 0], [0, 0]], st: [0, 1, 1, -1] },
  // -Z north: quad corners (x0y0, x0y1, x1y1, x1y0); looking south, right is -X and down is -Y.
  { normal: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0], base: [0, 0, 0], shade: SHADE_NORTH_SOUTH, key: 'north', uv: [[1, 1], [1, 0], [0, 0], [0, 1]], st: [0, -1, 1, -1] },
]

/** Whether a face against `neighborKind` should be culled for a `currentKind` block. Answers
 * only the MATERIAL half of the question; whether the neighbour actually fills its cell is
 * `fillsCell` in buildMesh, and both have to be true for a face to be hidden. */
function occludes(neighborKind: BlockKind, currentKind: BlockKind): boolean {
  if (neighborKind === 'solid') return true
  // Hide internal faces between two liquid cells (e.g. the body of a lake) but keep the
  // liquid's boundary faces against everything else visible.
  if (neighborKind === 'liquid' && currentKind === 'liquid') return true
  return false
}

/**
 * Build face-culled geometry for the cells in `volume` matching `opts.accept`, restricted to
 * the `[opts.minY, opts.maxY]` world-Y slice. A face is only culled when its neighbour is
 * both in-bounds, inside the slice, and opaque relative to the current block -- so slicing
 * exposes interior faces, exactly like the neighbour being removed would.
 */
export function buildMesh(volume: ViewerVolume, palette: readonly ViewerPaletteEntry[], opts: MesherOpts): MeshBuffers {
  const { minX, minY: volMinY, minZ, sizeX, sizeY, sizeZ, data } = volume
  const { minY: sliceMinY, maxY: sliceMaxY, accept, colorOverride, atlas, bounds } = opts

  let maxId = 0
  for (const entry of palette) if (entry.id > maxId) maxId = entry.id
  const kindById: BlockKind[] = new Array(maxId + 1).fill('air')
  const colorR = new Float32Array(maxId + 1)
  const colorG = new Float32Array(maxId + 1)
  const colorB = new Float32Array(maxId + 1)
  for (const entry of palette) {
    kindById[entry.id] = entry.kind
    colorR[entry.id] = ((entry.color >> 16) & 0xff) / 255
    colorG[entry.id] = ((entry.color >> 8) & 0xff) / 255
    colorB[entry.id] = (entry.color & 0xff) / 255
  }

  // Which ids actually FILL their cell, and may therefore hide a neighbour's face. Everything
  // does until a block is drawn to a non-cube shape: a torch that still occluded would leave a
  // block-shaped hole in the wall behind it, and a cross-shaped plant would hide the ground it
  // stands on. A rotated full cube still fills its cell and still occludes (shapes.ts's
  // CompiledShape.fills). In flat-colour mode there are no shapes, every entry stays 1, and
  // this is exactly the test that was here before.
  const fillsCell = new Uint8Array(maxId + 1).fill(1)
  if (atlas !== undefined) {
    for (let id = 0; id <= maxId; id++) {
      const shape = atlas.shapes[id]
      if (shape !== undefined && shape !== null && !shape.fills) fillsCell[id] = 0
    }
  }

  const layerStride = sizeX * sizeZ

  let vertCap = 4096
  let positions = new Float32Array(vertCap * 3)
  let normals = new Float32Array(vertCap * 3)
  let colors = new Float32Array(vertCap * 3)
  let blockIds = new Uint32Array(vertCap)
  // Allocated only for a textured pass -- a flat-colour pass pays nothing for a feature it does
  // not use, and hands back the zero-length array MeshBuffers.uvs documents.
  let uvs = atlas !== undefined ? new Float32Array(vertCap * 2) : EMPTY_UVS
  let indexCap = 6144
  let indices = new Uint32Array(indexCap)
  let vertCount = 0
  let indexCount = 0
  let quadCount = 0

  function ensureVertCap(extra: number): void {
    if (vertCount + extra <= vertCap) return
    while (vertCount + extra > vertCap) vertCap *= 2
    const p = new Float32Array(vertCap * 3)
    p.set(positions.subarray(0, vertCount * 3))
    positions = p
    const n = new Float32Array(vertCap * 3)
    n.set(normals.subarray(0, vertCount * 3))
    normals = n
    const c = new Float32Array(vertCap * 3)
    c.set(colors.subarray(0, vertCount * 3))
    colors = c
    const b = new Uint32Array(vertCap)
    b.set(blockIds.subarray(0, vertCount))
    blockIds = b
    if (atlas !== undefined) {
      const t = new Float32Array(vertCap * 2)
      t.set(uvs.subarray(0, vertCount * 2))
      uvs = t
    }
  }

  function ensureIndexCap(extra: number): void {
    if (indexCount + extra <= indexCap) return
    while (indexCount + extra > indexCap) indexCap *= 2
    const i = new Uint32Array(indexCap)
    i.set(indices.subarray(0, indexCount))
    indices = i
  }

  // The walked window: the slice, the volume, and -- when the caller named one -- `opts.bounds`,
  // all intersected. Every one of the three is inclusive in world coordinates, and the result is
  // converted to local indices once here rather than tested per cell.
  const loY = Math.max(sliceMinY, volMinY, bounds ? bounds.minY : -Infinity)
  const hiY = Math.min(sliceMaxY, volMinY + sizeY - 1, bounds ? bounds.maxY : Infinity)
  const loZ = Math.max(0, bounds ? bounds.minZ - minZ : 0)
  const hiZ = Math.min(sizeZ - 1, bounds ? bounds.maxZ - minZ : sizeZ - 1)
  const loX = Math.max(0, bounds ? bounds.minX - minX : 0)
  const hiX = Math.min(sizeX - 1, bounds ? bounds.maxX - minX : sizeX - 1)

  for (let ly = loY - volMinY; ly <= hiY - volMinY; ly++) {
    const wy = volMinY + ly
    for (let lz = loZ; lz <= hiZ; lz++) {
      const wz = minZ + lz
      const rowBase = ly * layerStride + lz * sizeX
      for (let lx = loX; lx <= hiX; lx++) {
        const wx = minX + lx
        const index = rowBase + lx
        const id = data[index] as number
        const kind = kindById[id] ?? 'air'
        if (kind === 'air') continue
        if (!accept(index, id)) continue

        const override = colorOverride?.(index, id)
        const r = override ? override[0] : (colorR[id] ?? 0)
        const g = override ? override[1] : (colorG[id] ?? 0)
        const b = override ? override[2] : (colorB[id] ?? 0)

        // A block the atlas gives a SHAPE to (shapes.ts -- a cross-shaped plant, a carpet, a
        // torch, a log turned onto its side) draws that shape's compiled quads instead of the
        // six faces of a cube. Everything else -- which is most blocks, and everything at all
        // in flat-colour mode -- takes the original path below, unchanged.
        const shape = atlas !== undefined ? (atlas.shapes[id] ?? null) : null
        if (shape !== null && atlas !== undefined) {
          for (let qi = 0; qi < shape.quads.length; qi++) {
            const q = shape.quads[qi] as ShapeQuad
            // Only a quad flush with the cell boundary can be hidden, and then only by the
            // neighbour in its own direction -- see ShapeQuad.cull.
            if (q.cull >= 0) {
              const cf = FACES[q.cull] as FaceDef
              const nx = lx + cf.normal[0]
              const ny = ly + cf.normal[1]
              const nz = lz + cf.normal[2]
              const nwy = wy + cf.normal[1]
              if (nx >= 0 && nx < sizeX && ny >= 0 && ny < sizeY && nz >= 0 && nz < sizeZ && nwy >= sliceMinY && nwy <= sliceMaxY) {
                const nId = data[ny * layerStride + nz * sizeX + nx] as number
                if (fillsCell[nId] === 1 && occludes(kindById[nId] ?? 'air', kind)) continue
              }
            }

            ensureVertCap(4)
            ensureIndexCap(6)
            const baseIndex = vertCount

            let br = r
            let bg = g
            let bb = b
            if (override === undefined) {
              const tint = atlas.tintForFace[id * FACE_COUNT + q.face] ?? 0xffffff
              br = ((tint >> 16) & 0xff) / 255
              bg = ((tint >> 8) & 0xff) / 255
              bb = (tint & 0xff) / 255
            }
            const cell4 = (atlas.cellForFace[id * FACE_COUNT + q.face] ?? 0) * 4
            const u0 = atlas.cellUV[cell4] ?? 0
            const v0 = atlas.cellUV[cell4 + 1] ?? 0
            const uSpan = (atlas.cellUV[cell4 + 2] ?? 0) - u0
            const vSpan = (atlas.cellUV[cell4 + 3] ?? 0) - v0
            const fr = br * q.shade
            const fg = bg * q.shade
            const fb = bb * q.shade

            for (let k = 0; k < 4; k++) {
              const vi = vertCount
              const p3 = vi * 3
              positions[p3] = wx + (q.pos[k * 3] as number)
              positions[p3 + 1] = wy + (q.pos[k * 3 + 1] as number)
              positions[p3 + 2] = wz + (q.pos[k * 3 + 2] as number)
              normals[p3] = q.nx
              normals[p3 + 1] = q.ny
              normals[p3 + 2] = q.nz
              colors[p3] = fr
              colors[p3 + 1] = fg
              colors[p3 + 2] = fb
              blockIds[vi] = id
              uvs[vi * 2] = u0 + uSpan * (q.st[k * 2] as number)
              uvs[vi * 2 + 1] = v0 + vSpan * (q.st[k * 2 + 1] as number)
              vertCount++
            }

            indices[indexCount++] = baseIndex
            indices[indexCount++] = baseIndex + 1
            indices[indexCount++] = baseIndex + 2
            indices[indexCount++] = baseIndex
            indices[indexCount++] = baseIndex + 2
            indices[indexCount++] = baseIndex + 3
            quadCount++
          }
          continue
        }

        // Indexed rather than for-of purely because a textured pass needs the face's INDEX to
        // reach into MesherAtlas' per-(id, face) tables; the body is otherwise unchanged.
        for (let f = 0; f < FACES.length; f++) {
          const face = FACES[f] as FaceDef
          const nx = lx + face.normal[0]
          const ny = ly + face.normal[1]
          const nz = lz + face.normal[2]
          const nwy = wy + face.normal[1]

          const inBounds = nx >= 0 && nx < sizeX && ny >= 0 && ny < sizeY && nz >= 0 && nz < sizeZ
          const inSlice = nwy >= sliceMinY && nwy <= sliceMaxY

          if (inBounds && inSlice) {
            const nIndex = ny * layerStride + nz * sizeX + nx
            const nId = data[nIndex] as number
            const neighborKind = kindById[nId] ?? 'air'
            if (fillsCell[nId] === 1 && occludes(neighborKind, kind)) continue
          }

          ensureVertCap(4)
          ensureIndexCap(6)
          const baseIndex = vertCount

          // Flat mode: the block's own colour. Textured mode: the face's TINT channel, which
          // is white for an ordinary vanilla face, a biome colour for a greyscale-baked one,
          // and the block's flat palette colour for a block the atlas table doesn't describe
          // (see MesherAtlas' doc comment). An explicit colorOverride -- the heatmap -- still
          // wins over both: that overlay colours by write count, not by material, and a
          // textured heatmap would defeat its entire purpose.
          let br = r
          let bg = g
          let bb = b
          let u0 = 0
          let v0 = 0
          let uSpan = 0
          let vSpan = 0
          if (atlas !== undefined) {
            if (override === undefined) {
              const tint = atlas.tintForFace[id * FACE_COUNT + f] ?? 0xffffff
              br = ((tint >> 16) & 0xff) / 255
              bg = ((tint >> 8) & 0xff) / 255
              bb = (tint & 0xff) / 255
            }
            const cell4 = (atlas.cellForFace[id * FACE_COUNT + f] ?? 0) * 4
            u0 = atlas.cellUV[cell4] ?? 0
            v0 = atlas.cellUV[cell4 + 1] ?? 0
            uSpan = (atlas.cellUV[cell4 + 2] ?? 0) - u0
            vSpan = (atlas.cellUV[cell4 + 3] ?? 0) - v0
          }

          const fr = br * face.shade
          const fg = bg * face.shade
          const fb = bb * face.shade

          for (let k = 0; k < 4; k++) {
            let ox = face.base[0]
            let oy = face.base[1]
            let oz = face.base[2]
            if (k === 1) {
              ox += face.u[0]
              oy += face.u[1]
              oz += face.u[2]
            } else if (k === 2) {
              ox += face.u[0] + face.v[0]
              oy += face.u[1] + face.v[1]
              oz += face.u[2] + face.v[2]
            } else if (k === 3) {
              ox += face.v[0]
              oy += face.v[1]
              oz += face.v[2]
            }
            const vi = vertCount
            const p3 = vi * 3
            positions[p3] = wx + ox
            positions[p3 + 1] = wy + oy
            positions[p3 + 2] = wz + oz
            normals[p3] = face.normal[0]
            normals[p3 + 1] = face.normal[1]
            normals[p3 + 2] = face.normal[2]
            colors[p3] = fr
            colors[p3 + 1] = fg
            colors[p3 + 2] = fb
            blockIds[vi] = id
            if (atlas !== undefined) {
              const corner = face.uv[k] as readonly [number, number]
              uvs[vi * 2] = u0 + uSpan * corner[0]
              uvs[vi * 2 + 1] = v0 + vSpan * corner[1]
            }
            vertCount++
          }

          indices[indexCount++] = baseIndex
          indices[indexCount++] = baseIndex + 1
          indices[indexCount++] = baseIndex + 2
          indices[indexCount++] = baseIndex
          indices[indexCount++] = baseIndex + 2
          indices[indexCount++] = baseIndex + 3
          quadCount++
        }
      }
    }
  }

  return {
    positions: positions.subarray(0, vertCount * 3),
    normals: normals.subarray(0, vertCount * 3),
    colors: colors.subarray(0, vertCount * 3),
    indices: indices.subarray(0, indexCount),
    blockIds: blockIds.subarray(0, vertCount),
    uvs: atlas !== undefined ? uvs.subarray(0, vertCount * 2) : EMPTY_UVS,
    quadCount,
  }
}


/**
 * Concatenates two `MeshBuffers` into one (vertex/index offsets shifted for `b`). Used to
 * combine passes that must share one draw call.
 */
export function concatMeshBuffers(a: MeshBuffers, b: MeshBuffers): MeshBuffers {
  if (a.positions.length === 0) return b
  if (b.positions.length === 0) return a
  const vertOffset = a.positions.length / 3
  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions)
  positions.set(b.positions, a.positions.length)
  const normals = new Float32Array(a.normals.length + b.normals.length)
  normals.set(a.normals)
  normals.set(b.normals, a.normals.length)
  const colors = new Float32Array(a.colors.length + b.colors.length)
  colors.set(a.colors)
  colors.set(b.colors, a.colors.length)
  const blockIds = new Uint32Array(a.blockIds.length + b.blockIds.length)
  blockIds.set(a.blockIds)
  blockIds.set(b.blockIds, a.blockIds.length)
  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices)
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = (b.indices[i] as number) + vertOffset
  // UVs only exist if at least one side was meshed with an atlas. A mixed concatenation (one
  // textured side, one not) is not something any caller does today, but silently producing a
  // uv array SHORTER than the vertex count would be a buffer-overrun-shaped bug in the GPU
  // upload rather than a visible one, so the untextured side is zero-filled to its full width
  // instead. Cell (0,0) of an atlas is a real cell, so those faces sample it -- wrong, but
  // wrong and drawn, not wrong and crashing.
  const uvVerts = (positions.length / 3) * 2
  let uvs = EMPTY_UVS
  if (a.uvs.length > 0 || b.uvs.length > 0) {
    uvs = new Float32Array(uvVerts)
    uvs.set(a.uvs.subarray(0, Math.min(a.uvs.length, vertOffset * 2)))
    uvs.set(b.uvs.subarray(0, Math.min(b.uvs.length, (b.positions.length / 3) * 2)), vertOffset * 2)
  }
  return { positions, normals, colors, indices, blockIds, uvs, quadCount: a.quadCount + b.quadCount }
}

/** One out-of-bounds block captured by the engine's overflow store (session.Result.
 * OverflowBlocks, volume.Volume.Overflow) -- world position PLUS the block id that would have
 * been written, had the bench been big enough to hold it. See ViewerVolume.overflowBlocks'
 * own doc comment (viewer.ts) for why this can't share `data`'s flat cell-index scheme: an
 * overflow position is by definition outside [minX,minX+sizeX) etc. */
export interface OverflowBlockMesh {
  x: number
  y: number
  z: number
  id: number
}

/**
 * Builds geometry for out-of-bounds captured blocks (see OverflowBlockMesh) -- unlike buildMesh
 * above, these are NOT indexed into a volume grid (a captured position sits outside the bench by
 * definition), so this walks the block list directly rather than a [minY,maxY] slice, and draws
 * every face of every block unconditionally: there is no volume-wide occlusion structure to test
 * a neighbour against, and overflow spillage is typically sparse enough that the extra interior faces of an occasional adjacent pair cost
 * nothing worth optimizing for.
 *
 * Each block's colour is the actual palette colour for its id, blended toward `tint` by
 * `tintStrength` (0 = the block's own real colour, 1 = flat `tint`) -- the same
 * "recognizable material, unmistakably marked" idea VoxelViewer's heatmap overlay uses via
 * buildMesh's own colorOverride, just computed once per block here instead of per-cell.
 */
export function buildOverflowMesh(blocks: readonly OverflowBlockMesh[], palette: readonly ViewerPaletteEntry[], tint: readonly [number, number, number], tintStrength: number): MeshBuffers {
  const colorById = new Map<number, readonly [number, number, number]>()
  for (const entry of palette) {
    colorById.set(entry.id, [((entry.color >> 16) & 0xff) / 255, ((entry.color >> 8) & 0xff) / 255, (entry.color & 0xff) / 255])
  }
  // Palette miss (an id decodeGenerateResult somehow didn't see in `palette`) falls back to the
  // tint colour itself rather than black -- an overflow block should never render as a void
  // silhouette just because its material lookup failed.
  const fallback: readonly [number, number, number] = tint

  const faceCount = blocks.length * FACES.length
  const positions = new Float32Array(faceCount * 4 * 3)
  const normals = new Float32Array(faceCount * 4 * 3)
  const colors = new Float32Array(faceCount * 4 * 3)
  const blockIds = new Uint32Array(faceCount * 4)
  const indices = new Uint32Array(faceCount * 6)
  let vertCount = 0
  let indexCount = 0

  for (const block of blocks) {
    const base = colorById.get(block.id) ?? fallback
    const r0 = base[0] * (1 - tintStrength) + tint[0] * tintStrength
    const g0 = base[1] * (1 - tintStrength) + tint[1] * tintStrength
    const b0 = base[2] * (1 - tintStrength) + tint[2] * tintStrength

    for (const face of FACES) {
      const baseIndex = vertCount
      const fr = r0 * face.shade
      const fg = g0 * face.shade
      const fb = b0 * face.shade
      for (let k = 0; k < 4; k++) {
        let ox = face.base[0]
        let oy = face.base[1]
        let oz = face.base[2]
        if (k === 1) {
          ox += face.u[0]
          oy += face.u[1]
          oz += face.u[2]
        } else if (k === 2) {
          ox += face.u[0] + face.v[0]
          oy += face.u[1] + face.v[1]
          oz += face.u[2] + face.v[2]
        } else if (k === 3) {
          ox += face.v[0]
          oy += face.v[1]
          oz += face.v[2]
        }
        const p3 = vertCount * 3
        positions[p3] = block.x + ox
        positions[p3 + 1] = block.y + oy
        positions[p3 + 2] = block.z + oz
        normals[p3] = face.normal[0]
        normals[p3 + 1] = face.normal[1]
        normals[p3 + 2] = face.normal[2]
        colors[p3] = fr
        colors[p3 + 1] = fg
        colors[p3 + 2] = fb
        blockIds[vertCount] = block.id
        vertCount++
      }
      indices[indexCount++] = baseIndex
      indices[indexCount++] = baseIndex + 1
      indices[indexCount++] = baseIndex + 2
      indices[indexCount++] = baseIndex
      indices[indexCount++] = baseIndex + 2
      indices[indexCount++] = baseIndex + 3
    }
  }

  // No UVs: the out-of-bounds overlay is deliberately flat-coloured even when the rest of the
  // preview is textured -- its whole job is to read as unmistakably NOT ordinary geometry (see
  // OVERFLOW_TINT in viewer.ts), which a texture would undo.
  return { positions, normals, colors, indices, blockIds, uvs: EMPTY_UVS, quadCount: faceCount }
}

/** Zero-length geometry buffers -- for clearing a mesh (e.g. the carved overlay when toggled
 * off or the current volume has nothing carved). */
export const EMPTY_MESH_BUFFERS: MeshBuffers = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  blockIds: new Uint32Array(0),
  uvs: EMPTY_UVS,
  quadCount: 0,
}
