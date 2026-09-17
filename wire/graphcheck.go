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
	"fmt"
	"sort"
	"strings"

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
			c.edgeDiag("error", CheckUnresolvedTarget, e, fmt.Sprintf(
				"delegates to %q, which no loaded file defines. Nothing resolves this reference at run time, so this branch places nothing -- check the namespace and the spelling, or add the file.",
				e.To))
		}

		c.checkEdgeData(e)

		for _, x := range c.exprs[i] {
			c.checkExpr(e, x)
		}
	}
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
	for _, cycle := range c.g.Cycles {
		if len(cycle) == 0 {
			continue
		}
		if c.suppressedByAny(cycle, CheckCycle) {
			continue
		}
		last := cycle[len(cycle)-1]
		c.append(session.Diagnostic{
			Level:      "warning",
			FileID:     cycle[0],
			Identifier: last,
			TypeID:     c.typeOf(last),
			Chain:      append([]string(nil), cycle...),
			Count:      1,
			Message: graphCheckMessage(CheckCycle, fmt.Sprintf(
				"delegation cycle: %s. This is legal -- the recursion guard stops it at run time -- but the chain has no end, and anything walking or laying out this graph has to be ready for that.",
				strings.Join(append(append([]string(nil), cycle...), cycle[0]), " -> "))),
		})
	}
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

func (c *graphChecker) append(d session.Diagnostic) { c.out = append(c.out, d) }

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
