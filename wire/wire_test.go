package wire

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
)

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func singleBlockFeatureJSON(identifier, placesBlock string) string {
	return `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"` +
		identifier + `"},"places_block":"` + placesBlock + `"}}`
}

// TestRunGenerate_JSONShapeCarriesEverythingAViewerNeeds proves the `generate` response
// contract this package's doc comment states: block volume (blocks/baseline/palette), bounds,
// the three-way placed/carved/replaced split, diagnostics, origin, and the seed actually used --
// all present as top-level JSON fields, not something only reachable by re-parsing a prose
// message.
func TestRunGenerate_JSONShapeCarriesEverythingAViewerNeeds(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "void"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}

	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	wantKeys := []string{
		"bounds", "featureSeed", "environmentSeed",
		"blocks", "baseline", "palette",
		"origin", "placements",
		"blocksChanged", "blocksPlaced", "blocksCarved", "blocksReplaced",
		"writesOutOfBounds", "placementDurationMs", "libraryBuildDurationMs", "totalDurationMs", "partial",
		"diagnostics", "entries", "ruleEntries", "activeRule", "unresolvedTags", "molangScope",
	}
	for _, k := range wantKeys {
		if _, ok := m[k]; !ok {
			t.Errorf("response JSON missing key %q -- full response: %s", k, raw)
		}
	}

	bounds, ok := m["bounds"].(map[string]any)
	if !ok {
		t.Fatalf("bounds is not an object: %v", m["bounds"])
	}
	for _, k := range []string{"minX", "minY", "minZ", "sizeX", "sizeY", "sizeZ"} {
		if _, ok := bounds[k]; !ok {
			t.Errorf("bounds missing key %q", k)
		}
	}

	// The load-bearing assertion for THIS consolidation: origin/palette must use the
	// lowerCamelCase wire convention (x/y/z, id/name/states/kind), not the capitalized Go
	// exported-field names wgen.BlockPos/block.Entry used to fall back to before they carried
	// json tags. A regression here (a tag removed, a rename reverted) must fail this test, not
	// silently start shipping "X"/"ID" again.
	origin, ok := m["origin"].(map[string]any)
	if !ok {
		t.Fatalf("origin is not an object: %v", m["origin"])
	}
	for _, k := range []string{"x", "y", "z"} {
		if _, ok := origin[k]; !ok {
			t.Errorf("origin missing lowerCamelCase key %q -- full origin: %v", k, origin)
		}
	}
	for _, bad := range []string{"X", "Y", "Z"} {
		if _, ok := origin[bad]; ok {
			t.Errorf("origin still carries capitalized key %q -- wgen.BlockPos tags regressed", bad)
		}
	}

	palette, ok := m["palette"].([]any)
	if !ok || len(palette) == 0 {
		t.Fatalf("palette is not a non-empty array: %v", m["palette"])
	}
	entry, ok := palette[0].(map[string]any)
	if !ok {
		t.Fatalf("palette[0] is not an object: %v", palette[0])
	}
	for _, k := range []string{"id", "name", "states", "kind"} {
		if _, ok := entry[k]; !ok {
			t.Errorf("palette[0] missing lowerCamelCase key %q -- full entry: %v", k, entry)
		}
	}
	for _, bad := range []string{"ID", "Name", "States", "Kind"} {
		if _, ok := entry[bad]; ok {
			t.Errorf("palette[0] still carries capitalized key %q -- block.Entry tags regressed", bad)
		}
	}

	if out.BlocksPlaced != 1 {
		t.Errorf("BlocksPlaced = %d, want 1", out.BlocksPlaced)
	}
	if out.FeatureSeed == 0 {
		t.Errorf("FeatureSeed = 0, want the preset default to have been filled in")
	}
	// "-" tagged Volume must NOT leak into the JSON.
	if _, ok := m["Volume"]; ok {
		t.Error("Volume (json:\"-\") leaked into the response")
	}
}

// TestRunGenerate_CarvedCellsAreVisibleInResponse proves the "carved cells are load-bearing"
// requirement: an excavating feature (places air into a solid environment) must show up as
// blocksCarved > 0 and in the Removed mask, not just as an unremarkable blocksChanged total.
func TestRunGenerate_CarvedCellsAreVisibleInResponse(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "carve_air.json"), singleBlockFeatureJSON("test:carve_air", "minecraft:air"))

	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:carve_air", Env: "underground_stone"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	if out.BlocksCarved != 1 {
		t.Errorf("BlocksCarved = %d, want 1", out.BlocksCarved)
	}
	sum := 0
	for _, b := range out.Removed {
		sum += int(b)
	}
	if sum != 1 {
		t.Errorf("sum(Removed) = %d, want 1", sum)
	}
}

func TestRunGenerate_RequiresExactlyOneOfFeatureOrRule(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "a.json"), singleBlockFeatureJSON("test:a", "minecraft:stone"))
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	if _, err := RunGenerate(loaded, GenerateParams{Env: "void"}); err == nil {
		t.Error("expected an error when neither feature nor rule is given")
	}
	if _, err := RunGenerate(loaded, GenerateParams{Feature: "test:a", Rule: "test:a", Env: "void"}); err == nil {
		t.Error("expected an error when both feature and rule are given")
	}
}

// TestRunGenerate_DurationFieldsDistinguishOneShotFromServe proves this package's own doc
// comment ("Duration fields"): RunGenerate (the one-shot path cmd/featurelab's `generate`
// subcommand and apps/desktop's App.Generate both call) must report a nonzero
// libraryBuildDurationMs, since it builds a brand-new Workspace for this one call; RunGenerateFrom
// Workspace (the `serve` "generate" path, called here against a Workspace built ahead of time,
// mirroring "loadPack" already having run) must report exactly zero, since it reused
// already-built libraries and paid no build cost of its own. Both must satisfy
// totalDurationMs == libraryBuildDurationMs + placementDurationMs exactly, so a consumer of
// either path never has to reach for arithmetic to get the total.
func TestRunGenerate_DurationFieldsDistinguishOneShotFromServe(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	// Several hundred filler files, not just one -- makes the build's disk I/O add up to
	// comfortably more than this environment's observed ~1ms effective timer floor (two
	// back-to-back time.Now() calls with negligible work between them can read back an exact
	// zero delta here), so LibraryBuildDurationMs below reads back reliably nonzero instead of
	// flaking near that floor.
	for i := 0; i < 300; i++ {
		id := fmt.Sprintf("test:filler_%d", i)
		writeTestFile(t, filepath.Join(root, "features", fmt.Sprintf("filler_%d.json", i)), singleBlockFeatureJSON(id, "minecraft:stone"))
	}

	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	params := GenerateParams{Feature: "test:place_diamond", Env: "void"}

	oneShot, err := RunGenerate(loaded, params)
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	if oneShot.LibraryBuildDurationMs <= 0 {
		t.Errorf("one-shot RunGenerate: LibraryBuildDurationMs = %v, want > 0", oneShot.LibraryBuildDurationMs)
	}

	// Mirrors what a `serve` session actually does: build the Workspace once (the "loadPack"
	// step), then call the reuse entry point for "generate".
	ws := session.NewWorkspace(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	viaWorkspace, err := RunGenerateFromWorkspace(ws, params)
	if err != nil {
		t.Fatalf("RunGenerateFromWorkspace: %v", err)
	}
	if viaWorkspace.LibraryBuildDurationMs != 0 {
		t.Errorf("serve-style RunGenerateFromWorkspace: LibraryBuildDurationMs = %v, want exactly 0 -- the build cost was already paid by NewWorkspace above, outside this call", viaWorkspace.LibraryBuildDurationMs)
	}

	for name, out := range map[string]*GenerateOutput{"oneShot": oneShot, "viaWorkspace": viaWorkspace} {
		if want := out.LibraryBuildDurationMs + out.PlacementDurationMs; out.TotalDurationMs != want {
			t.Errorf("%s: TotalDurationMs = %v, want LibraryBuildDurationMs(%v) + PlacementDurationMs(%v) = %v",
				name, out.TotalDurationMs, out.LibraryBuildDurationMs, out.PlacementDurationMs, want)
		}
	}
}

// TestRunGenerate_MaterialOverrideChangesPalette proves GenerateParams.Materials actually
// reaches the placed environment: two otherwise-identical requests, one with a TopMaterial
// override, must produce different palettes -- a flag that parses but changes nothing is not
// implemented.
func TestRunGenerate_MaterialOverrideChangesPalette(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	base, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "plains"})
	if err != nil {
		t.Fatalf("RunGenerate (default materials): %v", err)
	}
	top := "minecraft:red_sand"
	mid := "minecraft:sandstone"
	overridden, err := RunGenerate(loaded, GenerateParams{
		Feature: "test:place_diamond", Env: "plains",
		Materials: &Materials{TopMaterial: &top, MidMaterial: &mid},
	})
	if err != nil {
		t.Fatalf("RunGenerate (overridden materials): %v", err)
	}

	// env.InternMaterialSlots interns every material slot into the palette unconditionally,
	// whether or not the preset's Build actually writes that block into the volume -- so
	// palette MEMBERSHIP alone would prove only that the override was recognized, not that it
	// changed anything (exactly the "flag that parses but changes nothing" failure mode this
	// test exists to catch). The real assertion has to be over Baseline, the actual per-cell
	// terrain the preset built, decoded through each run's own Palette.
	nameOf := func(out *GenerateOutput, id int32) string {
		for _, e := range out.Palette {
			if int32(e.ID) == id {
				return e.Name
			}
		}
		return fmt.Sprintf("<unknown id %d>", id)
	}
	baselineHasName := func(out *GenerateOutput, name string) bool {
		for _, id := range out.Baseline {
			if nameOf(out, int32(id)) == name {
				return true
			}
		}
		return false
	}
	if baselineHasName(base, "minecraft:red_sand") {
		t.Error("default-materials run's baseline unexpectedly already contains minecraft:red_sand -- test fixture assumption broken")
	}
	if !baselineHasName(overridden, "minecraft:red_sand") {
		t.Errorf("materials.topMaterial override did not change the built terrain -- overridden baseline block names: %v", distinctBaselineNames(overridden))
	}
	if !baselineHasName(overridden, "minecraft:sandstone") {
		t.Errorf("materials.midMaterial override did not change the built terrain -- overridden baseline block names: %v", distinctBaselineNames(overridden))
	}
	if !baselineHasName(base, "minecraft:grass_block") && !baselineHasName(base, "minecraft:dirt") {
		t.Errorf("default-materials run's baseline contains neither grass_block nor dirt -- test fixture assumption broken, baseline block names: %v", distinctBaselineNames(base))
	}
}

func distinctBaselineNames(out *GenerateOutput) []string {
	seen := map[string]bool{}
	var names []string
	byID := map[int32]string{}
	for _, e := range out.Palette {
		byID[int32(e.ID)] = e.Name
	}
	for _, id := range out.Baseline {
		n := byID[int32(id)]
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	return names
}

// TestRunGenerate_UnknownMaterialProducesDiagnostic proves the "clear diagnostic naming the
// slot and the value" requirement: an unrecognized block name in a material slot must surface
// as a warning Diagnostic that names both, not a silent fallback and not a crash.
func TestRunGenerate_UnknownMaterialProducesDiagnostic(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	nonsense := "minecraft:this_is_not_a_real_block"
	out, err := RunGenerate(loaded, GenerateParams{
		Feature: "test:place_diamond", Env: "plains",
		Materials: &Materials{TopMaterial: &nonsense},
	})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	found := false
	for _, d := range out.Diagnostics {
		if d.Level == "warning" && strings.Contains(d.Message, "topMaterial") && strings.Contains(d.Message, nonsense) {
			found = true
			t.Logf("diagnostic: %s", d.Message)
		}
	}
	if !found {
		t.Errorf("expected a warning diagnostic naming both the slot (topMaterial) and value (%s), got: %+v", nonsense, out.Diagnostics)
	}
}

// TestRunGenerate_MinYOverride proves GenerateParams.MinY reaches session.Config and moves the
// response bounds' minY.
func TestRunGenerate_MinYOverride(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	minY := -40
	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "plains", MinY: &minY})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	if out.Bounds.MinY != minY {
		t.Errorf("Bounds.MinY = %d, want %d", out.Bounds.MinY, minY)
	}
}

// TestRunGenerate_UnknownBiomeIDReportsDiagnostic proves a BiomeID naming no loaded biome file
// is not a silent fallback: generation still succeeds (materials/tags fall back to the preset
// default) but the response carries an "error" Diagnostic naming the offending id -- see
// session.Config.EnvironmentBiomeID's own doc comment for why reporting the id is deliberate
// rather than falling back silently.
func TestRunGenerate_UnknownBiomeIDReportsDiagnostic(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "plains", BiomeID: "wiki:not_a_real_biome"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	found := false
	for _, d := range out.Diagnostics {
		if d.Level == "error" && strings.Contains(d.Message, "wiki:not_a_real_biome") {
			found = true
			t.Logf("diagnostic: %s", d.Message)
		}
	}
	if !found {
		t.Errorf("expected an \"error\" diagnostic naming the unresolved biome id, got: %+v", out.Diagnostics)
	}
	if out.EnvironmentBiome != nil {
		t.Errorf("EnvironmentBiome = %+v, want nil for an unresolved id", out.EnvironmentBiome)
	}
}

// TestRunGenerate_BiomeIDSelectsPackBiomeMaterialsAndTags proves a BiomeID that DOES name a
// loaded biomes/*.json file fills the material slots (env.MaterialSlots's "source 2") and
// becomes the default query.has_biome_tag identity -- the functional gap this package's own
// task existed to close. Verified against the actual terrain block written, not palette
// membership (see this repo's task notes: every material slot is interned whether or not it's
// used, so a palette check alone would pass even if the wiring did nothing).
func TestRunGenerate_BiomeIDSelectsPackBiomeMaterialsAndTags(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "biomes", "testbiome.json"), `{
		"format_version": "1.21.110",
		"minecraft:biome": {
			"description": {"identifier": "wiki:testbiome"},
			"components": {
				"minecraft:surface_builder": {"builder": {
					"type": "minecraft:overworld",
					"top_material": "minecraft:obsidian",
					"mid_material": "minecraft:obsidian",
					"foundation_material": "minecraft:obsidian",
					"sea_floor_depth": 0,
					"sea_floor_material": "minecraft:gravel",
					"sea_material": "minecraft:water"
				}},
				"minecraft:tags": {"tags": ["testbiome", "overworld"]}
			}
		}
	}`)
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "plains", BiomeID: "wiki:testbiome"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	if out.EnvironmentBiome == nil || out.EnvironmentBiome.Identifier != "wiki:testbiome" {
		t.Fatalf("EnvironmentBiome = %+v, want the resolved wiki:testbiome", out.EnvironmentBiome)
	}
	// Read a column away from (0,0): the placed feature's single_block_feature lands exactly
	// at the placement origin (0, preset.DefaultOriginY, 0) -- see this test's own debug trace
	// -- so checking that column would see the feature's own diamond_block, not the
	// environment's own terrain material this assertion is about.
	const cx, cz = 5, 5
	top := out.Volume.GetHeight(cx, cz) - 1
	var obsidianID, grassID block.ID
	haveObsidian, haveGrass := false, false
	for _, p := range out.Palette {
		switch p.Name {
		case "minecraft:obsidian":
			obsidianID, haveObsidian = p.ID, true
		case "minecraft:grass_block":
			grassID, haveGrass = p.ID, true
		}
	}
	if !haveObsidian {
		t.Fatal("minecraft:obsidian never interned -- the biome's surface_builder never reached the materials pipeline")
	}
	if got := out.Volume.GetBlockAt(cx, top, cz); got != obsidianID {
		t.Errorf("terrain top block id = %d, want obsidian id %d (plains' native grass never should have been built)", got, obsidianID)
	}
	if haveGrass {
		for _, id := range out.Blocks {
			if id == grassID {
				t.Errorf("grass_block appears in the built volume -- the selected biome's materials did not fully replace the preset's own")
				break
			}
		}
	}
}

// TestRunGenerate_BiomeEntriesAndEnvironmentBiomeSerializeLowerCamelCase proves the ACTUAL bytes
// this package puts on the wire for biomeEntries/environmentBiome carry lowerCamelCase keys
// throughout -- not just that the Go struct definitions (biomes.Entry/biomes.ResolvedBiome and
// everything they embed: Climate, Replacement, MaterialSlots) declare json tags, but that
// json.Marshal actually honours them end to end. biomes.go originally carried NO json tags at
// all, so this would have silently serialized as FileID/Identifier/SurfaceBuilder/TopMaterial/
// SnowAccumulation/ReplaceBiomes/... -- a defect a consumer reading camelCase would never error
// on, just silently read undefined and show an empty biome list. The fixture below exercises
// every reachable field (surface_builder, climate, replace_biomes) so no nested object escapes
// the check.
func TestRunGenerate_BiomeEntriesAndEnvironmentBiomeSerializeLowerCamelCase(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "biomes", "testbiome.json"), `{
		"format_version": "1.21.110",
		"minecraft:biome": {
			"description": {"identifier": "wiki:testbiome"},
			"components": {
				"minecraft:surface_builder": {"builder": {
					"type": "minecraft:overworld",
					"top_material": "minecraft:obsidian",
					"mid_material": "minecraft:obsidian",
					"foundation_material": "minecraft:obsidian",
					"sea_floor_depth": 0,
					"sea_floor_material": "minecraft:gravel",
					"sea_material": "minecraft:water"
				}},
				"minecraft:climate": {"temperature": 10.0, "snow_accumulation": [0.0, 0.0], "downfall": 0.0},
				"minecraft:replace_biomes": {"replacements": [
					{"targets": ["minecraft:desert"], "dimension": "minecraft:overworld", "amount": 0.7, "noise_frequency_scale": 1.7}
				]},
				"minecraft:tags": {"tags": ["testbiome", "overworld"]}
			}
		}
	}`)
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "plains", BiomeID: "wiki:testbiome"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}

	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	biomeEntries, ok := m["biomeEntries"]
	if !ok {
		t.Fatal("response has no top-level \"biomeEntries\" key")
	}
	if entries, ok := biomeEntries.([]any); !ok || len(entries) != 1 {
		t.Fatalf("biomeEntries = %#v, want a one-element array", biomeEntries)
	}
	environmentBiome, ok := m["environmentBiome"]
	if !ok || environmentBiome == nil {
		t.Fatal("response has no non-null top-level \"environmentBiome\" key")
	}

	assertNoUppercaseLeadingKeys(t, "biomeEntries", biomeEntries)
	assertNoUppercaseLeadingKeys(t, "environmentBiome", environmentBiome)
}

// assertNoUppercaseLeadingKeys walks a decoded JSON value (map[string]any / []any / scalars)
// and fails t for any object key beginning with an uppercase ASCII letter -- the actual,
// serialized shape a consumer sees, not the Go struct definition it came from.
func assertNoUppercaseLeadingKeys(t *testing.T, path string, v any) {
	t.Helper()
	switch val := v.(type) {
	case map[string]any:
		for k, sub := range val {
			if len(k) > 0 && k[0] >= 'A' && k[0] <= 'Z' {
				t.Errorf("%s: key %q starts with an uppercase letter -- PascalCase leaked onto the wire", path, k)
			}
			assertNoUppercaseLeadingKeys(t, path+"."+k, sub)
		}
	case []any:
		for i, sub := range val {
			assertNoUppercaseLeadingKeys(t, fmt.Sprintf("%s[%d]", path, i), sub)
		}
	}
}

func TestBuildConfig_BiomeID(t *testing.T) {
	cfg, err := BuildConfig(GenerateParams{Feature: "test:x", Env: "plains", BiomeID: "wiki:testbiome"})
	if err != nil {
		t.Fatalf("BuildConfig: %v", err)
	}
	if cfg.EnvironmentBiomeID != "wiki:testbiome" {
		t.Errorf("EnvironmentBiomeID = %q, want %q", cfg.EnvironmentBiomeID, "wiki:testbiome")
	}
	if cfg.BiomeOverride != nil {
		t.Errorf("BiomeOverride = %+v, want nil -- BiomeID alone selects a pack biome, it does not set a manual override", cfg.BiomeOverride)
	}
}

func TestBuildConfig_BiomeTagsAloneIsATagsOnlyOverride(t *testing.T) {
	cfg, err := BuildConfig(GenerateParams{Feature: "test:x", Env: "plains", BiomeTags: []string{"custom_tag"}})
	if err != nil {
		t.Fatalf("BuildConfig: %v", err)
	}
	if cfg.EnvironmentBiomeID != "" {
		t.Errorf("EnvironmentBiomeID = %q, want \"\" -- BiomeTags alone must not select a pack biome", cfg.EnvironmentBiomeID)
	}
	if cfg.BiomeOverride == nil {
		t.Fatal("BiomeOverride is nil, want set")
	}
	if cfg.BiomeOverride.ID != "" {
		t.Errorf("BiomeOverride.ID = %q, want \"\" -- so session.generate's own default identifier is left alone", cfg.BiomeOverride.ID)
	}
	if cfg.BiomeOverride.Tags != "custom_tag" {
		t.Errorf("BiomeOverride.Tags = %q, want %q", cfg.BiomeOverride.Tags, "custom_tag")
	}
}

func TestParseOrigin(t *testing.T) {
	x, y, z, err := ParseOrigin("1,-2,3")
	if err != nil || x != 1 || y != -2 || z != 3 {
		t.Errorf("ParseOrigin(1,-2,3) = %d,%d,%d,%v", x, y, z, err)
	}
	if _, _, _, err := ParseOrigin("1,2"); err == nil {
		t.Error("expected an error for a 2-component origin")
	}
}

func TestParseSize(t *testing.T) {
	x, y, z, err := ParseSize("16x32x16")
	if err != nil || x != 16 || y != 32 || z != 16 {
		t.Errorf("ParseSize(16x32x16) = %d,%d,%d,%v", x, y, z, err)
	}
	if _, _, _, err := ParseSize("0x1x1"); err == nil {
		t.Error("expected an error for a non-positive size component")
	}
}

// TestRunGenerate_OmitCatalogsDropsOnlyTheCatalogues covers GenerateParams.OmitCatalogs: the
// three pack catalogues go away and everything about the RUN stays. The flag exists because
// those three are the dominant cost of a repeated preview -- on a large add-on `entries` alone is
// over half a response -- and a client driving many generates against one loaded pack has no
// reason to be sent them again on every save.
func TestRunGenerate_OmitCatalogsDropsOnlyTheCatalogues(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	decode := func(t *testing.T, omit bool) map[string]any {
		t.Helper()
		out, err := RunGenerate(loaded, GenerateParams{Feature: "test:place_diamond", Env: "plains", OmitCatalogs: omit})
		if err != nil {
			t.Fatalf("RunGenerate(omitCatalogs=%v): %v", omit, err)
		}
		raw, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("json.Marshal: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("json.Unmarshal: %v", err)
		}
		return m
	}

	full := decode(t, false)
	lean := decode(t, true)

	if entries, ok := full["entries"].([]any); !ok || len(entries) != 1 {
		t.Fatalf("without the flag, entries = %#v, want the one loaded feature", full["entries"])
	}
	for _, key := range []string{"entries", "ruleEntries", "biomeEntries"} {
		if _, present := lean[key]; !present {
			t.Errorf("%q is absent from the response; omission must be a null field, not a missing key, "+
				"so a decoder that knows nothing about the flag still finds it", key)
		}
		if lean[key] != nil {
			t.Errorf("%q = %#v with omitCatalogs set, want null", key, lean[key])
		}
	}

	// Everything that describes the RUN rather than the pack has to be untouched -- otherwise
	// this is not a bandwidth flag, it is a different response.
	for _, key := range []string{"bounds", "blocks", "baseline", "palette", "changed", "removed",
		"blocksPlaced", "blocksChanged", "origin", "featureSeed", "environmentSeed", "diagnostics"} {
		if _, present := lean[key]; !present {
			t.Errorf("omitCatalogs dropped %q, which is about the run and not the pack", key)
		}
	}
	if fmt.Sprint(lean["blocksPlaced"]) != fmt.Sprint(full["blocksPlaced"]) {
		t.Errorf("blocksPlaced differs between the two responses (%v vs %v) -- the flag must not "+
			"change what was placed", lean["blocksPlaced"], full["blocksPlaced"])
	}
	if fmt.Sprint(lean["blocks"]) != fmt.Sprint(full["blocks"]) {
		t.Error("the block array differs between the two responses -- the flag must not change the run")
	}
}

// TestRunGenerate_StopsAreTopLevelWithoutProfiling pins the `stops` half of this package's doc
// comment: an ordinary generate -- profile NOT requested -- explains why it placed nothing, as a
// TOP-LEVEL array rather than something only a profiled run's nested profile.features[] carries.
func TestRunGenerate_StopsAreTopLevelWithoutProfiling(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "leaf.json"), singleBlockFeatureJSON("test:leaf", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		`{"format_version":"1.21.110","minecraft:scatter_feature":{"description":{"identifier":"test:scatter"},`+
			`"places_feature":"test:leaf","distribution":{"iterations":0,"x":0,"y":0,"z":0}}}`)

	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	out, err := RunGenerate(loaded, GenerateParams{Feature: "test:scatter", Env: "void"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(encoded, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m["profile"] != nil {
		t.Fatalf("profile = %v, want null -- this run did not ask for one", m["profile"])
	}
	stops, ok := m["stops"].([]any)
	if !ok || len(stops) != 1 {
		t.Fatalf("stops = %v, want one top-level row", m["stops"])
	}
	row, ok := stops[0].(map[string]any)
	if !ok {
		t.Fatalf("stops[0] = %v, want an object", stops[0])
	}
	if row["identifier"] != "test:scatter" || row["reason"] != "iterations_zero" {
		t.Errorf("stops[0] = %v, want test:scatter / iterations_zero", row)
	}
	if detail, _ := row["detail"].(string); !strings.Contains(detail, "iterations = 0") {
		t.Errorf("detail = %v, want the evaluated value", row["detail"])
	}
	if count, _ := row["count"].(float64); count < 1 {
		t.Errorf("count = %v, want at least 1", row["count"])
	}
	if _, present := row["ordinal"]; present {
		t.Errorf("ordinal = %v, want omitted for a whole-feature gate", row["ordinal"])
	}

	// A healthy feature carries no rows at all, and the field is absent rather than null.
	healthy, err := RunGenerate(loaded, GenerateParams{Feature: "test:leaf", Env: "void"})
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	encoded, err = json.Marshal(healthy)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	m = map[string]any{}
	if err := json.Unmarshal(encoded, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, present := m["stops"]; present {
		t.Errorf("stops = %v on a healthy run, want the key omitted entirely", m["stops"])
	}
}
