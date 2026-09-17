// steps.ts -- the `steps` compound: run each child in order, all at the SAME position, and do
// not stop when one of them fails.
//
// WHY THIS EXISTS, AND WHY `minecraft:sequence_feature` IS NOT IT. Both halves of the answer are
// in this repo's own port of the engine, features/aggregate.go, and both were re-read against it
// rather than taken from the schema docs:
//
//   1. RE-TARGETING. aggregate.go's Place loop keeps ONE running value, `result`. For the
//      sequence kind it builds each sub-feature's context as `ctx.WithOrigin(*result)` whenever
//      a previous child has already succeeded -- so child 2 is placed at child 1's successful
//      result, child 3 at child 2's, and the position walks down the list. The aggregate kind
//      passes `ctx` through verbatim, so every child sees the original origin. An author who
//      wants "three things at this spot" wants the aggregate behaviour and reaches for the word
//      "sequence".
//
//   2. HARD-WIRED early_out. buildAggregateFeature(sequence=true) sets `eo :=
//      earlyOutFirstFailure` and then SKIPS the `parseEarlyOut(body["early_out"])` branch
//      entirely -- the key is not in the sequence kind's schema, so supplying it changes
//      nothing. The tail test `if f.earlyOut == earlyOutFirstFailure && result == nil { break }`
//      then cuts the loop the moment a child declines while nothing has succeeded yet. There is
//      no JSON that turns that off.
//
// So `steps` is built the way the hand-written idiom builds it: a counted scatter whose first-evaluated
// coordinate advances a counter, wrapping an aggregate that dispatches on that counter. The
// aggregate kind never re-targets, and `first_success` stops the aggregate at the one branch
// that matched -- it does not stop the OUTER loop, so iteration i+1 still runs after step i
// declined. That is the whole trick, and it is why the two behaviours nobody asks for are gone.
//
// ON `first_success`: it is correct and must not be "simplified" to `none`. Exactly one branch
// guard is true per iteration, so `none` would place the same thing and merely keep walking the
// remaining N-1 branches, each evaluating a Molang comparison, for every iteration -- N^2 guard
// evaluations instead of the triangular number, and a `result` that ends up being whichever
// branch ran LAST rather than the one that placed. `first_success` is the aggregate returning
// the step's own result.
//
// ON `t.` RATHER THAN `v.`: spec.ts's compoundVariable settles the spelling. A temp is scoped to
// one evaluation, which is exactly the lifetime wanted -- the counter has to survive the
// aggregate call (aggregate.go forwards the SAME Molang scope by reference, so it does) and must
// not leak into the next evaluation of this same scatter, which a `variable.` would.
import type { PlanNote, PlanOperation, Refusal } from '../idioms.js'
import {
  FEATURE_SCHEMA_FLOOR,
  atLeastOrUnversioned,
  compareFormatVersions,
  parseFormatVersion,
  type FormatVersion,
} from '../typeCatalog.js'
import { CHILD_ROLES, compoundVariable, type CompoundResult, type CompoundSpec, type StepsParams } from './spec.js'

const SCATTER_TYPE_ID = 'minecraft:scatter_feature'
const AGGREGATE_TYPE_ID = 'minecraft:aggregate_feature'

/**
 * The format_version at which `scatter_feature`'s parameters moved off the feature body and into
 * a nested `distribution` object. Mirrors idioms.ts's constant of the same name and
 * features/scatter.go's `scatterNestedDistributionVersion`. Below the gate the schema accepts the flat keys
 * (`iterations`, `scatter_chance`, `coordinate_eval_order`, `x`, `y`, `z`) on the body; at or
 * above it there is one required `distribution` object and nothing else.
 *
 * This is not cosmetic. The two shapes are mutually exclusive and writing the wrong one does not
 * error in a way an author can act on -- the engine drops the out-of-schema key unread and then
 * fails the REQUIRED `iterations` it never found. A `steps` expansion writes four or more scatter
 * files, so getting the gate wrong breaks all of them at once.
 */
const SCATTER_DISTRIBUTION_SINCE = '1.21.10'

/**
 * WHICH AXIS CARRIES THE INCREMENT, and the evidence for it.
 *
 * The per-iteration script has to live in the axis that is evaluated FIRST, because the counter
 * it advances is what every branch guard inside the aggregate reads. features/distribution.go's
 * RunScatterDistribution walks `run.Dist.EvalOrder` once per surviving iteration, in order, so
 * "first" means `coordinate_eval_order`'s first letter and nothing else.
 *
 * The default was the open question, and the schema's stated default is not automatically the
 * idiom's assumption. features/distribution.go's ParseEvalOrder answers it directly: an ABSENT
 * `coordinate_eval_order` returns `evalOrders["xzy"]`, i.e. {AxisX, AxisZ, AxisY}. Its comment
 * records the fact that it was WRONG here until 2026-09-01 when it was changed from "xyz", and
 * the trap that makes it easy to get wrong -- a zero-initialised eval-order value would say
 * "xyz", which is not the default that governs.
 *
 * The decision: `x` is first under the real default `xzy` AND under `xyz`, the only other order
 * anyone reaches for by hand and the one the old wrong default named. Both candidate answers to
 * the question agree on the letter that matters, so the increment goes in `x` and NO explicit
 * `coordinate_eval_order` is emitted. Emitting one would be a key the idiom does not write and
 * the engine does not need, and it would have to be kept in step with the axis by hand forever
 * after -- exactly the coupling LoopParams.step's doc comment says cannot be edited
 * independently. If this ever has to change, the two move together: the increment string and the
 * emitted order are one decision, not two.
 */
const INCREMENT_AXIS = 'x' as const

// ---------------------------------------------------------------------------
// format_version
// ---------------------------------------------------------------------------

/**
 * The version this expansion will stamp on every file it writes, or a refusal.
 *
 * typeCatalog.ts owns the parsing and the comparison; the only thing added here is TOTALITY.
 * `parseFormatVersion` THROWS on a malformed version, and `expand` must never throw, so the one
 * call is fenced and the exception becomes the refusal it always should have been at this
 * boundary.
 *
 * The two rejections below are both "the file this would write does not load", which is the only
 * standard a generator gets to hold itself to:
 *
 *   - ABSENT. `atLeastOrUnversioned` reads an absent version as "unversioned -- judge the keys on
 *     their own terms", and that is exactly right for a file somebody else wrote and this editor
 *     is merely reading. It is NOT right here: `format_version` is a required child of every
 *     band's schema root, so a file this module writes without one cannot load, and the version
 *     was handed in rather than discovered. There is nothing to be lenient about.
 *   - BELOW THE FLOOR. A version under FEATURE_SCHEMA_FLOOR matches no schema band at all.
 */
function resolveVersion(formatVersion: string): FormatVersion | Refusal {
  let version: FormatVersion
  try {
    version = parseFormatVersion(formatVersion)
  } catch (err) {
    return {
      code: 'no-format-version',
      reason:
        `"${formatVersion}" is not a format_version: ${err instanceof Error ? err.message : String(err)}. Every generated file ` +
        'has to declare one, and which shape the generated scatters are written in depends on it, so there is nothing to fall back to.',
    }
  }
  if (!version.present) {
    return {
      code: 'no-format-version',
      reason:
        'no format_version was given. The game requires the key on every feature file, so every file this would write would ' +
        'fail to load -- name a version instead.',
    }
  }
  if (compareFormatVersions(version, parseFormatVersion(FEATURE_SCHEMA_FLOOR)) < 0) {
    return {
      code: 'no-format-version',
      reason:
        `format_version ${version.raw} is below ${FEATURE_SCHEMA_FLOOR}, which matches no feature schema band -- a file ` +
        'declaring it does not load at all, whatever is written inside it.',
    }
  }
  return version
}

function isRefusalValue(value: FormatVersion | Refusal): value is Refusal {
  return 'code' in value
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Refusals reuse idioms.ts's `Refusal` verbatim, which means reusing its CLOSED `RefusalCode`
 * union. That union was written for the four idiom actions and has no member for "these compound
 * parameters are not the shape this compound takes", so the closest honest codes are used:
 * `id-malformed` for a parameter that is not the type or spelling it has to be, `empty-selection`
 * for a step list with nothing in it, `molang-invalid` for a setup script that cannot be spliced,
 * and `no-format-version` for a version the file cannot declare. The `reason` is the entire
 * user-visible product of a refusal, so it carries the real explanation and the code is only ever
 * a bucket for a renderer.
 */
function refuse(code: Refusal['code'], reason: string): { readonly ok: false; readonly refusal: Refusal } {
  return { ok: false, refusal: { code, reason } }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** `namespace:id`, the only spelling a feature reference has. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_.-]+$/

function bareId(identifier: string): string {
  const colon = identifier.indexOf(':')
  return colon === -1 ? identifier : identifier.slice(colon + 1)
}

/**
 * Where a generated child's file goes.
 *
 * THE CONTRACT DOES NOT GIVE THIS. `CompoundSpec.expand` takes an identifier, parameters and a
 * format_version, and `PlanOperation.createFile` wants a pack-relative path -- so the path has to
 * come from somewhere, and idioms.ts's own actions dodge the question by making the caller supply
 * `file` on the request. A compound has no request object, so the convention is applied here:
 * `features/<bare id>.json`, which is pack.Load's own layout (features/ is one of the five
 * directories the engine reads) and what every file in docs/wiki/tools/fixtures/features uses.
 * The `.` a namespaced id may contain is left alone -- it is legal in a filename and packs
 * that use this idiom write ids that way.
 */
function featureFile(identifier: string): string {
  return `features/${bareId(identifier)}.json`
}

/** idioms.ts's featureFileContents, to the byte: two-space JSON, trailing newline, `description`
 * first. Duplicated because the original is module-private there and not part of the contract --
 * if it is ever exported, this should become that import rather than a second copy drifting. Both
 * halves of the shape matter: the two-space indent and the trailing newline are what a generated
 * file has to look like for a re-expansion after an unrelated edit not to churn the diff. */
function featureFileContents(typeId: string, identifier: string, formatVersion: string, body: Record<string, unknown>): string {
  const document = {
    format_version: formatVersion,
    [typeId]: { description: { identifier }, ...body },
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** The flat/nested gate from SCATTER_DISTRIBUTION_SINCE, applied to one scatter body. `places_feature`
 * sits OUTSIDE the gate on both sides of it (features/scatter.go reads it off the body either
 * way), so only the distribution parameters move. */
function scatterBody(places: string, distribution: Record<string, unknown>, nested: boolean): Record<string, unknown> {
  return nested ? { places_feature: places, distribution } : { places_feature: places, ...distribution }
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export const stepsCompound: CompoundSpec<StepsParams> = {
  kind: 'steps',
  title: 'Steps',
  summary: 'Runs each feature in turn at the same position, and keeps going when one of them fails.',

  validate(params: unknown) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return refuse('id-malformed', 'a steps node is described by an object with a `steps` list; this is not one.')
    }
    const raw = params as Record<string, unknown>
    const steps = raw['steps']
    if (!Array.isArray(steps)) {
      return refuse('id-malformed', '`steps` must be a list of feature references, in the order they should run.')
    }
    if (steps.length === 0) {
      // Not a stylistic objection. features/aggregate.go's buildAggregateFeature refuses an empty
      // `features` array outright -- the engine's own schema stores a minimum array size of 1 and
      // fails a shorter one with "Array too small (0 < 1)" -- so the aggregate this would generate
      // is a file that does not load. Refusing here says so while there is still something the
      // author can do about it.
      return refuse(
        'empty-selection',
        'a steps node with no steps has nothing to run, and the aggregate it expands to would not load: the game requires at ' +
          'least one entry in a feature list. Add the first step, or delete the node.',
      )
    }
    for (const [i, step] of steps.entries()) {
      if (typeof step !== 'string' || step.trim().length === 0) {
        return refuse('id-malformed', `step ${i} is not a feature reference. Every step names a feature to place.`)
      }
      if (!IDENTIFIER_RE.test(step)) {
        return refuse(
          'id-malformed',
          `step ${i} is "${step}", which is not a \`namespace:identifier\`. A step is a reference to another feature, and an ` +
            'unqualified name resolves to nothing.',
        )
      }
    }
    const setup = raw['setup']
    if (setup !== undefined && typeof setup !== 'string') {
      return refuse('molang-invalid', '`setup` is a Molang expression, written as text. Leave it out if there is nothing to set up.')
    }
    // Rebuilt rather than passed through, so a params blob carrying extra keys cannot smuggle
    // them into the annotation on the next write.
    const checked: StepsParams =
      setup === undefined ? { steps: [...(steps as string[])] } : { steps: [...(steps as string[])], setup }
    return { ok: true, params: checked }
  },

  expand(identifier: string, params: StepsParams, formatVersion: string): CompoundResult {
    // Every refusal below returns before a single operation is built, so a refused expansion has
    // ZERO operations rather than a partial plan.
    if (!IDENTIFIER_RE.test(identifier)) {
      return refuse('id-malformed', `"${identifier}" is not a \`namespace:identifier\`, so the generated children would have no name to hang off.`)
    }
    const version = resolveVersion(formatVersion)
    if (isRefusalValue(version)) return { ok: false, refusal: version }
    const revalidated = stepsCompound.validate(params)
    if (!revalidated.ok) return revalidated
    const { steps, setup } = revalidated.params

    const nested = atLeastOrUnversioned(version, SCATTER_DISTRIBUTION_SINCE)
    const counter = compoundVariable(identifier)
    const aggregateId = `${identifier}${CHILD_ROLES.stepsAggregate()}`
    const itemIds = steps.map((_, i) => `${identifier}${CHILD_ROLES.stepsItem(i)}`)

    // The seed comes BEFORE the author's setup, and the concatenation is the idiom's exactly:
    // "<counter> = -1; <setup>return <N>;". The order is load-bearing in the direction that is
    // easy to get backwards -- the author's setup must be able to READ a seeded counter, which it
    // can only do if the seed already ran. The setup is spliced verbatim, with no separator
    // inserted before `return`, because the parameters are the source: an author who reads their
    // own setup back out of the collapsed node has to see the text they typed.
    const iterations = `${counter} = -1; ${setup ?? ''}return ${steps.length};`

    // The per-iteration script, in the first evaluated axis. See INCREMENT_AXIS. It returns 0, so
    // the axis contributes no offset and the trailing `return` is what lets one expression be
    // both the bookkeeping and the coordinate.
    const increment = `${counter} = ${counter} + 1; return 0;`

    const operations: PlanOperation[] = [
      {
        op: 'createFile',
        file: featureFile(identifier),
        identifier,
        typeId: SCATTER_TYPE_ID,
        contents: featureFileContents(
          SCATTER_TYPE_ID,
          identifier,
          formatVersion,
          scatterBody(aggregateId, { iterations, [INCREMENT_AXIS]: increment, y: 0, z: 0 }, nested),
        ),
      },
      {
        op: 'createFile',
        file: featureFile(aggregateId),
        identifier: aggregateId,
        typeId: AGGREGATE_TYPE_ID,
        contents: featureFileContents(AGGREGATE_TYPE_ID, aggregateId, formatVersion, {
          early_out: 'first_success',
          features: itemIds,
        }),
      },
      ...itemIds.map((itemId, i): PlanOperation => {
        const places = steps[i] as string
        return {
          op: 'createFile',
          file: featureFile(itemId),
          identifier: itemId,
          typeId: SCATTER_TYPE_ID,
          // The branch guard is the scatter-as-condition idiom: `iterations` evaluates to 0 or 1,
          // and zero iterations IS the branch not being taken. No x/y/z is written -- an absent
          // axis is a zero-width axis at the origin, which is precisely "run this step where the
          // parent is", and it is what the idiom emits.
          contents: featureFileContents(SCATTER_TYPE_ID, itemId, formatVersion, scatterBody(places, { iterations: `${counter} == ${i}` }, nested)),
        }
      }),
    ]

    const notes: PlanNote[] = [
      {
        level: 'info',
        message:
          `Each step runs at the same position. This is a counted scatter over ${steps.length} step` +
          `${steps.length === 1 ? '' : 's'} with an aggregate dispatching on ${counter}, not a sequence_feature -- a ` +
          'sequence_feature would place each step at the previous one\'s result and would stop at the first failure, ' +
          'neither of which can be turned off in JSON.',
      },
      {
        level: 'info',
        message:
          `${counter} is a temp, so it lives for one evaluation of ${identifier}: long enough for the aggregate and its ` +
          'branches to read it, and not long enough to leak into the next placement.',
      },
      {
        level: 'info',
        message:
          `The step counter is advanced in \`${INCREMENT_AXIS}\`, which is the first coordinate evaluated under the default ` +
          'coordinate_eval_order (xzy). Setting coordinate_eval_order on this node by hand would move which axis runs first ' +
          'and stop the counter advancing before the branches read it.',
      },
    ]
    if (setup !== undefined && setup.trim().length > 0 && !setup.trimEnd().endsWith(';')) {
      notes.push({
        level: 'warning',
        message:
          'The setup script does not end in `;`, so it runs straight into the `return` that supplies the step count: ' +
          `\`${setup}return ${steps.length};\`. Add the semicolon unless that is deliberate.`,
      })
    }

    return {
      ok: true,
      expansion: {
        kind: 'steps',
        identifier,
        operations,
        notes,
        creates: [identifier, aggregateId, ...itemIds],
      },
    }
  },
}

export default stepsCompound
