// search.ts -- finding one feature in a pack with thousands of them.
//
// WHY THIS EXISTS. The canvas was built and judged on a 57-node sample, where every navigation
// problem is solved by looking. A large pack has thousands of nodes and edges and dozens
// of entry points; the overview panel lists twelve of those and says "and N more"; the camera opens
// on one connected drawing out of hundreds. At that size there is no way to reach a feature you
// can NAME, which is the one thing somebody always has. Panning until you recognise a box is not
// navigation, it is luck.
//
// TWO LAYERS, the same split as palette.ts and inspector.ts, for the same reason.
//
//   1. A DESCRIBED MODEL. `buildSearchIndex` turns a GraphWire into a flat array of entries;
//      `parseQuery` turns what somebody typed into a filter; `searchGraph` ranks; `filterGraph`
//      says which subgraph the canvas should draw; `applyKey` is the whole keyboard, as a pure
//      reducer. No DOM, no globals, no I/O -- so "does an exact id outrank a fuzzy match on
//      something else", "what does a result say about where it is" and "what does Escape do when
//      a filter is applied" are all answerable in plain node.
//   2. A THIN RENDERER (`createSearchBox`) over that model. It owns an input, a listbox, focus
//      and `aria-activedescendant`, and nothing else. Every string it draws came out of layer 1,
//      and every key it handles is decided by `applyKey`.
//
// IT MUTATES NOTHING AND TOUCHES NO FILE. `filterGraph` builds a NEW GraphWire out of the arrays
// it was handed; the index holds references to the caller's nodes and never writes through them.
// Revealing a node is reported as a callback, exactly as picking a palette entry is reported as a
// NodeCreationRequest: this module describes where to go, the host goes there.
//
// WHY THE RANKING LADDER LOOKS LIKE THE PALETTE'S. palette.ts already solved the neighbouring
// problem -- an exact id first, then a prefix, then a substring, then the softer fields, with menu
// order breaking ties -- and its reasoning transfers wholesale: a softer field must never outrank
// a harder one, or typing the name of the thing you want puts something else above it. Two search
// boxes in one panel that rank differently is worse than either of them alone, so the tiers here
// are the same idea applied to what a NODE has instead of what a menu entry has: an id, a type, a
// file, and its own field values. The one addition is a last-resort subsequence match, which
// exists because node ids are long and typed from memory, and which is deliberately bottom of the
// ladder so it can never beat anything literal.
//
// WHAT IS MATCHED, and why the field VALUES are in it. People remember three different things
// about a feature and only one of them is its name: part of an identifier ("dripleaf"), what kind
// of thing it is ("the scatter"), or something that is IN it ("the one that places big dripleaf").
// The third is the one a plain id search cannot answer and the one that saves the most time,
// because the block a feature places is usually the reason you are looking for it. So each node
// carries a bounded, lowercased haystack of the strings inside its own `fields`, harvested once at
// index time. It is bounded on purpose -- see CONTENT_CHAR_BUDGET -- because an unbounded one
// turns a pack with a large structure list into a search that scans a megabyte per keystroke.
//
// IT IMPORTS NOTHING AT RUN TIME. Both imports below are type-only and erase, so a host bundling
// the webview pays for this module and nothing else. That is deliberate: the one value it needs
// from elsewhere is a single string constant, and reaching for it through nodeStats.ts would drag
// the whole attribution/profile module into a bundle that has no use for it.
import type { GraphEdgeWire, GraphNodeWire, GraphWire } from './render.js'

/** The synthetic type a feature RULE carries -- singular, and deliberately not the
 * `minecraft:feature_rules` key its file is rooted at, because it names one rule rather than the
 * file's collection of them. Spelled out here rather than imported for the reason in the header;
 * nodeStats.ts's `RULE_TYPE_ID` is the same string and graphSearch.test.ts asserts they agree, so
 * the copy cannot drift unnoticed. */
export const RULE_TYPE_ID = 'minecraft:feature_rule'

// ---------------------------------------------------------------------------
// The node, as the wire actually delivers it
// ---------------------------------------------------------------------------

/** wire.GraphNode has an `External` field -- an unresolved reference the GAME provides, common
 * in real packs -- that render.ts's mirror does not yet
 * carry. It is read here structurally rather than by widening render.ts's interface, because
 * render.ts is not this module's to change and a node that arrives without the key simply reads
 * as `false`, which is the correct answer for every pack that has none. */
type WireNode = GraphNodeWire & { external?: boolean }

function isExternal(node: GraphNodeWire): boolean {
  return (node as WireNode).external === true
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** How many characters of a node's own field values are kept for searching.
 *
 * THIS IS THE ONE NUMBER THAT DECIDES WHETHER THE INDEX IS WORTH KEEPING. The index is rebuilt on
 * every pack reload, which is every save, so its build cost is paid far more often than any single
 * search. Harvesting the whole of every node's JSON would make the rebuild scale with the pack's
 * byte size rather than its node count -- a structure_template list or a long block palette is
 * kilobytes on one node -- and would buy nothing, because nobody remembers the four-hundredth
 * entry of a list.
 *
 * 512 characters holds every block id, structure name and Molang expression on an ordinary node
 * with room to spare, and clamps the pathological ones. Nodes that were clamped are counted in
 * `SearchIndex.stats.clampedNodes` rather than silently truncated, so a pack where the budget is
 * actually biting is visible instead of quietly under-searched. */
export const CONTENT_CHAR_BUDGET = 512

/** How deep into a node's fields the harvest goes. Deep enough for a weighted list of block
 * descriptors inside a variant inside a trunk (four levels is the deepest shape in the schema),
 * shallow enough that a hand-written pack cannot make it walk forever. */
export const CONTENT_DEPTH_BUDGET = 6

/** Below this length a term is matched against identifiers only.
 *
 * A one- or two-character term matches inside almost every node's values and almost every node's
 * id by subsequence, so allowing it there produces three thousand results ranked by nothing. Short
 * terms still search ids literally, which is what "ok" or "v2" is for. */
const SOFT_MATCH_MIN_TERM = 3

/** How many results are turned into full, described hits. The rest are counted.
 *
 * A list of thousands of rows is the problem restated, not solved. But `SearchResult.matchedIds` holds
 * EVERY match regardless, because the canvas filter needs all of them -- so the cap is on what is
 * drawn, never on what is found. */
export const DEFAULT_RESULT_LIMIT = 50

// ---------------------------------------------------------------------------
// The prose the panel itself authors
// ---------------------------------------------------------------------------

/** Every sentence this module writes that is not built out of the graph.
 *
 * COLLECTED IN ONE EXPORTED PLACE rather than spelled inline where each is used, because the
 * project guards its user-facing language -- no tool names, no addresses, no engine symbols, no
 * source-file names, no pack namespace but Minecraft's own and the sample one -- and a guard can
 * only scan what it can reach. A placeholder written inline in a DOM call is exactly the prose a
 * reviewer never re-reads and a test never sees. graphSearch.test.ts scans this record.
 *
 * `emptyHint` names the filters rather than the size of the pack on purpose: what somebody needs
 * at an empty box is the vocabulary, and the node count is a fact the overview already shows. */
export const SEARCH_STRINGS = {
  placeholder: 'Find a feature',
  inputLabel: 'Find a feature by name, type, file, or what it places',
  listLabel: 'Matching features',
  clear: 'Clear',
  /** Shown in the footer whenever there is a query. Says the two things the keyboard does that
   * are not obvious from looking at the panel. */
  keysHint: 'Enter goes there. Alt+Enter shows only these.',
  /** Shown when the box is empty. */
  emptyHint:
    'Type part of a name. Or a filter: is:root, is:problem, is:shared, or "type:" and "file:" with what to look for after them.',
} as const

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** One node, flattened into everything a search needs and nothing it does not.
 *
 * Every string here is already lowercased where it is matched against, because lowercasing thousands of
 * ids on each keystroke is work with a known answer. The un-lowercased `id` is kept for display
 * and for the match ranges, which index into it. */
export interface SearchEntry {
  /** The node's id, exactly as the graph spells it. */
  id: string
  node: GraphNodeWire
  /** `id` lowercased. */
  lowerId: string
  /** `id` after the namespace, lowercased. Most searches are for this half. */
  bareId: string
  /** Where `bareId` starts inside `id`, so a range found in the bare half can be reported against
   * the displayed string without the caller doing arithmetic. */
  bareOffset: number
  typeId?: string
  /** `typeId` lowercased, namespace and all. Empty when the node has no type (an unresolved one). */
  lowerType: string
  file?: string
  /** `file` lowercased. Empty when the node has no file. */
  lowerFile: string
  /** The strings inside this node's own fields, lowercased, space-joined, clamped to
   * CONTENT_CHAR_BUDGET. Empty for a node with no fields. */
  content: string
  /** True when the harvest hit the budget and stopped early. */
  contentClamped: boolean
  coverage?: string
  /** How many edges arrive here. Two or more means the node is SHARED and editing it changes
   * every parent -- which render.ts already calls out on the card, and which is exactly what makes
   * one result choosable over another. */
  fanIn: number
  /** How many edges leave. Zero is a leaf: the thing that actually places blocks. */
  fanOut: number
  /** One of the graph's roots -- nothing delegates to it, so it is where reading starts. */
  isRoot: boolean
  /** A feature rule rather than a feature. */
  isRule: boolean
  /** Something delegates here and the pack does not define it. */
  unresolved: boolean
  /** An unresolved reference the GAME provides. Not a fault; see wire/graph.go. */
  external: boolean
  /** Named in one of the graph's cycles. */
  inCycle: boolean
  /** Which connected drawing this node belongs to, treating edges as undirected -- the same
   * reading the canvas uses when it decides what to open on. */
  component: number
  /** How many nodes are in that drawing. 1 means the node is alone on the canvas, which on a pack
   * like this one is true of a great many of them and is worth saying. */
  componentSize: number
  /** Position in `graph.nodes`. The wire contract guarantees that order is deterministic, so using
   * it as the final tie-break makes the whole ranking deterministic too. */
  order: number
}

export interface SearchIndexStats {
  nodes: number
  edges: number
  roots: number
  /** Connected drawings, edges read as undirected. */
  components: number
  /** Total characters of field content kept. The index's whole memory cost, near enough. */
  contentChars: number
  /** Nodes whose field harvest hit CONTENT_CHAR_BUDGET. */
  clampedNodes: number
}

export interface SearchIndex {
  entries: readonly SearchEntry[]
  /** Lowercased id -> entry, and bare lowercased id -> entry where that is unambiguous. Exists so
   * "I know exactly what it is called" is a map lookup rather than a scan, and so an exact match
   * is found even when the scan is capped. */
  byId: ReadonlyMap<string, SearchEntry>
  stats: SearchIndexStats
}

/** Walks a node's fields and returns the strings in them, lowercased and budgeted.
 *
 * Keys are harvested as well as values, because "the one with may_replace on it" is a real way to
 * remember a node and costs nothing extra to support. Numbers and booleans are NOT harvested: a
 * term like "3" would match most of the pack, which is the same as matching none of it. */
function harvestContent(fields: Record<string, unknown> | undefined): { text: string; clamped: boolean } {
  if (fields === undefined) return { text: '', clamped: false }
  const parts: string[] = []
  let used = 0
  let clamped = false

  const take = (text: string): void => {
    if (used >= CONTENT_CHAR_BUDGET) {
      clamped = true
      return
    }
    const room = CONTENT_CHAR_BUDGET - used
    if (text.length > room) {
      parts.push(text.slice(0, room).toLowerCase())
      used = CONTENT_CHAR_BUDGET
      clamped = true
      return
    }
    parts.push(text.toLowerCase())
    used += text.length
  }

  const walk = (value: unknown, depth: number): void => {
    if (used >= CONTENT_CHAR_BUDGET) return
    if (typeof value === 'string') {
      take(value)
      return
    }
    if (depth >= CONTENT_DEPTH_BUDGET) {
      // Deeper than anything in the schema. Stopping is not a truncation worth reporting -- the
      // budget is what reports pressure -- it is a guard against a hand-written file nesting for
      // its own sake.
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        take(key)
        walk(inner, depth + 1)
      }
    }
  }

  walk(fields, 0)
  // The separators count too. Budgeting only the PARTS let a node of five hundred short strings
  // join to half as much again as the budget, which is the one thing the budget exists to stop.
  const joined = parts.join(' ')
  if (joined.length > CONTENT_CHAR_BUDGET) return { text: joined.slice(0, CONTENT_CHAR_BUDGET), clamped: true }
  return { text: joined, clamped }
}

/** Connected components, edges read as UNDIRECTED.
 *
 * Undirected for the same reason webview/graph.ts reads them that way when it picks an opening
 * view: two rules sharing one child are one drawing to whoever is looking at it, whichever way the
 * arrows point. Union-find with path halving, so this is effectively linear and cannot be made to
 * recurse by a cycle -- and cycles are legal here, per the contract. */
function components(nodeIds: readonly string[], edges: readonly GraphEdgeWire[]): { of: Map<string, number>; sizes: number[] } {
  const slot = new Map<string, number>()
  for (const [i, id] of nodeIds.entries()) slot.set(id, i)
  const parent = new Int32Array(nodeIds.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i

  const find = (x: number): number => {
    let cur = x
    while (parent[cur] !== cur) {
      const up = parent[cur] as number
      parent[cur] = parent[up] as number
      cur = parent[cur] as number
    }
    return cur
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  for (const edge of edges) {
    const a = slot.get(edge.from)
    const b = slot.get(edge.to)
    // An endpoint that is in no node list is a ghost the renderer draws as a stub; it joins no
    // component because there is nothing to join it to.
    if (a === undefined || b === undefined) continue
    union(a, b)
  }

  const label = new Map<number, number>()
  const sizes: number[] = []
  const of = new Map<string, number>()
  for (const [i, id] of nodeIds.entries()) {
    const root = find(i)
    let index = label.get(root)
    if (index === undefined) {
      index = sizes.length
      label.set(root, index)
      sizes.push(0)
    }
    sizes[index] = (sizes[index] as number) + 1
    of.set(id, index)
  }
  return { of, sizes }
}

/** Builds the index. One pass over the edges, one over the nodes, one union-find.
 *
 * NO INVERTED INDEX, and that is a measured decision rather than laziness. A trigram or token
 * index over a few thousand nodes would cost several times this to build and would have to be rebuilt on
 * every save, to accelerate a scan that already finishes inside a single animation frame. The
 * rule this module follows: do not build an index that costs more to
 * keep than the search saves. What IS pre-computed is everything that would otherwise be redone
 * per keystroke -- the lowercasing, the namespace split, the fan counts, the component labels --
 * because those are paid once per reload and saved on every character typed. */
export function buildSearchIndex(graph: GraphWire): SearchIndex {
  const fanIn = new Map<string, number>()
  const fanOut = new Map<string, number>()
  for (const edge of graph.edges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1)
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1)
  }

  const roots = new Set(graph.roots)
  const inCycle = new Set<string>()
  for (const cycle of graph.cycles ?? []) for (const id of cycle) inCycle.add(id)

  const ids = graph.nodes.map((n) => n.id)
  const comp = components(ids, graph.edges)

  const entries: SearchEntry[] = []
  const byId = new Map<string, SearchEntry>()
  let contentChars = 0
  let clampedNodes = 0

  for (const [order, node] of graph.nodes.entries()) {
    const lowerId = node.id.toLowerCase()
    const colon = lowerId.indexOf(':')
    const bareOffset = colon >= 0 ? colon + 1 : 0
    const { text, clamped } = harvestContent(node.fields)
    contentChars += text.length
    if (clamped) clampedNodes++
    const component = comp.of.get(node.id) ?? -1
    const entry: SearchEntry = {
      id: node.id,
      node,
      lowerId,
      bareId: lowerId.slice(bareOffset),
      bareOffset,
      typeId: node.typeId,
      lowerType: (node.typeId ?? '').toLowerCase(),
      file: node.file,
      lowerFile: (node.file ?? '').toLowerCase(),
      content: text,
      contentClamped: clamped,
      coverage: node.coverage,
      fanIn: fanIn.get(node.id) ?? 0,
      fanOut: fanOut.get(node.id) ?? 0,
      isRoot: roots.has(node.id),
      isRule: node.typeId === RULE_TYPE_ID,
      unresolved: node.unresolved === true && !isExternal(node),
      external: isExternal(node),
      inCycle: inCycle.has(node.id),
      component,
      componentSize: component >= 0 ? (comp.sizes[component] as number) : 1,
      order,
    }
    entries.push(entry)
    byId.set(entry.lowerId, entry)
    // The bare half too, but never overwriting: two packs' worth of namespaces can both define
    // `oak_tree`, and silently resolving that to whichever came last would send somebody to the
    // wrong node with no sign that a choice was made. First wins; the scan still finds both.
    if (entry.bareOffset > 0 && !byId.has(entry.bareId)) byId.set(entry.bareId, entry)
  }

  return {
    entries,
    byId,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      roots: graph.roots.length,
      components: comp.sizes.length,
      contentChars,
      clampedNodes,
    },
  }
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/** A property a node either has or does not, written `is:<name>`.
 *
 * These are what turn "twenty identical-looking ids" into a list somebody can choose from, and
 * they are in the QUERY rather than in a row of checkboxes because this is the feature you reach
 * for when you are lost, and reaching for the mouse at that moment is the thing it exists to
 * avoid. */
export type SearchFlag =
  | 'root'
  | 'rule'
  | 'shared'
  | 'leaf'
  | 'alone'
  | 'broken'
  | 'external'
  | 'cycle'
  | 'partial'
  | 'unsupported'
  | 'problem'

/** Every flag, with the sentence the box shows for it. Exported so a host can offer them without
 * restating the list, and so the language guard can scan them. */
export const SEARCH_FLAGS: Readonly<Record<SearchFlag, string>> = {
  root: 'Nothing delegates to it, so it is where reading the pack starts.',
  rule: 'A rule that decides where a feature is placed, rather than a feature.',
  shared: 'Two or more features delegate to it, so editing it changes all of them.',
  leaf: 'Delegates to nothing. These are the features that place blocks.',
  alone: 'Connected to nothing else -- it is a drawing of one box.',
  broken: 'Something delegates to it and this pack does not define it.',
  external: 'A feature the game provides rather than this pack. It works in game; no preview.',
  cycle: 'Part of a loop where a feature eventually delegates back to itself.',
  partial: 'This feature type is only partly built here, so a preview may differ from the game.',
  unsupported: 'This feature type is not built here, so it previews as empty.',
  problem: 'Anything the preview will get wrong: undefined references, loops, unbuilt types.',
}

const FLAG_NAMES = new Set(Object.keys(SEARCH_FLAGS) as SearchFlag[])

export interface ParsedQuery {
  /** What was typed, untouched. */
  raw: string
  /** The free words, lowercased, in the order typed. All of them must match. */
  terms: readonly string[]
  /** `type:` -- lowercased, namespace optional. */
  type?: string
  /** `file:` -- lowercased. */
  file?: string
  flags: readonly SearchFlag[]
  /** Things the query asked for that this module does not understand, said out loud rather than
   * dropped. A filter that is silently ignored is worse than one that is refused: the results
   * look like an answer to a question nobody asked. */
  notes: readonly string[]
  /** True when the query selects nothing at all -- no terms, no filters. */
  isEmpty: boolean
}

/** Splits a query into terms and filters.
 *
 * Deliberately forgiving. `type:scatter`, `type:minecraft:scatter_feature` and a bare `scatter`
 * all work; a trailing `is:` with nothing after it is one note, not an error; an unknown
 * `is:whatever` is a note naming what IS understood. Nothing here throws, because this runs on
 * every keystroke and half-typed input is the normal state of a search box. */
export function parseQuery(raw: string): ParsedQuery {
  const terms: string[] = []
  const flags: SearchFlag[] = []
  const notes: string[] = []
  let type: string | undefined
  let file: string | undefined

  for (const token of raw.trim().split(/\s+/)) {
    if (token.length === 0) continue
    const lower = token.toLowerCase()
    if (lower.startsWith('is:')) {
      const name = lower.slice(3)
      if (name.length === 0) {
        notes.push(`Add one of ${[...FLAG_NAMES].join(', ')} after "is:".`)
      } else if (FLAG_NAMES.has(name as SearchFlag)) {
        if (!flags.includes(name as SearchFlag)) flags.push(name as SearchFlag)
      } else {
        notes.push(`There is no "is:${name}". The ones there are: ${[...FLAG_NAMES].join(', ')}.`)
      }
      continue
    }
    if (lower.startsWith('type:')) {
      const rest = lower.slice(5)
      if (rest.length === 0) notes.push('Add a feature type after "type:".')
      else type = rest
      continue
    }
    if (lower.startsWith('file:')) {
      const rest = lower.slice(5)
      if (rest.length === 0) notes.push('Add part of a file name after "file:".')
      else file = rest
      continue
    }
    terms.push(lower)
  }

  return {
    raw,
    terms,
    type,
    file,
    flags,
    notes,
    isEmpty: terms.length === 0 && type === undefined && file === undefined && flags.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Where a term was found, worst-case first in the sense that matters: a tier further down the
 * list is a weaker reason to show a result, and NOTHING further down may outrank anything above
 * it. This is palette.ts's ladder with a node's fields in place of a menu entry's. */
export type SearchTier =
  | 'exact-id'
  | 'id-prefix'
  | 'id-word'
  | 'id-substring'
  | 'type'
  | 'file'
  | 'content'
  | 'letters'

/** Tier -> rank. Lower sorts first. Exported because "an exact id must never lose to a fuzzy match
 * on something else" is a property worth asserting against the numbers rather than against the
 * order of a particular result list. */
export const TIER_RANK: Readonly<Record<SearchTier, number>> = {
  'exact-id': 0,
  'id-prefix': 1,
  'id-word': 2,
  'id-substring': 3,
  type: 4,
  file: 5,
  content: 6,
  letters: 7,
}

/** One clause saying why a result is in the list, per tier. Shown only when the match was NOT on
 * the identifier, because when it was, the highlighted id has already said so. */
const TIER_REASON: Readonly<Record<SearchTier, string>> = {
  'exact-id': '',
  'id-prefix': '',
  'id-word': '',
  'id-substring': '',
  type: 'Matched its feature type.',
  file: 'Matched the file it is written in.',
  content: 'Matched a value inside this feature.',
  letters: 'Matched those letters in that order, spread through the name.',
}

export interface MatchRange {
  /** Offsets into the entry's `id` as displayed, not into the lowercased copy. */
  start: number
  end: number
}

interface TermMatch {
  tier: SearchTier
  /** Where the match starts in whatever it matched. Used only as a tie-break. */
  offset: number
  ranges: MatchRange[]
}

/** Every position of `term` inside `haystack`, as ranges shifted by `shift`. Bounded by the
 * haystack length, so a one-character term on a long id costs what that id costs and no more. */
function allRanges(haystack: string, term: string, shift: number): MatchRange[] {
  const out: MatchRange[] = []
  let at = haystack.indexOf(term)
  while (at >= 0) {
    out.push({ start: at + shift, end: at + shift + term.length })
    at = haystack.indexOf(term, at + term.length)
  }
  return out
}

/** Does `term` appear as a subsequence of `haystack`, and where.
 *
 * The last resort, and the only non-literal match in the ladder: node ids are long, typed from
 * memory and full of underscores, so "bdrip" ought to reach `big_dripleaf_patch`. It is bottom of
 * the ladder precisely because it matches so much -- it may never beat a real substring -- and it
 * is refused for terms shorter than SOFT_MATCH_MIN_TERM, where it would match nearly everything.
 * One pass, no backtracking: this is the greedy leftmost subsequence, not the prettiest one. */
function subsequenceRanges(haystack: string, term: string, shift: number): MatchRange[] | null {
  const out: MatchRange[] = []
  let at = 0
  for (const ch of term) {
    const found = haystack.indexOf(ch, at)
    if (found < 0) return null
    const last = out[out.length - 1]
    if (last !== undefined && last.end === found + shift) last.end = found + shift + 1
    else out.push({ start: found + shift, end: found + shift + 1 })
    at = found + 1
  }
  return out
}

/** The best tier one term reaches on one entry, or null when it reaches none.
 *
 * Ordered and early-returning, so a node whose id starts with the term costs one `indexOf` and a
 * node that matches nothing costs the whole ladder. That asymmetry is the right way round: on a
 * real query most nodes match nothing, but the ladder is five short string scans, and the one
 * long scan (the content haystack) is capped at CONTENT_CHAR_BUDGET by construction. */
function matchTerm(entry: SearchEntry, term: string): TermMatch | null {
  // 0. The id, exactly -- with or without the namespace on either side.
  if (entry.lowerId === term || entry.bareId === term) {
    return {
      tier: 'exact-id',
      offset: 0,
      ranges: [{ start: 0, end: entry.id.length }],
    }
  }

  // 1-3. One scan of the bare id decides all three identifier tiers: at the start is a prefix,
  // after a separator is a word, anywhere else is a substring. Doing it as three separate
  // predicates was the first version and scanned the same string three times to learn one thing.
  const inBare = entry.bareId.indexOf(term)
  if (inBare >= 0) {
    const before = inBare === 0 ? '' : entry.bareId.charAt(inBare - 1)
    const tier: SearchTier = inBare === 0 ? 'id-prefix' : /[^a-z0-9]/.test(before) ? 'id-word' : 'id-substring'
    return { tier, offset: inBare, ranges: allRanges(entry.bareId, term, entry.bareOffset) }
  }
  // The namespace half, which the bare scan cannot see.
  if (entry.bareOffset > 0) {
    const inNamespace = entry.lowerId.slice(0, entry.bareOffset).indexOf(term)
    if (inNamespace >= 0) {
      return { tier: 'id-substring', offset: inNamespace, ranges: allRanges(entry.lowerId, term, 0) }
    }
  }

  // 4. The type.
  if (entry.lowerType.length > 0) {
    const inType = entry.lowerType.indexOf(term)
    if (inType >= 0) return { tier: 'type', offset: inType, ranges: [] }
  }

  // 5. The file it is written in.
  if (entry.lowerFile.length > 0) {
    const inFile = entry.lowerFile.indexOf(term)
    if (inFile >= 0) return { tier: 'file', offset: inFile, ranges: [] }
  }

  if (term.length < SOFT_MATCH_MIN_TERM) return null

  // 6. Something inside the feature: a block, a structure, a Molang expression, a key.
  if (entry.content.length > 0) {
    const inContent = entry.content.indexOf(term)
    if (inContent >= 0) return { tier: 'content', offset: inContent, ranges: [] }
  }

  // 7. The letters, in order, anywhere in the id.
  const letters = subsequenceRanges(entry.bareId, term, entry.bareOffset)
  if (letters !== null) return { tier: 'letters', offset: letters[0]?.start ?? 0, ranges: letters }

  return null
}

function hasFlag(entry: SearchEntry, flag: SearchFlag): boolean {
  switch (flag) {
    case 'root':
      return entry.isRoot
    case 'rule':
      return entry.isRule
    case 'shared':
      return entry.fanIn >= 2
    case 'leaf':
      return entry.fanOut === 0 && !entry.unresolved && !entry.external
    case 'alone':
      return entry.componentSize === 1
    case 'broken':
      return entry.unresolved
    case 'external':
      return entry.external
    case 'cycle':
      return entry.inCycle
    case 'partial':
      return entry.coverage === 'partial'
    case 'unsupported':
      return entry.coverage === 'missing' || entry.coverage === 'out_of_scope'
    case 'problem':
      // Everything that means the preview will not match the game. An `external` node is NOT one
      // of these: the pack is correct and it resolves in game -- see wire/graph.go on why calling
      // those faults taught people to stop reading the fault list.
      return entry.unresolved || entry.inCycle || entry.coverage === 'missing' || entry.coverage === 'out_of_scope'
  }
}

// ---------------------------------------------------------------------------
// What a result SAYS
// ---------------------------------------------------------------------------

/** The facts that make one result choosable over another that looks the same.
 *
 * A list of twenty ids differing in one word helps nobody: what separates them is what kind of
 * thing each is, whether anything depends on it, and which file it lives in. Every fact here is
 * already on the canvas card or in the overview panel -- this is the same information, at the
 * moment somebody is choosing rather than after they have arrived. */
export interface HitDetail {
  /** The feature type, or the words for a rule. */
  kind: string
  /** Short phrases, in the order they should be read. Already ordered most-distinguishing first:
   * what it is, what depends on it, where it lives. */
  facts: readonly string[]
  /** One sentence, or '' when the highlighted id has already said everything. */
  why: string
  /** Set when the node is one the preview cannot render faithfully. '' otherwise. */
  warning: string
}

export interface SearchHit {
  entry: SearchEntry
  nodeId: string
  node: GraphNodeWire
  tier: SearchTier
  rank: number
  /** Ranges into `nodeId` to highlight. Empty when the match was not on the identifier. */
  ranges: readonly MatchRange[]
  detail: HitDetail
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function describeEntry(entry: SearchEntry, tier: SearchTier): HitDetail {
  const facts: string[] = []

  const kind = entry.isRule
    ? 'placement rule'
    : entry.unresolved
      ? 'no feature behind it'
      : entry.external
        ? 'provided by the game'
        : (entry.typeId ?? 'no type recorded')

  if (entry.isRoot && !entry.isRule) facts.push('nothing delegates to it')
  if (entry.fanIn >= 2) facts.push(`${plural(entry.fanIn, 'feature delegates', 'features delegate')} to it`)
  if (entry.fanOut > 0) facts.push(plural(entry.fanOut, 'child', 'children'))
  if (entry.fanOut === 0 && entry.fanIn > 0 && !entry.unresolved && !entry.external) facts.push('places blocks itself')
  if (entry.componentSize === 1) facts.push('connected to nothing else')
  if (entry.file !== undefined && entry.file.length > 0) facts.push(entry.file)

  let warning = ''
  if (entry.unresolved) warning = 'This pack defines nothing by this name, so nothing is placed where it is used.'
  else if (entry.external) warning = 'The game provides this one. It works in game; this tool cannot preview it.'
  else if (entry.inCycle) warning = 'It is part of a loop that eventually delegates back to itself.'
  else if (entry.coverage === 'partial') warning = 'This feature type is only partly built here, so a preview may differ from the game.'
  else if (entry.coverage === 'missing' || entry.coverage === 'out_of_scope') {
    warning = 'This feature type is not built here, so it previews as empty. The game still places it.'
  }

  return { kind, facts, why: TIER_REASON[tier], warning }
}

/** The one-line form, for a host that wants a string rather than the parts. */
export function describeHit(hit: SearchHit): string {
  return [hit.detail.kind, ...hit.detail.facts].join(' · ')
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

export interface SearchResult {
  query: ParsedQuery
  /** In rank order, capped at `limit`. */
  hits: readonly SearchHit[]
  /** How many entries matched in total, cap or no cap. */
  total: number
  truncated: boolean
  /** EVERY matching id, not just the ones in `hits`. This is what the canvas filter is built
   * from: showing only the top fifty of three hundred matches would be a different, and wrong,
   * answer to "show me only what matches". */
  matchedIds: ReadonlySet<string>
  notes: readonly string[]
  /** One line for the footer: how much of what was found is shown. */
  summary: string
}

export interface SearchOptions {
  limit?: number
}

/** A scored candidate, before it is described. Kept deliberately small: on a query like "e" every
 * node matches, and building three and a half thousand HitDetails to throw all but fifty of them
 * away was measurably the most expensive thing this module did. */
interface Candidate {
  entry: SearchEntry
  tier: SearchTier
  rank: number
  offset: number
  ranges: MatchRange[]
}

/** Runs a query.
 *
 * A LINEAR SCAN, on purpose and after measuring. Every entry is visited; each visit is a handful
 * of `indexOf` calls on short strings with an early return as soon as a tier is reached. At the
 * size this exists for -- thousands of entries -- that lands comfortably inside one animation frame, which
 * is the only budget a search box has to meet, and it needs nothing kept up to date between
 * reloads. See this module's header on why the alternative was rejected.
 *
 * An EMPTY QUERY RETURNS NOTHING rather than everything. That is the opposite of palette.ts, and
 * the difference is the size: a menu of 34 entries is a browsable list and shows it all, whereas
 * thousands of rows is the problem restated. What the empty state offers instead is the filters, which the
 * box prints. */
export function searchGraph(index: SearchIndex, query: string | ParsedQuery, options: SearchOptions = {}): SearchResult {
  const parsed = typeof query === 'string' ? parseQuery(query) : query
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT

  if (parsed.isEmpty) {
    return {
      query: parsed,
      hits: [],
      total: 0,
      truncated: false,
      matchedIds: new Set(),
      notes: parsed.notes,
      summary: SEARCH_STRINGS.emptyHint,
    }
  }

  const candidates: Candidate[] = []
  const matchedIds = new Set<string>()

  for (const entry of index.entries) {
    if (parsed.type !== undefined && !entry.lowerType.includes(parsed.type)) continue
    if (parsed.file !== undefined && !entry.lowerFile.includes(parsed.file)) continue
    let flagged = true
    for (const flag of parsed.flags) {
      if (!hasFlag(entry, flag)) {
        flagged = false
        break
      }
    }
    if (!flagged) continue

    // EVERY term must match -- "oak tree" means both, not either. The hit's tier is the WEAKEST of
    // them, so a node matching both words in its id outranks one matching a word in its id and a
    // word in its values. Ranking by the strongest term instead would let one good word drag an
    // otherwise irrelevant node to the top.
    let tier: SearchTier | null = null
    let rank = -1
    let offset = 0
    const ranges: MatchRange[] = []
    let ok = true
    for (const term of parsed.terms) {
      const match = matchTerm(entry, term)
      if (match === null) {
        ok = false
        break
      }
      ranges.push(...match.ranges)
      const termRank = TIER_RANK[match.tier]
      if (termRank > rank) {
        rank = termRank
        tier = match.tier
        offset = match.offset
      }
    }
    if (!ok) continue

    if (tier === null) {
      // No free terms: this is a pure filter query (`is:root type:scatter`). Every survivor is an
      // equally good answer, so they rank by the graph's own order, which is deterministic.
      tier = 'exact-id'
      rank = TIER_RANK['exact-id']
      offset = 0
    }

    matchedIds.add(entry.id)
    candidates.push({ entry, tier, rank, offset, ranges })
  }

  // Tie-breaks, in order and each with a reason:
  //   offset   -- a match near the front of the name is the one somebody was aiming at.
  //   length   -- the shortest id containing the term is the canonical one; the longer ones are
  //               usually variants of it, and burying the plain `oak_tree` under twelve of its own
  //               variants is exactly the failure this ranking exists to avoid.
  //   fan-in   -- when two are equally good, the one more of the pack depends on is more likely to
  //               be the one meant. This graph's real shape is many parents sharing few children.
  //   order    -- the wire contract guarantees node order is deterministic, so the whole sort is.
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.offset - b.offset ||
      a.entry.bareId.length - b.entry.bareId.length ||
      b.entry.fanIn - a.entry.fanIn ||
      a.entry.order - b.entry.order,
  )

  const hits: SearchHit[] = []
  for (const candidate of candidates.slice(0, Math.max(0, limit))) {
    hits.push({
      entry: candidate.entry,
      nodeId: candidate.entry.id,
      node: candidate.entry.node,
      tier: candidate.tier,
      rank: candidate.rank,
      ranges: mergeRanges(candidate.ranges),
      detail: describeEntry(candidate.entry, candidate.tier),
    })
  }

  const total = candidates.length
  const truncated = total > hits.length
  const summary =
    total === 0
      ? `Nothing in this pack matches ${JSON.stringify(parsed.raw.trim())}.`
      : truncated
        ? `${hits.length} of ${total} matches shown, out of ${index.stats.nodes}.`
        : `${plural(total, 'match', 'matches')} out of ${index.stats.nodes}.`

  return { query: parsed, hits, total, truncated, matchedIds, notes: parsed.notes, summary }
}

/** Overlapping ranges drawn one over the other produce nested `<mark>` elements and a highlight
 * that is darker where two terms happen to overlap. Merged and sorted here, once, rather than in
 * the renderer -- a highlight is a fact about a match, not a drawing decision. */
function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) return [...ranges]
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: MatchRange[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else out.push({ ...range })
  }
  return out
}

// ---------------------------------------------------------------------------
// Filtering the canvas
// ---------------------------------------------------------------------------
//
// THIS BELONGS HERE, and the decision is worth stating because it could plausibly have gone the
// other way. Showing only what matches is the same question as showing what matches in a list --
// one predicate, two presentations -- and splitting them across two modules would mean two
// implementations of "does this node match", which would drift, and the one that drifted would be
// the one nobody was looking at. So the PREDICATE and the SUBGRAPH live here.
//
// The DRAWING does not. This module returns a described GraphWire; render.ts's `render(graph,
// positions)` draws it, unchanged and unaware. That seam is what keeps filtering from becoming a
// rendering mode with its own state: the host passes the filtered graph and THE SAME positions
// map, so nothing is re-laid-out, nothing moves, and clearing the filter is passing the original
// graph back. A node that was at a point stays at that point whether it is currently shown or not,
// which is the property that makes filtering usable at all -- a filter that re-laid-out the canvas
// every keystroke would be a different picture each time, and the point of hiding things is to see
// where the remaining ones ARE.

export type FilterScope =
  /** Only the nodes that matched. */
  | 'matches'
  /** The matches plus everything within `depth` edges of one, either direction. What a match
   * delegates to and what delegates to it is usually the reason you searched. */
  | 'neighbours'
  /** Every node in the same connected drawing as a match. "Show me only this component." */
  | 'component'

export interface FilterOptions {
  scope?: FilterScope
  /** For `'neighbours'`. 1 by default: parents and children, not the whole ancestry. */
  depth?: number
}

export interface GraphFilter {
  scope: FilterScope
  /** The ids that survive. */
  visible: ReadonlySet<string>
  /** A new GraphWire holding only those nodes and the edges BETWEEN them, in the original order --
   * so the contract's determinism survives the filter. Hand this to `render`, with the same
   * positions map. */
  graph: GraphWire
  hiddenNodes: number
  hiddenEdges: number
  /** One line for the status bar, saying what is being hidden. A canvas that is quietly showing a
   * fraction of the pack with no sign of it is a canvas that will be reported as broken. */
  summary: string
}

/** Grows `seeds` outward by `depth` edges, edges read as undirected. */
function grow(graph: GraphWire, seeds: ReadonlySet<string>, depth: number): Set<string> {
  const neighbours = new Map<string, string[]>()
  const link = (a: string, b: string): void => {
    const list = neighbours.get(a)
    if (list === undefined) neighbours.set(a, [b])
    else list.push(b)
  }
  for (const edge of graph.edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }
  const out = new Set(seeds)
  let frontier = [...seeds]
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const to of neighbours.get(id) ?? []) {
        if (out.has(to)) continue
        out.add(to)
        next.push(to)
      }
    }
    frontier = next
  }
  return out
}

/** Which nodes are in the same drawing as `nodeId`. For "show me only this component", which is
 * the single most useful filter on a pack that is hundreds of separate drawings. */
export function componentOf(index: SearchIndex, nodeId: string): ReadonlySet<string> {
  const seed = index.byId.get(nodeId.toLowerCase())
  const out = new Set<string>()
  if (seed === undefined) return out
  for (const entry of index.entries) if (entry.component === seed.component) out.add(entry.id)
  return out
}

/** Describes the canvas as it should be while a filter is on. Mutates nothing: the returned graph
 * is new arrays holding the caller's own node and edge objects. */
export function filterGraph(
  index: SearchIndex,
  graph: GraphWire,
  matched: ReadonlySet<string>,
  options: FilterOptions = {},
): GraphFilter {
  const scope = options.scope ?? 'matches'
  const depth = Math.max(0, options.depth ?? 1)

  let visible: Set<string>
  if (scope === 'matches') {
    visible = new Set(matched)
  } else if (scope === 'neighbours') {
    visible = grow(graph, matched, depth)
  } else {
    visible = new Set<string>()
    const wanted = new Set<number>()
    for (const id of matched) {
      const entry = index.byId.get(id.toLowerCase())
      if (entry !== undefined) wanted.add(entry.component)
    }
    for (const entry of index.entries) if (wanted.has(entry.component)) visible.add(entry.id)
  }

  const nodes = graph.nodes.filter((n) => visible.has(n.id))
  // Both endpoints, never one. An edge with a hidden endpoint would be drawn as a line into
  // nothing -- indistinguishable from the dangling stub that means a genuinely broken reference,
  // which is the one thing on this canvas that must keep meaning what it means.
  const edges = graph.edges.filter((e) => visible.has(e.from) && visible.has(e.to))
  const roots = graph.roots.filter((id) => visible.has(id))
  const cycles = (graph.cycles ?? []).filter((cycle) => cycle.every((id) => visible.has(id)))

  const hiddenNodes = graph.nodes.length - nodes.length
  const hiddenEdges = graph.edges.length - edges.length
  const scopeWords =
    scope === 'matches'
      ? 'Showing only what matches'
      : scope === 'neighbours'
        ? `Showing what matches, and whatever is within ${plural(depth, 'step', 'steps')} of it`
        : 'Showing every drawing that contains a match'

  return {
    scope,
    visible,
    graph: { nodes, edges, roots, ...(cycles.length > 0 ? { cycles } : {}) },
    hiddenNodes,
    hiddenEdges,
    summary:
      hiddenNodes === 0
        ? `${scopeWords}. Nothing is hidden.`
        : `${scopeWords}: ${nodes.length} of ${graph.nodes.length}. ${plural(hiddenNodes, 'feature is', 'features are')} hidden.`,
  }
}

// ---------------------------------------------------------------------------
// The keyboard, as data
// ---------------------------------------------------------------------------
//
// KEYBOARD FIRST IS NOT A STYLE PREFERENCE HERE. This is the thing somebody reaches for when they
// are lost in a canvas of three and a half thousand boxes; a search that needs the mouse to drive
// its own results has missed the point of itself. So the whole keyboard is a PURE REDUCER over a
// small state, which means every binding is testable in plain node and none of it depends on the
// renderer being right. The renderer below does nothing but call this and obey the answer.

export interface SearchBoxState {
  query: string
  /** Which result is announced and would be revealed. Always a valid index, or -1 for none. */
  activeIndex: number
  /** Whether a canvas filter is currently applied. Escape unwinds this FIRST -- see below. */
  filtered: boolean
}

export type SearchAction =
  /** Nothing to do; the state may still have changed (the active row moved). */
  | { kind: 'none' }
  /** Go to this result: select it and put the camera on it. */
  | { kind: 'reveal'; index: number }
  /** Show only the current matches on the canvas. */
  | { kind: 'filter' }
  /** Put every node back. */
  | { kind: 'clear-filter' }
  /** Empty the box. */
  | { kind: 'clear-query' }
  /** Give up focus / close the box. */
  | { kind: 'close' }
  /** Not ours: let the browser have it. The renderer must not call preventDefault on these. */
  | { kind: 'passthrough' }

export interface KeyInput {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

/** How far PageUp/PageDown move. A screenful of rows, near enough, and a round number somebody can
 * predict. */
const PAGE_STEP = 10

/** The whole keyboard.
 *
 * The bindings and why each one is what it is:
 *
 *   ArrowDown/Up      move the active result. Wrapping, like the palette's -- a list you can
 *                     arrow off the end of makes you look at where you are.
 *   PageDown/Up       ten at a time, for a long result list.
 *   Ctrl+Home/End     first and last. NOT bare Home/End, which the palette takes: this box holds a
 *                     query somebody is editing, and stealing the two keys that move a caret to
 *                     the ends of it would make a typo at the front of a long query unfixable
 *                     without the mouse. That trade is the right way round in a menu with no text
 *                     worth editing and the wrong way round here.
 *   Enter             go to the active result, and STAY in the box. Arrow, Enter, arrow, Enter
 *                     walks the matches with the camera following and never leaves the keyboard.
 *   F3 / Shift+F3     next and previous match, revealed in one keystroke -- the find-again idiom
 *                     from every editor this sits next to, for somebody who is not looking at the
 *                     list at all.
 *   Alt+Enter         show only the matches on the canvas (Ctrl+Enter does the same, because
 *                     which of the two a person reaches for is a habit and neither is wrong here).
 *                     On Enter's key because it is the other thing to do with a result set, and a
 *                     modifier away because it changes what is on screen.
 *   Escape            unwinds ONE layer at a time: the filter, then the query, then focus. An
 *                     Escape that did all three would leave somebody who only wanted their canvas
 *                     back with an empty box as well, and the canvas is the expensive one to
 *                     rebuild by hand.
 *
 * Everything else passes through, because a search box is first a text field. */
export function applyKey(state: SearchBoxState, input: KeyInput, resultCount: number): { state: SearchBoxState; action: SearchAction } {
  const last = resultCount - 1
  const clamp = (index: number): number => (resultCount === 0 ? -1 : ((index % resultCount) + resultCount) % resultCount)
  const move = (delta: number): { state: SearchBoxState; action: SearchAction } => {
    if (resultCount === 0) return { state: { ...state, activeIndex: -1 }, action: { kind: 'none' } }
    return { state: { ...state, activeIndex: clamp(state.activeIndex + delta) }, action: { kind: 'none' } }
  }

  switch (input.key) {
    case 'ArrowDown':
      return move(1)
    case 'ArrowUp':
      return move(-1)
    case 'PageDown':
      return move(PAGE_STEP)
    case 'PageUp':
      return move(-PAGE_STEP)
    case 'Home':
      if (!input.ctrlKey && !input.metaKey) return { state, action: { kind: 'passthrough' } }
      return { state: { ...state, activeIndex: resultCount === 0 ? -1 : 0 }, action: { kind: 'none' } }
    case 'End':
      if (!input.ctrlKey && !input.metaKey) return { state, action: { kind: 'passthrough' } }
      return { state: { ...state, activeIndex: last }, action: { kind: 'none' } }
    case 'F3': {
      const next = move(input.shiftKey ? -1 : 1)
      if (next.state.activeIndex < 0) return next
      return { state: next.state, action: { kind: 'reveal', index: next.state.activeIndex } }
    }
    case 'Enter': {
      if (input.altKey || input.ctrlKey || input.metaKey) {
        if (resultCount === 0) return { state, action: { kind: 'none' } }
        return { state: { ...state, filtered: true }, action: { kind: 'filter' } }
      }
      if (state.activeIndex < 0 || state.activeIndex > last) return { state, action: { kind: 'none' } }
      return { state, action: { kind: 'reveal', index: state.activeIndex } }
    }
    case 'Escape':
      if (state.filtered) return { state: { ...state, filtered: false }, action: { kind: 'clear-filter' } }
      if (state.query.length > 0) return { state: { ...state, query: '', activeIndex: -1 }, action: { kind: 'clear-query' } }
      return { state, action: { kind: 'close' } }
    default:
      return { state, action: { kind: 'passthrough' } }
  }
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

/** The search box's stylesheet, following palette.ts's three rules exactly, because the two panels
 * sit in the same webview over the same canvas and a second convention would show:
 *
 *   1. Every `--fls-*` variable is declared ONCE, as `var(--vscode-<name>, <fallback>)`. The host
 *      injects every `--vscode-*` property and updates them live on a theme switch, so this
 *      follows the theme with no JavaScript.
 *   2. Every rule below the variable block reads only `--fls-*`.
 *   3. NO RAW COLOUR BELOW THE VARIABLE BLOCK. `transparent`, `none` and `currentColor` are
 *      keywords, not colours. graphSearch.test.ts scans this string, for the same reason
 *      graphPalette.test.ts scans the menu's.
 *
 * The highlighted run inside a result is a BACKGROUND from the editor's own find-match colour, not
 * bold text: on a list of ids that differ by one word, weight alone disappears into a monospaced
 * column, and the find-match colour is the one an editor's user already reads as "this is the bit
 * you typed". */
export const SEARCH_STYLESHEET = `
.fls-search {
  --fls-bg: var(--vscode-editorWidget-background, #252526);
  --fls-fg: var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground, #cccccc));
  --fls-fg-muted: var(--vscode-descriptionForeground, rgba(204, 204, 204, 0.7));
  --fls-border: var(--vscode-editorWidget-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  --fls-sep: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.35));
  --fls-active-bg: var(--vscode-list-activeSelectionBackground, #04395e);
  --fls-active-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
  --fls-hover-bg: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
  --fls-focus: var(--vscode-focusBorder, #007fd4);
  --fls-input-bg: var(--vscode-input-background, #3c3c3c);
  --fls-input-fg: var(--vscode-input-foreground, #cccccc);
  --fls-input-border: var(--vscode-input-border, rgba(128, 128, 128, 0.35));
  --fls-placeholder: var(--vscode-input-placeholderForeground, rgba(204, 204, 204, 0.5));
  --fls-mark-bg: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  --fls-mark-fg: var(--vscode-editor-foreground, #cccccc);
  --fls-warning-fg: var(--vscode-editorWarning-foreground, #cca700);
  --fls-code-fg: var(--vscode-textPreformat-foreground, #ce9178);
  --fls-badge-bg: var(--vscode-badge-background, #4d4d4d);
  --fls-badge-fg: var(--vscode-badge-foreground, #ffffff);
  --fls-font: var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --fls-mono: var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Consolas, monospace);
  --fls-font-size: var(--vscode-font-size, 13px);

  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: var(--fls-font);
  font-size: var(--fls-font-size);
  line-height: 1.35;
  color: var(--fls-fg);
  background-color: var(--fls-bg);
  border: 1px solid var(--fls-border);
  border-radius: 4px;
  overflow: hidden;
}

.fls-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--fls-sep);
}

.fls-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  font: inherit;
  color: var(--fls-input-fg);
  background-color: var(--fls-input-bg);
  border: 1px solid var(--fls-input-border);
  border-radius: 3px;
  outline: none;
}

.fls-input:focus {
  border-color: var(--fls-focus);
}

.fls-input::placeholder {
  color: var(--fls-placeholder);
}

.fls-clear {
  flex: none;
  padding: 2px 6px;
  font: inherit;
  color: var(--fls-fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}

.fls-clear:hover {
  background-color: var(--fls-hover-bg);
}

.fls-clear[hidden] {
  display: none;
}

.fls-notes {
  padding: 4px 10px;
  font-size: 0.88em;
  color: var(--fls-warning-fg);
}

.fls-notes[hidden] {
  display: none;
}

.fls-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}

.fls-row {
  display: block;
  padding: 5px 10px;
  cursor: pointer;
  border-left: 2px solid transparent;
}

.fls-row:hover {
  background-color: var(--fls-hover-bg);
}

.fls-row.fls-active {
  background-color: var(--fls-active-bg);
  color: var(--fls-active-fg);
  border-left-color: var(--fls-focus);
}

.fls-row.fls-active .fls-row-facts,
.fls-row.fls-active .fls-row-why,
.fls-row.fls-active .fls-row-id {
  color: var(--fls-active-fg);
}

.fls-row-id {
  font-family: var(--fls-mono);
  color: var(--fls-code-fg);
  overflow-wrap: anywhere;
}

.fls-row-id mark {
  color: var(--fls-mark-fg);
  background-color: var(--fls-mark-bg);
  border-radius: 2px;
}

.fls-row-facts {
  color: var(--fls-fg-muted);
  font-size: 0.9em;
}

.fls-row-why {
  color: var(--fls-fg-muted);
  font-size: 0.88em;
  font-style: italic;
}

.fls-row-warning {
  margin-top: 2px;
  font-size: 0.88em;
  color: var(--fls-warning-fg);
}

.fls-tag {
  flex: none;
  margin-left: 6px;
  padding: 0 5px;
  font-size: 0.8em;
  border-radius: 8px;
  background-color: var(--fls-badge-bg);
  color: var(--fls-badge-fg);
}

.fls-empty {
  padding: 10px;
  color: var(--fls-fg-muted);
}

.fls-foot {
  flex: none;
  padding: 4px 10px;
  font-size: 0.85em;
  color: var(--fls-fg-muted);
  border-top: 1px solid var(--fls-sep);
}
`

/** Injects `SEARCH_STYLESHEET` into `doc` once. Idempotent.
 *
 * The nonce dance is palette.ts's and is copied here rather than shared, because sharing it would
 * make this module depend on the menu for the ability to draw. A webview serves its page under a
 * Content-Security-Policy whose style-src is a nonce; a `<style>` created at runtime carries none,
 * so it is refused silently and the panel renders as unstyled text. The nonce is copied off a
 * style element the document was SERVED with -- the browser blanks the content attribute after
 * load but the element keeps the value and hands it back through the IDL property. With no nonce
 * to copy (a plain page, a test harness) the element is appended anyway: such a page has no policy
 * to violate. */
export function installSearchStyles(doc: Document = document): void {
  const id = 'fls-search-styles'
  if (doc.getElementById(id) !== null) return
  const style = doc.createElement('style')
  style.id = id
  const served = doc.querySelector('style[nonce]') as HTMLStyleElement | null
  const nonce = served?.nonce ?? ''
  if (nonce !== '') style.nonce = nonce
  style.textContent = SEARCH_STYLESHEET
  doc.head.append(style)
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface SearchBoxOptions {
  index: SearchIndex
  /** The graph the index was built from. Held only so a filter can be described against it. */
  graph: GraphWire
  /** Where the box appends itself. */
  container: HTMLElement
  /** "Go to this node" -- select it and put the camera on it. The host owns both; this module
   * never touches a GraphView. */
  onReveal: (hit: SearchHit) => void
  /** The active result changed. A host that wants the camera to follow while arrowing binds this;
   * one that does not, does not. Called with null when there is no active result. */
  onPreview?: (hit: SearchHit | null) => void
  /** Draw only this. Called with null to put everything back. */
  onFilter?: (filter: GraphFilter | null) => void
  /** The box gave up focus (Escape on an empty query). */
  onClose?: () => void
  /** How the canvas filter grows the match set. `'neighbours'` by default: a match on its own with
   * its parents hidden is a box floating in space, which is not the thing somebody was looking
   * for. */
  filterScope?: FilterScope
  limit?: number
  document?: Document
}

export interface SearchBox {
  readonly element: HTMLElement
  focus(): void
  /** Replaces the index and graph after a reload, keeping the query and re-running it -- so a save
   * does not throw away what somebody had typed. */
  setSource(index: SearchIndex, graph: GraphWire): void
  setQuery(query: string): void
  /** The current result, for a host that wants to drive something else off it. */
  result(): SearchResult
  /** Drops any canvas filter, notifying `onFilter`. */
  clearFilter(): void
  dispose(): void
}

/** The search panel: an input, a listbox and a footer.
 *
 * Everything it decides, it decides by calling layer 1. The only judgement in this function is
 * about DOM: which element gets which ARIA attribute, and when to scroll a row into view.
 *
 * A COMBOBOX, not a search landmark with a focusable list -- the same choice palette.ts makes and
 * for the same reason. Focus stays in the text field so typing always filters, while
 * `aria-activedescendant` moves what is announced. Moving real focus onto each row would mean
 * every arrow key steals focus out of the box and the next character goes nowhere. */
export function createSearchBox(options: SearchBoxOptions): SearchBox {
  const doc = options.document ?? options.container.ownerDocument ?? document
  installSearchStyles(doc)

  let index = options.index
  let graph = options.graph
  let state: SearchBoxState = { query: '', activeIndex: -1, filtered: false }
  let current: SearchResult = searchGraph(index, '', { limit: options.limit })
  let rows: HTMLElement[] = []
  let disposed = false

  const root = doc.createElement('div')
  root.className = 'fls-search'
  root.setAttribute('role', 'search')

  const head = doc.createElement('div')
  head.className = 'fls-head'
  const input = doc.createElement('input')
  input.className = 'fls-input'
  input.type = 'text'
  input.placeholder = SEARCH_STRINGS.placeholder
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-expanded', 'true')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-label', SEARCH_STRINGS.inputLabel)
  const clear = doc.createElement('button')
  clear.className = 'fls-clear'
  clear.type = 'button'
  clear.textContent = SEARCH_STRINGS.clear
  clear.hidden = true
  head.append(input, clear)

  const notes = doc.createElement('div')
  notes.className = 'fls-notes'
  notes.hidden = true

  const list = doc.createElement('div')
  list.className = 'fls-list'
  list.id = `fls-list-${Math.random().toString(36).slice(2, 8)}`
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', SEARCH_STRINGS.listLabel)
  input.setAttribute('aria-controls', list.id)

  const foot = doc.createElement('div')
  foot.className = 'fls-foot'
  // Announced when it changes, so somebody driving this by keyboard hears how many matched without
  // having to arrow into the list to find out.
  foot.setAttribute('aria-live', 'polite')

  root.append(head, notes, list, foot)
  options.container.append(root)

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** The id with its matched runs wrapped in <mark>. Built from the ranges rather than from a
   * re-search, so what is highlighted is exactly what was matched -- including the letters of a
   * subsequence match, which is the one case where a naive re-search would highlight nothing and
   * leave the row looking like it matched for no reason. */
  function idElement(hit: SearchHit): HTMLElement {
    const el = doc.createElement('div')
    el.className = 'fls-row-id'
    let at = 0
    for (const range of hit.ranges) {
      if (range.start > at) el.append(doc.createTextNode(hit.nodeId.slice(at, range.start)))
      const mark = doc.createElement('mark')
      mark.textContent = hit.nodeId.slice(range.start, range.end)
      el.append(mark)
      at = range.end
    }
    if (at < hit.nodeId.length) el.append(doc.createTextNode(hit.nodeId.slice(at)))
    return el
  }

  function drawRow(hit: SearchHit, position: number): HTMLElement {
    const el = doc.createElement('div')
    el.className = 'fls-row'
    el.id = `${list.id}-r${position}`
    el.setAttribute('role', 'option')
    el.setAttribute('aria-selected', 'false')
    el.dataset.nodeId = hit.nodeId
    el.append(idElement(hit))

    const facts = doc.createElement('div')
    facts.className = 'fls-row-facts'
    facts.textContent = describeHit(hit)
    el.append(facts)

    if (hit.detail.why.length > 0) {
      const why = doc.createElement('div')
      why.className = 'fls-row-why'
      why.textContent = hit.detail.why
      el.append(why)
    }
    if (hit.detail.warning.length > 0) {
      const warning = doc.createElement('div')
      warning.className = 'fls-row-warning'
      warning.textContent = hit.detail.warning
      el.append(warning)
    }

    // Everything the row says, in one string, because a screen reader announces the option's
    // label and not the three divs inside it.
    el.setAttribute(
      'aria-label',
      [hit.nodeId, describeHit(hit), hit.detail.why, hit.detail.warning].filter((s) => s.length > 0).join('. '),
    )
    return el
  }

  function draw(): void {
    list.textContent = ''
    rows = []
    for (const [position, hit] of current.hits.entries()) {
      const row = drawRow(hit, position)
      rows.push(row)
      list.append(row)
    }
    if (rows.length === 0) {
      const empty = doc.createElement('div')
      empty.className = 'fls-empty'
      empty.textContent = current.summary
      list.append(empty)
    }

    // Nothing below the input until somebody types. The box floats over the canvas, so an idle
    // panel of guidance sits on top of the graph permanently -- and it repeated the same sentence
    // in two places, because the notes and the footer both describe an empty query. The input's
    // own placeholder already says what this is for, which is as much as an untouched control
    // should say.
    const idle = state.query.trim().length === 0
    notes.hidden = idle || current.notes.length === 0
    notes.textContent = current.notes.join(' ')
    foot.hidden = idle
    list.hidden = idle
    clear.hidden = state.query.length === 0

    // The keyboard hint only where there is something to press Enter on. Telling somebody that
    // Enter goes there, under a line saying nothing matched, is a small lie.
    foot.textContent = current.hits.length === 0 ? current.summary : `${current.summary} ${SEARCH_STRINGS.keysHint}`

    applyActive()
  }

  function applyActive(): void {
    for (const [i, row] of rows.entries()) {
      const on = i === state.activeIndex
      row.classList.toggle('fls-active', on)
      row.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    const active = rows[state.activeIndex]
    if (active === undefined) {
      input.removeAttribute('aria-activedescendant')
      options.onPreview?.(null)
      return
    }
    input.setAttribute('aria-activedescendant', active.id)
    active.scrollIntoView({ block: 'nearest' })
    const hit = current.hits[state.activeIndex]
    if (hit !== undefined) options.onPreview?.(hit)
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  function runQuery(): void {
    current = searchGraph(index, state.query, { limit: options.limit })
    // The first result is active the moment there is one: Enter should go somewhere without an
    // arrow key first, which is what makes typing a name you already know a two-gesture operation.
    state = { ...state, activeIndex: current.hits.length > 0 ? 0 : -1 }
    draw()
    if (state.filtered) applyFilter()
  }

  function applyFilter(): void {
    if (options.onFilter === undefined) return
    options.onFilter(filterGraph(index, graph, current.matchedIds, { scope: options.filterScope ?? 'neighbours' }))
  }

  function perform(action: SearchAction): void {
    switch (action.kind) {
      case 'reveal': {
        const hit = current.hits[action.index]
        if (hit !== undefined) options.onReveal(hit)
        return
      }
      case 'filter':
        applyFilter()
        return
      case 'clear-filter':
        options.onFilter?.(null)
        return
      case 'clear-query':
        input.value = ''
        runQuery()
        return
      case 'close':
        options.onClose?.()
        return
      default:
        return
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    const before = state
    const { state: next, action } = applyKey(
      { ...state, query: input.value },
      {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
      current.hits.length,
    )
    if (action.kind === 'passthrough') return
    state = next
    event.preventDefault()
    // Moving the active row repaints two attributes; only a change of query or of filter state
    // rebuilds the list. Redrawing fifty rows on every Enter was the first version, and on a
    // result set somebody is walking with Enter that is fifty elements rebuilt per keystroke.
    if (next.activeIndex !== before.activeIndex) applyActive()
    if (action.kind !== 'clear-query' && next.filtered !== before.filtered) draw()
    perform(action)
  }

  function onInput(): void {
    state = { ...state, query: input.value }
    runQuery()
  }

  function onListPointerDown(event: PointerEvent): void {
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest('.fls-row')
    if (row === null) return
    const at = rows.indexOf(row as HTMLElement)
    if (at < 0) return
    state = { ...state, activeIndex: at }
    applyActive()
    const hit = current.hits[at]
    if (hit !== undefined) options.onReveal(hit)
    // Focus goes back to the box, never to the row: the next thing somebody does after choosing a
    // result is almost always type a different query.
    input.focus()
    event.preventDefault()
  }

  function onClearClick(): void {
    input.value = ''
    state = { ...state, query: '' }
    runQuery()
    input.focus()
  }

  input.addEventListener('keydown', onKeyDown)
  input.addEventListener('input', onInput)
  list.addEventListener('pointerdown', onListPointerDown)
  clear.addEventListener('click', onClearClick)

  draw()

  return {
    element: root,
    focus(): void {
      input.focus()
      input.select()
    },
    setSource(nextIndex: SearchIndex, nextGraph: GraphWire): void {
      index = nextIndex
      graph = nextGraph
      runQuery()
    },
    setQuery(query: string): void {
      input.value = query
      state = { ...state, query }
      runQuery()
    },
    result: () => current,
    clearFilter(): void {
      if (!state.filtered) return
      state = { ...state, filtered: false }
      options.onFilter?.(null)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      input.removeEventListener('keydown', onKeyDown)
      input.removeEventListener('input', onInput)
      list.removeEventListener('pointerdown', onListPointerDown)
      clear.removeEventListener('click', onClearClick)
      root.remove()
    },
  }
}
