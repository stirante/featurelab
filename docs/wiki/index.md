# Bedrock World Generation — Feature Documentation

This is a wiki.bedrock.dev-style documentation set covering Bedrock's JSON worldgen feature
system. **A linked row below is a written page; an unlinked row is still planned.** Every
feature type this set intends to cover per-type now has its page, and so does every guide it
planned — the unlinked rows that remain are the types deliberately left out (see "Scope" below).

## Scope

Three available types are deliberately without a page: `minecraft:rect_layout` and
`minecraft:beards_and_shavers`, which Microsoft's own reference lists as internal, and
`minecraft:sculk_patch_feature`. They are available and they work, and each is described in the
tables below, but a pack should not be built on an internal type and this set does not encourage it.
`minecraft:scan_surface` carries the same internal caveat but DOES have a page, because packs in
the wild already use it.

`minecraft:conditional_list` used to be listed here under that same caveat. It no longer belongs
there: Mojang's own changelog for 1.26.50.24 introduces it as a documented, public feature, and
the same release gave its `early_out_scheme` a third value. It is treated as a first-class public
type throughout this set.

## Version scope

Every page in this set is a statement about **Minecraft Bedrock 1.26.50.24**, the version this
project targets. Said once, here, rather than hedged on every page. Worldgen internals — field defaults, RNG draw order, which feature
types exist at all — move between releases; where this version is known to diverge from
Microsoft's current public reference (see "Version-specific divergences" below), the
divergence is called out on the relevant page, not silently absorbed.

That warning is not theoretical, and this set has now been through it once. The previous target
was **1.26.40.26**, which had 26 feature types; 1.26.50.24 has 29. Between the two
versions a field was renamed (`snap_to_surface_feature`'s `vertical_search_range` became
`search_range`), an enum default changed meaning (`conditional_list`'s `early_out_scheme` now
defaults to `none`, which evaluates every entry instead of stopping at the first passing
condition), and at least one placement algorithm was rewritten without its JSON surface
changing at all. A page still marked against the older version has not yet been re-checked
against this one, and says so.

## The rule every page follows

**These pages document the Minecraft Bedrock game, not any particular add-on tool.**
A claim about the version named above is stated as fact about the game.
Where a claim is instead a limitation of the tooling used to illustrate it — an
unimplemented field, a refusal, an approximation — that limitation is never phrased as if it
were something the game itself can't do. If a fact is not known with certainty, it's either
left out or explicitly marked as uncertain. This is the standard every page in this set is
held to.

Three pages are deliberate exceptions and say so in their opening lines: [Coverage and Known
Gaps](./coverage-and-known-gaps.md), [Block Textures in the Preview](./block-textures.md) and
[When the Preview Shows Nothing](./preview-shows-nothing.md) are about the *bench* these pages
were written with — how far its checking goes, how it draws what it found, and what it says when
it places nothing — rather than about the game. Nothing in any of them should be read as a
statement about Minecraft.

## Images

Feature pages illustrate their JSON examples with images rendered by
[`docs/wiki/tools/generate-images.mjs`](./tools/generate-images.mjs) — a standalone pipeline
that runs the real `featurelab` CLI against the committed fixtures under
[`docs/wiki/tools/fixtures/`](./tools/fixtures/) and screenshots the result through
featurelab-frontend's own built voxel viewer (a library import of `frontend/dist`, not a fork
or reimplementation) in a headless Chromium page. Every image is reproducible from a documented
one-command run, a fixed seed, and a deterministic camera fit — see that script's own header
comment for the exact command and requirements, and each feature page's own "Example" section
for the specific `featurelab generate` call behind its image.

Every image that pipeline produces renders blocks as **flat colours**, and it asserts that
rather than assuming it: a committed screenshot must not change appearance depending on whether
the machine that regenerated it happens to have built a block atlas. The single exception is the
before/after figure on [Block Textures in the Preview](./block-textures.md), which needs both
halves by definition and has [its own script](./tools/generate-texture-figure.mjs) for that
reason.

## Taxonomy

Feature grouping follows wiki.bedrock.dev's own four categories (from the
live site's "Feature Types" page), not an invented scheme:

- **Content features** — "the fundamental feature type responsible for defining block
  placements in a feature system." They place blocks directly.
- **Proxy features** — "group, arrange, or gate features, including other proxy features."
  They don't place blocks themselves; they decide *which* other feature places, *where*, or
  *whether at all*.
- **Scene features** — "a sort of combination of content features and proxy features" —
  typically a footprint search plus content placement bundled into one type (patches,
  geodes).
- **Carver features** — "special feature types for modifying vanilla cave generation." They
  subtract/reshape terrain rather than add to it.

wiki.bedrock.dev currently documents 17 of this version's types across those four
groups. The remaining types below (marked *not yet categorized by wiki.bedrock.dev*) are
placed by this outline according to their structural role — do they place blocks, gate/
delegate, combine both, or carve — as the most defensible reading available, not copied
from any existing page. That placement should be revisited once each page is actually
written.

## Content features

Place blocks directly; no delegation to another feature's `place()`.

| Page | Purpose |
|---|---|
| [Single Block Features](./single-block-feature.md) | Places one weighted-picked block, optionally against an attach face — the feature almost every other feature ends up delegating to. |
| [Ore Features](./ore-feature.md) | Places an ellipsoidal vein of blocks along a random angle, resolved per-block through replacement rules. |
| [Tree Features](./tree-feature.md) | Pairs one trunk shape with one canopy shape — leaning trunks, branches that carry their own canopy, and eleven crown algorithms selected by key rather than by a type field. |
| [Growing Plant Features](./growing-plant-feature.md) | Places a vertically-growing block column — cave vines, kelp, weeping vines — with weighted body/head blocks and a randomized height. |
| [Structure Template Features](./structure-template-feature.md) | Places a pre-authored `.mcstructure` file, with rotation, a spiral position search, and four placement constraints — `grounded`, `unburied`, `leveled` and `block_intersection` — each of which a candidate position must satisfy for the search to stop there. |
| [Multiface Features](./multiface-feature.md) | Spreads vine/glow-lichen-style multi-face growth onto adjacent blocks. |
| [Fossil Features](./fossil-feature.md) | Buries one of the game's eight prebuilt fossil structures, speckled with an ore block of your choosing. Two required fields and nothing else. *Not yet categorized by wiki.bedrock.dev — placed here on structural grounds (it places fixed content, like Structure Template Features).* |
| [Multipart Block Column Features](./multipart-block-column-feature.md) | Places an ordered column of up to four block roles — base, middle, frustum, tip — along any of the six directions, with either a plain or a weighted height, plus surface and replacement restrictions. New in this version. *Not yet categorized by wiki.bedrock.dev.* |
| [Horizontal Tree Decoration Features](./horizontal-tree-decoration-feature.md) | Places one decoration block against a randomly chosen horizontal side of the origin block — leaf litter and flower beds, the blocks that carry both a `cardinal_direction` and a `growth` state. New in this version. *Not yet categorized by wiki.bedrock.dev.* |
| [Multi Block Features](./multi-block-feature.md) | Places a custom multi-block — a block whose `minecraft:multi_block` trait spans 2–4 cells in a line — as its complete set of parts, all or nothing. Only does anything for a pack that defines such a block. New in this version. *Not yet categorized by wiki.bedrock.dev.* |

## Proxy features

Delegate to another feature's `place()`; decide which/where/whether, not what gets placed.

| Page | Purpose |
|---|---|
| [Scatter Features](./scatter-feature.md) | Repeatedly picks an offset from the origin (via a `distribution`) and delegates to another feature at each offset — the single most common feature type in real packs. |
| [Aggregate Features](./aggregate-and-sequence-feature.md#aggregate_feature) | Delegates to every listed sub-feature at the same, unmodified origin. |
| [Sequence Features](./aggregate-and-sequence-feature.md#sequence_feature) | Delegates to a list of sub-features in order, threading each success's position forward as the next sub-feature's origin. |
| [Weighted Random Features](./weighted-random-feature.md) | Picks one sub-feature from a weighted list and delegates to it. |
| [Search Features](./search-feature.md) | Searches a 3D volume along a configurable axis order for candidate positions where a delegated feature can place, committing the whole attempt transactionally. |
| [Snap-to-Surface Features](./snap-to-surface-feature.md) | Scans a column for a floor/ceiling/random-horizontal surface and delegates to another feature at the snapped position. |
| [Conditional List Features](./conditional-list-feature.md) | Places features from a list of `{places_feature, condition}` entries evaluated in order. Under the default `early_out_scheme: "none"` every entry whose condition passes places; `condition_success` and `placement_success` instead stop at the first passing condition or the first successful placement. Documented as a public feature by this version's changelog. *Not yet categorized by wiki.bedrock.dev.* |
| [Scan Surface Features](./scan-surface-feature.md) | Delegates to a wrapped feature once per column across the whole 16×16 chunk containing the origin. *Not yet categorized by wiki.bedrock.dev — Microsoft's own reference lists this as internal/deprecated, but it is available and fully functional in this version (see Coverage and Known Gaps).* |
| [Surface Relative Threshold Features](./surface-relative-threshold-feature.md) | Gates delegation on the origin's height relative to the surface. *Not yet categorized by wiki.bedrock.dev.* |
| [Height Difference Filter Features](./height-difference-filter-feature.md) | Gates delegation on the terrain height difference across a search radius around the origin. New in this version. *Not yet categorized by wiki.bedrock.dev.* |
| Rect Layout Features | Lays a wrapped feature out across a 16×16 chunk-local grid with a budgeted empty-space ratio. *Not yet categorized by wiki.bedrock.dev — Microsoft's own reference lists this as internal/deprecated.* |

## Scene features

Combine a footprint/shape search with content placement in one type.

| Page | Purpose |
|---|---|
| [Geode Features](./geode-feature.md) | Places a concentric-shell sphere (amethyst-geode-style) with budding-block-style inner placements. |
| [Vegetation Patch Features](./vegetation-patch-feature.md) | Places a ground patch plus vertical vegetation growth on top of it, floor or ceiling. |
| Sculk Patch Features | Places a central sculk block plus a spreading/growing cursor simulation. *Not yet categorized by wiki.bedrock.dev — same internal/deprecated caveat as Scan Surface Features.* |
| [Partially Exposed Blob Features](./partially-exposed-blob-feature.md) | Places a blob of blocks gated on a configurable face being exposed to a target material. *Not yet categorized by wiki.bedrock.dev.* |
| Beards and Shavers Features | Smooths terrain in a kernel-weighted shell around another feature's placement bounds. *Not yet categorized by wiki.bedrock.dev — Microsoft's own reference lists this as internal/deprecated; placed here as a content/wrapping combination on structural grounds.* |

## Carver features

Subtract/reshape existing terrain rather than add to it.

| Page | Purpose |
|---|---|
| [Cave Carver Features](./cave-carver-feature.md) | Digs rooms and branching tunnels through solid terrain -- removes blocks rather than placing them. |
| [Underwater Cave Carver Features](./underwater-cave-carver-feature.md) | The underwater variant: the base carver's placement and walk, but its own per-cell fill — a flat water line, a magma/obsidian row and a lava band at fixed depths, `replace_air_with` as a ninth field, its own diggable list, and a biome that must be tagged `ocean` or it writes nothing. |
| [Nether Cave Carver Features](./nether-cave-carver-feature.md) | The Nether variant: an identical JSON surface to the base carver, but its own tunnel/room behaviour, a three-block diggable list, a lava veto on whole tunnel steps, and three of the eight fields that are accepted and then ignored. |

## Guides

| Page | Purpose |
|---|---|
| [Molang in World Generation](./molang-in-world-generation.md) | Namespace scope lifetime, the versioned `&&`/`\|\|` precedence change, float32 evaluation, and which queries are actually available during worldgen. |
| [Coverage and Known Gaps](./coverage-and-known-gaps.md) | A transparency page: how the claims on these pages are backed, which types the tooling behind them implements fully and which only partially, the bench-wide approximations that cut across every page, and what has never been checked against real content — so the silences elsewhere are legible rather than accidental. |
| [RNG and Determinism in World Generation](./rng-and-determinism.md) | Where a feature's seed actually comes from — world seed to chunk to decoration entry, and the two independent streams that entry gets — plus which operations skip their draw entirely, why a rename moves a feature, and why draw *order*, not just draw *count*, is part of a feature's contract. |
| [Feature Rules](./feature-rules.md) | How a feature reaches a world at all — the `{distribution, places_feature}` pair a `minecraft:feature_rules` file attaches to every matching biome's chunks, rooted at the chunk corner and run once per chunk; the biome filter that decides which biomes those are; the eleven ordered `placement_pass` values (plus the separately-kept `pregeneration_pass`) and what the ordering buys an author; and the seven ways a rule places nothing while looking correct. |
| [Block Textures in the Preview](./block-textures.md) | How the bench draws real Minecraft textures instead of flat colours: where Mojang's assets come from and what the first run asks, how a pack's own blocks are resolved through its own resource pack — including texture sets and per-state art from a block's `permutations` — which six shapes are modelled, and every way of not having textures at all. *About the bench, not the game.* |
| [When the Preview Shows Nothing](./preview-shows-nothing.md) | The reasons a run places no blocks, and where each one is reported: zero iterations, a lost chance roll, no surface to snap to, an unresolved reference, the recursion guard, a spent budget — plus the refusals that are deliberately silent, and the separate set of reasons a feature rule decorates no chunks. *About the bench, not the game.* |
| [Feature Delegation and Composite Features](./feature-delegation.md) | The general shape every Proxy feature shares — which types substitute the origin and which pass it through, what the shared RNG stream and Molang scope mean for a chain, how the recursion guard is keyed, and what a delegate's return value does and does not promise. |

## Version-specific divergences worth flagging up front

Recorded here so a future page doesn't have to rediscover them:

- This version has **29** JSON feature types. The previous target, 1.26.40.26, had
  26: Microsoft's public feature-type reference documented
  `minecraft:horizontal_tree_decoration_feature` and `minecraft:multi_block_feature` before
  either existed in the game. Both are available in 1.26.50.24, along with a third,
  `minecraft:multipart_block_column_feature`, which this version's own changelog introduces.
  A worked example of why every page names its version.
- Microsoft's own official reference (the separate, non-wiki.bedrock.dev Bedrock Creator
  documentation) classifies `minecraft:conditional_list` as an internal/deprecated component.
  That is out of date as of this version: Mojang's 1.26.50.24 changelog introduces it as a public
  feature, and the same release added a third `early_out_scheme` value to it and made its
  per-entry `condition` optional. It is documented here as a first-class type.
- `minecraft:nether_cave_carver_feature` is this version's id for what older material (such as
  wiki.bedrock.dev's current page) calls `minecraft:hell_cave_carver_feature`.
- That same official reference classifies `minecraft:scan_surface` and
  `minecraft:sculk_patch_feature` as internal/deprecated components not meant for custom
  content — but both are available and fully functional in this version. These pages should
  document them like any other type, with a note on that classification, not skip them.
