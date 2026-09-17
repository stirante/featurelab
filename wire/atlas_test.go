package wire

import (
	"encoding/base64"
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
