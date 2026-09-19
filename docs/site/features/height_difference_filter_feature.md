---
title: Height difference filter
description: minecraft:height_difference_filter_feature looks at the ground around a position and only lets another feature place when the terrain nearby rises or falls the way you asked. Every key in a table, what the four constraint names do and do not mean, why zero blocks on flat ground is the right answer, and the two ways search_radius quietly accepts a value it cannot use — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:height_difference_filter_feature
category: proxy
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Height difference filter

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:height_difference_filter_feature` looks at the ground around a position and places another feature only where the terrain nearby rises or falls the way you asked.** You reach for it when something belongs to a *shape* of land rather than to a block or a biome: a boulder at the foot of a cliff, a shrine on a ledge, a waterfall head only where the ground drops away. It places nothing itself, which makes it a **Proxy feature** — it decides, and hands the position to `places_feature` unchanged.

It is the wrong type when what you care about is *depth below the surface* rather than *variation in it*: that is a [surface relative threshold feature](./surface_relative_threshold_feature.md), which compares one position against the surface directly above it. And it is the wrong type when you want to *move* to the terrain rather than be judged by it — a [snap-to-surface feature](./snap_to_surface_feature.md) walks to the ground; this one never moves anything.

Two things need saying before anything else. On flat ground a filter that asks for a rise places **nothing**, and that is the feature working, not a bug. And `search_radius` is the key everything else depends on: it is required, it accepts values it cannot use, and it is where almost every silent failure of this type starts — see [`search_radius`](#search-radius).

## Start here: a complete example

Two files, both complete. The filter asks for ground at least 3 blocks higher than the origin somewhere within 4 blocks; the block feature it delegates to is the one from the [single block page](./single_block_feature.md), unchanged.

::: code-group

```json [features/height_diff_gate.json]
{
  "format_version": "1.21.110",
  "minecraft:height_difference_filter_feature": {
    "description": { "identifier": "wiki:height_diff_gate" },
    "places_feature": "wiki:pumpkin_patch_block",
    "search_radius": 4,
    "min_required_upward_height_diff": 3
  }
}
```

```json [features/pumpkin_patch_block.json]
{
  "format_version": "1.21.110",
  "minecraft:single_block_feature": {
    "description": { "identifier": "wiki:pumpkin_patch_block" },
    "enforce_placement_rules": false,
    "enforce_survivability_rules": false,
    "places_block": [
      { "block": "minecraft:pumpkin", "weight": 3 },
      { "block": "minecraft:jack_o_lantern", "weight": 1 }
    ],
    "may_replace": ["minecraft:air"],
    "may_attach_to": { "bottom": "minecraft:grass_block" }
  }
}
```

:::

What each choice buys you:

- **`search_radius: 4`** walks four steps north, four east, four south and four west and reads the ground height at each of those sixteen positions. Nothing diagonal, nothing in between, and never the origin's own column — see [`search_radius`](#search-radius).
- **`min_required_upward_height_diff: 3`** is satisfied by **one** of those sixteen being at least 3 blocks higher than the origin. It is a "somewhere nearby" test, not an "everywhere" one.
- **No `max_allowed_*` key is written at all**, and that matters: a constraint you leave out is satisfied automatically, so this file asks exactly one question and nothing else.
- **The delegate runs at this feature's own position**, untouched — the same `(x, y, z)` the filter was given. Nothing is offset, and `wiki:pumpkin_patch_block` still runs its own `may_attach_to.bottom` check there.

```
featurelab generate --pack <pack> --feature wiki:height_diff_gate --env plains --seed 1
```

Run against the `plains` preset with feature seed `1` and the default origin, this places **0 blocks** and reports one warning, `placement returned no result and wrote no blocks`. The plains surface is flat at this origin: every one of the sixteen sampled columns reads the same height the origin sits at, none of them reaches the `+3` the file asked for, and the gate refuses. That is the correct answer for this file on this terrain.

::: tip Zero blocks on flat ground is the feature working
This is the one type whose *successful* behaviour is most often mistaken for a broken pack. If you write a height filter, test it on flat terrain and see nothing placed, nothing is wrong — you asked for a slope and there is no slope. Give it ground that varies, or loosen the constraint. The tip below builds that ground so you can watch the same file's sibling pass.
:::

::: details Seeing the same gate pass: build the slope first
Every terrain preset the bench ships is essentially flat around the origin, so the only way to watch this gate say yes is to raise some ground before it runs. These three files do that — a stone column five blocks east, then the filter, run one after the other from the same position:

```json
{
  "format_version": "1.21.110",
  "minecraft:single_block_feature": {
    "description": { "identifier": "wiki:height_diff_ridge_block" },
    "enforce_placement_rules": false,
    "enforce_survivability_rules": false,
    "places_block": "minecraft:stone"
  }
}
```

```json
{
  "format_version": "1.21.110",
  "minecraft:scatter_feature": {
    "description": { "identifier": "wiki:height_diff_ridge" },
    "places_feature": "wiki:height_diff_ridge_block",
    "distribution": {
      "iterations": 3,
      "x": 5,
      "y": { "distribution": "fixed_grid", "extent": [0, 2], "step_size": 1, "grid_offset": 0 },
      "z": 0
    }
  }
}
```

```json
{
  "format_version": "1.21.110",
  "minecraft:aggregate_feature": {
    "description": { "identifier": "wiki:height_diff_demo" },
    "features": ["wiki:height_diff_ridge", "wiki:height_diff_gate_reaching"]
  }
}
```

`wiki:height_diff_gate_reaching` is the example file above with `search_radius` raised to `5`, because the column is five blocks away and a radius of 4 never reaches it. Run the aggregate on `plains` at seed `1` and **4 cells change**: the three stone blocks at `(5, 63, 0)`, `(5, 64, 0)` and `(5, 65, 0)`, and then the delegate's block at the origin, `(0, 63, 0)` — the column's top is now at height 66, which is `63 + 3`, exactly the rise the filter asked for. Swap `wiki:height_diff_gate` back in and only the three stone blocks change: the gate is 4 and the slope is 5 away.
:::

## Fields

Six keys, all on the feature body, and four of them are optional constraints that behave in two different ways. "Default" is what the game uses when the key is absent. The long-form account of every key, in the editor's own words, is the [field reference](#field-reference) further down; this table is the short version.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `places_feature` | **yes** | feature identifier | — | The feature placed when the gate passes, at this feature's own position, unchanged. A name nothing defines is reported and nothing is placed. |
| `search_radius` | **yes** | whole number | — | How many steps out to sample, along four directions only. A fraction is cut down, not rounded; a value below 1 samples nothing. See [`search_radius`](#search-radius). |
| `min_required_upward_height_diff` | no | whole number | not asked | Requires **at least one** sampled column to stand this far above the origin. See [the four constraints](#constraints). |
| `max_allowed_upward_height_diff` | no | whole number | not asked | Despite the name, requires **at least one** sampled column to sit this far *below* the origin. See [the four constraints](#constraints). |
| `min_required_downward_height_diff` | no | whole number | not asked | Despite the name, a **ceiling**: refuses the position as soon as any sampled column stands more than this far above the origin. |
| `max_allowed_downward_height_diff` | no | whole number | not asked | A floor: refuses the position as soon as any sampled column sits more than this far below the origin. |

### The four constraints, and which kind each one is {#constraints}

Two of them are *requirements* — one satisfying column anywhere in the scan is enough, and the scan keeps going either way. Two of them are *limits* — the first column that breaks one ends the whole scan and refuses the position. Every constraint you leave out is satisfied; a file with none of the four passes anywhere the radius is at least 1.

| Key | Kind | Passes when | Reach for it when |
|---|---|---|---|
| `min_required_upward_height_diff` | requirement | some sampled column is **at least** this far above the origin | Something belongs at the foot of a rise: a boulder under a cliff, debris at the base of a slope. |
| `max_allowed_upward_height_diff` | requirement | some sampled column is **at least** this far below the origin | Something belongs at the top of a drop: a waterfall head, a ledge marker, a lookout. Read its name as "the ground is allowed to be this much lower than me, and has to be somewhere". |
| `min_required_downward_height_diff` | limit | **every** sampled column is at most this far above the origin | You want open ground, not a hollow: nothing hemmed in by walls on any side. |
| `max_allowed_downward_height_diff` | limit | **every** sampled column is at most this far below the origin | You want solid footing: nothing perched on the lip of a chasm. |

::: warning Two of the four names say the opposite of what they do
`max_allowed_upward_height_diff` does not cap how far the ground may rise — it *requires* the ground to fall. `min_required_downward_height_diff` does not require the ground to fall — it *caps* how far it may rise. The two that read straight are `min_required_upward_height_diff` (requires a rise) and `max_allowed_downward_height_diff` (caps a fall). The table above is the one to trust; the names are not.
:::

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| A filter asking for a rise, tested on flat ground | **0 blocks, one warning about no result.** The gate is working; the terrain has no rise in it. | Test it on varied ground, or [build the slope first](#start-here-a-complete-example). |
| `"search_radius": 4.9`, expecting 5 | It is cut down to **4**, with no complaint of any kind. `4.9` and `4.0` are the same file. | Write the whole number you mean. |
| `"search_radius": -5` or `0` | Accepted in silence. Nothing is sampled: the gate then passes everywhere unless you asked for a rise or a fall, in which case it passes **nowhere**. | Write at least `1`. |
| `search_radius` left out | The file is refused with `search_radius is required` — it is the one optional-looking key that is not. | Write it. |
| `"max_allowed_upward_height_diff": 2` meaning "no more than 2 blocks of rise" | The opposite: it demands a **2-block drop** somewhere nearby, and refuses flat ground. | `"min_required_downward_height_diff": 2` is the cap on rising ground. |
| `"min_required_downward_height_diff": 2` meaning "at least a 2-block drop" | The opposite: it caps how far the ground may **rise** and says nothing about drops. | `"max_allowed_upward_height_diff": 2` is the required drop. |
| A constraint that must hold all the way round, written as `min_required_upward_height_diff` | One satisfying column passes it. Fifteen flat columns and one raised one is a pass. | Use a limit (`min_required_downward_height_diff` / `max_allowed_downward_height_diff`) for "everywhere" tests. |
| Expecting the origin's own column to be sampled | It never is. The scan starts one step out in each direction. A pillar standing *on* the origin is invisible to this gate. | Compare against neighbours only, or pick a different position. |
| Expecting diagonal or filled-area coverage | Four straight arms, nothing else. A rise sitting diagonally two blocks away is never seen, whatever the radius. | Raise the radius until an arm crosses it, or accept the cross shape. |
| `"search_radius": 1000` to "be safe" | Four thousand height reads for every single placement attempt, on every attempt the rule makes. | Keep it to the distance the terrain feature you are looking for actually spans. |
| Expecting a diagnostic when the gate refuses | There is none. A refused position is silent; the only warning you see is the generic "nothing was placed" one. | Test with the constraints removed one at a time to find which is refusing. |

## How it runs

1. **Resolve `places_feature`.** A name no loaded file defines reports `` `height_difference_filter_feature` could not find feature `places_feature`. `` and nothing is placed — this happens before the ground is ever looked at.
2. **Check the radius.** Below 1, nothing is sampled at all, and the answer is decided on the spot: it is *yes*, unless `min_required_upward_height_diff` or `max_allowed_upward_height_diff` was written, in which case it is *no*. The two limits are not consulted on this path.
3. **Walk the four arms** — north, then east, then south, then west — one step at a time out to the radius, reading the ground height at each step.
4. **Apply the limits as you go.** The first sampled column that stands higher than `min_required_downward_height_diff` allows, or lower than `max_allowed_downward_height_diff` allows, ends the scan there and refuses the position.
5. **Collect the requirements.** Each of the two requirement keys is remembered as satisfied the moment one column satisfies it; the scan carries on regardless, because the other one may still need a column.
6. **Decide.** Both requirements satisfied, and no limit broken, and the gate passes.
7. **Place `places_feature`** at the unchanged position. The delegate runs its own checks there and may still refuse. If the gate did not pass, nothing at all happens and nothing is reported.

## `search_radius`: the key that decides everything else {#search-radius}

It is **required** — a file without it does not load — and it is measured in steps along each arm, not in any kind of area. A radius of `r` reads exactly `4 × r` columns: `r` to the north, `r` to the east, `r` to the south, `r` to the west, starting one block out. The origin's own column is never among them, and neither is anything off the four axes.

Three things about the value itself, all of them silent:

- **A fraction is cut towards zero, never rounded.** `4.9` is `4`; `-0.5` is `0`. Nothing is reported, so a file that looks like it reaches five blocks reaches four.
- **Zero and negative values are accepted.** They are not clamped and they do not warn. What `search_radius < 1` *means* is "sample nothing", and that has two very different outcomes depending on what else the file says.
- **With nothing sampled, the answer is decided by which keys exist**, not by the terrain: the gate passes when neither `min_required_upward_height_diff` nor `max_allowed_upward_height_diff` is written, and can never pass when either of them is. The two limit keys are ignored entirely — a radius of `0` with only `max_allowed_downward_height_diff` written passes everywhere, however the ground actually falls away.

So a mistyped radius fails in whichever direction is hardest to notice. A filter that was meant to be selective and has a radius of `0` places its delegate at every position it is offered; a filter that asks for a rise and has a radius of `0` places nothing, anywhere, for ever, and says nothing about why.

The cost is linear in the radius and paid on every placement attempt, not once: four arms times the radius, for every position a rule offers. A radius in the hundreds is the difference between a pack that generates and one that stalls.

## What "the ground height" means here {#surface-height}

Each sample is the height of that column — the level the terrain surface has reached there — and it is read live, at the moment the gate runs. That has one consequence worth planning around: **anything already placed in that column counts.** A feature earlier in the same pass that raised or lowered the ground changes what this gate sees, which is exactly what makes the slope-building recipe in the example above work, and is also why the same filter can pass or refuse depending on the order features run in.

The columns read are the four arms only. This gate has no idea what the ground does diagonally, and no idea what it does at the position it is standing on.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [table above](#fields) is the summary.

<!--@include: ../generated/fields/height_difference_filter_feature.md-->

## What the bench does differently

This page documents the game. Three things belong to the **featurelab** bench used to illustrate it:

- **The ground height is the bench's own terrain reading**, taken from the finished volume rather than from the game's terrain-generation estimate. On the flat presets the bench ships the two agree; on real, varied terrain the value a live game would compare against is the same quantity but not necessarily the same number. The [surface relative threshold page](./surface_relative_threshold_feature.md#surface-height) documents the same substitution in more detail, and it applies here identically.
- **Every terrain preset is effectively flat where features are placed**, so a filter that asks for any variation at all refuses everywhere on the bench. That is a property of the bench's scenery, not of the type: the recipe in the example above exists because there is no hilly preset to point at.
- **The bench puts the delegation through its recursion guard; the game does not for this type.** Every other delegating type in the game guards against a feature reaching itself, and the bench applies the same guard here for consistent diagnostics and profiling. A pack that contrives a loop through a height filter would therefore be stopped here and, as far as is known, not there.

## Advanced: what this type costs the random stream {#random-draws}

You do not need this section to use a height difference filter. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

**This type never touches the random stream.** Not on the passing path, not on the refusing path, not on the unresolved-reference path. It is a pure decision followed by a delegation, so a position it refuses and a position it accepts leave the stream in exactly the same place — everything spent inside it belongs to `places_feature`.

The decision, written out, with `y` the origin's own height and `h` a sampled column's:

| Key | Test at each sample | Effect |
|---|---|---|
| `min_required_downward_height_diff` = `d` | `y + d < h` | refuse immediately |
| `max_allowed_downward_height_diff` = `D` | `y − D > h` | refuse immediately |
| `min_required_upward_height_diff` = `u` | `y + u <= h` | mark satisfied |
| `max_allowed_upward_height_diff` = `U` | `y − U >= h` | mark satisfied |

The two limits are tested before the two requirements at every step, and the arms are walked north, east, south, west, each from step 1 to the radius inclusive. Both requirement flags start satisfied when their key is absent; both limits are skipped when theirs is. The final answer is the two requirement flags together, and a scan that refuses on a limit never reaches it.

Because a refusal aborts mid-scan and an acceptance does not, the number of height reads differs between the two outcomes — but height reads are not random values, so nothing downstream can tell.

## See also

- [Surface relative threshold feature](./surface_relative_threshold_feature.md) — the other pure gate: depth below the surface rather than variation across it, and the page that documents the surface reading both types depend on.
- [Scan surface feature](./scan_surface.md) — the Proxy type that offers a delegate one position per column of a chunk; pair it with this one to decorate only the columns whose neighbourhood has the shape you want.
- [Single block feature](./single_block_feature.md) — the delegate this page's example reuses verbatim.
- [Feature delegation](./feature_delegation.md) — what a wrapper does and does not change about the position, the Molang scope and the random stream.
- [Feature rules](./feature_rules.md) — how any of this reaches a world: a feature file is inert until a rule attaches it to the chunks of the biomes it belongs in.
- [RNG and determinism](./rng_and_determinism.md) — the model the "costs nothing" claim above fits into.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and it holds for **1.26.40.26** too: this type was introduced at 1.26.40 and neither its keys, their required and optional split, nor its decision changed at 1.26.50.

The four constraint tests, the four-arm scan and its order, the "one column satisfies a requirement, one column breaks a limit" split, the below-1 radius branch and the fact that nothing is reported when the gate refuses are stated as facts about the game.

The worked example was run end to end from the committed fixture [`height_difference_filter_demo.json`](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/fixtures/features/height_difference_filter_demo.json) and its zero-block result and single warning read back out of `featurelab generate`. The slope recipe was run the same way and its four changed cells — `(5, 63, 0)`, `(5, 64, 0)`, `(5, 65, 0)` and `(0, 63, 0)` — read from the result before the paragraph describing them was written; its files are printed in full on this page rather than committed to the fixture pack.

`search_radius`'s two silent behaviours were measured rather than reasoned about, because the page previously claimed a bound the game does not enforce. A file with `"search_radius": -5` loads with no diagnostic at all and its gate passes; the same file with a rise required places nothing, also silently. A file with `"search_radius": 4.9` behaves in every respect like `4`: run against a slope exactly five blocks away it refuses, where `5` accepts. Both were checked against the same scene, one number apart.

What is uncertain is collected in [what the bench does differently](#what-the-bench-does-differently): the height value itself, the flatness of every bench preset, and the recursion guard the bench adds to a delegation the game leaves unguarded.
