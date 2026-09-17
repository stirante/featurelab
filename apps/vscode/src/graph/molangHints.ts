// molangHints.ts -- the name catalogue and the source-text analysis behind the edge Molang
// editor (molangEdge.ts). Everything here is PURE: a string in, facts out. No DOM, no engine,
// no state. That split exists so the expensive half of the editor's feedback -- the half that
// needs a loaded pack and a placement walk -- can live in Go where it belongs, while the half
// that is decidable from the text alone stays instant and offline, which is what makes typing
// in a 3-character text field feel like an editor rather than a form.
//
// The catalogue is deliberately CLOSED. During worldgen the engine registers exactly six
// query.* functions (molang-go's worldgen.Register: noise, has_biome_tag, any_tag, all_tags,
// heightmap, above_top_solid) and publishes exactly six variable.* names from the placement
// origin. Offering anything else -- query.block_property, query.is_daytime, the entity-side
// catalogue people know from client files -- would be inventing reach the engine does not have,
// and the cost of that is not cosmetic: an unknown query. name is rejected by the real game at
// TOKENIZE time ("Failed to resolve query"), so a file carrying one fails to load outright.
// This tool substitutes 0 and keeps going, which means the ONLY place an author can find out is
// a diagnostic like the one below. That is why unreachable-query is an error here and not a
// suggestion.
//
// The one import is molangFormat.ts's scanner, and it is here rather than duplicated because the
// highlighter at the bottom of this file has to agree, character for character, with the thing
// that rewrites the text -- two scanners would eventually disagree about where a string ends, and
// the symptom would be colour spilling out of a quoted biome tag while the formatter left it
// alone. That module imports nothing from this one, so the dependency runs one way.
import { tokenizeMolang, type MolangToken } from './molangFormat.js'

/** The two places Molang lives on a graph edge (wire.GraphEdge's Condition and Iterations).
 * Declared here rather than in molangEdge.ts because every hint in this file is
 * field-dependent -- see PUBLISHED_VARIABLES, where the same name is live on one and stale on
 * the other. molangEdge.ts re-exports it so a caller only imports one module. */
export type MolangEdgeField = 'condition' | 'iterations'

/** Molang's namespaces, keyed by every spelling the engine's own alias table accepts
 * (molang-go ast.NamespaceAliases). The short forms are not a nicety to be normalised away at
 * the edges: real packs write `v.originx` far more often than `variable.originx`, so the
 * scanner has to recognise both, and completion has to insert whichever form the author was
 * already typing rather than silently rewriting their file's house style. */
export const NAMESPACE_ALIASES: Readonly<Record<string, MolangNamespace>> = {
  math: 'math',
  query: 'query',
  q: 'query',
  variable: 'variable',
  v: 'variable',
  temp: 'temp',
  t: 'temp',
  context: 'context',
  c: 'context',
  array: 'array',
  a: 'array',
  geometry: 'geometry',
  material: 'material',
  texture: 'texture',
}

export type MolangNamespace =
  | 'math'
  | 'query'
  | 'variable'
  | 'temp'
  | 'context'
  | 'array'
  | 'geometry'
  | 'material'
  | 'texture'

export interface QueryHint {
  /** The member name, without a namespace -- `noise`, not `query.noise`. */
  name: string
  /** How the completion renders the call, including its parameter names. */
  signature: string
  minArgs: number
  /** null for the variadic tag queries (any_tag/all_tags take one tag or many). */
  maxArgs: number | null
  /**
   * The counts the engine actually dispatches on, when they are a SET rather than a range.
   *
   * Only `has_biome_tag` needs this, and it needs it because its accepted counts are 1, 3 and
   * 4 -- with 2 missing from the middle. A min/max pair cannot say that: 1..4 would wave
   * through `has_biome_tag('forest', x)`, which the engine does not recognise and answers 0
   * for, silently. When present this is the authority and minArgs/maxArgs are only used to
   * phrase the message.
   */
  argCounts?: readonly number[]
  doc: string
  /** Whether this query's answer depends on WHERE the placement is happening. Drives the
   * "at this origin" framing in molangEdge.ts: an expression built only out of
   * origin-insensitive names really is the same everywhere, and one that reads any of these is
   * not allowed to be reported as dead on the strength of a single origin. */
  originSensitive: boolean
  /** Whether it depends on the selected biome instead (the tag queries read the run's biome
   * and answer 0 for every tag when no biome resolved). */
  biomeSensitive: boolean
}

/** The complete set of query.* functions reachable while worldgen Molang runs -- registered by
 * molang-go's worldgen.Register and wired up by featurelab's wgen/molangbridge.go. Arities are
 * the engine's own gates: noise/heightmap/above_top_solid answer 0 outright unless given
 * exactly two arguments, which is why a wrong count is worth saying out loud rather than
 * leaving as a silently-zero expression. */
export const WORLDGEN_QUERIES: readonly QueryHint[] = [
  {
    name: 'noise',
    signature: 'query.noise(x, z)',
    minArgs: 2,
    maxArgs: 2,
    doc:
      '2D simplex noise at (x, z). Fixed seed, world-seed INDEPENDENT: the same coordinates ' +
      'give the same value in every world forever, so this is a fixed pattern to place ' +
      'against, not a source of per-world variety. Single octave -- layering scales is on you. ' +
      'Answers 0 unless given exactly two arguments.',
    originSensitive: true,
    biomeSensitive: false,
  },
  {
    name: 'has_biome_tag',
    signature: "query.has_biome_tag('tag' [, x, y, z])",
    minArgs: 1,
    maxArgs: 4,
    argCounts: [1, 3, 4],
    doc:
      "Whether a biome carries the tag. With one argument it asks about the run's own origin. " +
      'It is also the ONLY tag query that can ask about somewhere else, which is what makes ' +
      'edge blending possible: pass four arguments to name an explicit x, y, z. ' +
      'Beware the three-argument form -- `has_biome_tag(\'tag\', x, z)` looks like a 2D lookup ' +
      'but forces y to 0, which is deep underground, so it answers about cave biomes rather ' +
      'than the surface. Answers 0 when no biome resolved for the run.',
    originSensitive: false,
    biomeSensitive: true,
  },
  {
    name: 'any_tag',
    signature: "query.any_tag('a', 'b', ...)",
    minArgs: 1,
    maxArgs: null,
    doc:
      'Whether the biome carries ANY of the given tags. Always asks about the run\'s own origin: ' +
      'every argument is read as a tag name, so there is no way to point it at another column. ' +
      'To test tags somewhere else, OR together several four-argument has_biome_tag calls.',
    originSensitive: false,
    biomeSensitive: true,
  },
  {
    name: 'all_tags',
    signature: "query.all_tags('a', 'b', ...)",
    minArgs: 1,
    maxArgs: null,
    doc:
      "Whether the biome carries EVERY one of the given tags. Always asks about the run's own " +
      'origin, for the same reason any_tag does: every argument is a tag name.',
    originSensitive: false,
    biomeSensitive: true,
  },
  {
    name: 'heightmap',
    signature: 'query.heightmap(x, z)',
    minArgs: 2,
    maxArgs: 2,
    doc: 'Terrain height at the column. 0 when the run has no world. Exactly two arguments.',
    originSensitive: true,
    biomeSensitive: false,
  },
  {
    name: 'above_top_solid',
    signature: 'query.above_top_solid(x, z)',
    minArgs: 2,
    maxArgs: 2,
    doc: 'One above the topmost solid block in the column. 0 with no world. Exactly two arguments.',
    originSensitive: true,
    biomeSensitive: false,
  },
]

/** Where a published variable is live, which is NOT the same question on both edge fields:
 *
 *   - 'published' -- the engine wrote it immediately before evaluating this expression.
 *   - 'stale' -- the name exists, but nothing wrote it for THIS evaluation, so it holds
 *     whatever the enclosing distribution happened to leave there (or is unset, which the
 *     engine treats as a read that ends the expression). Offered in completion anyway, with the
 *     warning attached, because silently hiding a name an author can see in other packs teaches
 *     them the tool is wrong rather than that the name is.
 */
export type VariableAvailability = 'published' | 'stale'

export interface VariableHint {
  name: string
  doc: string
  availability: Readonly<Record<MolangEdgeField, VariableAvailability>>
}

/** The variable.* names the engine itself publishes, and the one asymmetry that matters.
 *
 * A conditional_list publishes all six from its placement origin before evaluating any entry's
 * condition (worldx == originx, and so on -- the same three ints widened twice), so on a
 * `condition` edge every name here is live.
 *
 * A scatter publishes only originx/y/z before evaluating `iterations`. worldx/y/z are written
 * PER AXIS, PER ITERATION, inside the scatter loop -- i.e. strictly after `iterations` has
 * already been evaluated. Reading one from `iterations` therefore does not read this scatter's
 * position; it reads whatever an enclosing distribution last wrote, which is a real bug this
 * port has already had to fix once on the engine side. Hence 'stale', and hence
 * localProblems' world-var-in-iterations. */
export const PUBLISHED_VARIABLES: readonly VariableHint[] = [
  {
    name: 'originx',
    doc: 'X of the placement origin this feature was handed.',
    availability: { condition: 'published', iterations: 'published' },
  },
  {
    name: 'originy',
    doc: 'Y of the placement origin.',
    availability: { condition: 'published', iterations: 'published' },
  },
  {
    name: 'originz',
    doc: 'Z of the placement origin.',
    availability: { condition: 'published', iterations: 'published' },
  },
  {
    name: 'worldx',
    doc: "X of the current position. On a conditional_list's condition this equals originx.",
    availability: { condition: 'published', iterations: 'stale' },
  },
  {
    name: 'worldy',
    doc: 'Y of the current position. Equals originy on a condition.',
    availability: { condition: 'published', iterations: 'stale' },
  },
  {
    name: 'worldz',
    doc: 'Z of the current position. Equals originz on a condition.',
    availability: { condition: 'published', iterations: 'stale' },
  },
]

/** Arity of every math.* function Molang provides, mirroring molang-go's MathArity.
 * math.pi is a bare constant and is
 * absent on purpose. The 30 math.ease_* functions are also absent: they are all arity 3 and
 * belong to animation rather than worldgen, so they are neither completed nor arity-checked --
 * see checkArity, which only ever reports a math name it actually knows, so omitting them
 * costs a missing hint and never a false error. */
export const MATH_ARITY: Readonly<Record<string, number>> = {
  abs: 1, acos: 1, asin: 1, atan: 1, atan2: 2,
  ceil: 1, clamp: 3, copy_sign: 2, cos: 1,
  die_roll: 3, die_roll_integer: 3,
  exp: 1, floor: 1, hermite_blend: 1, inverse_lerp: 3,
  lerp: 3, lerprotate: 3, ln: 1, max: 2, min: 2,
  min_angle: 1, mod: 2,
  pow: 2, random: 2, random_integer: 2, round: 1, sign: 1,
  sin: 1, sqrt: 1, trunc: 1,
}

/** The math.* functions that consume RNG draws. An expression built out of these is re-rolled
 * per run, so "it was 0 this time" is luck rather than configuration -- the same distinction
 * the engine draws between a scatter_chance rejection and a zero-iterations outcome, and one
 * molangEdge.ts has to preserve when it explains a zero. */
export const RANDOM_MATH_FNS: ReadonlySet<string> = new Set([
  'random',
  'random_integer',
  'die_roll',
  'die_roll_integer',
])

/** One `namespace.member` occurrence found in the source. */
export interface MolangRef {
  namespace: MolangNamespace
  member: string
  /** The namespace exactly as written -- 'v' or 'variable' -- so completion and quick fixes can
   * keep an author's own spelling instead of normalising their file under them. */
  namespaceText: string
  /** Offset and length of the whole `v.originx` run within the ORIGINAL source (masking below
   * preserves offsets precisely so these can be handed to a renderer as an underline). */
  offset: number
  length: number
  /** Top-level argument count when this occurrence is a call, null when it is a plain read. */
  argCount: number | null
  /** True when an `=` (and not `==`) follows: this occurrence WRITES the name. */
  write: boolean
}

/** Replaces the contents of single-quoted Molang strings with spaces, preserving length and
 * therefore every offset. Tag names are strings (`q.has_biome_tag('forest')`) and would
 * otherwise be scanned as if they were code -- a tag literally named `v.x` is far-fetched, but
 * an apostrophe-free scanner that mistakes a `=` inside a string for an assignment is not. */
function maskStrings(source: string): string {
  let out = ''
  let inString = false
  for (const ch of source) {
    if (ch === "'") {
      inString = !inString
      out += ch
      continue
    }
    out += inString && ch !== '\n' ? ' ' : ch
  }
  return out
}

const REF_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g

/** Counts the top-level arguments of the call starting at `open` (which must index a `(`), and
 * returns the index just past its `)`. Deliberately a brace/paren depth scan rather than a
 * parser: Molang's `?:`, `??` and brace blocks can all appear inside an argument, and none of
 * them change where a top-level comma is. An unterminated call (still being typed) reports what
 * it has so far and an end at the source end, so a half-written expression still gets hints. */
function scanCall(masked: string, open: number): { argCount: number; end: number } {
  let depth = 0
  let commas = 0
  let sawContent = false
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]!
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return { argCount: sawContent ? commas + 1 : 0, end: i + 1 }
      continue
    }
    if (ch === ',' && depth === 1) {
      commas++
      continue
    }
    if (depth === 1 && !/\s/.test(ch)) sawContent = true
  }
  return { argCount: sawContent ? commas + 1 : 0, end: masked.length }
}

/** Every `namespace.member` in `source`, in source order. This one scan backs completion,
 * idiom classification, origin-sensitivity, arity checking and the spans a renderer underlines
 * -- one mechanism, so those five cannot disagree about what the text says. */
export function scanMolang(source: string): MolangRef[] {
  const masked = maskStrings(source)
  const refs: MolangRef[] = []
  REF_PATTERN.lastIndex = 0
  for (let m = REF_PATTERN.exec(masked); m !== null; m = REF_PATTERN.exec(masked)) {
    const namespaceText = m[1]!
    const namespace = NAMESPACE_ALIASES[namespaceText]
    // Not a namespace: `some_ident.field` is not Molang this tool knows, and guessing at it
    // would produce diagnostics about names that are not names.
    if (namespace === undefined) continue
    const member = m[2]!
    let cursor = m.index + m[0].length
    let argCount: number | null = null
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++
    if (masked[cursor] === '(') {
      const call = scanCall(masked, cursor)
      argCount = call.argCount
      cursor = call.end
      while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++
    }
    // `=` but not `==`. A comparison puts its own operator before the `=` (`v.x >= 1`), so the
    // character immediately after an identifier is only ever `=` for a real assignment.
    const write = masked[cursor] === '=' && masked[cursor + 1] !== '='
    refs.push({ namespace, member, namespaceText, offset: m.index, length: m[0].length, argCount, write })
  }
  return refs
}

/** True when `source` contains a `;` outside a string, i.e. it is a statement SEQUENCE rather
 * than a single expression. Load-bearing: a sequence with no `return` evaluates to 0 (proven by
 * molang-go's own TestStatementSequenceDefaultsToZero), which is exactly how an author writing
 * the setup idiom accidentally turns their scatter off. */
export function isStatementSequence(source: string): boolean {
  return maskStrings(source).includes(';')
}

const RETURN_PATTERN = /\breturn\b/

export function hasReturn(source: string): boolean {
  return RETURN_PATTERN.test(maskStrings(source))
}

/** The three things real packs use a scatter's `iterations` for. Not exclusive -- the useful
 * expressions are usually two of them at once -- so analyseIterations returns a set. */
export type IterationsIdiom = 'count' | 'condition' | 'setup'

export interface IdiomAnalysis {
  idioms: readonly IterationsIdiom[]
  /** `variable.*` names this expression assigns, in source order, de-duplicated. These are the
   * whole point of the setup idiom: the scatter's Molang scope is shared BY REFERENCE with
   * everything it delegates to, so a name written here is readable by the placed feature. */
  writes: readonly string[]
  /** The numeric value when the whole expression is a bare number literal, else null. The one
   * case where a stepper is a lossless representation of the text. */
  constant: number | null
  /** True when the expression is a sequence with no `return`, which evaluates to 0. */
  sequenceWithoutReturn: boolean
  /** True when any math.* RNG function is called: a zero from this expression is luck. */
  random: boolean
}

const COMPARISON_PATTERN = /(==|!=|>=|<=|&&|\|\||[<>])|\?[^?]/

/** Classifies an `iterations` expression by what the author is USING it for. This is a reading
 * of the text, never a verdict on it: it drives which explanation the editor leads with, and
 * nothing about it is enforced. A count and a condition and a setup step are all legal in the
 * same string, which is why the caller gets a set and not a mode. */
export function analyseIterations(source: string): IdiomAnalysis {
  const trimmed = source.trim()
  const refs = scanMolang(source)
  const writes: string[] = []
  for (const ref of refs) {
    if (ref.write && ref.namespace === 'variable' && !writes.includes(ref.member)) writes.push(ref.member)
  }
  const masked = maskStrings(source)
  const idioms: IterationsIdiom[] = []
  const constant = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : null
  // A comparison, a logical operator or a ternary means the expression is deciding something.
  // `(q.noise(...) > 0.4) * 8` is the canonical shape: eight iterations where the noise is high
  // and zero -- the engine's own distinctly-diagnosed "iterations evaluated to zero" -- where
  // it is not.
  if (COMPARISON_PATTERN.test(masked)) idioms.push('condition')
  if (writes.length > 0) idioms.push('setup')
  // Counting is the residual: anything that is not purely a gate or purely assignments still
  // produces a number the scatter loops on. A bare literal counts; so does `v.originy / 4`.
  const sequenceWithoutReturn = isStatementSequence(source) && !hasReturn(source)
  if (trimmed.length > 0 && !sequenceWithoutReturn && (idioms.length === 0 || constant !== null || refs.some((r) => !r.write))) {
    if (!idioms.includes('count')) idioms.unshift('count')
  }
  const random = refs.some((r) => r.namespace === 'math' && RANDOM_MATH_FNS.has(r.member))
  return { idioms, writes, constant, sequenceWithoutReturn, random }
}

/** Whether the expression's value can change with WHERE the feature is placed. molangEdge.ts
 * refuses to describe an expression as zero-everywhere while this is true -- see its
 * explainZero. Any published variable counts (they are all the origin), as do the three
 * coordinate queries; a read of an author's own `variable.*` counts too, conservatively,
 * because whatever wrote it upstream may well have read the origin. */
export function isOriginSensitive(refs: readonly MolangRef[]): boolean {
  return refs.some((ref) => {
    if (ref.namespace === 'variable' || ref.namespace === 'temp' || ref.namespace === 'context') return !ref.write
    if (ref.namespace !== 'query') return false
    return WORLDGEN_QUERIES.some((q) => q.name === ref.member && q.originSensitive)
  })
}

/** Whether the expression reads the biome, i.e. changes with the Biome control rather than the
 * origin one. Kept separate so a zero can be attributed to the control that actually governs
 * it instead of sending the author to the wrong one. */
export function isBiomeSensitive(refs: readonly MolangRef[]): boolean {
  return refs.some(
    (ref) => ref.namespace === 'query' && WORLDGEN_QUERIES.some((q) => q.name === ref.member && q.biomeSensitive),
  )
}

export type LocalProblemCode =
  | 'unreachable-query'
  | 'query-arity'
  | 'biome-tag-y-zero'
  | 'math-arity'
  | 'world-var-in-iterations'
  | 'sequence-without-return'
  | 'empty-required'

export interface LocalProblem {
  code: LocalProblemCode
  severity: 'error' | 'warning' | 'info'
  message: string
  /** Where in the expression to underline. Absent for problems about the expression as a
   * whole. */
  span?: { offset: number; length: number }
}

/** Everything wrong with an expression that its own text proves, with no pack loaded and no
 * engine running. Deliberately a short list: these are the checks that are DECIDABLE from the
 * text, so they can be wrong only if this file's catalogue is wrong. Anything needing to know
 * what the rest of the graph writes -- above all "this reads a name nothing ever writes", the
 * commonest real bug -- belongs to the Go validator and arrives through
 * molangEdge.ts's MolangEdgeValidator instead. */
export function localProblems(source: string, field: MolangEdgeField): LocalProblem[] {
  const problems: LocalProblem[] = []
  const refs = scanMolang(source)
  for (const ref of refs) {
    const span = { offset: ref.offset, length: ref.length }
    if (ref.namespace === 'query') {
      const hint = WORLDGEN_QUERIES.find((q) => q.name === ref.member)
      if (hint === undefined) {
        problems.push({
          code: 'unreachable-query',
          severity: 'error',
          message:
            `query.${ref.member} is not one of the six queries worldgen registers ` +
            `(${WORLDGEN_QUERIES.map((q) => q.name).join(', ')}). The game rejects an unknown query ` +
            'name while tokenizing -- "Failed to resolve query" -- so this file would fail to load ' +
            'outright. This tool reads it as 0 and keeps going, which is why nothing else will tell you.',
          span,
        })
        continue
      }
      // A wrong count is checked against the discrete set when there is one, because
      // has_biome_tag accepts 1, 3 and 4 but not 2, and a range cannot express a hole.
      const badCount =
        ref.argCount !== null &&
        (hint.argCounts !== undefined
          ? !hint.argCounts.includes(ref.argCount)
          : ref.argCount < hint.minArgs || (hint.maxArgs !== null && ref.argCount > hint.maxArgs))
      if (badCount) {
        const want =
          hint.argCounts !== undefined
            ? `${hint.argCounts.slice(0, -1).join(', ')} or ${hint.argCounts[hint.argCounts.length - 1]}`
            : hint.maxArgs === null
              ? `at least ${hint.minArgs}`
              : `exactly ${hint.minArgs}`
        problems.push({
          code: 'query-arity',
          severity: 'warning',
          message:
            `${hint.signature} takes ${want} argument(s); this call passes ${ref.argCount}. The engine ` +
            'does not error on a wrong count -- it answers 0 -- so the expression silently collapses ' +
            'rather than failing.',
          span,
        })
      }
      // The three-argument form is accepted by the engine, so it is not an arity problem, and
      // it is the single most expensive mistake available in a biome-blend expression: it
      // reads as "the biome at this column" and is really "the biome at y=0". Worth its own
      // message rather than a line buried in the hover, because the symptom -- a blend that
      // is patchy in a way that follows cave noise -- gives no hint of where to look.
      if (ref.member === 'has_biome_tag' && ref.argCount === 3) {
        problems.push({
          code: 'biome-tag-y-zero',
          severity: 'warning',
          message:
            "query.has_biome_tag('tag', x, z) does not sample at this column's height -- it forces " +
            'y to 0, far underground, where it answers about cave biomes instead of the surface. ' +
            "Pass an explicit height as well: has_biome_tag('tag', x, y, z). Be aware that a fixed " +
            'number is not a safe height either: which biome answers at a given y depends on the ' +
            'terrain as well as on y, so one constant lands in the right band at some columns and ' +
            'in a neighbouring biome at others. A height taken from the column itself -- ' +
            'query.above_top_solid(x, z) plus a little -- holds still where a constant does not.',
          span,
        })
      }
      continue
    }
    if (ref.namespace === 'math' && ref.argCount !== null) {
      const arity = MATH_ARITY[ref.member]
      if (arity !== undefined && ref.argCount !== arity) {
        problems.push({
          code: 'math-arity',
          severity: 'warning',
          message: `math.${ref.member} takes ${arity} argument(s); this call passes ${ref.argCount}.`,
          span,
        })
      }
      continue
    }
    if (ref.namespace === 'variable' && !ref.write && field === 'iterations') {
      const hint = PUBLISHED_VARIABLES.find((v) => v.name === ref.member)
      if (hint !== undefined && hint.availability.iterations === 'stale') {
        problems.push({
          code: 'world-var-in-iterations',
          severity: 'warning',
          message:
            `variable.${ref.member} is not this scatter's position here. A scatter publishes only ` +
            'originx/originy/originz before evaluating iterations; worldx/worldy/worldz are written ' +
            'per axis, per iteration, AFTER this runs -- so this reads whatever an enclosing ' +
            `distribution last left there. Use variable.${ref.member.replace('world', 'origin')} instead.`,
          span,
        })
      }
    }
  }
  if (source.trim().length === 0) {
    if (field === 'iterations') {
      problems.push({
        code: 'empty-required',
        severity: 'error',
        message: 'iterations is required -- a scatter_feature cannot load without it.',
      })
    }
    return problems
  }
  if (field === 'iterations' && isStatementSequence(source) && !hasReturn(source)) {
    problems.push({
      code: 'sequence-without-return',
      severity: 'warning',
      message:
        'This is a statement sequence with no `return`, and a sequence without one evaluates to 0 -- ' +
        'so the scatter places nothing. That is deliberate when the expression is a setup step used ' +
        'as an off switch; if you meant to set variables AND count, end it with `return <count>;`.',
    })
  }
  return problems
}

export type CompletionKind = 'query' | 'variable' | 'math' | 'namespace'

export interface MolangCompletion {
  label: string
  /** The text to put in place of [replaceOffset, replaceOffset+replaceLength). */
  insertText: string
  replaceOffset: number
  replaceLength: number
  kind: CompletionKind
  detail: string
  documentation: string
}

export interface HintContext {
  field: MolangEdgeField
  /** `variable.*` names something UPSTREAM of this edge writes, as reported by the Go validator
   * (MolangValidateResponse.scopeWrites). Offered alongside the engine's own published six so
   * an author can complete the name a parent scatter's iterations set up -- which is the whole
   * payoff of the setup idiom, and unusable if you have to remember the spelling. Names here
   * are real observations of the graph, never guesses. */
  scopeWrites?: readonly string[]
}

const IDENT_CHARS = /[A-Za-z0-9_.]/

/** The `namespace.member` fragment the caret sits in, as an offset range plus its parts. */
function tokenAt(source: string, offset: number): { start: number; namespaceText: string | null; partial: string } {
  let start = offset
  while (start > 0 && IDENT_CHARS.test(source[start - 1]!)) start--
  const text = source.slice(start, offset)
  const dot = text.indexOf('.')
  if (dot < 0) return { start, namespaceText: null, partial: text }
  return { start, namespaceText: text.slice(0, dot), partial: text.slice(dot + 1) }
}

function matches(candidate: string, partial: string): boolean {
  if (partial.length === 0) return true
  const lower = candidate.toLowerCase()
  const needle = partial.toLowerCase()
  return lower.startsWith(needle) || lower.includes(needle)
}

/** Completion for the caret at `offset`. Two shapes, because authors type both:
 *
 *   - after a namespace (`v.ori|`) -- members of that namespace only, replacing just the member
 *     so the author's chosen spelling of the namespace survives;
 *   - bare (`nois|`) -- fully-qualified names whose member matches, plus the namespace stems,
 *     replacing the whole fragment.
 *
 * Every candidate is a name the engine actually answers: the six worldgen queries, the six
 * published variables, whatever the validator observed written upstream, and the math library.
 * Nothing is offered from the entity-side Molang catalogue, however familiar it looks. */
export function completionsAt(source: string, offset: number, ctx: HintContext): MolangCompletion[] {
  const { start, namespaceText, partial } = tokenAt(source, offset)
  const out: MolangCompletion[] = []

  const variableDocs = (name: string): { detail: string; documentation: string } => {
    const published = PUBLISHED_VARIABLES.find((v) => v.name === name)
    if (published === undefined) {
      return {
        detail: 'variable (written upstream)',
        documentation:
          'Written by a feature earlier in this delegation chain. The Molang scope is shared by ' +
          'reference all the way down, so its value reaches here.',
      }
    }
    const availability = published.availability[ctx.field]
    return {
      detail: availability === 'published' ? 'variable (published by the engine)' : 'variable (NOT set here)',
      documentation:
        availability === 'published'
          ? published.doc
          : `${published.doc} -- but on an iterations expression this is written per axis, per ` +
            'iteration, AFTER this runs, so reading it here does not give this scatter\'s position.',
    }
  }

  const variableNames = [...PUBLISHED_VARIABLES.map((v) => v.name), ...(ctx.scopeWrites ?? [])].filter(
    (name, i, all) => all.indexOf(name) === i,
  )

  if (namespaceText !== null) {
    const namespace = NAMESPACE_ALIASES[namespaceText]
    if (namespace === undefined) return out
    const replaceOffset = start + namespaceText.length + 1
    const replaceLength = offset - replaceOffset
    if (namespace === 'query') {
      for (const q of WORLDGEN_QUERIES) {
        if (!matches(q.name, partial)) continue
        out.push({
          label: q.name,
          insertText: q.name,
          replaceOffset,
          replaceLength,
          kind: 'query',
          detail: q.signature,
          documentation: q.doc,
        })
      }
    } else if (namespace === 'variable') {
      for (const name of variableNames) {
        if (!matches(name, partial)) continue
        out.push({ label: name, insertText: name, replaceOffset, replaceLength, kind: 'variable', ...variableDocs(name) })
      }
    } else if (namespace === 'math') {
      for (const [name, arity] of Object.entries(MATH_ARITY)) {
        if (!matches(name, partial)) continue
        out.push({
          label: name,
          insertText: name,
          replaceOffset,
          replaceLength,
          kind: 'math',
          detail: `math.${name}(${arity} args)`,
          documentation: RANDOM_MATH_FNS.has(name) ? 'Draws from the run\'s RNG: re-rolled every run.' : '',
        })
      }
    }
    return out
  }

  const replaceLength = offset - start
  for (const q of WORLDGEN_QUERIES) {
    if (!matches(q.name, partial)) continue
    out.push({
      label: `query.${q.name}`,
      insertText: `query.${q.name}`,
      replaceOffset: start,
      replaceLength,
      kind: 'query',
      detail: q.signature,
      documentation: q.doc,
    })
  }
  for (const name of variableNames) {
    if (!matches(name, partial)) continue
    out.push({
      label: `variable.${name}`,
      insertText: `variable.${name}`,
      replaceOffset: start,
      replaceLength,
      kind: 'variable',
      ...variableDocs(name),
    })
  }
  for (const stem of ['query.', 'variable.', 'math.']) {
    if (!matches(stem, partial)) continue
    out.push({
      label: stem,
      insertText: stem,
      replaceOffset: start,
      replaceLength,
      kind: 'namespace',
      detail: 'namespace',
      documentation: '',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/** What a run of source text IS, for colouring.
 *
 * The distinction that earns this its own type rather than reusing CompletionKind is
 * `query-unknown`. A `query.` name the engine does not register is not an unrecognised name to be
 * left alone -- the real game refuses to tokenize the file that carries it, and localProblems
 * already reports it as an ERROR. Colouring it like the six that exist would have the editor
 * telling the author two different things about the same word, and the more prominent of the two
 * would be the wrong one. So the highlighter agrees with the diagnostic, by construction.
 *
 * `variable-other` is the opposite case and is the reason it is not simply 'unknown': an author's
 * own `variable.trunk_height` is entirely legal, merely not something this catalogue can vouch
 * for. It is drawn in the plain foreground -- not coloured as if the catalogue had confirmed it,
 * not marked as if it were wrong. */
export type MolangHighlightKind =
  | 'string'
  | 'number'
  | 'operator'
  | 'punct'
  | 'keyword'
  | 'query'
  | 'query-unknown'
  | 'variable'
  | 'variable-other'
  | 'function'
  | 'plain'

export interface MolangHighlightSpan {
  offset: number
  length: number
  kind: MolangHighlightKind
}

/** Molang's own words, which are not `namespace.member` reads and must not be coloured as if the
 * author had written a name. `loop` and `for_each` take a block; the rest are bare. */
const MOLANG_KEYWORDS: ReadonlySet<string> = new Set(['return', 'loop', 'for_each', 'break', 'continue', 'this'])

/**
 * Classifies every token in `source` for a syntax highlighter.
 *
 * Spans cover the tokens only, in source order and without overlapping; whatever lies between two
 * of them is whitespace and is the caller's to emit verbatim. Offsets are into `source` exactly as
 * given, which is what lets a highlighted layer be laid behind a textarea holding the same string.
 *
 * The scan is the LENIENT one (see molangFormat.ts): a field being typed into holds invalid text
 * most of the time -- `v.`, a string with no closing quote -- and a highlighter that gave up on
 * those would blink the colour off under the author's hands. Text the scanner cannot classify
 * comes back as 'plain', which is what it would have looked like with no highlighter at all.
 */
export function highlightMolang(source: string, ctx?: HintContext): MolangHighlightSpan[] {
  const tokens = tokenizeMolang(source, { lenient: true }) ?? []
  const known = new Set<string>([...PUBLISHED_VARIABLES.map((v) => v.name), ...(ctx?.scopeWrites ?? [])])
  const spans: MolangHighlightSpan[] = []
  for (const token of tokens) {
    spans.push({ offset: token.offset, length: token.text.length, kind: kindOf(token, known) })
  }
  return spans
}

function kindOf(token: MolangToken, knownVariables: ReadonlySet<string>): MolangHighlightKind {
  switch (token.kind) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'operator':
      return 'operator'
    case 'punct':
      return 'punct'
    case 'unknown':
      return 'plain'
    default:
      break
  }
  const dot = token.text.indexOf('.')
  if (dot < 0) return MOLANG_KEYWORDS.has(token.text.toLowerCase()) ? 'keyword' : 'plain'
  const namespace = NAMESPACE_ALIASES[token.text.slice(0, dot)]
  // Everything after the FIRST dot, so `variable.a.b` is judged on `a.b` and not silently
  // truncated to something the catalogue happens to know.
  const member = token.text.slice(dot + 1)
  if (namespace === 'query') {
    return WORLDGEN_QUERIES.some((q) => q.name === member) ? 'query' : 'query-unknown'
  }
  if (namespace === 'variable' || namespace === 'temp') {
    return knownVariables.has(member) ? 'variable' : 'variable-other'
  }
  // math.ease_* and friends are real functions this catalogue deliberately omits (see MATH_ARITY),
  // so an unlisted math name is drawn plain rather than flagged -- the same rule checkArity
  // follows, and for the same reason: never report a name as wrong on the strength of a list that
  // says it is incomplete.
  if (namespace === 'math') return MATH_ARITY[member] === undefined ? 'plain' : 'function'
  return 'plain'
}
