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
    expect(view.warnings).toHaveLength(3)
    expect(view.warnings.join('\n')).toMatch(/a:.*not a group id/)
    expect(view.warnings.join('\n')).toMatch(/b:.*neither expanded nor collapsed/)
    expect(view.warnings.join('\n')).toMatch(/c:.*needs an id, a state and a name/)
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
    const all = planRemove(graph, view, 'trees', ['wiki:birch', 'wiki:spruce'])
    expect(all.ok && all.summary).toMatch(/ends the group/)
    expect(planRemove(graph, view, 'trees', ['wiki:oak'])).toMatchObject({ ok: false })
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
    expect((out.nodes[1] as { group?: unknown }).group).toEqual({ id: 'trees', name: 'Big Trees', count: 2 })
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
    expect(expandedFrames(openView, open)).toEqual([{ groupId: 'trees', name: 'Big Trees', memberIds: ['wiki:birch', 'wiki:spruce'] }])
    expect(expandedFrames(openView, { nodes: [{ id: 'wiki:birch' }] })).toEqual([{ groupId: 'trees', name: 'Big Trees', memberIds: ['wiki:birch'] }])
  })
})
