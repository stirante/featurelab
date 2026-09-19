package jsonc

// trailingcomma_test.go covers the one JSON failure this package reports somewhere other than
// where encoding/json reports it.
//
// The complaint it comes from, verbatim: a comma after line 5's value produced
// "line 6 col 4: invalid character '}' looking for beginning of object key string" -- a line the
// author must not change, a character that is correct, and no mention anywhere of a comma. This
// loader accepts `//` comments, so a file that looks like JSONC is one whose author has every
// reason to expect JSONC's comma leniency too.

import (
	"encoding/json"
	"strings"
	"testing"
)

// parseFail hands src through the same StripComments -> json.Unmarshal path every loader in this
// repo uses, and returns the error it produced.
func parseFail(t *testing.T, src string) ([]byte, error) {
	t.Helper()
	stripped := StripComments([]byte(src))
	var v any
	err := json.Unmarshal(stripped, &v)
	if err == nil {
		t.Fatalf("%q parsed cleanly; this test needs a source that does not", src)
	}
	return stripped, err
}

// TestTrailingComma_PointsAtTheCommaNotTheCloser is the reported bug, in the exact shape it was
// reported in: the comma is on line 5 and the parser stops on line 6.
func TestTrailingComma_PointsAtTheCommaNotTheCloser(t *testing.T) {
	src := "{\n" +
		"  \"format_version\": \"1.21.110\",\n" +
		"  \"minecraft:single_block_feature\": {\n" +
		"    \"description\": { \"identifier\": \"wiki:broken\" },\n" +
		"    \"places_block\": \"minecraft:gold_block\",\n" +
		"  }\n" +
		"}\n"
	stripped, err := parseFail(t, src)

	pos, ok := ErrorPosition(stripped, err)
	if !ok {
		t.Fatalf("ErrorPosition reported no position for %v", err)
	}
	if pos.Line != 5 || pos.Column != 43 {
		t.Errorf("position = %+v, want line 5 column 43 -- the comma itself, not the '}' on line 6", pos)
	}

	msg := InvalidJSONMessage(stripped, err)
	if !strings.HasPrefix(msg, "invalid JSON at line 5, column 43: trailing comma") {
		t.Errorf("message = %q, want it to open at the comma and say what it is", msg)
	}
	// The closer is still named, because "what the parser complained about" is the thing the
	// author will see if they look at any other tool's output -- it just is not where the fix is.
	if !strings.Contains(msg, "line 6") {
		t.Errorf("message = %q, want it to say where the parser actually stopped", msg)
	}
}

// An array's trailing comma is the same mistake with a different closer, and encoding/json words
// it completely differently ("looking for beginning of value"). The detection is on the BYTES for
// exactly that reason -- neither wording is API.
func TestTrailingComma_InAnArray(t *testing.T) {
	stripped, err := parseFail(t, "{\n  \"features\": [\n    \"wiki:a\",\n  ]\n}")
	pos, ok := ErrorPosition(stripped, err)
	if !ok {
		t.Fatalf("ErrorPosition reported no position for %v", err)
	}
	if pos.Line != 3 || pos.Column != 13 {
		t.Errorf("position = %+v, want line 3 column 13 -- the comma after the last entry", pos)
	}
	msg := InvalidJSONMessage(stripped, err)
	if !strings.Contains(msg, "trailing comma") || !strings.Contains(msg, "entry of an array") {
		t.Errorf("message = %q, want it to name the trailing comma and the array it closed", msg)
	}
}

// A comment between the comma and the closer must not hide it. StripComments blanks comment bytes
// in place rather than removing them, so what is between the two really is whitespace.
func TestTrailingComma_SurvivesACommentBeforeTheCloser(t *testing.T) {
	stripped, err := parseFail(t, "{\n  \"a\": 1,\n  // about to close\n}")
	pos, ok := ErrorPosition(stripped, err)
	if !ok {
		t.Fatalf("ErrorPosition reported no position for %v", err)
	}
	if pos.Line != 2 || pos.Column != 9 {
		t.Errorf("position = %+v, want line 2 column 9 -- the comma, with the comment counting as whitespace", pos)
	}
	if !strings.Contains(InvalidJSONMessage(stripped, err), "trailing comma") {
		t.Errorf("message = %q, want the trailing comma named", InvalidJSONMessage(stripped, err))
	}
}

// TestTrailingComma_DoesNotClaimUnrelatedFailures is the half that keeps the special case honest.
// Each of these ends at a '}' or a ']', or has a comma somewhere near, and none of them is a
// trailing comma -- a detector that answered "trailing comma" to any of them would be worse than
// the message it replaced.
func TestTrailingComma_DoesNotClaimUnrelatedFailures(t *testing.T) {
	cases := []struct{ name, src string }{
		// A missing VALUE, not a stray comma. The byte before the '}' is a ':'.
		{"missing value", "{\n  \"a\":\n}"},
		// Two commas: the parser stops at the second, and the byte before it is a comma, not a
		// closer.
		{"double comma", "{\n  \"a\": 1,,\n  \"b\": 2\n}"},
		// Truncated mid-value: no closer at all.
		{"truncated", "{\n  \"a\": 1,\n  \"b\":"},
		// A missing comma BETWEEN members -- the opposite mistake.
		{"missing separator", "{\n  \"a\": 1\n  \"b\": 2\n}"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stripped, err := parseFail(t, c.src)
			if msg := InvalidJSONMessage(stripped, err); strings.Contains(msg, "trailing comma") {
				t.Errorf("message = %q, want no trailing-comma claim for %q", msg, c.src)
			}
		})
	}
}

// A well-formed document whose value does not fit the Go type carries an offset too, and it is
// already pointing at the value to fix. There is no comma involved and nothing to reinterpret.
func TestTrailingComma_LeavesTypeErrorsAlone(t *testing.T) {
	stripped := StripComments([]byte("{\n  \"a\": \"not a number\"\n}"))
	var v struct {
		A int `json:"a"`
	}
	err := json.Unmarshal(stripped, &v)
	if err == nil {
		t.Fatal("source decoded cleanly; this test needs a type mismatch")
	}
	if msg := InvalidJSONMessage(stripped, err); strings.Contains(msg, "trailing comma") {
		t.Errorf("message = %q, want an unmarshal type error reported as itself", msg)
	}
}
