package packrender

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/pack"
)

// buildFixture runs the whole pipeline the way a caller does -- load the
// behaviour pack, find its resource pack, build the table -- against the
// fixture add-on in pack/testdata/addon. Going through pack.Load and
// pack.FindResourcePack rather than hand-building a Palette is the point:
// this is the seam where "the pack's OWN resource pack" has to actually be
// located, and a test that skips that step tests nothing about it.
func buildFixture(t *testing.T) *Table {
	t.Helper()
	root := filepath.Join("..", "..", "pack", "testdata", "addon", "MyAddon_bp")
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	palette := block.NewPalette()
	if diags := palette.LoadBlockTags(loaded.Blocks); len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	rp, notes, err := pack.FindResourcePack(loaded.Dir, "")
	if err != nil {
		t.Fatalf("FindResourcePack: %v", err)
	}
	if rp == nil {
		t.Fatalf("no resource pack found for the fixture add-on; notes = %v", notes)
	}
	table, err := Build(Options{
		Palette:            palette,
		TerrainTexturePath: rp.TerrainTexturePath,
		TextureRoot:        rp.Dir,
		ResourcePackDir:    rp.Dir,
		ResourcePackName:   rp.Name,
		ResourcePackHow:    rp.How,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return table
}

// TestBuild_ResolvesThePacksOwnTextures is the headline: a custom block's face
// texture key resolves through the PACK's terrain_texture.json to a real image
// on disk, with the alias indirection followed and per-face overrides applied.
func TestBuild_ResolvesThePacksOwnTextures(t *testing.T) {
	table := buildFixture(t)

	slate, ok := table.Blocks["myaddon:slate"]
	if !ok {
		t.Fatalf("myaddon:slate missing; table has %d blocks", len(table.Blocks))
	}
	if !slate.Fully() {
		t.Errorf("myaddon:slate did not fully resolve: %+v", slate)
	}
	if slate.Faces["north"] != "myaddon:slate" {
		t.Errorf("north = %q, want myaddon:slate (via the \"*\" -> \"sides\" alias)", slate.Faces["north"])
	}
	if slate.Faces["up"] != "myaddon:slate_top" || slate.Faces["down"] != "myaddon:slate_top" {
		t.Errorf("up/down = %q/%q, want myaddon:slate_top (down via a two-hop alias)",
			slate.Faces["up"], slate.Faces["down"])
	}
	if slate.Render != block.RenderOpaque || slate.Shape != block.ShapeFullBlock {
		t.Errorf("render/shape = %q/%q, want opaque/full_block", slate.Render, slate.Shape)
	}

	src, ok := table.Textures["myaddon:slate_top"]
	if !ok {
		t.Fatal("myaddon:slate_top has no texture source -- the atlas builder gets no image")
	}
	if src.From != "pack" {
		t.Errorf("From = %q, want \"pack\"", src.From)
	}
	if !strings.HasSuffix(src.File, "slate_top.png") {
		t.Errorf("File = %q, want the real .png on disk", src.File)
	}
}

// TestBuild_CrossAndTintAndOverlay pins the cutout plant path end to end: the
// cross shape survives, the tint channel carries tint_method, and the texture
// entry carries terrain_texture.json's own overlay_color.
func TestBuild_CrossAndTintAndOverlay(t *testing.T) {
	table := buildFixture(t)
	fern, ok := table.Blocks["myaddon:fern"]
	if !ok {
		t.Fatal("myaddon:fern missing")
	}
	if fern.Shape != block.ShapeCross {
		t.Errorf("shape = %q, want cross", fern.Shape)
	}
	if fern.Render != block.RenderCutout || !fern.DoubleSided {
		t.Errorf("render/doubleSided = %q/%v, want cutout/true for alpha_test", fern.Render, fern.DoubleSided)
	}
	for face, tint := range fern.Tint {
		if tint != "grass" {
			t.Errorf("tint[%s] = %q, want grass", face, tint)
		}
	}
	if len(fern.Tint) != len(fern.Faces) {
		t.Errorf("tint has %d faces, faces has %d -- they must be indexable with the same key",
			len(fern.Tint), len(fern.Faces))
	}
	if got := table.Textures["myaddon:fern"].Overlay; got != "#79c05a" {
		t.Errorf("overlay = %q, want the entry's own overlay_color", got)
	}
}

// TestBuild_UnsupportedGeometryFallsBackAndSaysSo is the user-facing half of the
// scope boundary: a block whose geometry is a resource-pack model still gets its
// real textures on a cube, and carries the sentence that explains why.
func TestBuild_UnsupportedGeometryFallsBackAndSaysSo(t *testing.T) {
	table := buildFixture(t)
	lamp, ok := table.Blocks["myaddon:sculpted_lamp"]
	if !ok {
		t.Fatal("myaddon:sculpted_lamp missing")
	}
	if lamp.Shape != block.ShapeUnsupported {
		t.Errorf("shape = %q, want unsupported", lamp.Shape)
	}
	if lamp.Fully() {
		t.Error("Fully() = true for a block drawn as a cube instead of its model")
	}
	if len(lamp.Faces) != len(block.RenderFaces) {
		t.Errorf("faces = %d, want all six textured despite the unsupported geometry", len(lamp.Faces))
	}
	if lamp.Render != block.RenderCutout || lamp.DoubleSided {
		t.Errorf("render/doubleSided = %q/%v, want cutout/false for alpha_test_single_sided_to_opaque",
			lamp.Render, lamp.DoubleSided)
	}
	for _, want := range []string{"geometry.myaddon.sculpted_lamp", "full cube"} {
		if !strings.Contains(lamp.Fallback, want) {
			t.Errorf("fallback = %q, want it to mention %q", lamp.Fallback, want)
		}
	}
	found := false
	for _, note := range table.Notes {
		if note.Block == "myaddon:sculpted_lamp" {
			found = true
		}
	}
	if !found {
		t.Error("the block has no entry in table.Notes")
	}
}

// TestBuild_UnresolvedTexturesAreListedWithDistinctReasons pins that the two
// ways a texture fails to resolve stay distinguishable: a key the resource pack
// never declared, and a key it declared pointing at a file that is not there.
// They have different fixes, so collapsing them into one message would make the
// list useless.
func TestBuild_UnresolvedTexturesAreListedWithDistinctReasons(t *testing.T) {
	table := buildFixture(t)
	byFace := map[string]Unresolved{}
	for _, u := range table.Unresolved {
		if u.Block == "myaddon:broken_textures" {
			byFace[u.Face] = u
		}
	}
	up, ok := byFace["up"]
	if !ok {
		t.Fatalf("up face is not listed as unresolved; unresolved = %+v", table.Unresolved)
	}
	if !strings.Contains(up.Reason, "found for textures/blocks/not_on_disk") {
		t.Errorf("up reason = %q, want it to say the declared image is not on disk", up.Reason)
	}
	north, ok := byFace["north"]
	if !ok {
		t.Fatal("north face (via \"side\") is not listed as unresolved")
	}
	if !strings.Contains(north.Reason, "not declared in the resource pack") {
		t.Errorf("north reason = %q, want it to say the key is not declared", north.Reason)
	}

	broken := table.Blocks["myaddon:broken_textures"]
	if _, textured := broken.Faces["down"]; !textured {
		t.Error("the down face resolved and must still be in the table -- one bad key does not lose the good ones")
	}
	if _, textured := broken.Faces["up"]; textured {
		t.Error("the up face has no image and must not claim a texture")
	}
	if broken.Shape != block.ShapeFullBlock {
		t.Errorf("shape = %q, want full_block from the legacy minecraft:block_shape", broken.Shape)
	}
}

// TestBuild_VanillaFallbackKeysNeedNoImage pins the reason the vanilla table is
// consulted at all: custom blocks reuse vanilla texture keys, and a key found
// there is already a cell in the vanilla atlas, so no image is handed over.
func TestBuild_VanillaFallbackKeysNeedNoImage(t *testing.T) {
	root := filepath.Join("..", "..", "pack", "testdata", "addon", "MyAddon_bp")
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	palette := block.NewPalette()
	palette.LoadBlockTags(append(loaded.Blocks, block.SourceFile{
		ID: "reuses_vanilla.json",
		Text: `{"minecraft:block":{"description":{"identifier":"myaddon:reuses_vanilla"},
			"components":{"minecraft:material_instances":{"*":{"texture":"stone"}}}}}`,
	}))
	table, err := Build(Options{
		Palette:                   palette,
		VanillaTerrainTexturePath: filepath.Join("..", "..", "scripts", "vanilla-extract", "rp", "terrain_texture.json"),
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	src, ok := table.Textures["stone"]
	if !ok {
		t.Fatalf("the vanilla key \"stone\" did not resolve; unresolved = %+v", table.Unresolved)
	}
	if src.From != "vanilla" {
		t.Errorf("From = %q, want \"vanilla\"", src.From)
	}
	if src.File != "" {
		t.Errorf("File = %q, want empty -- the vanilla atlas already has this cell", src.File)
	}
}

// TestBuild_NoPaletteOrNoResourcePackIsNotAnError pins the fallback contract:
// with no pack loaded, or a pack with no resource pack, Build produces an empty
// or texture-less table rather than failing. Textures are an enhancement.
func TestBuild_NoPaletteOrNoResourcePackIsNotAnError(t *testing.T) {
	empty, err := Build(Options{})
	if err != nil {
		t.Fatalf("Build with no palette: %v", err)
	}
	if len(empty.Blocks) != 0 || empty.Blocks == nil || empty.Textures == nil ||
		empty.Unresolved == nil || empty.Notes == nil {
		t.Errorf("empty table = %+v, want empty-but-non-nil collections so a JSON consumer never sees null", empty)
	}

	palette := block.NewPalette()
	palette.LoadBlockTags([]block.SourceFile{{ID: "b.json", Text: `{"minecraft:block":{
		"description":{"identifier":"myaddon:x"},
		"components":{"minecraft:material_instances":{"*":{"texture":"myaddon:x"}}}}}`}})
	table, err := Build(Options{Palette: palette})
	if err != nil {
		t.Fatalf("Build with no resource pack: %v", err)
	}
	if len(table.Blocks) != 1 {
		t.Fatalf("blocks = %d, want the block itself still described", len(table.Blocks))
	}
	if len(table.Unresolved) != len(block.RenderFaces) {
		t.Errorf("unresolved = %d, want one per face", len(table.Unresolved))
	}
	if !strings.Contains(table.Unresolved[0].Reason, "resource pack was not found") {
		t.Errorf("reason = %q, want it to name the missing resource pack", table.Unresolved[0].Reason)
	}
}

// TestSummarise counts the fixture, which is deliberately one of each outcome.
func TestSummarise(t *testing.T) {
	s := buildFixture(t).Summarise()
	if s.Blocks != 4 {
		t.Errorf("Blocks = %d, want the fixture's 4", s.Blocks)
	}
	if s.Fully != 2 {
		t.Errorf("Fully = %d, want 2 (slate and fern)", s.Fully)
	}
	if s.ShapeCube != 1 {
		t.Errorf("ShapeCube = %d, want 1 (the sculpted lamp)", s.ShapeCube)
	}
	if s.Untextured != 1 {
		t.Errorf("Untextured = %d, want 1 (broken_textures)", s.Untextured)
	}
}
