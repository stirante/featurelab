// incomplete.ts -- "this node still needs a feature", instead of a ghost node nobody asked for.
//
// # The bug this exists to remove
//
// A newly created feature rule has to name a feature; a rule with no `places_feature` is refused
// by the engine, and a refused file produces no node at all, so creating a rule would show the
// author nothing. The way round that was to write a placeholder reference -- one shared constant,
// PLACEHOLDER_FEATURE -- so the file loads and the node appears.
//
// The cost only shows up on the second one. The placeholder is the SAME id every time, so the
// engine resolves every unattached rule and every freshly seeded compound to one dangling node,
// and the canvas draws them all converging on it. Two things a author made seconds apart, with
// nothing to do with each other, arrive joined together -- reported as "tworzę nowy feature rule
// i nagle mam od razu odnośnik do nieistniejącego replace_me... następnie dodaję prosty column
// feature i on nagle jest też podłączony pod nieistniejący replace_me".
//
// A per-node placeholder would split the ghosts apart and leave one dangling node per unfinished
// thing, which is more honest and just as much clutter. The author's own suggestion is better
// than either: draw no ghost, and say on the node that something is missing.
//
// # Why the placeholder stays in the FILE
//
// Nothing here changes what is written. The file keeps a loadable reference, because the
// alternative -- omit the key -- makes the engine refuse the file, and a refused file has no node
// for a badge to sit on. So the sentinel is a presentation concern: the pack on disk is always a
// pack that loads, and this module decides what the canvas does with a reference that is
// obviously a stand-in.
//
// # What counts as missing
//
// Only a reference to the sentinel. A dangling reference an author TYPED is a real problem and
// keeps its dangling node: they meant something by it, possibly a feature they are about to
// write, and silently reshaping it into a badge would hide a genuine broken link. The sentinel is
// different because this editor wrote it, seconds ago, precisely as a thing to replace.

import type { SingleSlot } from './connect.js'
import { listSlotFor, singleSlotsFor } from './connect.js'
import { PLACEHOLDER_FEATURE } from './compounds/spec.js'

/** The node shape this module needs -- a narrowing of wire.GraphNode, so a caller hands over its
 * graph unchanged. */
export interface IncompleteNode {
  id: string
  typeId?: string
  unresolved?: boolean
  fields?: Record<string, unknown>
}

/** The edge shape this module needs -- a narrowing of wire.GraphEdge. */
export interface IncompleteEdge {
  from: string
  to: string
  kind: string
  jsonPath: string
  required: boolean
}

export interface IncompleteGraph {
  nodes: readonly IncompleteNode[]
  edges: readonly IncompleteEdge[]
}

/** Whether `id` is the stand-in this editor writes when it has to name a feature and does not
 * know one yet. Case-folded, because feature identifiers are looked up case-folded and an
 * author who retyped it in another case still means the placeholder. */
export function isPlaceholderRef(id: string): boolean {
  return id.toLowerCase() === PLACEHOLDER_FEATURE.toLowerCase()
}

/** One thing a node is waiting for. */
export interface MissingSlot {
  /** The node that needs something. */
  nodeId: string
  /** Where the reference goes, as the edge that currently points at the placeholder reports it.
   * Writing the chosen feature here is the whole of "attach it". */
  jsonPath: string
  /** The slot's own name, for a panel that has to say which of two slots is empty. Empty when
   * the type has exactly one and naming it would be noise. */
  label: string
  /** What the parent does with the child, in the author's terms -- straight from connect.ts, so
   * the sentence an author reads while choosing is the same one the connect affordance uses. */
  doc: string
}

export interface IncompleteView {
  /** The graph with the placeholder's dangling node and the edges into it removed. Everything
   * else is untouched and identity-preserved: a caller can keep using its own node objects. */
  graph: IncompleteGraph
  /** Node id to what it is still waiting for, in the order the edges were reported. Only nodes
   * with something missing appear. */
  missing: ReadonlyMap<string, readonly MissingSlot[]>
}

/**
 * Removes the placeholder ghost and reports who was pointing at it.
 *
 * Deliberately NOT a filter over ids alone: the dangling node is dropped only when it is the
 * sentinel AND unresolved. A pack that genuinely defines a feature called `example:replace_me`
 * has a real node with a real file, and hiding that would be this editor deciding an author's own
 * feature does not exist.
 */
export function viewWithoutPlaceholders(graph: IncompleteGraph): IncompleteView {
  const defined = new Set<string>()
  for (const node of graph.nodes) if (node.unresolved !== true) defined.add(node.id.toLowerCase())

  // A sentinel reference is only a stand-in while nothing defines it.
  const sentinelIsReal = defined.has(PLACEHOLDER_FEATURE.toLowerCase())

  const missing = new Map<string, MissingSlot[]>()
  if (sentinelIsReal) {
    return { graph, missing }
  }

  const slotsByType = new Map<string, readonly SingleSlot[]>()
  const describe = (node: IncompleteNode | undefined, edge: IncompleteEdge): { label: string; doc: string } => {
    if (node === undefined) return { label: '', doc: '' }
    let slots = slotsByType.get(node.typeId ?? '')
    if (slots === undefined) {
      slots = singleSlotsFor({ typeId: node.typeId, fields: node.fields } as Parameters<typeof singleSlotsFor>[0])
      slotsByType.set(node.typeId ?? '', slots)
    }
    // One slot needs no name; several do, and then the edge's own path is what tells them apart.
    const only = slots.length === 1 ? slots[0] : slots.find((slot) => edge.jsonPath.includes(slot.path.join('.')))
    if (only !== undefined) return { label: slots.length === 1 ? '' : only.label, doc: only.doc }
    const list = listSlotFor({ typeId: node.typeId, fields: node.fields } as Parameters<typeof listSlotFor>[0])
    return { label: '', doc: list?.doc ?? '' }
  }

  const byId = new Map<string, IncompleteNode>()
  for (const node of graph.nodes) if (!byId.has(node.id)) byId.set(node.id, node)

  const edges: IncompleteEdge[] = []
  for (const edge of graph.edges) {
    if (!isPlaceholderRef(edge.to)) {
      edges.push(edge)
      continue
    }
    const { label, doc } = describe(byId.get(edge.from), edge)
    const list = missing.get(edge.from)
    const slot: MissingSlot = { nodeId: edge.from, jsonPath: edge.jsonPath, label, doc }
    if (list === undefined) missing.set(edge.from, [slot])
    else list.push(slot)
  }

  const nodes = graph.nodes.filter((node) => !(node.unresolved === true && isPlaceholderRef(node.id)))
  return { graph: { nodes, edges }, missing }
}

/**
 * The sentence a node's badge says, or null when nothing is missing.
 *
 * Phrased as what to DO, not as what is wrong. "Unresolved reference" describes the file; "needs
 * a feature to place" describes the next click, and the author is one click away from making it
 * true. The count is only mentioned when there is more than one, because "1 missing" on a type
 * that can only ever want one thing is a number doing no work.
 */
export function describeMissing(slots: readonly MissingSlot[]): string | null {
  if (slots.length === 0) return null
  if (slots.length === 1) {
    const named = slots[0]!.label
    return named === '' ? 'Needs a feature to place' : `Needs a feature for ${named}`
  }
  return `Needs ${slots.length} features`
}

/**
 * `fields` for a NEW node, with every required single delegation pointed at the stand-in.
 *
 * Creating a plain feature from the palette seeded only what the type catalogue describes, and a
 * delegation is deliberately not in the catalogue -- it is an edge. So a new scatter had no
 * `places_feature` at all, and neither did a new snap_to_surface, surface_relative_threshold or
 * height_difference_filter. Each of those REQUIRES its reference, so every one of them was written
 * as a file the engine refuses. And because there was no reference, there was no edge: nothing
 * said the node needed a feature, and a scatter's `iterations` -- which is carried on that edge --
 * had nowhere to be shown.
 *
 * A feature rule and a compound have always been created with the stand-in, which is what makes
 * them load, draw "Needs a feature to place" instead of a ghost, and start the pick-a-feature
 * chain. This gives a plain feature the same.
 *
 * Only REQUIRED single slots. An optional one (a tree trunk's decoration) left absent is a
 * complete file, and pointing it at a stand-in would invent a delegation nobody asked for. List
 * slots are not handled here: an aggregate, sequence or weighted list has its own entry shape,
 * and seeding one wrongly would be the same fault moved somewhere else.
 *
 * Never overwrites a reference that is already there.
 */
export function withPlaceholderDelegations(typeId: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>
  for (const slot of singleSlotsFor({ typeId, fields: out } as Parameters<typeof singleSlotsFor>[0])) {
    if (!slot.required || slot.path.length === 0) continue
    let parent: Record<string, unknown> = out
    for (const segment of slot.path.slice(0, -1)) {
      const next = parent[segment]
      if (typeof next !== 'object' || next === null || Array.isArray(next)) parent[segment] = {}
      parent = parent[segment] as Record<string, unknown>
    }
    const last = slot.path[slot.path.length - 1] as string
    if (parent[last] === undefined) parent[last] = PLACEHOLDER_FEATURE
  }
  return out
}

/**
 * A new scatter's required `iterations`, in whichever shape its seed already chose.
 *
 * The type catalogue leaves `iterations` out on purpose -- it is carried on the scatter's edge, and
 * a second control for it in the form would be two editors for one value. The cost was that seeding
 * a new scatter from that catalogue never wrote it, so a scatter created from the palette was
 * `"distribution": {}` and the engine refused it: "distribution.iterations must be a number or
 * Molang string".
 *
 * The SHAPE is not decided here. The seed has already written `distribution` for a format version
 * that takes it and left it out for one that does not, so this follows what is there -- the same
 * rule the graph builder uses to find `iterations` in an existing file. Deciding again from the
 * version would be a second, separate place to get that wrong.
 *
 * 1, as a new feature rule gets: one placement. 0 would load and then place nothing forever, which
 * is a file that looks finished and is not.
 */
export function withScatterIterations(typeId: string, fields: Record<string, unknown>): Record<string, unknown> {
  if (typeId !== 'minecraft:scatter_feature') return fields
  const out = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>
  const distribution = out['distribution']
  if (typeof distribution === 'object' && distribution !== null && !Array.isArray(distribution)) {
    const nested = distribution as Record<string, unknown>
    if (nested['iterations'] === undefined) nested['iterations'] = 1
  } else if (out['iterations'] === undefined) {
    out['iterations'] = 1
  }
  return out
}
