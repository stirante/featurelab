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
	out = blankUTF8BOM(out)
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

// utf8BOM is the three bytes a Windows text editor puts in front of a file it
// saved as "UTF-8 with BOM": U+FEFF encoded as UTF-8.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// blankUTF8BOM overwrites a LEADING UTF-8 byte-order mark with three ASCII
// spaces, in place.
//
// Go's encoding/json refuses a BOM. It is not whitespace and it is not a value,
// so the parser stops on the first byte and says `invalid character 'ï¿½'
// looking for beginning of value` -- a message about the parser's internals
// that names nothing the author can see, on a file that opens fine in every
// editor they have. The whole file then does not load: the feature is not
// registered, and the only trace left is something ELSE reporting a delegation
// to a feature nothing defines. A file that vanishes and blames a different
// file is the most expensive shape a diagnostic can take.
//
// It is worth the three lines because of WHO writes one. Notepad has written a
// BOM on "Save as UTF-8" for most of its existence, PowerShell's
// Out-File/Set-Content do it on Windows PowerShell's default encodings, and
// Bedrock pack authors are overwhelmingly on Windows. The author did nothing
// wrong; their editor did something invisible.
//
// BLANKED, not removed, which is this package's standing rule (see
// StripComments): every remaining byte keeps its original offset, so a
// json.SyntaxError's offset and any line/column derived from it still point
// into the user's own unmodified file. Deleting three bytes would shift
// everything on line 1 left by three columns.
//
// Silent, with no diagnostic. A BOM is legal UTF-8, it carries no meaning here
// beyond "this file is UTF-8", and every other tool in the author's chain
// accepts it -- so a row about it would be this tool complaining about a file
// nothing else objects to, which is how a warning channel stops being read.
// Note what this does NOT do: it does not make an unparseable file parse. A BOM
// in the MIDDLE of a file is left exactly where it is and json.Unmarshal still
// refuses it, because there it is not an encoding marker, it is a stray
// character inside the data.
func blankUTF8BOM(out []byte) []byte {
	if len(out) >= len(utf8BOM) &&
		out[0] == utf8BOM[0] && out[1] == utf8BOM[1] && out[2] == utf8BOM[2] {
		out[0], out[1], out[2] = ' ', ' ', ' '
	}
	return out
}

// HasUTF8BOM reports whether src begins with a UTF-8 byte-order mark.
//
// StripComments already blanks one so the file parses; this is for a loader
// that wants to SAY so, and it is asked on the file's own bytes rather than on
// the stripped copy, where the mark is already three spaces.
func HasUTF8BOM(src []byte) bool {
	return len(src) >= len(utf8BOM) && src[0] == utf8BOM[0] && src[1] == utf8BOM[1] && src[2] == utf8BOM[2]
}

// UTF8BOMWarning is the one sentence every loader reports for a BOM, written
// here so the four of them cannot drift.
//
// A WARNING, and the level is a measured call rather than a preference. The
// game parses pack JSON with jsoncpp's legacy Json::Reader, and that reader
// does not skip a byte-order mark: it points its cursor at the first byte of
// the buffer and starts tokenizing, so the mark is read as a value and the
// parse fails. (Checked against a real client binary: the CharReaderBuilder
// settings that would carry jsoncpp's "skipBom" option are not in it at all.)
// So this is a file the game is likely to refuse and this tool accepts --
// exactly the direction this codebase warns in rather than stays silent about.
//
// Not an ERROR, because only the reader was verified, not everything in front
// of it: a layer of the game that reads the file before jsoncpp sees it could
// drop the mark, and refusing a pack on the strength of "we could not find the
// code that would save you" is how a checker earns a reputation for being
// wrong. A warning states what was established and leaves the file loading.
const UTF8BOMWarning = "this file starts with a UTF-8 byte-order mark (BOM). " +
	"This tool reads past it, but the game's own JSON reader does not skip one -- it reads the mark " +
	"as the start of a value and refuses the whole file, which makes the feature simply not exist " +
	"in game with nothing to point at. Windows editors add it silently: Notepad's \"UTF-8\" and " +
	"PowerShell's Out-File/Set-Content both do. Re-save the file as UTF-8 without a BOM."
