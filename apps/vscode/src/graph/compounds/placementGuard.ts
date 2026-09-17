// placementGuard.ts -- the `placement-guard` compound.
//
// WHAT THIS IS, and the thing it is easiest to misread.
//
// `minecraft:single_block_feature` is the only feature type whose placement is
// gated by block predicates (`may_replace`, `may_attach_to`,
// `may_not_attach_to`). There is no "test this position" feature. So the only
// way to ask "does this position satisfy may_attach_to?" is to try to PLACE a
// block under that predicate and see whether the placement succeeded.
//
// That is what this compound generates:
//
//     aggregate <id> {
//       early_out: "first_failure",
//       features: [
//         <init>,                        # optional, omitted entirely when absent
//         <id>__placement_condition,     # the PROBE   -- single_block + predicates
//         <id>__placement_cleanup,       # the CLEANUP -- single_block of air
//         <places>                       # the payload
//       ]
//     }
//
// The bedrock and the air are NOT what the feature builds. They are a
// predicate, written in the only notation the format has for one. An editor
// that reports either as a redundant write, or as a block that never survives,
// is wrong on every open -- which is how an author learns to stop reading
// diagnostics. `isPlacementGuardPredicateWrite` below exists so a diagnostics
// layer can recognise and exempt the pair; it is the reason this module
// exports more than a CompoundSpec.
//
// -------------------------------------------------------------------------
// VERIFIED AGAINST THE ENGINE PORT, not assumed:
//
// 1. `early_out: "first_failure"` -- features/aggregate.go, AggregateFeature.Place.
//    The running state is ONE optional (`result`), and the loop-tail test is
//
//        if f.earlyOut == earlyOutFirstFailure && result == nil { break }
//
//    (features/aggregate.go:145-147). A child's failure leaves `result` ALONE
//    -- it is sticky: the failure path touches no state (features/aggregate.go:127-133).
//    So `first_failure` means
//    "stop while NOTHING HAS SUCCEEDED YET", not "stop when a child fails".
//
//    CONSEQUENCE, and it is load-bearing for this compound: the guard works
//    only because the probe is the FIRST child that can succeed. Put an
//    `init` in front of it and, whenever that init succeeds, `result` is
//    already non-nil when the probe fails -- the tail test does not fire, and
//    the cleanup and the payload both run anyway. `init` is in the frozen
//    contract (spec.ts's PlacementGuardParams.init) and the idiom emits it,
//    so it is emitted here byte for byte; the hazard is reported as a warning
//    note rather than silently repaired, because repairing it would make this
//    compound stop matching the pack files it has to round-trip.
//
// 2. A `single_block_feature` whose predicates reject the position DOES report
//    failure -- which is what makes (1) usable at all. features/single_block.go,
//    SingleBlockFeature.Place returns nil at every predicate branch:
//      - may_not_attach_to matched          -> nil (single_block.go:307-310)
//      - may_attach_to not satisfied        -> nil (single_block.go:322-326)
//      - may_replace rejected the position  -> nil (single_block.go:334-346)
//    Each logs a failure line and returns nil; there is no branch on which a
//    rejected predicate returns a position.
//    A nil return is exactly the "absent" the aggregate's `result` tracks.
//
// 3. The CLEANUP always lands. `passesAllowList` returns true when
//    `may_replace` is empty (features/single_block.go:282-287), so an air
//    single_block with no predicates cannot be rejected by the replace list,
//    and with no attach condition configured the attach test is not consulted
//    either. It therefore overwrites the probe block it follows.
//
// 4. `enforce_placement_rules` / `enforce_survivability_rules` are REQUIRED by
//    the engine's schema for this type (features/single_block.go:487-503,
//    parseRequiredBool: "the real game would reject this file"). Both are
//    written explicitly, as `false`, into the probe and the cleanup. A
//    generated file that the real game refuses to load is not a file worth
//    generating.
//
// 5. `may_not_attach_to` and `may_attach_to.diagonal` enter the schema at
//    format_version 1.21.40 (features/single_block.go:507-529). Below that the
//    key does not exist and the engine DROPS it unread -- the probe would then
//    test less than the author wrote, and place successfully where they meant
//    it to fail. That is a silent widening of the guard, so it is a warning
//    note keyed on the format_version passed to `expand`.

import type { PlanNote, PlanOperation, Refusal } from '../idioms'
import { formatJsonPath } from '../idioms'
import { CHILD_ROLES, type BlockSpec, type CompoundResult, type CompoundSpec, type PlacementGuardParams } from './spec'

// ---------------------------------------------------------------------------
// Type ids and constants
// ---------------------------------------------------------------------------

const AGGREGATE_TYPE_ID = 'minecraft:aggregate_feature'
const SINGLE_BLOCK_TYPE_ID = 'minecraft:single_block_feature'

/**
 * The early_out the whole construction rests on. See note (1) in the file
 * header for what the engine actually does with it -- it is NOT "stop at the
 * first failing child".
 */
export const PLACEMENT_GUARD_EARLY_OUT = 'first_failure'

/**
 * The probe block when the author names none. `minecraft:bedrock` is what the
 * idiom uses, and the choice is not arbitrary: the probe is written and
 * immediately replaced, so it wants to be a block nothing else in worldgen
 * reacts to.
 */
export const PLACEMENT_GUARD_DEFAULT_PROBE_BLOCK = 'minecraft:bedrock'

/** What the cleanup writes. Always air; it is an erase, not a placement. */
export const PLACEMENT_GUARD_CLEANUP_BLOCK = 'minecraft:air'

/** `__placement_condition` -- from spec.ts's CHILD_ROLES, not re-spelled here. */
export const PLACEMENT_GUARD_PROBE_SUFFIX = CHILD_ROLES.guardProbe()

/** `__placement_cleanup` -- likewise. */
export const PLACEMENT_GUARD_CLEANUP_SUFFIX = CHILD_ROLES.guardCleanup()

/** The format_version at which may_not_attach_to (and may_attach_to.diagonal) exist at all. */
const ATTACH_EXCLUSION_SINCE = '1.21.40'

// ---------------------------------------------------------------------------
// The ids a diagnostics layer has to know about
// ---------------------------------------------------------------------------

/** The probe's identifier: `<guard>__placement_condition`. */
export function placementGuardProbeId(guardIdentifier: string): string {
  return `${guardIdentifier}${PLACEMENT_GUARD_PROBE_SUFFIX}`
}

/** The cleanup's identifier: `<guard>__placement_cleanup`. */
export function placementGuardCleanupId(guardIdentifier: string): string {
  return `${guardIdentifier}${PLACEMENT_GUARD_CLEANUP_SUFFIX}`
}

/** Both ids at once, for a caller that wants to exempt the pair in one step. */
export function placementGuardPredicateIds(guardIdentifier: string): { readonly probe: string; readonly cleanup: string } {
  return { probe: placementGuardProbeId(guardIdentifier), cleanup: placementGuardCleanupId(guardIdentifier) }
}

/**
 * THE EXEMPTION PREDICATE. True when `featureId` is the probe or the cleanup of
 * the placement guard `guardIdentifier` -- i.e. when it is a block write that
 * exists ONLY to evaluate a predicate, and whose written block is never meant
 * to survive.
 *
 * A diagnostics layer MUST consult this before reporting, on `featureId`,
 * anything of the form "this places a block that is immediately overwritten",
 * "this block never survives", "this write is redundant", or "this feature
 * places bedrock / air, did you mean to?". All four are true statements about
 * the pair and all four are the wrong thing to say about it.
 *
 * `guardIdentifier` is required, and that is the point: identity comes from
 * the compound annotation (see spec.ts's "THE EJECT RULE"), so the caller has
 * to have read an annotation naming a placement guard before it can call this.
 * For the weaker, name-only test -- when no annotation is available -- see
 * `looksLikePlacementGuardPredicateWrite`, and read its warning first.
 */
export function isPlacementGuardPredicateWrite(featureId: string, guardIdentifier: string): boolean {
  const ids = placementGuardPredicateIds(guardIdentifier)
  return featureId === ids.probe || featureId === ids.cleanup
}

/**
 * The name-only fallback: does this id END in one of the two generated
 * suffixes?
 *
 * A HINT, NOT AN IDENTITY. spec.ts says so directly -- the generated names are
 * "a strong hint that a subgraph came from a compound, and they are
 * deliberately NOT used as one". A hand-written feature may legitimately carry
 * the suffix, and an ejected subgraph carries it with no annotation left.
 *
 * Use this ONLY to SUPPRESS a diagnostic, never to assert one, and never to
 * collapse a subgraph back into a compound. Suppressing on a false positive
 * costs one unreported redundant write; asserting on one invents a compound
 * the author never grouped.
 */
export function looksLikePlacementGuardPredicateWrite(featureId: string): boolean {
  return featureId.endsWith(PLACEMENT_GUARD_PROBE_SUFFIX) || featureId.endsWith(PLACEMENT_GUARD_CLEANUP_SUFFIX)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function refuse(code: Refusal['code'], reason: string, nodes?: readonly string[]): { readonly ok: false; readonly refusal: Refusal } {
  return { ok: false, refusal: nodes === undefined ? { code, reason } : { code, reason, nodes } }
}

function refusedExpansion(code: Refusal['code'], reason: string, nodes?: readonly string[]): CompoundResult {
  // A refusal carries ZERO operations. There is no partial plan: half a guard
  // is a feature that builds unconditionally, which is worse than none.
  return refuse(code, reason, nodes)
}

/**
 * `namespace:identifier`, checked the way idioms.ts's own `malformedIdReason`
 * checks it -- same rules, same wording shape, because a caller renders these
 * side by side and two dialects of "that id is wrong" read as two bugs.
 */
function malformedIdReason(id: string, what: string): string | null {
  if (id.length === 0) return `${what} is empty; it has to name a feature as "namespace:identifier".`
  const colon = id.indexOf(':')
  if (colon < 0) return `${what} "${id}" has no namespace. Feature identifiers are "namespace:identifier", and a bare name resolves against nothing.`
  if (colon === 0 || colon === id.length - 1) return `${what} "${id}" has an empty half; feature identifiers are "namespace:identifier".`
  if (id.indexOf(':', colon + 1) >= 0) return `${what} "${id}" has more than one ":".`
  if (/\s/.test(id)) return `${what} "${id}" contains whitespace.`
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Both forms spec.ts's BlockSpec accepts, and no third. A bare string, or
 * `{name, states?}`. The engine also reads a `{tags}` descriptor
 * (features/shared.go's AsBlockDescriptor), but BlockSpec does not name it, and
 * widening a frozen type here would make this module accept params the other
 * four compounds reject.
 *
 * The result is a tagged union rather than `BlockSpec | string`: the accepted
 * form INCLUDES a bare string, so a bare-string error channel could not be
 * told apart from a valid value by anything better than sniffing the text.
 */
type BlockSpecCheck = { readonly ok: true; readonly spec: BlockSpec } | { readonly ok: false; readonly reason: string }

function validateBlockSpec(value: unknown, what: string): BlockSpecCheck {
  if (typeof value === 'string') {
    if (value.length === 0) return { ok: false, reason: `${what} is an empty string; it has to name a block, e.g. "minecraft:stone".` }
    return { ok: true, spec: value }
  }
  if (isPlainObject(value)) {
    const name = value['name']
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, reason: `${what} is an object with no "name", so it names no block. Write "minecraft:stone", or {"name": "minecraft:stone"}.` }
    }
    const states = value['states']
    if (states === undefined) return { ok: true, spec: { name } }
    if (!isPlainObject(states)) return { ok: false, reason: `${what}.states must be an object of block states.` }
    return { ok: true, spec: { name, states: states as Readonly<Record<string, unknown>> } }
  }
  return { ok: false, reason: `${what} must be a block name string, or {"name": ..., "states": {...}}.` }
}

/**
 * Is this params object one this compound can express?
 *
 * Never throws. Every rejection is a Refusal whose `reason` is a sentence
 * addressed to the author.
 *
 * NOTE ON THE REFUSAL CODES. `RefusalCode` in idioms.ts is a closed union with
 * no member for "these parameters are malformed" -- it was written for the
 * graph-refactor actions, which refuse over nodes and paths. The closest
 * honest members are reused rather than invented (the union is part of the
 * frozen contract and cannot be widened from here): `id-malformed` for a
 * feature reference that is not "namespace:identifier", `empty-selection` for
 * a guard that tests nothing, and `path-shape` for a params object whose shape
 * this module cannot read.
 */
function validate(params: unknown): { readonly ok: true; readonly params: PlacementGuardParams } | { readonly ok: false; readonly refusal: Refusal } {
  if (!isPlainObject(params)) {
    return refuse('path-shape', 'a placement guard\'s parameters must be a JSON object with at least a "places" feature to guard.')
  }

  const places = params['places']
  if (typeof places !== 'string') {
    return refuse('id-malformed', '"places" is missing. A placement guard needs the feature it guards -- the thing that is placed once the position passes the test.')
  }
  const placesBad = malformedIdReason(places, '"places"')
  if (placesBad !== null) return refuse('id-malformed', placesBad)

  let init: string | undefined
  if (params['init'] !== undefined) {
    const raw = params['init']
    if (typeof raw !== 'string') return refuse('id-malformed', '"init" must be a feature identifier, or be left out entirely.')
    const bad = malformedIdReason(raw, '"init"')
    if (bad !== null) return refuse('id-malformed', bad)
    init = raw
  }

  let probeBlock: BlockSpec | undefined
  if (params['probeBlock'] !== undefined) {
    const checked = validateBlockSpec(params['probeBlock'], '"probeBlock"')
    if (!checked.ok) return refuse('path-shape', checked.reason)
    probeBlock = checked.spec
  }

  let mayReplace: readonly BlockSpec[] | undefined
  if (params['mayReplace'] !== undefined) {
    const raw = params['mayReplace']
    if (!Array.isArray(raw)) {
      return refuse('path-shape', '"mayReplace" must be an array of blocks the probe is allowed to replace.')
    }
    const out: BlockSpec[] = []
    for (let i = 0; i < raw.length; i++) {
      const checked = validateBlockSpec(raw[i], `"mayReplace"[${i}]`)
      if (!checked.ok) return refuse('path-shape', checked.reason)
      out.push(checked.spec)
    }
    mayReplace = out
  }

  let mayAttachTo: Readonly<Record<string, unknown>> | undefined
  if (params['mayAttachTo'] !== undefined) {
    const raw = params['mayAttachTo']
    if (!isPlainObject(raw)) return refuse('path-shape', '"mayAttachTo" must be an object of face names ("top", "bottom", "sides", ...) to blocks.')
    if (Object.keys(raw).length === 0) {
      return refuse('empty-selection', '"mayAttachTo" is an empty object, so it tests nothing. Name at least one face, or leave the key out.')
    }
    mayAttachTo = raw
  }

  let mayNotAttachTo: Readonly<Record<string, unknown>> | undefined
  if (params['mayNotAttachTo'] !== undefined) {
    const raw = params['mayNotAttachTo']
    if (!isPlainObject(raw)) return refuse('path-shape', '"mayNotAttachTo" must be an object of face names ("top", "bottom", "sides", ...) to blocks.')
    if (Object.keys(raw).length === 0) {
      return refuse('empty-selection', '"mayNotAttachTo" is an empty object, so it excludes nothing. Name at least one face, or leave the key out.')
    }
    mayNotAttachTo = raw
  }

  // A guard with no predicate at all is not a guard. The probe would place
  // bedrock wherever it was asked to, succeed unconditionally, and the whole
  // three-feature construction would reduce to "place the payload" with two
  // pointless writes -- which is the one reading the diagnostics layer is being
  // told to EXEMPT. Refusing here is what keeps that exemption honest.
  const hasReplace = mayReplace !== undefined && mayReplace.length > 0
  if (!hasReplace && mayAttachTo === undefined && mayNotAttachTo === undefined) {
    return refuse(
      'empty-selection',
      'a placement guard tests nothing: none of "mayReplace", "mayAttachTo" or "mayNotAttachTo" is set. The probe would ' +
        'succeed everywhere, so the guard would place its feature everywhere -- which is what placing the feature directly ' +
        'already does. Give it a test, or drop the guard.',
    )
  }

  // Rebuilt field by field rather than passed through, so a params object
  // carrying extra keys cannot smuggle them into the expansion.
  const clean: Record<string, unknown> = { places }
  if (probeBlock !== undefined) clean['probeBlock'] = probeBlock
  if (mayReplace !== undefined) clean['mayReplace'] = mayReplace
  if (mayAttachTo !== undefined) clean['mayAttachTo'] = mayAttachTo
  if (mayNotAttachTo !== undefined) clean['mayNotAttachTo'] = mayNotAttachTo
  if (init !== undefined) clean['init'] = init
  return { ok: true, params: clean as unknown as PlacementGuardParams }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** The bare half of an identifier -- what a generated file is named after. */
function bareId(identifier: string): string {
  const colon = identifier.indexOf(':')
  return colon < 0 ? identifier : identifier.slice(colon + 1)
}

/**
 * Where a generated feature file goes. `features/<bare id>.json`, the layout
 * features/registry.go reads ("a features/*.json file as delivered by the pack
 * loader") and the one every fixture in this repo uses.
 */
function featureFile(identifier: string): string {
  return `features/${bareId(identifier)}.json`
}

/** A complete feature file, keys in the order a hand-written one has them. */
function featureFileContents(typeId: string, identifier: string, formatVersion: string, body: Record<string, unknown>): string {
  const document = {
    format_version: formatVersion,
    [typeId]: { description: { identifier }, ...body },
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** `1.21.40` -> [1, 21, 40]. A part that is not a number sorts as 0. */
function versionParts(version: string): number[] {
  return version.split('.').map((p) => {
    const n = Number.parseInt(p, 10)
    return Number.isNaN(n) ? 0 : n
  })
}

/** Is `version` at least `floor`? An unparseable version reads as "modern", which is the policy
 * features/formatversion.go's AtLeastOrUnversioned applies to an absent one. */
function atLeast(version: string, floor: string): boolean {
  const a = versionParts(version)
  const b = versionParts(floor)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av > bv
  }
  return true
}

/** The probe's body: the throwaway block, plus the predicates that are the actual test. */
function probeBody(params: PlacementGuardParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // Both required by the engine's schema for this type -- see header note (4).
    // False on purpose: the probe asks the author's question and nothing else.
    enforce_placement_rules: false,
    enforce_survivability_rules: false,
    places_block: params.probeBlock ?? PLACEMENT_GUARD_DEFAULT_PROBE_BLOCK,
  }
  if (params.mayReplace !== undefined && params.mayReplace.length > 0) body['may_replace'] = params.mayReplace
  if (params.mayAttachTo !== undefined) body['may_attach_to'] = params.mayAttachTo
  if (params.mayNotAttachTo !== undefined) body['may_not_attach_to'] = params.mayNotAttachTo
  return body
}

/**
 * The cleanup's body. Air, and deliberately NO predicates: an empty
 * `may_replace` is "no constraint" (features/single_block.go:282-287), so the
 * erase cannot itself fail and strand a probe block in the world.
 */
function cleanupBody(): Record<string, unknown> {
  return {
    enforce_placement_rules: false,
    enforce_survivability_rules: false,
    places_block: PLACEMENT_GUARD_CLEANUP_BLOCK,
  }
}

function expand(identifier: string, params: PlacementGuardParams, formatVersion: string): CompoundResult {
  const idBad = malformedIdReason(identifier, 'the guard\'s own identifier')
  if (idBad !== null) return refusedExpansion('id-malformed', idBad)

  if (formatVersion === '') {
    return refusedExpansion(
      'no-format-version',
      'a placement guard writes three feature files, and each has to declare a format_version -- it decides whether ' +
        'may_not_attach_to is a key the engine reads at all, so it is not a detail this can pick.',
    )
  }

  const probeId = placementGuardProbeId(identifier)
  const cleanupId = placementGuardCleanupId(identifier)

  // The aggregate's child order IS the mechanism. init (if any), then the
  // probe, then the erase, then the payload.
  const children: string[] = []
  if (params.init !== undefined) children.push(params.init)
  children.push(probeId, cleanupId, params.places)

  const aggregateBody: Record<string, unknown> = {
    early_out: PLACEMENT_GUARD_EARLY_OUT,
    features: children,
  }

  const operations: readonly PlanOperation[] = [
    {
      op: 'createFile',
      file: featureFile(identifier),
      contents: featureFileContents(AGGREGATE_TYPE_ID, identifier, formatVersion, aggregateBody),
      identifier,
      typeId: AGGREGATE_TYPE_ID,
    },
    {
      op: 'createFile',
      file: featureFile(probeId),
      contents: featureFileContents(SINGLE_BLOCK_TYPE_ID, probeId, formatVersion, probeBody(params)),
      identifier: probeId,
      typeId: SINGLE_BLOCK_TYPE_ID,
    },
    {
      op: 'createFile',
      file: featureFile(cleanupId),
      contents: featureFileContents(SINGLE_BLOCK_TYPE_ID, cleanupId, formatVersion, cleanupBody()),
      identifier: cleanupId,
      typeId: SINGLE_BLOCK_TYPE_ID,
    },
  ]

  const probeIndex = params.init === undefined ? 1 : 2
  const probePath = formatJsonPath([{ key: AGGREGATE_TYPE_ID }, { key: 'features' }, { index: probeIndex }])

  const notes: PlanNote[] = [
    {
      level: 'info',
      message:
        `${probeId} places ${describeBlock(params.probeBlock ?? PLACEMENT_GUARD_DEFAULT_PROBE_BLOCK)} and ${cleanupId} ` +
        'immediately replaces it with air. Neither block is part of what this feature builds: they are how a block ' +
        'predicate is written, because single_block_feature\'s placement predicates are the only way to ask whether a ' +
        'position satisfies one. Do not "clean up" either of them.',
    },
    {
      level: 'info',
      message:
        'Where the probe passes, the position is left holding AIR rather than whatever was there before -- the cleanup ' +
        'erases, it does not restore. That is invisible only when the guarded feature writes its own block at the same ' +
        'position, which is the usual case.',
    },
  ]

  if (params.init !== undefined) {
    notes.push({
      level: 'warning',
      message:
        `"init" (${params.init}) runs before the probe at ${probePath}, and that weakens the guard. early_out ` +
        '"first_failure" stops the aggregate only while NOTHING has succeeded yet -- a child\'s failure does not clear ' +
        `the running result. So on any position where ${params.init} succeeds and the probe then fails, the aggregate ` +
        `does NOT stop: the cleanup and ${params.places} both run anyway, and the test has no effect. This is what the ` +
        'shape does, not a defect in this expansion; if the guard has to hold, move the init behind the payload or ' +
        'give it its own aggregate.',
    })
  }

  if (params.mayNotAttachTo !== undefined && !atLeast(formatVersion, ATTACH_EXCLUSION_SINCE)) {
    notes.push({
      level: 'warning',
      message:
        `"mayNotAttachTo" is written into ${probeId}, but may_not_attach_to entered single_block_feature's schema at ` +
        `format_version ${ATTACH_EXCLUSION_SINCE} and these files declare ${formatVersion}. The engine drops the key ` +
        'unread, so the probe tests LESS than was written and the guard passes in places it was meant to reject. ' +
        `Raise the format_version to ${ATTACH_EXCLUSION_SINCE} or express the exclusion through may_replace.`,
    })
  }

  if (params.mayAttachTo !== undefined && params.mayAttachTo['diagonal'] !== undefined && !atLeast(formatVersion, ATTACH_EXCLUSION_SINCE)) {
    notes.push({
      level: 'warning',
      message:
        `"mayAttachTo.diagonal" needs format_version ${ATTACH_EXCLUSION_SINCE}; these files declare ${formatVersion}, ` +
        'where the engine drops that face unread and the four horizontal diagonals are simply not tested.',
    })
  }

  if (params.mayAttachTo !== undefined && params.mayAttachTo['min_sides_must_attach'] === undefined) {
    const sideKeys = ['north', 'south', 'east', 'west', 'sides', 'all', 'diagonal']
    if (sideKeys.some((k) => params.mayAttachTo?.[k] !== undefined)) {
      notes.push({
        level: 'info',
        message:
          '"mayAttachTo" names side faces but no "min_sides_must_attach". The engine\'s factory default is 4, so the ' +
          'probe demands all four sides match before it will place. Set min_sides_must_attach: 1 if one matching side ' +
          'is what the guard means.',
      })
    }
  }

  return {
    ok: true,
    expansion: {
      kind: 'placement-guard',
      identifier,
      operations,
      notes,
      creates: [identifier, probeId, cleanupId],
    },
  }
}

function describeBlock(spec: BlockSpec): string {
  return typeof spec === 'string' ? spec : spec.name
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export const placementGuardSpec: CompoundSpec<PlacementGuardParams> = {
  kind: 'placement-guard',
  title: 'Place only where the blocks allow',
  summary: 'Tests a position against block predicates and places your feature only where the test passes.',
  validate,
  expand,
}

export default placementGuardSpec
