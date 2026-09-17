// protocol.ts -- decodes the Go engine's wire JSON (featurelab/wire's GenerateOutput,
// session.Result embedded -- see that package's doc comment for the full field-by-field spec)
// into the ViewerVolume/ViewerPaletteEntry shapes viewer.ts/mesher.ts consume. This is the ONLY
// place that knows the wire format; everything past this module works in the viewer's own
// vocabulary.
//
// The whole contract is lowerCamelCase, including block.Entry and wgen.BlockPos (id/name/
// states/kind, x/y/z) -- both used to have no `json:"..."` struct tags at all and fell back to
// Go's capitalized exported-field names ("ID", "Name", "States", "Kind", "X", "Y", "Z"), the
// one inconsistency in an otherwise all-camelCase contract; this decoder used to compensate for
// that by reading the capitalized names directly. That inconsistency is gone (see
// featurelab/wire's package doc comment, "Field naming") -- this file now reads the same
// lowerCamelCase convention everywhere.
//
// The per-cell arrays (blocks, baseline, changed, removed, profile.touchCounts) have changed
// encoding more than once, and this decoder accepts every shape the engine has emitted so that
// the older responses kept in test/fixtures still decode. They now arrive run-length encoded as
// an object, since a bench volume is mostly untouched environment and the dense forms were
// ruinous at large volume sizes (see featurelab/session's cellarrays.go and the rle package
// on the Go side). Historically blocks/baseline were a dense `number[]`, and changed/removed
// were Go `[]byte`, which encoding/json renders as a base64 string rather than an array of
// numbers -- which is why a string is still one of the accepted shapes. See CellArrayWire and
// expandCellArray below for the authoritative list; this paragraph is the history, not the spec.
import type { BlockKind, ViewerPaletteEntry, ViewerVolume } from './viewer.js'
import { colorForBlockName } from './colors.js'

export interface BoundsWire {
  minX: number
  minY: number
  minZ: number
  sizeX: number
  sizeY: number
  sizeZ: number
}

/** Wire shape of block.Entry. States is whatever JSON value each state holds (string/number/
 * bool) or null for a stateless block. Kind is block.Kind's own numeric encoding: 0 solid,
 * 1 air, 2 liquid, 3 plant, 4 glass (see featurelab/wire's package doc comment, "Kind
 * encoding"). */
export interface PaletteEntryWire {
  id: number
  name: string
  states: Record<string, unknown> | null
  kind: number
}

/** Wire shape of a diagnostic's `position` field -- the world cell it's about, or absent/null
 * when the diagnostic isn't position-specific. `{x:0,y:0,z:0}` is a genuine coordinate, NOT a
 * stand-in for "no position" -- decodeGenerateResult/normalizeDiagnostic below preserve `null`
 * as `null`, never coalescing it to a zero position. */
export interface DiagnosticPositionWire {
  x: number
  y: number
  z: number
}

/** Wire shape of a session.Diagnostic entry (session/session.go), as reshaped by this repo's
 * "diagnostics that point at the real culprit" fix: `identifier`/`typeId` name the feature that
 * actually produced the diagnostic, which can differ from whatever feature/rule the user asked
 * to preview when the failure happened inside a nested delegation -- `chain` is the root-first
 * path from the run feature/rule down to it (`chain[chain.length-1] === identifier`). `count` is
 * how many times this exact diagnostic fired this run (a failure inside a scatter/loop can
 * repeat thousands of times); `position`, per DiagnosticPositionWire's own doc comment, is the
 * one world cell this diagnostic is about, or null when it isn't tied to a single cell.
 *
 * identifier/typeId/chain/count/position are all OPTIONAL on the wire type here (not on the real
 * contract, which always sends them) purely so this decoder
 * tolerates a response captured from an engine build that predates this shape (the old
 * {level,fileId,message}-only Diagnostic) without throwing -- see normalizeDiagnostic's own
 * fallback for exactly what an absent field defaults to. */
export interface DiagnosticWire {
  level: string
  fileId: string
  identifier?: string
  typeId?: string
  chain?: string[]
  count?: number
  position?: DiagnosticPositionWire | null
  message: string
}

/** `DiagnosticWire` normalized so every field this package's own decoder guarantees is always
 * populated (never `undefined`) -- see `normalizeDiagnostic`. What `DecodedResult.diagnostics`
 * and panel.ts's Diagnostics section actually consume. */
export interface DecodedDiagnostic {
  level: string
  fileId: string
  identifier: string
  typeId: string
  /** Root-first, `chain[chain.length-1] === identifier`, always at least one element. */
  chain: string[]
  /** Always >= 1 -- an absent/0/negative wire `count` normalizes to 1 ("happened once"). */
  count: number
  position: DiagnosticPositionWire | null
  message: string
}

/** Wire shape of wgen.BlockPos as it appears under GenerateOutput's `origin` field -- the
 * placement origin actually used for this run (after resolving "Y auto" against the built
 * environment). See featurelab/wire's package doc comment, "Response: GenerateOutput". */
export interface OriginWire {
  x: number
  y: number
  z: number
}

/** Wire shape of features.Entry (session.Result.Entries) -- every loaded features/*.json
 * entry, regardless of whether it built successfully. Note there is NO `built`/success flag
 * on the wire: features.Entry's own `Feature wgen.IFeature` field is `json:"-"` (a built
 * feature has no JSON-safe representation), so unlike RuleEntryWire below, a consumer cannot
 * currently tell a successfully-built feature apart from one that failed (see that file's
 * build loop: both produce an Entry, only a failed one also produces a Diagnostic). Restoring
 * that distinction on the wire (e.g. a `built: boolean` field) is tracked as follow-up work --
 * see this repo's panel.ts doc comment for where that gap surfaces in the UI. */
export interface FeatureEntryWire {
  fileId: string
  identifier: string
  typeId: string
}

/** Wire shape of rules.FeatureRule, as it appears nested in RuleEntryWire.rule /
 * GenerateResultWire.activeRule. biomeFilter/distribution are read here only far enough to
 * render a one-line summary (see panel.ts's rule info readout) -- not decoded into a typed
 * tree the way DecodedResult's other fields are. */
export interface RuleWire {
  identifier: string
  placesFeature: string
  placementPass: string | null
  biomeFilter: unknown
}

/** Wire shape of rules.FeatureRuleEntry (session.Result.RuleEntries) -- every loaded
 * feature_rules/*.json entry, always populated regardless of request mode. Unlike
 * FeatureEntryWire, `rule` genuinely distinguishes success (a non-null object) from failure
 * (null, "file failed to parse/build") -- see rules.FeatureRuleEntry's own doc comment. */
export interface RuleEntryWire {
  fileId: string
  identifier: string
  rule: RuleWire | null
}

/** Wire shape of biomes.MaterialSlots (biomes/biomes.go) -- a resolved pack biome's own
 * minecraft:surface_builder, the same six fields wire.Materials lets a `generate` request
 * override and env.MaterialSlots (see EnvironmentMaterialsWire below) gives a preset. Layering
 * order (verified against the real engine, see this repo's Biome section doc comment in
 * panel.ts): preset (source 1) < selected pack biome, this type (source 2) < an explicit
 * per-slot Materials override on the request (source 3) -- source 3 always wins, even over a
 * selected biome. */
export interface MaterialSlotsWire {
  topMaterial: string
  midMaterial: string
  foundationMaterial: string
  seaFloorMaterial: string
  seaMaterial: string
  seaFloorDepth: number
}

/** Wire shape of biomes.Climate -- read here only far enough to round-trip; panel.ts does not
 * currently surface climate in the UI. Every field is independently nullable (biomes.Climate's
 * own fields are pointers -- "this biome file didn't specify one", not a meaningful zero). */
export interface ClimateWire {
  temperature: number | null
  snowAccumulation: [number, number] | null
  downfall: number | null
}

/** Wire shape of biomes.Replacement (minecraft:replace_biomes entries) -- like ClimateWire, read
 * here only far enough to round-trip; not currently surfaced in the UI. */
export interface ReplacementWire {
  targets: string[]
  dimension: string | null
  amount: number | null
  noiseFrequencyScale: number | null
}

/** Wire shape of biomes.ResolvedBiome -- one pack biome file, fully parsed. surfaceBuilder is
 * null when the file's minecraft:biome declared no minecraft:surface_builder component (that
 * biome contributes tags/identity only, same as picking no pack biome at all materials-wise). */
export interface ResolvedBiomeWire {
  identifier: string
  fileId: string
  tags: string[]
  surfaceBuilder: MaterialSlotsWire | null
  surfaceBuilderType: string | null
  climate: ClimateWire | null
  replaceBiomes: ReplacementWire[]
}

/** Wire shape of biomes.Entry (session.Result.BiomeEntries) -- every loaded biomes/*.json entry.
 * Unlike FeatureEntryWire, `biome` genuinely distinguishes success (a non-null object) from
 * failure (null, "file failed to parse") -- same shape of distinction RuleEntryWire's `rule`
 * makes, see that type's doc comment. Today biomes.BuildLibrary never actually emits an Entry
 * with a null Biome (a file that fails to parse is dropped before an Entry is even created, see
 * that function's own doc comment) -- this stays nullable on the wire type regardless, both
 * because the Go struct field itself is a pointer and because a consumer should not assume a
 * future engine change can't start emitting the null case. */
export interface BiomeEntryWire {
  fileId: string
  identifier: string
  biome: ResolvedBiomeWire | null
}

/** Wire shape of profiler.FeatureProfileStats (profiler/profiler.go) -- field names match
 * that struct's own JSON tags exactly. */
export interface FeatureProfileStatsWire {
  identifier: string
  typeId: string
  entered: number
  blocksWritten: number
  delegations: number
  selfMs: number
  inclusiveMs: number
  /** Where this feature stopped short, one row per (reason, ordinal). Omitted when it never
   * did, and by engines that predate stops. */
  stops?: StopStatWire[]
}

/** Wire shape of profiler.StopStat: a gate that ended a feature's work early. `reason` is a
 * stable code (iterations_zero, condition_false, ...), `detail` the first occurrence's evaluated
 * value, `ordinal` the entry index it applies to -- absent for the whole feature. */
export interface StopStatWire {
  reason: string
  detail: string
  count: number
  ordinal?: number
}

/** Wire shape of profiler.CellAttribution: three parallel arrays, entry i meaning feature
 * `featureIdentifiers[feature[i]]` wrote cell `cell[i]`, `count[i]` times. */
export interface CellAttributionWire {
  cell: number[]
  feature: number[]
  count: number[]
}

/** Wire shape of profiler.ProfileResult (session.Result.Profile) -- nil/absent on the wire
 * whenever Config.Profiling was false, or true but nothing was ever selected to place. */
export interface ProfileResultWire {
  /** One write count per cell -- run-length encoded like blocks/baseline, see CellArrayWire.
   * The single largest field a response can carry (10.6 MB of JSON at 96x384x96 before the
   * encoding), and usually one long run of zeros with a few touched cells in it. */
  touchCounts: CellArrayWire
  featureIdentifiers: string[]
  features: FeatureProfileStatsWire[]
  attribution: CellAttributionWire
}

/** The subset of GenerateOutput (cmd/featurelab/generate.go + session.Result) this package
 * actually decodes. Extra fields on the real response (placements, molangScope, ...) are
 * ignored here on purpose -- they are not the panel's concern -- so this interface only lists
 * what decodeGenerateResult reads, not the full wire contract. origin/entries/ruleEntries ARE
 * read (see DecodedResult) -- they drive panel.ts's Feature/Rule pickers and Origin X/Z
 * composition -- but are typed optional here and defaulted on decode (see decodeGenerateResult)
 * so a hand-trimmed fixture captured before this port existed still decodes without editing. */
export interface GenerateResultWire {
  bounds: BoundsWire
  featureSeed: number
  environmentSeed: number
  /** The placement origin actually used for this run (world coordinates, Y already resolved
   * from "auto" against the built environment when the request didn't pin one) -- see
   * OriginWire's doc comment. Consumed by panel.ts to track a "last known good" Y so editing
   * Origin X/Z alone (there is no Origin Y control -- see panel.ts's doc comment) can still
   * compose a full "x,y,z" wire origin string without forcing Y to a wrong fixed value. */
  origin?: OriginWire
  /** Every loaded features/*.json entry -- see FeatureEntryWire's doc comment for the "no
   * built flag" caveat. Populated regardless of request mode. */
  entries?: FeatureEntryWire[]
  /** Every loaded feature_rules/*.json entry -- see RuleEntryWire's doc comment. Populated
   * regardless of request mode. */
  ruleEntries?: RuleEntryWire[]
  /** One block id per cell -- see CellArrayWire for the three shapes this can arrive in. */
  blocks: CellArrayWire
  baseline: CellArrayWire
  palette: PaletteEntryWire[]
  /** 1 for every cell whose id differs from baseline, same indexing as blocks/baseline. */
  changed: CellArrayWire
  /** 1 for every cell the feature carved out, a subset of `changed`. */
  removed: CellArrayWire
  blocksChanged: number
  blocksPlaced: number
  blocksCarved: number
  blocksReplaced: number
  writesOutOfBounds: number
  /** Every out-of-bounds write this run captured instead of dropping (session.Result.
   * OverflowBlocks, volume.Volume.Overflow) -- world position PLUS the id that would have been
   * written, had the bench been big enough. Deduplicated per unique out-of-bounds position (a
   * repeat write to the same cell updates that entry, last write wins). Cannot share blocks/
   * baseline/changed/removed's flat cell-index scheme (index(x,y,z) assumes x/y/z fall inside
   * bounds, which an overflow position by definition does not) -- each entry carries its own
   * absolute world x/y/z instead. Optional/absent on a wire response captured before this field
   * existed (see decodeGenerateResult's own default, matching biomeEntries/environmentBiome
   * above) -- never absent on a current engine build, even when empty. See this repo's task
   * report ("Out-of-bounds capture") for the full design and why read semantics (GetBlock/
   * Contains) are completely unaffected by this field's existence. */
  overflowBlocks?: OverflowBlockWire[] | null
  /** Present only on a response from the "grow to fit and regenerate" action (wire.
   * RunGenerateGrown/RunGenerateGrownFromWorkspace, cmd/featurelab's `generateGrown` serve
   * method / `generate --grow` flag) -- true when a second, LARGER placement actually ran
   * because the first captured overflowBlocks; false (or absent, for a plain `generate`
   * response) means this is an ordinary result, not a re-run. A consumer MUST check this before
   * treating a result as "the same placement, just wider" -- see preGrowBounds below. The two must never be
   * conflated: a grown re-run can produce
   * DIFFERENT captured content than the original capture (different bench bounds change what a
   * feature reads, which can change its decisions and RNG draws). */
  grown?: boolean
  /** The ORIGINAL (pre-grow) bench bounds, present only when `grown` is true -- lets a consumer
   * report e.g. "grew from 32x48x32 to 64x64x64" rather than just this result's own (already
   * larger) bounds in isolation. Absent/null on every other response. */
  preGrowBounds?: BoundsWire | null
  /** This run's placement only (feature/rule Place calls, palette interning, the baseline diff)
   * -- excludes library build cost in both `generate` modes. What a pack author iterates against
   * turn to turn once a pack is loaded; see featurelab/wire's package doc comment ("Duration
   * fields") for the full spec these three fields replace a single, mode-ambiguous durationMs
   * with. */
  placementDurationMs: number
  /** Parsing/building the feature/structure/rule libraries this run placed against. Always 0 on
   * a `serve` "generate" call -- that cost was already paid once, earlier, by "loadPack", and is
   * NOT part of a regeneration. Nonzero only for a one-shot `generate` (the CLI subcommand /
   * desktop app path), which rebuilds those libraries on every call. */
  libraryBuildDurationMs: number
  /** libraryBuildDurationMs + placementDurationMs, computed on the Go side so this module never
   * has to add them itself. */
  totalDurationMs: number
  partial: boolean
  diagnostics: DiagnosticWire[] | null
  /** Every loaded biomes/*.json entry -- see BiomeEntryWire's doc comment. Populates panel.ts's
   * Pack biome picker. Optional/absent on a wire response captured before this field existed
   * (see decodeGenerateResult's own default). */
  biomeEntries?: BiomeEntryWire[]
  /** The resolved biome for this request's biomeId, when it named one the pack actually
   * defines; null when biomeId was "" or unresolved -- see session.Result.EnvironmentBiome's
   * own doc comment (wire/wire.go's package doc, "environmentBiome"). Optional/absent on a wire
   * response captured before this field existed. */
  environmentBiome?: ResolvedBiomeWire | null
  /** Populated only when the request that produced this result had profiling armed
   * (session.Config.Profiling / GenerateParams.Profile) -- absent (undefined) or explicit
   * null otherwise. See ProfileResultWire's doc comment. */
  profile?: ProfileResultWire | null
}

export interface BlockCounts {
  changed: number
  placed: number
  carved: number
  replaced: number
  writesOutOfBounds: number
}

/** Decoded profiler.ProfileResult -- same field set as ProfileResultWire, with the numeric
 * arrays converted to the same typed-array shapes ViewerVolume itself uses (touchCounts is
 * literally consumed as ViewerVolume.touchCounts, see decodeGenerateResult). */
export interface DecodedProfile {
  touchCounts: Uint32Array
  featureIdentifiers: string[]
  features: FeatureProfileStatsWire[]
  attribution: {
    cell: Uint32Array
    feature: Uint16Array
    count: Uint32Array
  }
}

export interface DecodedResult {
  volume: ViewerVolume
  palette: ViewerPaletteEntry[]
  counts: BlockCounts
  /** See GenerateResultWire.placementDurationMs -- the headline number, what a pack author
   * iterates against. */
  placementDurationMs: number
  /** See GenerateResultWire.libraryBuildDurationMs -- 0 on every `serve` regeneration, nonzero
   * only for a one-shot `generate` call. */
  libraryBuildDurationMs: number
  /** libraryBuildDurationMs + placementDurationMs. */
  totalDurationMs: number
  partial: boolean
  diagnostics: DecodedDiagnostic[]
  featureSeed: number
  environmentSeed: number
  /** null whenever the run this result came from had profiling off, or profiling on but
   * nothing selected to place -- see ProfileResultWire's doc comment. Drives the touch-count
   * heatmap (also folded onto `volume.touchCounts`) and the per-feature cost table. */
  profile: DecodedProfile | null
  /** The placement origin actually used -- {x:0,y:0,z:0} when the wire response predates this
   * field (see GenerateResultWire.origin's doc comment); a real `generate` response always
   * carries a genuine one. */
  origin: OriginWire
  /** Every loaded features/*.json entry -- [] when the wire response predates this field.
   * Populates panel.ts's Feature picker. */
  entries: FeatureEntryWire[]
  /** Every loaded feature_rules/*.json entry -- [] when the wire response predates this field.
   * Populates panel.ts's Rule picker. */
  ruleEntries: RuleEntryWire[]
  /** Every loaded biomes/*.json entry -- [] when the wire response predates this field.
   * Populates panel.ts's Pack biome picker. */
  biomeEntries: BiomeEntryWire[]
  /** The resolved biome for this request's biomeId -- null when biomeId was "" or unresolved,
   * OR when the wire response predates this field. See GenerateResultWire.environmentBiome's
   * doc comment. */
  environmentBiome: ResolvedBiomeWire | null
  /** Every out-of-bounds write this run captured -- [] when the wire response predates this
   * field or nothing spilled. Same array object as `volume.overflowBlocks` (see ViewerVolume's
   * own doc comment) -- exposed here too so a host UI (panel.ts) can read counts/positions
   * without reaching into the viewer-facing volume shape for what is really result-level
   * metadata. See GenerateResultWire.overflowBlocks' own doc comment for the full design. */
  overflowBlocks: OverflowBlockWire[]
  /** True only when this result came from a "grow to fit and regenerate" call AND that call
   * actually ran a second, larger placement (see GenerateResultWire.grown's own doc comment).
   * False for every ordinary `generate` result. A consumer MUST branch its UI on this: a grown
   * re-run must be labelled as a re-run, never as a wider view of the same result (see
   * GenerateResultWire.grown for why). */
  grown: boolean
  /** The pre-grow bench bounds, non-null only when `grown` is true. */
  preGrowBounds: BoundsWire | null
}

// --- `environments` method (cmd/featurelab/environments.go) --------------------------------
//
// A SEPARATE `serve` method from `generate` above (see cmd/featurelab/serve.go's dispatch) --
// static, pack-independent data (env.ENVIRONMENTS is a fixed built-in table), so a client may
// call it before or without ever calling loadPack. Response is a bare JSON array of
// EnvironmentOptionWire, one per env.ENVIRONMENTS entry, in that table's own order. This is what
// panel.ts's Preset dropdown populates itself from -- see environments.ts's deletion (the same
// change that added this method) for the hand-transcribed mirror it replaces.

export interface EnvironmentDefaultsWire {
  sizeX: number
  sizeY: number
  sizeZ: number
  minY: number
}

/** A preset's own NATIVE material identity (source 1 of the "material slots -> terrain builder"
 * pipeline -- see MaterialSlotsWire's doc comment for how this composes with a selected pack
 * biome and an explicit override). Same six fields as MaterialSlotsWire; kept as its own type
 * rather than reused because it mirrors a distinct Go type (env.MaterialSlots vs
 * biomes.MaterialSlots) even though the wire shape happens to be identical. */
export interface EnvironmentMaterialsWire {
  topMaterial: string
  midMaterial: string
  foundationMaterial: string
  seaFloorMaterial: string
  seaMaterial: string
  seaFloorDepth: number
}

/** Wire shape of one entry in session.Result.OverflowBlocks / volume.Volume.Overflow -- an
 * out-of-bounds write the engine captured instead of dropping. x/y/z are ABSOLUTE world
 * coordinates, NOT relative to bounds and NOT an index into blocks/baseline/changed/removed's
 * flat cell scheme (see GenerateResultWire.overflowBlocks' own doc comment for why) -- id
 * decodes against the same `palette` array every in-bounds cell already uses. */
export interface OverflowBlockWire {
  x: number
  y: number
  z: number
  id: number
}

export interface EnvironmentOptionWire {
  id: string
  label: string
  description: string
  defaults: EnvironmentDefaultsWire
  materials: EnvironmentMaterialsWire
  /** Whether this preset's terrain builder actually models a sea -- and therefore whether
   * `materials`' own seaFloorMaterial/seaMaterial/seaFloorDepth slots mean anything under it.
   * "ocean" alone, in this port (env.EnvironmentPreset.BuildsSea), but read the flag rather than
   * comparing `id` to 'ocean': which presets build a sea is the ENGINE's fact, and a hardcoded id
   * here would be exactly the hand-transcribed mirror the `environments` method exists to delete.
   * panel.ts's Materials section disables those three controls when this is false, so the panel
   * says up front what env.InertSeaSlotOverrides would otherwise only say in a warning attached to
   * a finished run. */
  buildsSea: boolean
  /** This preset's default query.has_biome_tag/any_tag/all_tags identity -- shown (never
   * auto-sent) as the Biome section's placeholder/prefill until the user selects a pack biome
   * or arms an explicit tags override -- see panel.ts. */
  biome: string
  biomeTags: string[]
}

// --- request-side wire types -------------------------------------------------------------
//
// GenerateParamsWire/MaterialsWire mirror featurelab/wire's GenerateParams/Materials
// field-for-field (see that package's own doc comment for the full "every field optional,
// omitted means use the preset default" contract) -- the request-side counterpart to
// GenerateResultWire above. This is the ONLY place in frontend/ that declares this shape;
// panel.ts imports it rather than redeclaring its own copy, and apps/vscode's
// previewController.ts imports it too rather than keeping a third independent copy (which is
// what let that file's old hand-rolled GenerateParams drift out of sync with the real wire
// contract in the first place).
//
// Field-for-field correspondence with wire.GenerateParams (Go):
//   Feature string            -> feature?: string
//   Rule string                -> rule?: string
//   Env string                 -> env?: string
//   Seed *uint32                -> seed?: number
//   Origin string ("x,y,z")     -> origin?: string
//   Size string ("XxYxZ")       -> size?: string
//   MinY *int                   -> minY?: number
//   BiomeID string               -> biomeId?: string
//   BiomeTags []string           -> biomeTags?: string[]
//   Materials *Materials         -> materials?: MaterialsWire
//   Repeat int                   -> repeat?: number
//   Profile bool                 -> profile?: boolean
//   WriteBudget *int              -> writeBudget?: number
//   DelegationBudget *int         -> delegationBudget?: number
//   PlacementTimeLimitMs *int     -> placementTimeLimitMs?: number

/** Mirrors wire.Materials -- every field independently optional; omitted means "keep whichever
 * of the preset's native materials / an earlier override layer already supplied this slot" (Go
 * side: env.MergeMaterialSlots). See GenerateParamsWire's doc comment. */
export interface MaterialsWire {
  topMaterial?: string
  midMaterial?: string
  foundationMaterial?: string
  seaFloorMaterial?: string
  seaMaterial?: string
  /** 0 is a legitimate depth ("no sea floor band") distinct from "not given" -- only include
   * this field once the user has actually set a depth, never as a default 0. */
  seaFloorDepth?: number
}

/** Mirrors wire.GenerateParams -- the "generate" request shape shared verbatim between the
 * CLI's `generate` subcommand flags and serve's "generate" JSON-RPC method params. Every field
 * is optional; omitting a field means "use the preset default" -- see this section's header
 * comment. Building one of these from panel.ts's own control state is buildGenerateParams's
 * job (see panel.ts); this module only declares the shape. */
export interface GenerateParamsWire {
  feature?: string
  rule?: string
  env?: string
  seed?: number
  /** "x,y,z", all three required together when present -- see wire.ParseOrigin. */
  origin?: string
  /** "XxYxZ", all three required together when present -- see wire.ParseSize. */
  size?: string
  minY?: number
  biomeId?: string
  biomeTags?: string[]
  materials?: MaterialsWire
  repeat?: number
  profile?: boolean
  /** Per-run override of the max SetBlock attempts before the engine aborts the run as a
   * runaway (an infinite/non-converging nested chain -- see volume.WriteBudgetExceeded).
   * Omitted means the engine's own built-in default, ENGINE_DEFAULT_WRITE_BUDGET below. */
  writeBudget?: number
  /** Per-run override of the max feature-to-feature delegation calls before the engine aborts
   * the run (features.DelegationBudgetExceeded). Omitted means the engine's own built-in
   * default, ENGINE_DEFAULT_DELEGATION_BUDGET below. */
  delegationBudget?: number
  /** Per-run override of the max wall-clock milliseconds the engine spends placing before
   * cutting the run off as partial. Omitted means the engine's own built-in default,
   * ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS below -- see that constant's own doc comment for the
   * extension-side request-timeout coupling raising this implies. */
  placementTimeLimitMs?: number
  /** Asks the engine to leave `entries`, `ruleEntries` and `biomeEntries` out of the response
   * (they come back null). Those three describe the loaded PACK, not the run, and they dominate
   * a repeated preview -- on a real pack `entries` alone is over half a response. A host driving
   * many generates against one loaded pack fetches them once and sets this on everything after;
   * whoever sets it is responsible for putting the cached arrays back before anything that reads
   * them sees the result. Omitted means the full response, which is what a one-shot caller and
   * any host that has not been taught about this keep getting. */
  omitCatalogs?: boolean
}

/** The engine's own built-in defaults for GenerateParamsWire's three budget knobs above
 * (session/session.go's WriteBudget / DefaultDelegationBudget / DefaultPlacementTimeLimitMs
 * constants) -- mirrored here by hand since there is no wire method that reports them, only the
 * fixed values the engine documents. panel.ts's Budget section shows these as each
 * control's placeholder/reference value (blank input = "use this"), and apps/vscode's
 * previewPanel.ts uses ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS to size its own request timeout
 * comfortably above whatever placementTimeLimitMs a request will actually run with -- the wait
 * the extension itself imposes (featurelab.requestTimeoutMs) is a SEPARATE knob, layered outside
 * this wire contract entirely, and left unaware of it a user raising placementTimeLimitMs above
 * their configured requestTimeoutMs would see a successful-but-slow run reported as a dead
 * engine (see previewPanel.ts's own regenerate() doc comment for the fix). */
export const ENGINE_DEFAULT_WRITE_BUDGET = 4_000_000
export const ENGINE_DEFAULT_DELEGATION_BUDGET = 2_000_000
export const ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS = 8_000

const KIND_BY_WIRE: readonly BlockKind[] = ['solid', 'air', 'liquid', 'plant', 'glass']

function kindFromWire(kind: number): BlockKind {
  return KIND_BY_WIRE[kind] ?? 'solid'
}

/** A per-cell array as it arrives on the wire, in any of the three shapes this engine has
 * emitted. The current one is the run-length object; the other two are accepted so a response
 * captured from an older engine (this package keeps several as test fixtures) still decodes.
 *
 *   - `{ rle: [value, run, value, run, ...] }` -- the current encoding. A bench volume is mostly
 *     untouched environment, so these arrays are long runs of the same value: at 96x384x96 the
 *     four block/mask arrays plus profile.touchCounts came to roughly 33 MB of JSON, and the
 *     same run encodes to a few hundred KB. See the Go side's featurelab/rle package.
 *   - `number[]` -- the dense array blocks/baseline used to be.
 *   - `string` -- base64 of one byte per cell, what a Go []byte marshals to; the old encoding
 *     for the changed/removed masks. */
export type CellArrayWire = { rle: number[] } | number[] | string

/** Expands one per-cell array into `out`, whatever shape it arrived in, and returns how many
 * cells it actually held -- the caller checks that against the volume's own cell count, since
 * an array that decodes cleanly but is the wrong length means a truncated response rather than
 * a small volume.
 *
 * `out` is allocated by the caller at the expected size, so the common (correct) case fills a
 * typed array with no intermediate JS array at all -- the whole point of the encoding is not to
 * spend memory proportional to the cell count on the way in. */
function expandCellArray(value: CellArrayWire, out: Uint32Array | Uint8Array, field: string): number {
  if (typeof value === 'string') {
    const bytes = base64ToUint8Array(value)
    const n = Math.min(bytes.length, out.length)
    out.set(bytes.subarray(0, n))
    return bytes.length
  }
  if (Array.isArray(value)) {
    const n = Math.min(value.length, out.length)
    for (let i = 0; i < n; i++) out[i] = value[i]!
    return value.length
  }
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { rle?: unknown }).rle)) {
    throw new Error(`malformed generate result: ${field} is not a cell array`)
  }
  const pairs = (value as { rle: number[] }).rle
  if (pairs.length % 2 !== 0) {
    throw new Error(`malformed generate result: ${field} has ${pairs.length} run-length elements, which is not a whole number of value/run pairs`)
  }
  let at = 0
  for (let i = 0; i < pairs.length; i += 2) {
    const v = pairs[i]!
    const run = pairs[i + 1]!
    if (!(run >= 1)) {
      throw new Error(`malformed generate result: ${field} has a run length of ${run}, which must be at least 1`)
    }
    const end = Math.min(at + run, out.length)
    out.fill(v, Math.min(at, out.length), end)
    at += run
  }
  return at
}

/** Decodes a Go `[]byte` field as it appears on the wire (a base64 string) into a Uint8Array.
 * Works both in a browser/webview (via `atob`) and under Node (vitest, the extension host's
 * non-webview code) via `Buffer`, since this module is imported from both. */
export function base64ToUint8Array(b64: string): Uint8Array {
  if (b64.length === 0) return new Uint8Array(0)
  const g = globalThis as { atob?: (s: string) => string; Buffer?: { from(s: string, enc: string): Uint8Array } }
  if (typeof g.atob === 'function') {
    const bin = g.atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  if (g.Buffer) {
    const buf = g.Buffer.from(b64, 'base64')
    return new Uint8Array(buf)
  }
  throw new Error('base64ToUint8Array: neither atob nor Buffer is available in this environment')
}

function assertField(obj: Record<string, unknown>, field: string): void {
  if (!(field in obj) || obj[field] === undefined) {
    throw new Error(`malformed generate result: missing field "${field}"`)
  }
}

/** Validates and decodes a raw `generate` result (already JSON.parse'd) into the viewer's
 * own volume/palette/counts shape. Throws a descriptive Error -- rather than producing a
 * viewer that silently renders nothing -- when a required field is missing, so a caller (the
 * extension) can surface it as a visible error instead of a blank/frozen preview. */
export function decodeGenerateResult(raw: unknown): DecodedResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('malformed generate result: expected a JSON object')
  }
  const obj = raw as Record<string, unknown>
  for (const field of ['bounds', 'blocks', 'baseline', 'palette', 'changed', 'removed']) {
    assertField(obj, field)
  }
  const result = obj as unknown as GenerateResultWire
  const { bounds } = result

  const expectedCells = bounds.sizeX * bounds.sizeY * bounds.sizeZ
  const data = new Uint32Array(expectedCells)
  const baseline = new Uint32Array(expectedCells)
  const changed = new Uint8Array(expectedCells)
  const removed = new Uint8Array(expectedCells)
  // Each of the four is length-checked, not just `blocks`. A short array decodes without
  // complaint into a zero-filled tail, which for `baseline` reads as "the whole far end of the
  // volume was air before the run" and for the masks as "nothing changed there" -- a silently
  // wrong picture rather than an error, which is the failure mode this decoder exists to avoid.
  const cellCounts: Array<[string, number]> = [
    ['blocks', expandCellArray(result.blocks, data, 'blocks')],
    ['baseline', expandCellArray(result.baseline, baseline, 'baseline')],
    ['changed', expandCellArray(result.changed, changed, 'changed')],
    ['removed', expandCellArray(result.removed, removed, 'removed')],
  ]
  for (const [field, count] of cellCounts) {
    if (count !== expectedCells) {
      throw new Error(`malformed generate result: ${field} has ${count} cells, expected ${expectedCells} from bounds`)
    }
  }

  const profile = decodeProfile(result.profile, expectedCells)
  const overflowBlocks = result.overflowBlocks ?? []

  const volume: ViewerVolume = {
    minX: bounds.minX,
    minY: bounds.minY,
    minZ: bounds.minZ,
    sizeX: bounds.sizeX,
    sizeY: bounds.sizeY,
    sizeZ: bounds.sizeZ,
    data,
    baseline,
    changed,
    removed,
    touchCounts: profile?.touchCounts,
    overflowBlocks,
  }

  const palette: ViewerPaletteEntry[] = result.palette.map((entry) => ({
    id: entry.id,
    name: entry.name,
    color: colorForPaletteEntry(entry),
    kind: kindFromWire(entry.kind),
    // Carried through verbatim rather than dropped: block states are what tell a textured pass
    // that this log lies east-west (shapes.ts's rotationForStates). Null for a stateless block,
    // which is most of them.
    states: entry.states,
  }))

  return {
    volume,
    palette,
    counts: {
      changed: result.blocksChanged,
      placed: result.blocksPlaced,
      carved: result.blocksCarved,
      replaced: result.blocksReplaced,
      writesOutOfBounds: result.writesOutOfBounds,
    },
    placementDurationMs: result.placementDurationMs,
    libraryBuildDurationMs: result.libraryBuildDurationMs,
    totalDurationMs: result.totalDurationMs,
    partial: result.partial,
    diagnostics: (result.diagnostics ?? []).map(normalizeDiagnostic),
    featureSeed: result.featureSeed,
    environmentSeed: result.environmentSeed,
    profile,
    origin: result.origin ?? { x: 0, y: 0, z: 0 },
    entries: result.entries ?? [],
    ruleEntries: result.ruleEntries ?? [],
    biomeEntries: result.biomeEntries ?? [],
    environmentBiome: result.environmentBiome ?? null,
    overflowBlocks,
    grown: result.grown ?? false,
    preGrowBounds: result.preGrowBounds ?? null,
  }
}

/** Normalizes a wire DiagnosticWire into a DecodedDiagnostic -- see that type's own doc comment
 * for the fallback this exists to cover: an engine build that predates identifier/typeId/chain/
 * count/position (the old {level,fileId,message}-only shape) still decodes into something
 * panel.ts's Diagnostics section can render sensibly, rather than throwing or showing
 * "undefined" -- identifier falls back to fileId (the closest available "what is this about"),
 * chain falls back to a single-element path ([identifier]), typeId to "", count to 1, position
 * to null (never a guessed {0,0,0} -- see DiagnosticPositionWire's own doc comment for why that
 * would be a lie, not a graceful default). */
function normalizeDiagnostic(d: DiagnosticWire): DecodedDiagnostic {
  const identifier = d.identifier && d.identifier.length > 0 ? d.identifier : d.fileId
  const chain = d.chain && d.chain.length > 0 ? d.chain : [identifier]
  const count = typeof d.count === 'number' && d.count > 0 ? d.count : 1
  return {
    level: d.level,
    fileId: d.fileId,
    identifier,
    typeId: d.typeId ?? '',
    chain,
    count,
    position: d.position ?? null,
    message: d.message,
  }
}

/** Decodes the wire `profile` field into DecodedProfile, or null when profiling was off for
 * this run (the field is absent or explicit null on the wire -- see ProfileResultWire's doc
 * comment). Validates touchCounts against the volume's own cell count with the same
 * "throw rather than silently mis-render" posture as the rest of this module -- a length
 * mismatch here would otherwise index the heatmap against the wrong cells with no error. */
function decodeProfile(wire: ProfileResultWire | null | undefined, expectedCells: number): DecodedProfile | null {
  if (wire === null || wire === undefined) return null
  const touchCounts = new Uint32Array(expectedCells)
  const touchCells = expandCellArray(wire.touchCounts, touchCounts, 'profile.touchCounts')
  if (touchCells !== expectedCells) {
    throw new Error(`malformed generate result: profile.touchCounts has ${touchCells} cells, expected ${expectedCells} from bounds`)
  }
  return {
    touchCounts,
    featureIdentifiers: wire.featureIdentifiers,
    features: wire.features,
    attribution: {
      cell: Uint32Array.from(wire.attribution.cell),
      feature: Uint16Array.from(wire.attribution.feature),
      count: Uint32Array.from(wire.attribution.count),
    },
  }
}

function colorForPaletteEntry(entry: PaletteEntryWire): number {
  return colorForBlockName(entry.name)
}

// --- `atlas` method (textured rendering) ----------------------------------------------------
//
// ONE delivery mechanism for all three hosts. The atlas is not a static asset and cannot be one:
// it is derived from a vanilla resource pack DOWNLOADED at runtime into a per-user cache
// directory, which rules out every
// host-specific asset path this repo has. apps/desktop embeds frontend/dist with
// `//go:embed all:frontend/dist`, so a file that does not exist at build time cannot be in it;
// apps/vscode's webview declares `localResourceRoots: [dist]`, so a file in the user's cache
// directory is not addressable from it without widening that root and its CSP. What all three
// hosts DO share is a request/response channel that already carries structured JSON -- `serve`'s
// newline-delimited JSON-RPC for the extension, the Wails bindings for the desktop app. So the
// atlas travels the same way `environments` does: one method, one response, once per session,
// decoded here.
//
// The PNG rides as base64 inside that JSON. That is a ~33% size penalty on a payload measured in
// hundreds of kilobytes, paid exactly once per session, in exchange for not building three
// separate asset paths.
//
// EVERY PART OF THIS IS OPTIONAL. A host that never calls the method, an engine build that does
// not implement it, an atlas that has not been built, a corrupt PNG: all of them leave the
// viewer in flat-colour mode, which is the DEFAULT and is what every committed wiki image and
// every apps/vscode/docs/panel-*.png still renders with. Textures are an enhancement.

/** The atlas table version this renderer understands. */
export const ATLAS_TABLE_VERSION = 1

/** One packed texture in the atlas image. `x`/`y` are the origin of the cell's INNER content
 * rectangle, border excluded, in texels -- an explicit position rather than something derived
 * from a cell index, so the atlas builder is free to change how it packs without every consumer
 * having to agree on the arithmetic. */
export interface AtlasCellWire {
  /** The resource-pack texture path these pixels came from, without extension. Not consumed by
   * the renderer; it is what makes a cell identifiable in a diagnostic. */
  path?: string
  x: number
  y: number
  /** How this texture's own alpha says it must be drawn -- measured by the builder rather than
   * declared anywhere in a resource pack. The renderer batches per BLOCK, so it reads
   * `AtlasBlockWire.render` (the strictest of a block's faces) instead; this is here for a
   * future per-face split. */
  render?: AtlasRenderMode
  /** The cell's alpha-aware average colour, `#rrggbb`. */
  color?: string
  /** True when the texture measures close enough to neutral that it is almost certainly baked
   * greyscale awaiting a runtime tint. The signal, not the instruction -- what to multiply by
   * is the per-face tint channel on the block. */
  grey?: boolean
}

/** How a block's faces must be composited. `opaque` and `cutout` share one alpha-tested draw
 * pass (an opaque texel has alpha 1, so the alpha test never rejects it); `translucent` gets its
 * own blended pass drawn afterwards -- see viewer.ts's TRANSLUCENT_* constants for the ordering
 * approximation that pass makes and what it costs. An unrecognised value is treated as
 * `opaque`, which is what every block rendered as before this existed. */
export type AtlasRenderMode = 'opaque' | 'cutout' | 'translucent'

/** One block's per-face lookup. Face keys are Bedrock's own spellings -- up, down, north, south,
 * east, west. A face the builder could not resolve is simply ABSENT, which the renderer draws
 * with the white cell and the block's flat palette colour rather than with a wrong texture.
 *
 * `'*'` is accepted on `faces` and `tint` as "every face this entry does not name". Vanilla's
 * own table never emits it -- the builder always writes all six -- but a behaviour pack's
 * `minecraft:material_instances` is literally keyed that way, so the shape is here for the
 * pack-defined blocks that will arrive through the same table. */
export interface AtlasBlockWire {
  faces: Readonly<Record<string, number>>
  /** The terrain_texture.json key each face resolved through. Not consumed by the renderer;
   * a block-state table needs it to find that key's other variants. */
  keys?: Readonly<Record<string, string>>
  /** The tint CHANNEL each face's texel must be multiplied by -- a name, not a colour, because
   * the real multiplier depends on biome. "none" for a face already the colour it should be. */
  tint?: Readonly<Record<string, string>>
  /** Per tinted face, a concrete `#rrggbb` multiplier the builder MEASURED, chosen so the face
   * renders at the colour vanilla renders it in a default biome.
   *
   * This is what the renderer actually multiplies by, in preference to anything of its own: the
   * bench has one biome at a time and no per-cell biome map to sample, so a measured
   * default-biome multiplier is strictly better than a hand-picked constant. colors.ts's own
   * channel table is the fallback for a table that does not carry this. */
  tint_color?: Readonly<Record<string, string>>
  /** The strictest render method among the block's faces. */
  render?: AtlasRenderMode
  resource_key?: string
  /** The block's GEOMETRY, in the vocabulary `block/render.go` and `shapes.ts` share --
   * `full_block`, `cross`, or `unsupported` (a resource-pack model, drawn as a textured cube).
   *
   * OPTIONAL, and vanilla's own table does not carry it: a vanilla block's shape is not
   * declared anywhere in a resource pack, so shapes.ts resolves those from its own name table.
   * This field is the seam for the other half -- a PACK-defined block, whose shape only its
   * behaviour pack knows and which `Palette.BlockRender(name)` already classifies. A table that
   * carries it needs no renderer change to draw a pack's cross-shaped block as a cross. */
  shape?: string
}

/** One tint channel's documentation, as the table carries it. */
export interface AtlasTintWire {
  /** `#rrggbb` -- the multiplier to use when nothing better is known. */
  default?: string
  source?: string
}

/** The `atlas.json` table. */
export interface AtlasTableWire {
  /** Bumped whenever a consumer would mis-read an older table. This decoder REFUSES a version
   * it does not know rather than guessing -- a silently mis-decoded atlas is a preview that
   * looks plausible and is wrong, which is worse than no textures at all. */
  version: number
  /** The resource-pack tag the textures came from, for diagnostics. */
  tag?: string
  /** "vanilla" for a bedrock-samples pack, "pack" for the pack under test's own. */
  source?: string

  /** Edge length of one cell's content, in texels (16 for vanilla block textures). */
  cell: number
  /** Texels of duplicated edge pixels around each cell. */
  border?: number
  /** cell + 2 * border. */
  stride?: number
  /** The UV inset, in texels, the table asks consumers to apply -- 0.5 for the usual half-texel
   * inset. Absent falls back to 0 when there is a border to absorb the rounding and 0.5 when
   * there is not. */
  inset?: number
  /** The atlas image's dimensions in texels. Checked against the decoded PNG. */
  width: number
  height: number
  cols: number
  rows: number

  /** Indexed by cell number: every integer anywhere else in the table indexes into this. */
  cells: readonly AtlasCellWire[]
  /** terrain_texture.json key -> its first variant's cell. Not consumed by the renderer. */
  textures?: Readonly<Record<string, number>>
  /** terrain_texture.json key -> every variant's cell, for keys with more than one. Piece D's
   * input; not consumed by this renderer, which is block-state-blind. */
  variants?: Readonly<Record<string, number[]>>
  blocks: Readonly<Record<string, AtlasBlockWire>>
  tints?: Readonly<Record<string, AtlasTintWire>>

  /** Cell index of an all-white, fully opaque cell, if the builder packed one.
   *
   * OPTIONAL, and synthesized by the renderer when absent (viewer.ts appends one row to the
   * uploaded texture and paints a cell white). The renderer needs one so a block the table says
   * nothing about -- a pack's own block, an id newer than the atlas -- can render in the SAME
   * draw call as everything else, sampling white and multiplying by its flat palette colour,
   * which reproduces flat-colour mode exactly for that block. A builder that packs one saves the
   * renderer a texture rewrite on every load; the renderer does not require it. */
  white?: number
}

/** The `atlas` method's response envelope: the table plus the atlas image itself. */
export interface AtlasWire {
  table: AtlasTableWire
  /** base64 of atlas.png. */
  png: string
}

/** A validated atlas, ready for viewer.ts to upload and compile against a palette. */
export interface DecodedAtlas {
  table: AtlasTableWire
  /** The decoded PNG bytes -- NOT a data: URI. viewer.ts turns these into a texture via a Blob
   * and `createImageBitmap`, which is not a resource fetch and so is not subject to the VS Code
   * webview's `default-src 'none'` CSP. Handing the webview a `data:` image instead would have
   * required widening that CSP with an `img-src data:`, and the CSP in apps/vscode's
   * previewPanel.ts is deliberately as narrow as it is. */
  png: Uint8Array
}

/** Parses a `#rrggbb` (or bare `rrggbb`) colour into packed 0xRRGGBB, or null when it is not
 * one. Used for the table's measured tint multipliers -- a malformed entry falls back to the
 * renderer's own channel table rather than throwing the whole atlas away. */
export function parseHexColor(value: string | undefined): number | null {
  if (value === undefined) return null
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return parseInt(hex, 16)
}

/**
 * Validates and decodes an `atlas` method response. Throws a descriptive Error rather than
 * returning a half-usable atlas -- every caller's recovery is the same and is always available
 * (stay in flat-colour mode and say why once), so there is nothing to be gained by limping on
 * with a table whose geometry does not add up.
 */
export function decodeAtlas(raw: unknown): DecodedAtlas {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('malformed atlas: expected a JSON object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.png !== 'string' || obj.png.length === 0) {
    throw new Error('malformed atlas: missing base64 "png"')
  }
  if (typeof obj.table !== 'object' || obj.table === null) {
    throw new Error('malformed atlas: missing "table"')
  }
  const table = obj.table as AtlasTableWire
  if (table.version !== ATLAS_TABLE_VERSION) {
    throw new Error(`unsupported atlas table version ${String(table.version)} -- this renderer understands version ${ATLAS_TABLE_VERSION}`)
  }
  for (const field of ['cell', 'cols', 'rows', 'width', 'height'] as const) {
    const v = table[field]
    if (!Number.isInteger(v) || (v as number) < 1) {
      throw new Error(`malformed atlas: "${field}" must be a positive integer, got ${String(v)}`)
    }
  }
  if (!Array.isArray(table.cells) || table.cells.length === 0) {
    throw new Error('malformed atlas: "cells" must be a non-empty array')
  }
  for (let i = 0; i < table.cells.length; i++) {
    const cell = table.cells[i] as AtlasCellWire
    if (!Number.isInteger(cell?.x) || !Number.isInteger(cell?.y) || cell.x < 0 || cell.y < 0 || cell.x + table.cell > table.width || cell.y + table.cell > table.height) {
      throw new Error(`malformed atlas: cell ${i} at (${String(cell?.x)}, ${String(cell?.y)}) does not fit inside a ${table.width}x${table.height} image`)
    }
  }
  if (typeof table.blocks !== 'object' || table.blocks === null) {
    throw new Error('malformed atlas: "blocks" must be an object')
  }
  if (table.white !== undefined && (!Number.isInteger(table.white) || table.white < 0 || table.white >= table.cells.length)) {
    throw new Error(`malformed atlas: "white" must be a cell index in [0, ${String(table.cells.length)}), got ${String(table.white)}`)
  }
  return { table, png: base64ToUint8Array(obj.png) }
}
