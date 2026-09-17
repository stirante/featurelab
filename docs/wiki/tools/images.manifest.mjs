// images.manifest.mjs -- the single list of "which feature, run how, screenshot to where"
// that generate-images.mjs walks. Each entry's `feature` must be an identifier defined
// somewhere under fixtures/features/ (that whole directory is loaded as one pack -- see
// generate-images.mjs's own doc comment). `out` is the PNG filename written under
// docs/wiki/images/, and is what the wiki pages reference directly.
//
// Every field here is also documented in prose on the page that embeds the image -- keep
// them in sync by hand. `origin`, when given, is passed straight through as `--origin` (world
// "x,y,z") -- most entries rely on the CLI's own default (x=0,z=0, preset auto Y, i.e. the top
// of the terrain column) the way the first three entries always have; a couple of the newer
// ones deliberately float the origin in open air above the surface, for a feature type whose
// whole point is what happens between the requested origin and where a delegate actually lands.
export const IMAGES = [
  {
    id: 'single-block-pumpkin',
    feature: 'wiki:pumpkin_patch_block',
    env: 'plains',
    seed: 1,
    out: 'single-block-feature-pumpkin.png',
    // Used only for the report/alt text -- not passed to the CLI.
    note: 'A single weighted pick (pumpkin, the 3-of-4-weight candidate) attached to the grass below it.',
  },
  {
    id: 'scatter-pumpkin-patch',
    feature: 'wiki:pumpkin_patch',
    env: 'plains',
    seed: 9,
    out: 'scatter-feature-pumpkin-patch.png',
    note: '14 scatter iterations delegating to the same single_block_feature above -- 12 attach, 2 fail (rolling terrain under the flat Y=0 offset) and are skipped, exactly as the feature type contract predicts.',
  },
  {
    id: 'ore-diamond-vein',
    feature: 'wiki:diamond_vein',
    env: 'underground_stone',
    seed: 1,
    out: 'ore-feature-diamond-vein.png',
    note: 'A 9-sphere diamond vein cutting through stone, discard_chance_on_air_exposure 0.5 thinning the blob where it breaks into open air. Rendered as a solid cutaway (see below), not ghosted -- a buried feature needs its surrounding material to read as material.',
    // underground_stone is a solid, cave-free fill (see env/environment.go) -- an ore vein
    // buried in it is entirely face-occluded by the surrounding rock (every neighbour is
    // solid, so face-culled meshing draws nothing at all -- see render-entry.mjs's own doc
    // comment on setSlice). This vein's OWN changed cells sit at world x 7-9, y 30-32, z 7-8 for
    // this exact seed (verified by reading the generate result's own `changed`-mask coordinates,
    // not the whole blocks array -- underground_stone's own scatterOres baseline can and does
    // include incidental diamond_ore blobs elsewhere in the volume that are NOT this feature's
    // output; only cells the mask marks changed are this JSON's own placements). maxY must land
    // AT the vein's own top (32), not merely above it: buildMesh only treats a neighbour as
    // non-occluding when that neighbour cell is itself OUTSIDE the slice (see
    // frontend/src/mesher.ts's own doc comment on buildMesh) -- a slice ending a couple of rows
    // higher still buries the vein's top face under sliced-in stone above it.
    //
    // WORTH KNOWING BEFORE RE-TUNING THIS SHOT: since the 2026-08-22 ore geometry fix (the vein's
    // membership test now asks about a cell's CENTRE, not its corner, so every vein moved half a
    // block), this seed's top row -- y 32 -- holds exactly ONE cell, (9, 32, 8), where it used to
    // hold several. The rule above still points at 32, and the image is correspondingly a single
    // cyan face rather than the L-shaped patch it was. Dropping maxY to 31 would expose the
    // five-cell y-31 layer and read much better, at the cost of hiding a real placed cell above
    // the cut. That is a viewing decision nobody has made yet, so the shot is left honest and
    // plain rather than retuned as a side effect of a correctness fix.
    slice: { minY: 29, maxY: 32 },
    // Ghosting (the previous approach here) fixed the "camera fits the whole terrain slab"
    // framing bug but left a buried feature floating in a translucent void, illegible as
    // anything solid. 'solid' fixes that half; on its own it would
    // just be an opaque version of the same problem (a flat gray top-slice plane with cyan
    // poking through, no sense that it's EMBEDDED). What actually sells "embedded in rock" is
    // `size` below: setSlice only ever cuts a horizontal Y-band (frontend/src/mesher.ts's
    // buildMesh takes minY/maxY, nothing on X/Z), so a Y-slice alone can only ever expose a flat
    // top surface, never a vertical wall. But buildMesh's OTHER face-exposing rule -- a face
    // whose neighbour is outside the volume's own X/Z bounds is never occluded, slice or no
    // slice -- still applies, and unlike the slice bounds, the volume's OWN bounds are just
    // `--size`, entirely under this manifest's control. Shrinking the preview to 22x48x22 (vs.
    // the 32-wide default) moves the volume's +X/+Z edges to world 10/10 -- 1 block past the
    // vein's own max x/z of 9 -- so the boundary itself becomes two vertical stone walls meeting
    // in a corner, sitting right next to the vein. DEFAULT_FRAME_DIR (viewer.ts, (1, 0.85, 1))
    // looks at content from exactly that +X/+Y/+Z corner, so those two walls plus the slice's own
    // top cut are the three faces the default camera already looks at -- a real three-face
    // cutaway (two rock walls + a cut top), the vein embedded in a visibly solid block of stone,
    // not a fourth invented camera trick.
    //
    // 1 block of margin, not 0: tried shrinking all the way to 20x48x20 (boundary touching the
    // vein directly, for an even more dramatic "ore visible ON the wall" shot) and it changes the
    // actual result, not just the view -- verified by diffing the `changed`-mask cell list against
    // the unshrunk default: 20x48x20 spans world x -10..9, so the two x=9 cells (9,31,8) and
    // (9,32,8) lose their x=10 neighbour off the edge of the shrunk preview, 8 placed instead of
    // 10. The exposure check (ore-feature.md's own `discard_chance_on_air_exposure` note) reads
    // that missing neighbour back as non-solid, and the 0.5 discard chance -- which never fires
    // anywhere else in this JSON, underground_stone being cave-free -- fires for both purely
    // because of the preview boundary. Re-running the same shrunk size with the file's
    // discard_chance_on_air_exposure set to 0 brings all 10 back, which is what makes it the gate
    // reacting to the edge rather than the geometry changing. That is a limitation of this bench's
    // own out-of-bounds read (a real Bedrock world has no edge there), not the engine, and not
    // something this page's flagship image may silently rely on -- see ore-feature.md's own note
    // on this. 22x48x22 was chosen as the smallest size confirmed (by the same mask diff) to still
    // reproduce all 10 cells at the same positions as the default 32-wide volume.
    size: '22x48x22',
    envMode: 'solid',
  },
  {
    id: 'structure-lamp-post',
    feature: 'wiki:lamp_post_structure',
    env: 'plains',
    seed: 1,
    out: 'structure-template-feature-lamp-post.png',
    note: 'A deliberately asymmetric 1x4x2 structure (fixtures/structures/wiki/lamp_post.mcstructure, see docs/wiki/tools/gen-fixture-structures.mjs) -- cobblestone foundation, oak_log shaft, a glowstone lantern offset to one side -- placed with facing_direction "east" so the rotation is actually visible.',
  },
  {
    id: 'snap-pumpkin-to-floor',
    feature: 'wiki:snap_pumpkin_to_floor',
    env: 'plains',
    seed: 1,
    origin: '0,71,0',
    out: 'snap-to-surface-feature-pumpkin.png',
    note: 'A snap_to_surface_feature scanning DOWN through 8 blocks of open air (origin (0,71,0), well above the plains surface, surface height 63) to find the floor and delegate wiki:pumpkin_patch_block there -- allow_air_placement is left UNSET in the JSON, relying on its true default (see the page\'s own note on what that default actually is).',
  },
  {
    id: 'weighted-random-pick',
    feature: 'wiki:weighted_pick_feature',
    env: 'plains',
    seed: 1,
    out: 'weighted-random-feature-pick.png',
    note: 'A weighted_random_feature choosing between wiki:pumpkin_patch_block (weight 1) and wiki:weighted_pick_alt, a single_block_feature placing minecraft:gold_block (weight 1) -- seed 1 draws the gold_block branch (verified by reading the placed block back out of the result). The seed is chosen so this image differs from the single_block page’s: on seed 3 the pumpkin branch wins and the two renders are byte-identical, which reads as a broken image rather than as a legitimate outcome.',
  },
  {
    id: 'aggregate-pumpkin-pair',
    feature: 'wiki:aggregate_pumpkin_pair',
    env: 'plains',
    seed: 9,
    out: 'aggregate-feature-pumpkin-pair.png',
    note: 'aggregate_feature delegating to wiki:pumpkin_patch_block AND wiki:pumpkin_patch (the scatter_feature from the Scatter Features page) at the SAME, unmodified origin -- a lone pumpkin at the origin plus the 14-iteration scattered patch around it, from one shared origin and one shared Random stream.',
  },
  {
    id: 'sequence-snap-then-scatter',
    feature: 'wiki:sequence_snap_then_scatter',
    env: 'plains',
    seed: 1,
    origin: '0,71,0',
    out: 'sequence-feature-snap-then-scatter.png',
    note: 'sequence_feature chaining wiki:snap_pumpkin_to_floor (finds the floor under a floating origin, places a pumpkin there) into wiki:pumpkin_patch (scatters around wherever step 1 actually landed, NOT the original floating origin) -- the origin-threading contrast with aggregate_feature above.',
  },
  {
    id: 'threshold-deep-gold',
    feature: 'wiki:threshold_deep',
    env: 'plains',
    seed: 1,
    origin: '0,50,0',
    out: 'surface-relative-threshold-feature-gold.png',
    note: 'A surface_relative_threshold_feature delegating to a bare gold-block marker only because origin y=50 is more than minimum_distance_below_surface (5) below the plains surface (height 63, threshold 58) -- the SAME JSON at y=60 fails outright (see the page\'s own tip). Another buried-single-cell feature, so this gets the same solid-cutaway treatment as the ore vein page, not a ghost.',
    // A lone gold block at world (0,50,0), buried in plains' subsurface stone -- fully
    // face-occluded from outside like any buried cell (see ore-feature.md's own note on this).
    // Unlike the ore vein, may_replace/may_attach_to are both absent on wiki:threshold_marker
    // (places unconditionally, no neighbour-exposure roll of any kind), so -- unlike the ore
    // vein's --size 20x48x20 finding -- there is no RNG-affecting boundary artifact to avoid
    // here: shrinking the preview volume changes nothing about what gets placed, only how close
    // the volume's own edge sits to the one cell that did. Shrunk to 6x48x6 (from the 32-wide
    // default) so the +X/+Z boundary sits 2 blocks from the origin cell, and sliced to
    // world Y 48-50 (the gold block's own layer plus 2 below) for the same reason the ore vein
    // needed maxY to land AT its own top, not above it.
    size: '6x48x6',
    slice: { minY: 48, maxY: 50 },
    envMode: 'solid',
  },
  {
    id: 'conditional-list-example',
    feature: 'wiki:conditional_list_example',
    env: 'plains',
    seed: 9,
    out: 'conditional-list-feature-scattered-pumpkins.png',
    note: 'A conditional_list with two entries sharing the SAME unmodified origin: wiki:weighted_pick_alt (gold block) gated on "variable.worldx > 100" (false at worldx=0, so skipped -- no gold anywhere in the shot) and wiki:pumpkin_patch (the 14-iteration scatter_feature from the Scatter Features page) gated on the constant 1 (always true, so it fires). Surface scatter, not buried -- ordinary ghosted ancestors, no cutaway needed.',
  },
  {
    id: 'scan-surface-pumpkins',
    feature: 'wiki:scan_surface_pumpkins',
    env: 'plains',
    seed: 1,
    out: 'scan-surface-feature-pumpkins.png',
    note: 'A scan_surface wrapping wiki:pumpkin_patch_block, one real placement attempt per column across the whole 16x16 chunk containing the origin -- all 256 succeed on plains\' unbroken grass, filling the chunk edge-to-edge (contrast with scatter_feature\'s random, gap-leaving spread on the same terrain type).',
  },
  {
    id: 'search-pumpkin-down',
    feature: 'wiki:search_pumpkin_down',
    env: 'plains',
    seed: 1,
    origin: '0,70,0',
    out: 'search-feature-pumpkin-down.png',
    note: 'A search_feature scanning DOWN (search_axis "-y", search_volume y -10..0) from a floating origin (0,70,0) -- the same 8-blocks-of-open-air setup as the Snap-to-Surface page\'s example, but reached by a generic per-axis volume search instead of a dedicated surface scan. 7 candidate positions fail (open air, nothing to attach to) before the 8th, world (0,63,0), succeeds and commits.',
  },
  {
    id: 'geode-amethyst',
    feature: 'wiki:amethyst_geode',
    env: 'underground_stone',
    seed: 4,
    origin: '0,32,0',
    out: 'geode-feature-amethyst.png',
    note: 'A vanilla-config amethyst geode (filler air, inner_layer amethyst_block, alternate_inner_layer/middle_layer calcite, outer_layer smooth_basalt) carved into solid stone -- 11 amethyst_cluster inner_placements this seed, budding off whichever face the bud-growth check found air or water on. Sliced (see below) to reveal the concentric shells; an unsliced render would show only the solid outer_layer shell.',
    // The geode's own changed cells span roughly world (-1..11, 30..42, -2..12) for this seed
    // (verified by reading the generate result's own baseline-vs-blocks diff, not assumed from
    // max_radius) -- an unsliced render is fully face-occluded from outside (same reasoning as
    // the ore vein and surface_relative_threshold pages: solid outer_layer blocks every face a
    // camera outside the sphere could see). Slicing at the geode's own vertical midpoint (36)
    // exposes a horizontal cross-section straight through the middle of the shell structure --
    // hollow filler core, inner_layer/alternate_inner_layer ring, middle_layer ring, outer_layer
    // ring, in that order from the center out -- the same "cut it in half" view real geode
    // photos use.
    slice: { minY: 8, maxY: 36 },
    envMode: 'solid',
  },
  {
    id: 'cave-carver-tunnels',
    feature: 'wiki:cave_demo',
    env: 'underground_stone',
    seed: 1,
    origin: '0,32,0',
    out: 'cave-carver-feature-tunnels.png',
    note: 'minecraft:cave_carver_feature carving rooms and branching tunnels through solid stone -- fill_with "minecraft:air", so every carved cell reads as blocksCarved, not blocksPlaced/blocksReplaced (see the page\'s own field reference). Carving is confined to the ORIGIN\'S OWN 16x16 chunk column (world x/z 0..15 for this origin) even though place() itself draws RNG from a 17x17 chunk neighbourhood -- see the page\'s own note on this. Sliced (see below) for the same reason the ore vein and geode pages are: a cave sealed in solid stone on every side is fully face-occluded from outside.',
    // Carving in this bench's underground_stone env is enclosed in solid stone on every side (no
    // natural opening to the exterior of the request volume) -- unsliced, every one of this
    // feature's own faces borders either more air (no face drawn) or stone that is ALSO
    // inside the volume's own bounds (occluded), so a plain render shows an ordinary solid stone
    // block, nothing carved visible at all. Slicing at the origin's own Y (32) with a wide band
    // below it exposes a floor-plan-style cross-section through the room/tunnel network at and
    // below that height -- picked over a single thin band because cave carving wanders across a
    // wide Y range (this seed's own carved cells span world Y 8-52) and a thin slice would miss
    // most of the system.
    slice: { minY: 8, maxY: 33 },
    envMode: 'solid',
  },
  {
    id: 'vegetation-patch-floor-pumpkins',
    feature: 'wiki:vegetation_patch_floor',
    env: 'plains',
    seed: 1,
    out: 'vegetation-patch-feature-floor-pumpkins.png',
    note: 'surface: "floor" -- a 9x9 ground patch (horizontal_radius 4) re-surfaced with grass_block (replaceable_blocks ["minecraft:air"], so it only touches cells that were already air above the existing ground), then wiki:pumpkin_patch_block (the same single_block_feature from the Single Block Features page) delegated onto roughly 60% of the kept cells. Ordinary surface feature, ghosted environment, no slice needed.',
  },
  {
    id: 'vegetation-patch-ceiling-roots',
    feature: 'wiki:vegetation_patch_ceiling_demo',
    env: 'void',
    seed: 1,
    origin: '0,10,0',
    out: 'vegetation-patch-feature-ceiling-roots.png',
    note: 'surface: "ceiling" -- the vegetation_patch_feature itself is wiki:vegetation_patch_ceiling (ground_block moss_block, vegetation_feature wiki:hanging_roots_ceiling_block, both new for the ceiling path); wrapped in an aggregate_feature with wiki:ceiling_slab_scatter ONLY so this image has a stone overhang to patch in the first place (void has no terrain of its own) -- that scatter is scaffolding for the screenshot, not part of the feature type being documented. Ceiling scan direction is upward, vegetation grows downward (Facing::STEP_Y[Down]=-1) -- the mirror image of the floor path\'s own downward scan / upward growth.',
  },
  {
    id: 'multiface-glow-lichen',
    feature: 'wiki:glow_lichen',
    env: 'plains',
    seed: 1,
    origin: '0,64,0',
    out: 'multiface-feature-glow-lichen.png',
    note: 'Glow lichen placed at origin (0,64,0) attached to grass below, with chance_of_spreading 0.5 firing and placing a second glow lichen block.',
  },
  {
    id: 'growing-plant-cave-vines',
    feature: 'wiki:cave_vines',
    env: 'void',
    seed: 1,
    origin: '0,10,0',
    out: 'growing-plant-feature-cave-vines.png',
    note: 'Cave vines growing downward from origin (0,10,0) in void environment, placing body blocks and an age-injected head block.',
  },
  {
    id: 'partially-exposed-blob-magma',
    feature: 'wiki:magma_blob',
    env: 'underground_stone',
    seed: 1,
    origin: '0,32,0',
    out: 'partially-exposed-blob-feature-magma.png',
    note: 'A magma blob placed in underground stone with placement_radius_around_floor 3, placement_probability_per_valid_position 0.5, and exposed_face "up". Sliced to reveal the magma cells embedded in stone.',
    slice: { minY: 28, maxY: 32 },
    envMode: 'solid',
  },
  {
    id: 'tree-acacia-branching',
    feature: 'wiki:acacia_branching_tree',
    env: 'plains',
    seed: 3,
    out: 'tree-feature-acacia-branching.png',
    note: 'An acacia trunk leaning diagonally with branch_chance 100, so its single side branch always grows and carries its own smaller branch_canopy -- the two-canopy silhouette the field reference describes. 47 blocks at this seed.',
  },
  {
    id: 'feature-rule-per-chunk',
    // A RULE, not a feature (see generateFeature's own note): the CLI runs it once per chunk the
    // bench covers, from that chunk's own minimum corner. The 32x32 footprint is deliberate --
    // it spans exactly four chunks, so the picture shows the thing the page is about, which is
    // that a rule is invoked per chunk rather than once at an origin.
    rule: 'wiki:rng_rule_a.fr',
    env: 'void',
    seed: 42,
    size: '32x16x32',
    minY: 0,
    out: 'feature-rules-per-chunk.png',
    note: 'One feature rule over four chunks: eight uniform-distribution attempts inside each chunk, all 32 landing, none of them crossing into a neighbouring chunk. The void preset is used so nothing but the rule’s own output is visible.',
  },
  {
    id: 'horizontal-tree-decoration-fallen-log',
    feature: 'wiki:fallen_log_with_litter',
    env: 'plains',
    seed: 1,
    out: 'horizontal-tree-decoration-feature-fallen-log.png',
    note: "A seven-block fallen oak trunk (pillar_axis x) with leaf litter scattered along it. Every tuft sits on a NORTH or SOUTH side: bark_side_only refuses the two x-facing cut ends of an x-axis log, so west and east draws place nothing. The gaps are the ten-probe adjacency rule, which refuses a tuft next to an existing one -- five tufts from seven attempts.",
    // The scene is built by the fixture pack itself, not by an environment preset: no preset
    // provides a horizontal log, and bark_side_only needs one at the origin to mean anything.
    // wiki:fallen_log_with_litter is an aggregate that lays the trunk first and then runs the
    // decoration over the same seven cells, which is also the honest way to show this feature --
    // in a real pack it is never placed on its own either.
  },
  {
    id: 'multipart-dripstone-spike',
    feature: 'wiki:dripstone_spike',
    env: 'plains',
    seed: 7,
    out: 'multipart-block-column-feature-dripstone-spike.png',
    note: 'A seven-block column at the rarest of the three weighted heights, which is the only one that shows the whole role vocabulary: base at the bottom, four repeats of middle_block, then frustum and tip. The commoner draws of 2 and 4 place a shorter column that skips middle entirely.',
  },
  {
    id: 'tree-fancy-oak',
    feature: 'wiki:fancy_oak_tree',
    env: 'plains',
    seed: 3,
    out: 'tree-feature-fancy-oak.png',
    note: "Vanilla's own fancy_oak_tree_feature body: a scaled trunk plus limbs drawn out to each foliage coordinate, every cluster carrying its own canopy. A tall sample: the height draw varies widely, and short draws produce a stunted tree whose foliage sits inside its own trunk.",
  },
  {
    id: 'tree-plain-trunk',
    feature: 'wiki:plain_trunk_tree',
    env: 'plains',
    seed: 3,
    out: 'tree-feature-plain-trunk.png',
    note: "The plain `trunk` key at its plainest: a twelve-log straight column -- no lean, no branch, no direction draw anywhere in it -- with vines rolled against all four horizontal sides of every log, and a `canopy` step pyramid whose widest layer sits two cells below the topmost log, so the last two logs spear up through the crown. Its bottom log is at world Y 62, one below the requested origin of 63: can_be_submerged walked the descent one cell down through a may_grow_through-passing grass block and grew from there.",
    // Deliberately taller than vanilla's own 5..9 oaks. At a 5..9 height the crown's widest
    // layer overhangs the trunk by three cells and the default camera (viewer.ts's
    // DEFAULT_FRAME_DIR, looking down from the +X/+Y/+Z corner at about 31 degrees) hides
    // every log within ~3 cells below it -- measured on the first render of this entry, which
    // came out as a step pyramid with two visible logs under it and no readable trunk at all.
    // The hidden band is fixed by the overhang, not by the height, so making the trunk taller
    // is what buys visible column rather than any camera trick.
    //
    // No slice and no envMode override. Ghost mode is what makes the descended log legible at
    // all: it REPLACED the grass block that was at (0, 62, 0), so it sits inside the terrain's
    // own surface layer, opaque against the translucent ghosted grass around it. A 'solid'
    // render would wall it off behind that grass instead. It is still the subtle half of this
    // picture -- the trunk shape is the obvious half -- so the page states the coordinate in
    // prose rather than asking a reader to measure it off the image.
  },
  {
    id: 'cave-carver-tunnels-origin-96',
    feature: 'wiki:cave_demo',
    env: 'underground_stone',
    seed: 1,
    origin: '96,32,96',
    out: 'cave-carver-feature-tunnels-origin-96.png',
    note: "The SAME fixture, the SAME seed and the SAME slice as cave-carver-tunnels above, moved one chunk-aligned step to origin (96,32,96). 7,097 cells carved inside world x/z 96..111 -- the origin's own 16x16 chunk column again, at the new coordinates -- against 3,229 inside x/z 0..15 at the other origin. The pair is the page's world-versus-chunk-local pin: a carver that quietly used chunk-local coordinates would carve at 0..15 in BOTH pictures, or in neither.",
    // Deliberately the same band as the origin-0 entry so the two images are directly
    // comparable; this origin's own carve happens to reach world Y 8-54 rather than 8-52, and
    // the extra two rows are outside the slice in both.
    slice: { minY: 8, maxY: 33 },
    envMode: 'solid',
  },
  {
    id: 'underwater-cave-flooded-tunnels',
    feature: 'wiki:underwater_cave_demo',
    env: 'ocean',
    seed: 3,
    origin: '0,48,0',
    // NOT the ocean preset's own defaults (min-y 30, 32x48x32), and the difference is not
    // cosmetic. This carver's ellipsoids reach down to world Y 2 at this seed, and a floor at 30
    // leaves most of that outside the bench: the same fixture run at the preset default reports
    // thousands of out-of-bounds writes, which the viewer draws as a separate capture overlay
    // hanging underneath the terrain -- a picture of the bench's edge, not of the feature.
    // Dropping the floor to 0 and giving the volume 64 rows brings the whole carve inside (0
    // out-of-bounds writes, read back off the result) and still reaches the sea: rock up to 47,
    // the sand seabed around 48, the water column from 49 to sea level.
    minY: 0,
    size: '32x64x32',
    out: 'underwater-cave-carver-feature-flooded-tunnels.png',
    note: "minecraft:underwater_cave_carver_feature carving the ocean preset's seabed with fill_with \"minecraft:water\" -- 2,968 cells inside world x/z 0..15, spanning world Y 2..50, and every one of the four blocks this type can write is in the picture. 2,728 water; 47 magma and 47 obsidian on world Y 10 and no other row; 146 lava below it. Nothing it writes is air, so the run reports 2,968 blocksReplaced and zero blocksCarved. The ocean preset is not decoration: its biome carries the \"ocean\" tag, and without that tag this feature abandons every column it touches and writes nothing at all.",
    // Sliced and solid for the same reason the two sibling carver entries are: a cave sealed
    // inside rock is fully face-occluded from outside, and a water cell against stone is
    // occluded exactly like an air one (frontend/src/mesher.ts's occludes(): a solid neighbour
    // culls the face whatever the current cell is). World Y 27 is picked over the origin-aligned
    // cut the base carver's entry uses because the carve is not continuous in Y at this seed --
    // rows 32-35 are empty, so a cut there would land on unbroken stone and show nothing. The
    // three lower fills are not in the cut plane at all; they are visible because the carve runs
    // flush to the bench's own +X/+Z edges, which face culling never occludes.
    slice: { minY: 0, maxY: 27 },
    envMode: 'solid',
  },
  {
    id: 'nether-cave-tunnels',
    feature: 'wiki:nether_cave_demo',
    env: 'nether',
    seed: 3,
    // NON-ZERO ON PURPOSE. This type had a real defect in which chunk-local coordinates reached
    // a world-space block API, and it was invisible at origin 0 because the two agree there. The
    // figure this page leads with is therefore taken a long way from the origin: 1,322 cells,
    // all of them inside world x/z 96..111.
    origin: '96,48,96',
    out: 'nether-cave-carver-feature-tunnels.png',
    note: "minecraft:nether_cave_carver_feature carving netherrack to air at origin (96,48,96) -- 1,322 cells, every one inside world x/z 96..111, the origin's own chunk column. The carve appears in two separated bands (world Y 30-38 and 64-71) because the nether preset hollows a cavern through the middle of the bench and air is NOT on this carver's diggable list: it digs the solid netherrack under and over the cavern and leaves the open space alone.",
    // The lower band is the denser of the two and the one that reads as a room-and-tunnel
    // network rather than as ceiling pockets, so the slice keeps that and cuts the cavern above
    // it away.
    slice: { minY: 24, maxY: 37 },
    envMode: 'solid',
  },
]
