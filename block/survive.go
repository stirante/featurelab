package block

// survive.go answers the two questions minecraft:single_block_feature asks of the
// block it is about to place when enforce_placement_rules / enforce_survivability_rules
// are on: may this block be placed here, and would it survive here. Both are per block
// type in the game, and this file models them by name for the families whose rule is
// known. Everything else is reported as unknown, and callers treat unknown as a pass.
//
// ---- The foliage family ----
//
// Flowers, saplings and the bush share one rule: the block survives only on a block of
// the vegetation-supporting group below it.
//
//	canSurvive(pos)  = mayPlaceOn(below)
//	mayPlaceOn(b)    = b in SupportsVegetation
//	                   (the two nether roots also accept the nether vegetation set)
//	mayPlace(pos)    = cell is not water or lava
//	                   && the block in the cell can be built over
//	                   && mayPlaceOn(below)
//
// SupportsVegetation is exactly the eleven blocks in supportsVegetation below.
//
// Not modelled (reported unknown): the nether vegetation set the roots also accept, so a
// root is known to survive on the eleven but unknown elsewhere; and the families with a
// rule of their own -- tall grass and ferns, double plants, mushrooms, crops, the dead
// bush. The world-height half of mayPlace is not modelled either: the bench has no
// build limit.
//
// "Can be built over" is a per block type property with no registry here. It is
// approximated by air plus the small replaceable plants and snow a worldgen surface
// carries (builtOverNames); a cell holding anything else refuses the placement check.

// supportsVegetation is the vegetation-supporting block group.
var supportsVegetation = map[string]struct{}{
	"minecraft:dirt":                 {},
	"minecraft:grass_block":          {},
	"minecraft:podzol":               {},
	"minecraft:coarse_dirt":          {},
	"minecraft:mycelium":             {},
	"minecraft:dirt_with_roots":      {},
	"minecraft:moss_block":           {},
	"minecraft:pale_moss_block":      {},
	"minecraft:mud":                  {},
	"minecraft:muddy_mangrove_roots": {},
	"minecraft:farmland":             {},
}

type surviveRule uint8

const (
	surviveUnknown surviveRule = iota
	// surviveFoliage: survives iff the block below supports vegetation.
	surviveFoliage
	// surviveFoliageNether: as surviveFoliage, and additionally on the nether
	// vegetation set, which is not modelled (so a miss is unknown, not false).
	surviveFoliageNether
)

var surviveRules = map[string]surviveRule{
	// Flowers.
	"minecraft:dandelion":          surviveFoliage,
	"minecraft:poppy":              surviveFoliage,
	"minecraft:blue_orchid":        surviveFoliage,
	"minecraft:allium":             surviveFoliage,
	"minecraft:azure_bluet":        surviveFoliage,
	"minecraft:red_tulip":          surviveFoliage,
	"minecraft:orange_tulip":       surviveFoliage,
	"minecraft:white_tulip":        surviveFoliage,
	"minecraft:pink_tulip":         surviveFoliage,
	"minecraft:oxeye_daisy":        surviveFoliage,
	"minecraft:cornflower":         surviveFoliage,
	"minecraft:lily_of_the_valley": surviveFoliage,
	// Saplings.
	"minecraft:oak_sapling":      surviveFoliage,
	"minecraft:spruce_sapling":   surviveFoliage,
	"minecraft:birch_sapling":    surviveFoliage,
	"minecraft:jungle_sapling":   surviveFoliage,
	"minecraft:acacia_sapling":   surviveFoliage,
	"minecraft:dark_oak_sapling": surviveFoliage,
	"minecraft:pale_oak_sapling": surviveFoliage,
	"minecraft:cherry_sapling":   surviveFoliage,
	// Bush.
	"minecraft:bush": surviveFoliage,
	// Nether roots.
	"minecraft:crimson_roots": surviveFoliageNether,
	"minecraft:warped_roots":  surviveFoliageNether,
}

// builtOverNames approximates "can be built over" for the placement check; see the
// file header.
var builtOverNames = map[string]struct{}{
	"minecraft:short_grass": {},
	"minecraft:tall_grass":  {},
	"minecraft:fern":        {},
	"minecraft:large_fern":  {},
	"minecraft:deadbush":    {},
	"minecraft:dead_bush":   {},
	"minecraft:vine":        {},
	"minecraft:snow_layer":  {},
	"minecraft:leaf_litter": {},
}

// HasSurviveRule reports whether CanSurvive and MayPlace model the named block's rule
// (at least in part). A caller warns once for a block that has none.
func HasSurviveRule(name string) bool {
	return surviveRules[canonicalName(name)] != surviveUnknown
}

// SupportsVegetation reports whether the named block is in the vegetation-supporting
// group.
func SupportsVegetation(name string) bool {
	_, ok := supportsVegetation[canonicalName(name)]
	return ok
}

func mayPlaceOn(rule surviveRule, below string) (ok, known bool) {
	if SupportsVegetation(below) {
		return true, true
	}
	if rule == surviveFoliageNether {
		return false, false
	}
	return false, true
}

// CanSurvive is the survivability check for placing `name` at a cell whose block below
// is `below`. known is false when the rule for `name` is not modelled, or when it
// depends on a part that is not (then ok is true, and callers should pass).
func CanSurvive(name, below string) (ok, known bool) {
	rule := surviveRules[canonicalName(name)]
	if rule == surviveUnknown {
		return true, false
	}
	ok, known = mayPlaceOn(rule, below)
	if !known {
		return true, false
	}
	return ok, true
}

// MayPlace is the placement check for placing `name` into a cell holding `cell`, with
// `below` under it. cellIsAir must be the palette's own air test for the cell; the
// name-based built-over set covers the rest. Same known convention as CanSurvive.
func MayPlace(name, cell string, cellIsAir bool, below string) (ok, known bool) {
	rule := surviveRules[canonicalName(name)]
	if rule == surviveUnknown {
		return true, false
	}
	switch canonicalName(cell) {
	case "minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava":
		return false, true
	}
	if !cellIsAir {
		if _, ok := builtOverNames[canonicalName(cell)]; !ok {
			return false, true
		}
	}
	return CanSurvive(name, below)
}
