package packrender

// variations_test.go is the reported bug seen from the end an author sees: a
// resource pack that uses "variations" in terrain_texture.json, which used to
// fail the whole file and leave EVERY block in the pack untextured with no
// message naming the entry responsible.
//
// The tests build a tiny pack in a temp directory for the same reason
// textureset_test.go does: each is about a different outcome of one lookup.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

// variationsPack writes a resource pack: terrainJSON verbatim as
// terrain_texture.json, one block per identifier in blocks (every face naming
// the identifier as its texture key), and every path in files. A file listed
// with an empty body is an image placeholder -- nothing here decodes pixels,
// only resolves paths.
func variationsPack(t *testing.T, terrainJSON string, blocks []string, files map[string]string) *Table {
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
	write("textures/terrain_texture.json", terrainJSON)
	for rel, body := range files {
		if body == "" {
			body = "placeholder bytes -- only the PATH is resolved here"
		}
		write(rel, body)
	}

	palette := block.NewPalette()
	sources := make([]block.SourceFile, 0, len(blocks))
	for _, id := range blocks {
		sources = append(sources, block.SourceFile{
			ID: "blocks/" + strings.ReplaceAll(id, ":", "_") + ".json",
			Text: `{"format_version":"1.21.0","minecraft:block":{
				"description":{"identifier":"` + id + `"},
				"components":{"minecraft:material_instances":{"*":{"texture":"` + id + `"}}}}}`,
		})
	}
	if diags := palette.LoadBlockTags(sources); len(diags) != 0 {
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

// TestBuild_VariationsResolveToTheFirstPath is the fix: a key written as a
// variations list resolves, the block keeps all six faces, and the image handed
// to the atlas builder is the first variation's -- the same one on every run.
func TestBuild_VariationsResolveToTheFirstPath(t *testing.T) {
	table := variationsPack(t, `{"texture_data":{"ns:custom":{"textures":[{"variations":[
		{"path":"textures/ns/blocks/custom_0","weight":1},
		{"path":"textures/ns/blocks/custom_1","weight":1},
		{"path":"textures/ns/blocks/custom_2","weight":1}]}]}}}`,
		[]string{"ns:custom"}, map[string]string{
			"textures/ns/blocks/custom_0.png": "",
			"textures/ns/blocks/custom_1.png": "",
			"textures/ns/blocks/custom_2.png": "",
		})

	if len(table.Unresolved) != 0 {
		t.Fatalf("Unresolved = %+v, want none", table.Unresolved)
	}
	src, ok := table.Textures["ns:custom"]
	if !ok {
		t.Fatal("ns:custom has no texture source -- the atlas builder gets nothing")
	}
	if !strings.HasSuffix(src.File, filepath.FromSlash("blocks/custom_0.png")) {
		t.Errorf("File = %q, want the first variation", src.File)
	}
	if faces := table.Blocks["ns:custom"].Faces; len(faces) != len(block.RenderFaces) {
		t.Errorf("faces = %v, want all six bound", faces)
	}
}

// TestBuild_OneUnsupportedEntryLeavesTheRestOfThePack is the heart of the
// report: "if your resource pack uses any variations at all, the entire
// terrain_texture.json will fail to load". One entry nothing can be made of
// must cost that one key, and the blocks that use other keys must draw.
func TestBuild_OneUnsupportedEntryLeavesTheRestOfThePack(t *testing.T) {
	table := variationsPack(t, `{"texture_data":{
		"ns:good":      {"textures":"textures/ns/blocks/good"},
		"ns:nonsense":  {"textures":{"no_path_here":true}},
		"ns:variations":{"textures":[{"variations":[{"path":"textures/ns/blocks/var_0","weight":1}]}]}}}`,
		[]string{"ns:good", "ns:nonsense", "ns:variations"}, map[string]string{
			"textures/ns/blocks/good.png":  "",
			"textures/ns/blocks/var_0.png": "",
		})

	for _, key := range []string{"ns:good", "ns:variations"} {
		if _, ok := table.Textures[key]; !ok {
			t.Errorf("%s resolved to nothing; an unrelated entry's problem took it down with it", key)
		}
		if faces := table.Blocks[key].Faces; len(faces) != len(block.RenderFaces) {
			t.Errorf("%s faces = %v, want all six bound", key, faces)
		}
	}
	if _, ok := table.Textures["ns:nonsense"]; ok {
		t.Error("ns:nonsense resolved, but its entry names no texture path")
	}

	// And the author is told which entry, and why -- not "this key is not
	// declared", which would send them to add an entry that is already there.
	var reason string
	for _, u := range table.Unresolved {
		if u.Texture == "ns:nonsense" {
			reason = u.Reason
		} else {
			t.Errorf("unexpected unresolved entry %+v", u)
		}
	}
	if reason == "" {
		t.Fatal("nothing in Unresolved names the skipped entry: the pack draws wrong and says nothing")
	}
	if !strings.Contains(reason, "skipped") || strings.Contains(reason, "is not declared") {
		t.Errorf("reason = %q, want it to say the declared entry was skipped and why", reason)
	}
}

// TestBuild_VariationsWithAMissingFirstPathIsReported covers both readings of
// "the first variation has no path": an entry with no "path" member at all, and
// one whose path names art that was never exported. Neither may crash, and the
// two must not collapse into the same sentence -- one is fixed in the JSON, the
// other by exporting a PNG.
func TestBuild_VariationsWithAMissingFirstPathIsReported(t *testing.T) {
	noPath := variationsPack(t, `{"texture_data":{"ns:custom":{"textures":[{"variations":[
		{"weight":1},
		{"path":"textures/ns/blocks/custom_1","weight":1}]}]}}}`,
		[]string{"ns:custom"}, map[string]string{"textures/ns/blocks/custom_1.png": ""})
	if _, ok := noPath.Textures["ns:custom"]; ok {
		t.Error("the key resolved; the first variation names no path and later ones are not substitutes")
	}
	if len(noPath.Unresolved) == 0 {
		t.Fatal("Unresolved is empty; a variations list whose first entry has no path must be reported")
	}
	if got := noPath.Unresolved[0].Reason; !strings.Contains(got, "variations") {
		t.Errorf("reason = %q, want it to name the variations list", got)
	}

	missingFile := variationsPack(t, `{"texture_data":{"ns:custom":{"textures":[{"variations":[
		{"path":"textures/ns/blocks/custom_0","weight":1},
		{"path":"textures/ns/blocks/custom_1","weight":1}]}]}}}`,
		[]string{"ns:custom"}, map[string]string{"textures/ns/blocks/custom_1.png": ""})
	if len(missingFile.Unresolved) == 0 {
		t.Fatal("Unresolved is empty; the first variation's image is not on disk")
	}
	if got := missingFile.Unresolved[0].Reason; !strings.Contains(got, "custom_0") {
		t.Errorf("reason = %q, want it to name the file that is not there", got)
	}
}

// TestBuild_TerrainPathWrittenAsATextureSetFile: a terrain_texture.json path
// that ends in .texture_set.json names THAT file, rather than a stem to append
// the suffix to a second time -- the spelling the issue reporter described. It
// is exercised here through a variations list because the two arrived together
// in the same pack.
func TestBuild_TerrainPathWrittenAsATextureSetFile(t *testing.T) {
	table := variationsPack(t, `{"texture_data":{"ns:custom":{"textures":[{"variations":[
		{"path":"textures/ns/blocks/custom.texture_set.json","weight":1}]}]}}}`,
		[]string{"ns:custom"}, map[string]string{
			"textures/ns/blocks/custom.texture_set.json": `{"minecraft:texture_set":{"color":"custom_base"}}`,
			"textures/ns/blocks/custom_base.png":         "",
		})
	if len(table.Unresolved) != 0 {
		t.Fatalf("Unresolved = %+v, want none", table.Unresolved)
	}
	src := table.Textures["ns:custom"]
	if !strings.HasSuffix(src.File, filepath.FromSlash("blocks/custom_base.png")) {
		t.Errorf("File = %q, want the image the texture set's colour names", src.File)
	}
	if len(src.TextureSets) != 1 {
		t.Errorf("TextureSets = %v, want the one texture set that was walked", src.TextureSets)
	}

	// A texture set whose colour is a literal, reached the same way.
	flat := variationsPack(t, `{"texture_data":{"ns:custom":{"textures":"textures/ns/blocks/paint.texture_set.json"}}}`,
		[]string{"ns:custom"}, map[string]string{
			"textures/ns/blocks/paint.texture_set.json": `{"minecraft:texture_set":{"color":[16,32,48]}}`,
		})
	if got := flat.Textures["ns:custom"].Color; got != "#102030" {
		t.Errorf("Color = %q, want #102030", got)
	}
}
