// shapes.test.ts -- Piece D: block shapes and the states that change them.
//
// What these assertions CANNOT check is whether the picture is right, and a shape table is the
// archetypal thing that passes every assertion and looks wrong -- two coincident quads instead
// of a cross, a plant floating half a block up, UVs mirrored on one axis. This repo's task
// report carries the screenshots that answer that: a cross seen from almost directly above
// (an X, not a band), an oak_log at each pillar_axis (end grain on the right pair of faces),
// and a plant against a solid block (cut out, no halo).
import { describe, expect, it } from 'vitest'
import { buildMesh, compileAtlas, faceST, FACES, FACE_COUNT } from '../src/mesher.js'
import { compileShapes, rotationForStates, shapeForBlock } from '../src/shapes.js'
import type { AtlasTableWire, ViewerPaletteEntry, ViewerVolume } from '../src/index.js'
import { CELL_BROWN, CELL_GREY_CHECKER, CELL_HOLED, CELL_TWO_BAND, STUB_CELL, STUB_COLS, stubAtlasTable } from './fixtures/stubAtlas.js'

const FACE_INDEX = Object.fromEntries(FACES.map((f, i) => [f.key, i])) as Record<string, number>
const SYNTHESIZED_WHITE = STUB_COLS * 2

function withSynthesizedWhite(table: AtlasTableWire, border = 1): AtlasTableWire {
  const stride = STUB_CELL + 2 * border
  return {
    ...table,
    height: table.height + stride,
    rows: table.rows + 1,
    cells: [...table.cells, { x: border, y: table.height + border, render: 'opaque' as const, color: '#ffffff' }],
  }
}

const STUB = withSynthesizedWhite(stubAtlasTable())

const AIR: ViewerPaletteEntry = { id: 0, name: 'minecraft:air', color: 0x000000, kind: 'air' }

function entry(id: number, name: string, states?: Record<string, unknown>, kind: ViewerPaletteEntry['kind'] = 'solid'): ViewerPaletteEntry {
  return { id, name, color: 0x808080, kind, states: states ?? null }
}

function shapesFor(palette: readonly ViewerPaletteEntry[], table: AtlasTableWire = STUB) {
  return compileShapes(table, palette)
}

/** Every corner of every quad, as [x,y,z]. */
function corners(quads: readonly { pos: Float32Array }[]): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const q of quads) for (let k = 0; k < 4; k++) out.push([q.pos[k * 3] as number, q.pos[k * 3 + 1] as number, q.pos[k * 3 + 2] as number])
  return out
}

describe('faceST -- the UV rule behind every non-cube shape', () => {
  // `FACES[f].uv` is the corner table Piece C derived face by face; `faceST` is the same
  // statement as a rule, and a shape smaller than a whole cell needs the rule rather than the
  // corners. Get one of them backwards and the geometry still meshes, every other test still
  // passes, and every asymmetric texture in the game renders mirrored -- so they are pinned to
  // each other here rather than each being asserted against a hand-written expectation.
  it('reproduces the per-face corner table at all four corners of every face', () => {
    for (let f = 0; f < FACE_COUNT; f++) {
      const def = FACES[f]!
      for (let k = 0; k < 4; k++) {
        const a = k === 1 || k === 2 ? 1 : 0
        const b = k === 2 || k === 3 ? 1 : 0
        const p: [number, number, number] = [
          def.base[0] + a * def.u[0] + b * def.v[0],
          def.base[1] + a * def.u[1] + b * def.v[1],
          def.base[2] + a * def.u[2] + b * def.v[2],
        ]
        expect(faceST(f, p[0], p[1], p[2]), `${def.key} corner ${k}`).toEqual([def.uv[k]![0], def.uv[k]![1]])
      }
    }
  })
})

describe('shapeForBlock', () => {
  it('draws the plants real packs actually place as crosses', () => {
    for (const name of ['minecraft:oak_sapling', 'minecraft:dandelion', 'minecraft:short_grass', 'minecraft:red_mushroom', 'minecraft:kelp', 'minecraft:bamboo']) {
      expect(shapeForBlock(name), name).toBe('cross')
    }
  })

  it('leaves everything it has not heard of as a full cube', () => {
    expect(shapeForBlock('minecraft:stone')).toBe('full_block')
    expect(shapeForBlock('minecraft:oak_leaves')).toBe('full_block')
    expect(shapeForBlock('pack:whatever')).toBe('full_block')
  })

  it('does NOT treat minecraft:grass as a plant -- in Bedrock that name is the grass BLOCK', () => {
    // block/aliases.go resolves minecraft:grass to minecraft:grass_block before the palette
    // sees it, so this is belt and braces; drawing the terrain's top layer as a cross would be
    // the single most visible way to get this table wrong.
    expect(shapeForBlock('minecraft:grass')).toBe('full_block')
    expect(shapeForBlock('minecraft:grass_block')).toBe('full_block')
    expect(shapeForBlock('minecraft:short_grass')).toBe('cross')
  })

  it('lets a pack declare its own block a cross, and treats an unsupported model as a cube', () => {
    // The vocabulary shared with block/render.go: full_block / cross / unsupported.
    expect(shapeForBlock('pack:bush', 'cross')).toBe('cross')
    expect(shapeForBlock('pack:pillar', 'full_block')).toBe('full_block')
    expect(shapeForBlock('pack:statue', 'unsupported')).toBe('full_block')
    // A declared shape wins over this file's own table: the pack is the authority on its blocks.
    expect(shapeForBlock('minecraft:oak_sapling', 'full_block')).toBe('full_block')
  })
})

describe('compileShapes', () => {
  it('leaves an ordinary block alone, so it stays on the untouched cube path', () => {
    const shapes = shapesFor([AIR, entry(1, 'minecraft:stone'), entry(2, 'minecraft:oak_leaves')])
    expect(shapes[1]).toBeNull()
    expect(shapes[2]).toBeNull()
  })

  it('gives a cross two PERPENDICULAR planes, each drawn from both sides', () => {
    const shape = shapesFor([AIR, entry(1, 'minecraft:oak_sapling', undefined, 'plant')])[1]!
    expect(shape.quads.length).toBe(4)
    expect(shape.fills).toBe(false)
    // Two distinct plane orientations, at right angles. Two coincident quads -- the classic way
    // to get this wrong while every count still matches -- would make this dot product 1.
    const [a, b] = [shape.quads[0]!, shape.quads[2]!]
    expect(Math.abs(a.nx * b.nx + a.ny * b.ny + a.nz * b.nz)).toBeLessThan(1e-6)
    // Front and back of the SAME plane: opposite normals, same four corners.
    expect(shape.quads[1]!.nx).toBeCloseTo(-a.nx)
    expect(shape.quads[1]!.nz).toBeCloseTo(-a.nz)
    // Every corner sits on one of the cell's two diagonals, spanning the full block height, and
    // stops just short of the corner so a plant never pokes into the cell next door.
    for (const [x, y, z] of corners(shape.quads)) {
      expect(y === 0 || y === 1).toBe(true)
      expect(Math.min(x, 1 - x)).toBeCloseTo(0.05, 6)
      expect(Math.min(z, 1 - z)).toBeCloseTo(0.05, 6)
    }
    // No neighbour can hide any of it: a flower against a wall keeps both planes.
    for (const q of shape.quads) expect(q.cull).toBe(-1)
  })

  it('gives a carpet a one-sixteenth slab whose UNDERSIDE is the only cullable face', () => {
    const shape = shapesFor([AIR, entry(1, 'minecraft:white_carpet')])[1]!
    expect(shape.fills).toBe(false)
    const ys = corners(shape.quads).map((c) => c[1])
    expect(Math.max(...ys)).toBeCloseTo(1 / 16, 6)
    const byFace = new Map(shape.quads.map((q) => [q.face, q]))
    expect(byFace.get(FACE_INDEX['down']!)!.cull).toBe(FACE_INDEX['down'])
    expect(byFace.get(FACE_INDEX['up']!)!.cull).toBe(-1)
    // Flush in x and z, so a carpet against a wall does lose its side face, exactly as in game.
    expect(byFace.get(FACE_INDEX['north']!)!.cull).toBe(FACE_INDEX['north'])
    // ...and that side face is the BOTTOM row of the wool texture, not the whole texture
    // squashed into one texel. This is the derived-UV rule; getting it wrong is invisible on a
    // uniform texture like wool and glaring on a torch.
    const north = byFace.get(FACE_INDEX['north']!)!
    for (let k = 0; k < 4; k++) expect(north.st[k * 2 + 1]).toBeGreaterThanOrEqual(15 / 16 - 1e-6)
  })

  it('gives a torch a thin post that reads the middle two columns of its texture', () => {
    const shape = shapesFor([AIR, entry(1, 'minecraft:torch')])[1]!
    expect(shape.fills).toBe(false)
    const xs = corners(shape.quads).map((c) => c[0])
    expect(Math.min(...xs)).toBeCloseTo(7 / 16, 6)
    expect(Math.max(...xs)).toBeCloseTo(9 / 16, 6)
    const north = shape.quads.find((q) => q.face === FACE_INDEX['north'])!
    for (let k = 0; k < 4; k++) {
      expect(north.st[k * 2]).toBeGreaterThanOrEqual(7 / 16 - 1e-6)
      expect(north.st[k * 2]).toBeLessThanOrEqual(9 / 16 + 1e-6)
    }
  })

  it('insets a cactus so its sides can never be hidden by the block beside it', () => {
    const shape = shapesFor([AIR, entry(1, 'minecraft:cactus', undefined, 'plant')])[1]!
    const byFace = new Map(shape.quads.map((q) => [q.face, q]))
    expect(byFace.get(FACE_INDEX['north']!)!.cull).toBe(-1)
    expect(byFace.get(FACE_INDEX['up']!)!.cull).toBe(FACE_INDEX['up'])
  })

  it('hangs a vine on the faces its state names, and on all four when it names none', () => {
    // vine_direction_bits, from block/rotate.go's table: 4 north, 8 east, 1 south,
    // 2 west. Two quads per face -- a vine sheet is visible from both sides.
    const north = shapesFor([AIR, entry(1, 'minecraft:vine', { vine_direction_bits: 4 }, 'plant')])[1]!
    expect(north.quads.length).toBe(2)
    expect(north.quads.every((q) => q.face === FACE_INDEX['north'])).toBe(true)
    const twoSided = shapesFor([AIR, entry(1, 'minecraft:vine', { vine_direction_bits: 4 + 8 }, 'plant')])[1]!
    expect(new Set(twoSided.quads.map((q) => q.face))).toEqual(new Set([FACE_INDEX['north'], FACE_INDEX['east']]))
    const stateless = shapesFor([AIR, entry(1, 'minecraft:vine', undefined, 'plant')])[1]!
    expect(new Set(stateless.quads.map((q) => q.face)).size).toBe(4)
  })
})

describe('pillar_axis', () => {
  it('is the only state family driven, and only for x and z', () => {
    expect(rotationForStates(null)).toBeNull()
    expect(rotationForStates({ pillar_axis: 'y' })).toBeNull()
    expect(rotationForStates({ pillar_axis: 'x' })).not.toBeNull()
    expect(rotationForStates({ pillar_axis: 'z' })).not.toBeNull()
    // Deliberately not driven -- nothing in the measured sample places one. See rotationForStates.
    expect(rotationForStates({ top_slot_bit: true })).toBeNull()
    expect(rotationForStates({ weirdo_direction: 2, upside_down_bit: false })).toBeNull()
    expect(rotationForStates({ growth: 7 })).toBeNull()
  })

  it('puts the end-grain texture on east/west for "x" and north/south for "z"', () => {
    // The whole of state-driven texture mapping in one assertion: the quad facing world east
    // still READS the `up` entry, which is where a log's end grain lives.
    for (const [axis, ends, sides] of [
      ['x', ['east', 'west'], ['up', 'down', 'north', 'south']],
      ['z', ['south', 'north'], ['up', 'down', 'east', 'west']],
    ] as const) {
      const shape = shapesFor([AIR, entry(1, 'minecraft:grass_block', { pillar_axis: axis })])[1]!
      expect(shape.fills, 'a rotated cube still fills its cell and must still occlude').toBe(true)
      expect(shape.quads.length).toBe(6)
      for (const q of shape.quads) {
        const world = FACES.findIndex((f) => f.normal[0] === q.nx && f.normal[1] === q.ny && f.normal[2] === q.nz)
        const worldKey = FACES[world]!.key
        const modelKey = FACES[q.face]!.key
        if ((ends as readonly string[]).includes(worldKey)) {
          expect(modelKey, `${axis}: world ${worldKey}`).toMatch(/^(up|down)$/)
        } else {
          expect((sides as readonly string[]).includes(worldKey), `${axis}: world ${worldKey}`).toBe(true)
          expect(modelKey, `${axis}: world ${worldKey}`).not.toMatch(/^(up|down)$/)
        }
        // Shaded by the direction it now faces, not the one it was authored facing.
        expect(q.shade).toBeCloseTo(FACES[world]!.shade, 6)
        expect(q.cull).toBe(world)
      }
    }
  })

  it('turns a cube into a cube -- the same eight corners, in some order', () => {
    const shape = shapesFor([AIR, entry(1, 'minecraft:grass_block', { pillar_axis: 'x' })])[1]!
    const seen = new Set(corners(shape.quads).map((c) => c.map((v) => Math.round(v)).join(',')))
    expect(seen.size).toBe(8)
    for (const c of seen) expect(c).toMatch(/^[01],[01],[01]$/)
  })
})

// --- the grass fringe --------------------------------------------------------------------------

/** A table shaped like the real one for grass: the side faces carry the `grass` tint channel
 * over a CUTOUT cell (vanilla's grass_side is the green fringe alone, 176/1000 opaque), and the
 * `down` face is the dirt underneath. */
function fringeTable(): AtlasTableWire {
  const table = withSynthesizedWhite(stubAtlasTable())
  return {
    ...table,
    blocks: {
      ...table.blocks,
      'minecraft:grass_block': {
        faces: { up: CELL_GREY_CHECKER, down: CELL_BROWN, north: CELL_HOLED, south: CELL_HOLED, east: CELL_HOLED, west: CELL_HOLED },
        tint: { up: 'grass', down: 'none', north: 'grass', south: 'grass', east: 'grass', west: 'grass' },
        render: 'cutout',
      },
      // A cutout block whose faces are NOT the grass channel: leaves. Must get no underlay --
      // drawing dirt behind every leaf would fill in a whole canopy.
      'minecraft:oak_leaves': {
        faces: { up: CELL_HOLED, down: CELL_HOLED, north: CELL_HOLED, south: CELL_HOLED, east: CELL_HOLED, west: CELL_HOLED },
        tint: { up: 'foliage', down: 'foliage', north: 'foliage', south: 'foliage', east: 'foliage', west: 'foliage' },
        render: 'cutout',
      },
    },
  }
}

describe('the grass fringe', () => {
  it('draws the block’s own down texture behind each mostly-transparent grass-channel face', () => {
    const table = fringeTable()
    const shape = compileShapes(table, [AIR, entry(1, 'minecraft:grass_block')])[1]!
    // Six cube faces plus one underlay behind each of the four sides.
    expect(shape.quads.length).toBe(10)
    expect(shape.fills, 'a grass block is still a solid cube and must still occlude').toBe(true)
    const underlays = shape.quads.filter((q) => q.face === FACE_INDEX['down'] && q.cull !== FACE_INDEX['down'])
    expect(underlays.length).toBe(4)
    for (const q of underlays) {
      // Faces outward like the side it stands in for, cullable with it, and a hair inside the
      // block so the depth buffer never has to choose between two coplanar quads.
      expect(q.cull).toBeGreaterThanOrEqual(0)
      expect(FACES[q.cull]!.key).toMatch(/^(north|south|east|west)$/)
      expect(q.shade).toBeCloseTo(FACES[q.cull]!.shade, 6)
      // Pulled INWARD along its own normal, by a distance far below one screen pixel at any
      // zoom this preview reaches: the overlay stays exactly on the block's boundary, so the
      // silhouette is unchanged and nothing pokes into the cell next door.
      const n = FACES[q.cull]!.normal
      const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2
      const plane = (n[axis] as number) > 0 ? 1 : 0
      for (let k = 0; k < 4; k++) {
        const offset = Math.abs((q.pos[k * 3 + axis] as number) - plane)
        expect(offset).toBeGreaterThan(0)
        expect(offset).toBeLessThan(0.01)
      }
    }
  })

  it('gives a cutout block that is not an overlay -- leaves -- no underlay at all', () => {
    const table = fringeTable()
    expect(compileShapes(table, [AIR, entry(1, 'minecraft:oak_leaves', undefined, 'plant')])[1]).toBeNull()
  })

  it('leaves a grass-channel face over an OPAQUE cell alone -- grass_top is tinted, not layered', () => {
    const table = fringeTable()
    const onlyUp: AtlasTableWire = {
      ...table,
      blocks: { ...table.blocks, 'minecraft:grass_block': { ...table.blocks['minecraft:grass_block']!, faces: { up: CELL_GREY_CHECKER, down: CELL_BROWN, north: CELL_TWO_BAND, south: CELL_TWO_BAND, east: CELL_TWO_BAND, west: CELL_TWO_BAND } } },
    }
    expect(compileShapes(onlyUp, [AIR, entry(1, 'minecraft:grass_block')])[1]).toBeNull()
  })
})

// --- what the mesher does with a shape ------------------------------------------------------------

const SLICE = { minY: -Infinity, maxY: Infinity }
const ACCEPT_ALL = () => true

/** A 3x3x3 volume with `below` at the middle-bottom and `above` directly on top of it. */
function stacked(below: number, above: number): ViewerVolume {
  const data = new Uint32Array(27)
  data[0 * 9 + 1 * 3 + 1] = below
  data[1 * 9 + 1 * 3 + 1] = above
  return {
    minX: 0,
    minY: 0,
    minZ: 0,
    sizeX: 3,
    sizeY: 3,
    sizeZ: 3,
    data,
    baseline: new Uint32Array(27),
    changed: new Uint8Array(27),
    removed: new Uint8Array(27),
  }
}

describe('buildMesh with shapes', () => {
  const palette = [AIR, entry(1, 'minecraft:dirt'), entry(2, 'minecraft:oak_sapling', undefined, 'plant'), entry(3, 'minecraft:stone')]
  const compiled = compileAtlas(STUB, palette, SYNTHESIZED_WHITE, compileShapes(STUB, palette))

  it('does not let a cross-shaped plant hide the block it stands on', () => {
    // The failure this exists to catch is silent: a plant that still "fills" its cell culls the
    // ground's top face and leaves a block-shaped hole in the terrain under every flower.
    const withPlant = buildMesh(stacked(1, 2), palette, { ...SLICE, accept: (_i, id) => id === 1, atlas: compiled.mesher })
    const withStone = buildMesh(stacked(1, 3), palette, { ...SLICE, accept: (_i, id) => id === 1, atlas: compiled.mesher })
    expect(withPlant.quadCount).toBe(6)
    expect(withStone.quadCount).toBe(5)
  })

  it('draws all four of a plant’s quads even when it is buried in solid rock', () => {
    const data = new Uint32Array(27)
    for (let i = 0; i < 27; i++) data[i] = 3
    data[1 * 9 + 1 * 3 + 1] = 2
    const volume: ViewerVolume = { ...stacked(0, 0), data }
    const buf = buildMesh(volume, palette, { ...SLICE, accept: (_i, id) => id === 2, atlas: compiled.mesher })
    expect(buf.quadCount).toBe(4)
  })

  it('emits a uv for every vertex of a shaped block, inside the cell the table names', () => {
    const buf = buildMesh(stacked(1, 2), palette, { ...SLICE, accept: (_i, id) => id === 2, atlas: compiled.mesher })
    expect(buf.uvs.length).toBe((buf.positions.length / 3) * 2)
    // oak_sapling is not in the stub table, so every quad samples the white cell -- which is
    // exactly how an unknown block renders today, shape or no shape.
    expect(STUB.blocks['minecraft:oak_sapling']).toBeUndefined()
    const cell = STUB.cells[SYNTHESIZED_WHITE]!
    for (let i = 0; i < buf.uvs.length; i += 2) {
      expect(buf.uvs[i]).toBeGreaterThanOrEqual(cell.x / STUB.width - 1e-9)
      expect(buf.uvs[i]).toBeLessThanOrEqual((cell.x + STUB.cell) / STUB.width + 1e-9)
    }
  })

  it('produces exactly the flat-mode geometry for a volume with no shaped blocks in it', () => {
    // The guarantee that protects every committed wiki image: shapes ride with the atlas, and a
    // volume of ordinary cubes meshes to the same positions with or without one.
    const cubes = [AIR, entry(1, 'minecraft:dirt'), entry(2, 'minecraft:stone')]
    const cubeAtlas = compileAtlas(STUB, cubes, SYNTHESIZED_WHITE, compileShapes(STUB, cubes))
    const volume = stacked(1, 2)
    const flat = buildMesh(volume, cubes, { ...SLICE, accept: ACCEPT_ALL })
    const textured = buildMesh(volume, cubes, { ...SLICE, accept: ACCEPT_ALL, atlas: cubeAtlas.mesher })
    expect(Array.from(textured.positions)).toEqual(Array.from(flat.positions))
    expect(Array.from(textured.normals)).toEqual(Array.from(flat.normals))
    expect(Array.from(textured.indices)).toEqual(Array.from(flat.indices))
  })
})
