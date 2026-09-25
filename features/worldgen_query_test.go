package features

import (
	"errors"
	"strings"
	"testing"

	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

// A query outside the world_gen set fails to parse in game. These tests pin the two outcomes that
// follow, which differ by field: a scatter's distribution loads with the whole expression at 0; a
// conditional_list condition fails validation and the feature does not load.

func TestParseMolangValue_RefusesNonWorldGenQueries(t *testing.T) {
	for src, want := range map[string][]string{
		"query.any_tag('forest')":  {"any_tag"},
		"query.all_tags('a', 'b')": {"all_tags"},
		"q.is_baby":                {"is_baby"},
		"query.has_biome_tag('a') && q.any_tag('b') || q.is_baby": {"any_tag", "is_baby"},
		"query.has_any_biome_tags('a', 'b') ? 1 : q.noise(0, 0)":  nil,
		"query.has_biome_tag('a', q.above_top_solid(0, 0), 1, 2)": nil,
	} {
		_, err := ParseMolangValue(src)
		if want == nil {
			if err != nil {
				t.Errorf("%q: unexpected error %v", src, err)
			}
			continue
		}
		var uq *UnresolvedQueryError
		if !errors.As(err, &uq) {
			t.Errorf("%q: got %v, want an UnresolvedQueryError", src, err)
			continue
		}
		if strings.Join(uq.Queries, ",") != strings.Join(want, ",") {
			t.Errorf("%q: unresolved %v, want %v", src, uq.Queries, want)
		}
	}
	_, err := ParseMolangValue("query.any_tag('forest')")
	for _, part := range []string{
		"Failed to resolve query any_tag.  Either the query does not exist or it is not supported in this context.",
		"has_any_biome_tags",
	} {
		if !strings.Contains(err.Error(), part) {
			t.Errorf("message %q lacks %q", err, part)
		}
	}
}

func TestScatterDistribution_NonWorldGenQueryLoadsAndEvaluatesToZero(t *testing.T) {
	var warnings []string
	dist, err := ParseScatterDistribution(map[string]any{
		"iterations":     "query.any_tag('forest') ? 8 : 4",
		"scatter_chance": "q.is_baby + 50",
		"x":              map[string]any{"distribution": "uniform", "extent": []any{"q.all_tags('a')", 15.0}},
		"y":              "q.heightmap(v.worldx, v.worldz)",
		"z":              "q.is_baby + 3",
	}, "distribution", func(m string) { warnings = append(warnings, m) })
	if err != nil {
		t.Fatalf("the feature must load: %v", err)
	}
	if len(warnings) != 4 {
		t.Fatalf("got %d warnings, want 4 (iterations, x.extent[0], z, scatter_chance): %v", len(warnings), warnings)
	}
	for _, w := range warnings {
		if !strings.Contains(w, "Failed to resolve query") || !strings.Contains(w, "evaluates to 0") {
			t.Errorf("warning %q does not quote the game's error and say what it costs", w)
		}
	}
	ctx := wgen.NewMolangContext(random.New(1), wgen.NewScope(), &wgen.MolangBiome{ID: "b", Tags: map[string]struct{}{"forest": {}}}, nil, nil)
	for name, e := range map[string]*MolangExpr{
		"iterations": dist.Iterations, "x.min": dist.AxisX.Min, "z": dist.AxisZ.Min, "chance": dist.Chance.Expr,
	} {
		if e.IsConstant() {
			t.Errorf("%s: a failed parse must not be constant (the load-time constant rewrites skip it)", name)
		}
		if got := e.Evaluate(ctx); got != 0 {
			t.Errorf("%s = %v, want 0", name, got)
		}
	}
	if dist.AxisX.Max.Evaluate(ctx) != 15 {
		t.Error("the other end of the extent is unaffected")
	}
	// A non-constant 0 percent is not rewritten to 100: it never scatters.
	if ShouldScatter(dist.Chance, ctx, random.New(1)) {
		t.Error("scatter_chance that failed to parse scattered; it evaluates to 0")
	}
}

func TestConditionalList_NonWorldGenQueryConditionIsRefused(t *testing.T) {
	_, err := parseConditionalFeatures([]any{
		map[string]any{"places_feature": "test:a", "condition": "query.any_tag('forest')"},
	})
	var uq *UnresolvedQueryError
	if !errors.As(err, &uq) {
		t.Fatalf("got %v, want the feature refused with an UnresolvedQueryError", err)
	}
	if _, err := parseConditionalFeatures([]any{
		map[string]any{"places_feature": "test:a", "condition": "query.has_any_biome_tags('forest', 'taiga')"},
	}); err != nil {
		t.Fatalf("has_any_biome_tags must be accepted: %v", err)
	}
}
