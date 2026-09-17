// formatversion_gates_test.go pins the version gates the 1.26.50.24 engine applies to feature
// JSON: which TYPES a file may name (typeavailability.go) and which KEYS exist inside the
// types that have a gated schema (single_block.go's four branches, scatter.go's legacy/nested
// split). The derivation for each of them lives in that feature's own header.
//
// These tests exist because a gate is invisible in a bench run: a file that declares an old
// format_version and writes a new key looks like it works, and the divergence only shows up in
// the real game, which is precisely the failure this tool exists to prevent. Each test
// therefore asserts BOTH sides of a gate -- the version where the key works and the version
// where it does not -- since a gate stuck open and a gate stuck shut are equally wrong and a
// one-sided test catches only one of them.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// buildOne builds a single-file library and returns the resolved feature (nil if it failed to
// build) plus every diagnostic the build produced.
func buildOne(t *testing.T, identifier, doc string) (wgen.IFeature, []Diagnostic) {
	t.Helper()
	lib := BuildLibrary([]SourceFile{{ID: identifier + ".json", Text: doc}}, block.NewPalette(), nil)
	return lib.Resolve(identifier), lib.Diagnostics
}

// diagWith reports the first diagnostic of the given level whose message contains substr.
func diagWith(diags []Diagnostic, level, substr string) (Diagnostic, bool) {
	for _, d := range diags {
		if d.Level == level && strings.Contains(d.Message, substr) {
			return d, true
		}
	}
	return Diagnostic{}, false
}

func diagLines(diags []Diagnostic) string {
	var b strings.Builder
	for _, d := range diags {
		b.WriteString("\n  " + d.Level + ": " + d.Message)
	}
	if b.Len() == 0 {
		return " (none)"
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// Type availability
// ---------------------------------------------------------------------------

func multiBlockDoc(formatVersion string) string {
	return `{
		"format_version": "` + formatVersion + `",
		"minecraft:multi_block_feature": {
			"description": {"identifier": "test:mb"},
			"places_block": "minecraft:stone"
		}
	}`
}

func TestTypeAvailability_MultiBlockRejectedBelowItsBand(t *testing.T) {
	// 1.21.110 is NEWER than 1.21.40 but OLDER than 1.26.40 -- the case a naive
	// "is this a recent pack" check gets wrong, and a version real packs commonly declare.
	feature, diags := buildOne(t, "test:mb", multiBlockDoc("1.21.110"))
	if feature != nil {
		t.Errorf("multi_block_feature built at format_version 1.21.110, but the engine's schema for "+
			"that version has no such type; diagnostics:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "error", "introduced at format_version 1.26.40"); !ok {
		t.Errorf("expected an error naming the version that introduced the type, got:%s", diagLines(diags))
	}
}

func TestTypeAvailability_MultiBlockAcceptedAtItsBand(t *testing.T) {
	// Exactly at the threshold: the engine registers a type into the band that CONTAINS its
	// min version, so equality must pass. An off-by-one here would reject every file that
	// declares the very version the type was introduced in.
	if _, diags := buildOne(t, "test:mb", multiBlockDoc("1.26.40")); len(diags) > 0 {
		if _, ok := diagWith(diags, "error", "introduced at format_version"); ok {
			t.Errorf("multi_block_feature refused at its own introducing version:%s", diagLines(diags))
		}
	}
}

func TestTypeAvailability_UngatedTypeIsUsableAtTheFloor(t *testing.T) {
	// horizontal_tree_decoration_feature is new in 1.26.50.24 as an IMPLEMENTATION but is
	// registered at feature schema version 2 (= 1.13.0), so an old file may name it. "New in this
	// build" and "gated to this build" are different claims and this is the one that catches
	// the confusion.
	doc := `{
		"format_version": "1.13.0",
		"minecraft:horizontal_tree_decoration_feature": {
			"description": {"identifier": "test:htd"},
			"places_block": "minecraft:vine",
			"tree_blocks": ["minecraft:oak_log"]
		}
	}`
	_, diags := buildOne(t, "test:htd", doc)
	if _, ok := diagWith(diags, "error", "introduced at format_version"); ok {
		t.Errorf("horizontal_tree_decoration_feature was version-gated, but it registers at the "+
			"schema floor:%s", diagLines(diags))
	}
}

func TestSchemaFloor_VersionBelowEveryBandIsRefused(t *testing.T) {
	doc := `{
		"format_version": "1.12.0",
		"minecraft:single_block_feature": {
			"description": {"identifier": "test:sb"},
			"places_block": "minecraft:stone",
			"enforce_placement_rules": false,
			"enforce_survivability_rules": false
		}
	}`
	feature, diags := buildOne(t, "test:sb", doc)
	if feature != nil {
		t.Errorf("a file below the oldest schema band built anyway; diagnostics:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "error", "oldest version any feature schema covers"); !ok {
		t.Errorf("expected the no-matching-schema error, got:%s", diagLines(diags))
	}
}

// ---------------------------------------------------------------------------
// scatter_feature: the flat/nested split at 1.21.10
// ---------------------------------------------------------------------------

// scatterLegacyDoc and scatterNestedDoc describe the SAME distribution in the two spellings:
// three fixed-grid steps along x, nothing on y/z.
func scatterLegacyDoc(formatVersion string) string {
	return `{
		"format_version": "` + formatVersion + `",
		"minecraft:scatter_feature": {
			"description": {"identifier": "test:scatter_legacy"},
			"places_feature": "test:mark",
			"iterations": 3,
			"x": {"distribution": "fixed_grid", "extent": [0, 2]},
			"y": 0,
			"z": 0
		}
	}`
}

func scatterNestedDoc(formatVersion string) string {
	return `{
		"format_version": "` + formatVersion + `",
		"minecraft:scatter_feature": {
			"description": {"identifier": "test:scatter_nested"},
			"places_feature": "test:mark",
			"distribution": {
				"iterations": 3,
				"x": {"distribution": "fixed_grid", "extent": [0, 2]},
				"y": 0,
				"z": 0
			}
		}
	}`
}

// placeScatter resolves a built scatter against a recording delegate and returns the origins it
// delegated to, so two spellings of one distribution can be compared by what they actually do
// rather than by how they parsed.
func placeScatter(t *testing.T, doc, identifier string) []wgen.BlockPos {
	t.Helper()
	pal := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: identifier + ".json", Text: doc}}, pal, nil)
	f := lib.Resolve(identifier)
	if f == nil {
		t.Fatalf("%s did not build:%s", identifier, diagLines(lib.Diagnostics))
	}
	rec := &recordingDelegate{}
	sf, ok := f.(*ScatterFeature)
	if !ok {
		t.Fatalf("%s built as %T, want *ScatterFeature", identifier, f)
	}
	sf.resolver = recordingResolver{rec}
	v := volume.New(volume.Bounds{MinX: -32, MinY: -32, MinZ: -32, SizeX: 64, SizeY: 64, SizeZ: 64}, pal, block.AirID)
	f.Place(&wgen.PlacementContext{
		API: v, Origin: wgen.BlockPos{}, Random: random.New(1), MolangScope: wgen.NewScope(),
		Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(string, string, wgen.BlockPos) {},
		LogWarning: func(string, string, *wgen.BlockPos) {},
	})
	return rec.origins
}

func TestScatter_LegacyFlatShapeMatchesNestedShape(t *testing.T) {
	// 1.20.0 is below the 1.21.10 gate, so the flat keys are that file's only spelling; the
	// legacy schema registers the same value types per key, so the two must place identically.
	legacy := placeScatter(t, strings.ReplaceAll(scatterLegacyDoc("1.20.0"), "test:mark", "test:recorder"), "test:scatter_legacy")
	nested := placeScatter(t, strings.ReplaceAll(scatterNestedDoc("1.21.110"), "test:mark", "test:recorder"), "test:scatter_nested")
	if len(legacy) == 0 {
		t.Fatalf("the legacy flat shape placed nothing")
	}
	if len(legacy) != len(nested) {
		t.Fatalf("legacy placed %d, nested placed %d — the same distribution in two spellings", len(legacy), len(nested))
	}
	for i := range legacy {
		if legacy[i] != nested[i] {
			t.Fatalf("placement %d differs: legacy %v, nested %v", i, legacy[i], nested[i])
		}
	}
}

func TestScatter_NestedDistributionIsNotInTheLegacySchema(t *testing.T) {
	doc := strings.ReplaceAll(scatterNestedDoc("1.20.0"), "test:scatter_nested", "test:s")
	feature, diags := buildOne(t, "test:s", doc)
	if feature != nil {
		t.Errorf("a pre-1.21.10 file built from a nested distribution the schema does not have:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "warning", "is not present in the schema for format_version 1.20.0"); !ok {
		t.Errorf("expected the member-not-in-schema warning naming distribution, got:%s", diagLines(diags))
	}
}

func TestScatter_FlatKeysAreNotInTheModernSchema(t *testing.T) {
	doc := strings.ReplaceAll(scatterLegacyDoc("1.21.110"), "test:scatter_legacy", "test:s")
	feature, diags := buildOne(t, "test:s", doc)
	if feature != nil {
		t.Errorf("a 1.21.110 file built from flat scatter keys, which that schema does not have:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "error", "distribution"); !ok {
		t.Errorf("expected an error about the missing required distribution object, got:%s", diagLines(diags))
	}
	// And the flat keys the author DID write have to be named. Without this the file gets
	// "distribution must be an object" and no hint that the six keys it carries were seen and
	// dropped -- which is the same silence the version gates exist to break.
	if _, ok := diagWith(diags, "warning", "iterations"); !ok {
		t.Errorf("the flat keys that were dropped are not named anywhere:%s", diagLines(diags))
	}
}

func TestScatter_ModernFileCarryingBothShapesReportsTheFlatKeys(t *testing.T) {
	// A file that writes both is the case that used to pass in complete silence: the nested
	// object satisfies the required key, so nothing errored, and the flat keys were dropped
	// with nothing said. They are dead weight in that file and an author should hear about it.
	doc := `{
		"format_version": "1.26.50",
		"minecraft:scatter_feature": {
			"description": {"identifier": "test:both"},
			"places_feature": "test:recorder",
			"iterations": 3,
			"x": 1,
			"distribution": {"iterations": 3, "x": 0, "y": 0, "z": 0}
		}
	}`
	feature, diags := buildOne(t, "test:both", doc)
	if feature == nil {
		t.Fatalf("the nested distribution is present and valid, so the file must still build:%s", diagLines(diags))
	}
	w, ok := diagWith(diags, "warning", "not present in the schema for format_version 1.26.50")
	if !ok {
		t.Fatalf("the stray flat keys were dropped silently:%s", diagLines(diags))
	}
	for _, key := range []string{"iterations", "x"} {
		if !strings.Contains(w.Message, key) {
			t.Errorf("the warning does not name the dropped key %q: %s", key, w.Message)
		}
	}
}

// ---------------------------------------------------------------------------
// single_block_feature: the four branches at 1.21.40
// ---------------------------------------------------------------------------

func singleBlockGateDoc(formatVersion, extraKeys string) string {
	return `{
		"format_version": "` + formatVersion + `",
		"minecraft:single_block_feature": {
			"description": {"identifier": "test:sb"},
			"places_block": "minecraft:stone",
			"enforce_placement_rules": false,
			"enforce_survivability_rules": false` + extraKeys + `
		}
	}`
}

func buildSingleBlockAt(t *testing.T, formatVersion, extraKeys string) (*SingleBlockFeature, []Diagnostic) {
	t.Helper()
	f, diags := buildOne(t, "test:sb", singleBlockGateDoc(formatVersion, extraKeys))
	if f == nil {
		return nil, diags
	}
	sb, ok := f.(*SingleBlockFeature)
	if !ok {
		t.Fatalf("built as %T, want *SingleBlockFeature", f)
	}
	return sb, diags
}

func TestSingleBlock_RandomizeRotationIsDroppedBelow1_21_40(t *testing.T) {
	sb, diags := buildSingleBlockAt(t, "1.21.10", `, "randomize_rotation": true`)
	if sb == nil {
		t.Fatalf("file did not build:%s", diagLines(diags))
	}
	if sb.randomizeRotation {
		t.Errorf("randomize_rotation took effect at format_version 1.21.10, where the key is not in "+
			"the schema; the game drops it:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "warning", "randomize_rotation"); !ok {
		t.Errorf("the dropped key was not reported:%s", diagLines(diags))
	}
}

func TestSingleBlock_RandomizeRotationAppliesAtAndAbove1_21_40(t *testing.T) {
	for _, v := range []string{"1.21.40", "1.21.110", "1.26.50"} {
		sb, diags := buildSingleBlockAt(t, v, `, "randomize_rotation": true`)
		if sb == nil {
			t.Fatalf("format_version %s did not build:%s", v, diagLines(diags))
		}
		if !sb.randomizeRotation {
			t.Errorf("randomize_rotation was dropped at format_version %s, where the schema has it:%s",
				v, diagLines(diags))
		}
	}
}

func TestSingleBlock_MayNotAttachToIsDroppedBelow1_21_40(t *testing.T) {
	extra := `, "may_not_attach_to": {"top": "minecraft:stone"}`
	sb, diags := buildSingleBlockAt(t, "1.21.10", extra)
	if sb == nil {
		t.Fatalf("file did not build:%s", diagLines(diags))
	}
	if !sb.mayNotAttachTo[dirTop].Empty() {
		t.Errorf("may_not_attach_to was honoured below 1.21.40, where the key does not exist")
	}
	if sb.attachConfigured {
		t.Errorf("a dropped may_not_attach_to still switched the attach test on — that flag decides " +
			"whether auto_rotate can fire, so this changes placement, not just the exclusion")
	}
	if _, ok := diagWith(diags, "warning", "may_not_attach_to"); !ok {
		t.Errorf("the dropped key was not reported:%s", diagLines(diags))
	}
}

func TestSingleBlock_DiagonalFaceIsDroppedBelow1_21_40(t *testing.T) {
	extra := `, "may_attach_to": {"top": "minecraft:stone", "diagonal": "minecraft:dirt"}`
	sb, diags := buildSingleBlockAt(t, "1.21.10", extra)
	if sb == nil {
		t.Fatalf("file did not build:%s", diagLines(diags))
	}
	if !sb.mayAttachTo[dirDiagonal].Empty() {
		t.Errorf("may_attach_to.diagonal was honoured below 1.21.40, where attach direction 8 is not " +
			"registered")
	}
	if sb.mayAttachTo[dirTop].Empty() {
		t.Errorf("gating diagonal also dropped the ungated top face")
	}
	if _, ok := diagWith(diags, "warning", "diagonal"); !ok {
		t.Errorf("the dropped face was not reported:%s", diagLines(diags))
	}
}

func TestSingleBlock_DiagonalFaceAppliesAtAndAbove1_21_40(t *testing.T) {
	extra := `, "may_attach_to": {"diagonal": "minecraft:dirt"}`
	sb, diags := buildSingleBlockAt(t, "1.21.40", extra)
	if sb == nil {
		t.Fatalf("file did not build:%s", diagLines(diags))
	}
	if sb.mayAttachTo[dirDiagonal].Empty() {
		t.Errorf("may_attach_to.diagonal was dropped at 1.21.40, the version that introduces it:%s",
			diagLines(diags))
	}
}

func TestSingleBlock_WeightedArrayPlacesBlockRejectedBelow1_21_40(t *testing.T) {
	extra := ""
	doc := `{
		"format_version": "1.21.10",
		"minecraft:single_block_feature": {
			"description": {"identifier": "test:sb"},
			"places_block": [{"block": "minecraft:stone", "weight": 1}],
			"enforce_placement_rules": false,
			"enforce_survivability_rules": false` + extra + `
		}
	}`
	feature, diags := buildOne(t, "test:sb", doc)
	if feature != nil {
		t.Errorf("the weighted array form built at 1.21.10, where places_block is a single "+
			"descriptor node:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "error", "weighted array"); !ok {
		t.Errorf("expected an error explaining the array form's minimum version, got:%s", diagLines(diags))
	}
}

// ---------------------------------------------------------------------------
// The unversioned policy
// ---------------------------------------------------------------------------

func TestUnversionedFileIsJudgedOnWhatItWrote(t *testing.T) {
	// No format_version at all: the loader says the game would refuse the file, and nothing
	// downstream punishes the same omission a second time by quietly disabling modern keys.
	// See FormatVersion.AtLeastOrUnversioned for the argument.
	doc := `{
		"minecraft:single_block_feature": {
			"description": {"identifier": "test:sb"},
			"places_block": [{"block": "minecraft:stone", "weight": 1}],
			"enforce_placement_rules": false,
			"enforce_survivability_rules": false,
			"randomize_rotation": true,
			"may_not_attach_to": {"top": "minecraft:stone"}
		}
	}`
	f, diags := buildOne(t, "test:sb", doc)
	if f == nil {
		t.Fatalf("an unversioned file did not build:%s", diagLines(diags))
	}
	sb := f.(*SingleBlockFeature)
	if !sb.randomizeRotation || sb.mayNotAttachTo[dirTop].Empty() {
		t.Errorf("modern keys were dropped from an unversioned file:%s", diagLines(diags))
	}
	if _, ok := diagWith(diags, "warning", "format_version is missing"); !ok {
		t.Errorf("the missing format_version was not reported:%s", diagLines(diags))
	}
}

func TestFormatVersion_AtLeastOrUnversioned(t *testing.T) {
	min := MustFormatVersion("1.21.40")
	cases := []struct {
		declared string
		want     bool
	}{
		{"", true}, // absent
		{"1.21.39", false},
		{"1.21.40", true},
		{"1.21.110", true},
		{"1.13.0", false},
	}
	for _, c := range cases {
		var fv FormatVersion
		if c.declared != "" {
			fv = MustFormatVersion(c.declared)
		}
		if got := fv.AtLeastOrUnversioned(min); got != c.want {
			t.Errorf("FormatVersion(%q).AtLeastOrUnversioned(1.21.40) = %v, want %v", c.declared, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Case-folded identifiers
// ---------------------------------------------------------------------------

func TestLibrary_ResolvesFeatureReferencesWithoutRegardToCase(t *testing.T) {
	// The engine's feature registry lower-cases both the key it stores and the key it looks up,
	// so a reference that differs from its target only in case resolves there. This port compared
	// exactly, which meant a pack that works in game could report "could not be resolved" here --
	// and an author could "fix" a file that was never broken.
	doc := `{
		"format_version": "1.21.110",
		"minecraft:single_block_feature": {
			"description": {"identifier": "test:MixedCase"},
			"places_block": "minecraft:stone",
			"enforce_placement_rules": false,
			"enforce_survivability_rules": false
		}
	}`
	lib := BuildLibrary([]SourceFile{{ID: "mixed.json", Text: doc}}, block.NewPalette(), nil)
	for _, spelling := range []string{"test:MixedCase", "test:mixedcase", "test:MIXEDCASE"} {
		if lib.Resolve(spelling) == nil {
			t.Errorf("Resolve(%q) found nothing; identifiers are matched case-insensitively", spelling)
		}
	}
	if lib.Resolve("test:mixedcase2") != nil {
		t.Error("Resolve matched a name that is not the same name at all")
	}
}

func TestLibrary_IdentifiersDifferingOnlyInCaseCollide(t *testing.T) {
	// Two such files are ONE name to the engine, and its registry keeps what it already has --
	// so the second file is unreachable rather than an override. Silent in game; said out loud
	// here, because "my feature is never placed and the file is perfect" is otherwise unfindable.
	docA := `{
		"format_version": "1.21.110",
		"minecraft:single_block_feature": {
			"description": {"identifier": "test:rock"},
			"places_block": "minecraft:stone",
			"enforce_placement_rules": false,
			"enforce_survivability_rules": false
		}
	}`
	docB := strings.Replace(docA, "test:rock", "test:Rock", 1)
	lib := BuildLibrary([]SourceFile{{ID: "a.json", Text: docA}, {ID: "b.json", Text: docB}}, block.NewPalette(), nil)

	if _, ok := diagWith(lib.Diagnostics, "warning", "without regard to case"); !ok {
		t.Errorf("the collision was not reported:%s", diagLines(lib.Diagnostics))
	}
	// First loaded wins, as in the engine -- not last.
	if got := lib.Resolve("test:rock"); got == nil || got.Identifier() != "test:rock" {
		t.Errorf("Resolve returned %v; the FIRST file to claim the name must keep it", got)
	}
}
