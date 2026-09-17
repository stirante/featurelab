package jsonc

import (
	"reflect"
	"strings"
	"testing"
)

// mustParse asserts the document scans cleanly, so a test about attachment never silently
// measures the "document did not parse, everything is $" fallback instead. It also checks the
// span of every annotation it returns, which is how the span claim gets tested against every
// fixture in this file -- CRLF, block comments, nesting -- rather than only its own.
func mustParse(t *testing.T, src string) []Annotation {
	t.Helper()
	got, err := ParseAnnotations([]byte(src))
	if err != nil {
		t.Fatalf("ParseAnnotations: %v", err)
	}
	assertSpansSliceBack(t, src, got)
	return got
}

// assertSpansSliceBack is the round trip the span exists for: cut the file at [Offset, EndOffset)
// and what comes out must be the directive, re-readable as the same directive.
func assertSpansSliceBack(t *testing.T, src string, anns []Annotation) {
	t.Helper()
	for _, a := range anns {
		if a.Offset < 0 || a.EndOffset > len(src) || a.Offset >= a.EndOffset {
			t.Fatalf("%s: span [%d,%d) is not inside a %d-byte document", a.Name, a.Offset, a.EndOffset, len(src))
		}
		slice := src[a.Offset:a.EndOffset]
		name, args, ok := parseDirective(slice)
		if !ok || name != a.Name || !reflect.DeepEqual(args, a.Args) {
			t.Fatalf("span of %s cut out %q, which reads back as (%q, %#v, %v)", a.Name, slice, name, args, ok)
		}
		if strings.ContainsAny(slice, "\r\n") {
			t.Fatalf("span of %s spans a line ending: %q", a.Name, slice)
		}
	}
}

// spanOf locates a directive in a fixture the way a reader would, so the expected spans below stay
// readable instead of being hand-counted byte offsets.
func spanOf(t *testing.T, src, directive string) (int, int) {
	t.Helper()
	i := strings.Index(src, directive)
	if i < 0 {
		t.Fatalf("fixture does not contain %q", directive)
	}
	if strings.Contains(src[i+len(directive):], directive) {
		t.Fatalf("fixture contains %q more than once; the expected span would be ambiguous", directive)
	}
	return i, i + len(directive)
}

// paths is the compact form the attachment tests assert on: one "name -> path" per annotation.
func paths(anns []Annotation) []string {
	out := make([]string, len(anns))
	for i, a := range anns {
		out[i] = a.Name + " -> " + a.JSONPath
	}
	return out
}

func assertPaths(t *testing.T, src string, want ...string) []Annotation {
	t.Helper()
	got := mustParse(t, src)
	if !reflect.DeepEqual(paths(got), want) {
		t.Fatalf("attachment:\n got: %v\nwant: %v", paths(got), want)
	}
	return got
}

// TestParseAnnotations_CommentAboveAKeyBelongsToThatKey is the rule the feature exists for. Every
// other attachment rule is an exception to this one.
func TestParseAnnotations_CommentAboveAKeyBelongsToThatKey(t *testing.T) {
	assertPaths(t, "{\n  \"a\": 1,\n  // @featurelab:layout 10 20\n  \"b\": 2\n}\n",
		"layout -> $.b")
}

// TestParseAnnotations_TrailingCommentBelongsToThePrecedingMember is the exception that matters
// most in practice: written at the end of a line, a note is about that line, not the next one.
func TestParseAnnotations_TrailingCommentBelongsToThePrecedingMember(t *testing.T) {
	assertPaths(t, "{\n  \"a\": 1, // @featurelab:ignore dead-branch\n  \"b\": 2\n}\n",
		"ignore -> $.a")
}

// TestParseAnnotations_MovingACommentOffTheLineMovesTheAnnotation pins the pair above against each
// other, because the two rules disagree about the same bytes and only line position separates them.
func TestParseAnnotations_MovingACommentOffTheLineMovesTheAnnotation(t *testing.T) {
	sameLine := mustParse(t, "{\n  \"a\": 1, // @featurelab:x\n  \"b\": 2\n}\n")
	ownLine := mustParse(t, "{\n  \"a\": 1,\n  // @featurelab:x\n  \"b\": 2\n}\n")
	if sameLine[0].JSONPath != "$.a" || ownLine[0].JSONPath != "$.b" {
		t.Fatalf("same line -> %s, own line -> %s; want $.a and $.b",
			sameLine[0].JSONPath, ownLine[0].JSONPath)
	}
}

func TestParseAnnotations_CommentWithNothingAfterItBelongsToItsContainer(t *testing.T) {
	assertPaths(t, "{\n  \"a\": {\n    \"b\": 1\n    // @featurelab:note\n  },\n  \"c\": 2\n}\n",
		"note -> $.a")
}

// TestParseAnnotations_IndentationDoesNotDecideAttachment pins the deliberate choice in the
// ambiguous case: a comment indented as if it belonged inside a block, but written after that
// block closed, attaches where its bytes are.
func TestParseAnnotations_IndentationDoesNotDecideAttachment(t *testing.T) {
	assertPaths(t, "{\n  \"a\": {\n    \"b\": 1\n  },\n    // @featurelab:note\n  \"c\": 2\n}\n",
		"note -> $.c")
}

func TestParseAnnotations_CommentOutsideTheDocumentBelongsToTheRoot(t *testing.T) {
	assertPaths(t, "// @featurelab:header\n{\n  \"a\": 1\n}\n", "header -> $")
	assertPaths(t, "{\n  \"a\": 1\n}\n// @featurelab:footer\n", "footer -> $")
}

func TestParseAnnotations_CommentBetweenAKeyAndItsValueBelongsToTheMember(t *testing.T) {
	assertPaths(t, "{\n  \"a\": /* @featurelab:x */ 1,\n  \"b\": 2\n}\n", "x -> $.a")
	assertPaths(t, "{\n  \"a\":\n  // @featurelab:x\n  1\n}\n", "x -> $.a")
}

func TestParseAnnotations_CommentInsideAnEmptyContainerBelongsToIt(t *testing.T) {
	assertPaths(t, "{\n  \"a\": {\n    // @featurelab:x\n  }\n}\n", "x -> $.a")
	assertPaths(t, "{\n  \"a\": [\n    // @featurelab:x\n  ]\n}\n", "x -> $.a")
}

func TestParseAnnotations_ArrayElements(t *testing.T) {
	assertPaths(t, "[\n  1,\n  // @featurelab:above\n  2,\n  3 // @featurelab:trailing\n]\n",
		"above -> $[1]", "trailing -> $[2]")
}

func TestParseAnnotations_NestedArraysAddressTheInnerElement(t *testing.T) {
	assertPaths(t, "{\n  \"a\": [[1, /* @featurelab:x */ 2], [3]]\n}\n", "x -> $.a[0][0]")
}

// TestParseAnnotations_EdgeInsideAListOfDelegations is the shape the graph editor actually reads:
// a directive on one entry of a sequence_feature must name that entry, not the list.
func TestParseAnnotations_EdgeInsideAListOfDelegations(t *testing.T) {
	src := "{\n" +
		"  \"minecraft:sequence_feature\": {\n" +
		"    \"features\": [\n" +
		"      \"a:first\",\n" +
		"      // @featurelab:ignore inactive-branch\n" +
		"      \"a:second\"\n" +
		"    ]\n" +
		"  }\n" +
		"}\n"
	assertPaths(t, src, "ignore -> $.minecraft:sequence_feature.features[1]")
}

// TestParseAnnotations_ContractExample walks the example from wire.Annotation's own doc comment
// end to end: several directives in one run, free text under the first of them, and a trailing
// directive on a value's line.
func TestParseAnnotations_ContractExample(t *testing.T) {
	src := "{\n" +
		"  // @featurelab:layout 340 120\n" +
		"  \"minecraft:tree_feature\": {\n" +
		"    \"description\": { \"identifier\": \"x:y\" },\n" +
		"    // @featurelab:ignore inactive-branch\n" +
		"    //   this branch is chunk-parity gated and is false at the preview origin\n" +
		"    // @featurelab:origin 128 70 128\n" +
		"    \"places_feature\": \"x:z\" // @featurelab:idiom setup-script\n" +
		"  }\n" +
		"}\n"

	layoutStart, layoutEnd := spanOf(t, src, "@featurelab:layout 340 120")
	ignoreStart, ignoreEnd := spanOf(t, src, "@featurelab:ignore inactive-branch")
	originStart, originEnd := spanOf(t, src, "@featurelab:origin 128 70 128")
	idiomStart, idiomEnd := spanOf(t, src, "@featurelab:idiom setup-script")

	want := []Annotation{
		{
			Name: "layout", Args: []string{"340", "120"},
			JSONPath: "$.minecraft:tree_feature", Line: 2,
			Offset: layoutStart, EndOffset: layoutEnd,
		},
		{
			Name:      "ignore",
			Args:      []string{"inactive-branch"},
			Text:      "this branch is chunk-parity gated and is false at the preview origin",
			JSONPath:  "$.minecraft:tree_feature.places_feature",
			Line:      5,
			Offset:    ignoreStart,
			EndOffset: ignoreEnd,
		},
		{
			Name: "origin", Args: []string{"128", "70", "128"},
			JSONPath: "$.minecraft:tree_feature.places_feature", Line: 7,
			Offset: originStart, EndOffset: originEnd,
		},
		{
			Name: "idiom", Args: []string{"setup-script"},
			JSONPath: "$.minecraft:tree_feature.places_feature", Line: 8,
			Offset: idiomStart, EndOffset: idiomEnd,
		},
	}
	got := mustParse(t, src)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got:\n%#v\nwant:\n%#v", got, want)
	}
}

// TestParseAnnotations_OneRunAttachesAsAUnit pins why attachment is computed from the run's first
// byte: two directives written together are about the same thing, and must not be split across
// two nodes by the line one of them happens to sit on.
func TestParseAnnotations_OneRunAttachesAsAUnit(t *testing.T) {
	src := "{\n  \"a\": 1, // @featurelab:first\n  // @featurelab:second\n  \"b\": 2\n}\n"
	assertPaths(t, src, "first -> $.a", "second -> $.a")
}

func TestParseAnnotations_ABlankLineEndsTheRun(t *testing.T) {
	src := "{\n  \"a\": 1, // @featurelab:first\n\n  // @featurelab:second\n  \"b\": 2\n}\n"
	assertPaths(t, src, "first -> $.a", "second -> $.b")
}

func TestParseAnnotations_TextRunsUntilTheNextDirective(t *testing.T) {
	src := "{\n" +
		"  // @featurelab:one\n" +
		"  // reason for one\n" +
		"  // still reason for one\n" +
		"  // @featurelab:two\n" +
		"  // reason for two\n" +
		"  \"a\": 1\n" +
		"}\n"
	got := mustParse(t, src)
	if got[0].Text != "reason for one\nstill reason for one" {
		t.Fatalf("first Text = %q", got[0].Text)
	}
	if got[1].Text != "reason for two" {
		t.Fatalf("second Text = %q", got[1].Text)
	}
}

func TestParseAnnotations_TextIgnoresProseBeforeTheFirstDirective(t *testing.T) {
	src := "{\n  // an ordinary comment\n  // @featurelab:x\n  \"a\": 1\n}\n"
	got := mustParse(t, src)
	if len(got) != 1 || got[0].Text != "" {
		t.Fatalf("got %#v; prose above a directive is not its Text", got)
	}
}

func TestParseAnnotations_BlockComment(t *testing.T) {
	src := "{\n" +
		"  /*\n" +
		"   * @featurelab:one a b\n" +
		"   * why one\n" +
		"   * @featurelab:two\n" +
		"   */\n" +
		"  \"a\": 1\n" +
		"}\n"
	got := mustParse(t, src)
	oneStart, oneEnd := spanOf(t, src, "@featurelab:one a b")
	twoStart, twoEnd := spanOf(t, src, "@featurelab:two")
	want := []Annotation{
		{
			Name: "one", Args: []string{"a", "b"}, Text: "why one",
			JSONPath: "$.a", Line: 3, Offset: oneStart, EndOffset: oneEnd,
		},
		{Name: "two", JSONPath: "$.a", Line: 5, Offset: twoStart, EndOffset: twoEnd},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got:\n%#v\nwant:\n%#v", got, want)
	}
}

// TestParseAnnotations_BlockCommentKeepsALeadingStarThatIsNotAMarker guards the continuation-marker
// stripping from eating an author's text.
func TestParseAnnotations_BlockCommentKeepsALeadingStarThatIsNotAMarker(t *testing.T) {
	src := "{\n  /* @featurelab:x\n     *emphasis* matters\n  */\n  \"a\": 1\n}\n"
	got := mustParse(t, src)
	if got[0].Text != "*emphasis* matters" {
		t.Fatalf("Text = %q, want %q", got[0].Text, "*emphasis* matters")
	}
}

func TestParseAnnotations_ArgsAreWhitespaceSplitAndNilWhenAbsent(t *testing.T) {
	got := mustParse(t, "{\n  // @featurelab:origin   128\t70  128\n  // @featurelab:bare\n  \"a\": 1\n}\n")
	if !reflect.DeepEqual(got[0].Args, []string{"128", "70", "128"}) {
		t.Fatalf("Args = %#v", got[0].Args)
	}
	if got[1].Args != nil {
		t.Fatalf("Args = %#v, want nil for a directive with no arguments", got[1].Args)
	}
}

func TestParseAnnotations_NameCharacterSet(t *testing.T) {
	got := mustParse(t, "{\n  // @featurelab:layout.v2_beta-1 x\n  \"a\": 1\n}\n")
	if got[0].Name != "layout.v2_beta-1" || !reflect.DeepEqual(got[0].Args, []string{"x"}) {
		t.Fatalf("got Name %q Args %#v", got[0].Name, got[0].Args)
	}
}

// TestParseAnnotations_ADirectiveMustStartTheLine is why prose can mention a directive without
// becoming one. Without the rule, every comment discussing the mechanism would fire it.
func TestParseAnnotations_ADirectiveMustStartTheLine(t *testing.T) {
	for name, src := range map[string]string{
		"mid sentence": "{\n  // superseded by @featurelab:ignore below\n  \"a\": 1\n}\n",
		"no name":      "{\n  // @featurelab: \n  \"a\": 1\n}\n",
		"wrong prefix": "{\n  // @featurelab.ignore x\n  \"a\": 1\n}\n",
	} {
		t.Run(name, func(t *testing.T) {
			if got := mustParse(t, src); len(got) != 0 {
				t.Fatalf("got %#v, want no annotations", got)
			}
		})
	}
}

// TestParseAnnotations_DirectiveInsideAStringIsNotADirective: the value is data the game reads,
// not a comment, and must never be interpreted as editor state.
func TestParseAnnotations_DirectiveInsideAStringIsNotADirective(t *testing.T) {
	for _, src := range []string{
		"{\n  \"a\": \"// @featurelab:x\"\n}\n",
		"{\n  \"a\": \"/* @featurelab:x */\"\n}\n",
		"{\n  \"@featurelab:x\": 1\n}\n",
		"{\n  \"a\": \"say \\\" // @featurelab:x\"\n}\n",
	} {
		if got := mustParse(t, src); len(got) != 0 {
			t.Fatalf("%q produced %#v, want no annotations", src, got)
		}
	}
}

func TestParseAnnotations_LineNumbersAre1BasedAndSurviveCRLF(t *testing.T) {
	lf := mustParse(t, "{\n\n\n  // @featurelab:x\n  \"a\": 1\n}\n")
	crlf := mustParse(t, "{\r\n\r\n\r\n  // @featurelab:x\r\n  \"a\": 1\r\n}\r\n")
	if lf[0].Line != 4 || crlf[0].Line != 4 {
		t.Fatalf("lines: lf %d, crlf %d, want 4 and 4", lf[0].Line, crlf[0].Line)
	}
	if crlf[0].JSONPath != "$.a" {
		t.Fatalf("crlf path = %q, want $.a", crlf[0].JSONPath)
	}
}

// TestParseAnnotations_CRLFDoesNotLeakIntoText: the '\r' of a CRLF line ending is part of the line
// ending, not part of the comment, and must not end up in a string the editor displays.
func TestParseAnnotations_CRLFDoesNotLeakIntoText(t *testing.T) {
	got := mustParse(t, "{\r\n  // @featurelab:x\r\n  // a reason\r\n  \"a\": 1\r\n}\r\n")
	if got[0].Text != "a reason" {
		t.Fatalf("Text = %q, want %q", got[0].Text, "a reason")
	}
}

// TestParseAnnotations_UnparsableDocumentStillYieldsDirectives is the mid-edit case: the file in
// the editor is broken half the time it is being read, and losing every annotation until it parses
// again would make the panel flicker empty while someone types.
func TestParseAnnotations_UnparsableDocumentStillYieldsDirectives(t *testing.T) {
	for name, src := range map[string]string{
		"only a comment": "// @featurelab:x note\n",
		"unclosed":       "{\n  // @featurelab:x note\n  \"a\": 1\n",
		"trailing comma": "{\n  // @featurelab:x note\n  \"a\": 1,\n}\n",
	} {
		t.Run(name, func(t *testing.T) {
			got, err := ParseAnnotations([]byte(src))
			if err == nil {
				t.Fatal("expected an error reporting why the paths are not trustworthy")
			}
			if len(got) != 1 || got[0].Name != "x" || !reflect.DeepEqual(got[0].Args, []string{"note"}) {
				t.Fatalf("got %#v", got)
			}
			if got[0].JSONPath != "$" {
				t.Fatalf("JSONPath = %q, want the %q fallback", got[0].JSONPath, "$")
			}
		})
	}
}

// TestParseAnnotations_DuplicateKeysShareOnePath documents a limit of the path dialect rather than
// a behaviour anyone wants: two members with one key cannot be told apart by path.
func TestParseAnnotations_DuplicateKeysShareOnePath(t *testing.T) {
	src := "{\n  // @featurelab:first\n  \"a\": 1,\n  // @featurelab:second\n  \"a\": 2\n}\n"
	assertPaths(t, src, "first -> $.a", "second -> $.a")
}

func TestParseAnnotations_KeysThatNeedQuotingInAPath(t *testing.T) {
	assertPaths(t, "{\n  // @featurelab:x\n  \"a.b\": 1\n}\n", `x -> $["a.b"]`)
	assertPaths(t, "{\n  // @featurelab:x\n  \"\": 1\n}\n", `x -> $[""]`)
	assertPaths(t, "{\n  // @featurelab:x\n  \"日本語\": 1\n}\n", "x -> $.日本語")
}

func TestParseAnnotations_NoCommentsMeansNoAnnotations(t *testing.T) {
	got, err := ParseAnnotations([]byte("{\"a\": 1}"))
	if err != nil || got != nil {
		t.Fatalf("got %#v, %v", got, err)
	}
}

// TestParseAnnotations_SpanCoversTheDirectiveAndNothingAround pins where the span stops in every
// comment shape the package accepts. The markers, the indentation and the free text are all
// outside it, so writing over the span changes the directive and leaves the comment intact.
func TestParseAnnotations_SpanCoversTheDirectiveAndNothingAround(t *testing.T) {
	for name, tc := range map[string]struct{ src, want string }{
		"line comment":       {"{\n  // @featurelab:x a b\n  \"a\": 1\n}\n", "@featurelab:x a b"},
		"inline block":       {"{\n  /* @featurelab:x a b */\n  \"a\": 1\n}\n", "@featurelab:x a b"},
		"starred block":      {"{\n  /*\n   * @featurelab:x a b\n   */\n  \"a\": 1\n}\n", "@featurelab:x a b"},
		"trailing on a line": {"{\n  \"a\": 1 // @featurelab:x a b\n}\n", "@featurelab:x a b"},
		"crlf":               {"{\r\n  // @featurelab:x a b\r\n  \"a\": 1\r\n}\r\n", "@featurelab:x a b"},
		"tab indented":       {"{\n\t// @featurelab:x a b\n\t\"a\": 1\n}\n", "@featurelab:x a b"},
		"padded":             {"{\n  //    @featurelab:x a b   \n  \"a\": 1\n}\n", "@featurelab:x a b"},
		"followed by text":   {"{\n  // @featurelab:x a b\n  // a reason\n  \"a\": 1\n}\n", "@featurelab:x a b"},
		"no arguments":       {"{\n  // @featurelab:x\n  \"a\": 1\n}\n", "@featurelab:x"},
		"unterminated block": {"{\n  \"a\": 1\n}\n/* @featurelab:x a b", "@featurelab:x a b"},
	} {
		t.Run(name, func(t *testing.T) {
			got, _ := ParseAnnotations([]byte(tc.src))
			if len(got) != 1 {
				t.Fatalf("got %d annotations, want 1", len(got))
			}
			if slice := tc.src[got[0].Offset:got[0].EndOffset]; slice != tc.want {
				t.Fatalf("span cut out %q, want %q", slice, tc.want)
			}
		})
	}
}

// TestParseAnnotations_BareCarriageReturnEndsALineInsideABlockComment: a line ending is a line
// ending whichever convention produced it, and a bare '\r' left inside a directive would put a
// line break inside the span an editor writes over -- which, in a "//" comment, would turn the
// remainder into JSON the game then has to parse.
func TestParseAnnotations_BareCarriageReturnEndsALineInsideABlockComment(t *testing.T) {
	src := "{\n  /* @featurelab:x a\rwhy x */\n  \"a\": 1\n}\n"
	got := mustParse(t, src)
	if len(got) != 1 || !reflect.DeepEqual(got[0].Args, []string{"a"}) || got[0].Text != "why x" {
		t.Fatalf("got %#v", got)
	}
	if slice := src[got[0].Offset:got[0].EndOffset]; slice != "@featurelab:x a" {
		t.Fatalf("span cut out %q", slice)
	}
}

// TestParseAnnotations_SpanIsWhatSuppressesAFalseWarning is the workflow the span was added for:
// the editor finds the directive it wants to change, writes over exactly those bytes, and the rest
// of the file -- comments, layout, the JSON itself -- comes through untouched.
func TestParseAnnotations_SpanIsWhatSuppressesAFalseWarning(t *testing.T) {
	src := "{\n" +
		"  // @featurelab:ignore inactive-branch\n" +
		"  //   false at the preview origin\n" +
		"  \"places_feature\": \"a:b\" // @featurelab:layout 10 20\n" +
		"}\n"

	before := mustParse(t, src)
	target := before[0]
	if target.Name != "ignore" {
		t.Fatalf("fixture drifted: first annotation is %q", target.Name)
	}

	out := src[:target.Offset] + "@featurelab:ignore chunk-parity" + src[target.EndOffset:]
	after := mustParse(t, out)

	if !reflect.DeepEqual(after[0].Args, []string{"chunk-parity"}) {
		t.Fatalf("rewritten directive reads back as %#v", after[0].Args)
	}
	if after[0].Text != "false at the preview origin" || after[0].JSONPath != "$.places_feature" {
		t.Fatalf("rewrite disturbed the annotation around it: %#v", after[0])
	}
	if !reflect.DeepEqual(after[1], Annotation{
		Name: "layout", Args: []string{"10", "20"}, JSONPath: "$.places_feature", Line: 4,
		Offset: after[1].Offset, EndOffset: after[1].EndOffset,
	}) {
		t.Fatalf("rewrite disturbed the other annotation: %#v", after[1])
	}
	if _, err := Apply([]byte(out)); err != nil {
		t.Fatalf("rewrite broke the document: %v", err)
	}

	// Only the directive's own bytes moved: everything on either side is identical.
	if out[:target.Offset] != src[:target.Offset] || out[len(out)-len(src)+target.EndOffset:] != src[target.EndOffset:] {
		t.Fatalf("bytes outside the span changed:\n%q\n%q", src, out)
	}
}

// TestParseAnnotations_SpanIsExactEvenWhenTheDocumentDoesNotScan: the span needs no parse, and the
// file is at its most broken exactly while someone is editing it -- which is when the editor most
// needs to be able to write a directive.
func TestParseAnnotations_SpanIsExactEvenWhenTheDocumentDoesNotScan(t *testing.T) {
	src := "{\n  // @featurelab:ignore inactive-branch\n  \"a\": 1,\n}\n"
	got, err := ParseAnnotations([]byte(src))
	if err == nil {
		t.Fatal("fixture should not scan: it has a trailing comma")
	}
	assertSpansSliceBack(t, src, got)
	if got[0].JSONPath != "$" {
		t.Fatalf("JSONPath = %q, want the %q fallback", got[0].JSONPath, "$")
	}
}

// TestParseAnnotations_EveryPathIsUsableByTheWriter closes the loop between the two halves of the
// package: an annotation's JSONPath is only worth reporting if the writer can act on it, so every
// path this parser produces must parse AND resolve to something Apply can edit.
func TestParseAnnotations_EveryPathIsUsableByTheWriter(t *testing.T) {
	src := "{\n" +
		"  // @featurelab:a\n" +
		"  \"minecraft:scatter_feature\": {\n" +
		"    \"places_feature\": \"x:y\", // @featurelab:b\n" +
		"    \"a.b\": [\n" +
		"      1,\n" +
		"      // @featurelab:c\n" +
		"      2\n" +
		"      // @featurelab:d\n" +
		"    ]\n" +
		"    // @featurelab:e\n" +
		"  }\n" +
		"}\n" +
		"// @featurelab:f\n"

	for _, a := range mustParse(t, src) {
		if _, err := ParsePath(a.JSONPath); err != nil {
			t.Fatalf("%s produced an unparsable path %q: %v", a.Name, a.JSONPath, err)
		}
		if _, err := Apply([]byte(src), Edit{Path: a.JSONPath, Value: []byte("0")}); err != nil {
			t.Fatalf("%s produced a path the writer cannot resolve (%q): %v", a.Name, a.JSONPath, err)
		}
	}
}

// TestParseAnnotations_SurvivesEditingTheDocument is the workflow in miniature: read the
// annotations, write through one of the paths they named, and read them back. Nothing may move,
// because the writer changed only the bytes under that one path.
func TestParseAnnotations_SurvivesEditingTheDocument(t *testing.T) {
	src := "{\n" +
		"  // @featurelab:layout 10 20\n" +
		"  \"a\": 1,\n" +
		"  \"b\": 2 // @featurelab:ignore why\n" +
		"}\n"
	before := mustParse(t, src)

	out, err := Apply([]byte(src), Edit{Path: "$.a", Value: []byte("42")})
	if err != nil {
		t.Fatal(err)
	}
	after := mustParse(t, string(out))

	if len(before) != len(after) {
		t.Fatalf("annotation count changed: %d -> %d", len(before), len(after))
	}
	for i := range before {
		b, a := before[i], after[i]
		// The span is the one field that is SUPPOSED to move: the edit made the value one
		// byte longer, so everything after it slid. What must not change is what the span
		// cuts out, which is the real claim -- the span still bounds the same directive.
		if src[b.Offset:b.EndOffset] != string(out[a.Offset:a.EndOffset]) {
			t.Fatalf("span %d stopped bounding its directive: %q -> %q",
				i, src[b.Offset:b.EndOffset], out[a.Offset:a.EndOffset])
		}
		b.Offset, b.EndOffset = a.Offset, a.EndOffset
		if !reflect.DeepEqual(b, a) {
			t.Fatalf("editing a value moved annotation %d:\nbefore %#v\nafter  %#v", i, b, a)
		}
	}
	if !strings.Contains(string(out), "\"a\": 42") {
		t.Fatalf("the edit did not land: %q", out)
	}
}

// assertInsertion is the whole claim about inserting, in one place: the directive comes back
// attached to the path it was asked for, the document still parses, and every byte that was
// already in the file is still there, in order, with only the inserted run of bytes between them.
func assertInsertion(t *testing.T, src, jsonPath, name string, args ...string) string {
	t.Helper()

	p, err := AnnotationPointFor([]byte(src), jsonPath)
	if err != nil {
		t.Fatalf("AnnotationPointFor(%s): %v", jsonPath, err)
	}
	outB, err := InsertAnnotation([]byte(src), jsonPath, name, args...)
	if err != nil {
		t.Fatalf("InsertAnnotation(%s): %v", jsonPath, err)
	}
	out := string(outB)

	if out[:p.Offset] != src[:p.Offset] || out[len(out)-(len(src)-p.Offset):] != src[p.Offset:] {
		t.Fatalf("insertion at %s disturbed bytes outside it:\n src %q\n out %q", jsonPath, src, out)
	}
	if _, err := Apply(outB); err != nil {
		t.Fatalf("insertion at %s broke the document (%v): %q", jsonPath, err, out)
	}

	anns, err := ParseAnnotations(outB)
	if err != nil {
		t.Fatalf("re-reading after inserting at %s: %v", jsonPath, err)
	}
	var found *Annotation
	for i := range anns {
		if anns[i].Name == name {
			found = &anns[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("inserting at %s produced no readable directive: %q", jsonPath, out)
	}
	if found.JSONPath != jsonPath {
		t.Fatalf("inserted at %s but it reads back on %s: %q", jsonPath, found.JSONPath, out)
	}
	if !reflect.DeepEqual(found.Args, argsOrNil(args)) {
		t.Fatalf("Args = %#v, want %#v", found.Args, argsOrNil(args))
	}
	if found.Line != p.Line {
		t.Fatalf("AnnotationPoint.Line = %d but the directive landed on line %d", p.Line, found.Line)
	}
	assertSpansSliceBack(t, out, anns)
	return out
}

func argsOrNil(args []string) []string {
	if len(args) == 0 {
		return nil
	}
	return args
}

// TestInsertAnnotation_OnANodeThatHasNoAnnotationYet is the workflow the insertion point exists
// for: a wrong "dead branch" warning appears on a node nobody has annotated, the author says it is
// gated rather than dead, and the editor has to write that into the file from nothing.
func TestInsertAnnotation_OnANodeThatHasNoAnnotationYet(t *testing.T) {
	src := "{\n" +
		"  \"format_version\": \"1.13.0\",\n" +
		"  \"minecraft:conditional_list\": {\n" +
		"    \"conditional_features\": [\n" +
		"      {\n" +
		"        \"places_feature\": \"a:gated\",\n" +
		"        \"condition\": \"math.mod(v.originx, 32) == 0\"\n" +
		"      }\n" +
		"    ]\n" +
		"  }\n" +
		"}\n"

	path := "$.minecraft:conditional_list.conditional_features[0].places_feature"
	out := assertInsertion(t, src, path, "ignore", "inactive-branch")

	want := "{\n" +
		"  \"format_version\": \"1.13.0\",\n" +
		"  \"minecraft:conditional_list\": {\n" +
		"    \"conditional_features\": [\n" +
		"      {\n" +
		"        // @featurelab:ignore inactive-branch\n" +
		"        \"places_feature\": \"a:gated\",\n" +
		"        \"condition\": \"math.mod(v.originx, 32) == 0\"\n" +
		"      }\n" +
		"    ]\n" +
		"  }\n" +
		"}\n"
	if out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
}

// TestInsertAnnotation_LandsOnTheRequestedPathInEveryShape walks the layouts a hand-written pack
// file actually uses. Each case is one where a naive "comment on the line above" is either
// impossible or lands somewhere else.
func TestInsertAnnotation_LandsOnTheRequestedPathInEveryShape(t *testing.T) {
	for name, tc := range map[string]struct{ src, path string }{
		"own line":            {"{\n  \"a\": 1,\n  \"b\": 2\n}\n", "$.b"},
		"first member":        {"{\n  \"a\": 1,\n  \"b\": 2\n}\n", "$.a"},
		"container member":    {"{\n  \"a\": {\n    \"b\": 1\n  }\n}\n", "$.a"},
		"array element":       {"{\n  \"a\": [\n    1,\n    2\n  ]\n}\n", "$.a[1]"},
		"tabs":                {"{\n\t\"a\": 1,\n\t\"b\": 2\n}\n", "$.b"},
		"crlf":                {"{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n", "$.b"},
		"no trailing newline": {"{\n  \"a\": 1\n}", "$.a"},
		"inline member":       {"{\"a\": 1, \"b\": 2}", "$.b"},
		"inline first member": {"{\"a\": 1, \"b\": 2}", "$.a"},
		"inline array":        {"{\n  \"a\": [1, 2]\n}\n", "$.a[1]"},
		"inline array first":  {"{\n  \"a\": [1, 2]\n}\n", "$.a[0]"},
		"zero indent":         {"{\n\"a\": 1,\n\"b\": 2\n}\n", "$.b"},
		"key needing quotes":  {"{\n  \"a.b\": 1\n}\n", `$["a.b"]`},
		"root":                {"{\n  \"a\": 1\n}\n", "$"},
		"root one line":       {"{\"a\": 1}", "$"},
		"scalar root":         {"42", "$"},
		"array root":          {"[\n  1,\n  2\n]\n", "$[0]"},
		"nested deep":         {"{\n  \"a\": [\n    {\n      \"b\": [1]\n    }\n  ]\n}\n", "$.a[0].b[0]"},
		"value on next line":  {"{\n  \"a\":\n    1\n}\n", "$.a"},
	} {
		t.Run(name, func(t *testing.T) {
			assertInsertion(t, tc.src, tc.path, "ignore", "inactive-branch")
		})
	}
}

// TestInsertAnnotation_DoesNotJoinTheRunAbove is the failure this would have shipped with: a
// comment written under a trailing "// note" joins that note's run, and a run attaches as a unit,
// so the new directive would have landed on the PREVIOUS member.
func TestInsertAnnotation_DoesNotJoinTheRunAbove(t *testing.T) {
	src := "{\n  \"a\": 1, // note about a\n  \"b\": 2\n}\n"
	out := assertInsertion(t, src, "$.b", "ignore", "x")
	if !strings.Contains(out, "// note about a") {
		t.Fatalf("the existing comment did not survive: %q", out)
	}
}

// TestInsertAnnotation_JoinsARunThatAlreadyPointsAtTheTarget is the other half of the rule: when
// the run above already attaches to the same path, joining it is right, and the directive goes on
// its own line rather than being pushed into the value.
func TestInsertAnnotation_JoinsARunThatAlreadyPointsAtTheTarget(t *testing.T) {
	src := "{\n  // an existing note about b\n  \"b\": 2\n}\n"
	out := assertInsertion(t, src, "$.b", "ignore", "x")
	want := "{\n  // an existing note about b\n  // @featurelab:ignore x\n  \"b\": 2\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

// TestInsertAnnotation_DetectsAJoinableRunEndingInWhitespace is a regression: "// note " ends in a
// space, so deciding whether a run sits above the insertion point by scanning backwards over
// whitespace walks INTO the comment and never finds its end. The join went undetected and the
// directive landed on the previous member.
func TestInsertAnnotation_DetectsAJoinableRunEndingInWhitespace(t *testing.T) {
	assertInsertion(t, "{\n  \"a\": 1, // note \n\"b\": 2\n}\n", "$.b", "ignore", "x")
}

// TestInsertAnnotation_RootSharingItsLineWithACommentTail is a regression: the root's line start is
// not a safe place to write when the root follows the "*/" of a block comment, because the
// directive would land inside that comment and stop being a directive.
func TestInsertAnnotation_RootSharingItsLineWithACommentTail(t *testing.T) {
	out := assertInsertion(t, "/*\n*/ 42", "$", "ignore", "x")
	if !strings.HasSuffix(out, "42 /* @featurelab:ignore x */") {
		t.Fatalf("got %q", out)
	}
}

// TestInsertAnnotation_InlineEntryTakesABlockCommentAfterItsValue pins the form chosen where a
// "//" comment cannot go: it would turn the rest of the line into a comment.
func TestInsertAnnotation_InlineEntryTakesABlockCommentAfterItsValue(t *testing.T) {
	out := assertInsertion(t, "{\"a\": 1, \"b\": 2}", "$.a", "ignore", "x")
	if out != "{\"a\": 1 /* @featurelab:ignore x */, \"b\": 2}" {
		t.Fatalf("got %q", out)
	}
}

func TestInsertAnnotation_RootTakesALineAboveTheDocument(t *testing.T) {
	out := assertInsertion(t, "{\n  \"a\": 1\n}\n", "$", "layout", "10", "20")
	if out != "// @featurelab:layout 10 20\n{\n  \"a\": 1\n}\n" {
		t.Fatalf("got %q", out)
	}
}

func TestInsertAnnotation_TwoDirectivesInARowBothLandOnTheSamePath(t *testing.T) {
	src := "{\n  \"a\": 1,\n  \"b\": 2\n}\n"
	once := assertInsertion(t, src, "$.b", "ignore", "x")
	twice := assertInsertion(t, once, "$.b", "layout", "10", "20")

	got := mustParse(t, twice)
	if len(got) != 2 || got[0].JSONPath != "$.b" || got[1].JSONPath != "$.b" {
		t.Fatalf("got %#v", got)
	}
}

// TestInsertAnnotation_RejectsWhatTheArgsContractCannotCarry turns a documented limit into an
// enforced one: Args is whitespace-split, so an argument with a space in it would come back as two
// and the caller would find out from a file that no longer says what they wrote.
func TestInsertAnnotation_RejectsWhatTheArgsContractCannotCarry(t *testing.T) {
	src := "{\n  \"a\": 1\n}\n"
	for name, tc := range map[string]struct {
		directive string
		args      []string
	}{
		"space in an argument": {"ignore", []string{"two words"}},
		"tab in an argument":   {"ignore", []string{"two\twords"}},
		"newline in argument":  {"ignore", []string{"two\nwords"}},
		"empty argument":       {"ignore", []string{""}},
		"closes a comment":     {"ignore", []string{"a*/b"}},
		"empty name":           {"", nil},
		"space in the name":    {"two words", nil},
		"colon in the name":    {"feature:lab", nil},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := InsertAnnotation([]byte(src), "$.a", tc.directive, tc.args...); err == nil {
				t.Fatal("expected an error rather than a file that does not say what was asked for")
			}
		})
	}
}

func TestInsertAnnotation_RejectsAPathItCannotAnnotate(t *testing.T) {
	for name, tc := range map[string]struct{ src, path string }{
		"missing key":     {"{\n  \"a\": 1\n}\n", "$.nope"},
		"past the end":    {"[1, 2]", "$[9]"},
		"malformed path":  {"{\n  \"a\": 1\n}\n", "a.b"},
		"broken document": {"{\n  \"a\": 1,\n}\n", "$.a"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := InsertAnnotation([]byte(tc.src), tc.path, "ignore", "x"); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

// TestInsertAnnotation_LandsOnEveryPathInADocument is the exhaustive form of the claim: walk the
// document, ask for an annotation on every single node in it, and require each one to read back on
// the path it was asked for. This is where an attachment rule that works on the shapes someone
// thought to write down gets caught failing on the ones they did not.
func TestInsertAnnotation_LandsOnEveryPathInADocument(t *testing.T) {
	for name, src := range map[string]string{
		"multiline":     "{\n  \"a\": 1,\n  \"b\": [1, {\"c\": 2}],\n  \"d\": {\n    \"e\": [\n      1,\n      2\n    ]\n  }\n}\n",
		"one line":      "{\"a\": 1, \"b\": [1, {\"c\": 2}]}",
		"tabs":          "{\n\t\"a\": 1,\n\t\"b\": [\n\t\t1,\n\t\t2\n\t]\n}\n",
		"crlf":          "{\r\n  \"a\": 1,\r\n  \"b\": [\r\n    1\r\n  ]\r\n}\r\n",
		"with comments": "{\n  // about a\n  \"a\": 1, // trailing a\n  /* about b */\n  \"b\": [1, 2]\n}\n",
		"empty":         "{\n  \"a\": {},\n  \"b\": []\n}\n",
		"nested arrays": "{\n  \"a\": [[1, 2], [3]]\n}\n",
		"duplicate key": "{\n  \"a\": 1,\n  \"a\": 2\n}\n",
		"array root":    "[\n  {\n    \"a\": 1\n  },\n  2\n]\n",
	} {
		t.Run(name, func(t *testing.T) {
			for _, path := range allPaths(t, src) {
				t.Run(path, func(t *testing.T) {
					assertInsertion(t, src, path, "ignore", "inactive-branch")
				})
			}
		})
	}
}

// allPaths enumerates every path in a document, root included, using the same scanner the writer
// uses so the test cannot disagree with the code about what a path is.
func allPaths(t *testing.T, src string) []string {
	t.Helper()
	root, err := scanDocument([]byte(src))
	if err != nil {
		t.Fatalf("fixture does not scan: %v", err)
	}
	var out []string
	var walk func(n *node, segs []PathSegment)
	walk = func(n *node, segs []PathSegment) {
		out = append(out, FormatPath(segs))
		for _, m := range n.members {
			walk(m.value, append(segs, PathSegment{Key: m.key}))
		}
		for i, e := range n.elems {
			walk(e, append(segs, PathSegment{Index: i, IsIndex: true}))
		}
	}
	walk(root, nil)
	return out
}

// FuzzInsertAnnotation_AlwaysLandsOnTheRequestedPath is the exhaustive test again, over documents
// nobody wrote: for every path in whatever the fuzzer produces, insert a directive and require it
// to read back on that path. The attachment rules and the insertion rules are inverses, and this
// is the assertion that they stay inverses on input nobody anticipated.
func FuzzInsertAnnotation_AlwaysLandsOnTheRequestedPath(f *testing.F) {
	for _, src := range corpus {
		f.Add([]byte(src))
	}
	f.Add([]byte("{\n  // about a\n  \"a\": 1, // trailing\n  \"b\": [1, {\"c\": 2}]\n}\n"))
	f.Add([]byte("{\"a\": 1, \"b\": [1, 2]}"))

	f.Fuzz(func(t *testing.T, src []byte) {
		root, err := scanDocument(src)
		if err != nil {
			return // not a document this package claims to read
		}

		var segs [][]PathSegment
		var walk func(n *node, at []PathSegment)
		walk = func(n *node, at []PathSegment) {
			if len(segs) > 32 { // enough coverage per input to stay fast
				return
			}
			segs = append(segs, append([]PathSegment(nil), at...))
			for _, m := range n.members {
				walk(m.value, append(at, PathSegment{Key: m.key}))
			}
			for i, e := range n.elems {
				walk(e, append(at, PathSegment{Index: i, IsIndex: true}))
			}
		}
		walk(root, nil)

		for _, s := range segs {
			path := FormatPath(s)
			out, err := InsertAnnotation(src, path, "ignore", "inactive-branch")
			if err != nil {
				t.Fatalf("InsertAnnotation(%s) on %q: %v", path, src, err)
			}
			if _, err := Apply(out); err != nil {
				t.Fatalf("inserting at %s broke %q -> %q: %v", path, src, out, err)
			}
			anns, err := ParseAnnotations(out)
			if err != nil {
				t.Fatalf("re-reading %q after inserting at %s: %v", out, path, err)
			}
			found := false
			for _, a := range anns {
				if a.Name != "ignore" || !reflect.DeepEqual(a.Args, []string{"inactive-branch"}) {
					continue
				}
				if a.JSONPath == path {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("inserted at %s in %q but it did not read back there: %q\n%#v", path, src, out, anns)
			}
		}
	})
}

// FuzzParseAnnotations_NeverPanicsAndPathsAlwaysParse: this runs over whatever is in a pack, and a
// malformed comment in someone's file must never take the editor down or produce a path the rest
// of the package cannot read back.
func FuzzParseAnnotations_NeverPanicsAndPathsAlwaysParse(f *testing.F) {
	for _, src := range corpus {
		f.Add([]byte(src))
	}
	f.Add([]byte("{\n  // @featurelab:x a b\n  // why\n  \"a\": 1\n}\n"))
	f.Add([]byte("/* @featurelab: */"))
	f.Add([]byte("// @featurelab:x"))

	f.Fuzz(func(t *testing.T, src []byte) {
		anns, err := ParseAnnotations(src)
		for _, a := range anns {
			if a.Name == "" {
				t.Fatalf("annotation with an empty name: %#v", a)
			}
			if a.Line < 1 {
				t.Fatalf("annotation with a non-positive line: %#v", a)
			}
			if _, perr := ParsePath(a.JSONPath); perr != nil {
				t.Fatalf("unparsable path %q from %q: %v", a.JSONPath, src, perr)
			}
			if err != nil && a.JSONPath != "$" {
				t.Fatalf("path %q reported for a document that did not scan", a.JSONPath)
			}
		}
		assertSpansSliceBack(t, string(src), anns)
	})
}

// TestSetAnnotation_InsertsThenRewritesInPlace is the toggle this function exists for: an editor
// records a choice, the author changes their mind, and the second write must change the argument
// rather than produce a second directive of the same name on the same path.
func TestSetAnnotation_InsertsThenRewritesInPlace(t *testing.T) {
	src := "{\n" +
		"  \"minecraft:scatter_feature\": {\n" +
		"    \"distribution\": {\n" +
		"      \"iterations\": \"v.h=4;return 1;\"\n" +
		"    }\n" +
		"  }\n" +
		"}\n"
	path := "$.minecraft:scatter_feature.distribution.iterations"

	first, err := SetAnnotation([]byte(src), path, "molang-format", "keep")
	if err != nil {
		t.Fatalf("SetAnnotation (insert): %v", err)
	}
	want := "{\n" +
		"  \"minecraft:scatter_feature\": {\n" +
		"    \"distribution\": {\n" +
		"      // @featurelab:molang-format keep\n" +
		"      \"iterations\": \"v.h=4;return 1;\"\n" +
		"    }\n" +
		"  }\n" +
		"}\n"
	if string(first) != want {
		t.Fatalf("insert produced:\n%s\nwant:\n%s", first, want)
	}

	second, err := SetAnnotation(first, path, "molang-format", "minify")
	if err != nil {
		t.Fatalf("SetAnnotation (rewrite): %v", err)
	}
	if got := strings.Count(string(second), "@featurelab:molang-format"); got != 1 {
		t.Fatalf("rewriting left %d directives, want 1:\n%s", got, second)
	}
	anns, err := ParseAnnotations(second)
	if err != nil {
		t.Fatalf("re-reading: %v", err)
	}
	if len(anns) != 1 || anns[0].JSONPath != path || !reflect.DeepEqual(anns[0].Args, []string{"minify"}) {
		t.Fatalf("read back %#v, want one molang-format minify on %s", anns, path)
	}
	// The rest of the file is untouched: only the argument moved.
	if string(second) != strings.Replace(want, "keep", "minify", 1) {
		t.Fatalf("rewrite disturbed more than the argument:\n%s", second)
	}
}

// TestSetAnnotation_LeavesOtherDirectivesOnThePathAlone pins the matching rule. Two directives of
// DIFFERENT names on one path is a normal file -- an author's "I know this is gated" sits next to
// an editor's "keep this readable" -- and setting one must not rewrite the other.
func TestSetAnnotation_LeavesOtherDirectivesOnThePathAlone(t *testing.T) {
	src := "{\n" +
		"  // @featurelab:ignore inactive-branch\n" +
		"  // @featurelab:molang-format keep\n" +
		"  \"a\": 1\n" +
		"}\n"
	out, err := SetAnnotation([]byte(src), "$.a", "molang-format", "minify")
	if err != nil {
		t.Fatalf("SetAnnotation: %v", err)
	}
	if !strings.Contains(string(out), "@featurelab:ignore inactive-branch") {
		t.Fatalf("the unrelated directive was lost:\n%s", out)
	}
	if !strings.Contains(string(out), "@featurelab:molang-format minify") {
		t.Fatalf("the directive was not updated:\n%s", out)
	}
}

// TestSetAnnotation_RefusesAnArgumentThatWouldNotSurvive is the contract InsertAnnotation already
// holds, restated here because SetAnnotation has its own path to the file and a rewrite that
// skipped the check would write a broken directive over a good one.
func TestSetAnnotation_RefusesAnArgumentThatWouldNotSurvive(t *testing.T) {
	src := "{\n  // @featurelab:molang-format keep\n  \"a\": 1\n}\n"
	if _, err := SetAnnotation([]byte(src), "$.a", "molang-format", "two words"); err == nil {
		t.Fatal("an argument containing a space was accepted; it would read back as two")
	}
}

// TestRemoveAnnotation_Table is the inverse of SetAnnotation, case by case: what a removal takes
// with it is decided by what else shares the comment and the line, and every one of those
// decisions is pinned here -- including the two line-ending styles, because a removal that turned
// a CRLF file into a mixed one would show up as a whole-file diff in version control.
func TestRemoveAnnotation_Table(t *testing.T) {
	cases := []struct {
		name string
		src  string
		path string
		want string
	}{
		{
			name: "own line above a key goes with its line",
			src:  "{\n  \"a\": 1,\n  // @featurelab:group g expanded Big Trees\n  \"b\": 2\n}\n",
			path: "$.b",
			want: "{\n  \"a\": 1,\n  \"b\": 2\n}\n",
		},
		{
			name: "own line above a key, CRLF file",
			src:  "{\r\n  \"a\": 1,\r\n  // @featurelab:group g expanded Big Trees\r\n  \"b\": 2\r\n}\r\n",
			path: "$.b",
			want: "{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n",
		},
		{
			name: "first line of the file, on the root",
			src:  "// @featurelab:group g collapsed Big Trees\n{\n  \"a\": 1\n}\n",
			path: "$",
			want: "{\n  \"a\": 1\n}\n",
		},
		{
			name: "first line of the file, CRLF",
			src:  "// @featurelab:group g collapsed Big Trees\r\n{\r\n  \"a\": 1\r\n}\r\n",
			path: "$",
			want: "{\r\n  \"a\": 1\r\n}\r\n",
		},
		{
			name: "last line without a line ending loses only its content",
			src:  "{\n  \"a\": 1\n}\n// @featurelab:group g expanded T",
			path: "$",
			want: "{\n  \"a\": 1\n}\n",
		},
		{
			name: "trailing a line of JSON goes with the whitespace before it",
			src:  "{\n  \"a\": 1, // @featurelab:ignore dead-branch\n  \"b\": 2\n}\n",
			path: "$.a",
			want: "{\n  \"a\": 1,\n  \"b\": 2\n}\n",
		},
		{
			name: "block comment after the document, the form AnnotationPointFor writes there",
			src:  "{\n  \"a\": 1\n} /* @featurelab:group g expanded T */\n",
			path: "$",
			want: "{\n  \"a\": 1\n}\n",
		},
		{
			name: "block comment alone on its line goes with the line",
			src:  "{\n  /* @featurelab:group g expanded T */\n  \"a\": 1\n}\n",
			path: "$.a",
			want: "{\n  \"a\": 1\n}\n",
		},
		{
			name: "block comment before content on the line keeps the indentation",
			src:  "{\n  \"a\": /* @featurelab:x */ 1\n}\n",
			path: "$.a",
			want: "{\n  \"a\": 1\n}\n",
		},
		{
			name: "block comment with a continuation marker is still only the directive",
			src:  "{\n  /*\n   * @featurelab:x\n   */\n  \"a\": 1\n}\n",
			path: "$.a",
			want: "{\n  \"a\": 1\n}\n",
		},
		{
			name: "free text on the following line is the author's and stays",
			src:  "{\n  // @featurelab:group g expanded T\n  // because these are the trees\n  \"a\": 1\n}\n",
			path: "$.a",
			want: "{\n  // because these are the trees\n  \"a\": 1\n}\n",
		},
		{
			name: "only the directive on the named path goes, not its namesake elsewhere",
			src:  "{\n  // @featurelab:x one\n  \"a\": 1,\n  // @featurelab:x two\n  \"b\": 2\n}\n",
			path: "$.b",
			want: "{\n  // @featurelab:x one\n  \"a\": 1,\n  \"b\": 2\n}\n",
		},
		{
			name: "a directive that is not there leaves the file exactly alone",
			src:  "{\n  // @featurelab:x\n  \"a\": 1\n}\n",
			path: "$",
			want: "{\n  // @featurelab:x\n  \"a\": 1\n}\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			name := "x"
			if strings.Contains(tc.src, "@featurelab:group") {
				name = "group"
			} else if strings.Contains(tc.src, "@featurelab:ignore") {
				name = "ignore"
			}
			got, err := RemoveAnnotation([]byte(tc.src), tc.path, name)
			if err != nil {
				t.Fatalf("RemoveAnnotation: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("got:\n%q\nwant:\n%q", string(got), tc.want)
			}
			// The bytes that remain must still read as a document, and the directive must be gone
			// from the path it was removed from -- not merely moved.
			after, err := ParseAnnotations(got)
			if err != nil {
				t.Fatalf("the result no longer scans: %v", err)
			}
			for _, a := range after {
				if a.Name == name && a.JSONPath == tc.path && tc.src != tc.want {
					t.Fatalf("the directive is still attached to %s after removal: %#v", tc.path, a)
				}
			}
		})
	}
}

// TestRemoveAnnotation_RefusesToDeleteProse pins the refusal that makes removal safe to offer at
// all: a block comment carrying anything besides the directive is somebody's writing.
func TestRemoveAnnotation_RefusesToDeleteProse(t *testing.T) {
	src := "{\n  /* @featurelab:x\n     the reason this is here */\n  \"a\": 1\n}\n"
	got, err := RemoveAnnotation([]byte(src), "$.a", "x")
	if err == nil {
		t.Fatalf("a block comment holding prose was deleted: %q", string(got))
	}
	if !strings.Contains(err.Error(), "other text") {
		t.Fatalf("the refusal does not say why: %v", err)
	}
}

// TestRemoveAnnotation_RefusesAFileThatDoesNotScan mirrors InsertAnnotation: without paths the
// directive cannot be matched, and removing whichever one has the right name would be a guess.
func TestRemoveAnnotation_RefusesAFileThatDoesNotScan(t *testing.T) {
	if _, err := RemoveAnnotation([]byte("{\n  // @featurelab:x\n  \"a\": \n"), "$.a", "x"); err == nil {
		t.Fatal("a file that does not scan was edited")
	}
}

// TestRemoveAnnotation_UndoesSetAnnotationByteForByte is the round trip the group feature relies
// on: writing a directive on the root and taking it off again must give back the file that was
// there, in both line-ending styles, with no blank line left where the comment was.
func TestRemoveAnnotation_UndoesSetAnnotationByteForByte(t *testing.T) {
	for _, src := range []string{
		"{\n  \"a\": 1\n}\n",
		"{\r\n  \"a\": 1\r\n}\r\n",
		"{\n  \"a\": 1\n}",
	} {
		set, err := SetAnnotation([]byte(src), "$", "group", "trees", "expanded", "Big", "Trees")
		if err != nil {
			t.Fatalf("SetAnnotation: %v", err)
		}
		if string(set) == src {
			t.Fatalf("SetAnnotation changed nothing on %q", src)
		}
		back, err := RemoveAnnotation(set, "$", "group")
		if err != nil {
			t.Fatalf("RemoveAnnotation: %v", err)
		}
		if string(back) != src {
			t.Fatalf("round trip of %q:\n set: %q\nback: %q", src, string(set), string(back))
		}
	}
}
