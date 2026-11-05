package block

import "testing"

func rotated(name, key string, value StateValue, rotation int) StateValue {
	p := NewPalette()
	id := p.Get(name, map[string]StateValue{key: value})
	return p.StatesOf(p.RotateBlock(id, rotation))[key]
}

func TestRotateBlockFamilies(t *testing.T) {
	cases := []struct {
		name, key string
		value     StateValue
		rotation  int
		want      StateValue
	}{
		{"minecraft:oak_stairs", "weirdo_direction", float64(3), 1, float64(0)},
		{"minecraft:furnace", "minecraft:cardinal_direction", "north", 1, "east"},
		{"minecraft:furnace", "minecraft:cardinal_direction", "west", 1, "north"},
		{"minecraft:oak_log", "pillar_axis", "x", 1, "z"},
		{"minecraft:oak_log", "pillar_axis", "y", 1, "y"},
		{"minecraft:rail", "rail_direction", float64(0), 1, float64(1)},
		{"minecraft:rail", "rail_direction", float64(4), 1, float64(2)},
		{"minecraft:rail", "rail_direction", float64(6), 1, float64(7)},
		{"minecraft:torch", "torch_facing_direction", "top", 1, "top"},
		{"minecraft:torch", "torch_facing_direction", "east", 2, "west"},
		{"minecraft:dispenser", "facing_direction", float64(2), 1, float64(5)},
		{"minecraft:dispenser", "facing_direction", float64(1), 3, float64(1)},
		{"minecraft:lever", "lever_direction", "up_north_south", 1, "up_east_west"},
		{"minecraft:crafter", "orientation", "down_east", 1, "down_south"},
		{"minecraft:crafter", "orientation", "north_up", 3, "west_up"},
		{"minecraft:oak_trapdoor", "direction", float64(0), 1, float64(2)},
		{"minecraft:oak_trapdoor", "direction", float64(3), 1, float64(0)},
		{"minecraft:bed", "direction", float64(2), 1, float64(3)},
		{"minecraft:oak_sign", "ground_sign_direction", float64(14), 1, float64(2)},
		{"minecraft:vine", "vine_direction_bits", float64(4), 1, float64(8)},
		{"minecraft:vine", "vine_direction_bits", float64(8), 1, float64(1)},
		{"minecraft:glow_lichen", "multi_face_direction_bits", float64(17), 1, float64(33)},
		{"minecraft:glow_lichen", "multi_face_direction_bits", float64(32), 1, float64(4)},
	}
	for _, c := range cases {
		if got := rotated(c.name, c.key, c.value, c.rotation); got != c.want {
			t.Errorf("%s %s=%v rotated %d: got %v, want %v", c.name, c.key, c.value, c.rotation, got, c.want)
		}
	}
}

func TestRotateBlockConnections(t *testing.T) {
	p := NewPalette()
	id := p.Get("minecraft:cobblestone_wall", map[string]StateValue{
		"wall_connection_type_north": "tall", "wall_connection_type_east": "none",
		"wall_connection_type_south": "short", "wall_connection_type_west": "none",
	})
	states := p.StatesOf(p.RotateBlock(id, 1))
	if states["wall_connection_type_east"] != "tall" || states["wall_connection_type_west"] != "short" {
		t.Fatalf("got %v", states)
	}
}

func TestRotateBlockLeavesOtherBlocksAlone(t *testing.T) {
	p := NewPalette()
	plain := p.Get("minecraft:stone", nil)
	if p.RotateBlock(plain, 1) != plain {
		t.Fatal("a block without states must keep its id")
	}
	unknownValue := p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "sideways"})
	if p.RotateBlock(unknownValue, 1) != unknownValue {
		t.Fatal("a value no table knows must stay")
	}
	bad := p.Get("minecraft:oak_trapdoor", map[string]StateValue{"direction": float64(9)})
	if p.RotateBlock(bad, 1) != bad {
		t.Fatal("a trapdoor direction outside 0-3 must stay")
	}
	if p.RotateBlock(unknownValue, 0) != unknownValue {
		t.Fatal("rotation 0 must keep the id")
	}
	partial := p.Get("minecraft:cobblestone_wall", map[string]StateValue{"wall_connection_type_north": "tall"})
	if p.RotateBlock(partial, 1) != partial {
		t.Fatal("a wall with only some connection states must stay")
	}
	sameWall := p.Get("minecraft:cobblestone_wall", map[string]StateValue{
		"wall_connection_type_north": "tall", "wall_connection_type_east": "tall",
		"wall_connection_type_south": "tall", "wall_connection_type_west": "tall",
	})
	if p.RotateBlock(sameWall, 1) != sameWall {
		t.Fatal("rotating four equal connections must keep the id")
	}
}
