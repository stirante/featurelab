// graphbuild.go turns a loaded pack into the editor's view of it -- the
// frozen shape graph.go defines: one node per feature and per feature rule,
// one typed edge per delegation between them.
//
// It reads the pack's JSON directly rather than walking the built libraries,
// and that is the design decision worth arguing. features.BuildLibrary drops
// a file that fails to build (an unknown type or a builder error leaves an
// Entry with a nil Feature), and the nine composite types' FeatureRefs()
// only exists on a feature that DID build -- so a graph built from the
// libraries would show an editor exactly the packs that are already fine,
// and go blank on the one the author opened it to fix. The same walk from
// JSON also carries what FeatureRefs() cannot: which key each reference was
// written under (GraphEdge.JSONPath), its position in a list (Ordinal),
// and the weight/condition/iterations written beside it.
package wire

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/internal/nearest"
	"github.com/stirante/featurelab/internal/packpath"
	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/rules"
)

// graphRuleTypeID is the TypeID a feature rule's node carries. It is the
// singular spelling GraphNode.TypeID's own doc comment names, NOT the
// rules file's plural root key (graphRuleBodyKey) -- a consumer telling
// nodes apart reads this constant, and one opening the file reads
// GraphNode.File.
const graphRuleTypeID = "minecraft:feature_rule"

// graphRuleBodyKey is the one root key a feature_rules file is read under --
// see the rules package: a rule file is bound to a single schema, so unlike
// a feature file there is no type key to discover.
const graphRuleBodyKey = "minecraft:feature_rules"

// BuildGraph walks every feature and feature rule in a loaded pack and
// returns the delegation graph between them.
//
// The error is for one caller mistake only -- no pack at all -- because
// nothing a PACK can contain is a reason to refuse it a graph. A file this
// cannot make a node of (unreadable JSON, no description.identifier) is left
// out, and is already reported by the library build's own diagnostics; a
// reference the pack does not define becomes an Unresolved node rather than
// a dropped edge, because an editor has to be able to SEE a broken
// reference; and a delegation cycle is reported (Graph.Cycles) rather than
// refused, because the engine guards recursion at run time, so a pack
// containing one is legal and still generates. A graph is most wanted for
// the pack that is broken, so failing on any of that would take the tool
// away exactly when it is needed.
func BuildGraph(loaded *pack.Pack) (*Graph, error) {
	return BuildGraphContext(context.Background(), loaded)
}

// BuildGraphContext is BuildGraph with a cancellation signal: cancelling ctx abandons the build
// and returns ctx.Err() instead of a Graph.
//
// PER FILE, not per node or per edge. Parsing one feature file is the unit of work here -- the
// cost of a graph is one JSON parse plus one annotation scan per file, several thousand times
// over on a large pack -- so a check between two files bounds the overshoot at one file's parse
// while costing one comparison per file against work measured in microseconds. The link/cycle
// pass below (b.build) is not checked at all: it walks data already in memory and is a small
// fraction of the whole.
func BuildGraphContext(ctx context.Context, loaded *pack.Pack) (*Graph, error) {
	if loaded == nil {
		return nil, fmt.Errorf("wire: BuildGraph needs a loaded pack")
	}
	b := &graphBuilder{byKey: make(map[string]int)}
	for _, f := range loaded.Features {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		b.register(withPackPath(parseGraphFeatureFile(f), loaded.Dir, f.AbsPath))
	}
	for _, f := range loaded.Rules {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		b.register(withPackPath(parseGraphRuleFile(f), loaded.Dir, f.AbsPath))
	}
	return b.build(), nil
}

// graphDoc is one parsed feature/rule file, before it becomes a node: the
// identity a delegation addresses it by, plus the body the edges are read
// out of.
type graphDoc struct {
	id     string
	typeID string
	fileID string
	// bodyKey is the top-level key this document's body sits under, and it is
	// NOT always typeID: a feature rule's body is under the plural
	// "minecraft:feature_rules" while its node reports the synthetic singular
	// "minecraft:feature_rule". Paths are rooted at the FILE, so this is the
	// first segment of every one of them.
	bodyKey       string
	formatVersion string
	body          map[string]any
	text          []byte
	isRule        bool
}

type graphBuilder struct {
	docs  []*graphDoc
	edges []GraphEdge
	// byKey is keyed by the case-folded identifier (graphFeatureKey), which
	// is how the engine's own registry keys it -- see that function.
	byKey map[string]int
	// unresolved keeps the nodes appended for references the pack does not
	// define, keyed the same way as byKey so a reference written in two
	// different cases produces ONE dangling node.
	unresolved    map[string]string
	unresolvedIDs []string
}

// register adds one parsed file as a node-to-be, unless an earlier file
// already claimed its identifier. Identifiers are matched without regard to
// case, and the FIRST file to claim one keeps it -- the engine's registry
// does exactly that, so the loser is a file nothing can ever place, and a
// second node for it would both break GraphNode.ID's uniqueness and
// show an editor a feature the game will not run. The build diagnostics
// already name the collision.
func (b *graphBuilder) register(doc *graphDoc) {
	if doc == nil {
		return
	}
	key := graphFeatureKey(doc.id)
	if _, taken := b.byKey[key]; taken {
		return
	}
	b.byKey[key] = len(b.docs)
	b.docs = append(b.docs, doc)
}

func (b *graphBuilder) build() *Graph {
	nodes := make([]GraphNode, 0, len(b.docs))
	for _, doc := range b.docs {
		nodes = append(nodes, b.node(doc))
	}
	// defined is every id the pack DOES define -- the candidate list each
	// dangling node's Suggestions is drawn from. Built once here, and only
	// when there is a dangling node to spend it on: the overwhelmingly common
	// pack has none.
	var defined []string
	for _, id := range b.unresolvedIDs {
		n := GraphNode{ID: id, Unresolved: true, External: isGameProvided(id)}
		if !n.External {
			if defined == nil {
				defined = make([]string, 0, len(b.docs))
				for _, doc := range b.docs {
					defined = append(defined, doc.id)
				}
			}
			// A game-provided id is deliberately left alone: the pack is
			// right, and offering it one of the pack's own features as a
			// "correction" is the wrong-error-on-a-working-pack problem
			// GraphNode.External exists to have fixed.
			n.Suggestions = nearest.Names(id, defined)
		}
		nodes = append(nodes, n)
	}
	// Not sorted here: nodes come out in pack order (the loader hands its
	// files over sorted by path) with the dangling ones after them, which is
	// already stable run to run, and a consumer that wants another order
	// imposes its own.
	g := &Graph{Nodes: nodes, Edges: b.edges}
	g.Roots = graphRoots(nodes, b.edges)
	g.Cycles = graphCycles(nodes, b.edges)
	return g
}

// node turns one parsed file into its node, emitting that node's edges on
// the way -- the two cannot be separated, because which keys became edges is
// exactly what Fields has to leave out.
func (b *graphBuilder) node(doc *graphDoc) GraphNode {
	n := GraphNode{
		ID:            doc.id,
		TypeID:        doc.typeID,
		File:          doc.fileID,
		FormatVersion: doc.formatVersion,
	}
	// A rule has no entry in the feature-type coverage table and gets no
	// coverage, rather than a made-up one: the table is about feature types.
	if cov, ok := features.CoverageFor(doc.typeID); ok {
		n.Coverage = string(cov.Status)
		n.CoverageNote = cov.Note
	}
	n.Fields = b.delegations(doc)
	n.Annotations = graphAnnotations(doc)
	return n
}

// graphAnnotations reads the editor directives out of this file's comments.
//
// Without this the Annotation half of the contract is inert: every node
// reaches an editor with an empty list, so a compound never renders
// collapsed, a suppressed warning is never suppressed, and the whole
// mechanism presents as "annotations do not work" -- which is what it did
// until this call existed, because nothing anywhere called ParseAnnotations.
//
// A file whose comments cannot be read yields no annotations rather than an
// error. A directive is an editor convenience; refusing to build the graph
// because one is malformed would take away the view someone opened
// specifically to find out what is wrong with their pack.
func graphAnnotations(doc *graphDoc) []Annotation {
	if len(doc.text) == 0 {
		return nil
	}
	parsed, err := jsonc.ParseAnnotations(doc.text)
	if err != nil || len(parsed) == 0 {
		return nil
	}
	out := make([]Annotation, 0, len(parsed))
	for _, a := range parsed {
		out = append(out, Annotation{
			Name:      a.Name,
			Args:      a.Args,
			Text:      a.Text,
			JSONPath:  a.JSONPath,
			Line:      a.Line,
			Offset:    a.Offset,
			EndOffset: a.EndOffset,
		})
	}
	return out
}

// delegations appends every edge doc's body declares and returns the body
// with the delegation keys removed -- GraphNode.Fields.
//
// "The delegation keys" means the key each edge was actually read from, and
// nothing around it: a scatter keeps its whole `distribution` object in
// Fields even though the edge mirrors `iterations` out of it, because
// `distribution` is not a delegation -- deleting one member of it would hand
// an editor a distribution it cannot render or write back. Three delegations
// are not on the body itself (a rule's description.places_feature and a
// fallen/poplar trunk's log_decoration_feature); those are cut out where
// they sit, leaving the object around them whole.
func (b *graphBuilder) delegations(doc *graphDoc) map[string]any {
	if doc.isRule {
		return b.ruleDelegation(doc)
	}
	switch doc.typeID {
	case "minecraft:aggregate_feature":
		return b.listDelegations(doc, EdgeAggregate)
	case "minecraft:sequence_feature":
		return b.listDelegations(doc, EdgeSequence)
	case "minecraft:weighted_random_feature":
		return b.weightedDelegations(doc)
	case "minecraft:conditional_list":
		return b.conditionalDelegations(doc)
	case "minecraft:scatter_feature":
		return b.scatterDelegation(doc)
	case "minecraft:snap_to_surface_feature":
		return b.filterDelegation(doc, "feature_to_snap")
	case "minecraft:surface_relative_threshold_feature":
		return b.filterDelegation(doc, "feature_to_place")
	case "minecraft:height_difference_filter_feature":
		return b.filterDelegation(doc, "places_feature")
	case "minecraft:scan_surface":
		return b.filterDelegation(doc, "places_feature", "feature", "feature_to_scan")
	case "minecraft:search_feature":
		return b.filterDelegation(doc, "places_feature")
	case "minecraft:vegetation_patch_feature":
		return b.childDelegation(doc, "vegetation_feature", true)
	case "minecraft:tree_feature":
		return b.treeDelegations(doc)
	}
	// Everything else contributes a node and no edges, which is what the
	// types that place blocks themselves should do.
	return graphFields(doc.body)
}

// ruleDelegation reads a rule's single places_feature, which lives one level
// down beside the identifier rather than on the body -- so, uniquely, the
// key cut out of Fields is a nested one and `description` survives with its
// other members intact.
func (b *graphBuilder) ruleDelegation(doc *graphDoc) map[string]any {
	description, _ := doc.body["description"].(map[string]any)
	if ref, ok := description["places_feature"].(string); ok && ref != "" {
		b.append(b.edge(doc, ref, EdgeRule, b.path(doc, graphKey("description"), graphKey("places_feature")), true))
	}
	fields := graphFields(doc.body)
	graphTrimNested(fields, "description", "places_feature")
	if len(fields) == 0 {
		return nil
	}
	return fields
}

// listDelegations reads aggregate_feature/sequence_feature's plain array of
// references. Ordinal is the array index, which for the sequence kind is
// execution order and therefore part of what the pack generates.
//
// An entry is Required only when it is the last one: the array itself is
// required and must be non-empty, so removing one of several is an edit and
// removing the only one stops the file loading.
func (b *graphBuilder) listDelegations(doc *graphDoc, kind EdgeKind) map[string]any {
	list, _ := doc.body["features"].([]any)
	for i, raw := range list {
		ref, ok := raw.(string)
		if !ok || ref == "" {
			continue
		}
		e := b.edge(doc, ref, kind, b.path(doc, graphKey("features"), graphIndex(i)), len(list) == 1)
		e.Ordinal = i
		b.append(e)
	}
	return graphFields(doc.body, "features")
}

// weightedDelegations reads weighted_random_feature's two accepted entry
// shapes: the `[reference, weight]` tuple, and the object form under either
// `feature` or `places_feature`.
//
// An object entry that writes no weight leaves Weight nil rather than the
// 1.0 the engine defaults to, for the reason GraphEdge.Condition gives
// for conditions: "the author wrote nothing" and "the author wrote 1" are
// different facts, and only the first one may be written back to the file
// unchanged.
func (b *graphBuilder) weightedDelegations(doc *graphDoc) map[string]any {
	list, _ := doc.body["features"].([]any)
	for i, raw := range list {
		segments := []jsonc.PathSegment{graphKey("features"), graphIndex(i)}
		var (
			ref    string
			weight *float64
		)
		switch entry := raw.(type) {
		case []any:
			if len(entry) != 2 {
				continue
			}
			ref, _ = entry[0].(string)
			segments = append(segments, graphIndex(0))
			if w, ok := graphNumber(entry[1]); ok {
				weight = &w
			}
		case map[string]any:
			key, value := graphFirstOf(entry, "feature", "places_feature")
			if key == "" {
				continue
			}
			ref, _ = value.(string)
			segments = append(segments, graphKey(key))
			if w, ok := graphNumber(entry["weight"]); ok {
				weight = &w
			}
		default:
			continue
		}
		if ref == "" {
			continue
		}
		e := b.edge(doc, ref, EdgeWeighted, b.path(doc, segments...), len(list) == 1)
		e.Ordinal = i
		e.Weight = weight
		b.append(e)
	}
	return graphFields(doc.body, "features")
}

// conditionalDelegations reads conditional_list's entries. No entry is ever
// Required: `conditional_features` itself is, but an empty one loads, so any
// single entry can be removed.
func (b *graphBuilder) conditionalDelegations(doc *graphDoc) map[string]any {
	list, _ := doc.body["conditional_features"].([]any)
	for i, raw := range list {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		ref, ok := entry["places_feature"].(string)
		if !ok || ref == "" {
			continue
		}
		e := b.edge(doc, ref, EdgeConditional,
			b.path(doc, graphKey("conditional_features"), graphIndex(i), graphKey("places_feature")), false)
		e.Ordinal = i
		// Absent stays nil -- it means always-true, and an editor must be
		// able to tell that from an author who wrote the constant.
		if condition, present := entry["condition"]; present {
			e.Condition = graphMolangText(condition)
		}
		// Set whether or not the key is there: an author adding a condition
		// to an always-true branch needs the location precisely when the
		// value is absent.
		e.ConditionPath = b.path(doc, graphKey("conditional_features"), graphIndex(i), graphKey("condition"))
		b.append(e)
	}
	return graphFields(doc.body, "conditional_features")
}

// scatterDelegation reads scatter_feature's places_feature plus the
// `iterations` beside it, from whichever of the two shapes the file uses --
// nested inside `distribution` (format_version 1.21.10 and up) or flat on
// the body below that. Both are read here regardless of the declared
// version: this is the editor's view of what the file SAYS, and the loader
// is the one that decides which shape that version's schema accepts.
func (b *graphBuilder) scatterDelegation(doc *graphDoc) map[string]any {
	ref, _ := doc.body["places_feature"].(string)
	if ref == "" {
		return graphFields(doc.body, "places_feature")
	}
	e := b.edge(doc, ref, EdgeScatter, b.path(doc, graphKey("places_feature")), true)
	// The path follows the shape the FILE uses, never the declared version.
	// Those two disagree in real packs, and only this function knows which
	// one is actually there -- see GraphEdge.IterationsPath.
	distribution, hasDistribution := doc.body["distribution"].(map[string]any)
	nestedPath := b.path(doc, graphKey("distribution"), graphKey("iterations"))
	flatPath := b.path(doc, graphKey("iterations"))
	switch {
	case hasDistribution && graphMolangText(distribution["iterations"]) != nil:
		e.Iterations = graphMolangText(distribution["iterations"])
		e.IterationsPath = nestedPath
	case graphMolangText(doc.body["iterations"]) != nil:
		// A flat value belongs at the flat key it was read from even when a
		// distribution object sits beside it; rewriting it into the nested
		// one would move the author's value behind their back.
		e.Iterations = graphMolangText(doc.body["iterations"])
		e.IterationsPath = flatPath
	case hasDistribution:
		// Nothing written yet, but the file has committed to the nested
		// shape, so that is where a new value goes.
		e.IterationsPath = nestedPath
	default:
		e.IterationsPath = flatPath
	}
	b.append(e)
	return graphFields(doc.body, "places_feature")
}

// filterDelegation reads the single child of a wrapping type, under the
// first of keys the file actually wrote. Every one of these types refuses to
// load without it, so the edge is Required.
func (b *graphBuilder) filterDelegation(doc *graphDoc, keys ...string) map[string]any {
	key, value := graphFirstOf(doc.body, keys...)
	if key == "" {
		return graphFields(doc.body, keys...)
	}
	if ref, ok := value.(string); ok && ref != "" {
		b.append(b.edge(doc, ref, EdgeFilter, b.path(doc, graphKey(key)), true))
	}
	// Only the key that was read leaves Fields: another spelling present
	// beside it is a key the engine drops unread, and hiding it would hide
	// why the file does not do what its author thinks.
	return graphFields(doc.body, key)
}

// childDelegation reads a named single-child slot on the body -- a feature
// in a field, with the parent neither filtering nor scattering it. The key
// is the only label the edge carries, because what the child means is the
// parent type's business.
func (b *graphBuilder) childDelegation(doc *graphDoc, key string, required bool) map[string]any {
	if ref, ok := doc.body[key].(string); ok && ref != "" {
		b.append(b.edge(doc, ref, EdgeChild, b.path(doc, graphKey(key)), required))
	}
	return graphFields(doc.body, key)
}

// treeDelegations reads tree_feature's one delegation: the decoration a
// fallen or poplar trunk places along its logs. The eight trunk variants are
// sibling keys on the body and exactly one may be present, but both are read
// here rather than stopping at the first -- a file carrying two does not
// load, and showing only one of them would hide half of why.
//
// Never Required: a trunk without the key simply places no decoration.
func (b *graphBuilder) treeDelegations(doc *graphDoc) map[string]any {
	const key = "log_decoration_feature"
	fields := graphFields(doc.body)
	for _, trunkKey := range []string{"fallen_trunk", "poplar_trunk"} {
		trunk, ok := doc.body[trunkKey].(map[string]any)
		if !ok {
			continue
		}
		ref, ok := trunk[key].(string)
		if !ok || ref == "" {
			continue
		}
		b.append(b.edge(doc, ref, EdgeChild, b.path(doc, graphKey(trunkKey), graphKey(key)), false))
		graphTrimNested(fields, trunkKey, key)
	}
	if len(fields) == 0 {
		return nil
	}
	return fields
}

// graphTrimNested cuts one nested delegation key out of an already-copied
// Fields map, leaving the object it sat in otherwise whole. Without it the
// same reference would appear twice -- once as an edge, once as a form field
// an editor could change out from under that edge.
func graphTrimNested(fields map[string]any, parentKey, childKey string) {
	parent, ok := fields[parentKey].(map[string]any)
	if !ok {
		return
	}
	if trimmed := graphFields(parent, childKey); trimmed != nil {
		fields[parentKey] = trimmed
	} else {
		delete(fields, parentKey)
	}
}

// edge starts an edge and resolves its target, creating the Unresolved node
// if the pack defines no such feature. It does NOT record the edge: a caller
// still has Ordinal/Weight/Condition/Iterations to fill in, and finishes
// with append.
func (b *graphBuilder) edge(doc *graphDoc, ref string, kind EdgeKind, path string, required bool) GraphEdge {
	return GraphEdge{From: doc.id, To: b.target(ref), Kind: kind, JSONPath: path, Required: required}
}

func (b *graphBuilder) append(e GraphEdge) { b.edges = append(b.edges, e) }

// graphPath renders an edge's JSONPath, and every path here goes through it
// -- never through string formatting, however obvious the result looks.
//
// IT IS ROOTED AT THE FILE, not at the feature body. `$` is the whole
// document, so the first segment is always the key the body sits under
// ("minecraft:aggregate_feature", or "minecraft:feature_rules" for a rule)
// and an aggregate's second entry is
// `$.minecraft:aggregate_feature.features[1]`.
//
// That root is not a preference, it is the only one that works, and getting
// it wrong once already cost this file a silent failure of everything paths
// are for. Two consumers read these strings and BOTH are file-rooted:
//
//   - jsonc.Apply resolves against the whole document, so a body-rooted
//     `$.features[0]` does not merely address the wrong place -- it fails
//     with "$.features does not exist", and every write an editor attempted
//     through an edge path would have failed that way.
//   - Annotation.JSONPath is produced by the comment scanner, which also
//     walks from the document root. Edges and annotations are matched by
//     string equality and nothing else, so two different ROOTS mismatch
//     exactly as quietly as two different dialects did: the annotation
//     attaches to nothing and it presents as "annotations do not work".
//
// Pinning the dialect was done first and was not enough on its own -- it
// fixed the spelling of the address while leaving the coordinate system
// disagreeing. Both halves have to match.
//
// jsonc.FormatPath is the one dialect, and it is also what quotes a key that
// would otherwise be ambiguous -- a pack is free to name a member "a.b", and
// hand-joining on '.' would silently address something else.
func (b *graphBuilder) path(doc *graphDoc, segments ...jsonc.PathSegment) string {
	rooted := make([]jsonc.PathSegment, 0, len(segments)+1)
	rooted = append(rooted, graphKey(doc.bodyKey))
	rooted = append(rooted, segments...)
	return jsonc.FormatPath(rooted)
}

func graphKey(key string) jsonc.PathSegment { return jsonc.PathSegment{Key: key} }

func graphIndex(i int) jsonc.PathSegment { return jsonc.PathSegment{Index: i, IsIndex: true} }

// target maps a written reference to the node id it points at: the defining
// file's own spelling of the identifier when the pack defines it (the engine
// matches identifiers without regard to case, so an edge written in another
// case still has to LAND on that node rather than fork the graph), and
// otherwise a new Unresolved node under the reference as written.
func (b *graphBuilder) target(ref string) string {
	key := graphFeatureKey(ref)
	if i, ok := b.byKey[key]; ok {
		return b.docs[i].id
	}
	if id, ok := b.unresolved[key]; ok {
		return id
	}
	if b.unresolved == nil {
		b.unresolved = make(map[string]string)
	}
	b.unresolved[key] = ref
	b.unresolvedIDs = append(b.unresolvedIDs, ref)
	return ref
}

// graphRoots is every node with no incoming edge -- the feature rules, plus
// any feature nothing delegates to. In Nodes order, for the reason build
// gives for that order.
//
// A feature reachable ONLY around a cycle has an incoming edge and is
// therefore not a root, so it is reachable from no root at all. That is why
// Nodes carries every feature the pack defines rather than only what the
// roots reach: a cycle is legal, and an editor that never showed the feature
// could not be used to break the cycle.
func graphRoots(nodes []GraphNode, edges []GraphEdge) []string {
	referenced := make(map[string]bool, len(edges))
	for _, e := range edges {
		referenced[e.To] = true
	}
	var roots []string
	for _, n := range nodes {
		if !referenced[n.ID] {
			roots = append(roots, n.ID)
		}
	}
	return roots
}

// graphCycles finds the delegation cycles, one per back edge of a
// depth-first walk over the whole graph. That is not every elementary cycle
// a dense graph could have -- enumerating those is exponential, and a pack
// does not need it -- but it does report a cycle through every edge that
// closes one, which is what a consumer needs before it walks the graph as if
// it were a tree.
//
// Each cycle is rotated to start at its smallest node id and de-duplicated,
// so the same loop reached from two different roots is reported once.
func graphCycles(nodes []GraphNode, edges []GraphEdge) [][]string {
	found := make(map[string][]string)
	adjacency := make(map[string][]string, len(nodes))
	for _, e := range edges {
		adjacency[e.From] = append(adjacency[e.From], e.To)
	}

	const (
		unvisited = 0
		onStack   = 1
		done      = 2
	)
	state := make(map[string]int, len(nodes))
	var stack []string

	var walk func(id string)
	walk = func(id string) {
		state[id] = onStack
		stack = append(stack, id)
		for _, next := range adjacency[id] {
			switch state[next] {
			case unvisited:
				walk(next)
			case onStack:
				for i := len(stack) - 1; i >= 0; i-- {
					if stack[i] != next {
						continue
					}
					cycle := graphRotateCycle(stack[i:])
					found[fmt.Sprint(cycle)] = cycle
					break
				}
			}
		}
		stack = stack[:len(stack)-1]
		state[id] = done
	}
	// Nodes are already sorted by id, so the walk order -- and with it which
	// rotation of a cycle is found first -- does not depend on map ordering.
	for _, n := range nodes {
		if state[n.ID] == unvisited {
			walk(n.ID)
		}
	}

	if len(found) == 0 {
		return nil
	}
	keys := make([]string, 0, len(found))
	for k := range found {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	cycles := make([][]string, 0, len(keys))
	for _, k := range keys {
		cycles = append(cycles, found[k])
	}
	return cycles
}

// graphRotateCycle returns the same cycle starting at its smallest id, so
// two walks that entered the loop at different points produce one answer.
func graphRotateCycle(cycle []string) []string {
	start := 0
	for i, id := range cycle {
		if id < cycle[start] {
			start = i
		}
	}
	out := make([]string, 0, len(cycle))
	out = append(out, cycle[start:]...)
	return append(out, cycle[:start]...)
}

// isGameProvided reports whether an unresolved id names one of the game's own
// features rather than a missing one of the pack's.
//
// The namespace is the whole test, and it is sound in both directions: the
// game's features are all in `minecraft:`, and a pack that writes its own
// `minecraft:` feature overrides the game's -- at which point the file exists
// and the node is resolved, so this is never reached for it.
//
// Case-insensitive because the engine matches identifiers that way.
func isGameProvided(id string) bool {
	return strings.HasPrefix(strings.ToLower(id), "minecraft:")
}

// withPackPath replaces a document's file id with a path relative to the pack.
//
// GraphNode.File's contract is "the pack-relative path this node was loaded
// from", which is what an editor joins onto the pack root to open or write the
// file. What the loader hands over is the SourceFile ID, and that is relative
// to the KIND's directory -- "tree_acacia.json", not "features/tree_acacia.json"
// -- so every consumer that joined it onto the pack root looked one directory
// too high and found nothing. Editing a field, opening a node's file and
// previewing a node all failed that way, on every node, in every pack.
//
// It went unnoticed because the tests on both sides agreed with each other and
// neither agreed with this function: the graph tests spell File as
// "features/x.json" by hand, and the apply tests are handed pack-relative paths
// directly. The one place the two meet had no test at all.
//
// Computed from the absolute path rather than by prefixing a directory name,
// so a pack whose features live somewhere the conventional layout does not put
// them still gets a path that resolves -- and if that somewhere is outside the
// pack entirely, the result says so with "..", which is true and checkable,
// rather than a tidy-looking path to nowhere.
func withPackPath(doc *graphDoc, packDir, absPath string) *graphDoc {
	if doc == nil {
		return doc
	}
	if rel := PackRelativePath(packDir, absPath); rel != "" {
		doc.fileID = rel
	}
	return doc
}

// PackRelativePath spells one file of a loaded pack the way everything this
// package puts on the wire spells it: relative to the pack root, POSIX
// separators. GraphNode.File is this, and so is GraphDiagnostic.FileID -- a
// renderer is promised it can join a diagnostic onto the node whose File
// matches, and that promise is only kept while ONE function computes both.
//
// It is exported for that second caller: the diagnostics come from
// cmd/featurelab's checkPack, which gets the loader's kind-relative SourceFile
// ID ("thing.json") and has to arrive at the same string this gives a node. A
// second implementation there -- prefixing "features/", say -- is how the two
// sides drift back apart, which is the whole history of this function (see
// withPackPath above).
//
// Returns "" for anything it cannot answer -- no pack root, no absolute path,
// or a Rel that fails (different volumes on Windows, most plausibly), and for
// the embedded vanilla block catalogue, whose "path" is inside a build-time
// FS and names nothing on disk. A caller keeps the id it already had: no more
// wrong than it was, and better than a path to nowhere.
//
// The body lives in internal/packpath because a THIRD caller cannot reach this
// one: session (whose Result.Diagnostics the preview renders) is imported BY
// this package, so it cannot import back, and it used to answer with the
// loader's kind-relative id for a file these two spelled pack-relative. See
// that package.
func PackRelativePath(packDir, absPath string) string {
	return packpath.Relative(packDir, absPath)
}

// parseGraphFeatureFile reads one features/*.json far enough to place it in
// the graph: its type key, its identifier and its body. It deliberately
// stops short of everything the loader checks beyond that (the version
// floor, whether the type exists at this format_version, whether the builder
// accepts the body) -- a file that fails any of those is exactly the file
// someone opens an editor to fix, and it still has to appear.
func parseGraphFeatureFile(f features.SourceFile) *graphDoc {
	root := graphParseJSON(f.Text)
	if root == nil {
		return nil
	}
	typeID := ""
	for k := range root {
		if k != "format_version" {
			typeID = k
			break
		}
	}
	body, ok := root[typeID].(map[string]any)
	if !ok {
		return nil
	}
	id := graphIdentifier(body)
	if id == "" {
		return nil
	}
	return &graphDoc{
		id:            id,
		typeID:        typeID,
		fileID:        f.ID,
		bodyKey:       typeID,
		formatVersion: graphFormatVersion(root),
		body:          body,
		text:          []byte(f.Text),
	}
}

func parseGraphRuleFile(f rules.SourceFile) *graphDoc {
	root := graphParseJSON(f.Text)
	if root == nil {
		return nil
	}
	body, ok := root[graphRuleBodyKey].(map[string]any)
	if !ok {
		return nil
	}
	id := graphIdentifier(body)
	if id == "" {
		return nil
	}
	return &graphDoc{
		id:            id,
		typeID:        graphRuleTypeID,
		fileID:        f.ID,
		bodyKey:       graphRuleBodyKey,
		formatVersion: graphFormatVersion(root),
		body:          body,
		text:          []byte(f.Text),
		isRule:        true,
	}
}

// graphParseJSON parses one pack file. Comments are stripped first because
// the game's own parser accepts them (see package jsonc), so a pack that
// uses them is not malformed.
func graphParseJSON(text string) map[string]any {
	var root map[string]any
	if err := json.Unmarshal(jsonc.StripComments([]byte(text)), &root); err != nil {
		return nil
	}
	return root
}

func graphIdentifier(body map[string]any) string {
	description, ok := body["description"].(map[string]any)
	if !ok {
		return ""
	}
	id, _ := description["identifier"].(string)
	return id
}

// graphFormatVersion renders the file's declared version in the one spelling
// a consumer can compare, whichever of the two legal shapes (a string, or an
// array of numbers) the file used. A version that does not parse is reported
// as absent: the file does not load in the game either, and the loader's own
// diagnostic says why.
func graphFormatVersion(root map[string]any) string {
	fv, err := features.ParseFormatVersion(root["format_version"])
	if err != nil || !fv.Present {
		return ""
	}
	return fv.Raw
}

// graphFields copies body without the keys that became edges. The copy is
// shallow -- nothing mutates the parsed document after this -- and an empty
// result is nil so the node simply carries no fields.
func graphFields(body map[string]any, without ...string) map[string]any {
	if len(body) == 0 {
		return nil
	}
	out := make(map[string]any, len(body))
	for k, v := range body {
		out[k] = v
	}
	for _, k := range without {
		delete(out, k)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// graphFirstOf names the first of keys present in obj, and its value. The
// KEY is what separates this from features.FirstOf: an edge's JSONPath has
// to say which spelling the file actually used.
func graphFirstOf(obj map[string]any, keys ...string) (string, any) {
	for _, k := range keys {
		if v, ok := obj[k]; ok {
			return k, v
		}
	}
	return "", nil
}

func graphNumber(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// graphMolangText renders a value that may legally be written as a number, a
// boolean or a Molang string -- `iterations` and a conditional entry's
// `condition` both are -- as the text an editor shows and writes back. A
// number keeps its plain decimal form rather than an exponent, because that
// is how a pack writes one.
func graphMolangText(v any) *string {
	var s string
	switch t := v.(type) {
	case string:
		s = t
	case float64:
		s = strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		s = strconv.FormatBool(t)
	default:
		return nil
	}
	return &s
}

// graphFeatureKey folds an identifier the way the engine's feature registry
// does: a reference that differs from its target only in case resolves in
// game, so it has to resolve here too, or the graph would show a dangling
// edge the game does not have. ASCII-only, matching the engine -- identifiers
// are namespace:name pairs, and Unicode folding would invent cases it does
// not have.
func graphFeatureKey(identifier string) string {
	out := []byte(identifier)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + ('a' - 'A')
		}
	}
	return string(out)
}
