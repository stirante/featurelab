package pack

import (
	"path/filepath"
	"strings"
	"testing"
)

// addonBP/addonRP name the fixture add-on under testdata/addon: a behaviour
// pack, the resource pack its manifest depends on, and a THIRD resource pack
// sitting right beside them that it does not depend on -- the whole point of
// the fixture being that the lookup must pick the one the manifest names and
// not merely the first plausible directory it walks past.
var (
	addonBP        = filepath.Join("testdata", "addon", "MyAddon_bp")
	addonRP        = filepath.Join("testdata", "addon", "MyAddon_rp")
	addonUnrelated = filepath.Join("testdata", "addon", "Unrelated_rp")
)

func TestFindResourcePack_ByManifestDependency(t *testing.T) {
	rp, notes, err := FindResourcePack(addonBP, "")
	if err != nil {
		t.Fatalf("FindResourcePack: %v", err)
	}
	if rp == nil {
		t.Fatalf("no resource pack found; notes = %v", notes)
	}
	if !SamePath(rp.Dir, abs(t, addonRP)) {
		t.Errorf("Dir = %q, want %q", rp.Dir, addonRP)
	}
	if SamePath(rp.Dir, abs(t, addonUnrelated)) {
		t.Error("picked the unrelated resource pack the behaviour pack does not depend on")
	}
	if rp.How != "manifest dependency" {
		t.Errorf("How = %q, want \"manifest dependency\"", rp.How)
	}
	if rp.Name != "MyAddon resources" {
		t.Errorf("Name = %q, want the manifest header name", rp.Name)
	}
	if rp.TerrainTexturePath == "" {
		t.Error("TerrainTexturePath is empty, but the fixture resource pack has one")
	}
	if len(notes) != 0 {
		t.Errorf("notes = %v, want none for a clean lookup", notes)
	}
}

// TestFindResourcePack_ExplicitOverrideIsUsedVerbatim pins that naming a
// directory means that directory: no search runs, and the unrelated pack is
// used exactly as asked even though it is not the manifest dependency.
func TestFindResourcePack_ExplicitOverrideIsUsedVerbatim(t *testing.T) {
	rp, _, err := FindResourcePack(addonBP, addonUnrelated)
	if err != nil {
		t.Fatalf("FindResourcePack: %v", err)
	}
	if !SamePath(rp.Dir, addonUnrelated) {
		t.Errorf("Dir = %q, want the directory that was named, %q", rp.Dir, addonUnrelated)
	}
	if rp.How != "explicit" {
		t.Errorf("How = %q, want \"explicit\"", rp.How)
	}
}

// TestFindResourcePack_ExplicitOverrideWithoutTerrainTextureSaysSo: the
// unrelated fixture pack has a manifest but no textures/terrain_texture.json,
// which resolves no texture key at all -- worth one sentence up front rather
// than discovering it as every texture missing.
func TestFindResourcePack_ExplicitOverrideWithoutTerrainTextureSaysSo(t *testing.T) {
	rp, notes, err := FindResourcePack(addonBP, addonUnrelated)
	if err != nil {
		t.Fatalf("FindResourcePack: %v", err)
	}
	if rp.TerrainTexturePath != "" {
		t.Fatalf("TerrainTexturePath = %q, want empty for a pack without one", rp.TerrainTexturePath)
	}
	if !anyContains(notes, "terrain_texture.json") {
		t.Errorf("notes = %v, want one naming the missing terrain_texture.json", notes)
	}
}

func TestFindResourcePack_MissingOverrideIsAnError(t *testing.T) {
	if _, _, err := FindResourcePack(addonBP, filepath.Join("testdata", "addon", "NoSuchPack")); err == nil {
		t.Error("want an error for an explicitly named directory that does not exist")
	}
}

// TestFindResourcePack_NoneFoundIsNotAnError pins the fallback contract: a
// behaviour pack with no resource pack beside it is ordinary, and the answer is
// a note explaining what was looked for, not a failure.
func TestFindResourcePack_NoneFoundIsNotAnError(t *testing.T) {
	rp, notes, err := FindResourcePack(filepath.Join("testdata", "vanilla-trees"), "")
	if err != nil {
		t.Fatalf("FindResourcePack: %v", err)
	}
	if rp != nil {
		t.Fatalf("found %q, want none -- testdata/vanilla-trees has no resource pack", rp.Dir)
	}
	if !anyContains(notes, "no resource pack found") {
		t.Errorf("notes = %v, want one saying nothing was found and what to do", notes)
	}
}

// TestNamesPair covers the fallback rule used when the manifest link is absent
// or unusable -- including that it does NOT pair two unrelated stems.
func TestNamesPair(t *testing.T) {
	cases := []struct {
		bp, rp string
		want   bool
	}{
		{"MyAddon_bp", "MyAddon_rp", true},
		{"myaddon_BP", "myaddon_RP", true},
		{"cool_behavior_pack", "cool_resource_pack", true},
		{"coolBP", "coolRP", true},
		{"cool-bp", "cool-rp", true},
		{"cool_behaviors", "cool_resources", true},
		{"MyAddon_bp", "OtherAddon_rp", false},
		{"MyAddon_bp", "textures", false},
		{"MyAddon", "MyAddon_rp", false},
	}
	for _, c := range cases {
		if got := namesPair(c.bp, c.rp); got != c.want {
			t.Errorf("namesPair(%q, %q) = %v, want %v", c.bp, c.rp, got, c.want)
		}
	}
}

func abs(t *testing.T, path string) string {
	t.Helper()
	// The search resolves packDir to an absolute path before walking, so
	// every directory it reports is absolute; a relative fixture path has to
	// be put on the same footing before comparing.
	full, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("filepath.Abs(%q): %v", path, err)
	}
	return full
}

func anyContains(notes []string, needle string) bool {
	for _, n := range notes {
		if strings.Contains(n, needle) {
			return true
		}
	}
	return false
}
