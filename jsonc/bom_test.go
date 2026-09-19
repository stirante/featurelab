package jsonc_test

// bom_test.go is driven by testdata/bom_feature.json, which is a REAL file with
// the three BOM bytes on disk rather than a string literal with \xEF\xBB\xBF in
// it. That distinction is the point: the bug arrives as a file somebody's
// editor saved, and a fixture built in Go source proves the parser handles
// three bytes without proving anything about reading a file.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/jsonc"
)

func readBOMFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "bom_feature.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 3 || raw[0] != 0xEF || raw[1] != 0xBB || raw[2] != 0xBF {
		t.Fatalf("the fixture has lost its BOM -- first bytes are % x; re-create it with the three bytes in front", raw[:min(6, len(raw))])
	}
	return raw
}

// TestBOMFixture_IsWhatGoRefusesWithoutHelp is the baseline the rest depends
// on: encoding/json really does refuse this file, with a message about a
// character nobody can see.
func TestBOMFixture_IsWhatGoRefusesWithoutHelp(t *testing.T) {
	var root map[string]any
	if err := json.Unmarshal(readBOMFixture(t), &root); err == nil {
		t.Skip("this Go version's encoding/json skips a BOM; the strip is then belt and braces")
	}
}

func TestStripComments_BlanksALeadingBOMSoTheFileParses(t *testing.T) {
	raw := readBOMFixture(t)
	stripped := jsonc.StripComments(raw)

	var root map[string]any
	if err := json.Unmarshal(stripped, &root); err != nil {
		t.Fatalf("a BOM-prefixed file still does not parse: %v", err)
	}
	if _, ok := root["minecraft:single_block_feature"]; !ok {
		t.Fatalf("the document decoded to something else: %v", root)
	}
	// BLANKED, not removed: every remaining byte has to stay where it was, or
	// every line:column this package hands an editor is three columns out on
	// line 1.
	if len(stripped) != len(raw) {
		t.Errorf("length changed from %d to %d -- the BOM must be overwritten, never deleted", len(raw), len(stripped))
	}
	if string(stripped[:3]) != "   " {
		t.Errorf("the first three bytes are %q, want three spaces", stripped[:3])
	}
}

// TestHasUTF8BOM_OnlyLeading: in the middle of a file the same bytes are not an
// encoding marker, they are a stray character in the data, and the parser is
// right to refuse them.
func TestHasUTF8BOM_OnlyLeading(t *testing.T) {
	if !jsonc.HasUTF8BOM(readBOMFixture(t)) {
		t.Error("HasUTF8BOM did not see the fixture's mark")
	}
	middle := []byte("{\"a\": \"\xEF\xBB\xBF\"}")
	if jsonc.HasUTF8BOM(middle) {
		t.Error("HasUTF8BOM reported a mark that is not at the start")
	}
	if stripped := jsonc.StripComments(middle); string(stripped) != string(middle) {
		t.Errorf("a non-leading BOM was touched: %q", stripped)
	}
	if !jsonc.HasUTF8BOM([]byte("\xEF\xBB\xBF")) {
		t.Error("a file that is nothing but a BOM still has one")
	}
	if jsonc.HasUTF8BOM(nil) || jsonc.HasUTF8BOM([]byte("{}")) {
		t.Error("HasUTF8BOM invented a mark")
	}
}

// TestFeatureLoader_LoadsABOMPrefixedFileAndSaysSo is the whole finding
// end-to-end: before this, the feature simply did not exist and the only trace
// was some OTHER file reporting a delegation to something nothing defines.
func TestFeatureLoader_LoadsABOMPrefixedFileAndSaysSo(t *testing.T) {
	lib := features.BuildLibrary(
		[]features.SourceFile{{ID: "bom_feature.json", Text: string(readBOMFixture(t))}},
		block.NewPalette(), nil)

	if lib.Resolve("wiki:notepad_saved_this") == nil {
		t.Fatalf("the feature did not load; diagnostics = %+v", lib.Diagnostics)
	}
	var warned bool
	for _, d := range lib.Diagnostics {
		if strings.Contains(d.Message, "byte-order mark") {
			warned = true
			if d.Level != "warning" {
				t.Errorf("level = %q, want warning -- only the game's JSON reader was checked, not every layer in front of it", d.Level)
			}
		}
		if d.Level == "error" {
			t.Errorf("a BOM produced an error: %q", d.Message)
		}
	}
	if !warned {
		t.Errorf("nothing was said about the BOM; diagnostics = %+v", lib.Diagnostics)
	}
}
