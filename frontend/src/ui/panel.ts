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
import type { EnvironmentMode, VoxelViewer } from '../viewer.js'
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
  RuleEntryWire,
} from '../protocol.js'
import { ENGINE_DEFAULT_DELEGATION_BUDGET, ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS, ENGINE_DEFAULT_WRITE_BUDGET } from '../protocol.js'
import { checkboxInput, clamp, h, iconButton, makeSection, numberInput, optionalNumberInput, readFloat, readInt, readOptionalInt, row, textInput } from './dom.js'
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
   * something is happening) -- a busyBanner row, a dimmed/pulsing look on the stat tiles, and the same on
   * the 3D preview itself (VoxelViewer.setBusy). A host is expected to call `setBusy(true)`
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
  }
  if (view.environmentMode !== 'solid' && view.environmentMode !== 'ghost' && view.environmentMode !== 'hidden') view.environmentMode = 'solid'

  const collapsedSections = new Set<string>(persisted?.collapsed ?? [])

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
    const params = buildGenerateParams()
    if (!params) return
    if (view.growSticky && opts.onGrowRegenerate) opts.onGrowRegenerate(params)
    else opts.onConfigChange?.(params)
  }

  root.textContent = ''
  root.classList.add('fl-panel')

  // ---- always-visible banners (never inside a collapsible section) ------------------------
  const staleBanner = h('div', 'fl-banner fl-banner-stale')
  staleBanner.style.display = 'none'
  const errorBanner = h('div', 'fl-banner fl-banner-error')
  errorBanner.style.display = 'none'
  // In-flight indicator (never "no indication that anything is happening") -- see setBusy/
  // applyBusy below for the full contract. Ordered before staleBanner/errorBanner are RENDERED
  // (i.e. appears above them) but those two still win visually whenever both would show at
  // once, since applyBusy(false) always fires as part of setError/setStale(true) -- see those
  // methods' own comments for why a busy indicator can never outlive the banner that explains
  // what actually happened.
  const busyBanner = h('div', 'fl-banner fl-banner-busy', 'Generating…')
  busyBanner.style.display = 'none'
  root.append(staleBanner, errorBanner, busyBanner)

  // ---- always-visible counts readout (the main result, so it is kept prominent) ------------
  // ------------------------------------------------------------------------------------------
  const countsSection = h('div', 'fl-readout')
  const placedTile = h('div', 'fl-stat fl-stat-placed')
  const carvedTile = h('div', 'fl-stat fl-stat-carved')
  const replacedTile = h('div', 'fl-stat fl-stat-replaced')
  for (const [tile, label] of [
    [placedTile, 'placed'],
    [carvedTile, 'carved'],
    [replacedTile, 'replaced'],
  ] as const) {
    tile.append(h('div', 'fl-stat-value', '0'), h('div', 'fl-stat-label', label))
  }
  countsSection.append(placedTile, carvedTile, replacedTile)
  const partialBadge = h('div', 'fl-badge-partial', 'PARTIAL RESULT — cut off by budget/time limit')
  partialBadge.style.display = 'none'
  const durationEl = h('div', 'fl-duration')
  const buildDurationEl = h('div', 'fl-duration fl-duration-secondary')
  buildDurationEl.style.display = 'none'

  /** Single point of truth for the "request in flight" visual state. Drives three
   * things at once: the busyBanner text row, a dimmed/pulsing look on the stat tiles
   * (.fl-readout-busy, panel.css), and the 3D preview itself (VoxelViewer.setBusy, so "the stat
   * tiles and preview should read as pending" covers both halves of the sidebar's own readout
   * and the canvas a host lays out beside it).
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
    busyBanner.style.display = v ? '' : 'none'
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
  const grownBanner = h('div', 'fl-banner fl-banner-grown')
  grownBanner.style.display = 'none'

  root.append(countsSection, partialBadge, durationEl, buildDurationEl, growStickyRow, overflowBanner, grownBanner)

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
  // The standing fact about every grown run, as the banner's tooltip rather than its text: the
  // text is only ever about this run.
  grownBanner.title = 'A grown run is a different placement (different reads, possibly different RNG draws), not the same result seen wider.'

  /** Reads `lastResult` from the enclosing closure (rather than taking one as a parameter) so
   * both setResult (a fresh result just arrived) and the sticky checkbox's own 'change' handler
   * (no new result yet, possibly none at all) can call this the same way -- see this function's
   * own two callers. */
  function renderGrownBanner(): void {
    const result = lastResult
    if (view.growSticky) {
      // Sticky: visible unconditionally while the mode is on (see
      // grownBanner's declaration above) -- one line that still distinguishes "this particular
      // run needed growing" from "it didn't", since those remain two different facts even
      // though the mode itself never turns off between them.
      grownBanner.textContent =
        result?.grown && result.preGrowBounds
          ? `Grow every run: on · grown ${GROWN_SIZES(result.preGrowBounds, result.volume)} this run`
          : `Grow every run: on · ${result ? 'no growth needed this run' : 'waiting for the next run…'}`
      grownBanner.style.display = ''
      return
    }
    // Not sticky: the original, single-result-only behaviour -- visible only while the CURRENT
    // result itself came from an explicit one-shot grow click.
    if (!result?.grown || !result.preGrowBounds) {
      grownBanner.style.display = 'none'
      return
    }
    grownBanner.textContent = `Re-run: bench grown ${GROWN_SIZES(result.preGrowBounds, result.volume)} to fit out-of-bounds writes`
    grownBanner.style.display = ''
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
  originXInput.addEventListener('change', () => {
    config.originX = readInt(originXInput, config.originX)
    config.originTouched = true
    originXInput.value = String(config.originX)
    notifyConfigChanged()
  })
  originZInput.addEventListener('change', () => {
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
  seedInput.addEventListener('change', () => {
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
    notifyConfigChanged()
  })

  const seedRowControl = h('div', 'fl-seed-row')
  seedRowControl.append(seedInput, randomSeedButton)

  const repeatInput = numberInput(config.repeatCount, { min: REPEAT_MIN, max: REPEAT_MAX })
  repeatInput.addEventListener('change', () => {
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
  sizeXInput.addEventListener('change', applySizeChange)
  sizeYInput.addEventListener('change', applySizeChange)
  sizeZInput.addEventListener('change', applySizeChange)
  minYInput.addEventListener('change', applySizeChange)

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
      input.disabled = !buildsSea
      slotRow.classList.toggle('fl-row-inert', !buildsSea)
      // An input with a title of its own overrides the row's; blank falls back to the row's.
      if (reason) input.title = reason
      else input.removeAttribute('title')
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
  topMaterialInput.addEventListener('change', () => applyMaterialOverride('topMaterial', topMaterialInput.value))
  midMaterialInput.addEventListener('change', () => applyMaterialOverride('midMaterial', midMaterialInput.value))
  foundationMaterialInput.addEventListener('change', () => applyMaterialOverride('foundationMaterial', foundationMaterialInput.value))
  seaFloorMaterialInput.addEventListener('change', () => applyMaterialOverride('seaFloorMaterial', seaFloorMaterialInput.value))
  seaMaterialInput.addEventListener('change', () => applyMaterialOverride('seaMaterial', seaMaterialInput.value))
  seaFloorDepthInput.addEventListener('change', () => applyMaterialOverride('seaFloorDepth', Math.max(0, readFloat(seaFloorDepthInput, 0))))

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
  biomeTagsInput.addEventListener('change', () => {
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
    input.addEventListener('change', () => {
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
    opts.viewer.setSlice(min, max)
    save()
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
    opts.viewer.setSlice(min, max)
    save()
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
  const sliceMaxRow = h('div', 'fl-row fl-row-primary')
  const sliceMaxLabelEl = h('label', 'fl-row-label', 'Max Y (cut)')
  sliceMaxRow.title = 'Hides everything above this Y in the result.'
  sliceMaxRow.append(sliceMaxLabelEl, sliceMaxInput, sliceMaxLabel)

  const envModeRow = h('div', 'fl-row')
  envModeRow.title = 'How the untouched terrain around the feature is drawn: solid, see-through, or not at all.'
  envModeRow.append(h('label', 'fl-row-label', 'Environment'))
  const envModeGroup = h('div', 'fl-radio-group')
  for (const mode of ['solid', 'ghost', 'hidden'] as const) {
    const optionLabel = h('label', 'fl-radio-option')
    const radio = h('input') as HTMLInputElement
    radio.type = 'radio'
    radio.name = 'fl-env-mode'
    radio.value = mode
    radio.checked = view.environmentMode === mode
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      view.environmentMode = mode
      opts.viewer.setEnvironmentMode(mode)
      save()
    })
    optionLabel.append(radio, document.createTextNode(mode[0]?.toUpperCase() + mode.slice(1)))
    envModeGroup.append(optionLabel)
  }
  envModeRow.append(envModeGroup)

  const carvedCheckbox = checkboxInput(view.showCarved)
  carvedCheckbox.addEventListener('change', () => {
    view.showCarved = carvedCheckbox.checked
    opts.viewer.setShowCarved(view.showCarved)
    save()
  })
  const carvedRow = row('Show carved', carvedCheckbox, 'Draws the cells the feature turned to air as a translucent tinted volume.')

  const heatmapCheckbox = checkboxInput(view.showHeatmap)
  heatmapCheckbox.addEventListener('change', () => {
    view.showHeatmap = heatmapCheckbox.checked
    opts.viewer.setShowHeatmap(view.showHeatmap)
    save()
  })
  const heatmapRow = row('Show heatmap', heatmapCheckbox, 'Colours each touched cell by how many writes hit it; needs profiling on the run that produced this result.')

  const overflowCheckbox = checkboxInput(view.showOverflow)
  overflowCheckbox.addEventListener('change', () => {
    view.showOverflow = overflowCheckbox.checked
    opts.viewer.setShowOverflow(view.showOverflow)
    save()
  })
  const overflowViewRow = row('Show overflow', overflowCheckbox, 'Draws the writes that landed outside the bench in magenta; showing them changes nothing about the run.')

  const gridCheckbox = checkboxInput(view.showGrid)
  gridCheckbox.addEventListener('change', () => {
    view.showGrid = gridCheckbox.checked
    opts.viewer.setShowGrid(view.showGrid)
    save()
  })

  // Two framing controls: "Frame view" fits what's actually occupied right now (feature +
  // visible environment/carved cells, respecting the current Y slice -- see
  // VoxelViewer.frameContent's own doc comment for why this replaced a plain frameAll() call
  // here), which is what a user wants nearly every time. "Frame volume" is the old whole-box
  // behaviour (frameAll(), air included) kept as a secondary control for the one time that
  // still matters: seeing where a feature sits relative to the volume it was asked to fill.
  const frameButton = h('button', 'fl-wide-btn', 'Frame view  (R)') as HTMLButtonElement
  frameButton.type = 'button'
  frameButton.title = 'Fits the camera to what is occupied right now, respecting the Y cut.'
  frameButton.addEventListener('click', () => opts.viewer.frameContent())

  const frameVolumeButton = h('button', 'fl-wide-btn', 'Frame volume  (Shift+R)') as HTMLButtonElement
  frameVolumeButton.type = 'button'
  frameVolumeButton.title = 'Fits the camera to the whole bench, air included.'
  frameVolumeButton.addEventListener('click', () => opts.viewer.frameAll())

  viewBody.append(sliceMinRow, sliceMaxRow, envModeRow, carvedRow, heatmapRow, overflowViewRow, row('Show grid', gridCheckbox, 'Draws the bench\'s outline and floor grid.'), frameButton, frameVolumeButton)

  // ==========================================================================================
  // ---- Diagnostics section -------------------------------------------------------------------
  // ==========================================================================================
  const { section: diagSection, body: diagBody, header: diagHeader } = section('diagnostics', 'Diagnostics')
  const MAX_LISTED_DIAGNOSTICS = 300

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

      body.append(h('div', 'fl-diag-text', d.message))

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

  // ---- keyboard shortcut: frame view (mirrors viewer.ts's own handleKeyDown -- see that
  // method's doc comment for why plain 'r' vs shift+'r' ('R') need no separate modifier check)
  document.addEventListener('keydown', (ev) => {
    const target = ev.target
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    if (ev.key === 'r') opts.viewer.frameContent()
    else if (ev.key === 'R') opts.viewer.frameAll()
  })

  // apply restored view state to the viewer immediately, before any data exists
  opts.viewer.setEnvironmentMode(view.environmentMode)
  opts.viewer.setShowGrid(view.showGrid)
  opts.viewer.setShowCarved(view.showCarved)
  opts.viewer.setShowHeatmap(view.showHeatmap)
  opts.viewer.setShowOverflow(view.showOverflow)
  opts.viewer.setSlice(view.sliceMinY, view.sliceMaxY)

  renderDiagnostics([])

  return {
    setResult(result: DecodedResult): void {
      // Safety net (see applyBusy's own doc comment) -- a fresh result always means "no longer
      // pending", whether or not the host also called setBusy(false) itself.
      applyBusy(false)
      errorBanner.style.display = 'none'
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

      renderCounts(result.counts, result.placementDurationMs, result.libraryBuildDurationMs, result.partial)
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
        errorBanner.textContent = `generation failed: ${message}`
        errorBanner.style.display = ''
      }
      renderDiagnostics(lastResult?.diagnostics ?? [])
    },
    setStale(stale: boolean, reason?: string): void {
      if (!stale) {
        staleBanner.style.display = 'none'
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
  }
}
