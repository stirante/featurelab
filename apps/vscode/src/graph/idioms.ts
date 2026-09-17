// idioms.ts -- the four things pack authors actually DO to a feature graph, offered as single
// actions instead of as a sequence of hand-edits across two or three files.
//
// The raw JSON schema names none of these. A pack author who wants "place this only when the
// noise is high" writes a scatter_feature whose `iterations` multiplies a comparison by a count,
// because a scatter that iterates zero times places nothing; one who wants to hand a placed
// feature a value writes `variable.* = ...` in that same `iterations`, because its Molang scope
// is shared by reference with everything the scatter delegates to. Both are idioms with no key
// of their own, both are load-bearing in real packs (wire/graph.go's GraphEdge.Iterations says
// so at length), and both are assembled by hand every single time. The same goes for pulling a
// run of sibling entries out into their own named feature, and for slipping a filter in above an
// existing one -- each is two files edited in lockstep, and getting half of it done is worse than
// not starting.
//
// SHAPE: headless, and deliberately so. Nothing here touches a disk. An action takes the graph
// plus a selection and returns a DESCRIPTION of the edits -- which file, which JSON path, which
// bytes -- that a caller hands to the Go side, where jsonc.Apply splices them into the original
// text with every comment, key order and indent byte the author wrote left alone. That split is
// not a testing convenience that happens to be tidy; it is what keeps the write path in ONE
// place. Two writers means two chances to rewrite a file the author has in version control.
//
// REFUSALS ARE A FEATURE. Every action can answer "no, and here is why": a cycle runs through
// the selection, the id is taken, these entries are not adjacent in a sequence_feature and the
// order children run in is part of the RNG contract. A refusal costs the author one sentence.
// A refactor that got two of its three files written costs them an afternoon with git, and the
// graph in between is a pack that does not load. So every structural assumption below is CHECKED
// and named rather than assumed, including assumptions about the contract's own JSONPath shapes:
// a path this module cannot read is a refusal, never a guess at where the reference lives.
//
// Everything Molang here goes through molangHints.ts -- the catalogue, the idiom classifier, and
// above all the trap it already knows about: a statement sequence with no `return` evaluates to
// 0, which silently switches a scatter OFF. Composing a setup step is exactly the operation that
// walks into that trap, so the composed expression is re-analysed after it is built rather than
// trusted because it was built carefully.
import { seedNewNodeFields } from './forms.js'
import { PUBLISHED_VARIABLES, analyseIterations, isStatementSequence, localProblems } from './molangHints.js'
import {
  ABSENT_FORMAT_VERSION,
  atLeastOrUnversioned,
  minFormatVersionForType,
  parseFormatVersion,
  typeAvailableAt,
  type FormatVersion,
} from './typeCatalog.js'

// ---------------------------------------------------------------------------
// The graph, narrowed
// ---------------------------------------------------------------------------

/** The subset of wire.GraphNode these actions read. A structural subset rather than a copy, for
 * the reason layout.ts gives for doing the same: a decoded GraphNode is assignable to this, and
 * so is a four-field literal in a test, and a field added to the contract never has to be
 * mirrored here. */
export interface IdiomGraphNode {
  readonly id: string
  readonly typeId?: string | undefined
  /** wire.GraphNode.File -- pack-relative, and the only file identity a plan ever uses. Resolving
   * it against a pack root is the caller's job, because this module has no idea where the pack
   * is and would have to be told in order to guess. */
  readonly file?: string | undefined
  readonly formatVersion?: string | undefined
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  readonly unresolved?: boolean | undefined
}

/** The subset of wire.GraphEdge these actions read. `ordinal` is optional here even though the
 * contract always writes it, because it is CROSS-CHECKED against jsonPath below and a missing
 * one must read as "cannot check" rather than as 0. */
export interface IdiomGraphEdge {
  readonly from: string
  readonly to: string
  /** wire.EdgeKind. Widened to `| string` so a kind added to the contract later refuses cleanly
   * instead of failing to type. */
  readonly kind: EdgeKind | string
  readonly jsonPath: string
  readonly ordinal?: number | undefined
  readonly weight?: number | null | undefined
  readonly condition?: string | null | undefined
  readonly iterations?: string | null | undefined
  readonly required?: boolean | undefined
}

/** The subset of wire.Graph these actions read. A decoded Graph is structurally assignable. */
export interface IdiomGraph {
  readonly nodes: readonly IdiomGraphNode[]
  readonly edges: readonly IdiomGraphEdge[]
  readonly roots?: readonly string[] | undefined
  /** Consulted, and not relied on. Every action also finds its own cycles (see nodesOnCycles),
   * so a graph whose `cycles` is stale or absent still refuses the refactors a cycle breaks. */
  readonly cycles?: readonly (readonly string[])[] | undefined
}

export type EdgeKind = 'rule' | 'aggregate' | 'sequence' | 'weighted' | 'conditional' | 'scatter' | 'filter' | 'child'

/** The edge kinds whose parent holds its children in a LIST, which is the only situation in which
 * one parent can contribute more than one edge into a selection -- and therefore the only one in
 * which extraction has to collapse siblings rather than rewrite a single reference. */
const LIST_KINDS: ReadonlySet<string> = new Set(['aggregate', 'sequence', 'weighted', 'conditional'])

const RULE_TYPE_ID = 'minecraft:feature_rule'
const SCATTER_TYPE_ID = 'minecraft:scatter_feature'

/** The format_version at which scatter's parameters moved from flat keys on the body into a
 * nested `distribution` object. The two shapes are mutually exclusive and writing the wrong one
 * does not error -- the engine drops the unknown key unread and then fails on the missing
 * required `iterations` -- so where this module writes an `iterations` depends on it. Mirrors
 * typeCatalog.ts's `since`/`until` on the same keys. */
export const SCATTER_DISTRIBUTION_SINCE = '1.21.10'

// ---------------------------------------------------------------------------
// The edit plan -- what the Go side executes
// ---------------------------------------------------------------------------

/** One change. The three operations map onto exactly what the write side already has: `set` and
 * `delete` become a jsonc.Edit (Path/Value, Path/Delete) applied through jsonc.Apply, and
 * `createFile` is a plain write of a file that does not exist yet -- jsonc.Apply deliberately
 * refuses to conjure containers, so a new feature cannot be expressed as an edit to something.
 *
 * `set` carries BOTH `json` and `value`. The bytes are the authority: jsonc.Edit.Value is raw
 * JSON inserted as given, and re-serialising `value` on the Go side would hand key order to
 * encoding/json -- which sorts map keys -- turning `{description, places_feature}` into
 * `{description, places_feature}` only by luck and `{places_feature, iterations}` into something
 * no author would have written. `value` is there so a caller (and a test) can assert on the
 * change without re-parsing. */
export type PlanOperation =
  | {
      readonly op: 'createFile'
      /** Pack-relative, exactly as GraphNode.File would report it once the file exists. */
      readonly file: string
      /**
       * Set when the file may ALREADY EXIST and is being replaced wholesale.
       *
       * The idiom actions never set it: each of them creates a file that does
       * not exist yet, and a collision is a `file-exists` refusal rather than
       * an overwrite. Compound re-expansion is the case that needs it -- a
       * compound's own file holds its annotation, so it exists from the moment
       * the compound does, and editing a parameter rewrites it. Without this
       * flag the apply path cannot tell that rewrite from a plan that is about
       * to clobber somebody's work, and would have to allow both or neither.
       */
      readonly replace?: boolean
      /** The complete file, ready to write. Ends in a newline. */
      readonly contents: string
      /** The feature this file defines, and its type -- so a caller can register the new node in
       * its own index without re-parsing what it just wrote. */
      readonly identifier: string
      readonly typeId: string
    }
  | {
      readonly op: 'set'
      readonly file: string
      /** jsonc.FormatPath's dialect, the same one wire.GraphEdge.JSONPath uses. */
      readonly path: string
      readonly json: string
      readonly value: unknown
    }
  | {
      readonly op: 'delete'
      readonly file: string
      readonly path: string
    }

/** Something true about the plan that the author should read before applying it, but that is not
 * a reason to stop. Placeholder values for required keys land here, as does every semantic
 * detail the plan had to decide on the author's behalf. */
export interface PlanNote {
  readonly level: 'info' | 'warning'
  readonly message: string
}

export type IdiomAction = 'gate-scatter' | 'setup-scatter' | 'extract-feature' | 'wrap-node'

export interface EditPlan {
  readonly action: IdiomAction
  /** One line, imperative, suitable for an undo stack entry or a confirmation button. */
  readonly title: string
  /** A few sentences: what changes, and what it will do to the world. */
  readonly summary: string
  readonly operations: readonly PlanOperation[]
  /** Every file the plan touches, de-duplicated and sorted -- so a caller can open, lock or
   * diff them without walking the operations. */
  readonly files: readonly string[]
  /** Feature ids the plan brings into existence. */
  readonly creates: readonly string[]
  readonly notes: readonly PlanNote[]
}

export type RefusalCode =
  | 'unknown-node'
  | 'unresolved-node'
  | 'node-is-rule'
  | 'id-malformed'
  | 'id-exists'
  | 'file-exists'
  | 'no-format-version'
  | 'cycle'
  | 'path-shape'
  | 'molang-invalid'
  | 'molang-not-composable'
  | 'iterations-off'
  | 'empty-selection'
  | 'single-entry'
  | 'mixed-entry-parents'
  | 'duplicate-entry'
  | 'order-sensitive'
  | 'conditional-entry'
  | 'no-referrers'
  | 'unknown-wrapper'
  | 'wrapper-unavailable'
  /** A compound's parameters are not a shape it can read. Added after four compound
   * implementations independently reported that every other member of this union describes an
   * action over an EXISTING graph, leaving them to map "the author's own input is malformed"
   * onto whichever code was nearest and carry the real meaning in the reason string. */
  | 'params-malformed'

export interface Refusal {
  readonly code: RefusalCode
  /** A whole sentence, addressed to the author, naming what to do instead wherever there is
   * something to do. This is the entire user-visible product of a refusal, so it is never a
   * code name with the underscores taken out. */
  readonly reason: string
  /** The node ids the refusal is about, so a renderer can highlight them. */
  readonly nodes?: readonly string[]
}

export type IdiomResult = { readonly ok: true; readonly plan: EditPlan } | { readonly ok: false; readonly refusal: Refusal }

function refuse(code: RefusalCode, reason: string, nodes?: readonly string[]): IdiomResult {
  return { ok: false, refusal: nodes === undefined ? { code, reason } : { code, reason, nodes } }
}

// ---------------------------------------------------------------------------
// jsonc.FormatPath, ported
// ---------------------------------------------------------------------------

/** One step of a document path: an object member, or an array element. */
export type PathSegment = { readonly key: string } | { readonly index: number }

export function isIndexSegment(seg: PathSegment): seg is { readonly index: number } {
  return 'index' in seg
}

/** The characters jsonc's isBareByte refuses, i.e. the ones the textual path form uses as
 * delimiters. ':' is deliberately absent: Bedrock's keys are all "minecraft:foo" and quoting
 * every one of them would make every path in the editor unreadable. */
const PATH_DELIMITERS: ReadonlySet<string> = new Set(['.', '[', ']', '"', '\\', '\u007f'])

function isBareKey(key: string): boolean {
  if (key.length === 0) return false
  for (const ch of key) {
    if (PATH_DELIMITERS.has(ch)) return false
    // jsonc's `c > ' '` over bytes. Every byte of a non-ASCII UTF-8 rune is >= 0x80, so a
    // non-ASCII key stays bare there and must stay bare here too.
    if (ch <= ' ') return false
  }
  return true
}

/** jsonc.FormatPath, character for character. Ported rather than approximated because the
 * contract pins this dialect for a reason spelled out in wire/graph.go: an annotation reaches an
 * edge only by STRING EQUALITY against a path, and two spellings that both look right never
 * match. A plan whose paths are a dialect of their own would be executed against the wrong keys
 * or against none. */
export function formatJsonPath(segments: readonly PathSegment[]): string {
  let out = '$'
  for (const seg of segments) {
    if (isIndexSegment(seg)) {
      out += `[${seg.index}]`
    } else if (isBareKey(seg.key)) {
      out += `.${seg.key}`
    } else {
      out += `[${JSON.stringify(seg.key)}]`
    }
  }
  return out
}

/** jsonc.ParsePath, returning null instead of throwing. Every caller turns a null into a
 * `path-shape` refusal, because a path this module cannot read is a path it must not rewrite. */
export function parseJsonPath(path: string): PathSegment[] | null {
  if (path.length === 0 || path[0] !== '$') return null
  const segments: PathSegment[] = []
  let i = 1
  while (i < path.length) {
    const ch = path[i]
    if (ch === '.') {
      i++
      const start = i
      while (i < path.length && !PATH_DELIMITERS.has(path[i]!) && path[i]! > ' ') i++
      if (i === start) return null
      segments.push({ key: path.slice(start, i) })
      continue
    }
    if (ch !== '[') return null
    i++
    if (path[i] === '"') {
      let j = i + 1
      while (j < path.length && path[j] !== '"') {
        if (path[j] === '\\') j++
        j++
      }
      if (j >= path.length || path[j + 1] !== ']') return null
      let key: string
      try {
        key = JSON.parse(path.slice(i, j + 1)) as string
      } catch {
        return null
      }
      segments.push({ key })
      i = j + 2
      continue
    }
    const start = i
    while (i < path.length && path[i]! >= '0' && path[i]! <= '9') i++
    if (i === start || path[i] !== ']') return null
    segments.push({ index: Number(path.slice(start, i)) })
    i++
  }
  return segments
}

// ---------------------------------------------------------------------------
// Reading an edge's JSONPath without guessing
// ---------------------------------------------------------------------------

/** Where an edge's two interesting spans live inside the parent's file.
 *
 * `reference` is the span holding the "namespace:id" string -- set it to retarget a delegation.
 * `entry` is the span holding the whole LIST ENTRY the reference sits in, which for a bare
 * aggregate element is the same span, for a conditional entry is the surrounding object (with
 * its `condition`), and for a weighted entry is the surrounding [ref, weight] tuple. Deleting a
 * delegation means deleting the entry; deleting the reference alone would leave a conditional
 * entry with a condition and nothing to place. `entry` is null for the single-slot kinds, where
 * there is no list and nothing to delete. */
interface EdgeSpans {
  readonly reference: string | null
  readonly entry: string | null
}

/** Resolves an edge's spans from its jsonPath, CROSS-CHECKED against its ordinal.
 *
 * The contract pins the dialect but not the shape a given kind's path takes, and the shapes are
 * not all the same: a weighted_random entry is a [ref, weight] tuple in practice, so a
 * producer may reasonably report the tuple (`features[2]`) or the reference slot inside it
 * (`features[2][0]`), and an object-form entry gives a third (`features[2].feature`). Rather
 * than pick one and corrupt a file when a producer picked another, this reads the path and
 * checks the list index it finds against the edge's own `ordinal`. A path that does not line up
 * yields null, and every caller turns that into a refusal naming the edge. */
function edgeSpans(edge: IdiomGraphEdge): EdgeSpans | null {
  const segments = parseJsonPath(edge.jsonPath)
  if (segments === null || segments.length === 0) return null
  const last = segments[segments.length - 1]!
  const prev = segments.length >= 2 ? segments[segments.length - 2]! : null

  if (!LIST_KINDS.has(edge.kind)) {
    // rule / scatter / filter / child: a named single slot. The path names the reference and
    // there is no entry to remove.
    return { reference: edge.jsonPath, entry: null }
  }

  const ordinal = edge.ordinal
  const dropLast = (): string => formatJsonPath(segments.slice(0, -1))

  if (edge.kind === 'aggregate' || edge.kind === 'sequence') {
    // `features` is an array of bare reference strings, so the element IS the entry.
    if (!isIndexSegment(last)) return null
    if (ordinal !== undefined && last.index !== ordinal) return null
    return { reference: edge.jsonPath, entry: edge.jsonPath }
  }

  if (edge.kind === 'conditional') {
    // `conditional_features[i].places_feature` -- the contract's own worked example.
    if (isIndexSegment(last) || prev === null || !isIndexSegment(prev)) return null
    if (ordinal !== undefined && prev.index !== ordinal) return null
    return { reference: edge.jsonPath, entry: dropLast() }
  }

  // weighted: three legal shapes, told apart by what the path's tail looks like.
  if (!isIndexSegment(last)) {
    // Object form: `features[i].feature` / `features[i].places_feature`.
    if (prev === null || !isIndexSegment(prev)) return null
    if (ordinal !== undefined && prev.index !== ordinal) return null
    return { reference: edge.jsonPath, entry: dropLast() }
  }
  if (prev !== null && isIndexSegment(prev) && (ordinal === undefined || prev.index === ordinal)) {
    // Tuple slot: `features[i][0]`.
    return { reference: edge.jsonPath, entry: dropLast() }
  }
  if (ordinal === undefined || last.index === ordinal) {
    // The tuple itself: `features[i]`. There is no span that holds the reference on its own, so
    // a caller retargeting this edge has to rewrite the whole tuple.
    return { reference: null, entry: edge.jsonPath }
  }
  return null
}

/** The body of a node's file, as a path -- derived from an edge that leaves it rather than
 * rebuilt from the type id.
 *
 * Rebuilding would mean turning wire.GraphNode.TypeID back into the file's root key, and those
 * are NOT the same string for a rule (the contract gives a rule the synthetic
 * "minecraft:feature_rule", singular, precisely because it names one rule and not the file's
 * "minecraft:feature_rules" collection). Taking the prefix of a path the producer already emitted
 * sidesteps the whole question. */
function bodyPathFromEdge(edge: IdiomGraphEdge): string | null {
  const segments = parseJsonPath(edge.jsonPath)
  if (segments === null || segments.length < 2) return null
  const root = segments[0]!
  if (isIndexSegment(root)) return null
  return formatJsonPath([root])
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

function nodeById(graph: IdiomGraph, id: string): IdiomGraphNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}

/** Every node that lies on a delegation cycle.
 *
 * Tarjan, iteratively -- iteratively because the recursion depth would otherwise be the graph's
 * depth, and the contract is explicit that a consumer must not assume a tree. `graph.cycles` is
 * folded in at the end rather than trusted as the answer: the engine's list is authoritative when
 * present, but a caller may have built a Graph literal without one, and an action that refused
 * only when told about a cycle would happily extract a subtree out of a recursive pack. */
function nodesOnCycles(graph: IdiomGraph): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>()
  const found = new Set<string>()
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from)
    if (list === undefined) adjacency.set(edge.from, [edge.to])
    else list.push(edge.to)
    // A feature that delegates to itself is a cycle of one, and Tarjan's component-size test
    // does not see it.
    if (edge.from === edge.to) found.add(edge.from)
  }
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0
  for (const root of graph.nodes.map((n) => n.id)) {
    if (index.has(root)) continue
    index.set(root, counter)
    low.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const neighbours = adjacency.get(frame.v) ?? []
      if (frame.i < neighbours.length) {
        const w = neighbours[frame.i]!
        frame.i++
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter)
          counter++
          stack.push(w)
          onStack.add(w)
          work.push({ v: w, i: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!))
      if (low.get(frame.v) === index.get(frame.v)) {
        const component: string[] = []
        for (;;) {
          const w = stack.pop()!
          onStack.delete(w)
          component.push(w)
          if (w === frame.v) break
        }
        if (component.length > 1) for (const id of component) found.add(id)
      }
    }
  }
  for (const cycle of graph.cycles ?? []) for (const id of cycle) found.add(id)
  return found
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/** "namespace:identifier", checked only as far as this module can honestly check it: exactly one
 * colon, both halves non-empty, no whitespace. Nothing here invents a character class the game
 * enforces, because a validator that refuses an id the game accepts is a bug an author cannot
 * work around from inside the editor. */
export function malformedIdReason(id: string): string | null {
  if (id.length === 0) return 'a new feature needs an identifier.'
  const colon = id.indexOf(':')
  if (colon < 0) return `"${id}" has no namespace. Feature identifiers are "namespace:identifier", and a bare name resolves against nothing.`
  if (colon === 0 || colon === id.length - 1) return `"${id}" has an empty half; feature identifiers are "namespace:identifier".`
  if (id.indexOf(':', colon + 1) >= 0) return `"${id}" has more than one ":".`
  if (/\s/.test(id)) return `"${id}" contains whitespace.`
  return null
}

interface NewFeatureRequest {
  readonly newId: string
  readonly file: string
  readonly formatVersion?: string | undefined
  /** Files the pack already holds that are not features, and so are not in the graph. Optional
   * because the graph's own nodes cover every case this module can see by itself; supplying it
   * turns "I would have overwritten your README" from a silent data loss into a refusal. */
  readonly existingFiles?: readonly string[] | undefined
}

/** The checks every action that CREATES a feature shares: the id is well-formed, the id is free,
 * and the file is free. All three are cheap, and each one of them is a half-applied refactor if
 * it is skipped -- an id collision in particular, because two files declaring the same identifier
 * is a state the pack loader resolves by picking one, silently. */
function checkNewFeature(graph: IdiomGraph, req: NewFeatureRequest): Refusal | null {
  const malformed = malformedIdReason(req.newId)
  if (malformed !== null) return { code: 'id-malformed', reason: malformed }
  // Compared case-INSENSITIVELY, because the engine registers and resolves identifiers folded:
  // `example:Oak` and `example:oak` are one feature to a pack, the first file loaded wins, and
  // the other is quietly never placed. A case-sensitive check here let this module create
  // exactly that -- two files, one reachable, no error anywhere.
  const folded = req.newId.toLowerCase()
  const clash = graph.nodes.find((n) => n.id.toLowerCase() === folded)
  if (clash !== undefined) {
    return {
      code: 'id-exists',
      reason:
        `"${req.newId}" is already defined${clash.file !== undefined && clash.file !== '' ? ` by ${clash.file}` : ''}. ` +
        'Two files declaring one identifier is not an error the pack reports -- the loader keeps one of them -- so ' +
        'this would quietly replace a feature somewhere else in the pack.',
      nodes: [req.newId],
    }
  }
  if (req.file.length === 0) return { code: 'file-exists', reason: 'a new feature needs a file to be written to.' }
  const fileClash =
    graph.nodes.some((n) => n.file === req.file) || (req.existingFiles ?? []).includes(req.file)
  if (fileClash) {
    return { code: 'file-exists', reason: `${req.file} already exists. Creating a feature there would overwrite it.` }
  }
  return null
}

/** The format_version the new file declares. Inherited from the node the action is working on --
 * a pack authored against one band should not sprout a file from another because this module had
 * a favourite -- and refused outright when there is nothing to inherit, because guessing here
 * decides which keys the new file's type is even allowed to have. */
function resolveFormatVersion(requested: string | undefined, inheritFrom: IdiomGraphNode | undefined): string | Refusal {
  const explicit = requested ?? inheritFrom?.formatVersion
  if (explicit === undefined || explicit === '') {
    return {
      code: 'no-format-version',
      reason:
        `a new feature file must declare a format_version, and ${inheritFrom?.id ?? 'the selection'} does not report one ` +
        'to inherit. Pass one -- it decides which keys the new file\'s type accepts, so it is not a detail this can pick.',
    }
  }
  return explicit
}

function isRefusalValue(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && 'code' in v && 'reason' in v
}

/** Resolves a node id to a node this module may act on: present, resolved, and a FEATURE.
 * A feature rule is excluded on purpose -- nothing in the format can delegate to a rule, so
 * wrapping one or pulling one into an aggregate produces a reference that resolves to nothing. */
function resolveFeature(graph: IdiomGraph, id: string, what: string): IdiomGraphNode | Refusal {
  const node = nodeById(graph, id)
  if (node === undefined) return { code: 'unknown-node', reason: `${what} "${id}" is not in this graph.`, nodes: [id] }
  if (node.unresolved === true) {
    return {
      code: 'unresolved-node',
      reason: `"${id}" is a dangling reference -- something in the pack delegates to it and no file defines it. There is nothing here to act on.`,
      nodes: [id],
    }
  }
  if (node.typeId === RULE_TYPE_ID) {
    return {
      code: 'node-is-rule',
      reason: `"${id}" is a feature RULE, not a feature. Nothing can delegate to a rule, so it cannot be wrapped or gathered into another feature.`,
      nodes: [id],
    }
  }
  if (node.file === undefined || node.file === '') {
    return { code: 'unresolved-node', reason: `"${id}" does not report a file, so there is nothing to edit.`, nodes: [id] }
  }
  return node
}

// ---------------------------------------------------------------------------
// Writing files and values
// ---------------------------------------------------------------------------

function setOperation(file: string, path: string, value: unknown): PlanOperation {
  return { op: 'set', file, path, json: JSON.stringify(value), value }
}

/** A complete feature file. `description.identifier` comes first inside the body because that is
 * where every vanilla file and every fixture in this repo puts it, and a generated file that
 * reads unlike the hand-written ones beside it is a generated file people rewrite by hand. */
export function featureFileContents(typeId: string, identifier: string, formatVersion: string, body: Record<string, unknown>): string {
  const document = {
    format_version: formatVersion,
    [typeId]: { description: { identifier }, ...body },
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Required keys the catalogue knows about, seeded with forms.ts's own placeholders, minus
 * anything the caller is about to write itself. The placeholders are NOT plausible values -- 0
 * for a number, "" for a block -- and that is forms.ts's deliberate choice: the file is invalid
 * until the author fills them in, and a placeholder that looked finished would let a half-written
 * node read as done. So every one of them is reported as a note rather than passed over. */
function seedRequired(
  typeId: string,
  formatVersion: string,
  alreadyWritten: ReadonlySet<string>,
): { fields: Record<string, unknown>; placeholders: string[] } {
  const seeded = seedNewNodeFields(typeId, formatVersion)
  const fields: Record<string, unknown> = {}
  const placeholders: string[] = []
  for (const [key, value] of Object.entries(seeded)) {
    if (alreadyWritten.has(key)) continue
    fields[key] = value
    placeholders.push(key)
  }
  return { fields, placeholders }
}

function planFiles(operations: readonly PlanOperation[]): string[] {
  return [...new Set(operations.map((op) => op.file))].sort()
}

// ---------------------------------------------------------------------------
// The two Molang shapes
// ---------------------------------------------------------------------------

export const BARE_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** `iterations` as an IF: a test multiplied by a count.
 *
 * Zero iterations is how this format spells "do not place", and the engine diagnoses it
 * specifically -- distinct from a scatter_chance rejection, which is luck rather than
 * configuration. So `(test) * 4` places four where the test passes and nothing where it does
 * not, and the reason nothing was placed survives into the engine's own output. */
export function gateExpression(condition: string, count: number | string = 1): string {
  const test = condition.trim()
  const n = String(count).trim()
  return `(${test}) * ${BARE_NUMBER.test(n) ? n : `(${n})`}`
}

export interface VariableAssignment {
  /** Without the namespace -- "trunk_height", not "variable.trunk_height". */
  readonly name: string
  /** The right-hand side, as Molang. */
  readonly value: string
}

/** `iterations` as a SETUP STEP: assignments, then a `return`.
 *
 * The scatter's Molang scope is shared by reference with everything it delegates to, so a name
 * assigned here is readable by the placed feature -- that sharing is the whole idiom. The
 * trailing `return` is not decoration: a statement sequence with no `return` evaluates to 0, and
 * 0 iterations places nothing, so the obvious way to write this idiom by hand silently switches
 * the scatter off. Nothing in this module ever emits a sequence without one, and
 * composeSetupIterations re-checks the result anyway. */
export function setupExpression(assignments: readonly VariableAssignment[], count: number | string = 1): string {
  const statements = assignments.map((a) => `variable.${a.name} = ${a.value.trim()};`)
  return `${statements.join(' ')}${statements.length > 0 ? ' ' : ''}return ${String(count).trim()};`
}

/** Puts `assignments` in front of an `iterations` expression that already exists, preserving
 * whatever it currently counts.
 *
 * Three shapes go in. A plain expression becomes the `return` value, so the count is unchanged.
 * A sequence that already ends in a `return` is appended to the assignments as-is. A sequence
 * WITHOUT a return is refused by the caller before it gets here -- see setupScatter. */
function composeSetupIterations(assignments: readonly VariableAssignment[], existing: string): string {
  const statements = assignments.map((a) => `variable.${a.name} = ${a.value.trim()};`).join(' ')
  const body = existing.trim()
  if (isStatementSequence(body)) return statements.length > 0 ? `${statements} ${body}` : body
  return statements.length > 0 ? `${statements} return ${body};` : `return ${body};`
}

/** Runs the composed expression back through molangHints' own checks and turns the result into
 * either a refusal or a list of notes.
 *
 * Errors refuse. An unreachable `query.*` name in particular is not a style opinion: the real
 * game rejects an unknown query while TOKENIZING, so the file does not load at all, and this
 * tool substitutes 0 and carries on -- which means a plan that wrote one would produce a pack
 * that works here and is broken in the game, the worst failure this editor can produce. */
function checkIterations(expression: string): { notes: PlanNote[] } | Refusal {
  const analysis = analyseIterations(expression)
  if (analysis.sequenceWithoutReturn) {
    return {
      code: 'iterations-off',
      reason:
        `the composed iterations "${expression}" is a statement sequence with no \`return\`, and a sequence without one ` +
        'evaluates to 0 -- the scatter would place nothing. Give it a `return <count>;`.',
    }
  }
  const problems = localProblems(expression, 'iterations')
  const error = problems.find((p) => p.severity === 'error')
  if (error !== undefined) {
    return { code: 'molang-invalid', reason: `the composed iterations is not loadable: ${error.message}` }
  }
  return {
    notes: problems
      .filter((p) => p.severity !== 'error')
      .map((p): PlanNote => ({ level: 'warning', message: p.message })),
  }
}

/** Where a scatter's `iterations` lives in its file, which the format_version decides.
 *
 * Below 1.21.10 the scatter's parameters are flat keys on the feature body; at and above it they
 * are members of a nested `distribution` object, and the two are mutually exclusive. Writing the
 * wrong one does not raise an error the author can see: the engine logs the unknown member,
 * drops it, and then fails on the missing required `iterations`. An unversioned file is read the
 * modern way, matching typeCatalog.ts's atLeastOrUnversioned and the argument it makes there. */
function iterationsPath(bodyPath: string, version: FormatVersion): string {
  const segments = parseJsonPath(bodyPath) ?? []
  return atLeastOrUnversioned(version, SCATTER_DISTRIBUTION_SINCE)
    ? formatJsonPath([...segments, { key: 'distribution' }, { key: 'iterations' }])
    : formatJsonPath([...segments, { key: 'iterations' }])
}

/** A scatter's distribution parameters, from whichever of the two spellings this file's version
 * uses. Read-only, and only to describe what an edit is landing next to. */
function scatterParameters(node: IdiomGraphNode, version: FormatVersion): Record<string, unknown> {
  const body = node.fields ?? {}
  if (!atLeastOrUnversioned(version, SCATTER_DISTRIBUTION_SINCE)) return body as Record<string, unknown>
  const nested = body['distribution']
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {}
}

/** Warns when this scatter carries a PER-ITERATION script, which sits somewhere an author editing
 * `iterations` would not look.
 *
 * A coordinate is a Molang expression too, and generated packs use the FIRST axis named by
 * `coordinate_eval_order` as a per-iteration script -- `"<statements> return <coord>;"` -- because
 * that axis is the first thing evaluated inside the loop. An edit to `iterations` is not an edit
 * to that script, but the two run in the same shared scope and one line apart in reading order,
 * so a plan that changed the count without mentioning the script would leave the author to
 * discover it. Worth a sentence; not worth refusing over, because nothing here moves it. */
function perIterationScriptNote(node: IdiomGraphNode, version: FormatVersion): PlanNote | null {
  const params = scatterParameters(node, version)
  const order = params['coordinate_eval_order']
  // The default is "xzy" -- x first -- which is exactly the case a file that wrote no order is in.
  const first = (typeof order === 'string' && order.length > 0 ? order[0] : 'x') as string
  const axis = params[first]
  if (typeof axis !== 'string' || !isStatementSequence(axis)) return null
  return {
    level: 'warning',
    message:
      `${node.id}'s "${first}" axis holds a statement sequence ("${axis}"), and coordinate_eval_order evaluates "${first}" first -- ` +
      'so that expression is this scatter\'s per-iteration script, running once per iteration in the same shared scope. This edit ' +
      'does not touch it, but changing coordinate_eval_order later would stop it running first.',
  }
}

/** The scatter body a wrapper gets: the feature it places, the iterations expression, and three
 * ZERO-width axes.
 *
 * The axes are the part that is easy to leave out and expensive to leave out. A scatter does not
 * only count, it also OFFSETS -- and an absent axis defaults to a zero-width axis at the origin
 * anyway, so writing 0 changes nothing about the placement and everything about what the file
 * says. A wrapper introduced to express "only when" must not also move the thing it wraps, and an
 * author reading `x: 0, y: 0, z: 0` can see that it does not. */
export function scatterWrapperBody(target: string, expression: string, version: FormatVersion): Record<string, unknown> {
  const axes = { x: 0, y: 0, z: 0 }
  return atLeastOrUnversioned(version, SCATTER_DISTRIBUTION_SINCE)
    ? { places_feature: target, distribution: { iterations: expression, ...axes } }
    : { places_feature: target, iterations: expression, ...axes }
}

/** Every edge that points AT `id`, in graph order. Order is the contract's, so a plan built from
 * it is byte-identical run to run. */
function referrers(graph: IdiomGraph, id: string): IdiomGraphEdge[] {
  return graph.edges.filter((e) => e.to === id)
}

/** Retargets one delegation at `newId`, choosing between rewriting the reference and rewriting
 * the whole entry. The second case exists only for a weighted_random entry whose producer
 * reported the [ref, weight] tuple rather than the slot inside it: writing a bare string there
 * would delete the weight, which the engine then defaults to 1.0 and nothing says so. */
function retargetOperation(graph: IdiomGraph, edge: IdiomGraphEdge, newId: string): PlanOperation | Refusal {
  const from = nodeById(graph, edge.from)
  const file = from?.file
  if (file === undefined || file === '') {
    return { code: 'unresolved-node', reason: `"${edge.from}" references this feature and does not report a file, so the reference cannot be rewritten.`, nodes: [edge.from] }
  }
  const spans = edgeSpans(edge)
  if (spans === null) {
    return {
      code: 'path-shape',
      reason:
        `the ${edge.kind} edge ${edge.from} -> ${edge.to} reports the path "${edge.jsonPath}", which does not have the shape ` +
        'that kind requires (its list index does not match the edge\'s ordinal). Rewriting it would edit the wrong entry, so nothing is planned.',
      nodes: [edge.from, edge.to],
    }
  }
  if (spans.reference !== null) return setOperation(file, spans.reference, newId)
  // The tuple case. The weight is carried across exactly as written; an absent one stays absent
  // in meaning by being written as the engine's own 1.0 default, which is noted by the caller.
  return setOperation(file, spans.entry!, [newId, edge.weight ?? 1])
}

// ---------------------------------------------------------------------------
// Action 1 -- scatter as an if-statement
// ---------------------------------------------------------------------------

export interface GateScatterRequest {
  /** The feature whose placement is being made conditional. */
  readonly target: string
  /** The Molang test. Written as the author typed it; this module parenthesises it, never
   * rewrites it. */
  readonly condition: string
  /** Iterations when the test passes. */
  readonly count?: number | string | undefined
  /** Only consulted when `target` is not already a scatter and one has to be created. */
  readonly newId?: string | undefined
  readonly file?: string | undefined
  readonly formatVersion?: string | undefined
  readonly existingFiles?: readonly string[] | undefined
}

/** "Place this only when ...".
 *
 * Two paths, because the answer to "where does the condition go" depends on what the author
 * selected. A scatter_feature already has the field this idiom is written in, so the condition
 * multiplies its existing `iterations` in place -- one file changes, and the scatter keeps
 * counting whatever it counted where the test passes. Anything else has no such field, so a
 * scatter is created above it and every reference to the original is retargeted at the wrapper.
 *
 * The in-place path is the one that needs care. `(test) * <existing>` is only meaningful when
 * `<existing>` is an expression; multiplying a statement sequence is not a thing Molang does, so
 * a scatter whose iterations is already a setup script is refused with the composition spelled
 * out rather than mangled. */
export function gateScatter(graph: IdiomGraph, request: GateScatterRequest): IdiomResult {
  if (request.condition.trim().length === 0) {
    return refuse('molang-invalid', 'a gate needs a condition; an empty expression is not a test.')
  }
  const target = resolveFeature(graph, request.target, 'the feature to gate')
  if (isRefusalValue(target)) return { ok: false, refusal: target }

  if (target.typeId === SCATTER_TYPE_ID) return gateScatterInPlace(graph, request, target)
  return gateScatterByWrapping(graph, request, target)
}

function gateScatterInPlace(graph: IdiomGraph, request: GateScatterRequest, target: IdiomGraphNode): IdiomResult {
  const scatterEdge = graph.edges.find((e) => e.from === target.id && e.kind === 'scatter')
  const existing = scatterEdge?.iterations ?? undefined
  const version = readFormatVersion(target)

  if (existing !== undefined && existing !== null && isStatementSequence(existing)) {
    return refuse(
      'molang-not-composable',
      `${target.id}'s iterations is a statement sequence ("${existing}"), and a gate multiplies an expression by a count -- ` +
        'there is no correct way to multiply a sequence. Fold the test into the sequence\'s own `return` instead, or gate the ' +
        'feature this scatter places rather than the scatter.',
      [target.id],
    )
  }

  const count = existing !== undefined && existing !== null && existing.trim().length > 0 ? existing : (request.count ?? 1)
  const expression = gateExpression(request.condition, count)
  const checked = checkIterations(expression)
  if (isRefusalValue(checked)) return { ok: false, refusal: checked }

  const bodyPath = scatterEdge !== undefined ? bodyPathFromEdge(scatterEdge) : null
  if (bodyPath === null) {
    return refuse(
      'path-shape',
      `${target.id} is a scatter_feature and this graph reports no usable path into its body, so there is nowhere to write ` +
        'the iterations. (A scatter always delegates; an edge leaving it is what names its file\'s root key.)',
      [target.id],
    )
  }
  const path = iterationsPath(bodyPath, version)
  const operations = [setOperation(target.file!, path, expression)]
  const notes: PlanNote[] = [...checked.notes]
  const perIteration = perIterationScriptNote(target, version)
  if (perIteration !== null) notes.push(perIteration)
  if (existing !== undefined && existing !== null && existing.trim().length > 0) {
    notes.push({
      level: 'info',
      message: `The existing count (${existing.trim()}) is kept and multiplied by the test, so where the test passes nothing about this scatter changes.`,
    })
  }
  return {
    ok: true,
    plan: {
      action: 'gate-scatter',
      title: `Gate ${target.id} on a condition`,
      summary:
        `${target.id}'s iterations becomes ${expression}. Where the test is false the scatter iterates zero times and places ` +
        'nothing -- which the engine reports as a zero-iterations outcome, distinct from a scatter_chance rejection, so the ' +
        'reason survives into its diagnostics.',
      operations,
      files: planFiles(operations),
      creates: [],
      notes,
    },
  }
}

function gateScatterByWrapping(graph: IdiomGraph, request: GateScatterRequest, target: IdiomGraphNode): IdiomResult {
  if (request.newId === undefined || request.file === undefined) {
    return refuse(
      'id-malformed',
      `${target.id} is a ${target.typeId ?? 'feature'}, not a scatter_feature, so the condition has nowhere to live in its own ` +
        'file. Gating it means creating a scatter above it, which needs an identifier and a file.',
      [target.id],
    )
  }
  const inbound = referrers(graph, target.id)
  if (inbound.length === 0) {
    return refuse(
      'no-referrers',
      `nothing in this pack delegates to ${target.id}, so a scatter wrapped around it would be unreachable -- the gate would ` +
        'exist and never run. Point a feature rule at the wrapper first, or gate a feature something already places.',
      [target.id],
    )
  }
  const onCycle = nodesOnCycles(graph)
  if (onCycle.has(target.id)) {
    return refuse(
      'cycle',
      `${target.id} lies on a delegation cycle. Retargeting every reference to it would move the cycle onto the new wrapper, ` +
        'and the recursion the engine guards would then run through a scatter that was not there when the pack was written.',
      [target.id],
    )
  }
  const created = checkNewFeature(graph, { newId: request.newId, file: request.file, existingFiles: request.existingFiles })
  if (created !== null) return { ok: false, refusal: created }
  const formatVersion = resolveFormatVersion(request.formatVersion, target)
  if (isRefusalValue(formatVersion)) return { ok: false, refusal: formatVersion }

  const version = parseFormatVersionSafely(formatVersion)
  const expression = gateExpression(request.condition, request.count ?? 1)
  const checked = checkIterations(expression)
  if (isRefusalValue(checked)) return { ok: false, refusal: checked }

  const operations: PlanOperation[] = [
    {
      op: 'createFile',
      file: request.file,
      identifier: request.newId,
      typeId: SCATTER_TYPE_ID,
      contents: featureFileContents(SCATTER_TYPE_ID, request.newId, formatVersion, scatterWrapperBody(target.id, expression, version)),
    },
  ]
  const notes: PlanNote[] = [
    ...checked.notes,
    {
      level: 'info',
      message:
        'The wrapper\'s x/y/z axes are written as 0. A scatter offsets as well as counts, and an absent axis already defaults to ' +
        'a zero-width axis at the origin -- writing them makes it visible that this wrapper only gates and never moves what it places.',
    },
  ]
  const retargeted = appendRetargets(graph, operations, inbound, request.newId, notes)
  if (retargeted !== null) return { ok: false, refusal: retargeted }

  return {
    ok: true,
    plan: {
      action: 'gate-scatter',
      title: `Place ${target.id} only when a condition holds`,
      summary:
        `A new scatter_feature ${request.newId} places ${target.id} with iterations ${expression}, and the ${inbound.length} ` +
        `reference${inbound.length === 1 ? '' : 's'} to ${target.id} now point at it. Where the test is false it iterates zero ` +
        'times and places nothing.',
      operations,
      files: planFiles(operations),
      creates: [request.newId],
      notes,
    },
  }
}

// ---------------------------------------------------------------------------
// Action 2 -- scatter as a setup step
// ---------------------------------------------------------------------------

export interface SetupScatterRequest {
  readonly target: string
  /** The `variable.*` names to assign, in order. These are what the placed feature will read. */
  readonly assignments: readonly VariableAssignment[]
  /** The iterations to return. Ignored on the in-place path, where the scatter's existing count
   * is preserved as the `return` value instead. */
  readonly count?: number | string | undefined
  readonly newId?: string | undefined
  readonly file?: string | undefined
  readonly formatVersion?: string | undefined
  readonly existingFiles?: readonly string[] | undefined
}

/** "Set up values the placed feature reads".
 *
 * A scatter's `iterations` is evaluated against a Molang scope SHARED with everything the scatter
 * delegates to, so `variable.trunk_height = 4 + math.random_integer(0, 3)` written here is a value
 * the placed feature can read. That is the mechanism; the trap is the syntax. Writing more than
 * one statement makes the expression a SEQUENCE, and a sequence with no `return` evaluates to 0 --
 * which is zero iterations, which is a scatter that places nothing. An author who adds a setup
 * line to a working scatter and watches it stop placing has no way to see why from inside the
 * file.
 *
 * So: every expression this produces ends in a `return`, the existing count becomes that return
 * value rather than being replaced by a 1, and the result is fed back through molangHints'
 * analyser before the plan is returned. */
export function setupScatter(graph: IdiomGraph, request: SetupScatterRequest): IdiomResult {
  if (request.assignments.length === 0) {
    return refuse('molang-invalid', 'a setup step needs at least one variable to assign.')
  }
  const badName = request.assignments.find((a) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.name))
  if (badName !== undefined) {
    return refuse('molang-invalid', `"${badName.name}" is not a Molang identifier, so \`variable.${badName.name}\` would not parse.`)
  }
  const emptyValue = request.assignments.find((a) => a.value.trim().length === 0)
  if (emptyValue !== undefined) {
    return refuse('molang-invalid', `variable.${emptyValue.name} has no value to assign.`)
  }
  const target = resolveFeature(graph, request.target, 'the feature to set up')
  if (isRefusalValue(target)) return { ok: false, refusal: target }

  // Assigning over a name the engine publishes is legal and almost never meant: the engine writes
  // originx/y/z immediately before this expression runs and worldx/y/z per axis per iteration
  // inside the loop, so an assignment either fights the engine or is overwritten by it.
  const notes: PlanNote[] = []
  for (const assignment of request.assignments) {
    if (PUBLISHED_VARIABLES.some((v) => v.name === assignment.name)) {
      notes.push({
        level: 'warning',
        message:
          `variable.${assignment.name} is a name the engine publishes itself. Assigning it here does not rename anything -- the ` +
          'engine writes its own value around this expression, so a reader downstream may see either.',
      })
    }
  }

  if (target.typeId === SCATTER_TYPE_ID) return setupScatterInPlace(graph, request, target, notes)
  return setupScatterByWrapping(graph, request, target, notes)
}

function setupScatterInPlace(
  graph: IdiomGraph,
  request: SetupScatterRequest,
  target: IdiomGraphNode,
  notes: PlanNote[],
): IdiomResult {
  const scatterEdge = graph.edges.find((e) => e.from === target.id && e.kind === 'scatter')
  const existingRaw = scatterEdge?.iterations ?? null
  const existing = existingRaw !== null && existingRaw.trim().length > 0 ? existingRaw.trim() : String(request.count ?? 1)

  // The one composition that cannot be made safe. A sequence with no `return` already evaluates
  // to 0, so this scatter places nothing TODAY; putting assignments in front of it leaves it
  // placing nothing, and the author would read the successful refactor as the cause.
  const currentAnalysis = analyseIterations(existing)
  if (currentAnalysis.sequenceWithoutReturn) {
    return refuse(
      'iterations-off',
      `${target.id}'s iterations ("${existing}") is a statement sequence with no \`return\`, so it already evaluates to 0 and the ` +
        'scatter places nothing. Adding assignments in front of it would not change that. Give it a `return <count>;` first.',
      [target.id],
    )
  }

  const expression = composeSetupIterations(request.assignments, existing)
  const checked = checkIterations(expression)
  if (isRefusalValue(checked)) return { ok: false, refusal: checked }

  const bodyPath = scatterEdge !== undefined ? bodyPathFromEdge(scatterEdge) : null
  if (bodyPath === null) {
    return refuse(
      'path-shape',
      `${target.id} is a scatter_feature and this graph reports no usable path into its body, so there is nowhere to write the iterations.`,
      [target.id],
    )
  }
  const version = readFormatVersion(target)
  const path = iterationsPath(bodyPath, version)
  const operations = [setOperation(target.file!, path, expression)]
  const perIteration = perIterationScriptNote(target, version)
  if (perIteration !== null) notes.push(perIteration)
  const placed = scatterEdge?.to
  return {
    ok: true,
    plan: {
      action: 'setup-scatter',
      title: `Set up ${request.assignments.length} variable${request.assignments.length === 1 ? '' : 's'} on ${target.id}`,
      summary:
        `${target.id}'s iterations becomes ${expression}. The assignments run before the scatter loops, in a Molang scope shared by ` +
        `reference with ${placed !== undefined ? placed : 'everything it places'}, so they are readable there. The existing count is ` +
        'preserved as the `return` value -- a sequence without one would evaluate to 0 and switch the scatter off.',
      operations,
      files: planFiles(operations),
      creates: [],
      notes: [...notes, ...checked.notes],
    },
  }
}

function setupScatterByWrapping(
  graph: IdiomGraph,
  request: SetupScatterRequest,
  target: IdiomGraphNode,
  notes: PlanNote[],
): IdiomResult {
  if (request.newId === undefined || request.file === undefined) {
    return refuse(
      'id-malformed',
      `${target.id} is a ${target.typeId ?? 'feature'}, not a scatter_feature, and only a scatter shares its Molang scope with what ` +
        'it places. Setting variables up for it means creating a scatter above it, which needs an identifier and a file.',
      [target.id],
    )
  }
  const inbound = referrers(graph, target.id)
  if (inbound.length === 0) {
    return refuse(
      'no-referrers',
      `nothing in this pack delegates to ${target.id}, so a scatter wrapped around it would never run and the variables would never be set.`,
      [target.id],
    )
  }
  const onCycle = nodesOnCycles(graph)
  if (onCycle.has(target.id)) {
    return refuse(
      'cycle',
      `${target.id} lies on a delegation cycle, so retargeting every reference to it would move the cycle onto the new wrapper.`,
      [target.id],
    )
  }
  const created = checkNewFeature(graph, { newId: request.newId, file: request.file, existingFiles: request.existingFiles })
  if (created !== null) return { ok: false, refusal: created }
  const formatVersion = resolveFormatVersion(request.formatVersion, target)
  if (isRefusalValue(formatVersion)) return { ok: false, refusal: formatVersion }

  const version = parseFormatVersionSafely(formatVersion)
  const expression = setupExpression(request.assignments, request.count ?? 1)
  const checked = checkIterations(expression)
  if (isRefusalValue(checked)) return { ok: false, refusal: checked }

  const operations: PlanOperation[] = [
    {
      op: 'createFile',
      file: request.file,
      identifier: request.newId,
      typeId: SCATTER_TYPE_ID,
      contents: featureFileContents(SCATTER_TYPE_ID, request.newId, formatVersion, scatterWrapperBody(target.id, expression, version)),
    },
  ]
  const allNotes: PlanNote[] = [
    ...notes,
    ...checked.notes,
    {
      level: 'info',
      message:
        'The wrapper\'s x/y/z axes are written as 0, so it sets variables and places once at the origin rather than scattering ' +
        `${target.id} around it.`,
    },
  ]
  const retargeted = appendRetargets(graph, operations, inbound, request.newId, allNotes)
  if (retargeted !== null) return { ok: false, refusal: retargeted }

  return {
    ok: true,
    plan: {
      action: 'setup-scatter',
      title: `Set up variables for ${target.id}`,
      summary:
        `A new scatter_feature ${request.newId} places ${target.id} with iterations ${expression}, and the ${inbound.length} ` +
        `reference${inbound.length === 1 ? '' : 's'} to ${target.id} now point at it. The assignments land in a Molang scope shared ` +
        `by reference with ${target.id}, so it can read them.`,
      operations,
      files: planFiles(operations),
      creates: [request.newId],
      notes: allNotes,
    },
  }
}

/** Retargets a whole set of inbound edges at `newId`, appending the operations in place. Returns
 * a Refusal on the first edge whose path cannot be read, so a plan is never half-built: the
 * caller has nothing to unwind because nothing was returned. */
function appendRetargets(
  graph: IdiomGraph,
  operations: PlanOperation[],
  edges: readonly IdiomGraphEdge[],
  newId: string,
  notes: PlanNote[],
): Refusal | null {
  for (const edge of edges) {
    const op = retargetOperation(graph, edge, newId)
    if (isRefusalValue(op)) return op
    if (edge.kind === 'weighted' && op.op === 'set' && Array.isArray(op.value) && (edge.weight === undefined || edge.weight === null)) {
      notes.push({
        level: 'warning',
        message:
          `${edge.from} holds this delegation as a [feature, weight] tuple and wrote no weight, so the rewritten entry writes the ` +
          'engine\'s own 1.0 default explicitly. The pick is unchanged; the file now says so.',
      })
    }
    operations.push(op)
  }
  return null
}

// ---------------------------------------------------------------------------
// Action 3 -- extract a subtree into its own feature
// ---------------------------------------------------------------------------

export interface ExtractFeatureRequest {
  /** The nodes the author selected. Interior nodes are welcome and are not listed in the new
   * feature -- they are already reached through the entries. */
  readonly selection: readonly string[]
  readonly newId: string
  readonly file: string
  /** Overrides the type the new feature is given. By default it MIRRORS the parent list's own
   * type, which is the only choice that preserves what the entries did. */
  readonly typeId?: string | undefined
  readonly formatVersion?: string | undefined
  readonly existingFiles?: readonly string[] | undefined
}

/** Pulls a run of sibling delegations out into a feature of their own and rewrites the parent to
 * reference it once.
 *
 * WHAT "extract" MEANS HERE, because the word could mean two things and only one of them is
 * useful. Every node in this graph is already a feature with its own identifier and its own file,
 * so extracting ONE node would produce nothing but an alias -- the name already exists and every
 * reference already points at it. What is genuinely laborious by hand, and what real packs are
 * full of, is the other one: an aggregate or a conditional_list with nine entries, four of which
 * belong together and want a name. Doing that by hand means creating a file, moving four
 * references into it, deleting four entries from the parent, and getting the remaining indices
 * right. This does it as one plan, or refuses.
 *
 * The refusals are all about ORDER AND IDENTITY, because those are what a careless version of
 * this gets wrong silently:
 *
 *   - a cycle through the selection, because the region has no outside and no entry;
 *   - entries belonging to more than one parent, because the new feature would then place all of
 *     them for each parent, which is not what any of those parents did;
 *   - non-adjacent entries of a sequence_feature, because the order children run in IS the RNG
 *     contract (wire/graph.go says so about EdgeKind itself) and collapsing across a gap moves a
 *     sibling past them;
 *   - an early-out scheme on the parent, for the same reason one step further out: under
 *     first_success the parent stops at the first entry that places, so folding several entries
 *     into one changes when it stops;
 *   - conditional entries whose conditions differ, because one collapsed entry can carry one
 *     condition and the others would be dropped.
 */
export function extractFeature(graph: IdiomGraph, request: ExtractFeatureRequest): IdiomResult {
  if (request.selection.length === 0) return refuse('empty-selection', 'nothing is selected.')

  const selected = new Set(request.selection)
  for (const id of request.selection) {
    const node = resolveFeature(graph, id, 'the selected feature')
    if (isRefusalValue(node)) return { ok: false, refusal: node }
  }

  const onCycle = nodesOnCycles(graph)
  const cyclic = request.selection.filter((id) => onCycle.has(id))
  if (cyclic.length > 0) {
    return refuse(
      'cycle',
      `${cyclic.join(', ')} lie${cyclic.length === 1 ? 's' : ''} on a delegation cycle. A region a cycle runs through has no single ` +
        'way in, so there is no reference set that can be rewritten to point at a new feature without changing which delegations ' +
        'close the loop.',
      cyclic,
    )
  }

  // Boundary edges: delegations from OUTSIDE the selection into it. Their targets are the entries
  // -- the names the rest of the pack knows this region by, and therefore the names the new
  // feature has to stand in for.
  const boundary = graph.edges.filter((e) => !selected.has(e.from) && selected.has(e.to))
  const entryIds: string[] = []
  for (const edge of boundary) if (!entryIds.includes(edge.to)) entryIds.push(edge.to)
  // A selected node nothing outside points at is either an interior node -- already reached
  // through an entry, and so not a way in -- or a root, which IS a way in even though no edge
  // arrives at it. Walked in graph.nodes order, which the contract guarantees is deterministic,
  // so the same selection produces the same entry list and therefore the same plan every time.
  const covered = new Set(reachable(graph, entryIds, selected))
  for (const node of graph.nodes) {
    if (!selected.has(node.id) || entryIds.includes(node.id) || covered.has(node.id)) continue
    entryIds.push(node.id)
    for (const id of reachable(graph, [node.id], selected)) covered.add(id)
  }

  if (entryIds.length < 2) {
    const only = entryIds[0] ?? request.selection[0]!
    return refuse(
      'single-entry',
      `this selection has one way in (${only}), and ${only} is already a feature with its own identifier -- every reference to this ` +
        'region already points at it. Extracting would only insert a hop. Rename it instead, or select the siblings you want to ' +
        'group with it.',
      [only],
    )
  }

  // Every entry must be held by the SAME parent, or by no parent at all. Two parents each holding
  // a different entry cannot both be rewritten to one reference: the new feature places all its
  // children, so each parent would start placing the other's.
  const parents = new Set(boundary.map((e) => e.from))
  if (parents.size > 1) {
    return refuse(
      'mixed-entry-parents',
      `these features are referenced from ${parents.size} different places (${[...parents].sort().join(', ')}). Gathering them into ` +
        'one feature and pointing every one of those at it would make each of them place all of the others as well. Select entries ' +
        'that share a parent.',
      [...parents].sort(),
    )
  }

  if (boundary.length === 0) return extractRoots(graph, request, entryIds)
  return extractSiblings(graph, request, entryIds, boundary)
}

/** The selection is a set of roots nothing delegates to. Gathering them is still useful -- it is
 * how a pack gets a "everything this biome adds" feature -- but there is nothing to rewrite, so
 * the plan says out loud that the new feature is not reachable yet. */
function extractRoots(graph: IdiomGraph, request: ExtractFeatureRequest, entryIds: readonly string[]): IdiomResult {
  const typeId = request.typeId ?? 'minecraft:aggregate_feature'
  const built = buildExtractedFeature(graph, request, typeId, entryIds.map((id) => ({ id, weight: null, condition: null })))
  if (isRefusalValue(built)) return { ok: false, refusal: built }
  return {
    ok: true,
    plan: {
      action: 'extract-feature',
      title: `Gather ${entryIds.length} features into ${request.newId}`,
      summary:
        `${request.newId} is a new ${typeId} placing ${entryIds.join(', ')}. Nothing referenced these before, so nothing is ` +
        'rewritten and nothing references the new feature yet either -- point a feature rule at it.',
      operations: built.operations,
      files: planFiles(built.operations),
      creates: [request.newId],
      notes: [
        ...built.notes,
        { level: 'warning', message: `${request.newId} is not reachable until something delegates to it.` },
      ],
    },
  }
}

function extractSiblings(
  graph: IdiomGraph,
  request: ExtractFeatureRequest,
  entryIds: readonly string[],
  boundary: readonly IdiomGraphEdge[],
): IdiomResult {
  const parentId = boundary[0]!.from
  const parent = nodeById(graph, parentId)
  if (parent === undefined || parent.file === undefined || parent.file === '') {
    return refuse('unresolved-node', `"${parentId}" holds these references and does not report a file, so they cannot be rewritten.`, [parentId])
  }
  const parentFile = parent.file
  if (boundary.length !== entryIds.length) {
    return refuse(
      'duplicate-entry',
      `${parentId} references one of these features more than once. Collapsing the group would keep a single reference and silently ` +
        'drop the repeat -- which for an ordered list is a change to what gets placed. Remove the duplicate first, or select around it.',
      [parentId],
    )
  }

  const kinds = new Set(boundary.map((e) => e.kind))
  if (kinds.size > 1) {
    return refuse(
      'mixed-entry-parents',
      `${parentId} holds these delegations through different slots (${[...kinds].sort().join(', ')}). Only entries of one list can be ` +
        'collapsed into one reference.',
      [parentId],
    )
  }
  const kind = boundary[0]!.kind
  if (!LIST_KINDS.has(kind)) {
    return refuse(
      'single-entry',
      `${parentId} holds this delegation in a single-feature slot, not a list, so there is nothing to collapse.`,
      [parentId],
    )
  }

  const ordered = [...boundary].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
  // Narrower than EdgeSpans: a collapsible entry is one whose own span is known, and the loop
  // below refuses anything else, so the rest of this function never has to re-check for null.
  const spans: { reference: string | null; entry: string }[] = []
  for (const edge of ordered) {
    const span = edgeSpans(edge)
    // Collapsing entries means deleting by index, and an index this module cannot verify against
    // the edge's own ordinal is one it must not delete -- the wrong sibling would go.
    if (span === null || span.entry === null) {
      return refuse(
        'path-shape',
        `the ${edge.kind} edge ${edge.from} -> ${edge.to} reports the path "${edge.jsonPath}", which does not resolve to a list entry ` +
          'whose index matches the edge\'s ordinal. Nothing is planned rather than the wrong entry deleted.',
        [parentId],
      )
    }
    spans.push({ reference: span.reference, entry: span.entry })
  }

  // Order. A sequence's list order IS execution order and therefore part of the RNG contract, and
  // an aggregate with an early_out scheme observes order too. Collapsing entries that are not
  // adjacent moves the entries in between across them.
  const ordinals = ordered.map((e) => e.ordinal ?? -1)
  const contiguous = ordinals.every((o, i) => i === 0 || o === ordinals[i - 1]! + 1) && !ordinals.includes(-1)
  const orderMatters =
    kind === 'sequence' ||
    (kind === 'aggregate' && typeof parent.fields?.['early_out'] === 'string' && parent.fields['early_out'] !== 'none')
  if (orderMatters && !contiguous) {
    return refuse(
      'order-sensitive',
      `these are entries ${ordinals.join(', ')} of ${parentId}, and they are not adjacent. ${
        kind === 'sequence'
          ? 'A sequence_feature runs its children in list order and that order is part of the RNG contract'
          : `This aggregate_feature declares early_out "${String(parent.fields?.['early_out'])}", so it stops at a particular child`
      }, so folding them into one entry would move the features in between. Select an adjacent run.`,
      [parentId],
    )
  }
  if (kind === 'conditional' && typeof parent.fields?.['early_out_scheme'] === 'string' && parent.fields['early_out_scheme'] !== 'none') {
    return refuse(
      'order-sensitive',
      `${parentId} declares early_out_scheme "${String(parent.fields['early_out_scheme'])}", so it stops walking its entries at the ` +
        'first one that succeeds. Folding several entries into one changes where it stops. Set the scheme to "none" first, or extract ' +
        'a different group.',
      [parentId],
    )
  }

  // Conditions. One collapsed entry carries one condition; differing ones would be thrown away.
  let sharedCondition: string | null | undefined
  if (kind === 'conditional') {
    const conditions = ordered.map((e) => e.condition ?? null)
    const first = conditions[0] ?? null
    if (!conditions.every((c) => c === first)) {
      return refuse(
        'conditional-entry',
        `these entries of ${parentId} do not all carry the same condition (${conditions.map((c) => (c === null ? '(always)' : c)).join(' / ')}). ` +
          'A collapsed entry can carry one condition and the rest would be lost. Extract entries that share a condition, or clear them first.',
        [parentId],
      )
    }
    sharedCondition = first
  }

  // The new feature's type mirrors the parent list, which is the only choice that preserves what
  // the entries did. A weighted pick extracted into an aggregate would place all of them.
  const defaultType =
    kind === 'weighted'
      ? 'minecraft:weighted_random_feature'
      : kind === 'sequence'
        ? 'minecraft:sequence_feature'
        : 'minecraft:aggregate_feature'
  const typeId = request.typeId ?? defaultType
  if (kind === 'weighted' && typeId !== 'minecraft:weighted_random_feature') {
    return refuse(
      'order-sensitive',
      `these are entries of a weighted_random_feature, which picks ONE of them. Extracting them as a ${typeId} would place all of ` +
        'them every time. Extract them as a weighted_random_feature (the default) so the relative weights survive.',
      [parentId],
    )
  }

  const children = ordered.map((e) => ({ id: e.to, weight: e.weight ?? null, condition: e.condition ?? null }))
  const built = buildExtractedFeature(graph, request, typeId, children)
  if (isRefusalValue(built)) return { ok: false, refusal: built }

  const operations = [...built.operations]
  const notes = [...built.notes]

  // Rewrite the kept entry, then delete the rest. jsonc.Apply resolves every span against the
  // ORIGINAL bytes before splicing anything, so deleting [1] and [2] in one call is correct and
  // the indices do not have to be walked backwards.
  const keptSpans = spans[0]!
  if (kind === 'weighted') {
    // The parent's single entry takes the SUM of the extracted weights, which preserves every
    // probability exactly: picking the group with weight (a+b) and then a within it is the same
    // distribution as picking a or b directly.
    const total = ordered.reduce((sum, e) => sum + (e.weight ?? 1), 0)
    const absent = ordered.filter((e) => e.weight === undefined || e.weight === null)
    if (absent.length > 0) {
      notes.push({
        level: 'warning',
        message:
          `${absent.length} of these entries wrote no weight, and the engine defaults an absent one to 1.0. That default is used for ` +
          `the arithmetic, so the new entry's weight is ${total} and every probability is unchanged -- but the value is now written ` +
          'down where it was implied before.',
      })
    }
    operations.push(setOperation(parentFile, keptSpans.entry, [request.newId, total]))
  } else if (kind === 'conditional') {
    const entry: Record<string, unknown> = { places_feature: request.newId }
    if (sharedCondition !== null && sharedCondition !== undefined) entry['condition'] = sharedCondition
    operations.push(setOperation(parentFile, keptSpans.entry, entry))
  } else {
    operations.push(setOperation(parentFile, keptSpans.reference ?? keptSpans.entry, request.newId))
  }
  for (let i = 1; i < spans.length; i++) {
    operations.push({ op: 'delete', file: parentFile, path: spans[i]!.entry })
  }

  const interior = request.selection.filter((id) => !entryIds.includes(id))
  if (interior.length > 0) {
    notes.push({
      level: 'info',
      message: `${interior.join(', ')} ${interior.length === 1 ? 'is' : 'are'} already reached through the extracted entries, so ${
        interior.length === 1 ? 'it is' : 'they are'
      } not listed in ${request.newId} and ${interior.length === 1 ? 'its' : 'their'} own file is untouched.`,
    })
  }

  return {
    ok: true,
    plan: {
      action: 'extract-feature',
      title: `Extract ${entryIds.length} entries of ${parentId} into ${request.newId}`,
      summary:
        `${request.newId} is a new ${typeId} holding ${entryIds.join(', ')}, and ${parentId}'s ${entryIds.length} entries collapse ` +
        `into one reference to it. ${
          kind === 'weighted'
            ? 'The group takes the sum of their weights, so every probability is unchanged.'
            : 'Nothing else about what gets placed changes.'
        }`,
      operations,
      files: planFiles(operations),
      creates: [request.newId],
      notes,
    },
  }
}

interface ExtractedChild {
  readonly id: string
  readonly weight: number | null
  readonly condition: string | null
}

/** Builds the createFile operation for an extracted feature, in whichever list spelling its type
 * uses. */
function buildExtractedFeature(
  graph: IdiomGraph,
  request: ExtractFeatureRequest,
  typeId: string,
  children: readonly ExtractedChild[],
): { operations: PlanOperation[]; notes: PlanNote[] } | Refusal {
  const created = checkNewFeature(graph, { newId: request.newId, file: request.file, existingFiles: request.existingFiles })
  if (created !== null) return created
  const inheritFrom = nodeById(graph, children[0]!.id)
  const formatVersion = resolveFormatVersion(request.formatVersion, inheritFrom)
  if (isRefusalValue(formatVersion)) return formatVersion
  const version = parseFormatVersionSafely(formatVersion)
  if (!typeAvailableAt(typeId, version)) {
    return {
      code: 'wrapper-unavailable',
      reason:
        `${typeId} is registered only from format_version ${minFormatVersionForType(typeId)} onward, and this file would declare ` +
        `${formatVersion}. The engine would not recognise the type key at all.`,
    }
  }

  let list: unknown
  let listKey: string
  if (typeId === 'minecraft:weighted_random_feature') {
    listKey = 'features'
    // The [featureReference, weight] tuple, which is the shape packs conventionally use.
    list = children.map((c) => [c.id, c.weight ?? 1])
  } else if (typeId === 'minecraft:conditional_list') {
    listKey = 'conditional_features'
    list = children.map((c) => (c.condition === null ? { places_feature: c.id } : { places_feature: c.id, condition: c.condition }))
  } else {
    listKey = 'features'
    list = children.map((c) => c.id)
  }

  const { fields, placeholders } = seedRequired(typeId, formatVersion, new Set([listKey]))
  const notes: PlanNote[] = []
  if (placeholders.length > 0) {
    notes.push({
      level: 'warning',
      message: `${request.newId} is written with placeholder values for its required key${placeholders.length === 1 ? '' : 's'} ${placeholders.join(', ')}; the file does not load until they are filled in.`,
    })
  }
  return {
    operations: [
      {
        op: 'createFile',
        file: request.file,
        identifier: request.newId,
        typeId,
        contents: featureFileContents(typeId, request.newId, formatVersion, { [listKey]: list, ...fields }),
      },
    ],
    notes,
  }
}

/** Everything reachable from `from` without leaving `within`. Used only to tell an interior node
 * apart from a second way in. */
function reachable(graph: IdiomGraph, from: readonly string[], within: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>()
  const queue = [...from]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const edge of graph.edges) {
      if (edge.from !== id) continue
      if (!within.has(edge.to) || seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return seen
}

// ---------------------------------------------------------------------------
// Action 4 -- wrap an existing node
// ---------------------------------------------------------------------------

export type WrapperKind = 'filter' | 'weighted' | 'conditional'

export interface WrapperSpec {
  readonly typeId: string
  readonly kind: WrapperKind
  /** The key the wrapped feature's reference is written under, which is NOT the same word across
   * the filters -- snap_to_surface says `feature_to_snap`, surface_relative_threshold says
   * `feature_to_place`, and neither accepts the other's spelling. A file using the wrong one does
   * not load. */
  readonly childKey: string
  readonly label: string
  readonly doc: string
}

/** The wrappers this action offers. Every childKey here is the key the engine's own parser reads
 * for that type, not a family resemblance: surface_relative_threshold in particular refuses
 * `feature`, `wrapped_feature` and `places_feature` outright, all three of which look like they
 * ought to work. */
export const WRAPPERS: readonly WrapperSpec[] = [
  {
    typeId: 'minecraft:snap_to_surface_feature',
    kind: 'filter',
    childKey: 'feature_to_snap',
    label: 'Snap to a surface',
    doc: 'Scans for a floor, ceiling or wall within a range and places the wrapped feature there instead of at the origin.',
  },
  {
    typeId: 'minecraft:surface_relative_threshold_feature',
    kind: 'filter',
    childKey: 'feature_to_place',
    label: 'Only below the surface',
    doc: 'Places the wrapped feature only where the origin is strictly deeper than minimum_distance_below_surface.',
  },
  {
    typeId: 'minecraft:height_difference_filter_feature',
    kind: 'filter',
    childKey: 'places_feature',
    label: 'Only on given terrain relief',
    doc: 'Places the wrapped feature only where the height difference within a search radius is inside the given bounds.',
  },
  {
    typeId: 'minecraft:scan_surface',
    kind: 'filter',
    childKey: 'places_feature',
    label: 'On every surface block',
    doc: 'Walks the surface of the placement volume and places the wrapped feature on each block of it.',
  },
  {
    typeId: 'minecraft:search_feature',
    kind: 'filter',
    childKey: 'places_feature',
    label: 'Search a volume for a spot',
    doc: 'Searches a volume along an axis for positions the wrapped feature accepts, and stops after required_successes of them.',
  },
  {
    typeId: 'minecraft:weighted_random_feature',
    kind: 'weighted',
    childKey: 'features',
    label: 'Make it one of several picks',
    doc: 'Picks exactly one entry by weight. The wrapped feature becomes the first entry; add the alternatives afterwards.',
  },
  {
    typeId: 'minecraft:conditional_list',
    kind: 'conditional',
    childKey: 'conditional_features',
    label: 'Make it conditional',
    doc: 'Walks its entries and places each one whose Molang condition passes.',
  },
]

export function wrapperSpec(typeId: string): WrapperSpec | undefined {
  return WRAPPERS.find((w) => w.typeId === typeId)
}

export interface WrapNodeRequest {
  readonly target: string
  /** One of WRAPPERS' typeIds. */
  readonly wrapper: string
  readonly newId: string
  readonly file: string
  readonly formatVersion?: string | undefined
  /** weighted only -- the weight the wrapped feature gets in the new pick. Defaults to 1, which
   * is also the engine's default for an absent one. */
  readonly weight?: number | undefined
  /** conditional only -- the Molang condition on the wrapped feature's entry. Omitted means the
   * entry carries no condition, which the engine reads as always. */
  readonly condition?: string | undefined
  /** Wrap a feature nothing references. Off by default: the wrapper would be unreachable and the
   * author would have changed two files for no effect on the world. */
  readonly allowUnreferenced?: boolean | undefined
  readonly existingFiles?: readonly string[] | undefined
}

/** Slips a wrapper in above an existing feature: creates the wrapper, puts the target inside it,
 * and retargets every reference to the target at the wrapper. Two files at least, and in a pack
 * where a leaf is referenced from five trees, six.
 *
 * The version gate is the refusal worth knowing about. The new file inherits the target's declared
 * format_version by default -- a pack authored against one band should not sprout a file from
 * another because this module had a favourite -- and a couple of types are registered only above
 * the floor. Offering `minecraft:multi_block_feature` into a 1.21.10 pack would produce a file
 * whose top-level key the engine does not recognise, so the type gate is checked rather than
 * assumed. */
export function wrapNode(graph: IdiomGraph, request: WrapNodeRequest): IdiomResult {
  const spec = wrapperSpec(request.wrapper)
  if (spec === undefined) {
    return refuse(
      'unknown-wrapper',
      `"${request.wrapper}" is not one of the wrappers this action knows (${WRAPPERS.map((w) => w.typeId).join(', ')}).`,
    )
  }
  const target = resolveFeature(graph, request.target, 'the feature to wrap')
  if (isRefusalValue(target)) return { ok: false, refusal: target }

  const onCycle = nodesOnCycles(graph)
  if (onCycle.has(target.id)) {
    return refuse(
      'cycle',
      `${target.id} lies on a delegation cycle. Retargeting every reference to it would put the wrapper inside the loop, so the ` +
        'recursion the engine guards would run through a filter that was not there when the pack was written.',
      [target.id],
    )
  }

  const inbound = referrers(graph, target.id)
  if (inbound.length === 0 && request.allowUnreferenced !== true) {
    return refuse(
      'no-referrers',
      `nothing in this pack delegates to ${target.id}, so a wrapper around it would be unreachable -- two files would change and the ` +
        'world would not. Point something at the wrapper afterwards, or pass allowUnreferenced to create it anyway.',
      [target.id],
    )
  }

  const created = checkNewFeature(graph, { newId: request.newId, file: request.file, existingFiles: request.existingFiles })
  if (created !== null) return { ok: false, refusal: created }
  const formatVersion = resolveFormatVersion(request.formatVersion, target)
  if (isRefusalValue(formatVersion)) return { ok: false, refusal: formatVersion }
  const version = parseFormatVersionSafely(formatVersion)
  if (!typeAvailableAt(spec.typeId, version)) {
    return refuse(
      'wrapper-unavailable',
      `${spec.typeId} is registered only from format_version ${minFormatVersionForType(spec.typeId)} onward, and the new file would ` +
        `declare ${formatVersion} (inherited from ${target.id}). The engine would not recognise the type key, so the file would not load.`,
      [target.id],
    )
  }

  let child: unknown
  if (spec.kind === 'weighted') {
    child = [[target.id, request.weight ?? 1]]
  } else if (spec.kind === 'conditional') {
    child = [request.condition === undefined ? { places_feature: target.id } : { places_feature: target.id, condition: request.condition }]
  } else {
    child = target.id
  }

  const { fields, placeholders } = seedRequired(spec.typeId, formatVersion, new Set([spec.childKey]))
  const operations: PlanOperation[] = [
    {
      op: 'createFile',
      file: request.file,
      identifier: request.newId,
      typeId: spec.typeId,
      contents: featureFileContents(spec.typeId, request.newId, formatVersion, { [spec.childKey]: child, ...fields }),
    },
  ]
  const notes: PlanNote[] = []
  if (placeholders.length > 0) {
    notes.push({
      level: 'warning',
      message: `${request.newId} is written with placeholder values for its required key${placeholders.length === 1 ? '' : 's'} ${placeholders.join(', ')}; the file does not load until they are filled in.`,
    })
  }
  if (spec.kind === 'weighted') {
    notes.push({
      level: 'info',
      message: `${request.newId} currently has one entry, so it picks ${target.id} every time until alternatives are added beside it.`,
    })
  }
  if (inbound.length === 0) {
    notes.push({ level: 'warning', message: `Nothing references ${request.newId}; it will not be placed until something does.` })
  }
  const retargeted = appendRetargets(graph, operations, inbound, request.newId, notes)
  if (retargeted !== null) return { ok: false, refusal: retargeted }

  return {
    ok: true,
    plan: {
      action: 'wrap-node',
      title: `Wrap ${target.id} in ${spec.label.toLowerCase()}`,
      summary:
        `A new ${spec.typeId} ${request.newId} holds ${target.id}, and the ${inbound.length} reference${inbound.length === 1 ? '' : 's'} ` +
        `to ${target.id} now point at it. ${spec.doc}`,
      operations,
      files: planFiles(operations),
      creates: [request.newId],
      notes,
    },
  }
}

// ---------------------------------------------------------------------------
// What can I do with this selection?
// ---------------------------------------------------------------------------

export interface IdiomOffer {
  readonly action: IdiomAction
  /** Imperative, in the author's words rather than the schema's. */
  readonly label: string
  readonly detail: string
  readonly available: boolean
  /** Why not, when not. Short enough for a greyed-out menu item's tooltip. */
  readonly unavailable?: string
}

/** The menu. One call, given whatever is selected, so a renderer does not have to re-derive which
 * of the four actions make sense -- and so that "this is greyed out" always comes with a reason.
 *
 * These are CHEAP structural probes, not dry runs: an action's full check needs an identifier and
 * a file the author has not typed yet, so a plan cannot be built to decide whether to offer the
 * button that asks for them. Anything an offer cannot see here still refuses later, with the
 * same codes. */
export function availableIdioms(graph: IdiomGraph, selection: readonly string[]): IdiomOffer[] {
  const single = selection.length === 1 ? nodeById(graph, selection[0]!) : undefined
  const singleUsable = single !== undefined && single.unresolved !== true && single.typeId !== RULE_TYPE_ID
  const isScatter = single?.typeId === SCATTER_TYPE_ID
  const notSingle =
    selection.length === 0
      ? 'select one feature.'
      : selection.length > 1
        ? 'select exactly one feature.'
        : single === undefined
          ? 'that feature is not in this graph.'
          : single.unresolved === true
            ? 'that reference resolves to nothing.'
            : 'a feature rule cannot be wrapped or placed by another feature.'

  const offers: IdiomOffer[] = [
    {
      action: 'gate-scatter',
      label: 'Place this only when...',
      detail: isScatter
        ? 'Multiplies this scatter\'s iterations by a Molang test. Zero iterations places nothing, which is how this format spells an if.'
        : 'Creates a scatter above this feature whose iterations are zero unless a Molang test passes.',
      available: singleUsable,
      ...(singleUsable ? {} : { unavailable: notSingle }),
    },
    {
      action: 'setup-scatter',
      label: 'Set up variables for this...',
      detail: isScatter
        ? 'Adds variable.* assignments in front of this scatter\'s iterations, keeping its count as the `return` value.'
        : 'Creates a scatter above this feature that assigns variable.* the feature can read, and returns a count.',
      available: singleUsable,
      ...(singleUsable ? {} : { unavailable: notSingle }),
    },
    {
      action: 'wrap-node',
      label: 'Wrap in...',
      detail: 'Creates a filter, a weighted pick or a conditional list around this feature and retargets every reference to it.',
      available: singleUsable,
      ...(singleUsable ? {} : { unavailable: notSingle }),
    },
  ]

  const extractable = extractOfferReason(graph, selection)
  offers.push({
    action: 'extract-feature',
    label: 'Extract into a new feature...',
    detail: 'Gathers the selected entries into one named feature and collapses their parent\'s references into a single one.',
    available: extractable === null,
    ...(extractable === null ? {} : { unavailable: extractable }),
  })
  return offers
}

function extractOfferReason(graph: IdiomGraph, selection: readonly string[]): string | null {
  if (selection.length < 2) return 'select two or more features that share a parent.'
  const selected = new Set(selection)
  for (const id of selection) {
    const node = nodeById(graph, id)
    if (node === undefined) return `${id} is not in this graph.`
    if (node.unresolved === true) return `${id} resolves to nothing.`
    if (node.typeId === RULE_TYPE_ID) return 'a feature rule cannot be placed by another feature.'
  }
  const onCycle = nodesOnCycles(graph)
  if (selection.some((id) => onCycle.has(id))) return 'a delegation cycle runs through this selection.'
  const boundary = graph.edges.filter((e) => !selected.has(e.from) && selected.has(e.to))
  const parents = new Set(boundary.map((e) => e.from))
  if (parents.size > 1) return 'these features are referenced from more than one place.'
  return null
}

// ---------------------------------------------------------------------------

/** parseFormatVersion, with a present-but-unparseable value read as absent rather than thrown.
 * Every gate this module runs treats absent as "judge the keys on their own terms" (typeCatalog's
 * own argument), which is the right answer for a version string this module could not read: it
 * offers everything and refuses nothing on a ground it does not actually have. */
function parseFormatVersionSafely(raw: string | undefined): FormatVersion {
  try {
    return parseFormatVersion(raw ?? null)
  } catch {
    return ABSENT_FORMAT_VERSION
  }
}

function readFormatVersion(node: IdiomGraphNode): FormatVersion {
  return parseFormatVersionSafely(node.formatVersion)
}
