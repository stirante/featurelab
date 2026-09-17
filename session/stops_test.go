// stops_test.go drives profiler stops end to end: a small pack whose placement stops at a gate,
// generated with profiling on, must name the gate on the feature that holds it.
package session

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/rules"
)

func featureFile(identifier, typeID, body string) features.SourceFile {
	text := `{"format_version":"1.21.110","` + typeID + `":{"description":{"identifier":"` +
		identifier + `"},` + body + `}}`
	return features.SourceFile{ID: identifier + ".json", AbsPath: identifier + ".json", Text: text}
}

// stopsOf generates with profiling on and returns the named feature's stops.
func stopsOf(t *testing.T, config Config, files []features.SourceFile, ruleFiles []rules.SourceFile, identifier string) []profiler.StopStat {
	t.Helper()
	config.Profiling = true
	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.Profile == nil {
		t.Fatal("Result.Profile is nil")
	}
	for _, f := range result.Profile.Features {
		if f.Identifier == identifier {
			return f.Stops
		}
	}
	t.Fatalf("no profile row for %s in %+v", identifier, result.Profile.Features)
	return nil
}

func wantSingleStop(t *testing.T, stops []profiler.StopStat, reason, detailPart string, ordinal int) {
	t.Helper()
	if len(stops) != 1 {
		t.Fatalf("stops = %+v, want exactly one %s", stops, reason)
	}
	s := stops[0]
	got := profiler.NoOrdinal
	if s.Ordinal != nil {
		got = *s.Ordinal
	}
	if s.Reason != reason || !strings.Contains(s.Detail, detailPart) || s.Count < 1 || got != ordinal {
		t.Errorf("stop = %+v (ordinal %d), want reason %s, detail containing %q, ordinal %d",
			s, got, reason, detailPart, ordinal)
	}
}

func voidFeatureConfig(t *testing.T, identifier string) Config {
	t.Helper()
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr(identifier)
	return config
}

func TestStops_ScatterIterationsZero(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:leaf","distribution":{"iterations":0.3,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:scatter"), files, nil, "test:scatter")
	wantSingleStop(t, stops, "iterations_zero", "iterations = 0 (from 0.3", profiler.NoOrdinal)
}

func TestStops_ScatterChanceZero(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:leaf","distribution":{"iterations":4,"scatter_chance":"v.originx * 0","x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:scatter"), files, nil, "test:scatter")
	wantSingleStop(t, stops, "chance_zero", "scatter_chance = 0%", profiler.NoOrdinal)
}

func TestStops_ConditionalListEntryConditionZero(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:list", "minecraft:conditional_list",
			`"conditional_features":[`+
				`{"places_feature":"test:leaf","condition":1},`+
				`{"places_feature":"test:other","condition":"v.originx > 1000000"}]`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
		singleBlockFeatureFile("test:other", "minecraft:gold_block"),
	}
	stops := stopsOf(t, voidFeatureConfig(t, "test:list"), files, nil, "test:list")
	wantSingleStop(t, stops, "condition_false", "test:other", 1)
}

func TestStops_SurfaceRelativeThresholdRejects(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:threshold")
	files := []features.SourceFile{
		featureFile("test:threshold", "minecraft:surface_relative_threshold_feature",
			`"feature_to_place":"test:leaf","minimum_distance_below_surface":16`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}
	stops := stopsOf(t, config, files, nil, "test:threshold")
	wantSingleStop(t, stops, "surface_threshold_rejected", "needs more than 16", profiler.NoOrdinal)
}

func TestStops_RuleBiomeFilterRejects(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr("test:rule")
	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		ruleSourceFile("rule.json", "test:rule", "test:place_diamond",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0},
			map[string]any{"minecraft:biome_filter": map[string]any{"test": "has_biome_tag", "value": "monster"}}),
	}
	stops := stopsOf(t, config, files, ruleFiles, "test:rule")
	wantSingleStop(t, stops, "biome_filter_rejected", "rejected by filter", profiler.NoOrdinal)
	if stops[0].Count != 4 {
		t.Errorf("count = %d, want 4 -- once per chunk of the default bench", stops[0].Count)
	}
}
