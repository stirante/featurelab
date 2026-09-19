// tree.go implements minecraft:tree_feature.
//
// ---- Int-range draws ----
//
// treeIntRangeValue implements the game's int-range draw over (min, max):
// if min >= max-1 it returns min and draws NOTHING; otherwise it returns
// min + nextIntBound(max-min) (one draw). This is the composition of the
// int-range draw calling the inclusive bounded draw with (min, max-1), where
// the inclusive bounded draw over (a, b) is: b < a ? a : a + nextIntBound(b-a+1).
// vegetation_patch.go's vegIntRangeValue uses the same formula.
// geodeIntRange/sculkRandomNextInt implement a genuinely different routine
// (the inclusive two-argument integer draw) -- see geode.go/sculk_patch.go.
// growing_plant.go's height/age draws call treeIntRangeValue directly. Every
// acacia tree exercises this: the acacia trunk's fixed (non-JSON) int range
// {1,4} for both lean_offset and lean_steps draws NextIntBound(3), not
// NextIntBound(2).
//
// Trunk shapes are selected by eight sibling JSON keys (see "How the JSON
// selects a trunk shape" below); the internal shape name is NOT the wood
// type. Canopy shapes are selected the same way by their <shape>_canopy
// keys. All eight trunk shapes and all canopy shapes are implemented:
// canopy, acacia_canopy, pine_canopy, fancy_canopy, spruce_canopy,
// random_spread_canopy, roofed_canopy, mangrove_canopy, mega_canopy,
// mega_pine_canopy, cherry_canopy and poplar_canopy, plus mangrove_roots and
// can_be_submerged.
//
// Summary of the pieces with non-obvious semantics:
//
//   - mangrove_roots (the real key; `roots` is not a valid spelling) runs
//     BEFORE the trunk, relocates the trunk origin, and a failed root
//     placement aborts the whole tree -- both the success flag and the
//     relocated origin matter. The root placement consists of a root
//     viability test, a RECURSIVE root simulation, a candidate-root-position
//     walk (which carries every RNG draw the growth makes) and a single-root
//     write. See "`mangrove_roots`" below.
//   - The radial block-group leaf helper shared by mega_canopy and
//     mega_pine_canopy (placeRadialBlockGroup): an obstruction does NOT
//     abandon the whole radial group; the step that follows is an ordinary
//     second normalization step, not an early exit. See "persistent_bit /
//     update_bit and the core-width assert", "mega_canopy and
//     mega_pine_canopy fields" and megaCanopy/megaPineCanopy/
//     megaPineRadiusFor below.
//   - The cherry trunk picks one/two/three tips by weight, dispatches the
//     canopy per tip in order with a fresh empty candidate list each time,
//     and uses x/z pillar_axis states for branch logs.
//
// Poplar (poplar_trunk/poplar_canopy) is covered in its own section below.
// The fallen trunk tolerates buildable-over leaf litter (see
// placeFallenTrunk). The attachable decoration's growth direction is the
// `step_direction` key, defaulting to down, with zero-fill.
//
// ---- The simple canopy (bare `canopy` key) ----
//
// The radius formula is int-multiply -> float-cast -> float-multiply ->
// truncate-toward-zero.
//
// Field set (JSON keys):
//
//	int   canopy_offset.min   (required)
//	int   canopy_offset.max   (required)
//	int   min_width           (optional, default 0)
//	float canopy_slope's "run" operand, PRE-CONVERTED to 1.0/run
//	int   canopy_slope's "rise" operand, kept as a raw int
//	block descriptor: leaf_block (required)
//	chance value: canopy_decoration's own gate (validity check)
//	chance value array: variation_chance, indexed
//	         by (y - canopy_offset.min)
//
// The rise/run assignment (which JSON field is the raw-int operand and which
// is the precomputed reciprocal) follows the natural "slope = rise/run"
// reading and is not otherwise verified; the arithmetic shape (one operand
// int-multiplied first, the other a stored float multiplied in after the
// cast) is exact. This draws no RNG and only affects non-default
// canopy_slope configs.
//
// Per-tree algorithm (ZERO RNG unless variation_chance is configured):
//
//	topSlope := slopeAt(canopy_offset.max)   // computed once, using max
//	for dy := canopy_offset.min; dy <= canopy_offset.max; dy++ {
//	    radius := topSlope + min_width - slopeAt(dy)
//	    if radius < 0 { continue }  // degenerate layer, nothing to place
//	    // a full (2*radius+1)^2 FILLED SQUARE (no corner cut -- see below),
//	    // centered on (anchor.X, anchor.Y+dy, anchor.Z)
//	}
//	slopeAt(dy) = truncTowardZero( float32(rise*dy) * float32(1.0/run) )
//
// This is a plain flat-topped cone: wide at the bottom (dy=min, most
// negative), narrowing toward min_width at the very top (dy=max) -- unlike
// the acacia/pine canopies' explicit corner cuts, the simple canopy's
// default shape is a hard SQUARE per layer (the corner test below is exactly
// `abs(dx)==radius && abs(dz)==radius`).
//
// `variation_chance` rounds those hard corners: at exactly the 4 true
// corners of each layer's square (|dx|==radius AND |dz|==radius), the game
// runs the shared chance roll on `variation_chance[dy-min]` and SKIPS that
// corner cell iff the roll returns true. The shared chance roll: in
// float-percent mode, `percent<=0` returns false WITHOUT drawing,
// `percent>=100` returns true without drawing, else it draws exactly one
// `NextFloat()*100 < percent`; in fraction mode, `numerator==denominator`
// returns true without drawing, else it takes one raw 32-bit value from the
// RNG and tests `raw % denominator < numerator`. The parser accepts, per
// element, a bare number (percent), a {numerator, denominator} chance
// object, or an array of either (the shared `chanceInformation` type), and
// requires an array's length to equal the layer count exactly. Absence is
// equivalent to every entry being a zeroed chance value (percent=0: returns
// false without drawing), i.e. "always keep the corner, draw nothing", so
// the plain square is what every JSON file omitting the key gets.
//
// The corner test has NO radius guard: nothing short-circuits on a radius of
// zero. So a radius-0 layer's single centre cell satisfies both halves of
// the test, spends a roll, and is DELETED when that roll succeeds -- the
// canopy eats its own only cell. This port does the same. The neighbouring
// canopy shapes differ on this: acacia, pine and spruce run no chance roll
// at all (their corner cut is deterministic); spruce guards on a nonzero
// radius while acacia does not, so acacia at canopy_size 0 unconditionally
// empties its own anchor layer. All three are pinned by
// TestCanopies_RadiusZeroCornerTests.
//
// `canopy_decoration` gates a second block behind its own chance-value
// validity check. Its absence is equivalent to a zeroed/invalid chance value
// (same as the acacia trunk's decoration), so the unconfigured case is
// unaffected.
//
// Leaf-placement gate: the simple canopy's gate is
// `materialType(existing) == 8 && <a second world check> ||
// materialType(existing) == 0 || materialType(existing) == 7` -- raw
// material-type codes, NOT a `passesAllowList(may_replace)` call the way the
// acacia/pine canopies do. This codebase has no material-type-code registry
// (see isValidTreePosition's field-mapping note), so this port uses the same
// approximation everywhere: `passesAllowList(may_replace) OR
// api.Palette().IsAir(existing)`.
//
// ---- The fancy canopy (`fancy_canopy` key) ----
//
// The layer fill takes (api, pos, block, radius, treeParams); every other
// field it uses comes from the canopy itself.
//
// Field set (JSON keys, in order):
//
//	int   "height" (required)
//	int   "radius" (optional -- default unknown; this port REQUIRES it
//	               rather than guess, see buildTreeFeature)
//	block descriptor: "leaf_block" (required)
//
// Per-tree algorithm (the branch-size==1x1 assert is not modelled -- this
// port never produces anything else; ZERO RNG anywhere in the canopy or its
// layer fill):
//
//	if height == 0 { place nothing }
//	for dy := 0; dy < height; dy++ {
//	    r := radius
//	    if dy == 0 || dy == height-1 { r = radius - 1 }   // cap layers
//	    fillLayer(anchor.Y + dy, r)                        // see below
//	}
//
// The layer fill uses double precision: two pow(double, 2.0) evaluations per
// candidate cell compared against radius*radius (squared as an int, then
// widened). For dx,dz in -r..r (inclusive at both ends, same loop pattern as
// acacia/pine), place iff (|dx|+0.5)^2 + (|dz|+0.5)^2 <= r*r AND
// passesAllowList(existing, may_replace) -- the same allow-list check the
// acacia/pine canopies use (not the simple canopy's OR-air approximation).
// Placement is a plain SetBlock with flag=3, spending zero RNG.
//
// r<0 (only reachable if radius==0) is a malformed range (begin exceeds
// end) with no well-defined result -- this port rejects radius<1 and
// height<0 at build time; height==0 is legal and places nothing.
//
// Shape: a tapered blob -- full `radius` bulge for every middle layer,
// `radius-1` caps top and bottom (height==1 is both cap and bottom at once,
// degenerating to a single radius-1 disc). Each layer is disc-shaped
// (rounded, not square -- unlike the acacia/pine/simple canopies'
// harder-edged rings), via the (|dx|+0.5)^2+(|dz|+0.5)^2<=r^2 test above.
//
// ---- The spruce canopy (`spruce_canopy` key) ----
//
// The spruce canopy ignores the trunk size entirely (trunk-independent, like
// the simple and fancy canopies).
//
// Field set (JSON keys, in order):
//
//	int range "lower_offset" (required)
//	int range "upper_offset" (optional -- default unknown; this port
//	               REQUIRES it rather than guess, same as fancy_canopy's
//	               "radius")
//	int range "max_radius" (required)
//	block descriptor "leaf_block" (required)
//
// RNG draw sequence (three int-range draws, then one direct draw):
//
//  1. lowerVal := lower_offset.getValue(rnd)   -- via treeIntRangeValue.
//  2. upperVal := upper_offset.getValue(rnd)   -- same helper.
//  3. maxRadiusVal := max_radius.getValue(rnd) -- same helper.
//  4. radius := rnd.NextIntBound(max_radius.max - max_radius.min) -- a
//     DIRECT bounded draw (the same one cave.go uses). Its bound is
//     max_radius.max - max_radius.min on the raw stored ints, with no -1 --
//     NOT the int-range draw's formula. Unconditional; NextIntBound's
//     bound<=0-returns-0-without-drawing contract matches the game for a
//     degenerate max_radius, so no extra guard is needed.
//
// So this canopy mixes both int-range-adjacent draw shapes in one function:
// draws 1-3 follow treeIntRangeValue (min+nextIntBound(max-min), zero draws
// when min >= max-1), draw 4 is the plain bounded draw.
//
// Per-tree algorithm:
//
//	// Ground search -- walk straight down from the anchor (typically
//	// through the trunk's own log column, since logs are not usually in
//	// may_replace) until the placement allow-list check on
//	// (existing, may_replace) is true. Draws NOTHING; aborts (places
//	// nothing) if MinY is reached first. groundY ends up ONE ABOVE the
//	// first passing position (the Y counter is only decremented on the
//	// FAILING branch).
//	y := anchor.Y
//	for {
//	    if passesAllowList(existing at (anchor.X, y-1, anchor.Z)) { break }
//	    if y <= api.MinY() { return }  // *** NO RNG drawn on this path ***
//	    y--
//	}
//
//	lowerVal, upperVal, maxRadiusVal := <the 3 int-range draws above>
//	radius := <the direct draw above>                // starting radius
//	top := upperVal + anchor.Y - lowerVal             // NOTE: anchor.Y, the
//	                                                   // ORIGINAL Y, not the
//	                                                   // ground search's y
//	n := top - y
//	if n <= -2 { /* malformed range, unsupported */ }
//	if n == -1 { return }                             // legal, empty, ZERO leaves
//
//	widthCap := max_radius.max - max_radius.min - 1    // a SEPARATE quantity
//	                                                    // from maxRadiusVal --
//	                                                    // the raw span, not the
//	                                                    // drawn value
//	flag := 0
//	topY := anchor.Y + upperVal
//	for dy := 0; ; dy++ {
//	    layerY := topY - dy                            // TOP first, descending
//	    ring(layerY, radius)                            // square minus the 4
//	                                                     // true corners when
//	                                                     // radius!=0 -- SAME
//	                                                     // corner-cut shape as
//	                                                     // acacia_canopy/
//	                                                     // pine_canopy's own
//	                                                     // rings
//	    // grow-then-reset state machine (kept 1:1 with the game's control
//	    // flow rather than re-expressed from intent):
//	    prevWidthCap := widthCap
//	    newCap := maxRadiusVal
//	    if prevWidthCap < maxRadiusVal { newCap = prevWidthCap + 1 }
//	    growing := radius < prevWidthCap
//	    if radius >= prevWidthCap { radius = flag } else { radius++ }
//	    if !growing { widthCap = newCap; flag = 1 }
//	    if dy == n { break }
//	}
//
// The leaf gate inside the ring is the SAME raw material-type shape as the
// simple canopy's (type 8 plus the second world check, or type 0, or type
// 7), approximated the same way: `passesAllowList(existing, may_replace) OR
// api.Palette().IsAir(existing)`. The ground search's gate, by contrast, is
// a plain allow-list check on (api, pos, may_replace) with no OR-air
// fallback -- an out-of-bounds/unloaded read that happens to look like air
// must NOT count as "found ground".
//
// Shape: alternating TIERS -- radius grows by 1 per layer from its starting
// `radius` (the direct draw) up to `widthCap`, then RESETS to `flag` (0 the
// first time a cap is hit, 1 every time after) and grows again, capped by
// max_radius's drawn value from then on. This is vanilla spruce's
// silhouette (alternating full/skinny bands up the trunk), unlike the
// acacia/pine/simple/fancy canopies' single smooth taper -- see
// TestSpruceCanopy_Place_TieredCrossSections for a worked 8-layer example
// (radii 0,1,2,0,1,2,3,1) and its ASCII rendering.
//
// ---- Trunk coupling of the canopy shapes ----
//
//   - mega_pine_canopy, mega_canopy, roofed_canopy and cherry_canopy are
//     trunk-core-width COUPLED: each asserts that either the core width was
//     not parsed or the trunk size matches it on BOTH axes (cherry: always
//     enforced; see "The core-width mechanism" below).
//   - random_spread_canopy and mangrove_canopy are trunk-core-width
//     INDEPENDENT: the trunk size is never used.
//
// ---- The random-spread canopy (`random_spread_canopy` key) ----
//
// Notes that are easy to get wrong:
//
//  1. The canopy also receives a list of branch sizes, which it never
//     reads (it ignores trunk size entirely).
//  2. The FIRST int-range key is "canopy_height", the SECOND
//     "canopy_radius"; that determines which drawn value feeds which jitter
//     axis (see RNG draw sequence below).
//  3. The weighted leaf-block pick draws `nextIntBound(int32(sum))` -- an
//     INTEGER bound truncated from the float weight sum, integer return --
//     which is genuinely different from shared.go's WeightedPick /
//     growing_plant.go's `NextFloat()*sum` float draw. Not reused; see
//     randomSpreadPickBlock's doc comment.
//
// Field set (JSON keys, required flags):
//
//	int range "canopy_height" (required) -- feeds the Y jitter axis
//	int range "canopy_radius" (required) -- feeds the X/Z jitter axes
//	int       "leaf_placement_attempts" (required)
//	list of weighted block references, "leaf_blocks" (required) --
//	         each entry is a block descriptor plus a float weight, as a
//	         2-element TUPLE (block descriptor at index 0, float weight at
//	         index 1 -- NOT named object keys), i.e. JSON shape
//	         `[[block descriptor, weight], ...]`.
//
// RNG draw sequence:
//
//  1. heightVal := the inclusive two-argument integer draw over
//     (canopy_height.min, canopy_height.max) -- 0 draws when max<=min, else
//     min+NextIntBound(max-min); geodeIntRange is reused for it. This is
//     DIFFERENT from the int-range draw (see spruce_canopy above).
//  2. radiusVal := the same two-argument draw over
//     (canopy_radius.min, canopy_radius.max).
//
// Then, for each candidate (one per successfully-placed trunk log position
// -- see "Trunk candidate-vector wiring" below), leaf_placement_attempts
// times:
//
//  3. Weighted leaf-block pick -- 0 or 1 rnd.NextIntBound(int32(sum of
//     leaf_blocks weights)) draw (0 when the TRUNCATED sum is exactly 0)
//     -- see randomSpreadPickBlock.
//  4. dx1 := rnd.NextIntBound(radiusVal)
//  5. dx2 := rnd.NextIntBound(radiusVal)
//  6. dy1 := rnd.NextIntBound(heightVal)
//  7. dy2 := rnd.NextIntBound(heightVal)
//  8. dz1 := rnd.NextIntBound(radiusVal)
//  9. dz2 := rnd.NextIntBound(radiusVal)
//     (X,X,Y,Y,Z,Z order -- the first pair uses bound=radiusVal for X, the
//     second bound=heightVal for Y, the third bound=radiusVal again for Z)
//
// Target position: (candidate.X + (dx1-radiusVal) + dx2 + 1, candidate.Y +
// (dy1-heightVal) + dy2 + 1, candidate.Z + (dz1-radiusVal) + dz2 + 1). A
// "sum of two uniform draws minus the bound" triangular-distribution jitter
// -- denser near the candidate, thinning toward +-bound -- which, spread
// across every trunk log position, gives vanilla's scattered-cluster
// silhouette rather than a single smooth taper.
//
// NOTE (reproduced faithfully): canopy_height/canopy_radius are ordinary
// int ranges and CAN legally draw a negative heightVal/radiusVal (e.g.
// canopy_height={"min":-2}). Both then feed NextIntBound as a BOUND (draws
// 4-9), and mtrand.Rand.NextIntBound computes `NextUint32() %
// uint32(bound)` -- a negative bound wraps to a huge uint32, producing an
// enormous offset. The game's bounded draw almost certainly behaves the
// same way, so this port adds no guard; the tests and CLI demo use
// non-negative bounds to avoid it.
//
// Leaf-placement gate: a block-descriptor list match against the tree
// parameters' may_replace list (an empty list SKIPS the gate and places
// unconditionally, matching the allow-list check's "empty ids -> always
// true" contract), OR'd with the raw material-type chain (types 8, 7 and 5
// behind the second world check, or type 0, plus two further block-level
// checks this codebase has no registry for). Approximated, as for the simple
// and spruce canopies, as `passesAllowList(existing, mayReplace) OR
// api.Palette().IsAir(existing)`.
//
// leaf_placement_attempts<0 is a malformed range -- rejected at build time.
//
// ---- Trunk candidate-vector wiring ----
//
// Unlike every other implemented canopy, the random-spread canopy reads the
// candidate block-position list that every canopy receives.
//
// The acacia trunk's order per log position is:
//
//	the decorated-block write runs unconditionally
//	if the block was NOT placed            -> no push, next iteration
//	if the y INDEX < min_height_for_canopy -> SKIP the push, next iteration
//	otherwise push the position onto the candidate list
//
// So min_height_for_canopy gates the ANCHOR COLLECTION, and each dropped
// anchor costs a random_spread_canopy seven draws.
//
// Two things the port does NOT model:
//
//   - the game also requires the decorated-block write to REPORT SUCCESS
//     before pushing; this port gates only on isValidTreePosition.
//   - the canopy receives TWO lists, not one: the candidate block-position
//     list and a parallel branch-size list, pushed in lockstep inside the
//     same gate with every entry {trunk_width, trunk_width}. Every entry is
//     identical and the random-spread canopy is the only consumer that reads
//     either, so this is unlikely to be draw-affecting, but it is a real
//     unmodelled parameter.
//
// The acacia trunk's per-layer "width" sub-loop is bounded by the field the
// "columnWidth=1" note (on placeBaseBlock) describes as 1, so this reduces
// to exactly one push per i where isValidTreePosition succeeds -- the same
// condition this port's trunk-placement loop gates placeLog/candidate
// tracking on.
//
// TreeFeature.Place carries a `candidates []wgen.BlockPos` slice, appended
// to on the same isValidTreePosition-success branch the `anchor` tracking
// uses (see Place's inline comment). It does not change what gets placed,
// when RNG draws, or any return value. Every canopy except
// randomSpreadCanopy ignores the parameter.
//
// Shape: leaf clusters scattered around EVERY trunk log position (not one
// shared anchor) -- see TestRandomSpreadCanopy_Place_ScattersAroundMultiple-
// Candidates for a worked 3-candidate example and its ASCII rendering, and
// TestCmdGenerate_TreeFeature_RandomSpreadCanopyKey_GrowsRealTree
// (cmd/featurelab/tree_cli_test.go) for a real CLI-grown tree showing
// leaves across 8 distinct Y levels along a 7-log trunk.
//
// ---- Trunk shapes ----
//
// The <shape>_trunk keys, in the game's order, all implemented:
//
//	"acacia_trunk"   -> the acacia trunk (placeShapedTrunk). Reachable ONLY
//	                    via "acacia_trunk"; the bare key is the SIMPLE trunk.
//	"cherry_trunk"   -> the cherry trunk (placeCherryTrunk)
//	"fallen_trunk"   -> the fallen trunk (placeFallenTrunk; see its doc
//	                    comment)
//	"fancy_trunk"    -> the fancy trunk (placeFancyTrunk)
//	"mangrove_trunk" -> the mangrove trunk (placeMangroveTrunk)
//	"mega_trunk"     -> the mega trunk (placeMegaTrunk)
//	"trunk" (bare)   -> the simple trunk (placeSubmergedTrunk). It does NOT
//	                    run an acacia-shaped path.
//	"poplar_trunk"   -> the poplar trunk (placePoplarTrunk, see the Poplar
//	                    section below)
//
// ---- How the JSON selects a trunk shape: EIGHT SIBLING KEYS ----
//
// The trunk shapes are eight independent sibling JSON keys, in this order:
// acacia_trunk, cherry_trunk, fallen_trunk, fancy_trunk, mangrove_trunk,
// mega_trunk, trunk, poplar_trunk -- each bound to the same-named shape in
// the table above. The key name alone decides the shape; there is no
// structural matching between shapes (the same way knownCanopyKeys works).
//
// The key sets confirm it. The simple trunk (`trunk`) accepts exactly five
// keys -- trunk_height (int range, REQUIRED), height_modifier (int range,
// optional), can_be_submerged (object and bool forms, both optional),
// trunk_block (block descriptor, REQUIRED) and trunk_decoration (optional)
// -- and has NO trunk_lean, lean_offset, lean_steps, branches or
// trunk_width. The acacia trunk requires trunk_width, an OBJECT trunk_height
// and trunk_lean, and has no can_be_submerged at all.
//
// So a file writing {"trunk": {"trunk_block": ..., "trunk_height": 7}}
// would fail the acacia trunk's schema on three counts, yet such files load
// in the game -- they are simple trunks.
//
// "can_be_submerged" belongs to the simple trunk only.
//
// ---- The core-width mechanism ----
//
// Every canopy shape receives the same inputs: the world-gen block API, the
// position, a branch size `trunkSize` ({sizeX, sizeZ}), the RNG, the render
// parameters, the shared tree parameters, a candidate block-position list,
// and a branch-size list. trunkSize is passed directly (the cherry trunk
// passes {1,1} for both of its canopy dispatches -- see below), NOT derived
// from `candidates`. canopyPlacer.place() has no branch-size parameter; a
// canopy needing core-width support requires threading a real branch size
// out of the trunk through TreeFeature.Place.
//
// The assert:
//   - mega_canopy: runs only when the canopy's "core width was parsed" flag
//     is set, and then requires trunkSize's two components to equal the
//     parsed core_width.
//   - mega_pine_canopy: identical.
//   - cherry_canopy: UNCONDITIONAL, with no "core width was parsed" guard:
//     it always requires trunkSize's two components to equal its own width
//     field, spelled with the JSON key "trunk_width" (distinct from the
//     mega/mega-pine/roofed "core_width" spelling).
//   - roofed_canopy: the same guarded form as the mega and mega pine
//     canopies.
//
// These four canopies (roofed, mega, mega pine, cherry) are only valid
// under the acacia, cherry and mega trunks; the fallen, fancy, mangrove and
// simple trunks do not accept them.
//
// A load-bearing, easy-to-miss consequence: the acacia trunk (branch size
// {1,1}, per the columnWidth=1 note) IS one of the three accepted trunks for
// all four. A branch size of {1,1} legally satisfies the mega and mega pine
// canopies' optional guard (core_width omitted from the JSON) or the cherry
// canopy's unconditional one (trunk_width:1 explicit) without needing the
// cherry or mega trunk.
//
// ---- Cherry trunk, mega trunk and the shared radial leaf helper ----
//
// The cherry trunk differs materially from the acacia trunk's single-anchor
// model: it makes a weighted pick over an int32 weight list (the summed
// weight fed to the bounded integer draw) to choose a branch
// count/configuration, draws TWO inclusive int ranges for height and one
// nextIntBound(4) for a lean direction, then grows branches (once per
// initial direction, the second time negated), collecting a list of branch
// tip positions. The canopy's placement is then called ONCE PER BRANCH TIP
// with a hardcoded branch size of {1,1}; no RNG is drawn between tips. So
// cherry trees place their canopy at multiple anchors per tree, which this
// port models as "trunk returns []anchor, Place loops" (see
// "cherry_trunk / cherry_canopy" below for the branch draw sequence).
//
// The mega trunk is the largest of the 7 trunk shapes. It has its own
// spawn-preparation step and an int-range-driven vine/moss decoration pass
// that touches the persistent_bit and update_bit block states of placed
// blocks.
//
// The radial block-group write is the leaf-placement helper shared by the
// mega and mega pine canopies. Each of those canopies draws exactly ONE
// int-range value (a radius/height variance) and then calls the helper per
// layer. Its geometry is a ROUNDED RECTANGLE, not a rounded square: the fill
// test is the squared distance to the nearest corner of the branch-size-sized
// core rectangle (sizeX by sizeZ) compared against radius^2, so the trunk's
// width sets the core footprint before the radius expands it. The helper
// itself draws ZERO RNG. Its bool argument is the mega canopy's
// simplify_canopy flag (see below).
//
// The cherry canopy uses two layer helpers: a plain leaf layer and a
// leaf-layer-with-hanging-leaves-below variant, called with negative dy
// values to build a downward-tapering stack whose bottom two layers get the
// hanging-leaves treatment.
//
// ---- persistent_bit / update_bit and the core-width assert ----
//
// persistent_bit and update_bit are both boolean block states (2 values),
// registered as block.PersistentBit / block.UpdateBit (see block/state.go).
//
// In the radial block-group write, for each candidate cell: if the EXISTING
// block's type has an update_bit state, a copy of that existing block with
// update_bit forced to 0 is derived purely to normalize it before the
// block-descriptor list match -- exactly
// `block.WithIntState(existingID, block.UpdateBit, 0)`. The persistent_bit
// branch is a second, ordinary normalization step, not an early exit. The block placed is
// always the canopy's own fixed leaf block; the normalized block is only used
// for the gating checks. The mega trunk's own vine/moss decoration pass is a
// separate consumer of these bits and is not covered by this description.
//
// Core-width assert: the mega, mega pine and roofed canopies assert that
// either the core width was not parsed, or the trunk size matches core_width
// on BOTH axes. The trunk size reaching a canopy through this port's trunks
// is {1,1}, so the assert holds for any JSON core_width==1. core_width != 1
// is refused at build time rather than silently forced to 1. The cherry
// canopy's variant is unconditional (it compares the trunk size against its
// own trunk_width, with no guard flag) and is equally satisfied by
// trunk_width==1.
//
// ---- The mega canopy (`mega_canopy` key) ----
//
// Fields:
//
//	int range        "canopy_height"   (required)
//	int              "base_radius"     (optional; default unknown, so this
//	                                    port requires it, same treatment as
//	                                    fancy_canopy's "radius")
//	int              "core_width"      (required, unconditionally)
//	bool             "simplify_canopy" (optional, default false) -- the
//	                                    radial block-group write's
//	                                    corner-relaxation flag inside its
//	                                    coarse circular pre-check
//	block descriptor "leaf_block"      (required)
//
// There is also a JSON-unexposed core-width-was-parsed flag. Its value does
// not matter for this port: the branch size fed to the radial block-group
// write's core rectangle is `coreWidthWasParsed ? {core_width,core_width} :
// trunkSize`, and since core_width==1 is required and trunkSize is always
// {1,1}, both branches yield {1,1} for every accepted file.
//
// Algorithm:
//
//	Value := canopy_height.getValue(rnd)        // the ONLY RNG draw
//	if Value == 0 { place nothing }
//	halfCoreWidth := core_width / 2              // rounds toward zero
//	                                              // (also for negative
//	                                              // core_width)
//	for dy := 1-Value; dy <= 0; dy++ {
//	    radius := -dy + base_radius + halfCoreWidth
//	    placeRadialBlockGroup(api, {anchor.X, anchor.Y+dy,
//	        anchor.Z}, leaf_block, radius, {core_width,core_width},
//	        simplify_canopy, may_replace)
//	}
//
// i.e. Value layers, widest (radius = Value-1+base_radius+halfCoreWidth) at
// the bottom (dy=1-Value), narrowing by exactly 1 per layer up to the
// smallest (radius = base_radius+halfCoreWidth) at dy=0 -- a downward-flaring
// cone, matching vanilla mega-tree canopies. The radial block-group write's
// per-cell test is a coarse circular accept/reject against that radius
// (relaxed at the 4 true corners UNLESS simplify_canopy is set) followed by
// the update-bit/persistent-bit gate above, then a single-block write with
// flag=3 like the other canopies. Implemented as megaCanopy /
// placeRadialBlockGroup below.
//
// ---- The roofed canopy (`roofed_canopy` key) -- PORTED ----
//
// Fields:
//
//	int  "canopy_height" (required; the wall-top Y offset AND the wall
//	              layer count)
//	int  "core_width"    (required; must be 1 here, see the core-width
//	              assert above)
//	int  "outer_radius"  (optional; default unknown, so REQUIRED here,
//	              same treatment as fancy_canopy's "radius")
//	int  "inner_radius"  (optional; same situation, REQUIRED here)
//	block descriptor "leaf_block" (required)
//
// Like the mega canopy it has a JSON-unexposed core-width-was-parsed flag,
// and for the same reason it cannot affect accepted files: sizeX_eff and
// sizeZ_eff (each `coreWidthWasParsed ? core_width : trunkSize`) are both
// always 1. That collapses the general "mirror around the core rectangle's
// far edge" arithmetic (`sizeX_eff-1-j`, `sizeZ_eff-1-k`) to a bare negation
// (`-j`, `-k`) throughout; the general form is noted here for anyone
// extending this to a real multi-width trunk.
//
// RNG draw sequence -- EXACTLY ONE draw, unconditional, a boolean draw
// that happens after the floor/roof-cap section and before any
// canopy_height/outer_radius/inner_radius range checks:
//
//  1. lidDraw := rnd.NextBoolean() -- gates a single-cell "lid" (see below).
//     Drawn EVERY call regardless of outer_radius/canopy_height/
//     inner_radius (even outer_radius==-1, which skips the entire floor/
//     roof-cap section, still reaches this draw).
//
// The floor/roof-cap section and the wall section draw ZERO RNG.
//
// Per-tree algorithm (anchor = the lean-adjusted trunk-top position, h =
// canopy_height, r1 = outer_radius, r2 = inner_radius). The (j,k) double loop
// below does NOT trace a sparse diagonal: j and k each sweep every integer in
// [-r1,0], and each iteration places at both j and its mirror -j (same for
// k), so every (dx,dz) in the full (2r1+1)x(2r1+1) square is generated by
// exactly one iteration (j=-|dx|, k=-|dz|). The floor is therefore a fully
// solid square (no corner cut); the roof cap is that same square with
// roofedUpperCornerAllowed's exclusion applied per cell, which gives a
// rounded/chamfered diamond that fills in more of the square as r1 grows
// (r1=0: the single cell excluded; r1=1: only the center cell survives; r1=2:
// a 13-cell rounded diamond; r1=3: a 37-cell chamfered-corner square) -- a
// hip-roof silhouette:
//
//	// 1. Floor + roof cap, ZERO RNG, skipped
//	//    entirely when r1 == -1 (r1 <= -2 is a malformed range this
//	//    port refuses at build time, same policy as every other
//	//    malformed-range guard in this file).
//	if r1 != -1 {
//	    for j := -r1; j <= 0; j++ {          // outer sweep
//	        for k := -r1; k <= 0; k++ {      // inner sweep
//	            mj, mk := -j, -k             // mirror (see simplification above)
//	            // Floor: y = anchor.Y-1, UNCONDITIONAL -- fills the WHOLE
//	            // square, not just 4 points:
//	            place(anchor.X+j,  anchor.Y-1, anchor.Z+k)
//	            place(anchor.X+mj, anchor.Y-1, anchor.Z+k)
//	            place(anchor.X+j,  anchor.Y-1, anchor.Z+mk)
//	            place(anchor.X+mj, anchor.Y-1, anchor.Z+mk)
//	            // Roof cap: y = anchor.Y+h, gated by the 2-clause
//	            // exclusion in roofedUpperCornerAllowed (see that
//	            // function's doc comment):
//	            if roofedUpperCornerAllowed(j, k, r1) {
//	                place(anchor.X+j,  anchor.Y+h, anchor.Z+k)
//	                place(anchor.X+mj, anchor.Y+h, anchor.Z+k)
//	                place(anchor.X+j,  anchor.Y+h, anchor.Z+mk)
//	                place(anchor.X+mj, anchor.Y+h, anchor.Z+mk)
//	            }
//	        }
//	    }
//	}
//	// 2. The single RNG draw + its gated peak.
//	if rnd.NextBoolean() {
//	    place(anchor.X, anchor.Y+h+1, anchor.Z)   // single cell (sx=sz=1)
//	}
//	// 3. canopy_height<0 is a malformed range -- refused at build
//	//    time. canopy_height==0 legally places nothing further (still gets
//	//    the floor/roof-cap/peak above -- those do not depend on h being
//	//    nonzero, only the roof-cap's Y level does).
//	if h == 0 { return }
//	// 4. Walls: a SOLID corner-cut square, radius
//	//    r2, stacked h layers tall starting at anchor.Y. The game's
//	//    3-clause corner exclusion (dx==-r2 && dz==-r2; dx==-r2 && dz==r2;
//	//    dx==r2 && (dz==-r2 || dz==r2)) is the union of all 4 exact
//	//    corners of the r2-square -- algebraically IDENTICAL to
//	//    `abs(dx)==r2 && abs(dz)==r2`, the corner-cut idiom
//	//    acacia_canopy/pine_canopy/spruce_canopy also use. The separate
//	//    accept test (`abs(dx)<r2 || abs(dz)<r2`) is implied once the true
//	//    corners are excluded (both halves of that OR can only be false
//	//    together when |dx|==r2 AND |dz|==r2 -- exactly the excluded
//	//    corner case), so it is not modeled as a separate condition --
//	//    an exact equivalence, not an approximation.
//	for layer := 0; layer < h; layer++ {
//	    for dx := -r2; dx <= r2; dx++ {
//	        for dz := -r2; dz <= r2; dz++ {
//	            if abs(dx) == r2 && abs(dz) == r2 { continue }
//	            place(anchor.X+dx, anchor.Y+layer, anchor.Z+dz)
//	        }
//	    }
//	}
//
// Leaf-placement gate (identical at every placement in this canopy): the
// existing block's material type must be 0 (air), alone -- unlike the simple,
// spruce and random-spread canopies' 3-code OR-chain (0, 7, 8, plus an extra
// world check) that this file approximates as `passesAllowList(may_replace)
// OR api.Palette().IsAir(existing)`. The roofed canopy's gate has no
// may_replace term and no codes 7/8, so this port applies
// `api.Palette().IsAir(existing)` alone. An unresolvable leaf_block is
// refused at build time via ctx.Palette.Resolve, like every other canopy.
//
// Shape: a solid (2*outer_radius+1)-square FLOOR one Y level below the
// anchor; a SOLID corner-cut square tower of radius inner_radius, walls
// stacked canopy_height layers tall starting at the anchor; a chamfered/
// rounded-diamond ROOF CAP at anchor.Y+canopy_height (same outer_radius
// footprint as the floor, corners trimmed by roofedUpperCornerAllowed); and
// an optional single-cell PEAK one layer above that, on a coin flip -- a
// small hut/gazebo silhouette. See TestRoofedCanopy_Place_HutCrossSections
// for a worked example with horizontal and vertical ASCII cross-sections.
//
// ---- The mangrove canopy (`mangrove_canopy` key) -- PORTED ----
//
// Fields, in order:
//
//	int range "canopy_height" (required)
//	int range "canopy_radius" (required)
//	int  "leaf_placement_attempts" (required)
//	list of weighted block references, "leaf_blocks" (required)
//	         -- the same `[[block descriptor, weight], ...]` tuple shape as
//	         the random-spread canopy's leaf_blocks; this port reuses
//	         randomSpreadWeightedBlock and randomSpreadPickBlock directly.
//	attachable decoration, "canopy_decoration" (optional object; see
//	         below).
//	block descriptor "hanging_block" (required).
//	chance value "hanging_block_placement_chance" (required), gating the prop-root pass below.
//
// canopy_decoration, when omitted, has a zeroed chance gate, so the
// decoration step is skipped with ZERO extra RNG -- the same behaviour as the
// simple canopy's canopy_decoration. This port REFUSES
// mangrove_canopy.canopy_decoration if PRESENT (same policy as the simple
// canopy's identical refusal), which costs nothing for files that omit it.
//
// Fixed (JSON-unexposed) constants:
//
//	= 2  -- mangroveRootSearchDepth
//	= 1  -- footprint half-width, X axis
//	= 1  -- footprint half-width, Z axis (equal to X, so the port uses a
//	                                   symmetric 3x3 footprint; the two axes
//	                                   are not interchangeable in general)
//
// RNG draw sequence:
//
//  1. heightVal := inclusive two-argument integer draw over
//     (canopy_height.min, canopy_height.max) -- geode.go's geodeIntRange
//     (0 draws when max<=min, else min+NextIntBound(max-min)), reused
//     directly, same draw as random_spread_canopy's.
//  2. radiusVal := the same draw over (canopy_radius.min, canopy_radius.max).
//
// Then, for each candidate (one per successfully-placed trunk log position,
// the same candidates wiring random_spread_canopy uses),
// leaf_placement_attempts times:
//
//  3. Weighted leaf-block pick -- 0 or 1 rnd.NextIntBound(int32(sum of
//     leaf_blocks weights)) draw, via randomSpreadPickBlock (the same
//     integer-bound weighted pick random_spread_canopy uses, NOT shared.go's
//     float-based WeightedPick).
//  4. dx1 := rnd.NextIntBound(radiusVal)
//  5. dx2 := rnd.NextIntBound(radiusVal)
//  6. dy1 := rnd.NextIntBound(heightVal)
//  7. dy2 := rnd.NextIntBound(heightVal)
//  8. dz1 := rnd.NextIntBound(radiusVal)
//  9. dz2 := rnd.NextIntBound(radiusVal)
//     (X,X,Y,Y,Z,Z order, same axis-bound pairing as random_spread_canopy's
//     6-draw jitter)
//
// Target position: (candidate.X + dx1 - dx2, candidate.Y + dy1 - dy2,
// candidate.Z + dz1 - dz2) -- a plain difference-of-two-uniform-draws jitter.
// NOTE this DIFFERS from random_spread_canopy's formula (which adds `+1` and
// subtracts the bound on one side): the mangrove jitter is symmetric around
// the candidate with no shift, despite the identical X,X,Y,Y,Z,Z draw order.
//
// Leaf-placement gate: a block-descriptor list match of the existing block
// against may_replace, OR either of two further block-level checks, OR the
// material-type chain -- type 8 behind the same second world check, or
// type 7, or type 5 -- the same shape as random_spread_canopy's gate,
// approximated the same way:
// `passesAllowList(existing, may_replace) OR api.Palette().IsAir(existing)`.
//
// After every candidate's every attempt: a Fisher-Yates shuffle of the FULL
// accumulated propagule-position list (across ALL candidates, not
// per-candidate), using the standard "callable(n) returns a uniform int in
// [0,n)" contract mapped to NextIntBound: for i in [1,len),
// j := rnd.NextIntBound(i+1), swap(list[i], list[j]) -- 0 draws for 0 or 1
// propagule.
//
// The shuffled order feeds BOTH remaining passes (canopy_decoration's
// decoration loop -- always skipped here because of the build-time refusal
// above -- and the hanging_block pass below), so the shuffle must run even
// though canopy_decoration never fires, to keep the hanging_block pass's RNG
// draws in the right order.
//
// Prop-root / hanging_block pass:
//
//	occupied := {} // set of positions (a Go map here)
//	for p := range shuffledPropagules {
//	    below := {p.X, p.Y-1, p.Z}
//	    if occupied[below] { continue }   // NO RNG -- the occupancy test
//	                                       // short-circuits before the
//	                                       // chance roll
//	    if !hangingChance.roll(rnd) { continue }   // *** RNG (0 or 1 draw) ***
//	    // Ground-clearance search, ZERO RNG: walk mangroveRootSearchDepth
//	    // cells straight down from p. If ANY cell in that range is NOT
//	    // air-like (this port's stand-in for the block-level "obstruction"
//	    // check -- the same check the leaf gate above approximates as air),
//	    // stop -- NO root placed. Reaching the full depth without an
//	    // obstruction commits to placement -- but ALWAYS at `below` (one cell
//	    // under the propagule), never at the search depth itself.
//	    if not clear { continue }
//	    place(below, hanging_block)
//	    for dx := -mangroveFootprintRadius; dx <= mangroveFootprintRadius; dx++ {
//	        for dz := -mangroveFootprintRadius; dz <= mangroveFootprintRadius; dz++ {
//	            occupied[{below.X+dx, below.Y, below.Z+dz}] = true
//	        }
//	    }
//	}
//
// Because the footprint half-widths are FIXED positive constants (not
// JSON-configurable), the footprint range is always well-formed, so the
// footprint marking is the plain fixed 3x3 double loop shown above.
//
// hanging_block_placement_chance's JSON shape: a plain number is a percent
// (float), and an object is a fraction with two uint32s (numerator and
// denominator); no third shape exists. The "numerator"/"denominator" key
// spelling matches distribution.go's ChanceSpec/ParseScatterChance, which
// uses the identical dual JSON shape and the identical two-mode roll for an
// analogous chance value -- see chanceInformation's doc comment below.
//
// Shape: leaf clusters scattered around every trunk log position (similar to
// random_spread_canopy's silhouette, but with a symmetric jitter), PLUS
// hanging "prop root" blocks one cell below any propagule that (a) isn't
// already claimed by a nearby root's 3x3 footprint, (b) passes its
// hanging_block_placement_chance roll, and (c) has at least
// mangroveRootSearchDepth cells of clear air straight down -- i.e. roots only
// grow from propagules with room to hang, matching vanilla mangrove trees'
// over-water silhouette. See TestMangroveCanopy_Place_ScatterAndHangingRoots
// for a worked example, its full RNG draw-sequence pin, and an ASCII
// cross-section.
//
// ---- chanceInformation -- shared chance value ----
//
// mangrove_canopy's REQUIRED hanging_block_placement_chance is a chance value
// that cannot be skipped by omission, so this file has a chanceInformation
// type + parser + roll() method (see below), implementing the shared chance
// roll described in the simple canopy's section above plus the JSON shape
// described immediately above. It is deliberately narrow (no Molang-string
// mode, unlike distribution.go's ChanceSpec) because the game's chance value
// only accepts a number or an object -- a string mode would invent a third
// shape vanilla does not parse.
//
// ---- `mangrove_roots` ----
//
// The roots key is spelled `mangrove_roots` (a bare `roots` key does not
// exist). It is a single, optional, top-level tree_feature object, parallel to
// a `<shape>_canopy` key but with only one shape: there is no generic roots
// shape the way bare `canopy` exists for canopies.
//
// Schema:
//
//	max_root_width            int              (required)
//	max_root_length           int              (required)
//	root_block                block descriptor (required)
//	above_root                object           (optional)
//	    above_root_chance     chance value     (optional, nested in above_root)
//	    above_root_block      block descriptor (optional, nested in above_root)
//	muddy_root_block          block descriptor (required)
//	mud_block                 block descriptor (required)
//	y_offset                  int range        (required)
//	roots_may_grow_through    array of block descriptors (required)
//	root_decoration           object           (optional) -- an attachable
//	                          decoration, the same shared type used by the
//	                          trunks and mangrove_canopy.
//
// Root placement runs BEFORE the trunk. It yields both a success flag and a
// relocated origin, and both halves matter: failure aborts the whole tree, and
// on success the returned position (not the raw feature origin) becomes the
// origin the trunk placement receives.
//
// Outline (see mangroveRootsPlace/mangroveCanPlaceRoot/mangroveSimulateRoots/
// mangrovePotentialRootPositions/mangrovePlaceRoot for the full algorithm):
//
//   - Value := y_offset drawn via treeIntRangeValue (0 or 1 draw).
//   - Vertical check: walking UP from origin.Y, EVERY Y in
//     [origin.Y, origin.Y+Value) must pass the root viability test; the first
//     failure aborts the whole root placement.
//   - Then the 4 horizontal directions, in a fixed order (the order is not
//     shuffled and draws nothing). Growth in each direction is a RECURSIVE,
//     BACKTRACKING search, not a flat loop: each step the candidate-root-
//     position walk returns ONE candidate (straight down, or forward, depending
//     on a distance-from-origin band) or TWO (down AND a forward diagonal, in
//     the boundary zone near max_root_width), each gated by the viability test.
//     A failure anywhere in the recursion (reaching max_root_length before a
//     natural stop, or an empty/oversized result) clears that direction's
//     whole accumulated branch and aborts the whole root placement.
//
// RNG draw sequence: the y_offset draw once at the top; then, per direction
// (up to 4) and per recursion step, the candidate walk's 0-2 draws (NextFloat,
// then conditionally NextBoolean or a second NextFloat depending on the
// distance band -- see mangrovePotentialRootPositions); then, per committed
// position (the accumulated list from all 4 directions, in order), the
// single-root write's 0-or-1 `above_root_chance` roll, reached only when a
// fresh root_block placement succeeds AND above_root_block is configured.
//
// Approximations, disclosed inline: (1) the viability test's material
// fallback depends on two block-level predicates this port has no registry
// for, approximated as `passesAllowList OR isWater` (a strict subset, never a
// false positive -- the same class of gap the simple/spruce/random-spread
// canopy leaf gates carry); (2) the single-root write's above_root placement
// gate (the same predicate on its own) is approximated as bare Air, like the
// roofed canopy's single unresolved predicate.
//
// ---- `can_be_submerged` and the simple trunk ----
//
// `can_be_submerged` belongs to the simple trunk (the bare `trunk` key), not
// the acacia trunk. Simple trunk schema:
//
//	trunk_height       int range (required, default {5,8})
//	height_modifier    int range (optional, default {0,0})
//	can_be_submerged   bool, or object {max_depth: int (required)} (optional)
//	trunk_block        block descriptor (required)
//	trunk_decoration   object    (optional) -- an attachable decoration
//
// Both can_be_submerged forms write one integer, a maximum submerged depth:
// true -> 255, false -> 0, {max_depth: N} -> N; absent -> 0.
//
// Trunk shape selection: the tree feature has eight independent SIBLING trunk
// keys (full table in this file's header); `trunk` always means the simple
// trunk -- there is no structural type union choosing between shapes.
// can_be_submerged selects only the descent depth, never the shape. The
// acacia trunk requires trunk_width, an object-shaped trunk_height and
// trunk_lean, so a {trunk_block, trunk_height: <number>} body can never be an
// acacia trunk.
//
// Simple trunk placement (placeSubmergedTrunk):
//
//   - If maxDepth >= 1, probe {x, y-1, z} with the placement allow-list check
//     against may_grow_through; while it passes, commit the probed cell as the
//     new working origin, decrement the budget (stop at zero), and probe one
//     lower. ZERO RNG. With maxDepth = 0 the descent is skipped entirely.
//   - Everything else runs from the relocated origin: trunk_block resolution,
//     spawn preparation with may_grow_on and may_grow_through, the height draw
//     (a plain int-range draw over trunk_height, treeIntRangeValue) plus the
//     height_modifier draw, then the log column. Net effect: a tree whose base
//     is under water can grow from up to max_depth blocks below the origin.
//   - The log loop's gate switches on the ORIGINAL origin.Y: may_grow_through
//     below it, may_replace at/above it.
//   - The canopy is called with EMPTY candidate/branch-size lists.
//   - The top-level `base_block` key is applied as a post-canopy fixup.
//
// Shared tree parameters schema: base_block (two forms), base_cluster
// {may_replace, num_clusters, cluster_radius}, may_grow_on, may_replace,
// may_grow_through. The three block-descriptor lists are, in order,
// may_grow_on, may_replace, may_grow_through.
//
// ---- mega_canopy and mega_pine_canopy fields ----
//
// mega_canopy keys:
//
//	canopy_height    int range (required, default {3,3})
//	base_radius      int       (optional, default 2)
//	core_width       int       (required, default 1)
//	simplify_canopy  bool      (optional, default false)
//	leaf_block       block descriptor (required)
//
// Parsing core_width also marks the core width as present, and since
// core_width is required the core-width/trunk-size assert always applies.
// simplify_canopy is passed as the radial block-group write's corner bool:
// false = corners relaxed, true = strict circular test. The radial block-group
// write takes (api, position, RNG, block, radius, branch size, bool, block
// list) and is a 4-corner conservative circle rasterization; its persistent-bit
// step is an ordinary normalization, not an obstruction check. See
// placeRadialBlockGroup/megaCanopy.
//
// mega_pine_canopy keys: canopy_height (default {3,8}), base_radius (default
// 2), radius_step_modifier (float, default 3.5), core_width (default 1),
// leaf_block. It has no simplify_canopy and always uses relaxed corners. Its
// per-layer radius is a stepped taper:
//
//	dy == 0 (the topmost layer): radius = baseRadius.
//	dy != 0: radius = baseRadius + floor32(radiusStepModifier *
//	    float32(-dy) / float32(value)) [the divide happens FIRST, then the
//	    multiply], PLUS a +1 bump whenever this layer's pre-bump radius equals
//	    the PREVIOUS layer's pre-bump radius (a plateau) AND the layer's
//	    absolute world Y (anchor.Y+dy) is even.
//
// The result is a STEPPED cone (each radius held for ~2 layers, with a +1
// stagger on flat steps at even Y), unlike mega_canopy's smooth taper. The loop
// runs value+1 layers (dy = -value..0 inclusive), one more than mega_canopy
// for the same drawn value; its range guards compare pos.Y-Value against
// pos.Y+1, so value==0 places exactly ONE layer (dy=0, radius=baseRadius)
// where mega_canopy places nothing. See megaPineCanopy/megaPineRadiusFor and
// TestMegaPineCanopy_Place_SteppedTaperCrossSections.
//
// ---- cherry_trunk / cherry_canopy ----
//
//   - Branch generation is ITERATIVE: two inclusive int-range draws, then a
//     walk loop drawing ONE NextFloat per iteration, stepping vertically while
//     `NextFloat() < |dyRem| / (|dxRem|+|dyRem|+|dzRem|)` and diagonally
//     otherwise, placing a log per step (position validity test + single-block
//     write) until the endpoint is reached; it returns the branch tip.
//   - Per-tip canopy loop: branch size {1,1}; each tip gets a canopy call with
//     fresh EMPTY candidate and branch-size lists. Nothing between iterations
//     draws RNG, and tips are visited in generation order -- so it is
//     draw-for-draw equivalent to the trunk returning []anchor and Place
//     calling canopy.place once per anchor with nil candidates. The candidate
//     list (filled by the acacia trunk, read only by random_spread/mangrove)
//     is a different mechanism and cannot carry the tips.
//   - Cherry canopy leaf layer: a trunk-width-dependent rectangle with a
//     three-tier corner rule (radius < 3: chance-rolled square corners;
//     radius >= 3: hard-cut corners plus a chance-rolled near-corner ring
//     inside an inner disc), and a layer index of -1 uses a SEPARATE chance
//     field -- reachable from the two explicit hanging-leaves calls (layers -1
//     and -2) and from the ordinary per-layer loop whenever its int-range draw
//     makes the layer index -1. The hanging-leaves variant places the layer,
//     then walks the outer ring's 4 straight edges counter-clockwise, placing a
//     chance-rolled leaf one cell below each edge cell that holds the
//     just-placed leaf block, with a nested roll for a further leaf 2 cells
//     below.
//   - The constants in the parser's cherry branch are initial values that are
//     then overwritten by the JSON fields.
//
// ---- Attachable decorations and feature references ----
//
//  1. mangrove_canopy.canopy_decoration: megaTrunkDecoration.place, unchanged,
//     once per propagule inside a stride-3 loop over the SAME shuffled
//     propagule list the hanging_block pass walks, strictly BEFORE the
//     hanging_block pass, with all four horizontal directions enabled
//     (mangroveTrunkAllDirections). The outer chance validity gate is only a
//     skip optimization: percent-mode validity is `percent>=0`, true even for
//     the zeroed default, whose roll is false with zero draws -- so a nil
//     check on c.decoration is equivalent. See mangroveCanopy.place.
//  2. mangrove_roots.root_decoration: applied at two points of the single-root
//     write, plus the above_root position through the decorated-block write
//     (SetBlock, then decorate iff SetBlock succeeded -- placeDecoratedBlock).
//     All three use mangroveTrunkAllDirections. See mangrovePlaceRoot.
//  3. fallen_trunk.log_decoration_feature: the fallen trunk's fields are, in
//     order, log_length, stump_height, height_modifier, trunk_block,
//     log_decoration_feature, trunk_decoration. log_decoration_feature is a
//     feature reference, placed once per log successfully placed along the
//     fallen line (never for the stump), at that log's position. This port
//     does it via ctx.WithOrigin(p) + target.Place(subCtx). Unlike every other
//     delegating feature in this package (aggregate/sequence/conditional_list/
//     scan_surface/scatter/search_feature/snap_to_surface/
//     surface_relative_threshold/vegetation_patch/weighted_random), vanilla
//     applies NO feature-permission gate here, so there is no
//     IsAllowedToPlaceFeature check; WithRecursionGuard is kept purely as a
//     safety net against circular references. fallen_trunk.trunk_decoration
//     (the stump column's decoration) is supported via
//     parseAttachableDecorationObject/megaTrunkDecoration, like mega_trunk/
//     mangrove_trunk. See placeFallenTrunk.
//  4. trunk_decoration.num_steps: a valid int key that the game never reads
//     (the multi-decoration write only uses decoration_blocks_sequence and each
//     entry's int range), so it is accepted silently, like other inert fields
//     (trunk_width, branches.branch_chance).
//  5. base_cluster: used only by the mega trunk. num_clusters/cluster_radius
//     are plain ints, not int ranges. Implemented as placeBaseClusterGroundwork
//     (with its circle and single-position base-block replacement helpers),
//     run at the end of placeMegaTrunk after the top canopy. See baseCluster
//     for the draw sequence.
//
// ---- acacia_trunk and fancy_trunk details ----
//
//   - acacia_trunk.branches has two consumers: the leaning-branch placement
//     (allow_diagonal_growth true) and the vertical-branch placement (false).
//     They draw branch_length/branch_position in OPPOSITE order; see
//     acaciaBranches.
//   - acacia_trunk.trunk_lean.lean_length extends the trunk loop past
//     trunk_height while the y write stays guarded by `index < height`, so it
//     grows a horizontal run at the top, not a taller tree.
//   - acacia_trunk.trunk_height.min_height_for_canopy gates CANOPY ANCHOR
//     collection only, never placement; a trunk that never clears it hands the
//     canopy a zeroed anchor.
//   - leanStart is `height - draw` (height being the int height parameter),
//     not the lean_height draw itself: the lean begins a drawn number of cells
//     BELOW the trunk top. This moves positions only, not the RNG stream.
//   - fancy_trunk (placeFancyTrunk, with its clear-line check and limb
//     placement) has no lean: it scatters foliage coordinates on a
//     semicircular profile, grows a canopy at each and draws a limb from the
//     trunk out to each. The trunk stops at `trunk_height.scale` of the sampled
//     height (so foliage routinely sits above it), and a short height draw
//     gives a stunted tree whose foliage overlaps its own trunk. Both are
//     vanilla behaviour.
//   - trunk_decoration is supported for acacia_trunk AND the plain `trunk` key
//     (the simple trunk accepts it too; four vanilla definitions use it on
//     `trunk`, one on acacia_trunk). See acaciaDecorationMask for why the
//     acacia mask is not the obvious form.
//
// With these, minecraft:tree_feature is StatusImplemented (see coverage.go).
package features

import (
	"fmt"
	"math"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const treeTypeID = "minecraft:tree_feature"

// knownCanopyKeys is the complete <shape>_canopy JSON key vocabulary,
// including "poplar_canopy". "canopy" (bare) is the generic/default key. All
// twelve keys are implemented.
var knownCanopyKeys = []string{
	"acacia_canopy",
	"canopy",
	"cherry_canopy",
	"fancy_canopy",
	"mangrove_canopy",
	"mega_canopy",
	"mega_pine_canopy",
	"pine_canopy",
	"poplar_canopy",
	"roofed_canopy",
	"spruce_canopy",
	"random_spread_canopy",
}

// Per-direction X and Z steps, indices 0-3 (South/West/North/East). Index
// picked by rnd.NextIntBound(4) (RNG draw #1, see the file header).
var leanDX = [4]int{0, -1, 0, 1}
var leanDZ = [4]int{1, 0, -1, 0}

// The acacia trunk's hardcoded, non-JSON-configurable fields (see the file
// header). Every acacia trunk uses these exact values.
var leanStartRange = [2]int{1, 4}
var leanStepsRange = [2]int{1, 4}

const branchCollectAfter = 3

// treeIntRangeValue is the game's int-range draw (see the file header).
// min >= max-1 draws nothing (0 draws, returns min); otherwise draws exactly
// one nextIntBound(max-min) -- uniform over [min, max-1], max EXCLUSIVE.
// Same formula as vegetation_patch.go's vegIntRangeValue.
func treeIntRangeValue(min, max int, rnd random.IRandom) int {
	if min >= max-1 {
		return min // *** 0 draws ***
	}
	return min + rnd.NextIntBound(max-min) // *** RNG CALL ***
}

// treeIntRangeValueInclusive is the game's INCLUSIVE int-range draw, distinct
// from treeIntRangeValue above: min>=max returns min with ZERO draws;
// otherwise the result is uniform over [min,max], maximum INCLUDED, via one
// NextIntBound(max-min+1) draw.
func treeIntRangeValueInclusive(min, max int, rnd random.IRandom) int {
	if min >= max {
		return min // *** 0 draws ***
	}
	return min + rnd.NextIntBound(max-min+1) // *** RNG CALL ***
}

// parseTreeIntRange accepts the same three shapes this codebase's other
// int-range-typed fields already accept (see growing_plant.go/
// vegetation_patch.go's own parsers) -- a plain number, [min,max] array, or
// {min,max} object. Used by spruce_canopy's lower_offset/upper_offset/
// max_radius (all int-range fields -- see the file header).
func parseTreeIntRange(raw any, jsonPath string) (min, max int, err error) {
	lo, hi, err := parseEngineRange(raw, jsonPath)
	if err != nil {
		return 0, 0, err
	}
	return int(lo), int(hi), nil
}

// passesAllowList is the game's placement allow-list check -- true when ids is empty (no restriction) or existing is one of ids. Used,
// non-inverted, by both canopies' leaf gate and isValidTreePosition's
// may_replace fast path.
func passesAllowList(existing block.ID, ids block.MatchSet) bool {
	if ids.Empty() {
		return true
	}
	return ids.Contains(existing)
}

// isValidTreePosition is the tree position validity test -- gates every
// trunk-column log placement. See the file header for the air-fallback
// approximation.
func isValidTreePosition(api wgen.BlockWorld, p wgen.BlockPos, mayReplaceIDs block.MatchSet) bool {
	existing := api.GetBlock(p)
	if passesAllowList(existing, mayReplaceIDs) {
		return true
	}
	return api.Palette().IsAir(existing)
}

// placeBaseBlock is the tree's base-block write -- the single
// root-flare/ground-fixup step before the trunk column. Skips
// (no-op) if the ground already passes may_grow_on; otherwise force-places
// fallback -- the first may_grow_on descriptor, resolved to one concrete
// block at build time (a PRODUCING use, unlike the membership test above,
// which stays a real predicate -- see buildTreeFeature). Never fails the
// tree.
func placeBaseBlock(api wgen.BlockWorld, p wgen.BlockPos, mayGrowOn block.MatchSet, fallback block.ID) {
	if mayGrowOn.Empty() {
		return
	}
	existing := api.GetBlock(p)
	if mayGrowOn.Contains(existing) {
		return
	}
	api.SetBlock(p, fallback)
}

// placeLog is the decorated-block write for the trunk log itself. The
// attachable decoration's write is a no-op when no decoration is configured
// (see the file header), so it is not modeled here.
func placeLog(api wgen.BlockWorld, p wgen.BlockPos, logID block.ID) {
	api.SetBlock(p, logID)
}

type treeParamsLists struct {
	mayGrowOn  block.MatchSet
	mayReplace block.MatchSet
}

// canopyPlacer draws a canopy's own RNG (if any) and places its leaves.
// anchor is the final (lean-adjusted) trunk-top position. candidates is the
// full column of successfully-placed trunk log positions (see
// TreeFeature.Place) -- the acacia trunk's candidate block-position list
// that every canopy receives, filled inside the SAME isValidTreePosition
// gate the trunk loop uses (see the file header's random_spread_canopy
// notes). Every canopy except randomSpreadCanopy ignores it, as in vanilla.
type canopyPlacer interface {
	place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, candidates []wgen.BlockPos)
}

// treeCanopyAnchor is one ordered canopy invocation emitted by a trunk.
// candidates belongs to this invocation only. Cherry emits nil for every
// tip, matching the fresh empty list the game builds for each tip;
// the existing acacia path emits its complete log-column list once.
type treeCanopyAnchor struct {
	pos        wgen.BlockPos
	candidates []wgen.BlockPos
}

// acaciaCanopy is the acacia canopy's placement -- fully deterministic,
// ZERO RNG.
type acaciaCanopy struct {
	leafID         block.ID
	canopySize     int
	simplifyCanopy bool
}

func (c *acaciaCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, _ random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	tryPlace := func(x, y, z int) {
		p := wgen.BlockPos{X: x, Y: y, Z: z}
		if passesAllowList(api.GetBlock(p), params.mayReplace) {
			api.SetBlock(p, c.leafID)
		}
	}

	// Layer y+1 -- no RNG.
	if c.simplifyCanopy {
		m := max(c.canopySize, 1)
		for dx := 1 - m; dx <= m-1; dx++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for dz := 1 - m; dz <= m-1; dz++ {
				tryPlace(anchor.X+dx, anchor.Y+1, anchor.Z+dz)
			}
		}
	} else {
		m := max(c.canopySize, 1)
		n := max(c.canopySize, 2)
		for dx := 2 - n; dx <= n-2; dx++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for dz := 2 - n; dz <= n-2; dz++ {
				tryPlace(anchor.X+dx, anchor.Y+1, anchor.Z+dz)
			}
		}
		tryPlace(anchor.X+(m-1), anchor.Y+1, anchor.Z)
		tryPlace(anchor.X-(m-1), anchor.Y+1, anchor.Z)
		tryPlace(anchor.X, anchor.Y+1, anchor.Z+(m-1))
		tryPlace(anchor.X, anchor.Y+1, anchor.Z-(m-1))
	}

	// Layer y+0 -- square minus the 4 exact corners (octagon ring).
	//
	// The corner cut is deterministic (no chance roll anywhere
	// in this shape) and is NOT guarded on a nonzero radius
	// -- there is no radius-zero escape in the loop at all, unlike
	// the spruce canopy's, which has one. So at
	// canopy_size 0 this layer's only cell IS a corner and the layer comes
	// out empty. Reproduced, not smoothed over -- see
	// TestCanopies_RadiusZeroCornerTests.
	r := c.canopySize
	for dx := -r; dx <= r; dx++ {
		TickDeadline("building a canopy layer as wide as its radius asks")
		for dz := -r; dz <= r; dz++ {
			if abs(dx) == r && abs(dz) == r {
				continue
			}
			tryPlace(anchor.X+dx, anchor.Y, anchor.Z+dz)
		}
	}
}

// pineCanopy is the pine canopy's placement -- ONE RNG draw (unconditional
// vertical jitter), then a deterministic stack of canopy_height+1 diamond-
// ring layers.
type pineCanopy struct {
	leafID                           block.ID
	canopyHeightMin, canopyHeightMax int
	baseRadius                       int
}

func (c *pineCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	tryPlace := func(x, y, z int) {
		p := wgen.BlockPos{X: x, Y: y, Z: z}
		if passesAllowList(api.GetBlock(p), params.mayReplace) {
			api.SetBlock(p, c.leafID)
		}
	}

	// *** RNG CALL *** -- unconditional vertical jitter. For a fixed
	// canopy_height=2/base_radius=2 this never actually changes the
	// placed shape, but the draw itself is mandatory -- see the file header.
	canopyHeight := treeIntRangeValue(c.canopyHeightMin, c.canopyHeightMax, rnd)
	jitter := rnd.NextIntBound(canopyHeight + 1)
	topCap := jitter + c.baseRadius

	shrinkAtY := 2 - canopyHeight
	bottomY := -canopyHeight
	radius := 0
	y := 1
	for {
		for dx := -radius; dx <= radius; dx++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for dz := -radius; dz <= radius; dz++ {
				if radius > 0 && abs(dx) == radius && abs(dz) == radius {
					continue
				}
				tryPlace(anchor.X+dx, anchor.Y+y, anchor.Z+dz)
			}
		}
		grown := radius
		if radius < topCap {
			grown = radius + 1
		}
		shrink := radius > 0 && y == shrinkAtY
		done := y-1 == bottomY
		if shrink {
			radius--
		} else {
			radius = grown
		}
		y--
		if done {
			break
		}
	}
}

// simpleCanopy is the simple canopy's placement -- the bare "canopy" key
// (see the file header). Its only RNG-drawing part is variation_chance; a
// body that omits the key is ZERO RNG. Note the corner test is deliberately
// UNGUARDED at radius 0 -- see the file header and
// TestCanopies_RadiusZeroCornerTests.
type simpleCanopy struct {
	leafID               block.ID
	offsetMin, offsetMax int
	minWidth             int
	rise, run            int
	variationChance      []chanceInformation
	decoration           *canopyDecoration
}

type canopyDecoration struct {
	blockID  block.ID
	chance   chanceInformation
	stepsMin int
	stepsMax int
	pal      *block.Palette
}

func (d *canopyDecoration) place(api wgen.BlockWorld, leaf wgen.BlockPos, rnd random.IRandom) {
	directions := [...]struct {
		dx, dz int
		bit    int
	}{{-1, 0, 32}, {1, 0, 8}, {0, -1, 4}, {0, 1, 16}}
	for _, direction := range directions {
		if !d.chance.roll(rnd) {
			continue
		}
		p := wgen.BlockPos{X: leaf.X + direction.dx, Y: leaf.Y, Z: leaf.Z + direction.dz}
		if !api.Palette().IsAir(api.GetBlock(p)) {
			continue
		}
		decorated, ok := d.pal.WithIntState(d.blockID, block.MultiFaceDirectionBits, direction.bit)
		if !ok {
			decorated = d.blockID
		}
		steps := treeIntRangeValueInclusive(d.stepsMin, d.stepsMax, rnd)
		for i := 0; i < steps && api.Palette().IsAir(api.GetBlock(p)); i++ {
			TickDeadline("growing a canopy decoration as far as its num_steps asks")
			api.SetBlock(p, decorated)
			p.Y--
		}
	}
}

// slopeAt is the simple canopy's pre-loop/per-layer radius formula:
// int-multiply (rise*dy), cast to float32, float-multiply by a stored
// float32 (1.0/run), truncate the result toward zero -- exactly Go's
// float32->int conversion. See the file header for the rise/run
// operand-assignment caveat.
func (c *simpleCanopy) slopeAt(dy int) int {
	invRun := float32(1) / float32(c.run)
	return int(float32(int32(c.rise)*int32(dy)) * invRun)
}

func (c *simpleCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	tryPlace := func(x, y, z int) {
		p := wgen.BlockPos{X: x, Y: y, Z: z}
		existing := api.GetBlock(p)
		// Leaf gate: the simple canopy's material-type check has no
		// material-code registry in this codebase -- reuses
		// isValidTreePosition's approximation (may_replace, OR the palette's
		// own IsAir) rather than inventing a new one. See the file header.
		if passesAllowList(existing, params.mayReplace) || api.Palette().IsAir(existing) {
			api.SetBlock(p, c.leafID)
			if c.decoration != nil {
				c.decoration.place(api, p, rnd)
			}
		}
	}

	topSlope := c.slopeAt(c.offsetMax)
	for dy := c.offsetMin; dy <= c.offsetMax; dy++ {
		radius := topSlope + c.minWidth - c.slopeAt(dy)
		if radius < 0 {
			continue
		}
		y := anchor.Y + dy
		for x := anchor.X - radius; x <= anchor.X+radius; x++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for z := anchor.Z - radius; z <= anchor.Z+radius; z++ {
				if len(c.variationChance) > 0 && abs(x-anchor.X) == radius && abs(z-anchor.Z) == radius && c.variationChance[dy-c.offsetMin].roll(rnd) {
					continue
				}
				tryPlace(x, y, z)
			}
		}
	}
}

// fancyCanopy is the fancy canopy's placement -- ZERO RNG (neither it nor
// its private layer-fill helper draws from the RNG each receives by
// parameter). A tapered disc-stack: radius-1 caps top and bottom,
// full radius in between. See the file header for details.
type fancyCanopy struct {
	leafID block.ID
	height int
	radius int
}

// fillLayer is the fancy canopy's layer fill -- a single disc-shaped layer
// at absolute y, radius r. The test is (|dx|+0.5)^2 + (|dz|+0.5)^2 <= r*r,
// where the game squares with pow(x,2.0) -- mathematically identical to x*x
// for all finite x, so this port squares directly. r<0 places nothing (see
// the file header).
//
// Widths: in the game |d|+0.5 is a FLOAT32 add (against a 0.5f constant),
// widened to double for the square, and the sum and compare are done in
// double, against r*r widened from int. This port does the +0.5 in float64
// instead; that is value-identical because k+0.5 is exact in both widths
// for any |d| this canopy reaches. Each square is separately rounded and the
// sum is a separate add, so the explicit float64() on BOTH squares below is
// a rounding barrier: without it gc fuses a square into the add (one
// rounding where the game has two). fx2 needs its own even though it is hoisted out
// of the inner loop -- gc sinks the loop-invariant multiply back into the add
// and fuses it there; only the conversion stops that. Do not simplify either
// away.
func (c *fancyCanopy) fillLayer(api wgen.BlockWorld, center wgen.BlockPos, r int, mayReplace block.MatchSet) {
	rr := float64(r * r)
	for dx := -r; dx <= r; dx++ {
		TickDeadline("building a canopy layer as wide as its radius asks")
		fx := float64(abs(dx)) + 0.5
		fx2 := float64(fx * fx)
		for dz := -r; dz <= r; dz++ {
			fz := float64(abs(dz)) + 0.5
			if fx2+float64(fz*fz) > rr {
				continue
			}
			p := wgen.BlockPos{X: center.X + dx, Y: center.Y, Z: center.Z + dz}
			if passesAllowList(api.GetBlock(p), mayReplace) {
				api.SetBlock(p, c.leafID)
			}
		}
	}
}

func (c *fancyCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, _ random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	for dy := 0; dy < c.height; dy++ {
		TickDeadline("stacking canopy layers as tall as its canopy height asks")
		r := c.radius
		if dy == 0 || dy == c.height-1 {
			r = c.radius - 1
		}
		if r < 0 {
			continue
		}
		center := wgen.BlockPos{X: anchor.X, Y: anchor.Y + dy, Z: anchor.Z}
		c.fillLayer(api, center, r, params.mayReplace)
	}
}

// spruceCanopy is the spruce canopy's placement -- 4 RNG draws
// (3 int-range draws plus one direct nextIntBound), a downward
// ground-search that draws nothing, then a tiered grow-then-reset ring
// stack. See the file header for details.
type spruceCanopy struct {
	leafID               block.ID
	lowerMin, lowerMax   int
	upperMin, upperMax   int
	radiusMin, radiusMax int
}

func (c *spruceCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	tryPlace := func(x, y, z int) {
		p := wgen.BlockPos{X: x, Y: y, Z: z}
		existing := api.GetBlock(p)
		// Leaf gate -- the SAME material-type shape as the simple canopy's
		// gate, approximated the same way. See the file header.
		if passesAllowList(existing, params.mayReplace) || api.Palette().IsAir(existing) {
			api.SetBlock(p, c.leafID)
		}
	}

	// Ground search. Walks straight down from the anchor testing the
	// placement allow-list check (NOT the OR-air fallback above -- see the
	// file header) until a candidate passes, or aborts (drawing NOTHING) if
	// MinY is reached first.
	y := anchor.Y
	for {
		TickDeadline("searching downward for a canopy anchor")
		candidate := wgen.BlockPos{X: anchor.X, Y: y - 1, Z: anchor.Z}
		if passesAllowList(api.GetBlock(candidate), params.mayReplace) {
			break
		}
		if y <= api.MinY() {
			return // *** NO RNG drawn on this path *** -- matches vanilla
		}
		y--
	}

	// *** RNG CALLS 1-3 *** -- lower_offset/upper_offset/max_radius, each
	// via the int-range draw (treeIntRangeValue).
	lowerVal := treeIntRangeValue(c.lowerMin, c.lowerMax, rnd)
	upperVal := treeIntRangeValue(c.upperMin, c.upperMax, rnd)
	maxRadiusVal := treeIntRangeValue(c.radiusMin, c.radiusMax, rnd)

	// *** RNG CALL 4 *** -- a DIRECT bounded integer draw (the same one
	// cave.go uses), NOT via the int-range draw: bound is max_radius's raw
	// (max-min), with no -1. See the file header.
	radius := rnd.NextIntBound(c.radiusMax - c.radiusMin)

	top := upperVal + anchor.Y - lowerVal // NOTE: anchor.Y, not the search's y
	n := top - y
	if n <= -2 {
		// Raised as a typed refusal rather than a bare panic: the condition and the position in
		// the sequence are unchanged, but session.go can now report it as a diagnostic naming
		// the field instead of re-panicking a Go stack trace at the user. See
		// features.MalformedRangeRefusal.
		RaiseMalformedRange("spruce_canopy.lower_offset/upper_offset", fmt.Sprintf(
			"the pair produced a range of %d against the ground level found at y=%d "+
				"(lower_offset drew %d, upper_offset drew %d)", n, y, lowerVal, upperVal))
	}
	if n == -1 {
		return // legal, empty range -- places nothing
	}

	widthCap := c.radiusMax - c.radiusMin - 1 // the raw span, NOT maxRadiusVal
	flag := 0
	topY := anchor.Y + upperVal
	for dy := 0; ; dy++ {
		layerY := topY - dy
		for dx := -radius; dx <= radius; dx++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for dz := -radius; dz <= radius; dz++ {
				// The `radius != 0` half is a vanilla guard, and it is the
				// thing this shape does that the acacia canopy does NOT -- see
				// TestCanopies_RadiusZeroCornerTests. Deleting it would
				// silently empty every radius-0 layer.
				if radius != 0 && abs(dx) == radius && abs(dz) == radius {
					continue
				}
				tryPlace(anchor.X+dx, layerY, anchor.Z+dz)
			}
		}

		// Grow-then-reset state machine -- kept step for step rather than
		// simplified. See the file header.
		prevWidthCap := widthCap
		newCap := maxRadiusVal
		if prevWidthCap < maxRadiusVal {
			newCap = prevWidthCap + 1
		}
		growing := radius < prevWidthCap
		if radius >= prevWidthCap {
			radius = flag
		} else {
			radius++
		}
		if !growing {
			widthCap = newCap
			flag = 1
		}
		if dy == n {
			break
		}
	}
}

// cherryCanopy is the cherry canopy's placement with its two
// private layer helpers. It is specialized to the
// existing acacia trunk's branch size {1,1}: the placement's opening compares
// both branch-size words to trunk_width, so buildTreeFeature requires the
// configured width to be 1 and no trunk abstraction change is needed.
//
// Load-bearing ordering:
//   - leaf resolution precedes both range draws; radius is sampled first,
//     height second;
//   - ordinary-layer wide-bottom and corner rolls both come before the
//     allow-list check;
//   - hanging traversal reads the generated layer, compares the block
//     types, rolls hanging, and only after a successful placement (the
//     write reporting success) rolls extension.
//
// Vanilla defaults are height=5, radius=4, trunk_width=1 and zeroed chance
// objects. Nevertheless height/radius and all four chance fields are
// required in JSON; only trunk_width is optional, so the builder follows
// those flags rather than treating every default as JSON optional.
type cherryCanopy struct {
	leafID                       block.ID
	heightMin, heightMax         int
	radiusMin, radiusMax         int
	trunkWidth                   int
	wideBottomHoleChance         chanceInformation
	cornerHoleChance             chanceInformation
	hangingLeavesChance          chanceInformation
	hangingLeavesExtensionChance chanceInformation
}

func cherryDistanceToTrunk(offset, trunkWidth int) int {
	if trunkWidth < 2 {
		return abs(offset)
	}
	return min(abs(offset), abs(offset-(trunkWidth-1)))
}

// placeLayer is the cherry canopy's leaf-layer write. Candidate order is dx
// outer, dz inner, both ascending through [-radius,trunkWidth+radius). Chance
// rolls stay ahead of may_replace exactly as in vanilla, including rolls for
// cells the allow-list later rejects.
//
// The two gates below can BOTH fire on one cell. A bottom-layer cell (dy == -1) that is outer-edge on
// either axis rolls the wide-bottom chance; on TRUE it is skipped with no
// second roll, and on FALSE it FALLS THROUGH to the corner gate.
// There, radius>=3 plus an exact corner skips outright
// with NO second roll; radius>=3 without an exact
// corner rolls the corner chance only when |dx|+|dz| > 2r-2; and radius<3
// with an exact corner rolls it -- two draws on the one cell. All three
// branches are pinned per-cell, in order, by
// TestCherryCanopy_BottomLayerCornerDoubleRoll.
func (c *cherryCanopy) placeLayer(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, dy, radius int) {
	for dx := -radius; dx < c.trunkWidth+radius; dx++ {
		TickDeadline("building a canopy layer as wide as its radius asks")
		xDist := cherryDistanceToTrunk(dx, c.trunkWidth)
		for dz := -radius; dz < c.trunkWidth+radius; dz++ {
			zDist := cherryDistanceToTrunk(dz, c.trunkWidth)

			if dy == -1 && (xDist == radius || zDist == radius) {
				// *** RNG CALL (0 or 1 draw) *** -- wide-bottom edge gate.
				if c.wideBottomHoleChance.roll(rnd) {
					continue
				}
			}

			corner := xDist == radius && zDist == radius
			if radius < 3 {
				if corner {
					// *** RNG CALL (0 or 1 draw) *** -- exact small-radius corner.
					if c.cornerHoleChance.roll(rnd) {
						continue
					}
				}
			} else {
				if corner {
					continue // exact large-radius corners skip with ZERO draws
				}
				if xDist+zDist > 2*radius-2 {
					// *** RNG CALL (0 or 1 draw) *** -- near-corner cell.
					if c.cornerHoleChance.roll(rnd) {
						continue
					}
				}
			}

			p := wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}
			if passesAllowList(api.GetBlock(p), params.mayReplace) {
				api.SetBlock(p, c.leafID)
			}
		}
	}
}

var cherryCounterClockwise = [4]int{3, 0, 1, 2}
var cherryStepX = [4]int{0, -1, 0, 1}
var cherryStepZ = [4]int{1, 0, -1, 0}

// placeLayerWithHanging is the cherry canopy's
// leaf-layer-with-hanging-leaves-below variant.
// It completes the ordinary layer first, then visits direction indices 0..3.
func (c *cherryCanopy) placeLayerWithHanging(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, dy, radius int) {
	c.placeLayer(api, anchor, rnd, params, dy, radius)

	count := c.trunkWidth + 2*radius - 1
	if count <= 0 {
		return
	}
	leafName := api.Palette().NameOf(c.leafID)
	for direction := 0; direction < 4; direction++ {
		ccw := cherryCounterClockwise[direction]
		edgeOffset := radius
		if ccw == 3 || ccw == 0 {
			edgeOffset = c.trunkWidth + radius - 1
		}
		x := anchor.X + edgeOffset*cherryStepX[ccw] - radius*cherryStepX[direction]
		z := anchor.Z + edgeOffset*cherryStepZ[ccw] - radius*cherryStepZ[direction]
		for i := 0; i < count; i++ {
			TickDeadline("hanging cherry leaves along a layer as wide as its canopy_radius asks")
			layerPos := wgen.BlockPos{X: x, Y: anchor.Y + dy, Z: z}
			if api.Palette().NameOf(api.GetBlock(layerPos)) == leafName {
				// *** RNG CALL (0 or 1 draw) *** -- only beneath an actual
				// leaf block type on the just-generated layer.
				if c.hangingLeavesChance.roll(rnd) {
					below := wgen.BlockPos{X: x, Y: layerPos.Y - 1, Z: z}
					if passesAllowList(api.GetBlock(below), params.mayReplace) && api.SetBlock(below, c.leafID) {
						// *** RNG CALL (0 or 1 draw) *** -- only after the first
						// hanging placement actually succeeds.
						if c.hangingLeavesExtensionChance.roll(rnd) {
							extension := wgen.BlockPos{X: x, Y: below.Y - 1, Z: z}
							if passesAllowList(api.GetBlock(extension), params.mayReplace) {
								api.SetBlock(extension, c.leafID)
							}
						}
					}
				}
			}
			x += cherryStepX[direction]
			z += cherryStepZ[direction]
		}
	}
}

func (c *cherryCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	// *** RNG CALL 1 (0 or 1 draw) *** -- radius MUST precede height.
	radius := treeIntRangeValueInclusive(c.radiusMin, c.radiusMax, rnd)
	// *** RNG CALL 2 (0 or 1 draw) *** -- height.
	height := treeIntRangeValueInclusive(c.heightMin, c.heightMax, rnd)

	radiusA := c.trunkWidth + radius - 4
	radiusB := c.trunkWidth + radius - 3
	radiusC := c.trunkWidth + radius - 2
	c.placeLayer(api, anchor, rnd, params, height-3, radiusA)
	c.placeLayer(api, anchor, rnd, params, height-4, radiusB)
	if height > 4 {
		for dy := height - 5; dy >= 0; dy-- {
			TickDeadline("stacking canopy layers as tall as its canopy height asks")
			c.placeLayer(api, anchor, rnd, params, dy, radiusC)
		}
	}
	c.placeLayerWithHanging(api, anchor, rnd, params, -1, radiusC)
	c.placeLayerWithHanging(api, anchor, rnd, params, -2, radiusB)
}

// randomSpreadWeightedBlock is one leaf_blocks entry -- in JSON a 2-element
// array [block descriptor, float weight] (exactly two elements; see the
// file header).
type randomSpreadWeightedBlock struct {
	id     block.ID
	weight float32
}

// randomSpreadPickBlock is the random-spread canopy's weighted leaf-block
// pick -- a GENUINELY DIFFERENT algorithm from shared.go's WeightedPick
// (NextFloat()*sum) despite the superficial "sum weights, walk subtracting"
// resemblance: the accumulated float weight sum is truncated to int32 BEFORE
// the draw, and the draw itself is an ordinary rnd.NextIntBound(int32(sum))
// with an INTEGER bound and INTEGER result -- not a NextFloat() draw at all.
// Skipped (0 draws) when the truncated sum is exactly 0, matching
// NextIntBound(0)'s own contract (the game tests this explicitly first).
//
// The scan is ALSO int32-truncated at every single step, not a running
// float accumulator: remainder = int32(float32(remainder) - weight[i]),
// its sign tested after each subtraction. This can matter for fractional
// weights (e.g. repeated 0.5s) -- reproduced 1:1 below; Go's
// int32(float32(x)) already truncates toward zero, matching vanilla
// bit-for-bit for in-range values.
func randomSpreadPickBlock(blocks []randomSpreadWeightedBlock, rnd random.IRandom) int {
	var sum float32
	for _, b := range blocks {
		sum += b.weight
	}
	sumInt := int32(sum) // truncated -- the bound about to feed NextIntBound
	var draw int32
	if sumInt != 0 {
		draw = int32(rnd.NextIntBound(int(sumInt))) // *** RNG CALL (0 or 1 draw) ***
	}
	remainder := int32(float32(draw) - blocks[0].weight)
	if remainder < 0 {
		return 0
	}
	for i := 1; i < len(blocks); i++ {
		remainder = int32(float32(remainder) - blocks[i].weight)
		if remainder < 0 {
			return i
		}
	}
	// Mathematically unreachable for a well-formed (non-negative-weight)
	// list: the true float sum of all weights is >= sumInt (sumInt is its
	// own floor), and draw < sumInt, so cumulative subtraction must go
	// negative by the last element. Falls through here only for a
	// malformed (e.g. negative-weight) list -- vanilla's walk is unguarded
	// too, so no new bound check is invented here.
	return len(blocks) - 1
}

// randomSpreadCanopy is the random-spread canopy's placement --
// see the file header for details (RNG draw sequence, schema,
// the weighted-pick subtlety above, and the trunk candidate-list
// wiring).
type randomSpreadCanopy struct {
	heightMin, heightMax int
	radiusMin, radiusMax int
	attempts             int
	blocks               []randomSpreadWeightedBlock
}

func (c *randomSpreadCanopy) place(api wgen.BlockWorld, _ wgen.BlockPos, rnd random.IRandom, params treeParamsLists, candidates []wgen.BlockPos) {
	if len(candidates) == 0 {
		return // vanilla returns early on an empty list -- ZERO draws
	}

	// *** RNG CALL 1 (0 or 1 draw) *** -- canopy_height, via the SAME
	// two-argument integer draw as geode.go's geodeIntRange (0 draws when
	// max<=min, else min+NextIntBound(max-min)) -- not the int-range draw
	// (see the file header).
	heightVal := geodeIntRange(c.heightMin, c.heightMax, rnd)
	// *** RNG CALL 2 (0 or 1 draw) *** -- canopy_radius, same shape.
	radiusVal := geodeIntRange(c.radiusMin, c.radiusMax, rnd)

	for _, cand := range candidates {
		for i := 0; i < c.attempts; i++ {
			TickDeadline("retrying leaf placement as many times as its leaf_placement_attempts asks")
			// *** RNG CALL (0 or 1 draw) *** -- weighted leaf-block pick.
			blockID := c.blocks[randomSpreadPickBlock(c.blocks, rnd)].id

			// *** RNG CALLS (6, always, once bound>0 draws start) *** --
			// X,X,Y,Y,Z,Z order. X/Z bound = radiusVal, Y bound = heightVal
			// (canopy_height feeds Y; canopy_radius feeds X and Z -- see the
			// file header).
			dx1 := rnd.NextIntBound(radiusVal)
			dx2 := rnd.NextIntBound(radiusVal)
			dy1 := rnd.NextIntBound(heightVal)
			dy2 := rnd.NextIntBound(heightVal)
			dz1 := rnd.NextIntBound(radiusVal)
			dz2 := rnd.NextIntBound(radiusVal)

			p := wgen.BlockPos{
				X: cand.X + (dx1 - radiusVal) + dx2 + 1,
				Y: cand.Y + (dy1 - heightVal) + dy2 + 1,
				Z: cand.Z + (dz1 - radiusVal) + dz2 + 1,
			}
			existing := api.GetBlock(p)
			// Leaf gate: the vanilla gate is a block-descriptor list match of
			// the existing block against the tree parameters' may_replace
			// list, plus block-level and material-type terms (codes 0,5,7,8
			// and two further block-level predicates) this codebase has no
			// registry for -- see the file header. Reuses the same
			// approximation the simple and spruce canopies use
			// (passesAllowList OR IsAir), which also reproduces vanilla's
			// "empty may_replace -> always place" behaviour via
			// passesAllowList's "empty ids -> true" contract.
			if passesAllowList(existing, params.mayReplace) || api.Palette().IsAir(existing) {
				api.SetBlock(p, blockID)
			}
		}
	}
}

// roofedCanopy is the roofed canopy's placement (`roofed_canopy`
// key) -- see the file header for details (schema, field set, the single
// boolean RNG draw, and the sx=sz=1 simplification the fixed acacia branch
// size {1,1} allows).
type roofedCanopy struct {
	leafID       block.ID
	canopyHeight int // "canopy_height" (required)
	outerRadius  int // "outer_radius"  (optional in vanilla, default unknown -- required here)
	innerRadius  int // "inner_radius"  (optional in vanilla, default unknown -- required here)
	coreWidth    int
}

// roofedUpperCornerAllowed is the guard gating the roof-cap level
// (y=anchor.Y+canopyHeight) half of each floor/roof-cap pair: a two-clause
// exclusion around -outerRadius and 1-outerRadius. Kept clause for clause
// rather than simplified into something more "sensible-looking" -- this
// project preserves the original control flow (see the file header).
func roofedUpperCornerAllowed(j, k, outerRadius int) bool {
	notFirst := j == -outerRadius && k <= 1-outerRadius
	notSecond := k == -outerRadius && j == 1-outerRadius
	return !(notFirst || notSecond)
}

func (c *roofedCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, _ treeParamsLists, _ []wgen.BlockPos) {
	coreWidth := max(1, c.coreWidth)
	// Leaf gate: the roofed canopy's own gate is JUST a material-type test
	// against index 0 -- a single type code, not the 3-type OR-chain
	// (0,7,8 plus a second world-API check) the
	// simple, spruce and random-spread canopies approximate as
	// "passesAllowList OR IsAir".
	// No may_replace fallback appears at this gate at all -- see the file
	// header for why this port reads type 0 as Air alone, with no OR.
	tryPlace := func(x, y, z int) {
		p := wgen.BlockPos{X: x, Y: y, Z: z}
		if api.Palette().IsAir(api.GetBlock(p)) {
			api.SetBlock(p, c.leafID)
		}
	}

	r1, h := c.outerRadius, c.canopyHeight

	// 1. Floor + roof cap (outer_radius), ZERO RNG. sizeX_eff==sizeZ_eff==1
	// unconditionally for this port (core_width==1 required at build time --
	// see the file header), so the general sizeX_eff-1-j/sizeZ_eff-1-k
	// "mirror around the core rectangle's far edge" formula collapses to a
	// bare negation here. NOTE: this is NOT a sparse diagonal -- j and k each
	// sweep every integer in [-r1,0], and each iteration places at both j and
	// its mirror -j, so together they cover the WHOLE (2r1+1)x(2r1+1) square
	// exactly once per cell (see the file header).
	if r1 != -1 {
		for j := -r1; j <= 0; j++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for k := -r1; k <= 0; k++ {
				mj, mk := coreWidth-1-j, coreWidth-1-k
				// Floor: one cell BELOW anchor, unconditional -- fills the
				// full square, no corner cut.
				tryPlace(anchor.X+j, anchor.Y-1, anchor.Z+k)
				tryPlace(anchor.X+mj, anchor.Y-1, anchor.Z+k)
				tryPlace(anchor.X+j, anchor.Y-1, anchor.Z+mk)
				tryPlace(anchor.X+mj, anchor.Y-1, anchor.Z+mk)
				// Roof cap: at anchor.Y+canopyHeight, gated -- a chamfered/
				// rounded-diamond trim of the same square (see the file header).
				if roofedUpperCornerAllowed(j, k, r1) {
					tryPlace(anchor.X+j, anchor.Y+h, anchor.Z+k)
					tryPlace(anchor.X+mj, anchor.Y+h, anchor.Z+k)
					tryPlace(anchor.X+j, anchor.Y+h, anchor.Z+mk)
					tryPlace(anchor.X+mj, anchor.Y+h, anchor.Z+mk)
				}
			}
		}
	}

	// *** RNG CALL (always exactly 1 draw) *** -- a boolean draw (see the
	// file header) -- gates a single-cell "peak" one layer above the roof cap.
	// Unconditional: reached even when r1==-1 skips the whole section above.
	if rnd.NextBoolean() {
		for dx := 0; dx < coreWidth; dx++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for dz := 0; dz < coreWidth; dz++ {
				tryPlace(anchor.X+dx, anchor.Y+h+1, anchor.Z+dz)
			}
		}
	}

	if h == 0 {
		return // canopy_height==0 is legal and places nothing further
	}

	// 2. Walls (inner_radius), ZERO RNG: a SOLID corner-cut square, radius
	// r2, stacked h layers tall starting at anchor.Y. The game's 3-clause
	// corner exclusion is the union of all 4 exact corners of the r2-square
	// -- algebraically identical to abs(dx)==r2 && abs(dz)==r2, the same
	// corner-cut idiom acacia/pine/spruce_canopy use -- see the file header
	// for the equivalence proof, including why the separate
	// `abs(dx)<r2||abs(dz)<r2` accept test is implied rather than modeled as
	// a second condition.
	r2 := c.innerRadius
	far := coreWidth - 1 + r2
	for layer := 0; layer < h; layer++ {
		for dx := -r2; dx <= far; dx++ {
			TickDeadline("building a canopy layer as wide as its radius asks")
			for dz := -r2; dz <= far; dz++ {
				corner := (dx == -r2 || dx == far) && (dz == -r2 || dz == far)
				if corner || (abs(dx) >= r2 && abs(dz) >= r2) {
					continue
				}
				tryPlace(anchor.X+dx, anchor.Y+layer, anchor.Z+dz)
			}
		}
	}
}

// chanceInformation is the game's shared chance value: a dual-mode
// percent/fraction gate -- see the file header for its JSON shape and why it
// stays narrower than distribution.go's own ChanceSpec (no Molang-string mode).
type chanceInformation struct {
	isFraction bool
	// percent is float32 because the game keeps it as a 32-bit float, and
	// every comparison it takes part in is a 32-bit float compare (against
	// 100.0f, against 0.0, against the scaled draw). Holding it as a float64
	// would carry bits out of the JSON literal that the game cannot store:
	// `"chance": 0.3` is 0.29999999999999999 as a double and
	// 0.30000001192092896 as the float the game keeps.
	percent                float32
	numerator, denominator uint32
}

// parseChanceInformation parses a JSON value into a chanceInformation: a
// plain number is percent mode, a {numerator, denominator} object is
// fraction mode -- see file header.
func parseChanceInformation(raw any, jsonPath string) (chanceInformation, error) {
	if f, ok := toFloat(raw); ok {
		return chanceInformation{percent: float32(f)}, nil
	}
	if m, ok := raw.(map[string]any); ok {
		num, numOK := toFloat(m["numerator"])
		den, denOK := toFloat(m["denominator"])
		if numOK && denOK {
			return chanceInformation{isFraction: true, numerator: uint32(num), denominator: uint32(den)}, nil
		}
	}
	return chanceInformation{}, fmt.Errorf("%s must be a number or a {numerator, denominator} object", jsonPath)
}

// roll implements the shared chance roll (see the simple canopy's section in
// the file header): percent mode draws NOTHING when percent<=0 (returns
// false) or percent>=100 (returns true), else exactly one NextFloat() draw;
// fraction mode returns false without drawing when denominator==0, returns
// true without drawing when numerator==denominator, and otherwise takes one
// raw 32-bit value from the core RNG modulo denominator, unsigned.
//
// That raw 32-bit step is mtrand.Rand.NextUint32() -- the full MT19937
// tempered output (two tempering masks, 11/7/15/18 shifts) every other method
// is built from. That is a DIFFERENT, wider value than rnd.NextInt()
// (int32(NextUint32()>>1) -- one bit narrower); using NextInt() here would
// silently draw the wrong 31-bit-shifted value on every fraction roll.
// rnd.NextIntBound(bound) already wraps the correct NextUint32()%bound
// computation, so it -- not NextInt() -- is the right primitive to reuse here.
func (c chanceInformation) roll(rnd random.IRandom) bool {
	if c.isFraction {
		if c.denominator == 0 {
			return false // NO RNG
		}
		if c.numerator == c.denominator {
			return true // NO RNG
		}
		// *** RNG CALL (exactly 1 raw draw) *** -- NextIntBound, NOT NextInt.
		return uint32(rnd.NextIntBound(int(c.denominator))) < c.numerator
	}
	if c.percent <= 0 {
		return false // NO RNG
	}
	if c.percent >= 100 {
		return true // NO RNG
	}
	// *** RNG CALL *** -- float32 end to end, as in the game: multiply by
	// 100.0f and compare, both in 32-bit float. The game's float draw is
	// already a float32 (narrowed from double), so the draw is narrowed here
	// too rather than being multiplied at a wider width. The float32() around
	// the product forbids Go fusing the multiply into the comparison's operand
	// on targets that have FMA.
	return float32(float32(rnd.NextFloat())*100) < c.percent
}

// isValid implements the shared chance value's validity test:
//
//	percent mode:  valid iff percent >= 0.0
//	fraction mode: valid iff denominator != 0 (a divide-by-zero guard)
//
// The denominator is the bound of the unsigned draw in roll(), and the
// numerator the value compared against it. A zero-value chanceInformation
// (percent=0) IS valid by this contract -- isValid and roll's own
// "percent<=0" early-out are DIFFERENT tests, not aliases of each other. Used
// by mangrove_roots' above_root gate below; above_root_chance defaults to
// percent=0, so isValid() alone does not signal "above_root was configured";
// that signal is above_root_block's own presence, tracked separately below.
func (c chanceInformation) isValid() bool {
	if c.isFraction {
		return c.denominator != 0
	}
	return c.percent >= 0
}

// mangroveRootDirections is the game's horizontal facing order for mangrove
// roots (NOT the ascending 2,3,4,5 one might assume): North(2), East(5),
// South(3), West(4) -- using this codebase's own established facing
// encoding (partially_exposed_blob.go's partiallyExposedBlobFacingOffsets:
// Down=0, Up=1, North=2, South=3, West=4, East=5), reused here as plain
// (dx,dz) offsets rather than raw facing bytes since the mangrove root
// placement, root simulation and candidate-position walk never need the byte
// value itself, only the neighbour offset it produces.
var mangroveRootDirections = []wgen.BlockPos{
	{X: 0, Y: 0, Z: -1}, // North
	{X: 1, Y: 0, Z: 0},  // East
	{X: 0, Y: 0, Z: 1},  // South
	{X: -1, Y: 0, Z: 0}, // West
}

// mangroveRoots is the `mangrove_roots` root variant (see the file header for
// its schema and algorithm sketch, and mangroveRootsPlace below for the
// placement itself).
type mangroveRoots struct {
	maxRootWidth, maxRootLength int // both required
	yOffsetMin, yOffsetMax      int // an int range (required)

	aboveRootChance   chanceInformation // optional, nested in above_root
	hasAboveRootBlock bool
	aboveRootBlock    block.ID // optional, nested in above_root

	rootBlock      block.ID // required
	muddyRootBlock block.ID // required
	mudBlock       block.ID // required

	rootsMayGrowThrough block.MatchSet // required

	// decoration is root_decoration (an attachable decoration) -- see
	// mangrovePlaceRoot's own doc comment for the three places it applies
	// (muddy branch, non-muddy branch, above_root branch).
	// nil is a pure no-op (absent -> zeroed -> zero draws), matching every other
	// megaTrunkDecoration-backed field in this file.
	decoration *megaTrunkDecoration
}

// mangroveCanPlaceRoot is the mangrove root viability test (ZERO RNG). The
// game's gate is:
//
//	passesAllowList(existing, roots_may_grow_through) ||
//	<first block-level predicate>(existing) ||
//	<second block-level predicate>(existing, 32) ||
//	(materialType(existing) == 8 && <a second world check>(pos,existing)) ||
//	materialType(existing) == 7 ||
//	materialType(existing) == 5   // material type 5 is water (see
//	                                  partially_exposed_blob.go's
//	                                  isWaterBlock note)
//
// This port has no material-type-code registry or per-block-type predicate
// table (the same gap the simple, spruce and random-spread canopies' leaf
// gates carry for their type-8/type-7 OR-chains), so this ships the same class
// of disclosed approximation, adapted to this gate's shape (Water, not Air,
// is the one known material term): passesAllowList OR isWater. This is a
// STRICT SUBSET of the real accept set (every dropped branch only ever adds
// acceptance) -- never a false positive, only possibly a false negative -- so
// it can make root growth fail more often than in the game but never succeed
// somewhere the game would reject.
func mangroveCanPlaceRoot(api wgen.BlockWorld, pos wgen.BlockPos, mayGrowThrough block.MatchSet) bool {
	existing := api.GetBlock(pos)
	if passesAllowList(existing, mayGrowThrough) {
		return true
	}
	return isWaterBlock(api.Palette(), existing)
}

// mangrovePotentialRootPositions is the mangrove candidate-root-position walk.
// It draws with two RNG methods: a float draw (NextFloat) compared against
// 0.2f, and a boolean draw (NextBoolean). dist is the Manhattan distance from
// origPos (the ORIGINAL per-direction start, fixed across the whole recursion)
// to curPos.
//
// Three distance bands against max_root_width (maxW):
//
//   - dist > maxW ("too far"): a SINGLE candidate, straight down. ZERO RNG.
//   - dist <= maxW-3 ("safe zone"): one NextFloat() draw; on its 80% branch
//     (>=0.2) a second NextBoolean() draw picks forward vs. down (a SINGLE
//     candidate either way); its 20% branch (<0.2) returns straight-down
//     with NO second draw.
//   - maxW-2 <= dist <= maxW ("boundary zone"): straight-down is ALWAYS a
//     candidate; one NextFloat() draw, and on its 20% branch (<0.2) a SECOND
//     candidate -- diagonal forward-and-down -- is ALSO returned (a genuine
//     fork/branch point for the recursive search in mangroveSimulateRoots).
func mangrovePotentialRootPositions(maxRootWidth int, curPos, origPos, dir wgen.BlockPos, rnd random.IRandom) []wgen.BlockPos {
	dist := abs(curPos.X-origPos.X) + abs(curPos.Y-origPos.Y) + abs(curPos.Z-origPos.Z)
	down := wgen.BlockPos{X: curPos.X, Y: curPos.Y - 1, Z: curPos.Z}
	fwd := wgen.BlockPos{X: curPos.X + dir.X, Y: curPos.Y + dir.Y, Z: curPos.Z + dir.Z}

	if maxRootWidth < dist {
		return []wgen.BlockPos{down} // *** NO RNG ***
	}
	if maxRootWidth-3 >= dist {
		// *** RNG CALL (NextFloat) *** -- safe zone, draw #1.
		if rnd.NextFloat() >= 0.2 {
			// *** RNG CALL (NextBoolean) *** -- draw #2.
			if rnd.NextBoolean() {
				return []wgen.BlockPos{fwd}
			}
			return []wgen.BlockPos{down}
		}
		return []wgen.BlockPos{down}
	}
	// Boundary zone: maxRootWidth-2 <= dist <= maxRootWidth.
	result := []wgen.BlockPos{down}
	// *** RNG CALL (NextFloat) ***
	if rnd.NextFloat() < 0.2 {
		result = append(result, wgen.BlockPos{X: fwd.X, Y: fwd.Y - 1, Z: fwd.Z})
	}
	return result
}

// mangroveSimulateRoots is the (recursive) mangrove root simulation. depth is
// capped by max_root_length two ways at once (the game tests both
// `depth == max_root_length` and `branchSize > max_root_length`):
// once via the recursion depth itself, and redundantly via the accumulated
// branch's own length (relevant only because a single candidate-position
// call can return TWO candidates in the boundary zone, so the branch can grow
// by more than one entry per recursion level). Both cap conditions TRUNCATE
// the branch to empty (not merely stop growing it) before returning false,
// and a failing
// recursive call ALSO clears the whole branch (not just its own subtree)
// before propagating false upward, which is why a single failure anywhere in
// one direction's search discards that entire direction's work, not just the
// failing leaf.
func mangroveSimulateRoots(api wgen.BlockWorld, rnd random.IRandom, curPos, origPos, dir wgen.BlockPos, branch *[]wgen.BlockPos, depth int, r *mangroveRoots) bool {
	if depth == r.maxRootLength || len(*branch) > r.maxRootLength {
		*branch = nil
		return false
	}
	candidates := mangrovePotentialRootPositions(r.maxRootWidth, curPos, origPos, dir, rnd)
	if len(candidates) == 0 {
		return true // clean stop -- growth naturally ended, nothing more to add
	}
	for _, cand := range candidates {
		TickDeadline("simulating mangrove roots as far as its max_root_length/max_root_width asks")
		if !mangroveCanPlaceRoot(api, cand, r.rootsMayGrowThrough) {
			continue // this candidate is skipped, NOT a failure -- try the next one
		}
		*branch = append(*branch, cand)
		if !mangroveSimulateRoots(api, rnd, cand, origPos, dir, branch, depth+1, r) {
			*branch = nil
			return false
		}
	}
	return true
}

// placeDecoratedBlock is the game's decorated-block write: SetBlock(pos, id,
// flag=3), and -- ONLY if that SetBlock succeeded -- decoration.place(api, pos,
// mask, rnd) unconditionally (the game ignores the decoration's boolean
// result here, so this port's callers do too). Used by mangrovePlaceRoot and
// the fallen trunk's stump column (placeFallenTrunk). decoration==nil is a
// pure no-op past the SetBlock, matching megaTrunkDecoration's "absent ->
// zeroed -> zero draws" contract.
func placeDecoratedBlock(api wgen.BlockWorld, pos wgen.BlockPos, rnd random.IRandom, id block.ID, decoration *megaTrunkDecoration, mask [4]bool) bool {
	if !api.SetBlock(pos, id) {
		return false
	}
	if decoration != nil {
		decoration.place(api, pos, mask, rnd)
	}
	return true
}

// mangrovePlaceRoot is the mangrove single-root write. Re-checks the root
// viability test at its own position (redundant with the check that put this
// position in the accumulator in the first place, but kept to match the
// game's control flow). Return value is void: the root placement's final
// commit loop ignores any result, looping to the next position regardless.
//
// Block selection: if the EXISTING block at pos is
// already mud_block (i.e. this position was already muddy ground, not one
// the root growth carved through), place muddy_root_block and
// stop -- above_root is only ever attempted on the OTHER branch. Otherwise
// place root_block and, if that succeeds, attempt above_root: gated on
// above_root_block having actually been configured (see mangroveRoots' own
// hasAboveRootBlock field) and above_root_chance.isValid() (see that
// method's own doc comment for why a default/unconfigured chanceInformation
// still passes this particular check), then a single chanceInformation.roll
// draw, then a single-predicate gate on the block directly above (the same
// unmodelled block-level predicate the root viability test carries --
// approximated the same way as the roofed canopy's single-predicate leaf
// gate: bare Air, no OR).
//
// root_decoration (an attachable decoration) applies in THREE places, all
// using the SAME decoration object, all with the mangroveTrunkAllDirections
// mask, all gated on the SetBlock they follow having succeeded
// (placeDecoratedBlock's own contract):
//  1. Muddy branch: decoration runs right after muddy_root_block is placed,
//     and its boolean result is this branch's result (moot -- the commit
//     loop ignores it).
//  2. Non-muddy branch: decoration runs right after root_block is placed,
//     result DISCARDED (control falls through to the above_root gate below,
//     unlike branch 1's early return).
//  3. above_root branch, via the decorated-block write: the SAME decoration
//     object decorates the above_root position TOO, if above_root_block ends
//     up placed.
func mangrovePlaceRoot(api wgen.BlockWorld, pos wgen.BlockPos, rnd random.IRandom, r *mangroveRoots) {
	if !mangroveCanPlaceRoot(api, pos, r.rootsMayGrowThrough) {
		return
	}
	existing := api.GetBlock(pos)
	if existing == r.mudBlock {
		// *** RNG CALLS (0-4, root_decoration) *** -- see placeDecoratedBlock/megaTrunkDecoration.place.
		placeDecoratedBlock(api, pos, rnd, r.muddyRootBlock, r.decoration, mangroveTrunkAllDirections)
		return
	}
	// *** RNG CALLS (0-4, root_decoration) ***
	if !placeDecoratedBlock(api, pos, rnd, r.rootBlock, r.decoration, mangroveTrunkAllDirections) {
		return
	}
	if !r.hasAboveRootBlock || !r.aboveRootChance.isValid() {
		return
	}
	// *** RNG CALL (0 or 1 draw, chanceInformation.roll's own contract) ***
	if !r.aboveRootChance.roll(rnd) {
		return
	}
	above := wgen.BlockPos{X: pos.X, Y: pos.Y + 1, Z: pos.Z}
	if !api.Palette().IsAir(api.GetBlock(above)) {
		return
	}
	// *** RNG CALLS (0-4, root_decoration -- the SAME object decorates above_root too) ***
	placeDecoratedBlock(api, above, rnd, r.aboveRootBlock, r.decoration, mangroveTrunkAllDirections)
}

// mangroveRootsPlace is the mangrove root placement end to end, including its
// vertical validation loop and the helpers above. See the file header for the
// schema.
//
// Returns (relocatedOrigin, true) on success. relocatedOrigin is
// (origin.X, origin.Y+yOffsetValue, origin.Z). Both halves of the result are
// load-bearing: the relocated position replaces the feature's own origin as
// the ORIGIN of the subsequent trunk placement -- which is exactly what
// TreeFeature.Place/placeSubmergedTrunk use as their origin for everything
// from that point on. Returns (zero, false) on any failure; the game then
// aborts the tree without placing a trunk (logging that the roots could not
// be placed), and TreeFeature.Place/placeSubmergedTrunk mirror that by
// returning nil (no trunk, no canopy) rather than falling back to the
// un-relocated origin.
func mangroveRootsPlace(api wgen.BlockWorld, origin wgen.BlockPos, rnd random.IRandom, height int, mayGrowOn block.MatchSet, r *mangroveRoots) (wgen.BlockPos, bool) {
	// *** RNG CALL *** -- y_offset drawn as an int range (treeIntRangeValue).
	value := treeIntRangeValue(r.yOffsetMin, r.yOffsetMax, rnd)
	topY := origin.Y + value

	// Spawn preparation -- this file's established approximation, using the
	// tree's OVERALL may_grow_on list (the same tree-parameter lists every
	// other spawn-preparation gate in this file uses, not a root-specific
	// list) -- evaluated at the ORIGINAL origin, not the relocated one.
	// ZERO RNG.
	if origin.Y <= api.MinY() || origin.Y+value+height >= api.MaxY() {
		return wgen.BlockPos{}, false
	}
	if !mayGrowOn.Empty() {
		below := api.GetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z})
		if !mayGrowOn.Contains(below) {
			return wgen.BlockPos{}, false
		}
	}

	// Vertical validation: EVERY Y from origin.Y up to (but not including)
	// topY must pass the root viability test -- an "every position must
	// pass" loop over an incrementing Y, aborting the WHOLE function the
	// first time a probe fails, NOT a "search for the first
	// pass" the way e.g. spruce_canopy's own ground search works. Skipped
	// entirely (0 iterations, 0 draws) when value<=0. ZERO RNG throughout
	// (the viability test itself never draws).
	for y := origin.Y; y < topY; y++ {
		TickDeadline("walking the mangrove root column its height asks for")
		if !mangroveCanPlaceRoot(api, wgen.BlockPos{X: origin.X, Y: y, Z: origin.Z}, r.rootsMayGrowThrough) {
			return wgen.BlockPos{}, false
		}
	}

	base := wgen.BlockPos{X: origin.X, Y: topY, Z: origin.Z}
	var accumulated []wgen.BlockPos
	// One entry, unconditionally, before any direction loop: (origin.X,
	// topY-1, origin.Z), pushed regardless of whether the vertical loop above
	// actually ran.
	accumulated = append(accumulated, wgen.BlockPos{X: origin.X, Y: topY - 1, Z: origin.Z})

	// The 4 horizontal facing-plane directions, fixed order (North, East,
	// South, West -- see mangroveRootDirections), NOT shuffled and NOT
	// itself an RNG draw.
	for _, dir := range mangroveRootDirections {
		start := wgen.BlockPos{X: base.X + dir.X, Y: base.Y + dir.Y, Z: base.Z + dir.Z}
		var branch []wgen.BlockPos
		ok := mangroveSimulateRoots(api, rnd, start, base, dir, &branch, 0, r)
		// An empty OR oversized branch aborts the WHOLE root placement (not
		// merely this direction) -- every one of the 4 directions must succeed.
		if !ok || len(branch) == 0 {
			return wgen.BlockPos{}, false
		}
		accumulated = append(accumulated, branch...)
		// The direction's own start position is pushed a SECOND time, AFTER
		// the whole branch: the one-step neighbour of base in that direction
		// is pushed after the branch's entries, not merged into them.
		accumulated = append(accumulated, start)
	}

	// Final commit -- every accumulated position, in order, via the
	// single-root write.
	// ZERO further gating here; that routine re-checks viability itself.
	for _, pos := range accumulated {
		mangrovePlaceRoot(api, pos, rnd, r)
	}

	return wgen.BlockPos{X: origin.X, Y: topY, Z: origin.Z}, true
}

// mangroveCanopy is the mangrove canopy's placement (`mangrove_canopy` key)
// -- see the file header for the schema, field set, fixed constants, the full
// RNG draw sequence, the propagule-scatter geometry, and the
// prop-root/hanging-block decoration pass.
type mangroveCanopy struct {
	heightMin, heightMax int                         // "canopy_height"
	radiusMin, radiusMax int                         // "canopy_radius"
	attempts             int                         // "leaf_placement_attempts"
	leafBlocks           []randomSpreadWeightedBlock // "leaf_blocks" (reuses random_spread_canopy's own type + picker -- see file header)
	hangingBlock         block.ID                    // "hanging_block"
	hangingChance        chanceInformation           // "hanging_block_placement_chance"
	// decoration is "canopy_decoration" (an attachable decoration) -- see the
	// decoration loop in the placement below. nil is a pure no-op (absent ->
	// zeroed -> chanceInformation.roll always false, zero draws -- the same
	// megaTrunkDecoration/mangroveTrunk "absent -> skip" contract used
	// elsewhere in this file), so a file that omits it is unaffected.
	decoration *megaTrunkDecoration
}

// mangroveRootSearchDepth and mangroveFootprintRadius are the mangrove
// canopy's fixed (not JSON-configurable) constants -- see the file header.
const (
	mangroveRootSearchDepth = 2
	mangroveFootprintRadius = 1 // the X and Z half-widths are both this
)

func (c *mangroveCanopy) place(api wgen.BlockWorld, _ wgen.BlockPos, rnd random.IRandom, params treeParamsLists, candidates []wgen.BlockPos) {
	if len(candidates) == 0 {
		return // no candidates: early return, ZERO draws
	}

	// *** RNG CALLS 1-2 *** -- canopy_height then canopy_radius, both via
	// the inclusive two-argument integer draw -- reuses geode.go's
	// geodeIntRange directly (0 draws when max<=min, else
	// min+NextIntBound(max-min)) -- see file header.
	heightVal := geodeIntRange(c.heightMin, c.heightMax, rnd)
	radiusVal := geodeIntRange(c.radiusMin, c.radiusMax, rnd)

	var propagules []wgen.BlockPos
	for _, cand := range candidates {
		for a := 0; a < c.attempts; a++ {
			TickDeadline("retrying leaf placement as many times as its leaf_placement_attempts asks")
			// *** RNG CALL (0 or 1 draw) *** -- weighted leaf-block pick,
			// reusing random_spread_canopy's own integer-bound
			// randomSpreadPickBlock (NOT shared.go's float-based
			// WeightedPick) -- the mangrove canopy's pick uses the same
			// integer-bound draw as random_spread_canopy, not
			// growing_plant.go's float-based one.
			blockID := c.leafBlocks[randomSpreadPickBlock(c.leafBlocks, rnd)].id

			// *** RNG CALLS (6, always) *** -- X,X,Y,Y,Z,Z order. A plain
			// difference-of-two-uniform-draws jitter -- DIFFERENT from
			// random_spread_canopy's own "+1, -bound" formula, no shift
			// here (see file header).
			dx1 := rnd.NextIntBound(radiusVal)
			dx2 := rnd.NextIntBound(radiusVal)
			dy1 := rnd.NextIntBound(heightVal)
			dy2 := rnd.NextIntBound(heightVal)
			dz1 := rnd.NextIntBound(radiusVal)
			dz2 := rnd.NextIntBound(radiusVal)

			p := wgen.BlockPos{X: cand.X + dx1 - dx2, Y: cand.Y + dy1 - dy2, Z: cand.Z + dz1 - dz2}
			existing := api.GetBlock(p)
			// Leaf gate: the SAME passesAllowList-OR-IsAir approximation
			// random_spread_canopy's own (structurally identical) gate
			// already uses -- see file header.
			if passesAllowList(existing, params.mayReplace) || api.Palette().IsAir(existing) {
				api.SetBlock(p, blockID)
				propagules = append(propagules, p)
			}
		}
	}

	// *** RNG CALLS (len(propagules)-1, or 0) *** -- Fisher-Yates shuffle of
	// the FULL accumulated propagule-position list (across every candidate,
	// not per-candidate); each swap index is a uniform int in [0,i+1) via
	// NextIntBound -- see file header.
	for i := 1; i < len(propagules); i++ {
		j := rnd.NextIntBound(i + 1)
		propagules[i], propagules[j] = propagules[j], propagules[i]
	}

	// canopy_decoration (an attachable decoration, the same decoration write
	// megaTrunkDecoration.place implements) runs as a loop immediately after
	// the shuffle above and BEFORE the hanging_block pass below, walking the
	// SAME shuffled propagule list: once per propagule, with the
	// all-four-horizontal-directions mask mega_trunk/mangrove_trunk/
	// mangrove_roots also use (mangroveTrunkAllDirections).
	// The game also wraps the loop in a chance-value validity check, but that
	// is only a loop skip, NOT an independent behavioral gate: percent-mode
	// validity is `percent>=0` (true even for the zeroed default -- see
	// chanceInformation.isValid), so a zeroed/absent canopy_decoration reaches
	// the SAME "roll() returns false, zero draws" outcome either way. Calling
	// decoration.place() unconditionally (nil-checked) is therefore
	// behaviorally IDENTICAL, and this port takes the simpler path.
	if c.decoration != nil {
		for _, p := range propagules {
			// *** RNG CALLS (0-4 per propagule) *** -- see megaTrunkDecoration.place's own doc
			// comment: one chanceInformation.roll() per enabled horizontal direction,
			// unconditionally, in west/east/north/south order.
			c.decoration.place(api, p, mangroveTrunkAllDirections, rnd)
		}
	}

	// Prop-root / hanging_block pass -- one shared chance roll per
	// SHUFFLED propagule position, gated first by a hash-set membership
	// check (NO draw when already occupied -- the check short-circuits
	// before the roll) so the footprint marking below suppresses overlapping
	// roots from nearby propagules. occupied is a Go map standing in for the
	// game's hash-based adjacency set -- see file header.
	occupied := make(map[wgen.BlockPos]bool)
	for _, p := range propagules {
		below := wgen.BlockPos{X: p.X, Y: p.Y - 1, Z: p.Z}
		if occupied[below] {
			continue // NO RNG -- short-circuited before roll()
		}
		// *** RNG CALL (0 or 1 draw) *** -- hanging_block_placement_chance.
		if !c.hangingChance.roll(rnd) {
			continue
		}
		// Ground-clearance search, ZERO RNG: mangroveRootSearchDepth cells
		// straight down from the propagule must ALL be air-like (this
		// port's stand-in for the unmodelled block-level "obstruction"
		// check -- the same check the leaf gate above approximates as air),
		// or no root is placed. The placement position never moves past
		// `below` regardless of how far the search goes -- only whether it
		// COMMITS is depth-dependent -- see file header.
		clear := true
		for dy := 1; dy <= mangroveRootSearchDepth; dy++ {
			if !api.Palette().IsAir(api.GetBlock(wgen.BlockPos{X: p.X, Y: p.Y - dy, Z: p.Z})) {
				clear = false
				break
			}
		}
		if !clear {
			continue
		}
		api.SetBlock(below, c.hangingBlock)
		for dx := -mangroveFootprintRadius; dx <= mangroveFootprintRadius; dx++ {
			for dz := -mangroveFootprintRadius; dz <= mangroveFootprintRadius; dz++ {
				occupied[wgen.BlockPos{X: below.X + dx, Y: below.Y, Z: below.Z + dz}] = true
			}
		}
	}
}

// normalizeForMayReplace is the two-step block-state normalization at the top
// of the radial block-group write's per-cell gate. Force UpdateBit to 0 if the
// existing block currently exposes it, then -- checking the (possibly
// just-normalized) block -- force PersistentBit to 0 too if IT is also
// exposed, before the may_replace list match.
//
// A persistent bit is NOT a placement obstruction and does NOT abandon the
// radial group early: it is exactly as narrow a case as the update bit, an
// extra normalization step whose result feeds the same skip-or-place path --
// both are ordinary block.StateField presence+derive operations.
//
// The body lives in normalizeAllowListBits (shared.go), because
// single_block_feature's allow-list check needs the identical two steps. They
// are kept as two named entry points because the two behaviours are only
// known to match, not known to be one shared rule.
func normalizeForMayReplace(pal *block.Palette, id block.ID) block.ID {
	return normalizeAllowListBits(pal, id)
}

// placeRadialBlockGroup is the game's radial block-group write, the shared
// leaf-placement helper both mega_canopy and mega_pine_canopy delegate to.
//
// It takes a branch-size core rectangle. TWO different things in this
// routine depend on it, and only ONE of them actually scales with it (the
// `within` closure below carries the reasoning):
//
//   - the outer loop range IS size-parameterised: x runs [-r, sizeX+r) and
//     z runs [-r, sizeZ+r) (each core-rectangle component plus the radius);
//   - the rounding test is NOT. It has exactly two fixed centres per
//     axis, at offsets {0,1}, with a constant 1 rather than
//     (size-1) -- so the accepted region is a fixed 2x2 stadium no matter
//     how wide the core rectangle is.
//
// Both canopies that call this also ASSERT the core rectangle is square and
// equal to their own core_width (the same "core width was parsed, and
// trunkSize matches it on both axes" guard the mega and roofed canopies
// share), and when core_width was NOT parsed both fall back
// to the trunk's own branch size, which need not be square. This port always
// has a parsed
// core_width and requires it to equal the trunk width, so the non-square
// fallback is unreachable here and is not modeled.
//
// Per-cell test: keep a cell iff its own 1x1 footprint (corners
// at (dx-1,dz-1)..(dx,dz)) has ANY corner within radius of the origin --
// basic(dx,dz) OR shifted1 OR shifted2 OR shifted3 below -- UNLESS
// strictCorners (simplify_canopy=true) is set, in which case only basic()
// counts. This is a conservative circle rasterization (keep a cell if the
// circle clips ANY of its 4 corners), NOT the "reject only the 4 TRUE
// corners of the bounding square" idiom acacia_canopy/pine_canopy/
// spruce_canopy/roofed_canopy use -- the three relaxed tests square (dx-1)
// and (dz-1) explicitly. This also
// explains simplify_canopy's own name: true selects the plain, SIMPLER
// (smaller, strictly-circular) test; false (default) keeps the relaxed,
// slightly fuller one.
//
// Zero RNG: the game's helper receives an RNG but never uses it.
func placeRadialBlockGroup(api wgen.BlockWorld, pal *block.Palette, center wgen.BlockPos, leafID block.ID, radius, coreWidth int, strictCorners bool, mayReplace block.MatchSet) error {
	if radius < 0 {
		// A malformed range (begin past end) -- refused rather than guessed,
		// matching this file's established malformed-range policy
		// (spruce_canopy/roofed_canopy's own precedent). See file header.
		return fmt.Errorf("minecraft:tree_feature: radial block group radius went negative (%d) -- a malformed range", radius)
	}
	r2 := radius * radius
	// The game's rounding test has exactly TWO centres per axis, and they do
	// NOT scale with the core rectangle: it squares the raw loop offset and,
	// separately, that offset minus a constant 1 -- not minus (size-1) -- on
	// each axis. (It is NOT a core-width-dependent distance-to-segment
	// transform with `coreWidth` centres per axis.)
	//
	// The four sums below are the cartesian product of {dx,dx-1} x
	// {dz,dz-1}, i.e. a fixed 2x2 stadium anchored at the core rectangle's
	// near corner, however wide that rectangle actually is. Only the LOOP
	// RANGE is size-parameterised (each core-rectangle component plus the
	// radius, giving x in [-r, sizeX+r) -- kept below), so at
	// core_width >= 2 the acceptance region stops tracking the footprint and
	// the far corners get cut. That asymmetry is vanilla behaviour, and it is
	// reproduced rather than smoothed over.
	//
	// At core_width == 1 a distance-to-segment transform would reduce to
	// plain abs(), and abs(v)^2 == v^2, so the two readings agree there
	// (radius 0..5, both strictCorners modes: zero differing cells); at
	// core_width 2 and up they differ only by cells the fixed test DROPS.
	within := func(dx, dz int) bool {
		return dx*dx+dz*dz <= r2
	}
	for dx := -radius; dx <= coreWidth-1+radius; dx++ {
		TickDeadline("building a canopy layer as wide as its radius asks")
		for dz := -radius; dz <= coreWidth-1+radius; dz++ {
			keep := within(dx, dz)
			if !keep && !strictCorners {
				keep = within(dx-1, dz-1) || within(dx, dz-1) || within(dx-1, dz)
			}
			if !keep {
				continue
			}
			p := wgen.BlockPos{X: center.X + dx, Y: center.Y, Z: center.Z + dz}
			normalized := normalizeForMayReplace(pal, api.GetBlock(p))
			if passesAllowList(normalized, mayReplace) {
				api.SetBlock(p, leafID)
			}
		}
	}
	return nil
}

// megaCanopy is the mega canopy's placement (`mega_canopy` key) -- see the
// file header for the schema and defaults (simplify_canopy, base_radius), and
// placeRadialBlockGroup above for the shared leaf-placement geometry.
type megaCanopy struct {
	leafID                           block.ID
	canopyHeightMin, canopyHeightMax int  // "canopy_height" (required int range; the default {3,3} is moot since required)
	baseRadius                       int  // "base_radius"   (optional int, DEFAULT 2)
	simplifyCanopy                   bool // "simplify_canopy" (optional bool, DEFAULT false)
	coreWidth                        int
	pal                              *block.Palette
}

func (c *megaCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	// *** RNG CALL (the ONLY draw) *** -- canopy_height drawn via
	// treeIntRangeValue, the SAME int-range draw acacia_canopy/spruce_canopy
	// use.
	value := treeIntRangeValue(c.canopyHeightMin, c.canopyHeightMax, rnd)
	if value == 0 {
		return // an early return on zero -- a legal, empty tree
	}
	if value < 0 {
		// A malformed range ("1-value >= 2") -- only reachable when
		// canopy_height's own min draws negative. Refused at runtime rather
		// than guessed, matching spruce_canopy's "n<=-2, unsupported"
		// malformed-range precedent (file header): this depends on an RNG
		// draw, not a JSON constant, so it
		// cannot be caught at build time the way base_radius's own bound is.
		RaiseMalformedRange("mega_canopy.canopy_height", fmt.Sprintf("drew %d, which is below 0", value))
	}

	// core_width is threaded through: it is required to equal the trunk
	// width (build time) but is no longer required to BE 1, so
	// halfCoreWidth = core_width/2 is a real term and the
	// {core_width,core_width} branch size placeRadialBlockGroup's own general
	// signature takes is a real square. What does NOT scale with it is that
	// helper's rounding test -- see its own doc comment; the game holds
	// that at two centres per axis regardless of the rectangle's width.
	//
	// dy runs (1-value)..0 inclusive, radius = -dy + baseRadius (+0):
	// widest at the bottom (dy=1-value), narrowing by exactly 1 per layer to
	// the smallest at dy=0 -- a downward-flaring cone (see file header).
	for i := 0; i < value; i++ {
		TickDeadline("stacking canopy layers as tall as its canopy height asks")
		dy := (1 - value) + i
		radius := (value - 1 - i) + c.baseRadius + c.coreWidth/2
		center := wgen.BlockPos{X: anchor.X, Y: anchor.Y + dy, Z: anchor.Z}
		if err := placeRadialBlockGroup(api, c.pal, center, c.leafID, radius, max(1, c.coreWidth), c.simplifyCanopy, params.mayReplace); err != nil {
			RaiseMalformedRange("mega_canopy", err.Error())
		}
	}
}

// megaPineCanopy is the mega pine canopy's placement
// (`mega_pine_canopy` key) -- shares placeRadialBlockGroup's own geometry
// with megaCanopy above (same helper), but has NO simplify_canopy field (it
// always uses the relaxed 4-corner test) and instead has its own
// JSON-configurable "radius_step_modifier" float (see the file header for the
// schema, and megaPineRadiusFor below for the formula).
type megaPineCanopy struct {
	leafID                           block.ID
	canopyHeightMin, canopyHeightMax int     // "canopy_height" (required int range; the default {3,8} is moot since required)
	baseRadius                       int     // "base_radius"   (optional int, DEFAULT 2)
	radiusStepModifier               float32 // "radius_step_modifier" (optional float, DEFAULT 3.5)
	coreWidth                        int
	pal                              *block.Palette
}

// megaPineRadiusFor computes ONE layer's radius, which feeds
// placeRadialBlockGroup the same way megaCanopy's does:
//
//	dy == 0 (the topmost layer, always the loop's LAST iteration): radius =
//	    baseRadius exactly, no "bump" (below) ever applies. This is not a
//	    special-cased approximation: the general formula's own numerator is
//	    float32(-dy) = 0 at dy=0 regardless of value, so the floor term is
//	    always 0 for any value != 0, and for value == 0 specifically the
//	    game computes float32(0)/float32(0) = NaN, whose float-to-int
//	    conversion saturates to 0 on the game's platforms -- i.e. BOTH cases
//	    the general formula would reach at dy=0 resolve to term=0, so
//	    hardcoding it here is an exact simplification, not a guess (Go's own
//	    NaN -> int conversion is unspecified, so this must be special-cased
//	    to stay bit-exact).
//	dy != 0 (value >= 1 guaranteed, so no div-by-zero risk): term =
//	    floor32(radiusStepModifier * float32(-dy) / float32(value))
//	    (the DIVIDE happens first, then the MULTIPLY -- not reassociated) as
//	    preBumpRadius = baseRadius + term.
//	"Bump": preBumpRadius gets +1 iff dy!=0
//	    AND preBumpRadius == the PREVIOUS layer's own preBumpRadius (a
//	    "plateau" in the stepped taper) AND the layer's absolute world Y
//	    coordinate (anchor.Y+dy) is even -- an alternating stagger on flat
//	    steps, matching real mega/dark-oak pine canopies' jagged silhouette.
//	    prevPreBump starts at 0 (a pre-loop sentinel) for the FIRST
//	    (bottom, most-negative dy) layer -- preserved exactly, including the
//	    (rare, only reachable if radiusStepModifier/baseRadius combine to a
//	    genuine 0 pre-bump radius on the very first layer) edge case this
//	    sentinel implies.
func megaPineRadiusFor(dy, value, baseRadius int, radiusStepModifier float32, prevPreBump int, y int) (radius, preBump int) {
	if dy == 0 {
		return baseRadius, baseRadius
	}
	ratio := float32(-dy) / float32(value) // the divide, first
	term := radiusStepModifier * ratio     // then the multiply
	term = float32(math.Floor(float64(term)))
	preBump = baseRadius + int(term)
	bump := 0
	if preBump == prevPreBump && y&1 == 0 {
		bump = 1
	}
	return preBump + bump, preBump
}

func (c *megaPineCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	// *** RNG CALL (the ONLY draw) *** -- canopy_height.getValue(rnd), the
	// SAME int-range draw as megaCanopy's own single draw.
	value := treeIntRangeValue(c.canopyHeightMin, c.canopyHeightMax, rnd)
	if value < -1 {
		// A malformed range, the SAME runtime-only refusal megaCanopy's
		// own canopy_height guard uses (only reachable via a pathological
		// canopy_height.min draw) -- see file header / megaCanopy's own
		// note.
		RaiseMalformedRange("mega_pine_canopy.canopy_height", fmt.Sprintf("drew %d, which is below -1", value))
	}
	if value == -1 {
		return // pos.Y-Value == pos.Y+1 -- a legal, empty tree. NOTE:
		// unlike megaCanopy, value==0 is NOT empty here -- it still places exactly
		// one layer (dy=0) -- see megaPineRadiusFor's own doc comment.
	}

	// core_width: see megaCanopy.place's own note (the rounding test does
	// not scale with it; coreWidth is passed through as the branch size).
	//
	// dy runs -value..0 inclusive (value+1 layers, ONE MORE than
	// megaCanopy's own `value` layers for the same drawn value -- consistent
	// with the malformed-range bounds above, which key off pos.Y directly,
	// not a bare value comparison the way megaCanopy's "1-value>=2" does).
	prevPreBump := 0 // pre-loop sentinel -- see megaPineRadiusFor's own doc comment
	for dy := -value; dy <= 0; dy++ {
		TickDeadline("stacking canopy layers as tall as its canopy height asks")
		y := anchor.Y + dy
		radius, preBump := megaPineRadiusFor(dy, value, c.baseRadius, c.radiusStepModifier, prevPreBump, y)
		prevPreBump = preBump
		center := wgen.BlockPos{X: anchor.X, Y: y, Z: anchor.Z}
		// The simplify_canopy-equivalent is always false -- the mega pine
		// canopy has no such JSON field at all -- so it always uses the
		// relaxed 4-corner test.
		if err := placeRadialBlockGroup(api, c.pal, center, c.leafID, radius, max(1, c.coreWidth), false, params.mayReplace); err != nil {
			// Reachable from `mega_pine_canopy.radius_step_modifier` alone: a negative one drives
			// the radius below zero at some layer for every tree. Same typed refusal as the
			// canopy_height guards above -- see features.MalformedRangeRefusal.
			RaiseMalformedRange("mega_pine_canopy", err.Error())
		}
	}
}

// TreeFeature is minecraft:tree_feature. A leaf type -- no feature
// delegation, so it is always in scope.
// ---- Poplar (`poplar_trunk` / `poplar_canopy`) ----------
//
// The poplar trunk ("poplar_trunk") and poplar canopy ("poplar_canopy") are a
// trunk/canopy pair; every RNG draw is named inline below. The poplar trunk's
// height is an int-range draw over trunk_height.
//
// Poplar trunk schema:
//
//	int range        trunk_height                            REQUIRED, default {7,9}
//	int range        remaining_trunk_height_above_branches   optional, default {4,4}
//	int range        amount_of_foliage_support_branches      optional, default {1,4}
//	block descriptor trunk_block                             REQUIRED
//	attachable decoration: trunk_decoration                  optional, default none
//	weak feature reference: log_decoration_feature           optional, default empty
//
// Poplar canopy schema:
//
//	block descriptor leaf_block     REQUIRED
//	block descriptor branch_block   REQUIRED
//	weighted-int list  radius       REQUIRED array
//	int range        height         REQUIRED, default {5,6}
//	float            side_hole_chance   optional, default 0.0
//	int              trunk_width        optional, default 1;
//	           the value round-trips int->float->int
//
// The poplar canopy's weighted-int element: `value` first, required;
// `weight` second, optional, default 1.
//
// Possible range validation NOT ported (semantics unknown): trunk_height,
// the canopy height, side_hole_chance ({0.0,1.0}) and trunk_width may carry
// min/range limits in the game, but no clamp is enforced here.
//
// There is no "X" JSON key in either schema.

// poplarFacingStepX/Z are the horizontal rows of the game's per-face offset
// table: [0]=down(0,-1,0), [1]=up(0,1,0),
// [2]=north(0,0,-1), [3]=south(0,0,1), [4]=west(-1,0,0), [5]=east(1,0,0).
// Indexed by the facing-direction state's own enum (2..5) -- the same
// convention a block position's neighbour offset uses.
var poplarFacingStepX = [6]int{0, 0, 0, 0, -1, 1}
var poplarFacingStepZ = [6]int{0, 0, -1, 1, 0, 0}

// treeShuffledHorizontalDirections mirrors the game's shuffled horizontal
// direction list: the array starts as {2,5,3,4} = {NORTH, EAST, SOUTH, WEST},
// then a Fisher-Yates pass over indices 1..3 draws NextIntBound(2),
// NextIntBound(3), NextIntBound(4) and swaps arr[i] with arr[j] when j != i
// (the game skips j==i, but a self-swap is identity anyway). ALWAYS exactly
// 3 draws.
func treeShuffledHorizontalDirections(rnd random.IRandom) [4]uint8 {
	arr := [4]uint8{2, 5, 3, 4}
	for i := 1; i <= 3; i++ {
		j := rnd.NextIntBound(i + 1) // *** RNG CALL (x3, bounds 2,3,4) ***
		arr[i], arr[j] = arr[j], arr[i]
	}
	return arr
}

// poplarPassesAllowList is the placement allow-list check the poplar canopy
// applies at both its leaf layers and its branch layer: an EMPTY may_replace
// list passes unconditionally (straight to the SetBlock); otherwise the
// existing block is normalized by forcing update_bit=0 then persistent_bit=0
// before the block-descriptor list match. normalizeForMayReplace implements
// exactly that two-state normalization (mangrove_canopy's gate uses it too).
func poplarPassesAllowList(api wgen.BlockWorld, pal *block.Palette, p wgen.BlockPos, ids block.MatchSet) bool {
	if ids.Empty() {
		return true
	}
	existing := api.GetBlock(p)
	if pal != nil {
		existing = normalizeForMayReplace(pal, existing)
	}
	return ids.Contains(existing)
}

// poplarWeightedInt is one entry of the poplar canopy's weighted-integer
// radius list: {int value, int weight}.
type poplarWeightedInt struct {
	value  int
	weight int
}

// poplarPickWeightedRadius mirrors the poplar canopy's radius draw, the
// game's usual integer weighted pick plus a poplar-specific -1:
//
//	total = sum(weight)
//	roll  = total != 0 ? NextIntBound(total) : 0   (a zero total skips
//	        the draw entirely -- ZERO draws for an all-zero-weight list)
//	pick the first element where the cumulative weight exceeds roll
//	        (a subtract-and-test scan)
//	return pick.value - 1
//
// This is the INTEGER-weight cousin of cherry_trunk's weightedTreeType (same
// NextIntBound(total)+cumulative-subtract shape), NOT randomSpreadPickBlock's
// float-truncating variant and NOT shared.go's WeightedPick (NextFloat*sum).
// An EMPTY list never reaches this scan: the canopy's caller logs that the
// weighted radius list cannot be empty and returns radius 0 with
// zero draws; this port additionally rejects empty lists at parse time.
// The game's scan has NO end check (an all-zero-weight list walks past the
// end of the list -- undefined); this port stops at the last element instead.
func poplarPickWeightedRadius(entries []poplarWeightedInt, rnd random.IRandom) int {
	total := 0
	for _, e := range entries {
		total += e.weight
	}
	roll := 0
	if total != 0 {
		roll = rnd.NextIntBound(total) // *** RNG CALL (0 or 1 draw) ***
	}
	for _, e := range entries {
		roll -= e.weight
		if roll < 0 {
			return e.value - 1
		}
	}
	return entries[len(entries)-1].value - 1
}

// poplarCanopy is the poplar canopy (`poplar_canopy`) -- see the file header
// for its schema.
type poplarCanopy struct {
	leafID block.ID
	// branchX/branchZ are branch_block with pillar_axis forced to x/z, as the
	// leaf-to-log replacement does: if the block type has a pillar_axis
	// state, it is set on the default state, axis = z when the cell's z != 0,
	// else x. Resolved at build time the same way cherry_trunk's branch
	// blocks are.
	branchX, branchZ     block.ID
	radius               []poplarWeightedInt
	heightMin, heightMax int
	sideHoleChance       float32
	trunkWidth           int
	pal                  *block.Palette
}

// placeLayer mirrors the poplar canopy's leaf-layer write. One horizontal
// layer at anchor.y+layerY:
//
//   - loops x (outer) then z (inner), both over [-r, r+wide] where wide is 1
//     for a >1-wide trunkSize and 0 otherwise; an r negative enough that
//     r+wide < -r returns immediately.
//   - isTopTwo = layerY == height-1 || layerY == height-2.
//     On those two layers, cells with |x|==r or
//     |z|==r are skipped WITHOUT drawing.
//   - a per-cell radius bump: +1 in two diagonal quadrants selected by the
//     quadrant bool (true: x>0&&z>0 or x<0&&z<0;
//     false: the OTHER two quadrants), else -1 on the
//     top two layers, else 0.
//   - every remaining cell draws exactly one NextFloat
//     BEFORE the diamond test; draw <= side_hole_chance
//     shrinks this cell's radius by 1 more.
//   - keep iff |x|+|z| <= r + bump - hole; then the
//     normalized may_replace gate (poplarPassesAllowList above) and SetBlock.
func (c *poplarCanopy) placeLayer(api wgen.BlockWorld, params treeParamsLists, anchor wgen.BlockPos, rnd random.IRandom, height, r, layerY int, quadrant, wide bool) {
	wideExt := 0
	if wide {
		wideExt = 1
	}
	if r+wideExt < -r {
		return
	}
	isTopTwo := layerY == height-1 || layerY == height-2
	for x := -r; x <= r+wideExt; x++ {
		TickDeadline("building a canopy layer as wide as its radius asks")
		for z := -r; z <= r+wideExt; z++ {
			bump := 0
			if quadrant {
				if (x > 0 && z > 0) || (x < 0 && z < 0) {
					bump = 1
				} else if isTopTwo {
					bump = -1
				}
			} else {
				if (x > 0 && z < 0) || (x < 0 && z > 0) {
					bump = 1
				} else if isTopTwo {
					bump = -1
				}
			}
			if isTopTwo && (abs(x) == r || abs(z) == r) {
				continue // *** no draw for top-two-layer edge cells ***
			}
			hole := 0
			// *** RNG CALL *** -- one NextFloat per remaining cell, spent
			// BEFORE the diamond test (rejected cells still consumed it).
			if float32(rnd.NextFloat()) <= c.sideHoleChance {
				hole = 1
			}
			if abs(x)+abs(z) > r+bump-hole {
				continue
			}
			p := wgen.BlockPos{X: anchor.X + x, Y: anchor.Y + layerY, Z: anchor.Z + z}
			if poplarPassesAllowList(api, c.pal, p, params.mayReplace) {
				api.SetBlock(p, c.leafID)
			}
		}
	}
}

// replaceLeavesWithLog mirrors the poplar canopy's leaf-to-log replacement.
// ZERO RNG. Overwrites the branch layer (anchor.y+branchY,
// branchY = height-4 from the caller) with oriented branch logs along the
// two horizontal axis lines:
//
//   - same x/z loop ranges as placeLayer.
//   - a cell participates iff (x==0 && r-|z| > 3) || (z==0 && r-|x| > 3) --
//     i.e. the two axis arms,
//     each reaching out to |coord| <= r-4.
//   - the same quadrant bump as placeLayer (the
//     isTopTwo term is structurally present but can never fire here, since
//     branchY = height-4 != height-1/height-2), then keep iff |x|+|z| <=
//     r-2+bump (the 2*r-2 constant minus r).
//   - block: branch_block with pillar_axis z when z != 0, else x
//     -- the center cell (0,0) gets the x-axis log.
//   - gate: the same normalized may_replace check (an empty list places
//     directly).
func (c *poplarCanopy) replaceLeavesWithLog(api wgen.BlockWorld, params treeParamsLists, anchor wgen.BlockPos, r, branchY int, quadrant, wide bool) {
	wideExt := 0
	if wide {
		wideExt = 1
	}
	if r+wideExt < -r {
		return
	}
	for x := -r; x <= r+wideExt; x++ {
		TickDeadline("replacing canopy leaves across a layer as wide as its radius asks")
		for z := -r; z <= r+wideExt; z++ {
			onArm := (x == 0 && r-abs(z) > 3) || (z == 0 && r-abs(x) > 3)
			if !onArm {
				continue
			}
			bump := 0
			if quadrant {
				if (x > 0 && z > 0) || (x < 0 && z < 0) {
					bump = 1
				}
			} else {
				if (x > 0 && z < 0) || (x < 0 && z > 0) {
					bump = 1
				}
			}
			if abs(x)+abs(z) > r-2+bump {
				continue
			}
			blockID := c.branchX
			if z != 0 {
				blockID = c.branchZ
			}
			p := wgen.BlockPos{X: anchor.X + x, Y: anchor.Y + branchY, Z: anchor.Z + z}
			if poplarPassesAllowList(api, c.pal, p, params.mayReplace) {
				api.SetBlock(p, blockID)
			}
		}
	}
}

// place mirrors the poplar canopy's placement. Draw sequence, exact:
//
//  1. radius pick        -- poplarPickWeightedRadius (0 or 1 NextIntBound)
//  2. height             -- the inclusive int-range draw over `height`
//  3. quadrant           -- one boolean draw
//     4+ per-cell NextFloat draws, in the inner build's exact layer order:
//     layer(r-2, y=h-1), layer(r-1, y=h-2), layer(r-1, y=h-3),
//     then for y = h-4 down to 1: layer(r, y)          (only when h >= 5),
//     then the leaf-to-log replacement at (r, y=h-4)   (zero draws),
//     then layer(r-1, y=0),
//     then layer(topR, y=-1) where topR = r>=3 ? min(r-2,2) : 1
//     (the min is unsigned, but r>=3 makes r-2 >= 1 so the unsigned/signed
//     distinction never matters).
//
// The game's canopy placement asserts trunkSize matches its trunk_width on
// both axes (non-fatal; execution continues either way). Every trunk in this
// port passes the fixed branch size {1,1} (the poplar trunk uses {1,1} too),
// so wide (=sizeX>1) is constant false here; a JSON trunk_width != 1 only
// ever fed the assert, never the geometry, on this port's call paths.
func (c *poplarCanopy) place(api wgen.BlockWorld, anchor wgen.BlockPos, rnd random.IRandom, params treeParamsLists, _ []wgen.BlockPos) {
	radius := poplarPickWeightedRadius(c.radius, rnd) // *** RNG CALL (0 or 1) ***
	// *** RNG CALL (0 or 1 draw) *** -- height.getValueInclusive.
	height := treeIntRangeValueInclusive(c.heightMin, c.heightMax, rnd)
	quadrant := rnd.NextBoolean() // *** RNG CALL ***
	const wide = false            // branch size {1,1} on every call path -- see doc comment
	c.placeLayer(api, params, anchor, rnd, height, radius-2, height-1, quadrant, wide)
	c.placeLayer(api, params, anchor, rnd, height, radius-1, height-2, quadrant, wide)
	c.placeLayer(api, params, anchor, rnd, height, radius-1, height-3, quadrant, wide)
	if height >= 5 {
		for y := height - 4; y >= 1; y-- {
			TickDeadline("stacking canopy layers as tall as its canopy height asks")
			c.placeLayer(api, params, anchor, rnd, height, radius, y, quadrant, wide)
		}
	}
	c.replaceLeavesWithLog(api, params, anchor, radius, height-4, quadrant, wide)
	c.placeLayer(api, params, anchor, rnd, height, radius-1, 0, quadrant, wide)
	topR := 1
	if radius >= 3 {
		topR = radius - 2
		if topR > 2 {
			topR = 2
		}
	}
	c.placeLayer(api, params, anchor, rnd, height, topR, -1, quadrant, wide)
}

// poplarTrunk is the poplar trunk (`poplar_trunk`) -- see the file header
// for its schema.
type poplarTrunk struct {
	heightMin, heightMax       int // trunk_height, REQUIRED (default {7,9})
	remainingMin, remainingMax int // remaining_trunk_height_above_branches, default {4,4}
	foliageMin, foliageMax     int // amount_of_foliage_support_branches, default {1,4}
	trunkBlock                 block.ID
	// branchX/branchZ are trunk_block with pillar_axis forced -- the trunk's
	// branch pass sets pillar_axis z for north/south branches and x for
	// west/east.
	branchX, branchZ      block.ID
	decoration            *megaTrunkDecoration // trunk_decoration
	logDecorationRef      string               // log_decoration_feature
	logDecorationResolver wgen.IFeatureResolver
	pal                   *block.Palette // for the normalized may_replace gate
}

type TreeFeature struct {
	identifier  string
	trunkBlock  block.ID
	trunkHeight int
	canopy      canopyPlacer
	mayGrowOn   block.MatchSet
	// mayGrowOnFallback is placeBaseBlock's PRODUCING-position fallback
	// block (may_grow_on's first descriptor, resolved to one concrete
	// block) -- only meaningful when !mayGrowOn.Empty(); see buildTreeFeature.
	mayGrowOnFallback block.ID
	baseBlock         block.MatchSet
	baseBlockFallback block.ID
	mayReplace        block.MatchSet
	// mayGrowThrough resolves "may_grow_through" -- consulted by
	// placeSubmergedTrunk (the simple trunk's descent probe and its
	// below-original-origin log gate), i.e. by every bare-`trunk` file.
	// Validated but otherwise unused on the seven <shape>_trunk keys, which
	// gate their columns on may_replace alone; buildTreeFeature warns when
	// the field is written on one of those.
	mayGrowThrough block.MatchSet
	// submergedTrunk is non-nil for EVERY bare "trunk" key -- that key always
	// selects the simple trunk (see the trunk-key list in the file header).
	// The name is historical. can_be_submerged only sets its maxDepth:
	// true -> 255, {max_depth:N} -> N, false/absent -> 0 (no descent).
	submergedTrunk *simpleTrunk
	// trunkDecoration is the plain `trunk` key's own trunk_decoration (an
	// attachable decoration). The simple trunk applies it to every
	// successfully placed log with an ALL-FOUR mask, gated on the SetBlock
	// succeeding.
	// Four vanilla definitions use it: jungle_tree, oak_tree_with_vines,
	// spruce_tree_with_vines and undecorated_jungle_tree_with_vines.
	trunkDecoration *megaTrunkDecoration
	// cherryTrunk is non-nil only for the top-level "cherry_trunk" variant.
	// Its canopy is parsed from branches.branch_canopy, not from a sibling
	// canopy key at tree-feature level.
	cherryTrunk *cherryTrunk
	// roots is non-nil only when the JSON supplies "mangrove_roots" -- see
	// buildTreeFeature and mangroveRootsPlace. nil is a pure no-op (skips
	// straight to trunk placement at the feature's own raw ctx.Origin).
	roots  *mangroveRoots
	fallen *fallenTrunk
	// poplar is non-nil only for the top-level "poplar_trunk" variant -- see
	// poplarTrunk's own doc comment and placePoplarTrunk.
	poplar *poplarTrunk
	shaped *shapedTrunk
	// mangroveTrunk is non-nil only for the top-level "mangrove_trunk"
	// variant -- see mangroveTrunk's own doc comment and placeMangroveTrunk.
	mangroveTrunk *mangroveTrunk
	// baseCluster is non-nil only when the JSON supplies the top-level
	// "base_cluster" object -- see baseCluster's own doc comment and
	// placeBaseClusterGroundwork. Consulted ONLY by placeMegaTrunk (vanilla
	// applies base_cluster to the mega trunk alone); nil is a pure no-op.
	baseCluster *baseCluster
	warnings    []string
}

type intervalHeight struct {
	base      int
	intervals []int
}

// sample mirrors the acacia trunk's and mega trunk's own height draws:
// base plus one direct
// NextIntBound(interval) call for every interval, in array order.
func (h intervalHeight) sample(rnd random.IRandom) int {
	value := h.base
	for _, interval := range h.intervals {
		value += rnd.NextIntBound(interval)
	}
	return value
}

type shapedTrunk struct {
	kind                         string
	height                       intervalHeight
	width                        int
	leanHeightMin, leanHeightMax int
	leanStepsMin, leanStepsMax   int
	leanLengthMin, leanLengthMax int
	allowDiagonal                bool
	// minHeightForCanopy is acacia_trunk.trunk_height.min_height_for_canopy
	// (default 3). Trunk cells below this height index are placed
	// but do NOT become canopy anchors -- see placeShapedTrunk.
	minHeightForCanopy int
	fancyVariance      int
	fancyScale         float32
	// fancy_trunk's own required fields -- see placeFancyTrunk for the
	// algorithm. All five are REQUIRED, as is the `branches` object three of
	// them live in (unlike acacia_trunk, where `branches` is optional).
	fancySlope          float32 // branches.slope
	fancyDensity        float32 // branches.density
	fancyMinAltitude    float32 // branches.min_altitude_factor
	fancyFoliageAltFact float32 // foliage_altitude_factor
	fancyWidthScale     float32 // width_scale
	// branches/decoration are non-nil only for the "mega_trunk" variant --
	// see megaBranches/megaTrunkDecoration and placeMegaTrunk below.
	branches   *megaBranches
	decoration *megaTrunkDecoration
	// acaciaBranches is acacia_trunk's own, unrelated `branches` object -- see
	// acaciaBranches' own doc comment for why it is not megaBranches. nil when
	// the JSON omitted it, in which case the defaults still run
	// (they place nothing but do spend a draw on the leaning path).
	acaciaBranches *acaciaBranches
}

// megaBranches models the mega trunk's own "branches" sub-object. The
// branches loop runs when the trunk has no top canopy handed to it directly,
// matching every other trunk shape in this file: the top canopy is placed
// separately by f.placeCanopies AFTER trunk geometry (the acacia trunk
// likewise treats its canopy as optional and places it once at the end).
//
// Fields:
//
//	int    "branch_length"   -- number of logs per branch
//	int range "branch_interval" -- drawn with the EXCLUSIVE-style int-range
//	                draw treeIntRangeValue implements, NOT the inclusive
//	                int-range draw, which is a different routine.
//	float  "branch_slope"
//	float  branch_altitude_factor.min
//	float  branch_altitude_factor.max
//	canopy wrapper: "branch_canopy" (nested inside "branches", same nesting
//	                as cherry_trunk's branch_canopy) -- placed ONCE PER
//	                BRANCH, INLINE, immediately after that branch's own
//	                geometry, NOT deferred to a collected-anchor pass the way
//	                f.placeCanopies handles the trunk's top-level canopy. The
//	                game's RNG order puts the branch canopy's draws between
//	                one branch's geometry and the next branch_interval draw,
//	                so megaBranches.place calls it directly. (The cherry
//	                trunk, by contrast, computes all tips first and then
//	                places a canopy per tip.)
//
// Per-branch draw sequence:
//
//	level := topThreshold - branch_interval.getValue(rnd)   // *** RNG ***
//	for level > lowThreshold {
//	    angle := rnd.NextFloat() * PI * 2                    // *** RNG ***
//	                 // PI here is the FULL-precision float32 pi, not a
//	                 // truncated 3.1416 (the same distinction cave.go
//	                 // documents for the cave carver).
//	    startY := int(float32(level-1) - branch_slope*float32(length-1))
//	    for step := 0; step < length; step++ {
//	        x := origin.X + int(1.5 + cos(angle)*float32(step))
//	        z := origin.Z + int(1.5 + sin(angle)*float32(step))
//	        y := int(float32(startY) + branch_slope*float32(step))
//	        SetBlock(x,y,z, trunkBlock)   // UNCONDITIONAL -- there is NO
//	                 // may_replace gate here, unlike the main column's
//	                 // per-cell placement (which DOES run the
//	                 // block-descriptor list match, see placeMegaTrunk).
//	    }
//	    if branch_canopy configured {
//	        branch_canopy.placeCanopy(api, (lastX, level, lastZ), rnd, ..., candidates=nil)
//	                 // Y is `level` -- the CURRENT threshold BEFORE this
//	                 // branch's own startY/slope offset -- not the last
//	                 // computed y.
//	    }
//	    level -= branch_interval.getValue(rnd)                // *** RNG ***
//	}
type megaBranches struct {
	length                   int
	slope                    float32
	intervalMin, intervalMax int
	altitudeMin, altitudeMax float32
	canopyBody               map[string]any
	canopyKey                string
	canopy                   canopyPlacer
}

// acaciaDecorationMask reproduces the direction mask the acacia trunk builds per trunk cell before
// the decorated-block write: entry 0 is set when the cell is on the -X edge, entry 1 on the +X
// edge, entry 2 on -Z, entry 3 on +Z -- but the +X and +Z tests only apply when the cell is not
// already on the corresponding minus edge (the game branches, it does not evaluate both). For
// trunk_width 1 that distinction is visible: dx==0 and dx==width-1 both hold, and the game sets
// entry 0 only.
//
// The mega trunk's per-trunk-log mask is the SAME sequence as acacia's, guard included: test the
// -X edge first, then compare against width-1 before the +X entry. If placeMegaTrunk in this file
// derives the mask UNGUARDED, that is a bug in this file rather than a vanilla difference.
//
// One asymmetry that IS real, in a different place: for mega's BRANCH logs (not trunk logs) the
// mask handed to the decoration write is all zero.
func acaciaDecorationMask(dx, dz, width int) [4]bool {
	return [4]bool{
		dx == 0,
		dx != 0 && dx == width-1,
		dz == 0,
		dz != 0 && dz == width-1,
	}
}

// acaciaBranches models the acacia trunk's own `branches` sub-object -- a
// DIFFERENT object from mega_trunk's `branches` above (different keys,
// different consumer, different geometry), so it gets its own type rather than
// sharing megaBranches.
//
// Schema:
//
//	branches        object             OPTIONAL
//	  branch_length   int range        REQUIRED
//	  branch_position int range        REQUIRED
//	  branch_chance   chance value     REQUIRED
//	  branch_canopy   object           OPTIONAL
//
// Defaults: branch_length {1,5}, branch_position {1,3}, branch_chance ZEROED
// and branch_canopy absent. The zeroed chance is why a `branches`-less acacia
// grows no branches at all: percent mode with percent 0 returns false with NO
// draw (see chanceInformation.roll), and the branch routine runs
// UNCONDITIONALLY at the end of the trunk placement regardless of whether
// `branches` appeared in the JSON.
//
// WHICH routine runs is decided by allow_diagonal_growth (default TRUE),
// tested at the end of the trunk placement: true selects the leaning-branch
// placement, false selects the vertical-branch placement.
// The two are NOT variations on one algorithm -- they differ in
// geometry, in how many branches they can produce, and even in the ORDER they
// draw branch_length vs branch_position:
//
//	                    leaning (diagonal)          vertical (non-diagonal)
//	branches placed     at most ONE                 up to one per perimeter cell
//	draw order          position, then length       length, then position
//	direction draw      nextInt(4), always          none
//	block placement     the decorated-block write   the single-block write
//	                    (trunk_decoration applies)  (no decoration)
//
// That draw-order inversion reads like a transcription slip; it is not. The
// two routines genuinely draw the two ranges in opposite orders.
type acaciaBranches struct {
	lengthMin, lengthMax     int
	positionMin, positionMax int
	chance                   chanceInformation
	canopyBody               map[string]any
	canopyKey                string
	canopy                   canopyPlacer
}

// acaciaBranchDefaults returns the default branches config -- what the game
// runs when `branches` is absent from the JSON. It produces no
// branch (zeroed chance rolls false without drawing), but it is NOT a no-op:
// the leaning path still burns its unconditional nextInt(4) direction draw
// before reaching the chance gate, which is why this is modelled rather than
// skipped.
func acaciaBranchDefaults() *acaciaBranches {
	return &acaciaBranches{lengthMin: 1, lengthMax: 5, positionMin: 1, positionMax: 3}
}

// placeAcaciaLeaningBranches ports the acacia trunk's leaning-branch
// placement -- the allow_diagonal_growth=true path. The control flow is
// subtle (the walk continues past invalid cells), so each step below is
// spelled out.
//
// origin is the trunk placement's own origin, leanDir/leanStart are the
// values it already computed for the MAIN trunk lean, and height is the
// sampled trunk height. The branch's start x/z come from the ORIGIN, not from
// the leaned trunk top: the start position is {origin.x, anchor.y, origin.z}
// and the loop overwrites y anyway.
//
// Sequence:
//
//  1. dir = nextInt(4) -- ALWAYS drawn.
//  2. if dir == leanDir: return. The draw is still spent.
//  3. if !branch_chance.roll: return.
//  4. position = branch_position.getValue -- FIRST.
//  5. length = branch_length.getValue -- SECOND.
//  6. index = leanStart - position; if index >= height: return.
//  7. if length < 1: return.
//  8. Walk: each iteration steps x/z by the per-direction X/Z step tables at
//     [dir] and sets
//     y = origin.Y + index, then tests isValidTreePosition. A valid cell is
//     placed and the walk continues from index+1; an INVALID cell still leaves
//     the x/z step applied and still consumes one length unit. The walk ends
//     when index+1 reaches height or length runs out.
//  9. If nothing was ever placed: return without a canopy.
//     Otherwise place branch_canopy at (walked x, LAST PLACED y, walked z) with
//     branch size {1,1} -- note the x/z are the walk's final values while y is
//     the last successful placement, so a trailing invalid step moves the
//     canopy sideways off the last log. That asymmetry is real: the game
//     replaces ONLY the y of the walked position before placing the canopy.
func placeAcaciaLeaningBranches(api wgen.BlockWorld, rnd random.IRandom, params treeParamsLists,
	b *acaciaBranches, trunkBlock block.ID, decoration *megaTrunkDecoration,
	origin wgen.BlockPos, anchorY, height, leanDir, leanStart int) {

	// *** RNG CALL *** -- unconditional, even when everything below bails.
	dir := rnd.NextIntBound(4)
	if dir == leanDir {
		return
	}
	if !b.chance.roll(rnd) {
		return
	}
	// *** RNG *** position FIRST, then length -- opposite of the vertical path.
	position := treeIntRangeValue(b.positionMin, b.positionMax, rnd)
	length := treeIntRangeValue(b.lengthMin, b.lengthMax, rnd)

	index := leanStart - position
	if index >= height || length < 1 {
		return
	}

	pos := wgen.BlockPos{X: origin.X, Y: anchorY, Z: origin.Z}
	placed := false
	lastY := 0
	for {
		TickDeadline("walking a leaning branch as long as its branch_length asks")
		if index >= 1 {
			// The step is applied before the validity test and is NOT rolled
			// back when the test fails.
			pos.Z += leanDZ[dir]
			pos.X += leanDX[dir]
			pos.Y = origin.Y + index
			if isValidTreePosition(api, pos, params.mayReplace) {
				placeLog(api, pos, trunkBlock)
				if decoration != nil {
					// A CONSTANT mask here -- all four horizontal directions
					// enabled, unlike the trunk loop's per-cell mask.
					decoration.place(api, pos, mangroveTrunkAllDirections, rnd)
				}
				placed = true
				lastY = pos.Y
				index++
				if index >= height || length <= 1 {
					break
				}
				length--
				continue
			}
		}
		index++
		if index >= height || length <= 1 {
			break
		}
		length--
	}
	if !placed || b.canopy == nil {
		return
	}
	pos.Y = lastY
	b.canopy.place(api, pos, rnd, params, nil)
}

// placeAcaciaVerticalBranches ports the acacia trunk's vertical-branch
// placement -- the allow_diagonal_growth=false path.
//
// This one sweeps the RING around the trunk footprint and can produce several
// branches in one tree. Both loops run their offset from -1 through trunkWidth
// INCLUSIVE (the body also runs for the offset equal to the width), and a
// cell is a candidate only when it lies OUTSIDE [0,width) on at least one
// axis. Interior cells are skipped without a draw.
//
// Per candidate cell:
//
//  1. branch_chance.roll; false -> next cell.
//  2. length = branch_length.getValue -- FIRST here.
//  3. position = branch_position.getValue -- SECOND.
//  4. If length != 0, place a DOWNWARD column of `length` cells starting at
//     y = anchor.Y - position, each gated by isValidTreePosition and placed
//     with a plain single-block write -- no decoration, unlike the
//     leaning path. x/z come from the ORIGIN plus the cell offset while y comes
//     from the ANCHOR; for a non-leaning trunk those
//     x/z agree with the anchor's own anyway.
//  5. branch_canopy, if configured, at (anchor.X+dx, anchor.Y-position,
//     anchor.Z+dz) with branch size {1,1} -- placed even when length is 0
//     (the zero case falls straight through to the canopy call).
//
// A NEGATIVE length trips an assert in the game and then walks a
// loop backwards from a negative counter; that is a game bug, not a
// behaviour worth reproducing, so length <= 0 is treated here the way length
// == 0 is: no column, canopy still placed.
func placeAcaciaVerticalBranches(api wgen.BlockWorld, rnd random.IRandom, params treeParamsLists,
	b *acaciaBranches, trunkBlock block.ID, origin, anchor wgen.BlockPos, trunkWidth int) {

	for dx := -1; dx <= trunkWidth; dx++ {
		for dz := -1; dz <= trunkWidth; dz++ {
			TickDeadline("walking a vertical branch as long as its branch_length asks")
			onRing := dx < 0 || dx >= trunkWidth || dz < 0 || dz >= trunkWidth
			if !onRing {
				continue
			}
			if !b.chance.roll(rnd) {
				continue
			}
			// *** RNG *** length FIRST here -- opposite of the leaning path.
			length := treeIntRangeValue(b.lengthMin, b.lengthMax, rnd)
			position := treeIntRangeValue(b.positionMin, b.positionMax, rnd)

			for n, y := length, anchor.Y-position; n > 0; n, y = n-1, y-1 {
				p := wgen.BlockPos{X: origin.X + dx, Y: y, Z: origin.Z + dz}
				if isValidTreePosition(api, p, params.mayReplace) {
					placeLog(api, p, trunkBlock)
				}
			}
			if b.canopy != nil {
				b.canopy.place(api, wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y - position, Z: anchor.Z + dz},
					rnd, params, nil)
			}
		}
	}
}

// placeAcaciaBranches dispatches on allow_diagonal_growth exactly the way
// the acacia trunk placement's tail does (true -> leaning, else
// vertical). Both routines run unconditionally at the end of every acacia
// trunk, configured or not.
func placeAcaciaBranches(api wgen.BlockWorld, rnd random.IRandom, params treeParamsLists,
	b *acaciaBranches, trunkBlock block.ID, decoration *megaTrunkDecoration,
	origin, anchor wgen.BlockPos, trunkWidth, height, leanDir, leanStart int, allowDiagonal bool) {

	if b == nil {
		b = acaciaBranchDefaults()
	}
	if allowDiagonal {
		placeAcaciaLeaningBranches(api, rnd, params, b, trunkBlock, decoration, origin, anchor.Y, height, leanDir, leanStart)
		return
	}
	placeAcaciaVerticalBranches(api, rnd, params, b, trunkBlock, origin, anchor, trunkWidth)
}

// place mirrors the mega trunk's branches loop -- see megaBranches' own doc
// comment for the algorithm.
func (b *megaBranches) place(api wgen.BlockWorld, origin wgen.BlockPos, rnd random.IRandom, height int, params treeParamsLists, trunkBlock block.ID) {
	if b.length < 1 {
		return
	}
	topThreshold := int(float32(height)*b.altitudeMax) + origin.Y
	lowThreshold := int(float32(height)*b.altitudeMin) + origin.Y
	// *** RNG CALL *** -- branch_interval.getValue (treeIntRangeValue).
	level := topThreshold - treeIntRangeValue(b.intervalMin, b.intervalMax, rnd)
	for level > lowThreshold {
		TickDeadline("stepping down the trunk by its branch_interval")
		// *** RNG CALL *** -- NextFloat(), the branch's own outward angle.
		//
		// EngineCos/EngineSin, NOT math.Cos/math.Sin: the mega trunk is one
		// of the five worldgen features that use the game's 65536-entry sine
		// lookup table (see enginemath.go) for both cosine and sine of the
		// same angle value.
		//
		// The angle is computed in FLOAT32 with a rounding at every step:
		//
		//	d := one float draw
		//	d * pi (float32)
		//	(d * pi) * 2                        <- grouping matters
		//
		// With a truncating table index, computing this in float64 and
		// narrowing only at the trig call can move a table entry.
		angle := float32(float32(rnd.NextFloat())*float32(math.Pi)) * 2
		cosA := EngineCos(angle)
		sinA := EngineSin(angle)
		// The explicit float32() around every product below is a rounding
		// barrier, not noise: gc otherwise fuses the multiply into the
		// neighbouring add/sub (one rounding), and the game rounds twice. Every
		// one of these is a separate multiply and then an add or subtract in
		// vanilla: startY is a multiply then a subtract;
		// x is a multiply then an add against a 1.5f constant; z and y are
		// two multiplies then two adds.
		// Truncation follows each add, so a last-bit difference at the
		// .5 boundary moves a block. See features/fmafusion_test.go.
		startY := int(float32(level-1) - float32(b.slope*float32(b.length-1)))
		var tipX, tipZ int
		for step := 0; step < b.length; step++ {
			TickDeadline("walking a branch as long as its branch_length asks")
			x := origin.X + int(1.5+float32(cosA*float32(step)))
			z := origin.Z + int(1.5+float32(sinA*float32(step)))
			y := int(float32(startY) + float32(b.slope*float32(step)))
			api.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, trunkBlock)
			tipX, tipZ = x, z
		}
		if b.canopy != nil {
			b.canopy.place(api, wgen.BlockPos{X: tipX, Y: level, Z: tipZ}, rnd, params, nil)
		}
		// *** RNG CALL *** -- branch_interval.getValue, next branch.
		level -= treeIntRangeValue(b.intervalMin, b.intervalMax, rnd)
	}
}

// megaTrunkVineDirections is the attachable decoration's fixed direction
// order and multi-face-direction-bits encoding -- the SAME bit values
// (west=32, east=8, north=4, south=16) canopyDecoration uses for the
// identical vine-attachment mechanic.
var megaTrunkVineDirections = [4]struct {
	dx, dz int
	bit    int
}{
	{-1, 0, 32}, // west
	{1, 0, 8},   // east
	{0, -1, 4},  // north
	{0, 1, 16},  // south
}

// megaTrunkDecoration models the mega trunk's "trunk_decoration" -- an
// attachable-decoration record. The mega trunk decorates logs in two places,
// the top-layer loop and the lower-layers loop; both use the same decoration
// write and differ only in the direction mask:
//
//   - Top layer: every direction disabled, so the decoration is a no-op (the
//     validity check still passes, but all 6 directions are skipped and ZERO
//     chance rolls happen for the topmost log layer).
//   - Lower layers: the mask comes from the log's local (dx,dz) index within
//     the trunk_width footprint: west iff dx==0, east iff dx==trunk_width-1,
//     north/south analogously from dz. Up/down are always disabled.
//
// The attachable decoration's JSON fields: decoration_chance (a chance value),
// decoration_blocks_sequence (array of {block, count: int range defaulting to
// "1"}), decoration_block (a block descriptor, the singular shorthand -- what
// mega_jungle_tree_feature.json uses), num_steps (plain int, optional,
// accepted but without effect -- see below), and step_direction (the growth
// direction, see stepDirection).
//
// Decoration write, per log:
//
//	if !decoration_chance.isValid() { return }   // zeroed -> whole call is a no-op
//	for each of the 4 horizontal directions (mask[i] gates each):
//	    candidate := log + directionOffset (dx,dz only; dy always 0)
//	    if !mask[i] { continue }
//	    if !chance.roll(rnd) { continue }             // *** RNG CALL ***
//	    if !materialCheck(GetBlock(candidate)) { continue }  // ZERO draws
//	    placeMultiDecoration(api, rnd, candidate, direction, log)
//
// The multi-decoration step walks decoration_blocks_sequence IN ORDER,
// continuing the SAME running position from entry to entry (a sequence of
// stacked block runs, not a per-entry reset):
//
//	pos := candidate
//	for each entry in decoration_blocks_sequence:
//	    block := TransformBlock(entry.block.resolve(), direction)
//	    count := entry.count.getValueInclusive(rnd)   // *** RNG CALL, ALWAYS,
//	                                                   // drawn BEFORE the
//	                                                   // material check, for
//	                                                   // every entry, even if
//	                                                   // count ends up unused ***
//	    if materialCheck(GetBlock(pos)) && count >= 1 {
//	        do {
//	            SetBlock(pos, block)
//	            pos += direction
//	            if !materialCheck(GetBlock(pos)) { break }
//	        } while (--count > 1... i.e. total `count` placements, checking
//	                 the NEXT cell before every placement past the first)
//	    }
//	    // next entry, pos NOT reset
//
// step_direction selects the per-entry step (2 = outward, following the
// candidate's horizontal (dx,dz) offset from the log; 1 = up +Y; 0 = down -Y;
// anything else = no movement) and defaults to 0 = DOWN. It is unobservable
// for count<=1 entries, since the first placement is always at the candidate
// cell. The singular decoration_block key synthesizes a ONE-entry sequence
// with count={1,1} (ZERO draws for that entry's inclusive int-range draw,
// matching treeIntRangeValueInclusive's min>=max early-return -- see that
// function's doc comment), so its draw sequence is identical to a plain
// single-block decoration. trunk_decoration.num_steps is accepted but inert:
// the multi-decoration step only reads the sequence and each entry's int
// range -- see parseAttachableDecorationObject's doc comment and the precedent
// (trunk_width/branches.branch_chance) this follows.
type megaTrunkDecorationEntry struct {
	blockID            block.ID
	countMin, countMax int
}

type megaTrunkDecoration struct {
	entries []megaTrunkDecorationEntry
	chance  chanceInformation
	// stepDirection is the `step_direction` key, the growth direction:
	// 2 = outward (candidate minus log, per-component), 1 = up (+Y),
	// 0 = down (-Y), anything else = no movement. The default is 0 = DOWN.
	// The difference from "outward" is only observable with a count > 1
	// entry; the first placement is always at the candidate cell regardless.
	// (The sibling num_steps key has no effect -- see the doc comment above.)
	stepDirection int
	pal           *block.Palette
}

// place implements the decoration write plus the multi-decoration step -- see
// megaTrunkDecoration's doc comment for the direction masks and the
// per-entry-sequence algorithm. enabled[i] corresponds 1:1 with
// megaTrunkVineDirections[i]. Each enabled direction draws EXACTLY one
// chanceInformation.roll(), in megaTrunkVineDirections' fixed order,
// REGARDLESS of whether the candidate cell goes on to pass its material check
// (the roll comes first, unconditionally when the mask bit is set;
// GetBlock + material check only after a successful roll).
func (d *megaTrunkDecoration) place(api wgen.BlockWorld, log wgen.BlockPos, enabled [4]bool, rnd random.IRandom) {
	for i, dir := range megaTrunkVineDirections {
		if !enabled[i] {
			continue
		}
		// *** RNG CALL *** -- the shared chance roll, unconditional once
		// this direction's mask bit is set.
		if !d.chance.roll(rnd) {
			continue
		}
		p := wgen.BlockPos{X: log.X + dir.dx, Y: log.Y, Z: log.Z + dir.dz}
		// Material-type check on the candidate cell, gating whether the
		// multi-decoration step runs at all; approximated with this file's
		// established IsAir check (see e.g. canopyDecoration.place and
		// isValidTreePosition).
		if !api.Palette().IsAir(api.GetBlock(p)) {
			continue
		}
		// The entry-sequence walk -- position CONTINUES across entries (no
		// reset), and each entry ALWAYS draws its count via
		// treeIntRangeValueInclusive before any material check (see doc
		// comment). The per-entry step vector follows step_direction (see
		// stepDirection's doc comment) -- 2 outward, 1 up, 0 down (the
		// default), anything else no movement.
		sx, sy, sz := 0, 0, 0
		switch d.stepDirection {
		case 2:
			sx, sz = dir.dx, dir.dz
		case 1:
			sy = 1
		case 0:
			sy = -1
		}
		for _, entry := range d.entries {
			decorated, ok := d.pal.WithIntState(entry.blockID, block.MultiFaceDirectionBits, dir.bit)
			if !ok {
				decorated = entry.blockID
			}
			// *** RNG CALL (0 or 1 draw) *** -- entry.count.getValueInclusive,
			// drawn unconditionally per entry, ZERO draws for a degenerate
			// {1,1} count (the decoration_block singular-shorthand default).
			count := treeIntRangeValueInclusive(entry.countMin, entry.countMax, rnd)
			if !api.Palette().IsAir(api.GetBlock(p)) || count < 1 {
				continue
			}
			for step := 0; step < count; step++ {
				TickDeadline("growing a trunk decoration as far as its count asks")
				api.SetBlock(p, decorated)
				p.X += sx
				p.Y += sy
				p.Z += sz
				if step+1 < count && !api.Palette().IsAir(api.GetBlock(p)) {
					break
				}
			}
		}
	}
}

// mangroveTrunk is the top-level `mangrove_trunk` variant.
//
// JSON fields:
//
//	"trunk_width"    int (optional) -- accepted and validated but without
//	                 effect: neither the trunk placement nor the branch
//	                 placement uses it. Same "inert, accepted not refused"
//	                 treatment as mega_trunk's "num_steps".
//	"trunk_height"   object (required):
//	    "base"           int (required) -- the constant term of the height.
//	    "height_rand_a"  int (required) -- the height's FIRST bounded draw,
//	                     over that field + 1 (see getTreeHeight).
//	    "height_rand_b"  int (required) -- the SECOND draw, same shape.
//	"trunk_block"    block descriptor.
//	"branches"       object (optional):
//	    "branch_length"  int range (optional) -- drawn TWICE via the
//	                     inclusive int-range draw (see "the coin flip" below).
//	    "branch_steps"   int range (optional) -- drawn ONCE.
//	    "branch_chance"  chance value (optional) -- accepted and validated but
//	                     without effect: neither the trunk nor the branch
//	                     placement ever runs a chance roll with it. Same
//	                     treatment as trunk_width.
//	"trunk_decoration" object (optional) -- the attachable-decoration shape
//	                 mega_trunk's trunk_decoration also uses
//	                 (decoration_block / decoration_blocks_sequence /
//	                 decoration_chance / num_steps accepted but inert),
//	                 parsed by parseAttachableDecorationObject and placed by
//	                 megaTrunkDecoration/megaTrunkDecorationEntry, shared
//	                 rather than duplicated. The trunk column and the branch
//	                 logs both use this same decoration object, with ALL FOUR
//	                 horizontal directions enabled and up/down disabled, for
//	                 EVERY successfully-placed log (trunk column AND branch
//	                 alike, including the FINAL/topmost trunk log -- unlike
//	                 mega_trunk, there is no top-layer all-disabled special
//	                 case). mangroveTrunkAllDirections models this fixed mask.
//
// ---- The coin flip: RNG call order (the decisive detail this port is built
// around) ----
//
// Per log, in the trunk loop (i = 0..height-1):
//
//  1. The position validity test (api, pos, may_replace) -- ZERO draws.
//  2. If valid: SetBlock(pos, trunk_block, flag=3) (placeLog). ZERO draws.
//  3. If SetBlock succeeded: the trunk decoration -- see
//     mangroveTrunkAllDirections/megaTrunkDecoration.place for its
//     per-direction chance rolls (0-4, only if trunk_decoration is configured
//     with a valid chance; ZERO when absent, the default case).
//  4. If i < height-1 (non-final log) -- *** RNG CALL, a boolean draw ***.
//     This draw happens ONLY when the validity test AND SetBlock both
//     succeeded -- but CRITICALLY, it does NOT depend on whether the JSON
//     supplies a "branches" object at all. The coin flip is part of the
//     mangrove trunk's algorithm for EVERY non-final successfully-placed log,
//     using branch_length/branch_steps' zeroed default int ranges when
//     "branches" is absent. A version that special-cased "branches present"
//     would silently desync the RNG stream for every mangrove_trunk JSON that
//     omits "branches" (a completely legal body, since the key is optional).
//  5. If the coin flip returns true -- THREE MORE unconditional draws, in
//     this exact order:
//     a. A random horizontal face: rnd.NextIntBound(4)+2, yielding one of
//     {2,3,4,5} = the facing values for {North,South,West,East} (see the
//     per-face steps below) -- NOT this file's leanDX/leanDZ table, whose
//     indices 0-3 use a DIFFERENT (South,West,North,East) ordering
//     established for the acacia trunk; mangroveBranchDX/mangroveBranchDZ
//     below is a dedicated table matching THIS shape's
//     {North,South,West,East} ordering.
//     b. branch_length.getValueInclusive(rnd) -- draw #1.
//     c. branch_length.getValueInclusive(rnd) -- draw #2 (the SAME field,
//     drawn AGAIN; both results are used -- see below).
//     d. branch_steps.getValueInclusive(rnd) -- one draw.
//     Then the branch is placed using: the branch start
//     `max(0, draw1-draw2-1)`, draw (d) verbatim as the step budget, the
//     face from draw (a), and the CURRENT log's working position and its Y
//     coordinate -- see mangroveTrunkBranch for how each is consumed.
//
// Per-face X and Z steps: the X step is -1 iff facing==4(West), +1 iff
// facing==5(East), else 0; the Z step is -1 iff facing==2(North), +1 iff
// facing==3(South), else 0 -- the standard Bedrock facing enum
// (0=Down,1=Up,2=North,3=South,4=West,5=East).
var mangroveTrunkAllDirections = [4]bool{true, true, true, true}

// mangroveBranchDX/mangroveBranchDZ are indexed by (facing-2), matching the
// random horizontal face draw's {2,3,4,5} = {North,South,West,East} output
// range -- see mangroveTrunk's doc comment. Deliberately NOT the same table as
// leanDX/leanDZ (the acacia trunk's South/West/North/East ordering, a
// different enum convention).
var mangroveBranchDX = [4]int{0, 0, -1, 1} // North, South, West, East
var mangroveBranchDZ = [4]int{-1, 1, 0, 0} // North, South, West, East

type mangroveTrunk struct {
	trunkBlock                       block.ID
	heightBase                       int
	heightRandA, heightRandB         int
	branchLengthMin, branchLengthMax int
	branchStepsMin, branchStepsMax   int
	// decoration is trunk_decoration (an attachable decoration),
	// optional -- nil is a pure no-op (a zeroed decoration -> every
	// chance roll returns false with zero draws, matching
	// megaTrunkDecoration's own established zero-cost-when-absent
	// contract), so this port models "absent" as literally not calling
	// .place at all rather than allocating a zeroed struct.
	decoration *megaTrunkDecoration
}

// getTreeHeight implements the mangrove trunk's height:
// `nextIntBound(height_rand_a + 1) + nextIntBound(height_rand_b + 1) + base`,
// via the plain bounded integer draw (the same one cave.go and
// spruce_canopy use). Draw order: height_rand_a FIRST, height_rand_b SECOND,
// then both summed with base (base itself draws nothing).
func (t *mangroveTrunk) getTreeHeight(rnd random.IRandom) int {
	a := rnd.NextIntBound(t.heightRandA + 1)
	b := rnd.NextIntBound(t.heightRandB + 1)
	return t.heightBase + a + b
}

// mangroveTrunkBranch implements the mangrove trunk's branch placement end to
// end -- see mangroveTrunk's doc comment for where every argument comes from.
// pos is the CURRENT trunk log's position (read into local x/z here and never
// written back; the trunk loop does not use the branch's final position).
// yBase is that same log's Y. start is
// `max(0, branch_length.draw1-branch_length.draw2-1)`. steps is branch_steps'
// single draw (a countdown budget, NOT a hard step count -- see the loop
// condition below).
//
// Per-step algorithm:
//
//	v := start          // NOT necessarily >=1
//	for {
//	    if v >= 1 {
//	        x, z = x+stepX(facing), z+stepZ(facing)   // ALWAYS steps once
//	        y := v + yBase
//	        pos := (x, y, z)
//	        if isValidTreePosition(pos) {              // ZERO draws
//	            if SetBlock(pos, trunk_block) {         // ZERO draws
//	                decorate(pos, ...)                  // see doc comment
//	                tipY = y + 1
//	            } else {
//	                tipY = y
//	            }
//	        } else {
//	            tipY = y
//	        }
//	        candidates = append(candidates, pos)        // UNCONDITIONAL --
//	                     // pushed regardless of isValidTreePosition/SetBlock
//	                     // success.
//	    }
//	    v++
//	    if v >= height { break }
//	    oldSteps := steps; steps--
//	    if oldSteps <= 1 { break }
//	}
//	if tipY - yBase > 1 {
//	    candidates = append(candidates, (finalX, tipY-2, finalZ))
//	}
//	// The branch also ALWAYS appends one branch size {1,1} to a SEPARATE
//	// list -- every entry in that list is always {1,1} throughout this
//	// codebase (see the file header's core-width notes), so this port does
//	// not track it; canopyPlacer never receives a branch size at all.
//
// The loop continuation is short-circuited: `steps` is only decremented (and
// tested) when `v+1 < height` still holds. Ported literally below, not
// simplified, since the short-circuit changes whether `steps` decrements on
// the iteration that hits the height ceiling.
func mangroveTrunkBranch(api wgen.BlockWorld, rnd random.IRandom, mayReplace block.MatchSet, pos wgen.BlockPos, yBase, height, facing, start, steps int, trunkBlock block.ID, decoration *megaTrunkDecoration, candidates *[]wgen.BlockPos) {
	dx, dz := mangroveBranchDX[facing-2], mangroveBranchDZ[facing-2]
	x, z := pos.X, pos.Z
	tipY := start + yBase
	finalX, finalZ := x, z
	// Outer double gate: `start < height`, and then `steps >= 1` before
	// entering the loop. When EITHER fails, the loop runs ZERO iterations --
	// v/tipY keep their initial values, and the tail "push a tip candidate"
	// check below still runs using those unmodified initial values (it is NOT
	// nested inside this gate).
	if start < height && steps >= 1 {
		v := start
		for {
			TickDeadline("walking a trunk branch as far as its num_steps asks")
			if v >= 1 {
				x += dx
				z += dz
				y := v + yBase
				p := wgen.BlockPos{X: x, Y: y, Z: z}
				tipY = y
				if isValidTreePosition(api, p, mayReplace) {
					if api.SetBlock(p, trunkBlock) {
						if decoration != nil {
							decoration.place(api, p, mangroveTrunkAllDirections, rnd)
						}
						tipY = y + 1
					}
				}
				finalX, finalZ = x, z
				*candidates = append(*candidates, p)
			}
			v++
			if v >= height {
				break
			}
			oldSteps := steps
			steps--
			if oldSteps <= 1 {
				break
			}
		}
	}
	if tipY-yBase > 1 {
		*candidates = append(*candidates, wgen.BlockPos{X: finalX, Y: tipY - 2, Z: finalZ})
	}
}

type fallenTrunk struct {
	logMin, logMax       int
	heightMin, heightMax int
	stumpMin, stumpMax   int
	logX, logZ           block.ID
	// logDecorationRef/logDecorationResolver back "log_decoration_feature" (a feature
	// reference) -- see placeFallenTrunk's doc comment. Empty ref / nil resolver is a pure
	// no-op (the key is optional).
	logDecorationRef      string
	logDecorationResolver wgen.IFeatureResolver
	// decoration is "trunk_decoration" (an attachable decoration) -- the SAME
	// parseAttachableDecorationObject/megaTrunkDecoration machinery mega_trunk and
	// mangrove_trunk already share, applied to the fallen trunk's stump column (see
	// placeFallenTrunk). nil is the established no-op default.
	decoration *megaTrunkDecoration
	pal        *block.Palette // for the normalized may_replace stump gate
}

func (f *TreeFeature) TypeID() string     { return treeTypeID }
func (f *TreeFeature) Identifier() string { return f.identifier }

func (f *TreeFeature) placeCanopies(api wgen.BlockWorld, rnd random.IRandom, params treeParamsLists, anchors []treeCanopyAnchor) {
	if f.canopy == nil {
		return
	}
	for _, anchor := range anchors {
		f.canopy.place(api, anchor.pos, rnd, params, anchor.candidates)
	}
}

// applyRoots is the FEATURE-level mangrove_roots pass, and the single
// implementation every one of this file's eight trunk paths calls.
//
// It is feature-level because vanilla's is: the only condition is whether
// mangrove_roots is configured, with no per-trunk-shape distinction, so
// `mangrove_roots` runs for `mega_trunk` and `fallen_trunk` exactly as it
// runs for `mangrove_trunk`.
//
// The ORDER is load-bearing:
//
//	draw the trunk height
//	place the roots
//	roots failed -> the FEATURE FAILS
//	replace the working position with the position the roots returned
//	place the trunk, handing it that same position
//
// i.e. the height draw, THEN the roots, THEN the trunk -- with the height
// already drawn when the root pass runs, and the root pass's returned position
// replacing the trunk's origin. Every caller below therefore sits immediately
// after its own height draw and before any spawn-preparation-shaped gate, and
// threads the returned origin (not ctx.Origin) through everything downstream.
// Moving a height draw to accommodate this would move the whole RNG stream and
// every feature placed after the tree in the chunk; nothing here does.
//
// A nil f.roots (mangrove_roots absent) is a pure no-op: same origin back,
// zero draws.
func (f *TreeFeature) applyRoots(ctx *wgen.PlacementContext, origin wgen.BlockPos, height int) (wgen.BlockPos, bool) {
	if f.roots == nil {
		return origin, true
	}
	relocated, ok := mangroveRootsPlace(ctx.API, origin, ctx.Random, height, f.mayGrowOn, f.roots)
	if !ok {
		LogFailure(ctx, treeTypeID, "Roots could not be placed")
		return origin, false
	}
	return relocated, true
}

// Place dispatches to the trunk implementation the JSON key selected. All
// eight trunk keys have a non-nil trunk struct, so every call returns from one
// of the branches below.
//
// The body AFTER those branches is an acacia trunk running on default values.
// It is UNREACHABLE: the bare "trunk" key binds the simple trunk
// (placeSubmergedTrunk). It is kept, not deleted, because it is this file's
// only implementation of the acacia trunk on default values and of the
// trailing direction re-roll -- but nothing reaches it, and nothing should be
// routed to it without first re-checking which trunk each JSON key selects.
// f.trunkHeight is likewise read only from here. Deleting both is a recorded
// follow-up.
func (f *TreeFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	for _, warning := range f.warnings {
		LogWarning(ctx, treeTypeID, warning, nil)
	}
	if f.fallen != nil {
		return f.placeFallenTrunk(ctx, f.fallen)
	}
	if f.poplar != nil {
		return f.placePoplarTrunk(ctx, f.poplar)
	}
	if f.shaped != nil {
		if f.shaped.kind == "mega_trunk" {
			return f.placeMegaTrunk(ctx, f.shaped)
		}
		if f.shaped.kind == "fancy_trunk" {
			return f.placeFancyTrunk(ctx, f.shaped)
		}
		return f.placeShapedTrunk(ctx, f.shaped)
	}
	if f.cherryTrunk != nil {
		return f.placeCherryTrunk(ctx, f.cherryTrunk)
	}
	if f.mangroveTrunk != nil {
		return f.placeMangroveTrunk(ctx, f.mangroveTrunk)
	}
	if f.submergedTrunk != nil {
		return f.placeSubmergedTrunk(ctx, f.submergedTrunk)
	}

	// ---- UNREACHABLE from here down; see this function's doc comment. ----

	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}

	// The acacia trunk's height draw -- extraHeightBounds is always empty
	// for a plain-int JSON trunk_height, so this draws NO RNG.
	height := f.trunkHeight

	// mangrove_roots -- see applyRoots for the order and the derivation.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}

	// Spawn preparation (simplified -- see the file header): ground must
	// match may_grow_on (or the list is empty), and the trunk must fit under
	// the build height. Both checks are zero-RNG in vanilla too, so
	// approximating their exact bound does not risk desyncing anything
	// RNG-order-sensitive.
	if origin.Y <= api.MinY() || origin.Y+height >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	if !f.mayGrowOn.Empty() {
		below := api.GetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z})
		if !f.mayGrowOn.Contains(below) {
			LogFailure(ctx, treeTypeID, "Trunk could not be placed")
			return nil
		}
	}

	// Root-flare / ground fixup -- single cell (columnWidth=1), no RNG.
	placeBaseBlock(api, wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, f.mayGrowOn, f.mayGrowOnFallback)

	// *** RNG CALL #1 *** -- main lean direction.
	direction := rnd.NextIntBound(4)
	// *** RNG CALL #2 *** -- lean_height.getValue(), SUBTRACTED FROM THE HEIGHT:
	// the lean starts `height - draw`, i.e. that many cells below the top.
	// See placeShapedTrunk's note; the same applies here because this path IS
	// an acacia trunk, just one running on default values instead of JSON.
	leanStart := height - treeIntRangeValue(leanStartRange[0], leanStartRange[1], rnd)
	// *** RNG CALL #3 *** -- leanStepsRange.getValue().
	leanStepsRemaining := treeIntRangeValue(leanStepsRange[0], leanStepsRange[1], rnd)
	// extraHeightRange is the range (0,0) -- degenerate, never draws, always
	// contributes 0.

	leanX, leanZ := origin.X, origin.Z
	var anchor wgen.BlockPos
	var candidates []wgen.BlockPos
	for i := 0; i < height; i++ {
		TickDeadline("walking a trunk column as tall as its trunk height asks")
		if i >= leanStart && leanStepsRemaining > 0 {
			leanStepsRemaining--
			leanX += leanDX[direction]
			leanZ += leanDZ[direction]
		}
		p := wgen.BlockPos{X: leanX, Y: origin.Y + i, Z: leanZ}
		if isValidTreePosition(api, p, f.mayReplace) {
			placeLog(api, p, f.trunkBlock)
			if f.trunkDecoration != nil {
				// All four horizontal directions -- the simple trunk's own
				// constant mask, not a per-cell one.
				f.trunkDecoration.place(api, p, mangroveTrunkAllDirections, rnd)
			}
			// candidates mirrors the acacia trunk's candidate-list push: it
			// fires on the EXACT SAME isValidTreePosition gate this loop already
			// uses, once per successfully-placed log (the acacia trunk's per-layer
			// "width" sub-loop is a single iteration, the same "columnWidth=1" as
			// placeBaseBlock above -- see the file header). It does not change what
			// gets placed or when RNG draws.
			candidates = append(candidates, p)
			if i >= branchCollectAfter {
				anchor = p
			}
		}
	}

	// Canopy -- placed exactly once, at the final collected anchor (see the
	// file header's "canopy anchor" note). candidates is the full log column;
	// only random_spread_canopy reads it (every other canopy ignores its
	// candidate-list parameter -- see the file header).
	f.placeCanopies(api, rnd, params, []treeCanopyAnchor{{pos: anchor, candidates: candidates}})

	// The acacia trunk's branch pass, on default values (this path has no JSON
	// trunk object to configure them from). It places nothing -- the default
	// chance value is zeroed and rolls false without drawing -- but it DOES
	// spend the unconditional nextInt(4) direction draw. Routing it through
	// placeAcaciaBranches rather than an inline re-roll means the draw and the
	// (absent) geometry can never drift apart. allow_diagonal_growth defaults
	// to TRUE, so this is the leaning path.
	placeAcaciaBranches(api, rnd, params, nil, f.trunkBlock, f.trunkDecoration, origin, anchor,
		1, height, direction, leanStart, true)

	result := origin
	return &result
}

// prepareShippedTree takes the origin explicitly rather than reading
// ctx.Origin, because mangrove_roots can have moved it: the root pass runs
// before the trunk and its return value replaces the origin (see
// applyRoots), and this gate is on the trunk side of that.
func (f *TreeFeature) prepareShippedTree(ctx *wgen.PlacementContext, origin wgen.BlockPos, height, width int) bool {
	api := ctx.API
	if origin.Y <= api.MinY() || origin.Y+height >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return false
	}
	for dx := 0; dx < width; dx++ {
		TickDeadline("filling a trunk layer as wide as its trunk_width asks")
		for dz := 0; dz < width; dz++ {
			below := wgen.BlockPos{X: origin.X + dx, Y: origin.Y - 1, Z: origin.Z + dz}
			if !f.mayGrowOn.Empty() && !f.mayGrowOn.Contains(api.GetBlock(below)) {
				LogFailure(ctx, treeTypeID, "Trunk could not be placed")
				return false
			}
			placeBaseBlock(api, below, f.mayGrowOn, f.mayGrowOnFallback)
		}
	}
	return true
}

func (f *TreeFeature) placeShapedTrunk(ctx *wgen.PlacementContext, trunk *shapedTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	height := 0
	if trunk.kind == "fancy_trunk" {
		// Same shape as placeFancyTrunk's, and for the same reason:
		// the fancy trunk's height draw is base + nextInt(variance).
		// This branch is believed DEAD -- Place dispatches fancy_trunk to
		// placeFancyTrunk before reaching here -- and it must stay dead, because the
		// prepareShippedTree call below WOULD impose a build-height guard vanilla
		// does not have on the fancy path. See placeFancyTrunk.
		height = trunk.height.base + rnd.NextIntBound(trunk.fancyVariance)
	} else {
		height = trunk.height.sample(rnd)
	}

	// mangrove_roots -- see applyRoots for the order. It sits between the
	// height draw and the spawn-preparation-shaped gate below because vanilla
	// places the roots between the height draw and the trunk, and the
	// `height < 1` guard here is on the trunk's side of that line.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}
	if height < 1 || !f.prepareShippedTree(ctx, origin, height, trunk.width) {
		return nil
	}

	// leanStart is a HEIGHT INDEX, not the drawn value: the lean_height
	// int-range draw is subtracted from the height (leanStart = height - draw),
	// so the lean begins a drawn number of cells BELOW the top, not a drawn
	// number of cells above the ground. With the default int range {1,4} and
	// height 5 the first leaning cell is at index 2..4.
	direction, leanStart, leanSteps, leanLength := 0, height+1, 0, 0
	if trunk.kind == "acacia_trunk" {
		direction = rnd.NextIntBound(4)
		leanStart = height - treeIntRangeValue(trunk.leanHeightMin, trunk.leanHeightMax, rnd)
		leanSteps = treeIntRangeValue(trunk.leanStepsMin, trunk.leanStepsMax, rnd)
		// lean_length (default {0,0} -> degenerate, zero draws, contributes 0).
		// Its ONLY effect is to extend the trunk loop past trunk_height: the draw
		// is added to the height to form the loop bound. The extra iterations
		// keep stepping x/z while leaving y frozen, because the y write is
		// guarded by `index < height` -- so lean_length grows a horizontal run
		// at the very top of the trunk.
		leanLength = treeIntRangeValue(trunk.leanLengthMin, trunk.leanLengthMax, rnd)
	}
	stemHeight := height
	if trunk.kind == "fancy_trunk" {
		stemHeight = max(1, int(float32(height)*trunk.fancyScale))
	}
	x, z := origin.X, origin.Z
	var last wgen.BlockPos
	var candidates []wgen.BlockPos
	anchored := false
	for y := 0; y < stemHeight+leanLength; y++ {
		TickDeadline("walking a trunk column as tall as its trunk height asks")
		if y >= leanStart && leanSteps > 0 {
			leanSteps--
			x += leanDX[direction]
			z += leanDZ[direction]
		}
		// y is frozen once the index passes the sampled height -- the
		// lean_length tail runs sideways, not upwards.
		cellY := origin.Y + min(y, stemHeight-1)
		for dx := 0; dx < trunk.width; dx++ {
			TickDeadline("filling a trunk layer as wide as its trunk_width asks")
			for dz := 0; dz < trunk.width; dz++ {
				p := wgen.BlockPos{X: x + dx, Y: cellY, Z: z + dz}
				if isValidTreePosition(api, p, f.mayReplace) {
					placeLog(api, p, f.trunkBlock)
					if trunk.decoration != nil {
						trunk.decoration.place(api, p, acaciaDecorationMask(dx, dz, trunk.width), rnd)
					}
					// min_height_for_canopy gates ANCHOR collection only, never
					// placement: a log joins the canopy-anchor list only once its
					// index has reached that value, while the block itself is placed
					// regardless.
					if y >= trunk.minHeightForCanopy {
						candidates = append(candidates, p)
						last = p
						anchored = true
					}
				}
			}
		}
	}
	// Vanilla starts the anchor at a ZEROED position and only overwrites it
	// from the last list entry when the list is non-empty. A trunk too short
	// to clear min_height_for_canopy therefore hands the canopy {0,0,0} --
	// effectively nowhere, since a bench origin is never world zero.
	// Reproduced rather than smoothed over, because "short trunk grows no
	// canopy" is the observable vanilla behaviour.
	anchor := wgen.BlockPos{}
	if trunk.kind != "acacia_trunk" {
		anchor = wgen.BlockPos{X: x, Y: origin.Y + stemHeight - 1, Z: z}
	}
	if anchored {
		anchor = wgen.BlockPos{X: last.X, Y: last.Y, Z: last.Z}
	}
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}
	f.placeCanopies(api, rnd, params, []treeCanopyAnchor{{pos: anchor, candidates: candidates}})
	if trunk.kind == "acacia_trunk" {
		placeAcaciaBranches(api, rnd, params, trunk.acaciaBranches, f.trunkBlock, trunk.decoration,
			origin, anchor, trunk.width, height, direction, leanStart, trunk.allowDiagonal)
	}
	result := origin
	return &result
}

// baseCluster models the top-level "base_cluster" object -- an OPTIONAL
// object of the shared tree parameters whose three children are ALL required
// once base_cluster itself is present:
//
//   - may_replace: an array of block descriptors (required), the same key
//     name as the top-level may_replace field. The base-cluster placement does
//     nothing when this list is empty, and the single-position base-block
//     replacement uses its first descriptor as the target block.
//   - num_clusters: a plain int (required) -- NOT an int range: no
//     per-generation draw and no [min,max] shorthand.
//   - cluster_radius: a plain int (required), same shape as num_clusters,
//     used as the radius of the circle form of the base-block replacement
//     (again with no int-range draw).
//
// Because num_clusters and cluster_radius are plain single-value JSON
// integers, this port accepts them as plain numbers (parseTreeIntRange is NOT
// used here).
//
// The FOURTH quantity the base-cluster placement needs -- the "reach" used to
// position its four fixed corner circles -- is NOT part of base_cluster. It is
// the mega trunk's trunk_width (base_cluster is only placed by the mega trunk,
// which also uses trunk_width as the footprint when it stamps the
// update/persistent bits under the whole trunk). This is the SAME value
// placeMegaTrunk already threads through as trunk.width -- base_cluster does
// not introduce a second, independent "reach".
//
// Draw sequence:
//
//  1. Mega-trunk-side gate: if num_clusters<=0, the base-cluster placement
//     does not run at all. ZERO draws, and this also skips the four fixed
//     corners, which would otherwise fire unconditionally.
//  2. The base-cluster placement's own gate: may_replace must be non-empty.
//     If empty, immediate return. ZERO draws.
//  3. Four FIXED corner circle replacements, unconditional, at
//     {-1,-1}/{reach,-1}/{-1,reach}/{reach,reach} (X,Z offsets from pos), in
//     that exact order. ZERO draws -- neither replacement form uses the RNG.
//  4. Exactly num_clusters iterations, each drawing `rnd.NextIntBound(64)` --
//     ALWAYS drawn, even when its result is discarded. Each draw r is
//     decomposed as qx,rem := r/8, r%8 (r in [0,64), so ordinary truncating
//     division/modulo). The circle replacement runs at offset {rem-3, qx-3}
//     ONLY when qx or rem sits on the border of this FIXED 8x8 grid
//     (qx==0||qx==7||rem==0||rem==7) -- i.e. the interior cells are excluded
//     on top of the corner-clipping the circle replacement already does at
//     ITS OWN radius. The 8x8 window (offset -3) is fixed, independent of
//     cluster_radius and of reach.
//
// pos (the base-cluster origin) is the trunk's origin with Y decremented by
// exactly 1: one layer of ground beneath the trunk's first log, matching
// "ground clusters" as a concept.
//
// Ordering within placeMegaTrunk: base_cluster runs immediately after the
// per-log trunk_decoration loop (the loop placeLog/trunk.decoration.place
// already model) and before a final, zero-RNG double loop that normalizes the
// update/persistent bits under the whole footprint -- not modelled
// separately, since this codebase's block-state layer already keeps those
// flags consistent. This port places base_cluster AFTER f.placeCanopies; the
// canopy's draws come before base_cluster's either way, so appending
// base_cluster last preserves the correct relative order.
type baseCluster struct {
	mayReplace block.MatchSet
	// mayReplaceFallback is the single-position replacement's PRODUCING target block --
	// may_replace's first descriptor, resolved to one concrete block, the
	// SAME "first descriptor as fallback" convention this file already uses
	// for may_grow_on/base_block (see buildTreeFeature). Only meaningful
	// when !mayReplace.Empty(), which every caller already guarantees.
	mayReplaceFallback block.ID
	numClusters        int
	clusterRadius      int
}

// parseBaseCluster parses the top-level "base_cluster" object -- see
// baseCluster's own doc comment for the schema (all three
// children required once the object itself is present).
func parseBaseCluster(raw any, ctx *BuildContext) (*baseCluster, error) {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("base_cluster must be an object")
	}
	if _, present := obj["may_replace"]; !present {
		return nil, fmt.Errorf("base_cluster.may_replace is required")
	}
	descs, err := AsBlockDescriptorList(obj["may_replace"], "base_cluster.may_replace")
	if err != nil {
		return nil, err
	}
	bc := &baseCluster{mayReplace: ResolveMatchSet(descs, ctx, "base_cluster.may_replace")}
	if len(descs) > 0 {
		bc.mayReplaceFallback = ctx.Palette.Resolve(descs[0])
	}
	numClustersF, ok := obj["num_clusters"].(float64)
	if !ok {
		return nil, fmt.Errorf("base_cluster.num_clusters is required and must be a number")
	}
	bc.numClusters = int(numClustersF)
	clusterRadiusF, ok := obj["cluster_radius"].(float64)
	if !ok {
		return nil, fmt.Errorf("base_cluster.cluster_radius is required and must be a number")
	}
	bc.clusterRadius = int(clusterRadiusF)
	return bc, nil
}

// replaceBaseBlockAt mirrors the single-position form of the tree
// parameters' own base-block replacement -- deterministic, ZERO RNG.
// Scans dy = +2,+1,0,-1,-2,-3 (six candidate Y offsets from pos.Y, in that
// order): for each probe, if the existing block already equals the target
// block's type, the ENTIRE scan stops immediately (treated as already
// satisfied); otherwise,
// if the existing block passes may_replace's own allow-list, the target
// block is placed there and the scan stops; otherwise the scan continues
// to the next dy. If no probe qualifies, nothing is placed.
func replaceBaseBlockAt(api wgen.BlockWorld, pos wgen.BlockPos, mayReplace block.MatchSet, target block.ID) {
	for _, dy := range [...]int{2, 1, 0, -1, -2, -3} {
		p := wgen.BlockPos{X: pos.X, Y: pos.Y + dy, Z: pos.Z}
		existing := api.GetBlock(p)
		if existing == target {
			return
		}
		if mayReplace.Contains(existing) {
			api.SetBlock(p, target)
			return
		}
	}
}

// replaceBaseBlockCircle mirrors the circle form of the tree parameters'
// own base-block replacement -- deterministic, ZERO RNG.
// Iterates dx,dz over [-radius,radius]x[-radius,radius] and calls
// replaceBaseBlockAt for every cell EXCEPT the four exact corners
// (|dx|==radius && |dz|==radius), producing a square-with-clipped-corners
// footprint. radius==0 degenerates to NO placements at all: the single
// (0,0) cell has |0|==radius==0 on both axes, so it IS the (degenerate)
// corner and gets skipped. radius<0 is 0 iterations.
func replaceBaseBlockCircle(api wgen.BlockWorld, center wgen.BlockPos, radius int, mayReplace block.MatchSet, target block.ID) {
	if radius < 0 {
		return
	}
	for dx := -radius; dx <= radius; dx++ {
		TickDeadline("replacing the ground circle its base_cluster cluster_radius asks for")
		for dz := -radius; dz <= radius; dz++ {
			if abs(dx) == radius && abs(dz) == radius {
				continue
			}
			replaceBaseBlockAt(api, wgen.BlockPos{X: center.X + dx, Y: center.Y, Z: center.Z + dz}, mayReplace, target)
		}
	}
}

// placeBaseClusterGroundwork mirrors the tree parameters' own base-cluster
// placement plus the mega trunk's pre-check before it -- see baseCluster's
// own doc comment for the schema and draw sequence. origin is the trunk's
// own origin -- this function works one block below it, at
// `{x, y-1, z}`. reach is the mega trunk's own trunk_width.
func placeBaseClusterGroundwork(api wgen.BlockWorld, origin wgen.BlockPos, reach int, rnd random.IRandom, bc *baseCluster) {
	if bc == nil || bc.numClusters <= 0 {
		return
	}
	if bc.mayReplace.Empty() {
		return
	}
	pos := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	replaceBaseBlockCircle(api, wgen.BlockPos{X: pos.X - 1, Y: pos.Y, Z: pos.Z - 1}, bc.clusterRadius, bc.mayReplace, bc.mayReplaceFallback)
	replaceBaseBlockCircle(api, wgen.BlockPos{X: pos.X + reach, Y: pos.Y, Z: pos.Z - 1}, bc.clusterRadius, bc.mayReplace, bc.mayReplaceFallback)
	replaceBaseBlockCircle(api, wgen.BlockPos{X: pos.X - 1, Y: pos.Y, Z: pos.Z + reach}, bc.clusterRadius, bc.mayReplace, bc.mayReplaceFallback)
	replaceBaseBlockCircle(api, wgen.BlockPos{X: pos.X + reach, Y: pos.Y, Z: pos.Z + reach}, bc.clusterRadius, bc.mayReplace, bc.mayReplaceFallback)
	for i := 0; i < bc.numClusters; i++ {
		TickDeadline("placing the base clusters its num_clusters asks for")
		r := rnd.NextIntBound(64) // *** RNG CALL, ALWAYS drawn ***
		qx, rem := r/8, r%8
		if qx == 0 || qx == 7 || rem == 0 || rem == 7 {
			replaceBaseBlockCircle(api, wgen.BlockPos{X: pos.X + rem - 3, Y: pos.Y, Z: pos.Z + qx - 3}, bc.clusterRadius, bc.mayReplace, bc.mayReplaceFallback)
		}
	}
}

// placeMegaTrunk mirrors the mega trunk's placement for the
// portion this port models: branches (see megaBranches.place), the
// TOP-LAYER of the trunk column (no decoration -- see megaTrunkDecoration's
// own doc comment for why), and the LOWER layers (with trunk_decoration
// applied per log). Split out from placeShapedTrunk -- which acacia_trunk
// and fancy_trunk still share unchanged -- because the mega trunk's own
// structure (branches placed BEFORE the column; the column itself split
// top-layer-then-rest; per-log decoration) is genuinely different, not a
// stylistic preference; see the file header's mega_trunk notes.
func (f *TreeFeature) placeMegaTrunk(ctx *wgen.PlacementContext, trunk *shapedTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	height := trunk.height.sample(rnd)

	// mangrove_roots -- see applyRoots for the order and the derivation.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}
	if height < 1 || !f.prepareShippedTree(ctx, origin, height, trunk.width) {
		return nil
	}

	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}

	// TOP CANOPY FIRST -- before the branches and before a single trunk log.
	//
	// This is the one ordering in this file that looks wrong and is right. Every
	// other trunk shape here places its geometry and then calls f.placeCanopies;
	// the mega trunk, straight after the spawn preparation succeeds, places its
	// canopy (when configured) before the branch gate and before any column loop.
	//
	// Two things follow, and both move blocks:
	//
	//   - ORDER. Every draw the top canopy makes (mega_canopy's canopy_height
	//     draw, and whatever any other canopy type used here draws) comes
	//     BEFORE every branch draw and every trunk_decoration draw. Placing the
	//     canopy last would keep the draw COUNT but shift the stream order, so
	//     everything downstream of the first branch would move.
	//   - ANCHOR. The anchor is {origin.x, origin.y + height, origin.z} --
	//     the cell ABOVE the top log, on the origin column -- not the last
	//     top-layer log placed. For mega_canopy's `dy = (1-value)..0` layering,
	//     the latter would shift the whole canopy down one block, and sideways
	//     too at the default trunk_width of 2.
	//
	// The candidate list handed to the canopy is EMPTY (as is the parallel
	// branch-size list). So nil here is not a shortcut -- the game genuinely
	// gives its top canopy no candidates, which is why this function collects
	// none. The canopy's result feeds only the trunk placement's own return
	// position and cannot fail the tree.
	f.placeCanopies(api, rnd, params, []treeCanopyAnchor{{
		pos:        wgen.BlockPos{X: origin.X, Y: origin.Y + height, Z: origin.Z},
		candidates: nil,
	}})

	// Branches, with their own (inline, per-branch) branch_canopy calls. No-op
	// (zero RNG) when trunk.branches is nil (trunk_decoration/branches both
	// absent) or trunk.branches.length < 1 -- that gate sits before the first
	// branch_interval draw on both paths, so a sub-1 branch_length costs
	// nothing.
	if trunk.branches != nil {
		trunk.branches.place(api, origin, rnd, height, params, f.trunkBlock)
	}

	// The column is THREE shapes, not two.
	// Bottom layer, then the middle layers, then a single top cell -- a
	// width x width top LAYER plus decorating everything below it would be
	// wrong at both ends.

	// 1. y = 0: width x width, and NO decoration at all. Decorating y = 0
	//    would add up to width^2 surplus decoration rolls per tree -- each a
	//    real draw whenever trunk_decoration is configured, offsetting the
	//    stream from the first middle-layer log onwards.
	for dx := 0; dx < trunk.width; dx++ {
		TickDeadline("filling a trunk layer as wide as its trunk_width asks")
		for dz := 0; dz < trunk.width; dz++ {
			p := wgen.BlockPos{X: origin.X + dx, Y: origin.Y, Z: origin.Z + dz}
			if isValidTreePosition(api, p, f.mayReplace) {
				placeLog(api, p, f.trunkBlock)
			}
		}
	}

	// 2. y = 1 .. height-2: width x width WITH trunk_decoration, mask derived
	//    from the log's own local (dx,dz). The loop
	//    exits when ++y reaches height-1, and is skipped entirely when
	//    height-1 == 1, which this loop's own bound reproduces: at height 2 it
	//    runs zero times, giving bottom layer plus top cell.
	for y := 1; y < height-1; y++ {
		TickDeadline("walking a trunk column as tall as its trunk height asks")
		for dx := 0; dx < trunk.width; dx++ {
			TickDeadline("filling a trunk layer as wide as its trunk_width asks")
			for dz := 0; dz < trunk.width; dz++ {
				p := wgen.BlockPos{X: origin.X + dx, Y: origin.Y + y, Z: origin.Z + dz}
				if !isValidTreePosition(api, p, f.mayReplace) {
					continue
				}
				placeLog(api, p, f.trunkBlock)
				if trunk.decoration != nil {
					// The same guarded mask acacia uses: the -X direction only when
					// dx == 0, else the +X direction only when dx == width-1. An unguarded
					// form differs only at trunk_width 1, where dx == 0 and dx == width-1
					// are the same cell: the game enables ONE direction there, not two.
					// mega_trunk's own width default is 2, so typical trees never reach it.
					trunk.decoration.place(api, p, acaciaDecorationMask(dx, dz, trunk.width), rnd)
				}
			}
		}
	}

	// 3. The top is exactly ONE cell, on the origin column, not a width x width
	//    layer: {origin.x, origin.y + height - 1, origin.z}, gated by the
	//    placement allow-list check and then written. At the default
	//    trunk_width of 2 a full layer would be four logs where the game
	//    writes one.
	//
	//    The game follows that write with a decoration step whose direction
	//    mask is all ZERO. It is not reproduced here because it is a
	//    provable no-op: megaTrunkDecoration.place skips every direction whose
	//    mask bit is clear before it can draw or write, so an all-false mask does
	//    nothing at all. (Mega's BRANCH logs get no decoration either -- they
	//    are plain block writes in the branch step loop.)
	top := wgen.BlockPos{X: origin.X, Y: origin.Y + height - 1, Z: origin.Z}
	if isValidTreePosition(api, top, f.mayReplace) {
		placeLog(api, top, f.trunkBlock)
	}

	// base_cluster -- mega-trunk-specific ground clusters, placed LAST;
	// see placeBaseClusterGroundwork and baseCluster's doc comments for
	// the schema and draw sequence.
	placeBaseClusterGroundwork(api, origin, trunk.width, rnd, f.baseCluster)

	result := origin
	return &result
}

// placeMangroveTrunk mirrors the mangrove trunk's placement end
// to end -- see mangroveTrunk's own doc comment for the details, including
// the unconditional coin flip this port must preserve, and
// mangroveTrunkBranch for the branch placement.
// Wired the SAME way TreeFeature.Place wires the acacia trunk and
// placeSubmergedTrunk: mangrove_roots relocates the origin first (a real
// failure aborts the whole tree), then the shared spawn-preparation-equivalent
// bounds/ground-fixup preamble, a straight vertical column (NO lean -- the
// column's X and Z never change, unlike the acacia trunk's own leanX/leanZ),
// and one canopy call at the final top anchor.
func (f *TreeFeature) placeMangroveTrunk(ctx *wgen.PlacementContext, t *mangroveTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}

	// *** RNG CALLS *** -- the mangrove trunk's height draw, see its own doc
	// comment for the exact draw order.
	height := t.getTreeHeight(rnd)

	// mangrove_roots -- see applyRoots for the order and the derivation.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}
	if origin.Y <= api.MinY() || origin.Y+height >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	if !f.mayGrowOn.Empty() {
		below := api.GetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z})
		if !f.mayGrowOn.Contains(below) {
			LogFailure(ctx, treeTypeID, "Trunk could not be placed")
			return nil
		}
	}
	placeBaseBlock(api, wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, f.mayGrowOn, f.mayGrowOnFallback)

	var candidates []wgen.BlockPos
	anchor := origin
	if height > 0 {
		// The mangrove trunk's own `height > 0` guard
		// -- height<=0 never happens for
		// any JSON this port accepts (trunk_height.base/height_rand_a/
		// height_rand_b are all required, non-negative fields -- see
		// buildTreeFeature), ported as a guard rather than assumed, this
		// file's own established style.
		for i := 0; i < height; i++ {
			TickDeadline("walking a trunk column as tall as its trunk height asks")
			p := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
			if isValidTreePosition(api, p, f.mayReplace) {
				// api.SetBlock's own success bool genuinely gates what
				// follows --
				// unlike this file's other trunk columns, this shape does
				// NOT use the void placeLog helper here.
				if api.SetBlock(p, t.trunkBlock) {
					if t.decoration != nil {
						t.decoration.place(api, p, mangroveTrunkAllDirections, rnd)
					}
					if i < height-1 {
						// *** RNG CALL *** -- a boolean draw, made
						// UNCONDITIONALLY for every non-final successfully-
						// placed log, regardless of whether "branches"
						// appears in the JSON at all -- see mangroveTrunk's
						// own doc comment, "The coin flip". This is the
						// single most load-bearing line in this port: making
						// it conditional on t.branchLengthMax>0 (or any
						// other "branches configured" signal) would silently
						// desync the RNG stream for every mangrove_trunk
						// JSON that omits "branches", which is entirely
						// legal.
						if rnd.NextBoolean() {
							// *** RNG CALL *** -- a random horizontal face draw.
							facing := 2 + rnd.NextIntBound(4)
							// *** RNG CALLS *** -- branch_length drawn TWICE,
							// branch_steps drawn ONCE, in this exact order.
							draw1 := treeIntRangeValueInclusive(t.branchLengthMin, t.branchLengthMax, rnd)
							draw2 := treeIntRangeValueInclusive(t.branchLengthMin, t.branchLengthMax, rnd)
							steps := treeIntRangeValueInclusive(t.branchStepsMin, t.branchStepsMax, rnd)
							start := draw1 - draw2 - 1
							if start < 0 {
								start = 0
							}
							mangroveTrunkBranch(api, rnd, f.mayReplace, p, origin.Y+i, height, facing, start, steps, t.trunkBlock, t.decoration, &candidates)
						}
					}
				}
			}
			if i == height-1 {
				// Unconditional, regardless of whether THIS iteration's own
				// isValidTreePosition/SetBlock succeeded -- the push is not
				// nested inside the success branch above.
				anchor = wgen.BlockPos{X: origin.X, Y: origin.Y + i + 1, Z: origin.Z}
				candidates = append(candidates, anchor)
			}
		}
	}

	f.placeCanopies(api, rnd, params, []treeCanopyAnchor{{pos: anchor, candidates: candidates}})

	result := origin
	return &result
}

// placeFallenTrunk places the fallen trunk's own diagonal log line plus vertical stump. Two
// attachable-decoration-backed fields:
//
//   - trunk_decoration decorates the STUMP column only (the stump's own
//     decorated-block write, with the all-four-directions mask -- gated
//     first on the placement allow-list check against may_replace, same as this
//     port's own isValidTreePosition already models) -- reuses
//     placeDecoratedBlock/megaTrunkDecoration exactly like mangrove_roots' own
//     above_root branch.
//
//   - log_decoration_feature (a weak feature reference -- see
//     fallenTrunk's own doc comment) delegates into ANOTHER registered feature ONCE PER LOG
//     placed along the diagonal line (NEVER for the stump), at that log's own
//     position. It is an ordinary feature placement, the same kind of delegation the
//     canopy, trunk, mangrove roots and rect-layout features use elsewhere in this
//     codebase (see coverage.go's minecraft:rect_layout entry) -- so this port uses
//     ctx.WithOrigin(p) + target.Place(subCtx), the SAME abstraction every other
//     delegation site in this package already uses.
//
//     ONE DIVERGENCE FROM THIS PACKAGE'S USUAL DELEGATION PATTERN: every OTHER delegating
//     feature in this package (aggregate_feature/sequence_feature/conditional_list/
//     scan_surface/scatter/search_feature/snap_to_surface/surface_relative_threshold/
//     vegetation_patch/weighted_random) gates its delegated placement behind the
//     feature-permission gate. The fallen trunk's log_decoration_feature is NOT gated in
//     vanilla -- it fires unconditionally whenever the weak reference resolves to a live
//     feature. This port preserves that: no IsAllowedToPlaceFeature check here. It DOES
//     still wrap the call in WithRecursionGuard, purely for this port's own budget/profiler
//     bookkeeping (a safety net against a pathological circular reference crashing the Go
//     process with a stack overflow, not a mirror of game behaviour) -- zero-cost and
//     zero-behavior-change for any acyclic reference, i.e. every real pack.
//
// fallenPassable is the per-cell "may the fallen log occupy / drop through
// this cell" test of the fallen-log placement (used for both the descend
// probe and the validity walk): an empty cell passes, and -- in newer game
// versions -- a non-empty cell also passes when the world reports it as
// buildable-over (older versions accepted only empty cells). The intent is
// letting a fallen trunk replace leaf litter.
//
// That buildable-over test is per block type and this port has no
// registry for it; it is approximated here by an explicit name set of the
// vanilla "replaceable" blocks that plausibly occupy worldgen ground level
// (leaf litter and the small replaceable plants/snow). The empty-block test is the
// established IsAir approximation.
var fallenBuiltOverNames = map[string]struct{}{
	"minecraft:leaf_litter": {},
	"minecraft:short_grass": {},
	"minecraft:grass":       {},
	"minecraft:tall_grass":  {},
	"minecraft:fern":        {},
	"minecraft:large_fern":  {},
	"minecraft:deadbush":    {},
	"minecraft:dead_bush":   {},
	"minecraft:snow_layer":  {},
}

func fallenPassable(api wgen.BlockWorld, p wgen.BlockPos) bool {
	existing := api.GetBlock(p)
	if api.Palette().IsAir(existing) {
		return true
	}
	_, ok := fallenBuiltOverNames[api.Palette().NameOf(existing)]
	return ok
}

// placeFallenTrunk mirrors the tree feature's height-draw step plus the
// fallen trunk's placement. Apart from the fallenPassable buildable-over
// tolerance above, older and newer game versions behave identically. Easy
// things to get wrong, all of which vanilla does NOT do: placing the log flat
// at origin.Y (it descends to the ground), skipping the validity pre-walk
// (placement is all-or-nothing), gating each log cell on isValidTreePosition
// (the log write is UNCONDITIONAL), gating the log_decoration_feature hook on
// the cell having been placed, using a rotated direction table, and returning
// the origin instead of the stump result.
//
// Fields: log_length REQUIRED, height_modifier optional {0,0}, stump_height
// optional {1,1}, trunk_block REQUIRED, log_decoration_feature optional,
// trunk_decoration optional. Its height draw is the int-range draw over
// log_length.
//
// Draw sequence, exact:
//
//  1. log_length      -- the tree's height draw, an int-range draw.
//  2. (a spawn-preparation failure aborts HERE -- draw 1 already spent.)
//  3. height_modifier -- an int-range draw.
//  4. direction       -- NextIntBound(4); facing = draw+2
//     indexing the per-face offset table (north/south/west/east).
//  5. start offset    -- NextIntBound(2)+2.
//  6. stump_height    -- an int-range draw.
//  7. per stump layer passing the may_replace gate: trunk_decoration rolls.
//
// The fallen-log placement, logLen = log_length + height_modifier - 2:
//
//   - descend: y starts at start.y + stump_height and drops while
//     y > the world's minimum height and the cell BELOW is fallenPassable.
//   - validity walk over all logLen cells from the rest position along the
//     direction vector: every cell must be fallenPassable, and a cell whose
//     below-block fails the block's solid-blocking predicate increments a
//     consecutive-unsupported counter -- the THIRD consecutive unsupported
//     cell fails the walk.
//     ALL-OR-NOTHING: any failure places no log at all, though the stump
//     below still runs.
//   - placement: the ORIENTED log (rotated for the facing -- pillar_axis x for
//     west/east, z for north/south, the same build-time resolution this
//     port already uses), placed UNCONDITIONALLY (a plain single-block
//     write, no allowlist), with the
//     log_decoration_feature hook invoked per cell AFTER the block write,
//     when configured.
//
// The stump placement: for i in 0..stump_height-1, gate on the
// placement allow-list check at pos+(0,i,0) against may_replace
// (normalized -- poplarPassesAllowList), then the
// decorated-block write with trunk_decoration and the all-four
// mask; then the base-block write below the origin against
// base_block. The RETURN is the LAST GATED stump cell's
// decorated-block result, and the placement returns it with
// y+1 when engaged -- so a fallen tree whose stump
// placed nothing returns FAILURE even when the log itself placed.
func (f *TreeFeature) placeFallenTrunk(ctx *wgen.PlacementContext, trunk *fallenTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	// *** RNG CALL #1 *** -- the height draw = log_length.getValue.
	length := treeIntRangeValue(trunk.logMin, trunk.logMax, rnd)

	// mangrove_roots -- see applyRoots for the order and the derivation.
	// The root placement receives whatever the height draw
	// returned, which for the fallen trunk is log_length, not a vertical
	// extent.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, length); !rootsOK {
		return nil
	}

	// The spawn preparation (api, pos, log_length draw, may_grow_on,
	// may_grow_through) -- the established approximation.
	if origin.Y <= api.MinY() || origin.Y+length >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	if !f.mayGrowOn.Empty() {
		below := api.GetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z})
		if !f.mayGrowOn.Contains(below) {
			LogFailure(ctx, treeTypeID, "Trunk could not be placed")
			return nil
		}
	}

	// *** RNG CALL #2 *** -- height_modifier.getValue.
	modifier := treeIntRangeValue(trunk.heightMin, trunk.heightMax, rnd)
	// *** RNG CALL #3 *** -- direction; facing = draw+2 (north/south/west/east).
	facing := rnd.NextIntBound(4) + 2
	// *** RNG CALL #4 *** -- start offset, NextIntBound(2)+2.
	startOffset := rnd.NextIntBound(2) + 2
	logLen := length + modifier - 2
	// *** RNG CALL #5 *** -- stump_height.getValue.
	stumpHeight := treeIntRangeValue(trunk.stumpMin, trunk.stumpMax, rnd)

	dx, dz := poplarFacingStepX[facing], poplarFacingStepZ[facing]
	start := wgen.BlockPos{X: origin.X + dx*startOffset, Y: origin.Y, Z: origin.Z + dz*startOffset}

	// ---- the fallen-log placement ----
	// Descend from start.y + stump_height to the resting level.
	y := start.Y + stumpHeight
	for y > api.MinY() && fallenPassable(api, wgen.BlockPos{X: start.X, Y: y - 1, Z: start.Z}) {
		y--
	}
	if logLen >= 1 {
		// Validity walk -- all-or-nothing.
		ok := true
		unsupported := 0
		cur := wgen.BlockPos{X: start.X, Y: y, Z: start.Z}
		for i := 0; i < logLen; i++ {
			TickDeadline("walking a fallen log as long as its length asks")
			if !fallenPassable(api, cur) {
				ok = false
			}
			belowBlk := api.GetBlock(wgen.BlockPos{X: cur.X, Y: cur.Y - 1, Z: cur.Z})
			if api.Palette().IsSolid(belowBlk) {
				unsupported = 0
			} else {
				if unsupported >= 2 {
					ok = false
				}
				unsupported++
			}
			cur.X += dx
			cur.Z += dz
		}
		if ok {
			oriented := trunk.logZ
			if dx != 0 {
				oriented = trunk.logX
			}
			var logDecoration wgen.IFeature
			if trunk.logDecorationRef != "" && trunk.logDecorationResolver != nil {
				logDecoration = trunk.logDecorationResolver.Resolve(trunk.logDecorationRef)
			}
			cur = wgen.BlockPos{X: start.X, Y: y, Z: start.Z}
			for i := 0; i < logLen; i++ {
				TickDeadline("walking a fallen log as long as its length asks")
				// Plain single-block write -- UNCONDITIONAL, no allowlist.
				api.SetBlock(cur, oriented)
				if logDecoration != nil {
					p := cur
					WithRecursionGuard(f, func() *wgen.BlockPos { return logDecoration.Place(ctx.WithOrigin(p)) })
				}
				cur.X += dx
				cur.Z += dz
			}
		}
	}

	// ---- the stump placement ----
	var lastStub *wgen.BlockPos
	for i := 0; i < stumpHeight; i++ {
		TickDeadline("building a stump as tall as its stump_height asks")
		p := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
		if poplarPassesAllowList(api, trunk.pal, p, f.mayReplace) {
			// *** RNG CALLS (trunk_decoration, 0 when unconfigured) ***
			if placeDecoratedBlock(api, p, rnd, f.trunkBlock, trunk.decoration, mangroveTrunkAllDirections) {
				pp := p
				lastStub = &pp
			} else {
				lastStub = nil
			}
		}
	}
	// The base-block write, below the origin, against base_block.
	placeBaseBlock(api, wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, f.baseBlock, f.baseBlockFallback)

	if lastStub == nil {
		// No stump cell placed -- the whole feature reports failure, as in
		// vanilla.
		return nil
	}
	result := wgen.BlockPos{X: lastStub.X, Y: lastStub.Y + 1, Z: lastStub.Z}
	return &result
}

// placePoplarTrunk mirrors the tree feature's height-draw step plus
// the poplar trunk's placement (see the Poplar section above). Draw sequence,
// exact:
//
//  1. height    -- the height draw = the int-range draw over trunk_height
//     (the EXCLUSIVE-max formula: {7,9} yields 7..8).
//  2. remaining -- the inclusive int-range draw over
//     remaining_trunk_height_above_branches
//     (default {4,4} is degenerate: ZERO draws).
//  3. per trunk log placed: trunk_decoration rolls (0 when unconfigured), and
//     log_decoration_feature's own placement draws (0 when unconfigured) --
//     the feature hook fires for EVERY column cell, NOT gated on the log
//     having been placed (both the placed and the allowlist-rejected cell
//     reach it).
//  4. shuffled directions -- 3x NextIntBound (bounds 2,3,4) shuffling the
//     horizontal direction list, see treeShuffledHorizontalDirections.
//  5. branch count -- the inclusive int-range draw over
//     amount_of_foliage_support_branches
//     (default {1,4}: ONE draw).
//  6. per branch placed: trunk_decoration rolls again.
//  7. the canopy's own draws (see poplarCanopy.place).
//
// Structure:
//
//   - the spawn preparation (api, pos, height, may_grow_on,
//     may_grow_through), then the max-build-height
//     check (fail when pos.y >=
//     maxHeight - height - 1). Both approximated with
//     this file's established spawn-preparation shape (MinY/MaxY bounds +
//     may_grow_on-below), the same one every other trunk here uses.
//   - the base fixup: if the block BELOW fails the allow-list check against
//     base_block it is overwritten with base_block[0]. An
//     empty base_block list passes vacuously -- no fixup.
//   - trunk column: for i in 0..height-1, gate on the allow-list check at
//     pos+(0,i,0) against may_replace (the normalized form -- see
//     poplarPassesAllowList), place trunk_block, then trunk_decoration with
//     the all-four-horizontals mask, then
//     the ungated log_decoration_feature hook (step 3 above).
//   - branch pass: topPos = pos + (0, height-remaining-1, 0);
//     shuffled directions; count branches; for each direction d
//     (consumed IN ORDER from the shuffled list -- vanilla behaviour for
//     count > 4 is undefined; this port stops at 4):
//     branchPos is topPos's one-step neighbour in d; block = trunk_block with
//     pillar_axis z for north/south, x for west/east;
//     gate on the same may_replace allowlist; place + trunk_decoration.
//   - canopy: invoked once at pos + (0, height-remaining, 0) with the
//     hardcoded branch size {1,1} and a fresh empty candidate list.
//   - returns the ORIGINAL origin with the success flag.
func (f *TreeFeature) placePoplarTrunk(ctx *wgen.PlacementContext, t *poplarTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}
	pal := t.pal

	// *** RNG CALL #1 *** -- the height draw (an int-range draw, EXCLUSIVE max).
	height := treeIntRangeValue(t.heightMin, t.heightMax, rnd)

	// mangrove_roots -- see applyRoots for the order and the derivation.
	// The root pass reuses the tree's OVERALL may_grow_on (mangroveRootsPlace's
	// own note), not this trunk's separate base_block list, because roots
	// get the feature-level tree parameters the same way for every shape.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}

	// Spawn preparation + max-build-height, this file's established approximation.
	if origin.Y <= api.MinY() || origin.Y+height >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	below := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	if !f.mayGrowOn.Empty() && !f.mayGrowOn.Contains(api.GetBlock(below)) {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}

	// base_block ground fixup -- the placement allow-list check
	// against base_block, placing base_block[0] on failure;
	// an empty list passes vacuously -- no fixup.
	if !poplarPassesAllowList(api, pal, below, f.baseBlock) {
		api.SetBlock(below, f.baseBlockFallback)
	}

	// *** RNG CALL #2 (0 or 1 draw) *** -- remaining_trunk_height_above_branches,
	// an inclusive int-range draw; the {4,4} default is degenerate and draws nothing.
	remaining := treeIntRangeValueInclusive(t.remainingMin, t.remainingMax, rnd)

	var logDecoration wgen.IFeature
	if t.logDecorationRef != "" && t.logDecorationResolver != nil {
		logDecoration = t.logDecorationResolver.Resolve(t.logDecorationRef)
	}

	// Trunk column.
	for i := 0; i < height; i++ {
		TickDeadline("walking a trunk column as tall as its trunk height asks")
		p := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
		if poplarPassesAllowList(api, pal, p, f.mayReplace) {
			// *** RNG CALLS (trunk_decoration, 0 when unconfigured) ***
			placeDecoratedBlock(api, p, rnd, t.trunkBlock, t.decoration, mangroveTrunkAllDirections)
		}
		// log_decoration_feature -- fires for EVERY column cell, placed or
		// not (see doc comment, step 3).
		if logDecoration != nil {
			WithRecursionGuard(f, func() *wgen.BlockPos { return logDecoration.Place(ctx.WithOrigin(p)) })
		}
	}

	// Branch pass.
	topPos := wgen.BlockPos{X: origin.X, Y: origin.Y + height - remaining - 1, Z: origin.Z}
	// *** RNG CALLS #3-#5 *** -- the three shuffle draws.
	dirs := treeShuffledHorizontalDirections(rnd)
	// *** RNG CALL #6 (0 or 1 draw) *** -- amount_of_foliage_support_branches.
	count := treeIntRangeValueInclusive(t.foliageMin, t.foliageMax, rnd)
	if count > 4 {
		// More than four branches has undefined behaviour in vanilla --
		// this port stops at the four real directions instead.
		count = 4
	}
	for j := 0; j < count; j++ {
		d := dirs[j]
		branchPos := wgen.BlockPos{X: topPos.X + poplarFacingStepX[d], Y: topPos.Y, Z: topPos.Z + poplarFacingStepZ[d]}
		branchBlock := t.branchX
		if d == 2 || d == 3 { // north/south -> pillar_axis z
			branchBlock = t.branchZ
		}
		if poplarPassesAllowList(api, pal, branchPos, f.mayReplace) {
			// *** RNG CALLS (trunk_decoration, 0 when unconfigured) ***
			placeDecoratedBlock(api, branchPos, rnd, branchBlock, t.decoration, mangroveTrunkAllDirections)
		}
	}

	// Canopy, once, at the branch layer + 1, with a fresh empty candidate
	// list.
	anchor := wgen.BlockPos{X: origin.X, Y: origin.Y + height - remaining, Z: origin.Z}
	f.placeCanopies(api, rnd, params, []treeCanopyAnchor{{pos: anchor, candidates: nil}})

	result := origin
	return &result
}

// cherryTrunk models the cherry trunk. Its vanilla defaults
// are retained here even though the schema requires the
// enclosing trunk_height/branches objects: base=5, empty intervals and
// weights, horizontal={2,4}, start={-4,-3}, end={-1,0}.
type cherryTrunk struct {
	trunkBlock, branchXBlock, branchZBlock block.ID
	baseHeight                             int
	heightIntervals                        []int
	oneBranchWeight                        int
	twoBranchesWeight                      int
	twoBranchesAndTrunkWeight              int
	horizontalMin, horizontalMax           int
	startMin, startMax                     int
	endMin, endMax                         int
}

func (ct *cherryTrunk) getTreeHeight(rnd random.IRandom) int {
	height := ct.baseHeight
	for _, interval := range ct.heightIntervals {
		height += treeIntRangeValueInclusive(0, interval, rnd)
	}
	return height
}

func (ct *cherryTrunk) weightedTreeType(rnd random.IRandom) int {
	weights := [...]int{ct.oneBranchWeight, ct.twoBranchesWeight, ct.twoBranchesAndTrunkWeight}
	total := weights[0] + weights[1] + weights[2]
	pick := rnd.NextIntBound(total)
	for i, weight := range weights {
		if pick < weight {
			return i
		}
		pick -= weight
	}
	// An empty/exhausted weighted scan yields -1. It follows the
	// same one-branch control-flow arm as tree type 0.
	return -1
}

func (ct *cherryTrunk) generateBranch(api wgen.BlockWorld, origin wgen.BlockPos, rnd random.IRandom, height int, params treeParamsLists, direction int, start int, joinsStemBelowTop bool) wgen.BlockPos {
	endY := height + treeIntRangeValueInclusive(ct.endMin, ct.endMax, rnd) - 1
	needsExtraHorizontal := joinsStemBelowTop || endY < start
	horizontalLength := treeIntRangeValueInclusive(ct.horizontalMin, ct.horizontalMax, rnd)
	if needsExtraHorizontal {
		horizontalLength++
	}

	dx, dz := leanDX[direction], leanDZ[direction]
	branchBlock := ct.branchZBlock
	if dx != 0 {
		branchBlock = ct.branchXBlock
	}
	cur := wgen.BlockPos{X: origin.X + dx, Y: origin.Y + start, Z: origin.Z + dz}
	if isValidTreePosition(api, cur, params.mayReplace) {
		placeLog(api, cur, branchBlock)
	}
	if needsExtraHorizontal {
		cur.X += dx
		cur.Z += dz
		if isValidTreePosition(api, cur, params.mayReplace) {
			placeLog(api, cur, branchBlock)
		}
	}

	target := wgen.BlockPos{X: origin.X + dx*horizontalLength, Y: origin.Y + endY, Z: origin.Z + dz*horizontalLength}
	for cur != target {
		TickDeadline("walking a branch out to its branch_length")
		dy := target.Y - cur.Y
		distance := abs(target.X-cur.X) + abs(dy) + abs(target.Z-cur.Z)
		ratio := float32(abs(dy)) / float32(distance)
		if float32(rnd.NextFloat()) < ratio {
			if dy < 0 {
				cur.Y--
			} else {
				cur.Y++
			}
			if isValidTreePosition(api, cur, params.mayReplace) {
				placeLog(api, cur, ct.trunkBlock)
			}
		} else {
			cur.X += dx
			cur.Z += dz
			if isValidTreePosition(api, cur, params.mayReplace) {
				placeLog(api, cur, branchBlock)
			}
		}
	}
	return wgen.BlockPos{X: target.X, Y: target.Y + 1, Z: target.Z}
}

func (f *TreeFeature) placeCherryTrunk(ctx *wgen.PlacementContext, ct *cherryTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}
	height := ct.getTreeHeight(rnd)

	// mangrove_roots -- see applyRoots for the order and the derivation.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}
	if origin.Y <= api.MinY() || origin.Y+height >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	if !f.mayGrowOn.Empty() {
		below := api.GetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z})
		if !f.mayGrowOn.Contains(below) {
			LogFailure(ctx, treeTypeID, "Trunk could not be placed")
			return nil
		}
	}
	placeBaseBlock(api, wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, f.mayGrowOn, f.mayGrowOnFallback)

	treeType := ct.weightedTreeType(rnd)
	startA := height - 1 + treeIntRangeValueInclusive(ct.startMin, ct.startMax, rnd)
	startB := height - 1 + treeIntRangeValueInclusive(ct.startMin, ct.startMax-1, rnd)
	if startB < 0 {
		startB = 0
	}
	if startA <= startB {
		startB++
	}
	direction := rnd.NextIntBound(4)
	startA = max(startA, 0)

	stemCount := startA + 1
	if treeType == 1 {
		stemCount = max(startA, startB) + 1
	} else if treeType == 2 {
		stemCount = height
	}
	for i := 0; i < stemCount; i++ {
		TickDeadline("placing the stems its cherry_trunk asks for")
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
		if isValidTreePosition(api, pos, params.mayReplace) {
			placeLog(api, pos, ct.trunkBlock)
		}
	}

	anchors := make([]treeCanopyAnchor, 0, 3)
	if treeType == 2 {
		anchors = append(anchors, treeCanopyAnchor{pos: wgen.BlockPos{X: origin.X, Y: origin.Y + height, Z: origin.Z}})
	}
	first := ct.generateBranch(api, origin, rnd, height, params, direction, startA, startA < stemCount-1)
	anchors = append(anchors, treeCanopyAnchor{pos: first})
	if treeType >= 1 {
		secondDirection := (direction + 2) & 3
		second := ct.generateBranch(api, origin, rnd, height, params, secondDirection, startB, startB < stemCount-1)
		anchors = append(anchors, treeCanopyAnchor{pos: second})
	}
	f.placeCanopies(api, rnd, params, anchors)

	result := origin
	return &result
}

// simpleTrunk models the simple trunk's placement -- the shape the bare
// "trunk" JSON key ALWAYS selects: "trunk" is one of eight independent
// sibling trunk keys (see the file header).
//
// can_be_submerged is a simple-trunk-only OPTION on that shape, not a
// selector between shapes: it only chooses the maximum submerged depth.
// bool true -> 255, {max_depth: N} -> N, absent or false -> 0, i.e. no
// descent at all. Typical vanilla trees land here with maxDepth 0.
//
// The bare key never selects the acacia trunk, whatever can_be_submerged
// says: a file writing {"trunk": {"trunk_block": ..., "trunk_height": <number>}}
// lacks three fields the acacia trunk requires (trunk_width, an object-shaped
// trunk_height, trunk_lean), and such files load in the game. A JSON scalar
// trunk_height is simply the degenerate spelling of the simple trunk's own
// required int-range trunk_height.
//
// The simple trunk's own shape is materially different from
// the acacia trunk's: a straight vertical column (no lean/direction draws at
// all -- it has no lean_offset/lean_steps fields), its own int-range-typed
// trunk_height/height_modifier (vs. the acacia trunk's plain-int
// trunk_height), and it hands the canopy an EMPTY candidates list (unlike the
// acacia trunk's accumulated log column) -- so random_spread_canopy paired
// with can_be_submerged gets no candidates either, same as every OTHER canopy.
type simpleTrunk struct {
	trunkBlock                     block.ID
	trunkHeightMin, trunkHeightMax int
	heightModMin, heightModMax     int
	// maxDepth is the simple trunk's own maximum submerged depth: 255 for
	// can_be_submerged=true (bool form), N for {max_depth: N} (object form).
	// 0 is a legal, fully-modeled value (the descent below is a no-op, but
	// the rest of the simple trunk's own straight-column shape still applies
	// -- only reachable via the object form, since the bool form's "false"
	// never constructs a *simpleTrunk at all; see buildTreeFeature).
	maxDepth int
}

// placeSubmergedTrunk implements the simple trunk's placement end to end. It
// is the ONLY path the bare "trunk" JSON key takes -- the name is historical
// (can_be_submerged used to be the only way in); can_be_submerged now merely
// sets maxDepth, and maxDepth 0 (the common shape) simply skips the descent.
//
// The bounds/ground/root-flare preamble is this file's approximation of the
// game's spawn preparation, shared with the acacia path for consistency -- but
// it runs ONCE, at the descended position, which is where the game runs it.
//
// Three known zero-RNG divergences from vanilla remain; each is marked
// DIVERGENCE at its own site with the reason it is left alone.
func (f *TreeFeature) placeSubmergedTrunk(ctx *wgen.PlacementContext, st *simpleTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}

	// *** RNG CALL *** (0 or 1 draws) -- the simple trunk's height draw,
	// an int-range draw over trunk_height, i.e.
	// treeIntRangeValue(trunk_height.min, trunk_height.max, rnd).
	height := treeIntRangeValue(st.trunkHeightMin, st.trunkHeightMax, rnd)

	// mangrove_roots -- see applyRoots for the ordering.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}

	// can_be_submerged's descent: probe (x, y-1, z) with may_grow_through; descend while it passes and budget remains,
	// committing the deepest passing cell. ZERO RNG. If the very first probe
	// fails, no relocation happens at all (relPos stays the original
	// origin).
	relPos := origin
	if st.maxDepth >= 1 {
		probe := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
		if passesAllowList(api.GetBlock(probe), f.mayGrowThrough) {
			budget := st.maxDepth
			for {
				TickDeadline("probing downward as deep as its max_depth asks")
				budget--
				relPos = probe
				if budget <= 0 {
					break
				}
				probe = wgen.BlockPos{X: probe.X, Y: probe.Y - 1, Z: probe.Z}
				if !passesAllowList(api.GetBlock(probe), f.mayGrowThrough) {
					break
				}
			}
		}
	}

	// The spawn preparation -- this file's approximation (ground must match
	// may_grow_on, trunk must fit under the build height, then the root-flare
	// ground fixup), run ONCE, at the DESCENDED position, AFTER the descent has
	// chosen relPos. Running it before the descent as well would be wrong: its
	// placeBaseBlock would write (origin.X, origin.Y-1, origin.Z), the very
	// cell the descent probes first, and a may_grow_on mismatch at the ORIGINAL
	// ground would abort a tree the game places -- a submerged tree may have
	// water/mud under its unrelocated origin and match may_grow_on only at the
	// bottom of the descent. Zero RNG either way.
	//
	// When can_be_submerged is absent or false, maxDepth is 0, the descent is
	// skipped, and relPos == origin.
	if relPos.Y <= api.MinY() || relPos.Y+height >= api.MaxY() {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	if !f.mayGrowOn.Empty() {
		below := api.GetBlock(wgen.BlockPos{X: relPos.X, Y: relPos.Y - 1, Z: relPos.Z})
		if !f.mayGrowOn.Contains(below) {
			LogFailure(ctx, treeTypeID, "Trunk could not be placed")
			return nil
		}
	}
	placeBaseBlock(api, wgen.BlockPos{X: relPos.X, Y: relPos.Y - 1, Z: relPos.Z}, f.mayGrowOn, f.mayGrowOnFallback)

	// *** RNG CALL *** (0 or 1 draws) -- height_modifier.getValue(rnd),
	// added to the base height drawn above.
	totalHeight := height + treeIntRangeValue(st.heightModMin, st.heightModMax, rnd)
	if totalHeight < 1 {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}

	// Straight vertical column, ZERO further RNG. Below the ORIGINAL
	// (unrelocated) origin.Y, gate by may_grow_through; at or above it, gate
	// by may_replace (the ordinary log gate). The comparison is against the
	// original origin, never the relocated one.
	var lastPlaced wgen.BlockPos
	placed := false
	y := relPos.Y
	for i := 0; i < totalHeight; i++ {
		TickDeadline("walking a trunk column as tall as its trunk height asks")
		pos := wgen.BlockPos{X: relPos.X, Y: y, Z: relPos.Z}
		gate := f.mayGrowThrough
		if y >= origin.Y {
			gate = f.mayReplace
		}
		if passesAllowList(api.GetBlock(pos), gate) {
			// DIVERGENCE, DELIBERATE: the game tests the block write's result
			// here -- a failed write skips the decoration AND aborts the whole
			// placement. This port ignores it, the same way every other
			// trunk path in this file does.
			//
			// Left as-is on purpose. In the game a failed write means
			// the chunk/region genuinely refused the write; in this port
			// Volume.SetBlock returns false for exactly one reason, the
			// write leaving the bench volume (volume.go's Contains check).
			// Honouring it would make a tree that pokes one cell over the
			// preview's edge abort entirely -- a bench artifact the game
			// never produces -- and would move the golden baseline for a
			// reason that has nothing to do with the game. Zero RNG
			// either way.
			placeLog(api, pos, st.trunkBlock)
			if f.trunkDecoration != nil {
				f.trunkDecoration.place(api, pos, mangroveTrunkAllDirections, rnd)
			}
			lastPlaced = pos
			placed = true
		}
		y++
	}
	if !placed {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}

	// Canopy anchor is simply "one above the topmost successfully-placed
	// log" -- no branchCollectAfter concept (the simple trunk has no lean),
	// and candidates is EMPTY (see simpleTrunk's own doc comment).
	//
	// DIVERGENCE, UNREACHABLE: the game fails the trunk placement outright
	// when there is no canopy; placeCanopies here just returns when f.canopy
	// is nil. Not ported because it cannot fire: buildTreeFeature requires
	// exactly one <shape>_canopy key for every trunk kind except fallen_trunk
	// and cherry_trunk (see the canopyKeys check), so f.canopy is never nil on
	// this path. Adding a dead guard would only invite a reader to trust it.
	anchor := wgen.BlockPos{X: lastPlaced.X, Y: lastPlaced.Y + 1, Z: lastPlaced.Z}
	f.placeCanopies(api, rnd, params, []treeCanopyAnchor{{pos: anchor}})
	// The simple trunk's post-canopy base_block ground fixup, gated on
	// !f.baseBlock.Empty() (an empty top-level base_block is a no-op in the
	// game, matching passesAllowList's empty-list-always-passes semantics),
	// at relPos.Y-1 -- relPos being the can_be_submerged-relocated starting
	// position, fixed once before the log loop and never reassigned, so
	// relPos.Y-1 is the same cell the game fixes up. A top-level "base_block"
	// key is accepted together with can_be_submerged;
	// TestBuildTreeFeature_CanopyKey_SchemaValidation's "trunk.can_be_submerged
	// + top-level base_block accepted" subtest pins the combination.
	if !f.baseBlock.Empty() {
		placeBaseBlock(api, wgen.BlockPos{X: relPos.X, Y: relPos.Y - 1, Z: relPos.Z}, f.baseBlock, f.baseBlockFallback)
	}

	// DIVERGENCE, DELIBERATE: the game returns the canopy anchor
	// `{x, lastPlacedY+1, z}`; every trunk path in this file returns the
	// (possibly roots-relocated) origin instead. Kept as the port-wide
	// convention rather than changed here alone -- a single path returning
	// something else is worse than all of them agreeing, and the return value
	// feeds this port's own feature-chaining. Zero RNG.
	result := origin
	return &result
}

// parseAttachableDecorationObject parses an attachable-decoration
// JSON object -- decoration_block or decoration_blocks_sequence, plus
// decoration_chance, num_steps accepted-but-inert (see below) -- into a
// *megaTrunkDecoration. Shared by mega_trunk.trunk_decoration and
// mangrove_trunk.trunk_decoration, both of which embed an
// attachable decoration at the SAME "trunk_decoration" JSON key and consume
// it via the SAME decoration machinery, megaTrunkDecoration -- see that
// type's doc comment for the full algorithm, and mangroveTrunk's doc comment
// for where the mangrove trunk applies it.
//
// num_steps: a valid int key of the attachable decoration, but it has no
// effect in vanilla -- decoration placement reads only the
// decoration_blocks_sequence entries and each entry's count range. A field
// the game accepts but ignores is not this port's business to refuse -- the
// same treatment given to mangrove_trunk's trunk_width and
// branches.branch_chance: accepted silently, value discarded.
func parseAttachableDecorationObject(raw any, path string, ctx *BuildContext) (*megaTrunkDecoration, error) {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", path)
	}
	var entries []megaTrunkDecorationEntry
	if seqRaw, present := obj["decoration_blocks_sequence"]; present {
		seq, ok := seqRaw.([]any)
		if !ok {
			return nil, fmt.Errorf("%s.decoration_blocks_sequence must be an array", path)
		}
		for i, itemRaw := range seq {
			item, ok := itemRaw.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s.decoration_blocks_sequence[%d] must be an object", path, i)
			}
			blockRaw, ok := item["block"]
			if !ok {
				return nil, fmt.Errorf("%s.decoration_blocks_sequence[%d].block is required", path, i)
			}
			desc, err := AsBlockDescriptor(blockRaw, fmt.Sprintf("%s.decoration_blocks_sequence[%d].block", path, i))
			if err != nil {
				return nil, err
			}
			cMin, cMax := 1, 1
			if countRaw, present := item["count"]; present {
				var err error
				cMin, cMax, err = parseTreeIntRange(countRaw, fmt.Sprintf("%s.decoration_blocks_sequence[%d].count", path, i))
				if err != nil {
					return nil, err
				}
			}
			entries = append(entries, megaTrunkDecorationEntry{blockID: ctx.Palette.Resolve(desc), countMin: cMin, countMax: cMax})
		}
		if len(entries) == 0 {
			return nil, fmt.Errorf("%s.decoration_blocks_sequence must not be empty", path)
		}
	} else if blockRaw, present := obj["decoration_block"]; present {
		desc, err := AsBlockDescriptor(blockRaw, path+".decoration_block")
		if err != nil {
			return nil, err
		}
		entries = []megaTrunkDecorationEntry{{blockID: ctx.Palette.Resolve(desc), countMin: 1, countMax: 1}}
	} else {
		// BOTH are optional in the game -- decoration_block and
		// decoration_blocks_sequence alike. A hard error here would refuse a file the game
		// loads -- the direction that costs an author most, because there is nothing wrong
		// with their JSON.
		//
		// A decoration with no block to place has nothing to do, so it is kept as an empty entry
		// list and said out loud rather than accepted in silence: an author who wrote the object
		// almost certainly meant to put a block in it.
		if ctx.Warn != nil {
			ctx.Warn(fmt.Sprintf("%s: %s has neither decoration_block nor decoration_blocks_sequence, "+
				"so it has no block to place and decorates nothing. Both keys are optional in the "+
				"game, so the file loads there too -- this is a warning, not an error",
				ctx.Identifier, path))
		}
	}
	chance, err := parseChanceInformation(obj["decoration_chance"], path+".decoration_chance")
	if err != nil {
		return nil, err
	}
	d := &megaTrunkDecoration{entries: entries, chance: chance, pal: ctx.Palette}
	// step_direction -- the JSON key behind the growth-direction field (see
	// megaTrunkDecoration.stepDirection's doc comment). Optional; default 0
	// (down). num_steps stays accepted-but-inert.
	if raw, present := obj["step_direction"]; present {
		// The game accepts this as an ENUM over four string spellings:
		// "down" = 0, "up" = 1, "out" = 2, and "away" = 2 as an ALIAS for "out".
		// A number is not a legal value in game.
		//
		// The number is still read, with a warning, rather than refused: a file that reaches this
		// tool with a number in it is one somebody wrote against older behaviour of this tool, and
		// telling them the value is not legal in game is more useful than making the file fail to load.
		switch v := raw.(type) {
		case string:
			switch strings.ToLower(v) {
			case "down":
				d.stepDirection = 0
			case "up":
				d.stepDirection = 1
			case "out", "away":
				d.stepDirection = 2
			default:
				return nil, fmt.Errorf("%s.step_direction must be one of \"down\", \"up\", \"out\" or "+
					"\"away\" (\"away\" is an alias for \"out\"), got %q", path, v)
			}
		case float64:
			if v != float64(int(v)) || v < 0 || v > 2 {
				return nil, fmt.Errorf("%s.step_direction as a number must be 0, 1 or 2", path)
			}
			d.stepDirection = int(v)
			if ctx.Warn != nil {
				ctx.Warn(fmt.Sprintf("%s: %s.step_direction is a number (%v). The game "+
					"accepts this key as an enum over \"down\", \"up\", \"out\" and \"away\", so a "+
					"number is not a legal value there and the real game would refuse this file. "+
					"Read here as %d for compatibility; write the string instead",
					ctx.Identifier, path, raw, int(v)))
			}
		default:
			return nil, fmt.Errorf("%s.step_direction must be one of \"down\", \"up\", \"out\" or \"away\"", path)
		}
	}
	return d, nil
}

func buildTreeFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	var trunk map[string]any
	var cherry *cherryTrunk
	var mangrove *mangroveTrunk
	trunkKind := ""
	for _, key := range []string{"trunk", "acacia_trunk", "cherry_trunk", "fallen_trunk", "fancy_trunk", "mega_trunk", "mangrove_trunk", "poplar_trunk"} {
		if raw, present := body[key]; present {
			if trunkKind != "" {
				return nil, fmt.Errorf("only one trunk variant may be present, found: %s, %s", trunkKind, key)
			}
			var ok bool
			trunk, ok = raw.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s must be an object", key)
			}
			trunkKind = key
		}
	}
	if trunkKind == "" {
		return nil, fmt.Errorf("one trunk variant is required")
	}
	if trunkKind == "cherry_trunk" {
		cherry = &cherryTrunk{
			baseHeight:    5,
			horizontalMin: 2, horizontalMax: 4,
			startMin: -4, startMax: -3,
			endMin: -1, endMax: 0,
		}
	}
	if trunkKind == "mangrove_trunk" {
		mangrove = &mangroveTrunk{}
	}
	trunkBlockRaw, ok := trunk["trunk_block"]
	if !ok {
		if cherry != nil {
			return nil, fmt.Errorf("cherry_trunk.trunk_block is required")
		}
		return nil, fmt.Errorf("trunk.trunk_block is required")
	}
	trunkPath := trunkKind
	trunkDesc, err := AsBlockDescriptor(trunkBlockRaw, trunkPath+".trunk_block")
	if err != nil {
		return nil, err
	}
	trunkBlockID := ctx.Palette.Resolve(trunkDesc)
	if cherry != nil {
		cherry.trunkBlock = trunkBlockID
		entry := ctx.Palette.Entry(trunkBlockID)
		axisBlock := func(axis string) block.ID {
			states := make(map[string]block.StateValue, len(entry.States)+1)
			for key, value := range entry.States {
				states[key] = value
			}
			states["pillar_axis"] = axis
			return ctx.Palette.Resolve(block.Descriptor{Name: entry.Name, States: states})
		}
		cherry.branchXBlock = axisBlock("x")
		cherry.branchZBlock = axisBlock("z")
	}

	parseIntervalHeight := func(raw any, path string) (intervalHeight, error) {
		obj, ok := raw.(map[string]any)
		if !ok {
			return intervalHeight{}, fmt.Errorf("%s must be an object", path)
		}
		base, ok := obj["base"].(float64)
		if !ok {
			return intervalHeight{}, fmt.Errorf("%s.base is required and must be a number", path)
		}
		result := intervalHeight{base: int(base)}
		if rawIntervals, present := obj["intervals"]; present {
			values, ok := rawIntervals.([]any)
			if !ok {
				return intervalHeight{}, fmt.Errorf("%s.intervals must be an array", path)
			}
			for i, rawInterval := range values {
				value, ok := rawInterval.(float64)
				if !ok || int(value) < 1 {
					return intervalHeight{}, fmt.Errorf("%s.intervals[%d] must be a number >= 1", path, i)
				}
				result.intervals = append(result.intervals, int(value))
			}
		}
		return result, nil
	}

	var shaped *shapedTrunk
	var fallen *fallenTrunk
	var poplar *poplarTrunk
	switch trunkKind {
	case "acacia_trunk", "mega_trunk":
		height, err := parseIntervalHeight(trunk["trunk_height"], trunkKind+".trunk_height")
		if err != nil {
			return nil, err
		}
		widthF, ok := trunk["trunk_width"].(float64)
		if !ok || int(widthF) < 1 {
			return nil, fmt.Errorf("%s.trunk_width is required and must be a number >= 1", trunkKind)
		}
		shaped = &shapedTrunk{kind: trunkKind, height: height, width: int(widthF)}
		if trunkKind == "acacia_trunk" {
			lean, ok := trunk["trunk_lean"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("acacia_trunk.trunk_lean is required and must be an object")
			}
			// allow_diagonal_growth is REQUIRED; the game rejects a file without
			// it at load. Enforcing it matters more than usual here, because the
			// Go zero value `false` (the perimeter sweep, up to eight branches)
			// picks the OPPOSITE routine from the game's internal default `true`
			// (one diagonal branch). Every vanilla acacia_trunk sets it explicitly.
			diagonal, ok := lean["allow_diagonal_growth"].(bool)
			if !ok {
				return nil, fmt.Errorf("acacia_trunk.trunk_lean.allow_diagonal_growth is required and must be a boolean")
			}
			shaped.allowDiagonal = diagonal
			shaped.leanHeightMin, shaped.leanHeightMax, err = parseTreeIntRange(lean["lean_height"], "acacia_trunk.trunk_lean.lean_height")
			if err != nil {
				return nil, err
			}
			shaped.leanStepsMin, shaped.leanStepsMax, err = parseTreeIntRange(lean["lean_steps"], "acacia_trunk.trunk_lean.lean_steps")
			if err != nil {
				return nil, err
			}
			// lean_length: optional int range, default {0,0} -- degenerate, so
			// an absent key draws nothing and adds nothing (see placeShapedTrunk).
			if _, present := lean["lean_length"]; present {
				shaped.leanLengthMin, shaped.leanLengthMax, err = parseTreeIntRange(lean["lean_length"], "acacia_trunk.trunk_lean.lean_length")
				if err != nil {
					return nil, err
				}
			}
			// min_height_for_canopy: optional plain int, default 3. Lives inside
			// trunk_height, not trunk_lean.
			shaped.minHeightForCanopy = branchCollectAfter
			if heightObj, ok := trunk["trunk_height"].(map[string]any); ok {
				if raw, present := heightObj["min_height_for_canopy"]; present {
					v, ok := toFloat(raw)
					if !ok {
						return nil, fmt.Errorf("acacia_trunk.trunk_height.min_height_for_canopy must be a number")
					}
					shaped.minHeightForCanopy = int(v)
				}
			}
			// acacia_trunk.branches -- a DIFFERENT object from mega_trunk's
			// `branches` (see acaciaBranches' own doc comment). All three of
			// branch_length/branch_position/branch_chance are REQUIRED once
			// `branches` is present; branch_canopy is optional and resolves
			// through the same buildCanopyByKey dispatch every other canopy
			// uses.
			if raw, present := trunk["branches"]; present {
				branchesObj, ok := raw.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("acacia_trunk.branches must be an object")
				}
				ab := &acaciaBranches{}
				if _, present := branchesObj["branch_length"]; !present {
					return nil, fmt.Errorf("acacia_trunk.branches.branch_length is required")
				}
				ab.lengthMin, ab.lengthMax, err = parseTreeIntRange(branchesObj["branch_length"], "acacia_trunk.branches.branch_length")
				if err != nil {
					return nil, err
				}
				if _, present := branchesObj["branch_position"]; !present {
					return nil, fmt.Errorf("acacia_trunk.branches.branch_position is required")
				}
				ab.positionMin, ab.positionMax, err = parseTreeIntRange(branchesObj["branch_position"], "acacia_trunk.branches.branch_position")
				if err != nil {
					return nil, err
				}
				chanceRaw, present := branchesObj["branch_chance"]
				if !present {
					return nil, fmt.Errorf("acacia_trunk.branches.branch_chance is required")
				}
				ab.chance, err = parseChanceInformation(chanceRaw, "acacia_trunk.branches.branch_chance")
				if err != nil {
					return nil, err
				}
				if canopyRaw, present := branchesObj["branch_canopy"]; present {
					canopyObj, ok := canopyRaw.(map[string]any)
					if !ok {
						return nil, fmt.Errorf("acacia_trunk.branches.branch_canopy must be an object")
					}
					ab.canopyBody = canopyObj
					for _, k := range knownCanopyKeys {
						if _, present := canopyObj[k]; present {
							if ab.canopyKey != "" {
								return nil, fmt.Errorf("only one canopy key may be present in acacia_trunk.branches.branch_canopy, found: %s, %s", ab.canopyKey, k)
							}
							ab.canopyKey = k
						}
					}
					if ab.canopyKey == "" {
						return nil, fmt.Errorf("acacia_trunk.branches.branch_canopy requires exactly one <shape>_canopy key (one of: %s)", strings.Join(knownCanopyKeys, ", "))
					}
				}
				shaped.acaciaBranches = ab
			}
			// acacia_trunk.trunk_decoration -- an optional object, applied by
			// the game to EVERY trunk log: each trunk cell and each leaning-branch
			// log gets the same attachable decoration. Parsed with the SAME
			// parseAttachableDecorationObject/megaTrunkDecoration machinery
			// mega_trunk, mangrove_trunk and fallen_trunk share. Vanilla's
			// roofed_tree_with_vines_feature gets its vines this way.
			if raw, present := trunk["trunk_decoration"]; present {
				shaped.decoration, err = parseAttachableDecorationObject(raw, "acacia_trunk.trunk_decoration", ctx)
				if err != nil {
					return nil, err
				}
			}
		} else {
			// mega_trunk.trunk_decoration -- see megaTrunkDecoration's own
			// doc comment for the schema and algorithm.
			// parseAttachableDecorationObject is shared with
			// mangrove_trunk.trunk_decoration below (the SAME
			// attachable-decoration JSON shape and runtime
			// machinery -- see mangroveTrunk's own doc comment).
			if raw, present := trunk["trunk_decoration"]; present {
				shaped.decoration, err = parseAttachableDecorationObject(raw, "mega_trunk.trunk_decoration", ctx)
				if err != nil {
					return nil, err
				}
			}

			// mega_trunk.branches -- see megaBranches' own doc comment for
			// the schema and algorithm. branch_canopy is
			// resolved later, via the SAME buildCanopyByKey dispatch the
			// top-level canopy uses (see below, after canopyBody/canopyKey
			// are computed).
			if raw, present := trunk["branches"]; present {
				branchesObj, ok := raw.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("mega_trunk.branches must be an object")
				}
				lengthF, ok := branchesObj["branch_length"].(float64)
				if !ok {
					return nil, fmt.Errorf("mega_trunk.branches.branch_length is required and must be a number")
				}
				slopeF, ok := toFloat(branchesObj["branch_slope"])
				if !ok {
					return nil, fmt.Errorf("mega_trunk.branches.branch_slope is required and must be a number")
				}
				intervalRaw, present := branchesObj["branch_interval"]
				if !present {
					return nil, fmt.Errorf("mega_trunk.branches.branch_interval is required")
				}
				intervalMin, intervalMax, err := parseTreeIntRange(intervalRaw, "mega_trunk.branches.branch_interval")
				if err != nil {
					return nil, err
				}
				altObj, ok := branchesObj["branch_altitude_factor"].(map[string]any)
				if !ok {
					return nil, fmt.Errorf("mega_trunk.branches.branch_altitude_factor is required and must be an object")
				}
				altMinF, ok := toFloat(altObj["min"])
				if !ok {
					return nil, fmt.Errorf("mega_trunk.branches.branch_altitude_factor.min is required and must be a number")
				}
				altMaxF, ok := toFloat(altObj["max"])
				if !ok {
					return nil, fmt.Errorf("mega_trunk.branches.branch_altitude_factor.max is required and must be a number")
				}
				branches := &megaBranches{
					length:      int(lengthF),
					slope:       float32(slopeF),
					intervalMin: intervalMin,
					intervalMax: intervalMax,
					altitudeMin: float32(altMinF),
					altitudeMax: float32(altMaxF),
				}
				if canopyRaw, present := branchesObj["branch_canopy"]; present {
					canopyObj, ok := canopyRaw.(map[string]any)
					if !ok {
						return nil, fmt.Errorf("mega_trunk.branches.branch_canopy must be an object")
					}
					branches.canopyBody = canopyObj
					for _, k := range knownCanopyKeys {
						if _, present := canopyObj[k]; present {
							if branches.canopyKey != "" {
								return nil, fmt.Errorf("only one canopy key may be present in mega_trunk.branches.branch_canopy, found: %s, %s", branches.canopyKey, k)
							}
							branches.canopyKey = k
						}
					}
					if branches.canopyKey == "" {
						return nil, fmt.Errorf("mega_trunk.branches.branch_canopy requires exactly one <shape>_canopy key (one of: %s)", strings.Join(knownCanopyKeys, ", "))
					}
				}
				shaped.branches = branches
			}
		}
	case "fancy_trunk":
		heightObj, ok := trunk["trunk_height"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("fancy_trunk.trunk_height is required and must be an object")
		}
		base, bok := heightObj["base"].(float64)
		variance, vok := heightObj["variance"].(float64)
		scale, sok := heightObj["scale"].(float64)
		width, wok := trunk["trunk_width"].(float64)
		if !bok || !vok || !sok || !wok || int(variance) < 1 || int(width) < 1 {
			return nil, fmt.Errorf("fancy_trunk requires numeric trunk_height.{base,variance,scale} and trunk_width")
		}
		shaped = &shapedTrunk{kind: trunkKind, height: intervalHeight{base: int(base)}, width: int(width), fancyVariance: int(variance), fancyScale: float32(scale)}
		// The fancy trunk's remaining five fields, ALL schema-REQUIRED, as is the
		// `branches` object three of them live in -- the sharpest contrast with
		// acacia_trunk, whose `branches` is optional. Each key is listed on the
		// struct field it writes.
		branchesRaw, present := trunk["branches"]
		if !present {
			return nil, fmt.Errorf("fancy_trunk.branches is required")
		}
		branchesObj, ok := branchesRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("fancy_trunk.branches must be an object")
		}
		slope, slopeOK := toFloat(branchesObj["slope"])
		density, densityOK := toFloat(branchesObj["density"])
		minAlt, minAltOK := toFloat(branchesObj["min_altitude_factor"])
		if !slopeOK || !densityOK || !minAltOK {
			return nil, fmt.Errorf("fancy_trunk.branches requires numeric slope, density and min_altitude_factor")
		}
		widthScale, wsOK := toFloat(trunk["width_scale"])
		foliageAlt, faOK := toFloat(trunk["foliage_altitude_factor"])
		if !wsOK || !faOK {
			return nil, fmt.Errorf("fancy_trunk requires numeric width_scale and foliage_altitude_factor")
		}
		shaped.fancySlope = float32(slope)
		shaped.fancyDensity = float32(density)
		shaped.fancyMinAltitude = float32(minAlt)
		shaped.fancyWidthScale = float32(widthScale)
		shaped.fancyFoliageAltFact = float32(foliageAlt)
	case "fallen_trunk":
		logMin, logMax, err := parseTreeIntRange(trunk["log_length"], "fallen_trunk.log_length")
		if err != nil {
			return nil, err
		}
		fallen = &fallenTrunk{logMin: logMin, logMax: logMax, stumpMin: 1, stumpMax: 1, logX: trunkBlockID, logZ: trunkBlockID, pal: ctx.Palette}
		if raw, present := trunk["height_modifier"]; present {
			fallen.heightMin, fallen.heightMax, err = parseTreeIntRange(raw, "fallen_trunk.height_modifier")
			if err != nil {
				return nil, err
			}
		}
		if raw, present := trunk["stump_height"]; present {
			fallen.stumpMin, fallen.stumpMax, err = parseTreeIntRange(raw, "fallen_trunk.stump_height")
			if err != nil {
				return nil, err
			}
		}
		entry := ctx.Palette.Entry(trunkBlockID)
		axisBlock := func(axis string) block.ID {
			states := make(map[string]block.StateValue, len(entry.States)+1)
			for key, value := range entry.States {
				states[key] = value
			}
			states["pillar_axis"] = axis
			return ctx.Palette.Resolve(block.Descriptor{Name: entry.Name, States: states})
		}
		fallen.logX, fallen.logZ = axisBlock("x"), axisBlock("z")

		// log_decoration_feature -- see fallenTrunk's own doc comment / placeFallenTrunk
		// for the behaviour. A plain "namespace:id" feature reference, resolved lazily the
		// SAME way aggregate_feature/sequence_feature's own "features" array already resolves
		// sibling references (features/aggregate.go's buildAggregateFeature).
		if raw, present := trunk["log_decoration_feature"]; present {
			s, ok := raw.(string)
			if !ok || s == "" {
				return nil, fmt.Errorf("fallen_trunk.log_decoration_feature must be a feature reference string")
			}
			fallen.logDecorationRef = s
			fallen.logDecorationResolver = ctx.Resolver
		}
		// trunk_decoration -- the SAME parseAttachableDecorationObject/megaTrunkDecoration
		// machinery mega_trunk/mangrove_trunk already share (see mangroveTrunk's own doc comment).
		if decRaw, present := trunk["trunk_decoration"]; present {
			decoration, err := parseAttachableDecorationObject(decRaw, "fallen_trunk.trunk_decoration", ctx)
			if err != nil {
				return nil, err
			}
			fallen.decoration = decoration
		}
	case "poplar_trunk":
		// The poplar trunk -- see the Poplar section for the schema (fields,
		// required keys and defaults).
		poplar = &poplarTrunk{
			remainingMin: 4, remainingMax: 4, // default {4,4}
			foliageMin: 1, foliageMax: 4, // default {1,4}
			trunkBlock: trunkBlockID,
			pal:        ctx.Palette,
		}
		heightRaw, present := trunk["trunk_height"]
		if !present {
			return nil, fmt.Errorf("poplar_trunk.trunk_height is required")
		}
		poplar.heightMin, poplar.heightMax, err = parseTreeIntRange(heightRaw, "poplar_trunk.trunk_height")
		if err != nil {
			return nil, err
		}
		if raw, present := trunk["remaining_trunk_height_above_branches"]; present {
			poplar.remainingMin, poplar.remainingMax, err = parseTreeIntRange(raw, "poplar_trunk.remaining_trunk_height_above_branches")
			if err != nil {
				return nil, err
			}
		}
		if raw, present := trunk["amount_of_foliage_support_branches"]; present {
			poplar.foliageMin, poplar.foliageMax, err = parseTreeIntRange(raw, "poplar_trunk.amount_of_foliage_support_branches")
			if err != nil {
				return nil, err
			}
		}
		// Branch logs are trunk_block with pillar_axis forced per direction --
		// the same build-time resolution cherry_trunk/fallen_trunk already use.
		entry := ctx.Palette.Entry(trunkBlockID)
		axisBlock := func(axis string) block.ID {
			states := make(map[string]block.StateValue, len(entry.States)+1)
			for key, value := range entry.States {
				states[key] = value
			}
			states["pillar_axis"] = axis
			return ctx.Palette.Resolve(block.Descriptor{Name: entry.Name, States: states})
		}
		poplar.branchX, poplar.branchZ = axisBlock("x"), axisBlock("z")
		if decRaw, present := trunk["trunk_decoration"]; present {
			poplar.decoration, err = parseAttachableDecorationObject(decRaw, "poplar_trunk.trunk_decoration", ctx)
			if err != nil {
				return nil, err
			}
		}
		if raw, present := trunk["log_decoration_feature"]; present {
			s, ok := raw.(string)
			if !ok || s == "" {
				return nil, fmt.Errorf("poplar_trunk.log_decoration_feature must be a feature reference string")
			}
			poplar.logDecorationRef = s
			poplar.logDecorationResolver = ctx.Resolver
		}
	}

	// trunk.can_be_submerged -- a simple-trunk field, and ONLY a depth.
	//
	// can_be_submerged does NOT choose between trunk shapes. The tree feature
	// has EIGHT independent SIBLING trunk KEYS, exactly the way knownCanopyKeys
	// works -- the key name alone decides the shape -- and "trunk" is the
	// simple trunk. Nothing about the VALUE at "trunk" can select a shape. The
	// full table is in this file's header. can_be_submerged exists only on the
	// simple trunk.
	//
	// So all this parse does is read the maximum submerged depth:
	// bool true -> 255, {max_depth: N} -> N, bool false or absent -> 0 (the
	// fallthrough below), which means "do not descend" and nothing else.
	var submerged *simpleTrunk
	if cbsRaw, present := trunk["can_be_submerged"]; present && trunkKind == "trunk" {
		switch cbs := cbsRaw.(type) {
		case bool:
			if cbs {
				// bool true -> a maximum submerged depth of 255.
				submerged = &simpleTrunk{maxDepth: 255}
			}
		case map[string]any:
			maxDepthRaw, ok := cbs["max_depth"]
			if !ok {
				return nil, fmt.Errorf("trunk.can_be_submerged.max_depth is required")
			}
			maxDepthF, ok := maxDepthRaw.(float64)
			if !ok {
				return nil, fmt.Errorf("trunk.can_be_submerged.max_depth must be a number")
			}
			submerged = &simpleTrunk{maxDepth: int(maxDepthF)}
		default:
			return nil, fmt.Errorf("trunk.can_be_submerged must be a boolean or an object")
		}
	}
	// The bare "trunk" key IS the simple trunk, always -- see this file's header for the
	// trunk-key table. can_be_submerged only chooses the DEPTH (bool true -> 255, object ->
	// max_depth, absent -> 0, i.e. no descent); it never chooses the shape, and the scalar
	// trunk_height that used to route this key to an acacia-shaped path is just the
	// degenerate spelling of the simple trunk's own required int-range field.
	if trunkKind == "trunk" && submerged == nil {
		submerged = &simpleTrunk{}
	}

	var trunkHeightF float64
	if cherry != nil {
		heightObj, ok := trunk["trunk_height"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("cherry_trunk.trunk_height is required and must be an object")
		}
		baseF, ok := heightObj["base"].(float64)
		if !ok || int(baseF) < 2 {
			return nil, fmt.Errorf("cherry_trunk.trunk_height.base is required and must be a number >= 2")
		}
		cherry.baseHeight = int(baseF)
		if intervalsRaw, present := heightObj["intervals"]; present {
			intervals, ok := intervalsRaw.([]any)
			if !ok {
				return nil, fmt.Errorf("cherry_trunk.trunk_height.intervals must be an array")
			}
			cherry.heightIntervals = make([]int, len(intervals))
			for i, raw := range intervals {
				value, ok := raw.(float64)
				if !ok || int(value) < 1 {
					return nil, fmt.Errorf("cherry_trunk.trunk_height.intervals[%d] must be a number >= 1", i)
				}
				cherry.heightIntervals[i] = int(value)
			}
		}

		branches, ok := trunk["branches"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("cherry_trunk.branches is required and must be an object")
		}
		if weightsRaw, present := branches["tree_type_weights"]; present {
			weights, ok := weightsRaw.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("cherry_trunk.branches.tree_type_weights must be an object")
			}
			for key, target := range map[string]*int{
				"one_branch":             &cherry.oneBranchWeight,
				"two_branches":           &cherry.twoBranchesWeight,
				"two_branches_and_trunk": &cherry.twoBranchesAndTrunkWeight,
			} {
				value, ok := weights[key].(float64)
				if !ok || int(value) < 0 {
					return nil, fmt.Errorf("cherry_trunk.branches.tree_type_weights.%s is required and must be a number >= 0", key)
				}
				*target = int(value)
			}
		}
		parseRequiredRange := func(key string) (int, int, error) {
			raw, present := branches[key]
			if !present {
				return 0, 0, fmt.Errorf("cherry_trunk.branches.%s is required", key)
			}
			return parseTreeIntRange(raw, "cherry_trunk.branches."+key)
		}
		cherry.horizontalMin, cherry.horizontalMax, err = parseRequiredRange("branch_horizontal_length")
		if err != nil {
			return nil, err
		}
		if cherry.horizontalMin < 2 || cherry.horizontalMax < 2 {
			return nil, fmt.Errorf("cherry_trunk.branches.branch_horizontal_length values must be >= 2")
		}
		cherry.startMin, cherry.startMax, err = parseRequiredRange("branch_start_offset_from_top")
		if err != nil {
			return nil, err
		}
		if cherry.startMin > 0 || cherry.startMax > 0 {
			return nil, fmt.Errorf("cherry_trunk.branches.branch_start_offset_from_top values must be <= 0")
		}
		cherry.endMin, cherry.endMax, err = parseRequiredRange("branch_end_offset_from_top")
		if err != nil {
			return nil, err
		}
	} else if mangrove != nil {
		// The mangrove trunk's own trunk_height is a NESTED object
		// {base, height_rand_a, height_rand_b} (all required plain ints,
		// NOT an int range -- see mangroveTrunk's own doc comment/getTreeHeight).
		heightObj, ok := trunk["trunk_height"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("mangrove_trunk.trunk_height is required and must be an object")
		}
		baseF, ok := heightObj["base"].(float64)
		if !ok {
			return nil, fmt.Errorf("mangrove_trunk.trunk_height.base is required and must be a number")
		}
		mangrove.heightBase = int(baseF)
		randAF, ok := heightObj["height_rand_a"].(float64)
		if !ok || int(randAF) < 0 {
			return nil, fmt.Errorf("mangrove_trunk.trunk_height.height_rand_a is required and must be a number >= 0")
		}
		mangrove.heightRandA = int(randAF)
		randBF, ok := heightObj["height_rand_b"].(float64)
		if !ok || int(randBF) < 0 {
			return nil, fmt.Errorf("mangrove_trunk.trunk_height.height_rand_b is required and must be a number >= 0")
		}
		mangrove.heightRandB = int(randBF)
		mangrove.trunkBlock = trunkBlockID

		// branches -- OPTIONAL. Absence keeps branch_length/branch_steps at
		// their zeroed defaults, which match the game's defaults -- NOT a
		// "branches disabled" signal (see mangroveTrunk's own doc comment/"the coin
		// flip": the NextBoolean draw always happens regardless).
		if branchesRaw, present := trunk["branches"]; present {
			branchesObj, ok := branchesRaw.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("mangrove_trunk.branches must be an object")
			}
			if lenRaw, present := branchesObj["branch_length"]; present {
				mangrove.branchLengthMin, mangrove.branchLengthMax, err = parseTreeIntRange(lenRaw, "mangrove_trunk.branches.branch_length")
				if err != nil {
					return nil, err
				}
			}
			if stepsRaw, present := branchesObj["branch_steps"]; present {
				mangrove.branchStepsMin, mangrove.branchStepsMax, err = parseTreeIntRange(stepsRaw, "mangrove_trunk.branches.branch_steps")
				if err != nil {
					return nil, err
				}
			}
			// branch_chance -- a valid key, but neither the trunk placement nor
			// the branch placement uses it (see mangroveTrunk's own doc comment). Validated so a malformed value is still
			// caught, but its value is never consumed.
			if chanceRaw, present := branchesObj["branch_chance"]; present {
				if _, err := parseChanceInformation(chanceRaw, "mangrove_trunk.branches.branch_chance"); err != nil {
					return nil, err
				}
			}
		}

		// trunk_decoration -- an OPTIONAL attachable decoration, the
		// SAME shape mega_trunk.trunk_decoration already ships; reuses
		// parseAttachableDecorationObject (factored out of mega_trunk's own
		// parsing below) and megaTrunkDecoration's own runtime .place
		// method -- see mangroveTrunk's own doc comment for the two
		// places it is applied.
		if decRaw, present := trunk["trunk_decoration"]; present {
			mangrove.decoration, err = parseAttachableDecorationObject(decRaw, "mangrove_trunk.trunk_decoration", ctx)
			if err != nil {
				return nil, err
			}
		}

		// trunk_width -- a valid optional int, but unused by the mangrove
		// trunk (see mangroveTrunk's own doc comment).
		// Accepted without validation; nothing to store.
	} else if shaped != nil || fallen != nil || poplar != nil {
		// Parsed by the variant-specific schema above.
	} else if submerged == nil {
		trunkHeightF, ok = trunk["trunk_height"].(float64)
		if !ok {
			return nil, fmt.Errorf("trunk.trunk_height must be a number (range/array forms are unconfirmed -- see this file's header)")
		}
	} else {
		// The simple trunk's OWN trunk_height is a genuine int-range
		// field (its height is an int-range draw over that field) -- unlike the acacia trunk's
		// plain-int-only requirement above, this accepts the full
		// number/[min,max]/{min,max} vocabulary this file's own
		// parseTreeIntRange already established for spruce_canopy et al.
		heightRaw, present := trunk["trunk_height"]
		if !present {
			return nil, fmt.Errorf("trunk.trunk_height is required")
		}
		hMin, hMax, err := parseTreeIntRange(heightRaw, "trunk.trunk_height")
		if err != nil {
			return nil, err
		}
		submerged.trunkHeightMin, submerged.trunkHeightMax = hMin, hMax

		// height_modifier -- optional, default {0,0}.
		if hmRaw, present := trunk["height_modifier"]; present {
			hmMin, hmMax, err := parseTreeIntRange(hmRaw, "trunk.height_modifier")
			if err != nil {
				return nil, err
			}
			submerged.heightModMin, submerged.heightModMax = hmMin, hmMax
		}

		submerged.trunkBlock = trunkBlockID

	}

	canopyBody := body
	if cherry != nil {
		branches := trunk["branches"].(map[string]any)
		if raw, present := branches["branch_canopy"]; present {
			var ok bool
			canopyBody, ok = raw.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("cherry_trunk.branches.branch_canopy must be an object")
			}
		} else {
			canopyBody = nil
		}
	}
	var canopyKeys []string
	for _, k := range knownCanopyKeys {
		if _, present := canopyBody[k]; present {
			canopyKeys = append(canopyKeys, k)
		}
	}
	if len(canopyKeys) == 0 {
		if fallen == nil && (cherry == nil || canopyBody != nil) {
			return nil, fmt.Errorf("exactly one <shape>_canopy key is required (one of: %s)", strings.Join(knownCanopyKeys, ", "))
		}
	}
	if len(canopyKeys) > 1 {
		return nil, fmt.Errorf("only one canopy key may be present, found: %s", strings.Join(canopyKeys, ", "))
	}
	canopyKey := ""
	if len(canopyKeys) == 1 {
		canopyKey = canopyKeys[0]
	}

	// The JSON key is "mangrove_roots", NOT bare "roots" -- the mangrove roots
	// are the ONLY root variant, and there is no bare/generic "roots" key the
	// way there is a bare "canopy". See the file header for the schema,
	// parseMangroveRoots below, and mangroveRootsPlace for the placement.
	var roots *mangroveRoots
	if rootsRaw, present := body["mangrove_roots"]; present {
		rootsObj, ok := rootsRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("mangrove_roots must be an object")
		}
		var err error
		roots, err = parseMangroveRoots(rootsObj, ctx)
		if err != nil {
			return nil, err
		}
	}

	mayGrowOnDescs, err := AsBlockDescriptorList(body["may_grow_on"], "may_grow_on")
	if err != nil {
		return nil, err
	}
	mayGrowOn := ResolveMatchSet(mayGrowOnDescs, ctx, "may_grow_on")
	// placeBaseBlock's fallback needs exactly one concrete block (a
	// PRODUCING use) -- may_grow_on's first descriptor, resolved the same
	// way places_block would be. Unlike the membership test above, this
	// does NOT need to be a real predicate: it is always the same, fixed
	// entry, never evaluated per-candidate.
	var mayGrowOnFallback block.ID
	if len(mayGrowOnDescs) > 0 {
		mayGrowOnFallback = ctx.Palette.Resolve(mayGrowOnDescs[0])
	}
	var baseBlock block.MatchSet
	var baseBlockFallback block.ID
	if raw, present := body["base_block"]; present {
		var baseBlocks []block.Descriptor
		var err error
		if _, isArray := raw.([]any); isArray {
			baseBlocks, err = AsBlockDescriptorList(raw, "base_block")
		} else {
			var desc block.Descriptor
			desc, err = AsBlockDescriptor(raw, "base_block")
			baseBlocks = []block.Descriptor{desc}
		}
		if err != nil {
			return nil, err
		}
		baseBlock = ResolveMatchSet(baseBlocks, ctx, "base_block")
		if len(baseBlocks) > 0 {
			baseBlockFallback = ctx.Palette.Resolve(baseBlocks[0])
			mayGrowOnFallback = baseBlockFallback
		}
	}

	mayReplaceDescs, err := AsBlockDescriptorList(body["may_replace"], "may_replace")
	if err != nil {
		return nil, err
	}
	mayReplace := ResolveMatchSet(mayReplaceDescs, ctx, "may_replace")

	// may_grow_through -- validated for every tree, and APPLIED for every bare
	// `trunk` file: the simple trunk's descent probe and its
	// below-original-origin log gate both consult it (placeSubmergedTrunk).
	// Unused (but harmless to resolve) on the seven <shape>_trunk keys.
	mayGrowThroughDescs, err := AsBlockDescriptorList(body["may_grow_through"], "may_grow_through")
	if err != nil {
		return nil, err
	}
	mayGrowThrough := ResolveMatchSet(mayGrowThroughDescs, ctx, "may_grow_through")
	// Say so when the field is written and this trunk kind will not read it. Only
	// placeSubmergedTrunk consults the top-level may_grow_through here; every other trunk path
	// gates its column on may_replace alone, because the game's spawn preparation -- the step
	// that uses both lists -- is approximated in this port rather than reproduced exactly (see
	// this file's header). Resolving the field and then ignoring it silently
	// is the specific thing the site's tree_feature page promises does not happen: "a file that
	// loads without warnings is one whose fields were all applied". Keeping that promise honest
	// costs one diagnostic; breaking it costs somebody a day wondering why their tree stops at a
	// block the field named.
	//
	// The plain `trunk` key (the simple trunk) always reads the field, so the warning fires
	// for exactly the seven <shape>_trunk keys.
	if !mayGrowThrough.Empty() && submerged == nil && ctx.Warn != nil {
		ctx.Warn("may_grow_through is set, but this trunk kind does not consult it in this tool -- " +
			"the trunk column is gated on may_replace alone, so cells this field would have allowed " +
			"the trunk to pass through are treated as blocking. The real game does apply it. The " +
			"paths here that do read it are the plain `trunk` key (always) and " +
			"mangrove_roots' own roots_may_grow_through. Expect this tree to stop short here " +
			"where the game would grow through.")
	}

	// base_cluster -- see baseCluster's own doc comment for the schema. Optional at this level; consumed only by placeMegaTrunk
	// (base_cluster is mega-trunk-specific -- see the warning below for
	// every other trunk kind).
	var baseClusterCfg *baseCluster
	if raw, present := body["base_cluster"]; present {
		baseClusterCfg, err = parseBaseCluster(raw, ctx)
		if err != nil {
			return nil, err
		}
	}

	trunkWidth := 1
	if shaped != nil {
		trunkWidth = shaped.width
	}
	// buildCanopyByKey is the shared <shape>_canopy dispatch, factored out of
	// this switch (previously operated directly on the top-level canopyBody/
	// canopyKey/trunkWidth) so mega_trunk's own branches.branch_canopy -- a
	// SEPARATE nested canopy from the tree's top-level one, unlike
	// cherry_trunk which has no top-level canopy of its own to conflict
	// with -- can reuse the EXACT same dispatch rather than duplicating it.
	// canopyBody/canopyKey/trunkWidth are now parameters (shadowing the
	// outer variables of the same name), so every case body below is
	// unchanged text. trunkWidth is passed explicitly (not just closure-
	// captured) because branch_canopy's own trunkSize is ALWAYS {1,1} (the
	// same hardcoded branch size this file's cherry_trunk/acacia_trunk
	// branches already use), independent of the tree's own trunk_width --
	// see the branch_canopy use below.
	buildCanopyByKey := func(canopyBody map[string]any, canopyKey string, trunkWidth int) (canopyPlacer, error) {
		var canopy canopyPlacer
		switch canopyKey {
		case "":
			// The cherry trunk's branch_canopy is optional. Without one, the
			// game's cherry trunk places no canopy at its tips.
		case "acacia_canopy":
			c, ok := canopyBody["acacia_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("acacia_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("acacia_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "acacia_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)
			canopySizeF, ok := c["canopy_size"].(float64)
			if !ok {
				return nil, fmt.Errorf("acacia_canopy.canopy_size must be a number")
			}
			simplifyCanopy, _ := c["simplify_canopy"].(bool)
			canopy = &acaciaCanopy{leafID: leafID, canopySize: int(canopySizeF), simplifyCanopy: simplifyCanopy}
		case "pine_canopy":
			c, ok := canopyBody["pine_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("pine_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("pine_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "pine_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)
			canopyHeightRaw, ok := c["canopy_height"]
			if !ok {
				return nil, fmt.Errorf("pine_canopy.canopy_height is required")
			}
			canopyHeightMin, canopyHeightMax, err := parseTreeIntRange(canopyHeightRaw, "pine_canopy.canopy_height")
			if err != nil {
				return nil, err
			}
			baseRadiusF, ok := c["base_radius"].(float64)
			if !ok {
				return nil, fmt.Errorf("pine_canopy.base_radius must be a number")
			}
			canopy = &pineCanopy{leafID: leafID, canopyHeightMin: canopyHeightMin, canopyHeightMax: canopyHeightMax, baseRadius: int(baseRadiusF)}
		case "canopy":
			c, ok := canopyBody["canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)
			offsetRaw, ok := c["canopy_offset"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("canopy.canopy_offset is required and must be an object")
			}
			offsetMinF, ok := offsetRaw["min"].(float64)
			if !ok {
				return nil, fmt.Errorf("canopy.canopy_offset.min is required and must be a number")
			}
			offsetMaxF, ok := offsetRaw["max"].(float64)
			if !ok {
				return nil, fmt.Errorf("canopy.canopy_offset.max is required and must be a number")
			}
			minWidth := 0
			if raw, present := c["min_width"]; present {
				minWidthF, ok := raw.(float64)
				if !ok {
					return nil, fmt.Errorf("canopy.min_width must be a number")
				}
				minWidth = int(minWidthF)
			}
			rise, run := 1, 1
			if raw, present := c["canopy_slope"]; present {
				slopeRaw, ok := raw.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("canopy.canopy_slope must be an object")
				}
				if riseRaw, present := slopeRaw["rise"]; present {
					riseF, ok := riseRaw.(float64)
					if !ok {
						return nil, fmt.Errorf("canopy.canopy_slope.rise must be a number")
					}
					rise = int(riseF)
				}
				if runRaw, present := slopeRaw["run"]; present {
					runF, ok := runRaw.(float64)
					if !ok {
						return nil, fmt.Errorf("canopy.canopy_slope.run must be a number")
					}
					run = int(runF)
				}
			}
			if run == 0 {
				// Defensive only -- not known game behaviour, just avoiding a
				// Go-side divide producing an implementation-defined float->int
				// conversion.
				return nil, fmt.Errorf("canopy.canopy_slope.run must be nonzero")
			}
			// An INVERTED canopy_offset -- max below min -- used to CRASH THE TOOL, and it is the
			// same shape, in the same kind of field, as the inverted search_volume that crashed it
			// before (features/search_feature.go's iterateInclusive, and the fixture spelling that
			// invites the swap). `canopy_offset: {"min": 2, "max": 0}` with any scalar or object
			// `variation_chance` made layerCount -1 and `make([]chanceInformation, -1)` panicked
			// with "makeslice: len out of range": a raw Go stack trace from the CLI, an opaque
			// "internal error" through serve, and `featurelab check` passing the file in silence.
			//
			// The placer's own loop (`for dy := offsetMin; dy <= offsetMax`) already visits nothing
			// when the pair is inverted, so no layers is what this canopy was always going to place
			// -- the crash was purely the allocation getting there first. Clamping the count at 0
			// makes the build agree with the placement instead of dying on the way. It is said out
			// loud because "this canopy places nothing" is not something to work out by elimination.
			//
			// What the GAME does with an inverted canopy_offset has NOT been established, so the
			// warning says that too, exactly as the search_volume one does.
			//
			// The count is also computed from the SAME truncated ints the placer indexes with,
			// rather than from `int(maxF - minF)`. Those two agree for every whole-number offset --
			// which is every offset any real file writes, and the only kind this field is
			// documented to take -- and disagree for a fractional one: `{"min": 0.5, "max": 2.0}`
			// made layerCount 2 while the placer walked three layers and ran off the end of
			// variationChance with "index out of range". Same field, second crash, opposite corner.
			layerCount := int(offsetMaxF) - int(offsetMinF) + 1
			if layerCount < 0 {
				layerCount = 0
			}
			if int(offsetMaxF) < int(offsetMinF) && ctx.Warn != nil {
				ctx.Warn(fmt.Sprintf("%s: canopy.canopy_offset runs from %d down to %d -- max is below "+
					"min, so this canopy has no layers and places no leaves at all. Did you mean to swap "+
					"them? What the real game does with an inverted canopy_offset has not been established "+
					"here, so do not read this tool's answer as the game's",
					ctx.Identifier, int(offsetMinF), int(offsetMaxF)))
			}
			var variation []chanceInformation
			if raw, present := c["variation_chance"]; present {
				switch values := raw.(type) {
				case []any:
					variation = make([]chanceInformation, len(values))
					for i, value := range values {
						parsed, err := parseChanceInformation(value, fmt.Sprintf("canopy.variation_chance[%d]", i))
						if err != nil {
							return nil, err
						}
						variation[i] = parsed
					}
				case map[string]any, float64:
					parsed, err := parseChanceInformation(values, "canopy.variation_chance")
					if err != nil {
						return nil, err
					}
					variation = make([]chanceInformation, layerCount)
					for i := range variation {
						variation[i] = parsed
					}
				default:
					return nil, fmt.Errorf("canopy.variation_chance must be a chance object, number, or array")
				}
				if len(variation) != layerCount {
					return nil, fmt.Errorf("canopy.variation_chance has %d entries, want %d (one per canopy layer)", len(variation), layerCount)
				}
			}
			var decoration *canopyDecoration
			if raw, present := c["canopy_decoration"]; present {
				obj, ok := raw.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("canopy.canopy_decoration must be an object")
				}
				blockRaw, ok := obj["decoration_block"]
				if !ok {
					return nil, fmt.Errorf("canopy.canopy_decoration.decoration_block is required")
				}
				desc, err := AsBlockDescriptor(blockRaw, "canopy.canopy_decoration.decoration_block")
				if err != nil {
					return nil, err
				}
				chance, err := parseChanceInformation(obj["decoration_chance"], "canopy.canopy_decoration.decoration_chance")
				if err != nil {
					return nil, err
				}
				stepsMin, stepsMax, err := parseTreeIntRange(obj["num_steps"], "canopy.canopy_decoration.num_steps")
				if err != nil {
					return nil, err
				}
				stepDirection, ok := obj["step_direction"].(string)
				if !ok || stepDirection != "down" {
					return nil, fmt.Errorf("canopy.canopy_decoration.step_direction must be %q; other native modes are not confirmed", "down")
				}
				decoration = &canopyDecoration{blockID: ctx.Palette.Resolve(desc), chance: chance, stepsMin: stepsMin, stepsMax: stepsMax, pal: ctx.Palette}
			}
			canopy = &simpleCanopy{
				leafID:          leafID,
				offsetMin:       int(offsetMinF),
				offsetMax:       int(offsetMaxF),
				minWidth:        minWidth,
				rise:            rise,
				run:             run,
				variationChance: variation,
				decoration:      decoration,
			}
		case "cherry_canopy":
			c, ok := canopyBody["cherry_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("cherry_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("cherry_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "cherry_canopy.leaf_block")
			if err != nil {
				return nil, err
			}

			heightRaw, ok := c["height"]
			if !ok {
				return nil, fmt.Errorf("cherry_canopy.height is required")
			}
			heightMin, heightMax, err := parseTreeIntRange(heightRaw, "cherry_canopy.height")
			if err != nil {
				return nil, err
			}
			if heightMin < 4 || heightMax < 4 {
				return nil, fmt.Errorf("cherry_canopy.height values must be >= 4")
			}

			radiusRaw, ok := c["radius"]
			if !ok {
				return nil, fmt.Errorf("cherry_canopy.radius is required")
			}
			radiusMin, radiusMax, err := parseTreeIntRange(radiusRaw, "cherry_canopy.radius")
			if err != nil {
				return nil, err
			}
			if radiusMin < 3 || radiusMax < 3 {
				return nil, fmt.Errorf("cherry_canopy.radius values must be >= 3")
			}

			trunkWidth := 1 // inline factory default
			if raw, present := c["trunk_width"]; present {
				f, ok := toFloat(raw)
				if !ok {
					return nil, fmt.Errorf("cherry_canopy.trunk_width must be a number")
				}
				trunkWidth = int(f)
			}
			if trunkWidth != 1 {
				return nil, fmt.Errorf("cherry_canopy.trunk_width must be 1 (this port's trunk always reports a branch size of {1,1} -- see tree.go header)")
			}

			parseRequiredChance := func(key string) (chanceInformation, error) {
				raw, present := c[key]
				if !present {
					return chanceInformation{}, fmt.Errorf("cherry_canopy.%s is required", key)
				}
				return parseChanceInformation(raw, "cherry_canopy."+key)
			}
			wideBottom, err := parseRequiredChance("wide_bottom_layer_hole_chance")
			if err != nil {
				return nil, err
			}
			corner, err := parseRequiredChance("corner_hole_chance")
			if err != nil {
				return nil, err
			}
			hanging, err := parseRequiredChance("hanging_leaves_chance")
			if err != nil {
				return nil, err
			}
			extension, err := parseRequiredChance("hanging_leaves_extension_chance")
			if err != nil {
				return nil, err
			}

			canopy = &cherryCanopy{
				leafID:                       ctx.Palette.Resolve(leafDesc),
				heightMin:                    heightMin,
				heightMax:                    heightMax,
				radiusMin:                    radiusMin,
				radiusMax:                    radiusMax,
				trunkWidth:                   trunkWidth,
				wideBottomHoleChance:         wideBottom,
				cornerHoleChance:             corner,
				hangingLeavesChance:          hanging,
				hangingLeavesExtensionChance: extension,
			}
		case "fancy_canopy":
			c, ok := canopyBody["fancy_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("fancy_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("fancy_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "fancy_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)
			heightF, ok := c["height"].(float64)
			if !ok {
				return nil, fmt.Errorf("fancy_canopy.height is required and must be a number")
			}
			height := int(heightF)
			if height < 0 {
				// Unsupported -- see the file header. height<0 is a malformed
				// range the game treats as an error; what happens past
				// that point is unknown, so it is refused.
				return nil, fmt.Errorf("fancy_canopy.height must be >= 0")
			}
			// radius is optional in the game, but its default value is not
			// known -- this port requires it explicitly rather than guess.
			radiusF, ok := c["radius"].(float64)
			if !ok {
				return nil, fmt.Errorf(
					"fancy_canopy.radius is required by this port -- the game treats it as optional, but its " +
						"default value is not known (see tree.go header)")
			}
			radius := int(radiusF)
			if radius < 1 {
				// Unsupported -- see the file header. radius<1 makes the
				// FIRST/LAST layer's radius-1 negative, a malformed range the
				// game treats as an error; what happens past that point is
				// unknown, so it is refused.
				return nil, fmt.Errorf("fancy_canopy.radius must be >= 1")
			}
			canopy = &fancyCanopy{leafID: leafID, height: height, radius: radius}
		case "spruce_canopy":
			c, ok := canopyBody["spruce_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("spruce_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("spruce_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "spruce_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)

			lowerRaw, ok := c["lower_offset"]
			if !ok {
				return nil, fmt.Errorf("spruce_canopy.lower_offset is required")
			}
			lowerMin, lowerMax, err := parseTreeIntRange(lowerRaw, "spruce_canopy.lower_offset")
			if err != nil {
				return nil, err
			}

			// upper_offset is optional in the game but -- same situation as
			// fancy_canopy's "radius" -- its default is not known, so this port
			// requires it explicitly rather than guess.
			upperRaw, ok := c["upper_offset"]
			if !ok {
				return nil, fmt.Errorf(
					"spruce_canopy.upper_offset is required by this port -- the game treats it as optional, " +
						"but its default value is not known (see tree.go header)")
			}
			upperMin, upperMax, err := parseTreeIntRange(upperRaw, "spruce_canopy.upper_offset")
			if err != nil {
				return nil, err
			}

			radiusRaw, ok := c["max_radius"]
			if !ok {
				return nil, fmt.Errorf("spruce_canopy.max_radius is required")
			}
			radiusMin, radiusMax, err := parseTreeIntRange(radiusRaw, "spruce_canopy.max_radius")
			if err != nil {
				return nil, err
			}

			canopy = &spruceCanopy{
				leafID:    leafID,
				lowerMin:  lowerMin,
				lowerMax:  lowerMax,
				upperMin:  upperMin,
				upperMax:  upperMax,
				radiusMin: radiusMin,
				radiusMax: radiusMax,
			}
		case "random_spread_canopy":
			c, ok := canopyBody["random_spread_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("random_spread_canopy must be an object")
			}
			heightRaw, ok := c["canopy_height"]
			if !ok {
				return nil, fmt.Errorf("random_spread_canopy.canopy_height is required")
			}
			heightMin, heightMax, err := parseTreeIntRange(heightRaw, "random_spread_canopy.canopy_height")
			if err != nil {
				return nil, err
			}
			radiusRaw, ok := c["canopy_radius"]
			if !ok {
				return nil, fmt.Errorf("random_spread_canopy.canopy_radius is required")
			}
			radiusMin, radiusMax, err := parseTreeIntRange(radiusRaw, "random_spread_canopy.canopy_radius")
			if err != nil {
				return nil, err
			}
			attemptsF, ok := c["leaf_placement_attempts"].(float64)
			if !ok {
				return nil, fmt.Errorf("random_spread_canopy.leaf_placement_attempts is required and must be a number")
			}
			attempts := int(attemptsF)
			if attempts < 0 {
				// Unsupported -- see the file header. leaf_placement_attempts<0
				// is the same malformed-range error every other guard in this
				// file refuses, rather than guess what the game does past it.
				return nil, fmt.Errorf("random_spread_canopy.leaf_placement_attempts must be >= 0")
			}
			blocksRaw, ok := c["leaf_blocks"]
			if !ok {
				return nil, fmt.Errorf("random_spread_canopy.leaf_blocks is required")
			}
			blocksArr, ok := blocksRaw.([]any)
			if !ok || len(blocksArr) == 0 {
				// The game's weight sum always reads the first entry, even for
				// an empty list (undefined behaviour) -- refused rather than
				// guessed. See the file header.
				return nil, fmt.Errorf("random_spread_canopy.leaf_blocks must be a non-empty array")
			}
			blocks := make([]randomSpreadWeightedBlock, len(blocksArr))
			for i, v := range blocksArr {
				p := fmt.Sprintf("random_spread_canopy.leaf_blocks[%d]", i)
				tuple, ok := v.([]any)
				if !ok || len(tuple) != 2 {
					return nil, fmt.Errorf("%s must be a [blockDescriptor, weight] tuple", p)
				}
				desc, err := AsBlockDescriptor(tuple[0], p+"[0]")
				if err != nil {
					return nil, err
				}
				w, ok := toFloat(tuple[1])
				if !ok {
					return nil, fmt.Errorf("%s[1] (weight) must be a number", p)
				}
				blocks[i] = randomSpreadWeightedBlock{id: ctx.Palette.Resolve(desc), weight: float32(w)}
			}
			canopy = &randomSpreadCanopy{
				heightMin: heightMin,
				heightMax: heightMax,
				radiusMin: radiusMin,
				radiusMax: radiusMax,
				attempts:  attempts,
				blocks:    blocks,
			}
		case "poplar_canopy":
			// The poplar canopy -- see the Poplar section doc comments for the
			// schema (fields, required keys and defaults).
			c, ok := canopyBody["poplar_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("poplar_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("poplar_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "poplar_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			branchRaw, ok := c["branch_block"]
			if !ok {
				return nil, fmt.Errorf("poplar_canopy.branch_block is required")
			}
			branchDesc, err := AsBlockDescriptor(branchRaw, "poplar_canopy.branch_block")
			if err != nil {
				return nil, err
			}
			branchID := ctx.Palette.Resolve(branchDesc)
			// Branch logs get pillar_axis forced per cell axis -- the same
			// build-time x/z resolution cherry_trunk already uses (the game
			// sets pillar_axis per cell, see
			// poplarCanopy.replaceLeavesWithLog's doc comment).
			branchEntry := ctx.Palette.Entry(branchID)
			axisBranch := func(axis string) block.ID {
				states := make(map[string]block.StateValue, len(branchEntry.States)+1)
				for key, value := range branchEntry.States {
					states[key] = value
				}
				states["pillar_axis"] = axis
				return ctx.Palette.Resolve(block.Descriptor{Name: branchEntry.Name, States: states})
			}
			pc := &poplarCanopy{
				leafID:     ctx.Palette.Resolve(leafDesc),
				branchX:    axisBranch("x"),
				branchZ:    axisBranch("z"),
				trunkWidth: 1, // default
				pal:        ctx.Palette,
			}
			radiusRaw, present := c["radius"]
			if !present {
				return nil, fmt.Errorf("poplar_canopy.radius is required")
			}
			radiusArr, ok := radiusRaw.([]any)
			if !ok || len(radiusArr) == 0 {
				// The game requires at least one entry and reports an error
				// for an empty weighted radius list -- reject at build time
				// rather than reproduce the error path.
				return nil, fmt.Errorf("poplar_canopy.radius must be a non-empty array of {value, weight} entries")
			}
			for i, entryRaw := range radiusArr {
				obj, ok := entryRaw.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("poplar_canopy.radius[%d] must be an object", i)
				}
				valueF, ok := obj["value"].(float64)
				if !ok {
					// "value" has no default -- required.
					return nil, fmt.Errorf("poplar_canopy.radius[%d].value is required and must be a number", i)
				}
				entry := poplarWeightedInt{value: int(valueF), weight: 1} // weight defaults to 1
				if weightRaw, present := obj["weight"]; present {
					weightF, ok := weightRaw.(float64)
					if !ok {
						return nil, fmt.Errorf("poplar_canopy.radius[%d].weight must be a number", i)
					}
					entry.weight = int(weightF)
				}
				pc.radius = append(pc.radius, entry)
			}
			heightRaw, present := c["height"]
			if !present {
				return nil, fmt.Errorf("poplar_canopy.height is required")
			}
			pc.heightMin, pc.heightMax, err = parseTreeIntRange(heightRaw, "poplar_canopy.height")
			if err != nil {
				return nil, err
			}
			if raw, present := c["side_hole_chance"]; present {
				chanceF, ok := toFloat(raw)
				if !ok {
					return nil, fmt.Errorf("poplar_canopy.side_hole_chance must be a number")
				}
				pc.sideHoleChance = float32(chanceF)
			}
			if raw, present := c["trunk_width"]; present {
				widthF, ok := raw.(float64)
				if !ok {
					return nil, fmt.Errorf("poplar_canopy.trunk_width must be a number")
				}
				// The game converts int(float(w)) -- identity for every
				// representable JSON int.
				pc.trunkWidth = int(widthF)
			}
			canopy = pc
		case "roofed_canopy":
			c, ok := canopyBody["roofed_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("roofed_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("roofed_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "roofed_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)

			canopyHeightF, ok := c["canopy_height"].(float64)
			if !ok {
				return nil, fmt.Errorf("roofed_canopy.canopy_height is required and must be a number")
			}
			canopyHeight := int(canopyHeightF)
			if canopyHeight < 0 {
				// A negative height is a malformed range in the game -- refused
				// rather than guessed, the same policy as every other
				// malformed-range guard in this file. See the file header.
				return nil, fmt.Errorf("roofed_canopy.canopy_height must be >= 0")
			}

			coreWidthF, ok := c["core_width"].(float64)
			if !ok {
				return nil, fmt.Errorf("roofed_canopy.core_width is required and must be a number")
			}
			if int(coreWidthF) != trunkWidth {
				return nil, fmt.Errorf("roofed_canopy.core_width (%d) must match trunk width (%d)", int(coreWidthF), trunkWidth)
			}

			outerRadiusF, ok := c["outer_radius"].(float64)
			if !ok {
				// Optional in the game, but its default is unknown -- required
				// here rather than guessed, matching fancy_canopy's "radius".
				// See the file header.
				return nil, fmt.Errorf("roofed_canopy.outer_radius is required by this port (default unknown -- see tree.go header)")
			}
			outerRadius := int(outerRadiusF)
			if outerRadius < -1 {
				return nil, fmt.Errorf("roofed_canopy.outer_radius must be >= -1")
			}

			innerRadiusF, ok := c["inner_radius"].(float64)
			if !ok {
				return nil, fmt.Errorf("roofed_canopy.inner_radius is required by this port (default unknown -- see tree.go header)")
			}
			innerRadius := int(innerRadiusF)
			if innerRadius < 0 {
				return nil, fmt.Errorf("roofed_canopy.inner_radius must be >= 0")
			}

			canopy = &roofedCanopy{
				leafID:       leafID,
				canopyHeight: canopyHeight,
				outerRadius:  outerRadius,
				innerRadius:  innerRadius,
				coreWidth:    int(coreWidthF),
			}
		case "mangrove_canopy":
			c, ok := canopyBody["mangrove_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy must be an object")
			}
			var canopyDecorationField *megaTrunkDecoration
			if decRaw, present := c["canopy_decoration"]; present {
				parsedDecoration, err := parseAttachableDecorationObject(decRaw, "mangrove_canopy.canopy_decoration", ctx)
				if err != nil {
					return nil, err
				}
				canopyDecorationField = parsedDecoration
			}

			heightRaw, ok := c["canopy_height"]
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy.canopy_height is required")
			}
			heightMin, heightMax, err := parseTreeIntRange(heightRaw, "mangrove_canopy.canopy_height")
			if err != nil {
				return nil, err
			}
			radiusRaw, ok := c["canopy_radius"]
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy.canopy_radius is required")
			}
			radiusMin, radiusMax, err := parseTreeIntRange(radiusRaw, "mangrove_canopy.canopy_radius")
			if err != nil {
				return nil, err
			}
			attemptsF, ok := c["leaf_placement_attempts"].(float64)
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy.leaf_placement_attempts is required and must be a number")
			}
			attempts := int(attemptsF)
			if attempts < 0 {
				// Unsupported -- see the file header. The same malformed-range
				// error every other guard in this file refuses.
				return nil, fmt.Errorf("mangrove_canopy.leaf_placement_attempts must be >= 0")
			}
			blocksRaw, ok := c["leaf_blocks"]
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy.leaf_blocks is required")
			}
			blocksArr, ok := blocksRaw.([]any)
			if !ok || len(blocksArr) == 0 {
				return nil, fmt.Errorf("mangrove_canopy.leaf_blocks must be a non-empty array")
			}
			leafBlocks := make([]randomSpreadWeightedBlock, len(blocksArr))
			for i, v := range blocksArr {
				p := fmt.Sprintf("mangrove_canopy.leaf_blocks[%d]", i)
				tuple, ok := v.([]any)
				if !ok || len(tuple) != 2 {
					return nil, fmt.Errorf("%s must be a [blockDescriptor, weight] tuple", p)
				}
				desc, err := AsBlockDescriptor(tuple[0], p+"[0]")
				if err != nil {
					return nil, err
				}
				w, ok := toFloat(tuple[1])
				if !ok {
					return nil, fmt.Errorf("%s[1] (weight) must be a number", p)
				}
				leafBlocks[i] = randomSpreadWeightedBlock{id: ctx.Palette.Resolve(desc), weight: float32(w)}
			}

			hangingRaw, ok := c["hanging_block"]
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy.hanging_block is required")
			}
			hangingDesc, err := AsBlockDescriptor(hangingRaw, "mangrove_canopy.hanging_block")
			if err != nil {
				return nil, err
			}
			hangingID := ctx.Palette.Resolve(hangingDesc)

			chanceRaw, ok := c["hanging_block_placement_chance"]
			if !ok {
				return nil, fmt.Errorf("mangrove_canopy.hanging_block_placement_chance is required")
			}
			chance, err := parseChanceInformation(chanceRaw, "mangrove_canopy.hanging_block_placement_chance")
			if err != nil {
				return nil, err
			}

			canopy = &mangroveCanopy{
				heightMin:     heightMin,
				heightMax:     heightMax,
				radiusMin:     radiusMin,
				radiusMax:     radiusMax,
				attempts:      attempts,
				leafBlocks:    leafBlocks,
				hangingBlock:  hangingID,
				hangingChance: chance,
				decoration:    canopyDecorationField,
			}
		case "mega_canopy":
			c, ok := canopyBody["mega_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("mega_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("mega_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "mega_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)

			heightRaw, ok := c["canopy_height"]
			if !ok {
				return nil, fmt.Errorf("mega_canopy.canopy_height is required")
			}
			heightMin, heightMax, err := parseTreeIntRange(heightRaw, "mega_canopy.canopy_height")
			if err != nil {
				return nil, err
			}

			// Optional, DEFAULT 2 -- unlike fancy_canopy's "radius"/roofed_canopy's
			// radii, which this port requires for lack of a known default.
			baseRadius := 2
			if v, present := c["base_radius"]; present {
				f, ok := toFloat(v)
				if !ok {
					return nil, fmt.Errorf("mega_canopy.base_radius must be a number")
				}
				baseRadius = int(f)
			}
			if baseRadius < 0 {
				// Deterministic (no RNG) lower bound: dy=0 always occurs whenever
				// value>0 (the topmost layer), where radius==baseRadius exactly
				// -- so a negative baseRadius trips placeRadialBlockGroup's own
				// malformed-range guard for EVERY tree, not just an unlucky
				// draw. Caught here for a clearer diagnostic; also independently
				// enforced at runtime by placeRadialBlockGroup itself.
				return nil, fmt.Errorf("mega_canopy.base_radius must be >= 0")
			}

			coreWidthF, ok := c["core_width"].(float64)
			if !ok {
				return nil, fmt.Errorf("mega_canopy.core_width is required and must be a number")
			}
			if int(coreWidthF) != trunkWidth {
				return nil, fmt.Errorf("mega_canopy.core_width (%d) must match trunk width (%d)", int(coreWidthF), trunkWidth)
			}

			simplifyCanopy := false
			if v, present := c["simplify_canopy"]; present {
				b, ok := v.(bool)
				if !ok {
					return nil, fmt.Errorf("mega_canopy.simplify_canopy must be a boolean")
				}
				simplifyCanopy = b
			}

			canopy = &megaCanopy{
				leafID:          leafID,
				canopyHeightMin: heightMin,
				canopyHeightMax: heightMax,
				baseRadius:      baseRadius,
				simplifyCanopy:  simplifyCanopy,
				coreWidth:       int(coreWidthF),
				pal:             ctx.Palette,
			}
		case "mega_pine_canopy":
			c, ok := canopyBody["mega_pine_canopy"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("mega_pine_canopy must be an object")
			}
			leafRaw, ok := c["leaf_block"]
			if !ok {
				return nil, fmt.Errorf("mega_pine_canopy.leaf_block is required")
			}
			leafDesc, err := AsBlockDescriptor(leafRaw, "mega_pine_canopy.leaf_block")
			if err != nil {
				return nil, err
			}
			leafID := ctx.Palette.Resolve(leafDesc)

			heightRaw, ok := c["canopy_height"]
			if !ok {
				return nil, fmt.Errorf("mega_pine_canopy.canopy_height is required")
			}
			heightMin, heightMax, err := parseTreeIntRange(heightRaw, "mega_pine_canopy.canopy_height")
			if err != nil {
				return nil, err
			}

			// Optional, DEFAULT 2 -- the same default as mega_canopy's own
			// base_radius.
			baseRadius := 2
			if v, present := c["base_radius"]; present {
				f, ok := toFloat(v)
				if !ok {
					return nil, fmt.Errorf("mega_pine_canopy.base_radius must be a number")
				}
				baseRadius = int(f)
			}
			if baseRadius < 0 {
				// Same deterministic lower bound as mega_canopy's own: dy=0
				// always occurs and radius==baseRadius exactly there (see
				// megaPineRadiusFor's own doc comment), so a negative
				// baseRadius trips placeRadialBlockGroup's malformed-range
				// guard for EVERY tree.
				return nil, fmt.Errorf("mega_pine_canopy.base_radius must be >= 0")
			}

			// Optional, DEFAULT 3.5.
			radiusStepModifier := float32(3.5)
			if v, present := c["radius_step_modifier"]; present {
				f, ok := toFloat(v)
				if !ok {
					return nil, fmt.Errorf("mega_pine_canopy.radius_step_modifier must be a number")
				}
				radiusStepModifier = float32(f)
			}

			coreWidthF, ok := c["core_width"].(float64)
			if !ok {
				return nil, fmt.Errorf("mega_pine_canopy.core_width is required and must be a number")
			}
			if int(coreWidthF) != trunkWidth {
				return nil, fmt.Errorf("mega_pine_canopy.core_width (%d) must match trunk width (%d)", int(coreWidthF), trunkWidth)
			}

			canopy = &megaPineCanopy{
				leafID:             leafID,
				canopyHeightMin:    heightMin,
				canopyHeightMax:    heightMax,
				baseRadius:         baseRadius,
				radiusStepModifier: radiusStepModifier,
				coreWidth:          int(coreWidthF),
				pal:                ctx.Palette,
			}
		default:
			return nil, fmt.Errorf("minecraft:tree_feature: canopy %q is recognized but has no builder", canopyKey)
		}
		return canopy, nil
	}
	canopy, err := buildCanopyByKey(canopyBody, canopyKey, trunkWidth)
	if err != nil {
		return nil, err
	}

	// shaped.branches (mega_trunk only) is mega_trunk's own
	// branches.branch_canopy -- parsed via the SAME buildCanopyByKey dispatch
	// above (not a second, invented path), scoped to its own nested body/key
	// exactly the way cherry_trunk's branches.branch_canopy already
	// redirects canopyBody/canopyKey (see above). nil unless
	// trunkKind=="mega_trunk" AND branches.branch_canopy is present.
	if shaped != nil && shaped.branches != nil && shaped.branches.canopyBody != nil {
		// trunkWidth=1 -- branch tips always report a branch size of {1,1}, the
		// same hardcoded literal cherry_trunk's own per-tip canopy calls
		// already use (see cherryTrunk's doc comment), distinct from the
		// tree's own trunk_width -- vanilla mega_jungle_tree_feature.json
		// shows this: its branches.branch_canopy.
		// mega_canopy omits core_width entirely, unlike the top-level
		// mega_canopy sibling key, which always sets it equal to
		// trunk_width. buildCanopyByKey's own "mega_canopy" case keeps
		// core_width UNCONDITIONALLY required (matching the top-level
		// key's own real schema, still enforced by
		// TestBuildTreeFeature_MegaCanopyKey_SchemaValidation), so this
		// synthesizes the field here -- ONLY when the branch canopy itself
		// omits it -- rather than relaxing the shared dispatch for every
		// caller.
		if mc, ok := shaped.branches.canopyBody["mega_canopy"].(map[string]any); ok {
			if _, present := mc["core_width"]; !present {
				mc["core_width"] = float64(1)
			}
		}
		shaped.branches.canopy, err = buildCanopyByKey(shaped.branches.canopyBody, shaped.branches.canopyKey, 1)
		if err != nil {
			return nil, err
		}
	}

	// acacia_trunk's own branches.branch_canopy, resolved through the same
	// dispatch. trunkWidth=1 for the same reason mega's branch tips use it:
	// both trunk shapes give their branch canopies a fixed branch size of {1,1},
	// not the tree's trunk_width.
	if shaped != nil && shaped.acaciaBranches != nil && shaped.acaciaBranches.canopyBody != nil {
		if mc, ok := shaped.acaciaBranches.canopyBody["mega_canopy"].(map[string]any); ok {
			if _, present := mc["core_width"]; !present {
				mc["core_width"] = float64(1)
			}
		}
		shaped.acaciaBranches.canopy, err = buildCanopyByKey(shaped.acaciaBranches.canopyBody, shaped.acaciaBranches.canopyKey, 1)
		if err != nil {
			return nil, err
		}
	}

	// trunk_decoration is genuinely applied for shaped (mega_trunk) and mangrove (mangrove_trunk)
	// alike -- both parse it via the SAME parseAttachableDecorationObject/megaTrunkDecoration
	// machinery (see mangroveTrunk's own doc comment). Only warn when it was present in the JSON but
	// NEITHER trunk struct actually picked it up.
	// The plain `trunk` key's own trunk_decoration -- see TreeFeature.trunkDecoration.
	var simpleDecoration *megaTrunkDecoration
	if trunkKind == "trunk" {
		if raw, present := trunk["trunk_decoration"]; present {
			simpleDecoration, err = parseAttachableDecorationObject(raw, "trunk.trunk_decoration", ctx)
			if err != nil {
				return nil, err
			}
		}
	}
	trunkDecorationApplied := (shaped != nil && shaped.decoration != nil) || (mangrove != nil && mangrove.decoration != nil) ||
		(fallen != nil && fallen.decoration != nil) || (poplar != nil && poplar.decoration != nil) || simpleDecoration != nil
	var warnings []string
	if _, present := trunk["trunk_decoration"]; present && !trunkDecorationApplied {
		warnings = append(warnings, trunkKind+".trunk_decoration is not implemented; trunk blocks are placed without its decoration")
	}
	logDecorationApplied := (fallen != nil && fallen.logDecorationRef != "") ||
		(poplar != nil && poplar.logDecorationRef != "")
	if _, present := trunk["log_decoration_feature"]; present && !logDecorationApplied {
		warnings = append(warnings, trunkKind+".log_decoration_feature is not implemented; the referenced feature is not invoked")
	}
	// `branches` is now implemented for all three trunk shapes that have one:
	// mega_trunk (shaped.branches), acacia_trunk (shaped.acaciaBranches) and
	// fancy_trunk (whose three fields live directly on shapedTrunk, since
	// the fancy trunk stores them flat rather than in a sub-object). The warning is
	// kept rather than deleted because a future trunk shape with a `branches` key
	// would otherwise be accepted in silence.
	fancyBranchesApplied := shaped != nil && shaped.kind == "fancy_trunk"
	if _, present := trunk["branches"]; present && shaped != nil && shaped.branches == nil &&
		shaped.acaciaBranches == nil && !fancyBranchesApplied {
		warnings = append(warnings, trunkKind+".branches is not implemented; only the main trunk and top canopy are placed")
	}
	// mangrove_roots needs no warning: the root pass runs for ALL EIGHT trunk kinds -- the game
	// applies roots whenever they are present, with no per-shape branch (see
	// TreeFeature.applyRoots).
	//
	// base_cluster is mega-trunk-specific (only the mega trunk's placement
	// uses it -- see baseCluster's own doc comment); warn only when it was
	// present in the JSON but the trunk isn't the "mega_trunk" shape that
	// actually consumes it.
	baseClusterApplied := shaped != nil && shaped.kind == "mega_trunk" && baseClusterCfg != nil
	if _, present := body["base_cluster"]; present && !baseClusterApplied {
		warnings = append(warnings, "base_cluster is implemented but only mega_trunk consumes it "+
			"(the game only uses it there, not a limitation here) -- ground clusters "+
			"are omitted for this trunk shape")
	}

	return &TreeFeature{
		identifier:        ctx.Identifier,
		trunkBlock:        trunkBlockID,
		trunkHeight:       int(trunkHeightF), // unused when submerged != nil
		canopy:            canopy,
		mayGrowOn:         mayGrowOn,
		mayGrowOnFallback: mayGrowOnFallback,
		baseBlock:         baseBlock,
		baseBlockFallback: baseBlockFallback,
		mayReplace:        mayReplace,
		mayGrowThrough:    mayGrowThrough,
		submergedTrunk:    submerged,
		trunkDecoration:   simpleDecoration,
		cherryTrunk:       cherry,
		mangroveTrunk:     mangrove,
		roots:             roots,
		fallen:            fallen,
		poplar:            poplar,
		shaped:            shaped,
		baseCluster:       baseClusterCfg,
		warnings:          warnings,
	}, nil
}

// parseMangroveRoots parses the "mangrove_roots" object into a *mangroveRoots
// -- see mangroveRoots' own doc comment for the field set and
// mangroveRootsPlace for the algorithm. max_root_width, max_root_length,
// root_block, muddy_root_block, mud_block, y_offset and
// roots_may_grow_through are required; above_root and root_decoration are
// optional.
func parseMangroveRoots(m map[string]any, ctx *BuildContext) (*mangroveRoots, error) {
	r := &mangroveRoots{}

	widthF, ok := m["max_root_width"].(float64)
	if !ok {
		return nil, fmt.Errorf("mangrove_roots.max_root_width is required and must be a number")
	}
	r.maxRootWidth = int(widthF)

	lengthF, ok := m["max_root_length"].(float64)
	if !ok {
		return nil, fmt.Errorf("mangrove_roots.max_root_length is required and must be a number")
	}
	r.maxRootLength = int(lengthF)

	rootBlockRaw, ok := m["root_block"]
	if !ok {
		return nil, fmt.Errorf("mangrove_roots.root_block is required")
	}
	rootBlockDesc, err := AsBlockDescriptor(rootBlockRaw, "mangrove_roots.root_block")
	if err != nil {
		return nil, err
	}
	r.rootBlock = ctx.Palette.Resolve(rootBlockDesc)

	muddyRaw, ok := m["muddy_root_block"]
	if !ok {
		return nil, fmt.Errorf("mangrove_roots.muddy_root_block is required")
	}
	muddyDesc, err := AsBlockDescriptor(muddyRaw, "mangrove_roots.muddy_root_block")
	if err != nil {
		return nil, err
	}
	r.muddyRootBlock = ctx.Palette.Resolve(muddyDesc)

	mudRaw, ok := m["mud_block"]
	if !ok {
		return nil, fmt.Errorf("mangrove_roots.mud_block is required")
	}
	mudDesc, err := AsBlockDescriptor(mudRaw, "mangrove_roots.mud_block")
	if err != nil {
		return nil, err
	}
	r.mudBlock = ctx.Palette.Resolve(mudDesc)

	yOffsetRaw, ok := m["y_offset"]
	if !ok {
		return nil, fmt.Errorf("mangrove_roots.y_offset is required")
	}
	yMin, yMax, err := parseTreeIntRange(yOffsetRaw, "mangrove_roots.y_offset")
	if err != nil {
		return nil, err
	}
	r.yOffsetMin, r.yOffsetMax = yMin, yMax

	growThroughDescs, err := AsBlockDescriptorList(m["roots_may_grow_through"], "mangrove_roots.roots_may_grow_through")
	if err != nil {
		return nil, err
	}
	if len(growThroughDescs) == 0 {
		return nil, fmt.Errorf("mangrove_roots.roots_may_grow_through is required")
	}
	r.rootsMayGrowThrough = ResolveMatchSet(growThroughDescs, ctx, "mangrove_roots.roots_may_grow_through")

	// above_root -- optional object, {above_root_chance, above_root_block},
	// both themselves optional within it. Absent/omitted-block leaves
	// hasAboveRootBlock false, a proven no-op (see mangrovePlaceRoot).
	if aboveRaw, present := m["above_root"]; present {
		aboveObj, ok := aboveRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("mangrove_roots.above_root must be an object")
		}
		if chanceRaw, present := aboveObj["above_root_chance"]; present {
			chance, err := parseChanceInformation(chanceRaw, "mangrove_roots.above_root.above_root_chance")
			if err != nil {
				return nil, err
			}
			r.aboveRootChance = chance
		}
		if blockRaw, present := aboveObj["above_root_block"]; present {
			aboveDesc, err := AsBlockDescriptor(blockRaw, "mangrove_roots.above_root.above_root_block")
			if err != nil {
				return nil, err
			}
			r.aboveRootBlock = ctx.Palette.Resolve(aboveDesc)
			r.hasAboveRootBlock = true
		}
	}

	// root_decoration (an attachable decoration). See mangrovePlaceRoot's own
	// doc comment for the three places the single-root write applies it.
	if decRaw, present := m["root_decoration"]; present {
		decoration, err := parseAttachableDecorationObject(decRaw, `"mangrove_roots".root_decoration`, ctx)
		if err != nil {
			return nil, err
		}
		r.decoration = decoration
	}

	return r, nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func init() {
	RegisterType(treeTypeID, buildTreeFeature)
}

var _ wgen.IFeature = (*TreeFeature)(nil)

// --- fancy_trunk ---------------------------------------------------------------------------
//
// The fancy trunk's placement with its two helpers -- the clear-line check
// and the limb placement. This is
// the "big tree" shape: instead of one column plus a crown, it computes a set of
// FOLIAGE COORDINATES scattered on a semicircular profile, grows a canopy at each,
// and then draws a LIMB from the trunk to each one.
//
// Fields:
//
//	trunk_height.base            int
//	trunk_height.variance        int
//	trunk_width                  int
//	trunk_height.scale           float
//	branches.slope               float
//	branches.density             float
//	branches.min_altitude_factor float
//	foliage_altitude_factor      float
//	trunk_block                  block descriptor
//	width_scale                  float
//
// ALL of them affect placement, so unlike trunk_decoration.num_steps there is no dead field here to accept-and-discard.
// Every one is also schema-REQUIRED, `branches` included -- the sharpest contrast with
// acacia_trunk, whose `branches` is optional.
//
// TWO THINGS THAT READ BACKWARDS and are the most likely source of a future regression:
//
//  1. The clear-line check returns **-1 when the line is CLEAR**, and otherwise the index
//     of the
//     first blocked cell. fancyCheckLine below keeps that convention rather than
//     "improving" it to a bool, so the comparison against trunk_height.base stays
//     easy to follow.
//  2. A blocked trunk line **SHORTENS the tree** instead of failing it: if the blocked
//     index exceeds trunk_height.base, that index becomes the height. Only a line
//     blocked at or below `base` aborts the whole feature.
//
// Draw order, per accepted OR rejected cluster (both draws always happen, before any
// validation): NextFloat for the distance, then NextFloat for the angle. sin drives X
// and cos drives Z -- the opposite of the usual convention, pinned by its own test.

// fancyFoliage is the fancy trunk's foliage coordinate record -- the cluster
// position plus the trunk height the limb to it attaches at.
type fancyFoliage struct {
	pos     wgen.BlockPos
	attachY int
}

// fancyAbsMax is the game's two-argument magnitude-max: the larger MAGNITUDE,
// with the sign DISCARDED (|a| vs |b|, always >= 0).
//
// Keeping the sign would be a real bug, not a cosmetic one: both callers compute a step count as
// fancyAbsMax(fancyAbsMax(dx,dy),dz) and then loop `for i := 0; i <= steps`, so every line whose
// dominant axis is NEGATIVE would get a negative count and walk ZERO cells. Fancy trees would grow
// limbs into one quadrant only, and the clear-line check would report "clear" for the other side
// without testing a single cell.
//
// Neither routine draws, so such a divergence is write-only: a baseline that compares this port
// against its own previous output cannot see it.
func fancyAbsMax(a, b float32) float32 {
	a, b = absF32(a), absF32(b)
	if a > b {
		return a
	}
	return b
}

func absF32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// fancyLineSteps is the step count every line walk in this trunk shares:
// fancyAbsMax(fancyAbsMax(dx,dy),dz) truncated to int -- the largest absolute component, so the
// dominant axis advances exactly one cell per step.
func fancyLineSteps(dx, dy, dz int) int {
	return int(fancyAbsMax(fancyAbsMax(float32(dx), float32(dy)), float32(dz)))
}

// fancyLinePos reproduces the game's per-step rounding literally:
// from + trunc(i * (delta/steps) + 0.5) per axis, in float32.
//
// The product is wrapped in an explicit float32() because it must round
// BEFORE the +0.5: the game multiplies and adds 0.5 as separate float32
// operations on every line walk. Without the conversion, gc
// fuses each into one multiply-add with a single rounding, and since the
// result is truncated to a cell index a last-bit difference at the .5
// boundary moves a log. See features/fmafusion_test.go.
func fancyLinePos(from wgen.BlockPos, i int, sx, sy, sz float32) wgen.BlockPos {
	return wgen.BlockPos{
		X: from.X + int(float32(float32(i)*sx)+0.5),
		Y: from.Y + int(float32(float32(i)*sy)+0.5),
		Z: from.Z + int(float32(float32(i)*sz)+0.5),
	}
}

// fancyCheckLine ports the fancy trunk's clear-line check. Returns -1 when every
// cell on the line passes, otherwise the index of the FIRST cell that does not. Note
// the loop runs steps+1 times, so the destination cell is included.
func fancyCheckLine(api wgen.BlockWorld, from, to wgen.BlockPos, mayReplace block.MatchSet) int {
	dx, dy, dz := to.X-from.X, to.Y-from.Y, to.Z-from.Z
	steps := fancyLineSteps(dx, dy, dz)
	if steps == -1 {
		return -1
	}
	var sx, sy, sz float32
	if steps != 0 {
		sx = float32(dx) / float32(steps)
		sy = float32(dy) / float32(steps)
		sz = float32(dz) / float32(steps)
	}
	for i := 0; i <= steps; i++ {
		TickDeadline("tracing a fancy-trunk limb across the trunk's own height")
		if !isValidTreePosition(api, fancyLinePos(from, i, sx, sy, sz), mayReplace) {
			return i
		}
	}
	return -1
}

// fancyPlaceLimb ports the fancy trunk's limb placement: draws the trunk block
// along a line with NO may_replace gate at all -- a plain single-block write,
// the same ungated write mega_trunk's own branch logs already use. The
// horizontal-dominant steps request a rotated pillar axis (direction 3 when |dx| >= |dz|, else 0); this port's TransformBlock
// is identity, so limbs are placed unrotated -- the same documented limitation every
// other rotation-eligible placement here carries.
func fancyPlaceLimb(api wgen.BlockWorld, from, to wgen.BlockPos, trunkBlock block.ID) {
	dx, dy, dz := to.X-from.X, to.Y-from.Y, to.Z-from.Z
	steps := fancyLineSteps(dx, dy, dz)
	if steps == -1 {
		return
	}
	var sx, sy, sz float32
	if steps != 0 {
		sx = float32(dx) / float32(steps)
		sy = float32(dy) / float32(steps)
		sz = float32(dz) / float32(steps)
	}
	for i := 0; i <= steps; i++ {
		TickDeadline("tracing a fancy-trunk limb across the trunk's own height")
		placeLog(api, fancyLinePos(from, i, sx, sy, sz), trunkBlock)
	}
}

// placeFancyTrunk ports the fancy trunk's placement in three phases, in the
// game's order. The order matters for block writes: the canopies run BEFORE the
// trunk column and the limbs, so logs overwrite leaves where they overlap and not the
// other way round.
func (f *TreeFeature) placeFancyTrunk(ctx *wgen.PlacementContext, trunk *shapedTrunk) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, treeTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	params := treeParamsLists{mayGrowOn: f.mayGrowOn, mayReplace: f.mayReplace}

	// *** RNG *** -- the height sample: base + nextInt(variance), ONE plain
	// bounded draw, with no clamp and no int-range draw (which would have been
	// min + nextInt(max-min+1) and a different bound).
	//
	// The height is drawn BEFORE the root placement and the trunk placement,
	// which is why applyRoots below runs on the drawn height.
	height := trunk.height.base + rnd.NextIntBound(trunk.fancyVariance)

	// mangrove_roots -- see applyRoots for the order and the derivation. It
	// runs on the DRAWN height, before the trunk line below is allowed to
	// shorten it: the game draws the height, runs the roots, and only then
	// places the trunk, where that shortening lives.
	var rootsOK bool
	if origin, rootsOK = f.applyRoots(ctx, origin, height); !rootsOK {
		return nil
	}
	if height < 1 {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}

	// THERE IS NO BUILD-HEIGHT GUARD ON THIS PATH, AND ADDING ONE WOULD BE A BUG.
	// Every other trunk class here goes through
	// prepareShippedTree, which fails the tree when origin.Y+height reaches the
	// ceiling; the fancy path's lack of one looks like an oversight. It is not. The
	// game's fancy trunk does no spawn preparation and no max/min-height check:
	// both the clear-line check and the limb placement walk cells straight through
	// the world-gen block API with no y-range test, so
	// whatever the API does with an out-of-range position IS the game's behaviour.
	// Adding a guard would fail trees the game places -- canopy and all -- and because
	// a failed trunk is a failed feature, it would also change which
	// features run after it in an aggregate or sequence. Leave the bounds decision to
	// the API implementation.

	// --- Phase 1: ground, then the trunk line (which can SHORTEN the tree) ---
	below := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	if !f.mayGrowOn.Empty() && !f.mayGrowOn.Contains(api.GetBlock(below)) {
		LogFailure(ctx, treeTypeID, "Trunk could not be placed")
		return nil
	}
	top := wgen.BlockPos{X: origin.X, Y: origin.Y + height - 1, Z: origin.Z}
	if blocked := fancyCheckLine(api, origin, top, f.mayReplace); blocked != -1 {
		if blocked <= trunk.height.base {
			LogFailure(ctx, treeTypeID, "Trunk could not be placed")
			return nil
		}
		height = blocked
	}
	// NO placeBaseBlock here, and that is deliberate.
	// The fancy trunk makes no block write before its canopies -- the only
	// writes on this path are the limbs'. A placeBaseBlock call could never
	// fire anyway, since placeBaseBlock only writes when may_grow_on is
	// non-empty AND does not contain the ground block, which is exactly the
	// case the check above has already failed the trunk on.

	// stemTopOffset is the scaled trunk top, clamped to height-1 -- note there is NO
	// lower clamp, so a small `scale` legitimately yields 0.
	stemTopOffset := int(float32(height) * trunk.fancyScale)
	if stemTopOffset >= height {
		stemTopOffset = height - 1
	}
	stemTopY := origin.Y + stemTopOffset

	// clustersPerLevel = max(1, int(powf(density*height/(variance+1), 2) + 1.382)).
	// The constant is exactly 1.382.
	span := trunk.fancyVariance + 1
	ratio := (trunk.fancyDensity * float32(height)) / float32(span)
	clusters := int(float32(math.Pow(float64(ratio), 2)) + 1.382)
	if clusters <= 1 {
		clusters = 1
	}
	// topLevel = height - (variance+1)/3, an exact signed divide by three.
	rise := span / 3
	topLevel := height - rise

	// The first foliage coordinate is pushed BEFORE the level loop and sits directly
	// above the trunk, attaching at the stem top.
	coords := []fancyFoliage{{
		pos:     wgen.BlockPos{X: origin.X, Y: origin.Y + topLevel, Z: origin.Z},
		attachY: stemTopY,
	}}

	// --- Phase 2: foliage coordinates, top level down to 0 ---
	for level := topLevel; level >= 0; level-- {
		TickDeadline("walking a trunk column as tall as its trunk height asks")
		// Radius from a semicircular profile, gated by foliage_altitude_factor. A
		// negative radius skips the level with ZERO draws.
		radius := float32(-1)
		if float32(level) >= float32(height)*trunk.fancyFoliageAltFact {
			// The game divides the height by 2.0f and then subtracts -- gc rewrites the /2 as *0.5 and
			// would fuse it into the subtract, hence the explicit
			// float32() on half. The profile is two squarings, a subtract and a
			// square root: two products each
			// rounded before the subtract, hence the two conversions below.
			half := float32(float32(height) / 2)
			d := half - float32(level)
			var r float32
			switch {
			case d == 0:
				r = half
			case absF32(d) < half:
				r = float32(math.Sqrt(float64(float32(half*half) - float32(d*d))))
			}
			radius = r * 0.5
		}
		if radius < 0 {
			continue
		}
		for c := 0; c < clusters; c++ {
			TickDeadline("placing the fancy-trunk branch clusters its branches.density asks for")
			// *** RNG 1 *** distance, *** RNG 2 *** angle -- in that order, and both
			// spent before any validation, so a rejected cluster still costs two draws.
			spread := trunk.fancyWidthScale * radius
			dist := spread * (float32(rnd.NextFloat()) + 0.328)
			angle := float32(rnd.NextFloat()) * 2 * math.Pi
			// sin -> X, cos -> Z. Deliberately not "fixed" to the usual convention.
			//
			// EngineSin/EngineCos, NOT math.Sin/math.Cos: the fancy trunk
			// uses the game's sine lookup table (see enginemath.go) for both
			// sine and cosine of the same angle -- and the angle above is
			// the float32 `(d * 2.0f) * pi_f32` (two separate float32
			// multiplies, by 2.0 then by float32 pi), so nothing widens.
			//
			// The float32() around each product is a rounding barrier: the
			// game multiplies, then adds a 0.5f constant, then truncates --
			// separately for sine and for cosine. gc
			// fuses these into one rounding without it, and the
			// truncation makes a last-bit difference move the cluster.
			cx := origin.X + int(float32(dist*EngineSin(angle))+0.5)
			cz := origin.Z + int(float32(dist*EngineCos(angle))+0.5)
			cy := origin.Y + level - 1
			cluster := wgen.BlockPos{X: cx, Y: cy, Z: cz}

			// Vertical clearance above the cluster: `rise` steps straight up. This
			// is the same line walk with a zeroed horizontal delta, so it degenerates to a
			// vertical walk.
			if fancyCheckLine(api, cluster, wgen.BlockPos{X: cx, Y: cy + rise, Z: cz}, f.mayReplace) != -1 {
				continue
			}

			// The limb's attachment height on the trunk: the cluster's own level minus
			// the horizontal distance times `slope`, capped at the stem top.
			hdx, hdz := origin.X-cx, origin.Z-cz
			horiz := int(math.Sqrt(float64(hdx*hdx + hdz*hdz)))
			attachY := stemTopY
			//
			// float32() around the product: the game multiplies and then
			// subtracts as two separate operations, two roundings;
			// gc would fuse them into one multiply-subtract.
			if dropped := float32(cy) - float32(float32(horiz)*trunk.fancySlope); dropped <= float32(stemTopY) {
				attachY = int(dropped)
			}

			// And the limb path itself must be clear before the cluster is accepted.
			if fancyCheckLine(api, wgen.BlockPos{X: origin.X, Y: attachY, Z: origin.Z}, cluster, f.mayReplace) != -1 {
				continue
			}
			coords = append(coords, fancyFoliage{pos: cluster, attachY: attachY})
		}
	}

	// --- Phase 3a: one canopy per foliage coordinate ---
	anchors := make([]treeCanopyAnchor, 0, len(coords))
	for _, c := range coords {
		anchors = append(anchors, treeCanopyAnchor{pos: c.pos})
	}
	f.placeCanopies(api, rnd, params, anchors)

	// --- Phase 3b: the trunk itself, drawn as trunk_width^2 vertical limbs ---
	for i := 0; i < trunk.width; i++ {
		TickDeadline("filling a trunk layer as wide as its trunk_width asks")
		for j := 0; j < trunk.width; j++ {
			from := wgen.BlockPos{X: origin.X + i, Y: origin.Y, Z: origin.Z + j}
			to := wgen.BlockPos{X: origin.X + i, Y: stemTopY, Z: origin.Z + j}
			fancyPlaceLimb(api, from, to, f.trunkBlock)
		}
	}

	// --- Phase 3c: a limb to each coordinate high enough to earn one ---
	for _, c := range coords {
		from := wgen.BlockPos{X: origin.X, Y: c.attachY, Z: origin.Z}
		// A wide trunk attaches from whichever edge faces the cluster.
		if c.pos.X > origin.X {
			from.X = origin.X + trunk.width - 1
		}
		if c.pos.Z > origin.Z {
			from.Z = origin.Z + trunk.width - 1
		}
		// min_altitude_factor gates on the ATTACH height, not the cluster's own.
		if float32(c.attachY-origin.Y) >= float32(height)*trunk.fancyMinAltitude {
			fancyPlaceLimb(api, from, c.pos, f.trunkBlock)
		}
	}

	result := origin
	return &result
}
