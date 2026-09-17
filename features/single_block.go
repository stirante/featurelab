// single_block.go is minecraft:single_block_feature -- one of the most common
// feature types, and the feature most scatters delegate to.
//
// Defaults: every field starts zero/false except two: min_sides_must_attach = 4
// and auto_rotate = true.
//
// JSON surface, with each key's required flag:
//
//	places_block                 string | descriptor | array of {block(req),
//	                             weight(req)} — several accepted shapes
//	enforce_placement_rules      REQUIRED bool
//	enforce_survivability_rules  REQUIRED bool
//	randomize_rotation           optional bool, default false
//	may_attach_to                optional object, with its own presence flag:
//	  top/bottom/north/east/south/west/all/sides/diagonal — each a block
//	  descriptor or list, held in a nine-slot dense enum map
//	  min_sides_must_attach      optional INT, default 4
//	  auto_rotate                optional bool, default TRUE
//	may_not_attach_to            optional object, same nine face keys
//	                             (a second nine-slot map)
//	may_replace                  optional descriptor list
//
// Both enforce_* keys are REQUIRED by the schema but are NO-OPS during world
// generation: they gate a placement check and a survivability check that
// always pass during world generation, in every supported game version
// (1.26.50 added a placement-filter check that this feature does not use).
// The bench therefore parses and stores the two keys but never rejects on
// them. (Outside world generation the two checks are real; that path is out
// of scope for a worldgen bench.)
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const singleBlockTypeID = "minecraft:single_block_feature"

// checkDirection is the single-block feature's attach-direction enum, with the
// game's own integer values: top=0, bottom=1, north=2, east=3, south=4,
// west=5, all=6, sides=7, diagonal=8.
type checkDirection int

const (
	dirTop checkDirection = iota
	dirBottom
	dirNorth
	dirEast
	dirSouth
	dirWest
	dirAll
	dirSides
	dirDiagonal
	dirCount
)

var checkDirectionKeys = [dirCount]string{
	"top", "bottom", "north", "east", "south", "west", "all", "sides", "diagonal",
}

// attachMap is a nine-slot dense map from
// attach-direction to a list of block descriptors: nine match sets, empty =
// unconfigured for that direction.
type attachMap [dirCount]block.MatchSet

func (m *attachMap) anyNonEmpty(dirs ...checkDirection) bool {
	for _, d := range dirs {
		if !m[d].Empty() {
			return true
		}
	}
	return false
}

// validateAttach mirrors the game's per-direction attach validation: TRUE iff every
// referenced list is empty (nothing configured for this direction at all),
// OR the neighbor matches ANY of the non-empty referenced lists.
func (m *attachMap) validateAttach(neighbor block.ID, dirs ...checkDirection) bool {
	if !m.anyNonEmpty(dirs...) {
		return true
	}
	for _, d := range dirs {
		if !m[d].Empty() && m[d].Contains(neighbor) {
			return true
		}
	}
	return false
}

// validateDeny mirrors the game's per-direction deny validation: TRUE (deny) iff
// the neighbor matches ANY non-empty referenced list; all-empty means no
// deny (the empty case skips, it does not deny).
func (m *attachMap) validateDeny(neighbor block.ID, dirs ...checkDirection) bool {
	for _, d := range dirs {
		if !m[d].Empty() && m[d].Contains(neighbor) {
			return true
		}
	}
	return false
}

// SingleBlockFeature is minecraft:single_block_feature.
type SingleBlockFeature struct {
	identifier    string
	weights       []float64
	blockIDs      []block.ID
	mayReplaceIDs block.MatchSet
	// pal is kept for the allow-list checks, which have to normalize the
	// world block's update_bit/persistent_bit before comparing it and so
	// need more of the palette than IPaletteView exposes. The tree feature
	// keeps one for the same reason.
	pal                *block.Palette
	mayAttachTo        attachMap
	mayNotAttachTo     attachMap
	attachConfigured   bool // presence flag: may_attach_to OR may_not_attach_to present in JSON
	minSidesMustAttach int  // default 4
	autoRotate         bool // default true
	randomizeRotation  bool // default false
	enforcePlacement   bool // parsed, never rejects (see header)
	enforceSurvival    bool // parsed, never rejects (see header)

	// rotated[d][i] is blockIDs[i] after block.Palette.TransformBlock toward
	// CommonDirection d — the game's block rotation, ported in
	// block/rotate.go. Pre-interned at build time
	// because the four rotations of a candidate are a property of the block,
	// not of world state, and this is one of the most common feature
	// types (the same reason multi_block.go pre-interns its partIDs rows).
	// nil when no rotation can fire for this file (no attach condition, or
	// auto_rotate off, and no randomize_rotation) -- the two readers below are
	// each gated on exactly the condition that fills these rows, so a nil row
	// is never indexed. See buildSingleBlockFeature's rotationCanFire.
	rotated [4][]block.ID
}

func (f *SingleBlockFeature) TypeID() string     { return singleBlockTypeID }
func (f *SingleBlockFeature) Identifier() string { return f.identifier }

func neighbor(pos wgen.BlockPos, dx, dy, dz int) wgen.BlockPos {
	return wgen.BlockPos{X: pos.X + dx, Y: pos.Y + dy, Z: pos.Z + dz}
}

// mayNotAttach mirrors the single-block feature's deny check (unchanged across
// supported game versions). TRUE the moment ANY configured deny list matches its corresponding
// neighbor. The game's neighbor order: top, bottom, the four horizontal
// diagonals, then north/east/south/west. Per neighbor the referenced lists
// are (specific, all) for top/bottom/diagonals and (specific, sides, all)
// for the four cardinal sides — "all" therefore covers all TEN neighbors
// (six faces plus four horizontal diagonals), "sides" only the cardinals.
func (f *SingleBlockFeature) mayNotAttach(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	if !f.attachConfigured {
		return false
	}
	m := &f.mayNotAttachTo
	type check struct {
		dx, dy, dz int
		dirs       []checkDirection
	}
	checks := []check{
		{0, 1, 0, []checkDirection{dirTop, dirAll}},
		{0, -1, 0, []checkDirection{dirBottom, dirAll}},
		{1, 0, 1, []checkDirection{dirDiagonal, dirAll}},
		{-1, 0, 1, []checkDirection{dirDiagonal, dirAll}},
		{1, 0, -1, []checkDirection{dirDiagonal, dirAll}},
		{-1, 0, -1, []checkDirection{dirDiagonal, dirAll}},
		{0, 0, -1, []checkDirection{dirNorth, dirSides, dirAll}},
		{1, 0, 0, []checkDirection{dirEast, dirSides, dirAll}},
		{0, 0, 1, []checkDirection{dirSouth, dirSides, dirAll}},
		{-1, 0, 0, []checkDirection{dirWest, dirSides, dirAll}},
	}
	for _, c := range checks {
		nb := normalizeAllowListBits(f.pal, api.GetBlock(neighbor(pos, c.dx, c.dy, c.dz)))
		if m.validateDeny(nb, c.dirs...) {
			return true
		}
	}
	return false
}

// The side-driven rotation's CommonDirection values live in block.CommonDirection
// (block/rotate.go), which owns the transform itself. The attach check's four
// sides use north=0, east=1, south=2, west=3 -- and randomize_rotation draws a raw unsigned value modulo 4 into the
// same enum.

// mayAttach mirrors the single-block feature's attach check (unchanged across
// supported game versions). Returns (ok, blockToPlace). Semantics:
//
//   - attach not configured at all (the presence flag unset) -> ok, block
//     unchanged (placement goes straight to resolving the descriptor, with
//     the game's unknown-block fallback).
//   - top, bottom and the four horizontal diagonals are HARD, individually
//     fatal checks against (specific, all): any failure -> not ok.
//   - the four cardinal sides (north, east, south, west, in that order) are
//     COUNTED against (specific, sides, all); the count must reach
//     min_sides_must_attach. A side whose referenced lists are all empty
//     counts for free — which is exactly why the default min_sides of 4
//     passes for a may_attach_to that configures no side lists at all.
//   - when auto_rotate is set AND randomize_rotation is not, each matching
//     side rotates the block toward that side's CommonDirection; the LAST
//     matching side wins, and each rotation transforms the ORIGINAL block
//     rather than accumulating -- the game starts from the unrotated block for
//     every side.
//
// pickIndex, not a block.ID, is what comes in: the four rotations of every
// candidate are pre-interned at build time (f.rotated), because this runs on
// one of the hottest feature types and re-deriving them per placement would
// intern the same handful of block states over and over.
func (f *SingleBlockFeature) mayAttach(api wgen.BlockWorld, pos wgen.BlockPos, pickIndex int, ctx *wgen.PlacementContext) (bool, block.ID) {
	blockID := f.blockIDs[pickIndex]
	if !f.attachConfigured {
		return true, blockID
	}
	m := &f.mayAttachTo

	hard := []struct {
		dx, dy, dz int
		dirs       []checkDirection
	}{
		{0, 1, 0, []checkDirection{dirTop, dirAll}},
		{0, -1, 0, []checkDirection{dirBottom, dirAll}},
		{1, 0, 1, []checkDirection{dirDiagonal, dirAll}},
		{-1, 0, 1, []checkDirection{dirDiagonal, dirAll}},
		{1, 0, -1, []checkDirection{dirDiagonal, dirAll}},
		{-1, 0, -1, []checkDirection{dirDiagonal, dirAll}},
	}
	for _, c := range hard {
		nb := normalizeAllowListBits(f.pal, api.GetBlock(neighbor(pos, c.dx, c.dy, c.dz)))
		if !m.validateAttach(nb, c.dirs...) {
			return false, blockID
		}
	}

	autoRotating := f.autoRotate && !f.randomizeRotation
	result := blockID
	sides := []struct {
		dx, dz int
		dir    checkDirection
		common block.CommonDirection
	}{
		{0, -1, dirNorth, block.CommonDirectionNorth},
		{1, 0, dirEast, block.CommonDirectionEast},
		{0, 1, dirSouth, block.CommonDirectionSouth},
		{-1, 0, dirWest, block.CommonDirectionWest},
	}
	matched := 0
	for _, s := range sides {
		nb := normalizeAllowListBits(f.pal, api.GetBlock(neighbor(pos, s.dx, 0, s.dz)))
		if m.validateAttach(nb, s.dir, dirSides, dirAll) {
			matched++
			if autoRotating {
				result = f.rotated[s.common][pickIndex]
			} else {
				result = blockID
			}
		}
	}
	if matched >= f.minSidesMustAttach {
		return true, result
	}
	return false, blockID
}

// passesAllowList mirrors the game's placement allow-list check, here as
// the replace-list check. An absent/empty may_replace is "no constraint".
func (f *SingleBlockFeature) passesAllowList(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	if f.mayReplaceIDs.Empty() {
		return true
	}
	return f.mayReplaceIDs.Contains(normalizeAllowListBits(f.pal, api.GetBlock(pos)))
}

// Place mirrors the single-block feature's placement, in the game's own
// check order: empty list -> deny list -> weighted pick -> attach (with
// auto-rotate) -> enforce placement (no-op here) -> enforce survivability
// (no-op here) -> may_replace -> randomize_rotation (RNG) -> write.
func (f *SingleBlockFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, singleBlockTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	// Step 1: empty candidate list -> fail, no RNG.
	if len(f.weights) == 0 {
		LogFailure(ctx, singleBlockTypeID, "Possible blocks list is empty")
		return nil
	}

	// Step 2: deny-list test on the neighbors, before any RNG.
	if f.mayNotAttach(api, origin) {
		LogFailure(ctx, singleBlockTypeID, "Target location surrounded by blocks contained in the deny list")
		return nil
	}

	// Steps 3-5: *** RNG CALL #1 *** weighted candidate pick.
	pickIndex := WeightedPick(f.weights, rnd)
	if pickIndex == -1 {
		LogFailure(ctx, singleBlockTypeID, "A block from the possible blocks could not be chosen")
		return nil
	}
	pos := origin

	// Step 7: attach test — hard top/bottom/diagonal gates plus the counted
	// sides, possibly auto-rotating the block toward the last matching side.
	ok, blockID := f.mayAttach(api, pos, pickIndex, ctx)
	if !ok {
		LogFailure(ctx, singleBlockTypeID, "Block could not attach to the given location")
		return nil
	}

	// Steps 8-9: enforce_placement_rules / enforce_survivability_rules gate
	// the placement and survivability checks, which always pass during world
	// generation (see this file's header), so they never reject here either.

	// Step 10: replace-list check.
	if !f.passesAllowList(api, pos) {
		// Name the block that was actually there. The engine's own message
		// ("Target location does not contain a block from the replace list")
		// is true and useless: it does not say what IS there, so the reader
		// has to go and find out by hand.
		// Plain concatenation, not fmt.Sprintf: this line fires once per
		// failed attempt and a busy pack drives it very hard -- the fmt
		// machinery was a measurable slice of that.
		LogFailure(ctx, singleBlockTypeID,
			"may_replace rejected this position: it holds "+describeBlockAt(api, pos)+
				", which is not in the replace list")
		return nil
	}

	// Step 11: randomize_rotation — *** RNG CALL #2 *** the game's raw
	// unsigned draw modulo 4 (a raw 32-bit value, NOT the bounded integer
	// draw), then the rotation toward that CommonDirection.
	if f.randomizeRotation {
		// The draw is unconditional and its value is passed straight into
		// the rotation as the CommonDirection, so the RNG stream is the
		// same whether or not the block turns out to carry a handled state.
		dir := block.CommonDirection(rnd.NextUnsignedInt(4))
		blockID = f.rotated[dir][pickIndex]
	}

	// Step 12: write the block.
	if !api.SetBlock(pos, blockID) {
		LogFailure(ctx, singleBlockTypeID, "Block could not be placed")
		return nil
	}
	result := pos
	return &result
}

type candidate struct {
	block  block.Descriptor
	weight float64
}

// parseCandidates takes a warn channel because two shapes it ACCEPTS are shapes the engine's own
// schema does not: an array entry with no `weight`, and an array entry that is a bare block
// descriptor rather than a {block, weight} pair. Both are read here at weight 1. See the two
// warnings below for why they are warnings rather than errors.
func parseCandidates(raw any, jsonPath string, warn func(string)) ([]candidate, error) {
	switch v := raw.(type) {
	case string:
		return []candidate{{block: block.NameDescriptor(v), weight: 1}}, nil
	case []any:
		if len(v) == 0 {
			return nil, fmt.Errorf("%s must not be an empty array", jsonPath)
		}
		out := make([]candidate, len(v))
		for i, entry := range v {
			p := fmt.Sprintf("%s[%d]", jsonPath, i)
			if m, ok := entry.(map[string]any); ok {
				if bv, hasBlock := m["block"]; hasBlock {
					weight := 1.0
					if wv, ok := m["weight"]; ok {
						f, ok := toFloat(wv)
						if !ok || f < 0 {
							return nil, fmt.Errorf("%s.weight must be a non-negative number", p)
						}
						weight = f
					} else if warn != nil {
						// The game's schema marks `weight` REQUIRED on the object form. Defaulting it to 1 makes a file that this bench places
						// into one the game would refuse to load -- which is the direction that
						// costs an author most, because everything looks right here.
						//
						// A warning rather than an error, for the same reason a missing
						// format_version is: refusing would delete the feature from the run and
						// leave the author hunting for a second consequence of a problem they
						// have already been told about.
						warn(fmt.Sprintf("%s has no `weight`. The engine's schema requires it on "+
							"this shape, so the real game would refuse this file; this tool reads "+
							"the entry at weight 1 and carries on.", p))
					}
					desc, err := AsBlockDescriptor(bv, p+".block")
					if err != nil {
						return nil, err
					}
					out[i] = candidate{block: desc, weight: weight}
					continue
				}
			}
			desc, err := AsBlockDescriptor(entry, p)
			if err != nil {
				return nil, err
			}
			if warn != nil {
				warn(fmt.Sprintf("%s is a bare block descriptor. Inside an array, this field's "+
					"entries are {block, weight} pairs, and the engine's schema would refuse this "+
					"shape; this tool reads it as that block at weight 1. Wrap it as "+
					"{\"block\": ..., \"weight\": 1}, or -- if there is only one candidate -- "+
					"drop the array and write the descriptor on its own.", p))
			}
			out[i] = candidate{block: desc, weight: 1}
		}
		return out, nil
	case map[string]any:
		desc, err := AsBlockDescriptor(v, jsonPath)
		if err != nil {
			return nil, err
		}
		return []candidate{{block: desc, weight: 1}}, nil
	default:
		return nil, fmt.Errorf("%s must be a block descriptor (string/object), or an array of {block, weight}", jsonPath)
	}
}

// notInSchemaWarning words the one diagnostic every key-level format_version gate produces.
// The game's own line is "<key>: this member was found in the input, but is not present in
// the Schema", which tells an author what happened but not why or what it costs them -- so this adds the version that introduced the key and the
// consequence for the run they are looking at.
func notInSchemaWarning(ctx *BuildContext, key string, introduced FormatVersion, consequence string) string {
	return fmt.Sprintf("%s: %q was found in the input, but is not present in the schema for "+
		"format_version %s — single_block_feature gained this key at format_version %s; the game "+
		"drops the value and so does this tool, so %s",
		ctx.Identifier, key, ctx.FormatVersion, introduced, consequence)
}

// parseAttachMap parses one may_attach_to / may_not_attach_to object's nine
// face keys into an attachMap. Non-face keys are left to the caller.
//
// modernSchema selects the >= 1.21.40 attach-condition schema: `diagonal` (attach-direction 8) is
// the one face key that version gates, so below that version it is not a key at all and its value
// is dropped with the same member-not-in-schema diagnostic every other gated key gets.
func parseAttachMap(obj map[string]any, ctx *BuildContext, field string, modernSchema bool) (attachMap, error) {
	var m attachMap
	for d := dirTop; d < dirCount; d++ {
		key := checkDirectionKeys[d]
		raw, present := obj[key]
		if !present {
			continue
		}
		if d == dirDiagonal && !modernSchema {
			ctx.Warn(notInSchemaWarning(ctx, field+".diagonal", singleBlockV1_21_40,
				"the four horizontal diagonals are not tested"))
			continue
		}
		list, err := AsBlockDescriptorOrList(raw, field+"."+key)
		if err != nil {
			return m, err
		}
		m[d] = ResolveMatchSet(list, ctx, field+"."+key)
	}
	return m, nil
}

func parseRequiredBool(body map[string]any, key string, ctx *BuildContext) (bool, error) {
	raw, present := body[key]
	if !present {
		// The schema marks this key REQUIRED — a pack omitting it would not
		// load in the game. Downgraded to a warning here rather than a hard
		// error because the schema is format_version-gated and older
		// format versions' requirements have not been confirmed; the warning still surfaces the
		// fidelity gap.
		ctx.Warn(fmt.Sprintf("%s: %q is required by the engine's schema (this build) but is missing -- the real game would reject this file; defaulting to false",
			ctx.Identifier, key))
		return false, nil
	}
	b, ok := raw.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return b, nil
}

// singleBlockV1_21_40 is the one format_version threshold in the single-block feature's
// schema: 1.21.40. The file's declared version is tested against it for four keys:
//
//	places_block            a legacy single block descriptor below the threshold; at or above,
//	                        the newer block specifier PLUS the weighted array-of-{weight, block}
//	                        form
//	randomize_rotation      present only at or above
//	may_attach_to.auto_rotate  the SAME optional key on both sides, with identical behaviour
//	                        (it sets the same flag), so treating the key identically at every
//	                        version is correct, not a caveat.
//	may_not_attach_to       present only at or above
//
// The nine face keys inside may_attach_to / may_not_attach_to carry the same threshold, which
// gates exactly one of them: `diagonal` (attach-direction 8) exists only at or above 1.21.40.
//
// See typeavailability.go for the coarser gate that decides which TYPES a file may name.
var singleBlockV1_21_40 = MustFormatVersion("1.21.40")

func buildSingleBlockFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	// modernSchema is "this file's declared format_version selects the >= 1.21.40 branch".
	// A file that declares nothing is unversioned rather than old -- see
	// FormatVersion.AtLeastOrUnversioned for why that is the policy across every gate here.
	modernSchema := ctx.FormatVersion.AtLeastOrUnversioned(singleBlockV1_21_40)

	placesBlock, ok := body["places_block"]
	if !ok {
		return nil, fmt.Errorf("places_block is required")
	}
	if _, isArray := placesBlock.([]any); isArray && !modernSchema {
		// Below 1.21.40 places_block is a single block-descriptor node: an array is not a
		// shape that node can read, so the value is rejected and the REQUIRED key is left
		// unset -- the file does not load. This is an error rather than a warning for that
		// reason; there is no "what the engine would have placed" to show.
		return nil, fmt.Errorf("places_block is a weighted array, which single_block_feature only "+
			"accepts from format_version %s onward; this file declares %s, where places_block must be a "+
			"single block descriptor (raise format_version to use the array form)",
			singleBlockV1_21_40, ctx.FormatVersion)
	}
	candidates, err := parseCandidates(placesBlock, "places_block", func(m string) {
		ctx.Warn(fmt.Sprintf("%s: %s", ctx.Identifier, m))
	})
	if err != nil {
		return nil, err
	}
	weights := make([]float64, len(candidates))
	blockIDs := make([]block.ID, len(candidates))
	for i, c := range candidates {
		weights[i] = c.weight
		blockIDs[i] = ctx.Palette.Resolve(c.block)
	}

	enforcePlacement, err := parseRequiredBool(body, "enforce_placement_rules", ctx)
	if err != nil {
		return nil, err
	}
	enforceSurvival, err := parseRequiredBool(body, "enforce_survivability_rules", ctx)
	if err != nil {
		return nil, err
	}

	randomizeRotation := false
	if raw, present := body["randomize_rotation"]; present {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("randomize_rotation must be a boolean")
		}
		if modernSchema {
			randomizeRotation = b
		} else {
			// Not in this band's schema at all: the engine logs the key by name
			// ("<key>: this member was found in the input, but is not present in the Schema")
			// and drops the value, leaving the engine's own default. Dropping it here too is what
			// keeps the bench honest -- an author whose old-format file "randomizes" in this
			// tool but not in the game has been actively misled.
			ctx.Warn(notInSchemaWarning(ctx, "randomize_rotation", singleBlockV1_21_40,
				"the block is placed unrotated, as it would be in game"))
		}
	}

	mayReplaceList, err := AsBlockDescriptorList(body["may_replace"], "may_replace")
	if err != nil {
		return nil, err
	}
	mayReplaceIDs := ResolveMatchSet(mayReplaceList, ctx, "may_replace")

	f := &SingleBlockFeature{
		identifier:         ctx.Identifier,
		pal:                ctx.Palette,
		weights:            weights,
		blockIDs:           blockIDs,
		mayReplaceIDs:      mayReplaceIDs,
		minSidesMustAttach: 4,    // game default
		autoRotate:         true, // game default
		randomizeRotation:  randomizeRotation,
		enforcePlacement:   enforcePlacement,
		enforceSurvival:    enforceSurvival,
	}

	if mayAttachToRaw, present := body["may_attach_to"]; present && mayAttachToRaw != nil {
		obj, ok := mayAttachToRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("may_attach_to must be an object")
		}
		f.attachConfigured = true
		f.mayAttachTo, err = parseAttachMap(obj, ctx, "may_attach_to", modernSchema)
		if err != nil {
			return nil, err
		}
		if mv, present := obj["min_sides_must_attach"]; present {
			v, ok := toFloat(mv)
			if !ok {
				return nil, fmt.Errorf("may_attach_to.min_sides_must_attach must be a number")
			}
			// Transcribed, not repaired -- the same policy as
			// constraints.leveled.max_steepness in structure_template.go, and for the same
			// reason: this field is a plain int with no range check in the game, so a value the author did not mean produces a strange result in
			// the game rather than a refused file. Refusing here would be this tool inventing a
			// constraint the engine does not have, and would hide the actual consequence.
			//
			// A fractional value truncates toward zero, which is what reading a JSON number into
			// an int does. A negative one makes the `matched >= minSides` test trivially true, so
			// every side check passes and the block places wherever the hard gates allow.
			n := int(v)
			if v != float64(n) {
				ctx.Warn(fmt.Sprintf("%s: may_attach_to.min_sides_must_attach is %v, and the field is "+
					"an integer -- it truncates to %d rather than rounding.", ctx.Identifier, mv, n))
			}
			if n < 0 {
				ctx.Warn(fmt.Sprintf("%s: may_attach_to.min_sides_must_attach is %v, which is negative. "+
					"The count of matching sides is then ALWAYS at least this, so the side requirement "+
					"passes everywhere and only the hard top/bottom/diagonal gates still apply. "+
					"Modelled as written rather than clamped, because the game does not repair it "+
					"either -- write 0 if that is what you meant.", ctx.Identifier, mv))
			}
			f.minSidesMustAttach = n
		}
		if av, present := obj["auto_rotate"]; present {
			b, ok := av.(bool)
			if !ok {
				return nil, fmt.Errorf("may_attach_to.auto_rotate must be a boolean")
			}
			f.autoRotate = b
		}
	}

	if mayNotAttachToRaw, present := body["may_not_attach_to"]; present && mayNotAttachToRaw != nil {
		obj, ok := mayNotAttachToRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("may_not_attach_to must be an object")
		}
		if !modernSchema {
			// The whole key, its object and its nested face keys arrive together
			// at 1.21.40. Below it the key does not exist, so it is dropped whole -- and,
			// load-bearingly, it does NOT count as "an attach condition was configured",
			// which is the flag that decides whether auto_rotate can fire at all.
			ctx.Warn(notInSchemaWarning(ctx, "may_not_attach_to", singleBlockV1_21_40,
				"no exclusion is applied, and this key alone does not enable the attach test"))
		} else {
			f.attachConfigured = true
			f.mayNotAttachTo, err = parseAttachMap(obj, ctx, "may_not_attach_to", modernSchema)
			if err != nil {
				return nil, err
			}
		}
	}

	// Can a rotation fire at all for this file? randomize_rotation always can;
	// the side path needs an attach condition to have been configured AND
	// auto_rotate left on (the `auto_rotate && !randomize_rotation` gate lives
	// in mayAttach, and randomize_rotation is covered here either way). This
	// one predicate gates both the pre-interning below and the warning after
	// it -- a file that cannot rotate must not gain unreachable rotated
	// variants in the palette, and must not be warned about spellings it will
	// never write.
	rotationCanFire := f.randomizeRotation || (f.attachConfigured && f.autoRotate)

	// Pre-intern the four rotations of every candidate. A candidate carrying
	// none of the sixteen handled states transforms to itself, so for the
	// common stateless case this interns nothing and costs four slice entries.
	if rotationCanFire {
		for d := range f.rotated {
			row := make([]block.ID, len(blockIDs))
			for i, id := range blockIDs {
				row[i] = ctx.Palette.TransformBlock(id, block.CommonDirection(d))
			}
			f.rotated[d] = row
		}
	}

	// Rotation-spelling warning. The rotation itself is performed (see
	// block/rotate.go), and every integer it writes matches the game -- but
	// for some state families the step from that integer to the token a pack
	// writes is inferred from vanilla state definitions and not confirmed
	// against the game. If a rotation can actually fire here AND a candidate
	// carries one of those families, say so once, at load time, so a pack
	// leaning on an inferred spelling knows it is doing so.
	//
	// The gate asks whether the block TYPE declares a directional state, not
	// whether the DESCRIPTOR spells one, because that is the question the game
	// asks -- so a bare `places_block: "minecraft:torch"` reaches it too.
	if rotationCanFire {
		for i, id := range blockIDs {
			inferred := block.InferredTransformStates(ctx.Palette.NameOf(id), ctx.Palette.StatesOf(id))
			if len(inferred) == 0 {
				continue
			}
			ctx.Warn(fmt.Sprintf(
				"%s: places_block[%d] is a block type that declares the directional state %q, which rotation (auto_rotate/randomize_rotation) writes -- whether or not your descriptor spells it out. The direction it picks is right; the NAME that value is written under is inferred from vanilla block-state definitions and not confirmed against the game, so the rotated block may be spelled differently in game",
				ctx.Identifier, i, inferred[0]))
		}
	}

	return f, nil
}

func init() {
	RegisterType(singleBlockTypeID, buildSingleBlockFeature)
}

var _ wgen.IFeature = (*SingleBlockFeature)(nil)
