package wgen

import (
	"testing"

	"github.com/stirante/featurelab/random"
)

// TestWorldGenQuerySet pins the query surface feature Molang evaluates against: the six world_gen
// queries and nothing else. query.any_tag and query.all_tags belong to block and item descriptor
// tag expressions; registering them here would make an expression the game refuses to parse
// work in this tool.
func TestWorldGenQuerySet(t *testing.T) {
	ctx := NewMolangContext(random.New(1), NewScope(), &MolangBiome{ID: "x"}, nil, nil)
	want := []string{"above_top_solid", "has_all_biome_tags", "has_any_biome_tags", "has_biome_tag", "heightmap", "noise"}
	got := WorldGenQueryNames()
	if len(got) != len(want) {
		t.Fatalf("WorldGenQueryNames() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("WorldGenQueryNames() = %v, want %v", got, want)
		}
		if ctx.QueryFuncs[want[i]] == nil {
			t.Errorf("query.%s is in the set but not registered", want[i])
		}
	}
	if len(ctx.QueryFuncs) != len(want) {
		t.Errorf("registered %d queries, want exactly the %d in the set", len(ctx.QueryFuncs), len(want))
	}
	for _, name := range []string{"any_tag", "all_tags", "is_baby"} {
		if IsWorldGenQuery(name) {
			t.Errorf("IsWorldGenQuery(%q) = true", name)
		}
		if ctx.QueryFuncs[name] != nil {
			t.Errorf("query.%s is registered for world generation", name)
		}
	}
}

// TestBiomeTagQueryArguments pins the argument handling of the three tag queries, which is where
// they differ from each other and from the descriptor-side any_tag/all_tags.
func TestBiomeTagQueryArguments(t *testing.T) {
	biome := &MolangBiome{ID: "test:b", Tags: map[string]struct{}{"forest": {}, "overworld": {}}}
	ctx := NewMolangContext(random.New(1), NewScope(), biome, nil, nil)
	for expr, want := range map[string]float64{
		// has_biome_tag: one tag, and exactly 1, 3 or 4 arguments.
		"query.has_biome_tag('forest')":             1,
		"query.has_biome_tag('desert')":             0,
		"query.has_biome_tag('forest', 1)":          0, // 2 arguments is not a form it accepts
		"query.has_biome_tag('forest', 1, 2)":       1, // (tag, x, z)
		"query.has_biome_tag('forest', 1, 2, 3)":    1, // (tag, x, y, z)
		"query.has_biome_tag('forest', 1, 2, 3, 4)": 0,
		"query.has_biome_tag('desert', 'forest')":   0, // the second argument is a coordinate, not a tag
		// has_any_biome_tags: OR over every argument.
		"query.has_any_biome_tags('desert', 'forest')": 1,
		"query.has_any_biome_tags('desert')":           0,
		"query.has_any_biome_tags()":                   0,
		// has_all_biome_tags: AND over every argument, and 0 -- not 1 -- for none.
		"query.has_all_biome_tags('forest', 'overworld')": 1,
		"query.has_all_biome_tags('forest', 'desert')":    0,
		"query.has_all_biome_tags()":                      0,
	} {
		if got := mustRun(t, expr, ctx); got != want {
			t.Errorf("%s = %v, want %v", expr, got, want)
		}
	}
}
