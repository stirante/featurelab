// ore.go is a port of minecraft:ore_feature's placement.
//
// A self-contained leaf -- no feature delegation, so it's always in scope.
//
// THERE IS A SECOND VEIN ALGORITHM IN THE GAME AND IT IS NOT THE ONE TO PORT.
// The game also has a legacy ore-vein layout, kept only for comparing the new algorithm
// against the old one in testing; normal world generation never uses it. It differs in
// substance -- it places each sphere as it is laid out instead of pruning first, it has no
// discard_chance_on_air_exposure at all, and it compares blocks by their full serialized
// state where the live placement compares block types -- so porting it would have been a
// behaviour change dressed up as a rounding fix.
//
// RNG order, in the game's own sequence:
//  1. one float draw for the vein angle,
//  2. a bounded integer draw of 3, TWICE, for the two Y endpoints,
//  3. ONLY THEN the empty-replace_rules bail, which sits downstream of both integer draws
//     -- so a rules-less ore still costs three draws,
//  4. one float draw per sphere across the count. Sphere centres are interpolated with no
//     draw of their own.
//
// The discard_chance_on_air_exposure roll happens PER RULE-MATCH ATTEMPT, not once
// globally -- see the gate inside the replace_rules walk below.
//
// EVERY VALUE IN THE VEIN IS float32. The game uses no double-precision arithmetic
// anywhere in the vein (nor in the legacy layout): every multiply, add, subtract,
// divide, square root, compare and integer-to-float conversion is single-precision.
// The game never fuses a multiply into an add here either -- which is why every product
// below that feeds an add is wrapped in an explicit
// `float32()`. Go is permitted to fuse `a*b + c` on arm64 and gc does; the conversion is
// what the spec says forbids it. This repo is developed and tested on amd64, where the
// fusion does not happen, so no test here would notice its absence.
//
// The game precomputes the count TWICE, both as float32, once per feature:
// float32(count), and float32(1) / float32(count).
//
// So the per-sphere interpolation multiplies by a precomputed reciprocal rather than
// dividing, and `pi/count` is one float32 product formed once outside the loop. Those are
// not algebraic
// niceties: 1/count is inexact for every count that is not a power of two, so
// `x1 + dx*(i/count)` and `x1 + (dx*i)*(1/count)` are different float32 numbers.
//
// TRIG: the two calls in the angle setup are the game's own sine and cosine --
// Minecraft's 65536-entry lookup table rather than libm; the per-sphere radius uses the
// same sine. All three go through EngineSin/EngineCos in enginemath.go, which reproduces
// that table's index arithmetic and contents exactly. The three calls are sin, cos and sin.
package features

import (
	"fmt"
	"math"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const oreTypeID = "minecraft:ore_feature"

// orePi is the game's own constant, a float32 that is float32(math.Pi) exactly.
const orePi = float32(math.Pi)

type oreReplaceRule struct {
	targetID      block.ID
	mayReplaceIDs block.MatchSet
}

// oreSphere mirrors the ore feature's sphere record: three float32 centre coordinates, then
// the SQUARED radius, then the radius. The game derives the stored radius from the square
// -- it squares, takes the square root and keeps both -- which round-trips exactly for a
// positive float32.
type oreSphere struct {
	x, y, z  float32
	radiusSq float32
	radius   float32
}

var oreNeighborOffsets = [6][3]int{
	{1, 0, 0},
	{-1, 0, 0},
	{0, 1, 0},
	{0, -1, 0},
	{0, 0, 1},
	{0, 0, -1},
}

// OreFeature is minecraft:ore_feature.
type OreFeature struct {
	identifier string
	count      int
	// discardChanceOnAirExposure is a float32 because the game's value is one: it is
	// loaded single-precision, and every comparison against it -- with 0.0, with 1.0, and
	// with the draw -- is single-precision too.
	discardChanceOnAirExposure float32
	rules                      []oreReplaceRule
}

func (f *OreFeature) TypeID() string     { return oreTypeID }
func (f *OreFeature) Identifier() string { return f.identifier }

// oreFloorToInt is the game's float-vector-to-block-position conversion: it rounds
// each component toward minus infinity -- i.e. floors it -- and only then converts to an
// integer. That conversion truncates toward zero, but the value it sees is already
// integral, so the pair is a plain floor -- including for negatives, where a bare
// truncation would not be.
func oreFloorToInt(v float32) int {
	return int(math.Floor(float64(v)))
}

// isExposedToAir mirrors the game's air-exposure test. Its exact behaviour is not
// independently confirmed, so this is the natural, deterministic "any of the 6 face
// neighbors is air" reading, matching every
// other adjacency helper already ported in this codebase. No RNG.
func (f *OreFeature) isExposedToAir(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	pal := api.Palette()
	for _, off := range oreNeighborOffsets {
		neighbor := wgen.BlockPos{X: pos.X + off[0], Y: pos.Y + off[1], Z: pos.Z + off[2]}
		if pal.IsAir(api.GetBlock(neighbor)) {
			return true
		}
	}
	return false
}

// Place mirrors the ore feature's placement step by step.
func (f *OreFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, oreTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	// Step 1: the vein axis. The literal "+8.0" is the chunk-relative-origin offset the
	// classic vanilla ore-vein algorithm uses -- it cancels out of the endpoint-to-endpoint
	// direction vector, but not out of the absolute sphere-centre positions, so it is
	// preserved here. The game adds the 8 to the PRODUCT and only then to the origin,
	// which is a different float32 number from (origin + 8) + product.
	angle := float32(rnd.NextFloat()) * orePi // *** RNG CALL #1 ***
	// EngineSin/EngineCos, NOT math.Sin/math.Cos: the game uses its own sine and then
	// its own cosine on the same value -- the lookup table, see enginemath.go. `angle` is
	// already the game's own float32 (one float draw times float32 pi), multiplied by
	// pi ONCE.
	sinA := EngineSin(angle)
	cosA := EngineCos(angle)

	countF := float32(f.count)         // the game's precomputed float32 count
	invCount := float32(1) / countF    // and its precomputed reciprocal
	sizeScale := countF / 8            // one float32 divide in the game
	axisX := float32(sinA * sizeScale) // one float32 multiply each
	axisZ := float32(cosA * sizeScale)
	ox := float32(origin.X)
	oy := float32(origin.Y)
	oz := float32(origin.Z)

	x1 := ox + (8 + axisX)
	z1 := oz + (8 + axisZ)
	// Step 2: Y bounds -- TWO separate bounded draws of 3, each pos.y + draw - 2.
	y1 := oy + (float32(rnd.NextIntBound(3)) - 2) // *** RNG CALL #2 ***
	x2 := ox + (8 - axisX)
	z2 := oz + (8 - axisZ)
	y2 := oy + (float32(rnd.NextIntBound(3)) - 2) // *** RNG CALL #3 ***

	dx := x2 - x1
	dy := y2 - y1
	dz := z2 - z1

	// Step 3: empty replace_rules -> fail, but only here, three draws in. Between the
	// endpoints and this test the game normalises the axis vector twice; both
	// normalisations feed nothing but a conservative pre-filter (see step 7) and neither
	// can divide by zero, because the axis length is at least count/4 and so the game's
	// two `< 1e-4` degenerate branches are unreachable for every count the schema
	// accepts.
	if len(f.rules) == 0 {
		LogFailure(ctx, oreTypeID, "Replace rules are empty")
		return nil
	}

	// Step 4: per-sphere loop, i = 0..count-1. Centre = point1 + (delta * i) * (1/count),
	// with no draw of its own. One float draw per sphere.
	piOverCount := orePi * invCount // one float32 product, formed once as the game does
	spheres := make([]oreSphere, f.count)
	for i := 0; i < f.count; i++ {
		TickDeadline("laying out the spheres its count asks for")
		fi := float32(i)
		cx := x1 + float32(float32(dx*fi)*invCount)
		cy := y1 + float32(float32(dy*fi)*invCount)
		cz := z1 + float32(float32(dz*fi)*invCount)
		roll := float32(rnd.NextFloat()) // *** RNG CALL, one per sphere (count total) ***
		d9 := float32(roll*countF) / 16
		// Same table again: the game's own sine.
		sinI := EngineSin(fi * piOverCount)
		radius := (float32(float32(sinI+1)*d9) + 1) / 2
		radiusSq := radius * radius
		spheres[i] = oreSphere{
			x: cx, y: cy, z: cz,
			radiusSq: radiusSq,
			radius:   float32(math.Sqrt(float64(radiusSq))),
		}
	}

	// Step 5: geometric pruning -- NO RNG. For each sphere j (in order), check only LATER
	// spheres k>j: if radius_j + dist(centre_j, centre_k) < radius_k, sphere j is fully
	// enclosed by k and is dropped. The last sphere (no later candidates) is always kept
	// unconditionally. The game also skips a k outright when radius_j > radius_k;
	// that is
	// pure speed -- a distance is never negative, so radius_j + dist < radius_k is already
	// false there -- and is not reproduced.
	kept := make([]oreSphere, 0, len(spheres))
	for j := 0; j < len(spheres); j++ {
		sj := spheres[j]
		enclosed := false
		for k := j + 1; k < len(spheres); k++ {
			// Ticked on the INNER loop, not the outer: this pruning pass is quadratic in count,
			// so with a large count one outer step alone is already unbounded work. It is also
			// the one loop here that could not matter less for an ordinary vein -- count is 8 to
			// 64 in every vanilla ore, i.e. a few thousand steps total.
			TickDeadline("pruning the spheres its count asks for against each other")
			sk := spheres[k]
			// The game takes sphere k first, subtracts sphere j, and sums as
			// (dx*dx + dy*dy) + dz*dz.
			ddx, ddy, ddz := sk.x-sj.x, sk.y-sj.y, sk.z-sj.z
			distSq := float32(ddx*ddx) + float32(ddy*ddy)
			distSq += float32(ddz * ddz)
			dist := float32(math.Sqrt(float64(distSq)))
			if sj.radius+dist < sk.radius {
				enclosed = true
				break
			}
		}
		if !enclosed {
			kept = append(kept, sj)
		}
	}

	// Step 6: union AABB over kept spheres. Each corner goes through the game's
	// float-vector-to-block-position conversion, i.e. a plain floor with NO half-cell
	// bias, for the low corner and the high one alike. The half cell lives in the
	// membership test instead, at step 7. This file used to have it the other way round --
	// floor(c +/- r + 0.5) as the box and a cell-CORNER distance -- which is self-consistent
	// but lays the vein half a block off the one the game lays.
	minX, minY, minZ := math.MaxInt32, math.MaxInt32, math.MaxInt32
	maxX, maxY, maxZ := math.MinInt32, math.MinInt32, math.MinInt32
	for _, s := range kept {
		minX = min(minX, oreFloorToInt(s.x-s.radius))
		minY = min(minY, oreFloorToInt(s.y-s.radius))
		minZ = min(minZ, oreFloorToInt(s.z-s.radius))
		maxX = max(maxX, oreFloorToInt(s.x+s.radius))
		maxY = max(maxY, oreFloorToInt(s.y+s.radius))
		maxZ = max(maxZ, oreFloorToInt(s.z+s.radius))
	}

	// Step 7: triple nested loop, X outer / Z / Y inner -- the game's own nesting.
	// Inside the z and y walks the game also runs two cylindrical pre-filters,
	// comparing the cell's squared distance from the vein axis against the
	// largest kept radiusSq. Both are conservative -- a cell inside a sphere is nearer the
	// axis than that sphere's radius, because every centre lies on the axis by construction
	// -- so skipping them only means testing more cells, never a different outcome. They are
	// not reproduced, and neither is the largest-radius bookkeeping that feeds them.
	placedCount := 0
	for x := minX; x <= maxX; x++ {
		for z := minZ; z <= maxZ; z++ {
			for y := minY; y <= maxY; y++ {
				// The bounding box these three loops walk grows with count, and the whole body
				// below has a no-write path (the membership miss, and every rule that declines),
				// so the write budget cannot see it.
				TickDeadline("filling the block volume its count spheres cover")
				// Step 7a: membership test against the pruned sphere list. The game tests the
				// CELL CENTRE: it seeds each of the three loops' floats with min + 0.5f
				// and steps each by 1.0f, then subtracts the centre and sums the
				// squares as (dx*dx + dy*dy) + dz*dz. Adding 0.5f to a float32
				// cell coordinate is exact at any coordinate this bench can address, so seeding
				// once and stepping by one is the same number as computing it per cell.
				fx := float32(x) + 0.5
				fy := float32(y) + 0.5
				fz := float32(z) + 0.5
				inside := false
				for _, s := range kept {
					ddx, ddy, ddz := fx-s.x, fy-s.y, fz-s.z
					d := float32(ddx*ddx) + float32(ddy*ddy)
					d += float32(ddz * ddz)
					if d < s.radiusSq {
						inside = true
						break
					}
				}
				if !inside {
					continue
				}

				pos := wgen.BlockPos{X: x, Y: y, Z: z}
				worldBlock := api.GetBlock(pos)

				// Step 7b: walk replace_rules in order.
				for _, rule := range f.rules {
					if !rule.mayReplaceIDs.Contains(worldBlock) {
						continue // not this rule's block
					}
					if worldBlock == rule.targetID {
						continue // already the target block
					}

					// Step 7c: discard-chance-on-air-exposure gate, rolled
					// PER RULE-MATCH ATTEMPT (only once a rule's
					// block-membership test has already matched):
					//  - chance <= 0      -> always place, no roll.
					//  - chance >= 1.0    -> ALWAYS check exposure, but the
					//                        float draw is skipped
					//                        entirely (short-circuited).
					//  - 0 < chance < 1.0 -> take one float draw; only if the
					//                        roll is LESS than chance does
					//                        it even check exposure.
					allowPlace := true
					if f.discardChanceOnAirExposure > 0 {
						shouldCheckExposure := f.discardChanceOnAirExposure >= 1 ||
							float32(rnd.NextFloat()) < f.discardChanceOnAirExposure // *** RNG CALL, per matching rule ***
						if shouldCheckExposure && f.isExposedToAir(api, pos) {
							allowPlace = false
						}
					}
					if !allowPlace {
						continue // rejected -> try the next rule at this position
					}

					if api.SetBlock(pos, rule.targetID) {
						placedCount++
						break // this position is done; don't try further rules here
					}
					// the block write failed (e.g. out of bounds) -> fall through, try the next rule
				}
			}
		}
	}

	// Step 8: overall success/failure.
	if placedCount == 0 {
		LogFailure(ctx, oreTypeID, "No blocks could be placed")
		return nil
	}
	result := origin
	return &result
}

func buildOreFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	countF, ok := toFloat(body["count"])
	if !ok || countF < 1 {
		return nil, fmt.Errorf("count must be a positive number")
	}
	// The `countF < 1` test above is not the same test as this one, and the gap between them
	// crashed the tool. `count` is stored as int(countF), and Go's float64->int conversion is
	// implementation-defined once the value leaves int64's range: on amd64 it lands on
	// math.MinInt64. So `"count": 1e19` passes "is it at least 1" as a float and then becomes a
	// hugely NEGATIVE int, which reaches `make([]oreSphere, f.count)` in Place and panics with
	// "makeslice: len out of range" -- a raw Go stack trace from the CLI, an opaque "internal
	// error" through serve, and `featurelab check` passing the file without a word.
	//
	// Re-testing the CONVERTED value is what closes it, and it is deliberately the same ">= 1"
	// question rather than a new one, so nothing else changes: a fractional count still truncates
	// the way it always did (1.9 is still 1), and every count that produced a usable int before
	// still does. The only values this newly refuses are the ones whose conversion did not
	// survive -- which is exactly the set that used to panic.
	if int(countF) < 1 {
		return nil, fmt.Errorf("count is %g, which is too large to be a whole number of ore blocks -- "+
			"it does not fit in an integer and wraps to a negative one. Write a real count (vanilla "+
			"veins use single or double digits)", countF)
	}
	discardChance := 0.0
	if v, ok := body["discard_chance_on_air_exposure"]; ok {
		f, ok := toFloat(v)
		if !ok {
			return nil, fmt.Errorf("discard_chance_on_air_exposure must be a number")
		}
		discardChance = f
	}

	// replace_rules is OPTIONAL in the game's schema, in both game versions, and not
	// required: a file without it loads
	// fine and then simply never places anything, because place()'s own step 1
	// bails on an empty rule list before spending any RNG. This port used to
	// reject such a file at load time, which is a different behaviour in kind
	// -- `featurelab check` would report an error where the game reports none.
	// Accept it, warn, and let the placement-time failure speak for itself.
	//
	// CORRECTED 2026-08-22: optional is not the same as "may be empty", and this port treated
	// them as one. The key being ABSENT is fine, as above. An explicitly EMPTY array is not:
	// the schema sets a minimum array size of 1 on both of its arrays
	// -- replace_rules and the nested may_replace list -- so the schema's array validation
	// fails `"replace_rules": []` with the content log "Array too small (0 < 1)".
	// Writing the key as an empty array is a load-time failure
	// in the game and used to load here with a warning.
	rulesRaw, present := body["replace_rules"]
	if present {
		arr, ok := rulesRaw.([]any)
		if !ok {
			return nil, fmt.Errorf("replace_rules must be an array")
		}
		if len(arr) == 0 {
			return nil, fmt.Errorf("replace_rules is written as an empty array -- the game refuses the " +
				"file outright for that (its schema requires at least one rule when the key is present). " +
				"Leave the key out entirely if the feature is meant to place nothing; that form loads, and " +
				"fails at placement time instead")
		}
	}
	rulesArr, _ := rulesRaw.([]any)
	if len(rulesArr) == 0 {
		ctx.Warn(fmt.Sprintf("%s: replace_rules is missing -- this feature will never place a block "+
			"(the engine accepts the file too, and fails the same way at placement time)", ctx.Identifier))
	}
	rules := make([]oreReplaceRule, len(rulesArr))
	for i, v := range rulesArr {
		p := fmt.Sprintf("replace_rules[%d]", i)
		e, ok := v.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s must be an object", p)
		}
		placesBlockRaw, ok := e["places_block"]
		if !ok {
			return nil, fmt.Errorf("%s.places_block is required", p)
		}
		desc, err := AsBlockDescriptor(placesBlockRaw, p+".places_block")
		if err != nil {
			return nil, err
		}
		targetID := ctx.Palette.Resolve(desc)
		mayReplaceList, err := AsBlockDescriptorList(e["may_replace"], p+".may_replace")
		if err != nil {
			return nil, err
		}
		// TYPE-level, not partial and not exact -- the odd one out among every
		// match list in this package. The game's replace-rule matching keeps
		// only the block TYPE and DISCARDS any states the author wrote, so
		// `{"name": "minecraft:oak_log", "states": {"pillar_axis": "y"}}` here
		// behaves exactly like the bare name. See block.MatchMode.
		mayReplaceIDs := ResolveMatchSetMode(mayReplaceList, ctx, p+".may_replace", block.MatchType)
		rules[i] = oreReplaceRule{targetID: targetID, mayReplaceIDs: mayReplaceIDs}
	}

	return &OreFeature{
		identifier: ctx.Identifier,
		count:      int(countF),
		// Narrowed once, here, rather than at each comparison: the game's value is a
		// float32 (see the field's own comment), so `"discard_chance_on_air_exposure": 0.3`
		// is the float 0.30000001192092896 in game and never the double 0.29999999999999999.
		discardChanceOnAirExposure: float32(discardChance),
		rules:                      rules,
	}, nil
}

func init() {
	RegisterType(oreTypeID, buildOreFeature)
}

var _ wgen.IFeature = (*OreFeature)(nil)
