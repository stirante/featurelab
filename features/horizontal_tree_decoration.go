// horizontal_tree_decoration.go implements
// minecraft:horizontal_tree_decoration_feature. This type is NEW in game version
// 1.26.50: it does not exist in 1.26.40 at all.
//
// Building blocks it relies on:
//
//	defaults                               -- bark_side_only and allow_adjacent
//	    BOTH default false
//	the random horizontal face draw        -- ONE bounded draw of 4, plus
//	    2, i.e. face is drawn from {2,3,4,5} = North/South/West/East
//	the inclusive bounded draw             -- if max < min return min WITHOUT
//	    drawing, else a bounded draw of (max-min+1) plus min; identical to
//	    features/distribution.go's nextIntInclusive helper
//	the facing-to-direction conversion     -- facing >= 6 returns 0 (invalid),
//	    facing <= 1 returns 0, else North(2)->2, South(3)->0, West(4)->1,
//	    East(5)->3. Under Bedrock's own direction enum (South=0, West=1,
//	    North=2, East=3 -- the order minecraft:cardinal_direction's documented
//	    value list ["south","west","north","east"] serializes, default
//	    "south"=0) that is the semantic identity: the placed block's
//	    cardinal_direction names the compass direction of the face drawn. The
//	    game's direction names are 0=south, 1=west, 2=north, 3=east, indexed
//	    directly by the state's integer value. block/support.go's header
//	    covers all four enum-valued states.
//	the block's empty test                 -- the air-material check this
//	    port's pal.IsAir already models
//	the single-block write                 -- one world-API block write with
//	    flag 3, returning the POSITION iff that write succeeded; the same
//	    ungated write tree.go's placeLog already stands in for, and this port
//	    respects the returned bool
//
// SCHEMA, in declaration order:
//
//	places_block    block descriptor  REQUIRED
//	allow_adjacent  bool              OPTIONAL, default false
//	bark_side_only  bool              OPTIONAL, default false
//
// These three keys are the complete schema; there are NO additional keys
// parsed via shared helpers.
//
// The placement ALGORITHM:
//
//  0. block := places_block resolved to a block (with the engine's
//     unknown-block fallback). Two state-presence gates run BEFORE any RNG:
//     a. the type does not carry the built-in cardinal-direction state:
//     content-log "'%s' did not have the required block state
//     'cardinal_direction'.", then ALSO check the growth state and
//     log "'%s' did not have the expected block state 'growth'." if that
//     is missing too, then FAIL (zero draws).
//     b. it carries cardinal_direction but not the growth state: log the
//     growth string, FAIL (zero draws).
//     This port evaluates these gates against block/vanilla_states.go, the
//     per-block-type state catalogue: places_block's own type is asked, once
//     at build time, whether it declares both states. A vanilla type that
//     does not fails every placement here exactly as it does in the game,
//     with zero draws, and the pack author is told which state is missing.
//     A type the catalogue does not know -- a pack's own block -- keeps the
//     old assumption that both gates pass, and the old disclosure with it.
//  1. Read allow_adjacent and bark_side_only into locals.
//  2. face := the engine's random horizontal face draw --
//     *** RNG DRAW #1: a bounded draw of 4, plus 2; domain {2,3,4,5} = N/S/W/E ***.
//     Drawn UNCONDITIONALLY once the two state gates pass, before any world
//     read.
//  3. target := the origin's neighbour along face; targetIsEmpty := the
//     block's empty test on the block read there (the air-material check).
//     The result is LATCHED here but only tested in step 6.
//  4. adjacencyOK: if allow_adjacent, trivially true. Otherwise TEN block
//     reads, each comparing the probed block's TYPE against places_block's
//     own type -- first match short-circuits to false:
//     the origin's neighbours (2 North), (5 East), (3 South), (4 West) --
//     that exact order -- then target's own six neighbours:
//     (1 Up), (0 Down), (2 North), (3 South), (4 West), (5 East) -- that
//     exact order.
//     (Note the origin's four horizontal probes INCLUDE the target position
//     itself -- the engine does not special-case it; neither does this port.
//     Block-type identity is modeled as palette Name equality, this
//     codebase's established stand-in -- see multiface.go.)
//  5. If bark_side_only (the whole step is skipped otherwise):
//     a. trunk := the block at the origin.
//     b. If the trunk's type does not carry the pillar-axis state:
//     FAIL silently (an absent result -- NO content log on this path,
//     unlike step 0's gates).
//     c. axis := the block type's state read of pillar_axis on the trunk.
//     d. If face is West/East AND axis == 1: FAIL.
//     e. barkOK := !(face is North/South AND axis == 2).
//     f. If !(targetIsEmpty AND adjacencyOK AND barkOK): FAIL.
//     pillar_axis value semantics: axis 1 rejects the two X-direction faces
//     and axis 2 rejects the two Z-direction faces, i.e. "never place on the
//     log's end grain" -- which pins axis 1 = x and axis 2 = z (and 0 = y,
//     which rejects nothing) as the only geometrically coherent assignment;
//     the pillar_axis STRING values x/y/z are Bedrock's documented state
//     domain. The game's integer-to-string mapping for pillar_axis is
//     0=y, 1=x, 2=z -- exactly the assignment the face-rejection geometry
//     implies (see 5d/5e).
//  6. Else (no bark_side_only): if !(targetIsEmpty AND adjacencyOK): FAIL.
//  7. growth := the engine's inclusive bounded draw over (0, 1) --
//     *** RNG DRAW #2: exactly a bounded draw of 2, plus 0, drawn ONLY after every check
//     in steps 3-6 passed, BEFORE the write ***.
//  8. dir := the facing-to-direction conversion of face; block' :=
//     places_block with cardinal_direction written to dir through the block
//     type's state write (falling back to the unchanged block if that write
//     comes back empty); that result is then given the growth state, with the
//     same fallback.
//  9. return the engine's single-block write of that final block at target -- one
//     ungated write with flag 3, returning target as a present result iff it
//     returned true.
//
// Every failure in steps 3-6 is SILENT in the engine (no log call anywhere on
// those paths -- the only two content logs in the whole placement are step 0's
// state-gate strings), so this port fails silently there too, matching
// height_difference_filter.go's "gate fails quietly" precedent. Failures after
// step 2 have consumed exactly ONE draw; success consumes exactly TWO.
//
// What this port cannot model, and how each gap is handled:
//
//   - Step 0's two gates: evaluated for a vanilla places_block, assumed to
//     pass for anything else, and disclosed either way via ONE build-time
//     ctx.Warn. What is left is only the non-vanilla case.
//   - Step 5b's pillar-axis state-presence test on the TRUNK block, in three cases.
//     When the placed trunk carries a
//     "pillar_axis" value its value is used exactly (5d/5e). When it does not,
//     the trunk's TYPE is asked: a type that declares pillar_axis supplies its
//     own default (which is "y" for every vanilla pillar -- the dominant real case is
//     a vertical log, which this codebase's own tree_feature places WITHOUT an
//     explicit pillar_axis state, see tree.go's vertical-trunk convention);
//     a vanilla type that declares no pillar_axis at all (dirt, stone) FAILS
//     the whole placement, as the engine does. Only a non-vanilla trunk still
//     falls back to pillar_axis="y" with a per-position LogWarning, because
//     nothing can be known about what its type declares.
package features

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const horizontalTreeDecorationTypeID = "minecraft:horizontal_tree_decoration_feature"

// horizontalTreeDecorationRequiredStates is step 0's pair, in the order the
// engine tests them. A places_block whose TYPE declares neither or only one of
// these is refused outright, before any draw.
var horizontalTreeDecorationRequiredStates = []string{"minecraft:cardinal_direction", "growth"}

// horizontalTreeDecorationFacingOffsets is the position delta for each facing
// index -- this codebase's established Down=0/Up=1/North=2/South=3/West=4/
// East=5 convention (the same as multiface.go's multifaceFacingOffsets).
var horizontalTreeDecorationFacingOffsets = [6]wgen.BlockPos{
	{X: 0, Y: -1, Z: 0}, // Down
	{X: 0, Y: 1, Z: 0},  // Up
	{X: 0, Y: 0, Z: -1}, // North
	{X: 0, Y: 0, Z: 1},  // South
	{X: -1, Y: 0, Z: 0}, // West
	{X: 1, Y: 0, Z: 0},  // East
}

// horizontalTreeDecorationCardinalName maps a horizontal facing (2..5) to the
// minecraft:cardinal_direction state string the game's
// facing-to-direction conversion plus state write produces: facing -> the
// direction value (North(2)->2, South(3)->0, West(4)->1,
// East(5)->3) -> the state's documented value order
// ["south","west","north","east"] -- a net semantic identity (the state names
// the drawn face's own compass direction); see this file's header.
var horizontalTreeDecorationCardinalName = map[int]string{
	2: "north",
	3: "south",
	4: "west",
	5: "east",
}

// HorizontalTreeDecorationFeature is minecraft:horizontal_tree_decoration_feature:
// places one decoration block (carrying minecraft:cardinal_direction and
// growth states) against a horizontal side of the block at the origin --
// e.g. a growth pod on a tree trunk. A leaf type: no feature delegation, so
// it is always in scope. New in game version 1.26.50. See this file's
// header for the full algorithm.
type HorizontalTreeDecorationFeature struct {
	identifier string

	placesBlock       block.ID
	placesBlockName   string
	placesBlockStates map[string]block.StateValue // resolved entry's own states, base for the derived variants
	allowAdjacent     bool
	barkSideOnly      bool

	// missingRequiredStates is step 0's answer, decided once at build time:
	// the required states places_block's TYPE does not declare. When it is
	// non-empty the engine content-logs and places nothing, every time, with
	// no draw taken -- so Place refuses immediately. It is empty both when
	// the type declares both states and when the type is not in the vanilla
	// catalogue at all (nothing is known about a pack's own block, so the
	// gates are assumed to pass, as they always were).
	missingRequiredStates []string

	pal *block.Palette // build-time palette, for interning the derived state variants -- same pattern as multiface.go
}

func (f *HorizontalTreeDecorationFeature) TypeID() string     { return horizontalTreeDecorationTypeID }
func (f *HorizontalTreeDecorationFeature) Identifier() string { return f.identifier }

// Place mirrors the horizontal-tree-decoration feature's placement
// step by step -- see this file's header for the full algorithm and the
// numbered steps referenced below.
func (f *HorizontalTreeDecorationFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, horizontalTreeDecorationTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	pal := api.Palette()

	// Step 0: the two required-state gates, decided at build time against the
	// block type's own declared states. A type that declares neither or only
	// one of them content-logs and places NOTHING -- and does so before any
	// draw, which is why this returns here rather than after the draw.
	if len(f.missingRequiredStates) > 0 {
		return nil
	}

	// Step 2: *** RNG DRAW #1 *** the engine's random horizontal face draw
	// = a bounded draw of 4, plus 2 -> {2,3,4,5} = North/South/West/East.
	face := 2 + rnd.NextIntBound(4)

	// Step 3: the target cell (one step from origin along face) must be empty
	// (air-material -- the block's empty test). Latched here, tested in
	// step 5f/6, exactly as the engine latches it.
	off := horizontalTreeDecorationFacingOffsets[face]
	target := wgen.BlockPos{X: origin.X + off.X, Y: origin.Y + off.Y, Z: origin.Z + off.Z}
	targetIsEmpty := pal.IsAir(api.GetBlock(target))

	// Step 4: adjacency -- no places_block-typed block may already touch the
	// origin horizontally or the target on any of its six sides, unless
	// allow_adjacent. Probe order and short-circuit match the game exactly
	// (origin N,E,S,W then target Up,Down,N,S,W,E -- see header step 4).
	adjacencyOK := true
	if !f.allowAdjacent {
		adjacencyOK = func() bool {
			for _, dir := range [4]int{2, 5, 3, 4} {
				o := horizontalTreeDecorationFacingOffsets[dir]
				p := wgen.BlockPos{X: origin.X + o.X, Y: origin.Y + o.Y, Z: origin.Z + o.Z}
				if pal.NameOf(api.GetBlock(p)) == f.placesBlockName {
					return false
				}
			}
			for _, dir := range [6]int{1, 0, 2, 3, 4, 5} {
				o := horizontalTreeDecorationFacingOffsets[dir]
				p := wgen.BlockPos{X: target.X + o.X, Y: target.Y + o.Y, Z: target.Z + o.Z}
				if pal.NameOf(api.GetBlock(p)) == f.placesBlockName {
					return false
				}
			}
			return true
		}()
	}

	// Steps 5/6: the combined gate, in the engine's own branch shape.
	if f.barkSideOnly {
		// Step 5a-5c: the trunk block's pillar_axis. See this file's header
		// ("What this port cannot model") for the absent-state approximation.
		trunkID := api.GetBlock(origin)
		axis, hasAxis := pal.StatesOf(trunkID)["pillar_axis"].(string)
		if !hasAxis {
			trunkName := pal.NameOf(trunkID)
			state, declares := block.LookupVanillaState(trunkName, "pillar_axis")
			switch {
			case declares:
				// The type declares pillar_axis and nothing wrote a value, so
				// the block carries the type's own default -- which is what
				// the engine reads here. pillar_axis is an enumerated state,
				// so its default is one of its spellings.
				axis, _ = state.Default.(string)
			case block.VanillaBlockKnown(trunkName):
				// Step 5b's real branch: the type has no pillar_axis at all
				// (dirt, stone, anything that is not a pillar), and the
				// engine fails the whole placement, silently. This bench used
				// to be unable to tell that case from a default-state log,
				// and warned instead of failing.
				return nil
			default:
				// A pack's own block: nothing is known about what its type
				// declares, so the old approximation and its disclosure
				// stand, now confined to exactly this case.
				axis = "y"
				LogWarning(ctx, horizontalTreeDecorationTypeID,
					"bark_side_only: the block at the origin is not a vanilla block, so this bench cannot "+
						"tell whether its type carries a pillar_axis state. Treated as pillar_axis=y (the "+
						"vanilla default for every log/pillar block, and what a vertical trunk placed by "+
						"this bench's own tree_feature is). The real engine fails the whole placement when "+
						"the type carries no pillar_axis state at all.",
					&origin)
			}
		}
		// Step 5d: West/East faces (X direction) never place on an X-axis
		// log's end grain (axis value 1 = x).
		if (face == 4 || face == 5) && axis == "x" {
			return nil // silent, like every step 3-6 failure in the engine
		}
		// Step 5e/5f: North/South faces (Z direction) likewise reject a
		// Z-axis log (axis value 2 = z), folded into the combined gate
		// exactly as the engine folds it.
		barkOK := !((face == 2 || face == 3) && axis == "z")
		if !(targetIsEmpty && adjacencyOK && barkOK) {
			return nil
		}
	} else if !(targetIsEmpty && adjacencyOK) {
		return nil // step 6 -- silent, zero further draws
	}

	// Step 7: *** RNG DRAW #2 *** the engine's inclusive bounded draw over
	// (0, 1) = a bounded draw of 2, plus 0 -- drawn only after every check passed, before
	// the write.
	//
	// Spelled through the shared nextIntInclusive helper rather than as a bare
	// NextIntBound(2), even though the two are identical here: the game uses
	// the inclusive form, and keeping it spelled that way means a future reader
	// does not have to work out that min == 0 made the difference vanish.
	growth := nextIntInclusive(rnd, 0, 1)

	// Step 8: derive the placed block -- places_block with
	// minecraft:cardinal_direction set to the drawn face's compass name and
	// growth set to the drawn value, on top of whatever states the descriptor
	// itself carried (the engine's pair of state writes mutates the resolved
	// block's own permutation the same way).
	states := make(map[string]block.StateValue, len(f.placesBlockStates)+2)
	for k, v := range f.placesBlockStates {
		states[k] = v
	}
	states["minecraft:cardinal_direction"] = horizontalTreeDecorationCardinalName[face]
	states["growth"] = float64(growth)
	placedID := f.pal.Get(f.placesBlockName, states)

	// Step 9: the engine's single-block write -- one ungated SetBlock,
	// success iff the write landed (the engine returns the target as a
	// present result iff the write returned true).
	if !api.SetBlock(target, placedID) {
		return nil
	}
	result := target
	return &result
}

func buildHorizontalTreeDecorationFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	placesRaw, ok := body["places_block"]
	if !ok {
		// REQUIRED -- see header SCHEMA.
		return nil, fmt.Errorf("places_block is required")
	}
	placesDesc, err := AsBlockDescriptor(placesRaw, "places_block")
	if err != nil {
		return nil, err
	}
	placesBlock := ctx.Palette.Resolve(placesDesc)
	placesEntry := ctx.Palette.Entry(placesBlock)

	optionalBool := func(key string) (bool, error) {
		raw, present := body[key]
		if !present {
			// OPTIONAL, default false -- see header SCHEMA.
			return false, nil
		}
		v, ok := raw.(bool)
		if !ok {
			return false, fmt.Errorf("%s must be a boolean", key)
		}
		return v, nil
	}

	allowAdjacent, err := optionalBool("allow_adjacent")
	if err != nil {
		return nil, err
	}
	barkSideOnly, err := optionalBool("bark_side_only")
	if err != nil {
		return nil, err
	}

	// Step 0's two required-state gates, evaluated once here against
	// places_block's own block type rather than assumed -- see this file's
	// header. Nothing is knowable about a pack's own block, so an unknown
	// type keeps the old assumption and the old disclosure.
	var missing []string
	if block.VanillaBlockKnown(placesEntry.Name) {
		for _, key := range horizontalTreeDecorationRequiredStates {
			if _, declares := block.LookupVanillaState(placesEntry.Name, key); !declares {
				missing = append(missing, key)
			}
		}
		if len(missing) > 0 {
			ctx.Warn(fmt.Sprintf(
				"%s: the engine requires places_block's block type to carry the minecraft:cardinal_direction "+
					"and growth block states, and refuses to place (with a content-log error) when it does "+
					"not. %q carries no %s, so this feature places nothing at all -- which is what the game "+
					"does with it too. Pick a block whose type has both states.",
				ctx.Identifier, placesEntry.Name, strings.Join(missing, " and no ")))
		}
	} else {
		ctx.Warn(fmt.Sprintf(
			"%s: the engine requires places_block's block type to carry the minecraft:cardinal_direction "+
				"and growth block states, and refuses to place (with a content-log error) when it does not. "+
				"%q is not a vanilla block, so this bench cannot check that: it assumes both states exist "+
				"and places the block with both set. If the real game logs \"did not have the required "+
				"block state\" for this feature, that is the gap firing.",
			ctx.Identifier, placesEntry.Name))
	}

	return &HorizontalTreeDecorationFeature{
		identifier:            ctx.Identifier,
		placesBlock:           placesBlock,
		placesBlockName:       placesEntry.Name,
		placesBlockStates:     placesEntry.States,
		allowAdjacent:         allowAdjacent,
		barkSideOnly:          barkSideOnly,
		missingRequiredStates: missing,
		pal:                   ctx.Palette,
	}, nil
}

func init() {
	RegisterType(horizontalTreeDecorationTypeID, buildHorizontalTreeDecorationFeature)
}

var _ wgen.IFeature = (*HorizontalTreeDecorationFeature)(nil)
