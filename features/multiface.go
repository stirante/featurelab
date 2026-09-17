// multiface.go implements minecraft:multiface_feature. See coverage.go's own
// minecraft:multiface_feature entry for the status notes; the multi_face_direction_bits
// read-modify-write logic lives in block/state.go and is only referred to here.
//
// The opposite-face lookup is exactly face^1: opposite(0)=1, opposite(1)=0,
// opposite(2)=3, opposite(3)=2, opposite(4)=5, opposite(5)=4 -- the standard
// Down/Up=0/1, North/South=2/3, West/East=4/5 pairing already used throughout this codebase
// (partially_exposed_blob.go, sculk_patch.go).
//
// VERSION NOTE, game version 1.26.50.24: behaviour of both direction shuffles (the shuffled
// direction list, and the same list minus one face) is unchanged from 1.26.40.26. Both shuffle
// with the game's thread-local generator, with the same bounded-draw semantics (bound==0 -> 0
// with NO draw, else a modulo of the generator step; standard MT19937 twist+temper).
//
// The "deterministic direction order in this port" deviation below therefore still holds in
// 1.26.50.24: the thread-local generator is lazily constructed and seeds from FOUR BYTES OF OS
// ENTROPY before the standard MT19937 init walk. So the real shuffle is non-reproducible across
// runs, independent of ctx.Random, and consumes ZERO draws from the placement stream.
//
// SCHEMA, in the order the game parses the fields (which is also the order their effects are
// applied):
//
//	places_block          block descriptor REQUIRED
//	search_range           int              REQUIRED, range [1,64]
//	can_place_on_floor     bool             REQUIRED (pushes DOWN=0 into the direction pool)
//	can_place_on_ceiling    bool             REQUIRED (pushes UP=1)
//	can_place_on_wall       bool             REQUIRED (pushes
//	                         NORTH=2, EAST=5, SOUTH=3, WEST=4 -- that exact order)
//	chance_of_spreading     float            REQUIRED, range [0.0,1.0]
//	can_place_on            array<block descriptor> OPTIONAL, min 1 entry
//	                         WHEN PRESENT (same convention as every other array field in this
//	                         codebase); its elements are not individually required.
//
// place() ALGORITHM:
//
//  1. If origin is NEITHER air NOR empty water (the SAME two-test shape
//     sculk_patch.go/growing_plant.go already use): LogFailure("Location does
//     not contain air or water"), return nil. ZERO RNG, ZERO writes.
//  2. Build the candidate direction pool (Down/Up/North/East/South/West filtered by the three
//     can_place_on_* flags, that exact push order -- see SCHEMA above).
//  3. Attempt the guarded block write AT ORIGIN ITSELF, with the FULL pool as candidate faces. On
//     success, place() returns origin immediately -- no further direction loop.
//  4. If the pool is empty: LogFailure("No adjacent locations contain air or water"), return nil.
//  5. Otherwise, for each direction `dir` in the pool (in pool order -- see "Direction order is
//     deterministic in this port" below for why real shuffle order doesn't matter here):
//     a. If search_range <= 0: skip this direction entirely (the game does the same; unreachable
//     for any schema-valid config since search_range is REQUIRED and schema-bounded to [1,64], but
//     reproduced for a config that manages to reach place() with 0 anyway).
//     b. neighborPos := origin.relative(dir, 1). If neighborPos is NEITHER air NOR empty water NOR
//     the SAME block type as places_block (a block-type identity compare in the game; this
//     port's equivalent is Name equality, this codebase's established block-type-identity stand-in):
//     skip to the next direction.
//     c. Otherwise, attempt the guarded block write AT neighborPos, with the pool MINUS
//     dir's opposite as candidate faces. On success, place() returns
//     neighborPos immediately.
//  6. If no direction ever succeeded: LogFailure("No adjacent locations contain air or water"),
//     return nil.
//
// "search_range retries" -- the ONE simplification in this port, and why it is RNG- and
// state-identical to the real loop, not merely convenient: the game wraps step 5c's
// guarded block write in a retry loop that fires up to search_range times AT THE SAME
// neighborPos with the SAME candidate-face list, decrementing a counter on each failure
// (both the initial attempt and each retry use the SAME dir and distance 1, recomputing the
// IDENTICAL position every retry, not a step further out). The guarded block write's
// own body (see below) makes ZERO RNG draws and ZERO writes on failure (the one float draw
// only happens after a successful, CHANGE-producing write), so with neighborPos, the candidate list,
// and world state all unchanged between retries, a failing retry is GUARANTEED to fail identically
// every time: zero draws, zero writes, on attempt 1 through attempt search_range. This port makes
// exactly one attempt per direction -- observably identical to the game's up-to-search_range
// attempts in every way that matters (RNG stream position, blocks placed), just without the wasted
// deterministic-failure loop iterations.
//
// Direction order is deterministic in this port, NOT a port of the real shuffle -- and this is a
// SEPARATE point from the search_range simplification above: both the shuffled direction list and
// the shuffled-list-minus-one-face shuffle via THE GAME'S THREAD-LOCAL GENERATOR -- a thread-local
// RNG instance, never ctx.Random, never seeded from the world seed. The spreader behaves the same
// way (see below): the game's face-pick ORDER is not reproducible from the world seed at all, on
// any run. Since the order doesn't touch ctx.Random (zero draws either way) and
// doesn't change WHETHER a placement succeeds (only which of several simultaneously-valid faces get
// picked first), any deterministic choice this port makes is equally faithful relative to that
// non-reproducible ground truth -- so this port uses the pool's own declared (unshuffled) order,
// deterministically, so this tool's own output is stable and testable across runs. This costs
// nothing on the RNG stream: neither the real shuffle nor this port's fixed order consumes
// ctx.Random.
//
// THE GUARDED BLOCK WRITE:
//
//  1. existingBlock := the world's block at pos (the block CURRENTLY at the position being placed
//     at -- pos, not any neighbor).
//  2. For each candidate face in the given list, in order: supportPos := pos.relative(face, 1);
//     supportBlock := the world's block at supportPos. Accept this face if (can_place_on is empty
//     OR the block-descriptor list match accepts supportBlock) AND the neighbour-chunk readiness
//     test passes for supportPos (see "What
//     this port cannot model" below). Stop at the FIRST accepted face; if none of the list's faces
//     are accepted, return failure (found nothing to attach to).
//  3. Compute the resulting block: if existingBlock's block type equals places_block's own block
//     type,
//     start from existingBlock's CURRENT multi_face_direction_bits (or 0 if it has none) and OR in
//     the accepted face's bit; otherwise start fresh from places_block with just that one bit. This
//     is EXACTLY the multiface block's worldgen placement derivation (see
//     "the two placement-block derivations" below) -- block.WithIntState reused
//     directly, no new primitive needed.
//  4. If the resulting block differs from existingBlock (a real change, not "this face was already
//     set"): write it, THEN draw exactly one rnd.NextFloat() -- *** RNG CALL, ONLY ON AN ACTUAL
//     CHANGE *** -- and if that roll is below chance_of_spreading, the game goes on to check
//     whether places_block is itself a multiface-capable block type with a spreader and, if so,
//     runs the spreader's random directed spread. See "the spreader
//     gap" below for what this port does with that roll's SUCCESS case.
//  5. Return success (a face was found and possibly written) regardless of whether step 4's `if`
//     branch fired -- "success" means "found an attach face", not "changed the world".
//
// The two placement-block derivations: the guarded block write uses the multiface block's LIVE
// placement block derivation, which behaves exactly like the WORLDGEN placement block derivation
// applied to the live world. So the state-bit read-modify-write logic this file relies on is the
// SAME logic block/state.go already implements, not a separate one.
//
// What this port cannot model, and why it is not a runtime-warned gap:
// the neighbour-chunk readiness test checks whether a candidate support position's OWN chunk
// is loaded/generated far enough (a chunk load state with values 0-5, requiring state>=2),
// and additionally -- only past that gate -- asks the active dimension's world generator
// whether the position overlaps a Stronghold or Mineshaft structure piece, to avoid growing
// multiface blocks across structure-carved terrain. This bench has exactly one already-generated
// Volume with no adjacent unloaded chunks and no structure/dimension model at all, so EVERY position
// this port ever queries is trivially "ready" by the ONLY case this bench can represent (the
// same-chunk case) -- there is no situational risk to disclose per-call the way GAP-class
// approximations elsewhere in this codebase are (e.g. geode.go's placement-check approximation,
// which fires on real per-position uncertainty); this is a universal, not a situational, mismatch
// between "what this bench models" and "what the game additionally checks",
// so it is recorded here rather than as per-call noise.
//
// DETERMINISTIC SPREADER DEVIATION [deliberate, not an accidental RNG substitution]: the
// chance_of_spreading roll remains the same single ctx.Random.NextFloat() at the same point in the
// control flow. The spread it gates is ported, but its direction shuffle consumes ZERO draws
// from ctx.Random. The game shuffles the spread directions with its thread-local generator, which
// is lazily seeded from operating-system entropy, so the real game's spread blocks are not
// reproducible from the world seed across runs. This port intentionally chooses reproducible
// previews instead: it creates a separate MT generator and uses only that generator for the five
// bounded draws in the six-facing shuffle, so ctx.Random remains bit-identical whether the gated
// spread runs or not. The LogWarning below discloses this deliberate difference whenever
// chance_of_spreading succeeds.
//
// "The spreader" -- how the spread works:
//
//  1. The directed spread lookup is NOT "try same-position, then try move-to-neighbor, done" --
//     it is a loop over a per-spreader mode LIST,
//     trying each configured mode in order and advancing to the next entry
//     on failure, returning on the first success. All three modes' failure paths converge on the
//     same "advance, go round again" step, so it really is one unified loop across all
//     three mode values.
//  2. The three mode values are 0 = add toward's bit at the SAME position, 1 = move one step
//     toward, retain fromFace's bit, and 2 = wrap around:
//     move one step along fromFace, then one more step along toward, and if the resulting position
//     accepts a block whose face is toward's OPPOSITE, place it there. Concretely:
//     mid := pos.relative(fromFace, 1); target :=
//     mid.relative(toward, 1); newFace := opposite(toward); if the spread-target test accepts
//     target and the worldgen placement derivation for (target, newFace) differs from target's
//     current block, spread
//     there. This is the "grow around a convex corner" case (e.g. a vine wrapping from a block's
//     north face onto its west face by stepping out and sideways) -- implemented as
//     getSpreadWrappingAround, tried as the third fallback after modes 0 and 1 both fail,
//     matching the mode ORDER below.
//  3. Which modes are configured for a given places_block is a property of the BLOCK
//     (fixed per block), not of any JSON field multiface_feature's own schema exposes -- so this
//     port cannot read it out of a pack config. But it does not need to guess: only two mode lists
//     exist in vanilla, the full list {0, 1, 2} and the same-position-only list {0}. Glow lichen
//     and sculk vein both use the full list. The same-position-only list is used only by sculk's
//     tick-based vein spreading, which this codebase treats as out of scope for multiface_feature
//     (sculk_patch_feature's own unported path) -- not a second multiface spread-mode
//     configuration. So every vanilla multiface block, and therefore every real places_block
//     multiface_feature could ever legitimately target, uses the full list {0, 1, 2}: this port
//     always tries mode 0, then mode 1, then mode 2, in that fixed order, rather than modeling a
//     configurable mode list it has no data source for.
//  4. The spread-target test takes an extra flag that has no effect on its result. So this port's
//     air/water/same-block-type-name approximation for it (used by modes 0/1, matching the
//     same empty-block/empty-water idiom this codebase already applies elsewhere) is reused
//     unchanged for mode 2's own spread-target check.
//  5. The worldgen placement derivation's own internal multiface-support check (block/state.go's
//     own doc comment already names this as unmodeled by WithIntState itself) is what actually gates
//     "is there a solid neighbor on the face being added" for ALL THREE modes in the game --
//     this port's multifaceBlockForPlacement helper (a solid/glass Kind check on the target face's
//     own neighbor) is this file's own established stand-in for that check, reused unchanged
//     for mode 2's own placement.
//
// spreadRnd's own seed is POSITION-DEPENDENT, not just world-seed-dependent. Seeding spreadRnd
// from ctx.Random.GetSeed() ALONE would be a real defect: GetSeed() returns the SEED LAST PASSED
// TO New/SetSeed, not anything derived from the twister's own advancing state
// (random.IRandom.GetSeed's own doc comment) -- and
// session.go constructs ctx.Random exactly ONCE per session (`rnd := random.New(config.FeatureSeed)`)
// and shares that SAME instance across every RepeatCount iteration and every distribution-driven
// placement in a rule. So a GetSeed()-only derivation would hand EVERY successful spread in an entire
// generation run the identical six-facing permutation, regardless of where in the world it fired --
// not "reproducible previews" (same seed and same input volume produce the same spread) but "one
// global permutation for the whole session". multifaceSpreadSeed mixes the base seed with the
// position being spread FROM (a pure, non-drawing combination -- this port's own choice, not the
// game's, since it governs only this port's own deliberately-non-vanilla preview generator) so
// different positions draw different, but individually still seed-reproducible, permutations.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const multifaceTypeID = "minecraft:multiface_feature"

// multifaceFacingOffsets is the BlockPos delta for each Facing index, matching this codebase's
// established Down=0/Up=1/North=2/South=3/West=4/East=5 convention (the same as
// partially_exposed_blob.go -- see this file's header for the opposite-face lookup on the same
// domain).
var multifaceFacingOffsets = [6]wgen.BlockPos{
	{X: 0, Y: -1, Z: 0}, // Down
	{X: 0, Y: 1, Z: 0},  // Up
	{X: 0, Y: 0, Z: -1}, // North
	{X: 0, Y: 0, Z: 1},  // South
	{X: -1, Y: 0, Z: 0}, // West
	{X: 1, Y: 0, Z: 0},  // East
}

// multifaceBitForFace maps a face index (this file's own domain above) to the multiface block's
// own direction-bit value (DOWN=1, UP=2, SOUTH=4, WEST=8, NORTH=16, EAST=32), the SAME values
// block/state.go's own header uses for MultiFaceDirectionBits's 64-value domain.
var multifaceBitForFace = [6]int{1, 2, 16, 4, 8, 32} // Down,Up,North,South,West,East

// multifaceGetOpposite mirrors the game's opposite-face lookup, which is exactly face^1; see this
// file's header.
func multifaceGetOpposite(face int) int { return face ^ 1 }

// multifaceShuffledDirections mirrors the multiface feature's shuffled direction list in its
// OBSERVABLE shape (copy
// the pool) but not its actual randomization -- see this file's header, "Direction order is
// deterministic in this port", for why the real shuffle (the game's thread-local generator,
// independent of
// ctx.Random and the world seed) cannot be faithfully reproduced OR meaningfully needs to be: it
// costs zero RNG draws either way and never changes whether a placement succeeds.
func multifaceShuffledDirections(pool []int) []int {
	out := make([]int, len(pool))
	copy(out, pool)
	return out
}

// multifaceShuffledDirectionsExcept mirrors the multiface feature's shuffled direction list minus
// one face, in its
// OBSERVABLE shape (filter out except, preserving pool order) -- see multifaceShuffledDirections'
// own doc comment for why the real shuffle itself is not reproduced.
func multifaceShuffledDirectionsExcept(pool []int, except int) []int {
	out := make([]int, 0, len(pool))
	for _, f := range pool {
		if f != except {
			out = append(out, f)
		}
	}
	return out
}

// multifaceSpreaderShuffledDirections mirrors the game's spread-direction shuffle: it starts from
// [1,0,2,3,4,5] and makes five bounded draws with bounds 2,3,4,5,6, each swapping the current
// entry with the returned index. The game supplies its OS-entropy-seeded thread-local generator;
// this port deliberately supplies
// a separate, world-seeded generator instead (see the header's deterministic-deviation note).
func multifaceSpreaderShuffledDirections(rnd random.IRandom) [6]int {
	directions := [6]int{1, 0, 2, 3, 4, 5}
	for i := 1; i < len(directions); i++ {
		j := rnd.NextIntBound(i + 1)
		if j != i {
			directions[i], directions[j] = directions[j], directions[i]
		}
	}
	return directions
}

// multifaceSpreadSeed derives spreadRnd's own seed from this port's configured seed AND the position
// being spread from -- a pure, non-drawing combination (this port's own choice, not the engine's: it
// governs only the deliberately-non-engine-faithful preview generator, never ctx.Random itself). See
// this file's header, "spreadRnd's own seed is now POSITION-DEPENDENT", for why a bare
// ctx.Random.GetSeed() would be a real defect, not a stylistic one: it
// made every successful spread in an entire generation session draw the identical permutation.
//
// Now routed through random.DeriveSeedAt, this project's single documented seed-derivation scheme
// (random/derive.go) -- DomainMultifaceSpread is registered there as a LEGACY, POSITIONAL domain
// reproducing this exact multiply-xor formula bit for bit, so this migration changes nothing about
// which spread permutation a given seed and position produce.
func multifaceSpreadSeed(base uint32, pos wgen.BlockPos) uint32 {
	return random.DeriveSeedAt(base, random.DomainMultifaceSpread, pos.X, pos.Y, pos.Z)
}

type multifaceSpread struct {
	pos  wgen.BlockPos
	face int
}

// MultifaceFeature is minecraft:multiface_feature (vine / glow lichen / sculk vein multi-face
// growth). A leaf type -- no feature delegation, so it is always in scope. See this file's header
// for the full algorithm and the deliberate deterministic spreader deviation.
type MultifaceFeature struct {
	identifier string

	placesBlock     block.ID
	placesBlockName string
	searchRange     int
	canPlaceOnFloor bool
	canPlaceOnCeil  bool
	canPlaceOnWall  bool
	chanceOfSpread  float64
	canPlaceOn      block.MatchSet
	directionPool   []int // Facing indices, in schema push order -- see header's SCHEMA section

	pal *block.Palette // build-time palette, for StateInt/WithIntState -- same pattern as growing_plant.go/tree.go
}

func (f *MultifaceFeature) TypeID() string     { return multifaceTypeID }
func (f *MultifaceFeature) Identifier() string { return f.identifier }

// Place mirrors the multiface feature's placement step-by-step -- see this file's header
// for the full algorithm.
func (f *MultifaceFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, multifaceTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	pal := api.Palette()

	// Step 1: origin must be air or empty water. ZERO RNG, ZERO writes either way.
	originID := api.GetBlock(origin)
	if !(pal.IsAir(originID) || isWaterBlock(pal, originID)) {
		LogFailure(ctx, multifaceTypeID, "Location does not contain air or water")
		return nil
	}

	// Step 2: candidate direction pool, in schema push order -- see header's "Direction order is
	// deterministic in this port".
	directions := multifaceShuffledDirections(f.directionPool)

	// Step 3: attempt directly at origin, using the FULL pool.
	if _, ok := f.placeBlockIfPossible(ctx, api, origin, rnd, directions); ok {
		result := origin
		return &result
	}

	// Step 4: empty pool (or origin attempt found nothing) with nothing left to try.
	if len(directions) == 0 {
		LogFailure(ctx, multifaceTypeID, "No adjacent locations contain air or water")
		return nil
	}

	// Step 5: per-direction fallback -- grow one step from origin in each pool direction.
	for _, dir := range directions {
		if f.searchRange <= 0 {
			continue // search_range==0 -- this direction contributes nothing, see header
		}

		off := multifaceFacingOffsets[dir]
		neighborPos := wgen.BlockPos{X: origin.X + off.X, Y: origin.Y + off.Y, Z: origin.Z + off.Z}
		neighborID := api.GetBlock(neighborPos)
		valid := pal.IsAir(neighborID) || isWaterBlock(pal, neighborID) || pal.NameOf(neighborID) == f.placesBlockName
		if !valid {
			continue
		}

		except := multifaceShuffledDirectionsExcept(f.directionPool, multifaceGetOpposite(dir))
		// search_range retries at this SAME position are RNG- and state-identical on every
		// deterministic failure -- see header, "search_range retries", for the full proof. One
		// attempt suffices.
		if _, ok := f.placeBlockIfPossible(ctx, api, neighborPos, rnd, except); ok {
			result := neighborPos
			return &result
		}
	}

	// Step 6: nothing worked.
	LogFailure(ctx, multifaceTypeID, "No adjacent locations contain air or water")
	return nil
}

// spreadFromFaceTowardRandomDirection mirrors the spreader's random directed spread for the
// multiface_feature-reached spread modes:
// visit all six shuffled directions and commit the first candidate whose derived block differs.
// The game runs the directed spread lookup for shuffled faces 0..5 in turn and writes the
// first changed result with update flag 3.
func (f *MultifaceFeature) spreadFromFaceTowardRandomDirection(api wgen.BlockWorld, pos wgen.BlockPos, fromFace int, rnd random.IRandom) bool {
	directions := multifaceSpreaderShuffledDirections(rnd)
	for _, toward := range directions {
		spread, ok := f.getSpreadFromFaceTowardDirection(api, pos, fromFace, toward)
		if !ok {
			continue
		}
		newID, ok := f.multifaceBlockForPlacement(api, spread.pos, spread.face)
		if !ok || newID == api.GetBlock(spread.pos) {
			continue
		}
		api.SetBlock(spread.pos, newID)
		return true
	}
	return false
}

// getSpreadFromFaceTowardDirection mirrors the multiface spreader's
// directed spread lookup. Its opening gates: the source
// must carry fromFace, toward may be neither fromFace nor its opposite, and toward must not already
// be present on the source. Past that gate, the game loops over the spreader's own
// configured spread-type list (mode 0 = same position, mode 1 = move to neighbor retaining fromFace,
// mode 2 = wrap around a corner), trying each in turn and stopping at the first block-changing
// candidate -- see this file's header, "The spreader" point 1, for why this is one single loop
// across all three modes, and point 3 for why this port always tries modes 0, 1, 2 in that fixed
// order (every vanilla multiface block uses the full spread-type list {0, 1, 2}, and no JSON
// field carries a different list).
func (f *MultifaceFeature) getSpreadFromFaceTowardDirection(api wgen.BlockWorld, pos wgen.BlockPos, fromFace, toward int) (multifaceSpread, bool) {
	sourceID := api.GetBlock(pos)
	bits, ok := f.pal.StateInt(sourceID, block.MultiFaceDirectionBits)
	if !ok || bits&multifaceBitForFace[fromFace] == 0 || toward == fromFace || toward == multifaceGetOpposite(fromFace) || bits&multifaceBitForFace[toward] != 0 {
		return multifaceSpread{}, false
	}

	// Mode 0: add toward's bit at the same position.
	if newID, ok := f.multifaceBlockForPlacement(api, pos, toward); ok && newID != sourceID {
		return multifaceSpread{pos: pos, face: toward}, true
	}

	// Mode 1: move one step toward, retain fromFace's bit.
	off := multifaceFacingOffsets[toward]
	target := wgen.BlockPos{X: pos.X + off.X, Y: pos.Y + off.Y, Z: pos.Z + off.Z}
	targetID := api.GetBlock(target)
	pal := api.Palette()
	if pal.IsAir(targetID) || isWaterBlock(pal, targetID) || pal.NameOf(targetID) == f.placesBlockName {
		if newID, ok := f.multifaceBlockForPlacement(api, target, fromFace); ok && newID != targetID {
			return multifaceSpread{pos: target, face: fromFace}, true
		}
	}

	// Mode 2: wrap around a corner -- see getSpreadWrappingAround.
	return f.getSpreadWrappingAround(api, pos, fromFace, toward)
}

// getSpreadWrappingAround mirrors the spreader's wrap-around lookup (mode 2 of
// the directed spread lookup's own mode chain -- see this file's header, "The spreader"
// point 2). Shape: step one block along fromFace (off
// the current support face), then one more block along toward (sideways), and if the resulting
// position accepts a block whose face is toward's OPPOSITE (attaching back toward where the spread
// came from), place it there. This is how e.g. glow lichen wraps around a convex corner of a block
// rather than only spreading across a single flat face.
func (f *MultifaceFeature) getSpreadWrappingAround(api wgen.BlockWorld, pos wgen.BlockPos, fromFace, toward int) (multifaceSpread, bool) {
	off1 := multifaceFacingOffsets[fromFace]
	mid := wgen.BlockPos{X: pos.X + off1.X, Y: pos.Y + off1.Y, Z: pos.Z + off1.Z}
	off2 := multifaceFacingOffsets[toward]
	target := wgen.BlockPos{X: mid.X + off2.X, Y: mid.Y + off2.Y, Z: mid.Z + off2.Z}
	newFace := multifaceGetOpposite(toward)

	targetID := api.GetBlock(target)
	pal := api.Palette()
	if !(pal.IsAir(targetID) || isWaterBlock(pal, targetID) || pal.NameOf(targetID) == f.placesBlockName) {
		return multifaceSpread{}, false
	}
	if newID, ok := f.multifaceBlockForPlacement(api, target, newFace); ok && newID != targetID {
		return multifaceSpread{pos: target, face: newFace}, true
	}
	return multifaceSpread{}, false
}

// canProvideMultifaceSupport is the support test that lives INSIDE the multiface block's worldgen
// placement derivation: per block/state.go, the face bit is ORed in only once a placement
// direction clears a multiface-support
// check. Both of this file's placement paths reach
// that derivation -- the spreader through multifaceBlockForPlacement and
// the guarded block write's own step 3 (see this file's header) -- so the gate belongs on both, and
// is factored out here so the two can never drift apart again. It previously existed only on the
// spread path: with can_place_on omitted and all six neighbours air, the two disagreed for the
// identical (pos, face) -- the spreader refused, while the guarded block write wrote places_block
// into open air, spent one NextFloat the game would not, and emitted a spurious spread warning.
//
// DELIBERATELY NOT ROUTED THROUGH block/support.go. That file models the block's own support test
// for any support type -- a DIFFERENT check, with a per-face model (stairs, slabs, trapdoors) this
// one may or may not share. Whether the multiface-support check matches it, or is a third thing,
// is not established. Substituting the richer model would be a behaviour change with no
// evidence behind it; this keeps the coarse kind test already documented on the spread path, and
// fixes only the demonstrated disagreement between the two paths. Recorded as an open question in
// coverage.go's evidence for this type.
func (f *MultifaceFeature) canProvideMultifaceSupport(api wgen.BlockWorld, pos wgen.BlockPos, face int) bool {
	off := multifaceFacingOffsets[face]
	supportID := api.GetBlock(wgen.BlockPos{X: pos.X + off.X, Y: pos.Y + off.Y, Z: pos.Z + off.Z})
	kind := f.pal.Entry(supportID).Kind
	return kind == block.KindSolid || kind == block.KindGlass
}

// multifaceBlockForPlacement is the spreader's use of the multiface block's worldgen placement
// derivation: require a support-capable block on the
// requested face, then OR that face into an existing same-type block or start from places_block.
// This volume's coarse block model can represent the normal full-face support cases as solid or
// glass blocks; air, liquids, and plants cannot provide multiface support.
func (f *MultifaceFeature) multifaceBlockForPlacement(api wgen.BlockWorld, pos wgen.BlockPos, face int) (block.ID, bool) {
	if !f.canProvideMultifaceSupport(api, pos, face) {
		return 0, false
	}

	existingID := api.GetBlock(pos)
	base := f.placesBlock
	bits := 0
	if api.Palette().NameOf(existingID) == f.placesBlockName {
		base = existingID
		if existingBits, ok := f.pal.StateInt(existingID, block.MultiFaceDirectionBits); ok {
			bits = existingBits
		}
	}
	return f.pal.WithIntState(base, block.MultiFaceDirectionBits, bits|multifaceBitForFace[face])
}

// placeBlockIfPossible mirrors the multiface feature's guarded block write -- see this
// file's header for the full algorithm. candidateFaces is tried in order; the first face whose
// support neighbor satisfies can_place_on (or can_place_on is empty) wins -- see header's "What this
// port cannot model" for why no chunk-readiness check appears here at all, not just an
// always-true stand-in.
func (f *MultifaceFeature) placeBlockIfPossible(ctx *wgen.PlacementContext, api wgen.BlockWorld, pos wgen.BlockPos, rnd random.IRandom, candidateFaces []int) (wgen.BlockPos, bool) {
	pal := api.Palette()
	existingID := api.GetBlock(pos)

	chosenFace := -1
	for _, face := range candidateFaces {
		off := multifaceFacingOffsets[face]
		supportPos := wgen.BlockPos{X: pos.X + off.X, Y: pos.Y + off.Y, Z: pos.Z + off.Z}
		supportID := api.GetBlock(supportPos)
		if f.canPlaceOn.Empty() || f.canPlaceOn.Contains(supportID) {
			chosenFace = face
			break
		}
	}
	if chosenFace == -1 {
		return wgen.BlockPos{}, false
	}

	// The worldgen placement derivation's OWN support gate, step 3 -- distinct from step 2's
	// can_place_on face selection above, which is schema-OPTIONAL and gates nothing when omitted.
	// The game's step-2 loop stops at the FIRST can_place_on-accepted face and does NOT fall
	// through to the next one when the block itself then refuses to attach, so this does not
	// resume the loop. The worldgen placement derivation returns the block UNCHANGED in that case
	// (block/state.go: "if the write succeeds it returns the NEW block; if it fails, it returns
	// the ORIGINAL block UNCHANGED"), so step 4's "did it actually change" test fails: no write,
	// no NextFloat, no spread. Step 5's own semantics still hold -- success here means "found an
	// attach face", not "changed the world" -- so this returns success, exactly as the
	// already-existing face-already-set no-op path a few lines below does.
	if !f.canProvideMultifaceSupport(api, pos, chosenFace) {
		return pos, true
	}

	// The worldgen placement derivation's own shape (block/state.go): start from the
	// EXISTING block's own bits when it's already the same block type, else start fresh.
	base := f.placesBlock
	existingBits := 0
	if pal.NameOf(existingID) == f.placesBlockName {
		base = existingID
		if bits, ok := f.pal.StateInt(existingID, block.MultiFaceDirectionBits); ok {
			existingBits = bits
		}
	}
	newBits := existingBits | multifaceBitForFace[chosenFace]
	newID, ok := f.pal.WithIntState(base, block.MultiFaceDirectionBits, newBits)
	if !ok {
		newID = base // matches the game's own state-write-fails-keep-original fallback
	}

	if newID != existingID {
		api.SetBlock(pos, newID)

		roll := rnd.NextFloat() // *** RNG CALL -- ONLY on an actual change, see header step 4 ***
		if roll < f.chanceOfSpread {
			// DELIBERATE DEVIATION: GetSeed is a non-drawing read. Every shuffle draw goes to this
			// separate generator; ctx.Random's state is therefore identical with spreading on/off.
			// The seed is mixed with pos (see header's "spreadRnd's own seed is
			// POSITION-DEPENDENT" note) so different spread events sharing one long-lived ctx.Random
			// object don't all draw the identical six-facing permutation.
			spreadRnd := random.New(multifaceSpreadSeed(rnd.GetSeed(), pos))
			f.spreadFromFaceTowardRandomDirection(api, pos, chosenFace, spreadRnd)
			LogWarning(ctx, multifaceTypeID,
				"chance_of_spreading succeeded. The spread is modelled deterministically from "+
					"this port's configured world seed using a separate generator that consumes zero "+
					"ctx.Random draws. The real engine instead shuffles with an OS-entropy-seeded "+
					"thread-local Random, so its spread blocks are non-reproducible across runs; a "+
					"comparison against the game may therefore show different spread blocks even "+
					"though the chance_of_spreading roll and surrounding world RNG sequence match.",
				&pos)
		}
	}

	return pos, true
}

func buildMultifaceFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	placesRaw, ok := body["places_block"]
	if !ok {
		return nil, fmt.Errorf("places_block is required")
	}
	placesDesc, err := AsBlockDescriptor(placesRaw, "places_block")
	if err != nil {
		return nil, err
	}
	placesBlock := ctx.Palette.Resolve(placesDesc)
	placesBlockName := ctx.Palette.Entry(placesBlock).Name

	intField := func(key string, lo, hi int) (int, error) {
		raw, ok := body[key]
		if !ok {
			return 0, fmt.Errorf("%s is required", key)
		}
		f, ok := toFloat(raw)
		if !ok || f != float64(int(f)) {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		v := int(f)
		if v < lo || v > hi {
			return 0, fmt.Errorf("%s must be in [%d, %d] (the game's own schema bound)", key, lo, hi)
		}
		return v, nil
	}
	floatField := func(key string, lo, hi float64) (float64, error) {
		raw, ok := body[key]
		if !ok {
			return 0, fmt.Errorf("%s is required", key)
		}
		v, ok := toFloat(raw)
		if !ok {
			return 0, fmt.Errorf("%s must be a number", key)
		}
		if v < lo || v > hi {
			return 0, fmt.Errorf("%s must be in [%v, %v] (the game's own schema bound)", key, lo, hi)
		}
		return v, nil
	}
	boolField := func(key string) (bool, error) {
		raw, ok := body[key]
		if !ok {
			return false, fmt.Errorf("%s is required", key)
		}
		v, ok := raw.(bool)
		if !ok {
			return false, fmt.Errorf("%s must be a boolean", key)
		}
		return v, nil
	}

	searchRange, err := intField("search_range", 1, 64)
	if err != nil {
		return nil, err
	}
	canPlaceOnFloor, err := boolField("can_place_on_floor")
	if err != nil {
		return nil, err
	}
	canPlaceOnCeil, err := boolField("can_place_on_ceiling")
	if err != nil {
		return nil, err
	}
	canPlaceOnWall, err := boolField("can_place_on_wall")
	if err != nil {
		return nil, err
	}
	chanceOfSpread, err := floatField("chance_of_spreading", 0.0, 1.0)
	if err != nil {
		return nil, err
	}

	var canPlaceOnDescs []block.Descriptor
	if raw, ok := body["can_place_on"]; ok {
		arr, isArr := raw.([]any)
		if !isArr || len(arr) == 0 {
			// min 1 entry when present -- see this file's header SCHEMA section.
			return nil, fmt.Errorf("can_place_on must be a non-empty array")
		}
		canPlaceOnDescs, err = AsBlockDescriptorList(raw, "can_place_on")
		if err != nil {
			return nil, err
		}
	}
	canPlaceOn := ResolveMatchSet(canPlaceOnDescs, ctx, "can_place_on")

	// Direction pool, schema push order -- see this file's header SCHEMA section:
	// can_place_on_floor -> Down(0); can_place_on_ceiling -> Up(1);
	// can_place_on_wall -> North(2), East(5), South(3), West(4).
	var directionPool []int
	if canPlaceOnFloor {
		directionPool = append(directionPool, 0)
	}
	if canPlaceOnCeil {
		directionPool = append(directionPool, 1)
	}
	if canPlaceOnWall {
		directionPool = append(directionPool, 2, 5, 3, 4)
	}

	return &MultifaceFeature{
		identifier:      ctx.Identifier,
		placesBlock:     placesBlock,
		placesBlockName: placesBlockName,
		searchRange:     searchRange,
		canPlaceOnFloor: canPlaceOnFloor,
		canPlaceOnCeil:  canPlaceOnCeil,
		canPlaceOnWall:  canPlaceOnWall,
		chanceOfSpread:  chanceOfSpread,
		canPlaceOn:      canPlaceOn,
		directionPool:   directionPool,
		pal:             ctx.Palette,
	}, nil
}

func init() {
	RegisterType(multifaceTypeID, buildMultifaceFeature)
}

var _ wgen.IFeature = (*MultifaceFeature)(nil)
