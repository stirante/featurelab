// stops_test.go drives profiler stops end to end: a small pack whose placement stops at a gate,
// generated with profiling on, must name the gate on the feature that holds it -- and, on the
// top-level Result.Stops rows, must name it on an ORDINARY generate with profiling off too.
package session

import (
	"encoding/json"
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

// generateStops runs an ORDINARY generate -- profiling off, exactly what a preview does -- and
// returns the top-level rows.
func generateStops(t *testing.T, config Config, files []features.SourceFile, ruleFiles []rules.SourceFile) (*Result, []profiler.StopRow) {
	t.Helper()
	if config.Profiling {
		t.Fatal("generateStops is the profiling-OFF path")
	}
	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.Profile != nil {
		t.Fatal("Result.Profile must stay nil when profiling was not requested")
	}
	return result, result.Stops
}

// TestStops_TopLevelWithoutProfiling is the point of the whole cheap tier: a scatter whose
// iterations round to 0 explains itself on a plain generate, with no profiler armed.
func TestStops_TopLevelWithoutProfiling(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:leaf","distribution":{"iterations":0.3,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}
	config := voidFeatureConfig(t, "test:scatter")
	result, rows := generateStops(t, config, files, nil)

	if result.BlocksPlaced != 0 {
		t.Fatalf("BlocksPlaced = %d, want 0 -- this pack is supposed to place nothing", result.BlocksPlaced)
	}
	if len(rows) != 1 {
		t.Fatalf("stops = %+v, want exactly one row", rows)
	}
	r := rows[0]
	if r.Identifier != "test:scatter" || r.Reason != profiler.StopIterationsZero {
		t.Errorf("row = %+v, want test:scatter / iterations_zero", r)
	}
	if !strings.Contains(r.Detail, "iterations = 0 (from 0.3") {
		t.Errorf("detail = %q, want the evaluated value", r.Detail)
	}
	if r.Ordinal != nil {
		t.Errorf("ordinal = %d, want omitted -- the gate is the whole feature's", *r.Ordinal)
	}

	// The count is the run's real one, not a placeholder: the same pack profiled must agree.
	profiled := stopsOf(t, voidFeatureConfig(t, "test:scatter"), files, nil, "test:scatter")
	if len(profiled) != 1 || profiled[0].Count != r.Count {
		t.Errorf("unprofiled count %d disagrees with the profiled %+v", r.Count, profiled)
	}
}

// TestStops_TopLevelCountsEveryChunkWithoutProfiling pins a count above one through the rule
// path, which runs the gate once per chunk of the bench.
func TestStops_TopLevelCountsEveryChunkWithoutProfiling(t *testing.T) {
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
	_, rows := generateStops(t, config, files, ruleFiles)

	if len(rows) != 1 {
		t.Fatalf("stops = %+v, want exactly one row", rows)
	}
	if rows[0].Reason != profiler.StopBiomeFilterRejected || rows[0].Identifier != "test:rule" {
		t.Errorf("row = %+v, want test:rule / biome_filter_rejected", rows[0])
	}
	if rows[0].Count != 4 {
		t.Errorf("count = %d, want 4 -- once per chunk of the default bench", rows[0].Count)
	}
}

// TestStops_HealthyGenerateHasNoRows: nothing stopped, nothing to say. The field is absent
// entirely, so a client never has to tell "no stops" from "old engine".
func TestStops_HealthyGenerateHasNoRows(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:leaf","distribution":{"iterations":4,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}
	result, rows := generateStops(t, voidFeatureConfig(t, "test:scatter"), files, nil)

	if result.BlocksPlaced == 0 {
		t.Fatal("BlocksPlaced = 0 -- this pack is supposed to place something")
	}
	if rows != nil {
		t.Fatalf("stops = %+v, want none on a healthy run", rows)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(encoded), `"stops"`) {
		t.Error(`a healthy result must omit "stops" from the wire shape entirely`)
	}
}

// TestStops_ProfiledRunCarriesBothViews: arming the profiler adds the per-feature view without
// taking the top-level one away, and the two agree.
func TestStops_ProfiledRunCarriesBothViews(t *testing.T) {
	files := []features.SourceFile{
		featureFile("test:list", "minecraft:conditional_list",
			`"conditional_features":[`+
				`{"places_feature":"test:leaf","condition":1},`+
				`{"places_feature":"test:other","condition":"v.originx > 1000000"}]`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
		singleBlockFeatureFile("test:other", "minecraft:gold_block"),
	}
	config := voidFeatureConfig(t, "test:list")
	config.Profiling = true
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.Profile == nil {
		t.Fatal("Result.Profile is nil")
	}
	var stat *profiler.StopStat
	for _, f := range result.Profile.Features {
		if f.Identifier == "test:list" && len(f.Stops) == 1 {
			stat = &f.Stops[0]
		}
	}
	if stat == nil {
		t.Fatalf("profile.features[test:list].stops missing: %+v", result.Profile.Features)
	}
	if len(result.Stops) != 1 {
		t.Fatalf("stops = %+v, want one top-level row on a profiled run too", result.Stops)
	}
	r := result.Stops[0]
	if r.Identifier != "test:list" || r.Reason != stat.Reason || r.Count != stat.Count || r.Detail != stat.Detail {
		t.Errorf("top-level row %+v disagrees with profile stop %+v", r, *stat)
	}
	if r.Ordinal == nil || stat.Ordinal == nil || *r.Ordinal != *stat.Ordinal {
		t.Errorf("ordinals disagree: %v vs %v", r.Ordinal, stat.Ordinal)
	}
}

// TestStops_DoNotLeakBetweenRuns: each generate reports its OWN stops, so a second, healthy run
// in the same process does not inherit the first's.
func TestStops_DoNotLeakBetweenRuns(t *testing.T) {
	stopping := []features.SourceFile{
		featureFile("test:scatter", "minecraft:scatter_feature",
			`"places_feature":"test:leaf","distribution":{"iterations":0,"x":0,"y":0,"z":0}`),
		singleBlockFeatureFile("test:leaf", "minecraft:diamond_block"),
	}
	if _, rows := generateStops(t, voidFeatureConfig(t, "test:scatter"), stopping, nil); len(rows) == 0 {
		t.Fatal("first run should have stopped")
	}
	healthy := []features.SourceFile{singleBlockFeatureFile("test:leaf", "minecraft:diamond_block")}
	if _, rows := generateStops(t, voidFeatureConfig(t, "test:leaf"), healthy, nil); rows != nil {
		t.Errorf("second run inherited %+v", rows)
	}
}
