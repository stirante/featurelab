package jsonc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// corpus is the set of documents every structural claim in this file is checked against. Each one
// is here because it is a way a hand-written pack file differs from what a JSON encoder would
// emit: comments in odd places, CRLF, tabs, no trailing newline, a key written twice, containers
// left empty, values sharing a line.
var corpus = map[string]string{
	"canonical":               "{\n  \"a\": 1,\n  \"b\": [1, 2, 3]\n}\n",
	"no trailing newline":     "{\n  \"a\": 1\n}",
	"crlf":                    "{\r\n  \"a\": 1,\r\n  // note\r\n  \"b\": 2\r\n}\r\n",
	"tabs":                    "{\n\t\"a\": {\n\t\t\"b\": 2\n\t}\n}\n",
	"four spaces":             "{\n    \"a\": 1\n}\n",
	"leading comment":         "// header\n{\n  \"a\": 1\n}\n",
	"trailing comment":        "{\n  \"a\": 1\n}\n// footer\n",
	"comment between":         "{\n  \"a\": /* why */ 1\n}\n",
	"comment before value":    "{\n  \"a\":\n  // why\n  1\n}\n",
	"block comment":           "{\n  /*\n   * a note\n   */\n  \"a\": 1\n}\n",
	"duplicate key":           "{\n  \"a\": 1,\n  \"a\": 2\n}\n",
	"empty object":            "{}\n",
	"empty object multiline":  "{\n}\n",
	"empty array":             "{\n  \"a\": []\n}\n",
	"nested arrays":           "{\n  \"a\": [[1, 2], [3, [4, 5]]]\n}\n",
	"one line":                "{\"a\":1,\"b\":2}",
	"array of objects":        "{\n  \"a\": [\n    { \"b\": 1 },\n    { \"c\": 2 }\n  ]\n}\n",
	"scalar root":             "42",
	"array root":              "[1, 2]\n",
	"string with comment-ish": "{\n  \"url\": \"http://x/*y*/\"\n}\n",
	"unicode key":             "{\n  \"日本語\": \"值\"\n}\n",
	"dotted key":              "{\n  \"a.b\": 1\n}\n",
	"minecraft key":           "{\n  \"minecraft:tree_feature\": { \"places_feature\": \"x\" }\n}\n",
	"ragged whitespace":       "{   \"a\"  :  1 ,\n\n\n      \"b\":2   }\n\n",
	"comment only trailing":   "{\n  \"a\": 1 // trailing\n}\n",
	"unterminated block":      "{\n  \"a\": 1\n}\n/* dangling",
}

// TestApply_NoEditsIsByteIdentical is the property the whole file exists to guarantee: opening a
// document and saving it without changing anything must not produce a diff.
func TestApply_NoEditsIsByteIdentical(t *testing.T) {
	for name, src := range corpus {
		t.Run(name, func(t *testing.T) {
			out, err := Apply([]byte(src))
			if err != nil {
				t.Fatalf("Apply: %v", err)
			}
			if string(out) != src {
				t.Fatalf("round trip changed bytes:\n got: %q\nwant: %q", out, src)
			}
		})
	}
}

// TestApply_CorpusMatchesWhatTheGameAccepts pins the scanner to the same answer StripComments plus
// encoding/json give, so this package can never read a file the loaders would reject, or reject
// one they read.
func TestApply_CorpusMatchesWhatTheGameAccepts(t *testing.T) {
	for name, src := range corpus {
		t.Run(name, func(t *testing.T) {
			_, applyErr := Apply([]byte(src))
			if valid := json.Valid(StripComments([]byte(src))); (applyErr == nil) != valid {
				t.Fatalf("disagreement: Apply err = %v, json.Valid = %v", applyErr, valid)
			}
		})
	}
}

func TestApply_ReplaceScalarTouchesOnlyThatValue(t *testing.T) {
	src := "{\n  // about a\n  \"a\": 1, // trailing\n  \"b\": [1, 2] /* tail */\n}\n"
	out := mustApply(t, src, Edit{Path: "$.a", Value: []byte("99")})
	want := "{\n  // about a\n  \"a\": 99, // trailing\n  \"b\": [1, 2] /* tail */\n}\n"
	if out != want {
		t.Fatalf("got:\n%q\nwant:\n%q", out, want)
	}
}

func TestApply_ReplacePreservesCRLF(t *testing.T) {
	src := "{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n"
	out := mustApply(t, src, Edit{Path: "$.b", Value: []byte("3")})
	want := "{\r\n  \"a\": 1,\r\n  \"b\": 3\r\n}\r\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestApply_MissingTrailingNewlineStaysMissing(t *testing.T) {
	src := "{\n  \"a\": 1\n}"
	out := mustApply(t, src, Edit{Path: "$.a", Value: []byte("2")})
	if strings.HasSuffix(out, "\n") {
		t.Fatalf("Apply added a trailing newline the file did not have: %q", out)
	}
}

func TestApply_ReplaceObjectWithMultilineValueReindentsToItsColumn(t *testing.T) {
	src := "{\n  \"a\": {\n    \"old\": 1\n  }\n}\n"
	// The caller marshals at zero indent, as encoding/json does; Apply places it.
	out := mustApply(t, src, Edit{Path: "$.a", Value: []byte("{\n  \"new\": 2\n}")})
	want := "{\n  \"a\": {\n    \"new\": 2\n  }\n}\n"
	if out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
}

func TestApply_ReindentUsesTabsWhenTheFileDoes(t *testing.T) {
	src := "{\n\t\"a\": 1\n}\n"
	out := mustApply(t, src, Edit{Path: "$.a", Value: []byte("{\n  \"x\": 2\n}")})
	want := "{\n\t\"a\": {\n\t  \"x\": 2\n\t}\n}\n"
	if out != want {
		t.Fatalf("got:\n%q\nwant:\n%q", out, want)
	}
}

func TestApply_DuplicateKeyEditsTheOccurrenceAParserKeeps(t *testing.T) {
	src := "{\n  \"a\": 1,\n  \"a\": 2\n}\n"
	out := mustApply(t, src, Edit{Path: "$.a", Value: []byte("9")})
	want := "{\n  \"a\": 1,\n  \"a\": 9\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	// The claim behind the rule: the edited copy is the one that survives decoding.
	var v map[string]any
	if err := json.Unmarshal(StripComments([]byte(out)), &v); err != nil {
		t.Fatal(err)
	}
	if v["a"] != float64(9) {
		t.Fatalf("decoded a = %v, want 9 -- the edit landed on the copy a parser discards", v["a"])
	}
}

func TestApply_InsertCopiesTheIndentOfItsSiblings(t *testing.T) {
	for name, tc := range map[string]struct{ src, want string }{
		"two space": {"{\n  \"a\": 1\n}\n", "{\n  \"a\": 1,\n  \"b\": 2\n}\n"},
		"tab":       {"{\n\t\"a\": 1\n}\n", "{\n\t\"a\": 1,\n\t\"b\": 2\n}\n"},
		"four":      {"{\n    \"a\": 1\n}\n", "{\n    \"a\": 1,\n    \"b\": 2\n}\n"},
		"crlf":      {"{\r\n  \"a\": 1\r\n}\r\n", "{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n"},
		"inline":    {"{\"a\": 1}", "{\"a\": 1, \"b\": 2}"},
	} {
		t.Run(name, func(t *testing.T) {
			out := mustApply(t, tc.src, Edit{Path: "$.b", Value: []byte("2")})
			if out != tc.want {
				t.Fatalf("got %q, want %q", out, tc.want)
			}
		})
	}
}

func TestApply_InsertIntoEmptyContainer(t *testing.T) {
	for name, tc := range map[string]struct {
		src, path, value, want string
	}{
		"inline object":    {"{}", "$.a", "1", "{\"a\": 1}"},
		"multiline object": {"{\n}\n", "$.a", "1", "{\n  \"a\": 1\n}\n"},
		"nested multiline": {"{\n  \"a\": {\n  }\n}\n", "$.a.b", "1", "{\n  \"a\": {\n    \"b\": 1\n  }\n}\n"},
		"inline array":     {"{\"a\": []}", "$.a[0]", "1", "{\"a\": [1]}"},
		"tab unit":         {"{\n\t\"a\": {\n\t}\n}\n", "$.a.b", "1", "{\n\t\"a\": {\n\t\t\"b\": 1\n\t}\n}\n"},
	} {
		t.Run(name, func(t *testing.T) {
			out := mustApply(t, tc.src, Edit{Path: tc.path, Value: []byte(tc.value)})
			if out != tc.want {
				t.Fatalf("got %q, want %q", out, tc.want)
			}
		})
	}
}

func TestApply_AppendArrayElement(t *testing.T) {
	src := "{\n  \"a\": [\n    1,\n    2\n  ]\n}\n"
	out := mustApply(t, src, Edit{Path: "$.a[2]", Value: []byte("3")})
	want := "{\n  \"a\": [\n    1,\n    2,\n    3\n  ]\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestApply_AppendPastTheEndIsAnError(t *testing.T) {
	if _, err := Apply([]byte("[1]"), Edit{Path: "$[5]", Value: []byte("2")}); err == nil {
		t.Fatal("expected an error for an index past the end of the array")
	}
}

func TestApply_InsertRefusesToInventIntermediateContainers(t *testing.T) {
	if _, err := Apply([]byte("{}"), Edit{Path: "$.a.b", Value: []byte("1")}); err == nil {
		t.Fatal("expected an error: guessing whether $.a should be an object or an array is not this package's call")
	}
}

func TestApply_DeleteRemovesTheEntryAndOneComma(t *testing.T) {
	for name, tc := range map[string]struct{ src, path, want string }{
		"middle member": {"{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n", "$.b", "{\n  \"a\": 1,\n  \"c\": 3\n}\n"},
		"first member":  {"{\n  \"a\": 1,\n  \"b\": 2\n}\n", "$.a", "{\n  \"b\": 2\n}\n"},
		"last member":   {"{\n  \"a\": 1,\n  \"b\": 2\n}\n", "$.b", "{\n  \"a\": 1\n}\n"},
		"only member":   {"{\n  \"a\": 1\n}\n", "$.a", "{\n}\n"},
		"inline last":   {"{\"a\": 1, \"b\": 2}", "$.b", "{\"a\": 1}"},
		"inline first":  {"{\"a\": 1, \"b\": 2}", "$.a", "{\"b\": 2}"},
		"array middle":  {"[\n  1,\n  2,\n  3\n]\n", "$[1]", "[\n  1,\n  3\n]\n"},
		"array last":    {"[\n  1,\n  2\n]\n", "$[1]", "[\n  1\n]\n"},
		"crlf":          {"{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n", "$.a", "{\r\n  \"b\": 2\r\n}\r\n"},
	} {
		t.Run(name, func(t *testing.T) {
			out := mustApply(t, tc.src, Edit{Path: tc.path, Delete: true})
			if out != tc.want {
				t.Fatalf("got %q, want %q", out, tc.want)
			}
			if err := json.Unmarshal(StripComments([]byte(out)), new(any)); err != nil {
				t.Fatalf("delete left invalid JSON %q: %v", out, err)
			}
		})
	}
}

// TestApply_DeleteKeepsTheAuthorsComments pins the deliberate asymmetry: a delete removes the
// entry's bytes, never a neighbouring comment, because silently discarding someone's prose is a
// worse failure than leaving a line they can remove themselves.
func TestApply_DeleteKeepsTheAuthorsComments(t *testing.T) {
	src := "{\n  // about a\n  \"a\": 1,\n  \"b\": 2\n}\n"
	out := mustApply(t, src, Edit{Path: "$.a", Delete: true})
	want := "{\n  // about a\n  \"b\": 2\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestApply_DeleteLeavesATrailingCommentInPlace(t *testing.T) {
	src := "{\n  \"a\": 1, // trailing\n  \"b\": 2\n}\n"
	out := mustApply(t, src, Edit{Path: "$.a", Delete: true})
	want := "{\n   // trailing\n  \"b\": 2\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	if err := json.Unmarshal(StripComments([]byte(out)), new(any)); err != nil {
		t.Fatalf("result does not parse: %v", err)
	}
}

func TestApply_DeleteRootIsRefused(t *testing.T) {
	if _, err := Apply([]byte("{}"), Edit{Path: "$", Delete: true}); err == nil {
		t.Fatal("expected an error: deleting the root would leave an empty file, not a document")
	}
}

func TestApply_EditsAreResolvedAgainstTheOriginalSoOrderDoesNotMatter(t *testing.T) {
	src := "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n"
	forward := mustApply(t, src,
		Edit{Path: "$.a", Value: []byte("\"one\"")},
		Edit{Path: "$.c", Value: []byte("[1, 2, 3]")},
	)
	backward := mustApply(t, src,
		Edit{Path: "$.c", Value: []byte("[1, 2, 3]")},
		Edit{Path: "$.a", Value: []byte("\"one\"")},
	)
	if forward != backward {
		t.Fatalf("argument order changed the result:\n%q\n%q", forward, backward)
	}
	want := "{\n  \"a\": \"one\",\n  \"b\": 2,\n  \"c\": [1, 2, 3]\n}\n"
	if forward != want {
		t.Fatalf("got %q, want %q", forward, want)
	}
}

func TestApply_TwoInsertionsIntoOneObjectLandInArgumentOrder(t *testing.T) {
	src := "{\n  \"a\": 1\n}\n"
	out := mustApply(t, src,
		Edit{Path: "$.b", Value: []byte("2")},
		Edit{Path: "$.c", Value: []byte("3")},
	)
	want := "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestApply_OverlappingEditsAreRefusedRatherThanRaced(t *testing.T) {
	src := "{\n  \"a\": { \"b\": 1 }\n}\n"
	_, err := Apply([]byte(src),
		Edit{Path: "$.a", Value: []byte("2")},
		Edit{Path: "$.a.b", Value: []byte("3")},
	)
	if err == nil {
		t.Fatal("expected an error: one edit replaces the span the other edits")
	}
	if !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("error should name the problem, got %v", err)
	}
}

func TestApply_RejectsAValueThatIsNotJSON(t *testing.T) {
	for name, v := range map[string]string{
		"bare word":      "oops",
		"unbalanced":     "{\"a\": 1",
		"empty":          "",
		"two values":     "1 2",
		"raw newline":    "\"line\nbreak\"",
		"trailing comma": "{\"a\": 1,}",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Apply([]byte("{\"a\": 0}"), Edit{Path: "$.a", Value: []byte(v)}); err == nil {
				t.Fatalf("expected %q to be rejected", v)
			}
		})
	}
}

func TestApply_AcceptsAValueCarryingItsOwnComment(t *testing.T) {
	src := "{\n  \"a\": 1\n}\n"
	out := mustApply(t, src, Edit{Path: "$.b", Value: []byte("// @featurelab:layout 10 20\n2")})
	want := "{\n  \"a\": 1,\n  \"b\": // @featurelab:layout 10 20\n  2\n}\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestApply_RejectsADocumentTheGameWouldReject(t *testing.T) {
	for name, src := range map[string]string{
		"trailing comma": "{\"a\": 1,}",
		"only a comment": "// nothing here\n",
		"empty":          "",
		"two roots":      "{} {}",
		"unclosed":       "{\"a\": 1",
		"bad number":     "{\"a\": 1.2.3}",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Apply([]byte(src)); err == nil {
				t.Fatalf("expected %q to be rejected", src)
			}
		})
	}
}

func TestSyntaxError_PointsAtTheOriginalLine(t *testing.T) {
	src := "{\n  /* a\n     multi-line\n     comment */\n  \"a\": 1,\n}\n"
	_, err := Apply([]byte(src))
	se, ok := err.(*SyntaxError)
	if !ok {
		t.Fatalf("expected *SyntaxError, got %T: %v", err, err)
	}
	if se.Line != 6 {
		t.Fatalf("Line = %d, want 6 (the closing brace after the trailing comma)", se.Line)
	}
	if src[se.Offset] != '}' {
		t.Fatalf("Offset %d points at %q, want the closing brace", se.Offset, src[se.Offset])
	}
}

func TestApply_PathDialectHandlesKeysThatContainDelimiters(t *testing.T) {
	src := "{\n  \"a.b\": 1,\n  \"with space\": 2,\n  \"\": 3,\n  \"minecraft:tree\": 4,\n  \"日本語\": 5\n}\n"
	for path, want := range map[string]string{
		`$["a.b"]`:         "1",
		`$["with space"]`:  "2",
		`$[""]`:            "3",
		`$.minecraft:tree`: "4",
		`$.日本語`:            "5",
	} {
		t.Run(path, func(t *testing.T) {
			out := mustApply(t, src, Edit{Path: path, Value: []byte("0")})
			if strings.Count(out, ": 0") != 1 || strings.Contains(out, ": "+want+",") || strings.HasSuffix(out, ": "+want+"\n}\n") {
				t.Fatalf("edit at %s did not land on the value %s: %q", path, want, out)
			}
		})
	}
}

func TestFormatPath_RoundTripsThroughParsePath(t *testing.T) {
	cases := [][]PathSegment{
		{},
		{{Key: "a"}},
		{{Key: "a"}, {Index: 3, IsIndex: true}, {Key: "b"}},
		{{Key: "minecraft:tree_feature"}},
		{{Key: "a.b"}},
		{{Key: "a[0]"}},
		{{Key: `quo"te`}},
		{{Key: `back\slash`}},
		{{Key: "with space"}},
		{{Key: ""}},
		{{Key: "日本語"}},
		{{Index: 0, IsIndex: true}, {Index: 12, IsIndex: true}},
		{{Key: "123"}},
	}
	for _, segs := range cases {
		p := FormatPath(segs)
		got, err := ParsePath(p)
		if err != nil {
			t.Fatalf("ParsePath(%q): %v", p, err)
		}
		if len(got) != len(segs) {
			t.Fatalf("ParsePath(%q) = %#v, want %#v", p, got, segs)
		}
		for i := range segs {
			if got[i] != segs[i] {
				t.Fatalf("ParsePath(%q)[%d] = %#v, want %#v", p, i, got[i], segs[i])
			}
		}
	}
}

// TestFormatPath_NumericKeyIsNotAnIndex pins the one place the dialect could be ambiguous: an
// object key that looks like a number stays in the dotted form, which only ever means a key.
func TestFormatPath_NumericKeyIsNotAnIndex(t *testing.T) {
	if got := FormatPath([]PathSegment{{Key: "0"}}); got != "$.0" {
		t.Fatalf("FormatPath = %q, want %q", got, "$.0")
	}
	segs, err := ParsePath("$.0")
	if err != nil {
		t.Fatal(err)
	}
	if segs[0].IsIndex {
		t.Fatal("$.0 parsed as an array index, want an object key")
	}
	if segs, _ := ParsePath("$[0]"); !segs[0].IsIndex {
		t.Fatal("$[0] parsed as an object key, want an array index")
	}
}

func TestParsePath_RejectsMalformedPaths(t *testing.T) {
	for _, p := range []string{"", "a", "$.", "$..a", "$[", "$[0", "$[a]", "$[\"a]", "$[\"a\"", "$!", "$[0]x"} {
		if _, err := ParsePath(p); err == nil {
			t.Fatalf("expected %q to be rejected", p)
		}
	}
}

func TestWriteFile_LeavesAnUnchangedFileAlone(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "feature.json")
	src := "{\n  // note\n  \"a\": 1\n}\n"
	if err := os.WriteFile(name, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(name); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("WriteFile rewrote a file it had no changes for; something is always watching these")
	}
}

func TestWriteFile_WritesTheEditAndNothingElse(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "feature.json")
	src := "{\n  // note\n  \"a\": 1\n}\n"
	if err := os.WriteFile(name, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(name, Edit{Path: "$.a", Value: []byte("2")}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  // note\n  \"a\": 2\n}\n"
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("WriteFile left a temporary file behind: %v", entries)
	}
}

// FuzzApply_NoEditsIsByteIdentical is the round-trip property again, but against inputs nobody
// thought to write down. Anything the scanner accepts it must reproduce exactly.
func FuzzApply_NoEditsIsByteIdentical(f *testing.F) {
	for _, src := range corpus {
		f.Add([]byte(src))
	}
	f.Fuzz(func(t *testing.T, src []byte) {
		out, err := Apply(src)

		// The scanner must agree with the loaders in BOTH directions: never accept a file
		// they would refuse (the tool would save something the game cannot load), and never
		// refuse one they read (the tool could not open a working pack). json.Valid, not
		// Unmarshal, is the comparand -- "1E1000" is legal JSON that merely overflows a
		// float64, which is a decoding limit and not a syntax error.
		if valid := json.Valid(StripComments(src)); (err == nil) != valid {
			t.Fatalf("Apply err = %v but json.Valid = %v for %q", err, valid, src)
		}
		if err != nil {
			return
		}
		if string(out) != string(src) {
			t.Fatalf("round trip changed bytes:\n got: %q\nwant: %q", out, src)
		}
	})
}

func mustApply(t *testing.T, src string, edits ...Edit) string {
	t.Helper()
	out, err := Apply([]byte(src), edits...)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := json.Unmarshal(StripComments(out), new(any)); err != nil {
		t.Fatalf("Apply produced JSON the loaders would reject (%v): %q", err, out)
	}
	return string(out)
}
