// motion_test.go pins block/motion.go's vanilla answers for the block's
// motion-blocking and solid-blocking predicates. It replaces
// kind_test.go, which pinned the render-kind approximation these two used to
// be; every case below that disagrees with that approximation is called out,
// because those disagreements are the only evidence anyone has about how wrong
// the guess was.
package block

import "testing"

func check(t *testing.T, name string, wantMotion, wantSolid bool) {
	t.Helper()
	if got := IsMotionBlocking(name, nil); got != wantMotion {
		t.Errorf("IsMotionBlocking(%s) = %v, want %v", name, got, wantMotion)
	}
	if got := IsSolidBlocking(name, nil); got != wantSolid {
		t.Errorf("IsSolidBlocking(%s) = %v, want %v", name, got, wantSolid)
	}
}

func TestMotion_FullCubesAndTheEmptyOnes(t *testing.T) {
	// Material 23 with property bit 18 intact: the ordinary full block.
	for _, name := range []string{
		"minecraft:stone", "minecraft:dirt", "minecraft:oak_planks", "minecraft:moss_block",
		"minecraft:white_wool", "minecraft:red_concrete", "minecraft:blue_terracotta",
		"minecraft:snow", "minecraft:packed_ice",
	} {
		check(t, name, true, true)
	}
	// Air (bit 18 cleared by the air block's own block-property override of 0) and the
	// liquids (materials 5 and 6, whose blocksMotion byte is 0).
	for _, name := range []string{
		"minecraft:air", "minecraft:cave_air", "minecraft:void_air",
		"minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava",
		"minecraft:poppy", "minecraft:short_grass", "minecraft:kelp", "minecraft:vine",
	} {
		check(t, name, false, false)
	}
}

func TestMotion_SolidBlockingIsStrictlyNarrower(t *testing.T) {
	// The solid-blocking material flag is `byte1 == 0 && blocksMotion != 0`, so
	// a material with byte 1 set blocks motion without being solid-blocking.
	// These are the families that land there, and every one of them is a case
	// the old Palette.IsSolid stand-in for the solid-blocking predicate got
	// wrong.
	for _, name := range []string{
		"minecraft:oak_leaves", "minecraft:cherry_leaves", "minecraft:azalea_leaves",
		"minecraft:glass", "minecraft:blue_stained_glass", "minecraft:tinted_glass",
		"minecraft:ice", "minecraft:frosted_ice",
		"minecraft:beacon", "minecraft:sea_lantern", "minecraft:glowstone",
	} {
		check(t, name, true, false)
	}
	// ice and packed_ice come from the same class and differ only in a flag
	// that selects material 13 or material 23.
	check(t, "minecraft:ice", true, false)
	check(t, "minecraft:packed_ice", true, true)
}

func TestMotion_SnowLayerDoesNotBlockMotion(t *testing.T) {
	// The headline correction. minecraft:snow_layer was reported as
	// motion-blocking by the old predicate, and an earlier note carried it as
	// "KNOWN WRONG, the real answer depends on the layer height". Both are
	// refuted: the top snow block overrides its properties to 0x808, which does
	// not include bit 18, and its material is 24, whose blocksMotion byte is 0.
	// The answer is false, once, for all eight heights -- the predicate never
	// reads a block state.
	check(t, "minecraft:snow_layer", false, false)
	for _, h := range []StateValue{int64(0), int64(3), int64(7)} {
		if IsMotionBlocking("minecraft:snow_layer", map[string]StateValue{"height": h}) {
			t.Errorf("snow_layer height=%v must not block motion", h)
		}
	}
}

func TestMotion_PartialBlocksDoNotBlockMotion(t *testing.T) {
	// The largest single group of corrections, ~350 ids. Every one of these
	// classes replaces the property mask, and no override mask anywhere in the
	// game contains bit 18, so the partial-shape families
	// lose it wholesale. The old predicate reported all of them as blocking
	// motion because their render Kind is Solid.
	for _, name := range []string{
		"minecraft:oak_stairs", "minecraft:oak_slab", "minecraft:normal_stone_slab",
		"minecraft:cobblestone_wall", "minecraft:oak_fence", "minecraft:fence_gate",
		"minecraft:glass_pane", "minecraft:iron_bars", "minecraft:wooden_door", "minecraft:trapdoor",
		"minecraft:stone_button", "minecraft:stone_pressure_plate", "minecraft:standing_sign",
		"minecraft:white_carpet", "minecraft:candle", "minecraft:anvil",
		"minecraft:chest", "minecraft:ladder", "minecraft:scaffolding",
		"minecraft:powder_snow", "minecraft:lightning_rod", "minecraft:undyed_shulker_box",
	} {
		check(t, name, false, false)
	}
	// A DOUBLE slab is the exception, and it is a conditional inside
	// the slab block class rather than a separate class: a double slab adds
	// block properties 0x40000 instead of 0x2, so bit 18 comes back.
	for _, name := range []string{
		"minecraft:oak_double_slab", "minecraft:normal_stone_double_slab",
		"minecraft:double_cut_copper_slab",
	} {
		check(t, name, true, true)
	}
}

func TestMotion_PlantsThatLookLikeTheyShouldBlockMotion(t *testing.T) {
	// These four were expected to be interesting, and they
	// are: all four have a collision box in game, and none of them is
	// motion-blocking to the game. Lily pads and big dripleaf were reported
	// false by the old predicate too (they classify as KindPlant), but cactus
	// and bamboo were in its alwaysMotionBlocking exception set and are
	// corrections.
	check(t, "minecraft:waterlily", false, false)
	check(t, "minecraft:big_dripleaf", false, false)
	check(t, "minecraft:sea_pickle", false, false)
	check(t, "minecraft:cactus", false, false)
	check(t, "minecraft:bamboo", false, false)
}

func TestMotion_BitEighteenIsNotEnoughOnItsOwn(t *testing.T) {
	// minecraft:structure_void KEEPS property bit 18 -- nothing overrides its
	// mask -- and is still not motion-blocking,
	// because its material (22) has blocksMotion == 0. It is the clearest case
	// in the table that both halves of the AND are load-bearing.
	check(t, "minecraft:structure_void", false, false)
	// And it is still not air, which is what grounded/unburied/leveled care
	// about: they compare against air's own default state.
	if classify("minecraft:structure_void", nil) == KindAir {
		t.Error("structure_void must not classify as air -- the constraints that test against air's " +
			"default state have to keep seeing it as a real block")
	}
}

func TestMotion_UnknownIdsTakeTheEngineUnknownBlockAnswer(t *testing.T) {
	// An id the GAME does not know: the unknown-block placeholder has material
	// 1 and never overrides the property mask, so bit 18 survives and both
	// predicates hold.
	for _, name := range []string{"somepack:whatever", "wiki:not_a_real_block"} {
		check(t, name, true, true)
	}
	// A pack's own "mypack:oak_stairs" is NOT quietly given the stair answer;
	// only minecraft:-namespaced ids are in the table at all.
	check(t, "mypack:oak_stairs", true, true)
}

func TestMotion_PackDefinedBlocksAreMaterialOneWhateverTheirJsonSays(t *testing.T) {
	// This test exists to stop an obvious-looking "fix": reading
	// minecraft:collision_box out of a pack's blocks/**/*.json and reporting a
	// block that removed its collision box as not motion-blocking. That is
	// wrong, and it is wrong against the game rather than merely unverified.
	//
	// Every JSON block is a plain block type with material type 1, which no
	// JSON key can change, and property bit 18, which nothing on that path
	// clears. Material 1 has blocksMotion != 0 and byte 1 == 0, i.e.
	// (motion-blocking, solid-blocking) = (true, true). minecraft:collision_box
	// is per-block component data instead and never reaches either input. See
	// motion.go's header for the full account.
	//
	// The names below stand in for the three shapes a pack's collision_box
	// takes, all of which get the SAME answer:
	//   absent            -> the game's full cube
	//   true / an object  -> a declared box
	//   false             -> no collision at all
	for _, name := range []string{
		"mypack:no_collision_box_declared",
		"mypack:collision_box_true",
		"mypack:collision_box_partial",
		"mypack:collision_box_false",
		"mypack:decorative_plant",
	} {
		check(t, name, true, true)
	}
	// And a pack block is type-level exactly as a vanilla one is: the states a
	// permutation would switch a collision box on cannot change the answer,
	// because the predicate never sees the Block.
	check(t, "mypack:collision_box_false", true, true)
	if !IsMotionBlocking("mypack:collision_box_false", map[string]StateValue{"mypack:open": true}) {
		t.Error("a pack block's states must not change IsMotionBlocking")
	}
}

func TestMotion_LegacySpellings(t *testing.T) {
	// The spellings kind.go accepts that the game does not define under
	// that name. INFERRED -- see legacyMotionSpellings.
	check(t, "minecraft:web", false, false)
	check(t, "minecraft:cobweb", false, false)
	check(t, "minecraft:lily_pad", false, false)
	// The legacy aggregate leaf ids are resolved by aliases.go before a palette
	// entry exists, so IsMotionBlocking never sees them; if one does arrive it
	// takes the default rather than a silently narrowed answer.
	check(t, "minecraft:leaves", true, true)
}
