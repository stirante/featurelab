package block

// motion.go answers two questions the game asks about a block TYPE, and only
// about a type:
//
//	the block's motion-blocking predicate -- structure_template's
//	    block_intersection partitions the template's cells with it
//	the block's solid-blocking predicate  -- structure_template's grounded and
//	    leveled constraints test the world with it
//
// Until 2026-08-22 both were stand-ins. IsMotionBlocking was built off
// kind.go's render-kind table plus two hand-written exception sets, and the
// solid-blocking side was Palette.IsSolid ("is this one of the solid KINDS").
// Neither matched vanilla and no test or baseline in this repo could catch an
// error in them. The table below models vanilla behaviour.
//
// The behaviour modelled is that of Bedrock 1.26.50.
//
// ---- The predicate, top to bottom ----
//
// The motion-blocking predicate depends only on the block's type, so the
// question is TYPE-level: every state of one type gets one answer and no block
// state can influence it. IsMotionBlocking still takes a `states` argument it
// does not consult; that is structurally right, not a shortcut.
//
// The block-type motion-blocking predicate is exactly:
//
//	the motion-blocking material flag of the type's material,
//	ANDed with bit 18 of the type's 64-bit block property mask
//
// The block-type solid-blocking predicate is the same with the solid-blocking
// material flag in place of the motion-blocking one. So the two predicates
// differ only in which material flag they read, and share the block-type flag
// exactly.
//
// Bit 18 of the property mask is the same bit the block type's support test
// tests first (see support.go), and it is the only property a block type
// starts with. The mask changes in exactly two ways: a property override
// (which REPLACES it) and a property addition (which only ever ORs bits in).
// The "solid" and "opaque full block" settings are separate from the mask and
// never touch it.
//
// ---- Material ----
//
// A Material is a 7-byte record:
//
//	+0  material type
//	+1  (no named flag; see the solid-blocking flag)
//	+2  isLiquid
//	+3  blocksMotion   the motion-blocking material flag
//	+4  blocksPrecipitation
//	+5  isSolid
//	+6  isSuperHot
//
// The solid-blocking material flag is not a field: it is
// `byte1 == 0 && blocksMotion != 0`. Solid-blocking therefore implies
// motion-blocking, which is why there is no "solid but not motion" case below.
//
// There are exactly 25 materials, indexed by material type (each row's byte 0
// equals its index -- a consistency check that holds for all 25).
//
//	type  name                        byte1 liquid motion precip solid hot   motion / solid-blocking
//	  0   air                             0     0      0      0      0    0     no  / no
//	  1   dirt                            0     0      1      1      1    0     yes / yes
//	  2   wood                            0     0      1      1      1    0     yes / yes
//	  3   metal                           0     0      1      1      1    0     yes / yes
//	  4   grate                           0     0      1      1      1    0     yes / yes
//	  5   water                           0     1      0      1      0    0     no  / no
//	  6   lava                            0     1      0      1      0    1     no  / no
//	  7   leaves                          1     0      1      1      1    0     yes / NO
//	  8   plant                           0     0      0      0      0    0     no  / no
//	  9   solid_plant                     0     0      1      0      1    0     yes / yes
//	 10   fire                            0     0      0      0      0    1     no  / no
//	 11   glass                           1     0      1      1      1    0     yes / NO
//	 12   explosive                       1     0      1      1      1    0     yes / NO
//	 13   ice                             1     0      1      1      1    0     yes / NO
//	 14   powder_snow                     0     0      1      1      0    0     yes / yes
//	 15   cactus                          1     0      1      1      1    0     yes / NO
//	 16   portal                          0     0      0      0      0    0     no  / no
//	 17   stone_decoration                0     0      0      0      1    0     no  / no
//	 18   bubble                          0     1      0      0      0    0     no  / no
//	 19   barrier                         0     0      1      0      1    0     yes / yes
//	 20   decoration_solid                0     0      0      0      1    0     no  / no
//	 21   client_request_placeholder      0     0      0      0      1    0     no  / no
//	 22   structure_void                  0     0      0      0      1    0     no  / no
//	 23   solid                           0     0      1      1      1    0     yes / yes
//	 24   non_solid                       0     0      0      0      0    0     no  / no
//
// The material-type names run air, dirt, wood, ... , non_solid, then one more
// name, "any", which is a wildcard rather than a 26th material. The names are
// an independent check on the rows and they agree everywhere it is testable:
// tnt is material 12 and 12 is "explosive", structure_void is 22 and 22 is
// "structure_void", bubble_column is 18 and 18 is "bubble", snow_layer is 24
// and 24 is "non_solid".
//
// Material 1 is "dirt" -- worth naming, because it is the material both an
// unknown block and every PACK-defined block get (see below).
//
// ---- How the per-block table is organised ----
//
// The same class grouping as support.go, keeping the RAW mask instead of a
// support rule. Vanilla defines 1261 distinct "minecraft:..." ids, 1228 of
// which are the plain snake_case of their internal name (the 33 that are not
// are the known naming quirks -- tripwire_hook, campfire, farmland, frame,
// glowingobsidian, light_block_N, deprecated_purpur_block_N, dripstone_block,
// element_0).
//
// For each class the mask and material are the result of its whole class
// chain, base first:
//
//   - the mask: starts at bit 18 alone, a property override replaces it, a
//     property addition ORs into it. NOT ONE of the 22 distinct override masks
//     in the game contains bit 18, and no added mask does either, so in
//     practice a class that overrides the mask loses bit 18 and a class that
//     does not keeps it.
//   - the Material: most classes fix it themselves; the rest take it per block.
//
// Three things the plain class chain does not cover:
//
//   - 52 property changes applied when a block is defined, after its class has
//     set its own -- they are applied last. Eleven are property overrides, and
//     only suspicious_sand/suspicious_gravel keep bit 18 through theirs
//     (mask bits 11+18).
//   - the slab class's mask is CONDITIONAL on whether the slab is double: a
//     single slab adds a property mask of bit 1 while a DOUBLE slab adds bit 18
//     back. Doubleness agrees with "double" appearing in the id for all 138
//     slab ids, with zero disagreements.
//   - 104 ids defined in bulk rather than one by one (wool, concrete, concrete
//     powder, terracotta, glazed terracotta, copper bars, copper chains, copper
//     lanterns), plus the eight lightning rods, whose shared configuration
//     overrides the properties with 0 and so clears bit 18 for all of them.
//
// 1257 of the 1261 vanilla ids are fully determined. The four that are not
// are minecraft:chain, minecraft:shelf_mushroom, minecraft:element_0 and
// minecraft:client_request_placeholder_block; they take the default.
//
// ---- Cross-check ----
//
// Bit 18 is the bit block/support.go uses as the support test's default, so
// the two tables agree wherever nothing else interferes: over all 1257 ids,
// 1199 agree exactly. The 57 that have bit 18 but do not support every face are
// exactly the classes support.go models through a class-specific rule or a
// block support component (leaves, light blocks, chorus, decorated pot,
// farmland, grass path, chains, double slabs) -- the cases support.go's own
// header says do NOT carry over to this bit. The single id that goes the other
// way, minecraft:composter, has its own composter support test, so its mask
// (bit 28, no bit 18) never reaches support.go's answer.
//
// ---- A block a PACK defines, and why minecraft:collision_box is NOT read ----
//
// The default this file falls through to is (motion-blocking, solid-blocking) =
// (true, true). For an id the game does not know, the unknown-block
// placeholder has material 1 and keeps the default mask with bit 18 --
// exactly (true, true).
//
// A block a PACK defines is not unknown to the game: a real block type is
// built out of the JSON, so one declaring its own material or removing its
// collision box could plausibly answer differently. It does not, for three
// reasons that meet:
//
//  1. A JSON block's block type is a plain block type with the default
//     property mask of exactly bit 18.
//
//  2. Bit 18 is never cleared afterwards. The only property changes on the
//     data-driven path are two property additions -- bits 35 and 36 -- and
//     additions only OR. Nothing on the data-driven path overrides the block
//     properties at all; only vanilla block classes and vanilla block
//     definitions do.
//
//  3. A JSON block's material is not something a pack can set. It defaults to
//     1 and no JSON key reaches it. It is changed only when a pack redefines an
//     existing vanilla block, in which case the vanilla block's material is
//     kept.
//
// So every pack block is material 1 with bit 18: motion-blocking and
// solid-blocking, which is what this file already answered.
//
// minecraft:collision_box is therefore deliberately NOT consulted, and reading
// it would make this port disagree with the game. It is a per-Block
// component: it stores collision AABBs on the block and changes neither the
// block type's property mask nor its material. That is also the structurally
// expected answer: collision_box can be overridden per permutation, and these
// two predicates read the block TYPE, which every permutation shares.
// minecraft:selection_box is the same shape -- a per-Block component about what
// the player can aim at, not about collision at all. minecraft:light_dampening,
// minecraft:light_emission and material_instances' render_method are not
// collision and are not considered.
//
// Block ARCHETYPES are a non-issue: a behaviour pack cannot declare an
// archetype, so a pack block never takes that path. Archetypes do hand
// construction to a real vanilla class -- there are 27 of them, "bush_block"
// ... "slab_block", "stair_block", "wall_sign_block" -- and they really would
// move the answer: the stair archetype builds a stair block, whose property
// override is 1 -- bit 18 gone; and the slab archetype builds a slab block,
// which overrides with 0 and then applies the conditional add, so a single slab
// loses it. (Not all of them do: the leaves block only ORs bit 5 and the planks
// block touches nothing, so those two KEEP bit 18.)
//
// What closes it is the gate on the JSON. An archetype can only be given under
// "internal_vanilla_data" -> "block_archetype", and "internal_vanilla_data" is
// accepted only from the base-game pack; in any other pack the key is rejected
// as "this member was found in the input, but is not present in the Schema".
// So every archetype is invisible to any pack that is not the base game. (A
// client can also receive archetypes from a server, but that mirrors what the
// server's base-game pack already defined, not pack JSON.)
//
// ---- What is NOT covered ----
//
//   - Legacy aggregate spellings (minecraft:leaves, tallgrass, ...) are
//     resolved by aliases.go before this table is consulted where they are
//     resolved at all; the few extra spellings this file knows about are listed
//     in legacyMotionSpellings and are INFERRED, exactly as the same kind of
//     list in support.go is.

// motionClass is the answer pair for one block type. There is no
// "solid-blocking but not motion-blocking" member because the solid-blocking
// material flag is `byte1 == 0 && blocksMotion != 0`, which cannot hold when
// blocksMotion is 0.
type motionClass uint8

const (
	// motionNone: neither predicate holds -- either property bit 18 was
	// cleared or the material's blocksMotion byte is 0.
	motionNone motionClass = iota
	// motionOnly: the motion-blocking predicate is true and the solid-blocking
	// one is false, i.e. bit 18 survives and the material has blocksMotion != 0 but
	// byte 1 != 0. Leaves, glass, ice, cactus and their families.
	motionOnly
	// motionBoth: both predicates hold. This is the answer for anything not in
	// the table, so it is never stored in it.
	motionBoth
)

// legacyMotionSpellings map ids this tool accepts elsewhere onto the vanilla id
// the game actually defines. INFERRED, in the same sense as support.go's
// legacy-aggregate note: the spellings themselves have no answer of their own,
// they are here so a pack writing the old name is not silently handed the
// default.
var legacyMotionSpellings = map[string]string{
	"minecraft:cobweb":     "minecraft:web",
	"minecraft:lily_pad":   "minecraft:waterlily",
	"minecraft:grass":      "minecraft:grass_block",
	"minecraft:snow_block": "minecraft:snow",
}

// vanillaMotionClasses lists every vanilla id whose answer is not the default
// motionBoth. Rows are grouped by the block class that implements each id, and
// each group's comment carries that class's property mask (as the list of bits
// it sets, so bit 18 is visible directly) and the material type the two
// predicates actually read.
//
// minecraft:air's block properties are 0, so its bit 18 is gone. cave_air and
// void_air are not Bedrock ids at all; kind.go
// accepts them, so they are listed with air (an inference), exactly as support.go
// lists them.
var vanillaMotionClasses = map[string]motionClass{
	// air block -- mask=none
	"minecraft:air": motionNone, "minecraft:cave_air": motionNone,
	"minecraft:void_air": motionNone,

	// ---- motionOnly: blocks motion, but the solid-blocking material flag is false ----
	// beacon block (1) -- mask=bits 18, material=11
	"minecraft:beacon": motionOnly,
	// the base block type (1) -- mask=bits 18, material=11
	"minecraft:sea_lantern": motionOnly,
	// cherry leaves block (1) -- mask=bits 5+18, material=7
	"minecraft:cherry_leaves": motionOnly,
	// frosted ice block (1) -- mask=bits 18, material=13
	"minecraft:frosted_ice": motionOnly,
	// glass block (3) -- mask=bits 18, material=11
	"minecraft:glass": motionOnly, "minecraft:hard_glass": motionOnly, "minecraft:tinted_glass": motionOnly,
	// glowstone block (1) -- mask=bits 18, material=11
	"minecraft:glowstone": motionOnly,
	// ice block (1) -- mask=bits 18, material=13
	"minecraft:ice": motionOnly,
	// leaves block (6) -- mask=bits 5+18, material=7
	"minecraft:acacia_leaves": motionOnly, "minecraft:birch_leaves": motionOnly, "minecraft:dark_oak_leaves": motionOnly,
	"minecraft:jungle_leaves": motionOnly, "minecraft:oak_leaves": motionOnly, "minecraft:spruce_leaves": motionOnly,
	// mangrove leaves block (1) -- mask=bits 5+18, material=7
	"minecraft:mangrove_leaves": motionOnly,
	// seasons agnostic leaves block (6) -- mask=bits 5+18, material=7
	"minecraft:azalea_leaves": motionOnly, "minecraft:azalea_leaves_flowered": motionOnly, "minecraft:orange_poplar_leaves": motionOnly,
	"minecraft:pale_oak_leaves": motionOnly, "minecraft:red_poplar_leaves": motionOnly, "minecraft:yellow_poplar_leaves": motionOnly,
	// stained glass block (32) -- mask=bits 18, material=11
	"minecraft:black_stained_glass": motionOnly, "minecraft:blue_stained_glass": motionOnly, "minecraft:brown_stained_glass": motionOnly,
	"minecraft:cyan_stained_glass": motionOnly, "minecraft:gray_stained_glass": motionOnly, "minecraft:green_stained_glass": motionOnly,
	"minecraft:hard_black_stained_glass": motionOnly, "minecraft:hard_blue_stained_glass": motionOnly,
	"minecraft:hard_brown_stained_glass": motionOnly, "minecraft:hard_cyan_stained_glass": motionOnly,
	"minecraft:hard_gray_stained_glass": motionOnly, "minecraft:hard_green_stained_glass": motionOnly,
	"minecraft:hard_light_blue_stained_glass": motionOnly, "minecraft:hard_light_gray_stained_glass": motionOnly,
	"minecraft:hard_lime_stained_glass": motionOnly, "minecraft:hard_magenta_stained_glass": motionOnly,
	"minecraft:hard_orange_stained_glass": motionOnly, "minecraft:hard_pink_stained_glass": motionOnly,
	"minecraft:hard_purple_stained_glass": motionOnly, "minecraft:hard_red_stained_glass": motionOnly,
	"minecraft:hard_white_stained_glass": motionOnly, "minecraft:hard_yellow_stained_glass": motionOnly,
	"minecraft:light_blue_stained_glass": motionOnly, "minecraft:light_gray_stained_glass": motionOnly,
	"minecraft:lime_stained_glass": motionOnly, "minecraft:magenta_stained_glass": motionOnly, "minecraft:orange_stained_glass": motionOnly,
	"minecraft:pink_stained_glass": motionOnly, "minecraft:purple_stained_glass": motionOnly, "minecraft:red_stained_glass": motionOnly,
	"minecraft:white_stained_glass": motionOnly, "minecraft:yellow_stained_glass": motionOnly,
	// tnt block (2) -- mask=bits 18, material=12
	"minecraft:tnt": motionOnly, "minecraft:underwater_tnt": motionOnly,

	// ---- motionNone: property bit 18 cleared, or the material does not block motion ----
	// activator rail block (1) -- mask=none, material=24
	"minecraft:activator_rail": motionNone,
	// amethyst cluster block (4) -- mask=none, material=23
	"minecraft:amethyst_cluster": motionNone, "minecraft:large_amethyst_bud": motionNone, "minecraft:medium_amethyst_bud": motionNone,
	"minecraft:small_amethyst_bud": motionNone,
	// anvil block (4) -- mask=bits 11, material=3
	"minecraft:anvil": motionNone, "minecraft:chipped_anvil": motionNone, "minecraft:damaged_anvil": motionNone,
	"minecraft:deprecated_anvil": motionNone,
	// azalea block (2) -- mask=none, material=9
	"minecraft:azalea": motionNone, "minecraft:flowering_azalea": motionNone,
	// bamboo sapling block (1) -- mask=none, material=8
	"minecraft:bamboo_sapling": motionNone,
	// bamboo stalk block (1) -- mask=none, material=9
	"minecraft:bamboo": motionNone,
	// banner block (2) -- mask=bits 14, material=2
	"minecraft:standing_banner": motionNone, "minecraft:wall_banner": motionNone,
	// bed block (1) -- mask=none, material=23
	"minecraft:bed": motionNone,
	// beetroot block (1) -- mask=none, material=8
	"minecraft:beetroot": motionNone,
	// bell block (1) -- mask=none, material=3
	"minecraft:bell": motionNone,
	// big dripleaf block (1) -- mask=none, material=8
	"minecraft:big_dripleaf": motionNone,
	// border block (1) -- mask=bits 21, material=23
	"minecraft:border_block": motionNone,
	// brewing stand block (1) -- mask=none, material=3
	"minecraft:brewing_stand": motionNone,
	// bubble column block (1) -- mask=bits 24, material=18
	"minecraft:bubble_column": motionNone,
	// bush block (1) -- mask=none, material=8
	"minecraft:bush": motionNone,
	// button block (13) -- mask=bits 8, material=2
	"minecraft:acacia_button": motionNone, "minecraft:bamboo_button": motionNone, "minecraft:birch_button": motionNone,
	"minecraft:cherry_button": motionNone, "minecraft:crimson_button": motionNone, "minecraft:dark_oak_button": motionNone,
	"minecraft:jungle_button": motionNone, "minecraft:mangrove_button": motionNone, "minecraft:pale_oak_button": motionNone,
	"minecraft:poplar_button": motionNone, "minecraft:spruce_button": motionNone, "minecraft:warped_button": motionNone,
	"minecraft:wooden_button": motionNone,
	// button block (2) -- mask=bits 8, material=23
	"minecraft:polished_blackstone_button": motionNone, "minecraft:stone_button": motionNone,
	// cactus block (1) -- mask=bits 22+27, material=15
	"minecraft:cactus": motionNone,
	// cactus flower block (1) -- mask=none, material=8
	"minecraft:cactus_flower": motionNone,
	// cake block (1) -- mask=none, material=23
	"minecraft:cake": motionNone,
	// calibrated sculk sensor block (1) -- mask=none, material=23
	"minecraft:calibrated_sculk_sensor": motionNone,
	// camera block (1) -- mask=none, material=2
	"minecraft:camera": motionNone,
	// campfire block (2) -- mask=bits 22, material=20
	"minecraft:campfire": motionNone, "minecraft:soul_campfire": motionNone,
	// candle block (17) -- mask=none, material=24
	"minecraft:black_candle": motionNone, "minecraft:blue_candle": motionNone, "minecraft:brown_candle": motionNone,
	"minecraft:candle": motionNone, "minecraft:cyan_candle": motionNone, "minecraft:gray_candle": motionNone,
	"minecraft:green_candle": motionNone, "minecraft:light_blue_candle": motionNone, "minecraft:light_gray_candle": motionNone,
	"minecraft:lime_candle": motionNone, "minecraft:magenta_candle": motionNone, "minecraft:orange_candle": motionNone,
	"minecraft:pink_candle": motionNone, "minecraft:purple_candle": motionNone, "minecraft:red_candle": motionNone,
	"minecraft:white_candle": motionNone, "minecraft:yellow_candle": motionNone,
	// candle cake block (17) -- mask=none, material=23
	"minecraft:black_candle_cake": motionNone, "minecraft:blue_candle_cake": motionNone, "minecraft:brown_candle_cake": motionNone,
	"minecraft:candle_cake": motionNone, "minecraft:cyan_candle_cake": motionNone, "minecraft:gray_candle_cake": motionNone,
	"minecraft:green_candle_cake": motionNone, "minecraft:light_blue_candle_cake": motionNone, "minecraft:light_gray_candle_cake": motionNone,
	"minecraft:lime_candle_cake": motionNone, "minecraft:magenta_candle_cake": motionNone, "minecraft:orange_candle_cake": motionNone,
	"minecraft:pink_candle_cake": motionNone, "minecraft:purple_candle_cake": motionNone, "minecraft:red_candle_cake": motionNone,
	"minecraft:white_candle_cake": motionNone, "minecraft:yellow_candle_cake": motionNone,
	// carpet block (1) -- mask=bits 7+15, material=8
	"minecraft:moss_carpet": motionNone,
	// carpet block (16) -- mask=bits 7+15+35, material=24
	"minecraft:black_carpet": motionNone, "minecraft:blue_carpet": motionNone, "minecraft:brown_carpet": motionNone,
	"minecraft:cyan_carpet": motionNone, "minecraft:gray_carpet": motionNone, "minecraft:green_carpet": motionNone,
	"minecraft:light_blue_carpet": motionNone, "minecraft:light_gray_carpet": motionNone, "minecraft:lime_carpet": motionNone,
	"minecraft:magenta_carpet": motionNone, "minecraft:orange_carpet": motionNone, "minecraft:pink_carpet": motionNone,
	"minecraft:purple_carpet": motionNone, "minecraft:red_carpet": motionNone, "minecraft:white_carpet": motionNone,
	"minecraft:yellow_carpet": motionNone,
	// carrot block (1) -- mask=none, material=8
	"minecraft:carrots": motionNone,
	// cauldron block (1) -- mask=bits 28, material=3
	"minecraft:cauldron": motionNone,
	// cave vines block (3) -- mask=none, material=8
	"minecraft:cave_vines": motionNone, "minecraft:cave_vines_body_with_berries": motionNone, "minecraft:cave_vines_head_with_berries": motionNone,
	// chalkboard block (1) -- mask=bits 21, material=2
	"minecraft:chalkboard": motionNone,
	// chest block (2) -- mask=bits 15, material=n/a
	"minecraft:chest": motionNone, "minecraft:trapped_chest": motionNone,
	// cocoa block (1) -- mask=none, material=8
	"minecraft:cocoa": motionNone,
	// colored torch block (4) -- mask=none, material=24
	"minecraft:colored_torch_blue": motionNone, "minecraft:colored_torch_green": motionNone, "minecraft:colored_torch_purple": motionNone,
	"minecraft:colored_torch_red": motionNone,
	// comparator block (2) -- mask=none, material=24
	"minecraft:powered_comparator": motionNone, "minecraft:unpowered_comparator": motionNone,
	// composter block (1) -- mask=bits 28, material=2
	"minecraft:composter": motionNone,
	// conduit block (1) -- mask=none, material=17
	"minecraft:conduit": motionNone,
	// copper lantern block (8) -- mask=none, material=3
	"minecraft:copper_lantern": motionNone, "minecraft:exposed_copper_lantern": motionNone, "minecraft:oxidized_copper_lantern": motionNone,
	"minecraft:waxed_copper_lantern": motionNone, "minecraft:waxed_exposed_copper_lantern": motionNone,
	"minecraft:waxed_oxidized_copper_lantern": motionNone, "minecraft:waxed_weathered_copper_lantern": motionNone,
	"minecraft:weathered_copper_lantern": motionNone,
	// copper slab block (8) -- mask=bits 1, material=3
	"minecraft:cut_copper_slab": motionNone, "minecraft:exposed_cut_copper_slab": motionNone, "minecraft:oxidized_cut_copper_slab": motionNone,
	"minecraft:waxed_cut_copper_slab": motionNone, "minecraft:waxed_exposed_cut_copper_slab": motionNone,
	"minecraft:waxed_oxidized_cut_copper_slab": motionNone, "minecraft:waxed_weathered_cut_copper_slab": motionNone,
	"minecraft:weathered_cut_copper_slab": motionNone,
	// copper stair block (8) -- mask=bits 0, material=n/a
	"minecraft:cut_copper_stairs": motionNone, "minecraft:exposed_cut_copper_stairs": motionNone,
	"minecraft:oxidized_cut_copper_stairs": motionNone, "minecraft:waxed_cut_copper_stairs": motionNone,
	"minecraft:waxed_exposed_cut_copper_stairs": motionNone, "minecraft:waxed_oxidized_cut_copper_stairs": motionNone,
	"minecraft:waxed_weathered_cut_copper_stairs": motionNone, "minecraft:weathered_cut_copper_stairs": motionNone,
	// copper thin fence block (8) -- mask=none, material=3
	"minecraft:copper_bars": motionNone, "minecraft:exposed_copper_bars": motionNone, "minecraft:oxidized_copper_bars": motionNone,
	"minecraft:waxed_copper_bars": motionNone, "minecraft:waxed_exposed_copper_bars": motionNone,
	"minecraft:waxed_oxidized_copper_bars": motionNone, "minecraft:waxed_weathered_copper_bars": motionNone,
	"minecraft:weathered_copper_bars": motionNone,
	// copper chest block (8) -- mask=bits 15, material=n/a
	"minecraft:copper_chest": motionNone, "minecraft:exposed_copper_chest": motionNone, "minecraft:oxidized_copper_chest": motionNone,
	"minecraft:waxed_copper_chest": motionNone, "minecraft:waxed_exposed_copper_chest": motionNone,
	"minecraft:waxed_oxidized_copper_chest": motionNone, "minecraft:waxed_weathered_copper_chest": motionNone,
	"minecraft:weathered_copper_chest": motionNone,
	// copper door block (8) -- mask=bits 9, material=3
	"minecraft:copper_door": motionNone, "minecraft:exposed_copper_door": motionNone, "minecraft:oxidized_copper_door": motionNone,
	"minecraft:waxed_copper_door": motionNone, "minecraft:waxed_exposed_copper_door": motionNone,
	"minecraft:waxed_oxidized_copper_door": motionNone, "minecraft:waxed_weathered_copper_door": motionNone,
	"minecraft:weathered_copper_door": motionNone,
	// copper golem statue block (8) -- mask=none, material=3
	"minecraft:copper_golem_statue": motionNone, "minecraft:exposed_copper_golem_statue": motionNone,
	"minecraft:oxidized_copper_golem_statue": motionNone, "minecraft:waxed_copper_golem_statue": motionNone,
	"minecraft:waxed_exposed_copper_golem_statue": motionNone, "minecraft:waxed_oxidized_copper_golem_statue": motionNone,
	"minecraft:waxed_weathered_copper_golem_statue": motionNone, "minecraft:weathered_copper_golem_statue": motionNone,
	// copper trap door block (8) -- mask=bits 13, material=3
	"minecraft:copper_trapdoor": motionNone, "minecraft:exposed_copper_trapdoor": motionNone, "minecraft:oxidized_copper_trapdoor": motionNone,
	"minecraft:waxed_copper_trapdoor": motionNone, "minecraft:waxed_exposed_copper_trapdoor": motionNone,
	"minecraft:waxed_oxidized_copper_trapdoor": motionNone, "minecraft:waxed_weathered_copper_trapdoor": motionNone,
	"minecraft:weathered_copper_trapdoor": motionNone,
	// coral fan (10) -- mask=none, material=23
	"minecraft:brain_coral_fan": motionNone, "minecraft:bubble_coral_fan": motionNone, "minecraft:dead_brain_coral_fan": motionNone,
	"minecraft:dead_bubble_coral_fan": motionNone, "minecraft:dead_fire_coral_fan": motionNone, "minecraft:dead_horn_coral_fan": motionNone,
	"minecraft:dead_tube_coral_fan": motionNone, "minecraft:fire_coral_fan": motionNone, "minecraft:horn_coral_fan": motionNone,
	"minecraft:tube_coral_fan": motionNone,
	// hanging coral fan (10) -- mask=none, material=23
	"minecraft:brain_coral_wall_fan": motionNone, "minecraft:bubble_coral_wall_fan": motionNone, "minecraft:dead_brain_coral_wall_fan": motionNone,
	"minecraft:dead_bubble_coral_wall_fan": motionNone, "minecraft:dead_fire_coral_wall_fan": motionNone,
	"minecraft:dead_horn_coral_wall_fan": motionNone, "minecraft:dead_tube_coral_wall_fan": motionNone,
	"minecraft:fire_coral_wall_fan": motionNone, "minecraft:horn_coral_wall_fan": motionNone, "minecraft:tube_coral_wall_fan": motionNone,
	// coral plant block (10) -- mask=none, material=23
	"minecraft:brain_coral": motionNone, "minecraft:bubble_coral": motionNone, "minecraft:dead_brain_coral": motionNone,
	"minecraft:dead_bubble_coral": motionNone, "minecraft:dead_fire_coral": motionNone, "minecraft:dead_horn_coral": motionNone,
	"minecraft:dead_tube_coral": motionNone, "minecraft:fire_coral": motionNone, "minecraft:horn_coral": motionNone,
	"minecraft:tube_coral": motionNone,
	// crop block (1) -- mask=none, material=8
	"minecraft:wheat": motionNone,
	// daylight detector block (2) -- mask=none, material=2
	"minecraft:daylight_detector": motionNone, "minecraft:daylight_detector_inverted": motionNone,
	// dead bush block (1) -- mask=none, material=8
	"minecraft:deadbush": motionNone,
	// decorated pot block (1) -- mask=bits 18, material=20
	"minecraft:decorated_pot": motionNone,
	// detector rail block (1) -- mask=none, material=24
	"minecraft:detector_rail": motionNone,
	// door block (13) -- mask=bits 9, material=2
	"minecraft:acacia_door": motionNone, "minecraft:bamboo_door": motionNone, "minecraft:birch_door": motionNone,
	"minecraft:cherry_door": motionNone, "minecraft:crimson_door": motionNone, "minecraft:dark_oak_door": motionNone,
	"minecraft:jungle_door": motionNone, "minecraft:mangrove_door": motionNone, "minecraft:pale_oak_door": motionNone,
	"minecraft:poplar_door": motionNone, "minecraft:spruce_door": motionNone, "minecraft:warped_door": motionNone,
	"minecraft:wooden_door": motionNone,
	// door block (1) -- mask=bits 9, material=3
	"minecraft:iron_door": motionNone,
	// double plant block (4) -- mask=none, material=8
	"minecraft:lilac": motionNone, "minecraft:peony": motionNone, "minecraft:rose_bush": motionNone,
	"minecraft:sunflower": motionNone,
	// double vegetation block (2) -- mask=none, material=8
	"minecraft:large_fern": motionNone, "minecraft:tall_grass": motionNone,
	// dragon egg block (1) -- mask=none, material=23
	"minecraft:dragon_egg": motionNone,
	// dried ghast block (1) -- mask=none, material=23
	"minecraft:dried_ghast": motionNone,
	// enchanting table block (1) -- mask=none, material=23
	"minecraft:enchanting_table": motionNone,
	// end gateway block (1) -- mask=bits 10, material=16
	"minecraft:end_gateway": motionNone,
	// end portal block (1) -- mask=bits 10, material=16
	"minecraft:end_portal": motionNone,
	// end portal frame block (1) -- mask=none, material=23
	"minecraft:end_portal_frame": motionNone,
	// end rod block (1) -- mask=bits 19, material=24
	"minecraft:end_rod": motionNone,
	// ender chest block (1) -- mask=none, material=23
	"minecraft:ender_chest": motionNone,
	// eyeblossom block (2) -- mask=none, material=8
	"minecraft:closed_eyeblossom": motionNone, "minecraft:open_eyeblossom": motionNone,
	// fence block (13) -- mask=bits 6+26, material=2
	"minecraft:acacia_fence": motionNone, "minecraft:bamboo_fence": motionNone, "minecraft:birch_fence": motionNone,
	"minecraft:cherry_fence": motionNone, "minecraft:crimson_fence": motionNone, "minecraft:dark_oak_fence": motionNone,
	"minecraft:jungle_fence": motionNone, "minecraft:mangrove_fence": motionNone, "minecraft:oak_fence": motionNone,
	"minecraft:pale_oak_fence": motionNone, "minecraft:poplar_fence": motionNone, "minecraft:spruce_fence": motionNone,
	"minecraft:warped_fence": motionNone,
	// fence block (1) -- mask=bits 6+26, material=23
	"minecraft:nether_brick_fence": motionNone,
	// fence gate block (13) -- mask=bits 4, material=2
	"minecraft:acacia_fence_gate": motionNone, "minecraft:bamboo_fence_gate": motionNone, "minecraft:birch_fence_gate": motionNone,
	"minecraft:cherry_fence_gate": motionNone, "minecraft:crimson_fence_gate": motionNone, "minecraft:dark_oak_fence_gate": motionNone,
	"minecraft:fence_gate": motionNone, "minecraft:jungle_fence_gate": motionNone, "minecraft:mangrove_fence_gate": motionNone,
	"minecraft:pale_oak_fence_gate": motionNone, "minecraft:poplar_fence_gate": motionNone, "minecraft:spruce_fence_gate": motionNone,
	"minecraft:warped_fence_gate": motionNone,
	// fire block (1) -- mask=bits 22, material=10
	"minecraft:fire": motionNone,
	// firefly bush block (1) -- mask=none, material=8
	"minecraft:firefly_bush": motionNone,
	// flower bed block (2) -- mask=none, material=8
	"minecraft:pink_petals": motionNone, "minecraft:wildflowers": motionNone,
	// flower block (14) -- mask=none, material=8
	"minecraft:allium": motionNone, "minecraft:azure_bluet": motionNone, "minecraft:blue_orchid": motionNone,
	"minecraft:cornflower": motionNone, "minecraft:crimson_roots": motionNone, "minecraft:dandelion": motionNone,
	"minecraft:lily_of_the_valley": motionNone, "minecraft:orange_tulip": motionNone, "minecraft:oxeye_daisy": motionNone,
	"minecraft:pink_tulip": motionNone, "minecraft:poppy": motionNone, "minecraft:red_tulip": motionNone,
	"minecraft:warped_roots": motionNone, "minecraft:white_tulip": motionNone,
	// flower pot block (1) -- mask=none, material=24
	"minecraft:flower_pot": motionNone,
	// frog spawn block (1) -- mask=none, material=24
	"minecraft:frog_spawn": motionNone,
	// glow item frame block (1) -- mask=none, material=24
	"minecraft:glow_frame": motionNone,
	// glow lichen block (1) -- mask=none, material=8
	"minecraft:glow_lichen": motionNone,
	// golden dandelion (1) -- mask=none, material=8
	"minecraft:golden_dandelion": motionNone,
	// grindstone block (1) -- mask=none, material=23
	"minecraft:grindstone": motionNone,
	// hanging roots block (1) -- mask=none, material=8
	"minecraft:hanging_roots": motionNone,
	// hanging sign block (13) -- mask=bits 14, material=2
	"minecraft:acacia_hanging_sign": motionNone, "minecraft:bamboo_hanging_sign": motionNone, "minecraft:birch_hanging_sign": motionNone,
	"minecraft:cherry_hanging_sign": motionNone, "minecraft:crimson_hanging_sign": motionNone, "minecraft:dark_oak_hanging_sign": motionNone,
	"minecraft:jungle_hanging_sign": motionNone, "minecraft:mangrove_hanging_sign": motionNone, "minecraft:oak_hanging_sign": motionNone,
	"minecraft:pale_oak_hanging_sign": motionNone, "minecraft:poplar_hanging_sign": motionNone, "minecraft:spruce_hanging_sign": motionNone,
	"minecraft:warped_hanging_sign": motionNone,
	// heavy core block (1) -- mask=none, material=23
	"minecraft:heavy_core": motionNone,
	// hopper block (1) -- mask=bits 2+17, material=3
	"minecraft:hopper": motionNone,
	// item frame block (1) -- mask=none, material=24
	"minecraft:frame": motionNone,
	// jigsaw block (1) -- mask=none, material=3
	"minecraft:jigsaw": motionNone,
	// kelp block (1) -- mask=none, material=8
	"minecraft:kelp": motionNone,
	// ladder block (1) -- mask=none, material=24
	"minecraft:ladder": motionNone,
	// lantern block (2) -- mask=none, material=3
	"minecraft:lantern": motionNone, "minecraft:soul_lantern": motionNone,
	// leaf litter block (1) -- mask=none, material=8
	"minecraft:leaf_litter": motionNone,
	// lectern block (1) -- mask=none, material=2
	"minecraft:lectern": motionNone,
	// lever block (1) -- mask=none, material=24
	"minecraft:lever": motionNone,
	// light block (16) -- mask=bits 18, material=0
	"minecraft:light_block_0": motionNone, "minecraft:light_block_1": motionNone, "minecraft:light_block_10": motionNone,
	"minecraft:light_block_11": motionNone, "minecraft:light_block_12": motionNone, "minecraft:light_block_13": motionNone,
	"minecraft:light_block_14": motionNone, "minecraft:light_block_15": motionNone, "minecraft:light_block_2": motionNone,
	"minecraft:light_block_3": motionNone, "minecraft:light_block_4": motionNone, "minecraft:light_block_5": motionNone,
	"minecraft:light_block_6": motionNone, "minecraft:light_block_7": motionNone, "minecraft:light_block_8": motionNone,
	"minecraft:light_block_9": motionNone,
	// lightning rod, shared configuration (8) -- mask=none, material=3
	"minecraft:exposed_lightning_rod": motionNone, "minecraft:lightning_rod": motionNone, "minecraft:oxidized_lightning_rod": motionNone,
	"minecraft:waxed_exposed_lightning_rod": motionNone, "minecraft:waxed_lightning_rod": motionNone,
	"minecraft:waxed_oxidized_lightning_rod": motionNone, "minecraft:waxed_weathered_lightning_rod": motionNone,
	"minecraft:weathered_lightning_rod": motionNone,
	// liquid block (1) -- mask=bits 24, material=5
	"minecraft:water": motionNone,
	// liquid block (1) -- mask=bits 24, material=6
	"minecraft:lava": motionNone,
	// dynamic liquid block (1) -- mask=bits 24, material=5
	"minecraft:flowing_water": motionNone,
	// dynamic liquid block (1) -- mask=bits 24, material=6
	"minecraft:flowing_lava": motionNone,
	// mangrove propagule block (1) -- mask=none, material=8
	"minecraft:mangrove_propagule": motionNone,
	// moving block (1) -- mask=none, material=23
	"minecraft:moving_block": motionNone,
	// multiface block (1) -- mask=none, material=24
	"minecraft:resin_clump": motionNone,
	// mushroom block (2) -- mask=none, material=8
	"minecraft:brown_mushroom": motionNone, "minecraft:red_mushroom": motionNone,
	// nether fungus block (2) -- mask=bits 18, material=8
	"minecraft:crimson_fungus": motionNone, "minecraft:warped_fungus": motionNone,
	// nether sprouts block (1) -- mask=none, material=8
	"minecraft:nether_sprouts": motionNone,
	// nether wart block (1) -- mask=none, material=8
	"minecraft:nether_wart": motionNone,
	// pale hanging moss block (1) -- mask=none, material=8
	"minecraft:pale_hanging_moss": motionNone,
	// pale moss carpet block (1) -- mask=bits 7+15, material=8
	"minecraft:pale_moss_carpet": motionNone,
	// piston arm block (2) -- mask=none, material=23
	"minecraft:piston_arm_collision": motionNone, "minecraft:sticky_piston_arm_collision": motionNone,
	// pitcher crop block (1) -- mask=none, material=8
	"minecraft:pitcher_crop": motionNone,
	// pitcher plant block (1) -- mask=none, material=8
	"minecraft:pitcher_plant": motionNone,
	// pointed dripstone block (1) -- mask=bits 11, material=23
	"minecraft:pointed_dripstone": motionNone,
	// portal block (1) -- mask=bits 10, material=16
	"minecraft:portal": motionNone,
	// potato block (1) -- mask=none, material=8
	"minecraft:potatoes": motionNone,
	// powder snow block (1) -- mask=none, material=14
	"minecraft:powder_snow": motionNone,
	// powered rail block (1) -- mask=none, material=24
	"minecraft:golden_rail": motionNone,
	// pressure plate block (13) -- mask=bits 16, material=2
	"minecraft:acacia_pressure_plate": motionNone, "minecraft:bamboo_pressure_plate": motionNone,
	"minecraft:birch_pressure_plate": motionNone, "minecraft:cherry_pressure_plate": motionNone, "minecraft:crimson_pressure_plate": motionNone,
	"minecraft:dark_oak_pressure_plate": motionNone, "minecraft:jungle_pressure_plate": motionNone,
	"minecraft:mangrove_pressure_plate": motionNone, "minecraft:pale_oak_pressure_plate": motionNone,
	"minecraft:poplar_pressure_plate": motionNone, "minecraft:spruce_pressure_plate": motionNone,
	"minecraft:warped_pressure_plate": motionNone, "minecraft:wooden_pressure_plate": motionNone,
	// pressure plate block (2) -- mask=bits 16, material=23
	"minecraft:polished_blackstone_pressure_plate": motionNone, "minecraft:stone_pressure_plate": motionNone,
	// rail block (1) -- mask=none, material=24
	"minecraft:rail": motionNone,
	// redstone wire block (1) -- mask=none, material=24
	"minecraft:redstone_wire": motionNone,
	// redstone torch block (2) -- mask=none, material=24
	"minecraft:redstone_torch": motionNone, "minecraft:unlit_redstone_torch": motionNone,
	// repeater block (2) -- mask=none, material=24
	"minecraft:powered_repeater": motionNone, "minecraft:unpowered_repeater": motionNone,
	// sapling block (9) -- mask=none, material=8
	"minecraft:acacia_sapling": motionNone, "minecraft:birch_sapling": motionNone, "minecraft:cherry_sapling": motionNone,
	"minecraft:dark_oak_sapling": motionNone, "minecraft:jungle_sapling": motionNone, "minecraft:oak_sapling": motionNone,
	"minecraft:pale_oak_sapling": motionNone, "minecraft:poplar_sapling": motionNone, "minecraft:spruce_sapling": motionNone,
	// scaffolding block (1) -- mask=bits 17+25, material=24
	"minecraft:scaffolding": motionNone,
	// sculk sensor block (1) -- mask=none, material=23
	"minecraft:sculk_sensor": motionNone,
	// sculk shrieker block (1) -- mask=none, material=23
	"minecraft:sculk_shrieker": motionNone,
	// sculk vein block (1) -- mask=none, material=24
	"minecraft:sculk_vein": motionNone,
	// sea pickle block (1) -- mask=none, material=8
	"minecraft:sea_pickle": motionNone,
	// seagrass block (1) -- mask=none, material=8
	"minecraft:seagrass": motionNone,
	// shelf block (13) -- mask=none, material=2
	"minecraft:acacia_shelf": motionNone, "minecraft:bamboo_shelf": motionNone, "minecraft:birch_shelf": motionNone,
	"minecraft:cherry_shelf": motionNone, "minecraft:crimson_shelf": motionNone, "minecraft:dark_oak_shelf": motionNone,
	"minecraft:jungle_shelf": motionNone, "minecraft:mangrove_shelf": motionNone, "minecraft:oak_shelf": motionNone,
	"minecraft:pale_oak_shelf": motionNone, "minecraft:poplar_shelf": motionNone, "minecraft:spruce_shelf": motionNone,
	"minecraft:warped_shelf": motionNone,
	// short dry grass block (1) -- mask=none, material=8
	"minecraft:short_dry_grass": motionNone,
	// shulker box block (17) -- mask=bits 15, material=23
	"minecraft:black_shulker_box": motionNone, "minecraft:blue_shulker_box": motionNone, "minecraft:brown_shulker_box": motionNone,
	"minecraft:cyan_shulker_box": motionNone, "minecraft:gray_shulker_box": motionNone, "minecraft:green_shulker_box": motionNone,
	"minecraft:light_blue_shulker_box": motionNone, "minecraft:light_gray_shulker_box": motionNone,
	"minecraft:lime_shulker_box": motionNone, "minecraft:magenta_shulker_box": motionNone, "minecraft:orange_shulker_box": motionNone,
	"minecraft:pink_shulker_box": motionNone, "minecraft:purple_shulker_box": motionNone, "minecraft:red_shulker_box": motionNone,
	"minecraft:undyed_shulker_box": motionNone, "minecraft:white_shulker_box": motionNone, "minecraft:yellow_shulker_box": motionNone,
	// sign block (26) -- mask=bits 14, material=2
	"minecraft:acacia_standing_sign": motionNone, "minecraft:acacia_wall_sign": motionNone, "minecraft:bamboo_standing_sign": motionNone,
	"minecraft:bamboo_wall_sign": motionNone, "minecraft:birch_standing_sign": motionNone, "minecraft:birch_wall_sign": motionNone,
	"minecraft:cherry_standing_sign": motionNone, "minecraft:cherry_wall_sign": motionNone, "minecraft:crimson_standing_sign": motionNone,
	"minecraft:crimson_wall_sign": motionNone, "minecraft:darkoak_standing_sign": motionNone, "minecraft:darkoak_wall_sign": motionNone,
	"minecraft:jungle_standing_sign": motionNone, "minecraft:jungle_wall_sign": motionNone, "minecraft:mangrove_standing_sign": motionNone,
	"minecraft:mangrove_wall_sign": motionNone, "minecraft:pale_oak_standing_sign": motionNone, "minecraft:pale_oak_wall_sign": motionNone,
	"minecraft:poplar_standing_sign": motionNone, "minecraft:poplar_wall_sign": motionNone, "minecraft:spruce_standing_sign": motionNone,
	"minecraft:spruce_wall_sign": motionNone, "minecraft:standing_sign": motionNone, "minecraft:wall_sign": motionNone,
	"minecraft:warped_standing_sign": motionNone, "minecraft:warped_wall_sign": motionNone,
	// skull block (7) -- mask=none, material=24
	"minecraft:creeper_head": motionNone, "minecraft:dragon_head": motionNone, "minecraft:piglin_head": motionNone,
	"minecraft:player_head": motionNone, "minecraft:skeleton_skull": motionNone, "minecraft:wither_skeleton_skull": motionNone,
	"minecraft:zombie_head": motionNone,
	// slab block (14) -- mask=bits 1, material=2
	"minecraft:acacia_slab": motionNone, "minecraft:bamboo_mosaic_slab": motionNone, "minecraft:bamboo_slab": motionNone,
	"minecraft:birch_slab": motionNone, "minecraft:cherry_slab": motionNone, "minecraft:crimson_slab": motionNone,
	"minecraft:dark_oak_slab": motionNone, "minecraft:jungle_slab": motionNone, "minecraft:mangrove_slab": motionNone,
	"minecraft:oak_slab": motionNone, "minecraft:pale_oak_slab": motionNone, "minecraft:poplar_slab": motionNone,
	"minecraft:spruce_slab": motionNone, "minecraft:warped_slab": motionNone,
	// slab block (47) -- mask=bits 1, material=23
	"minecraft:andesite_slab": motionNone, "minecraft:blackstone_slab": motionNone, "minecraft:brick_slab": motionNone,
	"minecraft:cinnabar_brick_slab": motionNone, "minecraft:cinnabar_slab": motionNone, "minecraft:cobbled_deepslate_slab": motionNone,
	"minecraft:cobblestone_slab": motionNone, "minecraft:cut_red_sandstone_slab": motionNone, "minecraft:cut_sandstone_slab": motionNone,
	"minecraft:dark_prismarine_slab": motionNone, "minecraft:deepslate_brick_slab": motionNone, "minecraft:deepslate_tile_slab": motionNone,
	"minecraft:diorite_slab": motionNone, "minecraft:end_stone_brick_slab": motionNone, "minecraft:granite_slab": motionNone,
	"minecraft:mossy_cobblestone_slab": motionNone, "minecraft:mossy_stone_brick_slab": motionNone,
	"minecraft:mud_brick_slab": motionNone, "minecraft:nether_brick_slab": motionNone, "minecraft:normal_stone_slab": motionNone,
	"minecraft:petrified_oak_slab": motionNone, "minecraft:polished_andesite_slab": motionNone, "minecraft:polished_blackstone_brick_slab": motionNone,
	"minecraft:polished_blackstone_slab": motionNone, "minecraft:polished_cinnabar_slab": motionNone,
	"minecraft:polished_deepslate_slab": motionNone, "minecraft:polished_diorite_slab": motionNone,
	"minecraft:polished_granite_slab": motionNone, "minecraft:polished_sulfur_slab": motionNone, "minecraft:polished_tuff_slab": motionNone,
	"minecraft:prismarine_brick_slab": motionNone, "minecraft:prismarine_slab": motionNone, "minecraft:purpur_slab": motionNone,
	"minecraft:quartz_slab": motionNone, "minecraft:red_nether_brick_slab": motionNone, "minecraft:red_sandstone_slab": motionNone,
	"minecraft:resin_brick_slab": motionNone, "minecraft:sandstone_slab": motionNone, "minecraft:smooth_quartz_slab": motionNone,
	"minecraft:smooth_red_sandstone_slab": motionNone, "minecraft:smooth_sandstone_slab": motionNone,
	"minecraft:smooth_stone_slab": motionNone, "minecraft:stone_brick_slab": motionNone, "minecraft:sulfur_brick_slab": motionNone,
	"minecraft:sulfur_slab": motionNone, "minecraft:tuff_brick_slab": motionNone, "minecraft:tuff_slab": motionNone,
	// small dripleaf block (1) -- mask=none, material=8
	"minecraft:small_dripleaf_block": motionNone,
	// soul fire block (1) -- mask=bits 22, material=10
	"minecraft:soul_fire": motionNone,
	// soul torch block (1) -- mask=none, material=24
	"minecraft:soul_torch": motionNone,
	// spore blossom block (1) -- mask=none, material=8
	"minecraft:spore_blossom": motionNone,
	// stair block (57) -- mask=bits 0, material=n/a
	"minecraft:acacia_stairs": motionNone, "minecraft:andesite_stairs": motionNone, "minecraft:bamboo_mosaic_stairs": motionNone,
	"minecraft:bamboo_stairs": motionNone, "minecraft:birch_stairs": motionNone, "minecraft:blackstone_stairs": motionNone,
	"minecraft:brick_stairs": motionNone, "minecraft:cherry_stairs": motionNone, "minecraft:cinnabar_brick_stairs": motionNone,
	"minecraft:cinnabar_stairs": motionNone, "minecraft:cobbled_deepslate_stairs": motionNone, "minecraft:crimson_stairs": motionNone,
	"minecraft:dark_oak_stairs": motionNone, "minecraft:dark_prismarine_stairs": motionNone, "minecraft:deepslate_brick_stairs": motionNone,
	"minecraft:deepslate_tile_stairs": motionNone, "minecraft:diorite_stairs": motionNone, "minecraft:end_brick_stairs": motionNone,
	"minecraft:granite_stairs": motionNone, "minecraft:jungle_stairs": motionNone, "minecraft:mangrove_stairs": motionNone,
	"minecraft:mossy_cobblestone_stairs": motionNone, "minecraft:mossy_stone_brick_stairs": motionNone,
	"minecraft:mud_brick_stairs": motionNone, "minecraft:nether_brick_stairs": motionNone, "minecraft:normal_stone_stairs": motionNone,
	"minecraft:oak_stairs": motionNone, "minecraft:pale_oak_stairs": motionNone, "minecraft:polished_andesite_stairs": motionNone,
	"minecraft:polished_blackstone_brick_stairs": motionNone, "minecraft:polished_blackstone_stairs": motionNone,
	"minecraft:polished_cinnabar_stairs": motionNone, "minecraft:polished_deepslate_stairs": motionNone,
	"minecraft:polished_diorite_stairs": motionNone, "minecraft:polished_granite_stairs": motionNone,
	"minecraft:polished_sulfur_stairs": motionNone, "minecraft:polished_tuff_stairs": motionNone,
	"minecraft:poplar_stairs": motionNone, "minecraft:prismarine_bricks_stairs": motionNone, "minecraft:prismarine_stairs": motionNone,
	"minecraft:purpur_stairs": motionNone, "minecraft:quartz_stairs": motionNone, "minecraft:red_nether_brick_stairs": motionNone,
	"minecraft:red_sandstone_stairs": motionNone, "minecraft:resin_brick_stairs": motionNone, "minecraft:sandstone_stairs": motionNone,
	"minecraft:smooth_quartz_stairs": motionNone, "minecraft:smooth_red_sandstone_stairs": motionNone,
	"minecraft:smooth_sandstone_stairs": motionNone, "minecraft:spruce_stairs": motionNone, "minecraft:stone_brick_stairs": motionNone,
	"minecraft:stone_stairs": motionNone, "minecraft:sulfur_brick_stairs": motionNone, "minecraft:sulfur_stairs": motionNone,
	"minecraft:tuff_brick_stairs": motionNone, "minecraft:tuff_stairs": motionNone, "minecraft:warped_stairs": motionNone,
	// stem block (2) -- mask=none, material=8
	"minecraft:melon_stem": motionNone, "minecraft:pumpkin_stem": motionNone,
	// stonecutter block (1) -- mask=none, material=23
	"minecraft:stonecutter_block": motionNone,
	// straw bed (1) -- mask=none, material=1
	"minecraft:straw_bed": motionNone,
	// structure block (1) -- mask=bits 17+29, material=3
	"minecraft:structure_block": motionNone,
	// structure void block (1) -- mask=bits 18, material=22
	"minecraft:structure_void": motionNone,
	// sugar cane block (1) -- mask=none, material=8
	"minecraft:reeds": motionNone,
	// sulfur spike block (1) -- mask=bits 11, material=23
	"minecraft:sulfur_spike": motionNone,
	// sweet berry bush block (1) -- mask=bits 22+27, material=8
	"minecraft:sweet_berry_bush": motionNone,
	// tall dry grass block (1) -- mask=none, material=8
	"minecraft:tall_dry_grass": motionNone,
	// tall grass block (2) -- mask=none, material=8
	"minecraft:fern": motionNone, "minecraft:short_grass": motionNone,
	// thin fence block (34) -- mask=none, material=11
	"minecraft:black_stained_glass_pane": motionNone, "minecraft:blue_stained_glass_pane": motionNone,
	"minecraft:brown_stained_glass_pane": motionNone, "minecraft:cyan_stained_glass_pane": motionNone,
	"minecraft:glass_pane": motionNone, "minecraft:gray_stained_glass_pane": motionNone, "minecraft:green_stained_glass_pane": motionNone,
	"minecraft:hard_black_stained_glass_pane": motionNone, "minecraft:hard_blue_stained_glass_pane": motionNone,
	"minecraft:hard_brown_stained_glass_pane": motionNone, "minecraft:hard_cyan_stained_glass_pane": motionNone,
	"minecraft:hard_glass_pane": motionNone, "minecraft:hard_gray_stained_glass_pane": motionNone,
	"minecraft:hard_green_stained_glass_pane": motionNone, "minecraft:hard_light_blue_stained_glass_pane": motionNone,
	"minecraft:hard_light_gray_stained_glass_pane": motionNone, "minecraft:hard_lime_stained_glass_pane": motionNone,
	"minecraft:hard_magenta_stained_glass_pane": motionNone, "minecraft:hard_orange_stained_glass_pane": motionNone,
	"minecraft:hard_pink_stained_glass_pane": motionNone, "minecraft:hard_purple_stained_glass_pane": motionNone,
	"minecraft:hard_red_stained_glass_pane": motionNone, "minecraft:hard_white_stained_glass_pane": motionNone,
	"minecraft:hard_yellow_stained_glass_pane": motionNone, "minecraft:light_blue_stained_glass_pane": motionNone,
	"minecraft:light_gray_stained_glass_pane": motionNone, "minecraft:lime_stained_glass_pane": motionNone,
	"minecraft:magenta_stained_glass_pane": motionNone, "minecraft:orange_stained_glass_pane": motionNone,
	"minecraft:pink_stained_glass_pane": motionNone, "minecraft:purple_stained_glass_pane": motionNone,
	"minecraft:red_stained_glass_pane": motionNone, "minecraft:white_stained_glass_pane": motionNone,
	"minecraft:yellow_stained_glass_pane": motionNone,
	// thin fence block (1) -- mask=bits 26, material=3
	"minecraft:iron_bars": motionNone,
	// top snow block (1) -- mask=bits 3+11, material=24
	"minecraft:snow_layer": motionNone,
	// torch block (2) -- mask=none, material=24
	"minecraft:copper_torch": motionNone, "minecraft:torch": motionNone,
	// torchflower block (1) -- mask=none, material=8
	"minecraft:torchflower": motionNone,
	// torchflower crop block (1) -- mask=none, material=8
	"minecraft:torchflower_crop": motionNone,
	// trap door block (13) -- mask=bits 13, material=2
	"minecraft:acacia_trapdoor": motionNone, "minecraft:bamboo_trapdoor": motionNone, "minecraft:birch_trapdoor": motionNone,
	"minecraft:cherry_trapdoor": motionNone, "minecraft:crimson_trapdoor": motionNone, "minecraft:dark_oak_trapdoor": motionNone,
	"minecraft:jungle_trapdoor": motionNone, "minecraft:mangrove_trapdoor": motionNone, "minecraft:pale_oak_trapdoor": motionNone,
	"minecraft:poplar_trapdoor": motionNone, "minecraft:spruce_trapdoor": motionNone, "minecraft:trapdoor": motionNone,
	"minecraft:warped_trapdoor": motionNone,
	// trap door block (1) -- mask=bits 13, material=3
	"minecraft:iron_trapdoor": motionNone,
	// trip wire block (1) -- mask=none, material=24
	"minecraft:trip_wire": motionNone,
	// trip wire hook block (1) -- mask=none, material=24
	"minecraft:tripwire_hook": motionNone,
	// turtle egg block (1) -- mask=none, material=23
	"minecraft:turtle_egg": motionNone,
	// twisting vines block (1) -- mask=none, material=8
	"minecraft:twisting_vines": motionNone,
	// underwater torch block (1) -- mask=none, material=24
	"minecraft:underwater_torch": motionNone,
	// vine block (1) -- mask=none, material=8
	"minecraft:vine": motionNone,
	// wall block (32) -- mask=bits 6+26, material=n/a
	"minecraft:andesite_wall": motionNone, "minecraft:blackstone_wall": motionNone, "minecraft:brick_wall": motionNone,
	"minecraft:cinnabar_brick_wall": motionNone, "minecraft:cinnabar_wall": motionNone, "minecraft:cobbled_deepslate_wall": motionNone,
	"minecraft:cobblestone_wall": motionNone, "minecraft:deepslate_brick_wall": motionNone, "minecraft:deepslate_tile_wall": motionNone,
	"minecraft:diorite_wall": motionNone, "minecraft:end_stone_brick_wall": motionNone, "minecraft:granite_wall": motionNone,
	"minecraft:mossy_cobblestone_wall": motionNone, "minecraft:mossy_stone_brick_wall": motionNone,
	"minecraft:mud_brick_wall": motionNone, "minecraft:nether_brick_wall": motionNone, "minecraft:polished_blackstone_brick_wall": motionNone,
	"minecraft:polished_blackstone_wall": motionNone, "minecraft:polished_cinnabar_wall": motionNone,
	"minecraft:polished_deepslate_wall": motionNone, "minecraft:polished_sulfur_wall": motionNone,
	"minecraft:polished_tuff_wall": motionNone, "minecraft:prismarine_wall": motionNone, "minecraft:red_nether_brick_wall": motionNone,
	"minecraft:red_sandstone_wall": motionNone, "minecraft:resin_brick_wall": motionNone, "minecraft:sandstone_wall": motionNone,
	"minecraft:stone_brick_wall": motionNone, "minecraft:sulfur_brick_wall": motionNone, "minecraft:sulfur_wall": motionNone,
	"minecraft:tuff_brick_wall": motionNone, "minecraft:tuff_wall": motionNone,
	// waterlily block (1) -- mask=none, material=9
	"minecraft:waterlily": motionNone,
	// web block (1) -- mask=none, material=24
	"minecraft:web": motionNone,
	// weeping vines block (1) -- mask=none, material=8
	"minecraft:weeping_vines": motionNone,
	// weighted pressure plate block (2) -- mask=bits 16, material=3
	"minecraft:heavy_weighted_pressure_plate": motionNone, "minecraft:light_weighted_pressure_plate": motionNone,
	// wither rose block (1) -- mask=none, material=8
	"minecraft:wither_rose": motionNone}

// motionClassOf resolves canonical (already minecraft:-prefixed where it is a
// vanilla id, as Palette.NameOf produces) to its answer pair.
func motionClassOf(canonical string) motionClass {
	if target, ok := legacyMotionSpellings[canonical]; ok {
		canonical = target
	}
	if c, ok := vanillaMotionClasses[canonical]; ok {
		return c
	}
	// Anything the table does not name -- an id the game does not know, and
	// every block a PACK defines -- is motionBoth. This is the vanilla answer
	// and not a fallback, for both cases: see the header's "A block a PACK
	// defines" section. In particular a pack block's OWN JSON is deliberately
	// not consulted here, because nothing in it reaches either input; a Palette
	// is not even a parameter, and adding one would be adding a way to be
	// wrong.
	return motionBoth
}

// IsMotionBlocking reports the block's motion-blocking predicate for the block
// named canonical. The states argument is accepted and deliberately unused: the
// predicate depends only on the block's TYPE, so every state of one type shares
// one answer.
func IsMotionBlocking(canonical string, states map[string]StateValue) bool {
	return motionClassOf(canonical) != motionNone
}

// IsSolidBlocking reports the block's solid-blocking predicate for the block
// named canonical -- the predicate structure_template's grounded and leveled
// constraints run against the world. Like IsMotionBlocking it is type-level.
//
// This is NOT the same question as Palette.IsSolid, which asks "is this one of
// the solid render KINDS" and is still what geode's anchor test and
// sculk_patch's neighbour scan use, because those model different vanilla checks.
func IsSolidBlocking(canonical string, states map[string]StateValue) bool {
	return motionClassOf(canonical) == motionBoth
}
