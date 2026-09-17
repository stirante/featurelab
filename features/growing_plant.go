// growing_plant.go implements minecraft:growing_plant_feature.
//
// Two shared draw helpers this type reuses:
//
//   - The game's int-range draw, the SAME one tree.go uses (see tree.go's
//     treeIntRangeValue): 0 draws when min >= max-1, else exactly one
//     nextIntBound(max-min) draw. place() uses this draw for BOTH the height
//     draw and the age draw, so treeIntRangeValue is reused directly.
//   - The game's weighted pick, at three sites in place()
//     (height_distribution, body_blocks, head_blocks), each with the
//     IDENTICAL control-flow shape ported as features.WeightedPick
//     (shared.go): sum the weights (truncating to int each step); if the sum
//     is nonzero, ONE bounded integer draw of the sum; walk the list
//     subtracting weights (truncating each step) until the running remainder
//     goes negative. See shared.go's WeightedPick doc comment (the other
//     users of that shape are SingleBlockFeature and WeightedRandomFeature).
//     It is a bounded integer draw, NOT one float draw scaled by the sum.
//
// Game version 1.26.50.24: place()'s behaviour is UNCHANGED from 1.26.40.26.
// Draw count, order and values, and every block write and its flags, are the
// same.
//
// Schema, in the order the game reports the fields (also this port's
// build-time diagnostic order):
//
//	height_distribution   array<[int range, float]> REQUIRED, min 1 entry (the same minimum
//	                                                  array size sculk_patch.go's array fields use)
//	growth_direction       string                    REQUIRED. Stored as a direction, 0 or 1, using
//	                                                  Bedrock's face encoding Down=0, Up=1 (see
//	                                                  sculk_patch.go's sculkFacingOffsets): 0 = down
//	                                                  (per-layer Y offset -i), 1 = up (+i). The
//	                                                  accepted JSON STRING values ("up"/"down") are
//	                                                  INFERRED, not confirmed -- the same kind of gap
//	                                                  as partially_exposed_blob.go's exposed_face
//	                                                  string parsing. The stored value's RUNTIME
//	                                                  MEANING is solid regardless.
//	age                     int range                 optional, default {0,0}
//	body_blocks             array<[block descriptor, float]> REQUIRED, min 1 entry
//	head_blocks             array<[block descriptor, float]> REQUIRED, min 1 entry
//	allow_water             bool                      optional, default false
//
// place() algorithm, in the exact order the game executes it:
//
//  1. Weighted-pick over height_distribution -> chosen [int range, weight] entry (0 or 1 draw,
//     via WeightedPick -- see above).
//  2. height := the int-range draw over the chosen entry's range (0 or 1 nextIntBound() draw).
//  3. age := the int-range draw over this feature's age range (0 or 1 draw) -- ALWAYS drawn,
//     unconditionally, BEFORE
//     the height<1 check below even runs. With age absent it is the 0-draw branch (age defaults to
//     {0,0}); with age configured it draws exactly like the height range does.
//  4. If height < 1: log failure ("No air or water blocks at target location" if allow_water else "No
//     air blocks at target location") and return nil. Zero further RNG or writes.
//  5. For i := 0..height-1 (growth_direction sets the per-layer Y offset: +i if up, -i if down):
//     a. pos := origin + (0, layerOffset(i), 0). positionOk := air(pos), OR water(pos) if allow_water
//     is set (see isWaterBlock in partially_exposed_blob.go -- reused directly).
//     ZERO RNG for this check.
//     b. If NOT positionOk: do nothing at this layer (no placement, no break-check) -- silently
//     continue to the next i. This is a genuine jump past both the break-check and the body-block
//     placement, reproduced exactly rather than smoothed into an early break.
//     c. If positionOk: peek nextPos := origin + (0, layerOffset(i+1), 0) (one step further,
//     air-only check, no water fallback here -- this peek never consults
//     allow_water). If i == height-1 OR nextPos is not air: this is the LAST body layer -- break
//     out of the loop with pos remembered as the head position (no body block placed at pos this
//     iteration).
//     d. Otherwise: weighted-pick over body_blocks (0 or 1 draw) and place the chosen block at pos.
//  6. Consequence of 5b/5c together, worth stating explicitly because it is easy to get backwards:
//     a SINGLE positionOk==true layer ANYWHERE in the column guarantees eventual success, because
//     step 5c's break fires unconditionally once such a layer is reached (either immediately, if
//     it's the last configured layer or the very next step is blocked, or after placing however many
//     more body blocks it takes to reach one of those two conditions). The loop can therefore only
//     run to completion WITHOUT ever breaking -- falling into the same failure this port raises
//     in step 4 -- when EVERY layer from i=0 to i=height-1 has positionOk==false: the whole
//     configured column, not just its final layer, must be unplaceable. A single obstruction
//     partway up a column that is otherwise clear does not fail the call; it gets caught by the
//     PRECEDING layer's own peek (5c) and simply ends the column one layer early, successfully.
//     Only a solid run of obstruction reaching every configured layer produces the failure return.
//  7. Otherwise (the loop broke with a remembered head position): weighted-pick over head_blocks (0
//     or 1 draw); if age's max is nonzero, inject the step-3 drawn age into the picked
//     head block's growing_plant_age state (see "Age injection" below) before placing it at the head
//     position. Returns the head position on success.
//
// Age injection: when age.max != 0, place() sets the growing_plant_age state of the picked head
// block to the drawn age. There is no modulo anywhere on this path. If drawnAge >= the state's
// value count (26 for growing_plant_age -- see block.GrowingPlantAge), or the block has no such
// state, the state write fails and place() uses the picked head block unchanged. This port
// reproduces that exactly via Palette.WithIntState (set growing_plant_age iff 0 <= drawnAge < 26,
// else keep the id as-is).
//
// The age path has no build-time restriction. Palette.WithIntState is the same bounded
// block-state derivation used by multiface_feature and geode_feature: an in-range derived state is
// interned, while an out-of-range value returns the original id unchanged. That preserves place()'s
// `state write failed ? pickedHead : result` shape without a block-name allowlist.
package features

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const growingPlantTypeID = "minecraft:growing_plant_feature"

// growingPlantHeightEntry is one height_distribution element: [int range, weight].
type growingPlantHeightEntry struct {
	min, max int
	weight   float64
}

// growingPlantBlockEntry is one body_blocks/head_blocks element: [block descriptor, weight].
type growingPlantBlockEntry struct {
	id     block.ID
	weight float64
}

// parseGrowingPlantIntRange accepts the same three shapes this codebase's other int-range-typed
// fields already accept: a plain number, a two-element array, or a
// {range_min, range_max} object.
//
// NOT {min, max}. This comment said so until it was checked against the code
// it describes: parseEngineRange rejects that spelling deliberately, because
// the engine reads only range_min/range_max and, given min/max, logs an error
// and substitutes a zero-width range -- so the file loads in game and then
// does nothing, which is the worst way for a field to be wrong.
func parseGrowingPlantIntRange(raw any, jsonPath string) (min, max int, err error) {
	lo, hi, err := parseEngineRange(raw, jsonPath)
	if err != nil {
		return 0, 0, err
	}
	return int(lo), int(hi), nil
}

func parseGrowingPlantHeightDistribution(raw any, jsonPath string) ([]growingPlantHeightEntry, error) {
	arr, ok := raw.([]any)
	if !ok || len(arr) == 0 {
		// min 1 entry -- see module header.
		return nil, fmt.Errorf("%s must be a non-empty array", jsonPath)
	}
	out := make([]growingPlantHeightEntry, len(arr))
	for i, v := range arr {
		p := fmt.Sprintf("%s[%d]", jsonPath, i)
		tuple, ok := v.([]any)
		if !ok || len(tuple) != 2 {
			return nil, fmt.Errorf("%s must be a [heightRange, weight] tuple", p)
		}
		min, max, err := parseGrowingPlantIntRange(tuple[0], p+"[0]")
		if err != nil {
			return nil, err
		}
		weight, ok := toFloat(tuple[1])
		if !ok {
			return nil, fmt.Errorf("%s[1] (weight) must be a number", p)
		}
		out[i] = growingPlantHeightEntry{min: min, max: max, weight: weight}
	}
	return out, nil
}

func parseGrowingPlantBlockList(raw any, jsonPath string, ctx *BuildContext) ([]growingPlantBlockEntry, error) {
	arr, ok := raw.([]any)
	if !ok || len(arr) == 0 {
		// min 1 entry -- see module header.
		return nil, fmt.Errorf("%s must be a non-empty array", jsonPath)
	}
	out := make([]growingPlantBlockEntry, len(arr))
	for i, v := range arr {
		p := fmt.Sprintf("%s[%d]", jsonPath, i)
		tuple, ok := v.([]any)
		if !ok || len(tuple) != 2 {
			return nil, fmt.Errorf("%s must be a [blockDescriptor, weight] tuple", p)
		}
		desc, err := AsBlockDescriptor(tuple[0], p+"[0]")
		if err != nil {
			return nil, err
		}
		weight, ok := toFloat(tuple[1])
		if !ok {
			return nil, fmt.Errorf("%s[1] (weight) must be a number", p)
		}
		out[i] = growingPlantBlockEntry{id: ctx.Palette.Resolve(desc), weight: weight}
	}
	return out, nil
}

// GrowingPlantFeature is minecraft:growing_plant_feature. A leaf type -- no
// feature delegation, so it is always in scope.
type GrowingPlantFeature struct {
	identifier string

	heightDistribution []growingPlantHeightEntry
	isUp               bool // growth_direction: true="up", false="down"
	bodyBlocks         []growingPlantBlockEntry
	headBlocks         []growingPlantBlockEntry
	allowWater         bool
	ageMin, ageMax     int            // injection gated on ageMax != 0
	pal                *block.Palette // build-time palette, for WithIntState age injection (same pattern as tree.go)
}

func (f *GrowingPlantFeature) TypeID() string     { return growingPlantTypeID }
func (f *GrowingPlantFeature) Identifier() string { return f.identifier }

// Place mirrors the growing-plant feature's placement step-by-step --
// see module header for the full algorithm.
func (f *GrowingPlantFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, growingPlantTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	pal := api.Palette()

	// Step 1: weighted pick over height_distribution. *** RNG CALL (0 or 1 draw) ***
	heightWeights := make([]float64, len(f.heightDistribution))
	for i, e := range f.heightDistribution {
		heightWeights[i] = e.weight
	}
	hIdx := WeightedPick(heightWeights, rnd)
	var hMin, hMax int
	if hIdx != -1 {
		hMin, hMax = f.heightDistribution[hIdx].min, f.heightDistribution[hIdx].max
	}
	// Step 2: height draw. *** RNG CALL (0 or 1 draw) ***
	height := treeIntRangeValue(hMin, hMax, rnd)
	// Step 3: age draw -- ALWAYS, unconditionally, before the height<1 check.
	// *** RNG CALL (0 or 1 draw) *** -- the int-range draw over this feature's
	// age range; drawn even when ageMax == 0 makes it a 0-draw call.
	age := treeIntRangeValue(f.ageMin, f.ageMax, rnd)

	// Step 4: height<1 gate.
	if height < 1 {
		if f.allowWater {
			LogFailure(ctx, growingPlantTypeID, "No air or water blocks at target location")
		} else {
			LogFailure(ctx, growingPlantTypeID, "No air blocks at target location")
		}
		return nil
	}

	layerOffset := func(i int) int {
		if f.isUp {
			return i
		}
		return -i
	}

	succeeded := false
	var headPos wgen.BlockPos
	for i := 0; i < height; i++ {
		TickDeadline("growing a column as tall as its height_distribution asks")
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + layerOffset(i), Z: origin.Z}
		positionOk := pal.IsAir(api.GetBlock(pos))
		if !positionOk && f.allowWater {
			positionOk = isWaterBlock(pal, api.GetBlock(pos))
		}
		if !positionOk {
			// Silently skip this layer -- no placement, no failure. See module
			// header step 5b: a mid-column obstruction is NOT fatal.
			continue
		}
		nextPos := wgen.BlockPos{X: origin.X, Y: origin.Y + layerOffset(i+1), Z: origin.Z}
		if i == height-1 || !pal.IsAir(api.GetBlock(nextPos)) {
			headPos = pos
			succeeded = true
			break
		}
		// *** RNG CALL (0 or 1 draw) *** -- body block weighted pick.
		bodyWeights := make([]float64, len(f.bodyBlocks))
		for j, e := range f.bodyBlocks {
			bodyWeights[j] = e.weight
		}
		if bIdx := WeightedPick(bodyWeights, rnd); bIdx != -1 {
			api.SetBlock(pos, f.bodyBlocks[bIdx].id)
		}
	}

	if !succeeded {
		// Only reachable when EVERY layer from i=0 to i=height-1 had
		// positionOk == false -- the whole configured column unplaceable, not
		// just its final layer. This comment used to say "the FINAL layer",
		// which is necessary but nowhere near sufficient, and is exactly the
		// reading module header step 6 flags as "easy to get backwards": a
		// single positionOk layer ANYWHERE guarantees eventual success,
		// because step 5c's break fires unconditionally once one is reached.
		// Any body blocks placed at earlier layers in this same call are NOT
		// rolled back.
		if f.allowWater {
			LogFailure(ctx, growingPlantTypeID, "No air or water blocks at target location")
		} else {
			LogFailure(ctx, growingPlantTypeID, "No air blocks at target location")
		}
		return nil
	}

	// *** RNG CALL (0 or 1 draw) *** -- head block weighted pick.
	headWeights := make([]float64, len(f.headBlocks))
	for j, e := range f.headBlocks {
		headWeights[j] = e.weight
	}
	if hdIdx := WeightedPick(headWeights, rnd); hdIdx != -1 {
		headID := f.headBlocks[hdIdx].id
		if f.ageMax != 0 {
			// The game: if age.max is nonzero, it sets the picked head
			// block's growing_plant_age state to the drawn age, which
			// succeeds iff value < the state's value count (26); on any
			// failure it places the picked head block UNCHANGED. WithIntState
			// reproduces exactly that: set the state key iff 0 <= age < 26,
			// else keep the id as-is.
			if withAge, ok := f.pal.WithIntState(headID, block.GrowingPlantAge, age); ok {
				headID = withAge
			}
		}
		api.SetBlock(headPos, headID)
	}

	result := headPos
	return &result
}

func buildGrowingPlantFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	heightRaw, ok := body["height_distribution"]
	if !ok {
		return nil, fmt.Errorf("height_distribution is required")
	}
	heightDistribution, err := parseGrowingPlantHeightDistribution(heightRaw, "height_distribution")
	if err != nil {
		return nil, err
	}

	dirRaw, ok := body["growth_direction"]
	if !ok {
		return nil, fmt.Errorf("growth_direction is required")
	}
	dirStr, ok := dirRaw.(string)
	if !ok {
		return nil, fmt.Errorf("growth_direction must be a string")
	}
	// CASE-INSENSITIVE. How the game parses growth_direction's string is not confirmed (see
	// this file's header) -- but the sibling single-byte face field
	// (multipart_block_column.go's `direction`) is known to go through the game's
	// enum-string parse, which LOWERCASES before matching. "Down" and "UP" therefore
	// almost certainly load in the real game, and refusing them here cost the author a hunt for
	// a problem the game does not have. Matching lowercased is the half of that finding with no
	// downside: it accepts strictly more files, and every file it newly accepts means the same
	// thing it means in game.
	var isUp bool
	switch strings.ToLower(dirStr) {
	case "up":
		isUp = true
	case "down":
		isUp = false
	default:
		// Still refused, and deliberately so -- but say what the game does, because it is NOT
		// this. If growth_direction really does go through the game's enum-string parse like
		// its sibling, an unrecognised string is silently discarded there and the field keeps its
		// default, which is 0 = "down" (that value's meaning IS confirmed;
		// the parse that feeds it is not). So the real game most likely loads this file and grows
		// the plant DOWNWARD with no message at all. This port refuses instead of silently
		// picking a direction the author did not write, because a downward plant with no
		// explanation is a worse thing to debug than this error -- and because the silent-default
		// half of the sibling's behaviour is inferred here, not confirmed.
		return nil, fmt.Errorf(`growth_direction must be "up" or "down", case-insensitive (got %q); `+
			`the real game most likely loads this file anyway and grows downward, silently -- `+
			`this port refuses rather than guess a direction you did not write`, dirStr)
	}

	// age is optional; omitting it leaves the game's range at {0,0}.
	var ageMin, ageMax int
	if ageRaw, ok := body["age"]; ok {
		var err error
		ageMin, ageMax, err = parseGrowingPlantIntRange(ageRaw, "age")
		if err != nil {
			return nil, err
		}
	}

	bodyRaw, ok := body["body_blocks"]
	if !ok {
		return nil, fmt.Errorf("body_blocks is required")
	}
	bodyBlocks, err := parseGrowingPlantBlockList(bodyRaw, "body_blocks", ctx)
	if err != nil {
		return nil, err
	}

	headRaw, ok := body["head_blocks"]
	if !ok {
		return nil, fmt.Errorf("head_blocks is required")
	}
	headBlocks, err := parseGrowingPlantBlockList(headRaw, "head_blocks", ctx)
	if err != nil {
		return nil, err
	}
	allowWater := false
	if raw, ok := body["allow_water"]; ok {
		v, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("allow_water must be a boolean")
		}
		allowWater = v
	}

	return &GrowingPlantFeature{
		identifier:         ctx.Identifier,
		heightDistribution: heightDistribution,
		isUp:               isUp,
		bodyBlocks:         bodyBlocks,
		headBlocks:         headBlocks,
		allowWater:         allowWater,
		ageMin:             ageMin,
		ageMax:             ageMax,
		pal:                ctx.Palette,
	}, nil
}

func init() {
	RegisterType(growingPlantTypeID, buildGrowingPlantFeature)
}

var _ wgen.IFeature = (*GrowingPlantFeature)(nil)
