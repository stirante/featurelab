// shapes.ts -- what a block's geometry IS, and which block states change it.
//
// The preview draws every block as a full cube. That is right for most of them and wrong for
// the ones a reader most wants to identify: a sapling drawn as a cube of sapling texture reads
// as a solid green block, not a plant.
//
// MEASURED FIRST, then built. Over a large sample of real packs and the public fixture
// pack, the block names actually placed break down into 65 full cubes, 20 cross-shaped plants,
// 10 leaves (a cube, but cutout and biome-tinted, which the atlas already handles), one vine,
// one carpet, one torch and one cactus. There is not a single slab, stair, fence, wall, pane,
// door or trapdoor in the whole sample. So this is five non-cube shapes and a full-cube
// fallback, not a general shape system: anything this table does not name renders exactly as it
// does today, which is never worse than today.
//
// TWO AXES, deliberately not conflated:
//
//   - SHAPE is geometry, and it is a table of unit-cube-relative boxes plus a cross primitive.
//   - STATE mostly changes texture MAPPING, not geometry. `pillar_axis` turns an oak log's end
//     grain onto a different pair of faces; that is in scope and visible in the fixture pack.
//     A slab's `top_slot_bit` and a stair's `weirdo_direction` are not, because nothing places
//     one. See `rotationForStates` for the full list of what is and is not driven.
//
// SHAPES RIDE WITH THE ATLAS, and that is forced rather than chosen: every committed wiki image
// and every apps/vscode/docs/panel-*.png renders in flat-colour mode, and none of them may move
// as a side effect of this work. A shaped flat-colour pass would move all of them. So
// `compileShapes` is only ever called for a textured pass, and flat mode draws the cubes it has
// always drawn.
//
// THE VOCABULARY IS SHARED WITH block/render.go (Piece E), which classifies a PACK-defined
// block's `minecraft:geometry` into `full_block` / `cross` / `unsupported`. Those three names
// mean the same things here, `unsupported` resolving to a full cube exactly as E's own note
// says it does, so a pack block declaring `minecraft:geometry.cross` and a vanilla sapling take
// the identical path through the renderer. `layer`/`attached`/`torch`/`cactus` are this file's
// own additions, for vanilla shapes Bedrock has no built-in geometry name for.
import { FACES, FACE_COUNT, faceST } from './mesher.js'
import { indexStatedAtlasBlocks, lookupAtlasBlock } from './protocol.js'
import type { AtlasTableWire } from './protocol.js'
import type { ViewerPaletteEntry } from './viewer.js'

/** Every shape this renderer draws. The first three names are Bedrock's own, and mean here
 * exactly what `block/render.go`'s `ShapeFullBlock` / `ShapeCross` / `ShapeUnsupported` mean
 * there -- `unsupported` is a block whose real geometry is a resource-pack model, drawn as a
 * textured full cube because drawing a model is out of scope. */
export type BlockShape = 'full_block' | 'cross' | 'unsupported' | 'layer' | 'attached' | 'torch' | 'cactus'

/** One quad of a compiled shape, in unit-cube space, ready for the meshing loop to translate to
 * a world cell. Everything a shaped quad needs that a cube face gets from `FACES` is resolved
 * here, once per (block, states) pair, rather than per cell. */
export interface ShapeQuad {
  /** 12 floats: four corners x/y/z, in the SAME order the meshing loop emits them. */
  readonly pos: Float32Array
  /** 8 floats: four `[s, t]` pairs in unit CELL space, `t` downward -- where each corner lands
   * inside whichever atlas cell `face` selects. */
  readonly st: Float32Array
  readonly nx: number
  readonly ny: number
  readonly nz: number
  /** Baked into the vertex colour, exactly as `FaceDef.shade` is for a cube. */
  readonly shade: number
  /** Which of the six per-(id, face) atlas entries supplies this quad's cell and tint. NOT
   * necessarily the direction the quad faces: a rotated log's east quad reads the `up` entry
   * (that is what puts end grain on the right faces), and a grass block's dirt underlay reads
   * the `down` entry while facing north. */
  readonly face: number
  /** The FACES index whose neighbour hides this quad, or -1 for a quad no neighbour can hide.
   * A quad is cullable only when it lies flush with the unit cube's boundary -- a carpet's
   * underside is, its top is not, and a cross plane never is. */
  readonly cull: number
}

/** A block's geometry, compiled against its own block states. */
export interface CompiledShape {
  readonly quads: readonly ShapeQuad[]
  /** Whether this block still fills its whole cell, and may therefore hide a neighbour's face.
   * A rotated full cube does; a cross, a carpet, a torch and a cactus do not. Getting this
   * wrong is invisible in a test and glaring on screen: a torch that still occludes leaves a
   * block-shaped hole in the wall behind it. */
  readonly fills: boolean
}

const FACE_INDEX: Readonly<Record<string, number>> = Object.fromEntries(FACES.map((f, i) => [f.key, i]))
const F_EAST = FACE_INDEX['east'] as number
const F_WEST = FACE_INDEX['west'] as number
const F_UP = FACE_INDEX['up'] as number
const F_DOWN = FACE_INDEX['down'] as number
const F_SOUTH = FACE_INDEX['south'] as number
const F_NORTH = FACE_INDEX['north'] as number

// --- the shape table ------------------------------------------------------------------------

/** A unit-cube-relative box, in Minecraft's own sixteenths. `from`/`to` are inclusive corners:
 * `[0,0,0]..[16,16,16]` is the full cube. */
interface ShapeBox {
  readonly from: readonly [number, number, number]
  readonly to: readonly [number, number, number]
}

/** The four box shapes, straight out of vanilla's own models.
 *
 * A box face's UVs are DERIVED from where the box sits inside the cell, which is the rule
 * vanilla's own model format uses when an element names no explicit uv: a carpet's north face
 * is the bottom row of the wool texture, and a torch's is the middle two columns from its head
 * down, which is what makes a torch look like a torch rather than like a squashed whole
 * texture. See `boxQuads`. */
const SHAPE_BOXES: Readonly<Record<'full_block' | 'layer' | 'torch' | 'cactus', ShapeBox>> = {
  full_block: { from: [0, 0, 0], to: [16, 16, 16] },
  // Carpet and its relatives: one sixteenth thick, resting on the floor.
  layer: { from: [0, 0, 0], to: [16, 1, 16] },
  // Vanilla's torch post. The head is not modelled -- vanilla does not model it either; the
  // flame is part of the texture.
  torch: { from: [7, 0, 7], to: [9, 10, 9] },
  // A cactus is a full-height column inset one texel on all four sides, which is why a cactus
  // never merges with the block beside it.
  cactus: { from: [1, 0, 1], to: [15, 16, 15] },
}

/** How far, in blocks, a vine's sheet sits inside the face it clings to. Vanilla's own offset. */
const ATTACHED_OFFSET = 1 / 16

/** Where a cross plane's diagonal starts and ends, in blocks. Vanilla insets the diagonal
 * slightly (0.8 .. 15.2 of 16) rather than running it corner to corner, so a plant never pokes
 * into the cell beside it. */
const CROSS_INSET = 0.8 / 16

/** Cross planes carry no directional shading. Vanilla renders a cross model at full brightness
 * -- the four-level face shading this renderer bakes is a cube affordance, and applying a side
 * face's 0.86 to both planes of a plant just makes every plant uniformly darker without telling
 * the eye anything. The scene's own directional light still separates the two planes. */
const CROSS_SHADE = 1

/** Block names whose geometry is not a full cube. Names only -- no pattern is applied to a
 * name this table does not list, because a suffix rule that catches `oak_sapling` also catches
 * anything else ending in `_sapling` that a pack invents, and a wrong shape is louder than a
 * cube.
 *
 * Every entry is a name the measurement above found in the sample or the fixture pack, or a
 * sibling of one in the same vanilla family (all sixteen wool carpets, all the tulips) -- a
 * family is listed whole because listing half of one produces a preview where two flowers side
 * by side are drawn differently. */
const BLOCK_SHAPES: Readonly<Record<string, BlockShape>> = Object.fromEntries([
  // -- cross: saplings ------------------------------------------------------------------------
  ...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'pale_oak'].map((s) => [`minecraft:${s}_sapling`, 'cross'] as const),
  ['minecraft:sapling', 'cross'],
  ['minecraft:bamboo_sapling', 'cross'],
  ['minecraft:mangrove_propagule', 'cross'],
  // -- cross: flowers -------------------------------------------------------------------------
  ...[
    'dandelion',
    'poppy',
    'blue_orchid',
    'allium',
    'azure_bluet',
    'red_tulip',
    'orange_tulip',
    'white_tulip',
    'pink_tulip',
    'oxeye_daisy',
    'cornflower',
    'lily_of_the_valley',
    'wither_rose',
    'torchflower',
    'sunflower',
    'lilac',
    'rose_bush',
    'peony',
    'pitcher_plant',
    'red_flower',
    'yellow_flower',
    'double_plant',
  ].map((s) => [`minecraft:${s}`, 'cross'] as const),
  // -- cross: grass, ferns, bushes -------------------------------------------------------------
  // NOTE `minecraft:grass` is deliberately absent: in Bedrock that name is the grass BLOCK, and
  // block/aliases.go resolves it to minecraft:grass_block before the palette ever sees it. The
  // plant is `short_grass` (`tallgrass` on older packs).
  ...['short_grass', 'tallgrass', 'tall_grass', 'fern', 'large_fern', 'deadbush', 'dead_bush', 'bush', 'firefly_bush', 'seagrass', 'sea_pickle'].map(
    (s) => [`minecraft:${s}`, 'cross'] as const,
  ),
  // -- cross: mushrooms and nether growth ------------------------------------------------------
  ...['brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots', 'nether_sprouts'].map(
    (s) => [`minecraft:${s}`, 'cross'] as const,
  ),
  // -- cross: coral ----------------------------------------------------------------------------
  ...['tube', 'brain', 'bubble', 'fire', 'horn'].flatMap(
    (s) =>
      [
        [`minecraft:${s}_coral`, 'cross'],
        [`minecraft:dead_${s}_coral`, 'cross'],
      ] as const,
  ),
  ['minecraft:coral', 'cross'],
  // -- cross: stalks and hanging growth --------------------------------------------------------
  ...[
    'kelp',
    'kelp_plant',
    'sugar_cane',
    'reeds',
    'bamboo',
    'cave_vines',
    'cave_vines_body_with_berries',
    'cave_vines_head_with_berries',
    'twisting_vines',
    'weeping_vines',
    'hanging_roots',
  ].map((s) => [`minecraft:${s}`, 'cross'] as const),
  // -- cross: crops ----------------------------------------------------------------------------
  // A vanilla crop is four parallel planes rather than two crossed ones, and the difference is
  // not visible at the scale this preview draws. `growth`/`age` picks a different texture frame
  // and is NOT driven -- see rotationForStates.
  ...['wheat', 'carrots', 'potatoes', 'beetroot', 'nether_wart', 'torchflower_crop', 'pitcher_crop'].map((s) => [`minecraft:${s}`, 'cross'] as const),
  // -- layer: carpets --------------------------------------------------------------------------
  ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(
    (s) => [`minecraft:${s}_carpet`, 'layer'] as const,
  ),
  ...['carpet', 'moss_carpet', 'pale_moss_carpet', 'pink_petals'].map((s) => [`minecraft:${s}`, 'layer'] as const),
  // -- attached: vine --------------------------------------------------------------------------
  ['minecraft:vine', 'attached'],
  // -- torch ------------------------------------------------------------------------------------
  ...['torch', 'soul_torch', 'redstone_torch', 'unlit_redstone_torch', 'underwater_torch'].map((s) => [`minecraft:${s}`, 'torch'] as const),
  // -- cactus -----------------------------------------------------------------------------------
  ['minecraft:cactus', 'cactus'],
]) as Readonly<Record<string, BlockShape>>

/** The shape to draw `name` as.
 *
 * `declared` is the atlas table's own per-block `shape`, which is where a PACK-defined block's
 * classification arrives from `block/render.go` -- a pack that says `minecraft:geometry.cross`
 * gets a cross here without this file having heard of the block. It wins over the vanilla name
 * table, because the pack is the authority on its own blocks. Anything unrecognised, including
 * E's `unsupported`, is a full cube. */
export function shapeForBlock(name: string, declared?: string): BlockShape {
  if (declared !== undefined && declared !== 'unsupported' && declared in SHAPE_BUILDERS) return declared as BlockShape
  return BLOCK_SHAPES[name] ?? 'full_block'
}

// --- compiling one shape --------------------------------------------------------------------

function quad(
  corners: readonly (readonly [number, number, number])[],
  st: readonly (readonly [number, number])[],
  normal: readonly [number, number, number],
  shade: number,
  face: number,
  cull: number,
): ShapeQuad {
  const pos = new Float32Array(12)
  const uv = new Float32Array(8)
  for (let k = 0; k < 4; k++) {
    const c = corners[k] as readonly [number, number, number]
    pos[k * 3] = c[0]
    pos[k * 3 + 1] = c[1]
    pos[k * 3 + 2] = c[2]
    const s = st[k] as readonly [number, number]
    uv[k * 2] = s[0]
    uv[k * 2 + 1] = s[1]
  }
  return { pos, st: uv, nx: normal[0], ny: normal[1], nz: normal[2], shade, face, cull }
}

/** The four corners of face `f` of the unit cube, in the meshing loop's emit order. */
function cubeFaceCorners(f: number): [number, number, number][] {
  const def = FACES[f]!
  const out: [number, number, number][] = []
  for (let k = 0; k < 4; k++) {
    const a = k === 1 || k === 2 ? 1 : 0
    const b = k === 2 || k === 3 ? 1 : 0
    out.push([def.base[0] + a * def.u[0] + b * def.v[0], def.base[1] + a * def.u[1] + b * def.v[1], def.base[2] + a * def.u[2] + b * def.v[2]])
  }
  return out
}

/**
 * Turns a box into up to six quads.
 *
 * The corner mapping is `from + p * (to - from)` component-wise on the unit-cube corner `p`,
 * which works for all six faces without a per-face case: `FACES` already puts the face's own
 * constant coordinate at 0 or 1, so it lands on `from` or `to` respectively.
 *
 * The UVs are then read off the RESULT, through `faceST` -- not off `p`. That is the whole
 * point: a carpet's north quad has corners at y = 0 and y = 1/16, so its texture rows are the
 * bottom sixteenth of the cell. Scaling the cube's own corner table instead would stretch the
 * whole texture over a one-texel-tall face.
 *
 * A face is cullable only when it is flush with the unit cube in its own normal's direction --
 * a carpet's underside is (it meets the block below exactly), its top is not, and a cactus'
 * sides are not, which is why a cactus keeps its silhouette against a neighbour.
 */
function boxQuads(box: ShapeBox, faces: readonly number[] = [F_EAST, F_WEST, F_UP, F_DOWN, F_SOUTH, F_NORTH]): ShapeQuad[] {
  const from = [box.from[0] / 16, box.from[1] / 16, box.from[2] / 16] as const
  const to = [box.to[0] / 16, box.to[1] / 16, box.to[2] / 16] as const
  const out: ShapeQuad[] = []
  for (const f of faces) {
    const def = FACES[f]!
    const axis = def.normal[0] !== 0 ? 0 : def.normal[1] !== 0 ? 1 : 2
    const positive = (def.normal[axis] as number) > 0
    const flush = positive ? to[axis] === 1 : from[axis] === 0
    const corners = cubeFaceCorners(f).map(
      (p) => [from[0] + p[0] * (to[0] - from[0]), from[1] + p[1] * (to[1] - from[1]), from[2] + p[2] * (to[2] - from[2])] as [number, number, number],
    )
    out.push(quad(corners, corners.map((c) => faceST(f, c[0], c[1], c[2])), def.normal as [number, number, number], def.shade, f, flush ? f : -1))
  }
  return out
}

/** Two crossed vertical planes, each drawn from both sides.
 *
 * The back of a plane is the same four corners in reverse order with the normal negated, so the
 * texture appears mirrored from behind -- which is exactly what vanilla shows, because vanilla
 * draws one double-sided quad rather than two. Reversing the corner order is what reverses the
 * winding; the shared triangulation (0,1,2)(0,2,3) then produces an outward-facing back.
 *
 * A cross plane is never flush with the cell boundary, so `cull` is -1 on all four: a flower
 * standing against a wall keeps both of its planes. */
function crossQuads(face: number): ShapeQuad[] {
  const a = CROSS_INSET
  const b = 1 - CROSS_INSET
  const out: ShapeQuad[] = []
  for (const [x0, z0, x1, z1] of [
    [a, a, b, b],
    [b, a, a, b],
  ] as const) {
    const corners: [number, number, number][] = [
      [x0, 0, z0],
      [x1, 0, z1],
      [x1, 1, z1],
      [x0, 1, z0],
    ]
    const st: [number, number][] = [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ]
    // n = (c1-c0) x (c2-c0), computed rather than written down so the two diagonals cannot
    // disagree: for a plane through (dx, 0, dz) and (0, 1, 0) that is (-dz, 0, dx).
    const dx = x1 - x0
    const dz = z1 - z0
    const len = Math.hypot(dz, dx) || 1
    const n: [number, number, number] = [-dz / len, 0, dx / len]
    out.push(quad(corners, st, n, CROSS_SHADE, face, -1))
    out.push(quad([...corners].reverse(), [...st].reverse(), [-n[0], -n[1], -n[2]], CROSS_SHADE, face, -1))
  }
  return out
}

/** Bedrock's `vine_direction_bits`, from `block/rotate.go`'s transform table: the
 * game sets 4 to point a vine north, 8 east, 1 south and 2 west. */
const VINE_BITS: readonly (readonly [number, number])[] = [
  [1, F_SOUTH],
  [2, F_WEST],
  [4, F_NORTH],
  [8, F_EAST],
]

/** A vine sheet on each face its state names: the cube's own face quad, pulled one sixteenth
 * inward, drawn from both sides.
 *
 * A vine with NO `vine_direction_bits` -- which is what a `places_block` with no states gets --
 * is drawn on all four sides. That is an approximation and it is chosen deliberately: a preview
 * whose job is to show what a feature placed must show that something is there, and the
 * alternative reading of "no recorded attachment" is a cell that draws nothing at all. */
function attachedQuads(bits: number | undefined): ShapeQuad[] {
  const out: ShapeQuad[] = []
  for (const [bit, f] of VINE_BITS) {
    if (bits !== undefined && bits !== 0 && (bits & bit) === 0) continue
    const def = FACES[f]!
    const corners = cubeFaceCorners(f).map(
      (p) => [p[0] - def.normal[0] * ATTACHED_OFFSET, p[1] - def.normal[1] * ATTACHED_OFFSET, p[2] - def.normal[2] * ATTACHED_OFFSET] as [number, number, number],
    )
    const st = def.uv.map((c) => [c[0], c[1]] as [number, number])
    out.push(quad(corners, st, def.normal as [number, number, number], def.shade, f, -1))
    out.push(quad([...corners].reverse(), [...st].reverse(), [-def.normal[0], -def.normal[1], -def.normal[2]], def.shade, f, -1))
  }
  return out
}

type ShapeBuilder = (states: Readonly<Record<string, unknown>> | null | undefined) => CompiledShape

const SHAPE_BUILDERS: Readonly<Record<BlockShape, ShapeBuilder>> = {
  full_block: () => ({ quads: boxQuads(SHAPE_BOXES.full_block), fills: true }),
  unsupported: () => ({ quads: boxQuads(SHAPE_BOXES.full_block), fills: true }),
  layer: () => ({ quads: boxQuads(SHAPE_BOXES.layer), fills: false }),
  torch: () => ({ quads: boxQuads(SHAPE_BOXES.torch), fills: false }),
  cactus: () => ({ quads: boxQuads(SHAPE_BOXES.cactus), fills: false }),
  cross: () => ({ quads: crossQuads(F_NORTH), fills: false }),
  attached: (states) => {
    const bits = states?.['vine_direction_bits']
    return { quads: attachedQuads(typeof bits === 'number' ? bits : undefined), fills: false }
  },
}

// --- states that rotate a block ---------------------------------------------------------------

/** A row-major integer rotation matrix. */
type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

/** `pillar_axis = "x"`: the y-log turned 90 degrees about Z, so its top lands on +X. */
const ROT_PILLAR_X: Mat3 = [0, 1, 0, -1, 0, 0, 0, 0, 1]
/** `pillar_axis = "z"`: the y-log turned 90 degrees about X, so its top lands on +Z. */
const ROT_PILLAR_Z: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0]

/**
 * The rotation a block's states put it in, or null for none.
 *
 * DRIVEN: `pillar_axis`. It is the one state family in scope, and it is in scope because
 * `oak_log` is in the public fixture pack and a horizontal log with its end grain on the wrong
 * pair of faces is wrong in a way anyone can see. Bedrock spells it
 * 0=y 1=x 2=z (block/rotate.go), and "y" is the identity.
 *
 * NOT DRIVEN, and each for the same reason -- nothing in the measured sample or the fixture
 * pack places a block carrying it, so building geometry for it would be building for cases
 * nothing reaches:
 *
 *   - `top_slot_bit` (which half a slab fills) -- no slab is placed anywhere in the sample.
 *   - `weirdo_direction` / `upside_down_bit` (stairs) -- likewise, no stair.
 *   - `cardinal_direction` / `facing_direction` / `minecraft:block_face` -- the directional
 *     blocks that carry them (furnaces, buttons, levers, trapdoors) are not placed either.
 *   - `height` (a snow layer's depth) -- a snow layer is placed, but as `snow_layer` with no
 *     height state, so there is nothing to read.
 *   - `growth` / `age` (which frame a crop draws) -- selecting a frame is a TEXTURE question
 *     and would need per-state cells the atlas does not carry; a crop draws its first frame.
 *
 * Adding any of them later is a row in this function plus, for the ones that are really
 * geometry, an entry in SHAPE_BOXES. Nothing else in the renderer would have to change.
 */
export function rotationForStates(states: Readonly<Record<string, unknown>> | null | undefined): Mat3 | null {
  const axis = states?.['pillar_axis']
  if (axis === 'x') return ROT_PILLAR_X
  if (axis === 'z') return ROT_PILLAR_Z
  return null
}

function applyMat3(m: Mat3, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]
}

function faceIndexByNormal(nx: number, ny: number, nz: number): number {
  for (let f = 0; f < FACE_COUNT; f++) {
    const n = FACES[f]!.normal
    if (n[0] === nx && n[1] === ny && n[2] === nz) return f
  }
  return -1
}

/**
 * Rotates a compiled shape into world space, leaving its TEXTURE mapping in model space.
 *
 * That split is the whole of state-driven texture mapping, and it is why this file needs no
 * per-axis table of "which face shows which texture". A quad keeps the `face` it was compiled
 * with -- so the model's `up` quad still reads the `up` entry, i.e. the log's end grain -- but
 * its corners, normal, shade and cull all move with the rotation. Turn a y-log to `pillar_axis
 * = "x"` and its top quad lands on the world's east side, still carrying `oak_log_top`, still
 * with the `st` it had in model space, so the bark on the four remaining sides comes out
 * rotated a quarter turn exactly as it does in the game. None of that is written down anywhere;
 * it falls out of transforming the geometry and not the mapping.
 *
 * A proper rotation preserves winding (det = +1), so the corner order is untouched.
 */
function rotateShape(shape: CompiledShape, m: Mat3): CompiledShape {
  const quads = shape.quads.map((q) => {
    const pos = new Float32Array(12)
    for (let k = 0; k < 4; k++) {
      const p = applyMat3(m, (q.pos[k * 3] as number) - 0.5, (q.pos[k * 3 + 1] as number) - 0.5, (q.pos[k * 3 + 2] as number) - 0.5)
      pos[k * 3] = p[0] + 0.5
      pos[k * 3 + 1] = p[1] + 0.5
      pos[k * 3 + 2] = p[2] + 0.5
    }
    const n = applyMat3(m, q.nx, q.ny, q.nz)
    const world = faceIndexByNormal(n[0], n[1], n[2])
    let cull = -1
    if (q.cull >= 0) {
      const c = FACES[q.cull]!.normal
      cull = faceIndexByNormal(...applyMat3(m, c[0], c[1], c[2]))
    }
    return {
      pos,
      st: q.st,
      nx: n[0],
      ny: n[1],
      nz: n[2],
      // A rotated quad is shaded by the direction it now faces, not the one it was authored
      // facing -- otherwise a log lying east-west keeps the bright top shading on its side.
      shade: world >= 0 ? (FACES[world]!.shade as number) : q.shade,
      face: q.face,
      cull,
    }
  })
  return { quads, fills: shape.fills }
}

// --- the grass fringe -------------------------------------------------------------------------

/** How far inside the cube the underlay of an overlay face sits. Small enough to be invisible
 * at any zoom this preview reaches (a block is tens of pixels across), large enough that the
 * depth buffer never has to choose between two coplanar quads. Inward rather than outward on
 * purpose: the overlay stays exactly on the block's boundary, so nothing about the block's
 * silhouette moves and nothing pokes into the cell next door. */
const UNDERLAY_INSET = 0.002

/**
 * Whether a face is a fringe OVERLAY rather than a whole face, and therefore needs the block's
 * own `down` texture drawn behind it.
 *
 * This is the grass block, and it is stated as a rule about the table rather than as that
 * block's name. Vanilla's `grass_side` is 176/1000 opaque -- it is the green fringe alone, not
 * dirt with a fringe on it -- and the atlas builder emits it exactly as the pack declares it,
 * with a note saying that layering it is the renderer's decision. Left unlayered a grass
 * block's four sides are mostly holes and you see straight through the terrain, which, grass
 * being the top layer of the default preset, is the first thing anyone would notice.
 *
 * The marker is `tint: "grass"` on a face whose CELL is cutout. That channel is set from
 * `terrain_texture.json`'s `overlay_color`, which is how the pack itself marks a texture as an
 * overlay over something else. MEASURED over the whole 1238-block vanilla catalogue: exactly
 * five faces carry the channel, and exactly the four that need this -- grass_block's sides --
 * are the cutout ones. The fifth is grass_block's `up` (grass_top, fully opaque), which is
 * tinted and needs no underlay, and is excluded by the cutout test rather than by name.
 *
 * A block with no `down` face in the table is left alone: there would be nothing to draw
 * behind it, and one mostly-transparent face is better than a confidently wrong one.
 */
function overlayFaces(block: AtlasTableWire['blocks'][string] | undefined, table: AtlasTableWire): number[] {
  if (block === undefined || (block.faces?.['down'] ?? block.faces?.['*']) === undefined) return []
  const out: number[] = []
  for (let f = 0; f < FACE_COUNT; f++) {
    const key = FACES[f]!.key
    if (key === 'down') continue
    if ((block.tint?.[key] ?? block.tint?.['*']) !== 'grass') continue
    const cell = block.faces?.[key] ?? block.faces?.['*']
    if (cell === undefined) continue
    if (table.cells[cell]?.render !== 'cutout') continue
    out.push(f)
  }
  return out
}

/** The full cube with an underlay quad added behind each overlay face: the block's `down` cell
 * (dirt, for grass), untinted, at the same place a hair further in. Both quads carry the same
 * `cull`, so they appear and disappear together. */
function withUnderlays(shape: CompiledShape, faces: readonly number[]): CompiledShape {
  const extra: ShapeQuad[] = []
  for (const f of faces) {
    const def = FACES[f]!
    const corners = cubeFaceCorners(f).map(
      (p) => [p[0] - def.normal[0] * UNDERLAY_INSET, p[1] - def.normal[1] * UNDERLAY_INSET, p[2] - def.normal[2] * UNDERLAY_INSET] as [number, number, number],
    )
    // The underlay is read from the `down` entry -- that is where the dirt is -- but mapped and
    // shaded as the SIDE face it stands in for.
    extra.push(quad(corners, def.uv.map((c) => [c[0], c[1]] as [number, number]), def.normal as [number, number, number], def.shade, F_DOWN, f))
  }
  return { quads: [...extra, ...shape.quads], fills: shape.fills }
}

// --- the whole palette --------------------------------------------------------------------------

/**
 * Compiles one shape per palette id, or null for "the plain full cube" -- which is by far the
 * common case (65 of the 99 vanilla names the measured sample places, plus every one of the 10 leaves)
 * and which the meshing loop keeps on its original, untouched code path.
 *
 * Called only for a TEXTURED pass. See this file's header for why that is forced rather than
 * chosen.
 */
export function compileShapes(table: AtlasTableWire, palette: readonly ViewerPaletteEntry[]): (CompiledShape | null)[] {
  let maxId = 0
  for (const entry of palette) if (entry.id > maxId) maxId = entry.id
  const out: (CompiledShape | null)[] = new Array(maxId + 1).fill(null)
  // One compiled instance per (shape, states) spelling, shared by every id that resolves to it
  // -- a bench full of oak logs all on the same axis compiles one shape, not one per palette
  // entry, and every quad's typed arrays are read-only from here on.
  const cache = new Map<string, CompiledShape | null>()
  // The SAME row mesher.ts's compileAtlas resolves for this entry: a permutation can swap a
  // block's geometry as well as its textures, and a block resolved to its lit textures and its
  // unlit shape would be worse than either.
  const stated = indexStatedAtlasBlocks(table)

  for (const entry of palette) {
    const block = lookupAtlasBlock(table, stated, entry.name, entry.states)
    const shape = shapeForBlock(entry.name, block?.shape)
    const rotation = rotationForStates(entry.states)
    const underlays = overlayFaces(block, table)
    if (shape === 'full_block' && rotation === null && underlays.length === 0) continue

    const key = `${shape}|${rotation === null ? '-' : rotation.join('')}|${underlays.join('')}|${shape === 'attached' ? String(entry.states?.['vine_direction_bits']) : ''}`
    let compiled = cache.get(key)
    if (compiled === undefined) {
      compiled = (SHAPE_BUILDERS[shape] as ShapeBuilder)(entry.states)
      if (underlays.length > 0) compiled = withUnderlays(compiled, underlays)
      if (rotation !== null) compiled = rotateShape(compiled, rotation)
      cache.set(key, compiled)
    }
    out[entry.id] = compiled
  }
  return out
}
