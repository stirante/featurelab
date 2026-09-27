package block

import "testing"

func TestSupportsVegetation_ExactlyTheElevenBlocks(t *testing.T) {
	want := []string{"dirt", "grass_block", "podzol", "coarse_dirt", "mycelium", "dirt_with_roots",
		"moss_block", "pale_moss_block", "mud", "muddy_mangrove_roots", "farmland"}
	for _, n := range want {
		if !SupportsVegetation("minecraft:" + n) {
			t.Errorf("%s: not in the group", n)
		}
	}
	if len(supportsVegetation) != len(want) {
		t.Errorf("group has %d entries, want %d", len(supportsVegetation), len(want))
	}
	for _, n := range []string{"minecraft:stone", "minecraft:sand", "minecraft:gravel", "minecraft:air", "minecraft:rooted_dirt"} {
		if SupportsVegetation(n) {
			t.Errorf("%s: in the group", n)
		}
	}
}

func TestCanSurvive_FoliageFamily(t *testing.T) {
	for _, n := range []string{"poppy", "dandelion", "cornflower", "oak_sapling", "cherry_sapling", "bush"} {
		if ok, known := CanSurvive("minecraft:"+n, "minecraft:grass_block"); !ok || !known {
			t.Errorf("%s on grass_block = (%v,%v), want (true,true)", n, ok, known)
		}
		if ok, known := CanSurvive("minecraft:"+n, "minecraft:stone"); ok || !known {
			t.Errorf("%s on stone = (%v,%v), want (false,true)", n, ok, known)
		}
	}
	// Nether roots: the nether vegetation set is not modelled, so a miss is unknown.
	if ok, known := CanSurvive("minecraft:crimson_roots", "minecraft:dirt"); !ok || !known {
		t.Errorf("crimson_roots on dirt = (%v,%v), want (true,true)", ok, known)
	}
	if ok, known := CanSurvive("minecraft:crimson_roots", "minecraft:crimson_nylium"); !ok || known {
		t.Errorf("crimson_roots on nylium = (%v,%v), want (true,false)", ok, known)
	}
	// Unmodelled blocks pass, unknown.
	if ok, known := CanSurvive("minecraft:red_mushroom", "minecraft:stone"); !ok || known {
		t.Errorf("red_mushroom = (%v,%v), want (true,false)", ok, known)
	}
}

func TestMayPlace_FoliageFamily(t *testing.T) {
	cases := []struct {
		cell  string
		air   bool
		below string
		want  bool
	}{
		{"minecraft:air", true, "minecraft:grass_block", true},
		{"minecraft:short_grass", false, "minecraft:grass_block", true},
		{"minecraft:water", false, "minecraft:grass_block", false},
		{"minecraft:lava", false, "minecraft:grass_block", false},
		{"minecraft:stone", false, "minecraft:grass_block", false},
		{"minecraft:air", true, "minecraft:stone", false},
	}
	for _, c := range cases {
		if ok, known := MayPlace("minecraft:poppy", c.cell, c.air, c.below); ok != c.want || !known {
			t.Errorf("poppy into %s over %s = (%v,%v), want (%v,true)", c.cell, c.below, ok, known, c.want)
		}
	}
}
