// atlas.test.ts -- the textured-rendering path: the wire decoder, the table-to-mesher compile
// step, and the per-vertex UVs/tints buildMesh emits from it. What these CANNOT check is whether
// the resulting picture is right; that needs a screenshot check by eye, and a renderer is the archetypal thing that passes every assertion and looks wrong.
import { describe, expect, it } from 'vitest'
import { buildMesh, compileAtlas, concatMeshBuffers, EMPTY_MESH_BUFFERS, FACES, FACE_COUNT, PASS_ALPHA_TESTED, PASS_TRANSLUCENT } from '../src/mesher.js'
import { decodeAtlas, parseHexColor } from '../src/protocol.js'
import { knownTintChannels, tintColorForChannel } from '../src/colors.js'
import type { AtlasTableWire, ViewerPaletteEntry, ViewerVolume } from '../src/index.js'
import { CELL_BLUE, CELL_BROWN, CELL_GREY_CHECKER, CELL_HOLED, CELL_TWO_BAND, CELL_WHITE, STUB_CELL, STUB_COLS, stubAtlasTable, stubAtlasTableWithWhite, stubAtlasWire } from './fixtures/stubAtlas.js'

const AIR: ViewerPaletteEntry = { id: 0, name: 'minecraft:air', color: 0x000000, kind: 'air' }
const GRASS: ViewerPaletteEntry = { id: 1, name: 'minecraft:grass_block', color: 0x6a9451, kind: 'solid' }
const WATER: ViewerPaletteEntry = { id: 2, name: 'minecraft:water', color: 0x3f76e4, kind: 'liquid' }
const LEAVES: ViewerPaletteEntry = { id: 3, name: 'minecraft:oak_leaves', color: 0x4a7942, kind: 'plant' }
// Deliberately NOT in the stub table -- the "a block the atlas has never heard of" case, which
// is every pack-defined block until the atlas learns about a pack's own resource pack.
const UNKNOWN: ViewerPaletteEntry = { id: 4, name: 'pack:mystery_block', color: 0x123456, kind: 'solid' }
// In the table, but with only its `up` face resolved -- the "builder could not resolve this
// texture key" case, which the table records as an absent face rather than a wrong cell.
const DIRT: ViewerPaletteEntry = { id: 5, name: 'minecraft:dirt', color: 0x8a5a3c, kind: 'solid' }
const PALETTE = [AIR, GRASS, WATER, LEAVES, UNKNOWN, DIRT]

const FACE_INDEX = Object.fromEntries(FACES.map((f, i) => [f.key, i])) as Record<string, number>

/** The stub tables carry no white cell -- the real builder does not pack one, so the renderer
 * synthesizes it (viewer.ts's prepareAtlas) by appending a row. These tests exercise the compile
 * step directly, so they stand in for that synthesis with the index it would produce. */
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

function oneCell(id: number) {
  const data = new Uint32Array(27)
  const volume: ViewerVolume = {
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
  data[1 * 9 + 1 * 3 + 1] = id // the middle cell, every neighbour air
  return volume
}

/** The (u, v) of every vertex of one face of the single meshed cell. buildMesh emits faces in
 * FACES order for a fully exposed block, so face `f` owns vertices 4f..4f+3. */
function faceUVs(uvs: Float32Array, face: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let k = 0; k < 4; k++) out.push([uvs[(face * 4 + k) * 2] as number, uvs[(face * 4 + k) * 2 + 1] as number])
  return out
}

/** The UV rectangle of one cell, computed straight from the table's own per-cell x/y rather
 * than from anything the renderer does -- so the assertions below are checking the renderer
 * against the table, not against a second copy of the renderer's own arithmetic. */
function cellRect(table: AtlasTableWire, cell: number) {
  const inset = typeof table.inset === 'number' ? table.inset : 0
  const c = table.cells[cell] as { x: number; y: number }
  return {
    u0: (c.x + inset) / table.width,
    v0: (c.y + inset) / table.height,
    u1: (c.x + table.cell - inset) / table.width,
    v1: (c.y + table.cell - inset) / table.height,
  }
}

const ACCEPT_ALL = () => true
const SLICE = { minY: -Infinity, maxY: Infinity }
const STUB = withSynthesizedWhite(stubAtlasTable())

function compiled(table = STUB) {
  return compileAtlas(table, PALETTE, SYNTHESIZED_WHITE)
}

describe('decodeAtlas', () => {
  it('accepts the stub atlas and decodes its PNG to bytes with a PNG signature', () => {
    const decoded = decodeAtlas(stubAtlasWire())
    expect(decoded.table.cols).toBe(STUB_COLS)
    expect(decoded.table.cells.length).toBe(STUB_COLS * 2)
    expect(Array.from(decoded.png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('accepts a table with no white cell -- the renderer synthesizes one rather than refusing', () => {
    expect(decodeAtlas(stubAtlasWire()).table.white).toBeUndefined()
    expect(decodeAtlas(stubAtlasWire(1, true)).table.white).toBe(CELL_WHITE)
  })

  it('refuses a table version it does not understand instead of guessing', () => {
    const wire = stubAtlasWire()
    ;(wire.table as { version: number }).version = 99
    expect(() => decodeAtlas(wire)).toThrow(/unsupported atlas table version 99/)
  })

  it('refuses a cell that does not fit inside the image its own table describes', () => {
    const wire = stubAtlasWire()
    ;(wire.table.cells[2] as { y: number }).y = 9999
    expect(() => decodeAtlas(wire)).toThrow(/does not fit inside a \d+x\d+ image/)
  })

  it('refuses a declared white cell index outside the cell list', () => {
    const wire = stubAtlasWire(1, true)
    ;(wire.table as { white: number }).white = 999
    expect(() => decodeAtlas(wire)).toThrow(/"white" must be a cell index/)
  })

  it('refuses a missing png, a missing table and an empty cell list', () => {
    expect(() => decodeAtlas({ table: stubAtlasTable() })).toThrow(/missing base64 "png"/)
    expect(() => decodeAtlas({ png: 'AA==' })).toThrow(/missing "table"/)
    const wire = stubAtlasWire()
    ;(wire.table as { cells: unknown[] }).cells = []
    expect(() => decodeAtlas(wire)).toThrow(/"cells" must be a non-empty array/)
  })
})

describe('compileAtlas', () => {
  it('resolves each face to the cell the table names for it', () => {
    const { mesher } = compiled()
    const base = GRASS.id * FACE_COUNT
    expect(mesher.cellForFace[base + (FACE_INDEX.up as number)]).toBe(CELL_GREY_CHECKER)
    expect(mesher.cellForFace[base + (FACE_INDEX.down as number)]).toBe(CELL_BROWN)
    for (const key of ['north', 'south', 'east', 'west']) {
      expect(mesher.cellForFace[base + (FACE_INDEX[key] as number)]).toBe(CELL_TWO_BAND)
    }
  })

  it('prefers the table’s MEASURED tint_color over its channel default and over our own table', () => {
    const { mesher } = compiled()
    // grass_block carries tint_color for `up` -- that measurement wins.
    expect(mesher.tintForFace[GRASS.id * FACE_COUNT + (FACE_INDEX.up as number)]).toBe(0x79c05a)
    // Its side faces are channel "none": white, so the texel passes through unchanged.
    expect(mesher.tintForFace[GRASS.id * FACE_COUNT + (FACE_INDEX.north as number)]).toBe(0xffffff)
  })

  it('falls back to the channel’s documented default when no measurement is given', () => {
    const { mesher } = compiled()
    // Leaves name the "foliage" channel with no tint_color, so the table's tints map answers.
    for (let f = 0; f < FACE_COUNT; f++) {
      expect(mesher.tintForFace[LEAVES.id * FACE_COUNT + f]).toBe(0x77ab2f)
    }
  })

  it('falls back to the renderer’s own channel table when the atlas documents neither', () => {
    const bare = { ...STUB, tints: undefined }
    const { mesher } = compiled(bare)
    for (let f = 0; f < FACE_COUNT; f++) {
      expect(mesher.tintForFace[LEAVES.id * FACE_COUNT + f]).toBe(tintColorForChannel('foliage'))
    }
  })

  it('points a block the table has never heard of at the white cell and its own flat colour', () => {
    const { mesher, pass } = compiled()
    const base = UNKNOWN.id * FACE_COUNT
    for (let f = 0; f < FACE_COUNT; f++) {
      expect(mesher.cellForFace[base + f]).toBe(SYNTHESIZED_WHITE)
      expect(mesher.tintForFace[base + f]).toBe(UNKNOWN.color)
    }
    // ...and into the ordinary opaque pass, which is where it renders today.
    expect(pass[UNKNOWN.id]).toBe(PASS_ALPHA_TESTED)
  })

  it('does the same for an individual face the builder could not resolve', () => {
    const { mesher } = compiled()
    const base = DIRT.id * FACE_COUNT
    expect(mesher.cellForFace[base + (FACE_INDEX.up as number)]).toBe(CELL_BROWN)
    for (const key of ['down', 'north', 'south', 'east', 'west']) {
      expect(mesher.cellForFace[base + (FACE_INDEX[key] as number)]).toBe(SYNTHESIZED_WHITE)
      expect(mesher.tintForFace[base + (FACE_INDEX[key] as number)]).toBe(DIRT.color)
    }
  })

  it('falls back to the white cell for a cell index the atlas cannot hold', () => {
    const broken = { ...STUB, blocks: { ...STUB.blocks, 'minecraft:dirt': { faces: { up: 9999 } } } }
    const { mesher } = compiled(broken)
    expect(mesher.cellForFace[DIRT.id * FACE_COUNT + (FACE_INDEX.up as number)]).toBe(SYNTHESIZED_WHITE)
  })

  it('routes only blocks the table marks translucent into the blended pass', () => {
    const { pass } = compiled()
    expect(pass[WATER.id]).toBe(PASS_TRANSLUCENT)
    // Cutout shares the alpha-tested pass with opaque -- see PASS_ALPHA_TESTED's doc comment.
    expect(pass[LEAVES.id]).toBe(PASS_ALPHA_TESTED)
    expect(pass[GRASS.id]).toBe(PASS_ALPHA_TESTED)
  })

  it('reads a cell’s position from the table rather than deriving it from the cell index', () => {
    // Move one cell somewhere the index arithmetic would never put it. A renderer that computed
    // col/row from the index would not notice.
    const moved = withSynthesizedWhite({ ...stubAtlasTable(), cells: stubAtlasTable().cells.map((c, i) => (i === CELL_BLUE ? { ...c, x: 1, y: 1 } : c)) })
    const uv = compileAtlas(moved, PALETTE, SYNTHESIZED_WHITE).mesher.cellUV
    expect(uv[CELL_BLUE * 4]).toBeCloseTo(1 / moved.width, 6)
    expect(uv[CELL_BLUE * 4 + 1]).toBeCloseTo(1 / moved.height, 6)
  })

  it('applies the inset the table names, in both the bordered and the flush layout', () => {
    const bordered = withSynthesizedWhite(stubAtlasTable(1), 1)
    const uvB = compileAtlas(bordered, PALETTE, SYNTHESIZED_WHITE).mesher.cellUV
    const rectB = cellRect(bordered, CELL_BLUE)
    expect(uvB[CELL_BLUE * 4]).toBeCloseTo(rectB.u0, 6)
    expect(uvB[CELL_BLUE * 4 + 2]).toBeCloseTo(rectB.u1, 6)

    const flush = withSynthesizedWhite(stubAtlasTable(0), 0)
    const uvF = compileAtlas(flush, PALETTE, SYNTHESIZED_WHITE).mesher.cellUV
    const rectF = cellRect(flush, CELL_BLUE)
    expect(uvF[CELL_BLUE * 4]).toBeCloseTo(rectF.u0, 6)
    expect(rectF.u0 - (flush.cells[CELL_BLUE] as { x: number }).x / flush.width).toBeCloseTo(0.5 / flush.width, 6)
  })
})

describe('buildMesh with an atlas', () => {
  it('emits no uvs at all without one, leaving flat-colour mode byte-identical', () => {
    const buf = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL })
    expect(buf.uvs.length).toBe(0)
    // The flat colour, per-face shaded, exactly as before textures existed: +X east, shade 0.72.
    expect(buf.colors[0]).toBeCloseTo((0x6a / 255) * 0.72, 5)
  })

  it('emits two uv floats per vertex with one', () => {
    const buf = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas: compiled().mesher })
    expect(buf.quadCount).toBe(6)
    expect(buf.uvs.length).toBe((buf.positions.length / 3) * 2)
  })

  it('puts every vertex of a face inside that face’s own atlas cell, and spans the whole of it', () => {
    const buf = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas: compiled().mesher })
    const cases: Array<[string, number]> = [
      ['up', CELL_GREY_CHECKER],
      ['down', CELL_BROWN],
      ['north', CELL_TWO_BAND],
      ['east', CELL_TWO_BAND],
    ]
    for (const [key, cell] of cases) {
      const rect = cellRect(STUB, cell)
      const corners = faceUVs(buf.uvs, FACE_INDEX[key] as number)
      for (const [u, v] of corners) {
        expect(u).toBeGreaterThanOrEqual(rect.u0 - 1e-6)
        expect(u).toBeLessThanOrEqual(rect.u1 + 1e-6)
        expect(v).toBeGreaterThanOrEqual(rect.v0 - 1e-6)
        expect(v).toBeLessThanOrEqual(rect.v1 + 1e-6)
      }
      // A degenerate mapping (all four corners on one point) would satisfy the bounds above.
      const us = corners.map(([u]) => u)
      const vs = corners.map(([, v]) => v)
      expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(rect.u1 - rect.u0, 6)
      expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(rect.v1 - rect.v0, 6)
    }
  })

  it('orients a side face upright: the vertex at the block’s TOP samples the cell’s TOP row', () => {
    const buf = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas: compiled().mesher })
    // This is the assertion that catches a vertically flipped side texture -- the failure that
    // would put a grass block's green band along its BOTTOM edge on all four sides.
    const rect = cellRect(STUB, CELL_TWO_BAND)
    for (const key of ['north', 'south', 'east', 'west']) {
      const face = FACE_INDEX[key] as number
      for (let k = 0; k < 4; k++) {
        const vertex = face * 4 + k
        const worldY = buf.positions[vertex * 3 + 1] as number
        const v = buf.uvs[vertex * 2 + 1] as number
        // The cell's top row is v0 (flipY=false), and the block's top is world y = 2 for the
        // cell at (1,1,1) in a 3x3x3 volume.
        expect(v).toBeCloseTo(worldY === 2 ? rect.v0 : rect.v1, 6)
      }
    }
  })

  it('multiplies the tint by the per-face shade, leaving the shading intact', () => {
    const buf = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas: compiled().mesher })
    const up = (FACE_INDEX.up as number) * 4 * 3
    expect(buf.colors[up]).toBeCloseTo((0x79 / 255) * 1.0, 5) // measured grass tint, SHADE_TOP
    const north = (FACE_INDEX.north as number) * 4 * 3
    expect(buf.colors[north]).toBeCloseTo(1.0 * 0.86, 5) // untinted -> white, N/S shade
    const down = (FACE_INDEX.down as number) * 4 * 3
    expect(buf.colors[down]).toBeCloseTo(1.0 * 0.58, 5) // untinted -> white, bottom shade
  })

  it('renders an unknown block as flat mode does -- white cell times its palette colour', () => {
    const textured = buildMesh(oneCell(UNKNOWN.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas: compiled().mesher })
    const flat = buildMesh(oneCell(UNKNOWN.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL })
    // Not bit-identical: flat mode's palette colour is rounded to float32 on the way into the
    // mesher's own lookup table, while a tint is unpacked at full precision. The gap is ~4e-9,
    // some six orders of magnitude below one step of an 8-bit colour channel.
    expect(textured.colors.length).toBe(flat.colors.length)
    for (let i = 0; i < flat.colors.length; i++) expect(textured.colors[i]).toBeCloseTo(flat.colors[i] as number, 6)
    const rect = cellRect(STUB, SYNTHESIZED_WHITE)
    for (const [u, v] of faceUVs(textured.uvs, FACE_INDEX.up as number)) {
      expect(u).toBeGreaterThanOrEqual(rect.u0 - 1e-6)
      expect(v).toBeGreaterThanOrEqual(rect.v0 - 1e-6)
    }
  })

  it('lets an explicit colorOverride (the heatmap) win over the tint, as it does over the palette', () => {
    const buf = buildMesh(oneCell(GRASS.id), PALETTE, {
      ...SLICE,
      accept: ACCEPT_ALL,
      atlas: compiled().mesher,
      colorOverride: () => [1, 0, 0],
    })
    const up = (FACE_INDEX.up as number) * 4 * 3
    expect(buf.colors[up]).toBeCloseTo(1.0, 5)
    expect(buf.colors[up + 1]).toBeCloseTo(0, 5)
  })

  it('grows the uv buffer alongside the others past their initial capacity', () => {
    const atlas = compiled().mesher
    const size = 12
    const cells = size * size * size
    const data = new Uint32Array(cells)
    for (let i = 0; i < cells; i += 2) data[i] = LEAVES.id
    const volume: ViewerVolume = {
      minX: 0,
      minY: 0,
      minZ: 0,
      sizeX: size,
      sizeY: size,
      sizeZ: size,
      data,
      baseline: new Uint32Array(cells),
      changed: new Uint8Array(cells),
      removed: new Uint8Array(cells),
    }
    const buf = buildMesh(volume, PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas })
    expect(buf.positions.length / 3).toBeGreaterThan(4096)
    expect(buf.uvs.length).toBe((buf.positions.length / 3) * 2)
    // Every uv must land inside the leaves cell -- a mis-sized regrow would leave zeros behind.
    const rect = cellRect(STUB, CELL_HOLED)
    for (let i = 0; i < buf.uvs.length; i += 2) {
      expect(buf.uvs[i]).toBeGreaterThanOrEqual(rect.u0 - 1e-6)
      expect(buf.uvs[i]).toBeLessThanOrEqual(rect.u1 + 1e-6)
    }
  })
})

describe('MeshBuffers.uvs across the helpers', () => {
  it('EMPTY_MESH_BUFFERS carries a zero-length uv array', () => {
    expect(EMPTY_MESH_BUFFERS.uvs.length).toBe(0)
  })

  it('concatenates two textured buffers into one uv array of the right width', () => {
    const atlas = compiled().mesher
    const a = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas })
    const b = buildMesh(oneCell(LEAVES.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL, atlas })
    const joined = concatMeshBuffers(a, b)
    expect(joined.uvs.length).toBe((joined.positions.length / 3) * 2)
    expect(Array.from(joined.uvs.subarray(0, a.uvs.length))).toEqual(Array.from(a.uvs))
  })

  it('keeps a flat concatenation flat', () => {
    const a = buildMesh(oneCell(GRASS.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL })
    const b = buildMesh(oneCell(LEAVES.id), PALETTE, { ...SLICE, accept: ACCEPT_ALL })
    expect(concatMeshBuffers(a, b).uvs.length).toBe(0)
  })
})

describe('tint channels', () => {
  it('parses the table’s #rrggbb multipliers and rejects anything else', () => {
    expect(parseHexColor('#79c05a')).toBe(0x79c05a)
    expect(parseHexColor('79c05a')).toBe(0x79c05a)
    expect(parseHexColor('#79c05')).toBeNull()
    expect(parseHexColor('rgb(1,2,3)')).toBeNull()
    expect(parseHexColor(undefined)).toBeNull()
  })

  it('resolves "none", an absent channel and an unknown channel all to white', () => {
    expect(tintColorForChannel('none')).toBe(0xffffff)
    expect(tintColorForChannel(undefined)).toBe(0xffffff)
    expect(tintColorForChannel('channel_from_a_newer_atlas')).toBe(0xffffff)
  })

  it('knows every channel the atlas builder can emit, so none can quietly fall through to white', () => {
    // These are internal/atlas's own TintNone/TintGrass/TintWater/TintFoliage/TintGrey. "grey"
    // is the builder saying it measured a greyscale texture and found nothing to multiply it
    // by, so white -- drawn untinted, exactly as today -- IS the right answer for it.
    const known = new Set(knownTintChannels())
    for (const channel of ['none', 'grass', 'water', 'foliage', 'grey']) {
      expect(known.has(channel)).toBe(true)
    }
  })
})
