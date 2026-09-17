// contentBounds.test.ts -- exercises computeOccupiedBounds (contentBounds.ts), the fix for the
// reported "frameAll() fits the volume bounds, not the content" bug: a typical volume is
// 32x48x32 with terrain only in the lower part, so fitting the camera to the whole box leaves
// most of the frame empty air. These tests build small synthetic volumes (mirroring
// mesher.test.ts's own makeVolume helper) with a clear "terrain in the lower part, air above"
// shape and assert the computed bounds actually exclude that empty air -- see the
// "load-bearing" test below.
import { describe, expect, it } from 'vitest'
import { computeOccupiedBounds } from '../src/contentBounds.js'
import type { ViewerPaletteEntry, ViewerVolume } from '../src/viewer.js'

const AIR: ViewerPaletteEntry = { id: 0, name: 'minecraft:air', color: 0x000000, kind: 'air' }
const STONE: ViewerPaletteEntry = { id: 1, name: 'minecraft:stone', color: 0x888888, kind: 'solid' }
const WOOD: ViewerPaletteEntry = { id: 2, name: 'minecraft:wood', color: 0x6b4a2b, kind: 'solid' }
const PALETTE = [AIR, STONE, WOOD]

/** Same indexing/helper shape as mesher.test.ts's own makeVolume -- see that file's comment. */
function makeVolume(minX: number, minY: number, minZ: number, sizeX: number, sizeY: number, sizeZ: number) {
  const cells = sizeX * sizeY * sizeZ
  const data = new Uint32Array(cells)
  const baseline = new Uint32Array(cells)
  const changed = new Uint8Array(cells)
  const removed = new Uint8Array(cells)
  const layerStride = sizeX * sizeZ
  function index(x: number, y: number, z: number): number {
    return (y - minY) * layerStride + (z - minZ) * sizeX + (x - minX)
  }
  return {
    volume: { minX, minY, minZ, sizeX, sizeY, sizeZ, data, baseline, changed, removed } satisfies ViewerVolume,
    set(x: number, y: number, z: number, id: number): void {
      data[index(x, y, z)] = id
    },
    setBaseline(x: number, y: number, z: number, id: number): void {
      baseline[index(x, y, z)] = id
    },
    setChanged(x: number, y: number, z: number): void {
      changed[index(x, y, z)] = 1
    },
    setRemoved(x: number, y: number, z: number): void {
      removed[index(x, y, z)] = 1
    },
  }
}

const DEFAULT_OPTS = { sliceMinY: -Infinity, sliceMaxY: Infinity, environmentVisible: true, showCarved: true, showOverflow: false }

describe('computeOccupiedBounds', () => {
  // THE LOAD-BEARING ASSERTION: a volume shaped
  // like the real bug report (terrain only in the lower third, air above) must produce bounds
  // that stop at the terrain surface, not run all the way up to the volume's own top -- this is
  // the entire point of framing content instead of the volume.
  it('excludes empty air above terrain -- bounds stop at the terrain surface, not the volume top', () => {
    const { volume, set } = makeVolume(0, 0, 0, 8, 20, 8) // volume is 20 tall, terrain only y=0..3
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) for (let y = 0; y <= 3; y++) set(x, y, z, STONE.id)

    const bounds = computeOccupiedBounds(volume, PALETTE, DEFAULT_OPTS)
    expect(bounds).not.toBeNull()
    expect(bounds!.minY).toBe(0)
    expect(bounds!.maxY).toBe(4) // one past the highest occupied cell (y=3) -- NOT 20
    expect(bounds!.maxY).toBeLessThan(volume.sizeY)
  })

  it('returns the full occupied extent (min and max) across X/Y/Z, not just one axis', () => {
    const { volume, set } = makeVolume(-2, 10, -2, 6, 6, 6)
    set(-2, 10, -2, STONE.id) // one corner
    set(3, 15, 3, STONE.id) // opposite corner
    const bounds = computeOccupiedBounds(volume, PALETTE, DEFAULT_OPTS)
    expect(bounds).toEqual({ minX: -2, minY: 10, minZ: -2, maxX: 4, maxY: 16, maxZ: 4 })
  })

  it('respects the current Y slice (max-Y cut) -- a cell above the cut does not count even though it exists in the data', () => {
    const { volume, set, setChanged } = makeVolume(0, 0, 0, 4, 20, 4)
    set(0, 0, 0, STONE.id) // environment terrain, low
    set(0, 15, 0, WOOD.id) // feature block, high up
    setChanged(0, 15, 0)

    const unsliced = computeOccupiedBounds(volume, PALETTE, DEFAULT_OPTS)
    expect(unsliced!.maxY).toBe(16) // includes the high feature block

    const sliced = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, sliceMaxY: 5 })
    expect(sliced!.maxY).toBe(1) // the high block is cut away by the slice -- must not be framed
  })

  it('a changed cell counts only when environment is visible for a plain (non-carved) environment cell', () => {
    const { volume, set } = makeVolume(0, 0, 0, 4, 4, 4)
    set(1, 1, 1, STONE.id) // ordinary environment terrain, not changed by the feature

    expect(computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, environmentVisible: true })).not.toBeNull()
    expect(computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, environmentVisible: false })).toBeNull()
  })

  it('a feature-changed cell counts regardless of environment visibility', () => {
    const { volume, set, setChanged } = makeVolume(0, 0, 0, 4, 4, 4)
    set(1, 1, 1, WOOD.id)
    setChanged(1, 1, 1)

    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, environmentVisible: false })
    expect(bounds).toEqual({ minX: 1, minY: 1, minZ: 1, maxX: 2, maxY: 2, maxZ: 2 })
  })

  it('a carved (removed) cell counts only when showCarved is on, even though its current id is air', () => {
    const { volume, setBaseline, setRemoved } = makeVolume(0, 0, 0, 4, 4, 4)
    setBaseline(2, 2, 2, STONE.id) // baseline shape -- current `data` at this cell is still air (default)
    setRemoved(2, 2, 2)

    expect(computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, showCarved: true })).toEqual({ minX: 2, minY: 2, minZ: 2, maxX: 3, maxY: 3, maxZ: 3 })
    expect(computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, showCarved: false })).toBeNull()
  })

  it('a changed cell whose current id is air and is NOT a carved cell does not count -- it renders nothing', () => {
    // changed=1 with the current id left as air (0) and removed=0: not a real generator output
    // (a real carve also sets removed=1), but exercises the "changed doesn't automatically mean
    // visible" rule in isolation -- see contentBounds.ts's own doc comment.
    const { volume, setChanged } = makeVolume(0, 0, 0, 4, 4, 4)
    setChanged(1, 1, 1) // data stays air (id 0)
    expect(computeOccupiedBounds(volume, PALETTE, DEFAULT_OPTS)).toBeNull()
  })

  it('returns null for the placement-refusal case: nothing changed, environment hidden, nothing carved', () => {
    const { volume, set } = makeVolume(0, 0, 0, 8, 8, 8)
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) set(x, 0, z, STONE.id) // terrain exists...
    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, environmentVisible: false, showCarved: false })
    expect(bounds).toBeNull() // ...but nothing is currently visible, so there is nothing to fit
  })

  it('returns null when the slice range excludes the entire volume', () => {
    const { volume, set } = makeVolume(0, 0, 0, 4, 4, 4)
    set(1, 1, 1, STONE.id)
    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, sliceMinY: 100, sliceMaxY: 200 })
    expect(bounds).toBeNull()
  })

  // --- out-of-bounds capture overlay (ViewerVolume.overflowBlocks) -----------------------------

  it('an out-of-bounds captured block counts as occupied when showOverflow is on, even outside the volume extent', () => {
    const { volume } = makeVolume(0, 0, 0, 4, 4, 4) // nothing placed inside the volume at all
    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, showOverflow: true, overflowBlocks: [{ x: 50, y: 2, z: -10 }] })
    expect(bounds).toEqual({ minX: 50, minY: 2, minZ: -10, maxX: 51, maxY: 3, maxZ: -9 })
  })

  it('an out-of-bounds captured block does not count when showOverflow is off', () => {
    const { volume } = makeVolume(0, 0, 0, 4, 4, 4)
    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, showOverflow: false, overflowBlocks: [{ x: 50, y: 2, z: -10 }] })
    expect(bounds).toBeNull()
  })

  it('overflow blocks are unaffected by the current Y slice -- there is no "cut from top" concept outside the bench', () => {
    const { volume } = makeVolume(0, 0, 0, 4, 4, 4)
    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, showOverflow: true, overflowBlocks: [{ x: 50, y: 200, z: 0 }], sliceMinY: 0, sliceMaxY: 5 })
    expect(bounds).toEqual({ minX: 50, minY: 200, minZ: 0, maxX: 51, maxY: 201, maxZ: 1 })
  })

  it('overflow blocks merge with ordinary in-volume content into one combined bounding box', () => {
    const { volume, set, setChanged } = makeVolume(0, 0, 0, 4, 4, 4)
    set(1, 1, 1, WOOD.id)
    setChanged(1, 1, 1)
    const bounds = computeOccupiedBounds(volume, PALETTE, { ...DEFAULT_OPTS, showOverflow: true, overflowBlocks: [{ x: 20, y: 1, z: 1 }] })
    expect(bounds).toEqual({ minX: 1, minY: 1, minZ: 1, maxX: 21, maxY: 2, maxZ: 2 })
  })
})
