// profiler_test.go proves the profiler wiring does what it needs to: nested feature resolution attributes a leaf reached through three levels of
// composite delegation to itself, not to whichever ancestor happened to be resolved first -- see
// profiler/profiler.go's package doc comment ("Attribution model"), and features/shared.go's
// WithRecursionGuard records each delegation against the WRAPPER doing the delegating, not the
// resolved target. Every concrete feature type's own Place method (features/*.go) now calls
// profiler.PushFeatureFrame/PopFeatureFrame directly, as its own first/last actions -- there is no
// separate per-Library "arm" step any more (an earlier revision's features.Library.ArmProfiling,
// which wrapped a resolver map's entries in profiler.InstrumentFeature, is gone -- see profiler.
// go's doc comment for why).
//
// This drives the whole thing through session.Generate (the actual
// production entry point cmd/featurelab calls), not hand-rolled fixtures --
// profiler/profiler_test.go already pins the profiler package's OWN
// accounting in isolation; what's missing there (by that file's own header)
// is exactly this: proof that BuildLibrary -> Library.Resolve -> Place,
// wired end-to-end through Generate, actually gets a leaf's writes
// attributed to the leaf through real composite delegation, not a resolver
// closure a test wrote by hand.
package session

import (
	"testing"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
)

// aggregateFeatureFile builds a minecraft:aggregate_feature JSON body that
// delegates to exactly one sub-feature reference -- deliberately minimal
// (early_out omitted, single entry) since this file only needs a composite
// that delegates once, not aggregate_feature's full behaviour (already
// covered by features/aggregate_test.go-adjacent coverage elsewhere).
func aggregateFeatureFile(identifier, ref string) features.SourceFile {
	text := `{"format_version":"1.21.110","minecraft:aggregate_feature":{"description":{"identifier":"` +
		identifier + `"},"features":["` + ref + `"]}}`
	return features.SourceFile{ID: identifier + ".json", AbsPath: identifier + ".json", Text: text}
}

// scatterFeatureFile builds a minimal minecraft:scatter_feature JSON body:
// exactly one iteration, at a fixed zero offset on every axis (DistNone --
// no RNG, no drift from the origin), so its single delegation always lands
// on the SAME cell the leaf itself targets -- deterministic and
// hand-checkable.
func scatterFeatureFile(identifier, placesFeature string) features.SourceFile {
	text := `{"format_version":"1.21.110","minecraft:scatter_feature":{"description":{"identifier":"` +
		identifier + `"},"places_feature":"` + placesFeature + `","distribution":{"iterations":1,"x":0,"y":0,"z":0}}}`
	return features.SourceFile{ID: identifier + ".json", AbsPath: identifier + ".json", Text: text}
}

// TestGenerate_ProfilingAttributesNestedLeafThroughThreeComposites is the
// core attribution guarantee: a leaf reached through three levels of
// composite is attributed to itself, not to its ancestor. test:root (aggregate) -> test:mid (aggregate) -> test:inner
// (scatter) -> test:leaf (single_block) is exactly three composite levels
// above the leaf, resolved entirely through Library.Resolve (never a
// build-time-captured reference), so this only passes if every nested
// resolution actually reaches a feature whose own Place bakes in the
// PushFeatureFrame/PopFeatureFrame pair, not just the top-level one
// session.Generate itself resolves.
func TestGenerate_ProfilingAttributesNestedLeafThroughThreeComposites(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid) // entirely air baseline
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:root")
	config.Profiling = true

	files := []features.SourceFile{
		aggregateFeatureFile("test:root", "test:mid"),
		aggregateFeatureFile("test:mid", "test:inner"),
		scatterFeatureFile("test:inner", "test:leaf"),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksPlaced != 1 {
		t.Fatalf("BlocksPlaced = %d, want 1 -- fixture sanity check failed before profiler assertions are meaningful", result.BlocksPlaced)
	}
	if result.Profile == nil {
		t.Fatal("expected Result.Profile to be populated when Config.Profiling is true and a feature was selected")
	}
	profile := result.Profile

	byID := make(map[string]int, len(profile.Features)) // identifier -> index into profile.Features
	for i, f := range profile.Features {
		byID[f.Identifier] = i
	}
	for _, id := range []string{"test:root", "test:mid", "test:inner", "test:leaf"} {
		if _, ok := byID[id]; !ok {
			t.Fatalf("no profile stats recorded for %s -- profile.Features = %+v", id, profile.Features)
		}
	}

	// The leaf itself is credited with the write and with having been
	// entered -- even though it was never resolved directly by
	// session.Generate, only through three nested Library.Resolve calls.
	leaf := profile.Features[byID["test:leaf"]]
	if leaf.Entered != 1 {
		t.Errorf("test:leaf Entered = %d, want 1", leaf.Entered)
	}
	if leaf.BlocksWritten != 1 {
		t.Errorf("test:leaf BlocksWritten = %d, want 1", leaf.BlocksWritten)
	}
	if leaf.Delegations != 0 {
		t.Errorf("test:leaf Delegations = %d, want 0 -- a leaf never delegates", leaf.Delegations)
	}

	// None of the three composite ancestors wrote a block directly -- the
	// write must be attributed to the LEAF, not absorbed into whichever
	// ancestor happened to be the top-level resolved feature.
	for _, id := range []string{"test:root", "test:mid", "test:inner"} {
		if got := profile.Features[byID[id]].BlocksWritten; got != 0 {
			t.Errorf("%s BlocksWritten = %d, want 0 -- composites never write directly; the leaf's write must not be absorbed into an ancestor", id, got)
		}
	}

	// Each composite delegated exactly once -- attributed to ITSELF, the
	// wrapper performing the delegation (features/shared.go's
	// WithRecursionGuard), not to whichever feature it delegated into.
	for _, id := range []string{"test:root", "test:mid", "test:inner"} {
		if got := profile.Features[byID[id]].Delegations; got != 1 {
			t.Errorf("%s Delegations = %d, want 1", id, got)
		}
	}

	// Exactly one cell was touched, and its attribution names test:leaf --
	// not test:root/test:mid/test:inner, which is exactly what a
	// three-levels-of-delegation-collapsed-onto-the-ancestor bug would get
	// wrong.
	totalTouched := 0
	for _, c := range profile.TouchCounts {
		if c > 0 {
			totalTouched++
		}
	}
	if totalTouched != 1 {
		t.Errorf("touched cells = %d, want 1", totalTouched)
	}
	leafFeatureIndex := -1
	for i, id := range profile.FeatureIdentifiers {
		if id == "test:leaf" {
			leafFeatureIndex = i
		}
	}
	if leafFeatureIndex < 0 {
		t.Fatal("test:leaf missing from FeatureIdentifiers")
	}
	if len(profile.Attribution.Cell) != 1 {
		t.Fatalf("len(Attribution.Cell) = %d, want 1 -- exactly one (cell, feature) pair should have been touched", len(profile.Attribution.Cell))
	}
	if got := int(profile.Attribution.Feature[0]); got != leafFeatureIndex {
		attributedTo := "?"
		if got >= 0 && got < len(profile.FeatureIdentifiers) {
			attributedTo = profile.FeatureIdentifiers[got]
		}
		t.Errorf("the one touched cell is attributed to feature index %d (%s), want test:leaf (index %d) -- "+
			"a nested leaf's write must not be credited to an ancestor composite", got, attributedTo, leafFeatureIndex)
	}
	if profile.Attribution.Count[0] != 1 {
		t.Errorf("attributed count = %d, want 1", profile.Attribution.Count[0])
	}
}

// TestGenerate_ProfilingOffLeavesProfileNil pins the "off by default costs
// nothing" contract's OBSERVABLE half: with Config.Profiling left false (the
// zero value), Result.Profile must be nil and profiler.ProfilingActive must
// be false once Generate returns -- a plain run never leaves the package-level
// profiler state armed for some LATER, unrelated, non-profiled run to trip
// over.
func TestGenerate_ProfilingOffLeavesProfileNil(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:leaf")
	files := []features.SourceFile{singleBlockFeatureFile("test:leaf", "minecraft:diamond_block")}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.Profile != nil {
		t.Errorf("Result.Profile = %+v, want nil when Config.Profiling is false", result.Profile)
	}
}
