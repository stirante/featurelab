// loop.ts -- the `loop` compound, which is one scatter_feature wearing three hats.
//
// A scatter already counts. What makes it a LOOP an author can write bookkeeping in is that two
// of its fields are Molang evaluated at known moments:
//
//   - `iterations` is evaluated ONCE, before the first iteration. Assignments put in front of a
//     trailing `return <count>;` therefore run exactly once, and the names they write are
//     readable by everything the scatter delegates to, because the Molang scope is shared by
//     reference. That is the setup script.
//   - the FIRST coordinate named by `coordinate_eval_order` is evaluated once per iteration,
//     before the other two. The same trick -- statements, then `return <coord>;` -- makes that
//     axis the per-iteration step script.
//
// Neither is discoverable from the schema, both are in every real pack, and neither survives
// expansion in recoverable form (a setup script is concatenated ahead of a `return`, and nothing
// short of parsing generated Molang back into authorial intent would separate them again). So
// spec.ts's rule holds here without exception: the parameters are the source, the file is
// derived, and the parameters are written down verbatim in the annotation.
//
// WHERE THE STEP SCRIPT GOES, which is the only genuinely hard decision in this module. It goes
// into `coordinateEvalOrder.at(0)` -- the axis the evaluation order names FIRST -- and nowhere
// else. Put it in `x` because `x` is usually first and it will keep working right up until an
// author sets `coordinate_eval_order` to "zyx", at which point the loop still runs, the counts
// are still right, and the bookkeeping happens after the coordinate that depends on it. No
// schema check sees that, no diagnostic in this repo sees that, and the placements just move.
// `firstEvaluatedAxis` is therefore the one function in here worth reading twice.
//
// THE EVAL-ORDER DEFAULT, and the discrepancy behind it. The hand-written idiom this compound replaces
// defaults `coordinateEvalOrder` to `'xyz'`. The engine's default for an ABSENT
// `coordinate_eval_order` is `'xzy'`. They disagree, spec.ts says to follow the schema, and the
// schema is what this module follows -- verified in this repo's own engine port rather than
// taken on trust:
//
//   - features/distribution.go, ParseEvalOrder: `if value == nil { return evalOrders["xzy"] }`,
//     with a comment recording why the absent-key default is "xzy", and the trap that a
//     zero-initialised parameter value would suggest "xyz", which is not the default that governs.
//   - features/scatter_semantics_test.go pins it behaviourally: with the key absent, `y` sees
//     `variable.worldz` already set, which is true under xzy and false under xyz and zyx.
//
// Two consequences, and they pull in opposite directions, so both are spelled out:
//
//   1. For the DEFAULT case the disagreement is invisible: "xyz" and "xzy" both name `x` first,
//      so the step script lands in `x` either way. The choice of default cannot be caught by a
//      test of where the step script went, and a test that claimed to catch it would be lying.
//   2. It is not invisible for the FILE. This module does not write `coordinate_eval_order` when
//      the parameter is absent, so the engine's own default governs the generated file. Writing
//      the default out explicitly would be a key the author never asked for; writing `"xyz"` out
//      -- the idiom's default -- would change which random draw feeds which axis and MOVE
//      PLACEMENTS, which is why it is not done.
//
// PURE AND TOTAL, as CompoundSpec requires. Every refusal returns before a single operation is
// built, so there is no path that yields a partial plan; nothing here reads a clock, a random
// source, or the filesystem; and key order in the generated document is fixed by a constant
// rather than by iteration over a caller's object, so re-expanding after an unrelated parameter
// edit produces byte-identical output.

import { formatJsonPath, type PathSegment, type PlanNote, type PlanOperation, type Refusal, type RefusalCode } from '../idioms'
import { FormatVersionError, atLeastOrUnversioned, parseFormatVersion, type FormatVersion } from '../typeCatalog'
import { type CompoundResult, type CompoundSpec, type LoopParams } from './spec'

// ---------------------------------------------------------------------------
// Constants fixed by the format, not chosen here
// ---------------------------------------------------------------------------

const SCATTER_TYPE_ID = 'minecraft:scatter_feature'

/** The format_version at which scatter's parameters moved from flat keys on the feature body
 * into a nested `distribution` object -- features/scatter.go's `scatterNestedDistributionVersion`,
 * and idioms.ts's `SCATTER_DISTRIBUTION_SINCE`. The two shapes are mutually exclusive and writing
 * the wrong one does not raise anything the author can see: the engine logs the unknown member,
 * drops it, and then fails the required `iterations`. So a generated file's shape is decided by
 * the format_version it declares, exactly as the engine decides it. */
const SCATTER_DISTRIBUTION_SINCE = '1.21.10'

/** The six permutations `coordinate_eval_order` accepts -- features/distribution.go's
 * `evalOrders`. Anything else is refused there with a message naming these six, so a compound
 * that emitted a seventh would produce a file that does not load. */
export const COORDINATE_EVAL_ORDERS: readonly string[] = ['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx']

/** The engine's default when the key is absent. See the header: this is the SCHEMA's default,
 * which is not the idiom's. */
export const DEFAULT_COORDINATE_EVAL_ORDER = 'xzy'

export type Axis = 'x' | 'y' | 'z'

/** The axes in the order the generated file WRITES them, which is deliberately not the order
 * they are evaluated in. Key order in a JSON object means nothing to the engine, and
 * features/scatter.go's `legacyScatterParamKeys` -- the loader's own registration order --
 * lists x, y, z, so a generated file reads like the schema. Evaluation order is
 * `coordinate_eval_order`'s job and is visible there. */
const AXES: readonly Axis[] = ['x', 'y', 'z']

/** The distribution keys in the loader's registration order, from features/scatter.go's
 * `legacyScatterParamKeys`. Fixing the order here rather than building the object ad hoc is what
 * makes a re-expansion byte-stable. */
const DISTRIBUTION_KEY_ORDER: readonly string[] = ['iterations', 'scatter_chance', 'coordinate_eval_order', 'x', 'y', 'z']

/**
 * Which axis carries the per-iteration step script: `coordinateEvalOrder.at(0)`, with the
 * schema's `xzy` standing in for an absent order.
 *
 * Exported because it is the one rule in this compound that a caller outside it needs -- a form
 * that lets the author edit `coordinateEvalOrder` has to move the step script in the same edit,
 * and it cannot do that without knowing where the script is.
 */
export function firstEvaluatedAxis(order: string | undefined): Axis {
  const resolved = order === undefined || order === '' ? DEFAULT_COORDINATE_EVAL_ORDER : order
  return resolved.charAt(0) as Axis
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The code a malformed PARAMETER gets.
 *
 * `RefusalCode` lives in idioms.ts, is shared with four other compounds, and has no member for
 * "a compound parameter is the wrong shape" -- it was written for actions that operate on an
 * existing graph, where the equivalent failures are `unknown-node` and `path-shape`. Rather than
 * invent a code this module cannot add to the union, malformed parameters take `molang-invalid`,
 * which is EXACT for every field of LoopParams except `places` (an identifier, so `id-malformed`,
 * which idioms.ts uses for exactly that) and `coordinateEvalOrder`, `scatterChance` and
 * `projectInputToFloor`, where it is merely the nearest. The `reason` sentence is the whole
 * user-visible product of a refusal and it names the field either way.
 *
 * This is reported upward as a gap in the contract rather than papered over.
 */
const MALFORMED_PARAM: RefusalCode = 'molang-invalid'

function refuse(code: RefusalCode, reason: string): { readonly ok: false; readonly refusal: Refusal } {
  return { ok: false, refusal: { code, reason } }
}

// ---------------------------------------------------------------------------
// Molang shapes this module has to recognise
// ---------------------------------------------------------------------------

/** Replaces the contents of single-quoted Molang strings with spaces, preserving length.
 * A narrower copy of molangHints.ts's `maskStrings`, behaviour for behaviour, kept local so a
 * compound does not take a dependency on the hint engine for one predicate. Molang's only string
 * literal is single-quoted and has no escape sequences, so this is the whole rule. */
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

/** True when `source` holds a `;` outside a string, i.e. it is a statement SEQUENCE rather than a
 * single expression -- molangHints.ts's `isStatementSequence`. */
function isStatementSequence(source: string): boolean {
  return maskStrings(source).includes(';')
}

/** True when `source` ends in the `;` that lets a script be concatenated in front of a `return`.
 * The idiom concatenates with NOTHING between -- `${initMolang}return ${iterations};` -- and
 * this module does the same, byte for byte, so a script that does not terminate its last
 * statement would produce `v.a = 1return 3;`. That is refused rather than silently repaired,
 * because inserting a separator the idiom does not insert is a diff on every regenerated file. */
function endsWithTerminator(source: string): boolean {
  return maskStrings(source).trimEnd().endsWith(';')
}

/** idioms.ts's `BARE_NUMBER`, character for character. A count or a coordinate that is a plain
 * numeric literal is written to the file AS A NUMBER: it did not need to be a string, and turning
 * it into one is a diff on every file for no gain. */
const BARE_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A Molang parameter as the JSON value it should become: a number when the author typed a bare
 * numeric literal, the string they typed otherwise. */
function molangValue(text: string): string | number {
  const trimmed = text.trim()
  return BARE_NUMBER.test(trimmed) ? Number(trimmed) : text
}

/** True when writing `text` as a JSON number would change the bytes the author typed (`"+5"`,
 * `"3."`, `"1e2"`). It still becomes a number -- those are not valid JSON number literals, so
 * there is no way to keep the spelling -- but the author is told, because a value that came back
 * different from what they typed and said nothing is how trust in a generator goes. */
function renumbered(text: string): boolean {
  const trimmed = text.trim()
  return BARE_NUMBER.test(trimmed) && String(Number(trimmed)) !== trimmed
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** "namespace:identifier", checked only as far as this module can honestly check it -- the same
 * rules idioms.ts's `malformedIdReason` applies, re-stated here because that one is module-local.
 * Nothing invents a character class the game enforces: a validator that refuses an id the game
 * accepts is a bug the author cannot work around from inside the editor. */
function malformedIdReason(id: string, what: string): string | null {
  if (id.length === 0) return `${what} is empty; feature identifiers are "namespace:identifier".`
  const colon = id.indexOf(':')
  if (colon < 0) return `${what} "${id}" has no namespace. Feature identifiers are "namespace:identifier", and a bare name resolves against nothing.`
  if (colon === 0 || colon === id.length - 1) return `${what} "${id}" has an empty half; feature identifiers are "namespace:identifier".`
  if (id.indexOf(':', colon + 1) >= 0) return `${what} "${id}" has more than one ":".`
  if (/\s/.test(id)) return `${what} "${id}" contains whitespace.`
  return null
}

function bareId(identifier: string): string {
  return identifier.slice(identifier.indexOf(':') + 1)
}

/**
 * Where the generated file goes: `features/<bare id>.json`, the convention every fixture and
 * every reference in this extension uses (featureDefinitionProvider.ts globs `**\/features\/**\/*.json`).
 *
 * WHAT THIS CANNOT DO, and it is a real limit rather than an oversight: `CompoundSpec.expand`
 * receives an identifier, parameters and a format_version, and no graph and no file list. So it
 * cannot check that the path is free, which is the `file-exists` refusal every creating action in
 * idioms.ts makes. A caller that has the graph must make that check itself before applying the
 * plan; this module cannot make it and does not pretend to.
 */
function loopFilePath(identifier: string): string {
  return `features/${bareId(identifier)}.json`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The parameter names, in the order the annotation writes them. Fixed here so that the JSON in
 * the comment is byte-identical for equal parameters however the caller's object was built --
 * an annotation that reshuffled itself would show up as a diff on every save. */
const PARAM_KEYS: readonly (keyof LoopParams)[] = [
  'count',
  'places',
  'setup',
  'step',
  'x',
  'y',
  'z',
  'coordinateEvalOrder',
  'scatterChance',
  'projectInputToFloor',
]

type ValidationResult = { readonly ok: true; readonly params: LoopParams } | { readonly ok: false; readonly refusal: Refusal }

function optionalMolang(raw: Record<string, unknown>, key: string, blankIsAbsent: boolean): string | undefined | Refusal {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    return { code: MALFORMED_PARAM, reason: `\`${key}\` must be a Molang expression written as a string; this one is ${typeof value}.` }
  }
  if (value.trim().length === 0) {
    // `setup` and `step` say "empty means none" in the contract, so a blank one is simply
    // absent -- an author clearing the box must not produce a file with an empty script in it.
    // A blank COORDINATE has no such reading: there is nothing to return.
    if (blankIsAbsent) return undefined
    return { code: MALFORMED_PARAM, reason: `\`${key}\` is an empty expression. Give it a coordinate, or leave it out -- an absent axis is a zero-width axis at the origin.` }
  }
  return value
}

function isRefusalValue(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && 'code' in v && 'reason' in v
}

function validate(params: unknown): ValidationResult {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return refuse(MALFORMED_PARAM, 'a loop is described by a JSON object of parameters; this is not one.')
  }
  const raw = params as Record<string, unknown>

  // Unknown keys are refused rather than dropped. The annotation is written back from the
  // VALIDATED parameters, so a key that is silently ignored here is a key the next save deletes
  // from the author's file -- and an annotation this module cannot read in full must degrade to
  // "show the raw subgraph", which is exactly what decodeCompoundParams returning null does for
  // a malformed one.
  const unknown = Object.keys(raw).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    return refuse(
      MALFORMED_PARAM,
      `${unknown.sort().join(', ')} ${unknown.length === 1 ? 'is not a parameter' : 'are not parameters'} of a loop. ` +
        'Rather than drop it and quietly rewrite the annotation without it, nothing is expanded -- the subgraph is shown as plain JSON instead.',
    )
  }

  const count = raw['count']
  if (typeof count !== 'string' || count.trim().length === 0) {
    return refuse(
      MALFORMED_PARAM,
      'a loop needs a `count`: the Molang the scatter evaluates once to decide how many iterations to run. It is a string and not a number on purpose -- a count that evaluates to 0 is how a branch is skipped.',
    )
  }

  const places = raw['places']
  if (typeof places !== 'string') {
    return refuse('id-malformed', 'a loop needs a `places`: the "namespace:identifier" of the feature each iteration places.')
  }
  const placesBad = malformedIdReason(places, '`places`')
  if (placesBad !== null) return refuse('id-malformed', placesBad)

  const optional: Record<string, string | undefined> = {}
  for (const [key, blankIsAbsent] of [
    ['setup', true],
    ['step', true],
    ['x', false],
    ['y', false],
    ['z', false],
  ] as const) {
    const value = optionalMolang(raw, key, blankIsAbsent)
    if (isRefusalValue(value)) return { ok: false, refusal: value }
    optional[key] = value
  }

  let coordinateEvalOrder: string | undefined
  if (raw['coordinateEvalOrder'] !== undefined) {
    const order = raw['coordinateEvalOrder']
    if (typeof order !== 'string' || !COORDINATE_EVAL_ORDERS.includes(order)) {
      return refuse(
        MALFORMED_PARAM,
        `\`coordinateEvalOrder\` must be one of ${COORDINATE_EVAL_ORDERS.join('/')}; "${String(order)}" is not, and the engine refuses the key rather than falling back. ` +
          `Leaving it out is not the same as writing one: an absent coordinate_eval_order evaluates as "${DEFAULT_COORDINATE_EVAL_ORDER}".`,
      )
    }
    coordinateEvalOrder = order
  }

  let scatterChance: number | undefined
  if (raw['scatterChance'] !== undefined) {
    const chance = raw['scatterChance']
    if (typeof chance !== 'number' || !Number.isFinite(chance)) {
      return refuse(MALFORMED_PARAM, '`scatterChance` must be a finite number. Note that a bare number is a PERCENT: 1.5 means 1.5%, not 150%.')
    }
    scatterChance = chance
  }

  let projectInputToFloor: boolean | undefined
  if (raw['projectInputToFloor'] !== undefined) {
    if (typeof raw['projectInputToFloor'] !== 'boolean') {
      return refuse(MALFORMED_PARAM, '`projectInputToFloor` must be true or false.')
    }
    projectInputToFloor = raw['projectInputToFloor']
  }

  // Rebuilt in PARAM_KEYS order with absent keys left out, so the annotation is a function of the
  // parameters and not of how the caller's object happened to be assembled.
  const clean: Record<string, unknown> = {}
  const values: Record<string, unknown> = {
    count,
    places,
    setup: optional['setup'],
    step: optional['step'],
    x: optional['x'],
    y: optional['y'],
    z: optional['z'],
    coordinateEvalOrder,
    scatterChance,
    projectInputToFloor,
  }
  for (const key of PARAM_KEYS) {
    if (values[key] !== undefined) clean[key] = values[key]
  }
  return { ok: true, params: clean as unknown as LoopParams }
}

// ---------------------------------------------------------------------------
// The generated file
// ---------------------------------------------------------------------------

/**
 * A complete feature file with the compound's annotation on its root.
 *
 * The JSON is produced by `JSON.stringify(.., 2)` and the two comment lines are spliced in after
 * the opening brace, rather than assembled by hand -- so the body is byte-identical to what
 * idioms.ts's `featureFileContents` writes for an ordinary generated file, and the annotation is
 * the only difference between them. `description.identifier` comes first inside the body for the
 * reason that function gives: a generated file that reads unlike the hand-written ones beside it
 * is a generated file people rewrite by hand.
 *
 * The parameters go on ONE line, because `Annotation.Text` is the following comment LINES and a
 * wrapped JSON object would be read back as several of them.
 */
function annotatedFileContents(identifier: string, formatVersion: string, params: LoopParams, body: Record<string, unknown>): string {
  const document = {
    format_version: formatVersion,
    [SCATTER_TYPE_ID]: { description: { identifier }, ...body },
  }
  // The directive is NOT written here any more, and both reasons are worth keeping.
  //
  // It used to be spliced in directly after the opening brace, which put it above
  // `format_version` -- and a directive attaches to the member that FOLLOWS it, so it described
  // the version string rather than the feature. The reader then refused it as "not at root",
  // and the compound silently would not collapse.
  //
  // And it was written by one compound out of five. Provenance is one rule, so it belongs in
  // one place: compounds/annotate.ts, called by whoever writes the files -- which is also the
  // only caller that knows whether a file already carries one. Two directives of the same name
  // on one path is a state the reader has no answer for, and two writers is how that gets
  // created.
  void params
  return `${JSON.stringify(document, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

function expand(identifier: string, params: LoopParams, formatVersion: string): CompoundResult {
  // Re-validated rather than trusted. `P` is an interface, so a caller can hand `expand` an
  // object that never went through `validate`, and a compound that produced a broken file for one
  // is a compound whose totality claim is only true on the happy path.
  const checked = validate(params)
  if (!checked.ok) return { ok: false, refusal: checked.refusal }
  const p = checked.params

  const idBad = malformedIdReason(identifier, 'the loop\'s own identifier')
  if (idBad !== null) return refuse('id-malformed', idBad)
  const bare = bareId(identifier)
  if (bare.includes('/') || bare.includes('\\') || bare === '.' || bare === '..') {
    return refuse(
      'id-malformed',
      `"${identifier}" would be written to ${loopFilePath(identifier)}, which is not a file inside features/. Identifiers that contain a path separator cannot name a file here.`,
    )
  }

  let version: FormatVersion
  try {
    version = parseFormatVersion(formatVersion)
  } catch (error) {
    return refuse(
      'no-format-version',
      `"${formatVersion}" is not a format_version: ${error instanceof FormatVersionError ? error.message : String(error)}. It decides which keys the generated file's type accepts, so it is not a detail this can pick.`,
    )
  }
  if (!version.present) {
    return refuse(
      'no-format-version',
      'a generated feature file must declare a format_version, and none was passed. It decides whether the scatter\'s parameters are flat keys or members of a `distribution` object, so guessing it would produce a file the engine drops half of.',
    )
  }
  const nested = atLeastOrUnversioned(version, SCATTER_DISTRIBUTION_SINCE)

  const notes: PlanNote[] = []

  // --- iterations: the count, and the setup script if there is one ---------
  let iterations: string | number
  if (p.setup === undefined) {
    // No setup: the count goes in exactly as the author wrote it. NOT wrapped in
    // `return <count>;` -- the idiom does not wrap it either, and an expression that did not
    // need to be a string must not become one.
    iterations = molangValue(p.count)
    if (renumbered(p.count)) {
      notes.push({ level: 'info', message: `\`count\` "${p.count.trim()}" is written as the JSON number ${String(Number(p.count.trim()))}; that spelling is not a JSON number literal, so the bytes differ from what you typed while the value does not.` })
    }
  } else {
    if (!endsWithTerminator(p.setup)) {
      return refuse(
        'molang-not-composable',
        `the setup script ("${p.setup}") does not end in ";", and it is concatenated directly in front of the count -- which would produce "${p.setup}return ${p.count};". Terminate the last statement.`,
      )
    }
    if (isStatementSequence(p.count)) {
      return refuse(
        'molang-not-composable',
        `the count ("${p.count}") is a statement sequence, and a setup script is composed with it as "<setup>return <count>;" -- there is no correct way to \`return\` a sequence. Move those statements into the setup script, or drop the setup script and write the whole sequence as the count, which is legal on its own.`,
      )
    }
    iterations = `${p.setup}return ${p.count};`
  }

  // --- the axes: the step script goes in whichever one is evaluated first ---
  const stepAxis = firstEvaluatedAxis(p.coordinateEvalOrder)
  const axisValues: Partial<Record<Axis, string | number>> = {}
  for (const axis of AXES) {
    const given = p[axis]
    if (axis === stepAxis && p.step !== undefined) {
      if (!endsWithTerminator(p.step)) {
        return refuse(
          'molang-not-composable',
          `the step script ("${p.step}") does not end in ";", and it is concatenated directly in front of the coordinate -- which would produce "${p.step}return ${given ?? '0'};". Terminate the last statement.`,
        )
      }
      const coordinate = given ?? '0'
      if (isStatementSequence(coordinate)) {
        return refuse(
          'molang-not-composable',
          `the "${axis}" coordinate ("${coordinate}") is a statement sequence, and the step script is composed with it as "<step>return <${axis}>;" -- there is no correct way to \`return\` a sequence. Move those statements into the step script.`,
        )
      }
      axisValues[axis] = `${p.step}return ${coordinate};`
      if (given === undefined) {
        notes.push({
          level: 'info',
          message: `the step script runs in "${axis}", which has no coordinate of its own, so it returns 0 -- the origin, which is what an absent axis means to the engine anyway.`,
        })
      }
      continue
    }
    // "as given": an axis nobody wrote is an axis this does not write. An absent axis is already
    // a zero-width axis at the origin, so emitting 0 would change nothing about the placement and
    // add a key to every generated file.
    if (given !== undefined) {
      axisValues[axis] = molangValue(given)
      if (renumbered(given)) {
        notes.push({ level: 'info', message: `the "${axis}" coordinate "${given.trim()}" is written as the JSON number ${String(Number(given.trim()))}; that spelling is not a JSON number literal, so the bytes differ from what you typed while the value does not.` })
      }
    }
  }

  // --- the distribution, in the loader's own key order ---------------------
  const distributionValues: Record<string, unknown> = {
    iterations,
    scatter_chance: p.scatterChance,
    coordinate_eval_order: p.coordinateEvalOrder,
    x: axisValues.x,
    y: axisValues.y,
    z: axisValues.z,
  }
  const distribution: Record<string, unknown> = {}
  for (const key of DISTRIBUTION_KEY_ORDER) {
    if (distributionValues[key] !== undefined) distribution[key] = distributionValues[key]
  }

  // `places_feature` and `project_input_to_floor` sit OUTSIDE the version gate -- they are body
  // keys in both shapes and mean the same thing in both (features/scatter.go says so explicitly).
  const body: Record<string, unknown> = { places_feature: p.places }
  if (p.projectInputToFloor !== undefined) body['project_input_to_floor'] = p.projectInputToFloor
  Object.assign(body, nested ? { distribution } : distribution)

  const file = loopFilePath(identifier)
  const operations: readonly PlanOperation[] = [
    {
      op: 'createFile',
      file,
      identifier,
      typeId: SCATTER_TYPE_ID,
      contents: annotatedFileContents(identifier, version.raw, p, body),
    },
  ]

  // --- the notes, which are where the two invisible rules become visible ----
  const distributionSegments: PathSegment[] = nested ? [{ key: SCATTER_TYPE_ID }, { key: 'distribution' }] : [{ key: SCATTER_TYPE_ID }]
  if (p.step !== undefined) {
    notes.push({
      level: 'info',
      message:
        `the step script is written into ${formatJsonPath([...distributionSegments, { key: stepAxis }])}, because coordinate_eval_order ` +
        `${p.coordinateEvalOrder === undefined ? `is absent and therefore "${DEFAULT_COORDINATE_EVAL_ORDER}"` : `is "${p.coordinateEvalOrder}"`} and that names "${stepAxis}" first. ` +
        'Changing the evaluation order moves it: leave it behind and the loop still runs, with its bookkeeping happening after the coordinate that depends on it.',
    })
  }
  if (p.coordinateEvalOrder === undefined) {
    notes.push({
      level: 'info',
      message:
        `no coordinate_eval_order is written, so the engine's own default governs: "${DEFAULT_COORDINATE_EVAL_ORDER}", which evaluates ` +
        'y LAST because a vertical coordinate usually depends on the lateral ones. (The TS library this node replaces defaulted to "xyz" instead. ' +
        'Both name "x" first, so nothing about this file changes -- but writing either one out explicitly would permute which random draw feeds which axis, and placements would move.)',
    })
  }
  if (p.setup !== undefined) {
    notes.push({
      level: 'info',
      message:
        `the setup script is written into ${formatJsonPath([...distributionSegments, { key: 'iterations' }])} in front of "return ${p.count};", ` +
        'because iterations is evaluated once before the first iteration. Anything it assigns is readable by ' +
        `${p.places} -- the Molang scope is shared by reference with everything the scatter delegates to.`,
    })
  }

  return {
    ok: true,
    expansion: { kind: 'loop', identifier, operations, notes, creates: [identifier] },
  }
}

// ---------------------------------------------------------------------------

export const loopCompound: CompoundSpec<LoopParams> = {
  kind: 'loop',
  title: 'Loop',
  summary: 'Places a feature a Molang-computed number of times, with a script that runs once before the loop and one that runs at the top of every iteration.',
  validate,
  expand,
}

export default loopCompound
