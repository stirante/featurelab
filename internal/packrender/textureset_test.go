package packrender

// textureset_test.go covers a block texture declared as a
// <name>.texture_set.json rather than as an image (see internal/rptex's
// textureset.go), seen from this end: what reaches Table.Textures, and what
// reaches Table.Unresolved when it cannot.
//
// These build a tiny pack in a temp directory rather than extending the shared
// fixture add-on, because each is about a DIFFERENT outcome of the same lookup
// and the fixture's own per-outcome counts are asserted in packrender_test.go.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

// textureSetPack writes a one-block pack whose single face resolves through
// terrain_texture.json to stem, with files laid out under the resource-pack
// root, and returns the built table.
func textureSetPack(t *testing.T, stem string, files map[string]string) *Table {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	for rel, body := range files {
		write(rel, body)
	}
	write("textures/terrain_texture.json", `{"texture_data":{"tset:block":{"textures":"`+stem+`"}}}`)

	palette := block.NewPalette()
	if diags := palette.LoadBlockTags([]block.SourceFile{{ID: "blocks/tset.json", Text: `{
		"format_version": "1.21.0",
		"minecraft:block": {
			"description": {"identifier": "tset:block"},
			"components": {
				"minecraft:material_instances": {"*": {"texture": "tset:block"}}
			}
		}
	}`}}); len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}

	table, err := Build(Options{
		Palette:            palette,
		TerrainTexturePath: filepath.Join(root, filepath.FromSlash("textures/terrain_texture.json")),
		TextureRoot:        root,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return table
}

// TestBuild_TextureSetResolvesToItsSiblingImage is the whole point of texture
// set support seen from here: the face stays in the block's Faces map and the
// atlas builder is handed an image, where before the face was dropped and the
// viewer fell back to the block's hash-derived colour.
func TestBuild_TextureSetResolvesToItsSiblingImage(t *testing.T) {
	table := textureSetPack(t, "textures/blocks/limestone", map[string]string{
		"textures/blocks/limestone.texture_set.json": `{"minecraft:texture_set":{"color":"limestone_base","normal":"limestone_normal"}}`,
		"textures/blocks/limestone_base.png":         "placeholder bytes -- only the PATH is resolved here",
	})
	if len(table.Unresolved) != 0 {
		t.Fatalf("Unresolved = %+v, want none", table.Unresolved)
	}
	src, ok := table.Textures["tset:block"]
	if !ok {
		t.Fatal("tset:block has no texture source -- the atlas builder gets nothing")
	}
	if !strings.HasSuffix(src.File, filepath.FromSlash("blocks/limestone_base.png")) {
		t.Errorf("File = %q, want the sibling image the texture set named", src.File)
	}
	if src.Color != "" {
		t.Errorf("Color = %q, want none when a real image was found", src.Color)
	}
	if len(src.TextureSets) != 1 {
		t.Errorf("TextureSets = %v, want the one texture set that was walked", src.TextureSets)
	}
	if faces := table.Blocks["tset:block"].Faces; len(faces) != len(block.RenderFaces) {
		t.Errorf("faces = %v, want all six bound", faces)
	}
}

// TestBuild_TextureSetFlatColourTravelsAsAColour: the pack declared the colour
// and shipped no art for it. The key still resolves -- with a colour instead
// of a file -- so internal/atlas can synthesise the cell.
func TestBuild_TextureSetFlatColourTravelsAsAColour(t *testing.T) {
	table := textureSetPack(t, "textures/blocks/paint", map[string]string{
		"textures/blocks/paint.texture_set.json": `{"minecraft:texture_set":{"color":[16,32,48,255]}}`,
	})
	if len(table.Unresolved) != 0 {
		t.Fatalf("Unresolved = %+v, want none", table.Unresolved)
	}
	src := table.Textures["tset:block"]
	if src.File != "" {
		t.Errorf("File = %q, want none for a flat colour", src.File)
	}
	if src.Color != "#102030" {
		t.Errorf("Color = %q, want #102030", src.Color)
	}
	if faces := table.Blocks["tset:block"].Faces; faces["up"] != "tset:block" {
		t.Errorf("faces = %v, want every face bound to the key", faces)
	}
}

// TestBuild_TextureSetFailuresSayWhichKind is the diagnostic half. A texture
// set naming a file that is not there and a texture set whose colour is
// written in a form this preview does not read must not collapse into one
// message: the first is fixed by exporting the art, the second by rewriting
// the colour, and the author sees only this sentence.
func TestBuild_TextureSetFailuresSayWhichKind(t *testing.T) {
	missing := textureSetPack(t, "textures/blocks/limestone", map[string]string{
		"textures/blocks/limestone.texture_set.json": `{"minecraft:texture_set":{"color":"limestone_base"}}`,
	})
	if len(missing.Unresolved) == 0 {
		t.Fatal("Unresolved is empty; a texture set naming a missing file must be reported")
	}
	reason := missing.Unresolved[0].Reason
	if !strings.Contains(reason, "limestone_base") || !strings.Contains(reason, ".texture_set.json") {
		t.Errorf("reason = %q, want it to name the texture set and the file it could not find", reason)
	}

	unsupported := textureSetPack(t, "textures/blocks/weird", map[string]string{
		"textures/blocks/weird.texture_set.json": `{"minecraft:texture_set":{"color":{"r":1}}}`,
	})
	if len(unsupported.Unresolved) == 0 {
		t.Fatal("Unresolved is empty; a colour form this preview cannot read must be reported")
	}
	if got := unsupported.Unresolved[0].Reason; !strings.Contains(got, "neither a texture name") {
		t.Errorf("reason = %q, want it to say the colour form is not one this preview reads", got)
	}
}
