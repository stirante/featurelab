package wire

// The feature graph, as the editor sees it.
//
// This file is the FROZEN CONTRACT between the engine and any graph editor.
// Everything else about the editor can change independently; this cannot,
// without coordinating, because several components are written against it at
// once.
//
// Two things it is deliberately NOT:
//
//   - It is not the JSON. A node carries the fields the editor renders, but
//     the file on disk stays the source of truth: the editor reads this to
//     lay out and validate, and writes JSON back through the round-trip
//     writer. Nothing here is authoritative about what a pack contains.
//   - It is not a tree. Features are addressed by "namespace:id" and shared,
//     so the same node can be the target of many edges, and a cycle is
//     possible (the engine guards recursion rather than forbidding it). A
//     consumer that assumes a tree will be wrong on real packs.
//
// ORDERING IS PART OF THE CONTRACT. Nodes, Edges, Roots and Cycles are all
// deterministically ordered before a Graph leaves the process, so the same
// pack serialises to the same bytes every time. That is not tidiness: an
// editor lays a graph out from these arrays, and an order that wobbled --
// Go map iteration is the obvious way for it to -- would move every box on
// screen each time someone reloaded a pack they had not changed. A producer
// may build in any order; the boundary sorts.
type Graph struct {
	// Nodes is every feature and feature rule reachable from Roots, plus any
	// node that is referenced but could not be resolved (Node.Unresolved).
	Nodes []GraphNode `json:"nodes"`
	// Edges is every delegation. An edge's meaning depends on its Kind; see
	// EdgeKind.
	Edges []GraphEdge `json:"edges"`
	// Roots are the node ids nothing delegates to -- feature rules, plus any
	// feature not referenced by another feature. An editor opens on these.
	Roots []string `json:"roots"`
	// Cycles lists each delegation cycle found, as the node ids around it.
	// Empty for the overwhelmingly common case. These are legal -- the
	// engine's recursion guard stops them at run time -- but an editor must
	// not lay out or walk the graph as if they cannot happen.
	Cycles [][]string `json:"cycles,omitempty"`

	// Diagnostics is every problem the pack raised while loading, in the
	// shape `check` reports them -- the SAME entries, from the same code
	// path, so the two can never disagree about a file.
	//
	// THIS FIELD IS AN ADDITIVE AMENDMENT to the frozen contract above:
	// appended at the end, no existing field changed, renamed or
	// reinterpreted, so every consumer written against the previous shape
	// keeps decoding exactly what it did before and simply ignores this.
	//
	// It had to be added because a file the pack REFUSED has no node, no
	// edge and no root -- there is nowhere in the shape above for it to
	// appear. A rule file with one nesting level too many loses its
	// `description`, the engine refuses the whole file, and the graph that
	// came back was a correct graph of everything that loaded, silently
	// missing the file the author had just written. `check` said exactly
	// what was wrong at error level, but an editor drawing the graph never
	// runs `check`, so the author's file vanished with no message anywhere.
	// A graph carries what it omitted, or nobody is told.
	//
	// WHAT IT DOES NOT CARRY: pack-level hygiene warnings -- a pack with no
	// structures/ or biomes/ directory -- which are true, are `check`'s to
	// report, and name no file an editor could put them beside. A
	// diagnostics channel that is non-empty for every pack is a channel
	// people learn to ignore, which would cost exactly the message this
	// field exists to deliver. A pack that loads cleanly produces [].
	//
	// Ordering is `check`'s own -- by asset kind, then by the order the
	// files were loaded in -- which is already deterministic for a given
	// pack, so unlike the lists above this one is not re-sorted at the
	// boundary. Re-sorting it would also scatter the two or three
	// diagnostics one broken file usually raises, which are read together.
	Diagnostics []GraphDiagnostic `json:"diagnostics"`
}

// GraphDiagnostic is one problem with one file, in the shape `check` prints
// (level, fileId, message) -- deliberately that shape and not a richer one,
// because these ARE check's entries rather than a second opinion built
// alongside them.
//
// FileID is the pack-relative id of the file the diagnostic is about, the
// same id GraphNode.File carries, so an editor can put a message beside the
// node it belongs to -- or, for a file that produced no node at all, name
// the file that is missing from the graph.
//
// "The same id" is a join, so it is only worth anything while one function
// spells both: PackRelativePath. The collector these come from (cmd/
// featurelab's checkPack) is handed the loader's KIND-relative SourceFile id
// -- "thing.json", not "feature_rules/thing.json" -- and resolves it through
// that function per asset kind, because the id alone cannot say which
// directory it came from and a pack may hold that same basename in two.
type GraphDiagnostic struct {
	// Level is "error" or "warning". An error means the engine refused the
	// file outright, so nothing in it reached the graph; a warning means it
	// loaded with something in it dropped or unread.
	Level string `json:"level"`
	// FileID is the file the diagnostic is about, pack-relative.
	FileID string `json:"fileId"`
	// Line and Column are the 1-based place in FileID, omitted when the
	// loader did not know one (most diagnostics are about a whole file).
	// Carried through from `check`'s own diagnostic rather than dropped
	// here: the position exists by the time it reaches this boundary, and a
	// graph's problem list is one of the places someone clicks to go fix
	// the file.
	Line   int `json:"line,omitempty"`
	Column int `json:"column,omitempty"`
	// Message is check's own sentence, verbatim. Not re-worded here: the
	// two commands quoting one problem differently is how a reader ends up
	// believing they are two problems.
	Message string `json:"message"`
}

// GraphNode is one feature or feature rule.
type GraphNode struct {
	// ID is "namespace:identifier", the name delegations address it by, and
	// is unique across the graph.
	ID string `json:"id"`
	// TypeID is the `minecraft:*` feature type. A rule gets the synthetic
	// "minecraft:feature_rule" -- singular, and deliberately NOT the
	// "minecraft:feature_rules" key its file is rooted at, because this
	// names one rule rather than the file's collection of them. Empty when
	// Unresolved.
	TypeID string `json:"typeId,omitempty"`
	// File is the pack-relative path this node was loaded from, which is
	// what an editor opens when someone asks to see the JSON. Empty when
	// Unresolved.
	File string `json:"file,omitempty"`

	// FormatVersion is the file's own declared version. It is NOT decoration:
	// the engine gates which keys a type accepts on the version band, so a
	// node's editable field set depends on this value.
	FormatVersion string `json:"formatVersion,omitempty"`

	// Coverage is this type's implementation status in this tool
	// ("implemented", "partial", "missing", "out_of_scope"), and Note is what
	// features/coverage.go says about it. An editor should refuse to offer a
	// missing/out_of_scope type when creating a node, and should show Note
	// beside a partial one rather than pretending it is complete.
	//
	// BOTH ARE A FUNCTION OF TypeID ALONE, and CoverageNote is the single
	// largest duplication in this shape. The whole coverage table is 29 types
	// and 27,188 characters of notes -- a mean of 937 per type, 3,110 for the
	// longest -- and every node carrying one carries its type's copy. Measured
	// on a 3,126-node pack, `coverageNote` was 4.53MB of a 20.5MB graph dump
	// (22.1%) and was ONE distinct string, repeated 2,500 times.
	//
	// It stays on the node by default, because that is the frozen contract and
	// a consumer reading it must keep working. A client that minds the size
	// asks for the graph with `omitCoverageNotes` and reads the table once
	// from serve's "types" method, which is where it comes from -- see
	// OmitCoverageNotes.
	Coverage     string `json:"coverage,omitempty"`
	CoverageNote string `json:"coverageNote,omitempty"`

	// Fields is the node's own JSON body minus the delegation keys, which
	// are edges instead. An editor renders this as the node's form.
	Fields map[string]any `json:"fields,omitempty"`

	// Annotations are the editor directives parsed out of the file's
	// comments. See Annotation.
	Annotations []Annotation `json:"annotations,omitempty"`

	// Unresolved marks a node that something delegates to and the pack does
	// not define. It has an ID and nothing else, and exists so a broken
	// reference is a visible dangling edge rather than a missing node.
	Unresolved bool `json:"unresolved,omitempty"`

	// External marks an unresolved node the GAME provides: one named in the
	// `minecraft:` namespace, which a pack delegates to without defining and
	// which resolves perfectly well at run time.
	//
	// The distinction is not pedantry. On the pack this tool is developed
	// against, 13 of 3531 nodes are these -- `minecraft:bush_feature`,
	// `minecraft:fern_feature`, the four big_dripleaf orientations -- and
	// before this field existed every one was drawn as a broken reference and
	// reported as an error telling the author to check the spelling of a name
	// that was spelled correctly. Thirteen wrong errors on a working pack is
	// how an author learns to stop reading them.
	//
	// What IS true of these, and worth saying instead: this tool does not
	// simulate the game's own features, so nothing appears for them in a
	// preview. That is a fact about the preview, not about the pack.
	//
	// A pack that defines `minecraft:something` itself overrides the game's
	// version, and is then resolved like anything else -- so this can only
	// ever be set on a node no file defines.
	External bool `json:"external,omitempty"`

	// Suggestions is what this dangling reference was plausibly meant to say:
	// up to three ids the pack actually defines, best first (internal/nearest
	// decides, and it prefers a forgotten namespace over an edit-distance
	// guess). Set only on an Unresolved node that is NOT External, and absent
	// when nothing in the pack is close enough -- which is the common case and
	// is not an error.
	//
	// It carries the CANDIDATES rather than the "did you mean ...?" sentence
	// because a node is where an editor can act rather than only read: this is
	// what a quick-fix offers, or a one-click rename of the reference. The
	// sentence exists too, on the diagnostic for the same edge (see
	// UnresolvedTargets), for the clients that only show text.
	//
	// Why it is on the node at all: the near-match machinery has been in this
	// repo for a while and reached exactly one situation, the identifier a
	// caller REQUESTED. So `generate --feature wiki:rng_markr` suggested
	// `wiki:rng_marker` and the very same typo written as a delegation got
	// nothing, on the canvas or anywhere else.
	Suggestions []string `json:"suggestions,omitempty"`
}

// OmitCoverageNotes clears CoverageNote on every node, in place.
//
// It is a strict subtraction of a field that is derivable from TypeID through serve's "types"
// method (features.CoverageFor is the same table both go through), and it is opt-in -- see
// GraphNode.Coverage for the measurement that makes it worth having, and for why the default
// cannot change.
//
// Coverage itself is deliberately NOT cleared. It is one short word, it was 0.3% of the same
// dump, and it is the half an editor acts on: it decides whether a type can be offered at all.
// The note is the paragraph beside it that a client can fetch once.
func OmitCoverageNotes(g *Graph) {
	if g == nil {
		return
	}
	for i := range g.Nodes {
		g.Nodes[i].CoverageNote = ""
	}
}

// EdgeKind is what a delegation MEANS, and the kinds are not
// interchangeable: confusing `sequence` for `aggregate` silently changes the
// world, because the order children run in is part of the RNG contract.
type EdgeKind string

const (
	// EdgeRule is a feature rule's places_feature. Exactly one per rule.
	EdgeRule EdgeKind = "rule"
	// EdgeAggregate is one entry of an aggregate_feature's list.
	EdgeAggregate EdgeKind = "aggregate"
	// EdgeSequence is one entry of a sequence_feature's list. Ordinal is
	// load-bearing.
	EdgeSequence EdgeKind = "sequence"
	// EdgeWeighted is one entry of a weighted_random_feature. Weight is set.
	EdgeWeighted EdgeKind = "weighted"
	// EdgeConditional is one entry of a conditional_list. Condition is set
	// (absent in the JSON means the constant 1.0, i.e. always).
	EdgeConditional EdgeKind = "conditional"
	// EdgeScatter is a scatter_feature's places_feature. Iterations is set.
	EdgeScatter EdgeKind = "scatter"
	// EdgeFilter is the single child of a wrapping type that decides whether
	// and where to delegate: snap_to_surface, surface_relative_threshold,
	// height_difference_filter, scan_surface, search.
	EdgeFilter EdgeKind = "filter"
	// EdgeChild is a named single-child slot that is none of the above: the
	// parent neither filters nor scatters, it just has a feature in a field.
	// `vegetation_patch_feature.vegetation_feature` and `tree_feature`'s
	// `log_decoration_feature` are the two, and between them they account
	// for 5 of the 24 files in this repo's own vanilla-trees fixture -- so a
	// graph without this kind reports those 24 nodes with ZERO edges, which
	// is what the first build of it did.
	//
	// What such a child MEANS is type-specific and the kind does not try to
	// say: read the key in JSONPath, which is the only honest label.
	EdgeChild EdgeKind = "child"
)

// GraphEdge is one delegation from a node to a feature.
type GraphEdge struct {
	From string   `json:"from"`
	To   string   `json:"to"`
	Kind EdgeKind `json:"kind"`

	// JSONPath locates this edge inside From's file, so an editor can write
	// a change back to the right place and jump to it in the text editor.
	//
	// THE DIALECT IS `jsonc.FormatPath`'s, and producers must call it rather
	// than format their own. This is not style: an annotation reaches an edge
	// ONLY by string equality between this field and Annotation.JSONPath, so
	// two implementations that both look right -- one emitting
	// `conditional_features[0].places_feature`, the other
	// `$.conditional_features[0].places_feature` -- would silently never
	// match, and the failure would look like "annotations do not work"
	// rather than like a bug with a location. Both spellings were in fact
	// produced independently before this was pinned.
	JSONPath string `json:"jsonPath"`

	// Ordinal is the position in the parent's list, 0-based. Set for
	// aggregate, sequence, weighted and conditional. For sequence it decides
	// execution order and therefore the world; for the others it is only the
	// order the keys appear in the file.
	Ordinal int `json:"ordinal"`

	// Weight is a weighted_random entry's weight, nil when the file did not
	// write one. The object form of an entry defaults an absent weight to
	// 1.0, but that default is the engine's to apply, not this graph's: an
	// editor that rendered it as a written 1.0 would write it back into a
	// file that never had it, and turn opening a pack into a diff.
	Weight *float64 `json:"weight,omitempty"`

	// Condition is a conditional_list entry's Molang, as written. Absent in
	// the JSON means always-true, and that is represented here as a nil
	// Condition rather than a synthesised "1.0", so an editor can tell "the
	// author wrote no condition" from "the author wrote 1.0".
	Condition *string `json:"condition,omitempty"`

	// Iterations is a scatter's `iterations`, as written -- a number or a
	// Molang string, both legal.
	//
	// Worth knowing before building UI on it: `iterations` is a full Molang
	// expression evaluated against a scope SHARED with everything the
	// scatter delegates to, so real packs use it for two things beyond
	// counting. As a condition, by evaluating to 0 (the engine diagnoses
	// this specifically, distinct from a scatter_chance rejection). And as a
	// setup step, by assigning `variable.*` that the placed feature then
	// reads. Both are load-bearing idioms rather than abuses, and an editor
	// that models `iterations` as a spin-box will make them harder to write
	// than plain text does.
	Iterations *string `json:"iterations,omitempty"`

	// ConditionPath and IterationsPath locate the two Molang slots above, in
	// the same dialect as JSONPath.
	//
	// ADDITIVE AMENDMENT. Both were added after an editor tried to write a
	// Molang edit back and had nowhere correct to send it. The reason they
	// cannot be derived is the point:
	//
	// JSONPath names the `places_feature` the edge was READ from, not the
	// object the edge's own settings live in. The Molang sits BESIDE that
	// key, not under it, so the obvious `JSONPath + ".iterations"` addresses
	// a member of a string and would corrupt the file rather than fail.
	//
	// Iterations is worse, because a scatter accepts it in two mutually
	// exclusive places: nested under `distribution` at format_version
	// 1.21.10 and up, flat on the body below that. scatterDelegation reads
	// whichever the file actually used, so only the builder knows which one
	// is there -- an editor that picked by declared version would write a
	// second copy beside the first in any file whose shape and version
	// disagree, and both would then be live with one silently ignored.
	//
	// Set even when the slot is EMPTY, because that is exactly when an
	// editor needs to know where to create it: an absent condition means
	// always-true and an author adding one has to be told where it goes.
	// Empty string means this edge kind has no such slot at all.
	ConditionPath  string `json:"conditionPath,omitempty"`
	IterationsPath string `json:"iterationsPath,omitempty"`

	// Required marks an edge the type cannot load without, so removing it in
	// the editor is an error rather than an edit.
	Required bool `json:"required"`
}

// Annotation is an editor directive written in a JSON comment.
//
// The game's own parser accepts `//` and `/* */` comments (see package
// jsonc), so a directive in one is invisible to Minecraft and visible to
// this tool. That is the whole reason for the mechanism: it lets a pack
// carry editor state without carrying a key the engine would have to accept.
//
// The syntax is one directive per comment, `@featurelab:<name> <args>`:
//
//	// @featurelab:ignore inactive-branch
//	//   this branch is chunk-parity gated and is false at the preview origin
//	// @featurelab:origin 128 70 128
//	// @featurelab:idiom setup-script
//	// @featurelab:layout 340 120
//
// `ignore` is the one that earns the mechanism. A condition gated on chunk
// position is false at the default preview origin of 0,0,0 and would
// otherwise be reported as a dead branch on every open -- a warning that is
// wrong, unactionable, and therefore trained away. Suppressing it in the
// file, next to the thing it is about, is the difference between a warning
// people read and one they stop seeing.
type Annotation struct {
	// Name is the directive, without the `@featurelab:` prefix.
	Name string `json:"name"`
	// Args is everything after the name, whitespace-split.
	Args []string `json:"args,omitempty"`
	// Text is any following comment lines that are not themselves
	// directives -- the author's reason, kept so the editor can show it.
	Text string `json:"text,omitempty"`
	// JSONPath is the node or edge the comment sits on, in the dialect
	// `jsonc.FormatPath` produces -- see GraphEdge.JSONPath for why that is
	// pinned rather than left to each producer.
	JSONPath string `json:"jsonPath"`
	// Line is the 1-based line in File, for jumping to it.
	Line int `json:"line"`
	// Offset and EndOffset are the directive's byte span in the file, so it
	// can be REWRITTEN, not only displayed.
	//
	// Without them an editor can show `@featurelab:ignore` and has no way to
	// add, change or remove one -- which would make the annotation mechanism
	// read-only, and the "this is gated, not dead" action that suppresses a
	// false warning is exactly the thing a person needs to do FROM the
	// editor, at the moment the wrong warning appears.
	Offset    int `json:"offset"`
	EndOffset int `json:"endOffset"`
}
