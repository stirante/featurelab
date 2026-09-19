// may_attach_to_shorthand_test.go is the regression coverage for the
// may_attach_to.<face> single-descriptor shorthand fix -- see
// AsBlockDescriptorOrList's doc comment in shared.go: the game's
// may_attach_to face fields accept a single descriptor -- string, {name, states?}, or {tags} -- as
// shorthand for a one-element list, and this shorthand is specific to
// may_attach_to/may_not_attach_to's per-face fields, not every
// "list of block descriptor" field.
//
// The bug: packs that load fine in game write
//
//	"may_attach_to": { "east": "example:branch_log", "top": "example:canopy_leaves" }
//
// which featurelab rejected with "may_attach_to.top must be an array"
// before this fix.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// buildAndResolveSingleBlock builds a one-file library from body (already
// wrapped as a full minecraft:single_block_feature JSON document) and
// returns the resolved feature plus the library's diagnostics.
func buildAndResolveSingleBlock(t *testing.T, identifier, jsonBody string) (wgen.IFeature, []Diagnostic) {
	t.Helper()
	palette := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: identifier + ".f.json", Text: jsonBody}}, palette, nil)
	return lib.Resolve(identifier), lib.Diagnostics
}

// singleBlockDoc wraps a may_attach_to fragment into a complete
// minecraft:single_block_feature document that places minecraft:torch onto
// minecraft:air only when the block above (top face) matches.
func singleBlockDoc(identifier, mayAttachToJSON string) string {
	return `{
        "format_version": "1.21.110",
        "minecraft:single_block_feature": {
            "description": {"identifier": "` + identifier + `"},
            "places_block": "minecraft:torch",
            "enforce_placement_rules": false,
            "enforce_survivability_rules": false,
            "may_attach_to": ` + mayAttachToJSON + `
        }
    }`
}

// diagnosticsBesidesRotationSpelling drops the one diagnostic every document
// in this file now produces and none of these tests is about: places_block is
// a bare minecraft:torch, whose block TYPE declares torch_facing_direction, so
// single_block_feature's rotation rewrites that state and warns that the
// direction it sets matches the game while the WORD written for it is
// inferred from vanilla block-state definitions. That warning is correct and
// is pinned by block/rotate_test.go; these tests are about may_attach_to's
// shorthand forms, and want to hear about nothing else.
//
// It also drops the unknown-block-name warning, for the same reason: the
// fixtures here name `example:branch_log` and `example:canopy_leaves`, which
// no blocks/ directory in these tests declares, so that warning is CORRECT
// (and is pinned by blocknames_test.go) and is not what any test in this file
// is asking about.
func diagnosticsBesidesRotationSpelling(diagnostics []Diagnostic) []Diagnostic {
	var out []Diagnostic
	for _, d := range diagnostics {
		if strings.Contains(d.Message, "(auto_rotate/randomize_rotation)") {
			continue
		}
		if strings.Contains(d.Message, "is not a block this engine knows") {
			continue
		}
		out = append(out, d)
	}
	return out
}

// placeWithTopNeighbor builds a 1x2x1 volume (origin at Y=0, its "top"
// neighbor at Y=1), sets the neighbor to neighborID, places feature at the
// origin (which starts as air), and reports whether placement succeeded.
func placeWithTopNeighbor(t *testing.T, feature wgen.IFeature, palette *block.Palette, neighborID block.ID) (placed bool) {
	t.Helper()
	v := volume.New(volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 1, SizeY: 2, SizeZ: 1}, palette, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	v.SetBlock(wgen.BlockPos{X: 0, Y: 1, Z: 0}, neighborID)

	ctx := &wgen.PlacementContext{
		API: v, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope(),
	}
	result := feature.Place(ctx)
	return result != nil
}

// TestMayAttachTo_SingleStringShorthand proves the exact shape from the
// bug report -- a bare block-id string for one face -- builds AND places
// correctly (attaches only when the top neighbor is the named block).
func TestMayAttachTo_SingleStringShorthand(t *testing.T) {
	body := singleBlockDoc("test:attach_single_string", `{"top": "minecraft:dirt"}`)
	palette := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: body}}, palette, nil)
	if other := diagnosticsBesidesRotationSpelling(lib.Diagnostics); len(other) != 0 {
		t.Fatalf("build diagnostics = %+v, want none besides the rotation-spelling one", other)
	}
	feature := lib.Resolve("test:attach_single_string")
	if feature == nil {
		t.Fatal("feature did not resolve")
	}

	dirtID := palette.Get("minecraft:dirt", nil)
	if !placeWithTopNeighbor(t, feature, palette, dirtID) {
		t.Error("top neighbor = minecraft:dirt: want placement to succeed (matches the shorthand descriptor)")
	}
	stoneID := palette.Get("minecraft:stone", nil)
	if placeWithTopNeighbor(t, feature, palette, stoneID) {
		t.Error("top neighbor = minecraft:stone: want placement to fail (does not match)")
	}
}

// TestMayAttachTo_SingleObjectShorthand proves a single {name, states}
// object -- not wrapped in an array -- is also accepted as shorthand.
func TestMayAttachTo_SingleObjectShorthand(t *testing.T) {
	body := singleBlockDoc("test:attach_single_object", `{"top": {"name": "minecraft:dirt"}}`)
	palette := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: body}}, palette, nil)
	if other := diagnosticsBesidesRotationSpelling(lib.Diagnostics); len(other) != 0 {
		t.Fatalf("build diagnostics = %+v, want none besides the rotation-spelling one", other)
	}
	feature := lib.Resolve("test:attach_single_object")
	if feature == nil {
		t.Fatal("feature did not resolve")
	}

	dirtID := palette.Get("minecraft:dirt", nil)
	if !placeWithTopNeighbor(t, feature, palette, dirtID) {
		t.Error("top neighbor = minecraft:dirt: want placement to succeed")
	}
	stoneID := palette.Get("minecraft:stone", nil)
	if placeWithTopNeighbor(t, feature, palette, stoneID) {
		t.Error("top neighbor = minecraft:stone: want placement to fail")
	}
}

// TestMayAttachTo_SingleTagsShorthand proves a single {"tags": ...}
// descriptor -- not wrapped in an array -- is accepted as shorthand and
// actually resolves through the tag machinery.
func TestMayAttachTo_SingleTagsShorthand(t *testing.T) {
	body := singleBlockDoc("test:attach_single_tags", `{"top": {"tags": "q.any_tag('dirt')"}}`)
	palette := block.NewPalette()
	if diags := palette.LoadBlockTags([]block.SourceFile{
		{ID: "dirt.b.json", Text: `{
            "minecraft:block": {
                "description": {"identifier": "minecraft:dirt"},
                "components": {"tag:dirt": {}}
            }
        }`},
	}); len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: body}}, palette, nil)
	if other := diagnosticsBesidesRotationSpelling(lib.Diagnostics); len(other) != 0 {
		t.Fatalf("build diagnostics = %+v, want none besides the rotation-spelling one", other)
	}
	feature := lib.Resolve("test:attach_single_tags")
	if feature == nil {
		t.Fatal("feature did not resolve")
	}

	dirtID := palette.Get("minecraft:dirt", nil)
	if !placeWithTopNeighbor(t, feature, palette, dirtID) {
		t.Error("top neighbor tagged 'dirt': want placement to succeed")
	}
	stoneID := palette.Get("minecraft:stone", nil)
	if placeWithTopNeighbor(t, feature, palette, stoneID) {
		t.Error("top neighbor untagged: want placement to fail")
	}
}

// TestMayAttachTo_ProperArrayStillWorks is the non-regression check: the
// pre-existing, always-valid array form must keep working exactly as
// before.
func TestMayAttachTo_ProperArrayStillWorks(t *testing.T) {
	body := singleBlockDoc("test:attach_array", `{"top": ["minecraft:dirt", "minecraft:grass"]}`)
	palette := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: body}}, palette, nil)
	if other := diagnosticsBesidesRotationSpelling(lib.Diagnostics); len(other) != 0 {
		t.Fatalf("build diagnostics = %+v, want none besides the rotation-spelling one", other)
	}
	feature := lib.Resolve("test:attach_array")
	if feature == nil {
		t.Fatal("feature did not resolve")
	}

	dirtID := palette.Get("minecraft:dirt", nil)
	if !placeWithTopNeighbor(t, feature, palette, dirtID) {
		t.Error("top neighbor = minecraft:dirt (in array): want placement to succeed")
	}
	grassID := palette.Get("minecraft:grass", nil)
	if !placeWithTopNeighbor(t, feature, palette, grassID) {
		t.Error("top neighbor = minecraft:grass (in array): want placement to succeed")
	}
	stoneID := palette.Get("minecraft:stone", nil)
	if placeWithTopNeighbor(t, feature, palette, stoneID) {
		t.Error("top neighbor = minecraft:stone (not in array): want placement to fail")
	}
}

// shorthandFaceValuesJSON is a synthetic single_block_feature document with
// every detail that made this shape fail with "may_attach_to.top must be
// an array" before the fix: BARE DESCRIPTOR STRINGS (not arrays) as the
// face values, exactly two faces configured -- one of them "top", which the
// game treats as a hard per-face gate, and one a counted side -- a
// may_replace written as a one-element array, both enforcement flags off,
// and a places_block whose TYPE declares "direction", so auto_rotate is in
// play. Rewriting either face as an array, or configuring only one of them,
// would delete the case.
const shorthandFaceValuesJSON = `{
    "format_version": "1.21.110",
    "minecraft:single_block_feature": {
        "description": {
            "identifier": "example:shorthand_face_values"
        },
        "places_block": "minecraft:bee_nest",
        "enforce_placement_rules": false,
        "enforce_survivability_rules": false,
        "may_replace": [
            "minecraft:air"
        ],
        "may_attach_to": {
            "east": "example:branch_log",
            "top": "example:canopy_leaves"
        }
    }
}`

// TestShorthandFaceValues_EastAndTop_BuildsAndPlaces is the end-to-end
// regression test for the shorthand-parse fix (a bare descriptor string as
// a face value must build), also asserting the game's attach semantics
// (see single_block.go's header): "top" is a HARD per-face gate, "east" is a
// counted side, and min_sides_must_attach defaults to 4 (NOT 1 as an earlier
// revision of this test assumed) -- so with "east" configured, the east side
// must match AND the three unconfigured sides count for free (3+1 = 4). Net
// effect for this file: the bee nest places ONLY when the top neighbor is
// canopy_leaves AND the east neighbor is branch_log; either face alone is
// not enough.
func TestShorthandFaceValues_EastAndTop_BuildsAndPlaces(t *testing.T) {
	palette := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: "shorthand_face_values.json", Text: shorthandFaceValuesJSON}}, palette, nil)
	if other := diagnosticsBesidesRotationSpelling(lib.Diagnostics); len(other) != 0 {
		t.Fatalf("build diagnostics = %+v, want none besides the rotation-spelling one", other)
	}
	feature := lib.Resolve("example:shorthand_face_values")
	if feature == nil {
		t.Fatal("example:shorthand_face_values did not resolve")
	}

	logID := palette.Get("example:branch_log", nil)
	leavesID := palette.Get("example:canopy_leaves", nil)
	stoneID := palette.Get("minecraft:stone", nil)
	// A bee nest is rotated on the way down: its block TYPE declares
	// "direction", auto_rotate defaults to true, and the last matching side
	// wins -- west here, since only "east" and "top" are configured and an
	// unconfigured side matches for free. direction=1 is west.
	beeNestID := palette.Get("minecraft:bee_nest", map[string]block.StateValue{"direction": float64(1)})

	newVolume := func() *volume.Volume {
		return volume.New(volume.Bounds{MinX: -1, MinY: -1, MinZ: -1, SizeX: 3, SizeY: 3, SizeZ: 3}, palette, block.AirID)
	}
	origin := wgen.BlockPos{X: 0, Y: 0, Z: 0}

	// East neighbor alone (top is air, and "top" is configured as a hard
	// gate) -> must refuse.
	vEast := newVolume()
	vEast.SetBlock(wgen.BlockPos{X: 1, Y: 0, Z: 0}, logID)
	if feature.Place(&wgen.PlacementContext{API: vEast, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope()}) != nil {
		t.Error("east neighbor alone: want placement to fail (the configured top face is a hard gate and does not match)")
	}

	// Top neighbor alone (east is air; matched sides = 3 free + 0 < 4) ->
	// must refuse.
	vTop := newVolume()
	vTop.SetBlock(wgen.BlockPos{X: 0, Y: 1, Z: 0}, leavesID)
	if feature.Place(&wgen.PlacementContext{API: vTop, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope()}) != nil {
		t.Error("top neighbor alone: want placement to fail (the configured east side does not match, 3 < min_sides 4)")
	}

	// Both faces match -> must attach and place.
	vBoth := newVolume()
	vBoth.SetBlock(wgen.BlockPos{X: 1, Y: 0, Z: 0}, logID)
	vBoth.SetBlock(wgen.BlockPos{X: 0, Y: 1, Z: 0}, leavesID)
	if feature.Place(&wgen.PlacementContext{API: vBoth, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope()}) == nil {
		t.Fatal("both faces match: want placement to succeed")
	}
	if got := vBoth.GetBlock(origin); got != beeNestID {
		t.Errorf("both faces match: block at origin = %q, want %q",
			palette.Entry(got).CanonicalString(), palette.Entry(beeNestID).CanonicalString())
	}

	// Neither face matches -> must refuse.
	vNone := newVolume()
	vNone.SetBlock(wgen.BlockPos{X: 1, Y: 0, Z: 0}, stoneID)
	vNone.SetBlock(wgen.BlockPos{X: 0, Y: 1, Z: 0}, stoneID)
	if feature.Place(&wgen.PlacementContext{API: vNone, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope()}) != nil {
		t.Error("neither face matches: want placement to fail")
	}
}

// TestMayAttachTo_MalformedValuesStillError proves loosening the shape to
// accept a bare descriptor did NOT turn genuine authoring mistakes into
// silence: a number, a nested array, and an object with neither name nor
// tags must all still fail the build with a clear, field-naming error.
func TestMayAttachTo_MalformedValuesStillError(t *testing.T) {
	cases := []struct {
		name         string
		mayAttachTo  string
		wantErrorHas []string
	}{
		{
			name:         "number",
			mayAttachTo:  `{"top": 5}`,
			wantErrorHas: []string{"may_attach_to.top"},
		},
		{
			name:         "nested array",
			mayAttachTo:  `{"top": [["minecraft:dirt"]]}`,
			wantErrorHas: []string{"may_attach_to.top"},
		},
		{
			name:         "object with neither name nor tags",
			mayAttachTo:  `{"top": {"foo": "bar"}}`,
			wantErrorHas: []string{"may_attach_to.top"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			identifier := "test:attach_malformed_" + strings.ReplaceAll(tc.name, " ", "_")
			body := singleBlockDoc(identifier, tc.mayAttachTo)
			_, diags := buildAndResolveSingleBlock(t, identifier, body)
			if len(diags) == 0 {
				t.Fatalf("want a build error for %s, got none", tc.mayAttachTo)
			}
			found := false
			for _, d := range diags {
				if d.Level != "error" {
					continue
				}
				ok := true
				for _, want := range tc.wantErrorHas {
					if !strings.Contains(d.Message, want) {
						ok = false
					}
				}
				if ok {
					found = true
				}
			}
			if !found {
				t.Errorf("want an error diagnostic containing %v, got %+v", tc.wantErrorHas, diags)
			}
		})
	}
}
