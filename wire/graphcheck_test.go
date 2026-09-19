package wire

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stirante/featurelab/session"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func gcStr(s string) *string   { return &s }
func gcNum(f float64) *float64 { return &f }

func gcNode(id, typeID string, ann ...Annotation) GraphNode {
	return GraphNode{ID: id, TypeID: typeID, File: "features/" + id + ".json", Annotations: ann}
}

func gcIgnore(names ...string) Annotation {
	return Annotation{Name: "ignore", Args: names, JSONPath: "$", Line: 1}
}

// gcFindings renders each diagnostic as "level:identifier:check", the three
// things a test cares about: how loud it is, which node it is charged to, and
// which check raised it. The check is recovered from the message's own
// "(@featurelab:ignore <check>)" suffix, which also pins that every diagnostic
// really does tell the author how to silence it.
func gcFindings(t *testing.T, diags []session.Diagnostic) []string {
	t.Helper()
	out := make([]string, 0, len(diags))
	for _, d := range diags {
		const open = "(@featurelab:ignore "
		i := strings.LastIndex(d.Message, open)
		if i < 0 || !strings.HasSuffix(d.Message, ")") {
			t.Fatalf("diagnostic does not name its check: %q", d.Message)
		}
		check := d.Message[i+len(open) : len(d.Message)-1]
		if d.Count != 1 {
			t.Errorf("Count should always be 1 for a graph diagnostic, got %d", d.Count)
		}
		if d.Position != nil {
			t.Errorf("Position should be nil for a graph diagnostic, got %v", *d.Position)
		}
		out = append(out, fmt.Sprintf("%s:%s:%s", d.Level, d.Identifier, check))
	}
	return out
}

func gcCheck(t *testing.T, g *Graph, want []string, wantContains ...string) {
	t.Helper()
	diags := CheckGraph(g)
	got := gcFindings(t, diags)
	if len(got) != len(want) {
		t.Fatalf("got %d findings %v, want %d %v\nmessages:\n%s", len(got), got, len(want), want, gcMessages(diags))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("finding %d: got %q, want %q\nmessages:\n%s", i, got[i], want[i], gcMessages(diags))
		}
	}
	for _, sub := range wantContains {
		found := false
		for _, d := range diags {
			if strings.Contains(d.Message, sub) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no diagnostic mentions %q\nmessages:\n%s", sub, gcMessages(diags))
		}
	}
}

func gcMessages(diags []session.Diagnostic) string {
	var b strings.Builder
	for _, d := range diags {
		fmt.Fprintf(&b, "  [%s] %s: %s\n", d.Level, d.Identifier, d.Message)
	}
	return b.String()
}

// gcScatter is the smallest well-formed graph this file reuses: a scatter that
// places a single block, with a legal iterations expression. Tests mutate a
// copy of it so that each one differs from a CLEAN graph in exactly the way it
// is about.
func gcScatter() *Graph {
	return &Graph{
		Nodes: []GraphNode{
			gcNode("test:scatter", "minecraft:scatter_feature"),
			gcNode("test:block", "minecraft:single_block_feature"),
		},
		Edges: []GraphEdge{{
			From: "test:scatter", To: "test:block", Kind: EdgeScatter,
			JSONPath: "$.places_feature", Required: true, Iterations: gcStr("4"),
		}},
		Roots: []string{"test:scatter"},
	}
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

func TestGraphCheckStructure(t *testing.T) {
	tests := []struct {
		// name states the CLAIM the case pins, not the input it uses.
		name         string
		graph        *Graph
		want         []string
		wantContains []string
	}{
		{
			name:  "a well-formed graph produces nothing at all",
			graph: gcScatter(),
			want:  nil,
		},
		{
			name: "a type that delegates to exactly one feature is an error with none",
			graph: &Graph{
				Nodes: []GraphNode{gcNode("test:snap", "minecraft:snap_to_surface_feature")},
				Roots: []string{"test:snap"},
			},
			want:         []string{"error:test:snap:required-edge"},
			wantContains: []string{"feature_to_snap"},
		},
		{
			name: "a type that delegates to exactly one feature is an error with two",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:search", "minecraft:search_feature"),
					gcNode("test:a", "minecraft:ore_feature"),
					gcNode("test:b", "minecraft:ore_feature"),
				},
				Edges: []GraphEdge{
					{From: "test:search", To: "test:a", Kind: EdgeFilter, JSONPath: "$.places_feature", Required: true},
					{From: "test:search", To: "test:b", Kind: EdgeFilter, JSONPath: "$.places_feature", Required: true},
				},
				Roots: []string{"test:search"},
			},
			want:         []string{"error:test:search:edge-arity"},
			wantContains: []string{"exactly one feature reference"},
		},
		{
			name: "an edge of a kind the source type does not delegate by is an error",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:seq", "minecraft:sequence_feature"),
					gcNode("test:a", "minecraft:ore_feature"),
				},
				Edges: []GraphEdge{
					{From: "test:seq", To: "test:a", Kind: EdgeAggregate, JSONPath: "$.features[0]"},
				},
				Roots: []string{"test:seq"},
			},
			want:         []string{"error:test:seq:edge-arity"},
			wantContains: []string{"an edge of kind aggregate does not belong"},
		},
		{
			name: "an empty weighted_random does not load, an empty aggregate is left alone",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:weighted", "minecraft:weighted_random_feature"),
					gcNode("test:aggregate", "minecraft:aggregate_feature"),
				},
				Roots: []string{"test:weighted", "test:aggregate"},
			},
			want: []string{"error:test:weighted:required-edge"},
		},
		{
			name: "an edge into an unresolved node is a dangling reference",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:seq", "minecraft:sequence_feature"),
					{ID: "test:typo", Unresolved: true},
				},
				Edges: []GraphEdge{
					{From: "test:seq", To: "test:typo", Kind: EdgeSequence, JSONPath: "$.features[0]"},
				},
				Roots: []string{"test:seq"},
			},
			want:         []string{"error:test:seq:unresolved-target"},
			wantContains: []string{"no loaded file defines"},
		},
		{
			name: "an edge whose target is not a node at all is still reported",
			graph: &Graph{
				Nodes: []GraphNode{gcNode("test:seq", "minecraft:sequence_feature")},
				Edges: []GraphEdge{
					{From: "test:seq", To: "test:nowhere", Kind: EdgeSequence, JSONPath: "$.features[0]"},
				},
				Roots: []string{"test:seq"},
			},
			want:         []string{"error:test:seq:unresolved-target"},
			wantContains: []string{"not a node in this graph"},
		},
		{
			name: "a required edge with no target is an error and an optional one is not",
			graph: &Graph{
				Nodes: []GraphNode{gcNode("test:seq", "minecraft:sequence_feature")},
				Edges: []GraphEdge{
					{From: "test:seq", To: "", Kind: EdgeSequence, JSONPath: "$.features[0]", Required: true},
					{From: "test:seq", To: "", Kind: EdgeSequence, JSONPath: "$.features[1]"},
				},
				Roots: []string{"test:seq"},
			},
			want: []string{"error:test:seq:required-edge"},
		},
		{
			name: "a named child slot is checked like any other edge when it dangles",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:patch", "minecraft:vegetation_patch_feature"),
					{ID: "test:typo", Unresolved: true},
				},
				Edges: []GraphEdge{
					{From: "test:patch", To: "test:typo", Kind: EdgeChild, JSONPath: "$.vegetation_feature", Required: true},
				},
				Roots: []string{"test:patch"},
			},
			want: []string{"error:test:patch:unresolved-target"},
		},
		{
			name: "a type whose named child slot is optional is not nagged for leaving it empty",
			// A tree without a log decoration is a tree. Whether a named child
			// is required is the type's business, not the edge kind's, so
			// nothing here invents one.
			graph: &Graph{
				Nodes: []GraphNode{gcNode("test:tree", "minecraft:tree_feature")},
				Roots: []string{"test:tree"},
			},
			want: nil,
		},
		{
			name: "a scatter with no iterations does not load",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:scatter", "minecraft:scatter_feature"),
					gcNode("test:block", "minecraft:single_block_feature"),
				},
				Edges: []GraphEdge{
					{From: "test:scatter", To: "test:block", Kind: EdgeScatter, JSONPath: "$.places_feature", Required: true},
				},
				Roots: []string{"test:scatter"},
			},
			want: []string{"error:test:scatter:edge-iterations"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gcCheck(t, tt.graph, tt.want, tt.wantContains...)
		})
	}
}

func TestGraphCheckWeights(t *testing.T) {
	graphWith := func(weights ...*float64) *Graph {
		g := &Graph{
			Nodes: []GraphNode{gcNode("test:pick", "minecraft:weighted_random_feature")},
			Roots: []string{"test:pick"},
		}
		for i, w := range weights {
			id := fmt.Sprintf("test:entry%d", i)
			g.Nodes = append(g.Nodes, gcNode(id, "minecraft:ore_feature"))
			g.Edges = append(g.Edges, GraphEdge{
				From: "test:pick", To: id, Kind: EdgeWeighted, Ordinal: i,
				JSONPath: fmt.Sprintf("$.features[%d]", i), Weight: w,
			})
		}
		return g
	}

	tests := []struct {
		name         string
		graph        *Graph
		want         []string
		wantContains []string
	}{
		{
			// An absent weight is legal in the object entry shape, where it
			// defaults to 1, and fatal in the pair shape, which is exactly two
			// elements. The graph does not say which shape the file used, so
			// this is a warning that names both -- never an error that would be
			// false on every object-form entry.
			name:         "an absent weight is a warning, because the graph cannot tell which entry shape was written",
			graph:        graphWith(gcNum(1), nil),
			want:         []string{"warning:test:pick:edge-weight"},
			wantContains: []string{"entry 1 has no weight written", "does not load at all"},
		},
		{
			name:         "a negative weight is refused by the type",
			graph:        graphWith(gcNum(-1)),
			want:         []string{"error:test:pick:edge-weight"},
			wantContains: []string{"does not load"},
		},
		{
			name:         "a zero weight is never picked, whatever the seed or origin",
			graph:        graphWith(gcNum(1), gcNum(0)),
			want:         []string{"warning:test:pick:edge-weight"},
			wantContains: []string{"never the entry that gets picked"},
		},
		{
			name:  "ordinary weights say nothing",
			graph: graphWith(gcNum(1), gcNum(9)),
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gcCheck(t, tt.graph, tt.want, tt.wantContains...)
		})
	}
}

// ---------------------------------------------------------------------------
// Molang
// ---------------------------------------------------------------------------

// gcCond is a two-entry conditional_list whose first entry carries cond. The
// second entry exists so that a "the other entry writes it" case has somewhere
// to write from; setup is that entry's iterations in the cases that need it.
func gcCond(cond string, alsoIterations *string) *Graph {
	g := &Graph{
		Nodes: []GraphNode{
			gcNode("test:list", "minecraft:conditional_list"),
			gcNode("test:block", "minecraft:single_block_feature"),
		},
		Edges: []GraphEdge{{
			From: "test:list", To: "test:block", Kind: EdgeConditional, Ordinal: 0,
			JSONPath: "$.conditional_features[0]", Condition: gcStr(cond),
		}},
		Roots: []string{"test:list"},
	}
	if alsoIterations != nil {
		g.Nodes = append(g.Nodes, gcNode("test:setup", "minecraft:scatter_feature"))
		g.Edges = append(g.Edges, GraphEdge{
			From: "test:setup", To: "test:list", Kind: EdgeScatter,
			JSONPath: "$.places_feature", Required: true, Iterations: alsoIterations,
		})
		g.Roots = []string{"test:setup"}
	}
	return g
}

func TestGraphCheckMolang(t *testing.T) {
	tests := []struct {
		name         string
		graph        *Graph
		want         []string
		wantContains []string
	}{
		{
			name:         "an expression that is not Molang is reported as one finding",
			graph:        gcCond("query.noise(", nil),
			want:         []string{"error:test:list:molang-parse"},
			wantContains: []string{"is not valid Molang"},
		},
		{
			name: "an empty condition string is not the same as no condition",
			// A nil Condition means the author wrote none, which the type reads
			// as always-true; a written "" is an empty expression and does not
			// parse, so only the second says anything.
			graph: gcCond("", nil),
			want:  []string{"error:test:list:molang-parse"},
		},
		{
			name: "no condition at all says nothing",
			graph: &Graph{
				Nodes: []GraphNode{
					gcNode("test:list", "minecraft:conditional_list"),
					gcNode("test:block", "minecraft:single_block_feature"),
				},
				Edges: []GraphEdge{{From: "test:list", To: "test:block", Kind: EdgeConditional, JSONPath: "$.conditional_features[0]"}},
				Roots: []string{"test:list"},
			},
			want: nil,
		},
		{
			name:  "every query world generation answers is accepted",
			graph: gcCond("query.noise(v.originx, v.originz) > 0.2 && query.has_biome_tag('forest') && query.any_tag('a','b') && query.all_tags('a') && query.heightmap(0,0) > query.above_top_solid(0,0)", nil),
			want:  nil,
		},
		{
			name:         "a query nothing answers during world generation is an error",
			graph:        gcCond("query.is_baby", nil),
			want:         []string{"error:test:list:molang-query"},
			wantContains: []string{"query.is_baby", "above_top_solid"},
		},
		{
			name:         "a read of a slot nothing in the graph writes has no value to read",
			graph:        gcCond("variable.tree_height > 4", nil),
			want:         []string{"warning:test:list:molang-unset-read"},
			wantContains: []string{"variable.tree_height", "never true", "?? <default>"},
		},
		{
			name:  "a read of a slot an enclosing scatter's iterations writes is the idiom, not a fault",
			graph: gcCond("variable.tree_height > 4", gcStr("variable.tree_height = math.random_integer(3, 7); 1;")),
			want:  nil,
		},
		{
			name:  "the variables world generation publishes itself are never unset",
			graph: gcCond("math.mod(variable.worldx, 32) == 0 && variable.originy > 60", nil),
			want:  nil,
		},
		{
			name:         "temp and context reads are reported the same way",
			graph:        gcCond("temp.t > context.height", nil),
			want:         []string{"warning:test:list:molang-unset-read", "warning:test:list:molang-unset-read"},
			wantContains: []string{"context.height", "temp.t"},
		},
		{
			name:  "an expression that writes a slot before reading it needs nothing from the host",
			graph: gcCond("variable.n = 3; variable.n > 1;", nil),
			// The write silences the read; the assignment itself is the
			// side-effect warning below, in a condition.
			want: []string{"warning:test:list:molang-side-effect"},
		},
		{
			name:         "assigning from inside a condition is worth a warning, not an error",
			graph:        gcCond("variable.count = variable.originx; 1;", nil),
			want:         []string{"warning:test:list:molang-side-effect"},
			wantContains: []string{"early-out scheme"},
		},
		{
			name: "assigning from inside a scatter's iterations is never reported",
			// The Molang scope is shared with everything the scatter delegates
			// to, so this is how a pack sets up the values its children read.
			// Flagging it would be flagging correct, deliberate authoring.
			graph: func() *Graph {
				g := gcScatter()
				g.Edges[0].Iterations = gcStr("variable.radius = 4; variable.kind = math.random_integer(0,2); 6;")
				return g
			}(),
			want: nil,
		},
		{
			name: "randomness in a condition is not a side effect",
			// SideEffectOps(false) is the engine's own shape: assignment is
			// what the switch removes, and math.random is left alone.
			graph: gcCond("math.random(0,1) > 0.5", nil),
			want:  nil,
		},
		{
			name: "a condition that is constantly false is NOT reported as a dead branch",
			// Liveness is origin-dependent and this layer has no origin. The
			// check that would fire here is the one this file refuses to write.
			graph: gcCond("0", nil),
			want:  nil,
		},
		{
			name:  "a chunk-gated condition is not reported either",
			graph: gcCond("math.mod(variable.worldx, 32) == 0", nil),
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gcCheck(t, tt.graph, tt.want, tt.wantContains...)
		})
	}
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

func TestGraphCheckCycleIsAWarningCarryingThePath(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			gcNode("test:a", "minecraft:sequence_feature"),
			gcNode("test:b", "minecraft:sequence_feature"),
		},
		Edges: []GraphEdge{
			{From: "test:a", To: "test:b", Kind: EdgeSequence, JSONPath: "$.features[0]"},
			{From: "test:b", To: "test:a", Kind: EdgeSequence, JSONPath: "$.features[0]"},
		},
		Roots:  []string{"test:a"},
		Cycles: [][]string{{"test:a", "test:b"}},
	}

	diags := CheckGraph(g)
	gcCheck(t, g, []string{"warning:test:b:cycle"})

	d := diags[0]
	if d.Level != "warning" {
		t.Fatalf("a cycle is legal and must never be an error, got %q", d.Level)
	}
	if got, want := strings.Join(d.Chain, ","), "test:a,test:b"; got != want {
		t.Errorf("Chain should be the cycle path: got %q want %q", got, want)
	}
	if d.FileID != "test:a" {
		t.Errorf("FileID should be Chain[0], got %q", d.FileID)
	}
	if !strings.Contains(d.Message, "test:a -> test:b -> test:a") {
		t.Errorf("the message should close the loop so it reads as one: %q", d.Message)
	}
}

func TestGraphCheckWalksACyclicGraphWithoutHanging(t *testing.T) {
	// Not a liveness concern -- a breadth-first walk that did not mark on first
	// visit would simply not terminate here, and the graph contract says a
	// consumer must not assume a tree.
	g := &Graph{
		Nodes: []GraphNode{
			gcNode("test:a", "minecraft:sequence_feature"),
			gcNode("test:b", "minecraft:sequence_feature"),
			gcNode("test:c", "minecraft:sequence_feature"),
		},
		Edges: []GraphEdge{
			{From: "test:a", To: "test:b", Kind: EdgeSequence},
			{From: "test:b", To: "test:c", Kind: EdgeSequence},
			{From: "test:c", To: "test:a", Kind: EdgeSequence},
		},
		Roots: []string{"test:a"},
	}
	if diags := CheckGraph(g); len(diags) != 0 {
		t.Fatalf("expected no findings, got:\n%s", gcMessages(diags))
	}
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

func TestGraphCheckChainIsTheRootFirstPathToTheNodeThatRaisedIt(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			gcNode("test:rule", "minecraft:feature_rule"),
			gcNode("test:scatter", "minecraft:scatter_feature"),
			gcNode("test:list", "minecraft:conditional_list"),
			gcNode("test:block", "minecraft:single_block_feature"),
		},
		Edges: []GraphEdge{
			{From: "test:rule", To: "test:scatter", Kind: EdgeRule, JSONPath: "$.places_feature", Required: true},
			{From: "test:scatter", To: "test:list", Kind: EdgeScatter, JSONPath: "$.places_feature", Required: true, Iterations: gcStr("1")},
			{From: "test:list", To: "test:block", Kind: EdgeConditional, JSONPath: "$.conditional_features[0]", Condition: gcStr("variable.unset > 0")},
		},
		Roots: []string{"test:rule"},
	}

	diags := CheckGraph(g)
	if len(diags) != 1 {
		t.Fatalf("expected exactly the unset-read warning, got:\n%s", gcMessages(diags))
	}
	d := diags[0]
	if got, want := strings.Join(d.Chain, ","), "test:rule,test:scatter,test:list"; got != want {
		t.Fatalf("Chain: got %q, want %q", got, want)
	}
	if d.FileID != d.Chain[0] {
		t.Errorf("FileID must be the root the path starts at: %q vs %q", d.FileID, d.Chain[0])
	}
	if d.Identifier != d.Chain[len(d.Chain)-1] {
		t.Errorf("Identifier must be the deepest chain entry: %q vs %q", d.Identifier, d.Chain[len(d.Chain)-1])
	}
	if d.TypeID != "minecraft:conditional_list" {
		t.Errorf("TypeID must name the type that raised it, got %q", d.TypeID)
	}
	if !strings.Contains(d.Message, "$.conditional_features[0]") {
		t.Errorf("an edge finding should name the JSON path it is written at: %q", d.Message)
	}
}

func TestGraphCheckNodeUnreachedByAnyRootStillNamesItself(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{gcNode("test:orphan", "minecraft:scatter_feature")},
		// Deliberately no Roots: a half-built editor graph has this shape.
	}
	diags := CheckGraph(g)
	if len(diags) != 1 {
		t.Fatalf("expected the missing-delegation error, got:\n%s", gcMessages(diags))
	}
	if got := strings.Join(diags[0].Chain, ","); got != "test:orphan" {
		t.Errorf("Chain: got %q, want the node itself", got)
	}
	if diags[0].FileID != "test:orphan" {
		t.Errorf("FileID: got %q, want the node itself", diags[0].FileID)
	}
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

func TestGraphCheckSuppression(t *testing.T) {
	withAnnotations := func(ann ...Annotation) *Graph {
		g := gcCond("variable.unset > 0 && query.is_baby", nil)
		g.Nodes[0].Annotations = ann
		return g
	}

	tests := []struct {
		name  string
		graph *Graph
		want  []string
	}{
		{
			name:  "with nothing suppressed both findings stand",
			graph: withAnnotations(),
			want:  []string{"error:test:list:molang-query", "warning:test:list:molang-unset-read"},
		},
		{
			name:  "an ignore names one check and silences only that one",
			graph: withAnnotations(gcIgnore("molang-unset-read")),
			want:  []string{"error:test:list:molang-query"},
		},
		{
			name:  "an ignore may name several checks at once",
			graph: withAnnotations(gcIgnore("molang-unset-read", "molang-query")),
			want:  nil,
		},
		{
			name:  "a bare ignore silences the whole node",
			graph: withAnnotations(gcIgnore()),
			want:  nil,
		},
		{
			name:  "a check name is matched without regard to case",
			graph: withAnnotations(gcIgnore("Molang-Unset-Read")),
			want:  []string{"error:test:list:molang-query"},
		},
		{
			name:  "an unrelated directive suppresses nothing",
			graph: withAnnotations(Annotation{Name: "layout", Args: []string{"340", "120"}}),
			want:  []string{"error:test:list:molang-query", "warning:test:list:molang-unset-read"},
		},
		{
			name:  "an ignore for a different check suppresses nothing",
			graph: withAnnotations(gcIgnore("cycle")),
			want:  []string{"error:test:list:molang-query", "warning:test:list:molang-unset-read"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gcCheck(t, tt.graph, tt.want)
		})
	}
}

func TestGraphCheckEdgeSuppressionIsChargedToTheSourceNode(t *testing.T) {
	// The annotation lives in the file the edge is written in, which is the
	// SOURCE's file -- an ignore on the target must not silence it.
	g := gcCond("variable.unset > 0", nil)
	g.Nodes[1].Annotations = []Annotation{gcIgnore("molang-unset-read")}
	gcCheck(t, g, []string{"warning:test:list:molang-unset-read"})

	g = gcCond("variable.unset > 0", nil)
	g.Nodes[0].Annotations = []Annotation{gcIgnore("molang-unset-read")}
	gcCheck(t, g, nil)
}

func TestGraphCheckAnyNodeAroundACycleCanSuppressIt(t *testing.T) {
	base := func() *Graph {
		return &Graph{
			Nodes: []GraphNode{
				gcNode("test:a", "minecraft:sequence_feature"),
				gcNode("test:b", "minecraft:sequence_feature"),
			},
			Edges: []GraphEdge{
				{From: "test:a", To: "test:b", Kind: EdgeSequence},
				{From: "test:b", To: "test:a", Kind: EdgeSequence},
			},
			Roots:  []string{"test:a"},
			Cycles: [][]string{{"test:a", "test:b"}},
		}
	}
	for _, idx := range []int{0, 1} {
		g := base()
		g.Nodes[idx].Annotations = []Annotation{gcIgnore("cycle")}
		gcCheck(t, g, nil)
	}
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

func TestGraphCheckNilGraphIsNotAFinding(t *testing.T) {
	if diags := CheckGraph(nil); diags != nil {
		t.Fatalf("a nil graph has nothing wrong with it, got:\n%s", gcMessages(diags))
	}
	if diags := CheckGraph(&Graph{}); len(diags) != 0 {
		t.Fatalf("an empty graph has nothing wrong with it, got:\n%s", gcMessages(diags))
	}
}

func TestGraphCheckNamesListsEveryCheckThatCanBeEmitted(t *testing.T) {
	// Every emitted check must be offerable in an editor's suppression menu; a
	// check with no name in the list is one an author cannot silence.
	known := make(map[string]bool, len(GraphCheckNames))
	for _, n := range GraphCheckNames {
		known[n] = true
	}
	graphs := []*Graph{
		gcCond("query.is_baby && variable.unset > 0 && (variable.x = 1)", nil),
		gcCond("(", nil),
		{
			Nodes: []GraphNode{
				gcNode("test:scatter", "minecraft:scatter_feature"),
				gcNode("test:pick", "minecraft:weighted_random_feature"),
				{ID: "test:gone", Unresolved: true},
			},
			Edges: []GraphEdge{
				{From: "test:pick", To: "test:gone", Kind: EdgeWeighted, JSONPath: "$.features[0]"},
				{From: "test:pick", To: "", Kind: EdgeAggregate, JSONPath: "$.features[1]", Required: true},
			},
			Roots:  []string{"test:scatter", "test:pick"},
			Cycles: [][]string{{"test:pick"}},
		},
	}
	seen := map[string]bool{}
	for _, g := range graphs {
		for _, f := range gcFindings(t, CheckGraph(g)) {
			check := f[strings.LastIndex(f, ":")+1:]
			if !known[check] {
				t.Errorf("check %q is emitted but not listed in GraphCheckNames", check)
			}
			seen[check] = true
		}
	}
	for _, n := range GraphCheckNames {
		if !seen[n] {
			t.Logf("check %q is not exercised by this test's graphs", n)
		}
	}
}

// TestDelegationCycleDiagnostics_IsWhatCheckGetsAndWhatItSays is the exported
// form: the one CheckGraph finding besides unresolved-target that has a
// production caller. Same finding, same suppression, and the FILE rather than
// the node id, because a host prints a row a person clicks.
func TestDelegationCycleDiagnostics_IsWhatCheckGetsAndWhatItSays(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			gcNode("test:a", "minecraft:scatter_feature"),
			gcNode("test:b", "minecraft:scatter_feature"),
		},
		Edges: []GraphEdge{
			{From: "test:a", To: "test:b", Kind: EdgeScatter, JSONPath: "$.places_feature"},
			{From: "test:b", To: "test:a", Kind: EdgeScatter, JSONPath: "$.places_feature"},
		},
		Roots:  []string{"test:a"},
		Cycles: [][]string{{"test:a", "test:b"}},
	}
	diags := DelegationCycleDiagnostics(g)
	if len(diags) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly one", diags)
	}
	d := diags[0]
	if d.Level != "warning" {
		t.Errorf("level = %q, want warning -- the pack loads and generates, so this must never fail a build", d.Level)
	}
	if d.Scope != session.ScopePack {
		t.Errorf("scope = %q, want pack -- a cycle is a fact about the files, true of every run", d.Scope)
	}
	if d.FileID != "features/test:a.json" {
		t.Errorf("FileID = %q, want the rooting node's file -- a host prints a path someone opens", d.FileID)
	}
	if !strings.Contains(d.Message, "test:a -> test:b -> test:a") {
		t.Errorf("the message should close the loop so it reads as one: %q", d.Message)
	}
	if !strings.Contains(d.Message, "@featurelab:ignore cycle") {
		t.Errorf("the message must carry the directive that silences it: %q", d.Message)
	}
}

// TestDelegationCycleDiagnostics_SelfDelegationIsTheSameFinding: the editor
// refuses A -> A on the canvas, but a file on disk can still say it, and it is
// the one-node spelling of exactly the same defect.
func TestDelegationCycleDiagnostics_SelfDelegationIsTheSameFinding(t *testing.T) {
	g := &Graph{
		Nodes:  []GraphNode{gcNode("test:a", "minecraft:scatter_feature")},
		Edges:  []GraphEdge{{From: "test:a", To: "test:a", Kind: EdgeScatter, JSONPath: "$.places_feature"}},
		Roots:  []string{"test:a"},
		Cycles: [][]string{{"test:a"}},
	}
	if diags := DelegationCycleDiagnostics(g); len(diags) != 1 {
		t.Fatalf("diagnostics = %+v, want one", diags)
	}
}

// TestDelegationCycleDiagnostics_HonoursTheAnnotationOnAnyNodeAroundTheLoop:
// the author who wrote it was looking at one node, and asking for the same
// sentence on every node in the loop is asking for four copies of it.
func TestDelegationCycleDiagnostics_HonoursTheAnnotationOnAnyNodeAroundTheLoop(t *testing.T) {
	b := gcNode("test:b", "minecraft:scatter_feature")
	b.Annotations = []Annotation{{Name: "ignore", Args: []string{"cycle"}}}
	g := &Graph{
		Nodes: []GraphNode{gcNode("test:a", "minecraft:scatter_feature"), b},
		Edges: []GraphEdge{
			{From: "test:a", To: "test:b", Kind: EdgeScatter},
			{From: "test:b", To: "test:a", Kind: EdgeScatter},
		},
		Roots:  []string{"test:a"},
		Cycles: [][]string{{"test:a", "test:b"}},
	}
	if diags := DelegationCycleDiagnostics(g); len(diags) != 0 {
		t.Errorf("diagnostics = %+v, want none -- the annotation is about the pack, not about one tool", diags)
	}
}

func TestDelegationCycleDiagnostics_NilAndAcyclicGraphsSayNothing(t *testing.T) {
	if diags := DelegationCycleDiagnostics(nil); diags != nil {
		t.Errorf("a nil graph produced %+v", diags)
	}
	g := &Graph{Nodes: []GraphNode{gcNode("test:a", "minecraft:scatter_feature")}}
	if diags := DelegationCycleDiagnostics(g); diags != nil {
		t.Errorf("an acyclic graph produced %+v", diags)
	}
}
