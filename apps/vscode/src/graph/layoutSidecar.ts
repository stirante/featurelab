// layoutSidecar.ts -- where hand-placed node positions live, and how they merge with layout.ts's
// automatic ones.
//
// A position has nowhere to go in the vanilla schema. A feature file is read by the game, and
// every key in it means something to the game; there is no "x"/"y" the engine would accept and
// no place to invent one. So positions go in a sidecar, `.featurelab-layout.json`, written beside
// the pack (next to manifest.json, at the pack root resolvePackRoot already computes).
//
// The format, deliberately boring:
//
//   {
//     "version": 1,
//     "nodes": {
//       "wiki:oak_tree":   { "x": 340, "y": 120 },
//       "wiki:birch_tree": { "x": 340, "y": 260 }
//     }
//   }
//
// Keyed by node id, because that is the one identifier the contract guarantees ("namespace:id",
// unique across the graph) and the one thing that survives a file being renamed or a feature
// being moved between files. Keys are written sorted and the file ends in a newline, so two
// editors that place the same nodes produce the same bytes and the file does not churn a diff
// every time it is saved.
//
// ONE FLAT MAP FOR THE WHOLE PACK, not one per graph. A pack's node ids are unique pack-wide, so
// a flat map needs no scoping to be unambiguous, and a feature shared by two rules keeps one
// position in both drawings -- which is arguably the right answer anyway (the same box in the
// same place is easier to recognise than the same box in two places). The cost is real and worth
// stating: someone who wants a shared feature arranged differently in two rules' views cannot
// have it. Adding that later means adding a scope above `nodes`, which is why `version` is in the
// file from the start.
//
// EVERYTHING HERE TOLERATES A BROKEN FILE. It is a dotfile in someone else's pack; it may be
// absent, empty, half-written by a crashed editor, merge-conflicted, or hand-edited into
// nonsense, and none of those may stop a graph opening. Reading therefore never throws: it
// returns the positions it could salvage plus a `problem` string describing what it could not,
// for the caller to show as a notice rather than an error. Writing is the one operation that does
// throw -- a save that silently did not happen is worse than one that reports why.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  autoLayout,
  positionsFromAnnotations,
  type LayoutGraph,
  type LayoutOptions,
  type LayoutPosition,
  type LayoutPositions,
} from './layout.js'

/** Beside the pack, not inside features/ -- one file per pack, and a leading dot so it sorts out
 * of the way and is easy to .gitignore for anyone who does not want to share their arrangement. */
export const SIDECAR_FILENAME = '.featurelab-layout.json'

/** Bumped only for a change that an older reader would MISREAD, not for one it would merely fail
 * to use. A reader here accepts any version whose `nodes` it understands (see parseSidecar). */
export const SIDECAR_VERSION = 1

export interface LayoutSidecar {
  version: number
  /** Node id -> explicit position. Positions are in the same units and the same top-left
   * convention as layout.ts's LayoutPosition. */
  nodes: Record<string, LayoutPosition>
}

export interface SidecarReadResult {
  sidecar: LayoutSidecar
  /** What could not be used, in a sentence fit to show a user, or null when the file was read
   * cleanly. A MISSING file is clean -- most packs have never been opened in this editor -- so
   * `existed` is what distinguishes "no file" from "no problem". */
  problem: string | null
  existed: boolean
}

/** Where a node's final position came from. Exposed so the UI can tell a pinned node from an
 * auto-placed one (a dragged node that silently re-flows on the next reload is a bug report). */
export type PositionSource = 'auto' | 'annotation' | 'sidecar'

export interface ResolvedLayout {
  positions: LayoutPositions
  sources: Record<string, PositionSource>
  /** Ids whose position was explicit -- from the sidecar or from an `@featurelab:layout`
   * annotation -- in graph order. */
  pinned: string[]
  /** Ids the sidecar has a position for that are NOT in this graph, sorted. See resolveLayout's
   * comment: these are kept, not dropped. */
  orphaned: string[]
}

export interface LoadedLayout extends ResolvedLayout {
  /** The sidecar as read, for a caller that is about to modify and write it back. Merging into
   * THIS value rather than building a fresh one is what stops saving one graph's positions from
   * erasing every other graph's. */
  sidecar: LayoutSidecar
  problem: string | null
  existed: boolean
}

export function sidecarPath(packRoot: string): string {
  return path.join(packRoot, SIDECAR_FILENAME)
}

export function emptySidecar(): LayoutSidecar {
  return { version: SIDECAR_VERSION, nodes: {} }
}

/** Reads the sidecar for `packRoot`. Never throws -- a missing file, a directory where the file
 * should be, an unreadable file and a file full of nonsense all resolve to "no positions, here is
 * why", because the alternative is an editor that refuses to open a pack it did not author. */
export function readSidecar(packRoot: string): SidecarReadResult {
  const file = sidecarPath(packRoot)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { sidecar: emptySidecar(), problem: null, existed: false }
    return {
      sidecar: emptySidecar(),
      problem: `could not read ${SIDECAR_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
      existed: true,
    }
  }
  const parsed = parseSidecar(text)
  return { sidecar: parsed.sidecar, problem: parsed.problem, existed: true }
}

/** Parses sidecar text. Split out from readSidecar so the tolerance rules can be tested without
 * a filesystem, and so a caller holding the text already (an open editor document, say) does not
 * have to round-trip through disk.
 *
 * Tolerance is PER ENTRY, not per file: one node whose position is a string does not discard the
 * other forty that were fine. Only damage at the top level -- not JSON at all, not an object, no
 * usable `nodes` -- costs the whole file, because at that point there is nothing to salvage. */
export function parseSidecar(text: string): { sidecar: LayoutSidecar; problem: string | null } {
  // An empty file is what a crashed or interrupted write leaves behind, and is common enough to
  // be worth not calling malformed: there is simply nothing in it.
  if (text.trim().length === 0) return { sidecar: emptySidecar(), problem: null }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      sidecar: emptySidecar(),
      problem: `${SIDECAR_FILENAME} is not valid JSON (${detail}); node positions were laid out automatically`,
    }
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return {
      sidecar: emptySidecar(),
      problem: `${SIDECAR_FILENAME} does not contain a JSON object; node positions were laid out automatically`,
    }
  }
  const obj = root as Record<string, unknown>
  const rawNodes = obj.nodes
  if (typeof rawNodes !== 'object' || rawNodes === null || Array.isArray(rawNodes)) {
    return {
      sidecar: emptySidecar(),
      problem: `${SIDECAR_FILENAME} has no "nodes" object; node positions were laid out automatically`,
    }
  }

  // A version this reader has never heard of is NOT rejected. A position is a position, and
  // discarding a newer editor's whole arrangement because it also wrote a key we do not
  // understand would be the more destructive choice -- the unknown keys are simply not carried
  // through a write (see serializeSidecar).
  const version = typeof obj.version === 'number' && Number.isFinite(obj.version) ? obj.version : SIDECAR_VERSION

  const nodes: Record<string, LayoutPosition> = {}
  let skipped = 0
  for (const [id, value] of Object.entries(rawNodes as Record<string, unknown>)) {
    const position = readPosition(value)
    if (position === null) {
      skipped++
      continue
    }
    nodes[id] = position
  }
  const plural = skipped === 1 ? 'position; it was' : 'positions; they were'
  const problem = skipped === 0 ? null : `${SIDECAR_FILENAME} has ${skipped} unusable node ${plural} laid out automatically`
  return { sidecar: { version, nodes }, problem }
}

/** A position is two finite numbers and nothing else. NaN and Infinity are rejected rather than
 * passed through because they do not fail where they are read -- they fail much later, as a node
 * rendered at an impossible offset or a viewport that will not fit its content. */
function readPosition(value: unknown): LayoutPosition | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { x, y } = value as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** The exact bytes writeSidecar puts on disk. Keys sorted, two-space indent, trailing newline:
 * the sidecar sits in a pack that is very likely in git, so a save that only moved one node must
 * produce a one-node diff. */
export function serializeSidecar(sidecar: LayoutSidecar): string {
  const nodes: Record<string, LayoutPosition> = {}
  for (const id of Object.keys(sidecar.nodes ?? {}).sort()) {
    const position = sidecar.nodes[id]
    if (position !== undefined) nodes[id] = { x: position.x, y: position.y }
  }
  const version = Number.isFinite(sidecar.version) ? sidecar.version : SIDECAR_VERSION
  return `${JSON.stringify({ version, nodes }, null, 2)}\n`
}

/** Writes the sidecar for `packRoot`. Unlike every read path here this DOES throw, and callers
 * should surface the failure: a position the user dragged and that was then quietly not saved is
 * indistinguishable, next time they open the graph, from the editor having lost their work. */
export function writeSidecar(packRoot: string, sidecar: LayoutSidecar): void {
  fs.writeFileSync(sidecarPath(packRoot), serializeSidecar(sidecar), 'utf-8')
}

/** Returns a new sidecar with `id` pinned at `position`. Immutable update rather than a mutation
 * so a caller can hold the previous value for an undo without having to clone defensively. */
export function withPosition(sidecar: LayoutSidecar, id: string, position: LayoutPosition): LayoutSidecar {
  return {
    version: sidecar.version,
    nodes: { ...sidecar.nodes, [id]: { x: position.x, y: position.y } },
  }
}

/** Returns a new sidecar with `id` un-pinned, so it goes back to auto-layout. */
export function withoutPosition(sidecar: LayoutSidecar, id: string): LayoutSidecar {
  const nodes = { ...sidecar.nodes }
  delete nodes[id]
  return { version: sidecar.version, nodes }
}

/** Drops every position whose node id is not in `keep`.
 *
 * Deliberately NOT what writing does by default. A node disappears from a graph for two very
 * different reasons: it was deleted, or its file is momentarily unparseable / its rule is not the
 * one currently open. The second is far more common -- it happens on most keystrokes in the JSON
 * -- and pruning on write would mean a typo silently destroyed an arrangement someone spent time
 * on. So stale entries are kept, cost a few bytes, and are removed only when a caller decides to,
 * with the full set of ids it means to keep. */
export function prunePositions(sidecar: LayoutSidecar, keep: Iterable<string>): LayoutSidecar {
  const keepSet = keep instanceof Set ? keep : new Set(keep)
  const nodes: Record<string, LayoutPosition> = {}
  for (const [id, position] of Object.entries(sidecar.nodes ?? {})) {
    if (keepSet.has(id)) nodes[id] = position
  }
  return { version: sidecar.version, nodes }
}

/** The merge: auto-layout for every node, overridden by an `@featurelab:layout` annotation,
 * overridden by the sidecar.
 *
 * That precedence is the interesting part. The annotation is committed with the pack and is what
 * its author meant everyone to see; the sidecar is this machine's working state and is therefore
 * newer by construction -- it is written by the last drag that happened here. A user who drags a
 * node must see it stay where they dropped it, even in a pack whose author annotated it, so the
 * sidecar wins.
 *
 * Auto-layout runs over the WHOLE graph, including the pinned nodes, and the pins are then
 * applied on top. It would be possible to instead treat pins as fixed constraints and lay the
 * rest out around them -- and that is rejected on purpose: it would mean dragging one node moved
 * every other node, so a small correction would rearrange the drawing the user was correcting.
 * Pinning a node here moves exactly that node, and nothing else. */
export function resolveLayout(
  graph: LayoutGraph,
  sidecar: LayoutSidecar | null | undefined,
  options: LayoutOptions = {},
): ResolvedLayout {
  const positions: LayoutPositions = { ...autoLayout(graph, options) }
  const sources: Record<string, PositionSource> = {}
  for (const id of Object.keys(positions)) sources[id] = 'auto'

  const annotated = positionsFromAnnotations(graph)
  for (const [id, position] of Object.entries(annotated)) {
    if (positions[id] === undefined) continue // annotated node not in this graph: nothing to place
    positions[id] = position
    sources[id] = 'annotation'
  }

  const saved = sidecar?.nodes ?? {}
  const orphaned: string[] = []
  for (const [id, position] of Object.entries(saved)) {
    // A saved position for a node the graph no longer has is REPORTED, not applied and not
    // dropped: applying it would put a box on screen for a feature that does not exist, and
    // dropping it would lose the arrangement of a rule the user simply does not have open.
    if (positions[id] === undefined) {
      orphaned.push(id)
      continue
    }
    positions[id] = position
    sources[id] = 'sidecar'
  }
  orphaned.sort()

  // A graph node the sidecar has never heard of -- the other constant case, since every newly
  // added feature starts here -- needs no handling at all beyond this: it keeps the auto position
  // it already has, which is the whole point of merging rather than replacing.
  const pinned = Object.keys(positions).filter((id) => sources[id] !== 'auto')
  return { positions, sources, pinned, orphaned }
}

/** Read the sidecar and resolve the layout in one call, for the common case. Never throws, for
 * the same reason readSidecar does not: opening someone else's pack must work. */
export function loadLayout(packRoot: string, graph: LayoutGraph, options: LayoutOptions = {}): LoadedLayout {
  const read = readSidecar(packRoot)
  const resolved = resolveLayout(graph, read.sidecar, options)
  return { ...resolved, sidecar: read.sidecar, problem: read.problem, existed: read.existed }
}
