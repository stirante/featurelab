package atlas

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/internal/rptex"
)

// writePNG writes a w x h texture painted by paint into the fixture pack.
func writePNG(t *testing.T, root, rel string, w, h int, paint func(x, y int) color.NRGBA) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel)+".png")
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	img := solid(w, h, paint)
	f, err := os.Create(full)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func flat(c color.NRGBA) func(int, int) color.NRGBA { return func(int, int) color.NRGBA { return c } }

// fixturePack builds a miniature resource pack on disk: five blocks covering
// every texture-set shape blocks.json uses and every tint channel this
// package emits, plus one deliberately dangling texture key.
func fixturePack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()

	grey := color.NRGBA{140, 140, 140, 255}
	writePNG(t, root, "textures/blocks/stone", 16, 16, flat(grey))
	writePNG(t, root, "textures/blocks/dirt", 16, 16, flat(color.NRGBA{134, 96, 67, 255}))
	writePNG(t, root, "textures/blocks/grass_top", 16, 16, flat(grey))
	// The grass side is the fringe overlay vanilla ships: opaque along the
	// top rows, transparent below.
	writePNG(t, root, "textures/blocks/grass_side", 16, 16, func(_, y int) color.NRGBA {
		if y < 4 {
			return grey
		}
		return color.NRGBA{}
	})
	writePNG(t, root, "textures/blocks/grass_carried_top", 16, 16, flat(color.NRGBA{110, 180, 70, 255}))
	writePNG(t, root, "textures/blocks/leaves", 16, 16, flat(grey))
	writePNG(t, root, "textures/blocks/leaves_carried", 16, 16, flat(color.NRGBA{70, 130, 40, 255}))
	writePNG(t, root, "textures/blocks/water_still_grey", 16, 16, flat(color.NRGBA{150, 150, 150, 240}))
	writePNG(t, root, "textures/blocks/water_still", 16, 16, flat(color.NRGBA{80, 120, 220, 240}))
	writePNG(t, root, "textures/blocks/log_side", 16, 16, flat(color.NRGBA{100, 80, 50, 255}))
	writePNG(t, root, "textures/blocks/log_top", 16, 16, flat(color.NRGBA{160, 130, 90, 255}))
	writePNG(t, root, "textures/blocks/furnace_front", 16, 16, flat(color.NRGBA{90, 90, 92, 255}))

	terrain := `// terrain_texture.json ships with comments; this fixture does too.
{
  "resource_pack_name": "fixture",
  "texture_data": {
    "stone": { "textures": "textures/blocks/stone" },
    "dirt": { "textures": "textures/blocks/dirt" },
    "grass_top": { "textures": "textures/blocks/grass_top" },
    "grass_side": { "textures": [
      { "path": "textures/blocks/grass_side", "overlay_color": "#79c05a" },
      { "path": "textures/blocks/grass_side", "overlay_color": "#8ab689" }
    ] },
    "grass_carried_top": { "textures": "textures/blocks/grass_carried_top" },
    "leaves": { "textures": "textures/blocks/leaves" },
    "leaves_carried": { "textures": "textures/blocks/leaves_carried" },
    "still_water_grey": { "textures": "textures/blocks/water_still_grey" },
    "still_water": { "textures": "textures/blocks/water_still" },
    "multi": { "textures": ["textures/blocks/stone", "textures/blocks/dirt"] },
    "log_side": { "textures": "textures/blocks/log_side" },
    "log_top": { "textures": "textures/blocks/log_top" },
    "furnace_front": { "textures": "textures/blocks/furnace_front" }
  }
}`
	if err := os.WriteFile(filepath.Join(root, "textures", "terrain_texture.json"), []byte(terrain), 0o644); err != nil {
		t.Fatal(err)
	}

	blocks := `{
  "format_version": [1, 1, 0],
  "stone": { "textures": "stone" },
  "grass": {
    "textures": { "up": "grass_top", "down": "dirt", "side": "grass_side" },
    "carried_textures": { "up": "grass_carried_top", "down": "dirt", "side": "grass_carried_top" }
  },
  "leaves": { "textures": "leaves", "carried_textures": "leaves_carried" },
  "water": { "textures": { "up": "still_water_grey", "down": "still_water_grey", "side": "still_water_grey" } },
  "log": {
    "textures": { "up": "log_top", "down": "log_top", "north": "furnace_front", "south": "log_side", "east": "log_side", "west": "log_side" }
  },
  "broken": { "textures": "no_such_key" }
}`
	if err := os.WriteFile(filepath.Join(root, "blocks.json"), []byte(blocks), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func fixtureIDs() []string {
	return []string{
		"minecraft:broken",
		"minecraft:grass",
		"minecraft:leaves",
		"minecraft:log",
		"minecraft:nothing_at_all",
		"minecraft:stone",
		"minecraft:water",
	}
}

func buildFixture(t *testing.T) *Built {
	t.Helper()
	built, err := Build(Options{Root: fixturePack(t), Tag: "fixture", BlockIDs: fixtureIDs()})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return built
}

// TestBuild_SheetGeometryMatchesTheTable is the check the renderer makes on
// the other side of the wire (frontend/src/viewer.ts): the image must be
// exactly cols*stride by rows*stride, because every UV is derived from those
// two numbers rather than from the file's own header.
func TestBuild_SheetGeometryMatchesTheTable(t *testing.T) {
	built := buildFixture(t)
	img, err := png.Decode(bytes.NewReader(built.PNG))
	if err != nil {
		t.Fatalf("decode atlas.png: %v", err)
	}
	tbl := built.Table
	stride := tbl.Cell + 2*tbl.Border
	if tbl.Stride != stride {
		t.Fatalf("table stride %d != cell+2*border %d", tbl.Stride, stride)
	}
	if got := img.Bounds(); got.Dx() != tbl.Cols*stride || got.Dy() != tbl.Rows*stride {
		t.Fatalf("atlas image is %v, but the table describes %dx%d cells of %d", got, tbl.Cols, tbl.Rows, stride)
	}
	if got := img.Bounds(); got.Dx() != tbl.Width || got.Dy() != tbl.Height {
		t.Fatalf("atlas image %v disagrees with the table's own width/height %dx%d", got, tbl.Width, tbl.Height)
	}
	if len(tbl.Cells) > tbl.Cols*tbl.Rows {
		t.Fatalf("%d cells do not fit a %dx%d grid", len(tbl.Cells), tbl.Cols, tbl.Rows)
	}
	for i, c := range tbl.Cells {
		if c.X+tbl.Cell > tbl.Width || c.Y+tbl.Cell > tbl.Height {
			t.Fatalf("cell %d at (%d,%d) runs off a %dx%d sheet", i, c.X, c.Y, tbl.Width, tbl.Height)
		}
	}
}

// TestBuild_WhiteCellIsWhite pins the cell every unknown block falls back to.
// It is the one cell this project draws itself, and a renderer multiplies a
// flat palette colour by it, so anything other than opaque white silently
// tints every custom block.
func TestBuild_WhiteCellIsWhite(t *testing.T) {
	built := buildFixture(t)
	tbl := built.Table
	if tbl.White < 0 || tbl.White >= len(tbl.Cells) {
		t.Fatalf("white = %d is not a cell index (have %d cells)", tbl.White, len(tbl.Cells))
	}
	if tbl.White >= tbl.Cols*tbl.Rows {
		t.Fatalf("white = %d is outside the cols*rows range decodeAtlas validates against", tbl.White)
	}
	cell := tbl.Cells[tbl.White]
	img, err := png.Decode(bytes.NewReader(built.PNG))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []image.Point{{X: cell.X, Y: cell.Y}, {X: cell.X + 15, Y: cell.Y + 15}, {X: cell.X + 7, Y: cell.Y + 3}} {
		r, g, b, a := img.At(p.X, p.Y).RGBA()
		if r != 0xffff || g != 0xffff || b != 0xffff || a != 0xffff {
			t.Fatalf("white cell pixel %v = (%d,%d,%d,%d), want opaque white", p, r>>8, g>>8, b>>8, a>>8)
		}
	}
}

// TestBuild_PerFaceResolution walks every texture-set shape blocks.json uses.
func TestBuild_PerFaceResolution(t *testing.T) {
	tbl := buildFixture(t).Table

	stone, ok := tbl.Blocks["minecraft:stone"]
	if !ok {
		t.Fatal("stone missing from the table")
	}
	if _, ok := stone.Faces[wildcardFace]; !ok || len(stone.Faces) != 1 {
		t.Fatalf("stone faces = %v, want a single wildcard entry for a flat single-texture block", stone.Faces)
	}

	grass, ok := tbl.Blocks["minecraft:grass"]
	if !ok {
		t.Fatal("grass missing from the table")
	}
	for _, face := range []string{"up", "down", "north", "south", "east", "west"} {
		if _, ok := grass.Faces[face]; !ok {
			t.Fatalf("grass has no %q face; a grass block is not one texture", face)
		}
	}
	if grass.Faces["up"] == grass.Faces["north"] || grass.Faces["down"] == grass.Faces["north"] {
		t.Fatalf("grass up/down/side collapsed onto one cell: %v", grass.Faces)
	}
	if grass.Keys["north"] != "grass_side" {
		t.Fatalf("grass north key = %q, want grass_side: the {up,down,side} form must fan \"side\" out to the cardinals", grass.Keys["north"])
	}

	log, ok := tbl.Blocks["minecraft:log"]
	if !ok {
		t.Fatal("log missing from the table")
	}
	if log.Keys["north"] != "furnace_front" || log.Keys["south"] != "log_side" {
		t.Fatalf("log cardinals not kept distinct: %v", log.Keys)
	}
	if log.Faces["up"] != log.Faces["down"] {
		t.Fatalf("log up/down should share log_top: %v", log.Faces)
	}
}

// TestBuild_TintChannels is the check the contract calls out as most likely
// to be got wrong: a greyscale texture rendered untinted looks grey, so every
// grey face that HAS a tint source must carry one, and the multiplier must be
// measured rather than invented.
func TestBuild_TintChannels(t *testing.T) {
	tbl := buildFixture(t).Table

	grass := tbl.Blocks["minecraft:grass"]
	if got := grass.Tint["north"]; got != TintGrass {
		t.Errorf("grass side tint = %q, want %q (its terrain entry carries overlay_color)", got, TintGrass)
	}
	if got := grass.TintColor["north"]; got != "#79c05a" {
		t.Errorf("grass side tint_color = %q, want the entry's own overlay_color #79c05a", got)
	}
	if got := grass.Tint["up"]; got != TintGrass {
		t.Errorf("grass top tint = %q, want %q -- a block with an explicitly grass-tinted face must not ask for the leaf colour on its top", got, TintGrass)
	}
	if grass.TintColor["up"] == "" {
		t.Error("grass top has no measured tint_color; an untinted greyscale top renders grey and wrong")
	}
	if got := grass.Tint["down"]; got != TintNone {
		t.Errorf("grass bottom tint = %q, want %q (dirt is not grey)", got, TintNone)
	}

	leaves := tbl.Blocks["minecraft:leaves"]
	if got := leaves.Tint[wildcardFace]; got != TintFoliage {
		t.Errorf("leaves tint = %q, want %q", got, TintFoliage)
	}
	// The multiplier must be the one that lands the grey texture on the
	// carried texture's colour: 140 * m / 255 == the carried channel.
	const greyAvg = 140
	multiplier, err := rptex.ParseHex(leaves.TintColor[wildcardFace])
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []int{70, 130, 40} {
		m := []uint8{multiplier.R, multiplier.G, multiplier.B}[i]
		if got := greyAvg * int(m) / 255; got < want-2 || got > want+2 {
			t.Errorf("leaves tint channel %d: grey %d multiplied by %d gives %d, want ~%d", i, greyAvg, m, got, want)
		}
	}

	water := tbl.Blocks["minecraft:water"]
	if got := water.Tint[wildcardFace]; got != TintWater {
		t.Errorf("water tint = %q, want %q (its texture is the _grey twin of a coloured one)", got, TintWater)
	}

	stone := tbl.Blocks["minecraft:stone"]
	if got := stone.Tint[wildcardFace]; got != TintNone {
		t.Errorf("stone tint = %q, want %q: stone is genuinely grey and has no tint source", got, TintNone)
	}
	if !tbl.Cells[stone.Faces[wildcardFace]].Grey {
		t.Error("stone's cell is not flagged grey; the flag is how a consumer tells an untintable grey from a coloured texture")
	}
}

// TestBuild_TintChannelsAreOnesTheRendererKnows guards the seam: the frontend
// resolves an unrecognised channel silently to white, so a channel invented
// here would show up as a texture that is quietly never tinted rather than as
// an error. The list is frontend/src/colors.ts's TINT_CHANNELS.
func TestBuild_TintChannelsAreOnesTheRendererKnows(t *testing.T) {
	known := map[string]bool{
		"none": true, "grass": true, "foliage": true, "dry_foliage": true,
		"water": true, "evergreen": true, "birch": true,
	}
	tbl := buildFixture(t).Table
	for channel := range tbl.Tints {
		if !known[channel] {
			t.Errorf("tint channel %q is not one frontend/src/colors.ts knows how to multiply", channel)
		}
	}
	for id, blk := range tbl.Blocks {
		for face, channel := range blk.Tint {
			if !known[channel] {
				t.Errorf("%s.%s uses unknown tint channel %q", id, face, channel)
			}
		}
	}
}

// TestBuild_VariantsKeepEveryLegacyTexture is what a block-state table needs
// and a single first-entry lookup cannot give it.
func TestBuild_VariantsKeepEveryLegacyTexture(t *testing.T) {
	tbl := buildFixture(t).Table
	multi, ok := tbl.Variants["multi"]
	if !ok {
		t.Fatal("a two-path terrain key produced no variants entry")
	}
	if len(multi) != 2 || multi[0] == multi[1] {
		t.Fatalf("variants[multi] = %v, want two distinct cells", multi)
	}
	if tbl.Textures["multi"] != multi[0] {
		t.Fatalf("textures[multi] = %d, want the first variant %d", tbl.Textures["multi"], multi[0])
	}
	if _, ok := tbl.Variants["stone"]; ok {
		t.Error("a single-path key should not appear in variants")
	}
}

// TestBuild_MissesAreRecordedNotSwallowed: an atlas that silently drops a
// texture family looks exactly like one that never had it.
func TestBuild_MissesAreRecordedNotSwallowed(t *testing.T) {
	built := buildFixture(t)
	tbl := built.Table

	if _, ok := tbl.Blocks["minecraft:nothing_at_all"]; ok {
		t.Error("a block with no blocks.json entry was emitted anyway")
	}
	var sawUnbound, sawBrokenKey bool
	for _, m := range tbl.Misses.Blocks {
		if m.ID == "minecraft:nothing_at_all" {
			sawUnbound = true
		}
		if m.ID == "minecraft:broken" {
			sawBrokenKey = true
		}
	}
	if !sawUnbound {
		t.Error("the unbound block is not in misses.blocks")
	}
	if !sawBrokenKey {
		t.Error("a block whose only texture key does not exist is not in misses.blocks")
	}
	var sawKeyMiss bool
	for _, m := range tbl.Misses.Textures {
		if m.Key == "no_such_key" {
			sawKeyMiss = true
		}
	}
	if !sawKeyMiss {
		t.Error("the dangling texture key is not in misses.textures")
	}
	if built.Stats.BlocksMissing != 2 {
		t.Errorf("BlocksMissing = %d, want 2", built.Stats.BlocksMissing)
	}
}

// TestBuild_Deterministic: the same pack must produce the same two bytes, or
// a cached atlas can never be compared with a fresh one.
func TestBuild_Deterministic(t *testing.T) {
	root := fixturePack(t)
	opts := Options{Root: root, Tag: "fixture", BlockIDs: fixtureIDs()}
	a, err := Build(opts)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Build(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.PNG, b.PNG) {
		t.Error("atlas.png differs between two builds of the same pack")
	}
	if !bytes.Equal(a.TableJSON(), b.TableJSON()) {
		t.Error("atlas.json differs between two builds of the same pack")
	}
	if a.Stats != b.Stats {
		t.Errorf("stats differ: %+v vs %+v", a.Stats, b.Stats)
	}
}

func TestBuilt_WriteDirWritesBothFiles(t *testing.T) {
	built := buildFixture(t)
	dir := filepath.Join(t.TempDir(), "atlas")
	if err := built.WriteDir(dir); err != nil {
		t.Fatal(err)
	}
	// The two names are the contract wire/atlas.go reads back.
	table, err := os.ReadFile(filepath.Join(dir, "atlas.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(table) {
		t.Fatal("atlas.json is not valid JSON")
	}
	if _, err := os.Stat(filepath.Join(dir, "atlas.png")); err != nil {
		t.Fatal(err)
	}
}

// TestBuild_TerrainEntryThatCannotBeReadIsAMissNotAFailure: rptex skips a
// terrain_texture.json entry it cannot make a path out of rather than failing
// the file (a pack using one shape this port had not implemented used to lose
// every texture it shipped). The atlas must still be built, and the skipped key
// must appear in Misses -- an atlas that silently drops a texture family looks
// exactly like one that never had it.
func TestBuild_TerrainEntryThatCannotBeReadIsAMissNotAFailure(t *testing.T) {
	root := fixturePack(t)
	terrainPath := filepath.Join(root, "textures", "terrain_texture.json")
	raw, err := os.ReadFile(terrainPath)
	if err != nil {
		t.Fatal(err)
	}
	// One entry naming no path at all, spliced in beside the fixture's own.
	patched := strings.Replace(string(raw), `"texture_data": {`,
		`"texture_data": {`+"\n"+`    "gibberish": { "textures": {"no_path_here": true} },`, 1)
	if patched == string(raw) {
		t.Fatal("fixture terrain_texture.json changed shape; this test's splice no longer applies")
	}
	if err := os.WriteFile(terrainPath, []byte(patched), 0o644); err != nil {
		t.Fatal(err)
	}

	built, err := Build(Options{Root: root, Tag: "fixture", BlockIDs: fixtureIDs()})
	if err != nil {
		t.Fatalf("Build: %v -- one unreadable entry must not fail the whole file", err)
	}
	if _, ok := built.Table.Textures["stone"]; !ok {
		t.Error("stone is missing: an unrelated entry's problem took the rest of the file with it")
	}
	var reason string
	for _, m := range built.Table.Misses.Textures {
		if m.Key == "gibberish" {
			reason = m.Reason
		}
	}
	if reason == "" {
		t.Fatal("the skipped entry is in no miss; it was dropped with nothing said about it")
	}
}

func TestBuild_RejectsAMissingRoot(t *testing.T) {
	if _, err := Build(Options{Root: filepath.Join(t.TempDir(), "nope")}); err == nil {
		t.Error("Build accepted a root that does not exist")
	}
}

// TestBuild_PackSuppliedBlocksAndTextures covers Piece E's path: a behaviour
// pack's custom blocks are in no blocks.json at all, their faces come from
// minecraft:material_instances, and some of the texture keys they name are
// vanilla ones they merely reuse.
func TestBuild_PackSuppliedBlocksAndTextures(t *testing.T) {
	root := fixturePack(t)

	// One texture that belongs to the pack, living outside the resource pack
	// this Build reads.
	packDir := t.TempDir()
	writePNG(t, packDir, "textures/blocks/custom", 16, 16, flat(color.NRGBA{200, 40, 40, 255}))
	custom, err := rptex.FindTexture(packDir, "textures/blocks/custom")
	if err != nil {
		t.Fatal(err)
	}

	built, err := Build(Options{
		Root:     root,
		BlockIDs: fixtureIDs(),
		ExtraTextures: map[string]ExtraTexture{
			"custom": {File: custom},
			// A vanilla key the pack reuses: already in the sheet, so this
			// must not add a second cell for it.
			"stone": {File: custom},
		},
		BlockFaces: map[string]map[string]string{
			"pack:machine": {"up": "custom", "side": "stone"},
			"pack:solid":   {"*": "custom"},
		},
		BlockTint:   map[string]map[string]string{"pack:solid": {"*": "water"}},
		BlockRender: map[string]string{"pack:solid": RenderTranslucent},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	tbl := built.Table

	if built.Stats.ExtraCells != 1 {
		t.Errorf("ExtraCells = %d, want 1: a vanilla key the pack reuses must not be packed twice", built.Stats.ExtraCells)
	}
	machine, ok := tbl.Blocks["pack:machine"]
	if !ok {
		t.Fatal("a block supplied through BlockFaces is not in the table")
	}
	if machine.Keys["up"] != "custom" || machine.Keys["north"] != "stone" {
		t.Errorf("pack:machine keys = %v, want up=custom and the cardinals filled from \"side\"", machine.Keys)
	}
	if tbl.Cells[machine.Faces["north"]].Path != "textures/blocks/stone" {
		t.Errorf("pack:machine's side did not resolve to the vanilla stone cell: %v", tbl.Cells[machine.Faces["north"]])
	}

	solid := tbl.Blocks["pack:solid"]
	if got := solid.Tint[wildcardFace]; got != "water" {
		t.Errorf("pack:solid tint = %q, want the pack's own declared channel", got)
	}
	if solid.Render != RenderTranslucent {
		t.Errorf("pack:solid render = %q, want the pack's own declared method to beat the measurement", solid.Render)
	}
	// The vanilla blocks are still all there.
	if _, ok := tbl.Blocks["minecraft:grass"]; !ok {
		t.Error("supplying pack blocks dropped the vanilla ones")
	}
}

// TestBuild_ExtraTextureOverlayIsBaked: a pack that writes one overlay_color
// against one key has declared a constant, not a biome channel, so it is
// multiplied in rather than carried as a channel name the renderer would
// resolve to white.
func TestBuild_ExtraTextureOverlayIsBaked(t *testing.T) {
	packDir := t.TempDir()
	writePNG(t, packDir, "textures/blocks/plain", 16, 16, flat(color.NRGBA{200, 200, 200, 255}))
	file, err := rptex.FindTexture(packDir, "textures/blocks/plain")
	if err != nil {
		t.Fatal(err)
	}
	built, err := Build(Options{
		Root:          fixturePack(t),
		BlockIDs:      []string{},
		ExtraTextures: map[string]ExtraTexture{"plain": {File: file, Overlay: "#ff8000"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cell := built.Table.Cells[built.Table.Textures["plain"]]
	if cell.Overlay != "#ff8000" {
		t.Errorf("cell overlay = %q, want it recorded so a reader can tell a baked tint from a real one", cell.Overlay)
	}
	got, err := rptex.ParseHex(cell.Color)
	if err != nil {
		t.Fatal(err)
	}
	if got.R != 200 || got.G < 95 || got.G > 105 || got.B != 0 {
		t.Errorf("baked colour = %v, want ~(200,100,0): 200 multiplied by #ff8000", got)
	}
}

// TestBuild_ExtraTextureFlatColourSynthesisesACell is the texture-set outcome
// that has no art at all: the pack declared the face's colour in a
// <name>.texture_set.json and shipped no image for it. The colour still has to
// reach the sheet as a real cell, or the block goes back to the hash colour
// the author was trying to get away from.
func TestBuild_ExtraTextureFlatColourSynthesisesACell(t *testing.T) {
	built, err := Build(Options{
		Root:     fixturePack(t),
		BlockIDs: []string{},
		ExtraTextures: map[string]ExtraTexture{
			"flat":  {Color: "#102030"},
			"sheer": {Color: "#10203080"},
			// Neither a file nor a colour is still a miss, and still says so.
			"empty": {},
		},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	tbl := built.Table

	cell := tbl.Cells[tbl.Textures["flat"]]
	if got, err := rptex.ParseHex(cell.Color); err != nil || got != (rptex.RGB{R: 0x10, G: 0x20, B: 0x30}) {
		t.Errorf("cell colour = %q (%v), want #102030", cell.Color, err)
	}
	if cell.Render != RenderOpaque {
		t.Errorf("render = %q, want opaque for a fully opaque flat colour", cell.Render)
	}
	if cell.Scaled != 1 {
		t.Errorf("Scaled = %d, want 1: one texel upscaled to fill the cell", cell.Scaled)
	}
	if !strings.Contains(cell.Path, "#102030") {
		t.Errorf("cell path = %q, want it to read as the flat colour it is rather than as a file", cell.Path)
	}

	// The declared alpha is part of the declaration, and it is what decides
	// which pass the face is drawn in.
	if got := tbl.Cells[tbl.Textures["sheer"]].Render; got != RenderTranslucent {
		t.Errorf("render = %q, want translucent for a flat colour declared at alpha 0x80", got)
	}

	if _, packed := tbl.Textures["empty"]; packed {
		t.Error("a key with neither a file nor a colour was packed; it must be a miss")
	}
	var said bool
	for _, m := range tbl.Misses.Textures {
		if m.Key == "empty" && strings.Contains(m.Reason, "flat colour") {
			said = true
		}
	}
	if !said {
		t.Errorf("misses = %+v, want one for \"empty\" saying neither form was supplied", tbl.Misses.Textures)
	}
}
