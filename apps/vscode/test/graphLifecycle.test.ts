// graphLifecycle.test.ts -- renaming a feature and deleting one, and above all the things both
// must REFUSE to do.
//
// The failure these operations exist to prevent is not "nothing happened". It is a pack left in a
// state nobody put it in: a feature renamed in its own file and nowhere else, so every delegation
// to it now resolves to nothing; or a feature deleted out from under three files the author was
// not looking at. Both are silent -- the engine does not report a reference that resolves to
// nothing as an error against the file that wrote it -- so the suite asserts on the REFUSAL and
// on the absence of a plan, not merely on an error being thrown.
//
// Every structural assumption these planners make has a test here that violating it refuses:
// that a delegation's reported path indexes the entry its ordinal says it does, that an array the
// engine requires to be non-empty keeps an entry. The identifiers are all `example:`, and the
// type ids, key names and list shapes are the real ones, so a contract that moves fails here
// rather than passing quietly.
//
// ONE OF THOSE REFUSALS IS NOW A RETARGET, and the tests say so where the old ones said refuse.
// A delegation the referring type cannot load without is pointed at PLACEHOLDER_FEATURE rather
// than removed: the file still loads, and graph/incomplete.ts turns that reference into "needs a
// feature" on the node itself. The property being pinned did not change -- no plan ever leaves a
// file that will not load, and no plan ever leaves a reference to a name nothing defines -- only
// which of the three fates a reference gets in order to keep it.
import { describe, expect, it } from 'vitest'
import {
  deleteFeature,
  foldIdentifier,
  lifecycleOffers,
  renameFeature,
  type LifecycleOperation,
  type LifecyclePlan,
  type LifecycleRefusal,
  type LifecycleResult,
} from '../src/graph/lifecycle.js'
import type { IdiomGraph, IdiomGraphEdge, IdiomGraphNode } from '../src/graph/idioms.js'
import { PLACEHOLDER_FEATURE } from '../src/graph/compounds/spec.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VERSION = '1.21.110'
const AGGREGATE = 'minecraft:aggregate_feature'
const SINGLE = 'minecraft:single_block_feature'
const SCATTER = 'minecraft:scatter_feature'
const WEIGHTED = 'minecraft:weighted_random_feature'
const CONDITIONAL = 'minecraft:conditional_list'
const RULE = 'minecraft:feature_rule'

function node(id: string, typeId: string, file: string, extra: Partial<IdiomGraphNode> = {}): IdiomGraphNode {
  return { id, typeId, file, formatVersion: VERSION, ...extra }
}

function listEdge(from: string, bodyKey: string, key: string, to: string, ordinal: number, kind: string, extra: Partial<IdiomGraphEdge> = {}): IdiomGraphEdge {
  return { from, to, kind, ordinal, jsonPath: `$.${bodyKey}.${key}[${ordinal}]`, ...extra }
}

function slotEdge(from: string, bodyKey: string, key: string, to: string, kind: string, extra: Partial<IdiomGraphEdge> = {}): IdiomGraphEdge {
  return { from, to, kind, ordinal: 0, jsonPath: `$.${bodyKey}.${key}`, ...extra }
}

/** The smallest pack that has both shapes worth testing: a rule into an aggregate of two, and a
 * scatter (whose delegation the type cannot load without) over one of them. */
function samplePack(): IdiomGraph {
  const nodes: IdiomGraphNode[] = [
    node('example:patch_rule', RULE, 'feature_rules/patch_rule.json'),
    node('example:patch', AGGREGATE, 'features/patch.json'),
    node('example:oak', SINGLE, 'features/oak.json'),
    node('example:fern', SINGLE, 'features/fern.json'),
    node('example:scattered', SCATTER, 'features/scattered.json'),
    node('example:stone', SINGLE, 'features/stone.json'),
  ]
  const edges: IdiomGraphEdge[] = [
    slotEdge('example:patch_rule', 'minecraft:feature_rules', 'description.places_feature', 'example:patch', 'rule', { required: true }),
    listEdge('example:patch', AGGREGATE, 'features', 'example:oak', 0, 'aggregate'),
    listEdge('example:patch', AGGREGATE, 'features', 'example:fern', 1, 'aggregate'),
    slotEdge('example:scattered', SCATTER, 'places_feature', 'example:stone', 'scatter', { required: true }),
  ]
  return { nodes, edges, roots: ['example:patch_rule', 'example:scattered'] }
}

function plan(result: LifecycleResult): LifecyclePlan {
  if (!result.ok) throw new Error(`expected a plan, got a refusal: ${result.refusal.code} -- ${result.refusal.reason}`)
  return result.plan
}

function refusal(result: LifecycleResult): LifecycleRefusal {
  if (result.ok) throw new Error(`expected a refusal, got a plan: ${result.plan.title}`)
  return result.refusal
}

function sets(operations: readonly LifecycleOperation[]): { file: string; path: string; value: unknown }[] {
  return operations.filter((op): op is Extract<LifecycleOperation, { op: 'set' }> => op.op === 'set').map(({ file, path, value }) => ({ file, path, value }))
}

function deletes(operations: readonly LifecycleOperation[]): { file: string; path: string }[] {
  return operations.filter((op): op is Extract<LifecycleOperation, { op: 'delete' }> => op.op === 'delete').map(({ file, path }) => ({ file, path }))
}

function deletedFiles(operations: readonly LifecycleOperation[]): string[] {
  return operations.filter((op): op is Extract<LifecycleOperation, { op: 'deleteFile' }> => op.op === 'deleteFile').map((op) => op.file)
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

describe('renameFeature', () => {
  // The whole point: a name lives in its own file AND in every file that delegates to it. Both
  // move, or the pack is left pointing at a name nothing defines.
  it('rewrites the declaration and every delegation that resolves to it', () => {
    const p = plan(renameFeature(samplePack(), { target: 'example:oak', newId: 'example:oak_log' }))
    expect(sets(p.operations)).toEqual([
      { file: 'features/oak.json', path: `$.${SINGLE}.description.identifier`, value: 'example:oak_log' },
      { file: 'features/patch.json', path: `$.${AGGREGATE}.features[0]`, value: 'example:oak_log' },
    ])
    expect(p.files).toEqual(['features/oak.json', 'features/patch.json'])
    expect(p.subject).toBe('example:oak')
    expect(p.request).toEqual({ method: 'renameFeature', params: { from: 'example:oak', to: 'example:oak_log' } })
  })

  // The file is not renamed, and no test-passing accident should let that change quietly: the
  // engine reads the identifier out of the file and derives nothing from the file's name, while
  // renaming the file invalidates whatever the author has open.
  it('never plans a file rename, and says the file keeps its name', () => {
    const p = plan(renameFeature(samplePack(), { target: 'example:oak', newId: 'example:oak_log' }))
    expect(p.operations.some((op) => op.op === 'createFile' || op.op === 'deleteFile')).toBe(false)
    expect(p.notes.map((n) => n.message).join(' ')).toContain('features/oak.json still holds it')
  })

  // A feature rule is the one node whose FILE NAME the engine looks at: it compares the
  // identifier's name half against the file's own name and logs when they differ. The rule still
  // loads and runs, so this is a note rather than a refusal -- but an author who is not told meets
  // it in the log later.
  it('warns that a renamed rule will no longer match its file name', () => {
    const p = plan(renameFeature(samplePack(), { target: 'example:patch_rule', newId: 'example:meadow_rule' }))
    expect(sets(p.operations)).toEqual([
      { file: 'feature_rules/patch_rule.json', path: '$.minecraft:feature_rules.description.identifier', value: 'example:meadow_rule' },
    ])
    expect(p.notes.map((n) => n.message).join(' ')).toContain('file name')
    // It names the file to rename to, because "these differ" without the answer is a puzzle.
    expect(p.notes.map((n) => n.message).join(' ')).toContain('feature_rules/meadow_rule.json')
  })

  // The other direction, which the note used to get wrong by firing on every rule rename: a rename
  // INTO agreement warns about nothing. A warning that is always there is one nobody reads, and
  // this one would have been attached to the rename that fixes the problem it describes.
  it('says nothing about the file name when the new name matches the file', () => {
    const p = plan(renameFeature(samplePack(), { target: 'example:patch_rule', newId: 'example:patch_rule_2' }))
    expect(p.notes.map((n) => n.message).join(' ')).toContain('file name')
    const matching = plan(renameFeature(samplePack(), { target: 'example:patch_rule', newId: 'other:patch_rule' }))
    expect(matching.notes.map((n) => n.message).join(' ')).not.toContain('file name')
  })

  // The rule's body key is the PLURAL collection key, while its node carries the singular
  // synthetic type. Writing the identifier under the node's type id would address a key the file
  // does not have.
  it('addresses a rule\'s identifier under the key its file is actually rooted at', () => {
    const graph: IdiomGraph = { nodes: [node('example:lonely_rule', RULE, 'feature_rules/lonely.json')], edges: [] }
    const p = plan(renameFeature(graph, { target: 'example:lonely_rule', newId: 'example:other_rule' }))
    expect(sets(p.operations)[0]!.path).toBe('$.minecraft:feature_rules.description.identifier')
  })

  it('refuses a name that is not "namespace:name"', () => {
    for (const newId of ['oak_log', 'example:', ':oak', 'example:oak:log', 'example:oak log']) {
      const r = renameFeature(samplePack(), { target: 'example:oak', newId })
      expect(refusal(r).code).toBe('id-malformed')
    }
  })

  it('refuses a name another file already declares, and names that file', () => {
    const r = refusal(renameFeature(samplePack(), { target: 'example:oak', newId: 'example:fern' }))
    expect(r.code).toBe('id-exists')
    expect(r.reason).toContain('features/fern.json')
  })

  // The dangerous collision. Two identifiers that differ only in case are ONE name to the engine:
  // the first file loaded keeps it and the other feature silently stops being placed. So this is
  // not a free name, however different it looks in a file listing.
  it('refuses a name that differs from another feature\'s only in case', () => {
    const r = refusal(renameFeature(samplePack(), { target: 'example:oak', newId: 'example:FERN' }))
    expect(r.code).toBe('id-exists')
    expect(r.reason).toContain('without regard to case')
    expect(r.nodes).toContain('example:fern')
  })

  // The other side of that coin. Re-spelling a feature's OWN name changes nothing the pack
  // generates -- which is exactly why an author does it -- and every reference moves with it so
  // the pack stops spelling one name two ways.
  it('allows re-spelling a feature\'s own name in another case, and says it changes nothing', () => {
    const graph = samplePack()
    const p = plan(renameFeature(graph, { target: 'example:oak', newId: 'example:Oak' }))
    expect(sets(p.operations)).toHaveLength(2)
    expect(p.notes.some((n) => n.message.includes('same name to the engine'))).toBe(true)
  })

  it('refuses renaming a feature to the name it already has', () => {
    expect(refusal(renameFeature(samplePack(), { target: 'example:oak', newId: 'example:oak' })).code).toBe('id-unchanged')
  })

  // A dangling reference is in the graph -- that is what the contract's Unresolved node is for --
  // and renaming INTO its name is not a collision: no file declares it. It repairs those
  // references, which is usually the point and is never left unsaid.
  it('adopts a dangling reference\'s name, and says how many references it just repaired', () => {
    const graph = samplePack()
    const withDangling: IdiomGraph = {
      nodes: [...graph.nodes, { id: 'example:missing', unresolved: true }],
      edges: [...graph.edges, listEdge('example:patch', AGGREGATE, 'features', 'example:missing', 2, 'aggregate')],
    }
    const p = plan(renameFeature(withDangling, { target: 'example:oak', newId: 'example:missing' }))
    expect(p.notes.some((n) => n.message.includes('currently resolve to nothing'))).toBe(true)
  })

  // A path whose list index disagrees with the delegation's own ordinal addresses a DIFFERENT
  // entry. Rewriting it would retarget somebody else's delegation, and the path still resolves, so
  // nothing would report it. The whole rename refuses rather than writing the half it is sure of.
  it('refuses when a delegation\'s reported path does not index the entry its ordinal claims', () => {
    const graph = samplePack()
    const broken: IdiomGraph = {
      nodes: graph.nodes,
      edges: graph.edges.map((e) =>
        e.to === 'example:oak' ? { ...e, jsonPath: `$.${AGGREGATE}.features[7]` } : e,
      ),
    }
    const r = refusal(renameFeature(broken, { target: 'example:oak', newId: 'example:oak_log' }))
    expect(r.code).toBe('path-shape')
  })

  it('refuses a feature this graph does not define', () => {
    expect(refusal(renameFeature(samplePack(), { target: 'example:nope', newId: 'example:x' })).code).toBe('unknown-node')
    const dangling: IdiomGraph = { nodes: [{ id: 'example:missing', unresolved: true }], edges: [] }
    expect(refusal(renameFeature(dangling, { target: 'example:missing', newId: 'example:x' })).code).toBe('unresolved-node')
  })

  // A feature that delegates to itself writes its own name inside its own file. That reference is
  // not a referrer to refuse over -- it is rewritten as part of the file already being rewritten.
  it('rewrites a self-reference along with the declaration', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:loop', AGGREGATE, 'features/loop.json')],
      edges: [listEdge('example:loop', AGGREGATE, 'features', 'example:loop', 0, 'aggregate')],
    }
    const p = plan(renameFeature(graph, { target: 'example:loop', newId: 'example:knot' }))
    expect(sets(p.operations)).toEqual([
      { file: 'features/loop.json', path: `$.${AGGREGATE}.description.identifier`, value: 'example:knot' },
      { file: 'features/loop.json', path: `$.${AGGREGATE}.features[0]`, value: 'example:knot' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('deleteFeature', () => {
  // The default, and most of the time the whole user-visible product: the refusal NAMES the
  // referrers, because the author's next move is to go and look at each one.
  it('refuses while something delegates to it, and names which files', () => {
    const r = refusal(deleteFeature(samplePack(), { target: 'example:oak' }))
    expect(r.code).toBe('referenced')
    expect(r.reason).toContain('example:patch')
    expect(r.reason).toContain('features/patch.json')
    expect(r.reason).toContain(`$.${AGGREGATE}.features[0]`)
  })

  it('removes the file outright when nothing delegates to it', () => {
    const graph: IdiomGraph = { nodes: [node('example:spare', SINGLE, 'features/spare.json')], edges: [] }
    const p = plan(deleteFeature(graph, { target: 'example:spare' }))
    expect(p.operations).toEqual([{ op: 'deleteFile', file: 'features/spare.json', identifier: 'example:spare' }])
    expect(p.request).toEqual({ method: 'deleteFeature', params: { id: 'example:spare', detachReferences: false, retarget: [] } })
    expect(p.retargeted).toEqual([])
  })

  // The opt-in path: the delegation goes out of the referring file, then the file goes. Both, or
  // the pack is left with a reference to a name nothing defines.
  it('removes the delegations along with the file when asked to', () => {
    const p = plan(deleteFeature(samplePack(), { target: 'example:oak', detachReferences: true }))
    expect(deletes(p.operations)).toEqual([{ file: 'features/patch.json', path: `$.${AGGREGATE}.features[0]` }])
    expect(deletedFiles(p.operations)).toEqual(['features/oak.json'])
    expect(p.request).toEqual({ method: 'deleteFeature', params: { id: 'example:oak', detachReferences: true, retarget: [] } })
    // An OPTIONAL delegation is removed, not stood in for. A key that is simply absent is not an
    // unfinished node, and writing a placeholder into a slot the type does not need would invent
    // work out of a deletion that finished cleanly.
    expect(p.retargeted).toEqual([])
    expect(sets(p.operations)).toEqual([])
  })

  // THE CASE THIS WHOLE CHANGE IS ABOUT. A scatter cannot load without its places_feature, so
  // removing the delegation does not detach the feature -- it breaks the file the delegation
  // lives in. That used to refuse the entire delete, which made the author's decision for them:
  // they still wanted the feature gone, and the parent still needed something to place.
  //
  // Now the reference is pointed at the placeholder. The parent keeps a valid file, keeps
  // loading, and graph/incomplete.ts draws it as a node that needs a feature -- so the open
  // question is marked where it will be met rather than described in a refusal read once.
  it('points a delegation the referring type cannot load without at the placeholder, instead of refusing', () => {
    const p = plan(deleteFeature(samplePack(), { target: 'example:stone', detachReferences: true }))
    expect(sets(p.operations)).toEqual([
      { file: 'features/scattered.json', path: `$.${SCATTER}.places_feature`, value: PLACEHOLDER_FEATURE },
    ])
    expect(deletedFiles(p.operations)).toEqual(['features/stone.json'])
    // Nothing is REMOVED from the referring file: the entry stays where it is, wearing a name
    // that means "not decided yet".
    expect(deletes(p.operations)).toEqual([])
    expect(p.retargeted).toEqual([
      { nodeId: 'example:scattered', file: 'features/scattered.json', path: `$.${SCATTER}.places_feature` },
    ])
  })

  // The plan is what the panel shows before anybody commits to it, so it has to name every file
  // it would touch -- including the ones it is only rewriting a reference in.
  it('names every file it touches, the retargeted ones included', () => {
    const p = plan(deleteFeature(samplePack(), { target: 'example:stone', detachReferences: true }))
    expect(p.files).toEqual(['features/scattered.json', 'features/stone.json'])
    expect(p.subject).toBe('example:stone')
    // And the request carries the retarget by NODE, not by path: the host is the only half that
    // turns a node into a file.
    expect(p.request).toEqual({
      method: 'deleteFeature',
      params: {
        id: 'example:stone',
        detachReferences: true,
        retarget: [{ nodeId: 'example:scattered', path: `$.${SCATTER}.places_feature` }],
      },
    })
  })

  // Both fates at once, which is the shape a real pack has: one parent that can live without the
  // feature and one that cannot. The first loses its entry; the second keeps it and is marked.
  it('removes the optional delegations and retargets the required ones in one plan', () => {
    const graph: IdiomGraph = {
      nodes: [
        node('example:patch', AGGREGATE, 'features/patch.json'),
        node('example:fern', SINGLE, 'features/fern.json'),
        node('example:scattered', SCATTER, 'features/scattered.json'),
        node('example:stone', SINGLE, 'features/stone.json'),
      ],
      edges: [
        listEdge('example:patch', AGGREGATE, 'features', 'example:stone', 0, 'aggregate'),
        listEdge('example:patch', AGGREGATE, 'features', 'example:fern', 1, 'aggregate'),
        slotEdge('example:scattered', SCATTER, 'places_feature', 'example:stone', 'scatter', { required: true }),
      ],
    }
    const p = plan(deleteFeature(graph, { target: 'example:stone', detachReferences: true }))
    expect(deletes(p.operations)).toEqual([{ file: 'features/patch.json', path: `$.${AGGREGATE}.features[0]` }])
    expect(sets(p.operations)).toEqual([
      { file: 'features/scattered.json', path: `$.${SCATTER}.places_feature`, value: PLACEHOLDER_FEATURE },
    ])
    expect(p.retargeted.map((slot) => slot.nodeId)).toEqual(['example:scattered'])
    expect(p.files).toEqual(['features/patch.json', 'features/scattered.json', 'features/stone.json'])
    // The author is told which node to come back to, by name. A count would leave them hunting.
    expect(p.notes.map((n) => n.message).join(' ')).toContain('example:scattered')
  })

  // The contract marks the sole entry of an aggregate required, because the array itself may not
  // be empty. Retargeting it keeps the array one entry long, so the list-emptying refusal must
  // not fire over an entry that is not being removed at all.
  it('retargets the only entry of a list rather than refusing that removing it would empty one', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:patch', AGGREGATE, 'features/patch.json'), node('example:oak', SINGLE, 'features/oak.json')],
      edges: [listEdge('example:patch', AGGREGATE, 'features', 'example:oak', 0, 'aggregate', { required: true })],
    }
    const p = plan(deleteFeature(graph, { target: 'example:oak', detachReferences: true }))
    expect(sets(p.operations)).toEqual([
      { file: 'features/patch.json', path: `$.${AGGREGATE}.features[0]`, value: PLACEHOLDER_FEATURE },
    ])
    expect(deletes(p.operations)).toEqual([])
  })

  // A required delegation whose reported path does not index the entry its ordinal claims is
  // refused, exactly as a removal of it would be: writing the placeholder through that path
  // would retarget somebody else's slot, and it would RESOLVE, so nothing would report it.
  it('refuses to retarget through a path whose list index does not match the ordinal', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:patch', AGGREGATE, 'features/patch.json'), node('example:oak', SINGLE, 'features/oak.json')],
      edges: [
        { from: 'example:patch', to: 'example:oak', kind: 'aggregate', ordinal: 0, jsonPath: `$.${AGGREGATE}.features[7]`, required: true },
      ],
    }
    expect(refusal(deleteFeature(graph, { target: 'example:oak', detachReferences: true })).code).toBe('path-shape')
  })

  // Two entries of one aggregate naming the same feature: neither is "the last one" on its own,
  // so neither is marked required, and removing both would leave a list the engine refuses to
  // load empty.
  it('refuses when detaching would empty a list the engine requires to be non-empty', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:patch', AGGREGATE, 'features/patch.json'), node('example:oak', SINGLE, 'features/oak.json')],
      edges: [
        listEdge('example:patch', AGGREGATE, 'features', 'example:oak', 0, 'aggregate'),
        listEdge('example:patch', AGGREGATE, 'features', 'example:oak', 1, 'aggregate'),
      ],
    }
    const r = refusal(deleteFeature(graph, { target: 'example:oak', detachReferences: true }))
    expect(r.code).toBe('would-empty-list')
    expect(r.reason).toContain('features/patch.json')
  })

  // A conditional_list is the exception: the key is required to be PRESENT and is accepted empty,
  // so emptying one is an edit rather than a breakage.
  it('allows emptying a conditional list, which the engine accepts empty', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:maybe', CONDITIONAL, 'features/maybe.json'), node('example:oak', SINGLE, 'features/oak.json')],
      edges: [
        {
          from: 'example:maybe',
          to: 'example:oak',
          kind: 'conditional',
          ordinal: 0,
          jsonPath: `$.${CONDITIONAL}.conditional_features[0].places_feature`,
        },
      ],
    }
    const p = plan(deleteFeature(graph, { target: 'example:oak', detachReferences: true }))
    // The ENTRY goes, not the reference: an entry stripped of its places_feature keeps a
    // condition and has nothing left to place.
    expect(deletes(p.operations)).toEqual([{ file: 'features/maybe.json', path: `$.${CONDITIONAL}.conditional_features[0]` }])
  })

  // Same rule for a weighted entry, where the reference is a slot inside the [feature, weight]
  // tuple: removing the slot alone would leave a weight with nothing attached to it.
  it('removes a weighted entry\'s whole tuple, not the reference inside it', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:pick', WEIGHTED, 'features/pick.json'), node('example:oak', SINGLE, 'features/oak.json'), node('example:fern', SINGLE, 'features/fern.json')],
      edges: [
        { from: 'example:pick', to: 'example:oak', kind: 'weighted', ordinal: 0, jsonPath: `$.${WEIGHTED}.features[0][0]`, weight: 3 },
        { from: 'example:pick', to: 'example:fern', kind: 'weighted', ordinal: 1, jsonPath: `$.${WEIGHTED}.features[1][0]`, weight: 1 },
      ],
    }
    const p = plan(deleteFeature(graph, { target: 'example:oak', detachReferences: true }))
    expect(deletes(p.operations)).toEqual([{ file: 'features/pick.json', path: `$.${WEIGHTED}.features[0]` }])
  })

  // What the feature itself placed is NOT deleted -- those files are somebody's work and nothing
  // asked for them to go -- but nothing places them afterwards, and that is invisible from the one
  // file that vanished.
  it('reports what it leaves referenced by nothing, and deletes none of it', () => {
    const graph = samplePack()
    const noRule: IdiomGraph = {
      nodes: graph.nodes.filter((n) => n.id !== 'example:patch_rule'),
      edges: graph.edges.filter((e) => e.from !== 'example:patch_rule'),
    }
    const p = plan(deleteFeature(noRule, { target: 'example:patch' }))
    expect(deletedFiles(p.operations)).toEqual(['features/patch.json'])
    expect(p.notes.map((n) => n.message).join(' ')).toContain('example:fern, example:oak')
  })

  // A self-reference lives in the file that is about to be removed, so it cannot be left dangling
  // and is not a reason to refuse.
  it('does not count a self-reference as something that would be left dangling', () => {
    const graph: IdiomGraph = {
      nodes: [node('example:loop', AGGREGATE, 'features/loop.json')],
      edges: [listEdge('example:loop', AGGREGATE, 'features', 'example:loop', 0, 'aggregate')],
    }
    const p = plan(deleteFeature(graph, { target: 'example:loop' }))
    expect(deletedFiles(p.operations)).toEqual(['features/loop.json'])
    expect(deletes(p.operations)).toEqual([])
  })

  it('refuses a dangling reference, which has no file to remove', () => {
    const dangling: IdiomGraph = { nodes: [{ id: 'example:missing', unresolved: true }], edges: [] }
    expect(refusal(deleteFeature(dangling, { target: 'example:missing' })).code).toBe('unresolved-node')
  })

  it('refuses when a delegation\'s reported path does not index the entry its ordinal claims', () => {
    const graph = samplePack()
    const broken: IdiomGraph = {
      nodes: graph.nodes,
      edges: graph.edges.map((e) => (e.to === 'example:oak' ? { ...e, jsonPath: `$.${AGGREGATE}.features[7]` } : e)),
    }
    expect(refusal(deleteFeature(broken, { target: 'example:oak', detachReferences: true })).code).toBe('path-shape')
  })
})

// ---------------------------------------------------------------------------
// The menu, and identity
// ---------------------------------------------------------------------------

describe('lifecycleOffers', () => {
  it('offers both on one resolved feature, and says how many references a change would reach', () => {
    const offers = lifecycleOffers(samplePack(), ['example:oak'])
    expect(offers.map((o) => o.action)).toEqual(['rename-feature', 'delete-feature'])
    expect(offers.every((o) => o.available)).toBe(true)
    expect(offers[0]!.detail).toContain('1 place')
  })

  it('greys both out with a reason when the selection cannot be acted on', () => {
    for (const selection of [[], ['example:oak', 'example:fern'], ['example:nope']]) {
      for (const offer of lifecycleOffers(samplePack(), selection)) {
        expect(offer.available).toBe(false)
        expect(offer.unavailable).toBeTruthy()
      }
    }
  })

  it('says a dangling reference has nothing to rename or remove', () => {
    const dangling: IdiomGraph = { nodes: [{ id: 'example:missing', unresolved: true }], edges: [] }
    expect(lifecycleOffers(dangling, ['example:missing'])[0]!.unavailable).toContain('resolves to nothing')
  })
})

describe('foldIdentifier', () => {
  // ASCII only, matching the engine. A locale-aware lowercase folds characters the engine does
  // not, which would make this editor refuse names a pack can legally use.
  it('folds ASCII and leaves everything else alone', () => {
    expect(foldIdentifier('Example:Oak_LOG')).toBe('example:oak_log')
    expect(foldIdentifier('example:Ä')).toBe('example:Ä')
  })
})
