// graphConnect.test.ts -- covers src/graph/connect.ts, which answers what dragging a connection
// from one node to another would DO to the JSON.
//
// Three halves, and the first one is the reason this file exists at all.
//
//   1. THE TABLE IS HELD AGAINST THE ENGINE. connect.ts carries a per-type table of which key a
//      delegation is written under, and a table like that is exactly the kind of thing that is
//      right the day it is written and wrong the day a type is added. So it is not asserted
//      against itself: it is read out of this repo's Go delegation tables and compared,
//      the same way test/catalogueAgainstEngine.test.ts holds the field catalogue against the
//      builders. A type that gains, loses or renames a child slot fails here.
//   2. THE ASKS ARE PINNED. Three values have no defensible default -- a weighted entry's weight,
//      a conditional entry's condition, and which of a tree's two trunk slots was meant -- and
//      "asks" rather than "guesses" is a promise that a later convenience could quietly break.
//      Each of them is asserted to come back as a question, and each of the plausible wrong
//      defaults is asserted NOT to be written.
//   3. THE REFUSALS ARE PINNED WITH THEIR SENTENCES. A refusal's whole user-visible product is
//      its reason, so an empty or code-shaped one is a broken feature even though every type
//      checks. The last test sweeps every sentence this module can produce for the things a
//      user-visible string here must never contain.
//
// Fixtures use `example:` identifiers throughout, and so do the assertions.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  childlessTypeIds,
  connectSourcePreview,
  connectableTypeIds,
  listSlotFor,
  planConnection,
  previewConnection,
  singleSlotsFor,
  type ConnectGraph,
  type ConnectGraphNode,
  type ConnectResult,
} from '../src/graph/connect.js'
import { catalogedTypeIds } from '../src/graph/typeCatalog.js'
import type { IdiomGraphEdge } from '../src/graph/idioms.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

function goSource(rel: string): string {
  const abs = path.join(repoRoot, rel)
  if (!fs.existsSync(abs)) throw new Error(`${rel} is not where this test expects the engine to be (looked in ${repoRoot})`)
  return fs.readFileSync(abs, 'utf8')
}

/** The body of a `var <name> = map[string]struct{...}{ ... }` literal.
 *
 * The `}{` in the middle is why this is a function: the struct type's own closing brace sits at
 * the start of a line, so the obvious "up to the next `\n}`" stops before a single entry has been
 * read -- and a table read as empty passes every "for each entry" assertion in this file
 * vacuously. The size checks below are there because it happened. */
function goMapBody(src: string, name: string): string {
  const start = src.indexOf(`var ${name} = map[string]struct`)
  expect(start, `wire/graphcheck.go no longer declares ${name}`).toBeGreaterThan(-1)
  const open = src.indexOf('}{', start)
  expect(open, `${name} is not the map-of-struct literal this test knows how to read`).toBeGreaterThan(-1)
  return src.slice(open + 2, src.indexOf('\n}', open + 2))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(id: string, typeId: string, extra: Partial<ConnectGraphNode> = {}): ConnectGraphNode {
  return { id, typeId, file: `features/${id.split(':')[1]}.json`, formatVersion: '1.21.10', ...extra }
}

function edge(partial: Partial<IdiomGraphEdge> & Pick<IdiomGraphEdge, 'from' | 'to' | 'kind' | 'jsonPath'>): IdiomGraphEdge {
  return { ordinal: 0, required: false, ...partial }
}

/** A leaf everything in this file connects TO -- a type that places blocks and holds nothing, so
 * it is never the interesting half of an assertion. */
const LEAF = node('example:gravel_block', 'minecraft:single_block_feature')
const LEAF_TWO = node('example:mossy_block', 'minecraft:single_block_feature')

function graphOf(nodes: readonly ConnectGraphNode[], edges: readonly IdiomGraphEdge[] = []): ConnectGraph {
  return { nodes: [...nodes], edges: [...edges] }
}

function plan(result: ConnectResult) {
  if (result.outcome !== 'plan') throw new Error(`expected a plan, got ${result.outcome}: ${JSON.stringify(result)}`)
  return result.plan
}

function ask(result: ConnectResult) {
  if (result.outcome !== 'ask') throw new Error(`expected a question, got ${result.outcome}: ${JSON.stringify(result)}`)
  return result.ask
}

function refusal(result: ConnectResult) {
  if (result.outcome !== 'refuse') throw new Error(`expected a refusal, got ${result.outcome}: ${JSON.stringify(result)}`)
  return result.refusal
}

/** The single `set` a plan makes, when it makes exactly one. */
function onlySet(result: ConnectResult): { file: string; path: string; value: unknown } {
  const operations = plan(result).operations
  expect(operations).toHaveLength(1)
  const op = operations[0]!
  if (op.op !== 'set') throw new Error(`expected a set, got ${op.op}`)
  return { file: op.file, path: op.path, value: op.value }
}

// ---------------------------------------------------------------------------
// 1. The table, against the engine's own
// ---------------------------------------------------------------------------

describe('the per-type delegation table is the engine\'s, not this module\'s', () => {
  /** wire/graphcheck.go's `checkSingleDelegation`: every type that delegates to exactly one
   * feature, with the edge kind and the JSON key. */
  function singleDelegationFromGo(): Map<string, { kind: string; key: string }> {
    const body = goMapBody(goSource('wire/graphcheck.go'), 'checkSingleDelegation')
    const out = new Map<string, { kind: string; key: string }>()
    for (const m of body.matchAll(/"([^"]+)":\s*\{Edge(\w+),\s*"([^"]+)"\}/g)) {
      out.set(m[1]!, { kind: (m[2] ?? '').toLowerCase(), key: m[3]! })
    }
    return out
  }

  /** wire/graphcheck.go's `checkListDelegation`. */
  function listDelegationFromGo(): Map<string, { kind: string; key: string }> {
    const body = goMapBody(goSource('wire/graphcheck.go'), 'checkListDelegation')
    const out = new Map<string, { kind: string; key: string }>()
    for (const m of body.matchAll(/"([^"]+)":\s*\{Edge(\w+),\s*"([^"]+)",\s*(?:true|false)\}/g)) {
      out.set(m[1]!, { kind: (m[2] ?? '').toLowerCase(), key: m[3]! })
    }
    return out
  }

  it('holds every single-child type the engine names, at the engine\'s own key', () => {
    const fromGo = singleDelegationFromGo()
    expect(fromGo.size, 'no single-delegation entries were read out of the engine at all').toBeGreaterThan(5)
    for (const [typeId, expected] of fromGo) {
      const slots = singleSlotsFor(node('example:x', typeId))
      expect(slots.length, `${typeId} delegates to exactly one feature and connect.ts offers no slot for it`).toBe(1)
      const slot = slots[0]!
      expect(slot.kind, `${typeId}'s edge kind`).toBe(expected.kind)
      // The LAST path segment is the key; a rule's slot is nested under `description`.
      expect(slot.path[slot.path.length - 1], `${typeId} writes its child under the wrong key`).toBe(expected.key)
    }
  })

  it('holds every list type the engine names, at the engine\'s own key', () => {
    const fromGo = listDelegationFromGo()
    expect(fromGo.size).toBe(4)
    for (const [typeId, expected] of fromGo) {
      const slot = listSlotFor(node('example:x', typeId))
      expect(slot, `${typeId} holds a list of features and connect.ts offers no list slot for it`).toBeDefined()
      expect(slot!.kind).toBe(expected.kind)
      expect(slot!.key).toBe(expected.key)
    }
  })

  it('offers no slot the engine does not have', () => {
    // The other direction. A key invented here would be written into somebody's file and then
    // dropped unread by the engine, which is silent -- the type fails afterwards on the required
    // reference it still does not have, and the message names the key that IS missing.
    const single = singleDelegationFromGo()
    const list = listDelegationFromGo()
    const build = goSource('wire/graphbuild.go')
    for (const typeId of connectableTypeIds()) {
      if (single.has(typeId) || list.has(typeId)) continue
      // The two remaining types hold a NAMED CHILD, which the engine keeps out of those tables on
      // purpose (whether such a slot is required is the individual type's business). They are
      // read out of the graph builder's own switch instead.
      expect(build).toContain(`case "${typeId}":`)
    }
  })

  it('writes a named child slot at the key the graph builder reads it from', () => {
    const build = goSource('wire/graphbuild.go')
    // vegetation_patch: `childDelegation(doc, "vegetation_feature", true)` -- required.
    const patch = /case "minecraft:vegetation_patch_feature":\s*\n\s*return b\.childDelegation\(doc, "([^"]+)", (true|false)\)/.exec(build)
    expect(patch, 'the graph builder no longer reads vegetation_patch_feature the way this test does').not.toBeNull()
    const patchSlots = singleSlotsFor(node('example:patch', 'minecraft:vegetation_patch_feature'))
    expect(patchSlots).toHaveLength(1)
    expect(patchSlots[0]!.path).toEqual([patch![1]])
    expect(patchSlots[0]!.required).toBe(patch![2] === 'true')
    expect(patchSlots[0]!.kind).toBe('child')

    // tree: the decoration key, and the two trunk shapes that carry it.
    const key = /const key = "([^"]+)"/.exec(build.slice(build.indexOf('func (b *graphBuilder) treeDelegations')))
    expect(key, 'the graph builder no longer names the tree decoration key the way this test does').not.toBeNull()
    const trunks = /for _, trunkKey := range \[\]string\{([^}]*)\}/.exec(build.slice(build.indexOf('func (b *graphBuilder) treeDelegations')))
    const trunkKeys = [...(trunks?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
    expect(trunkKeys.length).toBe(2)
    const tree = node('example:oak', 'minecraft:tree_feature', {
      fields: Object.fromEntries(trunkKeys.map((t) => [t, { trunk_block: 'minecraft:oak_log' }])),
    })
    expect(singleSlotsFor(tree).map((s) => s.path)).toEqual(trunkKeys.map((t) => [t, key![1]]))
    // And never required: a trunk without the key simply places no decoration.
    expect(singleSlotsFor(tree).every((s) => !s.required)).toBe(true)
  })

  it('knows every spelling scan_surface accepts, in the order the engine reads them', () => {
    const build = goSource('wire/graphbuild.go')
    const found = /case "minecraft:scan_surface":\s*\n\s*return b\.filterDelegation\(doc, ((?:"[^"]*",?\s*)+)\)/.exec(build)
    expect(found, 'the graph builder no longer reads scan_surface the way this test does').not.toBeNull()
    const keys = [...(found![1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
    expect(keys.length).toBeGreaterThan(1)
    const slot = singleSlotsFor(node('example:scan', 'minecraft:scan_surface'))[0]!
    expect([slot.path[slot.path.length - 1], ...(slot.aliases ?? [])]).toEqual(keys)
  })

  it('classifies every type the field catalogue knows, so a new one cannot arrive unclassified', () => {
    // The point of the childless list being a LIST rather than "everything not above": "this type
    // places blocks itself" is a fact about the format, and "this tool has not classified this
    // type" is an admission. An author needs the two to read differently, and they only can while
    // every known type is in one bucket or the other.
    const classified = new Set([...connectableTypeIds(), ...childlessTypeIds()])
    const unclassified = catalogedTypeIds().filter((id) => !classified.has(id))
    expect(
      unclassified,
      'these types are in the field catalogue and connect.ts has no answer for them, so a drag from one refuses as "this tool does not know" rather than saying what the type does',
    ).toEqual([])
    // And nothing is in both buckets.
    expect(connectableTypeIds().filter((id) => childlessTypeIds().includes(id))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. One slot: what a second connection does to the first
// ---------------------------------------------------------------------------

describe('a type that holds ONE feature replaces, and says so before it does', () => {
  const scatter = node('example:scatter', 'minecraft:scatter_feature')

  it('fills an empty slot at the type\'s own key', () => {
    const result = planConnection(graphOf([scatter, LEAF]), { from: scatter.id, to: LEAF.id })
    const set = onlySet(result)
    expect(set.path).toBe('$.minecraft:scatter_feature.places_feature')
    expect(set.value).toBe(LEAF.id)
    expect(set.file).toBe(scatter.file)
    expect(plan(result).kind).toBe('scatter')
    expect(plan(result).destructive).toBe(false)
    expect(plan(result).replaces).toBeUndefined()
    // The one note worth having when a required key was missing: it was missing.
    expect(plan(result).notes.map((n) => n.message).join(' ')).toContain('cannot load without')
  })

  it('REPLACES an occupied one, marks the plan destructive, and names what goes', () => {
    const graph = graphOf(
      [scatter, LEAF, LEAF_TWO],
      [edge({ from: scatter.id, to: LEAF.id, kind: 'scatter', jsonPath: '$.minecraft:scatter_feature.places_feature', required: true })],
    )
    const result = planConnection(graph, { from: scatter.id, to: LEAF_TWO.id })
    const set = onlySet(result)
    // Written at the SAME path, so the old reference is gone rather than sitting beside the new.
    expect(set.path).toBe('$.minecraft:scatter_feature.places_feature')
    expect(set.value).toBe(LEAF_TWO.id)
    expect(plan(result).destructive).toBe(true)
    expect(plan(result).replaces).toEqual({ to: LEAF.id, kind: 'scatter', jsonPath: '$.minecraft:scatter_feature.places_feature' })
    const warning = plan(result).notes.find((n) => n.level === 'warning')
    expect(warning?.message).toContain(LEAF.id)
    expect(warning?.message).toContain('REPLACED')
    // And the same fact reaches the pointer BEFORE the drop, which is the whole point.
    const preview = previewConnection(graph, scatter.id, LEAF_TWO.id)
    expect(preview.allowed).toBe(true)
    expect(preview.replaces).toBe(LEAF.id)
    expect(preview.label).toContain(LEAF.id)
  })

  it('refuses a connection that already exists rather than rewriting it as a no-op', () => {
    const graph = graphOf(
      [scatter, LEAF],
      [edge({ from: scatter.id, to: LEAF.id, kind: 'scatter', jsonPath: '$.minecraft:scatter_feature.places_feature' })],
    )
    const refused = refusal(planConnection(graph, { from: scatter.id, to: LEAF.id }))
    expect(refused.code).toBe('duplicate-entry')
    expect(refused.reason).toContain('already places')
  })

  it('writes a rule\'s child under description, at the plural key its FILE is rooted at', () => {
    // The trap: a rule's node type is the singular synthetic "minecraft:feature_rule" and its
    // file is rooted at "minecraft:feature_rules". Rebuilding the path from the type id would
    // write a key no rule file has.
    const rule = node('example:place_it.fr', 'minecraft:feature_rule', { file: 'feature_rules/place_it.json' })
    const set = onlySet(planConnection(graphOf([rule, LEAF]), { from: rule.id, to: LEAF.id }))
    expect(set.path).toBe('$.minecraft:feature_rules.description.places_feature')
    expect(set.file).toBe('feature_rules/place_it.json')
  })

  it('prefers the path the graph already reports over rebuilding one', () => {
    // A file rooted at something this module would not have guessed. Taking the prefix of a path
    // the producer already emitted sidesteps the whole question.
    const odd = node('example:odd', 'minecraft:scatter_feature')
    const graph = graphOf(
      [odd, LEAF, LEAF_TWO],
      [edge({ from: odd.id, to: LEAF.id, kind: 'scatter', jsonPath: '$.minecraft:scatter_feature.places_feature' })],
    )
    expect(onlySet(planConnection(graph, { from: odd.id, to: LEAF_TWO.id })).path).toBe('$.minecraft:scatter_feature.places_feature')
  })

  it('rewrites a filter\'s reference under the spelling the FILE used, not the canonical one', () => {
    // scan_surface reads three key names and takes whichever it finds first. Writing the
    // canonical one beside an existing alternative would leave two keys, and the engine would
    // read whichever comes first -- so the edit might change nothing at all.
    const scan = node('example:scan', 'minecraft:scan_surface')
    const graph = graphOf(
      [scan, LEAF, LEAF_TWO],
      [edge({ from: scan.id, to: LEAF.id, kind: 'filter', jsonPath: '$.minecraft:scan_surface.feature_to_scan', required: true })],
    )
    const set = onlySet(planConnection(graph, { from: scan.id, to: LEAF_TWO.id }))
    expect(set.path).toBe('$.minecraft:scan_surface.feature_to_scan')
  })

  it('writes a NEW filter reference under the canonical key, and says the type reads others', () => {
    const scan = node('example:scan', 'minecraft:scan_surface')
    const result = planConnection(graphOf([scan, LEAF]), { from: scan.id, to: LEAF.id })
    expect(onlySet(result).path).toBe('$.minecraft:scan_surface.places_feature')
    const note = plan(result).notes.find((n) => n.message.includes('feature_to_scan'))
    expect(note, 'a type with several accepted spellings must say which one was written').toBeDefined()
  })

  it('keeps the two filters whose key is NOT places_feature apart', () => {
    // snap_to_surface reads `feature_to_snap` and surface_relative_threshold reads
    // `feature_to_place`; neither accepts the other's spelling or the common one, and a file
    // using the wrong key does not load.
    const snap = node('example:snap', 'minecraft:snap_to_surface_feature')
    const threshold = node('example:deep', 'minecraft:surface_relative_threshold_feature')
    expect(onlySet(planConnection(graphOf([snap, LEAF]), { from: snap.id, to: LEAF.id })).path).toBe(
      '$.minecraft:snap_to_surface_feature.feature_to_snap',
    )
    expect(onlySet(planConnection(graphOf([threshold, LEAF]), { from: threshold.id, to: LEAF.id })).path).toBe(
      '$.minecraft:surface_relative_threshold_feature.feature_to_place',
    )
  })

  it('refuses when the existing delegation is written somewhere it cannot read', () => {
    // The silent failure this guards: an unreadable path makes the slot LOOK empty, so a
    // connection writes the canonical key and leaves whatever is already there beside it. The
    // type reads one reference, the engine takes whichever comes first, and the edit may change
    // nothing at all -- with no error anywhere.
    const scatter = node('example:scatter', 'minecraft:scatter_feature')
    const graph = graphOf(
      [scatter, LEAF, LEAF_TWO],
      [edge({ from: scatter.id, to: LEAF.id, kind: 'scatter', jsonPath: '$.scatter[0]' })],
    )
    const refused = refusal(planConnection(graph, { from: scatter.id, to: LEAF_TWO.id }))
    expect(refused.code).toBe('path-shape')
    expect(refused.reason).toContain(LEAF.id)
    expect(refused.reason).toContain('two')
  })

  it('writes a vegetation patch\'s child as a named slot, not as a filter', () => {
    const patch = node('example:patch', 'minecraft:vegetation_patch_feature')
    const result = planConnection(graphOf([patch, LEAF]), { from: patch.id, to: LEAF.id })
    expect(plan(result).kind).toBe('child')
    expect(onlySet(result).path).toBe('$.minecraft:vegetation_patch_feature.vegetation_feature')
  })
})

// ---------------------------------------------------------------------------
// 3. Lists
// ---------------------------------------------------------------------------

describe('a type that holds a LIST appends, and the position means different things', () => {
  const aggregate = node('example:both', 'minecraft:aggregate_feature')
  const sequence = node('example:then', 'minecraft:sequence_feature')

  function withEntries(parent: ConnectGraphNode, kind: 'aggregate' | 'sequence', targets: readonly string[]) {
    return graphOf(
      [parent, LEAF, LEAF_TWO, ...targets.filter((t) => t !== LEAF.id && t !== LEAF_TWO.id).map((t) => node(t, 'minecraft:ore_feature'))],
      targets.map((to, i) =>
        edge({ from: parent.id, to, kind, ordinal: i, jsonPath: `$.${parent.typeId}.features[${i}]` }),
      ),
    )
  }

  it('appends one element at the end of an existing list', () => {
    const graph = withEntries(aggregate, 'aggregate', ['example:first', 'example:second'])
    const set = onlySet(planConnection(graph, { from: aggregate.id, to: LEAF.id }))
    expect(set.path).toBe('$.minecraft:aggregate_feature.features[2]')
    expect(set.value).toBe(LEAF.id)
  })

  it('computes the append index from the entries\' own positions, not from how many it can read', () => {
    // A list whose readable entries are at 0 and 2 is a list with three positions. Appending at
    // "however many I could read" would write over position 2.
    const graph = graphOf(
      [aggregate, LEAF],
      [
        edge({ from: aggregate.id, to: 'example:a', kind: 'aggregate', ordinal: 0, jsonPath: '$.minecraft:aggregate_feature.features[0]' }),
        edge({ from: aggregate.id, to: 'example:b', kind: 'aggregate', ordinal: 2, jsonPath: '$.minecraft:aggregate_feature.features[2]' }),
      ],
    )
    expect(onlySet(planConnection(graph, { from: aggregate.id, to: LEAF.id })).path).toBe('$.minecraft:aggregate_feature.features[3]')
  })

  it('writes the whole list when the graph reports no entries, and warns that it does', () => {
    // A list this module cannot see into may be absent, empty, or holding something unreadable.
    // An append cannot create the key, so the key is written -- and the risk is stated rather
    // than discovered afterwards.
    const result = planConnection(graphOf([aggregate, LEAF]), { from: aggregate.id, to: LEAF.id })
    const set = onlySet(result)
    expect(set.path).toBe('$.minecraft:aggregate_feature.features')
    expect(set.value).toEqual([LEAF.id])
    expect(plan(result).notes.some((n) => n.level === 'warning' && n.message.includes('replaced'))).toBe(true)
  })

  it('says where a SEQUENCE step lands, and what it runs after', () => {
    const graph = withEntries(sequence, 'sequence', ['example:first', 'example:second'])
    const result = planConnection(graph, { from: sequence.id, to: LEAF.id })
    expect(plan(result).kind).toBe('sequence')
    const note = plan(result).notes.find((n) => n.message.includes('step 3 of 3'))
    expect(note, 'a sequence entry must say which step it becomes -- that is the generated world, not the file\'s layout').toBeDefined()
    expect(note!.message).toContain('example:second')
    expect(note!.message).toContain('execution order')
  })

  it('says the opposite about an AGGREGATE, which has no execution order to speak of', () => {
    const graph = withEntries(aggregate, 'aggregate', ['example:first'])
    const summary = plan(planConnection(graph, { from: aggregate.id, to: LEAF.id })).summary
    expect(summary).toContain('not an execution order')
    // And it never claims a step number.
    expect(summary).not.toMatch(/step \d/)
  })

  it('rewrites the whole list to insert a step before the end, and warns that it rewrites it', () => {
    const graph = withEntries(sequence, 'sequence', ['example:first', 'example:second'])
    const result = planConnection(graph, { from: sequence.id, to: LEAF.id, inputs: { index: 1 } })
    const set = onlySet(result)
    expect(set.path).toBe('$.minecraft:sequence_feature.features')
    expect(set.value).toEqual(['example:first', LEAF.id, 'example:second'])
    expect(plan(result).destructive).toBe(true)
    expect(plan(result).notes.some((n) => n.message.includes('rewrites'))).toBe(true)
    expect(plan(result).notes.some((n) => n.message.includes('step 2 of 3'))).toBe(true)
  })

  it('refuses a mid-list insert it cannot reconstruct byte for byte', () => {
    // Positions 0 and 2 readable: there is something at 1 this module cannot see, and rewriting
    // the list to make room would drop it.
    const graph = graphOf(
      [sequence, LEAF],
      [
        edge({ from: sequence.id, to: 'example:a', kind: 'sequence', ordinal: 0, jsonPath: '$.minecraft:sequence_feature.features[0]' }),
        edge({ from: sequence.id, to: 'example:b', kind: 'sequence', ordinal: 2, jsonPath: '$.minecraft:sequence_feature.features[2]' }),
      ],
    )
    const refused = refusal(planConnection(graph, { from: sequence.id, to: LEAF.id, inputs: { index: 1 } }))
    expect(refused.code).toBe('path-shape')
    expect(refused.reason).toContain('at the end')
  })

  it('refuses a position that is not a place in the list', () => {
    const graph = withEntries(sequence, 'sequence', ['example:first'])
    expect(refusal(planConnection(graph, { from: sequence.id, to: LEAF.id, inputs: { index: 9 } })).code).toBe('params-malformed')
    expect(refusal(planConnection(graph, { from: sequence.id, to: LEAF.id, inputs: { index: -1 } })).code).toBe('params-malformed')
  })

  it('allows a second entry for the same feature, and says it is a second one', () => {
    // Real packs do this -- an aggregate listing one feature twice -- so it is a note, not a
    // refusal. Contrast the single-slot case, where the same drop is a no-op and is refused.
    const graph = withEntries(aggregate, 'aggregate', [LEAF.id])
    const result = planConnection(graph, { from: aggregate.id, to: LEAF.id })
    expect(result.outcome).toBe('plan')
    expect(plan(result).notes.some((n) => n.level === 'warning' && n.message.includes('already lists'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. The three questions
// ---------------------------------------------------------------------------

describe('a weighted pick ASKS for a weight rather than inventing one', () => {
  const pick = node('example:pick', 'minecraft:weighted_random_feature')

  function withWeights(entries: readonly (readonly [string, number | undefined])[]): ConnectGraph {
    return graphOf(
      [pick, LEAF, LEAF_TWO],
      entries.map(([to, weight], i) =>
        edge({
          from: pick.id,
          to,
          kind: 'weighted',
          ordinal: i,
          jsonPath: `$.minecraft:weighted_random_feature.features[${i}][0]`,
          ...(weight === undefined ? {} : { weight }),
        }),
      ),
    )
  }

  it('asks, and hands the question the siblings the number has to be chosen against', () => {
    const graph = withWeights([['example:common', 9], ['example:rare', undefined]])
    const question = ask(planConnection(graph, { from: pick.id, to: LEAF.id }))
    expect(question.questions).toHaveLength(1)
    const weight = question.questions[0]!
    expect(weight.input).toBe('weight')
    if (weight.input !== 'weight') throw new Error('unreachable')
    // An unwritten weight is reported as the engine's own default AND as unwritten -- the same
    // distinction the graph contract keeps, for the same reason.
    expect(weight.siblings).toEqual([
      { to: 'example:common', weight: 9, written: true },
      { to: 'example:rare', weight: 1, written: false },
    ])
    expect(weight.detail).toContain('10')
    // And the drag says so before the drop: legal, but it will ask.
    expect(previewConnection(graph, pick.id, LEAF.id)).toMatchObject({ allowed: true, asks: ['weight'] })
  })

  it('writes the common shape -- a [feature, weight] pair -- when the list has no shape yet', () => {
    // A pick with no readable entries gets its whole `features` key written, so the entry is the
    // one element of it. The engine refuses an empty one, so there is no other shape to write.
    const set = onlySet(planConnection(graphOf([pick, LEAF]), { from: pick.id, to: LEAF.id, inputs: { weight: 4 } }))
    expect(set.path).toBe('$.minecraft:weighted_random_feature.features')
    expect(set.value).toEqual([[LEAF.id, 4]])
  })

  it('appends the pair on its own once the list has something in it', () => {
    const set = onlySet(planConnection(withWeights([['example:common', 9]]), { from: pick.id, to: LEAF.id, inputs: { weight: 4 } }))
    expect(set.path).toBe('$.minecraft:weighted_random_feature.features[1]')
    expect(set.value).toEqual([LEAF.id, 4])
  })

  it('matches the spelling its neighbours use instead of mixing two in one list', () => {
    const graph = graphOf(
      [pick, LEAF, LEAF_TWO],
      [
        edge({
          from: pick.id,
          to: LEAF_TWO.id,
          kind: 'weighted',
          ordinal: 0,
          jsonPath: '$.minecraft:weighted_random_feature.features[0].places_feature',
          weight: 2,
        }),
      ],
    )
    const set = onlySet(planConnection(graph, { from: pick.id, to: LEAF.id, inputs: { weight: 3 } }))
    expect(set.value).toEqual({ places_feature: LEAF.id, weight: 3 })
  })

  it('says what the new entry does to every entry that was already there', () => {
    const graph = withWeights([['example:common', 9]])
    const result = planConnection(graph, { from: pick.id, to: LEAF.id, inputs: { weight: 1 } })
    const note = plan(result).notes.find((n) => n.message.includes('10%'))
    expect(note, 'a weight is only a chance against its siblings, so the plan has to state the share').toBeDefined()
    expect(note!.message).toContain('drops')
  })

  it('warns about a weight of zero instead of quietly writing an entry that never happens', () => {
    const result = planConnection(withWeights([['example:common', 9]]), { from: pick.id, to: LEAF.id, inputs: { weight: 0 } })
    expect(plan(result).notes.some((n) => n.level === 'warning' && n.message.includes('never picked'))).toBe(true)
  })

  it('refuses a weight the engine refuses', () => {
    const refused = refusal(planConnection(withWeights([]), { from: pick.id, to: LEAF.id, inputs: { weight: -1 } }))
    expect(refused.code).toBe('params-malformed')
    expect(refused.reason).toContain('zero or more')
  })
})

describe('a conditional list ASKS for a condition, and keeps "none" different from "always true"', () => {
  const list = node('example:when', 'minecraft:conditional_list')

  it('asks, and says why neither answer can be assumed', () => {
    const question = ask(planConnection(graphOf([list, LEAF]), { from: list.id, to: LEAF.id }))
    expect(question.questions.map((q) => q.input)).toEqual(['condition'])
    expect(question.summary).toContain('always eligible')
    expect(previewConnection(graphOf([list, LEAF]), list.id, LEAF.id).asks).toEqual(['condition'])
  })

  it('writes NO condition key for "always", rather than a constant that is always true', () => {
    // The graph contract models an absent condition as absent rather than as a synthesised
    // "1.0", precisely so an editor can tell the two apart. Writing the constant here would throw
    // away the only thing that distinction was preserved for.
    const set = onlySet(planConnection(graphOf([list, LEAF]), { from: list.id, to: LEAF.id, inputs: { condition: { kind: 'always' } } }))
    expect(set.value).toEqual([{ places_feature: LEAF.id }])
    expect(JSON.stringify(set.value)).not.toContain('condition')
    expect(JSON.stringify(set.value)).not.toContain('1.0')
  })

  it('writes the expression exactly as given for a real condition', () => {
    const expression = 'query.get_biome_has_any_tag(\'swamp\')'
    const graph = graphOf(
      [list, LEAF, LEAF_TWO],
      [
        edge({
          from: list.id,
          to: LEAF_TWO.id,
          kind: 'conditional',
          jsonPath: '$.minecraft:conditional_list.conditional_features[0].places_feature',
        }),
      ],
    )
    const set = onlySet(planConnection(graph, { from: list.id, to: LEAF.id, inputs: { condition: { kind: 'molang', expression } } }))
    expect(set.path).toBe('$.minecraft:conditional_list.conditional_features[1]')
    expect(set.value).toEqual({ places_feature: LEAF.id, condition: expression })
  })

  it('refuses an empty expression rather than reading it as "always"', () => {
    const refused = refusal(
      planConnection(graphOf([list, LEAF]), { from: list.id, to: LEAF.id, inputs: { condition: { kind: 'molang', expression: '   ' } } }),
    )
    expect(refused.code).toBe('params-malformed')
    expect(refused.reason).toContain('different things')
  })

  it('carries what the expression\'s own text proves, without refusing over it', () => {
    // A condition reading a name the catalogue has never heard of is worth saying and is not
    // worth blocking: the catalogue can be behind, and refusing would leave the author no way
    // through from inside the editor.
    const result = planConnection(graphOf([list, LEAF]), {
      from: list.id,
      to: LEAF.id,
      inputs: { condition: { kind: 'molang', expression: 'query.not_a_real_query' } },
    })
    expect(result.outcome).toBe('plan')
    expect(plan(result).notes.length).toBeGreaterThan(0)
  })
})

describe('a tree ASKS which trunk carries the decoration', () => {
  const decoration = node('example:vines', 'minecraft:multiface_feature')

  it('asks when the tree is written with both trunk shapes', () => {
    const tree = node('example:oak', 'minecraft:tree_feature', {
      fields: { fallen_trunk: { trunk_block: 'minecraft:oak_log' }, poplar_trunk: { trunk_block: 'minecraft:oak_log' } },
    })
    const question = ask(planConnection(graphOf([tree, decoration]), { from: tree.id, to: decoration.id }))
    const slot = question.questions[0]!
    expect(slot.input).toBe('slot')
    if (slot.input !== 'slot') throw new Error('unreachable')
    expect(slot.options.map((o) => o.slot)).toEqual(['fallen_trunk.log_decoration_feature', 'poplar_trunk.log_decoration_feature'])
  })

  it('takes the one slot the tree actually has without asking', () => {
    const tree = node('example:oak', 'minecraft:tree_feature', { fields: { poplar_trunk: { trunk_block: 'minecraft:oak_log' } } })
    const set = onlySet(planConnection(graphOf([tree, decoration]), { from: tree.id, to: decoration.id }))
    expect(set.path).toBe('$.minecraft:tree_feature.poplar_trunk.log_decoration_feature')
  })

  it('writes into the slot the answer names', () => {
    const tree = node('example:oak', 'minecraft:tree_feature', {
      fields: { fallen_trunk: { trunk_block: 'minecraft:oak_log' }, poplar_trunk: { trunk_block: 'minecraft:oak_log' } },
    })
    const set = onlySet(
      planConnection(graphOf([tree, decoration]), {
        from: tree.id,
        to: decoration.id,
        inputs: { slot: 'fallen_trunk.log_decoration_feature' },
      }),
    )
    expect(set.path).toBe('$.minecraft:tree_feature.fallen_trunk.log_decoration_feature')
  })

  it('matches an existing decoration to ITS OWN trunk rather than to the first one it sees', () => {
    const tree = node('example:oak', 'minecraft:tree_feature', {
      fields: { fallen_trunk: { trunk_block: 'minecraft:oak_log' }, poplar_trunk: { trunk_block: 'minecraft:oak_log' } },
    })
    const graph = graphOf(
      [tree, decoration, LEAF],
      [
        edge({
          from: tree.id,
          to: LEAF.id,
          kind: 'child',
          jsonPath: '$.minecraft:tree_feature.poplar_trunk.log_decoration_feature',
        }),
      ],
    )
    const question = ask(planConnection(graph, { from: tree.id, to: decoration.id }))
    const slot = question.questions[0]!
    if (slot.input !== 'slot') throw new Error('unreachable')
    expect(slot.options.map((o) => o.occupiedBy)).toEqual([undefined, LEAF.id])
  })

  it('refuses a tree that has neither trunk shape, and says what to do about it', () => {
    const tree = node('example:oak', 'minecraft:tree_feature', { fields: { acacia_trunk: { trunk_width: 1 } } })
    const refused = refusal(planConnection(graphOf([tree, decoration]), { from: tree.id, to: decoration.id }))
    expect(refused.code).toBe('no-delegation')
    expect(refused.reason).toContain('fallen_trunk')
    expect(refused.reason).toContain('poplar_trunk')
  })

  it('refuses a slot that is not one of the tree\'s', () => {
    const tree = node('example:oak', 'minecraft:tree_feature', {
      fields: { fallen_trunk: {}, poplar_trunk: {} },
    })
    expect(
      refusal(planConnection(graphOf([tree, decoration]), { from: tree.id, to: decoration.id, inputs: { slot: 'mega_trunk.x' } })).code,
    ).toBe('params-malformed')
  })
})

// ---------------------------------------------------------------------------
// 5. Refusals
// ---------------------------------------------------------------------------

describe('what a connection refuses, and what it says', () => {
  it('refuses a source whose type holds no other feature, and names the type', () => {
    const refused = refusal(planConnection(graphOf([LEAF, LEAF_TWO]), { from: LEAF.id, to: LEAF_TWO.id }))
    expect(refused.code).toBe('no-delegation')
    expect(refused.reason).toContain('single_block_feature')
    // And it says what to do instead, which is the difference between a refusal and a wall.
    expect(refused.reason).toContain('wrap it')
    // The type name is written without its namespace, because every type has the same one.
    expect(refused.reason).not.toContain('minecraft:single_block_feature')
  })

  it('admits a type it has no answer for, in different words from a type that holds nothing', () => {
    const unknown = node('example:mystery', 'minecraft:some_future_feature')
    const refused = refusal(planConnection(graphOf([unknown, LEAF]), { from: unknown.id, to: LEAF.id }))
    expect(refused.code).toBe('unknown-type')
    expect(refused.reason).toContain('does not know')
  })

  it('answers about the SOURCE before it answers about the target', () => {
    // Dropping a block feature on a rule is wrong twice over. "This type places blocks itself" is
    // the half the author can act on; "nothing can delegate to a rule" answers a question they
    // did not ask.
    const rule = node('example:r.fr', 'minecraft:feature_rule', { file: 'feature_rules/r.json' })
    expect(refusal(planConnection(graphOf([LEAF, rule]), { from: LEAF.id, to: rule.id })).code).toBe('no-delegation')
  })

  it('refuses a rule as a TARGET -- nothing in the format delegates to one', () => {
    const rule = node('example:r.fr', 'minecraft:feature_rule', { file: 'feature_rules/r.json' })
    const scatter = node('example:scatter', 'minecraft:scatter_feature')
    const refused = refusal(planConnection(graphOf([scatter, rule]), { from: scatter.id, to: rule.id }))
    expect(refused.code).toBe('node-is-rule')
    expect(refused.reason).toContain('where a chain starts')
  })

  it('refuses a target nothing defines, and ALLOWS one the game provides', () => {
    const scatter = node('example:scatter', 'minecraft:scatter_feature')
    const broken: ConnectGraphNode = { id: 'example:typo', unresolved: true }
    const provided: ConnectGraphNode = { id: 'minecraft:bush_feature', unresolved: true, external: true }
    expect(refusal(planConnection(graphOf([scatter, broken]), { from: scatter.id, to: broken.id })).code).toBe('unresolved-node')

    const result = planConnection(graphOf([scatter, provided]), { from: scatter.id, to: provided.id })
    expect(result.outcome).toBe('plan')
    const note = plan(result).notes.find((n) => n.message.includes('provided by the game'))
    expect(note?.level).toBe('info')
    // The honest thing about it, and the only thing: it works, and nothing shows up in a preview.
    expect(note!.message).toContain('resolves when the world generates')
    expect(note!.message).toContain('preview')
  })

  it('refuses a feature placing itself', () => {
    const aggregate = node('example:both', 'minecraft:aggregate_feature')
    const refused = refusal(planConnection(graphOf([aggregate]), { from: aggregate.id, to: aggregate.id }))
    expect(refused.code).toBe('cycle')
    expect(refused.reason).toContain('recursion guard')
  })

  it('ALLOWS a connection that closes a longer loop, and warns that it does', () => {
    // Loops are legal -- the contract says so and the engine guards recursion at run time -- so
    // this is a warning, not a refusal. Refusing would make the editor stricter than the game.
    const a = node('example:a', 'minecraft:aggregate_feature')
    const b = node('example:b', 'minecraft:aggregate_feature')
    const graph = graphOf([a, b], [edge({ from: b.id, to: a.id, kind: 'aggregate', jsonPath: '$.minecraft:aggregate_feature.features[0]' })])
    const result = planConnection(graph, { from: a.id, to: b.id })
    expect(result.outcome).toBe('plan')
    expect(plan(result).notes.some((n) => n.level === 'warning' && n.message.includes('closes a loop'))).toBe(true)
  })

  it('refuses a source with nowhere to write', () => {
    const noFile = node('example:nofile', 'minecraft:scatter_feature', { file: '' })
    expect(refusal(planConnection(graphOf([noFile, LEAF]), { from: noFile.id, to: LEAF.id })).code).toBe('unresolved-node')
  })

  it('refuses a node that is not in the graph, on either end', () => {
    const scatter = node('example:scatter', 'minecraft:scatter_feature')
    expect(refusal(planConnection(graphOf([scatter]), { from: 'example:ghost', to: scatter.id })).code).toBe('unknown-node')
    expect(refusal(planConnection(graphOf([scatter]), { from: scatter.id, to: 'example:ghost' })).code).toBe('unknown-node')
  })
})

describe('the drag-time preview says the same thing the drop will', () => {
  const cases: Array<[string, ConnectGraph, string, string]> = (() => {
    const scatter = node('example:scatter', 'minecraft:scatter_feature')
    const pick = node('example:pick', 'minecraft:weighted_random_feature')
    const rule = node('example:r.fr', 'minecraft:feature_rule', { file: 'feature_rules/r.json' })
    return [
      ['a plain plan', graphOf([scatter, LEAF]), scatter.id, LEAF.id],
      ['a question', graphOf([pick, LEAF]), pick.id, LEAF.id],
      ['a refusal about the target', graphOf([scatter, rule]), scatter.id, rule.id],
      ['a refusal about the source', graphOf([LEAF, LEAF_TWO]), LEAF.id, LEAF_TWO.id],
    ]
  })()

  it.each(cases)('agrees with planConnection about %s', (_name, graph, from, to) => {
    // A preview drawn from different reasoning than the apply is a preview that lies at exactly
    // the moment it matters -- while the button is still down.
    const preview = previewConnection(graph, from, to)
    const result = planConnection(graph, { from, to })
    expect(preview.allowed).toBe(result.outcome !== 'refuse')
    expect(preview.detail.length).toBeGreaterThan(20)
    expect(preview.label.length).toBeGreaterThan(0)
    if (result.outcome === 'refuse') expect(preview.detail).toBe(result.refusal.reason)
    if (result.outcome === 'ask') expect(preview.asks.length).toBeGreaterThan(0)
  })

  it('answers about a source without being handed a target', () => {
    const sequence = node('example:then', 'minecraft:sequence_feature')
    const graph = graphOf([sequence, LEAF])
    expect(connectSourcePreview(graph, sequence.id)).toMatchObject({ allowed: true, kind: 'sequence' })
    expect(connectSourcePreview(graph, LEAF.id).allowed).toBe(false)
    expect(connectSourcePreview(graph, 'example:ghost').allowed).toBe(false)
    // Asked of a tree with two slots, it says a question is coming.
    const tree = node('example:oak', 'minecraft:tree_feature', { fields: { fallen_trunk: {}, poplar_trunk: {} } })
    expect(connectSourcePreview(graphOf([tree]), tree.id).asks).toEqual(['slot'])
  })
})

// ---------------------------------------------------------------------------
// 6. The words
// ---------------------------------------------------------------------------

describe('every sentence a user can see', () => {
  /** Everything this module can say, gathered by running it over every shape it handles. */
  function everySentence(): string[] {
    const out: string[] = []
    const collect = (result: ConnectResult): void => {
      if (result.outcome === 'refuse') {
        out.push(result.refusal.reason)
        return
      }
      if (result.outcome === 'ask') {
        out.push(result.ask.title, result.ask.summary)
        for (const question of result.ask.questions) {
          out.push(question.prompt, question.detail)
          if (question.input === 'slot') for (const option of question.options) out.push(option.label, option.doc)
        }
        return
      }
      out.push(result.plan.title, result.plan.summary)
      for (const note of result.plan.notes) out.push(note.message)
    }

    const targets = [LEAF, { id: 'minecraft:bush_feature', unresolved: true, external: true } as ConnectGraphNode]
    for (const typeId of [...connectableTypeIds(), ...childlessTypeIds(), 'minecraft:not_a_type']) {
      const source = node('example:source', typeId, {
        fields: { fallen_trunk: { trunk_block: 'example:log' }, poplar_trunk: { trunk_block: 'example:log' } },
        ...(typeId === 'minecraft:feature_rule' ? { file: 'feature_rules/source.json' } : {}),
      })
      for (const target of targets) {
        const graph = graphOf([source, target])
        collect(planConnection(graph, { from: source.id, to: target.id }))
        collect(planConnection(graph, { from: source.id, to: target.id, inputs: { weight: 2 } }))
        collect(planConnection(graph, { from: source.id, to: target.id, inputs: { weight: 0 } }))
        collect(planConnection(graph, { from: source.id, to: target.id, inputs: { condition: { kind: 'always' } } }))
        collect(planConnection(graph, { from: source.id, to: target.id, inputs: { condition: { kind: 'molang', expression: 'query.is_hot' } } }))
        collect(planConnection(graph, { from: source.id, to: target.id, inputs: { slot: 'poplar_trunk.log_decoration_feature' } }))
        collect(planConnection(graph, { from: source.id, to: target.id, inputs: { index: -3 } }))
        out.push(connectSourcePreview(graph, source.id).detail, previewConnection(graph, source.id, target.id).detail)
      }
    }
    return out.filter((s) => s.length > 0)
  }

  it('says what the engine does, and never how that was established', () => {
    // The one hard rule on a user-visible string here. A pack author reading a tooltip needs to
    // know what the game will do with their file; where any of it was worked out is not theirs to
    // carry, and a leaked file name or tool name in a tooltip is a leak that ships.
    const forbidden = [/\.go\b/i, /\bgraphbuild\b/i, /\bgraphcheck\b/i, /\bwire\b/i, /\bfeaturelab\b/i, /\bvscode\b/i, /\bts\b\./i, /0x[0-9a-f]{4,}/i]
    const offenders: string[] = []
    for (const sentence of everySentence()) {
      for (const pattern of forbidden) if (pattern.test(sentence)) offenders.push(`${pattern} in: ${sentence}`)
    }
    expect(offenders).toEqual([])
  })

  it('is made of whole sentences, not code names with the underscores taken out', () => {
    const offenders: string[] = []
    for (const sentence of everySentence()) {
      // A prompt is allowed to be two words ("Weight", "Place it under"); a reason, summary or
      // note is not, and those are what this is guarding.
      if (sentence.length < 4) offenders.push(`too short: ${sentence}`)
      if (/^[a-z-]+$/.test(sentence)) offenders.push(`a code name, not a sentence: ${sentence}`)
    }
    expect(offenders).toEqual([])
  })

  it('never invents a namespace that is not the game\'s or the fixture\'s', () => {
    const offenders = everySentence().filter((s) => {
      const namespaces = [...s.matchAll(/\b([a-z][a-z0-9_]*):[a-z][a-z0-9_]*/g)].map((m) => m[1]!)
      return namespaces.some((ns) => ns !== 'minecraft' && ns !== 'example')
    })
    expect(offenders).toEqual([])
  })
})
