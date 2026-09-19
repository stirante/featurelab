// panel.ts -- the sidebar controls, shared between the VS Code webview (apps/vscode/webview/
// main.ts) and the Wails desktop app's webview (apps/desktop/frontend/src/main.ts -- see that
// file's own doc comment; today it still drives a separate, desktop-only toolbar.ts instead of
// this section, which is tracked follow-up work, see this file's "Known gaps" section below).
// Do not fork this file per host -- both app shells must see the same controls, laid out the
// same way, themed the same way (see panel.css's own doc comment for the theming contract).
//
// Two kinds of state live here:
//   - GENERATION CONFIG (Feature/Rule, Environment, Materials, Biome sections): what the NEXT
//     `generate` request should ask for. Changing one of these fires `opts.onConfigChange` with
//     a freshly built GenerateParamsWire (see protocol.ts) -- the HOST is responsible for
//     actually driving a new request with it and feeding the result back via setResult()/
//     setError(). onConfigChange is optional: a host that doesn't pass it still gets the full
//     control UI (useful for visual/layout work in isolation), the controls just never fire a
//     request.
//   - VIEW STATE (View, Diagnostics, Profiler sections): how to look at whatever the LAST
//     result already contains. Never triggers a new request -- see viewer.ts's own doc comment
//     for why setResult() never touches camera position, which is what keeps "regenerate on
//     save without losing camera position or view settings" true.
//
// # No prose in the panel
//
// A row is one line: label, control, nothing under it. Its one-sentence explanation is the
// row's native `title` tooltip (dom.ts's row()), and the long form -- every standing fact about
// how the tool works -- is behind the one `?` on each section head (docs.ts renders it,
// panelDocs.ts holds the text). What the panel still SAYS in its own body is only what is about
// this run: a status line, a refusal, a diagnostic. An inert control shows that it is inert
// (dimmed, its reason as its tooltip) instead of explaining itself in a paragraph beneath. This
// is the node inspector's contract (apps/vscode/src/graph/inspector.ts), applied here.
//
// Only ONE of those two halves survives a panel being created (best-effort localStorage -- see
// save()/loadPersisted()):
//   - VIEW STATE persists. How you like to LOOK at a result -- the Y cut, sticky grow, the
//     environment/carved/heatmap/overflow/grid toggles, which sections you keep collapsed --
//     depends on neither the loaded pack nor the feature under test, so carrying it into the
//     next panel is always right and never surprising.
//   - GENERATION CONFIG resets to defaultConfig() every time, with one deliberate exception
//     (the SUBJECT: mode/featureIdentifier/ruleIdentifier -- see PersistedState below for why
//     that one is not treated as "config"). It describes a RUN, and a run's inputs belong to
//     the pack and the feature it was made for: remembering them bled settings between
//     sessions in exactly the ways that got reported -- a biome from another pack still
//     selected, a preset shown but not applied, material overrides outliving the biome reset
//     that should have cleared them, and, worst of the set, a write/delegation/time budget
//     raised for one heavy run still raised weeks later (see GenerationConfig's own doc comment
//     on those three: a permanently-raised budget turns an accidental infinite recursion from
//     "fails fast" into "grinds for a minute", which is precisely what raising one for a single
//     supervised run is meant to avoid).
//
// # Known gaps
//
//   - The Environment Preset dropdown and the Biome section's "Pack biome" dropdown are both now
//     populated from live engine data -- the `environments` serve method (cmd/featurelab/
//     environments.go) and GenerateOutput's own biomeEntries field (wire/wire.go) respectively --
//     rather than a hand-transcribed mirror. `environments` is fetched once per host session (see
//     setEnvironments/PanelHandle) and does not depend on a pack being loaded; biomeEntries
//     arrives on every `generate` response, same as entries/ruleEntries already did.
//   - features.Entry has no `built` flag on the wire (json:"-" on the one field that would
//     reveal it) -- unlike the Rule and Pack-biome pickers, which CAN grey out an entry that
//     failed to build (rules.FeatureRuleEntry.Rule / biomes.Entry.Biome are nil, and ARE on the
//     wire), the Feature picker cannot. See protocol.ts's FeatureEntryWire doc comment.
//   - Picking a "Pack biome" DOES change terrain materials: biomeId selects a pack biome and
//     layers its own minecraft:surface_builder over the active preset's native materials
//     (session.go's biome-materials wiring) -- an explicit Materials-section
//     override still wins per-slot over either. See
//     this section's own header comment below for the full precedence.
//   - The Materials section's three sea slots are gated on the selected preset's own
//     buildsSea flag (EnvironmentOptionWire.buildsSea, from env.EnvironmentPreset.BuildsSea):
//     disabled, explained, and held back from the request under a preset that models no sea --
//     the same rule the --sea-* CLI flags' "ocean only" help text and env.InertSeaSlotOverrides'
//     warning already state, said before the run instead of after it. The VALUE survives the
//     switch (it just stops being sent) -- see sendableMaterials for the three options and why
//     that is the one chosen. Note this changes nothing about the persistence split above: a
//     material override is generation config, still per-run, still never persisted.
import type { EnvironmentMode, PickedCell, VoxelViewer } from '../viewer.js'
import type {
  BiomeEntryWire,
  BlockCounts,
  BoundsWire,
  DecodedDiagnostic,
  DecodedResult,
  EnvironmentMaterialsWire,
  EnvironmentOptionWire,
  FeatureEntryWire,
  FeatureProfileStatsWire,
  GenerateParamsWire,
  MaterialSlotsWire,
  MaterialsWire,
  ResolvedBiomeWire,
  ResultStopWire,
  RuleEntryWire,
} from '../protocol.js'
import { ENGINE_DEFAULT_DELEGATION_BUDGET, ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS, ENGINE_DEFAULT_WRITE_BUDGET } from '../protocol.js'
import { checkboxInput, clamp, guardInertActivation, h, iconButton, isInert, labelFor, makeSection, numberInput, optionalNumberInput, readFloat, readInt, readOptionalInt, row, setInert, setInertReason, textInput } from './dom.js'
import { createDocsPanel } from './docs.js'
import { inertSeaSlotTitle, panelDocs } from './panelDocs.js'

/** Per-workspace storage key.
 *
 * A VS Code webview's localStorage is scoped per EXTENSION -- not per panel, per window, or
 * per workspace. One global key therefore meant two windows open on two different packs shared
 * a single blob of state: a biome picked in one silently became the selection in the other,
 * where it does not exist, producing "biome id X is not defined by any loaded biome file" for
 * an id the user never chose there. That particular symptom can no longer happen (biomeId is
 * no longer persisted at all -- see PersistedState below), but the reasoning outlives the
 * example: the SUBJECT still persists, and a feature identifier is every bit as pack-specific
 * as a biome id was, so an unsuffixed key would still hand window B a selection that only
 * exists in window A's pack. The host stamps its workspace id onto <body> (see
 * previewPanel.ts's workspaceIdFrom) BEFORE this module runs, because this key is read during
 * construction and no message could arrive in time. Hosts without a workspace concept (the
 * Wails desktop app) and windows with no folder open both land on the unsuffixed key, which is
 * correct for them: there is one workspace and it is "none". */
const STORAGE_KEY = (() => {
  const base = 'featurelab.panel.v1'
  try {
    const id = document.body?.dataset?.flWorkspace
    return id ? `${base}.${id}` : base
  } catch {
    return base
  }
})()

/** The one sentence that says why "Show heatmap" is inert, used by the View row and the REPLACED
 * chip alike -- an inert control must show that it is inert AND say why, in the same words
 * wherever it appears. */
/** How long a slice drag has to pause before the view blob is written. Long enough that a drag
 * across the whole range is one write rather than two hundred, short enough that letting go and
 * immediately closing the panel still persists what you chose. */
const SLICE_SAVE_DEBOUNCE_MS = 250

/** What an uncommitted field says when you hover it. These inputs commit on blur or Enter, so
 * until then the panel is showing one number and the preview is the result of another -- with
 * nothing to say which. */
const UNCOMMITTED_TITLE = 'Not run yet — press Enter (or Ctrl+Enter) to use this value.'

const HEATMAP_NEEDS_PROFILING = 'Needs profiling: turn on "Enable profiling" in the Profiler section and run again.'

/** Which sections a panel that has never been opened before starts COLLAPSED.
 *
 * Eight sections, all expanded, is roughly two thousand pixels of controls above a Diagnostics
 * list -- and seven of the eight are irrelevant to a first preview. The split is by how often a
 * control is actually touched, not by how interesting it is:
 *
 *   - OPEN: Feature/Rule (which feature, which seed, run it again), Environment (the preset and
 *     the bench it implies), View (the Y cut and the lenses), Diagnostics (the answer when
 *     something went wrong). These are the four a person moves between on every single run.
 *   - COLLAPSED: Materials and Biome (a deliberate excursion, and both show the preset's own
 *     values until you make one), Budget (three per-run escape hatches that start blank on
 *     purpose -- see that section's own comment) and Profiler (off by default, so its body is
 *     one sentence saying so).
 *
 * This is a DEFAULT, not a policy: the collapsed set is persisted per workspace from the first
 * time anything is toggled, so opening the Materials section once means it is open next time,
 * and closing Environment keeps it closed. A blob written before this constant existed is
 * honoured exactly as it was saved -- someone who already has all eight open keeps all eight
 * open, because that is what they last chose. */
const DEFAULT_COLLAPSED_SECTIONS: readonly string[] = ['materials', 'biome', 'budget', 'profiler']

const SIZE_XZ_MIN = 4
const SIZE_XZ_MAX = 512
const SIZE_Y_MIN = 4
const SIZE_Y_MAX = 512
const REPEAT_MIN = 1
const REPEAT_MAX = 16

/** Shown for a preset's own native materials only in the brief window before the `environments`
 * list has arrived (see the `environments` array/getEnvironment in createPanel) -- every field
 * blank rather than a guessed block name, so this state is visually distinguishable from a real
 * (if unusual) preset. Never sent: buildGenerateParams only ever sends config.materialOverride's
 * own keys, which this constant never populates. */
const FALLBACK_ENV_MATERIALS: EnvironmentMaterialsWire = {
  topMaterial: '',
  midMaterial: '',
  foundationMaterial: '',
  seaFloorMaterial: '',
  seaMaterial: '',
  seaFloorDepth: 0,
}

/** The three Materials slots that only mean anything under a preset whose terrain builder models
 * a sea -- env.SlotSeaFloorMaterial/SlotSeaMaterial/SlotSeaFloorDepth, in the order the Materials
 * section lays them out. Each entry pairs the wire field with the row label the user actually
 * reads, so ONE list drives both the request filter (sendableMaterials) and the rows that get
 * greyed out (syncSeaSlotAvailability). */
const SEA_MATERIAL_SLOTS: readonly { field: keyof MaterialsWire; label: string }[] = [
  { field: 'seaFloorMaterial', label: 'Sea floor material' },
  { field: 'seaMaterial', label: 'Sea material' },
  { field: 'seaFloorDepth', label: 'Sea floor depth' },
]

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Splits a comma-separated tag string into a trimmed, non-empty-only string[] -- the wire's
 * biomeTags shape (see GenerateParamsWire), while the control itself stays a single text field
 * (comma-separated). */
function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Which of the Budget section's three per-run overrides a diagnostic's message names --
 * matches GenerationConfig's own writeBudget/delegationBudget/placementTimeLimitMs split (and
 * this file's own budgetRowsByKind table, createPanel). */
export type BudgetKind = 'write' | 'delegation' | 'time'

/** One budget-exceeded diagnostic, decoded from its own message text -- `effective` is the
 * budget value THIS run actually hit (the engine's own default, or a request override, either
 * way baked into the message -- see below), not necessarily whatever GenerationConfig currently
 * holds (which could be null/"no opinion"). `label`/`unit` are for the quick-fix button's own
 * text, which makes it obvious which budget it will change and to what value. */
export interface BudgetDiagnostic {
  kind: BudgetKind
  effective: number
  label: string
  unit: string
}

// Matches session/session.go's own three panic->diagnostic messages EXACTLY (Error() methods on
// volume.WriteBudgetExceeded / features.DelegationBudgetExceeded / features.
// PlacementDeadlineExceeded, session.go's own addPlacementFailure call sites) -- see this
// module's own "budget quick-fix" doc comment on applyBudgetQuickFix (createPanel) for why the
// captured number is the run's own EFFECTIVE budget (the value actually hit), not a value this
// module has to separately look up. Each pattern only needs to match a PREFIX of the full
// message (session.go appends "; N repeat placement(s) completed..." after every one of these)
// -- deliberately not anchored with `$` for that reason.
const WRITE_BUDGET_RE = /write budget hit at \d+ of (\d+) block writes/
const DELEGATION_BUDGET_RE = /delegation budget hit at \d+ of (\d+) nested feature placements/
// The engine says "placement WALL-CLOCK time limit of Nms hit" -- this pattern was written
// without the "wall-clock" and therefore never matched, so the quick-fix for this budget had
// never once fired. It went unnoticed because the only test of it fed the regex a synthetic
// message rather than one the engine produces, which is the specific way a test can pass while
// covering nothing. `.*?` rather than the literal word so a future rewording of the qualifier
// does not silently break it again.
const TIME_LIMIT_RE = /placement .*?time limit of (\d+)ms hit/

/** Recognizes one of the three budget-exceeded diagnostic messages session.go produces (see the
 * regexes above) and extracts which budget it was and the exact count/limit this run hit --
 * null for every other diagnostic (a plain feature-placement warning/error has no budget to
 * raise). Pure and DOM-free so it's unit-testable on its own, same reasoning cameraFit.ts's own
 * split from viewer.ts documents. */
export function parseBudgetDiagnostic(message: string): BudgetDiagnostic | null {
  let m = WRITE_BUDGET_RE.exec(message)
  if (m) return { kind: 'write', effective: Number(m[1]), label: 'write budget', unit: '' }
  m = DELEGATION_BUDGET_RE.exec(message)
  if (m) return { kind: 'delegation', effective: Number(m[1]), label: 'delegation budget', unit: '' }
  m = TIME_LIMIT_RE.exec(message)
  if (m) return { kind: 'time', effective: Number(m[1]), label: 'time limit', unit: 'ms' }
  return null
}

// --- generation-config state --------------------------------------------------------------

// Exported so a host (e.g. apps/vscode's webview/main.ts) can type-check the `kind` it passes to
// PanelHandle.seedOpenedDocument against the exact same union this file's own mode radio/config
// use -- see that method's own doc comment.
/** How long the panel waits after the last keystroke before it asks the engine for a new run.
 *
 * Every generation control used to dispatch on its own `change`, so nudging a number spinner four
 * times was four placements, three of which nobody wanted and all of which the engine had to
 * finish. 350 ms is the interval the desktop build already settled on: long enough that a typed
 * value is finished, short enough that it never feels like waiting. Committing explicitly (Enter,
 * blur, Ctrl+Enter, any discrete control) bypasses it entirely -- a debounce is for keystrokes,
 * not for decisions. */
export const REGENERATE_DEBOUNCE_MS = 350

/** Plain-words names for the engine's stop reasons, mirroring apps/vscode/src/graph/nodeStats.ts's
 * own table -- the node editor and the preview must not describe one run's stop two ways. An
 * unknown code falls back to itself, so a newer engine's reason still reads as something rather
 * than vanishing. */
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
  unresolved_reference: 'Reference not found',
  recursion_guard: 'Recursion guard',
}

export interface StopDescription {
  /** Short, for the empty-result line: `no iterations — iterations = 0 ×412`. */
  readonly label: string
  /** Longer, for that line's tooltip: `No iterations: iterations = 0. 412 times in this run.` */
  readonly title: string
}

/** STOP_REASONS' entry as it reads MID-SENTENCE, after "Placed nothing · ".
 *
 * That table is sentence-cased because the node editor shows its values standing alone; here
 * they continue a line, so only the first letter changes. No entry starts with a proper noun or
 * an acronym, and an unknown code (which falls back to the raw `reason`, already lower snake
 * case) is unharmed by it. */
function midSentence(reason: string): string {
  return reason.charAt(0).toLowerCase() + reason.slice(1)
}

/** How to say one stop. The count is only shown when the stop was hit more than once -- `×1` is
 * noise, and a reader who sees a count at all should be able to trust it means "more than once".
 *
 * THE PLAIN REASON LEADS. The label used to be `stopped: <detail>` with the plain-English reason
 * reachable only as a native tooltip, so the one visible sentence about a run that placed
 * nothing was raw engine text -- an evaluated expression, out of context, in a line that had
 * room for the words. The detail keeps its place immediately after: it is the specific number
 * that turns "no surface to snap to" into something to go and change. */
export function describeStop(stop: ResultStopWire): StopDescription {
  const n = Number.isFinite(stop.count) ? Math.trunc(stop.count) : 0
  const reason = STOP_REASONS[stop.reason] ?? stop.reason
  const entry = typeof stop.ordinal === 'number' ? ` (entry ${String(stop.ordinal)})` : ''
  // A lost roll is luck, and the one stop where trying another seed is the right next step.
  const luck = stop.reason === 'chance_failed' ? ' Another seed may pass.' : ''
  const who = stop.identifier ? `${stop.identifier} — ` : ''
  return {
    label: `${midSentence(reason)} — ${stop.detail}${n > 1 ? ` ×${n.toLocaleString('en-US')}` : ''}`,
    title: `${who}${reason}${entry}: ${stop.detail}. ${n.toLocaleString('en-US')} time${n === 1 ? '' : 's'} in this run.${luck}`,
  }
}

/** Whether a diagnostic is about the RUN that just happened rather than the pack as a whole.
 *
 * TOLERANT BY DESIGN: `scope` is a field the engine does not send yet (see
 * DecodedDiagnostic.scope), and an absent one counts as this run's -- which is exactly how this
 * panel behaved before the field existed. Only an explicit `'pack'` is excluded, so the day the
 * engine starts separating "this file will not parse" from "this placement was refused", the
 * empty-result line stops offering the former as an explanation for the latter with no further
 * change here. */
export function isRunDiagnostic(d: DecodedDiagnostic): boolean {
  return d.scope !== 'pack'
}

/** Beyond this many characters a diagnostic gets a disclosure rather than being shown whole.
 *
 * A CHARACTER count, not a measured one: jsdom has no layout, a webview's own line length changes
 * with the sidebar width, and a clamp that depends on either would behave differently in the test
 * that guards it than in the panel it guards. ~110 characters is roughly two lines at the
 * narrowest sidebar this panel allows, so anything under it was never going to be a wall. */
const DIAGNOSTIC_CLAMP_CHARS = 110

/** Whether this message needs a disclosure. A newline counts regardless of length: a diagnostic
 * that came pre-formatted as several lines is exactly the "engine paragraph" case. */
function isLongDiagnostic(message: string): boolean {
  return message.length > DIAGNOSTIC_CLAMP_CHARS || /[\r\n]/.test(message)
}

export type Mode = 'feature' | 'rule'

interface GenerationConfig {
  mode: Mode
  featureIdentifier: string | null
  ruleIdentifier: string | null
  env: string
  sizeX: number
  sizeY: number
  sizeZ: number
  minY: number
  originX: number
  originZ: number
  /** Whether the user has ever edited Origin X/Z away from their 0/0 defaults -- gates whether
   * `origin` is sent at all (see buildGenerateParams). There is deliberately no Origin Y
   * control (see the required-controls list this port was built against) -- when origin IS
   * sent, Y is filled from `resolvedOriginY` (see that variable's own doc comment) rather than
   * a user-editable value. */
  originTouched: boolean
  /** World seed for the run, or null to let the preset pick. Exposed because a placement can
   * fail purely on luck -- a scatter_chance gate that did not roll -- and the only way to act
   * on that diagnostic is to try a different seed. Sent as wire.GenerateParams.seed, which is
   * already a pointer there precisely so 0 stays a legitimate seed rather than "unset". */
  seed: number | null
  repeatCount: number
  profiling: boolean
  /** Selects a loaded pack biome by identifier (wire.GenerateParams.BiomeID) -- "" means no
   * pack biome selected (preset default, unchanged). Set by the "Pack biome" <select>, built
   * from lastResult.biomeEntries. Independent of biomeTagsOverrideEnabled/biomeTagsText below --
   * see this section's own header comment for why the two are separate wire fields with
   * separate gating, not one combined "biome override". */
  biomeId: string
  /** Gates whether biomeTags is sent at all, but
   * ONLY for the tags-only override (wire.GenerateParams.BiomeTags), independent of biomeId
   * above. When false, "Biome tags" shows (but does not send) whichever of the active preset's
   * own default tags / the selected pack biome's own tags is currently active. */
  biomeTagsOverrideEnabled: boolean
  biomeTagsText: string
  /** Only the fields the user has actually edited are present -- mirrors
   * GenerateParamsWire.materials's own "every field independently optional" shape exactly, so
   * buildGenerateParams can hand this straight to the wire (after dropping the never-written
   * undefined keys). Cleared in one action by the "Reset to preset materials" button. */
  materialOverride: MaterialsWire
  /** Per-run overrides of the engine's placement budgets -- see this file's Budget section for
   * why these are generation config (sent with the request) rather than a permanent VS Code
   * setting: a budget is raised for ONE heavy run while the user watches, not left raised
   * forever (a permanently-raised limit just means an accidental infinite recursion grinds for
   * a minute instead of failing fast). These three are also the sharpest case for resetting
   * generation config on every panel (see PersistedState): persisting them contradicted this
   * very comment -- a budget raised for one supervised run stayed raised across sessions, and
   * "not left raised forever" only holds if something actually puts it back. null means "no
   * opinion, use the engine's own default" --
   * distinct from 0, which is itself a meaningful (if extreme) value for each of these on the
   * wire (wire.GenerateParams's own doc comment) -- see buildGenerateParams for how that
   * distinction survives onto the request. */
  writeBudget: number | null
  delegationBudget: number | null
  placementTimeLimitMs: number | null
}

function defaultConfig(): GenerationConfig {
  return {
    mode: 'feature',
    featureIdentifier: null,
    ruleIdentifier: null,
    env: 'plains',
    // Bootstrap-only: the real Environment preset list (environments, see the `environments`
    // array/setEnvironments below) arrives asynchronously from the engine, so these four have
    // to show SOMETHING before the first "environments"/generate round trip completes. They
    // match env/environment.go's own surfaceDefaults (the 'plains' preset's real defaults) as
    // of this port -- verified once, not re-verified automatically -- but nothing downstream
    // trusts them beyond that first paint: renderEnvironmentOptions() re-syncs the Preset row's
    // tooltip (and, on an actual preset change, size/minY themselves) from the live list the
    // moment it arrives.
    sizeX: 32,
    sizeY: 48,
    sizeZ: 32,
    minY: 44,
    originX: 0,
    seed: null,
    originZ: 0,
    originTouched: false,
    repeatCount: 1,
    profiling: false,
    biomeId: '',
    biomeTagsOverrideEnabled: false,
    biomeTagsText: '',
    materialOverride: {},
    writeBudget: null,
    delegationBudget: null,
    placementTimeLimitMs: null,
  }
}

interface ViewState {
  /** The user's own literal choice for the slice Min Y / Max Y sliders, in world Y coordinates
   * -- meaningless while `sliceTouched` below is false (see that field's own doc comment for
   * why, and for the ratchet bug this split fixes). NEVER written from a value already clamped
   * against a particular result's bounds -- only from the slider's own raw value at the moment
   * the user drags it, or restored verbatim from persistence. */
  sliceMinY: number
  sliceMaxY: number
  /** False until the user has actually dragged a slice slider -- the same "config vs. touched"
   * split GenerationConfig.originTouched already uses, applied here to fix a reported bug: Min
   * Y/Max Y would drift on their own, ratcheting narrower every time the bench shrank (e.g.
   * switching to a shorter preset) and never widening back out even when it grew again (most
   * dramatically after "Grow to fit & regenerate", which can take Size Y from 48 to 273). The
   * old code had no such flag -- it inferred "has the user touched this" from whether
   * view.sliceMinY/sliceMaxY were finite, but setResult unconditionally OVERWROTE them with a
   * value already clamped to that result's own bounds, so after the very first result ever
   * arrived they were always finite, indistinguishable from a real user choice from then on.
   * Every later result re-clamped THAT already-clamped number into whatever the new bounds
   * were -- clamping is lossy, so once narrowed, a value could never widen back out on its own.
   *
   * While false, every fresh result re-derives the FULL [worldMinY, worldMaxY] range from
   * scratch (see setResult) -- a slider the user has never touched should always track "no cut"
   * for whatever the current result's own bounds are, exactly like before the user has ever
   * generated anything. Once true, sliceMinY/sliceMaxY hold the user's own literal choice;
   * setResult clamps a SEPARATE display-only value from them for the slider's own value/label
   * and viewer.setSlice, but never writes that clamped value back into sliceMinY/sliceMaxY
   * themselves -- so widening the bounds again (a taller preset, editing Size Y, "Grow to fit &
   * regenerate") restores the original cut instead of leaving it pinned at whatever a narrower
   * intermediate result happened to clamp it down to. */
  sliceTouched: boolean
  /** Sticky "grow to fit" mode: while true, EVERY regenerate this panel drives (any config
   * change, "Reload files", and -- because the host is told about this, see notifyConfigChanged
   * -- even a save-triggered one that never touches this page's own JS at all) grows the bench
   * to fit whatever spilled outside it and places again at the larger size, instead of the
   * plain, ungrown request every OTHER control here sends. Fixes a reported bug: the one-shot
   * "Grow to fit & regenerate" button (see growButton below) is a single action that applies to
   * exactly one request -- the very next regenerate (a save included) silently reverts to the
   * ungrown bench, with nothing telling the user that happened. See growStickyCheckbox/
   * renderGrownBanner below for the toggle and the "stays visible while active" banner this
   * drives; see notifyConfigChanged for how a config-driven regenerate is redirected while this
   * is true, and previewPanel.ts's own lastRequestWasGrow for the save-triggered half (a plain
   * document save never reaches this page's JS, so the HOST has to remember this itself).
   * Clamped false on load whenever `opts.onGrowRegenerate` is absent (see the load logic below)
   * -- a host that cannot actually perform a grow must never have this resurrect as an active
   * mode from a previous session just because it happens to be in localStorage; see
   * growStickyCheckbox's own disabled state for the live-session half of that same rule. */
  growSticky: boolean
  environmentMode: EnvironmentMode
  showGrid: boolean
  showCarved: boolean
  showHeatmap: boolean
  showOverflow: boolean
  /** Whether to draw blocks with their textures WHENEVER an atlas is available.
   *
   * A PREFERENCE, not a claim about the current preview: the viewer can only honour it once a
   * host has delivered an atlas (VoxelViewer.setAtlas), and until then the row is inert and says
   * why. Defaults to true, which changes nothing for a host that never delivers one -- every
   * committed screenshot still renders in flat colours, because there is no atlas in those
   * runs, not because the switch was off. See the View section's texture row. */
  showTextures: boolean
}

function defaultView(): ViewState {
  return {
    // Placeholder-only while sliceTouched is false (see that field's own doc comment) -- these
    // two values are never read for anything until the user actually drags a slider. Kept as
    // the old ±Infinity sentinel purely so an accidental read before that point still means "no
    // cut" rather than some arbitrary finite number.
    sliceMinY: Number.NEGATIVE_INFINITY,
    sliceMaxY: Number.POSITIVE_INFINITY,
    growSticky: false,
    sliceTouched: false,
    environmentMode: 'solid',
    showGrid: true,
    // On by default -- without it, a terraform-style feature that works mostly by excavation
    // previews as if it did almost nothing (see viewer.ts's showCarved doc comment).
    showCarved: true,
    showHeatmap: false,
    // On by default -- see viewer.ts's showOverflow doc comment: capture-and-display is
    // automatic, unlike carved/heatmap above which are opt-in lenses on an already-shown result.
    showOverflow: true,
    // On by default -- see ViewState.showTextures. Inert until a host supplies an atlas, so this
    // is "use textures when there are any", not "textures are on".
    showTextures: true,
  }
}

/** What actually round-trips through localStorage -- deliberately NOT the whole of
 * GenerationConfig + ViewState (see this file's header comment for the policy and the reported
 * bleed-between-runs bugs behind it). Everything absent from this shape -- env, size/minY,
 * origin, seed, repeat, profiling, biome id/tags, material overrides, all three budgets -- is
 * reset to defaultConfig() every time a panel is created, on purpose: it describes ONE run
 * against ONE pack, and a stale one is worse than no opinion at all.
 *
 * `config` keeps its old name on the wire even though it now carries only the SUBJECT, because
 * that is where an already-written blob has it: renaming the field would silently drop the
 * remembered feature/rule for every existing user, and loadPersisted's own shape check requires
 * a `config` object to be there regardless. Extra keys an older build wrote alongside these
 * three are simply never read -- see createPanel, which picks the three out by name rather than
 * spreading whatever the blob happens to contain (a spread is what would quietly restore the
 * config half again).
 *
 * The subject is the one piece of generation config that persists, and it earns the exception:
 * the VS Code host re-seeds it from the opened file on every panel anyway
 * (PanelHandle.seedOpenedDocument, which always wins over whatever was restored), so forgetting
 * it there costs nothing -- while the Wails desktop app never calls that at all, so forgetting
 * it THERE would mean re-picking the feature under test on every single launch. */
interface PersistedState {
  config: {
    mode?: Mode
    featureIdentifier?: string | null
    ruleIdentifier?: string | null
  }
  view: {
    sliceMinY: number | null
    sliceMaxY: number | null
    /** Absent on a PersistedState saved before this field existed -- see the load logic in
     * createPanel for how that's handled (never trusted as "touched" without this field
     * explicitly saying so, even if sliceMinY/sliceMaxY are themselves present and finite from
     * an old save; see that code's own comment for why treating old data as untouched, rather
     * than as a real user choice, is the correct migration here). */
    sliceTouched?: boolean
    /** Absent on a PersistedState saved before this field existed -- defaults to false via
     * `?? false` in the load logic, same "an old save never resurrects a mode it didn't know
     * about" posture sliceTouched's own migration above uses. */
    growSticky?: boolean
    environmentMode?: string
    showGrid?: boolean
    showCarved?: boolean
    showHeatmap?: boolean
    showOverflow?: boolean
    /** Absent on a save from before textures had a control -- defaults to ON (see
     * defaultView()), unlike the other two migrations here, because "draw the textures when
     * there are any" is what someone who has never been asked would want, and a host with no
     * atlas is unaffected either way. */
    showTextures?: boolean
  }
  collapsed: string[]
}

/** Best-effort read of whatever is under STORAGE_KEY -- null for anything that isn't the shape
 * above, including a blob an older build wrote (those are structurally identical, just with a
 * fatter `config`: its extra keys survive this cast unread, since nothing downstream looks at
 * them). Nothing here validates FIELD types; that is createPanel's job (see the guards there),
 * and it has to be, because this returns the raw parse of a string a user can hand-edit. */
function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.config !== 'object' || obj.config === null) return null
    if (typeof obj.view !== 'object' || obj.view === null) return null
    if (!Array.isArray(obj.collapsed)) return null
    return obj as unknown as PersistedState
  } catch {
    return null
  }
}

export interface PanelOptions {
  viewer: VoxelViewer
  /** Fired whenever a generation-config control changes, with a freshly built GenerateParamsWire
   * reflecting every control's current value (see buildGenerateParams). The host drives the
   * actual `generate` call and feeds the result back via setResult()/setError() -- this module
   * never talks to an engine process itself. Optional -- see this file's header comment for what
   * omitting it means. Never fired while the current selection can't produce a valid request
   * (neither a feature nor a rule chosen yet -- BuildConfig requires exactly one). */
  onConfigChange?: (params: GenerateParamsWire) => void
  /** Fired when the user clicks "Reload files" in the Feature/Rule section. Optional for the
   * same reason as onConfigChange. */
  onReloadFiles?: () => void
  /** Fired when the user clicks "Grow to fit & regenerate" in the out-of-bounds banner (see
   * that banner's own comment below) -- the "grow to fit and regenerate" action: expand the
   * bench to contain every out-of-bounds block the last result captured, then place AGAIN at
   * the larger size. Params is the SAME GenerateParamsWire buildGenerateParams would send for
   * an ordinary regenerate (same feature/rule/env/origin/seed/...) -- the host is expected to
   * drive a DIFFERENT engine call with it (wire.RunGenerateGrown / the `generateGrown` serve
   * method), never the plain `generate` call, and feed the result back via setResult() exactly
   * like any other result (its `grown`/`preGrowBounds` fields are what make this panel render
   * it as a re-run rather than a wider view -- see setResult's own doc comment).
   *
   * Optional, and its ABSENCE is meaningful, not just "this host doesn't support it yet": the
   * button that fires this is disabled (with an explanatory title) whenever this callback is
   * not provided, exactly like onReloadFiles above -- so a host that cannot wire the
   * grow-and-regenerate action (e.g. because its own message-handling side does not implement
   * it yet) never presents a control that LOOKS live but silently does nothing on click. A host
   * gains the control automatically, with no other change needed here, the moment it starts
   * passing this callback. */
  onGrowRegenerate?: (params: GenerateParamsWire) => void
  /** Fired when the user clicks Cancel on the viewport's busy pill -- "stop the run currently in
   * flight". The panel neither knows nor cares HOW: it only knows that a host which passed this
   * claims it can, and a host which did not gets no Cancel button at all rather than one that
   * looks live and does nothing (the same rule onGrowRegenerate/onReloadFiles already follow).
   *
   * Cancelling is not an error and not a result, so this does NOT clear the busy state by itself:
   * the host's own reply (a result, an error, or a stale banner) is what ends the request, exactly
   * like every other request this panel drives. */
  onCancel?: () => void
  /** Overrides REGENERATE_DEBOUNCE_MS for this panel. 0 dispatches every typed change
   * immediately, which is what a test wants and nothing else does. */
  regenerateDebounceMs?: number
}

export interface PanelHandle {
  /** Applies a freshly decoded generate result: updates the volume, the count/diagnostics
   * readouts, the Feature/Rule pickers, and clamps the slice sliders to the new bounds --
   * WITHOUT touching camera position or any control's current value, so a save-triggered
   * regenerate never resets what the user was looking at or how they had the view/generation
   * controls configured. */
  setResult(result: DecodedResult): void
  /** Shows a visible error state (engine crashed, malformed response, ...) -- distinct from
   * an empty/successful result, so a stale preview is never mistaken for a current one. */
  setError(message: string | null): void
  /** Toggles a "stale" banner: the engine process this preview depends on is not currently
   * known-good (still starting, crashed, or a request timed out). */
  setStale(stale: boolean, reason?: string): void
  /** Toggles the "request in flight" visual state (so there is always an indication that
   * something is happening) -- a dimmed/pulsing look on the stat tiles, and the viewport's own
   * busy pill (VoxelViewer.setBusy), which is the one live indicator and the only one that can
   * actually stop the run. A host is expected to call `setBusy(true)`
   * the moment it dispatches a request (onConfigChange firing, or its own reload/grow trigger)
   * and `setBusy(false)` once that request settles either way -- but this is deliberately not
   * the ONLY path that can clear it: setResult/setError/setStale(true) all force it off
   * themselves too, so a host that forgets the failure-path setBusy(false) (or one whose
   * request never resolves at all, e.g. the engine process dies mid-request) can never leave
   * this panel stuck looking busy forever -- see applyBusy's own doc comment. */
  setBusy(busy: boolean): void
  /** Seeds the Feature OR Rule picker (per `kind`) with the identifier of the document a HOST
   * just opened -- e.g. apps/vscode's previewPanel.ts parses the just-opened file's own type key
   * (minecraft:feature_rules vs any other minecraft:*_feature) and identifier before the panel
   * exists to ask it, so the dropdown -- and the Feature/Rule MODE itself -- shows the right
   * thing from the start instead of guessing from the first result alone (a `generate` response
   * has no top-level "which feature did you mean" echo in feature mode -- only rule mode's
   * activeRule.identifier does that).
   *
   * ALWAYS switches mode and selection to match `kind`/`identifier`, overriding whatever
   * localStorage restored -- this is the fix for a reported bug: a VS Code webview's own
   * localStorage persists per EXTENSION, not per panel instance, so opening a brand new file in
   * a brand new preview panel would otherwise still show whatever feature/rule a PREVIOUS
   * preview (of a completely different file, possibly in an earlier VS Code session) last had
   * selected -- the panel confidently previewing something other than the file actually on
   * screen, with nothing indicating that had happened. Persisted selection is now only ever a
   * fallback for "this host never told me what it opened" (e.g. the Wails desktop app, which
   * has no per-file "opened document" concept and never calls this at all) -- never something an
   * explicit open has to compete with.
   *
   * Does NOT fire onConfigChange: this describes state the host is already acting on (about to
   * drive its own first request), not a new request this panel should originate. If `identifier`
   * turns out not to be in the loaded pack, this still selects it (as a synthetic option, same as
   * before) rather than silently keeping a stale selection -- updateFeatureInfo/updateRuleInfo's
   * existing "not found in loaded ... files" text, plus the engine's own "not defined by the
   * loaded pack" diagnostic once a result arrives, are what say so plainly; this method's job is
   * only to make sure the OPENED identifier is what's showing, not to paper over a mismatch by
   * leaving an old selection in place. */
  seedOpenedDocument(kind: Mode, identifier: string): void
  /** Populates the Environment section's Preset <select> from the engine's own `environments`
   * method response -- see EnvironmentOptionWire's doc comment. A host calls this once, whenever
   * it has that list available (it does not depend on a pack being loaded -- see that method's
   * own doc comment), the same way setResult() feeds the Feature/Rule pickers from a `generate`
   * response. Safe to call more than once (e.g. a host that re-fetches on reconnect); safe to
   * never call at all (the Preset dropdown just stays empty, same "no data yet" posture as the
   * Feature/Rule pickers before the first result). Never clobbers a size/minY value the user has
   * already edited away from a preset's default. */
  setEnvironments(list: EnvironmentOptionWire[]): void
  /** Surfaces the extension-side request-timeout coupling (see previewPanel.ts's regenerate()
   * doc comment for the full "why"): apps/vscode's own featurelab.requestTimeoutMs setting is a
   * SEPARATE knob from this panel's Budget section's placementTimeLimitMs, and if the engine's
   * placement budget is allowed to exceed how long the extension waits before declaring the
   * engine stale, a successful-but-slow run would be reported as a dead engine. previewPanel.ts
   * raises its own wait above the placement budget automatically when needed, and calls this
   * with the before/after so that override is visible in the Budget section rather than silent
   * -- pass null to hide the note (no override in effect). A host with no such coupling to
   * report (the Wails desktop app, which talks to the engine directly with no separate
   * client-side timeout -- see apps/desktop/frontend/src/main.ts) simply never calls this, and
   * the note stays hidden. */
  setTimeoutInfo(info: { configuredMs: number; effectiveMs: number } | null): void
  /** Returns the GenerateParamsWire the panel would send right now, or null if neither a
   * feature nor a rule is currently selected (the wire requires exactly one). Lets a host
   * re-drive the last-known config on its own trigger (e.g. a document save) without the
   * panel having to push a redundant onConfigChange first. */
  getGenerateParams(): GenerateParamsWire | null
  /** Says why block textures are not available, for a host that knows and can put it in words.
   *
   * The panel can already tell WHETHER textures are available -- it asks the viewer, which knows
   * whether an atlas was decoded -- and it says so without any help. What it cannot know is WHY
   * not, and the answers are genuinely different actions: no atlas has been built on this
   * machine yet, the atlas is there but failed to decode, the host was told not to fetch one.
   * A host that knows passes the sentence; one that does not simply never calls this and the
   * panel falls back to its own neutral wording.
   *
   * `available: true` is worth passing too, and means "I have delivered, or am about to deliver,
   * an atlas" -- it does not by itself turn anything on: the viewer still has to decode one, and
   * this panel still reports what the viewer is actually doing rather than what a host intended.
   * Pass null to go back to the neutral wording. */
  setTextureStatus(status: { available: boolean; reason?: string } | null): void
}

export function createPanel(root: HTMLElement, opts: PanelOptions): PanelHandle {
  const persisted = loadPersisted()

  // Every generation-config field starts at its default, EXCEPT the subject (see
  // PersistedState's own doc comment for both halves of that rule). The three subject fields
  // are named individually rather than spread from `persisted.config`: a spread would happily
  // restore the env/size/seed/biome/materials/budget keys an older build left in that same
  // object, which is the exact behaviour this reset exists to end.
  const config: GenerationConfig = {
    ...defaultConfig(),
    mode: persisted?.config?.mode ?? defaultConfig().mode,
    featureIdentifier: persisted?.config?.featureIdentifier ?? null,
    ruleIdentifier: persisted?.config?.ruleIdentifier ?? null,
  }
  // Defensive typo-guard on what IS restored -- a hand-edited blob (or one from an older shape)
  // should degrade to the default, never leave a non-string where an identifier is expected or
  // a mode no radio matches. An empty identifier is normalised to null because that is what
  // "nothing selected" means everywhere else here: buildGenerateParams gates on it being falsy,
  // and an empty string would otherwise be sent as a feature named "".
  if (config.mode !== 'feature' && config.mode !== 'rule') config.mode = 'feature'
  if (typeof config.featureIdentifier !== 'string' || config.featureIdentifier.length === 0) config.featureIdentifier = null
  if (typeof config.ruleIdentifier !== 'string' || config.ruleIdentifier.length === 0) config.ruleIdentifier = null

  // Only trust a persisted slice as "the user's own touched choice" when sliceTouched was
  // explicitly saved true -- see PersistedState.view.sliceTouched's own doc comment. A save from
  // before this field existed still has finite sliceMinY/sliceMaxY (the pre-fix code always
  // wrote clamped numbers, see ViewState's own doc comment), but treating those as real intent
  // would just resurrect whatever ratcheted-narrow cut this fix exists to stop happening in the
  // first place -- untouched (full range on the next result) is the correct migration.
  const restoredSliceTouched = persisted?.view.sliceTouched === true && isFiniteNumber(persisted?.view.sliceMinY) && isFiniteNumber(persisted?.view.sliceMaxY)
  const view: ViewState = {
    sliceMinY: restoredSliceTouched ? persisted!.view.sliceMinY! : defaultView().sliceMinY,
    sliceMaxY: restoredSliceTouched ? persisted!.view.sliceMaxY! : defaultView().sliceMaxY,
    sliceTouched: restoredSliceTouched,
    // Clamped false whenever this host can't actually perform a grow (`!opts.onGrowRegenerate`)
    // -- see ViewState.growSticky's own doc comment for why a persisted "on" must never resurrect
    // as an active-but-inert mode on such a host, the same failure mode this button's `disabled`
    // state was already built to avoid when it was first wired (see growButton below).
    growSticky: (persisted?.view.growSticky ?? defaultView().growSticky) && Boolean(opts.onGrowRegenerate),
    environmentMode: (persisted?.view.environmentMode as EnvironmentMode) ?? defaultView().environmentMode,
    showGrid: persisted?.view.showGrid ?? defaultView().showGrid,
    showCarved: persisted?.view.showCarved ?? defaultView().showCarved,
    showHeatmap: persisted?.view.showHeatmap ?? defaultView().showHeatmap,
    showOverflow: persisted?.view.showOverflow ?? defaultView().showOverflow,
    showTextures: persisted?.view.showTextures ?? defaultView().showTextures,
  }
  if (view.environmentMode !== 'solid' && view.environmentMode !== 'ghost' && view.environmentMode !== 'hidden') view.environmentMode = 'solid'

  // `?? DEFAULT_COLLAPSED_SECTIONS` and not `persisted?.collapsed ?? []`: the two are only
  // different for a panel nobody has ever opened here (loadPersisted returns null), which is
  // exactly the case the default is for. Once anything has been saved, the saved set wins whole,
  // including an empty one -- see that constant's own doc comment.
  const collapsedSections = new Set<string>(persisted?.collapsed ?? DEFAULT_COLLAPSED_SECTIONS)

  let lastResult: DecodedResult | null = null
  let lastError: string | null = null
  /** Whether a `generate` (or reload/grow) request the host is driving is currently in flight --
   * see PanelHandle.setBusy's own doc comment for the full contract, and applyBusy below for
   * where this actually gets read/written. */
  let busy = false
  /** The live Environment preset list, from the `environments` serve method -- empty until a
   * host calls setEnvironments() (see that method's own doc comment). Every reader of a
   * preset's own defaults/materials/biome (envSelect's change handler, syncBiomeInputs,
   * syncMaterialInputs) goes through getEnvironment() below rather than indexing this directly,
   * so "the list hasn't arrived yet" and "config.env names an id the list doesn't contain" are
   * handled in exactly one place. */
  let environments: EnvironmentOptionWire[] = []

  function getEnvironment(id: string): EnvironmentOptionWire | null {
    return environments.find((e) => e.id === id) ?? null
  }

  /** Whether the SELECTED preset's terrain builder actually models a sea (EnvironmentOptionWire.
   * buildsSea, straight from env.EnvironmentPreset.BuildsSea) -- the one question the Materials
   * section's three sea slots hang off, both for disabling them and for whether to send them.
   *
   * Unknown preset (the list hasn't arrived yet, or config.env names an id it doesn't contain)
   * answers TRUE, deliberately. The two things this gates are "grey the control out and say why"
   * and "drop the value from the request": doing either on a guess would mean a control greyed
   * out with a sentence naming a preset nobody has confirmed builds no sea, and a value the user
   * typed being dropped for the same unconfirmed reason. Not knowing is a reason to leave the
   * controls exactly as they were, not to act. The window is one round trip wide and closes the
   * moment setEnvironments() lands (which re-runs syncMaterialInputs). */
  function presetBuildsSea(): boolean {
    const preset = getEnvironment(config.env)
    return preset === null || preset.buildsSea
  }

  /** The currently-SELECTED pack biome's own ResolvedBiome (surfaceBuilder/tags/...), looked up
   * by identifier in lastResult.biomeEntries -- null when no pack biome is selected
   * (config.biomeId === ''), the identifier doesn't match any loaded biome file, or no result
   * has arrived yet. Deliberately looked up by identifier against the always-current
   * biomeEntries list (every loaded biomes/*.json file, refreshed on every result) rather than
   * read from lastResult.environmentBiome directly -- environmentBiome reflects whichever
   * biomeId the LAST SENT request asked for, which can be one regenerate stale relative to a
   * pack-biome selection the user just made but hasn't triggered a request for yet (the
   * material/tag defaults this drives are prefill text, not something a user should see lag a
   * dropdown change by one round trip). */
  function getSelectedBiome(): ResolvedBiomeWire | null {
    if (!config.biomeId) return null
    return lastResult?.biomeEntries.find((e) => e.identifier === config.biomeId)?.biome ?? null
  }
  /** The last resolved placement origin Y the engine actually reported (result.origin.y) --
   * used to compose a full "x,y,z" wire origin string when the user edits Origin X/Z, since
   * there is no Origin Y control (see GenerationConfig.originTouched's doc comment) but the
   * wire's `origin` field is one atomic "x,y,z" string with no way to say "keep Y automatic".
   * Starts at 0 (best-effort) before the first result arrives; converges to the real
   * preset-computed height within one regenerate after that. */
  let resolvedOriginY = 0
  let listFilter = ''
  /** Whether the user has edited Size X/Y/Z or Min Y by hand this session -- the same
   * "config vs. touched" split originTouched/sliceTouched already use, and the one thing that
   * must stop setEnvironments() from resyncing those four inputs to the arriving preset's own
   * engine-reported defaults (see that method below). It used to ask persistence the same
   * question ("did a saved sizeX come back?"), which no longer means anything now that size
   * never persists -- but the race it guarded is still real: `environments` arrives
   * asynchronously, and a user typing into Size Y in that window must not have it silently
   * overwritten a moment later. Deliberately NOT set by the Preset dropdown's own handler,
   * which writes the newly chosen preset's defaults and should keep tracking them. */
  let sizeTouched = false

  /** Writes the persisted half of this panel's state -- the view, the collapsed sections, and
   * the subject; never the rest of the generation config (see PersistedState's own doc comment
   * for what that costs and what it buys). Writing the three subject fields out explicitly,
   * rather than handing `config` to JSON.stringify, is what makes that true by construction:
   * a field added to GenerationConfig later cannot start persisting itself by accident. Note
   * this also OVERWRITES any older build's fatter blob with the slim shape the first time it
   * runs -- deliberate, since the stale config in it must never be read again anyway. */
  function save(): void {
    const state: PersistedState = {
      config: {
        mode: config.mode,
        featureIdentifier: config.featureIdentifier,
        ruleIdentifier: config.ruleIdentifier,
      },
      view: {
        // Persist INTENT, not the clamped display artefact -- while untouched these
        // are null (same "nothing to restore" contract as before); once touched, the exact
        // value the user chose, never a value setResult clamped for display.
        sliceMinY: view.sliceTouched ? view.sliceMinY : null,
        sliceMaxY: view.sliceTouched ? view.sliceMaxY : null,
        sliceTouched: view.sliceTouched,
        growSticky: view.growSticky,
        environmentMode: view.environmentMode,
        showGrid: view.showGrid,
        showCarved: view.showCarved,
        showHeatmap: view.showHeatmap,
        showOverflow: view.showOverflow,
        showTextures: view.showTextures,
      },
      collapsed: [...collapsedSections],
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // localStorage unavailable (quota, private mode, a webview host that restricts it) --
      // persistence is best-effort, never load-bearing.
    }
  }

  /** config.materialOverride, minus whatever the SELECTED preset would ignore -- today that is
   * exactly the three sea slots under a preset whose Build models no sea (see presetBuildsSea).
   *
   * The KEPT-BUT-NOT-SENT split is the deliberate part, and it is the answer to "what happens to
   * a value I already typed when I switch from Ocean to Plains?". Three options were on the
   * table:
   *
   *   1. Clear the override. Rejected outright: switching presets to look at something else and
   *      switching back must not cost the author their typing, and a panel that quietly deletes
   *      what you typed is a worse silence than the one this whole change exists to remove.
   *   2. Keep it AND keep sending it. That is what happens today, and what the engine's own
   *      warning is for -- but now that the panel greys the control out and says in so many words
   *      that the slot does nothing here, sending it anyway would earn a diagnostic restating,
   *      after the run, exactly what the panel already said before it. Two voices, one fact, and
   *      the later one attached to a result it did not affect.
   *   3. Keep it, don't send it (this). config.materialOverride is untouched, so the disabled
   *      input still SHOWS the value -- visibly remembered, not visibly gone -- and selecting a
   *      sea-building preset again puts it straight back on the wire with no retyping. The
   *      request carries only slots that can actually change the bench.
   *
   * Note this is a filter on the way OUT, not a mutation: nothing here writes to config, so the
   * round trip Ocean -> Plains -> Ocean is lossless by construction rather than by a restore step
   * that could be forgotten. "Reset to preset materials" is still the way to actually discard
   * them, and it still discards all six. */
  function sendableMaterials(): MaterialsWire {
    const out: MaterialsWire = { ...config.materialOverride }
    if (presetBuildsSea()) return out
    for (const slot of SEA_MATERIAL_SLOTS) delete out[slot.field]
    return out
  }

  /** Builds the GenerateParamsWire the current config implies, or null if the request would be
   * invalid (neither a feature nor a rule selected -- wire.BuildConfig requires exactly one).
   * Every optional field follows one rule: never send a value the user has not actually
   * touched away from "no opinion", even if that value happens to look like a sane default --
   * see this function's own per-field comments for why size/minY are the one exception. */
  function buildGenerateParams(): GenerateParamsWire | null {
    if (config.mode === 'feature') {
      if (!config.featureIdentifier) return null
    } else if (!config.ruleIdentifier) {
      return null
    }

    const params: GenerateParamsWire = {
      env: config.env,
      // size/minY are always sent, unlike every other optional field below -- but this is
      // still never "sending a blank": these two inputs are ALWAYS resynced to the active
      // preset's own real default the moment the preset changes (see envSelect's change
      // handler), so the value sent is either that genuine default (untouched) or the user's
      // own explicit override -- never a value that could silently diverge from what the
      // engine would have picked on its own.
      size: `${config.sizeX}x${config.sizeY}x${config.sizeZ}`,
      minY: config.minY,
      repeat: config.repeatCount,
      profile: config.profiling,
    }
    // Only when set: leaving it out is what asks the engine for the preset's own default, and
    // the response echoes back featureSeed so the field can show what was actually used.
    if (config.seed !== null) params.seed = config.seed
    if (config.mode === 'feature') params.feature = config.featureIdentifier!
    else params.rule = config.ruleIdentifier!

    // origin: composed only once the user has touched X or Z -- see originTouched's doc
    // comment for why Y comes from resolvedOriginY rather than a control.
    if (config.originTouched) {
      params.origin = `${config.originX},${resolvedOriginY},${config.originZ}`
    }

    // biomeId: sent whenever a pack biome is actually selected -- unlike biomeTags below, there
    // is no separate "armed" flag to gate this on, because the Pack biome <select> IS the gate:
    // its blank/leading option means "" (no pack biome, preset default unchanged), any other
    // option means the user has explicitly picked one. See wire.GenerateParams.BiomeID's own
    // doc comment for why this SELECTS terrain materials (source 2 of the materials pipeline),
    // unlike biomeTags below.
    if (config.biomeId) params.biomeId = config.biomeId

    // biomeTags: independent of biomeId above (wire.GenerateParams.BiomeTags is a tags-only
    // override, source 3 of query.has_biome_tag/any_tag/all_tags identity, layered on top of
    // whichever of the preset/selected-biome identity is active) -- only sent once the user has
    // armed this override, so the untouched case
    // always defers to the engine's own real default (the preset's own tags, or the selected
    // pack biome's own tags) instead of re-sending a value this UI merely displayed.
    if (config.biomeTagsOverrideEnabled) {
      const tags = splitTags(config.biomeTagsText)
      if (tags.length > 0) params.biomeTags = tags
    }

    // materials: same staleness concern as biome above, but already naturally per-field
    // optional (GenerationConfig.materialOverride only ever holds keys the user actually
    // edited) -- nothing to gate, just drop the object entirely if it's empty. sendableMaterials
    // is where the three sea slots get held back under a preset that has no sea (see that
    // function): the OTHER three are always sent as edited.
    const materials = sendableMaterials()
    if (Object.keys(materials).length > 0) {
      params.materials = materials
    }

    // Budget overrides: each is only sent once the user has actually entered a value (null =
    // "no opinion, use the engine default") -- see GenerationConfig's own doc comment on these
    // three fields for why they're per-run request fields, not a permanent setting.
    if (config.writeBudget !== null) params.writeBudget = config.writeBudget
    if (config.delegationBudget !== null) params.delegationBudget = config.delegationBudget
    if (config.placementTimeLimitMs !== null) params.placementTimeLimitMs = config.placementTimeLimitMs

    return params
  }

  /** Fires the request a control change implies -- ordinarily onConfigChange, but while
   * view.growSticky is on (and this host can actually perform a grow) EVERY one of these is
   * redirected to onGrowRegenerate instead, so "every regenerate is a grown run" holds
   * for every control on this page, not just the dedicated growButton below. This
   * reuses the EXACT existing onGrowRegenerate wiring host-side (previewPanel.ts's
   * 'growRegenerate' message case, previewController.ts's generateGrown) -- no new callback or
   * message type needed. See previewPanel.ts's own lastRequestWasGrow for how a save-triggered
   * regenerate, which never calls this function at all, still inherits the same behaviour. */
  function notifyConfigChanged(): void {
    save()
    cancelPendingRegenerate()
    const params = buildGenerateParams()
    if (!params) return
    if (view.growSticky && opts.onGrowRegenerate) opts.onGrowRegenerate(params)
    else opts.onConfigChange?.(params)
  }

  /** The keystroke path into notifyConfigChanged: saves immediately (so nothing is lost) but
   * holds the actual request back until typing stops -- see REGENERATE_DEBOUNCE_MS. Any explicit
   * commit (Enter, blur, Regenerate, a discrete control) goes through notifyConfigChanged
   * directly, which also cancels whatever this had pending, so one edit is never two runs. */
  let pendingRegenerate = 0
  const debounceMs = opts.regenerateDebounceMs ?? REGENERATE_DEBOUNCE_MS
  function cancelPendingRegenerate(): void {
    if (pendingRegenerate === 0) return
    clearTimeout(pendingRegenerate)
    pendingRegenerate = 0
  }
  function scheduleConfigChanged(): void {
    save()
    cancelPendingRegenerate()
    if (debounceMs <= 0) {
      notifyConfigChanged()
      return
    }
    pendingRegenerate = setTimeout(() => {
      pendingRegenerate = 0
      notifyConfigChanged()
    }, debounceMs) as unknown as number
  }

  /** Wires one text/number input so that it (a) shows an UNCOMMITTED marker the moment its value
   * stops matching what was last sent, and (b) regenerates on its own once typing stops, instead
   * of only on blur or Enter.
   *
   * The dirty marker is the honest half. These inputs commit on blur/Enter, so a typed-but-not-
   * committed value looked exactly like a sent one -- the panel showed 64 while the preview was
   * still the result of 32, and nothing said so. `commit` is the SAME handler the input's own
   * `change` already ran, so there is one code path per control, not two. */
  const committedInputs: { input: HTMLInputElement; resync: () => void }[] = []
  function attachCommit(input: HTMLInputElement, commit: () => void): void {
    let committed = input.value
    let timer = 0
    const clearTimer = (): void => {
      if (timer === 0) return
      clearTimeout(timer)
      timer = 0
    }
    const markClean = (): void => {
      input.classList.remove('fl-dirty')
      input.title = ''
    }
    const fire = (): void => {
      clearTimer()
      // Nothing to send. This is also what stops one edit becoming two runs: the debounce commits
      // while the field still has focus, and the browser then fires its own `change` on blur for
      // the same edit.
      if (input.value === committed) {
        markClean()
        return
      }
      markClean()
      commit()
      // Read back AFTER committing: a handler that clamps (Size Y above 512, a negative budget)
      // rewrites the field, and baselining against the pre-clamp text would leave the input
      // permanently "uncommitted" against a value it can never hold.
      committed = input.value
    }
    input.addEventListener('input', () => {
      const dirty = input.value !== committed
      input.classList.toggle('fl-dirty', dirty)
      input.title = dirty ? UNCOMMITTED_TITLE : ''
      clearTimer()
      if (!dirty) return
      if (debounceMs <= 0) {
        fire()
        return
      }
      timer = setTimeout(fire, debounceMs) as unknown as number
    })
    input.addEventListener('change', fire)
    // A programmatic write (setResult re-syncing a preset's defaults, the budget quick-fix)
    // is by definition already committed -- re-reading the value here is what stops those from
    // leaving a permanent, wrong "uncommitted" marker behind.
    committedInputs.push({
      input,
      resync: () => {
        committed = input.value
        markClean()
      },
    })
  }
  /** Re-baselines every committed input against its current value -- called whenever this module
   * writes those values itself. */
  function resyncCommitted(): void {
    for (const entry of committedInputs) entry.resync()
  }

  root.textContent = ''
  root.classList.add('fl-panel')

  // ---- always-visible banners (never inside a collapsible section) ------------------------
  const staleBanner = h('div', 'fl-banner fl-banner-stale')
  staleBanner.style.display = 'none'
  const errorBanner = h('div', 'fl-banner fl-banner-error')
  errorBanner.style.display = 'none'
  // role=alert for the two that report something WRONG, role=status for the rest: without these
  // a screen reader user gets no notification at all that the engine died or a run failed --
  // the banner simply appears, silently, somewhere they are not looking.
  errorBanner.setAttribute('role', 'alert')
  staleBanner.setAttribute('role', 'alert')
  // ONE BUSY INDICATOR, AND IT IS NOT HERE. A sidebar "Generating…" banner used to appear at the
  // same moment as the viewport's own busy pill, which already says the same word, counts the
  // elapsed time and carries Cancel -- two live indicators for one request, in one window, one
  // of which could do nothing about it. The banner is gone; what remains in the sidebar is the
  // stat tiles' pending look (.fl-readout-busy), which is not a second announcement but the
  // numbers themselves declining to read as this run's. See applyBusy.
  root.append(staleBanner, errorBanner)

  // ---- always-visible counts readout (the main result, so it is kept prominent) ------------
  // ------------------------------------------------------------------------------------------
  // The three chips are BUTTONS, and each one toggles the lens that shows what its own number
  // counts. They already looked like toggles -- three filled, rounded, labelled rectangles -- and
  // were inert, which is a worse lie than looking inert would have been. The loud hardcoded
  // green/orange/blue fills are gone with them: a fill that ignores the theme cannot follow the
  // user's own contrast settings, and a zero rendered in success green is the specific thing that
  // made "placed nothing" read as "placed fine".
  const countsSection = h('div', 'fl-readout')
  const placedTile = h('button', 'fl-stat fl-stat-placed') as HTMLButtonElement
  const carvedTile = h('button', 'fl-stat fl-stat-carved') as HTMLButtonElement
  const replacedTile = h('button', 'fl-stat fl-stat-replaced') as HTMLButtonElement
  for (const [tile, label] of [
    [placedTile, 'placed'],
    [carvedTile, 'carved'],
    [replacedTile, 'replaced'],
  ] as const) {
    tile.type = 'button'
    // Three lines, and the third is the one this row was missing: a stat row that is secretly
    // three toggles reads as a stat row, so the lens each chip drives -- and whether it is
    // currently on -- is now written on the chip in words instead of living in a native tooltip.
    tile.append(h('div', 'fl-stat-value', '0'), h('div', 'fl-stat-label', label), h('div', 'fl-stat-lens', ''))
  }
  // PLACED hides the surrounding terrain, so what is left on screen is what this number counted.
  placedTile.addEventListener('click', () => {
    setEnvironmentMode(view.environmentMode === 'hidden' ? 'solid' : 'hidden')
  })
  // CARVED is the exact match: the carved overlay draws the cells this number counts. It is the
  // one chip that can be inert (a run that carved nothing has no overlay to draw), and it says
  // so with aria-disabled rather than `disabled` -- see dom.ts's setInert for why the sentence
  // on a dead control is the one that most needs to stay reachable.
  carvedTile.addEventListener('click', () => {
    if (isInert(carvedTile)) return
    setShowCarved(!view.showCarved)
  })
  // REPLACED is about cells written more than once, which is what the heatmap colours. The
  // NUMBER is real whether or not profiling was on -- the engine counts overwrites either way --
  // so this chip is never disabled: greying out a live figure said the figure was unavailable,
  // which was not true of anything on the chip. Only the LENS needs a profiled run, and clicking
  // with profiling off is a request for that lens, so it arms both and re-runs rather than
  // doing nothing.
  replacedTile.addEventListener('click', () => {
    if (!config.profiling) {
      config.profiling = true
      profilingCheckbox.checked = true
      view.showHeatmap = true
      heatmapCheckbox.checked = true
      opts.viewer.setShowHeatmap(true)
      syncHeatmapAvailability()
      renderProfilerSection()
      save()
      notifyConfigChanged()
      return
    }
    setShowHeatmap(!view.showHeatmap)
  })
  countsSection.append(placedTile, carvedTile, replacedTile)

  /** Keeps each chip's pressed state, lens line, tooltip and disabled reason in step with the
   * View section rows it mirrors -- one function so a chip and its row can never disagree about
   * a lens.
   *
   * A CHIP READS "ON" ONLY WHEN ITS LENS IS ACTUALLY SHOWING SOMETHING. The carved overlay is on
   * by default, so the CARVED chip used to light up on every run including the (overwhelmingly
   * common) ones that carved nothing -- an accent that means "you are looking at this" pointing
   * at an empty overlay. A zero count now reads as off and the chip says why. */
  function syncStatChips(): void {
    const setLens = (tile: HTMLButtonElement, text: string): void => {
      const el = tile.querySelector('.fl-stat-lens')
      if (el) el.textContent = text
    }

    const isolated = view.environmentMode === 'hidden'
    placedTile.setAttribute('aria-pressed', String(isolated))
    placedTile.classList.toggle('fl-stat-on', isolated)
    setLens(placedTile, isolated ? 'terrain hidden' : 'hide terrain')
    // "CELLS", spelled out, because a graph editor next to this one reports the same run's
    // per-feature figure as WRITES and the two numbers differ (79 against 110 on a measured run)
    // while both used to be called "blocks". Neither is wrong: a feature that writes the same
    // cell twice spends two writes on one block. Saying which of the two this tile counts is what
    // stops the pair reading as a contradiction.
    const placedWhat = 'Cells this run ended up placing a block into — counted once each, however many writes hit them.'
    placedTile.title = isolated
      ? `Terrain hidden, so only what was placed is drawn. Click to bring it back.\n${placedWhat}`
      : `${placedWhat} Click to hide the surrounding terrain and see only them.`

    // Before the first result there is no run to have carved nothing, so the chip stays live --
    // "0" is a placeholder then, not an answer.
    const carvedCount = lastResult?.counts.carved ?? 0
    const carvedNothing = lastResult !== null && carvedCount === 0
    const carvedLive = view.showCarved && !carvedNothing
    setInert(carvedTile, carvedNothing)
    carvedTile.setAttribute('aria-pressed', String(carvedLive))
    carvedTile.classList.toggle('fl-stat-on', carvedLive)
    setLens(carvedTile, carvedNothing ? 'nothing carved' : carvedLive ? 'overlay on' : 'show overlay')
    carvedTile.title = carvedNothing
      ? 'This run turned no cells to air, so the carved overlay has nothing to draw.'
      : view.showCarved
        ? 'Carved cells are drawn as a tinted volume. Click to hide them.'
        : 'Cells this run turned to air. Click to draw them as a tinted volume.'

    // Never disabled -- see the click handler for why the number being real is the whole point.
    const canHeatmap = config.profiling
    replacedTile.disabled = false
    replacedTile.setAttribute('aria-pressed', String(view.showHeatmap && canHeatmap))
    replacedTile.classList.toggle('fl-stat-on', view.showHeatmap && canHeatmap)
    setLens(replacedTile, canHeatmap ? (view.showHeatmap ? 'heat map on' : 'show heat map') : 'heat map needs profiling')
    replacedTile.title = canHeatmap
      ? view.showHeatmap
        ? 'Each touched cell is coloured by how many writes hit it. Click to stop.'
        : 'Blocks this run overwrote. Click to colour every cell by how many writes hit it.'
      : 'Blocks this run overwrote — a real count either way. The heat map that shows WHERE needs a profiled run: click to turn profiling on and generate again.'
  }
  const partialBadge = h('div', 'fl-badge-partial', 'PARTIAL RESULT — cut off by budget/time limit')
  partialBadge.style.display = 'none'

  // ---- the outcome, announced --------------------------------------------------------------
  // A run that FAILS raises a role=alert banner and a run that places NOTHING shows a role=status
  // line, but a run that simply worked announced nothing at all: the three live regions that
  // mutate at that instant (the busy pill, the viewport notice, the host's attribution readout)
  // are every one of them hidden by then, and the figures themselves land in plain <div>s. The
  // single most useful sentence in the panel -- what the run actually did -- was the one a
  // screen reader never spoke. This is that sentence, and nothing else: see announceOutcome.
  const srStatus = h('div', 'fl-sr-status')
  srStatus.setAttribute('role', 'status')
  srStatus.setAttribute('aria-live', 'polite')

  /** Speaks the result of a finished run, once.
   *
   * Deliberately silent for a run that placed, carved and replaced nothing: that case already
   * has its own status line on screen (renderEmptyResult), and it says WHY, which is strictly
   * more useful than three zeros read out after it. */
  function announceOutcome(counts: BlockCounts, placementDurationMs: number, partial: boolean): void {
    if (counts.placed === 0 && counts.carved === 0 && counts.replaced === 0) return
    const n = (v: number): string => v.toLocaleString('en-US')
    srStatus.textContent = `${partial ? 'Partial result. ' : ''}${n(counts.placed)} placed, ${n(counts.carved)} carved, ${n(counts.replaced)} replaced, in ${placementDurationMs.toFixed(1)} ms.`
  }

  // ---- "this run placed nothing", said once, in words -------------------------------------
  // Three zeros and "No diagnostics." is not a report; it is the same picture a crash makes. The
  // engine already knows WHY a feature stopped (iterations that rounded to 0, a chance roll that
  // failed, no surface to snap to) -- this is the one line that says so where the zeros are.
  // Hidden for every run that placed, carved or replaced anything: a result that did something
  // needs no reassurance that it did.
  const emptyResultEl = h('div', 'fl-empty-result')
  emptyResultEl.style.display = 'none'
  emptyResultEl.setAttribute('role', 'status')
  emptyResultEl.setAttribute('aria-live', 'polite')
  const emptyResultText = h('span', 'fl-empty-result-text')
  // Reuses the diagnostics section's camera-jump verbatim -- the same glyph, the same action, the
  // same tooltip -- because "show me where" is the same question here as it is there.
  const emptyResultLocate = h('button', 'fl-diag-position') as HTMLButtonElement
  emptyResultLocate.type = 'button'
  emptyResultLocate.title = 'Move the camera to this cell and highlight it'
  emptyResultLocate.style.display = 'none'
  // The "the answer is already on screen, six sections down" control. When nothing stopped, the
  // explanation for an empty run is nearly always a diagnostic -- and the Diagnostics section
  // sits below the fold behind six other sections, so a line that merely said "nothing reported
  // stopping it" was true, unhelpful, and sitting directly above the real answer.
  const emptyResultDiagnostics = h('button', 'fl-empty-result-link') as HTMLButtonElement
  emptyResultDiagnostics.type = 'button'
  emptyResultDiagnostics.style.display = 'none'
  emptyResultEl.append(emptyResultText, emptyResultLocate, emptyResultDiagnostics)

  // ---- "what did I just click on" -------------------------------------------------------------
  // CLICKING A BLOCK NOW ALWAYS ANSWERS. It used to answer only while the node editor had asked
  // the attribution question, so in an ordinary preview -- which is every preview -- clicking a
  // block did nothing whatsoever, in a tool whose entire subject is which block ended up where.
  // The gesture lives in the viewer now (VoxelViewer.onPick); this line is what it says.
  //
  // One line, and it is the two facts a coordinate readout has to carry: WHAT (the block id, so
  // it can be copied into a feature file) and WHERE (world x, y, z, so it can be compared with a
  // diagnostic's own position). Whether this run placed it, carved it or merely stands on it is
  // the third, and the one that most often ends the question.
  const pickedEl = h('div', 'fl-picked')
  pickedEl.style.display = 'none'
  pickedEl.setAttribute('role', 'status')
  pickedEl.setAttribute('aria-live', 'polite')
  const pickedName = h('span', 'fl-picked-name')
  const pickedWhere = h('button', 'fl-diag-position') as HTMLButtonElement
  pickedWhere.type = 'button'
  pickedWhere.title = 'Move the camera to this cell'
  const pickedRole = h('span', 'fl-picked-role')
  pickedEl.append(pickedName, pickedWhere, pickedRole)

  function showPickedCell(pick: PickedCell): void {
    // An unnamed id should never be shown as a bare number with no hint of what it is -- the
    // palette not carrying it is a bug worth being able to SEE, not one to paper over.
    pickedName.textContent = pick.blockName === '' ? `block id ${String(pick.blockId)} (not in this run’s palette)` : pick.blockName
    pickedWhere.textContent = `⌖ (${String(pick.x)}, ${String(pick.y)}, ${String(pick.z)})`
    pickedWhere.onclick = () => opts.viewer.highlightCell(pick.x, pick.y, pick.z)
    pickedRole.textContent = pick.carved ? '· carved by this run' : pick.placed ? '· placed by this run' : '· terrain, not written by this run'
    pickedEl.title = pick.carved
      ? 'This cell held a block before the run and is air now. What is named is the block that used to be here.'
      : pick.placed
        ? 'This run wrote this cell.'
        : 'This block is part of the environment the feature was placed into — this run did not write it.'
    pickedEl.style.display = ''
  }

  function clearPickedCell(): void {
    pickedEl.style.display = 'none'
    pickedName.textContent = ''
    pickedWhere.textContent = ''
    pickedRole.textContent = ''
  }

  // ---- Regenerate ---------------------------------------------------------------------------
  // Re-running the same inputs used to require CHANGING one of them, which is the opposite of
  // what the user wanted: with an unpinned seed, "run it again" is a genuinely different answer,
  // and with a pinned one it is how you check that a fix took. Ctrl+Enter is the shortcut because
  // it is the one every form in this editor already uses for "submit what I typed".
  const regenerateButton = h('button', 'fl-regen-btn', '↻ Regenerate') as HTMLButtonElement
  regenerateButton.type = 'button'
  regenerateButton.title = 'Runs the current settings again (Ctrl+Enter). With no seed pinned, that is a different roll; with one pinned, the same run.'
  regenerateButton.addEventListener('click', () => {
    regenerate()
  })

  /** The one path "run it again" takes, whatever triggered it -- the button, Ctrl+Enter, or a
   * pending debounce being flushed. Commits any uncommitted input first, so what runs is what is
   * on screen. */
  function regenerate(): void {
    resyncCommitted()
    notifyConfigChanged()
  }
  const durationEl = h('div', 'fl-duration')
  const buildDurationEl = h('div', 'fl-duration fl-duration-secondary')
  buildDurationEl.style.display = 'none'

  /** Single point of truth for the "request in flight" visual state. Drives two things: a
   * dimmed/pulsing look on the stat tiles (.fl-readout-busy, panel.css) so the numbers on screen
   * stop claiming to be this run's, and the 3D preview itself (VoxelViewer.setBusy), which is
   * where the ONE live busy indicator lives -- the pill that counts elapsed time and carries
   * Cancel. The sidebar banner this used to raise alongside it is gone; see its former
   * declaration above.
   *
   * Called both by the public setBusy() (a host explicitly marking a request as started/
   * finished) AND, as a deliberate safety net, from setResult/setError/setStale(true) below --
   * so a busy indicator can never survive a result, an error, or a confirmed-dead engine even if
   * a host's own setBusy(false) call is missed, forgotten, or racing with one of those. This is
   * what guarantees it cannot get stuck on if a request fails or the engine dies, and that the
   * existing stale/error banner path still wins --
   * setError/setStale(true) calling this THEMSELVES, rather than trusting every host to remember
   * to pair setBusy(true) with a setBusy(false) on every failure path, is what makes that hold
   * regardless of which host (or a future one) is driving this panel. */
  function applyBusy(v: boolean): void {
    busy = v
    countsSection.classList.toggle('fl-readout-busy', v)
    opts.viewer.setBusy(v)
  }

  // ---- out-of-bounds capture banner: the "capture and display" half of this port's out-of-
  // bounds feature is automatic (see View section's "Show overflow" toggle below, on by
  // default) -- this banner is what makes it also VISIBLE at a glance in the readout, not just
  // in the 3D view, and is where the separate "grow to fit and regenerate" action lives (see
  // onGrowRegenerate's own doc comment for why growing is a DELIBERATELY different action from
  // showing). Hidden whenever the last result captured nothing (writesOutOfBounds === 0).
  const overflowBanner = h('div', 'fl-banner fl-banner-overflow')
  overflowBanner.style.display = 'none'
  const overflowText = h('span', 'fl-banner-overflow-text')
  const growButton = h('button', 'fl-wide-btn', 'Grow to fit & regenerate') as HTMLButtonElement
  growButton.type = 'button'
  growButton.title = opts.onGrowRegenerate
    ? 'Grows the bench to fit every out-of-bounds block, then places again at the larger size — a different run, not the same one seen wider.'
    : 'Not available in this preview host yet.'
  growButton.disabled = !opts.onGrowRegenerate
  growButton.addEventListener('click', () => {
    const params = buildGenerateParams()
    if (params) opts.onGrowRegenerate?.(params)
  })
  overflowBanner.append(overflowText, growButton)

  // ---- sticky "grow to fit" mode toggle -- ALWAYS visible (unlike overflowBanner
  // above, which only shows for the CURRENT result's own overflow), because turning this off is
  // exactly as important to reach at any time as turning it on: see ViewState.growSticky's own
  // doc comment for the full contract, and this row's own disabled state below for why a
  // persisted "on" can never resurrect as an active-looking-but-inert control on a host that
  // cannot perform a grow at all. Deliberately a checkbox, not a separate on/off button pair --
  // the SAME control toggling both directions is what makes "off" as obvious as "on" instead of
  // needing to be discovered as a different affordance somewhere else. */
  const growStickyCheckbox = checkboxInput(view.growSticky)
  growStickyCheckbox.disabled = !opts.onGrowRegenerate
  const growStickyRow = row(
    'Grow every run',
    growStickyCheckbox,
    opts.onGrowRegenerate
      ? 'Every regenerate grows the bench to fit whatever spilled outside it and places again — a different run each time, not the same one seen wider.'
      : 'Not available in this preview host yet.',
  )
  growStickyCheckbox.addEventListener('change', () => {
    view.growSticky = growStickyCheckbox.checked
    save()
    renderGrownBanner()
    notifyConfigChanged()
  })

  // ---- grown re-run banner: shown whenever the CURRENT result actually came from a grow action
  // (result.grown === true, see DecodedResult.grown's own doc comment for why a consumer must
  // not conflate this with an ordinary result), OR -- for as long as sticky
  // mode (above) is switched on at all, regardless of whether this SPECIFIC run happened to need
  // growing. Without the sticky half, this banner (like the one-shot grow button) only ever
  // reflected the single request that just finished: a save-triggered regenerate right after
  // silently reverted to the ungrown bench with nothing telling the user that happened -- the
  // reported bug the sticky half fixes. See renderGrownBanner below for the exact text each
  // state gets.
  // A BADGE ON THE ROW, not five lines under it. What growing IS -- that a grown run is a
  // different placement, that the mode is sticky, that the bench is refit from each run's own
  // overflow -- is a standing fact about the tool, so it lives behind the `?` (panelDocs.ts's
  // "Result" section) like every other standing fact here. What stays on screen is only what is
  // true of THIS run: on/off, and whether this one actually grew.
  const grownBadge = h('span', 'fl-grow-badge')
  grownBadge.style.display = 'none'
  const growHelp = h('button', 'fl-help', '?') as HTMLButtonElement
  growHelp.type = 'button'
  growHelp.title = 'Explain Result'
  growHelp.setAttribute('aria-label', 'Explain Result')
  growHelp.setAttribute('aria-expanded', 'false')
  growHelp.addEventListener('click', () => docs.toggle('readout'))
  growStickyRow.append(grownBadge, growHelp)

  root.append(countsSection, srStatus, emptyResultEl, pickedEl, partialBadge, durationEl, buildDurationEl, regenerateButton, growStickyRow, overflowBanner)

  function renderOverflowBanner(result: DecodedResult): void {
    const count = result.counts.writesOutOfBounds
    if (count <= 0) {
      overflowBanner.style.display = 'none'
      return
    }
    const captured = result.overflowBlocks.length
    // One line about THIS run; what capture means, and what growing does about it, is in the
    // tooltip and the Result documentation (panelDocs.ts), not here.
    overflowText.textContent =
      `${count.toLocaleString('en-US')} write${count === 1 ? '' : 's'} outside the bench` +
      (captured > 0 ? ` · ${captured.toLocaleString('en-US')} captured` : ' · none captured')
    overflowBanner.style.display = ''
  }
  overflowBanner.title = 'Writes that landed outside the bench this run; captured ones are drawn in magenta, the rest are in Diagnostics.'

  const GROWN_SIZES = (from: BoundsWire, to: BoundsWire): string => `${from.sizeX}×${from.sizeY}×${from.sizeZ} → ${to.sizeX}×${to.sizeY}×${to.sizeZ}`

  /** The grow state, as ONE badge on the "Grow every run" row.
   *
   * This replaced a banner that stacked up to five permanent lines of explanation under a
   * checkbox -- what a grown run is, that it is a different placement, that the mode is sticky,
   * what the bench is refit from. All of that is a standing fact about the tool rather than a fact
   * about this run, so all of it moved behind the row's own `?` (panelDocs.ts's "Result" section),
   * and what is left here is only what changes run to run.
   *
   * Reads `lastResult` from the enclosing closure (rather than taking one as a parameter) so both
   * setResult and the sticky checkbox's own 'change' handler -- which has no new result, possibly
   * none at all -- can call it the same way. */
  function renderGrownBanner(): void {
    const result = lastResult
    const grew = result?.grown === true && result.preGrowBounds !== null
    if (grew) {
      grownBadge.textContent = `grown ${GROWN_SIZES(result!.preGrowBounds!, result!.volume)}`
      // The one standing fact that has to travel WITH the number, because the number is exactly
      // what invites the wrong reading: a grown run is not the same result seen wider.
      grownBadge.title = 'This run grew the bench to fit writes that spilled outside it, then placed again at the larger size — a different placement, not the same one seen wider.'
      grownBadge.classList.add('fl-grow-badge-grew')
    } else if (view.growSticky && result) {
      grownBadge.textContent = 'no growth needed'
      grownBadge.title = 'Everything this run wrote fitted inside the bench as configured.'
      grownBadge.classList.remove('fl-grow-badge-grew')
    } else {
      grownBadge.textContent = ''
      grownBadge.classList.remove('fl-grow-badge-grew')
    }
    grownBadge.style.display = grownBadge.textContent === '' ? 'none' : ''
  }

  /** Picks the one diagnostic the empty-result line should send a reader to.
   *
   * "The relevant entry", in order: a diagnostic this run's own subject feature appears in
   * (heading identifier or delegation chain), then any error, then whatever is first. Pack-wide
   * diagnostics are excluded entirely (see `isRunDiagnostic`) -- a file that would not parse is
   * worth reporting, but it is not why THIS placement produced nothing. */
  function pickEmptyResultDiagnostic(diagnostics: readonly DecodedDiagnostic[]): DecodedDiagnostic | null {
    const mine = diagnostics.filter(isRunDiagnostic)
    if (mine.length === 0) return null
    const subject = (config.mode === 'feature' ? config.featureIdentifier : config.ruleIdentifier) ?? ''
    return mine.find((d) => subject !== '' && (d.identifier === subject || d.chain.includes(subject))) ?? mine.find((d) => d.level === 'error') ?? mine[0] ?? null
  }

  /** The "placed nothing" line -- see emptyResultEl's own declaration for why it exists.
   *
   * Three states:
   *
   *   - the run did something -> nothing is shown at all.
   *   - something stopped -> the heaviest stop is named, in plain words first (see
   *     `describeStop`), with the raw evaluated detail after it.
   *   - nothing stopped, but this run produced diagnostics -> the line points AT them and the
   *     control scrolls the Diagnostics section into view, expands it, and opens the entry it
   *     means. This is the fix for the case that prompted it: the true explanation ("may_replace
   *     rejected this position: it holds minecraft:air") was already on screen, roughly a
   *     thousand pixels below the fold, behind six collapsed sections.
   *   - nothing stopped and nothing was reported at all -> the honest weak sentence.
   *
   * There is deliberately no fourth state for "this engine cannot report stops". It used to
   * exist, keyed on an inverted `stopsKnown`, and it fired for the healthy case -- see
   * DecodedResult.stops.
   *
   * The stop that gets named is the one hit most often, with a count of the rest: a run that
   * stopped at four different gates has one dominant reason and three footnotes, and leading with
   * the footnotes is how a person learns to stop reading the line. */
  /** The sentence `syncViewportNotice` promotes onto the 3D view, or null when this run needs no
   * promoting. Written by renderEmptyResult, because that is the function that decides what the
   * answer IS -- the promotion must never be a second, separately-worded copy of it. */
  let promotedAnswer: string | null = null

  /** The host's own reason the engine is not answering, while the stale banner is up -- see
   * `setStale`. Kept here because `syncViewportNotice` is the one place that decides what the
   * viewport says, and a second writer to the same line is how two of them start disagreeing. */
  let staleReason: string | null = null

  /** Puts the one-line answer ON the view, beside the thing it describes.
   *
   * The readout under the canvas is the best writing in this panel and the easiest thing in the
   * window to miss: when a run places nothing, the 3D view does not change, and the explanation
   * for that is a line of text in a sidebar the eye has no reason to travel to. So exactly one
   * line goes onto the viewport -- never the diagnostics, never the counts, never a second copy
   * of anything already legible as a picture. A run that placed something is its own answer and
   * gets no banner at all; what it gets instead is nothing in the way of looking at it. */
  function syncViewportNotice(): void {
    // STALE WINS, because it is the only one of these that is about the picture itself being
    // wrong. When the engine stops answering, the viewport goes on drawing the PREVIOUS run's
    // mesh -- a complete, confident, out-of-date picture -- and the only thing that said so was
    // a banner in the sidebar. Someone watching the 3D view (which is what you watch while you
    // wait for a run) saw a preview that simply never changed. The reason goes where the stale
    // picture is.
    if (staleReason !== null) {
      opts.viewer.setNotice({ text: staleReason, tone: 'warn', title: 'The 3D view is still showing the last run that finished, not the one you asked for.' })
      return
    }
    if (promotedAnswer !== null) {
      opts.viewer.setNotice({ text: promotedAnswer, tone: 'empty', title: emptyResultEl.title })
      return
    }
    if (lastResult?.partial === true) {
      opts.viewer.setNotice({ text: 'Partial result — the run was cut off by a budget or the time limit', tone: 'warn', title: 'What is on screen is what had been placed when the run stopped, not the finished feature. Raise the budget it names in Diagnostics, or reduce what the feature is asked to do.' })
      return
    }
    opts.viewer.setNotice(null)
  }

  function renderEmptyResult(result: DecodedResult | null): void {
    emptyResultLocate.style.display = 'none'
    emptyResultDiagnostics.style.display = 'none'
    promotedAnswer = null
    if (result === null || result.counts.placed > 0 || result.counts.carved > 0 || result.counts.replaced > 0) {
      emptyResultEl.style.display = 'none'
      return
    }
    // Tolerant of a result built before `stops` existed (a hand-made fixture, an older host
    // feeding a decoded shape of its own): absent and empty both mean "nothing stopped", which
    // is the engine's own stated contract for the field.
    const stops = [...(result.stops ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    const top = stops[0]
    const diagnostics = result.diagnostics ?? []
    if (top) {
      const described = describeStop(top)
      const more = stops.length - 1
      emptyResultText.textContent = `Placed nothing · ${described.label}${more > 0 ? ` (+${String(more)} more)` : ''}`
      emptyResultEl.title = described.title
      promotedAnswer = emptyResultText.textContent
      // Mark the stopping node's own area when this run left something to point at: a diagnostic
      // carrying BOTH the stopping feature's identifier and a cell is the only data that can
      // honestly locate a stop, since a stop itself has no position on the wire. Nothing is
      // invented when there is none -- an arbitrary cell would be worse than no marker.
      const located = diagnostics.find((d) => d.position !== null && (d.identifier === top.identifier || d.chain.includes(top.identifier)))
      if (located?.position) {
        const pos = located.position
        emptyResultLocate.textContent = `⌖ (${String(pos.x)}, ${String(pos.y)}, ${String(pos.z)})`
        emptyResultLocate.onclick = () => opts.viewer.highlightCell(pos.x, pos.y, pos.z)
        emptyResultLocate.style.display = ''
      }
      emptyResultEl.style.display = ''
      return
    }
    const runDiagnostics = diagnostics.filter(isRunDiagnostic)
    const target = pickEmptyResultDiagnostic(diagnostics)
    if (target) {
      emptyResultText.textContent = 'Placed nothing · '
      emptyResultDiagnostics.textContent = `see Diagnostics (${String(runDiagnostics.length)})`
      emptyResultDiagnostics.title = `Nothing reported stopping this run, but it reported ${String(runDiagnostics.length)} diagnostic${runDiagnostics.length === 1 ? '' : 's'}. Opens the Diagnostics section at "${target.identifier}".`
      emptyResultDiagnostics.onclick = () => revealDiagnostic(target)
      emptyResultDiagnostics.style.display = ''
      emptyResultEl.title = ''
      // The viewport gets the whole sentence, link text included -- it has no button to click
      // there, so "see Diagnostics (3)" has to read as a fact rather than as an orphaned label.
      promotedAnswer = `Placed nothing · ${runDiagnostics.length.toLocaleString('en-US')} diagnostic${runDiagnostics.length === 1 ? '' : 's'} — see the sidebar`
    } else {
      emptyResultText.textContent = 'Placed nothing · nothing reported stopping it'
      emptyResultEl.title = 'Every feature this run entered ran to completion and wrote no blocks, and it reported nothing about why. A filter or an aggregate does that normally; a leaf doing it usually means it was placed somewhere it had nothing to place onto.'
      promotedAnswer = emptyResultText.textContent
    }
    emptyResultEl.style.display = ''
  }

  function renderCounts(counts: BlockCounts, placementDurationMs: number, libraryBuildDurationMs: number, partial: boolean): void {
    placedTile.querySelector('.fl-stat-value')!.textContent = counts.placed.toLocaleString()
    carvedTile.querySelector('.fl-stat-value')!.textContent = counts.carved.toLocaleString()
    replacedTile.querySelector('.fl-stat-value')!.textContent = counts.replaced.toLocaleString()
    durationEl.textContent = `${placementDurationMs.toFixed(1)} ms`
    if (libraryBuildDurationMs > 0) {
      buildDurationEl.textContent = `+ ${libraryBuildDurationMs.toFixed(1)} ms library build`
      buildDurationEl.style.display = ''
    } else {
      buildDurationEl.style.display = 'none'
    }
    partialBadge.style.display = partial ? '' : 'none'
    announceOutcome(counts, placementDurationMs, partial)
    syncStatChips()
  }

  // ---- the documentation panel: one `?` per section head opens it (see docs.ts) -----------
  // Built before the sections so each makeSection call can hand it its own id. Content is
  // computed on every open (panelDocs.ts) from the live preset list and the selected preset, so
  // the Materials page names the presets the dropdown actually has.
  const helpButtons = new Map<string, HTMLButtonElement>()
  const docs = createDocsPanel({
    // `root` IS the host's sidebar element (#fl-sidebar in both app shells, see their main.ts),
    // so its own box is the one the panel sits beside.
    anchor: () => root,
    title: 'Preview',
    subtitle: 'Every control of this sidebar',
    sections: () => panelDocs({ environments, env: config.env, canGrow: Boolean(opts.onGrowRegenerate), canReload: Boolean(opts.onReloadFiles) }),
    onChange: (open, isOpen) => {
      for (const [id, button] of helpButtons) button.setAttribute('aria-expanded', isOpen && open === id ? 'true' : 'false')
    },
    helpButtonFor: (id) => (id === null ? helpButtons.values().next().value ?? null : helpButtons.get(id) ?? null),
  })
  /** makeSection with this section's `?` wired to the docs panel. */
  function section(id: string, title: string): ReturnType<typeof makeSection> {
    const made = makeSection(id, title, collapsedSections, save, () => docs.toggle(id))
    if (made.help) {
      made.help.setAttribute('aria-controls', 'fl-docs')
      helpButtons.set(id, made.help)
    }
    return made
  }
  // The "Result" documentation has no section of its own (its subject is the always-visible
  // readout above the sections), so the `?` on the "Grow every run" row is its button: registering
  // it here is what gives it the same aria-expanded bookkeeping and focus-return every section's
  // own `?` gets, rather than a second, half-wired kind of help button.
  growHelp.setAttribute('aria-controls', 'fl-docs')
  helpButtons.set('readout', growHelp)

  // ==========================================================================================
  // ---- Feature/Rule section ----------------------------------------------------------------
  // ==========================================================================================
  const { section: featureSection, body: featureBody } = section('feature', 'Feature / Rule')

  const modeSelectorRow = h('div', 'fl-row')
  modeSelectorRow.title = 'Preview one feature on its own, or a feature rule with its placement pass and conditions.'
  modeSelectorRow.append(h('label', 'fl-row-label', 'Preview'))
  const modeGroup = h('div', 'fl-radio-group')
  const modeRadios: Record<Mode, HTMLInputElement> = {} as Record<Mode, HTMLInputElement>
  for (const [value, label] of [
    ['feature', 'Feature'],
    ['rule', 'Rule'],
  ] as const) {
    const optionLabel = h('label', 'fl-radio-option')
    const radio = h('input') as HTMLInputElement
    radio.type = 'radio'
    radio.name = 'fl-preview-mode'
    radio.value = value
    radio.checked = config.mode === value
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      config.mode = value
      updateModeVisibility()
      renderListOptions()
      notifyConfigChanged()
    })
    modeRadios[value] = radio
    optionLabel.append(radio, document.createTextNode(label))
    modeGroup.append(optionLabel)
  }
  modeSelectorRow.append(modeGroup)

  const filterInput = textInput('', 'filter by identifier…')
  const filterRow = row('Filter', filterInput, 'Narrows whichever list is visible to identifiers containing this text.')
  filterInput.addEventListener('input', () => {
    listFilter = filterInput.value
    renderListOptions()
  })

  const featureSelect = h('select', 'fl-select') as HTMLSelectElement
  const featureInfoEl = h('div', 'fl-info', '(no features loaded yet)')
  const featureRow = row('Feature', featureSelect, 'The feature the next run places; its type and file show on the line beneath.')

  const ruleSelect = h('select', 'fl-select') as HTMLSelectElement
  const ruleInfoEl = h('div', 'fl-info', '(no rules loaded yet)')
  const ruleRow = row('Rule', ruleSelect, 'The feature rule the next run evaluates; a rule that failed to build is greyed out.')

  featureSelect.addEventListener('change', () => {
    config.featureIdentifier = featureSelect.value || null
    updateFeatureInfo()
    notifyConfigChanged()
  })
  ruleSelect.addEventListener('change', () => {
    config.ruleIdentifier = ruleSelect.value || null
    updateRuleInfo()
    notifyConfigChanged()
  })

  function updateModeVisibility(): void {
    for (const [value, radio] of Object.entries(modeRadios)) radio.checked = config.mode === value
    const isRule = config.mode === 'rule'
    featureRow.classList.toggle('fl-hidden', isRule)
    featureInfoEl.classList.toggle('fl-hidden', isRule)
    ruleRow.classList.toggle('fl-hidden', !isRule)
    ruleInfoEl.classList.toggle('fl-hidden', !isRule)
  }

  function updateFeatureInfo(): void {
    const id = config.featureIdentifier
    if (!id) {
      featureInfoEl.textContent = '(select a feature)'
      return
    }
    const entry = lastResult?.entries.find((e) => e.identifier === id)
    featureInfoEl.textContent = entry ? `type ${entry.typeId}  ·  ${entry.fileId}` : `"${id}" not found in loaded files`
  }

  function updateRuleInfo(): void {
    const id = config.ruleIdentifier
    if (!id) {
      ruleInfoEl.textContent = '(select a rule)'
      return
    }
    const entry = lastResult?.ruleEntries.find((e) => e.identifier === id)
    if (!entry) {
      ruleInfoEl.textContent = `"${id}" not found in loaded rule files`
      return
    }
    if (!entry.rule) {
      ruleInfoEl.textContent = `"${id}" failed to build — see Diagnostics`
      return
    }
    ruleInfoEl.textContent = `places_feature: ${entry.rule.placesFeature}  ·  placement_pass: ${entry.rule.placementPass ?? '(none)'}`
  }

  /** Rebuilds both <select>s' <option> lists from the last result's entries, filtered by
   * `listFilter`. Cheap enough to call on every filter keystroke/mode switch -- a real pack's
   * entry count (thousands) means this still allocates proportionally to pack size, but that
   * cost is unavoidable for a live filter: the rebuild has to happen when the FILTER changes
   * and not just when the loaded SET does, so there is no signature short-circuit that would
   * help here. */
  function renderListOptions(): void {
    const filter = listFilter.trim().toLowerCase()
    const entries = lastResult?.entries ?? []
    const prevFeature = config.featureIdentifier ?? ''
    featureSelect.textContent = ''
    for (const entry of entries) {
      if (filter && !entry.identifier.toLowerCase().includes(filter)) continue
      const opt = document.createElement('option')
      opt.value = entry.identifier
      opt.textContent = `${entry.identifier}  (${entry.fileId})`
      featureSelect.append(opt)
    }
    if ([...featureSelect.options].some((o) => o.value === prevFeature)) featureSelect.value = prevFeature
    else if (featureSelect.options.length > 0) featureSelect.selectedIndex = -1

    const ruleEntries = lastResult?.ruleEntries ?? []
    const prevRule = config.ruleIdentifier ?? ''
    ruleSelect.textContent = ''
    for (const entry of ruleEntries) {
      if (filter && !entry.identifier.toLowerCase().includes(filter)) continue
      const opt = document.createElement('option')
      opt.value = entry.identifier
      opt.textContent = `${entry.identifier}  (${entry.fileId})`
      if (!entry.rule) opt.disabled = true
      ruleSelect.append(opt)
    }
    if ([...ruleSelect.options].some((o) => o.value === prevRule)) ruleSelect.value = prevRule
    else if (ruleSelect.options.length > 0) ruleSelect.selectedIndex = -1
  }

  const reloadButton = h('button', 'fl-wide-btn', 'Reload files') as HTMLButtonElement
  reloadButton.type = 'button'
  reloadButton.disabled = !opts.onReloadFiles
  reloadButton.title = opts.onReloadFiles ? 'Re-reads every feature, rule and biome file of the pack, then regenerates.' : 'Not available in this preview host yet.'
  reloadButton.addEventListener('click', () => opts.onReloadFiles?.())

  // Origin X/Z + Repeat count -- placement config for whichever feature/rule is selected
  // above. There is deliberately no Origin Y control -- see GenerationConfig.originTouched.
  const originXInput = numberInput(config.originX)
  const originZInput = numberInput(config.originZ)
  attachCommit(originXInput, () => {
    config.originX = readInt(originXInput, config.originX)
    config.originTouched = true
    originXInput.value = String(config.originX)
    notifyConfigChanged()
  })
  attachCommit(originZInput, () => {
    config.originZ = readInt(originZInput, config.originZ)
    config.originTouched = true
    originZInput.value = String(config.originZ)
    notifyConfigChanged()
  })

  // Seed + Random. A scatter_chance gate that does not roll produces a diagnostic saying "luck,
  // not configuration -- a different seed may place", and without a control that advice is not
  // actionable. Empty means "let the preset choose", which is not the same as 0: 0 is a real
  // seed, which is why wire.GenerateParams.seed is a pointer.
  const seedInput = optionalNumberInput(config.seed, { min: 0 })
  attachCommit(seedInput, () => {
    const v = readOptionalInt(seedInput, config.seed)
    config.seed = v === null || v < 0 ? null : v
    seedInput.value = config.seed === null ? '' : String(config.seed)
    notifyConfigChanged()
  })

  const randomSeedButton = h('button', 'fl-seed-btn', 'Random') as HTMLButtonElement
  randomSeedButton.type = 'button'
  randomSeedButton.title = 'Picks a new random seed and regenerates.'
  randomSeedButton.addEventListener('click', () => {
    // Math.random is fine here: this only chooses WHICH deterministic run to show. Everything
    // downstream of the seed stays fully reproducible from it -- that is the whole point of
    // surfacing the value rather than reshuffling invisibly.
    config.seed = Math.floor(Math.random() * 0xffffffff)
    seedInput.value = String(config.seed)
    resyncCommitted()
    notifyConfigChanged()
  })

  const seedRowControl = h('div', 'fl-seed-row')
  seedRowControl.append(seedInput, randomSeedButton)

  const repeatInput = numberInput(config.repeatCount, { min: REPEAT_MIN, max: REPEAT_MAX })
  attachCommit(repeatInput, () => {
    config.repeatCount = clamp(readInt(repeatInput, config.repeatCount), REPEAT_MIN, REPEAT_MAX)
    repeatInput.value = String(config.repeatCount)
    notifyConfigChanged()
  })

  featureBody.append(
    modeSelectorRow,
    filterRow,
    featureRow,
    featureInfoEl,
    ruleRow,
    ruleInfoEl,
    row('Origin X', originXInput, 'World X of the placement origin, sent once edited; Y is the height the preset resolves.'),
    row('Origin Z', originZInput, 'World Z of the placement origin, sent once edited; Y is the height the preset resolves.'),
    row('Seed', seedRowControl, 'Empty uses the preset default; the same seed reproduces the same run.'),
    row('Repeat count', repeatInput, `How many times the placement is attempted in one run (${REPEAT_MIN}–${REPEAT_MAX}).`),
    reloadButton,
  )

  // ==========================================================================================
  // ---- Environment section -----------------------------------------------------------------
  // ==========================================================================================
  const { section: envSection, body: envBody } = section('environment', 'Environment')

  // Starts empty -- populated by renderEnvironmentOptions() once setEnvironments() delivers the
  // real list (see that PanelHandle method's own doc comment), the same "no data until the host
  // provides it" posture the Feature/Rule selects above already have.
  const envSelect = h('select', 'fl-select') as HTMLSelectElement
  const presetRow = row('Preset', envSelect)

  /** The selected preset's own description is its row's tooltip -- the sentence the engine
   * wrote for it, not a paragraph under the dropdown. Every preset's description is also listed
   * under the Environment `?`. */
  function syncPresetTitle(): void {
    const preset = getEnvironment(config.env)
    presetRow.title = preset ? `${preset.label}: ${preset.description}` : 'The terrain the feature is placed into; the preset list has not arrived from the engine yet.'
    for (const opt of envSelect.options) opt.title = getEnvironment(opt.value)?.description ?? ''
  }

  /** Rebuilds envSelect's <option> list from the live `environments` array -- called once
   * setEnvironments() delivers it, mirroring renderListOptions' "rebuild from the last known
   * list, preserving the current selection if it's still present" pattern. */
  function renderEnvironmentOptions(): void {
    const prevEnv = config.env
    envSelect.textContent = ''
    for (const preset of environments) {
      const opt = document.createElement('option')
      opt.value = preset.id
      opt.textContent = preset.label
      envSelect.append(opt)
    }
    if ([...envSelect.options].some((o) => o.value === prevEnv)) envSelect.value = prevEnv
    else if (envSelect.options.length > 0) envSelect.selectedIndex = -1
    syncPresetTitle()
  }

  const sizeXInput = numberInput(config.sizeX, { min: SIZE_XZ_MIN, max: SIZE_XZ_MAX })
  const sizeYInput = numberInput(config.sizeY, { min: SIZE_Y_MIN, max: SIZE_Y_MAX })
  const sizeZInput = numberInput(config.sizeZ, { min: SIZE_XZ_MIN, max: SIZE_XZ_MAX })
  const minYInput = numberInput(config.minY)

  function applySizeChange(): void {
    sizeTouched = true
    config.sizeX = clamp(readInt(sizeXInput, config.sizeX), SIZE_XZ_MIN, SIZE_XZ_MAX)
    config.sizeY = clamp(readInt(sizeYInput, config.sizeY), SIZE_Y_MIN, SIZE_Y_MAX)
    config.sizeZ = clamp(readInt(sizeZInput, config.sizeZ), SIZE_XZ_MIN, SIZE_XZ_MAX)
    config.minY = readInt(minYInput, config.minY)
    sizeXInput.value = String(config.sizeX)
    sizeYInput.value = String(config.sizeY)
    sizeZInput.value = String(config.sizeZ)
    minYInput.value = String(config.minY)
    notifyConfigChanged()
  }
  attachCommit(sizeXInput, applySizeChange)
  attachCommit(sizeYInput, applySizeChange)
  attachCommit(sizeZInput, applySizeChange)
  attachCommit(minYInput, applySizeChange)

  envSelect.addEventListener('change', () => {
    config.env = envSelect.value
    const preset = getEnvironment(config.env)
    // preset can only be null here if the list is somehow stale relative to the <option> the
    // user just picked (should not happen -- the options ARE the list) -- guard anyway rather
    // than write NaN/undefined into config on a theoretical race.
    if (preset) {
      config.sizeX = preset.defaults.sizeX
      config.sizeY = preset.defaults.sizeY
      config.sizeZ = preset.defaults.sizeZ
      config.minY = preset.defaults.minY
      sizeXInput.value = String(config.sizeX)
      sizeYInput.value = String(config.sizeY)
      sizeZInput.value = String(config.sizeZ)
      minYInput.value = String(config.minY)
    }
    syncPresetTitle()
    syncBiomeInputs()
    syncMaterialInputs()
    notifyConfigChanged()
  })

  const SIZE_HINT = (axis: string) => `The bench's extent along ${axis} in blocks (${SIZE_XZ_MIN}–${SIZE_XZ_MAX}); a preset change resets it to that preset's default.`
  envBody.append(
    presetRow,
    row('Size X', sizeXInput, SIZE_HINT('X')),
    row('Size Y', sizeYInput, `The bench's height in blocks (${SIZE_Y_MIN}–${SIZE_Y_MAX}); a preset change resets it to that preset's default.`),
    row('Size Z', sizeZInput, SIZE_HINT('Z')),
    // Hint disambiguates this from the View section's OWN "Min Y (cut)" a few sections down --
    // same label prefix, unrelated meaning: this one is the bench floor, sent on the wire with
    // the next generate request; that one is a display-only slice of whatever the last result
    // already contains. See that row's own title for the reverse pointer.
    row('Min Y', minYInput, 'The bench floor in world Y, sent with the next request; not the View section\'s display-only "Min Y (cut)".'),
  )

  // ==========================================================================================
  // ---- Materials section --------------------------------------------------------------------
  // ==========================================================================================
  const { section: materialsSection, body: materialsBody } = section('materials', 'Materials')

  const topMaterialInput = textInput('')
  const midMaterialInput = textInput('')
  const foundationMaterialInput = textInput('')
  const seaFloorMaterialInput = textInput('')
  const seaMaterialInput = textInput('')
  const seaFloorDepthInput = numberInput(0, { min: 0 })

  /** The base materials shown/sent before config.materialOverride's own per-field overrides
   * (source 3) win: the SELECTED pack biome's own surfaceBuilder (source 2, see
   * getSelectedBiome) when one is armed and the loaded pack actually declares it, else the
   * active preset's own native materials (source 1) -- exactly session.go's own
   * MergeMaterialSlots precedence, so what this section shows always matches what the engine
   * will actually build. See this file's Biome-section header comment for the full pipeline. */
  function effectiveBaseMaterials(): EnvironmentMaterialsWire | MaterialSlotsWire {
    return getSelectedBiome()?.surfaceBuilder ?? getEnvironment(config.env)?.materials ?? FALLBACK_ENV_MATERIALS
  }

  const seaFloorMaterialRow = row('Sea floor material', seaFloorMaterialInput, 'surface_builder sea_floor_material: the seabed band under the water column (sea presets only).')
  const seaMaterialRow = row('Sea material', seaMaterialInput, 'surface_builder sea_material: the water column itself (sea presets only).')
  const seaFloorDepthRow = row('Sea floor depth', seaFloorDepthInput, 'surface_builder sea_floor_depth: how deep the seabed band goes (sea presets only).')

  /** Greys the three sea slots out under a preset that builds no sea, and makes each SHOW why:
   * the row dims (`fl-row-inert`) and the disabled input's own tooltip names the preset, the
   * presets that would honour it, and says the value is kept (inertSeaSlotTitle). No sentence is
   * written into the panel for it -- the full rule is under the Materials `?` (panelDocs.ts).
   *
   * The rule matches the CLI's own, deliberately: --sea-floor-depth/--sea-floor-material/
   * --sea-material already say "ocean only" in their help text, and env.InertSeaSlotOverrides
   * warns when one is set under a preset that builds no sea. The panel is saying the same thing
   * one step earlier, and says it from the same source (the engine's buildsSea flag) rather than
   * inventing a second rule that could drift from it. Which presets DO build a sea is read off
   * the live list too, so the tooltip names them by their real labels instead of hardcoding
   * "Ocean" -- the same reason the Preset dropdown itself stopped being a hand-transcribed
   * mirror. */
  function syncSeaSlotAvailability(): void {
    const buildsSea = presetBuildsSea()
    const slots: [HTMLElement, HTMLInputElement][] = [
      [seaFloorMaterialRow, seaFloorMaterialInput],
      [seaMaterialRow, seaMaterialInput],
      [seaFloorDepthRow, seaFloorDepthInput],
    ]
    const reason = buildsSea ? '' : inertSeaSlotTitle(getEnvironment(config.env)?.label ?? config.env, environments)
    for (const [slotRow, input] of slots) {
      // INERT, NOT DISABLED -- the same correction the CARVED chip, "Block textures" and "Show
      // heatmap" already took, arriving late at the three controls that need it most: the
      // reason here is not "unavailable" but "your value is being KEPT and not sent", which is
      // the kind of sentence a person goes looking for. `disabled` took all three out of the
      // tab order (measured: reachable=false for every one) together with the only copy of it.
      //
      // `readOnly` is what actually stops the editing, because aria-disabled is an announcement
      // and nothing more -- a plain aria-disabled text input still accepts typing. readonly
      // keeps the control focusable and in the tab order, which is the whole point.
      setInert(input, !buildsSea)
      input.readOnly = !buildsSea
      slotRow.classList.toggle('fl-row-inert', !buildsSea)
      // An input with a title of its own overrides the row's; blank falls back to the row's.
      if (reason) input.title = reason
      else input.removeAttribute('title')
      // ...and the same sentence as a real accessible description, which a `title` on the row
      // above was never going to be. No visible element: the standing rule for these three is
      // that the panel writes no paragraph under them (see this function's header).
      setInertReason(input, reason)
    }
  }

  function syncMaterialInputs(): void {
    const base = effectiveBaseMaterials()
    topMaterialInput.value = config.materialOverride.topMaterial ?? base.topMaterial
    midMaterialInput.value = config.materialOverride.midMaterial ?? base.midMaterial
    foundationMaterialInput.value = config.materialOverride.foundationMaterial ?? base.foundationMaterial
    seaFloorMaterialInput.value = config.materialOverride.seaFloorMaterial ?? base.seaFloorMaterial
    seaMaterialInput.value = config.materialOverride.seaMaterial ?? base.seaMaterial
    seaFloorDepthInput.value = String(config.materialOverride.seaFloorDepth ?? base.seaFloorDepth)
    // Same call site as the values themselves: every path that can change which preset is active
    // (the Preset dropdown, setEnvironments, a pack-biome change) already goes through here, so
    // availability can never lag the values shown beside it.
    syncSeaSlotAvailability()
  }
  syncMaterialInputs()

  function applyMaterialOverride<K extends keyof MaterialsWire>(field: K, value: MaterialsWire[K]): void {
    config.materialOverride = { ...config.materialOverride, [field]: value }
    notifyConfigChanged()
  }
  attachCommit(topMaterialInput, () => applyMaterialOverride('topMaterial', topMaterialInput.value))
  attachCommit(midMaterialInput, () => applyMaterialOverride('midMaterial', midMaterialInput.value))
  attachCommit(foundationMaterialInput, () => applyMaterialOverride('foundationMaterial', foundationMaterialInput.value))
  attachCommit(seaFloorMaterialInput, () => applyMaterialOverride('seaFloorMaterial', seaFloorMaterialInput.value))
  attachCommit(seaMaterialInput, () => applyMaterialOverride('seaMaterial', seaMaterialInput.value))
  attachCommit(seaFloorDepthInput, () => applyMaterialOverride('seaFloorDepth', Math.max(0, readFloat(seaFloorDepthInput, 0))))

  const materialResetButton = h('button', 'fl-wide-btn', 'Reset to preset materials') as HTMLButtonElement
  materialResetButton.type = 'button'
  materialResetButton.title = 'Clears every material override; the preset\'s (or pack biome\'s) own materials come back.'
  materialResetButton.addEventListener('click', () => {
    config.materialOverride = {}
    syncMaterialInputs()
    notifyConfigChanged()
  })

  materialsBody.append(
    row('Top material', topMaterialInput, 'surface_builder top_material: the surface layer of the terrain.'),
    row('Mid material', midMaterialInput, 'surface_builder mid_material: the layer under the surface.'),
    row('Foundation material', foundationMaterialInput, 'surface_builder foundation_material: everything beneath the mid layer.'),
    seaFloorMaterialRow,
    seaMaterialRow,
    seaFloorDepthRow,
    materialResetButton,
  )

  // ==========================================================================================
  // ---- Biome section -------------------------------------------------------------------------
  // ==========================================================================================
  const { section: biomeSection, body: biomeBody } = section('biome', 'Biome')

  /** "Pack biome" -- a real <select>, same populate-from-the-last-result pattern as the Feature/
   * Rule pickers above (see renderBiomeOptions), now that GenerateOutput carries biomeEntries
   * (wire/wire.go's "biomeEntries" field). Selecting one sets
   * biomeId, which SELECTS a pack biome and pulls in its own minecraft:surface_builder terrain
   * materials -- picking one changes the blocks the preview shows (see this section's own
   * header note below for the precedence). This is a genuinely
   * different knob from "Biome tags" below: biomeTags is a
   * tags-only override of query.has_biome_tag/any_tag/all_tags, independent of whichever pack
   * biome (if any) is selected here -- see wire.GenerateParams's own doc comment for the full
   * source-1/2/3 precedence. */
  const packBiomeSelect = h('select', 'fl-select') as HTMLSelectElement
  const biomeTagsInput = textInput('', 'comma-separated tags')

  /** Rebuilds packBiomeSelect's <option> list from lastResult.biomeEntries, gating on
   * `entry.biome !== null` (mirrors the Rule picker's `!entry.rule` -- see renderListOptions --
   * a biome file that failed to parse has an Entry but no ResolvedBiome to select; disable
   * rather than omit so a broken file is still visible in the list, consistent with how the
   * Rule picker surfaces a broken rule file rather than hiding it). A leading blank option
   * (value "") is always present -- "use the preset's own native materials/identity", i.e.
   * config.biomeId === "". */
  function renderBiomeOptions(): void {
    const prevBiomeId = config.biomeId
    packBiomeSelect.textContent = ''
    const noneOpt = document.createElement('option')
    noneOpt.value = ''
    noneOpt.textContent = '(preset default)'
    packBiomeSelect.append(noneOpt)
    for (const entry of lastResult?.biomeEntries ?? []) {
      const opt = document.createElement('option')
      opt.value = entry.identifier
      opt.textContent = `${entry.identifier}  (${entry.fileId})`
      if (!entry.biome) opt.disabled = true
      packBiomeSelect.append(opt)
    }
    if ([...packBiomeSelect.options].some((o) => o.value === prevBiomeId)) packBiomeSelect.value = prevBiomeId
    else packBiomeSelect.value = ''
  }

  packBiomeSelect.addEventListener('change', () => {
    config.biomeId = packBiomeSelect.value
    syncMaterialInputs()
    syncBiomeInputs()
    notifyConfigChanged()
  })
  attachCommit(biomeTagsInput, () => {
    config.biomeTagsText = biomeTagsInput.value
    config.biomeTagsOverrideEnabled = true
    notifyConfigChanged()
  })

  const biomeClearButton = h('button', 'fl-wide-btn', 'Clear (use preset defaults)') as HTMLButtonElement
  biomeClearButton.type = 'button'
  biomeClearButton.title = 'Drops the pack biome and the tag override; the preset\'s own biome comes back.'
  biomeClearButton.addEventListener('click', () => {
    config.biomeId = ''
    config.biomeTagsOverrideEnabled = false
    config.biomeTagsText = ''
    syncMaterialInputs()
    syncBiomeInputs()
    notifyConfigChanged()
  })

  /** Refreshes packBiomeSelect's current value and the Biome tags prefill/enabled state.
   * Doesn't touch <option> CONTENTS (renderBiomeOptions' job) -- called far more often, any
   * time config.biomeId/biomeTagsOverrideEnabled/env changes, so it stays cheap. */
  function syncBiomeInputs(): void {
    packBiomeSelect.value = config.biomeId
    if (config.biomeTagsOverrideEnabled) {
      biomeTagsInput.value = config.biomeTagsText
    } else {
      // Informational only while no override is armed -- editing still arms it (see the change
      // listener above); mirrors session.go's own default (`environmentBiome?.tags ??
      // preset.biomeTags`, wire/wire.go's "environmentBiome" doc comment) so what this shows
      // always matches what the engine would actually use if biomeTags were left unset.
      const selectedBiome = getSelectedBiome()
      const defaultTags = selectedBiome?.tags ?? getEnvironment(config.env)?.biomeTags ?? []
      biomeTagsInput.value = defaultTags.join(', ')
    }
  }
  syncBiomeInputs()

  biomeBody.append(
    row('Pack biome', packBiomeSelect, 'A biome from the loaded pack whose surface_builder materials layer over the preset\'s; a Materials override still wins per slot.'),
    row('Biome tags', biomeTagsInput, 'Comma-separated tags for query.has_biome_tag / any_tag / all_tags, independent of the pack biome.'),
    biomeClearButton,
  )

  // ==========================================================================================
  // ---- Budget section -------------------------------------------------------------------------
  // These are PER-RUN request overrides (wire.GenerateParams's writeBudget/delegationBudget/
  // placementTimeLimitMs), never a permanent VS Code/desktop setting -- the whole point is
  // raising one for a single heavy feature while watching the result, then leaving it blank
  // again: a permanently raised limit just means an accidental infinite recursion grinds for a
  // minute instead of failing fast. All three therefore start blank in every new panel, even
  // one opened seconds after the run that needed them (see PersistedState) -- forgetting is the
  // feature here, not an oversight. Blank (null) means "use the engine's own built-in default",
  // shown as each input's placeholder -- see ENGINE_DEFAULT_WRITE_BUDGET/
  // ENGINE_DEFAULT_DELEGATION_BUDGET/ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS's own doc comment
  // for where those numbers come from. A small "override" badge next to the input is a second,
  // unmissable signal for the same default-vs-overridden state a placeholder alone could make
  // easy to miss at a glance. All of the above is said to the user under this section's `?`
  // (panelDocs.ts), not in the section itself.
  // ==========================================================================================
  const { section: budgetSection, body: budgetBody } = section('budget', 'Budget')

  /** One budget control: an optional-number input (blank = engine default) plus an "override"
   * badge that only shows once the user has actually entered a value. `get`/`set` read/write
   * the relevant GenerationConfig field so this stays a thin, reusable row builder rather than
   * three near-identical copies of the same wiring. Returns the input/badge elements alongside
   * the assembled row -- the diagnostics section's budget quick-fix (see
   * applyBudgetQuickFix below) needs to update the SAME input/badge a diagnostic's own budget
   * belongs to, not just the underlying config field, so the value the user sees in the Budget
   * section never lags behind a fix applied from a diagnostic. */
  function budgetRow(
    label: string,
    hint: string,
    defaultValue: number,
    get: () => number | null,
    set: (v: number | null) => void,
  ): { el: HTMLElement; input: HTMLInputElement; badge: HTMLElement } {
    const input = optionalNumberInput(get(), { min: 0 })
    // 'en-US' explicitly -- this is a fixed reference value (the engine's own built-in
    // default), not user data, and should read the same regardless of the host's locale.
    input.placeholder = defaultValue.toLocaleString('en-US')
    const badge = h('span', 'fl-budget-badge', 'override')
    badge.classList.toggle('fl-hidden', get() === null)
    attachCommit(input, () => {
      const value = readOptionalInt(input, get())
      set(value)
      input.value = value === null ? '' : String(value)
      badge.classList.toggle('fl-hidden', value === null)
      notifyConfigChanged()
    })
    const wrap = h('div', 'fl-budget-control')
    wrap.append(input, badge)
    return { el: row(label, wrap, hint), input, badge }
  }

  /** The extension-side request-timeout status line (see previewPanel.ts's regenerate()), shown
   * once a host actually reports one via PanelHandle.setTimeoutInfo -- stays empty/hidden for a
   * host that never calls it (the Wails desktop app has no such coupling to report, see that
   * method's own doc comment), so this row is a no-op there rather than a permanently-visible
   * dead control. One line about this session's own state; the reason is its tooltip. */
  const timeoutInfoEl = h('div', 'fl-note')
  timeoutInfoEl.style.display = 'none'
  timeoutInfoEl.title = 'The extension waits at least as long as the placement time limit, so a slow-but-successful run is not reported as a dead engine.'

  const writeBudgetRow = budgetRow(
    'Write budget',
    `Max SetBlock attempts before the run is aborted as a runaway, non-converging chain (engine default ${ENGINE_DEFAULT_WRITE_BUDGET.toLocaleString('en-US')}).`,
    ENGINE_DEFAULT_WRITE_BUDGET,
    () => config.writeBudget,
    (v) => {
      config.writeBudget = v
    },
  )
  const delegationBudgetRow = budgetRow(
    'Delegation budget',
    `Max feature-to-feature delegation calls before the run is aborted (engine default ${ENGINE_DEFAULT_DELEGATION_BUDGET.toLocaleString('en-US')}).`,
    ENGINE_DEFAULT_DELEGATION_BUDGET,
    () => config.delegationBudget,
    (v) => {
      config.delegationBudget = v
    },
  )
  const timeLimitRow = budgetRow(
    // Short label -- fl-row-label is a fixed 108px column (see dom.css) and "Placement time
    // limit (ms)" ellipsized there while every other row label fit; the full name is still
    // in the hint (this row's third argument, the control's title tooltip).
    'Time limit (ms)',
    `Max wall-clock milliseconds the engine spends placing before cutting the run off as partial (engine default ${ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS.toLocaleString('en-US')} ms).`,
    ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS,
    () => config.placementTimeLimitMs,
    (v) => {
      config.placementTimeLimitMs = v
    },
  )

  budgetBody.append(writeBudgetRow.el, delegationBudgetRow.el, timeLimitRow.el, timeoutInfoEl)

  /** A budget diagnostic's own kind -- see parseBudgetDiagnostic below -- mapped to the
   * budgetRow whose input/badge that diagnostic's quick-fix button must update, alongside the
   * GenerationConfig field notifyConfigChanged() actually sends. Kept as one small table here
   * (rather than a switch duplicated at each call site) so the diagnostics section below and
   * this section can never drift out of sync about which budget is which. */
  const budgetRowsByKind: Record<BudgetKind, { input: HTMLInputElement; badge: HTMLElement; set: (v: number) => void }> = {
    write: { input: writeBudgetRow.input, badge: writeBudgetRow.badge, set: (v) => (config.writeBudget = v) },
    delegation: { input: delegationBudgetRow.input, badge: delegationBudgetRow.badge, set: (v) => (config.delegationBudget = v) },
    time: { input: timeLimitRow.input, badge: timeLimitRow.badge, set: (v) => (config.placementTimeLimitMs = v) },
  }

  /** The Diagnostics section's one-click budget fix: sets `kind`'s budget to
   * `newValue` -- both in GenerationConfig (so the next request actually sends it) AND in the
   * Budget section's own input/badge (so a user who clicks this and then opens that section
   * sees the value that's about to be sent, not a stale blank/placeholder) -- then fires a
   * fresh regenerate exactly like editing that input by hand would. See parseBudgetDiagnostic's
   * own doc comment for where `kind`/the doubled `newValue` come from. */
  function applyBudgetQuickFix(kind: BudgetKind, newValue: number): void {
    const target = budgetRowsByKind[kind]
    target.set(newValue)
    target.input.value = String(newValue)
    target.badge.classList.remove('fl-hidden')
    resyncCommitted()
    notifyConfigChanged()
  }

  // ==========================================================================================
  // ---- View section (unchanged behaviour from before this port, relaid out) -----------------
  // ==========================================================================================
  const { section: viewSection, body: viewBody } = section('view', 'View')

  const sliceMinInput = h('input', 'fl-slice-slider') as HTMLInputElement
  sliceMinInput.type = 'range'
  const sliceMinLabel = h('span', 'fl-slice-label', '')
  const sliceMaxInput = h('input', 'fl-slice-slider fl-slice-slider-primary') as HTMLInputElement
  sliceMaxInput.type = 'range'
  const sliceMaxLabel = h('span', 'fl-slice-label', '')

  /** A slider drag fires `input` on every pixel of travel, and each one used to write the whole
   * persisted blob to localStorage synchronously. The VALUES are applied immediately (the viewer
   * coalesces the re-mesh they imply itself, see VoxelViewer.setSlice); only the WRITE waits for
   * the drag to pause, and a `change` -- which is what releasing a slider fires -- flushes it on
   * the spot rather than leaving the last position of a drag owed to a timer. */
  let sliceSaveTimer = 0
  function flushSliceSave(): void {
    if (sliceSaveTimer === 0) return
    clearTimeout(sliceSaveTimer)
    sliceSaveTimer = 0
    save()
  }
  function applySlice(min: number, max: number): void {
    opts.viewer.setSlice(min, max)
    if (sliceSaveTimer !== 0) clearTimeout(sliceSaveTimer)
    sliceSaveTimer = setTimeout(() => {
      sliceSaveTimer = 0
      save()
    }, SLICE_SAVE_DEBOUNCE_MS) as unknown as number
  }
  sliceMinInput.addEventListener('change', flushSliceSave)
  sliceMaxInput.addEventListener('change', flushSliceSave)

  sliceMinInput.addEventListener('input', () => {
    let min = Number(sliceMinInput.value)
    let max = Number(sliceMaxInput.value)
    if (min > max) {
      max = min
      sliceMaxInput.value = String(max)
      sliceMaxLabel.textContent = String(max)
    }
    // The user just made an explicit choice -- from here on this is INTENT (see ViewState.
    // sliceTouched's own doc comment), not a value any future result is allowed to clamp and
    // write back over. Both sliceMinY AND sliceMaxY are captured here, not just the axis the
    // user actually dragged: sliceTouched is ONE shared flag for both (mirroring
    // GenerationConfig.originTouched's own X/Z split), so the moment it flips true, the OTHER
    // axis needs a real, finite intent value too -- `max` here is already the correct one (the
    // Max Y slider's own current, already-clamped display value), not the ±Infinity "untouched"
    // sentinel defaultView() starts it at. Skipping this would leave that sentinel as
    // view.sliceMaxY's stored "intent", which not only produces a wrong value the moment sliceMax
    // itself needs to widen, but doesn't survive persistence at all: JSON has no Infinity, so
    // save() would write it out as null and the whole touched cut would fail to restore on reload.
    view.sliceTouched = true
    view.sliceMinY = min
    view.sliceMaxY = max
    sliceMinLabel.textContent = String(min)
    applySlice(min, max)
  })
  sliceMaxInput.addEventListener('input', () => {
    let max = Number(sliceMaxInput.value)
    let min = Number(sliceMinInput.value)
    if (max < min) {
      min = max
      sliceMinInput.value = String(min)
      sliceMinLabel.textContent = String(min)
    }
    // See sliceMinInput's own listener above for why both axes are captured here too.
    view.sliceTouched = true
    view.sliceMinY = min
    view.sliceMaxY = max
    sliceMaxLabel.textContent = String(max)
    applySlice(min, max)
  })

  const sliceMinRow = h('div', 'fl-row')
  // "(cut)" disambiguates this from the Environment section's OWN "Min Y" a few sections up --
  // same label, unrelated meaning (that one is the bench floor, a generation parameter sent on
  // the wire; this one is a display-only slice of whatever the last result already contains,
  // never sent anywhere). Mirrors "Max Y (cut)" right below, which already had the suffix --
  // the reported "Min Y is changing on its own" bug named this control by a name it shared with
  // a completely different control two sections away, which likely fed the confusion as much as
  // the ratchet bug itself did (see ViewState.sliceTouched's own doc comment for that half of
  // the fix).
  const sliceMinLabelEl = h('label', 'fl-row-label', 'Min Y (cut)')
  sliceMinRow.title = 'Hides everything below this Y in the result; a display cut, not the Environment section\'s bench floor.'
  sliceMinRow.append(sliceMinLabelEl, sliceMinInput, sliceMinLabel)
  labelFor(sliceMinLabelEl, sliceMinInput)
  const sliceMaxRow = h('div', 'fl-row fl-row-primary')
  const sliceMaxLabelEl = h('label', 'fl-row-label', 'Max Y (cut)')
  sliceMaxRow.title = 'Hides everything above this Y in the result.'
  sliceMaxRow.append(sliceMaxLabelEl, sliceMaxInput, sliceMaxLabel)
  labelFor(sliceMaxLabelEl, sliceMaxInput)

  const envModeRow = h('div', 'fl-row')
  envModeRow.title = 'How the untouched terrain around the feature is drawn: solid, see-through, or not at all.'
  envModeRow.append(h('label', 'fl-row-label', 'Environment'))
  const envModeGroup = h('div', 'fl-radio-group')
  const envModeRadios: HTMLInputElement[] = []
  for (const mode of ['solid', 'ghost', 'hidden'] as const) {
    const optionLabel = h('label', 'fl-radio-option')
    const radio = h('input') as HTMLInputElement
    radio.type = 'radio'
    radio.name = 'fl-env-mode'
    radio.value = mode
    radio.checked = view.environmentMode === mode
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      setEnvironmentMode(mode)
    })
    envModeRadios.push(radio)
    optionLabel.append(radio, document.createTextNode(mode[0]?.toUpperCase() + mode.slice(1)))
    envModeGroup.append(optionLabel)
  }
  envModeRow.append(envModeGroup)

  const carvedCheckbox = checkboxInput(view.showCarved)
  carvedCheckbox.addEventListener('change', () => setShowCarved(carvedCheckbox.checked))
  const carvedRow = row('Show carved', carvedCheckbox, 'Draws the cells the feature turned to air as a translucent tinted volume.')

  const heatmapCheckbox = checkboxInput(view.showHeatmap)
  // Inert, not removed -- see dom.ts's setInert. The reason this row is inert lives in the row's
  // own title (HEATMAP_NEEDS_PROFILING), and `disabled` took the row's only reachable copy of
  // that sentence out of the tab order.
  guardInertActivation(heatmapCheckbox)
  heatmapCheckbox.addEventListener('change', () => setShowHeatmap(heatmapCheckbox.checked))
  const heatmapRow = row('Show heatmap', heatmapCheckbox, 'Colours each touched cell by how many writes hit it; needs profiling on the run that produced this result.')

  /** Enables/disables "Show heatmap" against whether the next run will actually record what it
   * needs. The heatmap has always been meaningless without profiling; the control just did not
   * say so, so turning it on looked like a toggle that did nothing. Disabled controls carry their
   * reason as their tooltip -- the panel's standing rule, applied to one more control. */
  function syncHeatmapAvailability(): void {
    setInert(heatmapCheckbox, !config.profiling)
    heatmapRow.classList.toggle('fl-row-inert', !config.profiling)
    heatmapRow.title = config.profiling
      ? 'Colours each touched cell by how many writes hit it.'
      : HEATMAP_NEEDS_PROFILING
    // The row's `title` is a tooltip on a wrapper div: not this checkbox's name, not its
    // description, and reachable by nothing but a hovering mouse. Measured, the accessible
    // description of this control while inert was "". See dom.ts's setInertReason.
    setInertReason(heatmapCheckbox, config.profiling ? '' : HEATMAP_NEEDS_PROFILING)
    syncStatChips()
  }

  // ---- the three view lenses, each with ONE setter -------------------------------------------
  // Each of these is now reachable from three places (the View row, the stat chip, and -- for the
  // environment and the grid -- the viewport overlay), so each gets exactly one function that
  // writes the state, the control, the viewer and the persisted blob. Three call sites updating
  // four things each is how a checkbox and a chip start disagreeing.
  function setShowCarved(value: boolean): void {
    view.showCarved = value
    carvedCheckbox.checked = value
    opts.viewer.setShowCarved(value)
    syncStatChips()
    save()
  }
  function setShowHeatmap(value: boolean): void {
    view.showHeatmap = value
    heatmapCheckbox.checked = value
    opts.viewer.setShowHeatmap(value)
    syncStatChips()
    save()
  }
  function setEnvironmentMode(mode: EnvironmentMode): void {
    view.environmentMode = mode
    for (const radio of envModeRadios) radio.checked = radio.value === mode
    opts.viewer.setEnvironmentMode(mode)
    syncStatChips()
    save()
  }
  function setShowGrid(value: boolean): void {
    view.showGrid = value
    gridCheckbox.checked = value
    opts.viewer.setShowGrid(value)
    save()
  }
  /** The preference is recorded whether or not it can be honoured right now: turning textures on
   * before an atlas exists has to mean "and when one does, use it", or the switch would have to
   * be found and flipped again at a moment nobody is watching for. */
  function setShowTextures(value: boolean): void {
    view.showTextures = value
    opts.viewer.setTexturesEnabled(value)
    syncTextureAvailability()
    save()
  }

  // ---- block textures ------------------------------------------------------------------------
  // THE SWITCH GOES WHERE THE PERSON LOOKING AT FLAT COLOURS IS. Textured rendering has existed
  // for a while and was reachable only from the editor's settings.json (apps/vscode's
  // featurelab.blockTextures), which is to say: not from the preview it changes. It is also the
  // single largest readability difference this preview can make -- "is that podzol or is that
  // dirt" is answerable at a glance with textures and a guess without them.
  //
  // What this row promises is deliberately narrow: "draw textures when there are any". Whether
  // there ARE any is the host's business (it fetches the atlas), so this row is inert -- and says
  // which of the two reasons it is inert for -- until one arrives. It never claims textures are
  // on when they are not, which is the specific failure the old setting had: switching it on with
  // no atlas built changed the settings file and nothing else.
  const textureCheckbox = checkboxInput(view.showTextures)
  // Inert, not removed -- see dom.ts's setInert. This is the row whose tooltip IS the
  // explanation ("No block texture atlas is available on this machine…"), and it is the exact
  // case that comment was written about.
  guardInertActivation(textureCheckbox)
  textureCheckbox.addEventListener('change', () => setShowTextures(textureCheckbox.checked))
  const textureRow = row('Block textures', textureCheckbox, 'Draws each block with its own texture instead of one flat colour.')
  /** The honest footnote: why textures are unavailable, or which blocks they could not cover.
   * One line, hidden whenever there is nothing to say. */
  const textureNote = h('div', 'fl-note fl-texture-note')
  // A STABLE id, because this div is the accessible description of the checkbox above it
  // whenever it is on screen (see syncTextureAvailability). It had none, so the one element in
  // the panel that holds "why textures are off" was unreferenceable -- the checkbox's computed
  // description was the empty string while it was inert.
  textureNote.id = 'fl-texture-note'
  textureNote.style.display = 'none'

  /** What a host has told us about its own ability to supply an atlas -- see
   * PanelHandle.setTextureStatus. Null while it has said nothing, which is not the same as
   * "unavailable": a host that simply does not implement textures should not make this panel
   * assert a reason it does not have. */
  let hostTextureStatus: { available: boolean; reason?: string } | null = null

  /** Keeps the texture row honest about three different states, and never lets the checkbox
   * claim more than the viewer is doing.
   *
   * The unresolved list is the part worth having. A block the atlas cannot answer for still
   * DRAWS -- in its flat palette colour, inside the same textured pass -- so on screen it is
   * indistinguishable from a block whose texture happens to be flat. Naming them is the
   * difference between "textures are on" and "textures are on, and these four are not textured",
   * which is exactly the question somebody asks when one block in their feature looks wrong. */
  function syncTextureAvailability(): void {
    const report = opts.viewer.getTextureReport()
    const available = report.hasAtlas
    setInert(textureCheckbox, !available)
    // ONE STATE, REPORTED THE SAME WAY IN BOTH PLACES. This used to fall back to the stored
    // PREFERENCE (`view.showTextures`) when no atlas existed, while the viewport's own Textures
    // button reported what is actually being DRAWN -- so with the preference on and no atlas,
    // the sidebar checkbox read checked=true and the toolbar button read pressed=false for one
    // and the same state, which is a contradiction a screen reader hears as two answers. Both
    // now report the drawing. The preference itself is not lost (setShowTextures still records
    // it, and this checkbox ticks itself the moment an atlas makes it true); what it no longer
    // does is claim textures are on when nothing is textured.
    textureCheckbox.checked = report.enabled
    textureRow.classList.toggle('fl-row-inert', !available)
    /** Why the checkbox is inert: the host's own sentence when it gave one, else this panel's
     * neutral wording. Named, because it is now needed in three places -- the row's tooltip,
     * the visible note, and the checkbox's accessible description -- and three copies of one
     * sentence is how two of them come to disagree. */
    const unavailableReason = hostTextureStatus?.reason ?? 'No block texture atlas is available on this machine, so the preview draws one flat colour per block.'
    textureRow.title = available
      ? report.enabled
        ? 'Each block is drawn with its own texture. Turn off for one flat colour per block.'
        : 'One flat colour per block. Turn on to draw the pack’s block textures.'
      : unavailableReason

    const unresolved = report.unresolved
    if (report.enabled && unresolved.length > 0) {
      const shown = unresolved.slice(0, 3).join(', ')
      const more = unresolved.length - Math.min(3, unresolved.length)
      textureNote.textContent = `${unresolved.length.toLocaleString('en-US')} of ${report.blocks.toLocaleString('en-US')} blocks have no texture in the atlas: ${shown}${more > 0 ? `, +${String(more)} more` : ''}`
      textureNote.title = 'These blocks are drawn in their flat palette colour even with textures on — the atlas has no image for them (a pack block, or a texture the atlas builder could not resolve). Everything else in this run is textured.'
      textureNote.style.display = ''
    } else if (!available) {
      // WAS `!available && hostTextureStatus?.reason`: a host that implements no textures at all
      // says nothing, so this branch did not fire, so the note stayed display:none -- and the
      // checkbox beside it was inert with its explanation nowhere on the page. The panel's own
      // neutral wording is exactly what that case is for.
      textureNote.textContent = unavailableReason
      textureNote.removeAttribute('title')
      textureNote.style.display = ''
    } else {
      textureNote.textContent = ''
      textureNote.style.display = 'none'
    }
    // Described FROM the visible note when there is one (no second, hidden copy for an AT to
    // read out twice); from a hidden span only if the note is not rendered. See setInertReason.
    setInertReason(textureCheckbox, available ? '' : unavailableReason, textureNote)
  }

  const overflowCheckbox = checkboxInput(view.showOverflow)
  overflowCheckbox.addEventListener('change', () => {
    view.showOverflow = overflowCheckbox.checked
    opts.viewer.setShowOverflow(view.showOverflow)
    save()
  })
  const overflowViewRow = row('Show overflow', overflowCheckbox, 'Draws the writes that landed outside the bench in magenta; showing them changes nothing about the run.')

  const gridCheckbox = checkboxInput(view.showGrid)
  gridCheckbox.addEventListener('change', () => setShowGrid(gridCheckbox.checked))

  // Two framing controls that DIFFER. "Frame feature" fits the cells this run actually touched;
  // "Frame bench" fits the whole box. They used to be the same picture whenever the environment
  // was solid -- which is the default -- because "what is occupied" included every terrain cell,
  // so a 53-block feature was framed as a postage stamp in the middle of the bench and the two
  // buttons only diverged once the terrain was hidden, which is exactly what the first button's
  // own tooltip promised as their distinction. See VoxelViewer.frameContent.
  const frameButton = h('button', 'fl-wide-btn', 'Frame feature  (R)') as HTMLButtonElement
  frameButton.type = 'button'
  frameButton.title = 'Fits the camera to the cells this run placed, carved or overwrote, respecting the Y cut. Falls back to the visible terrain when this run touched nothing.'
  frameButton.addEventListener('click', () => opts.viewer.frameContent())

  const frameVolumeButton = h('button', 'fl-wide-btn', 'Frame bench  (Shift+R)') as HTMLButtonElement
  frameVolumeButton.type = 'button'
  frameVolumeButton.title = 'Fits the camera to the whole bench, air included — where the feature sits in the volume it was given.'
  frameVolumeButton.addEventListener('click', () => opts.viewer.frameAll())

  viewBody.append(sliceMinRow, sliceMaxRow, envModeRow, textureRow, textureNote, carvedRow, heatmapRow, overflowViewRow, row('Show grid', gridCheckbox, 'Draws the bench\'s outline and floor grid.'), frameButton, frameVolumeButton)

  // ==========================================================================================
  // ---- Diagnostics section -------------------------------------------------------------------
  // ==========================================================================================
  const { section: diagSection, body: diagBody, header: diagHeader } = section('diagnostics', 'Diagnostics')
  const MAX_LISTED_DIAGNOSTICS = 300

  /** What `renderDiagnostics` just drew, so another part of the panel can send a reader to ONE
   * of these rows rather than to the section and a scroll. Rebuilt on every render; `expand`
   * un-clamps a row whose text is behind a "Show more" disclosure, because arriving at a
   * diagnostic still truncated is arriving nowhere. */
  let diagItems: { diag: DecodedDiagnostic; item: HTMLElement; expand: () => void }[] = []

  /** Opens the Diagnostics section at `target` -- the empty-result line's "see Diagnostics (N)"
   * control (see `renderEmptyResult`).
   *
   * Scrolling is guarded because jsdom implements no layout and therefore no `scrollIntoView`;
   * everything this does that a test can observe (the section expanded, the row marked, its text
   * un-clamped) happens before the scroll either way. */
  function revealDiagnostic(target: DecodedDiagnostic | null): void {
    if (diagSection.classList.contains('fl-collapsed')) {
      diagSection.classList.remove('fl-collapsed')
      diagHeader.setAttribute('aria-expanded', 'true')
      collapsedSections.delete('diagnostics')
      save()
    }
    for (const entry of diagItems) entry.item.classList.remove('fl-diag-revealed')
    const hit = diagItems.find((e) => e.diag === target) ?? diagItems[0]
    const scrollTo = hit?.item ?? diagSection
    if (hit) {
      hit.expand()
      hit.item.classList.add('fl-diag-revealed')
    }
    if (typeof scrollTo.scrollIntoView === 'function') scrollTo.scrollIntoView({ block: 'nearest' })
  }

  /** True when `identifier` names a features/*.json entry the last result actually loaded --
   * the one case a chain segment (or the diagnostic's own leading identifier) can reliably be
   * made clickable in the Feature picker. Chain segments are frequently RULE identifiers
   * (e.g. a rule delegating into the feature that actually failed), which have no Feature-picker
   * counterpart at all -- rather than half-wire a click that sometimes silently does nothing,
   * only identifiers this check confirms selectable ever render as a button; everything else
   * renders as plain text (see `chainSegment` below). */
  function isSelectableFeature(identifier: string): boolean {
    return (lastResult?.entries ?? []).some((e) => e.identifier === identifier)
  }

  /** Selects `identifier` in the Feature picker exactly as if the user had picked it from the
   * dropdown themselves -- switches to feature mode if needed, clears any active list filter so
   * the identifier is guaranteed present among the (freshly rebuilt) options, and fires a fresh
   * generate request. Only ever called for an identifier `isSelectableFeature` already
   * confirmed present, so the dropdown assignment below always finds a real option. */
  function selectFeatureFromChain(identifier: string): void {
    if (config.mode !== 'feature') {
      config.mode = 'feature'
      updateModeVisibility()
    }
    listFilter = ''
    filterInput.value = ''
    config.featureIdentifier = identifier
    renderListOptions()
    featureSelect.value = identifier
    updateFeatureInfo()
    notifyConfigChanged()
  }

  /** One chain/heading segment: a clickable button when `isSelectableFeature(identifier)`,
   * otherwise plain (but identically styled) text -- see `isSelectableFeature`'s own doc
   * comment for why only some segments can reliably be made clickable. */
  function chainSegment(identifier: string, isLast: boolean): HTMLElement {
    const cls = `fl-diag-chain-seg${isLast ? ' fl-diag-chain-last' : ''}`
    if (isSelectableFeature(identifier)) {
      const btn = h('button', `${cls} fl-diag-chain-link`) as HTMLButtonElement
      btn.type = 'button'
      btn.textContent = identifier
      btn.title = `Select "${identifier}" in the Feature picker and regenerate`
      btn.addEventListener('click', () => selectFeatureFromChain(identifier))
      return btn
    }
    return h('span', cls, identifier)
  }

  function renderDiagnostics(diagnostics: readonly DecodedDiagnostic[]): void {
    const errorCount = diagnostics.filter((d) => d.level === 'error').length
    const warningCount = diagnostics.length - errorCount
    const titleText = diagHeader.querySelector('.fl-section-title-text')!
    titleText.textContent = diagnostics.length === 0 ? 'Diagnostics' : `Diagnostics  (${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'})`
    diagHeader.classList.toggle('fl-section-header-error', errorCount > 0)
    diagHeader.classList.toggle('fl-section-header-warning', errorCount === 0 && warningCount > 0)

    diagBody.textContent = ''
    diagItems = []
    if (lastError) {
      diagBody.append(h('div', 'fl-diag-item fl-diag-error', `generation failed: ${lastError}`))
    }
    if (diagnostics.length === 0) {
      if (!lastError) diagBody.append(h('div', 'fl-diag-empty', 'No diagnostics.'))
      return
    }
    const sorted = [...diagnostics].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
    for (const d of sorted.slice(0, MAX_LISTED_DIAGNOSTICS)) {
      const item = h('div', `fl-diag-item fl-diag-${d.level}`)
      item.append(h('span', 'fl-diag-icon', d.level === 'error' ? '\u2716' : '\u26a0'))

      const body = h('div', 'fl-diag-body')

      // The failing feature's own identifier/type, prominently -- the fix for this repo's Task
      // 2: this used to show the RUN feature's identifier/type here, which named the wrong
      // feature whenever the actual failure happened inside a nested delegation.
      const heading = h('div', 'fl-diag-heading')
      heading.append(chainSegment(d.identifier, true))
      if (d.typeId) heading.append(h('span', 'fl-diag-type', d.typeId))
      if (d.count > 1) heading.append(h('span', 'fl-diag-count', `\u00d7${d.count.toLocaleString('en-US')}`))
      // Suppress fileId only when it's textually identical to the identifier already shown
      // above (an engine-level diagnostic with no real "file" of its own -- e.g. session/
      // unresolved.go's "not defined by the loaded pack" sets FileID to the identifier itself,
      // since there is no file to point at) -- showing the same string twice back to back, with
      // nothing between them, is pure noise: the user reads the same identifier twice before
      // reaching anything informative. A diagnostic that
      // genuinely comes from a DIFFERENT file than the feature it's about (the ordinary case --
      // a delegation failure surfaced on the run feature's own identifier but reported from the
      // file that actually failed) still shows both: that distinction is real information, not
      // redundancy, so this must never drop fileId unconditionally.
      if (d.fileId !== d.identifier) heading.append(h('span', 'fl-diag-file', d.fileId))
      body.append(heading)

      // Root-first path down to the identifier above -- only worth its own row once there's
      // actually a delegation chain to show (a direct failure's chain is just [identifier],
      // already shown in the heading).
      if (d.chain.length > 1) {
        const chainEl = h('div', 'fl-diag-chain')
        d.chain.forEach((id, i) => {
          if (i > 0) chainEl.append(h('span', 'fl-diag-chain-sep', '\u203a'))
          chainEl.append(chainSegment(id, i === d.chain.length - 1))
        })
        body.append(chainEl)
      }

      // Click-to-locate: moves the camera to this world cell and
      // highlights it in the preview -- see viewer.ts's highlightCell(). Absent
      // (position === null) whenever the diagnostic isn't tied to one cell; {0,0,0} is a real,
      // clickable coordinate, never treated as "no position" (see DiagnosticPositionWire).
      if (d.position) {
        const pos = d.position
        const posBtn = h('button', 'fl-diag-position') as HTMLButtonElement
        posBtn.type = 'button'
        posBtn.textContent = `\u2316 (${pos.x}, ${pos.y}, ${pos.z})`
        posBtn.title = 'Move the camera to this cell and highlight it'
        posBtn.addEventListener('click', () => opts.viewer.highlightCell(pos.x, pos.y, pos.z))
        body.append(posBtn)
      }

      // ONE LINE, with a disclosure. Engine diagnostics are prose written for a log -- several
      // sentences, sometimes a whole paragraph -- and rendering every one of them in full turned
      // a list of five problems into a wall nobody scrolls. Clamped to a line, the LIST is
      // readable (which is what a count in the header promises), and the full text is one click
      // away on the one that matters. The count stays in the section header either way.
      const text = h('div', 'fl-diag-text fl-diag-text-clamped', d.message)
      body.append(text)
      // Un-clamping this row from outside the section -- see `revealDiagnostic`. A row with no
      // disclosure is already whole, so its `expand` is a no-op rather than a special case at
      // every call site.
      let expand = (): void => {}
      if (isLongDiagnostic(d.message)) {
        const more = h('button', 'fl-diag-more', 'Show more') as HTMLButtonElement
        more.type = 'button'
        more.setAttribute('aria-expanded', 'false')
        more.title = 'Show the full text of this diagnostic'
        const setClamped = (clamped: boolean): void => {
          text.classList.toggle('fl-diag-text-clamped', clamped)
          more.textContent = clamped ? 'Show more' : 'Show less'
          more.setAttribute('aria-expanded', String(!clamped))
        }
        more.addEventListener('click', () => setClamped(!text.classList.contains('fl-diag-text-clamped')))
        expand = () => setClamped(false)
        body.append(more)
      }
      diagItems.push({ diag: d, item, expand })

      // One-click budget fix: without it, "the diagnostic says which budget and at what count, but
      // the user must then scroll to the Budget section and type a number" -- recognized here
      // by message shape (parseBudgetDiagnostic), not by a dedicated wire field, since the wire
      // has no such field (see that function's own doc comment for the exact messages this
      // matches). Doubling the RUN's own effective budget (not whatever GenerationConfig
      // currently holds, which could be null) is what "doubles the budget in question" means
      // when the user had never touched that field at all -- see applyBudgetQuickFix.
      const budgetHit = parseBudgetDiagnostic(d.message)
      if (budgetHit) {
        const newValue = budgetHit.effective * 2
        const fixBtn = h('button', 'fl-diag-budget-fix') as HTMLButtonElement
        fixBtn.type = 'button'
        fixBtn.textContent = `⚡ Double ${budgetHit.label} to ${newValue.toLocaleString('en-US')}${budgetHit.unit} & regenerate`
        fixBtn.title = `Sets ${budgetHit.label} to ${newValue.toLocaleString('en-US')}${budgetHit.unit} (this run hit ${budgetHit.effective.toLocaleString('en-US')}${budgetHit.unit}) and regenerates.`
        fixBtn.addEventListener('click', () => applyBudgetQuickFix(budgetHit.kind, newValue))
        body.append(fixBtn)
      }

      item.append(body)
      diagBody.append(item)
    }
    if (sorted.length > MAX_LISTED_DIAGNOSTICS) {
      diagBody.append(h('div', 'fl-diag-item', `... and ${sorted.length - MAX_LISTED_DIAGNOSTICS} more`))
    }
  }

  // ==========================================================================================
  // ---- Profiler section (unchanged behaviour from before this port) -------------------------
  // ==========================================================================================
  const { section: profilerSection, body: profilerBody } = section('profiler', 'Profiler')

  const profilingCheckbox = checkboxInput(config.profiling)
  profilingCheckbox.addEventListener('change', () => {
    config.profiling = profilingCheckbox.checked
    notifyConfigChanged()
    renderProfilerSection()
    syncHeatmapAvailability()
  })
  profilerBody.append(row('Enable profiling', profilingCheckbox, 'Records per-cell write counts and per-feature cost on the next run; off by default because it adds overhead.'))

  const profileSummaryEl = h('div', 'fl-profiler-summary')
  const profileTableEl = h('div', 'fl-profiler-table')
  profilerBody.append(profileSummaryEl, profileTableEl)

  type ProfileSortKey = 'identifier' | 'typeId' | 'entered' | 'blocksWritten' | 'delegations' | 'selfMs' | 'inclusiveMs'
  const PROFILE_COLUMNS: { key: ProfileSortKey; label: string; numeric?: boolean }[] = [
    { key: 'identifier', label: 'Feature' },
    { key: 'typeId', label: 'Type' },
    { key: 'entered', label: 'Entered', numeric: true },
    { key: 'blocksWritten', label: 'Blocks', numeric: true },
    { key: 'delegations', label: 'Delegations', numeric: true },
    { key: 'selfMs', label: 'Self ms', numeric: true },
    { key: 'inclusiveMs', label: 'Incl. ms', numeric: true },
  ]
  let profileSortKey: ProfileSortKey = 'inclusiveMs'
  let profileSortDir: 1 | -1 = -1
  let lastProfile: DecodedResult['profile'] = null

  function renderProfilerSection(): void {
    const profile = lastProfile
    // Empty states are one line each; how to fill the table is the checkbox's tooltip and the
    // Profiler `?`.
    if (!config.profiling) {
      profileSummaryEl.textContent = 'Profiling is off.'
      profileTableEl.textContent = ''
      return
    }
    if (!profile || profile.features.length === 0) {
      profileSummaryEl.textContent = 'No profile data yet — regenerate.'
      profileTableEl.textContent = ''
      return
    }

    let touchedCells = 0
    let maxTouch = 0
    for (const c of profile.touchCounts) {
      if (c > 0) touchedCells++
      if (c > maxTouch) maxTouch = c
    }
    profileSummaryEl.textContent = `${profile.features.length} feature(s) entered  \u00b7  ${touchedCells.toLocaleString()} cell(s) touched  \u00b7  max touches on one cell: ${maxTouch.toLocaleString()}`

    const rows: FeatureProfileStatsWire[] = [...profile.features].sort((a, b) => {
      const av = a[profileSortKey]
      const bv = b[profileSortKey]
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return cmp * profileSortDir
    })

    profileTableEl.textContent = ''
    const header = h('div', 'fl-profiler-row fl-profiler-header')
    for (const col of PROFILE_COLUMNS) {
      const cell = h('button', `fl-profiler-cell fl-profiler-head-cell${col.numeric ? ' fl-profiler-numeric' : ''}`) as HTMLButtonElement
      cell.type = 'button'
      const active = profileSortKey === col.key
      cell.textContent = active ? `${col.label} ${profileSortDir === -1 ? '\u25be' : '\u25b4'}` : col.label
      cell.classList.toggle('fl-profiler-head-active', active)
      cell.addEventListener('click', () => {
        if (profileSortKey === col.key) profileSortDir = profileSortDir === -1 ? 1 : -1
        else {
          profileSortKey = col.key
          profileSortDir = col.numeric ? -1 : 1
        }
        renderProfilerSection()
      })
      header.append(cell)
    }
    profileTableEl.append(header)

    for (const stat of rows) {
      const r = h('div', 'fl-profiler-row')
      r.append(
        h('span', 'fl-profiler-cell fl-profiler-identifier', stat.identifier),
        h('span', 'fl-profiler-cell', stat.typeId),
        h('span', 'fl-profiler-cell fl-profiler-numeric', stat.entered.toLocaleString()),
        h('span', 'fl-profiler-cell fl-profiler-numeric', stat.blocksWritten.toLocaleString()),
        h('span', 'fl-profiler-cell fl-profiler-numeric', stat.delegations.toLocaleString()),
        h('span', 'fl-profiler-cell fl-profiler-numeric', stat.selfMs.toFixed(1)),
        h('span', 'fl-profiler-cell fl-profiler-numeric', stat.inclusiveMs.toFixed(1)),
      )
      profileTableEl.append(r)
    }
  }
  renderProfilerSection()

  // ---- assemble sidebar ---------------------------------------------------------------------
  root.append(featureSection, envSection, materialsSection, biomeSection, budgetSection, viewSection, diagSection, profilerSection)

  // Now that every control updateModeVisibility/renderListOptions touches exists, sync initial
  // visibility to the restored config (persisted state can restore mode: 'rule' directly, not
  // just via the radio click).
  updateModeVisibility()
  updateFeatureInfo()
  updateRuleInfo()
  renderEnvironmentOptions()
  renderBiomeOptions()

  // ---- keyboard shortcut: Ctrl+Enter, and ONLY Ctrl+Enter.
  //
  // This listener used to also handle 'r'/'R' for the two framing actions -- which VoxelViewer's
  // own handleKeyDown already handles, on `window`, for the same keystroke. A keydown on the
  // document bubbles to the window, so both fired: every press of R framed the view twice. The
  // viewer owns the camera and therefore owns its keys; what is left here is the one shortcut
  // that belongs to the sidebar, because what it re-runs is the sidebar's own state.
  document.addEventListener('keydown', (ev) => {
    // Checked BEFORE any input guard, deliberately: "run what I just typed" is the one shortcut
    // whose whole purpose is to be usable from inside the field being typed into.
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault()
      regenerate()
    }
  })

  // apply restored view state to the viewer immediately, before any data exists
  opts.viewer.setEnvironmentMode(view.environmentMode)
  opts.viewer.setShowGrid(view.showGrid)
  opts.viewer.setShowCarved(view.showCarved)
  opts.viewer.setShowHeatmap(view.showHeatmap)
  opts.viewer.setShowOverflow(view.showOverflow)
  // Harmless before an atlas exists (the viewer simply records the request and keeps drawing flat
  // colours), and the whole point of recording it: the moment a host delivers one, onTexturesChanged
  // below re-applies this preference rather than the host having to decide on the user's behalf.
  opts.viewer.setTexturesEnabled(view.showTextures)
  opts.viewer.setSlice(view.sliceMinY, view.sliceMaxY)

  // The on-canvas overlay and the sidebar are two affordances for one set of settings, so each
  // has to follow the other. This is the overlay -> sidebar direction; every setter above is the
  // other one (they all call into the viewer, which re-syncs the overlay itself).
  opts.viewer.onViewChange = (state) => {
    if (state.environmentMode !== view.environmentMode) {
      view.environmentMode = state.environmentMode
      for (const radio of envModeRadios) radio.checked = radio.value === state.environmentMode
    }
    if (state.showGrid !== view.showGrid) {
      view.showGrid = state.showGrid
      gridCheckbox.checked = state.showGrid
    }
    syncStatChips()
    save()
  }
  // An atlas arriving (or failing to) is a change in what this row can honestly offer, and it
  // happens asynchronously, long after this panel was built. Re-applying the remembered
  // preference here is what makes "textures when there are any" true without the host having to
  // know the preference exists.
  opts.viewer.onTexturesChanged = () => {
    if (view.showTextures !== opts.viewer.getTexturesEnabled() && opts.viewer.getTextureReport().hasAtlas) {
      opts.viewer.setTexturesEnabled(view.showTextures)
      return // the call above re-enters this handler, which then syncs the row
    }
    syncTextureAvailability()
  }
  // Click-to-identify, always armed -- see pickedEl.
  opts.viewer.onPick = (pick) => showPickedCell(pick)
  // Cancel exists on the pill only for a host that can actually stop a run -- see
  // PanelOptions.onCancel.
  opts.viewer.setCancelHandler(opts.onCancel ? () => opts.onCancel?.() : null)

  syncHeatmapAvailability()
  syncStatChips()
  syncTextureAvailability()
  renderDiagnostics([])

  return {
    setResult(result: DecodedResult): void {
      // Safety net (see applyBusy's own doc comment) -- a fresh result always means "no longer
      // pending", whether or not the host also called setBusy(false) itself.
      applyBusy(false)
      errorBanner.style.display = 'none'
      // A result IS the engine answering, so nothing about this preview is stale any more --
      // including the viewport notice that said so (see setStale/syncViewportNotice). Hosts do
      // post stale:false at the start of every regenerate, but a notice claiming the picture is
      // out of date, sitting on the picture that just replaced it, is not a thing to leave to a
      // message ordering this file does not control.
      staleBanner.style.display = 'none'
      staleReason = null
      lastResult = result
      lastError = null
      resolvedOriginY = result.origin.y

      // Drop a selected biome the freshly-loaded pack does not actually define, rather than
      // keeping it selected and letting every later request fail with "biome id X is not
      // defined by any loaded biome file". The cross-session case this originally guarded is
      // gone (biomeId no longer survives a panel at all -- see PersistedState), but the
      // in-session one is not: the id came from THIS session's own biomeEntries, and "Reload
      // files" after renaming or deleting that biome file leaves the selection pointing at
      // something the pack no longer has.
      //
      // This has to happen here rather than at selection time: a result is the only thing that
      // ever tells us which ids exist, so the request that reloaded the pack is also the one
      // that reveals the id is gone. It is corrected before any subsequent request, and
      // silently, because the file the user picked from simply stopped existing -- there is
      // nothing for them to act on beyond picking again.
      if (config.biomeId && !result.biomeEntries.some((e) => e.identifier === config.biomeId)) {
        config.biomeId = ''
        save()
      }

      const { volume } = result
      const worldMinY = volume.minY
      const worldMaxY = volume.minY + volume.sizeY - 1

      // Slice restore -- see ViewState.sliceTouched's own doc comment for the full "why" this
      // replaced a `sliderRangeInitialized`-gated read of the SLIDER'S OWN (already-clamped)
      // value: that read back an artefact of a PREVIOUS clamp, so once the bench narrowed once,
      // the cut could never widen back out again even after a later, taller result arrived.
      // While untouched, intent is simply "the whole of whatever just arrived" -- no cut.
      const intentMin = view.sliceTouched ? view.sliceMinY : worldMinY
      const intentMax = view.sliceTouched ? view.sliceMaxY : worldMaxY

      sliceMinInput.min = String(worldMinY)
      sliceMinInput.max = String(worldMaxY)
      sliceMaxInput.min = String(worldMinY)
      sliceMaxInput.max = String(worldMaxY)

      // Clamped ONLY for what gets DISPLAYED/sent to the viewer this call -- intent itself
      // (view.sliceMinY/sliceMaxY) is only ever written below while sliceTouched, and even then
      // verbatim, never as this clamped value. That's what lets a later, wider result recover
      // the original cut instead of the narrower one a clamp in between would otherwise have
      // permanently baked in.
      const displayMin = Math.min(Math.max(intentMin, worldMinY), worldMaxY)
      const displayMax = Math.min(Math.max(intentMax, worldMinY), worldMaxY)
      sliceMinInput.value = String(displayMin)
      sliceMaxInput.value = String(displayMax)
      sliceMinLabel.textContent = String(displayMin)
      sliceMaxLabel.textContent = String(displayMax)
      if (view.sliceTouched) {
        view.sliceMinY = intentMin
        view.sliceMaxY = intentMax
      }

      opts.viewer.setVolume(volume, result.palette)
      opts.viewer.setSlice(displayMin, displayMax)

      // A fresh run re-interns cell indices and may well not contain the block that was picked
      // at all, so last run's identification is not this run's -- and the viewer's own marker is
      // left alone deliberately, since it may equally be a diagnostic's (see viewer.onPick).
      clearPickedCell()
      renderCounts(result.counts, result.placementDurationMs, result.libraryBuildDurationMs, result.partial)
      renderEmptyResult(result)
      syncViewportNotice()
      syncTextureAvailability()
      renderOverflowBanner(result)
      renderGrownBanner()
      renderDiagnostics(result.diagnostics)
      lastProfile = result.profile
      renderProfilerSection()

      renderListOptions()
      updateFeatureInfo()
      updateRuleInfo()
      // Biome materials/tags prefill can change with a fresh result even when config itself
      // didn't (biomeEntries is per-pack-load data, and the resolved surfaceBuilder for the
      // currently-selected pack biome, if any, could not be shown accurately before this
      // arrived) -- see getSelectedBiome's own doc comment for why this is looked up fresh
      // rather than cached.
      renderBiomeOptions()
      syncMaterialInputs()
      syncBiomeInputs()
      // Everything above may have rewritten an input this module also watches for uncommitted
      // edits -- a value THIS file just wrote is committed by definition, and leaving it marked
      // would be the marker crying wolf.
      resyncCommitted()
      syncHeatmapAvailability()
      save()
    },
    setError(message: string | null): void {
      lastError = message
      if (message === null) {
        errorBanner.style.display = 'none'
      } else {
        // Safety net (see applyBusy's own doc comment): a failed request is done, whether or
        // not the host's own catch/finally also called setBusy(false) -- the error banner must
        // always win over a lingering "Generating…" state, never race it.
        applyBusy(false)
        // A failed run has no counts, so the "placed nothing" line would be describing the
        // PREVIOUS result while the banner above it describes this one. The promoted copy of
        // that line goes with it, for the same reason.
        emptyResultEl.style.display = 'none'
        promotedAnswer = null
        opts.viewer.setNotice(null)
        errorBanner.textContent = `generation failed: ${message}`
        errorBanner.style.display = ''
      }
      renderDiagnostics(lastResult?.diagnostics ?? [])
    },
    setStale(stale: boolean, reason?: string): void {
      if (!stale) {
        staleBanner.style.display = 'none'
        staleReason = null
        syncViewportNotice()
        return
      }
      // Safety net (see applyBusy's own doc comment): the engine is confirmed not-good (crashed,
      // timed out, still starting), so whatever request was in flight is done, whether or not
      // the host's own catch/finally also called setBusy(false) -- the stale banner must always
      // win over a lingering "Generating…" state. Deliberately NOT mirrored for stale===false
      // above: a host posts that at the START of every regenerate too (clearing a PREVIOUS
      // stale banner before a new attempt), which must not be mistaken for "this request just
      // finished".
      applyBusy(false)
      staleBanner.textContent = reason ?? 'The featurelab engine process is not responding. This preview may be out of date.'
      staleBanner.style.display = ''
      // The same sentence, onto the view it is about -- see syncViewportNotice.
      staleReason = staleBanner.textContent
      syncViewportNotice()
    },
    setBusy(v: boolean): void {
      applyBusy(v)
    },
    seedOpenedDocument(kind: Mode, identifier: string): void {
      // ALWAYS wins over whatever was restored/default -- see this method's own PanelHandle doc
      // comment for the bug this fixes (a stale cross-file selection surviving in localStorage).
      config.mode = kind
      if (kind === 'feature') config.featureIdentifier = identifier
      else config.ruleIdentifier = identifier
      updateModeVisibility()

      const select = kind === 'feature' ? featureSelect : ruleSelect
      select.value = identifier
      if (select.value !== identifier) {
        // Not in the (possibly still-empty, or genuinely pack-mismatched) options list -- add a
        // placeholder option so the dropdown shows the OPENED identifier rather than either an
        // empty selection or, worse, silently leaving whatever was selected before this call.
        // renderListOptions (called from setResult once a real result arrives) replaces this
        // with the real option if one exists.
        const opt = document.createElement('option')
        opt.value = identifier
        opt.textContent = identifier
        select.append(opt)
        select.value = identifier
      }
      updateFeatureInfo()
      updateRuleInfo()
      save()
    },
    setEnvironments(list: EnvironmentOptionWire[]): void {
      environments = list
      renderEnvironmentOptions()
      // The bootstrap size/minY defaultConfig() shows before this arrives are a hardcoded
      // literal (see that function's own comment) -- once the real list is in and the user
      // hasn't touched anything yet, resync to the genuine engine-reported default for
      // whichever preset is (still) selected, same "never send a value the user hasn't
      // touched, but never show a stale one either" posture size/minY already have. Gated on
      // nothing having happened yet -- no result, and no hand-edit of those four inputs (see
      // sizeTouched) -- so a value the user typed while this list was still in flight is never
      // clobbered by it landing.
      if (lastResult === null && !sizeTouched) {
        const preset = getEnvironment(config.env)
        if (preset) {
          config.sizeX = preset.defaults.sizeX
          config.sizeY = preset.defaults.sizeY
          config.sizeZ = preset.defaults.sizeZ
          config.minY = preset.defaults.minY
          sizeXInput.value = String(config.sizeX)
          sizeYInput.value = String(config.sizeY)
          sizeZInput.value = String(config.sizeZ)
          minYInput.value = String(config.minY)
        }
      }
      resyncCommitted()
      syncMaterialInputs()
      syncBiomeInputs()
    },
    setTimeoutInfo(info: { configuredMs: number; effectiveMs: number } | null): void {
      if (!info || info.effectiveMs <= info.configuredMs) {
        timeoutInfoEl.style.display = 'none'
        return
      }
      timeoutInfoEl.textContent = `Extension wait raised to ${info.effectiveMs.toLocaleString('en-US')} ms (featurelab.requestTimeoutMs: ${info.configuredMs.toLocaleString('en-US')} ms)`
      timeoutInfoEl.style.display = ''
    },
    getGenerateParams(): GenerateParamsWire | null {
      return buildGenerateParams()
    },
    setTextureStatus(status: { available: boolean; reason?: string } | null): void {
      hostTextureStatus = status
      syncTextureAvailability()
    },
  }
}
