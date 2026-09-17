package jsonc

import (
	"fmt"
	"strings"
)

// DirectivePrefix introduces an editor directive inside a JSON comment. The game's own parser
// accepts `//` and `/* */` (see this package's doc comment), so a directive is invisible to
// Minecraft and visible to this tool -- a pack can carry editor state without carrying a key the
// engine would have to accept.
const DirectivePrefix = "@featurelab:"

// Annotation is one parsed directive. Its fields mirror wire.Annotation exactly, field for field
// and tag for tag, so a caller can convert element-wise: wire.Annotation(a).
//
// It is declared here rather than imported because wire already depends on this package
// (transitively, through the loaders that call StripComments); jsonc importing wire would be an
// import cycle. wire owns the contract, this package produces values for it, and the conversion
// is the seam between them.
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

// ParseAnnotations extracts every `@featurelab:` directive from src's comments, in source order.
//
// # Directive syntax
//
// A directive must be the first non-space text on a comment line: `@featurelab:<name> <args>`.
// The name runs to the first character outside [A-Za-z0-9_.-], and the rest of the line is
// whitespace-split into Args. Requiring the line to START with the prefix is what keeps prose
// that merely mentions a directive ("superseded by @featurelab:ignore below") from being parsed
// as one. A `@featurelab:` with no name after the colon is not a directive and is treated as
// prose.
//
// Text is the free text that follows a directive: the remaining lines of its comment run, up to
// the next directive or the end of the run, each stripped of its comment markers and surrounding
// whitespace and joined with "\n". A "comment run" is a group of comments separated only by
// whitespace containing at most one line ending -- so consecutive `//` lines are one run, and a
// blank line ends it. Inside a block comment a leading `*` is dropped when it is followed by
// whitespace or ends the line, which is the conventional continuation marker; `*emphasis*`
// survives intact.
//
// # How a comment is attached to a path
//
// Attachment is computed once per comment RUN, from the run's first byte, so every directive in
// one run lands on the same node -- two adjacent directives never disagree about what they
// annotate. Within the enclosing container, in this order:
//
//  1. If the run sits INSIDE a member or element -- between a key and its value, or anywhere
//     within a value -- it belongs to that member or element, and to the deepest one when values
//     nest. `"a": /* note */ 1` annotates $.a.
//  2. Otherwise, if the run begins on the same line as, and after, the end of a preceding
//     sibling, it belongs to that sibling. This is the trailing-comment case: in `"a": 1, // note`
//     the note is about a, not about whatever comes next.
//  3. Otherwise, if a sibling follows, it belongs to that sibling. This is the common case and
//     the point of the feature: a comment written above a key annotates that key.
//  4. Otherwise nothing follows it in this container, so it belongs to the container itself -- a
//     comment left at the bottom of an object is about the object.
//
// A comment before or after the whole document annotates the root, "$".
//
// # Ambiguous placements, and what happens to them
//
// Rules 2 and 3 can both look plausible to a human and only one can win. `"a": 1, // note` goes
// to a (rule 2); moving that same comment onto its own line moves it to the following key (rule
// 3). Line position decides, never indentation -- a comment indented to match a nested block but
// written after that block's closing brace belongs to the outer container, because that is where
// the bytes are.
//
// Two members of one object with the same key produce the same JSONPath for both, because the
// path dialect cannot distinguish them. Such a file is already ambiguous to every parser that
// reads it (the last one wins), so the annotation is attributed to the key, not to the copy.
//
// # Rewriting a directive
//
// Offset and EndOffset bound the directive TEXT: the '@' through the last argument, with the
// comment markers, the indentation before them and any following free text all outside the span.
// So src[Offset:EndOffset] is exactly the directive, and writing different bytes over that range
// changes it in place without disturbing the comment it lives in. Two things the replacement text
// must respect, both of which follow from the span stopping at the directive: it may not contain a
// line ending, because inside a `//` comment everything after one stops being a comment; and
// replacing it with nothing leaves an empty comment line rather than removing the line, since the
// markers were never part of the span.
//
// These spans are byte offsets into src, not into anything this package rewrote -- which is why
// StripComments blanks comments in place instead of deleting them, and why the two halves of this
// package can hand offsets to each other at all.
//
// A span only exists for a directive that is already there, so it covers changing and removing
// one. ADDING one to a path that has no annotation yet -- which is every path the first time
// anyone annotates it -- is InsertAnnotation.
//
// # Errors
//
// Annotations are returned even when src is not structurally valid JSON, because an editor has to
// keep working on a file mid-edit. Directives always come back with their Name, Args, Text, Line
// and span -- none of those need the document to parse. Only paths do, so when the document does
// not scan, every JSONPath falls back to "$" and the returned error says why. Callers that need
// trustworthy paths must check it; callers that only want to rewrite a directive need not, which
// is the case that matters, because the file is at its most broken exactly while someone is
// editing it.
func ParseAnnotations(src []byte) ([]Annotation, error) {
	toks := scanCommentTokens(src)
	if len(toks) == 0 {
		return nil, nil
	}
	lines := newLineIndex(src)

	root, scanErr := scanDocument(src)

	var out []Annotation
	for _, run := range groupRuns(src, toks) {
		path := "$"
		if scanErr == nil {
			path = attachPath(src, root, run[0].start)
		}
		out = append(out, parseRun(src, run, path, lines)...)
	}
	return out, scanErr
}

// AnnotationPoint is where a new directive annotating a path goes, and what a well-formed comment
// around it looks like there. Splicing Prefix + directive + Suffix into src at Offset produces a
// comment that ParseAnnotations will attach back to the path it was computed for.
//
// Prefix and Suffix carry the comment markers AND the layout -- the indentation to match, the
// document's line ending, and which comment form works at that spot -- so an inserter never has to
// decide between "//" and "/* */" itself. That decision is not cosmetic: see AnnotationPointFor.
type AnnotationPoint struct {
	// Offset is the byte offset in src to splice at.
	Offset int
	// Prefix and Suffix bracket the directive text.
	Prefix string
	Suffix string
	// Line is the 1-based line the directive will land on, for putting the cursor there.
	Line int
}

// AnnotationPointFor computes where to write a new directive so that it annotates jsonPath.
//
// This is the inverse of the attachment rules on ParseAnnotations, and it exists because those
// rules make the obvious insertion wrong often enough to matter. Three ways the naive "put a //
// comment on the line above" fails, all of which this handles:
//
//   - On an entry that shares its line with other content, a "//" comment would swallow the rest
//     of the line into a comment, and a block comment placed BEFORE the entry would be claimed by
//     the entry in front of it under the trailing-comment rule. So the directive goes immediately
//     AFTER the entry's value instead, where that same rule claims it for this entry.
//   - A comment written directly under an existing comment joins its run, and a run attaches as a
//     unit -- so a new line under a trailing "// note" would inherit that note's attachment and
//     land on the previous entry. The candidate is therefore checked from the start of whatever
//     run it would join, not from itself.
//   - The root is not an entry and has no line of its own to sit above, so "$" always takes a
//     comment line above the root value, where being outside the document is what attaches it.
//
// The point is verified rather than assumed: the own-line form is only used when asking the
// attachment rules where a comment there would land gives back the requested path, and the
// after-the-value form is the fallback when it does not.
//
// It returns an error if jsonPath does not parse, does not exist, or src does not scan -- unlike
// reading annotations, writing one into a file whose structure is unknown is not something to
// guess at.
func AnnotationPointFor(src []byte, jsonPath string) (AnnotationPoint, error) {
	segs, err := ParsePath(jsonPath)
	if err != nil {
		return AnnotationPoint{}, err
	}
	root, err := scanDocument(src)
	if err != nil {
		return AnnotationPoint{}, err
	}
	st := styleOf(src)
	lines := newLineIndex(src)

	// The root takes a comment line above the whole value: everything before the root value is
	// outside the document, which is what attaches a comment to "$", and that stays true of any
	// run it joins, since those start earlier still. The one thing to check is that the line is
	// the root's alone -- when the root shares it with the tail of a block comment, inserting at
	// the line start would put the directive INSIDE that comment, where it is text and not a
	// directive at all. Then it goes after the document instead, which is equally outside it.
	if len(segs) == 0 {
		if ls := lineStartAt(src, root.start); isAllSpace(src[ls:root.start]) {
			return AnnotationPoint{
				Offset: ls,
				Prefix: string(src[ls:root.start]) + "// ",
				Suffix: st.eol,
				Line:   lines.line(ls),
			}, nil
		}
		return AnnotationPoint{
			Offset: root.end,
			Prefix: " /* ",
			Suffix: " */",
			Line:   lines.line(root.end),
		}, nil
	}

	loc, err := locate(root, segs)
	if err != nil {
		return AnnotationPoint{}, err
	}
	if loc.node == nil {
		return AnnotationPoint{}, fmt.Errorf("jsonc: %s does not exist, so there is nothing to annotate", jsonPath)
	}
	start, end := entrySpan(loc.parent, loc.index)

	ls := lineStartAt(src, start)
	if isAllSpace(src[ls:start]) && attachPath(src, root, runStartAt(src, ls)) == FormatPath(segs) {
		return AnnotationPoint{
			Offset: ls,
			Prefix: string(src[ls:start]) + "// ",
			Suffix: st.eol,
			Line:   lines.line(ls),
		}, nil
	}
	return AnnotationPoint{Offset: end, Prefix: " /* ", Suffix: " */", Line: lines.line(end)}, nil
}

// InsertAnnotation returns src with a `@featurelab:name args...` directive added in a comment that
// annotates jsonPath. Only the inserted bytes are new; nothing already in the file moves or
// changes, which is the same promise Apply makes about values.
//
// Taking the name and arguments apart rather than as one string is what makes the whitespace-split
// Args contract enforceable: an argument containing a space would silently come back as two, so it
// is rejected here instead of being written into a file and discovered later.
//
// Whether the path already carries a directive of this name is the caller's business -- read them
// with ParseAnnotations and rewrite through Offset/EndOffset if replacing one is what is wanted.
func InsertAnnotation(src []byte, jsonPath, name string, args ...string) ([]byte, error) {
	directive, err := formatDirective(name, args)
	if err != nil {
		return nil, err
	}
	p, err := AnnotationPointFor(src, jsonPath)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(src)+len(p.Prefix)+len(directive)+len(p.Suffix))
	out = append(out, src[:p.Offset]...)
	out = append(out, p.Prefix...)
	out = append(out, directive...)
	out = append(out, p.Suffix...)
	return append(out, src[p.Offset:]...), nil
}

func formatDirective(name string, args []string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("jsonc: a directive needs a name")
	}
	for i := 0; i < len(name); i++ {
		if !isNameByte(name[i]) {
			return "", fmt.Errorf("jsonc: directive name %q contains %q, which is not one of [A-Za-z0-9_.-]", name, name[i])
		}
	}
	var b strings.Builder
	b.WriteString(DirectivePrefix)
	b.WriteString(name)
	for _, a := range args {
		switch {
		case a == "":
			return "", fmt.Errorf("jsonc: directive %q has an empty argument, which would vanish when Args is whitespace-split", name)
		case strings.ContainsAny(a, " \t\r\n\v\f"):
			return "", fmt.Errorf("jsonc: directive %q argument %q contains whitespace, and Args is whitespace-split, so it would read back as two arguments", name, a)
		case strings.Contains(a, "*/"):
			return "", fmt.Errorf("jsonc: directive %q argument %q contains %q, which would close a block comment early", name, a, "*/")
		}
		b.WriteByte(' ')
		b.WriteString(a)
	}
	return b.String(), nil
}

// runStartAt returns the byte that a comment inserted at the start of the line at ls would be
// attached from: the start of the comment run just above it when that run would absorb it (runs
// attach as a unit), and otherwise ls itself.
// It asks groupRuns' own question rather than re-deriving the answer by scanning backwards, which
// is not the same thing: a "// note " comment ends in whitespace, so walking back over whitespace
// from below walks INTO the comment and never finds its end, and the join goes undetected.
func runStartAt(src []byte, ls int) int {
	toks := scanCommentTokens(src)
	if len(toks) == 0 {
		return ls
	}
	var prev []commentTok
	for _, run := range groupRuns(src, toks) {
		if run[len(run)-1].end > ls {
			break
		}
		prev = run
	}
	if prev == nil {
		return ls
	}
	gap := src[prev[len(prev)-1].end:ls]
	if isAllSpace(gap) && countNewlines(gap) <= 1 {
		return prev[0].start
	}
	return ls
}

type commentTok struct {
	start, end int
	block      bool
}

// scanCommentTokens finds every comment in src, skipping string literals so that "http://x" and
// "a /* b */ c" inside a JSON string are never mistaken for comments. It mirrors StripComments'
// state machine; it cannot reuse it, because StripComments deliberately returns only blanked
// bytes and not the spans it blanked.
func scanCommentTokens(src []byte) []commentTok {
	var out []commentTok
	inString := false
	escaped := false
	for i := 0; i < len(src); {
		c := src[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			i++
			continue
		}
		if c == '"' {
			inString = true
			i++
			continue
		}
		if end, ok := commentEnd(src, i); ok {
			out = append(out, commentTok{start: i, end: end, block: src[i+1] == '*'})
			i = end
			continue
		}
		i++
	}
	return out
}

// groupRuns joins comments that a reader would read as one block: adjacent, or on consecutive
// lines. A blank line between two comments ends the run, so an author can detach a note from the
// directive above it by leaving a line.
func groupRuns(src []byte, toks []commentTok) [][]commentTok {
	var runs [][]commentTok
	cur := []commentTok{toks[0]}
	for _, t := range toks[1:] {
		gap := src[cur[len(cur)-1].end:t.start]
		if isAllSpace(gap) && countNewlines(gap) <= 1 {
			cur = append(cur, t)
			continue
		}
		runs = append(runs, cur)
		cur = []commentTok{t}
	}
	return append(runs, cur)
}

func countNewlines(b []byte) int {
	n := 0
	for _, c := range b {
		if c == '\n' {
			n++
		}
	}
	return n
}

// commentLine is one line of comment text with its markers removed, and off is where that text
// begins in src -- not where the line begins. Keeping the exact offset rather than recovering it
// later is what lets an annotation report a span an editor can write over.
type commentLine struct {
	off  int
	text string
}

func runLines(src []byte, run []commentTok) []commentLine {
	var out []commentLine
	for _, t := range run {
		if !t.block {
			out = append(out, trimLine(src, t.start+2, t.end, false))
			continue
		}
		// An unterminated block comment has no "*/" to exclude; commentEnd already ran it to
		// EOF, and the length test keeps "/*/" from mistaking its own opener for a closer.
		inner := t.end
		if inner >= t.start+4 && src[t.end-2] == '*' && src[t.end-1] == '/' {
			inner = t.end - 2
		}
		start := t.start + 2
		for i := start; i <= inner; i++ {
			if i < inner && src[i] != '\n' && src[i] != '\r' {
				continue
			}
			out = append(out, trimLine(src, start, i, true))
			// A bare '\r' ends a line here for the same reason it ends a "//" comment in
			// commentEnd: it is a line ending in files converted from classic Mac endings,
			// and letting one sit inside a directive would put a line break inside a span an
			// editor is meant to write over.
			if i+1 < inner && src[i] == '\r' && src[i+1] == '\n' {
				i++
			}
			start = i + 1
		}
	}
	return out
}

// trimLine reduces one raw comment line to its text by moving the bounds inward, so the result is
// always a contiguous slice of src and its offset stays exact.
func trimLine(src []byte, start, end int, block bool) commentLine {
	for start < end && isSpaceByte(src[start]) {
		start++
	}
	for end > start && isSpaceByte(src[end-1]) {
		end--
	}
	// Drop a block comment's conventional continuation marker, but only when it is one: a line
	// that opens a word with '*' keeps it, so `*emphasis*` survives.
	if block && start < end && src[start] == '*' &&
		(start+1 == end || src[start+1] == ' ' || src[start+1] == '\t') {
		start++
		for start < end && isSpaceByte(src[start]) {
			start++
		}
	}
	return commentLine{off: start, text: string(src[start:end])}
}

func parseRun(src []byte, run []commentTok, path string, lines lineIndex) []Annotation {
	var out []Annotation
	var text []string
	flush := func() {
		if len(out) == 0 {
			return
		}
		out[len(out)-1].Text = joinText(text)
		text = nil
	}
	for _, cl := range runLines(src, run) {
		name, args, ok := parseDirective(cl.text)
		if !ok {
			if len(out) > 0 {
				text = append(text, cl.text)
			}
			continue
		}
		flush()
		out = append(out, Annotation{
			Name:      name,
			Args:      args,
			JSONPath:  path,
			Line:      lines.line(cl.off),
			Offset:    cl.off,
			EndOffset: cl.off + len(cl.text),
		})
	}
	flush()
	return out
}

func joinText(lines []string) string {
	for len(lines) > 0 && lines[0] == "" {
		lines = lines[1:]
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

func parseDirective(line string) (name string, args []string, ok bool) {
	if !strings.HasPrefix(line, DirectivePrefix) {
		return "", nil, false
	}
	rest := line[len(DirectivePrefix):]
	i := 0
	for i < len(rest) && isNameByte(rest[i]) {
		i++
	}
	if i == 0 {
		return "", nil, false
	}
	args = strings.Fields(rest[i:])
	if len(args) == 0 {
		args = nil // a directive with no arguments has nil Args, never an empty slice
	}
	return rest[:i], args, true
}

func isNameByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	case c == '_', c == '-', c == '.':
		return true
	}
	return false
}

// attachPath implements the attachment rules documented on ParseAnnotations.
func attachPath(src []byte, root *node, off int) string {
	if off < root.start || off >= root.end {
		return "$"
	}
	var segs []PathSegment
	cur := root
	for cur.isContainer() {
		count := len(cur.members)
		if cur.kind == kindArray {
			count = len(cur.elems)
		}

		inside := -1
		for i := 0; i < count; i++ {
			s, e := entrySpan(cur, i)
			if off >= s && off < e {
				inside = i
				break
			}
		}
		if inside < 0 {
			return FormatPath(triviaSegs(src, cur, count, off, segs))
		}

		segs = append(segs, segFor(cur, inside))
		var value *node
		if cur.kind == kindObject {
			value = cur.members[inside].value
		} else {
			value = cur.elems[inside]
		}
		if !value.isContainer() || off <= value.start {
			// Between the key and its value, or inside a scalar: the member is as deep as
			// this comment goes.
			return FormatPath(segs)
		}
		cur = value
	}
	return FormatPath(segs)
}

// triviaSegs resolves a comment that sits in a container's whitespace, between entries rather
// than inside one: trailing comment first, then the following sibling, then the container.
func triviaSegs(src []byte, cur *node, count, off int, segs []PathSegment) []PathSegment {
	prev, next := -1, -1
	for i := 0; i < count; i++ {
		s, e := entrySpan(cur, i)
		if e <= off {
			prev = i
		}
		if next < 0 && s > off {
			next = i
		}
	}
	if prev >= 0 {
		_, e := entrySpan(cur, prev)
		if countNewlines(src[e:off]) == 0 && !containsCR(src[e:off]) {
			return append(segs, segFor(cur, prev))
		}
	}
	if next >= 0 {
		return append(segs, segFor(cur, next))
	}
	return segs
}

// containsCR catches a bare '\r' line ending, which countNewlines does not see. Old files
// converted from classic Mac line endings do turn up in packs.
func containsCR(b []byte) bool {
	for _, c := range b {
		if c == '\r' {
			return true
		}
	}
	return false
}

func segFor(cur *node, i int) PathSegment {
	if cur.kind == kindObject {
		return PathSegment{Key: cur.members[i].key}
	}
	return PathSegment{Index: i, IsIndex: true}
}

// SetAnnotation returns src with `@featurelab:name args...` recorded on jsonPath: the directive is
// REWRITTEN if one of that name is already attached there, and inserted otherwise.
//
// It exists because an editor's annotation is almost never written once. A directive that records
// a choice -- how an expression should be spelled, whether a warning has been considered and
// dismissed -- is toggled, and the two halves of a toggle have to be one operation: an insert that
// did not notice the existing directive would leave a path carrying the same name twice, which is
// a state ParseAnnotations has no answer for (it returns both, in source order, and every reader
// then has to invent a tie-break).
//
// Rewriting goes through Offset/EndOffset, which bound the directive text and nothing else, so the
// comment around it -- its markers, its indentation, any free text the author added after it --
// survives a change of argument untouched. That is the whole reason those spans are in the
// contract; see ParseAnnotations' "Rewriting a directive".
//
// Removing a directive is deliberately NOT offered. The span stops at the last argument, so
// writing nothing over it leaves an empty comment behind, and deleting the line it sits on would
// take with it any prose sharing that line -- which is the author's, not the editor's. A caller
// that wants an "off" state should write one as an argument, where it reads as a decision somebody
// made rather than as the absence of one.
func SetAnnotation(src []byte, jsonPath, name string, args ...string) ([]byte, error) {
	directive, err := formatDirective(name, args)
	if err != nil {
		return nil, err
	}
	existing, err := ParseAnnotations(src)
	// A parse error is reported by ParseAnnotations ALONGSIDE whatever it could read, and the
	// annotations it returns in that case have no paths -- so a file that does not scan cannot be
	// matched against jsonPath, and falls through to InsertAnnotation, which refuses it properly.
	if err == nil {
		for _, a := range existing {
			if a.Name != name || a.JSONPath != jsonPath {
				continue
			}
			out := make([]byte, 0, len(src)+len(directive))
			out = append(out, src[:a.Offset]...)
			out = append(out, directive...)
			return append(out, src[a.EndOffset:]...), nil
		}
	}
	return InsertAnnotation(src, jsonPath, name, args...)
}

// RemoveAnnotation returns src with the `@featurelab:name` directive attached to jsonPath taken
// out -- markers, and the line, when the line held nothing else.
//
// SetAnnotation's doc comment explains why removal was not offered at first: the span stops at
// the last argument, so blanking it leaves an empty comment behind, and deleting the line it sits
// on would take any prose sharing that line. This function draws exactly the distinction that
// comment asked for, by looking at what ELSE the comment holds:
//
//   - A `//` comment holding only the directive, alone on its line, goes with its whole line --
//     the line ending included, in whatever style the line had, so a CRLF file stays CRLF.
//   - The same comment trailing a line of JSON (`"a": 1, // @featurelab:x`) goes with the
//     whitespace that separated it from the JSON, and nothing else on the line.
//   - A block comment holding only the directive goes whole: with its line when the line was its
//     alone, and with the whitespace beside it otherwise -- which is how the ` /* ... */` form
//     AnnotationPointFor writes after a value is undone without leaving a stray space.
//   - A block comment that also carries other text is refused, and src comes back untouched. That
//     text is the author's, and an editor that deleted it to tidy up after itself would be the very
//     thing SetAnnotation's comment warned against. (A `//` comment cannot carry prose beside a
//     directive: everything after the name is arguments.)
//
// Free text on the FOLLOWING lines of the run (Annotation.Text) is left where it is. It was the
// author's reason, and it survives as an ordinary comment; deciding on their behalf that a reason
// without its directive is worthless is not this function's call.
//
// A directive that is not there is not an error: the result is src unchanged, so a caller that
// wants an end state can ask for it rather than first asking whether there is anything to undo. A
// file that does not scan IS an error, for the reason AnnotationPointFor gives: without paths the
// directive cannot be matched to jsonPath, and guessing would remove the wrong one.
func RemoveAnnotation(src []byte, jsonPath, name string) ([]byte, error) {
	if name == "" {
		return nil, fmt.Errorf("jsonc: a directive needs a name")
	}
	anns, err := ParseAnnotations(src)
	if err != nil {
		return nil, err
	}
	var found *Annotation
	for i := range anns {
		if anns[i].Name == name && anns[i].JSONPath == jsonPath {
			found = &anns[i]
			break
		}
	}
	if found == nil {
		return src, nil
	}

	var tok commentTok
	holds := false
	for _, t := range scanCommentTokens(src) {
		if t.start <= found.Offset && found.EndOffset <= t.end {
			tok, holds = t, true
			break
		}
	}
	if !holds {
		return nil, fmt.Errorf("jsonc: the directive at offset %d is not inside a comment", found.Offset)
	}

	// The comment's own text, minus the directive, has to be nothing: whitespace, and inside a
	// block comment the conventional `*` continuation marker, which is layout rather than text.
	inner := tok.end
	if tok.block && tok.end >= tok.start+4 && src[tok.end-2] == '*' && src[tok.end-1] == '/' {
		inner = tok.end - 2
	}
	if !isCommentFiller(src[tok.start+2:found.Offset], tok.block) || !isCommentFiller(src[found.EndOffset:inner], tok.block) {
		return nil, fmt.Errorf("jsonc: the comment holding @featurelab:%s on %s also carries other text, so it was left alone rather than deleting something somebody wrote", name, jsonPath)
	}

	ls := lineStartAt(src, tok.start)
	le := tok.end
	for le < len(src) && src[le] != '\n' && src[le] != '\r' {
		le++
	}
	aloneBefore := isAllSpace(src[ls:tok.start])
	aloneAfter := isAllSpace(src[tok.end:le])

	delStart, delEnd := tok.start, tok.end
	switch {
	case aloneBefore && aloneAfter:
		// The whole line, with its ending. A last line without one loses just its content, so a
		// file that ended in a newline before the directive was written still does.
		delStart, delEnd = ls, le
		if delEnd < len(src) {
			if src[delEnd] == '\r' && delEnd+1 < len(src) && src[delEnd+1] == '\n' {
				delEnd += 2
			} else {
				delEnd++
			}
		}
	case aloneBefore:
		// Content follows on the line: the comment goes with the whitespace that set it off from
		// that content, and the indentation before it stays the line's.
		for delEnd < le && (src[delEnd] == ' ' || src[delEnd] == '\t') {
			delEnd++
		}
	default:
		// Content precedes it: the comment goes with the whitespace that set it off.
		for delStart > ls && (src[delStart-1] == ' ' || src[delStart-1] == '\t') {
			delStart--
		}
	}

	out := make([]byte, 0, len(src)-(delEnd-delStart))
	out = append(out, src[:delStart]...)
	return append(out, src[delEnd:]...), nil
}

// isCommentFiller reports whether b is nothing a reader would call text: whitespace, plus the `*`
// that opens a continuation line inside a block comment.
func isCommentFiller(b []byte, block bool) bool {
	for _, c := range b {
		if isSpaceByte(c) || (block && c == '*') {
			continue
		}
		return false
	}
	return true
}
