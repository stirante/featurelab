// partially_exposed_blob_test.go exercises PartiallyExposedBlobFeature's RNG
// draw sequence explicitly (one NextFloat per candidate position, in the
// exact ring-by-ring, centre-outwards search order), not just final block
// counts -- see partially_exposed_blob.go's header for the algorithm this is
// checking against. No golden regression scene exercises this type, so these
// tests are the only thing standing between a wrong port and a caller relying
// on this type.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// ---------------------------------------------------------------------------
// partiallyExposedBlobOffsets -- the reconstructed ring-by-ring,
// centre-outwards enumeration order, tested on its own before anything else
// depends on it.
// ---------------------------------------------------------------------------

func TestPartiallyExposedBlobOffsets_CenterFirst(t *testing.T) {
	for radius := 1; radius <= 4; radius++ {
		off := partiallyExposedBlobOffsets(radius)
		if len(off) == 0 {
			t.Fatalf("radius=%d: no offsets", radius)
		}
		if off[0] != (wgen.BlockPos{}) {
			t.Errorf("radius=%d: off[0] = %+v, want the zero offset (center) first", radius, off[0])
		}
	}
}

func TestPartiallyExposedBlobOffsets_FullCubeCoverageNoDuplicates(t *testing.T) {
	for radius := 1; radius <= 3; radius++ {
		off := partiallyExposedBlobOffsets(radius)
		want := (2*radius + 1) * (2*radius + 1) * (2*radius + 1)
		if len(off) != want {
			t.Fatalf("radius=%d: len(offsets) = %d, want %d ((2r+1)^3)", radius, len(off), want)
		}
		seen := make(map[wgen.BlockPos]bool, want)
		for _, o := range off {
			if seen[o] {
				t.Fatalf("radius=%d: offset %+v yielded more than once", radius, o)
			}
			seen[o] = true
			if o.X < -radius || o.X > radius || o.Y < -radius || o.Y > radius || o.Z < -radius || o.Z > radius {
				t.Fatalf("radius=%d: offset %+v outside the cube", radius, o)
			}
		}
		// Full coverage: every cell in the cube must appear exactly once.
		for x := -radius; x <= radius; x++ {
			for y := -radius; y <= radius; y++ {
				for z := -radius; z <= radius; z++ {
					if !seen[wgen.BlockPos{X: x, Y: y, Z: z}] {
						t.Fatalf("radius=%d: cell (%d,%d,%d) never visited", radius, x, y, z)
					}
				}
			}
		}
	}
}

// TestPartiallyExposedBlobOffsets_Ring1Order pins the exact hand-derived
// order for the six ring-1 neighbors (see partially_exposed_blob.go header's
// "Search order" section for the order this checks): dx ascending
// (-1,0,+1), and within dx=0, dy ascending with z's +/- pair emitted
// immediately together (+z before -z).
func TestPartiallyExposedBlobOffsets_Ring1Order(t *testing.T) {
	off := partiallyExposedBlobOffsets(1)
	want := []wgen.BlockPos{
		{X: 0, Y: 0, Z: 0}, // ring 0: center
		// ring 1:
		{X: -1, Y: 0, Z: 0},
		{X: 0, Y: -1, Z: 0},
		{X: 0, Y: 0, Z: 1},
		{X: 0, Y: 0, Z: -1},
		{X: 0, Y: 1, Z: 0},
		{X: 1, Y: 0, Z: 0},
	}
	if len(off) < len(want) {
		t.Fatalf("len(offsets) = %d, want at least %d", len(off), len(want))
	}
	for i, w := range want {
		if off[i] != w {
			t.Errorf("off[%d] = %+v, want %+v", i, off[i], w)
		}
	}
}

// ---------------------------------------------------------------------------
// Feature-level tests.
// ---------------------------------------------------------------------------

func buildTestPartiallyExposedBlob(t *testing.T, pal *block.Palette, extra map[string]any) wgen.IFeature {
	t.Helper()
	body := map[string]any{
		"placement_radius_around_floor":            float64(1),
		"placement_probability_per_valid_position": float64(1),
		"exposed_face": "up",
		"places_block": "minecraft:magma",
	}
	for k, v := range extra {
		body[k] = v
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:blob", FileID: "test:blob", Warn: func(string) {}}
	f, err := buildPartiallyExposedBlobFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildPartiallyExposedBlobFeature: %v", err)
	}
	return f
}

func placeTestPartiallyExposedBlob(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

// newBlobTestVolume builds a volume with a solid stone block filling a
// (2*radius+3)-ish cube around the "floor" position (origin.y-1), i.e. no
// water anywhere -- every candidate position's canBePlaced() should pass
// (modulo the probability roll), isolating the RNG-draw-sequence tests below
// from canBePlaced's own logic.
func newBlobTestVolume(t *testing.T, radius int) (*volume.Volume, *block.Palette, wgen.BlockPos) {
	t.Helper()
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	r := radius + 2
	bounds := volume.Bounds{MinX: -r, MinY: 50, MinZ: -r, SizeX: 2*r + 1, SizeY: 30, SizeZ: 2*r + 1}
	v := volume.New(bounds, pal, stone) // out-of-bounds reads as stone too
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	floorCenter := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	for _, off := range partiallyExposedBlobOffsets(radius) {
		pos := wgen.BlockPos{X: floorCenter.X + off.X, Y: floorCenter.Y + off.Y, Z: floorCenter.Z + off.Z}
		v.SetBlock(pos, stone)
		// Fill the 6 neighbors too, since canBePlaced inspects them.
		for _, n := range partiallyExposedBlobFacingOffsets {
			v.SetBlock(wgen.BlockPos{X: pos.X + n.X, Y: pos.Y + n.Y, Z: pos.Z + n.Z}, stone)
		}
	}
	return v, pal, origin
}

// TestPartiallyExposedBlobFeature_DrawsExactlyOneFloatPerCandidate proves
// the roll is UNCONDITIONAL: with probability=0 (never places), Place()
// still draws exactly one NextFloat per one of the (2*radius+1)^3 candidate
// positions -- never fewer (short-circuited early), never more.
func TestPartiallyExposedBlobFeature_DrawsExactlyOneFloatPerCandidate(t *testing.T) {
	radius := 1
	v, pal, origin := newBlobTestVolume(t, radius)
	f := buildTestPartiallyExposedBlob(t, pal, map[string]any{
		"placement_radius_around_floor":            float64(radius),
		"placement_probability_per_valid_position": float64(0),
	})

	tracer := random.NewTracer(random.New(1))
	got := placeTestPartiallyExposedBlob(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (probability 0 never places)", got)
	}
	want := (2*radius + 1) * (2*radius + 1) * (2*radius + 1)
	if len(tracer.Draws) != want {
		t.Fatalf("draws = %d, want %d (one NextFloat per candidate position)", len(tracer.Draws), want)
	}
	for i, d := range tracer.Draws {
		if d.Method != random.MethodNextFloat {
			t.Errorf("draw[%d].Method = %v, want NextFloat", i, d.Method)
		}
	}
}

// TestPartiallyExposedBlobFeature_ProbabilityOneAndAllClear_PlacesEveryCandidate
// checks the other extreme: probability=1.0 means every draw satisfies
// roll<=1.0, so (with canBePlaced clear everywhere) every one of the
// (2*radius+1)^3 candidates gets places_block.
func TestPartiallyExposedBlobFeature_ProbabilityOneAndAllClear_PlacesEveryCandidate(t *testing.T) {
	radius := 1
	v, pal, origin := newBlobTestVolume(t, radius)
	f := buildTestPartiallyExposedBlob(t, pal, map[string]any{
		"placement_radius_around_floor":            float64(radius),
		"placement_probability_per_valid_position": float64(1),
		"exposed_face": "up", // irrelevant here -- nothing is water
	})

	got := placeTestPartiallyExposedBlob(f, v, origin, random.New(1))
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}
	floorCenter := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	magma := "minecraft:magma"
	for _, off := range partiallyExposedBlobOffsets(radius) {
		pos := wgen.BlockPos{X: floorCenter.X + off.X, Y: floorCenter.Y + off.Y, Z: floorCenter.Z + off.Z}
		if name := pal.NameOf(v.GetBlock(pos)); name != magma {
			t.Errorf("block at %+v = %q, want %q", pos, name, magma)
		}
	}
}

// TestPartiallyExposedBlobFeature_ExposedFaceSkipsOnlyThatNeighbor proves
// canBePlaced's face-skip: with water on the "up" neighbor of the floor
// center, exposed_face="up" must still allow placement there, but
// exposed_face="down" (a different, non-water-adjacent face) must not
// change the outcome for that same position -- while water on a REQUIRED
// face (north, when exposed_face=up) must refuse it.
func TestPartiallyExposedBlobFeature_ExposedFaceSkipsOnlyThatNeighbor(t *testing.T) {
	radius := 1
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	water := pal.Get("minecraft:water", nil)
	bounds := volume.Bounds{MinX: -3, MinY: 50, MinZ: -3, SizeX: 7, SizeY: 30, SizeZ: 7}
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	floorCenter := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}

	build := func(v *volume.Volume) *volume.Volume {
		for _, off := range partiallyExposedBlobOffsets(radius) {
			pos := wgen.BlockPos{X: floorCenter.X + off.X, Y: floorCenter.Y + off.Y, Z: floorCenter.Z + off.Z}
			v.SetBlock(pos, stone)
			for _, n := range partiallyExposedBlobFacingOffsets {
				v.SetBlock(wgen.BlockPos{X: pos.X + n.X, Y: pos.Y + n.Y, Z: pos.Z + n.Z}, stone)
			}
		}
		// Water directly above the floor center only.
		v.SetBlock(wgen.BlockPos{X: floorCenter.X, Y: floorCenter.Y + 1, Z: floorCenter.Z}, water)
		return v
	}

	t.Run("exposed_face=up tolerates water above", func(t *testing.T) {
		v := build(volume.New(bounds, pal, stone))
		f := buildTestPartiallyExposedBlob(t, pal, map[string]any{
			"placement_radius_around_floor":            float64(radius),
			"placement_probability_per_valid_position": float64(1),
			"exposed_face": "up",
		})
		placeTestPartiallyExposedBlob(f, v, origin, random.New(1))
		if name := pal.NameOf(v.GetBlock(floorCenter)); name != "minecraft:magma" {
			t.Errorf("floor center = %q, want minecraft:magma (up is the exposed face)", name)
		}
	})

	t.Run("exposed_face=down does not tolerate water above", func(t *testing.T) {
		v := build(volume.New(bounds, pal, stone))
		f := buildTestPartiallyExposedBlob(t, pal, map[string]any{
			"placement_radius_around_floor":            float64(radius),
			"placement_probability_per_valid_position": float64(1),
			"exposed_face": "down",
		})
		placeTestPartiallyExposedBlob(f, v, origin, random.New(1))
		if name := pal.NameOf(v.GetBlock(floorCenter)); name == "minecraft:magma" {
			t.Errorf("floor center = %q, want unchanged (up is water and NOT the exposed face)", name)
		}
	})
}

// TestPartiallyExposedBlobFeature_ExposedFaceDefaultsToUp pins the game's
// default of 1 (up) for exposed_face: an absent exposed_face builds
// successfully and behaves exactly like "up" (face 1). This replaces the
// earlier required-field refusal -- see partially_exposed_blob.go's header.
func TestPartiallyExposedBlobFeature_ExposedFaceDefaultsToUp(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:blob", FileID: "test:blob", Warn: func(string) {}}
	body := map[string]any{
		"placement_radius_around_floor":            float64(1),
		"placement_probability_per_valid_position": float64(1),
		"places_block": "minecraft:magma",
	}
	got, err := buildPartiallyExposedBlobFeature(body, ctx)
	if err != nil {
		t.Fatalf("build with exposed_face absent: %v (the field is optional in the engine, default up)", err)
	}
	f, ok := got.(*PartiallyExposedBlobFeature)
	if !ok {
		t.Fatalf("built %T, want *PartiallyExposedBlobFeature", got)
	}
	if f.exposedFace != 1 {
		t.Errorf("exposedFace = %d, want 1 (up -- the game's default)", f.exposedFace)
	}
}

// TestPartiallyExposedBlobFeature_SchemaValidation exercises the game's own
// schema bounds at build time.
func TestPartiallyExposedBlobFeature_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:blob", FileID: "test:blob", Warn: func(string) {}}
	base := func() map[string]any {
		return map[string]any{
			"placement_radius_around_floor":            float64(1),
			"placement_probability_per_valid_position": float64(1),
			"exposed_face": "up",
			"places_block": "minecraft:magma",
		}
	}

	t.Run("placement_radius_around_floor out of range (too low)", func(t *testing.T) {
		b := base()
		b["placement_radius_around_floor"] = float64(0) // the game's own bound is [1,8]
		if _, err := buildPartiallyExposedBlobFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("placement_radius_around_floor out of range (too high)", func(t *testing.T) {
		b := base()
		b["placement_radius_around_floor"] = float64(9)
		if _, err := buildPartiallyExposedBlobFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("placement_probability_per_valid_position out of range", func(t *testing.T) {
		b := base()
		b["placement_probability_per_valid_position"] = float64(1.5)
		if _, err := buildPartiallyExposedBlobFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("exposed_face invalid string", func(t *testing.T) {
		b := base()
		b["exposed_face"] = "sideways"
		if _, err := buildPartiallyExposedBlobFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("places_block required", func(t *testing.T) {
		b := base()
		delete(b, "places_block")
		if _, err := buildPartiallyExposedBlobFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("valid body builds", func(t *testing.T) {
		if _, err := buildPartiallyExposedBlobFeature(base(), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
}
