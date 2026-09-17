// hostile_input_test.go is the regression table for inputs a pack author can write that used to
// take this tool down rather than tell them anything.
//
// WHY IT IS A TABLE RATHER THAN ONE TEST PER BUG. Every entry below was found by sweeping all 27
// implemented feature types with the same handful of hostile values, and the sweep found the same
// SHAPE in builder after builder: a number from JSON reaching an allocation, a loop bound or a
// divisor with nothing between the two. Written out one function per bug, that shape is invisible
// and the next builder to grow one goes unnoticed; written as a table, adding a row is the cheap
// thing and the shape is the thing you read. The individual assertions further down pin the exact
// arithmetic each fix turns on, because a table can only prove "it did not crash" -- it cannot
// prove the boundary case a careless fix would break while still passing.
//
// THE ROOT CAUSE, since most rows share it. Go's `int` is 64 bits and the engine's is 32. A JSON
// number that does not fit is converted with a bare `int(f)`, which is implementation-defined once
// the value leaves int64's range and lands on math.MinInt64 on amd64. That single value then
// behaves as: a negative slice length (makeslice panic), a loop bound that overflows back onto
// itself (a loop that never ends), and -- because its low 32 bits are zero -- an RNG bound that
// passes a 64-bit "is it zero" test and then divides by zero. See random.Rand.NextIntBound.
package features

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// hostileCase is one feature body that must not be able to crash the tool.
type hostileCase struct {
	name string
	// typeID is the minecraft:*_feature key the body goes under.
	typeID string
	// body is the feature body verbatim, minus description (added by the runner).
	body string
	// wantBuildRefused is true when the fix REFUSES the file rather than placing it. Refusing is
	// only correct where placing has nothing sensible to do -- see each row's own comment.
	wantBuildRefused bool
	// wantDiagnostic, when set, must appear in the refusal or in a build warning. It is the part
	// that actually helps the author, so it is pinned rather than left to drift.
	wantDiagnostic string
}

// hostileCases is the table. Every row REPRODUCES A CRASH, HANG OR WEDGE that this tool had:
// each one was watched failing (panic, or the fixed value looping forever) before its fix went in.
var hostileCases = []hostileCase{
	// -----------------------------------------------------------------------------------------
	// Negative / overflowing slice capacities. The class the inverted search_volume belonged to.
	// -----------------------------------------------------------------------------------------
	{
		name:   "tree canopy_offset inverted makes a negative variation_chance length",
		typeID: "minecraft:tree_feature",
		// `make([]chanceInformation, int(0-2)+1)` = make(..., -1) -> "makeslice: len out of
		// range", AT BUILD TIME, so `featurelab check` crashed on this file rather than
		// reporting it. Exactly the inverted-{min,max} shape that crashed search_volume, in a
		// different type -- which is why the table exists.
		body: `"trunk":{"trunk_block":"minecraft:oak_log","trunk_height":5},
			"canopy":{"leaf_block":"minecraft:oak_leaves",
			"canopy_offset":{"min":2,"max":0},"variation_chance":0.5}`,
		wantDiagnostic: "canopy_offset runs from 2 down to 0",
	},
	{
		name:   "tree canopy_offset fractional disagrees with the layers actually walked",
		typeID: "minecraft:tree_feature",
		// The opposite corner of the same field. int(2.0-0.5)+1 == 2 sized the array, but the
		// placer walks int(0.5)..int(2.0) == three layers, so `variationChance[dy-offsetMin]`
		// ran off the end with "index out of range" at PLACE time, having built cleanly.
		body: `"trunk":{"trunk_block":"minecraft:oak_log","trunk_height":5},
			"canopy":{"leaf_block":"minecraft:oak_leaves",
			"canopy_offset":{"min":0.5,"max":2.0},"variation_chance":[0.2,0.2]}`,
		wantBuildRefused: true,
		wantDiagnostic:   "variation_chance has 2 entries, want 3",
	},
	{
		name:   "search_volume span too wide to represent",
		typeID: "minecraft:search_feature",
		// NOT the inverted case the earlier fix covered -- max is comfortably above min here.
		// `max-min+1` OVERFLOWS to a negative capacity, and make() panicked identically. The
		// realistic spelling is `-1e300`, which is what `int(f)` turns into this literal.
		body: `"places_feature":"hostile:marker",
			"search_volume":{"min":[0,-9223372036854775808,0],"max":[0,0,0]},
			"search_axis":"-y","required_successes":1`,
		wantBuildRefused: true,
		wantDiagnostic:   "a span too wide to represent",
	},
	{
		name:   "ore count too large to be a whole number",
		typeID: "minecraft:ore_feature",
		// `count` was checked >= 1 as a FLOAT and then stored as int(f). 1e19 passes the float
		// test and becomes math.MinInt64, so `make([]oreSphere, count)` panicked. The gap was
		// between the two forms of the same number, not between two different checks.
		body: `"count":1e19,
			"replace_rules":[{"places_block":"minecraft:diamond_ore","may_replace":["minecraft:stone"]}]`,
		wantBuildRefused: true,
		wantDiagnostic:   "does not fit in an integer",
	},

	// -----------------------------------------------------------------------------------------
	// Divide by zero: a bound whose low 32 bits are zero. All of these panicked with
	// "runtime error: integer divide by zero" before random.Rand.NextIntBound narrowed its test.
	// -----------------------------------------------------------------------------------------
	{
		name:   "cave skip_carve_chance that does not fit in an integer",
		typeID: "minecraft:cave_carver_feature",
		// Refused at build now. The builder's "must be an integer" test had one false negative --
		// math.MinInt64 round-trips through float64 and back -- and that is precisely the value
		// every out-of-range number converts to, so the guard let through the one input it most
		// needed to stop. It reached the engine's bounded integer draw as a bound whose low 32 bits are zero and
		// divided by zero.
		body: `"fill_with":"minecraft:air","skip_carve_chance":-9223372036854775808,
			"height_limit":62,"y_scale":{"range_min":1,"range_max":1},
			"horizontal_radius_multiplier":{"range_min":1,"range_max":1},
			"vertical_radius_multiplier":{"range_min":1,"range_max":1},
			"floor_level":{"range_min":-1,"range_max":-1}`,
		wantBuildRefused: true,
		wantDiagnostic:   "skip_carve_chance must be an integer",
	},
	{
		name:   "cave height_limit that does not fit in an integer",
		typeID: "minecraft:cave_carver_feature",
		// Same field shape, same guard, different consequence: this one divided by zero too, and
		// once that was fixed at the RNG it carved with nonsense Y bounds and ground on
		// indefinitely instead. Refusing the unrepresentable value is what actually closes it.
		body: `"fill_with":"minecraft:air","skip_carve_chance":1,
			"height_limit":-9223372036854775808,"y_scale":{"range_min":1,"range_max":1},
			"horizontal_radius_multiplier":{"range_min":1,"range_max":1},
			"vertical_radius_multiplier":{"range_min":1,"range_max":1},
			"floor_level":{"range_min":-1,"range_max":-1}`,
		wantBuildRefused: true,
		wantDiagnostic:   "height_limit must be an integer",
	},
	{
		name:   "nether cave skip_carve_chance that does not fit in an integer",
		typeID: "minecraft:nether_cave_carver_feature",
		// The three carvers each keep their own copy of the same intField helper, so the same
		// hole existed three times. All three rows are here so a fix to one that misses the
		// others is caught.
		body: `"fill_with":"minecraft:air","skip_carve_chance":-9223372036854775808,
			"height_limit":62,"y_scale":{"range_min":1,"range_max":1},
			"horizontal_radius_multiplier":{"range_min":1,"range_max":1},
			"vertical_radius_multiplier":{"range_min":1,"range_max":1},
			"floor_level":{"range_min":-1,"range_max":-1}`,
		wantBuildRefused: true,
		wantDiagnostic:   "skip_carve_chance must be an integer",
	},
	{
		name:   "underwater cave skip_carve_chance that does not fit in an integer",
		typeID: "minecraft:underwater_cave_carver_feature",
		body: `"fill_with":"minecraft:air","replace_air_with":"minecraft:water",
			"skip_carve_chance":-9223372036854775808,
			"height_limit":62,"y_scale":{"range_min":1,"range_max":1},
			"horizontal_radius_multiplier":{"range_min":1,"range_max":1},
			"vertical_radius_multiplier":{"range_min":1,"range_max":1},
			"floor_level":{"range_min":-1,"range_max":-1}`,
		wantBuildRefused: true,
		wantDiagnostic:   "skip_carve_chance must be an integer",
	},
	{
		name:   "growing_plant body block weight past float32's whole-number range",
		typeID: "minecraft:growing_plant_feature",
		// WeightedPick accumulates in float32, and every float32 at or above 2^56 has all 32 low
		// bits zero -- so ANY weight that big, not just an exact multiple of 2^32, reached
		// NextIntBound as a bound that a 64-bit zero-test let through.
		body: `"height_distribution":[[[1,3],1]],"growth_direction":"down",
			"body_blocks":[["minecraft:cave_vines",1e18]],
			"head_blocks":[["minecraft:cave_vines",1]],"allow_water":false`,
	},
	{
		name:   "growing_plant height_distribution weight past float32's whole-number range",
		typeID: "minecraft:growing_plant_feature",
		body: `"height_distribution":[[[1,3],1e18]],"growth_direction":"down",
			"body_blocks":[["minecraft:cave_vines",1]],
			"head_blocks":[["minecraft:cave_vines",1]],"allow_water":false`,
	},
	{
		name:   "single_block places_block weight past float32's whole-number range",
		typeID: "minecraft:single_block_feature",
		body: `"enforce_placement_rules":false,"enforce_survivability_rules":false,
			"places_block":[{"block":"minecraft:pumpkin","weight":1e18}],
			"may_replace":["minecraft:air"]`,
	},
	{
		name:   "weighted_random weight past float32's whole-number range",
		typeID: "minecraft:weighted_random_feature",
		body:   `"features":[["hostile:marker",1e18]]`,
	},
	{
		name:   "scatter scatter_chance denominator that truncates to zero",
		typeID: "minecraft:scatter_feature",
		// `den >= 1` passes on the float; uint32(4294967296) is 0.
		body: `"places_feature":"hostile:marker","distribution":{"iterations":2,
			"x":0,"y":0,"z":0,"scatter_chance":{"numerator":1,"denominator":4294967296}}`,
	},
	{
		name:   "scatter uniform extent that truncates to a zero bound",
		typeID: "minecraft:scatter_feature",
		body: `"places_feature":"hostile:marker","distribution":{"iterations":2,
			"x":{"distribution":"uniform","extent":[0,4294967296]},"y":0,"z":0}`,
	},
	{
		name:   "scatter fixed_grid extent whose modulus truncates to zero",
		typeID: "minecraft:scatter_feature",
		// A separate divisor from the one above, in gridIndexNext, with the identical
		// 64-bit-guard / 32-bit-divisor mismatch. extent [0, 4294967295] gives modulus 2^32.
		body: `"places_feature":"hostile:marker","distribution":{"iterations":2,
			"x":{"distribution":"fixed_grid","extent":[0,4294967295]},"y":0,"z":0}`,
	},
	{
		name:   "scatter jittered_grid step_size that truncates to a zero bound",
		typeID: "minecraft:scatter_feature",
		body: `"places_feature":"hostile:marker","distribution":{"iterations":2,
			"x":{"distribution":"jittered_grid","extent":[0,15],"step_size":4294967296},"y":0,"z":0}`,
	},

	{
		name:   "scatter scatter_chance denominator written as a quoted number",
		typeID: "minecraft:scatter_feature",
		// NOT a crash -- the opposite. Both conversions discarded their `ok`, so a value this
		// field could not read became 0, and 0 fails ShouldScatter's `num >= 1 && den >= 1` gate,
		// whose else-branch returns TRUE. A one-in-four chance scattered every single time, and
		// nothing said a word. Quoting a number is the commonest way a hand-edited JSON field
		// goes wrong, which is why this row is here next to the crashes.
		body: `"places_feature":"hostile:marker","distribution":{"iterations":2,
			"x":0,"y":0,"z":0,"scatter_chance":{"numerator":1,"denominator":"4"}}`,
		wantBuildRefused: true,
		wantDiagnostic:   "scatter_chance.denominator must be a number",
	},

	// -----------------------------------------------------------------------------------------
	// Loops that could never end -- not "enormous", genuinely non-terminating.
	// -----------------------------------------------------------------------------------------
	{
		name:   "geode max_radius that wraps its own loop bound",
		typeID: "minecraft:geode_feature",
		// `for x := origin.X - 1; x >= origin.X - maxRadius; x--` with maxRadius at MinInt64:
		// the bound overflows back to MinInt64, so the test holds for every int there is. No
		// allocation, no write, no draw -- so none of the three budgets could interrupt it, and
		// the tool simply pinned a core forever. The builder's own "must be an integer" test let
		// this through because MinInt64 is the one out-of-range value that round-trips.
		body: `"filler":"minecraft:air","inner_layer":"minecraft:amethyst_block",
			"alternate_inner_layer":"minecraft:calcite","middle_layer":"minecraft:calcite",
			"outer_layer":"minecraft:smooth_basalt","inner_placements":["minecraft:amethyst_cluster"],
			"min_outer_wall_distance":4,"max_outer_wall_distance":6,"min_distribution_points":3,
			"max_distribution_points":4,"min_point_offset":1,"max_point_offset":2,
			"max_radius":-9223372036854775808,"crack_point_offset":2,"generate_crack_chance":0.95,
			"base_crack_size":2,"noise_multiplier":0.05,"use_potential_placements_chance":0.35,
			"use_alternate_layer0_chance":0.083,"placements_require_layer0_alternate":true,
			"invalid_blocks_threshold":1`,
		wantBuildRefused: true,
		wantDiagnostic:   "run forever",
	},
}

// TestHostileInputsDoNotCrashTheTool runs every row through the whole path an author's file takes
// -- BuildLibrary (which is what `featurelab check` runs) and then Place (which is what `generate`
// runs) -- and fails if any of them panics. A builder that ACCEPTS a value is only half the
// surface: three rows here built cleanly for months and then took the process down at placement.
func TestHostileInputsDoNotCrashTheTool(t *testing.T) {
	for _, tc := range hostileCases {
		t.Run(tc.name, func(t *testing.T) {
			refused, diags := runHostileCase(t, tc.typeID, tc.body)
			if refused != tc.wantBuildRefused {
				t.Errorf("build refused = %v, want %v; diagnostics: %s",
					refused, tc.wantBuildRefused, strings.Join(diags, " | "))
			}
			if tc.wantDiagnostic != "" {
				joined := strings.Join(diags, " | ")
				if !strings.Contains(joined, tc.wantDiagnostic) {
					t.Errorf("no diagnostic contains %q; got: %s", tc.wantDiagnostic, joined)
				}
			}
		})
	}
}

// runHostileCase builds one feature body alongside a resolvable marker feature and, if it built,
// places it. It returns whether the build refused the file, plus every diagnostic raised. A panic
// anywhere fails the test rather than being recovered into a result: "it did not crash" is the
// whole assertion, so swallowing one would defeat the test.
func runHostileCase(t *testing.T, typeID, body string) (refused bool, diags []string) {
	t.Helper()

	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -20, MinY: 40, MinZ: -20, SizeX: 41, SizeY: 50, SizeZ: 41}
	vol := volume.New(bounds, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	grass := pal.Get("minecraft:grass_block", nil)
	for x := -20; x <= 20; x++ {
		for z := -20; z <= 20; z++ {
			for y := 40; y < 63; y++ {
				vol.SetBlockAt(x, y, z, stone)
			}
			vol.SetBlockAt(x, 63, z, grass)
		}
	}

	const marker = `{"format_version":"1.26.50","minecraft:single_block_feature":{
		"description":{"identifier":"hostile:marker"},"enforce_placement_rules":false,
		"enforce_survivability_rules":false,"places_block":"minecraft:gold_block"}}`
	subject := `{"format_version":"1.26.50","` + typeID + `":{
		"description":{"identifier":"hostile:subject"},` + body + `}}`

	lib := BuildLibrary([]SourceFile{
		{ID: "marker.json", AbsPath: "marker.json", Text: marker},
		{ID: "subject.json", AbsPath: "subject.json", Text: subject},
	}, pal, nil)
	for _, d := range lib.Diagnostics {
		if d.FileID == "subject.json" {
			diags = append(diags, d.Message)
		}
	}
	var feature wgen.IFeature
	for _, e := range lib.Entries {
		if e.FileID == "subject.json" {
			feature = e.Feature
		}
	}
	if feature == nil {
		return true, diags
	}

	// The same three budgets session.generate arms, so a row that still ran away here would be
	// running away past everything production has -- which is the finding, not a slow test.
	wb := 4_000_000
	vol.WriteBudget = &wb
	db := 2_000_000
	tl := 8_000
	SetDelegationBudgetMs(&db, &tl)
	defer SetDelegationBudgetMs(nil, nil)

	ctx := &wgen.PlacementContext{
		API: vol, Origin: wgen.BlockPos{X: 0, Y: 64, Z: 0}, Random: random.New(12345),
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "hostile:biome", Tags: map[string]struct{}{}},
		LogFailure:  func(string, string, wgen.BlockPos) {},
		LogWarning:  func(string, string, *wgen.BlockPos) {},
	}
	feature.Place(ctx)
	return false, diags
}

// buildHostileFeature builds ONE feature body through the same BuildLibrary path `featurelab
// check` runs and returns the built feature, failing the test if the builder refused it. Split out
// of runHostileCase so a test can drive Place itself -- runHostileCase deliberately calls Place
// with no recover (a panic there IS its failure), which is the opposite of what a test that
// asserts on the panic needs.
func buildHostileFeature(t *testing.T, typeID, body string) wgen.IFeature {
	t.Helper()

	const marker = `{"format_version":"1.26.50","minecraft:single_block_feature":{
		"description":{"identifier":"hostile:marker"},"enforce_placement_rules":false,
		"enforce_survivability_rules":false,"places_block":"minecraft:gold_block"}}`
	subject := `{"format_version":"1.26.50","` + typeID + `":{
		"description":{"identifier":"hostile:subject"},` + body + `}}`

	lib := BuildLibrary([]SourceFile{
		{ID: "marker.json", AbsPath: "marker.json", Text: marker},
		{ID: "subject.json", AbsPath: "subject.json", Text: subject},
	}, block.NewPalette(), nil)
	for _, e := range lib.Entries {
		if e.FileID == "subject.json" {
			return e.Feature
		}
	}
	var diags []string
	for _, d := range lib.Diagnostics {
		if d.FileID == "subject.json" {
			diags = append(diags, d.Message)
		}
	}
	t.Fatalf("%s body was refused at build time, so it never reaches Place: %s", typeID, strings.Join(diags, " | "))
	return nil
}

// hostileGeodeHugeRadius is a geode whose max_radius is enormous but perfectly REPRESENTABLE, so
// none of the builder's own guards fire: it is not fractional, it is not the one MinInt64 value
// that wraps its own loop bound, and the engine has no upper limit on the field for this port to
// borrow. The scan it asks for is (2*2e9)^3 columns, each one a distance sum plus a 3-D noise
// sample -- not "slow", not finishable.
//
// It is the same shape as the table's own "geode max_radius that wraps its own loop bound" row,
// deliberately: that row is REFUSED at build time, because a wrapped bound is provably a bug in
// the file. This one cannot be refused, because 2,000,000,000 is a number a pack author is
// allowed to write and no ceiling this project could name would be the engine's. Bounding it is
// the deadline's job, not the builder's.
const hostileGeodeHugeRadius = `"filler":"minecraft:air","inner_layer":"minecraft:amethyst_block",
	"alternate_inner_layer":"minecraft:calcite","middle_layer":"minecraft:calcite",
	"outer_layer":"minecraft:smooth_basalt","inner_placements":["minecraft:amethyst_cluster"],
	"min_outer_wall_distance":4,"max_outer_wall_distance":6,"min_distribution_points":3,
	"max_distribution_points":4,"min_point_offset":1,"max_point_offset":2,
	"max_radius":2000000000,"crack_point_offset":2,"generate_crack_chance":0.95,
	"base_crack_size":2,"noise_multiplier":0.05,"use_potential_placements_chance":0.35,
	"use_alternate_layer0_chance":0.083,"placements_require_layer0_alternate":true,
	"invalid_blocks_threshold":1`

// TestLeafFeatureIsBoundedByThePlacementDeadline is the regression test for the STRUCTURAL finding
// the rest of this file's sweep turned up: a leaf feature escaped all three budgets. The write
// budget counts write ATTEMPTS and this scan's dominant path (`density < tC4 -> continue`) writes
// nothing; the delegation budget and the wall-clock deadline were both checked only inside
// WithRecursionGuard, i.e. only when one feature delegates to another, and a geode delegates to
// nothing. So `--placement-time-limit-ms`, which this tool advertises in its CLI, its VS Code
// panel and its desktop panel, did not cover this feature at all.
//
// WHAT THIS TEST HAS TO SHOW, AND WHY EACH PART MATTERS.
//
//   - It truncates AT ALL. Without features.TickDeadline this does not fail, it HANGS -- verified
//     by stubbing TickDeadline's body out and running this test under `go test -timeout 20s`,
//     which reported "panic: test timed out after 20s" with the goroutine parked in
//     GeodeFeature.Place's visitColumn. A deadline that a leaf can outrun is not a deadline.
//   - It truncates with NO DELEGATION IN THE CHAIN (Delegations == 0). That is the whole point:
//     an abort that only happens once something delegates is the behaviour that was already
//     there. A chain length of one is what makes this a genuinely new guarantee.
//   - It is a *PlacementDeadlineExceeded and not some new error type. session.Generate's recover
//     switch turns exactly four panic types into a partial result and RE-PANICS everything else,
//     so an abort that invented its own type would reach a pack author as a raw Go stack trace --
//     the exact failure mode the tree-refusal fix in this same sweep removed.
//   - Its diagnostic NAMES THE LOOP. "Placement time limit exceeded" tells an author to raise the
//     limit, which is the wrong move when one field is nine orders of magnitude too large.
func TestLeafFeatureIsBoundedByThePlacementDeadline(t *testing.T) {
	feature := buildHostileFeature(t, "minecraft:geode_feature", hostileGeodeHugeRadius)

	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -20, MinY: 40, MinZ: -20, SizeX: 41, SizeY: 50, SizeZ: 41}
	vol := volume.New(bounds, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	for x := -20; x <= 20; x++ {
		for z := -20; z <= 20; z++ {
			for y := 40; y < 63; y++ {
				vol.SetBlockAt(x, y, z, stone)
			}
		}
	}

	// The same three budgets session.Generate arms, with only the deadline shortened so the test
	// is fast. The write and delegation budgets are left at their production values ON PURPOSE:
	// if either of them could stop this run, the finding would not exist and this test would be
	// proving nothing.
	wb := 4_000_000
	vol.WriteBudget = &wb
	vol.WritesAttempted = 0
	db := 2_000_000
	tl := 50
	SetDelegationBudgetMs(&db, &tl)
	defer SetDelegationBudgetMs(nil, nil)

	ctx := &wgen.PlacementContext{
		API: vol, Origin: wgen.BlockPos{X: 0, Y: 64, Z: 0}, Random: random.New(12345),
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "hostile:biome", Tags: map[string]struct{}{}},
		LogFailure:  func(string, string, wgen.BlockPos) {},
		LogWarning:  func(string, string, *wgen.BlockPos) {},
	}

	start := time.Now()
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		feature.Place(ctx)
	}()
	elapsed := time.Since(start)

	if recovered == nil {
		t.Fatal("a geode with max_radius 2000000000 returned normally -- it cannot have run the scan it was asked for")
	}
	e, ok := recovered.(*PlacementDeadlineExceeded)
	if !ok {
		t.Fatalf("panic value = %T (%v), want *PlacementDeadlineExceeded -- session.Generate's recover "+
			"re-panics anything that is not one of its four known types, so a new type here would reach "+
			"a pack author as a Go stack trace", recovered, recovered)
	}
	if e.Delegations != 0 {
		t.Errorf("Delegations = %d, want 0 -- this abort must happen with NO delegation in the chain; "+
			"a leaf that only stops once something delegates is the bug, not the fix", e.Delegations)
	}
	if e.Site == "" {
		t.Error("Site is empty -- the diagnostic must name the loop that was running, not just say the " +
			"time limit was hit")
	}
	if !strings.Contains(e.Error(), "max_radius") {
		t.Errorf("Error() = %q, want it to name the max_radius scan -- naming the field is what tells an "+
			"author to shrink it rather than to raise the limit", e.Error())
	}
	if !strings.Contains(e.Error(), "NOT REPRODUCIBLE") {
		t.Errorf("Error() = %q, want the wall-clock truncation to still declare itself not reproducible", e.Error())
	}
	if len(e.Chain) == 0 {
		t.Error("Chain is empty -- it is captured at the raise site precisely so it survives the unwind")
	}
	// Generous: the deadline is 50ms, and this asserts only that the run is bounded at all, not
	// how tightly. A machine that stalls for a second under load must not turn this into a flake.
	if elapsed > 30*time.Second {
		t.Errorf("took %v to notice a 50ms deadline -- the tripwire is sampling far too coarsely", elapsed)
	}
}

// TestPlacementDeadlineSiteIsAbsentForADelegationAbort keeps the two halves of the deadline
// distinguishable. WithRecursionGuard's own check has no single loop to name -- the delegation
// chain IS the answer there -- so it must keep leaving Site empty and keep producing the message
// it always produced. Without this, a well-meaning edit that filled Site in at the delegation site
// too would quietly make every deadline diagnostic claim to be a leaf loop.
func TestPlacementDeadlineSiteIsAbsentForADelegationAbort(t *testing.T) {
	e := &PlacementDeadlineExceeded{Delegations: 42, LimitMs: 8000}
	if got := e.Error(); !strings.Contains(got, "after 42 nested placements") {
		t.Errorf("Error() = %q, want the delegation-site wording when Site is empty", got)
	}
	leaf := &PlacementDeadlineExceeded{Delegations: 0, LimitMs: 8000, Site: "scanning the block volume its max_radius covers"}
	if got := leaf.Error(); !strings.Contains(got, "not a delegation chain") {
		t.Errorf("Error() = %q, want a leaf abort to say plainly that no delegation was involved -- "+
			"otherwise the obvious reading of any budget message in this tool, \"something is "+
			"recursing\", sends the author to the wrong file", got)
	}
}

// TestNextIntBoundZeroTestIsThirtyTwoBitsWide pins the arithmetic behind most of the table above,
// because the table can only show that nothing crashed -- it cannot show that the DRAWS are
// untouched, and this is a change to the RNG that every golden digest depends on.
//
// Three things have to hold at once, and a careless fix breaks one of them while passing the
// others: a bound whose low 32 bits are zero must not divide by zero; every other bound must draw
// exactly what it drew before, bit for bit; and the deliberate negative-bound wrap tree.go's
// random_spread_canopy header argues for (kept because the engine wraps the same way) must
// survive.
func TestNextIntBoundZeroTestIsThirtyTwoBitsWide(t *testing.T) {
	// The panics. Each of these used to be "runtime error: integer divide by zero": the guard read
	// all 64 bits, the modulus read the low 32.
	for _, bound := range []int{
		4294967296,    // 2^32
		-4294967296,   // -2^32
		8589934592,    // 2^33
		1 << 62,       // any high power of two
		math.MinInt64, // what int(f) yields on amd64 for any out-of-range float
		1 << 56,       // what int(float32(1e18)) is -- the weighted-pick route
		1<<40 + 1<<35, // an arbitrary large value whose low 32 bits happen to clear
	} {
		got := random.New(1).NextIntBound(bound)
		if got != 0 {
			t.Errorf("NextIntBound(%d) = %d, want 0 (bound is zero in the engine's 32-bit int)", bound, got)
		}
	}

	// A bound whose low 32 bits are zero must not SPEND A DRAW either, matching what the engine's
	// own bounded integer draw does for a zero bound (features/shared.go's header: it returns 0
	// without reaching the twister at all). If it drew, every later placement in the chunk would
	// move.
	spent := random.New(7)
	spent.NextIntBound(4294967296)
	untouched := random.New(7)
	if a, b := spent.NextFloat(), untouched.NextFloat(); a != b {
		t.Errorf("a zero-in-32-bits bound consumed a draw: next float %v vs %v", a, b)
	}

	// The inert half: ordinary bounds are bit-identical to what mtrand returned before, and that
	// is checked against a generator drawing the same sequence, not against a remembered constant.
	for _, bound := range []int{1, 2, 3, 16, 1000, 1 << 30, math.MaxInt32} {
		a, b := random.New(99), random.New(99)
		for i := 0; i < 8; i++ {
			got, want := a.NextIntBound(bound), int(b.NextUint32()%uint32(bound))
			if got != want {
				t.Fatalf("NextIntBound(%d) draw %d = %d, want %d", bound, i, got, want)
			}
		}
	}

	// The wrap tree.go deliberately keeps: a negative bound still draws and still wraps to a huge
	// uint32, because the engine does the same. Refusing or clamping it here would be a silent
	// behaviour change dressed up as a crash fix.
	wrapped, plain := random.New(5), random.New(5)
	negative := -3 // a variable, so the uint32 conversion below wraps at run time rather than
	// being rejected as an overflowing constant expression at compile time.
	if got, want := wrapped.NextIntBound(negative), int(plain.NextUint32()%uint32(negative)); got != want {
		t.Errorf("negative bound = %d, want the wrapped %d -- the engine's own wrap must survive", got, want)
	}
}

// TestGridIndexNextZeroModulusTestIsThirtyTwoBitsWide is gridIndexNext's half of the same mistake:
// its guard read the 64-bit modulus while its divisor was uint32(int32(modulus)).
func TestGridIndexNextZeroModulusTestIsThirtyTwoBitsWide(t *testing.T) {
	// Used to panic. extent [0, 4294967295] gives exactly this modulus.
	if got := gridIndexNext(1, 1, 0, 1<<32); got != 0 {
		t.Errorf("gridIndexNext with a 2^32 modulus = %d, want 0", got)
	}
	if got := gridIndexNext(1, 1, 0, math.MinInt64); got != 0 {
		t.Errorf("gridIndexNext with a MinInt64 modulus = %d, want 0", got)
	}
	// Inert for every modulus a working file produces: an ordinary grid cascade is unchanged.
	for _, modulus := range []int{1, 2, 7, 16, 4096} {
		want := int(int32((uint32(int32(3))*uint32(int32(5)) + uint32(int32(2))) / uint32(int32(modulus))))
		if got := gridIndexNext(3, 5, 2, modulus); got != want {
			t.Errorf("gridIndexNext(3,5,2,%d) = %d, want %d", modulus, got, want)
		}
	}
}

// TestIterateInclusiveSpanCannotOverflowIntoANegativeCapacity covers the half of `max-min+1` that
// the inverted-range guard does not reach: max is ABOVE min here, so that test passes, and the
// subtraction overflows anyway.
func TestIterateInclusiveSpanCannotOverflowIntoANegativeCapacity(t *testing.T) {
	// Used to panic with "makeslice: cap out of range".
	if got := iterateInclusive(searchAxisRange{min: math.MinInt64, max: 0}, 1); len(got) != 0 {
		t.Errorf("an unrepresentable span must yield no positions, got %d", len(got))
	}
	if got := iterateInclusive(searchAxisRange{min: -1, max: math.MaxInt64}, -1); len(got) != 0 {
		t.Errorf("an unrepresentable span must yield no positions descending either, got %d", len(got))
	}
	// The boundary a careless fix breaks: a span of exactly MaxInt64-1 is still refused (its
	// capacity expression is MaxInt64, which allocates nothing sane), but an ordinary range and
	// the empty max==min-1 range from the earlier fix must both keep working untouched.
	if got := iterateInclusive(searchAxisRange{min: 0, max: -1}, 1); len(got) != 0 {
		t.Errorf("max == min-1 is empty, got %v", got)
	}
	if got := iterateInclusive(searchAxisRange{min: -2, max: 1}, 1); len(got) != 4 {
		t.Errorf("ascending -2..1 = %v, want 4 positions", got)
	}
	if got := iterateInclusive(searchAxisRange{min: 5, max: 5}, 1); len(got) != 1 || got[0] != 5 {
		t.Errorf("a single-position range = %v, want [5]", got)
	}
}

// TestSearchAxisWalkAllocatesNothingForAnEnormousSpan pins the change that removed the LAST way
// search_volume could crash: the walk no longer materialises the positions it visits.
//
// `{"min": [0,0,0], "max": [0,1e18,0]}` is legal, is not inverted, and does not overflow -- and it
// used to panic with "makeslice: cap out of range" before visiting a single position, because the
// old walk asked for the whole list up front. A merely-large span such as 1e9 did not panic; it
// quietly asked for 8GB. The engine holds no list at all (three nested counters over the AABB),
// so neither does this now.
//
// The test stops after one visit, which is the point: with a list this could not have returned at
// all, and without one it costs a single iteration. A span this size is still a very long WALK if
// you let it run -- that is what it is in the game too, and it is deliberately not capped here.
func TestSearchAxisWalkAllocatesNothingForAnEnormousSpan(t *testing.T) {
	visits := 0
	forEachInclusive(searchAxisRange{min: 0, max: 1_000_000_000_000_000_000}, 1, func(v int) bool {
		visits++
		if v != 0 {
			t.Errorf("first ascending visit = %d, want the range's min", v)
		}
		return false // stop -- the required_successes early-out uses this same signal
	})
	if visits != 1 {
		t.Errorf("visits = %d, want exactly 1 (the walk must stop when told to)", visits)
	}
	// Descending starts at max, and stopping early must work from that end too.
	visits = 0
	forEachInclusive(searchAxisRange{min: -1_000_000_000_000_000_000, max: 0}, -1, func(v int) bool {
		visits++
		if v != 0 {
			t.Errorf("first descending visit = %d, want the range's max", v)
		}
		return false
	})
	if visits != 1 {
		t.Errorf("descending visits = %d, want exactly 1", visits)
	}
}

// TestMalformedRangeRefusalIsReportableRatherThanAStackTrace pins the DELIVERY change on tree.go's
// four deliberate refusals. The refusal itself is unchanged -- these placements still stop, at the
// same line, under the same condition -- but they used to `panic` with a bare error, which
// session.go's recover switch re-panics, so the author got a Go stack trace instead of a sentence
// naming the field.
//
// A caller now recovers a *MalformedRangeRefusal. If this test ever fails by finding some other
// panic type, that is the regression: something started refusing without saying what it refused.
func TestMalformedRangeRefusalIsReportableRatherThanAStackTrace(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -20, MinY: 40, MinZ: -20, SizeX: 41, SizeY: 50, SizeZ: 41}
	vol := volume.New(bounds, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	for x := -20; x <= 20; x++ {
		for z := -20; z <= 20; z++ {
			for y := 40; y <= 63; y++ {
				vol.SetBlockAt(x, y, z, stone)
			}
		}
	}

	// mega_canopy.canopy_height is a Range whose LOW end is a JSON constant, so a negative min
	// reaches the refusal deterministically -- no draw can rescue it.
	subject := `{"format_version":"1.26.50","minecraft:tree_feature":{
		"description":{"identifier":"hostile:mega"},
		"mega_trunk":{"trunk_height":{"base":6,"intervals":[1]},"trunk_block":"minecraft:jungle_log",
			"trunk_width":2,"width_scale":1.0},
		"mega_canopy":{"canopy_height":-1,"core_width":2,"leaf_block":"minecraft:jungle_leaves",
			"simplify_canopy":false,"base_radius":2,"radius_step_modifier":0.3},
		"base_block":["minecraft:dirt"],"may_grow_on":["minecraft:stone"],
		"may_replace":["minecraft:air","minecraft:stone"],"may_grow_through":["minecraft:air"]}}`

	lib := BuildLibrary([]SourceFile{{ID: "s.json", AbsPath: "s.json", Text: subject}}, pal, nil)
	var feature wgen.IFeature
	for _, e := range lib.Entries {
		feature = e.Feature
	}
	if feature == nil {
		t.Fatalf("mega_canopy did not build: %v", lib.Diagnostics)
	}

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		feature.Place(&wgen.PlacementContext{
			API: vol, Origin: wgen.BlockPos{X: 0, Y: 64, Z: 0}, Random: random.New(3),
			MolangScope: wgen.NewScope(),
			Biome:       &wgen.MolangBiome{ID: "b", Tags: map[string]struct{}{}},
		})
	}()
	if recovered == nil {
		t.Fatal("a negative mega_canopy.canopy_height must still refuse the placement")
	}
	refusal, ok := recovered.(*MalformedRangeRefusal)
	if !ok {
		t.Fatalf("refusal is %T, want *MalformedRangeRefusal -- an untyped panic reaches the user "+
			"as a raw Go stack trace, which is the whole thing this fixed: %v", recovered, recovered)
	}
	if !strings.Contains(refusal.Field, "mega_canopy.canopy_height") {
		t.Errorf("refusal names %q, want the field the author has to fix", refusal.Field)
	}
	if !strings.Contains(refusal.Error(), "refuses rather than guessing") {
		t.Errorf("refusal message does not say why it refuses: %s", refusal.Error())
	}
}
