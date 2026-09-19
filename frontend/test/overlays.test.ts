// overlays.test.ts -- the three questions a preview's overlays have to answer without a GPU:
// which writer owns which cell, what each colour on screen means, and what the block under the
// pointer is.
//
// All three used to live inside VoxelViewer, where they could only be exercised through a WebGL
// context, which is to say: not at all in this package's own suite. They are pure functions in
// remesh.ts now (the same split cameraFit.ts and contentBounds.ts already document), so what is
// left in the viewer is three.js bookkeeping.
import { describe, expect, it } from 'vitest'
import { describeCellAt, describeLegend, internAttributionGroups } from '../src/remesh.js'
import { attributionColorCss, attributionColorPacked, ATTRIBUTION_SERIES_LENGTH } from '../src/colors.js'
import type { AttributionGroupState, ViewerPaletteEntry, ViewerVolume } from '../src/viewer.js'

const AIR = 0
const STONE = 1
const LOG = 2

function makeVolume(): ViewerVolume {
  // 4x4x4 at world origin (10, 20, 30) -- a non-zero origin on every axis, deliberately: a cell
  // index computed against the wrong corner is exactly the bug this shape catches.
  const cells = 64
  const data = new Uint32Array(cells)
  const baseline = new Uint32Array(cells)
  const changed = new Uint8Array(cells)
  const removed = new Uint8Array(cells)
  // y=0 is stone throughout; one log at local (1, 1, 2), written by the run; one carved cell at
  // local (2, 0, 0).
  for (let i = 0; i < 16; i++) {
    data[i] = STONE
    baseline[i] = STONE
  }
  const log = 1 * 16 + 2 * 4 + 1
  data[log] = LOG
  changed[log] = 1
  const carved = 0 * 16 + 0 * 4 + 2
  data[carved] = AIR
  changed[carved] = 1
  removed[carved] = 1
  return { minX: 10, minY: 20, minZ: 30, sizeX: 4, sizeY: 4, sizeZ: 4, data, baseline, changed, removed }
}

function palette(): Map<number, ViewerPaletteEntry> {
  return new Map([
    [AIR, { id: AIR, name: 'minecraft:air', color: 0, kind: 'air' as const }],
    [STONE, { id: STONE, name: 'minecraft:stone', color: 0x7d7d7d, kind: 'solid' as const }],
    [LOG, { id: LOG, name: 'minecraft:oak_log', color: 0x6b5638, kind: 'solid' as const }],
  ])
}

describe('write attribution: more than one writer, told apart', () => {
  it('gives each writer its own colour index and counts what it owns', () => {
    const volume = makeVolume()
    const { attribution, groups } = internAttributionGroups(volume, [
      { id: 'wiki:trunk', label: 'wiki:trunk', cells: [0, 1, 2] },
      { id: 'wiki:canopy', label: 'wiki:canopy', cells: [16, 17] },
    ])
    expect(groups.map((g) => g.colorIndex)).toEqual([0, 1])
    expect(groups.map((g) => g.cells)).toEqual([3, 2])
    expect(attribution.cells).toBe(5)
    // The mask carries the GROUP, not a flat "attributed" bit -- that is what lets the mesher
    // paint two writers two colours in one pass.
    expect(attribution.mask![0]).toBe(1)
    expect(attribution.mask![16]).toBe(2)
    expect(attribution.mask![3]).toBe(0)
  })

  // Two features fighting over one cell is exactly the case somebody clicks a node to
  // understand, so it must not be resolved silently: a cell can only be painted once, and the
  // group that lost it is told how many it lost.
  it('gives an overlapped cell to the first writer that claimed it, and reports the loss', () => {
    const volume = makeVolume()
    const { attribution, groups } = internAttributionGroups(volume, [
      { id: 'first', label: 'first', cells: [0, 1, 2] },
      { id: 'second', label: 'second', cells: [1, 2, 3] },
    ])
    expect(groups[0]!.cells).toBe(3)
    expect(groups[0]!.overlapped).toBe(0)
    expect(groups[1]!.cells).toBe(1) // only cell 3 was still free
    expect(groups[1]!.overlapped).toBe(2)
    expect(attribution.mask![1]).toBe(1)
    expect(attribution.mask![2]).toBe(1)
    expect(attribution.mask![3]).toBe(2)
  })

  it('counts a cell a writer lists twice once, without calling it an overlap', () => {
    const volume = makeVolume()
    const { groups } = internAttributionGroups(volume, [{ id: 'a', label: 'a', cells: [5, 5, 5] }])
    expect(groups[0]!.cells).toBe(1)
    expect(groups[0]!.overlapped).toBe(0)
  })

  // A host posting a result and its attribution as two messages can race a regenerate. A stale
  // index must paint nothing rather than paint the wrong cell or take the preview down.
  it('skips indices that are not cells of this volume rather than throwing', () => {
    const volume = makeVolume()
    const { attribution, groups } = internAttributionGroups(volume, [{ id: 'a', label: 'a', cells: [-1, 64, 9999, 7, 1.5] }])
    expect(groups[0]!.cells).toBe(1)
    expect(attribution.cells).toBe(1)
    expect(attribution.mask![7]).toBe(1)
  })

  it('bounds the marked cells in world coordinates, so the mesher can skip the rest of the bench', () => {
    const volume = makeVolume()
    // local (1,0,0) -> cell 1; local (3,2,3) -> 2*16 + 3*4 + 3 = 47
    const { attribution } = internAttributionGroups(volume, [{ id: 'a', label: 'a', cells: [1, 47] }])
    expect(attribution.bounds).toEqual({ minX: 11, minY: 20, minZ: 30, maxX: 13, maxY: 22, maxZ: 33 })
  })

  // "Frame the cells THIS writer wrote" (a legend row activated from the keyboard -- see
  // viewportOverlay.ts's LegendEntry.onActivate) needs that writer's own extent, not the union
  // of everybody's, which is all the shared box above could offer.
  it('bounds each writer separately, counting only the cells that writer actually owns', () => {
    const volume = makeVolume()
    const { groups } = internAttributionGroups(volume, [
      { id: 'a', label: 'a', cells: [1] },
      // 47 is its own; 1 was already claimed by 'a', so it is overlap and must NOT stretch b's
      // box back to the corner 'a' owns.
      { id: 'b', label: 'b', cells: [1, 47] },
    ])
    expect(groups[0]!.bounds).toEqual({ minX: 11, minY: 20, minZ: 30, maxX: 11, maxY: 20, maxZ: 30 })
    expect(groups[1]!.bounds).toEqual({ minX: 13, minY: 22, minZ: 33, maxX: 13, maxY: 22, maxZ: 33 })
    expect(groups[1]!.overlapped).toBe(1)
    // A writer that owns nothing has no box, which is what stops it being offered as something
    // to frame.
    const { groups: quiet } = internAttributionGroups(volume, [{ id: 'q', label: 'q', cells: [] }])
    expect(quiet[0]!.bounds).toBeNull()
  })

  it('reports an empty answer as an empty answer, not as "never asked"', () => {
    const volume = makeVolume()
    const { attribution, groups } = internAttributionGroups(volume, [{ id: 'quiet', label: 'quiet', cells: [] }])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.cells).toBe(0)
    expect(attribution.cells).toBe(0)
    expect(attribution.bounds).toBeNull()
  })

  it('keeps the single-writer colour exactly what it always was, and never hands two writers one colour', () => {
    // The one-writer case must look unchanged: the first entry is the blue-violet the overlay has
    // used since it existed.
    expect(attributionColorCss(0)).toBe('#6b73ff')
    const seen = new Set<number>()
    for (let i = 0; i < ATTRIBUTION_SERIES_LENGTH; i++) seen.add(attributionColorPacked(i))
    expect(seen.size).toBe(ATTRIBUTION_SERIES_LENGTH)
    // Past the end it cycles rather than throwing -- a bad index is a host bug that should show
    // up as two writers sharing a colour, not as a preview that fails to draw.
    expect(attributionColorPacked(ATTRIBUTION_SERIES_LENGTH)).toBe(attributionColorPacked(0))
    // None of them is a warm hue: the carved (#ff5a3c), overflow (#ff26d9) and highlight
    // (#ffcc00) overlays already own that half of the wheel.
    for (let i = 0; i < ATTRIBUTION_SERIES_LENGTH; i++) {
      const c = attributionColorPacked(i)
      const r = (c >> 16) & 0xff
      const b = c & 0xff
      const g = (c >> 8) & 0xff
      expect(r).toBeLessThan(Math.max(g, b) + 40)
    }
  })
})

describe('the legend says what each colour on screen means, and nothing else', () => {
  const group = (over: Partial<AttributionGroupState> = {}): AttributionGroupState => ({ id: 'a', label: 'wiki:trunk', cells: 12, overlapped: 0, colorIndex: 0, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, ...over })
  const base = { attributionGroups: [], showCarved: true, hasCarved: false, showOverflow: true, overflowCount: 0, showHeatmap: false, maxTouchCount: 0, carvedTint: 0xff5a3c }

  // THE RULE THAT KEEPS IT FROM BEING FURNITURE. An ordinary preview of a feature that only
  // places blocks has no overlay colours, so it must have no legend at all.
  it('is empty when nothing but ordinary geometry is drawn', () => {
    expect(describeLegend(base)).toEqual([])
    // Carved ON but nothing carved is still nothing to explain.
    expect(describeLegend({ ...base, showCarved: true, hasCarved: false })).toEqual([])
    // And the lens being off hides the entry even when there IS something.
    expect(describeLegend({ ...base, showCarved: false, hasCarved: true })).toEqual([])
  })

  it('names one row per writer, in the writer’s own colour, with its block count', () => {
    const entries = describeLegend({ ...base, attributionGroups: [group(), group({ label: 'wiki:canopy', cells: 1284, colorIndex: 1 })] })
    expect(entries.map((e) => e.label)).toEqual(['wiki:trunk', 'wiki:canopy'])
    expect(entries.map((e) => e.swatch)).toEqual([attributionColorCss(0), attributionColorCss(1)])
    expect(entries.map((e) => e.detail)).toEqual(['12 blocks', '1,284 blocks'])
  })

  it('says "the selected node" rather than inventing a name for an unlabelled writer', () => {
    const entries = describeLegend({ ...base, attributionGroups: [group({ label: '' })] })
    expect(entries[0]!.label).toBe('written by the selected node')
  })

  it('leaves out a writer that wrote nothing, and explains a writer that lost cells to another', () => {
    const entries = describeLegend({ ...base, attributionGroups: [group({ cells: 0 }), group({ label: 'wiki:canopy', cells: 4, overlapped: 9, colorIndex: 1 })] })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toContain('9 more cell(s)')
    expect(entries[0]!.title).toContain('first writer listed keeps it')
  })

  // The legend named every writer and counted its blocks in plain text -- so the palette was
  // never colour-alone -- but the rows were list items with no tab stop, which put that text out
  // of a keyboard's reach entirely, in a tool whose whole subject is which writer put what
  // where. Clicking a block was the only other route, and it needs a mouse.
  it('offers each writer as something to frame, and names the writer in the offer', () => {
    const framed: number[] = []
    const entries = describeLegend({
      ...base,
      onSelectWriter: (index) => framed.push(index),
      // The first writer owns nothing, so it has no row -- which is exactly the case where a
      // row index and a group index part company.
      attributionGroups: [group({ label: 'wiki:roots', cells: 0 }), group({ label: 'wiki:canopy', cells: 1284, colorIndex: 1 })],
      hasCarved: true,
    })
    expect(entries.map((e) => e.label)).toEqual(['wiki:canopy', 'carved'])
    // The callback carries the GROUP's index (1), not the row's (0).
    entries[0]!.onActivate!()
    expect(framed).toEqual([1])
    expect(entries[0]!.actionLabel).toBe('Frame and select the cells wiki:canopy wrote')
    // An overlay that is not a writer has nothing to select, so it stays a plain label rather
    // than becoming a control that would have to do nothing.
    expect(entries[1]!.onActivate).toBeUndefined()
  })

  it('offers nothing to frame when the host has no selection to make, or the writer no cells to frame', () => {
    // No callback at all: every row is a label, which is what a host without a selection model
    // should get.
    const plain = describeLegend({ ...base, attributionGroups: [group()] })
    expect(plain[0]!.onActivate).toBeUndefined()
    // A writer whose cells all went to an earlier claimant owns no box -- and a button that
    // moves the camera nowhere is worse than a label that never offered to.
    const unframeable = describeLegend({ ...base, onSelectWriter: () => undefined, attributionGroups: [group({ bounds: null })] })
    expect(unframeable[0]!.onActivate).toBeUndefined()
  })

  it('lists the carved, overflow and heatmap overlays only while each is actually drawing', () => {
    const entries = describeLegend({ ...base, hasCarved: true, overflowCount: 3, showHeatmap: true, maxTouchCount: 7 })
    expect(entries.map((e) => e.label)).toEqual(['carved', 'outside the bench', 'writes per cell'])
    expect(entries[0]!.swatch).toBe('#ff5a3c')
    expect(entries[1]!.detail).toBe('3 captured')
    // The heatmap is a ramp, so its swatch is the ramp -- sampled from the same heatColor every
    // cell is coloured by, not a hand-picked approximation of it.
    expect(Array.isArray(entries[2]!.swatch)).toBe(true)
    expect(entries[2]!.detail).toBe('1 → 7')
  })
})

describe('clicking a block: what it is and where', () => {
  it('names the block, its world position and its flat cell index', () => {
    const volume = makeVolume()
    const pick = describeCellAt(volume, palette(), 11, 21, 32)!
    expect(pick.blockName).toBe('minecraft:oak_log')
    expect(pick.cell).toBe(1 * 16 + 2 * 4 + 1)
    expect(pick).toMatchObject({ x: 11, y: 21, z: 32, blockId: LOG, kind: 'solid' })
  })

  // The third fact, and the one that most often ends the question: did THIS run put it there?
  it('distinguishes a block this run placed, one it carved, and the terrain it was placed into', () => {
    const volume = makeVolume()
    const pal = palette()
    expect(describeCellAt(volume, pal, 11, 21, 32)).toMatchObject({ placed: true, carved: false })
    expect(describeCellAt(volume, pal, 12, 20, 30)).toMatchObject({ placed: true, carved: true })
    expect(describeCellAt(volume, pal, 10, 20, 30)).toMatchObject({ placed: false, carved: false, blockName: 'minecraft:stone' })
  })

  it('answers null outside the bench on every axis, rather than indexing a neighbouring cell', () => {
    const volume = makeVolume()
    const pal = palette()
    for (const [x, y, z] of [
      [9, 20, 30],
      [10, 19, 30],
      [10, 20, 29],
      [14, 20, 30],
      [10, 24, 30],
      [10, 20, 34],
    ] as const) {
      expect(describeCellAt(volume, pal, x, y, z)).toBeNull()
    }
  })

  it('still answers for a block id the palette does not carry, rather than pretending it is air', () => {
    const volume = makeVolume()
    const pick = describeCellAt(volume, new Map(), 11, 21, 32)!
    expect(pick.blockId).toBe(LOG)
    expect(pick.blockName).toBe('')
  })
})
