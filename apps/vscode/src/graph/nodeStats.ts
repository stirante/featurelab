// nodeStats.ts -- what one run has to say about one graph node, and how to say it honestly.
//
// Reads profiler.FeatureProfileStats (entered / blocksWritten / delegations / selfMs /
// inclusiveMs, one row per feature identifier entered at least once) and turns it into a per-node
// row an editor can put on the node box itself. A node that eats 60% of the run's writes should
// be able to say so where someone is already looking, before the pack ever reaches the game.
//
// Headless like attribution.ts: no DOM, no VS Code API, no file I/O.
//
// # The three counters are three different problems
//
// The contract keeps them apart on purpose, and so does this module. `entered` is how many times
// the feature's own Place ran. `blocksWritten` is what it placed while it was the innermost
// feature executing -- so a leaf's writes are the leaf's, not its outermost ancestor's.
// `delegations` is how many times this feature, as a composite, handed off to a sub-feature, and
// it counts hand-offs whose target ultimately wrote nothing. A wrapper that delegates 900 000
// times without writing a block is a completely different problem from a leaf that writes 900 000
// blocks, and a single "cost" number would hide exactly that.
//
// # The empty cases are the point of this file
//
// Two states look like failures and are not, and both get phrased here rather than left to each
// call site to improvise:
//
//   - A node that RAN and wrote nothing. That is the normal, healthy state of a filter or an
//     aggregate: they decide and delegate, they do not place. Reporting a zero as a problem
//     teaches a person to ignore the report.
//   - A node that never ran. This may simply not run AT THIS ORIGIN. A condition gated on chunk
//     position is false at the default preview origin of 0,0,0 and true one chunk over -- the
//     exact case wire/graph.go's `@featurelab:ignore` annotation exists to suppress. Everything
//     surfaced here is therefore scoped to THIS RUN, AT THIS ORIGIN, in the words as well as in
//     the data.
//
// And a third that is not about the pack at all: a feature RULE is measured only when the run
// places that rule (session.Generate pushes a frame around it). Previewing a feature places no
// rule, so a rule node absent from the profile means "this run did not place it", and saying "did
// not run at this origin" about one would be a plain falsehood.
//
// # Stops
//
// A row may carry `stops`: gates that ended the feature's work early -- an iterations expression
// that rounded to 0, a conditional_list entry whose condition was 0, a biome filter that rejected.
// A node that entered, wrote nothing, handed nothing off and hit one is `stopped`, which answers
// "why is this empty" where `entered-without-writing` only says that it is.
//
// Nothing in this module is allowed to call any of those states dead, unused, or unreachable.
// Those words describe the pack; these numbers only ever describe one run of it.

import { AttributionIndex, type BlockPosition, type FeatureStatsWire, type ProfileWire, type StopStatWire } from './attribution.js'

/** The synthetic type id wire/graph.go gives a feature rule node -- singular, and deliberately not
 * the `minecraft:feature_rules` key its file is rooted at, because it names one rule rather than
 * the file's collection of them. */
export const RULE_TYPE_ID = 'minecraft:feature_rule'

/** The type id the profiler's rule frame carries (session.Generate). Mapped to RULE_TYPE_ID so a
 * rule reads the same whether or not this run placed it. */
const PROFILED_RULE_TYPE_ID = 'minecraft:feature_rules'

/** What a node did in one run. Five states, none of them a verdict on the pack.
 *
 *   `wrote`                    -- entered and placed at least one block.
 *   `stopped`                  -- entered, placed nothing, delegated nothing, and hit a gate
 *                                 (see NodeRunStats.stops). The gate is the answer.
 *   `entered-without-writing`  -- entered and placed none. Normal for a filter or an aggregate.
 *   `not-entered`              -- no row in this run's profile. May run at another origin.
 *   `not-measured`             -- a feature rule with no row: this run did not place it. */
export type NodeActivity = 'wrote' | 'stopped' | 'entered-without-writing' | 'not-entered' | 'not-measured'

export interface NodeRunStats {
  readonly nodeId: string
  /** The feature type, from the profile when the node ran and from the caller's own graph
   * otherwise. Empty when neither knows it. */
  readonly typeId: string
  readonly activity: NodeActivity
  readonly entered: number
  readonly blocksWritten: number
  readonly delegations: number
  readonly selfMs: number
  readonly inclusiveMs: number
  /** Distinct cells this node wrote, when an AttributionIndex was supplied; null otherwise.
   * Always <= blocksWritten -- a feature that writes one cell twice spends two writes on one
   * block of highlight. */
  readonly distinctCells: number | null
  /** This node's share of everything the run wrote, 0..1. Exactly 0 on a run that wrote nothing:
   * the denominator is checked, never assumed non-zero. */
  readonly writeShare: number
  /** This node's share of the run's configured write budget (GenerateParams.writeBudget,
   * 4 000 000 by default), 0..1, or null when no budget was supplied. Distinct from writeShare:
   * a node can be 100% of a run that wrote four blocks and still be nothing against the budget. */
  readonly budgetShare: number | null
  /** Gates this node stopped at, in the order the run first hit them. Empty when none -- and on
   * any node that did not enter. */
  readonly stops: readonly StopStatWire[]
}

/** Run-wide denominators, computed once so a whole graph's worth of rows share them. */
export interface RunTotals {
  /** Total blocks written across every feature THIS run. The denominator for writeShare.
   *
   * Not the same number as GenerateOutput.blocksChanged: that counts cells whose final block
   * differs from the baseline, while this counts write operations -- including a write that a
   * later one overwrote, and a write that put back what was already there. Two honest counts of
   * two different things; this is the one a per-feature share is a share OF. */
  readonly blocksWritten: number
  readonly entered: number
  readonly delegations: number
  /** Features with a row in this run's profile -- i.e. entered at least once. */
  readonly features: number
  readonly writeBudget: number | null
  /** GenerateOutput.partial: a write/delegation/wall-clock budget cut the run off early, so every
   * count below is a floor rather than a total. */
  readonly partial: boolean
}

export interface NodeStatsOptions {
  /** Supplies distinctCells, and nothing else. Optional: the counters alone need no index. */
  readonly index?: AttributionIndex | null | undefined
  /** GenerateParams.writeBudget for this run, if the caller knows it. */
  readonly writeBudget?: number | null | undefined
  /** GenerateOutput.partial. */
  readonly partial?: boolean | undefined
  /** The origin this run placed at (GenerateOutput.origin), so "not entered" can name it instead
   * of gesturing at "this origin". */
  readonly origin?: BlockPosition | null | undefined
  /** Type id for a node the profile does not carry a row for -- from the caller's own wire.Graph.
   * This is what lets a rule be reported as unmeasured rather than as not having run. */
  readonly typeIdOf?: ((nodeId: string) => string | undefined) | undefined
}

/** Share at or above which a node is worth pointing at without being asked. Half the run's writes
 * in one node is not a fault -- a tree feature legitimately dominates a tree preview -- but it is
 * the first thing a person wants to know, so it gets a threshold rather than a rule. */
export const DOMINANT_WRITE_SHARE = 0.5

/** Totals over every feature the profile carries a row for. Safe on a null/absent profile. */
export function summarizeRun(profile: ProfileWire | null | undefined, options: NodeStatsOptions = {}): RunTotals {
  const features = profile?.features ?? []
  let blocksWritten = 0
  let entered = 0
  let delegations = 0
  for (const row of features) {
    blocksWritten += count(row.blocksWritten)
    entered += count(row.entered)
    delegations += count(row.delegations)
  }
  return {
    blocksWritten,
    entered,
    delegations,
    features: features.length,
    writeBudget: options.writeBudget ?? null,
    partial: options.partial ?? false,
  }
}

/** One node's row. Works for a node the profile has never heard of -- that is the whole reason it
 * takes a node id rather than a stats row. */
export function nodeRunStats(
  profile: ProfileWire | null | undefined,
  nodeId: string,
  options: NodeStatsOptions = {},
  totals: RunTotals = summarizeRun(profile, options),
): NodeRunStats {
  const row = findRow(profile, nodeId)
  const index = options.index ?? null
  const budget = totals.writeBudget

  if (!row) {
    const typeId = options.typeIdOf?.(nodeId) ?? ''
    return {
      nodeId,
      typeId,
      activity: typeId === RULE_TYPE_ID ? 'not-measured' : 'not-entered',
      entered: 0,
      blocksWritten: 0,
      delegations: 0,
      selfMs: 0,
      inclusiveMs: 0,
      distinctCells: index ? 0 : null,
      writeShare: 0,
      budgetShare: budget && budget > 0 ? 0 : null,
      stops: NO_STOPS,
    }
  }

  const blocksWritten = count(row.blocksWritten)
  const delegations = count(row.delegations)
  const stops = validStops(row.stops)
  const typeId = row.typeId === PROFILED_RULE_TYPE_ID ? RULE_TYPE_ID : row.typeId
  return {
    nodeId,
    typeId: typeId ?? options.typeIdOf?.(nodeId) ?? '',
    activity: blocksWritten > 0 ? 'wrote' : delegations === 0 && stops.length > 0 ? 'stopped' : 'entered-without-writing',
    entered: count(row.entered),
    blocksWritten,
    delegations,
    selfMs: finite(row.selfMs),
    inclusiveMs: finite(row.inclusiveMs),
    distinctCells: index ? index.distinctCellsWrittenBy(nodeId) : null,
    // The guard is the point of the expression, not a formality: a run in which every feature
    // was filtered out before writing anything has a zero denominator, and that is an ordinary
    // preview at an origin where nothing applies -- not a case worth producing NaN over.
    writeShare: totals.blocksWritten > 0 ? blocksWritten / totals.blocksWritten : 0,
    budgetShare: budget && budget > 0 ? blocksWritten / budget : null,
    stops,
  }
}

const NO_STOPS: readonly StopStatWire[] = Object.freeze([])

/** Plain-words names for the engine's stop reasons. An unknown code falls back to itself, so a
 * newer engine's reason still reads as something. */
const STOP_REASONS: Readonly<Record<string, string>> = {
  chance_zero: 'Chance is 0',
  chance_failed: 'Chance roll failed',
  iterations_zero: 'No iterations',
  condition_false: 'Condition false',
  biome_filter_rejected: 'Biome filter rejected',
  height_difference_rejected: 'Height difference out of range',
  surface_threshold_rejected: 'Too close to the surface',
  search_exhausted: 'Search ran out of positions',
  no_surface: 'No surface to snap to',
  no_selection: 'Nothing to pick',
  sequence_first_failure: 'Stopped at first failure',
  // "Unresolved", because that is what the canvas calls this state everywhere else: the
  // badge, the card, the legend row and the `is:unresolved` filter. A stop reason reading
  // "Reference not found" was a sixth name for it, on a panel a click away from the other five.
  unresolved_reference: 'Unresolved reference',
  recursion_guard: 'Recursion guard',
}

export interface StopDescription {
  /** Short, for a badge: `no iterations — iterations = 0 ×412`. The plain reason leads and the
   * engine's own wording follows it, so the badge says something a reader can act on before they
   * have to parse an expression. The preview panel phrases the same stop the same way. */
  readonly label: string
  /** Longer, for a tooltip: `No iterations: iterations = 0 (from 0.3). 412 times in this run.` */
  readonly title: string
}

/** How to say one stop. The count is only shown when the stop was hit more than once. */
export function describeStop(stop: StopStatWire): StopDescription {
  const n = count(stop.count)
  const reason = STOP_REASONS[stop.reason] ?? stop.reason
  const entry = typeof stop.ordinal === 'number' ? ` (entry ${stop.ordinal})` : ''
  // A lost roll is luck, and the one stop where trying another seed is the right next step.
  const luck = stop.reason === 'chance_failed' ? ' Another seed may pass.' : ''
  return {
    label: `${reason.charAt(0).toLowerCase()}${reason.slice(1)} — ${stop.detail}${n > 1 ? ` ×${formatCount(n)}` : ''}`,
    title: `${reason}${entry}: ${stop.detail}. ${formatCount(n)} ${plural(n, 'time')} in this run.${luck}`,
  }
}

/** A row for every node the profile carries, keyed by node id. Callers that also want rows for
 * graph nodes the profile has NOT heard of should walk their own node list through nodeRunStats --
 * this module has no graph and cannot invent those ids. */
export function buildNodeStats(profile: ProfileWire | null | undefined, options: NodeStatsOptions = {}): Map<string, NodeRunStats> {
  const totals = summarizeRun(profile, options)
  const out = new Map<string, NodeRunStats>()
  for (const row of profile?.features ?? []) {
    // First row wins, matching how the engine keys its own stats map by identifier: a duplicate
    // would be a broken response, and overwriting would silently discard the real one.
    if (!out.has(row.identifier)) out.set(row.identifier, nodeRunStats(profile, row.identifier, options, totals))
  }
  return out
}

/** Heaviest writers first, with ties broken by node id so the ranking is stable across reloads.
 * Nodes that wrote nothing are excluded -- a ranking of zeroes ranks nothing. */
export function rankByWrites(stats: Iterable<NodeRunStats>, limit = Infinity): NodeRunStats[] {
  const rows = [...stats].filter((s) => s.blocksWritten > 0)
  rows.sort((a, b) => b.blocksWritten - a.blocksWritten || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  return Number.isFinite(limit) ? rows.slice(0, Math.max(0, Math.trunc(limit))) : rows
}

/** Heaviest delegators first, same tie-break. Kept separate from rankByWrites because the two
 * answer different questions -- see this module's header. */
export function rankByDelegations(stats: Iterable<NodeRunStats>, limit = Infinity): NodeRunStats[] {
  const rows = [...stats].filter((s) => s.delegations > 0)
  rows.sort((a, b) => b.delegations - a.delegations || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  return Number.isFinite(limit) ? rows.slice(0, Math.max(0, Math.trunc(limit))) : rows
}

/** Whether this node is worth pointing at unprompted. Never true on a run that wrote nothing --
 * "100% of zero" is arithmetic, not a finding. */
export function isDominantWriter(stats: NodeRunStats, totals: RunTotals): boolean {
  return totals.blocksWritten > 0 && stats.writeShare >= DOMINANT_WRITE_SHARE
}

/** One line for a node box or a tooltip. Always true of THIS run at THIS origin, and never calls
 * a zero a fault. */
export function describeNodeRun(stats: NodeRunStats, totals: RunTotals, options: NodeStatsOptions = {}): string {
  switch (stats.activity) {
    case 'wrote':
      // "writes", never "blocks" -- see RunTotals.blocksWritten. This counter and the preview's
      // PLACED tile were both saying "blocks" about one run while counting two different things
      // (110 writes against 79 cells), so the inspector and the panel next to it contradicted
      // each other in plain words. The number is unchanged; only the noun was ever wrong.
      return `Performed ${formatCount(stats.blocksWritten)} ${plural(stats.blocksWritten, 'write')} in this run (${formatShare(stats.writeShare)} of the run's ${formatCount(totals.blocksWritten)}), entered ${formatCount(stats.entered)} ${plural(stats.entered, 'time')}.`
    case 'stopped': {
      const first = stats.stops[0] as StopStatWire
      const more = stats.stops.length - 1
      return `Entered ${formatCount(stats.entered)} ${plural(stats.entered, 'time')} in this run and stopped before placing: ${first.detail}${more > 0 ? ` (+${more} more)` : ''}.`
    }
    case 'entered-without-writing':
      return `Entered ${formatCount(stats.entered)} ${plural(stats.entered, 'time')} in this run and wrote no blocks${stats.delegations > 0 ? `, delegating ${formatCount(stats.delegations)} ${plural(stats.delegations, 'time')}` : ''}. Expected of a filter or an aggregate, which decide and delegate rather than place.`
    case 'not-measured':
      return `Feature rules are not measured by the profiler unless the run places that rule; this run did not.`
    case 'not-entered':
      return `Not entered in this run, ${atOrigin(options.origin)}. Whether it runs elsewhere is a question this run cannot answer.`
  }
}

/** The longer form: one line per thing worth saying, in the order a person reads them. Returns an
 * empty array only when there is genuinely nothing to add beyond describeNodeRun. */
export function explainNodeRun(stats: NodeRunStats, totals: RunTotals, options: NodeStatsOptions = {}): string[] {
  const lines: string[] = [describeNodeRun(stats, totals, options)]

  if (stats.activity === 'not-entered') {
    // The single most common false alarm this whole module exists to avoid raising. A condition
    // gated on chunk position is false at 0,0,0 and true one chunk over, and an editor that
    // called that a dead branch on every open would train people to stop reading it.
    lines.push(
      `A condition gated on chunk position can be false at this origin and true at another, so this is a fact about the run and not about the node. Try another origin before drawing a conclusion.`,
    )
  }

  if (stats.activity === 'wrote') {
    if (stats.distinctCells !== null && stats.distinctCells < stats.blocksWritten) {
      lines.push(
        `${formatCount(stats.blocksWritten)} writes landed on ${formatCount(stats.distinctCells)} distinct ${plural(stats.distinctCells, 'cell')} -- some cells were written more than once, by this node alone.`,
      )
    }
    if (isDominantWriter(stats, totals)) {
      lines.push(`This one node accounts for ${formatShare(stats.writeShare)} of everything the run wrote.`)
    }
    if (stats.budgetShare !== null && totals.writeBudget) {
      lines.push(`That is ${formatShare(stats.budgetShare)} of the run's write budget of ${formatCount(totals.writeBudget)}.`)
    }
  }

  if (stats.delegations > 0 && stats.activity === 'wrote') {
    lines.push(`It also delegated ${formatCount(stats.delegations)} ${plural(stats.delegations, 'time')}, including hand-offs whose target wrote nothing.`)
  }

  // Every gate, including on a node that wrote or delegated: a list whose second entry is always
  // false still places through its first, and that second entry is exactly what someone is
  // looking for when the output is thinner than expected.
  for (const stop of stats.stops) lines.push(describeStop(stop).title)

  if (totals.partial) {
    // Without this the numbers read as totals when they are floors, and a person tuning against
    // them would be tuning against a truncated run.
    lines.push(`A budget cut this run off early, so every count here is a lower bound, not a total.`)
  }

  return lines
}

/** A share as a percentage, rounded to keep a node box readable but never to 0% or 100% for a
 * value that is neither -- a node responsible for a handful of a million writes should read as
 * "<1%", not as nothing at all. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  if (share >= 1) return '100%'
  const percent = share * 100
  if (percent < 1) return '<1%'
  if (percent > 99) return '>99%'
  return `${percent < 10 ? percent.toFixed(1).replace(/\.0$/, '') : Math.round(percent)}%`
}

/** Thousands-separated, with an explicit separator rather than toLocaleString: this string ends up
 * in test expectations and in a webview whose locale is the user's, and a count that reads
 * "1.234" on one machine and "1,234" on another is a bug waiting for a bug report. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const negative = value < 0
  const digits = Math.abs(Math.trunc(value)).toString()
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return negative ? `-${out}` : out
}

function atOrigin(origin: BlockPosition | null | undefined): string {
  return origin ? `at origin ${origin.x},${origin.y},${origin.z}` : 'at this origin'
}

function plural(value: number, word: string): string {
  return value === 1 ? word : `${word}s`
}

function findRow(profile: ProfileWire | null | undefined, nodeId: string): FeatureStatsWire | undefined {
  // A linear scan rather than a map: the profile carries one row per feature ENTERED, which is
  // tens to low hundreds even on a large pack, and building a map per lookup would cost more than
  // it saves. buildNodeStats, which does want every row, walks the array once itself.
  for (const row of profile?.features ?? []) {
    if (row.identifier === nodeId) return row
  }
  return undefined
}

/** The row's stops, minus anything too malformed to phrase. Engine order is kept. */
function validStops(stops: readonly StopStatWire[] | undefined): readonly StopStatWire[] {
  if (!Array.isArray(stops) || stops.length === 0) return NO_STOPS
  const out = stops.filter((s) => s && typeof s.reason === 'string' && typeof s.detail === 'string')
  return out.length === stops.length ? stops : out
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
