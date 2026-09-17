package goldentest

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// ErrPackNotAvailable wraps SetupHarness's error when the pack simply
// isn't present at PackDir (the usual case: FEATURELAB_PACK_DIR is unset) -- callers that can skip gracefully (tests) should do so; the
// standalone goldengen command still treats it as fatal, since it has no
// meaningful output to produce without the pack.
var ErrPackNotAvailable = errors.New("pack not available")

// Fixed environment/library recipe shared by every digest test, benchmark,
// and the digest regeneration tool (cmd/goldengen) — same seeds and budgets
// every time so their results are directly comparable. The two baselines differ in exactly one
// input, the pack directory (PackDir vs FixturePackRel), and in where their
// digest file lives; how a chain is placed, encoded and hashed is shared
// code, so a divergence in either baseline means the same thing.
const (
	EnvSeed          = 12345
	FeatureSeed      = 1
	DelegationBudget = 200_000
	WriteBudget      = 400_000
)

// PackDir is an optional external behavior pack to build the harness from,
// read from the environment because its location is a property of one
// machine rather than of the project:
//
//	FEATURELAB_PACK_DIR=/path/to/Addon_bp go test ./goldentest/
//
// Unset, it is empty, SetupHarness reports ErrPackNotAvailable, and every
// caller that can skip does. That is the normal state of a clone; the
// fixture baseline below needs nothing from the environment at all.
var PackDir = os.Getenv("FEATURELAB_PACK_DIR")

// FixturePackRel is the repo-relative path of the PUBLIC fixture pack the
// second baseline is built from (TestFixtureDigest, pinned at
// goldentest/testdata/fixture_placement_digest.json). Unlike PackDir it is
// committed to this repo, so that baseline runs on any checkout, CI
// included — but it is also tiny and covers a small fraction of what a
// real content pack exercises. TestFixtureDigest prints exactly how small,
// every run, for the reason its header comment gives.
//
// The pack belongs to docs/wiki: every file under it is referenced by a
// documentation page. goldentest READS it and must never write to it or add
// files to it — a chain missing from it is a request to make of the wiki,
// not a file to drop in.
const FixturePackRel = "docs/wiki/tools/fixtures"

// Harness is the built environment + feature library the digest tests,
// benchmarks, and the regeneration tool all place features against.
type Harness struct {
	// PackLabel is what a regenerated digest's meta records as the pack it
	// came from. It is deliberately not the directory the pack was read
	// from: the fixture harness loads an absolute path resolved per machine
	// but labels it with the repo-relative FixturePackRel, so the committed
	// fixture digest carries no machine-specific path and two different
	// checkouts regenerate a byte-identical file.
	PackLabel string
	Lib       *features.Library
	Proto     *volume.Volume
	Baseline  volume.Snapshot
	Origin    wgen.BlockPos
	Biome     *wgen.MolangBiome
}

// SetupHarness builds the fixed environment/library recipe (plains preset,
// ENV_SEED=12345, origin = (0, defaultOriginY, 0)) against the pack at
// PackDir. Returns an error rather than calling testing.TB
// so it is usable from both *testing.T/B (which wrap the error into
// Skip/Fatal) and the standalone goldengen command.
func SetupHarness() (*Harness, error) {
	return SetupHarnessAt(PackDir, PackDir)
}

// SetupFixtureHarness is SetupHarness against the committed public fixture
// pack instead of PackDir — same preset, seeds, budgets, origin and
// biome, so a chain placed by either harness goes through identical code.
// Resolving the repo root (rather than assuming a working directory) is
// what lets `go test ./goldentest/` (cwd = goldentest/) and `go run
// ./goldentest/cmd/goldengen -pack fixture` (cwd = repo root) both find it.
func SetupFixtureHarness() (*Harness, error) {
	dir, err := FixturePackDir()
	if err != nil {
		return nil, err
	}
	return SetupHarnessAt(dir, FixturePackRel)
}

// FixturePackDir resolves FixturePackRel to an absolute directory. It first
// walks up from the working directory looking for this module's go.mod
// (covering `go test` inside goldentest/ and any command run from the repo
// root or below it), then falls back to the compiled-in source location of
// this file, whose parent directory is the repo root by construction. Each
// candidate is confirmed to actually exist before being returned, so a
// wrong guess fails here, loudly, rather than downstream as an unexplained
// "no feature files found".
func FixturePackDir() (string, error) {
	rel := filepath.FromSlash(FixturePackRel)
	var tried []string

	if wd, err := os.Getwd(); err == nil {
		for dir := wd; ; {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				cand := filepath.Join(dir, rel)
				if _, err := os.Stat(cand); err == nil {
					return cand, nil
				}
				tried = append(tried, cand)
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}

	if _, thisFile, _, ok := runtime.Caller(0); ok {
		cand := filepath.Join(filepath.Dir(filepath.Dir(thisFile)), rel)
		if _, err := os.Stat(cand); err == nil {
			return cand, nil
		}
		tried = append(tried, cand)
	}

	return "", fmt.Errorf("%w: cannot locate the fixture pack %s (tried %v)", ErrPackNotAvailable, FixturePackRel, tried)
}

// SetupHarnessAt is the shared body of SetupHarness and
// SetupFixtureHarness: build the one fixed recipe against the pack in
// packDir, labelling the result with label (see Harness.PackLabel for why
// those are two arguments and not one).
func SetupHarnessAt(packDir, label string) (*Harness, error) {
	if _, err := os.Stat(packDir); err != nil {
		return nil, fmt.Errorf("%w at %s: %w", ErrPackNotAvailable, packDir, err)
	}
	// Pack loading (walking features/structures/feature_rules/biomes into
	// SourceFile slices) used to be test-only code duplicated nowhere else;
	// it now lives in featurelab-go/pack so cmd/featurelab can load a real
	// pack directory too -- see that package's doc comment.
	loaded, err := pack.Load(pack.Options{Dir: packDir})
	if err != nil {
		return nil, fmt.Errorf("pack.Load(%s): %w", packDir, err)
	}
	if len(loaded.Features) == 0 {
		return nil, fmt.Errorf("no feature files found under %s", packDir)
	}
	if len(loaded.Structures) == 0 {
		return nil, fmt.Errorf("no structure files found under %s", packDir)
	}

	palette := block.NewPalette()
	structureLib := structures.BuildLibrary(loaded.Structures, palette)
	lib := features.BuildLibrary(loaded.Features, palette, structureLib)

	proto := volume.New(env.PlainsBounds, palette, block.AirID)
	env.BuildPlains(proto, EnvSeed)
	baseline := proto.Snapshot()
	origin := wgen.BlockPos{X: 0, Y: env.DefaultOriginY(proto), Z: 0}
	tags := make(map[string]struct{}, len(env.PlainsBiomeTags))
	for _, tg := range env.PlainsBiomeTags {
		tags[tg] = struct{}{}
	}
	biome := &wgen.MolangBiome{ID: env.PlainsBiomeID, Tags: tags}

	return &Harness{PackLabel: label, Lib: lib, Proto: proto, Baseline: baseline, Origin: origin, Biome: biome}, nil
}

// implementedFeatureTypes is the set of feature types this GOLDEN SUITE
// covers (scatter_feature, single_block_feature, aggregate_feature,
// sequence_feature, structure_template_feature, weighted_random_feature,
// conditional_list, snap_to_surface_feature,
// surface_relative_threshold_feature, scan_surface, ore_feature,
// tree_feature, search_feature, vegetation_patch_feature, and the three
// carvers: cave_carver_feature, nether_cave_carver_feature,
// underwater_cave_carver_feature). A chain that touches anything else is
// out of scope for both the digest tests and the regeneration tool.
//
// The name is a leftover from when the two sets WERE the same, and it is
// kept only because renaming it would touch the regeneration tool for no
// behavioural gain -- but do not read it as a coverage claim. `featurelab
// types` reports 21 implemented and 6 partial against these seventeen;
// geode, fossil, multiface, growing_plant, partially_exposed_blob,
// height_difference_filter, multi_block, multipart_block_column and
// horizontal_tree_decoration are all implemented and none of them is
// pinned by anything here. Adding one to this map is the deliberate act of
// bringing it under the digest, and it re-pins.
//
// The three carvers joined on 2026-08-22, when the fixture pack gained a
// second and third carver fixture. Two things had to change together: this
// map AND InScope's own leaf-type case below, which carries a second copy
// of the list. Adding a type to one and not the other looks like it
// worked -- the run stays green, and the coverage report simply says the
// type was not reached, which is what it said before. What the carvers buy
// is almost entirely DRAW coverage: at this suite's plains origin they
// write 433, 0 and 0 blocks respectively (nothing in a plains bench is
// netherrack, and the plains biome carries no "ocean" tag, so the
// underwater carver abandons every column), and they spend 21398, 5248 and
// 21398 draws. The draw hash is the part that matters: both of the carver
// defects found in the week before this landed moved the draw stream, and
// neither would have survived one run of this test.
var implementedFeatureTypes = map[string]bool{
	"minecraft:scatter_feature":                    true,
	"minecraft:single_block_feature":               true,
	"minecraft:aggregate_feature":                  true,
	"minecraft:sequence_feature":                   true,
	"minecraft:structure_template_feature":         true,
	"minecraft:weighted_random_feature":            true,
	"minecraft:conditional_list":                   true,
	"minecraft:snap_to_surface_feature":            true,
	"minecraft:surface_relative_threshold_feature": true,
	"minecraft:scan_surface":                       true,
	"minecraft:ore_feature":                        true,
	"minecraft:tree_feature":                       true,
	"minecraft:search_feature":                     true,
	"minecraft:vegetation_patch_feature":           true,
	"minecraft:cave_carver_feature":                true,
	"minecraft:nether_cave_carver_feature":         true,
	"minecraft:underwater_cave_carver_feature":     true,
}

// CoveredFeatureTypes returns implementedFeatureTypes' keys, sorted — the
// seventeen types both baselines advertise. TestFixtureDigest walks this to
// report which of them its (much smaller) corpus actually reaches, so that
// list can never drift from the map the scope walk really uses: add a type
// above and the coverage report starts naming it the same run.
func CoveredFeatureTypes() []string {
	out := make([]string, 0, len(implementedFeatureTypes))
	for t := range implementedFeatureTypes {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// InScope determines whether identifier's ENTIRE delegation chain is
// covered by implementedFeatureTypes — single_block_feature/
// structure_template_feature/ore_feature/tree_feature are always in scope
// (no delegation); the composite types are in scope iff every reference
// they could possibly delegate to is unresolved (deterministic immediate
// failure) or itself in scope (early_out only affects which children run
// at PLACE-time — this is a static walk over every reference the chain
// could possibly reach). Anything else is out of scope.
func InScope(identifier string, typeByID map[string]string, refsByID map[string][]string, visiting map[string]bool) bool {
	typeID, ok := typeByID[identifier]
	if !ok {
		return true // unresolved reference -- chain ends deterministically
	}
	switch typeID {
	case "minecraft:single_block_feature", "minecraft:structure_template_feature", "minecraft:ore_feature",
		"minecraft:tree_feature", "minecraft:cave_carver_feature", "minecraft:nether_cave_carver_feature",
		"minecraft:underwater_cave_carver_feature":
		return true
	case "minecraft:scatter_feature", "minecraft:aggregate_feature", "minecraft:sequence_feature",
		"minecraft:weighted_random_feature", "minecraft:conditional_list", "minecraft:snap_to_surface_feature",
		"minecraft:surface_relative_threshold_feature", "minecraft:scan_surface",
		"minecraft:search_feature", "minecraft:vegetation_patch_feature":
		if visiting[identifier] {
			return true // cycle: runtime recursion guard terminates it deterministically
		}
		visiting[identifier] = true
		defer delete(visiting, identifier)
		refs, ok := refsByID[identifier]
		if !ok {
			return true
		}
		for _, ref := range refs {
			if !InScope(ref, typeByID, refsByID, visiting) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// BuildScopeMaps walks lib's entries once, building the static type/
// reference maps InScope needs: typeByID for the switch above, refsByID for
// every composite type's static delegation targets.
func BuildScopeMaps(lib *features.Library) (typeByID map[string]string, refsByID map[string][]string) {
	typeByID = make(map[string]string, len(lib.Entries))
	refsByID = make(map[string][]string)
	for _, e := range lib.Entries {
		typeByID[e.Identifier] = e.TypeID
		if sf, ok := e.Feature.(*features.ScatterFeature); ok {
			refsByID[e.Identifier] = []string{sf.PlacesFeatureRef()}
		}
		if af, ok := e.Feature.(*features.AggregateFeature); ok {
			refsByID[e.Identifier] = af.FeatureRefs()
		}
		// The five composites below all expose FeatureRefs() the same way
		// aggregate does; weighted_random/conditional_list require their
		// WHOLE entry list in scope (which one actually gets delegated to
		// is runtime-random/Molang-conditional, not statically knowable),
		// snap_to_surface/surface_relative_threshold/scan_surface each wrap
		// exactly one target.
		if wr, ok := e.Feature.(*features.WeightedRandomFeature); ok {
			refsByID[e.Identifier] = wr.FeatureRefs()
		}
		if cl, ok := e.Feature.(*features.ConditionalListFeature); ok {
			refsByID[e.Identifier] = cl.FeatureRefs()
		}
		if sn, ok := e.Feature.(*features.SnapToSurfaceFeature); ok {
			refsByID[e.Identifier] = sn.FeatureRefs()
		}
		if sr, ok := e.Feature.(*features.SurfaceRelativeThresholdFeature); ok {
			refsByID[e.Identifier] = sr.FeatureRefs()
		}
		if ss, ok := e.Feature.(*features.ScanSurfaceFeature); ok {
			refsByID[e.Identifier] = ss.FeatureRefs()
		}
		if sf2, ok := e.Feature.(*features.SearchFeature); ok {
			refsByID[e.Identifier] = sf2.FeatureRefs()
		}
		if vp, ok := e.Feature.(*features.VegetationPatchFeature); ok {
			refsByID[e.Identifier] = vp.FeatureRefs()
		}
	}
	return typeByID, refsByID
}

// InScopeEntries returns every library entry of an implemented feature type
// whose entire delegation chain is itself in scope, in library order. This
// is the single definition of "in scope" the digest comparison and the
// regeneration tool both use, so the two can never silently disagree about
// which chains are being compared/pinned.
func InScopeEntries(lib *features.Library) []features.Entry {
	typeByID, refsByID := BuildScopeMaps(lib)
	visiting := make(map[string]bool)
	var out []features.Entry
	for _, e := range lib.Entries {
		if !implementedFeatureTypes[e.TypeID] {
			continue
		}
		if !InScope(e.Identifier, typeByID, refsByID, visiting) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// PlacementOutcome is everything one Place() call produced: the writes and
// RNG draws it made (in call order), the position it returned (if any),
// the resulting Molang scope, and which of the two budget panics (if
// either) stopped it.
type PlacementOutcome struct {
	Writes      []WriteRecord
	Draws       []random.DrawRecord
	Returned    *wgen.BlockPos
	Scope       []ScopeEntry
	BudgetError string // "write_budget_exceeded" | "delegation_budget_exceeded" | ""
	OtherError  string
}

// PlaceOne restores proto to baseline, then places feature at origin with a
// fresh RNG (seeded FeatureSeed) and a fresh Molang scope, recording every
// successful write and every RNG draw exactly as the golden digest
// contract requires (see EncodeWrites/EncodeDraws).
func PlaceOne(feature wgen.IFeature, proto *volume.Volume, baseline volume.Snapshot, origin wgen.BlockPos, biome *wgen.MolangBiome) PlacementOutcome {
	proto.Restore(baseline)
	wb := WriteBudget
	proto.WriteBudget = &wb
	proto.WritesAttempted = 0
	db := DelegationBudget
	features.SetDelegationBudget(&db)

	rnd := random.New(FeatureSeed)
	tracer := random.NewTracer(rnd)
	rec := &RecordingVolume{Inner: proto}
	scope := wgen.NewScope()
	ctx := &wgen.PlacementContext{API: rec, Origin: origin, Random: tracer, MolangScope: scope, Biome: biome}

	var out PlacementOutcome
	func() {
		defer func() {
			if r := recover(); r != nil {
				switch r.(type) {
				case *volume.WriteBudgetExceeded:
					out.BudgetError = "write_budget_exceeded"
				case *features.DelegationBudgetExceeded:
					out.BudgetError = "delegation_budget_exceeded"
				default:
					out.OtherError = errString(r)
				}
			}
		}()
		out.Returned = feature.Place(ctx)
	}()

	out.Writes = rec.Writes
	out.Draws = tracer.Draws
	out.Scope = ScopeEntries(scope)
	return out
}

func errString(r any) string {
	if err, ok := r.(error); ok {
		return err.Error()
	}
	if s, ok := r.(string); ok {
		return s
	}
	return "panic"
}
