package wire

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/rules"
)

// graphTestFile is one source file as the loader would have delivered it:
// the pack-relative path plus the text, which is all BuildGraph reads.
type graphTestFile struct{ id, text string }

// graphFeature wraps a body in the file shape a feature is declared in --
// format_version beside exactly one `minecraft:*` type key.
func graphFeature(path, typeID, identifier, body string) graphTestFile {
	comma := ""
	if body != "" {
		comma = ","
	}
	return graphTestFile{id: path, text: fmt.Sprintf(
		`{"format_version":"1.21.10","%s":{"description":{"identifier":"%s"}%s%s}}`,
		typeID, identifier, comma, body)}
}

func graphRule(path, identifier, placesFeature string) graphTestFile {
	return graphTestFile{id: path, text: fmt.Sprintf(
		`{"format_version":"1.13.0","minecraft:feature_rules":{"description":{"identifier":"%s",`+
			`"places_feature":"%s"},"conditions":{"placement_pass":"surface_pass"}}}`,
		identifier, placesFeature)}
}

func graphPack(featureFiles []graphTestFile, ruleFiles []graphTestFile) *pack.Pack {
	p := &pack.Pack{}
	for _, f := range featureFiles {
		p.Features = append(p.Features, features.SourceFile{ID: f.id, AbsPath: f.id, Text: f.text})
	}
	for _, f := range ruleFiles {
		p.Rules = append(p.Rules, rules.SourceFile{ID: f.id, AbsPath: f.id, Text: f.text})
	}
	return p
}

func graphOf(t *testing.T, featureFiles []graphTestFile, ruleFiles []graphTestFile) *Graph {
	t.Helper()
	g, err := BuildGraph(graphPack(featureFiles, ruleFiles))
	if err != nil {
		t.Fatalf("BuildGraph: %v", err)
	}
	return g
}

func graphNodeByID(t *testing.T, g *Graph, id string) GraphNode {
	t.Helper()
	for _, n := range g.Nodes {
		if n.ID == id {
			return n
		}
	}
	t.Fatalf("no node %q in %v", id, graphNodeIDs(g))
	return GraphNode{}
}

func graphNodeIDs(g *Graph) []string {
	out := make([]string, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		out = append(out, n.ID)
	}
	return out
}

func graphEdgesFrom(g *Graph, from string) []GraphEdge {
	var out []GraphEdge
	for _, e := range g.Edges {
		if e.From == from {
			out = append(out, e)
		}
	}
	return out
}

func graphOnlyEdge(t *testing.T, g *Graph, from string) GraphEdge {
	t.Helper()
	edges := graphEdgesFrom(g, from)
	if len(edges) != 1 {
		t.Fatalf("%s: want exactly 1 edge, got %d: %+v", from, len(edges), edges)
	}
	return edges[0]
}

// TestBuildGraph_EachDelegationKeyBecomesItsOwnEdgeKind pins the mapping the
// whole contract rests on: confusing sequence for aggregate, or a filter for
// a scatter, silently changes what a pack generates.
func TestBuildGraph_EachDelegationKeyBecomesItsOwnEdgeKind(t *testing.T) {
	cases := []struct {
		name     string
		file     graphTestFile
		rule     *graphTestFile
		from     string
		wantKind EdgeKind
		wantPath string
		wantTo   string
	}{
		{
			name:     "feature rule places_feature",
			rule:     ptrGraphFile(graphRule("r.json", "test:rule", "test:child")),
			from:     "test:rule",
			wantKind: EdgeRule,
			wantPath: "$.minecraft:feature_rules.description.places_feature",
		},
		{
			name:     "aggregate list entry",
			file:     graphFeature("a.json", "minecraft:aggregate_feature", "test:parent", `"features":["test:child"]`),
			wantKind: EdgeAggregate,
			wantPath: "$.minecraft:aggregate_feature.features[0]",
		},
		{
			name:     "sequence list entry",
			file:     graphFeature("a.json", "minecraft:sequence_feature", "test:parent", `"features":["test:child"]`),
			wantKind: EdgeSequence,
			wantPath: "$.minecraft:sequence_feature.features[0]",
		},
		{
			name: "weighted random tuple entry",
			file: graphFeature("a.json", "minecraft:weighted_random_feature", "test:parent",
				`"features":[["test:child",3]]`),
			wantKind: EdgeWeighted,
			wantPath: "$.minecraft:weighted_random_feature.features[0][0]",
		},
		{
			name: "weighted random object entry",
			file: graphFeature("a.json", "minecraft:weighted_random_feature", "test:parent",
				`"features":[{"feature":"test:child","weight":3}]`),
			wantKind: EdgeWeighted,
			wantPath: "$.minecraft:weighted_random_feature.features[0].feature",
		},
		{
			name: "conditional list entry",
			file: graphFeature("a.json", "minecraft:conditional_list", "test:parent",
				`"conditional_features":[{"places_feature":"test:child","condition":"1.0"}]`),
			wantKind: EdgeConditional,
			wantPath: "$.minecraft:conditional_list.conditional_features[0].places_feature",
		},
		{
			name: "scatter places_feature",
			file: graphFeature("a.json", "minecraft:scatter_feature", "test:parent",
				`"places_feature":"test:child","distribution":{"iterations":4}`),
			wantKind: EdgeScatter,
			wantPath: "$.minecraft:scatter_feature.places_feature",
		},
		{
			name: "snap_to_surface feature_to_snap",
			file: graphFeature("a.json", "minecraft:snap_to_surface_feature", "test:parent",
				`"feature_to_snap":"test:child","vertical_search_range":8`),
			wantKind: EdgeFilter,
			wantPath: "$.minecraft:snap_to_surface_feature.feature_to_snap",
		},
		{
			name: "surface_relative_threshold feature_to_place",
			file: graphFeature("a.json", "minecraft:surface_relative_threshold_feature", "test:parent",
				`"feature_to_place":"test:child"`),
			wantKind: EdgeFilter,
			wantPath: "$.minecraft:surface_relative_threshold_feature.feature_to_place",
		},
		{
			name: "height_difference_filter places_feature",
			file: graphFeature("a.json", "minecraft:height_difference_filter_feature", "test:parent",
				`"places_feature":"test:child","search_radius":4`),
			wantKind: EdgeFilter,
			wantPath: "$.minecraft:height_difference_filter_feature.places_feature",
		},
		{
			name: "scan_surface places_feature",
			file: graphFeature("a.json", "minecraft:scan_surface", "test:parent",
				`"places_feature":"test:child"`),
			wantKind: EdgeFilter,
			wantPath: "$.minecraft:scan_surface.places_feature",
		},
		{
			name: "scan_surface under the alias the file actually wrote",
			file: graphFeature("a.json", "minecraft:scan_surface", "test:parent",
				`"feature_to_scan":"test:child"`),
			wantKind: EdgeFilter,
			wantPath: "$.minecraft:scan_surface.feature_to_scan",
		},
		{
			name: "search places_feature",
			file: graphFeature("a.json", "minecraft:search_feature", "test:parent",
				`"places_feature":"test:child","search_volume":{"min":[0,0,0],"max":[1,1,1]}`),
			wantKind: EdgeFilter,
			wantPath: "$.minecraft:search_feature.places_feature",
		},
		{
			name: "vegetation_patch vegetation_feature",
			file: graphFeature("a.json", "minecraft:vegetation_patch_feature", "test:parent",
				`"vegetation_feature":"test:child","depth":3`),
			wantKind: EdgeChild,
			wantPath: "$.minecraft:vegetation_patch_feature.vegetation_feature",
		},
		{
			name: "fallen trunk log_decoration_feature",
			file: graphFeature("a.json", "minecraft:tree_feature", "test:parent",
				`"fallen_trunk":{"log_length":{"range_min":5,"range_max":8},"log_decoration_feature":"test:child"}`),
			wantKind: EdgeChild,
			wantPath: "$.minecraft:tree_feature.fallen_trunk.log_decoration_feature",
		},
		{
			name: "poplar trunk log_decoration_feature",
			file: graphFeature("a.json", "minecraft:tree_feature", "test:parent",
				`"poplar_trunk":{"log_decoration_feature":"test:child"}`),
			wantKind: EdgeChild,
			wantPath: "$.minecraft:tree_feature.poplar_trunk.log_decoration_feature",
		},
	}

	child := graphFeature("child.json", "minecraft:single_block_feature", "test:child",
		`"places_block":"minecraft:stone"`)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			featureFiles := []graphTestFile{child}
			var ruleFiles []graphTestFile
			from := "test:parent"
			if tc.rule != nil {
				ruleFiles = append(ruleFiles, *tc.rule)
				from = tc.from
			} else {
				featureFiles = append(featureFiles, tc.file)
			}
			g := graphOf(t, featureFiles, ruleFiles)

			e := graphOnlyEdge(t, g, from)
			if e.Kind != tc.wantKind {
				t.Errorf("kind = %q, want %q", e.Kind, tc.wantKind)
			}
			if e.JSONPath != tc.wantPath {
				t.Errorf("jsonPath = %q, want %q", e.JSONPath, tc.wantPath)
			}
			if e.To != "test:child" {
				t.Errorf("to = %q, want %q", e.To, "test:child")
			}
		})
	}
}

func ptrGraphFile(f graphTestFile) *graphTestFile { return &f }

// TestBuildGraph_ListOrdinalsAreDocumentOrder pins the field a sequence's
// meaning depends on: entry N of the file is Ordinal N, which for
// sequence_feature is the order the children actually run in.
func TestBuildGraph_ListOrdinalsAreDocumentOrder(t *testing.T) {
	for _, typeID := range []string{"minecraft:sequence_feature", "minecraft:aggregate_feature"} {
		t.Run(typeID, func(t *testing.T) {
			g := graphOf(t, []graphTestFile{graphFeature("a.json", typeID, "test:parent",
				`"features":["test:third","test:first","test:second"]`)}, nil)

			want := []string{"test:third", "test:first", "test:second"}
			edges := graphEdgesFrom(g, "test:parent")
			if len(edges) != len(want) {
				t.Fatalf("got %d edges, want %d", len(edges), len(want))
			}
			for _, e := range edges {
				if e.Ordinal < 0 || e.Ordinal >= len(want) {
					t.Fatalf("ordinal %d out of range", e.Ordinal)
				}
				if e.To != want[e.Ordinal] {
					t.Errorf("ordinal %d delegates to %q, want %q", e.Ordinal, e.To, want[e.Ordinal])
				}
				if e.JSONPath != fmt.Sprintf("$.%s.features[%d]", typeID, e.Ordinal) {
					t.Errorf("ordinal %d has path %q", e.Ordinal, e.JSONPath)
				}
			}
		})
	}
}

// TestBuildGraph_AbsentConditionIsNilNotOne is the distinction the contract
// spells out: an entry with no condition is always-true, and an editor must
// be able to tell that from an author who wrote the constant 1.0.
func TestBuildGraph_AbsentConditionIsNilNotOne(t *testing.T) {
	g := graphOf(t, []graphTestFile{graphFeature("a.json", "minecraft:conditional_list", "test:parent",
		`"conditional_features":[{"places_feature":"test:a"},{"places_feature":"test:b","condition":"q.is_daytime"},`+
			`{"places_feature":"test:c","condition":1.0}]`)}, nil)

	edges := graphEdgesFrom(g, "test:parent")
	if len(edges) != 3 {
		t.Fatalf("got %d edges, want 3", len(edges))
	}
	if edges[0].Condition != nil {
		t.Errorf("absent condition = %q, want nil", *edges[0].Condition)
	}
	if edges[1].Condition == nil || *edges[1].Condition != "q.is_daytime" {
		t.Errorf("molang condition = %v, want %q", edges[1].Condition, "q.is_daytime")
	}
	if edges[2].Condition == nil || *edges[2].Condition != "1" {
		t.Errorf("numeric condition = %v, want %q", edges[2].Condition, "1")
	}
}

// TestBuildGraph_WeightIsReadOnlyWhereTheAuthorWroteOne applies the same
// rule to weighted_random's object form, which the engine defaults to 1.0:
// the default is not written onto the edge, so nothing can write it back
// into a file that never had it.
func TestBuildGraph_WeightIsReadOnlyWhereTheAuthorWroteOne(t *testing.T) {
	g := graphOf(t, []graphTestFile{graphFeature("a.json", "minecraft:weighted_random_feature", "test:parent",
		`"features":[["test:a",7],{"places_feature":"test:b","weight":2.5},{"feature":"test:c"}]`)}, nil)

	edges := graphEdgesFrom(g, "test:parent")
	if len(edges) != 3 {
		t.Fatalf("got %d edges, want 3", len(edges))
	}
	cases := []struct {
		path   string
		weight *float64
	}{
		{"$.minecraft:weighted_random_feature.features[0][0]", graphFloat(7)},
		{"$.minecraft:weighted_random_feature.features[1].places_feature", graphFloat(2.5)},
		{"$.minecraft:weighted_random_feature.features[2].feature", nil},
	}
	for i, want := range cases {
		if edges[i].JSONPath != want.path {
			t.Errorf("edge %d path = %q, want %q", i, edges[i].JSONPath, want.path)
		}
		switch {
		case want.weight == nil && edges[i].Weight != nil:
			t.Errorf("edge %d weight = %v, want nil", i, *edges[i].Weight)
		case want.weight != nil && edges[i].Weight == nil:
			t.Errorf("edge %d weight = nil, want %v", i, *want.weight)
		case want.weight != nil && *edges[i].Weight != *want.weight:
			t.Errorf("edge %d weight = %v, want %v", i, *edges[i].Weight, *want.weight)
		}
	}
}

func graphFloat(f float64) *float64 { return &f }

// TestBuildGraph_ScatterIterationsAsWritten pins both of the shapes a real
// pack writes `iterations` in, and that a Molang string survives as one --
// it is a full expression, not a count, so coercing it to a number would
// throw the pack's meaning away.
func TestBuildGraph_ScatterIterationsAsWritten(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"nested molang", `"places_feature":"test:child","distribution":{"iterations":"math.random(1,3)"}`, "math.random(1,3)"},
		{"nested number", `"places_feature":"test:child","distribution":{"iterations":12}`, "12"},
		{"flat legacy number", `"places_feature":"test:child","iterations":3`, "3"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := graphOf(t, []graphTestFile{
				graphFeature("a.json", "minecraft:scatter_feature", "test:parent", tc.body)}, nil)
			e := graphOnlyEdge(t, g, "test:parent")
			if e.Iterations == nil || *e.Iterations != tc.want {
				t.Fatalf("iterations = %v, want %q", e.Iterations, tc.want)
			}
		})
	}
}

// TestBuildGraph_FieldsDropTheDelegationKeysAndNothingElse: Fields is what
// an editor renders as the node's form, so it must lose the keys that became
// edges -- and keep everything else, including the `distribution` object a
// scatter's iterations was only MIRRORED out of.
func TestBuildGraph_FieldsDropTheDelegationKeysAndNothingElse(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("scatter.json", "minecraft:scatter_feature", "test:scatter",
			`"places_feature":"test:child","project_input_to_floor":true,"distribution":{"iterations":4}`),
		graphFeature("agg.json", "minecraft:aggregate_feature", "test:aggregate",
			`"features":["test:child"],"early_out":"first_failure"`),
		graphFeature("tree.json", "minecraft:tree_feature", "test:tree",
			`"fallen_trunk":{"log_length":{"range_min":5,"range_max":8},"log_decoration_feature":"test:child"}`),
	}, []graphTestFile{graphRule("r.json", "test:rule", "test:scatter")})

	scatter := graphNodeByID(t, g, "test:scatter").Fields
	if _, present := scatter["places_feature"]; present {
		t.Error("scatter Fields kept places_feature, which is the edge")
	}
	if scatter["project_input_to_floor"] != true {
		t.Errorf("scatter Fields lost project_input_to_floor: %v", scatter)
	}
	distribution, ok := scatter["distribution"].(map[string]any)
	if !ok || distribution["iterations"] != float64(4) {
		t.Errorf("scatter Fields lost the distribution object: %v", scatter)
	}

	aggregate := graphNodeByID(t, g, "test:aggregate").Fields
	if _, present := aggregate["features"]; present {
		t.Error("aggregate Fields kept features, which are the edges")
	}
	if aggregate["early_out"] != "first_failure" {
		t.Errorf("aggregate Fields lost early_out: %v", aggregate)
	}

	// A trunk's decoration is nested too: the trunk object has to survive
	// with everything the trunk shape needs, minus the one key.
	tree := graphNodeByID(t, g, "test:tree").Fields
	trunk, ok := tree["fallen_trunk"].(map[string]any)
	if !ok {
		t.Fatalf("tree Fields lost fallen_trunk: %v", tree)
	}
	if _, present := trunk["log_decoration_feature"]; present {
		t.Error("tree Fields kept fallen_trunk.log_decoration_feature, which is the edge")
	}
	if _, present := trunk["log_length"]; !present {
		t.Errorf("tree Fields lost fallen_trunk.log_length: %v", trunk)
	}

	// The rule is the other node whose delegation key is nested:
	// description has to survive with its identifier, minus places_feature
	// alone.
	rule := graphNodeByID(t, g, "test:rule").Fields
	description, ok := rule["description"].(map[string]any)
	if !ok {
		t.Fatalf("rule Fields lost description: %v", rule)
	}
	if _, present := description["places_feature"]; present {
		t.Error("rule Fields kept description.places_feature, which is the edge")
	}
	if description["identifier"] != "test:rule" {
		t.Errorf("rule Fields lost description.identifier: %v", description)
	}
	if _, present := rule["conditions"]; !present {
		t.Errorf("rule Fields lost conditions: %v", rule)
	}
}

// TestBuildGraph_RequiredMarksTheEdgesTheTypeCannotLoadWithout is what tells
// an editor "removing this is an error, not an edit". A list entry is
// required only when it is the last one, because these lists must be
// non-empty but any one of several can go.
func TestBuildGraph_RequiredMarksTheEdgesTheTypeCannotLoadWithout(t *testing.T) {
	cases := []struct {
		name string
		file graphTestFile
		want []bool
	}{
		{
			name: "the only entry of an aggregate cannot go",
			file: graphFeature("a.json", "minecraft:aggregate_feature", "test:parent", `"features":["test:a"]`),
			want: []bool{true},
		},
		{
			name: "one of several aggregate entries can",
			file: graphFeature("a.json", "minecraft:aggregate_feature", "test:parent", `"features":["test:a","test:b"]`),
			want: []bool{false, false},
		},
		{
			name: "the only entry of a weighted random cannot go",
			file: graphFeature("a.json", "minecraft:weighted_random_feature", "test:parent", `"features":[["test:a",1]]`),
			want: []bool{true},
		},
		{
			name: "a conditional entry always can -- an empty conditional_features still loads",
			file: graphFeature("a.json", "minecraft:conditional_list", "test:parent",
				`"conditional_features":[{"places_feature":"test:a"}]`),
			want: []bool{false},
		},
		{
			name: "a scatter cannot load without places_feature",
			file: graphFeature("a.json", "minecraft:scatter_feature", "test:parent",
				`"places_feature":"test:a","distribution":{"iterations":1}`),
			want: []bool{true},
		},
		{
			name: "a filter cannot load without its child",
			file: graphFeature("a.json", "minecraft:snap_to_surface_feature", "test:parent",
				`"feature_to_snap":"test:a"`),
			want: []bool{true},
		},
		{
			name: "a vegetation patch cannot load without its vegetation",
			file: graphFeature("a.json", "minecraft:vegetation_patch_feature", "test:parent",
				`"vegetation_feature":"test:a","depth":3`),
			want: []bool{true},
		},
		{
			name: "a trunk decoration can always go -- a trunk without one just places none",
			file: graphFeature("a.json", "minecraft:tree_feature", "test:parent",
				`"fallen_trunk":{"log_decoration_feature":"test:a"}`),
			want: []bool{false},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := graphOf(t, []graphTestFile{tc.file}, nil)
			edges := graphEdgesFrom(g, "test:parent")
			if len(edges) != len(tc.want) {
				t.Fatalf("got %d edges, want %d", len(edges), len(tc.want))
			}
			for i, want := range tc.want {
				if edges[i].Required != want {
					t.Errorf("edge %d (%s) required = %v, want %v", i, edges[i].JSONPath, edges[i].Required, want)
				}
			}
		})
	}
}

// TestBuildGraph_RuleEdgeIsRequired keeps the rule's own case honest: a rule
// without places_feature does not load at all.
func TestBuildGraph_RuleEdgeIsRequired(t *testing.T) {
	g := graphOf(t, nil, []graphTestFile{graphRule("r.json", "test:rule", "test:child")})
	if e := graphOnlyEdge(t, g, "test:rule"); !e.Required {
		t.Error("a rule's places_feature edge is not marked required")
	}
}

// TestBuildGraph_UnresolvedReferenceIsAVisibleNode: a reference the pack
// does not define must show up as a dangling edge into an empty node, not
// disappear -- the broken reference is the thing the author opened the
// editor to find.
func TestBuildGraph_UnresolvedReferenceIsAVisibleNode(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("a.json", "minecraft:aggregate_feature", "test:parent",
			`"features":["test:missing","test:missing"]`)}, nil)

	missing := graphNodeByID(t, g, "test:missing")
	if !missing.Unresolved {
		t.Error("test:missing is not marked Unresolved")
	}
	if missing.TypeID != "" || missing.File != "" || missing.Fields != nil {
		t.Errorf("an unresolved node carries more than its id: %+v", missing)
	}
	if got := len(graphNodeIDs(g)); got != 2 {
		t.Errorf("two references to one missing feature made %d nodes, want 2: %v", got, graphNodeIDs(g))
	}
	for _, e := range graphEdgesFrom(g, "test:parent") {
		if e.To != "test:missing" {
			t.Errorf("edge %s points at %q", e.JSONPath, e.To)
		}
	}
}

// TestBuildGraph_ReferenceResolvesWithoutRegardToCase mirrors the engine's
// registry, which matches identifiers case-insensitively: an edge written in
// another case resolves in game, so reporting it as dangling here would be a
// warning about a pack that works.
func TestBuildGraph_ReferenceResolvesWithoutRegardToCase(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("child.json", "minecraft:single_block_feature", "test:Child",
			`"places_block":"minecraft:stone"`),
		graphFeature("a.json", "minecraft:aggregate_feature", "test:parent", `"features":["TEST:child"]`),
	}, nil)

	e := graphOnlyEdge(t, g, "test:parent")
	if e.To != "test:Child" {
		t.Errorf("edge lands on %q, want the defining file's own spelling %q", e.To, "test:Child")
	}
	for _, n := range g.Nodes {
		if n.Unresolved {
			t.Errorf("case-different reference produced a dangling node %q", n.ID)
		}
	}
}

// TestBuildGraph_RootsAreWhatNothingDelegatesTo: an editor opens on these,
// so a feature that is only ever reached through a rule must not be offered
// as a starting point.
func TestBuildGraph_RootsAreWhatNothingDelegatesTo(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("scatter.json", "minecraft:scatter_feature", "test:scatter",
			`"places_feature":"test:block","distribution":{"iterations":1}`),
		graphFeature("block.json", "minecraft:single_block_feature", "test:block",
			`"places_block":"minecraft:stone"`),
		graphFeature("orphan.json", "minecraft:single_block_feature", "test:orphan",
			`"places_block":"minecraft:dirt"`),
	}, []graphTestFile{graphRule("r.json", "test:rule", "test:scatter")})

	got := map[string]bool{}
	for _, id := range g.Roots {
		got[id] = true
	}
	want := map[string]bool{"test:rule": true, "test:orphan": true}
	for id := range want {
		if !got[id] {
			t.Errorf("%q is not a root, but nothing delegates to it (roots: %v)", id, g.Roots)
		}
	}
	for id := range got {
		if !want[id] {
			t.Errorf("%q is a root, but something delegates to it (roots: %v)", id, g.Roots)
		}
	}
}

// TestBuildGraph_CyclesAreReportedNotRefused: the engine guards recursion at
// run time, so a cycle is a legal pack. It still has to be announced, or a
// consumer laying the graph out as a tree walks forever.
func TestBuildGraph_CyclesAreReportedNotRefused(t *testing.T) {
	cases := []struct {
		name  string
		files []graphTestFile
		want  [][]string
	}{
		{
			name: "two features delegating to each other",
			files: []graphTestFile{
				graphFeature("a.json", "minecraft:aggregate_feature", "test:a", `"features":["test:b"]`),
				graphFeature("b.json", "minecraft:aggregate_feature", "test:b", `"features":["test:a"]`),
			},
			want: [][]string{{"test:a", "test:b"}},
		},
		{
			name: "a feature delegating to itself",
			files: []graphTestFile{
				graphFeature("a.json", "minecraft:aggregate_feature", "test:a", `"features":["test:a"]`),
			},
			want: [][]string{{"test:a"}},
		},
		{
			name: "a three-node loop, whichever node the walk enters it from",
			files: []graphTestFile{
				graphFeature("c.json", "minecraft:aggregate_feature", "test:c", `"features":["test:a"]`),
				graphFeature("b.json", "minecraft:aggregate_feature", "test:b", `"features":["test:c"]`),
				graphFeature("a.json", "minecraft:aggregate_feature", "test:a", `"features":["test:b"]`),
			},
			want: [][]string{{"test:a", "test:b", "test:c"}},
		},
		{
			name: "an acyclic pack reports none",
			files: []graphTestFile{
				graphFeature("a.json", "minecraft:aggregate_feature", "test:a", `"features":["test:b"]`),
				graphFeature("b.json", "minecraft:single_block_feature", "test:b", `"places_block":"minecraft:stone"`),
			},
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := graphOf(t, tc.files, nil)
			if len(g.Cycles) != len(tc.want) {
				t.Fatalf("got %d cycles %v, want %d", len(g.Cycles), g.Cycles, len(tc.want))
			}
			for i, want := range tc.want {
				got := g.Cycles[i]
				if len(got) != len(want) {
					t.Fatalf("cycle %d = %v, want %v", i, got, want)
				}
				for j := range want {
					if got[j] != want[j] {
						t.Fatalf("cycle %d = %v, want %v", i, got, want)
					}
				}
			}
			// The nodes in a cycle are still nodes: an editor has to be able
			// to open one to break the loop.
			for _, cycle := range g.Cycles {
				for _, id := range cycle {
					graphNodeByID(t, g, id)
				}
			}
		})
	}
}

// TestBuildGraph_NodeCarriesWhatTheEditorRendersItFrom pins the per-node
// identity fields, including format_version -- which is not decoration: the
// engine gates which keys a type accepts on it, so it decides the node's
// editable field set.
func TestBuildGraph_NodeCarriesWhatTheEditorRendersItFrom(t *testing.T) {
	arrayVersion := graphTestFile{id: "array.json", text: `{"format_version":[1,21,10],` +
		`"minecraft:single_block_feature":{"description":{"identifier":"test:array"},"places_block":"minecraft:stone"}}`}
	noVersion := graphTestFile{id: "none.json", text: `{"minecraft:single_block_feature":` +
		`{"description":{"identifier":"test:unversioned"},"places_block":"minecraft:stone"}}`}

	g := graphOf(t, []graphTestFile{
		graphFeature("block.json", "minecraft:single_block_feature", "test:block", `"places_block":"minecraft:stone"`),
		arrayVersion,
		noVersion,
	}, []graphTestFile{graphRule("r.json", "test:rule", "test:block")})

	block := graphNodeByID(t, g, "test:block")
	if block.TypeID != "minecraft:single_block_feature" {
		t.Errorf("typeId = %q", block.TypeID)
	}
	if block.File != "block.json" {
		t.Errorf("file = %q, want the pack-relative path", block.File)
	}
	if block.FormatVersion != "1.21.10" {
		t.Errorf("formatVersion = %q, want %q", block.FormatVersion, "1.21.10")
	}
	if graphNodeByID(t, g, "test:array").FormatVersion != "1.21.10" {
		t.Error("the array spelling of format_version did not read back as the dotted one")
	}
	if v := graphNodeByID(t, g, "test:unversioned").FormatVersion; v != "" {
		t.Errorf("a file declaring no format_version reported %q", v)
	}

	rule := graphNodeByID(t, g, "test:rule")
	if rule.TypeID != "minecraft:feature_rule" {
		t.Errorf("a rule's typeId = %q, want %q", rule.TypeID, "minecraft:feature_rule")
	}
	if rule.File != "r.json" {
		t.Errorf("a rule's file = %q", rule.File)
	}
}

// TestBuildGraph_CoverageComesFromTheCoverageTable: an editor must refuse to
// offer a type this tool does not implement, and must show the note beside a
// partial one rather than pretending it is complete.
func TestBuildGraph_CoverageComesFromTheCoverageTable(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("a.json", "minecraft:aggregate_feature", "test:aggregate", `"features":["test:aggregate"]`),
		graphFeature("u.json", "minecraft:not_a_feature_type", "test:unknown", ""),
	}, []graphTestFile{graphRule("r.json", "test:rule", "test:aggregate")})

	aggregate := graphNodeByID(t, g, "test:aggregate")
	want, ok := features.CoverageFor("minecraft:aggregate_feature")
	if !ok {
		t.Fatal("the coverage table no longer has minecraft:aggregate_feature")
	}
	if aggregate.Coverage != string(want.Status) {
		t.Errorf("coverage = %q, want %q", aggregate.Coverage, want.Status)
	}
	if aggregate.CoverageNote != want.Note {
		t.Errorf("coverageNote = %q, want %q", aggregate.CoverageNote, want.Note)
	}
	// A type the table has never heard of, and a rule, both get nothing
	// rather than an invented status.
	if c := graphNodeByID(t, g, "test:unknown").Coverage; c != "" {
		t.Errorf("an unregistered type reported coverage %q", c)
	}
	if c := graphNodeByID(t, g, "test:rule").Coverage; c != "" {
		t.Errorf("a rule reported feature-type coverage %q", c)
	}
}

// TestBuildGraph_FileThatWouldNotLoadStillHasANode is the reason this reads
// JSON rather than the built libraries: the loader drops a file whose type
// it cannot build, and that file is exactly the one someone opens an editor
// to fix.
func TestBuildGraph_FileThatWouldNotLoadStillHasANode(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		// Real type, missing its required search_radius -- the builder
		// refuses this file, so it has no entry in a built library.
		graphFeature("h.json", "minecraft:height_difference_filter_feature", "test:broken",
			`"places_feature":"test:child"`),
		// No such type at all.
		graphFeature("u.json", "minecraft:not_a_feature_type", "test:unknown", `"places_feature":"test:child"`),
	}, nil)

	broken := graphNodeByID(t, g, "test:broken")
	if broken.Unresolved {
		t.Error("a file that fails to build was reported as an unresolved reference")
	}
	if e := graphOnlyEdge(t, g, "test:broken"); e.To != "test:child" {
		t.Errorf("edge from the broken file = %q", e.To)
	}
	unknown := graphNodeByID(t, g, "test:unknown")
	if unknown.TypeID != "minecraft:not_a_feature_type" {
		t.Errorf("typeId = %q, want the type the file actually wrote", unknown.TypeID)
	}
	// An unknown type has no delegation keys this tool can name, so its
	// places_feature stays a plain field rather than becoming an edge it
	// might not be.
	if len(graphEdgesFrom(g, "test:unknown")) != 0 {
		t.Error("an unknown type produced delegation edges")
	}
	if unknown.Fields["places_feature"] != "test:child" {
		t.Errorf("an unknown type's fields lost places_feature: %v", unknown.Fields)
	}
}

// TestBuildGraph_UnreadableFileIsLeftOutRatherThanFailingTheWholeGraph: the
// library build already diagnoses these by file, and one bad file must not
// cost the author the graph of the other three thousand.
func TestBuildGraph_UnreadableFileIsLeftOutRatherThanFailingTheWholeGraph(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		{id: "bad.json", text: `{"minecraft:single_block_feature":{`},
		{id: "anon.json", text: `{"minecraft:single_block_feature":{"places_block":"minecraft:stone"}}`},
		graphFeature("ok.json", "minecraft:single_block_feature", "test:ok", `"places_block":"minecraft:stone"`),
	}, nil)

	if ids := graphNodeIDs(g); len(ids) != 1 || ids[0] != "test:ok" {
		t.Fatalf("nodes = %v, want only test:ok", ids)
	}
}

// TestBuildGraph_ACaseCollidingIdentifierKeepsOneNode: identifiers are
// matched without regard to case and the first file to claim one keeps it,
// so the second file names a feature nothing can place. Two nodes would
// break the uniqueness of GraphNode.ID as well as showing an editor a
// feature the game ignores.
func TestBuildGraph_ACaseCollidingIdentifierKeepsOneNode(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("first.json", "minecraft:single_block_feature", "test:dup", `"places_block":"minecraft:stone"`),
		graphFeature("second.json", "minecraft:single_block_feature", "test:DUP", `"places_block":"minecraft:dirt"`),
	}, nil)

	if ids := graphNodeIDs(g); len(ids) != 1 {
		t.Fatalf("nodes = %v, want one", ids)
	}
	if n := graphNodeByID(t, g, "test:dup"); n.File != "first.json" {
		t.Errorf("the surviving node came from %q, want the first file loaded", n.File)
	}
}

// TestBuildGraph_EveryPathIsTheOneDialect: an annotation reaches an edge
// only by string equality between Annotation.JSONPath and
// GraphEdge.JSONPath, so an edge addressed in a second dialect does not
// mismatch loudly -- the annotation attaches to nothing. Every path here is
// therefore jsonc.FormatPath's, which this checks by round-tripping: a
// hand-built string that happens to look right would not survive ParsePath
// and FormatPath returning it unchanged.
func TestBuildGraph_EveryPathIsTheOneDialect(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("w.json", "minecraft:weighted_random_feature", "test:weighted",
			`"features":[["test:a",1],{"feature":"test:b"}]`),
		graphFeature("c.json", "minecraft:conditional_list", "test:conditional",
			`"conditional_features":[{"places_feature":"test:a"}]`),
		graphFeature("s.json", "minecraft:scatter_feature", "test:scatter",
			`"places_feature":"test:a","distribution":{"iterations":1}`),
		graphFeature("t.json", "minecraft:tree_feature", "test:tree",
			`"fallen_trunk":{"log_decoration_feature":"test:a"}`),
	}, []graphTestFile{graphRule("r.json", "test:rule", "test:scatter")})

	if len(g.Edges) == 0 {
		t.Fatal("no edges to check")
	}
	for _, e := range g.Edges {
		segments, err := jsonc.ParsePath(e.JSONPath)
		if err != nil {
			t.Errorf("%s -> %s: JSONPath %q is not a jsonc path: %v", e.From, e.To, e.JSONPath, err)
			continue
		}
		if round := jsonc.FormatPath(segments); round != e.JSONPath {
			t.Errorf("%s -> %s: JSONPath %q is not FormatPath's spelling of itself (%q)",
				e.From, e.To, e.JSONPath, round)
		}
	}
}

// TestBuildGraph_NeedsALoadedPack: the only failure this has.
func TestBuildGraph_NeedsALoadedPack(t *testing.T) {
	if _, err := BuildGraph(nil); err == nil {
		t.Fatal("BuildGraph(nil) returned no error")
	}
	g, err := BuildGraph(&pack.Pack{})
	if err != nil {
		t.Fatalf("an empty pack is not an error: %v", err)
	}
	if len(g.Nodes) != 0 || len(g.Edges) != 0 || len(g.Roots) != 0 || len(g.Cycles) != 0 {
		t.Errorf("an empty pack produced %+v", g)
	}
}

// TestBuildGraph_EveryEdgePathCanActuallyBeApplied is the test whose absence
// let every edge path in this package be unusable without anything failing.
//
// The sibling tests above compare JSONPath against an expected STRING, so
// they pin the spelling and say nothing about whether the address resolves.
// Both halves were rooted at the feature body -- `$.features[0]` -- while the
// two things that consume these paths, jsonc.Apply and the annotation
// scanner, both root at the document. The strings matched each other
// perfectly and addressed nothing, and an editor writing a change through one
// would have got "$.features does not exist" for every edge in every pack.
//
// So this asserts the property rather than the text: take the real file, take
// the edge the builder reported, and make the edit. If a path is rooted
// wrongly -- or re-rooted wrongly later -- this fails, whatever it is spelled
// like.
func TestBuildGraph_EveryEdgePathCanActuallyBeApplied(t *testing.T) {
	files := []graphTestFile{
		graphFeature("agg.json", "minecraft:aggregate_feature", "test:agg", `"features":["test:leaf","test:leaf2"]`),
		graphFeature("seq.json", "minecraft:sequence_feature", "test:seq", `"features":["test:leaf"]`),
		graphFeature("cond.json", "minecraft:conditional_list", "test:cond",
			`"conditional_features":[{"places_feature":"test:leaf","condition":"1.0"}]`),
		graphFeature("scatter.json", "minecraft:scatter_feature", "test:scatter",
			`"places_feature":"test:leaf","iterations":1,"x":0,"y":0,"z":0`),
		graphFeature("snap.json", "minecraft:snap_to_surface_feature", "test:snap",
			`"feature_to_snap":"test:leaf","vertical_search_range":8`),
	}
	g := graphOf(t, files, nil)
	byFile := make(map[string]string, len(files))
	for _, f := range files {
		byFile[f.id] = f.text
	}

	if len(g.Edges) == 0 {
		t.Fatal("no edges to check; this guard is not looking at the graph it thinks it is")
	}
	for _, e := range g.Edges {
		var src string
		for _, n := range g.Nodes {
			if n.ID == e.From {
				src = byFile[n.File]
			}
		}
		if src == "" {
			continue // an unresolved target has no file, and no path of its own
		}
		// The value is deliberately a string: every one of these addresses a
		// feature reference, so writing one back is the ordinary edit an
		// editor makes when someone repoints a delegation.
		out, err := jsonc.Apply([]byte(src), jsonc.Edit{Path: e.JSONPath, Value: []byte(`"test:rewired"`)})
		if err != nil {
			t.Errorf("edge %s -> %s: its own JSONPath %q cannot be applied to its own file: %v",
				e.From, e.To, e.JSONPath, err)
			continue
		}
		if !strings.Contains(string(out), "test:rewired") {
			t.Errorf("edge %s -> %s: applying %q changed nothing", e.From, e.To, e.JSONPath)
		}
	}
}

// TestBuildGraph_MolangPathsLandOnTheMolangAndNotBesideIt: the two Molang
// slots have their own paths because neither is derivable from JSONPath,
// which names the `places_feature` the edge was read from. The obvious
// derivation -- JSONPath + ".iterations" -- addresses a member of a string.
//
// So this asserts by APPLYING, not by comparing spellings. A path that is
// merely well-formed is worth nothing here: the bug this guards against
// produced paths that looked exactly right and wrote into the wrong object.
func TestBuildGraph_MolangPathsLandOnTheMolangAndNotBesideIt(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		typeID string
		// where the written value has to end up, as a JSON substring
		want string
	}{
		{
			name:   "nested iterations stay nested",
			typeID: "minecraft:scatter_feature",
			body:   `"places_feature":"test:child","distribution":{"iterations":4}`,
			want:   `"iterations":"9"`,
		},
		{
			name:   "flat iterations stay flat",
			typeID: "minecraft:scatter_feature",
			body:   `"places_feature":"test:child","iterations":4`,
			want:   `"iterations":"9"`,
		},
		{
			// The case that made a derived path unsafe: a file carrying BOTH
			// shapes. The value was read from the flat key, so that is the
			// copy an edit has to land on -- writing the nested one would
			// leave the author's live value untouched and add a dead twin.
			name:   "a flat value wins over an empty distribution beside it",
			typeID: "minecraft:scatter_feature",
			body:   `"places_feature":"test:child","iterations":4,"distribution":{"x":0}`,
			want:   `"iterations":"9"`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			file := graphFeature("a.json", tc.typeID, "test:parent", tc.body)
			g := graphOf(t, []graphTestFile{file}, nil)
			e := graphOnlyEdge(t, g, "test:parent")
			if e.IterationsPath == "" {
				t.Fatal("no IterationsPath, so an editor has nowhere to write")
			}
			out, err := jsonc.Apply([]byte(file.text), jsonc.Edit{Path: e.IterationsPath, Value: []byte(`"9"`)})
			if err != nil {
				t.Fatalf("IterationsPath %q cannot be applied to its own file: %v", e.IterationsPath, err)
			}
			// Whitespace-insensitive: the writer preserves the source's own
			// spacing, and this fixture is compact.
			flat := strings.ReplaceAll(string(out), " ", "")
			if !strings.Contains(flat, tc.want) {
				t.Fatalf("applying %q gave:\n%s\nwant it to contain %s", e.IterationsPath, out, tc.want)
			}
			// And it must not have grown a second copy.
			if strings.Count(string(out), `"iterations"`) != 1 {
				t.Fatalf("applying %q produced two iterations keys:\n%s", e.IterationsPath, out)
			}
		})
	}
}

// TestBuildGraph_ConditionPathIsSetEvenWhenThereIsNoCondition: an absent
// condition means always-true, and adding one is the edit an author most
// often wants to make on such a branch. That is exactly when the value is
// nil, so a path supplied only alongside a value would be missing whenever
// it mattered.
func TestBuildGraph_ConditionPathIsSetEvenWhenThereIsNoCondition(t *testing.T) {
	file := graphFeature("cond.json", "minecraft:conditional_list", "test:cond",
		`"conditional_features":[{"places_feature":"test:leaf"}]`)
	g := graphOf(t, []graphTestFile{file}, nil)
	e := graphOnlyEdge(t, g, "test:cond")
	if e.Condition != nil {
		t.Fatalf("condition = %q, want nil for an always-true branch", *e.Condition)
	}
	if e.ConditionPath == "" {
		t.Fatal("no ConditionPath on a branch with no condition -- which is the case that needs one")
	}
	out, err := jsonc.Apply([]byte(file.text), jsonc.Edit{Path: e.ConditionPath, Value: []byte(`"q.noise(1,2) > 0"`)})
	if err != nil {
		t.Fatalf("ConditionPath %q cannot be applied: %v", e.ConditionPath, err)
	}
	flat := strings.ReplaceAll(string(out), " ", "")
	if !strings.Contains(flat, `"condition":"q.noise(1,2)>0"`) {
		t.Fatalf("applying %q gave:\n%s", e.ConditionPath, out)
	}
	// It has to sit inside the entry, not beside the list.
	if !strings.Contains(flat, `"places_feature":"test:leaf"`) {
		t.Fatalf("the entry lost its places_feature:\n%s", out)
	}
}
