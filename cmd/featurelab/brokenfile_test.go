package main

// brokenfile_test.go covers what a pack with ONE unreadable file does over the wire, end to
// end. That combination -- a file that cannot be parsed sitting in an otherwise healthy pack --
// used to be the quietest failure this tool had: "loadPack" answered with a feature count that
// included the broken file, no diagnostics at all, and a later "generate" naming the feature
// that file declares came back with an empty result and a message asserting the feature was not
// defined by the pack.
//
// Everything here is asserted through runServe's real request/response loop rather than against
// the loader directly, because every one of those symptoms was a REPORTING failure: each fact
// these tests want already existed somewhere inside the engine and simply never reached a
// caller.

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/session"
)

// truncatedFeatureJSON is a feature file cut off mid-value -- the shape a save-while-typing or
// an interrupted copy leaves behind. It still contains a readable description.identifier, which
// is what lets a diagnostic connect the identifier a caller asks for to the file that could not
// be read (features.ScrapeIdentifier).
const truncatedFeatureJSON = `{
  "format_version": "1.21.110",
  "minecraft:single_block_feature": {
    "description": {
      "identifier": "test:broken"
    },
    "places_block":`

// diagnosticsOf reads the "diagnostics" array out of a decoded JSON-RPC result.
func diagnosticsOf(t *testing.T, result any) []map[string]any {
	t.Helper()
	obj, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result is not an object: %v", result)
	}
	raw, ok := obj["diagnostics"].([]any)
	if !ok {
		t.Fatalf("result has no diagnostics array: %v", obj["diagnostics"])
	}
	out := make([]map[string]any, 0, len(raw))
	for _, d := range raw {
		m, ok := d.(map[string]any)
		if !ok {
			t.Fatalf("diagnostic is not an object: %v", d)
		}
		out = append(out, m)
	}
	return out
}

// TestServe_LoadPackReportsUnparseableFile is the whole silent-failure bug in one assertion set:
// the file is named, positioned, and excluded from the loaded count, all at load time, with no
// generate needed to surface any of it.
func TestServe_LoadPackReportsUnparseableFile(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "good.json"), singleBlockFeatureJSON("test:good", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "broken.json"), truncatedFeatureJSON)

	resps := runLines(t, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root))
	if len(resps) != 1 || resps[0].Error != nil {
		t.Fatalf("loadPack responses = %+v", resps)
	}
	result := resps[0].Result.(map[string]any)

	// The count is what the pack can USE. Two files on disk, one of them unreadable, so one
	// feature -- reported next to the file count rather than replacing it, so neither number
	// has to be guessed from the other.
	if got := result["featureCount"].(float64); got != 1 {
		t.Errorf("featureCount = %v, want 1 (two files, one of them unreadable)", got)
	}
	fileCounts, ok := result["fileCounts"].(map[string]any)
	if !ok {
		t.Fatalf("result has no fileCounts object: %v", result["fileCounts"])
	}
	if got := fileCounts["features"].(float64); got != 2 {
		t.Errorf("fileCounts.features = %v, want 2 (both files were read off disk)", got)
	}

	diags := diagnosticsOf(t, resps[0].Result)
	var found map[string]any
	for _, d := range diags {
		if strings.Contains(d["fileId"].(string), "broken.json") {
			found = d
			break
		}
	}
	if found == nil {
		t.Fatalf("no diagnostic names broken.json; got %+v", diags)
	}
	if found["level"] != "error" {
		t.Errorf("broken.json diagnostic level = %v, want error", found["level"])
	}
	if found["scope"] != session.ScopePack {
		t.Errorf("broken.json diagnostic scope = %v, want %q", found["scope"], session.ScopePack)
	}
	// The fileId is the pack-relative path, not the bare SourceFile id, so an editor can open
	// it without having to guess which directory the id came from.
	if got := found["fileId"].(string); got != filepath.ToSlash(filepath.Join("features", "broken.json")) {
		t.Errorf("broken.json diagnostic fileId = %q, want the pack-relative path", got)
	}
	// The file is truncated at its very end, so that is where the position points. Asserting
	// the exact line and column (not merely "a position is present") is the point: a position
	// that is present but wrong sends an editor's squiggle to the wrong character, which is
	// worse than none.
	lines := strings.Split(truncatedFeatureJSON, "\n")
	wantLine := float64(len(lines))
	wantColumn := float64(len(lines[len(lines)-1]) + 1)
	if found["line"] != wantLine || found["column"] != wantColumn {
		t.Errorf("broken.json diagnostic position = (%v, %v), want (%v, %v)",
			found["line"], found["column"], wantLine, wantColumn)
	}
	if msg := found["message"].(string); !strings.Contains(msg, "invalid JSON at line") {
		t.Errorf("broken.json diagnostic message = %q, want it to carry the position in the text too", msg)
	}
}

// TestServe_GenerateNamingAFileThatFailedToLoad pins the other half: asking for the feature that
// unreadable file declares must say so. It used to answer "not defined by the loaded pack (1
// feature(s) loaded, 1 built successfully)" -- a confident, false statement about an identifier
// the author can read in the file in front of them.
func TestServe_GenerateNamingAFileThatFailedToLoad(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "good.json"), singleBlockFeatureJSON("test:good", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "broken.json"), truncatedFeatureJSON)

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		`{"id":2,"method":"generate","params":{"feature":"test:broken","env":"void","omitCatalogs":true}}`)
	if len(resps) != 2 || resps[1].Error != nil {
		t.Fatalf("generate responses = %+v", resps)
	}

	var runDiags []map[string]any
	for _, d := range diagnosticsOf(t, resps[1].Result) {
		if d["scope"] == session.ScopeRun {
			runDiags = append(runDiags, d)
		}
	}
	if len(runDiags) != 1 {
		t.Fatalf("run-scoped diagnostics = %+v, want exactly the one explaining this run", runDiags)
	}
	msg := runDiags[0]["message"].(string)
	if runDiags[0]["level"] != "error" {
		t.Errorf("run diagnostic level = %v, want error", runDiags[0]["level"])
	}
	for _, want := range []string{"test:broken", "broken.json", "could not be loaded"} {
		if !strings.Contains(msg, want) {
			t.Errorf("run diagnostic message = %q, want it to mention %q", msg, want)
		}
	}
	if strings.Contains(msg, "is not defined by the loaded pack") {
		t.Errorf("run diagnostic still claims the feature is undefined: %q", msg)
	}
}

// TestServe_DiagnosticScopeSeparatesPackFromRun is the scope field's reason for existing: a
// preview of a perfectly healthy feature still carries every other file's build warnings, and
// without a scope a client cannot tell those from the one or two diagnostics that are about the
// run it just asked for.
func TestServe_DiagnosticScopeSeparatesPackFromRun(t *testing.T) {
	root := t.TempDir()
	// A feature that places nothing (its own file is fine) plus an unrelated broken file, so
	// the response is guaranteed to carry one of each scope.
	writeTestFile(t, filepath.Join(root, "features", "good.json"), singleBlockFeatureJSON("test:good", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "broken.json"), truncatedFeatureJSON)

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		// An environment id that no biome file declares: a run-scoped error, raised by this
		// call's own config and by nothing in the pack.
		`{"id":2,"method":"generate","params":{"feature":"test:good","env":"void","biomeId":"test:nope","omitCatalogs":true}}`)
	if len(resps) != 2 || resps[1].Error != nil {
		t.Fatalf("generate responses = %+v", resps)
	}

	byScope := map[string][]string{}
	for _, d := range diagnosticsOf(t, resps[1].Result) {
		scope, ok := d["scope"].(string)
		if !ok || (scope != session.ScopePack && scope != session.ScopeRun) {
			t.Fatalf("diagnostic has no usable scope: %+v", d)
		}
		byScope[scope] = append(byScope[scope], d["fileId"].(string))
	}
	if len(byScope[session.ScopePack]) == 0 {
		t.Error("no pack-scoped diagnostic; the broken file should be reported as a pack problem")
	}
	if len(byScope[session.ScopeRun]) == 0 {
		t.Error("no run-scoped diagnostic; the unknown biome id should be reported as this run's problem")
	}
	// The pack-scoped half is exactly what a loadPack of the same pack reports -- same
	// diagnostics, same scope -- so a client can keep one durable "pack problems" list from
	// the load and never have to re-derive it from a generate.
	loadDiags := diagnosticsOf(t, resps[0].Result)
	if len(loadDiags) != len(byScope[session.ScopePack]) {
		t.Errorf("loadPack reported %d diagnostics, generate's pack-scoped half has %d -- the two must agree",
			len(loadDiags), len(byScope[session.ScopePack]))
	}
	for _, d := range loadDiags {
		if d["scope"] != session.ScopePack {
			t.Errorf("loadPack diagnostic is not pack-scoped: %+v", d)
		}
	}
}

// TestServe_LoadPackResultIsAdditiveOnTheWire pins the fields a client may rely on, including
// that the new ones are ADDED rather than replacing anything: an older client reading only the
// four counts keeps working against this response.
func TestServe_LoadPackResultIsAdditiveOnTheWire(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "good.json"), singleBlockFeatureJSON("test:good", "minecraft:diamond_block"))

	resps := runLines(t, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root))
	raw, err := json.Marshal(resps[0].Result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"warnings", "featureCount", "structureCount", "ruleCount", "biomeCount", "fileCounts", "diagnostics"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("loadPack result is missing %q; got keys %v", key, decoded)
		}
	}
}
