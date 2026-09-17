// structure_template_test.go pins the parse-level facts for
// minecraft:structure_template_feature -- the facing_direction enum's exact
// values and its absent-key default, and the schema fields this port either
// requires or cannot enforce (so a pack author is told rather than silently
// misled) -- plus four vanilla behaviours that are easy to get wrong: the
// point-set predicate skipping explicit air as well as void,
// block_intersection's cell PARTITION and its default-true switch,
// block_allowlist being schema-required, and the schema ranges on
// adjustment_radius and ground_level. See structure_template.go's header for
// the details.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/nbt"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

func TestStructureTemplate_FacingDirectionEnumValues(t *testing.T) {
	// The game's enum values:
	// south=0, west=1, north=2, east=3, random=255. The mapping is NOT
	// alphabetical and NOT compass-clockwise-from-north, so it is worth
	// pinning: an off-by-one here silently rotates every structure.
	want := map[any]int{
		"south":  0,
		"west":   1,
		"north":  2,
		"east":   3,
		"random": 255,
		nil:      0, // absent key -> default 0 -> south
	}
	for value, expect := range want {
		got, err := parseFacingDirection(value)
		if err != nil {
			t.Fatalf("parseFacingDirection(%#v): %v", value, err)
		}
		if got != expect {
			t.Errorf("parseFacingDirection(%#v) = %d, want %d", value, got, expect)
		}
	}
	if _, err := parseFacingDirection("up"); err == nil {
		t.Error("parseFacingDirection(\"up\") should fail -- the enum has exactly five values")
	}
}

// constraintWarnings runs parseConstraints over one `constraints` value and
// returns the warnings it emitted.
func constraintWarnings(t *testing.T, raw any) []string {
	t.Helper()
	var warnings []string
	ctx := &BuildContext{
		Palette: block.NewPalette(), Resolver: condResolver{},
		Identifier: "test:structure", FileID: "test:structure",
		Warn: func(w string) { warnings = append(warnings, w) },
	}
	if _, err := parseConstraints(raw, ctx); err != nil {
		t.Fatalf("parseConstraints(%#v): %v", raw, err)
	}
	return warnings
}

// constraintError is constraintWarnings' counterpart for the shapes this port REFUSES: it returns
// the error parseConstraints produced, or nil. Two helpers rather than one because every caller
// knows which of the two it expects, and a caller that gets the other one should fail loudly at
// the call site rather than silently read an empty slice.
func constraintError(t *testing.T, raw any) error {
	t.Helper()
	ctx := &BuildContext{
		Palette: block.NewPalette(), Resolver: condResolver{},
		Identifier: "test:structure", FileID: "test:structure",
		Warn: func(string) {},
	}
	_, err := parseConstraints(raw, ctx)
	return err
}

func TestStructureTemplate_MissingConstraintsWarns(t *testing.T) {
	// `constraints` is schema-required; a file without it would not load in
	// the engine, so say so instead of quietly accepting it.
	got := constraintWarnings(t, nil)
	if len(got) != 1 || !strings.Contains(got[0], "required by the engine's schema") {
		t.Fatalf("absent constraints produced %v, want one schema-requirement warning", got)
	}
	// An empty object is legal and must NOT warn.
	if got := constraintWarnings(t, map[string]any{}); len(got) != 0 {
		t.Errorf("an empty constraints object must not warn, got %v", got)
	}
}

func TestStructureTemplate_LeveledIsEnforcedAndDoesNotWarn(t *testing.T) {
	// It used to be parsed, warned about as inert, and ignored. Now it is a real check, so the
	// warning has to be gone -- a stale "this does nothing" line is worse than none.
	if got := constraintWarnings(t, map[string]any{
		"leveled": map[string]any{"max_steepness": float64(2)},
	}); len(got) != 0 {
		t.Errorf("an enforced constraint must not warn, got %v", got)
	}
	// A negative window can never be satisfied, which is a pack bug the engine does not repair
	// either -- so it warns rather than being clamped.
	got := constraintWarnings(t, map[string]any{
		"leveled": map[string]any{"max_steepness": float64(-1)},
	})
	if len(got) != 1 || !strings.Contains(got[0], "negative") {
		t.Errorf("a negative max_steepness produced %v, want one warning about it", got)
	}
}

func TestStructureTemplate_MotionBlockingOptionIsEnforcedAndDoesNotWarn(t *testing.T) {
	// This key used to be parsed and then warned about as unimplemented. It is a real switch now,
	// so the warning has to be gone -- and it was wrong about which way the field defaults, which
	// is what makes a stale diagnostic here actively harmful rather than merely untidy.
	for _, v := range []any{true, false} {
		got := constraintWarnings(t, map[string]any{
			"block_intersection": map[string]any{
				"block_allowlist": []any{"minecraft:air"},
				"only_check_intersection_for_motion_blocking_blocks": v,
			},
		})
		if len(got) != 0 {
			t.Errorf("only_check_intersection_for_motion_blocking_blocks=%v warned: %v", v, got)
		}
	}
	// The schema node is a boolean, so a non-boolean does not validate there and does not load.
	err := constraintError(t, map[string]any{
		"block_intersection": map[string]any{
			"block_allowlist": []any{"minecraft:air"},
			"only_check_intersection_for_motion_blocking_blocks": "yes",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "true or false") {
		t.Errorf("a non-boolean must be refused, got %v", err)
	}
}

// TestStructureTemplate_BlockIntersectionAllowlistIsRequired pins the side this port now picks,
// and why picking it costs nothing. block_allowlist|block_whitelist is a REQUIRED child of
// block_intersection's schema, so a file omitting it does not load in the game at all -- there is
// no permissive engine behaviour to imitate. The old code registered no constraint and warned,
// which made "write nothing" the most permissive spelling available while `block_allowlist: []`,
// the same sentence in English, refused every candidate.
func TestStructureTemplate_BlockIntersectionAllowlistIsRequired(t *testing.T) {
	err := constraintError(t, map[string]any{"block_intersection": map[string]any{}})
	if err == nil {
		t.Fatal("block_intersection with no allow list must be refused")
	}
	// The diagnostic has to say what the GAME does, not just what this tool does -- an author who
	// only learns that featurelab refused it will go looking for a featurelab problem.
	for _, want := range []string{"block_allowlist", "required", "refuses to load"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error must mention %q; got: %v", want, err)
		}
	}
	// `block_whitelist` is the same key under its older name and must satisfy the requirement.
	if err := constraintError(t, map[string]any{"block_intersection": map[string]any{
		"block_whitelist": []any{"minecraft:stone"},
	}}); err != nil {
		t.Errorf("block_whitelist is the same key and must be accepted: %v", err)
	}
	// An EMPTY list is a different thing from an absent one: it is a legal file that happens to
	// allow nothing, so it parses and then refuses every candidate. Refusing it at parse time
	// would be this tool inventing a rule.
	if err := constraintError(t, map[string]any{"block_intersection": map[string]any{
		"block_allowlist": []any{},
	}}); err != nil {
		t.Errorf("an empty allow list is a legal file: %v", err)
	}
}

func TestStructureTemplate_EnforcedConstraintsDoNotWarn(t *testing.T) {
	// The three constraints this port does enforce must stay quiet -- warnings
	// are reserved for fields it cannot honour.
	got := constraintWarnings(t, map[string]any{
		"grounded": map[string]any{},
		"unburied": map[string]any{},
		"block_intersection": map[string]any{
			"block_allowlist": []any{"minecraft:air"},
		},
	})
	if len(got) != 0 {
		t.Errorf("enforced constraints must not warn, got %v", got)
	}
}

// ---------------------------------------------------------------------------
// Constraint POINT SETS (each constraint precomputes a list of block positions
// from the structure's palette; its test only iterates it). A regression digest
// cannot see any of this: in an open-air bench everything above the terrain is
// air and everything below is solid, so both a naive approximation and the
// game's real point set reach the same verdict. The
// difference shows up only when something non-air sits above part of the
// footprint, or when ground_level is nonzero.
// ---------------------------------------------------------------------------

// synthStructure builds a ResolvedStructure of the given size whose occupied
// cells are exactly those `occupied` reports true for.
func synthStructure(t *testing.T, pal *block.Palette, sx, sy, sz int, occupied func(x, y, z int) bool) *structures.ResolvedStructure {
	t.Helper()
	stone := pal.Get("minecraft:stone", nil)
	layer := make([]int32, sx*sy*sz)
	for x := 0; x < sx; x++ {
		for y := 0; y < sy; y++ {
			for z := 0; z < sz; z++ {
				idx := x*(sy*sz) + y*sz + z
				if occupied(x, y, z) {
					layer[idx] = 0
				} else {
					layer[idx] = -1 // void
				}
			}
		}
	}
	return &structures.ResolvedStructure{
		Size:       nbt.Vec3Int{X: sx, Y: sy, Z: sz},
		PaletteIDs: []block.ID{stone},
		Layer0:     layer,
	}
}

func constraintCtx(v *volume.Volume) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		API: v, Random: random.New(1), MolangScope: wgen.NewScope(),
		Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {},
	}
}

func TestStructureTemplate_GroundedSamplesTheGroundLevelRowAndTestsOneBelow(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	// 2x3x1 structure, occupied only on its MIDDLE row (y=1). With
	// ground_level 1 the sampled row is y=1, so both columns are in the point
	// set; with ground_level 0 the sampled row is empty and nothing is checked.
	st := synthStructure(t, pal, 2, 3, 1, func(x, y, z int) bool { return y == 1 })
	geo := &structureGeometry{structure: st}
	v := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}

	// ground_level 1 -> preOffset.Y = -1 -> the tested row is 63 - 1 - 1 = 61.
	preOffset := wgen.BlockPos{Y: -1}
	g := groundedConstraint()
	if g(constraintCtx(v), candidate, 0, preOffset, geo) {
		t.Error("with nothing solid at y=61 the grounded constraint must fail")
	}
	v.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, stone)
	v.SetBlock(wgen.BlockPos{X: 1, Y: 61, Z: 0}, stone)
	if !g(constraintCtx(v), candidate, 0, preOffset, geo) {
		t.Error("with both columns solid at y=61 (candidate.Y + preOffset.Y - 1) it must pass")
	}

	// ground_level 0 -> the sampled row (y=0) is empty, so the point set is
	// empty and the constraint passes vacuously even over thin air.
	empty := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	if !g(constraintCtx(empty), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("an empty point set must pass vacuously")
	}
}

func TestStructureTemplate_UnburiedChecksTheFixedTopRowOnly(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	// 2x3x1 structure: column x=0 is full height (so its top-row cell is
	// occupied), column x=1 only reaches y=0 (its top-row cell is void).
	st := synthStructure(t, pal, 2, 3, 1, func(x, y, z int) bool { return x == 0 || y == 0 })
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	u := unburiedConstraint()

	// The checked row is candidate.Y + preOffset.Y + size.Y = 63 + 0 + 3 = 66,
	// and only column x=0 is in the point set.
	v := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	if !u(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Fatal("all air above: must pass")
	}
	// Blocking the SKIPPED column (x=1) must not matter -- the engine never
	// looks there, because that column's top-row cell is void.
	v.SetBlock(wgen.BlockPos{X: 1, Y: 66, Z: 0}, stone)
	if !u(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a column whose TOP-ROW cell is void is not in the point set and must be ignored")
	}
	// Blocking the checked column must fail it.
	v.SetBlock(wgen.BlockPos{X: 0, Y: 66, Z: 0}, stone)
	if u(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a non-air block one row above the structure's top must fail the constraint")
	}
}

func TestStructureTemplate_UnburiedIgnoresLowerObstructions(t *testing.T) {
	// The old per-column "topmost occupied cell" reading tested different
	// heights per column; the engine tests one fixed row. A block at the height
	// the old reading would have checked, but not at the fixed row, must NOT
	// fail the constraint.
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	st := synthStructure(t, pal, 1, 3, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	v := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	// y=65 is inside the structure's own span (63..65), not the row above it.
	v.SetBlock(wgen.BlockPos{X: 0, Y: 65, Z: 0}, stone)
	if !unburiedConstraint()(constraintCtx(v), wgen.BlockPos{X: 0, Y: 63, Z: 0}, 0, wgen.BlockPos{}, geo) {
		t.Error("only the single row above the structure is checked; a block inside its own span is irrelevant")
	}
}

// ---------------------------------------------------------------------------
// leveled
// ---------------------------------------------------------------------------

// leveledWorld builds a volume whose column (x, z) is solid up to and including groundTop(x, z),
// and air above -- i.e. a terrain with a per-column surface height.
func leveledWorld(t *testing.T, pal *block.Palette, groundTop func(x, z int) int) *volume.Volume {
	t.Helper()
	stone := pal.Get("minecraft:stone", nil)
	v := volume.New(volume.Bounds{MinX: -8, MinY: 40, MinZ: -8, SizeX: 24, SizeY: 40, SizeZ: 24}, pal, block.AirID)
	for x := -8; x < 16; x++ {
		for z := -8; z < 16; z++ {
			for y := 40; y <= groundTop(x, z); y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	return v
}

func TestStructureTemplate_LeveledAcceptsGroundWithinTheWindow(t *testing.T) {
	pal := block.NewPalette()
	// A 3x1x1 structure occupied on its ground row, so all three columns are in the point set.
	st := synthStructure(t, pal, 3, 1, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	c := leveledConstraint(2)

	// Flat ground whose surface is exactly where the structure expects it: the tested row is
	// candidate.Y - 1 = 62, and the solid-to-air transition sits between 62 and 63.
	flat := leveledWorld(t, pal, func(x, z int) int { return 62 })
	if !c(constraintCtx(flat), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("flat ground at the expected level must satisfy leveled")
	}

	// One column's surface two blocks lower -- still inside a max_steepness of 2.
	stepped := leveledWorld(t, pal, func(x, z int) int {
		if x == 2 {
			return 60
		}
		return 62
	})
	if !c(constraintCtx(stepped), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a two-block step must satisfy leveled at max_steepness 2")
	}
}

func TestStructureTemplate_LeveledRefusesGroundOutsideTheWindow(t *testing.T) {
	pal := block.NewPalette()
	st := synthStructure(t, pal, 3, 1, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}

	// A cliff: one column's surface is far below the window, so that column has no solid-to-air
	// transition anywhere in the rows scanned, and the WHOLE placement is refused.
	cliff := leveledWorld(t, pal, func(x, z int) int {
		if x == 2 {
			return 50
		}
		return 62
	})
	if leveledConstraint(2)(constraintCtx(cliff), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a column whose surface is outside the window must refuse the placement")
	}
	// Widening the window far enough reaches it again -- the same world, the same structure.
	if !leveledConstraint(13)(constraintCtx(cliff), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a window wide enough to contain the drop must accept it")
	}
}

func TestStructureTemplate_LeveledRefusesSolidAllTheWayUp(t *testing.T) {
	// Buried: every scanned row is solid, so there is no solid-to-air transition to find. This is
	// the case that distinguishes leveled from grounded -- grounded only asks whether the row
	// below is solid, and would pass here.
	pal := block.NewPalette()
	st := synthStructure(t, pal, 2, 1, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	buried := leveledWorld(t, pal, func(x, z int) int { return 75 })

	if leveledConstraint(2)(constraintCtx(buried), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a fully buried footprint has no surface in the window and must be refused")
	}
	if !groundedConstraint()(constraintCtx(buried), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("grounded, by contrast, only asks whether the row below is solid -- it must pass")
	}
}

func TestStructureTemplate_LeveledPassesVacuouslyWithAnEmptyPointSet(t *testing.T) {
	// Same rule as every other constraint: an empty precomputed point vector satisfies
	// unconditionally, without touching the world.
	pal := block.NewPalette()
	st := synthStructure(t, pal, 2, 2, 1, func(x, y, z int) bool { return y == 1 })
	geo := &structureGeometry{structure: st}
	air := volume.New(volume.Bounds{MinX: -8, MinY: 40, MinZ: -8, SizeX: 24, SizeY: 40, SizeZ: 24}, pal, block.AirID)
	if !leveledConstraint(2)(constraintCtx(air), wgen.BlockPos{X: 0, Y: 63, Z: 0}, 0, wgen.BlockPos{}, geo) {
		t.Error("an empty point set must pass vacuously")
	}
}

func TestStructureTemplate_LeveledNegativeSteepnessNeverPlaces(t *testing.T) {
	// The engine's loop guard (`k > maxSteepness`) is true on entry for a negative window, so
	// every point fails before a single block is read. Transcribed rather than clamped.
	pal := block.NewPalette()
	st := synthStructure(t, pal, 1, 1, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	flat := leveledWorld(t, pal, func(x, z int) int { return 62 })
	if leveledConstraint(-1)(constraintCtx(flat), wgen.BlockPos{X: 0, Y: 63, Z: 0}, 0, wgen.BlockPos{}, geo) {
		t.Error("a negative max_steepness must refuse even perfectly flat ground")
	}
}

func TestStructureTemplate_LeveledWindowReachesOneRowAboveTheOrigin(t *testing.T) {
	// The scan probes the consecutive rows from y-maxSteepness to y+1+maxSteepness, so with the
	// tested row at 62 and a window of 2 it accepts a surface whose top is 60..64. Losing the
	// "+1" row -- the easiest slip in transcribing it -- narrows that to 60..63 and is invisible
	// unless a case sits exactly on the top edge. These two do.
	pal := block.NewPalette()
	st := synthStructure(t, pal, 2, 1, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0} // tested row 62, window 60..65
	c := leveledConstraint(2)

	// Top edge: ground two rows ABOVE the tested row, i.e. the structure would sit slightly
	// buried. The transition is between 64 and 65, the last pair the window covers.
	high := leveledWorld(t, pal, func(x, z int) int { return 64 })
	if !c(constraintCtx(high), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a surface at the top of the window was refused -- the window is one row short")
	}
	// One higher, and the transition is outside the window: refused.
	tooHigh := leveledWorld(t, pal, func(x, z int) int { return 65 })
	if c(constraintCtx(tooHigh), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a surface one row past the top of the window was accepted -- the window is too wide")
	}
	// And the bottom edge, for the same reason from the other side.
	low := leveledWorld(t, pal, func(x, z int) int { return 60 })
	if !c(constraintCtx(low), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a surface at the bottom of the window was refused")
	}
	if c(constraintCtx(leveledWorld(t, pal, func(x, z int) int { return 59 })), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("a surface one row below the window was accepted")
	}
}

func TestStructureTemplate_LeveledNegativeSteepnessSurvivesParsing(t *testing.T) {
	// The port's stated policy is that a negative max_steepness is transcribed rather than
	// clamped, because the engine's own loop guard makes it refuse everything and the game does
	// not repair it either. Asserting only that a warning appears would let someone "fix" the
	// value behind the warning -- the parse would then complain and place anyway, which is the
	// worst of both. This goes through parseConstraints and runs what it produced.
	pal := block.NewPalette()
	var warnings []string
	ctx := &BuildContext{
		Palette: pal, Resolver: condResolver{},
		Identifier: "test:structure", FileID: "test:structure",
		Warn: func(w string) { warnings = append(warnings, w) },
	}
	checks, err := parseConstraints(map[string]any{
		"leveled": map[string]any{"max_steepness": float64(-1)},
	}, ctx)
	if err != nil {
		t.Fatalf("parseConstraints: %v", err)
	}
	if len(checks) != 1 {
		t.Fatalf("parseConstraints produced %d constraints, want 1", len(checks))
	}
	if len(warnings) != 1 {
		t.Errorf("warnings = %v, want one about the negative value", warnings)
	}

	st := synthStructure(t, pal, 1, 1, 1, func(x, y, z int) bool { return true })
	geo := &structureGeometry{structure: st}
	flat := leveledWorld(t, pal, func(x, z int) int { return 62 })
	if checks[0](constraintCtx(flat), wgen.BlockPos{X: 0, Y: 63, Z: 0}, 0, wgen.BlockPos{}, geo) {
		t.Error("the parsed constraint accepted perfectly flat ground -- a negative window was " +
			"clamped somewhere instead of being passed through, so the warning above now describes " +
			"something that is not happening")
	}
}

// TestParseConstraints_SaysSomethingWhenAConstraintIsAllOrNothing pins the diagnostics that exist
// because silence here is indistinguishable from the constraint working. grounded and unburied are
// armed by the PRESENCE of their key, so `"grounded": false` reads like "off" and is not; both were
// accepted with no comment while the other two constraints type-checked theirs.
//
// The other half of this test used to live here too -- block_intersection with no allow list, which
// registered NO constraint and passed everything. That is now an error, and it is pinned by
// TestStructureTemplate_BlockIntersectionAllowlistIsRequired instead.
func TestParseConstraints_SaysSomethingWhenAConstraintIsAllOrNothing(t *testing.T) {
	parse := func(raw map[string]any) (int, []string) {
		t.Helper()
		var warnings []string
		ctx := &BuildContext{
			Palette: block.NewPalette(), Identifier: "probe:s", FileID: "s.json",
			Warn: func(m string) { warnings = append(warnings, m) },
		}
		checks, err := parseConstraints(raw, ctx)
		if err != nil {
			t.Fatalf("parseConstraints(%v): %v", raw, err)
		}
		return len(checks), warnings
	}

	t.Run("block_intersection with an allowlist stays quiet", func(t *testing.T) {
		n, warnings := parse(map[string]any{"block_intersection": map[string]any{
			"block_allowlist": []any{"minecraft:stone"},
		}})
		if n != 1 {
			t.Errorf("registered %d constraints, want 1", n)
		}
		if len(warnings) != 0 {
			t.Errorf("the shape that works must not warn, got %v", warnings)
		}
	})

	for _, c := range []struct {
		name  string
		value any
		warn  bool
	}{
		{"empty object is the correct spelling", map[string]any{}, false},
		{"null still arms it", nil, true},
		{"false reads like off and is not", false, true},
		{"a string still arms it", "yes", true},
		{"options inside it are read by nothing", map[string]any{"depth": 3.0}, true},
	} {
		t.Run("grounded: "+c.name, func(t *testing.T) {
			n, warnings := parse(map[string]any{"grounded": c.value})
			if n != 1 {
				t.Errorf("grounded must be ARMED however it is spelled (registered %d)", n)
			}
			if got := len(warnings) > 0; got != c.warn {
				t.Errorf("warned = %v, want %v (warnings: %v)", got, c.warn, warnings)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Explicit air versus void in the point set, and the block_intersection
// partition (1.26.50.24).
// ---------------------------------------------------------------------------

// synthStructureCells is the general form of synthStructure: `cell` returns the block name for
// each coordinate, or "" for a VOID cell. synthStructure stays because most tests only need
// "occupied or not" -- but three spellings of "empty" matter here that it cannot express, and they
// are three different answers to "is this cell a constraint point": void, explicit minecraft:air,
// and minecraft:structure_void.
func synthStructureCells(t *testing.T, pal *block.Palette, sx, sy, sz int, cell func(x, y, z int) string) *structures.ResolvedStructure {
	t.Helper()
	var ids []block.ID
	index := map[string]int32{}
	layer := make([]int32, sx*sy*sz)
	for x := 0; x < sx; x++ {
		for y := 0; y < sy; y++ {
			for z := 0; z < sz; z++ {
				idx := x*(sy*sz) + y*sz + z
				name := cell(x, y, z)
				if name == "" {
					layer[idx] = -1
					continue
				}
				pi, known := index[name]
				if !known {
					pi = int32(len(ids))
					index[name] = pi
					ids = append(ids, pal.Get(name, nil))
				}
				layer[idx] = pi
			}
		}
	}
	return &structures.ResolvedStructure{
		Size:       nbt.Vec3Int{X: sx, Y: sy, Z: sz},
		PaletteIDs: ids,
		Layer0:     layer,
	}
}

// TestStructureTemplate_UnburiedTreatsExplicitAirAsEmptyButNotStructureVoid pins the corrected
// point-set predicate on the constraint where it bites hardest.
//
// The game compares each sampled cell's full block identity against air's default state; a void
// cell reaches the SAME compare, because the game substitutes air for it. So void and explicit air
// are one answer, and this port asking only "is the cell void" put air cells into
// the point set.
//
// This is not a spelling nobody uses: a .mcstructure exported from a structure block writes
// empty-but-selected cells as explicit air, and features using such structures were refusing
// placements the game accepts because of it.
//
// minecraft:structure_void is the case that keeps the fix honest. It LOOKS like the same idea and
// is not: it is a real palette block with its own identity, so it never compares equal to
// air and it does contribute a point. Folding it into the skip would be the easy over-correction.
func TestStructureTemplate_UnburiedTreatsExplicitAirAsEmptyButNotStructureVoid(t *testing.T) {
	for _, c := range []struct {
		name        string
		empty       string
		contributes bool
	}{
		{"void", "", false},
		{"explicit air", "minecraft:air", false},
		{"structure_void", "minecraft:structure_void", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			pal := block.NewPalette()
			stone := pal.Get("minecraft:stone", nil)
			// 2x3x1: column x=0 is stone to the top, column x=1 is stone only on its bottom row
			// and spelled `empty` above that -- so only its TOP-ROW cell decides the question.
			st := synthStructureCells(t, pal, 2, 3, 1, func(x, y, z int) string {
				if x == 0 || y == 0 {
					return "minecraft:stone"
				}
				return c.empty
			})
			geo := &structureGeometry{structure: st}
			v := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
			// Obstruct the row above column x=1 and nothing else. Whether that fails the
			// constraint is exactly whether x=1's top-row cell is in the point set.
			v.SetBlock(wgen.BlockPos{X: 1, Y: 66, Z: 0}, stone)
			satisfied := unburiedConstraint()(constraintCtx(v), wgen.BlockPos{X: 0, Y: 63, Z: 0}, 0, wgen.BlockPos{}, geo)
			if satisfied == c.contributes {
				if c.contributes {
					t.Errorf("%s is a real block and must contribute a point, so the obstruction "+
						"above it must fail the constraint", c.name)
				} else {
					t.Errorf("%s must contribute no point, so the obstruction above it must be "+
						"ignored", c.name)
				}
			}
		})
	}
}

// TestStructureTemplate_GroundedAndLeveledSkipExplicitAirOnTheSampledRow covers the other two
// constraints that share the predicate. They sample the ground_level row rather than the top row,
// but the per-cell test is the same comparison against the same air state, so
// a fix that only reached unburied would be a fix in the wrong place.
func TestStructureTemplate_GroundedAndLeveledSkipExplicitAirOnTheSampledRow(t *testing.T) {
	pal := block.NewPalette()
	// 2x1x1 whose single row is stone at x=0 and explicit air at x=1.
	st := synthStructureCells(t, pal, 2, 1, 1, func(x, y, z int) string {
		if x == 0 {
			return "minecraft:stone"
		}
		return "minecraft:air"
	})
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}

	// Ground under column x=0 only: if the air cell were a point, grounded would look under x=1,
	// find nothing solid, and refuse.
	ground := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	ground.SetBlock(wgen.BlockPos{X: 0, Y: 62, Z: 0}, pal.Get("minecraft:stone", nil))
	if !groundedConstraint()(constraintCtx(ground), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("grounded checked the explicit-air column -- an air cell contributes no point")
	}

	// Same shape for leveled: column x=1's surface is far outside the scan window, so a point
	// there would refuse the whole placement.
	cliff := leveledWorld(t, pal, func(x, z int) int {
		if x == 1 {
			return 50
		}
		return 62
	})
	if !leveledConstraint(2)(constraintCtx(cliff), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("leveled checked the explicit-air column -- an air cell contributes no point")
	}
}

// TestStructureTemplate_BlockIntersectionPartitionsCellsAndChecksTheMotionBlockingHalf pins the
// second correction. The block-intersection constraint has no air test at all; it sorts
// every non-void cell into a motion-blocking vector and an everything-else vector, and
// its test walks the second one ONLY when only_check_intersection_for_motion_blocking_blocks
// is clear. The two vectors PARTITION the cells, so this is not "all cells, optionally narrowed"
// -- and reading it that way is how the default comes out backwards.
func TestStructureTemplate_BlockIntersectionPartitionsCellsAndChecksTheMotionBlockingHalf(t *testing.T) {
	pal := block.NewPalette()
	// 1x1x2: a motion-blocking cell at z=0 and an air cell at z=1.
	st := synthStructureCells(t, pal, 1, 1, 2, func(x, y, z int) string {
		if z == 0 {
			return "minecraft:stone"
		}
		return "minecraft:air"
	})
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	allow := ResolveMatchSet(
		[]block.Descriptor{{Name: "minecraft:air"}},
		&BuildContext{Palette: pal, Identifier: "test:s", FileID: "s.json", Warn: func(string) {}},
		"constraints.block_intersection.block_allowlist")

	// The world is legal under the stone cell and illegal under the air cell.
	v := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 63, Z: 1}, pal.Get("minecraft:dirt", nil))

	if !blockIntersectionConstraint(allow, true)(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("the motion-blocking half does not contain the air cell, so the illegal world " +
			"block under it must not be seen")
	}
	if blockIntersectionConstraint(allow, false)(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("with the flag clear BOTH vectors are walked, so the illegal world block under " +
			"the air cell must fail the constraint")
	}

	// And the other half of the partition: an illegal block under the MOTION-BLOCKING cell fails
	// either way. Without this the assertions above would pass just as well against a constraint
	// that checks nothing at all.
	w := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	w.SetBlock(wgen.BlockPos{X: 0, Y: 63, Z: 0}, pal.Get("minecraft:dirt", nil))
	for _, only := range []bool{true, false} {
		if blockIntersectionConstraint(allow, only)(constraintCtx(w), candidate, 0, wgen.BlockPos{}, geo) {
			t.Errorf("onlyMotionBlocking=%v: the motion-blocking cell is in both readings and must "+
				"always be checked", only)
		}
	}
}

// TestStructureTemplate_MotionBlockingDefaultIsTrue goes through parseConstraints rather than
// calling the constraint directly, because the DEFAULT is the whole finding: most files never write
// the key, so they all get the game's default -- true. A test exercising only the explicit
// spellings would pass equally well against the wrong default.
func TestStructureTemplate_MotionBlockingDefaultIsTrue(t *testing.T) {
	// One palette for the whole test. It used to build the constraint against a
	// SECOND, empty palette and still pass, because the only id the allowlist had
	// to recognise was air -- which is a fixed id in every palette -- and the dirt
	// it had to reject was absent from the empty one for the wrong reason. That
	// held only while match lists compared interned ids; a list that compares
	// NAMES has to look the candidate up, and looking an id from another palette
	// up is meaningless at best.
	pal := block.NewPalette()
	build := func(t *testing.T, bi map[string]any) constraint {
		t.Helper()
		ctx := &BuildContext{
			Palette: pal, Resolver: condResolver{},
			Identifier: "test:s", FileID: "s.json", Warn: func(string) {},
		}
		checks, err := parseConstraints(map[string]any{"block_intersection": bi}, ctx)
		if err != nil {
			t.Fatalf("parseConstraints: %v", err)
		}
		if len(checks) != 1 {
			t.Fatalf("parseConstraints produced %d constraints, want 1", len(checks))
		}
		return checks[0]
	}

	st := synthStructureCells(t, pal, 1, 1, 2, func(x, y, z int) string {
		if z == 0 {
			return "minecraft:stone"
		}
		return "minecraft:air"
	})
	geo := &structureGeometry{structure: st}
	candidate := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	v := volume.New(volume.Bounds{MinX: -4, MinY: 50, MinZ: -4, SizeX: 12, SizeY: 30, SizeZ: 12}, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 63, Z: 1}, pal.Get("minecraft:dirt", nil))

	allowAir := []any{"minecraft:air"}
	if !build(t, map[string]any{"block_allowlist": allowAir})(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("with the key absent the game's default (TRUE) applies, so only the " +
			"motion-blocking cell is checked and this must pass")
	}
	if build(t, map[string]any{
		"block_allowlist": allowAir,
		"only_check_intersection_for_motion_blocking_blocks": false,
	})(constraintCtx(v), candidate, 0, wgen.BlockPos{}, geo) {
		t.Error("an explicit false must widen the check to every non-void cell and fail here")
	}
}

// ---------------------------------------------------------------------------
// Schema RANGES. Both fields below are validated by the game's own schema
// and neither is clamped afterwards, so an out-of-range value is a
// file that does not load -- not a value with a repaired meaning.
// ---------------------------------------------------------------------------

// oneStructure is a structures.IResolver that answers every name with the same structure, so a
// build-level test does not need a real .mcstructure file on disk.
type oneStructure struct{ st *structures.ResolvedStructure }

func (o oneStructure) Resolve(string) *structures.ResolvedStructure { return o.st }

func buildStructureTemplate(t *testing.T, body map[string]any) error {
	t.Helper()
	pal := block.NewPalette()
	st := synthStructureCells(t, pal, 1, 1, 1, func(x, y, z int) string { return "minecraft:stone" })
	ctx := &BuildContext{
		Palette: pal, Resolver: condResolver{}, Structures: oneStructure{st: st},
		Identifier: "test:s", FileID: "s.json", Warn: func(string) {},
	}
	full := map[string]any{"structure_name": "test:st", "constraints": map[string]any{}}
	for k, v := range body {
		full[k] = v
	}
	_, err := buildStructureTemplateFeature(full, ctx)
	return err
}

// TestStructureTemplate_AdjustmentRadiusIsRangeCheckedNotClamped pins the correction to a field
// this port used to silently repair. The game's schema gives the field an explicit range of
// [0, 16] and rejects anything outside it; the position search then computes its budget straight
// from the signed value -- ((2r)|1) squared, with no guard of any kind. So there is no clamp to
// imitate anywhere in the game, and clamping a negative radius to 0 here
// (which is what this port did) invented a repair and hid a pack bug the game does not hide.
func TestStructureTemplate_AdjustmentRadiusIsRangeCheckedNotClamped(t *testing.T) {
	for _, v := range []float64{0, 1, 16} {
		if err := buildStructureTemplate(t, map[string]any{"adjustment_radius": v}); err != nil {
			t.Errorf("adjustment_radius %v is inside [0, 16] and must be accepted: %v", v, err)
		}
	}
	for _, v := range []float64{-1, 17, 100} {
		err := buildStructureTemplate(t, map[string]any{"adjustment_radius": v})
		if err == nil {
			t.Errorf("adjustment_radius %v is outside [0, 16] and must be refused", v)
			continue
		}
		// The message has to name the range and say the GAME refuses the file, not just that this
		// tool did -- an author told only the latter goes looking in the wrong place.
		if !strings.Contains(err.Error(), "[0, 16]") || !strings.Contains(err.Error(), "refuses to load") {
			t.Errorf("adjustment_radius %v: the error must name the range and the game's verdict; got %v", v, err)
		}
	}
}

// TestStructureTemplate_GroundLevelRejectsNegative is adjustment_radius's smaller sibling:
// ground_level's schema carries a minimum of 0 and no maximum. place() does clamp the value
// to [0, sizeY-1] and that clamp is still transcribed -- but only its upper half can ever fire,
// because a negative value never reaches place() in the game.
func TestStructureTemplate_GroundLevelRejectsNegative(t *testing.T) {
	if err := buildStructureTemplate(t, map[string]any{"ground_level": float64(0)}); err != nil {
		t.Errorf("ground_level 0 must be accepted: %v", err)
	}
	// Above the structure's own height is NOT a schema error -- there is no maximum -- so it must
	// still build, and place()'s clamp deals with it.
	if err := buildStructureTemplate(t, map[string]any{"ground_level": float64(99)}); err != nil {
		t.Errorf("ground_level has no schema maximum, so 99 must build and be clamped at place time: %v", err)
	}
	err := buildStructureTemplate(t, map[string]any{"ground_level": float64(-1)})
	if err == nil || !strings.Contains(err.Error(), "minimum of 0") {
		t.Errorf("a negative ground_level must be refused with a message naming the schema minimum; got %v", err)
	}
}
