package wire

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeAtlas writes a minimal, self-made pair of atlas files into a temp dir. The PNG bytes are
// not a real PNG and do not need to be: this package delivers the image, it never decodes one,
// and nothing here may ship a byte of Mojang's texture data.
func writeAtlas(t *testing.T, table string, image []byte) string {
	t.Helper()
	dir := t.TempDir()
	if table != "" {
		if err := os.WriteFile(filepath.Join(dir, AtlasTableFile), []byte(table), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if image != nil {
		if err := os.WriteFile(filepath.Join(dir, AtlasImageFile), image, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLoadAtlasReturnsTableVerbatimAndImageBase64(t *testing.T) {
	const table = `{"version":1,"cell":16,"cols":2,"rows":1}`
	image := []byte{0x89, 'P', 'N', 'G', 0x00, 0x01, 0x02}
	dir := writeAtlas(t, table, image)

	out, err := LoadAtlas(dir)
	if err != nil {
		t.Fatalf("LoadAtlas: %v", err)
	}
	// Verbatim: this package does not reshape the table on the way past, so a field it has
	// never heard of reaches the renderer untouched.
	if string(out.Table) != table {
		t.Errorf("table = %q, want %q", string(out.Table), table)
	}
	decoded, err := base64.StdEncoding.DecodeString(out.PNG)
	if err != nil {
		t.Fatalf("png is not valid base64: %v", err)
	}
	if string(decoded) != string(image) {
		t.Errorf("png round-tripped to %v, want %v", decoded, image)
	}
}

func TestLoadAtlasReportsAMissingAtlasAsErrNoAtlas(t *testing.T) {
	// The state every machine starts in. A caller distinguishes this from a broken atlas so it
	// can stay quiet about the former and say something about the latter.
	if _, err := LoadAtlas(filepath.Join(t.TempDir(), "nothing-here")); !errors.Is(err, ErrNoAtlas) {
		t.Errorf("err = %v, want ErrNoAtlas", err)
	}
}

func TestLoadAtlasReportsAHalfWrittenAtlasAsErrNoAtlasNamingTheMissingFile(t *testing.T) {
	dir := writeAtlas(t, `{"version":1}`, nil)
	_, err := LoadAtlas(dir)
	if !errors.Is(err, ErrNoAtlas) {
		t.Fatalf("err = %v, want ErrNoAtlas", err)
	}
	if !strings.Contains(err.Error(), AtlasImageFile) {
		t.Errorf("err = %q, want it to name %s", err, AtlasImageFile)
	}
}

func TestLoadAtlasRefusesATableThatIsNotJSON(t *testing.T) {
	// Catching this here names the file. Letting it through would surface as an unexplained
	// parse failure inside a webview, several layers from the truncated write that caused it.
	dir := writeAtlas(t, "{not json", []byte("x"))
	_, err := LoadAtlas(dir)
	if err == nil || errors.Is(err, ErrNoAtlas) {
		t.Fatalf("err = %v, want a non-ErrNoAtlas error", err)
	}
	if !strings.Contains(err.Error(), AtlasTableFile) {
		t.Errorf("err = %q, want it to name %s", err, AtlasTableFile)
	}
}

func TestAtlasDirPrefersTheEnvironmentOverride(t *testing.T) {
	t.Setenv(AtlasEnvVar, filepath.Join("somewhere", "else"))
	got, err := AtlasDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join("somewhere", "else") {
		t.Errorf("AtlasDir() = %q, want the override", got)
	}
}

func TestAtlasDirFallsBackToTheUserCacheDirectory(t *testing.T) {
	t.Setenv(AtlasEnvVar, "")
	got, err := AtlasDir()
	if err != nil {
		t.Skipf("no user cache directory on this machine: %v", err)
	}
	// Never inside the repository and never inside a pack -- the atlas is derived from Mojang's
	// assets and belongs in the same per-user cache the assets themselves are fetched into.
	if filepath.Base(got) != "atlas" || filepath.Base(filepath.Dir(got)) != "featurelab" {
		t.Errorf("AtlasDir() = %q, want it to end in featurelab/atlas", got)
	}
}

func TestLoadAtlasWithAnEmptyDirUsesAtlasDir(t *testing.T) {
	const table = `{"version":1}`
	dir := writeAtlas(t, table, []byte("x"))
	t.Setenv(AtlasEnvVar, dir)
	out, err := LoadAtlas("")
	if err != nil {
		t.Fatalf("LoadAtlas(\"\"): %v", err)
	}
	if string(out.Table) != table {
		t.Errorf("table = %q, want %q", string(out.Table), table)
	}
}

// writeAtlasMarker drops a build marker beside an already-written atlas -- the optional third
// file of the layout (AtlasMarkerFile), which blocktextures writes and this package reads two
// fields out of.
func writeAtlasMarker(t *testing.T, dir, marker string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, AtlasMarkerFile), []byte(marker), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestLoadAtlasCarriesWhatCouldNotBeTexturedFromTheMarker is why this reads the marker at all.
// These rows used to be attached by `serve`'s atlas method, so the ONLY host that could say why
// a block draws as a flat colour was the one that went through `serve` -- apps/desktop calls
// LoadAtlas directly and had no answer to the one question someone staring at a flat-coloured
// block actually has.
func TestLoadAtlasCarriesWhatCouldNotBeTexturedFromTheMarker(t *testing.T) {
	dir := writeAtlas(t, `{"version":1}`, []byte("x"))
	writeAtlasMarker(t, dir, `{"version":1,"blocks":1,"unresolvedTotal":24,"unresolved":[
		{"block":"wiki:glow_moss","face":"up","texture":"glow_moss","reason":"not declared","code":"key-not-declared"}
	],"note":"x"}`)

	out, err := LoadAtlas(dir)
	if err != nil {
		t.Fatalf("LoadAtlas: %v", err)
	}
	// The TOTAL is the real count and the rows are a capped sample of it -- a host rendering
	// "N of M blocks" off len(Unresolved) would under-report every pack with more than the cap,
	// which is most packs that ship no resource pack at all.
	if out.UnresolvedTotal != 24 {
		t.Errorf("UnresolvedTotal = %d, want 24 -- the real count, not len(Unresolved)", out.UnresolvedTotal)
	}
	if len(out.Unresolved) != 1 {
		t.Fatalf("Unresolved = %+v, want the one sample row", out.Unresolved)
	}
	got := out.Unresolved[0]
	if got.Block != "wiki:glow_moss" || got.Face != "up" || got.Texture != "glow_moss" {
		t.Errorf("row = %+v", got)
	}
	if got.Code != "key-not-declared" {
		t.Errorf("Code = %q, want the stable token a host groups on rather than the prose", got.Code)
	}
	if got.Reason == "" {
		t.Error("Reason is empty -- the sentence is kept beside the code, not replaced by it")
	}
}

// Every failure here is silent and the atlas is delivered regardless. This is extra information
// about a preview and must never be the reason a preview has no textures.
func TestLoadAtlasSurvivesAMarkerItCannotUse(t *testing.T) {
	for _, tc := range []struct{ name, marker string }{
		{"no marker at all", ""},
		{"not JSON", "{ this is not json"},
		{"marker from before these fields existed", `{"version":1,"blocks":1,"note":"x"}`},
		{"wrong types for both fields", `{"unresolved":"lots","unresolvedTotal":"many"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := writeAtlas(t, `{"version":1}`, []byte("x"))
			if tc.marker != "" {
				writeAtlasMarker(t, dir, tc.marker)
			}
			out, err := LoadAtlas(dir)
			if err != nil {
				t.Fatalf("LoadAtlas: %v", err)
			}
			if out.PNG == "" || len(out.Table) == 0 {
				t.Errorf("the atlas itself did not come back: png=%d table=%d", len(out.PNG), len(out.Table))
			}
			if len(out.Unresolved) != 0 || out.UnresolvedTotal != 0 {
				t.Errorf("got %+v / %d, want nothing", out.Unresolved, out.UnresolvedTotal)
			}
		})
	}
}

// TestLoadAtlasOmitsBothKeysWhenNothingIsUnresolved pins the additive half of the amendment: an
// atlas that textured everything is byte-identical on the wire to one from before these fields
// existed, so a client written against that shape decodes exactly what it always did.
func TestLoadAtlasOmitsBothKeysWhenNothingIsUnresolved(t *testing.T) {
	dir := writeAtlas(t, `{"version":1}`, []byte("x"))
	writeAtlasMarker(t, dir, `{"version":1,"blocks":1,"note":"x"}`)
	out, err := LoadAtlas(dir)
	if err != nil {
		t.Fatalf("LoadAtlas: %v", err)
	}
	raw, err := json.Marshal(out)
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
