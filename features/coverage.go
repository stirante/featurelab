// coverage.go is this tool's coverage table: what it implements, and what it
// does not.
//
// The game registers 29 JSON feature types as of 1.26.50.24. That qualifier is deliberate:
// every count and status below is a statement about ONE game version. 1.26.40.26 registered
// 26; 1.26.50.24 added `minecraft:horizontal_tree_decoration_feature`,
// `minecraft:multi_block_feature` and `minecraft:multipart_block_column_feature`. Microsoft's
// public feature-type reference documented some of those before the game shipped them, so
// the table follows the game version, not the documentation.
//
// When the target version moves, each type is checked on two axes: its JSON surface (keys,
// enum values, defaults) and its placement behaviour. The second matters because an algorithm
// can change behind an unchanged JSON surface. Where an entry below says a type is unchanged in
// 1.26.50.24, it means both were checked.
//
// This header deliberately does NOT give a count. `featurelab types` prints the live table;
// CoverageSummary() is the live count; coverage_test.go pins it so the two cannot drift apart.
//
// Several types have no end-to-end regression baseline, which raises the risk of a wrong
// implementation that nothing notices. Those types' tests assert on the RNG draw sequence --
// order, kind and bound of every draw -- rather than on a final block count, which would pass
// for a great many wrong implementations.
//
// This table is the single source of truth for coverage claims:
//   - registry.go uses it to tell "game type we haven't ported" apart from "not a real
//     type at all", which are very different things for someone debugging a pack.
//   - coverage_test.go asserts it agrees with the live builder registry in both
//     directions, so implementing a type without updating this file fails the suite.
//   - README's coverage section is written from it.
//
// Two KINDS of gap exist and the distinction is deliberate, not a severity ranking.
// StatusMissing means "a real gap, pick this up when the budget allows". StatusOutOfScope means
// "Microsoft's own public feature-type reference classifies this as internal/deprecated, not for
// custom content, so don't re-litigate it" -- see StatusOutOfScope's own doc comment for the exact
// policy and the one place it was NOT applied mechanically. Check CoverageSummary() for which
// types currently sit where.
//
// The 2 StatusOutOfScope types, minecraft:beards_and_shavers and minecraft:rect_layout, were
// investigated before this policy existed; their entries keep a short summary of what a port
// would need, so a future pass does not start from nothing.
package features

// CoverageStatus is the implementation state of one registered feature type.
type CoverageStatus string

const (
	// StatusImplemented means: fully ported, with no part of the type's JSON surface
	// refusing and no disclosed behavioural gap left open.
	//
	// This status is about COMPLETENESS, not about regression coverage. Whether a type is
	// covered by an end-to-end regression digest is a separate axis: the digest is generated
	// from this port, so it is a baseline between our own revisions, never evidence of
	// agreeing with the game, and it only bounds the paths it actually exercises. A type
	// without that coverage is held to explicit RNG-draw-sequence tests instead.
	//
	// A SUBSTITUTED RNG SOURCE DOES NOT MAKE A TYPE INCOMPLETE. Where the game draws from a
	// generator that is not derived from the world seed -- the multiface spreader's
	// OS-entropy-seeded generator, or the process-global generator behind Molang's math.random --
	// this port seeds from its own master seed instead. That is deliberate policy, not a
	// shortfall: the game's own output there is not reproducible between two runs of the
	// GAME, so there is no faithful result to converge on, and a tool for authoring features
	// must show changes caused by an edit rather than by a fresh random. What matters is that
	// the MECHANISM matches -- same draw, same position in the sequence, same effect on the
	// result. Types in that situation are Implemented, with the substitution disclosed in
	// their Note and in a runtime warning.
	StatusImplemented CoverageStatus = "implemented"
	// StatusPartial means: ported, but part of the type's JSON surface refuses with a
	// diagnostic, or a real capability this port does not model is missing (see
	// geode_feature's data-driven multi-block component). Read the paragraph above before
	// filing anything here: a deliberately substituted RNG source is NOT a reason to.
	StatusPartial CoverageStatus = "partial"
	// StatusMissing means: registered by the game, not yet investigated, no builder here.
	StatusMissing CoverageStatus = "missing"
	// StatusOutOfScope means: registered by the game, no builder here, and — unlike
	// StatusMissing — deliberately not going to get one under the current policy, rather than
	// simply not yet reached.
	//
	// Policy: a type is StatusOutOfScope when Microsoft's own public feature-type reference
	// classifies it under "Internal/Deprecated Components — either deprecated or internal to
	// Minecraft and not usable in custom content" AND this tool does not already implement it.
	// That second clause is load-bearing, not a formality: the reference page's own
	// Internal/Deprecated group also names minecraft:conditional_list, minecraft:scan_surface
	// and minecraft:sculk_patch_feature, all three of which are registered and fully functional
	// in the game (schema, parsing and placement all work) — evidence that "not usable in custom
	// content" is not reliably true for everything the page groups that way.
	// Rather than mechanically applying the label and un-implementing working types, this
	// policy only ever REMOVES something from future-work priority (StatusMissing ->
	// StatusOutOfScope); it never removes something already StatusImplemented or StatusPartial.
	// That leaves exactly two: minecraft:beards_and_shavers and minecraft:rect_layout.
	StatusOutOfScope CoverageStatus = "out_of_scope"
)

// CoverageEntry is one row of the coverage table -- reachable from the wire via
// cmd/featurelab's `types`/`types --json` output and the "types" JSON-RPC method (see
// featurelab-go/cmd/featurelab's TypesOutput), tagged lowerCamelCase for the same contract
// consistency as featurelab-go/wire's `generate` shape.
type CoverageEntry struct {
	// TypeID is the `minecraft:*` JSON id as registered in the targeted game version.
	TypeID string         `json:"typeId"`
	Status CoverageStatus `json:"status"`
	// Note is: for partial, what refuses. For missing, what the type is, so the gap is
	// legible. Empty for implemented entries.
	//
	// THIS FIELD IS SHOWN TO USERS. `featurelab types` prints it verbatim
	// (cmd/featurelab/types.go), and registry.go appends it to the diagnostic a pack gets
	// when it uses a type this tool has not implemented. So it has to answer the question a
	// pack author is actually asking -- "what does this mean for my pack?" -- in prose, and
	// it must not carry implementation history. coverage_test.go enforces that.
	Note string `json:"note"`
	// evidence is the reasoning behind this row: the game behaviour and the edge cases that
	// establish what Status and Note assert. Deliberately UNEXPORTED and untagged -- an
	// unexported field with no accessor cannot be serialised to the wire, printed by the CLI,
	// or appended to a diagnostic, so the separation is structural rather than a convention
	// someone has to remember. It is what lets a later pass re-check a claim against a new
	// game version instead of re-guessing it.
	evidence string
}

// FeatureTypeCoverage lists every type the game registers -- 29 in 1.26.50.24. Statuses are
// statements about that version, like everything else here. The count is not repeated in prose
// anywhere it can drift: len(FeatureTypeCoverage) is the count, and coverage_test.go pins it
// against the live builder registry in both directions.
var FeatureTypeCoverage = []CoverageEntry{
	// Entries follow the game's registration order as of 1.26.40.26; types new in a later
	// version are grouped at the end, which is the only grouping here that means anything.
	// Read Status, and CoverageSummary() for the live counts -- there are deliberately no
	// "implemented"/"partial" section markers, because they duplicate the Status field and go
	// stale the first time a status moves.
	{TypeID: "minecraft:aggregate_feature", Status: StatusImplemented},
	{TypeID: "minecraft:sequence_feature", Status: StatusImplemented},
	{
		TypeID: "minecraft:conditional_list",
		Status: StatusImplemented,
		Note: "Chooses between features by Molang condition. `conditional_features` is required, and " +
			"each entry needs `places_feature`; its `condition` is optional (as of game version 1.26.50), and an " +
			"absent condition is simply always true. `early_out_scheme` is optional and defaults to " +
			"`none` (game version 1.26.40 defaulted to `condition_success`) -- a file that relied on the " +
			"older default behaves differently now. Under `none` every entry whose condition passes places, and the " +
			"list reports the last placement that succeeded. `condition_success` stops at the first " +
			"entry whose condition passes, whether or not that entry placed anything. " +
			"`placement_success` keeps walking past entries that failed to place until one succeeds. If " +
			"an entry's `places_feature` cannot be resolved -- or the recursion guard refuses it -- the " +
			"whole list ABORTS there, and whatever earlier entries already placed stays placed. " +
			"Conditions evaluate in the `world_gen` Molang namespace, with variable.originx/y/z and " +
			"variable.worldx/y/z both published, holding the same values.",
		evidence: "Vanilla behaviour as of 1.26.50.24: conditional_features is required and each " +
			"entry's places_feature is required; condition is optional (it was required in 1.26.40.26) " +
			"and an absent one is constant true, evaluated in the world_gen Molang namespace. " +
			"early_out_scheme is optional: condition_success=0, placement_success=1, none=2, and the " +
			"default is none (it was condition_success in 1.26.40.26). Under none every true condition " +
			"places and the result is the LAST successful placement, engaged iff any placed; under " +
			"condition_success the first true condition ends the list whatever it placed; under " +
			"placement_success the walk continues past failed placements. An unresolved " +
			"places_feature (\"Feature not found!\") or a recursion-guard denial ABORTS the whole list " +
			"but returns the accumulated result, so earlier none-scheme successes survive (in " +
			"1.26.40.26 an unresolved entry was skipped instead). variable.originx/y/z are published " +
			"alongside variable.worldx/y/z with the same values. aggregate_feature's `early_out` and " +
			"this `early_out_scheme` are two unrelated enums that share a word (different strings, " +
			"values and fields), so they are deliberately not unified. Pinned by " +
			"conditional_list_test.go.",
	},
	{
		TypeID: "minecraft:ore_feature",
		Status: StatusImplemented,
		Note: "Ore vein placer. `count` and each `replace_rules[].places_block` are required; " +
			"`replace_rules` itself, `discard_chance_on_air_exposure` and `replace_rules[].may_replace` " +
			"are optional. WORTH KNOWING: omitting `replace_rules` is legal and the file loads, but the " +
			"feature then places NOTHING. It is not free, though -- the emptiness check happens AFTER " +
			"the angle draw and both Y-bound draws, so a rules-less vein still spends three values " +
			"from the feature's random stream and shifts whatever is placed after it in the same " +
			"chain. This tool warns about the missing rules instead of reporting a load error, because " +
			"the game reports no error either; the feature just silently does nothing. ONE REMAINING " +
			"GAP: the sine and cosine that set the vein's axis and its radius curve are computed at " +
			"full precision here, where the game reads them from a coarse lookup table -- a difference " +
			"of roughly one part in ten thousand in the angle, which can move a boundary cell. Several " +
			"other feature types share that lookup, so it is being closed once rather than separately " +
			"here. The gap this note used to disclose -- vein geometry computed in 64-bit floating " +
			"point where the game uses 32-bit -- is CLOSED.",
		evidence: "Schema: count and replace_rules[].places_block required; " +
			"discard_chance_on_air_exposure, replace_rules and replace_rules[].may_replace optional. " +
			"Optional and non-empty are separate: both arrays carry a minimum size of 1, and a shorter " +
			"array fails validation of the whole document (\"Array too small (%d < %d)\"). So an ABSENT " +
			"replace_rules loads and then places nothing (warned here, as the game reports no error), " +
			"while an explicitly EMPTY one is refused, with a message naming the spelling that works. " +
			"Placement: the empty-rules bail happens AFTER the angle float draw and both nextInt(3) " +
			"calls, so three draws are spent first. The whole vein is float32 with no fused " +
			"multiply-add: count is kept as float32(count) and float32(1)/count, and the interpolation " +
			"multiplies by that reciprocal instead of dividing. Converting a float position to a block " +
			"position is a plain floor, so the bounding box is floor(centre +/- radius); the membership " +
			"test starts its loop floats at min+0.5 and compares (dx*dx+dy*dy)+dz*dz against radiusSq.",
	},
	{TypeID: "minecraft:scan_surface", Status: StatusImplemented},
	{
		TypeID: "minecraft:scatter_feature",
		Status: StatusImplemented,
		Note: "Scatters a delegated feature over a volume, one `distribution` per axis. Two engine " +
			"behaviours are worth knowing if you write Molang here, because both surprise people and " +
			"this tool reproduces them: variable.originx/y/z hold the scatter origin, while " +
			"variable.worldx/y/z are filled in ONE AXIS AT A TIME as each coordinate is resolved, each " +
			"holding that axis's absolute world coordinate -- so an expression for a later axis can read " +
			"an earlier axis's result, and `iterations` and `scatter_chance` see whatever world* already " +
			"held. And the iteration index counts DOWN, which is what sets the visit order for the grid " +
			"distributions. BOTH SCHEMA SHAPES ARE SUPPORTED: a file declaring a format_version " +
			"below 1.21.10 writes the parameters as flat keys on the feature body (`iterations`, " +
			"`x`, `y`, `z`, `scatter_chance`, `coordinate_eval_order`) rather than inside " +
			"`distribution`, and that shape is read here too. The two are mutually exclusive, as " +
			"in the game: writing `distribution` in an older-versioned file, or the flat keys in " +
			"a newer one, is reported rather than quietly accepted.",
		evidence: "Molang: variable.originx/y/z are set from the origin and nothing else, while " +
			"variable.worldx/y/z are written per axis as each coordinate resolves, each holding that " +
			"axis's ABSOLUTE coordinate -- so a later axis reads an earlier axis's result and " +
			"iterations/scatter_chance read whatever world* already held. The iteration index counts " +
			"DOWN, reversing every grid distribution's visit order. The grid index carried to the next " +
			"axis is (index*stepSize + gridOffset)/modulus with no min term (signed division for the " +
			"modulo, unsigned for the carried index). Draw kinds: `triangle` draws nextInt(half+1) -- " +
			"INCLUSIVE -- and its half2 comes from the raw (max-min), not the negative-corrected range; " +
			"`jittered_grid`'s jitter is a bounded integer draw with bound stepSize; the gaussian " +
			"family draws nextInt(b)-nextInt(b) pairs. Unchanged in 1.26.50.24. scatter_chance: a " +
			"failing fraction check falls through to the percent field, which the object form never " +
			"writes and which therefore stays at 100, so it passes. Load-time rewrites, each logged and " +
			"then substituted rather than refused: denominator <= numerator -> denominator 1; a " +
			"CONSTANT percent outside (0,100] -> 100, so `scatter_chance: 0` ALWAYS scatters; a " +
			"negative constant `iterations` -> 1. numerator and denominator are 32-bit integers, so " +
			"{1.5, 4} runs as 1/4. Pinned by scatter_semantics_test.go and scatter_chance_test.go. " +
			"Bit-parity of the underlying generator across distribution kinds is deferred.",
	},
	{
		TypeID: "minecraft:search_feature",
		Status: StatusImplemented,
		evidence: "Transactional wrapper: a SetBlock inside a search reports exactly what the unwrapped " +
			"target reports (for *volume.Volume, whether the position is inside it), and a refused " +
			"write is not readable back out of the buffer. Write attempts are charged against the " +
			"write budget when they are BUFFERED and not again when replayed, so a runaway delegate " +
			"hits the same budget inside a search as outside one. required_successes has a default of " +
			"1 but no schema bound, so 0 loads with a warning; Place() compares the success count for " +
			"EQUALITY after incrementing, so 0 never matches and the transaction is discarded. Open: " +
			"whether the game tests == or >= (indistinguishable for values >= 1). Negatives and " +
			"fractions are refused. search_axis is required; its enum is -x=0, +x=1, -y=2, +y=3, -z=4, " +
			"+z=5 (constructed default +y, unreachable because the key is required). Loop order per " +
			"axis, outer/mid/inner: -x{x-,z-,y+} +x{x+,z+,y+} -y{y-,x-,z+} +y{y+,x+,z+} " +
			"-z{z-,x+,y+} +z{z+,x-,y+} -- the innermost loop always ascends, and the middle loop " +
			"follows the outer's sign for the x/y families but INVERTS it for the z family. Pinned by " +
			"features/search_axis_order_test.go, which walks a 2x2x2 volume per axis.",
	},
	{
		TypeID: "minecraft:single_block_feature",
		Status: StatusPartial,
		Note: "Places a single block, subject to attachment and rotation rules. Implemented in full: " +
			"`enforce_placement_rules` and `enforce_survivability_rules` (both REQUIRED by the schema, " +
			"and both no-ops during world generation -- the engine's own checks always pass there), " +
			"`randomize_rotation`, `may_attach_to` including its `all`/`sides`/`diagonal` group keys and " +
			"`auto_rotate` (which defaults to TRUE), and `may_not_attach_to`. How attachment actually " +
			"works: top, bottom and the diagonals are hard gates checked individually, and only the four " +
			"CARDINAL sides are counted against `min_sides_must_attach`, an integer whose default is 4; " +
			"a direction you did not configure counts as attached for free. " +
			"ROTATION NOW ROTATES. When a rotation fires the bench rewrites the placed block's own " +
			"directional state the way the game does, for all sixteen state families the engine handles " +
			"-- block_face, cardinal_direction, facing_direction, pillar_axis, portal_axis, rail, torch, " +
			"lever, stairs, coral, sign, vine and multiface bits, and jigsaw orientation. Two things " +
			"about that are worth knowing before you read a preview. First, the rewrite is an absolute " +
			"SET, not a turn: the state you wrote in `places_block` is discarded, and the direction the " +
			"rotation names replaces it. A block you wrote as `pillar_axis: y` comes out `x` or `z`. " +
			"Second, with a bare `may_attach_to: {}` all four sides match for free and the LAST one wins, " +
			"so the block always comes out facing west -- writing four files that differ only in the " +
			"state they place gets you four identical results, in the game as much as here. " +
			"WHY THIS IS STILL PARTIAL, and it is a much narrower gap than it was: the game decides " +
			"whether to rewrite a state by asking the block's TYPE whether it can ever carry that " +
			"state, and this bench now asks the same question of its own catalogue of 1,259 vanilla " +
			"types. A VANILLA block therefore rotates whether or not you spelled the state out -- a " +
			"bare `places_block: \"minecraft:torch\"` comes out `torch_facing_direction: west`, a bare " +
			"`minecraft:carved_pumpkin` comes out `minecraft:cardinal_direction: west`. WHAT REMAINS " +
			"is every type OUTSIDE that catalogue: your own pack's blocks, another add-on's, and any " +
			"vanilla id newer than the catalogue. For those the bench can still only see the states " +
			"your `places_block` spells out, so a bare `wiki:my_block` is placed unrotated where the " +
			"game would turn it, while the same block written with " +
			"`\"states\": {\"minecraft:cardinal_direction\": \"north\"}` rotates to west like any " +
			"vanilla one. That holds even for a block YOUR OWN pack declares with the " +
			"`minecraft:placement_direction` trait: the catalogue is vanilla-only, this type does not " +
			"read the trait (multi_block_feature is the one type that does), and nothing warns about " +
			"it -- so write the state out if you want the preview of a custom block to be right. " +
			"Separately, for ten of the sixteen families the direction the game picks is exact but the NAME that " +
			"direction is written under is taken from vanilla block definitions rather than from a " +
			"table the game documents; those ten warn at load time when you use them. The " +
			"three families packs most often rotate -- block_face, cardinal_direction, pillar_axis -- " +
			"are not among them and do not warn. Because `auto_rotate` defaults to TRUE, any file that " +
			"writes `may_attach_to` (even a bare {}) is rotated by the game. " +
			"THE OLDER SCHEMA SHAPE IS NOW ENFORCED: in a " +
			"file declaring a format_version below 1.21.40, places_block is a single block " +
			"reference rather than a weighted list, and randomize_rotation, may_not_attach_to and " +
			"may_attach_to.diagonal do not exist at all. Writing the weighted array there is an " +
			"error here, as it is in the game (the key is required, and an array cannot satisfy " +
			"it); the three younger keys are reported and dropped, so an old-version file behaves " +
			"here the way it behaves in the game rather than better.",
		evidence: "Rotation is ported in block/rotate.go: sixteen state-family arms, each an absolute " +
			"SET keyed on the rotation value. Rotation is gated on whether the block TYPE declares the " +
			"state, answered from block/vanilla_states_table.go (1,259 vanilla types with their state " +
			"domains and defaults); a type the table does not know -- a pack's own block -- falls back " +
			"to the states spelled out in places_block. Measured against a four-file pack: bare " +
			"minecraft:torch -> torch_facing_direction west, bare minecraft:carved_pumpkin -> " +
			"minecraft:cardinal_direction west, bare custom block -> unrotated (still unrotated when " +
			"the pack's own blocks/ declares it with the minecraft:placement_direction trait, which " +
			"only Palette.HasCardinalDirectionState reads and only multi_block_feature asks), custom " +
			"block with cardinal_direction north written out -> west. What keeps this Partial: (a) " +
			"that fallback for non-vanilla types, silent (the trait case does not even draw the " +
			"unknown-block-name warning) and visible in the placed block, the same class of gap that " +
			"keeps horizontal_tree_decoration_feature Partial; (b) for ten of the sixteen families " +
			"the value-to-token spelling is inferred from vanilla state definitions, and " +
			"block.InferredTransformStates drives a " +
			"load-time warning for exactly those (block_face, cardinal_direction and pillar_axis are " +
			"confirmed); (c) only rotation values 0-3 are modelled -- TransformBlock returns the block " +
			"unchanged for 4-24, which this feature cannot reach (attachment passes 0/1/2/3 and " +
			"randomize_rotation draws over 4). rail_direction's mapping holds only a few " +
			"non-horizontal values, so a horizontal direction is SET to 0, as in the game. Schema: " +
			"enforce_placement_rules and enforce_survivability_rules are REQUIRED and are no-ops during " +
			"worldgen (the placement and survivability checks always pass there); randomize_rotation, " +
			"may_not_attach_to and may_attach_to.diagonal exist from format_version 1.21.40. " +
			"Attachment: top/bottom/diagonals are individual hard gates, only the four cardinal sides " +
			"count against min_sides_must_attach (an int, default 4), and unconfigured directions count " +
			"for free; auto_rotate defaults to true. randomize_rotation's draw is a raw unsigned draw " +
			"taken modulo 4, NOT a bounded integer draw, and is taken whether or not the rotation " +
			"changes anything. Pinned by single_block_attach_test.go and single_block_rotation_test.go.",
	},
	{
		TypeID: "minecraft:snap_to_surface_feature",
		Status: StatusPartial,
		Note: "Scans for a surface and delegates to another feature at the snapped position. " +
			"Two things to know before writing one. First, `vertical_search_range` was RENAMED to " +
			"`search_range`, and which name your file must use depends on the format_version it " +
			"declares: below 1.26.50 only the old name is accepted, at 1.26.50 and above only the new " +
			"one, and the wrong name for your version is rejected rather than quietly honoured. Second, " +
			"if you omit `surface` the default is FLOOR, not ceiling -- this tool said ceiling until " +
			"2026-08-15 and was wrong about it in every build, so a pack that relied on the old " +
			"behaviour will snap the other way now. New in 1.26.50.24: `surface: \"wall\"` tries the " +
			"four horizontal directions in a random order, and `allow_non_air_placement` lets a snap " +
			"that starts inside a solid block escape outwards instead of failing. The scan reaches a " +
			"surface at exactly `search_range` blocks, and a range below 2 checks the block next to the " +
			"origin rather than the origin itself. With no `allowed_surface_blocks` the surface test is " +
			"now the real per-face one: the game asks whether the candidate block can support something " +
			"on the specific face the scan arrived at, which is not the same as asking whether it is " +
			"solid. Expect a floor scan to accept a top slab, a right-way-up stair, a fence, a wall, a " +
			"pane and glass, and to REFUSE a bottom slab, farmland, a dirt path, a chest, leaves, a " +
			"carpet, a torch and a snow layer that is not at full height; a ceiling scan mirrors most of " +
			"those. Blocks your own pack defines are treated as supporting every face, which is what the " +
			"game does with any block that does not opt out -- naming one `..._stairs` does not give it " +
			"a stair's behaviour, in this tool or in the game. STILL APPROXIMATE: a handful of enum " +
			"states (a stair's or shelf's facing, a chain's axis, a grindstone's attachment) are matched " +
			"by their documented value names rather than by the numbers the game stores, so an unusual " +
			"spelling falls back to that block's default orientation.",
		evidence: "Rename gate: below format_version 1.26.50 the schema has `vertical_search_range` " +
			"(required); at or above it, `search_range` (required). Both set the same int, so it is one " +
			"key with two names and no version accepts both. allow_non_air_placement (new in " +
			"1.26.50.24) is an optional bool defaulting to false: when the origin is neither air nor " +
			"water (lava counts as a solid start) the scan walks the OPPOSITE direction while the cell " +
			"is non-air and non-water, confirms the open cell it escapes into, and places at origin + " +
			"dir*(steps + (embed^1)). Surface enum: ceiling 0, floor 1, wall 2, random_horizontal 3 " +
			"(random_horizontal was 2 before 1.26.50.24); an absent `surface` defaults to FLOOR in " +
			"every version. wall: the direction array [NORTH, EAST, SOUTH, WEST] is shuffled by an " +
			"ascending Fisher-Yates with integer draws of bounds 2, 3 and 4 in that order, all taken " +
			"before any searching; random_horizontal draws exactly one boolean (even -> floor). All " +
			"modes: the walk starts at pos+1, reaches exactly `range` cells, and range<2 confirms the " +
			"NEIGHBOUR rather than the origin. With an empty allow-list the confirm is the per-face " +
			"support test modelled in block/support.go: every block supports every face unless its " +
			"class removes that; a pack's own blocks support every face, which is why name-based stair " +
			"families are applied only in the minecraft: namespace. What keeps this Partial: " +
			"allowed_surface_blocks matching through MatchSet.Contains is an assumed equivalent of the " +
			"game's comparison, and the integer-to-name step for cardinal_direction, pillar_axis, " +
			"vertical_half and attachment follows Bedrock's documented value order. A few support " +
			"tables (stair support, opposite face, trapdoor facing, top snow height) are marked in " +
			"block/support.go as wanting a re-check against 1.26.50.24.",
	},
	{
		TypeID: "minecraft:structure_template_feature",
		Status: StatusImplemented,
		Note: "Stamps a structure file into the world, gated by `constraints`. Implemented: " +
			"`facing_direction` (`south`/`west`/`north`/`east`/`random`, and an absent key means south), " +
			"`rotate_around_center`, `ground_level`, `adjustment_radius`, and all four constraints -- " +
			"`grounded`, `unburied`, `block_intersection` and `leveled` -- each over the same sample " +
			"points the engine uses. A VOID cell and a cell holding explicit `minecraft:air` both count " +
			"as empty for `grounded`, `unburied` and `leveled`: a .mcstructure exported from a structure " +
			"block writes empty-but-selected cells as air, and counting those as occupied made this tool " +
			"refuse placements the game accepts. `minecraft:structure_void` is a real block for that " +
			"test and still contributes a point. `block_intersection` checks only the MOTION-BLOCKING " +
			"cells unless `only_check_intersection_for_motion_blocking_blocks` is written as false: the " +
			"field's engine default is true, so a file that never mentions it gets the narrow check. " +
			"`leveled` scans the rows from `max_steepness` below each point to `max_steepness` above it " +
			"(default 2) for a solid-over-air transition and refuses the whole placement if any point " +
			"lacks one, so a structure straddling a cliff edge is rejected here as it is in game. " +
			"REFUSED rather than repaired, because the game refuses them too: a `block_intersection` " +
			"with no `block_allowlist` (alias `block_whitelist`), which the schema requires; an " +
			"`adjustment_radius` outside the schema's [0, 16], which nothing in the engine clamps; and a " +
			"negative `ground_level`, whose schema minimum is 0. THE TWO BLOCK PREDICATES ARE NOW THE " +
			"GAME'S OWN, which is a change worth knowing about because it moves results: " +
			"`block_intersection`'s cell split needs \"does this block stop movement\" and " +
			"`grounded`/`leveled` need \"is this solid enough to stand on\". Both used to be answered " +
			"from this tool's own render classification and are now the per-block answer the game " +
			"gives. They disagree with the old answer for about half the vanilla block list, always " +
			"in the same direction: stairs, single slabs, walls, fences, panes, doors, trapdoors, " +
			"buttons, pressure plates, signs, carpets, candles and chests do NOT stop movement, nor " +
			"do snow layers, cactus, bamboo, ladders, scaffolding or powder snow -- a double slab " +
			"does. Leaves, glass and ice stop movement but are not solid enough to stand on. WHAT IS " +
			"STILL ASSUMED: a block your own pack defines is taken to stop movement and to be " +
			"stand-on-able, which is right for an ordinary custom cube and wrong for one whose " +
			"collision box was removed; this tool does not read a custom block's material. " +
			"`unburied`'s own air test is exact. ONE THING `facing_direction` DOES NOT DO: it turns " +
			"POSITIONS, not states. Every cell is written with exactly the block the structure file " +
			"holds, states included, so a structure full of stairs or logs comes out of a quarter " +
			"turn facing the way it was authored. `fossil_feature`, the other type that stamps a " +
			"structure file, is the opposite -- it rotates its bone blocks' `pillar_axis` on a " +
			"quarter turn -- so do not read one across to the other.",
		evidence: "facing_direction enum: south=0 west=1 north=2 east=3 random=255, absent means south. " +
			"Sample points: grounded samples (x, clamp(ground_level), z) and tests the row ONE BELOW " +
			"the ground row; unburied samples the fixed top row (sizeY-1), skips columns whose top-row " +
			"cell is void, and tests (x, sizeY, z); leveled uses grounded's points and max_steepness " +
			"defaults to 2. grounded, unburied and leveled skip EXPLICIT minecraft:air in its default " +
			"state as well as void (a missing block resolves to air); cave_air and void_air are not " +
			"skipped, and structure_void still contributes a point. unburied's own test is \"is this " +
			"air in its default state\" (name AND every state), so Palette.IsAir is exact there. " +
			"block_intersection has NO air test: non-void cells are PARTITIONED into motion-blocking " +
			"and everything else; the motion-blocking set is always checked and the rest only when " +
			"only_check_intersection_for_motion_blocking_blocks is false (default TRUE). " +
			"block_allowlist (alias block_whitelist) is required; structure_name and constraints are " +
			"required and the other keys optional. adjustment_radius is schema-bounded to [0, 16] and " +
			"never clamped (\"Value '%d' outside valid range [%d, %d]\"); ground_level has a minimum " +
			"of 0, so place()'s own clamp only fires on the upper side. Predicates: motion-blocking and " +
			"solid-blocking are TYPE-level (no block state reaches them) and come from block/motion.go " +
			"(1257 vanilla ids); grounded/leveled call block.IsSolidBlocking. A pack's JSON block is a " +
			"plain block type that blocks motion and is solid, whatever its minecraft:collision_box, " +
			"exactly as in the game. The per-block copy is rotateXZ on the POSITION and a verbatim " +
			"SetBlock of the structure's own palette id: block/rotate.go's TransformBlock is never " +
			"reached from this file, so no block state is ever rewritten, in contrast to fossil.go's " +
			"fossilRotateAxis. Whether the engine's own template placement rewrites directional " +
			"states on a rotation has NOT been confirmed either way; what is recorded here is this " +
			"port's behaviour and the fact that the two structure-stamping types differ in it.",
	},
	{
		TypeID: "minecraft:surface_relative_threshold_feature",
		Status: StatusImplemented,
		Note: "Places a wrapped feature only where the origin is strictly deeper than " +
			"`minimum_distance_below_surface` below the surface. The type has exactly two keys, " +
			"`feature_to_place` (required) and `minimum_distance_below_surface` (optional). Four " +
			"near-miss spellings this tool used to accept as well -- `feature`, `wrapped_feature`, " +
			"`places_feature`, `min_distance_below_surface` -- do NOT exist in the engine, so a file " +
			"using one would not load in the game; this tool rejects them with an error naming the real " +
			"key rather than quietly accepting something the game will not. The distance is an integer " +
			"in the engine, so a fractional value truncates. APPROXIMATION: the surface height is looked " +
			"up once per 4x4 column block, matching the engine's granularity, but the VALUE is this " +
			"bench's finished-terrain height standing in for the engine's pre-generation estimate, which " +
			"a bench has no equivalent of.",
		evidence: "Schema: exactly feature_to_place (required) and minimum_distance_below_surface " +
			"(optional, a 32-bit integer, so a fraction truncates). The aliases feature, " +
			"wrapped_feature, places_feature and min_distance_below_surface do not exist and are " +
			"rejected with an error naming the real key. The test fails when surface - min <= " +
			"origin.y (strictly deeper than min passes). The surface is looked up at (x >> 2, z >> 2), " +
			"one value per 4x4 column block; the bench samples GetHeight at that cell's anchor, using " +
			"finished-terrain height in place of the game's pre-generation estimate. Covered by " +
			"surface_relative_threshold_test.go.",
	},
	{
		TypeID: "minecraft:weighted_random_feature",
		Status: StatusImplemented,
		Note: "Picks exactly one entry from a required `features` array by weight. WATCH THE WEIGHTS: " +
			"the engine truncates to whole numbers at every step of the pick, so fractional weights do " +
			"not behave like a float sum would -- two entries weighted 0.5 total zero and NOTHING is " +
			"picked at all. There is also no fallback to another entry when the picked one turns out to " +
			"be unresolvable: the feature just places nothing.",
		evidence: "One required `features` array, one pick, no fallback when the picked entry is " +
			"unresolvable, recursion-guard check after resolution. The shared weighted pick (also used " +
			"by single_block_feature, growing_plant_feature and tree_feature) is a bounded integer draw " +
			"over the total, NOT a float draw scaled by the total, and both the accumulation and the " +
			"subtraction truncate to int at every step -- so two 0.5 weights total 0 and nothing is " +
			"picked. The game's RNG draw kinds are listed in shared.go's WeightedPick comment.",
	},
	{TypeID: "minecraft:height_difference_filter_feature", Status: StatusImplemented},
	{
		TypeID: "minecraft:partially_exposed_blob_feature",
		Status: StatusImplemented,
		evidence: "The water-exposure gate tests for water, and blocks are visited centre-outwards, " +
			"ring by ring. exposed_face is optional and defaults to \"up\"; omitted JSON fields keep " +
			"their constructed defaults. Nothing refuses. Covered by its own tests; see " +
			"features/partially_exposed_blob.go's header.",
	},

	{
		TypeID: "minecraft:tree_feature",
		Status: StatusImplemented,
		Note: "Pairs one trunk shape with one canopy shape. All eight trunk variants are implemented -- the " +
			"plain trunk, acacia, cherry, fallen, fancy, mangrove, mega and poplar -- as are the canopy " +
			"variants, so no part of the JSON surface refuses. New in 1.26.50.24 and implemented here: " +
			"`poplar_trunk` and `poplar_canopy`, a weighted-radius crown with branch arms, optional " +
			"side holes and a branch block that replaces leaves. Also new in this build: a fallen trunk " +
			"now drops through and overwrites leaf litter instead of being blocked by it. APPROXIMATED: " +
			"the engine decides that per block type, and this tool uses a fixed list of the blocks " +
			"vanilla treats that way (leaf litter and the small replaceable plants and snow), so a " +
			"custom block that would be built over in the game may block a fallen log here. Rotation is " +
			"the one bench-wide caveat this type shares with the others: where the engine would rewrite " +
			"a placed block's directional state, this tool places it unrotated and says so at load time. " +
			"The bare `trunk` key is the plain trunk shape -- a straight column that can descend through " +
			"may_grow_through cells when can_be_submerged is set, and that reads may_grow_through " +
			"whether or not it is. It hands its canopy an EMPTY anchor list, so pairing it with " +
			"random_spread_canopy or mangrove_canopy (the only two canopies that read that list) grows " +
			"a bare pole -- engine behaviour, not a bench limit. `mangrove_roots` is a top-level key " +
			"and now runs for EVERY trunk shape, not just the three it used to: the game runs the root " +
			"pass for the feature, before the trunk, and the position it returns moves the trunk's " +
			"origin, so a tree that skipped it grew at the wrong height and spent none of the draws " +
			"that pass costs. The warning that used to say roots were being ignored is gone because " +
			"the skip is gone.",
		evidence: "The per-variant detail lives in features/tree.go's header. Summary of the vanilla " +
			"behaviour it implements: poplar_trunk and poplar_canopy are new in 1.26.50.24. The fancy " +
			"trunk's draws are two floats per cluster attempt, distance then angle, both before " +
			"validation. Since 1.26.50.24 the fallen trunk's descent and per-cell validity walk accept " +
			"a non-empty cell that can be built over (leaf litter). The acacia and cherry defaults are " +
			"unchanged. TRUNK KEYS: the tree feature has eight independent sibling trunk keys and the " +
			"key name alone selects the variant; bare `trunk` is the SIMPLE trunk (the acacia trunk's " +
			"schema requires trunk_width, an object trunk_height and trunk_lean, so the plain shape " +
			"could never parse as one). can_be_submerged only sets the maximum submerged depth (true -> " +
			"255, {max_depth:N} -> N, false/absent -> 0). The simple trunk applies may_grow_through " +
			"always and anchors its canopy one cell ABOVE the topmost log; spawn preparation runs once, " +
			"at the descended position. Three zero-RNG divergences from the simple trunk are marked " +
			"DIVERGENCE in tree.go. ROOTS: the shared placement path runs mangrove_roots for every " +
			"trunk class, in the order get height, place roots (an empty result fails the feature), " +
			"then place the trunk at the returned position. RADIAL WRITE: the block-group write's " +
			"rounding test has exactly two centres per axis at {0,1}, so the accepted region is a fixed " +
			"2x2 stadium however wide core_width is. CANOPIES: the simple canopy has no radius guard on " +
			"its variation_chance corner test (a radius-0 layer spends a roll and may delete its " +
			"centre); the cherry canopy rolls wide-bottom then, only if that failed, corner, with an " +
			"exact corner at radius>=3 skipping the second roll; acacia, pine and spruce canopies have " +
			"no chance roll, and spruce guards radius 0 while acacia does not. Open: the pine canopy's " +
			"radius-0 guard and the roofed canopy's wall-loop corners at core_width >= 3. ALIASES are " +
			"applied at block-descriptor resolution, not parse: a direct rename (minecraft:grass) and " +
			"a state-dependent flattening for log/log2 and leaves/leaves2 that CONSUMES the " +
			"discriminator state (block/aliases.go). DETAILS: acacia leanStart is `height - draw`; the " +
			"acacia branch passes draw position then length when leaning and length then position when " +
			"vertical; the acacia decoration mask's +X/+Z bits apply only when the cell is not already " +
			"on the matching minus edge, leaning branch logs get all four bits, and the vertical sweep " +
			"gets none. The fancy trunk has no lean: it scatters foliage coordinates on a semicircular " +
			"profile gated by foliage_altitude_factor, grows a canopy at each, and draws a limb to each " +
			"whose attachment height clears min_altitude_factor; its line check returns -1 for a clear " +
			"line, a blocked trunk line shortens the tree only past trunk_height.base, sin drives X and " +
			"cos drives Z, and limbs ignore may_replace. The mega trunk places branches BEFORE the " +
			"column, uses full-precision float32 pi, never decorates its top log layer, and rolls one " +
			"chance per enabled direction in west/east/north/south order. base_cluster's num_clusters " +
			"and cluster_radius are bare integers; it draws NextIntBound(64) num_clusters times, always. " +
			"The mangrove trunk draws a boolean unconditionally per non-final log. " +
			"log_decoration_feature's delegation is not permission-gated. Fields registered but never " +
			"read (the mangrove trunk's trunk_width and branch_chance, trunk_decoration.num_steps) are " +
			"accepted silently. mega_jungle needs a 96-block-tall preview.",
	},
	{
		TypeID: "minecraft:vegetation_patch_feature",
		Status: StatusImplemented,
		Note: "Vegetation patch -- a ground (or ceiling) patch of one block with vegetation grown out of " +
			"it. Both `surface: \"floor\"` and `surface: \"ceiling\"` are implemented. Any other value " +
			"for `surface` is rejected, which is what the game does with it too. TWO THINGS TO KNOW. " +
			"First, `replaceable_blocks` is about the GROUND, not the air above it: `ground_block` is " +
			"written into the solid surface the column scan lands on, so a patch listing only " +
			"`minecraft:air` there can never replace anything and drops every column unless the surface " +
			"already holds `ground_block`. List the terrain materials the patch should eat into. Second, " +
			"`waterlogged: true` places NOTHING here. The game still builds the ground patch and then " +
			"hands the columns to a separate water-surface routine; this tool does not implement that " +
			"routine, so it reports failure with zero blocks changed rather than showing you a dry patch " +
			"the game would never have placed -- which means it also skips the ground writes the game " +
			"does make. If you need a patch under water, leave `waterlogged` off and let the delegated " +
			"vegetation feature's own `may_replace` include water.",
		evidence: "surface: \"floor\" steps +1 in Y and \"ceiling\" steps -1; any other value is rejected " +
			"(\"Bad value for surface\"). The int-range draw is min + nextIntBound(max-min) when min < " +
			"max-1, else min (max exclusive). Placement: each horizontal_radius draw is used PLUS ONE, " +
			"so the walked rectangle is 2r+3 per axis and its outermost ring is what " +
			"extra_edge_column_chance gates; the extra-edge guard is an exact zero-compare, so a " +
			"negative chance still spends a draw. The column walk has TWO phases -- move while air, then, " +
			"if that landed in solid, move back while not air -- and its surface test is the block's " +
			"support test (any support type) on the ground cell plus an air test on the air cell. The " +
			"recorded cell, and the first cell the depth fill writes, is one step FURTHER than the air " +
			"cell the walk stops in, so ground_block replaces the surface material and vegetation goes " +
			"in the air cell. depth 0 goes straight to recording the column; only the fill loop's " +
			"non-replaceable break checks whether the column wrote anything. waterlogged: the discard " +
			"comes after every draw and ground write, and the water-surface pass is not modelled, so " +
			"this port reports failure there (both horizontal_radius draws are still taken). " +
			"Unconfirmed strictness kept as-is: replaceable_blocks must be non-empty and vertical_range " +
			">= 1.",
	},
	{
		TypeID: "minecraft:sculk_patch_feature",
		Status: StatusPartial,
		Note: "Sculk patch -- places a central block, then spreads sculk outward from it with a " +
			"cursor-driven growth simulation. The placement gate, `central_block` and " +
			"`extra_growth_chance` are implemented. One default to know, because it is not the one you " +
			"would guess: `central_block_placement_chance` defaults to 0.0, not 1.0. WHY THIS IS " +
			"PARTIAL: the spread and growth simulation runs on the engine's per-block behaviour system, " +
			"which this tool does not have. So a feature configured to actually run it -- " +
			"`growth_rounds` plus `spread_rounds` at least 1, AND `cursor_count` at least 1, AND " +
			"`spread_attempts` at least 1 -- refuses at build time with a diagnostic rather than " +
			"placing a patch missing everything the spread would add. Set `cursor_count` to zero, or " +
			"both `growth_rounds` and `spread_rounds` to zero, and the rest of the type works normally. " +
			"Note that `spread_attempts` is NOT a third way out even though it appears in that " +
			"condition: the schema bounds it to [1, 4], so the field itself refuses 0.",
		evidence: "The placement gate, central_block placement and extra_growth_chance are implemented. " +
			"Defaults: central_block_placement_chance is 0.0 and extra_growth_chance is the int range " +
			"(0,0). The cursor-driven spread and growth simulation runs each sculk charge cursor " +
			"through per-block sculk behaviours (and from there the multiface spreader), which needs a " +
			"block-behaviour system this port does not have. So it refuses at build time whenever " +
			"growth_rounds+spread_rounds >= 1 AND cursor_count >= 1 AND spread_attempts >= 1 -- exactly " +
			"the configurations where the simulation would run. See features/sculk_patch.go's header.",
	},
	{
		TypeID: "minecraft:growing_plant_feature",
		Status: StatusImplemented,
		evidence: "Vertically growing plant column (cave vines, kelp, weeping vines). growth_direction " +
			"is matched case-insensitively, like the enum-string parsing of multipart_block_column's " +
			"`direction`; an unrecognised string is refused here, and the error notes that the game " +
			"most likely ignores it and keeps the default 0 = down (unconfirmed, so this port does not " +
			"pick a direction the author did not write). The weighted picks (height_distribution, " +
			"body_blocks, head_blocks), both int-range draws and the per-layer placement walk are " +
			"implemented, including the asymmetry that a single unobstructed layer anywhere in the " +
			"column guarantees success -- failure requires every configured layer to be unplaceable. " +
			"age: when the age range's max is nonzero, the drawn age is written into the head block's " +
			"growing-plant age state if its type has one, and the head is placed unchanged otherwise " +
			"(Palette.WithIntState, GrowingPlantAge with 26 values). Omitted age defaults to {0,0}. " +
			"Unchanged in 1.26.50.24. See features/growing_plant.go's header.",
	},
	{
		TypeID: "minecraft:geode_feature",
		Status: StatusPartial,
		Note: "Amethyst-geode-style generator: concentric shells around a randomised blob, an optional " +
			"crack cut through them, and `inner_placements` blocks budded onto the walls of the inner " +
			"cavity. The shells, the crack geometry, the whole draw sequence and the traversal order are " +
			"implemented. TWO FIELDS DO NOT DO WHAT THEIR NAMES SUGGEST -- in the engine, not just here: " +
			"the crack roll is against a hardcoded 0.95 rather than your `generate_crack_chance`, and " +
			"`base_crack_size` is never read at all. (Microsoft's own worked example happens to set " +
			"`generate_crack_chance` to 0.95, which is why this is easy to miss.) WHY THIS IS PARTIAL: " +
			"whether a bud may attach to a cavity wall runs through a per-block check, and one step of " +
			"that consults a data-driven multi-block component this tool has no representation for. It " +
			"cannot affect the four vanilla amethyst blocks, so the warning fires only when " +
			"`inner_placements` names a block outside that set, names the block, and fires at most once " +
			"per run.",
		evidence: "Implemented: the 21-field schema; the full draw sequence (point count; the " +
			"unconditional 2608-draw noise construction; five threshold constants; a radius-jitter " +
			"float; a crack roll against a HARDCODED 0.95, not generate_crack_chance; four draws per " +
			"distribution point; a crack-branch selector draw; the per-column cascade's conditional " +
			"float draws); and the traversal order (X and Y each walk up-then-down from the origin, Z " +
			"ascending). base_crack_size is never read. Crack line: the 4-way selector builds a " +
			"3-point line with Y at origin.Y+7/+5/+1 and X and/or Z offset by (2*pointCount)|1. The " +
			"crack-carve test compares crackSum PLUS pointCount * noise * noise_multiplier against the " +
			"threshold. Density: a float32 accumulator of fast-inverse-square-root terms (one Newton " +
			"step, float32) over squared distances built in 64-bit integer arithmetic, compared against " +
			"float32 thresholds -- float64 changes shell identity, so it is transcribed exactly. The " +
			"per-point offset converts to float as UNSIGNED, crack_point_offset as signed. The " +
			"invalid-block abort returns IMMEDIATELY: the offending point draws nothing further and no " +
			"later point is drawn. Buds: face selection tests air-or-water over Up, Down, North, South, " +
			"West, East, and FacingDirection is set through Palette.WithIntState. The vanilla amethyst " +
			"blocks may be placed when the block behind the chosen face (the pre-face position) " +
			"provides full support on that face (geodeMayPlace); a solid anchor removed by the crack, " +
			"or a non-full-cube inner layer, therefore refuses. The placement-filter component is " +
			"implemented (empty conditions deny; allowed_faces down=1, up=2, north=4, south=8, " +
			"west=16, east=32, side=60, all=63; block_filter matched against the neighbour opposite the " +
			"face). What keeps this Partial: the data-driven multi-block component, which needs a " +
			"multi-part block model this codebase does not have; it cannot affect the four vanilla ids, " +
			"so the warning fires only for other inner_placements ids, at most once per Place(). " +
			"Reproducible baseline: `featurelab generate --pack docs/wiki/tools/fixtures --feature " +
			"<geode_amethyst's id> --env underground_stone --seed 3` gives 465 smooth_basalt / 361 " +
			"calcite / 260 amethyst_block / 4 amethyst_cluster. Unchanged in 1.26.50.24.",
	},

	{
		TypeID: "minecraft:cave_carver_feature",
		Status: StatusImplemented,
		Note: "Digs rooms and branching tunnels through solid terrain, removing blocks rather than placing " +
			"them. Fully implemented, including the water gate that stops a carve from opening into an " +
			"aquifer. Four things this tool used to get wrong were fixed on 2026-08-15, so output moved: " +
			"the carve now covers the row ABOVE the row the ellipsoid test uses rather than one row " +
			"lower, the thin-sand and lava-at-depth checks consult that test row rather than the carved " +
			"one, and a room's angle uses full float precision instead of a truncated pi. Nothing about " +
			"the JSON surface changed. Worth knowing when reading this tool's output: these paths have " +
			"no end-to-end regression baseline behind them -- their own tests are what stand behind " +
			"them instead.",
		evidence: "Unchanged in behaviour in 1.26.50.24; features/cave.go's header carries the detail. " +
			"GENERATOR: the carve-volume step receives the room/tunnel step's local generator, which " +
			"matters because the underwater carver's override draws from it (one float per position in " +
			"its magma/obsidian band). PER-NEIGHBOUR RESEED: a and b are two integer draws, each made " +
			"odd in the Java form (round toward zero, set the low bit -- equivalent here, since the " +
			"draws are never negative); for each (ncx, ncz) in a 17x17 window of 289 chunks the same " +
			"generator is reseeded with (ncx*a + ncz*b) ^ baseSeed. CARVE ROWS: the carve volume " +
			"carves [MinY+1..MaxY], one row above the test row, and the carve-block step's trailing " +
			"row is pos.Y-1; addRoom's angle uses full-precision float32 pi. The tunnel step's " +
			"per-step gaussian is one float draw minus another. CACHING: the game can cache a " +
			"neighbour chunk's rooms and tunnels across calls; both paths share the reseed, the draw " +
			"sequence and the overlap test, so this port always takes the uncached shape, where the " +
			"cache-append and the carve are an if/else, not two statements. DEFAULTS: all eight fields " +
			"are optional (fill_with -> no fill, i.e. carve without overwriting; width_modifier -> 0.0; " +
			"the rest 0 or {0,0}). WATER GATE: the carve proceeds when an aquifer is present or the " +
			"carver finds no water in the bounds; the generators this bench models have no aquifer, so " +
			"the gate is CaveScanForWaterGate, supplied as the default by NewCaveEllipsoidVolume. " +
			"WIDTH_MODIFIER: full non-drawing Molang, evaluated once per room call and once per tunnel " +
			"step. math.random and the die-roll functions draw, in the game, from a process-global " +
			"generator shared by every Molang evaluation, which is not reproducible; here they draw from " +
			"a generator private to the Molang context, seeded via DomainCaveWidthModifier, with a " +
			"build-time warning. width_modifier only shapes the ellipsoid radii and gates no draw, so " +
			"the RNG order is unaffected. That substitution does not make the type incomplete (see " +
			"StatusImplemented).",
	},

	{
		TypeID: "minecraft:multiface_feature",
		Status: StatusImplemented,
		Note: "Vine / glow-lichen multi-face growth: puts a face block on the sides of nearby blocks, " +
			"ORing a new face bit into whatever faces the block there already carries, and rolls " +
			"`chance_of_spreading` after each placement that actually changed something to spread " +
			"further. All of it is implemented, spread included -- including the support check that " +
			"decides whether the block can attach to the face at all, which for a while was applied on " +
			"the spread path but not on the main one, so a feature with no `can_place_on` list could " +
			"place a block into open air. ONE DELIBERATE DIFFERENCE FROM THE " +
			"GAME, and a warning says so whenever a spread roll succeeds: the engine shuffles both the " +
			"candidate faces and the spread direction with a generator seeded from operating-system " +
			"entropy, so no two runs of the GAME agree either -- there is no faithful result to match. " +
			"This tool is stable instead, so a preview only moves when you change something. The faces " +
			"are tried in the fixed order the type itself declares them -- down first if " +
			"`can_place_on_floor` is set, then up for `can_place_on_ceiling`, then the four walls as " +
			"north, east, south, west -- and only the spread direction is derived, from your seed and " +
			"the position being spread from. The consequence for you: a block may end up on a different " +
			"face, and spread blocks in different places, than in any one run of the real game. Which " +
			"draws are made, and where they sit in the sequence, match the engine exactly.",
		evidence: "Placement: the face loop tests can_place_on only and stops at the first accepted " +
			"face; the multiface support check is applied downstream, on both the main and the spread " +
			"path (one shared function, using the solid-or-glass kind test -- whether the game's " +
			"check is the general per-face support test is open). A placement that changes nothing " +
			"writes and draws nothing but still returns success. Schema: can_place_on_floor, " +
			"can_place_on_ceiling and can_place_on_wall are REQUIRED; they build the direction pool at " +
			"parse time in schema order, independent of JSON member order: Down, Up, then North, East, " +
			"South, West. search_range is bounded [1,64], chance_of_spreading [0,1], and can_place_on " +
			"is optional with a minimum size of 1 when present. The face bit is ORed into the existing " +
			"multi_face_direction_bits state (64 values) via block.WithIntState, falling back to the " +
			"original block when the write fails. chance_of_spreading is exactly one float draw, made " +
			"only after a change-producing placement. SPREAD: the spreader shuffles with a generator " +
			"seeded from OS entropy, so it never touches the world stream and its results are not " +
			"reproducible in the game. It loops over three spread modes (same position, move to " +
			"neighbour, wrap around a corner), all live for glow lichen and sculk vein. Here the spread " +
			"generator is seeded from the master seed mixed with the spread-from position, zero " +
			"ctx.Random draws (pinned by test), and a warning explains the difference. Faces are tried " +
			"in declared pool order rather than shuffled, which can change WHICH face receives the " +
			"block but not whether a placement succeeds. multiface_test.go pins the draw sequence and " +
			"the state-bit OR. Unchanged in 1.26.50.24.",
	},

	{
		TypeID: "minecraft:fossil_feature",
		Status: StatusImplemented,
		Note: "Buries one of eight hardcoded fossil structures (four spine, four skull) in stone, with " +
			"a proportion of its bone blocks swapped for your `ore_block`. Both keys the type has, " +
			"`ore_block` and `max_empty_corners`, are required and implemented. IT ROTATES THE BONE " +
			"BLOCKS' STATES, not just their positions: a quarter-turn (rotation 1 or 3) swaps each " +
			"bone block's `pillar_axis` between x and z, y passing through, so a rotated fossil's " +
			"ribs still run along the body. That is worth saying next to " +
			"`structure_template_feature`, the other type here that stamps a structure file: THAT one " +
			"copies each block's states verbatim and turns positions only. The two really do " +
			"disagree, and the fossil side is the one carrying an inference -- the exact x/z rule is " +
			"INFERRED (see features/fossil.go's \"Residual\"), while the structure-template path " +
			"applies no state transform at all. THE STRUCTURE FILES ARE " +
			"NOT SHIPPED WITH THIS TOOL -- they are Mojang assets, so you point `--pack` or " +
			"`--structures` at your own installed vanilla behaviour pack (the fossils live under its " +
			"`structures/fossils/`). If one is missing, this refuses at build time and lists every " +
			"absent file by name; it never silently places nothing. One other thing to know: in the game " +
			"a fossil is also skipped when a structure such as a village or a mineshaft already claims " +
			"the spot. This bench contains only the feature under test and no structures at all, so that " +
			"check can never trigger here -- that is a property of previewing one feature in isolation, " +
			"not an approximation of the fossil itself. A fossil is buried 15 to 24 blocks below the " +
			"surface and its anchor is never put lower than ten blocks above the bottom of the area " +
			"being generated, so a preview area ten blocks tall or less has nowhere to put one at all: " +
			"every seed then reports \"No blocks could be placed\". The horizontal offset is drawn east " +
			"and south of the origin over an EXCLUSIVE bound of sixteen minus the structure's rotated " +
			"size, so its largest value is fifteen minus that size -- about twelve for the real " +
			"fossils and never more than fourteen for any template -- and an area narrower than about " +
			"thirty-two blocks loses some placements off that edge too. Both are the preview area being " +
			"too small rather than anything about your JSON -- the game writes into a whole chunk column " +
			"and reports success regardless, so this failure is this tool speaking, and the message " +
			"names the size that caused it. Generate a taller or wider area.",
		evidence: "Structures: behavior_packs/vanilla/structures/fossils/fossil_{skull,spine}_01..04.nbt, " +
			"gzipped big-endian Java structure NBT (nbt/legacy.go), keyed without a namespace " +
			"(\"fossils/fossil_spine_01\", structures/legacy.go). They are not vendored; a missing one " +
			"refuses by name at build time, and tests skip when they are absent. Draw sequence, five " +
			"worldgen draws: nextInt(4) rotation, nextInt(8) structure (0-3 spine, 4-7 skull), " +
			"nextInt(16-rotSizeX), nextInt(16-rotSizeZ), a draw-free height scan, then nextInt(10) " +
			"burial jitter. The structure-overlap abort draws nothing; the empty-corner and " +
			"ore-descriptor failures abort after all five. Placement adds no worldgen draws: the bone " +
			"pass (integrity 0.9) and ore pass (0.1) each build a fresh local generator from the same " +
			"seed and draw one float per template block, so ore positions are a subset of bone " +
			"positions. The structure-overlap check is vacuously false in a bench with no structures; " +
			"the seam remains a func var so a test can prove the zero-draw abort. Deviation: Place has " +
			"a third post-draw failure, \"No blocks could be placed\", that the game lacks (the game " +
			"never reads its placement result and reports success); this port keeps it because a " +
			"write outside the finite preview fails. With the corner check disabled, over 30 seeds: " +
			"10 tall fails 30/30, 11 tall 0/30; at 60 tall, 32 wide 0/30, 24 wide 5/30, 16 wide 16/30, " +
			"8 wide 24/30. It consumes no draws. The burial clamp to MinY()+10 starts firing around 25 " +
			"blocks tall but still places. Unchanged in 1.26.50.24. The block-swap lookup and the " +
			"pillar-axis handling in the data mapping remain inferred.",
	},
	{
		TypeID: "minecraft:nether_cave_carver_feature",
		Status: StatusImplemented,
		Note: "The Nether variant of the cave carver. Same JSON surface as the base carver, and the same " +
			"per-neighbour seed mixing over the same 17x17 chunk window, but its own placement, tunnel " +
			"and room routines with their own draw cadence and walk -- so the same JSON under the two " +
			"ids still does not produce the same caves, just not for the reason this Note used to give. " +
			"Fully implemented. As with the base carver, there is no end-to-end regression baseline for " +
			"it, so its own tests are what stand behind it.",
		evidence: "Unchanged in behaviour in 1.26.50.24; see features/nether_cave.go's header. The " +
			"per-neighbour reseed is identical to the base carver's -- same 17x17 window of 289 chunks, " +
			"formula, odd-maker form and operand pairing (both implementations yield byte-identical " +
			"seeds). The type id is `nether_cave_carver_feature` (older versions used " +
			"`hell_cave_carver_feature`). It has its own placement, feature, tunnel and room logic and " +
			"shares only the carve-volume, carve-block and carver utility helpers. The game's carve " +
			"coordinates are chunk-local; this port converts to world space before every GetBlock/SetBlock " +
			"in the carve loop and the lava pre-scan, and a test at a non-zero chunk origin pins that.",
	},
	{
		TypeID: "minecraft:underwater_cave_carver_feature",
		Status: StatusImplemented,
		Note: "The underwater variant of the cave carver: the base carver's JSON surface plus " +
			"`replace_air_with`, which fills what would otherwise be air below the water line. Fully " +
			"implemented. The same carve-row and threshold-row corrections made to the base carver on " +
			"2026-08-15 apply here, so this type's output moved too. There is no end-to-end regression " +
			"baseline for it, so its own tests are what stand behind it.",
		evidence: "Unchanged in behaviour in 1.26.50.24; see features/underwater_cave.go. It uses the " +
			"base carver's placement, room, tunnel and feature logic unchanged (so the per-neighbour " +
			"reseed is identical) and always runs the uncached path; only the carve volume, the " +
			"carveable-block test and its schema differ. replace_air_with is OPTIONAL with a null " +
			"default. The carve volume draws exactly ONE float per position, only in the band at sea " +
			"level minus 53; it does not use the shared carve-block helper, so thin-sand capping, grass " +
			"relocation and the legacy ocean abort never apply. It grades Y bands with a " +
			"magma-at-25%/obsidian-at-75% layer (band literals 53 and 54, threshold 0.25) and lava " +
			"below. The local water level ignores the position and returns sea level (63 in the " +
			"overworld); the bounds test is the volume range check; air cells are replaced with " +
			"replace_air_with when the four horizontal neighbours (NORTH/SOUTH/WEST/EAST; Y is never " +
			"varied) pass the test. Carveable blocks: the 16 PLAIN coloured terracottas (light_gray, " +
			"not silver; glazed terracotta is not carveable) plus hardened_clay, water, flowing water, " +
			"lava, flowing lava, obsidian and air; compared with the dry carver it drops snow_layer, " +
			"packed_ice, deepslate, calcite, tuff, iron_ore, deepslate_iron_ore, raw_iron_block, " +
			"copper_ore, deepslate_copper_ore and raw_copper_block.",
	},
	{
		TypeID: "minecraft:beards_and_shavers",
		Status: StatusOutOfScope,
		Note: "DELIBERATELY OUT OF SCOPE, and not on a queue: Microsoft's own public feature-type " +
			"reference classifies `minecraft:beards_and_shavers` as internal/deprecated and not usable " +
			"in custom content, so this tool does not implement it and does not plan to. A pack that " +
			"uses it gets a diagnostic saying the type is not implemented here. What the type does, if " +
			"you are trying to identify it in an existing pack: it smooths terrain around ANOTHER " +
			"feature's footprint, raising or lowering the ground in a weighted shell around the feature " +
			"it wraps -- the way a village is bedded into the surrounding landscape.",
		evidence: "DELIBERATELY OUT OF SCOPE: Microsoft's own public feature-type reference lists " +
			"minecraft:beards_and_shavers under \"Internal/Deprecated Components -- either deprecated " +
			"or internal to Minecraft and not usable in custom content\", and this tool does not " +
			"already implement it -- see StatusOutOfScope's doc comment for the policy (and why " +
			"conditional_list/scan_surface/sculk_patch_feature do NOT get this treatment). What a port " +
			"would need: the schema is a required reference to the wrapped feature whose bounds drive " +
			"the smoothing, an array of bounding-box-to-float pairs, a float and a block descriptor. " +
			"Placement pads the bounding box by a kernel radius and, for each position in that grid, " +
			"draws one ranged float added to a precomputed per-position contribution weight to decide " +
			"solid or air. Unresolved: the exact terrain-contribution computation and beard kernel " +
			"values, and the wrapped feature's bounds would have to be resolved (by placing it) first.",
	},
	{
		TypeID: "minecraft:rect_layout",
		Status: StatusOutOfScope,
		Note: "DELIBERATELY OUT OF SCOPE, and not on a queue: Microsoft's own public feature-type " +
			"reference classifies `minecraft:rect_layout` as internal/deprecated and not usable in " +
			"custom content, so this tool does not implement it and does not plan to. A pack that uses " +
			"it gets a diagnostic saying the type is not implemented here. What the type does, if you " +
			"are trying to identify it in an existing pack: it lays OTHER features out on a 16x16 " +
			"chunk-local grid -- each entry of `feature_areas` pairs a feature with a two-value " +
			"`area_dimensions` footprint, and `ratio_of_empty_space` budgets how much of the grid is " +
			"left empty. Its schema and delegation are documented; a port was not attempted because the " +
			"footprint-centering arithmetic, which if implemented wrong would place the delegated " +
			"feature in the wrong spot with no signal that anything had gone wrong.",
		evidence: "DELIBERATELY OUT OF SCOPE: Microsoft's own public feature-type reference lists " +
			"minecraft:rect_layout under \"Internal/Deprecated Components -- either deprecated or " +
			"internal to Minecraft and not usable in custom content\", and this tool does not already " +
			"implement it -- see StatusOutOfScope's doc comment for the policy. What a port would " +
			"need: the schema is ratio_of_empty_space (float, optional) and feature_areas (required, " +
			"minimum 1), each area being feature (required feature reference) and area_dimensions (a " +
			"fixed 2-int array, both required). Placement visits up to 256 cells of a 16x16 " +
			"chunk-local grid; per cell it draws one unbounded integer then one float to decide, against " +
			"a live ratio_of_empty_space budget, whether to attempt a placement; it then linear-probes " +
			"feature_areas (wrapping, starting at the integer draw modulo the entry count) for an area " +
			"that fits the remaining grid and does not overlap cells already occupied in this call, " +
			"delegates through the feature-permission gate, and marks the footprint occupied. " +
			"Unresolved: the footprint-centering arithmetic that turns the half-dimensions and a height " +
			"query into the delegated block position.",
	},
	// ---- new in 1.26.50.24 ----
	//
	// These did not exist in 1.26.40.26. They are listed at the end rather than interleaved into
	// the registration order above, so adding them did not churn the whole table.
	//
	// Availability is banded: the game knows all 29 types, but each type's schema exists only in
	// the format_version band containing its own minimum and every newer band. 27 types sit at
	// the 1.13.0 band; multi_block_feature and multipart_block_column_feature sit at 1.26.40, so
	// a pack declaring an older format_version does not see those two at all.
	// horizontal_tree_decoration_feature is in the 1.13.0 band despite being new to the game.
	{
		TypeID: "minecraft:horizontal_tree_decoration_feature",
		Status: StatusPartial,
		Note: "Places one decoration block against a randomly chosen horizontal side of the origin " +
			"block -- leaf litter and flower beds, the blocks that carry both a cardinal_direction " +
			"and a growth state. places_block is required; allow_adjacent and bark_side_only are " +
			"optional and both default to false. New in 1.26.50.24, but usable from format_version " +
			"1.13.0. REFUSES NOTHING, BUT SKIPS A CHECK: the engine first verifies that your " +
			"places_block actually HAS a cardinal_direction and a growth state, and logs an error " +
			"and places nothing if it does not. This tool now asks the same question of its own " +
			"per-block-type state catalogue, so a VANILLA places_block missing either state fails " +
			"every placement here exactly as it does in the game, and is told which state is " +
			"missing. What is left is the non-vanilla case: a block your pack (or another add-on) " +
			"defines is not in that catalogue, so both gates are assumed to pass and one warning " +
			"says so at load time -- such a places_block can look like it works here and place " +
			"nothing in the game. Relatedly, bark_side_only needs the origin block's pillar_axis: a " +
			"vanilla trunk that declares the state but was placed without one supplies its own " +
			"default, a vanilla type that declares none (dirt, stone) refuses the placement as the " +
			"engine does, and only a non-vanilla trunk still falls back to y with a warning.",
		evidence: "New in 1.26.50.24. Schema: places_block is a required block descriptor; " +
			"allow_adjacent and bark_side_only are optional bools defaulting to false; no other keys. " +
			"Placement: two has-state gates (cardinal_direction, then growth) that log and return with " +
			"ZERO draws; draw 1 is a random horizontal face, nextInt(4)+2, giving N/S/W/E; target = " +
			"origin.neighbour(face), which must be empty; unless allow_adjacent, ten same-block-type " +
			"checks -- origin N,E,S,W, then target Up,Down,N,S,W,E -- where any match fails; if " +
			"bark_side_only, pillar_axis 1 (x) rejects W/E and 2 (z) rejects N/S (0 = y); draw 2 is an " +
			"inclusive draw over (0,1), only on the success path; then the cardinal_direction and " +
			"growth writes and one block write with flag 3. Draw budget 0, 1 or 2. Direction values: " +
			"0=south, 1=west, 2=north, 3=east. The only vanilla blocks with both states are pink_petals, " +
			"wildflowers and leaf_litter. The two has-state gates are evaluated against " +
			"block/vanilla_states.go (block.VanillaBlockKnown + block.LookupVanillaState, asked once " +
			"at build time), so what keeps this Partial is only the type that catalogue does not " +
			"know: for a non-vanilla places_block both gates are assumed to pass and the bench " +
			"places where the game would refuse.",
	},
	{
		TypeID: "minecraft:multi_block_feature",
		Status: StatusImplemented,
		Note: "Places a pack-defined multi-block -- a custom block whose minecraft:multi_block trait " +
			"makes it occupy 2 to 4 cells in a straight line -- as its complete line of parts, never " +
			"partially: a cell that fails the replace check rejects the whole placement, and a part " +
			"that falls outside the generated area erases the parts already written. places_block must " +
			"name the STARTING part; naming anything else, or a block without the trait, loads with a " +
			"warning and then fails every placement, exactly as the game does. randomize_rotation " +
			"costs one draw of four and turns the parts' minecraft:cardinal_direction state (the block " +
			"needs the placement_direction trait for that, otherwise the flag is switched off at load " +
			"with a warning); it does NOT change the direction the line extends in. The rotation is not " +
			"limited to that one state: it is the game's whole block-state rotation, so if your " +
			"places_block also writes pillar_axis, facing_direction, orientation or any of the other " +
			"directional states the game rotates, every one of them is turned by the same draw. The " +
			"part index this places is left alone. Ten of those state families have an exact direction " +
			"but a value spelling taken from vanilla block definitions; a places_block carrying one of " +
			"them loads with a warning saying so. " +
			"enforce_placement_rules parses but has no effect during world generation in this build. " +
			"The trait data is read from the loaded pack's own blocks JSON, so this type only does " +
			"anything for a pack that defines such a block. New in 1.26.50.24 and only available from " +
			"format_version 1.26.40.",
		evidence: "New in 1.26.50.24. Schema: places_block REQUIRED; enforce_placement_rules, " +
			"randomize_rotation and may_replace optional, all zero-defaulted; the whole schema exists " +
			"only from format_version 1.26.40. Parse-time: every places_block rejection stores air, so " +
			"the file loads and every placement fails; randomize_rotation on a block without " +
			"cardinal_direction is switched off. Placement: randomize_rotation draws ONE unsigned value " +
			"over a bound of 4 BEFORE any check, then applies the full block-state rotation " +
			"(block/rotate.go: sixteen arms, each firing cumulatively for every state the block carries, " +
			"each an absolute SET; cardinal_direction 0 north, 1 east, 2 south, 3 west), then sets " +
			"minecraft:multi_block_part per part, which the rotation does not touch. Ten families have " +
			"an inferred value spelling and warn, as in single_block.go. Parts extend origin + the " +
			"direction's face offset times the part index. enforce_placement_rules is a no-op in " +
			"worldgen (both checks it calls return true). Each cell is rejected if it already carries " +
			"any multi-block state (so multi-blocks never overlap, whatever may_replace says) or fails " +
			"may_replace; a failed write rolls back the parts already written. The multi-block " +
			"component comes only from the minecraft:multi_block trait in the pack's blocks JSON, and " +
			"worldgen never takes the gameplay delayed-placement path. Trait JSON: enabled_states must " +
			"be exactly [minecraft:multi_block_part], parts in [2,4] defaulting to 2, direction a " +
			"facing name defaulting to up, and an invalid direction DISABLES the trait. Inferred: the " +
			"rollback filler is air, and the facing names are the standard spellings. Bench-wide " +
			"approximation: a name-only may_replace descriptor matches only the stateless permutation " +
			"here, where the game matches any permutation of the type. See features/multi_block.go " +
			"and block/multiblock.go.",
	},
	{
		TypeID: "minecraft:multipart_block_column_feature",
		Status: StatusImplemented,
		Note: "Places an ordered column of up to four block roles along any of the six directions " +
			"(default up). All four of base_block, middle_block, frustum_block and tip_block are " +
			"REQUIRED even at heights that cannot use them all. Which roles appear depends on the " +
			"height: 1 gives tip only, 2 gives frustum plus tip, 3 gives base plus frustum plus " +
			"tip, and 4 or more gives base, one or more middles, frustum, tip. Give exactly one of " +
			"height_range or weighted_heights -- giving both, or neither, is only a warning and the " +
			"feature still places, which is what the engine does too. may_place_on is checked one " +
			"block BEHIND the origin (opposite the growth direction), not at the origin. may_replace " +
			"truncates the column at the first blocked cell, and the truncated height must still " +
			"reach height_range's minimum -- or, with weighted_heights, the SMALLEST value in the " +
			"list rather than the one that was drawn. An unrecognised direction string is silently " +
			"treated as up. New in 1.26.50.24 and only available from format_version 1.26.40. One " +
			"quirk worth knowing: the feature reports success at the tip position even when the " +
			"effective height works out below 1 and it placed nothing at all.",
		evidence: "New in 1.26.50.24. All four block keys are required. height_range is an optional int " +
			"range defaulting to {-1,-1}. weighted_heights is an optional array of {value, weight} " +
			"int32 pairs; missing keys are 0, numeric and array elements parse as {0,1}, and null, " +
			"string and bool elements are rejected. direction is an optional string defaulting to up; " +
			"it is lowercased, then matched down 0, up 1, north 2, south 3, west 4, east 5, and " +
			"anything else becomes up. may_place_on and may_replace are optional; empty or absent " +
			"allows anything. Mutual exclusion is VALUE-based: height_range counts as given when min " +
			"!= -1 and max != -1, weighted_heights when non-empty; both or neither logs the documented " +
			"message and still places. Placement: may_place_on is tested one step opposite the " +
			"direction, before any RNG (silent failure, zero draws). The height is either a weighted " +
			"pick with a PLAIN int32 weight sum and one nextInt(sum) taken only when the sum is " +
			"non-zero, walking until negative with no bounds check (undefined for all-zero or negative " +
			"weights), or the int-range draw, as tree.go's treeIntRangeValue. may_replace counts " +
			"consecutive passes from the origin itself, n = min(count, height), with zero draws; the " +
			"minimum gate compares n against height_range.min or the SMALLEST weighted value; roles " +
			"are selected with i+2-n; and the result is relative(direction, n-1) even when n < 1. At " +
			"most ONE draw per placement, between the may_place_on gate and the may_replace scan. Not " +
			"modelled: update_bit and persistent_bit normalisation in the allow-list match, observable " +
			"only for descriptors differing solely in those bits -- an edge case in matching, not a " +
			"skipped gate, so this stays Implemented.",
	},
}

// CoverageFor looks up a coverage entry by JSON id. The zero value's ok=false means the id
// is not a feature type the targeted game version registers.
func CoverageFor(typeID string) (CoverageEntry, bool) {
	for _, e := range FeatureTypeCoverage {
		if e.TypeID == typeID {
			return e, true
		}
	}
	return CoverageEntry{}, false
}

// Summary is the counts for the README and the UI, derived rather than restated. Tagged
// lowerCamelCase -- see CoverageEntry's doc comment for the wire this crosses.
type Summary struct {
	Total       int `json:"total"`
	Implemented int `json:"implemented"`
	Partial     int `json:"partial"`
	Missing     int `json:"missing"`
	// OutOfScope is StatusOutOfScope's own count -- kept as a separate field from Missing
	// rather than folded into it, because the two mean different things to a reader: Missing is
	// future-work priority, OutOfScope is a deliberate policy decision not to pursue it. See
	// StatusOutOfScope's own doc comment.
	OutOfScope int `json:"outOfScope"`
}

// CoverageSummary returns the counts for the README and the UI, derived rather than
// restated.
func CoverageSummary() Summary {
	count := func(s CoverageStatus) int {
		n := 0
		for _, e := range FeatureTypeCoverage {
			if e.Status == s {
				n++
			}
		}
		return n
	}
	return Summary{
		Total:       len(FeatureTypeCoverage),
		Implemented: count(StatusImplemented),
		Partial:     count(StatusPartial),
		Missing:     count(StatusMissing),
		OutOfScope:  count(StatusOutOfScope),
	}

}
