package wire

// graphcheck_unresolved_test.go covers UnresolvedTargets -- the piece of CheckGraph that was
// pulled out because CheckGraph itself had no production caller, so the one finding in it that a
// CI job needs ("this delegation names something nothing defines") was unreachable in the
// shipped tool.
//
// The tests that matter most here are the two about NOT drifting: the sentence it reports is
// CheckGraph's own, and the suppression it honours is CheckGraph's own. An author who read the
// finding in the editor and an author who read it in `check` have to be reading the same thing.

import (
	"context"
	"strings"
	"testing"

	"github.com/stirante/featurelab/session"
)

func unresolvedGraph() *Graph {
	return &Graph{
		Nodes: []GraphNode{
			{ID: "wiki:parent", TypeID: "minecraft:scatter_feature", File: "features/parent.json"},
			{ID: "wiki:rng_marker", TypeID: "minecraft:single_block_feature", File: "features/marker.json"},
			{ID: "wiki:rng_markr", Unresolved: true},
		},
		Edges: []GraphEdge{
			{From: "wiki:parent", To: "wiki:rng_markr", Kind: EdgeScatter, JSONPath: "$.minecraft:scatter_feature.places_feature", Required: true},
		},
		Roots: []string{"wiki:parent"},
	}
}

func TestUnresolvedTargets_NamesTheEdgeAndTheFileThatWroteIt(t *testing.T) {
	got := UnresolvedTargets(unresolvedGraph())
	if len(got) != 1 {
		t.Fatalf("UnresolvedTargets = %+v, want exactly one", got)
	}
	if got[0].From != "wiki:parent" || got[0].To != "wiki:rng_markr" {
		t.Errorf("from/to = %q/%q, want wiki:parent/wiki:rng_markr", got[0].From, got[0].To)
	}
	// The File is the DELEGATING node's -- the one that can be opened and edited. The target has
	// no file; that is what is wrong with it.
	if got[0].File != "features/parent.json" {
		t.Errorf("file = %q, want the delegating node's file", got[0].File)
	}
	if got[0].JSONPath != "$.minecraft:scatter_feature.places_feature" {
		t.Errorf("jsonPath = %q, want the edge's own path", got[0].JSONPath)
	}
	if !strings.Contains(got[0].Message, `did you mean "wiki:rng_marker"?`) {
		t.Errorf("message = %q, want the near match", got[0].Message)
	}
}

// TestUnresolvedTargets_ReportTheSameSentenceCheckGraphDoes is the anti-drift assertion. Two
// wordings of one problem is how a reader ends up believing they have two problems, and this is
// now reported by two different commands.
func TestUnresolvedTargets_ReportTheSameSentenceCheckGraphDoes(t *testing.T) {
	g := unresolvedGraph()
	targets := UnresolvedTargets(g)
	if len(targets) != 1 {
		t.Fatalf("UnresolvedTargets = %+v, want exactly one", targets)
	}
	fromCheckGraph := findCheckMessage(t, g, "no loaded file defines")
	if !strings.Contains(fromCheckGraph, targets[0].Message) {
		t.Errorf("CheckGraph says %q, UnresolvedTargets says %q -- the shared part must be identical",
			fromCheckGraph, targets[0].Message)
	}
}

// A game-provided target keeps its exemption here exactly as it has it in CheckGraph: the pack is
// right, the reference resolves in game, and only the preview cannot show it.
func TestUnresolvedTargets_GameProvidedTargetIsNotOne(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			{ID: "wiki:parent", TypeID: "minecraft:scatter_feature", File: "features/parent.json"},
			{ID: "minecraft:bush_feature", Unresolved: true, External: true},
		},
		Edges: []GraphEdge{
			{From: "wiki:parent", To: "minecraft:bush_feature", Kind: EdgeScatter, JSONPath: "$.a"},
		},
	}
	if got := UnresolvedTargets(g); len(got) != 0 {
		t.Errorf("UnresolvedTargets = %+v, want none for a feature the game provides", got)
	}
}

// An author who wrote the ignore directive has said something about the PACK, not about one tool
// that reads it, so the finding is suppressed wherever it would have been reported.
func TestUnresolvedTargets_HonourTheSameIgnoreDirective(t *testing.T) {
	g := unresolvedGraph()
	g.Nodes[0].Annotations = []Annotation{{Name: "ignore", Args: []string{CheckUnresolvedTarget}}}
	if got := UnresolvedTargets(g); len(got) != 0 {
		t.Errorf("UnresolvedTargets = %+v, want none -- @featurelab:ignore unresolved-target was written", got)
	}
}

func TestUnresolvedTargets_NilAndCleanGraphsHaveNothingWrongWithThem(t *testing.T) {
	if got := UnresolvedTargets(nil); got != nil {
		t.Errorf("UnresolvedTargets(nil) = %+v, want nil", got)
	}
	clean := &Graph{
		Nodes: []GraphNode{
			{ID: "wiki:parent", TypeID: "minecraft:scatter_feature", File: "features/parent.json"},
			{ID: "wiki:marker", TypeID: "minecraft:single_block_feature", File: "features/marker.json"},
		},
		Edges: []GraphEdge{{From: "wiki:parent", To: "wiki:marker", Kind: EdgeScatter, JSONPath: "$.a"}},
	}
	if got := UnresolvedTargets(clean); len(got) != 0 {
		t.Errorf("UnresolvedTargets = %+v, want none", got)
	}
}

// TestBuildGraph_UnresolvedNodeCarriesSuggestions is the same near match arriving on the NODE,
// which is where a canvas can act on it rather than only print it: a quick-fix, or a one-click
// rename of the reference. Candidates rather than a sentence, for exactly that reason.
func TestBuildGraph_UnresolvedNodeCarriesSuggestions(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("features/parent.json", "minecraft:scatter_feature", "wiki:parent",
			`"places_feature":"wiki:rng_markr","iterations":1,"x":0,"y":0,"z":0`),
		graphFeature("features/marker.json", "minecraft:single_block_feature", "wiki:rng_marker",
			`"places_block":"minecraft:gold_block"`),
	}, nil)

	var found bool
	for _, n := range g.Nodes {
		if !n.Unresolved {
			if len(n.Suggestions) != 0 {
				t.Errorf("node %q resolves and still carries suggestions %v", n.ID, n.Suggestions)
			}
			continue
		}
		found = true
		if len(n.Suggestions) != 1 || n.Suggestions[0] != "wiki:rng_marker" {
			t.Errorf("suggestions = %v, want [wiki:rng_marker]", n.Suggestions)
		}
	}
	if !found {
		t.Fatal("no unresolved node in the graph -- the fixture stopped being broken")
	}
}

// A game-provided node is not a mistake and is offered no correction -- the same exemption
// UnresolvedTargets makes, made once more where the node itself is built.
func TestBuildGraph_GameProvidedNodeIsOfferedNoSuggestion(t *testing.T) {
	g := graphOf(t, []graphTestFile{
		graphFeature("features/parent.json", "minecraft:scatter_feature", "wiki:parent",
			`"places_feature":"minecraft:bush_feature","iterations":1,"x":0,"y":0,"z":0`),
		graphFeature("features/bush.json", "minecraft:single_block_feature", "wiki:bush_feature",
			`"places_block":"minecraft:gold_block"`),
	}, nil)

	for _, n := range g.Nodes {
		if n.Unresolved && len(n.Suggestions) != 0 {
			t.Errorf("node %q is the game's own and was offered %v", n.ID, n.Suggestions)
		}
	}
}

// UnresolvedTargetDiagnostics is the form every HOST consumes -- the sentence above, as the
// diagnostic row a pack load or a placement already answers with. It lives here rather than in
// whichever host noticed the hole first, which is the whole subject of these last few tests:
// written in cmd/featurelab, it reached `check`, `graph` and the VS Code extension, and left
// apps/desktop -- which links this engine in-process -- with nothing to say about a pack that
// places nothing.

func TestUnresolvedTargetDiagnostics_AreErrorsAboutTheDelegatingFile(t *testing.T) {
	got, ok := UnresolvedTargetDiagnostics(context.Background(), nil, unresolvedGraph())
	if !ok {
		t.Fatal("ok = false with no cancellation")
	}
	if len(got) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly one", got)
	}
	d := got[0]
	if d.Level != "error" {
		t.Errorf("level = %q, want error -- the branch cannot place anything at any origin or seed", d.Level)
	}
	if d.Scope != session.ScopePack {
		t.Errorf("scope = %q, want pack -- it is a fact about the files on disk", d.Scope)
	}
	// The DELEGATING node's file, not the target's: the target has no file, and that is what is
	// wrong with it.
	if d.FileID != "features/parent.json" {
		t.Errorf("fileId = %q, want the delegating file", d.FileID)
	}
	for _, want := range []string{"wiki:parent", "places_feature", `"wiki:rng_markr"`} {
		if !strings.Contains(d.Message, want) {
			t.Errorf("message %q does not name %s", d.Message, want)
		}
	}
}

// The anti-drift assertion, one level up from the one above it: the row a host renders carries
// UnresolvedTargets' own sentence unchanged, so the editor, the terminal and the desktop banner
// are quoting one thing.
func TestUnresolvedTargetDiagnostics_CarryTheSharedSentence(t *testing.T) {
	g := unresolvedGraph()
	targets := UnresolvedTargets(g)
	got, _ := UnresolvedTargetDiagnostics(context.Background(), nil, g)
	if len(targets) != 1 || len(got) != 1 {
		t.Fatalf("targets = %+v, diagnostics = %+v, want one of each", targets, got)
	}
	if !strings.Contains(got[0].Message, targets[0].Message) {
		t.Errorf("diagnostic %q does not carry the shared sentence %q", got[0].Message, targets[0].Message)
	}
}

// Suppression is the pack author's statement about the pack, so it holds on this path too --
// otherwise a directive that silenced the editor would leave a banner up in the desktop app.
func TestUnresolvedTargetDiagnostics_HonourTheIgnoreDirective(t *testing.T) {
	g := unresolvedGraph()
	g.Nodes[0].Annotations = []Annotation{{Name: "ignore", Args: []string{CheckUnresolvedTarget}}}
	got, ok := UnresolvedTargetDiagnostics(context.Background(), nil, g)
	if !ok || len(got) != 0 {
		t.Errorf("diagnostics = %+v (ok=%v), want none", got, ok)
	}
}

// With no graph in hand it builds one from the pack, which is what every host that has only
// just loaded a pack actually has.
func TestUnresolvedTargetDiagnostics_BuildTheGraphWhenGivenNone(t *testing.T) {
	loaded := graphPack([]graphTestFile{
		graphFeature("gold.json", "minecraft:single_block_feature", "wiki:gold_block", `"places_block":"minecraft:gold_block"`),
		graphFeature("scatter.json", "minecraft:scatter_feature", "wiki:scatter",
			`"places_feature":"wiki:gold_blok","distribution":{"iterations":1,"x":0,"y":0,"z":0}`),
	}, nil)

	got, ok := UnresolvedTargetDiagnostics(context.Background(), loaded, nil)
	if !ok {
		t.Fatal("ok = false with no cancellation")
	}
	if len(got) != 1 {
		t.Fatalf("diagnostics = %+v, want exactly one", got)
	}
	if !strings.Contains(got[0].Message, `did you mean "wiki:gold_block"?`) {
		t.Errorf("message = %q, want the near match", got[0].Message)
	}
}

// ok=false means CANCELLED, and only that: the rows returned are a prefix of the real set and
// must not be shown to anybody.
func TestUnresolvedTargetDiagnostics_CancelledContextReportsNotDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, ok := UnresolvedTargetDiagnostics(ctx, graphPack(nil, nil), nil); ok {
		t.Errorf("ok = true for a cancelled context (diagnostics %+v)", got)
	}
}

// A graph that cannot be BUILT is a different thing: it says nothing about delegations either
// way, and the per-file diagnostics this is appended to are complete without it. Adding a
// finding is this function's job; failing for a reason unrelated to the pack's contents is not.
func TestUnresolvedTargetDiagnostics_NoPackIsSilentRatherThanFailing(t *testing.T) {
	got, ok := UnresolvedTargetDiagnostics(context.Background(), nil, nil)
	if !ok {
		t.Error("ok = false without a cancellation -- an unbuildable graph is not a cancelled one")
	}
	if len(got) != 0 {
		t.Errorf("diagnostics = %+v, want none", got)
	}
}
