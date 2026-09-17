// partially_exposed_blob.go implements minecraft:partially_exposed_blob_feature.
//
// Schema:
//
//	placement_radius_around_floor             int, REQUIRED validated range [1, 8]
//	placement_probability_per_valid_position  float, REQUIRED validated range [0.0, 1.0]
//	exposed_face                              string, optional; default "up" (face 1).
//	                                                              The default is not expressed in the
//	                                                              schema itself, but an absent
//	                                                              exposed_face behaves exactly like "up".
//	places_block                               block descriptor, REQUIRED
//
// exposed_face's accepted string values, and the face 0-5 each stores: down=0,
// up=1, north=2, south=3, west=4, east=5. [INFERRED: the exact string parsing
// is not confirmed -- but the stored face's MEANING is unambiguous regardless,
// because canBePlaced (see below) uses it directly as the face to skip, with
// Bedrock's 0-5 face encoding (sculk_patch.go's sculkFacingOffsets: Down=0,
// Up=1, North=2, South=3, West=4, East=5) -- and down/up/north/south/west/east
// is the only string set the game uses anywhere else for a single-face JSON field.]
//
// place() algorithm, in the exact order the game executes it:
//
//  1. center := {origin.x, origin.y - 1, origin.z} -- ONE below the placement origin (the "floor").
//  2. Walk every offset the ring-by-ring block-position walk yields from that center with extent
//     {radius,radius,radius} -- see "Search order" below for the exact enumeration this port
//     reproduces.
//  3. For EACH position in that walk, unconditionally: draw roll := the game's float draw -- *** RNG
//     CALL, once per position, always, regardless of the outcome ***. Only if roll <=
//     placement_probability_per_valid_position AND canBePlaced(pos) both hold (short-circuit `&&`,
//     so canBePlaced is never called -- and never costs anything -- when the roll alone already
//     fails) does it place `places_block` at pos and increment a counter.
//  4. If the counter is > 0, return success (this port returns the placement origin, matching this
//     codebase's IFeature.Place convention). Otherwise log
//     ("minecraft:partially_exposed_blob_feature", "No blocks could be placed") and return failure.
//     Both strings are the game's own, verbatim.
//
// Search order:
//
// It is a generic "walk a box outward from its center, ring by ring in Manhattan (L1)
// distance" utility -- NOT a plain nested x/y/z loop. Concretely, for extent {ex,ey,ez} (here
// ex=ey=ez=radius, since place() always uses all three equal), it enumerates every offset
// (dx,dy,dz) with |dx|<=ex, |dy|<=ey, |dz|<=ez, GROUPED into "rings" of increasing
// ring=|dx|+|dy|+|dz| (0, 1, 2, ..., ex+ey+ez), and within each ring: dx ascending over
// [-min(ring,ex), +min(ring,ex)], then for each dx, dy ascending over
// [-min(ring-|dx|,ey), +min(ring-|dx|,ey)], then dz is DERIVED (not independently looped) as
// zb := ring-|dx|-|dy|, skipped entirely if zb > ez, otherwise yielding (dx,dy,+zb) and -- ONLY when
// zb != 0 -- immediately also (dx,dy,-zb), the mirror around the center. For a CUBE (equal extents,
// this feature's only use), this bijects onto exactly the full (2*radius+1)^3-cell box, visited once
// each, ring 0 (the center itself) first. See partiallyExposedBlobOffsets and its accompanying
// TestPartiallyExposedBlobOffsets_* tests, which check both the exact early-ring order above
// and full-coverage/no-duplicates for several radii.
//
// canBePlaced -- what it ACTUALLY checks, no RNG:
//
// The position itself, plus all six face neighbors EXCEPT the one named by exposed_face, must each
// NOT be water (a material test for water -- NOT air; the same material test the game uses for
// waterlogging). The exposed_face neighbor is skipped from this check
// entirely -- neither required to be water NOR required not to be -- it is simply excluded,
// which is exactly the "may be exposed in this one
// direction" semantics the name implies (e.g. underwater magma: buried in solid ground on five
// sides, with the sixth, typically up, left unconstrained so it may legitimately touch the water
// above). The six faces are checked in fixed order Down(0), Up(1), North(2), South(3), West(4),
// East(5), and exactly the one check matching the stored exposed_face is skipped -- including
// Down (0).
//
// Layers: the game checks two block layers per position (the primary block and the
// waterlogging layer -- see structures.ResolvedStructure's own Layer1 doc comment for the same
// layer this port's world model has never modeled). Those collapse to ONE check here: this
// codebase's wgen.BlockWorld.GetBlock returns a single block.ID per position with no
// separate waterlog-layer query at all (unlike .mcstructure data, which does carry a Layer1 --
// just never surfaced through the live world API any feature place() call can see). Both checks
// are therefore folded into one isWaterBlock(api.GetBlock(pos)) check, which is a strictly
// faithful simplification given this port has no second layer to distinguish. Nothing about this
// type refuses.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const partiallyExposedBlobTypeID = "minecraft:partially_exposed_blob_feature"

// partiallyExposedBlobFacingOffsets is the six-neighbor scan order
// canBePlaced uses -- faces 0,1,2,3,4,5 in that exact order (Bedrock's face encoding: Down=0,
// Up=1, North=2, South=3, West=4, East=5 -- the same encoding sculk_patch.go's
// sculkFacingOffsets rests on).
var partiallyExposedBlobFacingOffsets = []wgen.BlockPos{
	{X: 0, Y: -1, Z: 0}, // Down (Facing 0)
	{X: 0, Y: 1, Z: 0},  // Up (Facing 1)
	{X: 0, Y: 0, Z: -1}, // North (Facing 2)
	{X: 0, Y: 0, Z: 1},  // South (Facing 3)
	{X: -1, Y: 0, Z: 0}, // West (Facing 4)
	{X: 1, Y: 0, Z: 0},  // East (Facing 5)
}

// exposedFaceByteNames maps the accepted JSON strings to the stored face --
// see module header's "exposed_face's accepted string values" note for the
// confidence level on this specific mapping.
var exposedFaceByteNames = map[string]int{
	"down": 0, "up": 1, "north": 2, "south": 3, "west": 4, "east": 5,
}

// partiallyExposedBlobOffsets reproduces the game's ring-by-ring
// block-position walk in its exact enumeration order, for a cube of the given
// radius in all three axes -- see module header's "Search order" section for
// the full description. Offset (0,0,0) (the center itself, i.e. ring 0) is
// always first.
func partiallyExposedBlobOffsets(radius int) []wgen.BlockPos {
	if radius < 0 {
		return nil
	}
	abs := func(v int) int {
		if v < 0 {
			return -v
		}
		return v
	}
	min := func(a, b int) int {
		if a < b {
			return a
		}
		return b
	}
	out := make([]wgen.BlockPos, 0, (2*radius+1)*(2*radius+1)*(2*radius+1))
	maxRing := 3 * radius
	for ring := 0; ring <= maxRing; ring++ {
		bx := min(ring, radius)
		for dx := -bx; dx <= bx; dx++ {
			adx := abs(dx)
			by := min(ring-adx, radius)
			for dy := -by; dy <= by; dy++ {
				ady := abs(dy)
				zb := ring - adx - ady
				if zb > radius {
					continue
				}
				out = append(out, wgen.BlockPos{X: dx, Y: dy, Z: zb})
				if zb != 0 {
					out = append(out, wgen.BlockPos{X: dx, Y: dy, Z: -zb})
				}
			}
		}
	}
	return out
}

// isWaterBlock mirrors the game's water material test -- approximated by
// canonical name since this port's block.Kind only
// tracks the coarser KindLiquid (water and lava together), consistent with
// this codebase's existing approximation precedent (e.g. sculk_patch.go's
// isSculkOrVein name check).
func isWaterBlock(pal wgen.IPaletteView, id block.ID) bool {
	name := pal.NameOf(id)
	return name == "minecraft:water" || name == "minecraft:flowing_water"
}

// PartiallyExposedBlobFeature is minecraft:partially_exposed_blob_feature. A
// leaf type -- no feature delegation, so it is always in scope.
type PartiallyExposedBlobFeature struct {
	identifier string

	radius        int
	probability   float64
	exposedFace   int
	placesBlockID block.ID
}

func (f *PartiallyExposedBlobFeature) TypeID() string     { return partiallyExposedBlobTypeID }
func (f *PartiallyExposedBlobFeature) Identifier() string { return f.identifier }

// canBePlaced mirrors the partially-exposed-blob feature's placement check
// exactly -- zero RNG. See module header for the full description.
func (f *PartiallyExposedBlobFeature) canBePlaced(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	pal := api.Palette()
	if isWaterBlock(pal, api.GetBlock(pos)) {
		return false
	}
	for face, off := range partiallyExposedBlobFacingOffsets {
		if face == f.exposedFace {
			continue // the one face deliberately excluded from this check
		}
		neighbor := wgen.BlockPos{X: pos.X + off.X, Y: pos.Y + off.Y, Z: pos.Z + off.Z}
		if isWaterBlock(pal, api.GetBlock(neighbor)) {
			return false
		}
	}
	return true
}

// Place mirrors the partially-exposed-blob feature's placement
// step-by-step -- see module header for the full algorithm.
func (f *PartiallyExposedBlobFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, partiallyExposedBlobTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	// Step 1: center is one below origin -- the "floor" this feature's
	// radius is measured around.
	center := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}

	placed := 0
	for _, off := range partiallyExposedBlobOffsets(f.radius) {
		pos := wgen.BlockPos{X: center.X + off.X, Y: center.Y + off.Y, Z: center.Z + off.Z}

		roll := rnd.NextFloat() // *** RNG CALL (always, one per candidate position) ***
		if roll <= f.probability && f.canBePlaced(api, pos) {
			api.SetBlock(pos, f.placesBlockID)
			placed++
		}
	}

	if placed == 0 {
		LogFailure(ctx, partiallyExposedBlobTypeID, "No blocks could be placed")
		return nil
	}
	result := origin
	return &result
}

func buildPartiallyExposedBlobFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	radiusRaw, ok := body["placement_radius_around_floor"]
	if !ok {
		return nil, fmt.Errorf("placement_radius_around_floor is required")
	}
	radiusF, ok := toFloat(radiusRaw)
	if !ok || radiusF != float64(int(radiusF)) {
		return nil, fmt.Errorf("placement_radius_around_floor must be an integer")
	}
	radius := int(radiusF)
	if radius < 1 || radius > 8 {
		return nil, fmt.Errorf("placement_radius_around_floor must be in [1, 8] (the game's own schema bound)")
	}

	probRaw, ok := body["placement_probability_per_valid_position"]
	if !ok {
		return nil, fmt.Errorf("placement_probability_per_valid_position is required")
	}
	probability, ok := toFloat(probRaw)
	if !ok {
		return nil, fmt.Errorf("placement_probability_per_valid_position must be a number")
	}
	if probability < 0 || probability > 1 {
		return nil, fmt.Errorf("placement_probability_per_valid_position must be in [0.0, 1.0] (the game's own schema bound)")
	}

	// exposed_face: optional, default "up" (face 1). The default is not
	// expressed in the schema, but a file that omits the key behaves exactly
	// like face 1 = up in the game.
	exposedFace := 1 // up -- see above
	if faceRaw, ok := body["exposed_face"]; ok {
		faceStr, ok := faceRaw.(string)
		if !ok {
			return nil, fmt.Errorf("exposed_face must be a string")
		}
		exposedFace, ok = exposedFaceByteNames[faceStr]
		if !ok {
			return nil, fmt.Errorf("exposed_face must be one of down, up, north, south, west, east (got %q)", faceStr)
		}
	}

	placesBlockRaw, ok := body["places_block"]
	if !ok {
		return nil, fmt.Errorf("places_block is required")
	}
	placesBlockDesc, err := AsBlockDescriptor(placesBlockRaw, "places_block")
	if err != nil {
		return nil, err
	}
	placesBlockID := ctx.Palette.Resolve(placesBlockDesc)

	return &PartiallyExposedBlobFeature{
		identifier:    ctx.Identifier,
		radius:        radius,
		probability:   probability,
		exposedFace:   exposedFace,
		placesBlockID: placesBlockID,
	}, nil
}

func init() {
	RegisterType(partiallyExposedBlobTypeID, buildPartiallyExposedBlobFeature)
}

var _ wgen.IFeature = (*PartiallyExposedBlobFeature)(nil)
