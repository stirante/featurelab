// multipart_block_column.go implements
// minecraft:multipart_block_column_feature. This type is NEW in game version
// 1.26.50 -- it does not exist in 1.26.40 at all, so there is no older
// implementation to inherit; the tests are the only guard on it.
//
// The engine's int-range draw has IDENTICAL semantics to the helper tree.go
// already ports as treeIntRangeValue: 0 draws when min >= max-1, else the
// engine's inclusive bounded draw over min..max-1 -- i.e. min plus ONE
// bounded draw of (max-min). Reused directly.
//
// The engine's opposite-face lookup is a six-entry table: 0<->1, 2<->3,
// 4<->5.
//
// Field defaults:
//
//	tip_block / frustum_block / middle_block / base_block   block descriptors
//	height_range      an int range {min, max} of int32s -- default {-1, -1},
//	        which is ALSO the "not given" sentinel the schema's own validation
//	        tests, see "mutual exclusion" below
//	weighted_heights  a list of {value int32, weight int32} elements. The
//	        sum loop uses the weight and the pick walk uses the value.
//	        Default: empty
//	direction         a facing index -- default 1, i.e. UP
//	may_place_on      a vector of block descriptors. Default: empty
//	may_replace       a vector of block descriptors. Default: empty
//
// Schema, in declaration order, with each key's required flag:
//
//	tip_block         block descriptor            REQUIRED
//	frustum_block     block descriptor            REQUIRED
//	middle_block      block descriptor            REQUIRED
//	base_block        block descriptor            REQUIRED
//	height_range      int range                   optional, default {-1,-1}
//	weighted_heights  array of weighted choices   optional
//	direction         string                      optional, default "up"
//	may_place_on      array of block descriptors  optional
//	may_replace       array of block descriptors  optional
//
// All four block roles are required KEYS even though short columns place only
// some of them (the game changelog's "1-4 block types" describes
// placement, not the schema).
//
// weighted_heights element shape: the schema accepts a JSON object, number,
// or array per element (null and everything else rejected), but ONLY an
// object is actually read: {"value": asInt, "weight": asInt} with each
// missing key parsing as 0. A numeric or array element silently yields
// {value: 0, weight: 1}. This port
// mirrors that exactly, with a ctx.Warn so the silent degradation is at least
// visible.
//
// direction: the string is LOWERCASED and then matched exactly: "down"->0,
// "up"->1, "north"->2, "south"->3, "west"->4, "east"->5. ANY other string
// silently yields the default, 1 -- i.e. UP. This
// port mirrors the silent fallback (with a ctx.Warn).
//
// Mutual exclusion, checked after the whole object is parsed: it is
// VALUE-based, not key-presence-based -- "weighted_heights given" means the
// vector is non-empty; "height_range given" means min != -1 AND max != -1
// (both values tested against the default sentinel):
//
//	neither given -> content log "height_range or weighted_heights has to be given"
//	both given    -> content log "height_range and weighted_heights can't be given at the same time"
//
// CRUCIALLY that check only LOGS -- the parse has already succeeded and the
// feature registers and places anyway. This port therefore reports both
// diagnostics through ctx.Warn (BuildLibrary surfaces them as warnings) and
// KEEPS BUILDING, reproducing the engine's runtime behaviour for both
// degenerate configurations rather than rejecting them. An explicit
// "height_range": [-1, -1] reads as "not given", exactly as the engine reads
// it.
//
// The placement algorithm, in exact execution order:
//
//  1. may_place_on gate. anchor := the position one step from the origin
//     along the OPPOSITE of direction -- one step BEHIND the origin along the
//     growth axis. The engine's placement allow-list check is then applied to
//     that anchor against may_place_on: an EMPTY list passes unconditionally
//     (the check's first test); otherwise the block at anchor (with its
//     update_bit/persistent_bit states normalized to 0 -- see
//     "approximations" below) must match one of the descriptors, via the
//     block-descriptor list match. Failure returns no position IMMEDIATELY,
//     consuming ZERO RNG draws. The engine logs nothing; this port emits a
//     port-side LogFailure so the refusal is visible.
//  2. height draw -- ONE of two sources, never both:
//     a. weighted_heights non-empty: the engine's weighted pick. Sum ALL
//     weights with plain int32 adds -- NOT the
//     float32-truncating accumulate shared.go's WeightedPick models for
//     float-weighted fields; these weights are already ints. If sum != 0: ONE
//     bounded integer draw with the sum as its bound -- the same
//     bounded-draw convention WeightedPick already established. If sum == 0:
//     NO draw, and the walk runs as if the draw were 0. Walk: rem = draw -
//     w[0]; while rem >= 0: advance, rem -= w[i]. The picked element's VALUE
//     is the height.
//     The engine has NO bounds check on this walk -- with weights that never
//     drive rem negative (all-zero, or negatives) it reads off the end of the
//     list, which is undefined behaviour and unportable; this port fails
//     the placement with a LogFailure instead (disclosed divergence,
//     unreachable for well-formed all-positive weights).
//     b. weighted_heights empty: height = the engine's int-range draw over
//     height_range = treeIntRangeValue: 0 draws when min >= max-1, else ONE
//     bounded draw of (max-min).
//  3. may_replace scan (ZERO draws). Only when height >= 1 (both branches
//     test that before reaching the scan): for i = 0,1,2,...: pos_i := the
//     position i steps from the origin along direction; count consecutive
//     positions that pass the allow-list check against may_replace (empty
//     list = always pass); stop at the first failure or when the count
//     reaches height. n := min(count, height). NOTE the scan starts AT the
//     origin (i=0) and the engine never re-checks cells during placement.
//  4. minimum-height gate. If weighted_heights is empty: n must be >=
//     height_range.min. Otherwise: n must be >= the MINIMUM VALUE across ALL
//     weighted_heights entries -- the smallest configured height, NOT the
//     picked one. Failure returns no position (silent in the engine;
//     port-side LogFailure here).
//  5. placement (ZERO draws). Cells i = 0..n-1 at i steps from the origin
//     along direction, written unconditionally through the world API's block
//     write with update flag 2:
//     n == 1: cell 0 = tip_block
//     n == 2: cell 0 = frustum_block, cell 1 = tip_block
//     n >= 3: cell 0 = base_block, cells 1..n-3 = middle_block, cell n-2 =
//     frustum_block, cell n-1 = tip_block (the loop's selector is i+2-n:
//     0 -> frustum, 1 -> tip, else middle)
//     This is exactly the game changelog's four documented cases (1: tip; 2:
//     frustum+tip; 3: base+frustum+tip; 4+: base+middles+frustum+tip) -- the
//     game agrees with the changelog on all four.
//  6. return the cell n-1 steps from the origin along direction -- the tip
//     cell -- as the success position. QUIRK, reproduced faithfully: when
//     n < 1 the placement loop is skipped entirely but the function STILL
//     returns this position as a success -- e.g. the "neither height source
//     given" configuration (height_range {-1,-1} -> the int-range draw
//     returns -1 with 0 draws -> n = -1) places nothing and returns the
//     position 2 steps BEHIND the origin. A zero-or-negative minimum makes
//     "place nothing" a successful outcome; only the two gates in steps 1 and
//     4 can make the placement return nothing.
//
// RNG contract (the whole determinism story for this type): AT MOST ONE draw
// per placement, always a bounded int draw, always between the may_place_on
// gate and the may_replace scan --
//
//	weighted_heights: 1 bounded draw of (sum of weights) iff the int32 sum != 0, else 0
//	height_range:     1 bounded draw of (max-min) iff min < max-1, else 0
//
// Approximations (disclosed):
//   - The allow-list check normalizes the candidate block's update_bit and
//     persistent_bit states to 0 before matching. This port's MatchSet matches interned name+states IDs and has
//     no such normalization; the difference is only observable when a world
//     block differs from a listed descriptor solely in one of those two
//     states.
//   - The weighted-pick out-of-bounds walk (engine UB) fails cleanly here
//     instead; see step 2a.
package features

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const multipartBlockColumnTypeID = "minecraft:multipart_block_column_feature"

// multipartFacingOffsets is the position delta for each facing index -- this
// codebase's established Down=0/Up=1/North=2/South=3/West=4/East=5 convention
// (the same as multiface.go's multifaceFacingOffsets; direction's own
// string-to-index mapping is in the module header).
var multipartFacingOffsets = [6]wgen.BlockPos{
	{X: 0, Y: -1, Z: 0}, // Down
	{X: 0, Y: 1, Z: 0},  // Up
	{X: 0, Y: 0, Z: -1}, // North
	{X: 0, Y: 0, Z: 1},  // South
	{X: -1, Y: 0, Z: 0}, // West
	{X: 1, Y: 0, Z: 0},  // East
}

// multipartWeightedHeight is one weighted_heights element -- a weighted
// choice: {value int32, weight int32}. int32 on
// purpose: the engine's sum and walk are both 32-bit, and this port
// reproduces that arithmetic exactly (including wraparound, however
// unlikely).
type multipartWeightedHeight struct {
	value  int32
	weight int32
}

// MultipartBlockColumnFeature is minecraft:multipart_block_column_feature. A
// leaf type -- no feature delegation, so it is always in scope.
type MultipartBlockColumnFeature struct {
	identifier string

	tipBlock     block.ID
	frustumBlock block.ID
	middleBlock  block.ID
	baseBlock    block.ID

	hrMin, hrMax    int32 // height_range; engine default {-1,-1}
	weightedHeights []multipartWeightedHeight

	direction int // facing byte; engine default 1 (up)

	mayPlaceOn block.MatchSet // empty = allow any
	mayReplace block.MatchSet // empty = allow any
}

func (f *MultipartBlockColumnFeature) TypeID() string     { return multipartBlockColumnTypeID }
func (f *MultipartBlockColumnFeature) Identifier() string { return f.identifier }

// multipartPasses is the engine's placement allow-list check: an empty
// list passes anything; otherwise the block at pos must match. (The engine's
// update_bit/persistent_bit normalization is a disclosed approximation gap --
// see module header.)
func multipartPasses(ms block.MatchSet, api wgen.BlockWorld, pos wgen.BlockPos) bool {
	if ms.Empty() {
		return true
	}
	return ms.Contains(api.GetBlock(pos))
}

// multipartRoleBlock returns the block for cell i of an n-cell column --
// the game's own two selections (one for cell 0, one inside the loop on
// the selector i+2-n), exactly:
//
//	n == 1                ->  tip
//	n == 2                ->  frustum, tip
//	n >= 3                ->  base, middle*, frustum (i = n-2), tip (i = n-1)
func (f *MultipartBlockColumnFeature) multipartRoleBlock(i, n int) block.ID {
	switch {
	case n == 1:
		return f.tipBlock
	case n == 2:
		if i == 0 {
			return f.frustumBlock
		}
		return f.tipBlock
	case i == 0:
		return f.baseBlock
	case i == n-1:
		return f.tipBlock
	case i == n-2:
		return f.frustumBlock
	default:
		return f.middleBlock
	}
}

// Place mirrors the multipart block column feature's placement step
// by step -- see module header for the full algorithm.
func (f *MultipartBlockColumnFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, multipartBlockColumnTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	dirOff := multipartFacingOffsets[f.direction]
	cell := func(i int) wgen.BlockPos {
		return wgen.BlockPos{X: origin.X + i*dirOff.X, Y: origin.Y + i*dirOff.Y, Z: origin.Z + i*dirOff.Z}
	}

	// Step 1: may_place_on gate one step from the origin along the OPPOSITE
	// of direction = one step BEHIND origin. ZERO draws on failure -- the
	// engine bails before any RNG. The engine logs nothing here; the
	// LogFailure below is this port's own diagnostic surface.
	if !multipartPasses(f.mayPlaceOn, api, cell(-1)) {
		LogFailure(ctx, multipartBlockColumnTypeID, "Placement surface is not in may_place_on")
		return nil
	}

	// Step 2: height draw -- weighted_heights when non-empty, else height_range.
	var height int
	if len(f.weightedHeights) > 0 {
		// The engine's weighted pick: a plain int32 weight sum,
		// NOT shared.go's float32-truncating WeightedPick accumulate --
		// these weights are ints.
		sum := int32(0)
		for _, e := range f.weightedHeights {
			sum += e.weight
		}
		draw := int32(0)
		if sum != 0 {
			// *** RNG CALL *** the engine's bounded integer draw, with the
			// sum as its bound. The ONLY possible draw on this path.
			draw = int32(rnd.NextIntBound(int(sum)))
		}
		// Walk: rem = draw - w[0]; while rem >= 0 advance.
		idx := 0
		rem := draw - f.weightedHeights[0].weight
		for rem >= 0 {
			idx++
			if idx >= len(f.weightedHeights) {
				// Engine UB: the engine's walk has no bounds check and would
				// read past the list (only reachable with zero/negative
				// weights). Fail cleanly instead -- disclosed divergence.
				LogFailure(ctx, multipartBlockColumnTypeID,
					"weighted_heights weights never select an entry (zero or negative weights)")
				return nil
			}
			rem -= f.weightedHeights[idx].weight
		}
		height = int(f.weightedHeights[idx].value)
	} else {
		// *** RNG CALL (0 or 1 draws) *** the engine's int-range draw --
		// the same thing tree.go's treeIntRangeValue already ports.
		height = treeIntRangeValue(int(f.hrMin), int(f.hrMax), rnd)
	}

	// Step 3: may_replace scan -- count consecutive passing cells from the
	// origin along direction, capped at height. Runs only when height >= 1
	// (both branches test that before reaching the scan). ZERO draws.
	clear := 0
	if height >= 1 {
		for i := 0; ; i++ {
			// The cheapest hang in the package before this tick existed: with may_replace
			// omitted, multipartPasses returns true without even reading the world, so this
			// counts to height with no write, no draw and no delegation for any budget to see.
			TickDeadline("scanning a column as tall as its height_range asks")
			if !multipartPasses(f.mayReplace, api, cell(i)) {
				break
			}
			clear++
			if clear == height {
				break
			}
		}
	}
	// n = min(clear, height). With height < 1 this is height itself
	// (clear stayed 0).
	n := clear
	if n >= height {
		n = height
	}

	// Step 4: minimum-height gate. Weighted path: the minimum over ALL
	// configured values, not the picked one. Plain path: height_range.min.
	// The engine fails silently here.
	if len(f.weightedHeights) > 0 {
		minVal := f.weightedHeights[0].value
		for _, e := range f.weightedHeights[1:] {
			if e.value < minVal {
				minVal = e.value
			}
		}
		if int32(n) < minVal {
			LogFailure(ctx, multipartBlockColumnTypeID,
				"Column is blocked before reaching the smallest weighted_heights value")
			return nil
		}
	} else {
		if int32(n) < f.hrMin {
			LogFailure(ctx, multipartBlockColumnTypeID,
				"Column is blocked before reaching the height_range minimum")
			return nil
		}
	}

	// Step 5: place cells 0..n-1 (skipped entirely when n < 1). Writes are
	// unconditional; every cell already passed the may_replace scan above.
	// ZERO draws.
	for i := 0; i < n; i++ {
		api.SetBlock(cell(i), f.multipartRoleBlock(i, n))
	}

	// Step 6: success position = the tip cell, n-1 steps from the origin
	// along direction -- returned even when n < 1 placed nothing (see module
	// header).
	result := cell(n - 1)
	return &result
}

// parseMultipartWeightedHeights parses the weighted_heights array -- see the
// module header for each accepted element shape and its exact engine
// result.
func parseMultipartWeightedHeights(raw any, ctx *BuildContext) ([]multipartWeightedHeight, error) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("weighted_heights must be an array")
	}
	out := make([]multipartWeightedHeight, 0, len(arr))
	for i, v := range arr {
		p := fmt.Sprintf("weighted_heights[%d]", i)
		switch e := v.(type) {
		case map[string]any:
			// {"value": int, "weight": int} -- each missing/non-numeric key
			// parses as 0.
			entry := multipartWeightedHeight{value: 0, weight: 0}
			if rawValue, ok := e["value"]; ok {
				if num, ok := toFloat(rawValue); ok {
					entry.value = int32(num)
				}
			}
			if rawWeight, ok := e["weight"]; ok {
				if num, ok := toFloat(rawWeight); ok {
					entry.weight = int32(num)
				}
			}
			out = append(out, entry)
		case float64, []any:
			// The element schema accepts numbers and arrays, but the parser
			// reads nothing from them: the element becomes {value: 0, weight: 1}. Mirrored exactly, with a warning
			// because it is almost certainly not what the author meant.
			ctx.Warn(fmt.Sprintf(
				"%s (%s): a weighted_heights entry must be a {\"value\", \"weight\"} object; this %T "+
					"element parses as {value: 0, weight: 1}, exactly as the engine would read it",
				ctx.Identifier, p, v))
			out = append(out, multipartWeightedHeight{value: 0, weight: 1})
		default:
			// null/string/bool fail the element schema outright in the engine.
			return nil, fmt.Errorf("%s must be a {\"value\", \"weight\"} object", p)
		}
	}
	return out, nil
}

func buildMultipartBlockColumnFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	// The four block roles: all REQUIRED keys (see module header), resolved
	// at build time like every other producing position in this package --
	// Palette.Resolve stands in for the engine's block-descriptor resolution
	// with its unknown-block fallback.
	resolveRole := func(key string) (block.ID, error) {
		raw, ok := body[key]
		if !ok {
			return 0, fmt.Errorf("%s is required", key)
		}
		desc, err := AsBlockDescriptor(raw, key)
		if err != nil {
			return 0, err
		}
		return ctx.Palette.Resolve(desc), nil
	}
	tipBlock, err := resolveRole("tip_block")
	if err != nil {
		return nil, err
	}
	frustumBlock, err := resolveRole("frustum_block")
	if err != nil {
		return nil, err
	}
	middleBlock, err := resolveRole("middle_block")
	if err != nil {
		return nil, err
	}
	baseBlock, err := resolveRole("base_block")
	if err != nil {
		return nil, err
	}

	// height_range: an optional int range, engine default
	// {-1,-1} -- which doubles as the validation's "not given" sentinel.
	hrMin, hrMax := int32(-1), int32(-1)
	if raw, ok := body["height_range"]; ok {
		min, max, err := parseGrowingPlantIntRange(raw, "height_range")
		if err != nil {
			return nil, err
		}
		hrMin, hrMax = int32(min), int32(max)
	}

	var weightedHeights []multipartWeightedHeight
	if raw, ok := body["weighted_heights"]; ok {
		weightedHeights, err = parseMultipartWeightedHeights(raw, ctx)
		if err != nil {
			return nil, err
		}
	}

	// Mutual exclusion -- the post-parse check, VALUE-based
	// (see module header). The engine content-logs and keeps the feature, so
	// this port warns and keeps building; both messages verbatim.
	if len(weightedHeights) == 0 {
		// `||`, not `&&`. This file's own header states the rule the engine applies: "height_range
		// given" means min != -1 AND max != -1 (BOTH values tested against the default
		// sentinel), so
		// "not given" negates to min == -1 OR max == -1. The `&&` that used to stand here made a
		// half-sentinel range like [-1, 7] read as "given" and pass in silence, where the engine
		// content-logs it. Diagnostic only: the engine logs and keeps the feature either way, and
		// so does this port.
		if hrMin == -1 || hrMax == -1 {
			ctx.Warn("height_range or weighted_heights has to be given")
		}
	} else if hrMin != -1 && hrMax != -1 {
		ctx.Warn("height_range and weighted_heights can't be given at the same time")
	}

	// direction: optional string, default up. The engine
	// lowercases first, and unrecognized strings silently fall back to the
	// default.
	direction := 1
	if raw, ok := body["direction"]; ok {
		s, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("direction must be a string")
		}
		switch strings.ToLower(s) {
		case "down":
			direction = 0
		case "up":
			direction = 1
		case "north":
			direction = 2
		case "south":
			direction = 3
		case "west":
			direction = 4
		case "east":
			direction = 5
		default:
			// Engine: silent fallback to the default (up). Warn so the typo
			// is at least visible.
			ctx.Warn(fmt.Sprintf(
				"%s (direction): %q is not one of down/up/north/south/west/east -- the engine "+
					"silently uses the default \"up\", and so does this tool",
				ctx.Identifier, s))
		}
	}

	// may_place_on / may_replace: optional arrays of block descriptors (array-
	// only schema, the rule for predicate lists -- see shared.go's
	// AsBlockDescriptorOrList doc comment). Empty/absent =
	// allow anything (the allow-list check's own first test).
	mayPlaceOnDescs, err := AsBlockDescriptorList(body["may_place_on"], "may_place_on")
	if err != nil {
		return nil, err
	}
	mayReplaceDescs, err := AsBlockDescriptorList(body["may_replace"], "may_replace")
	if err != nil {
		return nil, err
	}

	return &MultipartBlockColumnFeature{
		identifier:      ctx.Identifier,
		tipBlock:        tipBlock,
		frustumBlock:    frustumBlock,
		middleBlock:     middleBlock,
		baseBlock:       baseBlock,
		hrMin:           hrMin,
		hrMax:           hrMax,
		weightedHeights: weightedHeights,
		direction:       direction,
		mayPlaceOn:      ResolveMatchSet(mayPlaceOnDescs, ctx, "may_place_on"),
		mayReplace:      ResolveMatchSet(mayReplaceDescs, ctx, "may_replace"),
	}, nil
}

func init() {
	RegisterType(multipartBlockColumnTypeID, buildMultipartBlockColumnFeature)
}

var _ wgen.IFeature = (*MultipartBlockColumnFeature)(nil)
