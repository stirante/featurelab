---
title: Sequence feature
description: minecraft:sequence_feature runs a list of features in order, each one starting where the last one finished, and stops while nothing has succeeded yet. Its one key in a table, the origin threading side by side with aggregate_feature in one picture, and the probe-first pattern that turns a list into a conditional — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:sequence_feature
category: proxy
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Sequence feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:sequence_feature` runs several features in order, each one starting from where the last one finished.** It places nothing of its own. It is the same list walk an [aggregate feature](./aggregate_feature.md) does, with one thing changed and one thing fixed: each entry after a success is handed the position the previous successful entry *returned*, and the walk always stops while nothing has succeeded yet. That makes it a **Proxy feature**, and the one to reach for when a chain has to *move*.

Reach for it when the second thing belongs wherever the first thing ended up rather than where the call started: find the floor, then decorate the floor; snap to a wall, then grow from the wall. And reach for it when you want a cheap test to gate an expensive list — a probe as the first entry stops everything after it. You do **not** want it when every entry should stay at the one origin: that is the [aggregate feature](./aggregate_feature.md), which is also where this page's shared machinery is written out.

## Start here: a complete example

Four files, all complete. The sequence is asked to run at an origin floating in open air. Its first entry scans down to the real floor and places a pumpkin there; its second entry — the same scatter as everywhere else on this site — then runs at *that floor position*, not at the floating one the whole call started from.

::: code-group

```json [features/sequence_snap_then_scatter.json]
{
  "format_version": "1.21.110",
  "minecraft:sequence_feature": {
    "description": { "identifier": "wiki:sequence_snap_then_scatter" },
    "features": ["wiki:snap_pumpkin_to_floor", "wiki:pumpkin_patch"]
  }
}
```

```json [features/snap_pumpkin_to_floor.json]
{
  "format_version": "1.21.110",
  "minecraft:snap_to_surface_feature": {
    "description": { "identifier": "wiki:snap_pumpkin_to_floor" },
    "feature_to_snap": "wiki:pumpkin_patch_block",
    "surface": "floor",
    "vertical_search_range": 12
  }
}
```

```json [features/pumpkin_patch.json]
{
  "format_version": "1.21.110",
  "minecraft:scatter_feature": {
    "description": { "identifier": "wiki:pumpkin_patch" },
    "places_feature": "wiki:pumpkin_patch_block",
    "distribution": {
      "iterations": 14,
      "x": { "distribution": "uniform", "extent": [-8, 8] },
      "y": 0,
      "z": { "distribution": "uniform", "extent": [-8, 8] }
    }
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

- **The order.** [`wiki:snap_pumpkin_to_floor`](./snap_to_surface_feature.md) is first because it is the entry that *moves*: it returns the floor it found, not the origin it was handed. Put it second and it would have nothing to give the entries after it.
- **A delegate that reports a useful position.** A snap-to-surface returns wherever its scan landed, and a scatter returns its last attaching round — both worth threading. A feature that just returns the origin it was given threads nothing, and the sequence behaves like an aggregate for that step.
- **No `early_out` key**, because this type does not have one. The walk always stops while nothing has succeeded yet: see [where the list stops](#where-the-list-stops).

![A pumpkin at a snapped floor position, surrounded by a scatter patch centered on that same snapped position rather than the original floating origin, rendered by featurelab's voxel viewer](../../wiki/images/sequence-feature-snap-then-scatter.png)

```
featurelab generate --pack <pack> --feature wiki:sequence_snap_then_scatter --env plains --seed 1 --origin 0,71,0
```

Run against the `plains` preset with feature seed `1` from origin `(0, 71, 0)` — floating 8 blocks above the surface — **7 blocks are written, every one of them at world Y 63**. The first entry scans down and places its pumpkin at `(0, 63, 0)`; the patch around it is centred on that same `(0, 63, 0)`, the floor the scan actually found, and not on the `(0, 71, 0)` the call was asked to start from. Six of the scatter's 14 rounds attach, five pumpkins and two jack o'lanterns in all, and the sequence reports `(5, 63, 1)` — its last successful entry's own result — as its own.

::: tip Swap one word in that file and the patch moves 8 blocks up
Change `minecraft:sequence_feature` to `minecraft:aggregate_feature` and nothing else, and the scatter runs at the original `(0, 71, 0)` — in open air, where its delegate's `may_attach_to` finds no grass and places nothing at all. The picture below is that experiment run properly, with a delegate that places wherever it is put so the comparison is about *position* rather than about success.
:::

## Fields

One key. "Default" is what the game uses when the key is absent — there is nothing optional here to default. The long-form account, in the editor's own words, is the [field reference](#field-reference) further down.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `features` | yes | array of feature identifiers, **at least one** | — | The features to run, in order. The first runs at the sequence's own origin; each one after a success runs at [the position the previous successful entry returned](#origin-threading). An empty array does not load at all, and the shorthand of a bare string instead of an array does not exist — see [the aggregate page's note](./aggregate_feature.md#features-list), which is the same schema rule. |

There is deliberately no `early_out` row: **this type has no such key.** Its schema accepts `features` and nothing else, so none of the three values an [aggregate](./aggregate_feature.md#early-out-modes)'s `early_out` takes — `"none"`, `"first_success"`, `"first_failure"` — is available here. The behaviour the key would select is fixed at the last of the three: see [where the list stops](#where-the-list-stops).

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `"early_out": "none"` on a sequence, to make the whole list run | The key is not in this type's schema. It is not applied, the walk still stops while nothing has succeeded yet, and the entries after a failed first one still do not run. | [`minecraft:aggregate_feature`](./aggregate_feature.md), which does have the key, if you want every entry to run regardless. |
| A sequence, expecting every entry to run | The list stops at the first entry that places nothing — as long as nothing has succeeded yet. One silent failure at the top costs you the entire list. | Put the entry most likely to succeed first, or use an [aggregate](./aggregate_feature.md). |
| A sequence, expecting it to stop at *any* failure | After something has succeeded, a later failure does not stop it: [the running result is sticky](./aggregate_feature.md#running-result). | There is no mode that does this. Order the list so the entry that must succeed is first. |
| A mistyped name as the first entry | The entry is skipped, nothing has succeeded, and the walk ends there. The whole sequence places nothing and reports nothing — it looks exactly like a probe that failed. | `featurelab check` reports the unresolved reference by name with a near-match suggestion. |
| Entry one is a plain [single block feature](./single_block_feature.md), and you expected entry two to move | A single block returns the origin it was handed, so there is nothing to thread and entry two runs where entry one did. | Thread from a feature whose result actually differs from its input: a [snap to surface](./snap_to_surface_feature.md), a [search](./search_feature.md), a [scatter](./scatter_feature.md). |
| A sequence around two features that both place at their origin, expecting two blocks in two places | The second one is handed the first one's *returned* position, which for a single block is the cell it just filled. It overwrites it. | Offset the second entry itself, or reach for an [aggregate](./aggregate_feature.md) and offset one of them. |
| `"features": []` to switch a sequence off | The file does not load at all. | Remove the feature from whatever calls it. |

## How it runs

Given an origin, the sequence runs these steps:

1. **Take the next entry in `features`, in order,** and resolve the name. A name no loaded file defines is skipped here, and the walk carries on to step 4.
2. **Check that this sequence is still allowed to place a feature inside another feature** — the [recursion guard](./feature_delegation.md). If it is not, the entry is refused and [the running result is cleared](./aggregate_feature.md#running-result), which also resets the threaded origin.
3. **Run the entry** — the first one, and every one while nothing has succeeded yet, at the sequence's own origin; every one after a success at the position the previous successful entry returned. If it places something, its returned position becomes the running result.
4. **Stop if nothing has succeeded yet.** Otherwise go back to step 1.
5. **Report the running result** as the sequence's own: the position of the last entry that succeeded, or nothing at all.

Only the origin is replaced in the threaded step; everything else an entry receives — the Molang scope above all — is passed on exactly as an [aggregate](./aggregate_feature.md#one-origin) passes it.

## Each entry starts where the last one finished {#origin-threading}

This is the whole of the difference between the two composite types, and it is spatial, so here it is as a picture rather than as a paragraph. Both panels are the same JSON but for the type id: the same two entries in the same order, the same `plains` preset, the same feature seed `42`, the same floating origin `(0, 71, 0)`, the same volume and the same camera.

![Two panels from one origin: on the left an aggregate_feature, whose second entry scatters markers in mid-air at the original floating origin while the first entry's pumpkin sits alone on the ground below; on the right a sequence_feature, whose identical marker cloud sits on the ground around that same pumpkin](../../wiki/images/aggregate-sequence-feature-origin.png)

Each panel places the same **11** cells. One of them is the pumpkin at `(0, 63, 0)`: entry one snaps to the floor and lands there in *both* panels, because entry one is handed the call's own origin either way. The other 10 are the second entry's markers, at identical x and z in both panels — the same rounds, the same offsets — and at two different heights:

| | Where entry two ran | Where its markers landed |
|---|---|---|
| `aggregate_feature` | the call's own origin, `(0, 71, 0)` | world Y **71**, floating in open air 8 blocks above the ground |
| `sequence_feature` | `(0, 63, 0)`, the position entry one returned | world Y **63**, on the ground, around the pumpkin |

The 8-block gap is the whole figure. Nothing else in the two files differs.

The second entry here is a scatter of markers rather than the pumpkin patch the example above uses, and deliberately: its delegate attaches to nothing and places wherever it is put, so the aggregate panel shows the markers *somewhere else* rather than showing nothing. With the pumpkin patch in that slot, the aggregate's second entry would place nothing at all — its delegate needs grass below it and there is none at Y 71 — which is the real behaviour a pack meets, and is why "my second feature stopped working when I changed the type" is usually this. The fixtures behind the figure are committed with the others as `aggseq_panel_aggregate.json`, `aggseq_panel_sequence.json` and `aggseq_panel_scatter.json` under [`docs/wiki/tools/fixtures/features/`](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures/features).

Which entries are worth threading from is a question about the *delegate*, not about the sequence: what a feature returns is part of that type's own contract. A [snap to surface](./snap_to_surface_feature.md) returns wherever its scan landed. A [search](./search_feature.md) returns the position it committed to. A [scatter](./scatter_feature.md) returns its last attaching round, which is somewhere in its spread rather than at its centre. A [single block](./single_block_feature.md) returns the origin it was handed, so threading from one changes nothing.

## Where the list stops {#where-the-list-stops}

A sequence is permanently in the mode an aggregate spells `"early_out": "first_failure"`, and it has no key to change it. After every entry, the walk asks one question — [*has anything succeeded yet*](./aggregate_feature.md#running-result) — and stops if the answer is no. Read the two halves separately, because they behave quite differently:

**Before the first success, the list is fragile.** If entry one places nothing, entry two is never asked. This is the type's most useful property rather than a hazard, and it is how you write a conditional without a condition: make the first entry a cheap probe — a [single block feature](./single_block_feature.md) whose `may_replace` or `may_attach_to` describes the ground you are willing to build on — and everything after it runs only where that probe could place. A probe that fails ends the call.

**After the first success, the list is hard to stop.** A later entry that places nothing leaves the running result alone, so the walk carries on to the end. The only thing that empties it again mid-walk is an entry being refused outright by the recursion guard — and that also resets the threading to the original origin and, if it is the last thing to happen, makes the whole call report nothing despite the earlier success.

::: warning An unresolved first entry ends the sequence, silently
A name no loaded file defines is skipped rather than reported — the same as in an [aggregate](./aggregate_feature.md#unresolved-entries) — but here the consequence is different. Skipping leaves nothing succeeded, so the walk stops at once and the sequence places nothing at all, at every seed, in every biome. A typo at the top of the list is indistinguishable in the world from a probe that refused.

`featurelab check` reports it by name without running anything, and `featurelab generate --profile` names both the unresolved entry and the stop it caused, with the count of entries skipped after it.
:::

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [table above](#fields) is the summary.

<!--@include: ../generated/fields/sequence_feature.md-->

## What the bench does differently

Nothing specific to this type: featurelab implements `minecraft:sequence_feature` in full, and its coverage entry carries no exception. The bench's additions are the same ones an [aggregate](./aggregate_feature.md#what-the-bench-does-differently) gets, and they matter more here, because a sequence that stops early leaves nothing in the world to look at:

- **`featurelab generate --profile` names the entry that ended the walk** and how many entries were skipped after it, in the sequence's own profile row. That is the difference between "my sequence does nothing" and "entry one placed nothing, so the other three were never asked".
- **`featurelab generate`'s `diagnostics` name the delegation chain** for every refusal underneath the sequence, position by position.
- **`featurelab check` never runs a placement**, so it will tell you that an entry is unresolved and nothing about whether the first entry would have succeeded.

## Advanced: what a sequence spends {#random-values}

You do not need this section to use a sequence. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into, and [the aggregate page's own advanced section](./aggregate_feature.md#random-values) covers what the two types share; this is the part that is only true here.

**A sequence takes no random value of its own — zero draws.** Threading an origin is arithmetic, and the stop test reads a value it already has. Every draw spent under a sequence belongs to a delegate.

Two consequences are specific to this type:

- **A stopped list stops spending.** When the walk ends because nothing has succeeded yet, every entry after it is skipped, and none of them takes a value. So whether a probe succeeds decides not only what this sequence places but where the *next* feature's draws land — a sibling of this sequence, further down the caller's own list, is placed differently depending on whether a probe three levels down passed. This is the one type where a placement failure has a larger effect on the rest of the world than a placement success.
- **Threading changes positions, not draws.** The entries after a success are given a different origin, not a different stream position: they take exactly the values they would have taken at the original origin, and the offsets those values encode are simply measured from somewhere else. An aggregate and a sequence over the same list at the same seed therefore spend the same values in the same order, as long as the same entries succeed in both — which is why the figure's two panels place their markers at identical x and z and differ only in Y.

## See also

- [Aggregate feature](./aggregate_feature.md) — the same list walk with every entry at one origin, and the page that carries what the two types share: the running result, the three `early_out` modes, and the rules on the `features` array itself.
- [Snap to surface](./snap_to_surface_feature.md) and [search](./search_feature.md) — the two delegate types whose returned position is worth threading, and the reason a sequence exists at all.
- [Scatter feature](./scatter_feature.md) and [single block feature](./single_block_feature.md) — the other two delegates in this page's example, and the second of them is what returns its own input unchanged.
- [Weighted random feature](./weighted_random_feature.md) — the Proxy feature that picks exactly one entry from a list instead of walking it.
- [Feature delegation and composite features](./feature_delegation.md) — the recursion guard that can refuse an entry mid-walk, and what a delegating feature does and does not hand down.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — one key, no `early_out`, no default to state — and its behaviour are identical in both.

The threading rule, the fallback to the original origin while nothing has succeeded, the permanent stop condition and the absence of an `early_out` key are stated as facts about the game. The worked example was run end to end and its result read back out of `featurelab generate`: 7 blocks, all at world Y 63, the first at `(0, 63, 0)` from a call that began at `(0, 71, 0)`, 6 of the scatter's 14 rounds attaching, and `(5, 63, 1)` reported as the call's own result. Both images were rendered from exactly those results by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine against [the fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) with a fixed seed and a deterministic camera, so re-running either reproduces it byte for byte.

The figure was read against the runs behind it rather than described from the JSON: 11 changed cells per panel, the shared pumpkin at `(0, 63, 0)` in both, and the 10 markers at identical x and z at world Y 71 on one side and world Y 63 on the other. The pipeline additionally refuses a figure whose panels come out nearly identical; this pair differs over 7.7% of its panel area. That the sequence ends at an unresolved or failing first entry while an aggregate over the same two entries carries on was reproduced as a pair of two-entry fixtures at one origin and one seed, read back off the placed-block count and the `--profile` stop list, and that a `early_out` written on a sequence changes nothing was reproduced the same way.
