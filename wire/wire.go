// Package wire is the single, importable definition of the `generate` JSON wire contract --
// the request/response shape cmd/featurelab's `generate` subcommand and `serve` "generate"
// method, and apps/desktop's Wails-bound App.Generate, all produce byte-for-byte identically.
// Before this package existed, cmd/featurelab/generate.go (package main, unimportable) and
// apps/desktop/generate.go each declared their own copy of GenerateParams/Bounds/
// GenerateOutput/buildConfig; apps/desktop/generate.go's own header comment called that out as
// a seam that should be factored out once something other than cmd/featurelab could own it.
// This package is that seam: both callers now import wire and share one definition, so the two
// apps can no longer drift apart on what a `generate` request accepts or a response contains.
//
// # Field naming
//
// Every type on this contract is exported with an explicit `json:"..."` tag, and every tag is
// lowerCamelCase -- including wgen.BlockPos and block.Entry, which historically had NO struct
// tags at all and therefore serialized under Go's exported-field capitalization (X/Y/Z,
// ID/Name/States/Kind), the one inconsistency in an otherwise all-camelCase contract. A
// consumer (frontend/src/protocol.ts) used to special-case those two types; it no longer needs
// to. The one deliberate exception is documented under "MolangScope" below.
//
// # Request: GenerateParams
//
// GenerateParams is both the CLI generate subcommand's flag set and serve's "generate" JSON-RPC
// params, field-for-field identical on purpose (see GenerateParams's own doc comment) -- a pack
// author moving between the CLI, the VS Code extension, and the desktop app never has the same
// knob mean something different. String fields use "" as "not given" (every valid value is
// non-empty); Origin/Size are "x,y,z" / "XxYxZ" decimal strings (ParseOrigin/ParseSize); Seed is
// a pointer because 0 is a legitimate seed distinct from "use the preset default".
//
// MinY, biomeId/biomeTags, and materials are the environment-override knobs session.Config
// already carried internally but this contract did not yet expose -- see GenerateParams's own
// doc comment for the full field-by-field shape and fallback rules. Every one of them is
// OPTIONAL; omitted always means "use the preset's default", the same convention every other
// field on this contract already follows -- never a zero value silently overriding a preset
// (that is exactly why minY and materials.seaFloorDepth are pointers rather than bare ints/
// floats: 0 is a legitimate value for both, distinct from "not given").
//
// writeBudget/delegationBudget/placementTimeLimitMs are the three placement budgets
// (session.Config.WriteBudget/DelegationBudget/PlacementTimeLimitMs) that bound a runaway
// placement chain -- max SetBlock attempts, max nested feature delegations, and a wall-clock
// deadline in milliseconds, respectively. All three follow the same "pointer, omitted means the
// existing default" convention as minY/seed: 0 is a legitimate (if extreme -- an immediate abort)
// budget value, distinct from "not given", so a bare int could not tell the two apart. Defaults
// when omitted: writeBudget 4000000 (session.DefaultWriteBudget), delegationBudget 2000000
// (session.DefaultDelegationBudget), placementTimeLimitMs 8000 (session.
// DefaultPlacementTimeLimitMs). Exceeding any of the three never produces an empty response: the
// blocks placed before the budget was hit are still returned (result.partial is true), and
// diagnostics gets one "error" Diagnostic naming which budget was hit, the count reached against
// its configured limit, and how many repeat placements completed before the one that tripped it --
// see "# Diagnostics" below for the full Diagnostic shape that entry (and every other placement
// diagnostic) uses.
//
// # Response: GenerateOutput
//
// GenerateOutput is Bounds + the seeds actually resolved, promoted alongside every field
// *session.Result itself exports. The full set of top-level keys on the wire:
//
//	bounds            {minX,minY,minZ,sizeX,sizeY,sizeZ} int -- see Bounds
//	featureSeed       uint32  -- the seed actually used (fills in the preset default when the
//	                             request left Seed unset)
//	environmentSeed   int32
//	blocks            run-length encoded [sizeX*sizeY*sizeZ]int32 -- current block.ID per cell,
//	                             see "Block array indexing" and "Per-cell array encoding" below
//	baseline          run-length encoded, block.ID per cell BEFORE the feature/rule ran,
//	                             same indexing as blocks. Carried so a viewer can shape/colour a
//	                             carved cell, whose CURRENT id is air and carries no shape of its
//	                             own.
//	palette           []{id,name,states,kind} -- decodes every block.ID appearing in blocks/
//	                             baseline; see block.Entry and "Kind encoding" below
//	origin            {x,y,z} int -- the placement origin actually used, see wgen.BlockPos
//	placements        []{origin:{x,y,z}, returned:{x,y,z}|null} -- one entry per repeat iteration
//	changed           run-length encoded -- 1 per cell where blocks[i] != baseline[i], see
//	                             "Changed/Removed masks" below
//	removed           run-length encoded -- 1 per cell where baseline[i] was non-air and
//	                             blocks[i] is air ("carved out"), same indexing/encoding as
//	                             changed
//	blocksChanged     int -- total cells where blocks[i] != baseline[i]
//	blocksPlaced      int -- baseline air -> result non-air
//	blocksCarved      int -- baseline non-air -> result air
//	blocksReplaced    int -- baseline non-air -> result non-air, different id
//	writesOutOfBounds int -- writes attempted outside the previewed volume (dropped from `blocks`,
//	                             but see "Out-of-bounds capture" below -- no longer lost entirely)
//	overflowBlocks    []{x,y,z,id} -- every out-of-bounds write captured, see "Out-of-bounds
//	                             capture" below. Empty, never null, when writesOutOfBounds is 0
//	placementDurationMs    float64 -- see "Duration fields" below
//	libraryBuildDurationMs float64 -- see "Duration fields" below
//	totalDurationMs        float64 -- see "Duration fields" below
//	partial           bool -- true if a write/delegation/wall-clock budget cut the run off early
//	diagnostics       []{level,fileId,identifier,typeId,chain,count,position,message} -- see
//	                             "# Diagnostics" below for what each field means and when it's
//	                             present
//	entries           []{fileId,identifier,typeId} -- every loaded features/*.json entry; the
//	                             built wgen.IFeature itself is NOT serialized (see
//	                             features.Entry's doc comment for why)
//	ruleEntries       []{fileId,identifier,rule} -- every loaded feature_rules/*.json entry, rule
//	                             is null when the file failed to parse/build
//	activeRule        {identifier,placesFeature,placementPass,biomeFilter,distribution}|null --
//	                             the resolved rule when the request's mode was "rule", else null.
//	                             distribution's Molang-valued fields serialize as documented
//	                             under "Opaque Molang values" below
//	unresolvedTags    []string -- sorted {tags:"..."} descriptor expressions that failed to
//	                             resolve during palette interning
//	biomeEntries      []{fileId,identifier,biome}  -- every loaded biomes/*.json entry, biome
//	                             null if the file failed to parse (see session.biomes.Entry)
//	environmentBiome  {identifier,fileId,tags,surfaceBuilder,surfaceBuilderType,climate,
//	                             replaceBiomes}|null -- the resolved biome for the request's
//	                             biomeId, when it named one the pack actually defines; null
//	                             when biomeId was "" or unresolved (see "biomeId" above)
//	molangScope       see "MolangScope" below
//	profile           see "Profile" below -- absent/null unless GenerateParams.Profile was true
//
// entries/ruleEntries/biomeEntries are null when the request set `omitCatalogs` (see
// GenerateParams.OmitCatalogs): they describe the loaded PACK rather than the run, so a client
// driving repeated generates against one loaded pack can ask for them once. Nothing else in the
// response changes.
//
// # Block array indexing
//
// blocks/baseline/changed/removed/profile.touchCounts all share one flat indexing over the
// volume described by bounds: Y is the OUTER (slowest-varying) axis, then Z, then X (fastest-
// varying) --
//
//	index(x, y, z) = (y - bounds.minY) * bounds.sizeX * bounds.sizeZ
//	               + (z - bounds.minZ) * bounds.sizeX
//	               + (x - bounds.minX)
//
// mirroring volume.Volume's own internal layout exactly (see volume.go's index method) -- these
// arrays are that package's Data()/Diff() output passed straight through, never re-laid-out.
//
// # Per-cell array encoding
//
// blocks, baseline, changed, removed and profile.touchCounts are RUN-LENGTH ENCODED, as an
// object holding value/run-length pairs:
//
//	"blocks": {"rle": [0, 40960, 5, 1024, 0, 3496960]}
//
// -- "40960 cells of 0, then 1024 of 5, then 3496960 of 0". Run lengths are at least 1 and the
// pairs are exhaustive, so a decoder can recover the cell count by summing every second element
// and should check it against sizeX*sizeY*sizeZ. See package featurelab-go/rle for the encoder,
// the measurements that motivated it (a profiled 96x384x96 run: 26 MB of JSON, blocks alone 8.2
// MB, encoding to 175 KB), and why the shape is an object rather than a bare array of numbers.
//
// A decoder written against an OLDER response still has two other shapes to handle, and this
// repo's own decoders accept all three: a dense array of numbers (what blocks/baseline used to
// be) and a base64 string (what changed/removed used to be -- see the section below).
//
// # Changed/Removed masks
//
// These two used to travel as Go []byte, which encoding/json renders as a base64 STRING rather
// than an array of numbers -- worth knowing when reading a captured response from before the
// encoding change, since nothing about the field name says so. Each decodes to one byte per
// cell (same indexing as blocks), 0 or 1: changed[i]
// is 1 whenever blocks[i] != baseline[i]; removed[i] is 1 for the subset of that where baseline
// was non-air and the result is air (a carved cell -- invisible in a plain block-id mesh, since
// its current id is air and draws no geometry). See volume.Volume.Diff's doc comment for the
// full added/removed/replaced/changed classification these masks and the blocksXxx counts above
// are both derived from.
//
// # Duration fields
//
// This used to be one field, durationMs, meaning two different things depending on which mode
// produced it. A one-shot `generate` call (cmd/featurelab's `generate` subcommand, apps/desktop's
// App.Generate) rebuilds the feature/structure/rule libraries from source files on every call --
// measured on a large add-on, that build is ~94% of the call's total time (session.
// Workspace's own doc comment) -- while a `serve` "generate" call reuses a session.Workspace whose
// libraries were already built once, earlier, by "loadPack". durationMs only ever timed the
// placement itself, so it read honestly small (~1ms) for a `serve` regeneration and misleadingly
// just as small for the placement slice of a one-shot call that, wall-clock, took over a second --
// with nothing on the wire distinguishing which situation produced the number.
//
// placementDurationMs and libraryBuildDurationMs now report those two phases separately, and
// totalDurationMs is their sum -- computed here so a consumer never has to add them itself:
//
//	placementDurationMs    -- THIS run's placement only: feature/rule Place calls, palette
//	                           interning, and the baseline diff. Excludes library build cost
//	                           entirely, in both modes. What a pack author iterates against turn
//	                           to turn once a pack is loaded -- the headline number.
//	libraryBuildDurationMs -- parsing/building the feature/structure/rule libraries this run
//	                           placed against. In `serve` mode this is 0 on EVERY "generate" call:
//	                           the cost was already paid once at "loadPack", earlier, outside this
//	                           call, and is NOT part of a regeneration. Only a one-shot `generate`
//	                           (session.Generate, the entry point cmd/featurelab's `generate`
//	                           subcommand and apps/desktop's App.Generate both use) reports a
//	                           nonzero value here.
//	totalDurationMs        -- libraryBuildDurationMs + placementDurationMs. Equals
//	                           placementDurationMs exactly in `serve` mode (libraryBuildDurationMs
//	                           is 0 there); in one-shot mode it is what the command's own generate
//	                           step actually spent inside this process, reconcilable against that
//	                           command's own wall-clock time.
//
// # Diagnostics
//
// Each entry in the response's diagnostics array is session.Diagnostic:
//
//	{
//	  "level":      "warning" | "error",
//	  "fileId":     string,
//	  "identifier": string | absent,
//	  "typeId":     string | absent,
//	  "chain":      [string, ...] | absent,
//	  "count":      int,               -- always present, always >= 1
//	  "position":   {"x":int,"y":int,"z":int} | null,
//	  "message":    string
//	}
//
// fileId is the identifier/file of whatever the CALLER asked to run -- a build-time diagnostic's
// source file, or, for a placement diagnostic, the root feature/rule identifier the request's
// feature/rule field named. For a diagnostic raised from somewhere inside a multi-level delegation
// chain, fileId is deliberately NOT what actually failed: a scatter_feature that delegates into a
// composite that delegates into a single_block_feature which then refuses to place has fileId
// naming the ROOT (e.g. "wiki:highland.main"), while identifier/typeId below name the
// single_block_feature that actually raised the diagnostic. Reading fileId alone for a nested
// failure asserts something false -- that the root IS what failed -- which sends a reader to the
// wrong file; that conflation is exactly what identifier/typeId/chain exist to fix.
//
// identifier/typeId are the identifier and type of the feature that ACTUALLY raised this
// diagnostic -- chain's LAST entry, when chain is present. Both are absent (omitted, not empty
// string) for a diagnostic that never ran inside a placement (a structure/feature/rule/biome
// build error, a material-slot warning) -- those have no delegation chain to name a leaf of.
//
// chain is the full delegation chain from the root feature/rule (chain[0], matching fileId in the
// common case) down to and including the feature that actually raised this diagnostic
// (chain[len(chain)-1], always equal to identifier) -- root first, identifiers only, so a panel
// can render it directly as a path without a second lookup. Absent under the same condition as
// identifier/typeId. Backed by the engine's own always-on delegation-chain frame stack (see
// featurelab-go/profiler's package doc comment, "Always-on delegation chain") -- maintained
// regardless of whether the request's profile field was set, so this is exactly as detailed with
// profiling off as on.
//
// position is the block position placement had reached the FIRST time this (deduplicated)
// diagnostic occurred -- a structured {x,y,z} object, NEVER text baked into message, so a
// consumer can jump/highlight it directly. Explicit JSON null (not an absent key, and never the
// zero vector {0,0,0} standing in for "unknown") when this diagnostic is not tied to one specific
// write attempt -- a build-time diagnostic, or a delegation-budget/wall-clock-deadline diagnostic,
// which has a chain but no single position.
//
// count is how many times an diagnostic identical to this one (same level/identifier/typeId/
// message/chain) occurred during this run, deduplicated on the ENGINE side rather than left for a
// consumer to group -- a single scatter_feature iterating thousands of times can raise the exact
// same nested failure at every one of them, and repeating that diagnostic thousands of times over
// in the array would be an unreadable wall, not useful detail. Always present and always >= 1 -- a
// diagnostic that occurred once still reports count: 1, never 0 or omitted.
//
// message is the failure text alone -- it does NOT repeat identifier or typeId (an earlier
// revision of this contract prepended "typeId: " to message, which is how a diagnostic naming the
// wrong feature -- fileId's root instead of the nested feature that actually failed -- read as
// asserting the root WAS that type; see this package's task notes for the motivating
// "wiki:highland.main: minecraft:single_block_feature: ..." example). The structured fields
// carry identity; message carries only what went wrong.
//
// A budget-exceeded diagnostic (level "error", raised at most once per run since a single panic
// ends placement entirely) follows this same shape: identifier/typeId/chain name whichever
// feature was executing when the budget was hit (when available -- a write-budget diagnostic
// always has a position, a delegation-budget/deadline one never does, per the position field's own
// rule above), and message states which budget was hit, the count reached against its configured
// limit, and how many repeat placements completed successfully before the one that tripped it --
// e.g. "write budget hit at 4000000 of 4000000 block writes; 0 repeat placement(s) completed
// before stopping -- ...". That distinction (0 completed vs. all-but-one completed) is what lets a
// caller tell "raise the budget slightly" from "this is runaway recursion" -- see "writeBudget/
// delegationBudget/placementTimeLimitMs" above.
//
// # Out-of-bounds capture
//
// The bench a `generate` request describes (bounds/origin/size) is an artefact of THIS TOOL, not
// of the feature being previewed -- the real game has no bench walls, and a feature writing past
// the previewed volume's edge (a scatter reaching into a neighbouring chunk, a structure that
// doesn't fit) is completely legitimate content, not a mistake. Historically those writes were
// simply dropped: volume.Volume.SetBlockAt counted them (writesOutOfBounds) but discarded the
// block itself, so the preview had no way to show what actually got refused.
//
// overflowBlocks (backed by volume.Volume.Overflow, session.Result.OverflowBlocks) fixes the
// "discarded" half of that without touching the "counted" half or anything about how the bench
// itself behaves: every out-of-bounds SetBlock call is captured -- world position plus the block
// id that would have been written, deduplicated per unique position (a repeat write to the same
// out-of-bounds cell updates that entry in place, last write wins, exactly like an in-bounds cell
// would) -- and returned on the wire alongside the usual in-bounds blocks/baseline arrays. id
// decodes against the SAME palette array every in-bounds cell already uses; x/y/z are absolute
// world coordinates, NOT relative to bounds, since a captured position is by definition outside
// it and cannot be flattened into the same (y,z,x) cell-index scheme blocks/baseline/changed/
// removed share (see "Block array indexing" above) -- a consumer must render each entry at its
// own world position, not index it into that grid.
//
// Critically, this changes NOTHING about what a feature can read or how it behaves:
// volume.Volume.GetBlock/Contains are completely unmodified by this capture -- a feature querying
// a position past the bench edge still sees the same OOB sentinel it always has, makes the same
// placement decisions, and draws the same random numbers, so generation stays bit-identical to
// before overflow capture existed (the goldentest placement digests are unchanged by it). Only what a VIEWER is told about writes that
// were ALREADY going to be dropped changed. This is deliberately the opposite of growing the
// volume itself, which WOULD change reads and is therefore its own, separate action -- see
// "Grow-and-regenerate" below.
//
// # Grow-and-regenerate
//
// Capturing overflow (above) shows what spilled out without changing the run that produced it.
// Sometimes that is not what's wanted: a pack author may want to see the feature placed as if the
// bench were actually big enough to hold it, which requires a SECOND, larger bench and therefore a
// genuinely different placement -- different volume bounds means GetBlock/Contains answer
// differently at every position near the old edge, which can change a feature's decisions and, for
// anything that draws random numbers conditioned on what it read, its RNG draws too. This is never
// "the same result, viewed wider" -- it is a new run that happens to share the same seed/origin/
// feature as the first.
//
// wire.RunGenerateGrown/RunGenerateGrownFromWorkspace implement this as two ordinary generate
// calls: run once with the request's own bounds; if the result captured any overflowBlocks,
// compute a larger bench that contains both the original bounds and every captured position
// (session.GrowBounds -- horizontal growth stays centered on the request's own origin, vertical
// growth is a plain MinY/size extension) and run AGAIN at that size. The response, GrownGenerateOutput,
// embeds a normal GenerateOutput (the SECOND run's own full result -- blocks, diagnostics,
// everything, at the larger size) plus two fields that exist specifically so a caller cannot
// mistake this for the first behaviour:
//
//	grown          bool           -- true only when a second, larger run actually happened
//	                                  (false when the first run captured no overflow at all, in
//	                                  which case *GenerateOutput IS just that unchanged first
//	                                  result -- nothing to grow for)
//	preGrowBounds  *Bounds        -- the ORIGINAL (pre-grow) bench bounds, present only when
//	                                  grown is true, so a caller can report "grew from 32x48x32 to
//	                                  64x64x64" rather than the new size alone
//
// A consumer MUST use these two fields to label this result as a re-run in its own UI, not as a
// wider view of whatever the previous "generate" call already showed: a grown re-run can produce
// DIFFERENT captured content than the original capture, which is exactly why the two stay
// separate features rather than one "just show me everything" toggle.
//
// # Kind encoding
//
// block.Entry.Kind is a small integer, block.Kind's own iota order: 0 solid, 1 air, 2 liquid,
// 3 plant, 4 glass (block.KindSolid..block.KindGlass). A consumer that doesn't recognize a value
// should treat it as solid, the same fallback block.Kind's own classifier uses for an unknown
// block name.
//
// # Opaque Molang values
//
// activeRule.distribution (a features.ScatterDistribution) carries per-axis
// features.CoordinateRange entries whose Min/Max, and a top-level Iterations, are
// *features.MolangExpr -- either a constant or a COMPILED Molang program. MolangExpr's fields
// are all unexported (there is no general JSON representation of a compiled program), so every
// one of those fields serializes as an empty JSON object `{}` regardless of what expression it
// actually holds. This is intentional,
// not a bug: the surrounding kind/stepSize/gridOffset/chance fields ARE meaningful and tagged
// normally; only the compiled-expression leaves are opaque. A consumer that needs the actual
// Molang source should read the pack's own feature_rules/*.json file, not this field.
//
// # MolangScope
//
// Result.MolangScope is a *molang.Scope from the separate molang-go module (see this module's
// go.mod replace directive) -- outside featurelab-go and this consolidation's scope. Its fields
// (Temp/Variable/Query, all map[string]float64) are NOT camelCase and are the one deliberate
// exception to this contract's naming convention: they are that module's own exported field
// names, unmodified. An empty, untouched scope is still present (not null) when neither a
// feature nor a rule was selected.
//
// # Profile
//
// profile is a *profiler.ProfileResult, present only when GenerateParams.Profile was true AND a
// feature or rule was actually selected; absent (Go nil, encodes as JSON null) otherwise. Its
// own fields (touchCounts, featureIdentifiers, features, attribution) were already tagged
// lowerCamelCase before this consolidation -- see profiler.ProfileResult's doc comment for the
// per-field shape, including the sparse cell/feature/count parallel-array attribution table.
// Each features[] row may carry stops ({reason, detail, count, ordinal?}), omitted when the
// feature never stopped at a gate -- see profiler.StopStat.
package wire

import "github.com/stirante/featurelab/session"

// GenerateParams is the "generate" request shape shared verbatim between the CLI's `generate`
// subcommand flags and serve's "generate" JSON-RPC method params -- one place decides what a
// caller may ask for, so the desktop app and the VS Code extension (both of which drive this
// same contract, per this package's own doc comment) get exactly the same knobs a command-line
// user has.
//
// String fields use "" as "not given" (every valid value is non-empty); Seed is a pointer
// because 0 is a legitimate seed distinct from "use the preset default" (which is 1, not 0 --
// see session.DefaultConfig).
//
// MinY, BiomeID/BiomeTags, and Materials are the environment-override knobs session.Config
// already carried (MinY, EnvironmentBiomeID, BiomeOverride, MaterialOverride -- see
// session.Config's own doc comment) that this contract did not yet expose -- every one of them
// is OPTIONAL and omitted means "use the preset's default", never a zero value silently
// overriding a preset:
//
//   - MinY is a pointer for the same reason Seed is one -- 0 is a legitimate world-floor
//     value (e.g. an "ocean" preset previewed down to bedrock) distinct from "not given".
//   - BiomeID SELECTS a loaded pack biome (session.Config.EnvironmentBiomeID -- materials +
//     biome-identity source 2, layered onto the preset's own native source 1, see env.
//     MaterialSlots's own doc comment for the full pipeline). "" means no pack biome selected
//     (preset default, unchanged). A non-"" id that no loaded biomes/*.json file declares is
//     NOT a silent fallback: RunGenerate/RunGenerateFromWorkspace still succeed, but the
//     response's diagnostics gets an "error" Diagnostic naming the id, and materials/tags fall
//     back to the preset default exactly as if BiomeID were "" -- see
//     session.Config.EnvironmentBiomeID's own doc comment. Reporting the id is deliberate:
//     an unknown biome id is never swallowed silently.
//   - BiomeTags, independent of BiomeID, is a tags-ONLY manual override (source 3) of
//     query.has_biome_tag/any_tag/all_tags on top of whichever of source 1/2 above is active --
//     BuildConfig wires it to session.Config.BiomeOverride with its ID left "" so session.
//     generate's own default (preset, or the selected pack biome's own identifier) supplies
//     the id unchanged; only the tag set is overridden. nil/empty means no override at all.
//   - Materials carries the six minecraft:surface_builder slots (see env.MaterialSlots's own
//     doc comment for what each one feeds); every field inside it is independently optional
//     and merges over whichever of source 1/2 above is active, one slot at a time (env.
//     MergeMaterialSlots) -- explicit per-slot overrides here always win, even over a selected
//     pack biome's own materials. An unrecognized block name in any slot is not rejected and
//     does not silently fall back -- it is interned as given and reported as a "warning"
//     Diagnostic naming the slot and the offending value (env.InternMaterialSlots's warn
//     callback, wired to session.Result.Diagnostics).
type GenerateParams struct {
	Feature string  `json:"feature,omitempty"`
	Rule    string  `json:"rule,omitempty"`
	Env     string  `json:"env,omitempty"`
	Seed    *uint32 `json:"seed,omitempty"`
	Origin  string  `json:"origin,omitempty"` // "x,y,z"
	Size    string  `json:"size,omitempty"`   // "XxYxZ"
	// MinY overrides the preset's default world-floor Y. nil means preset default.
	MinY *int `json:"minY,omitempty"`
	// BiomeID selects a loaded pack biome by identifier (materials + biome-identity source 2).
	// "" means no pack biome selected -- see this type's doc comment for the unknown-id
	// diagnostic and how this combines with BiomeTags.
	BiomeID string `json:"biomeId,omitempty"`
	// BiomeTags is a tags-only manual override of query.has_biome_tag/any_tag/all_tags,
	// independent of BiomeID. nil/empty means no override -- see this type's doc comment for
	// how it combines with BiomeID.
	BiomeTags []string `json:"biomeTags,omitempty"`
	// Materials overrides individual minecraft:surface_builder slots. nil means every slot
	// uses the preset default; a non-nil Materials still leaves any of its own nil fields at
	// the preset default -- see Materials's own doc comment.
	Materials *Materials `json:"materials,omitempty"`
	Repeat    int        `json:"repeat,omitempty"`
	// Profile arms the profiler (session.Config.Profiling) for this run and includes the result
	// under the response's "profile" field -- off by default, matching session.Config.
	// Profiling's own "off costs nothing" contract.
	Profile bool `json:"profile,omitempty"`

	// WriteBudget/DelegationBudget/PlacementTimeLimitMs override session.Config's same-named
	// budgets (session.Config.WriteBudget/DelegationBudget/PlacementTimeLimitMs) -- see this
	// package's doc comment ("writeBudget/delegationBudget/placementTimeLimitMs") for what each
	// bounds, their defaults, and what exceeding one produces. Pointers for the same reason Seed/
	// MinY are: 0 is a legitimate (if extreme) budget value distinct from "not given" -- nil means
	// the preset default, exactly like every other optional field on this contract.
	WriteBudget          *int `json:"writeBudget,omitempty"`
	DelegationBudget     *int `json:"delegationBudget,omitempty"`
	PlacementTimeLimitMs *int `json:"placementTimeLimitMs,omitempty"`

	// OmitCatalogs drops `entries`, `ruleEntries` and `biomeEntries` from the response -- the
	// three catalogues of what the loaded pack contains, as opposed to anything about this run.
	//
	// They are the dominant cost of a repeated preview. On a large add-on, a 96x384x96 response
	// can be close to a megabyte of compact JSON, of which `entries` alone is over half: one row
	// per features/*.json file, thousands of them, re-serialised, re-piped and re-parsed on every
	// regenerate even though the set can only change when the pack is loaded again. A client
	// that drives many generates against one loaded pack -- which is what the editor
	// integrations do on every save -- can fetch them once and set this on everything after.
	//
	// Off by default, so a one-shot CLI caller and any client that has not been taught about
	// this keep getting the complete response they always got. Omission is a null field rather
	// than an absent one, so a decoder that ignores the flag's existence still sees the key.
	OmitCatalogs bool `json:"omitCatalogs,omitempty"`
}

// Materials is GenerateParams.Materials's shape -- session.Config.MaterialOverride
// (env.MaterialOverride) promoted onto the wire with explicit lowerCamelCase tags, since
// env.MaterialOverride itself carries none (see this package's "Field naming" doc comment for
// why every wire type gets its own tags rather than relying on a domain type's). Every field is
// an independently optional pointer: nil means "use whichever of the preset's native materials
// or an earlier override layer was already active for that slot" (env.MergeMaterialSlots merges
// one field at a time, never all-or-nothing). SeaFloorDepth is a pointer for the same reason
// MinY is -- 0 is a legitimate depth (no sea floor band at all) distinct from "not given".
type Materials struct {
	TopMaterial        *string  `json:"topMaterial,omitempty"`
	MidMaterial        *string  `json:"midMaterial,omitempty"`
	FoundationMaterial *string  `json:"foundationMaterial,omitempty"`
	SeaFloorMaterial   *string  `json:"seaFloorMaterial,omitempty"`
	SeaMaterial        *string  `json:"seaMaterial,omitempty"`
	SeaFloorDepth      *float64 `json:"seaFloorDepth,omitempty"`
}

// Bounds is the generated volume's world-space extent -- origin and size together, the shape a
// mesher/viewer needs to place blocks/baseline back into world space. session.Result itself
// only exposes this via its unmarshalable Volume field (json:"-"), so GenerateOutput adds it
// explicitly.
type Bounds struct {
	MinX  int `json:"minX"`
	MinY  int `json:"minY"`
	MinZ  int `json:"minZ"`
	SizeX int `json:"sizeX"`
	SizeY int `json:"sizeY"`
	SizeZ int `json:"sizeZ"`
}

// GenerateOutput is the full `generate` response contract: session.Result's fields
// (blocks/baseline/palette, placed/carved/replaced counts, diagnostics, origin, everything else
// already JSON-tagged there -- including EnvironmentBiome/BiomeEntries, whose element types
// biomes.ResolvedBiome/biomes.Entry carry their own lowerCamelCase tags, see biomes.go) promoted
// alongside the volume Bounds and the seeds actually used -- "actually used" matters because a
// caller that didn't pass a seed still needs to know what seed the preset default resolved to,
// to reproduce a result. See this package's doc comment for the full field-by-field wire spec.
type GenerateOutput struct {
	Bounds          Bounds `json:"bounds"`
	FeatureSeed     uint32 `json:"featureSeed"`
	EnvironmentSeed int32  `json:"environmentSeed"`
	*session.Result
}
