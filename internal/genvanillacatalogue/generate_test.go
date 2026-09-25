package genvanillacatalogue

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

// TestTableIsCurrent regenerates block/vanilla_catalogue_table.go in memory and
// compares it with the committed file. A table that has fallen behind the
// catalogue is still correct -- rows that no longer match are parsed instead
// (see block/vanilla_catalogue.go) -- so nothing else would notice it; the
// only symptom would be the playground's first run quietly getting slow again.
func TestTableIsCurrent(t *testing.T) {
	want, err := Render(block.DefaultBlocks())
	if err != nil {
		t.Fatalf("the catalogue cannot be tabled: %v", err)
	}
	got, err := os.ReadFile("../../block/vanilla_catalogue_table.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("block/vanilla_catalogue_table.go is stale -- run `go generate ./block`")
	}
}

// TestRender_RefusesAFileThatSaysMore: a row can only say "this file declares
// this block", so a file that declares anything else must stop the generator
// rather than lose what it says.
func TestRender_RefusesAFileThatSaysMore(t *testing.T) {
	cases := map[string]string{
		"a tag":         `{"minecraft:block":{"description":{"identifier":"minecraft:a"},"components":{"tag:stone":{}}}}`,
		"a trait":       `{"minecraft:block":{"description":{"identifier":"minecraft:a","traits":{}},"components":{}}}`,
		"permutations":  `{"minecraft:block":{"description":{"identifier":"minecraft:a"},"components":{},"permutations":[]}}`,
		"no identifier": `{"minecraft:block":{"description":{},"components":{}}}`,
		"no block":      `{"format_version":"1.21.70"}`,
		"a BOM":         "\xef\xbb\xbf" + `{"minecraft:block":{"description":{"identifier":"minecraft:a"},"components":{}}}`,
		"broken JSON":   `{"minecraft:block":`,
	}
	for name, text := range cases {
		_, err := Render([]block.SourceFile{{ID: "a.json", Text: text}})
		if err == nil {
			t.Errorf("%s: rendered a row", name)
		} else if !strings.HasPrefix(err.Error(), "a.json: ") {
			t.Errorf("%s: error %q does not name the file", name, err)
		}
	}
	if _, err := Render([]block.SourceFile{{ID: "a.json", Text: `{"minecraft:block":{"description":{"identifier":"minecraft:a"},"components":{}}}`}}); err != nil {
		t.Errorf("a bare file was refused: %v", err)
	}
}
