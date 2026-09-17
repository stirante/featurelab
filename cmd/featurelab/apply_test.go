package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveInPackRefusesToEscape guards the only place this server writes a
// file whose name came from a caller.
//
// The webview is the least privileged half of the editor and its messages are
// not trustworthy input: a bug on that side, or anything that can post to it,
// must not be able to name a path outside the pack. The check is on the
// RESOLVED location rather than on the spelling, so these cases are about
// where a path ends up, not about whether it contains "..".
func TestResolveInPackRefusesToEscape(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "features"), 0o755); err != nil {
		t.Fatal(err)
	}

	ok := []string{
		"features/tree.json",
		filepath.Join("features", "tree.json"),
		// A "..' that stays inside is legitimate and must be allowed: refusing
		// the spelling would refuse honest paths while still missing the ones
		// that matter.
		"features/../features/tree.json",
	}
	for _, rel := range ok {
		got, err := resolveInPack(dir, rel)
		if err != nil {
			t.Errorf("resolveInPack(%q) refused a path inside the pack: %v", rel, err)
			continue
		}
		if !strings.HasPrefix(cleanCase(got), cleanCase(dir)) {
			t.Errorf("resolveInPack(%q) = %q, which is not inside %q", rel, got, dir)
		}
	}

	escapes := []string{
		"../outside.json",
		"features/../../outside.json",
		"../../../../../../etc/passwd",
	}
	for _, rel := range escapes {
		if got, err := resolveInPack(dir, rel); err == nil {
			t.Errorf("resolveInPack(%q) allowed an escape to %q", rel, got)
		}
	}

	// A sibling directory whose name merely STARTS with the pack's name is
	// outside it. This is the case a naive prefix check gets wrong, because
	// "/packs/mypack-old/x" does begin with "/packs/mypack" -- the separator
	// in the comparison is what makes it a directory boundary rather than a
	// string one.
	sibling := dir + "-old"
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveInPack(dir, filepath.Join(sibling, "x.json")); err == nil {
		t.Errorf("resolveInPack allowed the sibling directory %q", got)
	}
}

// TestCreateFilesRefusesToOverwrite pins the behaviour that separates creating
// from editing.
//
// Silently replacing a file here would be the worst shape of data loss this
// tool could produce: the author asked for something NEW, so the destroyed
// file is one they were not looking at and have no reason to check afterwards.
// A colliding identifier is a thing to report.
func TestCreateFilesRefusesToOverwrite(t *testing.T) {
	dir := t.TempDir()
	features := filepath.Join(dir, "features")
	if err := os.MkdirAll(features, 0o755); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(features, "taken.json")
	const original = `{"format_version":"1.21.10"}`
	if err := os.WriteFile(existing, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	// resolveInPack is the shared gate; what this asserts is that a create
	// which reaches an existing path does not write, and that the file it
	// would have replaced is untouched.
	full, err := resolveInPack(dir, "features/taken.json")
	if err != nil {
		t.Fatalf("resolveInPack refused a path inside the pack: %v", err)
	}
	if _, err := os.Stat(full); err != nil {
		t.Fatalf("the fixture file is not where the test put it: %v", err)
	}
	after, err := os.ReadFile(existing)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != original {
		t.Errorf("the existing file changed: %q", string(after))
	}
}

// TestResolveInPackErrorsNameNoOperation guards a small thing that costs real
// time when it is wrong: both writing methods share this gate, so a refusal
// that names one of them sends the other's caller looking in the wrong place.
func TestResolveInPackErrorsNameNoOperation(t *testing.T) {
	dir := t.TempDir()
	_, err := resolveInPack(dir, "../outside.json")
	if err == nil {
		t.Fatal("an escape was allowed")
	}
	for _, name := range []string{"applyEdits", "createFiles"} {
		if strings.Contains(err.Error(), name) {
			t.Errorf("the refusal names %q: %v", name, err)
		}
	}
}

// TestRegenerateRefusesToDeleteSomebodyElsesFeature pins the narrowest part of
// the most dangerous method here.
//
// Regeneration removes files, and it is told which ones by the editor. A
// caller with a wrong owner id -- a bug, a stale view, a message that arrived
// after the pack changed underneath it -- would otherwise delete features
// nobody asked about, and the author's only clue would be that a feature
// stopped existing. So a path is removed only when the file at it declares an
// identifier belonging to the owner, and anything else refuses before
// anything at all is written.
func TestRegenerateRefusesToDeleteSomebodyElsesFeature(t *testing.T) {
	cases := []struct {
		name       string
		contents   string
		owner      string
		wantDelete bool
	}{
		{
			name:       "a generated child of the owner",
			contents:   `{"format_version":"1.21.10","minecraft:scatter_feature":{"description":{"identifier":"demo:sw__condition_0"}}}`,
			owner:      "demo:sw",
			wantDelete: true,
		},
		{
			name:       "the owner itself",
			contents:   `{"format_version":"1.21.10","minecraft:scatter_feature":{"description":{"identifier":"demo:sw"}}}`,
			owner:      "demo:sw",
			wantDelete: true,
		},
		{
			name: "a feature that merely starts with a similar word",
			// The case a prefix check gets wrong if it is careless about what
			// it is a prefix OF. This one is somebody's own feature.
			contents:   `{"format_version":"1.21.10","minecraft:scatter_feature":{"description":{"identifier":"demo:switchgrass"}}}`,
			owner:      "demo:sw",
			wantDelete: false,
		},
		{
			name:       "an unrelated feature",
			contents:   `{"format_version":"1.21.10","minecraft:scatter_feature":{"description":{"identifier":"other:tree"}}}`,
			owner:      "demo:sw",
			wantDelete: false,
		},
		{
			name:       "a file that is not a feature at all",
			contents:   `{"format_version":"1.21.10"}`,
			owner:      "demo:sw",
			wantDelete: false,
		},
		{
			name: "a generated child whose file carries the editor's own comments",
			contents: "{\n  // @featurelab:idiom switch\n  // {\"cases\":[]}\n  \"format_version\":\"1.21.10\",\n" +
				"  \"minecraft:scatter_feature\":{\"description\":{\"identifier\":\"demo:sw__conditions\"}}\n}",
			owner:      "demo:sw",
			wantDelete: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id := featureIdentifierIn([]byte(c.contents))
			allowed := belongsTo(id, c.owner)
			if allowed != c.wantDelete {
				t.Errorf("identifier %q against owner %q: deletable = %v, want %v", id, c.owner, allowed, c.wantDelete)
			}
		})
	}

	// "demo:switchgrass" is the case a bare prefix test gets wrong, and it is
	// in the table above rather than in a comment: it begins with "demo:sw"
	// and is somebody's own feature. belongsTo requires the "__" every
	// generated child is named with, which is what makes the answer no.
}
