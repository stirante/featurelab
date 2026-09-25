package block

import (
	"encoding/json"
	"reflect"
	"testing"
)

// uncatalogued returns files under ids the catalogue table has no row for, so
// LoadBlockTags parses every one of them. Nothing a row stands in for depends
// on the id: it reaches a diagnostic's FileID and a BlockRender's FileID, and a
// catalogue file produces neither -- which TestVanillaCatalogue_MatchesParse
// checks rather than assumes.
func uncatalogued(files []SourceFile) []SourceFile {
	out := make([]SourceFile, len(files))
	for i, f := range files {
		out[i] = SourceFile{ID: "uncatalogued/" + f.ID, AbsPath: f.AbsPath, Text: f.Text}
	}
	return out
}

// TestVanillaCatalogue_MatchesParse is the proof the table is allowed to
// exist: loading the vanilla catalogue through it leaves a palette in exactly
// the state parsing all 1238 files does, index by index and block by block.
// A pack file stacked on top, overriding one vanilla block and adding one of
// its own, is included so the later-file-wins ordering is covered too.
func TestVanillaCatalogue_MatchesParse(t *testing.T) {
	vanilla := DefaultBlocks()
	for _, f := range vanilla {
		if _, ok := cataloguedIdentifier(f); !ok {
			t.Fatalf("%s: not served by the table -- run `go generate ./block`", f.ID)
		}
	}
	pack := []SourceFile{
		{ID: "stone.json", Text: `{"minecraft:block":{"description":{"identifier":"minecraft:stone"},"components":{"tag:pack_tag":{}}}}`},
		{ID: "custom.json", Text: `{"minecraft:block":{"description":{"identifier":"demo:custom"},"components":{"tag:stone":{}}}}`},
	}

	fast := NewPalette()
	fastDiags := fast.LoadBlockTags(append(append([]SourceFile(nil), vanilla...), pack...))
	parsed := NewPalette()
	parsedDiags := parsed.LoadBlockTags(append(uncatalogued(vanilla), pack...))

	if len(fastDiags) != 0 || len(parsedDiags) != 0 {
		t.Fatalf("diagnostics: table %v, parse %v; want none from either", fastDiags, parsedDiags)
	}
	if len(parsed.renderData.byBlock) != 0 || len(parsed.renderData.notes) != 0 {
		t.Fatalf("parsing the catalogue recorded an appearance; a catalogue row cannot carry one")
	}
	if got := len(parsed.tagData.byBlock); got < len(vanilla) {
		t.Fatalf("parse indexed %d blocks, want at least the catalogue's %d", got, len(vanilla))
	}
	for name, want := range parsed.tagData.byBlock {
		if got, ok := fast.tagData.byBlock[name]; !ok || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: tags %v via the table, %v parsed", name, got, want)
		}
	}
	for _, c := range []struct {
		index       string
		table, pars any
	}{
		{"tags", fast.tagData, parsed.tagData},
		{"placement filters", fast.placementFilterData, parsed.placementFilterData},
		{"multi-block traits", fast.multiBlockData, parsed.multiBlockData},
		{"appearances", fast.renderData, parsed.renderData},
	} {
		if !reflect.DeepEqual(c.table, c.pars) {
			t.Errorf("%s index differs between the table and the parse", c.index)
		}
	}
}

// TestVanillaBlockNames_MatchesParse holds VanillaBlockNames, which reads the
// table too, to the names a parse of every file finds.
func TestVanillaBlockNames_MatchesParse(t *testing.T) {
	want := map[string]struct{}{}
	for _, f := range DefaultBlocks() {
		var doc struct {
			Block struct {
				Description struct {
					Identifier string `json:"identifier"`
				} `json:"description"`
			} `json:"minecraft:block"`
		}
		if err := json.Unmarshal([]byte(f.Text), &doc); err != nil {
			t.Fatalf("%s: %v", f.ID, err)
		}
		want[canonicalName(doc.Block.Description.Identifier)] = struct{}{}
	}
	if got := VanillaBlockNames(); !reflect.DeepEqual(got, want) {
		t.Errorf("VanillaBlockNames has %d names, a parse finds %d", len(got), len(want))
	}
}

// TestCataloguedIdentifier_RefusesChangedText: a row is for one exact text. A
// file under a catalogue id with anything else in it -- a pack shipping its own
// minecraft__stone.json, say -- has to be parsed.
func TestCataloguedIdentifier_RefusesChangedText(t *testing.T) {
	f := DefaultBlocks()[0]
	if _, ok := cataloguedIdentifier(f); !ok {
		t.Fatalf("%s should be served by the table", f.ID)
	}
	same := len(f.Text)
	changed := f
	changed.Text = f.Text[:same-1] + " "
	if _, ok := cataloguedIdentifier(changed); ok {
		t.Error("a same-length edit was served by the table")
	}
	changed.Text = f.Text + "\n"
	if _, ok := cataloguedIdentifier(changed); ok {
		t.Error("an appended newline was served by the table")
	}
	if _, ok := cataloguedIdentifier(SourceFile{ID: "zzz.json", Text: f.Text}); ok {
		t.Error("an id past the last row was served by the table")
	}
}
