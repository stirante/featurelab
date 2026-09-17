package session

import (
	"encoding/json"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/rules"
)

func singleBlockFeatureFile(identifier, placesBlock string) features.SourceFile {
	text := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"` +
		identifier + `"},"enforce_placement_rules":false,"enforce_survivability_rules":false,"places_block":"` + placesBlock + `"}}`
	return features.SourceFile{ID: identifier + ".json", AbsPath: identifier + ".json", Text: text}
}

// ruleSourceFile builds a feature_rules/*.json SourceFile -- mirrors the
// shape rules/rules_test.go's own ruleSourceFile helper builds (that helper
// is unexported and lives in a different package, so this is a small
// duplicate rather than a shared export).
func ruleSourceFile(id, identifier, placesFeature string, distribution map[string]any, conditions map[string]any) rules.SourceFile {
	// conditions.placement_pass is REQUIRED by the engine's own rule schema -- a file without it
	// does not load at all -- so a fixture that leaves it out is not exercising this package, it
	// is exercising the rules loader's refusal. Fill in a plausible pass unless the caller is
	// deliberately setting one.
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
	raw, err := json.Marshal(map[string]any{
		"format_version":          "1.21.110",
		"minecraft:feature_rules": body,
	})
	if err != nil {
		panic(err)
	}
	return rules.SourceFile{ID: id, AbsPath: id, Text: string(raw)}
}

func strPtr(s string) *string { return &s }
func intPtr(i int) *int       { return &i }

// ---------------------------------------------------------------------------
// DefaultConfig / Generate basics.
// ---------------------------------------------------------------------------

func TestDefaultConfig_UnknownEnvironmentFails(t *testing.T) {
	if _, ok := DefaultConfig("not_a_real_environment"); ok {
		t.Error("DefaultConfig with an unknown environment id should return ok=false")
	}
}

func TestGenerate_UnknownEnvironmentReturnsError(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.Environment = "not_a_real_environment"
	if _, err := Generate(config, nil, nil, nil, nil, nil); err == nil {
		t.Error("Generate with an unknown environment id should return an error")
	}
}

func TestGenerate_BareEnvironmentNoFeatureSelected(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	result, err := Generate(config, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksChanged != 0 {
		t.Errorf("BlocksChanged = %d, want 0 (no feature selected, nothing should have run)", result.BlocksChanged)
	}
	if len(result.Placements) != 0 {
		t.Errorf("Placements = %v, want none", result.Placements)
	}
	if result.MolangScope == nil {
		t.Error("MolangScope should never be nil, even with no feature selected")
	}
	if result.Partial {
		t.Error("Partial should be false for an ordinary run")
	}
	// The volume follows the horizontal origin: minX = originX - floor(sizeX/2).
	wantMinX := config.OriginX - config.SizeX/2
	if got := result.Volume.MinX(); got != wantMinX {
		t.Errorf("Volume.MinX() = %d, want %d", got, wantMinX)
	}
}

// TestGenerate_ModeRuleRunsDistributionThroughRulesPackage proves mode=rule
// is genuinely wired: it resolves the rule via the rules package, runs its
// distribution against the chunk-corner origin, and does NOT collapse a
// terraform-style rule's internal per-iteration loop -- 3 distribution
// iterations of a single_block_feature must write 3 distinct cells from ONE
// Generate call, not 1.
func TestGenerate_ModeRuleRunsDistributionThroughRulesPackage(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid) // entirely air baseline, no biome tags
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr("test:rule")

	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		ruleSourceFile("rule.json", "test:rule", "test:place_diamond",
			map[string]any{
				"iterations": 3.0,
				"x":          map[string]any{"distribution": "fixed_grid", "extent": []any{0.0, 2.0}},
				"y":          0.0,
				"z":          0.0,
			}, nil),
	}

	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.ActiveRule == nil {
		t.Fatal("expected ActiveRule to resolve")
	}
	if result.ActiveRule.PlacesFeature != "test:place_diamond" {
		t.Errorf("ActiveRule.PlacesFeature = %q", result.ActiveRule.PlacesFeature)
	}
	if len(result.RuleEntries) != 1 {
		t.Errorf("len(RuleEntries) = %d, want 1 (always populated regardless of mode)", len(result.RuleEntries))
	}
	// 3 distribution iterations x 4 chunks. A rule is applied PER CHUNK, like the real engine
	// does -- the default bench is 32x32, which is four 16x16 chunks. Before that, a bench
	// larger than one chunk only ever decorated the chunk containing the origin, which broke
	// terraform-style rules outright (they build one column and rely on being invoked for
	// every column of every chunk). The "must not collapse into one" half of this assertion is
	// the original point and still stands: 3 iterations must stay 3, not become 1.
	const chunksInDefaultBench = 4
	if result.BlocksPlaced != 3*chunksInDefaultBench {
		t.Errorf("BlocksPlaced = %d, want %d -- 3 distribution iterations x %d chunks; iterations must not collapse, and every chunk must be covered",
			result.BlocksPlaced, 3*chunksInDefaultBench, chunksInDefaultBench)
	}
	if result.BlocksChanged != 3*chunksInDefaultBench {
		t.Errorf("BlocksChanged = %d, want %d", result.BlocksChanged, 3*chunksInDefaultBench)
	}
	// One Placement per chunk per outer repeat. RepeatCount defaults to 1, and the rule's OWN
	// internal iterations are still summarized into that entry, the same way a single
	// scatter_feature's internal iterations are summarized by its own outer place() call.
	if len(result.Placements) != chunksInDefaultBench {
		t.Fatalf("len(Placements) = %d, want %d (one per chunk, rule's internal iterations summarized)",
			len(result.Placements), chunksInDefaultBench)
	}
	seenOrigins := map[[2]int]bool{}
	for _, p := range result.Placements {
		seenOrigins[[2]int{p.Origin.X, p.Origin.Z}] = true
	}
	if len(seenOrigins) != chunksInDefaultBench {
		t.Errorf("placements share origins %v -- each chunk must run from its OWN corner", seenOrigins)
	}
	if result.Placements[0].Returned == nil {
		t.Error("expected the outer placement to report a returned position")
	}
	if result.Partial {
		t.Error("Partial should be false for an ordinary run")
	}
}

// TestGenerate_ModeRuleBiomeFilterRejectionIsReportedNotSilent proves a
// rule whose biome_filter rejects the active biome reports that explicitly
// via a diagnostic rather than just returning an unexplained empty result.
func TestGenerate_ModeRuleBiomeFilterRejectionIsReportedNotSilent(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid) // biome "void", NO tags at all
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

	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksChanged != 0 {
		t.Errorf("BlocksChanged = %d, want 0 (biome filter rejected)", result.BlocksChanged)
	}
	found := false
	for _, d := range result.Diagnostics {
		if strings.Contains(d.Message, "biome filter rejected") && strings.Contains(d.Message, "monster") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected an explicit biome-filter-rejection diagnostic naming the tag, got %+v", result.Diagnostics)
	}
	// One entry per chunk now (see TestGenerate_ModeRuleRunsDistributionThroughRulesPackage);
	// the point here is that a biome-filter rejection places nothing in ANY of them.
	if len(result.Placements) == 0 {
		t.Error("expected one placement entry per chunk even when the biome filter rejects")
	}
	for _, p := range result.Placements {
		if p.Returned != nil {
			t.Errorf("Placements = %+v, want every entry with Returned == nil (nothing placed)", result.Placements)
			break
		}
	}
}

// ---------------------------------------------------------------------------
// Unresolved feature/rule identifiers: a silent-failure bug.
// A request naming an identifier the loaded pack does not define used to
// fall straight through every diagnostic-producing branch (all gated on
// `feature != nil || activeRule != nil`) and come back activeRule: null,
// diagnostics: [], blocksChanged: 0, exit 0 -- completely indistinguishable
// from a legitimate feature/rule that placed nothing -- for example
// `--rule "wiki:highland.main"` against a pack that had renamed every
// "highland." rule to "hl.".
// ---------------------------------------------------------------------------

func brokenSingleBlockFeatureFile(identifier string) features.SourceFile {
	// Omits the required "places_block" field -- features.builders still has an entry for
	// minecraft:single_block_feature, so this reaches the builder and fails there, not at
	// "unknown type" -- exactly the "declared but failed to build" case, distinct from "not
	// declared at all".
	text := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"` + identifier + `"}}}`
	return features.SourceFile{ID: identifier + ".broken.json", AbsPath: identifier + ".broken.json", Text: text}
}

func TestGenerate_UnresolvedFeatureIdentifierReportsDiagnostic(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:does_not_exist")

	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksChanged != 0 {
		t.Errorf("BlocksChanged = %d, want 0", result.BlocksChanged)
	}
	found := false
	for _, d := range result.Diagnostics {
		if d.Level == "error" && strings.Contains(d.Message, `"test:does_not_exist"`) && strings.Contains(d.Message, "not defined by the loaded pack") {
			if !strings.Contains(d.Message, "1 feature(s) loaded") {
				t.Errorf("diagnostic message = %q, want it to report how many features loaded (1) so \"not found\" reads distinguishably from \"pack loaded nothing\"", d.Message)
			}
			found = true
		}
	}
	if !found {
		t.Errorf("expected an \"error\" diagnostic naming the unresolved feature identifier, got %+v", result.Diagnostics)
	}
	// This must NOT be conflated with the (unrelated) "placed successfully but wrote no blocks"
	// diagnostic -- that one is gated on feature/activeRule having actually resolved.
	if len(result.Diagnostics) != 1 {
		t.Errorf("Diagnostics = %+v, want exactly the one unresolved-identifier diagnostic", result.Diagnostics)
	}
}

func TestGenerate_UnresolvedRuleIdentifierReportsDiagnostic(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr("wiki:highland.main")

	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		ruleSourceFile("hl.main.json", "wiki:hl.main", "test:place_diamond",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}, nil),
	}

	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.ActiveRule != nil {
		t.Errorf("ActiveRule = %+v, want nil for an unresolved rule id", result.ActiveRule)
	}
	if result.BlocksChanged != 0 {
		t.Errorf("BlocksChanged = %d, want 0", result.BlocksChanged)
	}
	found := false
	for _, d := range result.Diagnostics {
		if d.Level != "error" || !strings.Contains(d.Message, `"wiki:highland.main"`) {
			continue
		}
		if !strings.Contains(d.Message, "not defined by the loaded pack") {
			t.Errorf("diagnostic message = %q, want it to say the rule is not defined", d.Message)
		}
		if !strings.Contains(d.Message, "1 rule(s) loaded") {
			t.Errorf("diagnostic message = %q, want it to report how many rules loaded (1)", d.Message)
		}
		// The near-match threshold is deliberately tight (edit distance <= 2, see
		// closestIdentifiers) -- "highland.main" -> "hl.main" is a plausible real-world
		// rename, but at edit distance 6 it must NOT be guessed at here.
		if strings.Contains(d.Message, "did you mean") {
			t.Errorf("diagnostic message = %q, should not offer a near-match this far from the requested identifier", d.Message)
		}
		found = true
	}
	if !found {
		t.Errorf("expected an \"error\" diagnostic naming the unresolved rule identifier, got %+v", result.Diagnostics)
	}
}

func TestGenerate_UnresolvedFeatureIdentifierOffersCloseTypoMatch(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	// A single transposition away from a real identifier -- edit distance 2, inside the
	// near-match threshold.
	config.FeatureIdentifier = strPtr("test:palce_diamond")

	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	found := false
	for _, d := range result.Diagnostics {
		if d.Level == "error" && strings.Contains(d.Message, "did you mean") && strings.Contains(d.Message, `"test:place_diamond"`) {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a near-match suggestion naming test:place_diamond, got %+v", result.Diagnostics)
	}
}

func TestGenerate_FeatureDeclaredButFailedToBuildIsNamedNotJustNotFound(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:broken")

	files := []features.SourceFile{brokenSingleBlockFeatureFile("test:broken")}
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	var resolutionDiag *Diagnostic
	for i, d := range result.Diagnostics {
		if d.Level == "error" && d.FileID == "test:broken" && strings.Contains(d.Message, "failed to build") {
			resolutionDiag = &result.Diagnostics[i]
		}
	}
	if resolutionDiag == nil {
		t.Fatalf("expected an error diagnostic saying test:broken is declared but failed to build, got %+v", result.Diagnostics)
	}
	if strings.Contains(resolutionDiag.Message, "not defined by the loaded pack") {
		t.Errorf("message = %q -- a declared-but-broken identifier must not be reported as merely \"not defined\", those are different failures", resolutionDiag.Message)
	}
	// The underlying build error itself (from features.BuildLibrary) must still be present too --
	// this new diagnostic supplements it, it does not replace it.
	buildDiagFound := false
	for _, d := range result.Diagnostics {
		if d.Level == "error" && strings.Contains(d.Message, "places_block is required") {
			buildDiagFound = true
		}
	}
	if !buildDiagFound {
		t.Errorf("expected the underlying build-failure diagnostic to still be present, got %+v", result.Diagnostics)
	}
}

// ---------------------------------------------------------------------------
// Diff classification: placed / carved / replaced -- the three-way split
// task called out explicitly.
// ---------------------------------------------------------------------------

func TestGenerate_PlacedCell(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid) // entirely air baseline
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:place_diamond")
	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksPlaced != 1 {
		t.Errorf("BlocksPlaced = %d, want 1", result.BlocksPlaced)
	}
	if result.BlocksCarved != 0 {
		t.Errorf("BlocksCarved = %d, want 0", result.BlocksCarved)
	}
	if result.BlocksReplaced != 0 {
		t.Errorf("BlocksReplaced = %d, want 0", result.BlocksReplaced)
	}
	if result.BlocksChanged != 1 {
		t.Errorf("BlocksChanged = %d, want 1", result.BlocksChanged)
	}
	if sum := sumBytes(result.Changed); sum != 1 {
		t.Errorf("sum(Changed) = %d, want 1", sum)
	}
	if sum := sumBytes(result.Removed); sum != 0 {
		t.Errorf("sum(Removed) = %d, want 0 (an added cell is not a removed cell)", sum)
	}
	if len(result.Placements) != 1 || result.Placements[0].Returned == nil {
		t.Fatalf("expected exactly one successful placement, got %+v", result.Placements)
	}
}

func TestGenerate_CarvedCell(t *testing.T) {
	config, ok := DefaultConfig(env.EnvUndergroundStone) // solid stone baseline
	if !ok {
		t.Fatal("DefaultConfig(underground_stone) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:carve_air")
	files := []features.SourceFile{singleBlockFeatureFile("test:carve_air", "minecraft:air")}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksCarved != 1 {
		t.Errorf("BlocksCarved = %d, want 1", result.BlocksCarved)
	}
	if result.BlocksPlaced != 0 {
		t.Errorf("BlocksPlaced = %d, want 0", result.BlocksPlaced)
	}
	if result.BlocksReplaced != 0 {
		t.Errorf("BlocksReplaced = %d, want 0", result.BlocksReplaced)
	}
	if sum := sumBytes(result.Removed); sum != 1 {
		t.Errorf("sum(Removed) = %d, want 1 -- a carved cell must be visible in the Removed mask", sum)
	}
	if sum := sumBytes(result.Changed); sum != 1 {
		t.Errorf("sum(Changed) = %d, want 1", sum)
	}
}

func TestGenerate_ReplacedCell(t *testing.T) {
	config, ok := DefaultConfig(env.EnvUndergroundStone) // solid stone baseline
	if !ok {
		t.Fatal("DefaultConfig(underground_stone) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:replace_diamond")
	files := []features.SourceFile{singleBlockFeatureFile("test:replace_diamond", "minecraft:diamond_block")}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksReplaced != 1 {
		t.Errorf("BlocksReplaced = %d, want 1", result.BlocksReplaced)
	}
	if result.BlocksPlaced != 0 {
		t.Errorf("BlocksPlaced = %d, want 0", result.BlocksPlaced)
	}
	if result.BlocksCarved != 0 {
		t.Errorf("BlocksCarved = %d, want 0", result.BlocksCarved)
	}
	if sum := sumBytes(result.Changed); sum != 1 {
		t.Errorf("sum(Changed) = %d, want 1", sum)
	}
	if sum := sumBytes(result.Removed); sum != 0 {
		t.Errorf("sum(Removed) = %d, want 0 (a replaced cell is not carved)", sum)
	}
}

// ---------------------------------------------------------------------------
// Placement refusals surface as diagnostics, not silent empty output.
// ---------------------------------------------------------------------------

func TestGenerate_FailedPlacementSurfacesAsDiagnostic(t *testing.T) {
	config, ok := DefaultConfig(env.EnvUndergroundStone)
	if !ok {
		t.Fatal("DefaultConfig(underground_stone) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:restricted")
	// may_replace restricted to a block that is never actually present at
	// the origin (solid stone everywhere) -- passesAllowList always fails,
	// so placement writes nothing.
	text := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"test:restricted"},` +
		`"enforce_placement_rules":false,"enforce_survivability_rules":false,` +
		`"places_block":"minecraft:diamond_block","may_replace":["minecraft:obsidian"]}}`
	files := []features.SourceFile{{ID: "restricted.json", AbsPath: "restricted.json", Text: text}}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksChanged != 0 {
		t.Fatalf("BlocksChanged = %d, want 0 (placement should have been rejected)", result.BlocksChanged)
	}
	found := false
	for _, d := range result.Diagnostics {
		if strings.Contains(d.Message, "replace list") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a diagnostic naming the replace-list refusal, got %+v", result.Diagnostics)
	}
}

// TestGenerate_DiagnosticIdentifiesRealCulpritWithProfilingOff is the acceptance shape for this
// session's second task: a diagnostic raised from deep inside a delegation chain must name the
// feature that ACTUALLY failed (identifier + type), carry the full root-to-leaf chain, and a
// position -- and it must do so EQUALLY with Config.Profiling left at its zero value (false), not
// only when profiling is armed. test:root (aggregate) -> test:mid (aggregate) -> test:inner
// (scatter, zero-offset distribution) -> test:leaf (single_block, may_replace restricted to a
// block never present) is the same three-levels-of-delegation shape profiler_test.go's
// TestGenerate_ProfilingAttributesNestedLeafThroughThreeComposites uses to pin profiler
// attribution -- this pins the diagnostic side of the same wiring, with profiling OFF.
func TestGenerate_DiagnosticIdentifiesRealCulpritWithProfilingOff(t *testing.T) {
	config, ok := DefaultConfig(env.EnvUndergroundStone)
	if !ok {
		t.Fatal("DefaultConfig(underground_stone) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:root")
	// config.Profiling is deliberately left false (the zero value) -- the whole point of this test.

	leafText := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"test:leaf"},` +
		`"enforce_placement_rules":false,"enforce_survivability_rules":false,` +
		`"places_block":"minecraft:diamond_block","may_replace":["minecraft:obsidian"]}}`
	files := []features.SourceFile{
		aggregateFeatureFile("test:root", "test:mid"),
		aggregateFeatureFile("test:mid", "test:inner"),
		scatterFeatureFile("test:inner", "test:leaf"),
		{ID: "leaf.json", AbsPath: "leaf.json", Text: leafText},
	}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.Profile != nil {
		t.Fatalf("Result.Profile = %+v, want nil -- this test must exercise the profiling-OFF path", result.Profile)
	}

	var got *Diagnostic
	for i := range result.Diagnostics {
		if result.Diagnostics[i].Identifier == "test:leaf" {
			got = &result.Diagnostics[i]
		}
	}
	if got == nil {
		t.Fatalf("expected a diagnostic identifying test:leaf as the failing feature, got %+v", result.Diagnostics)
	}
	if got.FileID != "test:root" {
		t.Errorf("FileID = %q, want %q (the root the caller selected)", got.FileID, "test:root")
	}
	if got.TypeID != "minecraft:single_block_feature" {
		t.Errorf("TypeID = %q, want minecraft:single_block_feature", got.TypeID)
	}
	wantChain := []string{"test:root", "test:mid", "test:inner", "test:leaf"}
	if !reflect.DeepEqual(got.Chain, wantChain) {
		t.Errorf("Chain = %v, want %v", got.Chain, wantChain)
	}
	if got.Position == nil {
		t.Error("Position = nil, want a structured position (this diagnostic fires from inside single_block_feature's own ctx.Origin)")
	}
	if got.Count < 1 {
		t.Errorf("Count = %d, want >= 1", got.Count)
	}
	if strings.Contains(got.Message, "test:leaf") || strings.Contains(got.Message, "single_block_feature") {
		t.Errorf("Message = %q, must not repeat the identifier/type -- those are carried in the structured fields", got.Message)
	}
}

// ---------------------------------------------------------------------------
// RepeatCount places multiple times, advancing the same RNG/scope.
// ---------------------------------------------------------------------------

func TestGenerate_RepeatCountPlacesMultipleTimes(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:place_diamond")
	config.RepeatCount = 3
	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(result.Placements) != 3 {
		t.Errorf("len(Placements) = %d, want 3", len(result.Placements))
	}
	// Every repeat places at the SAME origin (single_block_feature has no
	// randomness in its position), so only one cell ever actually changes.
	if result.BlocksPlaced != 1 {
		t.Errorf("BlocksPlaced = %d, want 1 (same cell written 3 times)", result.BlocksPlaced)
	}
}

// ---------------------------------------------------------------------------
// A manual OriginY override is honoured instead of the preset default.
// ---------------------------------------------------------------------------

func TestGenerate_OriginYOverride(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.OriginY = intPtr(5)
	config.FeatureIdentifier = strPtr("test:place_diamond")
	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.Origin.Y != 5 {
		t.Errorf("Origin.Y = %d, want 5 (manual override)", result.Origin.Y)
	}
}

func sumBytes(b []byte) int {
	n := 0
	for _, v := range b {
		n += int(v)
	}
	return n
}

// ---------------------------------------------------------------------------
// EnvironmentBiomeID: a loaded pack biome fills the material slots (source 2
// of env.MaterialSlots's pipeline) AND supplies query.has_biome_tag's default
// identity. Precedence: preset
// (source 1) is the base, a selected pack biome (source 2) fills in over
// it, and an explicit override (source 3 -- MaterialOverride for materials,
// BiomeOverride for tags/id) always wins over both.
// ---------------------------------------------------------------------------

// biomeSourceFile builds a biomes/*.json SourceFile. surfaceBuilder may be nil
// (a biome with no minecraft:surface_builder component at all, falling back
// to the preset's own materials exactly as if no biome were selected).
func biomeSourceFile(identifier string, tags []string, surfaceBuilder map[string]any) biomes.SourceFile {
	components := map[string]any{
		"minecraft:tags": map[string]any{"tags": tags},
	}
	if surfaceBuilder != nil {
		components["minecraft:surface_builder"] = map[string]any{"builder": surfaceBuilder}
	}
	raw, err := json.Marshal(map[string]any{
		"format_version": "1.21.110",
		"minecraft:biome": map[string]any{
			"description": map[string]any{"identifier": identifier},
			"components":  components,
		},
	})
	if err != nil {
		panic(err)
	}
	id := strings.ReplaceAll(identifier, ":", "_") + ".sb.json"
	return biomes.SourceFile{ID: id, AbsPath: id, Text: string(raw)}
}

func obsidianTestBiome() biomes.SourceFile {
	return biomeSourceFile("wiki:testbiome", []string{"testbiome", "overworld"}, map[string]any{
		"type":                "minecraft:overworld",
		"top_material":        "minecraft:obsidian",
		"mid_material":        "minecraft:obsidian",
		"foundation_material": "minecraft:obsidian",
		"sea_floor_depth":     0.0,
		"sea_floor_material":  "minecraft:gravel",
		"sea_material":        "minecraft:water",
	})
}

func TestGenerate_EnvironmentBiomeFillsMaterialSlots(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.EnvironmentBiomeID = "wiki:testbiome"

	result, err := Generate(config, nil, nil, nil, []biomes.SourceFile{obsidianTestBiome()}, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.EnvironmentBiome == nil || result.EnvironmentBiome.Identifier != "wiki:testbiome" {
		t.Fatalf("EnvironmentBiome = %+v, want the resolved wiki:testbiome", result.EnvironmentBiome)
	}
	if len(result.BiomeEntries) != 1 {
		t.Errorf("len(BiomeEntries) = %d, want 1 (always populated, mirrors RuleEntries/Entries)", len(result.BiomeEntries))
	}
	top := result.Volume.GetHeight(0, 0) - 1
	obsidian := paletteID(t, result.Palette, "minecraft:obsidian")
	if got := result.Volume.GetBlockAt(0, top, 0); got != obsidian {
		t.Errorf("terrain top block id = %d, want obsidian id %d -- plains' native grass_block should have been replaced", got, obsidian)
	}
	for _, id := range result.Blocks {
		if name := paletteName(result.Palette, id); name == "minecraft:grass_block" || name == "minecraft:dirt" {
			t.Errorf("found %s in the built volume -- the selected biome's materials did not fully replace plains' own", name)
			break
		}
	}
}

// TestGenerate_MaterialOverrideWinsOverSelectedBiome proves source 3
// (Config.MaterialOverride) still wins per-field over source 2 (a selected
// pack biome) -- "a user who picks a biome and then edits one material must
// keep their edit", the precedence rule the task calls out explicitly.
func TestGenerate_MaterialOverrideWinsOverSelectedBiome(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.EnvironmentBiomeID = "wiki:testbiome"
	diamond := "minecraft:diamond_block"
	config.MaterialOverride = &env.MaterialOverride{TopMaterial: &diamond}

	result, err := Generate(config, nil, nil, nil, []biomes.SourceFile{obsidianTestBiome()}, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	top := result.Volume.GetHeight(0, 0) - 1
	diamondID := paletteID(t, result.Palette, "minecraft:diamond_block")
	if got := result.Volume.GetBlockAt(0, top, 0); got != diamondID {
		t.Errorf("terrain top block id = %d, want the explicit override's diamond_block id %d, not the biome's own obsidian", got, diamondID)
	}
	// mid_material was NOT overridden, so the biome's own obsidian must still be there --
	// an override wins per-FIELD, it does not wipe the rest of the biome's materials.
	obsidian := paletteID(t, result.Palette, "minecraft:obsidian")
	mid := result.Volume.GetBlockAt(0, top-2, 0)
	if mid != obsidian {
		t.Errorf("mid-depth block id = %d, want the biome's own obsidian id %d -- an override should win only for the field it names", mid, obsidian)
	}
}

// TestGenerate_EnvironmentBiomeSuppliesDefaultTagsForBiomeFilter proves the
// selected biome's own minecraft:tags become query.has_biome_tag's default
// identity, gating a feature_rules biome_filter exactly like
// EnvironmentPreset.biome/biomeTags already did.
func TestGenerate_EnvironmentBiomeSuppliesDefaultTagsForBiomeFilter(t *testing.T) {
	files := []features.SourceFile{singleBlockFeatureFile("test:marker", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		// y=46 (not 0): a rule's origin is the chunk/dimension build floor (y=0), but
		// plains' own volume spans MinY=44..91 (env.surfaceDefaults) -- y=0 would land
		// outside the previewed volume and read as 0 blocks changed for a reason that has
		// nothing to do with the biome_filter this test is actually exercising.
		ruleSourceFile("marker.fr.json", "wiki:marker.fr", "test:marker",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 46.0, "z": 0.0},
			map[string]any{"minecraft:biome_filter": map[string]any{"test": "has_biome_tag", "value": "testbiome"}}),
	}
	biomeFiles := []biomes.SourceFile{obsidianTestBiome()}

	without, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	without.Mode = ModeRule
	without.RuleIdentifier = strPtr("wiki:marker.fr")
	rejected, err := Generate(without, files, nil, ruleFiles, biomeFiles, nil)
	if err != nil {
		t.Fatalf("Generate (without biome): %v", err)
	}
	if rejected.BlocksChanged != 0 {
		t.Errorf("without EnvironmentBiomeID: BlocksChanged = %d, want 0 -- plains' own tags don't carry 'testbiome'", rejected.BlocksChanged)
	}

	with, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	with.Mode = ModeRule
	with.RuleIdentifier = strPtr("wiki:marker.fr")
	with.EnvironmentBiomeID = "wiki:testbiome"
	accepted, err := Generate(with, files, nil, ruleFiles, biomeFiles, nil)
	if err != nil {
		t.Fatalf("Generate (with biome): %v", err)
	}
	if accepted.BlocksChanged == 0 {
		t.Error("with EnvironmentBiomeID selecting wiki:testbiome: BlocksChanged = 0, want > 0 -- the biome's own tags should have passed the filter")
	}
}

// TestGenerate_BiomeOverrideWinsOverEnvironmentBiome proves source 3
// (Config.BiomeOverride) still wins over source 2 (EnvironmentBiomeID) for
// tag identity -- the existing manual-override mechanism, unchanged: a
// manual BiomeOverride still wins.
func TestGenerate_BiomeOverrideWinsOverEnvironmentBiome(t *testing.T) {
	files := []features.SourceFile{singleBlockFeatureFile("test:marker", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		ruleSourceFile("marker.fr.json", "wiki:marker.fr", "test:marker",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0},
			map[string]any{"minecraft:biome_filter": map[string]any{"test": "has_biome_tag", "value": "testbiome"}}),
	}
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr("wiki:marker.fr")
	config.EnvironmentBiomeID = "wiki:testbiome"
	config.BiomeOverride = &BiomeOverride{ID: "somewhere_else", Tags: "nothing_relevant"}

	result, err := Generate(config, files, nil, ruleFiles, []biomes.SourceFile{obsidianTestBiome()}, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.BlocksChanged != 0 {
		t.Errorf("BlocksChanged = %d, want 0 -- BiomeOverride's tags don't include 'testbiome', and it must win even though the pack biome (which does carry it) is selected", result.BlocksChanged)
	}
}

// TestGenerate_UnknownEnvironmentBiomeIDReportsDiagnostic proves an id naming
// no loaded biome file is not a silent fallback -- see
// Config.EnvironmentBiomeID's own doc comment.
func TestGenerate_UnknownEnvironmentBiomeIDReportsDiagnostic(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.EnvironmentBiomeID = "wiki:does_not_exist"

	result, err := Generate(config, nil, nil, nil, []biomes.SourceFile{obsidianTestBiome()}, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result.EnvironmentBiome != nil {
		t.Errorf("EnvironmentBiome = %+v, want nil for an unresolved id", result.EnvironmentBiome)
	}
	found := false
	for _, d := range result.Diagnostics {
		if d.Level == "error" && strings.Contains(d.Message, "wiki:does_not_exist") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected an \"error\" diagnostic naming the unresolved id, got %+v", result.Diagnostics)
	}
	// Still falls back to the preset's own materials -- not a silent no-op, but not a hard
	// failure either.
	top := result.Volume.GetHeight(0, 0) - 1
	grass := paletteID(t, result.Palette, "minecraft:grass_block")
	if got := result.Volume.GetBlockAt(0, top, 0); got != grass {
		t.Errorf("terrain top block id = %d, want plains' own grass_block id %d as the fallback", got, grass)
	}
}

func paletteID(t *testing.T, entries []block.Entry, name string) block.ID {
	t.Helper()
	for _, e := range entries {
		if e.Name == name {
			return e.ID
		}
	}
	t.Fatalf("palette has no entry named %q", name)
	return 0
}

func paletteName(entries []block.Entry, id block.ID) string {
	for _, e := range entries {
		if e.ID == id {
			return e.Name
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Workspace caching: biome resolution participates in the same per-kind
// content-fingerprint invalidation as feature/structure/rule libraries (see
// workspace.go's own doc comment) -- editing an unrelated kind must not
// rebuild the biome library, and editing a biome file must.
// ---------------------------------------------------------------------------

func TestWorkspace_BiomeLibraryCachedAcrossUnrelatedUpdates(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "biomes", "testbiome.json"), obsidianTestBiome().Text)
	writeWorkspaceTestFeature(t, root, "minecraft:stone")
	loaded := loadWorkspaceTestPack(t, root)

	ws := NewWorkspace(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	firstBiomeLib := ws.biomeLib
	if firstBiomeLib == nil {
		t.Fatal("biomeLib is nil after NewWorkspace")
	}

	// Edit only the feature file -- the biome file on disk is untouched.
	writeWorkspaceTestFeature(t, root, "minecraft:diamond_block")
	reloaded := loadWorkspaceTestPack(t, root)
	ws.Update(reloaded.Features, reloaded.Structures, reloaded.Rules, reloaded.Biomes, reloaded.Blocks)

	if ws.biomeLib != firstBiomeLib {
		t.Error("biomeLib was rebuilt even though no biomes/*.json file changed -- Update's per-kind fingerprinting regressed (reintroduces per-call rebuild cost)")
	}

	// Now actually edit the biome file's own content.
	edited := biomeSourceFile("wiki:testbiome", []string{"testbiome"}, map[string]any{
		"type": "minecraft:overworld", "top_material": "minecraft:diamond_ore",
		"mid_material": "minecraft:diamond_ore", "foundation_material": "minecraft:diamond_ore",
		"sea_floor_depth": 0.0, "sea_floor_material": "minecraft:gravel", "sea_material": "minecraft:water",
	})
	writeTestFile(t, filepath.Join(root, "biomes", "testbiome.json"), edited.Text)
	reloaded2 := loadWorkspaceTestPack(t, root)
	ws.Update(reloaded2.Features, reloaded2.Structures, reloaded2.Rules, reloaded2.Biomes, reloaded2.Blocks)

	if ws.biomeLib == firstBiomeLib {
		t.Error("biomeLib was NOT rebuilt after its own source file changed -- a stale biome library would be served forever")
	}
	resolved := ws.biomeLib.Resolve("wiki:testbiome")
	if resolved == nil || resolved.SurfaceBuilder == nil || resolved.SurfaceBuilder.TopMaterial != "minecraft:diamond_ore" {
		t.Fatalf("resolved biome after edit = %+v, want top_material updated to minecraft:diamond_ore", resolved)
	}

	// And the correctness end-to-end: Generate against the now-edited biome sees the edit.
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.EnvironmentBiomeID = "wiki:testbiome"
	result, err := ws.Generate(config)
	if err != nil {
		t.Fatalf("ws.Generate: %v", err)
	}
	top := result.Volume.GetHeight(0, 0) - 1
	diamondOre := paletteID(t, result.Palette, "minecraft:diamond_ore")
	if got := result.Volume.GetBlockAt(0, top, 0); got != diamondOre {
		t.Errorf("terrain top block id = %d, want the edited biome's diamond_ore id %d", got, diamondOre)
	}
}

// ---------------------------------------------------------------------------
// Rule-mode seeding, end to end
// ---------------------------------------------------------------------------

// changedCells returns every cell the run wrote, as world (x, y, z), sorted -- the observable
// output of a rule-mode generate, which is what the seeding actually decides.
func changedCells(t *testing.T, r *Result) [][3]int {
	t.Helper()
	v := r.Volume
	var out [][3]int
	for y := v.MinY(); y < v.MinY()+v.SizeY(); y++ {
		for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
			for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
				i := (y-v.MinY())*v.SizeX()*v.SizeZ() + (z-v.MinZ())*v.SizeX() + (x - v.MinX())
				if r.Changed[i] == 1 {
					out = append(out, [3]int{x, y, z})
				}
			}
		}
	}
	return out
}

// ruleRun generates one rule over a 32x16x32 bench (exactly four chunks) on the void preset, so
// nothing but the rule's own output is in the volume.
func ruleRun(t *testing.T, ruleID string, seed uint32, ruleFiles []rules.SourceFile) *Result {
	t.Helper()
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr(ruleID)
	config.FeatureSeed = seed
	config.SizeX, config.SizeY, config.SizeZ = 32, 16, 32
	config.MinY = 0

	files := []features.SourceFile{singleBlockFeatureFile("test:mark", "minecraft:stone")}
	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate(%s): %v", ruleID, err)
	}
	return result
}

// uniformRuleFile is a rule that scatters its marker uniformly inside each chunk -- eight
// attempts, both horizontal axes random, so every draw the seeding decides is visible in the
// output positions.
func uniformRuleFile(id, identifier string) rules.SourceFile {
	return ruleSourceFile(id, identifier, "test:mark", map[string]any{
		"iterations": 8.0,
		"x":          map[string]any{"distribution": "uniform", "extent": []any{0.0, 15.0}},
		"y":          0.0,
		"z":          map[string]any{"distribution": "uniform", "extent": []any{0.0, 15.0}},
	}, nil)
}

func TestGenerate_RuleSeedingIsPerChunkAndRepeatable(t *testing.T) {
	// The seeding wiring this covers lives in Generate itself: world seed + the CHUNK's own
	// coordinates give the chunk seed, and the chunk coordinate comes from the chunk-aligned
	// world origin. An off-by-a-shift there (world x instead of chunk x, say) still produces
	// output that looks plausible -- scattered markers, right count -- so only a pinned
	// comparison catches it.
	files := []rules.SourceFile{uniformRuleFile("r.json", "test:rule")}

	first := changedCells(t, ruleRun(t, "test:rule", 42, files))
	again := changedCells(t, ruleRun(t, "test:rule", 42, files))
	if len(first) == 0 {
		t.Fatal("the rule placed nothing; the rest of this test proves nothing")
	}
	if !reflect.DeepEqual(first, again) {
		t.Error("the same rule at the same seed placed differently twice")
	}

	// Every one of the four chunks must be decorated, and each from its own stream: eight
	// attempts land in each 16x16, none of them in a neighbour's. A single shared stream (or a
	// chunk coordinate that does not vary) collapses this into one chunk or four identical ones.
	perChunk := map[[2]int]int{}
	for _, c := range first {
		perChunk[[2]int{floorDiv(c[0], 16), floorDiv(c[2], 16)}]++
	}
	if len(perChunk) != 4 {
		t.Fatalf("placements landed in %d chunks, want all 4: %v", len(perChunk), perChunk)
	}
	// Offsets are chunk-relative, so the pattern inside two different chunks must differ -- if
	// the chunk coordinate were not reaching the seed, all four would carry the same pattern.
	rel := map[[2]int]map[[2]int]bool{}
	for _, c := range first {
		key := [2]int{floorDiv(c[0], 16), floorDiv(c[2], 16)}
		if rel[key] == nil {
			rel[key] = map[[2]int]bool{}
		}
		rel[key][[2]int{mod16(c[0]), mod16(c[2])}] = true
	}
	a, b := rel[[2]int{-1, -1}], rel[[2]int{0, 0}]
	if len(a) > 0 && len(b) > 0 && reflect.DeepEqual(a, b) {
		t.Error("two different chunks decorated with an identical in-chunk pattern -- the chunk " +
			"coordinate is not reaching the seed")
	}
}

func TestGenerate_RuleSeedingUsesTheRuleIdentifier(t *testing.T) {
	// The name folded into each entry's seed is the RULE's identifier, not the feature it places.
	// Two rules that differ ONLY in identifier must decorate differently; the same rule under a
	// different seed must too.
	byName := func(identifier string) [][3]int {
		return changedCells(t, ruleRun(t, identifier, 42, []rules.SourceFile{
			uniformRuleFile("a.json", "test:rule_a"),
			uniformRuleFile("b.json", "test:rule_b"),
		}))
	}
	a, b := byName("test:rule_a"), byName("test:rule_b")
	if len(a) == 0 || len(b) == 0 {
		t.Fatal("both rules must place something")
	}
	if reflect.DeepEqual(a, b) {
		t.Error("two rules differing only in identifier placed identically -- the identifier is " +
			"not reaching the seed")
	}

	other := changedCells(t, ruleRun(t, "test:rule_a", 43, []rules.SourceFile{uniformRuleFile("a.json", "test:rule_a")}))
	if reflect.DeepEqual(a, other) {
		t.Error("the same rule placed identically under two different world seeds")
	}
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func mod16(a int) int {
	m := a % 16
	if m < 0 {
		m += 16
	}
	return m
}

// uniformRuleDistribution is the distribution uniformRuleFile writes, as the map the parser
// takes -- so a test can build the SAME distribution the rule got without going through the
// rule at all, and predict where it should place.
func uniformRuleDistribution() map[string]any {
	return map[string]any{
		"iterations": 8.0,
		"x":          map[string]any{"distribution": "uniform", "extent": []any{0.0, 15.0}},
		"y":          0.0,
		"z":          map[string]any{"distribution": "uniform", "extent": []any{0.0, 15.0}},
	}
}

func TestGenerate_RuleSeedingUsesTheChunkCoordinateNotTheWorldCoordinate(t *testing.T) {
	// The chunk seed takes the CHUNK's coordinates. Feeding it the chunk-aligned WORLD
	// coordinates instead -- dropping one shift -- still gives every chunk its own stream, still
	// covers the bench, still reproduces run to run, so every property-shaped assertion around it
	// keeps passing while every position in the world moves. The only thing that catches it is
	// predicting the positions from the derivation independently and comparing, which is what
	// this does for one chunk.
	const seed = uint32(42)
	result := ruleRun(t, "test:rule", seed, []rules.SourceFile{uniformRuleFile("r.json", "test:rule")})

	// The chunk at world (-16, -16), i.e. chunk (-1, -1) -- deliberately not the chunk at the
	// world origin, where the two readings coincide and prove nothing.
	origin := wgen.BlockPos{X: -16, Y: 0, Z: -16}
	chunkSeed := random.ChunkDecorationSeed(seed, -1, -1)
	entrySeed := random.DecorationEntrySeed(chunkSeed, random.HashedStringHash32("test:rule"))

	dist, err := features.ParseScatterDistribution(uniformRuleDistribution(), "distribution", nil)
	if err != nil {
		t.Fatalf("ParseScatterDistribution: %v", err)
	}
	rnd := random.New(entrySeed)
	scope := wgen.NewScope()
	scope.Variable["originx"] = float64(origin.X)
	scope.Variable["originy"] = float64(origin.Y)
	scope.Variable["originz"] = float64(origin.Z)
	biome := &wgen.MolangBiome{ID: "void", Tags: map[string]struct{}{}}
	want := map[[3]int]bool{}
	features.RunScatterDistribution(features.ScatterRun{
		Dist:   dist,
		Molang: wgen.NewMolangContext(rnd, scope, biome, result.Volume, nil),
		Random: rnd,
		Origin: [3]int{origin.X, origin.Y, origin.Z},
		OnAxis: func(a features.Axis, absolute int) {
			scope.Variable[features.WorldVarName(a)] = float64(absolute)
		},
		OnIteration: func(offset features.AxisOffset, _ int) {
			want[[3]int{origin.X + offset.X, origin.Y + offset.Y, origin.Z + offset.Z}] = true
		},
	})
	if len(want) == 0 {
		t.Fatal("the independent prediction produced no positions; it is not predicting anything")
	}

	got := map[[3]int]bool{}
	for _, c := range changedCells(t, result) {
		if floorDiv(c[0], 16) == -1 && floorDiv(c[2], 16) == -1 {
			got[c] = true
		}
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("chunk (-1,-1) placed %v; the seed derived from the CHUNK coordinate predicts %v -- "+
			"if these differ by a factor of sixteen somewhere, the world coordinate is reaching the "+
			"seed where the chunk coordinate belongs", sortedCells(got), sortedCells(want))
	}
}

func TestGenerate_RuleDelegateDrawsDoNotMoveItsPositions(t *testing.T) {
	// Session builds TWO generators from the entry seed: one the distribution draws positions
	// from, one the delegated feature draws from. Collapsing them into one shared generator is a
	// one-word edit that leaves every other rule-mode assertion intact -- same chunks, same
	// counts, reproducible -- and moves every position as soon as the delegate draws at all.
	//
	// randomize_rotation is the cheapest delegate draw there is: one draw per placement, and no
	// effect on WHERE the block goes. So the two runs below must place in exactly the same cells.
	plain := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":
		{"identifier":"test:mark"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":"minecraft:stone"}}`
	drawing := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":
		{"identifier":"test:mark"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"randomize_rotation":true,"places_block":"minecraft:stone"}}`

	run := func(featureText string) [][3]int {
		config, ok := DefaultConfig(env.EnvVoid)
		if !ok {
			t.Fatal("DefaultConfig(void) should succeed")
		}
		config.Mode = ModeRule
		config.RuleIdentifier = strPtr("test:rule")
		config.FeatureSeed = 7
		config.SizeX, config.SizeY, config.SizeZ = 32, 16, 32
		config.MinY = 0
		files := []features.SourceFile{{ID: "mark.json", AbsPath: "mark.json", Text: featureText}}
		ruleFiles := []rules.SourceFile{uniformRuleFile("r.json", "test:rule")}
		result, err := Generate(config, files, nil, ruleFiles, nil, nil)
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		return changedCells(t, result)
	}

	withoutDraws := run(plain)
	withDraws := run(drawing)
	if len(withoutDraws) == 0 {
		t.Fatal("the rule placed nothing; the comparison would be vacuous")
	}
	if !reflect.DeepEqual(withoutDraws, withDraws) {
		t.Errorf("giving the delegate a draw of its own moved the positions the rule picked:\n  "+
			"without: %v\n  with:    %v\nThe distribution and the delegate must draw from two "+
			"independent generators seeded alike, not from one shared stream", withoutDraws, withDraws)
	}
}

func sortedCells(set map[[3]int]bool) [][3]int {
	out := make([][3]int, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i][1] != out[j][1] {
			return out[i][1] < out[j][1]
		}
		if out[i][2] != out[j][2] {
			return out[i][2] < out[j][2]
		}
		return out[i][0] < out[j][0]
	})
	return out
}

// TestReuseFingerprint_TrustsSliceIdentityAndNothingElse is
// reuseFingerprint's own test, and it has to be a direct one. What the
// function does when it takes its fast path is invisible from outside:
// skipping the hash and re-hashing to the same value are indistinguishable
// through Update, which is exactly why the whole optimisation could be
// deleted without a single test noticing. What each of its three conditions
// REFUSES to take the fast path for is the part that matters, and only two
// of the three are reachable through a caller at all.
//
// The obligation the fast path rests on is the caller's (see
// reuseFingerprint's own doc comment): a slice already handed to Update is
// never mutated in place, so "the very same slice" really does mean "the
// very same bytes". That is pinned from the callers' side by
// pack.TestReloadFile_DoesNotWriteThroughTheCallersPreviousSlice and
// TestApp_HandlePackChanged_DoesNotMutateSlicesAlreadyHandedToTheWorkspace;
// what is pinned HERE is the other direction -- that identity is the only
// thing this trusts, so anything that merely LOOKS unchanged is still
// re-hashed.
func TestReuseFingerprint_TrustsSliceIdentityAndNothingElse(t *testing.T) {
	hashes := 0
	hash := func(files []features.SourceFile) string {
		hashes++
		return "recomputed"
	}
	files := []features.SourceFile{
		{ID: "a.json", Text: `{"a":1}`},
		{ID: "b.json", Text: `{"b":1}`},
	}

	// The one case the fast path is for: the caller handed back literally
	// the slice the stored fingerprint was computed from (a kind a
	// single-file reload did not touch). The stored answer stands, and
	// nothing is hashed -- which on a large add-on is many MB of structure
	// files this exists to not re-read on every save.
	if got := reuseFingerprint(files, files, "stored", hash); got != "stored" {
		t.Errorf("same slice: fingerprint = %q, want the stored one", got)
	}
	if hashes != 0 {
		t.Errorf("same slice: hashed %d times, want 0 -- the stored fingerprint was recomputed instead of reused", hashes)
	}

	// A DIFFERENT slice is re-hashed even when its contents are identical,
	// because that is the only way a changed kind is ever noticed: pack.
	// Pack.ReloadFile copies before splicing precisely so an edited kind
	// arrives as a new slice, and it arrives at the same length as often as
	// not (one file edited in place). Trusting length alone here is a stale
	// library served forever.
	same := append([]features.SourceFile(nil), files...)
	if got := reuseFingerprint(same, files, "stored", hash); got != "recomputed" {
		t.Errorf("copied slice: fingerprint = %q, want it recomputed -- a new slice must never be taken on trust", got)
	}

	// Same backing array, different length: still not the slice the stored
	// fingerprint was computed from, so still not an answer this may reuse.
	if got := reuseFingerprint(files[:1], files, "stored", hash); got != "recomputed" {
		t.Errorf("prefix of the same array: fingerprint = %q, want it recomputed", got)
	}

	// Empty slices have no first element to compare, so there is no identity
	// to trust -- and hashing nothing costs nothing. This is the case
	// NewWorkspace hits on its very first call for every kind a pack has
	// none of.
	var none []features.SourceFile
	if got := reuseFingerprint(none, none, "stored", hash); got != "recomputed" {
		t.Errorf("empty slices: fingerprint = %q, want it recomputed rather than an identity comparison with no address to make", got)
	}
}
