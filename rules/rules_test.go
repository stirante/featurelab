// rules_test.go covers rule JSON parsing
// (identifier/places_feature/placement_pass/biome_filter shapes actually
// seen in practice), and PlaceFeatureRule's fixed_grid origin
// set / biome-filter-rejection / unresolved-places_feature behaviour.
//
// No golden dump exists for feature_rules (goldentest's
// feature_placement_digest.json/feature_placement_detail.json both cover
// minecraft:*_feature placement, not feature_rules) -- these tests are
// therefore behavioural assertions, not a byte-for-byte digest comparison.
// The fixed_grid case
// below draws zero RNG (see distribution.go's EvalCoordinateRange:
// fixed_grid with stepSize<2 never calls into the RNG), so it is a fully
// deterministic check of RNG-order-sensitive control flow (grid index
// threading across axes) without needing a shared RNG stream to compare
// against.
package rules

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

// TestBuildFeatureRuleLibrary_TolerateJsoncComments is the direct regression test for the
// jsonc.StripComments pre-pass parseRuleFile now runs: a real vanilla-style feature_rules file
// with a "//" line comment must parse cleanly instead of producing an "invalid JSON" diagnostic.
func TestBuildFeatureRuleLibrary_TolerateJsoncComments(t *testing.T) {
	text := `{
		"format_version": "1.13.0",
		"minecraft:feature_rules": {
			"description": {
				// a vanilla-style comment right before identifier
				"identifier": "wiki:commented_rule",
				"places_feature": "wiki:some_feature"
			},
			"conditions": {"placement_pass": "surface_pass"},
			"distribution": {
				"iterations": 1,
				"x": {"distribution": "fixed_grid", "extent": [0, 15]},
				"y": 64,
				"z": {"distribution": "fixed_grid", "extent": [0, 15]}
			}
		}
	}`
	// The file is named for its identifier's name half on purpose: an identifier that does not
	// match the filename is a (separate, engine-mirrored) warning, and this test asserts NO
	// diagnostics at all.
	lib := BuildFeatureRuleLibrary([]SourceFile{{ID: "commented_rule.json", AbsPath: "/virtual/rules/commented_rule.json", Text: text}})
	for _, d := range lib.Diagnostics {
		t.Errorf("unexpected diagnostic: %+v", d)
	}
	if lib.Resolve("wiki:commented_rule") == nil {
		t.Fatal("expected wiki:commented_rule to be loaded despite the JSON comment")
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// ruleSourceFile builds a well-formed rule file. conditions.placement_pass is REQUIRED by the
// engine (a file without it does not load at all), so a caller that passes nil conditions -- or
// conditions carrying only a biome filter -- gets a valid pass filled in here. Tests that are
// ABOUT the pass spell their conditions out instead of relying on this.
func ruleSourceFile(id, identifier, placesFeature string, distribution map[string]any, conditions map[string]any) SourceFile {
	if conditions == nil {
		conditions = map[string]any{}
	}
	if _, ok := conditions["placement_pass"]; !ok {
		filled := make(map[string]any, len(conditions)+1)
		for k, v := range conditions {
			filled[k] = v
		}
		filled["placement_pass"] = "surface_pass"
		conditions = filled
	}
	body := map[string]any{
		"description":  map[string]any{"identifier": identifier, "places_feature": placesFeature},
		"conditions":   conditions,
		"distribution": distribution,
	}
	return SourceFile{ID: id, AbsPath: "/virtual/rules/" + id, Text: mustJSON(map[string]any{
		"format_version":          "1.21.110",
		"minecraft:feature_rules": body,
	})}
}

// ruleFileFromBody builds a rule file from a raw `minecraft:feature_rules` body, with nothing
// filled in -- the shape every "the engine refuses / drops this" test needs.
func ruleFileFromBody(id string, body map[string]any) SourceFile {
	return SourceFile{ID: id, AbsPath: "/virtual/rules/" + id, Text: mustJSON(map[string]any{
		"format_version":          "1.21.110",
		"minecraft:feature_rules": body,
	})}
}

// descriptionFor is the description half every raw-body test needs, spelled once.
func descriptionFor(identifier string) map[string]any {
	return map[string]any{"identifier": identifier, "places_feature": "wiki:target"}
}

// simpleDistribution is a one-iteration, zero-offset distribution: enough to load, and it draws
// no RNG.
func simpleDistribution() map[string]any {
	return map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}
}

// diagnosticsMentioning collects the diagnostics whose message contains substr.
func diagnosticsMentioning(lib *FeatureRuleLibrary, substr string) []string {
	var out []string
	for _, d := range lib.Diagnostics {
		if contains(d.Message, substr) {
			out = append(out, d.Level+": "+d.Message)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// noRNG -- any draw is a test failure, proving a code path is genuinely
// RNG-free.
// ---------------------------------------------------------------------------

type noRNG struct{ t *testing.T }

// losingRNG permits exactly one kind of draw -- the bounded int a fraction
// scatter_chance makes -- and always loses it. Every other draw is still a
// test failure, so it stays as strict as noRNG about the rest.
type losingRNG struct{ noRNG }

func (l losingRNG) NextIntBound(bound int) int { return bound - 1 }

func (n noRNG) NextInt() int32 {
	n.t.Fatal("unexpected RNG draw: NextInt")
	return 0
}
func (n noRNG) NextIntBound(int) int {
	n.t.Fatal("unexpected RNG draw: NextIntBound")
	return 0
}
func (n noRNG) NextFloat() float64 {
	n.t.Fatal("unexpected RNG draw: NextFloat")
	return 0
}
func (n noRNG) NextDouble() float64 {
	n.t.Fatal("unexpected RNG draw: NextDouble")
	return 0
}
func (n noRNG) NextBoolean() bool {
	n.t.Fatal("unexpected RNG draw: NextBoolean")
	return false
}
func (n noRNG) NextUnsignedInt(uint32) uint32 {
	n.t.Fatal("unexpected RNG draw: NextUnsignedInt")
	return 0
}
func (n noRNG) SetSeed(uint32) {
	n.t.Fatal("unexpected RNG reseed: SetSeed")
}
func (n noRNG) GetSeed() uint32 {
	n.t.Fatal("unexpected RNG read: GetSeed")
	return 0
}

var _ random.IRandom = noRNG{}

func molangBiome(id string, tags ...string) *wgen.MolangBiome {
	set := make(map[string]struct{}, len(tags))
	for _, t := range tags {
		set[t] = struct{}{}
	}
	return &wgen.MolangBiome{ID: id, Tags: set}
}

// ---------------------------------------------------------------------------
// Rule parsing
// ---------------------------------------------------------------------------

func TestParsing_PlacesFeaturePlacementPassAndBiomeFilter(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile(
			"canyon_terraform.fr.json", "wiki:canyon_terraform.fr", "wiki:canyon_shave_and_terraform.f",
			map[string]any{"iterations": 256.0, "x": map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 15.0}}, "y": 112.0, "z": map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 15.0}}},
			map[string]any{"placement_pass": "before_surface_pass", "minecraft:biome_filter": map[string]any{"test": "has_biome_tag", "value": "canyon"}},
		),
	})
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("diagnostics = %+v, want none", lib.Diagnostics)
	}
	rule := lib.Resolve("wiki:canyon_terraform.fr")
	if rule == nil {
		t.Fatal("expected rule to resolve")
	}
	if rule.PlacesFeature != "wiki:canyon_shave_and_terraform.f" {
		t.Errorf("placesFeature = %q", rule.PlacesFeature)
	}
	if rule.PlacementPass == nil || *rule.PlacementPass != "before_surface_pass" {
		t.Errorf("placementPass = %v", rule.PlacementPass)
	}
	if got := DescribeBiomeFilter(rule.BiomeFilter); got != "has_biome_tag('canyon')" {
		t.Errorf("describeBiomeFilter = %q", got)
	}
}

func TestParsing_EmptyBiomeFilterAlwaysMatches(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("highland.main.json", "wiki:highland.main", "wiki:highland_this_and_neighbours",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0},
			map[string]any{"placement_pass": "first_pass", "minecraft:biome_filter": map[string]any{}}),
	})
	rule := lib.Resolve("wiki:highland.main")
	if rule == nil {
		t.Fatal("expected rule to resolve")
	}
	if !EvaluateBiomeFilter(rule.BiomeFilter, molangBiome("anything")) {
		t.Error("expected empty filter to match any biome")
	}
	if !EvaluateBiomeFilter(rule.BiomeFilter, nil) {
		t.Error("expected empty filter to match a nil biome")
	}
}

// A rule whose conditions carry a pass and nothing else still gets the always-matching default
// biome filter. If this broke, an unfiltered rule would silently stop matching any biome --
// the engine treats an absent minecraft:biome_filter as "no filter", not "matches nothing".
func TestParsing_MissingBiomeFilterDefaultsToAlwaysMatching(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("bare.json", "wiki:bare", "wiki:bare_target", simpleDistribution(),
			map[string]any{"placement_pass": "surface_pass"}),
	})
	rule := lib.Resolve("wiki:bare")
	if rule == nil {
		t.Fatalf("expected rule to resolve; diagnostics = %+v", lib.Diagnostics)
	}
	if rule.PlacementPass == nil || *rule.PlacementPass != "surface_pass" {
		t.Errorf("placementPass = %v, want surface_pass", rule.PlacementPass)
	}
	if !EvaluateBiomeFilter(rule.BiomeFilter, nil) {
		t.Error("expected default filter to always match")
	}
}

// ---------------------------------------------------------------------------
// conditions / placement_pass -- REQUIRED by the engine's schema
// ---------------------------------------------------------------------------

// The engine's rule schema marks `conditions` and `conditions.placement_pass` required: a file
// missing either reports "missing required field" and does NOT load, so no rule is inserted and
// nothing it would place ever appears. If these assertions broke, this tool would show
// placements for a file the game silently ignores -- the single most expensive kind of wrong
// answer it can give a pack author.
func TestParsing_ConditionsAndPlacementPassAreRequired(t *testing.T) {
	cases := []struct {
		name       string
		conditions any
		present    bool
		wantLoad   bool
		wantIn     string
	}{
		{name: "no conditions key at all", present: false, wantIn: `"conditions" is required`},
		{name: "conditions is null", conditions: nil, present: true, wantIn: `"conditions" is required`},
		{name: "conditions without placement_pass", conditions: map[string]any{}, present: true,
			wantIn: "conditions.placement_pass is required"},
		{name: "only a biome filter", present: true,
			conditions: map[string]any{"minecraft:biome_filter": map[string]any{}},
			wantIn:     "conditions.placement_pass is required"},
		{name: "placement_pass is not a string", present: true,
			conditions: map[string]any{"placement_pass": 3.0},
			wantIn:     "conditions.placement_pass must be a string"},
		{name: "a real pass", present: true, wantLoad: true,
			conditions: map[string]any{"placement_pass": "underground_pass"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{
				"description":  descriptionFor("wiki:cond"),
				"distribution": simpleDistribution(),
			}
			if tc.present {
				body["conditions"] = tc.conditions
			}
			lib := BuildFeatureRuleLibrary([]SourceFile{ruleFileFromBody("cond.json", body)})
			got := lib.Resolve("wiki:cond")
			if tc.wantLoad {
				if got == nil {
					t.Fatalf("expected the rule to load; diagnostics = %+v", lib.Diagnostics)
				}
				for _, d := range lib.Diagnostics {
					t.Errorf("unexpected diagnostic: %+v", d)
				}
				return
			}
			if got != nil {
				t.Error("expected the rule NOT to load -- the game refuses the whole file")
			}
			var errs []features.Diagnostic
			for _, d := range lib.Diagnostics {
				if d.Level == "error" {
					errs = append(errs, d)
				}
			}
			if len(errs) != 1 {
				t.Fatalf("errors = %+v, want exactly 1", errs)
			}
			if !contains(errs[0].Message, tc.wantIn) {
				t.Errorf("message = %q, want it to contain %q", errs[0].Message, tc.wantIn)
			}
			if errs[0].FileID != "cond.json" {
				t.Errorf("fileID = %q, want the file the error is about", errs[0].FileID)
			}
			// The message has to say what it means for the run, not just what is missing.
			if !contains(errs[0].Message, "refuses the whole file") {
				t.Errorf("message = %q, want it to say the game refuses the file", errs[0].Message)
			}
		})
	}
}

// Every pass the engine registers must load clean, and anything else must warn while KEEPING the
// value. If the accepted list drifted (a typo, a renamed pass, a "helpful" substitution of a
// default), a rule that works in game would be flagged here, or -- worse -- a rule that never
// runs in game would look fine.
func TestParsing_PlacementPassValidation(t *testing.T) {
	known := []string{
		"first_pass", "before_underground_pass", "underground_pass", "after_underground_pass",
		"before_surface_pass", "surface_pass", "after_surface_pass", "before_sky_pass", "sky_pass",
		"after_sky_pass", "final_pass", "pregeneration_pass",
	}
	for _, pass := range known {
		t.Run(pass, func(t *testing.T) {
			lib := BuildFeatureRuleLibrary([]SourceFile{
				ruleSourceFile("known.json", "wiki:known", "wiki:target", simpleDistribution(),
					map[string]any{"placement_pass": pass}),
			})
			for _, d := range lib.Diagnostics {
				t.Errorf("unexpected diagnostic for a registered pass: %+v", d)
			}
			rule := lib.Resolve("wiki:known")
			if rule == nil || rule.PlacementPass == nil || *rule.PlacementPass != pass {
				t.Fatalf("rule = %+v, want it loaded with pass %q", rule, pass)
			}
		})
	}

	for _, pass := range []string{"middle_pass", "SURFACE_PASS", "surface", ""} {
		t.Run("unknown/"+pass, func(t *testing.T) {
			lib := BuildFeatureRuleLibrary([]SourceFile{
				ruleSourceFile("unknown.json", "wiki:unknown", "wiki:target", simpleDistribution(),
					map[string]any{"placement_pass": pass}),
			})
			// The engine keeps the string verbatim: no substitution, no default. A tool that
			// "helpfully" corrected it would make a dead rule look alive.
			rule := lib.Resolve("wiki:unknown")
			if rule == nil {
				t.Fatalf("expected the rule to still load; diagnostics = %+v", lib.Diagnostics)
			}
			if rule.PlacementPass == nil || *rule.PlacementPass != pass {
				t.Fatalf("placementPass = %v, want the value kept as written (%q)", rule.PlacementPass, pass)
			}
			hits := diagnosticsMentioning(lib, "specifies unknown pass")
			if len(hits) != 1 {
				t.Fatalf("diagnostics = %+v, want exactly one unknown-pass warning", lib.Diagnostics)
			}
			// Both halves: the engine's own wording, and the consequence it never states.
			if !contains(hits[0], "warning: ") {
				t.Errorf("diagnostic = %q, want it to be a warning (the file still loads)", hits[0])
			}
			if !contains(hits[0], "never runs") {
				t.Errorf("diagnostic = %q, want it to say the rule never runs", hits[0])
			}
		})
	}
}

// ---------------------------------------------------------------------------
// distribution -- OPTIONAL
// ---------------------------------------------------------------------------

// `distribution` is optional in the engine's schema. A file without
// one LOADS, with default-constructed scatter parameters: iterations 0, scatter_chance 100. If this
// regressed to the old "distribution must be an object" error, this tool would report a parse
// failure for a file the game accepts, and would hide the actual problem -- a live rule that can
// never place anything.
func TestParsing_DistributionIsOptional(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleFileFromBody("nodist.json", map[string]any{
			"description": descriptionFor("wiki:nodist"),
			"conditions":  map[string]any{"placement_pass": "surface_pass"},
		}),
	})
	rule := lib.Resolve("wiki:nodist")
	if rule == nil {
		t.Fatalf("expected the rule to load without a distribution; diagnostics = %+v", lib.Diagnostics)
	}
	for _, d := range lib.Diagnostics {
		if d.Level == "error" {
			t.Errorf("unexpected error diagnostic: %+v", d)
		}
	}
	hits := diagnosticsMentioning(lib, "iterations is 0")
	if len(hits) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly one warning about the defaulted distribution", lib.Diagnostics)
	}
	if !contains(hits[0], "places nothing") {
		t.Errorf("diagnostic = %q, want it to say the rule places nothing", hits[0])
	}

	// And the default really is inert: iterations 0 means zero placements, with the
	// zero-iterations failure explaining why rather than an empty, mute result.
	var failures []string
	result := PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"wiki:target": stubFeature{}},
		Origin:   wgen.BlockPos{},
		Ctx: PlaceContext{
			Random: noRNG{t}, // scatter_chance defaults to 100 -> the gate draws nothing.
			LogFailure: func(featureType, message string, pos wgen.BlockPos) {
				failures = append(failures, message)
			},
		},
	})
	if result.Iterations != 0 || len(result.Placements) != 0 {
		t.Fatalf("iterations = %d, placements = %d, want 0 and 0", result.Iterations, len(result.Placements))
	}
	if len(failures) != 1 || !contains(failures[0], "iterations") {
		t.Fatalf("failures = %v, want one explaining the zero iterations", failures)
	}
}

// The other side of the same key: a distribution that IS present must satisfy the nested
// schema's own required keys (iterations/x/y/z), which the engine enforces exactly as it
// enforces the outer ones. An empty object is not "no distribution".
func TestParsing_PresentDistributionStillNeedsItsRequiredKeys(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("empty_dist.json", "wiki:empty_dist", "wiki:target", map[string]any{}, nil),
	})
	if lib.Resolve("wiki:empty_dist") != nil {
		t.Error("expected an empty distribution object to fail the file, not default it")
	}
	found := false
	for _, d := range lib.Diagnostics {
		if d.Level == "error" && contains(d.Message, "iterations") {
			found = true
		}
	}
	if !found {
		t.Errorf("diagnostics = %+v, want an error naming the missing iterations", lib.Diagnostics)
	}
}

func TestParsing_AnyOfCombinesWithOR(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("highland.ores.json", "wiki:highland.ores", "wiki:highland.ores",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 128.0, "z": 0.0},
			map[string]any{"placement_pass": "before_underground_pass", "minecraft:biome_filter": map[string]any{
				"any_of": []any{
					map[string]any{"test": "has_biome_tag", "value": "highlands"},
					map[string]any{"test": "has_biome_tag", "value": "misty_marsh_with_highlands"},
				},
			}}),
	})
	rule := lib.Resolve("wiki:highland.ores")
	if rule == nil {
		t.Fatal("expected rule to resolve")
	}
	if !EvaluateBiomeFilter(rule.BiomeFilter, molangBiome("a", "highlands")) {
		t.Error("expected highlands to match")
	}
	if !EvaluateBiomeFilter(rule.BiomeFilter, molangBiome("a", "misty_marsh_with_highlands")) {
		t.Error("expected misty_marsh_with_highlands to match")
	}
	if EvaluateBiomeFilter(rule.BiomeFilter, molangBiome("a", "plains")) {
		t.Error("expected plains to not match")
	}
}

func TestParsing_AllOfAndNoneOfCombinators(t *testing.T) {
	allOf := BiomeFilterNode{Kind: FilterAllOf, Children: []BiomeFilterNode{
		{Kind: FilterTest, Test: "has_biome_tag", Value: "a"},
		{Kind: FilterTest, Test: "has_biome_tag", Value: "b"},
	}}
	noneOf := BiomeFilterNode{Kind: FilterNoneOf, Children: []BiomeFilterNode{
		{Kind: FilterTest, Test: "has_biome_tag", Value: "a"},
	}}
	if !EvaluateBiomeFilter(allOf, molangBiome("x", "a", "b")) {
		t.Error("all_of(a,b) should match a biome with both tags")
	}
	if EvaluateBiomeFilter(allOf, molangBiome("x", "a")) {
		t.Error("all_of(a,b) should not match a biome with only 'a'")
	}
	if !EvaluateBiomeFilter(noneOf, molangBiome("x", "b")) {
		t.Error("none_of(a) should match a biome without 'a'")
	}
	if EvaluateBiomeFilter(noneOf, molangBiome("x", "a")) {
		t.Error("none_of(a) should not match a biome with 'a'")
	}
}

func TestParsing_MalformedDistributionDiagnostic(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("bad.json", "wiki:bad", "wiki:bad_target", map[string]any{"iterations": 1.0, "x": map[string]any{"distribution": "not_a_kind"}}, nil),
	})
	if lib.Resolve("wiki:bad") != nil {
		t.Error("expected wiki:bad to not resolve")
	}
	if len(lib.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly 1", lib.Diagnostics)
	}
	if lib.Diagnostics[0].Level != "error" {
		t.Errorf("level = %q, want error", lib.Diagnostics[0].Level)
	}
}

// ---------------------------------------------------------------------------
// Duplicate identifiers -- deduped PER PASS, first wins
// ---------------------------------------------------------------------------

// The engine's rule store is map[placement_pass][identifier]: a second rule with the same
// identifier is dropped only when it lands in the SAME pass, and the first one wins. If this
// regressed to the old "any repeated identifier is a duplicate", the tool would tell an author
// that a rule is dropped when the game in fact runs it -- and would say nothing about which of
// two same-pass rules actually survives.
func TestBuildFeatureRuleLibrary_DuplicateIdentifiersDedupPerPass(t *testing.T) {
	dist := simpleDistribution()
	firstOnly := map[string]any{"iterations": 7.0, "x": 0.0, "y": 0.0, "z": 0.0}

	t.Run("same pass drops the second", func(t *testing.T) {
		lib := BuildFeatureRuleLibrary([]SourceFile{
			ruleSourceFile("a/dup.json", "wiki:dup", "wiki:first", firstOnly,
				map[string]any{"placement_pass": "surface_pass"}),
			ruleSourceFile("b/dup.json", "wiki:dup", "wiki:second", dist,
				map[string]any{"placement_pass": "surface_pass"}),
		})
		rule := lib.Resolve("wiki:dup")
		if rule == nil || rule.PlacesFeature != "wiki:first" {
			t.Fatalf("resolved %+v, want the FIRST file's rule -- the engine keeps the first insert", rule)
		}
		hits := diagnosticsMentioning(lib, "already declared for placement pass")
		if len(hits) != 1 {
			t.Fatalf("diagnostics = %+v, want exactly one same-pass duplicate warning", lib.Diagnostics)
		}
		// It has to name the file that won, and say the loser is dropped at load.
		if !contains(hits[0], "a/dup.json") || !contains(hits[0], "never runs") {
			t.Errorf("diagnostic = %q, want it to name the winning file and say the loser never runs", hits[0])
		}
		if lib.Diagnostics[0].FileID != "b/dup.json" {
			t.Errorf("fileID = %q, want the DROPPED file", lib.Diagnostics[0].FileID)
		}
	})

	t.Run("different passes keep both", func(t *testing.T) {
		lib := BuildFeatureRuleLibrary([]SourceFile{
			ruleSourceFile("a/dup.json", "wiki:dup", "wiki:first", firstOnly,
				map[string]any{"placement_pass": "surface_pass"}),
			ruleSourceFile("b/dup.json", "wiki:dup", "wiki:second", dist,
				map[string]any{"placement_pass": "underground_pass"}),
		})
		if hits := diagnosticsMentioning(lib, "already declared for placement pass"); len(hits) != 0 {
			t.Errorf("diagnostics = %+v, want NO drop warning: the engine runs both", lib.Diagnostics)
		}
		hits := diagnosticsMentioning(lib, "keeps BOTH rules")
		if len(hits) != 1 {
			t.Fatalf("diagnostics = %+v, want one warning explaining that both rules run", lib.Diagnostics)
		}
		// Resolve is keyed by identifier alone, so it can only return one of the two; the
		// diagnostic exists precisely to say so.
		if rule := lib.Resolve("wiki:dup"); rule == nil || rule.PlacesFeature != "wiki:first" {
			t.Fatalf("resolved %+v, want the first-seen rule", rule)
		}
		if len(lib.Entries) != 2 {
			t.Errorf("entries = %d, want both files listed", len(lib.Entries))
		}
	})
}

// ---------------------------------------------------------------------------
// description.identifier -- the engine's two warnings
// ---------------------------------------------------------------------------

// Both checks are warnings in the engine: the rule is inserted and runs either way. If either
// became an error here, a pack that generates fine in game would fail to load in this tool; if
// either stopped firing, the most common real-world rename mistake would go unreported.
func TestParsing_IdentifierWarnings(t *testing.T) {
	cases := []struct {
		name       string
		fileID     string
		identifier string
		wantNS     bool
		wantFile   bool
	}{
		{name: "namespaced and matching", fileID: "canyon.fr.json", identifier: "wiki:canyon.fr"},
		{name: "in a subdirectory", fileID: "overworld/canyon.fr.json", identifier: "wiki:canyon.fr"},
		// Two levels deep, not one: a single separator is the same character
		// whether the name is taken from the first or the last one, so a
		// one-level path cannot tell the two apart. A pack that groups its
		// rules (feature_rules/overworld/caves/) would otherwise be told every
		// file in it was renamed.
		{name: "in a nested subdirectory", fileID: "overworld/caves/canyon.fr.json", identifier: "wiki:canyon.fr"},
		{name: "no colon at all", fileID: "canyon.json", identifier: "canyon", wantNS: true},
		{name: "leading colon", fileID: "canyon.json", identifier: ":canyon", wantNS: true},
		{name: "one-character namespace", fileID: "canyon.json", identifier: "x:canyon", wantNS: true},
		{name: "renamed file", fileID: "canyon_v2.json", identifier: "wiki:canyon", wantFile: true},
		{name: "case differs", fileID: "canyon.json", identifier: "wiki:Canyon", wantFile: true},
		{name: "both wrong", fileID: "canyon_v2.json", identifier: "canyon", wantNS: true, wantFile: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lib := BuildFeatureRuleLibrary([]SourceFile{
				ruleSourceFile(tc.fileID, tc.identifier, "wiki:target", simpleDistribution(), nil),
			})
			if lib.Resolve(tc.identifier) == nil {
				t.Fatalf("expected the rule to load regardless; diagnostics = %+v", lib.Diagnostics)
			}
			gotNS := len(diagnosticsMentioning(lib, "does not use the appropriate namespace syntax")) == 1
			gotFile := len(diagnosticsMentioning(lib, "does not match filename")) == 1
			if gotNS != tc.wantNS {
				t.Errorf("namespace warning = %v, want %v (diagnostics = %+v)", gotNS, tc.wantNS, lib.Diagnostics)
			}
			if gotFile != tc.wantFile {
				t.Errorf("filename warning = %v, want %v (diagnostics = %+v)", gotFile, tc.wantFile, lib.Diagnostics)
			}
			for _, d := range lib.Diagnostics {
				if d.Level != "warning" {
					t.Errorf("diagnostic %+v is level %q, want warning -- the engine still loads the rule", d, d.Level)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Unknown keys
// ---------------------------------------------------------------------------

// The engine reports an unrecognised member by name and drops it. If this stopped firing, a
// typo like "placement_passes" or "iteration" would be perfectly silent -- the rule loads, the
// value does nothing, and nothing says why. And format_version must never be reported: it is a
// real key of every rule file, read by the loader rather than by this schema.
func TestParsing_UnknownKeysAreReportedByName(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(body map[string]any)
		want   string
	}{
		{name: "rule body", want: `"placement_pass"`, mutate: func(body map[string]any) {
			body["placement_pass"] = "surface_pass" // right key, wrong level
		}},
		{name: "description", want: `"description.type"`, mutate: func(body map[string]any) {
			body["description"].(map[string]any)["type"] = "scatter"
		}},
		{name: "conditions", want: `"conditions.biome_filter"`, mutate: func(body map[string]any) {
			body["conditions"].(map[string]any)["biome_filter"] = map[string]any{}
		}},
		{name: "distribution", want: `"distribution.iteration"`, mutate: func(body map[string]any) {
			body["distribution"].(map[string]any)["iteration"] = 4.0
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{
				"description":  descriptionFor("wiki:unknown_key"),
				"conditions":   map[string]any{"placement_pass": "surface_pass"},
				"distribution": simpleDistribution(),
			}
			tc.mutate(body)
			lib := BuildFeatureRuleLibrary([]SourceFile{ruleFileFromBody("unknown_key.json", body)})
			if lib.Resolve("wiki:unknown_key") == nil {
				t.Fatalf("expected the rule to still load; diagnostics = %+v", lib.Diagnostics)
			}
			hits := diagnosticsMentioning(lib, tc.want)
			if len(hits) != 1 {
				t.Fatalf("diagnostics = %+v, want exactly one naming %s", lib.Diagnostics, tc.want)
			}
			if !contains(hits[0], "not present in the Schema") || !contains(hits[0], "drops it unread") {
				t.Errorf("diagnostic = %q, want the engine's wording plus what it means", hits[0])
			}
		})
	}

	t.Run("format_version is never reported", func(t *testing.T) {
		lib := BuildFeatureRuleLibrary([]SourceFile{
			ruleSourceFile("fv.json", "wiki:fv", "wiki:target", simpleDistribution(), nil),
		})
		if hits := diagnosticsMentioning(lib, "format_version"); len(hits) != 0 {
			t.Errorf("diagnostics = %+v, want format_version left alone", lib.Diagnostics)
		}
	})

	// Several unknown keys at one level have to come back in ONE order, not
	// in whatever order the file's map happened to iterate: a rule with three
	// typos would otherwise list them differently on every reload, so the
	// diagnostics panel reshuffles on each save and nothing downstream can
	// compare two runs. See reportUnknownKeys's own comment on the sort.
	t.Run("several unknown keys are reported in a stable order", func(t *testing.T) {
		// Written out by hand, in reverse alphabetical order, rather than
		// through mustJSON: encoding/json emits a map's keys already sorted,
		// which would let an unsorted report pass on the input's own order.
		text := `{
			"format_version": "1.21.110",
			"minecraft:feature_rules": {
				"zeta": 1,
				"mu": 2,
				"delta": 3,
				"alpha": 4,
				"description": {"identifier": "wiki:many", "places_feature": "wiki:target"},
				"conditions": {"placement_pass": "surface_pass"},
				"distribution": {"iterations": 1, "x": 0, "y": 0, "z": 0}
			}
		}`
		lib := BuildFeatureRuleLibrary([]SourceFile{{ID: "many.json", AbsPath: "/virtual/rules/many.json", Text: text}})
		if lib.Resolve("wiki:many") == nil {
			t.Fatalf("expected the rule to still load; diagnostics = %+v", lib.Diagnostics)
		}
		want := []string{`"alpha"`, `"delta"`, `"mu"`, `"zeta"`}
		var got []string
		for _, d := range lib.Diagnostics {
			for _, key := range want {
				if contains(d.Message, key+" was found in the input") {
					got = append(got, key)
				}
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("unknown keys reported in the order %v, want %v -- a diagnostic list that reorders itself between runs is neither comparable nor testable", got, want)
		}
	})
}

// ---------------------------------------------------------------------------
// PlaceFeatureRule -- fixed_grid origin set
// ---------------------------------------------------------------------------

type stubFeature struct{}

func (stubFeature) TypeID() string     { return "test:rule_stub" }
func (stubFeature) Identifier() string { return "stub" }
func (stubFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	pos := ctx.Origin
	return &pos
}

type mapResolver map[string]wgen.IFeature

func (m mapResolver) Resolve(id string) wgen.IFeature { return m[id] }

func TestPlaceFeatureRule_FixedGrid256(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile(
			"canyon_terraform.fr.json", "wiki:canyon_terraform.fr", "wiki:canyon_shave_and_terraform.f",
			map[string]any{"iterations": 256.0, "x": map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 15.0}}, "y": 112.0, "z": map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 15.0}}},
			map[string]any{"placement_pass": "before_surface_pass", "minecraft:biome_filter": map[string]any{"test": "has_biome_tag", "value": "canyon"}},
		),
	})
	rule := lib.Resolve("wiki:canyon_terraform.fr")
	if rule == nil {
		t.Fatal("expected rule to resolve")
	}
	origin := wgen.BlockPos{X: 100, Y: -56, Z: -200}

	result := PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"wiki:canyon_shave_and_terraform.f": stubFeature{}},
		Origin:   origin,
		Ctx: PlaceContext{
			Random: noRNG{t}, // fixed_grid draws ZERO RNG -- any draw fails this test.
			Biome:  molangBiome("wiki:canyon", "canyon"),
		},
	})

	if !result.BiomeMatched {
		t.Fatal("expected biome filter to match")
	}
	if result.Iterations != 256 {
		t.Fatalf("iterations = %d, want 256", result.Iterations)
	}
	if len(result.Placements) != 256 {
		t.Fatalf("placements = %d, want 256", len(result.Placements))
	}

	seen := make(map[[2]int]bool, 256)
	for _, p := range result.Placements {
		dx, dz := p.Origin.X-origin.X, p.Origin.Z-origin.Z
		seen[[2]int{dx, dz}] = true
		if p.Origin.Y != origin.Y+112 {
			t.Errorf("placement y = %d, want %d", p.Origin.Y, origin.Y+112)
		}
	}
	if len(seen) != 256 {
		t.Fatalf("distinct (dx,dz) cells = %d, want 256", len(seen))
	}
	for dx := 0; dx <= 15; dx++ {
		for dz := 0; dz <= 15; dz++ {
			if !seen[[2]int{dx, dz}] {
				t.Fatalf("missing grid cell (%d,%d)", dx, dz)
			}
		}
	}
}

func TestPlaceFeatureRule_BiomeFilterRejectionIsReportedNotSilent(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile(
			"canyon_terraform.fr.json", "wiki:canyon_terraform.fr", "wiki:canyon_shave_and_terraform.f",
			map[string]any{"iterations": 256.0, "x": map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 15.0}}, "y": 112.0, "z": map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 15.0}}},
			map[string]any{"minecraft:biome_filter": map[string]any{"test": "has_biome_tag", "value": "canyon"}},
		),
	})
	rule := lib.Resolve("wiki:canyon_terraform.fr")
	if rule == nil {
		t.Fatal("expected rule to resolve")
	}

	var failures []string
	result := PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"wiki:canyon_shave_and_terraform.f": stubFeature{}},
		Origin:   wgen.BlockPos{X: 0, Y: -56, Z: 0},
		Ctx: PlaceContext{
			Random: noRNG{t},
			Biome:  molangBiome("plains", "plains"), // no 'canyon' tag
			LogFailure: func(featureType, message string, pos wgen.BlockPos) {
				failures = append(failures, featureType+": "+message)
			},
		},
	})

	if result.BiomeMatched {
		t.Error("expected biome filter to reject")
	}
	if result.Iterations != 0 {
		t.Errorf("iterations = %d, want 0", result.Iterations)
	}
	if len(result.Placements) != 0 {
		t.Errorf("placements = %+v, want none", result.Placements)
	}
	if len(failures) != 1 {
		t.Fatalf("failures = %v, want exactly 1", failures)
	}
	if !contains(failures[0], "biome filter rejected") || !contains(failures[0], "canyon") {
		t.Errorf("failure message = %q, want it to mention the rejection and the tag", failures[0])
	}
}

func TestPlaceFeatureRule_UnresolvedPlacesFeature(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("r.json", "wiki:r", "wiki:does_not_exist", map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}, nil),
	})
	rule := lib.Resolve("wiki:r")
	if rule == nil {
		t.Fatal("expected rule to resolve")
	}

	var failures []string
	result := PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{},
		Origin:   wgen.BlockPos{},
		Ctx: PlaceContext{
			Random: noRNG{t},
			LogFailure: func(featureType, message string, pos wgen.BlockPos) {
				failures = append(failures, featureType+": "+message)
			},
		},
	})

	// Biome filter (default: always matches, since no conditions were
	// supplied) is still evaluated FIRST, before the places_feature lookup.
	if !result.BiomeMatched {
		t.Error("expected biome filter to match (default always-match)")
	}
	if result.Iterations != 0 {
		t.Errorf("iterations = %d, want 0", result.Iterations)
	}
	if len(failures) != 1 || !contains(failures[0], "could not be resolved") {
		t.Fatalf("failures = %v, want exactly 1 mentioning 'could not be resolved'", failures)
	}
	// Case used to be a real difference between this tool and the game, and the message used to
	// disclose it. It is not any more -- features.BuildLibrary folds the key the way the engine's
	// registry does -- so the message now says the opposite, and says it because an author
	// hunting an unresolved reference will otherwise spend the search on the one thing that is
	// not the problem.
	if !contains(failures[0], "Case is not the problem") {
		t.Errorf("failure message = %q, want it to rule case out as the cause", failures[0])
	}
}

// ---------------------------------------------------------------------------
// pregeneration_pass -- cave carvers only
// ---------------------------------------------------------------------------

// typedFeature is a stub whose TypeID is whatever the test needs, so the pregeneration check can
// be exercised from both sides.
type typedFeature struct{ typeID string }

func (f typedFeature) TypeID() string     { return f.typeID }
func (f typedFeature) Identifier() string { return "typed" }
func (f typedFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	pos := ctx.Origin
	return &pos
}

// A feature's placement-legality test refuses every non-carver in pregeneration_pass, so such a
// rule is a
// guaranteed no-op in game while loading perfectly. Nothing else reports it: if this warning
// stopped firing, the author's only signal would be that the feature never appears. And the
// warning must NOT fire for a cave carver, which is the one legal pairing.
func TestPlaceFeatureRule_PregenerationPassAcceptsOnlyCaveCarvers(t *testing.T) {
	cases := []struct {
		name     string
		pass     string
		typeID   string
		wantWarn bool
	}{
		{name: "carver in pregeneration_pass", pass: "pregeneration_pass", typeID: "minecraft:cave_carver_feature"},
		{name: "ore in pregeneration_pass", pass: "pregeneration_pass", typeID: "minecraft:ore_feature", wantWarn: true},
		{name: "ore in a decoration pass", pass: "underground_pass", typeID: "minecraft:ore_feature"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lib := BuildFeatureRuleLibrary([]SourceFile{
				ruleSourceFile("pregen.json", "wiki:pregen", "wiki:target", simpleDistribution(),
					map[string]any{"placement_pass": tc.pass}),
			})
			rule := lib.Resolve("wiki:pregen")
			if rule == nil {
				t.Fatalf("expected the rule to load; diagnostics = %+v", lib.Diagnostics)
			}

			var warnings []string
			result := PlaceFeatureRule(RulePlacementOptions{
				Rule:     rule,
				Resolver: mapResolver{"wiki:target": typedFeature{typeID: tc.typeID}},
				Origin:   wgen.BlockPos{},
				Ctx: PlaceContext{
					Random: noRNG{t},
					LogWarning: func(featureType, message string, pos *wgen.BlockPos) {
						warnings = append(warnings, message)
					},
				},
			})
			// Diagnostics only: the placement itself must be untouched, so the author can still
			// see what the rule would place.
			if len(result.Placements) != 1 {
				t.Fatalf("placements = %d, want the rule still run (1)", len(result.Placements))
			}
			if !tc.wantWarn {
				if len(warnings) != 0 {
					t.Fatalf("warnings = %v, want none", warnings)
				}
				return
			}
			if len(warnings) != 1 {
				t.Fatalf("warnings = %v, want exactly one", warnings)
			}
			if !contains(warnings[0], `"cave_carver_feature" is the only valid feature`) {
				t.Errorf("warning = %q, want the engine's own wording", warnings[0])
			}
			if !contains(warnings[0], "no-op") {
				t.Errorf("warning = %q, want it to say the rule places nothing in game", warnings[0])
			}
		})
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (func() bool {
		for i := 0; i+len(substr) <= len(s); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	})()
}

// ---------------------------------------------------------------------------
// PlaceFeatureRule -- the two RNG streams
// ---------------------------------------------------------------------------

// drawingFeature draws from the placement context's own generator, the way a real feature does,
// and records which generator instance it was handed.
type drawingFeature struct {
	draws []int32
	seen  []random.IRandom
}

func (d *drawingFeature) TypeID() string     { return "test:drawing" }
func (d *drawingFeature) Identifier() string { return "drawing" }
func (d *drawingFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	d.seen = append(d.seen, ctx.Random)
	d.draws = append(d.draws, ctx.Random.NextInt())
	pos := ctx.Origin
	return &pos
}

// uniformRule is a rule whose distribution actually draws (uniform x/z), so the position stream
// is observable and can be shown NOT to move when the delegate draws.
func uniformRule(t *testing.T) *FeatureRule {
	t.Helper()
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile(
			"stream.fr.json", "test:stream.fr", "test:drawing",
			map[string]any{
				"iterations": 6.0,
				"x":          map[string]any{"distribution": "uniform", "extent": []any{0.0, 15.0}},
				"y":          0.0,
				"z":          map[string]any{"distribution": "uniform", "extent": []any{0.0, 15.0}},
			},
			map[string]any{},
		),
	})
	rule := lib.Resolve("test:stream.fr")
	if rule == nil {
		t.Fatal("expected the rule to resolve")
	}
	return rule
}

func TestPlaceFeatureRule_DelegateDrawsDoNotMoveThePositions(t *testing.T) {
	// The engine builds two generators from one per-entry seed: the distribution draws positions
	// from one, every delegated feature draws from the other (the per-biome decoration pass,
	// see random/decorationseed.go). Sharing a single stream -- which this package
	// did before the two-generator seeding was modelled -- means a feature's own draws shift the positions it is
	// placed at, so the same rule with a heavier delegate scatters differently.
	rule := uniformRule(t)

	run := func(placeRandom random.IRandom, delegate wgen.IFeature) []wgen.BlockPos {
		result := PlaceFeatureRule(RulePlacementOptions{
			Rule:     rule,
			Resolver: mapResolver{"test:drawing": delegate},
			Origin:   wgen.BlockPos{},
			Ctx: PlaceContext{
				Random:      random.New(7),
				PlaceRandom: placeRandom,
				Biome:       molangBiome("plains", "plains"),
			},
		})
		var out []wgen.BlockPos
		for _, p := range result.Placements {
			out = append(out, p.Origin)
		}
		return out
	}

	withDraws := run(random.New(99), &drawingFeature{})
	// The same distribution, same seed, delegating to something that draws NOTHING.
	withoutDraws := run(random.New(99), stubFeature{})

	if len(withDraws) != 6 || len(withoutDraws) != 6 {
		t.Fatalf("expected 6 placements each, got %d and %d", len(withDraws), len(withoutDraws))
	}
	for i := range withDraws {
		if withDraws[i] != withoutDraws[i] {
			t.Fatalf("placement %d moved when the delegate drew: %v vs %v -- the two streams are "+
				"not separate", i, withDraws[i], withoutDraws[i])
		}
	}
}

func TestPlaceFeatureRule_DelegateUsesThePlacementStream(t *testing.T) {
	rule := uniformRule(t)
	delegate := &drawingFeature{}
	placeRandom := random.New(4242)
	PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"test:drawing": delegate},
		Origin:   wgen.BlockPos{},
		Ctx: PlaceContext{
			Random:      random.New(7),
			PlaceRandom: placeRandom,
			Biome:       molangBiome("plains", "plains"),
		},
	})

	if len(delegate.draws) != 6 {
		t.Fatalf("delegate ran %d times, want 6", len(delegate.draws))
	}
	for _, got := range delegate.seen {
		if got != placeRandom {
			t.Fatalf("delegate was handed %p, want the placement stream %p", got, placeRandom)
		}
	}
	// Every iteration shares ONE placement generator (the engine builds it once per decoration
	// entry, not once per position), so consecutive draws must differ rather than repeat.
	same := true
	for i := 1; i < len(delegate.draws); i++ {
		if delegate.draws[i] != delegate.draws[0] {
			same = false
		}
	}
	if same {
		t.Error("every delegate call drew the same value -- the placement generator is being " +
			"rebuilt per position instead of shared across the entry")
	}
}

func TestPlaceFeatureRule_PlaceRandomDefaultsToTheDistributionStream(t *testing.T) {
	// Callers that predate the split (and tests that only care about distribution order) leave
	// PlaceRandom nil and get the old single-stream behaviour.
	rule := uniformRule(t)
	delegate := &drawingFeature{}
	shared := random.New(7)
	PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"test:drawing": delegate},
		Origin:   wgen.BlockPos{},
		Ctx:      PlaceContext{Random: shared, Biome: molangBiome("plains", "plains")},
	})
	for _, got := range delegate.seen {
		if got != shared {
			t.Fatalf("delegate was handed %p, want the distribution stream %p", got, shared)
		}
	}
}

// ---------------------------------------------------------------------------
// EvaluateBiomeFilter -- the two ways a test node says "no"
// ---------------------------------------------------------------------------

// TestEvaluateBiomeFilter_OnlyHasBiomeTagAndOnlyAgainstARealBiome pins the
// two refusals inside the FilterTest branch. Every other filter test above
// asks a has_biome_tag node about a biome that has the tag, or one that does
// not -- neither of which reaches either refusal, so both could be deleted
// without a single existing assertion moving.
//
// Both make the tool answer a question the game answers differently, which
// is the most expensive kind of wrong answer it can give: a preview that
// places where the game places nothing.
//   - An unrecognised test name (a typo like has_biome_tags, or one of the
//     other Bedrock filter tests this package does not implement) must evaluate
//     to non-matching. If it read the tag anyway, a filter that the engine
//     silently never satisfies would look like it matches.
//   - No active biome at all (the void preset, and every caller that has not
//     resolved one) must be non-matching too.
func TestEvaluateBiomeFilter_OnlyHasBiomeTagAndOnlyAgainstARealBiome(t *testing.T) {
	tagged := BiomeFilterNode{Kind: FilterTest, Test: "has_biome_tag", Value: "canyon"}
	if !EvaluateBiomeFilter(tagged, molangBiome("wiki:canyon", "canyon")) {
		t.Fatal("test is vacuous: has_biome_tag('canyon') should match a biome carrying that tag")
	}

	if EvaluateBiomeFilter(tagged, nil) {
		t.Error("has_biome_tag matched with NO active biome -- a rule filtered on a tag would preview as placing in an environment that has no biome to carry it")
	}

	for _, name := range []string{"has_biome_tags", "has_surface", ""} {
		unknown := BiomeFilterNode{Kind: FilterTest, Test: name, Value: "canyon"}
		if EvaluateBiomeFilter(unknown, molangBiome("wiki:canyon", "canyon")) {
			t.Errorf("test %q matched -- only has_biome_tag is implemented, so anything else has to be non-matching rather than fall through to the tag lookup", name)
		}
	}

	// And inside a combinator, where one wrongly-true child flips the whole
	// answer: none_of is the shape where a filter that should reject ends up
	// accepting.
	noneOfUnknown := BiomeFilterNode{Kind: FilterNoneOf, Children: []BiomeFilterNode{
		{Kind: FilterTest, Test: "has_biome_tags", Value: "canyon"},
	}}
	if !EvaluateBiomeFilter(noneOfUnknown, molangBiome("wiki:canyon", "canyon")) {
		t.Error("none_of(<unrecognised test>) rejected -- the unrecognised child evaluated true")
	}
}

// TestParsing_EmptyPlacesFeatureIsRefused covers the half of the
// places_feature check no test reaches: the key is there, is a string, and
// is empty. The engine's schema wants a non-empty feature reference and
// refuses the whole file without one, so the rule is never inserted and
// places nothing. Accepting it here would show an author a rule running
// happily that the game does not load at all -- and it would then fail a
// second time at placement, as an unresolved places_feature, pointing at the
// wrong cause.
func TestParsing_EmptyPlacesFeatureIsRefused(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleFileFromBody("empty_target.json", map[string]any{
			"description":  map[string]any{"identifier": "wiki:empty_target", "places_feature": ""},
			"conditions":   map[string]any{"placement_pass": "surface_pass"},
			"distribution": simpleDistribution(),
		}),
	})
	if lib.Resolve("wiki:empty_target") != nil {
		t.Error("expected an empty places_feature to fail the file -- the game refuses it and inserts no rule")
	}
	var errs []features.Diagnostic
	for _, d := range lib.Diagnostics {
		if d.Level == "error" {
			errs = append(errs, d)
		}
	}
	if len(errs) != 1 {
		t.Fatalf("errors = %+v, want exactly 1", errs)
	}
	if !contains(errs[0].Message, "places_feature") || !contains(errs[0].Message, "refuses the whole file") {
		t.Errorf("message = %q, want it to name places_feature and say the game refuses the file", errs[0].Message)
	}
}

// TestPlaceFeatureRule_SeedsTheOriginMolangVariablesFromTheChunkCorner pins
// what the scatter feature's Molang parameter setup writes before a distribution runs:
// variable.originx/originy/originz from the chunk-corner origin, each from
// its OWN axis. RulePlacementResult.Scope is exposed precisely so a caller
// can read this back, and nothing else here ever looks at it -- so a rule
// whose distribution is written in terms of variable.originx (a real pattern
// for placing relative to the chunk) could be scattered along the wrong axis
// entirely with every existing assertion still green.
//
// The three coordinates are deliberately distinct and differently signed, so
// a swapped pair cannot pass by coincidence.
func TestPlaceFeatureRule_SeedsTheOriginMolangVariablesFromTheChunkCorner(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("origin.json", "wiki:origin", "wiki:target", simpleDistribution(), nil),
	})
	rule := lib.Resolve("wiki:origin")
	if rule == nil {
		t.Fatalf("expected the rule to load; diagnostics = %+v", lib.Diagnostics)
	}

	origin := wgen.BlockPos{X: 112, Y: -48, Z: -320}
	result := PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"wiki:target": stubFeature{}},
		Origin:   origin,
		Ctx:      PlaceContext{Random: noRNG{t}}, // the Molang parameter setup draws NO RNG
	})
	if result.Scope == nil {
		t.Fatal("result.Scope is nil -- it is created up front so every return path hands one back")
	}
	for _, tc := range []struct {
		name string
		want float64
	}{
		{"originx", 112},
		{"originy", -48},
		{"originz", -320},
	} {
		got, ok := result.Scope.Variable[tc.name]
		if !ok {
			t.Errorf("variable.%s was never written", tc.name)
			continue
		}
		if got != tc.want {
			t.Errorf("variable.%s = %v, want %v (the origin's own %s)", tc.name, got, tc.want, tc.name[len(tc.name)-1:])
		}
	}
}

// TestPlaceFeatureRule_ScatterChanceRejectionSaysWhy is the twin of the
// zero-iterations case TestParsing_DistributionIsOptional already covers.
// Both exist for the same reason -- see PlaceFeatureRule's own comment on
// the switch: a rule that placed nothing used to say only "placement
// returned no result and wrote no blocks", which read as broken rather than
// unlucky, and cost real time on a rule whose scatter_chance was 1.5 (a
// PERCENT). Only one of the two arms is tested, so the other could stop
// reporting entirely and nothing would notice.
//
// This used to be written with `scatter_chance: 0`, which refused without
// drawing at all. It cannot be any more: the game treats a constant 0 as a
// bad value, reports it and uses 100 instead, so 0 now ALWAYS scatters here
// too (ParseScatterChance carries the derivation). The rejection is
// therefore reached the only way that survives -- a fraction gate that draws
// and loses -- so this test now needs a generator, and losingRNG is one that
// permits exactly the one draw the gate makes.
func TestPlaceFeatureRule_ScatterChanceRejectionSaysWhy(t *testing.T) {
	lib := BuildFeatureRuleLibrary([]SourceFile{
		ruleSourceFile("chance.json", "wiki:chance", "wiki:target",
			map[string]any{"iterations": 4.0, "x": 0.0, "y": 0.0, "z": 0.0,
				"scatter_chance": map[string]any{"numerator": 1.0, "denominator": 4.0}}, nil),
	})
	rule := lib.Resolve("wiki:chance")
	if rule == nil {
		t.Fatalf("expected the rule to load; diagnostics = %+v", lib.Diagnostics)
	}

	var failures []string
	result := PlaceFeatureRule(RulePlacementOptions{
		Rule:     rule,
		Resolver: mapResolver{"wiki:target": stubFeature{}},
		Origin:   wgen.BlockPos{},
		Ctx: PlaceContext{
			Random: losingRNG{noRNG{t}}, // one draw, and it loses the 1-in-4 gate
			LogFailure: func(featureType, message string, pos wgen.BlockPos) {
				failures = append(failures, message)
			},
		},
	})
	if result.Iterations != 0 || len(result.Placements) != 0 {
		t.Fatalf("iterations = %d, placements = %d, want 0 and 0", result.Iterations, len(result.Placements))
	}
	if len(failures) != 1 {
		t.Fatalf("failures = %v, want exactly one saying why nothing was placed", failures)
	}
	if !contains(failures[0], "scatter_chance") {
		t.Errorf("failure = %q, want it to name scatter_chance as the reason", failures[0])
	}
	// The two halves that make it useful: it is luck rather than a mistake,
	// and the number is a percent.
	if !contains(failures[0], "luck, not") {
		t.Errorf("failure = %q, want it to say this is luck rather than configuration", failures[0])
	}
	if !contains(failures[0], "PERCENT") {
		t.Errorf("failure = %q, want it to say a bare scatter_chance is a percent", failures[0])
	}
}
