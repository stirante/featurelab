package block

import "strings"

// support.go answers the one question minecraft:snap_to_surface_feature asks of
// a candidate surface block when the pack gave no `allowed_surface_blocks`: the
// block's support test, asked with the any-support-type argument. Until
// 2026-08-21 this repo approximated that with Palette.IsSolid, which is a
// different question ("is this block one of the solid KINDS") and gets common
// families wrong in both directions -- glass is not a solid kind but supports
// every face, an oak slab is a solid kind but supports only the half it
// occupies.
//
// The behaviour modelled is that of Bedrock 1.26.50. 1.26.40 differs only in
// the two points noted below.
//
// ---- The dispatch, top to bottom ----
//
// The support test, taking a face and a support type, resolves like this:
//
//	c = the block's own block support component
//	if (!c) c = its block type's block support component
//	if (c && c->shape == 1) return the stair support check(block, face)
//	if (c && c->shape == 0) return (type in {Center, Any}) && face < 2
//	return the block type's own support rule (block, face, type)  // below
//
// The support-type test is "type with bit 1 cleared is zero", i.e. type in
// {Center = 0, Any = 2}. The snap path always passes Any (2), so every `type`
// test in this file is satisfied and is modelled as a constant true; that is
// why nothing here takes a support type. A Center- or Edge-passing caller would
// need those tests back.
//
// The block type's DEFAULT support rule is:
//
//	mask = the block type's 64-bit block property mask
//	return (mask & bit 18) ? true : (face == UP && bit 17 of mask)
//
// and a freshly created block type's mask holds exactly bit 18. So the default
// is "this block supports EVERY face", and a block only loses it if something
// takes it away.
//
// THAT SAME BIT 18 IS THE OTHER HALF OF THE MOTION-BLOCKING AND SOLID-BLOCKING
// PREDICATES, which is worth knowing before anyone re-derives it from scratch:
// those two predicates test the same bit. The per-class masks below therefore
// already carry the per-block datum block/motion.go needs -- this file just
// keeps a support RULE rather than the raw mask. Two things here do NOT carry
// over, because they belong to the support test and not to the bit: the 44
// block families with their own support rule and the fence/stair block support
// component shapes. A stair keeps bit 18 whatever its component answers.
// Replacing a block type's property mask is the only thing that can clear bit
// 18; adding properties only ORs bits in, so it never can. A mask that keeps
// bit 17 but not bit 18 means "top face only".
//
// ---- How the table below is organised ----
//
// Every vanilla block id is grouped by the block class that implements it.
// That covers every bench id except the colour-loop families (concrete,
// concrete powder, wool, terracotta, glazed terracotta) and the waxed/oxidised
// copper arrays, which are defined from a static id array; those are handled
// by the name families below or fall to the default.
//
// Each class's rule combines three things:
//
//   - the support rule the class inherits: a subclass without its own rule
//     uses its base class's, so e.g. the copper trapdoor uses the trapdoor
//     block's rule.
//   - the property mask of its most-derived ancestor that replaces the mask --
//     a replacement in a subclass wins over one in its base. The actor block
//     base and the copper block wrapper never replace the mask themselves, and
//     each copper wrapper takes the mask of the class it wraps, so the copper
//     doors are supportNever through the door block, not the default.
//   - the block support component a block is defined with: 79 vanilla blocks
//     carry one, 14 with shape 0 (fence) and 65 with shape 1 (stair). Those 79
//     are exactly the 14 vanilla fence ids and the 65 stair / copper stair ids,
//     with nothing else in either set.
//
// Five vanilla blocks lose their support ONLY through a property override
// applied when the block is defined, not by their class (see the table's
// DEFINITION-TIME group); a class-only derivation gets all five wrong.
//
// Between 1.26.40 and 1.26.50 the per-class results agree for 258 of 260
// classes; the two differences are the amethyst cluster block being renamed to
// the crystal cluster block (same always-false rule) and the straw bed gaining
// its own class with mask 0 in 1.26.50. This file follows 1.26.50.
//
// UNRESOLVED / approximate, listed so the next reader need not rediscover them:
//
//   - Non-vanilla (add-on) blocks always take the default "supports every face".
//     That is the behaviour for a block type that never replaces its property
//     mask, which is every JSON-defined block, so it is right for the common
//     case; a pack shipping its own block_support component is not modelled.
//   - The name families are applied only to minecraft:-namespaced names, so an
//     add-on's "mypack:oak_stairs" is NOT silently given the stair rule.
//   - (CLOSED 2026-08-22, kept because this used to be a disclosed gap.) The
//     int-to-string step for the enum-valued states this file reads used to be
//     INFERRED from Bedrock's documented value order. All four are now
//     CONFIRMED, and all four match what was assumed. A block state's NBT
//     serialisation maps the state's integer value directly onto its name by
//     position, so the value orders below ARE the int->string tables:
//         pillar_axis                   0=y, 1=x, 2=z
//         attachment                    0=standing, 1=hanging, 2=side,
//                                       3=multiple
//         minecraft:vertical_half       0=bottom, 1=top
//         minecraft:cardinal_direction  0=south, 1=west, 2=north, 3=east
//     features/horizontal_tree_decoration.go still marks the first two INFERRED
//     and can cite these instead.
//   - The piston arm's rule (piston_arm_collision) is modelled from the block's
//     facing_direction and reproduces the opposite-face lookup for horizontal
//     arms, but was never exercised against a live world.
//   - LEGACY AGGREGATE IDS (minecraft:leaves, tallgrass, red_flower, ...) are
//     given their flattened family's rule below. INFERRED: the game resolves
//     those names through block aliases long before this question is asked, so
//     they have no rule of their own; they are here so a pack that writes the
//     flat legacy name is not silently handed the default.

// Face is Bedrock's facing numbering: 0 down, 1 up, 2 north (-z), 3 south (+z),
// 4 west (-x), 5 east (+x) -- the same numbering state.go's multiface-block
// reading uses, and the one the support test takes.
type Face uint8

// The six Facing values.
const (
	FaceDown  Face = 0
	FaceUp    Face = 1
	FaceNorth Face = 2
	FaceSouth Face = 3
	FaceWest  Face = 4
	FaceEast  Face = 5
)

// OppositeFace is the opposite-face table: 1 0 3 2 5 4. A caller that walked `dir` to
// reach a surface asks that surface for OppositeFace[dir] -- a floor scan walks
// DOWN and asks the floor block about its UP face.
var OppositeFace = [6]Face{FaceUp, FaceDown, FaceSouth, FaceNorth, FaceEast, FaceWest}

// isHorizontal is the horizontal-face test: everything but down and up.
func (f Face) isHorizontal() bool { return f >= FaceNorth }

// VerticalHalfState is the JSON key for the built-in vertical-half state, the
// bottom/top state the slab support test and the stair support check both read
// as a bool (true == top). The pre-flattening spelling of the same field is
// "top_slot_bit", accepted alongside it wherever it is read.
const VerticalHalfState = "minecraft:vertical_half"

// supportRule is one answer shape. Rules are named for the block family that
// defines them, not for the ids that happen to use them.
type supportRule uint8

const (
	// supportAlways is the block type default -- mask bit 18 survives, so every
	// face supports. Never stored in the table: it is what a miss returns.
	supportAlways supportRule = iota
	// supportNever: the class replaced the mask with one holding neither bit 18
	// nor bit 17, or has its own rule that is always false
	// (the leaves, light, powder snow, shulker box, sea pickle, frog spawn,
	// crystal cluster and chorus plant blocks).
	supportNever
	// supportUpOnly: a mask that keeps bit 17 and not bit 18 (scaffolding, the
	// structure block, the hopper), or a rule that reduces to face == UP
	// under the any-support-type argument (the hopper: face == UP; the
	// cauldron: face == UP and type is Edge or Any).
	supportUpOnly
	// supportDownOnly: a rule that reduces to face == DOWN -- the shape
	// shared by the sculk sensor, sculk shrieker, grass path, lectern,
	// enchanting table, end portal frame, farmland, daylight detector, campfire
	// and stonecutter blocks, plus the "face == DOWN and type in {Center, Any}"
	// variant used by the heavy core, hanging sign, chest, chorus flower,
	// brewing stand, candle, turtle egg and anvil blocks.
	supportDownOnly
	// supportVertical is the "fence rule": face < 2. Reached either through a
	// shape-0 block support component (the 14 wooden/nether-brick fences) or
	// through a block's own rule that amounts to the same test -- the wall block,
	// the thin fence block (face < 2 with type in {Center, Any}), the decorated
	// pot and the sniffer egg. The border block shares the wall block's rule.
	supportVertical
	// supportStair is the shape-1 block support component check, the stair
	// support check.
	supportStair
	// supportSlab is the slab block's support test.
	supportSlab
	// supportSnowLayer is the top snow block's support test.
	supportSnowLayer
	// supportChain is the chain block's support test: the fence rule, gated on a
	// vertical pillar_axis.
	supportChain
	// supportRod is the end rod block's support test and the lightning rod
	// block's: the fence rule, gated on a vertical facing_direction.
	supportRod
	// supportTrapdoor is the trapdoor block's support test.
	supportTrapdoor
	// supportShelf is the shelf block's support test.
	supportShelf
	// supportSkull is the skull block's support test.
	supportSkull
	// supportGrindstone is the grindstone block's support test.
	supportGrindstone
	// supportPistonArm is the piston arm block's support test.
	supportPistonArm
)

// supportNameFamilies are the id suffixes whose whole family shares one rule.
// Each was checked against the full (id -> class -> rule) table: for every
// one of these suffixes, EVERY vanilla id carrying it resolves to the stated
// rule and no id outside the suffix carries that rule, so the suffix is a
// faithful compression of the table rather than a guess. They are tried only
// after the exact table below and only for minecraft:-namespaced names.
//
// Deliberately NOT a family: "_lantern" (minecraft:sea_lantern is a full block
// and keeps the default while the lanterns proper never support), "_door" and
// "_sign" (their wall/standing/hanging variants split across rules).
var supportNameFamilies = []struct {
	suffix string
	rule   supportRule
}{
	// 65 shape-1 block support components == the 57 stair-block ids plus
	// 8 copper stair ids, and every one of them ends "_stairs".
	{"_stairs", supportStair},
	// 122 slab-block + 16 copper-slab ids, all ending "_slab"
	// (which also catches every "_double_slab" -- the rule reads the double-ness
	// off the id, see canProvideSupportSlab).
	{"_slab", supportSlab},
	// wall block (32), fence block (14, via shape 0), thin fence block (35: panes
	// and iron/copper bars).
	{"_wall", supportVertical},
	{"_fence", supportVertical},
	{"_pane", supportVertical},
	{"_bars", supportVertical},
	// chain block: minecraft:iron_chain plus the eight copper chains.
	{"_chain", supportChain},
	// trapdoor block (14) + copper trapdoor block (8).
	{"_trapdoor", supportTrapdoor},
	// shelf block (13).
	{"_shelf", supportShelf},
	// candle block (16 dyed + plain) and hanging sign block (13), both DOWN only.
	{"_candle", supportDownOnly},
	{"_hanging_sign", supportDownOnly},
	// anvil block (anvil, chipped, damaged, deprecated).
	{"_anvil", supportDownOnly},
	// end rod block + the nine lightning rods.
	{"_rod", supportRod},
}

// vanillaSupportRules is the exact (id -> rule) table for every vanilla block
// whose rule is not the default and is not covered by supportNameFamilies. It
// is grouped by the block class that implements each id, so a reader can check
// any row against the class's rule or mask described on supportRule's constants.
var vanillaSupportRules = map[string]supportRule{
	// anvil block -- DOWN_ONLY (1)
	"minecraft:anvil": supportDownOnly,
	// brewing stand block -- DOWN_ONLY (1)
	"minecraft:brewing_stand": supportDownOnly,
	// calibrated sculk sensor block -- DOWN_ONLY (1; shares the sculk sensor block's rule)
	"minecraft:calibrated_sculk_sensor": supportDownOnly,
	// campfire block -- DOWN_ONLY (2)
	"minecraft:campfire": supportDownOnly, "minecraft:soul_campfire": supportDownOnly,
	// candle block -- DOWN_ONLY (1)
	"minecraft:candle": supportDownOnly,
	// chest block -- DOWN_ONLY (2)
	"minecraft:chest": supportDownOnly, "minecraft:trapped_chest": supportDownOnly,
	// chorus flower block -- DOWN_ONLY (1)
	"minecraft:chorus_flower": supportDownOnly,
	// copper chest block -- DOWN_ONLY (8; shares the chest block's rule)
	"minecraft:copper_chest": supportDownOnly, "minecraft:exposed_copper_chest": supportDownOnly,
	"minecraft:oxidized_copper_chest": supportDownOnly, "minecraft:waxed_copper_chest": supportDownOnly,
	"minecraft:waxed_exposed_copper_chest":   supportDownOnly,
	"minecraft:waxed_oxidized_copper_chest":  supportDownOnly,
	"minecraft:waxed_weathered_copper_chest": supportDownOnly,
	"minecraft:weathered_copper_chest":       supportDownOnly,
	// daylight detector block -- DOWN_ONLY (2)
	"minecraft:daylight_detector": supportDownOnly, "minecraft:daylight_detector_inverted": supportDownOnly,
	// enchanting table block -- DOWN_ONLY (1)
	"minecraft:enchanting_table": supportDownOnly,
	// end portal frame block -- DOWN_ONLY (1)
	"minecraft:end_portal_frame": supportDownOnly,
	// ender chest block -- DOWN_ONLY (1; shares the chest block's rule)
	"minecraft:ender_chest": supportDownOnly,
	// farm block -- DOWN_ONLY (1)
	"minecraft:farmland": supportDownOnly,
	// heavy core block -- DOWN_ONLY (1)
	"minecraft:heavy_core": supportDownOnly,
	// lectern block -- DOWN_ONLY (1)
	"minecraft:lectern": supportDownOnly,
	// path block -- DOWN_ONLY (1; "dirt_path" is this id's modern spelling and is
	// listed with it -- INFERRED, the game defines only "grass_path")
	"minecraft:grass_path": supportDownOnly, "minecraft:dirt_path": supportDownOnly,
	// sculk sensor block -- DOWN_ONLY (1)
	"minecraft:sculk_sensor": supportDownOnly,
	// sculk shrieker block -- DOWN_ONLY (1)
	"minecraft:sculk_shrieker": supportDownOnly,
	// stonecutter block -- DOWN_ONLY (1)
	"minecraft:stonecutter_block": supportDownOnly,
	// turtle egg block -- DOWN_ONLY (1)
	"minecraft:turtle_egg": supportDownOnly,
	// grindstone block -- GRINDSTONE (1)
	"minecraft:grindstone": supportGrindstone,
	// air block -- NEVER. Air's property mask is 0.
	// cave_air/void_air are not Bedrock ids at all but block/kind.go accepts
	// them, so they are listed with air -- INFERRED.
	"minecraft:air": supportNever, "minecraft:cave_air": supportNever,
	"minecraft:void_air": supportNever,
	// DEFINITION-TIME OVERRIDES -- NEVER (5). These five do not lose bit 18
	// through their block class at all: their property mask is replaced when the
	// block is defined, on top of whatever the class set. Twelve blocks get such a
	// definition-time override; seven of them are blocks whose class has its own
	// support rule anyway, so the mask changes nothing (brewing_stand,
	// sculk_sensor, sculk_shrieker, calibrated_sculk_sensor, heavy_core,
	// sculk_vein, and the nine lightning rods, which share one configuration);
	// these five are the ones that matter.
	"minecraft:pointed_dripstone": supportNever, // mask bit 11
	"minecraft:suspicious_sand":   supportNever, // mask bits 0+7
	"minecraft:suspicious_gravel": supportNever, // mask bits 0+7
	"minecraft:dried_ghast":       supportNever, // mask 0
	"minecraft:sulfur_spike":      supportNever, // mask bit 11
	// activator rail block -- NEVER (1)
	"minecraft:activator_rail": supportNever,
	// amethyst cluster block -- NEVER (4)
	"minecraft:amethyst_cluster": supportNever, "minecraft:large_amethyst_bud": supportNever,
	"minecraft:medium_amethyst_bud": supportNever, "minecraft:small_amethyst_bud": supportNever,
	// azalea block -- NEVER (2)
	"minecraft:azalea": supportNever, "minecraft:flowering_azalea": supportNever,
	// bamboo sapling block -- NEVER (1)
	"minecraft:bamboo_sapling": supportNever,
	// bamboo stalk block -- NEVER (1)
	"minecraft:bamboo": supportNever,
	// banner block -- NEVER (2)
	"minecraft:standing_banner": supportNever, "minecraft:wall_banner": supportNever,
	// bed block -- NEVER (1)
	"minecraft:bed": supportNever,
	// beetroot block -- NEVER (1)
	"minecraft:beetroot": supportNever,
	// bell block -- NEVER (1)
	"minecraft:bell": supportNever,
	// big dripleaf block -- NEVER (1)
	"minecraft:big_dripleaf": supportNever,
	// bubble column block -- NEVER (1)
	"minecraft:bubble_column": supportNever,
	// bush block -- NEVER (1)
	"minecraft:bush": supportNever,
	// button block -- NEVER (15)
	"minecraft:acacia_button": supportNever, "minecraft:bamboo_button": supportNever,
	"minecraft:birch_button": supportNever, "minecraft:cherry_button": supportNever,
	"minecraft:crimson_button": supportNever, "minecraft:dark_oak_button": supportNever,
	"minecraft:jungle_button": supportNever, "minecraft:mangrove_button": supportNever,
	"minecraft:pale_oak_button": supportNever, "minecraft:polished_blackstone_button": supportNever,
	"minecraft:poplar_button": supportNever, "minecraft:spruce_button": supportNever,
	"minecraft:stone_button": supportNever, "minecraft:warped_button": supportNever,
	"minecraft:wooden_button": supportNever,
	// cactus block -- NEVER (1)
	"minecraft:cactus": supportNever,
	// cactus flower block -- NEVER (1)
	"minecraft:cactus_flower": supportNever,
	// cake block -- NEVER (1)
	"minecraft:cake": supportNever,
	// camera block -- NEVER (1)
	"minecraft:camera": supportNever,
	// candle cake block -- NEVER (17)
	"minecraft:black_candle_cake": supportNever, "minecraft:blue_candle_cake": supportNever,
	"minecraft:brown_candle_cake": supportNever, "minecraft:candle_cake": supportNever,
	"minecraft:cyan_candle_cake": supportNever, "minecraft:gray_candle_cake": supportNever,
	"minecraft:green_candle_cake": supportNever, "minecraft:light_blue_candle_cake": supportNever,
	"minecraft:light_gray_candle_cake": supportNever, "minecraft:lime_candle_cake": supportNever,
	"minecraft:magenta_candle_cake": supportNever, "minecraft:orange_candle_cake": supportNever,
	"minecraft:pink_candle_cake": supportNever, "minecraft:purple_candle_cake": supportNever,
	"minecraft:red_candle_cake": supportNever, "minecraft:white_candle_cake": supportNever,
	"minecraft:yellow_candle_cake": supportNever,
	// carpet block -- NEVER (17)
	"minecraft:black_carpet": supportNever, "minecraft:blue_carpet": supportNever,
	"minecraft:brown_carpet": supportNever, "minecraft:cyan_carpet": supportNever,
	"minecraft:gray_carpet": supportNever, "minecraft:green_carpet": supportNever,
	"minecraft:light_blue_carpet": supportNever, "minecraft:light_gray_carpet": supportNever,
	"minecraft:lime_carpet": supportNever, "minecraft:magenta_carpet": supportNever,
	"minecraft:moss_carpet": supportNever, "minecraft:orange_carpet": supportNever,
	"minecraft:pink_carpet": supportNever, "minecraft:purple_carpet": supportNever,
	"minecraft:red_carpet": supportNever, "minecraft:white_carpet": supportNever,
	"minecraft:yellow_carpet": supportNever,
	// carrot block -- NEVER (1)
	"minecraft:carrots": supportNever,
	// cave vines block -- NEVER (3)
	"minecraft:cave_vines": supportNever, "minecraft:cave_vines_body_with_berries": supportNever,
	"minecraft:cave_vines_head_with_berries": supportNever,
	// chalkboard block -- NEVER (1)
	"minecraft:chalkboard": supportNever,
	// cherry leaves block -- NEVER (1; shares the leaves block's rule)
	"minecraft:cherry_leaves": supportNever,
	// chorus plant block -- NEVER (1)
	"minecraft:chorus_plant": supportNever,
	// cocoa block -- NEVER (1)
	"minecraft:cocoa": supportNever,
	// colored torch block -- NEVER (4)
	"minecraft:colored_torch_blue": supportNever, "minecraft:colored_torch_green": supportNever,
	"minecraft:colored_torch_purple": supportNever, "minecraft:colored_torch_red": supportNever,
	// comparator block -- NEVER (2)
	"minecraft:powered_comparator": supportNever, "minecraft:unpowered_comparator": supportNever,
	// conduit block -- NEVER (1)
	"minecraft:conduit": supportNever,
	// copper golem statue block -- NEVER (8)
	"minecraft:copper_golem_statue": supportNever, "minecraft:exposed_copper_golem_statue": supportNever,
	"minecraft:oxidized_copper_golem_statue": supportNever, "minecraft:waxed_copper_golem_statue": supportNever,
	"minecraft:waxed_exposed_copper_golem_statue":   supportNever,
	"minecraft:waxed_oxidized_copper_golem_statue":  supportNever,
	"minecraft:waxed_weathered_copper_golem_statue": supportNever,
	"minecraft:weathered_copper_golem_statue":       supportNever,
	// coral fan -- NEVER (10)
	"minecraft:brain_coral_fan": supportNever, "minecraft:bubble_coral_fan": supportNever,
	"minecraft:dead_brain_coral_fan": supportNever, "minecraft:dead_bubble_coral_fan": supportNever,
	"minecraft:dead_fire_coral_fan": supportNever, "minecraft:dead_horn_coral_fan": supportNever,
	"minecraft:dead_tube_coral_fan": supportNever, "minecraft:fire_coral_fan": supportNever,
	"minecraft:horn_coral_fan": supportNever, "minecraft:tube_coral_fan": supportNever,
	// hanging coral fan -- NEVER (10)
	"minecraft:brain_coral_wall_fan": supportNever, "minecraft:bubble_coral_wall_fan": supportNever,
	"minecraft:dead_brain_coral_wall_fan": supportNever, "minecraft:dead_bubble_coral_wall_fan": supportNever,
	"minecraft:dead_fire_coral_wall_fan": supportNever, "minecraft:dead_horn_coral_wall_fan": supportNever,
	"minecraft:dead_tube_coral_wall_fan": supportNever, "minecraft:fire_coral_wall_fan": supportNever,
	"minecraft:horn_coral_wall_fan": supportNever, "minecraft:tube_coral_wall_fan": supportNever,
	// coral plant block -- NEVER (10)
	"minecraft:brain_coral": supportNever, "minecraft:bubble_coral": supportNever,
	"minecraft:dead_brain_coral": supportNever, "minecraft:dead_bubble_coral": supportNever,
	"minecraft:dead_fire_coral": supportNever, "minecraft:dead_horn_coral": supportNever,
	"minecraft:dead_tube_coral": supportNever, "minecraft:fire_coral": supportNever,
	"minecraft:horn_coral": supportNever, "minecraft:tube_coral": supportNever,
	// crop block -- NEVER (1)
	"minecraft:wheat": supportNever,
	// dead bush block -- NEVER (1)
	"minecraft:deadbush": supportNever,
	// detector rail block -- NEVER (1)
	"minecraft:detector_rail": supportNever,
	// door block -- NEVER (14) and copper door block (8, shares the door block's mask)
	"minecraft:acacia_door": supportNever, "minecraft:bamboo_door": supportNever,
	"minecraft:birch_door": supportNever, "minecraft:cherry_door": supportNever,
	"minecraft:crimson_door": supportNever, "minecraft:dark_oak_door": supportNever,
	"minecraft:iron_door": supportNever, "minecraft:jungle_door": supportNever,
	"minecraft:mangrove_door": supportNever, "minecraft:pale_oak_door": supportNever,
	"minecraft:poplar_door": supportNever, "minecraft:spruce_door": supportNever,
	"minecraft:warped_door": supportNever, "minecraft:wooden_door": supportNever,
	"minecraft:copper_door": supportNever, "minecraft:exposed_copper_door": supportNever,
	"minecraft:oxidized_copper_door": supportNever, "minecraft:waxed_copper_door": supportNever,
	"minecraft:waxed_exposed_copper_door":   supportNever,
	"minecraft:waxed_oxidized_copper_door":  supportNever,
	"minecraft:waxed_weathered_copper_door": supportNever,
	"minecraft:weathered_copper_door":       supportNever,
	// double plant block -- NEVER (4)
	"minecraft:lilac": supportNever, "minecraft:peony": supportNever, "minecraft:rose_bush": supportNever,
	"minecraft:sunflower": supportNever,
	// double vegetation block -- NEVER (2)
	"minecraft:large_fern": supportNever, "minecraft:tall_grass": supportNever,
	// dragon egg block -- NEVER (1)
	"minecraft:dragon_egg": supportNever,
	// end gateway block -- NEVER (1)
	"minecraft:end_gateway": supportNever,
	// end portal block -- NEVER (1)
	"minecraft:end_portal": supportNever,
	// eyeblossom block -- NEVER (2)
	"minecraft:closed_eyeblossom": supportNever, "minecraft:open_eyeblossom": supportNever,
	// fence gate block -- NEVER (13) -- mask 0x10, and note it is NOT the fence rule
	"minecraft:acacia_fence_gate": supportNever, "minecraft:bamboo_fence_gate": supportNever,
	"minecraft:birch_fence_gate": supportNever, "minecraft:cherry_fence_gate": supportNever,
	"minecraft:crimson_fence_gate": supportNever, "minecraft:dark_oak_fence_gate": supportNever,
	"minecraft:fence_gate": supportNever, "minecraft:jungle_fence_gate": supportNever,
	"minecraft:mangrove_fence_gate": supportNever, "minecraft:pale_oak_fence_gate": supportNever,
	"minecraft:poplar_fence_gate": supportNever, "minecraft:spruce_fence_gate": supportNever,
	"minecraft:warped_fence_gate": supportNever,
	// fire block -- NEVER (1)
	"minecraft:fire": supportNever,
	// firefly bush block -- NEVER (1)
	"minecraft:firefly_bush": supportNever,
	// flower bed block -- NEVER (2)
	"minecraft:pink_petals": supportNever, "minecraft:wildflowers": supportNever,
	// flower block -- NEVER (14)
	"minecraft:allium": supportNever, "minecraft:azure_bluet": supportNever,
	"minecraft:blue_orchid": supportNever, "minecraft:cornflower": supportNever,
	"minecraft:crimson_roots": supportNever, "minecraft:dandelion": supportNever,
	"minecraft:lily_of_the_valley": supportNever, "minecraft:orange_tulip": supportNever,
	"minecraft:oxeye_daisy": supportNever, "minecraft:pink_tulip": supportNever,
	"minecraft:poppy": supportNever, "minecraft:red_tulip": supportNever,
	"minecraft:warped_roots": supportNever, "minecraft:white_tulip": supportNever,
	// flower pot block -- NEVER (1)
	"minecraft:flower_pot": supportNever,
	// frog spawn block -- NEVER (1)
	"minecraft:frog_spawn": supportNever,
	// glow item frame block -- NEVER (1)
	"minecraft:glow_frame": supportNever,
	// glow lichen block -- NEVER (1)
	"minecraft:glow_lichen": supportNever,
	// golden dandelion -- NEVER (1)
	"minecraft:golden_dandelion": supportNever,
	// hanging roots block -- NEVER (1)
	"minecraft:hanging_roots": supportNever,
	// item frame block -- NEVER (1)
	"minecraft:frame": supportNever,
	// jigsaw block -- NEVER (1)
	"minecraft:jigsaw": supportNever,
	// kelp block -- NEVER (1)
	"minecraft:kelp": supportNever,
	// ladder block -- NEVER (1)
	"minecraft:ladder": supportNever,
	// lantern block -- NEVER (2 + the 8 copper lanterns)
	"minecraft:lantern": supportNever, "minecraft:soul_lantern": supportNever,
	"minecraft:copper_lantern": supportNever, "minecraft:exposed_copper_lantern": supportNever,
	"minecraft:oxidized_copper_lantern": supportNever, "minecraft:waxed_copper_lantern": supportNever,
	"minecraft:waxed_exposed_copper_lantern":   supportNever,
	"minecraft:waxed_oxidized_copper_lantern":  supportNever,
	"minecraft:waxed_weathered_copper_lantern": supportNever,
	"minecraft:weathered_copper_lantern":       supportNever,
	// leaf litter block -- NEVER (1)
	"minecraft:leaf_litter": supportNever,
	// leaves block -- NEVER (6)
	"minecraft:acacia_leaves": supportNever, "minecraft:birch_leaves": supportNever,
	"minecraft:dark_oak_leaves": supportNever, "minecraft:jungle_leaves": supportNever,
	"minecraft:oak_leaves": supportNever, "minecraft:spruce_leaves": supportNever,
	// lever block -- NEVER (1)
	"minecraft:lever": supportNever,
	// light block -- NEVER (16)
	"minecraft:light_block_0": supportNever, "minecraft:light_block_1": supportNever,
	"minecraft:light_block_10": supportNever, "minecraft:light_block_11": supportNever,
	"minecraft:light_block_12": supportNever, "minecraft:light_block_13": supportNever,
	"minecraft:light_block_14": supportNever, "minecraft:light_block_15": supportNever,
	"minecraft:light_block_2": supportNever, "minecraft:light_block_3": supportNever,
	"minecraft:light_block_4": supportNever, "minecraft:light_block_5": supportNever,
	"minecraft:light_block_6": supportNever, "minecraft:light_block_7": supportNever,
	"minecraft:light_block_8": supportNever, "minecraft:light_block_9": supportNever,
	// liquid blocks, still and flowing -- NEVER (4, mask 0)
	"minecraft:lava": supportNever, "minecraft:water": supportNever,
	"minecraft:flowing_lava": supportNever, "minecraft:flowing_water": supportNever,
	// mangrove leaves block -- NEVER (1)
	"minecraft:mangrove_leaves": supportNever,
	// mangrove propagule block -- NEVER (1)
	"minecraft:mangrove_propagule": supportNever,
	// moving block -- NEVER (1)
	"minecraft:moving_block": supportNever,
	// multiface block -- NEVER (1)
	"minecraft:resin_clump": supportNever,
	// mushroom block -- NEVER (2)
	"minecraft:brown_mushroom": supportNever, "minecraft:red_mushroom": supportNever,
	// nether fungus block -- NEVER (2)
	"minecraft:crimson_fungus": supportNever, "minecraft:warped_fungus": supportNever,
	// nether sprouts block -- NEVER (1)
	"minecraft:nether_sprouts": supportNever,
	// nether wart block -- NEVER (1)
	"minecraft:nether_wart": supportNever,
	// pale hanging moss block -- NEVER (1)
	"minecraft:pale_hanging_moss": supportNever,
	// pale moss carpet block -- NEVER (1)
	"minecraft:pale_moss_carpet": supportNever,
	// pitcher crop / pitcher plant -- NEVER (2)
	"minecraft:pitcher_crop": supportNever, "minecraft:pitcher_plant": supportNever,
	// portal block -- NEVER (1)
	"minecraft:portal": supportNever,
	// potato block -- NEVER (1)
	"minecraft:potatoes": supportNever,
	// powder snow block -- NEVER (1)
	"minecraft:powder_snow": supportNever,
	// powered rail block -- NEVER (1)
	"minecraft:golden_rail": supportNever,
	// pressure plate block -- NEVER (15, mask 0x10000)
	"minecraft:acacia_pressure_plate": supportNever, "minecraft:bamboo_pressure_plate": supportNever,
	"minecraft:birch_pressure_plate": supportNever, "minecraft:cherry_pressure_plate": supportNever,
	"minecraft:crimson_pressure_plate": supportNever, "minecraft:dark_oak_pressure_plate": supportNever,
	"minecraft:jungle_pressure_plate": supportNever, "minecraft:mangrove_pressure_plate": supportNever,
	"minecraft:pale_oak_pressure_plate":            supportNever,
	"minecraft:polished_blackstone_pressure_plate": supportNever,
	"minecraft:poplar_pressure_plate":              supportNever, "minecraft:spruce_pressure_plate": supportNever,
	"minecraft:stone_pressure_plate": supportNever, "minecraft:warped_pressure_plate": supportNever,
	"minecraft:wooden_pressure_plate": supportNever,
	// rail block -- NEVER (1)
	"minecraft:rail": supportNever,
	// redstone wire block -- NEVER (1)
	"minecraft:redstone_wire": supportNever,
	// redstone torch block -- NEVER (2)
	"minecraft:redstone_torch": supportNever, "minecraft:unlit_redstone_torch": supportNever,
	// repeater block -- NEVER (2)
	"minecraft:powered_repeater": supportNever, "minecraft:unpowered_repeater": supportNever,
	// sapling block -- NEVER (9)
	"minecraft:acacia_sapling": supportNever, "minecraft:birch_sapling": supportNever,
	"minecraft:cherry_sapling": supportNever, "minecraft:dark_oak_sapling": supportNever,
	"minecraft:jungle_sapling": supportNever, "minecraft:oak_sapling": supportNever,
	"minecraft:pale_oak_sapling": supportNever, "minecraft:poplar_sapling": supportNever,
	"minecraft:spruce_sapling": supportNever,
	// sculk vein block -- NEVER (1)
	"minecraft:sculk_vein": supportNever,
	// sea pickle block -- NEVER (1)
	"minecraft:sea_pickle": supportNever,
	// seagrass block -- NEVER (1)
	"minecraft:seagrass": supportNever,
	// seasons agnostic leaves block -- NEVER (6)
	"minecraft:azalea_leaves": supportNever, "minecraft:azalea_leaves_flowered": supportNever,
	"minecraft:orange_poplar_leaves": supportNever, "minecraft:pale_oak_leaves": supportNever,
	"minecraft:red_poplar_leaves": supportNever, "minecraft:yellow_poplar_leaves": supportNever,
	// short / tall dry grass -- NEVER (2)
	"minecraft:short_dry_grass": supportNever, "minecraft:tall_dry_grass": supportNever,
	// shulker box block -- NEVER (17)
	"minecraft:black_shulker_box": supportNever, "minecraft:blue_shulker_box": supportNever,
	"minecraft:brown_shulker_box": supportNever, "minecraft:cyan_shulker_box": supportNever,
	"minecraft:gray_shulker_box": supportNever, "minecraft:green_shulker_box": supportNever,
	"minecraft:light_blue_shulker_box": supportNever, "minecraft:light_gray_shulker_box": supportNever,
	"minecraft:lime_shulker_box": supportNever, "minecraft:magenta_shulker_box": supportNever,
	"minecraft:orange_shulker_box": supportNever, "minecraft:pink_shulker_box": supportNever,
	"minecraft:purple_shulker_box": supportNever, "minecraft:red_shulker_box": supportNever,
	"minecraft:undyed_shulker_box": supportNever, "minecraft:white_shulker_box": supportNever,
	"minecraft:yellow_shulker_box": supportNever,
	// sign block -- NEVER (26; the hanging signs are DOWN-only and live in the
	// "_hanging_sign" family instead)
	"minecraft:acacia_standing_sign": supportNever, "minecraft:acacia_wall_sign": supportNever,
	"minecraft:bamboo_standing_sign": supportNever, "minecraft:bamboo_wall_sign": supportNever,
	"minecraft:birch_standing_sign": supportNever, "minecraft:birch_wall_sign": supportNever,
	"minecraft:cherry_standing_sign": supportNever, "minecraft:cherry_wall_sign": supportNever,
	"minecraft:crimson_standing_sign": supportNever, "minecraft:crimson_wall_sign": supportNever,
	"minecraft:darkoak_standing_sign": supportNever, "minecraft:darkoak_wall_sign": supportNever,
	"minecraft:jungle_standing_sign": supportNever, "minecraft:jungle_wall_sign": supportNever,
	"minecraft:mangrove_standing_sign": supportNever, "minecraft:mangrove_wall_sign": supportNever,
	"minecraft:pale_oak_standing_sign": supportNever, "minecraft:pale_oak_wall_sign": supportNever,
	"minecraft:poplar_standing_sign": supportNever, "minecraft:poplar_wall_sign": supportNever,
	"minecraft:spruce_standing_sign": supportNever, "minecraft:spruce_wall_sign": supportNever,
	"minecraft:standing_sign": supportNever, "minecraft:wall_sign": supportNever,
	"minecraft:warped_standing_sign": supportNever, "minecraft:warped_wall_sign": supportNever,
	// small dripleaf block -- NEVER (1)
	"minecraft:small_dripleaf_block": supportNever,
	// soul fire block -- NEVER (1)
	"minecraft:soul_fire": supportNever,
	// spore blossom block -- NEVER (1)
	"minecraft:spore_blossom": supportNever,
	// stem block -- NEVER (2)
	"minecraft:melon_stem": supportNever, "minecraft:pumpkin_stem": supportNever,
	// straw bed -- NEVER (1)
	"minecraft:straw_bed": supportNever,
	// sugar cane block -- NEVER (1)
	"minecraft:reeds": supportNever,
	// sweet berry bush block -- NEVER (1)
	"minecraft:sweet_berry_bush": supportNever,
	// tall grass block -- NEVER (2)
	"minecraft:fern": supportNever, "minecraft:short_grass": supportNever,
	// torch / soul torch / underwater torch -- NEVER (4)
	"minecraft:copper_torch": supportNever, "minecraft:torch": supportNever,
	"minecraft:soul_torch": supportNever, "minecraft:underwater_torch": supportNever,
	// torchflower / torchflower crop -- NEVER (2)
	"minecraft:torchflower": supportNever, "minecraft:torchflower_crop": supportNever,
	// trip wire / tripwire hook -- NEVER (2)
	"minecraft:trip_wire": supportNever, "minecraft:tripwire_hook": supportNever,
	// twisting vines / weeping vines / vine -- NEVER (3)
	"minecraft:twisting_vines": supportNever, "minecraft:weeping_vines": supportNever,
	"minecraft:vine": supportNever,
	// waterlily block -- NEVER (1)
	"minecraft:waterlily": supportNever,
	// web block -- NEVER (1)
	"minecraft:web": supportNever,
	// weighted pressure plate block -- NEVER (2)
	"minecraft:heavy_weighted_pressure_plate": supportNever,
	"minecraft:light_weighted_pressure_plate": supportNever,
	// wither rose block -- NEVER (1)
	"minecraft:wither_rose": supportNever,
	// piston arm block -- PISTONARM (2)
	"minecraft:piston_arm_collision":        supportPistonArm,
	"minecraft:sticky_piston_arm_collision": supportPistonArm,
	// skull block -- SKULL (7)
	"minecraft:creeper_head": supportSkull, "minecraft:dragon_head": supportSkull,
	"minecraft:piglin_head": supportSkull, "minecraft:player_head": supportSkull,
	"minecraft:skeleton_skull": supportSkull, "minecraft:wither_skeleton_skull": supportSkull,
	"minecraft:zombie_head": supportSkull,
	// top snow block -- SNOW (1)
	"minecraft:snow_layer": supportSnowLayer,
	// trap door block -- TRAPDOOR (1; the rest are in the "_trapdoor" family)
	"minecraft:trapdoor": supportTrapdoor,
	// scaffolding / structure block -- UP only, by mask bit 17
	"minecraft:scaffolding": supportUpOnly, "minecraft:structure_block": supportUpOnly,
	// cauldron block -- UP_ONLY (2) and hopper block -- UP_ONLY (1)
	"minecraft:cauldron": supportUpOnly, "minecraft:lava_cauldron": supportUpOnly,
	"minecraft:hopper": supportUpOnly,
	// border block / decorated pot / sniffer egg -- the fence rule
	"minecraft:border_block": supportVertical, "minecraft:decorated_pot": supportVertical,
	"minecraft:sniffer_egg": supportVertical,
	// The chain block -- the game defines "minecraft:iron_chain", which the
	// "_chain" family already covers; the bare pre-rename spelling does not end
	// in "_chain" and so needs its own row.
	"minecraft:chain": supportChain,
	// LEGACY AGGREGATE IDS -- INFERRED (see this file's header): the game
	// flattens these through block aliases before any block ever answers the
	// support test, so they have no rule of their own. They carry
	// the rule of the family they flatten into, so a pack writing the flat name
	// is not silently handed the default.
	"minecraft:leaves": supportNever, "minecraft:leaves2": supportNever,
	"minecraft:tallgrass": supportNever, "minecraft:double_plant": supportNever,
	"minecraft:red_flower": supportNever, "minecraft:yellow_flower": supportNever,
	"minecraft:sapling": supportNever, "minecraft:coral": supportNever,
	"minecraft:coral_fan": supportNever, "minecraft:coral_fan_dead": supportNever,
	"minecraft:coral_fan_hang": supportNever, "minecraft:coral_fan_hang2": supportNever,
	"minecraft:coral_fan_hang3": supportNever, "minecraft:carpet": supportNever,
}

// supportRuleFor picks the rule for a canonical block name. Exact table first,
// then the name families, then the default. Only minecraft:-named blocks are
// eligible for either lookup: an add-on block has no vanilla block class behind
// it, so it keeps the default the way any JSON-defined block does.
func supportRuleFor(name string) supportRule {
	if !strings.HasPrefix(name, "minecraft:") {
		return supportAlways
	}
	if r, ok := vanillaSupportRules[name]; ok {
		return r
	}
	for _, fam := range supportNameFamilies {
		if strings.HasSuffix(name, fam.suffix) {
			return fam.rule
		}
	}
	return supportAlways
}

// CanProvideSupport reports the block's support test, asked with the
// any-support-type argument, for a block identified by its canonical name and its
// own states -- see this file's header for the dispatch and for how the rules
// are organised.
func CanProvideSupport(name string, states map[string]StateValue, face Face) bool {
	if face > FaceEast {
		return false
	}
	switch supportRuleFor(name) {
	case supportNever:
		return false
	case supportUpOnly:
		return face == FaceUp
	case supportDownOnly:
		return face == FaceDown
	case supportVertical:
		return !face.isHorizontal()
	case supportStair:
		return supportStairCheck(states, face)
	case supportSlab:
		return supportSlabCheck(name, states, face)
	case supportSnowLayer:
		return supportSnowLayerCheck(states)
	case supportChain:
		return supportChainCheck(states, face)
	case supportRod:
		return supportRodCheck(states, face)
	case supportTrapdoor:
		return supportTrapdoorCheck(states, face)
	case supportShelf:
		return supportShelfCheck(states, face)
	case supportSkull:
		return supportSkullCheck(states, face)
	case supportGrindstone:
		return supportGrindstoneCheck(states, face)
	case supportPistonArm:
		return supportPistonArmCheck(states, face)
	}
	return true
}

// CanProvideSupport is the palette-side spelling of the package function, for
// callers that hold an interned id.
func (p *Palette) CanProvideSupport(id ID, face Face) bool {
	e := p.Entry(id)
	return CanProvideSupport(e.Name, e.States, face)
}

// ---------------------------------------------------------------------------
// State readers.
//
// The support rules read the block's CURRENT value for a state its type
// declares. A palette entry that
// simply omits a state is the state's default variant, so every reader below
// falls back to the default the vanilla block ships with (bottom slab, closed
// trapdoor, one snow layer, standing grindstone, vertical chain) rather than
// inventing a value.

// stateBoolValue reads a state the support rules treat as a bool. The
// JSON side spells such a state either as a real bool, as 0/1, or -- for the
// modern enum-shaped ones -- as a string, so all three are accepted.
func stateBoolValue(states map[string]StateValue, key string, trueWord string) (bool, bool) {
	v, ok := states[key]
	if !ok {
		return false, false
	}
	switch x := v.(type) {
	case bool:
		return x, true
	case float64:
		return x != 0, true
	case int:
		return x != 0, true
	case string:
		if trueWord != "" {
			return x == trueWord, true
		}
		return x == "true", true
	}
	return false, false
}

// stateIntValue reads a state the support rules treat as an integer.
func stateIntValue(states map[string]StateValue, key string) (int, bool) {
	v, ok := states[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// directionFacing is the direction-to-facing table -- [3, 4, 2, 5], i.e.
// Bedrock's Direction enum south=0, west=1, north=2, east=3 mapped onto Facing.
var directionFacing = [4]Face{FaceSouth, FaceWest, FaceNorth, FaceEast}

// cardinalDirectionFacing reads minecraft:cardinal_direction and returns the
// Facing it names. The string-to-index step is CONFIRMED (see this file's
// header; Bedrock's documented value order south/west/north/east, the same
// link features/horizontal_tree_decoration.go already documents).
func cardinalDirectionFacing(states map[string]StateValue) (Face, bool) {
	v, ok := states[CardinalDirectionState]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case string:
		switch x {
		case "south":
			return FaceSouth, true
		case "west":
			return FaceWest, true
		case "north":
			return FaceNorth, true
		case "east":
			return FaceEast, true
		}
		return 0, false
	case float64:
		if x >= 0 && int(x) < 4 {
			return directionFacing[int(x)], true
		}
	case int:
		if x >= 0 && x < 4 {
			return directionFacing[x], true
		}
	}
	return 0, false
}

// ---------------------------------------------------------------------------
// The per-family rules.

// supportStairCheck is the stair support check, reached from the shape-1
// branch of the block support component's support test:
//
//	face DOWN -> !upsideDown          face UP -> upsideDown
//	horizontal -> stairFacing == face
//
// upsideDown comes from upside_down_bit if the type has it, else from
// minecraft:vertical_half, else the whole check is FALSE outright -- so a
// stair with neither state does NOT get the `!false = true` a naive reading of
// the DOWN branch would give. stairFacing comes from weirdo_direction through
// the stair-direction-to-facing conversion (d < 4 ? 5 - d : 6,
// so 0->east, 1->west, 2->south, 3->north), else from
// minecraft:cardinal_direction through the direction-to-facing table, else from
// facing_direction used raw, else false.
func supportStairCheck(states map[string]StateValue, face Face) bool {
	if !face.isHorizontal() {
		upsideDown, ok := stateBoolValue(states, "upside_down_bit", "")
		if !ok {
			upsideDown, ok = stateBoolValue(states, VerticalHalfState, "top")
		}
		if !ok {
			return false
		}
		if face == FaceDown {
			return !upsideDown
		}
		return upsideDown
	}
	if d, ok := stateIntValue(states, "weirdo_direction"); ok {
		if d >= 0 && d < 4 {
			return Face(5-d) == face
		}
		return Face(6) == face // unreachable for a legal state; out-of-range maps to 6
	}
	if f, ok := cardinalDirectionFacing(states); ok {
		return f == face
	}
	if d, ok := stateIntValue(states, "facing_direction"); ok {
		return d >= 0 && d < 6 && Face(d) == face
	}
	return false
}

// supportSlabCheck is the slab block's support test:
//
//	isDouble || (face == UP && half == top) || (face == DOWN && half == bottom)
//
// isDouble is a fixed property of the block type, and the ids that carry it
// are exactly the "*_double_slab" ones -- so this takes it from the name.
// `half` is the built-in vertical-half state as a bool, with no state-presence
// guard, so an absent state is the vanilla default (bottom).
func supportSlabCheck(name string, states map[string]StateValue, face Face) bool {
	if strings.HasSuffix(name, "_double_slab") {
		return true
	}
	top, ok := stateBoolValue(states, VerticalHalfState, "top")
	if !ok {
		top, _ = stateBoolValue(states, "top_slot_bit", "")
	}
	if face == FaceUp {
		return top
	}
	if face == FaceDown {
		return !top
	}
	return false
}

// supportSnowLayerCheck is the top snow block's support test: the height
// state plus 1 compared against the height state's own declared value count,
// with the FACE ignored entirely -- a full-height snow layer supports every face
// and a shallower one supports none.
//
// That value count is the top snow block's maximum height, 8. So the
// condition is height == 7, the eighth and full layer. An absent height is
// the vanilla default 0, one layer.
func supportSnowLayerCheck(states map[string]StateValue) bool {
	h, _ := stateIntValue(states, "height")
	return h+1 == topSnowMaxHeight
}

// topSnowMaxHeight is the top snow block's maximum-height constant -- the declared value count of
// the `height` state, 8 (values 0..7).
const topSnowMaxHeight = 8

// supportChainCheck is the chain block's support test: axis 1 and 2 support
// nothing and axis 0 falls through to the fence rule (face < 2). Under
// this repo's established pillar-axis reading (0 = y, 1 = x, 2 = z -- CONFIRMED,
// see this file's header and features/horizontal_tree_decoration.go, and corroborated
// here: it is the only assignment under which a vertical chain is the one that
// supports) that means a vertical chain supports down and up, a horizontal one
// supports nothing. An absent pillar_axis is vanilla's universal default "y".
func supportChainCheck(states map[string]StateValue, face Face) bool {
	if axis, ok := states["pillar_axis"].(string); ok && axis != "y" {
		return false
	}
	if axis, ok := stateIntValue(states, "pillar_axis"); ok && axis >= 1 && axis <= 2 {
		return false
	}
	return !face.isHorizontal()
}

// supportRodCheck is the end rod block's support test and the lightning rod
// block's, which are the same rule: if the rod's own facing_direction is
// horizontal the answer is false, otherwise it is the fence rule (face < 2).
func supportRodCheck(states map[string]StateValue, face Face) bool {
	if d, ok := stateIntValue(states, "facing_direction"); ok && d >= 2 {
		return false
	}
	return !face.isHorizontal()
}

// trapDoorToFacingDirection is the trapdoor-direction-to-facing conversion --
// [4, 5, 2, 3].
var trapDoorToFacingDirection = [4]Face{FaceWest, FaceEast, FaceNorth, FaceSouth}

// supportTrapdoorCheck is the trapdoor block's support test:
//
//	face < 2  : open ? false : (face == DOWN) != upsideDown   // i.e. DOWN -> !ud, UP -> ud
//	horizontal: open ? trapDoorToFacingDirection[direction] == face : false
//
// open_bit and upside_down_bit are bools with no state-presence guard,
// so an absent state is the vanilla default (closed, right way up).
func supportTrapdoorCheck(states map[string]StateValue, face Face) bool {
	open, _ := stateBoolValue(states, "open_bit", "")
	if !face.isHorizontal() {
		if open {
			return false
		}
		upsideDown, _ := stateBoolValue(states, "upside_down_bit", "")
		if face == FaceDown {
			return !upsideDown
		}
		return upsideDown
	}
	if !open {
		return false
	}
	d, _ := stateIntValue(states, "direction")
	if d < 0 || d > 3 {
		return false
	}
	return trapDoorToFacingDirection[d] == face
}

// supportShelfCheck is the shelf block's support test: the opposite-face
// lookup of the direction-to-facing conversion of the block's
// cardinal_direction state == face -- a shelf supports only the face it has its
// back to.
func supportShelfCheck(states map[string]StateValue, face Face) bool {
	f, ok := cardinalDirectionFacing(states)
	if !ok {
		f = FaceSouth // the cardinal-direction enum's default 0 = south
	}
	return OppositeFace[f] == face
}

// supportSkullCheck is the skull block's support test:
// face == DOWN, facing_direction == 1 and type in {Center, Any} -- only a
// skull sitting on the floor supports, and only on its underside.
func supportSkullCheck(states map[string]StateValue, face Face) bool {
	if face != FaceDown {
		return false
	}
	d, _ := stateIntValue(states, "facing_direction")
	return d == 1
}

// supportGrindstoneCheck is the grindstone block's support test: face UP
// wants attachment "standing" (0), face DOWN wants "hanging" (1), and a
// horizontal face falls through to the block type default -- which for the
// grindstone's own mask (0) is false. The attachment string-to-index step is
// CONFIRMED (see this file's header), and matches Bedrock's documented value
// order standing/hanging/side/multiple.
func supportGrindstoneCheck(states map[string]StateValue, face Face) bool {
	attachment := 0
	if s, ok := states["attachment"].(string); ok {
		switch s {
		case "standing":
			attachment = 0
		case "hanging":
			attachment = 1
		case "side":
			attachment = 2
		case "multiple":
			attachment = 3
		default:
			return false
		}
	} else if v, ok := stateIntValue(states, "attachment"); ok {
		attachment = v
	}
	switch face {
	case FaceUp:
		return attachment == 0
	case FaceDown:
		return attachment == 1
	}
	return false
}

// supportPistonArmCheck is the piston arm block's support test: read
// facing_direction, keep it as-is when it is already vertical (< 2) and
// otherwise map it through the opposite-face table, then answer
// `that == face`.
func supportPistonArmCheck(states map[string]StateValue, face Face) bool {
	d, _ := stateIntValue(states, "facing_direction")
	if d < 0 || d > 5 {
		return false
	}
	f := Face(d)
	if f >= FaceNorth {
		f = OppositeFace[f]
	}
	return f == face
}
