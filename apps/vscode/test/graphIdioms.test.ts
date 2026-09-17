// graphIdioms.test.ts -- the four author-level actions in src/graph/idioms.ts, and above all the
// things they must REFUSE to do.
//
// The suite leans hard on the refusals, because the failure mode this module exists to prevent is
// not "the action did nothing". It is a refactor that wrote two of its three files: the pack is
// then in a state no author put it in, half the references point somewhere that does not exist
// yet, and the git diff is the only record of what was supposed to happen. Every structural
// assumption these actions make -- that a selection has one way in, that a list's entries are
// adjacent, that an edge's reported JSONPath indexes the entry its ordinal says it does -- has a
// test here asserting that violating it produces a REFUSAL and an empty plan rather than a
// partial one.
//
// The other half is the two Molang idioms. Both are pinned against the exact trap wire/graph.go
// and molangHints.ts describe: a statement sequence with no `return` evaluates to 0, which is
// zero iterations, which is a scatter that silently places nothing. A setup step is the one
// operation that walks straight into it, so "the composed expression still ends in a return" and
// "the existing count survives as the return value" are both asserted directly rather than
// inferred from the shape of the code.
//
// Format versions, type ids, key names and list spellings in the fixtures are the real ones --
// scatter's flat/nested `iterations` split at 1.21.10, weighted_random's [reference, weight]
// tuples, surface_relative_threshold's `feature_to_place` (which does NOT accept `places_feature`)
// -- so a gate that moves fails here rather than passing quietly.
import { describe, expect, it } from 'vitest'
import {
  WRAPPERS,
  availableIdioms,
  extractFeature,
  formatJsonPath,
  gateExpression,
  gateScatter,
  parseJsonPath,
  setupExpression,
  setupScatter,
  wrapNode,
  type EditPlan,
  type IdiomGraph,
  type IdiomGraphEdge,
  type IdiomGraphNode,
  type IdiomResult,
  type PlanOperation,
  type Refusal,
} from '../src/graph/idioms.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VERSION = '1.21.110'

function node(id: string, typeId: string, file: string, extra: Partial<IdiomGraphNode> = {}): IdiomGraphNode {
  return { id, typeId, file, formatVersion: VERSION, ...extra }
}

function listEdge(from: string, typeId: string, key: string, to: string, ordinal: number, kind: string, extra: Partial<IdiomGraphEdge> = {}): IdiomGraphEdge {
  return { from, to, kind, ordinal, jsonPath: `$.${typeId}.${key}[${ordinal}]`, ...extra }
}

function slotEdge(from: string, typeId: string, key: string, to: string, kind: string, extra: Partial<IdiomGraphEdge> = {}): IdiomGraphEdge {
  return { from, to, kind, ordinal: 0, jsonPath: `$.${typeId}.${key}`, ...extra }
}

/** A pack shaped like the ones this action set is for: a rule into an aggregate of four blocks,
 * a scatter with a plain numeric count, a weighted pick, and a conditional list. */
function samplePack(): IdiomGraph {
  const AGG = 'minecraft:aggregate_feature'
  const nodes: IdiomGraphNode[] = [
    node('wiki:rule', 'minecraft:feature_rule', 'feature_rules/rule.fr.json'),
    node('wiki:patch', AGG, 'features/patch.json'),
    node('wiki:a', 'minecraft:single_block_feature', 'features/a.json'),
    node('wiki:b', 'minecraft:single_block_feature', 'features/b.json'),
    node('wiki:c', 'minecraft:single_block_feature', 'features/c.json'),
    node('wiki:d', 'minecraft:single_block_feature', 'features/d.json'),
    node('wiki:scatter', 'minecraft:scatter_feature', 'features/scatter.json'),
    node('wiki:block', 'minecraft:single_block_feature', 'features/block.json'),
  ]
  const edges: IdiomGraphEdge[] = [
    slotEdge('wiki:rule', 'minecraft:feature_rules', 'description.places_feature', 'wiki:patch', 'rule', { required: true }),
    listEdge('wiki:patch', AGG, 'features', 'wiki:a', 0, 'aggregate'),
    listEdge('wiki:patch', AGG, 'features', 'wiki:b', 1, 'aggregate'),
    listEdge('wiki:patch', AGG, 'features', 'wiki:c', 2, 'aggregate'),
    listEdge('wiki:patch', AGG, 'features', 'wiki:d', 3, 'aggregate'),
    slotEdge('wiki:scatter', 'minecraft:scatter_feature', 'places_feature', 'wiki:block', 'scatter', {
      required: true,
      iterations: '8',
    }),
  ]
  return { nodes, edges, roots: ['wiki:rule', 'wiki:scatter'] }
}

function plan(result: IdiomResult): EditPlan {
  if (!result.ok) throw new Error(`expected a plan, got refusal ${result.refusal.code}: ${result.refusal.reason}`)
  return result.plan
}

function refusalOf(result: IdiomResult): Refusal {
  if (result.ok) throw new Error(`expected a refusal, got plan: ${result.plan.title}`)
  return result.refusal
}

function setOps(p: EditPlan): Extract<PlanOperation, { op: 'set' }>[] {
  return p.operations.filter((op): op is Extract<PlanOperation, { op: 'set' }> => op.op === 'set')
}

function createdFile(p: EditPlan): Extract<PlanOperation, { op: 'createFile' }> {
  const op = p.operations.find((o): o is Extract<PlanOperation, { op: 'createFile' }> => o.op === 'createFile')
  if (op === undefined) throw new Error('plan creates no file')
  return op
}

// ---------------------------------------------------------------------------
// The path dialect
// ---------------------------------------------------------------------------

describe('the JSONPath dialect, which every plan is executed against', () => {
  it('spells a Bedrock "minecraft:foo" key BARE, because the write side does', () => {
    // ':' is not a delimiter in jsonc.FormatPath, and if it were, every path in the editor would
    // be quoted. A plan whose paths were quoted where the producer's were not would never match.
    expect(formatJsonPath([{ key: 'minecraft:scatter_feature' }, { key: 'distribution' }, { key: 'iterations' }])).toBe(
      '$.minecraft:scatter_feature.distribution.iterations',
    )
  })

  it('quotes a key containing a path delimiter, and round-trips it', () => {
    const segments = [{ key: 'a.b' }, { index: 2 }, { key: 'c' }]
    const path = formatJsonPath(segments)
    expect(path).toBe('$["a.b"][2].c')
    expect(parseJsonPath(path)).toEqual(segments)
  })

  it('round-trips every path the fixtures use', () => {
    for (const raw of [
      '$.minecraft:aggregate_feature.features[0]',
      '$.minecraft:conditional_list.conditional_features[3].places_feature',
      '$.minecraft:weighted_random_feature.features[1][0]',
      '$.minecraft:feature_rules.description.places_feature',
    ]) {
      expect(formatJsonPath(parseJsonPath(raw)!)).toBe(raw)
    }
  })

  it('reads a malformed path as null rather than throwing, so a caller can refuse', () => {
    expect(parseJsonPath('minecraft:foo')).toBeNull()
    expect(parseJsonPath('$.a[')).toBeNull()
    expect(parseJsonPath('$.a[x]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Action 1 -- scatter as an if-statement
// ---------------------------------------------------------------------------

describe('gateScatter -- "place this only when..."', () => {
  it('multiplies an existing scatter\'s count by the test, in place, in one file', () => {
    const p = plan(gateScatter(samplePack(), { target: 'wiki:scatter', condition: 'query.noise(1, 2) > 0.4' }))
    expect(p.files).toEqual(['features/scatter.json'])
    expect(p.creates).toEqual([])
    expect(setOps(p)).toEqual([
      {
        op: 'set',
        file: 'features/scatter.json',
        path: '$.minecraft:scatter_feature.distribution.iterations',
        json: JSON.stringify('(query.noise(1, 2) > 0.4) * 8'),
        value: '(query.noise(1, 2) > 0.4) * 8',
      },
    ])
  })

  it('writes the FLAT iterations below format_version 1.21.10, where the nested distribution does not exist', () => {
    // The two shapes are mutually exclusive. Writing `distribution` into an older file has the
    // engine drop it unread and then fail on the missing flat `iterations` -- a file that does not
    // load, for a reason the author cannot see from inside it.
    const graph = samplePack()
    const legacy: IdiomGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'wiki:scatter' ? { ...n, formatVersion: '1.13.0' } : n)),
    }
    const p = plan(gateScatter(legacy, { target: 'wiki:scatter', condition: 'query.noise(1, 2) > 0.4' }))
    expect(setOps(p)[0]!.path).toBe('$.minecraft:scatter_feature.iterations')
  })

  it('refuses to multiply a statement sequence, which is not an expression', () => {
    const graph = samplePack()
    const withScript: IdiomGraph = {
      ...graph,
      edges: graph.edges.map((e) => (e.kind === 'scatter' ? { ...e, iterations: 'variable.h = 4; return 2;' } : e)),
    }
    expect(refusalOf(gateScatter(withScript, { target: 'wiki:scatter', condition: 'q.noise(1,2) > 0' })).code).toBe(
      'molang-not-composable',
    )
  })

  it('wraps a non-scatter in a scatter and retargets every reference to it', () => {
    const p = plan(
      gateScatter(samplePack(), {
        target: 'wiki:b',
        condition: 'query.has_biome_tag(\'forest\')',
        count: 3,
        newId: 'wiki:b_gated',
        file: 'features/b_gated.json',
      }),
    )
    expect(p.creates).toEqual(['wiki:b_gated'])
    expect(p.files).toEqual(['features/b_gated.json', 'features/patch.json'])
    // The one reference to wiki:b, rewritten where the graph said it was.
    expect(setOps(p)).toEqual([
      {
        op: 'set',
        file: 'features/patch.json',
        path: '$.minecraft:aggregate_feature.features[1]',
        json: '"wiki:b_gated"',
        value: 'wiki:b_gated',
      },
    ])
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written['minecraft:scatter_feature'].places_feature).toBe('wiki:b')
    expect(written['minecraft:scatter_feature'].distribution.iterations).toBe("(query.has_biome_tag('forest')) * 3")
  })

  it('writes the wrapper\'s axes as zero, so a gate does not also become an offset', () => {
    // A scatter offsets as well as counts. A wrapper introduced to say "only when" must not move
    // what it wraps, and an absent axis already means a zero-width axis at the origin -- so this
    // asserts the file SAYS so rather than relying on the reader knowing the default.
    const p = plan(
      gateScatter(samplePack(), { target: 'wiki:b', condition: '1', newId: 'wiki:g', file: 'features/g.json' }),
    )
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written['minecraft:scatter_feature'].distribution).toMatchObject({ x: 0, y: 0, z: 0 })
  })

  it('refuses a condition naming a query worldgen does not register', () => {
    // The real game rejects an unknown query while tokenizing, so the file does not load at all.
    // This tool substitutes 0 and carries on, which means a plan that wrote one would produce a
    // pack that previews here and is broken in the game.
    const r = refusalOf(gateScatter(samplePack(), { target: 'wiki:scatter', condition: 'query.is_daytime > 0' }))
    expect(r.code).toBe('molang-invalid')
    expect(r.reason).toContain('query.is_daytime')
  })

  it('refuses to wrap a feature nothing references, because the gate would never run', () => {
    const graph = samplePack()
    const orphaned: IdiomGraph = { ...graph, nodes: [...graph.nodes, node('wiki:lonely', 'minecraft:single_block_feature', 'features/lonely.json')] }
    expect(
      refusalOf(gateScatter(orphaned, { target: 'wiki:lonely', condition: '1', newId: 'wiki:g', file: 'features/g.json' })).code,
    ).toBe('no-referrers')
  })

  it('refuses an identifier the pack already defines, naming the file that has it', () => {
    const r = refusalOf(gateScatter(samplePack(), { target: 'wiki:b', condition: '1', newId: 'wiki:c', file: 'features/g.json' }))
    expect(r.code).toBe('id-exists')
    expect(r.reason).toContain('features/c.json')
  })

  it('refuses a file that already exists rather than overwriting it', () => {
    expect(
      refusalOf(gateScatter(samplePack(), { target: 'wiki:b', condition: '1', newId: 'wiki:g', file: 'features/c.json' })).code,
    ).toBe('file-exists')
  })

  it('refuses a dangling reference and a feature rule, neither of which is a feature to gate', () => {
    const graph = samplePack()
    const withDangling: IdiomGraph = { ...graph, nodes: [...graph.nodes, { id: 'wiki:ghost', unresolved: true }] }
    expect(refusalOf(gateScatter(withDangling, { target: 'wiki:ghost', condition: '1' })).code).toBe('unresolved-node')
    expect(refusalOf(gateScatter(graph, { target: 'wiki:rule', condition: '1' })).code).toBe('node-is-rule')
    expect(refusalOf(gateScatter(graph, { target: 'wiki:nope', condition: '1' })).code).toBe('unknown-node')
  })

  it('builds the gate shape the idiom actually uses', () => {
    expect(gateExpression('q.noise(1, 2) > 0.4', 4)).toBe('(q.noise(1, 2) > 0.4) * 4')
    // A non-literal count is parenthesised, or `(test) * 2 + 1` would add one iteration where the
    // test fails.
    expect(gateExpression('a > 1', '2 + 1')).toBe('(a > 1) * (2 + 1)')
  })
})

// ---------------------------------------------------------------------------
// Action 2 -- scatter as a setup step
// ---------------------------------------------------------------------------

describe('setupScatter -- "set up values the placed feature reads"', () => {
  it('keeps the existing count as the `return` value instead of replacing it with 1', () => {
    // This is the whole trap. Prepending assignments makes the expression a SEQUENCE, and a
    // sequence with no `return` evaluates to 0 -- zero iterations, nothing placed. Preserving the
    // count as the return value fixes both problems at once: the scatter keeps doing what it did,
    // and it keeps doing anything at all.
    const p = plan(
      setupScatter(samplePack(), {
        target: 'wiki:scatter',
        assignments: [{ name: 'trunk_height', value: '4 + math.random_integer(0, 3)' }],
      }),
    )
    expect(setOps(p)[0]!.value).toBe('variable.trunk_height = 4 + math.random_integer(0, 3); return 8;')
    expect(setOps(p)[0]!.path).toBe('$.minecraft:scatter_feature.distribution.iterations')
  })

  it('appends to a sequence that already returns, without a second return', () => {
    const graph = samplePack()
    const scripted: IdiomGraph = {
      ...graph,
      edges: graph.edges.map((e) => (e.kind === 'scatter' ? { ...e, iterations: 'variable.a = 1; return 2;' } : e)),
    }
    const p = plan(setupScatter(scripted, { target: 'wiki:scatter', assignments: [{ name: 'b', value: '3' }] }))
    expect(setOps(p)[0]!.value).toBe('variable.b = 3; variable.a = 1; return 2;')
  })

  it('refuses a scatter whose iterations is a sequence with NO return, because it is already off', () => {
    // Such a scatter evaluates to 0 today and places nothing. Putting assignments in front leaves
    // it placing nothing, and the author would read the successful refactor as the cause.
    const graph = samplePack()
    const broken: IdiomGraph = {
      ...graph,
      edges: graph.edges.map((e) => (e.kind === 'scatter' ? { ...e, iterations: 'variable.a = 1; variable.b = 2;' } : e)),
    }
    const r = refusalOf(setupScatter(broken, { target: 'wiki:scatter', assignments: [{ name: 'c', value: '3' }] }))
    expect(r.code).toBe('iterations-off')
    expect(r.reason).toContain('return')
  })

  it('always emits a return when it creates the scatter itself', () => {
    const p = plan(
      setupScatter(samplePack(), {
        target: 'wiki:b',
        assignments: [{ name: 'h', value: '5' }],
        count: 2,
        newId: 'wiki:b_setup',
        file: 'features/b_setup.json',
      }),
    )
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written['minecraft:scatter_feature'].distribution.iterations).toBe('variable.h = 5; return 2;')
    // And the reference moved, so the setup actually runs above wiki:b rather than beside it.
    expect(setOps(p)[0]!.value).toBe('wiki:b_setup')
  })

  it('warns when an assignment shadows a name the engine publishes', () => {
    const p = plan(setupScatter(samplePack(), { target: 'wiki:scatter', assignments: [{ name: 'originx', value: '0' }] }))
    expect(p.notes.some((n) => n.level === 'warning' && n.message.includes('variable.originx'))).toBe(true)
  })

  it('refuses a name that is not a Molang identifier, and an empty value', () => {
    expect(refusalOf(setupScatter(samplePack(), { target: 'wiki:scatter', assignments: [{ name: 'a-b', value: '1' }] })).code).toBe('molang-invalid')
    expect(refusalOf(setupScatter(samplePack(), { target: 'wiki:scatter', assignments: [{ name: 'a', value: '  ' }] })).code).toBe('molang-invalid')
    expect(refusalOf(setupScatter(samplePack(), { target: 'wiki:scatter', assignments: [] })).code).toBe('molang-invalid')
  })

  it('points out a per-iteration script hiding in the first-evaluated axis', () => {
    // A coordinate is Molang too, and the first axis coordinate_eval_order names is the first
    // thing evaluated inside the loop -- so `"<statements> return <coord>;"` there is a
    // per-iteration script sharing this scope. An author editing `iterations` would not look at
    // an axis, so the plan says it is there.
    const base = samplePack()
    const graph: IdiomGraph = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'wiki:scatter'
          ? { ...n, fields: { distribution: { coordinate_eval_order: 'zxy', z: 'variable.i = variable.i + 1; return 0;' } } }
          : n,
      ),
    }
    const p = plan(setupScatter(graph, { target: 'wiki:scatter', assignments: [{ name: 'i', value: '0' }] }))
    expect(p.notes.some((n) => n.level === 'warning' && n.message.includes('per-iteration script'))).toBe(true)
    // A plain numeric axis is not a script and gets no note.
    const plainGraph: IdiomGraph = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'wiki:scatter' ? { ...n, fields: { distribution: { coordinate_eval_order: 'zxy', z: 0 } } } : n)),
    }
    const plain = plan(setupScatter(plainGraph, { target: 'wiki:scatter', assignments: [{ name: 'i', value: '0' }] }))
    expect(plain.notes.some((n) => n.message.includes('per-iteration script'))).toBe(false)
  })

  it('builds a setup expression that ends in a return', () => {
    expect(setupExpression([{ name: 'a', value: '1' }, { name: 'b', value: 'math.random(0, 1)' }], 4)).toBe(
      'variable.a = 1; variable.b = math.random(0, 1); return 4;',
    )
  })
})

// ---------------------------------------------------------------------------
// Action 3 -- extract a subtree
// ---------------------------------------------------------------------------

describe('extractFeature -- gathering sibling entries under a name', () => {
  const AGG = 'minecraft:aggregate_feature'

  it('collapses an adjacent run into one entry and deletes the rest BY ORIGINAL INDEX', () => {
    // jsonc.Apply resolves every span against the original bytes before splicing, so deleting [1]
    // and [2] in one call is correct and the indices are not walked backwards. A plan that
    // compensated for shifting indices would delete the wrong entries under that writer.
    const p = plan(
      extractFeature(samplePack(), { selection: ['wiki:a', 'wiki:b', 'wiki:c'], newId: 'wiki:trio', file: 'features/trio.json' }),
    )
    expect(p.creates).toEqual(['wiki:trio'])
    expect(p.operations.filter((o) => o.op === 'delete')).toEqual([
      { op: 'delete', file: 'features/patch.json', path: '$.minecraft:aggregate_feature.features[1]' },
      { op: 'delete', file: 'features/patch.json', path: '$.minecraft:aggregate_feature.features[2]' },
    ])
    expect(setOps(p)).toEqual([
      {
        op: 'set',
        file: 'features/patch.json',
        path: '$.minecraft:aggregate_feature.features[0]',
        json: '"wiki:trio"',
        value: 'wiki:trio',
      },
    ])
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written[AGG].features).toEqual(['wiki:a', 'wiki:b', 'wiki:c'])
    expect(written[AGG].description.identifier).toBe('wiki:trio')
    expect(written.format_version).toBe(VERSION)
  })

  it('refuses a single selected feature, which is already a name every reference points at', () => {
    const r = refusalOf(extractFeature(samplePack(), { selection: ['wiki:a'], newId: 'wiki:x', file: 'features/x.json' }))
    expect(r.code).toBe('single-entry')
  })

  it('does not list an interior node -- it is already reached through an entry', () => {
    // Selecting a scatter and the block it places has ONE way in. Selecting them alongside a
    // sibling has two, and only the two entries belong in the new feature.
    const base = samplePack()
    const graph: IdiomGraph = {
      ...base,
      edges: [...base.edges, listEdge('wiki:patch', AGG, 'features', 'wiki:scatter', 4, 'aggregate')],
      nodes: base.nodes,
    }
    const p = plan(
      extractFeature(graph, {
        selection: ['wiki:d', 'wiki:scatter', 'wiki:block'],
        newId: 'wiki:grp',
        file: 'features/grp.json',
      }),
    )
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written[AGG].features).toEqual(['wiki:d', 'wiki:scatter'])
    expect(p.notes.some((n) => n.message.includes('wiki:block'))).toBe(true)
  })

  it('refuses a non-adjacent run of a sequence_feature, because list order IS execution order', () => {
    const SEQ = 'minecraft:sequence_feature'
    const graph: IdiomGraph = {
      nodes: [
        node('wiki:seq', SEQ, 'features/seq.json'),
        node('wiki:a', 'minecraft:single_block_feature', 'features/a.json'),
        node('wiki:b', 'minecraft:single_block_feature', 'features/b.json'),
        node('wiki:c', 'minecraft:single_block_feature', 'features/c.json'),
      ],
      edges: [
        listEdge('wiki:seq', SEQ, 'features', 'wiki:a', 0, 'sequence'),
        listEdge('wiki:seq', SEQ, 'features', 'wiki:b', 1, 'sequence'),
        listEdge('wiki:seq', SEQ, 'features', 'wiki:c', 2, 'sequence'),
      ],
    }
    const r = refusalOf(extractFeature(graph, { selection: ['wiki:a', 'wiki:c'], newId: 'wiki:x', file: 'features/x.json' }))
    expect(r.code).toBe('order-sensitive')

    // Adjacent is fine, and the new feature mirrors the parent's type so the order it preserved
    // is still preserved inside it.
    const ok = plan(extractFeature(graph, { selection: ['wiki:b', 'wiki:c'], newId: 'wiki:x', file: 'features/x.json' }))
    expect(Object.keys(JSON.parse(createdFile(ok).contents) as object)).toContain(SEQ)
  })

  it('refuses a non-adjacent run of an aggregate that declares an early_out scheme', () => {
    const base = samplePack()
    const graph: IdiomGraph = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'wiki:patch' ? { ...n, fields: { early_out: 'first_success' } } : n)),
    }
    expect(refusalOf(extractFeature(graph, { selection: ['wiki:a', 'wiki:c'], newId: 'wiki:x', file: 'features/x.json' })).code).toBe(
      'order-sensitive',
    )
    // Without a scheme the same selection is fine: a plain aggregate places every entry.
    expect(extractFeature(base, { selection: ['wiki:a', 'wiki:c'], newId: 'wiki:x', file: 'features/x.json' }).ok).toBe(true)
  })

  it('sums a weighted pick\'s weights, so every probability survives the refactor', () => {
    // Picking the group with weight (3+1) and then a or b inside it is exactly the distribution
    // that picking a(3), b(1) or c(2) directly was.
    const WR = 'minecraft:weighted_random_feature'
    const graph: IdiomGraph = {
      nodes: [
        node('wiki:pick', WR, 'features/pick.json'),
        node('wiki:x', 'minecraft:single_block_feature', 'features/x.json'),
        node('wiki:y', 'minecraft:single_block_feature', 'features/y.json'),
        node('wiki:z', 'minecraft:single_block_feature', 'features/z.json'),
      ],
      edges: [
        { from: 'wiki:pick', to: 'wiki:x', kind: 'weighted', ordinal: 0, weight: 3, jsonPath: `$.${WR}.features[0][0]` },
        { from: 'wiki:pick', to: 'wiki:y', kind: 'weighted', ordinal: 1, weight: 1, jsonPath: `$.${WR}.features[1][0]` },
        { from: 'wiki:pick', to: 'wiki:z', kind: 'weighted', ordinal: 2, weight: 2, jsonPath: `$.${WR}.features[2][0]` },
      ],
    }
    const p = plan(extractFeature(graph, { selection: ['wiki:x', 'wiki:y'], newId: 'wiki:xy', file: 'features/xy.json' }))
    expect(setOps(p)).toEqual([
      {
        op: 'set',
        file: 'features/pick.json',
        path: `$.${WR}.features[0]`,
        json: '["wiki:xy",4]',
        value: ['wiki:xy', 4],
      },
    ])
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written[WR].features).toEqual([['wiki:x', 3], ['wiki:y', 1]])
  })

  it('refuses to extract weighted entries into a type that would place all of them', () => {
    const WR = 'minecraft:weighted_random_feature'
    const graph: IdiomGraph = {
      nodes: [
        node('wiki:pick', WR, 'features/pick.json'),
        node('wiki:x', 'minecraft:single_block_feature', 'features/x.json'),
        node('wiki:y', 'minecraft:single_block_feature', 'features/y.json'),
      ],
      edges: [
        { from: 'wiki:pick', to: 'wiki:x', kind: 'weighted', ordinal: 0, weight: 1, jsonPath: `$.${WR}.features[0][0]` },
        { from: 'wiki:pick', to: 'wiki:y', kind: 'weighted', ordinal: 1, weight: 1, jsonPath: `$.${WR}.features[1][0]` },
      ],
    }
    expect(
      refusalOf(
        extractFeature(graph, {
          selection: ['wiki:x', 'wiki:y'],
          newId: 'wiki:xy',
          file: 'features/xy.json',
          typeId: 'minecraft:aggregate_feature',
        }),
      ).code,
    ).toBe('order-sensitive')
  })

  it('keeps a conditional entry\'s condition, and refuses when the conditions differ', () => {
    const CL = 'minecraft:conditional_list'
    const makeGraph = (secondCondition: string | null): IdiomGraph => ({
      nodes: [
        node('wiki:list', CL, 'features/list.json'),
        node('wiki:x', 'minecraft:single_block_feature', 'features/x.json'),
        node('wiki:y', 'minecraft:single_block_feature', 'features/y.json'),
      ],
      edges: [
        { from: 'wiki:list', to: 'wiki:x', kind: 'conditional', ordinal: 0, condition: 'variable.worldx > 100', jsonPath: `$.${CL}.conditional_features[0].places_feature` },
        { from: 'wiki:list', to: 'wiki:y', kind: 'conditional', ordinal: 1, ...(secondCondition === null ? {} : { condition: secondCondition }), jsonPath: `$.${CL}.conditional_features[1].places_feature` },
      ],
    })
    const p = plan(
      extractFeature(makeGraph('variable.worldx > 100'), { selection: ['wiki:x', 'wiki:y'], newId: 'wiki:xy', file: 'features/xy.json' }),
    )
    expect(setOps(p)[0]).toMatchObject({
      path: `$.${CL}.conditional_features[0]`,
      value: { places_feature: 'wiki:xy', condition: 'variable.worldx > 100' },
    })
    expect(refusalOf(extractFeature(makeGraph('variable.worldz > 1'), { selection: ['wiki:x', 'wiki:y'], newId: 'wiki:xy', file: 'features/xy.json' })).code).toBe(
      'conditional-entry',
    )
    // An absent condition means "always" and is not the same as any written one.
    expect(refusalOf(extractFeature(makeGraph(null), { selection: ['wiki:x', 'wiki:y'], newId: 'wiki:xy', file: 'features/xy.json' })).code).toBe(
      'conditional-entry',
    )
  })

  it('refuses when the entries belong to more than one parent', () => {
    const base = samplePack()
    const graph: IdiomGraph = {
      ...base,
      nodes: [...base.nodes, node('wiki:other', AGG, 'features/other.json')],
      edges: [
        ...base.edges.filter((e) => !(e.from === 'wiki:patch' && e.to === 'wiki:c')),
        listEdge('wiki:other', AGG, 'features', 'wiki:c', 0, 'aggregate'),
      ],
    }
    const r = refusalOf(extractFeature(graph, { selection: ['wiki:a', 'wiki:c'], newId: 'wiki:x', file: 'features/x.json' }))
    expect(r.code).toBe('mixed-entry-parents')
    expect(r.nodes).toEqual(['wiki:other', 'wiki:patch'])
  })

  it('refuses a selection a cycle runs through, even when the graph reports no cycles', () => {
    // Graph.cycles is authoritative when present, and a caller may not have it. Finding its own
    // back edges is what stops this action from happily extracting out of a recursive pack.
    const graph: IdiomGraph = {
      nodes: [
        node('wiki:top', AGG, 'features/top.json'),
        node('wiki:p', AGG, 'features/p.json'),
        node('wiki:q', AGG, 'features/q.json'),
      ],
      edges: [
        listEdge('wiki:top', AGG, 'features', 'wiki:p', 0, 'aggregate'),
        listEdge('wiki:top', AGG, 'features', 'wiki:q', 1, 'aggregate'),
        listEdge('wiki:p', AGG, 'features', 'wiki:q', 0, 'aggregate'),
        listEdge('wiki:q', AGG, 'features', 'wiki:p', 0, 'aggregate'),
      ],
    }
    const r = refusalOf(extractFeature(graph, { selection: ['wiki:p', 'wiki:q'], newId: 'wiki:x', file: 'features/x.json' }))
    expect(r.code).toBe('cycle')
  })

  it('refuses an entry whose reported path does not index the ordinal it claims', () => {
    // A producer whose paths and ordinals disagree is a contract surprise. Collapsing means
    // deleting by index, so the honest answer is to plan nothing rather than delete a sibling.
    const base = samplePack()
    const graph: IdiomGraph = {
      ...base,
      edges: base.edges.map((e) => (e.to === 'wiki:b' ? { ...e, jsonPath: `$.${AGG}.features[7]` } : e)),
    }
    expect(refusalOf(extractFeature(graph, { selection: ['wiki:a', 'wiki:b'], newId: 'wiki:x', file: 'features/x.json' })).code).toBe(
      'path-shape',
    )
  })

  it('gathers unreferenced roots, and says the result is not reachable yet', () => {
    const graph: IdiomGraph = {
      nodes: [node('wiki:r1', AGG, 'features/r1.json'), node('wiki:r2', AGG, 'features/r2.json')],
      edges: [],
    }
    const p = plan(extractFeature(graph, { selection: ['wiki:r1', 'wiki:r2'], newId: 'wiki:both', file: 'features/both.json' }))
    expect(p.operations).toHaveLength(1)
    expect(p.notes.some((n) => n.level === 'warning' && n.message.includes('not reachable'))).toBe(true)
  })

  it('refuses an empty selection, an unknown id, a taken id and a taken file', () => {
    const g = samplePack()
    expect(refusalOf(extractFeature(g, { selection: [], newId: 'wiki:x', file: 'features/x.json' })).code).toBe('empty-selection')
    expect(refusalOf(extractFeature(g, { selection: ['wiki:a', 'wiki:nope'], newId: 'wiki:x', file: 'features/x.json' })).code).toBe('unknown-node')
    expect(refusalOf(extractFeature(g, { selection: ['wiki:a', 'wiki:b'], newId: 'wiki:d', file: 'features/x.json' })).code).toBe('id-exists')
    expect(refusalOf(extractFeature(g, { selection: ['wiki:a', 'wiki:b'], newId: 'wiki:x', file: 'features/d.json' })).code).toBe('file-exists')
    expect(refusalOf(extractFeature(g, { selection: ['wiki:a', 'wiki:b'], newId: 'bare_name', file: 'features/x.json' })).code).toBe('id-malformed')
  })

  it('refuses a feature rule in the selection, because nothing can delegate to a rule', () => {
    expect(
      refusalOf(extractFeature(samplePack(), { selection: ['wiki:rule', 'wiki:a'], newId: 'wiki:x', file: 'features/x.json' })).code,
    ).toBe('node-is-rule')
  })
})

// ---------------------------------------------------------------------------
// Action 4 -- wrap an existing node
// ---------------------------------------------------------------------------

describe('wrapNode -- slipping a wrapper in above an existing feature', () => {
  it('uses each filter\'s OWN child key, not a family resemblance', () => {
    // surface_relative_threshold registers exactly `feature_to_place`; `feature`,
    // `wrapped_feature` and `places_feature` all look like they should work and are all refused
    // by the engine, so a file using one does not load.
    const byType = new Map(WRAPPERS.map((w) => [w.typeId, w.childKey]))
    expect(byType.get('minecraft:snap_to_surface_feature')).toBe('feature_to_snap')
    expect(byType.get('minecraft:surface_relative_threshold_feature')).toBe('feature_to_place')
    expect(byType.get('minecraft:height_difference_filter_feature')).toBe('places_feature')
  })

  it('creates the wrapper and retargets every reference in one plan', () => {
    const base = samplePack()
    // wiki:b referenced twice, from two different features, which is the case that makes this
    // action worth having at all.
    const graph: IdiomGraph = {
      ...base,
      nodes: [...base.nodes, node('wiki:other', 'minecraft:aggregate_feature', 'features/other.json')],
      edges: [...base.edges, listEdge('wiki:other', 'minecraft:aggregate_feature', 'features', 'wiki:b', 0, 'aggregate')],
    }
    const p = plan(
      wrapNode(graph, {
        target: 'wiki:b',
        wrapper: 'minecraft:surface_relative_threshold_feature',
        newId: 'wiki:b_deep',
        file: 'features/b_deep.json',
      }),
    )
    expect(p.files).toEqual(['features/b_deep.json', 'features/other.json', 'features/patch.json'])
    expect(setOps(p).map((o) => o.path)).toEqual([
      '$.minecraft:aggregate_feature.features[1]',
      '$.minecraft:aggregate_feature.features[0]',
    ])
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written['minecraft:surface_relative_threshold_feature'].feature_to_place).toBe('wiki:b')
  })

  it('seeds a wrapper\'s required keys with placeholders and SAYS it did', () => {
    // forms.ts seeds required keys with values that are deliberately not plausible, so a
    // half-written node cannot read as finished. The plan has to carry that forward or the author
    // applies it and gets a file the game refuses.
    const p = plan(
      wrapNode(samplePack(), {
        target: 'wiki:b',
        wrapper: 'minecraft:snap_to_surface_feature',
        newId: 'wiki:b_snap',
        file: 'features/b_snap.json',
      }),
    )
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    // At 1.21.110 the key is still spelled vertical_search_range; it is renamed at 1.26.50.
    expect(written['minecraft:snap_to_surface_feature']).toHaveProperty('vertical_search_range')
    expect(p.notes.some((n) => n.level === 'warning' && n.message.includes('vertical_search_range'))).toBe(true)
  })

  it('writes a weighted wrapper as a [reference, weight] tuple list', () => {
    const p = plan(
      wrapNode(samplePack(), {
        target: 'wiki:b',
        wrapper: 'minecraft:weighted_random_feature',
        newId: 'wiki:b_pick',
        file: 'features/b_pick.json',
        weight: 5,
      }),
    )
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written['minecraft:weighted_random_feature'].features).toEqual([['wiki:b', 5]])
  })

  it('writes a conditional wrapper with no condition key when none is given', () => {
    // An absent condition and a written "1.0" are different things to the contract, and a wrapper
    // that invented one would erase the distinction on the author's behalf.
    const p = plan(
      wrapNode(samplePack(), { target: 'wiki:b', wrapper: 'minecraft:conditional_list', newId: 'wiki:b_if', file: 'features/b_if.json' }),
    )
    const written = JSON.parse(createdFile(p).contents) as Record<string, any>
    expect(written['minecraft:conditional_list'].conditional_features).toEqual([{ places_feature: 'wiki:b' }])
  })

  it('refuses a wrapper the inherited format_version cannot name', () => {
    // A file below the schema floor matches no band at all: the engine does not recognise the
    // type key, and the file does not load.
    const base = samplePack()
    const graph: IdiomGraph = { ...base, nodes: base.nodes.map((n) => (n.id === 'wiki:b' ? { ...n, formatVersion: '1.12.0' } : n)) }
    const r = refusalOf(
      wrapNode(graph, { target: 'wiki:b', wrapper: 'minecraft:scan_surface', newId: 'wiki:b_scan', file: 'features/b_scan.json' }),
    )
    expect(r.code).toBe('wrapper-unavailable')
    expect(r.reason).toContain('1.12.0')
  })

  it('refuses a new file with no format_version to inherit, rather than picking one', () => {
    const base = samplePack()
    const graph: IdiomGraph = { ...base, nodes: base.nodes.map((n) => (n.id === 'wiki:b' ? { ...n, formatVersion: undefined } : n)) }
    expect(
      refusalOf(wrapNode(graph, { target: 'wiki:b', wrapper: 'minecraft:scan_surface', newId: 'wiki:w', file: 'features/w.json' })).code,
    ).toBe('no-format-version')
  })

  it('refuses an unknown wrapper, a rule, and a feature on a cycle', () => {
    const base = samplePack()
    expect(refusalOf(wrapNode(base, { target: 'wiki:b', wrapper: 'minecraft:ore_feature', newId: 'wiki:w', file: 'features/w.json' })).code).toBe(
      'unknown-wrapper',
    )
    expect(
      refusalOf(wrapNode(base, { target: 'wiki:rule', wrapper: 'minecraft:scan_surface', newId: 'wiki:w', file: 'features/w.json' })).code,
    ).toBe('node-is-rule')
    const selfReferential: IdiomGraph = {
      ...base,
      edges: [...base.edges, listEdge('wiki:patch', 'minecraft:aggregate_feature', 'features', 'wiki:patch', 4, 'aggregate')],
    }
    expect(
      refusalOf(wrapNode(selfReferential, { target: 'wiki:patch', wrapper: 'minecraft:scan_surface', newId: 'wiki:w', file: 'features/w.json' })).code,
    ).toBe('cycle')
  })

  it('refuses an unreferenced feature unless explicitly told to make one anyway', () => {
    const base = samplePack()
    const graph: IdiomGraph = { ...base, nodes: [...base.nodes, node('wiki:lonely', 'minecraft:single_block_feature', 'features/lonely.json')] }
    const req = { target: 'wiki:lonely', wrapper: 'minecraft:scan_surface', newId: 'wiki:w', file: 'features/w.json' } as const
    expect(refusalOf(wrapNode(graph, req)).code).toBe('no-referrers')
    const p = plan(wrapNode(graph, { ...req, allowUnreferenced: true }))
    expect(p.operations).toHaveLength(1)
    expect(p.notes.some((n) => n.level === 'warning')).toBe(true)
  })

  it('rewrites a whole weighted tuple when that is all the path names, keeping the weight', () => {
    // A producer may report the [ref, weight] tuple rather than the slot inside it. Writing a bare
    // string there would delete the weight, which the engine then defaults to 1.0 with nothing
    // saying so.
    const WR = 'minecraft:weighted_random_feature'
    const graph: IdiomGraph = {
      nodes: [node('wiki:pick', WR, 'features/pick.json'), node('wiki:x', 'minecraft:single_block_feature', 'features/x.json')],
      edges: [{ from: 'wiki:pick', to: 'wiki:x', kind: 'weighted', ordinal: 0, weight: 7, jsonPath: `$.${WR}.features[0]` }],
    }
    const p = plan(wrapNode(graph, { target: 'wiki:x', wrapper: 'minecraft:scan_surface', newId: 'wiki:w', file: 'features/w.json' }))
    expect(setOps(p)[0]).toMatchObject({ path: `$.${WR}.features[0]`, value: ['wiki:w', 7] })
  })

  it('plans NOTHING when a reference cannot be rewritten, rather than half of it', () => {
    const base = samplePack()
    const graph: IdiomGraph = {
      ...base,
      edges: base.edges.map((e) => (e.to === 'wiki:b' ? { ...e, jsonPath: '$.minecraft:aggregate_feature.features[7]' } : e)),
    }
    const result = wrapNode(graph, { target: 'wiki:b', wrapper: 'minecraft:scan_surface', newId: 'wiki:w', file: 'features/w.json' })
    expect(refusalOf(result).code).toBe('path-shape')
  })
})

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

describe('availableIdioms -- what this selection can do', () => {
  it('offers all four for a single feature with siblings, with a reason on each refusal', () => {
    const offers = availableIdioms(samplePack(), ['wiki:a'])
    const byAction = new Map(offers.map((o) => [o.action, o]))
    expect(byAction.get('gate-scatter')!.available).toBe(true)
    expect(byAction.get('setup-scatter')!.available).toBe(true)
    expect(byAction.get('wrap-node')!.available).toBe(true)
    // One node cannot be extracted, and the offer says why rather than vanishing.
    expect(byAction.get('extract-feature')!.available).toBe(false)
    expect(byAction.get('extract-feature')!.unavailable).toBeTruthy()
  })

  it('offers extraction for a multi-selection, and nothing single-node for it', () => {
    const offers = availableIdioms(samplePack(), ['wiki:a', 'wiki:b'])
    const byAction = new Map(offers.map((o) => [o.action, o]))
    expect(byAction.get('extract-feature')!.available).toBe(true)
    expect(byAction.get('wrap-node')!.available).toBe(false)
  })

  it('says a rule cannot be wrapped, and every offer carries a reason when unavailable', () => {
    for (const offer of availableIdioms(samplePack(), ['wiki:rule'])) {
      expect(offer.available).toBe(false)
      expect(offer.unavailable).toBeTruthy()
    }
  })
})
