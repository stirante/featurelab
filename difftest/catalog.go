package difftest

import (
	"fmt"
	"strings"
)

// canopyWithoutVariationChance is the ExpectedGameCrash reason for the plain canopies that omit
// variation_chance.
const canopyWithoutVariationChance = "a plain canopy without variation_chance crashes the game when it places a layer " +
	"(it reads one chance per layer); the engine refuses the feature"

// BuildCatalog assembles the whole test pack and its tests. repoRoot is this repository's root;
// the public fixture pack (docs/wiki/tools/fixtures) and the vanilla tree corpus
// (pack/testdata/vanilla-trees) are imported from it.
func BuildCatalog(repoRoot string) (*Catalog, error) {
	b := newBuilder(repoRoot)
	b.packManifest()
	b.shared()
	fx := b.importDir("docs/wiki/tools/fixtures/features", "fx_")
	b.copyFile("docs/wiki/tools/fixtures/structures/wiki/lamp_post.mcstructure", "structures/wiki/lamp_post.mcstructure")
	vt := b.importDir("pack/testdata/vanilla-trees/features", "vt_")

	b.trees(fx, vt)
	b.scatters(fx)
	b.snaps(fx)
	b.searches(fx)
	b.composites(fx)
	b.surfaceFilters(fx)
	b.ores(fx)
	b.singleBlocks(fx)
	b.vegetation(fx)
	b.caveDecor(fx)
	b.blobs(fx)
	b.carvers(fx)
	b.structuresAndFossils(fx)
	b.newTypes(fx)
	b.anchorRules()

	if len(b.errs) > 0 {
		return nil, fmt.Errorf("catalog errors:\n  %s", strings.Join(b.errs, "\n  "))
	}
	Layout(b.cat.Tests)
	return b.cat, nil
}

func (b *builder) packManifest() {
	b.raw("manifest.json", `{
	  "format_version": 2,
	  "header": {
	    "name": "featurelab difftest",
	    "description": "Feature placement differential tests (development only).",
	    "uuid": "6f1d2c1e-3b8a-4f55-9d2e-8a1f0c7d4b21",
	    "version": [1, 0, 0],
	    "min_engine_version": [1, 26, 50]
	  },
	  "modules": [
	    { "type": "data", "uuid": "a7c3e9f2-51d4-4b0e-8c6a-2e9f7b1d3c58", "version": [1, 0, 0] }
	  ]
	}`)
}

// shared defines the small leaf features several composite tests delegate to.
func (b *builder) shared() {
	b.feature("single_block_feature", "blk_gold", `{
	  "enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:gold_block", "may_replace": ["minecraft:air"]}`)
	b.feature("single_block_feature", "blk_gold_on_grass", `{
	  "enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:gold_block", "may_replace": ["minecraft:air"],
	  "may_attach_to": {"bottom": "minecraft:grass_block"}}`)
	b.feature("single_block_feature", "blk_emerald", `{
	  "enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:emerald_block", "may_replace": ["minecraft:air"]}`)
	b.feature("single_block_feature", "blk_fail", `{
	  "enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:diamond_block", "may_replace": ["minecraft:bedrock"]}`)
	b.feature("single_block_feature", "blk_poppy", `{
	  "enforce_placement_rules": true, "enforce_survivability_rules": true,
	  "places_block": "minecraft:poppy", "may_replace": ["minecraft:air"]}`)
}

// ---------------------------------------------------------------------------------------------
// minecraft:tree_feature

func (b *builder) trees(fx, vt map[string]string) {
	// Every vanilla tree in the public corpus (every trunk/canopy the game itself ships except
	// cherry, mangrove and azalea, which are written out below).
	for _, old := range SortedKeys(vt) {
		id := vt[old]
		name := strings.TrimPrefix(id, Namespace+":")
		b.test(Test{ID: name, Type: "minecraft:tree_feature", FeatureID: id, Group: "tree/vanilla",
			Source: "pack/testdata/vanilla-trees", Region: regionTree, Metrics: treeMetrics})
	}
	for _, old := range []string{"wiki:acacia_branching_tree", "wiki:fancy_oak_tree", "wiki:plain_trunk_tree", "wiki:poplar_tree"} {
		id := fx[old]
		b.test(Test{ID: strings.TrimPrefix(id, Namespace+":"), Type: "minecraft:tree_feature", FeatureID: id,
			Group: "tree/fixture", Source: "docs/wiki/tools/fixtures", Region: regionTree, Metrics: treeMetrics})
	}

	// canopy_slope: the run multiplies and the rise divides. Four ratios, one of them 1:1.
	// These four, tree_trunk_decoration_sequence and tree_submerged grow a plain canopy with no
	// variation_chance, which crashes the game; they are kept as crash repros and marked.
	for _, s := range []struct{ rise, run int }{{1, 2}, {2, 1}, {1, 1}, {3, 2}} {
		name := fmt.Sprintf("tree_slope_rise%d_run%d", s.rise, s.run)
		b.feature("tree_feature", name, fmt.Sprintf(`{
		  "trunk": {"trunk_height": {"range_min": 5, "range_max": 7}, "trunk_block": "minecraft:oak_log"},
		  "canopy": {"canopy_offset": {"min": -3, "max": 0}, "min_width": 1,
		             "canopy_slope": {"rise": %d, "run": %d}, "leaf_block": "minecraft:oak_leaves"},
		  "base_block": ["minecraft:dirt"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block"],
		  "may_replace": ["minecraft:air", "minecraft:oak_leaves"],
		  "may_grow_through": ["minecraft:air", "minecraft:grass_block", "minecraft:dirt"]}`, s.rise, s.run))
		b.test(Test{ID: name, Type: "minecraft:tree_feature", Group: "tree/canopy_slope", Region: regionTree,
			Metrics:           append([]string{"leafExtent[+0]", "leafExtent[+4]", "leafExtent[+6]"}, treeMetrics...),
			Note:              fmt.Sprintf("canopy_slope rise=%d run=%d over canopy_offset -3..0, min_width 1", s.rise, s.run),
			ExpectedGameCrash: canopyWithoutVariationChance})
	}
	// canopy with variation_chance and a canopy decoration (vines hanging off it).
	b.feature("tree_feature", "tree_canopy_decorated", `{
	  "trunk": {"trunk_height": {"range_min": 5, "range_max": 8}, "trunk_block": "minecraft:jungle_log",
	            "trunk_decoration": {"decoration_block": "minecraft:vine", "decoration_chance": {"numerator": 1, "denominator": 2}}},
	  "canopy": {"canopy_offset": {"min": -3, "max": 1}, "min_width": 0, "leaf_block": "minecraft:jungle_leaves",
	             "variation_chance": [{"numerator": 1, "denominator": 2}, {"numerator": 1, "denominator": 3},
	                                  {"numerator": 1, "denominator": 4}, {"numerator": 1, "denominator": 1}, {"numerator": 1, "denominator": 1}],
	             "canopy_decoration": {"decoration_block": "minecraft:vine", "decoration_chance": {"numerator": 1, "denominator": 4},
	                                   "num_steps": 3, "step_direction": "down"}},
	  "base_block": ["minecraft:dirt"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block"],
	  "may_replace": ["minecraft:air", "minecraft:jungle_leaves", "minecraft:vine"],
	  "may_grow_through": ["minecraft:air", "minecraft:grass_block", "minecraft:dirt"]}`)
	b.test(Test{ID: "tree_canopy_decorated", Type: "minecraft:tree_feature", Group: "tree/decoration", Region: regionTree,
		Metrics: append([]string{"block:minecraft:vine"}, treeMetrics...)})
	// trunk decoration with a block sequence stepping outward.
	b.feature("tree_feature", "tree_trunk_decoration_sequence", `{
	  "trunk": {"trunk_height": {"range_min": 6, "range_max": 9}, "trunk_block": "minecraft:dark_oak_log",
	            "trunk_decoration": {"decoration_chance": {"numerator": 1, "denominator": 2},
	                                 "decoration_blocks_sequence": [{"block": "minecraft:glow_lichen", "count": {"range_min": 1, "range_max": 2}},
	                                                                {"block": "minecraft:vine", "count": 1}],
	                                 "num_steps": 2, "step_direction": "down"}},
	  "canopy": {"canopy_offset": {"min": -2, "max": 0}, "leaf_block": "minecraft:dark_oak_leaves"},
	  "base_block": ["minecraft:dirt"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block"],
	  "may_replace": ["minecraft:air", "minecraft:dark_oak_leaves"],
	  "may_grow_through": ["minecraft:air", "minecraft:grass_block", "minecraft:dirt"]}`)
	b.test(Test{ID: "tree_trunk_decoration_sequence", Type: "minecraft:tree_feature", Group: "tree/decoration", Region: regionTree,
		Metrics:           append([]string{"block:minecraft:vine", "block:minecraft:glow_lichen"}, treeMetrics...),
		ExpectedGameCrash: canopyWithoutVariationChance})
	// can_be_submerged: a trunk standing in a water pool.
	b.feature("tree_feature", "tree_submerged", `{
	  "trunk": {"trunk_height": {"range_min": 5, "range_max": 8}, "trunk_block": "minecraft:oak_log", "can_be_submerged": {"max_depth": 2}},
	  "canopy": {"canopy_offset": {"min": -3, "max": 0}, "min_width": 1, "canopy_slope": {"rise": 2, "run": 1}, "leaf_block": "minecraft:oak_leaves"},
	  "base_block": ["minecraft:dirt"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block"],
	  "may_replace": ["minecraft:air", "minecraft:oak_leaves", "minecraft:water"],
	  "may_grow_through": ["minecraft:air", "minecraft:water", "minecraft:grass_block", "minecraft:dirt"]}`)
	b.test(Test{ID: "tree_submerged", Type: "minecraft:tree_feature", Group: "tree/submerged", Region: regionTree,
		Setup: []Op{fill(box(-5, -2, -5, 5, -1, 5), "minecraft:water"), fill(box(-5, -3, -5, 5, -3, 5), "minecraft:dirt")},
		Place: [3]int{0, -2, 0}, Metrics: treeMetrics,
		Note:              "origin on the pool floor under two blocks of water",
		ExpectedGameCrash: canopyWithoutVariationChance})
	// base_cluster (the podzol ring mega spruces make).
	b.feature("tree_feature", "tree_base_cluster", `{
	  "trunk": {"trunk_height": {"range_min": 6, "range_max": 9}, "trunk_block": "minecraft:spruce_log"},
	  "spruce_canopy": {"lower_offset": {"range_min": 1, "range_max": 3}, "upper_offset": {"range_min": 0, "range_max": 3},
	                    "max_radius": {"range_min": 2, "range_max": 4}, "leaf_block": "minecraft:spruce_leaves"},
	  "base_block": ["minecraft:dirt"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block", "minecraft:podzol"],
	  "base_cluster": {"may_replace": ["minecraft:grass_block", "minecraft:dirt"], "num_clusters": 5, "cluster_radius": 2},
	  "may_replace": ["minecraft:air", "minecraft:spruce_leaves"],
	  "may_grow_through": ["minecraft:air", "minecraft:grass_block", "minecraft:dirt"]}`)
	b.test(Test{ID: "tree_base_cluster", Type: "minecraft:tree_feature", Group: "tree/base_cluster", Region: regionTree,
		Metrics: append([]string{"block:minecraft:dirt", "replaced"}, treeMetrics...),
		Note:    "base_cluster turns the grass around the trunk into dirt"})

	// cherry_trunk: the tips grow the TOP-LEVEL cherry_canopy; branches.branch_canopy is never grown.
	cherryTrunk := func(weights string) string {
		return fmt.Sprintf(`"cherry_trunk": {"trunk_block": "minecraft:cherry_log",
		  "trunk_height": {"base": 7, "intervals": [1, 1]},
		  "branches": {"tree_type_weights": %s,
		               "branch_horizontal_length": {"range_min": 2, "range_max": 4},
		               "branch_start_offset_from_top": {"range_min": -4, "range_max": -3},
		               "branch_end_offset_from_top": {"range_min": -1, "range_max": 1}%%s}}`, weights)
	}
	cherryCanopy := func(leaf string) string {
		return fmt.Sprintf(`{"leaf_block": %q, "height": 5, "radius": 4,
		  "wide_bottom_layer_hole_chance": 0.25, "corner_hole_chance": 0.25,
		  "hanging_leaves_chance": 0.1666667, "hanging_leaves_extension_chance": 0.3333333}`, leaf)
	}
	tail := `"base_block": ["minecraft:dirt"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block"],
	  "may_replace": ["minecraft:air", "minecraft:cherry_leaves", "minecraft:azalea_leaves"],
	  "may_grow_through": ["minecraft:air", "minecraft:grass_block", "minecraft:dirt"]`
	vanillaWeights := `{"one_branch": 1, "two_branches": 1, "two_branches_and_trunk": 1}`
	cherry := []struct {
		name, weights, branch, top, note string
	}{
		{"tree_cherry_top_canopy", vanillaWeights, "", cherryCanopy("minecraft:cherry_leaves"),
			"vanilla shape: canopy at the top level, beside cherry_trunk"},
		{"tree_cherry_branch_canopy_only", vanillaWeights, cherryCanopy("minecraft:cherry_leaves"), "",
			"canopy only inside branches.branch_canopy: the game grows bare branches"},
		{"tree_cherry_both_canopies", vanillaWeights, cherryCanopy("minecraft:azalea_leaves"), cherryCanopy("minecraft:cherry_leaves"),
			"both present with different leaves: only the top-level (cherry_leaves) one grows"},
		{"tree_cherry_one_branch", `{"one_branch": 1, "two_branches": 0, "two_branches_and_trunk": 0}`, "", cherryCanopy("minecraft:cherry_leaves"), ""},
		{"tree_cherry_two_branches", `{"one_branch": 0, "two_branches": 1, "two_branches_and_trunk": 0}`, "", cherryCanopy("minecraft:cherry_leaves"), ""},
		{"tree_cherry_two_branches_and_trunk", `{"one_branch": 0, "two_branches": 0, "two_branches_and_trunk": 1}`, "", cherryCanopy("minecraft:cherry_leaves"), ""},
	}
	for _, c := range cherry {
		branch := ""
		if c.branch != "" {
			branch = `, "branch_canopy": {"cherry_canopy": ` + c.branch + `}`
		}
		body := "{" + fmt.Sprintf(cherryTrunk(c.weights), branch)
		if c.top != "" {
			body += `, "cherry_canopy": ` + c.top
		}
		body += ", " + tail + "}"
		b.feature("tree_feature", c.name, body)
		b.test(Test{ID: c.name, Type: "minecraft:tree_feature", Group: "tree/cherry", Region: regionTree, Note: c.note,
			Metrics: append([]string{"block:minecraft:cherry_leaves", "block:minecraft:azalea_leaves", "block:minecraft:cherry_log"}, treeMetrics...)})
	}

	// mangrove: trunk with branches, the mangrove canopy with hanging propagule-roots, and roots.
	b.feature("tree_feature", "tree_mangrove", `{
	  "mangrove_trunk": {"trunk_width": 1, "trunk_block": "minecraft:mangrove_log",
	                     "trunk_height": {"base": 2, "height_rand_a": 1, "height_rand_b": 4},
	                     "branches": {"branch_length": {"range_min": 1, "range_max": 4}, "branch_steps": {"range_min": 2, "range_max": 5},
	                                  "branch_chance": {"numerator": 1, "denominator": 2}}},
	  "mangrove_canopy": {"canopy_height": {"range_min": 2, "range_max": 4}, "canopy_radius": {"range_min": 3, "range_max": 5},
	                      "leaf_placement_attempts": 70, "leaf_blocks": [["minecraft:mangrove_leaves", 1.0]],
	                      "hanging_block": "minecraft:mangrove_propagule", "hanging_block_placement_chance": 14},
	  "mangrove_roots": {"max_root_width": 8, "max_root_length": 15, "y_offset": {"range_min": 1, "range_max": 4},
	                     "root_block": "minecraft:mangrove_roots", "muddy_root_block": "minecraft:muddy_mangrove_roots",
	                     "mud_block": "minecraft:mud",
	                     "roots_may_grow_through": ["minecraft:air", "minecraft:water", "minecraft:grass_block", "minecraft:dirt", "minecraft:mud",
	                                                "minecraft:mangrove_roots", "minecraft:mangrove_leaves", "minecraft:mangrove_propagule"],
	                     "above_root": {"above_root_chance": 0.5, "above_root_block": "minecraft:moss_carpet"}},
	  "base_block": ["minecraft:mud"], "may_grow_on": ["minecraft:mud", "minecraft:dirt", "minecraft:grass_block", "minecraft:mangrove_roots", "minecraft:muddy_mangrove_roots"],
	  "may_replace": ["minecraft:air", "minecraft:water", "minecraft:mangrove_leaves", "minecraft:mangrove_roots", "minecraft:mangrove_propagule", "minecraft:moss_carpet"],
	  "may_grow_through": ["minecraft:air", "minecraft:water", "minecraft:grass_block", "minecraft:dirt", "minecraft:mud", "minecraft:mangrove_roots"]}`)
	b.test(Test{ID: "tree_mangrove", Type: "minecraft:tree_feature", Group: "tree/mangrove", Region: regionTree,
		Metrics: append([]string{"block:minecraft:mangrove_roots", "block:minecraft:mangrove_leaves", "block:minecraft:mangrove_propagule"}, treeMetrics...)})
	// azalea: acacia trunk with a random_spread_canopy of two leaf kinds.
	b.feature("tree_feature", "tree_azalea", `{
	  "acacia_trunk": {"trunk_width": 1, "trunk_block": "minecraft:oak_log",
	                   "trunk_height": {"base": 4, "intervals": [2], "min_height_for_canopy": 3},
	                   "trunk_lean": {"allow_diagonal_growth": true, "lean_height": {"range_min": 2, "range_max": 3},
	                                  "lean_steps": {"range_min": 3, "range_max": 4}, "lean_length": {"range_min": 1, "range_max": 2}}},
	  "random_spread_canopy": {"canopy_height": 2, "canopy_radius": 3, "leaf_placement_attempts": 50,
	                           "leaf_blocks": [["minecraft:azalea_leaves", 3], ["minecraft:azalea_leaves_flowered", 1]]},
	  "base_block": ["minecraft:dirt_with_roots"], "may_grow_on": ["minecraft:dirt", "minecraft:grass_block"],
	  "may_replace": ["minecraft:air", "minecraft:azalea_leaves", "minecraft:azalea_leaves_flowered"],
	  "may_grow_through": ["minecraft:air", "minecraft:grass_block", "minecraft:dirt"]}`)
	b.test(Test{ID: "tree_azalea", Type: "minecraft:tree_feature", Group: "tree/azalea", Region: regionTree,
		Metrics: append([]string{"block:minecraft:azalea_leaves", "block:minecraft:azalea_leaves_flowered"}, treeMetrics...)})
}

// ---------------------------------------------------------------------------------------------
// minecraft:scatter_feature

func (b *builder) scatters(fx map[string]string) {
	add := func(name, dist, note string, setup []Op, place [3]int) {
		b.feature("scatter_feature", name, `{"places_feature": "difftest:blk_gold", "distribution": `+dist+`}`)
		b.test(Test{ID: name, Type: "minecraft:scatter_feature", Group: "scatter", Region: regionScatter,
			Metrics: append([]string{"block:minecraft:gold_block"}, scatterMetrics...), Note: note, Setup: setup, Place: place})
	}
	u := func(lo, hi int) string {
		return fmt.Sprintf(`{"distribution": "uniform", "extent": [%d, %d]}`, lo, hi)
	}
	for _, d := range []string{"uniform", "gaussian", "inverse_gaussian", "triangle"} {
		add("scatter_dist_"+d, fmt.Sprintf(`{"iterations": 24, "x": {"distribution": %q, "extent": [-10, 10]}, "y": {"distribution": %q, "extent": [0, 8]}, "z": {"distribution": %q, "extent": [-10, 10]}}`, d, d, d),
			d+" on all three axes", nil, [3]int{})
	}
	add("scatter_fixed_grid", `{"iterations": 49, "x": {"distribution": "fixed_grid", "extent": [-6, 6], "step_size": 2}, "y": 0, "z": {"distribution": "fixed_grid", "extent": [-6, 6], "step_size": 2}}`,
		"fixed_grid with step_size 2", nil, [3]int{})
	add("scatter_fixed_grid_offset", `{"iterations": 30, "x": {"distribution": "fixed_grid", "extent": [-8, 8], "step_size": 3, "grid_offset": 1}, "y": 0, "z": {"distribution": "fixed_grid", "extent": [-4, 4], "step_size": 2, "grid_offset": 2}}`,
		"fixed_grid with grid_offset", nil, [3]int{})
	add("scatter_jittered_grid", `{"iterations": 36, "x": {"distribution": "jittered_grid", "extent": [-9, 9], "step_size": 3}, "y": 0, "z": {"distribution": "jittered_grid", "extent": [-9, 9], "step_size": 3, "grid_offset": 1}}`,
		"jittered_grid", nil, [3]int{})
	for _, order := range []string{"xyz", "xzy", "yxz", "yzx", "zxy", "zyx"} {
		add("scatter_order_"+order, fmt.Sprintf(`{"iterations": 16, "coordinate_eval_order": %q, "x": %s, "y": %s, "z": {"distribution": "fixed_grid", "extent": [-6, 6], "step_size": 3}}`, order, u(-6, 6), u(0, 6)),
			"coordinate_eval_order "+order+" (mixes a grid axis with two random axes, so the order is visible)", nil, [3]int{})
	}
	add("scatter_iterations_molang", `{"iterations": "math.random_integer(1, 16)", "x": `+u(-8, 8)+`, "y": 0, "z": `+u(-8, 8)+`}`,
		"iterations drawn by Molang per placement", nil, [3]int{})
	add("scatter_iterations_zero", `{"iterations": 0, "x": `+u(-8, 8)+`, "y": 0, "z": `+u(-8, 8)+`}`,
		"iterations 0 places nothing", nil, [3]int{})
	add("scatter_chance_percent", `{"iterations": 30, "scatter_chance": 30, "x": `+u(-8, 8)+`, "y": 0, "z": `+u(-8, 8)+`}`,
		"scatter_chance 30 is a percent", nil, [3]int{})
	add("scatter_chance_fraction", `{"iterations": 30, "scatter_chance": {"numerator": 1, "denominator": 4}, "x": `+u(-8, 8)+`, "y": 0, "z": `+u(-8, 8)+`}`,
		"scatter_chance as a fraction", nil, [3]int{})
	add("scatter_chance_molang", `{"iterations": 30, "scatter_chance": "math.random(10, 60)", "x": `+u(-8, 8)+`, "y": 0, "z": `+u(-8, 8)+`}`,
		"scatter_chance as a Molang expression", nil, [3]int{})
	add("scatter_y_heightmap", `{"iterations": 40, "x": `+u(-10, 10)+`, "y": "q.heightmap(v.worldx, v.worldz) - v.originy", "z": `+u(-10, 10)+`}`,
		"y from query.heightmap over a stepped stone mound",
		[]Op{fill(box(-6, 0, -6, 6, 1, 6), "minecraft:stone"), fill(box(-3, 2, -3, 3, 4, 3), "minecraft:stone")}, [3]int{})
	add("scatter_x_molang", `{"iterations": 20, "x": "math.random_integer(-8, 8) * 1", "y": "v.worldx > v.originx ? 2 : 0", "z": `+u(-8, 8)+`}`,
		"x and y as Molang expressions reading variable.worldx/originx", nil, [3]int{})
	// project_input_to_floor is a top-level key, not part of distribution.
	b.feature("scatter_feature", "scatter_project_floor", `{"places_feature": "difftest:blk_gold", "project_input_to_floor": true,
	  "distribution": {"iterations": 24, "x": `+u(-8, 8)+`, "y": 0, "z": `+u(-8, 8)+`}}`)
	b.test(Test{ID: "scatter_project_floor", Type: "minecraft:scatter_feature", Group: "scatter", Region: regionScatter,
		Place:   [3]int{0, 8, 0},
		Setup:   []Op{fill(box(-4, 0, -4, 4, 2, 4), "minecraft:stone")},
		Metrics: append([]string{"block:minecraft:gold_block", "bbox.minY", "bbox.maxY"}, scatterMetrics...),
		Note:    "project_input_to_floor from 8 blocks up, over a stone block in the middle"})
	b.featureFV("1.20.0", "scatter_feature", "scatter_legacy_flat", `{"places_feature": "difftest:blk_gold",
	  "iterations": 12, "scatter_chance": 50, "x": `+u(-7, 7)+`, "y": 0, "z": `+u(-7, 7)+`}`)
	b.test(Test{ID: "scatter_legacy_flat", Type: "minecraft:scatter_feature", Group: "scatter", Region: regionScatter,
		Metrics: scatterMetrics, Note: "pre-1.21.10 flat iterations/scatter_chance/x/y/z"})
	b.feature("scatter_feature", "scatter_nested_inner", `{"places_feature": "difftest:blk_gold",
	  "distribution": {"iterations": 4, "x": `+u(-2, 2)+`, "y": `+u(0, 3)+`, "z": `+u(-2, 2)+`}}`)
	b.feature("scatter_feature", "scatter_nested", `{"places_feature": "difftest:scatter_nested_inner",
	  "distribution": {"iterations": 5, "x": `+u(-12, 12)+`, "y": 0, "z": `+u(-12, 12)+`}}`)
	b.test(Test{ID: "scatter_nested", Type: "minecraft:scatter_feature", Group: "scatter", Region: regionScatter,
		Metrics: scatterMetrics, Note: "scatter of scatter: clusters of up to four"})
	for _, old := range []string{"wiki:pumpkin_patch", "wiki:rng_scatter_bare", "wiki:rng_scatter_degenerate", "wiki:rng_scatter_nondegenerate",
		"wiki:rng_scatter_evalorder_default", "wiki:rng_scatter_evalorder_xyz", "wiki:fallen_log_run"} {
		id := fx[old]
		b.test(Test{ID: strings.TrimPrefix(id, Namespace+":"), FeatureID: id, Type: "minecraft:scatter_feature", Group: "scatter/fixture",
			Source: "docs/wiki/tools/fixtures", Region: box(-12, -4, -12, 24, 16, 24), Metrics: scatterMetrics})
	}
}

// ---------------------------------------------------------------------------------------------
// minecraft:snap_to_surface_feature and minecraft:search_feature

func (b *builder) snaps(fx map[string]string) {
	for _, old := range []string{"wiki:snap_pumpkin_to_floor", "wiki:snap_pumpkin_air_disallowed"} {
		id := fx[old]
		b.test(Test{ID: strings.TrimPrefix(id, Namespace+":"), FeatureID: id, Type: "minecraft:snap_to_surface_feature",
			Group: "snap/fixture", Source: "docs/wiki/tools/fixtures", Place: [3]int{0, 6, 0},
			Metrics: []string{"success", "block:minecraft:pumpkin", "block:minecraft:lit_pumpkin", "bbox.minY"}})
	}
	scatterOf := func(name, target string, y int, spread int) string {
		return b.feature("scatter_feature", name, fmt.Sprintf(`{"places_feature": %q,
		  "distribution": {"iterations": 20, "x": {"distribution": "uniform", "extent": [-%d, %d]}, "y": %d,
		                   "z": {"distribution": "uniform", "extent": [-%d, %d]}}}`, target, spread, spread, y, spread, spread))
	}
	type snapCase struct {
		name, body string
		setup      []Op
		y          int
		note       string
	}
	cases := []snapCase{
		{"snap_floor", `{"feature_to_snap": "difftest:blk_gold", "surface": "floor", "vertical_search_range": 12}`,
			[]Op{fill(box(-4, 0, -4, 4, 3, 4), "minecraft:stone")}, 6, "20 snaps down onto grass and a stone block"},
		{"snap_floor_search_range", `{"feature_to_snap": "difftest:blk_gold", "surface": "floor", "search_range": 4}`,
			[]Op{fill(box(-4, 0, -4, 4, 3, 4), "minecraft:stone")}, 6, "1.26.50 search_range 4: only the stone block top is in reach"},
		{"snap_ceiling", `{"feature_to_snap": "difftest:blk_gold", "surface": "ceiling", "vertical_search_range": 12}`,
			room(10, 0, 11, "minecraft:stone"), 5, "snaps up to a room ceiling"},
		{"snap_random_horizontal", `{"feature_to_snap": "difftest:blk_gold", "surface": "random_horizontal", "vertical_search_range": 12}`,
			room(10, 0, 11, "minecraft:stone"), 5, "floor or ceiling at random"},
		{"snap_allowed_surface", `{"feature_to_snap": "difftest:blk_gold", "surface": "floor", "vertical_search_range": 12, "allowed_surface_blocks": ["minecraft:stone"]}`,
			[]Op{fill(box(0, -1, -8, 8, -1, 8), "minecraft:stone")}, 4, "only lands on the stone half of the ground"},
		{"snap_embed", `{"feature_to_snap": "difftest:blk_emerald_any", "surface": "floor", "vertical_search_range": 12, "embed_in_surface": true}`,
			nil, 4, "embed_in_surface replaces the surface block itself"},
		{"snap_non_air_start", `{"feature_to_snap": "difftest:blk_gold", "surface": "floor", "vertical_search_range": 14, "allow_non_air_placement": true}`,
			room(10, 0, 11, "minecraft:stone"), 12, "starts inside the room's ceiling rock and still finds the floor"},
	}
	b.feature("single_block_feature", "blk_emerald_any", `{
	  "enforce_placement_rules": false, "enforce_survivability_rules": false, "places_block": "minecraft:emerald_block"}`)
	for _, c := range cases {
		fv := defaultFormatVersion
		if strings.Contains(c.body, `"search_range"`) {
			fv = "1.26.50"
		}
		b.featureFV(fv, "snap_to_surface_feature", c.name+"_inner", c.body)
		id := scatterOf(c.name, Namespace+":"+c.name+"_inner", c.y, 7)
		b.test(Test{ID: c.name, FeatureID: id, Type: "minecraft:snap_to_surface_feature", Group: "snap", Setup: c.setup, Region: regionRoom,
			Metrics: []string{"success", "placed", "bbox.minY", "bbox.maxY", "layer[+0]", "layer[+10]", "clusters"}, Note: "scatter of 20: " + c.note})
	}
}

func (b *builder) searches(fx map[string]string) {
	for _, old := range []string{"wiki:search_pumpkin_down", "wiki:search_pumpkin_too_shallow"} {
		id := fx[old]
		b.test(Test{ID: strings.TrimPrefix(id, Namespace+":"), FeatureID: id, Type: "minecraft:search_feature",
			Group: "search/fixture", Source: "docs/wiki/tools/fixtures", Place: [3]int{0, 6, 0},
			Metrics: []string{"success", "placed", "bbox.minY"}})
	}
	b.feature("search_feature", "search_three_successes", `{"places_feature": "difftest:blk_gold_on_grass",
	  "search_volume": {"min": [-3, -6, -3], "max": [3, 0, 3]}, "search_axis": "-y", "required_successes": 3}`)
	b.test(Test{ID: "search_three_successes", Type: "minecraft:search_feature", Group: "search", Place: [3]int{0, 3, 0},
		Metrics: []string{"success", "placed", "bbox.dx", "bbox.dz"}, Note: "needs three spots; stops after the third"})
	b.feature("search_feature", "search_axis_x", `{"places_feature": "difftest:blk_gold_on_grass",
	  "search_volume": {"min": [-6, -3, -2], "max": [6, 0, 2]}, "search_axis": "+x", "required_successes": 2}`)
	b.test(Test{ID: "search_axis_x", Type: "minecraft:search_feature", Group: "search", Place: [3]int{0, 2, 0},
		Setup:   []Op{fill(box(-6, -1, -2, -1, -1, 2), "minecraft:stone")},
		Metrics: []string{"success", "placed", "bbox.cx", "bbox.cz"}, Note: "search_axis x over half stone, half grass"})
	b.feature("search_feature", "search_unreachable", `{"places_feature": "difftest:blk_gold_on_grass",
	  "search_volume": {"min": [-2, 0, -2], "max": [2, 3, 2]}, "search_axis": "+y", "required_successes": 1}`)
	b.test(Test{ID: "search_unreachable", Type: "minecraft:search_feature", Group: "search", Place: [3]int{0, 4, 0},
		Metrics: []string{"success"}, Note: "volume entirely in the air: never places"})
}

// ---------------------------------------------------------------------------------------------
// composites: aggregate, sequence, weighted_random, conditional_list, scan_surface

func (b *builder) composites(fx map[string]string) {
	fixture := func(old, typ, group string, region Box, metrics []string) {
		id := fx[old]
		b.test(Test{ID: strings.TrimPrefix(id, Namespace+":"), FeatureID: id, Type: typ, Group: group,
			Source: "docs/wiki/tools/fixtures", Region: region, Metrics: metrics})
	}
	pumpkins := []string{"success", "placed", "block:minecraft:pumpkin", "block:minecraft:lit_pumpkin", "block:minecraft:gold_block", "clusters"}
	fixture("wiki:aggregate_pumpkin_pair", "minecraft:aggregate_feature", "aggregate/fixture", regionScatter, pumpkins)
	fixture("wiki:matchmode_bare_vs_stated", "minecraft:aggregate_feature", "aggregate/fixture", regionSmall, pumpkins)
	b.feature("aggregate_feature", "aggregate_first_success", `{"features": ["difftest:blk_fail", "difftest:blk_gold", "difftest:blk_emerald"], "early_out": "first_success"}`)
	b.test(Test{ID: "aggregate_first_success", Type: "minecraft:aggregate_feature", Group: "aggregate",
		Metrics: []string{"success", "block:minecraft:gold_block", "block:minecraft:emerald_block"}, Note: "stops after gold"})
	b.feature("aggregate_feature", "aggregate_first_failure", `{"features": ["difftest:blk_gold", "difftest:blk_fail", "difftest:blk_emerald"], "early_out": "first_failure"}`)
	b.test(Test{ID: "aggregate_first_failure", Type: "minecraft:aggregate_feature", Group: "aggregate",
		Metrics: []string{"success", "block:minecraft:gold_block", "block:minecraft:emerald_block"}, Note: "stops at the failing diamond"})

	fixture("wiki:sequence_snap_then_scatter", "minecraft:sequence_feature", "sequence/fixture", regionScatter, pumpkins)
	b.feature("scatter_feature", "seq_step_up", `{"places_feature": "difftest:blk_emerald", "distribution": {"iterations": 1, "x": 0, "y": {"distribution": "uniform", "extent": [1, 4]}, "z": 0}}`)
	b.feature("sequence_feature", "sequence_threaded", `{"features": ["difftest:fx_pumpkin_patch", "difftest:seq_step_up", "difftest:seq_step_up"]}`)
	b.test(Test{ID: "sequence_threaded", Type: "minecraft:sequence_feature", Group: "sequence", Region: regionScatter,
		Metrics: append([]string{"block:minecraft:emerald_block", "top"}, pumpkins...), Note: "each step starts from the previous step's returned position"})

	fixture("wiki:weighted_pick_feature", "minecraft:weighted_random_feature", "weighted_random/fixture", regionSmall, pumpkins)
	fixture("wiki:weighted_pick_lopsided", "minecraft:weighted_random_feature", "weighted_random/fixture", regionSmall, pumpkins)
	b.feature("weighted_random_feature", "weighted_three", `{"features": [["difftest:blk_gold", 1], ["difftest:blk_emerald", 3], ["difftest:blk_fail", 2]]}`)
	b.feature("scatter_feature", "weighted_three_field", `{"places_feature": "difftest:weighted_three", "distribution": {"iterations": 40,
	  "x": {"distribution": "uniform", "extent": [-10, 10]}, "y": 0, "z": {"distribution": "uniform", "extent": [-10, 10]}}}`)
	b.test(Test{ID: "weighted_three_field", Type: "minecraft:weighted_random_feature", Group: "weighted_random", Region: regionScatter,
		Metrics: []string{"block:minecraft:gold_block", "block:minecraft:emerald_block", "placed"}, Note: "40 picks at 1:3:2, the 2 always fails"})

	fixture("wiki:conditional_list_example", "minecraft:conditional_list", "conditional_list/fixture", regionScatter, pumpkins)
	fixture("wiki:conditional_list_both_true", "minecraft:conditional_list", "conditional_list/fixture", regionScatter, pumpkins)
	fixture("wiki:conditional_list_early_out", "minecraft:conditional_list", "conditional_list/fixture", regionScatter, pumpkins)
	b.featureFV("1.26.50", "conditional_list", "conditional_condition_success", `{"conditional_features": [
	    {"places_feature": "difftest:blk_fail", "condition": "1"},
	    {"places_feature": "difftest:blk_gold"}],
	  "early_out_scheme": "condition_success"}`)
	b.test(Test{ID: "conditional_condition_success", Type: "minecraft:conditional_list", Group: "conditional_list",
		Metrics: []string{"success", "placed"}, Note: "first true condition wins even though it fails to place"})
	b.featureFV("1.26.50", "conditional_list", "conditional_random_inner", `{"conditional_features": [
	    {"places_feature": "difftest:blk_gold", "condition": "math.random(0, 1) < 0.3"},
	    {"places_feature": "difftest:blk_emerald"}],
	  "early_out_scheme": "condition_success"}`)
	b.feature("scatter_feature", "conditional_random_field", `{"places_feature": "difftest:conditional_random_inner", "distribution": {"iterations": 40,
	  "x": {"distribution": "uniform", "extent": [-10, 10]}, "y": 0, "z": {"distribution": "uniform", "extent": [-10, 10]}}}`)
	b.test(Test{ID: "conditional_random_field", Type: "minecraft:conditional_list", Group: "conditional_list", Region: regionScatter,
		Metrics: []string{"block:minecraft:gold_block", "block:minecraft:emerald_block", "placed"}, Note: "a Molang random condition, 30% gold"})

	fixture("wiki:scan_surface_pumpkins", "minecraft:scan_surface", "scan_surface/fixture", box(-12, -4, -12, 12, 6, 12), pumpkins)
	b.feature("scan_surface", "scan_surface_weighted", `{"places_feature": "difftest:weighted_three"}`)
	b.test(Test{ID: "scan_surface_weighted", Type: "minecraft:scan_surface", Group: "scan_surface", Region: box(-12, -4, -12, 12, 6, 12),
		Setup:   []Op{fill(box(-3, 0, -3, 3, 2, 3), "minecraft:stone")},
		Metrics: []string{"block:minecraft:gold_block", "block:minecraft:emerald_block", "placed", "bbox.dx", "bbox.dz", "layer[+3]"},
		Note:    "every column of the chunk, over a stone block"})
}

// ---------------------------------------------------------------------------------------------
// surface_relative_threshold and height_difference_filter

func (b *builder) surfaceFilters(fx map[string]string) {
	plateau := []Op{fill(box(-8, 0, -8, 8, 11, 8), "minecraft:stone")}
	id := fx["wiki:threshold_deep"]
	b.test(Test{ID: "fx_threshold_deep_ok", FeatureID: id, Type: "minecraft:surface_relative_threshold_feature", Group: "threshold/fixture",
		Source: "docs/wiki/tools/fixtures", Setup: plateau, Place: [3]int{0, 2, 0}, Metrics: []string{"success", "placed"},
		Note: "10 blocks under a stone plateau: deeper than 5, places"})
	b.test(Test{ID: "fx_threshold_deep_shallow", FeatureID: id, Type: "minecraft:surface_relative_threshold_feature", Group: "threshold/fixture",
		Source: "docs/wiki/tools/fixtures", Setup: plateau, Place: [3]int{0, 9, 0}, Metrics: []string{"success", "placed"},
		Note: "2 blocks under the plateau top: not deep enough, places nothing"})
	b.feature("surface_relative_threshold_feature", "threshold_zero_inner", `{"feature_to_place": "difftest:blk_gold_any", "minimum_distance_below_surface": 0}`)
	b.feature("single_block_feature", "blk_gold_any", `{"enforce_placement_rules": false, "enforce_survivability_rules": false, "places_block": "minecraft:gold_block"}`)
	b.feature("scatter_feature", "threshold_zero_column", `{"places_feature": "difftest:threshold_zero_inner", "distribution": {"iterations": 16,
	  "x": {"distribution": "uniform", "extent": [-10, 10]}, "y": {"distribution": "uniform", "extent": [-3, 14]}, "z": {"distribution": "uniform", "extent": [-10, 10]}}}`)
	b.test(Test{ID: "threshold_zero_column", Type: "minecraft:surface_relative_threshold_feature", Group: "threshold",
		Setup: plateau, Region: regionScatter, Metrics: []string{"success", "placed", "bbox.maxY", "bbox.dy"},
		Note: "random heights inside and around a plateau: only positions with cover place"})

	wall := []Op{fill(box(3, 0, -8, 6, 4, 8), "minecraft:stone")}
	hdf := fx["wiki:height_diff_gate"]
	b.test(Test{ID: "fx_height_diff_gate_near_wall", FeatureID: hdf, Type: "minecraft:height_difference_filter_feature", Group: "height_diff/fixture",
		Source: "docs/wiki/tools/fixtures", Setup: wall, Metrics: []string{"success", "placed"}, Note: "a 5-high wall 3 blocks away: passes"})
	b.test(Test{ID: "fx_height_diff_gate_open", FeatureID: hdf, Type: "minecraft:height_difference_filter_feature", Group: "height_diff/fixture",
		Source: "docs/wiki/tools/fixtures", Metrics: []string{"success", "placed"}, Note: "flat ground: fails"})
	b.feature("height_difference_filter_feature", "hdf_max_up_inner", `{"places_feature": "difftest:blk_gold", "search_radius": 3,
	  "max_allowed_upward_height_diff": 2}`)
	b.feature("scatter_feature", "hdf_max_up_field", `{"places_feature": "difftest:hdf_max_up_inner", "distribution": {"iterations": 30,
	  "x": {"distribution": "uniform", "extent": [-10, 10]}, "y": 0, "z": {"distribution": "uniform", "extent": [-10, 10]}}}`)
	b.test(Test{ID: "hdf_max_up_field", Type: "minecraft:height_difference_filter_feature", Group: "height_diff", Setup: wall,
		Region: regionScatter, Metrics: []string{"placed", "bbox.cx", "bbox.dx"}, Note: "30 points; the ones near the wall are refused"})
	b.feature("height_difference_filter_feature", "hdf_down_inner", `{"places_feature": "difftest:blk_gold", "search_radius": 2,
	  "min_required_downward_height_diff": 2, "max_allowed_downward_height_diff": 4}`)
	b.feature("scatter_feature", "hdf_down_field", `{"places_feature": "difftest:hdf_down_inner", "distribution": {"iterations": 30,
	  "x": {"distribution": "uniform", "extent": [-8, 8]}, "y": 5, "z": {"distribution": "uniform", "extent": [-8, 8]}}}`)
	b.test(Test{ID: "hdf_down_field", Type: "minecraft:height_difference_filter_feature", Group: "height_diff", Region: regionScatter,
		Setup:   []Op{fill(box(-4, 0, -4, 4, 4, 4), "minecraft:stone")},
		Metrics: []string{"placed", "bbox.dx", "bbox.dz"}, Note: "on top of a 5-high block: only its edges see a drop of 2..4"})
}

// ---------------------------------------------------------------------------------------------
// minecraft:ore_feature

func (b *builder) ores(fx map[string]string) {
	// The vein is centred 8 blocks +X/+Z from the origin, so the stone box is too.
	stoneBox := []Op{fill(box(-6, -3, -6, 22, 22, 22), "minecraft:stone")}
	region := box(-8, -4, -8, 24, 24, 24)
	place := [3]int{0, 8, 0}
	add := func(id, name, group, source, note string, setup []Op) {
		b.test(Test{ID: name, FeatureID: id, Type: "minecraft:ore_feature", Group: group, Source: source, Setup: setup,
			Region: region, Place: place, Metrics: oreMetrics, Note: note})
	}
	add(fx["wiki:diamond_vein"], "fx_diamond_vein", "ore/fixture", "docs/wiki/tools/fixtures", "count 9 in solid stone", stoneBox)
	b.test(Test{ID: "fx_surface_clay_vein", FeatureID: fx["wiki:surface_clay_vein"], Type: "minecraft:ore_feature", Group: "ore/fixture",
		Source: "docs/wiki/tools/fixtures", Region: region, Place: [3]int{0, -2, 0}, Metrics: append([]string{"block:minecraft:clay", "block:minecraft:gravel"}, oreMetrics...),
		Note: "into the superflat dirt and grass; first rule wins"})
	for _, n := range []int{4, 16, 33} {
		name := fmt.Sprintf("ore_count_%d", n)
		b.feature("ore_feature", name, fmt.Sprintf(`{"count": %d, "replace_rules": [{"places_block": "minecraft:iron_ore", "may_replace": ["minecraft:stone"]}]}`, n))
		add(Namespace+":"+name, name, "ore", "catalog", fmt.Sprintf("count %d", n), stoneBox)
	}
	b.feature("ore_feature", "ore_two_rules", `{"count": 20, "replace_rules": [
	  {"places_block": "minecraft:copper_ore", "may_replace": ["minecraft:stone"]},
	  {"places_block": "minecraft:deepslate_copper_ore", "may_replace": ["minecraft:deepslate"]}]}`)
	add(Namespace+":ore_two_rules", "ore_two_rules", "ore", "catalog", "stone and deepslate halves, one rule each",
		[]Op{fill(box(-6, -3, -6, 22, 22, 22), "minecraft:stone"), fill(box(8, -3, -6, 22, 22, 22), "minecraft:deepslate")})
	b.feature("ore_feature", "ore_air_exposure", `{"count": 24, "discard_chance_on_air_exposure": 1.0,
	  "replace_rules": [{"places_block": "minecraft:gold_ore", "may_replace": ["minecraft:stone"]}]}`)
	add(Namespace+":ore_air_exposure", "ore_air_exposure", "ore", "catalog", "discard_chance_on_air_exposure 1 next to a carved slot",
		[]Op{fill(box(-6, -3, -6, 22, 22, 22), "minecraft:stone"), fill(box(2, 8, -6, 14, 8, 22), "minecraft:air")})
	b.feature("ore_feature", "ore_no_rules", `{"count": 12}`)
	add(Namespace+":ore_no_rules", "ore_no_rules", "ore", "catalog", "no replace_rules: loads and places nothing", stoneBox)
}

// ---------------------------------------------------------------------------------------------
// minecraft:single_block_feature

func (b *builder) singleBlocks(fx map[string]string) {
	field := func(name, target string, iterations, spread, y int) string {
		return b.feature("scatter_feature", name, fmt.Sprintf(`{"places_feature": %q, "distribution": {"iterations": %d,
		  "x": {"distribution": "uniform", "extent": [-%d, %d]}, "y": %d, "z": {"distribution": "uniform", "extent": [-%d, %d]}}}`,
			target, iterations, spread, spread, y, spread, spread))
	}
	sbMetrics := []string{"success", "placed", "clusters"}
	b.test(Test{ID: "fx_pumpkin_patch_block", FeatureID: fx["wiki:pumpkin_patch_block"], Type: "minecraft:single_block_feature",
		Group: "single_block/fixture", Source: "docs/wiki/tools/fixtures",
		Metrics: []string{"success", "block:minecraft:pumpkin", "block:minecraft:lit_pumpkin"}, Note: "weighted places_block 3:1"})
	b.test(Test{ID: "fx_blocked_gold_block", FeatureID: fx["wiki:blocked_gold_block"], Type: "minecraft:single_block_feature",
		Group: "single_block/fixture", Source: "docs/wiki/tools/fixtures", Metrics: []string{"success"}, Note: "may_replace stone over air: refused"})
	b.test(Test{ID: "fx_hanging_roots", FeatureID: fx["wiki:hanging_roots_ceiling_block"], Type: "minecraft:single_block_feature",
		Group: "single_block/fixture", Source: "docs/wiki/tools/fixtures", Region: regionRoom, Place: [3]int{0, 10, 0},
		Setup:   append(room(10, 0, 11, "minecraft:stone"), fill(box(-3, 11, -3, 3, 11, 3), "minecraft:moss_block")),
		Metrics: []string{"success", "block:minecraft:hanging_roots"}, Note: "may_attach_to top moss: under a moss ceiling"})

	b.feature("single_block_feature", "sb_survivability_inner", `{"enforce_placement_rules": true, "enforce_survivability_rules": true,
	  "places_block": "minecraft:poppy", "may_replace": ["minecraft:air"]}`)
	field("sb_survivability", Namespace+":sb_survivability_inner", 30, 8, 0)
	b.test(Test{ID: "sb_survivability", Type: "minecraft:single_block_feature", Group: "single_block", Region: regionScatter,
		Setup:   []Op{fill(box(0, -1, -8, 8, -1, 8), "minecraft:stone")},
		Metrics: append([]string{"block:minecraft:poppy", "bbox.cx"}, sbMetrics...), Note: "poppies survive on the grass half only"})

	b.featureFV("1.21.40", "single_block_feature", "sb_not_attach_inner", `{"enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:gold_block", "may_replace": ["minecraft:air"],
	  "may_not_attach_to": {"sides": ["minecraft:stone"]}}`)
	field("sb_not_attach", Namespace+":sb_not_attach_inner", 40, 8, 0)
	pillars := []Op{}
	for _, p := range [][2]int{{-4, -4}, {-4, 4}, {4, -4}, {4, 4}, {0, 0}, {-6, 0}, {6, 0}, {0, -6}, {0, 6}} {
		pillars = append(pillars, fill(box(p[0]-1, 0, p[1]-1, p[0]+1, 2, p[1]+1), "minecraft:stone"))
	}
	b.test(Test{ID: "sb_not_attach", Type: "minecraft:single_block_feature", Group: "single_block", Region: regionScatter, Setup: pillars,
		Metrics: append([]string{"block:minecraft:gold_block"}, sbMetrics...), Note: "may_not_attach_to sides stone among stone pillars"})

	b.feature("single_block_feature", "sb_min_sides_inner", `{"enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:gold_block", "may_replace": ["minecraft:air"],
	  "may_attach_to": {"sides": ["minecraft:stone"], "min_sides_must_attach": 2, "auto_rotate": false}}`)
	field("sb_min_sides", Namespace+":sb_min_sides_inner", 60, 8, 0)
	b.test(Test{ID: "sb_min_sides", Type: "minecraft:single_block_feature", Group: "single_block", Region: regionScatter, Setup: pillars,
		Metrics: append([]string{"block:minecraft:gold_block"}, sbMetrics...), Note: "needs two stone sides: only in pillar corners"})

	b.feature("single_block_feature", "sb_attach_all_inner", `{"enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": "minecraft:emerald_block", "may_replace": ["minecraft:air"],
	  "may_attach_to": {"bottom": ["minecraft:grass_block", "minecraft:stone"], "diagonal": ["minecraft:stone"], "min_sides_must_attach": 1}}`)
	field("sb_attach_diagonal", Namespace+":sb_attach_all_inner", 60, 8, 0)
	b.test(Test{ID: "sb_attach_diagonal", Type: "minecraft:single_block_feature", Group: "single_block", Region: regionScatter, Setup: pillars,
		Metrics: append([]string{"block:minecraft:emerald_block"}, sbMetrics...), Note: "may_attach_to bottom + diagonal"})

	b.featureFV("1.21.40", "single_block_feature", "sb_rotation_inner", `{"enforce_placement_rules": false, "enforce_survivability_rules": false,
	  "places_block": [{"block": "minecraft:carved_pumpkin", "weight": 1}, {"block": "minecraft:lit_pumpkin", "weight": 2}],
	  "randomize_rotation": true, "may_replace": ["minecraft:air"]}`)
	field("sb_rotation", Namespace+":sb_rotation_inner", 30, 8, 0)
	b.test(Test{ID: "sb_rotation", Type: "minecraft:single_block_feature", Group: "single_block", Region: regionScatter,
		Metrics: []string{"block:minecraft:carved_pumpkin", "block:minecraft:lit_pumpkin", "placed"}, Note: "weighted 1:2 with randomize_rotation"})
}

// ---------------------------------------------------------------------------------------------
// vegetation_patch, sculk_patch, growing_plant, multiface

func (b *builder) vegetation(fx map[string]string) {
	vp := []string{"success", "placed", "replaced", "bbox.dx", "bbox.dz", "bbox.minY", "block:minecraft:pumpkin"}
	b.test(Test{ID: "fx_vegetation_patch_floor", FeatureID: fx["wiki:vegetation_patch_floor"], Type: "minecraft:vegetation_patch_feature",
		Group: "vegetation_patch/fixture", Source: "docs/wiki/tools/fixtures", Metrics: vp})
	b.test(Test{ID: "fx_vegetation_patch_ceiling_demo", FeatureID: fx["wiki:vegetation_patch_ceiling_demo"], Type: "minecraft:vegetation_patch_feature",
		Group: "vegetation_patch/fixture", Source: "docs/wiki/tools/fixtures",
		Metrics: append([]string{"block:minecraft:moss_block", "block:minecraft:hanging_roots"}, vp...)})
	b.feature("vegetation_patch_feature", "vegetation_patch_moss_deep", `{"replaceable_blocks": ["minecraft:grass_block", "minecraft:dirt", "minecraft:stone"],
	  "ground_block": "minecraft:moss_block", "vegetation_feature": "difftest:blk_gold", "depth": {"range_min": 1, "range_max": 3},
	  "extra_deep_block_chance": 0.5, "vertical_range": 5, "vegetation_chance": 0.3, "horizontal_radius": {"range_min": 3, "range_max": 6},
	  "extra_edge_column_chance": 0.5, "waterlogged": false, "surface": "floor"}`)
	b.test(Test{ID: "vegetation_patch_moss_deep", Type: "minecraft:vegetation_patch_feature", Group: "vegetation_patch", Region: regionScatter,
		Metrics: append([]string{"block:minecraft:moss_block", "block:minecraft:gold_block"}, vp...), Note: "ranged depth and radius"})
	b.feature("vegetation_patch_feature", "vegetation_patch_waterlogged", `{"replaceable_blocks": ["minecraft:grass_block", "minecraft:dirt"],
	  "ground_block": "minecraft:clay", "vegetation_feature": "difftest:blk_gold_any", "depth": 2,
	  "vertical_range": 3, "vegetation_chance": 0.2, "horizontal_radius": 5, "extra_edge_column_chance": 0.2, "waterlogged": true, "surface": "floor"}`)
	b.test(Test{ID: "vegetation_patch_waterlogged", Type: "minecraft:vegetation_patch_feature", Group: "vegetation_patch", Region: regionScatter,
		Metrics: append([]string{"block:minecraft:clay", "block:minecraft:water", "block:minecraft:gold_block"}, vp...), Note: "waterlogged: the patch surface becomes water"})

	sculkStone := []Op{fill(box(-12, -3, -12, 12, -1, 12), "minecraft:stone")}
	b.feature("sculk_patch_feature", "sculk_patch_basic", `{"can_place_sculk_patch_on": ["minecraft:stone"], "charge_amount": 10, "cursor_count": 10,
	  "spread_attempts": 2, "growth_rounds": 1, "spread_rounds": 2, "extra_growth_chance": {"range_min": 0, "range_max": 3}}`)
	b.test(Test{ID: "sculk_patch_basic", Type: "minecraft:sculk_patch_feature", Group: "sculk_patch", Region: regionScatter, Setup: sculkStone,
		Metrics: []string{"success", "replaced", "placed", "block:minecraft:sculk", "block:minecraft:sculk_vein", "bbox.dx", "bbox.dz"}})
	b.feature("sculk_patch_feature", "sculk_patch_catalyst", `{"can_place_sculk_patch_on": ["minecraft:stone"], "central_block": "minecraft:sculk_catalyst",
	  "central_block_placement_chance": 1.0, "charge_amount": 32, "cursor_count": 20, "spread_attempts": 4, "growth_rounds": 0, "spread_rounds": 3}`)
	b.feature("sculk_patch_feature", "sculk_patch_central_only", `{"can_place_sculk_patch_on": [], "central_block": "minecraft:sculk_shrieker",
	  "central_block_placement_chance": 0.5, "charge_amount": 1, "cursor_count": 0, "spread_attempts": 1, "growth_rounds": 0, "spread_rounds": 0}`)
	b.test(Test{ID: "sculk_patch_central_only", Type: "minecraft:sculk_patch_feature", Group: "sculk_patch", Setup: sculkStone,
		Place: [3]int{0, 0, 0}, Metrics: []string{"success", "placed", "block:minecraft:sculk_shrieker"},
		Note: "no cursors: only the central block, at 50%"})
	b.test(Test{ID: "sculk_patch_catalyst", Type: "minecraft:sculk_patch_feature", Group: "sculk_patch", Region: regionScatter, Setup: sculkStone,
		Metrics: []string{"success", "replaced", "placed", "block:minecraft:sculk", "block:minecraft:sculk_catalyst", "bbox.dx", "bbox.dz"}})
}

func (b *builder) caveDecor(fx map[string]string) {
	stoneRoom := room(10, 0, 11, "minecraft:stone")
	b.test(Test{ID: "fx_cave_vines", FeatureID: fx["wiki:cave_vines"], Type: "minecraft:growing_plant_feature", Group: "growing_plant/fixture",
		Source: "docs/wiki/tools/fixtures", Region: regionRoom, Setup: stoneRoom, Place: [3]int{0, 10, 0},
		Metrics: []string{"success", "placed", "bbox.dy", "bbox.minY", "block:minecraft:cave_vines", "block:minecraft:cave_vines_head_with_berries", "block:minecraft:cave_vines_body_with_berries"}})
	b.feature("growing_plant_feature", "growing_plant_up", `{"height_distribution": [[[2, 9], 3], [[9, 14], 1]],
	  "growth_direction": "up", "body_blocks": [["minecraft:twisting_vines", 1]], "head_blocks": [["minecraft:twisting_vines", 1]],
	  "age": {"range_min": 0, "range_max": 25}, "allow_water": false}`)
	b.test(Test{ID: "growing_plant_up", Type: "minecraft:growing_plant_feature", Group: "growing_plant", Region: regionRoom,
		Metrics: []string{"success", "placed", "top", "bbox.dy"}, Note: "grows upward in open air"})
	b.feature("growing_plant_feature", "growing_plant_kelp", `{"height_distribution": [[[1, 7], 1]],
	  "growth_direction": "up", "body_blocks": [["minecraft:kelp", 1]], "head_blocks": [["minecraft:kelp", 1]],
	  "age": {"range_min": 0, "range_max": 20}, "allow_water": true}`)
	b.test(Test{ID: "growing_plant_kelp", Type: "minecraft:growing_plant_feature", Group: "growing_plant", Region: regionRoom,
		Setup: []Op{fill(box(-4, -3, -4, 4, 6, 4), "minecraft:water"), fill(box(-5, -4, -5, 5, -4, 5), "minecraft:bedrock")},
		Place: [3]int{0, -3, 0}, Metrics: []string{"success", "placed", "top", "block:minecraft:kelp"}, Note: "allow_water: grows through a water column"})

	b.test(Test{ID: "fx_glow_lichen", FeatureID: fx["wiki:glow_lichen"], Type: "minecraft:multiface_feature", Group: "multiface/fixture",
		Source: "docs/wiki/tools/fixtures", Region: regionRoom, Setup: stoneRoom, Place: [3]int{0, 1, 0},
		Metrics: []string{"success", "placed", "clusters", "bbox.dx", "bbox.dy", "bbox.dz"}})
	b.feature("multiface_feature", "multiface_floor_only", `{"places_block": "minecraft:sculk_vein", "search_range": 6,
	  "can_place_on_floor": true, "can_place_on_ceiling": false, "can_place_on_wall": false, "chance_of_spreading": 0.9,
	  "can_place_on": ["minecraft:stone"]}`)
	b.test(Test{ID: "multiface_floor_only", Type: "minecraft:multiface_feature", Group: "multiface", Region: regionRoom, Setup: stoneRoom,
		Place: [3]int{0, 1, 0}, Metrics: []string{"success", "placed", "clusters", "layer[-2]", "bbox.dx", "bbox.dz"}})
	b.feature("multiface_feature", "multiface_moss_only", `{"places_block": "minecraft:glow_lichen", "search_range": 8,
	  "can_place_on_floor": true, "can_place_on_ceiling": true, "can_place_on_wall": true, "chance_of_spreading": 1.0,
	  "can_place_on": ["minecraft:moss_block"]}`)
	b.test(Test{ID: "multiface_moss_only", Type: "minecraft:multiface_feature", Group: "multiface", Region: regionRoom,
		Setup: append(room(10, 0, 11, "minecraft:stone"), fill(box(-8, 0, -8, 0, 0, 8), "minecraft:moss_block")),
		Place: [3]int{-4, 1, 0}, Metrics: []string{"success", "placed", "bbox.cx", "clusters"}, Note: "only the moss half of the floor"})

	b.test(Test{ID: "fx_dripstone_spike", FeatureID: fx["wiki:dripstone_spike"], Type: "minecraft:multipart_block_column_feature",
		Group: "multipart/fixture", Source: "docs/wiki/tools/fixtures",
		Metrics: []string{"success", "placed", "top", "block:minecraft:pointed_dripstone", "block:minecraft:dripstone_block"}})
	b.featureFV("1.26.50", "multipart_block_column_feature", "multipart_down_range", `{"direction": "down",
	  "base_block": "minecraft:dripstone_block", "middle_block": "minecraft:dripstone_block",
	  "frustum_block": "minecraft:pointed_dripstone", "tip_block": "minecraft:pointed_dripstone",
	  "height_range": {"range_min": 2, "range_max": 8}, "may_replace": ["minecraft:air"], "may_place_on": ["minecraft:stone"]}`)
	b.test(Test{ID: "multipart_down_range", Type: "minecraft:multipart_block_column_feature", Group: "multipart", Region: regionRoom,
		Setup: stoneRoom, Place: [3]int{0, 10, 0}, Metrics: []string{"success", "placed", "bbox.minY", "bbox.dy"}, Note: "hangs from a room ceiling, height_range 2..8"})
	b.featureFV("1.26.50", "multipart_block_column_feature", "multipart_blocked_base", `{"direction": "up",
	  "base_block": "minecraft:dripstone_block", "middle_block": "minecraft:dripstone_block",
	  "frustum_block": "minecraft:pointed_dripstone", "tip_block": "minecraft:pointed_dripstone",
	  "weighted_heights": [{"value": 3, "weight": 1}, {"value": 6, "weight": 1}], "may_replace": ["minecraft:air"], "may_place_on": ["minecraft:stone"]}`)
	b.test(Test{ID: "multipart_blocked_base", Type: "minecraft:multipart_block_column_feature", Group: "multipart",
		Metrics: []string{"success"}, Note: "may_place_on stone over grass: refused"})
}

// ---------------------------------------------------------------------------------------------
// partially_exposed_blob, geode

func (b *builder) blobs(fx map[string]string) {
	b.test(Test{ID: "fx_magma_blob", FeatureID: fx["wiki:magma_blob"], Type: "minecraft:partially_exposed_blob_feature",
		Group: "blob/fixture", Source: "docs/wiki/tools/fixtures", Place: [3]int{0, -1, 0},
		Metrics: []string{"success", "replaced", "block:minecraft:magma", "bbox.dx", "bbox.dz", "bbox.dy"}})
	b.feature("partially_exposed_blob_feature", "blob_down_full", `{"placement_radius_around_floor": 2,
	  "placement_probability_per_valid_position": 1.0, "exposed_face": "down", "places_block": "minecraft:glowstone"}`)
	b.test(Test{ID: "blob_down_full", Type: "minecraft:partially_exposed_blob_feature", Group: "blob", Region: regionRoom,
		Setup: room(10, 0, 11, "minecraft:stone"), Place: [3]int{0, 11, 0},
		Metrics: []string{"success", "replaced", "block:minecraft:glowstone", "bbox.dx", "bbox.dy"}, Note: "exposed_face down in a room ceiling, probability 1"})

	geodeBox := []Op{fill(box(-14, -3, -14, 14, 26, 14), "minecraft:stone")}
	geodeRegion := box(-16, -4, -16, 16, 28, 16)
	b.test(Test{ID: "fx_amethyst_geode", FeatureID: fx["wiki:amethyst_geode"], Type: "minecraft:geode_feature", Group: "geode/fixture",
		Source: "docs/wiki/tools/fixtures", Setup: geodeBox, Region: geodeRegion, Place: [3]int{0, 8, 0},
		Metrics: []string{"success", "replaced", "removed", "block:minecraft:smooth_basalt", "block:minecraft:calcite", "block:minecraft:amethyst_block", "block:minecraft:amethyst_cluster", "bbox.dx", "bbox.dy"}})
	b.feature("geode_feature", "geode_small_solid", `{"filler": "minecraft:glass", "inner_layer": "minecraft:emerald_block",
	  "alternate_inner_layer": "minecraft:diamond_block", "middle_layer": "minecraft:gold_block", "outer_layer": "minecraft:obsidian",
	  "min_outer_wall_distance": 2, "max_outer_wall_distance": 4, "min_distribution_points": 2,
	  "max_distribution_points": 5, "min_point_offset": 1, "max_point_offset": 3, "max_radius": 12, "crack_point_offset": 1,
	  "generate_crack_chance": 0.0, "base_crack_size": 1.5, "noise_multiplier": 0.1, "use_potential_placements_chance": 0.0,
	  "use_alternate_layer0_chance": 0.3, "placements_require_layer0_alternate": false, "invalid_blocks_threshold": 4}`)
	b.test(Test{ID: "geode_small_solid", Type: "minecraft:geode_feature", Group: "geode", Setup: geodeBox, Region: geodeRegion,
		Place:   [3]int{0, 8, 0},
		Metrics: []string{"success", "replaced", "block:minecraft:glass", "block:minecraft:obsidian", "block:minecraft:diamond_block", "bbox.dx", "bbox.dy"},
		Note:    "glass-filled, alternate inner layer 30%"})
}

// ---------------------------------------------------------------------------------------------
// carvers -- the game may refuse /place feature for them; kept so both sides are measured.

func (b *builder) carvers(fx map[string]string) {
	caveat := "carvers run in the carving pass; /place feature may place nothing for them in game"
	// Tunnels start at a random Y from 8 up to height_limit in the origin's chunk, so the solid
	// volume sits at world Y 2..62 over and around that chunk (the anchor is 8 blocks into it).
	region := box(-24, 60, -24, 40, 124, 40)
	solid := func(block string) []Op { return []Op{fill(box(-22, 62, -22, 38, 122, 38), block)} }
	b.test(Test{ID: "fx_cave_demo", FeatureID: fx["wiki:cave_demo"], Type: "minecraft:cave_carver_feature", Group: "carver/fixture",
		Source: "docs/wiki/tools/fixtures", Region: region, Setup: solid("minecraft:stone"),
		Place: [3]int{0, 90, 0}, Metrics: carverMetrics, GameCaveat: caveat, Repeats: 20})
	b.test(Test{ID: "fx_nether_cave_demo", FeatureID: fx["wiki:nether_cave_demo"], Type: "minecraft:nether_cave_carver_feature",
		Group: "carver/fixture", Source: "docs/wiki/tools/fixtures", Region: region, Setup: solid("minecraft:netherrack"),
		Place: [3]int{0, 90, 0}, Metrics: carverMetrics, GameCaveat: caveat, Repeats: 20})
	b.test(Test{ID: "fx_underwater_cave_demo", FeatureID: fx["wiki:underwater_cave_demo"], Type: "minecraft:underwater_cave_carver_feature",
		Group: "carver/fixture", Source: "docs/wiki/tools/fixtures", Region: region, Setup: solid("minecraft:stone"),
		Place: [3]int{0, 90, 0}, Metrics: carverMetrics, GameCaveat: caveat + "; needs an ocean-tagged biome, so superflat plains carves nothing", Repeats: 20})
	b.feature("aggregate_feature", "cave_carver_wrapped", `{"features": ["difftest:fx_cave_demo"]}`)
	b.test(Test{ID: "cave_carver_wrapped", Type: "minecraft:cave_carver_feature", Group: "carver", Region: region,
		Setup: solid("minecraft:stone"), Place: [3]int{0, 90, 0}, Metrics: carverMetrics,
		GameCaveat: caveat, Repeats: 20, Note: "the same carver behind an aggregate, in case the game only refuses it at the top level"})
}

// ---------------------------------------------------------------------------------------------
// structure_template, fossil

func (b *builder) structuresAndFossils(fx map[string]string) {
	st := []string{"success", "placed", "bbox.dx", "bbox.dy", "bbox.dz", "bbox.cx", "bbox.cz"}
	b.test(Test{ID: "fx_lamp_post_structure", FeatureID: fx["wiki:lamp_post_structure"], Type: "minecraft:structure_template_feature",
		Group: "structure/fixture", Source: "docs/wiki/tools/fixtures", Metrics: st, Repeats: 10})
	b.test(Test{ID: "fx_lamp_post_constrained", FeatureID: fx["wiki:lamp_post_constrained"], Type: "minecraft:structure_template_feature",
		Group: "structure/fixture", Source: "docs/wiki/tools/fixtures", Metrics: st,
		Setup: []Op{fill(box(-2, 0, 1, 4, 0, 4), "minecraft:stone")}, Note: "grounded/unburied/leveled with a step beside the origin"})
	for _, f := range []string{"north", "south", "west", "random"} {
		name := "structure_facing_" + f
		b.feature("structure_template_feature", name, fmt.Sprintf(`{"structure_name": "wiki:lamp_post", "facing_direction": %q, "constraints": {}}`, f))
		b.test(Test{ID: name, Type: "minecraft:structure_template_feature", Group: "structure", Metrics: st})
	}
	b.feature("structure_template_feature", "structure_rotate_center", `{"structure_name": "wiki:lamp_post", "facing_direction": "random",
	  "rotate_around_center": true, "constraints": {"block_intersection": {"block_allowlist": ["minecraft:air"]}}}`)
	b.test(Test{ID: "structure_rotate_center", Type: "minecraft:structure_template_feature", Group: "structure", Metrics: st,
		Note: "rotate_around_center with a block_intersection allowlist"})

	fossilBox := []Op{fill(box(-14, -3, -14, 14, 20, 14), "minecraft:stone")}
	b.feature("fossil_feature", "fossil_diamond", `{"ore_block": "minecraft:diamond_ore", "max_empty_corners": 4}`)
	b.test(Test{ID: "fossil_diamond", Type: "minecraft:fossil_feature", Group: "fossil", Setup: fossilBox, Region: box(-16, -4, -16, 16, 22, 16),
		Place:   [3]int{0, 4, 0},
		Metrics: []string{"success", "replaced", "block:minecraft:bone_block", "block:minecraft:diamond_ore", "bbox.dx", "bbox.dy", "bbox.dz"},
		Note:    "buried in stone (needs the vanilla fossil structures on both sides)"})
	b.feature("fossil_feature", "fossil_exposed_refused", `{"ore_block": "minecraft:coal_ore", "max_empty_corners": 0}`)
	b.test(Test{ID: "fossil_exposed_refused", Type: "minecraft:fossil_feature", Group: "fossil", Region: box(-16, -4, -16, 16, 22, 16),
		Metrics: []string{"success", "placed"}, Note: "on the open surface with max_empty_corners 0: refused"})
}

// ---------------------------------------------------------------------------------------------
// 1.26.x types: horizontal_tree_decoration, multi_block (multipart is with the cave decor)

func (b *builder) newTypes(fx map[string]string) {
	b.test(Test{ID: "fx_fallen_log_with_litter", FeatureID: fx["wiki:fallen_log_with_litter"], Type: "minecraft:horizontal_tree_decoration_feature",
		Group: "horizontal_tree_decoration/fixture", Source: "docs/wiki/tools/fixtures",
		Metrics: []string{"success", "placed", "block:minecraft:leaf_litter", "block:minecraft:oak_log"}})
	b.feature("horizontal_tree_decoration_feature", "htd_adjacent_inner", `{"places_block": "minecraft:pink_petals", "allow_adjacent": true}`)
	b.feature("scatter_feature", "htd_adjacent_run", `{"places_feature": "difftest:htd_adjacent_inner", "distribution": {"iterations": 7,
	  "x": {"distribution": "fixed_grid", "extent": [-3, 3]}, "y": 0, "z": 0}}`)
	b.feature("aggregate_feature", "htd_adjacent", `{"features": ["difftest:fx_fallen_log_run", "difftest:htd_adjacent_run"]}`)
	b.test(Test{ID: "htd_adjacent", Type: "minecraft:horizontal_tree_decoration_feature", Group: "horizontal_tree_decoration",
		Metrics: []string{"success", "placed", "block:minecraft:pink_petals"}, Note: "pink petals along a fallen oak log, allow_adjacent"})

	b.raw("blocks/totem.json", `{"format_version": "1.26.50", "minecraft:block": {"description": {"identifier": "difftest:totem",
	  "traits": {"minecraft:multi_block": {"enabled_states": ["minecraft:multi_block_part"], "parts": 3, "direction": "up"}}},
	  "components": {"minecraft:movable": {"movement_type": "immovable"}}}}`)
	b.featureFV("1.26.50", "multi_block_feature", "multi_block_totem", `{"places_block": "difftest:totem", "may_replace": ["minecraft:air"]}`)
	b.test(Test{ID: "multi_block_totem", Type: "minecraft:multi_block_feature", Group: "multi_block",
		Metrics: []string{"success", "placed", "block:difftest:totem", "bbox.dy"}, Note: "a three-part custom block, stacked up"})
	b.featureFV("1.26.50", "multi_block_feature", "multi_block_totem_blocked_inner", `{"places_block": "difftest:totem", "may_replace": ["minecraft:air"]}`)
	b.feature("scatter_feature", "multi_block_totem_field", `{"places_feature": "difftest:multi_block_totem_blocked_inner", "distribution": {"iterations": 20,
	  "x": {"distribution": "uniform", "extent": [-6, 6]}, "y": 0, "z": {"distribution": "uniform", "extent": [-6, 6]}}}`)
	b.test(Test{ID: "multi_block_totem_field", Type: "minecraft:multi_block_feature", Group: "multi_block", Region: regionScatter,
		Setup:   []Op{fill(box(-6, 2, -6, 0, 2, 6), "minecraft:stone")},
		Metrics: []string{"placed", "block:difftest:totem", "bbox.cx"}, Note: "half the field has a stone slab two blocks up: no room for three parts"})
}
