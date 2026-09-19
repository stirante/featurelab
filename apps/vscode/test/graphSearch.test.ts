// graphSearch.test.ts -- covers src/graph/search.ts, finding and filtering on a real-sized pack.
//
// THE FIXTURE IS NOT test/fixtures/graph-sample.json, AND THAT IS THE POINT. That file is 57
// nodes. Every navigation question this module exists to answer is trivially true at 57 nodes and
// says nothing about the case that matters: a large pack, the target here, is 3531 nodes,
// 4580 edges and 41 placement rules, laid out as one large drawing plus several hundred small
// disconnected ones sharing a pool of leaf features. A ranking that looks fine on 57 rows can be
// useless on 3531, and a scan that is instant on 57 can miss a frame on 3531, so this file
// GENERATES a graph of that size and shape and asserts against it -- both the order of the results
// and what they cost.
//
// FOUR PARTS:
//
//   1. THE GENERATOR, and a sanity pass proving it really did build what it claims. A fixture that
//      quietly shrank would make every assertion below pass for the wrong reason.
//   2. THE MODEL, in plain node: the ranking ladder, what a result says about WHERE it is, the
//      filters, the canvas subgraph, and the keyboard -- which is a pure reducer precisely so it
//      can be tested here rather than only through a browser.
//   3. THE COST, measured on that graph and printed. Index build, worst-case query, and the same
//      search done naively without an index, so "a linear scan is fine here" is a measurement
//      rather than an assumption.
//   4. THE DOM, in real Chromium, following graphPalette.test.ts -- plus the language guard and the
//      stylesheet guard those files establish.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  ABSOLUTE_PATH_PATTERN,
  EXTRA_BANNED_WORDS,
  REJECT_SAMPLES,
  SOURCE_FILE_PATTERN,
  TOOLING_WORDS,
  readGoGuard,
  word,
} from './fixtures/languageGuard.js'
import {
  CONTENT_CHAR_BUDGET,
  DEFAULT_RESULT_LIMIT,
  RULE_TYPE_ID,
  SEARCH_CHIPS,
  SEARCH_FLAGS,
  SEARCH_STRINGS,
  SEARCH_STYLESHEET,
  TIER_RANK,
  applyKey,
  buildSearchIndex,
  chipLegend,
  chipsInUse,
  componentOf,
  describeHit,
  filterGraph,
  parseQuery,
  searchGraph,
  type SearchBoxState,
  type SearchHit,
  type SearchTier,
} from '../src/graph/search.js'
import { RULE_TYPE_ID as NODE_STATS_RULE_TYPE_ID } from '../src/graph/nodeStats.js'
import type { GraphEdgeKind, GraphEdgeWire, GraphNodeWire, GraphWire } from '../src/graph/render.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const searchPath = path.join(dir, '..', 'src', 'graph', 'search.ts')

// ---------------------------------------------------------------------------
// 1. A pack at the size this module is for
// ---------------------------------------------------------------------------

/** The measurements this fixture is built to reproduce. */
const TARGET_NODES = 3531
const TARGET_EDGES = 4580
/** Placement rules. The target pack has 41 and they are its entry points. Note that the wire
 * contract's `roots` is wider than this -- it is every node nothing delegates to, so the head of
 * each small disconnected drawing is one too -- and this fixture reproduces that as well. */
const RULE_COUNT = 41

/** A tiny deterministic PRNG. The fixture must be byte-identical run to run, or a ranking
 * assertion becomes a coin toss that fails once a fortnight on somebody else's machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Word pools for the bulk of the pack.
 *
 * DELIBERATELY FREE OF EVERY WORD THE RANKING TESTS SEARCH FOR ("oak", "drip", "anchor", "spire",
 * "amethyst"). The assertions below are about which node comes first, and a pool that accidentally
 * spelled one of those would make them depend on a coincidence rather than on the ladder. The
 * sanity pass asserts the pools really are clean. */
const ADJECTIVES = [
  'sparse', 'dense', 'tall', 'short', 'wide', 'narrow', 'rocky', 'sandy',
  'frozen', 'warm', 'humid', 'dry', 'shaded', 'bright', 'deep', 'shallow',
] as const
const NOUNS = [
  'patch', 'cluster', 'grove', 'thicket', 'vein', 'bed', 'ridge', 'mound',
  'drift', 'bloom', 'tangle', 'shelf', 'pocket', 'stack',
] as const
const GROUPS = ['surface', 'underground', 'ceiling', 'water', 'nether', 'end', 'plains', 'ridges'] as const
const BLOCKS = [
  'minecraft:stone', 'minecraft:granite', 'minecraft:moss_block', 'minecraft:sand',
  'minecraft:gravel', 'minecraft:clay', 'minecraft:tuff', 'minecraft:calcite',
] as const
const FEATURE_TYPES = [
  'minecraft:scatter_feature', 'minecraft:aggregate_feature', 'minecraft:sequence_feature',
  'minecraft:weighted_random_feature', 'minecraft:conditional_list', 'minecraft:tree_feature',
  'minecraft:ore_feature', 'minecraft:single_block_feature', 'minecraft:vegetation_patch_feature',
  'minecraft:snap_to_surface_feature',
] as const
const EDGE_KINDS: readonly GraphEdgeKind[] = ['aggregate', 'sequence', 'weighted', 'conditional', 'scatter', 'filter', 'child']

interface PackBuilder {
  nodes: GraphNodeWire[]
  edges: GraphEdgeWire[]
  add(node: GraphNodeWire): string
  link(from: string, to: string, kind?: GraphEdgeKind): boolean
}

function newBuilder(): PackBuilder {
  const nodes: GraphNodeWire[] = []
  const edges: GraphEdgeWire[] = []
  const seenEdge = new Set<string>()
  const outCount = new Map<string, number>()
  return {
    nodes,
    edges,
    add(node) {
      nodes.push(node)
      return node.id
    },
    link(from, to, kind = 'aggregate') {
      const key = `${from}\u0000${to}`
      if (seenEdge.has(key)) return false
      seenEdge.add(key)
      const ordinal = outCount.get(from) ?? 0
      outCount.set(from, ordinal + 1)
      edges.push({ from, to, kind, jsonPath: `features[${ordinal}]`, ordinal, required: kind === 'rule' })
      return true
    },
  }
}

/** The nodes the ranking assertions are about, hand-written so the ladder can be read off them.
 *
 * Every one of them is planted in the middle of three and a half thousand others, which is the
 * only way to find out whether the ranking works -- a ladder tested on five nodes is a ladder
 * tested on nothing. */
const SPECIALS: readonly GraphNodeWire[] = [
  // The exact-match target. Deliberately unremarkable: nothing delegates to it, it is added LAST
  // of the oak family so graph order does not favour it, and it has no fan-in to lean on. If it
  // still comes first for "oak", it came first for being the thing that was typed.
  { id: 'example:oak', typeId: 'minecraft:tree_feature', file: 'features/plains/oak.json', coverage: 'implemented', fields: { trunk: 'trunk' } },
  // Starts with it.
  { id: 'example:oak_tree_canopy_large', typeId: 'minecraft:tree_feature', file: 'features/plains/canopy.json', coverage: 'implemented', fields: {} },
  // Contains it at a word boundary.
  { id: 'example:swamp_oak_stand', typeId: 'minecraft:tree_feature', file: 'features/water/stand.json', coverage: 'implemented', fields: {} },
  // Contains it inside a word.
  { id: 'example:cloak_of_leaves', typeId: 'minecraft:aggregate_feature', file: 'features/plains/cloak.json', coverage: 'implemented', fields: {} },
  // Has the letters in order and nothing else: o-vergr-o-wn_-a-ncient_-k-not.
  { id: 'example:overgrown_ancient_knot', typeId: 'minecraft:ore_feature', file: 'features/underground/knot.json', coverage: 'implemented', fields: {} },
  // Mentions the id in its own values, and is the reason "an exact id must never lose to a fuzzy
  // match on something else" is testable: it matches the string "example:oak" literally.
  { id: 'example:relay_beacon', typeId: 'minecraft:sequence_feature', file: 'features/plains/relay.json', coverage: 'implemented', fields: { note: 'runs after example:oak' } },
  // The one somebody remembers as "the one with the dripleaf in it". Its NAME says nothing about
  // dripleaf; only its values do.
  { id: 'example:mossy_recess', typeId: 'minecraft:vegetation_patch_feature', file: 'features/ceiling/recess.json', coverage: 'implemented', fields: { vegetation_block: 'minecraft:big_dripleaf', ground_block: 'minecraft:moss_block' } },
  // ...and one whose name does, so the two can be raced.
  { id: 'example:cave_dripleaf_patch', typeId: 'minecraft:scatter_feature', file: 'features/ceiling/dripleaf.json', coverage: 'implemented', fields: {} },
  // Two equally good matches for "anchor", differing only in how much of the pack depends on
  // them. `bb` is added FIRST and given one parent; `aa` is added second and given thirty, so
  // graph order pulls one way and fan-in the other.
  { id: 'example:shared_anchor_bb', typeId: 'minecraft:single_block_feature', file: 'features/surface/anchor_bb.json', coverage: 'implemented', fields: {} },
  { id: 'example:shared_anchor_aa', typeId: 'minecraft:single_block_feature', file: 'features/surface/anchor_aa.json', coverage: 'implemented', fields: {} },
  // Two prefix matches for "spire", differing only in length.
  { id: 'example:spire_tall_extra_wide', typeId: 'minecraft:ore_feature', file: 'features/ridges/spire_wide.json', coverage: 'implemented', fields: {} },
  { id: 'example:spire_tall', typeId: 'minecraft:ore_feature', file: 'features/ridges/spire.json', coverage: 'implemented', fields: {} },
  // A type this tool only partly builds, so the warning line has something to say.
  { id: 'example:approximate_grove', typeId: 'minecraft:tree_feature', file: 'features/plains/approximate.json', coverage: 'partial', coverageNote: 'Rotation is approximated.', fields: {} },
]

interface Pack {
  graph: GraphWire
  /** The ids of the small disconnected drawings' head nodes, for the sanity pass. */
  smallHeads: readonly string[]
  ruleIds: readonly string[]
}

/** Builds a pack shaped like a large real one: dozens of placement rules over one large drawing of
 * shared children, several hundred small disconnected drawings, a handful of references the pack
 * does not define, thirteen the game provides, and one loop. */
function buildPack(): Pack {
  const rand = mulberry32(0x5eed_1234)
  const b = newBuilder()
  const pick = <T>(pool: readonly T[]): T => pool[Math.floor(rand() * pool.length)] as T

  let serial = 0
  const bulkNode = (kind: 'top' | 'mid' | 'leaf' | 'small'): GraphNodeWire => {
    const id = `example:${pick(ADJECTIVES)}_${pick(NOUNS)}_${serial++}`
    const group = pick(GROUPS)
    const typeId = kind === 'leaf' ? (rand() < 0.5 ? 'minecraft:single_block_feature' : 'minecraft:ore_feature') : pick(FEATURE_TYPES)
    const roll = rand()
    return {
      id,
      typeId,
      file: `features/${group}/${id.slice('example:'.length)}.json`,
      formatVersion: '1.21.110',
      coverage: roll < 0.02 ? 'missing' : roll < 0.05 ? 'partial' : 'implemented',
      fields:
        kind === 'leaf'
          ? { places_block: pick(BLOCKS), may_replace: [pick(BLOCKS), pick(BLOCKS)] }
          : { iterations: `${1 + Math.floor(rand() * 8)}`, scatter_chance: Math.floor(rand() * 100) },
    }
  }

  // --- the specials, planted before the bulk so they are not at the end of the node order ---
  for (const node of SPECIALS.slice(0, 8)) b.add(node)

  // --- the large drawing: 41 rules -> 41 tops -> 400 mids -> 600 shared leaves ---
  const ruleIds: string[] = []
  const tops: string[] = []
  for (let i = 0; i < RULE_COUNT; i++) {
    const top = b.add(bulkNode('top'))
    tops.push(top)
    const rule = b.add({
      id: `example:rule_${String(i).padStart(2, '0')}`,
      typeId: RULE_TYPE_ID,
      file: `rules/${pick(GROUPS)}_${i}.json`,
      formatVersion: '1.21.110',
      coverage: 'implemented',
      fields: { distribution: { iterations: 1 } },
    })
    ruleIds.push(rule)
    b.link(rule, top, 'rule')
  }

  const mids: string[] = []
  for (let i = 0; i < 400; i++) {
    const mid = b.add(bulkNode('mid'))
    mids.push(mid)
    b.link(tops[i % tops.length] as string, mid, pick(EDGE_KINDS))
  }
  const leaves: string[] = []
  for (let i = 0; i < 600; i++) leaves.push(b.add(bulkNode('leaf')))
  for (const [i, mid] of mids.entries()) {
    // Heavy sharing, which is a large pack's shape: a handful of leaves carry most of the fan-in.
    b.link(mid, leaves[(i * 7) % leaves.length] as string, pick(EDGE_KINDS))
    b.link(mid, leaves[Math.floor(rand() * 40)] as string, pick(EDGE_KINDS))
  }

  // --- the rest of the specials, wired into the large drawing ---
  for (const node of SPECIALS.slice(8)) b.add(node)
  b.link(mids[0] as string, 'example:oak_tree_canopy_large', 'child')
  b.link(mids[1] as string, 'example:swamp_oak_stand', 'child')
  b.link(mids[2] as string, 'example:cloak_of_leaves', 'child')
  b.link(mids[3] as string, 'example:overgrown_ancient_knot', 'child')
  b.link(mids[4] as string, 'example:relay_beacon', 'child')
  b.link(mids[5] as string, 'example:mossy_recess', 'child')
  b.link(mids[6] as string, 'example:cave_dripleaf_patch', 'child')
  b.link(mids[7] as string, 'example:shared_anchor_bb', 'child')
  for (let i = 0; i < 30; i++) b.link(mids[10 + i] as string, 'example:shared_anchor_aa', 'child')
  b.link(mids[8] as string, 'example:spire_tall', 'child')
  b.link(mids[9] as string, 'example:spire_tall_extra_wide', 'child')
  b.link(mids[50] as string, 'example:approximate_grove', 'child')
  // `example:oak` is reached from nothing at all: it is one of the roots, and the least
  // well-connected node in the oak family.

  // --- references the pack does not define, and the thirteen the game provides ---
  for (let i = 0; i < 5; i++) {
    const id = `example:missing_reference_${i}`
    b.add({ id, unresolved: true })
    b.link(mids[100 + i] as string, id, 'child')
  }
  const gameProvided = [
    'minecraft:bush_feature', 'minecraft:fern_feature', 'minecraft:big_dripleaf_north',
    'minecraft:big_dripleaf_south', 'minecraft:big_dripleaf_east', 'minecraft:big_dripleaf_west',
    'minecraft:oak_tree_feature', 'minecraft:birch_tree_feature', 'minecraft:spruce_tree_feature',
    'minecraft:pumpkin_feature', 'minecraft:melon_feature', 'minecraft:sugar_cane_feature',
    'minecraft:cactus_feature',
  ]
  for (const [i, id] of gameProvided.entries()) {
    b.add({ id, unresolved: true, external: true } as GraphNodeWire)
    b.link(mids[150 + i] as string, id, 'child')
  }

  // --- one loop, which the contract says is legal and must not be walked as if it were not ---
  const cycle = [mids[200] as string, mids[201] as string, mids[202] as string]
  b.link(cycle[0] as string, cycle[1] as string, 'sequence')
  b.link(cycle[1] as string, cycle[2] as string, 'sequence')
  b.link(cycle[2] as string, cycle[0] as string, 'sequence')

  // --- several hundred small disconnected drawings ---
  const smallHeads: string[] = []
  let size = 2
  while (b.nodes.length + size <= TARGET_NODES) {
    const chain: string[] = []
    for (let i = 0; i < size; i++) chain.push(b.add(bulkNode('small')))
    smallHeads.push(chain[0] as string)
    for (let i = 1; i < chain.length; i++) b.link(chain[i - 1] as string, chain[i] as string, pick(EDGE_KINDS))
    // A shared child inside the drawing, so these are not all bare chains.
    if (size >= 4) b.link(chain[0] as string, chain[size - 1] as string, 'aggregate')
    size = size === 7 ? 2 : size + 1
  }
  // Exactly to the target, with single-box drawings -- of which a real pack has plenty.
  while (b.nodes.length < TARGET_NODES) {
    const only = b.add(bulkNode('small'))
    smallHeads.push(only)
  }

  // --- top up the edges to the target by deepening the sharing in the large drawing ---
  let guard = 0
  for (let i = 0; b.edges.length < TARGET_EDGES; i++) {
    if (guard++ > 200_000) throw new Error('could not reach the edge target -- the generator needs more pairs')
    const mid = mids[i % mids.length] as string
    const leaf = leaves[(i * 13 + Math.floor(i / mids.length) * 3) % leaves.length] as string
    b.link(mid, leaf, 'aggregate')
  }

  const incoming = new Set(b.edges.map((e) => e.to))
  const roots = b.nodes.map((n) => n.id).filter((id) => !incoming.has(id))
  return { graph: { nodes: b.nodes, edges: b.edges, roots, cycles: [cycle] }, smallHeads, ruleIds }
}

const PACK = buildPack()
const GRAPH = PACK.graph
const INDEX = buildSearchIndex(GRAPH)

const ids = (hits: readonly SearchHit[]): string[] => hits.map((h) => h.nodeId)
const tierOf = (hits: readonly SearchHit[], nodeId: string): SearchTier | undefined =>
  hits.find((h) => h.nodeId === nodeId)?.tier

describe('the fixture is a pack at the size this module exists for', () => {
  it('is 3531 nodes and 4580 edges, not a 57-node sample', () => {
    expect(GRAPH.nodes.length).toBe(TARGET_NODES)
    expect(GRAPH.edges.length).toBe(TARGET_EDGES)
    expect(new Set(GRAPH.nodes.map((n) => n.id)).size).toBe(TARGET_NODES)
  })

  it('has 41 placement rules, and roots wider than that because most drawings are small', () => {
    expect(PACK.ruleIds.length).toBe(RULE_COUNT)
    expect(GRAPH.nodes.filter((n) => n.typeId === RULE_TYPE_ID)).toHaveLength(RULE_COUNT)
    // Every rule is a root, and so is the head of each small drawing -- which is what the wire
    // contract says a root is. A fixture whose roots were only the rules would not reproduce the
    // thing that makes this pack hard to navigate.
    for (const rule of PACK.ruleIds) expect(GRAPH.roots).toContain(rule)
    expect(GRAPH.roots.length).toBeGreaterThan(300)
  })

  it('is hundreds of separate drawings with one big one, and has shared children', () => {
    expect(INDEX.stats.components).toBeGreaterThan(300)
    const biggest = Math.max(...INDEX.entries.map((e) => e.componentSize))
    expect(biggest).toBeGreaterThan(1000)
    const shared = INDEX.entries.filter((e) => e.fanIn >= 2)
    expect(shared.length).toBeGreaterThan(400)
    expect(Math.max(...INDEX.entries.map((e) => e.fanIn))).toBeGreaterThanOrEqual(30)
  })

  it('carries the awkward cases a real pack carries', () => {
    expect(INDEX.entries.filter((e) => e.unresolved)).toHaveLength(5)
    expect(INDEX.entries.filter((e) => e.external)).toHaveLength(13)
    expect(INDEX.entries.filter((e) => e.inCycle)).toHaveLength(3)
    expect(INDEX.entries.filter((e) => e.coverage === 'partial').length).toBeGreaterThan(20)
  })

  it('spells none of the search terms the ranking tests use in its bulk vocabulary', () => {
    // The whole point of the ladder assertions is that the planted node wins on RANK. A pool word
    // that happened to contain "oak" would turn them into assertions about a coincidence.
    const pools = [...ADJECTIVES, ...NOUNS, ...GROUPS, ...BLOCKS, ...FEATURE_TYPES].join(' ')
    for (const term of ['oak', 'drip', 'anchor', 'spire', 'beacon', 'recess']) {
      expect(pools, `"${term}" must not appear in the bulk vocabulary`).not.toContain(term)
    }
  })

  it('agrees with nodeStats about what a placement rule is called', () => {
    // search.ts spells the constant out rather than importing nodeStats, so that the module has no
    // run-time dependency at all. This is what stops the copy drifting.
    expect(RULE_TYPE_ID).toBe(NODE_STATS_RULE_TYPE_ID)
  })
})

// ---------------------------------------------------------------------------
// 2. The ranking ladder
// ---------------------------------------------------------------------------

describe('ranking: an exact id never loses to anything', () => {
  it('puts the exact id first even though every rival is better connected', () => {
    const result = searchGraph(INDEX, 'oak')
    expect(result.hits[0]?.nodeId).toBe('example:oak')
    expect(result.hits[0]?.tier).toBe('exact-id')
    // And it won on rank, not on luck: it is a root nothing points at, while the entry directly
    // below it is reached from the large drawing.
    const winner = INDEX.byId.get('example:oak')
    expect(winner?.fanIn).toBe(0)
    expect(INDEX.byId.get('example:shared_anchor_aa')?.fanIn).toBe(30)
  })

  it('orders the whole ladder: exact, prefix, word, substring, values, letters', () => {
    const order = ids(searchGraph(INDEX, 'oak').hits)
    const at = (id: string): number => order.indexOf(id)
    expect(at('example:oak')).toBe(0)
    expect(tierOf(searchGraph(INDEX, 'oak').hits, 'example:oak_tree_canopy_large')).toBe('id-prefix')
    expect(tierOf(searchGraph(INDEX, 'oak').hits, 'example:swamp_oak_stand')).toBe('id-word')
    expect(tierOf(searchGraph(INDEX, 'oak').hits, 'example:cloak_of_leaves')).toBe('id-substring')
    expect(tierOf(searchGraph(INDEX, 'oak').hits, 'example:relay_beacon')).toBe('content')
    expect(tierOf(searchGraph(INDEX, 'oak').hits, 'example:overgrown_ancient_knot')).toBe('letters')
    expect(at('example:oak')).toBeLessThan(at('example:oak_tree_canopy_large'))
    expect(at('example:oak_tree_canopy_large')).toBeLessThan(at('example:swamp_oak_stand'))
    expect(at('example:swamp_oak_stand')).toBeLessThan(at('example:cloak_of_leaves'))
    expect(at('example:cloak_of_leaves')).toBeLessThan(at('example:relay_beacon'))
    expect(at('example:relay_beacon')).toBeLessThan(at('example:overgrown_ancient_knot'))
  })

  it('never lets a softer tier outrank a harder one, on any query', () => {
    // The invariant the ladder exists to guarantee, asserted structurally rather than one pair at
    // a time: the returned list is non-decreasing in rank.
    for (const query of ['oak', 'drip', 'patch', 'a', 'scatter', 'anchor', 'minecraft']) {
      const hits = searchGraph(INDEX, query, { limit: 400 }).hits
      for (let i = 1; i < hits.length; i++) {
        const before = hits[i - 1] as SearchHit
        const here = hits[i] as SearchHit
        expect(before.rank, `${query}: ${before.nodeId} then ${here.nodeId}`).toBeLessThanOrEqual(here.rank)
        expect(TIER_RANK[here.tier]).toBe(here.rank)
      }
    }
  })

  it('finds a node by a full id even when another node quotes that id in its own values', () => {
    const result = searchGraph(INDEX, 'example:oak')
    expect(result.hits[0]?.nodeId).toBe('example:oak')
    expect(result.hits[0]?.tier).toBe('exact-id')
    expect(ids(result.hits)).toContain('example:relay_beacon')
    expect(tierOf(result.hits, 'example:relay_beacon')).toBe('content')
  })
})

describe('ranking: finding a node by what is INSIDE it', () => {
  it('finds "the one with the dripleaf in it" when its name says nothing about dripleaf', () => {
    const result = searchGraph(INDEX, 'dripleaf', { limit: 400 })
    expect(ids(result.hits)).toContain('example:mossy_recess')
    expect(tierOf(result.hits, 'example:mossy_recess')).toBe('content')
    // ...and every node NAMED for it still comes first, which is the right way round: the values
    // are a way in, not a way of outranking the identifier.
    const named = ids(result.hits).filter((id) => id.includes('dripleaf'))
    expect(named.length).toBeGreaterThan(1)
    expect(result.hits[0]?.nodeId).toBe(named[0])
    for (const id of named) {
      expect(ids(result.hits).indexOf(id)).toBeLessThan(ids(result.hits).indexOf('example:mossy_recess'))
    }
  })

  it('will not search values on a term too short to mean anything', () => {
    // A one- or two-character term inside a values haystack matches most of the pack. Identifiers
    // are still searched, which is what a short term is actually for.
    const short = searchGraph(INDEX, 'ss', { limit: 4000 })
    expect(short.hits.every((h) => h.tier !== 'content' && h.tier !== 'letters')).toBe(true)
  })

  it('keeps a bounded haystack per node rather than the whole of its JSON', () => {
    const bloated: GraphWire = {
      nodes: [
        { id: 'example:huge', typeId: 'minecraft:ore_feature', fields: { list: Array.from({ length: 500 }, (_, i) => `block_number_${i}`) } },
      ],
      edges: [],
      roots: ['example:huge'],
    }
    const index = buildSearchIndex(bloated)
    expect(index.entries[0]?.content.length).toBeLessThanOrEqual(CONTENT_CHAR_BUDGET)
    expect(index.entries[0]?.contentClamped).toBe(true)
    expect(index.stats.clampedNodes).toBe(1)
    // The early part of the list is still searchable; the tail is honestly out of reach, which is
    // the trade the budget makes and reports.
    expect(searchGraph(index, 'block_number_3').total).toBe(1)
  })
})

describe('ranking: finding a feature by the group the author put it in', () => {
  // THE ONE NAME ON THIS CANVAS SOMEBODY CHOSE. A group is called "Surface Markers" because a
  // person decided it was, and Ctrl+F on that answered "Nothing in this pack matches" -- while
  // searching a MEMBER of the same group worked, and even reported the group in the status line
  // when it was collapsed. The box looked as though it knew about groups and had decided this one
  // did not exist. A group name is not on the wire; groups.ts reads it off the directive and the
  // panel hands it in. See SearchEntry.groupName.
  const GROUPED: GraphWire = {
    nodes: [
      { id: 'example:rng_marker', typeId: 'minecraft:single_block_feature', file: 'features/rng_marker.json' },
      { id: 'example:threshold_marker', typeId: 'minecraft:single_block_feature', file: 'features/threshold_marker.json' },
      { id: 'example:lonely', typeId: 'minecraft:single_block_feature', file: 'features/lonely.json' },
    ],
    edges: [],
    roots: ['example:rng_marker', 'example:threshold_marker', 'example:lonely'],
  }
  const NAMES = new Map([
    ['example:rng_marker', 'Surface Markers'],
    ['example:threshold_marker', 'Surface Markers'],
  ])
  const grouped = buildSearchIndex(GROUPED, { groupNames: NAMES })

  it('finds every member of a group by the group’s own name', () => {
    const result = searchGraph(grouped, 'Surface Markers')
    expect(ids(result.hits).sort()).toEqual(['example:rng_marker', 'example:threshold_marker'])
    expect(tierOf(result.hits, 'example:rng_marker')).toBe('group')
    // And it says WHY, because the highlighted id cannot: nothing in "rng_marker" spells
    // "Surface".
    expect(result.hits[0]?.detail.why).toMatch(/group it is in/)
    // The row names the group too, which is where revealing the hit will actually land when the
    // group is folded.
    expect(result.hits[0]?.detail.facts).toContain('in "Surface Markers"')
  })

  it('one word of the name is enough, and a node in no group is not dragged in', () => {
    expect(ids(searchGraph(grouped, 'markers').hits).sort()).toEqual(['example:rng_marker', 'example:threshold_marker'])
    expect(ids(searchGraph(grouped, 'surface').hits)).toEqual(['example:rng_marker', 'example:threshold_marker'])
    expect(ids(searchGraph(grouped, 'lonely').hits)).toEqual(['example:lonely'])
  })

  it('never outranks the identifier, and never loses to the file or the type', () => {
    // The group is a way IN, exactly as a value inside the feature is. A node actually named for
    // the term still comes first.
    const withNamed: GraphWire = {
      ...GROUPED,
      nodes: [...GROUPED.nodes, { id: 'example:surface', typeId: 'minecraft:single_block_feature', file: 'features/surface.json' }],
    }
    const index = buildSearchIndex(withNamed, { groupNames: NAMES })
    const hits = searchGraph(index, 'surface').hits
    expect(hits[0]?.nodeId).toBe('example:surface')
    expect(hits[0]?.tier).toBe('exact-id')
    expect(TIER_RANK.group).toBeGreaterThan(TIER_RANK['id-substring'])
    // ...but ABOVE the machine's own names for a thing. Somebody typing a group's name means the
    // group, not a path that happens to spell it.
    expect(TIER_RANK.group).toBeLessThan(TIER_RANK.type)
    expect(TIER_RANK.group).toBeLessThan(TIER_RANK.file)
  })

  it('costs nothing when the pack has no groups, which is most packs', () => {
    expect(INDEX.entries.every((e) => e.lowerGroup === '' && e.groupName === undefined)).toBe(true)
    expect(searchGraph(INDEX, 'surface markers').hits.every((h) => h.tier !== 'group')).toBe(true)
  })
})

describe('ranking: the tie-breaks, which are what a list of near-identical ids needs', () => {
  it('prefers the shorter name when two match equally well', () => {
    const order = ids(searchGraph(INDEX, 'spire').hits)
    expect(order.indexOf('example:spire_tall')).toBeLessThan(order.indexOf('example:spire_tall_extra_wide'))
    // Both really were the same tier -- otherwise this is testing the ladder, not the tie-break.
    const hits = searchGraph(INDEX, 'spire').hits
    expect(tierOf(hits, 'example:spire_tall')).toBe('id-prefix')
    expect(tierOf(hits, 'example:spire_tall_extra_wide')).toBe('id-prefix')
  })

  it('prefers the one more of the pack depends on when name length cannot decide', () => {
    const hits = searchGraph(INDEX, 'anchor').hits
    const order = ids(hits)
    expect(tierOf(hits, 'example:shared_anchor_aa')).toBe('id-word')
    expect(tierOf(hits, 'example:shared_anchor_bb')).toBe('id-word')
    expect(INDEX.byId.get('example:shared_anchor_aa')?.bareId.length).toBe(
      INDEX.byId.get('example:shared_anchor_bb')?.bareId.length,
    )
    // `bb` comes first in the graph's own node order, so this is fan-in winning against it.
    expect(INDEX.byId.get('example:shared_anchor_bb')?.order).toBeLessThan(
      INDEX.byId.get('example:shared_anchor_aa')?.order as number,
    )
    expect(order.indexOf('example:shared_anchor_aa')).toBeLessThan(order.indexOf('example:shared_anchor_bb'))
  })

  it('is completely deterministic, because the node order underneath it is', () => {
    const again = buildSearchIndex(GRAPH)
    for (const query of ['patch', 'a', 'is:root', 'type:scatter oak']) {
      expect(ids(searchGraph(again, query, { limit: 200 }).hits)).toEqual(ids(searchGraph(INDEX, query, { limit: 200 }).hits))
    }
  })
})

describe('ranking: several words mean all of them', () => {
  it('requires every term and ranks by the weakest one', () => {
    const both = searchGraph(INDEX, 'oak canopy')
    expect(ids(both.hits)).toEqual(['example:oak_tree_canopy_large'])
    expect(searchGraph(INDEX, 'oak nothinglikethis').total).toBe(0)
  })

  it('highlights every matched run in the identifier, merged and in order', () => {
    const hit = searchGraph(INDEX, 'oak canopy').hits[0] as SearchHit
    const marked = hit.ranges.map((r) => hit.nodeId.slice(r.start, r.end))
    expect(marked).toEqual(['oak', 'canopy'])
    for (let i = 1; i < hit.ranges.length; i++) {
      expect((hit.ranges[i] as { start: number }).start).toBeGreaterThan((hit.ranges[i - 1] as { end: number }).end - 1)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. A result has to say WHERE
// ---------------------------------------------------------------------------

describe('a result says what distinguishes it, not just its name', () => {
  it('names the type, the fan-in, the children and the file', () => {
    const hit = searchGraph(INDEX, 'example:shared_anchor_aa').hits[0] as SearchHit
    expect(hit.detail.kind).toBe('minecraft:single_block_feature')
    expect(hit.detail.facts).toContain('30 features delegate to it')
    expect(hit.detail.facts).toContain('places blocks itself')
    expect(hit.detail.facts).toContain('features/surface/anchor_aa.json')
    expect(describeHit(hit)).toContain('minecraft:single_block_feature')
  })

  it('says when a node is one of the pack\u2019s entry points', () => {
    const hit = searchGraph(INDEX, 'example:oak').hits[0] as SearchHit
    expect(INDEX.byId.get('example:oak')?.isRoot).toBe(true)
    expect(hit.detail.facts).toContain('nothing delegates to it')
  })

  it('calls a placement rule a placement rule rather than showing a synthetic type id', () => {
    const hit = searchGraph(INDEX, PACK.ruleIds[0] as string).hits[0] as SearchHit
    expect(hit.detail.kind).toBe('placement rule')
  })

  it('marks a row instead of repeating a paragraph on every one of them', () => {
    // The sentence is still the model's answer -- it is what the row announces and what the
    // footer prints -- but the chip is what a row DRAWS, and it is two or three words.
    const partial = searchGraph(INDEX, 'example:approximate_grove').hits[0] as SearchHit
    expect(partial.detail.chip).toBe('partly previewed')
    expect(SEARCH_CHIPS[partial.detail.chip as keyof typeof SEARCH_CHIPS]).toBe(partial.detail.warning)
    const broken = searchGraph(INDEX, 'example:missing_reference_0').hits[0] as SearchHit
    expect(broken.detail.chip).toBe('unresolved')
    const external = searchGraph(INDEX, 'minecraft:fern_feature').hits[0] as SearchHit
    expect(external.detail.chip).toBe('from the game')
    // An ordinary node is unmarked. A mark on every row is the repetition problem in one word.
    const ordinary = searchGraph(INDEX, 'example:oak').hits[0] as SearchHit
    expect(ordinary.detail.chip).toBe('')
  })

  it('explains the marks once, in the footer, and only the ones on screen', () => {
    const result = searchGraph(INDEX, 'example:missing_reference_0')
    const legend = chipLegend(result.hits)
    expect(legend).toContain('"unresolved"')
    expect(legend).toContain(SEARCH_CHIPS.unresolved)
    // Nothing in that result is a vanilla node, so the legend must not explain that mark.
    expect(legend).not.toContain('from the game')
    // Every chip the legend names is one a row actually carries.
    for (const chip of chipsInUse(result.hits)) expect(legend).toContain(`"${chip}"`)
    // And nothing to explain is nothing said, rather than an empty heading.
    expect(chipLegend([])).toBe('')
  })
  it('warns about the node kinds a preview will get wrong, and does not warn about the ones it will not', () => {
    const broken = searchGraph(INDEX, 'example:missing_reference_0').hits[0] as SearchHit
    expect(broken.detail.warning).toContain('defines nothing by this name')
    const external = searchGraph(INDEX, 'minecraft:fern_feature').hits[0] as SearchHit
    expect(external.detail.warning).toContain('works in game')
    const partial = searchGraph(INDEX, 'example:approximate_grove').hits[0] as SearchHit
    expect(partial.detail.warning).toContain('partly built')
    const ordinary = searchGraph(INDEX, 'example:oak').hits[0] as SearchHit
    expect(ordinary.detail.warning).toBe('')
  })

  it('says why a result is there when the highlighted name has not already said so', () => {
    expect((searchGraph(INDEX, 'dripleaf').hits.find((h) => h.nodeId === 'example:mossy_recess') as SearchHit).detail.why)
      .toContain('inside this feature')
    // ...and says nothing when the name itself is the answer, because the highlight already did.
    expect((searchGraph(INDEX, 'example:oak').hits[0] as SearchHit).detail.why).toBe('')
  })

  it('says a node is connected to nothing else, which on this pack is a great many of them', () => {
    const alone = INDEX.entries.find((e) => e.componentSize === 1)
    expect(alone).toBeDefined()
    const hit = searchGraph(INDEX, (alone as { id: string }).id).hits[0] as SearchHit
    expect(hit.detail.facts).toContain('connected to nothing else')
  })
})

// ---------------------------------------------------------------------------
// 4. Filters
// ---------------------------------------------------------------------------

describe('filters: what turns twenty identical ids into a choosable list', () => {
  it('scopes to a feature type, with or without the namespace', () => {
    const bare = searchGraph(INDEX, 'type:scatter', { limit: 4000 })
    const full = searchGraph(INDEX, 'type:minecraft:scatter_feature', { limit: 4000 })
    expect(bare.total).toBe(full.total)
    expect(bare.total).toBeGreaterThan(20)
    expect(bare.hits.every((h) => h.node.typeId === 'minecraft:scatter_feature')).toBe(true)
  })

  it('scopes to a file', () => {
    const result = searchGraph(INDEX, 'file:features/ceiling', { limit: 4000 })
    expect(result.total).toBeGreaterThan(1)
    expect(result.hits.every((h) => (h.node.file ?? '').includes('features/ceiling'))).toBe(true)
  })

  it('offers the properties somebody actually hunts by', () => {
    const count = (query: string): number => searchGraph(INDEX, query, { limit: 4000 }).total
    expect(count('is:root')).toBe(GRAPH.roots.length)
    expect(count('is:rule')).toBe(RULE_COUNT)
    expect(count('is:unresolved')).toBe(5)
    expect(count('is:external')).toBe(13)
    expect(count('is:cycle')).toBe(3)
    expect(count('is:shared')).toBeGreaterThan(400)
    expect(count('is:alone')).toBeGreaterThan(0)
    // Everything the preview will get wrong -- and NOT the thirteen the game provides, which are
    // not faults at all.
    const problems = searchGraph(INDEX, 'is:problem', { limit: 4000 })
    expect(problems.hits.every((h) => !(h.entry.external && !h.entry.unresolved))).toBe(true)
    expect(problems.total).toBeGreaterThanOrEqual(count('is:unresolved') + count('is:cycle'))
  })

  it('combines a filter with a term, and combines filters with each other', () => {
    const combined = searchGraph(INDEX, 'is:rule is:root', { limit: 4000 })
    expect(combined.total).toBe(RULE_COUNT)
    const withTerm = searchGraph(INDEX, 'type:tree oak', { limit: 4000 })
    expect(ids(withTerm.hits)).toContain('example:oak')
    expect(withTerm.hits.every((h) => (h.node.typeId ?? '').includes('tree'))).toBe(true)
  })

  it('says so out loud when it was asked for a filter it does not have', () => {
    // Silently ignoring a filter is worse than refusing it: the results look like an answer to a
    // question nobody asked.
    const parsed = parseQuery('is:haunted oak')
    expect(parsed.flags).toEqual([])
    expect(parsed.terms).toEqual(['oak'])
    expect(parsed.notes.join(' ')).toContain('is:haunted')
    expect(parsed.notes.join(' ')).toContain('root')
    expect(searchGraph(INDEX, 'is:haunted oak').notes.length).toBe(1)
    expect(parseQuery('type:').notes.length).toBe(1)
    expect(parseQuery('is:').notes.length).toBe(1)
  })

  it('has a sentence for every flag it offers', () => {
    for (const [flag, sentence] of Object.entries(SEARCH_FLAGS)) {
      expect(sentence.length, flag).toBeGreaterThan(20)
      expect(sentence.endsWith('.'), flag).toBe(true)
    }
  })

  it('returns nothing at all for an empty query rather than three thousand rows', () => {
    const empty = searchGraph(INDEX, '   ')
    expect(empty.hits).toEqual([])
    expect(empty.total).toBe(0)
    expect(empty.summary).toContain('is:root')
  })

  it('caps what it describes but never what it found', () => {
    const wide = searchGraph(INDEX, 'is:root')
    expect(wide.hits.length).toBe(DEFAULT_RESULT_LIMIT)
    expect(wide.truncated).toBe(true)
    // The canvas filter is built from `matchedIds`, so showing the top fifty must not narrow it.
    expect(wide.matchedIds.size).toBe(GRAPH.roots.length)
    expect(wide.summary).toContain(String(wide.total))
  })
})

// ---------------------------------------------------------------------------
// 5. Filtering the canvas
// ---------------------------------------------------------------------------

describe('filtering the canvas is the same predicate, described as a subgraph', () => {
  it('keeps only the matches, and only the edges between them', () => {
    const result = searchGraph(INDEX, 'is:rule', { limit: 4000 })
    const filter = filterGraph(INDEX, GRAPH, result.matchedIds, { scope: 'matches' })
    expect(filter.graph.nodes).toHaveLength(RULE_COUNT)
    // Rules delegate to features, not to each other, so nothing survives.
    expect(filter.graph.edges).toHaveLength(0)
    expect(filter.hiddenNodes).toBe(TARGET_NODES - RULE_COUNT)
    expect(filter.summary).toContain('hidden')
  })

  it('never keeps an edge with a hidden endpoint', () => {
    const result = searchGraph(INDEX, 'patch', { limit: 4000 })
    for (const scope of ['matches', 'neighbours', 'component'] as const) {
      const filter = filterGraph(INDEX, GRAPH, result.matchedIds, { scope })
      const visible = new Set(filter.graph.nodes.map((n) => n.id))
      for (const edge of filter.graph.edges) {
        // A line into nothing is how this canvas draws a genuinely broken reference. A filter that
        // produced one would be making the pack look broken.
        expect(visible.has(edge.from)).toBe(true)
        expect(visible.has(edge.to)).toBe(true)
      }
    }
  })

  it('grows to the neighbours, because a match with its parents hidden is a box in space', () => {
    const seeds = new Set(['example:shared_anchor_aa'])
    const one = filterGraph(INDEX, GRAPH, seeds, { scope: 'matches' })
    const grown = filterGraph(INDEX, GRAPH, seeds, { scope: 'neighbours', depth: 1 })
    expect(one.graph.nodes).toHaveLength(1)
    expect(grown.graph.nodes).toHaveLength(31)
    expect(grown.graph.edges).toHaveLength(30)
    const deeper = filterGraph(INDEX, GRAPH, seeds, { scope: 'neighbours', depth: 2 })
    expect(deeper.graph.nodes.length).toBeGreaterThan(grown.graph.nodes.length)
  })

  it('shows one whole drawing, which is the filter this pack needs most', () => {
    const alone = INDEX.entries.find((e) => e.componentSize === 1) as { id: string }
    expect(componentOf(INDEX, alone.id).size).toBe(1)
    const small = INDEX.entries.find((e) => e.componentSize === 5) as { id: string }
    const filter = filterGraph(INDEX, GRAPH, new Set([small.id]), { scope: 'component' })
    expect(filter.graph.nodes).toHaveLength(5)
    expect(componentOf(INDEX, 'no such node').size).toBe(0)
  })

  it('carries the roots and the loops through the filter, and keeps the wire order', () => {
    const result = searchGraph(INDEX, 'is:cycle', { limit: 4000 })
    const filter = filterGraph(INDEX, GRAPH, result.matchedIds, { scope: 'matches' })
    expect(filter.graph.cycles).toHaveLength(1)
    expect(filter.graph.roots.every((id) => filter.visible.has(id))).toBe(true)
    const order = filter.graph.nodes.map((n) => n.id)
    const inWireOrder = GRAPH.nodes.filter((n) => filter.visible.has(n.id)).map((n) => n.id)
    expect(order).toEqual(inWireOrder)
  })

  it('mutates nothing it was handed', () => {
    const before = { nodes: GRAPH.nodes.length, edges: GRAPH.edges.length, roots: GRAPH.roots.length }
    const snapshot = JSON.stringify(GRAPH.nodes[0])
    filterGraph(INDEX, GRAPH, new Set(['example:oak']), { scope: 'neighbours', depth: 3 })
    expect({ nodes: GRAPH.nodes.length, edges: GRAPH.edges.length, roots: GRAPH.roots.length }).toEqual(before)
    expect(JSON.stringify(GRAPH.nodes[0])).toBe(snapshot)
  })
})

// ---------------------------------------------------------------------------
// 6. The keyboard, tested without a browser because it is a reducer
// ---------------------------------------------------------------------------

describe('the keyboard, which is the whole point of this feature', () => {
  const start: SearchBoxState = { query: 'oak', activeIndex: 0, filtered: false }

  it('moves, wraps, and pages', () => {
    expect(applyKey(start, { key: 'ArrowDown' }, 5).state.activeIndex).toBe(1)
    expect(applyKey(start, { key: 'ArrowUp' }, 5).state.activeIndex).toBe(4)
    expect(applyKey(start, { key: 'PageDown' }, 50).state.activeIndex).toBe(10)
    expect(applyKey({ ...start, activeIndex: 4 }, { key: 'PageUp' }, 50).state.activeIndex).toBe(44)
  })

  it('leaves bare Home and End to the caret, and takes them with Ctrl', () => {
    // The palette takes bare Home/End because it has no text worth editing. This box holds a query
    // somebody is in the middle of typing, so stealing the keys that reach the ends of it would
    // make a typo at the front unfixable without the mouse.
    expect(applyKey(start, { key: 'Home' }, 5).action.kind).toBe('passthrough')
    expect(applyKey(start, { key: 'End' }, 5).action.kind).toBe('passthrough')
    expect(applyKey(start, { key: 'Home', ctrlKey: true }, 5).state.activeIndex).toBe(0)
    expect(applyKey(start, { key: 'End', ctrlKey: true }, 5).state.activeIndex).toBe(4)
  })

  it('goes to a result on Enter and stays in the box, so Enter can be pressed again', () => {
    const first = applyKey(start, { key: 'Enter' }, 5)
    expect(first.action).toEqual({ kind: 'reveal', index: 0 })
    const moved = applyKey(first.state, { key: 'ArrowDown' }, 5)
    expect(applyKey(moved.state, { key: 'Enter' }, 5).action).toEqual({ kind: 'reveal', index: 1 })
  })

  it('walks the matches on F3 without looking at the list at all', () => {
    const next = applyKey(start, { key: 'F3' }, 5)
    expect(next.action).toEqual({ kind: 'reveal', index: 1 })
    expect(applyKey(next.state, { key: 'F3', shiftKey: true }, 5).action).toEqual({ kind: 'reveal', index: 0 })
  })

  it('filters the canvas on Alt+Enter and refuses to on an empty result set', () => {
    const filtered = applyKey(start, { key: 'Enter', altKey: true }, 5)
    expect(filtered.action).toEqual({ kind: 'filter' })
    expect(filtered.state.filtered).toBe(true)
    // Ctrl+Enter does the same: which of the two somebody reaches for is a habit, and a binding
    // that works under one hand and not the other is a binding people stop trusting.
    expect(applyKey(start, { key: 'Enter', ctrlKey: true }, 5).action).toEqual({ kind: 'filter' })
    expect(applyKey(start, { key: 'Enter', altKey: true }, 0).action).toEqual({ kind: 'none' })
  })

  it('unwinds one layer at a time on Escape: the filter, then the query, then focus', () => {
    const filtered: SearchBoxState = { query: 'oak', activeIndex: 0, filtered: true }
    const one = applyKey(filtered, { key: 'Escape' }, 5)
    expect(one.action).toEqual({ kind: 'clear-filter' })
    expect(one.state.filtered).toBe(false)
    expect(one.state.query).toBe('oak')
    const two = applyKey(one.state, { key: 'Escape' }, 5)
    expect(two.action).toEqual({ kind: 'clear-query' })
    expect(two.state.query).toBe('')
    expect(applyKey(two.state, { key: 'Escape' }, 0).action).toEqual({ kind: 'close' })
  })

  it('passes every ordinary key through, because this is first a text field', () => {
    for (const key of ['a', 'Backspace', 'ArrowLeft', 'ArrowRight', ':', 'Tab']) {
      expect(applyKey(start, { key }, 5).action.kind, key).toBe('passthrough')
    }
  })

  it('does not point at a result that is not there', () => {
    expect(applyKey(start, { key: 'ArrowDown' }, 0).state.activeIndex).toBe(-1)
    expect(applyKey({ ...start, activeIndex: -1 }, { key: 'Enter' }, 0).action).toEqual({ kind: 'none' })
  })
})

// ---------------------------------------------------------------------------
// 7. What it costs at this size
// ---------------------------------------------------------------------------

function medianMs(runs: number, body: () => void): number {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    body()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)] as number
}

/** The same search with no index at all: lowercase and split on every keystroke, which is what a
 * straightforward implementation does. Here to answer "is the index worth keeping" with a number
 * rather than with an opinion. */
function naiveSearch(graph: GraphWire, query: string): string[] {
  const q = query.toLowerCase()
  const out: string[] = []
  for (const node of graph.nodes) {
    const haystack = `${node.id} ${node.typeId ?? ''} ${node.file ?? ''} ${JSON.stringify(node.fields ?? {})}`.toLowerCase()
    if (haystack.includes(q)) out.push(node.id)
  }
  return out
}

describe('what it costs on 3531 nodes -- measured, not assumed', () => {
  it('rebuilds the whole index fast enough to do it on every save', () => {
    const build = medianMs(15, () => {
      buildSearchIndex(GRAPH)
    })
    const stats = INDEX.stats
    // eslint-disable-next-line no-console
    console.log(
      `[search] index over ${stats.nodes} nodes / ${stats.edges} edges: ${build.toFixed(2)} ms median, ` +
        `${stats.components} drawings, ${(stats.contentChars / 1024).toFixed(0)} KiB of value text, ` +
        `${stats.clampedNodes} node(s) clamped at ${CONTENT_CHAR_BUDGET} chars`,
    )
    // The budget is one reload, not one frame: this runs when the pack changes, not when a key is
    // pressed. Set well above the measured figure so a slow CI box does not fail the build over
    // something that is not a regression.
    expect(build).toBeLessThan(250)
  })

  it('answers the worst query it can be given inside one animation frame', () => {
    // In order: a single letter, which matches nearly every node and therefore does the most
    // sorting; a term that exists only in values, which is the one that has to scan every
    // haystack; a subsequence, which falls all the way down the ladder on every node; a pure
    // filter; and the ordinary case of a name somebody typed.
    const queries = ['a', 'dripleaf', 'drplf', 'is:root type:scatter', 'example:oak', 'oak canopy']
    const measured: string[] = []
    for (const query of queries) {
      const ms = medianMs(40, () => {
        searchGraph(INDEX, query)
      })
      measured.push(`${JSON.stringify(query)} ${ms.toFixed(2)} ms`)
      expect(ms, `${query} is too slow to run on every keystroke`).toBeLessThan(50)
    }
    // eslint-disable-next-line no-console
    console.log(`[search] query medians over ${INDEX.stats.nodes} nodes: ${measured.join(', ')}`)
  })

  it('is faster than doing it without an index, which is what the index is for', () => {
    const indexed = medianMs(40, () => {
      searchGraph(INDEX, 'dripleaf', { limit: 4000 })
    })
    const naive = medianMs(40, () => {
      naiveSearch(GRAPH, 'dripleaf')
    })
    // eslint-disable-next-line no-console
    console.log(`[search] one query: ${indexed.toFixed(2)} ms indexed vs ${naive.toFixed(2)} ms with no index`)
    expect(indexed).toBeLessThan(naive)
  })

  it('costs no more to filter the canvas than to search it', () => {
    const result = searchGraph(INDEX, 'patch', { limit: 4000 })
    const ms = medianMs(20, () => {
      filterGraph(INDEX, GRAPH, result.matchedIds, { scope: 'neighbours' })
    })
    // eslint-disable-next-line no-console
    console.log(`[search] canvas filter over ${result.total} matches: ${ms.toFixed(2)} ms median`)
    expect(ms).toBeLessThan(80)
  })
})

// ---------------------------------------------------------------------------
// 8. The stylesheet
// ---------------------------------------------------------------------------

describe('the stylesheet follows the same three rules as the canvas and the menu', () => {
  /** Everything above the first blank line after the variable block is where colours may be
   * spelled; everything below reads variables only. */
  function bodyOfStylesheet(): string {
    const marker = SEARCH_STYLESHEET.indexOf('display: flex;')
    expect(marker).toBeGreaterThan(0)
    return SEARCH_STYLESHEET.slice(marker)
  }

  it('reads every colour it uses out of a --vscode-* property, however many steps away', () => {
    // A token may now be DERIVED from other tokens -- `--fls-fg-dim` is this panel's own
    // foreground faded towards its own background, which is how a "quieter, but still legible"
    // grey is obtained without borrowing the host's `descriptionForeground` (60% alpha in the
    // light default, 3.40:1 once it resolves). So "contains var(--vscode-" is no longer the
    // right question; "does every path out of this token end at a --vscode-* property" is, and
    // it is the question the rule always meant to ask. A hard-coded colour still fails, a token
    // that references a token that references the host still passes, and a token that
    // references one that does not exist fails rather than silently rendering as nothing.
    const declared = new Map<string, string>()
    for (const match of SEARCH_STYLESHEET.matchAll(/(--fls-[a-z-]+):\s*([^;]+);/g)) declared.set(match[1]!, match[2]!)
    expect(declared.size).toBeGreaterThan(15)

    function resolvesToTheHost(value: string, seen: Set<string>): boolean {
      if (value.includes('var(--vscode-')) return true
      const references = [...value.matchAll(/var\((--fls-[a-z-]+)/g)].map((m) => m[1]!)
      if (references.length === 0) return false
      return references.some((name) => {
        if (seen.has(name)) return false
        seen.add(name)
        const next = declared.get(name)
        return next !== undefined && resolvesToTheHost(next, seen)
      })
    }

    for (const [name, value] of declared) {
      expect(resolvesToTheHost(value, new Set([name])), `${name} does not resolve to a --vscode-* property`).toBe(true)
    }
  })

  it('spells no raw colour below the variable block', () => {
    const body = bodyOfStylesheet()
    const raw = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)].map((m) => m[0])
    expect(raw, 'a hard-coded colour looks right in exactly the one theme its author was using').toEqual([])
  })

  it('uses only --fls-* variables below the block, never a --vscode-* one directly', () => {
    const body = bodyOfStylesheet()
    expect([...body.matchAll(/var\(--vscode-[a-z-]+/gi)].map((m) => m[0])).toEqual([])
  })

  it('hides the panel\u2019s optional parts with [hidden] rather than leaving them visible', () => {
    expect(SEARCH_STYLESHEET).toContain('.fls-clear[hidden]')
    expect(SEARCH_STYLESHEET).toContain('.fls-notes[hidden]')
  })
})

// ---------------------------------------------------------------------------
// 9. The language guard -- mirrored from graphPalette.test.ts / docsLanguage.test.ts
// ---------------------------------------------------------------------------

function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(d, 'go.mod'))) return d
    const parent = dirname(d)
    if (parent === d) throw new Error('no go.mod above the test directory')
    d = parent
  }
}

const SEARCH_SOURCE = readFileSync(searchPath, 'utf8')

// Tooling words that must never appear in user-facing text, and the Go guard's patterns -- read
// from features/userfacing_strings_test.go via fixtures/languageGuard.ts.
const GO_GUARD = readGoGuard()
const BANNED_WORDS = GO_GUARD.words
const ADDRESS_PATTERN = GO_GUARD.address
const SYMBOL_PATTERN = GO_GUARD.qualifiedName
/** A `namespace:id` that is neither Minecraft's own nor the sample namespace this project uses. */
const FOREIGN_NAMESPACE_PATTERN = /\b(?!minecraft:|example:)[a-z][a-z0-9_]{2,}:[a-z][a-z0-9_]+\b/

/** The strings the RENDERER authors -- the placeholder, the accessible names, the footer hint.
 *
 * They are never returned by the model, so scanning only the model's output would leave the prose
 * a user reads FIRST unguarded. They are collected in one exported record in the module precisely
 * so this guard can reach them; a literal written inline in a DOM call cannot be scanned, which is
 * the whole reason the record exists. */
function rendererStrings(): { location: string; text: string }[] {
  return Object.entries(SEARCH_STRINGS).map(([key, text]) => ({ location: `string ${key}`, text }))
}

/** The guard must be looking at the real record and not at a stale copy, so every value in it is
 * also asserted to appear verbatim in the module's own source. */
function rendererStringsAreUsed(): string[] {
  return Object.entries(SEARCH_STRINGS)
    .filter(([, text]) => !SEARCH_SOURCE.includes(text))
    .map(([key]) => key)
}

/** Every string a user can read that this module composes from the graph. Run over the generated
 * pack, which uses the sample namespace throughout -- so the interpolated sentences are scanned as
 * they will actually be read, not as templates with the data taken out. */
function describedStrings(): { location: string; text: string }[] {
  const out: { location: string; text: string }[] = []
  for (const [flag, sentence] of Object.entries(SEARCH_FLAGS)) out.push({ location: `flag ${flag}`, text: sentence })
  const queries = [
    'oak', 'dripleaf', 'is:rule', 'is:unresolved', 'is:external', 'is:cycle', 'is:problem',
    'type:scatter', 'file:features', 'is:haunted', 'type:', '', 'nothinglikethis',
    'example:approximate_grove', 'minecraft:fern_feature', 'example:missing_reference_0',
  ]
  for (const query of queries) {
    const result = searchGraph(INDEX, query)
    out.push({ location: `summary ${JSON.stringify(query)}`, text: result.summary })
    for (const note of result.notes) out.push({ location: `note ${JSON.stringify(query)}`, text: note })
    for (const hit of result.hits.slice(0, 6)) {
      out.push({ location: `${hit.nodeId} kind`, text: hit.detail.kind })
      for (const fact of hit.detail.facts) out.push({ location: `${hit.nodeId} fact`, text: fact })
      if (hit.detail.why.length > 0) out.push({ location: `${hit.nodeId} why`, text: hit.detail.why })
      if (hit.detail.warning.length > 0) out.push({ location: `${hit.nodeId} warning`, text: hit.detail.warning })
      out.push({ location: `${hit.nodeId} line`, text: describeHit(hit) })
    }
    for (const scope of ['matches', 'neighbours', 'component'] as const) {
      out.push({
        location: `filter ${scope} ${JSON.stringify(query)}`,
        text: filterGraph(INDEX, GRAPH, result.matchedIds, { scope }).summary,
      })
    }
  }
  return out
}

const SCANNED = [...describedStrings(), ...rendererStrings()]

describe('the language guard is looking at something', () => {
  it('read a real vocabulary out of the Go guard', () => {
    expect(BANNED_WORDS.length).toBeGreaterThanOrEqual(5)
    expect(BANNED_WORDS).toContain(TOOLING_WORDS[0])
    expect(BANNED_WORDS).toContain(word('v', 'table'))
    expect(SYMBOL_PATTERN.source).toContain('::')
  })

  it('is scanning the whole surface and not an empty list', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(150)
    expect(SCANNED.every((s) => s.text.length > 0)).toBe(true)
    expect(SCANNED.some((s) => s.location.startsWith('flag '))).toBe(true)
    expect(SCANNED.some((s) => s.location.includes('warning'))).toBe(true)
    expect(SCANNED.some((s) => s.location.startsWith('filter '))).toBe(true)
    // And it really did reach the renderer's own prose -- the strings a user reads before any
    // result exists.
    expect(SCANNED.some((s) => s.text.includes('Find a feature'))).toBe(true)
    expect(rendererStringsAreUsed(), 'every scanned string must still be one the panel draws').toEqual([])
  })

  it('actually rejects the things it is meant to reject', () => {
    expect(BANNED_WORDS.some((w) => REJECT_SAMPLES.word.includes(w))).toBe(true)
    expect(ADDRESS_PATTERN.test(REJECT_SAMPLES.hexToken)).toBe(true)
    expect(SYMBOL_PATTERN.test('ScatterFeature::place')).toBe(true)
    expect(SOURCE_FILE_PATTERN.test('see coverage.go')).toBe(true)
    expect(ABSOLUTE_PATH_PATTERN.test('C:\\some\\path')).toBe(true)
    expect(FOREIGN_NAMESPACE_PATTERN.test('somepack:oak_tree')).toBe(true)
    expect(FOREIGN_NAMESPACE_PATTERN.test('minecraft:scatter_feature')).toBe(false)
    expect(FOREIGN_NAMESPACE_PATTERN.test('example:oak_tree')).toBe(false)
    expect(SYMBOL_PATTERN.test('Nothing delegates to it, so it is where reading the pack starts.')).toBe(false)
  })
})

describe('strings this panel shows state behaviour only', () => {
  it('uses none of the banned vocabulary', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      for (const word of [...BANNED_WORDS, ...EXTRA_BANNED_WORDS]) {
        if (text.includes(word)) leaks.push(`${location}: contains ${JSON.stringify(word)}`)
      }
    }
    expect(
      leaks,
      'a result must say what the engine DOES, never how that was established. Rewrite the\n' +
        'sentence in terms of the behaviour an author can see in a generated chunk.',
    ).toEqual([])
  })

  it('carries no address-shaped token and names no engine symbol', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      if (ADDRESS_PATTERN.test(text)) leaks.push(`${location}: address-shaped token`)
      if (SYMBOL_PATTERN.test(text)) leaks.push(`${location}: names a symbol`)
    }
    expect(leaks).toEqual([])
  })

  it('cites no source file and no path off this machine', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      if (SOURCE_FILE_PATTERN.test(text)) leaks.push(`${location}: cites a source file`)
      if (ABSOLUTE_PATH_PATTERN.test(text)) leaks.push(`${location}: contains a local path`)
    }
    expect(leaks, 'this panel ships to people who have none of these files.').toEqual([])
  })

  it('names no pack\u2019s namespace but Minecraft\u2019s own and the sample one', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      if (FOREIGN_NAMESPACE_PATTERN.test(text)) leaks.push(`${location}: ${JSON.stringify(text)}`)
    }
    expect(leaks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 10. The DOM, in real Chromium
// ---------------------------------------------------------------------------

const DARK_THEME: Record<string, string> = {
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-input-background': '#3c3c3c',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-focusBorder': '#007fd4',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-editor-findMatchHighlightBackground': 'rgb(234, 92, 0)',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-textPreformat-foreground': '#ce9178',
}

/** VS Code's Light Modern.
 *
 * `#3b3b3b99` is not a typo: VS Code registers `descriptionForeground` as the theme's own
 * foreground at 60% alpha, and in a light theme that resolves to a grey which measured 3.48:1
 * on this panel's footer -- the one line that says what the keyboard does here and how much of
 * what was found is on screen. Written with the alpha byte on, because flattening it by hand is
 * exactly the step the stylesheet cannot do for itself. */
const LIGHT_MODERN_THEME: Record<string, string> = {
  ...DARK_THEME,
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-descriptionForeground': '#3b3b3b99',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-list-activeSelectionBackground': '#005fb8',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-textPreformat-foreground': '#a31515',
}

/** Asks the page for raw strings only -- the element's colour, and every background and opacity
 * above it, root first -- so the compositing can be done here, where it is type-checked. */
const READ_COLOUR_STACK = `(selector) => {
  const el = document.querySelector(selector)
  if (el === null) return null
  const stack = []
  for (let n = el; n !== null; n = n.parentElement) {
    const s = getComputedStyle(n)
    stack.push({ background: s.backgroundColor, opacity: s.opacity })
  }
  return { colour: getComputedStyle(el).color, stack: stack.reverse() }
}`

/** `rgb()`, `rgba()` and `color(srgb r g b / a)` -- the last being what a browser answers for
 * anything that went through `color-mix()`, which is every derived colour in this stylesheet. */
function parseCssColour(value: string): [number, number, number, number] {
  const mix = /color\(srgb ([^)]+)\)/.exec(value)
  if (mix !== null) {
    const n = mix[1]!.split(/[\s/]+/).filter((part) => part !== '').map(Number)
    return [n[0]! * 255, n[1]! * 255, n[2]! * 255, n[3] ?? 1]
  }
  const plain = /rgba?\(([^)]+)\)/.exec(value)
  if (plain === null) return [0, 0, 0, 0]
  const n = plain[1]!.split(/[\s,/]+/).filter((part) => part !== '').map(Number)
  return [n[0]!, n[1]!, n[2]!, n[3] ?? 1]
}

/** WCAG 2.x contrast, over the colour the text is really seen in and the colour really behind
 * it. Composited the way a compositor does: root first, every alpha and every `opacity`. */
function contrastOf(read: { colour: string; stack: { background: string; opacity: string }[] }): number {
  const over = (src: readonly number[], back: readonly number[], a: number): number[] => [
    src[0]! * a + back[0]! * (1 - a),
    src[1]! * a + back[1]! * (1 - a),
    src[2]! * a + back[2]! * (1 - a),
  ]
  let background: number[] = [255, 255, 255]
  let alpha = 1
  for (const layer of read.stack) {
    const layerOpacity = Number(layer.opacity)
    alpha *= Number.isFinite(layerOpacity) ? layerOpacity : 1
    const bg = parseCssColour(layer.background)
    if (bg[3] > 0) background = over(bg, background, bg[3] * alpha)
  }
  const fg = parseCssColour(read.colour)
  const foreground = over(fg, background, fg[3] * alpha)
  const luminance = (c: readonly number[]): number => {
    const channel = (v: number): number => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(c[0]!) + 0.7152 * channel(c[1]!) + 0.0722 * channel(c[2]!)
  }
  const la = luminance(foreground)
  const lb = luminance(background)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** A small graph for the browser half: the DOM is what is under test here, and shipping 3531
 * nodes through `page.evaluate` would be testing the serialiser. */
function smallGraph(): GraphWire {
  const nodes = SPECIALS.map((n) => ({ ...n }))
  const edges: GraphEdgeWire[] = [
    { from: 'example:relay_beacon', to: 'example:oak_tree_canopy_large', kind: 'sequence', jsonPath: 'features[0]', ordinal: 0, required: false },
    { from: 'example:relay_beacon', to: 'example:swamp_oak_stand', kind: 'sequence', jsonPath: 'features[1]', ordinal: 1, required: false },
  ]
  const incoming = new Set(edges.map((e) => e.to))
  return { nodes, edges, roots: nodes.map((n) => n.id).filter((id) => !incoming.has(id)) }
}

async function bundleHarness(): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from ${JSON.stringify(searchPath.replace(/\\/g, '/'))}`,
      resolveDir: dir,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling the search harness')
  return output.text
}

interface Recorded {
  reveal: string[]
  preview: (string | null)[]
  filter: (number | null)[]
  closed: number
}

describe('search panel: real Chromium, the keyboard and the theme', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string

  beforeAll(async () => {
    moduleSource = await bundleHarness()
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/search.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0}#host{position:absolute;left:0;top:0;width:360px;bottom:0;display:flex}
#host > .fls-search{flex:1 1 auto}</style>
</head><body><div id="host"></div>
<script type="module">import * as m from '/search.js'; window.FLS = m; window.__ready = true;</script>
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
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  async function load(theme: Record<string, string> = DARK_THEME): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 640, height: 900 } })
    await page.goto(`http://${'127.0.0.1'}:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 10_000 })
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    }, theme)
    await page.evaluate((graph) => {
      const api = (window as unknown as { FLS: Record<string, unknown> }).FLS
      const index = (api.buildSearchIndex as (g: unknown) => unknown)(graph)
      const log: Recorded = { reveal: [], preview: [], filter: [], closed: 0 }
      ;(window as unknown as { log: Recorded }).log = log
      const box = (api.createSearchBox as (o: unknown) => unknown)({
        index,
        graph,
        container: document.getElementById('host') as HTMLElement,
        onReveal: (hit: { nodeId: string }) => log.reveal.push(hit.nodeId),
        onPreview: (hit: { nodeId: string } | null) => log.preview.push(hit ? hit.nodeId : null),
        onFilter: (filter: { graph: { nodes: unknown[] } } | null) => log.filter.push(filter ? filter.graph.nodes.length : null),
        onClose: () => {
          log.closed++
        },
      })
      ;(window as unknown as { box: unknown }).box = box
      ;(box as { focus(): void }).focus()
    }, graph)
    return page
  }

  const graph = smallGraph()
  const log = (page: Page) => page.evaluate(() => (window as unknown as { log: Recorded }).log)

  it('finds, highlights and goes to a node without the mouse ever being used', async () => {
    const page = await load()
    try {
      await page.keyboard.type('oak')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      // The first row is the exact match, and the run somebody typed is marked inside it.
      expect(await page.locator('.fls-row').first().getAttribute('data-node-id')).toBe('example:oak')
      // An EXACT match marks the whole identifier, because the whole identifier is what matched.
      expect(await page.locator('.fls-row').first().locator('mark').first().textContent()).toBe('example:oak')
      // A partial one marks only the run that was typed.
      expect(
        await page.locator('.fls-row[data-node-id="example:oak_tree_canopy_large"] mark').first().textContent(),
      ).toBe('oak')
      // The active row is announced through the input, which keeps typing working.
      const active = await page.locator('.fls-input').getAttribute('aria-activedescendant')
      expect(active).toBe(await page.locator('.fls-row').first().getAttribute('id'))
      await page.keyboard.press('Enter')
      expect((await log(page)).reveal).toEqual(['example:oak'])
      // Arrow down, Enter again: the camera walks the matches and focus never leaves the box.
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      const after = await log(page)
      expect(after.reveal).toEqual(['example:oak', 'example:oak_tree_canopy_large'])
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('fls-input')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('the footer reads at 4.5:1 in both default themes', async () => {
    // The footer was measured at 3.48:1 in Light Modern, where `descriptionForeground` arrives
    // as the theme's foreground at 60% alpha. It is the line that says what Enter and Escape do
    // and how much of what was found is on screen -- body text, in a 0.85em run, which is not
    // large text by any reading of the rule. Measured rather than compared against a hex,
    // because the failure is invisible until the alpha is resolved over a real background.
    for (const theme of [DARK_THEME, LIGHT_MODERN_THEME]) {
      const page = await load(theme)
      try {
        await page.keyboard.type('oak')
        await page.locator('.fls-foot').waitFor({ state: 'visible', timeout: 4000 })
        for (const selector of ['.fls-foot', '.fls-foot-note']) {
          const read = (await page.evaluate(`(${READ_COLOUR_STACK})(${JSON.stringify(selector)})`)) as
            | { colour: string; stack: { background: string; opacity: string }[] }
            | null
          if (read === null) continue
          const ratio = contrastOf(read)
          expect(ratio, `${selector} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        }
      } finally {
        await page.close()
      }
    }
  }, 45_000)

  it('shows what distinguishes each result, not just a column of identifiers', async () => {
    const page = await load()
    try {
      await page.keyboard.type('anchor')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      // Two results whose names differ by two characters. What tells them apart is everything
      // else on the row.
      expect(await page.locator('.fls-row').count()).toBe(2)
      const row = page.locator('.fls-row[data-node-id="example:shared_anchor_aa"]')
      const facts = await row.locator('.fls-row-facts').textContent()
      expect(facts).toContain('minecraft:single_block_feature')
      expect(facts).toContain('features/surface/anchor_aa.json')
      const label = await row.getAttribute('aria-label')
      expect(label).toContain('example:shared_anchor_aa')
      expect(label).toContain('minecraft:single_block_feature')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('filters the canvas on Alt+Enter and puts it back on Escape, one layer at a time', async () => {
    const page = await load()
    try {
      await page.keyboard.type('oak')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      await page.keyboard.press('Alt+Enter')
      const filtered = await log(page)
      expect(filtered.filter.length).toBe(1)
      expect(filtered.filter[0]).toBeGreaterThan(0)
      expect(filtered.filter[0]).toBeLessThan(graph.nodes.length)
      await page.keyboard.press('Escape')
      expect((await log(page)).filter).toEqual([filtered.filter[0], null])
      // The query survives the first Escape; the second clears it; the third gives up focus.
      expect(await page.locator('.fls-input').inputValue()).toBe('oak')
      await page.keyboard.press('Escape')
      expect(await page.locator('.fls-input').inputValue()).toBe('')
      await page.keyboard.press('Escape')
      expect((await log(page)).closed).toBe(1)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('says out loud when it was handed a filter it does not have', async () => {
    const page = await load()
    try {
      await page.keyboard.type('is:haunted oak')
      await page.locator('.fls-notes').waitFor({ state: 'visible', timeout: 4000 })
      expect(await page.locator('.fls-notes').textContent()).toContain('is:haunted')
      // And when nothing matched, the footer does not go on to say what Enter would do.
      await page.locator('.fls-input').fill('nothinglikethisexists')
      await page.locator('.fls-empty').waitFor({ state: 'visible', timeout: 4000 })
      const foot = (await page.locator('.fls-foot').textContent()) ?? ''
      expect(foot).toContain('Nothing in this pack matches')
      expect(foot).not.toContain('Enter goes there')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('takes every colour from the theme the host injected', async () => {
    const page = await load()
    try {
      await page.keyboard.type('oak')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      const colours = await page.evaluate(() => {
        const row = document.querySelector('.fls-row.fls-active') as HTMLElement
        const mark = document.querySelector('.fls-row-id mark') as HTMLElement
        const panel = document.querySelector('.fls-search') as HTMLElement
        return {
          active: getComputedStyle(row).backgroundColor,
          mark: getComputedStyle(mark).backgroundColor,
          panel: getComputedStyle(panel).backgroundColor,
        }
      })
      expect(colours.active).toBe('rgb(4, 57, 94)')
      expect(colours.mark).toBe('rgb(234, 92, 0)')
      expect(colours.panel).toBe('rgb(37, 37, 38)')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('draws one chip per row and not one paragraph per row', async () => {
    const page = await load()
    try {
      // A query that matches many rows of the same kind is the case that broke: every one of them
      // used to carry the same two-line sentence, thirty times down a 360px column.
      await page.keyboard.type('example:')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      const rows = await page.locator('.fls-row').count()
      expect(rows).toBeGreaterThan(3)

      // No row anywhere carries the paragraph any more.
      expect(await page.locator('.fls-row-warning').count()).toBe(0)
      // And no row carries more than one mark: the chip is a summary, not a badge collection.
      for (let i = 0; i < rows; i++) {
        expect(await page.locator('.fls-row').nth(i).locator('.fls-row-chip').count()).toBeLessThanOrEqual(1)
      }

      // The long sentence is said once, below the count, for the marks that are on screen.
      const marked = page.locator('.fls-row .fls-row-chip').first()
      if ((await marked.count()) > 0) {
        const chip = (await marked.textContent()) ?? ''
        expect(chip.length).toBeLessThan(20)
        const legend = (await page.locator('.fls-foot-note').textContent()) ?? ''
        expect(legend).toContain(`"${chip}"`)
        // Once. The whole point is that N rows do not become N copies of it.
        expect(await page.locator('.fls-foot-note').count()).toBe(1)
      }

      // The count line reviewers liked is untouched, and still above the legend.
      expect(await page.locator('.fls-foot').textContent()).toMatch(/match/i)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('keeps every row the same height whether or not it carries a chip', async () => {
    const page = await load()
    try {
      await page.keyboard.type('example:')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      // A chip that made its row taller would make the list jump as somebody typed, which is the
      // thing that makes a result list impossible to aim at.
      const heights = await page.evaluate(() => {
        const out: { chip: boolean; height: number }[] = []
        for (const row of document.querySelectorAll('.fls-row')) {
          out.push({ chip: row.querySelector('.fls-row-chip') !== null, height: Math.round(row.getBoundingClientRect().height) })
        }
        return out
      })
      const withChip = heights.filter((h) => h.chip).map((h) => h.height)
      const without = heights.filter((h) => !h.chip).map((h) => h.height)
      if (withChip.length > 0 && without.length > 0) {
        // Within a line: a chip adds its own line, but never a paragraph's worth.
        expect(Math.max(...withChip) - Math.min(...without)).toBeLessThan(40)
      }
    } finally {
      await page.close()
    }
  }, 45_000)
  it('keeps what was typed when the pack is reloaded under it', async () => {
    const page = await load()
    try {
      await page.keyboard.type('oak')
      await page.locator('.fls-row').first().waitFor({ state: 'visible', timeout: 4000 })
      const before = await page.locator('.fls-row').count()
      await page.evaluate((g) => {
        const api = (window as unknown as { FLS: Record<string, unknown> }).FLS
        const box = (window as unknown as { box: { setSource(i: unknown, g: unknown): void } }).box
        box.setSource((api.buildSearchIndex as (x: unknown) => unknown)(g), g)
      }, graph)
      expect(await page.locator('.fls-input').inputValue()).toBe('oak')
      expect(await page.locator('.fls-row').count()).toBe(before)
    } finally {
      await page.close()
    }
  }, 45_000)
})
