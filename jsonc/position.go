package jsonc

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Position is a 1-based place in a source file: the line, and the column
// within it counted in Unicode code points (not bytes), which is what a
// person reading the file in an editor counts. Both fields are 1-based, so
// the zero value is never a valid position and can stand for "unknown".
//
// Columns are code points rather than bytes because a pack file that
// happens to carry a non-ASCII character in a string (a curly quote in a
// comment, an accented name) would otherwise report a column past where the
// character actually sits. Pack JSON is overwhelmingly ASCII, where the two
// counts are identical anyway.
type Position struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// ErrorPosition turns an encoding/json error into a place in src, when the
// error carries one. ok is false for an error that names no offset at all
// -- e.g. an error from a custom UnmarshalJSON, or any non-json error --
// and the caller must then say only which FILE is bad, not where.
//
// src must be the bytes actually handed to json.Unmarshal. Passing the
// StripComments output rather than the raw file is fine and is what callers
// do: StripComments only ever overwrites comment bytes with spaces, never
// moves or removes any, so every offset in the stripped copy is the same
// offset in the user's own file (see StripComments's own doc comment).
//
// Two error types carry an offset: *json.SyntaxError (a malformed document
// -- a missing comma, an unterminated string, a truncated file) and
// *json.UnmarshalTypeError (well-formed JSON whose value does not fit the
// Go type). Both offsets point just PAST the byte that caused the failure,
// which is exactly the editor caret position a person wants: for a
// truncated file that is the end of the last line, for a stray comma it is
// the comma.
//
// ONE failure is deliberately not reported where encoding/json puts it: a
// trailing comma, where the parser's offset is the `}` or `]` on a LATER line
// and the character to change is the comma behind it. That one answers with
// the comma's own position -- see trailingComma.
func ErrorPosition(src []byte, err error) (Position, bool) {
	if c, ok := trailingComma(src, err); ok {
		return c.Position, true
	}
	offset, ok := errorOffset(err)
	if !ok {
		return Position{}, false
	}
	return OffsetPosition(src, offset), true
}

// trailingCommaError is one "`}` or `]` where a key or a value was expected,
// with nothing but whitespace between it and a comma" -- a trailing comma,
// which is the single commonest way a hand-edited pack file stops parsing.
//
// It is worth its own case because encoding/json describes it from the
// PARSER's side and the parser is one token further on than the mistake:
//
//	5:    "places_block": "minecraft:gold_block",
//	6:  }
//
// reports "line 6, column 4: invalid character '}' looking for beginning of
// object key string" -- a line the author must not change, a character that is
// correct, and no mention anywhere of a comma. Worse, this loader accepts `//`
// comments (see StripComments), so a file that looks like JSONC is a file whose
// author has every reason to expect JSONC's comma leniency too; they need to be
// told plainly that this one they do not get.
type trailingCommaError struct {
	// Position is the COMMA's own place -- the character to delete.
	Position Position
	// Closer is the '}' or ']' the parser actually stopped at, and CloserLine
	// is the line it sits on, so the message can say where the parser was
	// looking without sending the author there to edit.
	Closer     byte
	CloserLine int
}

// trailingComma recognises err as a trailing comma in src, and says where the
// comma is.
//
// Deliberately decided on the BYTES rather than on encoding/json's wording: the
// two messages this fires for ("looking for beginning of object key string" and
// "looking for beginning of value") are not API, and a Go release that reworded
// either would silently switch this off. What is stable is the offset and what
// is at it -- a closing brace or bracket, preceded by nothing but whitespace
// and a comma.
//
// Only *json.SyntaxError is considered. An *json.UnmarshalTypeError is a
// well-formed document whose value did not fit a Go type; there is no comma
// involved and its own offset already points at the value to fix.
//
// src must be the bytes actually handed to json.Unmarshal. The StripComments
// output is what callers pass and is exactly right here: it overwrites every
// comment byte with a space and moves nothing, so a comma separated from its
// closer by a `// note` is still separated from it by whitespace alone.
func trailingComma(src []byte, err error) (trailingCommaError, bool) {
	var syntaxErr *json.SyntaxError
	if !errors.As(err, &syntaxErr) {
		return trailingCommaError{}, false
	}
	// json.SyntaxError.Offset points just PAST the byte that caused the
	// failure, so the offending character is the one before it.
	at := syntaxErr.Offset - 1
	if at < 0 || at >= int64(len(src)) {
		return trailingCommaError{}, false
	}
	closer := src[at]
	if closer != '}' && closer != ']' {
		return trailingCommaError{}, false
	}
	i := at - 1
	for i >= 0 && isJSONSpace(src[i]) {
		i--
	}
	if i < 0 || src[i] != ',' {
		return trailingCommaError{}, false
	}
	return trailingCommaError{
		Position:   OffsetPosition(src, i),
		Closer:     closer,
		CloserLine: OffsetPosition(src, at).Line,
	}, true
}

// isJSONSpace is the whitespace set encoding/json itself skips between tokens.
func isJSONSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

func errorOffset(err error) (int64, bool) {
	var syntaxErr *json.SyntaxError
	if errors.As(err, &syntaxErr) {
		return syntaxErr.Offset, true
	}
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) {
		return typeErr.Offset, true
	}
	return 0, false
}

// OffsetPosition converts a byte offset into src to a 1-based line/column.
// An offset past the end of src clamps to the end (the truncated-file case,
// where encoding/json reports the offset as the whole length); a negative
// one clamps to the start. "\r\n" counts as one line ending, so a file with
// Windows line endings -- which a pack edited on Windows very often has --
// does not report every column one too far.
func OffsetPosition(src []byte, offset int64) Position {
	if offset < 0 {
		offset = 0
	}
	if offset > int64(len(src)) {
		offset = int64(len(src))
	}
	line, column := 1, 1
	for i := int64(0); i < offset; i++ {
		switch src[i] {
		case '\n':
			line++
			column = 1
		case '\r':
			// A lone '\r' is a line ending too; '\r\n' must not count twice.
			if i+1 < int64(len(src)) && src[i+1] == '\n' {
				continue
			}
			line++
			column = 1
		default:
			// Count code points, not bytes: a UTF-8 continuation byte
			// (10xxxxxx) is part of the character before it.
			if src[i]&0xC0 != 0x80 {
				column++
			}
		}
	}
	return Position{Line: line, Column: column}
}

// InvalidJSONMessage is the one sentence every loader in this repo uses to
// report a file encoding/json refused, so a feature file, a rule file, a
// biome file and a block file all read the same way and a client can parse
// one shape rather than four.
//
// It names the position when the error carries one -- "invalid JSON at line
// 9, column 22: unexpected end of JSON input" -- and falls back to the bare
// "invalid JSON: <reason>" when it does not. The position is repeated in
// the structured Line/Column fields of the Diagnostic this message ends up
// on; it is in the text as well because plenty of consumers (a terminal,
// a log line, `check`'s output) only ever show the message.
func InvalidJSONMessage(src []byte, err error) string {
	if c, ok := trailingComma(src, err); ok {
		return fmt.Sprintf(
			"invalid JSON at line %d, column %d: trailing comma -- JSON does not allow a comma after the last %s; "+
				"delete it (the parser only notices at the %q on line %d: %v)",
			c.Position.Line, c.Position.Column, trailingCommaContainer(c.Closer), string(c.Closer), c.CloserLine, err)
	}
	if pos, ok := ErrorPosition(src, err); ok {
		return fmt.Sprintf("invalid JSON at line %d, column %d: %v", pos.Line, pos.Column, err)
	}
	return "invalid JSON: " + err.Error()
}

// trailingCommaContainer names what the comma was the last separator in, from
// the closer the parser stopped at.
func trailingCommaContainer(closer byte) string {
	if closer == ']' {
		return "entry of an array"
	}
	return "member of an object"
}
