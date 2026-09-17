// compoundCollapse.test.ts -- the collapse/expand host.
//
// The five compound modules do not exist here, and are not imported: the host
// takes a registry of `CompoundSpec`s as a parameter precisely so it can be
// tested against fakes, and a test that leaned on a real one would be testing
// that module instead. Every spec below is written in this file, including two
// that misbehave, because "never throws on malformed input" is not a claim a
// test can make against well-behaved collaborators only.

import { describe, expect, it } from 'vitest'
import {
  buildCompoundView,
  classifyEdit,
  ejectWarning,
  planCanvasMove,
  planEject,
  planParameterEdit,
  readCompoundAnnotation,
  type CollapseGraph,
  type CollapseNode,
  type CompoundRegistry,
} from '../src/graph/compounds/collapse'
import { COMPOUND_DIRECTIVE, encodeCompoundParams, type CompoundResult, type CompoundSpec } from '../src/graph/compounds/spec'
import type { PlanOperation, Refusal } from '../src/graph/idioms'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FORMAT_VERSION = '1.21.0'

interface FakeParams {
  readonly count: string
  readonly places: string
  readonly extra?: number
}

function isFakeParams(value: unknown): value is FakeParams {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['count'] === 'string' && typeof record['places'] === 'string'
}

function rootContents(identifier: string, params: FakeParams, formatVersion: string): string {
  return `${JSON.stringify(
    {
      format_version: formatVersion,
      'minecraft:scatter_feature': {
        description: { identifier },
        iterations: params.count,
        scatter_chance: params.extra ?? 50,
        places_feature: params.places,
      },
    },
    null,
    2,
  )}\n`
}

function childContents(identifier: string, formatVersion: string): string {
  return `${JSON.stringify(
    {
      format_version: formatVersion,
      'minecraft:aggregate_feature': { description: { identifier }, early_out: 'first_failure' },
    },
    null,
    2,
  )}\n`
}

/**
 * A compound that creates its own file plus `n` children, where `n` is the
 * count parameter read as a number. Enough shape to exercise identity,
 * re-expansion and drift without pretending to be `loop`.
 */
function fakeSpec(kind: CompoundSpec<FakeParams>['kind'] = 'loop'): CompoundSpec<FakeParams> {
  return {
    kind,
    title: 'Repeat',
    summary: 'Places a feature a number of times.',
    validate(params: unknown) {
      if (!isFakeParams(params)) {
        const refusal: Refusal = { code: 'path-shape', reason: 'A fake compound needs a count and a places.' }
        return { ok: false, refusal }
      }
      return { ok: true, params }
    },
    expand(identifier: string, params: FakeParams, formatVersion: string): CompoundResult {
      const childCount = Number(params.count)
      const operations: PlanOperation[] = [
        {
          op: 'createFile',
          file: `features/${bare(identifier)}.json`,
          contents: rootContents(identifier, params, formatVersion),
          identifier,
          typeId: 'minecraft:scatter_feature',
        },
      ]
      const creates: string[] = [identifier]
      for (let i = 0; i < childCount; i += 1) {
        const childId = `${identifier}__item_${i}`
        creates.push(childId)
        operations.push({
          op: 'createFile',
          file: `features/${bare(childId)}.json`,
          contents: childContents(childId, formatVersion),
          identifier: childId,
          typeId: 'minecraft:aggregate_feature',
        })
      }
      return {
        ok: true,
        expansion: {
          kind,
          identifier,
          operations,
          notes: [{ level: 'info', message: `${identifier} places ${params.places}.` }],
          creates,
        },
      }
    },
  }
}

/** Always refuses to expand, but validates. */
const refusingSpec: CompoundSpec<FakeParams> = {
  ...fakeSpec(),
  expand(identifier: string): CompoundResult {
    return { ok: false, refusal: { code: 'iterations-off', reason: `${identifier} cannot be built.`, nodes: [identifier] } }
  },
}

/** Throws from both halves. A registry entry is not a promise of good manners. */
const throwingSpec: CompoundSpec<FakeParams> = {
  kind: 'loop',
  title: 'Boom',
  summary: 'Throws.',
  validate(): never {
    throw new Error('validate exploded')
  },
  expand(): never {
    throw new Error('expand exploded')
  },
}

function bare(identifier: string): string {
  return identifier.includes(':') ? identifier.slice(identifier.indexOf(':') + 1) : identifier
}

const registry: CompoundRegistry = { loop: fakeSpec() }

// ---------------------------------------------------------------------------
// Graph fixtures
// ---------------------------------------------------------------------------

interface AnnotationInput {
  readonly kind?: string
  readonly text?: string
  readonly jsonPath?: string
  readonly name?: string
}

function idiom(input: AnnotationInput = {}) {
  return {
    name: input.name ?? COMPOUND_DIRECTIVE,
    args: input.kind === undefined ? ['loop'] : [input.kind],
    text: input.text ?? encodeCompoundParams({ count: '2', places: 'ns:leaf' }),
    jsonPath: input.jsonPath ?? '$',
    line: 2,
    offset: 40,
    endOffset: 40 + `@featurelab:${COMPOUND_DIRECTIVE} loop`.length,
  }
}

/** The root node as the builder would report it once the compound is written. */
function compoundRoot(overrides: Partial<CollapseNode> = {}): CollapseNode {
  return {
    id: 'ns:tower',
    typeId: 'minecraft:scatter_feature',
    file: 'features/tower.json',
    formatVersion: FORMAT_VERSION,
    fields: { description: { identifier: 'ns:tower' }, iterations: '2', scatter_chance: 50 },
    annotations: [idiom()],
    ...overrides,
  }
}

function child(n: number, overrides: Partial<CollapseNode> = {}): CollapseNode {
  const id = `ns:tower__item_${n}`
  return {
    id,
    typeId: 'minecraft:aggregate_feature',
    file: `features/tower__item_${n}.json`,
    formatVersion: FORMAT_VERSION,
    fields: { description: { identifier: id }, early_out: 'first_failure' },
    ...overrides,
  }
}

const leaf: CollapseNode = {
  id: 'ns:leaf',
  typeId: 'minecraft:single_block_feature',
  file: 'features/leaf.json',
  formatVersion: FORMAT_VERSION,
  fields: { description: { identifier: 'ns:leaf' }, places_block: 'minecraft:oak_leaves' },
}

/**
 * The scatter's `places_feature` as the builder reports it: lifted out of
 * Fields and into an edge. Every graph below carries it, because a compound
 * root without it is a root whose body genuinely IS missing the key.
 */
function scatterEdge(from: string) {
  return { from, to: 'ns:leaf', kind: 'scatter' as const, jsonPath: '$.places_feature', iterations: '2', required: true }
}

function standardGraph(overrides: { readonly root?: Partial<CollapseNode> } = {}): CollapseGraph {
  return { nodes: [compoundRoot(overrides.root), child(0), child(1), leaf], edges: [scatterEdge('ns:tower')] }
}

// ---------------------------------------------------------------------------

describe('readCompoundAnnotation', () => {
  it('reads the kind and the parameter body', () => {
    const read = readCompoundAnnotation(compoundRoot())
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.kind).toBe('loop')
    expect(read.params).toEqual({ count: '2', places: 'ns:leaf' })
  })

  it('passes over an `idiom` directive that is not a compound', () => {
    // wire/graph.go's own example is `@featurelab:idiom setup-script`. It
    // belongs to something else and is not this module's to call malformed.
    const node = compoundRoot({ annotations: [idiom({ kind: 'setup-script' })] })
    expect(readCompoundAnnotation(node).status).toBe('none')
  })

  it('degrades a body that is not a JSON object', () => {
    for (const text of ['', 'not json', '"a string"', 'null', '3']) {
      const read = readCompoundAnnotation(compoundRoot({ annotations: [idiom({ text })] }))
      expect(read).toEqual({ status: 'degraded', reason: 'malformed-params' })
    }
  })

  it('accepts an array body, because spec.ts\'s own decoder does', () => {
    // decodeCompoundParams says it returns null on "anything that is not a JSON
    // object" and then tests `typeof value === 'object'`, which an array
    // passes. Decoding is spec.ts's to own, so this records the behaviour
    // rather than second-guessing it here: the spec's `validate` is what
    // rejects a params value of the wrong shape, and it does (see below).
    const read = readCompoundAnnotation(compoundRoot({ annotations: [idiom({ text: '[1,2]' })] }))
    expect(read.status).toBe('ok')
    const view = buildCompoundView({ graph: standardGraph({ root: { annotations: [idiom({ text: '[1,2]' })] } }), registry })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')
    expect(root.drift.map((finding) => finding.what)).toEqual(['invalid-params'])
  })

  it('believes neither of two compound directives on one file', () => {
    const node = compoundRoot({ annotations: [idiom(), idiom({ kind: 'steps' })] })
    expect(readCompoundAnnotation(node)).toEqual({ status: 'degraded', reason: 'ambiguous-annotation' })
  })

  it('accepts a directive on the file root OR on the type key, and nothing deeper', () => {
    // The rule changed after it was measured rather than reasoned about. The contract first
    // said the directive sits at the top of the file, so this test required `$` -- but a
    // directive attaches to the member that FOLLOWS it, and at the top of a feature file that
    // member is `format_version`. It was reported at `$.format_version`, this check refused it
    // as not-at-root, and every compound written that way silently failed to collapse with
    // nothing anywhere reporting a problem.
    //
    // It now sits directly above the type key and is reported at `$.minecraft:<type>`, which is
    // also the root every edge JSONPath in that file starts from -- and a shared root is the
    // only reason an annotation and an edge can be compared at all.
    expect(readCompoundAnnotation(compoundRoot({ annotations: [idiom({ jsonPath: '$' })] })).status).toBe('ok')
    expect(
      readCompoundAnnotation(compoundRoot({ annotations: [idiom({ jsonPath: '$.minecraft:scatter_feature' })] })).status,
    ).toBe('ok')

    // Deeper is still refused, and that distinction is the point of the check: an annotation
    // about something INSIDE a feature is not an annotation about the feature.
    for (const path of ['$.minecraft:scatter_feature.places_feature', '$.features[0]']) {
      expect(readCompoundAnnotation(compoundRoot({ annotations: [idiom({ jsonPath: path })] }))).toEqual({
        status: 'degraded',
        reason: 'annotation-not-at-root',
      })
    }
  })

  it('matches the directive name the way graphcheck does, case-insensitively', () => {
    const node = compoundRoot({ annotations: [idiom({ name: 'IDIOM' })] })
    expect(readCompoundAnnotation(node).status).toBe('ok')
  })

  it('finds nothing on a node with no annotations at all', () => {
    expect(readCompoundAnnotation(leaf)).toEqual({ status: 'none' })
  })

  it('degrades a directive carrying more than its one argument', () => {
    // "The directive carries the kind in its single whitespace-split
    // argument". A second word means something went in that this module has no
    // reading of, and guessing which word is the kind is how an editor starts
    // collapsing nodes nobody grouped.
    const node = compoundRoot({ annotations: [{ ...idiom(), args: ['loop', 'extra'] }] })
    expect(readCompoundAnnotation(node)).toEqual({ status: 'degraded', reason: 'malformed-directive' })
  })
})

describe('buildCompoundView -- the three presentations', () => {
  it('collapses a compound to one node and hides what it generated', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry })

    const root = view.byId.get('ns:tower')
    expect(root?.presentation).toBe('compound')
    expect(view.hiddenNodeIds).toEqual(['ns:tower__item_0', 'ns:tower__item_1'])
    expect(view.drift).toEqual([])
  })

  it('renders the form from the recorded parameters, never from the generated JSON', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'compound') throw new Error('expected a compound')

    expect(root.formParams).toEqual({ count: '2', places: 'ns:leaf' })
    // The generated body is present, and is emphatically not the form.
    expect(root.fields).toEqual({ description: { identifier: 'ns:tower' }, iterations: '2', scatter_chance: 50 })
    expect(root.formParams).not.toEqual(root.fields)
    expect(root.title).toBe('Repeat')
  })

  it('shows a node with no annotation raw, and does not guess at it', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry })
    const plain = view.byId.get('ns:leaf')
    expect(plain).toEqual({
      identifier: 'ns:leaf',
      fields: leaf.fields,
      presentation: 'plain',
    })
  })

  it('reveals the children when the compound is expanded', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry, expanded: ['ns:tower'] })
    expect(view.hiddenNodeIds).toEqual([])
    const first = view.byId.get('ns:tower__item_0')
    if (first?.presentation !== 'child') throw new Error('expected a child')
    expect(first.hidden).toBe(false)
    expect(first.parent).toBe('ns:tower')
  })
})

describe('buildCompoundView -- identity', () => {
  it('takes the children from what re-expansion creates, not from their names', () => {
    // `ns:decoy__item_0` is named exactly the way the generator names a child
    // and is NOT produced by this compound's parameters. CHILD_ROLES is a hint
    // and spec.ts says it is not identity; a host that matched on the name
    // would swallow a node the author wrote by hand.
    const decoy: CollapseNode = { id: 'ns:decoy__item_0', typeId: 'minecraft:aggregate_feature', file: 'features/decoy.json' }
    const graph: CollapseGraph = { nodes: [compoundRoot(), child(0), child(1), decoy, leaf], edges: [scatterEdge('ns:tower')] }

    const view = buildCompoundView({ graph, registry })
    expect(view.byId.get('ns:decoy__item_0')?.presentation).toBe('plain')
    expect(view.hiddenNodeIds).toEqual(['ns:tower__item_0', 'ns:tower__item_1'])
  })

  it('does not swallow the feature the compound merely places', () => {
    // `ns:leaf` is the author's own feature. It is delegated to and never
    // created, so it is never in `creates` and never hidden.
    const view = buildCompoundView({ graph: standardGraph(), registry })
    expect(view.hiddenNodeIds).not.toContain('ns:leaf')
    expect(view.byId.get('ns:leaf')?.presentation).toBe('plain')
  })

  it('owns a child whose name looks nothing like a role', () => {
    const renamer: CompoundSpec<FakeParams> = {
      ...fakeSpec(),
      expand(identifier, params, formatVersion) {
        const result = fakeSpec().expand(identifier, params, formatVersion)
        if (!result.ok) return result
        return {
          ok: true,
          expansion: { ...result.expansion, creates: [identifier, 'ns:hand_named'] },
        }
      },
    }
    const odd: CollapseNode = { id: 'ns:hand_named', typeId: 'minecraft:aggregate_feature', file: 'features/odd.json' }
    const graph: CollapseGraph = { nodes: [compoundRoot(), odd], edges: [scatterEdge('ns:tower')] }

    const view = buildCompoundView({ graph, registry: { loop: renamer } })
    expect(view.byId.get('ns:hand_named')?.presentation).toBe('child')
    expect(view.hiddenNodeIds).toEqual(['ns:hand_named'])
  })

  it('gives a contested id to the compound that claims it first, in graph order', () => {
    const second = compoundRoot({
      id: 'ns:tower2',
      file: 'features/tower2.json',
      fields: { description: { identifier: 'ns:tower2' }, iterations: '2', scatter_chance: 50 },
    })
    const sameChildren: CompoundSpec<FakeParams> = {
      ...fakeSpec(),
      expand(identifier, params, formatVersion) {
        const result = fakeSpec().expand(identifier, params, formatVersion)
        if (!result.ok) return result
        return { ok: true, expansion: { ...result.expansion, creates: [identifier, 'ns:shared'] } }
      },
    }
    const shared: CollapseNode = { id: 'ns:shared', file: 'features/shared.json' }
    const graph: CollapseGraph = { nodes: [compoundRoot(), second, shared], edges: [scatterEdge('ns:tower'), scatterEdge('ns:tower2')] }

    const view = buildCompoundView({ graph, registry: { loop: sameChildren } })
    const owner = view.byId.get('ns:shared')
    if (owner?.presentation !== 'child') throw new Error('expected a child')
    expect(owner.parent).toBe('ns:tower')
    expect(view.drift.map((finding) => [finding.what, finding.compound, finding.identifier])).toEqual([
      ['contested-child', 'ns:tower2', 'ns:shared'],
    ])
  })

  it('flags a hidden child that something outside the compound delegates to', () => {
    const graph: CollapseGraph = {
      nodes: [compoundRoot(), child(0), child(1), leaf],
      edges: [
        { from: 'ns:tower', to: 'ns:leaf', kind: 'scatter', jsonPath: '$.places_feature', required: true },
        { from: 'ns:leaf', to: 'ns:tower__item_0', kind: 'child', jsonPath: '$.vegetation_feature', required: false },
      ],
    }
    const view = buildCompoundView({ graph, registry })
    const borrowed = view.byId.get('ns:tower__item_0')
    if (borrowed?.presentation !== 'child') throw new Error('expected a child')
    expect(borrowed.borrowed).toBe(true)
    const other = view.byId.get('ns:tower__item_1')
    if (other?.presentation !== 'child') throw new Error('expected a child')
    expect(other.borrowed).toBe(false)
  })
})

describe('buildCompoundView -- degrading', () => {
  it('shows the raw subgraph when the annotation body is malformed, and says why', () => {
    const graph = standardGraph({ root: { annotations: [idiom({ text: '{not json' })] } })
    const view = buildCompoundView({ graph, registry })

    const root = view.byId.get('ns:tower')
    expect(root).toEqual({
      identifier: 'ns:tower',
      fields: compoundRoot().fields,
      presentation: 'plain',
      degraded: 'malformed-params',
    })
    // Exactly as a missing annotation does: nothing is hidden.
    expect(view.hiddenNodeIds).toEqual([])
    expect(view.byId.get('ns:tower__item_0')?.presentation).toBe('plain')
  })

  it('keeps an unknown kind visible as a drifted compound rather than dropping it', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry: {} })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')

    expect(root.drift.map((finding) => finding.what)).toEqual(['unknown-kind'])
    expect(root.collapsible).toBe(false)
    expect(root.childIds).toEqual([])
    // Children unknown means nothing is safe to hide.
    expect(view.hiddenNodeIds).toEqual([])
  })

  it('shows a retired `switch` annotation as the raw subgraph, like any kind this editor does not know', () => {
    // `switch` was a compound once and packs still carry its directive. It is no longer a kind, so
    // the directive is passed over rather than read, and the machinery it wrote is shown as written.
    const text = encodeCompoundParams({ cases: [{ condition: 'q.above_top_solid > 70', places: 'ns:leaf' }] })
    const node = compoundRoot({ annotations: [idiom({ kind: 'switch', text })] })
    expect(readCompoundAnnotation(node)).toEqual({ status: 'none' })

    const view = buildCompoundView({ graph: standardGraph({ root: { annotations: node.annotations } }), registry })
    expect(view.byId.get('ns:tower')?.presentation).toBe('plain')
    expect(view.compounds).toEqual([])
    expect(view.hiddenNodeIds).toEqual([])
    expect(view.byId.get('ns:tower__item_0')?.presentation).toBe('plain')
  })

  it('never throws when a spec does', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry: { loop: throwingSpec } })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')
    expect(root.drift.map((finding) => finding.what)).toEqual(['invalid-params'])
    expect(root.formParams).toBeNull()
  })

  it('carries the spec\'s own refusal through when it will not re-expand', () => {
    const view = buildCompoundView({ graph: standardGraph(), registry: { loop: refusingSpec } })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')
    expect(root.drift[0]?.what).toBe('expansion-refused')
    expect(root.drift[0]?.refusal?.code).toBe('iterations-off')
    expect(root.collapsible).toBe(false)
  })

  it('survives an empty graph', () => {
    expect(buildCompoundView({ graph: {}, registry }).nodes).toEqual([])
    expect(buildCompoundView({ graph: { nodes: [], edges: [] }, registry }).compounds).toEqual([])
  })
})

describe('buildCompoundView -- drift', () => {
  it('reports a value a text editor changed', () => {
    const graph = standardGraph({ root: { fields: { description: { identifier: 'ns:tower' }, iterations: '2', scatter_chance: 25 } } })
    const view = buildCompoundView({ graph, registry })

    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')
    expect(root.drift).toHaveLength(1)
    expect(root.drift[0]?.what).toBe('field-changed')
    expect(root.drift[0]?.key).toBe('scatter_chance')
    // Neither dropped nor trusted: the parameters are still the form, and the
    // subgraph is still on screen.
    expect(root.formParams).toEqual({ count: '2', places: 'ns:leaf' })
    expect(root.collapsible).toBe(true)
  })

  it('reports a key someone added and a key someone removed', () => {
    const graph = standardGraph({ root: { fields: { description: { identifier: 'ns:tower' }, scatter_chance: 50, y_offset: 3 } } })
    const view = buildCompoundView({ graph, registry })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')

    expect(root.drift.map((finding) => [finding.what, finding.key])).toEqual([
      ['field-missing', 'iterations'],
      ['field-added', 'y_offset'],
    ])
  })

  it('does NOT report a delegation key the builder lifted into an edge', () => {
    // `places_feature` is in every generated body and in no node's Fields.
    // Reporting it would fire on every compound on every open, which is the
    // failure mode spec.ts spends a paragraph on.
    const view = buildCompoundView({ graph: standardGraph(), registry })
    expect(view.drift).toEqual([])
  })

  it('stays quiet when the generated file cannot be read rather than guessing', () => {
    const unreadable: CompoundSpec<FakeParams> = {
      ...fakeSpec(),
      expand(identifier, params, formatVersion) {
        const result = fakeSpec().expand(identifier, params, formatVersion)
        if (!result.ok) return result
        const operations = result.expansion.operations.map((operation) =>
          operation.op === 'createFile' ? { ...operation, contents: '{ this is not json' } : operation,
        )
        return { ok: true, expansion: { ...result.expansion, operations } }
      },
    }
    const view = buildCompoundView({ graph: standardGraph(), registry: { loop: unreadable } })
    expect(view.drift).toEqual([])
    expect(view.byId.get('ns:tower')?.presentation).toBe('compound')
  })

  it('reads a generated file that carries the compound\'s own comment', () => {
    const commented: CompoundSpec<FakeParams> = {
      ...fakeSpec(),
      expand(identifier, params, formatVersion) {
        const result = fakeSpec().expand(identifier, params, formatVersion)
        if (!result.ok) return result
        const operations = result.expansion.operations.map((operation) =>
          operation.op === 'createFile' && operation.identifier === identifier
            ? {
                ...operation,
                contents: operation.contents.replace(
                  '{\n',
                  `{\n  // @featurelab:${COMPOUND_DIRECTIVE} loop\n  // {"count":"2","places":"ns:leaf"}\n`,
                ),
              }
            : operation,
        )
        return { ok: true, expansion: { ...result.expansion, operations } }
      },
    }
    const view = buildCompoundView({ graph: standardGraph(), registry: { loop: commented } })
    expect(view.drift).toEqual([])
    expect(view.byId.get('ns:tower')?.presentation).toBe('compound')
  })

  it('reports a child the parameters produce and the pack does not have', () => {
    const graph: CollapseGraph = { nodes: [compoundRoot(), child(0), leaf], edges: [scatterEdge('ns:tower')] }
    const view = buildCompoundView({ graph, registry })
    const root = view.byId.get('ns:tower')
    if (root?.presentation !== 'drifted') throw new Error('expected drifted')

    expect(root.drift.map((finding) => [finding.what, finding.identifier])).toEqual([['missing-child', 'ns:tower__item_1']])
    expect(root.children.map((ref) => [ref.identifier, ref.present])).toEqual([
      ['ns:tower__item_0', true],
      ['ns:tower__item_1', false],
    ])
  })

  it('reports a child that is only a dangling reference', () => {
    const graph: CollapseGraph = {
      nodes: [compoundRoot(), child(0), { id: 'ns:tower__item_1', unresolved: true }, leaf],
      edges: [scatterEdge('ns:tower')],
    }
    const view = buildCompoundView({ graph, registry })
    expect(view.drift.map((finding) => finding.what)).toEqual(['unresolved-child'])
  })
})

describe('buildCompoundView -- purity', () => {
  it('gives the same answer, in the same order, every time', () => {
    const first = buildCompoundView({ graph: standardGraph(), registry })
    const second = buildCompoundView({ graph: standardGraph(), registry })
    expect(second).toEqual(first)
    expect(second.nodes.map((node) => node.identifier)).toEqual(['ns:tower', 'ns:tower__item_0', 'ns:tower__item_1', 'ns:leaf'])
  })

  it('orders findings by key so a re-open does not reshuffle the warnings', () => {
    const fields = { z_last: 1, description: { identifier: 'ns:tower' }, a_first: 1, scatter_chance: 50, iterations: '2' }
    const view = buildCompoundView({ graph: standardGraph({ root: { fields } }), registry })
    expect(view.drift.map((finding) => finding.key)).toEqual(['a_first', 'z_last'])
  })
})

describe('the eject rule', () => {
  const view = buildCompoundView({ graph: standardGraph(), registry })

  it('treats a canvas move as no edit at all', () => {
    expect(classifyEdit(view, { what: 'canvas-position', identifier: 'ns:tower' })).toEqual({
      effect: 'none',
      identifier: 'ns:tower',
      why: 'layout-is-not-an-edit',
    })
    expect(planCanvasMove('ns:tower')).toEqual({
      ok: true,
      identifier: 'ns:tower',
      operations: [],
      ejects: false,
      applyable: true,
    })
  })

  it('regenerates when the collapsed node\'s own fields are edited', () => {
    expect(classifyEdit(view, { what: 'compound-fields', identifier: 'ns:tower' })).toEqual({
      effect: 'regenerate',
      identifier: 'ns:tower',
      kind: 'loop',
      overwritesDrift: false,
      drift: [],
    })
  })

  it('ejects when the compound\'s own JSON is edited', () => {
    const consequence = classifyEdit(view, { what: 'node-body', identifier: 'ns:tower' })
    expect(consequence.effect).toBe('eject')
    if (consequence.effect !== 'eject') return
    expect(consequence.identifier).toBe('ns:tower')
    expect(consequence.warning.oneWay).toBe(true)
  })

  it('ejects the PARENT when a generated child is edited', () => {
    const consequence = classifyEdit(view, { what: 'node-body', identifier: 'ns:tower__item_1' })
    expect(consequence.effect).toBe('eject')
    if (consequence.effect !== 'eject') return
    expect(consequence.identifier).toBe('ns:tower')
  })

  it('leaves an ordinary node ordinary', () => {
    expect(classifyEdit(view, { what: 'node-body', identifier: 'ns:leaf' })).toEqual({ effect: 'plain', identifier: 'ns:leaf' })
    expect(classifyEdit(view, { what: 'compound-fields', identifier: 'ns:leaf' })).toEqual({ effect: 'unknown', identifier: 'ns:leaf' })
    expect(classifyEdit(view, { what: 'node-body', identifier: 'ns:nothing' })).toEqual({ effect: 'unknown', identifier: 'ns:nothing' })
  })

  it('says what an edit will cost BEFORE it happens', () => {
    const warning = ejectWarning(view, 'ns:tower')
    expect(warning).not.toBeNull()
    expect(warning?.losesParams).toEqual({ count: '2', places: 'ns:leaf' })
    expect(warning?.nodesBecomingPlain).toEqual(['ns:tower', 'ns:tower__item_0', 'ns:tower__item_1'])
    expect(warning?.reason).toContain('cannot be undone')
    expect(ejectWarning(view, 'ns:leaf')).toBeNull()
  })

  it('tells the command layer when regenerating would overwrite a hand edit', () => {
    const drifted = buildCompoundView({
      graph: standardGraph({ root: { fields: { description: { identifier: 'ns:tower' }, iterations: '2', scatter_chance: 25 } } }),
      registry,
    })
    const consequence = classifyEdit(drifted, { what: 'compound-fields', identifier: 'ns:tower' })
    expect(consequence.effect).toBe('regenerate')
    if (consequence.effect !== 'regenerate') return
    expect(consequence.overwritesDrift).toBe(true)
    expect(consequence.drift[0]?.what).toBe('field-changed')
  })
})

describe('planParameterEdit', () => {
  const view = buildCompoundView({ graph: standardGraph(), registry })

  it('re-expands, stays collapsed, and passes the spec\'s operations through in order', () => {
    const plan = planParameterEdit({ view, identifier: 'ns:tower', params: { count: '3', places: 'ns:leaf' }, registry })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')

    expect(plan.stays).toBe('collapsed')
    expect(plan.creates).toEqual(['ns:tower', 'ns:tower__item_0', 'ns:tower__item_1', 'ns:tower__item_2'])
    expect(plan.operations.map((operation) => operation.op)).toEqual(['createFile', 'createFile', 'createFile', 'createFile'])
    expect(plan.files).toEqual([
      'features/tower.json',
      'features/tower__item_0.json',
      'features/tower__item_1.json',
      'features/tower__item_2.json',
    ])
    expect(plan.orphans).toEqual([])
  })

  it('re-records the new parameters in the annotation', () => {
    const plan = planParameterEdit({ view, identifier: 'ns:tower', params: { count: '3', places: 'ns:leaf' }, registry })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')

    expect(plan.annotation.file).toBe('features/tower.json')
    expect(plan.annotation.jsonPath).toBe('$')
    expect(plan.annotation.directive).toBe(`@featurelab:${COMPOUND_DIRECTIVE} loop`)
    expect(plan.annotation.body).toBe(encodeCompoundParams({ count: '3', places: 'ns:leaf' }))
    expect(plan.annotation.previousBody).toBe(encodeCompoundParams({ count: '2', places: 'ns:leaf' }))
    expect(plan.annotation.directiveSpan).toEqual({ offset: 40, endOffset: 40 + `@featurelab:${COMPOUND_DIRECTIVE} loop`.length })
  })

  it('cannot be applied from its operations alone, and says so rather than pretending', () => {
    // The parameters live in Annotation.Text, which has no recorded span and no
    // PlanOperation that can address it. Applying the operations without the
    // annotation change would leave the recording disagreeing with the files.
    const plan = planParameterEdit({ view, identifier: 'ns:tower', params: { count: '3', places: 'ns:leaf' }, registry })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')

    expect(plan.applyable).toBe(false)
    expect(plan.blocked.map((gap) => gap.gap)).toEqual(['annotation-body-has-no-span'])
    expect(plan.notes.some((note) => note.level === 'warning')).toBe(true)
  })

  it('lists the children the new parameters no longer produce, and does not fabricate a delete', () => {
    const plan = planParameterEdit({ view, identifier: 'ns:tower', params: { count: '1', places: 'ns:leaf' }, registry })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')

    expect(plan.orphans.map((orphan) => orphan.identifier)).toEqual(['ns:tower__item_1'])
    expect(plan.orphans[0]?.file).toBe('features/tower__item_1.json')
    // PlanOperation has no file deletion; the operations are creates only.
    expect(plan.operations.every((operation) => operation.op === 'createFile')).toBe(true)
    expect(plan.blocked.map((gap) => gap.gap)).toEqual(['annotation-body-has-no-span', 'no-file-delete-operation'])
  })

  it('warns when an orphan is something else\'s target', () => {
    const borrowedView = buildCompoundView({
      graph: {
        nodes: [compoundRoot(), child(0), child(1), leaf],
        edges: [{ from: 'ns:leaf', to: 'ns:tower__item_1', kind: 'child', jsonPath: '$.vegetation_feature', required: false }],
      },
      registry,
    })
    const plan = planParameterEdit({ view: borrowedView, identifier: 'ns:tower', params: { count: '1', places: 'ns:leaf' }, registry })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')
    expect(plan.orphans[0]?.borrowed).toBe(true)
    expect(plan.orphans[0]?.reason).toContain('dangling reference')
  })

  it('carries the drift it is about to overwrite', () => {
    const drifted = buildCompoundView({
      graph: standardGraph({ root: { fields: { description: { identifier: 'ns:tower' }, iterations: '2', scatter_chance: 25 } } }),
      registry,
    })
    const plan = planParameterEdit({ view: drifted, identifier: 'ns:tower', params: { count: '2', places: 'ns:leaf' }, registry })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')
    expect(plan.overwrites.map((finding) => finding.what)).toEqual(['field-changed'])
  })

  it('refuses, with a reason, rather than throwing', () => {
    const cases: ReadonlyArray<readonly [string, Parameters<typeof planParameterEdit>[0], string]> = [
      ['not a compound', { view, identifier: 'ns:leaf', params: {}, registry }, 'unknown-node'],
      ['not in the graph', { view, identifier: 'ns:gone', params: {}, registry }, 'unknown-node'],
      ['no spec registered', { view, identifier: 'ns:tower', params: {}, registry: {} }, 'unknown-wrapper'],
      ['a spec that throws', { view, identifier: 'ns:tower', params: {}, registry: { loop: throwingSpec } }, 'molang-invalid'],
    ]
    for (const [, input, code] of cases) {
      const result = planParameterEdit(input)
      if (!('ok' in result) || result.ok !== false) throw new Error('expected a refusal')
      expect(result.refusal.code).toBe(code)
      expect(result.refusal.reason.length).toBeGreaterThan(20)
    }
  })

  it('passes the spec\'s own refusal through untouched', () => {
    const result = planParameterEdit({ view, identifier: 'ns:tower', params: { nonsense: true }, registry })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected a refusal')
    expect(result.refusal).toEqual({ code: 'path-shape', reason: 'A fake compound needs a count and a places.' })
  })

  it('refuses without a format_version, because the editable key set depends on it', () => {
    const versionless = buildCompoundView({ graph: standardGraph({ root: { formatVersion: undefined } }), registry })
    const result = planParameterEdit({ view: versionless, identifier: 'ns:tower', params: { count: '1', places: 'ns:leaf' }, registry })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected a refusal')
    expect(result.refusal.code).toBe('no-format-version')
  })

  it('refuses a compound whose node reports no file', () => {
    const fileless = buildCompoundView({ graph: standardGraph({ root: { file: undefined } }), registry })
    const result = planParameterEdit({ view: fileless, identifier: 'ns:tower', params: { count: '1', places: 'ns:leaf' }, registry })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected a refusal')
    expect(result.refusal.code).toBe('unresolved-node')
  })

  it('is pure -- the same edit twice is the same plan twice', () => {
    const args = { view, identifier: 'ns:tower', params: { count: '3', places: 'ns:leaf' }, registry } as const
    expect(planParameterEdit({ ...args })).toEqual(planParameterEdit({ ...args }))
  })
})

describe('planEject', () => {
  const view = buildCompoundView({ graph: standardGraph(), registry })

  it('removes the annotation and touches no JSON', () => {
    const plan = planEject({ view, identifier: 'ns:tower' })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')

    expect(plan.operations).toEqual([])
    expect(plan.annotation.directive).toBe('')
    expect(plan.annotation.body).toBe('')
    expect(plan.annotation.directiveSpan).toEqual({ offset: 40, endOffset: 62 })
    expect(plan.annotation.previousBody).toBe(encodeCompoundParams({ count: '2', places: 'ns:leaf' }))
    expect(plan.becomesPlain).toEqual(['ns:tower', 'ns:tower__item_0', 'ns:tower__item_1'])
  })

  it('carries the warning with it, not only ahead of it', () => {
    const plan = planEject({ view, identifier: 'ns:tower' })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')
    expect(plan.warning.oneWay).toBe(true)
    expect(plan.warning.losesParams).toEqual({ count: '2', places: 'ns:leaf' })
    expect(plan.notes[0]?.level).toBe('warning')
  })

  it('is blocked on the same missing span as a parameter edit', () => {
    const plan = planEject({ view, identifier: 'ns:tower' })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')
    // The recorded span covers `@featurelab:idiom loop` and stops there, so
    // blanking it leaves the parameter comment line behind as prose.
    expect(plan.applyable).toBe(false)
    expect(plan.blocked.map((gap) => gap.gap)).toEqual(['annotation-body-has-no-span'])
  })

  it('can eject a drifted compound -- keeping the JSON is the whole point', () => {
    const drifted = buildCompoundView({
      graph: standardGraph({ root: { fields: { description: { identifier: 'ns:tower' }, iterations: '2', scatter_chance: 25 } } }),
      registry,
    })
    const plan = planEject({ view: drifted, identifier: 'ns:tower' })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')
    expect(plan.operations).toEqual([])
  })

  it('refuses on anything that is not a compound', () => {
    for (const identifier of ['ns:leaf', 'ns:tower__item_0', 'ns:gone']) {
      const result = planEject({ view, identifier })
      if (!('ok' in result) || result.ok !== false) throw new Error('expected a refusal')
      expect(result.refusal.code).toBe('unknown-node')
    }
  })

  it('refuses a compound whose node reports no file', () => {
    const fileless = buildCompoundView({ graph: standardGraph({ root: { file: undefined } }), registry })
    const result = planEject({ view: fileless, identifier: 'ns:tower' })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected a refusal')
    expect(result.refusal.code).toBe('unresolved-node')
  })

  it('reports no span at all rather than a made-up one when the annotation carries no offsets', () => {
    const spanless = buildCompoundView({
      graph: standardGraph({ root: { annotations: [{ ...idiom(), offset: undefined, endOffset: undefined }] } }),
      registry,
    })
    const plan = planEject({ view: spanless, identifier: 'ns:tower' })
    if (!('ok' in plan) || plan.ok !== true) throw new Error('expected a plan')
    expect(plan.annotation.directiveSpan).toBeNull()
    expect(plan.applyable).toBe(false)
  })
})
