package rptex

// terrain_test.go covers the two things a terrain_texture.json reader owes a
// pack author: every shape the file is written in is understood, and an entry
// that is not understood costs that entry and nothing else.
//
// The second half is the bug this file was written for. A resource pack using
// "variations" -- the perfectly ordinary way to give one block several random
// textures -- hit parseVariant's "unrecognised textures shape", which failed
// LoadTerrain, which failed the whole build: not one texture from the pack
// loaded, and nothing said why.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// terrainFile writes body as a terrain_texture.json in a temp directory and
// parses it.
func terrainFile(t *testing.T, body string) *Terrain {
	t.Helper()
	path := filepath.Join(t.TempDir(), "terrain_texture.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	terrain, err := LoadTerrain(path)
	if err != nil {
		t.Fatalf("LoadTerrain: %v", err)
	}
	return terrain
}

// TestLoadTerrain_EveryTexturesShape walks the five spellings a real pack uses
// for one texture key, in one file, and asserts each reaches the same place.
// They are one test because the point is that they COEXIST: a pack mixes them
// freely, and a reader that takes each only in isolation is no use.
func TestLoadTerrain_EveryTexturesShape(t *testing.T) {
	terrain := terrainFile(t, `{
		"texture_data": {
			"bare_string":   {"textures": "textures/blocks/stone"},
			"string_array":  {"textures": ["textures/blocks/stone", "textures/blocks/granite"]},
			"object":        {"textures": {"path": "textures/blocks/grass_side", "overlay_color": "#79c05a"}},
			"object_array":  {"textures": [{"path": "textures/blocks/leaves"}, {"path": "textures/blocks/leaves_opaque"}]},
			"variations":    {"textures": [{"variations": [
				{"path": "textures/blocks/custom_0", "weight": 1},
				{"path": "textures/blocks/custom_1", "weight": 1},
				{"path": "textures/blocks/custom_2", "weight": 1}]}]},
			"bare_variations": {"textures": {"variations": [
				{"path": "textures/blocks/bare_0", "weight": 3},
				{"path": "textures/blocks/bare_1", "weight": 1}]}},
			"string_variations": {"textures": [{"variations": ["textures/blocks/plain_0", "textures/blocks/plain_1"]}]},
			"tinted_variations": {"textures": [{"overlay_color": "#79c05a", "variations": [
				{"path": "textures/blocks/tinted_0", "weight": 1}]}]}
		}
	}`)
	if len(terrain.Skipped) != 0 {
		t.Fatalf("Skipped = %v, want none: every shape here is one real packs write", terrain.Skipped)
	}

	first := func(key string) Variant {
		t.Helper()
		vs, ok := terrain.Keys[key]
		if !ok {
			t.Fatalf("texture key %q is missing", key)
		}
		if len(vs) == 0 {
			t.Fatalf("texture key %q has no variants: every consumer indexes [0] unconditionally", key)
		}
		return vs[0]
	}

	for key, want := range map[string]string{
		"bare_string":       "textures/blocks/stone",
		"string_array":      "textures/blocks/stone",
		"object":            "textures/blocks/grass_side",
		"object_array":      "textures/blocks/leaves",
		"variations":        "textures/blocks/custom_0",
		"bare_variations":   "textures/blocks/bare_0",
		"string_variations": "textures/blocks/plain_0",
		"tinted_variations": "textures/blocks/tinted_0",
	} {
		if got := first(key).Path; got != want {
			t.Errorf("%s first path = %q, want %q", key, got, want)
		}
	}

	// The legacy per-data-value list keeps all of its entries; a variations
	// list is pinned to its first and the rest are not represented, because the
	// choice the engine makes between them is per PLACED BLOCK and there is
	// nowhere in a preview to put it.
	if got := len(terrain.Keys["string_array"]); got != 2 {
		t.Errorf("string_array kept %d variants, want both", got)
	}
	if got := len(terrain.Keys["variations"]); got != 1 {
		t.Errorf("variations kept %d variants, want exactly the pinned first", got)
	}

	if v := first("object"); v.Overlay == nil || v.Overlay.Hex() != "#79c05a" {
		t.Errorf("object overlay = %v, want the declared #79c05a", v.Overlay)
	}
	if v := first("tinted_variations"); v.Overlay == nil || v.Overlay.Hex() != "#79c05a" {
		t.Errorf("an overlay_color beside a variations list applies to the picked variation; got %v", v.Overlay)
	}
	if v := first("variations"); v.Overlay != nil {
		t.Errorf("variations overlay = %v, want none: the entry declared no overlay_color", v.Overlay)
	}
}

// TestLoadTerrain_VariationsAreDeterministic: the same file read twice must
// name the same texture. The engine rolls a weighted die per placed block; a
// preview that rolled one too would show its own randomness as though it were
// the pack, and no two screenshots of the same world would match.
func TestLoadTerrain_VariationsAreDeterministic(t *testing.T) {
	const body = `{"texture_data":{"k":{"textures":[{"variations":[
		{"path":"a","weight":1},{"path":"b","weight":99},{"path":"c","weight":1}]}]}}}`
	for i := 0; i < 8; i++ {
		terrain := terrainFile(t, body)
		if got := terrain.Keys["k"][0].Path; got != "a" {
			t.Fatalf("read %d picked %q, want the first variation every time regardless of weight", i, got)
		}
	}
}

// TestLoadTerrain_OneBadEntryDoesNotFailTheFile is the reported bug, reduced:
// one entry this reader does not take, surrounded by entries it does. Before,
// the first bad entry returned an error from LoadTerrain and the pack rendered
// with no textures at all.
func TestLoadTerrain_OneBadEntryDoesNotFailTheFile(t *testing.T) {
	terrain := terrainFile(t, `{
		"texture_data": {
			"good_before":  {"textures": "textures/blocks/stone"},
			"nonsense":     {"textures": 17},
			"empty_array":  {"textures": []},
			"no_textures":  {"other": "textures/blocks/x"},
			"not_an_object": "textures/blocks/x",
			"good_after":   {"textures": [{"variations": [{"path": "textures/blocks/y", "weight": 1}]}]}
		}
	}`)
	for _, key := range []string{"good_before", "good_after"} {
		if _, ok := terrain.Keys[key]; !ok {
			t.Errorf("texture key %q was lost to an unrelated entry's problem", key)
		}
	}
	for _, key := range []string{"nonsense", "empty_array", "no_textures", "not_an_object"} {
		if _, ok := terrain.Keys[key]; ok {
			t.Errorf("texture key %q parsed, but nothing here yields a path", key)
		}
		reason, ok := terrain.Skipped[key]
		if !ok || strings.TrimSpace(reason) == "" {
			t.Errorf("texture key %q was dropped with no reason recorded; the author is left guessing", key)
		}
	}
	if got := terrain.Skipped["no_textures"]; !strings.Contains(got, "textures") {
		t.Errorf("reason for a missing \"textures\" = %q, want it to name what is missing", got)
	}
}

// TestLoadTerrain_VariationsFailuresAreReported: the ways a variations list can
// be written that yield no path at all. Each must come back as a named skip --
// not a panic, not an empty variant slice that the first consumer to index [0]
// turns into one.
func TestLoadTerrain_VariationsFailuresAreReported(t *testing.T) {
	cases := map[string]struct{ body, want string }{
		"first entry has no path": {
			`{"texture_data":{"k":{"textures":[{"variations":[{"weight":1},{"path":"b","weight":1}]}]}}}`,
			"first \"variations\" entry",
		},
		"empty list": {
			`{"texture_data":{"k":{"textures":[{"variations":[]}]}}}`,
			"empty \"variations\" list",
		},
		"nested past the bound": {
			`{"texture_data":{"k":{"textures":[{"variations":[{"variations":[{"variations":[{"variations":[{"variations":[{"path":"a"}]}]}]}]}]}]}}}`,
			"nested more than",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			terrain := terrainFile(t, tc.body)
			if vs, ok := terrain.Keys["k"]; ok {
				t.Fatalf("key parsed to %+v, want it skipped: there is no path in it to draw", vs)
			}
			got := terrain.Skipped["k"]
			if !strings.Contains(got, tc.want) {
				t.Errorf("reason = %q, want it to mention %q", got, tc.want)
			}
		})
	}
}

// TestLoadTerrain_ArrayKeepsWhatItCan: one unreadable entry inside an array is
// dropped and its siblings survive, for the same reason one unreadable key does
// not fail the file.
func TestLoadTerrain_ArrayKeepsWhatItCan(t *testing.T) {
	terrain := terrainFile(t, `{"texture_data":{"k":{"textures":[
		{"path":"textures/blocks/a"}, 17, {"variations":[{"path":"textures/blocks/c","weight":1}]}]}}}`)
	vs, ok := terrain.Keys["k"]
	if !ok {
		t.Fatal("the key was dropped entirely over one bad array entry")
	}
	if len(vs) != 2 || vs[0].Path != "textures/blocks/a" || vs[1].Path != "textures/blocks/c" {
		t.Errorf("variants = %+v, want the two readable entries in file order", vs)
	}
}

// TestLoadTerrain_StillFailsOnAnUnusableFile: resilience is per ENTRY. A file
// that is not JSON is a different report, and swallowing it would leave an
// author with a typo in their braces staring at a pack with no textures and no
// message at all.
func TestLoadTerrain_StillFailsOnAnUnusableFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "terrain_texture.json")
	if err := os.WriteFile(path, []byte(`{"texture_data": {`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := LoadTerrain(path); err == nil {
		t.Fatal("LoadTerrain accepted truncated JSON; a broken file must still be reported as one")
	}
}
