// Package jsonc pre-processes pack JSON so Go's strict encoding/json can parse what Minecraft:
// Bedrock's own engine accepts. The game parses pack files with jsoncpp, which tolerates two comment forms real vanilla files use -- "// line" and "/* block */" -- but,
// notably, does NOT tolerate a trailing comma. This package only ever blanks comment bytes; it
// never deletes, joins, or otherwise reshapes bytes, so it can never accidentally paper over a
// trailing comma or any other real syntax error jsoncpp itself would also reject. That asymmetry
// (accept the game's two comment forms, reject everything else the game also rejects) is
// deliberate: a permissive JSONC/JWCC library would accept files the real game does not, which is
// worse than rejecting files it does accept in a tool whose entire value is fidelity to the game.
package jsonc

// StripComments returns a copy of src with every "//" line comment and "/* */" block comment
// overwritten with ASCII spaces (one space per comment byte, except a literal '\n'/'\r' inside a
// block comment which is left alone) -- never deleted. This keeps every remaining byte at its
// original offset, so a downstream json.SyntaxError's byte offset (and any line/column a caller
// derives from it) still points at the right place in the user's own, unmodified file.
//
// Comment-like text inside a JSON string literal is left completely alone: this function tracks
// whether it is inside a "..." string (respecting backslash escapes, so \" does not end the
// string and \\ does not falsely escape the following character) and only recognizes // or /* as
// a comment start outside of one. "minecraft:foo" and "http://example" are therefore never
// mangled, matching jsoncpp's own string-first tokenizing.
//
// An unterminated "/*" block comment (no closing "*/" before EOF) blanks to the end of the input
// -- json.Unmarshal will then report its own "unexpected end of JSON input" (or similar), which is
// an acceptable diagnosis for a file real jsoncpp would also refuse to parse cleanly.
func StripComments(src []byte) []byte {
	out := append([]byte(nil), src...)
	n := len(out)
	inString := false
	escaped := false

	for i := 0; i < n; {
		c := out[i]

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

		if c == '/' && i+1 < n && out[i+1] == '/' {
			j := i
			for j < n && out[j] != '\n' && out[j] != '\r' {
				out[j] = ' '
				j++
			}
			i = j
			continue
		}

		if c == '/' && i+1 < n && out[i+1] == '*' {
			out[i] = ' '
			out[i+1] = ' '
			j := i + 2
			for j < n {
				if out[j] == '*' && j+1 < n && out[j+1] == '/' {
					out[j] = ' '
					out[j+1] = ' '
					j += 2
					break
				}
				if out[j] != '\n' && out[j] != '\r' {
					out[j] = ' '
				}
				j++
			}
			i = j
			continue
		}

		i++
	}

	return out
}
