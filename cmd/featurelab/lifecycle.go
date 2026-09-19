// lifecycle.go implements the two things an editor can do to a feature that
// are not edits to its body: "renameFeature" and "deleteFeature".
//
// They are here rather than beside applyEdits because neither is one file's
// business. A feature's identifier is written once in its own
// description.identifier and once more in EVERY file that delegates to it, and
// those files are exactly the ones the author is not looking at. An operation
// that changed only the file on screen would leave the pack referring to a
// name nothing defines -- which the editor would then draw as a dangling edge,
// honestly, and which nobody asked for.
//
// Three rules are inherited from applyEdits.go and not restated in each
// method:
//
//   - The WHOLE operation is validated before any of it is written. A rename
//     that got three files in and stopped is a pack in a state no author put
//     it in, and the only record of what was supposed to happen is the diff.
//   - Paths are checked by where they RESOLVE (resolveInPack), never by how
//     they are spelled.
//   - Files are rewritten through jsonc.Apply, so comments, key order and
//     indentation survive. A pack file's comments are not decoration.
//
// And one rule of their own: NOTHING IS REWRITTEN ON THE STRENGTH OF THE
// GRAPH ALONE. The graph says where a reference lives; the file on disk says
// what is actually there. Every path these methods touch is read back and the
// value at it is checked to still name the feature being renamed or deleted
// before a single byte is planned. The pack can change under an editor --
// another window saved, a branch was switched, the author hand-edited the
// JSON -- and the failure mode of trusting a stale path is not a visible error
// but a silently corrupted file, because a path that has stopped meaning what
// it meant usually still resolves to something.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/wire"
)

// ruleTypeID is the synthetic type wire/graph.go gives a feature rule's node.
// It is deliberately NOT the plural key a rules file is rooted at, and nothing
// here derives one from the other by string surgery: the key a file is
// actually rooted at is found by reading the file (see identifierPath).
const ruleTypeID = "minecraft:feature_rule"

// listKinds are the edge kinds whose delegation is one entry of an array, so
// detaching it means removing the ENTRY rather than the reference: a
// conditional entry stripped of its places_feature keeps a condition and has
// nothing left to place.
var listKinds = map[wire.EdgeKind]bool{
	wire.EdgeAggregate:   true,
	wire.EdgeSequence:    true,
	wire.EdgeWeighted:    true,
	wire.EdgeConditional: true,
}

// nonEmptyListKinds are the kinds whose array the engine refuses to load empty
// -- an aggregate's and a sequence's `features` (features/aggregate.go), and a
// weighted_random's (features/weighted_random.go). A conditional_list is
// deliberately absent: its `conditional_features` is required to be present
// and is accepted empty (features/conditional_list.go), so removing the last
// entry of one is an edit rather than a breakage.
var nonEmptyListKinds = map[wire.EdgeKind]bool{
	wire.EdgeAggregate: true,
	wire.EdgeSequence:  true,
	wire.EdgeWeighted:  true,
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

type renameFeatureParams struct {
	// From is the identifier as the graph reports it (wire.GraphNode.ID). It
	// is matched without regard to case, for the same reason the engine
	// matches it that way.
	From string `json:"from"`
	To   string `json:"to"`
}

type renameFeatureResult struct {
	From string `json:"from"`
	To   string `json:"to"`
	// File is the file that declares the feature, pack-relative. It is
	// reported and NOT renamed -- see methodRenameFeature.
	File string `json:"file"`
	// References is how many delegations elsewhere in the pack were rewritten
	// to the new name.
	References int      `json:"references"`
	Files      []string `json:"files"`
	// Notes are things that are true about what just happened and that the
	// author would otherwise have to discover from the game's log.
	Notes []string `json:"notes,omitempty"`
}

// methodRenameFeature renames one feature or feature rule, everywhere.
//
// WHAT IT WRITES: the identifier in the declaring file, and every delegation
// in the pack that resolves to it. Both halves or neither -- a rename that
// updated only the declaration would break every file that points at it, and
// one that updated only the references would break the pack the other way
// round.
//
// WHAT IT DOES NOT WRITE: the FILE NAME. `features/<name>.json` is the
// convention this tool follows when it creates a file, but it is only a
// convention -- a pack may name a feature file anything, and the engine reads
// the identifier out of the file rather than deriving anything from the name.
// Renaming the file would therefore be a second, different operation with its
// own failure modes: it invalidates whatever the author has open in an editor
// (unsaved buffers included), it moves a path that version control, a build
// script or another tool may be holding, and it cannot be undone by undoing an
// edit. So the file stays where it is and the result names it, which leaves
// renaming it a thing the author does deliberately if they want it.
//
// A feature RULE is the one case where that has a visible consequence, and it
// is reported as a note rather than acted on: the engine compares a rule's
// identifier against its own file name and logs when they differ (see
// rules/schema.go's identifier checks). The rule still loads and still runs --
// the check is a warning there and nothing is broken by it -- but an author
// who does not hear about it will meet it in the log later.
//
// CASE. The engine matches feature identifiers without regard to case (see
// features/registry.go), so two files whose identifiers differ only in case
// are ONE name: the first one loaded keeps it and the other is unreachable,
// however correct it is. Two things follow, and they pull in opposite
// directions:
//
//   - A collision is detected WITHOUT regard to case. Renaming to something
//     that differs only in case from another node's name is refused, because
//     the result would not be an error the pack reports -- it would be a
//     feature that silently stops being placed.
//   - A rename that differs only in case from the feature's OWN current name
//     is a legal, useful edit and is performed. It changes nothing about what
//     the pack generates, which is exactly why it is worth doing and worth
//     saying: an author fixing the spelling of a name wants the whole pack to
//     agree on it, and every reference is rewritten so that it does.
func methodRenameFeature(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p renameFeatureParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	from, to := strings.TrimSpace(p.From), strings.TrimSpace(p.To)
	if from == "" {
		return nil, fmt.Errorf("malformed params: \"from\" is required -- name the feature to rename")
	}
	if to == "" {
		return nil, fmt.Errorf("malformed params: \"to\" is required -- name what to rename it to")
	}
	if from == to {
		return nil, fmt.Errorf("renameFeature: %q is already its name; nothing to do", to)
	}
	if why := malformedIdentifierReason(to); why != "" {
		return nil, fmt.Errorf("renameFeature: %s", why)
	}

	graph, err := buildGraph(context.Background(), state.loaded)
	if err != nil {
		return nil, fmt.Errorf("renameFeature: reading the pack's graph: %v", err)
	}
	node, ok := findGraphNode(graph, from)
	if !ok {
		return nil, fmt.Errorf("renameFeature: no file in this pack declares %q", from)
	}
	if node.Unresolved {
		return nil, fmt.Errorf(
			"renameFeature: %q is a dangling reference -- something delegates to it and no file defines it, so there is no name to change. Fix the file that points at it instead",
			node.ID)
	}
	if node.File == "" {
		return nil, fmt.Errorf("renameFeature: %q does not report a file, so there is nothing to rewrite", node.ID)
	}

	// The collision check, and the one exception to it: an UNRESOLVED node
	// carrying the new name is not a file -- it is the pack already pointing
	// at a name nothing defines -- so renaming into it is allowed and adopts
	// those references. That is usually what the author meant (they are
	// repairing a broken reference), and it is never silent: it is noted.
	var notes []string
	adopted := 0
	for _, other := range graph.Nodes {
		if foldIdentifier(other.ID) != foldIdentifier(to) {
			continue
		}
		if foldIdentifier(other.ID) == foldIdentifier(node.ID) {
			continue // the node being renamed, reached under its new spelling
		}
		if other.Unresolved {
			for _, e := range graph.Edges {
				if e.To == other.ID {
					adopted++
				}
			}
			continue
		}
		return nil, collisionError(node, other, to)
	}
	if adopted > 0 {
		notes = append(notes, fmt.Sprintf(
			"%d delegation(s) in this pack already name %q and currently resolve to nothing; from now on they place this feature.",
			adopted, to))
	}

	files := newPackFileSet(state.loaded.Dir)

	// The declaration. The body key is read out of the file rather than
	// derived from the node's type, because for a rule those are two different
	// strings by design, and because a file that has been edited since the
	// graph was built may not have the key the graph expects at all.
	declaring, err := files.read(node.File)
	if err != nil {
		return nil, fmt.Errorf("renameFeature: %v", err)
	}
	idPath, ok := identifierPath(declaring.root, node.ID)
	if !ok {
		return nil, staleError(node.File, "it no longer declares "+quote(node.ID))
	}
	files.edit(declaring, jsonc.Edit{Path: idPath, Value: mustJSON(to)})

	// The references. Every one is read back before it is planned: the graph
	// says where a delegation lives, the file says whether it is still there.
	references := 0
	for _, e := range graph.Edges {
		if e.To != node.ID {
			continue
		}
		f, err := files.readReferrer(graph, e)
		if err != nil {
			return nil, fmt.Errorf("renameFeature: %v", err)
		}
		if err := checkReferenceAt(f, e.JSONPath, node.ID); err != nil {
			return nil, fmt.Errorf("renameFeature: %v", err)
		}
		files.edit(f, jsonc.Edit{Path: e.JSONPath, Value: mustJSON(to)})
		references++
	}

	if foldIdentifier(from) == foldIdentifier(to) {
		notes = append(notes, fmt.Sprintf(
			"%q and %q are the same name to the engine, which matches feature identifiers without regard to case. Nothing this pack generates changes; the files now spell the name one way.",
			from, to))
	}
	if node.TypeID == ruleTypeID {
		notes = append(notes, fmt.Sprintf(
			"%s still holds this rule. The engine compares a feature rule's identifier against its own file name and logs when the two differ -- the rule loads and runs either way; renaming the file silences it.",
			node.File))
	}

	written, err := files.commit()
	if err != nil {
		return nil, fmt.Errorf("renameFeature: %v", err)
	}
	if err := reloadWholePack(state); err != nil {
		return nil, fmt.Errorf("renameFeature: %v", err)
	}
	return renameFeatureResult{
		From: node.ID, To: to, File: node.File,
		References: references, Files: written, Notes: notes,
	}, nil
}

// collisionError is the refusal that stops a rename onto a name some other
// file already declares. The two shapes are worth separating: an exact clash
// is obvious to the author, and a clash that differs only in case looks like a
// free name until the game quietly drops one of the two files.
func collisionError(node, other wire.GraphNode, to string) error {
	where := ""
	if other.File != "" {
		where = ", declared by " + other.File
	}
	if other.ID == to {
		return fmt.Errorf("renameFeature: %q is already taken%s. Rename or remove that one first", to, where)
	}
	if other.TypeID == ruleTypeID && node.TypeID == ruleTypeID {
		return fmt.Errorf(
			"renameFeature: %q differs only in case from %q%s. Two feature rules named that way are two rules to the engine and one node to this editor, so the rename is refused rather than hiding one of them",
			to, other.ID, where)
	}
	return fmt.Errorf(
		"renameFeature: %q differs only in case from %q%s, and the engine matches feature identifiers without regard to case -- the two would be one name, the first one loaded would keep it, and the other would stop being placed without the pack reporting anything",
		to, other.ID, where)
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

type deleteFeatureParams struct {
	ID string `json:"id"`
	// DetachReferences also removes the delegations that point at the feature,
	// instead of refusing because they exist. Off by default: see
	// methodDeleteFeature.
	DetachReferences bool `json:"detachReferences"`
}

type deleteFeatureResult struct {
	ID string `json:"id"`
	// File is the file that was removed, pack-relative.
	File string `json:"file"`
	// Detached is how many delegations pointing at the feature were removed.
	Detached int `json:"detached"`
	// Files are the files that were edited to remove those delegations. The
	// removed file is File and is not repeated here.
	Files []string `json:"files"`
	// Orphaned names the features this one delegated to that nothing else
	// delegates to. They still exist; nothing places them any more.
	Orphaned []string `json:"orphaned,omitempty"`
	Notes    []string `json:"notes,omitempty"`
}

// methodDeleteFeature removes one feature or feature rule from the pack.
//
// A feature something delegates to cannot simply vanish: the delegation stays
// behind in a file the author was not looking at, resolving to nothing. So the
// default is to REFUSE while anything references it, and to name every
// referrer -- which feature, which file, which path -- so the refusal is a
// list of places to go rather than a "no".
//
// "Refuse" was chosen over the two alternatives deliberately:
//
//   - Deleting and reporting would be a broken pack plus a message. The
//     message is read once; the dangling references stay.
//   - Clearing the references silently would edit files the author never named
//     in an operation they asked about one file, which is the same surprise in
//     the other direction.
//
// So clearing IS offered -- `detachReferences` -- and it is a thing the caller
// asks for explicitly, having been told what it would touch. Even then it
// refuses rather than breaks: a delegation that the referring type cannot load
// without (wire.GraphEdge.Required), or one whose removal would empty an array
// the engine requires to be non-empty, stops the whole operation and names the
// file. Those are edits the author has to make with a decision in hand -- what
// should that parent place instead? -- and no default answer is better than
// guessing one.
//
// ORDER IS PART OF THE SAFETY. Every file is read, verified and transformed in
// memory before anything is written; then the references go; then the file.
// Each intermediate state is a pack that still loads: after the references are
// removed the feature is merely unreferenced, and if removing the file then
// fails, the pack has one orphan feature in it rather than a set of
// delegations pointing at nothing.
//
// A feature that delegates to ITSELF is not counted as a referrer: that
// reference lives in the file being removed and leaves with it.
func methodDeleteFeature(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p deleteFeatureParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	id := strings.TrimSpace(p.ID)
	if id == "" {
		return nil, fmt.Errorf("malformed params: \"id\" is required -- name the feature to delete")
	}

	graph, err := buildGraph(context.Background(), state.loaded)
	if err != nil {
		return nil, fmt.Errorf("deleteFeature: reading the pack's graph: %v", err)
	}
	node, ok := findGraphNode(graph, id)
	if !ok {
		return nil, fmt.Errorf("deleteFeature: no file in this pack declares %q", id)
	}
	if node.Unresolved {
		return nil, fmt.Errorf(
			"deleteFeature: %q is a dangling reference -- something delegates to it and no file defines it, so there is no file to remove. Fix the file that points at it instead",
			node.ID)
	}
	if node.File == "" {
		return nil, fmt.Errorf("deleteFeature: %q does not report a file, so there is nothing to remove", node.ID)
	}

	// The file has to still be the one that declares this feature. Removing a
	// file on the strength of a graph built before somebody else changed the
	// pack is how an editor deletes the wrong thing.
	files := newPackFileSet(state.loaded.Dir)
	declaring, err := files.read(node.File)
	if err != nil {
		return nil, fmt.Errorf("deleteFeature: %v", err)
	}
	if _, ok := identifierPath(declaring.root, node.ID); !ok {
		return nil, staleError(node.File, "it no longer declares "+quote(node.ID))
	}

	var inbound []wire.GraphEdge
	for _, e := range graph.Edges {
		if e.To == node.ID && e.From != node.ID {
			inbound = append(inbound, e)
		}
	}
	if len(inbound) > 0 && !p.DetachReferences {
		return nil, referencedError(graph, node, inbound)
	}

	// Detaching: plan every removal, refusing on the first one that cannot be
	// made without breaking the file it is in.
	perParent := map[string]int{}
	for _, e := range inbound {
		perParent[e.From+"\x00"+string(e.Kind)]++
	}
	outgoing := map[string]int{}
	for _, e := range graph.Edges {
		outgoing[e.From+"\x00"+string(e.Kind)]++
	}
	for _, e := range inbound {
		f, err := files.readReferrer(graph, e)
		if err != nil {
			return nil, fmt.Errorf("deleteFeature: %v", err)
		}
		if err := checkReferenceAt(f, e.JSONPath, node.ID); err != nil {
			return nil, fmt.Errorf("deleteFeature: %v", err)
		}
		if e.Required {
			return nil, fmt.Errorf(
				"deleteFeature: %s delegates to %q at %s and cannot load without it, so removing the delegation would stop that file loading. Point it somewhere else, or delete it too, then try again -- nothing was written",
				f.rel, node.ID, e.JSONPath)
		}
		key := e.From + "\x00" + string(e.Kind)
		if nonEmptyListKinds[e.Kind] && perParent[key] >= outgoing[key] {
			return nil, fmt.Errorf(
				"deleteFeature: every entry of %s's list in %s delegates to %q, and the engine refuses to load that list empty. Give it something else to place first -- nothing was written",
				e.From, f.rel, node.ID)
		}
		entry, err := detachPath(e)
		if err != nil {
			return nil, fmt.Errorf("deleteFeature: %v", err)
		}
		files.edit(f, jsonc.Edit{Path: entry, Delete: true})
	}

	// Everything this feature placed that nothing else does. Reported, not
	// acted on: an unreferenced feature is a legal pack and often the point of
	// the deletion, but it is not obvious from the one file that vanished.
	orphaned := orphanedBy(graph, node.ID)

	written, err := files.commit()
	if err != nil {
		return nil, fmt.Errorf("deleteFeature: %v", err)
	}
	// declaring.full, not a fresh resolveInPack: the path was resolved and
	// checked before any of this was planned, and re-deriving it here would
	// put a check that can refuse AFTER the references have been written.
	if err := os.Remove(declaring.full); err != nil {
		return nil, fmt.Errorf(
			"deleteFeature: removing %s: %v. The %d delegation(s) to %q were already removed, so the pack still loads and %q is now unreferenced",
			node.File, err, len(inbound), node.ID, node.ID)
	}
	if err := reloadWholePack(state); err != nil {
		return nil, fmt.Errorf("deleteFeature: %v", err)
	}

	var notes []string
	if len(orphaned) > 0 {
		notes = append(notes, fmt.Sprintf(
			"%d feature(s) it placed are now referenced by nothing and will not be generated until something points at them.",
			len(orphaned)))
	}
	return deleteFeatureResult{
		ID: node.ID, File: node.File, Detached: len(inbound),
		Files: written, Orphaned: orphaned, Notes: notes,
	}, nil
}

// referencedError is the default refusal, and it is the whole product of this
// method most of the time -- so it names the referrers rather than counting
// them. Capped, because a feature with sixty referrers produces a message
// nobody reads; the count is still exact.
func referencedError(graph *wire.Graph, node wire.GraphNode, inbound []wire.GraphEdge) error {
	const show = 6
	var lines []string
	for i, e := range inbound {
		if i == show {
			lines = append(lines, fmt.Sprintf("and %d more", len(inbound)-show))
			break
		}
		where := e.From
		if f, ok := findGraphNode(graph, e.From); ok && f.File != "" {
			where = fmt.Sprintf("%s (%s at %s)", e.From, f.File, e.JSONPath)
		}
		lines = append(lines, where)
	}
	return fmt.Errorf(
		"deleteFeature: %d thing(s) in this pack delegate to %q: %s. Deleting it would leave those references pointing at nothing, in files you are not looking at. Retarget them, or pass detachReferences to remove them along with the feature -- nothing was written",
		len(inbound), node.ID, strings.Join(lines, ", "))
}

// detachPath turns an edge into the path whose removal takes the whole
// delegation with it.
//
// For a list kind that is the ENTRY, not the reference: a conditional entry
// without its places_feature still has a condition and nothing to place, and a
// weighted entry without its reference still has a weight. The shapes are the
// ones wire/graphbuild.go emits, and each is cross-checked against the edge's
// own Ordinal before being trusted -- a path whose list index disagrees with
// the ordinal it is supposed to be addresses a different entry, and removing
// the wrong entry is exactly the silent corruption this file exists to avoid.
//
// For a single-slot kind there is no entry and the key itself goes. Only a
// slot the type can load without ever reaches here; the required ones are
// refused by the caller, which can say which file would stop loading.
func detachPath(e wire.GraphEdge) (string, error) {
	segs, err := jsonc.ParsePath(e.JSONPath)
	if err != nil || len(segs) == 0 {
		return "", fmt.Errorf("the %s delegation %s -> %s reports the path %q, which cannot be read; nothing was written",
			e.Kind, e.From, e.To, e.JSONPath)
	}
	if !listKinds[e.Kind] {
		return e.JSONPath, nil
	}
	last := segs[len(segs)-1]
	var prev *jsonc.PathSegment
	if len(segs) >= 2 {
		prev = &segs[len(segs)-2]
	}
	shapeErr := fmt.Errorf(
		"the %s delegation %s -> %s reports the path %q, which is not the shape that kind has (its list index does not match the delegation's position). Removing it would edit a different entry, so nothing was written",
		e.Kind, e.From, e.To, e.JSONPath)

	switch e.Kind {
	case wire.EdgeAggregate, wire.EdgeSequence:
		// A bare array of reference strings: the element IS the entry.
		if !last.IsIndex || last.Index != e.Ordinal {
			return "", shapeErr
		}
		return e.JSONPath, nil
	case wire.EdgeConditional:
		// `conditional_features[i].places_feature`.
		if last.IsIndex || prev == nil || !prev.IsIndex || prev.Index != e.Ordinal {
			return "", shapeErr
		}
		return jsonc.FormatPath(segs[:len(segs)-1]), nil
	case wire.EdgeWeighted:
		// Either the tuple's first slot (`features[i][0]`) or the object
		// form's key (`features[i].feature`). Both sit one level inside the
		// entry, and the entry is what goes.
		if prev == nil || !prev.IsIndex || prev.Index != e.Ordinal {
			return "", shapeErr
		}
		return jsonc.FormatPath(segs[:len(segs)-1]), nil
	}
	return "", shapeErr
}

// orphanedBy is every feature the named node delegates to that nothing else
// delegates to, sorted. Computed before the edits, from the graph, because
// afterwards the edges are gone.
func orphanedBy(graph *wire.Graph, id string) []string {
	inboundElsewhere := map[string]int{}
	for _, e := range graph.Edges {
		if e.From != id {
			inboundElsewhere[e.To]++
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, e := range graph.Edges {
		if e.From != id || e.To == id || seen[e.To] {
			continue
		}
		if inboundElsewhere[e.To] == 0 {
			seen[e.To] = true
			out = append(out, e.To)
		}
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------
// shared machinery
// ---------------------------------------------------------------------------

// packFile is one pack file being changed: the bytes that were verified, the
// decoded copy the verification read, and the edits planned against those
// exact bytes.
type packFile struct {
	rel   string
	full  string
	src   []byte
	root  any
	edits []jsonc.Edit
}

// packFileSet collects the files one operation touches, so a file named twice
// -- a feature that references itself, or a parent holding two delegations to
// the same child -- is read once and written once. Two jsonc.Apply calls on
// one file would resolve the second batch's spans against bytes the first had
// already moved.
type packFileSet struct {
	dir   string
	byRel map[string]*packFile
	order []*packFile
}

func newPackFileSet(dir string) *packFileSet {
	return &packFileSet{dir: dir, byRel: map[string]*packFile{}}
}

func (s *packFileSet) read(rel string) (*packFile, error) {
	if f, ok := s.byRel[rel]; ok {
		return f, nil
	}
	full, err := resolveInPack(s.dir, rel)
	if err != nil {
		return nil, err
	}
	src, err := os.ReadFile(full)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %v", rel, err)
	}
	var root any
	if err := json.Unmarshal(jsonc.StripComments(src), &root); err != nil {
		return nil, fmt.Errorf("%s is not readable as JSON (%v), so nothing can be rewritten in it safely", rel, err)
	}
	f := &packFile{rel: rel, full: full, src: src, root: root}
	s.byRel[rel] = f
	s.order = append(s.order, f)
	return f, nil
}

// readReferrer is read() for the file an edge leaves FROM, with the two
// reasons that file might not be usable turned into sentences about the
// delegation rather than about a path.
func (s *packFileSet) readReferrer(graph *wire.Graph, e wire.GraphEdge) (*packFile, error) {
	from, ok := findGraphNode(graph, e.From)
	if !ok || from.File == "" {
		return nil, fmt.Errorf("%q delegates to %q and does not report a file, so that delegation cannot be rewritten; nothing was written", e.From, e.To)
	}
	return s.read(from.File)
}

func (s *packFileSet) edit(f *packFile, e jsonc.Edit) { f.edits = append(f.edits, e) }

// commit applies every file's edits and writes the ones that changed, and is
// the single point where this file stops planning and starts writing.
//
// Every transformation is computed BEFORE any file is written, so a batch that
// jsonc.Apply refuses -- two removals whose spans meet, most plausibly -- fails
// with nothing on disk touched. What remains after that is the filesystem
// itself refusing, and the honest thing then is to say which files did land
// rather than to attempt an unwind that could fail the same way.
func (s *packFileSet) commit() ([]string, error) {
	type output struct {
		f   *packFile
		out []byte
	}
	var planned []output
	for _, f := range s.order {
		if len(f.edits) == 0 {
			continue
		}
		out, err := jsonc.Apply(f.src, f.edits...)
		if err != nil {
			return nil, fmt.Errorf(
				"%s cannot take all of these changes at once (%v). Nothing was written; make one of them by hand and try again",
				f.rel, err)
		}
		if string(out) == string(f.src) {
			continue
		}
		planned = append(planned, output{f: f, out: out})
	}
	written := make([]string, 0, len(planned))
	for _, p := range planned {
		if err := os.WriteFile(p.f.full, p.out, 0o644); err != nil {
			return nil, fmt.Errorf("writing %s: %v (wrote %v first)", p.f.rel, err, written)
		}
		written = append(written, p.f.rel)
	}
	sort.Strings(written)
	return written, nil
}

// reloadWholePack re-reads the pack, rather than splicing the changed files
// in. Both of these operations change which identifiers exist, and one of them
// removes a file outright -- only the loader's own walk sees that.
func reloadWholePack(state *serverState) error {
	reloaded, err := pack.Load(state.loadOpts)
	if err != nil {
		return fmt.Errorf("re-reading the pack: %v", err)
	}
	state.loaded = reloaded
	state.workspace.Update(reloaded.Features, reloaded.Structures, reloaded.Rules, reloaded.Biomes, reloaded.Blocks)
	return nil
}

// checkReferenceAt is the verification both methods run before planning
// anything: the file, right now, holds a string at this path naming this
// feature.
//
// Matching without regard to case is not laxity -- a delegation written in
// another case resolves in game (features/registry.go), so it really is a
// reference to this feature and really does have to be rewritten with it.
func checkReferenceAt(f *packFile, path, id string) error {
	value, err := valueAt(f.root, path)
	if err != nil {
		return staleError(f.rel, fmt.Sprintf("%s is no longer there (%v)", path, err))
	}
	s, ok := value.(string)
	if !ok {
		return staleError(f.rel, fmt.Sprintf("%s no longer holds a feature reference", path))
	}
	if foldIdentifier(s) != foldIdentifier(id) {
		return staleError(f.rel, fmt.Sprintf("%s now names %s rather than %s", path, quote(s), quote(id)))
	}
	return nil
}

// staleError is the one answer for every "the file does not say what the graph
// said it says". It is worth having in one voice: the author has done nothing
// wrong, the view is simply older than the pack, and the fix is always the
// same.
func staleError(rel, what string) error {
	return fmt.Errorf("%s has changed since this view of the pack was built -- %s. Reload the pack and try again; nothing was written", rel, what)
}

// identifierPath finds where a file declares the given identifier, and is how
// both methods avoid guessing which key a file's body sits under. A feature
// file is rooted at its type key and a rule file at the rules collection key,
// and a file may have been edited into a different type since the graph was
// built -- so the file is searched for the identifier rather than addressed
// from the outside.
func identifierPath(root any, id string) (string, bool) {
	obj, ok := root.(map[string]any)
	if !ok {
		return "", false
	}
	for key, value := range obj {
		if key == "format_version" {
			continue
		}
		body, ok := value.(map[string]any)
		if !ok {
			continue
		}
		description, ok := body["description"].(map[string]any)
		if !ok {
			continue
		}
		declared, ok := description["identifier"].(string)
		if !ok || foldIdentifier(declared) != foldIdentifier(id) {
			continue
		}
		return jsonc.FormatPath([]jsonc.PathSegment{
			{Key: key}, {Key: "description"}, {Key: "identifier"},
		}), true
	}
	return "", false
}

// valueAt walks a decoded document to the value one of jsonc's textual paths
// names. The path is parsed rather than split, because a pack may legally name
// a member "a.b" and splitting on '.' would address something else.
func valueAt(root any, path string) (any, error) {
	segs, err := jsonc.ParsePath(path)
	if err != nil {
		return nil, err
	}
	current := root
	for i, s := range segs {
		if s.IsIndex {
			list, ok := current.([]any)
			if !ok {
				return nil, fmt.Errorf("%s is not an array", jsonc.FormatPath(segs[:i]))
			}
			if s.Index < 0 || s.Index >= len(list) {
				return nil, fmt.Errorf("%s does not exist", jsonc.FormatPath(segs[:i+1]))
			}
			current = list[s.Index]
			continue
		}
		obj, ok := current.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s is not an object", jsonc.FormatPath(segs[:i]))
		}
		value, ok := obj[s.Key]
		if !ok {
			return nil, fmt.Errorf("%s does not exist", jsonc.FormatPath(segs[:i+1]))
		}
		current = value
	}
	return current, nil
}

// findGraphNode resolves an identifier to its node without regard to case,
// matching how the engine resolves one. An editor that had the name from a
// file written in another case would otherwise be told the pack does not
// define a feature it plainly does.
func findGraphNode(graph *wire.Graph, id string) (wire.GraphNode, bool) {
	key := foldIdentifier(id)
	for _, n := range graph.Nodes {
		if n.ID == id {
			return n, true
		}
	}
	for _, n := range graph.Nodes {
		if foldIdentifier(n.ID) == key {
			return n, true
		}
	}
	return wire.GraphNode{}, false
}

// foldIdentifier folds an identifier the way the engine's own feature registry
// does (see features/registry.go): ASCII only, because identifiers are
// namespace:name pairs and Unicode folding would invent cases the engine does
// not have.
func foldIdentifier(identifier string) string {
	out := []byte(identifier)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + ('a' - 'A')
		}
	}
	return string(out)
}

// malformedIdentifierReason refuses a new name this tool can say is wrong, and
// nothing more. It checks the shape every reference in the format relies on --
// one colon, both halves present, no whitespace -- and deliberately invents no
// character class: a validator that refuses a name the game accepts is one an
// author cannot work around from inside the editor.
func malformedIdentifierReason(id string) string {
	colon := strings.Index(id, ":")
	if colon < 0 {
		return fmt.Sprintf("%s has no namespace. Feature identifiers are \"namespace:name\" -- for instance \"example:oak\" -- and a bare name resolves against nothing", quote(id))
	}
	if colon == 0 || colon == len(id)-1 {
		return fmt.Sprintf("%s has an empty half; feature identifiers are \"namespace:name\"", quote(id))
	}
	if strings.Index(id[colon+1:], ":") >= 0 {
		return fmt.Sprintf("%s has more than one \":\"", quote(id))
	}
	if strings.ContainsAny(id, " \t\r\n") {
		return fmt.Sprintf("%s contains whitespace", quote(id))
	}
	return ""
}

func quote(s string) string { return "\"" + s + "\"" }

// mustJSON encodes a value that cannot fail to encode -- every caller passes a
// string -- so the one write path stays free of an error branch that can never
// be taken.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("encoding %v: %v", v, err))
	}
	return b
}
