// horizontal_tree_decoration_test.go exercises HorizontalTreeDecorationFeature's RNG draw sequence
// explicitly (method + bound + count, per random.Tracer, on both the success and every failure
// path), the face-to-position and face-to-cardinal_direction mappings for all four drawn faces,
// each schema default, the required-key/type errors, the ten-probe adjacency rule (including the
// name-identity stand-in for block-type equality), and every bark_side_only axis/face
// combination -- not just final block counts. There is no golden-dump differential coverage for
// this type (it is brand-new in 1.26.50.24), so these tests are the only thing
// standing between a wrong implementation and a caller relying on this type. See
// horizontal_tree_decoration.go's header for the algorithm this is checking against.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// htdTestOrigin is centered with room for the target cell and every adjacency probe.
var htdTestOrigin = wgen.BlockPos{X: 0, Y: 63, Z: 0}

func newHTDTestVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -5, MinY: 58, MinZ: -5, SizeX: 11, SizeY: 11, SizeZ: 11}
	return volume.New(bounds, pal, block.AirID), pal
}

func buildTestHTD(t *testing.T, pal *block.Palette, extra map[string]any) (wgen.IFeature, []string) {
	t.Helper()
	body := map[string]any{
		"places_block": "minecraft:pink_petals",
	}
	for k, v := range extra {
		body[k] = v
	}
	var buildWarnings []string
	ctx := &BuildContext{
		Palette:    pal,
		Identifier: "test:htd",
		FileID:     "test:htd",
		Warn:       func(msg string) { buildWarnings = append(buildWarnings, msg) },
	}
	f, err := buildHorizontalTreeDecorationFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildHorizontalTreeDecorationFeature: %v", err)
	}
	return f, buildWarnings
}

func placeTestHTD(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []string, []string) {
	var failures []string
	var warnings []string
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {
			failures = append(failures, message)
		},
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) {
			warnings = append(warnings, message)
		},
	}
	pos := f.Place(ctx)
	return pos, failures, warnings
}

// htdSeedForFace scans for a seed whose FIRST NextIntBound(4) draw yields the requested horizontal
// face (2=North, 3=South, 4=West, 5=East) -- so a test can pin which target cell place() attacks
// without touching the implementation.
func htdSeedForFace(t *testing.T, face int) uint32 {
	t.Helper()
	for seed := uint32(0); seed < 10000; seed++ {
		if 2+random.New(seed).NextIntBound(4) == face {
			return seed
		}
	}
	t.Fatalf("no seed under 10000 yields face %d", face)
	return 0
}

// htdFaceOffset is the test's OWN independent facing table (Down/Up/North/South/West/East =
// 0..5, the codebase-wide convention) so a transcription error in the implementation's table
// cannot cancel out here.
func htdFaceOffset(face int) wgen.BlockPos {
	switch face {
	case 2:
		return wgen.BlockPos{Z: -1}
	case 3:
		return wgen.BlockPos{Z: 1}
	case 4:
		return wgen.BlockPos{X: -1}
	case 5:
		return wgen.BlockPos{X: 1}
	}
	return wgen.BlockPos{}
}

// TestHorizontalTreeDecoration_SchemaErrors covers the one required key and the two optional
// bools' type checks -- places_block REQUIRED, allow_adjacent /
// bark_side_only bool-typed.
func TestHorizontalTreeDecoration_SchemaErrors(t *testing.T) {
	_, pal := newHTDTestVolume(t)
	ctx := &BuildContext{Palette: pal, Identifier: "test:htd", FileID: "test:htd", Warn: func(string) {}}

	if _, err := buildHorizontalTreeDecorationFeature(map[string]any{}, ctx); err == nil || !strings.Contains(err.Error(), "places_block") {
		t.Fatalf("missing places_block: err = %v, want places_block-is-required error", err)
	}
	if _, err := buildHorizontalTreeDecorationFeature(map[string]any{
		"places_block":   "minecraft:pink_petals",
		"allow_adjacent": "yes",
	}, ctx); err == nil || !strings.Contains(err.Error(), "allow_adjacent") {
		t.Fatalf("non-bool allow_adjacent: err = %v, want type error", err)
	}
	if _, err := buildHorizontalTreeDecorationFeature(map[string]any{
		"places_block":   "minecraft:pink_petals",
		"bark_side_only": float64(1),
	}, ctx); err == nil || !strings.Contains(err.Error(), "bark_side_only") {
		t.Fatalf("non-bool bark_side_only: err = %v, want type error", err)
	}
}

// TestHorizontalTreeDecoration_BuildStateGates pins the build-time evaluation of the two
// required-state gates (place() step 0 -- see the header): a vanilla block type that declares
// both is silent, one that does not is named, and a block nothing is known about still gets the
// old assumption disclosed.
func TestHorizontalTreeDecoration_BuildStateGates(t *testing.T) {
	_, pal := newHTDTestVolume(t)

	// minecraft:pink_petals declares both, so there is nothing to disclose.
	if _, warnings := buildTestHTD(t, pal, nil); len(warnings) != 0 {
		t.Fatalf("build warnings = %v, want none for a block type that carries both states", warnings)
	}

	// A pack's own block cannot be checked, so the assumption is disclosed.
	_, warnings := buildTestHTD(t, pal, map[string]any{"places_block": "pack:custom_pod"})
	if len(warnings) != 1 {
		t.Fatalf("build warnings = %v, want exactly one disclosure for a non-vanilla block", warnings)
	}
	if !strings.Contains(warnings[0], "minecraft:cardinal_direction") || !strings.Contains(warnings[0], "growth") {
		t.Fatalf("build warning %q does not name both required states", warnings[0])
	}
}

// TestHorizontalTreeDecoration_DrawSequence pins the exact RNG contract: success = NextIntBound(4)
// then NextIntBound(2) (the engine's random horizontal face draw, then its inclusive bounded
// draw over 0..1); any post-face failure = NextIntBound(4) alone.
func TestHorizontalTreeDecoration_DrawSequence(t *testing.T) {
	// Success: empty target, no neighbors, no bark check.
	v, pal := newHTDTestVolume(t)
	f, _ := buildTestHTD(t, pal, nil)
	tracer := random.NewTracer(random.New(7))
	pos, _, _ := placeTestHTD(f, v, htdTestOrigin, tracer)
	if pos == nil {
		t.Fatalf("Place() = nil on an all-air volume, want success")
	}
	want := []random.DrawRecord{
		{Method: random.MethodNextIntBound, Bound: 4},
		{Method: random.MethodNextIntBound, Bound: 2},
	}
	if len(tracer.Draws) != len(want) {
		t.Fatalf("success draw count = %d (%v), want %d", len(tracer.Draws), tracer.Draws, len(want))
	}
	for i, d := range tracer.Draws {
		if d.Method != want[i].Method || d.Bound != want[i].Bound {
			t.Fatalf("success draw %d = {method %d bound %d}, want {method %d bound %d}",
				i, d.Method, d.Bound, want[i].Method, want[i].Bound)
		}
	}

	// Failure after the face draw: every horizontal target cell blocked -> exactly one draw,
	// no growth draw.
	v2, pal2 := newHTDTestVolume(t)
	stone := pal2.Get("minecraft:stone", nil)
	for _, face := range []int{2, 3, 4, 5} {
		off := htdFaceOffset(face)
		v2.SetBlock(wgen.BlockPos{X: htdTestOrigin.X + off.X, Y: htdTestOrigin.Y, Z: htdTestOrigin.Z + off.Z}, stone)
	}
	f2, _ := buildTestHTD(t, pal2, nil)
	tracer2 := random.NewTracer(random.New(7))
	if pos, _, _ := placeTestHTD(f2, v2, htdTestOrigin, tracer2); pos != nil {
		t.Fatalf("Place() = %v with every target blocked, want nil", pos)
	}
	if len(tracer2.Draws) != 1 || tracer2.Draws[0].Method != random.MethodNextIntBound || tracer2.Draws[0].Bound != 4 {
		t.Fatalf("failure draws = %v, want exactly one NextIntBound(4)", tracer2.Draws)
	}
}

// TestHorizontalTreeDecoration_FaceMappingAndStates drives all four face draws and pins target
// position, block name, the cardinal_direction string (the facing-to-direction net
// identity: the state names the drawn face's compass direction) and the drawn growth value.
func TestHorizontalTreeDecoration_FaceMappingAndStates(t *testing.T) {
	wantCardinal := map[int]string{2: "north", 3: "south", 4: "west", 5: "east"}
	for face := 2; face <= 5; face++ {
		seed := htdSeedForFace(t, face)

		// Recompute the expected draws independently of the implementation.
		ref := random.New(seed)
		if got := 2 + ref.NextIntBound(4); got != face {
			t.Fatalf("seed scan broken: face = %d, want %d", got, face)
		}
		wantGrowth := float64(ref.NextIntBound(2))

		v, pal := newHTDTestVolume(t)
		f, _ := buildTestHTD(t, pal, nil)
		pos, _, _ := placeTestHTD(f, v, htdTestOrigin, random.New(seed))
		if pos == nil {
			t.Fatalf("face %d: Place() = nil, want success", face)
		}
		off := htdFaceOffset(face)
		wantPos := wgen.BlockPos{X: htdTestOrigin.X + off.X, Y: htdTestOrigin.Y, Z: htdTestOrigin.Z + off.Z}
		if *pos != wantPos {
			t.Fatalf("face %d: Place() = %v, want %v", face, *pos, wantPos)
		}
		entry := pal.Entry(v.GetBlock(wantPos))
		if entry.Name != "minecraft:pink_petals" {
			t.Fatalf("face %d: placed %q, want minecraft:pink_petals", face, entry.Name)
		}
		if got := entry.States["minecraft:cardinal_direction"]; got != wantCardinal[face] {
			t.Fatalf("face %d: cardinal_direction = %v, want %q", face, got, wantCardinal[face])
		}
		if got := entry.States["growth"]; got != block.StateValue(wantGrowth) {
			t.Fatalf("face %d: growth = %v, want %v", face, got, wantGrowth)
		}
	}
}

// TestHorizontalTreeDecoration_PreservesDescriptorStates: the drawn states are set ON TOP of the
// descriptor's own states (the engine's pair of state writes mutates the resolved permutation, not a
// fresh default block).
func TestHorizontalTreeDecoration_PreservesDescriptorStates(t *testing.T) {
	v, pal := newHTDTestVolume(t)
	f, _ := buildTestHTD(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "minecraft:pink_petals",
			"states": map[string]any{"custom": "kept"},
		},
	})
	pos, _, _ := placeTestHTD(f, v, htdTestOrigin, random.New(3))
	if pos == nil {
		t.Fatalf("Place() = nil, want success")
	}
	entry := pal.Entry(v.GetBlock(*pos))
	if entry.States["custom"] != "kept" {
		t.Fatalf("descriptor state lost: states = %v", entry.States)
	}
	if _, ok := entry.States["minecraft:cardinal_direction"]; !ok {
		t.Fatalf("cardinal_direction missing: states = %v", entry.States)
	}
}

// TestHorizontalTreeDecoration_TargetMustBeEmpty: the target cell must be air-material
// (the block's empty test) -- solid AND water targets both refuse, silently, leaving the
// volume untouched.
func TestHorizontalTreeDecoration_TargetMustBeEmpty(t *testing.T) {
	for _, blocker := range []string{"minecraft:stone", "minecraft:water"} {
		seed := htdSeedForFace(t, 5) // East
		v, pal := newHTDTestVolume(t)
		target := wgen.BlockPos{X: htdTestOrigin.X + 1, Y: htdTestOrigin.Y, Z: htdTestOrigin.Z}
		v.SetBlock(target, pal.Get(blocker, nil))
		f, _ := buildTestHTD(t, pal, nil)
		pos, failures, _ := placeTestHTD(f, v, htdTestOrigin, random.New(seed))
		if pos != nil {
			t.Fatalf("%s target: Place() = %v, want nil", blocker, pos)
		}
		// The game logs NOTHING on this path (see the header: the only content logs in place()
		// are the two step-0 state-gate strings) -- the port must fail silently too.
		if len(failures) != 0 {
			t.Fatalf("%s target: failures = %v, want silent refusal", blocker, failures)
		}
		if pal.NameOf(v.GetBlock(target)) != blocker {
			t.Fatalf("%s target was overwritten", blocker)
		}
	}
}

// TestHorizontalTreeDecoration_AdjacencyChecks covers the ten probes (origin N/E/S/W, target's six
// neighbors --), the allow_adjacent bypass, the "same name, different
// states still counts" identity rule, and that a decoration two steps away does NOT trip it.
func TestHorizontalTreeDecoration_AdjacencyChecks(t *testing.T) {
	seed := htdSeedForFace(t, 5) // East: target = origin + (1,0,0)
	target := wgen.BlockPos{X: htdTestOrigin.X + 1, Y: htdTestOrigin.Y, Z: htdTestOrigin.Z}

	type tc struct {
		name    string
		at      wgen.BlockPos
		states  map[string]block.StateValue
		allow   bool
		wantNil bool
	}
	cases := []tc{
		// One of origin's four horizontal probes (North of origin).
		{name: "origin north neighbor", at: wgen.BlockPos{X: 0, Y: 63, Z: -1}, wantNil: true},
		// One of target's six probes (above the target).
		{name: "above target", at: wgen.BlockPos{X: 1, Y: 64, Z: 0}, wantNil: true},
		// Target's own East neighbor (the last probe in the engine's order).
		{name: "east of target", at: wgen.BlockPos{X: 2, Y: 63, Z: 0}, wantNil: true},
		// Same NAME with different states still matches -- block-type identity is per-type, not
		// per-permutation (the game compares block types, not states).
		{name: "different states still count", at: wgen.BlockPos{X: 1, Y: 64, Z: 0},
			states: map[string]block.StateValue{"growth": float64(1)}, wantNil: true},
		// Probes are exactly one step -- two steps up from the target is NOT probed.
		{name: "two steps away is fine", at: wgen.BlockPos{X: 1, Y: 65, Z: 0}, wantNil: false},
		// Diagonal from both origin and target is NOT probed.
		{name: "diagonal is fine", at: wgen.BlockPos{X: -1, Y: 63, Z: -1}, wantNil: false},
		// allow_adjacent=true bypasses every probe.
		{name: "allow_adjacent bypass", at: wgen.BlockPos{X: 1, Y: 64, Z: 0}, allow: true, wantNil: false},
	}
	for _, c := range cases {
		v, pal := newHTDTestVolume(t)
		v.SetBlock(c.at, pal.Get("minecraft:pink_petals", c.states))
		extra := map[string]any{}
		if c.allow {
			extra["allow_adjacent"] = true
		}
		f, _ := buildTestHTD(t, pal, extra)
		pos, _, _ := placeTestHTD(f, v, htdTestOrigin, random.New(seed))
		if c.wantNil && pos != nil {
			t.Fatalf("%s: Place() = %v, want nil", c.name, pos)
		}
		if !c.wantNil {
			if pos == nil {
				t.Fatalf("%s: Place() = nil, want success", c.name)
			}
			if *pos != target {
				t.Fatalf("%s: Place() = %v, want %v", c.name, *pos, target)
			}
		}
	}
}

// TestHorizontalTreeDecoration_BarkSideOnly covers every axis/face combination of place() step 5
// : x-axis logs reject West/East, z-axis logs reject North/South, y-axis
// logs reject nothing, and a bark failure consumes NO growth draw.
func TestHorizontalTreeDecoration_BarkSideOnly(t *testing.T) {
	cases := []struct {
		axis    string
		face    int
		wantNil bool
	}{
		{"x", 4, true}, {"x", 5, true}, {"x", 2, false}, {"x", 3, false},
		{"z", 2, true}, {"z", 3, true}, {"z", 4, false}, {"z", 5, false},
		{"y", 2, false}, {"y", 3, false}, {"y", 4, false}, {"y", 5, false},
	}
	for _, c := range cases {
		seed := htdSeedForFace(t, c.face)
		v, pal := newHTDTestVolume(t)
		v.SetBlock(htdTestOrigin, pal.Get("minecraft:oak_log", map[string]block.StateValue{"pillar_axis": c.axis}))
		f, _ := buildTestHTD(t, pal, map[string]any{"bark_side_only": true})
		tracer := random.NewTracer(random.New(seed))
		pos, _, warnings := placeTestHTD(f, v, htdTestOrigin, tracer)
		if c.wantNil {
			if pos != nil {
				t.Fatalf("axis %s face %d: Place() = %v, want nil", c.axis, c.face, pos)
			}
			if len(tracer.Draws) != 1 {
				t.Fatalf("axis %s face %d: draws = %v, want exactly the face draw", c.axis, c.face, tracer.Draws)
			}
		} else {
			if pos == nil {
				t.Fatalf("axis %s face %d: Place() = nil, want success", c.axis, c.face)
			}
			if len(tracer.Draws) != 2 {
				t.Fatalf("axis %s face %d: draws = %v, want face + growth", c.axis, c.face, tracer.Draws)
			}
		}
		// The explicit-state cases must NOT emit the missing-pillar_axis approximation warning.
		if len(warnings) != 0 {
			t.Fatalf("axis %s face %d: warnings = %v, want none", c.axis, c.face, warnings)
		}
	}
}

// TestHorizontalTreeDecoration_BarkSideOnlyMissingAxisUsesTheTypesDefault: a trunk interned
// WITHOUT a pillar_axis state carries whatever its TYPE defaults to, and for an oak log that is
// "y" -- the axis that rejects no face. It comes from the block-type state catalogue, so no
// warning is emitted.
func TestHorizontalTreeDecoration_BarkSideOnlyMissingAxisUsesTheTypesDefault(t *testing.T) {
	seed := htdSeedForFace(t, 4) // West
	v, pal := newHTDTestVolume(t)
	v.SetBlock(htdTestOrigin, pal.Get("minecraft:oak_log", nil)) // no pillar_axis state written
	f, _ := buildTestHTD(t, pal, map[string]any{"bark_side_only": true})
	pos, _, warnings := placeTestHTD(f, v, htdTestOrigin, random.New(seed))
	if pos == nil {
		t.Fatalf("Place() = nil, want success (an oak log's type defaults to pillar_axis=y)")
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none -- the axis is known, not approximated", warnings)
	}
}

// TestHorizontalTreeDecoration_BarkSideOnlyFailsOnATypeWithNoAxis is step 5b's real branch,
// which this port could not reach before: a trunk whose TYPE declares no pillar_axis at all
// fails the whole placement, silently, after the one face draw.
func TestHorizontalTreeDecoration_BarkSideOnlyFailsOnATypeWithNoAxis(t *testing.T) {
	seed := htdSeedForFace(t, 4) // West
	v, pal := newHTDTestVolume(t)
	v.SetBlock(htdTestOrigin, pal.Get("minecraft:dirt", nil)) // no pillar_axis on the TYPE
	f, _ := buildTestHTD(t, pal, map[string]any{"bark_side_only": true})
	tracer := random.NewTracer(random.New(seed))
	pos, _, warnings := placeTestHTD(f, v, htdTestOrigin, tracer)
	if pos != nil {
		t.Fatalf("Place() = %+v, want nil -- dirt has no pillar_axis state to read", pos)
	}
	if len(tracer.Draws) != 1 {
		t.Fatalf("draws = %v, want exactly the face draw -- the failure is after step 2", tracer.Draws)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none -- the engine fails this path silently", warnings)
	}
}

// TestHorizontalTreeDecoration_BarkSideOnlyStillWarnsForANonVanillaTrunk: the approximation
// survives exactly where it must, on a block nothing is known about.
func TestHorizontalTreeDecoration_BarkSideOnlyStillWarnsForANonVanillaTrunk(t *testing.T) {
	seed := htdSeedForFace(t, 4) // West
	v, pal := newHTDTestVolume(t)
	v.SetBlock(htdTestOrigin, pal.Get("pack:custom_log", nil))
	f, _ := buildTestHTD(t, pal, map[string]any{"bark_side_only": true})
	pos, _, warnings := placeTestHTD(f, v, htdTestOrigin, random.New(seed))
	if pos == nil {
		t.Fatalf("Place() = nil, want success (absent axis on an unknown type is treated as y)")
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "pillar_axis") {
		t.Fatalf("warnings = %v, want exactly one pillar_axis disclosure", warnings)
	}
}

// TestHorizontalTreeDecoration_RefusesABlockTypeWithoutTheRequiredStates is step 0, which this
// port used to assume its way past. Only three vanilla block types declare both
// minecraft:cardinal_direction and growth; a places_block that is not one of them makes the
// engine content-log and place nothing, and it does so before any draw.
func TestHorizontalTreeDecoration_RefusesABlockTypeWithoutTheRequiredStates(t *testing.T) {
	v, pal := newHTDTestVolume(t)
	f, buildWarnings := buildTestHTD(t, pal, map[string]any{"places_block": "minecraft:cocoa"})
	if len(buildWarnings) != 1 || !strings.Contains(buildWarnings[0], "places nothing at all") {
		t.Fatalf("build warnings = %v, want one naming the missing states", buildWarnings)
	}
	tracer := random.NewTracer(random.New(3))
	pos, _, warnings := placeTestHTD(f, v, htdTestOrigin, tracer)
	if pos != nil {
		t.Fatalf("Place() = %+v, want nil -- a cocoa pod has neither required state", pos)
	}
	if len(tracer.Draws) != 0 {
		t.Fatalf("draws = %v, want none -- step 0 fails before the face draw", tracer.Draws)
	}
	if len(warnings) != 0 {
		t.Fatalf("place-time warnings = %v, want none -- the disclosure is at build time", warnings)
	}
}

// TestHorizontalTreeDecoration_DefaultsAreFalse verifies both defaults behaviorally
// (bark_side_only AND allow_adjacent both default false):
// omitted allow_adjacent means the adjacency probes RUN (an adjacent decoration refuses), and
// omitted bark_side_only means the pillar-axis gate does NOT run (an x-axis log origin with a
// West face still places).
func TestHorizontalTreeDecoration_DefaultsAreFalse(t *testing.T) {
	// allow_adjacent defaults false: adjacent same-type block refuses.
	seed := htdSeedForFace(t, 5)
	v, pal := newHTDTestVolume(t)
	v.SetBlock(wgen.BlockPos{X: 1, Y: 64, Z: 0}, pal.Get("minecraft:pink_petals", nil))
	f, _ := buildTestHTD(t, pal, nil) // neither bool present
	if pos, _, _ := placeTestHTD(f, v, htdTestOrigin, random.New(seed)); pos != nil {
		t.Fatalf("default allow_adjacent: Place() = %v, want nil (probes must run)", pos)
	}

	// bark_side_only defaults false: an end-grain-facing placement still succeeds.
	seed = htdSeedForFace(t, 4) // West, which bark_side_only would reject on an x-axis log
	v2, pal2 := newHTDTestVolume(t)
	v2.SetBlock(htdTestOrigin, pal2.Get("minecraft:oak_log", map[string]block.StateValue{"pillar_axis": "x"}))
	f2, _ := buildTestHTD(t, pal2, nil)
	if pos, _, _ := placeTestHTD(f2, v2, htdTestOrigin, random.New(seed)); pos == nil {
		t.Fatalf("default bark_side_only: Place() = nil, want success (axis gate must not run)")
	}
}

// TestHorizontalTreeDecoration_SetBlockFailureReturnsNil: the engine's single-block write
// only returns an engaged position when the underlying write succeeded -- an out-of-bounds target
// must yield nil.
func TestHorizontalTreeDecoration_SetBlockFailureReturnsNil(t *testing.T) {
	seed := htdSeedForFace(t, 5) // East
	v, pal := newHTDTestVolume(t)
	// Origin at the volume's +X edge: target (origin East) is out of bounds, SetBlock fails.
	edgeOrigin := wgen.BlockPos{X: 5, Y: 63, Z: 0}
	f, _ := buildTestHTD(t, pal, nil)
	if pos, _, _ := placeTestHTD(f, v, edgeOrigin, random.New(seed)); pos != nil {
		t.Fatalf("out-of-bounds target: Place() = %v, want nil", pos)
	}
	_ = v
}
