// ore_test.go pins the facts about the ore feature's placement that ore.go's header
// records about the game, so that a later edit has to argue with the recorded
// behaviour rather than with a previous implementation. Every expectation here is written
// independently of ore.go: the sphere geometry in
// TestOreFeature_MembershipUsesTheCellCentre is recomputed from the game's own formula
// list, which is why it fails against the spelling this file replaced (a cell-CORNER
// distance test with the half cell moved into the bounding box instead).
package features

import (
	"math"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

func oreTestBody(count int, rules []any) map[string]any {
	return map[string]any{
		"count":         float64(count),
		"replace_rules": rules,
	}
}

func oreTestOneRule() []any {
	return []any{map[string]any{
		"places_block": "minecraft:iron_ore",
		"may_replace":  []any{map[string]any{"name": "minecraft:stone"}},
	}}
}

func buildTestOre(t *testing.T, pal *block.Palette, body map[string]any) *OreFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:ore", FileID: "test:ore", Warn: func(string) {}}
	f, err := buildOreFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildOreFeature: %v", err)
	}
	of, ok := f.(*OreFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *OreFeature", f)
	}
	return of
}

// oreTestWorld returns a solid-stone volume centred on the origin the tests place at.
func oreTestWorld(pal *block.Palette) (*volume.Volume, block.ID, wgen.BlockPos) {
	stone := pal.Get("minecraft:stone", nil)
	b := volume.Bounds{MinX: -32, MinY: 32, MinZ: -32, SizeX: 65, SizeY: 65, SizeZ: 65}
	v := volume.New(b, pal, stone)
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				v.SetBlockUnbudgeted(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	return v, stone, wgen.BlockPos{X: 0, Y: 64, Z: 0}
}

func orePlace(f *OreFeature, api wgen.BlockWorld, origin wgen.BlockPos, rnd random.IRandom) *wgen.BlockPos {
	return f.Place(&wgen.PlacementContext{
		API:         api,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	})
}

// TestOreFeature_DrawSequence pins the order the game draws in: one float draw for the
// vein angle, then a bounded draw of 3 TWICE for the Y endpoints, then exactly one float draw per
// sphere. `discard_chance_on_air_exposure` is absent here (<= 0), so the per-match roll is
// skipped entirely and the count is exact.
func TestOreFeature_DrawSequence(t *testing.T) {
	const count = 5
	pal := block.NewPalette()
	f := buildTestOre(t, pal, oreTestBody(count, oreTestOneRule()))
	v, _, origin := oreTestWorld(pal)
	tr := random.NewTracer(random.New(12345))

	orePlace(f, v, origin, tr)

	want := []random.Method{random.MethodNextFloat, random.MethodNextIntBound, random.MethodNextIntBound}
	for i := 0; i < count; i++ {
		want = append(want, random.MethodNextFloat)
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draw count = %d, want %d (1 angle + 2 Y endpoints + %d spheres): %v", len(tr.Draws), len(want), count, tr.Draws)
	}
	for i, m := range want {
		if tr.Draws[i].Method != m {
			t.Fatalf("draw %d = %v, want %v", i, tr.Draws[i].Method, m)
		}
	}
	if tr.Draws[1].Bound != 3 || tr.Draws[2].Bound != 3 {
		t.Errorf("Y endpoint bounds = %d, %d, want 3, 3", tr.Draws[1].Bound, tr.Draws[2].Bound)
	}
}

// TestOreFeature_EmptyReplaceRulesStillSpendsTheThreeAxisDraws is the ordering fact that
// is easiest to get backwards, and this port did: the game's replace_rules emptiness test
// happens AFTER the angle float draw and after BOTH bounded draws of 3.
// A rules-less ore therefore still costs three draws, and everything placed
// after it in the same chain is shifted accordingly. It costs no MORE than three: the
// per-sphere loop is downstream of the bail.
// The rules-less file is spelled by OMITTING the key, not by writing `[]`: the key is
// optional, but an array that is present must hold at least one rule, and the game refuses
// the empty spelling at load time (see buildOreFeature's own comment).
func TestOreFeature_EmptyReplaceRulesStillSpendsTheThreeAxisDraws(t *testing.T) {
	pal := block.NewPalette()
	f := buildTestOre(t, pal, map[string]any{"count": float64(9)})
	v, _, origin := oreTestWorld(pal)
	tr := random.NewTracer(random.New(99))

	if got := orePlace(f, v, origin, tr); got != nil {
		t.Errorf("Place() = %v, want nil (empty replace_rules cannot place)", got)
	}
	if len(tr.Draws) != 3 {
		t.Fatalf("draw count = %d, want exactly 3: %v", len(tr.Draws), tr.Draws)
	}
	if tr.Draws[0].Method != random.MethodNextFloat ||
		tr.Draws[1].Method != random.MethodNextIntBound ||
		tr.Draws[2].Method != random.MethodNextIntBound {
		t.Errorf("draws = %v, want NextFloat, NextIntBound(3), NextIntBound(3)", tr.Draws)
	}
}

// TestOreFloorToInt_IsFloorNotTruncation pins how the game converts a float vector to a
// block position: it rounds toward minus
// infinity BEFORE converting to an integer, and that conversion truncates toward zero.
// The two agree for positives and disagree for
// every negative with a fractional part -- which is exactly where a vein below y=0, or
// west/north of the origin, lives.
func TestOreFloorToInt_IsFloorNotTruncation(t *testing.T) {
	for _, tc := range []struct {
		in   float32
		want int
	}{
		{2.7, 2}, {2.0, 2}, {0.5, 0}, {-0.5, -1}, {-2.7, -3}, {-3.0, -3},
	} {
		if got := oreFloorToInt(tc.in); got != tc.want {
			t.Errorf("oreFloorToInt(%v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestOreFeature_MembershipUsesTheCellCentre recomputes the whole vein from the game's
// own formula list -- the float32 chain quoted in ore.go's header -- and asserts the
// placed set is EXACTLY the cells whose CENTRE falls inside
// a kept sphere. The two halves this pins are a pair: the bounding box is a plain
// floor(centre +/- radius) with no half-cell bias, and the half cell
// appears instead in the distance test, whose loop floats are seeded with min + 0.5f
// and compared as (dx*dx + dy*dy) + dz*dz against radiusSq.
// Moving the half cell to the other side -- floor(c +/- r + 0.5) as the box and a
// cell-CORNER distance -- is self-consistent and lays the vein half a block off; this test
// is what tells the two apart.
func TestOreFeature_MembershipUsesTheCellCentre(t *testing.T) {
	const count = 6
	for _, seed := range []uint32{1, 2, 7, 31, 4242} {
		pal := block.NewPalette()
		f := buildTestOre(t, pal, oreTestBody(count, oreTestOneRule()))
		v, stone, origin := oreTestWorld(pal)
		orePlace(f, v, origin, random.New(seed))

		// Independent recomputation of the game's formula, not a copy of ore.go.
		r := random.New(seed)
		pi := float32(math.Pi) // the game's own float32 pi constant
		angle := float32(r.NextFloat()) * pi
		sinA := float32(math.Sin(float64(angle)))
		cosA := float32(math.Cos(float64(angle)))
		cf := float32(count)
		inv := float32(1) / cf
		scale := cf / 8
		ax := float32(sinA * scale)
		az := float32(cosA * scale)
		ox, oy, oz := float32(origin.X), float32(origin.Y), float32(origin.Z)
		x1 := ox + (8 + ax)
		z1 := oz + (8 + az)
		y1 := oy + (float32(r.NextIntBound(3)) - 2)
		x2 := ox + (8 - ax)
		z2 := oz + (8 - az)
		y2 := oy + (float32(r.NextIntBound(3)) - 2)
		dx, dy, dz := x2-x1, y2-y1, z2-z1

		type sph struct{ x, y, z, rsq, rad float32 }
		all := make([]sph, 0, count)
		piOverCount := pi * inv
		for i := 0; i < count; i++ {
			fi := float32(i)
			cx := x1 + float32(float32(dx*fi)*inv)
			cy := y1 + float32(float32(dy*fi)*inv)
			cz := z1 + float32(float32(dz*fi)*inv)
			d9 := float32(float32(r.NextFloat())*cf) / 16
			si := float32(math.Sin(float64(fi * piOverCount)))
			rad := (float32(float32(si+1)*d9) + 1) / 2
			rsq := rad * rad
			all = append(all, sph{cx, cy, cz, rsq, float32(math.Sqrt(float64(rsq)))})
		}
		kept := make([]sph, 0, count)
		for j := range all {
			enclosed := false
			for k := j + 1; k < len(all); k++ {
				ddx, ddy, ddz := all[k].x-all[j].x, all[k].y-all[j].y, all[k].z-all[j].z
				d := float32(ddx*ddx) + float32(ddy*ddy)
				d += float32(ddz * ddz)
				if all[j].rad+float32(math.Sqrt(float64(d))) < all[k].rad {
					enclosed = true
					break
				}
			}
			if !enclosed {
				kept = append(kept, all[j])
			}
		}

		inside := func(x, y, z int) bool {
			fx, fy, fz := float32(x)+0.5, float32(y)+0.5, float32(z)+0.5
			for _, s := range kept {
				ddx, ddy, ddz := fx-s.x, fy-s.y, fz-s.z
				d := float32(ddx*ddx) + float32(ddy*ddy)
				d += float32(ddz * ddz)
				if d < s.rsq {
					return true
				}
			}
			return false
		}

		// Sweep a box comfortably wider than any bounding box the vein can produce, so a
		// bounding box that is too NARROW shows up as a missing cell rather than going
		// unseen.
		placed, expected, mismatch := 0, 0, 0
		for x := -24; x <= 24; x++ {
			for y := 40; y <= 88; y++ {
				for z := -24; z <= 24; z++ {
					got := v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) != stone
					want := inside(x, y, z)
					if got {
						placed++
					}
					if want {
						expected++
					}
					if got != want && mismatch < 5 {
						t.Errorf("seed %d: cell (%d,%d,%d): placed=%v, cell-centre predicate=%v", seed, x, y, z, got, want)
						mismatch++
					}
				}
			}
		}
		if expected == 0 {
			t.Fatalf("seed %d: the re-derivation expects no cells at all -- the test is not testing anything", seed)
		}
		if placed != expected {
			t.Errorf("seed %d: placed %d cells, cell-centre predicate says %d", seed, placed, expected)
		}
	}
}

// TestOreFeature_ExplicitlyEmptyReplaceRulesIsRefused pins the distinction the port used to
// miss: the key is optional, so a file without it loads and fails at placement time -- but a
// file that writes the key as an empty array is refused by the game's schema outright, because
// every array node carries a minimum size and this one's is 1.
func TestOreFeature_ExplicitlyEmptyReplaceRulesIsRefused(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:ore", FileID: "test:ore", Warn: func(string) {}}

	if _, err := buildOreFeature(map[string]any{"count": 1.0, "replace_rules": []any{}}, ctx); err == nil {
		t.Fatal("an explicitly empty replace_rules must be refused, as the game refuses it")
	}

	var warnings []string
	warnCtx := &BuildContext{Palette: pal, Identifier: "test:ore", FileID: "test:ore",
		Warn: func(m string) { warnings = append(warnings, m) }}
	if _, err := buildOreFeature(map[string]any{"count": 1.0}, warnCtx); err != nil {
		t.Fatalf("an ABSENT replace_rules must still load: %v", err)
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly one saying the feature will never place", warnings)
	}
}
