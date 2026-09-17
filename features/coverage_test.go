// coverage_test.go guards the coverage table in coverage.go.
//
// The coverage table exists so claims about what this tool supports stay true. That only
// works if it cannot drift away from the code, which is exactly how README came to say
// "ten of the eleven types" long after that stopped being right.
//
// These assertions are two-directional on purpose: implementing a type without listing it
// fails, and listing a type as done without implementing it fails too.
package features

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

func registeredSet(t *testing.T) map[string]bool {
	t.Helper()
	set := make(map[string]bool)
	for _, id := range RegisteredTypes() {
		set[id] = true
	}
	return set
}

// requiresBuilder reports whether a coverage entry's status implies a registered builder must
// exist for it: StatusImplemented/StatusPartial, yes; StatusMissing/StatusOutOfScope, no --
// "not yet ported" and "deliberately out of scope" (see StatusOutOfScope's own doc comment) are
// different REASONS for having no builder, but the same fact as far as the registry is
// concerned. Panics on an unhandled status rather than defaulting either way, so the
// two-directional check below can't silently go stale the next time a status is added -- it
// would fail loudly here instead.
func requiresBuilder(s CoverageStatus) bool {
	switch s {
	case StatusImplemented, StatusPartial:
		return true
	case StatusMissing, StatusOutOfScope:
		return false
	default:
		panic(fmt.Sprintf("coverage_test.go: requiresBuilder: unhandled CoverageStatus %q -- add it here explicitly", s))
	}
}

func TestCoverageHasExactly29Types(t *testing.T) {
	// The game registers every JSON feature type unconditionally, so this count is a property of
	// the targeted game version. A change here means the target version changed, not that the
	// table needs relaxing.
	//
	// 26 in the previous target, 29 in this one. Note that the number registered and the number
	// AVAILABLE to a given pack are different questions: each type's schema exists only in the
	// format_version bands at or above the type's own minimum, so a pack declaring an older
	// format_version sees 27 of these rather than 29. This assertion is about registration.
	if got := len(FeatureTypeCoverage); got != 29 {
		t.Errorf("len(FeatureTypeCoverage) = %d, want 29", got)
	}
}

func TestCoverageListsNoTypeTwice(t *testing.T) {
	seen := make(map[string]bool)
	for _, e := range FeatureTypeCoverage {
		if seen[e.TypeID] {
			t.Errorf("typeID %q listed more than once", e.TypeID)
		}
		seen[e.TypeID] = true
	}
}

func TestCoverageHasBuilderForEveryImplementedOrPartialType(t *testing.T) {
	registered := registeredSet(t)
	var unbacked []string
	for _, e := range FeatureTypeCoverage {
		if requiresBuilder(e.Status) && !registered[e.TypeID] {
			unbacked = append(unbacked, e.TypeID)
		}
	}
	if len(unbacked) != 0 {
		t.Errorf("listed as supported but no builder is registered: %v", unbacked)
	}
}

// TestCoverageHasNoBuilderForAnyMissingOrOutOfScopeType is the other direction of the check
// above: neither "not yet ported" (StatusMissing) nor "deliberately out of scope"
// (StatusOutOfScope) may have a live builder -- if one does, the status is stale (the type got
// implemented, or the out-of-scope call needs revisiting because it's implemented after all) and
// coverage.go must be updated to say so, not silently left behind.
func TestCoverageHasNoBuilderForAnyMissingOrOutOfScopeType(t *testing.T) {
	registered := registeredSet(t)
	var stale []string
	for _, e := range FeatureTypeCoverage {
		if !requiresBuilder(e.Status) && registered[e.TypeID] {
			stale = append(stale, e.TypeID)
		}
	}
	if len(stale) != 0 {
		t.Errorf("implemented since — mark it in coverage.go (as StatusImplemented/StatusPartial) and update README: %v", stale)
	}
}

func TestCoverageListsEveryRegisteredBuilder(t *testing.T) {
	var unlisted []string
	for _, id := range RegisteredTypes() {
		if _, ok := CoverageFor(id); !ok {
			unlisted = append(unlisted, id)
		}
	}
	if len(unlisted) != 0 {
		t.Errorf("registered but absent from the coverage table: %v", unlisted)
	}
}

func TestCoverageExplainsEveryGap(t *testing.T) {
	// A gap with no note is a gap nobody can act on.
	var unexplained []string
	for _, e := range FeatureTypeCoverage {
		if e.Status != StatusImplemented && e.Note == "" {
			unexplained = append(unexplained, e.TypeID)
		}
	}
	if len(unexplained) != 0 {
		t.Errorf("gap(s) with no note: %v", unexplained)
	}
}

// TestCoverageNotesAreUserFacing pins the split between CoverageEntry.Note and
// CoverageEntry.evidence.
//
// Note is printed verbatim by `featurelab types` and appended to the diagnostic a pack gets when
// it uses an unimplemented type, so it reaches an add-on author who is trying to understand their
// own JSON. Internal implementation reasoning belongs in the unexported `evidence` field, which
// is never serialised or printed; Note says what a gap MEANS for a pack.
//
// This test is the guard that keeps the two apart. It is deliberately a crude keyword-and-shape
// check rather than anything clever: the failure mode it exists to catch is someone pasting
// internal reasoning into the wrong field, and a crude check catches that reliably.
func TestCoverageNotesAreUserFacing(t *testing.T) {
	// Tooling words that must never appear in user-facing text, plus one more that is only
	// ever internal jargon in a note.
	banned := append(toolingWords(), reversed("delgnam"))
	// A bare hex or long decimal token. `[0-9]{7,}` would also match a huge count, but no
	// user-facing sentence has a legitimate reason to contain one.
	addr := regexp.MustCompile(`0x[0-9A-Fa-f]{4,}|\b[0-9]{7,}\b`)

	for _, e := range FeatureTypeCoverage {
		for _, w := range banned {
			if strings.Contains(e.Note, w) {
				t.Errorf("%s: Note contains %q -- that belongs in the entry's evidence field, "+
					"which is never printed. Note is what `featurelab types` shows a pack author.",
					e.TypeID, w)
			}
		}
		if m := addr.FindString(e.Note); m != "" {
			t.Errorf("%s: Note contains the hex/long-number token %q -- move the reasoning to the "+
				"entry's evidence field and say in Note what the gap MEANS for a pack.", e.TypeID, m)
		}
	}
}

// TestCoverageEvidenceIsRecorded is the other half of the split: moving a derivation out of Note
// must not mean throwing it away. Every entry whose Note describes a gap has to record the
// reasoning behind its status, or a later pass targeting a new game version has nothing to
// re-check against and will re-guess instead -- which is the specific way this project has
// produced wrong claims before.
func TestCoverageEvidenceIsRecorded(t *testing.T) {
	var undocumented []string
	for _, e := range FeatureTypeCoverage {
		if e.Status != StatusImplemented && e.evidence == "" {
			undocumented = append(undocumented, e.TypeID)
		}
	}
	if len(undocumented) != 0 {
		t.Errorf("gap(s) with no recorded reasoning in their evidence field: %v", undocumented)
	}
}

func TestCoverageSummarisesConsistently(t *testing.T) {
	s := CoverageSummary()
	if s.Implemented+s.Partial+s.Missing+s.OutOfScope != s.Total {
		t.Errorf("implemented(%d) + partial(%d) + missing(%d) + outOfScope(%d) != total(%d)",
			s.Implemented, s.Partial, s.Missing, s.OutOfScope, s.Total)
	}
	// The numbers README quotes. Update both together or not at all -- and prefer changing them
	// only when a status genuinely moved, since this literal is the tripwire that catches a
	// status edited in coverage.go without anyone deciding it should move.
	//
	// This used to carry a running commentary of every past promotion and demotion, one paragraph
	// per type, which grew to some forty lines and had itself gone stale in three places. That
	// history belongs to the entries it describes: each CoverageEntry now has an unexported
	// `evidence` field holding its own status reasoning, so the account of WHY a
	// type sits where it does travels with the type instead of accumulating here.
	//
	// Where the 1.26.50.24 retarget left things: 29 registered types, nothing StatusMissing.
	// Three types are new in that version (horizontal_tree_decoration_feature at Partial because
	// its two block-state gates cannot be evaluated by this bench, multi_block_feature and
	// multipart_block_column_feature at Implemented). snap_to_surface_feature moved Implemented
	// -> Partial, with the reason recorded in its own evidence field rather than here.
	//
	// 2026-08-22: structure_template_feature moved Partial -> Implemented. Its own note said it
	// was Partial "for one reason", the two block predicates it leans on being stand-ins rather
	// than vanilla data, and block/motion.go closed both.
	want := Summary{Total: 29, Implemented: 22, Partial: 5, Missing: 0, OutOfScope: 2}
	if s != want {
		t.Errorf("CoverageSummary() = %+v, want %+v", s, want)
	}
}
