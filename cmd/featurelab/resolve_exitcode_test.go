package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// resolve_exitcode_test.go covers the CLI-visible half of unresolved-identifier handling: `generate` against an
// identifier the loaded pack does not define must (a) say so in its own diagnostics -- covered in
// depth by featurelab-go/session's own tests -- and (b) exit non-zero rather than 0, the same
// "any error-level diagnostic fails the run" rule cmdCheck/diagLevelHasError already applied. A
// known-good request must still exit 0, unchanged.

func TestCmdGenerate_UnknownFeatureExitsNonZeroWithDiagnostic(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	args := []string{"generate", "--pack", root, "--feature", "test:does_not_exist", "--env", "void"}

	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code == 0 {
		t.Fatalf("run(%v) = 0, want non-zero: an unresolved --feature must not exit as if it succeeded; output: %s", args, out)
	}

	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	diags, ok := m["diagnostics"].([]any)
	if !ok || len(diags) == 0 {
		t.Fatalf("diagnostics = %v, want at least one entry naming the unresolved identifier", m["diagnostics"])
	}
	d0, ok := diags[0].(map[string]any)
	if !ok || d0["level"] != "error" || !strings.Contains(d0["message"].(string), "test:does_not_exist") {
		t.Errorf("diagnostics[0] = %+v, want an error naming test:does_not_exist", d0)
	}
}

func TestCmdGenerate_UnknownRuleExitsNonZeroWithDiagnostic(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "feature_rules", "rule.json"),
		`{"format_version":"1.21.110","minecraft:feature_rules":{"description":{"identifier":"test:rule","places_feature":"test:place_diamond"},"distribution":{"iterations":1,"x":0,"y":0,"z":0}}}`)

	args := []string{"generate", "--pack", root, "--rule", "test:does_not_exist", "--env", "void"}

	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code == 0 {
		t.Fatalf("run(%v) = 0, want non-zero: an unresolved --rule must not exit as if it succeeded; output: %s", args, out)
	}

	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if m["activeRule"] != nil {
		t.Errorf("activeRule = %v, want null for an unresolved rule id", m["activeRule"])
	}
}

func TestCmdGenerate_KnownGoodFeatureStillExitsZero(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	args := []string{"generate", "--pack", root, "--feature", "test:place_diamond", "--env", "void"}

	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0 for a feature that resolves and places normally; output: %s", args, code, out)
	}

	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if m["blocksPlaced"].(float64) != 1 {
		t.Errorf("blocksPlaced = %v, want 1", m["blocksPlaced"])
	}
	if diags, ok := m["diagnostics"].([]any); ok && len(diags) != 0 {
		t.Errorf("diagnostics = %v, want none for a clean known-good run", diags)
	}
}
