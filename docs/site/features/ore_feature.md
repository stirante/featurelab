---
title: Ore feature
description: minecraft:ore_feature places a whole ellipsoidal vein of blocks in one call, resolved cell by cell through an ordered list of replace rules. Every key in a table, the +8 offset that moves the vein off your origin, and what the air-exposure gate really does — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:ore_feature
category: content
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Ore feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:ore_feature` places a whole vein of blocks in a single call.** It strings a line of spheres along a randomly angled axis through its origin, merges them into one lens-shaped blob, and then walks every cell of that blob against an ordered list of *replace rules* — each rule saying "where you find these blocks, write this one". You reach for it for anything that reads as a deposit in existing material: ores, clay, gravel, a pocket of anything.

It is a **Content feature** and a self-contained leaf: it never delegates to another feature, so unlike a [single block feature](./single_block_feature.md) reached over and over by a [scatter](./scatter_feature.md), a whole vein comes out of one call. You do not need it for a cluster of loose blocks in the open — a scatter over a single block feature is both simpler and easier to aim — and you do need something to call it at all, which is a [feature rule](./feature_rules.md).

## Start here: a complete example

One file, complete. Nine blobs of diamond ore through stone, discarding half of the cells that would otherwise break into open air:

```json title="features/diamond_vein.json"
{
  "format_version": "1.21.110",
  "minecraft:ore_feature": {
    "description": { "identifier": "wiki:diamond_vein" },
    "count": 9,
    "discard_chance_on_air_exposure": 0.5,
    "replace_rules": [
      {
        "places_block": "minecraft:diamond_ore",
        "may_replace": ["minecraft:stone"]
      }
    ]
  }
}
```

What each choice buys you:

- **`count: 9`** is nine *blobs* strung along the vein, not nine blocks. Overlapping spheres and cells that match no rule both mean fewer blocks than this number — here, nine blobs come out as ten cells.
- **`may_replace: ["minecraft:stone"]`** is what makes it a vein rather than a boulder: only stone is converted, so the vein takes the shape of whatever stone it happens to pass through. A rule with no list at all matches **nothing** — see [replace rules](#replace-rules).
- **`discard_chance_on_air_exposure: 0.5`** thins the vein where it would break into a cave or the open. In solid rock it never rejects anything, which is why this example is run underground.

![A small cluster of diamond ore embedded in the corner of a solid gray stone cutaway block, rendered by featurelab's voxel viewer](../../wiki/images/ore-feature-diamond-vein.png)

```
featurelab generate --pack <pack> --feature wiki:diamond_vein --env underground_stone --seed 1 --size 22x48x22
```

Run against the `underground_stone` preset (solid stone, no caves) with feature seed `1`, this places **10** diamond-ore blocks in a small cluster spanning world `(7–9, 30–32, 7–8)` — note how far that is from the requested origin `(0, 32, 0)`. That is [the `+8` offset](#the-8-offset), and it is the single most common reason a vein "isn't showing up".

::: tip A vein you cannot see is usually there
Two ordinary things hide a correct vein. It is **not centred on your origin** — look `+8` along X and Z. And an ore vein fully buried in solid rock is, correctly, invisible from outside it: a cell with solid neighbours on every side has no face to draw, in a preview as in the game. Neither is a failure to fix. Before adding `count`, check the cell list in `featurelab generate`'s result — the blocks are usually all there.

The failure that *is* worth chasing is a vein that places nothing at all, and it has two causes with the same symptom: `replace_rules` left out entirely, or a rule whose `may_replace` list is empty or absent. Both are silent.
:::

The picture is a **cutaway**, not a plain render: sliced to the vein's own top layer (world Y 29–32) and rendered with the surrounding rock solid rather than ghosted, so the stone reads as material and not as empty space. Both are viewing choices, not a change to what the feature placed — but the narrowed `--size` is not purely a viewing choice, and [what the bench does differently](#what-the-bench-does-differently) says why.

## Fields

Three keys on the feature body, two inside each replace rule. "Default" is what the game uses when the key is absent. The long-form account of every key, in the editor's own words, is the [field reference](#field-reference) further down; these tables are the short version.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `count` | yes | positive integer | — | How many blobs are strung along the vein and merged. A count of **blobs**, not of blocks placed. |
| `discard_chance_on_air_exposure` | no | number | `0` — never discard | Thins the vein where it touches air. Rolled **per rule-match attempt**, not once for the whole vein — see [the gate](#discard-chance). |
| `replace_rules` | no — **but a vein without it places nothing** | array of `{places_block, may_replace}` objects, minimum one entry | — | The ordered list every candidate cell is walked against. Leaving the key out loads fine and then places nothing, silently; writing it as `[]` is refused at load. See [the warning below](#replace-rules). |

### Inside a `replace_rules` entry

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `places_block` | yes | a block descriptor | — | The block this rule writes, where its own `may_replace` matched. `replace_rules[].places_block` is the one key in this object the schema insists on. |
| `may_replace` | no — **but a rule without it never fires** | array of block descriptors | — | Which existing blocks this rule is willing to convert. Unlike a single block feature's `may_replace`, an absent or empty list is **not** "no constraint": it matches nothing. And unlike every other block list on the site, the match is on block *type* always — states you write here are discarded. |

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `"replace_rules": []` to mean "place nothing for now" | Refused at **load** time, with a content-log line of the form *Array too small (0 < 1)*. The whole file is gone. | Leave the key out — that is the spelling that loads and places nothing. |
| No `replace_rules` at all, by accident | The file loads without complaint and the feature never places a block. Nothing is logged at placement time. And it is not free: the check sits *after* the vein's geometry has been settled, so removing the rules from a file shifts everything placed after it in the same chain. | Give it a rule. If you meant to disable the feature, take it out of whatever calls it. |
| A rule with no `may_replace`, expecting "no constraint, matches anything" | That shorthand belongs to a [single block feature](./single_block_feature.md#block-matching), not here. The same list-membership test runs either way, so an empty list simply never matches and the rule never fires. | Always give `replace_rules[].may_replace` an explicit list: `["minecraft:stone"]` and similar. |
| `{ "name": "minecraft:oak_log", "states": { "pillar_axis": "x" } }` in a rule's `may_replace` | The states are discarded: the comparison here is on block type, always. The entry matches every state of that block. | Write the bare name; if you needed the states to narrow it, this field cannot do that. |
| Looking for the vein at the origin you asked for | It is offset `+8` on X and Z — a `count: 9` vein placed at `(0, 32, 0)` centres around roughly `(8, 31, 8)`. | Look `+8` away, or place the feature 8 blocks back. See [the `+8` offset](#the-8-offset). |
| `"count": 30` to get thirty blocks | `count` is blobs. Overlapping spheres are merged and pruned, and cells matching no rule are skipped, so the block total is always lower and is not proportional in any simple way. | Read the placed-cell count out of a run rather than predicting it. |
| A broad rule first and a narrow one second, expecting the narrow one to win somewhere | Rules are walked in order and the first match wins, so a rule that matches everything the next one does hides it — except through the exposure fall-through. | Put the narrowest rule first. |
| Two rules meaning "clay where I am buried, gravel where I am exposed" | `discard_chance_on_air_exposure` is a **feature-level** field, not a per-rule one. A cell that falls through meets the same gate again, at the same chance, with only the roll being new. | There is no way to spell that in two rules. See [a second rule](#second-rule). |
| `"discard_chance_on_air_exposure": 1.0` with a fallback rule behind it | At `1.0` every exposed cell is discarded unconditionally, in the second rule exactly as in the first. The fallback rescues nothing. | Use a value below `1.0` if you want the fall-through to happen at all. |

## How it runs

Given an origin, the feature runs these steps in this order:

1. **Pick a random angle** and derive the vein's two endpoints from it, offset `+8` on X and Z from the origin. See [the `+8` offset](#the-8-offset).
2. **Pick two independent Y bounds** at random, each near the origin's own Y.
3. **Fail if `replace_rules` is empty.** Note where in the order this check sits: *after* the two steps above, not before them.
4. **For each of `count` spheres along the line between those endpoints**, place its centre by interpolation and then size its radius at random. The radius follows a sine curve along the vein's length, so spheres near the two ends are small and spheres near the middle are largest — a lens shape, not a uniform tube.
5. **Prune spheres fully enclosed by a later sphere.** Pure geometry, nothing random; the last sphere in the list is always kept.
6. **Walk every cell inside the surviving spheres' union.** For each occupied cell, walk `replace_rules` **in order**; the first rule whose `may_replace` matches the cell's current block, and whose [exposure gate](#discard-chance) does not reject it, writes that rule's `places_block`, and the walk moves on to the next cell.

Everything about *where* the vein is happens in steps 1 to 5, before a single cell is looked at. Nothing in step 6 can move a vein — the gate only decides which of its candidate cells get written.

## The `+8` offset {#the-8-offset}

::: note The vein's endpoints are offset `+8` on X and Z from the origin — it is not centred where you asked
This is a literal, preserved artifact of the classic vanilla ore-vein algorithm: the `+8.0` is part of the endpoint arithmetic. It cancels out of the endpoint-to-endpoint *direction*, but not out of the spheres' *absolute* centres. A `count: 9` vein placed at origin `(0, 32, 0)` centres around roughly `(8, 31, 8)`, not `(0, 32, 0)` — worth knowing before you conclude a vein is not showing up at the position you placed it at.
:::

If a vein has to land somewhere precise, the practical answer is to place the feature 8 blocks back on both axes, not to fight the offset. If it only has to land *somewhere* in a chunk — which is the usual case, since a [feature rule](./feature_rules.md) is scattering it across the chunk anyway — the offset costs you nothing and can be ignored.

## `discard_chance_on_air_exposure` {#discard-chance}

Rolled **per rule-match attempt** — once a cell's current block has already matched a rule's `may_replace`, not once globally for the whole vein — against whether that specific cell is exposed to air on any of its six faces:

| Value | Behaviour |
|---|---|
| `<= 0` (the default, `0`) | Always place. No roll, no exposure check. |
| between `0` and `1.0` | Roll once; only if the roll comes up **below** the configured chance is the exposure check consulted at all. Only an exposed cell that also came up below the chance is discarded. |
| `>= 1.0` | Always check exposure, and skip the roll — no value could make it fail. Every exposed cell is discarded unconditionally. |

The roll gates the *check*, not the other way round. That ordering is what makes a rules-heavy file behave the way it does, and it is why the gate cannot be used as a condition.

A rejected cell is not left alone: the walk falls through to the *next* matching rule at that same position, if one exists, rather than giving up on the cell.

## A second rule, and what the gate does to it {#second-rule}

The example above has one rule and lives in cave-free stone, so its gate never rejects anything — the fall-through is described and then never exercised. This file exercises both:

```json title="features/surface_clay_vein.json"
{
  "format_version": "1.21.110",
  "minecraft:ore_feature": {
    "description": { "identifier": "wiki:surface_clay_vein" },
    "count": 12,
    "discard_chance_on_air_exposure": 0.5,
    "replace_rules": [
      {
        "places_block": "minecraft:clay",
        "may_replace": ["minecraft:dirt", "minecraft:grass_block"]
      },
      {
        "places_block": "minecraft:gravel",
        "may_replace": ["minecraft:dirt", "minecraft:grass_block"]
      }
    ]
  }
}
```

Two rules with the **same** `may_replace` list. That looks redundant and is not: because the first rule matches everything the second one does, the second is reachable *only* through the fall-through — at a position the first rule matched and the exposure gate then rejected. Whatever gravel comes out of this file is a direct sighting of "the walk falls through to the next matching rule" actually happening.

Run against `plains` — not `underground_stone`; the whole point is a vein that reaches daylight — with feature seed `1`:

```
featurelab generate --pack <pack> --feature wiki:surface_clay_vein --env plains --seed 1
```

the origin resolves to `(0, 63, 0)` and the `+8` offset puts the vein's cells at world `x 6–9, y 61–63, z 7–8`. The plains column there is grass at `y 63` over dirt at `y 60–62`, so the vein's own top row is exactly the part of it that touches air, and the rows beneath it are sealed.

**Eleven** blocks are written: ten `minecraft:clay` and one `minecraft:gravel` at `(9, 63, 8)`. The ten clay cells all sit at `y 61–62`, buried on all six faces — the roll still happens there, and sometimes comes up below `0.5`, but the exposure check it gates then finds solid material in every direction and nothing is discarded. Exactly one of the vein's cells reaches the top row at `y 63`, and that one is the gravel: the first rule rolled below `0.5`, saw open sky, and discarded the cell; the walk moved on to the second rule, whose own fresh roll came up at or above `0.5`, and the gravel block is what that rescue looks like from outside. One cell is a thin sighting, but an unambiguous one — the first rule cannot produce a gravel block at all, so nothing else could have put it there.

Editing your own copy of this file to set `discard_chance_on_air_exposure` to `0` and re-running the same command is the check: the same eleven cells come back, every one of them clay.

::: warning A second rule is not an `else` branch
`discard_chance_on_air_exposure` is a *feature-level* field, so a cell that falls through meets the same gate again, at the same chance, with only the roll being new. There is no way to spell "clay where I am buried, gravel where I am exposed" in two rules: at `0.5` the second rule rescues an exposed cell only about half the time, and at `>= 1.0` it rescues nothing at all.
:::

## Replace rules match by block type, always {#replace-rules}

::: warning An empty or absent `may_replace` on a rule matches nothing
This is **not** the "no constraint, matches anything" shorthand `may_replace` has on a [single block feature](./single_block_feature.md#block-matching). The game runs the same list-membership test on a rule either way, so a rule with nothing in its list simply never fires. Always give `replace_rules[].may_replace` an explicit list for the block or blocks the vein is meant to cut through.
:::

The other difference from every other block list in the worldgen schema is quieter: **states written into a rule's `may_replace` are discarded**, and the comparison is on the block type alone. A bare `minecraft:dirt` and a `{"name": "minecraft:dirt", "states": {…}}` behave identically here. That is more forgiving than the single block feature's rule, not less — but it means a rule cannot be narrowed to one state, and writing states out to try is silently ineffective rather than an error.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [tables above](#fields) are the summary.

<!--@include: ../generated/fields/ore_feature.md-->

## What the bench does differently

One narrow gap in the vein's geometry, and one bench control that can change a result rather than just the view. The two silent failures at the top of [common mistakes](#common-mistakes) are not silent here: `featurelab check` reports an empty `replace_rules` as an error against the file and a missing one as a warning naming the feature, neither of which the game says before placement time.

**The geometry gap.** The sine and cosine that set the vein's axis and its radius curve are computed at full precision here, where the game reads them from a coarse lookup table — a difference of roughly one part in ten thousand in the angle, enough to move a boundary cell of a vein now and then. Several other feature types share that lookup, so it is being closed once, in one place, rather than separately here. Two larger gaps that used to be disclosed in this position are closed: the vein's geometry — the axis angle, both endpoints, every sphere centre, every radius, the enclosure test and the cell membership test — is computed in 32-bit throughout where this bench had used 64-bit floating point, in the game's own operation order and using its precomputed `1/count` reciprocal rather than a division per sphere — measured across **1,980** vein placements spanning eleven counts and sixty seeds, closing it moved not one cell — and a cell now belongs to a sphere when the cell's **centre** is inside it, where this bench had been testing the cell's corner and laying every vein half a block off in each axis. The examples and the image above were re-derived after that fix.

::: warning `--size` is a preview control, not an engine one, and shrinking it too far changes the result
The exposure check reads the block at each of a candidate cell's six neighbour positions. A neighbour position that falls *outside the previewed volume* reads back as non-solid — there is no real block there to report, so the query treats it as air, which the check cannot tell apart from a real air pocket. Face culling compounds the temptation to shrink: a face whose neighbour is outside the volume's own bounds is never drawn, slice or no slice, so a narrower preview is what brings the surrounding rock close enough to read as a wall in a screenshot.

Shrinking to `--size 20x48x20` — tried while producing the image above — spans world x `-10` to `9`, so this same seed's two `x = 9` cells, `(9, 31, 8)` and `(9, 32, 8)`, have a neighbour at `x = 10` that is off the edge of the preview. Both register as exposed, `discard_chance_on_air_exposure: 0.5` discards both, and **8** blocks are placed instead of 10. Setting the same file's `discard_chance_on_air_exposure` to `0` and re-running at `20x48x20` brings all 10 back, which is the check that the two missing cells are the gate reacting to the preview edge rather than the geometry changing.

An unbounded world has no such edge, so this is a limitation of the preview and not a claim about the game. `22x48x22` was chosen for the image specifically because it keeps the boundary one full cell away from every vein cell, and it reproduces the same 10 cells at the same positions as the unshrunk default volume.
:::

## Advanced: how the random values are spent {#random-draws}

You do not need this section to use an ore feature. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

Where the draws sit in a call, against [the steps above](#how-it-runs):

| Step | Draws | Notes |
|---|---|---|
| 1. the axis angle | 1 | Taken before anything else, including before the emptiness check in step 3. |
| 2. the two Y bounds | 2 | Two independent draws, each `origin.y + random(0..2) - 2`. |
| 3. the `replace_rules` emptiness check | 0 | But it happens *here*, after the three draws above. A vein with no rules still spends three values from the feature's stream and shifts whatever is placed after it in the same chain, rather than leaving the chain untouched. |
| 4. sizing the spheres | `count` | One per sphere, whatever the pruning in step 5 later removes. |
| 5. pruning | 0 | Pure geometry. |
| 6. the cell walk | one per rule **match attempt** | Only where `discard_chance_on_air_exposure` is strictly between `0` and `1.0`; at `0` there is no roll and at `>= 1.0` the roll is short-circuited. |

Worked against [the clay vein](#second-rule), whose eleven cells are all measured: **27** draws in all — one for the angle, two for the Y bounds, twelve to size its twelve spheres, and twelve gate rolls. Those twelve are eleven cells getting through the first rule, including the ten buried ones that were never near air, plus one more for the single cell that fell through to the second rule.

What the gate rolls cannot do is move the vein. The angle, both endpoints, every sphere centre and every radius are drawn in steps 1 to 4, before a single cell is looked at, so turning the gate on and off changes which of a vein's cells get written and never which cells were candidates in the first place — which is exactly what the two `discard_chance_on_air_exposure: 0` control runs above show.

## See also

- [Single block feature](./single_block_feature.md) — the simpler Content feature: one block per call, delegated to over and over, and with the *other* block-matching rule (bare name matches any state, written states narrow).
- [Scatter feature](./scatter_feature.md) — how a vein gets repeated across an area, and the distribution machinery a rule uses too.
- [Feature rules](./feature_rules.md) — how a vein reaches a world at all. `underground_pass` is the pass most ore rules belong in.
- [Geode features](./geode_feature.md) and [cave carver features](./cave_carver_feature.md) — two more self-contained leaves that write a whole ellipsoid-derived structure in one call with no delegation, contrasted here by shape and, for the carver, by direction: it removes material instead of adding it.
- [Molang in world generation](./molang.md) — `math.random` and `math.die_roll` draw from the same stream this page's angle, radius and exposure rolls do, for a feature higher up a delegation chain that also uses Molang.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — every key and default — and its placement are identical in both.

Both JSON examples are committed fixtures and were run end to end, and every count and coordinate on this page was read back out of `featurelab generate`'s result: the diamond vein's 10 cells at `(7–9, 30–32, 7–8)`, the clay vein's eleven cells with the single gravel at `(9, 63, 8)`, and the plains column beneath them. The image was rendered from the diamond vein's own result by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine against [the fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) with a fixed seed and a deterministic camera, and sliced for visibility as described above.

Four figures do not come from the commands printed beside them, and each is named as a control run where it is used: the `20x48x20` result of 8 cells, the same run's return to 10 cells with the gate at `0`, and the "same eleven cells, all clay" result — each from re-running the same file with `discard_chance_on_air_exposure` set to `0`, the edit each passage asks the reader to make for themselves. The draw counts in the Advanced section are arithmetic over those measured cell counts and the per-step costs beside them, not a separate measurement.
