package jsonc

import (
	"fmt"
	"sort"
)

// This file is the read-only half of what the span scanner already knows: where a named value
// sits, and which keys were written twice.
//
// Both exist for the same reason ErrorPosition does. A diagnostic that names only a FILE makes a
// person open it and search; a diagnostic that names a line and a column puts an editor's caret
// on the problem. encoding/json hands out a position for the two failures it can see -- malformed
// JSON, and a value whose type does not fit the Go type it was being decoded into -- and every
// loader in this repo now reports it. The failures encoding/json CANNOT see got nothing:
//
//   - "this key must be an object" is a check a loader makes for itself after decoding into
//     map[string]any, where nothing ever has a wrong type as far as encoding/json is concerned.
//     The position is not unknowable, it was simply never asked for. PathPosition asks.
//
//   - A duplicate key is not an error to encoding/json at all: last one wins, silently, and the
//     copy the author is editing may be the one being thrown away. jsoncpp -- the game's own
//     parser -- does the same, so this is not a file the game would refuse; it is a file that
//     does something other than what it looks like it does, which is worse. The scanner has
//     always known (see node.lastMember, where the last-wins rule is implemented); it had no way
//     to say so. DuplicateKeys is that way.

// PathPosition returns where the value at path begins in src -- the first byte of the value
// itself, not of the key in front of it, because that is where an editor's caret belongs for
// "this value is the wrong shape".
//
// ok is false when the document does not parse, when path is not a valid path, or when nothing
// in the document is at that path. A caller reporting a missing key therefore asks for the
// PARENT's position, which is what it wants anyway: the place the key should have been written
// is inside the object that should have held it.
//
// src must be the same bytes the caller decoded -- the StripComments output is fine and is what
// callers use, since it preserves every offset (see StripComments).
func PathPosition(src []byte, path string) (Position, bool) {
	segs, err := ParsePath(path)
	if err != nil {
		return Position{}, false
	}
	root, err := scanDocument(src)
	if err != nil {
		return Position{}, false
	}
	loc, err := locate(root, segs)
	if err != nil || loc.node == nil {
		return Position{}, false
	}
	return OffsetPosition(src, int64(loc.node.start)), true
}

// FirstPathPosition is PathPosition over several candidate paths, answering for the first one
// that exists.
//
// It is the shape every caller actually needs and the reason it is here rather than repeated at
// each of them: a loader complaining that `description.identifier` is missing wants to point at
// `description` when the identifier is not there, and at the body when the description is not
// there either. Written out at the call site that is a three-deep if/else chain per diagnostic,
// and the version of it that gets written the second time is the one that forgets a fallback.
func FirstPathPosition(src []byte, paths ...string) (Position, bool) {
	for _, p := range paths {
		if pos, ok := PathPosition(src, p); ok {
			return pos, true
		}
	}
	return Position{}, false
}

// Duplicate is one object key written more than once in the same object.
//
// Path names the member, in FormatPath's dialect -- so `$.minecraft:feature_rules.description`,
// the thing the author reads, rather than the object that contains it.
//
// First is the occurrence that is thrown away and Last is the one that survives. BOTH are
// reported because neither alone is actionable: a person told only where the winner is does not
// know what it overrode, and a person told only where the loser is does not know what is
// overriding it. Which of the two an editor puts its squiggle on is the editor's decision -- the
// loser is usually the interesting one, because it is the edit that did nothing.
type Duplicate struct {
	Path  string
	Key   string
	First Position
	Last  Position
}

// DuplicateKeys reports every key written more than once inside the same object, anywhere in the
// document, in document order.
//
// It returns nothing (and no error) for a document that does not parse: a file with a syntax
// error is already being reported as a syntax error, and a duplicate-key finding scraped out of
// a half-parsed document would be a second, less certain message about the same broken file.
//
// A key repeated three times produces ONE Duplicate, spanning the first and last occurrence,
// rather than two. The finding is "this key is written more than once", and saying it twice for
// one key is how a diagnostic list stops being read.
//
// COST, because a caller running this per file over a whole pack deserves the number rather than
// a promise: it re-parses the document through this package's span scanner, which is about the
// same work again as the json.Unmarshal the loader has already done on the same bytes (see
// BenchmarkDuplicateKeys next to BenchmarkUnmarshal -- 79us against 76us on a real vanilla tree
// file). End to end that is roughly a sixth added to a cold load of a 12.5k-file pack, and
// nothing at all on the single-file reload the edit-save loop uses. It is a deliberate trade for
// a bug class that is otherwise completely silent -- the file loads, the pack works, and the
// value the author is editing is the one being thrown away.
func DuplicateKeys(src []byte) []Duplicate {
	root, err := scanDocument(src)
	if err != nil {
		return nil
	}
	var out []Duplicate
	var walk func(n *node, segs []PathSegment)
	walk = func(n *node, segs []PathSegment) {
		switch n.kind {
		case kindObject:
			// first[key] is the index of the key's first occurrence; a key seen once never
			// allocates anything beyond this map entry, which is the common case for every
			// object in every file.
			first := make(map[string]int, len(n.members))
			var repeated []string
			for i, m := range n.members {
				if _, seen := first[m.key]; seen {
					if !containsKey(repeated, m.key) {
						repeated = append(repeated, m.key)
					}
					continue
				}
				first[m.key] = i
			}
			for _, key := range repeated {
				lastIdx := n.lastMember(key)
				firstIdx := first[key]
				out = append(out, Duplicate{
					Path:  FormatPath(child(segs, PathSegment{Key: key})),
					Key:   key,
					First: OffsetPosition(src, int64(n.members[firstIdx].keyStart)),
					Last:  OffsetPosition(src, int64(n.members[lastIdx].keyStart)),
				})
			}
			for _, m := range n.members {
				walk(m.value, child(segs, PathSegment{Key: m.key}))
			}
		case kindArray:
			for i, e := range n.elems {
				walk(e, child(segs, PathSegment{Index: i, IsIndex: true}))
			}
		}
	}
	walk(root, nil)
	// Document order, by where the losing occurrence sits: a reader works down the file, and a
	// findings list that jumped around inside it would be read as two separate problems.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].First.Line != out[j].First.Line {
			return out[i].First.Line < out[j].First.Line
		}
		return out[i].First.Column < out[j].First.Column
	})
	return out
}

// child extends a path by one segment onto a FRESH slice. Plain append would be a bug rather
// than an optimisation here: the walk holds one path per level and appends to it once per child,
// so two siblings would share a backing array and the second would overwrite the first's last
// segment -- producing a correct-looking path that names the wrong member.
func child(segs []PathSegment, seg PathSegment) []PathSegment {
	out := make([]PathSegment, len(segs), len(segs)+1)
	copy(out, segs)
	return append(out, seg)
}

func containsKey(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// DuplicateKeyMessage is the one sentence every loader uses for a Duplicate, so a feature file, a
// rule file and a biome file all report it the same way -- the same reason InvalidJSONMessage
// exists.
//
// It is a WARNING everywhere it is raised, not an error, and the wording carries why: the game
// loads this file. jsoncpp keeps the last occurrence exactly as encoding/json does, so the pack
// works; what it does not do is match the file, and the author editing the copy that lost has no
// way to find that out other than by being told.
func DuplicateKeyMessage(d Duplicate) string {
	return fmt.Sprintf("%s is written twice, at line %d and again at line %d -- the game keeps the last one, "+
		"so the earlier one has no effect", d.Path, d.First.Line, d.Last.Line)
}
