---
title: Multiface feature
description: minecraft:multiface_feature sticks a glow lichen or sculk vein onto the face of a block next to the origin and lets it creep one step further. Every key in a table, which of the origin's neighbours it really tries, the three blocks that can carry a face at all, and why a reported success can write nothing — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:multiface_feature
category: content
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Multiface feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:multiface_feature` sticks a face block — glow lichen, sculk vein, resin clump — onto the surface of a block next to the origin, and then gives it one chance to creep one step further.** It is the only feature type that adds itself to a block that is already there: where a position already holds the same face block, the new face is added to the faces it already carries instead of replacing it, which is how a single lichen ends up wrapping two sides of the same stone.

It is a **Content feature**, and it is a *one-position* type: one call sticks at most one block down, plus at most one more if the spread fires. You do not reach for it to cover a cave wall — that is a [scatter feature](./scatter_feature.md) with this one as its delegate, called at every offset — and you do not reach for it for a block that does not attach to faces, because the face state is the whole mechanism. Something has to call it at all, which is a [feature rule](./feature_rules.md).

## Start here: a complete example

One file, complete. Glow lichen that will attach to stone, grass or dirt, on any of the six faces, with an even chance of creeping one step:

```json title="features/glow_lichen.json"
{
  "format_version": "1.21.110",
  "minecraft:multiface_feature": {
    "description": { "identifier": "wiki:glow_lichen" },
    "places_block": "minecraft:glow_lichen",
    "search_range": 10,
    "can_place_on_floor": true,
    "can_place_on_ceiling": true,
    "can_place_on_wall": true,
    "chance_of_spreading": 0.5,
    "can_place_on": ["minecraft:stone", "minecraft:grass_block", "minecraft:dirt"]
  }
}
```

What each choice buys you:

- **`places_block: "minecraft:glow_lichen"`** is written as a bare name, and that is enough: the feature sets the face state itself. Only three vanilla blocks can carry a face at all — see [which blocks can be a multiface block](#which-blocks).
- **The three `can_place_on_*` flags** decide which of the six directions the block is willing to hang from — here all of them. They are all required, and turning all three off is a file that can never place anything.
- **`can_place_on`** is the list of blocks that may serve as the surface. It is the only optional key on the type, and leaving it out does **not** mean "any surface will do" — it usually means nothing is placed at all. See [`can_place_on` is not optional in the way it looks](#can-place-on).
- **`chance_of_spreading: 0.5`** is the chance, rolled once after a block actually goes down, that a second one creeps off it. It is not a patch size: see [spreading](#spreading).
- **`search_range: 10`** changes nothing you can observe. It is retries at one position, not reach — see [`search_range` is not a radius](#search-range).

![Glow lichen blocks placed on a grass surface, rendered by featurelab's voxel viewer](../../wiki/images/multiface-feature-glow-lichen.png)

```
featurelab generate --pack <pack> --feature wiki:glow_lichen --env plains --seed 1 --origin 0,64,0
```

Run against the `plains` preset — whose top solid block in the column at `(0, 0)` is the grass at `Y 62`, over dirt over stone — with feature seed `1` and origin `(0, 64, 0)`, deliberately **two** blocks above that grass, this writes **2** glow lichen blocks, at `(0, 63, 0)` and `(-1, 63, 0)`, each carrying its down face. Neither is at the origin. The origin cell has nothing but air around it, so nothing there can serve as a surface; the feature then steps one block down to `Y 63`, where the grass below *is* on the `can_place_on` list, sticks the lichen to its underside, and the spread roll carries a second block west to `(-1, 63, 0)`.

::: tip The origin is the empty cell, not the block you want to cover
This trips almost everyone once. The position you hand a multiface feature has to be **air or water** — it is where the lichen goes, not what it grows on. Aim at the stone itself and the call ends immediately with `Location does not contain air or water` and nothing placed, which is exactly what `featurelab generate --origin 0,62,0` reports against this same file.

Aiming one cell *too far* into the open, as this example does on purpose, still works, because the feature also tries the six cells around the origin. Two cells out is where it stops working.
:::

## Fields

Seven keys, six of them required — this type has the highest ratio of required keys of any feature type, and a file missing any one of them does not load. "Default" is what the game uses when the key is absent. The long-form account of every key, in the editor's own words, is the [field reference](#field-reference) further down; this table is the short version.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `places_block` | **yes** | a block descriptor | — | The face block written. Write the bare name: the feature sets the face state, and writing one yourself is overwritten. Only three vanilla blocks can carry a face — see [which blocks can be a multiface block](#which-blocks). |
| `search_range` | **yes** | integer, `[1, 64]` | — | Retries at a position that already refused, so it changes nothing observable. **Not** a distance and nothing to do with [snap-to-surface](./snap_to_surface_feature.md)'s key of the same name. See [`search_range` is not a radius](#search-range). |
| `can_place_on_floor` | **yes** | boolean | — | Allows the block to sit on the **top** of the block below it, i.e. to carry its down face. |
| `can_place_on_ceiling` | **yes** | boolean | — | Allows it to hang from the **underside** of the block above it. |
| `can_place_on_wall` | **yes** | boolean | — | Allows all four vertical sides at once. There is no per-side control: north, east, south and west arrive together or not at all. |
| `chance_of_spreading` | **yes** | number, `[0.0, 1.0]` | — | The chance that a block that just went down creeps one step further. Rolled only when the write actually changed something. `0` switches spreading off; it does not switch the feature off. See [spreading](#spreading). |
| `can_place_on` | no | array of block descriptors, at least one entry when written | no restriction on the surface *block*, which is not the same as "any surface" | The blocks allowed to serve as the surface. Absent, this reads as "the first allowed direction is accepted whatever is there", which usually ends in nothing being written — see [`can_place_on` is not optional in the way it looks](#can-place-on). Written as `[]`, the file is refused at load. |

### The three direction flags, and the order they are tried in

The three booleans build one list of candidate directions, and the order is fixed by the schema, not by the order you write the keys in:

| Flag | Adds, in this order | Reach for it when |
|---|---|---|
| `can_place_on_floor` | down | The block should sit on top of something — lichen on a cave floor, vein over a slab. |
| `can_place_on_ceiling` | up | It should hang — the usual look for glow lichen in a cave roof. |
| `can_place_on_wall` | north, east, south, west | It should cling to a vertical face. All four, always. |

Which entry of that list actually receives the block is [not something any implementation can promise](#face-order).

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| An origin inside the block you wanted covered | `Location does not contain air or water`, nothing placed, immediately. The origin is the cell the lichen occupies. | Aim at the air or water cell touching the surface. |
| No `can_place_on` at all, meaning "attach to anything" | The first allowed direction is accepted whatever sits there, the block then refuses to attach to a surface that cannot hold it, and the call **reports success having written nothing** — and, because the origin already "succeeded", the six neighbours are never tried. The same origin *with* a list places two blocks. | Always write `can_place_on`. It is the only key that makes the direction test mean anything. |
| `"can_place_on": []` to mean "no restriction" | Refused at load: `can_place_on must be a non-empty array`. The whole file is gone. | Leave the key out only if you have read [the row above](#can-place-on); otherwise list the blocks. |
| All three `can_place_on_*` set to `false` | Loads without complaint, then fails on every single call with `No adjacent locations contain air or water`. | At least one must be `true`, or the file can never do anything. |
| `"places_block": "minecraft:stone"`, or any block that is not a face block | The block is written flat, with no face on it, and it can never spread. Nothing is reported. | Use `minecraft:glow_lichen`, `minecraft:sculk_vein` or `minecraft:resin_clump` — see [which blocks can be a multiface block](#which-blocks). |
| `"places_block": {"name": "minecraft:glow_lichen", "states": {"multi_face_direction_bits": 63}}` to get all six faces | The state you wrote is replaced by the one face the feature accepted. Writing it out changes nothing. | Write the bare name and let the feature decide, or call the feature repeatedly from a [scatter](./scatter_feature.md). |
| `"search_range": 64` to cover more of the wall | Nothing changes at all. The reach is fixed at the origin and its six neighbours. | Raise `chance_of_spreading`, or wrap the feature in a [scatter](./scatter_feature.md) and call it at many offsets. |
| `"search_range": 0` or `65` | Refused at load: `search_range must be in [1, 64] (the game's own schema bound)`. | Any value in `[1, 64]`. `10` is as good as any. |
| `"chance_of_spreading": 2.0` | Refused at load: `chance_of_spreading must be in [0, 1] (the game's own schema bound)`. | A value in `[0.0, 1.0]`. At `1.0` every placed block creeps exactly once, not endlessly. |
| `"chance_of_spreading": 1.0` expecting a patch | One extra block, once. The spread does not chain. | Call the feature many times from a [scatter](./scatter_feature.md). |
| Reading a reported success as "a block was written" | Success here means "a face was found", which includes the face the block then refused to attach to. | Count the cells, not the successes. `featurelab generate` says `placed successfully but wrote no blocks` when they disagree. |
| Comparing a preview's face or spread direction against a world | Both are picked from a source with no connection to the world seed, so two runs of the *game* disagree with each other too. | Compare *whether* and *how many*, never *where* — see [what the bench does differently](#what-the-bench-does-differently). |

## How it runs

Given an origin, the feature runs these steps in this order, and stops at the first one that succeeds:

1. **Check the origin is air or water.** Anything else and the call ends here with `Location does not contain air or water`.
2. **Build the list of candidate directions** from the three `can_place_on_*` flags: down, then up, then north, east, south, west, keeping only the ones their flag allows.
3. **Try to attach at the origin itself**, with the full list as candidate faces ([how a face is picked and written](#the-attach)). If it *succeeds* — which, importantly, is not the same as "writes something" — the call returns the origin and stops.
4. **If the list is empty**, the call ends with `No adjacent locations contain air or water`.
5. **Otherwise step one block out in each direction on the list, in list order.** A neighbour that is not air, not water and not already the same block is skipped. At the first one that is not skipped, try to attach again — this time with the list *minus the face pointing back at the origin*, because that face's surface would be the origin cell, which step 1 has already established is empty. The first neighbour that succeeds ends the call and is what the feature returns.
6. **If nothing succeeded**, the call ends with `No adjacent locations contain air or water` — the same sentence step 4 uses.

The feature never looks further than one block from the origin, in any direction, at any setting.

## How a face is picked and written {#the-attach}

Steps 3 and 5 above both run the same small routine at a position, and it is where most of this type's surprises live. Three things happen in order:

1. **A face is chosen.** Each candidate direction is tried in list order; the first one whose *surface block* — the block one step that way — is on the `can_place_on` list wins. With no `can_place_on`, the very first direction on the list wins unconditionally. **Only that one face is ever tried.**
2. **The surface is asked whether it can hold a face.** This is a separate question from `can_place_on`, and it is the one that stops lichen hanging in mid-air. If the answer is no, nothing is written — and the routine does **not** go back to step 1 for the next candidate face. It reports success anyway.
3. **The block is written.** If the position already holds the same block, the chosen face is added to the faces it already has; otherwise a fresh block is written with that one face. If the result is identical to what was already there — the face was already set — nothing is written. Only a write that actually changed the world rolls `chance_of_spreading`.

::: warning "Success" means a face was found, not that a block was written
Step 2 refusing still counts as success, and step 3 finding the face already set still counts as success. That matters because of where success is *used*: step 3 of [how it runs](#how-it-runs) returns immediately on success, so a silent refusal at the origin cancels the search through the six neighbours that would otherwise have found a real surface.

This is why [`can_place_on`](#can-place-on) is the key that matters most on this type, and why a run that reports a placement and shows nothing is a normal, reproducible outcome rather than a bug.
:::

## `can_place_on` is not optional in the way it looks {#can-place-on}

The schema calls it optional and every other block list on the site reads an absent list as "no constraint". Here the two combine badly. Absent, step 1 above accepts the **first direction on the list, whatever is next to it** — usually down, usually air. Step 2 then refuses, nothing is written, and step 3 of [how it runs](#how-it-runs) treats that as a success and stops.

Measured, on the example file with its `can_place_on` list deleted and everything else untouched:

```
featurelab generate --pack <pack> --feature wiki:glow_lichen --env plains --seed 1 --origin 0,64,0
```

**0** blocks, against **2** for the file as written. The same file at origin `(0, 63, 0)` — the cell directly on the grass, where down is a real surface — places both blocks with or without the list, because there the free acceptance happens to be right. That is the shape of the failure: it is invisible where the geometry is simple and total where it is not.

Write `can_place_on`. It costs one line and it is the only thing that makes the direction list mean anything.

## `search_range` is not a radius {#search-range}

`search_range` is bounded to `[1, 64]` and reads like reach. It is not. It is how many times the game re-attempts the attach routine at *one* position with *one* candidate list, and a refusal there is deterministic: nothing about the position, the list or the world changes between attempts, so an attempt that failed fails the same way every time.

The whole `[1, 64]` range is therefore observationally identical. Measured: the example file at `search_range: 1` and at `search_range: 64` produces the same two cells at the same positions.

What does grow a patch is `chance_of_spreading`, and — far more — calling the feature repeatedly from a [scatter feature](./scatter_feature.md).

## Which blocks can be a multiface block {#which-blocks}

Three vanilla block types carry the `multi_face_direction_bits` state, and they are the only sensible values for `places_block`:

| Block | Faces it starts with when placed by anything else |
|---|---|
| `minecraft:glow_lichen` | all six |
| `minecraft:sculk_vein` | none |
| `minecraft:resin_clump` | none |

Anything else — stone, a fence, a block another add-on defines — has no face to set. The feature still writes it, flat and whole, at the position it picked; it simply cannot carry a face and so can never spread. Nothing reports this, so it is worth checking the block name before concluding the feature is broken.

Note what the first row means in practice: a glow lichen written by a [single block feature](./single_block_feature.md), or by any other type, comes out covering all six faces. A glow lichen written by *this* type never does — it carries exactly the faces this feature gave it.

## Faces, and the bits they are written as {#state-bits}

`multi_face_direction_bits` is a six-bit number, `0` to `63`, one bit per face:

| Face | Bit |
|---|---|
| down | `1` |
| up | `2` |
| south | `4` |
| west | `8` |
| north | `16` |
| east | `32` |

A block covering its floor face alone is `1`; one covering floor and ceiling is `1 + 2 = 3`; all six is `63`. When this feature attaches to a position that already holds the same block, it **adds** the new bit to the ones already there rather than replacing them — a lichen already on a block's north face that gains a south face becomes `16 + 4 = 20`, one block, two faces. That addition is the whole reason this type exists as something other than a [single block feature](./single_block_feature.md), whose `places_block` is a plain overwrite.

## Which face gets the block {#face-order}

::: warning No implementation can tell you which face receives the block, including the game's own
The candidate list is shuffled before a face is chosen, and the shuffle is fed from a source with **no connection to the world seed**. Two runs of the game, same world, same seed, same chunk, can put the lichen on a different face. The shuffle does not touch the world's own random sequence, so it can never change what any other feature does — but it does mean the face is not something to design around.

Where several faces are simultaneously valid — the lichen is in a corner and both north and east would do — any of them may win. Where only one face is valid, the outcome is fixed, and that is the case worth designing for.
:::

## Spreading {#spreading}

When the `chance_of_spreading` roll comes up below the configured chance — strictly below, so `0` never spreads and `1.0` always does — the block that was just written gets one chance to creep. The spreader shuffles all six directions and tries each in turn, taking the first that produces a real change, in three fixed modes:

1. **Add a face at the same position.** The block gains a second face rather than a neighbour.
2. **Step one block over** and put the *original* face on the block there — the way lichen continues along a wall.
3. **Wrap around a corner:** step one block out along the face, then one block sideways, and attach on the opposite side. This is how a patch grows round a convex edge.

The first mode that changes something wins and the spread stops there. All three still require a surface that can hold a face, so a spread cannot walk into open air. **Spreading does not chain**: a block placed by the spread is not itself rolled for. One call writes at most two blocks.

::: warning Where a spread lands is not reproducible in the game
The direction shuffle comes from the same seed-independent source the face pick does, so the same world at the same seed spreads differently on every run of the game. Only *whether* it spreads is decided by the world's own sequence, and that part is reproducible.

Read a preview's spread as "one extra block, roughly here", never as the cell the game will use.
:::

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, bounds) the editor's forms are built from. The [table above](#fields) is the summary.

<!--@include: ../generated/fields/multiface_feature.md-->

## What the bench does differently

Two of this type's behaviours are not reproducible in the game at all, and the bench deliberately replaces them with reproducible ones rather than imitating a coin toss:

- **The face is picked in a fixed order instead of a shuffled one:** down, up, north, east, south, west, filtered by the three flags. This can only change *which* of several simultaneously-valid faces receives the block, never whether a block is placed, and never the world's own random sequence.
- **The spread direction is derived from your seed** mixed with the position being spread from, so editing a file moves the spread only when the edit did. `featurelab generate` emits a warning saying so on every run where the roll succeeds.

Both stand in for something the game itself cannot repeat between two runs, so there is no faithful answer to converge on. The roll that decides *whether* spreading happens is the world's own and does match.

Three narrower differences, each of which can change what you see:

- **"Can this surface hold a face" is coarse here.** The bench accepts a solid or glass block and refuses everything else — air, liquids, plants. The game's own test is per block and per face, so a block that holds a face on some sides and not others is modelled wrong in both directions by a whole-block answer. What the bench does get right is that the test exists, and that it applies to the first placement and to the spread alike, so omitting `can_place_on` cannot hang a block in open air here either.
- **A block the bench's own state catalogue does not know gets a face it may not be able to carry.** For the three vanilla face blocks the bench asks the block's *type* whether it declares `multi_face_direction_bits`, the same question the game asks, and a vanilla block that does not declare it is written flat exactly as the game writes it. A block another add-on defines is unknown to that catalogue, and the bench writes the face onto it anyway. Since only a write that changed something rolls `chance_of_spreading`, that difference can also produce a spread the game would not. Preview custom face blocks with this in mind.
- **The game additionally asks whether a candidate surface's own chunk is far enough generated, and whether a stronghold or mineshaft claims the position**, and grows nothing across either. The bench is one already-generated volume with no neighbours and no structures, so that test is trivially satisfied everywhere and never refuses. It is a universal difference, not a per-position one, which is why nothing warns about it.

One thing about reading the picture: blocks are coloured, not textured, and a face block is drawn as a whole cell. The image above shows *which cells the feature touched*, not the thin skin a lichen really is.

## Advanced: how the random values are spent {#random-draws}

You do not need this section to use a multiface feature. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

A call spends **one** value at most, and often none:

| Outcome | Draws | Notes |
|---|---|---|
| The origin is not air or water (step 1) | 0 | The call ends before the direction list is built. |
| The direction list is empty (step 4) | 0 | |
| No candidate face passes `can_place_on`, at every position tried | 0 | Each refusal is free, at the origin and at each of the six neighbours alike. |
| A face is accepted but the surface cannot hold it | 0 | Success is returned, nothing is written, and the roll never happens. |
| The face was already set on an existing block | 0 | The derived block equals the existing one, so no write and no roll. |
| A write actually changed the world | **1** | One float draw, taken immediately after the write, compared strictly against `chance_of_spreading`. |
| The spread that roll gates | 0 | Both shuffles — the six faces of the candidate list and the six spread directions — draw from a generator outside the world's sequence. The spread's own write costs nothing either. |

So at most one value per call, and the cost is a function of **whether a block changed**, not of the configuration: `search_range`, the length of `can_place_on` and the number of direction flags all cost nothing. Measured against a delegate chain whose next feature's positions record the sequence position: the example file — which writes two blocks — leaves the sequence exactly where a single value would, the same file at an origin where it succeeds without writing leaves it untouched, and so does the all-flags-false file that fails outright.

The consequence for a chain: turning `chance_of_spreading` up or down does not shift what is placed after this feature, because the roll happens either way. Turning a multiface feature from one that writes into one that does not — by moving its origin, or by deleting `can_place_on` — does shift it, by one value.

## See also

- [Single block feature](./single_block_feature.md) — the other Content feature that writes one block at one position, and the contrast that defines this one: a plain overwrite, where this adds a face to what is already there.
- [Scatter feature](./scatter_feature.md) — how this type covers an area rather than a cell: wrap it and call it at every offset the distribution produces.
- [Snap-to-surface feature](./snap_to_surface_feature.md) — the other type with a `search_range` key, which there really is a distance. The two are unrelated.
- [Feature rules](./feature_rules.md) — how any of this reaches a world; a feature file is inert until a rule attaches it to chunks.
- [RNG and determinism](./rng_and_determinism.md) — why two of this type's decisions are not reproducible even in the game, and what that does and does not affect.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — every key, bound and required/optional status — its placement and its spreading are identical in both, including the two non-reproducible shuffles, so both warnings above hold for the two versions exactly as written.

The example is a committed fixture and was run end to end; every count, coordinate and message on this page was read back out of `featurelab generate` or `featurelab check` against the [committed fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures): the two cells at `(0, 63, 0)` and `(-1, 63, 0)` and the face each carries, the plains column with grass at `Y 62`, the `Location does not contain air or water` end at origin `(0, 62, 0)`, the `No adjacent locations contain air or water` end with all three flags off, the identical result at `search_range` `1` and `64`, and the three load refusals quoted verbatim. The `can_place_on`-deleted run and the "0 against 2" comparison are control runs from the same file with that one key removed — the edit the section asks the reader to make for themselves. The image was rendered from the example's own result by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine with a fixed seed and a deterministic camera, so re-running it reproduces the picture byte for byte.

What is uncertain is named where it is relevant: the game's own "can this surface hold a face" test is not established, and [what the bench does differently](#what-the-bench-does-differently) says what stands in for it rather than claiming the game's answer. The three blocks that carry `multi_face_direction_bits` and the bit values are read from the game's own published block metadata. The face order and the spread direction are bench choices standing in for something the game does not repeat between two of its own runs, and are labelled as such everywhere they appear.
