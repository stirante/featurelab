// statedBlocks.test.ts -- the state-keyed half of the atlas table: a block whose textures (or
// shape) depend on a block state. The engine files those rows under the canonical
// `name#k=v,k=v` key it interns a placed block under; this checks the renderer picks the right
// one, and -- just as important -- that a table with no such rows behaves exactly as before.
import { describe, expect, it } from 'vitest'
import { compileAtlas, FACES, FACE_COUNT } from '../src/mesher.js'
import { compileShapes } from '../src/shapes.js'
import { atlasBlockKey, indexStatedAtlasBlocks, lookupAtlasBlock } from '../src/protocol.js'
import type { AtlasTableWire, ViewerPaletteEntry } from '../src/index.js'
import { CELL_BLUE, CELL_BROWN, CELL_GREY_CHECKER, STUB_CELL, STUB_COLS, stubAtlasTable } from './fixtures/stubAtlas.js'

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

/** The stub table plus one pack block: a lamp whose default top is brown and whose lit row --
 * filed under the canonical key, exactly as `internal/packrender` emits it -- is the grey
 * checker, with a `cross` shape so the shape lookup is exercised on the same row. */
function tableWithLamp(): AtlasTableWire {
  const base = withSynthesizedWhite(stubAtlasTable())
  return {
    ...base,
    blocks: {
      ...base.blocks,
      'pack:lamp': {
        faces: { '*': CELL_BLUE, up: CELL_BROWN },
        render: 'opaque',
        shape: 'full_block',
      },
      'pack:lamp#pack:lit=true': {
        faces: { '*': CELL_BLUE, up: CELL_GREY_CHECKER },
        render: 'opaque',
        shape: 'cross',
      },
    },
  }
}

const AIR: ViewerPaletteEntry = { id: 0, name: 'minecraft:air', color: 0x000000, kind: 'air' }
const UNLIT: ViewerPaletteEntry = { id: 1, name: 'pack:lamp', color: 0x112233, kind: 'solid', states: { 'pack:lit': false } }
const LIT: ViewerPaletteEntry = { id: 2, name: 'pack:lamp', color: 0x112233, kind: 'solid', states: { 'pack:lit': true } }
const PLAIN: ViewerPaletteEntry = { id: 3, name: 'pack:lamp', color: 0x112233, kind: 'solid' }
/** The same block, placed by a descriptor that ALSO spelled out a state no permutation reads --
 * so it interns under a longer key than the engine emitted a row for. */
const LIT_PLUS: ViewerPaletteEntry = {
  id: 4,
  name: 'pack:lamp',
  color: 0x112233,
  kind: 'solid',
  states: { 'pack:lit': true, 'pack:facing': 'north' },
}

describe('atlasBlockKey', () => {
  it('is the engine\'s own canonical spelling: name alone, or name#k=v sorted by key', () => {
    expect(atlasBlockKey('pack:lamp')).toBe('pack:lamp')
    expect(atlasBlockKey('pack:lamp', null)).toBe('pack:lamp')
    expect(atlasBlockKey('pack:lamp', {})).toBe('pack:lamp')
    expect(atlasBlockKey('pack:lamp', { 'pack:lit': true })).toBe('pack:lamp#pack:lit=true')
    // Sorted by state name, not by insertion order -- the Go side sorts, so this must too or
    // the two spellings never meet.
    expect(atlasBlockKey('pack:lamp', { b: 1, a: false })).toBe('pack:lamp#a=false,b=1')
    // Numbers are plain decimal with no trailing ".0"; strings go through verbatim.
    expect(atlasBlockKey('x:y', { age: 3, axis: 'y' })).toBe('x:y#age=3,axis=y')
  })
})

describe('lookupAtlasBlock', () => {
  const table = tableWithLamp()
  const stated = indexStatedAtlasBlocks(table)

  it('prefers the state-keyed row over the name-only one', () => {
    expect(lookupAtlasBlock(table, stated, LIT.name, LIT.states)?.faces.up).toBe(CELL_GREY_CHECKER)
  })

  it('falls back to the name-only row for a state set with no row of its own', () => {
    expect(lookupAtlasBlock(table, stated, UNLIT.name, UNLIT.states)?.faces.up).toBe(CELL_BROWN)
    expect(lookupAtlasBlock(table, stated, PLAIN.name, PLAIN.states)?.faces.up).toBe(CELL_BROWN)
  })

  it('matches a row whose states are a SUBSET of the entry\'s, as the game applies a permutation', () => {
    expect(lookupAtlasBlock(table, stated, LIT_PLUS.name, LIT_PLUS.states)?.faces.up).toBe(CELL_GREY_CHECKER)
  })

  it('still answers undefined for a block the table says nothing about', () => {
    expect(lookupAtlasBlock(table, stated, 'pack:mystery', { a: 1 })).toBeUndefined()
  })

  it('is exactly today\'s lookup against a table that carries no stated rows at all', () => {
    const plain = withSynthesizedWhite(stubAtlasTable())
    const empty = indexStatedAtlasBlocks(plain)
    expect(empty.size).toBe(0)
    expect(lookupAtlasBlock(plain, empty, 'minecraft:dirt', { some: 'state' })).toBe(plain.blocks['minecraft:dirt'])
  })
})

describe('compileAtlas with state-keyed rows', () => {
  it('draws the lit and unlit lamps from different cells in the same palette', () => {
    const table = tableWithLamp()
    const { mesher } = compileAtlas(table, [AIR, UNLIT, LIT, PLAIN, LIT_PLUS], SYNTHESIZED_WHITE)
    const up = FACE_INDEX.up as number
    expect(mesher.cellForFace[LIT.id * FACE_COUNT + up]).toBe(CELL_GREY_CHECKER)
    expect(mesher.cellForFace[UNLIT.id * FACE_COUNT + up]).toBe(CELL_BROWN)
    expect(mesher.cellForFace[PLAIN.id * FACE_COUNT + up]).toBe(CELL_BROWN)
    expect(mesher.cellForFace[LIT_PLUS.id * FACE_COUNT + up]).toBe(CELL_GREY_CHECKER)
    // The faces the stated row did NOT override still come from its own "*", so the sides
    // agree across both rows.
    expect(mesher.cellForFace[LIT.id * FACE_COUNT + (FACE_INDEX.north as number)]).toBe(CELL_BLUE)
    expect(mesher.cellForFace[UNLIT.id * FACE_COUNT + (FACE_INDEX.north as number)]).toBe(CELL_BLUE)
  })
})

describe('compileShapes with state-keyed rows', () => {
  it('takes the shape from the SAME row the textures came from', () => {
    const table = tableWithLamp()
    const shapes = compileShapes(table, [AIR, UNLIT, LIT])
    // The unlit row is a plain full block, which compileShapes leaves null (the untouched
    // fast path); the lit row is a cross and gets a compiled shape.
    expect(shapes[UNLIT.id]).toBeNull()
    expect(shapes[LIT.id]).not.toBeNull()
  })
})
