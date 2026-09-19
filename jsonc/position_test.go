package jsonc

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestErrorPosition_PointsAtTheOffendingCharacter covers the positions a pack author actually
// produces, one case per way a JSON file goes wrong.
func TestErrorPosition_PointsAtTheOffendingCharacter(t *testing.T) {
	cases := []struct {
		name       string
		src        string
		wantLine   int
		wantColumn int
	}{
		{
			// Truncated mid-value -- a save while typing, or an interrupted copy. The offset
			// encoding/json reports is the whole length, so the position is the end of the
			// last line, which is where the file stops making sense.
			name:     "truncated",
			src:      "{\n  \"a\": 1,\n  \"b\":",
			wantLine: 3, wantColumn: 7,
		},
		{
			// A trailing comma: legal in no JSON dialect the game accepts either (see this
			// package's own doc comment). The caret lands on the COMMA, which is a line
			// earlier than where encoding/json stops -- see trailingComma for why that is
			// worth a special case, and TestTrailingComma_* below for the rest of it.
			name:     "trailing comma",
			src:      "{\n  \"a\": 1,\n}",
			wantLine: 2, wantColumn: 9,
		},
		{
			// Windows line endings must not count twice -- a pack edited on Windows is the
			// common case, and double-counting would put every reported line at 2x.
			name:     "crlf",
			src:      "{\r\n  \"a\": 1,\r\n}",
			wantLine: 2, wantColumn: 9,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stripped := StripComments([]byte(c.src))
			var v any
			err := json.Unmarshal(stripped, &v)
			if err == nil {
				t.Fatalf("%q parsed cleanly; the case needs a source that does not", c.src)
			}
			pos, ok := ErrorPosition(stripped, err)
			if !ok {
				t.Fatalf("ErrorPosition reported no position for %v", err)
			}
			if pos.Line != c.wantLine || pos.Column != c.wantColumn {
				t.Errorf("position = %+v, want line %d column %d (error: %v)", pos, c.wantLine, c.wantColumn, err)
			}
		})
	}
}

// TestErrorPosition_SurvivesStrippedComments is the property StripComments was built to have,
// asserted from the consumer's side: a comment BEFORE the error must not shift the reported
// position, because the bytes handed to encoding/json are blanked in place rather than removed.
// Without it every line/column in a commented file would be reported against a document the
// author never wrote.
func TestErrorPosition_SurvivesStrippedComments(t *testing.T) {
	src := "{\n  // a note about the next line\n  \"a\": 1,\n}"
	stripped := StripComments([]byte(src))
	var v any
	err := json.Unmarshal(stripped, &v)
	if err == nil {
		t.Fatal("source parsed cleanly; the test needs one that does not")
	}
	pos, ok := ErrorPosition(stripped, err)
	if !ok {
		t.Fatalf("ErrorPosition reported no position for %v", err)
	}
	// Line 3, not 4: this source ends in a trailing comma, and that is reported at the comma
	// itself (see trailingComma). What this test is about is unchanged either way -- the
	// comment on line 2 must count as one line and shift nothing.
	if pos.Line != 3 || pos.Column != 9 {
		t.Errorf("position = %+v, want line 3 column 9 -- the comment line must count as a line and shift nothing", pos)
	}
}

// TestInvalidJSONMessage_CarriesThePositionInTheText pins the one sentence every loader shares,
// for the consumers that only ever show a message (a terminal, a log line).
func TestInvalidJSONMessage_CarriesThePositionInTheText(t *testing.T) {
	stripped := StripComments([]byte("{\n  \"a\":"))
	var v any
	err := json.Unmarshal(stripped, &v)
	msg := InvalidJSONMessage(stripped, err)
	if !strings.HasPrefix(msg, "invalid JSON at line 2, column 7: ") {
		t.Errorf("message = %q, want it to open with the position", msg)
	}

	// An error with no offset falls back to the bare form rather than inventing a position.
	if got := InvalidJSONMessage(stripped, errNoOffset{}); got != "invalid JSON: no offset here" {
		t.Errorf("message for a positionless error = %q, want the bare form", got)
	}
}

type errNoOffset struct{}

func (errNoOffset) Error() string { return "no offset here" }

// TestOffsetPosition_ClampsRatherThanPanics covers the two out-of-range offsets a caller can
// hand this: encoding/json reports the whole length for a truncated document (already at the
// boundary), and a caller doing its own arithmetic can overshoot.
func TestOffsetPosition_ClampsRatherThanPanics(t *testing.T) {
	src := []byte("{\n}")
	if pos := OffsetPosition(src, 9999); pos.Line != 2 || pos.Column != 2 {
		t.Errorf("past-the-end offset = %+v, want the end of the input (line 2 column 2)", pos)
	}
	if pos := OffsetPosition(src, -5); pos.Line != 1 || pos.Column != 1 {
		t.Errorf("negative offset = %+v, want the start of the input", pos)
	}
}
