// single_block_rotation_test.go pins the two ways
// minecraft:single_block_feature reaches the game's block rotation -- the
// side-driven auto_rotate path in the attach check and the draw-driven
// randomize_rotation path in placement -- now that the transform
// itself exists (block/rotate.go, which owns the tables and their own tests).
// What is pinned HERE is the wiring: which direction each path passes, when
// each path is allowed to fire, and that neither of them changed the RNG.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

// placedKey places f once and returns the canonical descriptor of whatever
// ended up at the origin.
func placedKey(t *testing.T, pal *block.Palette, f wgen.IFeature, ctx *wgen.PlacementContext) string {
	t.Helper()
	if f.Place(ctx) == nil {
		t.Fatal("expected placement to succeed")
	}
	return pal.Entry(ctx.API.GetBlock(wgen.BlockPos{})).CanonicalString()
}

// fixedRandom returns the same raw unsigned draw every time, so a test can
// name the CommonDirection randomize_rotation will use.
type fixedRandom struct {
	*random.Rand
	value  uint32
	bounds []uint32
}

func (r *fixedRandom) NextUnsignedInt(bound uint32) uint32 {
	r.bounds = append(r.bounds, bound)
	return r.value
}

// TestSingleBlock_AutoRotateUsesTheLastMatchingSide is a very common shape:
// "may_attach_to": {} with nothing configured, so all four sides match
// for free and the LAST of them -- west, CommonDirection 3 -- is the one
// whose transform survives. auto_rotate defaults to TRUE, so this is not an
// exotic configuration: it is what most real files do.
//
// Note what canNOT be tested here, and why that is fine: the attach check transforms
// the ORIGINAL block for every side rather than the accumulated one -- the
// game starts from the unrotated block per side. Because each arm of the rotation is an absolute
// SET keyed only on the direction, transforming an already-transformed block
// gives the identical answer -- the two readings are indistinguishable by
// output. The port follows the game's shape anyway; block/rotate.go's
// TestTransformBlockIsAnAbsoluteSetNotARotation is what makes that safe.
func TestSingleBlock_AutoRotateUsesTheLastMatchingSide(t *testing.T) {
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "minecraft:amethyst_cluster",
			"states": map[string]any{"minecraft:block_face": "up"},
		},
		"may_attach_to": map[string]any{},
	})
	v := sbVolume(pal)
	got := placedKey(t, pal, f, sbCtx(v))
	if want := "minecraft:amethyst_cluster#minecraft:block_face=west"; got != want {
		t.Fatalf("placed %q, want %q -- all four sides match for free and west is last", got, want)
	}
}

// TestSingleBlock_AutoRotateFollowsTheOneMatchingSide pins the direction each
// side passes, one side at a time. All four sides have to be configured to do
// that: an UNCONFIGURED side counts as attached for free, so leaving three of
// them out would make all four match and the last (west) would always win --
// which is exactly what TestSingleBlock_AutoRotateUsesTheLastMatchingSide
// covers. Here every side names a block, only one neighbour is that block, and
// min_sides_must_attach is lowered to 1 so the single match still places.
func TestSingleBlock_AutoRotateFollowsTheOneMatchingSide(t *testing.T) {
	// The neighbour offsets are the game's: north is z-1, east x+1, south
	// z+1, west x-1 -- the game's own side order.
	cases := []struct {
		side     string
		dx, dz   int
		wantFace string
	}{
		{"north", 0, -1, "north"},
		{"east", 1, 0, "east"},
		{"south", 0, 1, "south"},
		{"west", -1, 0, "west"},
	}
	for _, c := range cases {
		pal := block.NewPalette()
		f := buildSB(t, pal, map[string]any{
			"places_block": map[string]any{
				"name":   "minecraft:amethyst_cluster",
				"states": map[string]any{"minecraft:block_face": "up"},
			},
			"may_attach_to": map[string]any{
				"north":                 "minecraft:stone",
				"east":                  "minecraft:stone",
				"south":                 "minecraft:stone",
				"west":                  "minecraft:stone",
				"min_sides_must_attach": float64(1),
			},
		})
		v := sbVolume(pal)
		v.SetBlock(wgen.BlockPos{X: c.dx, Z: c.dz}, pal.Get("minecraft:stone", nil))
		got := placedKey(t, pal, f, sbCtx(v))
		want := "minecraft:amethyst_cluster#minecraft:block_face=" + c.wantFace
		if got != want {
			t.Errorf("side %q: placed %q, want %q", c.side, got, want)
		}
	}
}

// TestSingleBlock_AutoRotateFalseLeavesTheBlockAlone: auto_rotate is the only
// thing that lets the side path rewrite the block. Turn it off and the sides
// are still counted -- the placement still succeeds -- but the block goes down
// exactly as the pack wrote it.
func TestSingleBlock_AutoRotateFalseLeavesTheBlockAlone(t *testing.T) {
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "minecraft:amethyst_cluster",
			"states": map[string]any{"minecraft:block_face": "up"},
		},
		"may_attach_to": map[string]any{"auto_rotate": false},
	})
	got := placedKey(t, pal, f, sbCtx(sbVolume(pal)))
	if want := "minecraft:amethyst_cluster#minecraft:block_face=up"; got != want {
		t.Fatalf("placed %q, want %q", got, want)
	}
}

// TestSingleBlock_RandomizeRotationPassesTheRawDrawAsTheDirection: place()
// takes the game's raw unsigned draw with a bound of 4 and passes it straight into the rotation,
// so the 0..3 draw IS the CommonDirection, with no remapping in between. Each
// row here fixes the draw and names the face it must produce.
func TestSingleBlock_RandomizeRotationPassesTheRawDrawAsTheDirection(t *testing.T) {
	for draw, wantFace := range map[uint32]string{0: "north", 1: "east", 2: "south", 3: "west"} {
		pal := block.NewPalette()
		f := buildSB(t, pal, map[string]any{
			"places_block": map[string]any{
				"name":   "minecraft:amethyst_cluster",
				"states": map[string]any{"minecraft:block_face": "up"},
			},
			"randomize_rotation": true,
		})
		v := sbVolume(pal)
		ctx := sbCtx(v)
		rnd := &fixedRandom{Rand: random.New(1), value: draw}
		ctx.Random = rnd
		got := placedKey(t, pal, f, ctx)
		want := "minecraft:amethyst_cluster#minecraft:block_face=" + wantFace
		if got != want {
			t.Errorf("draw %d: placed %q, want %q", draw, got, want)
		}
		// The RNG contract is unchanged by this feature gaining a transform:
		// one weighted pick over a single candidate makes no unsigned draw,
		// so the only raw unsigned draw here is rotation's, bound 4.
		if len(rnd.bounds) != 1 || rnd.bounds[0] != 4 {
			t.Errorf("draw %d: expected exactly one NextUnsignedInt(4), got %v", draw, rnd.bounds)
		}
	}
}

// TestSingleBlock_RandomizeRotationSuppressesTheSidePath: the gate in
// the attach check is `auto_rotate && !randomize_rotation`, so a file that sets both gets the
// DRAW's direction, not the last matching side's. With every side matching for
// free the side path would have produced west; a draw of 0 must produce north.
func TestSingleBlock_RandomizeRotationSuppressesTheSidePath(t *testing.T) {
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "minecraft:amethyst_cluster",
			"states": map[string]any{"minecraft:block_face": "up"},
		},
		"randomize_rotation": true,
		"may_attach_to":      map[string]any{}, // auto_rotate defaults to TRUE here
	})
	ctx := sbCtx(sbVolume(pal))
	ctx.Random = &fixedRandom{Rand: random.New(1), value: 0}
	got := placedKey(t, pal, f, ctx)
	if want := "minecraft:amethyst_cluster#minecraft:block_face=north"; got != want {
		t.Fatalf("placed %q, want %q -- randomize_rotation disables the side path entirely", got, want)
	}
}

// TestSingleBlock_RotationLeavesUnhandledBlocksAlone: the identity case this
// port implemented before the tables existed is still the answer for a block
// whose TYPE declares none of the sixteen states. minecraft:oak_leaves is one
// -- persistent_bit and update_bit are all it has, and neither is an arm.
//
// The block this test used to use, a standing banner carrying "rotation", is
// no longer an example of the identity case and is a better example of
// something else: "rotation" is still not an arm, but the banner's TYPE
// declares ground_sign_direction, so the game rotates it on that and leaves
// "rotation" alone. block/rotate_test.go's
// TestTransformBlockGateFollowsTheTypeNotTheWrittenStates pins that pair.
func TestSingleBlock_RotationLeavesUnhandledBlocksAlone(t *testing.T) {
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "minecraft:oak_leaves",
			"states": map[string]any{"persistent_bit": true},
		},
		"may_attach_to": map[string]any{},
	})
	got := placedKey(t, pal, f, sbCtx(sbVolume(pal)))
	if want := "minecraft:oak_leaves#persistent_bit=true"; got != want {
		t.Fatalf("placed %q, want %q -- no arm touches either of oak_leaves's states", got, want)
	}
}

// TestSingleBlock_WarnsOnlyForInferredSpellings: the load-time diagnostic no
// longer says "rotation is not implemented" -- it says "the direction matches
// the game, the spelling of it was inferred", and it only fires for the
// families where that is true. A pack whose rotating candidates carry
// minecraft:block_face, minecraft:cardinal_direction or pillar_axis gets no
// rotation warnings at all.
func TestSingleBlock_WarnsOnlyForInferredSpellings(t *testing.T) {
	build := func(states map[string]any, extra map[string]any) []string {
		pal := block.NewPalette()
		var warnings []string
		body := map[string]any{
			"places_block":                map[string]any{"name": "test:rotating_block", "states": states},
			"enforce_placement_rules":     false,
			"enforce_survivability_rules": false,
			"may_attach_to":               map[string]any{},
		}
		for k, v := range extra {
			body[k] = v
		}
		ctx := &BuildContext{Palette: pal, Resolver: condResolver{}, Identifier: "test:sb", FileID: "test:sb",
			Warn: func(w string) { warnings = append(warnings, w) }}
		if _, err := buildSingleBlockFeature(body, ctx); err != nil {
			t.Fatalf("build: %v", err)
		}
		var rotation []string
		for _, w := range warnings {
			if strings.Contains(w, "directional state") {
				rotation = append(rotation, w)
			}
		}
		return rotation
	}

	// These three common families are CONFIRMED end to end, so a file using
	// them is silent.
	for _, key := range []string{"minecraft:block_face", "minecraft:cardinal_direction", "pillar_axis"} {
		if got := build(map[string]any{key: "north"}, nil); len(got) != 0 {
			t.Errorf("%s is confirmed and must not warn, got %v", key, got)
		}
	}

	// An inferred family warns, and the message says what is inferred: the
	// spelling, not the direction.
	got := build(map[string]any{"lever_direction": "north"}, nil)
	if len(got) != 1 {
		t.Fatalf("lever_direction must warn exactly once, got %v", got)
	}
	// The two halves of the claim, which is the whole point of this warning:
	// the direction it picks is right, and only the NAME the value is written
	// under is uncertain. Keyed on short fragments rather than a sentence, so a
	// rewording does not fail a test about meaning.
	if !strings.Contains(got[0], "lever_direction") ||
		!strings.Contains(got[0], "direction it picks is right") ||
		!strings.Contains(got[0], "spelled differently") {
		t.Fatalf("warning must say the direction is right and the spelling uncertain, got %q", got[0])
	}

	// No rotation can fire -> no warning, however inferred the state is.
	if w := build(map[string]any{"lever_direction": "north"},
		map[string]any{"may_attach_to": map[string]any{"auto_rotate": false}}); len(w) != 0 {
		t.Errorf("auto_rotate false and randomize_rotation absent means no rotation fires; got %v", w)
	}
}
