// collapse.ts -- the COLLAPSE/EXPAND host for compound feature nodes.
//
// spec.ts says what a compound IS. This says how one is SHOWN, which nodes it
// owns, when it stops being one, and what an edit to it costs. It writes
// nothing: every answer is a description a caller hands to the Go side, where
// jsonc.Apply splices it in. Same split, and for the same reason, as idioms.ts.
//
// ===========================================================================
// IDENTITY: WHICH NODES BELONG TO A COMPOUND
// ===========================================================================
//
// A compound owns exactly the ids ITS OWN RE-EXPANSION CREATES -- run
// `CompoundSpec.expand` on the recorded parameters and read `creates`.
//
// That is the only sound answer available, and it is sound for the reason the
// whole design rests on: the parameters are the source and the subgraph is
// derived, so the set of generated ids is a pure function of (identifier,
// parameters) computed by the SAME generator that wrote the files. It is the
// generator's own answer, not an observer's reconstruction.
//
// CHILD_ROLES is not used, and spec.ts is right that it must not be. Matching
// `<parent>__<role>_<n>` fails in both directions: it captures a hand-written
// feature that happens to be named that way, and it captures nothing at all
// for a compound whose generated ids were renamed by hand. Either way the
// editor would hide a node the author never grouped, which is the exact
// failure spec.ts rules out.
//
// `creates` also draws the line that matters and costs nothing: a compound's
// `places` targets are the author's OWN features. They are delegated to, but
// they are not created, so they never appear in `creates` and are never
// swallowed into the collapsed node.
//
// WHAT THIS COSTS, AND THE ONE CASE IT CANNOT COVER. Children are known only
// when the annotation parses, a spec for the kind is registered, and `expand`
// succeeds. Short of that the children are unknown, so nothing is hidden and
// the raw subgraph is shown -- there is no fallback, by design.
//
// And ORPHANS ARE NOT DETECTABLE ACROSS A REOPEN. If someone hand-edits the
// annotation's parameters in a text editor, the files the OLD parameters
// produced are still on disk and nothing distinguishes them from ordinary
// features: no generated file records which compound wrote it. Inside one
// session the parameter-edit path does know, because the old parameters are
// still the recorded ones (see planParameterEdit); across a reopen the
// knowledge is gone. Closing that hole needs one directive on each generated
// file -- `@featurelab:idiom-child <parent-identifier>` -- which the contract
// does not have and which jsonc.InsertAnnotation could write as it stands,
// since an identifier has no spaces. It is NOT closed here by guessing at
// names.
//
// ===========================================================================
// TWO THINGS THE CONTRACT ASKS FOR AND CANNOT EXPRESS
// ===========================================================================
//
// Both were found by reading the write side rather than assuming it, and both
// are REFUSED here rather than worked around. See ContractGap.
//
// 1. THE ANNOTATION CANNOT BE WRITTEN THROUGH A PlanOperation.
//
//    `PlanOperation` is createFile / set / delete, and idioms.ts says those
//    "map onto exactly what the write side already has": jsonc.Edit is
//    {Path, Value, Delete}, addressed at a member or an element. A COMMENT has
//    no path, so no plan operation can touch one.
//
//    Nor does the byte span help as much as it looks. jsonc/annotations.go:
//    "Offset and EndOffset bound the directive TEXT: the '@' through the last
//    argument, with the comment markers, the indentation before them and any
//    following free text all outside the span", and the replacement "may not
//    contain a line ending". The compound's PARAMETERS live in exactly that
//    following free text -- `Annotation.Text` -- and no span for it is
//    recorded anywhere. So:
//
//      - Re-recording parameters after a field edit has no address at all.
//      - An eject can blank the directive through the span, but leaves an
//        empty `//` line AND the whole parameter line behind as prose.
//      - jsonc.InsertAnnotation writes `@featurelab:<name> <args...>` and no
//        Text, and rejects an argument containing a space -- so the parameter
//        JSON cannot be smuggled in as an argument either.
//
//    The recording mechanism spec.ts describes is, today, READ-ONLY. This
//    module therefore emits a fully specified `AnnotationChange` and marks the
//    plan `applyable: false`, instead of inventing a fourth PlanOperation.
//
// 2. THERE IS NO OPERATION THAT DELETES A FILE.
//
//    spec.ts's CompoundExpansion doc says a re-expansion comes out as
//    createFile operations "plus ... the `delete` of any child the new
//    parameters no longer produce". But every generated child is its own file
//    (spec.ts says so in the same sentence) and `delete` is
//    {op:'delete', file, path} -- a jsonc.Edit that removes a member from a
//    file that stays. Deleting `$["minecraft:scatter_feature"]` would leave a
//    file holding only a format_version, which is not a deletion but a broken
//    feature. So orphaned children come back as DATA (`orphans`) with a
//    warning note, and no operation is fabricated for them.
//
// A third, smaller one, recorded because it will bite whoever wires the
// annotation up: GraphEdge.JSONPath is rooted at the feature BODY
// (wire/graphbuild.go builds `$.places_feature`, `$.features[0]`) while
// Annotation.JSONPath is rooted at the FILE (`$` is the file root, which is
// why spec.ts can put the compound directive there). wire/graph.go says the
// two are "matched by string equality"; for a feature file they are in
// different coordinate systems and never will be.

import {
  COMPOUND_DIRECTIVE,
  decodeCompoundParams,
  encodeCompoundParams,
  isCompoundKind,
  type CompoundAnnotation,
  type CompoundExpansion,
  type CompoundKind,
  type CompoundSpec,
} from './spec'
import {
  isIndexSegment,
  parseJsonPath,
  type IdiomGraphEdge,
  type IdiomGraphNode,
  type PlanNote,
  type PlanOperation,
  type Refusal,
} from '../idioms'

// ---------------------------------------------------------------------------
// Graph input
// ---------------------------------------------------------------------------

/**
 * One `@featurelab:` directive, as `wire.Annotation` reports it.
 *
 * idioms.ts's `IdiomGraphNode` does not carry annotations -- it has no use for
 * them -- so this is the one field added on top of it. Everything else is
 * reused rather than restated, so a decoded `wire.Graph` is assignable to both.
 */
export interface CollapseAnnotation {
  readonly name: string
  readonly args?: readonly string[] | undefined
  readonly text?: string | undefined
  readonly jsonPath: string
  readonly line?: number | undefined
  /** The DIRECTIVE's byte span. Excludes the comment markers and `text`. */
  readonly offset?: number | undefined
  readonly endOffset?: number | undefined
}

export interface CollapseNode extends IdiomGraphNode {
  readonly annotations?: readonly CollapseAnnotation[] | undefined
}

export type CollapseEdge = IdiomGraphEdge

/**
 * Deliberately more tolerant than `IdiomGraph`: `wire.Graph`'s slices marshal
 * to `null` when empty, and a view builder that threw on an empty pack would
 * be a view builder nobody could open a new pack in.
 */
export interface CollapseGraph {
  readonly nodes?: readonly CollapseNode[] | undefined
  readonly edges?: readonly CollapseEdge[] | undefined
}

/**
 * The specs available to this host, by kind -- A PARAMETER, never a
 * module-level table. The four compound modules are written by other hands,
 * and a host that imported them could not be tested without them.
 *
 * `CompoundSpec<unknown>` accepts a `CompoundSpec<LoopParams>` without a cast
 * because spec.ts declares `validate`/`expand` with method syntax, which stays
 * bivariant under `strictFunctionTypes`.
 */
export type CompoundRegistry = { readonly [K in CompoundKind]?: CompoundSpec<unknown> }

// ---------------------------------------------------------------------------
// Contract gaps
// ---------------------------------------------------------------------------

export type ContractGap =
  /**
   * The parameters live in `Annotation.Text`, which has no recorded span and
   * no PlanOperation that can address it.
   */
  | 'annotation-body-has-no-span'
  /**
   * `PlanOperation` has no file deletion, so a child the new parameters no
   * longer produce cannot be removed by a plan.
   */
  | 'no-file-delete-operation'

export interface ContractGapNote {
  readonly gap: ContractGap
  readonly message: string
}

const GAP_ANNOTATION: ContractGapNote = {
  gap: 'annotation-body-has-no-span',
  message:
    'The compound parameters live in the annotation\'s free text, which wire.Annotation gives no byte span for and ' +
    'jsonc.Edit cannot address -- a comment has no JSON path. This change is fully described below but no PlanOperation ' +
    'can carry it, so applying the operations alone would leave the recorded parameters disagreeing with the subgraph.',
}

const GAP_DELETE: ContractGapNote = {
  gap: 'no-file-delete-operation',
  message:
    'Each generated child is its own file and PlanOperation has no file deletion -- its `delete` removes a member from ' +
    'a file that stays. The orphaned children are listed rather than deleted.',
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type DriftKind =
  /** The kind is a real compound kind and no spec for it is registered. */
  | 'unknown-kind'
  /** The spec rejected the recorded parameters, or threw on them. */
  | 'invalid-params'
  /** The spec refused to re-expand the recorded parameters, or threw. */
  | 'expansion-refused'
  /** Re-expansion produces this id and the graph has no node for it. */
  | 'missing-child'
  /** Re-expansion produces this id and the node is a dangling reference. */
  | 'unresolved-child'
  /** An earlier compound already produces this id. */
  | 'contested-child'
  /** Re-expansion produces this id and it carries its own annotation. */
  | 'child-is-compound'
  /** The file holds a different value for this key than re-expansion writes. */
  | 'field-changed'
  /** Re-expansion writes this key and the file does not have it. */
  | 'field-missing'
  /** The file holds a key re-expansion does not write. */
  | 'field-added'

export interface DriftFinding {
  readonly what: DriftKind
  /** The node this is about; the compound root for kind-level findings. */
  readonly identifier: string
  /** The compound whose re-expansion produced it. */
  readonly compound: string
  readonly key?: string
  readonly ownedBy?: string
  readonly refusal?: Refusal
  /** A whole sentence, addressed to the author. */
  readonly message: string
}

/** Why a node carrying an annotation is nonetheless shown raw. */
export type DegradeReason =
  /** The directive did not carry exactly one argument. */
  | 'malformed-directive'
  /** The parameter body was absent, not JSON, or not a JSON object. */
  | 'malformed-params'
  /** Two compound directives on one file. Neither is believed. */
  | 'ambiguous-annotation'
  /** A compound directive somewhere other than the file root. */
  | 'annotation-not-at-root'

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface ChildRef {
  readonly identifier: string
  readonly file?: string
  /** False when re-expansion names an id the graph does not have. */
  readonly present: boolean
  /**
   * Something OUTSIDE this compound delegates to this child.
   *
   * Generated ids are namespaced under the parent so this is rare, but hiding
   * such a node strands a real edge, and a renderer that is not told will draw
   * an edge into nothing.
   */
  readonly borrowed: boolean
}

interface NodeViewBase {
  readonly identifier: string
  /** The node's own JSON body. DISPLAY ONLY -- never a compound's form. */
  readonly fields: Readonly<Record<string, unknown>>
}

export interface PlainNodeView extends NodeViewBase {
  readonly presentation: 'plain'
  /**
   * Set when the node DID carry a compound directive that could not be
   * believed. A malformed annotation degrades to the raw subgraph exactly as a
   * missing one does -- but not silently: this is here so the UI can say why.
   */
  readonly degraded?: DegradeReason
}

export interface GeneratedChildView extends NodeViewBase {
  readonly presentation: 'child'
  readonly parent: string
  /** True while the owning compound is collapsed. */
  readonly hidden: boolean
  readonly borrowed: boolean
}

interface CompoundViewBase extends NodeViewBase {
  readonly kind: CompoundKind
  /** From the spec. Empty when no spec is registered. */
  readonly title: string
  readonly summary: string
  readonly annotation: CompoundAnnotation
  readonly site: AnnotationSite | null
  /**
   * THE FORM. The parameters as the spec validated them -- what a collapsed
   * node's fields are rendered from. Never `fields`, which is generated output.
   * Null when no spec accepted them.
   *
   * It is the parameter OBJECT and not a row list because `CompoundSpec` has
   * no field schema: `title`, `summary`, `validate`, `expand` and nothing
   * else. forms.ts's generic renderer is driven by typeCatalog's FieldSpecs
   * and has nothing to work from here, so a compound form needs per-kind
   * knowledge in the renderer. That is a gap in spec.ts, not a choice here.
   */
  readonly formParams: unknown
  /** The parameters exactly as recorded, before validation. */
  readonly rawParams: unknown
  readonly children: readonly ChildRef[]
  readonly childIds: readonly string[]
  /** The re-expansion this view was checked against. Null when it refused. */
  readonly expansion: CompoundExpansion | null
  readonly formatVersion: string
  /** False when the children are unknown, so there is nothing safe to hide. */
  readonly collapsible: boolean
  readonly expanded: boolean
}

export interface CollapsedCompoundView extends CompoundViewBase {
  readonly presentation: 'compound'
  readonly drift: readonly DriftFinding[]
}

export interface DriftedCompoundView extends CompoundViewBase {
  readonly presentation: 'drifted'
  /**
   * Never empty. The annotation is neither dropped nor trusted: both readings
   * stay available, because which one wins is the command layer's decision.
   */
  readonly drift: readonly DriftFinding[]
}

export type CompoundNodeView = CollapsedCompoundView | DriftedCompoundView
export type NodeView = PlainNodeView | GeneratedChildView | CompoundNodeView

export interface CompoundView {
  /** One entry per graph node, in graph order. */
  readonly nodes: readonly NodeView[]
  readonly byId: ReadonlyMap<string, NodeView>
  /** Compound roots in graph order, drifted ones included. */
  readonly compounds: readonly CompoundNodeView[]
  /** Children of collapsed compounds: draw neither them nor their edges. */
  readonly hiddenNodeIds: readonly string[]
  /** Every finding, compound by compound in graph order. */
  readonly drift: readonly DriftFinding[]
}

export interface BuildCompoundViewInput {
  readonly graph: CollapseGraph
  readonly registry: CompoundRegistry
  /** Ids the user has expanded. Everything else renders collapsed. */
  readonly expanded?: Iterable<string> | undefined
  /** Used when a node does not declare one. */
  readonly formatVersion?: string | undefined
}

// ---------------------------------------------------------------------------
// Reading the annotation
// ---------------------------------------------------------------------------

export type AnnotationRead =
  | { readonly status: 'none' }
  | { readonly status: 'degraded'; readonly reason: DegradeReason }
  | {
      readonly status: 'ok'
      readonly kind: CompoundKind
      readonly params: unknown
      readonly annotation: CollapseAnnotation
    }

/** `$` per spec.ts. ParseAnnotations falls back to `$` when a file does not scan. */
function isRootPath(path: string): boolean {
  // `$` is accepted for a file whose directive really is at the document root, and so is a
  // single top-level key -- which is where it actually lands.
  //
  // This used to accept only `$`, following an earlier version of the contract that said the
  // directive sits at the top of the file. Measuring what the graph builder reported showed
  // that is not what happens: a directive attaches to the member that FOLLOWS it, so at the top
  // of the file it describes `format_version`, the string. The contract was corrected to put it
  // directly above the type key, where it reports `$.minecraft:scatter_feature` -- the body
  // key, and the same root every edge JSONPath in that file starts from.
  //
  // The check stayed behind, so every compound written under the corrected rule was read back
  // as "not at root" and silently refused to collapse. Nothing failed: an unrecognised
  // annotation is indistinguishable from a pack that never had one.
  if (path === '$') return true
  const segments = path.startsWith('$.') ? path.slice(2) : ''
  // One segment only. A deeper path is an annotation about something INSIDE the feature, which
  // is a different thing from one about the feature.
  return segments !== '' && !segments.includes('.') && !segments.includes('[')
}

/**
 * Finds the compound directive on a node, or says why there is not one.
 *
 * `idiom` is a SHARED directive name -- wire/graph.go's own example is
 * `@featurelab:idiom setup-script`, which is not a compound. Those belong to
 * something else and are passed over in silence rather than called malformed.
 *
 * The directive NAME is matched case-insensitively, following graphcheck.go's
 * `suppressedByIgnore`; the kind argument is matched exactly, because it is
 * data rather than spelling.
 */
export function readCompoundAnnotation(node: CollapseNode): AnnotationRead {
  const compoundish: CollapseAnnotation[] = []
  for (const annotation of node.annotations ?? []) {
    if (annotation.name.toLowerCase() !== COMPOUND_DIRECTIVE) continue
    const args = annotation.args ?? []
    const first = args.length === 0 ? undefined : args[0]
    if (first === undefined || !isCompoundKind(first)) continue
    compoundish.push(annotation)
  }
  if (compoundish.length === 0) return { status: 'none' }
  if (compoundish.length > 1) return { status: 'degraded', reason: 'ambiguous-annotation' }

  const annotation = compoundish[0] as CollapseAnnotation
  if (!isRootPath(annotation.jsonPath)) return { status: 'degraded', reason: 'annotation-not-at-root' }

  const args = annotation.args ?? []
  if (args.length !== 1) return { status: 'degraded', reason: 'malformed-directive' }
  const kind = args[0] as string
  if (!isCompoundKind(kind)) return { status: 'degraded', reason: 'malformed-directive' }

  const params = decodeCompoundParams(annotation.text ?? '')
  if (params === null) return { status: 'degraded', reason: 'malformed-params' }
  return { status: 'ok', kind, params, annotation }
}

// ---------------------------------------------------------------------------
// Building the view
// ---------------------------------------------------------------------------

interface Candidate {
  readonly node: CollapseNode
  readonly kind: CompoundKind
  readonly rawParams: unknown
  readonly annotation: CollapseAnnotation
  readonly spec: CompoundSpec<unknown> | undefined
  formParams: unknown
  expansion: CompoundExpansion | null
  readonly findings: DriftFinding[]
}

function finding(
  what: DriftKind,
  compound: string,
  identifier: string,
  message: string,
  extra?: { readonly key?: string; readonly ownedBy?: string; readonly refusal?: Refusal },
): DriftFinding {
  return {
    what,
    identifier,
    compound,
    message,
    ...(extra?.key === undefined ? {} : { key: extra.key }),
    ...(extra?.ownedBy === undefined ? {} : { ownedBy: extra.ownedBy }),
    ...(extra?.refusal === undefined ? {} : { refusal: extra.refusal }),
  }
}

/**
 * Classifies every node in the graph.
 *
 * PURE AND TOTAL. The same graph gives the same views in the same order; it
 * never throws, not even when a registered spec does; and it never infers a
 * compound that is not written down.
 */
export function buildCompoundView(input: BuildCompoundViewInput): CompoundView {
  const nodes = input.graph.nodes ?? []
  const edges = input.graph.edges ?? []
  const expandedIds = new Set<string>(input.expanded ?? [])

  const byId = new Map<string, CollapseNode>()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)

  const outEdges = new Map<string, CollapseEdge[]>()
  const inEdges = new Map<string, CollapseEdge[]>()
  for (const edge of edges) {
    const out = outEdges.get(edge.from)
    if (out === undefined) outEdges.set(edge.from, [edge])
    else out.push(edge)
    const into = inEdges.get(edge.to)
    if (into === undefined) inEdges.set(edge.to, [edge])
    else into.push(edge)
  }

  // Pass 1 -- read the annotations, and re-expand every compound we can.
  const degraded = new Map<string, DegradeReason>()
  const candidates: Candidate[] = []
  const candidateIds = new Set<string>()
  for (const node of nodes) {
    const read = readCompoundAnnotation(node)
    if (read.status === 'none') continue
    if (read.status === 'degraded') {
      degraded.set(node.id, read.reason)
      continue
    }
    const spec = input.registry[read.kind]
    const candidate: Candidate = {
      node,
      kind: read.kind,
      rawParams: read.params,
      annotation: read.annotation,
      spec,
      formParams: null,
      expansion: null,
      findings: [],
    }
    candidates.push(candidate)
    candidateIds.add(node.id)

    if (spec === undefined) {
      candidate.findings.push(
        finding(
          'unknown-kind',
          node.id,
          node.id,
          `No spec is registered for the '${read.kind}' compound, so its subgraph cannot be reproduced and its ` +
            `machinery is shown as written.`,
        ),
      )
      continue
    }

    const validated = callValidate(spec, read.params)
    if (validated.thrown) {
      candidate.findings.push(
        finding('invalid-params', node.id, node.id, `The '${read.kind}' spec threw while validating the recorded parameters.`),
      )
      continue
    }
    if (!validated.result.ok) {
      candidate.findings.push(
        finding('invalid-params', node.id, node.id, `The '${read.kind}' spec rejected the recorded parameters.`, {
          refusal: validated.result.refusal,
        }),
      )
      continue
    }
    candidate.formParams = validated.result.params

    const formatVersion = node.formatVersion ?? input.formatVersion ?? ''
    const expanded = callExpand(spec, node.id, validated.result.params, formatVersion)
    if (expanded.thrown) {
      candidate.findings.push(
        finding('expansion-refused', node.id, node.id, `The '${read.kind}' spec threw while re-expanding the recorded parameters.`),
      )
      continue
    }
    if (!expanded.result.ok) {
      candidate.findings.push(
        finding('expansion-refused', node.id, node.id, `The '${read.kind}' spec refused to re-expand the recorded parameters.`, {
          refusal: expanded.result.refusal,
        }),
      )
      continue
    }
    candidate.expansion = expanded.result.expansion
  }

  // Pass 2 -- identity. A compound owns exactly what its own re-expansion
  // creates. See the module header.
  const ownerOf = new Map<string, string>()
  const childrenOf = new Map<string, ChildRef[]>()
  for (const candidate of candidates) {
    const owned: ChildRef[] = []
    childrenOf.set(candidate.node.id, owned)
    if (candidate.expansion === null) continue
    for (const created of candidate.expansion.creates) {
      if (created === candidate.node.id) continue
      const existing = ownerOf.get(created)
      if (existing !== undefined) {
        candidate.findings.push(
          finding('contested-child', candidate.node.id, created, `'${created}' is already produced by '${existing}'.`, {
            ownedBy: existing,
          }),
        )
        continue
      }
      if (candidateIds.has(created)) {
        candidate.findings.push(
          finding(
            'child-is-compound',
            candidate.node.id,
            created,
            `'${created}' carries its own compound annotation, so it is not folded into '${candidate.node.id}'.`,
          ),
        )
        continue
      }
      const child = byId.get(created)
      if (child === undefined) {
        candidate.findings.push(
          finding('missing-child', candidate.node.id, created, `Re-expansion produces '${created}' and the graph has no such node.`),
        )
        owned.push({ identifier: created, present: false, borrowed: false })
        ownerOf.set(created, candidate.node.id)
        continue
      }
      if (child.unresolved === true) {
        candidate.findings.push(
          finding('unresolved-child', candidate.node.id, created, `'${created}' is a dangling reference rather than a feature file.`),
        )
      }
      owned.push({
        identifier: created,
        ...(child.file === undefined ? {} : { file: child.file }),
        present: true,
        borrowed: false,
      })
      ownerOf.set(created, candidate.node.id)
    }
  }

  // Borrowed children: an in-edge from outside the compound's own family.
  for (const candidate of candidates) {
    const owned = childrenOf.get(candidate.node.id) ?? []
    const family = new Set<string>([candidate.node.id])
    for (const child of owned) family.add(child.identifier)
    for (let i = 0; i < owned.length; i += 1) {
      const child = owned[i] as ChildRef
      const incoming = inEdges.get(child.identifier) ?? []
      if (incoming.some((edge) => !family.has(edge.from))) owned[i] = { ...child, borrowed: true }
    }
  }

  // Pass 3 -- body drift.
  for (const candidate of candidates) {
    if (candidate.expansion === null) continue
    for (const operation of candidate.expansion.operations) {
      if (operation.op !== 'createFile') continue
      if (operation.identifier !== candidate.node.id && ownerOf.get(operation.identifier) !== candidate.node.id) continue
      const node = byId.get(operation.identifier)
      if (node === undefined || node.unresolved === true) continue
      const expected = featureBodyOf(operation.contents, operation.typeId)
      if (expected === null) continue
      compareBody(candidate, node, expected, outEdges.get(node.id) ?? [])
    }
  }

  // Pass 4 -- assemble, in graph order.
  const candidateById = new Map<string, Candidate>()
  for (const candidate of candidates) candidateById.set(candidate.node.id, candidate)

  const views: NodeView[] = []
  const viewById = new Map<string, NodeView>()
  const compounds: CompoundNodeView[] = []
  const hiddenNodeIds: string[] = []
  const drift: DriftFinding[] = []

  for (const node of nodes) {
    const fields = node.fields ?? {}
    const candidate = candidateById.get(node.id)
    if (candidate !== undefined) {
      const children = childrenOf.get(node.id) ?? []
      const base: CompoundViewBase = {
        identifier: node.id,
        fields,
        kind: candidate.kind,
        title: candidate.spec?.title ?? '',
        summary: candidate.spec?.summary ?? '',
        annotation: { kind: candidate.kind, params: candidate.rawParams },
        site: annotationSite(node, candidate.annotation),
        formParams: candidate.formParams,
        rawParams: candidate.rawParams,
        children,
        childIds: children.map((child) => child.identifier),
        expansion: candidate.expansion,
        formatVersion: node.formatVersion ?? input.formatVersion ?? '',
        collapsible: candidate.expansion !== null,
        expanded: expandedIds.has(node.id),
      }
      const view: CompoundNodeView =
        candidate.findings.length === 0
          ? { ...base, presentation: 'compound', drift: [] }
          : { ...base, presentation: 'drifted', drift: candidate.findings }
      views.push(view)
      viewById.set(node.id, view)
      compounds.push(view)
      for (const each of candidate.findings) drift.push(each)
      continue
    }

    const owner = ownerOf.get(node.id)
    if (owner !== undefined) {
      const ownerCandidate = candidateById.get(owner)
      const ref = (childrenOf.get(owner) ?? []).find((child) => child.identifier === node.id)
      const collapsed = ownerCandidate !== undefined && ownerCandidate.expansion !== null && !expandedIds.has(owner)
      const view: GeneratedChildView = {
        identifier: node.id,
        fields,
        presentation: 'child',
        parent: owner,
        hidden: collapsed,
        borrowed: ref?.borrowed ?? false,
      }
      views.push(view)
      viewById.set(node.id, view)
      if (collapsed) hiddenNodeIds.push(node.id)
      continue
    }

    const reason = degraded.get(node.id)
    const view: PlainNodeView = {
      identifier: node.id,
      fields,
      presentation: 'plain',
      ...(reason === undefined ? {} : { degraded: reason }),
    }
    views.push(view)
    viewById.set(node.id, view)
  }

  return { nodes: views, byId: viewById, compounds, hiddenNodeIds, drift }
}

/** The compound's file and its directive span, forwarded verbatim. */
export interface AnnotationSite {
  readonly identifier: string
  readonly file: string
  readonly annotation: CollapseAnnotation
}

function annotationSite(node: CollapseNode, annotation: CollapseAnnotation): AnnotationSite | null {
  if (node.file === undefined || node.file === '') return null
  return { identifier: node.id, file: node.file, annotation }
}

function callValidate(
  spec: CompoundSpec<unknown>,
  params: unknown,
): { readonly thrown: true } | { readonly thrown: false; readonly result: ReturnType<CompoundSpec<unknown>['validate']> } {
  try {
    return { thrown: false, result: spec.validate(params) }
  } catch {
    return { thrown: true }
  }
}

function callExpand(
  spec: CompoundSpec<unknown>,
  identifier: string,
  params: unknown,
  formatVersion: string,
): { readonly thrown: true } | { readonly thrown: false; readonly result: ReturnType<CompoundSpec<unknown>['expand']> } {
  try {
    return { thrown: false, result: spec.expand(identifier, params, formatVersion) }
  } catch {
    return { thrown: true }
  }
}

// ---------------------------------------------------------------------------
// Body comparison
// ---------------------------------------------------------------------------

/**
 * jsonc.StripComments, ported -- comment bytes become spaces, nothing moves.
 *
 * Ported rather than approximated for the reason idioms.ts ports FormatPath:
 * a generated file may legally carry the compound's own directive, so the
 * bytes `expand` produced have to be read the way the engine reads them, and a
 * permissive JSONC library would accept files the game does not.
 */
function stripComments(src: string): string {
  const out = src.split('')
  const n = out.length
  let inString = false
  let escaped = false
  let i = 0
  while (i < n) {
    const c = out[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      i += 1
      continue
    }
    if (c === '"') {
      inString = true
      i += 1
      continue
    }
    if (c === '/' && i + 1 < n && out[i + 1] === '/') {
      let j = i
      while (j < n && out[j] !== '\n' && out[j] !== '\r') {
        out[j] = ' '
        j += 1
      }
      i = j
      continue
    }
    if (c === '/' && i + 1 < n && out[i + 1] === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      let j = i + 2
      while (j < n) {
        if (out[j] === '*' && j + 1 < n && out[j + 1] === '/') {
          out[j] = ' '
          out[j + 1] = ' '
          j += 2
          break
        }
        if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' '
        j += 1
      }
      i = j
      continue
    }
    i += 1
  }
  return out.join('')
}

/**
 * The feature BODY inside a generated file -- `contents[typeId]`.
 *
 * `GraphNode.Fields` is the body minus delegation keys (wire/graphbuild.go's
 * graphFields), not the file, so this is the level the two can be compared at.
 * Anything that does not read cleanly returns null and is not compared, which
 * is the conservative direction.
 */
function featureBodyOf(contents: string, typeId: string): Readonly<Record<string, unknown>> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripComments(contents))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const body = (parsed as Record<string, unknown>)[typeId]
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Readonly<Record<string, unknown>>
}

/**
 * Compares one intended feature body against the node the graph actually holds.
 *
 * CONSERVATIVE BY CONSTRUCTION, and that direction is chosen deliberately. A
 * key the intended body writes may be absent from `Fields` simply because the
 * builder lifted it into an edge, so any key an out-edge's JSONPath starts at
 * is skipped rather than guessed at -- reconstructing it would mean inverting
 * the builder per feature type, which is the inference this project rejected.
 *
 * Everything unsure therefore degrades to "no drift", never to "drift". A
 * warning that fires when nothing drifted is worse than one that stays quiet,
 * because the first teaches people to stop reading the banner -- which is the
 * same argument spec.ts makes about the placement-guard probe.
 */
function compareBody(
  candidate: Candidate,
  node: CollapseNode,
  expected: Readonly<Record<string, unknown>>,
  out: readonly CollapseEdge[],
): void {
  const actual = node.fields ?? {}
  const lifted = new Set<string>()
  for (const edge of out) {
    const head = firstPathKey(edge.jsonPath)
    if (head !== null) lifted.add(head)
  }

  for (const key of sortedKeys(expected)) {
    if (Object.prototype.hasOwnProperty.call(actual, key)) {
      if (!deepEqual(expected[key], actual[key])) {
        candidate.findings.push(
          finding(
            'field-changed',
            candidate.node.id,
            node.id,
            `'${node.id}' has a different '${key}' than the recorded parameters produce.`,
            { key },
          ),
        )
      }
      continue
    }
    if (lifted.has(key)) continue
    candidate.findings.push(
      finding('field-missing', candidate.node.id, node.id, `'${node.id}' is missing '${key}', which the recorded parameters produce.`, {
        key,
      }),
    )
  }

  for (const key of sortedKeys(actual)) {
    if (Object.prototype.hasOwnProperty.call(expected, key)) continue
    if (lifted.has(key)) continue
    candidate.findings.push(
      finding('field-added', candidate.node.id, node.id, `'${node.id}' has '${key}', which the recorded parameters do not produce.`, {
        key,
      }),
    )
  }
}

/**
 * The top-level body key an edge path starts at, or null.
 *
 * Through idioms.ts's `parseJsonPath`, which is jsonc.ParsePath ported -- the
 * dialect is pinned precisely so nobody hand-splits it on '.', and a pack is
 * free to name a member `a.b`.
 */
function firstPathKey(path: string): string | null {
  const segments = parseJsonPath(path)
  if (segments === null || segments.length === 0) return null
  const first = segments[0] as { readonly key: string } | { readonly index: number }
  return isIndexSegment(first) ? null : first.key
}

function sortedKeys(value: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Total: the depth cap keeps a cyclic object from becoming a thrown error. */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (depth > 64) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArray = Array.isArray(a)
  if (aArray !== Array.isArray(b)) return false
  if (aArray) {
    const x = a as readonly unknown[]
    const y = b as readonly unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i += 1) if (!deepEqual(x[i], y[i], depth + 1)) return false
    return true
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  if (keys.length !== Object.keys(y).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(y, key)) return false
    if (!deepEqual(x[key], y[key], depth + 1)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// The eject rule
// ---------------------------------------------------------------------------

export type EditTarget =
  /** The collapsed node's own form. */
  | { readonly what: 'compound-fields'; readonly identifier: string }
  /** A node's JSON -- its fields or its delegations. */
  | { readonly what: 'node-body'; readonly identifier: string }
  /** A drag on the canvas. */
  | { readonly what: 'canvas-position'; readonly identifier: string }

export type EditConsequence =
  /** Re-expand and stay collapsed. */
  | {
      readonly effect: 'regenerate'
      readonly identifier: string
      readonly kind: CompoundKind
      /**
       * The subgraph on disk ALREADY disagrees with the parameters, so
       * re-expanding overwrites whatever was hand-edited. Which way that goes
       * is the command layer's call; this refuses to make it silently.
       */
      readonly overwritesDrift: boolean
      readonly drift: readonly DriftFinding[]
    }
  /** One-way: the annotation goes. */
  | { readonly effect: 'eject'; readonly identifier: string; readonly kind: CompoundKind; readonly warning: EjectWarning }
  /** Layout lives in the sidecar. Not an edit, no plan, no warning. */
  | { readonly effect: 'none'; readonly identifier: string; readonly why: 'layout-is-not-an-edit' }
  /** An ordinary node edited ordinarily. */
  | { readonly effect: 'plain'; readonly identifier: string }
  | { readonly effect: 'unknown'; readonly identifier: string }

/**
 * What the UI must say BEFORE the first keystroke lands.
 *
 * spec.ts: "warned before the first change, and never reversible". Afterwards
 * is no use -- the parameters are gone by then, and re-deriving them from the
 * subgraph is precisely the shape-recognition the project ruled out.
 */
export interface EjectWarning {
  readonly identifier: string
  readonly kind: CompoundKind
  readonly title: string
  readonly oneWay: true
  /** Exactly what stops being editable as a form. */
  readonly losesParams: unknown
  /** The root and every generated child, all becoming ordinary nodes. */
  readonly nodesBecomingPlain: readonly string[]
  readonly reason: string
}

function compoundIn(view: CompoundView, identifier: string): CompoundNodeView | null {
  const found = view.byId.get(identifier)
  if (found === undefined) return null
  return found.presentation === 'compound' || found.presentation === 'drifted' ? found : null
}

export function ejectWarning(view: CompoundView, identifier: string): EjectWarning | null {
  const compound = compoundIn(view, identifier)
  if (compound === null) return null
  return {
    identifier,
    kind: compound.kind,
    title: compound.title,
    oneWay: true,
    losesParams: compound.rawParams,
    nodesBecomingPlain: [identifier, ...compound.childIds],
    reason:
      `Editing the expanded subgraph of "${identifier}" removes its @featurelab:${COMPOUND_DIRECTIVE} annotation and ` +
      `leaves a plain vanilla graph. The recorded ${compound.kind} parameters are discarded, and nothing can recover ` +
      `them from the JSON afterwards. This cannot be undone by re-adding the annotation.`,
  }
}

/**
 * What an edit MEANS. Nothing is written; this is what the command layer asks
 * before it decides whether to prompt.
 */
export function classifyEdit(view: CompoundView, target: EditTarget): EditConsequence {
  if (target.what === 'canvas-position') {
    return { effect: 'none', identifier: target.identifier, why: 'layout-is-not-an-edit' }
  }

  const node = view.byId.get(target.identifier)
  if (node === undefined) return { effect: 'unknown', identifier: target.identifier }

  if (target.what === 'compound-fields') {
    if (node.presentation !== 'compound' && node.presentation !== 'drifted') {
      return { effect: 'unknown', identifier: target.identifier }
    }
    return {
      effect: 'regenerate',
      identifier: target.identifier,
      kind: node.kind,
      overwritesDrift: node.drift.length > 0,
      drift: node.drift,
    }
  }

  // node-body: editing the JSON of the compound root, or of anything it
  // generated, IS editing the expanded subgraph.
  if (node.presentation === 'compound' || node.presentation === 'drifted') {
    const warning = ejectWarning(view, target.identifier)
    if (warning === null) return { effect: 'plain', identifier: target.identifier }
    return { effect: 'eject', identifier: target.identifier, kind: node.kind, warning }
  }
  if (node.presentation === 'child') {
    const owner = compoundIn(view, node.parent)
    const warning = ejectWarning(view, node.parent)
    if (owner === null || warning === null) return { effect: 'plain', identifier: target.identifier }
    return { effect: 'eject', identifier: node.parent, kind: owner.kind, warning }
  }
  return { effect: 'plain', identifier: target.identifier }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * The change the annotation must undergo, described completely.
 *
 * NOT a PlanOperation, because no PlanOperation can carry it -- see the module
 * header, gap 1. Everything a writer needs is here, including which part of it
 * the recorded span can and cannot reach.
 */
export interface AnnotationChange {
  readonly identifier: string
  readonly file: string
  /** `$`, the root of the compound's own file. */
  readonly jsonPath: string
  /** The directive's byte span. Covers `@featurelab:idiom <kind>` and no more. */
  readonly directiveSpan: { readonly offset: number; readonly endOffset: number } | null
  readonly line: number | null
  /** What the directive should become. Empty means remove it. */
  readonly directive: string
  /** What `Annotation.Text` should become. Empty means remove it. */
  readonly body: string
  /** What `Annotation.Text` is now, so a writer can find it in the file. */
  readonly previousBody: string
  readonly gaps: readonly ContractGapNote[]
}

export interface OrphanedChild {
  readonly identifier: string
  readonly file?: string
  readonly borrowed: boolean
  readonly reason: string
}

export interface ParameterEditPlan {
  readonly ok: true
  readonly identifier: string
  readonly kind: CompoundKind
  /** Always. Editing the form never ejects. */
  readonly stays: 'collapsed'
  /** The subgraph operations, straight from the spec. These ARE applyable. */
  readonly operations: readonly PlanOperation[]
  readonly notes: readonly PlanNote[]
  /** Every file the operations touch, de-duplicated and sorted. */
  readonly files: readonly string[]
  /** Ids the new parameters produce, in write order. */
  readonly creates: readonly string[]
  /** The required companion change, which no operation can carry. */
  readonly annotation: AnnotationChange
  /** Owned children the new parameters no longer produce. */
  readonly orphans: readonly OrphanedChild[]
  /** The drift this plan overwrites. */
  readonly overwrites: readonly DriftFinding[]
  /** Non-empty means the plan is incomplete as operations alone. */
  readonly blocked: readonly ContractGapNote[]
  /** False whenever `blocked` is non-empty. Check it before applying. */
  readonly applyable: boolean
}

export interface EjectPlan {
  readonly ok: true
  readonly identifier: string
  readonly kind: CompoundKind
  /** Always empty: an eject changes no JSON, only a comment. */
  readonly operations: readonly PlanOperation[]
  readonly notes: readonly PlanNote[]
  readonly annotation: AnnotationChange
  /** The root and its children, now ordinary nodes. */
  readonly becomesPlain: readonly string[]
  readonly warning: EjectWarning
  readonly blocked: readonly ContractGapNote[]
  readonly applyable: boolean
}

export type PlanResult<T> = T | { readonly ok: false; readonly refusal: Refusal }

export interface ParameterEditInput {
  readonly view: CompoundView
  readonly identifier: string
  /** The form's new parameters, unvalidated. */
  readonly params: unknown
  readonly registry: CompoundRegistry
  readonly formatVersion?: string | undefined
}

/**
 * Editing a collapsed node's own fields: re-expand, STAY COLLAPSED.
 *
 * Operation order is fixed -- the spec's own operations in its own order, then
 * nothing else. A re-expansion after an unrelated edit must not churn the
 * file, so no Map or Set ordering reaches the output.
 */
export function planParameterEdit(input: ParameterEditInput): PlanResult<ParameterEditPlan> {
  const { view, identifier } = input
  const compound = compoundIn(view, identifier)
  if (compound === null) {
    return refuse('unknown-node', `"${identifier}" is not a compound in this graph, so it has no parameters to edit.`, [identifier])
  }
  if (compound.site === null) {
    return refuse(
      'unresolved-node',
      `"${identifier}" does not report a file, so its recorded parameters cannot be rewritten.`,
      [identifier],
    )
  }
  const spec = input.registry[compound.kind]
  if (spec === undefined) {
    return refuse(
      'unknown-wrapper',
      `"${compound.kind}" is not one of the compounds this editor has a spec for, so its parameters cannot be expanded.`,
      [identifier],
    )
  }

  const formatVersion = input.formatVersion ?? compound.formatVersion
  if (formatVersion === '') {
    return refuse(
      'no-format-version',
      `"${identifier}" declares no format_version and none was supplied, and which keys a feature accepts depends on it.`,
      [identifier],
    )
  }

  const validated = callValidate(spec, input.params)
  if (validated.thrown) {
    return refuse('molang-invalid', `The "${compound.kind}" spec threw while validating the new parameters.`, [identifier])
  }
  if (!validated.result.ok) return { ok: false, refusal: validated.result.refusal }

  const expanded = callExpand(spec, identifier, validated.result.params, formatVersion)
  if (expanded.thrown) {
    return refuse('molang-invalid', `The "${compound.kind}" spec threw while expanding the new parameters.`, [identifier])
  }
  if (!expanded.result.ok) return { ok: false, refusal: expanded.result.refusal }
  const expansion = expanded.result.expansion

  const operations = [...expansion.operations]
  const notes: PlanNote[] = [...expansion.notes]

  // Only ids this compound actually OWNS are listed as orphans. An id the old
  // expansion named but that was contested, or already absent, is left alone:
  // proposing to remove a file on the strength of a name is the one thing this
  // host must never do.
  const stillCreated = new Set<string>(expansion.creates)
  const orphans: OrphanedChild[] = []
  for (const child of compound.children) {
    if (stillCreated.has(child.identifier)) continue
    if (!child.present) continue
    orphans.push({
      identifier: child.identifier,
      ...(child.file === undefined ? {} : { file: child.file }),
      borrowed: child.borrowed,
      reason: child.borrowed
        ? `"${identifier}" no longer produces "${child.identifier}", but something outside the compound delegates to it, ` +
          `so removing its file would leave a dangling reference.`
        : `"${identifier}" no longer produces "${child.identifier}".`,
    })
  }

  const blocked: ContractGapNote[] = [GAP_ANNOTATION]
  notes.push({ level: 'warning', message: GAP_ANNOTATION.message })
  if (orphans.length > 0) {
    blocked.push(GAP_DELETE)
    notes.push({
      level: 'warning',
      message:
        `${orphans.length === 1 ? 'One file is' : `${orphans.length} files are`} left over: ` +
        `${orphans.map((orphan) => orphan.file ?? orphan.identifier).join(', ')}. ` +
        GAP_DELETE.message,
    })
  }

  return {
    ok: true,
    identifier,
    kind: compound.kind,
    stays: 'collapsed',
    operations,
    notes,
    files: touchedFiles(operations),
    creates: expansion.creates,
    annotation: {
      identifier,
      file: compound.site.file,
      jsonPath: compound.site.annotation.jsonPath,
      directiveSpan: spanOf(compound.site.annotation),
      line: compound.site.annotation.line ?? null,
      directive: `@featurelab:${COMPOUND_DIRECTIVE} ${compound.kind}`,
      body: encodeCompoundParams(validated.result.params),
      previousBody: compound.site.annotation.text ?? '',
      gaps: [GAP_ANNOTATION],
    },
    orphans,
    overwrites: compound.drift,
    blocked,
    applyable: false,
  }
}

/**
 * The eject. The annotation goes and what is left is a plain vanilla graph.
 *
 * Nothing is regenerated and nothing is deleted: the subgraph on disk is
 * exactly the thing being kept, which is why this returns no operations at all.
 */
export function planEject(input: { readonly view: CompoundView; readonly identifier: string }): PlanResult<EjectPlan> {
  const { view, identifier } = input
  const compound = compoundIn(view, identifier)
  if (compound === null) {
    return refuse('unknown-node', `"${identifier}" is not a compound in this graph, so there is no annotation to eject.`, [identifier])
  }
  if (compound.site === null) {
    return refuse(
      'unresolved-node',
      `"${identifier}" does not report a file, so its @featurelab:${COMPOUND_DIRECTIVE} annotation cannot be removed.`,
      [identifier],
    )
  }
  const warning = ejectWarning(view, identifier)
  if (warning === null) {
    return refuse('unknown-node', `"${identifier}" cannot be ejected.`, [identifier])
  }

  return {
    ok: true,
    identifier,
    kind: compound.kind,
    operations: [],
    notes: [
      { level: 'warning', message: warning.reason },
      { level: 'warning', message: GAP_ANNOTATION.message },
    ],
    annotation: {
      identifier,
      file: compound.site.file,
      jsonPath: compound.site.annotation.jsonPath,
      directiveSpan: spanOf(compound.site.annotation),
      line: compound.site.annotation.line ?? null,
      directive: '',
      body: '',
      previousBody: compound.site.annotation.text ?? '',
      gaps: [GAP_ANNOTATION],
    },
    becomesPlain: warning.nodesBecomingPlain,
    warning,
    blocked: [GAP_ANNOTATION],
    applyable: false,
  }
}

/**
 * Moving a node is NOT an edit.
 *
 * A function rather than a comment because this is the rule most easily lost.
 * Canvas position lives in the layout sidecar, so inspecting the machinery
 * costs nothing and ejects nothing; a host that made a drag ambiguous would
 * make opening a compound frightening, and then nobody would ever look inside.
 */
export function planCanvasMove(identifier: string): {
  readonly ok: true
  readonly identifier: string
  readonly operations: readonly PlanOperation[]
  readonly ejects: false
  readonly applyable: true
} {
  return { ok: true, identifier, operations: [], ejects: false, applyable: true }
}

function spanOf(annotation: CollapseAnnotation): { readonly offset: number; readonly endOffset: number } | null {
  const { offset, endOffset } = annotation
  if (offset === undefined || endOffset === undefined) return null
  if (endOffset < offset) return null
  return { offset, endOffset }
}

/** Mirrors EditPlan.files: de-duplicated and sorted, so a caller need not walk. */
function touchedFiles(operations: readonly PlanOperation[]): string[] {
  const seen = new Set<string>()
  for (const operation of operations) seen.add(operation.file)
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Refusals reuse idioms.ts's `Refusal` unchanged, which means reusing its
 * CLOSED `RefusalCode` union -- it has no compound codes, so three of these
 * are the nearest honest neighbour rather than an exact name:
 *
 *   unknown-node      -- the id is not a compound here (idioms.ts uses it for
 *                        "not in this graph", which is the same shape).
 *   unknown-wrapper   -- no spec is registered for the kind. idioms.ts uses it
 *                        for "not one of the wrappers this action knows".
 *   molang-invalid    -- a spec threw. The code is about a bad expression; what
 *                        is meant is "the spec could not make sense of this".
 *
 * A compound code (`unknown-compound`, `compound-refused`) belongs in
 * idioms.ts. It is not added here, because RefusalCode is not this module's.
 */
function refuse(
  code: Refusal['code'],
  reason: string,
  nodes?: readonly string[],
): { readonly ok: false; readonly refusal: Refusal } {
  return { ok: false, refusal: nodes === undefined ? { code, reason } : { code, reason, nodes } }
}
