---
title: Fossil feature
description: minecraft:fossil_feature buries one of the game's own eight fossil structures in the terrain and speckles its bones with an ore you choose. Both keys in a table, what max_empty_corners really tests, and why a rotation turns a fossil's bones when a structure template's blocks stay put — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:fossil_feature
category: content
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Fossil feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:fossil_feature` buries one of the game's own eight fossil structures — four spines, four skulls — somewhere under the terrain near its origin, and swaps roughly one bone block in ten for an ore block you name.** You reach for it when you want vanilla's buried-skeleton set dressing with a different reward inside it, and that is very nearly all you can ask it for.

It is a **Content feature**: it writes blocks itself and never delegates. It is also the most opinionated type in the system. You choose the ore and how fussy the burial check is, and the game chooses everything else — which of the eight, which way round, how far it slides, how deep it sinks. There is no field naming a structure, no depth control and no rotation control, so if you want *your* structure at *your* position, that is a [structure template feature](./structure_template_feature.md) and not this.

## Start here: a complete example

One file, complete. A fossil whose bones are speckled with diamond, refused if more than half of its box's corners are open:

```json title="features/diamond_fossil.json"
{
  "format_version": "1.21.110",
  "minecraft:fossil_feature": {
    "description": { "identifier": "wiki:diamond_fossil" },
    "ore_block": "minecraft:diamond_ore",
    "max_empty_corners": 4
  }
}
```

What each choice buys you:

- **`ore_block: "minecraft:diamond_ore"`** is what makes a fossil worth digging out. It replaces about a tenth of the fossil's blocks; the rest stay `minecraft:bone_block`. See [what the two passes leave behind](#two-passes).
- **`max_empty_corners: 4`** is the only tuning knob the type has. Four of the eight corners of the fossil's box may be open — air, water or lava — before the placement is refused. See [`max_empty_corners`](#max-empty-corners).
- **No other keys, because there are none.** Both of these are required; nothing else is accepted.

```
featurelab generate --pack <pack> --feature wiki:diamond_fossil --env plains --seed 1 --size 32x48x32 --min-y 30
```

Run against `plains` with feature seed `1`, this writes **107** blocks — 92 `minecraft:bone_block` and 15 `minecraft:diamond_ore` — spanning world `(-12 to 0, 45 to 49, 3 to 11)`. Seven of those 107 landed on ore the terrain preset had already put there, which nothing in this type cares about: a fossil overwrites whatever it finds. The origin the command resolved to is `(0, 63, 0)`, the top of the terrain column, and the fossil's own anchor is at `(0, 45, 3)` — eighteen blocks down and three blocks south of where you pointed it.

::: tip Why the numbers on this page have no picture beside them
Every other type page here shows you a render. This one cannot: the eight structures are Mojang's game assets and are not shipped with featurelab, so the shared fixture pack the documentation's images are generated from has no fossil in it — adding one would make that pack refuse to load on any machine without a copy of the game. Point `--pack` or `--structures` at your own installed vanilla behaviour pack and every command on this page runs. See [the eight structures](#the-eight-structures).
:::

## Fields

Two keys, both required, and that is the whole schema. "Default" is what the game uses when the key is absent — there is nothing optional here to default. The long-form account of both keys, in the editor's own words, is the [field reference](#field-reference) further down.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `ore_block` | yes | a block descriptor | — | The block that replaces about one bone in ten. It is written over the bone, not mixed in beside it, so it always ends up inside the fossil's own silhouette. See [the two passes](#two-passes). |
| `max_empty_corners` | yes | integer | — | How many of the **eight corners** of the fossil's box may be air, water or lava before the placement is refused. `0` demands all eight be inside solid material; `8` accepts anything, including a fossil hanging in open air. A fraction does not load: `max_empty_corners must be an integer`. See [`max_empty_corners`](#max-empty-corners). |

Leaving either key out is a load error — `ore_block is required`, `max_empty_corners is required` — and the whole file is gone with it.

There is no `structure_name`, no `facing_direction`, no depth or radius, and no `may_replace`. This is not a shortened list; it is the list.

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| A `structure_name`, expecting to use your own fossil | The key does not exist and is ignored. You get one of the game's eight. | Use a [structure template feature](./structure_template_feature.md), which is the type that takes a file name. |
| `"max_empty_corners": 0` expecting "only fully buried fossils" | Only **eight points** are tested — the corners of the box. A fossil whose middle is inside a cavern passes as long as its corners are in rock. | Accept that this is a corner test, not a volume test. There is no field that checks the inside. |
| `"max_empty_corners": -1` to switch the check off | It does switch it off, but through a sign quirk rather than a documented value: the comparison treats a negative bound as enormous, so nothing can exceed it. | `8` says the same thing plainly — every corner may be empty — without depending on the quirk. |
| `"max_empty_corners": 4.5` | Refused at load: `max_empty_corners must be an integer`. | A whole number. |
| Expecting `ore_block` to replace every bone | It replaces about one block in ten. The rest are bone, and about one in ten of the structure's blocks is left out of the fossil altogether. | Nothing to fix — that is the vanilla look. If you want a solid block of something, that is an [ore feature](./ore_feature.md). |
| Expecting the fossil to be centred on the origin | It is not near it either. The fossil slides up to twelve blocks east and south of the origin, then sinks 15 to 24 blocks, and then grows away from its anchor in whichever direction the rotation points — which can be west and north. | Treat the origin as "somewhere in this chunk", which is how a [feature rule](./feature_rules.md) uses it anyway. See [where a fossil ends up](#where-it-lands). |
| Expecting the bone blocks to keep the orientation they have in the file | They do not. A quarter turn turns each bone block's pillar with it, so a bone laid along X comes out along Z. This is the opposite of what a [structure template feature](./structure_template_feature.md#what-the-bench-does-differently) does with a rotated structure. | Nothing to fix — it is the right behaviour for a fossil. It is worth knowing because the two types disagree. See [a rotation turns the bones too](#rotation). |
| Previewing one in a short or narrow volume and reading the failure as a JSON problem | A fossil needs room. `No blocks could be placed` in an area ten blocks tall is the preview area, not your file. | Grow the volume. See [what the bench does differently](#what-the-bench-does-differently). |

## How it runs

Given an origin, the game runs these steps in this order:

1. **Ask whether a structure feature already claims this spot** — a village, a mineshaft, anything of that kind. If one does, nothing is placed and the feature stops here.
2. **Pick a rotation**, one of four quarter turns about the vertical axis.
3. **Pick one of the eight structures.** Four spines and four skulls, equally likely.
4. **Pick how far to slide.** An offset east and an offset south of the origin, each as large as the room the rotated structure leaves inside a 16 × 16 chunk.
5. **Find the ground.** The lowest ground height across the rotated footprint, and never higher than the origin's own Y.
6. **Pick a burial depth:** 15 to 24 blocks below that.
7. **Count the open corners.** The eight corners of the fossil's box are looked at, and if more than `max_empty_corners` of them are air, water or lava the placement **fails** and nothing at all is written.
8. **Stamp the structure twice.** The first pass lays down bone blocks; the second overwrites about a tenth of them with `ore_block`. A tenth of the file's blocks are left out of both passes, which is what gives a fossil its gaps.

Nothing in step 8 can partly fail: once step 7 has passed, the fossil is written.

## The eight structures are game assets, not JSON {#the-eight-structures}

This is the part that surprises people. `fossil_feature` has no field naming a structure, because the set is fixed. The feature picks one of eight files that ship inside the vanilla behaviour pack, under `structures/fossils/`:

| Structure | Size (X × Y × Z) | Blocks in the file |
|---|---|---|
| `fossils/fossil_spine_01` | 3 × 3 × 13 | 37 |
| `fossils/fossil_spine_02` | 5 × 4 × 13 | 61 |
| `fossils/fossil_spine_03` | 7 × 4 × 13 | 97 |
| `fossils/fossil_spine_04` | 9 × 5 × 13 | 121 |
| `fossils/fossil_skull_01` | 6 × 5 × 7 | 86 |
| `fossils/fossil_skull_02` | 7 × 5 × 5 | 75 |
| `fossils/fossil_skull_03` | 5 × 4 × 5 | 58 |
| `fossils/fossil_skull_04` | 4 × 4 × 4 | 32 |

The four spines are ribcages: long on Z and thin, from a 37-block sliver to a 121-block rack. The four skulls are compact. Every block in every one of the eight is a `minecraft:bone_block` — never anything else — and the only thing that varies between them is which way the bone's pillar runs. That uniformity is what lets the ore pass work on a plain "is this a bone block" match.

::: note
You cannot substitute your own structures here and you cannot rename these. If you want an arbitrary buried structure, that is a [structure template feature](./structure_template_feature.md), not this type.
:::

## `max_empty_corners`, and what "buried" actually means {#max-empty-corners}

The check looks at exactly **eight points**: the corners of the box the chosen structure would occupy at the position it has chosen. A corner counts as empty if the block there is air, **water or lava** — an aquifer or a lava lake refuses a fossil exactly as a cave does. If more than `max_empty_corners` of the eight are empty, the placement fails and nothing is written.

A low value demands the fossil be almost fully enclosed and makes fossils rare; a high value lets them break the surface or hang into a cave. `8` disables the check, because eight is all there are.

Two things about it are easy to assume the other way round.

- **It is a corner test, not a volume test.** The interior of the box is never looked at. A fossil whose middle is a cavern but whose eight corners are in rock is accepted, and a fossil entirely inside rock whose box happens to clip a cave at one corner is not.
- **It tests the box, not the bones.** The box is the whole rectangular extent of the chosen structure, including the parts of it that are empty. A 3 × 3 × 13 spine is a thin ribcage inside a large box, so its corners are often well away from any bone.

A run that shows the check doing its work: point the example above at a preview volume whose floor sits above the terrain, so the fossil's anchor is forced into open air.

```
featurelab generate --pack <pack> --feature wiki:diamond_fossil --env plains --seed 1 --size 32x24x32 --min-y 60
```

At `max_empty_corners: 4` — the example's value — this writes nothing and reports one warning, `Too many empty corners`. Raise the same file to `8` and the identical run writes all 107 blocks, hanging in the air above the ground where they would otherwise have been buried. `-1` does the same as `8`, for the reason the mistakes table gives.

## What the two passes leave behind {#two-passes}

The structure is stamped **twice**, and both passes work through the file's blocks in the same order, keeping or skipping each one on the same decision. The first pass keeps about nine blocks in ten and writes them as bone. The second keeps about one in ten and writes those as `ore_block`, over the bone the first pass just laid there.

The result, for any fossil:

| Share of the file's blocks | What ends up there |
|---|---|
| about 80% | `minecraft:bone_block` |
| about 10% | your `ore_block` |
| about 10% | nothing — the cell is left as it was |

So the ore is always **strictly inside the bone silhouette**, never sticking out of it, and the fossil has holes in it. Both are what makes a fossil read as a fossil rather than as a block of bone. In the example run above, 92 of the 107 written blocks were bone and 15 were diamond ore, out of a 121-block structure.

Nothing here is configurable. There is no integrity field, no ore-density field and no way to make the ore pass leave the bone alone.

## A rotation turns the bones too {#rotation}

This is the one place where fossils and [structure template features](./structure_template_feature.md) — the other type that stamps a pre-authored structure — genuinely disagree, and it is worth reading twice because the two behave in opposite ways.

A structure template feature's rotation moves the structure's **positions** and leaves every block exactly as the file stores it: a log built lying along X is still lying along X after a quarter turn, in a new place. A fossil's rotation moves the positions **and turns the blocks**: a bone block whose pillar runs along X comes out with its pillar running along Z. Vertical pillars are never touched by either type, and a half turn changes no block at all — turning a pillar 180° leaves it on the same axis.

| Rotation | Positions | A bone block's `pillar_axis` |
|---|---|---|
| none | unturned | unchanged |
| a quarter turn, either way | turned | **`x` ↔ `z`**, `y` unchanged |
| a half turn | turned | unchanged |

You can see it without any special tooling, because one of the eight structures makes it unmissable. `fossils/fossil_skull_04` is a 4 × 4 × 4 cube whose file contains only X-pillar and Y-pillar bone blocks — not a single Z-pillar block anywhere in it. Run the example file on `plains` at seeds 2 and 11:

```
featurelab generate --pack <pack> --feature wiki:diamond_fossil --env plains --seed 2 --size 32x48x32 --min-y 30
featurelab generate --pack <pack> --feature wiki:diamond_fossil --env plains --seed 11 --size 32x48x32 --min-y 30
```

Both place that same structure, and both place 30 of its 32 blocks in the same 4 × 4 × 4 footprint. Seed 2 comes out unturned: 13 X-pillar bones and 16 Y-pillar ones, and no Z-pillar block at all. Seed 11 comes out quarter-turned: 13 **Z**-pillar bones and 13 Y-pillar ones, and no X-pillar block at all. The shape is the same cube either way — only the block states moved.

The practical consequence is small but real: a fossil never looks wrong after a rotation, which is exactly why the game can afford to turn them at random. A rotated structure template feature can, if you built it out of directional blocks.

## Where a fossil ends up {#where-it-lands}

Three things move a fossil away from the origin you gave it, and they compose.

- **The slide.** An offset east and an offset south, each drawn within the room the rotated structure leaves in a 16 × 16 chunk. The room is `16` minus the structure's own width on that axis, so the narrowest structure can slide furthest: the largest offset any of the eight can take is **twelve** blocks, and a 13-deep spine gets at most **two** along its long axis. A quarter turn swaps which of its two sizes limits which axis.
- **The burial.** The fossil's anchor sits 15 to 24 blocks below the ground — specifically, below the *lowest* ground height across the rotated footprint, so a fossil that straddles a slope goes under the lower side. The origin is a ceiling on this too: the anchor is never higher than 15 blocks below the origin's own Y, so handing this feature an origin underground buries the fossil from *there*, not from the surface.
- **The rotation.** The structure grows away from its anchor in a direction the rotation chooses, so although the slide is always east and south, the fossil itself can end up west and north of the anchor. In the example run the anchor is at `(0, 45, 3)` and the fossil occupies `x -12 to 0` — the whole of it west of the anchor.

Added up: a fossil can be anywhere in the chunk-sized neighbourhood of the origin and roughly two dozen blocks under it. If you need one in a known place, this is not the type.

## Field reference

The long-form account of both keys, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind) the editor's forms are built from. The [table above](#fields) is the summary; where the two differ in precision, the table is the measured version.

<!--@include: ../generated/fields/fossil_feature.md-->

## What the bench does differently

featurelab implements `minecraft:fossil_feature` in full — both keys, the structure choice, the rotation, the slide, the burial, the corner test and both placement passes. Four things are worth knowing when you run one.

- **The eight structure files are not shipped, and the feature refuses to build without them.** They are Mojang's own game assets. Point `--pack` or `--structures` at a directory whose `structures/` folder holds `structures/fossils/fossil_spine_01.nbt` through `fossil_skull_04.nbt` under exactly those names — your own installed vanilla behaviour pack's `structures/` directory will do. If any of the eight is missing, `featurelab check` names every absent file and the feature does not load, rather than silently placing nothing on every call.
- **Step 1 never fires here.** This bench has no model of structure features at all, so it can place a fossil where the game would have stood aside for a village or a mineshaft. That affects every fossil equally rather than particular packs, and it is a property of previewing one feature on its own.
- **The game reports a fossil as placed even when none of it survives.** It never checks what either placement pass wrote, and its own per-block clipping is switched off on this path, so a fossil that lands somewhere the world does not keep is still a success as far as the game is concerned. This bench cannot honestly do that, because writing outside a finite previewed volume is something it *can* detect and a parent feature would be misled by a success that placed nothing — so it reports a failure the game has no equivalent of, and names the geometry that caused it.
- **That failure has two causes, and both are the preview area being too small.** A fossil is buried 15 to 24 blocks below the surface and its anchor is never put lower than ten blocks above the bottom of the generated area, so an area **ten blocks tall or less has nowhere to put one at all**: every seed reports `No blocks could be placed`, with a message naming the sizes. Eleven blocks tall is enough for the check to start passing. The slide can also carry a fossil off the eastern or southern edge, so an area **narrower than about thirty-two blocks** loses some placements to that alone. Neither is anything about your JSON. Both are only reachable once the corner check has passed, which over thin terrain means `max_empty_corners` is `8` or negative; otherwise `Too many empty corners` is what you get first.

One correction to the engine's own note on this type, kept here because the page is the measured version: the note says the slide reaches "up to fifteen blocks east and south". Twelve is the true maximum, and only the narrowest of the eight structures can reach it.

## Advanced: the five random values, and the two local streams {#random-draws}

You do not need this section to place a fossil. It is for reading a preview against the game value for value, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this section is this type's row in it.

Exactly **five** values are taken from the world-generation stream, always the same five, always in this order:

| # | Call | What it decides |
|---|---|---|
| 1 | `nextIntBound(4)` | the rotation, `0`–`3` |
| 2 | `nextIntBound(8)` | the structure: `0`–`3` are `fossil_spine_01`–`04`, `4`–`7` are `fossil_skull_01`–`04` |
| 3 | `nextIntBound(16 - rotatedSizeX)` | the eastward offset |
| 4 | `nextIntBound(16 - rotatedSizeZ)` | the southward offset |
| 5 | `nextIntBound(10)` | the burial jitter |

`rotatedSizeX` and `rotatedSizeZ` are the structure's own sizes with X and Z swapped when the rotation is `1` or `3`, so the bound of draws 3 and 4 depends on which structure draw 2 picked and which way draw 1 turned it. Every bound is exclusive, which is why the largest offset any of the eight can take is `15 - 3 = 12` and not 15: `fossils/fossil_spine_01` is 3 wide, so its own bound is `nextIntBound(13)`.

The height scan between draws 4 and 5 is draw-free, and so is the corner test after draw 5. The anchor is
`y = max(minY + 10, groundHeight - nextIntBound(10) - 15)`, where `groundHeight` is the smaller of the origin's own Y and the lowest above-top-solid height over the rotated footprint.

Two things follow that matter if you are matching a sequence value for value.

- **The abort in step 1 draws nothing.** When a structure feature already claims the position, the feature returns having taken zero values, and everything after it in the chunk sees an unshifted sequence.
- **Both failure paths after step 5 have already spent all five.** A fossil refused for empty corners costs exactly what an accepted one costs, so setting `max_empty_corners` low places fewer fossils and desynchronises nothing.

### The two placement passes {#two-passes-advanced}

Neither pass touches the world-generation stream. The world generator's seed is read once, before either pass, and each pass builds a **brand new** generator from that same value — so the two replay an identical float sequence over an identical block list.

Per pass, per block in the file, in file order: one float is taken, and the block is written if that float is at or below the pass's integrity. The first pass's integrity is `0.9`, the second's is `0.1`, and neither is a JSON field. Because the two sequences are identical, a block whose float is at or below `0.1` is written as bone by the first pass and then overwritten with `ore_block` by the second; one between `0.1` and `0.9` stays bone; one above `0.9` is written by neither. That is the 80 / 10 / 10 split, and it is why the ore can never fall outside the bone silhouette.

The ore pass's rule matches the block it is about to place at type level — ignoring the pillar axis — at probability `1.0`, which short-circuits without taking a value, and its world-side test is unconditionally true. So every block the ore pass keeps becomes `ore_block`, never bone, and the pass never needs to work out a rotated axis at all.

### The corner box

The eight corners are the corners of the box spanning the anchor `p` to `p + extent`, and the extent is worked out from the structure's **unrotated** size with the rotation choosing which of four formulas applies — the box is "inverted" on X, on Z, or on both, for rotations 2, 1 and 3 respectively. Only the count matters, not the order. The emptiness test is the block's material type being air, water or lava.

The comparison the check makes is `(unsigned)count > (unsigned)max_empty_corners`, which is the whole of why a negative `max_empty_corners` accepts everything: it sign-extends to an enormous unsigned bound that a count of at most eight can never exceed.

## See also

- [Structure template feature](./structure_template_feature.md) — the type to reach for when you want your own structure, your own position and your own rotation. Also the type whose rotation leaves block states alone, where this one turns them.
- [Ore feature](./ore_feature.md) — the ordinary way to scatter an ore block through stone, with replace rules and a shape you control.
- [Cave carver feature](./cave_carver_feature.md) — the carvers whose cavities `max_empty_corners` is implicitly guarding against.
- [Feature rules](./feature_rules.md) — how a fossil reaches a world at all, and why "the origin" is really "somewhere in this chunk".

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — both keys and their required status — and its whole behaviour, from the placement sequence through the structure stamp, the corner test and the structure-feature check, are unchanged between the two.

Every number and every quoted message on this page was read back out of a run. The example's 107 blocks, their 92 / 15 split and their extent; the anchor at `(0, 45, 3)`; the `Too many empty corners` refusal at `max_empty_corners` `4` and the same run's 107 blocks at `8` and at `-1`; the three load errors; the `No blocks could be placed` message in a ten-block-tall area and its absence at eleven. The eight structures' sizes and block counts were read out of the files themselves, and are byte-identical across every build of the game checked. The 80 / 10 / 10 split was measured over 74,000 block decisions rather than inferred from the two integrity values.

The rotation claim — that a quarter turn turns each bone block's pillar — was measured the way the page describes it, by running seeds 2 and 11 against `fossils/fossil_skull_04` and reading the placed block states: the structure's own file has no Z-pillar block in it, and the quarter-turned placement has nothing but Z where the unturned one has X. What is **less certain** is the rule behind that observation rather than the observation itself: the X ↔ Z swap on a quarter turn is certain for this bench, and the claim that the game does the same is a reconstruction from how the structure's own block data is written. If a rotated fossil in a real world ever disagrees with a preview, this is the thing to check first. The contrasting claim about [structure template features](./structure_template_feature.md#what-the-bench-does-differently) — that their copy writes each block exactly as stored, so a rotation turns positions only — is stated on that page as a fact about the bench, with the same caveat.

Two further things are named rather than smoothed over. The example was run against a pack supplying the eight vanilla structure files; it is not a committed fixture, because committing one would make the documentation's shared fixture pack refuse to load on a machine without them. And the claim that the game reports a fossil as placed even when none of its blocks survive is a statement about a code path this bench deliberately does not reproduce, not something a preview can show you.
