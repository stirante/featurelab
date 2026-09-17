// contentBounds.ts -- computes the bounding box of "occupied" cells in a ViewerVolume, for
// VoxelViewer.frameContent() (see viewer.ts's own doc comment on that method for why this
// exists: frameAll() fits the full volume bounds, air included, which for a typical volume
// (terrain only in the lower part of the box) leaves most of the frame empty).
//
// Pulled into its own module, separate from viewer.ts, purely so it can be unit-tested without
// a WebGL context (jsdom/node have neither) -- VoxelViewer itself needs a real canvas/GL
// context to construct at all, so nothing inside viewer.ts's own class is reachable from a
// plain vitest test. This module has no such dependency: it is pure data-in, data-out, exactly
// like mesher.ts's buildMesh (which this mirrors -- both build a palette-kind lookup and walk
// the same [minY,maxY]-clamped slice of the volume).
import type { BlockKind, ViewerPaletteEntry, ViewerVolume } from './viewer.js'

export interface ContentBoundsOpts {
  /** Current Y slice, world coordinates -- same meaning as VoxelViewer.setSlice's own
   * minY/maxY. The max-Y "cut from top" control changes what's actually visible, so a cell
   * outside [sliceMinY, sliceMaxY] must never count as occupied, or cutting away the top would
   * leave the camera framing empty space above the cut. */
  sliceMinY: number
  sliceMaxY: number
  /** VoxelViewer.getEnvironmentMode() !== 'hidden' -- whether the environment mesh pass is
   * currently drawing anything at all. An environment cell only counts as occupied while this
   * is true; a feature-changed cell counts regardless (the feature mesh pass is independent of
   * environment visibility). */
  environmentVisible: boolean
  /** VoxelViewer.getShowCarved() -- whether the translucent carved-overlay pass (baseline
   * shape at cells the feature carved to air) is currently drawing anything. */
  showCarved: boolean
  /** VoxelViewer.getShowOverflow() -- whether the out-of-bounds capture overlay
   * (ViewerVolume.overflowBlocks) is currently drawing anything. Unlike every other cell this
   * function considers, an overflow block sits OUTSIDE the volume's own [minY,maxY] extent by
   * definition, so it has no meaningful relationship to sliceMinY/sliceMaxY (there is no "cut
   * from top" concept for a block the bench never contained in the first place) -- when true,
   * every entry in `overflowBlocks` counts as occupied unconditionally, regardless of the
   * current Y slice. */
  showOverflow: boolean
  /** ViewerVolume.overflowBlocks -- see `showOverflow`'s own doc comment. */
  overflowBlocks?: readonly { x: number; y: number; z: number }[]
}

export interface ContentBounds {
  minX: number
  minY: number
  minZ: number
  /** Exclusive -- one past the highest occupied cell, so `maxX - minX` is a size, not an
   * index. Matches how `frameAll`'s own sizeX/sizeY/sizeZ are already sizes, not indices. */
  maxX: number
  maxY: number
  maxZ: number
}

/** Bounding box of cells actually worth looking at right now, or null when nothing is
 * (a placement refusal with the environment hidden and the carved overlay off, or an empty
 * slice range) -- see `ContentBoundsOpts`'s own field comments for exactly which cells count.
 * A cell's current id being air always excludes it UNLESS it's a carved cell being rendered by
 * the carved-overlay pass (that pass draws the cell's BASELINE shape, not its current air id) --
 * see `remesh` in viewer.ts for the three mesh passes this mirrors. */
export function computeOccupiedBounds(volume: ViewerVolume, palette: readonly ViewerPaletteEntry[], opts: ContentBoundsOpts): ContentBounds | null {
  const { minX, minY: volMinY, minZ, sizeX, sizeY, sizeZ, data, changed, removed } = volume
  const { sliceMinY, sliceMaxY, environmentVisible, showCarved, showOverflow, overflowBlocks } = opts

  let minXi = Infinity
  let minYi = Infinity
  let minZi = Infinity
  let maxXi = -Infinity
  let maxYi = -Infinity
  let maxZi = -Infinity
  let found = false

  // Out-of-bounds captured blocks first -- unconditional on the Y slice (see showOverflow's own
  // doc comment) and independent of whether the in-volume loop below finds anything at all, so
  // a placement that landed ENTIRELY out of bounds still frames on what it actually produced
  // instead of falling back to frameAll().
  if (showOverflow && overflowBlocks) {
    for (const b of overflowBlocks) {
      found = true
      if (b.x < minXi) minXi = b.x
      if (b.x + 1 > maxXi) maxXi = b.x + 1
      if (b.y < minYi) minYi = b.y
      if (b.y + 1 > maxYi) maxYi = b.y + 1
      if (b.z < minZi) minZi = b.z
      if (b.z + 1 > maxZi) maxZi = b.z + 1
    }
  }

  const loY = Math.max(sliceMinY, volMinY)
  const hiY = Math.min(sliceMaxY, volMinY + sizeY - 1)
  if (loY > hiY) return found ? { minX: minXi, minY: minYi, minZ: minZi, maxX: maxXi, maxY: maxYi, maxZ: maxZi } : null

  let maxId = 0
  for (const entry of palette) if (entry.id > maxId) maxId = entry.id
  const kindById: BlockKind[] = new Array(maxId + 1).fill('air')
  for (const entry of palette) kindById[entry.id] = entry.kind

  const layerStride = sizeX * sizeZ

  for (let ly = loY - volMinY; ly <= hiY - volMinY; ly++) {
    const wy = volMinY + ly
    for (let lz = 0; lz < sizeZ; lz++) {
      const wz = minZ + lz
      const rowBase = ly * layerStride + lz * sizeX
      for (let lx = 0; lx < sizeX; lx++) {
        const index = rowBase + lx
        let occupied = showCarved && removed[index] === 1
        if (!occupied) {
          const id = data[index] as number
          const kind = kindById[id] ?? 'air'
          if (kind !== 'air') occupied = changed[index] === 1 || environmentVisible
        }
        if (!occupied) continue

        found = true
        const wx = minX + lx
        if (wx < minXi) minXi = wx
        if (wx + 1 > maxXi) maxXi = wx + 1
        if (wy < minYi) minYi = wy
        if (wy + 1 > maxYi) maxYi = wy + 1
        if (wz < minZi) minZi = wz
        if (wz + 1 > maxZi) maxZi = wz + 1
      }
    }
  }

  if (!found) return null
  return { minX: minXi, minY: minYi, minZ: minZi, maxX: maxXi, maxY: maxYi, maxZ: maxZi }
}
