// geode.go implements minecraft:geode_feature.
//
// Every threshold below is derived from formulas, so their relative order
// can be checked without trusting any names: tC1=1/sqrt(1.7),
// tC2=1/sqrt(pointRatio+2.2), tC3=1/sqrt(pointRatio+3.2), tC4=1/sqrt(pointRatio+4.2) are
// DECREASING in that order (pointRatio>=0). Microsoft's creator docs for this type
// describe placements_require_layer0_alternate as "potential placement blocks
// will only be placed on the alternate layer0 blocks that get placed", which
// matches the control flow below: the potential-placement roll is skipped
// ONLY when layer0 resolved to the NON-alternate (inner_layer) block AND
// placements_require_layer0_alternate is set; it is always attempted when
// layer0 resolved to alternate_inner_layer.
//
// VERSION NOTE: behaviour is unchanged between 1.26.40.26 and 1.26.50.24 --
// same draws, same draw order, same writes, same gates. The block placement
// check gained a trailing actor parameter in 1.26.50.24; the geode passes
// none, and the no-actor path is identical to the older one, so the
// placement-check model below applies to both versions.
//
// RNG: the bounded integer draw returns 0 with NO draw when bound==0, else
// generatorStep() % bound (plain MT19937 twist+temper).
//
// SCHEMA: see the GeodeFeature struct below for the full field list.
//
// RNG DRAW SEQUENCE:
//
//  1. pointCount := drawIntRange(min_distribution_points, max_distribution_points, rnd).
//     drawIntRange is this file's geodeIntRange, NOT tree.go's treeIntRangeValue and NOT
//     the game's int-range draw -- see "geodeIntRange vs. treeIntRangeValue" below for
//     why they are genuinely different functions:
//     `if (max > min) { min += nextIntBound(max-min); }`. Zero draws
//     when max<=min, one nextIntBound(max-min) draw otherwise -- NOT
//     nextIntBound(max-min-1) the way the int-range draw works. The two look
//     superficially similar (both "0 or 1 nextIntBound draws") but disagree at
//     max-min==1 (the int-range draw skips the draw there; the two-argument
//     integer draw still makes an always-0 nextIntBound(1) draw), so reusing tree.go's helper
//     here would silently desync the RNG stream for any geode config with a
//     degenerate 1-wide bound pair. Every two-argument integer draw in this file
//     (point count, per-axis offsets, point offset) uses THIS shape.
//  2. NormalNoise construction -- noise.New(nr, -4, []float32{1.0}), nr being
//     ctx.Random widened to noise.Random via this file's local geodeRandom
//     adapter (see "Random-surface widening" below). Fires unconditionally,
//     before any schema-gated branch. 2608 RNG-stream advances -- see noise/
//     normal_noise.go and TestGeodeDrawTotal.
//  3. Five threshold constants, all float32 formulas, computed in
//     this exact order (tC1 first, with NO pointRatio term, all the way through to
//     tC5 last, which alone uses a RESET pointRatio):
//     pointRatio := pointCount / max_outer_wall_distance
//     tC1 := 1/sqrt(1.7)                    (bare constant)
//     tC2 := 1/sqrt(pointRatio+2.2)
//     tC3 := 1/sqrt(pointRatio+3.2)
//     tC4 := 1/sqrt(pointRatio+4.2)
//     radiusJitter := rnd.NextFloat()/2 + 2   *** RNG CALL ***
//     if pointCount <= 3 { pointRatio = 0 }            (AFTER tC1..tC4, BEFORE tC5)
//     tC5 := 1/sqrt(radiusJitter+pointRatio)
//     crackRoll := rnd.NextFloat()            *** RNG CALL ***
//     crackRollOk := crackRoll < 0.95
//     crackRollOk's 0.95 is HARDCODED -- NOT the generate_crack_chance schema
//     field, despite Microsoft's own worked example coincidentally setting that
//     field to 0.95 too. generate_crack_chance and base_crack_size are
//     schema-required and validated at build time, but placement never reads
//     either of them.
//  4. Per distribution point (pointCount iterations, no retry -- see
//     the invalid_blocks_threshold abort below): (a) dx := drawIntRange(
//     min_outer_wall_distance, max_outer_wall_distance, rnd), (b) dy same range,
//     (c) dz same range -- x,y,z in that exact order,
//     THEN (d), gated on max_point_offset>min_point_offset, offset :=
//     drawIntRange(min_point_offset, max_point_offset, rnd) (else offset=0, no
//     draw). The geode-support check is made BEFORE that offset draw (no RNG) and a
//     failure compares the running invalid counter against
//     invalid_blocks_threshold: at or above it placement fails ON THE
//     SPOT, so the offending point spends no offset draw, is never
//     stored, and no later point is drawn at all. Below it the counter
//     increments and the point is stored like any other -- an "invalid" point
//     that does not trip the threshold still becomes a real distribution
//     point, exactly Java vanilla's own geode algorithm.
//  5. If step 3's crack roll succeeded: ONE more draw, rnd.NextIntBound(4),
//     selecting one of 4 crack-line shapes (see "CRACK-LINE GEOMETRY" below).
//     None of the 4 shapes makes any further draws.
//  6. Per-column classification (a concentric-shell geode: outer -> middle ->
//     layer0 (inner/alternate) -> filler, density-ordered from a fastInvSqrt
//     point-distance-field sum, matching Microsoft's docs' own "distance field"
//     description). EVERYTHING in this cascade is float32 -- the accumulator,
//     the noise term, all five thresholds -- and fastInvSqrt is the game's
//     Quake bit hack, not a reciprocal square root; see fastInvSqrt's own comment:
//     density := (sum over distribution points of fastInvSqrt(distSq+offset))
//     + pointCount*NormalNoise.Sample(pos)*noise_multiplier
//     if density < tC4:            nothing (outside the geode entirely)
//     elif crackRollOk && crackLineSum + pointCount*noiseTerm >= tC5 &&
//     density < tC1: crack-carve. (The noise term is the SAME one the
//     density carries and is added to the crack sum separately, as its own
//     multiply-then-add. When crackRollOk is false there is no crackLine
//     and the sum is 0, which never clears a positive tC5.)
//     elif density >= tC1:         filler
//     elif density >= tC2:         layer0 -- THEN, unconditionally:
//     altRoll := rnd.NextFloat()                     *** RNG CALL ***
//     useAlternate := altRoll < use_alternate_layer0_chance
//     layer0Block := alternate_inner_layer if useAlternate else inner_layer
//     IF NOT (useAlternate==false AND placements_require_layer0_alternate):
//     potentialRoll := rnd.NextFloat()           *** RNG CALL, CONDITIONAL ***
//     if potentialRoll < use_potential_placements_chance:
//     append pos to the potential-placements list (drained in
//     step 7 below)
//     (so: one unconditional plus one conditional float draw, and BOTH
//     only within the layer0 density band -- not "two, always, every column")
//     elif density < tC3:          outer_layer  (tC4 <= density < tC3)
//     else:                        middle_layer (tC3 <= density < tC2)
//  7. Once per potential-placement position: ONE
//     rnd.NextIntBound(len(inner_placements)) draw picks an entry, THEN a
//     bud-growth face scan AND an anchor-support check gate the actual
//     write -- see "BUD PLACEMENT" below for both.
//
// X/Y/Z TRAVERSAL ORDER: NOT a plain ascending sweep.
// X walks origin.x .. origin.x+max_radius ascending FIRST, then
// origin.x-1 .. origin.x-max_radius descending SECOND (two separate loops).
// For each X, Y does the identical up-then-down split around origin.y. For
// each (X,Y), Z is a single ascending pass over
// origin.z-max_radius..origin.z+max_radius.
// This order is preserved exactly here because it is the
// only thing that determines which specific column receives which specific
// float draw when the RNG stream is shared across an entire geode.
//
// Random-surface widening: NormalNoise construction needs the raw generator
// step (NextUint32, for MultiOctaveNoise's octave-skip consumeCount
// path -- see noise/normal_noise.go), which random.IRandom does not expose.
// Rather than widening IRandom itself, this file defines a small
// LOCAL interface (geodeRandom) requiring IRandom's existing surface PLUS
// NextUint32, and type-asserts ctx.Random against it at Place() time. Every
// concrete IRandom this codebase's production path constructs (*random.Rand,
// via session.go's `random.New(seed)`) already satisfies it; geode_test.go
// defines its own local test recorder satisfying the same interface, rather
// than extending random.Tracer.
//
// CRACK-LINE GEOMETRY:
//
// The game builds a literal 3-point block-position list, crackLine (the
// SAME list step 6's crackLineSum consumes), Y = origin.Y+7, then +5,
// then +1. X and Z each independently either stay at origin.X/origin.Z or
// get offset by span := (2*pointCount)|1, DEPENDING ON WHICH of the 4 values
// (0-3) step 5's `rnd.NextIntBound(4)` draw returned:
//
//	branch 0 (fallthrough/default): X=origin.X+span, Z=origin.Z        (X-axis offset only)
//	branch 1:                       X=origin.X,      Z=origin.Z+span  (Z-axis offset only)
//	branch 2:                       X=origin.X+span, Z=origin.Z+span  (diagonal, both offset)
//	branch 3:                       X=origin.X,      Z=origin.Z        (no offset, straight up)
//
// This is geodeCrackLinePoints, wired into Place() as
// `crackLine = geodeCrackLinePoints(origin, pointCount, branch)` -- see
// TestGeodeCrackLinePoints_* and TestGeodeFeature_CrackLine_ForcedBranchesDivergeInGeometry.
// generate_crack_chance gates nothing at runtime (the roll is against a
// hardcoded 0.95 -- see step 3 above) and base_crack_size is never read by
// placement either; no diagnostic exists for them beyond this comment (a
// diagnostic exists for what visibly refuses, and cracks visibly fire).
//
// BUD PLACEMENT -- potential-placement face selection AND anchor-support check:
//
// The budding amethyst block's bud-growth check is: the position is air, or
// water (a material-type test against index 5 -- the same test
// partially_exposed_blob.go's isWaterBlock implements, reused here verbatim).
// The bud's FacingDirection block state is derived from the chosen face:
//
//   - the bud-growth check -> isAir(neighbor) || isWaterBlock(neighbor), reusing
//     this package's existing isWaterBlock helper (partially_exposed_blob.go)
//     exactly, not a new approximation of what "water" means.
//   - Face SEARCH ORDER is the game's face iteration order {1,0,2,3,4,5}
//     -- Up, Down, North, South, West, East, NOT
//     partiallyExposedBlobFacingOffsets' own Down-first declaration order
//     (geodeAllFacesSearchOrder indexes into that same offset table in the
//     game's face iteration order instead of redeclaring the six offsets).
//   - FacingDirection is block.FacingDirection (block/state.go), with
//     ValueCount=6 -- see block/state.go's own doc comment.
//     block.Palette.WithIntState(placeID, block.FacingDirection,
//     face) derives the faced block, applied unconditionally (this palette
//     has no block-type state-presence query to gate on -- see block/state.go's
//     FacingDirection doc comment for why that inherits WithIntState's own
//     already-documented scope).
//
// The placement check:
//
//  1. Everything a vanilla geode places (amethyst_cluster plus the three bud
//     stages) is the same amethyst cluster block type -- the game registers
//     exactly those four ids as that type. That type's placement check is one
//     line, no base call: `return getBlock(pos.neighbor(opposite(face))).canProvideFullSupport(face)`.
//     (In 1.26.50.24 the amethyst cluster block derives from a new crystal
//     cluster base that owns this check; the behaviour is identical.) In the
//     geode's own calling shape (neighbor := pos.relative(face,1); the check
//     called on that neighbor with the SAME face), the anchor computation
//     cancels back to the PRE-face pos itself -- anchor =
//     neighbor.neighbor(opposite(face)) = (pos+offset(face)) - offset(face) =
//     pos -- regardless of which face won the bud-growth scan. So the placement
//     check here is exactly "does the geode's own potential-placement position
//     still provide full support," face-independent, checkable once per
//     potential position rather than once per candidate face.
//  2. The generic block placement check a non-overriding type would fall
//     through to is NOT `return true`: it is a y-bounds + canBeBuiltOver +
//     mayPlaceOn(below) chain. It is unreachable on this path for vanilla
//     content (the amethyst cluster block's check fully replaces it), so it
//     changes nothing here.
//
// For a full-cube anchor, the full-support test bottoms out in a block-type
// flag ("provides full support on any face") that vanilla full cubes carry
// unconditionally. This port's existing block.Kind classification
// (block/kind.go) already IS this codebase's "is this a full cube"
// predicate -- KindSolid is exactly what every other full-cube/support check in this package
// gates on (structure_template.go, scatter.go, sculk_patch.go, vegetation_patch.go all use
// Palette.IsSolid the same way) -- so the check needs no new subsystem, just geodeMayPlace
// below: `api.Palette().IsSolid(api.GetBlock(pos))`, pos being the ORIGINAL potential-placement
// position (the geode's own layer0 block), not the neighbor.
//
// The check matters in exactly two situations: (a) the crack carve removed
// the anchor before the drain reads it back, or (b) a config's inner_layer/
// alternate_inner_layer resolves to a non-full-cube or liquid block. Otherwise
// nothing in Place() erases a layer0 block before step 7 runs. See
// TestGeodeFeature_MayPlace_SolidAnchorPlacesCluster/
// _NonSolidAnchorRefusesCluster for the pinned "solid anchor -> placed, non-solid anchor ->
// refused" integration behavior, TestGeodeMayPlace_* for geodeMayPlace as a pure function, and
// TestGeodeFeature_MayPlaceCheck_DoesNotAffectRNGDrawSequence for the no-new-draws proof
// (geodeMayPlace makes no RNG calls; the game's placement check takes no
// generator either -- just the world, a position and a face).
//
// PLACEMENT FILTER -- see block/tags.go's own "minecraft:placement_filter"
// section for the component's face+anchor+block_filter logic, the per-face
// bit and opposite-face tables, and the allowed_faces string->bitmask table.
//
// The game's full placement check ANDs the per-block-type check with the
// block's minecraft:placement_filter component, when the block carries one.
// block/tags.go's LoadBlockTags parses "minecraft:placement_filter" --
// conditions, each an allowed_faces bitmask plus a block_filter
// block-descriptor list matched via this codebase's existing MatchSet
// predicate machinery -- and block.Palette.PlacementFilterAllows evaluates it
// ANDed into the per-block-type result ONLY when the component is present,
// using the SAME anchor position (pos) and the SAME already-picked face
// geodeMayPlace and geodePickFace already established for this calling shape.
// Vanilla amethyst clusters carry no such component (see block/vanilla/blocks/ -- zero generated
// files reference "placement_filter"), so this matters only for a pack's OWN custom
// inner_placements block that declares one; every vanilla config's placed counts are unchanged (see
// TestGeodeFeature_PlacementFilter_VanillaConfigUnaffectedByCheck).
//
// Residual (both INFERRED; ONE disclosed by a runtime LogWarning, ONE deliberately not):
//   - The game's placement check ANDs in a LAST step, a multi-block component
//     check, present ONLY if the block carries that data-driven component.
//     That check requires the candidate block to carry a
//     built-in multi-block-part state and then walks the structure's OTHER
//     parts, in local and world space, testing each computed part's
//     own position -- none of which (part geometry, a multi-block-part-shaped block state,
//     part traversal) this codebase's block/state.go or pack JSON parsing represents anywhere;
//     it would be a genuinely new subsystem (multi-part block geometry).
//     Vanilla amethyst clusters carry no such component,
//     so this port is exactly right for vanilla inner_placements,
//     and DISCLOSES NOTHING for it: warning on every vanilla placement to name a risk that
//     cannot apply there trains the user to ignore the diagnostic, which then hides the case where it
//     is real. So Place()'s drain loop (below) fires LogWarning ONLY when the picked
//     inner_placements entry's resolved name is outside vanillaAmethystClusterBlockNames (the
//     complete set of ids the game registers as the amethyst cluster block
//     type -- see that var's own doc comment), naming the offending id,
//     and AT MOST ONCE per Place() call (LogWarning itself has no dedup -- see shared.go's own doc
//     comment -- so without this gate a geode placing forty clusters would emit forty identical
//     diagnostics).
//   - The full-cube support flag is set when the block type is registered,
//     from the block's collision shape (INFERRED: every plain full-cube vanilla
//     block takes that path; not exhaustively enumerated). This port's own block.Kind/
//     KindSolid table (block/kind.go) is itself a hand-curated approximation of the same "is this
//     a full cube" fact, already relied on unwarned everywhere else in this package.
//     Deliberately NO runtime diagnostic for this one: it is a property of this
//     bench's whole block model (every IsSolid call in this package rests on it, unwarned),
//     and it would fire on literally every geode placement.
//
// geodeIntRange vs. treeIntRangeValue: see step 1 above -- kept as two
// separate functions deliberately, not a refactor of one into the other,
// because the game uses two genuinely different draws
// (the two-argument integer draw vs. the int-range draw) that happen to look
// alike but disagree at one boundary value.
package features

import (
	"fmt"
	"math"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/noise"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const geodeTypeID = "minecraft:geode_feature"

// geodeRandom widens random.IRandom with the raw generator step
// (NextUint32) noise.Random additionally requires -- see this file's header,
// "Random-surface widening". Every concrete IRandom this codebase's
// production path constructs already satisfies it.
type geodeRandom interface {
	random.IRandom
	NextUint32() uint32
}

// geodeIntRange mirrors the game's two-argument integer draw exactly
// (NOT tree.go's treeIntRangeValue, and NOT the game's int-range draw -- see
// this file's header for why they differ): zero draws when max<=min, otherwise exactly
// one rnd.NextIntBound(max-min) draw, added to min.
func geodeIntRange(min, max int, rnd random.IRandom) int {
	if max <= min {
		return min
	}
	return min + rnd.NextIntBound(max-min)
}

// geodeStatePalette narrows wgen.IPaletteView to the extra capabilities this
// file's inner_placements handling needs beyond IPaletteView's own surface
// (block.Palette.WithIntState for the FacingDirection derivation,
// block.Palette.PlacementFilterAllows for the placement-filter component's
// step -- see the header's "PLACEMENT FILTER") -- the exact same "widen via a
// small local interface, type-assert at Place() time" shape this file
// already uses for geodeRandom/NextUint32, and for the identical reason:
// adding either to wgen.IPaletteView itself would widen every
// BlockWorld implementation this codebase has, for capabilities only
// this one type currently needs. volume.Volume.Palette() (this codebase's
// only production IPaletteView) already satisfies it, since it always
// returns a *block.Palette under the interface.
type geodeStatePalette interface {
	WithIntState(id block.ID, field block.StateField, newValue int) (block.ID, bool)
	PlacementFilterAllows(id block.ID, face int, anchorID block.ID) bool
}

// geodeAllFacesSearchOrder is the game's face iteration order
// {1,0,2,3,4,5} -- Up, Down, North, South, West, East,
// in that exact order. This indexes partiallyExposedBlobFacingOffsets
// (Down=0,Up=1,North=2,South=3,West=4,East=5 -- that slice's own declaration
// order) rather than redeclaring the six offsets a second time; the ORDER
// here is what matters and is deliberately NOT partiallyExposedBlobFacingOffsets'
// own Down-first order -- see this file's header, "BUD PLACEMENT".
var geodeAllFacesSearchOrder = [6]int{1, 0, 2, 3, 4, 5}

// geodeCrackLinePoints mirrors the literal 3-point block-position list the
// game builds for whichever of the 4 crack-branch values
// step 5's `rnd.NextIntBound(4)` draw returns -- see this file's header,
// "CRACK-LINE GEOMETRY". Y is always
// origin.Y+7, then +5, then +1 (three hardcoded offsets);
// X and Z are each independently either left at origin.X/origin.Z or offset
// by span, depending on branch (0-3, the raw `rnd.NextIntBound(4)` result --
// any other value is outside the game's own domain and returns no points;
// the game has no fifth case).
func geodeCrackLinePoints(origin wgen.BlockPos, pointCount, branch int) []wgen.BlockPos {
	span := 2*pointCount | 1 // the game computes exactly (2*pointCount)|1
	var dx, dz int
	switch branch {
	case 0:
		dx = span
	case 1:
		dz = span
	case 2:
		dx, dz = span, span
	case 3:
		// no offset -- straight up from origin
	default:
		return nil
	}
	pts := make([]wgen.BlockPos, 0, 3)
	for _, dy := range [3]int{7, 5, 1} { // three hardcoded offsets, see header
		pts = append(pts, wgen.BlockPos{X: origin.X + dx, Y: origin.Y + dy, Z: origin.Z + dz})
	}
	return pts
}

// geodeInvalidMaterials mirrors the geode feature's own invalid-material list
// -- canonical names canSupportGeode rejects outright.
var geodeInvalidMaterials = map[string]bool{
	"minecraft:bedrock":    true,
	"minecraft:packed_ice": true,
	"minecraft:blue_ice":   true,
}

// geodeDistPoint is one distribution point: an absolute position plus its
// own drawn distance-field offset (step 4d).
type geodeDistPoint struct {
	pos wgen.BlockPos
	// offset is held UNSIGNED because the game holds it that way: the
	// distribution point is a {int x, int y, int z, uint offset} record
	// and the density loop converts that field as UNSIGNED, so a negative
	// min_point_offset does not shrink the field -- it turns into ~4.29e9.
	offset uint32
}

// GeodeFeature is minecraft:geode_feature. A leaf type -- no feature
// delegation, so it is always in scope.
type GeodeFeature struct {
	identifier string

	filler              block.ID
	innerLayer          block.ID
	alternateInnerLayer block.ID
	middleLayer         block.ID
	outerLayer          block.ID
	innerPlacements     []block.Descriptor

	minOuterWallDistance             int
	maxOuterWallDistance             int
	minDistributionPoints            int
	maxDistributionPoints            int
	minPointOffset                   int
	maxPointOffset                   int
	maxRadius                        int
	crackPointOffset                 int
	generateCrackChance              float64 // schema-required, validated, not read by place() -- see header
	baseCrackSize                    float64 // schema-required, validated, not read by place() -- see header
	noiseMultiplier                  float64
	usePotentialPlacementsChance     float64
	useAlternateLayer0Chance         float64
	placementsRequireLayer0Alternate bool
	invalidBlocksThreshold           int
}

func (f *GeodeFeature) TypeID() string     { return geodeTypeID }
func (f *GeodeFeature) Identifier() string { return f.identifier }

// canSupportGeode mirrors the geode feature's own geode-support check --
// the game checks both the primary and the legacy block layer; this port's
// world model does not carry that distinction, so it is one GetBlock lookup
// (the same precedent as partially_exposed_blob.go's header).
func (f *GeodeFeature) canSupportGeode(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	name := api.Palette().NameOf(api.GetBlock(pos))
	return !geodeInvalidMaterials[name]
}

// Place mirrors the geode feature's placement step-by-step -- see
// module header for the full description.
func (f *GeodeFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, geodeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	nr, ok := rnd.(geodeRandom)
	if !ok {
		// Every real IRandom this codebase's production path constructs
		// satisfies this -- see header's "Random-surface widening".
		panic(fmt.Sprintf("minecraft:geode_feature: ctx.Random (%T) does not expose NextUint32, needed for its unconditional NormalNoise construction", rnd))
	}

	// Step 1: distribution point count.
	pointCount := geodeIntRange(f.minDistributionPoints, f.maxDistributionPoints, rnd)

	// Step 2: NormalNoise, unconditional, before any schema-gated branch.
	noiseGen := noise.New(nr, -4, []float32{1.0})

	// Step 3: five threshold constants + radius jitter + crack roll.
	//
	// EVERY value in this cascade is float32 in the game and is float32
	// here: the division is single-precision, the four constants 1.7, 2.2,
	// 3.2 and 4.2 are single-precision, each reciprocal is a
	// single-precision square root followed by a single-precision divide,
	// and all five are kept as float32 for the per-column pass. The density
	// they are compared against is a float32 accumulator too (see below), so
	// computing them in float64 shifted comparisons in the low bits.
	pointRatio := float32(pointCount) / float32(f.maxOuterWallDistance)
	tC1 := 1.0 / sqrt32(1.7)
	tC2 := 1.0 / sqrt32(pointRatio+2.2)
	tC3 := 1.0 / sqrt32(pointRatio+3.2)
	tC4 := 1.0 / sqrt32(pointRatio+4.2)
	// The inner float32() is a rounding barrier: the game divides by 2.0f
	// and THEN adds, as two separately rounded single-precision steps. gc
	// rewrites /2 as *0.5 and on arm64 fuses that multiply into the add,
	// giving one rounding where the game has two; the conversion forbids
	// the fusion. See features/fmafusion_test.go.
	radiusJitter := float32(float32(rnd.NextFloat())/2) + 2 // *** RNG CALL ***
	if pointCount <= 3 {
		pointRatio = 0
	}
	tC5 := 1.0 / sqrt32(radiusJitter+pointRatio)
	crackRoll := float32(rnd.NextFloat()) // *** RNG CALL ***
	// 0.95f exactly as the game has it: a single-precision compare
	// against a constant, with no config field involved.
	crackRollOk := crackRoll < 0.95

	// Step 4: per distribution point. No retry: an "invalid" point still
	// gets stored, only the running invalid counter changes -- see header.
	points := make([]geodeDistPoint, 0, pointCount)
	invalidCount := 0
	for i := 0; i < pointCount; i++ {
		TickDeadline("building the distribution points its min/max_distribution_points ask for")
		dx := geodeIntRange(f.minOuterWallDistance, f.maxOuterWallDistance, rnd)
		dy := geodeIntRange(f.minOuterWallDistance, f.maxOuterWallDistance, rnd)
		dz := geodeIntRange(f.minOuterWallDistance, f.maxOuterWallDistance, rnd)
		pos := wgen.BlockPos{X: origin.X + dx, Y: origin.Y + dy, Z: origin.Z + dz}

		if !f.canSupportGeode(api, pos) {
			// The abort is IMMEDIATE: the running invalid count is compared
			// against invalid_blocks_threshold BEFORE it is incremented, and
			// reaching it fails placement on the spot. So the
			// point that tripped it never draws its own point-offset, never
			// joins the list, and no later point is drawn at all. Finishing the
			// loop instead would spend draws the game never spends -- with
			// invalid_blocks_threshold 0 and three points, 12 draws where the
			// game makes 3.
			if invalidCount >= f.invalidBlocksThreshold {
				LogFailure(ctx, geodeTypeID, "No surrounding blocks could support the geode")
				return nil
			}
			invalidCount++
		}

		offset := 0
		if f.maxPointOffset > f.minPointOffset {
			offset = geodeIntRange(f.minPointOffset, f.maxPointOffset, rnd) // *** RNG CALL (d) ***
		}
		points = append(points, geodeDistPoint{pos: pos, offset: uint32(int32(offset))})
	}

	// Step 5: crack-branch selector, driving the crack-line geometry -- see
	// header's "CRACK-LINE GEOMETRY".
	var crackLine []wgen.BlockPos
	if crackRollOk {
		branch := rnd.NextIntBound(4) // *** RNG CALL -- selector, drives geodeCrackLinePoints ***
		crackLine = geodeCrackLinePoints(origin, pointCount, branch)
	}

	// Step 6: per-column classification, over the X/Y/Z
	// traversal order (X up-then-down, Y up-then-down per X, Z ascending
	// inside -- see header).
	placedAny := false
	var potentialPositions []wgen.BlockPos

	visitColumn := func(x, y int) {
		for z := origin.Z - f.maxRadius; z <= origin.Z+f.maxRadius; z++ {
			// The deadline's only view of this feature. Every one of the four nested walks below
			// funnels through this z loop, and its `density < tC4 -> continue` path takes no
			// write and no draw, so neither of the other two budgets can see a max_radius that is
			// three orders of magnitude too large. Ticked here, per column-step, rather than in
			// the per-distribution-point density sum just below it: that sum is this feature's
			// genuinely hot inner loop, and it is bounded by max_distribution_points, which the
			// step-4 tick above already walks once at the same scale.
			TickDeadline("scanning the block volume its max_radius covers")
			pos := wgen.BlockPos{X: x, Y: y, Z: z}

			// The distance-field sum: the squared distance is built in 64-bit
			// INTEGER arithmetic, only then converted to floating point as
			// UNSIGNED, the point's offset is added as a float32, and the
			// accumulator itself is a float32 seeded at zero.
			distSum := float32(0)
			for _, p := range points {
				dx := int64(pos.X - p.pos.X)
				dy := int64(pos.Y - p.pos.Y)
				dz := int64(pos.Z - p.pos.Z)
				distSum += fastInvSqrt(float32(uint64(dx*dx+dy*dy+dz*dz)) + float32(p.offset))
			}
			// noise * noise_multiplier is formed FIRST (before the point
			// loop even starts), then scaled by
			// the point count and added.
			noiseVal := float32(noiseGen.Sample(float64(pos.X), float64(pos.Y), float64(pos.Z))) * float32(f.noiseMultiplier)
			// float32() around the product is a rounding barrier: the game
			// multiplies and then adds, as two separate roundings.
			density := distSum + float32(float32(pointCount)*noiseVal)

			if density < tC4 {
				continue // outside the geode entirely
			}

			// Same barrier: the game multiplies and then adds as two separate
			// roundings here too.
			if crackRollOk && crackLineSum(crackLine, pos, float32(f.crackPointOffset))+float32(float32(pointCount)*noiseVal) >= tC5 && density < tC1 {
				// crack-carve.
				if api.SetBlock(pos, block.AirID) {
					placedAny = true
				}
				continue
			}

			switch {
			case density >= tC1:
				if api.SetBlock(pos, f.filler) {
					placedAny = true
				}
			case density >= tC2:
				altRoll := rnd.NextFloat() // *** RNG CALL ***
				useAlternate := altRoll < f.useAlternateLayer0Chance
				layer0 := f.innerLayer
				if useAlternate {
					layer0 = f.alternateInnerLayer
				}
				if api.SetBlock(pos, layer0) {
					placedAny = true
				}
				if useAlternate || !f.placementsRequireLayer0Alternate {
					potentialRoll := rnd.NextFloat() // *** RNG CALL, CONDITIONAL ***
					if potentialRoll < f.usePotentialPlacementsChance {
						potentialPositions = append(potentialPositions, pos)
					}
				}
			case density < tC3:
				if api.SetBlock(pos, f.outerLayer) {
					placedAny = true
				}
			default:
				if api.SetBlock(pos, f.middleLayer) {
					placedAny = true
				}
			}
		}
	}

	for x := origin.X; x <= origin.X+f.maxRadius; x++ {
		for y := origin.Y; y <= origin.Y+f.maxRadius; y++ {
			visitColumn(x, y)
		}
		for y := origin.Y - 1; y >= origin.Y-f.maxRadius; y-- {
			visitColumn(x, y)
		}
	}
	for x := origin.X - 1; x >= origin.X-f.maxRadius; x-- {
		for y := origin.Y; y <= origin.Y+f.maxRadius; y++ {
			visitColumn(x, y)
		}
		for y := origin.Y - 1; y >= origin.Y-f.maxRadius; y-- {
			visitColumn(x, y)
		}
	}

	// Step 7: potential-placement drain -- see header's "BUD PLACEMENT" for the
	// bud-growth check + FacingDirection derivation AND the placement-check anchor-support
	// check, plus the one residual disclosure neither of those covers.
	if len(f.innerPlacements) > 0 {
		sp, ok := api.Palette().(geodeStatePalette)
		if !ok {
			// Every real IPaletteView this codebase's production path constructs (volume.Volume's,
			// always backed by a *block.Palette) already satisfies this -- see geodeStatePalette.
			panic(fmt.Sprintf("minecraft:geode_feature: ctx.API.Palette() (%T) does not expose WithIntState, needed for inner_placements' FacingDirection derivation", api.Palette()))
		}
		nonVanillaWarned := false // see below -- at most ONE residual-component warning per Place() call
		for _, pos := range potentialPositions {
			TickDeadline("draining the bud positions its max_radius scan collected")
			pick := rnd.NextIntBound(len(f.innerPlacements)) // *** RNG CALL, one per potential position ***
			desc := f.innerPlacements[pick]
			placeID := ctx.API.Palette().Resolve(desc)

			neighbor, face, ok := geodePickFace(api, pos)
			if !ok {
				continue // no face's neighbor is empty/water -- the bud-growth check fails everywhere
			}
			if !geodeMayPlace(api, pos) {
				// The anchor (pos itself -- see geodeMayPlace's own doc comment for
				// why it does not depend on which face won the scan above) is not a full cube, so
				// the amethyst cluster block's placement check refuses on every face, not just
				// the one picked.
				// No RNG call happens on this path (see header's "no-new-draws proof").
				continue
			}
			// The placement-filter component step of the placement check (see header's
			// "PLACEMENT FILTER" and block/tags.go's own "minecraft:placement_filter"
			// section). anchorID is the SAME position
			// geodeMayPlace's own per-block-type check just used (pos itself -- both checks'
			// anchor computations cancel back to it in this exact calling shape). ANDed with the
			// per-block-type result above, as the game does.
			// PlacementFilterAllows returns true unconditionally for a block with no such
			// component (i.e. every vanilla amethyst cluster id), so this changes nothing for
			// vanilla inner_placements. No RNG call happens on this path either
			// (the placement filter consumes no randomness).
			anchorID := api.GetBlock(pos)
			if !sp.PlacementFilterAllows(placeID, face, anchorID) {
				continue
			}
			// The one residual disclosure (header's "Residual"):
			// the placement check's LAST step, a multi-block-component check, is
			// data-driven and only ever present on a NON-vanilla block -- vanillaAmethystClusterBlockNames
			// is the complete set of ids the game registers as the
			// amethyst cluster block type, and none of them carry it. Warning on every vanilla placement
			// (the common case, by far) would disclose a risk that cannot apply there,
			// train the user to ignore the diagnostic, and flood the panel (LogWarning has no
			// dedup -- shared.go's own doc comment). So this fires ONLY for a picked entry outside
			// that set, and at most ONCE per Place() call (not once per placement) -- enough to
			// tell the user THIS config has an entry this port cannot fully vouch for, without
			// repeating it per bud. The placement-filter component is deliberately NOT named here:
			// that check is evaluated above.
			pickedName := api.Palette().NameOf(placeID)
			if !nonVanillaWarned && !vanillaAmethystClusterBlockNames[pickedName] {
				nonVanillaWarned = true
				LogWarning(ctx, geodeTypeID,
					fmt.Sprintf("inner_placements block %q is not one of the four vanilla amethyst bud blocks. "+
						"The rules this tool uses to decide whether a bud can attach to a wall, and which way it "+
						"faces, are the ones the game applies to those four; a different block may legally carry "+
						"its own placement rules that this tool does not read, so where its buds end up here may "+
						"not be where the game puts them. The four vanilla buds preview accurately.", pickedName),
					nil)
			}
			faced, ok := sp.WithIntState(placeID, block.FacingDirection, face)
			if !ok {
				faced = placeID // matches the game's state-write-fails-keep-original fallback
			}
			if api.SetBlock(neighbor, faced) {
				placedAny = true
			}
		}
	}

	if !placedAny {
		LogFailure(ctx, geodeTypeID, "No blocks could be placed")
		return nil
	}
	result := origin
	return &result
}

// crackLineSum is the crack-line distance-field sum step 6's crack-carve
// check compares against tC5 -- crackLine is geodeCrackLinePoints' 3-point
// result when crackRollOk, nil otherwise (see header, "CRACK-LINE GEOMETRY"), so
// this returns 0 whenever there is no crack.
//
// Same shape as the density sum: int64 squared
// distance converted to float32 as UNSIGNED, crack_point_offset added as a
// SIGNED float (unlike the per-point offset, which is unsigned), float32
// accumulator.
// The caller adds pointCount * noise * noise_multiplier to the result before
// comparing it with tC5, as its own multiply-then-add --
// that term is NOT part of this function.
func crackLineSum(crackLine []wgen.BlockPos, pos wgen.BlockPos, offset float32) float32 {
	sum := float32(0)
	for _, p := range crackLine {
		dx := int64(pos.X - p.X)
		dy := int64(pos.Y - p.Y)
		dz := int64(pos.Z - p.Z)
		sum += fastInvSqrt(float32(uint64(dx*dx+dy*dy+dz*dz)) + offset)
	}
	return sum
}

// geodePickFace mirrors the budding amethyst block's bud-growth check
// (the position is air or water -- see header, "BUD PLACEMENT") applied to each of
// pos's six neighbors in the game's face iteration order (geodeAllFacesSearchOrder), returning
// the first
// neighbor position and face value (0-5, block.FacingDirection's own domain) that qualifies, or
// ok=false if none of the six do -- exactly the game's "try each face, stop at the first
// the position-level check accepts" shape. This is ONLY the bud-growth check; the placement
// check's own anchor-support check is geodeMayPlace below, called separately by Place() because (per the
// header's "BUD PLACEMENT") it does not depend on which face this function picks.
func geodePickFace(api wgen.BlockWorld, pos wgen.BlockPos) (neighbor wgen.BlockPos, face int, ok bool) {
	pal := api.Palette()
	for _, f := range geodeAllFacesSearchOrder {
		off := partiallyExposedBlobFacingOffsets[f]
		n := wgen.BlockPos{X: pos.X + off.X, Y: pos.Y + off.Y, Z: pos.Z + off.Z}
		b := api.GetBlock(n)
		if pal.IsAir(b) || isWaterBlock(pal, b) {
			return n, f, true
		}
	}
	return wgen.BlockPos{}, 0, false
}

// vanillaAmethystClusterBlockNames is the COMPLETE set of ids the game registers as
// the amethyst cluster block type -- exactly four (amethyst cluster plus the large, medium and
// small buds), with no other block of that type and no separate bud type. Used to
// gate the one residual disclosure in Place(): for anything IN this set, this port's
// geodeMayPlace is a complete, correct model of the amethyst cluster block's
// placement check
// (none of the four carries the data-driven components). For anything NOT in this
// set -- a behavior/resource pack's own custom inner_placements block -- this port has no way to
// know what block type that id actually is, so it cannot rule out a
// placement-filter or multi-block component the game would also consult.
// This is a reliable check, not a heuristic: it is an exact-name lookup against an
// exhaustively enumerated set (the same "small hand-curated exact-name table" shape this file's own
// geodeInvalidMaterials and block/kind.go's tagRepresentativeBlock already use), not a guess at
// what an arbitrary block might be.
var vanillaAmethystClusterBlockNames = map[string]bool{
	"minecraft:amethyst_cluster":    true,
	"minecraft:large_amethyst_bud":  true,
	"minecraft:medium_amethyst_bud": true,
	"minecraft:small_amethyst_bud":  true,
}

// geodeMayPlace mirrors the block's placement check (world, position, face) for the ONLY
// per-block-type rule that applies to anything a vanilla geode places -- the amethyst cluster
// block's placement check (from 1.26.50.24 owned by the new crystal cluster base type, with
// identical behaviour).
// It is one line: take the block one step opposite the face and ask its own
// full-support test about that face (see header, "BUD PLACEMENT").
// In the geode's own calling shape, that rule's anchor position always
// cancels back to pos -- the ORIGINAL potential-placement position (the geode's own layer0 block),
// NOT the neighbor geodePickFace returns -- regardless of face, so this takes pos alone and is
// called once per potential position, not once per candidate face. The full-support test bottoms
// out, for a full cube, in a flag on the block type; this port's existing
// block.Kind classification (KindSolid, block/kind.go) already IS this codebase's "is this a full
// cube" predicate -- the same one every other support/solidity check in this package uses
// (structure_template.go, scatter.go, sculk_patch.go, vegetation_patch.go) -- so no new subsystem
// is needed here, only a GetBlock+IsSolid test. Makes no RNG calls (the game's placement
// check consumes no randomness).
func geodeMayPlace(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	return api.Palette().IsSolid(api.GetBlock(pos))
}

// fastInvSqrt is a BIT-EXACT reproduction of the game's
// fast inverse square root -- not an equivalent formula but the same
// operations, in the same order, at the same precision. It is the canonical Quake III reciprocal
// square root: one magic constant, ONE Newton step, float32 throughout.
// Bit-exactness is the whole reason this function exists rather than a call to
// the standard library: its result is summed over every distribution point and
// the total is compared against a threshold, so a value that differs in the
// last bit can move a cell from one geode shell to another.
//
// `1 / math.Sqrt(x)` in float64 is NOT a substitute, even though "both are
// monotonic": monotonicity of a term does not survive SUMMING several
// of them and comparing the total against a threshold. Measured over twelve
// seeds, hundreds of cells changed shell identity in every
// seed and the geode's own draw count differed in eleven of the twelve
// (907/909, 358/355, 1092/1088, 1149/1141), because a cell crossing into or
// out of the layer-0 band adds or removes its own altRoll/potentialRoll.
//
// There is no guard on x. The game has none either, and it matters: a
// column sitting exactly on a distribution point gives x == 0, for which this
// returns ~1.98e19 rather than the +Inf a float64 version would produce. Both
// land in the same (filler) branch, but only one of them is what the game
// computes.
//
// The two explicit float32() conversions in the Newton step are rounding
// barriers, not noise. The game's step is four separate single-precision
// operations -- multiply, multiply, subtract from 1.5, multiply -- so (x2*y)*y
// is rounded BEFORE the 1.5 - subtract, and the final y*(...) is rounded before
// it returns to a caller that adds it into an accumulator. gc on arm64 would
// otherwise fuse the first multiply and subtract into a single fused
// multiply-add here and -- because this function inlines -- fuse the second
// into the caller's own `distSum +=` addition, giving ONE rounding where the
// game has TWO at each site, and a different value. See
// features/fmafusion_test.go.
func fastInvSqrt(x float32) float32 {
	i := int32(0x5F3759DF) - int32(math.Float32bits(x))>>1
	y := math.Float32frombits(uint32(i))
	half := 0.5 * x
	t := 1.5 - float32(half*y*y)
	return float32(y * t)
}

// sqrt32 is a single-precision square root: the game's threshold cascade takes
// float32 square roots, and rounding the float64 result afterwards is not the
// same value.
func sqrt32(x float32) float32 { return float32(math.Sqrt(float64(x))) }

func buildGeodeFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	blockField := func(key string) (block.ID, error) {
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
	filler, err := blockField("filler")
	if err != nil {
		return nil, err
	}
	innerLayer, err := blockField("inner_layer")
	if err != nil {
		return nil, err
	}
	alternateInnerLayer, err := blockField("alternate_inner_layer")
	if err != nil {
		return nil, err
	}
	middleLayer, err := blockField("middle_layer")
	if err != nil {
		return nil, err
	}
	outerLayer, err := blockField("outer_layer")
	if err != nil {
		return nil, err
	}

	innerPlacements, err := AsBlockDescriptorList(body["inner_placements"], "inner_placements")
	if err != nil {
		return nil, err
	}

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

	minOuterWallDistance, err := intField("min_outer_wall_distance", 1, 10)
	if err != nil {
		return nil, err
	}
	maxOuterWallDistance, err := intField("max_outer_wall_distance", 1, 20)
	if err != nil {
		return nil, err
	}
	minDistributionPoints, err := intField("min_distribution_points", 1, 10)
	if err != nil {
		return nil, err
	}
	maxDistributionPoints, err := intField("max_distribution_points", 1, 20)
	if err != nil {
		return nil, err
	}
	minPointOffset, err := intField("min_point_offset", 0, 10)
	if err != nil {
		return nil, err
	}
	maxPointOffset, err := intField("max_point_offset", 0, 10)
	if err != nil {
		return nil, err
	}
	maxRadiusRaw, ok := body["max_radius"]
	if !ok {
		return nil, fmt.Errorf("max_radius is required")
	}
	maxRadiusF, ok := toFloat(maxRadiusRaw)
	if !ok || maxRadiusF != float64(int(maxRadiusF)) {
		return nil, fmt.Errorf("max_radius must be an integer")
	}
	// The round-trip test above is meant to refuse any value that does not survive the conversion
	// to int, and it has exactly ONE false negative: math.MinInt64 converts to itself and round-
	// trips back to itself, so `"max_radius": -9223372036854775808` sails through. It is also the
	// value Go's implementation-defined float64->int conversion produces on amd64 for anything
	// outside int64's range, which is how a pack reaches it without typing nineteen digits.
	//
	// The consequence is not a wrong geode, it is a WEDGED PROCESS: Place walks
	// `for x := origin.X - 1; x >= origin.X - f.maxRadius; x--`, and with maxRadius at MinInt64
	// that bound itself overflows back to MinInt64, so `x >= math.MinInt64` is true for every int
	// there is and the loop never ends. No allocation, no write, no draw -- so neither the write
	// budget nor the delegation budget nor the wall-clock deadline (checked only on delegation,
	// and a geode never delegates) can interrupt it. One pinned CPU, forever, with nothing said.
	//
	// Closing the guard's own hole rather than adding a new bound: the only input this newly
	// refuses is the one the existing test already intended to catch and missed.
	if maxRadius := int(maxRadiusF); maxRadius == math.MinInt64 {
		return nil, fmt.Errorf("max_radius is %g, which does not fit in an integer -- it wraps, and "+
			"the wrapped value makes this feature's own scan run forever. Write a real radius "+
			"(vanilla amethyst geodes use 16)", maxRadiusF)
	}
	maxRadius := int(maxRadiusF)
	crackPointOffset, err := intField("crack_point_offset", 0, 10)
	if err != nil {
		return nil, err
	}
	generateCrackChance, err := floatField("generate_crack_chance", 0.0, 1.0)
	if err != nil {
		return nil, err
	}
	baseCrackSize, err := floatField("base_crack_size", 0.0, 5.0)
	if err != nil {
		return nil, err
	}
	noiseMultiplierRaw, ok := body["noise_multiplier"]
	if !ok {
		return nil, fmt.Errorf("noise_multiplier is required")
	}
	noiseMultiplier, ok := toFloat(noiseMultiplierRaw)
	if !ok {
		return nil, fmt.Errorf("noise_multiplier must be a number")
	}
	usePotentialPlacementsChance, err := floatField("use_potential_placements_chance", 0.0, 1.0)
	if err != nil {
		return nil, err
	}
	useAlternateLayer0Chance, err := floatField("use_alternate_layer0_chance", 0.0, 1.0)
	if err != nil {
		return nil, err
	}
	placementsRequireRaw, ok := body["placements_require_layer0_alternate"]
	if !ok {
		return nil, fmt.Errorf("placements_require_layer0_alternate is required")
	}
	placementsRequire, ok := placementsRequireRaw.(bool)
	if !ok {
		return nil, fmt.Errorf("placements_require_layer0_alternate must be a boolean")
	}
	invalidBlocksThresholdRaw, ok := body["invalid_blocks_threshold"]
	if !ok {
		return nil, fmt.Errorf("invalid_blocks_threshold is required")
	}
	invalidBlocksThresholdF, ok := toFloat(invalidBlocksThresholdRaw)
	if !ok || invalidBlocksThresholdF != float64(int(invalidBlocksThresholdF)) {
		return nil, fmt.Errorf("invalid_blocks_threshold must be an integer")
	}

	return &GeodeFeature{
		identifier:                       ctx.Identifier,
		filler:                           filler,
		innerLayer:                       innerLayer,
		alternateInnerLayer:              alternateInnerLayer,
		middleLayer:                      middleLayer,
		outerLayer:                       outerLayer,
		innerPlacements:                  innerPlacements,
		minOuterWallDistance:             minOuterWallDistance,
		maxOuterWallDistance:             maxOuterWallDistance,
		minDistributionPoints:            minDistributionPoints,
		maxDistributionPoints:            maxDistributionPoints,
		minPointOffset:                   minPointOffset,
		maxPointOffset:                   maxPointOffset,
		maxRadius:                        maxRadius,
		crackPointOffset:                 crackPointOffset,
		generateCrackChance:              generateCrackChance,
		baseCrackSize:                    baseCrackSize,
		noiseMultiplier:                  noiseMultiplier,
		usePotentialPlacementsChance:     usePotentialPlacementsChance,
		useAlternateLayer0Chance:         useAlternateLayer0Chance,
		placementsRequireLayer0Alternate: placementsRequire,
		invalidBlocksThreshold:           int(invalidBlocksThresholdF),
	}, nil
}

func init() {
	RegisterType(geodeTypeID, buildGeodeFeature)
}

var _ wgen.IFeature = (*GeodeFeature)(nil)
