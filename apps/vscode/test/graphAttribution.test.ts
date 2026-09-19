// graphAttribution.test.ts -- covers attribution.ts and nodeStats.ts: the run-length decode on its
// own (all three wire shapes, and the malformed ones it has to refuse), cell<->position round
// trips, both directions of the attribution index, a cell several features wrote in sequence, the
// empty cases that are NOT faults, and a share calculation on a run that wrote nothing.
import { describe, expect, it, vi } from 'vitest'
import {
  AttributionIndex,
  RLE_MAX_CELLS,
  cellCount,
  cellIndexOf,
  cellPositionOf,
  createAttributionBridge,
  decodeCellArray,
  type AttributionSelection,
  type CellBounds,
  type ProfileWire,
} from '../src/graph/attribution.js'
import {
  DOMINANT_WRITE_SHARE,
  RULE_TYPE_ID,
  buildNodeStats,
  describeNodeRun,
  describeStop,
  explainNodeRun,
  formatCount,
  formatShare,
  isDominantWriter,
  nodeRunStats,
  rankByDelegations,
  rankByWrites,
  summarizeRun,
} from '../src/graph/nodeStats.js'

const BOUNDS: CellBounds = { minX: -8, minY: 60, minZ: -8, sizeX: 4, sizeY: 3, sizeZ: 5 }

/** Builds a profile the way the engine would: featureIdentifiers is index -> identifier, and the
 * attribution rows are in NO particular order, because the engine emits them in Go map order. */
function profileOf(
  identifiers: readonly string[],
  rows: readonly { cell: number; feature: number; count: number }[],
  features: ProfileWire['features'] = [],
): ProfileWire {
  return {
    featureIdentifiers: identifiers,
    features,
    attribution: {
      cell: rows.map((r) => r.cell),
      feature: rows.map((r) => r.feature),
      count: rows.map((r) => r.count),
    },
  }
}

describe('decodeCellArray', () => {
  it('expands value/run pairs into the dense array', () => {
    expect([...(decodeCellArray({ rle: [0, 3, 5, 2, 0, 1] }) as Int32Array)]).toEqual([0, 0, 0, 5, 5, 0])
  })

  it('round-trips an array the engine would have encoded', () => {
    const dense = [0, 0, 0, 0, 7, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3]
    // Encode the way rle.Marshal does, then decode: the encoding is exact, not lossy.
    const pairs: number[] = []
    let current = dense[0] as number
    let run = 1
    for (let i = 1; i < dense.length; i++) {
      if (dense[i] === current) {
        run++
        continue
      }
      pairs.push(current, run)
      current = dense[i] as number
      run = 1
    }
    pairs.push(current, run)
    expect(pairs).toEqual([0, 4, 7, 2, 1, 1, 0, 8, 3, 1])
    expect([...(decodeCellArray({ rle: pairs }) as Int32Array)]).toEqual(dense)
  })

  it('accepts the dense array older responses carry, unchanged', () => {
    expect([...(decodeCellArray([4, 4, 9]) as Int32Array)]).toEqual([4, 4, 9])
  })

  it('accepts the base64 mask the changed/removed arrays used to be', () => {
    // Go marshals a []byte{0,1,1,0,1} as this string.
    expect([...(decodeCellArray('AAEBAAE=') as Int32Array)]).toEqual([0, 1, 1, 0, 1])
  })

  it('decodes an absent array to null, NOT to an empty one', () => {
    // profile.touchCounts is genuinely absent on an unprofiled run; conflating that with a
    // zero-cell volume would make a missing array look like a valid answer.
    expect(decodeCellArray(null)).toBeNull()
    expect(decodeCellArray(undefined)).toBeNull()
    expect([...(decodeCellArray({ rle: [] }) as Int32Array)]).toEqual([])
  })

  it('refuses an odd number of pair elements', () => {
    expect(() => decodeCellArray({ rle: [0, 3, 5] })).toThrow(/whole number of value\/run pairs/)
  })

  it('refuses a run length below 1', () => {
    expect(() => decodeCellArray({ rle: [0, 0] })).toThrow(/must be at least 1/)
  })

  it('refuses run lengths that sum past any real volume, rather than allocating', () => {
    expect(() => decodeCellArray({ rle: [0, RLE_MAX_CELLS + 1] })).toThrow(/refusing to allocate/)
  })

  it('refuses a shape that is none of the three', () => {
    expect(() => decodeCellArray(42)).toThrow(/expected an object, an array or a base64 string/)
    expect(() => decodeCellArray({ notRle: [] })).toThrow(/"rle" array/)
  })
})

describe('cell indexing', () => {
  it('round-trips every cell in a volume', () => {
    for (let cell = 0; cell < cellCount(BOUNDS); cell++) {
      const pos = cellPositionOf(BOUNDS, cell)
      expect(pos).not.toBeNull()
      expect(cellIndexOf(BOUNDS, pos!)).toBe(cell)
    }
  })

  it('lays Y out as the outer axis, then Z, then X -- the engine ordering', () => {
    expect(cellIndexOf(BOUNDS, { x: -8, y: 60, z: -8 })).toBe(0)
    expect(cellIndexOf(BOUNDS, { x: -7, y: 60, z: -8 })).toBe(1)
    expect(cellIndexOf(BOUNDS, { x: -8, y: 60, z: -7 })).toBe(BOUNDS.sizeX)
    expect(cellIndexOf(BOUNDS, { x: -8, y: 61, z: -8 })).toBe(BOUNDS.sizeX * BOUNDS.sizeZ)
  })

  it('reports out of bounds rather than wrapping', () => {
    expect(cellIndexOf(BOUNDS, { x: -9, y: 60, z: -8 })).toBe(-1)
    expect(cellIndexOf(BOUNDS, { x: -8, y: 63, z: -8 })).toBe(-1)
    expect(cellPositionOf(BOUNDS, cellCount(BOUNDS))).toBeNull()
    expect(cellPositionOf(BOUNDS, -1)).toBeNull()
  })
})

describe('AttributionIndex', () => {
  it('builds both directions from the parallel arrays', () => {
    const profile = profileOf(
      ['wiki:trunk', 'wiki:leaves'],
      [
        { cell: 12, feature: 1, count: 1 },
        { cell: 4, feature: 0, count: 2 },
        { cell: 7, feature: 0, count: 1 },
        { cell: 12, feature: 0, count: 1 },
      ],
    )
    const index = AttributionIndex.fromProfile(profile, BOUNDS)

    // node -> cells, ascending, regardless of the order the rows arrived in.
    expect([...index.cellsWrittenBy('wiki:trunk')]).toEqual([4, 7, 12])
    expect([...index.cellsWrittenBy('wiki:leaves')]).toEqual([12])
    expect(index.writesBy('wiki:trunk')).toBe(4)
    expect(index.distinctCellsWrittenBy('wiki:trunk')).toBe(3)

    // cell -> nodes.
    expect(index.writersOf(4)).toEqual([{ nodeId: 'wiki:trunk', featureIndex: 0, writes: 2 }])
    expect(index.writersOf(99)).toEqual([])
  })

  it('resolves a world position through the bounds', () => {
    const cell = cellIndexOf(BOUNDS, { x: -6, y: 61, z: -5 })
    const index = AttributionIndex.fromProfile(profileOf(['wiki:a'], [{ cell, feature: 0, count: 3 }]), BOUNDS)
    expect(index.writersAt({ x: -6, y: 61, z: -5 })).toEqual([{ nodeId: 'wiki:a', featureIndex: 0, writes: 3 }])
    expect(index.entryAt({ x: -6, y: 61, z: -5 })).toMatchObject({ cell, position: { x: -6, y: 61, z: -5 }, writes: 3 })
    // Outside the volume is an ordinary click, not an error.
    expect(index.entryAt({ x: 500, y: 61, z: -5 })).toMatchObject({ cell: -1, writers: [], writes: 0 })
  })

  it('reports EVERY feature that wrote a cell, not just one', () => {
    // Three features write the same cell in sequence -- a sequence_feature whose entries overwrite
    // each other. The block a viewer sees belongs to whichever wrote last, and the wire table
    // carries counts with no sequence at all, so the honest report is all three.
    const profile = profileOf(
      ['wiki:first', 'wiki:second', 'wiki:third'],
      [
        { cell: 5, feature: 2, count: 1 },
        { cell: 5, feature: 0, count: 4 },
        { cell: 5, feature: 1, count: 2 },
      ],
    )
    const index = AttributionIndex.fromProfile(profile, BOUNDS)
    const writers = index.writersOf(5)
    expect(writers).toHaveLength(3)
    // Deterministic order: ascending feature index, which is the order features were first entered
    // across the whole run. Not "first" or "last" for this cell, and not presented as such.
    expect(writers.map((w) => w.nodeId)).toEqual(['wiki:first', 'wiki:second', 'wiki:third'])
    expect(writers.map((w) => w.writes)).toEqual([4, 2, 1])
    expect(index.entryOf(5).writes).toBe(7)
  })

  it('is empty, not broken, for an unprofiled run', () => {
    const index = AttributionIndex.fromProfile(null)
    expect(index.isEmpty).toBe(true)
    expect(index.rowCount).toBe(0)
    expect(index.byteLength).toBeGreaterThanOrEqual(0)
    expect([...index.cellsWrittenBy('wiki:anything')]).toEqual([])
    expect(index.writersOf(0)).toEqual([])
    expect(index.writesBy('wiki:anything')).toBe(0)
    expect(index.has('wiki:anything')).toBe(false)
  })

  it('is empty for a profile whose attribution table has no rows', () => {
    const index = AttributionIndex.fromProfile(profileOf(['wiki:a'], []), BOUNDS)
    expect(index.isEmpty).toBe(true)
    expect(index.nodeIds).toEqual(['wiki:a'])
    // A node the profile knows about that wrote nothing is the normal state of a filter.
    expect([...index.cellsWrittenBy('wiki:a')]).toEqual([])
    expect(index.distinctCellsWrittenBy('wiki:a')).toBe(0)
  })

  it('keeps a row whose feature index the identifier list does not cover, as an unnamed writer', () => {
    // A truncated response. The cell WAS written by something, and dropping the row would turn
    // that into "nothing wrote this", which is a different and wrong answer.
    const index = AttributionIndex.fromProfile(profileOf(['wiki:a'], [{ cell: 3, feature: 9, count: 1 }]), BOUNDS)
    expect(index.writersOf(3)).toEqual([{ nodeId: null, featureIndex: 1, writes: 1 }])
    expect([...index.cellsWrittenBy('wiki:a')]).toEqual([])
  })

  it('refuses parallel arrays of differing lengths', () => {
    expect(() =>
      AttributionIndex.fromProfile({
        featureIdentifiers: ['wiki:a'],
        attribution: { cell: [1, 2], feature: [0], count: [1, 1] },
      }),
    ).toThrow(/parallel arrays and must be the same length/)
  })

  it('costs 14 bytes per row plus the per-node offsets', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ cell: (i * 977) % 60, feature: i % 3, count: 1 }))
    const index = AttributionIndex.fromProfile(profileOf(['wiki:a', 'wiki:b', 'wiki:c'], rows), BOUNDS)
    expect(index.rowCount).toBe(1000)
    expect(index.byteLength).toBe(14 * 1000 + 4 * (3 + 2))
  })

  it('sorts correctly across a volume large enough to exercise every radix pass', () => {
    // Cell indices spread past 2^16 so the two upper byte passes actually run, and rows handed in
    // deliberately unsorted, the way Go map iteration hands them over.
    const identifiers = ['wiki:a', 'wiki:b', 'wiki:c', 'wiki:d']
    const rows: { cell: number; feature: number; count: number }[] = []
    for (let i = 0; i < 20_000; i++) {
      rows.push({ cell: (i * 104_729) % 1_000_003, feature: i % identifiers.length, count: (i % 5) + 1 })
    }
    const index = AttributionIndex.fromProfile(profileOf(identifiers, rows), null)
    expect(index.rowCount).toBe(20_000)

    for (const id of identifiers) {
      const cells = index.cellsWrittenBy(id)
      const expected = rows.filter((_, i) => identifiers[i % identifiers.length] === id).map((r) => r.cell)
      expect(cells.length).toBe(expected.length)
      expect([...cells]).toEqual([...expected].sort((a, b) => a - b))
      for (let i = 1; i < cells.length; i++) expect(cells[i]! >= cells[i - 1]!).toBe(true)
    }

    // Spot-check the reverse direction against the raw table.
    for (const probe of [rows[0]!, rows[7777]!, rows[19_999]!]) {
      const writers = index.writersOf(probe.cell)
      expect(writers.some((w) => w.nodeId === identifiers[probe.feature] && w.writes === probe.count)).toBe(true)
    }
  })
})

describe('createAttributionBridge', () => {
  const profile = profileOf(
    ['wiki:trunk', 'wiki:leaves'],
    [
      { cell: 4, feature: 0, count: 2 },
      { cell: 4, feature: 1, count: 1 },
      { cell: 9, feature: 0, count: 1 },
    ],
  )

  it('emits a node selection carrying that node\'s cells', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    const seen: AttributionSelection[] = []
    bridge.onSelect((s) => seen.push(s))
    bridge.selectNode('wiki:trunk')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'node', nodeId: 'wiki:trunk', writes: 3 })
    expect([...(seen[0] as { cells: Uint32Array }).cells]).toEqual([4, 9])
  })

  it('emits a cell selection carrying every writer', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    const listener = vi.fn()
    bridge.onSelect(listener)
    bridge.selectCell(4)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]![0]).toMatchObject({
      kind: 'cell',
      cell: 4,
      writes: 3,
      writers: [
        { nodeId: 'wiki:trunk', writes: 2 },
        { nodeId: 'wiki:leaves', writes: 1 },
      ],
    })
  })

  it('selects a node that wrote nothing rather than refusing -- an empty highlight is the answer', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    const selection = bridge.selectNode('wiki:filter_that_never_places')
    expect(selection).toMatchObject({ kind: 'node', nodeId: 'wiki:filter_that_never_places', writes: 0 })
    expect([...(selection as { cells: Uint32Array }).cells]).toEqual([])
  })

  it('does not re-emit an identical selection, so a two-way wiring cannot ping-pong', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    const listener = vi.fn()
    bridge.onSelect(listener)
    bridge.selectNode('wiki:trunk')
    bridge.selectNode('wiki:trunk')
    bridge.selectCell(4)
    bridge.selectCell(4)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('setSelection applies without emitting -- the other half of the loop break', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    const listener = vi.fn()
    bridge.onSelect(listener)
    bridge.setSelection({ kind: 'node', nodeId: 'wiki:leaves', cells: new Uint32Array([4]), writes: 1 })
    expect(listener).not.toHaveBeenCalled()
    expect(bridge.getSelection()).toMatchObject({ nodeId: 'wiki:leaves' })
  })

  it('clears the selection for a position outside the previewed volume', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    bridge.selectNode('wiki:trunk')
    expect(bridge.selectPosition({ x: 9999, y: 0, z: 0 })).toBeNull()
    expect(bridge.getSelection()).toBeNull()
  })

  it('unsubscribes, and an unsubscribe during a notification does not change who hears that one', () => {
    const bridge = createAttributionBridge(AttributionIndex.fromProfile(profile, BOUNDS))
    const second = vi.fn()
    const off = bridge.onSelect(() => off())
    bridge.onSelect(second)
    bridge.selectNode('wiki:trunk')
    expect(second).toHaveBeenCalledTimes(1)
    bridge.selectNode('wiki:leaves')
    expect(second).toHaveBeenCalledTimes(2)
  })
})

describe('nodeStats', () => {
  const profile: ProfileWire = {
    featureIdentifiers: ['wiki:tree', 'wiki:scatter', 'wiki:trunk'],
    features: [
      { identifier: 'wiki:tree', typeId: 'minecraft:tree_feature', entered: 4, blocksWritten: 600, delegations: 8, selfMs: 3, inclusiveMs: 9 },
      { identifier: 'wiki:scatter', typeId: 'minecraft:scatter_feature', entered: 1, blocksWritten: 0, delegations: 4, selfMs: 1, inclusiveMs: 10 },
      { identifier: 'wiki:trunk', typeId: 'minecraft:single_block_feature', entered: 400, blocksWritten: 400, delegations: 0, selfMs: 2, inclusiveMs: 2 },
    ],
    attribution: { cell: [1, 2, 3], feature: [0, 0, 2], count: [400, 200, 400] },
  }

  it('totals the run', () => {
    expect(summarizeRun(profile)).toMatchObject({ blocksWritten: 1000, entered: 405, delegations: 12, features: 3, partial: false })
  })

  it('computes a node\'s share of the run\'s writes', () => {
    const totals = summarizeRun(profile)
    const tree = nodeRunStats(profile, 'wiki:tree', {}, totals)
    expect(tree.activity).toBe('wrote')
    expect(tree.writeShare).toBeCloseTo(0.6)
    expect(isDominantWriter(tree, totals)).toBe(true)
    // WRITES, and the noun is the assertion. The preview panel beside this one reports the same
    // run's PLACED figure, which counts CELLS -- 79 against 110 on a measured run -- and while
    // both said "blocks" the two panels contradicted each other about one run in plain words.
    expect(describeNodeRun(tree, totals)).toBe("Performed 600 writes in this run (60% of the run's 1,000), entered 4 times.")
    expect(describeNodeRun(tree, totals)).not.toMatch(/blocks/)
  })

  it('reports a budget share separately from a run share', () => {
    const options = { writeBudget: 4_000_000 }
    const totals = summarizeRun(profile, options)
    const tree = nodeRunStats(profile, 'wiki:tree', options, totals)
    // 60% of what the run wrote is a rounding error against the budget. Two different questions.
    expect(tree.writeShare).toBeCloseTo(0.6)
    expect(tree.budgetShare).toBeCloseTo(0.00015)
    expect(explainNodeRun(tree, totals, options)).toContain('That is <1% of the run\'s write budget of 4,000,000.')
  })

  it('counts distinct cells separately from writes when an index is supplied', () => {
    const index = AttributionIndex.fromProfile(profile, BOUNDS)
    const options = { index }
    const totals = summarizeRun(profile, options)
    const tree = nodeRunStats(profile, 'wiki:tree', options, totals)
    expect(tree.blocksWritten).toBe(600)
    expect(tree.distinctCells).toBe(2)
    expect(explainNodeRun(tree, totals, options)).toContain('600 writes landed on 2 distinct cells -- some cells were written more than once, by this node alone.')
  })

  it('calls a node that ran and wrote nothing normal, never dead', () => {
    const totals = summarizeRun(profile)
    const scatter = nodeRunStats(profile, 'wiki:scatter', {}, totals)
    expect(scatter.activity).toBe('entered-without-writing')
    expect(scatter.writeShare).toBe(0)
    const line = describeNodeRun(scatter, totals)
    expect(line).toBe('Entered 1 time in this run and wrote no blocks, delegating 4 times. Expected of a filter or an aggregate, which decide and delegate rather than place.')
    expect(line.toLowerCase()).not.toMatch(/dead|unused|unreachable|never runs/)
  })

  it('scopes a node absent from the profile to THIS run at THIS origin', () => {
    const totals = summarizeRun(profile)
    const options = { origin: { x: 0, y: 0, z: 0 } }
    const stats = nodeRunStats(profile, 'wiki:chunk_gated', options, totals)
    expect(stats.activity).toBe('not-entered')
    expect(stats.entered).toBe(0)
    expect(stats.writeShare).toBe(0)
    expect(describeNodeRun(stats, totals, options)).toBe('Not entered in this run, at origin 0,0,0. Whether it runs elsewhere is a question this run cannot answer.')
    const lines = explainNodeRun(stats, totals, options)
    expect(lines[1]).toMatch(/gated on chunk position can be false at this origin and true at another/)
    expect(lines.join(' ').toLowerCase()).not.toMatch(/dead|unused|unreachable/)
  })

  it('says a feature rule this run did not place is unmeasured rather than saying it did not run', () => {
    // A rule gets a profiler frame only when the run places it; previewing a feature places none.
    // "Did not run at this origin" would be a plain falsehood about one.
    const totals = summarizeRun(profile)
    const options = { typeIdOf: () => RULE_TYPE_ID }
    const stats = nodeRunStats(profile, 'wiki:my_rule', options, totals)
    expect(stats.activity).toBe('not-measured')
    expect(stats.stops).toEqual([])
    expect(describeNodeRun(stats, totals, options)).toBe('Feature rules are not measured by the profiler unless the run places that rule; this run did not.')
  })

  it('reads a placed rule as a rule, with its stops', () => {
    const ruleProfile: ProfileWire = {
      featureIdentifiers: ['wiki:my_rule'],
      features: [
        {
          identifier: 'wiki:my_rule',
          typeId: 'minecraft:feature_rules',
          entered: 4,
          blocksWritten: 0,
          delegations: 0,
          stops: [{ reason: 'biome_filter_rejected', detail: 'biome void rejected by filter', count: 4 }],
        },
      ],
    }
    const totals = summarizeRun(ruleProfile)
    const stats = nodeRunStats(ruleProfile, 'wiki:my_rule', {}, totals)
    expect(stats.typeId).toBe(RULE_TYPE_ID)
    expect(stats.activity).toBe('stopped')
    expect(describeNodeRun(stats, totals)).toBe('Entered 4 times in this run and stopped before placing: biome void rejected by filter.')
  })

  it('does not divide by zero on a run that wrote nothing', () => {
    const nothing: ProfileWire = {
      featureIdentifiers: ['wiki:filter'],
      features: [{ identifier: 'wiki:filter', typeId: 'minecraft:snap_to_surface_feature', entered: 3, blocksWritten: 0, delegations: 3 }],
      attribution: { cell: [], feature: [], count: [] },
    }
    const totals = summarizeRun(nothing)
    expect(totals.blocksWritten).toBe(0)
    const stats = nodeRunStats(nothing, 'wiki:filter', {}, totals)
    expect(stats.writeShare).toBe(0)
    expect(Number.isNaN(stats.writeShare)).toBe(false)
    // "100% of zero" is arithmetic, not a finding, so nothing gets flagged as dominant.
    expect(isDominantWriter(stats, totals)).toBe(false)
    expect(DOMINANT_WRITE_SHARE).toBe(0.5)
    // And a node nobody has heard of on a run that wrote nothing is still a clean zero.
    expect(nodeRunStats(nothing, 'wiki:absent', {}, totals).writeShare).toBe(0)
  })

  it('summarizes a null profile without throwing', () => {
    const totals = summarizeRun(null)
    expect(totals).toMatchObject({ blocksWritten: 0, entered: 0, delegations: 0, features: 0 })
    expect(buildNodeStats(null).size).toBe(0)
    expect(nodeRunStats(undefined, 'wiki:a', {}, totals).activity).toBe('not-entered')
  })

  it('builds a row per profiled node and ranks them stably', () => {
    const stats = buildNodeStats(profile)
    expect([...stats.keys()]).toEqual(['wiki:tree', 'wiki:scatter', 'wiki:trunk'])
    expect(rankByWrites(stats.values()).map((s) => s.nodeId)).toEqual(['wiki:tree', 'wiki:trunk'])
    expect(rankByWrites(stats.values(), 1).map((s) => s.nodeId)).toEqual(['wiki:tree'])
    // A wrapper that delegates heavily ranks here and nowhere near the write ranking.
    expect(rankByDelegations(stats.values()).map((s) => s.nodeId)).toEqual(['wiki:tree', 'wiki:scatter'])
  })

  it('marks every count as a floor when a budget cut the run off', () => {
    const options = { partial: true }
    const totals = summarizeRun(profile, options)
    const tree = nodeRunStats(profile, 'wiki:tree', options, totals)
    expect(explainNodeRun(tree, totals, options)).toContain('A budget cut this run off early, so every count here is a lower bound, not a total.')
  })

  it('formats shares without rounding a real value away to nothing', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(1)).toBe('100%')
    expect(formatShare(0.0000001)).toBe('<1%')
    expect(formatShare(0.9999)).toBe('>99%')
    expect(formatShare(0.6)).toBe('60%')
    expect(formatShare(0.045)).toBe('4.5%')
  })

  it('formats counts with a fixed separator, not the host locale\'s', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1000)).toBe('1,000')
    expect(formatCount(3_500_000)).toBe('3,500,000')
  })
})

describe('stops', () => {
  const profile: ProfileWire = {
    featureIdentifiers: ['wiki:scatter', 'wiki:list', 'wiki:plain'],
    features: [
      {
        identifier: 'wiki:scatter',
        typeId: 'minecraft:scatter_feature',
        entered: 412,
        blocksWritten: 0,
        delegations: 0,
        stops: [{ reason: 'iterations_zero', detail: 'iterations = 0 (from 0.3)', count: 412 }],
      },
      {
        identifier: 'wiki:list',
        typeId: 'minecraft:conditional_list',
        entered: 5,
        blocksWritten: 0,
        delegations: 5,
        stops: [{ reason: 'condition_false', detail: 'condition = 0, wiki:b skipped', count: 5, ordinal: 1 }],
      },
      { identifier: 'wiki:plain', typeId: 'minecraft:aggregate_feature', entered: 1, blocksWritten: 0, delegations: 1 },
    ],
  }
  const totals = summarizeRun(profile)

  it('describes a stop with a short label and a longer title', () => {
    expect(describeStop({ reason: 'iterations_zero', detail: 'iterations = 0', count: 412 })).toEqual({
      label: 'no iterations — iterations = 0 ×412',
      title: 'No iterations: iterations = 0. 412 times in this run.',
    })
    // One hit carries no count, and an entry index is named only in the title.
    expect(describeStop({ reason: 'condition_false', detail: 'condition = 0', count: 1, ordinal: 0 })).toEqual({
      label: 'condition false — condition = 0',
      title: 'Condition false (entry 0): condition = 0. 1 time in this run.',
    })
    expect(describeStop({ reason: 'chance_failed', detail: 'roll failed at 25%', count: 2 }).title).toBe(
      'Chance roll failed: roll failed at 25%. 2 times in this run. Another seed may pass.',
    )
    // A reason this build does not know still reads as something.
    expect(describeStop({ reason: 'new_gate', detail: 'x', count: 3 }).title).toBe('new_gate: x. 3 times in this run.')
  })

  it('calls a node that entered, handed nothing off and hit a gate stopped', () => {
    const stats = nodeRunStats(profile, 'wiki:scatter', {}, totals)
    expect(stats.activity).toBe('stopped')
    expect(stats.stops).toHaveLength(1)
    expect(describeNodeRun(stats, totals)).toBe('Entered 412 times in this run and stopped before placing: iterations = 0 (from 0.3).')
    expect(explainNodeRun(stats, totals)).toContain('No iterations: iterations = 0 (from 0.3). 412 times in this run.')
  })

  it('keeps a node that still delegated as entered-without-writing, and lists its stops', () => {
    const stats = nodeRunStats(profile, 'wiki:list', {}, totals)
    expect(stats.activity).toBe('entered-without-writing')
    expect(stats.stops[0]?.ordinal).toBe(1)
    expect(explainNodeRun(stats, totals)).toContain('Condition false (entry 1): condition = 0, wiki:b skipped. 5 times in this run.')
  })

  it('reads an absent stops field as none', () => {
    const stats = buildNodeStats(profile).get('wiki:plain')
    expect(stats?.stops).toEqual([])
    expect(stats?.activity).toBe('entered-without-writing')
  })

  it('names how many more gates there were', () => {
    const two: ProfileWire = {
      features: [
        {
          identifier: 'wiki:snap',
          entered: 2,
          stops: [
            { reason: 'no_surface', detail: 'no surface below within 12', count: 1 },
            { reason: 'unresolved_reference', detail: 'wiki:gone not found', count: 1 },
          ],
        },
      ],
    }
    const t = summarizeRun(two)
    expect(describeNodeRun(nodeRunStats(two, 'wiki:snap', {}, t), t)).toBe(
      'Entered 2 times in this run and stopped before placing: no surface below within 12 (+1 more).',
    )
  })
})
