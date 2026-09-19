package jsonc

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPathPosition_PointsAtTheValue(t *testing.T) {
	src := []byte("{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:aggregate_feature\": 7\n}\n")
	pos, ok := PathPosition(src, `$["minecraft:aggregate_feature"]`)
	if !ok {
		t.Fatal("PathPosition: not found")
	}
	if pos.Line != 3 {
		t.Errorf("Line = %d, want 3", pos.Line)
	}
	// The caret belongs on the value, not on the key in front of it.
	if got := lineText(src, pos.Line)[pos.Column-1:]; !strings.HasPrefix(got, "7") {
		t.Errorf("column %d points at %q, want the value", pos.Column, got)
	}
}

func TestPathPosition_NestedAndIndexed(t *testing.T) {
	src := []byte("{\n  \"a\": {\n    \"b\": [\n      1,\n      2\n    ]\n  }\n}\n")
	pos, ok := PathPosition(src, "$.a.b[1]")
	if !ok {
		t.Fatal("PathPosition: not found")
	}
	if pos.Line != 5 {
		t.Errorf("Line = %d, want 5", pos.Line)
	}
}

func TestPathPosition_MissingPathIsNotFound(t *testing.T) {
	src := []byte(`{"a": 1}`)
	if _, ok := PathPosition(src, "$.b"); ok {
		t.Error("PathPosition reported a position for a path that is not in the document")
	}
}

func TestPathPosition_UnparsableDocumentIsNotFound(t *testing.T) {
	// A trailing comma -- the file is already being reported as invalid JSON, and a position
	// scraped out of it would be a second, weaker statement about the same file.
	if _, ok := PathPosition([]byte(`{"a": 1,}`), "$.a"); ok {
		t.Error("PathPosition reported a position in a document that does not parse")
	}
}

func TestFirstPathPosition_FallsBackToTheParent(t *testing.T) {
	src := []byte("{\n  \"minecraft:feature_rules\": {\n    \"description\": {\n    }\n  }\n}\n")
	pos, ok := FirstPathPosition(src,
		`$["minecraft:feature_rules"].description.identifier`,
		`$["minecraft:feature_rules"].description`,
		`$["minecraft:feature_rules"]`)
	if !ok {
		t.Fatal("FirstPathPosition: not found")
	}
	if pos.Line != 3 {
		t.Errorf("Line = %d, want 3 (the description object, since identifier is absent)", pos.Line)
	}
}

func TestFirstPathPosition_NoneOfThemExist(t *testing.T) {
	if _, ok := FirstPathPosition([]byte(`{"a":1}`), "$.b", "$.c"); ok {
		t.Error("FirstPathPosition reported a position with no candidate present")
	}
}

func TestDuplicateKeys_ReportsBothOccurrences(t *testing.T) {
	src := []byte("{\n  \"a\": 1,\n  \"b\": 2,\n  \"a\": 3\n}\n")
	got := DuplicateKeys(src)
	if len(got) != 1 {
		t.Fatalf("DuplicateKeys = %+v, want exactly one", got)
	}
	d := got[0]
	if d.Key != "a" || d.Path != "$.a" {
		t.Errorf("Key/Path = %q/%q, want \"a\"/\"$.a\"", d.Key, d.Path)
	}
	if d.First.Line != 2 {
		t.Errorf("First.Line = %d, want 2", d.First.Line)
	}
	if d.Last.Line != 4 {
		t.Errorf("Last.Line = %d, want 4", d.Last.Line)
	}
}

func TestDuplicateKeys_AgreesWithWhatTheDecoderKeeps(t *testing.T) {
	// The whole point of the finding: the value the game (and encoding/json) keeps is the LAST
	// one, so the position called Last has to be the one that won.
	src := []byte("{\n  \"a\": 1,\n  \"a\": 3\n}\n")
	var decoded map[string]any
	if err := json.Unmarshal(src, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded["a"] != float64(3) {
		t.Fatalf("decoded a = %v, want the last occurrence", decoded["a"])
	}
	d := DuplicateKeys(src)[0]
	if !strings.Contains(lineText(src, d.Last.Line), "3") {
		t.Errorf("Last points at line %d (%q), want the occurrence the decoder kept", d.Last.Line, lineText(src, d.Last.Line))
	}
}

func TestDuplicateKeys_Nested(t *testing.T) {
	src := []byte("{\n  \"outer\": {\n    \"k\": 1,\n    \"k\": 2\n  }\n}\n")
	got := DuplicateKeys(src)
	if len(got) != 1 {
		t.Fatalf("DuplicateKeys = %+v, want one", got)
	}
	if got[0].Path != "$.outer.k" {
		t.Errorf("Path = %q, want $.outer.k", got[0].Path)
	}
}

func TestDuplicateKeys_InsideAnArrayElement(t *testing.T) {
	src := []byte("{\n  \"list\": [\n    {\"k\": 1, \"k\": 2}\n  ]\n}\n")
	got := DuplicateKeys(src)
	if len(got) != 1 {
		t.Fatalf("DuplicateKeys = %+v, want one", got)
	}
	if got[0].Path != "$.list[0].k" {
		t.Errorf("Path = %q, want $.list[0].k", got[0].Path)
	}
}

func TestDuplicateKeys_SiblingPathsDoNotAlias(t *testing.T) {
	// Two sibling objects each holding a duplicate: if the walk shared one path slice, the second
	// finding would carry the first's key.
	src := []byte("{\n  \"a\": {\"k\": 1, \"k\": 2},\n  \"b\": {\"m\": 1, \"m\": 2}\n}\n")
	got := DuplicateKeys(src)
	if len(got) != 2 {
		t.Fatalf("DuplicateKeys = %+v, want two", got)
	}
	if got[0].Path != "$.a.k" || got[1].Path != "$.b.m" {
		t.Errorf("paths = %q, %q, want $.a.k and $.b.m", got[0].Path, got[1].Path)
	}
}

func TestDuplicateKeys_ThreeOccurrencesAreOneFinding(t *testing.T) {
	src := []byte("{\n  \"a\": 1,\n  \"a\": 2,\n  \"a\": 3\n}\n")
	got := DuplicateKeys(src)
	if len(got) != 1 {
		t.Fatalf("DuplicateKeys = %+v, want one finding spanning the first and last", got)
	}
	if got[0].First.Line != 2 || got[0].Last.Line != 4 {
		t.Errorf("First/Last lines = %d/%d, want 2/4", got[0].First.Line, got[0].Last.Line)
	}
}

func TestDuplicateKeys_CleanDocument(t *testing.T) {
	if got := DuplicateKeys([]byte(`{"a":1,"b":{"a":2}}`)); len(got) != 0 {
		t.Errorf("DuplicateKeys = %+v, want none -- the same key in two DIFFERENT objects is not a duplicate", got)
	}
}

func TestDuplicateKeys_UnparsableDocumentSaysNothing(t *testing.T) {
	if got := DuplicateKeys([]byte(`{"a":1,"a":2,}`)); len(got) != 0 {
		t.Errorf("DuplicateKeys = %+v, want none for a file already being reported as invalid JSON", got)
	}
}

func TestDuplicateKeys_ToleratesComments(t *testing.T) {
	// Callers hand this the StripComments output, but the scanner accepts comments itself, so a
	// caller that hands over the raw file still gets the right offsets.
	src := []byte("{\n  // a note\n  \"a\": 1,\n  \"a\": 2\n}\n")
	got := DuplicateKeys(src)
	if len(got) != 1 || got[0].First.Line != 3 || got[0].Last.Line != 4 {
		t.Fatalf("DuplicateKeys = %+v, want one finding at lines 3 and 4", got)
	}
}

func TestDuplicateKeyMessage(t *testing.T) {
	src := []byte("{\n  \"a\": 1,\n  \"a\": 2\n}\n")
	msg := DuplicateKeyMessage(DuplicateKeys(src)[0])
	for _, want := range []string{"$.a", "line 2", "line 3", "keeps the last one"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message = %q, want it to contain %q", msg, want)
		}
	}
}

func TestSyntaxError_TrailingCommaCarriesAColumn(t *testing.T) {
	// The one syntax error real pack files actually contain, and the reason Column exists.
	src := []byte("{\n  \"a\": 1,\n}\n")
	_, err := scanDocument(src)
	var se *SyntaxError
	if !asSyntaxError(err, &se) {
		t.Fatalf("scanDocument err = %v, want a *SyntaxError", err)
	}
	if !strings.Contains(se.Msg, "trailing comma") {
		t.Fatalf("Msg = %q, want the trailing-comma message", se.Msg)
	}
	if se.Line != 3 || se.Column != 1 {
		t.Errorf("position = %d:%d, want 3:1 (the '}' the comma dangles before)", se.Line, se.Column)
	}
	if se.Position() != (Position{Line: 3, Column: 1}) {
		t.Errorf("Position() = %+v, want it to agree with Line/Column", se.Position())
	}
	if !strings.Contains(se.Error(), "column 1") {
		t.Errorf("Error() = %q, want the column in the text too", se.Error())
	}
}

func TestSyntaxError_ColumnAgreesWithOffsetPosition(t *testing.T) {
	// One implementation of "where is byte N", not two: a SyntaxError and an
	// InvalidJSONMessage over the same file must not disagree about the column.
	src := []byte("{\n  \"a\": 1, \"b\": [1,]\n}\n")
	_, err := scanDocument(src)
	var se *SyntaxError
	if !asSyntaxError(err, &se) {
		t.Fatalf("scanDocument err = %v, want a *SyntaxError", err)
	}
	want := OffsetPosition(src, int64(se.Offset))
	if se.Position() != want {
		t.Errorf("Position() = %+v, OffsetPosition = %+v", se.Position(), want)
	}
}

func TestSyntaxError_CRLFColumn(t *testing.T) {
	// A pack edited on Windows. "\r\n" is one line ending, so the column must not be one too far.
	src := []byte("{\r\n  \"a\": 1,\r\n}\r\n")
	_, err := scanDocument(src)
	var se *SyntaxError
	if !asSyntaxError(err, &se) {
		t.Fatalf("scanDocument err = %v, want a *SyntaxError", err)
	}
	if se.Line != 3 || se.Column != 1 {
		t.Errorf("position = %d:%d, want 3:1", se.Line, se.Column)
	}
}

func asSyntaxError(err error, out **SyntaxError) bool {
	se, ok := err.(*SyntaxError)
	if ok {
		*out = se
	}
	return ok
}

func lineText(src []byte, line int) string {
	lines := strings.Split(strings.ReplaceAll(string(src), "\r\n", "\n"), "\n")
	if line-1 < 0 || line-1 >= len(lines) {
		return ""
	}
	return lines[line-1]
}
