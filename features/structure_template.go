// structure_template.go implements minecraft:structure_template_feature, which
// is common both on its own and inside delegation chains. Where the two
// supported game versions differ this file says so. What it covers: the schema,
// the position search the adjustment_radius spiral does, the four
// structure-placement constraint kinds, and the per-block copy plus its
// integrity mechanism.
//
// RNG-order contract, the entire point of this port: exactly ONE possible
// draw, made BEFORE the position search and BEFORE any constraint is
// evaluated -- random.nextIntBound(4) -- and ONLY when facing_direction is
// the "random" sentinel (byte 255). Every other code path (explicit
// facing_direction, the adjustment_radius search, every constraint, the
// per-block copy) draws nothing.
//
// integrity/integrity_seed are real mechanisms but are NOT exposed as JSON
// keys for this feature type -- the placement never sets them, so every
// placement uses the structure settings' defaults (integrity=100.0, seed=0),
// which short-circuits the per-block skip mechanism to "always keep every
// block, zero RNG". There is no JSON field to implement here, only a default
// behavior, kept as a no-op (no per-block skip logic) rather than dead code
// implementing an unreachable knob.
//
// Constraint status (see parseConstraints):
//
//	grounded            enforced, point set exact, predicate exact. The
//	                    game's test per point is the block's solid-blocking
//	                    predicate, the same in both supported game versions.
//	                    This port runs that predicate itself,
//	                    block.IsSolidBlocking (block/motion.go), not
//	                    Palette.IsSolid.
//	unburied            enforced, point set exact. The game compares each
//	                    sampled block's FULL identity -- name AND every state
//	                    at its concrete value -- against air's default state,
//	                    so Palette.IsAir is exact rather than approximate for
//	                    the world-side test.
//	block_intersection  enforced. The game PARTITIONS the cells with the
//	                    block's motion-blocking predicate, and
//	                    only_check_intersection_for_motion_blocking_blocks picks
//	                    a half -- default TRUE, i.e. the motion-blocking one.
//	                    Both halves are modelled, and so is the predicate:
//	                    block.IsMotionBlocking is the per-block-type answer
//	                    (block/motion.go), not a render-kind approximation.
//	leveled             enforced. Per point, the game scans the consecutive
//	                    rows from y-max_steepness to y+1+max_steepness
//	                    (max_steepness defaults to 2) for a solid-over-air
//	                    transition, and fails the whole placement if any point
//	                    has none. Its point set is the same as grounded's.
//	                    structure_template_test.go is what stands behind it.
//
// THE POINT LISTS. Each constraint walks the structure's palette once when it
// is set up and precomputes a vector of relative points; the test only
// iterates that vector. In all four the structure index is
// `z + sizeZ*(y + x*sizeY)` -- the same linearization structureGeometry uses.
//
//	grounded     loops x then z (NO y loop), samples the cell at
//	             (x, clamp(ground_level, 0, sizeY-1), z), and for each one that
//	             is not air pushes the relative point (x, -1, z). So the test is
//	             "one row below the structure's ground row", per column that has
//	             a block on that row.
//	unburied     loops x then z, samples the FIXED top row (sizeY - 1), and
//	             pushes (x, sizeY, z) -- one row ABOVE the structure. A column
//	             whose top-row cell is void is skipped entirely, and every
//	             checked point sits at the same height.
//	leveled      same point set as grounded ((x, -1, z), sampled at the
//	             ground_level row). max_steepness defaults to 2 and the JSON
//	             value overrides it when supplied.
//	block_int.   loops all three axes and pushes the actual (x, y, z), with NO
//	             air test anywhere. It fills TWO vectors and they PARTITION the
//	             non-void cells: the motion-blocking ones, and every other
//	             non-void cell (explicit air included). Read as "all cells plus
//	             a subset" -- which this port once did -- the default meaning of
//	             only_check_intersection_for_motion_blocking_blocks comes out
//	             backwards.
//
// Easy mistakes, invisible in an open-air bench (everything above the terrain
// is air, everything below is solid, so either reading reaches the same
// verdict) and whenever ground_level is 0: sampling row 0 instead of the
// ground_level row and dropping preOffset.Y from the tested position; scanning
// each column for its own topmost occupied cell and testing one above THAT,
// instead of the fixed top row. Both are pinned by structure_template_test.go.
//
// Four further vanilla behaviours this port models, all of which move
// placement or loading:
//
//  1. grounded / unburied / leveled skip EXPLICIT AIR as well as void: a void
//     cell compares as air too. Not hypothetical: .mcstructure files written
//     by a structure block encode empty-but-selected cells as explicit air.
//     See contributesPoint.
//  2. block_intersection checks only the motion-blocking half by default, not
//     every non-void cell -- see blockIntersectionConstraint.
//  3. block_intersection.block_allowlist is schema-REQUIRED, so a
//     block_intersection with no allow list is an invalid file. This port used
//     to register no constraint and warn, which made the omission the most
//     permissive spelling available. It is an error now.
//  4. adjustment_radius is schema-validated to [0, 16] and never clamped, and
//     ground_level carries a schema minimum of 0. Both are refused out of
//     range, since the game refuses them. See buildStructureTemplateFeature.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/internal/nearest"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wgen"
)

const structureTemplateTypeID = "minecraft:structure_template_feature"

// ---------------------------------------------------------------------------
// facing_direction <-> Rotation byte. — see module doc comment.
// ---------------------------------------------------------------------------

const randomFacing = 255

var facingToRotation = map[string]int{
	"south": 0, "west": 1, "north": 2, "east": 3, "random": randomFacing,
}

func parseFacingDirection(value any) (int, error) {
	if value == nil {
		return 0, nil // default "south"
	}
	s, ok := value.(string)
	if !ok {
		return 0, fmt.Errorf("facing_direction must be one of south, west, north, east, random (got %#v)", value)
	}
	r, ok := facingToRotation[s]
	if !ok {
		return 0, fmt.Errorf("facing_direction must be one of south, west, north, east, random (got %#v)", value)
	}
	return r, nil
}

// rotateXZ mirrors the game's rotation of a block position: the standard
// quarter-turn rotation matrix. 2D, XZ-plane only; Y always passes through
// unchanged.
func rotateXZ(x, z, rotation int) (int, int) {
	switch rotation & 3 {
	case 1:
		return -z, x
	case 2:
		return -x, -z
	case 3:
		return z, -x
	default:
		return x, z
	}
}

// ---------------------------------------------------------------------------
// adjustment_radius spiral search. The origin is tried first, and there are
// exactly (2r+1)^2 candidate cells in total, after which the search fails --
// both as in the game. The ORDER of the cells after the first is this port's
// reconstruction and is unconfirmed.
// ---------------------------------------------------------------------------

func spiralOffsets(radius int) [][2]int {
	out := [][2]int{{0, 0}}
	if radius <= 0 {
		return out
	}
	maxCells := (2*radius + 1) * (2*radius + 1)
	x, z := 0, 0
	dx, dz := 1, 0
	legLength := 1
	stepsInLeg := 0
	legsCompleted := 0
	total := 1
	for total < maxCells {
		x += dx
		z += dz
		total++
		stepsInLeg++
		out = append(out, [2]int{x, z})
		if stepsInLeg == legLength {
			dx, dz = -dz, dx
			stepsInLeg = 0
			legsCompleted++
			if legsCompleted%2 == 0 {
				legLength++
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// constraints
// ---------------------------------------------------------------------------

// structureGeometry is `structure.layer0`, reinterpreted as a 3D lookup.
type structureGeometry struct {
	structure *structures.ResolvedStructure
}

// blockAt returns (id, true), or (_, false) for a void cell / out-of-range
// coordinate.
func (g *structureGeometry) blockAt(sx, sy, sz int) (block.ID, bool) {
	size := g.structure.Size
	if sx < 0 || sy < 0 || sz < 0 || sx >= size.X || sy >= size.Y || sz >= size.Z {
		return 0, false
	}
	idx := sx*(size.Y*size.Z) + sy*size.Z + sz
	paletteIndex := g.structure.Layer0[idx]
	if paletteIndex < 0 || int(paletteIndex) >= len(g.structure.PaletteIDs) {
		return 0, false
	}
	return g.structure.PaletteIDs[paletteIndex], true
}

// isDefaultAir is the equality test grounded, leveled and unburied each run
// once per sampled cell while building their point sets. The game compares
// the cell's full block identity -- its NAME and every state at its concrete
// value -- against minecraft:air's default state, so the comparison is
// exactly "is this minecraft:air in its default state", not "is this
// air-like".
//
// DELIBERATELY NARROWER than Palette.IsAir, which also answers true for
// minecraft:cave_air and minecraft:void_air -- block/kind.go groups all three
// as KindAir because they render the same. The game compares against exactly
// ONE name here, so a cell holding some other air-ish id does not compare
// equal and DOES contribute a point. Using IsAir would silently widen the skip
// past what the game does.
func isDefaultAir(pal wgen.IPaletteView, id block.ID) bool {
	return pal.NameOf(id) == "minecraft:air" && len(pal.StatesOf(id)) == 0
}

// contributesPoint reports whether the structure cell at (sx, sy, sz) puts a
// point into the precomputed vector grounded, unburied and leveled each walk.
//
// VOID and EXPLICIT AIR are the same answer -- no point. For a void cell the
// game substitutes air's default state and runs the SAME comparison, so the
// void path and the explicit-air path converge and both skip the cell.
//
// This used to ask only "is the cell void", which let an explicit
// minecraft:air cell into the point set. That is not a hypothetical spelling:
// a .mcstructure exported from a structure block writes empty-but-selected
// cells as explicit air, so real features were refusing placements the game
// accepts.
//
// minecraft:structure_void is NOT covered by this: it is a real palette block
// with its own identity, so it never compares equal to air and it
// DOES contribute a point.
func (g *structureGeometry) contributesPoint(pal wgen.IPaletteView, sx, sy, sz int) bool {
	id, ok := g.blockAt(sx, sy, sz)
	if !ok {
		return false
	}
	return !isDefaultAir(pal, id)
}

// constraint is one parsed entry of the `constraints` object.
type constraint func(ctx *wgen.PlacementContext, candidate wgen.BlockPos, rotation int, preOffset wgen.BlockPos, geo *structureGeometry) bool

// groundedConstraint is `constraints.grounded {}`.
// The game's test walks a precomputed vector of relative points, rotates
// each, and applies the block's solid-blocking predicate to the block found
// there -- every point must pass, and it bails on the first failure; an empty
// vector (or the constraint never having been configured) unconditionally
// passes. The predicate is block.IsSolidBlocking, the game's solid-blocking
// predicate (not Palette.IsSolid, a render-kind test). This implementation uses the
// established fact that the structure's ground_level row always lands
// exactly at the placement origin's Y and checks: for every column whose cell
// on that row is neither void nor air, the world block one below the origin
// must be solid.
// Documented as a known-narrower approximation for a nonzero (rarely used)
// ground_level.
func groundedConstraint() constraint {
	return func(ctx *wgen.PlacementContext, candidate wgen.BlockPos, rotation int, preOffset wgen.BlockPos, geo *structureGeometry) bool {
		size := geo.structure.Size
		// The game's point set: it walks x then z (no y loop), samples the structure cell at
		// (x, clamp(ground_level), z), and for every one that is NOT air pushes
		// the relative point (x, -1, z). preOffset.Y is -clamp(ground_level) by
		// construction, so the sampled row is recoverable from it without extra
		// plumbing.
		groundRow := -preOffset.Y
		pal := ctx.API.Palette()
		for sx := 0; sx < size.X; sx++ {
			for sz := 0; sz < size.Z; sz++ {
				// Void AND explicit air are both skipped -- see contributesPoint.
				if !geo.contributesPoint(pal, sx, groundRow, sz) {
					continue
				}
				wx, wz := rotateXZ(preOffset.X+sx, preOffset.Z+sz, rotation)
				// the constraint's test evaluates origin + rotate(point + preOffset); rotation
				// never touches Y, so the world row is candidate.Y +
				// preOffset.Y - 1. Dropping preOffset.Y here is invisible
				// whenever ground_level is 0.
				below := ctx.API.GetBlock(wgen.BlockPos{X: candidate.X + wx, Y: candidate.Y + preOffset.Y - 1, Z: candidate.Z + wz})
				if !block.IsSolidBlocking(pal.NameOf(below), pal.StatesOf(below)) {
					return false
				}
			}
		}
		return true
	}
}

// unburiedConstraint is `constraints.unburied {}`. The game compares each
// sampled world block's FULL identity against air's default state -- not a
// material or "passable" test. That identity covers the name AND every state
// at its concrete value, so the test is exactly "is this air in its default
// state" and Palette.IsAir is an exact match for it rather than an
// approximation.
// This implementation checks: for every column whose top-row cell is neither
// void nor air, the world block one row above the whole structure must be air.
func unburiedConstraint() constraint {
	return func(ctx *wgen.PlacementContext, candidate wgen.BlockPos, rotation int, preOffset wgen.BlockPos, geo *structureGeometry) bool {
		size := geo.structure.Size
		// The game's point set: x then z (no y loop), sampling the structure
		// cell at the FIXED top row `size.Y - 1` and, for every one that is not
		// air, pushing the relative point (x, size.Y, z) -- one row above the
		// structure. So a column whose highest block sits below the top row is
		// skipped entirely, and every checked point is at the same height.
		//
		// This port used to scan each column for its own topmost occupied cell
		// and test one above THAT, which checks more columns, at differing
		// heights, for any structure that is not full at its top row.
		topRow := size.Y - 1
		if topRow < 0 {
			return true
		}
		worldY := candidate.Y + preOffset.Y + size.Y
		pal := ctx.API.Palette()
		for sx := 0; sx < size.X; sx++ {
			for sz := 0; sz < size.Z; sz++ {
				// Void AND explicit air are both skipped -- see contributesPoint.
				if !geo.contributesPoint(pal, sx, topRow, sz) {
					continue
				}
				wx, wz := rotateXZ(preOffset.X+sx, preOffset.Z+sz, rotation)
				above := ctx.API.GetBlock(wgen.BlockPos{X: candidate.X + wx, Y: worldY, Z: candidate.Z + wz})
				if !ctx.API.Palette().IsAir(above) {
					return false
				}
			}
		}
		return true
	}
}

// blockIntersectionConstraint is `constraints.block_intersection`:
// `block_allowlist` (alias `block_whitelist`, schema-REQUIRED) plus
// `only_check_intersection_for_motion_blocking_blocks`. Every checked point
// must have a world block matching the allowlist; the first non-match
// short-circuits to false. Identical in both supported game versions.
//
// THE CELL SET IS A PARTITION, NOT A SUBSET, and which half is checked flips
// on a flag whose default is TRUE. Building the point set involves no air
// test at all; the per-cell filter is exactly:
//
//	the palette lookup comes back empty (VOID)     -> skip the cell entirely
//	the block's motion-blocking predicate is true  -> vector A
//	                                    otherwise  -> vector B
//
// so vector A holds the motion-blocking cells and vector B holds every OTHER
// non-void cell, explicit air included. The test walks A first, applying the
// block-descriptor list match and returning false on the first non-match,
// then reads the flag: SET returns true right there, CLEAR falls into the
// same loop over B. The flag is
// only_check_intersection_for_motion_blocking_blocks, and it defaults to
// true. So a file that never mentions the key gets the
// motion-blocking-only check -- which is the narrow one. This port used to
// check every non-void cell unconditionally, i.e. all of A plus all of B.
//
// The two vectors are walked as one loop here rather than as two. Order is
// unobservable: the check reads the world, draws no RNG and writes nothing, so
// only the SET of points decides the verdict.
//
// EXACT: block.IsMotionBlocking is the block's own motion-blocking predicate,
// per block type, in block/motion.go. That includes a block a PACK defines:
// the game treats every data-driven block as motion-blocking for this
// purpose, and minecraft:collision_box does not affect it. So a pack's
// decorative, collision-free block IS motion-blocking here, exactly as it is
// in the game.
func blockIntersectionConstraint(allow block.MatchSet, onlyMotionBlocking bool) constraint {
	return func(ctx *wgen.PlacementContext, candidate wgen.BlockPos, rotation int, preOffset wgen.BlockPos, geo *structureGeometry) bool {
		size := geo.structure.Size
		pal := ctx.API.Palette()
		for sx := 0; sx < size.X; sx++ {
			for sy := 0; sy < size.Y; sy++ {
				for sz := 0; sz < size.Z; sz++ {
					id, ok := geo.blockAt(sx, sy, sz)
					if !ok {
						continue // void: skipped above, in neither vector
					}
					// The partition. Unlike the other three constraints this
					// one has no air test -- explicit air is simply not
					// motion-blocking, so it lands in vector B.
					if onlyMotionBlocking && !block.IsMotionBlocking(pal.NameOf(id), pal.StatesOf(id)) {
						continue
					}
					wx, wz := rotateXZ(preOffset.X+sx, preOffset.Z+sz, rotation)
					worldPos := wgen.BlockPos{X: candidate.X + wx, Y: candidate.Y + preOffset.Y + sy, Z: candidate.Z + wz}
					if !allow.Contains(ctx.API.GetBlock(worldPos)) {
						return false
					}
				}
			}
		}
		return true
	}
}

// leveledConstraint is `constraints.leveled { max_steepness }`.
// The game's leveled test, identical in both supported versions, walks the
// SAME precomputed point set
// grounded uses -- (x, -1, z) for every column with a block on the
// ground_level row -- and, for each point, looks for a solid-to-air
// transition in a vertical window around it:
//
//	prev = solidBlocking(x, y - maxSteepness, z)
//	for k := -maxSteepness; k <= maxSteepness; k++ {
//	    cur = solidBlocking(x, y + 1 + k, z)
//	    if prev && !cur { this point is satisfied }
//	    prev = cur
//	}
//	// no transition found in the window -> the WHOLE placement fails
//
// So the probes are consecutive rows from y-maxSteepness up to y+1+maxSteepness,
// and what satisfies a point is solid directly below air somewhere in that
// span: the ground surface has to be findable within maxSteepness of where the
// structure expects it, per column. A structure spanning a cliff edge has a
// column whose surface is outside the window, and is refused.
//
// maxSteepness defaults to 2. A NEGATIVE value
// makes the loop's own `k > maxSteepness` guard true on entry, so every point
// fails immediately and the structure can never place -- transcribed rather
// than clamped, with a build-time warning, since silently repairing it would
// hide a pack bug the game does not hide.
//
// block.IsSolidBlocking is the predicate, exactly as in groundedConstraint.
func leveledConstraint(maxSteepness int) constraint {
	return func(ctx *wgen.PlacementContext, candidate wgen.BlockPos, rotation int, preOffset wgen.BlockPos, geo *structureGeometry) bool {
		size := geo.structure.Size
		groundRow := -preOffset.Y
		// The same world row grounded tests, for the same reason: the point set
		// is (x, -1, z) relative to a structure whose ground_level row lands at
		// the placement origin.
		baseY := candidate.Y + preOffset.Y - 1
		pal := ctx.API.Palette()
		solid := func(x, y, z int) bool {
			id := ctx.API.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z})
			return block.IsSolidBlocking(pal.NameOf(id), pal.StatesOf(id))
		}
		for sx := 0; sx < size.X; sx++ {
			for sz := 0; sz < size.Z; sz++ {
				// Void AND explicit air are both skipped -- see contributesPoint.
				if !geo.contributesPoint(pal, sx, groundRow, sz) {
					continue
				}
				wx, wz := rotateXZ(preOffset.X+sx, preOffset.Z+sz, rotation)
				x, z := candidate.X+wx, candidate.Z+wz
				prev := solid(x, baseY-maxSteepness, z)
				found := false
				for k := -maxSteepness; k <= maxSteepness; k++ {
					TickDeadline("probing the rows its constraints.leveled.max_steepness spans")
					cur := solid(x, baseY+1+k, z)
					if prev && !cur {
						found = true
						break
					}
					prev = cur
				}
				if !found {
					return false
				}
			}
		}
		return true
	}
}

func parseConstraints(raw any, ctx *BuildContext) ([]constraint, error) {
	if raw == nil {
		// REQUIRED by the game's schema. Warn rather than reject: an empty
		// constraint set is harmless here, and the file still loads.
		ctx.Warn(fmt.Sprintf("%s: \"constraints\" is required by the engine's schema (this build) but is "+
			"missing -- the real game would reject this file; continuing with no constraints", ctx.Identifier))
		return nil, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("constraints must be an object")
	}

	var checks []constraint
	// grounded and unburied take no options, so presence of the key is what arms them -- but a
	// value that is not an object is almost certainly a mistake ("grounded": false reads like
	// "off" and is not), and arming a real constraint off a typo is the kind of thing that gets
	// blamed on the terrain. block_intersection and leveled both type-check their value; these
	// two now say something too, rather than being the two that quietly do not.
	emptyObjectConstraint := func(key string, raw any) {
		if raw == nil {
			ctx.Warn(fmt.Sprintf("%s: constraints.%s is null. It is still ARMED -- this constraint "+
				"takes no options, so the engine reads only whether the key is present. Write {} if "+
				"you meant to enable it, or remove the key if you meant to turn it off.",
				ctx.Identifier, key))
			return
		}
		if m, isObj := raw.(map[string]any); !isObj {
			ctx.Warn(fmt.Sprintf("%s: constraints.%s should be an empty object {}, but this file "+
				"writes %T. It is still ARMED -- this constraint takes no options, so only the key's "+
				"presence is read, and there is no value that turns it off. Remove the key instead.",
				ctx.Identifier, key, raw))
		} else if len(m) > 0 {
			ctx.Warn(fmt.Sprintf("%s: constraints.%s takes no options, so the keys inside it are "+
				"read by nothing. The constraint itself is armed.", ctx.Identifier, key))
		}
	}
	if raw, ok := obj["grounded"]; ok {
		emptyObjectConstraint("grounded", raw)
		checks = append(checks, groundedConstraint())
	}
	if raw, ok := obj["unburied"]; ok {
		emptyObjectConstraint("unburied", raw)
		checks = append(checks, unburiedConstraint())
	}
	if biRaw, ok := obj["block_intersection"]; ok {
		bi, ok := biRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("constraints.block_intersection must be an object")
		}
		allowRaw, ok := bi["block_allowlist"]
		if !ok {
			allowRaw, ok = bi["block_whitelist"]
		}
		if !ok {
			// The allow list is schema-REQUIRED, so a file without it is invalid rather than
			// permissive: block_allowlist|block_whitelist is required, while eight of the other
			// ten keys across this whole feature's schema are optional. This used to register NO
			// constraint and warn -- which made
			// the omission the most permissive spelling available, while `block_allowlist: []`,
			// the same sentence in English, failed every point. Neither is what the game does.
			//
			// Refusing here costs the author nothing extra: the message names the exact key, so
			// there is no second hunt, and it is the same verdict the game reaches.
			return nil, fmt.Errorf("constraints.block_intersection has no block_allowlist (or " +
				"block_whitelist), and the engine's schema marks that child required -- the real " +
				"game refuses to load this file. There is no permissive reading to fall back on " +
				"either: an allow list containing nothing matches nothing, so even a file that did " +
				"load would fail every candidate position. Write the blocks the structure is " +
				"allowed to intersect, or remove the block_intersection key.")
		}
		descs, err := AsBlockDescriptorList(allowRaw, "constraints.block_intersection.block_allowlist")
		if err != nil {
			return nil, err
		}
		allow := ResolveMatchSet(descs, ctx, "constraints.block_intersection.block_allowlist")

		// only_check_intersection_for_motion_blocking_blocks: OPTIONAL, and its default is
		// TRUE -- so a file that never writes the key gets the NARROW check, over the
		// motion-blocking cells alone. See blockIntersectionConstraint for the partition and for
		// the one approximation left in it.
		onlyMotionBlocking := true
		if v, present := bi["only_check_intersection_for_motion_blocking_blocks"]; present {
			b, isBool := v.(bool)
			if !isBool {
				return nil, fmt.Errorf("constraints.block_intersection." +
					"only_check_intersection_for_motion_blocking_blocks must be true or false")
			}
			onlyMotionBlocking = b
		}
		checks = append(checks, blockIntersectionConstraint(allow, onlyMotionBlocking))
	}
	// `leveled` -- enforced; see leveledConstraint for the
	// window it scans and the point set it shares with grounded.
	if lvRaw, present := obj["leveled"]; present {
		maxSteepness := 2 // the game's default, overridden by the JSON value
		if lv, ok := lvRaw.(map[string]any); ok {
			if ms, present := lv["max_steepness"]; present {
				v, ok := toFloat(ms)
				if !ok {
					return nil, fmt.Errorf("constraints.leveled.max_steepness must be a number")
				}
				// The field is an integer in the engine, so a fractional value
				// truncates rather than rounding.
				maxSteepness = int(v)
				if maxSteepness < 0 {
					ctx.Warn(fmt.Sprintf("%s: constraints.leveled.max_steepness is %v, which is negative -- "+
						"the engine's own scan then has an empty window and refuses every point, so this "+
						"structure can never place. Modelled as-is rather than clamped, because the game "+
						"does not repair it either", ctx.Identifier, ms))
				}
			}
		} else if lvRaw != nil {
			return nil, fmt.Errorf("constraints.leveled must be an object")
		}
		checks = append(checks, leveledConstraint(maxSteepness))
	}

	return checks, nil
}

// ---------------------------------------------------------------------------
// StructureTemplateFeature
// ---------------------------------------------------------------------------

// StructureTemplateFeature is minecraft:structure_template_feature.
type StructureTemplateFeature struct {
	identifier         string
	structure          *structures.ResolvedStructure
	facingByte         int
	rotateAroundCenter bool
	groundLevel        int
	adjustmentRadius   int
	constraints        []constraint
}

func (f *StructureTemplateFeature) TypeID() string     { return structureTemplateTypeID }
func (f *StructureTemplateFeature) Identifier() string { return f.identifier }

// Place mirrors the game's structure-template placement step by step, in the game's own
// order.
func (f *StructureTemplateFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, structureTemplateTypeID)
	defer profiler.PopFeatureFrame()

	geo := &structureGeometry{structure: f.structure}
	size := f.structure.Size

	// *** RNG CALL, ONLY when facing_direction is unset/"random" *** — a
	// bounded integer draw with bound 4, drawn directly on the
	// placement context's RNG, BEFORE anything else (position search,
	// constraints). See the module doc comment.
	rotation := f.facingByte
	if f.facingByte == randomFacing {
		rotation = ctx.Random.NextIntBound(4)
	}

	// rotate_around_center: horizontal center offset, computed pre-rotation
	// from the raw structure size, THEN rotated along with everything else.
	centerX, centerZ := 0, 0
	if f.rotateAroundCenter {
		centerX = -(size.X / 2)
		centerZ = -(size.Z / 2)
	}

	// ground_level: clamp to [0, max(sizeY-1, 0)], matching place()'s own
	// clamp exactly.
	maxGroundLevel := size.Y - 1
	if maxGroundLevel < 0 {
		maxGroundLevel = 0
	}
	clampedGroundLevel := f.groundLevel
	if clampedGroundLevel < 0 {
		clampedGroundLevel = 0
	}
	if clampedGroundLevel > maxGroundLevel {
		clampedGroundLevel = maxGroundLevel
	}

	preOffset := wgen.BlockPos{X: centerX, Y: -clampedGroundLevel, Z: centerZ}

	// No clamp: the engine has none either, and buildStructureTemplateFeature
	// has already refused anything outside the schema's [0, 16] range, so the
	// value reaching here is exactly what the file wrote.
	var found *wgen.BlockPos
	for _, off := range spiralOffsets(f.adjustmentRadius) {
		// One tick per candidate position, not per constrained cell: adjustment_radius is
		// schema-clamped to [0,16] (at most 1089 candidates) and each candidate's constraint
		// sweep is bounded by the structure file's own cell count, so a candidate is already
		// about the size of the deadline's own sampling target. The one axis here that is NOT
		// bounded, constraints.leveled.max_steepness, is ticked inside leveledConstraint itself.
		TickDeadline("testing where the structure fits inside its adjustment_radius")
		candidate := wgen.BlockPos{X: ctx.Origin.X + off[0], Y: ctx.Origin.Y, Z: ctx.Origin.Z + off[1]}
		// Constraints draw no RNG — pure world lookups. ALL
		// configured constraints must pass (matches every constraint's own
		// "empty vector -> true" short-circuit generalized to "no
		// configured constraints -> true").
		ok := true
		for _, check := range f.constraints {
			if !check(ctx, candidate, rotation, preOffset, geo) {
				ok = false
				break
			}
		}
		if ok {
			c := candidate
			found = &c
			break
		}
	}

	if found == nil {
		LogFailure(ctx, structureTemplateTypeID, "Structure could not be placed.")
		return nil
	}

	// Per-block copy. During some worldgen passes the game does not support
	// structure placement at all and this step places nothing -- but on the
	// real in-game path it unconditionally succeeds and does the real copy.
	// This simulator mirrors the real in-game path, since a preview tool that
	// always shows "nothing placed" would defeat its own purpose -- see
	// module doc comment.
	for sx := 0; sx < size.X; sx++ {
		for sy := 0; sy < size.Y; sy++ {
			for sz := 0; sz < size.Z; sz++ {
				blockID, ok := geo.blockAt(sx, sy, sz)
				if !ok {
					continue // void cell -- never overwrites the destination
				}
				wx, wz := rotateXZ(preOffset.X+sx, preOffset.Z+sz, rotation)
				worldPos := wgen.BlockPos{X: found.X + wx, Y: found.Y + preOffset.Y + sy, Z: found.Z + wz}
				ctx.API.SetBlock(worldPos, blockID)
			}
		}
	}

	return found
}

// structureNameLister is the optional half of structures.IResolver: a resolver that can also
// say what it holds. structures.Library implements it; structures.NoStructures does not, and
// neither does any test double that only needs Resolve -- so this is an assertion rather than a
// method on the interface, and a resolver without it simply produces the message with no
// suggestion on the end.
type structureNameLister interface {
	Names() []string
}

func structureNames(r structures.IResolver) []string {
	if lister, ok := r.(structureNameLister); ok {
		return lister.Names()
	}
	return nil
}

func buildStructureTemplateFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	name, ok := body["structure_name"].(string)
	if !ok || name == "" {
		return nil, fmt.Errorf("structure_name must be a non-empty string")
	}
	structure := ctx.Structures.Resolve(name)
	if structure == nil {
		return nil, fmt.Errorf("structure_name %q was not found in the loaded structures%s",
			name, nearest.Phrase(name, structureNames(ctx.Structures)))
	}

	facingByte, err := parseFacingDirection(body["facing_direction"])
	if err != nil {
		return nil, err
	}
	rotateAroundCenter := jsonTruthy(body["rotate_around_center"])

	// ground_level carries a schema range with a MINIMUM of 0 and no maximum.
	// The game's placement-time clamp is still transcribed, but only its
	// upper half can ever fire: a negative value never reaches placement because the
	// file does not load.
	groundLevel := 0
	if v, present := body["ground_level"]; present {
		f, ok := toFloat(v)
		if !ok {
			return nil, fmt.Errorf("ground_level must be a number")
		}
		groundLevel = int(f)
		if groundLevel < 0 {
			return nil, fmt.Errorf("ground_level is %v, but the engine's schema gives this field a "+
				"minimum of 0 and rejects anything below it -- the real game refuses to load a file "+
				"with a negative ground_level rather than clamping it", v)
		}
	}

	// adjustment_radius is schema-validated to [0, 16] and NEVER clamped
	// anywhere. The position search computes its budget straight from the
	// signed value -- ((2r)|1)^2, no guard -- so the range is the only thing
	// standing between a bad value and that arithmetic, and the game enforces
	// it hard: outside the range it rejects with "Value '%d' outside valid
	// range [%d, %d]" and the file does not load. This port used to clamp a
	// negative radius to 0 silently, which invented a repair the game does not
	// perform.
	adjustmentRadius := 0
	if v, present := body["adjustment_radius"]; present {
		f, ok := toFloat(v)
		if !ok {
			return nil, fmt.Errorf("adjustment_radius must be a number")
		}
		adjustmentRadius = int(f)
		if adjustmentRadius < 0 || adjustmentRadius > 16 {
			return nil, fmt.Errorf("adjustment_radius is %v, outside the engine's schema range "+
				"[0, 16] -- the real game rejects the value during validation and refuses to load "+
				"this file. Nothing clamps it there, so there is no in-range behaviour to fall back "+
				"on; write a radius between 0 and 16, or omit the key for 0", v)
		}
	}

	constraints, err := parseConstraints(body["constraints"], ctx)
	if err != nil {
		return nil, err
	}

	return &StructureTemplateFeature{
		identifier:         ctx.Identifier,
		structure:          structure,
		facingByte:         facingByte,
		rotateAroundCenter: rotateAroundCenter,
		groundLevel:        groundLevel,
		adjustmentRadius:   adjustmentRadius,
		constraints:        constraints,
	}, nil
}

func init() {
	RegisterType(structureTemplateTypeID, buildStructureTemplateFeature)
}

var _ wgen.IFeature = (*StructureTemplateFeature)(nil)
