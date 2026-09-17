package env

import (
	"fmt"

	"github.com/stirante/featurelab/volume"
)

// Landform is what an EnvironmentPreset.Build PROMISES to produce, so a
// post-build check can tell a preset that DEGENERATED from one that is doing
// exactly what it says on the tin.
//
// A blanket "every bench must contain both air and solid" rule is wrong in
// both directions here: "void" is 100% air on purpose (that is its whole
// point), "underground_stone" is 100% solid on purpose, and "ocean" fills its
// water column to the top of a short bench with no air left over -- none of
// those is a bug. What IS a bug is a preset whose own description promises a
// landform the bench does not contain, and every case of that found so far
// came from a legal --origin/--size the preset's hardcoded offsets were never
// written for:
//
//   - "end" measures its island from world (0,0) while the volume follows
//     --origin, so `--origin 100,68,100` produced a bench that was 100% air
//     under a preset described as "a floating end-stone island surrounded by
//     void" -- with no diagnostic at all.
//   - "nether" carves its cavern between minY+12 and maxY-8, which cross once
//     sizeY drops to 20, so `--size 32x20x32` produced a solid netherrack cube
//     under a preset described as "solid netherrack with a hollowed cavern"
//     (25,929 air cells at the default size, 0 at that one).
//
// So the check is driven per preset by what that preset promises, and it is
// deliberately binary -- ZERO cells of a promised kind, not "fewer than I
// expected". A proportional threshold would have to guess at what a thin
// island or a narrow cavern should weigh, and would start firing on benches
// that are merely small. Zero cannot be a matter of taste.
type Landform struct {
	// Solid is true if Build promises at least one non-air block.
	Solid bool
	// Air is true if Build promises at least one air cell -- open space the
	// feature under test can be placed INTO. False for presets that are solid
	// by design (the underground family) or flooded by design (ocean), where
	// having no air is not a defect.
	Air bool
	// Advice is this preset's own actionable half of the diagnostic: which
	// flag the author should change, and why THIS preset degenerates the way
	// it does. The generic half (what was promised, what the bench actually
	// contains) is built by CheckLandform; only the preset knows that its
	// island is anchored at world (0,0) or that its cavern needs 20+ blocks of
	// headroom. Required whenever Solid or Air is set: a diagnostic that says
	// "this went wrong" without saying what to change is barely better than
	// the silence it replaces (TestEveryPromisingPresetCarriesAdvice pins it).
	Advice string
}

// CheckLandform reports whether the volume preset p just built actually
// contains the landform p promises (see Landform), returning "" when it does
// and a ready-to-report diagnostic message when it does not.
//
// Called once per generation, straight after Build, against a volume that was
// just written cell by cell -- the scan below is one pass over the same cells
// Build wrote, with an early exit as soon as both kinds are seen, so on a
// healthy bench it stops within the first few columns.
func (p EnvironmentPreset) CheckLandform(v *volume.Volume) string {
	if !p.Landform.Solid && !p.Landform.Air {
		return ""
	}
	air, solid := countAirAndSolid(v)
	switch {
	case p.Landform.Solid && solid == 0:
		return fmt.Sprintf("the %q environment is described as %q, but the bench it just built is entirely air: "+
			"%d cells, not one solid block. Nothing here is standing on anything, and a feature that looks for "+
			"ground will find none. %s", p.ID, p.Description, air, p.Landform.Advice)
	case p.Landform.Air && air == 0:
		return fmt.Sprintf("the %q environment is described as %q, but the bench it just built is solid all the way "+
			"through: %d cells, not one air cell. There is no open space for a feature to be placed into. %s",
			p.ID, p.Description, solid, p.Landform.Advice)
	}
	return ""
}

// countAirAndSolid counts air vs non-air cells across the whole volume,
// stopping as soon as both have been seen (all CheckLandform needs to know is
// which kinds are PRESENT, and a healthy bench proves that immediately).
func countAirAndSolid(v *volume.Volume) (air, solid int) {
	pal := v.RawPalette()
	for y := v.MinY(); y < v.MaxY(); y++ {
		for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
			for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
				if pal.IsAir(v.GetBlockAt(x, y, z)) {
					air++
				} else {
					solid++
				}
				if air > 0 && solid > 0 {
					return air, solid
				}
			}
		}
	}
	return air, solid
}

// SeaSlotNames are the three material slots that only mean something to a
// preset whose Build models a sea -- "ocean" alone (see
// EnvironmentPreset.BuildsSea).
const (
	SlotSeaFloorMaterial = "sea_floor_material"
	SlotSeaMaterial      = "sea_material"
	SlotSeaFloorDepth    = "sea_floor_depth"
)

// InertSeaSlotOverrides returns the names of the sea-related material-slot
// overrides the caller explicitly set that THIS preset's Build will not read,
// in a stable order, or nil when there are none.
//
// This is the "or warn" half of honouring sea_floor_depth. The slot is now
// real -- ocean builds a genuine sea-floor band from it (see that preset's
// Build) -- but ocean is the only preset with a sea at all, so setting any of
// the three under "plains" or "nether" still does exactly nothing. It has a
// --sea-floor-depth flag and a field in both apps' panels, which is this
// tool's own addition rather than an inherited one, so a knob that quietly
// does nothing is this tool's own bug.
//
// Deliberately keyed on the OVERRIDE, not on the effective slot values: a
// loaded pack biome carries a surface_builder with all three fields whether
// its author thought about them or not, so warning on those would fire on
// every biome-driven run and mean nothing. An override is someone typing a
// value and expecting to see it.
func (p EnvironmentPreset) InertSeaSlotOverrides(override *MaterialOverride) []string {
	if override == nil || p.BuildsSea {
		return nil
	}
	var inert []string
	if override.SeaFloorMaterial != nil {
		inert = append(inert, SlotSeaFloorMaterial)
	}
	if override.SeaMaterial != nil {
		inert = append(inert, SlotSeaMaterial)
	}
	if override.SeaFloorDepth != nil {
		inert = append(inert, SlotSeaFloorDepth)
	}
	return inert
}
