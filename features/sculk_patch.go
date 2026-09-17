// sculk_patch.go implements minecraft:sculk_patch_feature.
//
// The one draw formula this type depends on: extra_growth_chance is drawn
// with the engine's two-argument integer draw, `if (max > min) { min +=
// boundedDraw(max - min); } return min;` -- i.e. ZERO draws when max <= min,
// otherwise exactly one bounded draw of (max - min). That is a DIFFERENT
// formula from the engine's int-range draw (tree.go/vegetation_patch.go's
// min >= max-1 formula).
//
// Schema:
//
//	can_place_sculk_patch_on         array<block descriptor> REQUIRED (key must be present; the array
//	                                                          contents themselves may be empty -- see
//	                                                          "empty list" behavior below)
//	central_block                    block descriptor        optional, absent = no central block
//	central_block_placement_chance   float                   optional, validated range
//	                                                          [0.0, 1.0]; default 0.0 (NOT 1.0): the
//	                                                          schema declares no default for this
//	                                                          field, so an absent value stays at the
//	                                                          feature's zero-initialised 0.0.
//	cursor_count                     int, REQUIRED validated range [0, 32].
//	charge_amount                    int, REQUIRED range [1, 1000]
//	spread_attempts                  int, REQUIRED range [1, 4]
//	growth_rounds                    int, REQUIRED range [0, 8]
//	spread_rounds                    int, REQUIRED range [0, 8]
//	extra_growth_chance              int range ({min,max})   optional; absent -> {0,0} (zero draws, zero
//	                                                          iterations).
//
// place() algorithm, in the exact order the engine executes it:
//
//  1. Gate: the spread-source test on (api, origin). Fails (returns nil) immediately, before
//     any RNG, unless origin is air/water-source/already-sculk-or-sculk-vein AND at least one of the
//     six face neighbors (checked in this exact order: Up, Down, North, South, West, East -- Bedrock's
//     face encoding 1,0,2,3,4,5) is solid (when can_place_sculk_patch_on is an empty list) or matches
//     can_place_sculk_patch_on (when non-empty). Zero RNG.
//  2. Round loop, growth_rounds+spread_rounds iterations total: each round adds cursor_count cursors
//     (the sculk spreader's cursor seeding -- deterministic, zero RNG, just charge accounting) then,
//     if spread_attempts >= 1, runs the sculk spreader's cursor update pass spread_attempts times,
//     then always clears the cursor list. See "What refuses" -- this port only
//     implements the cursor bookkeeping (add/clear), never the update pass's cursor-movement body.
//  3. central_block gate: exactly ONE unconditional float draw, always, regardless of
//     whether central_block is even configured. If draw <= central_block_placement_chance AND
//     central_block is configured AND the block one below origin is solid, place central_block AT
//     origin.
//  4. extra_growth_chance loop: draw count with the engine's two-argument integer draw (one draw, or
//     zero if max <= min -- see the formula above). For each of `count` iterations, draw dx =
//     boundedDraw(5)-2 and dz = boundedDraw(5)-2 (TWO draws per iteration, always, in that order --
//     x then z). If the block at origin+(dx,0,dz) is air AND the block at origin+(dx,-1,dz) is solid,
//     place minecraft:sculk_shrieker with can_summon=true at origin+(dx,0,dz).
//  5. Always returns origin (a non-nil result) once past the gate in step 1 -- success/failure of the
//     individual central_block/extra_growth placements does not change the return value.
//
// What refuses, and why: the sculk spreader's cursor update pass is the
// engine's actual cursor-movement/sculk-growth simulation -- it dispatches through a charge
// cursor's update into the per-block sculk behaviour (its charge-spend and vein-spread attempts,
// and from there the multiface spreader), a block-specific behavior-polymorphism subsystem this port
// has no counterpart for at all (block.Kind only tracks air/solid/liquid/plant/glass, not "how does
// sculk grow on top of this specific block"). Porting it would require an entire per-block
// behaviour registry.
// The ONE thing that IS known cheaply: the update pass's own early-return guard
// (it returns immediately when the cursor list is empty) means it is a total, zero-RNG
// no-op whenever the spreader currently holds zero cursors. Combined with cursor seeding and reset
// being fully deterministic, this means the ENTIRE round loop is safe to run
// faithfully -- with zero risk of silently-wrong RNG -- for any combination where cursors are never
// live when the update pass is actually called. That is exactly: growth_rounds+spread_rounds == 0
// (loop never runs), OR cursor_count == 0 (no cursors ever added), OR spread_attempts == 0 (update
// pass never called). Build refuses, by name, precisely the one remaining combination
// (growth_rounds+spread_rounds >= 1 AND cursor_count >= 1 AND spread_attempts >= 1) where cursors
// would actually be live when the update pass runs -- i.e. where the missing simulation would
// actually fire.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const sculkPatchTypeID = "minecraft:sculk_patch_feature"

// sculkFacingOffsets is the six-neighbor scan order the spread-source test
// uses -- face values 1, 0, 2, 3, 4, 5 in that exact order (Bedrock's face encoding: Down=0,
// Up=1, North=2, South=3, West=4, East=5).
var sculkFacingOffsets = []wgen.BlockPos{
	{X: 0, Y: 1, Z: 0},  // Up (face 1) -- checked first
	{X: 0, Y: -1, Z: 0}, // Down (face 0)
	{X: 0, Y: 0, Z: -1}, // North (face 2)
	{X: 0, Y: 0, Z: 1},  // South (face 3)
	{X: -1, Y: 0, Z: 0}, // West (face 4)
	{X: 1, Y: 0, Z: 0},  // East (face 5)
}

// sculkIntRange is extra_growth_chance's JSON shape: a plain number, a
// [min, max] array, or a {min, max} object -- same accepted-forms convention
// as vegetation_patch.go's vegIntRange, applied here to a field this port
// feeds through the two-argument integer draw formula (see module
// header), not the engine's int-range draw.
type sculkIntRange struct{ min, max int }

func parseSculkIntRange(raw any, jsonPath string) (sculkIntRange, error) {
	// extra_growth_chance is an int range in the schema (the DRAW formula differs from the engine's
	// int-range draw -- see the module header -- but the JSON type does not), so it takes the
	// engine's range spelling. See parseEngineRange in shared.go.
	lo, hi, err := parseEngineRange(raw, jsonPath)
	if err != nil {
		return sculkIntRange{}, err
	}
	return sculkIntRange{min: int(lo), max: int(hi)}, nil
}

// sculkRandomNextInt mirrors the engine's two-argument integer draw exactly:
// zero draws when max <= min, otherwise exactly one
// rnd.NextIntBound(max-min) draw.
func sculkRandomNextInt(r sculkIntRange, rnd random.IRandom) int {
	if r.max <= r.min {
		return r.min // *** 0 draws ***
	}
	return r.min + rnd.NextIntBound(r.max-r.min) // *** RNG CALL ***
}

// SculkPatchFeature is minecraft:sculk_patch_feature. A leaf type -- no
// feature delegation, so it is always in scope.
type SculkPatchFeature struct {
	identifier string

	canPlaceOn block.MatchSet // predicate position -- empty list means "any solid neighbor"

	hasCentralBlock             bool
	centralBlockID              block.ID
	centralBlockPlacementChance float64 // default 0.0, see module header

	cursorCount    int
	chargeAmount   int
	spreadAttempts int
	growthRounds   int
	spreadRounds   int

	hasExtraGrowthChance bool
	extraGrowthChance    sculkIntRange

	sculkShriekerCanSummonID block.ID
}

func (f *SculkPatchFeature) TypeID() string     { return sculkPatchTypeID }
func (f *SculkPatchFeature) Identifier() string { return f.identifier }

// canSpreadFrom mirrors the sculk-patch feature's spread-source test
// exactly -- zero RNG. See module header step 1.
func (f *SculkPatchFeature) canSpreadFrom(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	pal := api.Palette()
	origin := api.GetBlock(pos)
	originName := pal.NameOf(origin)
	// isSculkOrSculkVein / isWaterSource have no dedicated Kind in this
	// port's simplified palette (block/kind.go only tracks
	// air/solid/liquid/plant/glass) -- approximated by canonical name,
	// consistent with this codebase's existing approximation precedent
	// (e.g. tree.go's isValidTreePosition air-fallback).
	isSculkOrVein := originName == "minecraft:sculk" || originName == "minecraft:sculk_vein"
	if !isSculkOrVein && !pal.IsAir(origin) && originName != "minecraft:water" {
		return false
	}
	for _, off := range sculkFacingOffsets {
		neighbor := wgen.BlockPos{X: pos.X + off.X, Y: pos.Y + off.Y, Z: pos.Z + off.Z}
		nb := api.GetBlock(neighbor)
		if f.canPlaceOn.Empty() {
			if pal.IsSolid(nb) {
				return true
			}
		} else if f.canPlaceOn.Contains(nb) {
			return true
		}
	}
	return false
}

// Place mirrors the sculk-patch feature's placement step-by-step --
// see module header for the full algorithm and exactly what "What refuses"
// covers.
func (f *SculkPatchFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, sculkPatchTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	// Step 1: gate. Zero RNG.
	if !f.canSpreadFrom(api, origin) {
		LogFailure(ctx, sculkPatchTypeID, "Could not place sculk patch")
		return nil
	}

	// Step 2: round loop -- cursor bookkeeping only (the sculk spreader's
	// cursor seeding and cursor reset are both deterministic). The
	// RNG-drawing cursor-movement body (its cursor update pass) is
	// never reachable here: buildSculkPatchFeature already refused at
	// build time any configuration where it would ever see a live
	// cursor -- see module header's "What refuses". With that guarantee
	// in place, the round loop itself has no further observable effect
	// (no RNG, no writes), so it is not reproduced as an actual loop
	// here -- cursorCount/chargeAmount/growthRounds/spreadRounds/
	// spreadAttempts are validated at build time (schema bounds) and
	// used only by that refusal check.

	// Step 3: central_block gate -- ONE unconditional float draw,
	// always, regardless of whether central_block is configured.
	roll := rnd.NextFloat() // *** RNG CALL (always) ***
	if roll <= f.centralBlockPlacementChance && f.hasCentralBlock {
		below := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
		if api.Palette().IsSolid(api.GetBlock(below)) {
			api.SetBlock(origin, f.centralBlockID)
		}
	}

	// Step 4: extra_growth_chance loop.
	extraRange := sculkIntRange{} // {0,0} default -- see module header
	if f.hasExtraGrowthChance {
		extraRange = f.extraGrowthChance
	}
	count := sculkRandomNextInt(extraRange, rnd) // *** RNG CALL (0 or 1 draw) ***
	for i := 0; i < count; i++ {
		TickDeadline("scattering the extra growths its extra_growth_chance asks for")
		dx := rnd.NextIntBound(5) - 2 // *** RNG CALL, per iteration ***
		dz := rnd.NextIntBound(5) - 2 // *** RNG CALL, per iteration ***
		candidate := wgen.BlockPos{X: origin.X + dx, Y: origin.Y, Z: origin.Z + dz}
		below := wgen.BlockPos{X: candidate.X, Y: candidate.Y - 1, Z: candidate.Z}
		if api.Palette().IsAir(api.GetBlock(candidate)) && api.Palette().IsSolid(api.GetBlock(below)) {
			api.SetBlock(candidate, f.sculkShriekerCanSummonID)
		}
	}

	// Step 5: always succeeds past the gate.
	result := origin
	return &result
}

func buildSculkPatchFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	canPlaceOnRaw, present := body["can_place_sculk_patch_on"]
	if !present {
		return nil, fmt.Errorf("can_place_sculk_patch_on is required")
	}
	canPlaceOnDescs, err := AsBlockDescriptorList(canPlaceOnRaw, "can_place_sculk_patch_on")
	if err != nil {
		return nil, err
	}
	canPlaceOn := ResolveMatchSet(canPlaceOnDescs, ctx, "can_place_sculk_patch_on")

	var hasCentralBlock bool
	var centralBlockID block.ID
	if raw, ok := body["central_block"]; ok {
		desc, err := AsBlockDescriptor(raw, "central_block")
		if err != nil {
			return nil, err
		}
		centralBlockID = ctx.Palette.Resolve(desc)
		hasCentralBlock = true
	}

	// Default 0.0 (NOT 1.0). The feature starts with every JSON-backed field
	// zero-initialised, including the chance float that place() compares its
	// draw against. Absent JSON fields keep those values, so absent chance ==
	// 0.0: the central block then places only when the float draw returns
	// exactly 0.0.
	centralBlockPlacementChance := 0.0
	if raw, ok := body["central_block_placement_chance"]; ok {
		v, ok := toFloat(raw)
		if !ok {
			return nil, fmt.Errorf("central_block_placement_chance must be a number")
		}
		if v < 0 || v > 1 {
			return nil, fmt.Errorf("central_block_placement_chance must be in [0, 1] (the game's own schema bound)")
		}
		centralBlockPlacementChance = v
	}

	requiredIntField := func(key string, min, max int) (int, error) {
		raw, ok := body[key]
		if !ok {
			return 0, fmt.Errorf("%s is required", key)
		}
		f, ok := toFloat(raw)
		if !ok || f != float64(int(f)) {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		v := int(f)
		if v < min || v > max {
			return 0, fmt.Errorf("%s must be in [%d, %d] (the game's own schema bound)", key, min, max)
		}
		return v, nil
	}

	cursorCount, err := requiredIntField("cursor_count", 0, 32)
	if err != nil {
		return nil, err
	}
	chargeAmount, err := requiredIntField("charge_amount", 1, 1000)
	if err != nil {
		return nil, err
	}
	spreadAttempts, err := requiredIntField("spread_attempts", 1, 4)
	if err != nil {
		return nil, err
	}
	growthRounds, err := requiredIntField("growth_rounds", 0, 8)
	if err != nil {
		return nil, err
	}
	spreadRounds, err := requiredIntField("spread_rounds", 0, 8)
	if err != nil {
		return nil, err
	}

	// Refuse, by name, the one configuration where the sculk spreader's
	// unimplemented cursor-movement/growth simulation would actually run
	// -- see module header's "What refuses".
	// spreadAttempts >= 1 is TAUTOLOGICAL here and kept only because it mirrors
	// the three-way condition in the module header: requiredIntField already bounds spread_attempts to
	// [1,4] a few lines up, so it can never be 0 by the time this runs. That is exactly why the
	// message below no longer offers "set spread_attempts=0" as a way out -- following that advice
	// produced a second, contradictory error about the [1,4] range and sent the author in a circle.
	if growthRounds+spreadRounds >= 1 && cursorCount >= 1 && spreadAttempts >= 1 {
		return nil, fmt.Errorf(
			"minecraft:sculk_patch_feature: cursor-driven spreading (growth_rounds+spread_rounds=%d, "+
				"cursor_count=%d, spread_attempts=%d, all >= 1) is not supported by this tool. Spreading "+
				"works by walking charge cursors outward and asking each block they reach how it grows, "+
				"which needs a per-block behaviour registry this tool does not have -- so it is refused "+
				"rather than approximated, because a wrong sculk patch is harder to notice than a missing "+
				"one. Set cursor_count=0, or growth_rounds=0 AND spread_rounds=0, to use the parts of "+
				"this feature that ARE supported (central_block placement, extra_growth_chance). Note that "+
				"spread_attempts is NOT a way out even though it appears in this condition: the schema "+
				"bounds it to [1,4], so 0 is refused by the field itself.",
			growthRounds+spreadRounds, cursorCount, spreadAttempts)
	}

	var hasExtraGrowthChance bool
	var extraGrowthChance sculkIntRange
	if raw, ok := body["extra_growth_chance"]; ok {
		extraGrowthChance, err = parseSculkIntRange(raw, "extra_growth_chance")
		if err != nil {
			return nil, err
		}
		hasExtraGrowthChance = true
	}

	shriekerDesc := block.Descriptor{
		Name:   "minecraft:sculk_shrieker",
		States: map[string]block.StateValue{"can_summon": true},
	}
	sculkShriekerCanSummonID := ctx.Palette.Resolve(shriekerDesc)

	return &SculkPatchFeature{
		identifier: ctx.Identifier,

		canPlaceOn: canPlaceOn,

		hasCentralBlock:             hasCentralBlock,
		centralBlockID:              centralBlockID,
		centralBlockPlacementChance: centralBlockPlacementChance,

		cursorCount:    cursorCount,
		chargeAmount:   chargeAmount,
		spreadAttempts: spreadAttempts,
		growthRounds:   growthRounds,
		spreadRounds:   spreadRounds,

		hasExtraGrowthChance: hasExtraGrowthChance,
		extraGrowthChance:    extraGrowthChance,

		sculkShriekerCanSummonID: sculkShriekerCanSummonID,
	}, nil
}

func init() {
	RegisterType(sculkPatchTypeID, buildSculkPatchFeature)
}

var _ wgen.IFeature = (*SculkPatchFeature)(nil)
