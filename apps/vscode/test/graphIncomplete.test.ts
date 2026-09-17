// graphIncomplete.test.ts -- the placeholder ghost, and what replaces it.
//
// The reported symptom, from someone building a pack from scratch: create a feature rule and a
// dangling `example:replace_me` appears far down the canvas; then create a column compound and it
// arrives joined to THAT SAME dangling node. Two unrelated things, made seconds apart, drawn as
// if one delegated to the other.
//
// The cause is that the placeholder is one shared constant, so every unfinished thing resolves to
// one node. The fix is not a unique placeholder per node -- that splits one piece of clutter into
// several -- but drawing no ghost at all and saying on the node that something is missing.
//
// What these tests are careful about is the line between "this editor wrote a stand-in" and "the
// author typed a name for something that does not exist yet". Only the first is hidden. Hiding
// the second would turn a real broken reference into silence.
import { describe, expect, it } from 'vitest'
import {
  describeMissing,
  isPlaceholderRef,
  viewWithoutPlaceholders,
  type IncompleteGraph,
} from '../src/graph/incomplete.js'
import { PLACEHOLDER_FEATURE } from '../src/graph/compounds/spec.js'

function graph(over: Partial<IncompleteGraph> = {}): IncompleteGraph {
  return { nodes: [], edges: [], ...over }
}

const ruleEdge = (from: string, to: string) => ({
  from,
  to,
  kind: 'rule',
  jsonPath: '$.minecraft:feature_rules.description.places_feature',
  required: true,
})

describe('the shared placeholder is not drawn', () => {
  it('drops the ghost and the edges into it, and reports who was waiting', () => {
    const g = graph({
      nodes: [
        { id: 'ik:rule_a', typeId: 'minecraft:feature_rule' },
        { id: 'ik:rule_b', typeId: 'minecraft:feature_rule' },
        { id: PLACEHOLDER_FEATURE, unresolved: true },
      ],
      edges: [ruleEdge('ik:rule_a', PLACEHOLDER_FEATURE), ruleEdge('ik:rule_b', PLACEHOLDER_FEATURE)],
    })
    const view = viewWithoutPlaceholders(g)

    expect(view.graph.nodes.map((n) => n.id)).toEqual(['ik:rule_a', 'ik:rule_b'])
    expect(view.graph.edges).toEqual([])
    // The exact reported symptom: the two rules must not be joined to one another through a
    // shared ghost, and neither may keep an edge to nowhere.
    expect(view.missing.get('ik:rule_a')).toHaveLength(1)
    expect(view.missing.get('ik:rule_b')).toHaveLength(1)
  })

  it('carries the path the chosen feature has to be written to', () => {
    const g = graph({
      nodes: [{ id: 'ik:rule_a', typeId: 'minecraft:feature_rule' }, { id: PLACEHOLDER_FEATURE, unresolved: true }],
      edges: [ruleEdge('ik:rule_a', PLACEHOLDER_FEATURE)],
    })
    // Attaching a feature is one edit at this path; a badge that could not say where to write
    // would be a label rather than an affordance.
    expect(view(g).missing.get('ik:rule_a')?.[0]?.jsonPath).toBe(
      '$.minecraft:feature_rules.description.places_feature',
    )
  })

  it('leaves a reference the AUTHOR typed exactly as it was', () => {
    // The whole point of restricting this to the sentinel. `ik:not_written_yet` is somebody's
    // plan, or somebody's typo; either way it is a real dangling reference and the canvas has
    // always drawn those, deliberately, so a broken link is visible.
    const g = graph({
      nodes: [{ id: 'ik:rule_a', typeId: 'minecraft:feature_rule' }, { id: 'ik:not_written_yet', unresolved: true }],
      edges: [ruleEdge('ik:rule_a', 'ik:not_written_yet')],
    })
    const view = viewWithoutPlaceholders(g)
    expect(view.graph.nodes.map((n) => n.id)).toContain('ik:not_written_yet')
    expect(view.graph.edges).toHaveLength(1)
    expect(view.missing.size).toBe(0)
  })

  it('stops hiding it the moment the pack actually defines a feature by that name', () => {
    // A pack is allowed to contain `example:replace_me` for real. Then it is not a stand-in, it
    // is somebody's feature, and hiding their node would be this editor deciding it does not
    // exist.
    const g = graph({
      nodes: [
        { id: 'ik:rule_a', typeId: 'minecraft:feature_rule' },
        { id: PLACEHOLDER_FEATURE, typeId: 'minecraft:single_block_feature' },
      ],
      edges: [ruleEdge('ik:rule_a', PLACEHOLDER_FEATURE)],
    })
    const view = viewWithoutPlaceholders(g)
    expect(view.graph.nodes.map((n) => n.id)).toContain(PLACEHOLDER_FEATURE)
    expect(view.graph.edges).toHaveLength(1)
    expect(view.missing.size).toBe(0)
  })

  it('matches the sentinel without regard to case, the way the registry keys identifiers', () => {
    expect(isPlaceholderRef(PLACEHOLDER_FEATURE)).toBe(true)
    expect(isPlaceholderRef(PLACEHOLDER_FEATURE.toUpperCase())).toBe(true)
    expect(isPlaceholderRef('ik:something')).toBe(false)
  })

  it('does not disturb a graph that has no placeholder in it', () => {
    const g = graph({
      nodes: [{ id: 'ik:rule_a', typeId: 'minecraft:feature_rule' }, { id: 'ik:leaf', typeId: 'minecraft:single_block_feature' }],
      edges: [ruleEdge('ik:rule_a', 'ik:leaf')],
    })
    const view = viewWithoutPlaceholders(g)
    expect(view.graph.nodes).toHaveLength(2)
    expect(view.graph.edges).toHaveLength(1)
    expect(view.missing.size).toBe(0)
  })
})

describe('what the badge says', () => {
  it('says what to do next rather than what is wrong', () => {
    const said = describeMissing([{ nodeId: 'a', jsonPath: '$.x', label: '', doc: '' }])
    expect(said).toBe('Needs a feature to place')
    // "Unresolved reference" describes the file. This describes the next click.
    expect(said?.toLowerCase()).not.toMatch(/unresolved|dangling|broken|error/)
  })

  it('names the slot only when there is more than one to tell apart', () => {
    expect(describeMissing([{ nodeId: 'a', jsonPath: '$.x', label: 'acacia_trunk.decoration', doc: '' }])).toBe(
      'Needs a feature for acacia_trunk.decoration',
    )
    expect(
      describeMissing([
        { nodeId: 'a', jsonPath: '$.x', label: 'one', doc: '' },
        { nodeId: 'a', jsonPath: '$.y', label: 'two', doc: '' },
      ]),
    ).toBe('Needs 2 features')
  })

  it('says nothing when nothing is missing', () => {
    expect(describeMissing([])).toBeNull()
  })
})

function view(g: IncompleteGraph) {
  return viewWithoutPlaceholders(g)
}
