import { describe, expect, it } from 'vitest'
import { buildMesh, buildOverflowMesh, concatMeshBuffers, EMPTY_MESH_BUFFERS, FACES } from '../src/mesher.js'
import type { ViewerPaletteEntry, ViewerVolume } from '../src/viewer.js'

const AIR: ViewerPaletteEntry = { id: 0, name: 'minecraft:air', color: 0x000000, kind: 'air' }
const STONE: ViewerPaletteEntry = { id: 1, name: 'minecraft:stone', color: 0x888888, kind: 'solid' }
const WATER: ViewerPaletteEntry = { id: 2, name: 'minecraft:water', color: 0x3f76e4, kind: 'liquid' }

/** Builds a dense ViewerVolume of the given size, every cell defaulting to air (id 0), plus
 * a `set(x,y,z,id)` helper addressing world-space coordinates against the volume's own
 * min corner -- mirrors the (y-minY)*sizeX*sizeZ + (z-minZ)*sizeX + (x-minX) indexing every
 * consumer of ViewerVolume.data assumes. */
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
    index,
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

const ACCEPT_ALL = () => true

describe('buildMesh', () => {
  it('produces zero geometry for an all-air volume', () => {
    const { volume } = makeVolume(0, 0, 0, 4, 4, 4)
    const buf = buildMesh(volume, [AIR], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    expect(buf.quadCount).toBe(0)
    expect(buf.positions.length).toBe(0)
    expect(buf.indices.length).toBe(0)
  })

  it('meshes a single isolated solid cell as exactly 6 quads (one per face, all exposed)', () => {
    const { volume, set } = makeVolume(0, 0, 0, 3, 3, 3)
    set(1, 1, 1, 1) // one stone cell in the middle, every neighbour is air
    const buf = buildMesh(volume, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    expect(buf.quadCount).toBe(6)
    expect(buf.positions.length / 3).toBe(24) // 4 verts/quad * 6
    expect(buf.indices.length).toBe(36) // 6 indices/quad * 6
  })

  // THE LOAD-BEARING ASSERTION: a solid NxNxN cuboid must cull every INTERNAL face between
  // two solid neighbours and mesh only its outer surface -- this is the entire reason the
  // mesher exists (measured at ~1% of total generation+render cost specifically because it
  // does NOT emit a naive 6-quads-per-cell mesh). For N=2 the outer surface is 6 faces * 4
  // unit squares per face = 24 quads; a naive unculled mesh would instead emit 8 cells * 6
  // faces = 48 quads, exactly double. If face culling ever regresses to "mesh everything",
  // this is the assertion that catches it.
  it('culls internal faces of a solid 2x2x2 cuboid down to its outer surface (24 quads, not 48)', () => {
    const { volume, set } = makeVolume(0, 0, 0, 2, 2, 2)
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) set(x, y, z, 1)
    const buf = buildMesh(volume, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    expect(buf.quadCount).toBe(24)
  })

  it('culls faces between two liquid cells but keeps a liquid cell exposed against air', () => {
    const { volume, set } = makeVolume(0, 0, 0, 2, 1, 1)
    set(0, 0, 0, 2) // water
    set(1, 0, 0, 2) // water, adjacent -- shared face should be culled
    const buf = buildMesh(volume, [AIR, STONE, WATER], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    // Two adjacent 1x1x1 water cells: 12 faces total minus the 2 culled internal faces = 10.
    expect(buf.quadCount).toBe(10)
  })

  it('restricts meshing to the given Y slice and treats the slice boundary as exposed', () => {
    const { volume, set } = makeVolume(0, 0, 0, 1, 3, 1)
    set(0, 0, 0, 1)
    set(0, 1, 0, 1)
    set(0, 2, 0, 1)
    // Full column, no slice: internal faces between the three stacked cells are culled. A
    // 1x1x3 column exposes 4 side faces per layer * 3 layers = 12, plus top + bottom = 14.
    const full = buildMesh(volume, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    expect(full.quadCount).toBe(14)

    // Slice to only y=1 (the middle cell): its top/bottom neighbours (y=0, y=2) are now
    // OUTSIDE the slice, so those faces must render as exposed even though the neighbour
    // cell itself is still solid stone -- this is the whole point of "cut from top".
    const sliced = buildMesh(volume, [AIR, STONE], { minY: 1, maxY: 1, accept: ACCEPT_ALL })
    expect(sliced.quadCount).toBe(6) // fully isolated within the slice: all 6 faces exposed
  })

  it('honours the accept callback (used to split a result into feature vs. environment passes) while still occluding against the true neighbour data', () => {
    const { volume, set, setChanged } = makeVolume(0, 0, 0, 2, 1, 1)
    set(0, 0, 0, 1)
    set(1, 0, 0, 1)
    setChanged(0, 0, 0) // only the first cell is "feature-placed"
    const featureBuf = buildMesh(volume, [AIR, STONE], {
      minY: -Infinity,
      maxY: Infinity,
      accept: (index) => volume.changed[index] === 1,
    })
    const envBuf = buildMesh(volume, [AIR, STONE], {
      minY: -Infinity,
      maxY: Infinity,
      accept: (index) => volume.changed[index] !== 1,
    })
    // accept only gates whether the CURRENT cell is meshed at all -- occlusion against a
    // neighbour always reads the neighbour's real block data, regardless of whether that
    // neighbour itself would pass accept. So the feature pass's cell (0,0,0) still has its
    // +X face culled by the (rejected, but still solid) neighbour at (1,0,0): 5 of its 6
    // faces are exposed, not 6. Symmetrically for the environment pass's cell (1,0,0).
    expect(featureBuf.quadCount).toBe(5)
    expect(envBuf.quadCount).toBe(5)
  })

  // Carved-volume path: mesh the BASELINE data restricted to `removed` cells, exactly how
  // viewer.ts's remesh() builds the carved overlay -- this is the "cells the feature removed,
  // drawn as a translucent volume" requirement, proven at the mesher level.
  it('meshes a carved cell from baseline data when its current id is air', () => {
    const { volume, setBaseline, setRemoved } = makeVolume(0, 0, 0, 3, 3, 3)
    setBaseline(1, 1, 1, 1) // was stone
    setRemoved(1, 1, 1) // now air (data defaults to 0/air) -- carved out
    const baselineVolume: ViewerVolume = { ...volume, data: volume.baseline }
    const carvedBuf = buildMesh(baselineVolume, [AIR, STONE], {
      minY: -Infinity,
      maxY: Infinity,
      accept: (index) => volume.removed[index] === 1,
    })
    expect(carvedBuf.quadCount).toBe(6)
    expect(carvedBuf.blockIds.every((id) => id === 1)).toBe(true)
  })

  // colorOverride: the touch-count heatmap overlay (viewer.ts's setShowHeatmap) colours cells
  // by write count rather than by palette material -- this is the mesher-level proof that the
  // override actually replaces the palette colour (still multiplied by the same per-face
  // shade) rather than being ignored.
  it('uses colorOverride in place of the palette colour when provided, still shaded per-face', () => {
    const { volume, set } = makeVolume(0, 0, 0, 3, 3, 3)
    set(1, 1, 1, 1) // stone, palette colour 0x888888
    const withoutOverride = buildMesh(volume, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    const withOverride = buildMesh(volume, [AIR, STONE], {
      minY: -Infinity,
      maxY: Infinity,
      accept: ACCEPT_ALL,
      colorOverride: () => [1, 0, 0],
    })
    expect(withOverride.quadCount).toBe(withoutOverride.quadCount)
    // Every vertex colour must differ from the un-overridden (palette-derived) colour --
    // proves the override actually replaced it rather than being silently dropped -- and the
    // top face (brightest, shade 1.0) must come out as pure red (1,0,0), confirming the
    // override value itself (not just "something changed") flows through, still multiplied
    // by the per-face shade rather than replacing shading entirely.
    for (let i = 0; i < withOverride.colors.length; i++) {
      expect(withOverride.colors[i]).not.toBe(withoutOverride.colors[i])
    }
    let foundPureRedFace = false
    for (let v = 0; v < withOverride.colors.length / 3; v++) {
      const [r, g, b] = [withOverride.colors[v * 3], withOverride.colors[v * 3 + 1], withOverride.colors[v * 3 + 2]]
      if (r === 1 && g === 0 && b === 0) foundPureRedFace = true
    }
    expect(foundPureRedFace).toBe(true)
  })

  it('grows its scratch buffers correctly past their initial capacity (many isolated cells)', () => {
    // Initial vertCap is 4096 (1024 quads) and indexCap is 6144 -- this volume's cell count
    // is chosen so the mesh exceeds both, forcing at least one buffer growth in each.
    const size = 30
    const { volume, set } = makeVolume(0, 0, 0, size, 1, size)
    for (let x = 0; x < size; x += 2) {
      for (let z = 0; z < size; z += 2) set(x, 0, z, 1)
    }
    const buf = buildMesh(volume, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    const cellCount = Math.ceil(size / 2) * Math.ceil(size / 2)
    expect(buf.quadCount).toBe(cellCount * 6) // every placed cell fully isolated -> 6 exposed faces
    expect(buf.positions.length).toBe(buf.quadCount * 4 * 3)
    expect(buf.indices.length).toBe(buf.quadCount * 6)
  })
})

describe('concatMeshBuffers', () => {
  it('offsets the second buffer indices by the first buffer vertex count', () => {
    const { volume: vA, set: setA } = makeVolume(0, 0, 0, 3, 3, 3)
    setA(1, 1, 1, 1)
    const a = buildMesh(vA, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })

    const { volume: vB, set: setB } = makeVolume(10, 0, 0, 3, 3, 3)
    setB(11, 1, 1, 1)
    const b = buildMesh(vB, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })

    const combined = concatMeshBuffers(a, b)
    expect(combined.quadCount).toBe(a.quadCount + b.quadCount)
    expect(combined.positions.length).toBe(a.positions.length + b.positions.length)
    expect(combined.indices.length).toBe(a.indices.length + b.indices.length)
    // Every index into combined.positions must be in range -- if the offset were wrong this
    // would go out of bounds (undefined reads) for b's contribution.
    const maxVertIndex = combined.positions.length / 3 - 1
    for (const idx of combined.indices) expect(idx).toBeLessThanOrEqual(maxVertIndex)
  })

  it('returns the other buffer unchanged when one side is empty', () => {
    const { volume, set } = makeVolume(0, 0, 0, 3, 3, 3)
    set(1, 1, 1, 1)
    const buf = buildMesh(volume, [AIR, STONE], { minY: -Infinity, maxY: Infinity, accept: ACCEPT_ALL })
    expect(concatMeshBuffers(EMPTY_MESH_BUFFERS, buf)).toBe(buf)
    expect(concatMeshBuffers(buf, EMPTY_MESH_BUFFERS)).toBe(buf)
  })
})

// buildOverflowMesh backs the out-of-bounds capture overlay (viewer.ts's setShowOverflow) --
// unlike buildMesh above, it walks a flat block list at absolute world positions rather than a
// volume grid, and never culls faces (no volume-wide neighbour structure to test against).
describe('buildOverflowMesh', () => {
  const NO_TINT: readonly [number, number, number] = [1, 0, 1]

  it('produces zero geometry for an empty block list', () => {
    const buf = buildOverflowMesh([], [STONE], NO_TINT, 0)
    expect(buf.quadCount).toBe(0)
    expect(buf.positions.length).toBe(0)
    expect(buf.indices.length).toBe(0)
  })

  it('emits exactly 6 quads (all faces, unconditionally -- no occlusion) for one block', () => {
    const buf = buildOverflowMesh([{ x: 5, y: 10, z: -3, id: STONE.id }], [STONE], NO_TINT, 0)
    expect(buf.quadCount).toBe(FACES.length)
    expect(buf.positions.length / 3).toBe(FACES.length * 4)
    expect(buf.indices.length).toBe(FACES.length * 6)
  })

  it('emits 6 quads per block for two ADJACENT blocks -- no shared-face culling like buildMesh has', () => {
    const buf = buildOverflowMesh(
      [
        { x: 0, y: 0, z: 0, id: STONE.id },
        { x: 1, y: 0, z: 0, id: STONE.id }, // touches the first block's +X face
      ],
      [STONE],
      NO_TINT,
      0,
    )
    expect(buf.quadCount).toBe(FACES.length * 2)
  })

  it('positions each block at its own absolute world coordinate, not relative to any volume origin', () => {
    const buf = buildOverflowMesh([{ x: 100, y: -20, z: 7, id: STONE.id }], [STONE], NO_TINT, 0)
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    for (let i = 0; i < buf.positions.length; i += 3) {
      minX = Math.min(minX, buf.positions[i] as number)
      minY = Math.min(minY, buf.positions[i + 1] as number)
      minZ = Math.min(minZ, buf.positions[i + 2] as number)
    }
    expect(minX).toBe(100)
    expect(minY).toBe(-20)
    expect(minZ).toBe(7)
  })

  it('tintStrength 0 uses the block’s own real palette colour, unblended', () => {
    const RED_STONE: ViewerPaletteEntry = { id: 3, name: 'test:red', color: 0xff0000, kind: 'solid' }
    const buf = buildOverflowMesh([{ x: 0, y: 0, z: 0, id: RED_STONE.id }], [RED_STONE], [0, 0, 1], 0)
    // Top face (shade 1.0, see mesher.ts's SHADE_TOP) carries the colour unshaded -- find any
    // vertex and check it reads pure red, not blended toward the blue tint.
    const maxR = Math.max(...Array.from({ length: buf.colors.length / 3 }, (_, i) => buf.colors[i * 3] as number))
    expect(maxR).toBeCloseTo(1, 5)
    const maxB = Math.max(...Array.from({ length: buf.colors.length / 3 }, (_, i) => buf.colors[i * 3 + 2] as number))
    expect(maxB).toBeCloseTo(0, 5)
  })

  it('tintStrength 1 uses the tint colour unblended, regardless of the block’s own palette colour', () => {
    const buf = buildOverflowMesh([{ x: 0, y: 0, z: 0, id: STONE.id }], [STONE], [0, 0, 1], 1)
    const maxB = Math.max(...Array.from({ length: buf.colors.length / 3 }, (_, i) => buf.colors[i * 3 + 2] as number))
    expect(maxB).toBeCloseTo(1, 5) // full-strength blue tint on the (brightest, top) face
  })

  it('falls back to the tint colour (not black) for a block id missing from the palette', () => {
    const buf = buildOverflowMesh([{ x: 0, y: 0, z: 0, id: 999 }], [STONE], [0, 1, 0], 0)
    // tintStrength 0 would normally leave the tint out entirely, but a palette MISS still
    // falls back to `tint` itself (see buildOverflowMesh's own doc comment) rather than
    // black -- the brightest (top) face should read as green, not (0,0,0).
    const maxG = Math.max(...Array.from({ length: buf.colors.length / 3 }, (_, i) => buf.colors[i * 3 + 1] as number))
    expect(maxG).toBeCloseTo(1, 5)
  })
})
