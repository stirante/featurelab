---
title: Nether cave carver feature
description: minecraft:nether_cave_carver_feature digs tunnels through netherrack and almost nothing else. The three-block list that makes it look broken, the lava veto that shortens tunnels near the lava sea, the three fields it accepts and ignores, and the one it will not load without — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:nether_cave_carver_feature
category: carver
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Nether cave carver feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:nether_cave_carver_feature` digs tunnels through netherrack, replacing it with `fill_with`.** It is the Nether's own cave carver, and it reads as a chain of connected chambers rather than the long smooth bores the [cave carver](./cave_carver_feature.md) digs, because a Nether tunnel skips the carve at about one step in four.

It is the **Carver** category, so everything the cave carver page says about what that means for a preview applies here unchanged: a carve adds nothing to look at, a result reports it as `blocksCarved` rather than `blocksPlaced`, and `/placefeature` can never demonstrate one, because the carve path is only reached during chunk generation.

Reach for it for tunnel networks through a netherrack dimension or a netherrack layer. Do **not** reach for it anywhere else: it digs exactly three things, and over anything but netherrack, dirt or grass it writes nothing and reports success — which is [the fastest way to conclude it is broken when it is working perfectly](#nether-diggable).

**It is not the cave carver with a new name.** It shares the front door and nothing else: [the same 17×17 chunk window and the same per-neighbour re-seeding](#nether-front-door), and then its own rooms, its own tunnel walk and its own per-cell carve. The same JSON body under the two ids does not produce the same cave.

::: note Naming
This version's id is `minecraft:nether_cave_carver_feature`. Older material — including wiki.bedrock.dev's current page — shows `minecraft:hell_cave_carver_feature` instead. That is the same carver under its previous id, and the old id does not resolve here.
:::

## Start here: a complete example

One file. `height_limit` and `y_scale` are left out deliberately: they would be accepted and would do nothing, and this file is meant to be copyable.

```json title="features/nether_cave_demo.json"
{
  "format_version": "1.21.110",
  "minecraft:nether_cave_carver_feature": {
    "description": { "identifier": "wiki:nether_cave_demo" },
    "fill_with": "minecraft:air",
    "width_modifier": 0.0,
    "skip_carve_chance": 1,
    "horizontal_radius_multiplier": { "range_min": 1.0, "range_max": 1.0 },
    "vertical_radius_multiplier": { "range_min": 0.7, "range_max": 1.4 },
    "floor_level": { "range_min": -1.0, "range_max": -0.7 }
  }
}
```

What each choice buys you:

- **`fill_with: "minecraft:air"`** is the one field you must write. Unlike its two siblings, this type has no behaviour for an omitted value — see [`fill_with` is required](#nether-fill-with).
- **`skip_carve_chance: 1`** means *never skip*. Write `1`, not `0`; [the cave carver page](./cave_carver_feature.md#carver-skip-carve-chance) says why they are not interchangeable.
- **`floor_level` at −1.0 to −0.7** keeps most of every ellipsoid. The default of `0` throws away the bottom half of each one: same fixture, same seed, `{-1.0, -1.0}` carves 105 cells and `{0.0, 0.0}` carves 58.
- **The two radius multipliers** change the cave here, but never its radii. They are the strangest thing about this type and they have [their own section](#nether-inert-fields).

![A cutaway of a netherrack block revealing a network of carved rooms and tunnels, rendered by featurelab's voxel viewer](../../wiki/images/nether-cave-carver-feature-tunnels.png)

```
featurelab generate --pack <pack> --feature wiki:nether_cave_demo --env nether --seed 3 --origin 96,48,96
```

Run against the `nether` preset with feature seed `3`, **at origin (96, 48, 96)**, this carves **1,322 cells**, every one of them inside world X/Z `96..111` — the origin's own 16×16 chunk column, at those coordinates — in two separated bands at world Y `30..38` and `64..71`.

::: tip Two bands, and a non-zero origin, are both the point
**The two bands are the diggable list working, not a gap in the carve.** The `nether` preset hollows a cavern through the middle of its netherrack, and **air is not on this carver's list either** — so the carve appears in the solid netherrack under the cavern and over it, with the open space between them left alone.

**The non-zero origin is deliberate.** A carver's footprint is world-space: it lands in the chunk column that actually contains the origin and nowhere else. At origin `(0, 48, 0)` a chunk-local mistake and a world-space one produce exactly the same picture, because the two coordinate systems agree there — so an example rooted at the origin cannot distinguish them. This one can: `96..111`, not `0..15`. The same seed at `(0, 48, 0)` carves 9 cells inside X/Z `0..15`, which is not "less of the same cave" but a different chunk's own carve; [the cave carver page](./cave_carver_feature.md#carver-one-chunk-over) makes the same comparison with two pictures.

The image is a cutaway, sliced between world Y 24 and 37, for the same reason the cave carver and [ore](./ore_feature.md) pages slice theirs: a cave sealed inside solid rock shows nothing from outside. The cut keeps the lower of the two bands, which is the one that reads as a room-and-tunnel network.
:::

## Fields

Eight keys, all optional to the game's loader — the same eight the [cave carver](./cave_carver_feature.md#fields) accepts, so an identical body loads against either id. **Only five of them reach anything.** `fill_with` is additionally required by featurelab, which is stricter than the loader on purpose.

### The five that do something

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `fill_with` | **yes, in this tool** | block descriptor | — | The block every carved cell becomes. featurelab refuses a file without it; [see why](#nether-fill-with). |
| `skip_carve_chance` | no | integer, `1` or more | `0` — never skips | A one-in-N gate on a whole neighbour's contribution: **bigger is rarer**. Write `1`, not `0` — [detail](./cave_carver_feature.md#carver-skip-carve-chance). |
| `width_modifier` | no | number or Molang string | `0.0` | Added to every tunnel step's radius, so it thickens or thins the whole cave uniformly. |
| `floor_level` | no | a [range](./cave_carver_feature.md#carver-ranges) — a bare number, `[min, max]`, or `{range_min, range_max}` | `{0, 0}` — half a cave | How much of the bottom of each ellipsoid is left uncarved: `-1` keeps the whole thing, `0` throws away the lower half. Read by rooms and tunnels alike, exactly as on the base carver. |
| `horizontal_radius_multiplier` / `vertical_radius_multiplier` | no | a range each | `{0, 0}` | **No effect on any radius, on this type** — and they still change the cave. See [the three fields that do nothing](#nether-inert-fields). |

### The two that are accepted and discarded

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `height_limit` | no | integer | `0` | **Nothing here.** The vertical range is fixed and no field moves it. |
| `y_scale` | no | a range | `{0, 0}` | **Nothing here.** It is read by the base carver's rooms and by nothing on this type. |

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| This carver over stone, basalt, blackstone or soul sand | Nothing at all, and it reports success. The list is netherrack, dirt and grass — **that is the whole list**. Same fixture, same seed: **0 cells** in a solid-stone bench, **1,322** in a netherrack one. | Netherrack. See [what it will dig](#nether-diggable). |
| No `fill_with` | featurelab refuses to load the file, with an error saying why. The game's own loader accepts it and then writes an unset block the first time it carves. | Write it. `minecraft:air` for an ordinary Nether cave. |
| `"height_limit": 8` to keep tunnels low | Nothing. The field is read, range-checked and discarded. Adding it — along with a `y_scale` — to this page's fixture produces the identical 1,322 cells at the identical positions. | Nothing here will do it. Every row this type writes falls in world Y 3 to 120, whatever the JSON says. |
| `"vertical_radius_multiplier": { "range_min": 6.0, "range_max": 9.0 }` for fatter tunnels | Identical output to `{0.7, 1.4}` — same 1,322 cells, same positions. Neither multiplier is ever applied to a radius on this type. | `width_modifier`, which really is added to every tunnel radius. |
| `{ "min": …, "max": … }` on a range field | Substituted with a zero-width `{0, 0}` range. On this type that is **doubly** easy to miss: for the two radius multipliers it produces no visible change in shape at all, and only quietly moves the whole cave. | `{ "range_min": …, "range_max": … }`. [Detail](./cave_carver_feature.md#carver-range-spelling). |
| Leaving `floor_level` out | Its default of `0` cuts the bottom half off every room and every tunnel step: 58 cells instead of 105 on the same fixture and seed. | `-1.0`, or vanilla's `-1.0` to `-0.7`. |
| A carver configured to dig near the lava sea, wondering why the tunnels are short | Any tunnel step whose ellipsoid would break into lava is skipped whole — not the cells near the lava, the entire step. Nothing in the JSON explains it. | Nothing to fix. See [the lava veto](#nether-lava-veto). |
| Expecting the same cave as a `cave_carver_feature` with the same body | The two ids share the front door and nothing past it. The same seed and the same configuration do not produce the same cave system. | Nothing to fix; read [the three carvers, side by side](./cave_carver_feature.md#the-three-carvers). |
| Testing with `/placefeature` | A carver only runs during chunk generation. The command reports success and changes nothing. | Attach it to a [feature rule](./feature_rules.md) and generate fresh terrain. |

## How it runs

1. **Walk a 17×17 grid of chunks** around the chunk containing the origin — 289 neighbours — re-seeding from each neighbour's own coordinates. This part is shared with the other two carvers, byte for byte. See [the front door](#nether-front-door).
2. **Per neighbour, pick a system count of 0 to 9**, narrowed twice so that low counts dominate and 0 is much the most likely outcome, then roll `skip_carve_chance` for the whole neighbour. (The base carver runs the same three-step narrowing from 40 rather than 10, so a Nether chunk contributes far fewer systems than an overworld one at the same setting.)
3. **Anchor each system** anywhere in that neighbour's own 16×16 column, at a height picked evenly from **0 to 127**. No field moves that band.
4. **One system in four opens with a room.** The room is not a separate shape and has no geometry of its own: it is one call into the same tunnel walk, stopped after a single step, taken at the point of the walk where the taper is widest, with a thickness between 1 and 7. When it fires, the system then runs **1 to 4** tunnels; when it does not, exactly one.
5. **Each tunnel walks 85 to 112 steps**, drifting its heading a little each step. Its pitch flattens towards horizontal by a factor picked once per tunnel: `0.7` normally, and `0.92` about one tunnel in six — the occasional one that keeps its slope.
6. **Every step carves a small ellipsoid, except that a non-room tunnel skips the carve about one step in four** — the reason a Nether tunnel reads as a chain of chambers rather than a smooth bore.
7. **At one step partway along** — picked per tunnel, from a quarter of the way to just under three quarters — a tunnel whose thickness is over 1 **forks**: two children at right angles to the parent's heading, each at a third of its pitch, each walking the parent's remaining steps, and the parent stops there rather than continuing past the fork. Rooms never fork.
8. **Before carving any step's ellipsoid**, scan the region it would touch for lava. [If there is any, skip the whole step.](#nether-lava-veto)
9. **Carve each cell the surviving ellipsoids reach** whose block is on [the three-block list](#nether-diggable), and write `fill_with` there. Every row written is clamped into world Y **3 to 120**.

As with every carver, the placement **always succeeds**: a call that carves nothing anywhere still reports success and returns its origin unchanged.

## It shares the front door and nothing else {#nether-front-door}

All three carvers begin identically. The placement reads its own seed, turns it into two odd multipliers, and walks a **17×17 grid of chunks** centred on the chunk containing the origin — 289 neighbours — re-seeding the shared generator from each neighbour's own coordinates and asking that neighbour to contribute rooms and tunnels. The mixing formula and the window are the same for all three, so all three visit the same 289 neighbours with the same 289 seeds, and cave systems continue across chunk borders for this id exactly as they do for the base one. [The cave carver page](./cave_carver_feature.md#carver-one-chunk) describes that architecture in full.

Past that point this type shares no behaviour with its siblings: its own per-neighbour step, its own room, its own tunnel walk, its own per-cell carve.

## Three of the eight fields do nothing here {#nether-inert-fields}

The loader takes all eight and `featurelab check` reports no problem with them, but only five reach anything.

**`height_limit` and `y_scale` are inert.** The base carver clamps every ellipsoid against `height_limit` and uses it to decide where a system starts; this one does not read it at all. Its vertical range is fixed: a system's anchor is picked evenly over 0 to 127, and every row it writes is clamped into 3 to 120, whatever the JSON says. Checked by running this page's fixture in a 128-row bench across eight seeds: the highest cell any of them writes is world Y 120 exactly, and the lowest is 3. `y_scale` is read by the base carver's rooms and by nothing here.

Verified directly: this page's fixture with `height_limit: 8` and `y_scale: {range_min: 0.1, range_max: 9.0}` added produces the identical **1,322** cells at the identical positions as the fixture without them.

**`horizontal_radius_multiplier` and `vertical_radius_multiplier` change the cave, but never its radii.** A tunnel step's horizontal radius here comes entirely from the system's own thickness, its taper along the walk, and `width_modifier`; the vertical radius is that number times a fixed per-walk scale. Neither multiplier is ever applied to either.

They are still **read**, though, and that is not nothing. A range whose two ends differ is resolved by picking a value between them, and a range whose ends are equal is not — and on this type that difference is the only thing about these two fields you can observe, because it moves everything the cave decides afterwards. Measured, same fixture, same seed, same bench:

| `vertical_radius_multiplier` | Cells carved |
|---|---|
| `{0.7, 1.4}` | 1,322 |
| `{6.0, 9.0}` | **1,322**, at the same positions |
| `{0.0, 0.001}` | **1,322**, at the same positions |
| `{1.0, 1.0}` (ends equal) | 423 |
| `{6.0, 6.0}` (ends equal) | 423 |

Three different ranges with distinct ends give byte-identical output; two different equal-ended ones give a different byte-identical output. Only "do the two ends differ?" is observable. [The advanced section](#nether-random-values) says why.

**`floor_level` is live**, and is read by rooms and tunnels alike, exactly as on the base carver: its default of `0` carves only the upper half of every ellipsoid. Same fixture, same seed, both spellings with equal ends so neither is what is being seen: `{-1.0, -1.0}` carves 105 cells and `{0.0, 0.0}` carves 58.

`fill_with`, `width_modifier` and `skip_carve_chance` all behave as the [base carver's page](./cave_carver_feature.md#fields) describes.

## `fill_with` is the one field you must write {#nether-fill-with}

::: warning Always write `fill_with` on a Nether carver
The game's own loader marks it optional and will accept a file without it — but unlike the base carver, which checks for a missing value before writing and simply skips the write, this type hands the field straight to the block API the first time it carves anything. There is no "omitted" behaviour to fall back on.

featurelab is deliberately stricter than the game here and **refuses to load the file at all**, with an error saying why, rather than reproducing what an unwritten value does. That is the one place on this page where the tooling does not match the loader, and it is on purpose.
:::

## What it will dig — a very short list {#nether-diggable}

This is the biggest practical difference between this carver and its siblings, and the fastest way to conclude the feature is broken when it is working perfectly.

**The Nether carver digs exactly three things:** `minecraft:netherrack`, `minecraft:grass_block`, and the dirt family (`minecraft:dirt` and `minecraft:coarse_dirt`).

That is the whole list. Not stone. Not deepslate. Not soul sand, soul soil, basalt, blackstone, nether brick, magma, gravel, quartz ore or ancient debris. **Not air**, either, which is why a carve through a hollowed cavern appears in two separated bands rather than one. Anything else is left completely untouched even where the tunnel geometry reaches it, so a Nether carver run over anything but netherrack — or a patch of dirt or grass — writes nothing and reports success.

Measured with this page's own fixture, same seed, same origin: **0 cells** in featurelab's `underground_stone` bench, **1,322** in its `nether` bench.

## Lava stops a tunnel step before it starts {#nether-lava-veto}

Before carving a step's ellipsoid, this carver scans the region that ellipsoid would touch for `minecraft:lava` or `minecraft:flowing_lava`, and **if it finds any, the whole step is skipped** — not the individual cells near the lava, the entire ellipsoid.

The scan is not a full box sweep. The edge columns of the region are checked over their whole height plus a two-row margin above and below; the interior columns are checked at only three rows — two above the region's top, and one and two below its bottom. So the carver is looking for lava it would *break into* — a lava sea below, a pool the tunnel would open from the side — rather than lava embedded in the middle of the rock it is digging through.

This is the mechanism that keeps Nether tunnels from routinely draining the lava sea into themselves. It also means a carver configured to dig near the lava level produces visibly fewer, shorter tunnels there than the same configuration higher up, with nothing in the JSON to explain it.

The base and underwater carvers have no equivalent: the base carver's lava handling is a per-cell check inside its own carve, not a step-level veto.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [tables above](#fields) are the summary; where the two differ in precision, the tables are the measured version — and for `fill_with`, `height_limit`, `y_scale` and the two radius multipliers they genuinely differ, because the catalogue describes the shared schema rather than what this one id does with it.

<!--@include: ../generated/fields/nether_cave_carver_feature.md-->

## What the bench does differently

featurelab implements this type in full: the shared front door, its own rooms and tunnel walk, the lava veto, the three-block list and the Y clamp. Four things about reading a preview of one are worth knowing.

- **`fill_with` is required here and optional in the game's own schema.** That is a deliberate divergence, not a gap: the alternative is reproducing what writing an unset block does, which is not behaviour worth having. It is the only place this type's loader is stricter than the game's.
- **A `width_modifier` that calls `math.random` cannot be reproduced at all, and that is the game's doing.** Those calls draw from a generator with no world seed behind them, so the same world at the same seed gives a different value every time. featurelab substitutes a seed-derived generator so a preview stays stable while you edit, and says so in a build warning. See [RNG and determinism](./rng_and_determinism.md).
- **The preview's own volume is part of the measurement.** A bench builds its terrain to fit whatever volume you ask for, so two runs are comparable only at the same `--size` and `--min-y`. A carve at the edge of the bench is also clipped by the bench, which a real world has no equivalent of.
- **`featurelab check` never runs a placement.** It reports a missing `fill_with` and a range written `min`/`max`; it cannot tell you the bench is not made of netherrack, or that a `height_limit` you wrote will be discarded. Those are `featurelab generate`'s `diagnostics`, and the preview panel's Diagnostics section.

## Advanced: where the random values go {#nether-random-values}

You do not need this section to build one of these. It is for reading a preview value for value against the game. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into, and [the cave carver's own advanced section](./cave_carver_feature.md#carver-random-values) is the one to read beside it, because the placement is identical and everything after it is not.

**The placement.** Two unbounded integer draws up front, turned into two odd multipliers, then a re-seed per neighbour from `chunkX * a + chunkZ * b` XOR-ed with the placement's stored seed. Identical to both siblings, formula included.

**Per neighbour, in this order:**

1. `nextIntBound(10)`, then `nextIntBound(that + 1)`, then `nextIntBound(that + 1)` — the system count, 0 to 9, heavily skewed small. The base carver's first bound is 40 rather than 10.
2. `nextIntBound(skip_carve_chance)` — the skip roll.
3. `floor_level`, then `horizontal_radius_multiplier`, then `vertical_radius_multiplier`: each is one float draw **when the range's ends differ and no draw at all when they are equal**. That, and only that, is why the table in [the inert-fields section](#nether-inert-fields) looks the way it does — the values themselves are discarded for the two multipliers, but taking the draw shifts everything after it.
4. **All of the above happen before the early-out**, so a neighbour that is about to be skipped, or that rolled a count of zero, still costs those draws.

**Per system:** `nextIntBound(16)` for Z, `nextIntBound(128)` for Y, `nextIntBound(16)` for X — Z first, then Y, then X. Then `nextIntBound(4)` for whether a room opens the system, and if it does, a room call plus `nextIntBound(4) + 1` for how many tunnels follow. Then, per tunnel round, one float for the yaw, one for the pitch, and two more for the thickness (`(f1 * 2 + f2) * 2`).

**Per tunnel.** A tunnel takes exactly one unbounded integer from its caller to seed its own local generator and draws everything else from that: the length, `112 - nextIntBound(28)`, so 85 to 112 steps and never more; the branch step, `nextIntBound(distance / 2) + distance / 4`; the decay selector, `nextIntBound(6)`, choosing `0.92` on zero and `0.7` otherwise; then per step, three floats for the pitch accumulator, three for the yaw accumulator, and one `nextIntBound(4)` deciding whether this step carves. A fork spends one float per child for its thickness, and each child chains off the parent's local generator. A room is the same call with its own one float for thickness (`1 + f * 6`, so 1 up to but never 7) taken before it.

**The carve itself draws nothing.** Unlike the [underwater carver](./underwater_cave_carver_feature.md#uw-random-values), which spends one float per cell on one row, this type's per-cell write is draw-free — the lava scan and the three-block test included.

### The fixture

The worked example is [`nether_cave_demo.json`](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures/features). Every variant measured on this page is that file with one key changed, added or removed.

## See also

- [Cave carver feature](./cave_carver_feature.md) — the base carver. Read it for the per-chunk architecture this type shares, for the fields that behave the same way on both, and for the side-by-side table of which field is live on which type.
- [Underwater cave carver feature](./underwater_cave_carver_feature.md) — the third carver, which inherits the base carver's behaviour wholesale and diverges only in what it writes per cell. The opposite shape of divergence from this one.
- [Feature rules](./feature_rules.md) — how a carver reaches a world at all, and the `pregeneration_pass` that is the only pass a carver may run in.
- [RNG and determinism](./rng_and_determinism.md) — the model the advanced section fits into.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type is behaviourally identical between the two versions. All three carvers use the same odd-number adjustment in their seed mixing.

Every number quoted was produced by running the exact JSON above — or that file with one key changed — through `featurelab generate` and reading the counts and coordinates back out of the result: the two inert-field comparisons, the five-row radius-multiplier table, the `floor_level` pair, the 0-versus-1,322 diggable-list measurement, the 9 cells at origin `(0, 48, 0)`, and the example's own counts, coordinates and two bands. The Y clamp was checked by running the fixture in a 128-row bench across eight seeds and reading the highest and lowest row written; 120 and 3 both occur. The image was rendered from the example's own run by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), sliced as the tip describes.

One number was re-measured rather than carried over. The inert-field comparison was previously quoted as 423 cells; 423 is this fixture with a *degenerate* `vertical_radius_multiplier`, and the fixture as it is written carves 1,322. Both comparisons hold — the cells are identical with and without `height_limit` and `y_scale`, at either baseline — but the baseline named was the wrong one. The walk's own bounds were re-read at the same time and all hold as stated: 0 to 9 systems, an anchor height of 0 to 127, 85 to 112 steps, a fork between a quarter and just under three quarters of the way along, and a room thickness of 1 up to but not including 7.

This carver's coordinate handling in this tool was wrong until recently: chunk-local X and Z reached a world-space block API, which meant it carved correctly at origin 0 and carved *nothing* anywhere else. It was fixed, and the fixture and figure above are rooted at a non-zero origin specifically so that the same mistake cannot be made again without a picture on this page changing.
