package main

// atlas_test.go covers App.LoadAtlas -- the desktop app's own way of getting the block-texture
// atlas, a Wails binding straight onto wire.LoadAtlas rather than a `serve` JSON-RPC call.
//
// The subject is the thing that made the two paths differ. "Which blocks could not be textured,
// and why" used to be attached by `serve`'s atlas method, so the preview in VS Code could say
// why a block draws as a flat colour and the preview in THIS app -- which is the whole window
// -- could not. Same atlas, same directory, same marker sitting in it, two different answers.
// It is read by wire.LoadAtlas now, so the two are one answer by construction; these tests are
// what keeps them that way.

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/wire"
)

// writeFakeAtlas puts the two files an atlas is made of, plus the build marker recording what
// could not be textured, into dir -- the layout wire.LoadAtlas reads and blocktextures writes.
// The same fixture cmd/featurelab's own atlas tests build, deliberately: the point of these
// tests is that the two hosts read one directory the same way.
func writeFakeAtlas(t *testing.T, dir, marker string) {
	t.Helper()
	writeTestFile(t, filepath.Join(dir, wire.AtlasTableFile), `{"version":1,"blocks":{}}`)
	writeTestFile(t, filepath.Join(dir, wire.AtlasImageFile), "not really a png")
	if marker != "" {
		writeTestFile(t, filepath.Join(dir, wire.AtlasMarkerFile), marker)
	}
}

const unresolvedMarker = `{
  "version": 1,
  "blocks": 1,
  "unresolvedTotal": 24,
  "unresolved": [
    {"block":"wiki:glow_moss","face":"up","texture":"glow_moss","reason":"texture key \"glow_moss\" is not declared in the resource pack's terrain_texture.json","code":"key-not-declared"},
    {"block":"wiki:runestone","face":"side","texture":"runestone","reason":"no image","code":"image-missing"}
  ],
  "note": "x"
}`

// loadAtlasJSON drives the bound method exactly as a Wails frontend call does -- App.LoadAtlas
// returns already-encoded JSON (see its doc comment) -- and decodes the envelope back.
func loadAtlasJSON(t *testing.T, dir string) *wire.AtlasOutput {
	t.Helper()
	t.Setenv(wire.AtlasEnvVar, dir)
	raw, err := NewApp().LoadAtlas()
	if err != nil {
		t.Fatalf("App.LoadAtlas: %v", err)
	}
	var got wire.AtlasOutput
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("App.LoadAtlas returned JSON that does not decode: %v; %s", err, raw)
	}
	return &got
}

// TestApp_LoadAtlasCarriesTheSameUnresolvedRowsTheServePathDoes is the gap, asserted from the
// side the desktop user sees it from: the app could not say why a block draws flat, because the
// only code that attached those rows lived in `serve`.
//
// The comparison is against wire.LoadAtlas itself rather than against a hand-written expected
// value, because wire.LoadAtlas IS the serve path -- cmd/featurelab's atlas method returns its
// output unchanged (see cmd/featurelab/atlas.go). Encoding both and comparing the bytes catches
// a field that reaches one host and not the other, which is exactly what went wrong before.
func TestApp_LoadAtlasCarriesTheSameUnresolvedRowsTheServePathDoes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "atlas")
	writeFakeAtlas(t, dir, unresolvedMarker)

	got := loadAtlasJSON(t, dir)
	if got.UnresolvedTotal != 24 {
		t.Errorf("UnresolvedTotal = %d, want 24 -- the real count, not len(Unresolved)", got.UnresolvedTotal)
	}
	if len(got.Unresolved) != 2 {
		t.Fatalf("Unresolved = %+v, want the two sample rows", got.Unresolved)
	}
	first := got.Unresolved[0]
	if first.Block != "wiki:glow_moss" || first.Face != "up" || first.Texture != "glow_moss" {
		t.Errorf("row = %+v", first)
	}
	if first.Code != "key-not-declared" {
		t.Errorf("Code = %q, want the short token a host can group on", first.Code)
	}
	if first.Reason == "" {
		t.Errorf("Reason = %q, want the sentence kept beside the code", first.Reason)
	}
	// The atlas itself is still delivered, unchanged.
	if got.PNG == "" || len(got.Table) == 0 {
		t.Errorf("the atlas itself did not come back: png=%d table=%d", len(got.PNG), len(got.Table))
	}

	serve, err := wire.LoadAtlas(dir)
	if err != nil {
		t.Fatalf("wire.LoadAtlas: %v", err)
	}
	mine, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := json.Marshal(serve)
	if err != nil {
		t.Fatal(err)
	}
	if string(mine) != string(theirs) {
		t.Errorf("the desktop binding and the serve path answer differently for one atlas:\n desktop: %s\n serve:   %s", mine, theirs)
	}
}

// Additive and omitted when empty: an atlas that textured everything carries neither key, so
// frontend/src/protocol.ts's decodeAtlas -- written before these existed -- decodes exactly what
// it always did.
func TestApp_LoadAtlasOmitsBothKeysWhenNothingIsUnresolved(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "atlas")
	writeFakeAtlas(t, dir, `{"version":1,"blocks":1,"note":"x"}`)

	t.Setenv(wire.AtlasEnvVar, dir)
	raw, err := NewApp().LoadAtlas()
	if err != nil {
		t.Fatalf("App.LoadAtlas: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatal(err)
	}
	if _, has := decoded["unresolved"]; has {
		t.Errorf("payload carries an empty \"unresolved\": %s", raw)
	}
	if _, has := decoded["unresolvedTotal"]; has {
		t.Errorf("payload carries a zero \"unresolvedTotal\": %s", raw)
	}
}

// An atlas built before this was recorded has no marker at all, and a half-written one cannot be
// parsed. Neither may change the atlas delivered: this is extra information about a preview, and
// must never be the reason a preview has no textures.
func TestApp_LoadAtlasStillDeliversWithoutAReadableMarker(t *testing.T) {
	for _, tc := range []struct{ name, marker string }{
		{"no marker", ""},
		{"unreadable marker", "{ this is not json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "atlas")
			writeFakeAtlas(t, dir, tc.marker)
			got := loadAtlasJSON(t, dir)
			if got.PNG == "" || len(got.Table) == 0 {
				t.Errorf("the atlas did not come back: png=%d table=%d", len(got.PNG), len(got.Table))
			}
			if len(got.Unresolved) != 0 || got.UnresolvedTotal != 0 {
				t.Errorf("got %+v / %d, want nothing", got.Unresolved, got.UnresolvedTotal)
			}
		})
	}
}

// No atlas at all stays an error, which is the state every machine starts in: the frontend's
// recovery is to stay on flat block colours, and it needs the rejected promise to say so once.
func TestApp_LoadAtlasWithNoAtlasIsStillAnError(t *testing.T) {
	t.Setenv(wire.AtlasEnvVar, filepath.Join(t.TempDir(), "nothing-here"))
	if _, err := NewApp().LoadAtlas(); err == nil {
		t.Fatal("expected an error when no atlas has been built")
	}
}
