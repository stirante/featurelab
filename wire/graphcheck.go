// graphcheck.go is the validation a graph editor runs while someone is BUILDING
// a feature graph: it takes a Graph and answers with diagnostics, without
// placing anything, without a world, without an origin and without an RNG.
//
// It lives in this package because this is the only one that can see both
// sides: Graph is declared here, and session -- whose Diagnostic these findings
// are reported as -- is already imported here, while the reverse would be a
// cycle.
//
// Reusing session.Diagnostic rather than declaring a graph-flavoured one is not
// only about the editor already rendering that shape. Its Chain is exactly what
// a graph diagnostic wants to carry: a root-first delegation path. A path
// through the graph IS a delegation chain; the only difference from a placement
// diagnostic is that this one was derived by walking edges instead of by
// watching a run. So FileID/Identifier/TypeID/Chain keep the meanings
// session.Diagnostic documents -- Chain is root-first, Chain[0] is the root the
// path started at and matches FileID, and Identifier/TypeID name the node that
// actually raised the diagnostic, which is Chain's LAST entry.
//
// Every diagnostic names its check at the end of its message,
// "(@featurelab:ignore <check>)", because session.Diagnostic has no field for
// one and an author who wants a warning gone needs to be told the exact
// directive to write. See the suppression section below.
//
// # Position is always nil
//
// Nothing here corresponds to a write attempt: these are statements about the
// graph, not about a placement. session.Diagnostic.Position documents nil as "not
// applicable", and a zero BlockPos would claim the origin, which is a real
// coordinate.
//
// # The check this file deliberately does NOT contain
//
// There is no "this branch is dead" check, and adding one later would be a
// mistake in this layer. Whether a branch runs is origin-dependent: a condition
// gated on chunk parity or on query.noise of the placement position is false at
// the default preview origin of 0,0,0 and true two chunks over. A static walk
// cannot tell "never runs" from "did not run HERE", and reporting the second as
// the first is worse than saying nothing -- it is wrong, the author cannot act
// on it, and a warning nobody can act on is how a tool teaches people to ignore
// all of its warnings, including the true ones. If a liveness signal is ever
// wanted it belongs to a RUN, must be phrased as "did not run at this origin",
// and must be suppressible; the ignore mechanism below already accepts a name
// for it.
//
// The same restraint is why the unset-read check (the most useful thing here)
// errs toward silence -- see checkExpr.
package wire

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/stirante/featurelab/internal/nearest"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"

	molang "github.com/stirante/molang-go"
	"github.com/stirante/molang-go/ast"
)

// Check names. These are the API: they are what an author writes after
// `@featurelab:ignore` and what an editor offers in a "suppress this" menu, so
// they are exported and they are stable strings rather than an enum a UI would
// have to translate back into text.
const (
	// CheckRequiredEdge is a delegation the type cannot load without.
	CheckRequiredEdge = "required-edge"
	// CheckUnresolvedTarget is an edge pointing at a feature the pack does not
	// define AND the game does not provide.
	CheckUnresolvedTarget = "unresolved-target"
	// CheckGameProvidedTarget is an edge pointing at one of the game's own
	// features. Reported at info, because the pack is correct: it resolves at
	// run time and only the preview cannot show it.
	CheckGameProvidedTarget = "game-provided-target"
	// CheckEdgeArity is a count or a kind of delegation the type cannot accept.
	CheckEdgeArity = "edge-arity"
	// CheckEdgeWeight is a weighted_random entry whose weight is missing,
	// negative, or can never win.
	CheckEdgeWeight = "edge-weight"
	// CheckEdgeIterations is a scatter with no iterations expression.
	CheckEdgeIterations = "edge-iterations"
	// CheckMolangParse is a condition or iterations expression that is not
	// Molang.
	CheckMolangParse = "molang-parse"
	// CheckMolangQuery is a query nothing answers during world generation.
	CheckMolangQuery = "molang-query"
	// CheckMolangUnsetRead is a read of a slot nothing in the graph writes.
	CheckMolangUnsetRead = "molang-unset-read"
	// CheckMolangSideEffect is an assignment inside a CONDITION -- see
	// checkExpr for why iterations is exempt.
	CheckMolangSideEffect = "molang-side-effect"
	// CheckCycle is a delegation cycle. Always a warning; cycles are legal.
	CheckCycle = "cycle"
)

// GraphCheckNames is every check name CheckGraph can emit, for an editor
// building a suppression menu, and for a test that a new check was not added
// without a name.
var GraphCheckNames = []string{
	CheckRequiredEdge,
	CheckUnresolvedTarget,
	CheckGameProvidedTarget,
	CheckEdgeArity,
	CheckEdgeWeight,
	CheckEdgeIterations,
	CheckMolangParse,
	CheckMolangQuery,
	CheckMolangUnsetRead,
	CheckMolangSideEffect,
	CheckCycle,
}

// checkWorldGenQueries is every query that resolves during world generation. The
// list is short because the world_gen Molang surface IS short: noise, the three
// biome-tag queries, and the two column-height queries. Anything else names a
// query no world generation context publishes -- it does not evaluate to
// something useful and unexpected, it evaluates to nothing, which is the reason
// naming one is worth an error rather than a shrug.
var checkWorldGenQueries = map[string]bool{
	"noise":           true,
	"has_biome_tag":   true,
	"any_tag":         true,
	"all_tags":        true,
	"heightmap":       true,
	"above_top_solid": true,
}

// checkEnginePublishedVars are the Molang slots world generation fills in
// before a feature's own expressions run, so a read of one is never an unset
// read however little the graph itself writes. A scatter (and a feature rule,
// which runs the same scatter) writes variable.originx/y/z from its origin
// before evaluating iterations, and writes variable.worldx/y/z one axis at a
// time as each coordinate is resolved; a conditional_list writes all six from
// its own origin before evaluating any entry's condition.
var checkEnginePublishedVars = map[string]bool{
	"variable.originx": true,
	"variable.originy": true,
	"variable.originz": true,
	"variable.worldx":  true,
	"variable.worldy":  true,
	"variable.worldz":  true,
}

// checkSingleDelegation is every type that delegates to EXACTLY ONE feature, with
// the edge kind that delegation arrives as and the JSON key it is written
// under. All of these are required: none of these types has anything to do
// without its one child, and each refuses to load without the key.
//
// Keyed by type rather than derived from the edge, because the point is to
// catch the node that has NO edge at all -- a case with no edge to look at.
//
// EdgeChild is deliberately absent from this table and from the one below. A
// named child slot is single by construction, but whether it is REQUIRED is the
// individual type's business -- a vegetation patch without its vegetation is
// nothing, a tree without a log decoration is a tree -- so a "this type must
// have one" rule keyed on the kind would invent a requirement for every type
// whose slot is optional. Those edges are still checked by everything that does
// not need a type to be meaningful: a dangling target, and an edge the graph
// itself marks Required with nothing in it.
var checkSingleDelegation = map[string]struct {
	kind EdgeKind
	key  string
}{
	"minecraft:feature_rule":                       {EdgeRule, "places_feature"},
	"minecraft:scatter_feature":                    {EdgeScatter, "places_feature"},
	"minecraft:snap_to_surface_feature":            {EdgeFilter, "feature_to_snap"},
	"minecraft:surface_relative_threshold_feature": {EdgeFilter, "feature_to_place"},
	"minecraft:height_difference_filter_feature":   {EdgeFilter, "places_feature"},
	"minecraft:scan_surface":                       {EdgeFilter, "places_feature"},
	"minecraft:search_feature":                     {EdgeFilter, "places_feature"},
}

// checkListDelegation is every type that delegates to a LIST, with the edge kind its
// entries arrive as and the key the list is written under.
//
// mustBeNonEmpty is set only where an empty list is a confirmed load failure --
// weighted_random_feature's entry array carries a minimum size of 1 and the
// schema refuses a shorter one. The other three are left alone: an empty
// aggregate is a feature that places nothing, which is pointless but is not
// something known to be refused, and inventing an error for it would put this
// file in the business of guessing.
var checkListDelegation = map[string]struct {
	kind           EdgeKind
	key            string
	mustBeNonEmpty bool
}{
	"minecraft:aggregate_feature":       {EdgeAggregate, "features", false},
	"minecraft:sequence_feature":        {EdgeSequence, "features", false},
	"minecraft:weighted_random_feature": {EdgeWeighted, "features", true},
	"minecraft:conditional_list":        {EdgeConditional, "conditional_features", false},
}

// CheckGraph validates g and returns everything an editor should show, in a
// stable order: per-node structural findings in Nodes order, then per-edge
// findings in Edges order, then one per cycle. Never nil-hostile: a nil or
// empty graph has nothing wrong with it.
//
// Errors are things the pack will not load with or that cannot mean anything;
// warnings are things that load and are probably not what the author meant.
// Cycles are always warnings -- see checkCycles.
//
// # CheckGraph HAS NO PRODUCTION CALLER, AND THAT IS ON PURPOSE
//
// Everything below is tested and nothing but tests calls it. Exactly one of
// its findings ships: unresolved-target, lifted out into UnresolvedTargets /
// UnresolvedTargetDiagnostics, because a delegation naming something nothing
// defines is a pack that places nothing -- a defect nobody disputes, on a
// pack that was already broken, so reporting it took nothing away from
// anyone.
//
// The other ten are a MEASURED PRODUCT CHANGE, not a bug fix, and that is why
// they are still here rather than wired into `check`. Every one of them would
// appear on packs that pass today; the error-level ones would flip a green CI
// job to red on a pack whose author changed nothing. That call belongs to
// whoever owns the release, with numbers from real packs in front of them,
// and "the code was already written" is not the argument that should make it.
//
// What is here, who wants it, and what has to be decided first:
//
//   - required-edge, edge-arity, edge-weight, edge-iterations (error). A
//     delegation the type cannot load without, a count or kind of delegation
//     it cannot accept, a weighted entry that can never win, a scatter with
//     no iterations. Wanted by `check` and by a CI job: these are load
//     failures in game, which is the strongest case in the set. DECIDE: run
//     the four over a corpus of packs that pass `check` today and count the
//     findings. If the count is near zero, they are free; if it is not, the
//     tables they are keyed on (checkSingleDelegation, checkListDelegation)
//     are guessing about types nobody confirmed, and the fix is to narrow the
//     tables before shipping the checks.
//
//   - molang-parse (error), molang-query, molang-side-effect (warning). An
//     expression that is not Molang, a query nothing answers during world
//     generation, an assignment inside a condition. Wanted by a graph editor
//     first -- they point at a character in a string, which is what an editor
//     can show and a terminal row cannot. DECIDE: whether checkWorldGenQueries
//     is the whole world-gen Molang surface. It is short because the surface
//     is short, but anything missing from it becomes a wrong error on a
//     correct pack, which is the failure mode this package spent thirteen
//     wrong errors learning to avoid (see GraphNode.External).
//
//   - molang-unset-read (warning). A read of a variable./temp. slot nothing
//     in the graph writes. The most useful thing here and the most likely to
//     be wrong: the write set is graph-wide rather than per-ancestor (see
//     checkExpr), so it under-reports by design. DECIDE: nothing, if it stays
//     a warning; it must never become an error while the write set is
//     approximate.
//
//   - game-provided-target (info). An edge into one of the game's own
//     features: correct pack, and only the preview cannot draw it. Wanted by
//     an editor, to explain a node that renders as a stub. DECIDE: whether
//     `check` should carry info rows about correctness at all -- it now has
//     an info level, and this is the first finding that would use it for
//     something other than a missing directory.
//
//   - cycle (warning). A delegation cycle, which is legal -- the engine
//     guards recursion at run time -- so this can only ever be a warning, and
//     a pack that means it needs a way to say so. DECIDE: nothing beyond
//     accepting that @featurelab:ignore cycle is the answer for a pack that
//     is doing it deliberately.
//
// The mechanism for shipping any of them is already complete: every finding
// names its check, and @featurelab:ignore <check> suppresses it per node. So
// the work left is not code. It is picking the levels, running the corpus,
// and deciding what a release is willing to turn red.
//
// See also this file's header for the check deliberately NOT in here (dead
// branches), which is a different question: that one is wrong in principle,
// not merely unshipped.
func CheckGraph(g *Graph) []session.Diagnostic {
	if g == nil {
		return nil
	}
	c := newGraphChecker(g)
	c.checkNodes()
	c.checkEdges()
	c.checkCycles()
	return c.out
}

type graphChecker struct {
	g     *Graph
	nodes map[string]*GraphNode
	// out[id] is the index into g.Edges of every edge leaving id, in the order
	// g.Edges lists them.
	edgesFrom map[string][]int
	// path[id] is one representative root-first path to id -- see pathTo.
	path map[string][]string
	// written is every variable./temp. name any expression ANYWHERE in the
	// graph assigns -- see checkExpr for why the set is graph-wide and not
	// per-ancestor.
	written map[string]bool
	// exprs is every parsed condition/iterations, keyed by edge index, so the
	// write-collecting pass and the reporting pass share one parse.
	exprs map[int][]*graphExpr

	// defined memoises DefinedNodeIDs(c.g) -- see there for what is in it and
	// what is deliberately not. Built lazily, because the overwhelmingly common
	// graph has no dangling edge at all and never asks for it.
	defined []string

	out []session.Diagnostic
}

// graphExpr is one Molang expression carried on one edge, parsed once.
type graphExpr struct {
	// what is the JSON key the expression was written under, which is also how
	// a message refers to it: "condition" or "iterations".
	what string
	// source is the expression as the author wrote it, quoted back in messages
	// so the one being complained about is unambiguous.
	source string
	tree   *ast.Program
	err    error
	refs   molang.Refs
}

// newGraphExpr parses one expression and collects its references up front. A
// parse failure is kept rather than returned: it is a finding to report on the
// edge, not a reason to stop checking the rest of the graph.
func newGraphExpr(what, source string) *graphExpr {
	x := &graphExpr{what: what, source: source}
	x.tree, x.err = molang.Parse(source)
	if x.err == nil {
		x.refs = molang.References(x.tree)
	}
	return x
}

func newGraphChecker(g *Graph) *graphChecker {
	c := &graphChecker{
		g:         g,
		nodes:     make(map[string]*GraphNode, len(g.Nodes)),
		edgesFrom: make(map[string][]int, len(g.Nodes)),
		written:   map[string]bool{},
		exprs:     map[int][]*graphExpr{},
	}
	for i := range g.Nodes {
		c.nodes[g.Nodes[i].ID] = &g.Nodes[i]
	}
	for i := range g.Edges {
		c.edgesFrom[g.Edges[i].From] = append(c.edgesFrom[g.Edges[i].From], i)
	}
	c.buildPaths()
	c.parseExpressions()
	return c
}

// buildPaths walks breadth-first from Roots so every reachable node gets one
// representative root-first path -- the shortest, and for equal lengths the one
// through the earliest root and the earliest edge, which makes the Chain a
// given graph produces deterministic even though Edges is documented as
// unordered.
//
// Breadth-first rather than depth-first for the obvious reason and one less
// obvious one: the graph is not a tree and may contain cycles, so a walk that
// does not mark on first visit does not terminate.
func (c *graphChecker) buildPaths() {
	c.path = make(map[string][]string, len(c.g.Nodes))
	queue := make([]string, 0, len(c.g.Nodes))
	visit := func(id string, p []string) {
		if _, seen := c.path[id]; seen {
			return
		}
		c.path[id] = p
		queue = append(queue, id)
	}
	for _, r := range c.g.Roots {
		visit(r, []string{r})
	}
	for i := 0; i < len(queue); i++ {
		id := queue[i]
		for _, ei := range c.edgesFrom[id] {
			to := c.g.Edges[ei].To
			if to == "" {
				continue
			}
			p := make([]string, len(c.path[id]), len(c.path[id])+1)
			copy(p, c.path[id])
			visit(to, append(p, to))
		}
	}
}

// pathTo is the Chain for a diagnostic raised at id. A node no root reaches --
// which a well-formed graph does not contain, but a half-built one in an editor
// very much does -- is its own chain, so the diagnostic still names it rather
// than arriving with an empty Chain and an empty FileID.
func (c *graphChecker) pathTo(id string) []string {
	if p, ok := c.path[id]; ok && len(p) > 0 {
		return p
	}
	return []string{id}
}

// parseExpressions parses every condition and every iterations once, and
// records what they WRITE before anything reports on what they read. Both
// passes need the same trees and parsing twice would be the kind of quiet waste
// that only shows up on a large pack.
func (c *graphChecker) parseExpressions() {
	for i := range c.g.Edges {
		e := &c.g.Edges[i]
		var list []*graphExpr
		// A nil Condition is the author writing no condition, which the type
		// treats as the constant 1.0. That is not an empty expression and must
		// not be parsed as one.
		if e.Condition != nil {
			list = append(list, newGraphExpr("condition", *e.Condition))
		}
		if e.Iterations != nil {
			list = append(list, newGraphExpr("iterations", *e.Iterations))
		}
		if len(list) == 0 {
			continue
		}
		c.exprs[i] = list
		for _, x := range list {
			if x.err != nil {
				continue
			}
			for _, n := range x.refs.VariableWrites {
				c.written["variable."+n] = true
			}
			for _, n := range x.refs.TempWrites {
				c.written["temp."+n] = true
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

// checkNodes reports what is wrong with a node's delegation SHAPE -- the cases
// that are about an edge that is not there, which no walk over Edges could
// find.
func (c *graphChecker) checkNodes() {
	for i := range c.g.Nodes {
		n := &c.g.Nodes[i]
		if n.Unresolved {
			// An unresolved node is a placeholder for a reference the pack does
			// not define. It has an ID and nothing else, so it has no type to
			// hold to a shape, and the dangling reference is already reported
			// on the EDGE that points here -- once per broken reference rather
			// than once more for the hole it points into.
			continue
		}
		counts := map[EdgeKind]int{}
		for _, ei := range c.edgesFrom[n.ID] {
			counts[c.g.Edges[ei].Kind]++
		}
		if spec, ok := checkSingleDelegation[n.TypeID]; ok {
			switch got := counts[spec.kind]; {
			case got == 0:
				c.nodeDiag("error", CheckRequiredEdge, n, fmt.Sprintf(
					"%s delegates to exactly one feature and cannot load without it, but nothing is wired to its %s.",
					n.TypeID, spec.key))
			case got > 1:
				c.nodeDiag("error", CheckEdgeArity, n, fmt.Sprintf(
					"%s has %d delegations, and %s holds exactly one feature reference. "+
						"Only one of them can be written back to the file; wrap them in an aggregate_feature or a sequence_feature if all of them are meant to run.",
					n.TypeID, got, spec.key))
			}
			c.reportForeignKinds(n, counts, spec.kind, spec.key)
			continue
		}
		if spec, ok := checkListDelegation[n.TypeID]; ok {
			if counts[spec.kind] == 0 && spec.mustBeNonEmpty {
				c.nodeDiag("error", CheckRequiredEdge, n, fmt.Sprintf(
					"%s has no entries. Its %s list is refused below one entry, so this node does not load.",
					n.TypeID, spec.key))
			}
			c.reportForeignKinds(n, counts, spec.kind, spec.key)
		}
		// A type that is in neither table delegates to nothing (a tree, an ore,
		// a single block), and an edge leaving it is reported by
		// reportForeignKinds only where the type IS known to delegate. A node
		// whose type this file does not know -- a type added to the engine
		// after this table was written -- is left alone on purpose: silence
		// there is correct, and an "unexpected delegation" error there would be
		// this file asserting completeness it does not have.
	}
}

// reportForeignKinds reports an edge whose Kind is not the one its source type
// delegates by. Confusing the kinds is not cosmetic: `sequence` and `aggregate`
// differ in the order children run, and order is part of what the world ends up
// looking like, so an edge of the wrong kind is not a mislabel to tidy later.
func (c *graphChecker) reportForeignKinds(n *GraphNode, counts map[EdgeKind]int, want EdgeKind, key string) {
	kinds := make([]string, 0, len(counts))
	for k := range counts {
		if k != want {
			kinds = append(kinds, string(k))
		}
	}
	if len(kinds) == 0 {
		return
	}
	sort.Strings(kinds)
	c.nodeDiag("error", CheckEdgeArity, n, fmt.Sprintf(
		"%s delegates only through %s (%s edges), so an edge of kind %s does not belong on it.",
		n.TypeID, key, want, strings.Join(kinds, "/")))
}

// checkEdges reports what is wrong with an edge itself: where it points, the
// data it carries, and the Molang written on it.
func (c *graphChecker) checkEdges() {
	for i := range c.g.Edges {
		e := &c.g.Edges[i]

		switch target, known := c.nodes[e.To]; {
		case e.To == "":
			// A Required edge with no target is how a half-finished edit looks
			// in the editor: the slot is there, the type needs it filled, and
			// nothing is in it. An optional edge with no target is just an edge
			// the author has not finished drawing, and nagging about it while
			// they are still dragging it is noise.
			if e.Required {
				c.edgeDiag("error", CheckRequiredEdge, e, fmt.Sprintf(
					"this %s delegation has no target, and %s cannot load without it.", e.Kind, e.From))
			}
		case !known:
			c.edgeDiag("error", CheckUnresolvedTarget, e, fmt.Sprintf(
				"delegates to %q, which is not a node in this graph.", e.To))
		case target.Unresolved && target.External:
			// The game's own feature. The pack is right, the reference resolves
			// at run time, and calling it an error told 13 authors on one real
			// pack to correct the spelling of names that were spelled
			// correctly. What IS worth saying is what this tool cannot do.
			c.edgeDiag("info", CheckGameProvidedTarget, e, fmt.Sprintf(
				"delegates to %q, which the game provides rather than this pack. It resolves in game; this tool does not simulate the game's own features, so nothing appears for it in a preview.",
				e.To))
		case target.Unresolved:
			c.edgeDiag("error", CheckUnresolvedTarget, e, unresolvedTargetMessage(e.To, c.definedIDs()))
		}

		c.checkEdgeData(e)

		for _, x := range c.exprs[i] {
			c.checkExpr(e, x)
		}
	}
}

// definedIDs is every node id the pack defines, built on first use. The
// namespace half of the near-match is what earns this: a reference written
// without its namespace is the commonest dangling edge in a real pack, and it
// is the one case where naming the intended target is a near-certainty rather
// than a guess.
func (c *graphChecker) definedIDs() []string {
	if c.defined != nil {
		return c.defined
	}
	c.defined = DefinedNodeIDs(c.g)
	return c.defined
}

// DefinedNodeIDs is every id g actually DEFINES -- the candidate list a
// dangling reference's "did you mean" is drawn from.
//
// Deliberately not every node: an unresolved node is itself a reference
// nothing defines, and suggesting one broken name in place of another would be
// worse than saying nothing.
//
// Non-nil even when the graph defines nothing, so a caller memoising it runs
// the walk once rather than once per dangling edge.
func DefinedNodeIDs(g *Graph) []string {
	if g == nil {
		return []string{}
	}
	out := make([]string, 0, len(g.Nodes))
	for i := range g.Nodes {
		if !g.Nodes[i].Unresolved {
			out = append(out, g.Nodes[i].ID)
		}
	}
	return out
}

// unresolvedTargetMessage is the one sentence a dangling delegation gets,
// wherever it is reported.
//
// It is a function rather than two copies of a string because it now has two
// callers with two very different presentations -- CheckGraph, which wraps it
// with the edge's JSON path and the ignore directive for an editor, and
// cmd/featurelab's checkPack, which prefixes the delegating node for a
// terminal -- and the thing a reader has to recognise across the two is the
// part in the middle: what is wrong, why it matters, and what it might have
// been meant to say.
func unresolvedTargetMessage(to string, defined []string) string {
	return fmt.Sprintf(
		"delegates to %q, which no loaded file defines. Nothing resolves this reference at run time, so this branch places nothing -- check the namespace and the spelling, or add the file.%s",
		to, nearest.Phrase(to, defined))
}

// UnresolvedTarget is one delegation whose target no loaded file defines and
// the game does not provide: a branch of the pack that cannot place anything,
// in game or here.
type UnresolvedTarget struct {
	// From is the node that delegates, To is the reference it wrote.
	From string
	To   string
	// File is From's pack-relative path -- what a client opens to fix this.
	// Empty when From is not a node of this graph.
	File string
	// JSONPath is where inside File the reference is written, in
	// jsonc.FormatPath's dialect (see GraphEdge.JSONPath). Empty for an edge
	// carrying none.
	JSONPath string
	// Message is the sentence to show, shared verbatim with CheckGraph's own
	// unresolved-target finding -- see unresolvedTargetMessage.
	Message string
}

// UnresolvedTargets returns every dangling delegation in g, in g.Edges order.
//
// This exists because the finding it reports was, in practice, unreachable.
// It has always been part of CheckGraph -- with the "did you mean" and
// everything -- and CheckGraph had no production caller at all, so a pack
// whose `"places_feature"` was one letter off loaded clean, checked clean,
// graphed clean, and generated nothing. This is the piece of CheckGraph that
// belongs to `check` rather than to a live editor: it needs no Molang parse,
// no cycle walk and no per-node structural rules, only the edges and which
// nodes resolved, so it is cheap enough to run on every `check` and every
// graph request.
//
// It honours the same `@featurelab:ignore unresolved-target` annotation
// CheckGraph honours, and reports the same sentence, because an author who
// suppressed this finding in the editor has said what they meant about the
// pack, not about one tool that reads it.
//
// External (game-provided `minecraft:*`) targets are NOT here, keeping their
// own non-error treatment: the pack is correct, the reference resolves in
// game, and only the preview cannot show it. See GraphNode.External for the
// 13-wrong-errors-on-a-working-pack history behind that.
//
// An edge whose To names no node at all is also skipped. Every reference in a
// built graph becomes a node -- that is what GraphNode.Unresolved is for -- so
// this can only be a hand-assembled Graph, and it is CheckGraph's business to
// complain about one, not a pack checker's.
func UnresolvedTargets(g *Graph) []UnresolvedTarget {
	if g == nil {
		return nil
	}
	// Built here rather than via newGraphChecker, which parses every Molang
	// expression in the graph on construction -- an outlay this answer has no
	// use for, on a path that runs for every `check` of every pack.
	nodes := make(map[string]*GraphNode, len(g.Nodes))
	for i := range g.Nodes {
		nodes[g.Nodes[i].ID] = &g.Nodes[i]
	}
	var defined []string
	var out []UnresolvedTarget
	for i := range g.Edges {
		e := &g.Edges[i]
		target, known := nodes[e.To]
		if e.To == "" || !known || !target.Unresolved || target.External {
			continue
		}
		from := nodes[e.From]
		if suppressedByIgnore(from, CheckUnresolvedTarget) {
			continue
		}
		if defined == nil {
			defined = DefinedNodeIDs(g)
		}
		file := ""
		if from != nil {
			file = from.File
		}
		out = append(out, UnresolvedTarget{
			From: e.From, To: e.To, File: file, JSONPath: e.JSONPath,
			Message: unresolvedTargetMessage(e.To, defined),
		})
	}
	return out
}

// Diagnostic is one UnresolvedTarget as the row every host already knows how to render: the
// same shape CheckGraph emits and the same shape a pack load or a placement answers with.
//
// It is a method rather than a line of formatting at each call site because the SENTENCE is the
// thing that must not fork. It was already one function (unresolvedTargetMessage) shared by
// CheckGraph and `check`; the prefix in front of it -- the delegating node, then where inside
// its file the reference is written -- was `check`'s alone, and the next host to report this
// would have written a second one. Two wordings of one problem is how a reader ends up
// believing they have two problems.
//
// Level is "error", like any other reference to something that does not exist: the branch
// cannot place anything, in this tool or in game, and there is no origin or seed at which it
// starts working.
//
// Scope is pack, not run: it is a fact about the files on disk, true of every run of every
// feature in the pack.
//
// FileID is the DELEGATING node's file -- the one that can be opened and edited. The target has
// no file; that is what is wrong with it. It falls back to the delegating identifier when the
// graph knows no path for it, because a row naming nothing at all is worse than a row naming
// the feature.
func (t UnresolvedTarget) Diagnostic() session.Diagnostic {
	where := t.JSONPath
	if where == "" {
		where = "places_feature"
	}
	file := t.File
	if file == "" {
		file = t.From
	}
	return session.Diagnostic{
		Level: "error", FileID: file, Scope: session.ScopePack,
		Message: t.From + ": " + where + ": " + t.Message,
	}
}

// UnresolvedTargetDiagnostics is every dangling delegation in a loaded pack, as diagnostics.
//
// THIS IS THE HOLE EVERY HOST HAD, and the reason it is here rather than in whichever host
// noticed it first. Every individual file in such a pack is perfectly well-formed -- a
// `"places_feature"` is a string and that string is spelled fine -- so the loaders have nothing
// to complain about, and a pack with one letter wrong in one delegation loads clean and
// generates nothing but "No features could be placed". The mistake is not visible in any one
// file; it is visible only BETWEEN two of them, which is exactly what the graph is, and the
// graph is this package's.
//
// It was written in cmd/featurelab, so `check`, `graph` and the VS Code extension (which drives
// both over `serve`) reported it and apps/desktop -- which links this engine in-process and
// never goes through that package at all -- did not. The natural-looking home, session, is not
// available and should not be made available: this package already imports session for
// Diagnostic, so session importing Graph would be an import cycle, and the honest reason behind
// that cycle is that session is about running a placement while this is a statement about the
// files, derived without an origin, a seed or a world. So it lives beside the graph it reads,
// and every host calls it.
//
// g is the caller's already-built graph, or nil to build one here. The parameter exists because
// a graph costs a JSON re-parse of every source file in the pack, and a `graph` request that
// built one and then made this build a second identical one would have doubled the cost of the
// slowest request this engine serves.
//
// ok is false ONLY when ctx was cancelled, in which case the diagnostics returned are a prefix
// of the real set and must not be shown to anybody. A graph that could not be BUILT is a
// different thing: it says nothing about delegations either way, and the per-file diagnostics
// this is appended to are complete without it, so it answers with nothing and no error. Adding
// a finding is this function's job; failing for a reason unrelated to the pack's contents is
// not.
func UnresolvedTargetDiagnostics(ctx context.Context, loaded *pack.Pack, g *Graph) ([]session.Diagnostic, bool) {
	if g == nil {
		var err error
		g, err = BuildGraphContext(ctx, loaded)
		if err != nil {
			if ctx.Err() != nil {
				return nil, false
			}
			return nil, true
		}
	}
	if ctx.Err() != nil {
		return nil, false
	}
	targets := UnresolvedTargets(g)
	if len(targets) == 0 {
		return nil, true
	}
	out := make([]session.Diagnostic, 0, len(targets))
	for _, t := range targets {
		out = append(out, t.Diagnostic())
	}
	return out, true
}

// checkEdgeData reports the per-kind payload an edge must carry.
func (c *graphChecker) checkEdgeData(e *GraphEdge) {
	switch e.Kind {
	case EdgeWeighted:
		switch {
		case e.Weight == nil:
			// A WARNING, not an error, and the wording carries the reason:
			// nothing in the graph says which of the two entry shapes the file
			// used. The `[feature, weight]` pair is pinned at exactly two
			// elements, so a pair with no weight does not load; the object form
			// defaults an absent weight to 1.0 and loads fine. Calling this an
			// error would be a false "your pack is broken" on every object-form
			// entry -- and a weight left to a default is worth one line
			// regardless, because what an entry is worth then depends on which
			// shape the file happens to be written in.
			c.edgeDiag("warning", CheckEdgeWeight, e, fmt.Sprintf(
				"weighted_random entry %d has no weight written. Written as an object entry it is worth 1; written as a [feature, weight] pair it does not load at all, because the pair is exactly two elements. Write the weight out so the entry's odds do not depend on which shape the file uses.",
				e.Ordinal))
		case *e.Weight < 0:
			c.edgeDiag("error", CheckEdgeWeight, e, fmt.Sprintf(
				"weighted_random entry %d has weight %g. A negative weight is refused, so the file does not load.",
				e.Ordinal, *e.Weight))
		case *e.Weight == 0:
			// Origin-independent, seed-independent and therefore safe to state
			// flatly: the pick accumulates the weights and draws below the
			// total, and an entry contributing nothing to the total is never
			// the one the draw lands on.
			//
			// Weights between 0 and 1 are also suspect -- the accumulation
			// truncates to whole numbers, so a fractional entry can be
			// unreachable too -- but whether it is depends on the other
			// entries' weights, so it is not stated here as a certainty.
			c.edgeDiag("warning", CheckEdgeWeight, e, fmt.Sprintf(
				"weighted_random entry %d has weight 0, so it is never the entry that gets picked -- not with another seed, not at another origin. Give it a weight of 1 or more, or remove it.",
				e.Ordinal))
		}
	case EdgeScatter:
		if e.Iterations == nil {
			c.edgeDiag("error", CheckEdgeIterations, e,
				"a scatter has no iterations expression. iterations is required and decides how many times the scatter places, so the file does not load without it.")
		}
	}
}

// ---------------------------------------------------------------------------
// Molang checks
// ---------------------------------------------------------------------------

// checkExpr reports on one condition or one iterations expression.
//
// Three of the four findings are uncontroversial. The fourth -- side effects --
// is a judgement call, and it is made asymmetrically ON PURPOSE:
//
//	An assignment inside a scatter's ITERATIONS is not flagged, ever. The
//	Molang scope is shared by reference with everything the scatter delegates
//	to, so `v.height = math.random(3,6); 4;` in iterations is how a pack sets
//	up the values its children read. That is an idiom real packs are built on,
//	not an abuse, and the engine's own "disallow side effects" switch is not
//	applied to world generation at all -- it guards entity property groups,
//	block descriptions and bone visibility. Reporting it would be reporting
//	correct, deliberate, widespread authoring.
//
//	An assignment inside a CONDITION is flagged, as a warning and not an error.
//	It loads and it runs, so an error would be false. But the entry a condition
//	belongs to is one of a list, and how many times a condition is evaluated
//	depends on the list's early-out scheme and on which earlier entries matched
//	-- so a write made from inside one is a write whose number of times is a
//	property of the list's shape rather than of the expression. That is worth
//	one warning saying "put this in the scatter's iterations, where the
//	evaluation count is yours to control", and it is suppressible for the
//	author who meant it.
func (c *graphChecker) checkExpr(e *GraphEdge, x *graphExpr) {
	if x.err != nil {
		c.edgeDiag("error", CheckMolangParse, e, fmt.Sprintf(
			"%s %q is not valid Molang: %v", x.what, x.source, x.err))
		return
	}

	for _, q := range x.refs.Queries {
		if checkWorldGenQueries[q] {
			continue
		}
		c.edgeDiag("error", CheckMolangQuery, e, fmt.Sprintf(
			"%s names query.%s, which nothing answers during world generation. The queries available here are %s.",
			x.what, q, strings.Join(sortedNameList(checkWorldGenQueries), ", ")))
	}

	// The headline check: names this expression READS that nothing writes.
	//
	// NeedsFromHost is a documented lower bound -- it does not follow
	// statement order and treats a name written inside a branch as written --
	// and the set it is filtered against here is deliberately wider still:
	// every write ANYWHERE in the graph counts, not just writes on the path
	// above this edge. That is not laziness, it is the only answer this layer
	// can defend. One Molang scope is shared by the whole delegation tree, so a
	// slot is set by whatever ran before this expression -- a parent's
	// iterations, but equally an earlier sibling in a sequence, or an earlier
	// entry of the same conditional list. Which of those actually ran first is
	// a property of a RUN, not of the graph, so narrowing the set would trade
	// silence for false alarms, and a false "this has no value" on an
	// expression that works is exactly the warning that teaches an author to
	// stop reading warnings.
	//
	// What survives that filter is worth saying loudly: a name nothing in the
	// pack ever writes has no value to read at all. The game does not treat
	// that as a zero and carry on -- an unresolved read with no `??` to catch
	// it ends the expression where it stands, so a condition containing one is
	// never true and an iterations containing one never counts, whatever else
	// is written around it.
	for _, name := range x.refs.NeedsFromHost() {
		if c.written[name] || checkEnginePublishedVars[name] {
			continue
		}
		c.edgeDiag("warning", CheckMolangUnsetRead, e, fmt.Sprintf(
			"%s reads %s, and nothing in this graph ever writes it. In the game a read of a slot that holds no value ends the expression where it stands -- so %s, however the rest of it is written -- while a preview here substitutes 0 and carries on. "+
				"Set %s = <value> in an enclosing scatter's iterations, which shares this Molang scope, or write %s ?? <default> to give the read a value of its own.",
			x.what, name, expressionOutcome(x.what), name, name))
	}

	// SideEffectOps(false) is the engine's own set: assignment is what the
	// switch removes, and math.random is deliberately left in it, so a
	// condition that rolls a chance is not caught here.
	if x.what == "condition" && molang.CheckOps(x.tree, molang.SideEffectOps(false)) != nil {
		c.edgeDiag("warning", CheckMolangSideEffect, e, fmt.Sprintf(
			"condition %q assigns as well as testing. It loads and it runs, but how many times a condition is evaluated depends on the list's early-out scheme and on which earlier entries matched, so the assignment happens a number of times the expression itself does not decide. "+
				"An enclosing scatter's iterations is the place for setup: it shares this same Molang scope and runs once.",
			x.source))
	}
}

// expressionOutcome says what an expression that stops at an unresolved read
// means for the delegation it sits on, in the field's own terms -- "is never
// true" reads as advice, "the read is 0" reads as trivia.
func expressionOutcome(what string) string {
	if what == "iterations" {
		return "this scatter places nothing"
	}
	return "this condition is never true and the feature below it never places"
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

// checkCycles reports Graph.Cycles, as warnings, never as errors.
//
// A cycle is legal. Features are addressed by name and shared, the engine
// guards recursion at run time rather than forbidding it at load, and a pack
// that contains one loads and generates. What it costs is the reader's ability
// to see where the chain ends, and the editor's ability to lay the graph out as
// if it were a tree -- so the useful thing is to hand over the path and let the
// author decide, not to refuse the pack.
func (c *graphChecker) checkCycles() {
	for _, d := range DelegationCycleDiagnostics(c.g) {
		// FileID back to Chain[0]. CheckGraph's rows all carry the ROOT NODE ID
		// there (see nodeDiag/edgeDiag, which spell it c.pathTo(id)[0]), and
		// this package's header documents that FileID matches Chain[0] for
		// everything it emits. The exported form is for hosts that print a row
		// a person clicks, and fills in the node's real file instead -- the
		// same split UnresolvedTarget already makes between CheckGraph's row
		// and Diagnostic()'s.
		if len(d.Chain) > 0 {
			d.FileID = d.Chain[0]
		}
		c.append(d)
	}
}

// DelegationCycleDiagnostics is every delegation cycle in g, as diagnostics --
// the second finding of CheckGraph's eleven to be lifted out for a production
// caller, and the reason it is this one rather than any of the other nine is
// worth stating.
//
// It is the only one in the set whose level was never in question. See
// CheckGraph's own comment: every other unshipped check either is, or could
// become, an ERROR, and turning one on flips a green CI run red on a pack whose
// author changed nothing -- a release decision, taken with corpus numbers in
// hand, not a bug fix. A cycle can only ever be a warning, because the pack
// really does load and really does generate. `check`'s exit code is decided by
// the error count and by nothing else (see cmdCheck), so wiring this one adds a
// row and cannot fail a pack that passes today.
//
// And the finding is real rather than stylistic. A -> B -> A means one of the
// two delegations places nothing: the recursion guard refuses the re-entry, so
// the inner branch is dropped at run time, silently, with no diagnostic
// anywhere and no seed at which it behaves differently. That is the same class
// of defect as a dangling places_feature -- a branch of the pack that cannot
// do anything -- and the editor already refuses the one-node spelling of it
// when someone draws A -> A on the canvas. An author who means it says so with
// `@featurelab:ignore cycle`, which this honours, for the same reason
// UnresolvedTargets honours its own annotation: the note is about the pack, not
// about whichever tool happens to be reading it.
//
// FileID is the file of the node the cycle is rooted at, so a host can open it,
// falling back to the node id when the graph knows no path for it (a
// hand-assembled graph, or an unresolved node, which has no file -- that being
// what is wrong with it). Identifier/TypeID name the node the path ENDS on,
// which is Chain's last entry, exactly as session.Diagnostic documents.
func DelegationCycleDiagnostics(g *Graph) []session.Diagnostic {
	if g == nil || len(g.Cycles) == 0 {
		return nil
	}
	nodes := make(map[string]*GraphNode, len(g.Nodes))
	for i := range g.Nodes {
		nodes[g.Nodes[i].ID] = &g.Nodes[i]
	}
	var out []session.Diagnostic
	for _, cycle := range g.Cycles {
		if len(cycle) == 0 {
			continue
		}
		suppressed := false
		for _, id := range cycle {
			if suppressedByIgnore(nodes[id], CheckCycle) {
				suppressed = true
				break
			}
		}
		if suppressed {
			continue
		}
		last := cycle[len(cycle)-1]
		file := cycle[0]
		if n := nodes[cycle[0]]; n != nil && n.File != "" {
			file = n.File
		}
		typeID := ""
		if n := nodes[last]; n != nil {
			typeID = n.TypeID
		}
		out = append(out, session.Diagnostic{
			Level:      "warning",
			FileID:     file,
			Scope:      session.ScopePack,
			Identifier: last,
			TypeID:     typeID,
			Chain:      append([]string(nil), cycle...),
			Count:      1,
			Message: graphCheckMessage(CheckCycle, fmt.Sprintf(
				"delegation cycle: %s. The pack loads and generates -- the engine's recursion guard stops the loop at run time -- but that guard works by DROPPING the re-entry, so one of these delegations places nothing, at every origin and under every seed, and reports nothing when it does. The chain also has no end, so anything walking or laying out this graph has to be ready for that.",
				strings.Join(append(append([]string(nil), cycle...), cycle[0]), " -> "))),
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

// suppressedByIgnore reports whether the node carries `@featurelab:ignore <check>`.
//
// A bare `@featurelab:ignore` with no arguments silences every check on the
// node. That is the reading the syntax invites, and an author who wrote it
// meant "stop telling me about this node"; refusing to honour it would just
// produce a row of ten ignore lines.
//
// Suppression is per NODE and a diagnostic about an edge is charged to the edge
// SOURCE, because that is the file and the JSON path the edge is written in --
// the annotation the author writes sits next to the delegation it is about.
func suppressedByIgnore(n *GraphNode, check string) bool {
	if n == nil {
		return false
	}
	for _, a := range n.Annotations {
		if !strings.EqualFold(a.Name, "ignore") {
			continue
		}
		if len(a.Args) == 0 {
			return true
		}
		for _, arg := range a.Args {
			if strings.EqualFold(strings.TrimSpace(arg), check) {
				return true
			}
		}
	}
	return false
}

// suppressedByAny is suppression for a finding that belongs to several nodes at
// once -- a cycle. Any node around the cycle may silence it: the author who
// wrote the annotation was looking at one of them, and asking them to annotate
// every node in the loop would be asking for the same sentence four times.
func (c *graphChecker) suppressedByAny(ids []string, check string) bool {
	for _, id := range ids {
		if suppressedByIgnore(c.nodes[id], check) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// session.Diagnostic construction
// ---------------------------------------------------------------------------

func (c *graphChecker) nodeDiag(level, check string, n *GraphNode, msg string) {
	if suppressedByIgnore(n, check) {
		return
	}
	c.append(session.Diagnostic{
		Level:      level,
		FileID:     c.pathTo(n.ID)[0],
		Identifier: n.ID,
		TypeID:     n.TypeID,
		Chain:      c.pathTo(n.ID),
		Count:      1,
		Message:    graphCheckMessage(check, msg),
	})
}

// edgeDiag attributes an edge's finding to the edge's SOURCE node: the source
// is what raised it (the edge is written in its file, at e.JSONPath), so the
// Chain ends there and Identifier names it, exactly as session.Diagnostic documents.
// The target is named in the message instead, which is also what an author
// reading "delegates to X" wants to see.
func (c *graphChecker) edgeDiag(level, check string, e *GraphEdge, msg string) {
	from := c.nodes[e.From]
	if suppressedByIgnore(from, check) {
		return
	}
	typeID := ""
	if from != nil {
		typeID = from.TypeID
	}
	where := e.JSONPath
	if where == "" {
		where = string(e.Kind)
	}
	c.append(session.Diagnostic{
		Level:      level,
		FileID:     c.pathTo(e.From)[0],
		Identifier: e.From,
		TypeID:     typeID,
		Chain:      c.pathTo(e.From),
		Count:      1,
		Message:    graphCheckMessage(check, where+": "+msg),
	})
}

// append is the one funnel every finding in this file goes through, which is also where the
// scope is stamped. Every check here is static analysis of the pack's own graph -- a dead
// delegation, a cycle, a reference to a feature nothing declares -- and is therefore true of
// the pack regardless of what anyone previews: session.ScopePack, never ScopeRun. Nothing in
// this file runs during a placement, so there is no second case to decide between.
func (c *graphChecker) append(d session.Diagnostic) {
	d.Scope = session.ScopePack
	c.out = append(c.out, d)
}

func (c *graphChecker) typeOf(id string) string {
	if n, ok := c.nodes[id]; ok {
		return n.TypeID
	}
	return ""
}

// graphCheckMessage appends the directive that silences this finding. session.Diagnostic has no
// field for a check name, and an author told only "this is a warning" has to
// guess the name to write in the annotation -- so the message carries it, in
// the exact form it is written in the file.
func graphCheckMessage(check, msg string) string {
	return msg + " (@featurelab:ignore " + check + ")"
}

func sortedNameList(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
