package jsonc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// This file is the span-preserving half of the package: a scanner that records where every value
// in a JSONC document begins and ends, and an Apply that rewrites only the spans a caller named.
//
// Why not decode to map[string]any and re-encode? Because that loses every byte the decoder does
// not model: comments (the entire point of this package), key order, indentation width and
// character, whether a small object was written on one line, CRLF, and whether the file ends in a
// newline. A round trip through encoding/json therefore turns a one-key edit into a whole-file
// diff. These are hand-edited files kept in version control; an editor whose first save rewrites
// every line gets turned off after that save. So: parse to spans, splice bytes, and let every byte
// the caller did not name survive untouched by construction rather than by effort.
//
// The scanner deliberately accepts exactly what StripComments + encoding/json accept -- the two
// comment forms real vanilla files use, and no trailing comma -- so a file this package can read
// is a file the game can read, and vice versa.

// SyntaxError reports a structural problem in a JSONC document. It carries a byte Offset into the
// original, unmodified source and a 1-based Line/Column, because an editor needs a cursor
// position and the human reading its error message needs a place to look.
//
// Column was not here at first, and its absence was a hole rather than a simplification. The
// errors this type reports are the ones THIS package's scanner finds rather than encoding/json --
// most of them a trailing comma, which is the one syntax error real pack files actually contain,
// because jsoncpp rejects it and every other JSON dialect a pack author has used accepts it. A
// trailing comma is one character on a line that is otherwise fine, so "line 214" points at a
// line whose problem is invisible, while the invalid-JSON diagnostic beside it (see
// InvalidJSONMessage, which goes through encoding/json and therefore through ErrorPosition)
// already pointed at a line AND a column. Two reports of the same class of problem, one of them
// half as precise, for no reason but which parser happened to find it.
//
// Position() is what the two now share: the same code-point column, over the same CRLF handling,
// as OffsetPosition.
type SyntaxError struct {
	Msg    string
	Offset int
	Line   int
	Column int
}

// Position is where in the document the error is, in the shape the rest of this package reports
// positions in.
func (e *SyntaxError) Position() Position {
	return Position{Line: e.Line, Column: e.Column}
}

func (e *SyntaxError) Error() string {
	return fmt.Sprintf("jsonc: %s at line %d, column %d (byte offset %d)", e.Msg, e.Line, e.Column, e.Offset)
}

// PathSegment is one step of a document path: an object member Key, or an array element Index
// when IsIndex is true. Callers building a path for an arbitrary key should go through
// FormatPath rather than concatenating strings, because a key may legally contain the characters
// the textual form uses as delimiters.
type PathSegment struct {
	Key     string
	Index   int
	IsIndex bool
}

// FormatPath renders segments as the textual path used by Annotation.JSONPath and Edit.Path.
//
// The dialect is the familiar dotted one: "$" is the document root, ".key" is an object member,
// "[0]" is an array element, and a key that would be ambiguous in the bare form -- empty, or
// containing whitespace, '.', '[', ']', '"' or '\' -- is written as a JSON string literal in
// brackets, e.g. `$["a.b"]`. Bedrock's pervasive "minecraft:foo" keys need no quoting, which is
// why ':' is not a delimiter. Non-ASCII bytes stay bare too, so a UTF-8 key survives readably.
func FormatPath(segs []PathSegment) string {
	var b strings.Builder
	b.WriteByte('$')
	for _, s := range segs {
		switch {
		case s.IsIndex:
			b.WriteByte('[')
			b.WriteString(strconv.Itoa(s.Index))
			b.WriteByte(']')
		case isBareKey(s.Key):
			b.WriteByte('.')
			b.WriteString(s.Key)
		default:
			q, _ := json.Marshal(s.Key)
			b.WriteByte('[')
			b.Write(q)
			b.WriteByte(']')
		}
	}
	return b.String()
}

// ParsePath is the inverse of FormatPath. ParsePath(FormatPath(s)) equals s for every s.
func ParsePath(p string) ([]PathSegment, error) {
	if p == "" || p[0] != '$' {
		return nil, fmt.Errorf("jsonc: path %q must start with %q", p, "$")
	}
	var segs []PathSegment
	for i := 1; i < len(p); {
		switch p[i] {
		case '.':
			i++
			j := i
			for j < len(p) && isBareByte(p[j]) {
				j++
			}
			if j == i {
				return nil, fmt.Errorf("jsonc: path %q has an empty key at offset %d", p, i)
			}
			segs = append(segs, PathSegment{Key: p[i:j]})
			i = j
		case '[':
			i++
			if i < len(p) && p[i] == '"' {
				j := i + 1
				for j < len(p) && p[j] != '"' {
					if p[j] == '\\' {
						j++
					}
					j++
				}
				if j >= len(p) {
					return nil, fmt.Errorf("jsonc: path %q has an unterminated quoted key", p)
				}
				var key string
				if err := json.Unmarshal([]byte(p[i:j+1]), &key); err != nil {
					return nil, fmt.Errorf("jsonc: path %q has a malformed quoted key: %w", p, err)
				}
				if j+1 >= len(p) || p[j+1] != ']' {
					return nil, fmt.Errorf("jsonc: path %q is missing %q after a quoted key", p, "]")
				}
				segs = append(segs, PathSegment{Key: key})
				i = j + 2
				continue
			}
			j := i
			for j < len(p) && p[j] >= '0' && p[j] <= '9' {
				j++
			}
			if j == i {
				return nil, fmt.Errorf("jsonc: path %q has a non-numeric index at offset %d", p, i)
			}
			n, err := strconv.Atoi(p[i:j])
			if err != nil {
				return nil, fmt.Errorf("jsonc: path %q has an unusable index: %w", p, err)
			}
			if j >= len(p) || p[j] != ']' {
				return nil, fmt.Errorf("jsonc: path %q is missing %q after an index", p, "]")
			}
			segs = append(segs, PathSegment{Index: n, IsIndex: true})
			i = j + 1
		default:
			return nil, fmt.Errorf("jsonc: path %q has an unexpected %q at offset %d", p, p[i], i)
		}
	}
	return segs, nil
}

func isBareKey(k string) bool {
	if k == "" {
		return false
	}
	for i := 0; i < len(k); i++ {
		if !isBareByte(k[i]) {
			return false
		}
	}
	return true
}

func isBareByte(c byte) bool {
	switch c {
	case '.', '[', ']', '"', '\\', 0x7f:
		return false
	}
	return c > ' '
}

// Edit is one change to one path.
//
// Value is raw JSON (comments allowed -- an editor may want to write an annotation alongside the
// value it describes) and is inserted as given, with only its continuation lines re-indented to
// the column the value lands in. Delete removes the member or element entirely, along with the
// one comma that joined it to its siblings.
//
// An Edit whose path does not exist inserts, but only one level deep: the parent container must
// exist, and for an array the index must be exactly len (an append). Creating intermediate
// containers is deliberately not supported, because guessing whether a missing "$.a.b" wants an
// object or an array is exactly the kind of guess that silently produces a file the game rejects.
type Edit struct {
	Path   string
	Value  []byte
	Delete bool
}

// Apply returns src with each Edit applied, and is byte-identical to src when given no edits.
//
// Every edit's target span is resolved against the ORIGINAL bytes before any splicing, so edits
// never see each other's output and their order in the argument list does not change the result.
// Two edits whose spans overlap are an error rather than a last-one-wins race; two insertions
// into the same container are fine and land in argument order.
//
// A path naming a key that appears twice in one object resolves to the LAST occurrence, which is
// the one a parser (the game's and Go's alike) actually keeps. Editing the copy that has no
// effect on the world would be worse than the alternative.
//
// Replacing a value replaces everything inside it, comments included -- the caller asked for those
// bytes to become different bytes. Everything outside the named span, including a comment on the
// same line, is left exactly as it was. Paths use the dialect FormatPath produces, which is also
// what Annotation.JSONPath reports, so an annotation can be edited where it was found.
func Apply(src []byte, edits ...Edit) ([]byte, error) {
	root, err := scanDocument(src)
	if err != nil {
		return nil, err
	}
	st := styleOf(src)

	patches := make([]patch, 0, len(edits))
	for i, e := range edits {
		p, err := planEdit(src, root, st, e)
		if err != nil {
			return nil, fmt.Errorf("jsonc: edit %d (%s): %w", i, e.Path, err)
		}
		p.order = i
		patches = append(patches, p)
	}
	sort.SliceStable(patches, func(i, j int) bool {
		if patches[i].start != patches[j].start {
			return patches[i].start < patches[j].start
		}
		return patches[i].order < patches[j].order
	})
	for i := 1; i < len(patches); i++ {
		if patches[i].start < patches[i-1].end {
			return nil, fmt.Errorf("jsonc: edits %d and %d touch overlapping regions of the document",
				patches[i-1].order, patches[i].order)
		}
	}

	out := make([]byte, 0, len(src)+64*len(patches))
	prev := 0
	for _, p := range patches {
		out = append(out, src[prev:p.start]...)
		out = append(out, p.text...)
		prev = p.end
	}
	return append(out, src[prev:]...), nil
}

// WriteFile applies edits to the file at name and writes it back through a temporary file in the
// same directory, so a crash mid-write cannot leave a half-written pack file behind. A no-op edit
// set does not touch the file at all: rewriting identical bytes would still move the mtime, and
// something is always watching these files.
func WriteFile(name string, edits ...Edit) error {
	src, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	out, err := Apply(src, edits...)
	if err != nil {
		return err
	}
	if bytes.Equal(src, out) {
		return nil
	}

	mode := fs.FileMode(0o644)
	if fi, err := os.Stat(name); err == nil {
		mode = fi.Mode().Perm()
	}
	dir := filepath.Dir(name)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(name)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	return os.Rename(tmpName, name)
}

type patch struct {
	start, end int
	text       []byte
	order      int
}

func planEdit(src []byte, root *node, st style, e Edit) (patch, error) {
	segs, err := ParsePath(e.Path)
	if err != nil {
		return patch{}, err
	}
	loc, err := locate(root, segs)
	if err != nil {
		return patch{}, err
	}

	if e.Delete {
		if loc.node == nil {
			return patch{}, fmt.Errorf("path does not exist")
		}
		if loc.parent == nil {
			return patch{}, fmt.Errorf("the root value cannot be deleted")
		}
		s, en := deleteSpan(src, loc.parent, loc.index)
		return patch{start: s, end: en}, nil
	}

	val, err := normalizeValue(e.Value)
	if err != nil {
		return patch{}, err
	}

	if loc.node != nil {
		indent := lineIndentAt(src, loc.node.start)
		return patch{start: loc.node.start, end: loc.node.end, text: reindent(val, indent, st.eol)}, nil
	}
	return planInsert(src, st, loc, val)
}

// location is the result of walking a path: the value it names when it exists, plus enough about
// its container to insert or delete it when it does not.
type location struct {
	node   *node
	parent *node
	index  int
	seg    PathSegment
}

func locate(root *node, segs []PathSegment) (location, error) {
	cur := root
	for i, s := range segs {
		last := i == len(segs)-1
		switch {
		case s.IsIndex:
			if cur.kind != kindArray {
				return location{}, fmt.Errorf("%s is not an array", FormatPath(segs[:i]))
			}
			if s.Index < 0 || s.Index >= len(cur.elems) {
				if last {
					return location{parent: cur, index: -1, seg: s}, nil
				}
				return location{}, fmt.Errorf("%s does not exist", FormatPath(segs[:i+1]))
			}
			if last {
				return location{node: cur.elems[s.Index], parent: cur, index: s.Index, seg: s}, nil
			}
			cur = cur.elems[s.Index]
		default:
			if cur.kind != kindObject {
				return location{}, fmt.Errorf("%s is not an object", FormatPath(segs[:i]))
			}
			idx := cur.lastMember(s.Key)
			if idx < 0 {
				if last {
					return location{parent: cur, index: -1, seg: s}, nil
				}
				return location{}, fmt.Errorf("%s does not exist", FormatPath(segs[:i+1]))
			}
			if last {
				return location{node: cur.members[idx].value, parent: cur, index: idx, seg: s}, nil
			}
			cur = cur.members[idx].value
		}
	}
	return location{node: cur}, nil
}

// planInsert adds a member or element that does not exist yet, matching the surrounding layout:
// a container already written across several lines gets the new entry on its own line at the
// indentation its siblings use, and one written on a single line stays on one line.
func planInsert(src []byte, st style, loc location, val []byte) (patch, error) {
	parent := loc.parent
	if parent == nil {
		return patch{}, fmt.Errorf("path does not exist")
	}
	if loc.seg.IsIndex {
		if parent.kind != kindArray {
			return patch{}, fmt.Errorf("path does not exist")
		}
		if loc.seg.Index != len(parent.elems) {
			return patch{}, fmt.Errorf("index %d is past the end of an array of %d (only an append is supported)",
				loc.seg.Index, len(parent.elems))
		}
	} else if parent.kind != kindObject {
		return patch{}, fmt.Errorf("path does not exist")
	}

	entry := func(indent string) []byte {
		body := reindent(val, indent, st.eol)
		if loc.seg.IsIndex {
			return body
		}
		key, _ := json.Marshal(loc.seg.Key)
		return append(append(key, ": "...), body...)
	}

	// An empty container has no sibling to copy, so the new entry is placed relative to the
	// container's own line, one indent step in.
	count := len(parent.members)
	if parent.kind == kindArray {
		count = len(parent.elems)
	}
	if count == 0 {
		pos := parent.start + 1
		if !bytes.ContainsRune(src[parent.start:parent.end], '\n') {
			return patch{start: pos, end: pos, text: entry("")}, nil
		}
		indent := lineIndentAt(src, parent.start) + st.unit
		return patch{start: pos, end: pos, text: []byte(st.eol + indent + string(entry(indent)))}, nil
	}

	lastStart, lastEnd := entrySpan(parent, count-1)
	if !bytes.ContainsRune(src[lastEnd:parent.end], '\n') {
		return patch{start: lastEnd, end: lastEnd, text: append([]byte(", "), entry("")...)}, nil
	}
	indent := lineIndentAt(src, lastStart)
	return patch{start: lastEnd, end: lastEnd, text: []byte("," + st.eol + indent + string(entry(indent)))}, nil
}

// entrySpan is the full byte range of one member (key through value) or element.
func entrySpan(parent *node, i int) (int, int) {
	if parent.kind == kindObject {
		m := parent.members[i]
		return m.keyStart, m.value.end
	}
	e := parent.elems[i]
	return e.start, e.end
}

// deleteSpan is the range to cut so that removing an entry leaves valid JSON and disturbs nothing
// else. It takes the one comma that joined the entry to its siblings -- the following comma
// normally, the preceding one when removing the last entry -- and, when the entry had its line to
// itself, the line as well, so a delete does not leave a blank line behind.
//
// It stops at any comment: a comment on the same line is left where it is rather than deleted
// along with the entry, because a comment is the author's text and losing it silently is worse
// than leaving one stray line for them to tidy.
func deleteSpan(src []byte, parent *node, idx int) (int, int) {
	count := len(parent.members)
	if parent.kind == kindArray {
		count = len(parent.elems)
	}
	s, e := entrySpan(parent, idx)

	if idx < count-1 {
		j := e
		for j < len(src) && (src[j] == ' ' || src[j] == '\t') {
			j++
		}
		if j < len(src) && src[j] == ',' {
			e = j + 1
			// Close the gap the comma left, so deleting from an object written on one line
			// does not leave `{ "b": 2}` behind. Stop at a line ending (the whole-line rule
			// below handles that shape) and at a comment (never delete the author's text).
			k := e
			for k < len(src) && (src[k] == ' ' || src[k] == '\t') {
				k++
			}
			if k < len(src) && src[k] != '/' && src[k] != '\n' && src[k] != '\r' {
				e = k
			}
		}
	} else if count > 1 {
		j := s - 1
		for j >= 0 && isSpaceByte(src[j]) {
			j--
		}
		if j >= 0 && src[j] == ',' {
			s = j
		}
	}

	ls := lineStartAt(src, s)
	if isAllSpace(src[ls:s]) {
		le := e
		for le < len(src) && (src[le] == ' ' || src[le] == '\t') {
			le++
		}
		if le == len(src) {
			return ls, le
		}
		if src[le] == '\r' && le+1 < len(src) && src[le+1] == '\n' {
			return ls, le + 2
		}
		if src[le] == '\n' || src[le] == '\r' {
			return ls, le + 1
		}
	}
	return s, e
}

// normalizeValue trims the whitespace a caller's marshaller left around the value (a stray
// trailing newline would otherwise land in the middle of a line) and rejects anything that is not
// valid JSON. That validation is load-bearing beyond the obvious: valid JSON cannot contain a raw
// newline inside a string literal, which is what makes reindent's line-by-line rewrite safe.
func normalizeValue(v []byte) ([]byte, error) {
	v = bytes.Trim(v, " \t\r\n")
	if len(v) == 0 {
		return nil, fmt.Errorf("value is empty (set Delete to remove a path)")
	}
	if !json.Valid(StripComments(v)) {
		return nil, fmt.Errorf("value is not valid JSON")
	}
	return v, nil
}

// reindent shifts a multi-line value to the column it is being written at, preserving its own
// internal structure: continuation lines are dedented by their common prefix and re-indented by
// indent, and line endings are normalized to the document's. A single-line value is returned
// untouched. Splitting raw JSON on newlines can never split inside a string literal, because JSON
// requires literal newlines to be escaped -- normalizeValue has already established the value is
// real JSON, so that holds.
func reindent(val []byte, indent, eol string) []byte {
	if !bytes.ContainsAny(val, "\r\n") {
		return val
	}
	lines := splitLines(val)
	common := -1
	for _, l := range lines[1:] {
		if isAllSpace(l) {
			continue
		}
		w := len(l) - len(bytes.TrimLeft(l, " \t"))
		if common < 0 || w < common {
			common = w
		}
	}
	if common < 0 {
		common = 0
	}

	var b bytes.Buffer
	b.Write(lines[0])
	for _, l := range lines[1:] {
		b.WriteString(eol)
		if isAllSpace(l) {
			continue
		}
		b.WriteString(indent)
		b.Write(l[common:])
	}
	return b.Bytes()
}

func splitLines(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for i := 0; i < len(b); i++ {
		if b[i] == '\n' {
			end := i
			if end > start && b[end-1] == '\r' {
				end--
			}
			out = append(out, b[start:end])
			start = i + 1
		}
	}
	return append(out, b[start:])
}

// style is the layout the document already uses, which insertions copy so a new line looks like
// the lines around it rather than like this package's preferences.
type style struct {
	eol  string
	unit string
}

func styleOf(src []byte) style {
	st := style{eol: "\n", unit: "  "}

	crlf, lf := 0, 0
	for i := 0; i < len(src); i++ {
		if src[i] == '\n' {
			if i > 0 && src[i-1] == '\r' {
				crlf++
			} else {
				lf++
			}
		}
	}
	if crlf > lf {
		st.eol = "\r\n"
	}

	// The narrowest indented line in the file is the best available guess at one indent step,
	// and it carries the character (tab or space) along with the width. Only insertions into an
	// empty container ever consult it; every other insertion copies a sibling's actual indent.
	best := -1
	atLineStart := true
	for i := 0; i < len(src); i++ {
		if src[i] == '\n' {
			atLineStart = true
			continue
		}
		if !atLineStart {
			continue
		}
		atLineStart = false
		if src[i] != ' ' && src[i] != '\t' {
			continue
		}
		j := i
		for j < len(src) && (src[j] == ' ' || src[j] == '\t') {
			j++
		}
		if j < len(src) && (src[j] == '\n' || src[j] == '\r') {
			continue // a blank line's whitespace says nothing about indentation
		}
		if best < 0 || j-i < best {
			best = j - i
			st.unit = string(src[i:j])
		}
	}
	return st
}

func lineStartAt(src []byte, pos int) int {
	for pos > 0 && src[pos-1] != '\n' {
		pos--
	}
	return pos
}

func lineIndentAt(src []byte, pos int) string {
	ls := lineStartAt(src, pos)
	i := ls
	for i < pos && (src[i] == ' ' || src[i] == '\t') {
		i++
	}
	return string(src[ls:i])
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isAllSpace(b []byte) bool {
	for _, c := range b {
		if !isSpaceByte(c) {
			return false
		}
	}
	return true
}

// --- document scanner -------------------------------------------------------------------------

type kind uint8

const (
	kindScalar kind = iota
	kindObject
	kindArray
)

// node is a value and the exact bytes it occupies. start is its first byte and end is one past
// its last, both indices into the original source, which is the only thing Apply ever edits.
type node struct {
	kind    kind
	start   int
	end     int
	members []*member
	elems   []*node
}

type member struct {
	keyStart int
	keyEnd   int
	key      string
	value    *node
}

// lastMember is where the duplicate-key rule lives: the last occurrence wins, because that is the
// one that survives parsing.
func (n *node) lastMember(key string) int {
	for i := len(n.members) - 1; i >= 0; i-- {
		if n.members[i].key == key {
			return i
		}
	}
	return -1
}

func (n *node) isContainer() bool { return n.kind == kindObject || n.kind == kindArray }

type scanner struct {
	src   []byte
	i     int
	lines lineIndex
}

func scanDocument(src []byte) (*node, error) {
	s := &scanner{src: src, lines: newLineIndex(src)}
	n, err := s.value()
	if err != nil {
		return nil, err
	}
	s.i = skipTrivia(s.src, s.i)
	if s.i < len(s.src) {
		return nil, s.errf(s.i, "unexpected trailing content after the top-level value")
	}
	return n, nil
}

// errf builds the package's one error type. The position goes through OffsetPosition rather than
// through the scanner's own line index, so a SyntaxError and an encoding/json error over the same
// file can never disagree about where line 1 ends -- OffsetPosition treats a lone ” as a line
// ending and counts columns in code points, and a second implementation of that beside it is a
// second set of rules to keep in step.
//
// It is O(offset), unlike the line index's binary search, and that is the right trade here: this
// runs once, at the moment a document has already failed to parse, while the index is consulted
// per annotation on documents that parsed fine.
func (s *scanner) errf(off int, format string, args ...any) error {
	pos := OffsetPosition(s.src, int64(off))
	return &SyntaxError{Msg: fmt.Sprintf(format, args...), Offset: off, Line: pos.Line, Column: pos.Column}
}

func (s *scanner) value() (*node, error) {
	s.i = skipTrivia(s.src, s.i)
	if s.i >= len(s.src) {
		return nil, s.errf(s.i, "unexpected end of input, expected a value")
	}
	switch s.src[s.i] {
	case '{':
		return s.object()
	case '[':
		return s.array()
	case '"':
		start := s.i
		end, ok := stringEnd(s.src, s.i)
		if !ok {
			return nil, s.errf(start, "unterminated string")
		}
		// Finding the closing quote is not the same as the literal being legal: a raw newline
		// or other control byte inside it, or a bad \u escape, is something encoding/json
		// rejects, and this scanner must never accept a document the loaders will not.
		if !json.Valid(s.src[start:end]) {
			return nil, s.errf(start, "invalid string literal")
		}
		s.i = end
		return &node{kind: kindScalar, start: start, end: end}, nil
	default:
		return s.scalar()
	}
}

func (s *scanner) object() (*node, error) {
	n := &node{kind: kindObject, start: s.i}
	s.i++
	for {
		s.i = skipTrivia(s.src, s.i)
		if s.i >= len(s.src) {
			return nil, s.errf(s.i, "unexpected end of input inside an object")
		}
		if s.src[s.i] == '}' {
			s.i++
			n.end = s.i
			return n, nil
		}
		if len(n.members) > 0 {
			if s.src[s.i] != ',' {
				return nil, s.errf(s.i, "expected %q or %q in an object", ",", "}")
			}
			s.i++
			s.i = skipTrivia(s.src, s.i)
			if s.i < len(s.src) && s.src[s.i] == '}' {
				// The game's parser rejects this too; accepting it here would let the tool
				// save a file the game then refuses to load.
				return nil, s.errf(s.i, "trailing comma before %q", "}")
			}
		}
		if s.i >= len(s.src) || s.src[s.i] != '"' {
			return nil, s.errf(s.i, "expected an object key")
		}
		ks := s.i
		ke, ok := stringEnd(s.src, s.i)
		if !ok {
			return nil, s.errf(ks, "unterminated object key")
		}
		var key string
		if err := json.Unmarshal(s.src[ks:ke], &key); err != nil {
			return nil, s.errf(ks, "malformed object key")
		}
		s.i = ke
		s.i = skipTrivia(s.src, s.i)
		if s.i >= len(s.src) || s.src[s.i] != ':' {
			return nil, s.errf(s.i, "expected %q after an object key", ":")
		}
		s.i++
		v, err := s.value()
		if err != nil {
			return nil, err
		}
		n.members = append(n.members, &member{keyStart: ks, keyEnd: ke, key: key, value: v})
	}
}

func (s *scanner) array() (*node, error) {
	n := &node{kind: kindArray, start: s.i}
	s.i++
	for {
		s.i = skipTrivia(s.src, s.i)
		if s.i >= len(s.src) {
			return nil, s.errf(s.i, "unexpected end of input inside an array")
		}
		if s.src[s.i] == ']' {
			s.i++
			n.end = s.i
			return n, nil
		}
		if len(n.elems) > 0 {
			if s.src[s.i] != ',' {
				return nil, s.errf(s.i, "expected %q or %q in an array", ",", "]")
			}
			s.i++
			s.i = skipTrivia(s.src, s.i)
			if s.i < len(s.src) && s.src[s.i] == ']' {
				return nil, s.errf(s.i, "trailing comma before %q", "]")
			}
		}
		v, err := s.value()
		if err != nil {
			return nil, err
		}
		n.elems = append(n.elems, v)
	}
}

// scalar takes the run of bytes that can belong to a number or a bare literal and hands it to
// encoding/json to judge, rather than reimplementing number grammar. The run stops at '/' as well
// as the usual separators so that "1/* note */" scans as the number 1 followed by a comment.
func (s *scanner) scalar() (*node, error) {
	start := s.i
	j := s.i
	for j < len(s.src) {
		c := s.src[j]
		if isSpaceByte(c) || c == ',' || c == ']' || c == '}' || c == '/' {
			break
		}
		j++
	}
	if j == start || !json.Valid(s.src[start:j]) {
		return nil, s.errf(start, "invalid value")
	}
	s.i = j
	return &node{kind: kindScalar, start: start, end: j}, nil
}

// stringEnd returns one past the closing quote of the string literal starting at i, honoring
// backslash escapes so that \" does not end the string and \\ does not escape the quote after it.
func stringEnd(src []byte, i int) (int, bool) {
	for j := i + 1; j < len(src); j++ {
		switch src[j] {
		case '\\':
			j++
		case '"':
			return j + 1, true
		}
	}
	return 0, false
}

// skipTrivia advances past whitespace and comments. It is only ever called between tokens, never
// inside a string literal, which is what lets it treat any '/' as a possible comment start.
func skipTrivia(src []byte, i int) int {
	for i < len(src) {
		if isSpaceByte(src[i]) {
			i++
			continue
		}
		end, ok := commentEnd(src, i)
		if !ok {
			return i
		}
		i = end
	}
	return i
}

// commentEnd reports whether a comment starts at src[i] and where it ends. It matches
// StripComments exactly, including the two edge cases: a "//" comment ends at the line ending (or
// EOF) without consuming it, and an unterminated "/*" runs to EOF.
func commentEnd(src []byte, i int) (int, bool) {
	if i+1 >= len(src) || src[i] != '/' {
		return 0, false
	}
	switch src[i+1] {
	case '/':
		j := i + 2
		for j < len(src) && src[j] != '\n' && src[j] != '\r' {
			j++
		}
		return j, true
	case '*':
		for j := i + 2; j+1 < len(src); j++ {
			if src[j] == '*' && src[j+1] == '/' {
				return j + 2, true
			}
		}
		return len(src), true
	}
	return 0, false
}

// lineIndex turns a byte offset into a 1-based line number. Lines are counted by '\n' alone, so a
// CRLF document numbers the same as an LF one.
type lineIndex []int

func newLineIndex(src []byte) lineIndex {
	var li lineIndex
	for i, c := range src {
		if c == '\n' {
			li = append(li, i)
		}
	}
	return li
}

func (li lineIndex) line(off int) int {
	return sort.SearchInts(li, off) + 1
}
