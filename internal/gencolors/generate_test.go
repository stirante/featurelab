package gencolors

import (
	"encoding/json"
	"image/color"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestParseTextureShape(t *testing.T) {
	t.Run("flat string", func(t *testing.T) {
		shape, ok := parseTextureShape(json.RawMessage(`"stone"`))
		if !ok || shape.Flat != "stone" || shape.Faces != nil {
			t.Fatalf("got %+v ok=%v, want flat=stone", shape, ok)
		}
	})
	t.Run("per-face object", func(t *testing.T) {
		shape, ok := parseTextureShape(json.RawMessage(`{"up":"grass_top","down":"grass_bottom","side":"grass_side"}`))
		if !ok || shape.Flat != "" || len(shape.Faces) != 3 || shape.Faces["up"] != "grass_top" {
			t.Fatalf("got %+v ok=%v", shape, ok)
		}
	})
	t.Run("absent field", func(t *testing.T) {
		if _, ok := parseTextureShape(nil); ok {
			t.Fatal("parseTextureShape(nil) ok = true, want false")
		}
	})
	t.Run("empty string", func(t *testing.T) {
		if _, ok := parseTextureShape(json.RawMessage(`""`)); ok {
			t.Fatal("parseTextureShape(\"\") ok = true, want false")
		}
	})
}

func TestCarriedKeyFor(t *testing.T) {
	dictCarried, _ := parseTextureShape(json.RawMessage(`{"up":"grass_carried_top","side":"grass_carried_side"}`))
	if got := carriedKeyFor(dictCarried, true, "up"); got != "grass_carried_top" {
		t.Fatalf("carriedKeyFor(dict, up) = %q, want grass_carried_top", got)
	}
	if got := carriedKeyFor(dictCarried, true, "down"); got != "" {
		t.Fatalf("carriedKeyFor(dict, down) = %q, want empty (no entry for that face)", got)
	}

	flatCarried, _ := parseTextureShape(json.RawMessage(`"leaves_carried"`))
	if got := carriedKeyFor(flatCarried, true, "up"); got != "leaves_carried" {
		t.Fatalf("carriedKeyFor(flat, up) = %q, want leaves_carried", got)
	}
	if got := carriedKeyFor(flatCarried, true, "north"); got != "leaves_carried" {
		t.Fatalf("carriedKeyFor(flat, north) = %q, want leaves_carried applied uniformly to every face", got)
	}

	if got := carriedKeyFor(dictCarried, false, "up"); got != "" {
		t.Fatalf("carriedKeyFor(_, hasCarried=false, _) = %q, want empty", got)
	}
}

func TestBuildResourceKeyFallback(t *testing.T) {
	fallback := buildResourceKeyFallback()

	// Simple alias: minecraft:grass -> minecraft:grass_block.
	if got := fallback["minecraft:grass_block"]; got != "grass" {
		t.Errorf(`fallback["minecraft:grass_block"] = %q, want "grass"`, got)
	}
	// Tree-complex aliases: every leaf/log species must reverse back to
	// its legacy aggregate resource key. This is the fix that lets
	// oak_leaves (explicitly a sanity-check block) get a colour at all --
	// without it, oak_leaves has no resource_pack entry anywhere.
	for target, wantKey := range map[string]string{
		"minecraft:oak_leaves":      "leaves",
		"minecraft:spruce_leaves":   "leaves",
		"minecraft:birch_leaves":    "leaves",
		"minecraft:jungle_leaves":   "leaves",
		"minecraft:acacia_leaves":   "leaves2",
		"minecraft:dark_oak_leaves": "leaves2",
		"minecraft:oak_log":         "log",
		"minecraft:acacia_log":      "log2",
	} {
		if got := fallback[target]; got != wantKey {
			t.Errorf("fallback[%q] = %q, want %q", target, got, wantKey)
		}
	}
}

// writeFile writes body to path, creating parent directories as needed.
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// buildSyntheticFixture assembles a complete, self-contained input tree
// (texture root + rp_blocks.json + terrain_texture.json + a small
// block/vanilla/blocks-shaped directory) under t.TempDir(), exercising
// every non-trivial code path in Generate without depending on a real
// bedrock-samples checkout: overlay application, alpha-skip averaging,
// first-entry multi-path resolution, the achromatic-gated carried-texture
// fallback, tree-alias reverse resolution (a real alias, from block.go),
// a texture key missing from the terrain index, a path with no file on
// disk, and a block with no rp_blocks.json entry at all.
func buildSyntheticFixture(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	textureRoot := filepath.Join(dir, "bedrock-samples", "resource_pack")

	writePNG(t, filepath.Join(textureRoot, "textures/blocks/stone.png"), 2, 2, solid(color.NRGBA{125, 125, 125, 255}))
	writePNG(t, filepath.Join(textureRoot, "textures/blocks/dirt.png"), 2, 2, solid(color.NRGBA{134, 96, 67, 255}))
	writePNG(t, filepath.Join(textureRoot, "textures/blocks/grass_top.png"), 2, 2, solid(color.NRGBA{147, 147, 147, 255}))
	writePNG(t, filepath.Join(textureRoot, "textures/blocks/grass_side.png"), 2, 2, solid(color.NRGBA{154, 154, 154, 255}))
	writePNG(t, filepath.Join(textureRoot, "textures/blocks/grass_carried.png"), 2, 2, solid(color.NRGBA{78, 118, 42, 255}))
	// leaves.png: mostly grey, but with one fully-transparent pixel of a
	// wildly different colour -- if alpha-skip regresses, the average
	// stops being achromatic and the carried-texture fallback (asserted
	// below) stops firing.
	writePNG(t, filepath.Join(textureRoot, "textures/blocks/leaves.png"), 2, 2, func(x, y int) color.NRGBA {
		if x == 0 && y == 0 {
			return color.NRGBA{255, 0, 255, 0}
		}
		return color.NRGBA{144, 144, 144, 255}
	})
	writePNG(t, filepath.Join(textureRoot, "textures/blocks/leaves_carried.png"), 2, 2, solid(color.NRGBA{38, 100, 9, 255}))

	rpBlocksPath := filepath.Join(dir, "rp_blocks.json")
	writeFile(t, rpBlocksPath, `{
		// a comment, to exercise jsonc.StripComments on this file too
		"format_version": [1, 1, 0],
		"stone": { "textures": "stone" },
		"grass": {
			"textures": { "up": "grass_top", "down": "dirt", "side": "grass_side" },
			"carried_textures": { "up": "grass_carried_top", "down": "dirt", "side": "grass_side" }
		},
		"leaves": {
			"textures": "leaves_key",
			"carried_textures": "leaves_carried_key"
		},
		"broken": {
			"textures": "missing_key"
		},
		"unindexed": {
			"textures": "key_not_in_terrain_texture_json"
		}
	}`)

	terrainTexturePath := filepath.Join(dir, "terrain_texture.json")
	writeFile(t, terrainTexturePath, `{
		"texture_data": {
			"stone": { "textures": "textures/blocks/stone" },
			"dirt": { "textures": "textures/blocks/dirt" },
			"grass_top": {
				"textures": [
					"textures/blocks/grass_top",
					{"path": "textures/blocks/grass_carried", "overlay_color": "#000000"}
				]
			},
			"grass_side": { "textures": { "path": "textures/blocks/grass_side", "overlay_color": "#79c05a" } },
			"grass_carried_top": { "textures": "textures/blocks/grass_carried" },
			"leaves_key": { "textures": "textures/blocks/leaves" },
			"leaves_carried_key": { "textures": "textures/blocks/leaves_carried" },
			"missing_key": { "textures": "textures/blocks/does_not_exist" }
		}
	}`)

	blocksDir := filepath.Join(dir, "blocks")
	committed := func(id string) string {
		return `{"minecraft:block":{"description":{"identifier":"` + id + `"}}}`
	}
	writeFile(t, filepath.Join(blocksDir, "minecraft__stone.json"), committed("minecraft:stone"))
	// grass_block only reaches the "grass" rp_blocks.json entry through
	// the REAL simple alias in block/aliases.go (minecraft:grass ->
	// minecraft:grass_block).
	writeFile(t, filepath.Join(blocksDir, "minecraft__grass_block.json"), committed("minecraft:grass_block"))
	// oak_leaves only reaches the "leaves" rp_blocks.json entry through
	// the REAL tree-complex alias in block/aliases.go.
	writeFile(t, filepath.Join(blocksDir, "minecraft__oak_leaves.json"), committed("minecraft:oak_leaves"))
	writeFile(t, filepath.Join(blocksDir, "minecraft__broken.json"), committed("minecraft:broken"))
	writeFile(t, filepath.Join(blocksDir, "minecraft__unindexed.json"), committed("minecraft:unindexed"))
	writeFile(t, filepath.Join(blocksDir, "minecraft__totally_unknown.json"), committed("minecraft:totally_unknown"))

	return Config{
		TextureRoot:        textureRoot,
		RPBlocksPath:       rpBlocksPath,
		TerrainTexturePath: terrainTexturePath,
		BlocksDir:          blocksDir,
		OutputPath:         filepath.Join(dir, "out", "colors.json"),
	}
}

func TestGenerate_Synthetic(t *testing.T) {
	cfg := buildSyntheticFixture(t)
	summary, err := Generate(cfg)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if summary.Blocks != 6 {
		t.Fatalf("summary.Blocks = %d, want 6", summary.Blocks)
	}
	if summary.BlocksWithColor != 3 {
		t.Fatalf("summary.BlocksWithColor = %d, want 3 (stone, grass_block, oak_leaves)", summary.BlocksWithColor)
	}
	if summary.BlocksWithoutColor != 3 {
		t.Fatalf("summary.BlocksWithoutColor = %d, want 3 (broken, unindexed, totally_unknown)", summary.BlocksWithoutColor)
	}

	data, err := os.ReadFile(cfg.OutputPath)
	if err != nil {
		t.Fatalf("reading output: %v", err)
	}
	var table ColorTable
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatalf("decoding output: %v", err)
	}

	stone := table.Blocks["minecraft:stone"]
	if stone.Color != "#7d7d7d" {
		t.Errorf("stone.Color = %q, want #7d7d7d", stone.Color)
	}
	if stone.Notes["color"] != noteGreyscaleNoFallback {
		t.Errorf("stone.Notes[color] = %q, want the plain greyscale note", stone.Notes["color"])
	}

	grass := table.Blocks["minecraft:grass_block"]
	// Hand-computed, independently of applyOverlay: 154*0x79/255=73 (0x49),
	// 154*0xc0/255=115 (0x73), 154*0x5a/255=54 (0x36).
	if grass.Faces["side"] != "#497336" {
		t.Errorf("grass_block.Faces[side] = %q, want the overlay-tinted side colour #497336", grass.Faces["side"])
	}
	if grass.Faces["down"] != "#866043" {
		t.Errorf("grass_block.Faces[down] = %q, want dirt's own colour #866043", grass.Faces["down"])
	}
	if grass.Faces["up"] != "#4e762a" {
		t.Errorf("grass_block.Faces[up] = %q, want the carried-texture fallback colour #4e762a "+
			"(proves multi-path first-entry selection: the array's second entry would have produced black)", grass.Faces["up"])
	}
	if grass.Notes["up"] != noteCarriedFallback {
		t.Errorf("grass_block.Notes[up] = %q, want the carried-fallback note", grass.Notes["up"])
	}
	if _, sideNoted := grass.Notes["side"]; sideNoted {
		t.Errorf("grass_block.Notes[side] should be absent (own overlay needs no fallback note), got %q", grass.Notes["side"])
	}

	leaves := table.Blocks["minecraft:oak_leaves"]
	if leaves.Color != "#266409" {
		t.Errorf("oak_leaves.Color = %q, want #266409 (proves both alpha-skip and tree-alias resolution)", leaves.Color)
	}
	if leaves.Notes["color"] != noteCarriedFallback {
		t.Errorf("oak_leaves.Notes[color] = %q, want the carried-fallback note", leaves.Notes["color"])
	}

	missIDs := make([]string, len(table.Misses.BlocksWithoutColor))
	for i, m := range table.Misses.BlocksWithoutColor {
		missIDs[i] = m.ID
	}
	sort.Strings(missIDs)
	wantMissIDs := []string{"minecraft:broken", "minecraft:totally_unknown", "minecraft:unindexed"}
	if len(missIDs) != len(wantMissIDs) {
		t.Fatalf("blocks_without_color = %v, want %v", missIDs, wantMissIDs)
	}
	for i := range wantMissIDs {
		if missIDs[i] != wantMissIDs[i] {
			t.Errorf("blocks_without_color[%d] = %q, want %q", i, missIDs[i], wantMissIDs[i])
		}
	}

	if len(table.Misses.UnavailableTextures) != 2 {
		t.Fatalf("unavailable_textures = %+v, want 2 entries (missing_key's file, unindexed's key)", table.Misses.UnavailableTextures)
	}
	unavailableKeys := map[string]bool{}
	for _, m := range table.Misses.UnavailableTextures {
		unavailableKeys[m.Key] = true
	}
	if !unavailableKeys["missing_key"] || !unavailableKeys["key_not_in_terrain_texture_json"] {
		t.Errorf("unavailable_textures keys = %v, want missing_key and key_not_in_terrain_texture_json", unavailableKeys)
	}

	if len(table.Notes) == 0 {
		t.Error("table.Notes is empty; the committed output must document alpha/overlay/multi-path/fallback handling in-line")
	}
}

func TestGenerate_SyntheticDeterministic(t *testing.T) {
	cfg := buildSyntheticFixture(t)
	outA := cfg.OutputPath
	if _, err := Generate(cfg); err != nil {
		t.Fatalf("Generate (run A): %v", err)
	}
	bytesA, err := os.ReadFile(outA)
	if err != nil {
		t.Fatal(err)
	}

	cfg.OutputPath = filepath.Join(filepath.Dir(outA), "colors_b.json")
	if _, err := Generate(cfg); err != nil {
		t.Fatalf("Generate (run B): %v", err)
	}
	bytesB, err := os.ReadFile(cfg.OutputPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(bytesA) != string(bytesB) {
		t.Fatalf("Generate is not deterministic:\n--- A ---\n%s\n--- B ---\n%s", bytesA, bytesB)
	}
}

func TestGenerate_RequiresTextureRoot(t *testing.T) {
	cfg := buildSyntheticFixture(t)
	cfg.TextureRoot = ""
	if _, err := Generate(cfg); err == nil {
		t.Fatal("Generate with empty TextureRoot: expected error, got nil")
	}
}

func TestGenerate_RejectsNonexistentTextureRoot(t *testing.T) {
	cfg := buildSyntheticFixture(t)
	cfg.TextureRoot = filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := Generate(cfg); err == nil {
		t.Fatal("Generate with nonexistent TextureRoot: expected error, got nil")
	}
}
