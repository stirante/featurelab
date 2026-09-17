package block

import "testing"

// The eleven measured cases the retarget pass named, plus one row per family
// rule in support.go. Every expectation here is the engine's answer for
// the any-support-type argument, as read out of the body described in
// support.go's supportRule constants -- if one of these ever has to change,
// the body it came from is the thing to re-read, not this table.

func TestCanProvideSupportMeasuredCases(t *testing.T) {
	// Measured rows, verbatim.
	cases := []struct {
		name   string
		states map[string]StateValue
		// want, indexed by Face: down, up, north, south, west, east.
		want [6]bool
		why  string
	}{
		{
			name: "minecraft:cobblestone_wall",
			want: [6]bool{true, true, false, false, false, false},
			why:  "the wall block's support test spells the fence rule out: face < 2",
		},
		{
			name: "minecraft:oak_fence",
			want: [6]bool{true, true, false, false, false, false},
			why:  "shape-0 block support component on the block definition",
		},
		{
			name: "minecraft:glass_pane",
			want: [6]bool{true, true, false, false, false, false},
			why:  "the thin fence block's support test, the fence rule again",
		},
		{
			name: "minecraft:iron_bars",
			want: [6]bool{true, true, false, false, false, false},
			why:  "the thin fence block as well -- bars and panes are the same class",
		},
		{
			name:   "minecraft:oak_slab",
			states: map[string]StateValue{VerticalHalfState: "bottom"},
			want:   [6]bool{true, false, false, false, false, false},
			why:    "the slab rule: a bottom slab supports only its DOWN face",
		},
		{
			name:   "minecraft:oak_stairs",
			states: map[string]StateValue{"upside_down_bit": false, "weirdo_direction": float64(0)},
			want:   [6]bool{true, false, false, false, false, true},
			why:    "right-side-up stair: DOWN, plus the face it backs onto (weirdo 0 -> east)",
		},
		{
			name:   "minecraft:snow_layer",
			states: map[string]StateValue{"height": float64(3)},
			want:   [6]bool{false, false, false, false, false, false},
			why:    "the top snow block ignores the face and wants height+1 == 8",
		},
		{
			name: "minecraft:farmland",
			want: [6]bool{true, false, false, false, false, false},
			why:  "farmland: DOWN only -- its top is 15/16 high",
		},
		{
			name: "minecraft:dirt_path",
			want: [6]bool{true, false, false, false, false, false},
			why:  "the dirt path block, same shape as farmland",
		},
		{
			name: "minecraft:torch",
			want: [6]bool{false, false, false, false, false, false},
			why:  "the torch block class replaces the mask with 0",
		},
		{
			name: "minecraft:glass",
			want: [6]bool{true, true, true, true, true, true},
			why: "the one that goes the OTHER way: the glass block never touches the " +
				"property mask, so it keeps bit 18 and supports every face -- " +
				"Palette.IsSolid calls it non-solid",
		},
	}
	for _, tc := range cases {
		for f := FaceDown; f <= FaceEast; f++ {
			got := CanProvideSupport(tc.name, tc.states, f)
			if got != tc.want[f] {
				t.Errorf("CanProvideSupport(%s, face %d) = %v, want %v (%s)",
					tc.name, f, got, tc.want[f], tc.why)
			}
		}
	}
}

func TestCanProvideSupportFamilies(t *testing.T) {
	cases := []struct {
		label  string
		name   string
		states map[string]StateValue
		want   [6]bool
	}{
		// Default: anything the table does not name supports every face.
		{"plain stone", "minecraft:stone", nil, [6]bool{true, true, true, true, true, true}},
		{"grass block", "minecraft:grass_block", nil, [6]bool{true, true, true, true, true, true}},
		{"add-on block keeps the default", "mypack:weird_block", nil, [6]bool{true, true, true, true, true, true}},
		// ...including an add-on block whose NAME looks like a vanilla family.
		{"add-on stairs are not given the stair rule", "mypack:oak_stairs", nil,
			[6]bool{true, true, true, true, true, true}},

		// Deny list.
		{"air", "minecraft:air", nil, [6]bool{false, false, false, false, false, false}},
		{"water", "minecraft:water", nil, [6]bool{false, false, false, false, false, false}},
		{"oak leaves", "minecraft:oak_leaves", nil, [6]bool{false, false, false, false, false, false}},
		{"poppy", "minecraft:poppy", nil, [6]bool{false, false, false, false, false, false}},
		{"white carpet", "minecraft:white_carpet", nil, [6]bool{false, false, false, false, false, false}},
		{"stone pressure plate", "minecraft:stone_pressure_plate", nil,
			[6]bool{false, false, false, false, false, false}},
		{"fence gate is NOT the fence rule", "minecraft:fence_gate", nil,
			[6]bool{false, false, false, false, false, false}},

		// Top-face-only.
		{"scaffolding", "minecraft:scaffolding", nil, [6]bool{false, true, false, false, false, false}},
		{"structure block", "minecraft:structure_block", nil, [6]bool{false, true, false, false, false, false}},
		{"hopper", "minecraft:hopper", nil, [6]bool{false, true, false, false, false, false}},
		{"cauldron", "minecraft:cauldron", nil, [6]bool{false, true, false, false, false, false}},

		// Bottom-face-only.
		{"chest", "minecraft:chest", nil, [6]bool{true, false, false, false, false, false}},
		{"anvil", "minecraft:anvil", nil, [6]bool{true, false, false, false, false, false}},
		{"oak hanging sign", "minecraft:oak_hanging_sign", nil, [6]bool{true, false, false, false, false, false}},
		{"white candle", "minecraft:white_candle", nil, [6]bool{true, false, false, false, false, false}},

		// Fence rule, the rest of the family.
		{"copper bars", "minecraft:waxed_copper_bars", nil, [6]bool{true, true, false, false, false, false}},
		{"decorated pot", "minecraft:decorated_pot", nil, [6]bool{true, true, false, false, false, false}},
		{"sniffer egg", "minecraft:sniffer_egg", nil, [6]bool{true, true, false, false, false, false}},

		// Slabs.
		{"top slab", "minecraft:oak_slab", map[string]StateValue{VerticalHalfState: "top"},
			[6]bool{false, true, false, false, false, false}},
		{"slab with no state is the bottom half", "minecraft:stone_brick_slab", nil,
			[6]bool{true, false, false, false, false, false}},
		{"legacy top_slot_bit", "minecraft:oak_slab", map[string]StateValue{"top_slot_bit": true},
			[6]bool{false, true, false, false, false, false}},
		{"double slab supports everything", "minecraft:oak_double_slab", nil,
			[6]bool{true, true, true, true, true, true}},
		{"copper slab is still a slab", "minecraft:waxed_cut_copper_slab",
			map[string]StateValue{VerticalHalfState: "top"}, [6]bool{false, true, false, false, false, false}},

		// Stairs. weirdo_direction -> facing is 5 - d: 0 east, 1 west, 2 south, 3 north.
		{"upside-down stair", "minecraft:oak_stairs",
			map[string]StateValue{"upside_down_bit": true, "weirdo_direction": float64(3)},
			[6]bool{false, true, true, false, false, false}},
		{"stair weirdo 1 backs onto west", "minecraft:stone_stairs",
			map[string]StateValue{"upside_down_bit": false, "weirdo_direction": float64(1)},
			[6]bool{true, false, false, false, true, false}},
		{"stair with no upside-down state answers false on both vertical faces",
			"minecraft:oak_stairs", map[string]StateValue{"weirdo_direction": float64(2)},
			[6]bool{false, false, false, true, false, false}},
		{"stair falling back to cardinal_direction", "minecraft:oak_stairs",
			map[string]StateValue{"upside_down_bit": false, CardinalDirectionState: "north"},
			[6]bool{true, false, true, false, false, false}},
		{"copper stairs get the component too", "minecraft:waxed_cut_copper_stairs",
			map[string]StateValue{"upside_down_bit": false, "weirdo_direction": float64(0)},
			[6]bool{true, false, false, false, false, true}},

		// Snow layer.
		{"full snow layer supports every face", "minecraft:snow_layer",
			map[string]StateValue{"height": float64(7)}, [6]bool{true, true, true, true, true, true}},
		{"snow layer with no height is one layer", "minecraft:snow_layer", nil,
			[6]bool{false, false, false, false, false, false}},

		// Chains.
		{"vertical chain", "minecraft:chain", map[string]StateValue{"pillar_axis": "y"},
			[6]bool{true, true, false, false, false, false}},
		{"chain with no axis defaults vertical", "minecraft:iron_chain", nil,
			[6]bool{true, true, false, false, false, false}},
		{"horizontal chain supports nothing", "minecraft:chain",
			map[string]StateValue{"pillar_axis": "x"}, [6]bool{false, false, false, false, false, false}},
		{"copper chain is a chain", "minecraft:waxed_copper_chain",
			map[string]StateValue{"pillar_axis": "z"}, [6]bool{false, false, false, false, false, false}},

		// Rods.
		{"upright end rod", "minecraft:end_rod", map[string]StateValue{"facing_direction": float64(1)},
			[6]bool{true, true, false, false, false, false}},
		{"sideways lightning rod supports nothing", "minecraft:lightning_rod",
			map[string]StateValue{"facing_direction": float64(4)},
			[6]bool{false, false, false, false, false, false}},

		// Trapdoors.
		{"closed bottom trapdoor", "minecraft:oak_trapdoor",
			map[string]StateValue{"open_bit": false, "upside_down_bit": false},
			[6]bool{true, false, false, false, false, false}},
		{"closed top trapdoor", "minecraft:oak_trapdoor",
			map[string]StateValue{"open_bit": false, "upside_down_bit": true},
			[6]bool{false, true, false, false, false, false}},
		{"open trapdoor, direction 0 -> west", "minecraft:oak_trapdoor",
			map[string]StateValue{"open_bit": true, "direction": float64(0)},
			[6]bool{false, false, false, false, true, false}},
		{"copper trapdoor inherits the rule", "minecraft:waxed_copper_trapdoor",
			map[string]StateValue{"open_bit": true, "direction": float64(2)},
			[6]bool{false, false, true, false, false, false}},

		// Shelves, skulls, grindstones, piston arms.
		{"shelf facing north backs onto south", "minecraft:oak_shelf",
			map[string]StateValue{CardinalDirectionState: "north"},
			[6]bool{false, false, false, true, false, false}},
		{"skull on the floor", "minecraft:skeleton_skull",
			map[string]StateValue{"facing_direction": float64(1)},
			[6]bool{true, false, false, false, false, false}},
		{"skull on a wall supports nothing", "minecraft:skeleton_skull",
			map[string]StateValue{"facing_direction": float64(3)},
			[6]bool{false, false, false, false, false, false}},
		{"standing grindstone", "minecraft:grindstone",
			map[string]StateValue{"attachment": "standing"},
			[6]bool{false, true, false, false, false, false}},
		{"hanging grindstone", "minecraft:grindstone",
			map[string]StateValue{"attachment": "hanging"},
			[6]bool{true, false, false, false, false, false}},
		{"side grindstone", "minecraft:grindstone",
			map[string]StateValue{"attachment": "side"},
			[6]bool{false, false, false, false, false, false}},
		{"piston arm facing up", "minecraft:piston_arm_collision",
			map[string]StateValue{"facing_direction": float64(1)},
			[6]bool{false, true, false, false, false, false}},
	}

	for _, tc := range cases {
		for f := FaceDown; f <= FaceEast; f++ {
			got := CanProvideSupport(tc.name, tc.states, f)
			if got != tc.want[f] {
				t.Errorf("%s: CanProvideSupport(%s, face %d) = %v, want %v",
					tc.label, tc.name, f, got, tc.want[f])
			}
		}
	}
}

// TestOppositeFaceIsAnInvolution guards the opposite-face table, which the
// snap caller depends on to turn "the direction I walked" into "the face of the
// block I hit". The game's table is 1 0 3 2 5 4.
func TestOppositeFaceIsAnInvolution(t *testing.T) {
	want := [6]Face{FaceUp, FaceDown, FaceSouth, FaceNorth, FaceEast, FaceWest}
	for f := FaceDown; f <= FaceEast; f++ {
		if OppositeFace[f] != want[f] {
			t.Fatalf("OppositeFace[%d] = %d, want %d", f, OppositeFace[f], want[f])
		}
		if OppositeFace[OppositeFace[f]] != f {
			t.Fatalf("OppositeFace is not an involution at %d", f)
		}
	}
}

// TestCanProvideSupportRejectsOutOfRangeFace is a guard on the caller contract,
// not on an engine behaviour: a Facing byte above 5 never reaches
// the block's support test in the engine, so answering false is this port's choice and
// is recorded here so it cannot drift silently.
func TestCanProvideSupportRejectsOutOfRangeFace(t *testing.T) {
	if CanProvideSupport("minecraft:stone", nil, Face(6)) {
		t.Fatal("face 6 should not be answered true")
	}
}

// TestPaletteCanProvideSupport checks the palette-side spelling agrees with the
// package function through a real interned entry, states and all.
func TestPaletteCanProvideSupport(t *testing.T) {
	p := NewPalette()
	slab := p.Get("minecraft:oak_slab", map[string]StateValue{VerticalHalfState: "top"})
	if !p.CanProvideSupport(slab, FaceUp) {
		t.Error("a top slab should support its UP face")
	}
	if p.CanProvideSupport(slab, FaceDown) {
		t.Error("a top slab should not support its DOWN face")
	}
	glass := p.Get("minecraft:glass", nil)
	if p.IsSolid(glass) {
		t.Fatal("precondition: this bench classifies glass as non-solid")
	}
	for f := FaceDown; f <= FaceEast; f++ {
		if !p.CanProvideSupport(glass, f) {
			t.Errorf("glass should support face %d even though it is not a solid KIND", f)
		}
	}
}
