package env

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/volume"
)

// ---------------------------------------------------------------------------
// MergeMaterialSlots / InternMaterialSlots.
// ---------------------------------------------------------------------------

func stoneSlots() MaterialSlots {
	return MaterialSlots{
		TopMaterial: "minecraft:stone", MidMaterial: "minecraft:stone", FoundationMaterial: "minecraft:stone",
		SeaFloorMaterial: "minecraft:gravel", SeaMaterial: "minecraft:water", SeaFloorDepth: 0,
	}
}

func TestMergeMaterialSlots_NilOverrideReturnsBaseUnchanged(t *testing.T) {
	base := stoneSlots()
	merged := MergeMaterialSlots(base, nil)
	if merged != base {
		t.Errorf("MergeMaterialSlots(base, nil) = %+v, want %+v", merged, base)
	}
}

func TestMergeMaterialSlots_OverrideWinsPerField(t *testing.T) {
	base := MaterialSlots{
		TopMaterial: "minecraft:grass_block", MidMaterial: "minecraft:dirt", FoundationMaterial: "minecraft:stone",
		SeaFloorMaterial: "minecraft:gravel", SeaMaterial: "minecraft:water", SeaFloorDepth: 0,
	}
	top := "minecraft:basalt"
	depth := 3.0
	merged := MergeMaterialSlots(base, &MaterialOverride{TopMaterial: &top, SeaFloorDepth: &depth})
	want := base
	want.TopMaterial = "minecraft:basalt"
	want.SeaFloorDepth = 3
	if merged != want {
		t.Errorf("merged = %+v, want %+v", merged, want)
	}
}

func TestInternMaterialSlots_NoWarningsForRecognizedNames(t *testing.T) {
	palette := block.NewPalette()
	var warnings []string
	resolved := InternMaterialSlots(palette, stoneSlots(), func(m string) { warnings = append(warnings, m) })
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}
	if got := palette.NameOf(resolved.Top); got != "minecraft:stone" {
		t.Errorf("NameOf(Top) = %q, want minecraft:stone", got)
	}
	if got := palette.NameOf(resolved.Foundation); got != "minecraft:stone" {
		t.Errorf("NameOf(Foundation) = %q, want minecraft:stone", got)
	}
	if got := palette.NameOf(resolved.Sea); got != "minecraft:water" {
		t.Errorf("NameOf(Sea) = %q, want minecraft:water", got)
	}
	if resolved.SeaFloorDepth != 0 {
		t.Errorf("SeaFloorDepth = %d, want 0", resolved.SeaFloorDepth)
	}
}

func TestInternMaterialSlots_WarnsForTypoButStillInterns(t *testing.T) {
	palette := block.NewPalette()
	var warnings []string
	slots := stoneSlots()
	slots.TopMaterial = "minecraft:stoen"
	resolved := InternMaterialSlots(palette, slots, func(m string) { warnings = append(warnings, m) })
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly 1", warnings)
	}
	if !strings.Contains(warnings[0], "topMaterial") || !strings.Contains(warnings[0], "stoen") {
		t.Errorf("warning = %q, want it to mention topMaterial and stoen", warnings[0])
	}
	// Still renders -- interned like any other block, not rejected/air.
	if got := palette.NameOf(resolved.Top); got != "minecraft:stoen" {
		t.Errorf("NameOf(Top) = %q, want minecraft:stoen (interned despite the warning)", got)
	}
}

func TestInternMaterialSlots_WarnsForAddonNamespacedBlock(t *testing.T) {
	palette := block.NewPalette()
	var warnings []string
	slots := stoneSlots()
	slots.FoundationMaterial = "wiki:basalt_rock"
	InternMaterialSlots(palette, slots, func(m string) { warnings = append(warnings, m) })
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly 1", warnings)
	}
	if !strings.Contains(warnings[0], "foundationMaterial") {
		t.Errorf("warning = %q, want it to mention foundationMaterial", warnings[0])
	}
}

func TestInternMaterialSlots_RoundsAndClampsSeaFloorDepth(t *testing.T) {
	palette := block.NewPalette()
	slots := stoneSlots()
	slots.SeaFloorDepth = -3
	if got := InternMaterialSlots(palette, slots, nil).SeaFloorDepth; got != 0 {
		t.Errorf("SeaFloorDepth(-3) = %d, want 0", got)
	}
	slots.SeaFloorDepth = 2.6
	if got := InternMaterialSlots(palette, slots, nil).SeaFloorDepth; got != 3 {
		t.Errorf("SeaFloorDepth(2.6) = %d, want 3 (rounded)", got)
	}
}

// ---------------------------------------------------------------------------
// EnvironmentPreset.Materials -- every preset declares a native default.
// ---------------------------------------------------------------------------

func TestEveryPresetHasNonEmptyNativeMaterials(t *testing.T) {
	for _, preset := range ENVIRONMENTS {
		if preset.Materials.TopMaterial == "" {
			t.Errorf("%s: TopMaterial is empty", preset.ID)
		}
		if preset.Materials.MidMaterial == "" {
			t.Errorf("%s: MidMaterial is empty", preset.ID)
		}
		if preset.Materials.FoundationMaterial == "" {
			t.Errorf("%s: FoundationMaterial is empty", preset.ID)
		}
		if preset.Materials.SeaFloorDepth < 0 {
			t.Errorf("%s: SeaFloorDepth = %v, want >= 0", preset.ID, preset.Materials.SeaFloorDepth)
		}
	}
}

func TestPlainsNativeMaterialsAreGrassDirtStone(t *testing.T) {
	preset, ok := GetEnvironment(EnvPlains)
	if !ok {
		t.Fatal("plains preset not found")
	}
	if preset.Materials.TopMaterial != "minecraft:grass_block" {
		t.Errorf("TopMaterial = %q, want minecraft:grass_block", preset.Materials.TopMaterial)
	}
	if preset.Materials.MidMaterial != "minecraft:dirt" {
		t.Errorf("MidMaterial = %q, want minecraft:dirt", preset.Materials.MidMaterial)
	}
	if preset.Materials.FoundationMaterial != "minecraft:stone" {
		t.Errorf("FoundationMaterial = %q, want minecraft:stone", preset.Materials.FoundationMaterial)
	}
}

// ---------------------------------------------------------------------------
// A preset's build() actually consumes the resolved materials: landform
// unchanged, only the palette swaps.
// ---------------------------------------------------------------------------

func TestPlainsBuildPutsGrassOnTop(t *testing.T) {
	palette := block.NewPalette()
	preset, _ := GetEnvironment(EnvPlains)
	vol := volume.New(volume.Bounds{MinX: -4, MinY: 44, MinZ: -4, SizeX: 8, SizeY: 48, SizeZ: 8}, palette, block.AirID)
	materials := InternMaterialSlots(palette, preset.Materials, nil)
	preset.Build(vol, 12345, materials)
	grass := palette.Get("minecraft:grass_block", nil)
	top := vol.GetHeight(0, 0) - 1
	if got := vol.GetBlockAt(0, top, 0); got != grass {
		t.Errorf("GetBlockAt(0, top, 0) = %d, want grass_block id %d", got, grass)
	}
}

func TestPlainsBuildWithOverriddenMaterialsHasNoGrassSameLandform(t *testing.T) {
	preset, _ := GetEnvironment(EnvPlains)
	bounds := volume.Bounds{MinX: -4, MinY: 44, MinZ: -4, SizeX: 8, SizeY: 48, SizeZ: 8}
	const seed = 12345

	nativePalette := block.NewPalette()
	nativeVolume := volume.New(bounds, nativePalette, block.AirID)
	preset.Build(nativeVolume, seed, InternMaterialSlots(nativePalette, preset.Materials, nil))
	var nativeHeights [4]int
	xs := []int{0, 1, -2, 3}
	for i, x := range xs {
		nativeHeights[i] = nativeVolume.GetHeight(x, 0)
	}

	stonePalette := block.NewPalette()
	stoneVolume := volume.New(bounds, stonePalette, block.AirID)
	top, mid := "minecraft:stone", "minecraft:stone"
	effective := MergeMaterialSlots(preset.Materials, &MaterialOverride{TopMaterial: &top, MidMaterial: &mid})
	preset.Build(stoneVolume, seed, InternMaterialSlots(stonePalette, effective, nil))
	var stoneHeights [4]int
	for i, x := range xs {
		stoneHeights[i] = stoneVolume.GetHeight(x, 0)
	}

	if nativeHeights != stoneHeights {
		t.Errorf("stoneHeights = %v, want same landform as nativeHeights = %v", stoneHeights, nativeHeights)
	}

	grass := stonePalette.Get("minecraft:grass_block", nil)
	stone := stonePalette.Get("minecraft:stone", nil)
	grassCount, stoneCount := 0, 0
	for _, id := range stoneVolume.Data() {
		if id == grass {
			grassCount++
		}
		if id == stone {
			stoneCount++
		}
	}
	if grassCount != 0 {
		t.Errorf("grassCount = %d, want 0 (materials overridden to stone)", grassCount)
	}
	if stoneCount == 0 {
		t.Error("stoneCount = 0, want > 0")
	}
}

// ---------------------------------------------------------------------------
// Block-distribution pin: for every preset, at env seed 12345 and the
// preset's own default bounds centered at world (0, 0) (the same "volume
// follows the origin" convention session.Generate uses), a deterministic
// FNV-1a 64 hash of every cell's canonical block name (in (y, z, x)
// iteration order) must match the recorded fixture
// (testdata_env_hashes.json). Any edit to a preset's build() that moves a
// single block shows up here.
// ---------------------------------------------------------------------------

type envHashFixture struct {
	Hash        string `json:"hash"`
	NonAirCount int    `json:"nonAirCount"`
	TotalCells  int    `json:"totalCells"`
}

func loadEnvHashFixtures(t *testing.T) map[string]envHashFixture {
	t.Helper()
	data, err := os.ReadFile("testdata_env_hashes.json")
	if err != nil {
		t.Fatalf("reading testdata_env_hashes.json: %v", err)
	}
	var out map[string]envHashFixture
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("parsing testdata_env_hashes.json: %v", err)
	}
	return out
}

// fnv1a64Hex is the same FNV-1a 64 helper featurelab-go/goldentest uses.
func fnv1a64Hex(b []byte) string {
	h := uint64(0xcbf29ce484222325)
	for _, c := range b {
		h ^= uint64(c)
		h *= 0x100000001b3
	}
	buf := make([]byte, 16)
	const hexDigits = "0123456789abcdef"
	for i := 15; i >= 0; i-- {
		buf[i] = hexDigits[h&0xf]
		h >>= 4
	}
	return string(buf)
}

func hashPresetBuild(preset EnvironmentPreset, seed int32) (hash string, nonAirCount, totalCells int) {
	sizeX, sizeY, sizeZ, minY := preset.Defaults.SizeX, preset.Defaults.SizeY, preset.Defaults.SizeZ, preset.Defaults.MinY
	minX := 0 - sizeX/2
	minZ := 0 - sizeZ/2
	palette := block.NewPalette()
	vol := volume.New(volume.Bounds{MinX: minX, MinY: minY, MinZ: minZ, SizeX: sizeX, SizeY: sizeY, SizeZ: sizeZ}, palette, block.AirID)
	materials := InternMaterialSlots(palette, preset.Materials, nil)
	preset.Build(vol, seed, materials)

	air := palette.Get("minecraft:air", nil)
	var sb strings.Builder
	for y := minY; y < minY+sizeY; y++ {
		for z := minZ; z < minZ+sizeZ; z++ {
			for x := minX; x < minX+sizeX; x++ {
				id := vol.GetBlockAt(x, y, z)
				if id != air {
					nonAirCount++
				}
				sb.WriteString(palette.NameOf(id))
				sb.WriteByte('\n')
			}
		}
	}
	totalCells = sizeX * sizeY * sizeZ
	return fnv1a64Hex([]byte(strings.TrimSuffix(sb.String(), "\n"))), nonAirCount, totalCells
}

func TestPresetBlockDistributionMatchesRecordedFixture(t *testing.T) {
	fixtures := loadEnvHashFixtures(t)
	if len(fixtures) != len(ENVIRONMENTS) {
		t.Fatalf("fixture has %d presets, ENVIRONMENTS has %d -- regenerate testdata_env_hashes.json", len(fixtures), len(ENVIRONMENTS))
	}
	for _, preset := range ENVIRONMENTS {
		id := string(preset.ID)
		want, ok := fixtures[id]
		if !ok {
			t.Errorf("%s: no fixture entry", id)
			continue
		}
		gotHash, gotNonAir, gotTotal := hashPresetBuild(preset, 12345)
		if gotTotal != want.TotalCells {
			t.Errorf("%s: totalCells = %d, want %d", id, gotTotal, want.TotalCells)
		}
		if gotNonAir != want.NonAirCount {
			t.Errorf("%s: nonAirCount = %d, want %d (recorded fixture)", id, gotNonAir, want.NonAirCount)
		}
		if gotHash != want.Hash {
			t.Errorf("%s: block-arrangement hash = %s, want %s (recorded fixture) -- this preset's build() has changed", id, gotHash, want.Hash)
		}
	}
}
