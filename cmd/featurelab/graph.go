// graph.go implements both ways an editor asks for the feature graph: the
// one-shot `graph` subcommand and serve's long-lived "graph" method. They
// live in one file, and share one builder call and one normalizer, because
// the only thing that legitimately differs between them is where the loaded
// pack came from -- an editor that dumps a graph on the command line and
// then watches the same pack over `serve` must be looking at the same graph,
// not two that drifted apart.
//
// The shape is wire.Graph, the frozen editor contract (see wire/graph.go);
// nothing here adds to it or reinterprets it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/wire"
)

// buildGraph is the seam between this command and the graph builder itself,
// which lives outside this package. A var rather than a direct call so this
// package's tests can pin what this file is actually responsible for --
// flags, exit codes, the response envelope, and the output ordering below --
// against a graph they construct, instead of against whatever a fixture pack
// happens to produce today.
var buildGraph = buildGraphFromPack

// buildGraphFromPack is the single join point for the graph builder. It
// takes the whole loaded pack because a graph is built from the source
// files -- each node's own JSON body, its file path, its format version,
// and the comments the annotations are parsed out of -- none of which
// survives into the built libraries.
func buildGraphFromPack(ctx context.Context, loaded *pack.Pack) (*wire.Graph, error) {
	return wire.BuildGraphContext(ctx, loaded)
}

// normalizeGraph puts every list in a graph into a fixed order, in place.
//
// This is not tidiness. An editor, and anything else that stores a dumped
// graph, diffs one dump against the next; any list whose order comes from a
// map walk or from whichever file the builder happened to reach first would
// make every unchanged node and edge look edited on every dump. Two dumps of
// the same pack have to be byte-identical, so the ordering is imposed here,
// at the one point both entry points pass through. wire.Graph's contract
// makes the ordering a promise to consumers and leaves producers free to
// build in any order; this is where that promise is kept.
//
// Node.Fields needs nothing: encoding/json already writes map keys sorted.
// Annotations are left as the builder emitted them, which is file order --
// the order they must be shown in, and the one order a text scan cannot
// produce nondeterministically.
//
// Cycles' inner lists are likewise untouched: the order of ids AROUND a
// cycle is the cycle, and rotating them to a canonical start would be
// rewriting the data rather than ordering it. Only the outer list is sorted.
func normalizeGraph(g *wire.Graph) {
	if g == nil {
		return
	}
	sort.SliceStable(g.Nodes, func(i, j int) bool { return g.Nodes[i].ID < g.Nodes[j].ID })
	sort.SliceStable(g.Edges, func(i, j int) bool { return lessEdge(g.Edges[i], g.Edges[j]) })
	sort.Strings(g.Roots)
	sort.SliceStable(g.Cycles, func(i, j int) bool { return lessStrings(g.Cycles[i], g.Cycles[j]) })

	// nil and [] are different bytes on the wire (`null` vs `[]`), and a
	// client that walks `nodes` has to special-case one of them. These four
	// are the non-omitempty fields of the contract, so they are always
	// present and always an array. Cycles is omitempty and stays absent.
	//
	// Diagnostics is in that group rather than omitempty on purpose, and the
	// reason is not symmetry: a clean pack and an engine too old to report
	// diagnostics at all would otherwise be the same bytes, and a client
	// could not tell "nothing is wrong" from "nobody looked". `[]` says the
	// first; absent says the second.
	//
	// Diagnostics is NOT sorted here -- see wire.Graph.Diagnostics for why
	// its own emission order is both deterministic and the order to read it
	// in.
	if g.Nodes == nil {
		g.Nodes = []wire.GraphNode{}
	}
	if g.Edges == nil {
		g.Edges = []wire.GraphEdge{}
	}
	if g.Roots == nil {
		g.Roots = []string{}
	}
	if g.Diagnostics == nil {
		g.Diagnostics = []wire.GraphDiagnostic{}
	}
}

// graphDiagnostics is what a graph carries about the files that are NOT in
// it -- see wire.Graph.Diagnostics.
//
// It is handed the graph this request already built, and passes it down, so
// the dangling-delegation check `check` grew (see danglingDelegationDiagnostics)
// reads THIS graph instead of building a second one.
//
// It calls checkPack, the same function the `check` subcommand runs, rather
// than collecting diagnostics of its own. That is the whole point: an author
// who runs `check` and an author who opens the graph editor have to be told
// the same thing about the same file, in the same words, and two collectors
// that agree today are two collectors that can drift tomorrow. The cost is
// that a graph request rebuilds the pack's libraries; the graph builder
// already re-reads and re-parses every source file, so this is the same
// order of work, not a new one.
//
// It then drops PACK-LEVEL warnings -- pack.Load's "this pack has no
// structures/ directory", which every pack without structures or biomes
// raises on every load. They are true and `check` keeps reporting them; they
// are simply not editor diagnostics. They name no file, so there is nothing
// to show them beside, and a channel that is non-empty for every pack ever
// opened is one people stop reading -- which would cost the message this
// field exists to carry (a file the engine REFUSED) to save one that says a
// pack is fine as it is.
//
// Level, not kind, is what is filtered: anything at "error" level survives
// wherever it came from, because an error is by definition something that
// stopped a file from loading, and a graph that quietly dropped one would be
// the bug this is fixing wearing a different hat.
//
// The ids pass through UNTOUCHED, and that is only safe because checkPack
// already spells them the way this field promises: pack-relative, through the
// same wire.PackRelativePath a node's File goes through, resolved per asset
// kind (see packRelativeIDs). Rewriting them here instead would put the join
// back where it was -- one spelling produced at the boundary, another inside
// it, each with its own tests.
func graphDiagnostics(ctx context.Context, loaded *pack.Pack, g *wire.Graph) ([]wire.GraphDiagnostic, bool) {
	diags, ok := checkPackGraphContext(ctx, loaded, g)
	if !ok {
		return nil, false
	}
	out := []wire.GraphDiagnostic{}
	for _, d := range diags {
		if d.FileID == packDiagnosticFileID && d.Level != "error" {
			continue
		}
		out = append(out, wire.GraphDiagnostic{Level: d.Level, FileID: d.FileID, Line: d.Line, Column: d.Column, Message: d.Message})
	}
	return out, true
}

// lessEdge orders edges by their source first, so a file's delegations stay
// together and a diff localises to the node that changed. Within a source,
// Ordinal comes before To because for a sequence_feature that is execution
// order -- the one order a reader of the dump is entitled to read meaning
// into. JSONPath is last and is what makes the order total: it is the edge's
// unique position inside its own file, so no two edges of one node tie.
func lessEdge(a, b wire.GraphEdge) bool {
	if a.From != b.From {
		return a.From < b.From
	}
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	if a.Ordinal != b.Ordinal {
		return a.Ordinal < b.Ordinal
	}
	if a.To != b.To {
		return a.To < b.To
	}
	return a.JSONPath < b.JSONPath
}

func lessStrings(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// cmdGraph implements the `graph` subcommand: load a pack, print its feature
// graph as JSON to stdout.
//
// It exits 0 on a pack whose graph has unresolved nodes, which is the one
// place its exit code deliberately parts company with `check`'s. A dangling
// reference is a first-class part of this contract -- wire.GraphNode.
// Unresolved exists so a broken reference is a visible node instead of a
// missing one -- and an editor opens a half-written pack constantly. Failing
// the command would make the graph unreadable at exactly the moment someone
// needs to see what is broken. `check` remains the command that has an
// opinion about whether a pack is well-formed.
func cmdGraph(args []string) int {
	fs := flag.NewFlagSet("graph", flag.ContinueOnError)
	var pf packFlags
	omitCoverageNotes := fs.Bool("omit-coverage-notes", false,
		"leave each node's coverageNote out of the dump (it is a per-type constant; `types` has the table)")
	pf.register(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}

	loaded, err := pack.Load(pf.options())
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	// Pack-level notices go to stderr, as `generate` does it: stdout is a
	// JSON document a caller pipes somewhere, and these are exactly the
	// diagnostics graphDiagnostics keeps OUT of the graph's own Diagnostics
	// list (see there for why). Stderr is still the right place for them --
	// dropped entirely, a mistyped --features path would look like a pack
	// with no features. Levelled by `check`'s own rule rather than all called
	// warnings; see printPackNotices.
	printPackNotices(os.Stderr, loaded)

	g, err := buildGraph(context.Background(), loaded)
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	// The ok flag is discarded, and this is the one call site where that is safe: a background
	// context cannot be cancelled, so it is always true. Only serve's "graph" method has anything
	// that could make it false, and it acts on it (see methodGraph).
	g.Diagnostics, _ = graphDiagnostics(context.Background(), loaded, g)
	if *omitCoverageNotes {
		wire.OmitCoverageNotes(g)
	}
	normalizeGraph(g)
	if err := writeJSON(os.Stdout, g); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: encoding JSON: "+err.Error())
		return 1
	}
	return 0
}

// graphParams is "graph"'s request shape. It had none until this field, and an absent params
// object stays exactly as valid as it always was.
type graphParams struct {
	// OmitCoverageNotes drops GraphNode.CoverageNote from every node -- see wire.
	// OmitCoverageNotes for what it is and the measurement behind it. Off by default; a client
	// that sets it reads the same notes once from the "types" method.
	OmitCoverageNotes bool `json:"omitCoverageNotes,omitempty"`
}

// methodGraph implements serve's "graph" method -- the same graph as the
// subcommand, over the pack this session already has open, so an editor asks
// for it without re-reading the pack from disk.
//
// Its params SELECT NOTHING about the graph itself: it is everything reachable
// in the loaded pack, and there is nothing to choose. The one field is about
// how much of each node comes back. Like every other pack-dependent method it
// answers errNoPackLoaded before the first "loadPack", with that exact
// shared sentence rather than a fourth wording of it.
//
// It reads state.loaded (the source files) rather than state.workspace (the
// built libraries) because that is what a graph is built from. The two are
// set together and never independently -- see serverState -- so checking
// both is checking the one invariant, the same way methodReloadFile does.
// reporter may be nil -- see progressReporter. The two phases it names are the
// two halves this method visibly spends its time in, and naming them is the
// whole progress signal a graph gets: unlike a pack load there is no file
// being read to count, because the source files are already in memory and the
// work is parsing them. A host showing "graph" for 40s and then "diagnostics"
// knows the engine is alive and roughly where it is, which is what the
// requirement is for.
func methodGraph(ctx context.Context, state *serverState, raw json.RawMessage, reporter *progressReporter) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p graphParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	reporter.SetPhase("graph")
	g, err := buildGraph(ctx, state.loaded)
	if err != nil {
		return nil, err
	}
	reporter.SetPhase("diagnostics")
	// Attached here as well as in cmdGraph, from the same pack and the same
	// collector, because the editor talks to this method and never runs the
	// subcommand -- a graph that carried its diagnostics on the command line
	// only would leave the one caller that needs them without them.
	diagnostics, ok := graphDiagnostics(ctx, state.loaded, g)
	if !ok {
		// Cancelled part-way through the library builds. The graph itself is complete but its
		// diagnostics are a prefix of the real set, and a graph that under-reports refused files
		// is worse than no graph: it is the blank-node bug wire.Graph.Diagnostics exists to
		// close, wearing a successful response. Answer with the cancellation instead.
		return nil, ctx.Err()
	}
	g.Diagnostics = diagnostics
	if p.OmitCoverageNotes {
		wire.OmitCoverageNotes(g)
	}
	normalizeGraph(g)
	return g, nil
}
