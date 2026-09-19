---
title: Aggregate feature
description: minecraft:aggregate_feature runs a list of other features, in order, all at one position. Both keys in a table, the three early_out modes and when to reach for each, what the call reports when one entry fails, and what a mistyped name in the list actually does — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:aggregate_feature
category: proxy
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Aggregate feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:aggregate_feature` runs several features, one after another, at the same position.** It places nothing of its own: it holds a list of names, walks the list in order every call, and hands each entry the very same origin it was given. That makes it a **Proxy feature**, and the plainest one — "put all of these here" is the whole idea, and the only choice you have beyond the list is whether the walk is allowed to stop early.

Reach for it when one spot needs more than one thing: a boulder and the moss on it, a trunk and the litter around it, a pond and its reeds. You do **not** want it when each entry should start where the last one finished — that is a [sequence feature](./sequence_feature.md), which is this same list walk with the origin threaded through it — and you do not want it when exactly one of the entries should run, which is a [weighted random feature](./weighted_random_feature.md). And an aggregate reaches a world only through something that calls it: a [feature rule](./feature_rules.md), or another feature above it.

## Start here: a complete example

Three files, all complete. The aggregate names two features and gives both of them the same origin: a single block placed right at that origin, and a scatter that spreads fourteen more around it.

::: code-group

```json [features/aggregate_pumpkin_pair.json]
{
  "format_version": "1.21.110",
  "minecraft:aggregate_feature": {
    "description": { "identifier": "wiki:aggregate_pumpkin_pair" },
    "features": ["wiki:pumpkin_patch_block", "wiki:pumpkin_patch"]
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

- **Two entries, not one feature doing both jobs.** [`wiki:pumpkin_patch_block`](./single_block_feature.md#start-here-a-complete-example) puts one pumpkin exactly where the aggregate was asked to put something; [`wiki:pumpkin_patch`](./scatter_feature.md#start-here-a-complete-example) spreads fourteen rounds of the same block over a 16-block square around it. Keeping them separate is what lets the centre be guaranteed and the surround be random.
- **No `early_out`.** The key is absent, so the default `none` applies and both entries always run. See [the three modes](#early-out-modes).
- **They do not fight over the centre cell**, even though both were handed the identical origin. The scatter moves *itself*, through its own `distribution`; the aggregate did not move it. Two entries that do *not* offset themselves internally would genuinely contend — see [one origin, every entry](#one-origin).

![One pumpkin at the origin plus a scattered patch of pumpkins and jack o'lanterns around it, all delegated from a single aggregate_feature call at one shared origin, rendered by featurelab's voxel viewer](../../wiki/images/aggregate-feature-pumpkin-pair.png)

```
featurelab generate --pack <pack> --feature wiki:aggregate_pumpkin_pair --env plains --seed 9
```

Run against the `plains` preset with feature seed `9`, **8 blocks are written**: the first entry's own pick lands at the origin, world `(0, 63, 0)`, and the second entry's scatter attaches on **7 of its 14 rounds**, the other 7 refused by the delegate's own `may_attach_to` where the ground below is not grass. Five pumpkins and three jack o'lanterns, no two of them in the same cell, and the aggregate reports `(-5, 63, 3)` — the last round that succeeded — as its own result.

::: tip The scatter does not land where it lands on its own page
[Its own page](./scatter_feature.md#start-here-a-complete-example) runs `wiki:pumpkin_patch` alone at the same seed and gets 12 of 14. Nothing here is broken and nothing about the scatter changed: the first entry makes a random choice of its own *before* the scatter starts, so every position the scatter then picks is a different one. Putting a feature into an aggregate — or changing which feature goes first — moves everything the later entries place. That is worth knowing before you compare two screenshots and conclude a key stopped working. The [advanced section](#random-values) says exactly how much moves.
:::

## Fields

Two keys, and one of them is the list itself. "Default" is what the game uses when the key is absent. The long-form account of both, in the editor's own words, is the [field reference](#field-reference) further down; these tables are the short version.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `features` | yes | array of feature identifiers, **at least one** | — | The features to run, in order, every call. Each one is handed the aggregate's own origin, unmodified. An entry no loaded file defines is skipped rather than reported — see [a mistyped name](#unresolved-entries). An empty array does not load at all: see [the list itself](#features-list). |
| `early_out` | no | one of the three modes below | `none` | Whether the walk may stop before the end of the list. Nothing to do with [`conditional_list`](./conditional_list.md)'s `early_out_scheme`, which shares a word and nothing else. |

### The three `early_out` modes {#early-out-modes}

All three are tested **after every entry**, against [the running result](#running-result) — not against whether the entry that just ran succeeded.

| Mode | What it does | Reach for it when |
|---|---|---|
| `none` (the default) | Every entry runs, whatever each one does. | You want all of them. This is the usual answer, and the reason the key is usually absent. |
| `first_success` | Stop at the first entry that places something; the entries after it are never asked. | You want *one* of several alternatives, tried in a fixed order — "a boulder, or failing that a rock, or failing that a pebble". |
| `first_failure` | Stop as soon as nothing has succeeded yet — so it stops at an early failure but not at a late one. | You want a cheap test as entry one and the rest only if it passes. A [sequence feature](./sequence_feature.md) is always this mode, and its page is where that pattern is written out. |

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| Two entries that both place at their own origin, expecting both blocks | They were handed the same cell. The second one overwrites the first, and the aggregate reports one write where you expected two. | Give one of them an offset of its own — wrap it in a [scatter](./scatter_feature.md) with bare `x`/`z` — or use a type that spreads. |
| An aggregate, expecting entry two to start where entry one ended | It does not. Every entry gets the origin the aggregate itself was given. | [`minecraft:sequence_feature`](./sequence_feature.md), which is this type with the origin threaded through; [the figure there](./sequence_feature.md#origin-threading) shows the difference. |
| `"early_out": "first_failure"` expecting "stop as soon as any entry fails" | It tests whether *anything has succeeded yet*, not whether the last entry failed. After one success a later failure no longer stops it. | Put the entry that must succeed **first**. See [the running result](#running-result). |
| `"early_out": "condition_success"`, borrowed from `conditional_list` | Refused when the file loads: the value is not one of this key's three. The two keys are unrelated despite the shared word. | `none`, `first_success` or `first_failure`. |
| `"features": []` to switch an aggregate off | The file does not load at all — this is not "loads and places nothing". | Remove the feature from whatever calls it. |
| `"features": "wiki:one_thing"` | A bare string is not an array; the file does not load. | `["wiki:one_thing"]`. |
| A mistyped name in the list | Silently skipped. The rest of the list still runs and the aggregate still reports success, so the missing entry looks like a feature that "does nothing". | Run `featurelab check`, which reports the unresolved reference by name with a near-match suggestion. See [a mistyped name](#unresolved-entries). |
| Comparing two runs after adding an entry and calling the difference a bug | Every entry that runs changes what the entries after it produce. | Compare at a fixed list, or read [the advanced section](#random-values). |

## How it runs

Given an origin, the aggregate runs these steps:

1. **Take the next entry in `features`, in order,** and resolve the name. A name no loaded file defines is skipped here, and the walk carries on to step 4.
2. **Check that this aggregate is still allowed to place a feature inside another feature** — the [recursion guard](./feature_delegation.md). If it is not, the entry is refused, a failure is reported, and [the running result is cleared](#running-result).
3. **Run the entry at the aggregate's own origin** — the same position, unmodified, for every entry in the list. If it places something, its returned position becomes the running result.
4. **Test `early_out`** against the running result. Under `first_success`, stop if there is one; under `first_failure`, stop if there is not; under `none`, never stop. Otherwise go back to step 1.
5. **Report the running result** as the aggregate's own: the position of the last entry that succeeded, or nothing at all.

## One origin, every entry {#one-origin}

Every entry is handed the position the aggregate itself was given — the same one, unchanged, all the way down the list. Nothing about an aggregate moves anything.

The consequence people meet first is collision. Two entries that place *at* their origin are placing in the same cell, and the later one wins it; the earlier block is simply gone. Two entries that offset themselves — a [scatter](./scatter_feature.md) through its own `distribution`, an [ore feature](./ore_feature.md) through its own `+8` endpoint offset — do not collide, because *they* moved, not the aggregate. The example above is the second case, which is why its 8 blocks are 8 distinct cells.

The Molang scope goes down unchanged too: every entry reads and writes the same `variable.`/`temp.` slots, in list order, so an entry can leave a value for the next one to read. That is a property of delegation generally, not of this type — see [feature delegation](./feature_delegation.md).

If you wanted the second entry to start where the first one ended, that is the [sequence feature](./sequence_feature.md), and [its figure](./sequence_feature.md#origin-threading) is the two types side by side from one origin.

## The running result: what an aggregate reports {#running-result}

One value is carried through the whole walk, and it does three jobs: it is what the call reports at the end, it is what `early_out` tests after every entry, and — in a [sequence](./sequence_feature.md) — it is also the origin threaded into the next entry. It is worth knowing exactly how it moves, because two of the three `early_out` modes are meaningless without it:

- **An entry that succeeds overwrites it** with its own returned position.
- **An entry that runs and places nothing leaves it alone.** It is *sticky*: a failure in the middle of a list does not undo an earlier success, and does not make the aggregate report failure.
- **An entry that is refused outright clears it.** When the recursion guard denies an entry — the aggregate is already inside a chain that is not allowed to place another feature — the running result is emptied, not preserved. If that is the last thing to happen in the walk, the aggregate reports nothing at all, *despite* an earlier entry having placed something.

So "the aggregate failed" means "no entry succeeded, or the last thing that happened was a refusal", and not "some entry failed". The value that reaches the caller is the last *successful* entry's position — which for the example above is the scatter's final attaching round, not the single block that ran first.

## `early_out`: stopping before the end of the list {#early-out}

The key takes exactly three values — `"none"`, `"first_success"` and `"first_failure"` — and anything else is refused when the file loads.

The default is `"none"`, and most files want it: every entry runs and the aggregate reports the last one that placed anything.

`"first_success"` is the "try these in order until one works" list. It stops at the first entry that places something, and the entries after it are never asked — which also means they spend nothing and change nothing, so a `first_success` aggregate is a cheap way to express alternatives.

`first_failure` reads backwards from its name, and this is the one that catches people:

::: warning `first_failure` means "stop while nothing has succeeded yet", not "stop when an entry fails"
The test after every entry is simply *is the running result still empty*. Two consequences:

- **Before the first success it stops immediately.** If entry one places nothing, no later entry runs at all. That is what makes the guard-first pattern work: a cheap probe as the first entry turns the whole list into a conditional.
- **After a success it becomes hard to stop.** A later entry's own failure [leaves the running result alone](#running-result), so the walk carries on. The only thing that empties it again mid-walk is an entry being refused outright.

Every [sequence feature](./sequence_feature.md) is this mode and cannot be anything else, so [that page](./sequence_feature.md#where-the-list-stops) is where the probe-first pattern is written out with a worked file.
:::

## A mistyped name is skipped, not reported {#unresolved-entries}

An entry naming a feature no loaded file defines is **not** an error and does not stop the walk. The entry is skipped, the running result is left exactly as it was, and the next entry runs normally. A list of three whose middle name has a typo places two things and reports success.

This is worth stating because it is not the general rule. A [`conditional_list`](./conditional_list.md) *aborts* on an unresolved entry; an aggregate carries on. And it interacts with `early_out`: under `first_failure`, a skipped first entry leaves the running result empty, and the walk stops right there — so in a list that stops early, a typo is indistinguishable from a probe that failed.

`featurelab check` reports every unresolved reference by name, with a near-match suggestion, without running anything; that is the cheapest way to find one.

## `features` is a list of names, and it may not be empty {#features-list}

The entries are feature identifiers — `namespace:id` strings naming other feature files — and not feature bodies written inline. In the node editor they are the connections leaving the card rather than rows in its form.

::: warning `"features": []` is a load error, not an empty run
"At least one" is the schema's own rule, for this type, for [`sequence_feature`](./sequence_feature.md) and for [`weighted_random_feature`](./weighted_random_feature.md) alike: an array that is present must hold at least one entry. Writing the key as `[]` fails validation with a content-log line of the form *Array too small (0 < 1)* and the file does not load — it does not load and place nothing. The same holds one level in for `weighted_random_feature`'s entries, whose tuples must be exactly two elements long.
:::

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [tables above](#fields) are the summary.

<!--@include: ../generated/fields/aggregate_feature.md-->

## What the bench does differently

Nothing specific to this type: featurelab implements `minecraft:aggregate_feature` in full, both keys included, and its coverage entry carries no exception. What the bench *adds* is visibility into a walk that the game gives you no way to watch:

- **`featurelab generate`'s `diagnostics` name the delegation chain** for every refusal underneath an aggregate, position by position, so "which entry placed nothing" is answerable without bisecting the list by hand.
- **`featurelab generate --profile` names an early stop**, giving the entry that ended the walk and how many entries were skipped after it. An unresolved entry is reported there too, by name.
- **`featurelab check` never runs a placement.** It reports an unresolved `features` entry and a malformed `early_out`, and nothing about which entries would have placed. That is `generate`'s job.

## Advanced: what an aggregate spends {#random-values}

You do not need this section to use an aggregate. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

**An aggregate takes no random value of its own — zero draws, in every mode, at every list length.** Resolving a name costs nothing, the recursion-guard check costs nothing, `early_out` costs nothing, and the running result is bookkeeping. Every value spent under an aggregate belongs to a delegate.

What the type *does* decide is position in the stream, and that is the whole of its effect on determinism:

- **The entries draw in list order**, each one continuing where the last left off — no entry gets a fresh stream. So reordering `features` moves everything every entry places, even though the list is otherwise the same.
- **An entry that is skipped or never reached spends nothing.** A `first_success` walk that stops at entry one leaves the stream exactly where entry one left it, and a mistyped name spends nothing at all — so fixing the typo moves every placement after it.
- **This is why the example above differs from the scatter's own page at the same seed.** `wiki:pumpkin_patch_block` spends one bounded draw on its weighted pick before the scatter starts; the scatter's own draws therefore begin one position further along and every offset it produces is a different one. 12 of 14 rounds attach when the scatter runs alone, 7 of 14 when it runs second in this aggregate.

## See also

- [Sequence feature](./sequence_feature.md) — the same list walk with one thing changed: each entry starts at the previous one's result. Its figure is the two types side by side from one origin, and its `early_out` is permanently `first_failure`.
- [Weighted random feature](./weighted_random_feature.md) — the Proxy feature that picks exactly **one** entry from a list, where these two walk the whole list every call.
- [Conditional list](./conditional_list.md) — a list walk gated per entry by Molang, with its own `early_out_scheme` that shares a word with `early_out` and nothing else.
- [Scatter feature](./scatter_feature.md) and [single block feature](./single_block_feature.md) — the two delegates this page's example reuses unchanged.
- [Feature delegation and composite features](./feature_delegation.md) — the recursion guard, and what any delegating feature does and does not hand the feature below it.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — both keys, the three `early_out` values and the default — and its behaviour are identical in both.

The walk order, the stickiness of the running result, the clearing of it on a refusal, and the meaning of each `early_out` mode are stated as facts about the game. The worked example was run end to end and its result read back out of `featurelab generate`: 8 blocks, the first entry's at world `(0, 63, 0)`, 7 of the scatter's 14 rounds attaching against 12 of 14 when the same scatter is run alone at the same seed, and `(-5, 63, 3)` reported as the call's own result. The image was rendered from that exact result by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine against [the fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) with a fixed seed and a deterministic camera, so re-running it reproduces the picture byte for byte.

Two behaviours were reproduced rather than read: that an unresolved entry is **skipped** while the rest of the list runs, and that the same unresolved entry in a `first_failure` walk ends the list instead — both run as two-entry fixtures against the same origin and seed, one aggregate and one sequence, and read back off the placed-block count and the `--profile` stop list. *Array too small (0 < 1)* is the game's own content-log wording for an empty `features`; featurelab refuses the same file with its own message rather than that one.
