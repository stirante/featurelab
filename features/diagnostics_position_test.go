package features

import (
	"strings"
	"testing"
)

// diagnosticsFor parses one file and returns everything it raised, so these tests assert on the
// loader's real output rather than on a helper's idea of it.
func diagnosticsFor(t *testing.T, id, text string) []Diagnostic {
	t.Helper()
	var diags []Diagnostic
	var failed []FailedFile
	parseFile(SourceFile{ID: id, Text: text}, &diags, &failed)
	return diags
}

func findDiag(t *testing.T, diags []Diagnostic, contains string) Diagnostic {
	t.Helper()
	for _, d := range diags {
		if strings.Contains(d.Message, contains) {
			return d
		}
	}
	t.Fatalf("no diagnostic containing %q, got %+v", contains, diags)
	return Diagnostic{}
}

// A trailing comma is the one syntax error real pack files actually contain, and encoding/json
// reports an offset for it -- so the invalid-JSON diagnostic has always been able to point at it.
// This pins that it does.
func TestParseFile_TrailingCommaCarriesLineAndColumn(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:single_block_feature\": {\n    \"description\": { \"identifier\": \"wiki:a\" },\n  }\n}\n"
	d := findDiag(t, diagnosticsFor(t, "a.json", text), "invalid JSON")
	if d.Line == 0 || d.Column == 0 {
		t.Errorf("diagnostic = %+v, want a line and a column", d)
	}
	if !strings.Contains(d.Message, "line") || !strings.Contains(d.Message, "column") {
		t.Errorf("message = %q, want the position in the text as well as the fields", d.Message)
	}
}

// "the wrong type for a known key" is the class encoding/json would have positioned if the
// decode had had a type to disappoint. Decoding into map[string]any means it never does, so the
// position is asked for explicitly.
func TestParseFile_WrongTypeForTheBodyKeyPointsAtTheValue(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:single_block_feature\": 7\n}\n"
	d := findDiag(t, diagnosticsFor(t, "a.json", text), "must be an object")
	if d.Line != 3 {
		t.Errorf("Line = %d, want 3 (the line the body key is on)", d.Line)
	}
	if d.Column == 0 {
		t.Errorf("Column = %d, want the value's column", d.Column)
	}
}

// A missing key has no position of its own, so the caret falls back outward to the innermost
// thing that does exist -- the object the key should have been written in.
func TestParseFile_MissingIdentifierPointsAtTheDescription(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:single_block_feature\": {\n    \"description\": {\n    }\n  }\n}\n"
	d := findDiag(t, diagnosticsFor(t, "a.json", text), "description.identifier is missing")
	if d.Line != 4 {
		t.Errorf("Line = %d, want 4 (the description object)", d.Line)
	}
}

func TestParseFile_MissingDescriptionFallsBackToTheBody(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:single_block_feature\": {\n    \"places_block\": \"minecraft:stone\"\n  }\n}\n"
	d := findDiag(t, diagnosticsFor(t, "a.json", text), "description.identifier is missing")
	if d.Line != 3 {
		t.Errorf("Line = %d, want 3 (the body, since there is no description to point at)", d.Line)
	}
}

func TestParseFile_BadFormatVersionPointsAtIt(t *testing.T) {
	text := "{\n  \"format_version\": [1, 2, \"x\"],\n  \"minecraft:single_block_feature\": {\n    \"description\": { \"identifier\": \"wiki:a\" },\n    \"places_block\": \"minecraft:stone\"\n  }\n}\n"
	diags := diagnosticsFor(t, "a.json", text)
	for _, d := range diags {
		if d.Level != "error" {
			continue
		}
		if d.Line != 2 {
			t.Errorf("diagnostic %+v, want it positioned on line 2 (format_version)", d)
		}
		return
	}
	t.Fatalf("no error diagnostic for a malformed format_version, got %+v", diags)
}

// A duplicate key is an error nowhere -- the game keeps the last one and so does this loader --
// which is exactly why it is worth saying: the file loads and does something other than what it
// looks like it does.
func TestParseFile_DuplicateKeyIsAPositionedWarning(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:single_block_feature\": {\n" +
		"    \"description\": { \"identifier\": \"wiki:a\" },\n" +
		"    \"places_block\": \"minecraft:stone\",\n" +
		"    \"places_block\": \"minecraft:dirt\"\n  }\n}\n"
	diags := diagnosticsFor(t, "a.json", text)
	d := findDiag(t, diags, "written twice")
	if d.Level != "warning" {
		t.Errorf("Level = %q, want warning -- the game loads this file", d.Level)
	}
	if d.Line != 5 {
		t.Errorf("Line = %d, want 5 (the occurrence that has no effect)", d.Line)
	}
	if d.Column == 0 {
		t.Errorf("Column = %d, want the key's column", d.Column)
	}
	if !strings.Contains(d.Message, "keeps the last one") {
		t.Errorf("message = %q, want it to say which occurrence survives", d.Message)
	}
	// The file still loads, which is the point.
	for _, x := range diags {
		if x.Level == "error" {
			t.Errorf("a duplicate key must not stop the file loading, got %+v", x)
		}
	}
}

func TestParseFile_NoDuplicateWarningForACleanFile(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:single_block_feature\": {\n" +
		"    \"description\": { \"identifier\": \"wiki:a\" },\n    \"places_block\": \"minecraft:stone\"\n  }\n}\n"
	for _, d := range diagnosticsFor(t, "a.json", text) {
		if strings.Contains(d.Message, "written twice") {
			t.Errorf("clean file raised %+v", d)
		}
	}
}

// The same key in two DIFFERENT objects is not a duplicate, and a check that thought it was
// would fire on every pack (every feature has a "description", and so does every nested one).
func TestParseFile_SameKeyInDifferentObjectsIsNotADuplicate(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:aggregate_feature\": {\n" +
		"    \"description\": { \"identifier\": \"wiki:a\" },\n" +
		"    \"early_out\": \"none\",\n" +
		"    \"features\": [ \"wiki:b\" ]\n  }\n}\n"
	for _, d := range diagnosticsFor(t, "a.json", text) {
		if strings.Contains(d.Message, "written twice") {
			t.Errorf("raised %+v for a file with no duplicate", d)
		}
	}
}

// A file that does not parse is already being reported as invalid JSON; a duplicate-key finding
// scraped out of it would be a second, weaker message about the same broken file.
func TestParseFile_UnparsableFileRaisesOnlyTheSyntaxError(t *testing.T) {
	text := "{\n  \"a\": 1,\n  \"a\": 2,\n}\n"
	for _, d := range diagnosticsFor(t, "a.json", text) {
		if strings.Contains(d.Message, "written twice") {
			t.Errorf("raised %+v for a file that does not parse", d)
		}
	}
}
