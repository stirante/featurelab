package session

// stops_suggest_test.go is the "did you mean" reaching the PREVIEW.
//
// The near-match machinery has been in this repo for a while and reached exactly one situation:
// the identifier a caller REQUESTED. `generate --feature wiki:rng_markr` suggested
// `wiki:rng_marker`; the identical typo written as a `"places_feature"` inside a file produced
// `wiki:rng_markr not found` and nothing else. Same mistake, same pack, same fix, and the help
// only on the path where the author had already typed the name themselves.
//
// It is asserted on the STOP rather than on the placement failure beside it because the stop is
// where the reference is named. A scatter that cannot resolve its target logs "No features could
// be placed" -- a sentence about the scatter, correct, and no place to hang a spelling hint
// about a name it does not mention.

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/rules"
)

func TestStops_UnresolvedDelegationOffersTheNearMatch(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:rng_markr","distribution":{"iterations":1,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:rng_marker", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:scatter"), files, nil, "test:scatter")
	wantSingleStop(t, stops, profiler.StopUnresolvedReference, `did you mean "test:rng_marker"?`, profiler.NoOrdinal)
}

// The reference itself stays at the front of the detail. The suggestion is appended, never
// substituted: a reader has to be able to see WHICH name did not resolve, and the clause after it
// is a guess about what it should have been.
func TestStops_UnresolvedDelegationStillNamesTheReference(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:rng_markr","distribution":{"iterations":1,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:rng_marker", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:scatter"), files, nil, "test:scatter")
	if len(stops) != 1 {
		t.Fatalf("stops = %+v, want exactly one", stops)
	}
	if !strings.HasPrefix(stops[0].Detail, "test:rng_markr not found") {
		t.Errorf("detail = %q, want it to open with the reference that did not resolve", stops[0].Detail)
	}
}

// Nothing close enough means nothing said. A message that always ends in a guess is a message
// whose guesses stop being read.
func TestStops_UnresolvedDelegationWithNoNearMatchSuggestsNothing(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:completely_different_thing","distribution":{"iterations":1,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:rng_marker", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:scatter"), files, nil, "test:scatter")
	if len(stops) != 1 {
		t.Fatalf("stops = %+v, want exactly one", stops)
	}
	if strings.Contains(stops[0].Detail, "did you mean") {
		t.Errorf("detail = %q, want no guess when nothing in the pack is close", stops[0].Detail)
	}
}

// A conditional_list's detail carries its own clause ("; list ended") and the suggestion has to
// come after it, not through the middle of it.
func TestStops_ConditionalListUnresolvedEntryReadsInOrder(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:list", "minecraft:conditional_list",
			`"conditional_features":[{"places_feature":"test:rng_markr","condition":1}]`),
		singleBlockFeatureFile("test:rng_marker", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:list"), files, nil, "test:list")
	if len(stops) != 1 {
		t.Fatalf("stops = %+v, want exactly one", stops)
	}
	want := `test:rng_markr not found; list ended -- did you mean "test:rng_marker"?`
	if stops[0].Detail != want {
		t.Errorf("detail = %q, want %q", stops[0].Detail, want)
	}
}

// A feature rule's own places_feature goes through the same helper, so the rule path does not
// become the one place a typo gets no help.
func TestStops_RuleUnresolvedFeatureOffersTheNearMatch(t *testing.T) {
	config := voidFeatureConfig(t, "test:unused")
	config.FeatureIdentifier = nil
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr("test:rule")

	files := []features.SourceFile{singleBlockFeatureFile("test:rng_marker", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		ruleSourceFile("rule.json", "test:rule", "test:rng_markr",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}, nil),
	}
	stops := stopsOf(t, config, files, ruleFiles, "test:rule")
	wantSingleStop(t, stops, profiler.StopUnresolvedReference, `did you mean "test:rng_marker"?`, profiler.NoOrdinal)
}
