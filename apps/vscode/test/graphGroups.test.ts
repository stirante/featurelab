// graphGroups.test.ts -- covers src/graph/groups.ts: reading groups out of a graph's directives,
// planning the batch of directive writes an operation means, and folding collapsed groups into
// one node each. Pure, so all of it runs in plain vitest.
import { describe, expect, it } from 'vitest'
import {
  collapseGroups,
  expandedFrames,
  groupCardPositions,
  groupIdOfNode,
  groupNodeId,
  groupOf,
  groupableReason,
  nodeGroupWarnings,
  normaliseGroupName,
  planAdd,
  planCreate,
  planRemove,
  planRename,
  planSetCollapsed,
  planUngroup,
  readGroups,
  slugForGroup,
  validateGroupName,
  withDirectives,
  type GroupGraph,
  type GroupNodeWire,
} from '../src/graph/groups.js'

function directive(...args: string[]): { name: string; args: string[]; jsonPath: string } {
  return { name: 'group', args, jsonPath: '$' }
}

function node(id: string, extra: Partial<GroupNodeWire> = {}): GroupNodeWire {
  return { id, file: `features/${id.replace(':', '_')}.json`, ...extra }
}

/** Two trees in a group, an oak on its own, a rule placing the oak, and a dangling reference. */
function packGraph(): GroupGraph {
  return {
    nodes: [
      node('wiki:rule', { file: 'feature_rules/rule.json' }),
      node('wiki:birch', { annotations: [directive('trees', 'expanded', 'Big', 'Trees')] }),
      node('wiki:spruce', { annotations: [directive('trees', 'expanded', 'Big', 'Trees')] }),
      node('wiki:oak'),
      node('wiki:leaves'),
      { id: 'wiki:missing', unresolved: true },
      { id: 'minecraft:bush_feature', unresolved: true, external: true },
    ],
    edges: [
      { from: 'wiki:rule', to: 'wiki:oak', kind: 'rule' },
      { from: 'wiki:oak', to: 'wiki:birch', kind: 'aggregate' },
      { from: 'wiki:oak', to: 'wiki:spruce', kind: 'aggregate' },
      { from: 'wiki:birch', to: 'wiki:leaves', kind: 'child' },
      { from: 'wiki:spruce', to: 'wiki:leaves', kind: 'child' },
      { from: 'wiki:birch', to: 'wiki:spruce', kind: 'sequence' },
      { from: 'wiki:spruce', to: 'wiki:missing', kind: 'child' },
    ],
    roots: ['wiki:rule'],
  }
}

describe('readGroups', () => {
  it('reads a group off its members and nothing else', () => {
    const view = readGroups(packGraph())
    expect(view.groups).toHaveLength(1)
    const trees = view.groups[0]!
    expect(trees).toMatchObject({ id: 'trees', name: 'Big Trees', collapsed: false, memberIds: ['wiki:birch', 'wiki:spruce'], warnings: [] })
    expect(view.memberOf.get('wiki:birch')).toBe('trees')
    expect(view.memberOf.has('wiki:oak')).toBe(false)
    expect(groupOf(view, 'wiki:spruce')?.id).toBe('trees')
    expect(groupOf(view, 'wiki:oak')).toBeNull()
    expect(view.warnings).toEqual([])
  })

  it('takes the commonest name and state when members disagree, and says so', () => {
    const graph: GroupGraph = {
      nodes: [
        node('a', { annotations: [directive('g', 'collapsed', 'One')] }),
        node('b', { annotations: [directive('g', 'collapsed', 'Two')] }),
        node('c', { annotations: [directive('g', 'expanded', 'Two')] }),
      ],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    const g = view.groups[0]!
    expect(g.name).toBe('Two')
    expect(g.collapsed).toBe(true)
    expect(g.warnings).toHaveLength(2)
    expect(g.warnings[0]).toMatch(/disagree about the name/)
    expect(g.warnings[1]).toMatch(/disagree about being collapsed/)
  })

  it('ties break to the first member seen', () => {
    const graph: GroupGraph = {
      nodes: [node('a', { annotations: [directive('g', 'expanded', 'First')] }), node('b', { annotations: [directive('g', 'collapsed', 'Second')] })],
      edges: [],
      roots: [],
    }
    const g = readGroups(graph).groups[0]!
    expect(g.name).toBe('First')
    expect(g.collapsed).toBe(false)
  })

  it('ignores a malformed directive and reports it, without inventing a group', () => {
    const graph: GroupGraph = {
      nodes: [
        node('a', { annotations: [directive('Bad Id', 'expanded', 'X')] }),
        node('b', { annotations: [directive('g', 'sideways', 'X')] }),
        node('c', { annotations: [directive('g', 'expanded')] }),
        node('d', { annotations: [{ name: 'group', args: ['g', 'expanded', 'Elsewhere'], jsonPath: '$.minecraft:x' }] }),
      ],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    expect(view.groups).toEqual([])
    // FOUR, and the fourth is `d`. Its directive is perfectly well formed and sits one line too
    // low -- on `$.minecraft:x` rather than on the file -- which is what a person writing one by
    // hand produces when they put it after the opening brace instead of before it. It declared no
    // group and was reported nowhere: the filter that picked out root directives ran BEFORE the
    // warning path, so the one malformed directive an author is most likely to write was the one
    // kind this list could not contain.
    expect(view.warnings).toHaveLength(4)
    expect(view.warnings.join('\n')).toMatch(/a:.*not a group id/)
    expect(view.warnings.join('\n')).toMatch(/b:.*neither expanded nor collapsed/)
    expect(view.warnings.join('\n')).toMatch(/c:.*needs an id, a state and a name/)
    expect(view.warnings.join('\n')).toMatch(/d carries a @featurelab:group directive on \$\.minecraft:x/)
    // And it is on the NODE as well, which is where the inspector reads from.
    expect(nodeGroupWarnings(view, 'd').join('\n')).toMatch(/ABOVE the opening brace/)
  })

  it('uses the first of two directives on one file and warns on the group', () => {
    const graph: GroupGraph = {
      nodes: [node('a', { annotations: [directive('one', 'expanded', 'One'), directive('two', 'expanded', 'Two')] })],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    expect(view.groups.map((g) => g.id)).toEqual(['one'])
    expect(view.groups[0]!.warnings[0]).toMatch(/a carries 2 group directives/)
  })

  it('says the two-directive warning on the NODE as well, because that is where the choice is made', () => {
    // The warning used to live only on the winning group's panel -- which is not open when
    // somebody is standing on the node picking a group for it out of a select. See
    // GroupsView.nodeWarnings.
    const graph: GroupGraph = {
      nodes: [
        node('a', { annotations: [directive('patches', 'expanded', 'Patches'), directive('markers', 'expanded', 'Markers')] }),
        node('b', { annotations: [directive('markers', 'expanded', 'Markers')] }),
      ],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    expect(nodeGroupWarnings(view, 'a')[0]).toMatch(/a carries 2 group directives/)
    // And it says what taking it out will do, which is the surprise the warning exists for.
    expect(nodeGroupWarnings(view, 'a')[0]).toMatch(/removes all of them/)
    expect(nodeGroupWarnings(view, 'b')).toEqual([])
    expect(nodeGroupWarnings(view, 'nobody')).toEqual([])
  })

  it('never reads a group off a node with no file', () => {
    const graph: GroupGraph = {
      nodes: [{ id: 'x', unresolved: true, annotations: [directive('g', 'expanded', 'G')] }],
      edges: [],
      roots: [],
    }
    expect(readGroups(graph).groups).toEqual([])
  })
})

describe('names and ids', () => {
  it('normalises whitespace, because the directive is whitespace-split on the way back', () => {
    expect(normaliseGroupName('  Big \t Trees  ')).toBe('Big Trees')
  })

  it('refuses an empty name and a name that would close a block comment', () => {
    expect(validateGroupName('   ')).toMatch(/needs a name/)
    expect(validateGroupName('a */ b')).toMatch(/\*\//)
    expect(validateGroupName('Big Trees')).toBeNull()
  })

  it('slugs a name and suffixes a taken slug', () => {
    expect(slugForGroup('Big Trees!', [])).toBe('big-trees')
    expect(slugForGroup('Big Trees', ['big-trees'])).toBe('big-trees-2')
    expect(slugForGroup('Big Trees', ['big-trees', 'big-trees-2'])).toBe('big-trees-3')
    expect(slugForGroup('***', [])).toBe('group')
  })

  it('tells a group node id from a feature id', () => {
    expect(groupIdOfNode(groupNodeId('trees'))).toBe('trees')
    expect(groupIdOfNode('wiki:trees')).toBeNull()
    expect(groupIdOfNode('group:Not Valid')).toBeNull()
  })
})

describe('what may be grouped', () => {
  it('only a node with a real file', () => {
    expect(groupableReason(node('wiki:oak'))).toBeNull()
    expect(groupableReason({ id: 'wiki:missing', unresolved: true })).toMatch(/not defined/)
    expect(groupableReason({ id: 'minecraft:bush_feature', unresolved: true, external: true })).toMatch(/provided by the game/)
    expect(groupableReason({ id: 'wiki:nofile' })).toMatch(/no file/)
    expect(groupableReason({ id: groupNodeId('trees'), file: 'x' })).toMatch(/do not nest/)
  })
})

describe('planning', () => {
  it('planCreate writes one expanded directive per member, with a fresh slug', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const plan = planCreate(graph, view, ['wiki:oak', 'wiki:leaves'], '  Oak   Stuff ')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.groupId).toBe('oak-stuff')
    expect(plan.moved).toEqual([])
    expect(plan.ops).toEqual([
      { file: 'features/wiki_oak.json', path: '$', name: 'group', args: ['oak-stuff', 'expanded', 'Oak', 'Stuff'] },
      { file: 'features/wiki_leaves.json', path: '$', name: 'group', args: ['oak-stuff', 'expanded', 'Oak', 'Stuff'] },
    ])
  })

  it('planCreate names nodes it moves out of another group, and does not collide with its slug', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const plan = planCreate(graph, view, ['wiki:birch', 'wiki:oak'], 'trees')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.groupId).toBe('trees-2')
    expect(plan.moved).toEqual(['wiki:birch'])
  })

  it('planCreate refuses what cannot carry a directive, before writing anything', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    expect(planCreate(graph, view, ['wiki:oak', 'wiki:missing'], 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/not defined/) })
    expect(planCreate(graph, view, ['wiki:oak'], '')).toMatchObject({ ok: false, reason: expect.stringMatching(/needs a name/) })
    expect(planCreate(graph, view, [], 'x')).toMatchObject({ ok: false })
    expect(planCreate(graph, view, ['wiki:nope'], 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/not in the graph/) })
  })

  it('planRename rewrites every member with the new name and keeps id and state', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const plan = planRename(graph, view, 'trees', 'Tall Trees')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops.map((op) => op.args)).toEqual([
      ['trees', 'expanded', 'Tall', 'Trees'],
      ['trees', 'expanded', 'Tall', 'Trees'],
    ])
    expect(planRename(graph, view, 'trees', ' ')).toMatchObject({ ok: false })
    expect(planRename(graph, view, 'nope', 'x')).toMatchObject({ ok: false })
  })

  it('planSetCollapsed rewrites every member with the new state', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const plan = planSetCollapsed(graph, view, 'trees', true)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops.map((op) => op.args)).toEqual([
      ['trees', 'collapsed', 'Big', 'Trees'],
      ['trees', 'collapsed', 'Big', 'Trees'],
    ])
  })

  // THE CHEAP COPY OF A 20-SECOND JOURNEY. test/journeys/groups.test.ts renames a group and then
  // collapses it, and pins the outcome on the members' files over the real host and the real
  // engine. What it is really about is decidable here: a second operation planned BEFORE the
  // first one's graph has come back, which is the state a panel is in for the couple of hundred
  // milliseconds a write's round trip takes -- and therefore the state anybody's second click
  // lands in. A directive is rewritten whole, so the second plan does not add to the first, it
  // undoes it: rename a group, fold it a moment later, and the fold writes the old name back.
  it('a second operation planned before the first comes back builds on it, not over it', () => {
    const graph = packGraph()
    const renamed = planRename(graph, readGroups(graph), 'trees', 'Tall Trees')
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return

    // Planned against the graph as it was, the fold writes "Big Trees" back -- the rename undone.
    expect(planSetCollapsed(graph, readGroups(graph), 'trees', true)).toMatchObject({
      ok: true,
      ops: [{ args: ['trees', 'collapsed', 'Big', 'Trees'] }, { args: ['trees', 'collapsed', 'Big', 'Trees'] }],
    })

    // Planned against the graph the rename will produce, it keeps it.
    const pending = withDirectives(graph, renamed.ops)
    const plan = planSetCollapsed(pending, readGroups(pending), 'trees', true)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops.map((op) => op.args)).toEqual([
      ['trees', 'collapsed', 'Tall', 'Trees'],
      ['trees', 'collapsed', 'Tall', 'Trees'],
    ])
    // And the graph it was planned against is untouched: what is DRAWN stays the host's answer.
    expect(readGroups(graph).byId.get('trees')?.name).toBe('Big Trees')
  })

  it('withDirectives folds in what was asked for, and takes out what was asked to go', () => {
    const graph = packGraph()
    // A directive written onto a file that had none makes a new member of an existing group.
    const added = withDirectives(graph, [{ file: 'features/wiki_oak.json', path: '$', name: 'group', args: ['trees', 'expanded', 'Big', 'Trees'] }])
    expect(readGroups(added).byId.get('trees')?.memberIds).toEqual(['wiki:birch', 'wiki:spruce', 'wiki:oak'])
    // A removal takes one out, and does not touch the others.
    const removed = withDirectives(graph, [{ file: 'features/wiki_birch.json', path: '$', name: 'group', remove: true }])
    expect(readGroups(removed).byId.get('trees')?.memberIds).toEqual(['wiki:spruce'])
    // Folding the same op in twice says the same thing -- a write replaces, it does not append.
    const op = { file: 'features/wiki_birch.json', path: '$', name: 'group', args: ['trees', 'collapsed', 'Big', 'Trees'] }
    expect(withDirectives(graph, [op, op]).nodes.find((n) => n.id === 'wiki:birch')?.annotations).toHaveLength(1)
    // No ops is the graph itself, untouched and un-copied.
    expect(withDirectives(graph, [])).toBe(graph)
    expect(graph.nodes.find((n) => n.id === 'wiki:oak')?.annotations).toBeUndefined()
  })

  it('planAdd writes the group directive onto the newcomers only', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const plan = planAdd(graph, view, 'trees', ['wiki:oak', 'wiki:birch'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops).toEqual([{ file: 'features/wiki_oak.json', path: '$', name: 'group', args: ['trees', 'expanded', 'Big', 'Trees'] }])
    expect(planAdd(graph, view, 'trees', ['wiki:birch'])).toMatchObject({ ok: false, reason: expect.stringMatching(/Already in/) })
  })

  it('planAdd moving a node from another group is one rewrite, and is reported', () => {
    const graph: GroupGraph = {
      nodes: [node('a', { annotations: [directive('one', 'expanded', 'One')] }), node('b', { annotations: [directive('two', 'collapsed', 'Two')] })],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    const plan = planAdd(graph, view, 'two', ['a'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.moved).toEqual(['a'])
    expect(plan.ops).toEqual([{ file: 'features/a.json', path: '$', name: 'group', args: ['two', 'collapsed', 'Two'] }])
  })

  it('planRemove removes the directive, and says when that ends the group', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const one = planRemove(graph, view, 'trees', ['wiki:birch'])
    expect(one.ok).toBe(true)
    if (!one.ok) return
    expect(one.ops).toEqual([{ file: 'features/wiki_birch.json', path: '$', name: 'group', remove: true }])
    expect(one.summary).not.toMatch(/ends the group/)
    expect(one.leaving).toEqual(['wiki:birch'])
    const all = planRemove(graph, view, 'trees', ['wiki:birch', 'wiki:spruce'])
    expect(all.ok && all.summary).toMatch(/ends the group/)
    expect(planRemove(graph, view, 'trees', ['wiki:oak'])).toMatchObject({ ok: false })
  })

  it('planRemove takes ALL of a file’s group directives off, not just the first', () => {
    // "None" USED TO MOVE YOU INTO A DIFFERENT GROUP. The engine's RemoveAnnotation takes the
    // first matching directive off and leaves the rest, so a file carrying `patches` then
    // `markers` came back still in `markers` -- the node's row had said "Patches", the author
    // chose None, and the feature silently joined the other group with nothing said about it.
    const graph: GroupGraph = {
      nodes: [node('a', { annotations: [directive('patches', 'expanded', 'Patches'), directive('markers', 'expanded', 'Markers')] })],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    const plan = planRemove(graph, view, 'patches', ['a'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // One op per directive on that file. They are identical by construction -- ops on one file
    // apply in sequence to the same bytes, and a remove that finds nothing is a no-op -- so this
    // is exactly "all of them" and never more.
    expect(plan.ops).toEqual([
      { file: 'features/a.json', path: '$', name: 'group', remove: true },
      { file: 'features/a.json', path: '$', name: 'group', remove: true },
    ])
    // And the view this panel plans the NEXT operation against agrees that it is in no group.
    const after = readGroups(withDirectives(graph, plan.ops))
    expect(after.memberOf.has('a')).toBe(false)
    expect(after.groups).toEqual([])
  })

  it('planRemove reaches a directive written a line too low, at its own path', () => {
    // THE OTHER HALF OF THE SAME BUG. A hand-written `// @featurelab:group caves expanded Caves`
    // placed after the `{` instead of before it attaches to the first key, declares no group, and
    // was invisible to `directiveCount` -- which counted root directives only. So the file that
    // measurement produced (one working directive above the brace, one stray below it) planned
    // ONE removal, came back still carrying the stray, and the feature rejoined the group the
    // author had just chosen None for.
    //
    // And the removals are ADDRESSED: jsonc.RemoveAnnotation matches on name AND jsonPath
    // exactly, so N copies of `$`/`group` would take off N copies of the root one and leave the
    // stray exactly where it was.
    const graph: GroupGraph = {
      nodes: [
        node('a', {
          annotations: [
            directive('caves', 'expanded', 'Caves'),
            { name: 'group', args: ['caves', 'expanded', 'Caves'], jsonPath: '$.minecraft:cave_carver_feature' },
          ],
        }),
      ],
      edges: [],
      roots: [],
    }
    const plan = planRemove(graph, readGroups(graph), 'caves', ['a'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops).toEqual([
      { file: 'features/a.json', path: '$', name: 'group', remove: true },
      { file: 'features/a.json', path: '$.minecraft:cave_carver_feature', name: 'group', remove: true },
    ])
    expect(readGroups(withDirectives(graph, plan.ops)).groups).toEqual([])
  })

  it('choosing a group for a file that already holds a stray directive does not leave two behind', () => {
    // The sequence the critic walked: a file with a misplaced directive, then the inspector's
    // group menu. `setOp` writes `@featurelab:group` at `$` and the engine replaces exactly that
    // one, so the stray survived and the file ended up carrying two -- the second permanently
    // invisible, and enough to put the feature back in the group after a "None".
    const graph: GroupGraph = {
      nodes: [
        node('a', { annotations: [{ name: 'group', args: ['caves', 'expanded', 'Caves'], jsonPath: '$.minecraft:cave_carver_feature' }] }),
      ],
      edges: [],
      roots: [],
    }
    const plan = planCreate(graph, readGroups(graph), ['a'], 'Caves')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // The stray comes off FIRST; ops on one file apply in sequence, so this is the order on disk.
    expect(plan.ops[0]).toEqual({ file: 'features/a.json', path: '$.minecraft:cave_carver_feature', name: 'group', remove: true })
    expect(plan.ops).toHaveLength(2)
    const after = withDirectives(graph, plan.ops)
    expect(after.nodes[0]!.annotations).toHaveLength(1)
    expect(after.nodes[0]!.annotations![0]!.jsonPath).toBe('$')
  })

  it('choosing a group for a file holding TWO root directives does not leave the second behind', () => {
    // THE VARIANT THAT SURVIVED. `@featurelab:Group` at `$` and a stray at `$.format_version` are
    // both removed in front of the set op now, because neither matches what the set op overwrites.
    // Two LOWER-CASE directives at `$` both matched it -- `supersededRemoveOps` filtered out
    // exactly the `$`+`group` pair -- so a file readGroups already WARNS about planned a set op
    // and no removals at all. The engine's writer replaces the first match and returns, so the
    // second root directive came through untouched: invisible in the panel, live in the file, and
    // enough to put the feature back in its old group the next time anybody chose "None".
    //
    // Exactly ONE is spared, because exactly one is what the set op will land on.
    const graph: GroupGraph = {
      nodes: [
        node('a', {
          annotations: [directive('caves', 'expanded', 'Caves'), directive('ores', 'collapsed', 'Ores')],
        }),
      ],
      edges: [],
      roots: [],
    }
    // The state is one this tool already recognises rather than one invented for the test.
    expect(nodeGroupWarnings(readGroups(graph), 'a').join('\n')).not.toEqual('')
    const plan = planCreate(graph, readGroups(graph), ['a'], 'Trees')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // One removal, then the set -- ops on one file apply in sequence, so this is the order on disk.
    expect(plan.ops).toEqual([
      { file: 'features/a.json', path: '$', name: 'group', remove: true },
      { file: 'features/a.json', path: '$', name: 'group', args: ['trees', 'expanded', 'Trees'] },
    ])
    const after = withDirectives(graph, plan.ops)
    expect(after.nodes[0]!.annotations).toHaveLength(1)
    const view = readGroups(after)
    expect(view.groups.map((g) => g.id)).toEqual(['trees'])
    // And nothing is left for a later "None" to fall through to.
    const none = planRemove(after, view, 'trees', ['a'])
    expect(none.ok).toBe(true)
    if (!none.ok) return
    expect(readGroups(withDirectives(after, none.ops)).groups).toEqual([])
  })

  it('reads @featurelab:Group, and says the spelling is wrong', () => {
    // The engine matches `@featurelab:ignore` with strings.EqualFold (wire/graphcheck.go's
    // suppressedByIgnore), so a capital was honoured on one side of this tool and dropped without
    // a word on the other. Every OTHER malformed directive was already reported; this one was
    // filtered out one line before the warning path could see it.
    const graph: GroupGraph = {
      nodes: [
        node('a', { annotations: [{ name: 'Group', args: ['pumpkins', 'expanded', 'Pumpkins'], jsonPath: '$' }] }),
        node('b', { annotations: [directive('pumpkins', 'expanded', 'Pumpkins')] }),
      ],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    expect(view.groups.map((g) => g.id)).toEqual(['pumpkins'])
    expect(view.groups[0]!.memberIds).toEqual(['a', 'b'])
    expect(view.groups[0]!.warnings.join('\n')).toMatch(/a spells its directive @featurelab:Group/)
    expect(nodeGroupWarnings(view, 'a').join('\n')).toMatch(/Write it lower case/)
    // Nothing is said about the file that spelled it correctly.
    expect(nodeGroupWarnings(view, 'b')).toEqual([])
  })

  it('a removal aimed at @featurelab:Group carries that spelling, because the engine matches it exactly', () => {
    const graph: GroupGraph = {
      nodes: [node('a', { annotations: [{ name: 'Group', args: ['pumpkins', 'expanded', 'Pumpkins'], jsonPath: '$' }] })],
      edges: [],
      roots: [],
    }
    const plan = planRemove(graph, readGroups(graph), 'pumpkins', ['a'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // `{name: 'group'}` would match nothing in jsonc.RemoveAnnotation and leave the file as it
    // was -- recognising the capital without being able to remove it would be worse than not
    // recognising it at all.
    expect(plan.ops).toEqual([{ file: 'features/a.json', path: '$', name: 'Group', remove: true }])
    expect(readGroups(withDirectives(graph, plan.ops)).groups).toEqual([])
  })

  it('expandedFrames marks a group that is down to one member', () => {
    const graph: GroupGraph = {
      nodes: [node('a', { annotations: [directive('ores', 'expanded', 'Ores')] })],
      edges: [],
      roots: [],
    }
    expect(expandedFrames(readGroups(graph), graph)).toEqual([
      { groupId: 'ores', name: 'Ores', memberIds: ['a'], lone: true },
    ])
  })

  it('planUngroup clears a member carrying two directives just as thoroughly', () => {
    const graph: GroupGraph = {
      nodes: [
        node('a', { annotations: [directive('trees', 'expanded', 'Trees'), directive('other', 'expanded', 'Other')] }),
        node('b', { annotations: [directive('trees', 'expanded', 'Trees')] }),
      ],
      edges: [],
      roots: [],
    }
    const view = readGroups(graph)
    const plan = planUngroup(graph, view, 'trees')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops.filter((op) => op.file === 'features/a.json')).toHaveLength(2)
    expect(plan.ops.filter((op) => op.file === 'features/b.json')).toHaveLength(1)
    expect(plan.leaving).toEqual(['a', 'b'])
    expect(readGroups(withDirectives(graph, plan.ops)).groups).toEqual([])
  })

  it('planUngroup removes every member directive', () => {
    const graph = packGraph()
    const view = readGroups(graph)
    const plan = planUngroup(graph, view, 'trees')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ops).toEqual([
      { file: 'features/wiki_birch.json', path: '$', name: 'group', remove: true },
      { file: 'features/wiki_spruce.json', path: '$', name: 'group', remove: true },
    ])
  })
})

describe('collapseGroups', () => {
  function collapsedPack(): GroupGraph {
    const graph = packGraph()
    return {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.annotations ? { ...n, annotations: [directive('trees', 'collapsed', 'Big', 'Trees')] } : n,
      ),
    }
  }

  it('leaves a graph with no collapsed group untouched', () => {
    const graph = packGraph()
    expect(collapseGroups(graph, readGroups(graph))).toBe(graph)
  })

  it('replaces the members with one node carrying the group summary, where the first member was', () => {
    const graph = collapsedPack()
    const out = collapseGroups(graph, readGroups(graph))
    expect(out.nodes.map((n) => n.id)).toEqual(['wiki:rule', 'group:trees', 'wiki:oak', 'wiki:leaves', 'wiki:missing', 'minecraft:bush_feature'])
    // The members are named on the summary, not only counted: a card that says "2 features" and
    // nothing else is a fold nobody can read across. See GroupNodeSummary.memberIds.
    expect((out.nodes[1] as { group?: unknown }).group).toEqual({
      id: 'trees',
      name: 'Big Trees',
      count: 2,
      memberIds: ['wiki:birch', 'wiki:spruce'],
    })
  })

  it('names only the members that are actually in the graph, so the card cannot advertise one that is not drawn', () => {
    const graph = collapsedPack()
    const without = { ...graph, nodes: graph.nodes.filter((n) => n.id !== 'wiki:spruce') }
    const out = collapseGroups(without, readGroups(graph))
    const summary = (out.nodes.find((n) => n.id === 'group:trees') as unknown as { group: { count: number; memberIds: string[] } }).group
    expect(summary.memberIds).toEqual(['wiki:birch'])
    expect(summary.count).toBe(1)
  })

  it('re-points outside edges, dedupes what becomes the same edge, and drops internal ones', () => {
    const graph = collapsedPack()
    const out = collapseGroups(graph, readGroups(graph))
    expect(out.edges).toEqual([
      { from: 'wiki:rule', to: 'wiki:oak', kind: 'rule' },
      // Two aggregate edges into two members became one edge into the card.
      { from: 'wiki:oak', to: 'group:trees', kind: 'aggregate' },
      // Two child edges out of two members to the same leaf became one.
      { from: 'group:trees', to: 'wiki:leaves', kind: 'child' },
      // birch -> spruce was inside the group and is gone.
      { from: 'group:trees', to: 'wiki:missing', kind: 'child' },
    ])
  })

  it('keeps roots for nodes still drawn, and makes the card a root only when nothing reaches it', () => {
    const graph = collapsedPack()
    const view = readGroups(graph)
    expect(collapseGroups(graph, view).roots).toEqual(['wiki:rule'])

    const rootedGroup: GroupGraph = { ...graph, edges: graph.edges.filter((e) => e.to !== 'wiki:birch' && e.to !== 'wiki:spruce'), roots: ['wiki:rule', 'wiki:birch'] }
    expect(collapseGroups(rootedGroup, view).roots).toEqual(['wiki:rule', 'group:trees'])

    const reachedGroup: GroupGraph = { ...graph, roots: ['wiki:rule', 'wiki:birch'] }
    expect(collapseGroups(reachedGroup, view).roots).toEqual(['wiki:rule'])
  })

  it('ignores members that are not in the graph it is handed', () => {
    const graph = collapsedPack()
    const view = readGroups(graph)
    const without = { ...graph, nodes: graph.nodes.filter((n) => n.id !== 'wiki:spruce'), edges: graph.edges.filter((e) => e.from !== 'wiki:spruce' && e.to !== 'wiki:spruce') }
    const out = collapseGroups(without, view)
    expect((out.nodes.find((n) => n.id === 'group:trees') as unknown as { group: { count: number } }).group.count).toBe(1)
  })

  it('places the card at the top-left of its members, and frames only expanded groups', () => {
    const graph = collapsedPack()
    const view = readGroups(graph)
    const positions = new Map([
      ['wiki:birch', { x: 300, y: 120 }],
      ['wiki:spruce', { x: 100, y: 400 }],
      ['wiki:oak', { x: 0, y: 0 }],
    ])
    expect([...groupCardPositions(view, positions)]).toEqual([['group:trees', { x: 100, y: 120 }]])
    expect(expandedFrames(view, graph)).toEqual([])

    const open = packGraph()
    const openView = readGroups(open)
    expect(groupCardPositions(openView, positions).size).toBe(0)
    expect(expandedFrames(openView, open)).toEqual([
      { groupId: 'trees', name: 'Big Trees', memberIds: ['wiki:birch', 'wiki:spruce'], lone: false },
    ])
    // `lone` is about the GROUP, not about what is currently drawn: this graph draws one of the
    // two members, and a group whose other member is merely off this view is not a remnant.
    expect(expandedFrames(openView, { nodes: [{ id: 'wiki:birch' }] })).toEqual([
      { groupId: 'trees', name: 'Big Trees', memberIds: ['wiki:birch'], lone: false },
    ])
  })
})
