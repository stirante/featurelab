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
//
// An entry with `panels` instead of `feature` is a comparison FIGURE: every panel is generated
// with the entry's own env/seed/origin/size/minY and only the panel's `feature` differs, and all
// of them are rendered into one labelled grid (`columns` across). `framing: 'volume'` fits every
// panel's camera to the request volume rather than to the cells the run wrote, so the panels
// share one camera -- see render-entry.mjs's __flRenderPanels for why that is the right choice
// for a figure and the wrong one for a single image.
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
    id: 'scatter-distribution-kinds',
    // A FIGURE (see the doc comment at the top): the six `distribution` kinds a scatter axis can
    // name, one panel each, with everything else held identical -- 64 iterations, an extent of
    // [0, 15] on x and z, y pinned to 0, seed 42, the void preset so nothing but the placements
    // is visible, and the same 18x4x18 volume framed the same way in every panel.
    //
    // Two things in the fixtures are scaffolding for the picture, not part of what it shows:
    //
    //  - wiki:dist_panel_<kind> is a one-iteration scatter with bare axes x: -8, z: -8 wrapped
    //    around wiki:dist_<kind>, the fixture the page actually quotes. The CLI centres its
    //    volume on the origin and has no way to offset it, and a [0, 15] extent spreads from the
    //    origin in the positive direction only, so without the wrapper half the spread would be
    //    outside an 18-wide volume. A bare axis spends no random draw, so the inner scatter's
    //    positions are exactly those of running wiki:dist_<kind> alone -- verified by comparing
    //    the changed-cell sets: every panel is the bare fixture's own cells shifted by (-8, -8).
    //  - the grid kinds carry step_size 2, which the other four kinds do not read. 2 is chosen so
    //    64 iterations is exactly one visit per lattice cell (an 8x8 lattice over 16 cells): a
    //    step of 4 gives 16 cells visited four times each, which reads as "the grid is sparse"
    //    when what happened is "48 rounds landed on a cell already filled".
    //
    // Why [0, 15] and not [-8, 7]: the grid kinds compute (low + index * step) % (high - low + 1)
    // and do not re-base the result into [low, high], so a negative low end does not centre a
    // grid on the origin -- it puts the first few cells on the negative side and the rest at
    // 0..14, which the page documents as a mistake. Every kind is therefore shown with the extent
    // a feature rule actually uses, and the wrapper does the centring.
    //
    // 'volume' framing, not content: gaussian's 48 cells sit in a 12x11 box and inverse_gaussian's
    // 55 cover the full 16x16, so a content fit would zoom each panel differently and the figure
    // would show the camera moving. All six panels are the same 18x4x18 request volume, so a
    // volume fit is one camera for all of them.
    env: 'void',
    seed: 42,
    origin: '0,1,0',
    size: '18x4x18',
    minY: 0,
    framing: 'volume',
    columns: 3,
    panels: [
      { label: 'uniform', feature: 'wiki:dist_panel_uniform' },
      { label: 'gaussian', feature: 'wiki:dist_panel_gaussian' },
      { label: 'inverse_gaussian', feature: 'wiki:dist_panel_inverse_gaussian' },
      { label: 'triangle', feature: 'wiki:dist_panel_triangle' },
      { label: 'fixed_grid', feature: 'wiki:dist_panel_fixed_grid' },
      { label: 'jittered_grid', feature: 'wiki:dist_panel_jittered_grid' },
    ],
    out: 'scatter-feature-distribution-kinds.png',
    note: 'The six distribution kinds with identical parameters (64 iterations, extent [0, 15] on x and z, seed 42). Distinct cells per panel at this seed: uniform 54 (spread flat over 0..14 -- the top end is excluded), gaussian 48 (a cluster in the middle, 2..13, never reaching either end), inverse_gaussian 55 (the corners and edges, with the middle empty), triangle 57 (a looser cluster that does reach 0 and 15), fixed_grid 64 (an 8x8 lattice, every other block), jittered_grid 64 (one placement somewhere inside each 2x2 lattice cell).',
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
    id: 'structure-facing-direction',
    // A FIGURE (see the doc comment at the top): the four cardinal `facing_direction` values, one
    // panel each, from ONE origin at ONE seed with every other field held identical -- the same
    // wiki:facing_post structure, the same empty `constraints`, the same plains preset, seed 1,
    // the same 3x5x3 volume framed the same way. The four fixtures differ in that one word and
    // nothing else, and "south" is written out rather than omitted so the panel that shows the
    // default reads like the other three in the file.
    //
    // WHY NOT THE LAMP POST THE PAGE'S OWN EXAMPLE USES, because the first build of this entry
    // was refused. Four of wiki:lamp_post's five cells sit ON the structure's own origin column,
    // and rotateXZ leaves that column exactly where it is in all four rotations -- so four fifths
    // of every panel was shared and only the single glowstone lantern moved. west against north
    // came out 1.84% different, under the pipeline's own threshold: the shared thing was blocking
    // the figure, which is the same mistake the tree and snap entries paid for. wiki:facing_post
    // (see gen-fixture-structures.mjs) is the same five cells and the same blocks rearranged: the
    // post stands on the lantern's ARM cell, one along local +Z, and a gold marker is left alone
    // on the origin cell. Four of the five cells then move, the marker stays, and the footprint is
    // still only 3x3 -- which is what keeps each cell large in its own panel.
    //
    // Local +Z and not the diagonal, which also cleared the gate (6.9%) and was rejected anyway.
    // facing_direction names where the structure's local +Z ends up, so a post on that cell lands
    // DUE SOUTH of the marker for "south", due west for "west" and so on, and the picture answers
    // the question a reader actually has. A post on the diagonal cell lands southeast for "south"
    // and southwest for "west" -- a quarter turn, correctly, but a caption nobody can use -- and
    // it stands between the camera and the marker in the "south" panel, hiding the pivot in the
    // one panel that shows the default.
    //
    // The footprint is what sets the scale here, not the height: these panels are 250x650, far
    // taller than they are wide, so the camera fits the volume by its WIDTH and a wider volume
    // buys nothing but smaller blocks. A TALLER post buys nothing either -- it pushes the camera
    // back by as much as it adds (a seven-cell post measured 4.4% between the closest pair against
    // this four-cell one's 4.6%) -- so the post is the lamp post's own height and the marker and
    // post read as one small L that turns. 3x5x3 is the smallest volume holding all four post
    // positions (world x/z -1..1) plus the surface row below them, and all four panels report 0
    // writes out of bounds.
    //
    // min-y 62, one row below the resolved origin, puts the plains surface layer at the floor of
    // the volume: the ghosted 3x3 plate under each post is that one layer, identical in all four
    // panels, and it is the reference that makes "which side" read as a direction at all. Nothing
    // else of the terrain is in the frame.
    //
    // No slice and no envMode override: the whole structure stands in open air above the surface.
    // One asymmetry, stated here and on the page rather than left to be noticed: the viewer's own
    // fixed camera looks from the +X/+Y/+Z corner (viewer.ts's DEFAULT_FRAME_DIR), i.e. from the
    // south-east, so in the "east" panel the post stands between the camera and the marker and
    // clips its near corner. The marker is fully visible in the other three.
    env: 'plains',
    seed: 1,
    minY: 62,
    size: '3x5x3',
    framing: 'volume',
    columns: 4,
    panels: [
      { label: 'south', feature: 'wiki:structure_panel_south' },
      { label: 'west', feature: 'wiki:structure_panel_west' },
      { label: 'north', feature: 'wiki:structure_panel_north' },
      { label: 'east', feature: 'wiki:structure_panel_east' },
    ],
    out: 'structure-template-feature-facing-direction.png',
    note: 'The four cardinal facing_direction values over one 1x4x2 structure from one origin at seed 1. Every panel places the same 5 cells, and the only one that does not move is the gold marker on the structure\'s own origin cell at (0, 63, 0) -- that cell is the pivot, so every rotation leaves it exactly there. The four-block post is the figure, and it stands in the named direction from that marker every time: world (0, 1) for "south", (-1, 0) for "west", (0, -1) for "north", (1, 0) for "east". Closest panel pair: south / west at 4.6% differing.',
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
    id: 'aggregate-sequence-origin',
    // A FIGURE (see the doc comment at the top): the ONE behavioural difference between
    // minecraft:aggregate_feature and minecraft:sequence_feature -- what origin each entry of the
    // list receives -- with everything else held identical. The two panels are byte-for-byte the
    // same JSON but for the type id: the same two entries in the same order
    // (wiki:snap_pumpkin_to_floor then wiki:aggseq_panel_scatter), the same plains preset, the
    // same seed 42, the same floating origin (0, 71, 0), the same volume and the same camera.
    //
    // Why these two delegates and not the two the pages' own examples use. The figure has to
    // isolate WHERE the second entry ran, so the second entry must place wherever it is put:
    // wiki:pumpkin_patch (the pages' own scatter) delegates to wiki:pumpkin_patch_block, which
    // needs grass under it, so at the aggregate's unthreaded origin -- 8 blocks up in open air --
    // it would place nothing at all, and the panel would read as "the aggregate is broken"
    // rather than as "the aggregate ran it somewhere else". wiki:aggseq_panel_scatter delegates
    // to wiki:rng_marker, which attaches to nothing and places unconditionally, so both panels
    // place the same eleven cells and the only thing that moves is their height.
    //
    // What the picture therefore shows, verified by reading the changed-cell coordinates out of
    // both runs: an identical cloud of ten markers at identical x/z, at world Y 71 in the
    // aggregate panel and world Y 63 in the sequence panel, plus the one pumpkin at (0, 63, 0)
    // that wiki:snap_pumpkin_to_floor puts on the floor in BOTH panels -- it is entry one, and
    // entry one gets the same origin either way. The eight-block gap is the whole figure.
    // 11 cells per panel: 12 scatter rounds, two of which land on a cell already filled.
    //
    // Seed 42 rather than the 1 and 9 the two pages' own examples use, and the reason is the
    // pumpkin. The scatter's extent spans the origin, so at some seeds one marker lands on the
    // scatter's own (0, 0) offset -- which in the SEQUENCE panel is exactly the cell the pumpkin
    // is standing on, and the marker overwrites it (verified at seed 3: the sequence panel comes
    // out 11 cells with stone at (0, 63, 0) and no pumpkin anywhere, while the aggregate panel
    // keeps its pumpkin, because there the markers are 8 blocks up). That difference is real
    // behaviour -- two entries of an aggregate genuinely contend for a cell -- but it is not what
    // this figure is about, and it removes the one element the two panels share. At 42 no round
    // lands on (0, 0) and the pumpkin is in both.
    //
    // Volume: 10x12x10 from min-y 62, i.e. world x/z -5..4 and world Y 62..73. Tight on purpose,
    // and tightened twice (see the tree entry's own account of what the 2%-difference gate
    // costs): the markers span x/z -3..3, so a wider volume would shrink the cloud towards the
    // middle of its own panel and leave the two panels differing over a few percent of mostly
    // empty air. min-y 62 puts the volume floor at the plains surface layer, so the terrain is
    // one ghosted plane under the picture instead of filling it -- the same trick the tree
    // figure uses, and the reason the eight-block lift is legible as a height at all.
    env: 'plains',
    seed: 42,
    origin: '0,71,0',
    minY: 62,
    size: '10x12x10',
    framing: 'volume',
    columns: 2,
    panels: [
      { label: 'aggregate_feature', feature: 'wiki:aggseq_panel_aggregate' },
      { label: 'sequence_feature', feature: 'wiki:aggseq_panel_sequence' },
    ],
    out: 'aggregate-sequence-feature-origin.png',
    note: 'The one difference between the two types, from one origin at one seed: the same two entries -- wiki:snap_pumpkin_to_floor then a 12-round scatter of markers -- run first as an aggregate_feature and then as a sequence_feature, from a floating origin (0, 71, 0) eight blocks above the plains surface. Both panels place the same 11 cells: the pumpkin at (0, 63, 0), where entry one snapped to the floor in both, and 10 markers at identical x/z. In the aggregate panel those markers are at world Y 71, because entry two was given the aggregate\'s own origin -- the floating one, in open air. In the sequence panel they are at world Y 63, because entry two was given the position entry one RETURNED. Closest (only) panel pair: 7.7% differing.',
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
    // The note here used to say the fixture's replaceable_blocks was ["minecraft:air"] and that
    // the patch "only touches cells that were already air above the existing ground". Both
    // halves were wrong -- the fixture lists grass_block, dirt and stone, and the ground layer is
    // written INTO the solid surface, never into the air above it -- so it is corrected here
    // against the fixture and against the run's own changed cells.
    note: 'surface: "floor" -- horizontal_radius 4, so an 11x11 walk whose 9x9 interior is kept outright and whose outer ring is kept per column at extra_edge_column_chance 0.3. 66 cells change at this seed: 13 of them minecraft:dirt turning into the ground_block one row below the ground layer (the extra_deep_block_chance hits -- the ground layer itself is already grass_block almost everywhere, and a cell that already holds ground_block is counted rather than rewritten), and 53 pumpkins and jack o\'lanterns from wiki:pumpkin_patch_block (the same single_block_feature from the Single Block Features page) on the columns that won their vegetation_chance 0.6 roll. Ordinary surface feature, ghosted environment, no slice needed.',
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
    id: 'partially-exposed-blob-exposed-face',
    // A FIGURE (see the doc comment at the top): `exposed_face: "up"` against
    // `exposed_face: "down"`, two panels, from ONE origin at (0,47,0) on the ocean preset's
    // seabed with every other field held identical -- the same radius 3, the same magma, the
    // same seed, the same volume framed the same way. The two fixtures differ in that one word
    // and nothing else, which is the only way to show a key that changes no geometry at all.
    //
    // placement_probability_per_valid_position is 1.0, not the page example's 0.5, and that is
    // the whole reason the figure works: at 0.5 the probability knocks its own holes in both
    // panels and the eye cannot tell a refused cell from an unlucky one. At 1.0 the water test
    // is the ONLY thing deciding anything, so every cell missing from a panel is missing
    // because of the word in its label.
    //
    // WHY THE SEABED AND NOT A DRY CAVE. exposed_face reads the world, not the JSON: in ground
    // with no water anywhere the two panels are byte-identical and the pipeline's own
    // near-identical-panels refusal would (correctly) reject the figure. The ocean preset's
    // seabed at this column -- sand up to y 46, water from y 47 -- is the scene that makes the
    // difference exist at all.
    //
    // VOLUME, and why 9x9x9 from min-y 42 is not a framing choice but a correctness one. The
    // water test reads each candidate's six face neighbours, and a neighbour outside the
    // previewed volume reads back as not-water -- the permissive answer (see the page's own
    // `--size` warning). The candidate cube is x/z -3..3 and y 43..49 around the floor cell at
    // (0, 46, 0), so the volume has to hold that cube PLUS one cell of margin on every side:
    // x/z -4..4 and y 42..50. 9x9x9 from min-y 42 is exactly that box and no larger, and both
    // panels reproduce the default 32x48x32 volume's own results cell for cell (199 and 164,
    // same coordinates) -- verified by comparing the changed-cell sets, not just the counts.
    // Anything smaller changes the result; anything larger buys nothing and shrinks the blob.
    //
    // THE SLICE IS AT 46, AND BOTH NEIGHBOURING VALUES WERE TRIED AND REJECTED. This entry cut
    // twice before it cut right, and both failures are the same lesson from opposite sides.
    //
    //  - No slice at all, environment 'ghost' (what this entry was first written as): the
    //    pipeline's panel comparison PASSED it at 5.9% differing, and the picture was still
    //    useless. A blob buried in sand on five sides is face-occluded exactly as the ore vein
    //    is -- ghosting the sand makes it translucent but leaves it a solid neighbour to the
    //    mesher, so every face of the blob that touches sand is culled. Both panels were a
    //    ghosted blue box with one tan quad floating in it. The 2% gate proves two panels
    //    differ; it cannot prove either one shows the subject.
    //  - Slice at 47, to keep up's three y-47 cells and show the water that does the refusing:
    //    REFUSED by the pipeline at 0.43% differing. Row y 47 is water across the middle of
    //    both panels, and water drawn over the top of the blob hides the whole of the
    //    difference underneath it. The shared element is the water, and that is the same trap
    //    the snap-to-surface figure's ceiling plate cost a render for.
    //
    // 46 is the one cut that works, and not by luck: the y-46 layer IS the difference (49 cells
    // against 17), so ending the slice there turns the difference into the picture's own top
    // face, the largest surface the viewer's fixed camera sees. With environment 'solid' the
    // sand around and between the magma reads as material rather than haze, so a missing cell
    // is visibly seabed rather than visibly nothing. The cost is up's three cells at y 47,
    // which are above the cut and not in the picture -- named on the page rather than implied.
    //
    // What the two panels show, read off each result's own changed-cell coordinates: both place
    // three complete 7x7 layers at y 43, 44 and 45, buried on all six sides and identical. They
    // differ only above that. up keeps a fourth complete 7x7 layer at y 46 and three more cells
    // at y 47 where the seabed rises a block; down keeps 17 of that layer's 49 cells -- the two
    // outer edge rows at z -3 and z 3 plus three cells beside them, which are exactly the
    // columns holding sand or gravel rather than water at y 47 -- and nothing at y 47. 199
    // cells against 164; closest (only) panel pair 5.4% differing.
    env: 'ocean',
    seed: 1,
    origin: '0,47,0',
    size: '9x9x9',
    minY: 42,
    framing: 'volume',
    columns: 2,
    panels: [
      { label: 'up', feature: 'wiki:blob_panel_up' },
      { label: 'down', feature: 'wiki:blob_panel_down' },
    ],
    slice: { minY: 42, maxY: 46 },
    envMode: 'solid',
    out: 'partially-exposed-blob-feature-exposed-face.png',
    note: 'exposed_face "up" against exposed_face "down" from one origin at (0,47,0) on the ocean preset\'s seabed -- sand up to y 46, water from y 47 -- with placement_probability_per_valid_position at 1.0 so the water test is the only thing deciding anything. Both panels fill the same three complete 7x7 layers at y 43, 44 and 45, buried on all sides. up also keeps the whole y-46 layer (49 cells) and three cells at y 47: 199 in all. down keeps 17 of the y-46 layer -- the columns with sand or gravel above them rather than water -- and nothing at y 47: 164 in all. Everything else in the two files is identical. Both panels are cut away at y 46 so that layer is the top face you see; the pale material is the seabed itself, and up\'s three cells at y 47 are above the cut.',
  },
  {
    id: 'tree-trunk-kinds',
    // A FIGURE (see the doc comment at the top): the eight trunk keys a tree body can name, one
    // panel each, from ONE origin at ONE seed with everything else held as identical as the
    // schema allows -- the same oak_log, the same plains preset, seed 3, the same 20x12x20 volume
    // framed the same way, and a nominal trunk height of 9 everywhere.
    //
    // Four things in the fixtures are scaffolding for the picture, not part of what it shows:
    //
    //  - THE CANOPY IS SHRUNK TO A MARKER. A tree body must carry a canopy key -- buildTreeFeature
    //    rejects a file without one for six of the eight trunks -- and an ordinary crown buries the
    //    thing this figure is about: at canopy_offset {-3, 0} the plain `canopy` adds ~80 leaves
    //    that hide the trunk completely, and the first render of this figure had four panels that
    //    were the same green blob. Every panel therefore writes `canopy` with canopy_offset
    //    {"min": -1, "max": 0}: a 3x3 layer and a single cell above it, 10 cells at most. That is
    //    small enough to leave the log skeleton visible and big enough to show WHERE each trunk
    //    hands its canopy over, which is itself one of the differences between them -- poplar_trunk
    //    gets only 4 of its 10 cells, because its four branch stubs and its own continuing column
    //    occupy the rest of that layer.
    //  - cherry_trunk writes that canopy at cherry_trunk.branches.branch_canopy rather than on the
    //    feature body, because that is where a cherry tree's canopy is read from; a body-level
    //    canopy key on a cherry tree is accepted and grows nothing. fallen_trunk keeps the
    //    body-level key, which it also never grows -- both are stated on the page.
    //  - may_grow_on, base_block and may_grow_through are written on none of the eight.
    //    may_grow_through is inert on seven of them in this tool (the diagnostic says so) and on
    //    the plain trunk it only matters with can_be_submerged, which no panel sets; the other two
    //    would only add a ground-fixup cell under some panels and not others. Leaving all three out
    //    keeps the eight bodies as close to identical as the schema allows and the pack's `check`
    //    clean.
    //  - min-y 63 puts the volume's floor at the plains surface, so the terrain is below the
    //    picture rather than filling it. The ghosted diamond under each tree is that one floor
    //    layer, and it is the same in all eight panels, which is what makes the scale comparable.
    //
    // Per-kind values that could NOT be shared, because the schemas genuinely differ. Each height
    // field is the narrowest range that samples 15, so no panel's shape is one draw away from a
    // different one: trunk and poplar_trunk trunk_height [15, 16) = 15 (exclusive max);
    // acacia_trunk, cherry_trunk and mega_trunk trunk_height.base 15 with no intervals; fancy_trunk
    // {base 15, variance 1, scale 0.8}; mangrove_trunk {base 15, height_rand_a 0, height_rand_b 0}.
    // fallen_trunk has no height at all, only log_length, set to [6, 7) so its log stays inside the
    // shared volume. The branch sub-object each kind requires or is defined by is written at a
    // comparable size.
    //
    // WHAT THE PANEL-DIFFERENCE GATE ACTUALLY COST, because the next figure will pay it too. This
    // entry was refused three times before it was written. At an ordinary crown, nineteen of the
    // twenty-eight pairs were under 2%. With the crown cut to one cell and a 20x12x20 volume, six
    // pairs still were: the four one-wide columns (trunk, cherry_trunk, mangrove_trunk,
    // poplar_trunk) are the same shape, and at that volume a tree was about 2% of its own panel, so
    // "the same shape" and "the same picture" were indistinguishable. Three changes fixed it, and
    // only the first was about the trees: the crown went from 1 cell to 10 so a canopy's POSITION
    // reads; mangrove_trunk's and cherry_trunk's branches were lengthened so their defining feature
    // is bigger than a nub; and the volume was tightened to 12x19x10, which meant shortening
    // fallen_trunk's log and pulling fancy_trunk's width_scale to 0.6 so the two widest panels
    // stopped setting the frame for the other six. mega_trunk's branch_altitude_factor is {0.2, 0.9}
    // rather than a vanilla-like {0.6, 0.8} for the same reason: the narrower band put every branch
    // level above the trunk's own top and the panel was a bare 2x2 pillar. Closest pair now:
    // trunk / poplar_trunk at 2.9%.
    //
    // Volume: 12x19x10 from min-y 63. Verified against the 40x24x40 volume this was tuned at --
    // every one of the eight panels writes exactly the same cells at the same coordinates in both,
    // and all eight report 0 writes out of bounds -- so the tight volume is framing only, not a
    // boundary artifact of the kind the ore entry below documents.
    env: 'plains',
    seed: 3,
    minY: 63,
    size: '12x19x10',
    framing: 'volume',
    columns: 4,
    panels: [
      { label: 'trunk', feature: 'wiki:tree_panel_trunk' },
      { label: 'acacia_trunk', feature: 'wiki:tree_panel_acacia_trunk' },
      { label: 'cherry_trunk', feature: 'wiki:tree_panel_cherry_trunk' },
      { label: 'fallen_trunk', feature: 'wiki:tree_panel_fallen_trunk' },
      { label: 'fancy_trunk', feature: 'wiki:tree_panel_fancy_trunk' },
      { label: 'mangrove_trunk', feature: 'wiki:tree_panel_mangrove_trunk' },
      { label: 'mega_trunk', feature: 'wiki:tree_panel_mega_trunk' },
      { label: 'poplar_trunk', feature: 'wiki:tree_panel_poplar_trunk' },
    ],
    out: 'tree-feature-trunk-kinds.png',
    note: 'The eight trunk keys, from one origin at seed 3, every trunk 15 blocks tall and every crown cut to a 10-cell marker so the log skeleton is what the picture shows. Cells per panel, logs + leaves: trunk 24 = 15 + 9 (a dead straight column, crown on top); acacia_trunk 27 = 19 + 8 (the column leans and carries one diagonal side branch, and the crown sits on the branch, not on the trunk); cherry_trunk 28 = 20 + 8 (a column with one horizontal branch, and the crown at the branch tip); fallen_trunk 5 = 5 + 0 (a log lying on the ground -- it grows no crown at all, whatever canopy key the file writes); fancy_trunk 405 = 105 + 300 (a trunk that stops short of its own foliage, a limb out to each foliage coordinate, and a canopy on every one of them); mangrove_trunk 38 = 30 + 8; mega_trunk 78 = 69 + 9 (a 2x2 column with branches radiating at drawn angles); poplar_trunk 23 = 19 + 4 (a straight column whose crown sits four cells below the top, so the trunk spears up through it -- and the crown loses five of its ten cells to that column and to the four branch stubs it sits on).',
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
    note: "A seven-block fallen oak trunk (pillar_axis x) with leaf litter scattered along it -- five tufts from seven attempts. Every tuft sits on a NORTH or SOUTH side: bark_side_only refuses the two x-facing cut ends of an x-axis log, so the two attempts that placed nothing are the two whose side came up west or east (2 of 7, not the half an even four-way pick would average). The ten-probe adjacency rule refuses NOTHING at this seed: re-running the same scene with allow_adjacent true -- and again with bark_side_only off as well -- reproduces the same five tufts in the same cells with the same growth states, which is what leaves the bark rule as the only possible cause of the two gaps. The rule does fire at other seeds (at seed 18, allow_adjacent adds a third tuft one cell west of an existing one); it just does not fire here, and the page says so rather than letting the spacing read as its work.",
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
    id: 'multipart-weighted-heights',
    // A FIGURE (see the doc comment at the top): the three heights the page's own example lists
    // in weighted_heights -- 2, 4 and 7 -- one panel each, from ONE origin at ONE seed with
    // everything else held identical. The three fixtures differ in the single `value` inside
    // weighted_heights and in nothing else.
    //
    // WHY A DEGENERATE weighted_heights PER PANEL RATHER THAN THREE SEEDS OF THE PAGE'S OWN
    // FIXTURE. A figure has to hold the seed still and change one word; three seeds of
    // wiki:dripstone_spike would change the seed, which is the one thing a panel comparison may
    // not do. Each panel therefore carries a one-entry weighted_heights whose value is its own
    // label. A one-entry list still sums to a non-zero weight, so all three panels take the same
    // draw and reach the walk at the same point -- the panels differ in the outcome, not in what
    // it cost.
    //
    // FOUR BLOCKS, NOT THE EXAMPLE'S TWO, and that IS the figure. The page's dripstone example
    // writes dripstone_block for both base and middle and pointed_dripstone for both frustum and
    // tip, so a render of it cannot show where one role ends and the next begins -- which is the
    // whole question "which roles appear at which height" asks. The panels use four flatly
    // different blocks instead: gold_block for base, lapis_block for middle, redstone_block for
    // frustum, diamond_block for tip. Nobody would build a spike out of those; nobody can
    // misread which cell is which role either, and the page says so beside the picture.
    //
    // THE STONE CUBE UNDER EACH COLUMN is scaffolding, wiki:multipart_panel_anchor: a
    // single_block stone laid one cell BELOW the origin by a one-iteration scatter with bare
    // x/y/z (the dist_panel_* idiom -- a bare axis spends no random value, so the column's own
    // outcome is exactly what running wiki:multipart_panel_column_<n> alone gives). It is the
    // one element all three panels share, and it is deliberately at the BOTTOM of the frame: the
    // shared thing is what blocks the view in a figure (the tree figure's canopy, the
    // snap figure's ceiling plate, the blob figure's water), and a cube under a column that
    // grows upward occludes none of it. What it buys is the reference that makes the comparison
    // read at all -- all three columns start on the same cell, so the panels differ in where
    // they END -- and it is where may_place_on would look, which is the next thing a reader asks.
    //
    // Volume: 3x8x3 from min-y 0 with the origin at (0,1,0), i.e. world x/z -1..1 and world Y
    // 0..7 -- the anchor cube at Y 0 and the tallest column's seven cells at Y 1..7, with one
    // cell of margin on each side and none above. Tight on purpose: at the 32-wide preset
    // default a one-block-wide column is a hairline and all three panels are the same empty
    // frame. All three panels report 0 writes out of bounds. 'volume' framing, not content: the
    // three columns are 3, 5 and 8 cells tall, so a content fit would zoom each panel to its own
    // column and the figure would show the camera moving instead of the height changing.
    //
    // The margin is free, which is worth knowing before anyone tries to buy scale by removing
    // it: the camera fit floors each axis's half-extent at 2 blocks (viewer.ts's
    // FRAME_MIN_HALF_EXTENT), so a 1-block and a 3-block footprint frame identically. Re-rendered
    // at --size 1x8x1 this entry produces a byte-identical PNG (sha256 fc4c8cb4...), and what
    // actually sets the distance here is that floored footprint against a 332px-wide panel, not
    // the column's own height. Shrinking the volume further changes nothing; the margin is kept
    // because it is honest about where the column's neighbours are.
    env: 'void',
    seed: 1,
    origin: '0,1,0',
    size: '3x8x3',
    minY: 0,
    framing: 'volume',
    columns: 3,
    panels: [
      { label: 'height 2', feature: 'wiki:multipart_panel_2' },
      { label: 'height 4', feature: 'wiki:multipart_panel_4' },
      { label: 'height 7', feature: 'wiki:multipart_panel_7' },
    ],
    out: 'multipart-block-column-feature-weighted-heights.png',
    note: 'The three heights the page\'s example lists in weighted_heights -- 2, 4 and 7 -- from one origin at one seed, with the four roles written as four different blocks so the boundaries between them are visible: gold base, lapis middle, redstone frustum, diamond tip. Read off each run\'s own changed cells: height 2 places frustum and tip and NO base and no middle; height 4 places base, one middle, frustum and tip; height 7 places base, FOUR middles, frustum and tip. The grey cube under each column is one shared stone block laid one cell below the origin, so all three columns visibly start from the same cell.',
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
    //
    // NOT MERGED INTO A `panels` FIGURE WITH cave-carver-tunnels, and the reason is measured
    // rather than aesthetic. A figure's panels share ONE --origin and ONE --size (see
    // generateEntry: only `feature` is swapped per panel), and this pair's whole claim is that
    // the carve lands in the chunk column containing the origin -- two world positions 96 blocks
    // apart. Holding both inside one volume needs it at least 144 wide, and three things follow:
    //
    //  - The bench changes, so the numbers change. underground_stone scatters its ore blobs
    //    across whatever volume it is given, and most ores are NOT on the carver's diggable list,
    //    so the same fixture at the same seed and the same origin carves 3,229 cells at the
    //    preset 32-wide volume and 3,240 at 128 wide -- the differing cells are exactly the ones
    //    where one bench put a coal/redstone/lapis/gold blob and the other did not. The origin-96
    //    run moves the same way: 7,097 against 7,147. A figure would therefore have to restate
    //    every number on the page against a bench that exists only for the picture.
    //  - Each panel's carve would be 16 of 144 blocks across, ~11% of the panel, in opposite
    //    corners of an otherwise unbroken stone plate -- and the room/tunnel network, which is
    //    the CONTENT of both images, stops being legible. The tree entry above paid for exactly
    //    this from the other side and had to tighten its volume to 12x19x10.
    //  - The 2%-difference gate would pass (two patches in opposite corners), so the gate would
    //    NOT catch it. This is the "two panels that differ without meaning anything" case
    //    docs/site/authoring.md says the pipeline cannot refuse for you.
    //
    // A bare-offset wrapper scatter (the dist_panel_* idiom) does reproduce the carve exactly --
    // verified: wrapping wiki:cave_demo in a 1-iteration scatter with bare x/z 0 gives the same
    // 3,229 cells at the same coordinates -- so the idiom is not what blocks this. The frame is.
    // The two pages state in prose that the pair is two cameras and that only the counts are the
    // comparison.
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
  {
    id: 'search-axis-kinds',
    // A FIGURE (see the doc comment at the top): the six `search_axis` values, one panel each,
    // from ONE floating origin in the void with every other field held identical -- the same
    // 5x5x5 search_volume ({min: [-2,-2,-2], max: [2,2,2]}, 125 candidate offsets), the same
    // delegate, the same seed, the same volume framed the same way.
    //
    // WHY THE FIGURE IS BUILT THIS WAY, because the obvious build does not work. search_axis
    // decides the ORDER candidates are visited in, and a search commits at the first position
    // that works -- so with a delegate that only succeeds somewhere specific (a pumpkin needing
    // grass under it, say) all six panels show one block, in six places that differ by a cell or
    // two. Six near-identical smudges. What the six values actually differ in is the VISIT
    // ORDER, so the figure shows the order directly: the delegate is wiki:threshold_marker, a
    // bare gold block that succeeds at every candidate, and required_successes is 30 of the 125
    // available. The search therefore commits after the first 30 positions its axis order
    // reaches, and the shape those 30 cells make IS the loop order.
    //
    // What each panel reads as, and all three are verified off the result's own changed-cell
    // coordinates rather than predicted: the outer loop's first slab is 5x5 = 25 cells, so every
    // panel is one full face of the cube plus a five-cell line into the next slab.
    //
    //   -x  the x=+2 face, then a line at (x 1, z 2)    +x  the x=-2 face, then (x -1, z -2)
    //   -y  the y=top face, then a line at (y-1, x 2)   +y  the y=bottom face, then (y+1, x -2)
    //   -z  the z=+2 face, then a line at (z 1, x -2)   +z  the z=-2 face, then (z -1, x 2)
    //
    // The face says which corner the search starts from; the trailing line says which way the
    // MIDDLE loop counts, and that is the pattern nobody guesses: it follows the outer loop for
    // the x and y families and runs OPPOSITE to it for the two z values. -x's line sits at the
    // z=+2 edge (mid descending with the outer loop) while -z's sits at the x=-2 edge (mid
    // ascending against it) -- the same inversion, visible, in one picture.
    //
    // required_successes is 30 and not 25 for exactly that reason: at 25 every panel is a bare
    // face and the middle loop leaves no trace at all.
    //
    // Volume: exactly the search volume, 5x5x5 from min-y 2 with the origin at (0,4,0), so the
    // cube the search walks fills the frame and nothing else is in it. 'volume' framing, not
    // content: each panel's own cells are a flat 5x5 slab in a different place, so a content fit
    // would zoom and re-centre every panel and the figure would show the camera moving instead
    // of the search order. The void preset means no terrain -- the six shapes are the whole
    // picture.
    env: 'void',
    seed: 42,
    origin: '0,4,0',
    size: '5x5x5',
    minY: 2,
    framing: 'volume',
    columns: 3,
    panels: [
      { label: '-x', feature: 'wiki:search_panel_minus_x' },
      { label: '+x', feature: 'wiki:search_panel_plus_x' },
      { label: '-y', feature: 'wiki:search_panel_minus_y' },
      { label: '+y', feature: 'wiki:search_panel_plus_y' },
      { label: '-z', feature: 'wiki:search_panel_minus_z' },
      { label: '+z', feature: 'wiki:search_panel_plus_z' },
    ],
    out: 'search-feature-axis-kinds.png',
    note: 'The six search_axis values over one 5x5x5 search_volume, with a delegate that succeeds everywhere and required_successes 30 -- so each panel is the first 30 offsets that axis order reaches. Every panel is one 25-cell face of the cube plus a five-cell line into the next slab: -x starts at x=+2 and +x at x=-2, -y at the top layer and +y at the bottom, -z at z=+2 and +z at z=-2. The trailing line shows the middle loop: at the z=+2 edge for -x (middle follows the outer loop) and at the x=-2 edge for -z (middle runs against it).',
  },
  {
    id: 'snap-surface-floor-vs-ceiling',
    // A FIGURE (see the doc comment at the top): `surface: "floor"` against `surface: "ceiling"`,
    // two panels, from ONE floating origin at (0,4,0) in the void with every other field held
    // identical -- the same delegate, the same search_range of 8, the same seed, the same volume
    // framed the same way. The two fixtures differ in that one word and nothing else.
    //
    // Three things in the fixtures are scaffolding for the picture, not part of what it shows:
    //
    //  - THE SCENE IS BUILT BY THE FIXTURE. The void preset has no terrain, and a snap with
    //    nothing to snap to fails in both directions, so each panel is an aggregate_feature that
    //    first lays one stone block four cells BELOW the origin and one four cells ABOVE it, and
    //    then runs the snap. Both markers are in both panels: the point of the figure is that the
    //    same column, with a surface at each end, sends the delegate to opposite ends of it.
    //  - ONE BLOCK EACH, not a slab. A 5x5 ceiling plate hides everything under it from the
    //    viewer's own fixed camera (it looks down from the +X/+Y/+Z corner at about 31 degrees,
    //    so a cell one row below a plate needs ~1.7 blocks of horizontal clearance to be seen at
    //    all) -- which is the canopy-over-the-trunk mistake the tree figure paid for. A single
    //    block is a perfectly good surface for a one-wide column scan and occludes nothing.
    //  - THE DELEGATE IS A 5x5 SHEET, wiki:snap_panel_patch, not a single block: a lone cell in a
    //    5x9x5 volume is a dot, and two dots four rows apart is not a figure. The sheet is
    //    wiki:snap_panel_patch_grid, a 25-iteration fixed_grid scatter over [0, 4] on x and z
    //    delegating to wiki:threshold_marker, wrapped in a bare-offset scatter of (-2, 0, -2) to
    //    centre it -- the same wrapper idiom, and the same reason for it, as the dist_panel_*
    //    fixtures above: a bare axis spends no random draw and the CLI cannot offset its volume.
    //
    // What the two panels show, read off each result's own changed-cell coordinates: 27 cells in
    // both, and 25 of them move. floor walks down from y 4 across three passable air cells, stops
    // on the marker at y 0, and the sheet lands at y 1 -- the open cell on top of the floor.
    // ceiling walks up the same three cells, stops on the marker at y 8, and the sheet lands at
    // y 7, the open cell under the ceiling. Same origin, same range, opposite ends of the column.
    //
    // One asymmetry in the picture, stated here and on the page rather than left to be noticed:
    // in the floor panel the lower marker is UNDER the sheet and invisible, because the sheet is
    // sitting on it. Both markers are visible in the ceiling panel, where the sheet is hung one
    // cell below the upper one. The visible cube in the floor panel is therefore the ceiling
    // marker -- the surface that snap ignored.
    //
    // Volume: 5x9x5 from min-y 0, so the frame is exactly the column between the two markers and
    // the sheet spans its full width. 'volume' framing, not content: the two panels' cells sit
    // six rows apart, so a content fit would put both sheets in the middle of their own panel and
    // the figure would show nothing at all.
    //
    // format_version 1.26.50 on the two snap fixtures, on purpose: they are the pack's only
    // committed files on the POST-rename spelling (`search_range`), so the rename gate the page
    // documents is exercised in both directions -- wiki:snap_pumpkin_to_floor is 1.21.110 and
    // says `vertical_search_range`, these say `search_range`, and `featurelab check` is clean on
    // all three.
    env: 'void',
    seed: 1,
    origin: '0,4,0',
    size: '5x9x5',
    minY: 0,
    framing: 'volume',
    columns: 2,
    panels: [
      { label: 'floor', feature: 'wiki:snap_panel_floor' },
      { label: 'ceiling', feature: 'wiki:snap_panel_ceiling' },
    ],
    out: 'snap-to-surface-feature-floor-vs-ceiling.png',
    note: 'surface "floor" against surface "ceiling" from one floating origin at (0,4,0), with a stone marker four cells below it and another four cells above it. Both panels place 27 cells; the two markers are shared and the 25-cell sheet is the delegate. floor puts it at y 1, on top of the lower marker; ceiling puts it at y 7, under the upper one. Everything else in the two files -- delegate, search_range 8, seed -- is identical.',
  },
  {
    id: 'vegetation-patch-floor-vs-ceiling',
    // A FIGURE (see the doc comment at the top): `surface: "floor"` against `surface: "ceiling"`,
    // two panels, from ONE floating origin at (0,4,0) in the void with every other field held
    // identical -- the same delegate, the same horizontal_radius 2, depth 1, vertical_range 4 and
    // vegetation_chance 0.6, the same seed, the same volume framed the same way. The two patch
    // fixtures differ in that one word and nothing else.
    //
    // This figure REPLACES the two single images this page used to carry
    // (vegetation-patch-feature-floor-pumpkins.png on plains and
    // vegetation-patch-feature-ceiling-roots.png in the void). Those two could never have been
    // one figure: different presets, different origins, different delegates and, in the ceiling
    // one, a 90-iteration scatter of stone built the overhang, so the two shared no camera, no
    // scale and no scene. The floor one stays as the page's worked example, because a real patch
    // on real terrain is what the "Start here" section is for; the ceiling one is retired here.
    //
    // Three things in the fixtures are scaffolding for the picture, not part of what it shows:
    //
    //  - THE SCENE IS BUILT BY THE FIXTURE. The void preset has no terrain and a patch with
    //    nothing to find keeps no column at all, so each panel is an aggregate_feature that lays a
    //    5x5 stone plate four cells BELOW the origin and another four cells ABOVE it, and then
    //    runs the patch. Both plates are in both panels: the point is that one column, with a
    //    surface at each end, sends the patch to opposite ends of it.
    //  - ONE BLOCK THICK, AND EXACTLY AS WIDE AS THE PATCH. depth 1 means the ceiling patch's
    //    ground_block replaces the WHOLE upper plate rather than coating an underside the camera
    //    cannot see -- which is the trap the snap-to-surface figure paid for with its 5x5 ceiling
    //    plate, and the tree figure with its canopy. So the panel's headline difference is which
    //    plate is moss and which is still stone, and that is visible from the viewer's own fixed
    //    camera whichever way the patch grew. horizontal_radius 2 walks a 7x7 rectangle whose
    //    outer ring the default extra_edge_column_chance of 0 drops, leaving a 5x5 interior --
    //    exactly the plate, so every column finds its surface and none overhangs the plate edge.
    //  - THE DELEGATE IS A BARE MARKER, wiki:threshold_marker, not the page's own moss-attached
    //    hanging roots. A vegetation feature that checks what it is attached to grows on one
    //    surface and not the other, and the panel that placed nothing would read as broken rather
    //    than as mirrored -- the same reason the aggregate/sequence figure uses a marker instead
    //    of the pumpkin patch. A gold block also reads against both moss and stone.
    //
    // vegetation_chance is 0.6 rather than 1 so the ground layer is not buried under a solid
    // sheet of markers: at 1 the floor panel would be 25 gold cells with no moss visible at all.
    // The draw sequence is identical in both panels (two zero-draw radius values, then one float
    // per kept column, in the same column order), so the SAME 14 of the 25 columns grow in both
    // -- verified by reading the changed-cell coordinates out of both runs: 64 cells per panel,
    // 25 stone + 25 moss + 14 gold, and the 14 gold (x, z) pairs are the same list twice.
    // floor puts the moss at y 0 and the markers at y 1; ceiling puts the moss at y 8 and the
    // markers at y 7. Nothing else moves.
    //
    // Volume: 7x9x7 from min-y 0, i.e. world x/z -3..3 and world Y 0..8 -- the column between the
    // two plates and one cell of margin around them. 'volume' framing, not content: the two
    // panels' cells sit at opposite ends of that column, so a content fit would centre each
    // panel's own patch and the figure would show nothing at all.
    env: 'void',
    seed: 1,
    origin: '0,4,0',
    size: '7x9x7',
    minY: 0,
    framing: 'volume',
    columns: 2,
    panels: [
      { label: 'floor', feature: 'wiki:veg_panel_floor' },
      { label: 'ceiling', feature: 'wiki:veg_panel_ceiling' },
    ],
    out: 'vegetation-patch-feature-floor-vs-ceiling.png',
    note: 'surface "floor" against surface "ceiling" from one floating origin at (0,4,0), with a 5x5 stone plate four cells below it and another four cells above it. Both panels place 64 cells -- 25 stone, 25 moss_block and 14 gold markers -- and the same 14 columns grow in both. floor coats the lower plate at y 0 and puts its markers at y 1; ceiling coats the upper plate at y 8 and hangs its markers at y 7. Everything else in the two files -- delegate, horizontal_radius 2, depth 1, vertical_range 4, vegetation_chance 0.6, seed -- is identical.',
  },
  {
    id: 'growing-plant-up-vs-down',
    // A FIGURE (see the doc comment at the top): `growth_direction: "up"` against
    // `growth_direction: "down"`, two panels, from ONE origin at (0,6,0) in the void with every
    // other field held identical -- the same height_distribution, the same body and head blocks,
    // the same age range, the same seed, the same volume framed the same way. The two plant
    // fixtures differ in that one word and nothing else.
    //
    // Two things in the fixtures are scaffolding for the picture, not part of what it shows:
    //
    //  - THE TWO PLATES. A lone 1x1 column in an empty void is a thin line with no scale and
    //    nothing to be "up" or "down" relative to, so each panel lays a 3x3 stone plate six cells
    //    below the origin and another six above it. 3x3 and not 5x5 on purpose: the upward column
    //    ends one cell under the upper plate, and at the viewer's own fixed camera (down from the
    //    +X/+Y/+Z corner at about 31 degrees) a cell one row below a plate needs roughly 1.7
    //    blocks of horizontal clearance to be seen at all. A 3x3 plate leaves the centre column
    //    that clearance; a 5x5 one would hide the head block -- the ceiling-plate trap the
    //    snap-to-surface figure documents.
    //  - THE PLATES ALSO STOP THE COLUMN, and that is deliberate rather than incidental. The
    //    height_distribution is a degenerate [8, 9) range, so both panels draw a height of 8, and
    //    both place only SIX cells: at the sixth layer the look-ahead finds the plate instead of
    //    air and the head block goes there. The configured height is an upper bound, not a
    //    promise, and the figure shows that as well as the direction.
    //
    // What the two panels show, read off each result's own changed-cell coordinates: 24 cells in
    // both, 18 of them the two shared plates. up puts five cave_vines at y 6..10 and the berried
    // head at y 11, one under the upper plate; down puts them at y 6..2 and the head at y 1, one
    // above the lower plate. The head carries growing_plant_age 21 in both -- one age draw over
    // {17, 25}, the same value either way, because the two panels spend the same draws in the
    // same order.
    //
    // Volume: 5x13x5 from min-y 0, i.e. world x/z -2..2 and world Y 0..12 -- the two plates and
    // the column between them, with one cell of margin. 'volume' framing, not content: each
    // panel's own cells fill a different half of that column, so a content fit would put both
    // columns in the middle of their own panel and the figure would show nothing.
    env: 'void',
    seed: 1,
    origin: '0,6,0',
    size: '5x13x5',
    minY: 0,
    framing: 'volume',
    columns: 2,
    panels: [
      { label: 'up', feature: 'wiki:growplant_panel_up' },
      { label: 'down', feature: 'wiki:growplant_panel_down' },
    ],
    out: 'growing-plant-feature-growth-direction.png',
    note: 'growth_direction "up" against growth_direction "down" from one origin at (0,6,0), with a 3x3 stone plate six cells below it and another six cells above it. Both panels place 24 cells: the two shared plates, five cave_vines and one berried head block carrying growing_plant_age 21. up runs the column from y 6 to the head at y 11, one cell under the upper plate; down runs it from y 6 to the head at y 1, one cell above the lower plate. Both stop at six of the eight layers the height_distribution asked for, because the sixth layer\'s look-ahead finds the plate instead of air.',
  },
]
