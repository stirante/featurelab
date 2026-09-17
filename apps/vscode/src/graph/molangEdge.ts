// molangEdge.ts -- the editor for the Molang that lives ON AN EDGE: a conditional_list entry's
// `condition` and a scatter's `iterations` (wire.GraphEdge.Condition / .Iterations). One
// headless controller per edge. It owns the draft text, the mode, the diagnostics shown beside
// the field, and the change events the host writes back through; it owns no pixels and no
// engine.
//
// # Why there is no DOM in this file
//
// Every other module under apps/vscode/src is DOM-free (identifier.ts, diagnostics.ts,
// previewController.ts) and the pixels live in frontend/src/ui, which both app shells share --
// forking a renderer per host is the thing that file's header forbids. So this exposes a
// `view()` value describing what to draw and a small command surface for what the user did,
// and the graph canvas renders it. The immediate payoff is that the interesting half is
// testable under this package's vitest config, which is `environment: 'node'` with no jsdom.
//
// # Why validation is behind an interface
//
// The useful diagnostics need a loaded pack, a resolved delegation chain and a placement walk:
// "this reads a name nothing ever writes" cannot be answered from one expression's text. That
// lives in Go. This file states the request and response it needs (MolangValidateRequest /
// MolangValidateResponse, the shape a host wires to EngineProcess.request) and takes a
// validator by injection, so the editor is exercisable with a fake and the engine is not a test
// dependency. Everything decidable from the text alone is answered here and now, offline, by
// molangHints.ts.
//
// # The three things `iterations` is for, and why this is not a spin-box
//
// `iterations` is a full Molang expression evaluated against a scope SHARED BY REFERENCE with
// everything the scatter delegates to (wgen.NewScope's doc comment: deriving a child scope is
// the identity operation). Real packs therefore use it three ways, and GraphEdge.Iterations
// calls all three load-bearing idioms rather than abuses:
//
//  1. COUNTING -- how many times to place. The obvious one.
//  2. AS A CONDITION -- evaluate to 0 and nothing is placed. The engine diagnoses exactly this,
//     distinctly from a scatter_chance rejection, because the two call for opposite responses:
//     a chance rejection is luck and another seed may place, a zero-iterations is configuration
//     and no seed will help.
//  3. AS A SETUP STEP -- assign `variable.*` that the placed feature then reads.
//
// A spin-box can express only (1), and would make (2) and (3) harder to write than a plain text
// box does -- you would have to leave the control to say anything interesting. So the control
// is ALWAYS a text field, and the number case gets an ADORNMENT instead of a mode of its own:
// `stepper` is non-null exactly while the text is a bare numeric literal, i.e. exactly while a
// stepper is a lossless view of it, and it disappears the moment the author types an operator.
// Nobody loses the up/down arrows for `4`, and nobody is trapped inside them at `(q.noise(...)
// > 0.4) * 8`.
//
// The other two idioms get help of their own instead of a widget:
//   - `idioms` reports which of the three the text is currently doing, so the editor can lead
//     with the relevant explanation (and label a 0 as the condition idiom rather than a bug).
//   - ITERATIONS_TEMPLATES seeds either of the non-obvious two with one click.
//   - `writes` lists the `variable.*` names a setup expression sets, which is what a reader of
//     the placed feature needs and what the validator feeds back as completion downstream.
//   - localProblems catches the specific way the setup idiom misfires: a statement sequence
//     with no `return` evaluates to 0, so `v.height = 5;` silently turns the scatter off.
//
// # Origin sensitivity
//
// A condition gated on chunk position is FALSE at the default preview origin of 0,0,0 and true
// elsewhere. "It did not run" is not "it is dead", and this file never conflates them: every
// evaluation result is phrased "at this origin", carries the origin it used, and offers an
// action that points at the origin control. The word "dead" is reserved for an expression whose
// own text proves it cannot vary. An author who has already settled the question can say so in
// the file with `// @featurelab:ignore inactive-branch`, and this editor honours it.
//
// # Why the text on screen is not the text in the file
//
// Real packs write a setup script as one enormous line, because JSON gives them nowhere else to
// put it, and one enormous line is unreadable in three rows of a text box. So this editor holds
// the READABLE spelling as its draft -- every offset it reports, every completion range, every
// diagnostic span is against that -- and writes the COMPACT one, unless the author has said
// otherwise. `molangFormat.ts` owns both rewrites and guarantees that neither can change what an
// expression says; this file owns the decision about which one the file receives, and records
// that decision in the file itself so it survives the session (see MOLANG_FORMAT_DIRECTIVE).
//
// The consequence to keep hold of: `dirty` is not "the draft differs from the committed text".
// It is "what this editor WOULD WRITE differs from what is in the file". Opening an expression
// reformats it on screen and must not, by that act alone, mark the file as changed.
import { formatMolang, isFormattable, minifyMolang } from './molangFormat.js'
import {
  analyseIterations,
  completionsAt,
  isBiomeSensitive,
  isOriginSensitive,
  localProblems,
  scanMolang,
  type IterationsIdiom,
  type MolangCompletion,
  type MolangEdgeField,
} from './molangHints.js'

export type { MolangEdgeField, MolangCompletion, IterationsIdiom }

/** The subset of wire.GraphEdge this editor needs to identify and write back through. Not a
 * copy of the frozen contract -- a narrowing of it -- so a host can pass a GraphEdge straight
 * in, and this module stays uninterested in Weight, Ordinal and the rest. */
export interface MolangEdgeRef {
  from: string
  to: string
  /** wire.EdgeKind; 'conditional' or 'scatter' for an edge that carries Molang at all. */
  kind: string
  /** wire.GraphEdge.JSONPath -- where in From's file the change goes, and where "show me the
   * JSON" jumps to. Also the key this editor matches wire.Annotation against. */
  jsonPath: string
  /** wire.GraphEdge.Required. `iterations` is required; a `condition` is not. */
  required: boolean
}

/** wire.Annotation, narrowed. Only the directives on THIS edge's jsonPath are the editor's
 * business. */
export interface EdgeAnnotation {
  name: string
  args?: readonly string[]
  text?: string
  jsonPath: string
  line?: number
}

export interface OriginPoint {
  x: number
  y: number
  z: number
}

// ---------------------------------------------------------------------------
// The validation contract this editor assumes of the Go side
// ---------------------------------------------------------------------------

/** What the editor asks the engine about one edge expression.
 *
 * Sent per edge rather than per file because the answer genuinely depends on the edge: the
 * scope reaching a conditional entry is whatever its ancestors wrote on the way down, and two
 * entries of the same list can have different ones. `from`/`jsonPath` are how the engine finds
 * that chain. */
export interface MolangValidateRequest {
  /** Which field's rules apply -- requiredness, and which variables the engine publishes before
   * evaluating (all six for a condition, origin-only for iterations). */
  field: MolangEdgeField
  /** The expression exactly as it would be written into the JSON. Never null: an absent
   * condition is always-true and is not sent. */
  expression: string
  edge: { from: string; to: string; kind: string; jsonPath: string }
  /** The origin the caller would generate at. Present on EVERY request, and echoed back in the
   * response, because an evaluation is only ever true of one origin and a response that does
   * not say which is not reportable. */
  origin: OriginPoint
  /** The biome whose tags back has_biome_tag/any_tag/all_tags, when the run selected one. */
  biomeId?: string
}

export interface MolangSpan {
  offset: number
  length: number
}

/** A name this expression reads that nothing writes on any path reaching this edge -- the
 * commonest real bug in edge Molang, and the reason this whole module surfaces diagnostics AT
 * the edge instead of in a problems list. The engine already knows the answer: it reports every
 * unresolved read it swallows (wgen's OnUnresolvedRead / UnresolvedReadWarning), and knows that
 * in the real game such a read STOPS the expression where it stands. */
export interface UnwrittenRead {
  /** "variable.trunk_height" -- namespace-qualified, in the canonical long spelling. */
  name: string
  /** Where it is read in `expression`, for an inline underline. */
  span?: MolangSpan
  /** The engine's own long-form explanation (UnresolvedReadWarning), when it has one. The
   * editor shows its own short line and keeps this for the hover. */
  detail?: string
}

export interface MolangValidateResponse {
  /** Set when the expression does not compile. Everything else is then absent. */
  syntaxError?: { message: string; span?: MolangSpan }
  /** Names read here and written nowhere upstream. Empty/absent means every read resolves. */
  unwrittenReads?: readonly UnwrittenRead[]
  /** `variable.*` names this expression itself writes, as the engine sees them. Redundant with
   * the local scan for simple text and authoritative when they disagree. */
  writes?: readonly string[]
  /** `variable.*` names written by features UPSTREAM of this edge -- what completion offers
   * beyond the engine's published six. */
  scopeWrites?: readonly string[]
  /** The value at `originUsed`. Absent when the engine declined to evaluate (no pack loaded, a
   * syntax error, a chain it could not resolve). */
  evaluation?: {
    value: number
    /** Echo of the request origin. The editor reports THIS, never the one it asked with, so a
     * response that raced an origin change cannot be mislabelled. */
    originUsed: OriginPoint
    /** The engine's own answer to "could this differ elsewhere?", overriding the local textual
     * guess when present. */
    originSensitive?: boolean
  }
  /** Anything else the engine wants shown on this edge, already phrased for a human. */
  diagnostics?: readonly { severity: 'error' | 'warning' | 'info'; message: string; span?: MolangSpan }[]
}

export interface MolangEdgeValidator {
  validate(request: MolangValidateRequest): Promise<MolangValidateResponse>
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type EdgeProblemCode =
  | 'syntax'
  | 'unwritten-read'
  | 'engine'
  | 'unreachable-query'
  | 'query-arity'
  | 'biome-tag-y-zero'
  | 'math-arity'
  | 'world-var-in-iterations'
  | 'sequence-without-return'
  | 'empty-required'
  | 'zero-at-origin'

export type EdgeActionKind = 'reveal-origin' | 'reveal-json' | 'annotate-ignore' | 'insert-fallback'

export interface EdgeAction {
  kind: EdgeActionKind
  label: string
  /** For 'insert-fallback': the name to guard, e.g. "variable.trunk_height". */
  name?: string
}

export interface EdgeProblem {
  code: EdgeProblemCode
  severity: 'error' | 'warning' | 'info'
  /** One line, written to be read in a tooltip beside a graph edge -- not a paragraph. */
  message: string
  /** The long form, for a hover or an expanded row. */
  detail?: string
  span?: MolangSpan
  actions?: readonly EdgeAction[]
}

export interface EdgeEvaluation {
  value: number
  origin: OriginPoint
  /** Always phrased "at this origin", always naming the origin. See this file's header. */
  summary: string
}

export type EdgeStatus = 'idle' | 'validating' | 'stale' | 'ok' | 'problems'

export interface MolangEdgeView {
  field: MolangEdgeField
  edge: MolangEdgeRef
  /** The draft text. Empty string when the key is absent. */
  text: string
  /** True when the JSON carries no such key at all. Only ever true for `condition`, where the
   * contract keeps nil distinct from a written "1.0" so the editor can say "the author wrote no
   * condition" rather than inventing one. Clearing the field returns to this state; typing
   * "1.0" does not. */
  absent: boolean
  /** True while the draft differs from the last committed value. */
  dirty: boolean
  status: EdgeStatus
  /** Present exactly while the text is a bare number, i.e. while a stepper is a lossless view
   * of it. Null the instant it is not -- see this file's header on why the control itself is
   * never a spin-box. */
  stepper: { value: number; min: number; step: number } | null
  /** Which of the three `iterations` idioms the text is currently doing. Empty for a
   * `condition` edge, whose single job needs no classification. */
  idioms: readonly IterationsIdiom[]
  /** An `@featurelab:idiom <name>` directive on this edge, when the author declared one. An
   * explicit declaration beats inference for what the editor LEADS with. */
  declaredIdiom: string | null
  /** `variable.*` names this expression writes for the placed feature to read. */
  writes: readonly string[]
  /** The author has asked for this expression to reach the FILE in the readable spelling rather
   * than the compact one. False is the default and means the file gets one line. */
  keepFormatted: boolean
  /** Whether the two spellings are actually different here -- i.e. whether molangFormat could
   * scan the text at all. False for a half-typed or unusual expression, where both rewrites
   * return their input and the choice above would be a control that does nothing. */
  formattable: boolean
  /** Exactly the bytes `commit()` would put in the file, given the current draft and the choice
   * above. Exposed so a renderer can show the author what their file is going to receive instead
   * of asking them to trust it. */
  writeValue: string
  problems: readonly EdgeProblem[]
  /** Problem codes suppressed by an `@featurelab:ignore` directive, so a renderer can show a
   * muted marker rather than nothing at all. */
  suppressed: readonly EdgeProblemCode[]
  evaluation: EdgeEvaluation | null
}

/** Seeds for the two idioms a text box does not advertise. Offered as one-click inserts because
 * the shapes are not guessable but are entirely conventional once seen. */
export const ITERATIONS_TEMPLATES: readonly { id: IterationsIdiom; label: string; text: string; doc: string }[] = [
  {
    id: 'condition',
    label: 'Gate: place only where a test passes',
    text: '(query.noise(variable.originx / 128, variable.originz / 128) > 0.4) * 4',
    doc:
      'Four iterations where the test passes and zero where it does not. Zero iterations means ' +
      'nothing is placed, and the engine reports that specifically -- as configuration, not as ' +
      'the luck of a scatter_chance roll.',
  },
  {
    id: 'setup',
    label: 'Setup: set variables the placed feature reads',
    text: 'variable.trunk_height = 4 + math.random_integer(0, 3); return 1;',
    doc:
      'The scatter shares its Molang scope by reference with everything it delegates to, so a ' +
      'variable set here is readable by the placed feature. End with `return <count>` -- a ' +
      'statement sequence without one evaluates to 0, which places nothing.',
  },
]

export type MolangEdgeChange =
  /** The expression the host should write into the file at edge.jsonPath. `value: null` means
   * REMOVE the key, which is meaningful only for `condition`: the contract distinguishes an
   * absent condition from a written "1.0", and an editor that wrote "1.0" on clear would erase
   * that distinction on the author's behalf. */
  | { kind: 'value'; field: MolangEdgeField; edge: MolangEdgeRef; value: string | null }
  /** Write a JSON-comment directive next to this edge. Used by the 'annotate-ignore' action, so
   * an author's "yes, I know, it is chunk-gated" is recorded in the file where the next reader
   * sees it instead of in this session -- and by the format choice, which has nowhere else to
   * live: the game's schema has no key for "how should this be spelled", and a session that
   * forgot the answer would re-flatten the expression the next time anybody touched it.
   *
   * `jsonPath` says WHICH member the comment attaches to, and defaults to the edge's own. The
   * format choice is about the EXPRESSION, so it names the expression's path
   * (`$....distribution.iterations`) rather than the delegation's -- a comment on the wrong
   * member would read back as an annotation of something else. */
  | {
      kind: 'annotate'
      edge: MolangEdgeRef
      jsonPath?: string
      annotation: { name: string; args: string[]; text?: string }
    }
  /** Take the user somewhere: the origin control that governs an "at this origin" result, or
   * the JSON this edge came from. */
  | { kind: 'reveal'; edge: MolangEdgeRef; target: 'origin-control' | 'json' }

export interface MolangEdgeInput {
  edge: MolangEdgeRef
  field: MolangEdgeField
  /** wire.GraphEdge.Condition / .Iterations verbatim, null included. */
  value: string | null
  /** Where the EXPRESSION lives in the file -- wire.GraphEdge.IterationsPath / .ConditionPath --
   * as opposed to `edge.jsonPath`, which is where the delegation does. The two are different
   * members of different objects, and a directive about how this expression is spelled belongs on
   * the expression. Annotations on either path are read; a directive this editor writes goes
   * here when it is set. */
  fieldPath?: string
  /** The preview origin the surrounding panel is generating at. */
  origin: OriginPoint
  /** wire.Annotation entries; those whose jsonPath is not this edge's are ignored. */
  annotations?: readonly EdgeAnnotation[]
  biomeId?: string
}

export interface MolangEdgeEditorOptions {
  validator: MolangEdgeValidator
  /** Debounce hook. Returns a canceller. Injected rather than a bare setTimeout so a test can
   * run validation synchronously and a host can tune the delay without touching this file. */
  schedule?: (run: () => void) => () => void
}

/** The directive that records how one expression should be spelled in the file.
 *
 * `@featurelab:molang-format keep` -- write the readable text; `@featurelab:molang-format minify`
 * -- write the compact one, which is also what an expression with no directive gets. Named for
 * what it governs, in the same shape as the directives that were already here (`idiom`,
 * `idiom-child`, `ignore`, `layout`): one lowercase hyphenated word, with the choice as an
 * argument rather than as a second directive name, so the two states are one thing with two
 * values and a file can never carry both at once.
 *
 * The OFF state is written out rather than left implicit. It is redundant -- absence already
 * means minify -- and it is worth the line: unticking the box is an action the author took, and a
 * toggle whose off state removes all trace of itself gives them no way to tell "I decided this"
 * from "nobody ever looked". It also makes the control reversible through exactly one mechanism
 * (rewrite the argument) instead of two (insert, then delete a comment line and hope the line had
 * nothing else on it). */
export const MOLANG_FORMAT_DIRECTIVE = 'molang-format'
/** The argument that opts one expression OUT of minify-on-write. */
export const MOLANG_FORMAT_KEEP = 'keep'
/** The argument that spells out the default. */
export const MOLANG_FORMAT_MINIFY = 'minify'

const DEFAULT_DEBOUNCE_MS = 150

function defaultSchedule(run: () => void): () => void {
  const timer = setTimeout(run, DEFAULT_DEBOUNCE_MS)
  return () => clearTimeout(timer)
}

function formatOrigin(origin: OriginPoint): string {
  return `${origin.x},${origin.y},${origin.z}`
}

/** One edge's Molang field. Construct per edge, dispose when the edge leaves the canvas. */
export class MolangEdgeEditor {
  private readonly edge: MolangEdgeRef
  private readonly field: MolangEdgeField
  private readonly validator: MolangEdgeValidator
  private readonly schedule: (run: () => void) => () => void
  private readonly listeners = new Set<(change: MolangEdgeChange) => void>()
  private readonly ignored: ReadonlySet<string>

  private readonly fieldPath: string
  private committed: string | null
  /** The READABLE spelling -- what the text box holds and what every offset this editor reports
   * is measured against. Never the file's own bytes unless the two happen to coincide. */
  private draft: string
  private keepFormatted: boolean
  private origin: OriginPoint
  private biomeId: string | undefined
  private declaredIdiom: string | null
  private response: MolangValidateResponse | null = null
  /** The text `response` describes. A response about text the author has since edited is stale
   * and is reported as such rather than shown as if it were current. */
  private responseFor: string | null = null
  private validating = false
  private inflight: Promise<void> | null = null
  private cancelSchedule: (() => void) | null = null
  /** Monotonic; a response whose token is not the newest is dropped. Without this, a slow
   * validation of an older draft overwrites a fast one of the newer, and the field shows
   * diagnostics about text that is no longer there. */
  private token = 0
  private disposed = false

  constructor(input: MolangEdgeInput, options: MolangEdgeEditorOptions) {
    this.edge = input.edge
    this.field = input.field
    this.validator = options.validator
    this.schedule = options.schedule ?? defaultSchedule
    this.fieldPath = input.fieldPath ?? input.edge.jsonPath
    this.committed = input.value
    this.origin = input.origin
    this.biomeId = input.biomeId
    // Both paths are read. A directive about the delegation and a directive about the expression
    // are written on different members but are both "on this edge" as far as a reader is
    // concerned, and an author who put `ignore` above the wrong one of two adjacent lines should
    // not silently get nothing.
    const paths = new Set([input.edge.jsonPath, this.fieldPath])
    const mine = (input.annotations ?? []).filter((a) => paths.has(a.jsonPath))
    this.ignored = new Set(mine.filter((a) => a.name === 'ignore').flatMap((a) => a.args ?? []))
    this.declaredIdiom = mine.find((a) => a.name === 'idiom')?.args?.[0] ?? null
    this.keepFormatted =
      mine.find((a) => a.name === MOLANG_FORMAT_DIRECTIVE)?.args?.[0] === MOLANG_FORMAT_KEEP
    // The draft is the formatted spelling from the first frame, so the author never sees the one
    // enormous line the file holds. formatMolang returns its input for anything it cannot scan
    // confidently, so this is a no-op on a half-written or unusual expression rather than a
    // rewrite of it.
    this.draft = input.value === null ? '' : formatMolang(input.value)
    if (this.committed !== null) this.requestValidation()
  }

  /** Subscribe to change events. Returns the unsubscriber. */
  onChange(listener: (change: MolangEdgeChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: MolangEdgeChange): void {
    for (const listener of this.listeners) listener(change)
  }

  /** Live typing. Updates the draft and re-runs the offline analysis immediately; schedules
   * validation; emits NOTHING. Writing the file on every keystroke would churn the document and
   * the pack reload behind it, so the write is a separate, explicit commit() -- a host wires it
   * to blur/Enter. */
  setText(next: string): void {
    if (next === this.draft) return
    this.draft = next
    this.requestValidation()
  }

  /** What `commit()` would put in the file: the draft, spelled the way this expression's format
   * choice says. Never a guess -- minifyMolang returns its input verbatim for anything it cannot
   * scan back to the same tokens, so the worst case is that the file keeps the readable text. */
  private valueToWrite(): string {
    // Both branches go through a rewrite, and the "keep" one is not a no-op: it writes the
    // CANONICAL readable form rather than whatever the draft happens to look like mid-edit. If it
    // wrote the draft verbatim, "keep the line breaks" would mean "keep whatever spacing you had
    // when you clicked away", and the same expression would land in the file differently
    // depending on where the author's hands were. Both rewrites return their input untouched for
    // text they cannot scan, so neither branch can invent bytes.
    return this.keepFormatted ? formatMolang(this.draft) : minifyMolang(this.draft)
  }

  /** Writes the draft back. Returns false when there is nothing to write.
   *
   * "Nothing to write" is decided against what would GO IN THE FILE, not against the draft.
   * Opening an expression reformats it on screen, and a commit that compared the two spellings
   * would find them different and rewrite the file for every edge anybody looked at. */
  commit(): boolean {
    if (this.disposed) return false
    const value = this.valueToWrite()
    if (value === (this.committed ?? '')) return false
    this.committed = value
    this.emit({ kind: 'value', field: this.field, edge: this.edge, value })
    return true
  }

  /** Re-lays-out the draft, returning true when that changed anything.
   *
   * Called when the field loses focus rather than while typing: reformatting under a moving caret
   * would move the caret, and there is no spelling of "put it back where it was" that survives a
   * line break being inserted three characters ahead of it. */
  reformat(): boolean {
    const next = formatMolang(this.draft)
    if (next === this.draft) return false
    this.draft = next
    this.requestValidation()
    return true
  }

  /** Sets whether this one expression is written to the file readable rather than compact, and
   * records the answer in the file.
   *
   * Records it and nothing else: the expression itself is NOT rewritten here. Two writes to one
   * file from one gesture would be two round trips through the engine and two redraws, racing
   * each other through a host that does not serialise them -- and the second one would be
   * rewriting an expression the author had not touched. The new spelling reaches the file on the
   * next commit, which is the same rule every other change in this editor follows. */
  setKeepFormatted(keep: boolean): boolean {
    if (this.disposed || keep === this.keepFormatted) return false
    this.keepFormatted = keep
    this.emit({
      kind: 'annotate',
      edge: this.edge,
      jsonPath: this.fieldPath,
      annotation: {
        name: MOLANG_FORMAT_DIRECTIVE,
        args: [keep ? MOLANG_FORMAT_KEEP : MOLANG_FORMAT_MINIFY],
      },
    })
    return true
  }

  /** Removes the key entirely -- the only way back to "the author wrote no condition". Refused
   * on a required field: removing `iterations` is not an edit a scatter survives, and the
   * contract marks it Required precisely so an editor can refuse rather than produce a file
   * that will not load. */
  clear(): boolean {
    if (this.edge.required || this.field === 'iterations') return false
    this.draft = ''
    this.committed = null
    this.response = null
    this.responseFor = null
    this.cancelSchedule?.()
    this.cancelSchedule = null
    this.token++
    this.validating = false
    this.emit({ kind: 'value', field: this.field, edge: this.edge, value: null })
    return true
  }

  /** Replaces the text with one of ITERATIONS_TEMPLATES. Does not commit -- the author gets to
   * edit the seed before it reaches their file. */
  insertTemplate(id: IterationsIdiom): boolean {
    const template = ITERATIONS_TEMPLATES.find((t) => t.id === id)
    if (template === undefined) return false
    // Formatted, because a seed arrives all at once and there is no caret to disturb -- and the
    // setup template is a two-statement sequence, which is exactly the shape a single line hides.
    this.setText(formatMolang(template.text))
    return true
  }

  /** The origin the surrounding preview is generating at. Changing it re-validates, because
   * every evaluation this editor reports is a statement about one origin. */
  setOrigin(origin: OriginPoint): void {
    if (origin.x === this.origin.x && origin.y === this.origin.y && origin.z === this.origin.z) return
    this.origin = origin
    this.requestValidation()
  }

  setBiomeId(biomeId: string | undefined): void {
    if (biomeId === this.biomeId) return
    this.biomeId = biomeId
    this.requestValidation()
  }

  /** Completion for a caret in the text field. Fed the names the validator reported written
   * upstream, so the setup idiom's payoff -- completing the variable a parent scatter set --
   * actually works. */
  completions(offset: number): MolangCompletion[] {
    return completionsAt(this.draft, offset, { field: this.field, scopeWrites: this.response?.scopeWrites })
  }

  /** Runs an action offered on a problem. Actions that change text do so; the rest turn into
   * change events for the host, which owns the origin control and the text document. */
  invokeAction(action: EdgeAction): void {
    switch (action.kind) {
      case 'reveal-origin':
        this.emit({ kind: 'reveal', edge: this.edge, target: 'origin-control' })
        return
      case 'reveal-json':
        this.emit({ kind: 'reveal', edge: this.edge, target: 'json' })
        return
      case 'annotate-ignore':
        this.emit({
          kind: 'annotate',
          edge: this.edge,
          annotation: { name: 'ignore', args: ['inactive-branch'] },
        })
        return
      case 'insert-fallback':
        // `?? 0` is the engine's own escape hatch for an unresolved read, and the only one that
        // settles the question in the file instead of in a conversation -- see
        // wgen.UnresolvedReadWarning, which offers exactly this or an upstream write.
        if (action.name !== undefined) this.setText(`(${this.draft}) ?? 0`)
        return
    }
  }

  /** Resolves once no validation is in flight. For tests and for a host that wants to await a
   * settled view; never needed to render, since view() is always consistent. */
  async whenSettled(): Promise<void> {
    for (;;) {
      const pending = this.inflight
      if (pending === null) return
      await pending
      if (pending === this.inflight) return
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelSchedule?.()
    this.cancelSchedule = null
    this.listeners.clear()
  }

  private requestValidation(): void {
    this.cancelSchedule?.()
    // A disposed editor still answers view() from whatever it last knew (a renderer may paint
    // one more frame), but it must not start engine work for an edge that is gone.
    if (this.disposed) return
    const token = ++this.token
    if (this.draft.trim().length === 0) {
      // Nothing to ask about: an empty required field is already an error the text proves, and
      // an empty condition is the absent-condition case, which means always-true.
      this.validating = false
      this.response = null
      this.responseFor = null
      this.cancelSchedule = null
      return
    }
    this.validating = true
    this.cancelSchedule = this.schedule(() => {
      this.inflight = this.runValidation(token).finally(() => {
        if (this.token === token) this.inflight = null
      })
    })
  }

  private async runValidation(token: number): Promise<void> {
    const expression = this.draft
    const origin = this.origin
    let response: MolangValidateResponse
    try {
      response = await this.validator.validate({
        field: this.field,
        expression,
        edge: { from: this.edge.from, to: this.edge.to, kind: this.edge.kind, jsonPath: this.edge.jsonPath },
        origin,
        ...(this.biomeId === undefined ? {} : { biomeId: this.biomeId }),
      })
    } catch (err) {
      // A validator that throws is an engine problem, not an authoring one, and must not read
      // as a verdict on the expression: report it as such and keep the text's own findings.
      if (this.disposed || token !== this.token) return
      this.validating = false
      this.response = {
        diagnostics: [
          {
            severity: 'info',
            message: `could not be checked against the engine: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
      this.responseFor = expression
      return
    }
    // Dropped rather than applied: this response describes text the author has already moved
    // past (or an editor that is gone).
    if (this.disposed || token !== this.token) return
    this.validating = false
    this.response = response
    this.responseFor = expression
  }

  /** Everything a renderer needs, recomputed from the current draft. Cheap by construction: the
   * offline analysis is a single scan of a short string, and the engine half is whatever the
   * last accepted response held. */
  view(): MolangEdgeView {
    const text = this.draft
    const absent = this.committed === null && text.length === 0
    const refs = scanMolang(text)
    const analysis = this.field === 'iterations' ? analyseIterations(text) : null
    const problems: EdgeProblem[] = []
    const suppressed: EdgeProblemCode[] = []

    for (const local of localProblems(text, this.field)) {
      problems.push({ code: local.code, severity: local.severity, message: local.message, ...(local.span ? { span: local.span } : {}) })
    }

    const response = this.responseFor === text ? this.response : null
    if (response?.syntaxError !== undefined) {
      problems.push({
        code: 'syntax',
        severity: 'error',
        message: response.syntaxError.message,
        ...(response.syntaxError.span ? { span: response.syntaxError.span } : {}),
      })
    }
    // The headline diagnostic, and the reason it is rendered ON the edge: a read of a name
    // nothing writes is the commonest real bug in edge Molang, and in the real game it does not
    // merely read 0 -- it ENDS the expression, so nothing sequenced after it happens either.
    // Buried in a problems list it is a line of text; next to the field it is the answer.
    for (const read of response?.unwrittenReads ?? []) {
      problems.push({
        code: 'unwritten-read',
        severity: 'warning',
        message:
          `${read.name} is read here and written nowhere upstream. In the real game an unresolved ` +
          'read stops the expression where it stands, so nothing after it runs either.',
        ...(read.detail === undefined ? {} : { detail: read.detail }),
        ...(read.span ? { span: read.span } : {}),
        actions: [
          { kind: 'insert-fallback', label: `Guard with ?? 0`, name: read.name },
          { kind: 'reveal-json', label: 'Show the JSON' },
        ],
      })
    }
    for (const diagnostic of response?.diagnostics ?? []) {
      problems.push({
        code: 'engine',
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.span ? { span: diagnostic.span } : {}),
      })
    }

    let evaluation: EdgeEvaluation | null = null
    if (response?.evaluation !== undefined) {
      const { value, originUsed } = response.evaluation
      const sensitive = response.evaluation.originSensitive ?? isOriginSensitive(refs)
      evaluation = {
        value,
        origin: originUsed,
        summary: `${value} at this origin (${formatOrigin(originUsed)})`,
      }
      if (value === 0) {
        const zero = this.explainZero(sensitive, isBiomeSensitive(refs), analysis?.random ?? false, originUsed)
        if (this.ignored.has('inactive-branch')) suppressed.push('zero-at-origin')
        else problems.push(zero)
      }
    }

    const status: EdgeStatus = this.validating
      ? 'validating'
      : this.responseFor !== null && this.responseFor !== text
        ? 'stale'
        : problems.some((p) => p.severity === 'error' || p.severity === 'warning')
          ? 'problems'
          : response === null
            ? 'idle'
            : 'ok'

    return {
      field: this.field,
      edge: this.edge,
      text,
      absent,
      dirty: this.valueToWrite() !== (this.committed ?? ''),
      status,
      stepper:
        analysis?.constant !== null && analysis?.constant !== undefined
          ? { value: analysis.constant, min: 0, step: 1 }
          : null,
      idioms: analysis?.idioms ?? [],
      declaredIdiom: this.declaredIdiom,
      writes: response?.writes ?? analysis?.writes ?? [],
      keepFormatted: this.keepFormatted,
      formattable: isFormattable(text),
      writeValue: this.valueToWrite(),
      problems,
      suppressed,
      evaluation,
    }
  }

  /** Explains a zero WITHOUT calling it dead.
   *
   * The rule this enforces: "this did not run" may never be reported as "this is dead". A
   * condition gated on chunk position is false at 0,0,0 and true 200 blocks away, so a verdict
   * drawn from one origin is not a verdict at all -- and a warning that is wrong on real packs
   * is a warning authors train themselves to stop reading. So a zero is only ever described as
   * unconditional when the expression's own text proves nothing in it can vary, and every other
   * phrasing says "at this origin" and hands the reader the control that would change it. */
  private explainZero(
    originSensitive: boolean,
    biomeSensitive: boolean,
    random: boolean,
    origin: OriginPoint,
  ): EdgeProblem {
    const subject =
      this.field === 'iterations'
        ? 'iterations evaluates to 0, so this scatter places nothing'
        : 'this condition is false, so this entry does not place'
    const zeroIterationsNote =
      this.field === 'iterations'
        ? ' The engine reports this outcome specifically, and distinctly from a scatter_chance ' +
          'rejection: a rejection is luck and another seed may place, a zero is configuration.'
        : ''
    const at = ` at this origin (${formatOrigin(origin)}).`
    if (originSensitive) {
      return {
        code: 'zero-at-origin',
        severity: 'info',
        message:
          `${subject}${at} This expression reads the placement position, so it can be non-zero ` +
          'somewhere else -- a branch gated on chunk position is false at the default origin of ' +
          '0,0,0 and true elsewhere. Move the origin before concluding anything about this branch.',
        detail: zeroIterationsNote.trim(),
        actions: [
          { kind: 'reveal-origin', label: 'Change the preview origin' },
          { kind: 'annotate-ignore', label: 'Known: gated, not dead' },
        ],
      }
    }
    if (biomeSensitive) {
      return {
        code: 'zero-at-origin',
        severity: 'info',
        message:
          `${subject} for this run's biome${at.replace('.', '')} -- it reads biome tags, so a run in ` +
          'another biome can differ. Change the biome before concluding anything about this branch.',
        detail: zeroIterationsNote.trim(),
        actions: [{ kind: 'annotate-ignore', label: 'Known: gated, not dead' }],
      }
    }
    if (random) {
      return {
        code: 'zero-at-origin',
        severity: 'info',
        message: `${subject} this run -- the expression draws from the RNG, so this is luck and another seed may differ.`,
        detail: zeroIterationsNote.trim(),
      }
    }
    // Nothing in the text can vary: an unconditional statement is finally allowed.
    return {
      code: 'zero-at-origin',
      severity: 'warning',
      message: `${subject}, and reads nothing that varies with origin, biome or seed -- so it is 0 for every run.`,
      detail: zeroIterationsNote.trim(),
      actions: [{ kind: 'reveal-json', label: 'Show the JSON' }],
    }
  }
}
