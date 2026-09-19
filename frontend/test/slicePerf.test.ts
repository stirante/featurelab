// slicePerf.test.ts -- what dragging the Y cut costs, measured.
//
// Dragging a slice slider re-meshes. VoxelViewer.setSlice already coalesces the re-mesh to one
// per animation frame and panel.ts already debounces the localStorage write behind it, so the
// only question left is how expensive ONE re-mesh is -- and at bench sizes people actually use
// (48^3 is a common one, 96^3 is what "grow to fit" produces from it) the answer used to be
// "three full walks of the volume", two of which were avoidable:
//
//   - the carved overlay was gated on `removed.length > 0`, and `removed` is one byte per cell,
//     so the carved pass ran on every re-mesh of every result whether or not anything was carved;
//   - the feature pass walked the whole bench looking for the few thousand cells the run wrote.
//
// Both are fixed in remesh.ts (see its header). This file is the evidence, and the guard: it
// measures the OLD pass set and the NEW one against the same volume, in the same process, and
// fails if the new one stops being the faster of the two. Absolute milliseconds vary by machine
// and are printed rather than asserted -- a budget in absolute time either flakes on a slow CI
// box or is so loose it guards nothing. The RATIO is the claim, and it is a property of the
// algorithm rather than of the hardware.
import { describe, expect, it, afterAll } from 'vitest'
import { buildMesh, EMPTY_MESH_BUFFERS, type MeshBuffers } from '../src/mesher.js'
import { buildScenePasses, summarizeVolume } from '../src/remesh.js'
import type { ViewerPaletteEntry, ViewerVolume } from '../src/viewer.js'

const measured: Array<[label: string, value: string]> = []
function record(label: string, value: number, unit = 'ms'): number {
  measured.push([label, `${value.toFixed(1)} ${unit}`])
  return value
}

afterAll(() => {
  const width = Math.max(...measured.map(([label]) => label.length))
  const lines = measured.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)
  console.log(`\n--- slicePerf.test.ts: measured on this machine ---\n${lines.join('\n')}\n`)
})

/** The FASTEST of `runs` timings.
 *
 * apps/vscode/test/scale.test.ts takes the median, and is right to: it measures how long a user
 * waits, and a user waits for the contended case. This file measures which of two implementations
 * is cheaper, and for that the contention is noise -- strictly additive noise, so the fastest
 * sample is the least-polluted estimate of the cost itself. Vitest runs test files in parallel,
 * and under a full-suite run the median reversed this file's comparisons while the minimum did
 * not. */
function timeIt(runs: number, fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    const took = performance.now() - t
    if (took < best) best = took
  }
  return best
}

const AIR = 0
const STONE = 1
const DIRT = 2
const GRASS = 3
const LOG = 4
const LEAVES = 5

function palette(): ViewerPaletteEntry[] {
  return [
    { id: AIR, name: 'minecraft:air', color: 0x000000, kind: 'air' },
    { id: STONE, name: 'minecraft:stone', color: 0x7d7d7d, kind: 'solid' },
    { id: DIRT, name: 'minecraft:dirt', color: 0x8a5a3c, kind: 'solid' },
    { id: GRASS, name: 'minecraft:grass_block', color: 0x6a9451, kind: 'solid' },
    { id: LOG, name: 'minecraft:oak_log', color: 0x6b5638, kind: 'solid' },
    { id: LEAVES, name: 'minecraft:oak_leaves', color: 0x4a7942, kind: 'plant' },
  ]
}

/** A bench-shaped volume: terrain filling the lower half (stone, then dirt, then a grass
 * surface) and ONE tree standing on it, which is the shape of the overwhelming majority of real
 * previews -- a few thousand written cells inside a hundred thousand-cell bench.
 *
 * `carve` digs a small pit under the tree, for the carved-overlay half of the comparison. */
function makeBench(size: number, opts: { carve?: boolean } = {}): ViewerVolume {
  const cells = size * size * size
  const data = new Uint32Array(cells)
  const baseline = new Uint32Array(cells)
  const changed = new Uint8Array(cells)
  const removed = new Uint8Array(cells)
  const layer = size * size
  const surface = Math.floor(size / 2)
  const at = (x: number, y: number, z: number): number => y * layer + z * size + x

  for (let y = 0; y < surface; y++) {
    const id = y === surface - 1 ? GRASS : y > surface - 5 ? DIRT : STONE
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) data[at(x, y, z)] = id
  }
  baseline.set(data)

  const cx = size >> 1
  const cz = size >> 1
  const trunk = Math.max(5, Math.floor(size / 4))
  for (let i = 0; i < trunk; i++) {
    const idx = at(cx, surface + i, cz)
    data[idx] = LOG
    changed[idx] = 1
  }
  const canopyY = surface + trunk
  const r = 4
  for (let dy = -r; dy <= r; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy + dz * dz > r * r) continue
        const y = canopyY + dy
        if (y < 0 || y >= size) continue
        const idx = at(cx + dx, y, cz + dz)
        if (data[idx] !== AIR) continue
        data[idx] = LEAVES
        changed[idx] = 1
      }
    }
  }

  if (opts.carve === true) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = 1; dy <= 3; dy++) {
          const idx = at(cx + dx, surface - dy, cz + dz)
          data[idx] = AIR
          changed[idx] = 1
          removed[idx] = 1
        }
      }
    }
  }

  return { minX: 0, minY: 0, minZ: 0, sizeX: size, sizeY: size, sizeZ: size, data, baseline, changed, removed }
}

/** The pass set VoxelViewer.remesh built BEFORE remesh.ts existed, reproduced exactly: a feature
 * pass over the whole volume, an environment pass (built whether or not it was going to be
 * drawn), and a carved pass gated on `removed.length > 0` -- which is always true. */
function legacyPasses(volume: ViewerVolume, pal: readonly ViewerPaletteEntry[], sliceMinY: number, sliceMaxY: number): MeshBuffers[] {
  const changed = volume.changed
  const removed = volume.removed
  const feature = buildMesh(volume, pal, { minY: sliceMinY, maxY: sliceMaxY, accept: (index) => changed[index] === 1 })
  const environment = buildMesh(volume, pal, { minY: sliceMinY, maxY: sliceMaxY, accept: (index) => changed[index] !== 1 })
  const carved =
    removed.length > 0
      ? buildMesh({ ...volume, data: volume.baseline }, pal, { minY: sliceMinY, maxY: sliceMaxY, accept: (index) => removed[index] === 1 })
      : EMPTY_MESH_BUFFERS
  return [feature, environment, carved]
}

function newPasses(volume: ViewerVolume, pal: readonly ViewerPaletteEntry[], sliceMinY: number, sliceMaxY: number, environmentMode: 'solid' | 'hidden' = 'solid', precomputed?: ReturnType<typeof summarizeVolume>): MeshBuffers[] {
  // summarizeVolume is per-RESULT work (VoxelViewer.setVolume), not per-frame, so a timed drag
  // passes the summary it already has -- including it in a per-cut number would be measuring
  // something a drag never pays. Its own cost is measured separately at the end of this file.
  const summary = precomputed ?? summarizeVolume(volume)
  const passes = buildScenePasses({
    volume,
    palette: pal,
    summary,
    sliceMinY,
    sliceMaxY,
    environmentMode,
    showCarved: true,
    showHeatmap: false,
    showOverflow: true,
    attribution: { mask: null, cells: 0, bounds: null },
    atlas: null,
  })
  return [passes.feature, passes.environment, passes.carved]
}

/** Total quads across a pass set -- the geometry itself, which must not change. */
function quads(passes: readonly MeshBuffers[]): number {
  return passes.reduce((sum, p) => sum + p.quadCount, 0)
}

describe('a slice drag re-meshes less than it used to, and draws exactly the same thing', () => {
  // THE LOAD-BEARING ASSERTION. Everything below is about speed, and speed bought by drawing
  // something different is not a saving. A pass restricted to a box must produce the same quads
  // as the same pass over the whole bench, including at the box's own edges, where culling has
  // to keep consulting the neighbours OUTSIDE it.
  it('produces identical geometry to the unbounded passes, at every cut', () => {
    const pal = palette()
    const volume = makeBench(32, { carve: true })
    for (const [minY, maxY] of [
      [0, 31],
      [0, 20],
      [14, 31],
      [15, 18],
      [16, 16],
    ] as const) {
      const before = legacyPasses(volume, pal, minY, maxY)
      const after = newPasses(volume, pal, minY, maxY)
      expect(quads(after)).toBe(quads(before))
      // Not just the count: the actual vertex data, pass by pass.
      for (let i = 0; i < before.length; i++) {
        expect(Array.from(after[i]!.positions)).toEqual(Array.from(before[i]!.positions))
      }
    }
  })

  it('skips the carved pass entirely when the run carved nothing', () => {
    const pal = palette()
    const volume = makeBench(32)
    const summary = summarizeVolume(volume)
    expect(summary.carvedBounds).toBeNull()
    expect(newPasses(volume, pal, 0, 31)[2]!.quadCount).toBe(0)
    // And still draws it when there IS something -- the skip must be about the data, not about
    // the overlay having been quietly dropped.
    expect(summarizeVolume(makeBench(32, { carve: true })).carvedBounds).not.toBeNull()
    expect(newPasses(makeBench(32, { carve: true }), pal, 0, 31)[2]!.quadCount).toBeGreaterThan(0)
  })

  it('does not build the environment pass while the environment is hidden', () => {
    const pal = palette()
    const volume = makeBench(32)
    expect(newPasses(volume, pal, 0, 31, 'hidden')[1]!.quadCount).toBe(0)
    expect(newPasses(volume, pal, 0, 31, 'solid')[1]!.quadCount).toBeGreaterThan(0)
  })

  for (const size of [48, 96]) {
    it(`is faster than the old pass set on a ${String(size)}^3 bench`, () => {
      const pal = palette()
      const volume = makeBench(size)
      const top = size - 1
      // A drag is a sequence of cuts, not one -- timing a single mid-range cut would flatter
      // whichever implementation happens to be cheap there. These four span the range.
      const cuts: readonly (readonly [number, number])[] = [
        [0, top],
        [0, Math.floor(size * 0.75)],
        [0, Math.floor(size * 0.5)],
        [Math.floor(size * 0.25), Math.floor(size * 0.6)],
      ]
      const summary = summarizeVolume(volume)
      const legacy = (): void => {
        for (const [lo, hi] of cuts) legacyPasses(volume, pal, lo, hi)
      }
      const current = (): void => {
        for (const [lo, hi] of cuts) newPasses(volume, pal, lo, hi, 'solid', summary)
      }
      // BOTH warmed, and then ALTERNATED. buildMesh takes its `accept` as a callback, so its one
      // call site goes megamorphic as soon as it has seen a few different closures -- which means
      // whichever implementation runs second in a naive A-then-B benchmark is measured after the
      // other one has already spoiled the inline cache for it, and comes out slower for a reason
      // that has nothing to do with the code under test. (Measured: that alone reversed the sign
      // of this comparison at 96^3.) Warming both first, then interleaving the samples, leaves
      // them in the same state as each other.
      legacy()
      current()
      const beforeSamples: number[] = []
      const afterSamples: number[] = []
      for (let i = 0; i < 9; i++) {
        let t = performance.now()
        legacy()
        beforeSamples.push(performance.now() - t)
        t = performance.now()
        current()
        afterSamples.push(performance.now() - t)
      }
      // THE MINIMUM, not the median -- the one place in this repo where that is the right
      // statistic. Vitest runs test files in parallel, so a sample can be interrupted by another
      // worker at any moment; that noise is strictly additive, so the fastest sample of each side
      // is the cleanest estimate of what each side costs, and the median of a contended run
      // measures the machine rather than the code (measured: it reversed this comparison's sign
      // under full-suite load while the minimum did not). Both sides are sampled alternately, so
      // neither gets a quieter stretch of the machine than the other.
      const min = (xs: number[]): number => Math.min(...xs)
      const before = record(`${String(size)}^3 re-mesh, before`, min(beforeSamples) / cuts.length)
      const after = record(`${String(size)}^3 re-mesh, after`, min(afterSamples) / cuts.length)
      record(`${String(size)}^3 re-mesh, saved`, (1 - after / before) * 100, '%')
      // A deliberately loose floor: the claim is "meaningfully cheaper", and anything tighter is
      // a measurement of this machine rather than of the change.
      expect(after).toBeLessThan(before * 0.9)
    }, 60_000)

    it(`is dramatically faster with the environment hidden on a ${String(size)}^3 bench`, () => {
      const pal = palette()
      const volume = makeBench(size)
      const top = size - 1
      const runs = 5
      const solid = timeIt(runs, () => newPasses(volume, pal, 0, top, 'solid'))
      const hidden = record(`${String(size)}^3 re-mesh, terrain hidden`, timeIt(runs, () => newPasses(volume, pal, 0, top, 'hidden')))
      expect(hidden).toBeLessThan(solid * 0.5)
    }, 60_000)
  }

  // summarizeVolume is the one thing this change ADDS, and it runs once per result rather than
  // once per frame -- but "once per result" is still once per keystroke-debounced regenerate, so
  // it has to be cheap enough not to show up there either.
  it('pays for the boxes once per result, not once per frame', () => {
    const volume = makeBench(96)
    const summarize = record('96^3 summarizeVolume', timeIt(9, () => summarizeVolume(volume)))
    const pal = palette()
    const remesh = timeIt(9, () => newPasses(volume, pal, 0, 95))
    expect(summarize).toBeLessThan(remesh)
  }, 60_000)
})
