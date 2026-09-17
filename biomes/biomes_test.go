// biomes_test.go covers BuildLibrary parsing and adds one integration check
// for the tags->wgen.MolangBiome join point described in biomes.go's header.
// query.has_biome_tag/any_tag/all_tags evaluation itself is already covered
// by featurelab-go's existing wgen/molang-go tests, so it is not re-tested
// wholesale here.
package biomes

import (
	"testing"

	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"

	molang "github.com/stirante/molang-go"
)

// canyonJSON is synthetic, but keeps the exact shape of the real-world
// biomes/*.sb.json this test was written against: every component the parser
// reads present at once, and -- the reason the tags array is spelled out
// rather than minimised -- stray blank (null) slots scattered through
// minecraft:tags.tags, plus the pack's own NAMESPACE repeated as a bare tag
// beside the descriptive ones. Both are real authoring habits the parser has
// to survive; flattening the array to three clean strings would delete the
// case.
const canyonJSON = `{
    "format_version": "1.21.110",
    "minecraft:biome": {
        "description": {
            "identifier": "wiki:canyon"
        },
        "components": {
            "minecraft:replace_biomes": {
                "replacements": [
                    {
                        "targets": ["minecraft:desert"],
                        "dimension": "minecraft:overworld",
                        "amount": 0.7,
                        "noise_frequency_scale": 1.7
                    }
                ]
            },
            "minecraft:surface_builder": {
                "builder": {
                    "type": "minecraft:overworld",
                    "top_material": "minecraft:stone",
                    "mid_material": "minecraft:stone",
                    "foundation_material": "minecraft:stone",
                    "sea_floor_depth": 0,
                    "sea_floor_material": "minecraft:gravel",
                    "sea_material": "minecraft:water"
                }
            },
            "minecraft:climate": { "temperature": 10.0, "snow_accumulation": [0.0, 0.0], "downfall": 0.0 },
            "minecraft:tags": { "tags": [null, null, "overworld", null, null, "wiki", "canyon"] }
        }
    }
}`

func file(id, text string) SourceFile {
	return SourceFile{ID: id, AbsPath: `C:\fake\` + id, Text: text}
}

// TestBuildLibrary_TolerateJsoncComments is the direct regression test for the jsonc.StripComments
// pre-pass parseBiomeFile now runs: a real vanilla-style biome file with a "//" line comment must
// parse cleanly instead of producing an "invalid JSON: invalid character '/' looking for beginning
// of value" diagnostic.
func TestBuildLibrary_TolerateJsoncComments(t *testing.T) {
	text := `{
		"format_version": "1.21.110",
		"minecraft:biome": {
			// a vanilla-style comment right before description
			"description": {
				"identifier": "wiki:commented"
			},
			"components": {}
		}
	}`
	lib := BuildLibrary([]SourceFile{file("commented.json", text)})
	for _, d := range lib.Diagnostics {
		t.Errorf("unexpected diagnostic: %+v", d)
	}
	if lib.Resolve("wiki:commented") == nil {
		t.Fatal("expected wiki:commented to be loaded despite the JSON comment")
	}
}

func strEqual(t *testing.T, name string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %v, want %v", name, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s: got %v, want %v", name, got, want)
		}
	}
}

func TestBuildBiomeLibrary_ParsesCanyon(t *testing.T) {
	lib := BuildLibrary([]SourceFile{file("canyon.sb.json", canyonJSON)})
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("expected no diagnostics, got %+v", lib.Diagnostics)
	}
	biome := lib.Resolve("wiki:canyon")
	if biome == nil {
		t.Fatal("expected wiki:canyon to resolve")
	}
	if biome.Identifier != "wiki:canyon" {
		t.Errorf("identifier = %q", biome.Identifier)
	}
	strEqual(t, "tags", biome.Tags, []string{"overworld", "wiki", "canyon"}) // blank slots filtered

	if biome.SurfaceBuilderType == nil || *biome.SurfaceBuilderType != "minecraft:overworld" {
		t.Errorf("surfaceBuilderType = %v", biome.SurfaceBuilderType)
	}
	if biome.SurfaceBuilder == nil {
		t.Fatal("expected surfaceBuilder to be non-nil")
	}
	want := MaterialSlots{
		TopMaterial: "minecraft:stone", MidMaterial: "minecraft:stone", FoundationMaterial: "minecraft:stone",
		SeaFloorMaterial: "minecraft:gravel", SeaMaterial: "minecraft:water", SeaFloorDepth: 0,
	}
	if *biome.SurfaceBuilder != want {
		t.Errorf("surfaceBuilder = %+v, want %+v", *biome.SurfaceBuilder, want)
	}

	if biome.Climate == nil {
		t.Fatal("expected climate to be non-nil")
	}
	if biome.Climate.Temperature == nil || *biome.Climate.Temperature != 10 {
		t.Errorf("climate.temperature = %v", biome.Climate.Temperature)
	}
	if biome.Climate.SnowAccumulation == nil || *biome.Climate.SnowAccumulation != [2]float64{0, 0} {
		t.Errorf("climate.snowAccumulation = %v", biome.Climate.SnowAccumulation)
	}
	if biome.Climate.Downfall == nil || *biome.Climate.Downfall != 0 {
		t.Errorf("climate.downfall = %v", biome.Climate.Downfall)
	}

	if len(biome.ReplaceBiomes) != 1 {
		t.Fatalf("replaceBiomes = %+v", biome.ReplaceBiomes)
	}
	rep := biome.ReplaceBiomes[0]
	strEqual(t, "replaceBiomes[0].targets", rep.Targets, []string{"minecraft:desert"})
	if rep.Dimension == nil || *rep.Dimension != "minecraft:overworld" {
		t.Errorf("replaceBiomes[0].dimension = %v", rep.Dimension)
	}
	if rep.Amount == nil || *rep.Amount != 0.7 {
		t.Errorf("replaceBiomes[0].amount = %v", rep.Amount)
	}
	if rep.NoiseFrequencyScale == nil || *rep.NoiseFrequencyScale != 1.7 {
		t.Errorf("replaceBiomes[0].noiseFrequencyScale = %v", rep.NoiseFrequencyScale)
	}
}

func TestBuildBiomeLibrary_IgnoresUnknownComponents(t *testing.T) {
	json := `{
      "minecraft:biome": {
        "description": { "identifier": "wiki:mystery" },
        "components": {
          "minecraft:mob_spawn_data": { "entities": [] },
          "minecraft:ambient_sounds": { "addition_sound": "ambient.weather.rain" }
        }
      }
    }`
	lib := BuildLibrary([]SourceFile{file("mystery.json", json)})
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("expected no diagnostics, got %+v", lib.Diagnostics)
	}
	biome := lib.Resolve("wiki:mystery")
	if biome == nil {
		t.Fatal("expected wiki:mystery to resolve")
	}
	if len(biome.Tags) != 0 {
		t.Errorf("tags = %v, want empty", biome.Tags)
	}
	if biome.SurfaceBuilder != nil {
		t.Errorf("surfaceBuilder = %+v, want nil", biome.SurfaceBuilder)
	}
	if biome.Climate != nil {
		t.Errorf("climate = %+v, want nil", biome.Climate)
	}
	if len(biome.ReplaceBiomes) != 0 {
		t.Errorf("replaceBiomes = %+v, want empty", biome.ReplaceBiomes)
	}
}

func TestBuildBiomeLibrary_InvalidJSONDiagnostic(t *testing.T) {
	lib := BuildLibrary([]SourceFile{file("broken.json", "{ not json")})
	if len(lib.Entries) != 0 {
		t.Fatalf("entries = %+v, want empty", lib.Entries)
	}
	if len(lib.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly 1", lib.Diagnostics)
	}
	if lib.Diagnostics[0].Level != "error" {
		t.Errorf("level = %q, want error", lib.Diagnostics[0].Level)
	}
}

func TestBuildBiomeLibrary_MissingIdentifierDiagnostic(t *testing.T) {
	lib := BuildLibrary([]SourceFile{file("noid.json", `{ "minecraft:biome": { "components": {} } }`)})
	if len(lib.Entries) != 0 {
		t.Fatalf("entries = %+v, want empty", lib.Entries)
	}
	if len(lib.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly 1", lib.Diagnostics)
	}
}

func TestBuildBiomeLibrary_DuplicateIdentifierWarning(t *testing.T) {
	a := file("a.json", canyonJSON)
	b := file("b.json", canyonJSON)
	lib := BuildLibrary([]SourceFile{a, b})
	if len(lib.Entries) != 2 {
		t.Fatalf("entries = %+v, want 2", lib.Entries)
	}
	if len(lib.Diagnostics) != 1 || lib.Diagnostics[0].Level != "warning" {
		t.Fatalf("diagnostics = %+v, want exactly 1 warning", lib.Diagnostics)
	}
	// First file wins resolution, matching buildFeatureRuleLibrary's convention.
	if lib.Resolve("wiki:canyon").FileID != "a.json" {
		t.Errorf("resolved fileID = %q, want a.json", lib.Resolve("wiki:canyon").FileID)
	}
}

func TestBuildBiomeLibrary_PartialSurfaceBuilderFallsBackPerField(t *testing.T) {
	json := `{
      "minecraft:biome": {
        "description": { "identifier": "wiki:partial" },
        "components": {
          "minecraft:surface_builder": {
            "builder": { "type": "minecraft:overworld", "top_material": "minecraft:grass_block" }
          }
        }
      }
    }`
	biome := BuildLibrary([]SourceFile{file("partial.json", json)}).Resolve("wiki:partial")
	if biome == nil {
		t.Fatal("expected wiki:partial to resolve")
	}
	want := MaterialSlots{
		TopMaterial: "minecraft:grass_block", MidMaterial: "minecraft:stone", FoundationMaterial: "minecraft:stone",
		SeaFloorMaterial: "minecraft:gravel", SeaMaterial: "minecraft:water", SeaFloorDepth: 0,
	}
	if biome.SurfaceBuilder == nil || *biome.SurfaceBuilder != want {
		t.Errorf("surfaceBuilder = %+v, want %+v", biome.SurfaceBuilder, want)
	}
}

// TestResolvedBiomeTagsFeedMolangQueries proves the join point biomes.go's
// header promises: a ResolvedBiome's Tags, converted via TagSet() into a
// wgen.MolangBiome, actually drive query.has_biome_tag/any_tag/all_tags
// through the real molang-go evaluator -- has_biome_tag matches a present
// tag, any_tag is OR, all_tags is AND -- using a biome parsed by THIS
// package instead of a hand-built MolangBiome literal.
func TestResolvedBiomeTagsFeedMolangQueries(t *testing.T) {
	biome := BuildLibrary([]SourceFile{file("canyon.sb.json", canyonJSON)}).Resolve("wiki:canyon")
	if biome == nil {
		t.Fatal("expected wiki:canyon to resolve")
	}
	mb := &wgen.MolangBiome{ID: biome.Identifier, Tags: biome.TagSet()}

	eval := func(src string) float64 {
		prog, err := molang.Compile(src)
		if err != nil {
			t.Fatalf("compile %q: %v", src, err)
		}
		scope := wgen.NewScope()
		ctx := wgen.NewMolangContext(random.New(1), scope, mb, nil, nil)
		return prog.Run(ctx)
	}

	if got := eval(`q.has_biome_tag('canyon')`); got != 1 {
		t.Errorf("has_biome_tag('canyon') = %v, want 1", got)
	}
	if got := eval(`q.has_biome_tag('plains')`); got != 0 {
		t.Errorf("has_biome_tag('plains') = %v, want 0", got)
	}
	if got := eval(`q.any_tag('plains', 'canyon')`); got != 1 {
		t.Errorf("any_tag('plains','canyon') = %v, want 1", got)
	}
	if got := eval(`q.all_tags('overworld', 'canyon')`); got != 1 {
		t.Errorf("all_tags('overworld','canyon') = %v, want 1", got)
	}
	if got := eval(`q.all_tags('overworld', 'plains')`); got != 0 {
		t.Errorf("all_tags('overworld','plains') = %v, want 0", got)
	}
}
