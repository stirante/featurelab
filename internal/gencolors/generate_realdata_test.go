package gencolors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// realTextureRoot locates a local bedrock-samples checkout. It is not part
// of this repository (see the package doc comment) and CI has no reason to
// have one, so every test that needs it skips cleanly when it is absent
// rather than failing the build.
func realTextureRoot(t *testing.T) string {
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

// realConfig builds a Config against the real, checked-in vanilla data
// inputs and the real (external) bedrock-samples texture root.
func realConfig(t *testing.T, outputPath string) Config {
	return Config{
		TextureRoot:        realTextureRoot(t),
		RPBlocksPath:       filepath.Join("..", "..", "scripts", "vanilla-extract", "rp", "rp_blocks.json"),
		TerrainTexturePath: filepath.Join("..", "..", "scripts", "vanilla-extract", "rp", "terrain_texture.json"),
		BlocksDir:          filepath.Join("..", "..", "block", "vanilla", "blocks"),
		OutputPath:         outputPath,
	}
}

// TestGenerate_RealData_Deterministic mirrors
// internal/genvanillablocks's own TestGenerate_Deterministic: running
// Generate twice against the same real inputs must produce byte-identical
// output.
func TestGenerate_RealData_Deterministic(t *testing.T) {
	outA := filepath.Join(t.TempDir(), "a.json")
	outB := filepath.Join(t.TempDir(), "b.json")

	summaryA, err := Generate(realConfig(t, outA))
	if err != nil {
		t.Fatalf("Generate (run A): %v", err)
	}
	summaryB, err := Generate(realConfig(t, outB))
	if err != nil {
		t.Fatalf("Generate (run B): %v", err)
	}
	if summaryA != summaryB {
		t.Fatalf("Summary differs between runs: A=%+v B=%+v", summaryA, summaryB)
	}
	if summaryA.BlocksWithColor == 0 {
		t.Fatal("Generate produced 0 coloured blocks against the real data -- cannot tell a real regression from a degenerate empty run")
	}
	if summaryA.BlocksWithoutColor == 0 {
		t.Fatal("Generate produced 0 misses against the real data -- misses are expected (1238 blocks, 340 rp_blocks.json entries) and this generator must record them, not silently succeed on everything")
	}

	bytesA, err := os.ReadFile(outA)
	if err != nil {
		t.Fatal(err)
	}
	bytesB, err := os.ReadFile(outB)
	if err != nil {
		t.Fatal(err)
	}
	if string(bytesA) != string(bytesB) {
		t.Fatal("Generate is not deterministic against the real data (see the two temp files for a diff)")
	}
}

// TestGenerate_RealData_SanityColors is the generator's acceptance check:
// grass_top and leaves must not come out grey (that would mean the overlay/
// carried-texture handling regressed), while stone/dirt/water must look
// like themselves.
func TestGenerate_RealData_SanityColors(t *testing.T) {
	out := filepath.Join(t.TempDir(), "colors.json")
	if _, err := Generate(realConfig(t, out)); err != nil {
		t.Fatalf("Generate: %v", err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var table ColorTable
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}

	mustColor := func(id string) rgb {
		t.Helper()
		bc, ok := table.Blocks[id]
		if !ok {
			t.Fatalf("%s: no entry in the generated colour table", id)
		}
		hex := bc.Color
		if hex == "" {
			hex = bc.Faces["up"]
		}
		if hex == "" {
			t.Fatalf("%s: no usable colour field in %+v", id, bc)
		}
		c, err := parseHexColor(hex)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		return c
	}

	grassTop := mustColor("minecraft:grass_block")
	if grassTop.Achromatic() {
		t.Errorf("grass_block's up face = %+v is grey -- the overlay/carried-texture handling regressed (vanilla grass_top.png IS grey pre-tint, this generator must not leave it that way)", grassTop)
	}
	if grassTop.G <= grassTop.R || grassTop.G <= grassTop.B {
		t.Errorf("grass_block's up face = %+v is not green-dominant", grassTop)
	}

	leaves := mustColor("minecraft:oak_leaves")
	if leaves.Achromatic() {
		t.Errorf("oak_leaves = %+v is grey -- the overlay/carried-texture handling regressed", leaves)
	}
	if leaves.G <= leaves.R || leaves.G <= leaves.B {
		t.Errorf("oak_leaves = %+v is not green-dominant", leaves)
	}

	stone := mustColor("minecraft:stone")
	if !stone.Achromatic() {
		t.Errorf("stone = %+v should be a literal grey (no overlay, no carried_textures)", stone)
	}

	dirt := mustColor("minecraft:dirt")
	if dirt.R <= dirt.G || dirt.G <= dirt.B {
		t.Errorf("dirt = %+v is not brown (want R > G > B)", dirt)
	}

	water := mustColor("minecraft:water")
	// Water has no overlay_color and no carried_textures anywhere in the
	// data chain (it is not a placeable-from-inventory item), so it stays
	// a literal grey -- unlike grass/leaves, this is expected: this generator
	// does not invent a blue it has no data for.
	if !water.Achromatic() {
		t.Errorf("water = %+v expected to be a literal grey given no overlay/carried-texture data is available for it", water)
	}

	t.Logf("sanity colours: grass_top=%s oak_leaves=%s stone=%s dirt=%s water=%s",
		grassTop.Hex(), leaves.Hex(), stone.Hex(), dirt.Hex(), water.Hex())
}
