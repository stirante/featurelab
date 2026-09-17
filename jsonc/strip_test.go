package jsonc

import (
	"encoding/json"
	"testing"
)

// mustSameLength fails the test if StripComments changed the byte count -- the whole point of
// blanking in place instead of deleting is that every remaining byte keeps its original offset.
func mustSameLength(t *testing.T, src []byte, out []byte) {
	t.Helper()
	if len(src) != len(out) {
		t.Fatalf("StripComments changed length: %d -> %d", len(src), len(out))
	}
}

func TestStripComments_LineComment(t *testing.T) {
	src := []byte("{\n  \"a\": 1,\n  // trailing note\n  \"b\": 2\n}")
	out := StripComments(src)
	mustSameLength(t, src, out)

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	if v["a"] != float64(1) || v["b"] != float64(2) {
		t.Fatalf("unexpected decoded value: %#v", v)
	}
}

func TestStripComments_BlockComment(t *testing.T) {
	src := []byte("{\n  \"a\": /* inline note */ 1,\n  \"b\": 2\n}")
	out := StripComments(src)
	mustSameLength(t, src, out)

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	if v["a"] != float64(1) || v["b"] != float64(2) {
		t.Fatalf("unexpected decoded value: %#v", v)
	}
}

func TestStripComments_BlockCommentSpanningLines_PreservesLineNumbers(t *testing.T) {
	// The block comment spans three lines; StripComments must leave the newlines inside it
	// alone (only overwrite non-newline bytes) so a syntax error AFTER the comment still
	// reports the same line number encoding/json would compute against the ORIGINAL source.
	src := []byte("{\n/*\nnote\n*/\n\"a\": @@@\n}")
	out := StripComments(src)
	mustSameLength(t, src, out)

	srcLines := countBytes(src, '\n')
	outLines := countBytes(out, '\n')
	if srcLines != outLines {
		t.Fatalf("newline count changed: %d -> %d (line numbers would drift)", srcLines, outLines)
	}

	err := json.Unmarshal(out, &map[string]any{})
	if err == nil {
		t.Fatalf("expected a JSON syntax error from the deliberately-invalid \"@@@\" token")
	}
	se, ok := err.(*json.SyntaxError)
	if !ok {
		t.Fatalf("expected *json.SyntaxError, got %T: %v", err, err)
	}
	// Byte offset of "@@@" in the ORIGINAL source must match the offset encoding/json reports
	// against the STRIPPED source -- proof the comment was blanked in place, not deleted.
	wantOffset := indexOf(src, "@@@")
	if wantOffset < 0 {
		t.Fatalf("test fixture missing @@@ marker")
	}
	if int(se.Offset) < wantOffset || int(se.Offset) > wantOffset+3 {
		t.Fatalf("SyntaxError.Offset = %d, want within [%d, %d] (original @@@ position)", se.Offset, wantOffset, wantOffset+3)
	}
}

func TestStripComments_DoubleSlashInsideString(t *testing.T) {
	src := []byte(`{"url": "http://example.com", "note": "not // a comment"}`)
	out := StripComments(src)
	mustSameLength(t, src, out)

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	if v["url"] != "http://example.com" {
		t.Fatalf("string content was mangled: %#v", v["url"])
	}
	if v["note"] != "not // a comment" {
		t.Fatalf("string content was mangled: %#v", v["note"])
	}
}

func TestStripComments_BlockCommentMarkerInsideString(t *testing.T) {
	src := []byte(`{"note": "this looks /* like a block comment */ but isn't"}`)
	out := StripComments(src)
	mustSameLength(t, src, out)

	if string(out) != string(src) {
		t.Fatalf("string content was modified:\n got: %q\nwant: %q", out, src)
	}

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	if v["note"] != "this looks /* like a block comment */ but isn't" {
		t.Fatalf("string content was mangled: %#v", v["note"])
	}
}

func TestStripComments_EscapedQuoteBeforeCommentLikeSequence(t *testing.T) {
	// The string is `say \"hi\" // still inside` -- the backslash-escaped quotes must NOT end
	// the string early, so the "//" that follows is still inside the string literal (real text,
	// not a comment) and must survive untouched.
	src := []byte(`{"msg": "say \"hi\" // still inside"}`)
	out := StripComments(src)
	mustSameLength(t, src, out)

	if string(out) != string(src) {
		t.Fatalf("string content was modified:\n got: %q\nwant: %q", out, src)
	}

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	want := `say "hi" // still inside`
	if v["msg"] != want {
		t.Fatalf("decoded msg = %q, want %q", v["msg"], want)
	}
}

func TestStripComments_LineCommentAtEOFNoTrailingNewline(t *testing.T) {
	src := []byte(`{"a": 1} // trailing, no newline after this`)
	out := StripComments(src)
	mustSameLength(t, src, out)

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	if v["a"] != float64(1) {
		t.Fatalf("unexpected decoded value: %#v", v)
	}
}

func TestStripComments_VanillaMayGrowOnExample(t *testing.T) {
	// The exact shape from the bug report: a vanilla file's array with a "//" comment sitting
	// between two real elements.
	src := []byte(`{
  "may_grow_on": [
    "minecraft:dirt",
    "minecraft:grass",
    "minecraft:podzol",
    // Block aliases sure would be sweet
    { "name": "minecraft:dirt", "states": { "dirt_type": "coarse" } }
  ]
}`)
	out := StripComments(src)
	mustSameLength(t, src, out)

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("json.Unmarshal after strip: %v\nstripped: %q", err, out)
	}
	arr, ok := v["may_grow_on"].([]any)
	if !ok || len(arr) != 4 {
		t.Fatalf("unexpected decoded may_grow_on: %#v", v["may_grow_on"])
	}
}

// TrailingCommaStillRejected is the negative half of the spec: jsoncpp (what the real game
// parses pack JSON with) does NOT tolerate a trailing comma, so StripComments must never make one
// swallowable -- it only blanks comment bytes, it never touches commas.
func TestStripComments_TrailingCommaStillRejected(t *testing.T) {
	src := []byte(`{
  "may_grow_on": [
    "minecraft:dirt",
    "minecraft:grass", // comment right before the trailing comma
  ]
}`)
	out := StripComments(src)
	mustSameLength(t, src, out)

	var v map[string]any
	err := json.Unmarshal(out, &v)
	if err == nil {
		t.Fatalf("expected json.Unmarshal to reject the trailing comma, got success: %#v", v)
	}
}

func countBytes(b []byte, target byte) int {
	n := 0
	for _, c := range b {
		if c == target {
			n++
		}
	}
	return n
}

func indexOf(b []byte, sub string) int {
	for i := 0; i+len(sub) <= len(b); i++ {
		if string(b[i:i+len(sub)]) == sub {
			return i
		}
	}
	return -1
}
