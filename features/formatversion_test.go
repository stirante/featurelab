// formatversion_test.go — tests for the parsed `format_version` value.
//
// These matter more than their size suggests: the 1.26.50.24 engine gates individual schema
// keys on this value, so a comparison that is wrong at a boundary makes this tool accept a key
// the game rejects (or reject one it accepts), which is the exact failure mode the tool exists
// to prevent. The boundary cases -- equal versions, a shorter dotted form against a longer one,
// and an absent version -- therefore get explicit tests rather than being left to inspection.
package features

import (
	"strings"
	"testing"
)

func TestParseFormatVersion_StringForms(t *testing.T) {
	cases := []struct {
		in    string
		parts []int
	}{
		{"1.21.0", []int{1, 21, 0}},
		{"1.13", []int{1, 13}},
		{"1.16.100", []int{1, 16, 100}},
		{"1.21.20.3", []int{1, 21, 20, 3}},
		{" 1.21.0 ", []int{1, 21, 0}},
	}
	for _, c := range cases {
		got, err := ParseFormatVersion(c.in)
		if err != nil {
			t.Fatalf("ParseFormatVersion(%q) returned error: %v", c.in, err)
		}
		if !got.Present {
			t.Errorf("ParseFormatVersion(%q).Present = false, want true", c.in)
		}
		if len(got.Parts) != len(c.parts) {
			t.Fatalf("ParseFormatVersion(%q).Parts = %v, want %v", c.in, got.Parts, c.parts)
		}
		for i := range c.parts {
			if got.Parts[i] != c.parts[i] {
				t.Errorf("ParseFormatVersion(%q).Parts = %v, want %v", c.in, got.Parts, c.parts)
				break
			}
		}
	}
}

func TestParseFormatVersion_ArrayForm(t *testing.T) {
	// encoding/json hands every JSON number over as float64, so this is the shape a real pack
	// file actually produces -- testing with []any{1, 21, 0} would test a value this code can
	// never receive.
	got, err := ParseFormatVersion([]any{float64(1), float64(21), float64(0)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Raw != "1.21.0" {
		t.Errorf("Raw = %q, want %q", got.Raw, "1.21.0")
	}
	if !got.Present || len(got.Parts) != 3 || got.Parts[1] != 21 {
		t.Errorf("Parts = %v, Present = %v", got.Parts, got.Present)
	}
}

func TestParseFormatVersion_AbsentIsNotAnError(t *testing.T) {
	got, err := ParseFormatVersion(nil)
	if err != nil {
		t.Fatalf("absent format_version must not be an error, got %v", err)
	}
	if got.Present {
		t.Error("absent format_version must not report Present")
	}
	if got.String() != "(absent)" {
		t.Errorf("String() = %q, want %q", got.String(), "(absent)")
	}
}

func TestParseFormatVersion_RejectsMalformed(t *testing.T) {
	bad := []any{
		"",
		"1",                                 // a single component is not a version
		"1.2.3.4.5",                         // too many
		"1.x.0",                             // non-numeric
		"1.-2.0",                            // negative
		[]any{float64(1)},                   // too few elements
		[]any{float64(1), float64(21.5)},    // fractional component
		[]any{float64(1), "21"},             // wrong element type
		float64(1.21),                       // a bare number is not a version
		map[string]any{"major": float64(1)}, // wrong shape entirely
	}
	for _, in := range bad {
		if _, err := ParseFormatVersion(in); err == nil {
			t.Errorf("ParseFormatVersion(%#v) = nil error, want an error", in)
		}
	}
}

func TestFormatVersion_CompareTreatsMissingComponentsAsZero(t *testing.T) {
	if got := MustFormatVersion("1.21").Compare(MustFormatVersion("1.21.0")); got != 0 {
		t.Errorf("1.21 vs 1.21.0 = %d, want 0", got)
	}
	if got := MustFormatVersion("1.21").Compare(MustFormatVersion("1.21.1")); got != -1 {
		t.Errorf("1.21 vs 1.21.1 = %d, want -1", got)
	}
	if got := MustFormatVersion("1.21.1").Compare(MustFormatVersion("1.21")); got != 1 {
		t.Errorf("1.21.1 vs 1.21 = %d, want 1", got)
	}
	// Most-significant-first ordering: a bigger minor must not outrank a bigger major.
	if got := MustFormatVersion("1.99.0").Compare(MustFormatVersion("2.0.0")); got != -1 {
		t.Errorf("1.99.0 vs 2.0.0 = %d, want -1", got)
	}
	// Numeric, not lexicographic: "1.9" must order BELOW "1.21".
	if got := MustFormatVersion("1.9.0").Compare(MustFormatVersion("1.21.0")); got != -1 {
		t.Errorf("1.9.0 vs 1.21.0 = %d, want -1 (numeric comparison, not string)", got)
	}
}

// TestParseFile_ReadsFormatVersion covers the loader half: the value has to actually reach a
// builder, because a correctly-parsed version that nobody threads through is worth nothing. The
// loader used to read this key only to skip past it while looking for the feature type key beside
// it, so "it is parsed" and "it is available" were genuinely separate facts here.
func TestParseFile_ReadsFormatVersion(t *testing.T) {
	const body = `{"description":{"identifier":"t:x"},"features":[]}`

	t.Run("string form", func(t *testing.T) {
		var diags []Diagnostic
		p := parseFile(SourceFile{ID: "f", Text: `{"format_version":"1.21.110","minecraft:aggregate_feature":` + body + `}`}, &diags, nil)
		if p == nil {
			t.Fatalf("parseFile returned nil, diags: %v", diags)
		}
		if !p.formatVersion.Present || p.formatVersion.Raw != "1.21.110" {
			t.Errorf("formatVersion = %+v, want 1.21.110 present", p.formatVersion)
		}
		// 1.21.110 sits below the 1.26.50 rename gate -- numerically, not lexically, which is
		// the trap: a string comparison would put "1.21.110" above "1.26.50".
		if p.formatVersion.AtLeast(MustFormatVersion("1.26.50")) {
			t.Error("1.21.110 must NOT satisfy a 1.26.50 gate")
		}
		if !p.formatVersion.AtLeast(MustFormatVersion("1.21.40")) {
			t.Error("1.21.110 must satisfy a 1.21.40 gate")
		}
		if len(diags) != 0 {
			t.Errorf("unexpected diagnostics: %v", diags)
		}
	})

	t.Run("array form", func(t *testing.T) {
		var diags []Diagnostic
		p := parseFile(SourceFile{ID: "f", Text: `{"format_version":[1,21,110],"minecraft:aggregate_feature":` + body + `}`}, &diags, nil)
		if p == nil {
			t.Fatalf("parseFile returned nil, diags: %v", diags)
		}
		if p.formatVersion.Raw != "1.21.110" {
			t.Errorf("Raw = %q, want %q", p.formatVersion.Raw, "1.21.110")
		}
	})

	t.Run("absent warns but still builds", func(t *testing.T) {
		var diags []Diagnostic
		p := parseFile(SourceFile{ID: "f", Text: `{"minecraft:aggregate_feature":` + body + `}`}, &diags, nil)
		if p == nil {
			t.Fatalf("an absent format_version must not abort the file, diags: %v", diags)
		}
		if p.formatVersion.Present {
			t.Error("formatVersion must not report Present when the key is absent")
		}
		if len(diags) != 1 || diags[0].Level != "warning" {
			t.Fatalf("want exactly one warning, got %v", diags)
		}
		// The message has to say what the GAME does, not just what this tool did -- otherwise
		// an author reads it as a tool quirk and ignores it.
		if !strings.Contains(diags[0].Message, "game requires it") {
			t.Errorf("warning should say the game requires the key, got %q", diags[0].Message)
		}
	})

	t.Run("malformed is an error and aborts the file", func(t *testing.T) {
		var diags []Diagnostic
		p := parseFile(SourceFile{ID: "f", Text: `{"format_version":"1.x.0","minecraft:aggregate_feature":` + body + `}`}, &diags, nil)
		if p != nil {
			t.Error("a malformed format_version must abort the file -- which schema applies is unknowable")
		}
		if len(diags) != 1 || diags[0].Level != "error" {
			t.Fatalf("want exactly one error, got %v", diags)
		}
	})
}

func TestFormatVersion_AtLeastIsInclusiveAndAbsentFails(t *testing.T) {
	min := MustFormatVersion("1.21.0")
	if !MustFormatVersion("1.21.0").AtLeast(min) {
		t.Error("a version equal to the minimum must satisfy the gate")
	}
	if !MustFormatVersion("1.21.10").AtLeast(min) {
		t.Error("a version above the minimum must satisfy the gate")
	}
	if MustFormatVersion("1.20.80").AtLeast(min) {
		t.Error("a version below the minimum must not satisfy the gate")
	}
	var absent FormatVersion
	if absent.AtLeast(min) {
		t.Error("an absent version must never satisfy a gate")
	}
	// The assertion above passes even without the Present check, because an absent version has
	// no components and so compares below "1.21.0" anyway -- it was written first and it does
	// not actually test what it claims. A gate whose minimum is all zeroes is the case that
	// separates the two: component-wise comparison alone calls that EQUAL and lets an absent
	// version through, so this is the assertion that pins the Present check.
	if absent.AtLeast(MustFormatVersion("0.0.0")) {
		t.Error("an absent version must not satisfy even an all-zero minimum")
	}
	if absent.AtLeast(FormatVersion{}) {
		t.Error("an absent version must not satisfy an absent minimum")
	}
}
