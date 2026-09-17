// graphRender.test.ts -- covers src/graph/render.ts and media/graph.css.
//
// Two halves, on purpose:
//
//   1. PURE. describeEdge/describeCoverage/resolvePositions/truncation are imported straight
//      into vitest (render.ts imports nothing but the DOM lib types, so unlike previewPanel.ts
//      it needs no esbuild-with-a-vscode-stub dance -- see test/fixtures/shellHtml.ts for why
//      that exists at all). This is where "the six kinds are not interchangeable" is actually
//      asserted: whether a sequence chip shows its ordinal and an aggregate chip does not is a
//      property of the data these functions return, and pinning it there means a later
//      restyling cannot quietly undo it.
//   2. REAL LAYOUT. The rest runs the built module in Playwright's Chromium against the REAL
//      media/graph.css, because the questions that remain are geometric and thematic: does an
//      unresolved node actually get drawn, does a 3-cycle actually terminate, does every colour
//      actually change when the theme's variables do. jsdom answers none of those -- it reports
//      zero for every layout measurement and resolves no custom properties -- which is the same
//      reason panelLayout.test.ts drives a real browser rather than jsdom.
//
// The theme half deserves its own note. "Themed correctly" cannot be shown by a screenshot of
// one theme, so this file checks it two ways: statically, that graph.css declares no raw colour
// outside its `--flg-*`/fallback variable blocks (the rule panel.css states and this file's own
// header restates), and dynamically, that injecting a LIGHT `--vscode-*` palette and then a DARK
// one actually moves every rendered colour -- which is only true if nothing downstream was
// hard-coded.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  buildSiblingIndex,
  describeCoverage,
  describeEdge,
  describeFanIn,
  describeFanOut,
  edgeKey,
  jsonPathKey,
  resolvePositions,
  siblingsFor,
  summariseNodes,
  type GraphEdgeWire,
  type GraphNodeWire,
  type GraphWire,
} from '../src/graph/render.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const renderPath = path.join(dir, '..', 'src', 'graph', 'render.ts')
const cssPath = path.join(dir, '..', 'media', 'graph.css')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function edge(partial: Partial<GraphEdgeWire> & Pick<GraphEdgeWire, 'from' | 'to' | 'kind'>): GraphEdgeWire {
  return { ordinal: 0, jsonPath: `$.${partial.kind}[${partial.ordinal ?? 0}]`, required: false, ...partial }
}

/** One graph carrying every edge kind, a partial-coverage node, an unresolved reference, a
 * 3-cycle, a self-edge and a pair of parallel edges -- i.e. every case this renderer makes a
 * specific promise about, in one payload, so the browser half never has to decide which of six
 * fixtures to load. */
function kitchenSinkGraph(): GraphWire {
  const nodes: GraphNodeWire[] = [
    { id: 'ex:rule', typeId: 'minecraft:feature_rule', file: 'feature_rules/r.json', coverage: 'implemented' },
    { id: 'ex:seq', typeId: 'minecraft:sequence_feature', file: 'features/seq.json', coverage: 'implemented' },
    { id: 'ex:agg', typeId: 'minecraft:aggregate_feature', file: 'features/agg.json', coverage: 'implemented' },
    { id: 'ex:weighted', typeId: 'minecraft:weighted_random_feature', file: 'features/w.json', coverage: 'implemented' },
    { id: 'ex:cond', typeId: 'minecraft:conditional_list', file: 'features/c.json', coverage: 'implemented' },
    { id: 'ex:scatter', typeId: 'minecraft:scatter_feature', file: 'features/s.json', coverage: 'implemented' },
    { id: 'ex:snap', typeId: 'minecraft:snap_to_surface_feature', file: 'features/snap.json', coverage: 'implemented' },
    {
      id: 'ex:tree',
      typeId: 'minecraft:tree_feature',
      file: 'features/tree.json',
      formatVersion: '1.13.0',
      coverage: 'partial',
      coverageNote: 'canopy decoration and vine placement are not ported',
    },
    { id: 'ex:ore', typeId: 'minecraft:ore_feature', file: 'features/ore.json', coverage: 'implemented' },
    { id: 'ex:legacy', typeId: 'minecraft:structure_template_feature', file: 'features/l.json', coverage: 'out_of_scope', coverageNote: 'structure templates are handled by the structure pipeline' },
    // The whole point of Node.Unresolved: something delegates here and the pack does not define
    // it. It must be drawn, and its edge must be drawn, not dropped.
    { id: 'ex:missing_target', unresolved: true },
    // And its opposite, which arrives wearing the same `unresolved` flag: a feature the GAME
    // provides. This pack delegates to it and does not define it, and that is correct -- it
    // resolves when the world generates. In a typical large pack, most unresolved
    // references are one of these, so a renderer that cannot tell them apart puts an error on
    // thirteen working delegations, which is how a warning stops being read.
    { id: 'minecraft:bush_feature', unresolved: true, external: true },
    // A 3-cycle, legal per the contract (the engine's recursion guard stops it at run time).
    { id: 'ex:cycle_a', typeId: 'minecraft:aggregate_feature', file: 'features/ca.json', coverage: 'implemented' },
    { id: 'ex:cycle_b', typeId: 'minecraft:aggregate_feature', file: 'features/cb.json', coverage: 'implemented' },
    { id: 'ex:cycle_c', typeId: 'minecraft:aggregate_feature', file: 'features/cc.json', coverage: 'implemented' },
    { id: 'ex:selfie', typeId: 'minecraft:aggregate_feature', file: 'features/self.json', coverage: 'implemented' },
  ]

  const edges: GraphEdgeWire[] = [
    edge({ from: 'ex:rule', to: 'ex:seq', kind: 'rule', required: true }),

    edge({ from: 'ex:seq', to: 'ex:agg', kind: 'sequence', ordinal: 0 }),
    edge({ from: 'ex:seq', to: 'ex:weighted', kind: 'sequence', ordinal: 1 }),
    edge({ from: 'ex:seq', to: 'ex:cond', kind: 'sequence', ordinal: 2 }),

    edge({ from: 'ex:agg', to: 'ex:scatter', kind: 'aggregate', ordinal: 0 }),
    edge({ from: 'ex:agg', to: 'ex:snap', kind: 'aggregate', ordinal: 1 }),
    // The same target twice from one parent -- real, and the case parallel-edge fanning exists
    // for: without it one of the two chips is hidden under the other.
    edge({ from: 'ex:agg', to: 'ex:scatter', kind: 'aggregate', ordinal: 2, jsonPath: '$.features[2]' }),
    // A delegation to one of the game's own features. It resolves, so this edge is NOT dangling.
    edge({ from: 'ex:agg', to: 'minecraft:bush_feature', kind: 'aggregate', ordinal: 3, jsonPath: '$.features[3]' }),

    edge({ from: 'ex:weighted', to: 'ex:tree', kind: 'weighted', ordinal: 0, weight: 3 }),
    edge({ from: 'ex:weighted', to: 'ex:ore', kind: 'weighted', ordinal: 1, weight: 1 }),
    // No weight written at all -- the engine defaults it to 1, and that 1 must be shown as
    // supplied rather than transcribed. See the "defaulted" test below.
    edge({ from: 'ex:weighted', to: 'ex:legacy', kind: 'weighted', ordinal: 2 }),

    // The distinction the contract preserves by keeping Condition nil: no condition written...
    edge({ from: 'ex:cond', to: 'ex:ore', kind: 'conditional', ordinal: 0 }),
    // ...versus a condition that was.
    edge({ from: 'ex:cond', to: 'ex:legacy', kind: 'conditional', ordinal: 1, condition: 'query.get_biome_has_any_tag("swamp") && variable.wet > 0.5' }),

    // Real paths on the two single-slot parents, because the connection gesture matches an
    // existing delegation to the slot it fills by reading the KEY out of the path -- a synthetic
    // `$.scatter[0]` would make a scatter that already places something read as an empty one.
    edge({ from: 'ex:scatter', to: 'ex:tree', kind: 'scatter', ordinal: 0, jsonPath: '$.minecraft:scatter_feature.places_feature', iterations: '4', required: true }),
    edge({ from: 'ex:snap', to: 'ex:missing_target', kind: 'filter', ordinal: 0, jsonPath: '$.minecraft:snap_to_surface_feature.feature_to_snap', required: true }),
    // A named single-child slot -- the kind that, left unrendered, draws a tree_feature as a
    // leaf. Its JSONPath key is the only honest label for it.
    edge({ from: 'ex:tree', to: 'ex:ore', kind: 'child', ordinal: 0, jsonPath: '$.minecraft:tree_feature.log_decoration_feature' }),

    edge({ from: 'ex:cycle_a', to: 'ex:cycle_b', kind: 'aggregate', ordinal: 0 }),
    edge({ from: 'ex:cycle_b', to: 'ex:cycle_c', kind: 'aggregate', ordinal: 0 }),
    edge({ from: 'ex:cycle_c', to: 'ex:cycle_a', kind: 'aggregate', ordinal: 0 }),
    edge({ from: 'ex:selfie', to: 'ex:selfie', kind: 'aggregate', ordinal: 0 }),
  ]

  return {
    nodes,
    edges,
    roots: ['ex:rule', 'ex:cycle_a', 'ex:selfie'],
    cycles: [['ex:cycle_a', 'ex:cycle_b', 'ex:cycle_c'], ['ex:selfie']],
  }
}

/** A grid, deliberately NOT covering `ex:missing_target` -- a layout that walks outward from
 * the roots can legitimately produce no coordinate for an unresolved reference, and the
 * renderer's job is to draw it anyway. */
function kitchenSinkPositions(): Array<[string, { x: number; y: number }]> {
  const graph = kitchenSinkGraph()
  const out: Array<[string, { x: number; y: number }]> = []
  let i = 0
  for (const node of graph.nodes) {
    if (node.id === 'ex:missing_target') continue
    out.push([node.id, { x: (i % 4) * 360, y: Math.floor(i / 4) * 220 }])
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Pure: the six kinds are not interchangeable
// ---------------------------------------------------------------------------

describe('describeEdge: each edge kind says what it means, and no two say it the same way', () => {
  const graph = kitchenSinkGraph()
  const index = buildSiblingIndex(graph.edges)
  const describe_ = (e: GraphEdgeWire) => describeEdge(e, siblingsFor(index, e))

  it('a sequence edge shows its execution position, as a 1-based number with the length', () => {
    const second = graph.edges.find((e) => e.kind === 'sequence' && e.ordinal === 1)!
    const badge = describe_(second)
    // The number itself, prominently -- this is the ordinal that decides execution order and
    // therefore the generated world.
    expect(badge.label).toBe('2')
    expect(badge.detail).toBe('/3')
    expect(badge.modifiers).toContain('sequence')
    // The 0-based JSON index must still be recoverable, or someone cross-referencing the file
    // is off by one with no way to notice.
    expect(badge.title).toContain('JSON index 1')
    expect(badge.title).toMatch(/order is load-bearing/i)
  })

  it('an aggregate edge shows NO number on its face -- its ordinal is file order, not run order', () => {
    for (const aggregate of graph.edges.filter((e) => e.kind === 'aggregate')) {
      const badge = describe_(aggregate)
      expect(badge.label).toBe('unordered')
      // The specific confusion this guards against: an aggregate chip that shows "3" reads
      // exactly like a sequence chip that shows "3", and believing an aggregate runs in order
      // is how someone's world changes without their file changing.
      expect(badge.label).not.toMatch(/\d/)
      expect(badge.detail).not.toMatch(/\d/)
      // Still recoverable when actually asked for.
      expect(badge.title).toMatch(/File position \d+ of \d+/)
    }
  })

  it('a sequence chip and an aggregate chip share neither label nor styling hooks', () => {
    const sequence = describe_(graph.edges.find((e) => e.kind === 'sequence')!)
    const aggregate = describe_(graph.edges.find((e) => e.kind === 'aggregate')!)
    expect(sequence.label).not.toBe(aggregate.label)
    expect(sequence.modifiers).not.toEqual(aggregate.modifiers)
  })

  it('a weighted edge shows its weight AND its share of its siblings', () => {
    const heavier = graph.edges.find((e) => e.kind === 'weighted' && e.weight === 3)!
    const badge = describe_(heavier)
    expect(badge.label).toBe('3')
    // 3 of (3 + 1 + an unwritten entry the engine defaults to 1) = 60%.
    expect(badge.detail).toBe('60%')
    // A weight means nothing alone, so the share has to be computed against the group, not
    // reported raw.
    expect(badge.share).toBeCloseTo(0.6, 5)
    expect(badge.title).toContain('of 5')
  })

  it('an unwritten weight shows the engine default, marked as supplied rather than transcribed', () => {
    const absent = graph.edges.find((e) => e.kind === 'weighted' && e.weight === undefined)!
    const badge = describe_(absent)
    // The share has to be the one the engine will actually roll, so the default counts...
    expect(badge.share).toBeCloseTo(0.2, 5)
    expect(badge.label).toBe('1')
    // ...but the chip must not claim the file says 1. The contract keeps Weight nil precisely
    // so an editor does not write a 1.0 back into a file that never had one.
    expect(badge.modifiers).toContain('defaulted')
    expect(badge.modifiers).not.toContain('suspect')
    expect(badge.title).toMatch(/NO weight written/)
    expect(badge.title).toMatch(/file does not contain this number/)

    // A written 1 and an unwritten one are different edits, so they must not look the same.
    const written = graph.edges.find((e) => e.kind === 'weighted' && e.weight === 1)!
    expect(describe_(written).modifiers).not.toContain('defaulted')
  })

  it('a child edge is labelled with the key it was written under', () => {
    const child = graph.edges.find((e) => e.kind === 'child')!
    const badge = describe_(child)
    // The contract is explicit that the kind says nothing about meaning and the key is the only
    // honest label, so the chip names the key rather than inventing a word for it.
    expect(badge.label).toBe('log_decoration_feature')
    expect(badge.title).toContain('log_decoration_feature')
    expect(badge.title).toMatch(/neither filters nor scatters/)
  })

  it('a weighted group that sums to zero is flagged rather than shown as a share of nothing', () => {
    // Both weights WRITTEN as 0 -- an absent weight would default to 1 and the group would not
    // sum to zero at all, which is the distinction effectiveWeight() exists to keep.
    const zeroed = [edge({ from: 'a', to: 'b', kind: 'weighted', weight: 0 }), edge({ from: 'a', to: 'c', kind: 'weighted', ordinal: 1, weight: 0 })]
    const zeroIndex = buildSiblingIndex(zeroed)
    const badge = describeEdge(zeroed[0]!, siblingsFor(zeroIndex, zeroed[0]!))
    expect(badge.share).toBeNull()
    expect(badge.modifiers).toContain('suspect')
    expect(badge.title).toMatch(/sum to zero/i)
  })

  it('"no condition written" and "a condition was written" are visibly different, not both "1.0"', () => {
    const absent = graph.edges.find((e) => e.kind === 'conditional' && e.condition === undefined)!
    const written = graph.edges.find((e) => e.kind === 'conditional' && typeof e.condition === 'string')!

    const absentBadge = describe_(absent)
    expect(absentBadge.label).toBe('always')
    expect(absentBadge.modifiers).toContain('always')
    // The contract models the absent case as a nil Condition precisely so an editor can tell
    // it apart; synthesising "1.0" back into the chip would throw that away.
    expect(absentBadge.label).not.toContain('1.0')
    expect(absentBadge.title).toMatch(/omits `condition`/)

    const writtenBadge = describe_(written)
    expect(writtenBadge.modifiers).toContain('molang')
    expect(writtenBadge.modifiers).not.toContain('always')
    // The face is elided (the expression is long) but the whole expression survives on the title.
    expect(writtenBadge.title).toContain(written.condition!)
  })

  it('a long Molang condition is elided in the MIDDLE, so two conditions sharing a prefix stay distinguishable', () => {
    const a = edge({ from: 'n', to: 'x', kind: 'conditional', condition: 'query.get_biome_has_any_tag("swamp_and_more") && variable.a > 1' })
    const b = edge({ from: 'n', to: 'y', kind: 'conditional', ordinal: 1, condition: 'query.get_biome_has_any_tag("swamp_and_more") && variable.b > 9' })
    const idx = buildSiblingIndex([a, b])
    const la = describeEdge(a, siblingsFor(idx, a)).label
    const lb = describeEdge(b, siblingsFor(idx, b)).label
    expect(la).not.toBe(lb)
    expect(la).toContain('…')
  })

  it('a scatter shows its iterations as written, and flags a non-numeric one as Molang', () => {
    const plain = describe_(graph.edges.find((e) => e.kind === 'scatter')!)
    expect(plain.label).toBe('4')
    expect(plain.modifiers).toContain('molang')
    expect(plain.modifiers).not.toContain('expression')
    // Even the numeric case must not be described as a plain count -- `iterations` is Molang,
    // and packs use it as a condition and as a setup step.
    expect(plain.title).toMatch(/not a count/i)
    expect(plain.title).toMatch(/variable\./)

    const expression = edge({ from: 'ex:scatter', to: 'ex:tree', kind: 'scatter', iterations: 'variable.n = 3; return 2;' })
    const badge = describeEdge(expression, siblingsFor(buildSiblingIndex([expression]), expression))
    expect(badge.modifiers).toContain('expression')
    expect(badge.detail).toBe('molang')
    expect(badge.title).toContain('variable.n = 3; return 2;')
  })

  it('a filter says it decides whether and where to delegate', () => {
    const badge = describe_(graph.edges.find((e) => e.kind === 'filter')!)
    expect(badge.label).toBe('filter')
    expect(badge.title).toMatch(/WHETHER to delegate and WHERE/)
  })

  it('every kind produces a distinct chip face, and every chip carries a non-empty title', () => {
    const faces = new Set<string>()
    const kinds: GraphEdgeWire['kind'][] = ['rule', 'aggregate', 'sequence', 'weighted', 'conditional', 'scatter', 'filter', 'child']
    for (const kind of kinds) {
      const e = edge({ from: 'p', to: 'c', kind, weight: 1, iterations: kind === 'scatter' ? '2' : undefined })
      const badge = describeEdge(e, siblingsFor(buildSiblingIndex([e]), e))
      faces.add(`${badge.mark}|${badge.label}|${badge.detail}`)
      expect(badge.title.length).toBeGreaterThan(20)
    }
    expect(faces.size).toBe(kinds.length)
  })

  it('a required edge says removing it is an error rather than an edit', () => {
    const required = graph.edges.find((e) => e.required)!
    const badge = describe_(required)
    expect(badge.modifiers).toContain('required')
    expect(badge.title).toMatch(/cannot load without/)
  })

  it('a duplicated sequence ordinal is flagged -- the order on screen is otherwise a fiction', () => {
    const dup = [edge({ from: 's', to: 'a', kind: 'sequence', ordinal: 0 }), edge({ from: 's', to: 'b', kind: 'sequence', ordinal: 0, jsonPath: '$.features[1]' })]
    const idx = buildSiblingIndex(dup)
    const badge = describeEdge(dup[1]!, siblingsFor(idx, dup[1]!))
    expect(badge.modifiers).toContain('suspect')
    expect(badge.title).toMatch(/not actually determined/)
  })

  it('an edge kind this renderer predates is labelled unknown rather than silently drawn as a plain line', () => {
    const future = { from: 'a', to: 'b', kind: 'teleport' as GraphEdgeWire['kind'], jsonPath: '$.x', ordinal: 0, required: false }
    const badge = describeEdge(future, siblingsFor(buildSiblingIndex([future]), future))
    expect(badge.modifiers).toContain('unknown')
    expect(badge.label).toBe('teleport')
  })

  it('edgeKey is stable across a re-walk that reorders graph.edges', () => {
    const keys = graph.edges.map(edgeKey)
    expect(new Set(keys).size).toBe(keys.length)
    const shuffled = [...graph.edges].reverse()
    expect(new Set(shuffled.map(edgeKey))).toEqual(new Set(keys))
  })
})

describe('jsonPathKey', () => {
  it('reads the key a child slot was written under', () => {
    expect(jsonPathKey('$.minecraft:vegetation_patch_feature.vegetation_feature')).toBe('vegetation_feature')
    expect(jsonPathKey("$['minecraft:tree_feature']['log_decoration_feature']")).toBe('log_decoration_feature')
  })

  it('returns nothing it would have to invent', () => {
    // An array subscript is not a key, and neither is the root -- a chip saying "[2]" would be
    // worse than one saying "child".
    expect(jsonPathKey('$.features[2]')).toBe('features')
    expect(jsonPathKey('$')).toBe('')
  })
})

describe('describeCoverage', () => {
  it('a partial type gets no badge -- most of a real pack is partial, so it marked nothing', () => {
    // Asked for by the author, who found the badges noise. The note lives in the documentation
    // panel, where it is about the type rather than repeated on every card of it.
    const badge = describeCoverage({ id: 'ex:tree', typeId: 'minecraft:tree_feature', coverage: 'partial', coverageNote: 'vines not ported' })
    expect(badge).toEqual({ label: '', tone: 'none', title: '' })
  })

  it('an implemented type gets no badge -- a badge on every node is a badge on none', () => {
    expect(describeCoverage({ id: 'a', coverage: 'implemented' }).label).toBe('')
  })

  it('missing and out_of_scope are distinguishable from each other and from no badge', () => {
    const tones = ['missing', 'out_of_scope', 'implemented'].map((c) => describeCoverage({ id: 'a', coverage: c }).tone)
    expect(new Set(tones).size).toBe(3)
  })

  it('an unresolved node reports unresolved, whatever its (absent) coverage says', () => {
    const badge = describeCoverage({ id: 'ex:gone', unresolved: true })
    expect(badge.tone).toBe('unresolved')
    expect(badge.title).toMatch(/does not define it/)
  })

  it('a feature the GAME provides is not reported as a fault, even though it is unresolved too', () => {
    // The two arrive wearing the same `unresolved` flag and say opposite things. Reporting the
    // second in the first's words is the bug this exists to prevent: in a typical pack most
    // unresolved references are one of these, so "check the spelling" was being said over and over
    // about names that were spelled correctly -- and a warning that is wrong that often is a
    // warning people train themselves out of reading.
    const badge = describeCoverage({ id: 'minecraft:bush_feature', unresolved: true, external: true })
    expect(badge.tone).toBe('external')
    expect(badge.label).toBe('from the game')
    expect(badge.title).toMatch(/provided by the game/)
    // What is actually true about it, and the only caveat worth carrying: it works, and nothing
    // shows up for it in a preview.
    expect(badge.title).toMatch(/resolves when the world generates/)
    expect(badge.title).toMatch(/preview/)
    // And not one word of the broken-reference sentence.
    expect(badge.title).not.toMatch(/does not define it/)
    expect(badge.title).not.toMatch(/broken|spelling|dangling/i)
  })

  it('gives the two states different tones, so nothing downstream can style them alike by accident', () => {
    const broken = describeCoverage({ id: 'ex:gone', unresolved: true })
    const provided = describeCoverage({ id: 'minecraft:bush_feature', unresolved: true, external: true })
    expect(provided.tone).not.toBe(broken.tone)
    expect(provided.label).not.toBe(broken.label)
  })
})

describe('summariseNodes: a node is categorised by what it delegates, not by a list of type names', () => {
  const graph = kitchenSinkGraph()
  const summaries = summariseNodes(graph)

  it('takes a node\'s category from its own outgoing edge kinds', () => {
    // The point of deriving it rather than tabulating it: the edge kinds are the frozen
    // contract, so this cannot go stale when a feature type is added, and it has an answer for a
    // type it has never heard of.
    expect(summaries.get('ex:rule')!.category).toBe('rule')
    expect(summaries.get('ex:seq')!.category).toBe('sequence')
    expect(summaries.get('ex:agg')!.category).toBe('aggregate')
    expect(summaries.get('ex:weighted')!.category).toBe('weighted')
    expect(summaries.get('ex:cond')!.category).toBe('conditional')
    expect(summaries.get('ex:scatter')!.category).toBe('scatter')
    expect(summaries.get('ex:snap')!.category).toBe('filter')
    expect(summaries.get('ex:tree')!.category).toBe('child')
  })

  it('gives a game-provided node its own category, not the unresolved one', () => {
    expect(summaries.get('minecraft:bush_feature')!.category).toBe('external')
    expect(summaries.get('ex:missing_target')!.category).toBe('unresolved')
    // The glyph is the half of the distinction that survives a grayscale print and a
    // high-contrast theme, so the two must not share one.
    expect(summaries.get('minecraft:bush_feature')!.mark).not.toBe(summaries.get('ex:missing_target')!.mark)
  })

  it('calls a node with no outgoing edges a leaf, and an unresolved one unresolved', () => {
    // A leaf is what actually places blocks, and is most of a real pack -- so it is a category
    // in its own right rather than an absence.
    expect(summaries.get('ex:ore')!.category).toBe('leaf')
    expect(summaries.get('ex:ore')!.out).toBe(0)
    // Unresolved outranks everything: there is no node there to have a category.
    expect(summaries.get('ex:missing_target')!.category).toBe('unresolved')
  })

  it('counts fan-in, which is the number that says an edit here changes several files', () => {
    // ex:ore is reached by a weighted entry, a conditional entry and a tree's child slot.
    expect(summaries.get('ex:ore')!.in).toBe(3)
    expect(describeFanIn(summaries.get('ex:ore')!).label).toBe('3')
    expect(describeFanIn(summaries.get('ex:ore')!).title).toMatch(/changes all 3/)
    // One parent is unremarkable and gets no row: a badge on every node is a badge on none.
    expect(describeFanIn(summaries.get('ex:seq')!).label).toBe('')
  })

  it('names the kind when there is one kind of child, and only counts when there are several', () => {
    // Naming the kind is what keeps the card's colour from being the only thing that says it.
    expect(describeFanOut(summaries.get('ex:seq')!).label).toBe('3 sequence')
    const mixed = summariseNodes({
      nodes: [{ id: 'p' }, { id: 'a' }, { id: 'b' }],
      edges: [edge({ from: 'p', to: 'a', kind: 'aggregate' }), edge({ from: 'p', to: 'b', kind: 'child', jsonPath: '$.x.y' })],
      roots: ['p'],
    })
    expect(describeFanOut(mixed.get('p')!).label).toBe('2 children')
    // ...and the breakdown is still recoverable when asked for.
    expect(describeFanOut(mixed.get('p')!).title).toMatch(/1 aggregate/)
    expect(describeFanOut(mixed.get('p')!).title).toMatch(/1 child/)
    expect(describeFanOut(summaries.get('ex:ore')!).label).toBe('')
  })

  it('gives the dominant kind to a node whose children are mostly one kind', () => {
    const mostly = summariseNodes({
      nodes: [{ id: 'p' }],
      edges: [
        edge({ from: 'p', to: 'a', kind: 'aggregate' }),
        edge({ from: 'p', to: 'b', kind: 'aggregate', jsonPath: '$.f[1]' }),
        edge({ from: 'p', to: 'c', kind: 'child', jsonPath: '$.x.y' }),
      ],
      roots: ['p'],
    })
    expect(mostly.get('p')!.category).toBe('aggregate')
  })
})

describe('resolvePositions', () => {
  it('uses the layout module\'s coordinates verbatim where it has them', () => {
    const graph: GraphWire = { nodes: [{ id: 'a' }], edges: [], roots: ['a'] }
    const { rects } = resolvePositions(graph, new Map([['a', { x: 40, y: 90 }]]))
    expect(rects.get('a')).toEqual({ x: 40, y: 90, w: GRAPH_NODE_WIDTH, h: GRAPH_NODE_HEIGHT })
  })

  it('honours the center anchor, so a layout that thinks in centres still agrees with what is drawn', () => {
    const graph: GraphWire = { nodes: [{ id: 'a' }], edges: [], roots: ['a'] }
    const { rects } = resolvePositions(graph, new Map([['a', { x: 0, y: 0 }]]), 'center')
    expect(rects.get('a')).toEqual({ x: -GRAPH_NODE_WIDTH / 2, y: -GRAPH_NODE_HEIGHT / 2, w: GRAPH_NODE_WIDTH, h: GRAPH_NODE_HEIGHT })
  })

  it('places an unresolved node the layout skipped, rather than dropping it', () => {
    const graph = kitchenSinkGraph()
    const { rects } = resolvePositions(graph, new Map(kitchenSinkPositions()))
    const placed = rects.get('ex:missing_target')
    expect(placed).toBeDefined()
    // Next to whatever delegates to it, not stranded at the origin on top of another node.
    const parent = rects.get('ex:snap')!
    expect(placed!.x).toBeGreaterThan(parent.x)
  })

  it('materialises an edge endpoint that is in no node list at all', () => {
    const graph: GraphWire = { nodes: [{ id: 'a' }], edges: [edge({ from: 'a', to: 'phantom', kind: 'filter' })], roots: ['a'] }
    const { rects, ghosts } = resolvePositions(graph, new Map([['a', { x: 0, y: 0 }]]))
    expect(ghosts.has('phantom')).toBe(true)
    expect(rects.get('phantom')).toBeDefined()
  })

  it('terminates on a graph that is entirely one cycle with no positions at all', () => {
    // Single-pass by construction (see resolvePositions' own doc comment): the fallback never
    // reads a rect it wrote in the same pass, so there is no chain to follow round the loop.
    const graph: GraphWire = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [edge({ from: 'a', to: 'b', kind: 'aggregate' }), edge({ from: 'b', to: 'c', kind: 'aggregate' }), edge({ from: 'c', to: 'a', kind: 'aggregate' })],
      roots: [],
      cycles: [['a', 'b', 'c']],
    }
    const { rects } = resolvePositions(graph, new Map())
    expect([...rects.keys()].sort()).toEqual(['a', 'b', 'c'])
    // Nothing overlaps: three unplaceable nodes land in three distinct columns.
    expect(new Set([...rects.values()].map((r) => r.x)).size).toBe(3)
  })

  it('rejects a non-finite coordinate instead of propagating NaN into the geometry', () => {
    const graph: GraphWire = { nodes: [{ id: 'a' }], edges: [], roots: ['a'] }
    const { rects } = resolvePositions(graph, new Map([['a', { x: Number.NaN, y: 0 }]]))
    expect(Number.isFinite(rects.get('a')!.x)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Real browser: geometry, interaction, theming
// ---------------------------------------------------------------------------

/** VS Code injects `--vscode-*` on the webview's <html> and swaps them live on a theme change
 * (https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content). These
 * two are trimmed-down but REAL palettes -- Dark+ and Light+ values -- so "does it read in both"
 * is exercised the way the host actually exercises it, not by toggling a media query. */
const DARK_THEME: Record<string, string> = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-textPreformat-foreground': '#d7ba7d',
  '--vscode-textCodeBlock-background': '#2a2a2a',
  '--vscode-editorIndentGuide-background': '#404040',
  '--vscode-charts-blue': '#4e94ce',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-lines': '#dadada',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

const LIGHT_THEME: Record<string, string> = {
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#5f5f5f',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-list-hoverBackground': '#e8e8e8',
  '--vscode-widget-border': '#e5e5e5',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-list-activeSelectionBackground': '#005fb8',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-badge-background': '#cccccc',
  '--vscode-badge-foreground': '#3b3b3b',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-editorError-foreground': '#e51400',
  '--vscode-textPreformat-foreground': '#a31515',
  '--vscode-textCodeBlock-background': '#f3f3f3',
  '--vscode-editorIndentGuide-background': '#d3d3d3',
  '--vscode-charts-blue': '#1a85ff',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-green': '#388a34',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-yellow': '#bf8803',
  '--vscode-charts-red': '#e51400',
  '--vscode-charts-lines': '#616161',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

/** Every `--vscode-*` the stylesheet reads, given a unique colour no palette would produce.
 *
 * This is the half that actually proves nothing is hard-coded. The real Dark+/Light+ pair below
 * cannot do it: the two themes legitimately SHARE some values (`charts.orange` is the same
 * `#d18616` in both), so "this colour did not change between dark and light" is not evidence of
 * a hard-coded colour -- it is sometimes just true. Against a palette where every single input
 * is distinct, any rendered colour that fails to move is a colour the stylesheet baked in. */
function sentinelTheme(): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  for (const name of Object.keys(DARK_THEME)) {
    if (!name.endsWith('-family') && !name.endsWith('-size')) {
      // Spread through the cube in big steps so no two land on the same value and none can
      // coincide with a plausible theme colour.
      const n = i * 7 + 11
      out[name] = `rgb(${(n * 13) % 200 + 20}, ${(n * 29) % 200 + 20}, ${(n * 53) % 200 + 20})`
      i++
    } else {
      out[name] = DARK_THEME[name]!
    }
  }
  return out
}

async function bundleRenderModule(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [renderPath],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling src/graph/render.ts')
  return output.text
}

describe('graph render: real Chromium layout, interaction and theming', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string
  let css: string

  beforeAll(async () => {
    moduleSource = await bundleRenderModule()
    css = readFileSync(cssPath, 'utf-8')
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/graph.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      if (req.url === '/graph.css') {
        res.setHeader('Content-Type', 'text/css')
        res.end(css)
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/graph.css">
<style>html,body{height:100%;margin:0}#host{position:absolute;inset:0}</style>
</head><body><div id="host"></div>
<script type="module">import * as m from '/graph.js'; window.FLG = m; window.__ready = true;</script>
</body></html>`)
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  /** Loads the harness, applies `theme` as `--vscode-*` properties on <html> exactly as the
   * webview host does, and renders the kitchen-sink graph. */
  async function load(theme: Record<string, string> = DARK_THEME): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 10_000 })
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    }, theme)
    await page.evaluate(
      ({ graph, positions }) => {
        const api = (window as unknown as { FLG: Record<string, unknown> }).FLG
        const create = api.createGraphView as (host: HTMLElement, options?: unknown) => Record<string, unknown>
        const view = create(document.getElementById('host')!)
        ;(window as unknown as { view: typeof view; events: unknown[] }).view = view
        const events: unknown[] = []
        ;(window as unknown as { events: unknown[] }).events = events
        ;(view.onSelect as (l: (s: unknown) => void) => void)((s) => events.push({ via: 'onSelect', s }))
        ;(view.onActivate as (l: (s: unknown) => void) => void)((s) => events.push({ via: 'onActivate', s }))
        ;(view.onNodeMove as (l: (m: unknown) => void) => void)((m) => events.push({ via: 'onNodeMove', moves: m }))
        ;(view.onConnect as (l: (r: unknown) => void) => void)((r) => events.push({ via: 'onConnect', request: r }))
        document.addEventListener('flg-connect', (e) => events.push({ via: 'dom-connect', request: (e as CustomEvent).detail }))
        document.addEventListener('flg-select', (e) => events.push({ via: 'dom', s: (e as CustomEvent).detail }))
        document.addEventListener('flg-move', (e) => events.push({ via: 'dom-move', moves: (e as CustomEvent).detail }))
        ;(view.render as (g: unknown, p: Map<string, unknown>) => void)(graph, new Map(positions as Array<[string, unknown]>))
      },
      { graph: kitchenSinkGraph(), positions: kitchenSinkPositions() },
    )
    return page
  }

  it('draws every node, including the unresolved one the layout gave no position for', async () => {
    const page = await load()
    try {
      const ids = await page.$$eval('.flg-node', (els) => els.map((e) => (e as HTMLElement).dataset.nodeId))
      expect(ids).toHaveLength(kitchenSinkGraph().nodes.length)
      expect(ids).toContain('ex:missing_target')

      // "Visible dangling edge, not vanished": the node has real, non-zero geometry and the
      // filter edge pointing at it is actually in the DOM.
      const box = await page.locator('.flg-node[data-node-id="ex:missing_target"]').boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThan(50)
      expect(box!.height).toBeGreaterThan(20)

      const dangling = await page.$$eval('.flg-edge-dangling .flg-edge-line', (els) => els.map((e) => e.getAttribute('d')))
      expect(dangling).toHaveLength(1)
      // A real curve with a real start point, whichever Bezier the router is drawing: the point
      // is that the edge is DRAWN, not which command spells it. (It is a cubic today -- edges
      // leave a port horizontally and arrive at one horizontally, so a fan converging on a
      // shared child reads as a fan; it was a quadratic bowed off the centre line before that.)
      expect(dangling[0]).toMatch(/^M [-\d.]+ [-\d.]+ [QC]/)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('never parks a fallback-placed node on top of one the layout placed', async () => {
    const page = await load()
    try {
      // The bug this pins: the unresolved node, placed at a fixed offset from its parent,
      // landed exactly on a real node in the layout's grid -- hiding it, and (being drawn on
      // top) making it unclickable. A stub whose whole job is to prove nothing is hidden must
      // not hide something.
      const overlaps = await page.$$eval('.flg-node', (els) => {
        const boxes = els.map((e) => ({ id: (e as HTMLElement).dataset.nodeId ?? '?', r: e.getBoundingClientRect() }))
        const out: string[] = []
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!
            const b = boxes[j]!
            if (a.r.left < b.r.right && b.r.left < a.r.right && a.r.top < b.r.bottom && b.r.top < a.r.bottom) {
              out.push(`${a.id} overlaps ${b.id}`)
            }
          }
        }
        return out
      })
      expect(overlaps).toEqual([])

      // And the stub is still reachable by a real click, which is what the overlap denied.
      await page.locator('.flg-node[data-node-id="ex:missing_target"]').click({ timeout: 4000 })
      expect(await page.evaluate(() => document.querySelectorAll('.flg-node.flg-selected').length)).toBe(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('draws every edge exactly once, with a finite path and an arrowhead', async () => {
    const page = await load()
    try {
      const paths = await page.$$eval('.flg-edge .flg-edge-line', (els) => els.map((e) => e.getAttribute('d') ?? ''))
      expect(paths).toHaveLength(kitchenSinkGraph().edges.length)
      expect(await page.locator('.flg-chip-child').count()).toBe(1)
      for (const d of paths) expect(d).not.toMatch(/NaN|Infinity/)
      const arrows = await page.$$eval('.flg-edge .flg-edge-arrow', (els) => els.map((e) => e.getAttribute('d') ?? ''))
      expect(arrows).toHaveLength(paths.length)
      for (const d of arrows) expect(d).not.toMatch(/NaN|Infinity/)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a node shows its id and its type, and a partial one wears no badge or note', async () => {
    const page = await load()
    try {
      const tree = page.locator('.flg-node[data-node-id="ex:tree"]')
      expect(await tree.locator('.flg-node-id').textContent()).toBe('ex:tree')
      // The `minecraft:` prefix is dropped for display; the full type stays in the dataset.
      expect(await tree.locator('.flg-node-type').textContent()).toBe('tree_feature')
      expect(await tree.getAttribute('data-type-id')).toBe('minecraft:tree_feature')
      expect(await tree.getAttribute('data-coverage')).toBe('partial')

      // Partial is on the dataset for anything that needs it, and nowhere a reader sees it.
      expect(await tree.locator('.flg-coverage').count()).toBe(0)
      expect(await tree.locator('.flg-node-note').count()).toBe(0)

      // Everything on the node must be inside the node.
      const outer = (await tree.boundingBox())!
      for (const selector of ['.flg-node-id', '.flg-node-type', '.flg-node-badges']) {
        const inner = (await tree.locator(selector).boundingBox())!
        expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5)
        expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
      }

      // An implemented node carries no coverage badge at all.
      expect(await page.locator('.flg-node[data-node-id="ex:ore"] .flg-coverage').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('the card leads with the IDENTIFIER, in a header, above the type', async () => {
    const page = await load()
    try {
      const shape = await page.evaluate(() => {
        const node = document.querySelector('.flg-node[data-node-id="ex:tree"]')!
        const id = node.querySelector('.flg-node-id')!
        const type = node.querySelector('.flg-node-type')!
        const idStyle = getComputedStyle(id)
        const typeStyle = getComputedStyle(type)
        return {
          idInHeader: id.parentElement?.className,
          idSize: parseFloat(idStyle.fontSize),
          idWeight: Number(idStyle.fontWeight),
          typeSize: parseFloat(typeStyle.fontSize),
          typeWeight: Number(typeStyle.fontWeight),
          idTop: id.getBoundingClientRect().top,
          typeTop: type.getBoundingClientRect().top,
        }
      })
      // The correction this redesign exists for: the type used to be the only emphasised text on
      // the box and the id a thin grey line under it, which is backwards -- the id is the string
      // the rest of the pack delegates by and the thing someone is searching for.
      expect(shape.idInHeader).toContain('flg-node-head')
      expect(shape.idSize).toBeGreaterThan(shape.typeSize)
      expect(shape.idWeight).toBeGreaterThan(shape.typeWeight)
      expect(shape.idTop).toBeLessThan(shape.typeTop)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a node is coloured by category -- and says the category in text as well', async () => {
    const page = await load()
    try {
      const cards = await page.evaluate(() => {
        const out: Record<string, { accent: string; mark: string; type: string }> = {}
        for (const id of ['ex:rule', 'ex:seq', 'ex:agg', 'ex:weighted', 'ex:scatter', 'ex:ore']) {
          const node = document.querySelector(`.flg-node[data-node-id="${id}"]`) as HTMLElement | null
          if (!node) continue
          out[id] = {
            accent: getComputedStyle(node).borderLeftColor,
            mark: node.querySelector('.flg-node-icon')?.textContent ?? '',
            type: node.querySelector('.flg-node-type')?.textContent ?? '',
          }
        }
        return out
      })
      // Six categories, six distinct stripe colours...
      const accents = Object.values(cards).map((c) => c.accent)
      expect(new Set(accents).size).toBe(accents.length)
      // ...none of which is the only thing saying so. Every card carries a glyph AND the type
      // name written out, because a high-contrast theme flattens the palette and roughly one man
      // in twelve cannot separate two of these hues.
      for (const [id, card] of Object.entries(cards)) {
        expect(card.mark, `${id} has no category glyph`).not.toBe('')
        expect(card.type, `${id} has no type text`).not.toBe('')
      }
      const marks = Object.values(cards).map((c) => c.mark)
      expect(new Set(marks).size).toBe(marks.length)
      // A node's hue is the hue of the edges leaving it, which is what lets a chain be traced.
      const sequenceStroke = await page.evaluate(() => getComputedStyle(document.querySelector('.flg-edge-sequence .flg-edge-line')!).stroke)
      expect(cards['ex:seq']!.accent).toBe(sequenceStroke)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('edges converging on one node land on separate points of its border', async () => {
    const page = await load()
    try {
      // THE case this graph is full of: the contract shares features by "namespace:id", so many
      // parents reaching one child is normal. Drawn to the box's centre, those edges arrive as
      // one blot and neither "which is mine" nor "how many are there" is answerable.
      const ends = await page.evaluate(() => {
        // The node's own world coordinates, which is the space the edge paths are written in --
        // an edge's key names the node it LEAVES, so arrivals have to be found geometrically.
        const box = document.querySelector('.flg-node[data-node-id="ex:ore"]') as HTMLElement
        const left = parseFloat(box.style.left)
        const top = parseFloat(box.style.top)
        const out: Array<{ side: string; y: number }> = []
        for (const line of document.querySelectorAll('.flg-edge-line')) {
          const numbers = (line.getAttribute('d') ?? '').match(/-?[\d.]+/g) ?? []
          if (numbers.length < 2) continue
          const point = { x: Number(numbers[numbers.length - 2]), y: Number(numbers[numbers.length - 1]) }
          if (point.y < top - 8 || point.y > top + 86 + 8) continue
          // Within the gap the arrowheads are held off the border by. A parent drawn to the
          // RIGHT of its child delegates backwards and arrives on the right border, which is
          // exactly how a backward edge is made to look like one.
          if (Math.abs(point.x - left) <= 8) out.push({ side: 'left', y: point.y })
          else if (Math.abs(point.x - (left + 232)) <= 8) out.push({ side: 'right', y: point.y })
        }
        return out
      })
      // ex:ore is reached three times -- a weighted entry, a conditional entry and a tree's
      // child slot -- and is left by nothing, so every one of these is an arrival.
      expect(ends).toHaveLength(3)
      // Two of them share a border, and they do NOT share a point on it.
      const right = ends.filter((p) => p.side === 'right').map((p) => p.y)
      expect(right.length).toBeGreaterThanOrEqual(2)
      expect(new Set(right).size).toBe(right.length)
      expect(Math.max(...right) - Math.min(...right)).toBeGreaterThan(GRAPH_NODE_HEIGHT / 4)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('selecting a node quiets everything that does not touch it, without moving anything', async () => {
    const page = await load()
    try {
      const before = await page.$$eval('.flg-node', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${(e as HTMLElement).dataset.nodeId}:${r.x},${r.y}` }))

      await page.locator('.flg-node[data-node-id="ex:ore"]').click({ timeout: 4000 })
      await page.waitForTimeout(200)

      const state = await page.evaluate(() => {
        const lit = document.querySelectorAll('.flg-edge.flg-incident').length
        const unlitEdge = document.querySelector('.flg-edge:not(.flg-incident)')
        const litEdge = document.querySelector('.flg-edge.flg-incident')
        const unlitNode = document.querySelector('.flg-node:not(.flg-node-focus)')
        return {
          hasFocus: document.querySelector('.flg-graph')!.classList.contains('flg-has-focus'),
          lit,
          litOpacity: litEdge ? Number(getComputedStyle(litEdge).opacity) : -1,
          unlitOpacity: unlitEdge ? Number(getComputedStyle(unlitEdge).opacity) : -1,
          unlitNodeOpacity: unlitNode ? Number(getComputedStyle(unlitNode).opacity) : -1,
          focusedNodes: document.querySelectorAll('.flg-node.flg-node-focus').length,
        }
      })
      expect(state.hasFocus).toBe(true)
      // Three edges reach ex:ore, and all three are lit -- along with ex:ore itself and the three
      // nodes at their other ends, because a delegation is a statement about two boxes.
      expect(state.lit).toBe(3)
      expect(state.focusedNodes).toBe(4)
      expect(state.litOpacity).toBe(1)
      expect(state.unlitOpacity).toBeLessThan(0.5)
      expect(state.unlitNodeOpacity).toBeLessThan(0.5)

      // NOTHING MOVED. The whole point of doing this with opacity is that the mental map of where
      // things are survives the click.
      const after = await page.$$eval('.flg-node', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${(e as HTMLElement).dataset.nodeId}:${r.x},${r.y}` }))
      expect(after).toEqual(before)

      // And it is reversible: clearing the selection restores the canvas.
      await page.keyboard.press('Escape')
      await page.evaluate(() => (window as never as { view: { setSelection(s: unknown): void } }).view.setSelection(null))
      await page.waitForTimeout(200)
      expect(await page.evaluate(() => document.querySelector('.flg-graph')!.classList.contains('flg-has-focus'))).toBe(false)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a quieted node is still clickable, so the canvas never traps the user', async () => {
    const page = await load()
    try {
      await page.locator('.flg-node[data-node-id="ex:ore"]').click({ timeout: 4000 })
      await page.waitForTimeout(200)
      // ex:selfie touches nothing ex:ore touches, so it is quieted -- and must still take a
      // click, or selecting the wrong node would be a dead end.
      await page.locator('.flg-node[data-node-id="ex:selfie"]').click({ timeout: 4000 })
      expect(await page.evaluate(() => (document.querySelector('.flg-node.flg-selected') as HTMLElement | null)?.dataset.nodeId)).toBe('ex:selfie')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('an unresolved node is unmistakable by shape, not only by colour', async () => {
    const page = await load()
    try {
      const state = await page.evaluate(() => {
        const missing = document.querySelector('.flg-node[data-node-id="ex:missing_target"]')!
        const ordinary = document.querySelector('.flg-node[data-node-id="ex:ore"]')!
        const m = getComputedStyle(missing)
        const o = getComputedStyle(ordinary)
        return {
          style: m.borderTopStyle,
          ordinaryStyle: o.borderTopStyle,
          width: parseFloat(m.borderTopWidth),
          ordinaryWidth: parseFloat(o.borderTopWidth),
          hatch: m.backgroundImage,
          ordinaryHatch: o.backgroundImage,
          text: missing.querySelector('.flg-node-type')?.textContent ?? '',
          badge: missing.querySelector('.flg-coverage-unresolved')?.textContent ?? '',
        }
      })
      // Dashed where an ordinary card is solid, heavier, and HATCHED rather than filled -- three
      // signals that survive a theme in which `charts-red` and the error colour are the same
      // value, which is most of them.
      expect(state.style).toBe('dashed')
      expect(state.ordinaryStyle).toBe('solid')
      expect(state.width).toBeGreaterThan(state.ordinaryWidth)
      expect(state.hatch).toMatch(/gradient/)
      expect(state.ordinaryHatch).toBe('none')
      // And it says so in words, twice.
      expect(state.text).toMatch(/not defined in this pack/)
      expect(state.badge).toBe('unresolved')

      // A node in a cycle is a different shape again: a ring OUTSIDE the box, so the two red
      // broken outlines cannot be confused for each other.
      const cycle = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.flg-node[data-node-id="ex:cycle_a"]')!)
        return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), border: style.borderTopStyle }
      })
      expect(cycle.outline).toBe('dotted')
      expect(cycle.width).toBeGreaterThan(0)
      expect(cycle.border).toBe('solid')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a node the GAME provides does not look like a broken one -- and the difference is not colour', async () => {
    const page = await load()
    try {
      const state = await page.evaluate(() => {
        const read = (id: string) => {
          const card = document.querySelector(`.flg-node[data-node-id="${id}"]`)!
          const style = getComputedStyle(card)
          return {
            hatch: style.backgroundImage,
            borderStyle: style.borderTopStyle,
            leftStyle: style.borderLeftStyle,
            classes: card.className,
            coverage: (card as HTMLElement).dataset.coverage,
            category: (card as HTMLElement).dataset.category,
            glyph: card.querySelector('.flg-node-icon')?.textContent ?? '',
            type: card.querySelector('.flg-node-type')?.textContent ?? '',
            badge: card.querySelector('.flg-badge')?.textContent ?? '',
            label: card.getAttribute('aria-label') ?? '',
            title: (card as HTMLElement).title,
          }
        }
        return { provided: read('minecraft:bush_feature'), broken: read('ex:missing_target'), ordinary: read('ex:ore') }
      })

      // NOT the broken card's shape: filled rather than hatched, and not wearing its class.
      expect(state.provided.hatch).toBe('none')
      expect(state.broken.hatch).toMatch(/gradient/)
      expect(state.provided.classes).not.toContain('flg-node-unresolved')
      expect(state.provided.classes).toContain('flg-node-external')

      // And not an ordinary card either: a DOUBLE left edge, a texture used nowhere else, so the
      // three states are separable with no hue at all.
      expect(state.provided.leftStyle).toBe('double')
      expect(state.ordinary.leftStyle).not.toBe('double')
      expect(state.broken.borderStyle).toBe('dashed')

      // Said in words, three times, and never in the broken one's words.
      expect(state.provided.type).toBe('provided by the game')
      expect(state.provided.badge).toBe('from the game')
      expect(state.provided.label).toContain('provided by the game')
      expect(state.provided.label).not.toContain('unresolved')
      expect(state.provided.title).toContain('provided by the game')
      expect(state.provided.coverage).toBe('external')
      expect(state.provided.category).toBe('external')

      // Different glyph, so the two are separable in a grayscale print and a high-contrast theme.
      expect(state.provided.glyph).not.toBe(state.broken.glyph)
      expect(state.provided.glyph.length).toBeGreaterThan(0)

      // The edge into it is a delegation that RESOLVES, so it is not drawn as a broken one. The
      // dangling count stays at the single genuinely broken reference in the fixture.
      const classes = await page.$$eval('.flg-edge', (els) => els.map((e) => e.getAttribute('class') ?? ''))
      expect(classes.filter((c) => c.includes('flg-edge-dangling'))).toHaveLength(1)
      expect(classes.filter((c) => c.includes('flg-edge-external'))).toHaveLength(1)
      expect(classes.find((c) => c.includes('flg-edge-external'))).not.toContain('flg-edge-dangling')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('refuses to start a connection from a feature the game provides -- there is no file here', async () => {
    const page = await load()
    try {
      const port = page.locator('.flg-node[data-node-id="minecraft:bush_feature"] .flg-node-port')
      expect(await port.getAttribute('data-refuses')).toBe('true')
      expect(await port.getAttribute('title')).toMatch(/provided by the game/)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('an out-of-scope type is marked on the card edge, and a partial one is not', async () => {
    const page = await load()
    try {
      const marks = await page.evaluate(() => {
        const read = (id: string) => {
          const style = getComputedStyle(document.querySelector(`.flg-node[data-node-id="${id}"]`)!)
          return { width: parseFloat(style.borderRightWidth), color: style.borderRightColor }
        }
        return { partial: read('ex:tree'), scope: read('ex:legacy'), plain: read('ex:ore') }
      })
      expect(marks.partial).toEqual(marks.plain)
      expect(marks.scope.width).toBeGreaterThan(marks.plain.width)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('no edge chip is parked on top of another node\'s identifier', async () => {
    const page = await load()
    try {
      const collisions = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('.flg-node')].map((e) => e.getBoundingClientRect())
        const out: string[] = []
        for (const chip of document.querySelectorAll('.flg-chip')) {
          const r = chip.getBoundingClientRect()
          const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          for (const box of boxes) {
            if (centre.x >= box.left && centre.x <= box.right && centre.y >= box.top && centre.y <= box.bottom) {
              out.push(`${chip.getAttribute('aria-label')}`)
              break
            }
          }
        }
        return out
      })
      // A label lying across a card's identifier damages two things at once -- the chip cannot be
      // read against the text under it, and the identifier cannot be read at all. The chip slides
      // along its own edge until it is clear; see chipAnchor.
      expect(collisions).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('sequence chips are numbered and visually unlike aggregate chips', async () => {
    const page = await load()
    try {
      const sequenceLabels = await page.$$eval('.flg-chip-sequence .flg-chip-label', (els) => els.map((e) => e.textContent))
      expect(sequenceLabels.sort()).toEqual(['1', '2', '3'])

      const aggregateLabels = await page.$$eval('.flg-chip-aggregate .flg-chip-label', (els) => els.map((e) => e.textContent ?? ''))
      expect(aggregateLabels.length).toBeGreaterThan(0)
      for (const label of aggregateLabels) expect(label).not.toMatch(/\d/)

      // Not just different text: a different SHAPE, which is the half that survives a
      // high-contrast theme flattening the palette.
      const shapes = await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('.flg-chip-sequence')!)
        const a = getComputedStyle(document.querySelector('.flg-chip-aggregate')!)
        return { seqRadius: s.borderTopLeftRadius, aggRadius: a.borderTopLeftRadius, seqWeight: s.borderTopWidth, aggWeight: a.borderTopWidth, seqColor: s.borderTopColor, aggColor: a.borderTopColor }
      })
      expect(shapes.seqRadius).not.toBe(shapes.aggRadius)
      expect(shapes.seqColor).not.toBe(shapes.aggColor)
      expect(shapes.seqWeight).not.toBe(shapes.aggWeight)

      // And a different line, so the two are separable before the chips are even read.
      const dashes = await page.evaluate(() => ({
        sequence: getComputedStyle(document.querySelector('.flg-edge-sequence .flg-edge-line')!).strokeDasharray,
        aggregate: getComputedStyle(document.querySelector('.flg-edge-aggregate .flg-edge-line')!).strokeDasharray,
      }))
      expect(dashes.sequence).not.toBe(dashes.aggregate)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('all seven edge kinds are separable by stroke pattern alone, with no colour involved', async () => {
    const page = await load()
    try {
      const signatures = await page.evaluate(() => {
        const kinds = ['rule', 'sequence', 'aggregate', 'weighted', 'conditional', 'scatter', 'filter', 'child']
        const out: Record<string, string> = {}
        for (const kind of kinds) {
          const line = document.querySelector(`.flg-edge-${kind} .flg-edge-line`)
          if (!line) continue
          const style = getComputedStyle(line)
          out[kind] = `${style.strokeDasharray}|${style.strokeWidth}`
        }
        return out
      })
      const present = Object.values(signatures)
      expect(present.length).toBe(8)
      // Every kind drawn on this canvas must be distinguishable from every other by dash
      // pattern and width -- the signal that survives a grayscale print, a high-contrast theme
      // and a red/green colour deficiency.
      expect(new Set(present).size).toBe(present.length)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('the weighted chips show siblings-relative shares, as a number and as a bar', async () => {
    const page = await load()
    try {
      const chips = await page.$$eval('.flg-chip-weighted', (els) =>
        els.map((e) => ({
          label: e.querySelector('.flg-chip-label')?.textContent,
          detail: e.querySelector('.flg-chip-detail')?.textContent,
          barWidth: (e.querySelector('.flg-chip-bar-fill') as HTMLElement | null)?.style.width,
        })),
      )
      expect(chips).toHaveLength(3)
      const byLabel = Object.fromEntries(chips.map((c) => [c.label, c]))
      expect(byLabel['3']!.detail).toBe('60%')
      expect(byLabel['3']!.barWidth).toBe('60%')
      // The two entries whose effective weight is 1 -- one written, one defaulted -- share a
      // label and a share, and are told apart by the modifier class, not by the number.
      expect(await page.locator('.flg-chip-weighted.flg-chip-defaulted').count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('an unwritten condition renders differently from a written one', async () => {
    const page = await load()
    try {
      expect(await page.locator('.flg-chip-conditional.flg-chip-always').count()).toBe(1)
      expect(await page.locator('.flg-chip-conditional.flg-chip-molang').count()).toBe(1)
      expect(await page.locator('.flg-chip-always .flg-chip-label').textContent()).toBe('always')

      const styles = await page.evaluate(() => {
        const always = getComputedStyle(document.querySelector('.flg-chip-always .flg-chip-label')!);
        const molang = getComputedStyle(document.querySelector('.flg-chip-molang .flg-chip-label')!)
        return { alwaysFont: always.fontFamily, molangFont: molang.fontFamily, alwaysColor: always.color, molangColor: molang.color }
      })
      // The absence is set in the UI font; the written expression is set in the code font and
      // the code colour, so "nothing was written" never masquerades as a piece of Molang.
      expect(styles.alwaysFont).not.toBe(styles.molangFont)
      expect(styles.alwaysColor).not.toBe(styles.molangColor)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a cycle renders, is marked, and terminates -- including a self-edge', async () => {
    const page = await load()
    try {
      const cycleNodes = await page.$$eval('.flg-node-cycle', (els) => els.map((e) => (e as HTMLElement).dataset.nodeId).sort())
      expect(cycleNodes).toEqual(['ex:cycle_a', 'ex:cycle_b', 'ex:cycle_c', 'ex:selfie'])
      expect(await page.locator('.flg-badge-cycle').count()).toBe(4)

      // All three legs of the 3-cycle are drawn -- a renderer that stopped at "already visited"
      // would silently omit the edge that closes the loop, which is the one that matters.
      const cycleEdges = await page.$$eval('.flg-edge-cycle .flg-edge-line', (els) => els.map((e) => e.getAttribute('d') ?? ''))
      expect(cycleEdges.length).toBe(4)

      // A self-delegation has no direction, so a naive line collapses to zero length and
      // divides by zero. It must be a real loop with real geometry.
      const selfPath = await page.evaluate(() => {
        const group = document.querySelector('.flg-edge[data-edge-key*="ex:selfie"]')
        return group?.querySelector('.flg-edge-line')?.getAttribute('d') ?? ''
      })
      expect(selfPath).toContain('C')
      expect(selfPath).not.toMatch(/NaN/)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('parallel edges between the same pair are fanned apart so neither chip hides the other', async () => {
    const page = await load()
    try {
      const chips = await page.$$eval('.flg-chip-aggregate', (els) =>
        els
          .filter((e) => (e.getAttribute('aria-label') ?? '').includes('from ex:agg to ex:scatter'))
          .map((e) => {
            const r = e.getBoundingClientRect()
            return { x: r.x, y: r.y }
          }),
      )
      expect(chips).toHaveLength(2)
      expect(Math.hypot(chips[0]!.x - chips[1]!.x, chips[0]!.y - chips[1]!.y)).toBeGreaterThan(20)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('pans with a drag and zooms at the cursor with ctrl+wheel, without re-rendering', async () => {
    const page = await load()
    try {
      const before = await page.evaluate(() => document.querySelectorAll('.flg-node').length)
      const start = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera())

      await page.mouse.move(700, 800)
      await page.mouse.down()
      await page.mouse.move(560, 720, { steps: 6 })
      await page.mouse.up()
      const panned = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera())
      expect(panned.x).toBeGreaterThan(start.x)
      expect(panned.y).toBeGreaterThan(start.y)
      expect(panned.zoom).toBe(start.zoom)

      // What sits under the cursor must stay under the cursor across a zoom, or the user spends
      // the session re-centering.
      await page.mouse.move(400, 300)
      const worldBefore = await page.evaluate(() => {
        const c = (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera()
        const box = document.querySelector('.flg-graph')!.getBoundingClientRect()
        return { x: c.x + (400 - box.left) / c.zoom, y: c.y + (300 - box.top) / c.zoom }
      })
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -300)
      await page.keyboard.up('Control')
      await page.waitForTimeout(80)
      const after = await page.evaluate(() => {
        const c = (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera()
        const box = document.querySelector('.flg-graph')!.getBoundingClientRect()
        return { zoom: c.zoom, x: c.x + (400 - box.left) / c.zoom, y: c.y + (300 - box.top) / c.zoom }
      })
      expect(after.zoom).toBeGreaterThan(panned.zoom)
      expect(after.x).toBeCloseTo(worldBefore.x, 0)
      expect(after.y).toBeCloseTo(worldBefore.y, 0)

      // Pan and zoom are one transform write, never a rebuild -- the element count is unchanged
      // and the transform is on the single world layer.
      expect(await page.evaluate(() => document.querySelectorAll('.flg-node').length)).toBe(before)
      expect(await page.evaluate(() => (document.querySelector('.flg-world') as HTMLElement).style.transform)).toContain('scale(')
    } finally {
      await page.close()
    }
  }, 30_000)

  // -- moving a node ------------------------------------------------------
  //
  // Everything below is asserted through real pointer and key events, never by calling into the
  // view: a drag is the one feature here whose whole substance is what the browser does with a
  // press, a threshold and a capture, and a test that reached past that would pass with the
  // gesture completely broken.

  /** Where a card actually sits, in GRAPH coordinates. `style.left/top` IS that coordinate --
   * the cards live inside the single transformed world layer, so the camera never touches
   * them -- which is also why these numbers are the ones a host would write to a file. */
  const cardAt = (page: Page, id: string) =>
    page.$eval(`.flg-node[data-node-id="${id}"]`, (el) => ({
      x: parseFloat((el as HTMLElement).style.left),
      y: parseFloat((el as HTMLElement).style.top),
    }))

  type MoveReport = { nodeId: string; position: { x: number; y: number }; from: { x: number; y: number } }

  const movesReported = (page: Page, via = 'onNodeMove') =>
    page.evaluate((channel) => {
      const all = (window as never as { events: Array<{ via: string; moves?: unknown }> }).events
      return JSON.parse(JSON.stringify(all.filter((e) => e.via === channel).map((e) => e.moves))) as MoveReport[][]
    }, via) as Promise<MoveReport[][]>

  const selections = (page: Page) =>
    page.evaluate(() => {
      const all = (window as never as { events: Array<{ via: string; s?: { kind?: string; nodeId?: string } | null }> }).events
      return JSON.parse(JSON.stringify(all.filter((e) => e.via === 'onSelect').map((e) => e.s))) as Array<{ kind?: string; nodeId?: string } | null>
    })

  /** Presses in the middle of a card, drags by a SCREEN delta in several steps, releases.
   *
   * `alt` holds ALT for the gesture, which defeats the alignment snap -- the tests that assert
   * exact arithmetic need it off, because a card dragged near a neighbour's edge is SUPPOSED to
   * land on that neighbour's edge rather than on the number the arithmetic predicts. */
  async function dragCard(page: Page, id: string, dx: number, dy: number, alt = true): Promise<void> {
    const box = (await page.locator(`.flg-node[data-node-id="${id}"]`).boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    if (alt) await page.keyboard.down('Alt')
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 8 })
    await page.mouse.up()
    if (alt) await page.keyboard.up('Alt')
    // One frame, so the release's own reroute has certainly landed in the DOM.
    await page.waitForTimeout(60)
  }

  /** The start point of an edge's path -- where it actually attaches to the card it leaves. */
  const edgeStart = (page: Page, selector: string) =>
    page.$eval(selector, (el) => {
      const found = /^M ([-\d.]+) ([-\d.]+)/.exec(el.getAttribute('d') ?? '')
      return found ? { x: parseFloat(found[1]!), y: parseFloat(found[2]!) } : null
    })

  it('a card ends up where it was dropped, under a panned and zoomed camera', async () => {
    const page = await load()
    try {
      // Not the default camera: a drag that only works at zoom 1 and the origin is a drag that
      // works nowhere a user actually is. The card has to stay under the pointer, which means
      // the screen delta has to be divided by the zoom before it becomes a world delta.
      await page.evaluate(() => (window as never as { view: { setCamera(c: unknown): void } }).view.setCamera({ x: -120, y: -60, zoom: 0.75 }))
      await page.waitForTimeout(80)

      const before = await cardAt(page, 'ex:tree')
      const edgeBefore = await page.$eval('.flg-edge-child .flg-edge-line', (el) => el.getAttribute('d'))

      await dragCard(page, 'ex:tree', 150, -90)

      const after = await cardAt(page, 'ex:tree')
      expect(after.x - before.x).toBeCloseTo(150 / 0.75, 0)
      expect(after.y - before.y).toBeCloseTo(-90 / 0.75, 0)

      // EDGES FOLLOW. They attach at ports computed from node positions, so a move that did not
      // re-route them would leave every line ending in mid-air -- and `ex:tree` has three.
      const edgeAfter = await page.$eval('.flg-edge-child .flg-edge-line', (el) => el.getAttribute('d'))
      expect(edgeAfter).not.toBe(edgeBefore)
      const start = await edgeStart(page, '.flg-edge-child .flg-edge-line')
      expect(start).not.toBeNull()
      // On the card's border, wherever the router decided to put the port: just outside one of
      // the two vertical edges, somewhere down the box's own height.
      expect(Math.min(Math.abs(start!.x - after.x), Math.abs(start!.x - (after.x + GRAPH_NODE_WIDTH)))).toBeLessThanOrEqual(6)
      expect(start!.y).toBeGreaterThanOrEqual(after.y - 1)
      expect(start!.y).toBeLessThanOrEqual(after.y + GRAPH_NODE_HEIGHT + 1)

      // Reported ONCE, on the drop, with graph coordinates on both ends of the gesture.
      const reports = await movesReported(page)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toHaveLength(1)
      expect(reports[0]![0]!.nodeId).toBe('ex:tree')
      expect(reports[0]![0]!.position.x).toBeCloseTo(after.x, 1)
      expect(reports[0]![0]!.position.y).toBeCloseTo(after.y, 1)
      expect(reports[0]![0]!.from.x).toBeCloseTo(before.x, 1)
      expect(reports[0]![0]!.from.y).toBeCloseTo(before.y, 1)
      // And it reaches a listener that never held the view, like every other event here.
      expect(await movesReported(page, 'dom-move')).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a couple of pixels of movement while clicking is still a click', async () => {
    const page = await load()
    try {
      const before = await cardAt(page, 'ex:ore')
      const box = (await page.locator('.flg-node[data-node-id="ex:ore"]').boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      // The tremor in an ordinary click -- more on a trackpad, more again for an unsteady hand.
      // If this counted as a drag, selecting anything on this canvas would be a lottery.
      await page.mouse.move(x + 2, y + 2, { steps: 2 })
      await page.mouse.up()
      await page.waitForTimeout(60)

      expect(await cardAt(page, 'ex:ore')).toEqual(before)
      expect(await movesReported(page)).toEqual([])
      const selected = await selections(page)
      expect(selected).toHaveLength(1)
      expect(selected[0]?.nodeId).toBe('ex:ore')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('dragging a card moves the card, dragging the background moves the camera, and neither does the other', async () => {
    const page = await load()
    try {
      const cameraBefore = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera())
      const otherBefore = await cardAt(page, 'ex:agg')

      await dragCard(page, 'ex:ore', 90, 45)

      const cameraAfterCardDrag = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera())
      expect(cameraAfterCardDrag).toEqual(cameraBefore)
      // Only the card that was grabbed moved. A drag that also nudged its neighbours would mean
      // correcting one box rearranged the drawing being corrected.
      expect(await cardAt(page, 'ex:agg')).toEqual(otherBefore)
      // A DRAG IS NOT A SELECTION: the click the browser synthesises on release is swallowed.
      expect(await selections(page)).toEqual([])

      // ...and the background still pans, which is the gesture the card drag had to be told
      // apart from in the first place.
      const dropped = await cardAt(page, 'ex:ore')
      await page.mouse.move(700, 860)
      await page.mouse.down()
      await page.mouse.move(600, 800, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(60)
      const panned = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number; zoom: number } } }).view.getCamera())
      expect(panned.x).toBeGreaterThan(cameraBefore.x)
      expect(await cardAt(page, 'ex:ore')).toEqual(dropped)
      expect(await movesReported(page)).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a drag re-routes what moved and rebuilds nothing', async () => {
    const page = await load()
    try {
      // Every element gets a mark that only survives if that exact element survives. Re-running
      // render() on every pointermove -- the obvious implementation -- replaces all of them, and
      // was measured at about 10 ms of scripting on this 15-node fixture and 144 ms on a
      // 900-node graph, which is nine dropped frames per mouse move.
      await page.evaluate(() => {
        document.querySelectorAll('.flg-node, .flg-chip, .flg-edge').forEach((el, i) => {
          ;(el as unknown as { __mark?: number }).__mark = i
        })
      })
      const pathsBefore = await page.$$eval('.flg-edge-line', (els) => els.map((e) => e.getAttribute('d') ?? ''))

      await dragCard(page, 'ex:tree', 130, 70)

      const survivors = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.flg-node, .flg-chip, .flg-edge')]
        return { total: all.length, marked: all.filter((el) => (el as unknown as { __mark?: number }).__mark !== undefined).length }
      })
      expect(survivors.marked).toBe(survivors.total)
      expect(survivors.total).toBeGreaterThan(0)

      const pathsAfter = await page.$$eval('.flg-edge-line', (els) => els.map((e) => e.getAttribute('d') ?? ''))
      expect(pathsAfter).toHaveLength(pathsBefore.length)
      const changed = pathsAfter.filter((d, i) => d !== pathsBefore[i]).length
      // The edges that touch the moved card, and the ones whose port slots it renumbered -- not
      // nothing, and not everything.
      expect(changed).toBeGreaterThan(0)
      expect(changed).toBeLessThan(pathsBefore.length)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('lines a dragged card up with its neighbours, shows what it locked onto, and lets ALT off', async () => {
    const page = await load()
    try {
      // `ex:ore` and `ex:rule` share a left edge in the fixture grid, so a card nudged five
      // pixels off that column is exactly the case alignment snapping exists for.
      const before = await cardAt(page, 'ex:ore')
      const box = (await page.locator('.flg-node[data-node-id="ex:ore"]').boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 5, y, { steps: 4 })
      await page.waitForTimeout(60)
      // The guide is the whole reason a snap is not just a canvas that feels sticky.
      expect(await page.locator('.flg-guide.flg-guide-on').count()).toBeGreaterThan(0)
      await page.mouse.up()
      await page.waitForTimeout(60)

      expect(await page.locator('.flg-guide.flg-guide-on').count()).toBe(0)
      const snapped = await cardAt(page, 'ex:ore')
      expect(snapped.x).toBeCloseTo(before.x, 3)
      // Snapped back onto the column it started in, so nothing was reported -- there was no move.
      expect(await movesReported(page)).toEqual([])

      // ALT defeats it, and the card goes exactly where it was put.
      await dragCard(page, 'ex:ore', 5, 0)
      const free = await cardAt(page, 'ex:ore')
      expect(free.x - before.x).toBeCloseTo(5, 1)
      expect(await movesReported(page)).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('arrow keys move a focused card, and report the burst once rather than the keypresses', async () => {
    const page = await load()
    try {
      const cameraBefore = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number } } }).view.getCamera())
      await page.locator('.flg-node[data-node-id="ex:agg"]').focus()
      const before = await cardAt(page, 'ex:agg')

      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Shift+ArrowDown')
      await page.waitForTimeout(60)

      const after = await cardAt(page, 'ex:agg')
      expect(after.x - before.x).toBeCloseTo(16, 3)
      expect(after.y - before.y).toBeCloseTo(48, 3)
      // The arrows moved the CARD, not the view: on the canvas itself they still pan, which is
      // why onKeyDown checks its own target.
      expect(await page.evaluate(() => (window as never as { view: { getCamera(): { x: number; y: number } } }).view.getCamera())).toEqual(cameraBefore)
      // Nothing yet -- four presses are one gesture, and on the other end of a report is a file.
      expect(await movesReported(page)).toEqual([])

      await page.waitForTimeout(450)
      const reports = await movesReported(page)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toHaveLength(1)
      expect(reports[0]![0]!.nodeId).toBe('ex:agg')
      expect(reports[0]![0]!.position.x).toBeCloseTo(before.x + 16, 1)
      expect(reports[0]![0]!.from.y).toBeCloseTo(before.y, 1)
    } finally {
      await page.close()
    }
  }, 30_000)

  // -- dragging a CONNECTION -----------------------------------------------
  //
  // The gesture this canvas was missing, and the one everybody expects from a drawing of
  // connected boxes. Everything here goes through real pointer and key events for the same reason
  // the card drag does: the substance of this feature is what the browser does with a press, a
  // capture and a hit test, and a test that called into the view would pass with the gesture
  // completely broken.
  //
  // The thing under test is as much what it does NOT do: the two gestures that were already here
  // (a press on a card moves the card, a press on the background pans) must both still work
  // exactly as they did, because a third gesture that ate one of them would be a bad trade.

  /** The handle a connection is dragged out of, in client coordinates. */
  const portBox = async (page: Page, id: string) => {
    const box = await page.locator(`.flg-node[data-node-id="${id}"] .flg-node-port`).boundingBox()
    expect(box, `${id} has no connector handle`).not.toBeNull()
    return box!
  }

  /** Presses the handle on `from` and drags to the middle of `to`, WITHOUT releasing -- so a test
   * can assert what the canvas is saying while the button is still down, which is the whole
   * point of the feedback. */
  async function dragConnection(page: Page, from: string, to: string): Promise<void> {
    const port = await portBox(page, from)
    const target = (await page.locator(`.flg-node[data-node-id="${to}"]`).boundingBox())!
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
    await page.waitForTimeout(80)
  }

  type ConnectReport = { from: string; to: string; verdict: { allowed: boolean; label: string; detail: string; asks?: string[] } }

  const connectsReported = (page: Page, via = 'onConnect') =>
    page.evaluate((channel) => {
      const all = (window as never as { events: Array<{ via: string; request?: unknown }> }).events
      return JSON.parse(JSON.stringify(all.filter((e) => e.via === channel).map((e) => e.request))) as ConnectReport[]
    }, via) as Promise<ConnectReport[]>

  const linkState = (page: Page) =>
    page.evaluate(() => {
      const tip = document.querySelector('.flg-link-tip') as HTMLElement | null
      const line = document.querySelector('.flg-link-line')
      return {
        linking: document.querySelector('.flg-graph')!.classList.contains('flg-linking'),
        armed: document.querySelector('.flg-graph')!.classList.contains('flg-linking-armed'),
        line: line?.getAttribute('d') ?? '',
        lineBad: line?.classList.contains('flg-link-bad') ?? false,
        tipShown: tip !== null && !tip.hidden,
        tipBad: tip?.classList.contains('flg-link-tip-bad') ?? false,
        tipAsks: tip?.classList.contains('flg-link-tip-asks') ?? false,
        tipText: tip?.textContent ?? '',
        ok: [...document.querySelectorAll('.flg-node.flg-link-ok')].map((e) => (e as HTMLElement).dataset.nodeId),
        bad: [...document.querySelectorAll('.flg-node.flg-link-bad')].map((e) => (e as HTMLElement).dataset.nodeId),
      }
    })

  it('every card carries a connector handle, and it is a real control', async () => {
    const page = await load()
    try {
      const handles = await page.$$eval('.flg-node-port', (els) =>
        els.map((e) => ({
          for: (e as HTMLElement).dataset.portFor,
          tabIndex: (e as HTMLElement).tabIndex,
          role: e.getAttribute('role'),
          label: e.getAttribute('aria-label') ?? '',
          refuses: (e as HTMLElement).dataset.refuses ?? '',
          title: (e as HTMLElement).title,
        })),
      )
      expect(handles).toHaveLength(kitchenSinkGraph().nodes.length)
      for (const handle of handles) {
        expect(handle.role).toBe('button')
        expect(handle.tabIndex).toBe(0)
        expect(handle.label).toContain(handle.for)
        // Every handle answers for itself before it is touched, including the ones that refuse.
        expect(handle.title.length).toBeGreaterThan(20)
      }
      // A type that holds another feature and a type that does not are told apart on the handle
      // itself, so the refusal is visible before anything is dragged anywhere.
      expect(handles.find((h) => h.for === 'ex:agg')!.refuses).toBe('')
      expect(handles.find((h) => h.for === 'ex:ore')!.refuses).toBe('true')
      expect(handles.find((h) => h.for === 'ex:ore')!.title).toMatch(/holds no other feature/)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('dragging from the handle connects, and does not move the card or the camera', async () => {
    const page = await load()
    try {
      const cameraBefore = await page.evaluate(() => (window as never as { view: { getCamera(): unknown } }).view.getCamera())
      const sourceBefore = await cardAt(page, 'ex:agg')
      const targetBefore = await cardAt(page, 'ex:ore')

      await dragConnection(page, 'ex:agg', 'ex:ore')
      // While the button is down: a line, and the target card saying yes.
      const during = await linkState(page)
      expect(during.linking).toBe(true)
      expect(during.line).toMatch(/^M [-\d.]+ [-\d.]+ C/)
      expect(during.lineBad).toBe(false)
      expect(during.ok).toEqual(['ex:ore'])
      expect(during.tipShown).toBe(true)
      expect(during.tipText).toContain('aggregate')

      await page.mouse.up()
      await page.waitForTimeout(60)

      const reports = await connectsReported(page)
      expect(reports).toHaveLength(1)
      expect(reports[0]!.from).toBe('ex:agg')
      expect(reports[0]!.to).toBe('ex:ore')
      expect(reports[0]!.verdict.allowed).toBe(true)
      // And it reaches a listener that never held the view, like every other event here.
      expect(await connectsReported(page, 'dom-connect')).toHaveLength(1)

      // THE GESTURES DO NOT FIGHT. Neither card moved, the camera did not move, and the canvas
      // is clean again.
      expect(await cardAt(page, 'ex:agg')).toEqual(sourceBefore)
      expect(await cardAt(page, 'ex:ore')).toEqual(targetBefore)
      expect(await page.evaluate(() => (window as never as { view: { getCamera(): unknown } }).view.getCamera())).toEqual(cameraBefore)
      expect(await movesReported(page)).toEqual([])
      // Nor is completing a connection a selection: the inspector does not follow the line.
      expect(await selections(page)).toEqual([])
      const after = await linkState(page)
      expect(after.linking).toBe(false)
      expect(after.tipShown).toBe(false)
      expect(after.ok).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('an illegal drop LOOKS illegal before the button comes up, and reports nothing', async () => {
    const page = await load()
    try {
      // Nothing in the format can delegate to a feature rule. That is a fact the author needs
      // while the line is still in their hand -- an error after the release is an error about
      // work already done.
      await dragConnection(page, 'ex:scatter', 'ex:rule')
      const during = await linkState(page)
      expect(during.lineBad).toBe(true)
      expect(during.bad).toEqual(['ex:rule'])
      expect(during.ok).toEqual([])
      expect(during.tipBad).toBe(true)
      expect(during.tipText).toMatch(/rule/i)
      // The illegal target differs from a legal one by TEXTURE as well as by colour, because a
      // high-contrast theme flattens the two to the same value.
      const hatched = await page.evaluate(
        () => getComputedStyle(document.querySelector('.flg-node[data-node-id="ex:rule"]')!).backgroundImage,
      )
      expect(hatched).toMatch(/gradient/)

      await page.mouse.up()
      await page.waitForTimeout(60)
      expect(await connectsReported(page)).toEqual([])
      expect((await linkState(page)).linking).toBe(false)
      expect(await page.$$eval('.flg-node.flg-link-bad', (els) => els.length)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a drag from a type that holds no other feature refuses at the handle and SAYS so', async () => {
    const page = await load()
    try {
      const before = await cardAt(page, 'ex:ore')
      const port = await portBox(page, 'ex:ore')
      await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2)
      await page.mouse.down()
      await page.mouse.move(port.x + 120, port.y + 60, { steps: 6 })
      await page.waitForTimeout(80)

      const during = await linkState(page)
      // No line was ever started, and the refusal is on screen rather than waiting for a drop.
      expect(during.linking).toBe(false)
      expect(during.line).toBe('')
      expect(during.tipShown).toBe(true)
      expect(during.tipBad).toBe(true)
      expect(during.tipText).toMatch(/holds no other feature/)
      // It also says what to do instead, which is the difference between a refusal and a wall.
      expect(during.tipText).toMatch(/wrap it/)
      expect(await page.$$eval('.flg-node-port.flg-node-port-refused', (els) => els.length)).toBe(1)

      await page.mouse.up()
      await page.waitForTimeout(60)
      // And the press that refused did not become a card drag on the way out.
      expect(await cardAt(page, 'ex:ore')).toEqual(before)
      expect(await movesReported(page)).toEqual([])
      expect(await connectsReported(page)).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('says what a drop will REPLACE, and that it will ask, before either happens', async () => {
    const page = await load()
    try {
      // A scatter holds ONE feature and already holds one. Connecting a second REPLACES the
      // first, and that has to be readable before the button comes up.
      await dragConnection(page, 'ex:scatter', 'ex:ore')
      const replacing = await linkState(page)
      expect(replacing.lineBad).toBe(false)
      expect(replacing.tipText).toContain('replaces ex:tree')
      expect(replacing.tipText).toMatch(/instead of ex:tree/)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(60)
      expect(await connectsReported(page)).toEqual([])

      // A weighted pick needs a number nothing can supply for it. The drop is legal and it will
      // open a question -- said in advance, so the form is not a surprise.
      await dragConnection(page, 'ex:weighted', 'ex:ore')
      const asking = await linkState(page)
      expect(asking.tipAsks).toBe(true)
      expect(asking.tipBad).toBe(false)
      expect(asking.tipText).toMatch(/weight/i)
      await page.mouse.up()
      await page.waitForTimeout(60)
      const reports = await connectsReported(page)
      expect(reports).toHaveLength(1)
      expect(reports[0]!.verdict.asks).toEqual(['weight'])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('Escape abandons a connection in flight, and does not also clear the selection', async () => {
    const page = await load()
    try {
      await page.locator('.flg-node[data-node-id="ex:seq"]').click()
      await page.waitForTimeout(40)
      await dragConnection(page, 'ex:agg', 'ex:ore')
      expect((await linkState(page)).linking).toBe(true)

      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(60)

      expect((await linkState(page)).linking).toBe(false)
      expect(await connectsReported(page)).toEqual([])
      // One Escape, one undo, and the one the user means is the line in their hand.
      expect(await page.evaluate(() => (window as never as { view: { getSelection(): { nodeId?: string } | null } }).view.getSelection())).toMatchObject(
        { nodeId: 'ex:seq' },
      )
    } finally {
      await page.close()
    }
  }, 30_000)

  it('can be driven entirely from the keyboard, and Enter on a card still means "open" afterwards', async () => {
    const page = await load()
    try {
      // A canvas whose one new verb needs a mouse is a canvas that got worse for the people who
      // do not use one.
      await page.locator('.flg-node[data-node-id="ex:agg"] .flg-node-port').focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(60)

      const armed = await linkState(page)
      expect(armed.armed).toBe(true)
      expect(armed.tipText).toMatch(/press Enter/)
      // Every card is answered at once, which is what makes tabbing through them not blind.
      expect(armed.ok).toContain('ex:ore')
      expect(armed.bad).toContain('ex:rule')
      expect(armed.ok).not.toContain('ex:agg')

      await page.locator('.flg-node[data-node-id="ex:ore"]').focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(60)

      const reports = await connectsReported(page)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ from: 'ex:agg', to: 'ex:ore' })
      expect((await linkState(page)).armed).toBe(false)
      // Enter while armed meant "connect", and did NOT also mean the card's own "open this" --
      // which is why it is taken in the capture phase rather than by teaching the card a mode.
      const activations = await page.evaluate(() => {
        const all = (window as never as { events: Array<{ via: string }> }).events
        return all.filter((e) => e.via === 'onActivate').length
      })
      expect(activations).toBe(0)

      // And with the mode over, Enter on a card is "open this" again.
      await page.keyboard.press('Enter')
      await page.waitForTimeout(40)
      expect(
        await page.evaluate(() => {
          const all = (window as never as { events: Array<{ via: string }> }).events
          return all.filter((e) => e.via === 'onActivate').length
        }),
      ).toBe(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('refuses an armed connection onto an illegal card without leaving the mode', async () => {
    const page = await load()
    try {
      await page.locator('.flg-node[data-node-id="ex:agg"] .flg-node-port').focus()
      await page.keyboard.press('Enter')
      await page.locator('.flg-node[data-node-id="ex:rule"]').focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(60)

      expect(await connectsReported(page)).toEqual([])
      const state = await linkState(page)
      // Still armed, with the reason on screen: the author picked the wrong card, not the wrong
      // gesture, so the gesture is not thrown away under them.
      expect(state.armed).toBe(true)
      expect(state.tipBad).toBe(true)
      expect(state.tipText).toMatch(/rule/i)

      await page.keyboard.press('Escape')
      await page.waitForTimeout(40)
      expect((await linkState(page)).armed).toBe(false)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('takes the handle away out at the far zoom band, where a card is thirty pixels wide', async () => {
    const page = await load()
    try {
      expect(await page.locator('.flg-node[data-node-id="ex:agg"] .flg-node-port').boundingBox()).not.toBeNull()
      await page.evaluate(() => (window as never as { view: { setCamera(c: unknown): void } }).view.setCamera({ zoom: 0.2 }))
      await page.waitForTimeout(80)
      // Not removed -- hidden, like every other thing the zoom bands drop, so zooming back in
      // cannot lose anything.
      expect(await page.$$eval('.flg-node-port', (els) => els.length)).toBe(kitchenSinkGraph().nodes.length)
      expect(await page.locator('.flg-node[data-node-id="ex:agg"] .flg-node-port').boundingBox()).toBeNull()
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a host can turn the gesture off entirely, and then there is no handle to press', async () => {
    const page = await load()
    try {
      await page.evaluate(
        ({ graph, positions }) => {
          const api = (window as unknown as { FLG: Record<string, unknown> }).FLG
          const create = api.createGraphView as (host: HTMLElement, options?: unknown) => Record<string, unknown>
          const host = document.createElement('div')
          host.id = 'second'
          host.style.cssText = 'position:absolute;inset:0'
          document.body.append(host)
          const view = create(host, { connectPolicy: false })
          ;(view.render as (g: unknown, p: Map<string, unknown>) => void)(graph, new Map(positions as Array<[string, unknown]>))
        },
        { graph: kitchenSinkGraph(), positions: kitchenSinkPositions() },
      )
      expect(await page.$$eval('#second .flg-node', (els) => els.length)).toBeGreaterThan(0)
      expect(await page.$$eval('#second .flg-node-port', (els) => els.length)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('Escape abandons a drag in flight, putting the card back and reporting nothing', async () => {
    const page = await load()
    try {
      const before = await cardAt(page, 'ex:seq')
      const box = (await page.locator('.flg-node[data-node-id="ex:seq"]').boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 90, { steps: 6 })
      await page.waitForTimeout(60)
      expect((await cardAt(page, 'ex:seq')).x).not.toBeCloseTo(before.x, 1)

      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(60)

      expect(await cardAt(page, 'ex:seq')).toEqual(before)
      expect(await movesReported(page)).toEqual([])
      // Escape cancelled the DRAG, not the selection -- one Escape, one undo, and the one in
      // the user's hand is the gesture.
      const stillSelected = await page.evaluate(() => (window as never as { view: { getSelection(): unknown } }).view.getSelection())
      expect(stillSelected).toBeNull()
    } finally {
      await page.close()
    }
  }, 30_000)

  it('stores nothing: a re-render with the host\'s own positions puts a dragged card back', async () => {
    const page = await load()
    try {
      const before = await cardAt(page, 'ex:ore')
      await dragCard(page, 'ex:ore', 200, 120)
      expect((await cardAt(page, 'ex:ore')).x).toBeCloseTo(before.x + 200, 0)

      // The view reports the move and remembers nothing about it, exactly as it emits a
      // selection and acts on nothing. A host that persists the report re-renders with the new
      // coordinate; a host that drops it gets the old one back, which is the honest outcome and
      // not a bug -- where a drawing is saved is not a rendering decision.
      await page.evaluate(
        ({ graph, positions }) => {
          const view = (window as never as { view: { render(g: unknown, p: Map<string, unknown>): void } }).view
          view.render(graph, new Map(positions as Array<[string, unknown]>))
        },
        { graph: kitchenSinkGraph(), positions: kitchenSinkPositions() },
      )
      expect(await cardAt(page, 'ex:ore')).toEqual(before)
      expect(await movesReported(page)).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('clamps zoom and frames the whole graph on zoomToFit, dangling nodes included', async () => {
    const page = await load()
    try {
      const clamped = await page.evaluate(() => {
        const view = (window as never as { view: { setCamera(c: unknown): void; getCamera(): { zoom: number } } }).view
        view.setCamera({ zoom: 9999 })
        const high = view.getCamera().zoom
        view.setCamera({ zoom: 0.0001 })
        return { high, low: view.getCamera().zoom }
      })
      expect(clamped.high).toBeLessThanOrEqual(4)
      expect(clamped.low).toBeGreaterThanOrEqual(0.1)

      await page.evaluate(() => (window as never as { view: { zoomToFit(): void } }).view.zoomToFit())
      await page.waitForTimeout(80)
      const host = (await page.locator('.flg-graph').boundingBox())!
      const outside = await page.$$eval('.flg-node', (els, bounds) => {
        const out: string[] = []
        for (const e of els) {
          const r = e.getBoundingClientRect()
          if (r.left < bounds.x - 1 || r.top < bounds.y - 1 || r.right > bounds.x + bounds.width + 1 || r.bottom > bounds.y + bounds.height + 1) {
            out.push((e as HTMLElement).dataset.nodeId ?? '?')
          }
        }
        return out
      }, host)
      expect(outside).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('emits a selection for a node and for an edge, and does nothing else with it', async () => {
    const page = await load()
    try {
      await page.locator('.flg-node[data-node-id="ex:tree"]').click({ timeout: 4000 })
      await page.locator('.flg-chip-sequence').first().click({ timeout: 4000 })

      const events = await page.evaluate(() => JSON.parse(JSON.stringify((window as never as { events: unknown[] }).events)) as Array<{ via: string; s: { kind?: string; nodeId?: string; edgeKey?: string; edge?: { kind: string } } | null }>)

      const nodeSelect = events.find((e) => e.via === 'onSelect' && e.s?.kind === 'node')
      expect(nodeSelect?.s?.nodeId).toBe('ex:tree')
      // The same selection also reaches a listener that never held the view -- what lets the
      // message-handling half of a webview stay decoupled from the rendering half.
      expect(events.some((e) => e.via === 'dom' && e.s?.kind === 'node')).toBe(true)

      const edgeSelect = events.find((e) => e.via === 'onSelect' && e.s?.kind === 'edge')
      expect(edgeSelect?.s?.edge?.kind).toBe('sequence')
      expect(typeof edgeSelect?.s?.edgeKey).toBe('string')

      // Emitting is ALL it does: nothing was navigated, nothing collapsed, nothing was removed.
      expect(await page.evaluate(() => document.querySelectorAll('.flg-node').length)).toBe(kitchenSinkGraph().nodes.length)
      expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('an edge is selectable by its line, not only by its chip, and both light up together', async () => {
    const page = await load()
    try {
      // A point actually ON the edge's hit stroke, found by walking the path.
      //
      // This used to be `.click({ force: true })`, which dispatches at the element's BOUNDING BOX
      // centre -- fine for a shallow arc, whose box centre is near the curve, and meaningless for
      // the S the router draws now, whose box centre is in the empty space the S curves around.
      // A test for "clicking the line selects the edge" has to click the line; asking the path
      // where it is, rather than assuming, is what makes it a test of the behaviour instead of a
      // test of the shape. The chip sits at the curve's own midpoint, so the candidates start
      // away from it -- clicking the chip would prove something else.
      const point = await page.evaluate(() => {
        const hit = document.querySelector('.flg-edge-scatter .flg-edge-hit') as SVGGeometryElement | null
        if (!hit) return null
        const ctm = hit.getScreenCTM()
        if (!ctm) return null
        const total = hit.getTotalLength()
        for (const fraction of [0.3, 0.7, 0.45, 0.85, 0.15]) {
          const at = hit.getPointAtLength(total * fraction).matrixTransform(ctm)
          if (document.elementFromPoint(at.x, at.y) === hit) return { x: at.x, y: at.y }
        }
        return null
      })
      expect(point, 'no point on the scatter edge was reachable by a click').not.toBeNull()
      await page.mouse.click(point!.x, point!.y)

      const selected = await page.evaluate(() => ({
        groups: document.querySelectorAll('.flg-edge.flg-selected').length,
        chips: document.querySelectorAll('.flg-chip.flg-selected').length,
        kind: (document.querySelector('.flg-edge.flg-selected') as SVGElement | null)?.getAttribute('data-edge-kind'),
      }))
      expect(selected.groups).toBe(1)
      expect(selected.chips).toBe(1)
      expect(selected.kind).toBe('scatter')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('setSelection applies without emitting, so a host that both listens and sets cannot loop', async () => {
    const page = await load()
    try {
      const emitted = await page.evaluate(() => {
        const w = window as never as { view: { setSelection(s: unknown): void }; events: unknown[] }
        const before = w.events.length
        w.view.setSelection({ kind: 'node', nodeId: 'ex:ore' })
        return { added: w.events.length - before, selected: document.querySelectorAll('.flg-node.flg-selected').length }
      })
      expect(emitted.added).toBe(0)
      expect(emitted.selected).toBe(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a re-render keeps the camera and a still-present selection, and drops a vanished one', async () => {
    const page = await load()
    try {
      await page.locator('.flg-node[data-node-id="ex:tree"]').click({ timeout: 4000 })
      await page.evaluate(() => (window as never as { view: { setCamera(c: unknown): void } }).view.setCamera({ x: 123, y: 45, zoom: 1.5 }))

      const kept = await page.evaluate(
        ({ graph, positions }) => {
          const w = window as never as { view: { render(g: unknown, p: Map<string, unknown>): void; getCamera(): { x: number }; getSelection(): { kind: string } | null } }
          w.view.render(graph, new Map(positions as Array<[string, unknown]>))
          return { camera: w.view.getCamera().x, selection: w.view.getSelection()?.kind ?? null }
        },
        { graph: kitchenSinkGraph(), positions: kitchenSinkPositions() },
      )
      // Regenerate-on-save must not throw away where the user was looking or what they had
      // selected -- the same promise previewPanel.ts makes for the 3D preview's camera.
      expect(kept.camera).toBe(123)
      expect(kept.selection).toBe('node')

      const dropped = await page.evaluate(() => {
        const w = window as never as { view: { render(g: unknown, p: Map<string, unknown>): void; getSelection(): unknown } }
        w.view.render({ nodes: [{ id: 'other' }], edges: [], roots: ['other'] }, new Map([['other', { x: 0, y: 0 }]]))
        return w.view.getSelection()
      })
      expect(dropped).toBeNull()
    } finally {
      await page.close()
    }
  }, 30_000)

  it('nodes and chips are keyboard reachable and activate with Enter', async () => {
    const page = await load()
    try {
      const activated = await page.evaluate(() => {
        const node = document.querySelector('.flg-node[data-node-id="ex:seq"]') as HTMLElement
        node.focus()
        const focused = document.activeElement === node
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        const events = (window as never as { events: Array<{ via: string }> }).events
        return { focused, tabIndex: node.tabIndex, role: node.getAttribute('role'), activate: events.some((e) => e.via === 'onActivate') }
      })
      expect(activated.focused).toBe(true)
      expect(activated.tabIndex).toBe(0)
      expect(activated.role).toBe('button')
      expect(activated.activate).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('survives a graph whose every node is in one cycle and whose layout supplied nothing', async () => {
    const page = await load()
    try {
      // The contract's own warning, taken literally: a consumer that walks the graph as if
      // cycles cannot happen will hang here. A timeout on this evaluate IS the failure.
      const drawn = await page.evaluate(() => {
        const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `c:${i}`, typeId: 'minecraft:aggregate_feature', coverage: 'implemented' }))
        const edges = nodes.map((n, i) => ({ from: n.id, to: `c:${(i + 1) % nodes.length}`, kind: 'aggregate', jsonPath: `$.features[0]`, ordinal: 0, required: false }))
        const cycles = [nodes.map((n) => n.id)]
        const w = window as never as { view: { render(g: unknown, p: Map<string, unknown>): void } }
        const started = performance.now()
        w.view.render({ nodes, edges, roots: [], cycles }, new Map())
        return { nodes: document.querySelectorAll('.flg-node').length, edges: document.querySelectorAll('.flg-edge').length, ms: performance.now() - started }
      })
      expect(drawn.nodes).toBe(60)
      expect(drawn.edges).toBe(60)
      expect(drawn.ms).toBeLessThan(4000)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('never interprets pack text as markup', async () => {
    const page = await load()
    try {
      const safe = await page.evaluate(() => {
        const hostile = '<img src=x onerror="window.__pwned=1">'
        const w = window as never as { view: { render(g: unknown, p: Map<string, unknown>): void } }
        w.view.render(
          {
            nodes: [{ id: hostile, typeId: hostile, coverage: 'partial', coverageNote: hostile }, { id: 'b' }],
            edges: [{ from: hostile, to: 'b', kind: 'conditional', jsonPath: '$.x', ordinal: 0, required: false, condition: hostile }],
            roots: [hostile],
          },
          new Map([
            [hostile, { x: 0, y: 0 }],
            ['b', { x: 400, y: 0 }],
          ]),
        )
        return {
          pwned: (window as never as { __pwned?: number }).__pwned ?? 0,
          images: document.querySelectorAll('.flg-graph img').length,
          text: document.querySelector('.flg-node-id')?.textContent,
        }
      })
      expect(safe.pwned).toBe(0)
      expect(safe.images).toBe(0)
      expect(safe.text).toBe('<img src=x onerror="window.__pwned=1">')
    } finally {
      await page.close()
    }
  }, 30_000)

  // -- theming ------------------------------------------------------------

  it('graph.css declares no raw colour outside its variable blocks', () => {
    // The rule frontend/src/ui/panel.css states and this file's header restates. Enforced
    // statically because a hard-coded colour looks perfectly fine in whichever theme the author
    // happened to be using, and only goes wrong for someone else.
    const offenders: string[] = []
    let inVariableBlock = false
    const lines = css.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      const line = raw.replace(/\/\*.*?\*\//g, '').trim()
      if (line.startsWith('/*') || line.startsWith('*')) continue
      const declaration = line.startsWith('--')
      if (declaration) {
        inVariableBlock = true
        continue
      }
      if (line.endsWith('{') || line === '}') {
        inVariableBlock = false
        continue
      }
      if (inVariableBlock) continue
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line) || /\bhsla?\(/.test(line)) {
        offenders.push(`line ${i + 1}: ${line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  const probeColours = (page: Page) =>
    page.evaluate(() => {
      const read = (selector: string, property: string): string => {
        const element = document.querySelector(selector)
        return element ? getComputedStyle(element).getPropertyValue(property).trim() : ''
      }
      return {
        canvasBg: read('.flg-graph', 'background-color'),
        nodeBg: read('.flg-node', 'background-color'),
        nodeFg: read('.flg-node', 'color'),
        typeFg: read('.flg-node-type', 'color'),
        unresolved: read('.flg-node-unresolved', 'border-top-color'),
        sequence: read('.flg-edge-sequence .flg-edge-line', 'stroke'),
        aggregate: read('.flg-edge-aggregate .flg-edge-line', 'stroke'),
        weighted: read('.flg-edge-weighted .flg-edge-line', 'stroke'),
        conditional: read('.flg-edge-conditional .flg-edge-line', 'stroke'),
        scatter: read('.flg-edge-scatter .flg-edge-line', 'stroke'),
        child: read('.flg-edge-child .flg-edge-line', 'stroke'),
        molang: read('.flg-chip-molang .flg-chip-label', 'color'),
        arrow: read('.flg-edge-rule .flg-edge-arrow', 'fill'),
      }
    })

  it('takes every rendered colour from the host theme, with none baked into the stylesheet', async () => {
    // Dark+ versus a palette in which every variable is a distinct sentinel colour. Anything
    // that fails to move between those two is a colour graph.css supplied itself -- which is
    // what the `prefers-color-scheme: light` fallback block used to do to the whole canvas,
    // painting a real DARK theme's background white because a bare literal there outranks the
    // `--vscode-*` value it was only ever meant to stand in for.
    const darkPage = await load(DARK_THEME)
    const sentinelPage = await load(sentinelTheme())
    try {
      const dark = await probeColours(darkPage)
      const sentinel = await probeColours(sentinelPage)
      for (const [key, value] of Object.entries(dark)) expect(value, `dark ${key}`).not.toBe('')
      for (const key of Object.keys(dark) as Array<keyof typeof dark>) {
        expect(sentinel[key], `${key} is hard-coded -- it ignored the host theme`).not.toBe(dark[key])
      }
    } finally {
      await darkPage.close()
      await sentinelPage.close()
    }
  }, 45_000)

  it('stays legible in a real dark theme and a real light one', async () => {
    const darkPage = await load(DARK_THEME)
    const lightPage = await load(LIGHT_THEME)
    try {
      const dark = await probeColours(darkPage)
      const light = await probeColours(lightPage)
      // Nothing may be blank: a typo in a variable name silently yields the empty string, and
      // the element then inherits something that happens to look plausible in one theme.
      for (const [key, value] of Object.entries(dark)) expect(value, `dark ${key}`).not.toBe('')
      for (const [key, value] of Object.entries(light)) expect(value, `light ${key}`).not.toBe('')
      // The two palettes must genuinely differ overall -- but NOT every value: Dark+ and Light+
      // legitimately ship the same `charts.orange`, and demanding movement there would be
      // demanding the stylesheet override the theme, which is the opposite of the goal.
      const moved = (Object.keys(dark) as Array<keyof typeof dark>).filter((k) => light[k] !== dark[k])
      expect(moved.length).toBeGreaterThan(Object.keys(dark).length / 2)
      // Background and body text specifically must invert; if those held still the canvas would
      // be a dark panel in a light editor.
      expect(light.canvasBg).not.toBe(dark.canvasBg)
      expect(light.nodeFg).not.toBe(dark.nodeFg)

      // And legible, not merely different: body text against the node surface must clear WCAG AA
      // for normal text in BOTH themes.
      for (const [name, page] of [['dark', darkPage], ['light', lightPage]] as const) {
        const ratio = await page.evaluate(() => {
          const parse = (value: string): [number, number, number] => {
            const parts = value.match(/[\d.]+/g) ?? []
            return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)]
          }
          const luminance = (rgb: [number, number, number]): number => {
            const channel = (c: number): number => {
              const s = c / 255
              return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
          }
          const node = document.querySelector('.flg-node')!
          const style = getComputedStyle(node)
          const a = luminance(parse(style.color))
          const b = luminance(parse(style.backgroundColor))
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        })
        expect(ratio, `${name} node text contrast`).toBeGreaterThanOrEqual(4.5)
      }
    } finally {
      await darkPage.close()
      await lightPage.close()
    }
  }, 45_000)

  it('hides chip text when zoomed far out, and brings it back without a re-render', async () => {
    const page = await load()
    try {
      const before = await page.evaluate(() => document.querySelectorAll('.flg-chip').length)
      await page.evaluate(() => (window as never as { view: { setCamera(c: unknown): void } }).view.setCamera({ zoom: 0.2 }))
      await page.waitForTimeout(80)
      expect(await page.getAttribute('.flg-graph', 'data-zoom-band')).toBe('far')
      expect(await page.locator('.flg-chip').first().isVisible()).toBe(false)
      // The node text goes with them -- at this scale a card is about thirty pixels wide and an
      // 11px label on it is a smear. What survives is the card as a solid block in its category's
      // colour, which is the only question answerable from that far out.
      expect(await page.locator('.flg-node[data-node-id="ex:tree"] .flg-node-id').isVisible()).toBe(false)
      const blocks = await page.evaluate(() =>
        ['ex:seq', 'ex:agg', 'ex:weighted'].map((id) => getComputedStyle(document.querySelector(`.flg-node[data-node-id="${id}"] .flg-node-head`)!).backgroundColor),
      )
      expect(new Set(blocks).size).toBe(3)
      // And the edges stop scaling with the camera, so the structure they carry is still drawn
      // rather than reduced to a quarter of a pixel.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.flg-edge-rule .flg-edge-line')!).vectorEffect)).toBe('non-scaling-stroke')

      await page.evaluate(() => (window as never as { view: { setCamera(c: unknown): void } }).view.setCamera({ zoom: 1.5 }))
      await page.waitForTimeout(80)
      expect(await page.getAttribute('.flg-graph', 'data-zoom-band')).toBe('near')
      expect(await page.locator('.flg-chip').first().isVisible()).toBe(true)
      // The chips were never removed, so nothing about them can be lost by zooming.
      expect(await page.evaluate(() => document.querySelectorAll('.flg-chip').length)).toBe(before)

      // The DEFAULT camera has to be a band that shows everything: a threshold above zoom 1 would
      // mean the view someone opens on is the abbreviated one.
      await page.evaluate(() => (window as never as { view: { setCamera(c: unknown): void } }).view.setCamera({ zoom: 1 }))
      await page.waitForTimeout(80)
      expect(await page.getAttribute('.flg-graph', 'data-zoom-band')).toBe('near')
      expect(await page.locator('.flg-node[data-node-id="ex:tree"] .flg-node-id').isVisible()).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('dispose removes the canvas and stops listening', async () => {
    const page = await load()
    try {
      const after = await page.evaluate(() => {
        const w = window as never as { view: { dispose(): void }; events: unknown[] }
        w.view.dispose()
        document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
        return { canvases: document.querySelectorAll('.flg-graph').length, events: w.events.length }
      })
      expect(after.canvases).toBe(0)
      expect(after.events).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)
})
