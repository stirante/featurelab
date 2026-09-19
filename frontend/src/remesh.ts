// remesh.ts -- what a preview is made of, as a pure function of the result and the view
// settings: which geometry is drawn, what the overlay colours on it mean, and what any one cell
// of it is.
//
// Split out of VoxelViewer for the same reason cameraFit.ts and contentBounds.ts were: the
// decisions here are the ones worth testing, and testing them inside the viewer would mean a
// WebGL context. What is left in viewer.ts is the three.js half -- uploading these buffers into
// geometries, pointing meshes at materials, and owning the camera.
//
// # This file is where a slice drag is made affordable
//
// Dragging the Y cut re-runs everything here, once per animation frame (VoxelViewer.setSlice
// coalesces the calls; it cannot make one cheaper). So every pass this plans has to be able to
// say "nothing, and here is why" without walking the bench:
//
//   - THE ENVIRONMENT PASS IS SKIPPED WHILE THE ENVIRONMENT IS HIDDEN. It is the most expensive
//     pass by a wide margin -- the terrain is most of the non-air cells in a bench -- and the
//     mesh it produced while hidden was built, uploaded and then not drawn. The viewer re-meshes
//     when the mode changes, which is what keeps this from being visible as anything but speed.
//   - THE CARVED PASS IS SKIPPED WHEN NOTHING WAS CARVED, which is most runs. It used to be
//     gated on `removed.length > 0` -- and `removed` is one byte per cell of the volume, so that
//     test is true for every result that has ever existed. A whole extra walk of the bench, on
//     every frame of every drag, for an overlay with nothing to draw.
//   - EVERY PASS THAT CAN ONLY MATCH INSIDE A BOX IS GIVEN THAT BOX (`MesherOpts.bounds`). The
//     feature, carved, heatmap and attribution passes are all "the cells this run touched",
//     which on a typical bench is a small fraction of it in a small corner of it. The boxes are
//     computed ONCE per result (`summarizeVolume`), not per frame.
//
// None of the three changes a single triangle: the passes that do run are byte-identical to what
// they produced before, because face culling reads `volume.data` directly and is bounded by the
// volume rather than by any of this.
import { buildMesh, buildOverflowMesh, concatMeshBuffers, EMPTY_MESH_BUFFERS, PASS_TRANSLUCENT, type CompiledAtlas, type MeshBuffers } from './mesher.js'
import { attributionColor, attributionColorCss } from './colors.js'
import type { LegendEntry } from './ui/viewportOverlay.js'
import type { AttributionGroup, AttributionGroupState, BlockKind, EnvironmentMode, PickedCell, ViewerPaletteEntry, ViewerVolume } from './viewer.js'

/** An inclusive world-space box. Same shape `MesherOpts.bounds` takes. */
export interface CellBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

// Touch-count heatmap overlay: cool teal (touched once) through yellow to hot red (the cell's own
// maximum touch count this run). Lives here rather than in viewer.ts because the ramp is part of
// building the heatmap PASS, and nothing about it is a three.js concern.
const HEAT_COLD: readonly [number, number, number] = [0.1, 0.55, 0.55]
const HEAT_MID: readonly [number, number, number] = [0.95, 0.85, 0.15]
const HEAT_HOT: readonly [number, number, number] = [0.85, 0.1, 0.1]

// Out-of-bounds capture overlay (ViewerVolume.overflowBlocks): a vivid magenta/pink tint blended
// over each captured block's OWN real palette colour, so a captured block still reads as roughly
// the material it is while being unmistakably distinct from ordinary feature geometry, the carved
// overlay (warm orange) and the heatmap (teal to red).
const OVERFLOW_TINT: readonly [number, number, number] = [1.0, 0.15, 0.85]
const OVERFLOW_TINT_STRENGTH = 0.55

/** Maps a touch count's position within `[1, maxCount]` (t=0 at the coldest end) to an RGB
 * triple via a two-segment teal -> yellow -> red ramp -- see the constants above. */
export function heatColor(t: number): readonly [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t))
  const [a, b, u] = clamped < 0.5 ? [HEAT_COLD, HEAT_MID, clamped / 0.5] : [HEAT_MID, HEAT_HOT, (clamped - 0.5) / 0.5]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

/** Accumulates an inclusive world box one cell at a time. `box()` is null until something has
 * actually been added, which is the distinction every caller here depends on: "no cell matched"
 * and "one cell at the origin matched" are different answers. Exported because the attribution
 * overlay builds its own box the same way, as it interns a host's cell lists (viewer.ts). */
export class CellBoxBuilder {
  private minX = Infinity
  private minY = Infinity
  private minZ = Infinity
  private maxX = -Infinity
  private maxY = -Infinity
  private maxZ = -Infinity
  private any = false

  add(x: number, y: number, z: number): void {
    this.any = true
    if (x < this.minX) this.minX = x
    if (y < this.minY) this.minY = y
    if (z < this.minZ) this.minZ = z
    if (x > this.maxX) this.maxX = x
    if (y > this.maxY) this.maxY = y
    if (z > this.maxZ) this.maxZ = z
  }

  box(): CellBox | null {
    if (!this.any) return null
    return { minX: this.minX, minY: this.minY, minZ: this.minZ, maxX: this.maxX, maxY: this.maxY, maxZ: this.maxZ }
  }
}

/** Everything about a volume that every later re-mesh of it needs and none of them should have
 * to re-derive: whether each overlay has anything at all to draw, and the box it would draw in.
 *
 * Computed ONCE per result, in `VoxelViewer.setVolume`. A slice drag, a lens toggle and a
 * projection change all leave every field here true, which is exactly why it is worth computing
 * separately from the thing that runs sixty times a second.
 *
 * One pass over the cells, not three: `changed`, `removed` and `touchCounts` are all indexed the
 * same way, so asking all three questions of each cell costs one traversal and three array reads
 * rather than three traversals. */
export interface VolumeSummary {
  /** Box containing every cell the run wrote (`changed === 1`), or null if it wrote none. */
  changedBounds: CellBox | null
  /** Box containing every cell the run turned to air (`removed === 1`), or null if it carved
   * nothing -- which is the common case, and the one a whole pass used to be built for anyway. */
  carvedBounds: CellBox | null
  /** Box containing every cell with a non-zero write count, or null when the run was not
   * profiled (no `touchCounts`) or nothing was touched. */
  touchedBounds: CellBox | null
  /** Highest `touchCounts` value in the volume; 0 when there is none. The heatmap ramp is
   * normalized against this run's own maximum rather than a fixed scale. */
  maxTouchCount: number
}

export function summarizeVolume(volume: ViewerVolume): VolumeSummary {
  const { minX, minY, minZ, sizeX, sizeY, sizeZ, changed, removed, touchCounts } = volume
  const changedBox = new CellBoxBuilder()
  const carvedBox = new CellBoxBuilder()
  const touchedBox = new CellBoxBuilder()
  let maxTouchCount = 0
  const layerStride = sizeX * sizeZ
  for (let ly = 0; ly < sizeY; ly++) {
    for (let lz = 0; lz < sizeZ; lz++) {
      const rowBase = ly * layerStride + lz * sizeX
      for (let lx = 0; lx < sizeX; lx++) {
        const i = rowBase + lx
        const isChanged = changed[i] === 1
        const isRemoved = removed[i] === 1
        const touches = touchCounts === undefined ? 0 : (touchCounts[i] ?? 0)
        if (!isChanged && !isRemoved && touches === 0) continue
        const wx = minX + lx
        const wy = minY + ly
        const wz = minZ + lz
        if (isChanged) changedBox.add(wx, wy, wz)
        if (isRemoved) carvedBox.add(wx, wy, wz)
        if (touches > 0) {
          touchedBox.add(wx, wy, wz)
          if (touches > maxTouchCount) maxTouchCount = touches
        }
      }
    }
  }
  return { changedBounds: changedBox.box(), carvedBounds: carvedBox.box(), touchedBounds: touchedBox.box(), maxTouchCount }
}

/** The write-attribution overlay's current answer, as the viewer holds it: one byte per cell
 * naming which GROUP owns it (0 = none, n = `groups[n - 1]`), plus the box those cells sit in.
 * See `VoxelViewer.setAttributionGroups`. */
export interface AttributionState {
  mask: Uint8Array | null
  /** How many cells `mask` marks, across every group. */
  cells: number
  bounds: CellBox | null
}

export interface SceneInput {
  volume: ViewerVolume
  palette: readonly ViewerPaletteEntry[]
  summary: VolumeSummary
  sliceMinY: number
  sliceMaxY: number
  environmentMode: EnvironmentMode
  showCarved: boolean
  showHeatmap: boolean
  showOverflow: boolean
  attribution: AttributionState
  /** The compiled atlas when textures are ACTIVE (an atlas exists and the host asked for it),
   * null for flat-colour mode. */
  atlas: CompiledAtlas | null
}

/** One buffer per mesh the viewer owns. Every field is always present; a pass with nothing to
 * draw is `EMPTY_MESH_BUFFERS`, so the viewer's own upload loop has no special cases. */
export interface ScenePasses {
  feature: MeshBuffers
  featureTranslucent: MeshBuffers
  environment: MeshBuffers
  environmentTranslucent: MeshBuffers
  carved: MeshBuffers
  heatmap: MeshBuffers
  attribution: MeshBuffers
  overflow: MeshBuffers
}

export function buildScenePasses(input: SceneInput): ScenePasses {
  const { volume, palette, summary, sliceMinY, sliceMaxY, environmentMode, showCarved, showHeatmap, showOverflow, attribution, atlas } = input
  const changed = volume.changed
  const baseline = volume.baseline

  // Flat mode meshes exactly two passes, as it always has. Textured mode splits each of them in
  // two by the atlas' per-block render mode: everything opaque or cutout into the alpha-tested
  // pass, everything translucent into its own blended pass drawn afterwards. The split is done
  // through `accept` alone, so face CULLING is unaffected -- buildMesh always occludes against
  // the true neighbour data regardless of which pass is being built, which is what keeps the
  // inside of a lake unmeshed rather than turning into a stack of overlapping water quads the
  // moment water gets its own pass.
  const mesherAtlas = atlas?.mesher
  const translucentPass = atlas?.pass
  const isTranslucent = (id: number): boolean => translucentPass !== undefined && translucentPass[id] === PASS_TRANSLUCENT
  // A ghosted environment draws everything through one blended material, so routing its water
  // into a second blended pass would double-blend it -- see VoxelViewer.applyMaterials.
  const splitEnvironment = atlas !== null && environmentMode !== 'ghost'
  // Hidden means the mesh is not drawn at all, so building it is work whose only consumer is the
  // garbage collector. The viewer re-meshes on every change of this mode, so the geometry is
  // never stale when it comes back.
  const environmentDrawn = environmentMode !== 'hidden'

  const featureBounds = summary.changedBounds
  const feature =
    featureBounds === null
      ? EMPTY_MESH_BUFFERS
      : buildMesh(volume, palette, {
          minY: sliceMinY,
          maxY: sliceMaxY,
          bounds: featureBounds,
          accept: (index: number, id: number) => changed[index] === 1 && !isTranslucent(id),
          atlas: mesherAtlas,
        })
  const featureTranslucent =
    atlas === null || featureBounds === null
      ? EMPTY_MESH_BUFFERS
      : buildMesh(volume, palette, {
          minY: sliceMinY,
          maxY: sliceMaxY,
          bounds: featureBounds,
          accept: (index: number, id: number) => changed[index] === 1 && isTranslucent(id),
          atlas: mesherAtlas,
        })

  const environment = environmentDrawn
    ? buildMesh(volume, palette, {
        minY: sliceMinY,
        maxY: sliceMaxY,
        accept: (index: number, id: number) => changed[index] !== 1 && (!splitEnvironment || !isTranslucent(id)),
        atlas: mesherAtlas,
      })
    : EMPTY_MESH_BUFFERS
  const environmentTranslucent =
    environmentDrawn && splitEnvironment
      ? buildMesh(volume, palette, {
          minY: sliceMinY,
          maxY: sliceMaxY,
          accept: (index: number, id: number) => changed[index] !== 1 && isTranslucent(id),
          atlas: mesherAtlas,
        })
      : EMPTY_MESH_BUFFERS

  // Mesh the BASELINE volume (not the current one -- the current id at every removed cell is air
  // and carries no shape), restricted to cells `removed` marks. Neighbour occlusion is therefore
  // also evaluated against the baseline, which is what keeps this cheap for a large contiguous
  // carved region: two adjacent removed cells occlude each other's shared face exactly like two
  // adjacent solid blocks normally would, so only the carved region's outer boundary is meshed.
  const baselineVolume: ViewerVolume = { ...volume, data: baseline }
  const removed = volume.removed
  const carved =
    showCarved && summary.carvedBounds !== null
      ? buildMesh(baselineVolume, palette, {
          minY: sliceMinY,
          maxY: sliceMaxY,
          bounds: summary.carvedBounds,
          accept: (index: number) => removed[index] === 1,
        })
      : EMPTY_MESH_BUFFERS

  const paletteKind = kindById(palette)
  const isCurrentlyAir = (index: number): boolean => (paletteKind[volume.data[index] as number] ?? 'air') === 'air'

  const touchCounts = volume.touchCounts
  let heatmap = EMPTY_MESH_BUFFERS
  if (showHeatmap && touchCounts !== undefined && summary.maxTouchCount > 0 && summary.touchedBounds !== null) {
    const denom = Math.max(1, summary.maxTouchCount - 1)
    const colorOverride = (index: number): readonly [number, number, number] => heatColor(((touchCounts[index] ?? 0) - 1) / denom)
    // Pass 1: cells whose CURRENT id is non-air -- buildMesh already skips air cells on its own
    // before calling `accept`, so this pass needs no extra air check of its own.
    const current = buildMesh(volume, palette, {
      minY: sliceMinY,
      maxY: sliceMaxY,
      bounds: summary.touchedBounds,
      accept: (index: number) => (touchCounts[index] ?? 0) > 0,
      colorOverride,
    })
    // Pass 2: cells a feature touched but that ended up air in the CURRENT result (written, then
    // carved away again) -- meshed against baseline for shape, exactly like the carved overlay,
    // so a heavily-rewritten column that happens to net out to "nothing here" doesn't silently
    // vanish from the heatmap, which would defeat its whole purpose.
    const fromBaseline = buildMesh(baselineVolume, palette, {
      minY: sliceMinY,
      maxY: sliceMaxY,
      bounds: summary.touchedBounds,
      accept: (index: number) => (touchCounts[index] ?? 0) > 0 && isCurrentlyAir(index),
      colorOverride,
    })
    heatmap = concatMeshBuffers(current, fromBaseline)
  }

  const mask = attribution.mask
  let attributionBuf = EMPTY_MESH_BUFFERS
  if (mask !== null && attribution.cells > 0 && attribution.bounds !== null) {
    // The colour is the GROUP's, not one colour for "attributed" -- see setAttributionGroups.
    const colorOverride = (index: number): readonly [number, number, number] => attributionColor((mask[index] as number) - 1)
    // Two passes, exactly as the heatmap above and for exactly the same reason: a feature that
    // wrote a cell and then had it carved away again ends up air in the CURRENT result, and
    // buildMesh skips air before it ever calls `accept`. Meshing the baseline for those cells is
    // what keeps "this node wrote here" visible for a node whose work was later undone -- which
    // is precisely the case somebody is clicking a node to understand.
    const current = buildMesh(volume, palette, {
      minY: sliceMinY,
      maxY: sliceMaxY,
      bounds: attribution.bounds,
      accept: (index: number) => (mask[index] as number) > 0,
      colorOverride,
    })
    const fromBaseline = buildMesh(baselineVolume, palette, {
      minY: sliceMinY,
      maxY: sliceMaxY,
      bounds: attribution.bounds,
      accept: (index: number) => (mask[index] as number) > 0 && isCurrentlyAir(index),
      colorOverride,
    })
    attributionBuf = concatMeshBuffers(current, fromBaseline)
  }

  const overflowBlocks = volume.overflowBlocks
  const overflow =
    showOverflow && overflowBlocks !== undefined && overflowBlocks.length > 0
      ? buildOverflowMesh(overflowBlocks, palette, OVERFLOW_TINT, OVERFLOW_TINT_STRENGTH)
      : EMPTY_MESH_BUFFERS

  return { feature, featureTranslucent, environment, environmentTranslucent, carved, heatmap, attribution: attributionBuf, overflow }
}

/** `kind` per block id, as a dense array -- the same shape buildMesh builds for itself. Only the
 * two "did this cell end up as air" predicates above need it, and both are called per cell. */
function kindById(palette: readonly ViewerPaletteEntry[]): BlockKind[] {
  let maxId = 0
  for (const entry of palette) if (entry.id > maxId) maxId = entry.id
  const kinds: BlockKind[] = new Array(maxId + 1).fill('air')
  for (const entry of palette) kinds[entry.id] = entry.kind
  return kinds
}

// --- write attribution ------------------------------------------------------------------------

/** Turns the host's per-writer cell lists into the one-byte-per-cell mask the mesher reads, and
 * reports what each group actually ended up owning.
 *
 * Pure, and separate from the viewer, because the interesting parts are arithmetic: a cell index
 * has to survive the round trip to a world position and back, an index from a stale result has to
 * be dropped rather than paint the wrong cell, and a cell two writers both claim has to go to
 * exactly one of them and be COUNTED for the other. See VoxelViewer.setAttributionGroups for the
 * contract those three rules add up to. */
export function internAttributionGroups(
  volume: ViewerVolume,
  groups: readonly AttributionGroup[],
): { attribution: AttributionState; groups: AttributionGroupState[] } {
  const total = volume.sizeX * volume.sizeY * volume.sizeZ
  const mask = new Uint8Array(total)
  const state: AttributionGroupState[] = []
  const box = new CellBoxBuilder()
  // One box per group as well as the shared one: the legend's own rows are controls now (see
  // viewportOverlay.ts's LegendEntry.onActivate), and "frame the cells THIS writer wrote" needs
  // that writer's own extent, not the union of everybody's. Built from the cells the group
  // actually OWNS -- a cell an earlier writer claimed is counted in `overlapped` and is not part
  // of this writer's box, for the same reason it is not painted in this writer's colour.
  let groupBox = new CellBoxBuilder()
  const layer = volume.sizeX * volume.sizeZ
  let marked = 0
  // 255 groups is the mask's own ceiling (one byte per cell, 0 reserved for "nobody"). Nothing
  // realistic approaches it, and truncating is still better than wrapping one group's id onto
  // another group's colour.
  const limit = Math.min(groups.length, 255)
  for (let g = 0; g < limit; g++) {
    const group = groups[g] as AttributionGroup
    let own = 0
    let overlapped = 0
    for (let i = 0; i < group.cells.length; i++) {
      const cell = group.cells[i] as number
      if (!Number.isInteger(cell) || cell < 0 || cell >= total) continue
      if (mask[cell] !== 0) {
        // Already claimed -- by an earlier group, or by this one listing the same cell twice.
        // Only the former is worth reporting.
        if (mask[cell] !== g + 1) overlapped++
        continue
      }
      mask[cell] = g + 1
      own++
      marked++
      const y = Math.trunc(cell / layer)
      const rest = cell - y * layer
      const z = Math.trunc(rest / volume.sizeX)
      const wx = volume.minX + (rest - z * volume.sizeX)
      const wy = volume.minY + y
      const wz = volume.minZ + z
      box.add(wx, wy, wz)
      groupBox.add(wx, wy, wz)
    }
    state.push({ id: group.id, label: group.label, cells: own, overlapped, colorIndex: g, bounds: groupBox.box() })
    groupBox = new CellBoxBuilder()
  }
  return { attribution: { mask, cells: marked, bounds: box.box() }, groups: state }
}

// --- the legend -------------------------------------------------------------------------------

/** What the overlay colours currently on screen mean, in the order they should be listed.
 *
 * ONE ENTRY PER THING ACTUALLY DRAWN, which is the rule that keeps a legend from becoming
 * furniture: a preview of a feature that only places blocks has no overlay colours and therefore
 * no legend at all. Every colour here is read from the same table the geometry is painted from
 * (colors.ts, and the two tints below), never retyped, so a swatch cannot name a colour the
 * preview does not use. */
export interface LegendInput {
  attributionGroups: readonly AttributionGroupState[]
  showCarved: boolean
  /** Whether this run carved anything at all -- VolumeSummary.carvedBounds !== null. */
  hasCarved: boolean
  showOverflow: boolean
  overflowCount: number
  showHeatmap: boolean
  maxTouchCount: number
  /** The carved overlay's tint, packed 0xRRGGBB -- passed in rather than duplicated here,
   * because the MATERIAL that uses it lives in viewer.ts. */
  carvedTint: number
  /** Makes each WRITER row an actionable control -- "frame and select the cells this writer
   * wrote" (see viewportOverlay.ts's LegendEntry.onActivate for why the legend needed one).
   * Called with the writer's index into `attributionGroups`, so the caller never has to
   * re-derive which legend row is which group: the mapping is not one-to-one, because a group
   * that owns no cells has no row. Omitted leaves every row a plain label, which is what a host
   * with nothing to select should get. */
  onSelectWriter?: (groupIndex: number) => void
}

export function describeLegend(input: LegendInput): LegendEntry[] {
  const entries: LegendEntry[] = []
  const select = input.onSelectWriter
  for (let index = 0; index < input.attributionGroups.length; index++) {
    const group = input.attributionGroups[index] as AttributionGroupState
    if (group.cells === 0) continue
    // A writer with no extent cannot be framed, so it is not offered as a control -- a button
    // that does nothing is worse than a label that never claimed to.
    const actionable = select !== undefined && group.bounds !== null
    const name = group.label === '' ? 'written by the selected node' : group.label
    entries.push({
      swatch: attributionColorCss(group.colorIndex),
      // An unnamed single group is what setAttributionCells produces. Saying "the selected node"
      // is honest; inventing a name for it would not be.
      label: name,
      detail: `${group.cells.toLocaleString('en-US')} block${group.cells === 1 ? '' : 's'}`,
      ...(actionable
        ? {
            onActivate: (): void => {
              select(index)
            },
            actionLabel: `Frame and select the cells ${name} wrote`,
          }
        : {}),
      title:
        group.overlapped > 0
          ? `${group.overlapped.toLocaleString('en-US')} more cell(s) this writer touched are drawn in an earlier writer's colour — a cell can only be painted once, and the first writer listed keeps it.`
          : 'Cells this writer wrote in the run on screen.',
    })
  }
  if (input.showCarved && input.hasCarved) {
    entries.push({
      swatch: `#${input.carvedTint.toString(16).padStart(6, '0')}`,
      label: 'carved',
      detail: 'turned to air',
      title: 'Cells this run emptied, drawn as a translucent ghost of what used to be there.',
    })
  }
  if (input.showOverflow && input.overflowCount > 0) {
    entries.push({
      swatch: packedCss(OVERFLOW_TINT),
      label: 'outside the bench',
      detail: `${input.overflowCount.toLocaleString('en-US')} captured`,
      title: 'Writes that landed outside the bench and were captured rather than dropped.',
    })
  }
  if (input.showHeatmap && input.maxTouchCount > 0) {
    entries.push({
      // The ramp itself, sampled at its two ends and its middle -- the same heatColor every
      // touched cell is coloured by, so the gradient is the legend rather than a picture of one.
      swatch: [packedCss(heatColor(0)), packedCss(heatColor(0.5)), packedCss(heatColor(1))],
      label: 'writes per cell',
      detail: `1 → ${input.maxTouchCount.toLocaleString('en-US')}`,
      title: 'Each touched cell coloured by how many writes hit it, scaled to this run’s own hottest cell.',
    })
  }
  return entries
}

function packedCss(rgb: readonly [number, number, number]): string {
  const to = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`
}

// --- one cell -----------------------------------------------------------------------------------

/** What the cell at world (x, y, z) is, or null when it is outside the bench.
 *
 * The answer a click produces (VoxelViewer.onPick). Separate and pure because it is index
 * arithmetic against the same flat scheme everything else here uses, and index arithmetic that is
 * wrong by one is wrong in a way nobody notices by looking at a preview. */
export function describeCellAt(volume: ViewerVolume, paletteById: ReadonlyMap<number, ViewerPaletteEntry>, x: number, y: number, z: number): PickedCell | null {
  const lx = x - volume.minX
  const ly = y - volume.minY
  const lz = z - volume.minZ
  if (lx < 0 || ly < 0 || lz < 0 || lx >= volume.sizeX || ly >= volume.sizeY || lz >= volume.sizeZ) return null
  const cell = ly * volume.sizeX * volume.sizeZ + lz * volume.sizeX + lx
  const id = volume.data[cell] as number
  const entry = paletteById.get(id)
  return {
    x,
    y,
    z,
    cell,
    blockId: id,
    blockName: entry?.name ?? '',
    kind: entry?.kind ?? 'air',
    placed: volume.changed[cell] === 1,
    carved: volume.removed[cell] === 1,
  }
}
