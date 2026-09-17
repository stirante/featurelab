// vegetation_patch.go implements minecraft:vegetation_patch_feature.
//
// Behaviour points that are easy to get wrong, each cited at its own site
// below:
//  1. The placement passes horizontal_radius + 1 to the ground-patch
//     placement, twice.
//  2. The list the vegetation grows from holds the GROUND cell, one step
//     below the air cell the column walk stops in -- and the depth fill
//     starts there too. Using the air cell for both would make a `depth: 1`
//     patch write ground_block into the air above the ground and grow its
//     vegetation one block too high.
//  3. `depth: 0` still contributes the column. The zero-depth case skips
//     the fill loop and goes straight to the push; requiring a written cell
//     would drop every column of a `depth: 0` patch.
//  4. The column walk has a SECOND phase that climbs back out of solid
//     ground, and its surface test is the block's support test, not "not air".
//
// surface: "floor" and "ceiling" are both implemented:
//   - The surface value maps to an int: "floor" -> 1, "ceiling" -> 0 (i.e.
//     the surface's own facing: Up=1 / Down=0), and the game content-logs
//     "Bad value for surface - should be 'ceiling' or 'floor'" otherwise.
//   - The direction used is the opposite face of (sel == 0 ? 1 : 0), with
//     the opposite-face table [1,0,3,2,5,4], which nets out to
//     floor(sel=1) -> dir 1 (Up), ceiling(sel=0) -> dir 0 (Down). Both the
//     placement and the ground-patch placement compute the SAME thing.
//   - The Y step applied is the per-face Y step {-1,+1,0,0,0,0}: floor steps
//     +1, ceiling steps -1 (the placement computes y-1+step at the vegetation
//     offset).
//   - Implementation strategy: this port collapses the "sel -> dir -> Y step"
//     indirection into a single signed surfaceDir int (+1 for floor, -1 for
//     ceiling), computed once at build time. surfaceDir *is* that Y step --
//     for floor (dir=Up=1) it is +1, for ceiling (dir=Down=0) it is -1 (see
//     placeGroundPatch/Place below: every Y computation multiplies by
//     surfaceDir). The ground-below-scan direction, the depth-fill direction
//     (into the solid anchor block) and the vegetation-growth direction all
//     mirror through surfaceDir together, matching the game's single shared
//     selector.
//
// The int-range draw (vegIntRangeValue): over (min,max) it returns min with
// 0 draws when min >= max-1, else min + a bounded draw of (max-min), i.e.
// uniform over [min, max-1] -- max is EXCLUSIVE. (It is the inclusive bounded
// draw over (min, max-1), which is `a + a bounded draw of (b-a+1)`, one
// bounded draw; b < a returns a without drawing.) The int-range parse stores
// JSON min/max verbatim (scalar -> {v,v}, [a,b] arrays,
// {"range_min","range_max"} objects; swaps if reversed), so no hidden +1
// exists at parse time either. The golden digest is only a self-consistency
// baseline (see goldentest/golden_test.go's header), so it does not validate
// this formula against the game; the tests do. tree.go's treeIntRangeValue
// uses the same formula.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const vegetationPatchTypeID = "minecraft:vegetation_patch_feature"

// vegIntRange is the depth/horizontal_radius field shape: a plain number,
// [min, max] array, or {min, max} object -- all normalize to an inclusive
// int range.
type vegIntRange struct{ min, max int }

func parseVegIntRange(raw any, jsonPath string) (vegIntRange, error) {
	// depth and horizontal_radius are int-range fields (vegIntRangeValue mirrors
	// the engine's int-range draw), so they take the engine's range spelling -- see parseEngineRange in
	// shared.go for why {min, max} is refused rather than silently accepted.
	lo, hi, err := parseEngineRange(raw, jsonPath)
	if err != nil {
		return vegIntRange{}, err
	}
	return vegIntRange{min: int(lo), max: int(hi)}, nil
}

// vegIntRangeValue mirrors the engine's int-range draw -- see module header.
// min >= max-1 returns min with zero draws; otherwise one bounded draw of
// (max-min), uniform over [min, max-1] (max EXCLUSIVE). The tests in
// vegetation_patch_test.go pin both branches.
func vegIntRangeValue(r vegIntRange, rnd random.IRandom) int {
	if r.min >= r.max-1 {
		return r.min // *** 0 draws ***
	}
	// *** RNG CALL *** -- see header. One bounded
	// draw of (max-min); uniform over [min, max-1] (max EXCLUSIVE).
	return r.min + rnd.NextIntBound(r.max-r.min)
}

type vegGroundCell struct{ pos wgen.BlockPos }

// VegetationPatchFeature is minecraft:vegetation_patch_feature.
type VegetationPatchFeature struct {
	identifier            string
	replaceableIDs        block.MatchSet
	groundBlockID         block.ID
	vegetationFeatureRef  string
	depth                 vegIntRange
	extraDeepBlockChance  float64
	verticalRange         int
	vegetationChance      float64
	horizontalRadius      vegIntRange
	extraEdgeColumnChance float64
	waterlogged           bool
	// surfaceDir mirrors the engine's per-face Y step for this feature's
	// "surface" selector -- see module header. +1 for "floor" (ground is found by
	// scanning downward, vegetation grows upward), -1 for "ceiling"
	// (ground is found by scanning upward, vegetation grows downward).
	surfaceDir int
	resolver   wgen.IFeatureResolver
}

func (f *VegetationPatchFeature) TypeID() string     { return vegetationPatchTypeID }
func (f *VegetationPatchFeature) Identifier() string { return f.identifier }

// FeatureRefs exposes the single delegated feature reference for the static
// delegation-chain walk.
func (f *VegetationPatchFeature) FeatureRefs() []string { return []string{f.vegetationFeatureRef} }

// placeGroundPatch mirrors the vegetation-patch feature's ground-patch
// placement -- it builds the list of ground cells the
// vegetation loop in Place will iterate. spanX/spanZ are the placement
// placement's own two arguments, NOT the raw horizontal_radius draws: see Place
// for the +1.
//
// The fields it reads are the surface selector, the depth int range,
// extra_deep_block_chance, vertical_range, vegetation_chance, the
// horizontal_radius int range, extra_edge_column_chance, waterlogged, the
// replaceable_blocks list and the ground_block descriptor.
//
// The column walk is TWO loops, not one:
// descend while the cell is air, up to vertical_range steps; then, if the
// cell it stopped on is NOT air, ascend the other way while the cell is not
// air, again up to vertical_range steps. The second phase is what lets an
// origin buried inside the ground still find the surface above it.
//
// The surface test is the block's support test, asked about the descend
// direction for any support type, on the cell one step FURTHER
// in that direction -- plus the block's air test on the cell itself. It is
// not a solidity test; block.CanProvideSupport is this codebase's model of
// it.
func (f *VegetationPatchFeature) placeGroundPatch(ctx *wgen.PlacementContext, spanX, spanZ int) []vegGroundCell {
	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	pal := api.Palette()
	// dir is the engine's per-face Y step for the opposite of the surface
	// selector -- +1 for floor, -1 for ceiling; it is the direction the
	// VEGETATION grows. scanStep is its negation, the direction the column
	// walk descends and the depth fill runs.
	dir := f.surfaceDir
	scanStep := -dir
	// The face the ground block is asked about is the engine's own `dir`:
	// Up for a floor patch, Down for a ceiling one.
	surfaceFace := block.FaceUp
	if dir < 0 {
		surfaceFace = block.FaceDown
	}
	isAir := func(p wgen.BlockPos) bool { return pal.IsAir(api.GetBlock(p)) }

	// A negative span, on either axis, skips the whole walk and yields an
	// empty patch -- the engine tests the sign bit of each before entering.
	if spanX < 0 || spanZ < 0 {
		return nil
	}

	var cells []vegGroundCell
	for dx := -spanX; dx <= spanX; dx++ {
		xEdge := dx == -spanX || dx == spanX
		for dz := -spanZ; dz <= spanZ; dz++ {
			TickDeadline("walking the patch its horizontal_radius covers")
			zEdge := dz == -spanZ || dz == spanZ
			if xEdge && zEdge {
				continue // corner -- always trimmed, NO RNG
			}
			if xEdge != zEdge {
				// single-edge cell. The engine's own guard is an exact
				// compare against zero, so a NEGATIVE
				// extra_edge_column_chance still spends a draw here (and
				// then always skips).
				if f.extraEdgeColumnChance == 0 {
					continue
				}
				// *** RNG CALL ***
				if rnd.NextFloat() > f.extraEdgeColumnChance {
					continue
				}
			}

			pos := wgen.BlockPos{X: origin.X + dx, Y: origin.Y, Z: origin.Z + dz}
			// Phase 1: descend while air. The
			// counter starts at 1 and is compared BEFORE its increment, so
			// the walk takes between 1 and vertical_range steps.
			if isAir(pos) && f.verticalRange > 0 {
				for n := 1; ; n++ {
					TickDeadline("walking a column as far as its vertical_range asks")
					pos.Y += scanStep
					if !isAir(pos) || n >= f.verticalRange {
						break
					}
				}
			}
			// Phase 2: if that landed inside solid
			// ground, walk back the other way while NOT air.
			if !isAir(pos) && f.verticalRange >= 1 {
				for n := 1; ; n++ {
					TickDeadline("walking a column back out of the ground its vertical_range asks about")
					pos.Y -= scanStep
					if isAir(pos) || n >= f.verticalRange {
						break
					}
				}
			}

			// groundPos is the cell one step further in the descend
			// direction -- the block that has to support the
			// patch, the first cell the depth fill writes, and the cell
			// that goes into the list. `pos` itself stays air and is where
			// Place's vegetation goes.
			groundPos := wgen.BlockPos{X: pos.X, Y: pos.Y + scanStep, Z: pos.Z}
			groundBlk := api.GetBlock(groundPos)
			if !isAir(pos) {
				continue // ran out of vertical_range inside solid ground
			}
			if !block.CanProvideSupport(pal.NameOf(groundBlk), pal.StatesOf(groundBlk), surfaceFace) {
				continue
			}

			// *** RNG, only when extra_deep_block_chance > 0 *** -- adds one
			// extra depth step.
			extraDeep := 0
			if f.extraDeepBlockChance > 0 && rnd.NextFloat() < f.extraDeepBlockChance {
				extraDeep = 1
			}
			// *** RNG (possibly), see vegIntRangeValue *** -- a
			// single-value depth draws nothing.
			depthCount := vegIntRangeValue(f.depth, rnd) + extraDeep
			if depthCount < 0 {
				// DIVERGENCE, deliberate. The engine treats this as an
				// invalid range and then
				// enters the fill loop anyway with a negative bound, whose
				// termination test can never fire -- it runs
				// until a non-replaceable block stops it. Refusing the
				// column instead is this bench's existing guard and is kept.
				continue
			}

			wrote := 0
			skip := false
			for i := 0; i < depthCount; i++ {
				TickDeadline("filling a column as deep as its extra_deep_block_chance/depth asks")
				cellPos := wgen.BlockPos{X: groundPos.X, Y: groundPos.Y + i*scanStep, Z: groundPos.Z}
				blk := api.GetBlock(cellPos)
				if blk == f.groundBlockID {
					wrote++
					continue
				}
				if f.replaceableIDs.Contains(blk) {
					api.SetBlock(cellPos, f.groundBlockID)
					wrote++
					continue
				}
				// non-replaceable, non-ground block -- stop the depth walk.
				// The column is dropped ONLY if this break happened on the
				// very first cell. A partially filled column still counts.
				skip = wrote == 0
				break
			}
			if skip {
				continue
			}
			// Reached by the completed loop AND by depthCount == 0, which
			// jumps straight to this push. A patch
			// with depth 0 therefore writes no ground at all and still
			// grows vegetation on every column it found.
			cells = append(cells, vegGroundCell{pos: groundPos})
		}
	}
	return cells
}

// Place mirrors the vegetation-patch feature's placement.
func (f *VegetationPatchFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, vegetationPatchTypeID)
	defer profiler.PopFeatureFrame()

	// *** RNG CALLS *** -- horizontal_radius sampled TWICE, independently (X
	// then Z), from the horizontal_radius int range. Each draw is passed on
	// PLUS ONE. The
	// patch a file asks for is therefore (2*radius+3) columns on a side, not
	// (2*radius+1), and its outermost ring is the one extra_edge_column_chance
	// gates -- so `horizontal_radius: 0` is still a 3x3 patch with a single
	// ungated centre column.
	radiusX := vegIntRangeValue(f.horizontalRadius, ctx.Random)
	radiusZ := vegIntRangeValue(f.horizontalRadius, ctx.Random)

	// waterlogged: true -- DIVERGENCE, deliberate. The discard is at the BOTTOM of the ground-patch
	// placement, not the top: the engine walks the whole patch first,
	// spending every extra-edge/extra-deep/depth draw and writing every
	// ground block, and only then hands the collected positions to its
	// water-on-surface pass and frees them.
	// What it returns after that is genuinely INDETERMINATE -- that branch
	// has no defined result, unlike the non-waterlogged one. This port keeps
	// its "no cells" reading because there is no defined answer to match, but the two draws above now happen
	// either way, and the ground writes and per-column draws it still skips
	// are recorded in the coverage note rather than modelled.
	if f.waterlogged {
		LogFailure(ctx, vegetationPatchTypeID, "Vegetation could not be placed")
		return nil
	}

	cells := f.placeGroundPatch(ctx, radiusX+1, radiusZ+1)
	if len(cells) == 0 {
		LogFailure(ctx, vegetationPatchTypeID, "Vegetation could not be placed")
		return nil
	}
	if !IsAllowedToPlaceFeature(f) {
		LogFailure(ctx, vegetationPatchTypeID, "Cannot place internal feature")
		return nil
	}
	target := f.resolver.Resolve(f.vegetationFeatureRef)

	for _, cell := range cells {
		// *** RNG CALL, per ground cell *** -- vegetation_chance <= 0 never
		// draws.
		if f.vegetationChance > 0 && ctx.Random.NextFloat() < f.vegetationChance && target != nil {
			// vegPos.Y = cell.pos.Y + surfaceDir, the engine's own per-face
			// Y step added to the ground row: +1 (floor, grows upward away
			// from the ground) or -1 (ceiling, grows downward away from the
			// ceiling). cell.pos is the GROUND cell, so this lands on the air
			// cell the column walk stopped in. (The engine's waterlogged
			// variant subtracts one more first; unreachable here -- see the
			// waterlogged note above.)
			vegPos := wgen.BlockPos{X: cell.pos.X, Y: cell.pos.Y + f.surfaceDir, Z: cell.pos.Z}
			subCtx := ctx.WithOrigin(vegPos)
			// Result intentionally ignored -- every kept cell always
			// attempts placement, matching this codebase's "run everything"
			// shape (see header).
			WithRecursionGuard(f, func() *wgen.BlockPos { return target.Place(subCtx) })
		}
	}

	last := cells[len(cells)-1].pos
	result := last
	return &result
}

func buildVegetationPatchFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	replaceableDescs, err := AsBlockDescriptorList(body["replaceable_blocks"], "replaceable_blocks")
	if err != nil {
		return nil, err
	}
	if len(replaceableDescs) == 0 {
		return nil, fmt.Errorf("replaceable_blocks must be a non-empty array")
	}
	replaceableIDs := ResolveMatchSet(replaceableDescs, ctx, "replaceable_blocks")

	groundBlockRaw, ok := body["ground_block"]
	if !ok {
		return nil, fmt.Errorf("ground_block is required")
	}
	groundDesc, err := AsBlockDescriptor(groundBlockRaw, "ground_block")
	if err != nil {
		return nil, err
	}
	groundBlockID := ctx.Palette.Resolve(groundDesc)

	vegRef, ok := body["vegetation_feature"].(string)
	if !ok || vegRef == "" {
		return nil, fmt.Errorf("vegetation_feature must be a non-empty feature reference string")
	}

	depthRaw, ok := body["depth"]
	if !ok {
		return nil, fmt.Errorf("depth is required")
	}
	depth, err := parseVegIntRange(depthRaw, "depth")
	if err != nil {
		return nil, err
	}

	hrRaw, ok := body["horizontal_radius"]
	if !ok {
		return nil, fmt.Errorf("horizontal_radius is required")
	}
	horizontalRadius, err := parseVegIntRange(hrRaw, "horizontal_radius")
	if err != nil {
		return nil, err
	}

	verticalRangeF, ok := toFloat(body["vertical_range"])
	if !ok || verticalRangeF < 1 {
		return nil, fmt.Errorf("vertical_range must be a number >= 1")
	}

	surfaceRaw := body["surface"]
	if surfaceRaw == nil {
		surfaceRaw = "floor"
	}
	// surfaceDir mirrors the engine's per-face Y step for the
	// "floor"/"ceiling" selector -- see module header (the surface value, the
	// opposite-face table and the per-face Y step). Any other value matches the engine's own content-log diagnostic
	// ("Bad value for surface - should be 'ceiling' or 'floor').
	var surfaceDir int
	switch surfaceRaw {
	case "floor":
		surfaceDir = 1
	case "ceiling":
		surfaceDir = -1
	default:
		return nil, fmt.Errorf("vegetation_patch_feature: surface %#v is not supported (should be 'ceiling' or 'floor')", surfaceRaw)
	}

	extraDeepBlockChance := 0.0
	if v, ok := toFloat(body["extra_deep_block_chance"]); ok {
		extraDeepBlockChance = v
	}
	vegetationChance := 0.0
	if v, ok := toFloat(body["vegetation_chance"]); ok {
		vegetationChance = v
	}
	extraEdgeColumnChance := 0.0
	if v, ok := toFloat(body["extra_edge_column_chance"]); ok {
		extraEdgeColumnChance = v
	}
	waterlogged := jsonTruthy(body["waterlogged"])

	return &VegetationPatchFeature{
		identifier:            ctx.Identifier,
		replaceableIDs:        replaceableIDs,
		groundBlockID:         groundBlockID,
		vegetationFeatureRef:  vegRef,
		depth:                 depth,
		extraDeepBlockChance:  extraDeepBlockChance,
		verticalRange:         int(verticalRangeF),
		vegetationChance:      vegetationChance,
		horizontalRadius:      horizontalRadius,
		extraEdgeColumnChance: extraEdgeColumnChance,
		waterlogged:           waterlogged,
		surfaceDir:            surfaceDir,
		resolver:              ctx.Resolver,
	}, nil
}

func init() {
	RegisterType(vegetationPatchTypeID, buildVegetationPatchFeature)
}

var _ wgen.IFeature = (*VegetationPatchFeature)(nil)
