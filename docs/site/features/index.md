---
title: Feature types
description: Every JSON feature type Minecraft Bedrock 1.26.50.24 accepts, grouped the way wiki.bedrock.dev groups them, with what each one is for and how far the featurelab bench implements it.
game: 1.26.50.24
scope: game
---

# Feature types

<VersionBadge />

One page per feature type, plus the pages on how features reach a world at all. Every page is a statement about **Minecraft Bedrock 1.26.50.24**, the version this project targets — said once here, and shown as a badge on each page rather than hedged in every paragraph. Worldgen internals move between releases: field defaults, draw order, which types exist at all. Where this version is known to diverge from Microsoft's public reference, the page says so.

::: info Pages marked ↗ have not moved here yet
They open on GitHub, in the documentation set this site is being built from. Every link on this site to one of them will become a local link when the page moves; the sidebar is complete now so that nothing you look for is missing.
:::

## The rule every page follows

**These pages document the Minecraft Bedrock game, not any particular add-on tool.** A claim about the version named above is stated as fact about the game. Where a claim is instead a limitation of the bench used to illustrate it — an unimplemented field, a refusal, an approximation — that limitation is confined to the page's own *What the bench does differently* section, and never phrased as if it were something the game itself cannot do. If a fact is not known with certainty, it is either left out or marked as uncertain.

Three pages are deliberate exceptions and carry a different badge: [Coverage and known gaps](../engine/coverage.md), [Block textures in the preview](../engine/block_textures.md) and [When the preview shows nothing](../editor/preview_shows_nothing.md) are about the bench — how far its checking goes, how it draws what it found, and what it says when it places nothing.

## Taxonomy

Feature grouping follows wiki.bedrock.dev's own four categories, not an invented scheme. Types that site has not yet categorised are placed by structural role — do they place blocks, gate or delegate, combine both, or carve — and say so.

### Content features

Place blocks directly; no delegation to another feature.

| Type | Page | Purpose |
|---|---|---|
| `minecraft:single_block_feature` | [Single block](./single_block_feature.md) | Places one weighted-picked block, optionally against an attach face — the feature almost every other feature ends up delegating to. |
| `minecraft:ore_feature` | [Ore](./ore_feature.md) | Places an ellipsoidal vein of blocks along a random angle, resolved per block through replacement rules. |
| `minecraft:tree_feature` | [Tree](./tree_feature.md) | Pairs one trunk shape with one canopy shape — eight trunk algorithms and twelve crown algorithms, selected by which key is present rather than by a type field. |
| `minecraft:growing_plant_feature` | [Growing plant](./growing_plant_feature.md) | Places a vertically growing block column — cave vines, kelp, weeping vines — with weighted body and head blocks and a randomised height. |
| `minecraft:structure_template_feature` | [Structure template](./structure_template_feature.md) | Places a pre-authored `.mcstructure` file, with rotation, a spiral position search, and four placement constraints. |
| `minecraft:multiface_feature` | [Multiface](./multiface_feature.md) | Spreads vine and glow-lichen-style multi-face growth onto adjacent blocks. |
| `minecraft:fossil_feature` | [Fossil](./fossil_feature.md) | Buries one of the game's eight prebuilt fossil structures, speckled with an ore block of your choosing. Two required fields and nothing else. |
| `minecraft:multipart_block_column_feature` | [Multipart block column](./multipart_block_column_feature.md) | Places an ordered column of up to four block roles — base, middle, frustum, tip — along any of the six directions. New in this version. |
| `minecraft:horizontal_tree_decoration_feature` | [Horizontal tree decoration](./horizontal_tree_decoration_feature.md) | Places one decoration block against a randomly chosen horizontal side of the origin block — leaf litter and flower beds. New in this version. |
| `minecraft:multi_block_feature` | [Multi block](./multi_block_feature.md) | Places a custom multi-block — a block whose `minecraft:multi_block` trait spans 2–4 cells in a line — as its complete set of parts, all or nothing. New in this version. |

### Proxy features

Delegate to another feature; decide which, where, or whether, not what gets placed.

| Type | Page | Purpose |
|---|---|---|
| `minecraft:scatter_feature` | [Scatter](./scatter_feature.md) | Repeatedly picks an offset from the origin and delegates to another feature at each — the single most common feature type in real packs. |
| `minecraft:aggregate_feature` | [Aggregate](./aggregate_feature.md) | Delegates to every listed sub-feature at the same, unmodified origin. |
| `minecraft:sequence_feature` | [Sequence](./sequence_feature.md) | Delegates to a list of sub-features in order, threading each success's position forward as the next one's origin. |
| `minecraft:weighted_random_feature` | [Weighted random](./weighted_random_feature.md) | Picks one sub-feature from a weighted list and delegates to it. |
| `minecraft:search_feature` | [Search](./search_feature.md) | Searches a volume along a configurable axis order for positions where a delegated feature can place, committing the whole attempt transactionally. |
| `minecraft:snap_to_surface_feature` | [Snap to surface](./snap_to_surface_feature.md) | Scans a column for a floor, ceiling or wall and delegates to another feature at the snapped position. |
| `minecraft:conditional_list` | [Conditional list](./conditional_list.md) | Places features from a list of `{places_feature, condition}` entries evaluated in order. Documented as a public feature by this version's changelog. |
| `minecraft:scan_surface` | [Scan surface](./scan_surface.md) | Delegates to a wrapped feature once per column across the whole 16×16 chunk containing the origin. Microsoft's reference lists it as internal; it is available and fully functional in this version. |
| `minecraft:surface_relative_threshold_feature` | [Surface relative threshold](./surface_relative_threshold_feature.md) | Gates delegation on the origin's height relative to the surface. |
| `minecraft:height_difference_filter_feature` | [Height difference filter](./height_difference_filter_feature.md) | Gates delegation on the terrain height difference across a search radius around the origin. New in **1.26.40**, not in this version, and unchanged since. |
| `minecraft:rect_layout` | *no page* | Lays a wrapped feature out across a chunk-local grid with a budgeted empty-space ratio. Internal per Microsoft's reference; not implemented by the bench and deliberately without a page. |

### Scene features

Combine a footprint or shape search with content placement in one type.

| Type | Page | Purpose |
|---|---|---|
| `minecraft:geode_feature` | [Geode](./geode_feature.md) | Places a concentric-shell sphere with budding-block-style inner placements. |
| `minecraft:vegetation_patch_feature` | [Vegetation patch](./vegetation_patch_feature.md) | Places a ground patch plus vertical vegetation growth on top of it, floor or ceiling. |
| `minecraft:partially_exposed_blob_feature` | [Partially exposed blob](./partially_exposed_blob_feature.md) | Fills a cube of cells below the origin, keeping only the cells that are not submerged — except on the one face you name. |
| `minecraft:sculk_patch_feature` | *no page* | Places a central sculk block plus a spreading, growing cursor simulation. Internal per Microsoft's reference; the bench implements it partially. |
| `minecraft:beards_and_shavers` | *no page* | Smooths terrain in a kernel-weighted shell around another feature's placement bounds. Internal per Microsoft's reference; not implemented by the bench. |

### Carver features

Subtract or reshape existing terrain rather than add to it.

| Type | Page | Purpose |
|---|---|---|
| `minecraft:cave_carver_feature` | [Cave carver](./cave_carver_feature.md) | Digs rooms and branching tunnels through solid terrain — removes blocks rather than placing them. |
| `minecraft:underwater_cave_carver_feature` | [Underwater cave carver](./underwater_cave_carver_feature.md) | The underwater variant: a flat water line, a magma/obsidian row and a lava band at fixed depths, and a biome that must be tagged `ocean` or it writes nothing. |
| `minecraft:nether_cave_carver_feature` | [Nether cave carver](./nether_cave_carver_feature.md) | The Nether variant: an identical JSON surface to the base carver, its own tunnel behaviour, and four of the eight fields whose value never reaches the geometry — `height_limit` and `y_scale` are read and discarded outright, while `horizontal_radius_multiplier` and `vertical_radius_multiplier` are still sampled, so they move the random stream without changing a single cell. |

## How features reach a world

| Page | Purpose |
|---|---|
| [Feature rules](./feature_rules.md) | The `{distribution, places_feature}` pair a `minecraft:feature_rules` file attaches to every matching biome's chunks; the biome filter; the eleven ordered passes and the twelfth; the seven ways a rule places nothing while looking correct. |
| [Delegation and composite features](./feature_delegation.md) | The shape every Proxy feature shares — which types substitute the origin and which pass it through, the shared random stream and Molang scope, how the recursion guard is keyed, and what a delegate's return value does and does not promise. |
| [RNG and determinism](./rng_and_determinism.md) | Where a feature's seed comes from — world seed to chunk to decoration entry, and the two independent streams that entry gets — which operations skip their draw, why a rename moves a feature, and why draw *order* is part of a feature's contract. |
| [Molang in world generation](./molang.md) | Where an expression can go, what `math.random` actually returns, namespace scope lifetime, the versioned `&&`/`\|\|` precedence change, float32 evaluation, and the six queries available during worldgen. |

## Version-specific divergences worth knowing up front

- This version has **29** JSON feature types. The previous target, 1.26.40.26, had 26: Microsoft's public reference documented `minecraft:horizontal_tree_decoration_feature` and `minecraft:multi_block_feature` before either existed in the game. Both are available in 1.26.50.24, along with `minecraft:multipart_block_column_feature`, which this version's own changelog introduces.
- Between those two versions a field was renamed (`snap_to_surface_feature`'s `vertical_search_range` became `search_range`), an enum default changed meaning (`conditional_list`'s `early_out_scheme` now defaults to `none`), and at least one placement algorithm was rewritten without its JSON surface changing at all.
- Microsoft's official reference classifies `minecraft:conditional_list` as internal or deprecated. That is out of date as of this version: the 1.26.50.24 changelog introduces it as a public feature. It is documented here as a first-class type.
- `minecraft:nether_cave_carver_feature` is this version's id for what older material calls `minecraft:hell_cave_carver_feature`.
- `minecraft:scan_surface` and `minecraft:sculk_patch_feature` are classified internal by that same reference, but both are available and functional in this version. `scan_surface` has a page because packs in the wild use it; `sculk_patch_feature` does not.

## Images

Feature pages illustrate their JSON examples with images rendered by [`docs/wiki/tools/generate-images.mjs`](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs) — a pipeline that runs the real `featurelab` CLI against the committed [fixture pack](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) and screenshots the result through the same voxel viewer the editor embeds, in a headless browser. Every image is reproducible from a documented one-command run, a fixed seed and a deterministic camera fit; each page's example section gives the exact `featurelab generate` call behind its image. Every image renders blocks as flat colours, and the pipeline asserts that: a committed screenshot must not change depending on whether the machine that regenerated it happens to have built a block atlas.
