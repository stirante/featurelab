// lifecycle.ts -- the two operations on a feature that are not edits to its body: giving it a
// different NAME, and removing it.
//
// Creating a node already works, and it names the new feature for the author -- example:scatter_1
// and the like -- because nobody has been asked for a name at that point. Without a rename that
// placeholder is permanent, which is how every feature anybody makes in this editor ends up
// called example:scatter_1. That is what this module is for.
//
// SHAPE: a PLANNER, exactly like idioms.ts, and for the same reason. Nothing here touches a disk.
// A request plus the graph goes in; a description of the change -- which files, which JSON paths,
// which bytes -- or a refusal with a sentence comes out. The write itself happens on the Go side,
// where the round-trip writer splices edits into the original text and every comment, key order
// and indent byte the author wrote survives by construction. Two writers would be two chances to
// reformat a file somebody has in version control.
//
// WHAT THIS IS NOT: it is not the authority on whether the change is safe. The plan is built from
// the GRAPH, which is a view of the pack as it was when it was built, and a view can be older
// than the pack -- another window saved, a branch was switched, the JSON was hand-edited. The
// server re-reads every file and re-checks the value at every path before it writes a byte, and
// refuses the whole operation if one of them has stopped saying what the graph said it says. So a
// plan from here is what to SHOW the author and what to ASK the server for; it is never a licence
// the server takes on trust. `plan.request` is that ask, already shaped.
//
// REFUSALS ARE THE PRODUCT. Deleting a feature something else delegates to is the dangerous one:
// the delegation stays behind in a file the author is not looking at, resolving to nothing, and
// the editor then draws it as a dangling edge -- honestly, and not at all what was asked for. So
// the default is to refuse and name every referrer. Clearing them is available and is asked for
// explicitly.
//
// AND A REFUSAL IS NOT THE ONLY HONEST ANSWER ANY MORE. There is now a third thing a reference
// can be pointed AT: graph/incomplete.ts's PLACEHOLDER_FEATURE, which draws no ghost node and
// instead makes the referring node say "Needs a feature to place", with the button that fills it.
// A delegation the referring type cannot load without used to stop the whole delete -- see
// deleteFeature's own comment -- and is now retargeted onto that sentinel: the author gets their
// deletion, the parent still loads, and the thing that needs a decision is marked on the canvas
// where they will meet it rather than described in a message they read once.
import {
  malformedIdReason,
  formatJsonPath,
  isIndexSegment,
  parseJsonPath,
  type IdiomGraph,
  type IdiomGraphEdge,
  type IdiomGraphNode,
  type PlanNote,
  type PlanOperation,
} from './idioms.js'
// The synthetic type a feature rule's node carries, the key its FILE is actually rooted at, and
// the editor's version of the engine's identifier-versus-file-name warning. The two strings are
// different by design -- the node names one rule, the file's key names the collection -- and they
// come from the one module that records the pack's file layout rather than being restated here.
// PLACEHOLDER_FEATURE comes from the same module for the same reason: it is what this editor
// already writes wherever it has to name a feature and does not know one yet, and graph/
// incomplete.ts is what turns a reference to it into "this node needs a feature" on the canvas.
// A second spelling of the sentinel here would be a second thing to keep in step with that.
import { PLACEHOLDER_FEATURE, RULE_BODY_KEY, RULE_TYPE_ID, ruleFileNameNote } from './compounds/spec.js'

/** Kinds whose delegation is one entry of an ARRAY. Detaching one means removing the entry, not
 * the reference: a conditional entry stripped of its places_feature still has a condition and
 * nothing left to place, and a weighted entry still has a weight. */
const LIST_KINDS: ReadonlySet<string> = new Set(['aggregate', 'sequence', 'weighted', 'conditional'])

/** Kinds whose array the engine refuses to load EMPTY -- an aggregate's and a sequence's
 * `features`, and a weighted_random's. `conditional_features` is deliberately absent: it is
 * required to be present and is accepted empty, so removing the last entry of one is an edit
 * rather than a breakage. */
const NON_EMPTY_LIST_KINDS: ReadonlySet<string> = new Set(['aggregate', 'sequence', 'weighted'])

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** idioms.ts's three operations plus the one only this module has: removing a whole file.
 *
 * A feature file holds exactly one feature, so deleting the feature IS deleting the file -- there
 * is no edit that expresses it, in the same way that creating a feature is not an edit to
 * anything. It is kept separate from `delete` (which removes a path INSIDE a file) because the
 * two fail differently and a caller that confused them would remove a pack file when it meant to
 * remove a list entry. */
export type LifecycleOperation =
  | PlanOperation
  | {
      readonly op: 'deleteFile'
      /** Pack-relative, as GraphNode.File reports it. */
      readonly file: string
      /** The feature the file declares, so a caller can drop it from its own index -- and so the
       * server has something to check the file still says before removing it. */
      readonly identifier: string
    }

export type LifecycleAction = 'rename-feature' | 'delete-feature'

/** The server call this plan corresponds to. Carried on the plan so the panel forwards it rather
 * than re-deriving it from the operations -- the operations are for showing the author what is
 * about to happen, and a second derivation of the same request is a second thing to get wrong. */
export type LifecycleRequest =
  | { readonly method: 'renameFeature'; readonly params: { readonly from: string; readonly to: string } }
  | {
      readonly method: 'deleteFeature'
      readonly params: {
        readonly id: string
        readonly detachReferences: boolean
        /** The delegations to point at PLACEHOLDER_FEATURE BEFORE the delete is asked for, named
         * the way every path this editor sends is named: by the node whose file it is in, which
         * only the host may turn into a path.
         *
         * Two calls rather than one because the engine's `deleteFeature` has exactly the refusal
         * this module used to have -- it stops on a required delegation -- and its contract is
         * frozen. Retargeting first is not a way around that refusal, it is the thing that makes
         * it inapplicable: by the time the delete runs, nothing required points at the feature
         * any more. Each intermediate state is a pack that loads, which is the same property the
         * engine's own ordering has: after the retarget the parent places a stand-in, and if the
         * delete then fails the pack is whole and says so on the canvas. */
        readonly retarget: readonly { readonly nodeId: string; readonly path: string }[]
      }
    }

/** One delegation that is being pointed at the placeholder instead of removed. */
export interface RetargetedSlot {
  /** The node that delegates -- the one that will wear "Needs a feature" afterwards. */
  readonly nodeId: string
  /** Pack-relative, from the referring node. */
  readonly file: string
  /** Where the reference string itself is written. */
  readonly path: string
}

export interface LifecyclePlan {
  readonly action: LifecycleAction
  /** One line, imperative, suitable for a confirmation button or an undo entry. */
  readonly title: string
  /** A few sentences: what changes, and what it does to the pack. */
  readonly summary: string
  readonly operations: readonly LifecycleOperation[]
  /** Every file the plan touches, de-duplicated and sorted. */
  readonly files: readonly string[]
  /** The feature the plan is about, by its CURRENT name -- what a caller re-selects, highlights
   * or drops from its own index once the plan has run. */
  readonly subject: string
  /** The delegations this plan points at the placeholder rather than removing, so a caller can
   * say afterwards WHICH nodes now need attention and take somebody to one. Always present and
   * usually empty: a rename retargets nothing, and so does deleting something unreferenced. */
  readonly retargeted: readonly RetargetedSlot[]
  readonly notes: readonly PlanNote[]
  readonly request: LifecycleRequest
}

export type LifecycleRefusalCode =
  | 'unknown-node'
  | 'unresolved-node'
  | 'no-file'
  | 'id-malformed'
  | 'id-exists'
  | 'id-unchanged'
  | 'path-shape'
  /** Something delegates to the feature and the caller did not ask for those to be cleared. */
  | 'referenced'
  /** Removing the delegations would leave an array the engine requires to be non-empty.
   *
   * The neighbouring `required-reference` code is GONE rather than deprecated: a delegation the
   * referring type cannot load without is now retargeted onto the placeholder instead of
   * refused, so nothing can return that code any more, and a code in this union that nothing
   * returns is a promise to a renderer that the module does not keep. */
  | 'would-empty-list'

export interface LifecycleRefusal {
  readonly code: LifecycleRefusalCode
  /** A whole sentence, addressed to the author, naming what to do instead wherever there is
   * something to do. It is the entire user-visible product of a refusal, so it is never a code
   * name with the underscores taken out. */
  readonly reason: string
  /** The node ids the refusal is about, so a renderer can highlight them. */
  readonly nodes?: readonly string[]
}

export type LifecycleResult =
  | { readonly ok: true; readonly plan: LifecyclePlan }
  | { readonly ok: false; readonly refusal: LifecycleRefusal }

function refuse(code: LifecycleRefusalCode, reason: string, nodes?: readonly string[]): LifecycleResult {
  return { ok: false, refusal: nodes === undefined ? { code, reason } : { code, reason, nodes } }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Folds an identifier the way the engine's feature registry does: two names that differ only in
 * case are ONE feature there, the first file loaded keeps the name, and the other file is
 * unreachable however correct it is -- silently, because the pack reports nothing.
 *
 * ASCII only, matching the engine. A locale-aware lowercase would fold characters the engine does
 * not, and identifiers are namespace:name pairs where that has never come up. */
export function foldIdentifier(identifier: string): string {
  let out = ''
  for (let i = 0; i < identifier.length; i++) {
    const c = identifier.charCodeAt(i)
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : identifier[i]!
  }
  return out
}

/** Resolves an identifier to its node without regard to case, preferring an exact spelling when
 * one exists. An editor holding the name as some other file spelled it would otherwise be told
 * the pack does not define a feature it plainly does. */
function findNode(graph: IdiomGraph, id: string): IdiomGraphNode | undefined {
  const exact = graph.nodes.find((n) => n.id === id)
  if (exact !== undefined) return exact
  const key = foldIdentifier(id)
  return graph.nodes.find((n) => foldIdentifier(n.id) === key)
}

/** A node this module may act on: present, resolved, and backed by a file.
 *
 * A dangling reference is deliberately excluded from BOTH operations. It is in the graph -- that
 * is what wire.GraphNode.Unresolved is for -- but no file declares it, so there is no identifier
 * to rewrite and no file to remove. The thing to fix is whatever points at it. */
function resolveNode(graph: IdiomGraph, id: string, what: string): IdiomGraphNode | LifecycleRefusal {
  const node = findNode(graph, id)
  if (node === undefined) return { code: 'unknown-node', reason: `${what} "${id}" is not in this graph.`, nodes: [id] }
  if (node.unresolved === true) {
    return {
      code: 'unresolved-node',
      reason:
        `"${node.id}" is a dangling reference -- something in this pack delegates to it and no file defines it. ` +
        'There is no name to change and no file to remove; the file that points at it is the one to fix.',
      nodes: [node.id],
    }
  }
  if (node.file === undefined || node.file === '') {
    return { code: 'no-file', reason: `"${node.id}" does not report a file, so there is nothing to change.`, nodes: [node.id] }
  }
  return node
}

function isRefusal(v: unknown): v is LifecycleRefusal {
  return typeof v === 'object' && v !== null && 'code' in v && 'reason' in v
}

/** Every edge pointing AT `id`, in graph order (the contract's order, so a plan is byte-identical
 * run to run), with self-references left out.
 *
 * A feature that delegates to itself is not a referrer for either operation's purposes: that
 * reference lives in the feature's own file, so a rename rewrites it as part of the file it is
 * already rewriting, and a delete takes it away along with the file. */
function referrers(graph: IdiomGraph, id: string): IdiomGraphEdge[] {
  return graph.edges.filter((e) => e.to === id && e.from !== id)
}

function nodeFile(graph: IdiomGraph, id: string): string | undefined {
  const file = findNode(graph, id)?.file
  return file === undefined || file === '' ? undefined : file
}

function planFiles(operations: readonly LifecycleOperation[]): string[] {
  return [...new Set(operations.map((op) => op.file))].sort()
}

function setOperation(file: string, path: string, value: unknown): PlanOperation {
  return { op: 'set', file, path, json: JSON.stringify(value), value }
}

// ---------------------------------------------------------------------------
// Where a name is written
// ---------------------------------------------------------------------------

/** The path of a node's own `description.identifier`, rooted at the FILE the way every path in
 * this contract is.
 *
 * The body key is taken from a path the graph producer already emitted whenever the node has one
 * -- an outgoing edge's first segment is exactly that key -- and only falls back to the type id
 * when the node delegates to nothing. The fallback needs its own case for a rule, whose node
 * carries the singular synthetic type while its file is rooted at the plural collection. */
function identifierPath(graph: IdiomGraph, node: IdiomGraphNode): string | null {
  for (const edge of graph.edges) {
    if (edge.from !== node.id) continue
    const segments = parseJsonPath(edge.jsonPath)
    if (segments === null || segments.length < 2) continue
    const root = segments[0]!
    if (isIndexSegment(root)) continue
    return formatJsonPath([root, { key: 'description' }, { key: 'identifier' }])
  }
  const bodyKey = node.typeId === RULE_TYPE_ID ? RULE_BODY_KEY : node.typeId
  if (bodyKey === undefined || bodyKey === '') return null
  return formatJsonPath([{ key: bodyKey }, { key: 'description' }, { key: 'identifier' }])
}

/** Where an edge's reference STRING is, cross-checked against the edge's own ordinal.
 *
 * The contract pins the path dialect but not the shape each kind's path takes, and a path whose
 * list index disagrees with the ordinal it claims to be addresses a different entry -- rewriting
 * it would retarget somebody else's delegation, and the path still resolves, so nothing would
 * report it. A shape this cannot read is a refusal, never a guess.
 *
 * The one shape with no reference span of its own is a weighted entry reported as the whole
 * `[feature, weight]` tuple rather than the slot inside it. The value there is an array, not a
 * string, so there is nothing to set a name into. */
function referencePath(edge: IdiomGraphEdge): string | null {
  const segments = parseJsonPath(edge.jsonPath)
  if (segments === null || segments.length === 0) return null
  if (!LIST_KINDS.has(edge.kind)) return edge.jsonPath

  const last = segments[segments.length - 1]!
  const prev = segments.length >= 2 ? segments[segments.length - 2]! : null
  const ordinal = edge.ordinal

  if (edge.kind === 'aggregate' || edge.kind === 'sequence') {
    if (!isIndexSegment(last)) return null
    if (ordinal !== undefined && last.index !== ordinal) return null
    return edge.jsonPath
  }
  if (edge.kind === 'conditional') {
    if (isIndexSegment(last) || prev === null || !isIndexSegment(prev)) return null
    if (ordinal !== undefined && prev.index !== ordinal) return null
    return edge.jsonPath
  }
  // weighted: the tuple's first slot, or the object form's key. Both sit one level inside the
  // entry; the entry itself holds no bare reference.
  if (prev === null || !isIndexSegment(prev)) return null
  if (ordinal !== undefined && prev.index !== ordinal) return null
  return edge.jsonPath
}

/** The path whose removal takes the whole delegation with it: the ENTRY for a list kind, the key
 * itself for a single slot. Shares referencePath's cross-check, because a path good enough to
 * rewrite is exactly the standard for one worth removing. */
function detachPath(edge: IdiomGraphEdge): string | null {
  if (referencePath(edge) === null) return null
  if (!LIST_KINDS.has(edge.kind)) return edge.jsonPath
  const segments = parseJsonPath(edge.jsonPath)
  if (segments === null || segments.length === 0) return null
  if (edge.kind === 'aggregate' || edge.kind === 'sequence') return edge.jsonPath
  return formatJsonPath(segments.slice(0, -1))
}

function pathShapeRefusal(edge: IdiomGraphEdge): LifecycleRefusal {
  return {
    code: 'path-shape',
    reason:
      `the ${edge.kind} delegation ${edge.from} -> ${edge.to} reports the path "${edge.jsonPath}", which does not have the ` +
      'shape that kind requires (its list index does not match the delegation\'s own position). Acting on it would edit a ' +
      'different entry, so nothing is planned.',
    nodes: [edge.from, edge.to],
  }
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface RenameFeatureRequest {
  /** The feature to rename, as the graph reports it. Matched without regard to case. */
  readonly target: string
  readonly newId: string
}

/** Renames a feature or a feature rule everywhere it is written: its own description.identifier,
 * and every delegation in the pack that resolves to it.
 *
 * BOTH HALVES OR NEITHER. A rename that moved only the declaration would break every file that
 * points at the feature; one that moved only the references would break it the other way round.
 * So a reference this cannot address refuses the whole operation rather than producing a plan
 * that is right about most of the pack.
 *
 * THE FILE IS NOT RENAMED. `features/<name>.json` is the convention this editor follows when it
 * creates one, but it is only a convention: a pack may name a feature file anything, and the
 * engine reads the identifier out of the file rather than deriving anything from the name.
 * Renaming the file would be a different operation with its own surprises -- it invalidates
 * whatever the author has open, including unsaved buffers, and moves a path that version control
 * or a build script may be holding. A feature rule is the one case where leaving it has a visible
 * consequence, and that is a note: the engine compares a rule's identifier against its own file
 * name and logs when they differ. The rule loads and runs either way.
 *
 * CASE. The engine matches feature identifiers without regard to case, so a name that differs
 * only in case from another feature's is not a free name -- the two would be one name, the first
 * file loaded would keep it, and the other feature would stop being placed with nothing reported.
 * That is refused. Re-spelling a feature's OWN name in another case is the opposite situation: it
 * changes nothing the pack generates, which is exactly why an author does it, and every reference
 * moves with it so the pack stops spelling its own feature two ways. */
export function renameFeature(graph: IdiomGraph, request: RenameFeatureRequest): LifecycleResult {
  const newId = request.newId.trim()
  const malformed = malformedIdReason(newId)
  if (malformed !== null) return refuse('id-malformed', malformed)

  const node = resolveNode(graph, request.target, 'the feature to rename')
  if (isRefusal(node)) return { ok: false, refusal: node }
  if (node.id === newId) {
    return refuse('id-unchanged', `"${newId}" is the name it already has.`, [node.id])
  }

  const notes: PlanNote[] = []
  let adopted = 0
  for (const other of graph.nodes) {
    if (foldIdentifier(other.id) !== foldIdentifier(newId)) continue
    if (foldIdentifier(other.id) === foldIdentifier(node.id)) continue
    if (other.unresolved === true) {
      // Not a collision: no file declares it. The pack is already pointing at this name and
      // getting nothing, so the rename REPAIRS those references -- which is usually the point,
      // and is never left unsaid.
      adopted = graph.edges.filter((e) => e.to === other.id).length
      continue
    }
    const where = other.file !== undefined && other.file !== '' ? `, declared by ${other.file}` : ''
    if (other.id === newId) {
      return refuse('id-exists', `"${newId}" is already taken${where}. Rename or remove that one first.`, [other.id])
    }
    if (other.typeId === RULE_TYPE_ID && node.typeId === RULE_TYPE_ID) {
      return refuse(
        'id-exists',
        `"${newId}" differs only in case from "${other.id}"${where}. Two feature rules named that way are two rules to the ` +
          'engine and one node to this editor, so the rename is refused rather than hiding one of them.',
        [other.id],
      )
    }
    return refuse(
      'id-exists',
      `"${newId}" differs only in case from "${other.id}"${where}, and the engine matches feature identifiers without regard ` +
        'to case. The two would be one name: the first file loaded would keep it and the other feature would stop being ' +
        'placed, with nothing reported.',
      [other.id],
    )
  }

  const declarationPath = identifierPath(graph, node)
  if (declarationPath === null) {
    return refuse(
      'path-shape',
      `"${node.id}" does not report a type, so this cannot say where in ${node.file} its identifier is written.`,
      [node.id],
    )
  }
  const operations: LifecycleOperation[] = [setOperation(node.file!, declarationPath, newId)]

  const inbound = referrers(graph, node.id)
  const selfReferences = graph.edges.filter((e) => e.from === node.id && e.to === node.id)
  for (const edge of [...inbound, ...selfReferences]) {
    const file = nodeFile(graph, edge.from)
    if (file === undefined) {
      return refuse(
        'no-file',
        `"${edge.from}" delegates to "${node.id}" and does not report a file, so that reference cannot be rewritten. ` +
          'Renaming only some of a feature\'s references would leave the pack pointing at a name nothing defines.',
        [edge.from],
      )
    }
    const path = referencePath(edge)
    if (path === null) return { ok: false, refusal: pathShapeRefusal(edge) }
    operations.push(setOperation(file, path, newId))
  }

  if (foldIdentifier(node.id) === foldIdentifier(newId)) {
    notes.push({
      level: 'info',
      message:
        `"${node.id}" and "${newId}" are the same name to the engine, which matches feature identifiers without regard to ` +
        'case. Nothing this pack generates changes; the files simply stop spelling one name two ways.',
    })
  }
  if (adopted > 0) {
    notes.push({
      level: 'warning',
      message:
        `${adopted} delegation${adopted === 1 ? '' : 's'} in this pack already name "${newId}" and currently resolve to ` +
        `nothing. From now on ${adopted === 1 ? 'it places' : 'they place'} this feature.`,
    })
  }
  notes.push({
    level: 'info',
    message: `${node.file} still holds it. The engine reads the identifier out of the file and derives nothing from the file's name.`,
  })
  // The engine compares a rule's identifier against its own file name, and this rename can create
  // that mismatch or leave one standing. Asked of the NEW name and the file it is about to live
  // in, so the note appears exactly when it is true -- the version that fired on every rule rename
  // said nothing about this rename, and a warning that is always there is one nobody reads.
  if (node.typeId === RULE_TYPE_ID && node.file !== undefined && node.file !== '') {
    const mismatch = ruleFileNameNote(newId, node.file)
    if (mismatch !== null) notes.push({ level: 'warning', message: mismatch })
  }

  const referenceCount = inbound.length + selfReferences.length
  return {
    ok: true,
    plan: {
      action: 'rename-feature',
      title: `Rename ${node.id} to ${newId}`,
      summary:
        `${node.file} declares ${newId} instead of ${node.id}, and the ${referenceCount} delegation` +
        `${referenceCount === 1 ? '' : 's'} that resolve${referenceCount === 1 ? 's' : ''} to it ${referenceCount === 1 ? 'is' : 'are'} ` +
        'rewritten with it. A reference left behind would resolve to nothing, so this is all of them or none.',
      operations,
      files: planFiles(operations),
      subject: node.id,
      // A rename moves every reference WITH the name, so nothing is left needing a decision.
      retargeted: [],
      notes,
      request: { method: 'renameFeature', params: { from: node.id, to: newId } },
    },
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteFeatureRequest {
  readonly target: string
  /** Remove the delegations that point at the feature as well, instead of refusing because they
   * exist. Off by default, and asked for by the author after being shown what it would touch. */
  readonly detachReferences?: boolean | undefined
}

/** Removes a feature or a feature rule from the pack.
 *
 * A feature something delegates to cannot simply vanish: the delegation stays behind in a file the
 * author was not looking at, resolving to nothing. So the default is to REFUSE while anything
 * references it, and to name every referrer -- which feature, which file, which path -- so the
 * refusal is a list of places to go rather than a "no".
 *
 * Deleting and reporting was the alternative, and it is worse: the report is read once and the
 * dangling references stay. Clearing the references without being asked is the same surprise in
 * the other direction -- files the author never named, changed by an operation they aimed at one
 * feature. So clearing is offered, explicitly, as `detachReferences`.
 *
 * THE THIRD OPTION, which is new, and which is why a required delegation no longer stops this.
 *
 * All of the above was written when a reference had two possible fates: kept, or removed. It now
 * has a third -- pointed at PLACEHOLDER_FEATURE, which graph/incomplete.ts draws as "Needs a
 * feature to place" ON the referring node, with the button that fills it, and draws as no ghost
 * node at all. So:
 *
 *   - a REQUIRED delegation is RETARGETED. Removing it would stop the referring file loading,
 *     and refusing the whole delete over it made the author's decision for them: they still want
 *     the feature gone, and the parent still needs something to place. Pointing it at the
 *     sentinel gives both, and leaves the open question marked where it will be met rather than
 *     described in a refusal. The parent loads, has a valid file, and says what it is waiting
 *     for.
 *   - an OPTIONAL one is REMOVED, exactly as before. A key that is simply absent is not an
 *     unfinished node, and writing a stand-in into a slot the type does not need would invent
 *     work for the author out of a deletion that finished cleanly.
 *
 * The reasoning above survives that: nothing here deletes and leaves a dangling reference, and
 * nothing rewrites a file the author was not shown. `detachReferences` is still the moment they
 * say yes, and the refusal it replaces is still what they are shown to decide from.
 *
 * One refusal in this shape remains. A detach that would empty an array the engine will not load
 * empty -- every entry of one aggregate naming the feature being deleted -- still stops the plan
 * and names the file. That is deliberately NOT retargeted: the repair there is not "one stand-in
 * for one reference" but "remove all but one of these entries and put a stand-in in what is
 * left", which invents a new shape for somebody's list rather than preserving the one they
 * wrote. Asking still beats guessing at that.
 *
 * What the feature itself DELEGATED to is not deleted. Those files are somebody's work and
 * nothing asked for them to go; the ones left referenced by nothing are reported instead. */
export function deleteFeature(graph: IdiomGraph, request: DeleteFeatureRequest): LifecycleResult {
  const node = resolveNode(graph, request.target, 'the feature to delete')
  if (isRefusal(node)) return { ok: false, refusal: node }

  const inbound = referrers(graph, node.id)
  const detach = request.detachReferences === true
  if (inbound.length > 0 && !detach) {
    return refuse('referenced', referencedReason(graph, node.id, inbound), [node.id, ...inbound.map((e) => e.from)])
  }

  // How many of each parent's delegations of each kind would go, against how many it has. The
  // key joins the two on a character an identifier cannot contain, so a feature called "a b" and
  // one called "a" beside a kind called "b" cannot be mistaken for each other.
  //
  // A REQUIRED delegation is not counted as going: it is retargeted below, so its entry stays
  // where it is and the list it sits in cannot be emptied by it. Counting it would refuse a
  // one-entry aggregate -- which is exactly the case the contract marks required -- with
  // "removing these would empty the list" while nothing was being removed from it.
  const operations: LifecycleOperation[] = []
  const retargeted: RetargetedSlot[] = []
  const removedPerList = new Map<string, number>()
  const totalPerList = new Map<string, number>()
  for (const edge of graph.edges) {
    const key = `${edge.from}\u0000${edge.kind}`
    totalPerList.set(key, (totalPerList.get(key) ?? 0) + 1)
  }
  for (const edge of inbound) {
    if (edge.required === true) continue
    const key = `${edge.from}\u0000${edge.kind}`
    removedPerList.set(key, (removedPerList.get(key) ?? 0) + 1)
  }

  for (const edge of inbound) {
    const file = nodeFile(graph, edge.from)
    if (file === undefined) {
      return refuse(
        'no-file',
        `"${edge.from}" delegates to "${node.id}" and does not report a file, so that delegation cannot be removed. ` +
          'Deleting the feature anyway would leave it pointing at nothing.',
        [edge.from],
      )
    }
    if (edge.required === true) {
      // Retargeted, not removed: the referring type cannot load without this key, so taking it
      // away would break a file the author did not ask about. The reference STRING is what moves
      // -- not the entry -- because the entry is staying exactly where it is, wearing a name that
      // means "not decided yet".
      //
      // Held to the same path cross-check a rename is held to, and for the identical reason: a
      // path whose list index disagrees with the delegation's own ordinal addresses somebody
      // else's slot, and writing the placeholder through it would resolve, so nothing would ever
      // report it.
      const path = referencePath(edge)
      if (path === null) return { ok: false, refusal: pathShapeRefusal(edge) }
      operations.push(setOperation(file, path, PLACEHOLDER_FEATURE))
      retargeted.push({ nodeId: edge.from, file, path })
      continue
    }
    const key = `${edge.from}\u0000${edge.kind}`
    if (NON_EMPTY_LIST_KINDS.has(edge.kind) && (removedPerList.get(key) ?? 0) >= (totalPerList.get(key) ?? 0)) {
      return refuse(
        'would-empty-list',
        `every entry of ${edge.from}'s list in ${file} delegates to "${node.id}", and the engine refuses to load that list ` +
          'empty. Give it something else to place first.',
        [edge.from, node.id],
      )
    }
    const path = detachPath(edge)
    if (path === null) return { ok: false, refusal: pathShapeRefusal(edge) }
    operations.push({ op: 'delete', file, path })
  }
  operations.push({ op: 'deleteFile', file: node.file!, identifier: node.id })

  const notes: PlanNote[] = []
  const orphaned = orphanedBy(graph, node.id)
  if (orphaned.length > 0) {
    notes.push({
      level: 'warning',
      message:
        `${orphaned.join(', ')} ${orphaned.length === 1 ? 'is' : 'are'} placed by nothing else in this pack, so ` +
        `${orphaned.length === 1 ? 'it stops' : 'they stop'} being generated. The file${orphaned.length === 1 ? '' : 's'} ` +
        'stay where they are.',
    })
  }
  const removedCount = inbound.length - retargeted.length
  if (removedCount > 0) {
    notes.push({
      level: 'warning',
      message: `${removedCount} delegation${removedCount === 1 ? '' : 's'} to "${node.id}" ${removedCount === 1 ? 'is' : 'are'} removed along with it.`,
    })
  }
  // Named rather than counted, and phrased as what to do next. These are the nodes somebody has
  // to come back to, and a count would leave them hunting for which.
  if (retargeted.length > 0) {
    const names = [...new Set(retargeted.map((slot) => slot.nodeId))]
    notes.push({
      level: 'warning',
      message:
        `${names.join(', ')} cannot load without something to place, so ${names.length === 1 ? 'its delegation is' : 'their delegations are'} ` +
        `pointed at ${PLACEHOLDER_FEATURE} instead of removed. ${names.length === 1 ? 'It keeps' : 'They keep'} loading, and ` +
        `${names.length === 1 ? 'says' : 'say'} "needs a feature" until you give ${names.length === 1 ? 'it' : 'them'} one.`,
    })
  }

  return {
    ok: true,
    plan: {
      action: 'delete-feature',
      title: `Delete ${node.id}`,
      summary: deleteSummary(node.file!, node.id, removedCount, retargeted.length),
      operations,
      files: planFiles(operations),
      subject: node.id,
      retargeted,
      notes,
      request: {
        method: 'deleteFeature',
        params: {
          id: node.id,
          detachReferences: detach,
          retarget: retargeted.map((slot) => ({ nodeId: slot.nodeId, path: slot.path })),
        },
      },
    },
  }
}

/** What the delete does, in one paragraph, split by the three things that can happen to the
 * delegations. Written as a function rather than a nested ternary because there are now three
 * cases and a sentence assembled out of fragments is the kind nobody proof-reads. */
function deleteSummary(file: string, id: string, removed: number, retargeted: number): string {
  if (removed === 0 && retargeted === 0) {
    return `${file} is removed. Nothing in this pack delegates to ${id}, so nothing is left pointing at it.`
  }
  const parts = [`${file} is removed.`]
  if (removed > 0) {
    parts.push(`${removed} delegation${removed === 1 ? '' : 's'} to ${id} ${removed === 1 ? 'goes' : 'go'} with it.`)
  }
  if (retargeted > 0) {
    parts.push(
      `${retargeted} delegation${retargeted === 1 ? '' : 's'} cannot be removed without stopping ${retargeted === 1 ? 'its' : 'their'} own file ` +
        `loading, so ${retargeted === 1 ? 'it is' : 'they are'} pointed at ${PLACEHOLDER_FEATURE} instead -- which the canvas draws as a node ` +
        'that needs a feature, rather than as a broken link.',
    )
  }
  parts.push('No file is left referring to a name nothing defines.')
  return parts.join(' ')
}

/** The default refusal, and most of the time the whole user-visible product of this module. It
 * NAMES the referrers rather than counting them, because the author's next move is to go and look
 * at each one. Capped, because sixty of them is a message nobody reads; the count stays exact. */
function referencedReason(graph: IdiomGraph, id: string, inbound: readonly IdiomGraphEdge[]): string {
  const SHOW = 6
  const listed = inbound.slice(0, SHOW).map((e) => {
    const file = nodeFile(graph, e.from)
    return file === undefined ? e.from : `${e.from} (${file} at ${e.jsonPath})`
  })
  if (inbound.length > SHOW) listed.push(`and ${inbound.length - SHOW} more`)
  return (
    `${inbound.length} thing${inbound.length === 1 ? '' : 's'} in this pack delegate to "${id}": ${listed.join(', ')}. ` +
    'Deleting it would leave those references pointing at nothing, in files you are not looking at. Retarget them yourself, or ' +
    'delete it anyway: each delegation is then either removed, or -- where its file cannot load without one -- pointed at a ' +
    'stand-in, and that node says it needs a feature until you pick one.'
  )
}

/** Every feature the node delegates to that nothing else delegates to, sorted. These are not
 * deleted -- an unreferenced feature is a legal pack and often the point of the deletion -- but
 * nothing places them afterwards, and that is not visible from the one file that vanished. */
function orphanedBy(graph: IdiomGraph, id: string): string[] {
  const inboundElsewhere = new Map<string, number>()
  for (const e of graph.edges) {
    if (e.from === id) continue
    inboundElsewhere.set(e.to, (inboundElsewhere.get(e.to) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const e of graph.edges) {
    if (e.from !== id || e.to === id) continue
    if ((inboundElsewhere.get(e.to) ?? 0) === 0) out.add(e.to)
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// What can I do with this selection?
// ---------------------------------------------------------------------------

export interface LifecycleOffer {
  readonly action: LifecycleAction
  /** Imperative, in the author's words rather than the schema's. */
  readonly label: string
  readonly detail: string
  readonly available: boolean
  /** Why not, when not. Short enough for a greyed-out menu item's tooltip. */
  readonly unavailable?: string
}

/** The menu, given whatever is selected -- so a renderer does not re-derive which operations make
 * sense, and so "this is greyed out" always comes with a reason.
 *
 * These are cheap structural probes, not dry runs: a rename needs a name the author has not typed
 * yet, so no plan can be built to decide whether to offer the field that asks for it. Deleting is
 * offered even when the feature is referenced, because being told which six files to look at IS
 * the useful answer -- the refusal is where that list comes from. */
export function lifecycleOffers(graph: IdiomGraph, selection: readonly string[]): LifecycleOffer[] {
  const single = selection.length === 1 ? findNode(graph, selection[0]!) : undefined
  const usable = single !== undefined && single.unresolved !== true && single.file !== undefined && single.file !== ''
  const why =
    selection.length === 0
      ? 'select one feature.'
      : selection.length > 1
        ? 'select exactly one feature.'
        : single === undefined
          ? 'that feature is not in this graph.'
          : single.unresolved === true
            ? 'that reference resolves to nothing -- no file defines it, so there is nothing to rename or remove.'
            : 'that feature does not report a file.'

  const referenced = usable ? referrers(graph, single.id).length : 0
  return [
    {
      action: 'rename-feature',
      label: 'Rename...',
      detail:
        referenced === 0
          ? 'Changes the identifier in this file. Nothing else in the pack refers to it.'
          : `Changes the identifier here and in the ${referenced} place${referenced === 1 ? '' : 's'} that delegate to it. The file keeps its name.`,
      available: usable,
      ...(usable ? {} : { unavailable: why }),
    },
    {
      action: 'delete-feature',
      label: 'Delete...',
      detail:
        referenced === 0
          ? 'Removes this file. Nothing delegates to it, so nothing is left pointing at a name that no longer exists.'
          : `${referenced} thing${referenced === 1 ? '' : 's'} delegate to this. You will be shown which, and asked before any of them are changed -- ` +
            'and anything that cannot load without this is pointed at a stand-in rather than broken.',
      available: usable,
      ...(usable ? {} : { unavailable: why }),
    },
  ]
}
