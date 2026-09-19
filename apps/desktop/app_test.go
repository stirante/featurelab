// app_test.go covers App's own bound-method surface (LoadPack/Generate/ListEnvironments) --
// the buildConfig/RunGenerate/ParseOrigin/ParseSize logic those methods delegate to now lives
// in, and is tested by, featurelab-go/wire (see that package's wire_test.go), since app.go no
// longer duplicates it (see app.go's Generate doc comment).
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/wire"
)

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func singleBlockFeatureJSON(identifier, placesBlock string) string {
	return `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"` +
		identifier + `"},"places_block":"` + placesBlock + `"}}`
}

// TestApp_LoadPackThenGenerate exercises the actual bound-method path a Wails frontend call
// drives (App.LoadPack then App.Generate), not just the wire.RunGenerate helper underneath it --
// this is what proves the "one loaded pack, reused across regenerate calls" wiring the app's
// own header comment describes actually holds together, in-process, with no featurelab binary
// involved.
func TestApp_LoadPackThenGenerate(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	app := NewApp()
	t.Cleanup(func() { app.shutdown(nil) }) // shutdown ignores its ctx param, nil is safe here

	loadResult, err := app.LoadPack(root)
	if err != nil {
		t.Fatalf("App.LoadPack: %v", err)
	}
	if loadResult.Dir != root {
		t.Errorf("LoadPackResult.Dir = %q, want %q", loadResult.Dir, root)
	}
	if len(loadResult.Items) != 1 || loadResult.Items[0].Identifier != "test:place_diamond" {
		t.Fatalf("LoadPackResult.Items = %+v, want exactly one item for test:place_diamond", loadResult.Items)
	}

	// App.Generate returns an already-JSON-encoded string (see app.go's Generate doc comment
	// for why) -- this is the specific contract the desktop frontend's main.ts relies on
	// (JSON.parse before decodeGenerateResult), proven here from the Go side.
	rawJSON, err := app.Generate(wire.GenerateParams{Feature: "test:place_diamond", Env: "void"})
	if err != nil {
		t.Fatalf("App.Generate: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(rawJSON), &decoded); err != nil {
		t.Fatalf("App.Generate did not return valid JSON: %v\nraw: %s", err, rawJSON)
	}
	if decoded["blocksPlaced"] != float64(1) {
		t.Errorf("blocksPlaced = %v, want 1", decoded["blocksPlaced"])
	}
	for _, k := range []string{"bounds", "blocks", "baseline", "palette", "changed", "removed"} {
		if _, ok := decoded[k]; !ok {
			t.Errorf("App.Generate's JSON missing key %q", k)
		}
	}
}

func TestApp_GenerateWithoutLoadPackFails(t *testing.T) {
	app := NewApp()
	t.Cleanup(func() { app.shutdown(nil) })
	if _, err := app.Generate(wire.GenerateParams{Feature: "test:whatever", Env: "void"}); err == nil {
		t.Error("expected an error calling Generate before any pack was loaded")
	}
}

// scatterFeatureFixedOffsetJSON builds a minecraft:scatter_feature body that places exactly
// once, at a FIXED (non-random) offset from origin -- see wire/grow_test.go's own copy of this
// helper for the full rationale; duplicated here rather than exported cross-package since it is
// a small, self-contained test fixture.
func scatterFeatureFixedOffsetJSON(identifier, placesFeature string, dx, dy, dz int) string {
	return `{"format_version":"1.21.110","minecraft:scatter_feature":{"description":{"identifier":"` + identifier +
		`"},"places_feature":"` + placesFeature + `","distribution":{"iterations":1,"x":` + itoaApp(dx) + `,"y":` + itoaApp(dy) + `,"z":` + itoaApp(dz) + `}}}`
}

func itoaApp(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// TestApp_GenerateGrown exercises the bound App.GenerateGrown method end to end: a scatter
// feature placing a fixed offset outside a small bench captures that write on a plain
// App.Generate call, and App.GenerateGrown reports grown:true plus a bench that actually
// contains it -- the same proof wire/grow_test.go gives at the wire-package level, here through
// the exact bound method a Wails frontend calls.
func TestApp_GenerateGrown(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "leaf.json"), singleBlockFeatureJSON("test:leaf", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "root.json"), scatterFeatureFixedOffsetJSON("test:root", "test:leaf", 100, 0, 0))

	app := NewApp()
	t.Cleanup(func() { app.shutdown(nil) })
	if _, err := app.LoadPack(root); err != nil {
		t.Fatalf("App.LoadPack: %v", err)
	}

	params := wire.GenerateParams{Feature: "test:root", Env: "void", Origin: "0,0,0", Size: "8x8x8"}

	plainRaw, err := app.Generate(params)
	if err != nil {
		t.Fatalf("App.Generate: %v", err)
	}
	var plain map[string]any
	if err := json.Unmarshal([]byte(plainRaw), &plain); err != nil {
		t.Fatalf("App.Generate did not return valid JSON: %v", err)
	}
	if plain["writesOutOfBounds"] != float64(1) {
		t.Fatalf("plain App.Generate writesOutOfBounds = %v, want 1", plain["writesOutOfBounds"])
	}
	if _, ok := plain["grown"]; ok {
		t.Errorf("plain App.Generate output should not carry a \"grown\" key, got %v", plain["grown"])
	}

	grownRaw, err := app.GenerateGrown(params)
	if err != nil {
		t.Fatalf("App.GenerateGrown: %v", err)
	}
	var grown map[string]any
	if err := json.Unmarshal([]byte(grownRaw), &grown); err != nil {
		t.Fatalf("App.GenerateGrown did not return valid JSON: %v\nraw: %s", err, grownRaw)
	}
	if grown["grown"] != true {
		t.Errorf("App.GenerateGrown grown = %v, want true", grown["grown"])
	}
	if grown["preGrowBounds"] == nil {
		t.Error("App.GenerateGrown preGrowBounds should be present when grown is true")
	}
	if grown["writesOutOfBounds"] != float64(0) {
		t.Errorf("App.GenerateGrown writesOutOfBounds = %v, want 0 (the grown bench contains the write)", grown["writesOutOfBounds"])
	}
}

func TestApp_GenerateGrownWithoutLoadPackFails(t *testing.T) {
	app := NewApp()
	t.Cleanup(func() { app.shutdown(nil) })
	if _, err := app.GenerateGrown(wire.GenerateParams{Feature: "test:whatever", Env: "void"}); err == nil {
		t.Error("expected an error calling GenerateGrown before any pack was loaded")
	}
}

// TestApp_GenerateDiagnosticsSpellFilesPackRelative pins the one thing App.Generate stamps on
// its params that the frontend cannot: session.Config.PackDir, by way of wire.GenerateParams.
//
// Without it a preview diagnostic named the loader's kind-relative id ("broken.json") while
// `featurelab check`, the graph canvas and the VS Code preview all named the same file
// "features/broken.json" -- one file, two spellings, in the one host whose entire window is a
// preview. Asserted on the "/" in the id rather than on the message, because the message is
// prose and the path is the contract.
func TestApp_GenerateDiagnosticsSpellFilesPackRelative(t *testing.T) {
	root := t.TempDir()
	// A structure_name nothing defines: raises a pack-scoped diagnostic against the feature
	// file, which is exactly the shape whose fileId this test is about.
	writeTestFile(t, filepath.Join(root, "features", "broken.json"),
		`{"format_version":"1.21.110","minecraft:structure_template_feature":{"description":{"identifier":"test:broken"},`+
			`"structure_name":"test:nothing_defines_this","adjustment_radius":0,"facing_direction":"north","constraints":{}}}`)

	app := NewApp()
	t.Cleanup(func() { app.shutdown(nil) })
	if _, err := app.LoadPack(root); err != nil {
		t.Fatalf("App.LoadPack: %v", err)
	}

	for _, tc := range []struct {
		name string
		run  func(wire.GenerateParams) (string, error)
	}{
		{"Generate", app.Generate},
		{"GenerateGrown", app.GenerateGrown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := tc.run(wire.GenerateParams{Feature: "test:broken", Env: "void"})
			if err != nil {
				t.Fatalf("App.%s: %v", tc.name, err)
			}
			var decoded struct {
				Diagnostics []struct {
					FileID string `json:"fileId"`
				} `json:"diagnostics"`
			}
			if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
				t.Fatalf("App.%s did not return valid JSON: %v", tc.name, err)
			}
			var found bool
			for _, d := range decoded.Diagnostics {
				if d.FileID == "features/broken.json" {
					found = true
				}
				if d.FileID == "broken.json" {
					t.Errorf("diagnostic fileId = %q -- the kind-relative spelling means PackDir was never stamped on the params", d.FileID)
				}
			}
			if !found {
				t.Errorf("no diagnostic spelled \"features/broken.json\"; got %+v", decoded.Diagnostics)
			}
		})
	}
}

// TestApp_LoadPackDoesNotWarnAboutConventionalDirectoriesAPackSimplyLacks pins the levelling
// packWarnings does. The pack below has features/ and nothing else, which is a perfectly normal
// pack; every notice pack.Load raises about it is the informational kind, so the toolbar's
// warning banner must stay down. Before this, opening it painted a warning saying the pack was
// fine as it is.
func TestApp_LoadPackDoesNotWarnAboutConventionalDirectoriesAPackSimplyLacks(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	app := NewApp()
	t.Cleanup(func() { app.shutdown(nil) })
	result, err := app.LoadPack(root)
	if err != nil {
		t.Fatalf("App.LoadPack: %v", err)
	}
	if len(result.Warnings) != 0 {
		t.Errorf("LoadPackResult.Warnings = %q, want none for a pack that merely has no structures/feature_rules/biomes/blocks", result.Warnings)
	}
	if result.Warnings == nil {
		t.Error("LoadPackResult.Warnings must marshal as [] rather than null -- the frontend reads .length off it")
	}
}

func TestApp_ListEnvironments(t *testing.T) {
	app := NewApp()
	envs := app.ListEnvironments()
	if len(envs) == 0 {
		t.Fatal("expected at least one environment preset")
	}
	found := false
	for _, e := range envs {
		if e.ID == "plains" {
			found = true
			if e.DefaultSizeX == 0 || e.DefaultSizeY == 0 || e.DefaultSizeZ == 0 {
				t.Errorf("plains preset has a zero default size: %+v", e)
			}
		}
	}
	if !found {
		t.Error("expected \"plains\" among the listed environments")
	}
}
