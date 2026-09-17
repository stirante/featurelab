package atlas

import (
	"bytes"
	"image/png"
	"os"
	"sync"
	"testing"

	"github.com/stirante/featurelab/internal/rptex"
)

// realRoot locates a local bedrock-samples checkout, the same way
// internal/gencolors' real-data tests do. It is not part of this repository
// and CI has no reason to have one, so every test that needs it skips
// cleanly when it is absent rather than failing the build. No test here
// touches the network.
func realRoot(t *testing.T) string {
	t.Helper()
	root := os.Getenv("GENCOLORS_TEXTURE_ROOT")
	if root == "" {
		t.Skip("GENCOLORS_TEXTURE_ROOT is not set; this test needs a local resource pack")
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Skipf("texture root %s not available locally (set GENCOLORS_TEXTURE_ROOT to override): %v", root, err)
	}
	return root
}

// buildReal builds the real vanilla atlas once and shares it across the
// tests in this file. Building it costs a couple of seconds and every test
// here only reads the result, so doing it per-test would multiply the cost of
// `go test ./...` for nothing. TestBuild_RealData_Deterministic builds its own
// pair, since sharing one would defeat the point of that test.
var realOnce struct {
	sync.Once
	built *Built
	err   error
}

func buildReal(t *testing.T) *Built {
	t.Helper()
	root := realRoot(t)
	realOnce.Do(func() {
		realOnce.built, realOnce.err = Build(Options{Root: root, Tag: "local-checkout"})
	})
	if realOnce.err != nil {
		t.Fatalf("Build: %v", realOnce.err)
	}
	return realOnce.built
}

// TestBuild_RealData_NotDegenerate is the "is this actually doing anything"
// floor. Every bound here is far below what a healthy vanilla pack produces
// (1275 cells, 1164 fully-faced blocks as measured against v1.26.30.5), so it
// catches a wholesale failure -- a resolver returning nothing, a decoder
// rejecting every file -- without pinning numbers that move with every
// Minecraft release.
func TestBuild_RealData_NotDegenerate(t *testing.T) {
	built := buildReal(t)
	s := built.Stats
	t.Logf("%d keys / %d paths -> %d cells (%d paths and %d keys unresolved); "+
		"%d blocks -> %d full, %d partial, %d unbound; %d grey cells, %d tinted faces, %d untinted greys; png %d bytes, table %d bytes",
		s.TextureKeys, s.TexturePaths, s.CellsPacked, s.TexturePathsBad, s.TextureKeysBad,
		s.Blocks, s.BlocksFull, s.BlocksPartial, s.BlocksMissing,
		s.GreyCells, s.TintedFaces, s.UntintedGrey, len(built.PNG), len(built.TableJSON()))

	if s.CellsPacked < 900 {
		t.Errorf("only %d textures packed; a vanilla pack has well over a thousand", s.CellsPacked)
	}
	if s.BlocksFull < 800 {
		t.Errorf("only %d blocks got all six faces", s.BlocksFull)
	}
	if s.TintedFaces == 0 {
		t.Error("no block face got a tint channel: grass and leaves would render grey, which is the single failure this table exists to prevent")
	}
	if s.TexturePathsBad == 0 {
		t.Error("no texture path failed to resolve; vanilla has a handful that cannot be packed and they must be recorded, not silently succeeded")
	}
	if len(built.Table.Variants) < 100 {
		t.Errorf("only %d multi-variant texture keys; the legacy per-data-value lists a block-state table needs are missing", len(built.Table.Variants))
	}
}

// TestBuild_RealData_SanityFaces is the acceptance check the contract spells
// out: a grass block is not one texture, its greyscale faces are tinted, and
// water is translucent.
func TestBuild_RealData_SanityFaces(t *testing.T) {
	tbl := buildReal(t).Table

	grass, ok := tbl.Blocks["minecraft:grass_block"]
	if !ok {
		t.Fatal("minecraft:grass_block is not in the table")
	}
	if _, wildcard := grass.Faces[wildcardFace]; wildcard {
		t.Fatal("grass_block collapsed to a single texture; its top, bottom and sides are three different ones")
	}
	if grass.Faces["up"] == grass.Faces["north"] || grass.Faces["up"] == grass.Faces["down"] {
		t.Errorf("grass_block faces are not distinct: %v", grass.Faces)
	}
	if grass.Tint["up"] != TintGrass || grass.Tint["north"] != TintGrass {
		t.Errorf("grass_block tints = %v, want the top and sides on the grass channel", grass.Tint)
	}

	leaves, ok := tbl.Blocks["minecraft:oak_leaves"]
	if !ok {
		t.Fatal("minecraft:oak_leaves is not in the table -- the tree-alias species resolution regressed")
	}
	if channel := faceValue(leaves.Tint, "north"); channel == TintNone {
		t.Errorf("oak_leaves is untinted (%v); vanilla ships it greyscale and it renders grey without a multiply", leaves.Tint)
	}
	if leaves.Render != RenderCutout {
		t.Errorf("oak_leaves render = %q, want %q", leaves.Render, RenderCutout)
	}

	water, ok := tbl.Blocks["minecraft:water"]
	if !ok {
		t.Fatal("minecraft:water is not in the table")
	}
	if water.Render != RenderTranslucent {
		t.Errorf("water render = %q, want %q", water.Render, RenderTranslucent)
	}
	if channel := faceValue(water.Tint, "up"); channel != TintWater {
		t.Errorf("water up tint = %q, want %q", channel, TintWater)
	}

	stone, ok := tbl.Blocks["minecraft:stone"]
	if !ok {
		t.Fatal("minecraft:stone is not in the table")
	}
	if stone.Render != RenderOpaque {
		t.Errorf("stone render = %q, want %q", stone.Render, RenderOpaque)
	}
}

// faceValue reads a per-face map that may have been collapsed to a wildcard.
func faceValue(m map[string]string, face string) string {
	if v, ok := m[face]; ok {
		return v
	}
	return m[wildcardFace]
}

// TestBuild_RealData_SheetIsConsistent walks the whole sheet: the geometry the
// table claims, every face index in range, and the border actually duplicated.
// A texture atlas is exactly the kind of artifact that is plausibly wrong in a
// way no single assertion catches.
func TestBuild_RealData_SheetIsConsistent(t *testing.T) {
	built := buildReal(t)
	tbl := built.Table
	img, err := png.Decode(bytes.NewReader(built.PNG))
	if err != nil {
		t.Fatalf("the atlas this package just produced does not decode: %v", err)
	}
	if got := img.Bounds(); got.Dx() != tbl.Cols*tbl.Stride || got.Dy() != tbl.Rows*tbl.Stride {
		t.Fatalf("atlas image %v does not match the %dx%d grid of %d the table describes", got, tbl.Cols, tbl.Rows, tbl.Stride)
	}
	cellCount := tbl.Cols * tbl.Rows
	for id, blk := range tbl.Blocks {
		for face, idx := range blk.Faces {
			if idx < 0 || idx >= len(tbl.Cells) || idx >= cellCount {
				t.Fatalf("%s.%s points at cell %d, outside the %d cells the sheet holds", id, face, idx, len(tbl.Cells))
			}
		}
	}
	for key, idx := range tbl.Textures {
		if idx < 0 || idx >= len(tbl.Cells) {
			t.Fatalf("texture key %q points at cell %d, out of range", key, idx)
		}
	}

	// The border is what stops one cell bleeding into the next under any
	// filtering, and it is invisible at 1:1 -- so it gets checked here rather
	// than by looking at the picture.
	for _, i := range []int{0, len(tbl.Cells) / 2, len(tbl.Cells) - 1} {
		c := tbl.Cells[i]
		for _, probe := range []struct{ dx, dy, sx, sy int }{
			{-1, 0, 0, 0}, {tbl.Cell, 0, tbl.Cell - 1, 0},
			{0, -1, 0, 0}, {0, tbl.Cell, 0, tbl.Cell - 1},
		} {
			got := img.At(c.X+probe.dx, c.Y+probe.dy)
			want := img.At(c.X+probe.sx, c.Y+probe.sy)
			if got != want {
				t.Errorf("cell %d (%s): border pixel at +(%d,%d) is %v, not a copy of the edge texel %v",
					i, c.Path, probe.dx, probe.dy, got, want)
			}
		}
	}
}

// TestBuild_RealData_TGAsAreRightWayUp is the check that caught the one real
// bug this work found. Every .tga in bedrock-samples is bottom-origin, and a
// decoder that ignores the descriptor bit returns all 51 of them upside down
// -- grass_side among them, which would put the grass fringe at the bottom of
// every grass block's sides. It went unnoticed for as long as the only
// consumer averaged whole textures.
func TestBuild_RealData_TGAsAreRightWayUp(t *testing.T) {
	root := realRoot(t)
	built := buildReal(t)
	img, err := png.Decode(bytes.NewReader(built.PNG))
	if err != nil {
		t.Fatal(err)
	}
	var cell *Cell
	for i := range built.Table.Cells {
		if built.Table.Cells[i].Path == "textures/blocks/grass_side" {
			cell = &built.Table.Cells[i]
		}
	}
	if cell == nil {
		t.Skip("this pack has no textures/blocks/grass_side to check")
	}
	source, ext, err := rptex.LoadImage(root, cell.Path)
	if err != nil {
		t.Fatal(err)
	}
	if ext != ".tga" {
		t.Skipf("grass_side is %s here, not a .tga; nothing to check", ext)
	}
	for y := 0; y < built.Table.Cell; y++ {
		for x := 0; x < built.Table.Cell; x++ {
			want := source.At(x, y)
			got := img.At(cell.X+x, cell.Y+y)
			wr, wg, wb, wa := want.RGBA()
			gr, gg, gb, ga := got.RGBA()
			if wr != gr || wg != gg || wb != gb || wa != ga {
				t.Fatalf("grass_side pixel (%d,%d): atlas has %v, source has %v", x, y, got, want)
			}
		}
	}
	// The vanilla grass side is the fringe overlay: opaque along the top,
	// transparent below. If the flip were wrong this would be inverted.
	opaqueRow := func(y int) int {
		n := 0
		for x := 0; x < built.Table.Cell; x++ {
			if _, _, _, a := img.At(cell.X+x, cell.Y+y).RGBA(); a > 0 {
				n++
			}
		}
		return n
	}
	if top, bottom := opaqueRow(0), opaqueRow(built.Table.Cell-1); top <= bottom {
		t.Errorf("grass_side has %d opaque texels in its top row and %d in its bottom; vanilla's fringe hangs from the TOP, so this is upside down", top, bottom)
	}
}

// TestBuild_RealData_Deterministic: a cached atlas is only useful if a fresh
// build of the same pack is the same bytes.
func TestBuild_RealData_Deterministic(t *testing.T) {
	root := realRoot(t)
	opts := Options{Root: root, Tag: "local-checkout"}
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
}
