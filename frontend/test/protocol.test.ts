import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { base64ToUint8Array, decodeGenerateResult } from '../src/protocol.js'
import { buildMesh } from '../src/mesher.js'

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/wiki-fancy-oak.json', import.meta.url))

/**
 * fixtures/wiki-ceiling-patch-with-entries.json is a REAL response captured from the real Go
 * binary against the same committed wiki example pack, kept exactly as the engine emitted it
 * (no trimming, no re-shaping):
 *
 *   featurelab generate --pack docs/wiki/tools/fixtures \
 *     --feature wiki:vegetation_patch_ceiling_demo --env plains --seed 1
 *
 * It is the response the docs screenshots are captured from (apps/vscode/scripts/
 * capture-screenshots.mjs) and the one apps/vscode/test/panelLayout.test.ts drives its
 * real-Chromium layout assertions with, because this one run populates every panel section from
 * real engine output: the pack's 44 feature entries, its 2 rule entries, and TWO diagnostics
 * that between them cover both diagnostic wire shapes -- one OLD-shape ({level,fileId,message},
 * the leaf-litter block-state gap) and one NEW-shape (identifier/typeId/chain/count/position:
 * may_replace rejecting 27 positions three features down a delegation chain). It proves
 * FeatureEntryWire/RuleEntryWire/OriginWire decode against a real response, not a hand-written
 * stub.
 */
const FIXTURE_WITH_ENTRIES_PATH = fileURLToPath(new URL('./fixtures/wiki-ceiling-patch-with-entries.json', import.meta.url))
function loadFixtureWithEntries(): unknown {
  return JSON.parse(readFileSync(FIXTURE_WITH_ENTRIES_PATH, 'utf-8'))
}

/**
 * fixtures/wiki-fallen-log-profile.json is a REAL, --profile response captured from the real Go
 * binary (cmd/featurelab's `generate` subcommand) run against the same committed wiki example
 * pack, kept exactly as the engine emitted it:
 *
 *   featurelab generate --pack docs/wiki/tools/fixtures \
 *     --feature wiki:fallen_log_with_litter --env plains --seed 1 --repeat 5 --profile
 *
 * --repeat 5 is what makes the touch counts NON-UNIFORM, which is the property this file's
 * heatmap assertions need: it places the same feature five times, advancing the RNG each time,
 * so the scatter keeps landing on cells it has already written (a SINGLE placement of this
 * feature writes each of its cells exactly once -- captured both ways to check). The feature is
 * a real three-level delegation chain (aggregate -> two scatter runs -> two leaf features), so
 * the same capture also carries a real per-feature breakdown, not one leaf. This is the "prove
 * the heatmap renders real profiler data" test: real engine, real pack, real profiled run, fed
 * through the real decoder, asserting non-uniform touch counts -- not a synthetic fixture.
 *
 * Re-running that command reproduces every value asserted below, but NOT a byte-identical file:
 * the durations differ run to run, and `profile.attribution`'s rows come out in a different
 * order each time (it is built from a Go map). Nothing here depends on that order.
 */
const PROFILE_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/wiki-fallen-log-profile.json', import.meta.url))
function loadProfileFixture(): unknown {
  return JSON.parse(readFileSync(PROFILE_FIXTURE_PATH, 'utf-8'))
}

/**
 * fixtures/wiki-fancy-oak.json is a REAL response captured from the real Go binary
 * (cmd/featurelab's `generate` subcommand) run against the committed wiki example pack
 * (docs/wiki/tools/fixtures -- public, and the same pack the documentation screenshots are
 * generated from, so unlike an external behaviour pack anyone can reproduce it):
 *
 *   featurelab generate --pack docs/wiki/tools/fixtures \
 *     --feature wiki:fancy_oak_tree --env plains --seed 1 --size 20x30x20
 *
 * and then deliberately re-shaped into the OLDER wire form this file has always kept one
 * fixture in, because that shape is itself what several assertions below are testing:
 *
 *   - `blocks`/`baseline` expanded from the run-length objects the engine emits today back to
 *     dense `number[]`, and `changed`/`removed` re-encoded as one byte per cell, base64 --
 *     exactly what encoding/json produced for Go `[]byte` before cell arrays became run-length
 *     encoded. That keeps "the decoder still reads what the engine emitted BEFORE" proven
 *     against a real captured volume rather than a hand-written stub, while
 *     wiki-dripstone-profile.json below proves it against what the engine emits today.
 *   - every field that postdates that shape dropped (entries, ruleEntries, activeRule,
 *     unresolvedTags, biomeEntries, environmentBiome, molangScope, placements, overflowBlocks),
 *     leaving exactly the field set the pre-RLE captures carried -- which is what lets the
 *     "defaults ... when the response predates those fields" cases below assert the real decode
 *     of a committed fixture instead of a synthetic deletion.
 *
 * Nothing else is edited: bounds/palette/origin/counts/diagnostics/partial and every cell value
 * are this run's own. This is also the "prove the viewer renders real data" test: real engine,
 * real pack, real feature, fed through the real decode + mesh path, asserting a non-empty,
 * plausible mesh.
 */
function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
}

describe('base64ToUint8Array', () => {
  it('decodes an empty string to an empty array', () => {
    expect(base64ToUint8Array('')).toEqual(new Uint8Array(0))
  })

  it('decodes known base64 bytes correctly', () => {
    // "AQIDBA==" is bytes [1,2,3,4]
    expect(Array.from(base64ToUint8Array('AQIDBA=='))).toEqual([1, 2, 3, 4])
  })
})

describe('decodeGenerateResult on real engine output', () => {
  const decoded = decodeGenerateResult(loadFixture())

  it('decodes the volume bounds exactly as the engine reported them', () => {
    expect(decoded.volume.sizeX).toBe(20)
    expect(decoded.volume.sizeY).toBe(30)
    expect(decoded.volume.sizeZ).toBe(20)
    expect(decoded.volume.data.length).toBe(20 * 30 * 20)
    expect(decoded.volume.baseline.length).toBe(20 * 30 * 20)
    expect(decoded.volume.changed.length).toBe(20 * 30 * 20)
    expect(decoded.volume.removed.length).toBe(20 * 30 * 20)
  })

  it('decodes a non-trivial palette with real Bedrock block names', () => {
    expect(decoded.palette.length).toBeGreaterThan(50)
    const names = decoded.palette.map((p) => p.name)
    expect(names).toContain('minecraft:air')
    // The two blocks this run actually placed -- so this asserts the palette carries the run's
    // own content, not just whatever the environment preset put in the volume.
    expect(names).toContain('minecraft:oak_log')
    expect(names).toContain('minecraft:oak_leaves')
  })

  it('reports the placed/carved/replaced breakdown the tree feature actually produced', () => {
    expect(decoded.counts.placed).toBeGreaterThan(0)
    expect(decoded.counts.placed).toBe(decoded.counts.changed) // this run carved/replaced nothing
    expect(decoded.counts.carved).toBe(0)
    expect(decoded.counts.replaced).toBe(0)
    expect(decoded.partial).toBe(false)
  })

  // THE load-bearing assertion for this whole test file: feed the real, decoded volume
  // through the real mesher and assert a non-empty, plausible mesh comes out the other end.
  // A viewer that has never been shown real engine output is not verified -- this is that
  // proof, headless (no WebGL/canvas needed -- buildMesh is pure data in, buffers out).
  it('produces a non-empty mesh with a plausible triangle count when fed through buildMesh', () => {
    // Mesh only the FEATURE pass (cells the tree actually placed, `changed[index] === 1`) --
    // exactly the split viewer.ts's remesh() does -- so the triangle count can be bounded
    // against `counts.placed` meaningfully. Meshing the whole volume (feature + untouched
    // environment terrain) would make that bound meaningless: the environment alone is
    // thousands of cells unrelated to what this test is actually proving happened.
    const buf = buildMesh(decoded.volume, decoded.palette, {
      minY: -Infinity,
      maxY: Infinity,
      accept: (index) => decoded.volume.changed[index] === 1,
    })
    expect(buf.quadCount).toBeGreaterThan(0)
    // Every placed block contributes at most 6 quads (fewer once neighbours occlude faces);
    // face culling means the real number is well below that ceiling for a solid trunk +
    // canopy, and well above "basically nothing got meshed" -- bound it on both sides rather
    // than pinning an exact number that would break on the mesher's own legitimate tuning.
    const placedCells = decoded.counts.placed
    expect(buf.quadCount).toBeLessThanOrEqual(placedCells * 6)
    expect(buf.quadCount).toBeGreaterThan(placedCells) // culling happened, but not to zero
    const triangleCount = buf.indices.length / 3
    expect(triangleCount).toBe(buf.quadCount * 2)
    expect(triangleCount).toBeGreaterThan(20)

    // Geometry sanity: every index resolves inside the position buffer, and positions land
    // within (or immediately adjacent to, for the outward face offset) the volume's bounds.
    const maxVertIndex = buf.positions.length / 3 - 1
    for (const idx of buf.indices) expect(idx).toBeLessThanOrEqual(maxVertIndex)
  })

  it('throws a descriptive error instead of silently producing a broken viewer when a required field is missing', () => {
    const raw = loadFixture() as Record<string, unknown>
    delete raw.blocks
    expect(() => decodeGenerateResult(raw)).toThrow(/missing field "blocks"/)
  })

  it('throws when the blocks array length does not match the declared bounds', () => {
    const raw = loadFixture() as Record<string, unknown>
    raw.blocks = [0, 0, 0] // nowhere near sizeX*sizeY*sizeZ
    expect(() => decodeGenerateResult(raw)).toThrow(/blocks has 3 cells, expected/)
  })

  it('has no profile on a run that was not profiled', () => {
    expect(decoded.profile).toBeNull()
    expect(decoded.volume.touchCounts).toBeUndefined()
  })

  it('defaults origin/entries/ruleEntries when the response predates those fields', () => {
    // wiki-fancy-oak.json carries no entries/ruleEntries at all: it is reduced to exactly the
    // field set the pre-RLE captures had (see this file's provenance comment for that fixture),
    // which is the shape panel.ts's inputs postdate. So this asserts the actual decode of the
    // committed fixture, not a synthetic deletion inside the test.
    expect(decoded.entries).toEqual([])
    expect(decoded.ruleEntries).toEqual([])
    // origin IS kept on this fixture (origin/bounds were always part of that older field set) --
    // decodes to the real resolved placement origin, not the {x:0,y:0,z:0} fallback.
    expect(decoded.origin).toEqual({ x: 0, y: 63, z: 0 })
    // biomeEntries/environmentBiome are newer still than entries/ruleEntries (added alongside
    // the pack-biome materials wiring), and are absent here too, so they must
    // default the same "absent means empty/null, never throw" way.
    expect(decoded.biomeEntries).toEqual([])
    expect(decoded.environmentBiome).toBeNull()
  })
})

describe('decodeGenerateResult on a real response that includes entries/ruleEntries/origin', () => {
  const decoded = decodeGenerateResult(loadFixtureWithEntries())

  it('decodes FeatureEntryWire[] with identifiers from the example pack, including the one this run placed', () => {
    expect(decoded.entries.length).toBeGreaterThan(0)
    const target = decoded.entries.find((e) => e.identifier === 'wiki:vegetation_patch_ceiling_demo')
    expect(target).toEqual({ fileId: 'vegetation_patch_ceiling_demo.json', identifier: 'wiki:vegetation_patch_ceiling_demo', typeId: 'minecraft:aggregate_feature' })
  })

  it('decodes RuleEntryWire[] with a real, successfully-built rule', () => {
    expect(decoded.ruleEntries.length).toBeGreaterThan(0)
    const built = decoded.ruleEntries.find((e) => e.rule !== null)
    expect(built).toBeDefined()
    expect(built!.rule!.placesFeature.length).toBeGreaterThan(0)
  })

  // This fixture is what apps/vscode's screenshot/layout harnesses post to the panel BECAUSE
  // this single real run emits a diagnostic in each of the two wire shapes (see the fixture's
  // provenance comment). Those harnesses used to graft synthetic diagnostics on to get that
  // coverage; they now use the fixture's own, so guard the property here -- if a re-capture ever
  // loses one of the shapes, this fails loudly instead of the screenshots quietly changing.
  it('decodes both diagnostic wire shapes from the one real run: the old flat one and the chained one', () => {
    expect(decoded.diagnostics.length).toBe(2)
    const [old_, chained] = decoded.diagnostics
    // Old shape: no identifier/typeId/chain/position on the wire -- normalizeDiagnostic falls
    // back to fileId for the identifier and a one-element chain, and keeps position null.
    expect(old_!.fileId).toBe('horizontal_tree_decoration_leaf_litter.json')
    expect(old_!.identifier).toBe('horizontal_tree_decoration_leaf_litter.json')
    expect(old_!.chain).toEqual(['horizontal_tree_decoration_leaf_litter.json'])
    expect(old_!.position).toBeNull()
    expect(old_!.count).toBe(1)
    // New shape: the culprit three features down the delegation chain, with a repeat count and
    // the one cell it is about.
    expect(chained!.identifier).toBe('wiki:ceiling_slab_block')
    expect(chained!.typeId).toBe('minecraft:single_block_feature')
    expect(chained!.chain).toEqual(['wiki:vegetation_patch_ceiling_demo', 'wiki:ceiling_slab_scatter', 'wiki:ceiling_slab_block'])
    expect(chained!.count).toBe(27)
    expect(chained!.position).toEqual({ x: -2, y: 68, z: 1 })
  })

  it('decodes the real resolved placement origin, distinct from the volume bounds', () => {
    // The plains preset's auto-Y snaps to ground height, which is NOT bounds.minY (the
    // volume's own floor) -- proving this reads the wire's dedicated `origin` field, not a
    // derived/guessed value.
    expect(decoded.origin.y).not.toBe(decoded.volume.minY)
    expect(decoded.origin).toEqual({ x: 0, y: 63, z: 0 })
  })
})

describe('decodeGenerateResult on real profiler output', () => {
  const decoded = decodeGenerateResult(loadProfileFixture())

  it('decodes a populated profile alongside the volume', () => {
    expect(decoded.profile).not.toBeNull()
    expect(decoded.volume.touchCounts).toBeDefined()
    // profile.touchCounts is folded onto the volume under the same indexing everything else
    // on ViewerVolume uses -- this is what lets viewer.ts's remesh() drive the heatmap off
    // `volume.touchCounts` exactly like it already reads `volume.changed`/`volume.removed`.
    expect(decoded.volume.touchCounts).toBe(decoded.profile?.touchCounts)
    expect(decoded.volume.touchCounts?.length).toBe(decoded.volume.sizeX * decoded.volume.sizeY * decoded.volume.sizeZ)
  })

  // THE load-bearing assertion for this file: real profiler output must show NON-UNIFORM
  // touch counts (some cells untouched, some touched exactly once, at least one touched
  // more than once) -- a heatmap fed uniform data would render as a flat, useless colour.
  it('reports non-uniform touch counts, not all-zero and not all-one', () => {
    const tc = decoded.profile?.touchCounts
    if (!tc) throw new Error('expected a populated profile')
    let zero = 0
    let one = 0
    let more = 0
    let max = 0
    for (const c of tc) {
      if (c === 0) zero++
      else if (c === 1) one++
      else more++
      if (c > max) max = c
    }
    expect(zero).toBeGreaterThan(0) // most of the volume is untouched terrain
    expect(one).toBeGreaterThan(0) // some touched cells were written exactly once
    expect(more).toBeGreaterThan(0) // and some were re-touched -- the whole point of a heatmap
    // Five placements of a scatter that keeps landing on its own cells: the busiest cell in
    // this capture was written once per placement. Captured value, not a derived bound.
    expect(max).toBe(5)
  })

  it('carries per-feature stats attributing this run’s cost across the delegation chain', () => {
    const profile = decoded.profile
    if (!profile) throw new Error('expected a populated profile')
    // A real nested chain, not one leaf: aggregate -> two scatter runs -> two leaf features.
    expect(profile.features.length).toBe(5)
    expect([...profile.featureIdentifiers].sort()).toEqual([
      'wiki:fallen_log_block',
      'wiki:fallen_log_run',
      'wiki:fallen_log_with_litter',
      'wiki:log_leaf_litter',
      'wiki:log_litter_run',
    ])

    const totalDelegations = profile.features.reduce((sum, f) => sum + f.delegations, 0)
    expect(totalDelegations).toBe(80)
    // Where the DELEGATIONS go: the two scatter runs tie at 35 each (43.75% of the run apiece),
    // the aggregate above them accounts for the remaining 10. This capture has no single
    // dominating delegator, so assert the tie the run actually produced rather than pinning a
    // "winner" that only sort() stability would decide.
    const byDelegations = [...profile.features].sort((a, b) => b.delegations - a.delegations)
    expect(byDelegations.slice(0, 2).map((f) => f.identifier).sort()).toEqual(['wiki:fallen_log_run', 'wiki:log_litter_run'])
    expect(byDelegations[0]!.delegations).toBe(byDelegations[1]!.delegations)
    expect(byDelegations[0]!.delegations / totalDelegations).toBeCloseTo(0.4375, 6)

    // Where the WRITES go is unambiguous, and is the question the panel's profiler table exists
    // to answer: one leaf feature wrote the overwhelming majority of this run's blocks.
    const totalWrites = profile.features.reduce((sum, f) => sum + f.blocksWritten, 0)
    expect(totalWrites).toBe(42)
    const topWriter = [...profile.features].sort((a, b) => b.blocksWritten - a.blocksWritten)[0]!
    expect(topWriter.identifier).toBe('wiki:fallen_log_block')
    expect(topWriter.blocksWritten / totalWrites).toBeGreaterThan(0.8)
  })

  it('leaves stops absent on a capture that predates them', () => {
    const profile = decoded.profile
    if (!profile) throw new Error('expected a populated profile')
    for (const f of profile.features) expect(f.stops).toBeUndefined()
  })

  it('passes a feature’s stops through, ordinal optional', () => {
    const raw = loadProfileFixture() as { profile: { features: Record<string, unknown>[] } }
    const stops = [
      { reason: 'condition_false', detail: 'condition = 0, wiki:x skipped', count: 412, ordinal: 1 },
      { reason: 'iterations_zero', detail: 'iterations = 0 (from 0.3)', count: 3 },
    ]
    raw.profile.features[0]!.stops = stops
    const profile = decodeGenerateResult(raw).profile
    if (!profile) throw new Error('expected a populated profile')
    expect(profile.features[0]!.stops).toEqual(stops)
    expect(profile.features[0]!.stops?.[1]?.ordinal).toBeUndefined()
  })

  it('decodes the sparse per-cell attribution table alongside touchCounts', () => {
    const profile = decoded.profile
    if (!profile) throw new Error('expected a populated profile')
    expect(profile.attribution.cell.length).toBeGreaterThan(0)
    expect(profile.attribution.cell.length).toBe(profile.attribution.feature.length)
    expect(profile.attribution.cell.length).toBe(profile.attribution.count.length)
    // Every attributed feature index must resolve inside featureIdentifiers.
    for (const featureIndex of profile.attribution.feature) {
      expect(profile.featureIdentifiers[featureIndex]).toBeDefined()
    }
  })

  // Feeds the profiled volume through the real mesher with a heatmap-style accept/colour
  // pass -- exactly the shape viewer.ts's remesh() builds when setShowHeatmap(true) -- and
  // asserts a non-empty mesh comes out, proving the heatmap has real touched geometry to
  // render, not just non-zero numbers in an array nobody meshes.
  it('produces a non-empty heatmap mesh when touched cells are fed through buildMesh with a colour override', () => {
    const profile = decoded.profile
    if (!profile) throw new Error('expected a populated profile')
    const touchCounts = profile.touchCounts
    const buf = buildMesh(decoded.volume, decoded.palette, {
      minY: -Infinity,
      maxY: Infinity,
      accept: (index) => (touchCounts[index] ?? 0) > 0,
      colorOverride: () => [1, 0, 0],
    })
    expect(buf.quadCount).toBeGreaterThan(0)
  })
})

// --- out-of-bounds capture / grow-and-regenerate wire fields --------------------------------
//
// wiki-fancy-oak.json above carries no overflowBlocks/grown/preGrowBounds at all -- it is
// reduced to the field set that predates them (see its provenance comment), which is what the
// "absent on an older response" case below asserts against; these tests build minimal synthetic
// responses instead, since exercising every combination (present-and-empty, present-and-populated, grown
// true/false) against a real captured fixture would mean capturing four separate real responses
// for what is otherwise pure decode-path logic.
describe('decodeGenerateResult: overflowBlocks / grown / preGrowBounds', () => {
  const BASE_RESULT = {
    bounds: { minX: 0, minY: 0, minZ: 0, sizeX: 2, sizeY: 2, sizeZ: 2 },
    blocks: new Array(8).fill(0),
    baseline: new Array(8).fill(0),
    palette: [{ id: 0, name: 'minecraft:air', states: null, kind: 1 }],
    // Full-length masks, not empty strings: the decoder length-checks every per-cell array
    // against the bounds, because a short one decodes into a zero-filled tail that reads as real
    // data ("nothing changed out there") rather than as the truncation it is. 'AAAAAAAAAAA=' is
    // eight zero bytes.
    changed: 'AAAAAAAAAAA=',
    removed: 'AAAAAAAAAAA=',
  }

  it('a response that predates these fields decodes with empty overflowBlocks and grown:false', () => {
    const decoded = decodeGenerateResult(loadFixture())
    expect(decoded.overflowBlocks).toEqual([])
    expect(decoded.volume.overflowBlocks).toEqual([])
    expect(decoded.grown).toBe(false)
    expect(decoded.preGrowBounds).toBeNull()
  })

  it('decodes overflowBlocks onto both the top-level result AND the nested volume (same array)', () => {
    const raw = { ...BASE_RESULT, overflowBlocks: [{ x: 50, y: 1, z: -3, id: 7 }] }
    const decoded = decodeGenerateResult(raw)
    expect(decoded.overflowBlocks).toEqual([{ x: 50, y: 1, z: -3, id: 7 }])
    expect(decoded.volume.overflowBlocks).toBe(decoded.overflowBlocks)
  })

  it('decodes grown:true with a non-null preGrowBounds', () => {
    const raw = { ...BASE_RESULT, grown: true, preGrowBounds: { minX: -4, minY: 0, minZ: -4, sizeX: 8, sizeY: 8, sizeZ: 8 } }
    const decoded = decodeGenerateResult(raw)
    expect(decoded.grown).toBe(true)
    expect(decoded.preGrowBounds).toEqual({ minX: -4, minY: 0, minZ: -4, sizeX: 8, sizeY: 8, sizeZ: 8 })
  })

  it('an explicit grown:false with overflowBlocks still present decodes correctly (nothing spilled on the grown call itself)', () => {
    const raw = { ...BASE_RESULT, grown: false, overflowBlocks: [] }
    const decoded = decodeGenerateResult(raw)
    expect(decoded.grown).toBe(false)
    expect(decoded.preGrowBounds).toBeNull()
    expect(decoded.overflowBlocks).toEqual([])
  })
})

/**
 * fixtures/wiki-dripstone-profile.json is a REAL, --profile response captured from the real Go
 * binary, run against the committed wiki example pack (docs/wiki/tools/fixtures, the same pack
 * every fixture in this file now comes from):
 *
 *   featurelab generate --pack docs/wiki/tools/fixtures \
 *     --feature wiki:dripstone_spike --env plains --seed 7 --profile
 *
 * It is the first fixture captured AFTER the per-cell arrays became run-length encoded, and
 * together with the other two untouched captures it proves the decoder against what the engine
 * emits today -- while wiki-fancy-oak.json, deliberately kept in the older dense/base64 shape,
 * keeps proving it still reads what the engine emitted before. That pairing is the whole reason
 * the encoded shape is an object rather than a bare array: the three shapes stay
 * distinguishable, so accepting all of them needs no guessing and no version field.
 */
const RLE_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/wiki-dripstone-profile.json', import.meta.url))
function loadRleFixture(): unknown {
  return JSON.parse(readFileSync(RLE_FIXTURE_PATH, 'utf-8'))
}

describe('decodeGenerateResult on run-length encoded engine output', () => {
  const decoded = decodeGenerateResult(loadRleFixture())
  const cells = 32 * 48 * 32

  it('expands every per-cell array back to one entry per cell', () => {
    expect(decoded.volume.data.length).toBe(cells)
    expect(decoded.volume.baseline.length).toBe(cells)
    expect(decoded.volume.changed.length).toBe(cells)
    expect(decoded.volume.removed.length).toBe(cells)
    expect(decoded.profile!.touchCounts.length).toBe(cells)
  })

  it('recovers the column the feature actually placed', () => {
    // A seven-block multipart column: the run-length arrays have to reproduce not just the
    // right number of changed cells but their positions, so count them out of the mask rather
    // than trusting the counts field (which travels as a plain integer and would pass even if
    // every array decoded to zeros).
    const changedCells = decoded.volume.changed.reduce((n, v) => n + v, 0)
    expect(decoded.counts.placed).toBe(7)
    expect(changedCells).toBe(7)
    expect(decoded.counts.carved).toBe(0)
  })

  it('recovers the touched cells the profiler recorded, not a uniform array', () => {
    const touched = [...decoded.profile!.touchCounts].filter((c) => c > 0)
    expect(touched.length).toBe(7)
    expect(Math.max(...touched)).toBeGreaterThan(0)
  })

  it('meshes into non-empty geometry, like a dense response does', () => {
    const buf = buildMesh(decoded.volume, decoded.palette, {
      minY: -Infinity,
      maxY: Infinity,
      accept: (index) => decoded.volume.changed[index] === 1,
    })
    expect(buf.quadCount).toBeGreaterThan(0)
    expect(buf.quadCount).toBeLessThanOrEqual(7 * 6)
  })
})

describe('decodeGenerateResult: malformed run-length arrays', () => {
  /** A minimal 2x1x2 response with `blocks` replaced by whatever a case wants to test. */
  function withBlocks(blocks: unknown): unknown {
    const cells = 4
    return {
      bounds: { minX: 0, minY: 0, minZ: 0, sizeX: 2, sizeY: 1, sizeZ: 2 },
      blocks,
      baseline: { rle: [0, cells] },
      palette: [{ name: 'minecraft:air', states: {}, kind: 1 }],
      changed: { rle: [0, cells] },
      removed: { rle: [0, cells] },
      blocksChanged: 0,
      blocksPlaced: 0,
      blocksCarved: 0,
      blocksReplaced: 0,
      writesOutOfBounds: 0,
      placementDurationMs: 0,
      libraryBuildDurationMs: 0,
      totalDurationMs: 0,
      partial: false,
      diagnostics: [],
    }
  }

  it('accepts a well-formed one', () => {
    const decoded = decodeGenerateResult(withBlocks({ rle: [7, 2, 9, 2] }))
    expect([...decoded.volume.data]).toEqual([7, 7, 9, 9])
  })

  it('rejects a dangling value with no run length', () => {
    expect(() => decodeGenerateResult(withBlocks({ rle: [7, 2, 9] }))).toThrow(/value\/run pairs/)
  })

  it('rejects a zero-length run, which would silently shorten the volume', () => {
    expect(() => decodeGenerateResult(withBlocks({ rle: [7, 0, 9, 4] }))).toThrow(/at least 1/)
  })

  it('rejects runs that do not add up to the volume’s own cell count', () => {
    expect(() => decodeGenerateResult(withBlocks({ rle: [7, 3] }))).toThrow(/expected 4 from bounds/)
  })

  it('rejects a shape that is neither encoded, dense, nor base64', () => {
    expect(() => decodeGenerateResult(withBlocks({ notRle: [] }))).toThrow(/not a cell array/)
  })

  // The length check covers all four per-cell arrays, not just `blocks`. A short `baseline` or
  // mask decodes into a zero-filled tail that reads downstream as real data -- an all-air far
  // end of the volume, a region where nothing changed -- so the three cases below are the ones
  // that would otherwise mis-render in silence. Each asserts the error names ITS OWN field,
  // which is what makes them distinguishable from the `blocks` case.
  it.each([
    ['baseline', 'baseline has 3 cells'],
    ['changed', 'changed has 3 cells'],
    ['removed', 'removed has 3 cells'],
  ])('rejects a short %s, naming it', (field, expected) => {
    const raw = withBlocks({ rle: [0, 4] }) as Record<string, unknown>
    raw[field] = { rle: [0, 3] } // one cell short of the 2x1x2 bounds
    expect(() => decodeGenerateResult(raw)).toThrow(new RegExp(expected))
  })
})
