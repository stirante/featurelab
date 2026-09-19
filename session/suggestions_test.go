package session

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/rules"
)

// The commonest way a caller reaches "not defined by the loaded pack" at all: they typed the
// feature's name and left the namespace off. The message used to answer with a count.
func TestGenerate_MissingNamespaceIsNamedNotCounted(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("rng_marker")

	files := []features.SourceFile{singleBlockFeatureFile("wiki:rng_marker", "minecraft:diamond_block")}
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	msg := findDiagnostic(t, result.Diagnostics, `"rng_marker"`)
	if !strings.Contains(msg, `did you mean "wiki:rng_marker"`) {
		t.Errorf("message = %q, want the namespaced identifier offered", msg)
	}
}

// "55 built successfully" was internal bookkeeping in the place the answer belonged.
func TestGenerate_UnresolvedMessageDropsTheBuiltCount(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("wiki:nothing_like_this_at_all")

	files := []features.SourceFile{singleBlockFeatureFile("wiki:rock", "minecraft:diamond_block")}
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	msg := findDiagnostic(t, result.Diagnostics, `"wiki:nothing_like_this_at_all"`)
	if strings.Contains(msg, "built successfully") {
		t.Errorf("message = %q, want no \"built successfully\" -- it is bookkeeping a pack author cannot act on", msg)
	}
	// The loaded count stays: it is what tells "not found" apart from "the pack loaded nothing".
	if !strings.Contains(msg, "1 feature(s) loaded") {
		t.Errorf("message = %q, want the loaded count kept", msg)
	}
}

// A namespace match is offered instead of, not alongside, an edit-distance guess -- the same
// rule the shared helper is tested for, asserted here through a real Generate so the wiring is
// covered too.
func TestGenerate_RuleMissingNamespaceIsNamed(t *testing.T) {
	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.Mode = ModeRule
	config.RuleIdentifier = strPtr("highland.main")

	files := []features.SourceFile{singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block")}
	ruleFiles := []rules.SourceFile{
		ruleSourceFile("hl.json", "wiki:highland.main", "test:place_diamond",
			map[string]any{"iterations": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}, nil),
	}
	result, err := Generate(config, files, nil, ruleFiles, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	msg := findDiagnostic(t, result.Diagnostics, `"highland.main"`)
	if !strings.Contains(msg, `did you mean "wiki:highland.main"`) {
		t.Errorf("message = %q, want the namespaced rule offered", msg)
	}
	if strings.Contains(msg, "built successfully") {
		t.Errorf("message = %q, want no \"built successfully\"", msg)
	}
}

// The --biome-id case is the one where getting it wrong looks like nothing happened: a mistyped
// biome falls back to the preset's own materials and then generates perfectly happily.
func TestGenerate_UnknownBiomeIDOffersTheNearMatch(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.EnvironmentBiomeID = "highlands"

	files := []features.SourceFile{singleBlockFeatureFile("wiki:rock", "minecraft:diamond_block")}
	config.FeatureIdentifier = strPtr("wiki:rock")
	biomeFiles := []biomes.SourceFile{biomeSourceFile("wiki:highlands", []string{"overworld"}, nil)}
	result, err := Generate(config, files, nil, nil, biomeFiles, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	msg := findDiagnostic(t, result.Diagnostics, `"highlands"`)
	if !strings.Contains(msg, "not defined by any loaded biome file") {
		t.Errorf("message = %q, want the unknown-biome sentence", msg)
	}
	if !strings.Contains(msg, `did you mean "wiki:highlands"`) {
		t.Errorf("message = %q, want the namespaced biome offered", msg)
	}
	if !strings.Contains(msg, "1 biome(s) loaded") {
		t.Errorf("message = %q, want the loaded biome count", msg)
	}
}

func findDiagnostic(t *testing.T, diags []Diagnostic, contains string) string {
	t.Helper()
	for _, d := range diags {
		if strings.Contains(d.Message, contains) {
			return d.Message
		}
	}
	t.Fatalf("no diagnostic mentioning %s, got %+v", contains, diags)
	return ""
}
