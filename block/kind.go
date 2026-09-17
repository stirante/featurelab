package block

import "strings"

// Kind is the coarse classification blockColors.ts assigns every block —
// only the branch-relevant "kind" is ported here, not the render colour.
type Kind uint8

const (
	KindSolid Kind = iota
	KindAir
	KindLiquid
	KindPlant
	KindGlass
)

// blockKinds mirrors blockColors.ts's BLOCK_COLORS table (name -> kind
// only; colour dropped, irrelevant to placement logic).
var blockKinds = map[string]Kind{
	"minecraft:air":      KindAir,
	"minecraft:cave_air": KindAir,
	"minecraft:void_air": KindAir,

	"minecraft:water":         KindLiquid,
	"minecraft:flowing_water": KindLiquid,
	"minecraft:lava":          KindLiquid,
	"minecraft:flowing_lava":  KindLiquid,

	"minecraft:stone": KindSolid, "minecraft:granite": KindSolid, "minecraft:polished_granite": KindSolid,
	"minecraft:diorite": KindSolid, "minecraft:polished_diorite": KindSolid, "minecraft:andesite": KindSolid,
	"minecraft:polished_andesite": KindSolid, "minecraft:tuff": KindSolid, "minecraft:calcite": KindSolid,
	"minecraft:deepslate": KindSolid, "minecraft:cobbled_deepslate": KindSolid, "minecraft:polished_deepslate": KindSolid,
	"minecraft:deepslate_bricks": KindSolid, "minecraft:deepslate_tiles": KindSolid,
	"minecraft:cracked_deepslate_bricks": KindSolid, "minecraft:cracked_deepslate_tiles": KindSolid,
	"minecraft:chiseled_deepslate": KindSolid, "minecraft:bedrock": KindSolid, "minecraft:gravel": KindSolid,
	"minecraft:stone_bricks": KindSolid, "minecraft:stonebrick": KindSolid, "minecraft:mossy_stone_bricks": KindSolid,
	"minecraft:cracked_stone_bricks": KindSolid, "minecraft:chiseled_stone_bricks": KindSolid,
	"minecraft:cobblestone": KindSolid, "minecraft:mossy_cobblestone": KindSolid,

	"minecraft:dirt": KindSolid, "minecraft:coarse_dirt": KindSolid, "minecraft:rooted_dirt": KindSolid,
	"minecraft:podzol": KindSolid, "minecraft:mycelium": KindSolid, "minecraft:grass_block": KindSolid,
	"minecraft:grass": KindSolid, "minecraft:sand": KindSolid, "minecraft:red_sand": KindSolid,
	"minecraft:sandstone": KindSolid, "minecraft:red_sandstone": KindSolid, "minecraft:clay": KindSolid,
	"minecraft:mud": KindSolid, "minecraft:packed_mud": KindSolid,

	"minecraft:terracotta": KindSolid, "minecraft:hardened_clay": KindSolid,
	"minecraft:white_terracotta": KindSolid, "minecraft:orange_terracotta": KindSolid,
	"minecraft:magenta_terracotta": KindSolid, "minecraft:light_blue_terracotta": KindSolid,
	"minecraft:yellow_terracotta": KindSolid, "minecraft:lime_terracotta": KindSolid,
	"minecraft:pink_terracotta": KindSolid, "minecraft:gray_terracotta": KindSolid,
	"minecraft:light_gray_terracotta": KindSolid, "minecraft:cyan_terracotta": KindSolid,
	"minecraft:purple_terracotta": KindSolid, "minecraft:blue_terracotta": KindSolid,
	"minecraft:brown_terracotta": KindSolid, "minecraft:green_terracotta": KindSolid,
	"minecraft:red_terracotta": KindSolid, "minecraft:black_terracotta": KindSolid,

	"minecraft:netherrack": KindSolid, "minecraft:basalt": KindSolid, "minecraft:smooth_basalt": KindSolid,
	"minecraft:blackstone": KindSolid, "minecraft:soul_sand": KindSolid, "minecraft:soul_soil": KindSolid,
	"minecraft:magma": KindSolid, "minecraft:nether_bricks": KindSolid, "minecraft:obsidian": KindSolid,
	"minecraft:crying_obsidian": KindSolid,

	"minecraft:end_stone": KindSolid,

	"minecraft:snow": KindSolid, "minecraft:snow_layer": KindSolid, "minecraft:ice": KindSolid,
	"minecraft:packed_ice": KindSolid, "minecraft:blue_ice": KindSolid, "minecraft:powder_snow": KindSolid,

	"minecraft:moss_block": KindSolid, "minecraft:dripstone_block": KindSolid, "minecraft:pointed_dripstone": KindSolid,
	"minecraft:sculk": KindSolid, "minecraft:sculk_vein": KindSolid, "minecraft:sculk_catalyst": KindSolid,
	"minecraft:sculk_sensor": KindSolid, "minecraft:sculk_shrieker": KindSolid,

	"minecraft:amethyst_block": KindSolid, "minecraft:budding_amethyst": KindSolid,
	"minecraft:amethyst_cluster": KindSolid, "minecraft:small_amethyst_bud": KindSolid,
	"minecraft:medium_amethyst_bud": KindSolid, "minecraft:large_amethyst_bud": KindSolid,

	"minecraft:coal_ore": KindSolid, "minecraft:deepslate_coal_ore": KindSolid, "minecraft:iron_ore": KindSolid,
	"minecraft:deepslate_iron_ore": KindSolid, "minecraft:copper_ore": KindSolid, "minecraft:deepslate_copper_ore": KindSolid,
	"minecraft:gold_ore": KindSolid, "minecraft:deepslate_gold_ore": KindSolid, "minecraft:redstone_ore": KindSolid,
	"minecraft:lit_redstone_ore": KindSolid, "minecraft:deepslate_redstone_ore": KindSolid,
	"minecraft:lit_deepslate_redstone_ore": KindSolid, "minecraft:diamond_ore": KindSolid,
	"minecraft:deepslate_diamond_ore": KindSolid, "minecraft:emerald_ore": KindSolid,
	"minecraft:deepslate_emerald_ore": KindSolid, "minecraft:lapis_ore": KindSolid,
	"minecraft:deepslate_lapis_ore": KindSolid, "minecraft:nether_gold_ore": KindSolid,
	"minecraft:quartz_ore": KindSolid, "minecraft:ancient_debris": KindSolid, "minecraft:raw_iron_block": KindSolid,
	"minecraft:raw_copper_block": KindSolid, "minecraft:raw_gold_block": KindSolid,

	"minecraft:oak_log": KindSolid, "minecraft:stripped_oak_log": KindSolid, "minecraft:oak_wood": KindSolid,
	"minecraft:stripped_oak_wood": KindSolid, "minecraft:spruce_log": KindSolid, "minecraft:stripped_spruce_log": KindSolid,
	"minecraft:spruce_wood": KindSolid, "minecraft:stripped_spruce_wood": KindSolid, "minecraft:birch_log": KindSolid,
	"minecraft:stripped_birch_log": KindSolid, "minecraft:birch_wood": KindSolid, "minecraft:stripped_birch_wood": KindSolid,
	"minecraft:jungle_log": KindSolid, "minecraft:stripped_jungle_log": KindSolid, "minecraft:jungle_wood": KindSolid,
	"minecraft:stripped_jungle_wood": KindSolid, "minecraft:acacia_log": KindSolid, "minecraft:stripped_acacia_log": KindSolid,
	"minecraft:acacia_wood": KindSolid, "minecraft:stripped_acacia_wood": KindSolid, "minecraft:dark_oak_log": KindSolid,
	"minecraft:stripped_dark_oak_log": KindSolid, "minecraft:dark_oak_wood": KindSolid, "minecraft:stripped_dark_oak_wood": KindSolid,
	"minecraft:mangrove_log": KindSolid, "minecraft:stripped_mangrove_log": KindSolid, "minecraft:mangrove_wood": KindSolid,
	"minecraft:stripped_mangrove_wood": KindSolid, "minecraft:cherry_log": KindSolid, "minecraft:stripped_cherry_log": KindSolid,
	"minecraft:cherry_wood": KindSolid, "minecraft:stripped_cherry_wood": KindSolid, "minecraft:pale_oak_log": KindSolid,
	"minecraft:stripped_pale_oak_log": KindSolid, "minecraft:pale_oak_wood": KindSolid, "minecraft:stripped_pale_oak_wood": KindSolid,
	"minecraft:crimson_stem": KindSolid, "minecraft:stripped_crimson_stem": KindSolid, "minecraft:crimson_hyphae": KindSolid,
	"minecraft:stripped_crimson_hyphae": KindSolid, "minecraft:warped_stem": KindSolid, "minecraft:stripped_warped_stem": KindSolid,
	"minecraft:warped_hyphae": KindSolid, "minecraft:stripped_warped_hyphae": KindSolid,

	"minecraft:oak_planks": KindSolid, "minecraft:spruce_planks": KindSolid, "minecraft:birch_planks": KindSolid,
	"minecraft:jungle_planks": KindSolid, "minecraft:acacia_planks": KindSolid, "minecraft:dark_oak_planks": KindSolid,
	"minecraft:mangrove_planks": KindSolid, "minecraft:cherry_planks": KindSolid, "minecraft:pale_oak_planks": KindSolid,
	"minecraft:crimson_planks": KindSolid, "minecraft:warped_planks": KindSolid,

	"minecraft:oak_leaves": KindPlant, "minecraft:spruce_leaves": KindPlant, "minecraft:birch_leaves": KindPlant,
	"minecraft:jungle_leaves": KindPlant, "minecraft:acacia_leaves": KindPlant, "minecraft:dark_oak_leaves": KindPlant,
	"minecraft:mangrove_leaves": KindPlant, "minecraft:cherry_leaves": KindPlant, "minecraft:pale_oak_leaves": KindPlant,
	"minecraft:azalea_leaves": KindPlant, "minecraft:azalea_leaves_flowered": KindPlant,

	"minecraft:short_grass": KindPlant, "minecraft:tall_grass": KindPlant, "minecraft:fern": KindPlant,
	"minecraft:large_fern": KindPlant, "minecraft:deadbush": KindPlant, "minecraft:dead_bush": KindPlant,
	"minecraft:cactus": KindPlant, "minecraft:reeds": KindPlant, "minecraft:sugar_cane": KindPlant,
	"minecraft:bamboo": KindPlant, "minecraft:vine": KindPlant, "minecraft:glow_lichen": KindPlant,
	"minecraft:moss_carpet": KindPlant, "minecraft:hanging_roots": KindPlant, "minecraft:big_dripleaf": KindPlant,
	"minecraft:small_dripleaf": KindPlant, "minecraft:spore_blossom": KindPlant, "minecraft:kelp": KindPlant,
	"minecraft:kelp_plant": KindPlant, "minecraft:seagrass": KindPlant, "minecraft:sea_pickle": KindPlant,
	"minecraft:pumpkin": KindSolid, "minecraft:carved_pumpkin": KindSolid, "minecraft:lit_pumpkin": KindSolid,
	"minecraft:melon_block": KindSolid, "minecraft:waterlily": KindPlant, "minecraft:lily_pad": KindPlant,
	"minecraft:wheat": KindPlant, "minecraft:nether_wart": KindPlant, "minecraft:twisting_vines": KindPlant,
	"minecraft:weeping_vines": KindPlant, "minecraft:crimson_roots": KindPlant, "minecraft:warped_roots": KindPlant,
	"minecraft:nether_sprouts": KindPlant, "minecraft:crimson_fungus": KindPlant, "minecraft:warped_fungus": KindPlant,
	"minecraft:shroomlight": KindSolid, "minecraft:brown_mushroom": KindPlant, "minecraft:red_mushroom": KindPlant,
	"minecraft:brown_mushroom_block": KindSolid, "minecraft:red_mushroom_block": KindSolid, "minecraft:firefly_bush": KindPlant,

	"minecraft:poppy": KindPlant, "minecraft:blue_orchid": KindPlant, "minecraft:allium": KindPlant,
	"minecraft:azure_bluet": KindPlant, "minecraft:red_tulip": KindPlant, "minecraft:orange_tulip": KindPlant,
	"minecraft:white_tulip": KindPlant, "minecraft:pink_tulip": KindPlant, "minecraft:oxeye_daisy": KindPlant,
	"minecraft:cornflower": KindPlant, "minecraft:lily_of_the_valley": KindPlant, "minecraft:dandelion": KindPlant,
	"minecraft:sunflower": KindPlant, "minecraft:lilac": KindPlant, "minecraft:rose_bush": KindPlant,
	"minecraft:peony": KindPlant, "minecraft:torchflower": KindPlant, "minecraft:pitcher_plant": KindPlant,
	"minecraft:wither_rose": KindPlant, "minecraft:pink_petals": KindPlant,

	"minecraft:chest": KindSolid, "minecraft:spawner": KindSolid, "minecraft:mob_spawner": KindSolid,
	"minecraft:glowstone": KindSolid, "minecraft:torch": KindSolid, "minecraft:soul_torch": KindSolid,
	"minecraft:fire": KindSolid, "minecraft:soul_fire": KindSolid, "minecraft:web": KindSolid,
	"minecraft:cobweb": KindSolid, "minecraft:infested_stone": KindSolid, "minecraft:infested_cobblestone": KindSolid,
	"minecraft:infested_stone_bricks": KindSolid, "minecraft:infested_mossy_stone_bricks": KindSolid,
	"minecraft:infested_cracked_stone_bricks": KindSolid, "minecraft:infested_chiseled_stone_bricks": KindSolid,
	"minecraft:infested_deepslate": KindSolid, "minecraft:structure_void": KindSolid,

	"minecraft:glass": KindGlass, "minecraft:white_stained_glass": KindGlass, "minecraft:orange_stained_glass": KindGlass,
	"minecraft:magenta_stained_glass": KindGlass, "minecraft:light_blue_stained_glass": KindGlass,
	"minecraft:yellow_stained_glass": KindGlass, "minecraft:lime_stained_glass": KindGlass,
	"minecraft:pink_stained_glass": KindGlass, "minecraft:gray_stained_glass": KindGlass,
	"minecraft:light_gray_stained_glass": KindGlass, "minecraft:cyan_stained_glass": KindGlass,
	"minecraft:purple_stained_glass": KindGlass, "minecraft:blue_stained_glass": KindGlass,
	"minecraft:brown_stained_glass": KindGlass, "minecraft:green_stained_glass": KindGlass,
	"minecraft:red_stained_glass": KindGlass, "minecraft:black_stained_glass": KindGlass,
}

func stateString(states map[string]StateValue, key string) (string, bool) {
	if states == nil {
		return "", false
	}
	v, ok := states[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

var redFlowerTypeToID = map[string]string{
	"poppy": "minecraft:poppy", "orchid": "minecraft:blue_orchid", "allium": "minecraft:allium",
	"houstonia": "minecraft:azure_bluet", "tulip_red": "minecraft:red_tulip", "tulip_orange": "minecraft:orange_tulip",
	"tulip_white": "minecraft:white_tulip", "tulip_pink": "minecraft:pink_tulip", "oxeye": "minecraft:oxeye_daisy",
	"cornflower": "minecraft:cornflower", "lily_of_the_valley": "minecraft:lily_of_the_valley",
}

var doublePlantTypeToID = map[string]string{
	"sunflower": "minecraft:sunflower", "syringa": "minecraft:lilac", "grass": "minecraft:tall_grass",
	"fern": "minecraft:large_fern", "rose": "minecraft:rose_bush", "paeonia": "minecraft:peony",
}

// classify mirrors blockColors.ts's blockAppearance, kind-only: legacy
// aggregate ids (log/log2/leaves/leaves2/red_flower/yellow_flower/
// double_plant/tallgrass) resolve via their state, everything else is a
// direct BLOCK_COLORS lookup, falling back to "solid" for unknown ids
// (matches fallbackAppearance's kind).
func classify(canonical string, states map[string]StateValue) Kind {
	switch canonical {
	case "minecraft:log":
		t, _ := stateString(states, "old_log_type")
		if t == "" {
			t = "oak"
		}
		if k, ok := blockKinds["minecraft:"+t+"_log"]; ok {
			return k
		}
		return KindSolid
	case "minecraft:log2":
		t, _ := stateString(states, "new_log_type")
		if t == "" {
			t = "acacia"
		}
		if k, ok := blockKinds["minecraft:"+t+"_log"]; ok {
			return k
		}
		return KindSolid
	case "minecraft:leaves":
		t, _ := stateString(states, "old_leaf_type")
		if t == "" {
			t = "oak"
		}
		if k, ok := blockKinds["minecraft:"+t+"_leaves"]; ok {
			return k
		}
		return KindPlant
	case "minecraft:leaves2":
		t, _ := stateString(states, "new_leaf_type")
		if t == "" {
			t = "acacia"
		}
		if k, ok := blockKinds["minecraft:"+t+"_leaves"]; ok {
			return k
		}
		return KindPlant
	case "minecraft:red_flower":
		t, _ := stateString(states, "flower_type")
		if t == "" {
			t = "poppy"
		}
		id, ok := redFlowerTypeToID[t]
		if !ok {
			id = "minecraft:poppy"
		}
		return blockKinds[id]
	case "minecraft:yellow_flower":
		return blockKinds["minecraft:dandelion"]
	case "minecraft:double_plant":
		t, _ := stateString(states, "double_plant_type")
		if t == "" {
			t = "grass"
		}
		id, ok := doublePlantTypeToID[t]
		if !ok {
			id = "minecraft:tall_grass"
		}
		return blockKinds[id]
	case "minecraft:tallgrass":
		t, _ := stateString(states, "tall_grass_type")
		switch t {
		case "tall":
			return blockKinds["minecraft:tall_grass"]
		case "fern":
			return blockKinds["minecraft:fern"]
		default:
			return blockKinds["minecraft:short_grass"]
		}
	case "minecraft:coral", "minecraft:coral_block", "minecraft:coral_fan", "minecraft:coral_fan_dead",
		"minecraft:coral_fan_hang", "minecraft:coral_fan_hang2", "minecraft:coral_fan_hang3":
		return KindPlant
	}

	if k, ok := blockKinds[canonical]; ok {
		return k
	}
	return KindSolid
}

// IsKnownBlockName reports whether canonical (already minecraft:-prefixed,
// as canonicalName produces) is a block name this tool actually recognizes
// -- either a direct blockKinds entry or one of the legacy aggregate ids
// classify special-cases above. Mirrors blockColors.ts's isKnownBlockName
// exactly. Used by env.InternMaterialSlots to warn (never reject) on a
// typo'd or addon-private material name in a user-editable material slot.
func IsKnownBlockName(canonical string) bool {
	switch canonical {
	case "minecraft:log", "minecraft:log2", "minecraft:leaves", "minecraft:leaves2",
		"minecraft:red_flower", "minecraft:yellow_flower", "minecraft:double_plant", "minecraft:tallgrass",
		"minecraft:coral", "minecraft:coral_block", "minecraft:coral_fan", "minecraft:coral_fan_dead",
		"minecraft:coral_fan_hang", "minecraft:coral_fan_hang2", "minecraft:coral_fan_hang3":
		return true
	}
	_, ok := blockKinds[canonical]
	return ok
}

// motion blocking and solid blocking used to be approximated here, on top of
// the blockKinds render table plus two hand-written exception sets. They are
// no longer approximated and no longer live here: block/motion.go carries the
// vanilla per-block-type table and both predicates, IsMotionBlocking and
// IsSolidBlocking. Kind stays what it always was, a RENDER classification.

// ---------------------------------------------------------------------------
// {tags: "..."} block-descriptor resolution — port of palette.ts's tiny
// any_tag/all_tags parser and its representative-block table.
//
// parseTagCall/resolveTagExpression below back Palette.Resolve, i.e. the
// PRODUCING-position path only (places_block and similar — see Resolve's
// doc comment in block.go). tagRepresentativeBlock itself is also reused,
// read the other way (tag -> is THIS specific candidate the representative
// block?), as tags.go's blockHasTag last-resort fallback for the
// PREDICATE-position path (may_replace and similar) when a tag is neither
// declared by the pack itself nor otherwise known.
//
// EXPLICITLY APPROXIMATE, both uses: this is a small, hand-curated table of
// "one plausible representative block per vanilla tag name", not real
// vanilla tag data (this tool has no copy of the game's vanilla tag
// tables) — e.g. "water" only ever means minecraft:water, never
// minecraft:flowing_water; "stone" only means minecraft:stone, never
// granite/diorite/andesite/deepslate/etc. It is deliberately NOT extended
// into a bigger guess: a vanilla tag this table doesn't cover is diagnosed
// (UnresolvedTags for Resolve; the unknownTag callback for NewMatchSet),
// never silently widened.
// ---------------------------------------------------------------------------

var tagRepresentativeBlock = map[string]string{
	"dirt": "minecraft:dirt", "grass": "minecraft:grass_block", "sand": "minecraft:sand",
	"stone": "minecraft:stone", "water": "minecraft:water", "lava": "minecraft:lava",
	"log": "minecraft:oak_log", "wood": "minecraft:oak_log", "leaves": "minecraft:oak_leaves",
	"ice": "minecraft:ice", "snow": "minecraft:snow", "gravel": "minecraft:gravel",
	"clay": "minecraft:clay", "netherrack": "minecraft:netherrack", "end_stone": "minecraft:end_stone",
}

// parseTagCall recognizes exactly `[!]q(uery)?.(any_tag|all_tags)('a', 'b', ...)`.
func parseTagCall(expr string) (negated, all bool, tags []string, ok bool) {
	s := strings.TrimSpace(expr)
	negated = strings.HasPrefix(s, "!")
	if negated {
		s = strings.TrimSpace(s[1:])
	}
	rest := s
	switch {
	case strings.HasPrefix(rest, "query.any_tag("):
		rest = strings.TrimPrefix(rest, "query.any_tag(")
	case strings.HasPrefix(rest, "q.any_tag("):
		rest = strings.TrimPrefix(rest, "q.any_tag(")
	case strings.HasPrefix(rest, "query.all_tags("):
		all = true
		rest = strings.TrimPrefix(rest, "query.all_tags(")
	case strings.HasPrefix(rest, "q.all_tags("):
		all = true
		rest = strings.TrimPrefix(rest, "q.all_tags(")
	default:
		return false, false, nil, false
	}
	if !strings.HasSuffix(rest, ")") {
		return false, false, nil, false
	}
	rest = rest[:len(rest)-1]
	for _, part := range strings.Split(rest, ",") {
		t := strings.TrimSpace(part)
		t = strings.Trim(t, "'\"")
		t = strings.TrimPrefix(t, "minecraft:")
		if t != "" {
			tags = append(tags, t)
		}
	}
	if len(tags) == 0 {
		return false, false, nil, false
	}
	return negated, all, tags, true
}

func resolveTagExpression(expr string) (string, bool) {
	negated, all, tags, ok := parseTagCall(expr)
	if !ok || negated {
		return "", false
	}
	if all {
		for _, t := range tags {
			if _, ok := tagRepresentativeBlock[t]; !ok {
				return "", false
			}
		}
		return tagRepresentativeBlock[tags[0]], true
	}
	for _, t := range tags {
		if b, ok := tagRepresentativeBlock[t]; ok {
			return b, true
		}
	}
	return "", false
}
