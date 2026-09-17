// Package session is the generation entry point: it builds a preset
// environment (env), resolves and places a single feature (features) or runs
// a feature rule's full distribution (rules) at an origin, diffs the result
// against the pre-placement baseline (volume.Diff), and returns one
// structured, JSON-friendly Result.
//
// Rule execution (Mode == ModeRule) is wired to the rules/ package below
// -- see the "mode == ModeRule" branch in
// Generate. Rule placement runs through rules.PlaceFeatureRule exactly once
// per Config.RepeatCount iteration, the same way ModeFeature runs
// feature.Place once per iteration; a rule whose distribution invokes
// places_feature many times (terraform-style) is that package's own loop,
// never collapsed here.
//
// Layering a loaded pack biome's own surface_builder onto a preset's native
// materials (MaterialSlots's own doc comment calls this "source 2" of its
// pipeline) IS wired: Config.EnvironmentBiomeID selects a biomes.ResolvedBiome
// out of whichever biomes.Library this run's biome files resolve to (built/
// cached by Workspace exactly like the feature/structure/rule libraries --
// see workspace.go), and generate below feeds its SurfaceBuilder into
// env.MergeMaterialSlots as `base` in place of `preset.Materials`, and its
// Tags/Identifier into the same default-biome-identity slot
// preset.Biome/BiomeTags used to fill alone.
//
// This package does not write JSON encoders, an HTTP handler, or a CLI --
// that is separate, later work. Result's fields are exported with json tags
// so that work can marshal it directly.
package session

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"

	molang "github.com/stirante/molang-go"
)

// Budgets/limits -- all three user-settable
// (see Config.WriteBudget/DelegationBudget/PlacementTimeLimitMs) rather than the write budget
// being a hardcoded constant generate() read directly, ignoring whatever a caller configured.
const (
	// DefaultWriteBudget is the default Config.WriteBudget: the max number of SetBlock attempts a
	// single generation may make before it is aborted. Was
	// formerly an unconditional constant (WriteBudget) that generate() read directly regardless of
	// Config; renamed alongside becoming a real, overridable default to match
	// DefaultDelegationBudget/DefaultPlacementTimeLimitMs's own naming.
	DefaultWriteBudget = 4_000_000
	// DefaultDelegationBudget is the default Config.DelegationBudget.
	DefaultDelegationBudget = 2_000_000
	// DefaultPlacementTimeLimitMs is the default Config.PlacementTimeLimitMs.
	DefaultPlacementTimeLimitMs = 8_000
)

// Mode selects what a run places.
type Mode string

const (
	ModeFeature Mode = "feature"
	// ModeRule requests feature-rule distribution placement, run through
	// the rules package -- see Generate's ModeRule branch.
	ModeRule Mode = "rule"
)

// BiomeOverride is a manual biome-identity override: id and tags travel
// together as one unit so a partial override can't desync them.
type BiomeOverride struct {
	ID string `json:"id"`
	// Tags is a comma-separated tag list, the text-field convention the
	// UI's biome override control uses.
	Tags string `json:"tags"`
}

// Config is one generation request.
type Config struct {
	Environment     env.EnvironmentID `json:"environment"`
	EnvironmentSeed int32             `json:"environmentSeed"`
	FeatureSeed     uint32            `json:"featureSeed"`

	SizeX int `json:"sizeX"`
	SizeY int `json:"sizeY"`
	SizeZ int `json:"sizeZ"`
	MinY  int `json:"minY"`

	// OriginX/OriginZ are the feature's placement origin in world
	// coordinates; the volume itself follows the origin (see Generate's
	// doc comment). OriginY nil means "use the preset's own default".
	OriginX int
	OriginY *int
	OriginZ int

	// Mode selects feature vs. rule placement -- see ModeRule's doc
	// comment for why only ModeFeature does anything today.
	Mode              Mode
	FeatureIdentifier *string
	// RuleIdentifier selects which loaded feature_rules/*.json entry to run
	// when Mode == ModeRule -- resolved against the rules.FeatureRuleLibrary
	// built from Generate's ruleFiles parameter.
	RuleIdentifier *string

	// RepeatCount places the feature/rule this many times, advancing the
	// RNG, to judge variance.
	RepeatCount int

	// EnvironmentBiomeID selects a loaded pack biome (from the biomeFiles a
	// caller passes to Generate/Workspace) as the material + biome-identity
	// source 2 -- see env.MaterialSlots's own doc comment for the full
	// "material slots -> terrain builder" pipeline this is source 2 of.
	// "" means "use the preset's own native materials/biome identity"
	// (source 1), unchanged default behaviour. A non-empty id that no
	// loaded biome file declares is NOT a silent fallback: generate reports
	// an "error" Diagnostic naming the id and still falls back to the
	// preset's own materials/identity, exactly as if EnvironmentBiomeID
	// were "".
	EnvironmentBiomeID string

	// BiomeOverride is source 3 of the same biome-identity pipeline --
	// always available, always winning per-field over whichever of source
	// 1 (preset)/source 2 (EnvironmentBiomeID) is active. Independent of
	// EnvironmentBiomeID; a caller may set either, both, or neither.
	BiomeOverride    *BiomeOverride
	MaterialOverride *env.MaterialOverride

	// WriteBudget/PlacementTimeLimitMs/DelegationBudget bound this run --
	// see DefaultWriteBudget/DefaultDelegationBudget/DefaultPlacementTimeLimitMs's doc comments
	// for what each bounds and their defaults. All three are user-settable end to end:
	// wire.GenerateParams exposes each as an optional *int (nil means "use the default"), and
	// DefaultConfig fills in the default for every one a caller leaves at its zero value.
	WriteBudget          int
	PlacementTimeLimitMs int
	DelegationBudget     int

	// Profiling arms the profiler (profiler.BeginProfiling/EndProfiling) for
	// this run when a feature or rule is actually selected. Off by default,
	// and off costs nothing (see profiler.go's package doc comment: every
	// hot path this touches is guarded by a direct boolean read, not a
	// function call). When true, the collected profiler.ProfileResult is
	// returned on Result.Profile; when false (the default), Result.Profile
	// is nil and neither Generate nor anything it calls ever reads or
	// writes profiler package state.
	Profiling bool `json:"profiling"`
}

// DefaultConfig returns the default Config for a preset. ok is false when
// environment names a preset env.GetEnvironment doesn't know.
func DefaultConfig(environment env.EnvironmentID) (Config, bool) {
	preset, ok := env.GetEnvironment(environment)
	if !ok {
		return Config{}, false
	}
	return Config{
		Environment:          environment,
		EnvironmentSeed:      12345,
		FeatureSeed:          1,
		SizeX:                preset.Defaults.SizeX,
		SizeY:                preset.Defaults.SizeY,
		SizeZ:                preset.Defaults.SizeZ,
		MinY:                 preset.Defaults.MinY,
		OriginX:              0,
		OriginZ:              0,
		Mode:                 ModeFeature,
		RepeatCount:          1,
		WriteBudget:          DefaultWriteBudget,
		PlacementTimeLimitMs: DefaultPlacementTimeLimitMs,
		DelegationBudget:     DefaultDelegationBudget,
	}, true
}

// Diagnostic is one build/placement diagnostic, normalized from whichever
// internal package raised it (features/structures build errors, a
// materials-slot warning, a placement refusal) into one JSON-friendly
// shape: several per-subsystem Diagnostic lists concatenated into one.
//
// FileID is always the identifier/file of whatever the CALLER asked to run (a build-time
// diagnostic's source file, or -- for a placement diagnostic -- the root feature/rule identifier
// Config.FeatureIdentifier/RuleIdentifier selected). For a placement diagnostic raised from
// somewhere inside a multi-level delegation chain, FileID is deliberately NOT what actually
// failed: Identifier/TypeID/Chain below carry that. Reading FileID alone for a nested failure used
// to assert something false -- that the root IS what failed -- which sent a reader to the wrong
// file; see this package's task notes for the motivating wiki:highland.main example.
type Diagnostic struct {
	Level  string `json:"level"` // "error" | "warning"
	FileID string `json:"fileId"`

	// Identifier/TypeID name the feature that ACTUALLY raised this diagnostic -- the deepest
	// (currently-executing) entry of Chain below, i.e. Chain[len(Chain)-1].Identifier/TypeID when
	// Chain is non-empty. Empty for a diagnostic that never ran inside a placement (a structure/
	// feature/biome build error, a material-slot warning) -- those have no delegation chain to
	// report a leaf of.
	Identifier string `json:"identifier,omitempty"`
	TypeID     string `json:"typeId,omitempty"`

	// Chain is the full delegation chain from the root feature/rule (Chain[0], matching FileID in
	// the common case) down to and including the feature that actually raised this diagnostic
	// (Chain[len(Chain)-1], matching Identifier) -- root first, so a consumer can render it
	// directly as a path. nil when this diagnostic did not originate from inside a placement.
	// Backed by profiler.CurrentChain(), which -- see profiler.go's "Always-on delegation chain"
	// doc comment -- is maintained regardless of Config.Profiling, so this is exactly as detailed
	// with profiling off as on.
	Chain []string `json:"chain,omitempty"`

	// Position is the block position placement had reached the FIRST time this (deduplicated)
	// diagnostic occurred -- nil, marshaling as JSON null, when not applicable (a build-time
	// diagnostic, or a diagnostic not tied to one write attempt). Never a zero BlockPos standing
	// in for "unknown": {0,0,0} is a real, meaningful coordinate, so "no position" is always
	// represented as a nil pointer, never that struct's zero value.
	Position *wgen.BlockPos `json:"position"`

	// Count is how many times an diagnostic identical to this one (same Level/Identifier/TypeID/
	// Message/Chain) occurred during this run, deduplicated on the engine side rather than left for
	// a consumer to group -- a single scatter_feature iterating thousands of times can raise the
	// SAME nested failure at every one of them, and repeating that diagnostic thousands of times
	// over would be an unreadable wall, not useful detail. Always >= 1 -- a diagnostic that
	// occurred once still reports Count: 1, never 0 or omitted.
	Count int `json:"count"`

	Message string `json:"message"`
}

// Placement is one placement attempt (one per Config.RepeatCount
// iteration).
type Placement struct {
	Origin   wgen.BlockPos  `json:"origin"`
	Returned *wgen.BlockPos `json:"returned"`
}

// Result is one generation's outcome. Alongside the live Volume pointer
// for programmatic callers, it exposes plain, JSON-marshalable snapshots
// (Blocks/Baseline/Palette).
type Result struct {
	// Volume is the finished volume, for programmatic access (GetBlockAt
	// etc.) -- not itself JSON-marshalable, see Blocks/Baseline/Palette
	// below for the wire-friendly equivalents.
	Volume *volume.Volume `json:"-"`

	// Blocks is the current block id for every cell, same indexing as
	// Baseline/Changed/Removed. Decode an id via Palette.
	Blocks CellIDs `json:"blocks"`
	// Baseline is the block id for every cell BEFORE the feature/rule ran
	// -- the same pre-placement snapshot Changed/Removed/the block counts
	// are all diffed against. Carried on the result so a viewer can
	// shape/colour a carved cell, whose current id is air and carries no
	// shape of its own.
	Baseline CellIDs `json:"baseline"`
	// Palette decodes every block.ID appearing in Blocks/Baseline into its
	// name/states.
	Palette []block.Entry `json:"palette"`

	Origin     wgen.BlockPos `json:"origin"`
	Placements []Placement   `json:"placements"`

	// Changed is 1 for any cell whose id differs from Baseline.
	Changed CellMask `json:"changed"`
	// Removed is 1 for a cell where Baseline was non-air and the result is
	// air -- the feature carved this cell out. A subset of Changed, and
	// invisible in a plain block-id mesh since a carved cell's current id
	// is air and draws no geometry.
	Removed CellMask `json:"removed"`

	// BlocksChanged is the total cells whose id differs from Baseline --
	// kept as the headline total. Conflates three very different visual
	// outcomes; see BlocksPlaced/BlocksCarved/BlocksReplaced for the
	// breakdown (their sum equals this minus any air-kind-to-different-
	// air-kind cell -- see volume.Diff's doc comment).
	BlocksChanged int `json:"blocksChanged"`
	// BlocksPlaced is Baseline air -> result non-air (volume.Diff's
	// Added). Renders normally, part of the feature mesh.
	BlocksPlaced int `json:"blocksPlaced"`
	// BlocksCarved is Baseline non-air -> result air (volume.Diff's
	// Removed) -- carved out. Renders nothing by construction unless a
	// carved-volume overlay is drawn separately (see Removed above): for
	// an excavating feature this is often the majority of what it did,
	// and BlocksChanged alone makes it invisible.
	BlocksCarved int `json:"blocksCarved"`
	// BlocksReplaced is Baseline non-air -> result non-air, different id
	// (volume.Diff's Replaced). Renders normally, part of the feature
	// mesh.
	BlocksReplaced int `json:"blocksReplaced"`

	WritesOutOfBounds int `json:"writesOutOfBounds"`

	// OverflowBlocks is every out-of-bounds write this run captured (volume.Volume.Overflow) --
	// what WritesOutOfBounds above used to leave as a bare count with nothing behind it. Read
	// semantics (GetBlock/Contains, and therefore every decision/RNG draw a feature made this
	// run) are completely unaffected by this field existing -- it is purely additional
	// information about writes that were ALREADY dropped, never a change to what got placed.
	// See wire's package doc comment, "Out-of-bounds capture", for the full wire spec and how
	// this differs from the separate "grow to fit and regenerate" action (GrowBounds/wire.
	// RunGenerateGrown), which is a genuinely different placement run, not a wider view of this
	// one. Empty, never nil, when WritesOutOfBounds is 0.
	OverflowBlocks []volume.OverflowBlock `json:"overflowBlocks"`

	// PlacementDurationMs, LibraryBuildDurationMs and TotalDurationMs report generation cost as
	// two distinct phases instead of one ambiguous number -- see wire's package doc comment
	// ("Duration fields") for the full rationale and wire spec; this is the field that used to be
	// a single DurationMs meaning "just placement" for a `serve` regeneration and "everything"
	// (misleadingly reported as ~1ms) for a one-shot `generate` call.
	//
	// PlacementDurationMs is THIS call's placement only -- feature/rule Place calls, palette
	// interning, and the baseline diff -- timed from the top of the unexported generate() below,
	// which always runs against an already-built palette/library set regardless of caller.
	PlacementDurationMs float64 `json:"placementDurationMs"`
	// LibraryBuildDurationMs is how long parsing/building the feature/structure/rule libraries
	// this run placed against took. Left at its zero value here -- generate() itself never builds
	// a library, only places against ones already built -- and filled in by whichever exported
	// entry point actually paid that cost: package-level Generate (the one-shot path) measures its
	// own NewWorkspace call and sets this; Workspace.Generate (the `serve` reuse path) leaves it
	// 0, because the cost was already paid once, earlier, by a prior "loadPack" call, and is NOT
	// part of this regeneration.
	LibraryBuildDurationMs float64 `json:"libraryBuildDurationMs"`
	// TotalDurationMs is LibraryBuildDurationMs + PlacementDurationMs, computed by the same
	// exported entry points that set LibraryBuildDurationMs so a consumer never has to add the two
	// itself.
	TotalDurationMs float64 `json:"totalDurationMs"`

	// Partial is true when the run was cut off by a write/delegation/
	// wall-clock budget rather than finishing on its own -- i.e. every
	// field above is a snapshot of however far placement got, not the
	// finished result.
	Partial bool `json:"partial"`

	Diagnostics []Diagnostic     `json:"diagnostics"`
	Entries     []features.Entry `json:"entries"`

	// RuleEntries is every loaded feature_rules/*.json entry, always
	// populated regardless of Mode (mirrors Entries above).
	RuleEntries []rules.FeatureRuleEntry `json:"ruleEntries"`
	// ActiveRule is the resolved rule for Config.RuleIdentifier when
	// Mode == ModeRule, nil otherwise.
	ActiveRule *rules.FeatureRule `json:"activeRule"`

	UnresolvedTags []string `json:"unresolvedTags"`

	// BiomeEntries is every loaded biomes/*.json entry, always populated
	// regardless of whether one is selected (mirrors RuleEntries above),
	// for a picker UI.
	BiomeEntries []biomes.Entry `json:"biomeEntries"`
	// EnvironmentBiome is the resolved biome for Config.EnvironmentBiomeID,
	// for a caller to show its climate/replace_biomes targets read-only.
	// nil when
	// Config.EnvironmentBiomeID was "" OR named a biome no loaded file
	// declares (see EnvironmentBiomeID's own doc comment for the
	// diagnostic that second case raises).
	EnvironmentBiome *biomes.ResolvedBiome `json:"environmentBiome"`

	// MolangScope is the single scope this run's placement chain shared --
	// see wgen.NewScope's doc comment for why one scope, never forked, is
	// the correct model for an entire nested Place() tree. An empty,
	// untouched scope when neither a feature nor a rule was selected.
	MolangScope *molang.Scope `json:"molangScope"`

	// Profile is populated only when Config.Profiling was true AND a
	// feature or rule was actually selected. nil otherwise (including when
	// profiling was requested but nothing was selected to place, since
	// nothing was ever pushed onto the profiler's stack in that case), so a
	// caller never has to special-case "profiling was off" vs "profiling
	// was on but nothing ran" beyond a single nil check.
	Profile *profiler.ProfileResult `json:"profile"`
}

// Generate builds a brand-new Workspace from files/structureFiles/ruleFiles
// and runs one placement in it -- the one-shot, no-reuse entry point every
// existing caller/test uses (the
// one-shot CLI `generate` subcommand never runs a second placement in the
// same process, so there is nothing to gain from holding a Workspace open).
// Building a Workspace just for this one call still re-parses every source
// file, exactly like this function always has -- the win from separating
// "build the libraries" out of "run a placement" only appears for a caller
// that holds the Workspace open across multiple Generate calls; see
// Workspace's doc comment and cmd/featurelab/serve.go's loadPack/generate
// split, which is that caller.
//
// Always regenerating from a clean environment (rather than undoing a
// previous placement) keeps every run reproducible from (config, files,
// structureFiles) alone.
func Generate(config Config, files []features.SourceFile, structureFiles []structures.SourceFile, ruleFiles []rules.SourceFile, biomeFiles []biomes.SourceFile, blockFiles []block.SourceFile) (*Result, error) {
	buildStarted := time.Now()
	ws := NewWorkspace(files, structureFiles, ruleFiles, biomeFiles, blockFiles)
	buildDurationMs := float64(time.Since(buildStarted)) / float64(time.Millisecond)

	result, err := ws.Generate(config)
	if err != nil {
		return nil, err
	}
	// Overwrites what Workspace.Generate itself set (0, since IT never builds a library) with the
	// NewWorkspace cost this call actually paid -- see Result.LibraryBuildDurationMs's doc comment
	// for why only this one-shot entry point ever reports a nonzero value here.
	result.LibraryBuildDurationMs = buildDurationMs
	result.TotalDurationMs = result.LibraryBuildDurationMs + result.PlacementDurationMs
	return result, nil
}

// generate is the shared implementation behind both Generate and
// Workspace.Generate: run one placement against an already-built palette
// and feature/structure/rule library -- see Workspace's doc comment for
// what "already built" means here and the correctness contract that makes
// reusing them across calls safe. Generate itself satisfies that contract
// trivially, by handing generate a Workspace's libraries that were just
// built fresh and will never be reused again.
//
// The volume follows the horizontal origin instead of sitting permanently
// at world (0, 0): minX = originX - floor(sizeX/2), same for Z. Features
// that read world position (query.noise, seeded from a fixed constant, so
// it depends on absolute coordinates) behave completely differently in
// different places, and previewing them anywhere but the origin is
// impossible while the volume stays put -- every write would land outside
// and be silently dropped.
func generate(config Config, palette *block.Palette, lib *features.Library, structureLib *structures.Library, ruleLib *rules.FeatureRuleLibrary, biomeLib *biomes.Library) (*Result, error) {
	started := time.Now()

	preset, ok := env.GetEnvironment(config.Environment)
	if !ok {
		return nil, fmt.Errorf("session: unknown environment %q", config.Environment)
	}

	bounds := volume.Bounds{
		MinX:  config.OriginX - config.SizeX/2,
		MinY:  config.MinY,
		MinZ:  config.OriginZ - config.SizeZ/2,
		SizeX: config.SizeX, SizeY: config.SizeY, SizeZ: config.SizeZ,
	}
	vol := volume.New(bounds, palette, block.AirID)

	var materialWarnings []Diagnostic

	// Resolve Config.EnvironmentBiomeID against biomeLib. An id that names
	// no loaded biome file raises an explicit "error" Diagnostic instead of
	// silently behaving like "" (see EnvironmentBiomeID's own
	// doc comment for why -- a mistyped --biome-id must never look like a
	// no-op).
	var environmentBiome *biomes.ResolvedBiome
	if config.EnvironmentBiomeID != "" {
		environmentBiome = biomeLib.Resolve(config.EnvironmentBiomeID)
		if environmentBiome == nil {
			materialWarnings = append(materialWarnings, Diagnostic{
				Level: "error", FileID: "(environment)", Count: 1,
				Message: fmt.Sprintf("biome id %q is not defined by any loaded biome file -- materials/tags fall back to the %q preset's own defaults", config.EnvironmentBiomeID, config.Environment),
			})
		}
	}

	// Material-slots pipeline (env.MaterialSlots's doc comment): source 1
	// is the preset's own native materials, source 2 (when
	// environmentBiome resolved above is non-nil and declares its own
	// minecraft:surface_builder) is that biome's own materials, source 3
	// is the manual per-field override, always available, always winning
	// per-field over whichever of 1/2 is active. Interning here always
	// runs, every call, even on a reused Workspace -- materials depend on
	// config (seed/biome/override), which varies call to call -- but it is
	// cheap and, like every other palette.intern call, idempotent: a
	// config identical to a previous call's interns nothing new and
	// returns the same ids.
	baseMaterialSlots := preset.Materials
	if environmentBiome != nil && environmentBiome.SurfaceBuilder != nil {
		baseMaterialSlots = biomeMaterialSlots(environmentBiome.SurfaceBuilder)
	}
	effectiveSlots := env.MergeMaterialSlots(baseMaterialSlots, config.MaterialOverride)
	materials := env.InternMaterialSlots(palette, effectiveSlots, func(message string) {
		materialWarnings = append(materialWarnings, Diagnostic{Level: "warning", FileID: "(environment)", Count: 1, Message: message})
	})

	preset.Build(vol, config.EnvironmentSeed, materials)

	// Two "you set something and nothing happened" checks, both about the
	// environment layer rather than the feature under test. A defect down here
	// does not break one feature type, it silently changes every preview, so
	// neither of these is allowed to stay quiet.
	//
	// First: sea slots set on a preset that has no sea. sea_floor_depth is
	// honoured now (env/environment.go's "ocean" Build), but ocean is the only
	// preset with a sea at all, and this tool -- not the engine it models --
	// added the --sea-floor-depth flag and the panel fields, so it owes the
	// author an answer when they do nothing.
	if inert := preset.InertSeaSlotOverrides(config.MaterialOverride); len(inert) > 0 {
		materialWarnings = append(materialWarnings, Diagnostic{
			Level: "warning", FileID: "(environment)", Count: 1,
			Message: fmt.Sprintf("%s set, but the %q environment builds no sea, so it changes nothing in this preview. "+
				"Only the %q preset models one -- its water column, its seabed, and the sea_floor_depth band beneath it. "+
				"Switch environments to see these take effect, or leave them unset.",
				strings.Join(inert, " and "), config.Environment, env.EnvOcean),
		})
	}
	// Second: a preset that promised a landform and did not produce it. Level
	// "error", not "warning": the bench is unusable, exactly like the mistyped
	// --biome-id above, and both `check` and `generate` gate their exit code on
	// this level so a scripted run cannot mistake an empty preview for a
	// feature that placed nothing.
	if message := preset.CheckLandform(vol); message != "" {
		materialWarnings = append(materialWarnings, Diagnostic{
			Level: "error", FileID: "(environment)", Count: 1, Message: message,
		})
	}
	// The environment builder writes into the same volume the feature will, so its own spill
	// outside the bounds lands on the same counter -- and everything downstream reads that
	// counter as the FEATURE's. Clear it here so the numbers on the wire, the "all N writes
	// landed outside the previewed volume" diagnostic, and --grow's decision to expand and
	// regenerate all describe the placement and nothing else. See
	// Volume.ResetOutOfBoundsAccounting for the flag combination that made this visible.
	vol.ResetOutOfBoundsAccounting()
	baseline := vol.Snapshot()

	diagID := func() string {
		if config.Mode == ModeRule {
			if config.RuleIdentifier != nil && *config.RuleIdentifier != "" {
				return *config.RuleIdentifier
			}
			return "(placement)"
		}
		if config.FeatureIdentifier != nil && *config.FeatureIdentifier != "" {
			return *config.FeatureIdentifier
		}
		return "(placement)"
	}

	// A rule's origin is NOT the "Y auto/manual" surface-snap used for a
	// single feature -- the real engine scatters every decoration-list
	// entry from the chunk/dimension build floor, read once per chunk.
	// Config.OriginY's auto/manual toggle only applies in ModeFeature.
	origin := wgen.BlockPos{X: config.OriginX, Z: config.OriginZ}
	if config.Mode == ModeRule {
		origin.Y = 0
	} else if config.OriginY != nil {
		origin.Y = *config.OriginY
	} else {
		origin.Y = preset.DefaultOriginY(vol)
	}

	var placements []Placement
	var placementFailures []Diagnostic
	// failureIndex deduplicates placementFailures: key -> index into placementFailures, so a
	// repeat occurrence of the SAME diagnostic (same level/identifier/typeId/message/chain, e.g. a
	// scatter_feature's nested feature failing the same way at every one of thousands of
	// iterations) bumps that entry's Count instead of appending a new, near-identical entry --
	// see addPlacementFailure below and Diagnostic.Count's own doc comment.
	failureIndex := make(map[string]int)
	molangScope := wgen.NewScope()
	partial := false
	// Populated below, only when config.Profiling is true AND a feature/rule
	// was actually selected -- see Result.Profile's doc comment.
	var profileResult *profiler.ProfileResult

	var feature wgen.IFeature
	if config.Mode == ModeFeature && config.FeatureIdentifier != nil && *config.FeatureIdentifier != "" {
		feature = lib.Resolve(*config.FeatureIdentifier)
	}
	var activeRule *rules.FeatureRule
	if config.Mode == ModeRule && config.RuleIdentifier != nil && *config.RuleIdentifier != "" {
		activeRule = ruleLib.Resolve(*config.RuleIdentifier)
	}

	// A request that named an identifier lib/ruleLib could not resolve must never fall straight
	// through to an unexplained empty result -- see unresolvedFeatureDiagnostic/
	// unresolvedRuleDiagnostic's own doc comment for the silent-failure bug this closes
	// (config.FeatureIdentifier/RuleIdentifier non-empty, feature/activeRule both nil, so every
	// diagnostic below -- gated on `feature != nil || activeRule != nil` -- used to never run).
	if config.Mode == ModeFeature && config.FeatureIdentifier != nil && *config.FeatureIdentifier != "" && feature == nil {
		placementFailures = append(placementFailures, unresolvedFeatureDiagnostic(*config.FeatureIdentifier, lib))
	}
	if config.Mode == ModeRule && config.RuleIdentifier != nil && *config.RuleIdentifier != "" && activeRule == nil {
		placementFailures = append(placementFailures, unresolvedRuleDiagnostic(*config.RuleIdentifier, ruleLib))
	}

	if feature != nil || activeRule != nil {
		rnd := random.New(config.FeatureSeed)

		// The "active default" identity is the resolved pack biome's own
		// identifier/minecraft:tags when EnvironmentBiomeID selected one,
		// else the preset's own biome/biomeTags. config.BiomeOverride below
		// still overrides either default exactly as before.
		defaultBiomeID := preset.Biome
		defaultBiomeTags := preset.BiomeTags
		if environmentBiome != nil {
			defaultBiomeID = environmentBiome.Identifier
			defaultBiomeTags = environmentBiome.Tags
		}
		biomeID := defaultBiomeID
		biomeTags := defaultBiomeTags
		if config.BiomeOverride != nil {
			if trimmed := strings.TrimSpace(config.BiomeOverride.ID); trimmed != "" {
				biomeID = trimmed
			}
			var tags []string
			for _, part := range strings.Split(config.BiomeOverride.Tags, ",") {
				t := strings.TrimSpace(part)
				if t != "" {
					tags = append(tags, t)
				}
			}
			biomeTags = tags
		}
		tagSet := make(map[string]struct{}, len(biomeTags))
		for _, t := range biomeTags {
			tagSet[t] = struct{}{}
		}
		biome := &wgen.MolangBiome{ID: biomeID, Tags: tagSet}

		id := diagID()

		// addPlacementFailure appends (or, for a repeat of the identical diagnostic, just
		// increments the Count of) one placement diagnostic -- the single place that turns a raw
		// (level, message, chain, position) into the wire Diagnostic shape, so LogFailure-driven
		// refusals and budget-exceeded panics both go through the same identifier/typeId/chain
		// projection and the same dedup rule. chain is root-first (profiler.CurrentChain()'s own
		// contract); the failing feature itself -- Identifier/TypeID below -- is always chain's
		// LAST entry, never the root (see Diagnostic's own doc comment for why that distinction is
		// the whole point). pos nil means "not tied to one write attempt" (e.g. a delegation-budget/
		// deadline panic, which has a chain but no single position) and is carried through as a
		// literal JSON null, never a zero BlockPos.
		// failureKeyBuf/failureChainBuf are reused scratch buffers: the dedup-HIT path (the same
		// diagnostic repeating, e.g. once per failed nested placement -- ~1M times in a
		// pathological run, see failures.go) allocates nothing. pos travels by value with an
		// explicit hasPos flag (rather than the old *BlockPos) so the hot callers below don't
		// heap-allocate a BlockPos per call just to have it discarded on a dedup hit; the copy
		// that IS retained (first occurrence only) is made below.
		var failureKeyBuf []byte
		var failureChainBuf []profiler.ChainFrame
		addPlacementFailure := func(level, message string, chain []profiler.ChainFrame, pos wgen.BlockPos, hasPos bool) {
			failureKeyBuf = appendFailureKey(failureKeyBuf[:0], level, message, chain)
			if idx, ok := failureIndex[string(failureKeyBuf)]; ok {
				placementFailures[idx].Count++
				return
			}
			var identifier, typeID string
			if len(chain) > 0 {
				last := chain[len(chain)-1]
				identifier, typeID = last.Identifier, last.TypeID
			}
			chainIDs := make([]string, len(chain))
			for i, f := range chain {
				chainIDs[i] = f.Identifier
			}
			var posCopy *wgen.BlockPos
			if hasPos {
				p := pos
				posCopy = &p
			}
			failureIndex[string(failureKeyBuf)] = len(placementFailures)
			placementFailures = append(placementFailures, Diagnostic{
				Level: level, FileID: id, Identifier: identifier, TypeID: typeID,
				Chain: chainIDs, Position: posCopy, Count: 1, Message: message,
			})
		}
		logFailure := func(featureType, message string, pos wgen.BlockPos) {
			failureChainBuf = profiler.AppendChain(failureChainBuf[:0])
			addPlacementFailure("warning", message, failureChainBuf, pos, true)
		}
		// logWarning is LogFailure's non-refusing counterpart -- pos is a pointer at this
		// boundary (wgen.PlacementContext.LogWarning's own contract) and is unpacked into the
		// value+flag form here, nil meaning "no position".
		logWarning := func(featureType, message string, pos *wgen.BlockPos) {
			failureChainBuf = profiler.AppendChain(failureChainBuf[:0])
			if pos != nil {
				addPlacementFailure("warning", message, failureChainBuf, *pos, true)
			} else {
				addPlacementFailure("warning", message, failureChainBuf, wgen.BlockPos{}, false)
			}
		}

		// Some real chains nest scatters deeply enough that their
		// iteration counts multiply into work that never finishes. Place
		// is synchronous, so without a budget a caller has no way back.
		wb := config.WriteBudget
		vol.WriteBudget = &wb
		vol.WritesAttempted = 0
		delegationBudget := config.DelegationBudget
		timeLimitMs := config.PlacementTimeLimitMs
		features.SetDelegationBudgetMs(&delegationBudget, &timeLimitMs)

		// Profiler setup (profiler.go) -- only the full accounting (per-feature stats, per-cell
		// touch counts) is gated on config.Profiling; the delegation-chain frame stack every
		// feature's own Place pushes/pops is unconditional (profiler.go's "Always-on delegation
		// chain" doc comment) so LogFailure/budget-exceeded diagnostics are equally detailed with
		// profiling off. Skipped entirely when config.Profiling is false, so a plain run allocates
		// none of BeginProfiling's touchCounts/stats-map state and never reads/writes it.
		if config.Profiling {
			profiler.BeginProfiling(len(vol.Data()))
		}

		func() {
			defer features.SetDelegationBudgetMs(nil, nil)
			// Registered before the recover defer below so it still runs
			// AFTER recover has handled (or re-panicked) whatever happened --
			// Go continues running remaining deferred calls even when one of
			// them panics again, so this captures accurate stats regardless
			// of how placement ended.
			if config.Profiling {
				defer func() {
					pr := profiler.EndProfiling()
					profileResult = &pr
				}()
			}
			defer func() {
				r := recover()
				if r == nil {
					return
				}
				// Chain/position on every one of these three are captured AT THE PANIC SITE
				// (volume.SetBlockAt / features.WithRecursionGuard), not here: by the time
				// recover() runs, every enclosing Place call's own deferred PopFeatureFrame has
				// already unwound profiler's chain stack back to empty, so reading
				// profiler.CurrentChain() at THIS point would find nothing. See profiler.go's
				// "Always-on delegation chain" doc comment. completed reports how many repeat
				// placements finished successfully before the one that tripped the budget --
				// exactly what a user needs to tell "raise the budget slightly" (completed is
				// close to repeat) from "this is runaway recursion" (completed is 0 or 1).
				completed := len(placements)
				switch e := r.(type) {
				case *volume.WriteBudgetExceeded:
					partial = true
					addPlacementFailure("error", fmt.Sprintf(
						"%s; %d repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result",
						e.Error(), completed), e.Chain, e.Position, true)
				case *features.DelegationBudgetExceeded:
					partial = true
					addPlacementFailure("error", fmt.Sprintf(
						"%s; %d repeat placement(s) completed before stopping -- its nested chain expands without converging, so the blocks shown are a partial result",
						e.Error(), completed), e.Chain, wgen.BlockPos{}, false)
				case *features.PlacementDeadlineExceeded:
					partial = true
					// Deliberately NOT the same "expands without converging" suffix the count-based
					// DelegationBudgetExceeded case above uses: that phrase asserts a cause (runaway
					// recursion) this wall-clock cutoff cannot actually establish -- a placement chain
					// that would have converged fine can still get cut off here purely because this
					// run happened to be slow. e.Error() itself (features.PlacementDeadlineExceeded,
					// see that type's own doc comment) already states the NOT REPRODUCIBLE distinction
					// plainly; this suffix only adds the same partial-result framing the other two
					// cases give, without repeating a convergence claim this case cannot back up.
					addPlacementFailure("error", fmt.Sprintf(
						"%s; %d repeat placement(s) completed before stopping -- the blocks shown are a partial result, and re-running with the SAME seed may stop at a different point",
						e.Error(), completed), e.Chain, wgen.BlockPos{}, false)
				case *features.MalformedRangeRefusal:
					// NOT a budget: this placement was declined on purpose, by a feature that will
					// not invent behaviour the game does not define (see that type's own doc
					// comment for all four sites and for why the refusal itself is unchanged).
					// It is recovered here for the same reason the three above are -- so the user
					// reads a diagnostic naming the field instead of the raw Go stack trace this
					// used to print, which is what happens to anything the default arm re-panics.
					// partial is set for the same reason as the others: the placement stopped
					// part-way, so whatever is on screen is not the finished feature.
					partial = true
					addPlacementFailure("error", fmt.Sprintf(
						"%s; %d repeat placement(s) completed before stopping -- the blocks shown are a partial result",
						e.Error(), completed), e.Chain, wgen.BlockPos{}, false)
				default:
					panic(r)
				}
			}()

			repeat := config.RepeatCount
			if repeat < 1 {
				repeat = 1
			}

			if feature != nil {
				ctx := &wgen.PlacementContext{API: vol, Origin: origin, Random: rnd, MolangScope: molangScope, Biome: biome, LogFailure: logFailure, LogWarning: logWarning}
				for i := 0; i < repeat; i++ {
					returned := feature.Place(ctx)
					placements = append(placements, Placement{Origin: origin, Returned: returned})
				}
				return
			}

			// ModeRule: run the rule's full distribution through
			// rules.PlaceFeatureRule, once per RepeatCount iteration.
			// PlaceFeatureRule owns the per-iteration loop internally
			// (a terraform-style rule invokes places_feature many
			// times per call); that loop is never collapsed here.
			baseCtx := rules.PlaceContext{API: vol, Random: rnd, Biome: biome, LogFailure: logFailure, LogWarning: logWarning}
			// A rule itself is not a wgen.IFeature (PlaceFeatureRule, not a .Place() call), so it
			// is never covered by every concrete feature type's own baked-in PushFeatureFrame/
			// PopFeatureFrame -- push/pop its own frame directly here, unconditionally (regardless
			// of config.Profiling -- see profiler.go's "Always-on delegation chain" doc comment),
			// so its own overhead (evaluating the distribution, resolving places_feature) is
			// attributed to the rule's identifier, and so any diagnostic raised from inside
			// PlaceFeatureRule (biome-filter rejection, unresolved places_feature) has at least
			// this one frame on the chain, rather than silently vanishing into whichever frame
			// happened to be on top (there is none, at the top level).
			ruleFrameID := "(rule)"
			if config.RuleIdentifier != nil && *config.RuleIdentifier != "" {
				ruleFrameID = *config.RuleIdentifier
			}
			// Run the rule once per CHUNK the bench covers, not once for the whole bench.
			//
			// The real engine applies a feature rule per chunk, and a terraform-style rule leans
			// on exactly that: it builds one column and relies on being invoked 256 times for
			// each chunk. Applying it once meant a 32x32 bench only ever decorated the single
			// 16x16 chunk containing the origin -- visibly wrong, and reported as such.
			//
			// The seeding matches the game's, implemented in random/decorationseed.go: the
			// world seed and the chunk coordinates give the chunk its decoration seed, that
			// seed and the entry's name hash give the entry its seed, and the entry seed is
			// then used TWICE -- once for the generator the distribution draws positions with,
			// once for a separate generator every delegated feature draws from. Both start
			// from the same value and advance independently.
			//
			// It replaced random.DomainRuleChunk, this project's own stand-in, which gave each
			// chunk a reproducible stream without claiming to be the game's. Chunk coverage was
			// already right; the sequence within a chunk now is too.
			//
			// A fresh generator per chunk, rather than one shared stream, therefore falls out
			// of the engine's own design rather than being a bench decision: chunk N does not
			// depend on how many draws chunks 1..N-1 happened to make.
			masterSeed := rnd.GetSeed()
			// The name whose hash seeds the entry is the RULE'S OWN IDENTIFIER, not the feature
			// it places, see random/decorationseed.go. A rule with no identifier (this bench allows one; the
			// engine's schema does not) hashes the empty string, which the engine's own hash
			// maps to 0 rather than to the FNV offset basis.
			entryName := ""
			if config.RuleIdentifier != nil {
				entryName = *config.RuleIdentifier
			}
			for _, chunkOrigin := range ruleChunkOrigins(vol, origin) {
				chunkSeed := random.ChunkDecorationSeed(masterSeed, int32(chunkOrigin.X>>4), int32(chunkOrigin.Z>>4))
				entrySeed := random.DecorationEntrySeed(chunkSeed, random.HashedStringHash32(entryName))
				ruleCtx := baseCtx
				ruleCtx.Random = random.New(entrySeed)
				ruleCtx.PlaceRandom = random.New(entrySeed)
				for i := 0; i < repeat; i++ {
					profiler.PushFeatureFrame(ruleFrameID, "minecraft:feature_rules")
					result := func() rules.RulePlacementResult {
						defer profiler.PopFeatureFrame()
						return rules.PlaceFeatureRule(rules.RulePlacementOptions{
							Rule:     activeRule,
							Resolver: lib,
							Origin:   chunkOrigin,
							Ctx:      ruleCtx,
						})
					}()
					// PlaceFeatureRule creates its own fresh MolangScope
					// per call (see rules.RulePlacementResult.Scope's doc
					// comment) -- unlike the feature-mode loop above, a
					// rule's RepeatCount iterations don't share one scope
					// object. Exposing the LAST iteration's scope matches
					// this result's other per-repeat fields (Placements/
					// the summarized Returned below), which are also
					// "last iteration wins" summaries, not a merge.
					molangScope = result.Scope
					var lastReturned *wgen.BlockPos
					for _, p := range result.Placements {
						if p.Returned != nil {
							pos := *p.Returned
							lastReturned = &pos
						}
					}
					placements = append(placements, Placement{Origin: chunkOrigin, Returned: lastReturned})
				}
			}
		}()
	}

	diff := vol.Diff(baseline)

	// A feature can report success and still write nothing -- every
	// candidate position rejected, a nested reference that resolved but
	// placed nothing, a depth or chance of zero. That reads as a blank
	// preview with no explanation, so say it out loud even though no
	// individual step called it a failure.
	if (feature != nil || activeRule != nil) && diff.ChangedCount == 0 && len(placementFailures) == 0 {
		succeeded := false
		for _, p := range placements {
			if p.Returned != nil {
				succeeded = true
				break
			}
		}
		message := "placement returned no result and wrote no blocks"
		if succeeded {
			message = "placed successfully but wrote no blocks — every candidate position was rejected, or a nested feature placed nothing"
		}
		placementFailures = append(placementFailures, Diagnostic{Level: "warning", FileID: diagID(), Count: 1, Message: message})
	}

	// Writing outside the previewed region is normal, not an error: in the
	// game those blocks land in neighbouring chunks, and some features
	// deliberately reach that far. This tool only has this one finite
	// volume, so those writes are dropped, and the useful thing to say is
	// where the edges are, not that the feature did something wrong.
	if vol.WritesOutOfBounds > 0 && diff.ChangedCount == 0 {
		placementFailures = append(placementFailures, Diagnostic{
			Level: "warning", FileID: diagID(), Count: 1,
			Message: fmt.Sprintf(
				"all %d writes landed outside the previewed volume (x %d..%d, y %d..%d, z %d..%d), so nothing is shown. "+
					"That is expected for a feature that works on neighbouring chunks; otherwise grow the volume or move the origin",
				vol.WritesOutOfBounds, vol.MinX(), vol.MinX()+vol.SizeX()-1, vol.MinY(), vol.MaxY()-1, vol.MinZ(), vol.MinZ()+vol.SizeZ()-1),
		})
	}

	var diagnostics []Diagnostic
	diagnostics = append(diagnostics, convertStructureDiagnostics(structureLib.Diagnostics)...)
	diagnostics = append(diagnostics, convertFeatureDiagnostics(lib.Diagnostics)...)
	diagnostics = append(diagnostics, convertFeatureDiagnostics(ruleLib.Diagnostics)...)
	diagnostics = append(diagnostics, convertBiomeDiagnostics(biomeLib.Diagnostics)...)
	diagnostics = append(diagnostics, materialWarnings...)
	diagnostics = append(diagnostics, placementFailures...)

	unresolvedTags := palette.UnresolvedTagList()
	sort.Strings(unresolvedTags)

	// Every legacy alias the palette could not resolve, reported. This channel existed and was
	// populated from the day the palette was written, and until now the ONLY thing that ever read
	// it was a unit test -- so the failure it records reached a pack author as silence.
	//
	// What it records is not cosmetic. `minecraft:leaves` is an alias whose target depends on its
	// `old_leaf_type` state; written without one, the palette deliberately refuses to guess and
	// keeps the descriptor verbatim. That is the right call, but it means the entry is now a name
	// no feature in this bench ever WRITES -- a tree places `minecraft:oak_leaves` -- so a
	// `may_replace: ["minecraft:leaves"]` silently matches nothing at all, and the symptom the
	// author sees is a tree that refuses to grow for no stated reason.
	//
	// Reported at the palette level rather than per-field because the palette does not know which
	// JSON field a name arrived from; naming the block and what to write instead is the part that
	// gets someone unstuck, and it is the same shape as the unresolved-tag reporting beside it.
	for _, alias := range palette.UnresolvedAliasList() {
		diagnostics = append(diagnostics, Diagnostic{
			Level: "warning", FileID: "(blocks)", Count: 1,
			Message: fmt.Sprintf("%s is a legacy alias whose modern block depends on a state this "+
				"descriptor does not set, so it was kept as written rather than guessed at. Nothing "+
				"in this bench places a block by that name, so any list containing it matches "+
				"nothing -- write the flattened block instead (for example minecraft:oak_leaves "+
				"rather than minecraft:leaves), or add the state that selects one.", alias),
		})
	}

	return &Result{
		Volume:              vol,
		Blocks:              vol.Data(),
		Baseline:            baseline.Data(),
		Palette:             palette.Snapshot(),
		Origin:              origin,
		Placements:          placements,
		Changed:             diff.Changed,
		Removed:             diff.Removed,
		BlocksChanged:       diff.ChangedCount,
		BlocksPlaced:        diff.AddedCount,
		BlocksCarved:        diff.RemovedCount,
		BlocksReplaced:      diff.ReplacedCount,
		WritesOutOfBounds:   vol.WritesOutOfBounds,
		OverflowBlocks:      vol.Overflow(),
		PlacementDurationMs: float64(time.Since(started)) / float64(time.Millisecond),
		Partial:             partial,
		Diagnostics:         diagnostics,
		Entries:             lib.Entries,
		RuleEntries:         ruleLib.Entries,
		ActiveRule:          activeRule,
		UnresolvedTags:      unresolvedTags,
		BiomeEntries:        biomeLib.Entries,
		EnvironmentBiome:    environmentBiome,
		MolangScope:         molangScope,
		Profile:             profileResult,
	}, nil
}

// biomeMaterialSlots converts a biomes.MaterialSlots (biomes package's own,
// deliberately independent declaration -- see that type's doc comment) into
// env.MaterialSlots field-for-field -- the join point between the biomes
// package's parse-only output and env.MergeMaterialSlots/InternMaterialSlots,
// which this package (not biomes) owns per biomes.go's own doc comment.
func biomeMaterialSlots(b *biomes.MaterialSlots) env.MaterialSlots {
	return env.MaterialSlots{
		TopMaterial:        b.TopMaterial,
		MidMaterial:        b.MidMaterial,
		FoundationMaterial: b.FoundationMaterial,
		SeaFloorMaterial:   b.SeaFloorMaterial,
		SeaMaterial:        b.SeaMaterial,
		SeaFloorDepth:      b.SeaFloorDepth,
	}
}

func convertFeatureDiagnostics(in []features.Diagnostic) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: d.FileID, Count: 1, Message: d.Message}
	}
	return out
}

func convertStructureDiagnostics(in []structures.Diagnostic) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: d.FileID, Count: 1, Message: d.Message}
	}
	return out
}

func convertBiomeDiagnostics(in []biomes.Diagnostic) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: d.FileID, Count: 1, Message: d.Message}
	}
	return out
}

// ruleChunkOrigins lists the chunk-corner origins a rule run should cover for this bench.
//
// The real engine invokes a feature rule once per chunk, from that chunk's own corner. This
// mirrors the ITERATION, not the seeding (see the call site's comment: the per-chunk seed is
// this project's stand-in, not the game's). Chunks are 16x16 in X/Z; Y is whatever the caller
// already resolved for rule mode (the build floor), so it is carried through unchanged.
//
// The bench's own origin is snapped down to its containing chunk corner and the grid is walked
// from there, so a bench that starts mid-chunk still covers every chunk it touches instead of
// silently skipping the partial one at each edge.
func ruleChunkOrigins(vol *volume.Volume, origin wgen.BlockPos) []wgen.BlockPos {
	const chunk = 16
	floorDiv := func(a, b int) int {
		q := a / b
		if a%b != 0 && (a < 0) != (b < 0) {
			q--
		}
		return q
	}
	minX := floorDiv(vol.MinX(), chunk) * chunk
	minZ := floorDiv(vol.MinZ(), chunk) * chunk
	maxX := vol.MinX() + vol.SizeX() - 1
	maxZ := vol.MinZ() + vol.SizeZ() - 1

	var out []wgen.BlockPos
	for cz := minZ; cz <= maxZ; cz += chunk {
		for cx := minX; cx <= maxX; cx += chunk {
			out = append(out, wgen.BlockPos{X: cx, Y: origin.Y, Z: cz})
		}
	}
	// A bench smaller than one chunk still has to run once -- otherwise a preview narrower than
	// 16 blocks would silently place nothing at all.
	if len(out) == 0 {
		out = append(out, origin)
	}
	return out
}
