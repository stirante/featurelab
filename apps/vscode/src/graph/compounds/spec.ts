// The compound node contract, as the editor sees it.
//
// This file is the FROZEN CONTRACT for compound feature nodes. Four compounds
// are implemented against it at once; it cannot change without coordinating.
//
// WHAT A COMPOUND IS. Minecraft has no compound feature types. A compound is a
// node the EDITOR offers, which expands into a subgraph of ordinary vanilla
// features. The four here are not invented: each one is a helper that pack
// build steps tend to grow on their own, because writing that shape out by hand
// in JSON was not worth doing twice. Nobody writes an abstraction for
// something that is comfortable to click, so each surviving helper marks a
// shape the raw format makes painful -- which is what makes that set a
// specification of what this editor has to make clickable, rather than a list
// somebody thought up.
//
// THE PARAMETERS ARE THE SOURCE; THE SUBGRAPH IS DERIVED. This is the whole
// design, and the one thing not to get wrong.
//
// A collapsed node has to show the author their own inputs -- the list of
// conditions, the setup script, the level variable. Those inputs do not
// survive expansion in recoverable form: a loop's step script is folded into
// whichever coordinate is evaluated first, and a setup script is concatenated
// ahead of a `return`. Recovering them would mean
// parsing generated Molang back into authorial intent, which is exactly the
// inference this project decided against -- in an editor, a heuristic that
// sometimes fires is worse than none, because it collapses nodes the author
// never grouped.
//
// So the parameters are WRITTEN DOWN, verbatim, in the annotation. The JSON is
// derived from them the way a build output is derived from its source, and
// nothing is ever recovered from the subgraph.
//
// THE EJECT RULE. A compound renders collapsed, and can be expanded to look at
// the machinery. Looking is free -- canvas position lives in the layout
// sidecar, never in the JSON. Editing the collapsed node's own fields
// regenerates the subgraph and stays collapsed. Editing the EXPANDED subgraph
// drops the annotation permanently and leaves a plain vanilla graph: one-way,
// warned before the first change, and never reversible -- because reversing it
// is precisely the shape-recognition that was ruled out.

import type { PlanOperation, PlanNote, Refusal } from '../idioms'
import { DEFAULT_PLACEMENT_PASS } from '../typeCatalog.js'

/**
 * The four compounds. These names are what the user sees, and they were chosen
 * to say what you GET rather than how it is built:
 *
 * - `loop`   was `MolangScatterFeature`. "Molang" named the implementation.
 * - `steps`  was `FixedSequenceFeature`. "Fixed sequence" sitting next to the
 *            real `sequence_feature` invited exactly the confusion that makes
 *            this compound necessary -- see COMPOUND_KIND_NOTES.steps.
 * - `placement-guard` was `PlacementConditionFeature`. "Condition" suggested
 *            a branch; it is a block-predicate test in front of one placement.
 * - `column` absorbs both `ColumnFeature` and `ColumnReversedFeature` under an
 *            `order` parameter; see ColumnParams for why that direction is a
 *            real difference in the engine and not a presentational one.
 */
export type CompoundKind = 'loop' | 'steps' | 'placement-guard' | 'column'

export const COMPOUND_KINDS: readonly CompoundKind[] = [
  'loop',
  'steps',
  'placement-guard',
  'column',
]

export function isCompoundKind(value: string): value is CompoundKind {
  return (COMPOUND_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * A Molang expression exactly as the author typed it.
 *
 * It is a string and not a number, everywhere, on purpose. `iterations` and
 * every coordinate are full Molang evaluated against a scope shared with
 * whatever the scatter delegates to, and real packs lean on that: a count that
 * evaluates to 0 is how a branch is skipped, and assignments in the same
 * expression are how a child is set up. A common idiom decodes a
 * flat iteration index back into (x, y, z) with div and mod to run a 3-D scan
 * as a 1-D loop. A UI that models any of these as a spin-box makes that
 * unwritable.
 */
export type Molang = string

/** A `namespace:identifier` reference to another feature. */
export type FeatureRef = string

/**
 * `loop` -- one `scatter_feature`.
 *
 *     scatter {
 *       iterations: "<setup>return <count>;"
 *       <first axis of coordinate_eval_order>: "<step>return <x|y|z>;"
 *     }
 *
 * Two idioms in one node, and both are load-bearing. `iterations` runs ONCE
 * before the loop, so it is also the setup script; the trailing `return` is
 * what lets one expression be both. The first EVALUATED coordinate runs once
 * per iteration, so it is also the step script.
 */
export interface LoopParams {
  readonly count: Molang
  readonly places: FeatureRef
  /** Runs once, before the first iteration. Empty means none. */
  readonly setup?: Molang
  /**
   * Runs once per iteration.
   *
   * IT IS WRITTEN INTO WHICHEVER AXIS `coordinateEvalOrder` NAMES FIRST -- the
   * library literally picks `coordinateEvalOrder.at(0)`, and an implementation
   * must do the same. This is why the two fields cannot be edited
   * independently: changing the evaluation order without moving the step
   * script leaves the loop running and its bookkeeping happening in the wrong
   * order, which no schema check can see.
   */
  readonly step?: Molang
  readonly x?: Molang
  readonly y?: Molang
  readonly z?: Molang
  /** Defaults to the schema's own default, `xzy` -- NOT to `xyz`. */
  readonly coordinateEvalOrder?: string
  readonly scatterChance?: number
  readonly projectInputToFloor?: boolean
}

/**
 * `steps` -- run each child in order, all at the same position, and do not
 * stop at a failure.
 *
 *     scatter {
 *       iterations: "t.<id>__sequence = -1; <setup>return <N>;"
 *       x: "t.<id>__sequence = t.<id>__sequence + 1; return 0;"   # y, z = 0
 *       places_feature: aggregate {
 *         early_out: "first_success",
 *         features: [ scatter { iterations: "t.<id>__sequence == i" }, ... ]
 *       }
 *     }
 *
 * See COMPOUND_KIND_NOTES.steps for why this exists at all rather than using
 * `sequence_feature`. `first_success` is correct because exactly one branch
 * matches per iteration.
 */
export interface StepsParams {
  readonly steps: readonly FeatureRef[]
  readonly setup?: Molang
}

/**
 * `placement-guard` -- test a position with block predicates, then place.
 *
 *     aggregate {
 *       early_out: "first_failure",
 *       features: [
 *         <init>,                                     # optional
 *         single_block { places_block: <probe>, may_replace / may_attach_to },
 *         single_block { places_block: minecraft:air },
 *         <places>
 *       ]
 *     }
 *
 * `single_block_feature`'s placement predicates are the only way to ask "does
 * this position satisfy may_attach_to?", so the author places a throwaway
 * block to run the test, deletes it, and relies on `first_failure` to skip
 * everything after a failed probe.
 *
 * AN EDITOR MUST NOT REPORT THE PROBE OR THE CLEANUP AS A REDUNDANT WRITE, or
 * as a block that never survives. They are a predicate. That diagnostic would
 * fire on every open, be wrong every time, and train the author to stop
 * reading diagnostics -- which costs more than the feature is worth.
 */
export interface PlacementGuardParams {
  readonly places: FeatureRef
  /** Probe block. Defaults to `minecraft:bedrock`, as the idiom does. */
  readonly probeBlock?: BlockSpec
  readonly mayReplace?: readonly BlockSpec[]
  readonly mayAttachTo?: Readonly<Record<string, unknown>>
  readonly mayNotAttachTo?: Readonly<Record<string, unknown>>
  /** Runs before the probe, inside the same `first_failure` aggregate. */
  readonly init?: FeatureRef
}

/** A block, in either form the schema accepts. */
export type BlockSpec = string | { readonly name: string; readonly states?: Readonly<Record<string, unknown>> }

/**
 * `column` -- place a feature at each level between two bounds.
 *
 * THE RANGE IS HALF-OPEN: the idiom computes `iterations = max - min`, so
 * the levels placed are `minY` up to but NOT including `maxY`. That is what
 * existing packs do and this reproduces it; a UI must label the field so nobody
 * expects the top level to be included.
 *
 * `order` IS THE PARAMETER THAT SELECTS THE SHAPE, and it names a real
 * difference in the engine -- one I got wrong once and am recording properly
 * so nobody re-derives it. Reading only the `DistFixedGrid` arithmetic
 * (`modulus = max - min + 1`, `indexed = gridOffset + min + index*stepSize`)
 * suggests the grid ascends. It does not, because of what feeds `index`: the
 * scatter's iteration index COUNTS DOWN. `features/distribution.go` passes
 * `index := iterations - 1 - i`, with a comment recording that the game's
 * position generator passes the post-decrement counter, and that this holds
 * in both game versions. So:
 *
 *   'top-down'  (default) -> the `fixed_grid` shape. y is a distribution over
 *              [0, iterations-1], which the descending index walks from the
 *              TOP level down. Nothing runs per iteration, and the child
 *              cannot see which level it is on. A non-zero `minY` needs an
 *              outer scatter that applies the offset once and returns 1,
 *              wrapping an inner scatter that does the grid.
 *
 *   'bottom-up' -> the counter shape (the reversed-column helper): a
 *              `loop` whose setup seeds a variable at -1, whose step
 *              increments it, and whose y is `<min> + <variable>`.
 *
 * THE ORDER IS LOAD-BEARING, not cosmetic. By the engine port's own account
 * the direction decides which placement wins an overlapping cell, the order
 * children consume RNG, and the position the scatter finally returns. Two
 * columns differing only in `order` produce different worlds.
 *
 * `levelVariable` rides along with 'bottom-up' because only that shape has a
 * counter to expose. Naming it is what lets the child READ its own level,
 * which is the reason that shape exists at all. Setting it while `order` is
 * 'top-down' is a refusal, not a silent switch: quietly flipping the
 * placement order to satisfy a different field is exactly the kind of
 * invisible change this contract exists to prevent.
 *
 * `step` likewise exists only in the 'bottom-up' shape.
 */
export interface ColumnParams {
  readonly places: FeatureRef
  /** Exclusive upper bound -- see the half-open note above. */
  readonly maxY: Molang
  readonly minY?: Molang
  readonly setup?: Molang
  /** Placement order. Defaults to 'top-down', the plain `fixed_grid` shape. */
  readonly order?: ColumnOrder
  /** Exposes the level to the child. Requires `order: 'bottom-up'`. */
  readonly levelVariable?: string
  /** Per-level script. Requires `order: 'bottom-up'`. */
  readonly step?: Molang
}

/**
 * Which end of the column is placed first. Not cosmetic -- see ColumnParams.
 */
export type ColumnOrder = 'top-down' | 'bottom-up'

export type CompoundParams =
  | { readonly kind: 'loop'; readonly params: LoopParams }
  | { readonly kind: 'steps'; readonly params: StepsParams }
  | { readonly kind: 'placement-guard'; readonly params: PlacementGuardParams }
  | { readonly kind: 'column'; readonly params: ColumnParams }

// ---------------------------------------------------------------------------
// The annotation
// ---------------------------------------------------------------------------

/** The directive name, without the `@featurelab:` prefix. */
export const COMPOUND_DIRECTIVE = 'idiom'

/**
 * How a compound is recorded in the file.
 *
 * The directive carries the kind in its single whitespace-split argument, and
 * the parameters follow as JSON on the comment lines beneath it -- which is
 * `Annotation.Text`, the only part of the mechanism that can hold spaces:
 *
 *     {
 *       "format_version": "1.21.0",
 *       // @featurelab:idiom loop
 *       // {"count":"4","places":"ns:a","setup":"v.n = 0;"}
 *       "minecraft:scatter_feature": { ... }
 *     }
 *
 * IT GOES DIRECTLY ABOVE THE TYPE KEY, and the position is not cosmetic. A
 * directive attaches to the member that FOLLOWS it, so an earlier version of
 * this comment -- which put it at the top of the file and claimed `jsonPath`
 * would be `$` -- actually produced `$.format_version`, an annotation about
 * the compound hanging off the version string. Measured, not reasoned: the
 * graph reports it.
 *
 * Above the type key it reports `$.minecraft:scatter_feature`, which is the
 * body key, which is exactly the root every edge JSONPath in the same file
 * starts from. That is what makes annotations and edges live in ONE
 * coordinate system and be comparable at all.
 *
 * Both halves are needed and neither is redundant. The kind alone would leave
 * the parameters to be parsed back out of generated Molang; the parameters
 * alone would not say which compound produced them.
 */
export interface CompoundAnnotation {
  readonly kind: CompoundKind
  readonly params: unknown
}

/** Encodes to the `Text` body. One line, so it survives a `//` comment. */
export function encodeCompoundParams(params: unknown): string {
  return JSON.stringify(params)
}

/**
 * Decodes the `Text` body. Returns `null` -- never throws, and never guesses --
 * on anything that is not a JSON object, because a malformed annotation must
 * degrade to "show the raw subgraph", exactly as a missing one does.
 */
export function decodeCompoundParams(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Child naming. The idiom generates `<parent>__<role>_<n>`, and an
 * implementation must match it byte for byte: an existing pack already holds
 * these ids, and a rename would orphan every reference to one.
 *
 * The names are a strong hint that a subgraph came from a compound, and they
 * are deliberately NOT used as one. Identity comes from the annotation alone.
 */
export const CHILD_ROLES = {
  stepsItem: (n: number) => `__item_${n}`,
  stepsAggregate: () => `__aggregate`,
  columnInner: () => `__column`,
  guardProbe: () => `__placement_condition`,
  guardCleanup: () => `__placement_cleanup`,
} as const

/**
 * The variable a `steps` compound's parts talk to each other through.
 *
 * It uses `t.` (scoped to one evaluation, which is exactly the lifetime
 * wanted). The `.` in an identifier becomes `_`, and the namespace is stripped
 * first.
 */
export function compoundVariable(identifier: string): string {
  const bare = identifier.includes(':') ? identifier.slice(identifier.indexOf(':') + 1) : identifier
  const safe = bare.split('.').join('_')
  return `t.${safe}__sequence`
}

/**
 * What expanding a compound produces.
 *
 * `operations` reuses `PlanOperation` from idioms.ts unchanged, so the Go side
 * applies a compound exactly as it applies an idiom -- one apply path, not two.
 * That is why this module depends on idioms.ts and not the other way round.
 *
 * A compound spanning several files -- most do, since each generated child is
 * its own feature file -- comes out as a list of `createFile` operations, the
 * first of which is the compound's OWN file, the one holding the annotation.
 * That file exists from the moment the compound does, so re-expansion sets
 * `replace` on it; see `PlanOperation`'s `createFile` for why that flag has to
 * be explicit rather than inferred.
 *
 * WHAT AN EXPANSION CANNOT DO, and an earlier version of this comment wrongly
 * said it would: emit the `delete` of a child the new parameters no longer
 * produce. `expand` is pure and is handed no prior state -- it cannot know
 * which children existed a moment ago. Removing them is the caller's job, by
 * diffing the previous `creates` against the new one. Four implementations
 * reported this independently, which is what it took to notice.
 */
export interface CompoundExpansion {
  readonly kind: CompoundKind
  readonly identifier: string
  readonly operations: readonly PlanOperation[]
  readonly notes: readonly PlanNote[]
  /** Ids this expansion creates, in the order they are written. */
  readonly creates: readonly string[]
}

export type CompoundResult =
  | { readonly ok: true; readonly expansion: CompoundExpansion }
  | { readonly ok: false; readonly refusal: Refusal }

/**
 * Every compound implements this, and nothing else is required of it.
 *
 * `expand` must be PURE and TOTAL: the same parameters always give the same
 * operations in the same order (a re-expansion after an unrelated edit must
 * not churn the file), and anything it cannot express comes back as a refusal
 * with zero operations rather than a partial plan. Refusals reuse idioms.ts's
 * `Refusal` so a caller has one way to render "no, and here is why".
 */
export interface CompoundSpec<P> {
  readonly kind: CompoundKind
  /** What the palette shows. */
  readonly title: string
  /** One sentence, shown under the title. Says what you get, not how. */
  readonly summary: string
  /** Rejects malformed parameters without throwing. */
  validate(params: unknown): { readonly ok: true; readonly params: P } | { readonly ok: false; readonly refusal: Refusal }
  /** `identifier` is the compound's own `namespace:id`; children hang off it. */
  expand(identifier: string, params: P, formatVersion: string): CompoundResult
}

/**
 * Why each compound exists, for anyone who wonders whether it could be dropped.
 * Kept here rather than in a README because the answer is what stops someone
 * "simplifying" one away.
 */
export const COMPOUND_KIND_NOTES: Readonly<Record<CompoundKind, string>> = {
  loop:
    'A scatter whose iterations doubles as a setup script and whose first evaluated ' +
    'coordinate doubles as a per-step script. Both idioms are in every real pack, and ' +
    'neither is discoverable from the schema.',
  steps:
    'minecraft:sequence_feature does two things nobody asks for: it re-targets each ' +
    'child at the previous child\'s successful result, so the position drifts, and it ' +
    'always behaves as first_failure with no schema key to change it, so one ' +
    'failure cuts the rest. This compound runs every child at the same origin and lets ' +
    'a failure pass -- which is what people expect a sequence to do.',
  'placement-guard':
    'single_block_feature\'s placement predicates are the only way to ask whether a ' +
    'position satisfies may_attach_to. The probe-and-cleanup pair is a predicate, not ' +
    'a build, and must never be diagnosed as a redundant write.',
  column:
    'One feature at each level between two bounds, over a half-open range. The placement ' +
    'order decides which write wins an overlap and in what order children draw RNG, so the ' + 'two directions are different worlds, not a preference.',
}

/**
 * Where a feature file lives, given its identifier.
 *
 * `expand` is handed no path, and five implementations independently arrived
 * at this same convention and each attached a note saying it was a guess. It
 * is not a guess -- it is what `pack.Load` walks and what every fixture in
 * this repo uses -- so it is recorded here once, and the notes can go.
 *
 * The namespace is stripped: `example:oak_tree` lives at `features/oak_tree.json`.
 * A pack that puts features elsewhere is a case this does not yet handle, and
 * the honest fix then is a path argument, not a cleverer guess here.
 */
export function featureFilePath(identifier: string): string {
  return `features/${bareName(identifier)}.json`
}

/**
 * Where a feature RULE file lives, given its identifier. The pack's second
 * convention, recorded beside the first so there is one implementation of each
 * rather than one per caller -- terraform.ts wrote its own before this existed.
 *
 * THE EXTENSION IS THE TRAP, and it is worth the paragraph. The engine compares
 * the identifier's NAME half -- everything after the last `:` -- against the
 * file's own name with ONE extension stripped. So `example:volcano` belongs at
 * `feature_rules/volcano.json`; written as `feature_rules/volcano.fr.json` the
 * file's name reads as `volcano.fr`, which is not `volcano`, and every load
 * logs a mismatch. The mirror image is just as real and is why this cannot
 * simply strip `.fr` too: a pack whose rule is honestly named
 * `example:volcano.fr` is CORRECT at `feature_rules/volcano.fr.json`, because
 * that is the name its identifier claims. The name half and the file name have
 * to be the same string; nothing else about either is special.
 *
 * The mismatch is a warning in the engine, not a refusal: the rule loads and
 * runs either way. `ruleFileNameNote` is the editor's version of that warning.
 */
export function ruleFilePath(identifier: string): string {
  return `feature_rules/${bareName(identifier)}.json`
}

/** Where a node of `typeId` belongs. The one branch a creation path needs: a
 * rule is not a feature and does not live in `features/`. */
export function nodeFilePath(typeId: string | undefined, identifier: string): string {
  return typeId === RULE_TYPE_ID ? ruleFilePath(identifier) : featureFilePath(identifier)
}

/** The name half of an identifier: everything after the last `:`, which is
 * what the engine compares a rule's file name against, and what both path
 * builders above use as the file's stem. */
export function bareName(identifier: string): string {
  const colon = identifier.lastIndexOf(':')
  return colon >= 0 ? identifier.slice(colon + 1) : identifier
}

/**
 * The synthetic type a rule NODE carries, and the key its FILE is rooted at.
 *
 * They are different strings and neither is derived from the other by trimming
 * an `s`: the graph names one rule, so its node is the SINGULAR
 * `minecraft:feature_rule`; the file's root key names the collection, so it is
 * the PLURAL `minecraft:feature_rules`. A JSONPath built from the node's type
 * does not address the wrong thing in a rule file -- it addresses nothing, and
 * the write fails with "$.minecraft:feature_rule does not exist".
 */
export const RULE_TYPE_ID = 'minecraft:feature_rule'
export const RULE_BODY_KEY = 'minecraft:feature_rules'

/** The root key a node of `typeId` writes its body under -- the type id itself
 * for every feature, and the plural collection key for a rule. */
export function nodeBodyKey(typeId: string): string {
  return typeId === RULE_TYPE_ID ? RULE_BODY_KEY : typeId
}

/**
 * What the editor should say when it meets a rule whose file name and
 * identifier disagree -- `feature_rules/test_rule.fr.json` declaring
 * `wiki:test_rule` being the shape that sends people looking for a bug that is
 * not there. Null when they agree.
 *
 * A DIAGNOSTIC AND NOT A REFUSAL, because that is what the engine does: it logs
 * the mismatch and loads the rule anyway. A pack full of these generates
 * exactly what it should, and an editor that refused to open one -- or that
 * "helpfully" renamed the file -- would be wrong about the thing it is warning
 * about.
 */
export function ruleFileNameNote(identifier: string, file: string): string | null {
  const written = ruleFileStem(file)
  const expected = bareName(identifier)
  if (written === null || written === expected) return null
  return (
    `The engine compares a rule's identifier against its own file name with one extension removed, and here they differ: ` +
    `"${identifier}" has the name "${expected}" while ${file} reads as "${written}". The rule LOADS and runs either way -- ` +
    `this is a log line, not a failure -- but every load repeats it. Renaming the file to ` +
    `"${ruleFilePath(identifier)}" silences it, and so does spelling the identifier "${written}" instead.`
  )
}

/** A rule file's own name as the engine derives it: the last path segment with
 * ONE extension removed. Null for a path with no name to read. */
export function ruleFileStem(file: string): string | null {
  const name = file.split(/[/\\]/).pop() ?? ''
  if (name === '') return null
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * What a rule created from scratch places, until the author says otherwise.
 *
 * `example:` is a namespace no real pack owns, and is what this editor already
 * uses wherever it has to write a reference it cannot know -- so an unfinished
 * rule is a VISIBLE dangling edge on the canvas rather than a silent wrong one.
 */
export const PLACEHOLDER_FEATURE = 'example:replace_me'

export interface NewRuleOptions {
  /** The feature the rule places. Defaults to PLACEHOLDER_FEATURE. */
  placesFeature?: string
  /** The decoration pass. Defaults to typeCatalog's DEFAULT_PLACEMENT_PASS. */
  placementPass?: string
  /** `conditions["minecraft:biome_filter"]`, verbatim. Omitted entirely when absent, which is
   * how a rule says "every biome this pass reaches" -- an empty object would say the same thing
   * and read as a setting somebody meant to fill in. */
  biomeFilter?: Record<string, unknown> | undefined
  /** Replaces the default `{iterations: 1}` wholesale. */
  distribution?: Record<string, unknown>
}

/**
 * The body of a new feature rule: the smallest one the engine LOADS and that
 * then actually does something.
 *
 * WHY IT NAMES A FEATURE THAT MAY NOT EXIST YET, rather than refusing to create
 * a rule until one does. `places_feature` is required -- a rule without it
 * fails a required field and the game refuses the whole file -- so "create the
 * rule now, attach it later" is only possible with a placeholder in it. The
 * alternative is refusing, and refusing gets the order of work backwards: a
 * pack is just as often designed rule-first ("something should generate on
 * beaches") as feature-first, and an editor that cannot express the first half
 * of that thought sends the author back to a text editor, which is the exact
 * situation this panel exists to end. So the rule is created UNATTACHED BUT
 * LOADABLE: valid, listed, drawn, and joined by a dangling edge that the canvas
 * already renders as "nothing in this pack defines this" -- which is a
 * to-do the author can see and drag, instead of a dialog that says no.
 *
 * WHY `iterations` IS WRITTEN. `distribution` is optional to the schema, and a
 * rule without one loads with default-constructed parameters: iterations 0.
 * That rule is inserted, attached to its pass and its biomes, and then places
 * nothing in every chunk forever -- correct, live and inert, with no error
 * anywhere. A new rule that does nothing until you find that out is not a
 * created rule, so the smallest value that makes it run is written out.
 */
export function newRuleBody(identifier: string, options: NewRuleOptions = {}): Record<string, unknown> {
  const conditions: Record<string, unknown> = { placement_pass: options.placementPass ?? DEFAULT_PLACEMENT_PASS }
  if (options.biomeFilter !== undefined) conditions['minecraft:biome_filter'] = options.biomeFilter
  return {
    description: {
      identifier,
      places_feature: options.placesFeature ?? PLACEHOLDER_FEATURE,
    },
    conditions,
    distribution: options.distribution ?? { iterations: 1 },
  }
}

/** A complete feature-rule file. The sibling of idioms.ts's
 * `featureFileContents`, in the same layout the compounds write: the body's
 * `description` first, two-space indent, trailing newline. A generated file
 * that reads unlike the hand-written ones beside it is a generated file people
 * rewrite by hand. */
export function ruleFileContents(identifier: string, formatVersion: string, options: NewRuleOptions = {}): string {
  const document = { format_version: formatVersion, [RULE_BODY_KEY]: newRuleBody(identifier, options) }
  return `${JSON.stringify(document, null, 2)}\n`
}
