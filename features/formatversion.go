// formatversion.go — the pack-declared `format_version` of one features/*.json file, as a
// comparable value.
//
// Why this exists as of the 1.26.50 retarget: that game version introduced a per-KEY version
// gate in the feature schemas. Each feature schema version has a minimum format version, and
// individual keys are now only accepted when the file's declared version reaches that minimum.
// The comparison is a real version comparison, not a string match.
// The observable consequence for a pack author is that a key can exist in the engine and still
// be rejected in THEIR file, purely because the file declares an older `format_version` — and
// `minecraft:snap_to_surface_feature`'s `vertical_search_range` -> `search_range` rename is the
// first case where that matters in practice, since the two names are the same key at different
// versions.
//
// This tool exists to tell an add-on author what the engine will really do with their pack, so
// silently accepting a key the engine would reject is the wrong behaviour, and so is silently
// rejecting one it would accept. Both require knowing the file's declared version, which the
// loader used to read and throw away (registry.go's parseFile skipped `format_version` while
// looking for the type key next to it).
//
// Deliberately NOT a general semver implementation: Bedrock's `format_version` is a
// dotted numeric triple with no pre-release or build metadata, written either as a string
// ("1.21.0") or as an array of numbers ([1, 21, 0]) — both forms appear in Mojang's own packs,
// so both are accepted here. A fourth component shows up in some manifests; it is parsed and
// compared rather than rejected, because refusing a file the game loads would be a worse
// failure than ordering it slightly differently from the engine.
package features

import (
	"fmt"
	"strconv"
	"strings"
)

// FormatVersion is a parsed `format_version`. The zero value means "absent", which is a
// meaningful state rather than an error: a file may omit the key entirely, and the engine then
// has no version to compare against. Callers must therefore branch on Present rather than
// treating a zero version as "1.0.0" — those are different situations and conflating them is
// how a gate silently opens.
type FormatVersion struct {
	// Parts holds the dotted components in order, most significant first. Length is 2, 3 or 4;
	// comparison is component-wise with a missing component treated as 0, so "1.21" and
	// "1.21.0" compare equal, which is what the string forms in real packs imply.
	Parts []int
	// Raw is the value exactly as it appeared, for diagnostics. A message that echoes what the
	// author wrote is far more useful than one that echoes our normalisation of it.
	Raw string
	// Present distinguishes "the file declared no format_version" from "the file declared
	// something we parsed to all zeroes".
	Present bool
}

// ParseFormatVersion reads the `format_version` value from a features/*.json root object.
// Pass the raw value as it came out of encoding/json: a string, a []any of numbers, or nil
// when the key was absent.
//
// Returns an error only for a value that is PRESENT but unparseable. An absent key yields a
// zero FormatVersion and no error, because absence is legal in the files this tool reads.
func ParseFormatVersion(v any) (FormatVersion, error) {
	switch value := v.(type) {
	case nil:
		return FormatVersion{}, nil

	case string:
		raw := strings.TrimSpace(value)
		if raw == "" {
			return FormatVersion{}, fmt.Errorf("format_version is an empty string")
		}
		fields := strings.Split(raw, ".")
		if len(fields) < 2 || len(fields) > 4 {
			return FormatVersion{}, fmt.Errorf("format_version %q must have 2 to 4 dotted components", raw)
		}
		parts := make([]int, 0, len(fields))
		for _, f := range fields {
			n, err := strconv.Atoi(strings.TrimSpace(f))
			if err != nil || n < 0 {
				return FormatVersion{}, fmt.Errorf("format_version %q has a non-numeric component %q", raw, f)
			}
			parts = append(parts, n)
		}
		return FormatVersion{Parts: parts, Raw: raw, Present: true}, nil

	case []any:
		if len(value) < 2 || len(value) > 4 {
			return FormatVersion{}, fmt.Errorf("format_version array must have 2 to 4 elements, got %d", len(value))
		}
		parts := make([]int, 0, len(value))
		text := make([]string, 0, len(value))
		for i, el := range value {
			// encoding/json decodes every JSON number into float64, so an integer arrives as
			// e.g. 21.0. Reject a genuinely fractional component rather than truncating it:
			// [1, 21.5, 0] is a mistake in the pack, and rounding it silently would hide it.
			f, ok := el.(float64)
			if !ok {
				return FormatVersion{}, fmt.Errorf("format_version[%d] must be a number, got %T", i, el)
			}
			n := int(f)
			if float64(n) != f || n < 0 {
				return FormatVersion{}, fmt.Errorf("format_version[%d] must be a non-negative whole number, got %v", i, f)
			}
			parts = append(parts, n)
			text = append(text, strconv.Itoa(n))
		}
		return FormatVersion{Parts: parts, Raw: strings.Join(text, "."), Present: true}, nil

	default:
		return FormatVersion{}, fmt.Errorf("format_version must be a string or an array of numbers, got %T", v)
	}
}

// MustFormatVersion parses a dotted string and panics on failure. For test fixtures and for
// the compile-time constants that name a gate's minimum version, where an unparseable literal
// is a bug in this package rather than in a user's pack.
func MustFormatVersion(s string) FormatVersion {
	fv, err := ParseFormatVersion(s)
	if err != nil {
		panic(fmt.Sprintf("features.MustFormatVersion(%q): %v", s, err))
	}
	return fv
}

// Compare returns -1 if f orders before other, +1 if after, 0 if equal. Components are
// compared most-significant first, and a component missing from either side counts as 0, so
// "1.21" == "1.21.0" and "1.21" < "1.21.1".
//
// Present plays no part: comparing an absent version is the caller's decision to make, not
// something to encode in an ordering. See AtLeast for the gate-shaped question.
func (f FormatVersion) Compare(other FormatVersion) int {
	n := len(f.Parts)
	if len(other.Parts) > n {
		n = len(other.Parts)
	}
	for i := 0; i < n; i++ {
		a, b := 0, 0
		if i < len(f.Parts) {
			a = f.Parts[i]
		}
		if i < len(other.Parts) {
			b = other.Parts[i]
		}
		if a != b {
			if a < b {
				return -1
			}
			return 1
		}
	}
	return 0
}

// AtLeast reports whether this declared version satisfies a gate whose minimum is min.
//
// An ABSENT version never satisfies a gate here — the strict reading, which does not invent a
// version the author did not write. It is NOT the reading the builders in this package use:
// see AtLeastOrUnversioned, which argues why an undeclared version is better treated as
// "unversioned" than as "older than everything", and which is the predicate a new gate should
// reach for. This one remains for the sites that genuinely want the strict answer, and for
// AtLeastOrUnversioned itself to be defined against.
func (f FormatVersion) AtLeast(min FormatVersion) bool {
	if !f.Present {
		return false
	}
	return f.Compare(min) >= 0
}

// AtLeastOrUnversioned is AtLeast for a file that declares a version, and TRUE for one that
// does not. It is the gate predicate every builder in this package should use, and the reason
// it exists rather than each site writing `!Present || AtLeast(...)` is that the choice needs
// one place to be argued:
//
// A file with no `format_version` does not load in the game AT ALL — the key is a required
// child of every band's schema root. So for such a
// file there is no "what the engine would do with this key": both branches of every gate are
// equally counterfactual, and picking the older one buys no fidelity. What it does buy is a
// second, quieter punishment for an omission the loader has already reported once — an author
// who forgot the key would find their modern keys silently disabled here on top of it, with
// nothing in the run pointing at the cause.
//
// So: a declared version is honoured exactly, and an undeclared one is read as "unversioned,
// judge the keys on their own terms". registry.go emits the one warning that says the game
// would refuse the file; nothing downstream repeats it.
//
// AtLeast remains the strict form, for the rare site that must treat absence as "older than
// anything" rather than as "unversioned".
func (f FormatVersion) AtLeastOrUnversioned(min FormatVersion) bool {
	if !f.Present {
		return true
	}
	return f.Compare(min) >= 0
}

// String renders the version as the author wrote it, or "(absent)" — chosen over an empty
// string so it cannot vanish inside a diagnostic message.
func (f FormatVersion) String() string {
	if !f.Present {
		return "(absent)"
	}
	return f.Raw
}
