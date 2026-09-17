// landform_test.go covers the two environment-layer defects that were silent
// before: a sea_floor_depth that was configurable everywhere and honoured
// nowhere, and presets that degenerated into an empty (or completely solid)
// bench under a perfectly legal --origin/--size without saying a word.
//
// Both are in the layer UNDERNEATH every feature type, which is why the
// assertions below insist on a direction rather than a value: an all-air bench
// and a sea floor that is one block thinner than asked for are both
// plausible-looking results, and a test that only checks "something was built"
// or "the output changed" passes against either bug.
package env

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/volume"
)

func oceanBench(t *testing.T, depth float64) (*volume.Volume, *block.Palette, ResolvedMaterials) {
	t.Helper()
	preset, ok := GetEnvironment(EnvOcean)
	if !ok {
		t.Fatal("ocean preset not found")
	}
	palette := block.NewPalette()
	slots := preset.Materials
	slots.SeaFloorDepth = depth
	materials := InternMaterialSlots(palette, slots, nil)
	vol := volume.New(volume.Bounds{
		MinX: -8, MinY: preset.Defaults.MinY, MinZ: -8,
		SizeX: 16, SizeY: preset.Defaults.SizeY, SizeZ: 16,
	}, palette, block.AirID)
	preset.Build(vol, 12345, materials)
	return vol, palette, materials
}

// seabedTop is the Y of the topmost non-air block in a column -- the seabed
// surface, since everything above it is water and water is not air.
func seabedTop(t *testing.T, v *volume.Volume, palette *block.Palette, x, z int, water block.ID) int {
	t.Helper()
	for y := v.MaxY() - 1; y >= v.MinY(); y-- {
		id := v.GetBlockAt(x, y, z)
		if !palette.IsAir(id) && id != water {
			return y
		}
	}
	t.Fatalf("column (%d, %d) has no seabed at all", x, z)
	return 0
}

// TestOceanBuildHonoursSeaFloorDepth pins the fix for a slot that was parsed
// from a pack biome, merged, rounded, clamped, put on ResolvedMaterials,
// exposed on the wire, given a --sea-floor-depth flag and a field in both
// apps' panels -- and read by no preset at all. `--env ocean` with 0 and with
// 10 produced byte-identical output.
//
// The direction here is the thickness AND where the band sits: a band built
// one block short, or built upward from the seabed instead of down into it,
// still "changes the output" and still puts gravel where a screenshot would
// show gravel. So this asserts the exact requested count of sea_floor_material
// blocks, starting at the seabed surface, with the block BELOW the band no
// longer sea_floor_material.
func TestOceanBuildHonoursSeaFloorDepth(t *testing.T) {
	const depth = 3
	vol, palette, materials := oceanBench(t, depth)
	water := materials.Sea

	for _, col := range [][2]int{{-8, -8}, {-3, 4}, {0, 0}, {5, -6}, {7, 7}} {
		x, z := col[0], col[1]
		top := seabedTop(t, vol, palette, x, z, water)
		for i := 0; i < depth; i++ {
			y := top - i
			if got := vol.GetBlockAt(x, y, z); got != materials.SeaFloor {
				t.Errorf("column (%d, %d): block %d below the seabed surface is %q, want sea_floor_material %q -- "+
					"the band is thinner than the requested sea_floor_depth of %d",
					x, z, i, palette.NameOf(got), palette.NameOf(materials.SeaFloor), depth)
			}
		}
		// One block deeper than asked for must NOT be sea floor: a band that
		// runs long is the same class of bug as one that runs short.
		if got := vol.GetBlockAt(x, top-depth, z); got == materials.SeaFloor {
			t.Errorf("column (%d, %d): the band is still sea_floor_material %d blocks down, deeper than the "+
				"requested sea_floor_depth of %d", x, z, depth, depth)
		}
		// And the band must go DOWN from the seabed, not up into the water:
		// the cell above the surface is still sea_material.
		if got := vol.GetBlockAt(x, top+1, z); got != water {
			t.Errorf("column (%d, %d): the cell above the seabed is %q, want sea_material %q -- the band grew "+
				"upward into the water column instead of down into the seabed",
				x, z, palette.NameOf(got), palette.NameOf(water))
		}
	}
}

// TestOceanSeaFloorDepthDeeperBandDoesNotMoveTheSeabed pins the other
// direction the band could plausibly have been wrong in: sea_floor_depth is a
// depth, so raising it must dig further DOWN, never raise the sea floor
// towards the surface. A build that stacked the band on top of the terrain
// would produce a thicker gravel bed and a shallower ocean, which looks
// perfectly reasonable in a screenshot.
func TestOceanSeaFloorDepthDeeperBandDoesNotMoveTheSeabed(t *testing.T) {
	shallow, palette, materials := oceanBench(t, 2)
	deep, deepPalette, deepMaterials := oceanBench(t, 8)

	for _, col := range [][2]int{{-8, -8}, {0, 0}, {7, 7}} {
		x, z := col[0], col[1]
		shallowTop := seabedTop(t, shallow, palette, x, z, materials.Sea)
		deepTop := seabedTop(t, deep, deepPalette, x, z, deepMaterials.Sea)
		if shallowTop != deepTop {
			t.Errorf("column (%d, %d): seabed surface moved from y=%d to y=%d when sea_floor_depth went from 2 "+
				"to 8 -- the band must extend downward, leaving the landform where it was",
				x, z, shallowTop, deepTop)
		}
	}
}

// TestOceanSeaFloorDepthZeroKeepsTheSurfaceDither pins that the preset's
// default -- every preset's native sea_floor_depth is 0 -- still produces
// exactly the terrain it always did: sand speckled with a 25% single-block
// gravel dither, NOT a zero-thickness band that quietly replaced it.
//
// This is the "nothing moved" half of implementing the slot. Both golden
// digests run on plains, so nothing else in the tree would have caught the
// default ocean bench changing shape.
func TestOceanSeaFloorDepthZeroKeepsTheSurfaceDither(t *testing.T) {
	vol, palette, materials := oceanBench(t, 0)
	sand, gravel := 0, 0
	for z := vol.MinZ(); z < vol.MinZ()+vol.SizeZ(); z++ {
		for x := vol.MinX(); x < vol.MinX()+vol.SizeX(); x++ {
			switch vol.GetBlockAt(x, seabedTop(t, vol, palette, x, z, materials.Sea), z) {
			case materials.Top:
				sand++
			case materials.SeaFloor:
				gravel++
			}
		}
	}
	if sand == 0 || gravel == 0 {
		t.Errorf("at sea_floor_depth 0 the seabed surface is %d top_material and %d sea_floor_material cells; "+
			"want both -- the 25%% dither is this preset's default look and must survive the band being added",
			sand, gravel)
	}
}

// TestInertSeaSlotOverridesOnlyFireForPresetsWithoutASea is the "or warn" half:
// sea_floor_depth is real now, but only for the one preset that builds a sea,
// so setting it anywhere else must say so instead of doing nothing quietly.
func TestInertSeaSlotOverridesOnlyFireForPresetsWithoutASea(t *testing.T) {
	depth := 4.0
	gravel := "minecraft:gravel"
	override := &MaterialOverride{SeaFloorDepth: &depth, SeaFloorMaterial: &gravel}

	ocean, _ := GetEnvironment(EnvOcean)
	if got := ocean.InertSeaSlotOverrides(override); len(got) != 0 {
		t.Errorf("ocean reported %v as inert, want none -- ocean is the preset that reads all three", got)
	}

	plains, _ := GetEnvironment(EnvPlains)
	got := plains.InertSeaSlotOverrides(override)
	if len(got) != 2 || got[0] != SlotSeaFloorMaterial || got[1] != SlotSeaFloorDepth {
		t.Errorf("plains reported %v as inert, want [%s %s]", got, SlotSeaFloorMaterial, SlotSeaFloorDepth)
	}

	// A run with no override at all must stay silent, even under a preset with
	// no sea: a loaded pack biome fills all three slots whether its author
	// meant to or not, and warning about those would fire on every biome-driven
	// run and mean nothing.
	if got := plains.InertSeaSlotOverrides(nil); got != nil {
		t.Errorf("plains reported %v as inert with no override set, want none", got)
	}
}

// ---------------------------------------------------------------------------
// Landform: a preset that promised a landform and did not build it.
// ---------------------------------------------------------------------------

func benchFor(t *testing.T, preset EnvironmentPreset, originX, originZ, sizeY int) *volume.Volume {
	t.Helper()
	palette := block.NewPalette()
	materials := InternMaterialSlots(palette, preset.Materials, nil)
	// Same bounds arithmetic session.generate uses: the volume follows the
	// horizontal origin, minX = originX - floor(sizeX/2).
	vol := volume.New(volume.Bounds{
		MinX: originX - preset.Defaults.SizeX/2, MinY: preset.Defaults.MinY, MinZ: originZ - preset.Defaults.SizeZ/2,
		SizeX: preset.Defaults.SizeX, SizeY: sizeY, SizeZ: preset.Defaults.SizeZ,
	}, palette, block.AirID)
	preset.Build(vol, 12345, materials)
	return vol
}

// TestCheckLandform_EndIslandLostAtADistantOriginIsReported pins the first of
// the two known degenerations: `end` measures its island from world (0,0)
// while the bench follows --origin, so --origin 100,68,100 built a bench that
// was 100% air under a preset described as "a floating end-stone island
// surrounded by void" -- with no diagnostic whatsoever.
//
// The direction that matters is that the check fires on the BROKEN bench and
// stays silent on the working one at the same preset. A check that fired on
// both would be noise nobody reads, which is how you end up back at silence.
func TestCheckLandform_EndIslandLostAtADistantOriginIsReported(t *testing.T) {
	preset, _ := GetEnvironment(EnvEnd)

	atOrigin := benchFor(t, preset, 0, 0, preset.Defaults.SizeY)
	if msg := preset.CheckLandform(atOrigin); msg != "" {
		t.Errorf("end at origin (0,0) reported %q, want no diagnostic -- this is the preset working", msg)
	}

	faraway := benchFor(t, preset, 100, 100, preset.Defaults.SizeY)
	msg := preset.CheckLandform(faraway)
	if msg == "" {
		t.Fatal("end at origin (100,100) built a bench with no solid block in it and reported nothing")
	}
	// The diagnostic has to name what to change, or it is barely better than
	// the silence it replaces.
	if !strings.Contains(msg, "--origin") {
		t.Errorf("diagnostic does not mention --origin, the flag that caused this: %q", msg)
	}
	if !strings.Contains(msg, "entirely air") {
		t.Errorf("diagnostic does not say what the bench actually contains: %q", msg)
	}
}

// TestCheckLandform_NetherCavernCrushedByAShortVolumeIsReported pins the
// second: `nether`'s cavern floor is minY+12 and its ceiling maxY-8, which
// cross once sizeY drops to 20, so `--size 32x20x32` produced a solid
// netherrack cube under a preset described as "solid netherrack with a
// hollowed cavern". 25,929 air cells at the default size, 0 at that one.
func TestCheckLandform_NetherCavernCrushedByAShortVolumeIsReported(t *testing.T) {
	preset, _ := GetEnvironment(EnvNether)

	full := benchFor(t, preset, 0, 0, preset.Defaults.SizeY)
	if msg := preset.CheckLandform(full); msg != "" {
		t.Errorf("nether at the default size reported %q, want no diagnostic", msg)
	}

	squashed := benchFor(t, preset, 0, 0, 20)
	msg := preset.CheckLandform(squashed)
	if msg == "" {
		t.Fatal("nether at sizeY=20 built a solid cube with no cavern and reported nothing")
	}
	if !strings.Contains(msg, "--size Y") {
		t.Errorf("diagnostic does not mention --size Y, the flag that caused this: %q", msg)
	}
	if !strings.Contains(msg, "solid all the way") {
		t.Errorf("diagnostic does not say what the bench actually contains: %q", msg)
	}
}

// TestCheckLandform_PresetsThatAreAllOneThingOnPurposeStaySilent is the
// other direction, and the reason this check is per preset rather than a
// blanket "every bench needs both air and solid" rule: `void` is 100% air
// because that is its entire purpose, and the underground family is 100%
// solid because that is theirs. Neither may ever produce a diagnostic, at any
// size -- a false positive here would train authors to ignore the true ones.
func TestCheckLandform_PresetsThatAreAllOneThingOnPurposeStaySilent(t *testing.T) {
	for _, id := range []EnvironmentID{EnvVoid, EnvUndergroundStone, EnvUndergroundDeepslate, EnvUndergroundMixed, EnvOcean} {
		preset, ok := GetEnvironment(id)
		if !ok {
			t.Fatalf("%s preset not found", id)
		}
		for _, sizeY := range []int{4, 16, 20, preset.Defaults.SizeY} {
			if msg := preset.CheckLandform(benchFor(t, preset, 0, 0, sizeY)); msg != "" {
				t.Errorf("%s at sizeY=%d reported %q; this preset is all one thing by design and must never fire",
					id, sizeY, msg)
			}
		}
	}
}

// TestEveryPromisingPresetCarriesAdvice: a preset that promises a landform has
// to be able to tell the author what to change when it fails to build it. The
// generic half of the message ("promised X, built Y") is the easy half; the
// half worth having is "your --origin is 100 blocks from the island".
func TestEveryPromisingPresetCarriesAdvice(t *testing.T) {
	for _, preset := range ENVIRONMENTS {
		if !preset.Landform.Solid && !preset.Landform.Air {
			continue
		}
		if strings.TrimSpace(preset.Landform.Advice) == "" {
			t.Errorf("%s promises a landform but carries no Advice: a diagnostic that cannot say what to "+
				"change is barely better than the silence it replaces", preset.ID)
		}
	}
}

// TestOnlyOceanBuildsASea guards the pairing the two features above both rest
// on: BuildsSea is what makes sea_floor_depth honoured here and reported inert
// everywhere else, so a new preset that grows a water column must set it (and
// one that does not must not claim it).
func TestOnlyOceanBuildsASea(t *testing.T) {
	for _, preset := range ENVIRONMENTS {
		want := preset.ID == EnvOcean
		if preset.BuildsSea != want {
			t.Errorf("%s: BuildsSea = %v, want %v", preset.ID, preset.BuildsSea, want)
		}
	}
}
