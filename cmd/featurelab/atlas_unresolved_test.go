package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/wire"
)

// writeFakeAtlas puts the two files an atlas is made of, plus the build marker that records what
// could not be textured, into dir -- the layout wire.LoadAtlas reads and blocktextures writes.
func writeFakeAtlas(t *testing.T, dir string, marker string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(dir, wire.AtlasTableFile), `{"version":1,"blocks":{}}`)
	writeTestFile(t, filepath.Join(dir, wire.AtlasImageFile), "not really a png")
	if marker != "" {
		writeTestFile(t, filepath.Join(dir, ".featurelab-atlas.json"), marker)
	}
}

func atlasResponse(t *testing.T, dir string) *wire.AtlasOutput {
	t.Helper()
	raw, err := json.Marshal(atlasParams{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	out, err := methodAtlas(raw)
	if err != nil {
		t.Fatalf("methodAtlas: %v", err)
	}
	got, ok := out.(*wire.AtlasOutput)
	if !ok {
		t.Fatalf("methodAtlas returned %T, want *wire.AtlasOutput", out)
	}
	return got
}

// The preview can now say WHY a block draws as a flat colour; this is the data reaching it.
func TestMethodAtlas_CarriesTheUnresolvedRowsAndTheTotal(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "atlas")
	writeFakeAtlas(t, dir, `{
  "version": 1,
  "blocks": 1,
  "unresolvedTotal": 24,
  "unresolved": [
    {"block":"wiki:glow_moss","face":"up","texture":"glow_moss","reason":"texture key \"glow_moss\" is not declared in the resource pack's terrain_texture.json","code":"key-not-declared"},
    {"block":"wiki:runestone","face":"side","texture":"runestone","reason":"no image","code":"image-missing"}
  ],
  "note": "x"
}`)
	got := atlasResponse(t, dir)
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
}

// Additive and omitted when empty: an atlas that textured everything carries neither key, so a
// client written before these existed decodes exactly what it always did.
func TestMethodAtlas_OmitsBothKeysWhenNothingIsUnresolved(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "atlas")
	writeFakeAtlas(t, dir, `{"version":1,"blocks":1,"note":"x"}`)
	got := atlasResponse(t, dir)
	if len(got.Unresolved) != 0 || got.UnresolvedTotal != 0 {
		t.Fatalf("got %+v, want nothing", got.Unresolved)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, has := decoded["unresolved"]; has {
		t.Errorf("payload carries an empty \"unresolved\": %s", raw)
	}
	if _, has := decoded["unresolvedTotal"]; has {
		t.Errorf("payload carries a zero \"unresolvedTotal\": %s", raw)
	}
}

// An atlas built before this was recorded has no marker at all. That must not change the atlas
// it delivers: this is extra information about a preview, never a reason a preview has no
// textures.
func TestMethodAtlas_AtlasWithNoMarkerStillDelivers(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "atlas")
	writeFakeAtlas(t, dir, "")
	got := atlasResponse(t, dir)
	if got.PNG == "" || len(got.Table) == 0 {
		t.Errorf("the atlas did not come back without a marker beside it")
	}
	if len(got.Unresolved) != 0 {
		t.Errorf("Unresolved = %+v, want nothing", got.Unresolved)
	}
}

func TestMethodAtlas_UnreadableMarkerIsSilent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "atlas")
	writeFakeAtlas(t, dir, "{ this is not json")
	got := atlasResponse(t, dir)
	if got.PNG == "" {
		t.Errorf("the atlas did not come back past an unreadable marker")
	}
	if len(got.Unresolved) != 0 || got.UnresolvedTotal != 0 {
		t.Errorf("got %+v / %d, want nothing", got.Unresolved, got.UnresolvedTotal)
	}
}

// No atlas at all remains an error response, as it always was -- a client's recovery is the same
// (stay in flat-colour mode) and turning it into a result would change what every existing
// client sees for the commonest state a machine is in.
func TestMethodAtlas_NoAtlasIsStillAnError(t *testing.T) {
	raw, err := json.Marshal(atlasParams{Dir: filepath.Join(t.TempDir(), "nothing-here")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := methodAtlas(raw); err == nil {
		t.Fatal("expected an error when no atlas has been built")
	}
}
