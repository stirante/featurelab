// column.ts -- the `column` compound: one feature at every level between two heights.
//
// This is the two column idioms, merged under ColumnParams.order
// exactly as spec.ts describes. The merge is only legitimate BECAUSE `order` is a parameter: the
// two classes are not two spellings of one shape, they build the column from opposite ends, and
// features/distribution.go says why in its own words.
//
// THE DIRECTION, since it is the one thing here that is easy to get backwards. The `fixed_grid`
// arithmetic READS as ascending -- `modulus = max - min + 1`, `indexed = gridOffset + min +
// index*stepSize` (features/distribution.go:541-570) -- but what feeds `index` is the scatter's
// own iteration counter, and that counter COUNTS DOWN: `index := iterations - 1 - i`
// (features/distribution.go:834), with the comment there recording that the game's position
// generator passes the POST-decrement value, and that this holds in two game versions. So the
// grid shape walks the column from the TOP. The counter shape, which increments a variable of its
// own once per iteration, walks it from the BOTTOM. Same levels, opposite order, and by that same
// comment's account the order decides which placement wins an overlapping cell, the order children
// draw RNG, and the position the scatter finally returns.
//
// That is why `levelVariable` or `step` under `order: 'top-down'` is a REFUSAL here and never a
// quiet promotion to the counter shape. Only the counter shape has a per-iteration slot to put
// them in, and reaching for it on the author's behalf would silently reverse the world they get.
//
// THE HALF-OPEN RANGE. `iterations = max - min`, so the levels placed are minY .. maxY-1. That is
// what the idiom computes and this reproduces it rather than quietly adding a 1; every shape
// carries a note saying so, because the field name does not.
//
// THE FORMAT-VERSION GATE. scatter_feature's parameters move into a nested `distribution` object
// at 1.21.10 (features/scatter.go, and typeCatalog.ts's `since`/`until` on the same keys). The two
// spellings are mutually exclusive and writing the wrong one is not diagnosed usefully -- the
// engine drops the unknown member unread and then fails on the missing required `iterations` -- so
// every scatter this module writes is gated on the version it was handed, the same way idioms.ts's
// scatterWrapperBody gates. A version string that cannot be parsed is a refusal, not a throw.
import type { PlanNote, PlanOperation, Refusal, RefusalCode } from '../idioms.js'
import { atLeastOrUnversioned, parseFormatVersion, type FormatVersion } from '../typeCatalog.js'
import { CHILD_ROLES } from './spec.js'
import type { ColumnOrder, ColumnParams, CompoundResult, CompoundSpec } from './spec.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCATTER_TYPE_ID = 'minecraft:scatter_feature'

/** The format_version at which scatter's parameters moved into a nested `distribution` object.
 * The same constant idioms.ts keeps, for the same reason and with the same value. */
const SCATTER_DISTRIBUTION_SINCE = '1.21.10'

/** A Molang identifier -- the part after `v.` / `t.`. */
const MOLANG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A BARE numeric literal: optional sign, digits, optional fraction, and nothing else.
 *
 * Deliberately narrow. The single-scatter shape is only correct when minY is KNOWN to be zero, and
 * "known" means readable off the text -- `v.base`, `(0)` and `q.x - q.x` all take the offset shape
 * even though the last two evaluate to zero, because assuming a non-literal is zero is silently
 * wrong and the offset shape is correct either way. No exponent form: `1e0` is not something this
 * needs to recognise, and the offset shape handles it correctly anyway. */
const BARE_NUMBER = /^[+-]?\d+(?:\.\d*)?$/

/** Namespaces a compound may seed a counter in. `q.`/`query.` is read-only, and anything else is
 * not a variable namespace at all. */
const ASSIGNABLE_PREFIXES: ReadonlySet<string> = new Set(['v', 'variable', 't', 'temp'])

/** The temp namespaces, which are scoped to ONE evaluation. Legal here -- the placed feature is
 * reached from inside that evaluation -- but worth a sentence, because a name that vanishes at the
 * scatter boundary reads like a name that does not. */
const TEMP_PREFIXES: ReadonlySet<string> = new Set(['t', 'temp'])

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function refusal(code: RefusalCode, reason: string, nodes?: readonly string[]): Refusal {
  return nodes === undefined ? { code, reason } : { code, reason, nodes }
}

function no(code: RefusalCode, reason: string, nodes?: readonly string[]): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: refusal(code, reason, nodes) }
}

function bareId(identifier: string): string {
  return identifier.includes(':') ? identifier.slice(identifier.indexOf(':') + 1) : identifier
}

/** The identifier as it may appear inside a Molang name: namespace stripped, `.` replaced by `_`.
 * The same normalisation spec.ts's compoundVariable applies, and for the same reason -- a `.` in
 * an identifier would otherwise read as a namespace separator in the generated variable. */
function safeId(identifier: string): string {
  return bareId(identifier).split('.').join('_')
}

/** `features/<bare id>.json` -- the convention pack.Load walks and every fixture in this repo
 * follows. The namespace is dropped because a `:` is not a filename on every platform this runs
 * on, and because that is the layout packs conventionally use. */
function featureFile(identifier: string): string {
  return `features/${bareId(identifier)}.json`
}

/**
 * The four variables a column's parts talk to each other through.
 *
 * Exported because a collapsed node has to be able to TELL the author these names: they are the
 * only handle the placed feature has on the column, and nothing in the generated JSON says where
 * they came from. `level` is the counter shape's default; a `levelVariable` overrides it.
 */
export function columnVariables(identifier: string): {
  readonly min: string
  readonly max: string
  readonly iterations: string
  readonly level: string
} {
  const id = safeId(identifier)
  return {
    min: `v.${id}__min`,
    max: `v.${id}__max`,
    iterations: `v.${id}__iterations`,
    level: `v.${id}__item`,
  }
}

/** An author's script, normalised into a prefix that can be concatenated ahead of more statements.
 *
 * The terminating `;` is ADDED when it is missing rather than assumed present. Concatenating
 * `v.a = 1` with `v.x__min = 0;` produces one expression that does not parse, and the author's
 * only symptom would be a feature that stopped loading after an edit they did not make. */
function statementPrefix(script: string | undefined): string {
  const text = (script ?? '').trim()
  if (text.length === 0) return ''
  return text.endsWith(';') ? `${text} ` : `${text}; `
}

/** "namespace:identifier", checked exactly as far as this can honestly be checked: one colon, two
 * non-empty halves, no whitespace. Nothing here invents a character class the game enforces. */
function malformedIdReason(id: string): string | null {
  if (id.length === 0) return 'a column needs an identifier.'
  const colon = id.indexOf(':')
  if (colon < 0) return `"${id}" has no namespace. Feature identifiers are "namespace:identifier", and a bare name resolves against nothing.`
  if (colon === 0 || colon === id.length - 1) return `"${id}" has an empty half; feature identifiers are "namespace:identifier".`
  if (id.indexOf(':', colon + 1) >= 0) return `"${id}" has more than one ":".`
  if (/\s/.test(id)) return `"${id}" contains whitespace.`
  return null
}

/** A complete feature file, byte-compatible with what idioms.ts writes: `description.identifier`
 * first inside the body, two-space indent, trailing newline. A generated file that reads unlike
 * the hand-written ones beside it is a generated file people rewrite by hand. */
function featureFileContents(identifier: string, formatVersion: string, body: Record<string, unknown>): string {
  const document = {
    format_version: formatVersion,
    [SCATTER_TYPE_ID]: { description: { identifier }, ...body },
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** One scatter file's operation, with the distribution parameters written in whichever of the two
 * spellings this format_version uses. */
function scatterFile(
  identifier: string,
  formatVersion: string,
  nested: boolean,
  places: string,
  parameters: Record<string, unknown>,
): PlanOperation {
  const body: Record<string, unknown> = nested
    ? { places_feature: places, distribution: { ...parameters } }
    : { places_feature: places, ...parameters }
  return {
    op: 'createFile',
    file: featureFile(identifier),
    identifier,
    typeId: SCATTER_TYPE_ID,
    contents: featureFileContents(identifier, formatVersion, body),
  }
}

/** The `fixed_grid` y axis: one cell per level, over a Molang extent. */
function fixedGridAxis(iterationsVariable: string): Record<string, unknown> {
  return { distribution: 'fixed_grid', extent: [0, `${iterationsVariable} - 1`] }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Validated = { readonly ok: true; readonly params: ColumnParams } | { readonly ok: false; readonly refusal: Refusal }

/** Whether `text` is a bare numeric literal worth exactly zero. */
function isLiteralZero(text: string): boolean {
  const trimmed = text.trim()
  return BARE_NUMBER.test(trimmed) && Number(trimmed) === 0
}

function optionalMolang(value: unknown, field: string): { ok: true; value: string | undefined } | { ok: false; refusal: Refusal } {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string') {
    return no('molang-invalid', `a column's "${field}" is Molang, written as a string; this one is a ${typeof value}.`)
  }
  // An all-whitespace script is not a script. Reading it as absent is the only answer that keeps
  // expand total without emitting an empty statement into the generated expression.
  return { ok: true, value: value.trim().length === 0 ? undefined : value }
}

/**
 * Rejects malformed parameters without throwing, including the cross-field rules -- `levelVariable`
 * and `step` belong to the counter shape and nowhere else.
 *
 * NOTE ON THE REFUSAL CODES. idioms.ts's `RefusalCode` is a closed union written for the four
 * graph actions, and it has no member meaning "these compound parameters are not usable". Rather
 * than widen a frozen contract from a leaf module, every parameter-shape refusal here reuses the
 * nearest existing code -- `molang-invalid` for the Molang-valued fields and the overall shape,
 * `id-malformed` for the feature reference, `order-sensitive` for the two cross-field rules, which
 * is the one place the borrowed name says exactly the right thing. The `reason` is the entire
 * user-visible product of a refusal, so each one is a whole sentence that stands on its own.
 */
export function validateColumnParams(value: unknown): Validated {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return no('molang-invalid', 'a column\'s parameters must be an object with at least a "places" and a "maxY".')
  }
  const raw = value as Record<string, unknown>

  const places = raw['places']
  if (typeof places !== 'string') {
    return no('id-malformed', 'a column needs a "places": the feature to put at every level, as "namespace:identifier".')
  }
  const malformed = malformedIdReason(places.trim())
  if (malformed !== null) return no('id-malformed', `a column places ${malformed}`)

  const maxY = raw['maxY']
  if (typeof maxY !== 'string' || maxY.trim().length === 0) {
    return no('molang-invalid', 'a column needs a "maxY": the exclusive upper bound, as Molang. Without one there is nothing to count.')
  }

  const minY = optionalMolang(raw['minY'], 'minY')
  if (!minY.ok) return minY
  const setup = optionalMolang(raw['setup'], 'setup')
  if (!setup.ok) return setup
  const step = optionalMolang(raw['step'], 'step')
  if (!step.ok) return step

  const orderRaw = raw['order']
  if (orderRaw !== undefined && orderRaw !== 'top-down' && orderRaw !== 'bottom-up') {
    return no(
      'molang-invalid',
      `"${String(orderRaw)}" is not a column order. It is "top-down" (the fixed_grid shape, the default) or "bottom-up" ` +
        '(the counter shape), and the two build the column from opposite ends.',
    )
  }
  const order: ColumnOrder = orderRaw === 'bottom-up' ? 'bottom-up' : 'top-down'

  const levelRaw = raw['levelVariable']
  if (levelRaw !== undefined && typeof levelRaw !== 'string') {
    return no('molang-invalid', `a column's "levelVariable" is a variable name, written as a string; this one is a ${typeof levelRaw}.`)
  }
  const levelVariable = levelRaw === undefined || levelRaw.trim().length === 0 ? undefined : levelRaw.trim()
  if (levelRaw !== undefined && levelVariable === undefined) {
    return no('molang-invalid', 'a column\'s "levelVariable" was given as an empty string. Leave it out to use the default name, or name it.')
  }

  // The two cross-field rules. Both are refusals and never a silent switch to the other shape:
  // the shapes place the column in opposite orders, so satisfying one field by flipping `order`
  // would hand the author a different world than the one they asked for.
  if (order === 'top-down' && levelVariable !== undefined) {
    return no(
      'order-sensitive',
      'a "levelVariable" needs order: "bottom-up". The top-down shape is a fixed_grid on the y axis: nothing runs per iteration, ' +
        'so there is no counter to expose and the placed feature cannot be told which level it is on. Switching the order for you ' +
        'would reverse which placement wins an overlapping cell and the order the levels draw RNG, so set it yourself if that is ' +
        'what you want.',
    )
  }
  if (order === 'top-down' && step.value !== undefined) {
    return no(
      'order-sensitive',
      'a per-level "step" script needs order: "bottom-up". The top-down shape has no per-iteration slot to run it in -- its y axis ' +
        'is a distribution, not an expression -- and switching the order for you would reverse the order the column is built in.',
    )
  }

  if (levelVariable !== undefined) {
    const levelReference = resolveLevelVariable(levelVariable)
    if (!levelReference.ok) return levelReference
  }

  const params: ColumnParams = {
    places: places.trim(),
    maxY,
    ...(minY.value === undefined ? {} : { minY: minY.value }),
    ...(setup.value === undefined ? {} : { setup: setup.value }),
    ...(orderRaw === undefined ? {} : { order }),
    ...(levelVariable === undefined ? {} : { levelVariable }),
    ...(step.value === undefined ? {} : { step: step.value }),
  }
  return { ok: true, params }
}

interface LevelReference {
  readonly ok: true
  /** The full Molang reference, ready to write. */
  readonly reference: string
  /** True for `t.`/`temp.`, which is legal and worth a note. */
  readonly temp: boolean
}

/**
 * Turns a `levelVariable` into the reference the generated Molang writes.
 *
 * A bare name gets `v.`, which is what the idiom does and the only namespace that is certainly
 * readable from the placed feature. An explicit namespace is honoured as typed so an author who
 * shares a counter with something else can say so. `q.`/`query.` is refused rather than written:
 * the column ASSIGNS this name once per iteration, and a query is read-only, so the generated
 * expression would not load at all.
 */
function resolveLevelVariable(name: string): LevelReference | { ok: false; refusal: Refusal } {
  const dot = name.indexOf('.')
  if (dot < 0) {
    if (!MOLANG_NAME.test(name)) {
      return no('molang-invalid', `"${name}" is not a Molang identifier, so \`v.${name}\` would not parse.`)
    }
    return { ok: true, reference: `v.${name}`, temp: false }
  }
  const prefix = name.slice(0, dot).toLowerCase()
  const rest = name.slice(dot + 1)
  if (!ASSIGNABLE_PREFIXES.has(prefix)) {
    return no(
      'molang-invalid',
      `"${name}" cannot be assigned. A column writes its level counter once per iteration, so the name has to live in ` +
        'variable.* (v.*) or temp.* (t.*); query.* is read-only and anything else is not a variable namespace.',
    )
  }
  if (!MOLANG_NAME.test(rest)) {
    return no('molang-invalid', `"${name}" is not a Molang variable name -- "${rest}" is not an identifier.`)
  }
  return { ok: true, reference: name, temp: TEMP_PREFIXES.has(prefix) }
}

/** The format_version the generated files declare. Present and parseable, or a refusal -- a new
 * feature file MUST declare one (it decides which keys the file's type even accepts), and a
 * version this module cannot read is a version it must not gate on. */
function resolveVersion(formatVersion: string): { ok: true; version: FormatVersion } | { ok: false; refusal: Refusal } {
  let parsed: FormatVersion
  try {
    parsed = parseFormatVersion(formatVersion)
  } catch (err) {
    return no(
      'no-format-version',
      `"${formatVersion}" is not a format_version this can read (${err instanceof Error ? err.message : String(err)}). ` +
        'It decides whether a scatter\'s parameters are flat keys or members of a nested "distribution" object, and the two are ' +
        'mutually exclusive, so nothing is generated until it is readable.',
    )
  }
  if (!parsed.present) {
    return no(
      'no-format-version',
      'a column\'s generated files must declare a format_version, and none was passed. It decides whether a scatter writes its ' +
        'parameters flat or inside a nested "distribution" object -- writing the wrong one fails on a missing "iterations" with no ' +
        'useful diagnostic -- so it is not a detail this can pick.',
    )
  }
  return { ok: true, version: parsed }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function halfOpenNote(minExpression: string, maxExpression: string): PlanNote {
  return {
    level: 'info',
    message:
      `The range is half-open. iterations is (${maxExpression}) - (${minExpression}), so the levels placed run from ${minExpression} ` +
      `up to but NOT including ${maxExpression}. That is what the idiom computes and this reproduces it; the top level is left out.`,
  }
}

const TOP_DOWN_DIRECTION_NOTE: PlanNote = {
  level: 'info',
  message:
    'The y axis is a fixed_grid over [0, iterations - 1], and the scatter walks a grid with a DESCENDING iteration index -- the ' +
    'engine passes its post-decrement counter -- so this column is built from the TOP down. Nothing runs per iteration in this ' +
    'shape, so the placed feature cannot read which level it is on; order: "bottom-up" is the shape that can tell it.',
}

const STEP_SIZE_NOTE: PlanNote = {
  level: 'warning',
  message:
    'No step_size is written, so the fixed_grid axis relies on the default of 1 -- and that default is NOT established. It is ' +
    'simply the only value that leaves a bare grid axis non-degenerate, which matches how grid columns are written in practice. If the ' +
    'real default turns out to differ, every top-down column moves. The counter shape does not touch fixed_grid at all.',
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

function expandColumn(identifier: string, params: ColumnParams, formatVersion: string): CompoundResult {
  const badIdentifier = malformedIdReason(identifier)
  if (badIdentifier !== null) return no('id-malformed', `a column's own identifier is malformed: ${badIdentifier}`)

  // Re-validated rather than trusted. `expand` is required to be TOTAL, and its parameter is a
  // compile-time type: a caller that decoded an annotation and cast it reaches here with anything.
  const validated = validateColumnParams(params)
  if (!validated.ok) return validated
  const checked = validated.params

  const resolvedVersion = resolveVersion(formatVersion)
  if (!resolvedVersion.ok) return resolvedVersion
  const nested = atLeastOrUnversioned(resolvedVersion.version, SCATTER_DISTRIBUTION_SINCE)

  if (checked.places === identifier) {
    return no(
      'cycle',
      `a column cannot place itself. "${identifier}" would delegate to "${identifier}", and the engine's recursion guard, not this ` +
        'column, would decide how deep it got.',
      [identifier],
    )
  }

  const order: ColumnOrder = checked.order ?? 'top-down'
  const variables = columnVariables(identifier)
  const setup = statementPrefix(checked.setup)
  const maxExpression = checked.maxY.trim()
  const minExpression = (checked.minY ?? '0').trim()

  if (order === 'bottom-up') {
    return expandBottomUp(identifier, checked, formatVersion, nested, {
      variables,
      setup,
      minExpression,
      maxExpression,
    })
  }
  return expandTopDown(identifier, checked, formatVersion, nested, { variables, setup, minExpression, maxExpression })
}

interface Pieces {
  readonly variables: ReturnType<typeof columnVariables>
  readonly setup: string
  readonly minExpression: string
  readonly maxExpression: string
}

/** The bounds-and-count preamble both shapes share, minus the trailing `return`. */
function bounds(p: Pieces): string {
  const v = p.variables
  return `${v.min} = ${p.minExpression}; ${v.max} = ${p.maxExpression}; ${v.iterations} = ${v.max} - ${v.min};`
}

function expandTopDown(
  identifier: string,
  params: ColumnParams,
  formatVersion: string,
  nested: boolean,
  p: Pieces,
): CompoundResult {
  const v = p.variables
  const grid = fixedGridAxis(v.iterations)
  const notes: PlanNote[] = [halfOpenNote(p.minExpression, p.maxExpression), TOP_DOWN_DIRECTION_NOTE, STEP_SIZE_NOTE]

  // One scatter is enough only when minY is KNOWN to be zero off the text, because the grid's own
  // extent starts at 0 and the levels then already line up. Anything else -- including an
  // expression that happens to evaluate to zero -- gets the offset shape, which is correct either
  // way, because reading a non-literal as zero is a wrong answer nothing downstream can catch.
  if (params.minY === undefined || isLiteralZero(params.minY)) {
    const iterations = `${p.setup}${bounds(p)} return ${v.iterations};`
    const operations = [
      scatterFile(identifier, formatVersion, nested, params.places, { iterations, x: 0, y: grid, z: 0 }),
    ]
    return {
      ok: true,
      expansion: { kind: 'column', identifier, operations, notes, creates: [identifier] },
    }
  }

  const childId = `${identifier}${CHILD_ROLES.columnInner()}`
  if (params.places === childId) {
    return no(
      'id-exists',
      `"${childId}" is the identifier this column generates for its inner scatter, so it cannot also be the feature the column ` +
        'places -- one of the two would silently replace the other when the pack loads.',
      [identifier, childId],
    )
  }
  const outerIterations = `${p.setup}${bounds(p)} return 1;`
  const operations = [
    scatterFile(identifier, formatVersion, nested, childId, { iterations: outerIterations, x: 0, y: v.min, z: 0 }),
    scatterFile(childId, formatVersion, nested, params.places, {
      iterations: `return ${v.iterations};`,
      x: 0,
      y: grid,
      z: 0,
    }),
  ]
  notes.push({
    level: 'info',
    message:
      `minY ("${p.minExpression}") is not a bare zero, so the offset is applied ONCE by an outer scatter: it runs the setup, ` +
      `returns 1, and offsets y by ${v.min}, while ${childId} does the grid. Folding the offset into the grid instead would mean ` +
      'assuming the expression evaluates to zero, which nothing here can check -- and the split is correct even when it does.',
  })
  return {
    ok: true,
    expansion: { kind: 'column', identifier, operations, notes, creates: [identifier, childId] },
  }
}

function expandBottomUp(
  identifier: string,
  params: ColumnParams,
  formatVersion: string,
  nested: boolean,
  p: Pieces,
): CompoundResult {
  const v = p.variables
  let level = v.level
  let levelIsTemp = false
  if (params.levelVariable !== undefined) {
    const resolved = resolveLevelVariable(params.levelVariable)
    if (!resolved.ok) return resolved
    level = resolved.reference
    levelIsTemp = resolved.temp
  }

  // The counter is seeded at -1 and incremented at the TOP of each iteration, so the first level
  // read is 0 and the last is iterations-1. Seeding at 0 and incrementing afterwards would place
  // the first level twice as far up as asked.
  const iterations = `${p.setup}${level} = -1; ${bounds(p)} return ${v.iterations};`
  const stepScript = `${statementPrefix(params.step)}${level} = ${level} + 1; return 0;`
  const y = `${v.min} + ${level}`

  const operations = [
    scatterFile(identifier, formatVersion, nested, params.places, { iterations, x: stepScript, y, z: 0 }),
  ]
  const notes: PlanNote[] = [
    halfOpenNote(p.minExpression, p.maxExpression),
    {
      level: 'info',
      message:
        `${level} counts 0, 1, 2 ... as the column is built UPWARDS from ${v.min}, and the placed feature can read it -- which is ` +
        'the whole reason this shape exists. No fixed_grid is involved, so the descending grid index that makes the top-down shape ' +
        'build downwards plays no part here.',
    },
    {
      level: 'info',
      message:
        'The per-level script is written into the "x" axis, because coordinate_eval_order defaults to "xzy" and only the FIRST ' +
        `evaluated axis runs once per iteration. Setting a coordinate_eval_order that does not start with "x" would stop ${level} ` +
        'being incremented before "y" reads it -- the loop would keep running and every level would be off by one.',
    },
  ]
  if (levelIsTemp) {
    notes.push({
      level: 'warning',
      message:
        `${level} is a temp, which is scoped to ONE evaluation. The placed feature is reached from inside that evaluation so it can ` +
        'read the level, but nothing outside this scatter can -- a variable.* name is what survives further.',
    })
  }
  return { ok: true, expansion: { kind: 'column', identifier, operations, notes, creates: [identifier] } }
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export const columnCompound: CompoundSpec<ColumnParams> = {
  kind: 'column',
  title: 'Column',
  summary: 'Places one feature at every level between two heights, built from the top down or from the bottom up.',
  validate: validateColumnParams,
  expand: expandColumn,
}
