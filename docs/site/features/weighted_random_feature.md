---
title: Weighted random feature
description: minecraft:weighted_random_feature picks exactly one feature from a weighted list and places it at its own origin. Its one key in a table, why fractional weights come to nothing, why a zero weight is unreachable, and what a lopsided split really buys you — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:weighted_random_feature
category: proxy
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Weighted random feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:weighted_random_feature` picks exactly one feature out of a list and places it, at its own origin, unmoved.** You reach for it when a spot should hold *one of several things*: an oak or a birch, a common flower or a rare one, a plain boulder or the version with moss on it. It places nothing itself and it moves nothing, which makes it a **Proxy feature** — the list of candidates and their weights is the whole of its JSON.

It is the wrong type when you want *all* of them: that is an [aggregate feature](./aggregate_feature.md), which walks its whole list. It is also the wrong type when the choice should depend on *where* you are rather than on luck — a [conditional list](./conditional_list.md) gates each candidate on a Molang condition instead. And it never retries: the entry it picks is the only one it tries, so a pick that fails to place leaves nothing behind rather than falling through to the next candidate.

## Start here: a complete example

Two files, complete. The wrapper lists two candidates at equal weight; the second is a plain one-block feature that places a gold block, so whichever way the pick goes the result is unmistakable. The first candidate, `wiki:pumpkin_patch_block`, is [the single block feature's own example](./single_block_feature.md#start-here-a-complete-example), reused unchanged:

::: code-group

```json [features/weighted_pick_feature.json]
{
  "format_version": "1.21.110",
  "minecraft:weighted_random_feature": {
    "description": { "identifier": "wiki:weighted_pick_feature" },
    "features": [
      ["wiki:pumpkin_patch_block", 1],
      ["wiki:weighted_pick_alt", 1]
    ]
  }
}
```

```json [features/weighted_pick_alt.json]
{
  "format_version": "1.21.110",
  "minecraft:single_block_feature": {
    "description": { "identifier": "wiki:weighted_pick_alt" },
    "enforce_placement_rules": false,
    "enforce_survivability_rules": false,
    "places_block": "minecraft:gold_block",
    "may_replace": ["minecraft:air"],
    "may_attach_to": { "bottom": "minecraft:grass_block" }
  }
}
```

:::

What each choice buys you:

- **Two entries at weight `1`** make the pick a fair coin flip. Weights are relative to their own total and to nothing else, so `1` and `1` say exactly what `50` and `50` would.
- **The tuple shape, `[featureReference, weight]`**, is what real packs write, and both elements are required — there is no "weight defaults to 1" in this spelling.
- **Nothing else.** There is no origin to set, no count, no condition. Everything a weighted random feature does is in that list.

![A single gold block sitting on a patch of grass, chosen by a weighted random pick between two single-block delegates, rendered by featurelab's voxel viewer](../../wiki/images/weighted-random-feature-pick.png)

```
featurelab generate --pack <pack> --feature wiki:weighted_pick_feature --env plains --seed 1
```

Run against the `plains` preset with feature seed `1`, the pick lands on `wiki:weighted_pick_alt` and a single `minecraft:gold_block` is written at `(0, 63, 0)`, on the grass. One block changed, and no trace anywhere of the pumpkin branch — the candidate that lost was never called.

::: tip Both halves of the result move with the seed
Seed `2` against this same file picks the other branch, `wiki:pumpkin_patch_block`, and *that* delegate's own 3:1 block pick then lands on its rarer candidate, so a `minecraft:jack_o_lantern` comes out. Seed `3` picks the same branch and gets the pumpkin instead — the commoner of that delegate's two outcomes. The second choice is a fresh 3-in-4 every time, not a consequence of the first, which is worth seeing once before you conclude a nested pick is stuck.
:::

## Fields

One key, and it is required. The long-form account is the [field reference](#field-reference) further down; this is the short version.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `features` | yes | array of `[featureReference, weight]` tuples, at least one | — | The candidates. Exactly one is placed per call, chosen by weight, at this feature's own unmodified origin. An explicitly empty array is refused when the file loads. |

### Inside a `features` entry

| Element | Required | Value | Default | What it does |
|---|---|---|---|---|
| `[0]` — the reference | yes | feature identifier string | — | A `namespace:id` some file in the pack defines. If the entry that wins names something unresolved, the call places nothing — there is no fallback to the runner-up. |
| `[1]` — the weight | yes | number, not negative | — | This entry's share of the total of every weight in the list. Use whole numbers: see [what a weight actually is](#weights). A negative weight is refused when the file loads. |

::: note An object-shaped entry is accepted, and is not known to work in the game
An entry written `{feature, weight}` — or `{places_feature, weight}`, either spelling of the reference — parses here, and `weight` may be omitted from it, defaulting to `1`. But the tuple is the shape vanilla and real packs use, and the object form has not been seen to load in the game. Treat it as plausible, not certain, and write the tuple.
:::

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `[["a", 0.5], ["b", 0.5]]`, expecting a 50/50 split | The weights are cut to whole numbers as they are added up, so the total comes to **0** and **nothing is picked at all** — the feature reports `Feature could not be selected` and places nothing. | `[["a", 1], ["b", 1]]`. Fractions below `1` are not a finer grain of control; they are zero. |
| `[["a", 1.6], ["b", 1.6]]`, expecting a total of `3.2` | The total is **2**, not `3.2` — and the split is the same one `1` and `1` would give. | Scale the numbers up until they are whole: `16` and `16`, or just `1` and `1`. |
| `[["rare_thing", 0], ["common_thing", 1]]` to switch a candidate off "but keep it in the file" | It is switched off — completely. A zero-weighted entry is **unreachable**: not at another seed, not at another origin, not as a last resort. | Nothing to fix if that is what you meant. If you wanted it rare, give it `1` against a large common weight. |
| `"features": []` | Refused when the file loads: `features must be a non-empty array`. The whole feature fails to build, so anything referring to it is unresolved too. | Remove the feature, or give it a candidate. |
| An entry whose reference is misspelt, expecting the other candidates to cover for it | They do not. The pick happens first and is final; if the winner does not resolve, the call reports `Feature could not be selected` and places nothing. At another seed the same file works, which is what makes this one hard to see. | Run `featurelab check` — it reports an unresolved reference without needing the right seed. |
| A weighted random feature used to place several things in one spot | It places one. Every other entry is simply never visited on that call. | Use an [aggregate feature](./aggregate_feature.md) for "all of them, in order". |
| Reading two identical previews as a broken pick | Two seeds landing on the same candidate is ordinary, especially on a lopsided list. | Change the seed a few times before concluding anything; the [Advanced section](#random-draws) says what the odds actually are. |

## How it runs

Given an origin, the feature runs these steps in this order, and stops at the first one that fails:

1. **Add up every entry's weight** and pick one entry against that total. If the total comes to zero — every weight is zero, or they are all fractions that round away — nothing is picked: the feature reports `Feature could not be selected` and the call ends here.
2. **Resolve the picked entry's reference.** Unresolved, the call ends the same way, with the same message. The other entries are not tried.
3. **Check that this feature is allowed to place an internal feature** — the [recursion guard](./feature_delegation.md#the-recursion-guard), which refuses while this same wrapper is already inside a delegation of its own. Refused, it logs `Cannot place internal feature` and the call ends.
4. **Place the chosen feature once**, at the original origin with nothing changed — the same Molang scope, the same everything — and return whatever it returns.

That is the whole type. One choice, one delegation, and no second attempt.

## What a weight actually is {#weights}

A weight is a share of the list's total, and the total is whatever the numbers add up to — there is no scale to hit, no "must sum to 100". `5` against `1` is five chances in six; `50` against `10` is the same thing.

The catch is that the adding up happens in **whole numbers, cut down after every entry**. That is the rule behind every surprise on this page:

- Two entries weighted `0.5` total `0`. Nothing is picked and nothing is placed.
- Two entries weighted `1.6` total `2` — not `3.2` — and behave exactly like `1` and `1`.
- An entry weighted `0` adds nothing to the total and can never win, so the rest of the list keeps precisely the odds it would have had if you had deleted that line.

Write whole numbers, and the ratio you wrote is the ratio you get, with no rounding anywhere.

## Unequal weights, and what they look like in practice {#unequal-weights}

The example above is a 1:1 list, which is the one case where the arithmetic has nothing to say. Give the same two candidates a lopsided split and it becomes visible:

```json title="features/weighted_pick_lopsided.json"
{
  "format_version": "1.21.110",
  "minecraft:weighted_random_feature": {
    "description": { "identifier": "wiki:weighted_pick_lopsided" },
    "features": [
      ["wiki:pumpkin_patch_block", 5],
      ["wiki:weighted_pick_alt", 1]
    ]
  }
}
```

Five chances in six against one in six. Run at feature seed `1`, the pick lands on the weight-5 candidate, and that delegate's own 3:1 block pick then draws its rarer candidate, so a `minecraft:jack_o_lantern` lands at `(0, 63, 0)`:

```
featurelab generate --pack <pack> --feature wiki:weighted_pick_lopsided --env plains --seed 1
```

Seed `1` is the same seed that picks the *other* branch — the gold block — in the 1:1 example above, and that is worth pausing on, because it is the commonest reason a weight edit looks like it broke something. Changing a weight does not merely move a boundary that an unchanged number falls on one side of; it changes the number itself. See [how the pick is made](#random-draws) for why.

Over feature seeds `1` through `12`, run one at a time, the 5:1 list picks the weight-5 candidate ten times and the weight-1 candidate twice (seeds `5` and `10`) — 10:2 against a 10:2 expectation, which at twelve runs is luck as much as arithmetic, but it is at least the right shape. The 1:1 list over those same twelve seeds splits 5:7, with the **first** candidate the rarer of the two. Both tallies are counts of real runs of the two commands, one seed at a time, not a probability calculation.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [tables above](#fields) are the summary. This type's one key is carried by the connections on the canvas rather than by a form, which is why the note below says the form is empty.

<!--@include: ../generated/fields/weighted_random_feature.md-->

## What the bench does differently

Nothing specific to this type: featurelab implements `minecraft:weighted_random_feature` in full, including the whole-number arithmetic that makes fractional weights collapse, and it reports the same `Feature could not be selected` for a list that totals zero and for a winner that does not resolve. One bench-wide behaviour is worth knowing when you read a preview of one:

- **`featurelab check` never runs a placement**, so it reports an unresolved candidate — with a near-match suggestion — against every entry in the list at once, which is more than any single run can tell you. What it cannot tell you is which candidate a given seed picks; that is in `featurelab generate`'s result, and in the preview panel.

## Advanced: how the pick is made {#random-draws}

You do not need this section to use a weighted random feature. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

**The cost is one bounded draw per call, whatever the list looks like.** The weights are summed once, one value is taken against that total, and the list is walked to find where it landed — so a two-entry list and a twenty-entry list cost the same, and a list that loses its winner to an unresolved reference has already spent that value by the time it finds out.

| Step | Cost | Which kind |
|---|---|---|
| Summing the weights | 0 | Integer arithmetic: `total = (int)(float)(total + weight)`, one truncation per entry. |
| The pick itself | **1**, unless `total == 0` | One bounded integer draw, `nextInt(total)`, in `[0, total)`. Under `total == 0` the draw is skipped entirely and the pick returns "nothing", which is the [no-draw catalogue](./rng_and_determinism.md#the-no-draw-catalogue)'s row for this type. |
| Resolving the winner, the recursion guard, the delegation | 0 | Everything after the pick is lookup and control flow. |
| The delegate's own work | the delegate's | It continues the same stream the pick took its value from. |

**How the walk turns a value into a candidate.** For the 5:1 list above the accumulate runs `0 -> 5 -> 6`, so the draw is `nextInt(6)`, an integer in `[0, 6)`. The walk then subtracts each weight in turn and takes the first entry that drives the running value **below zero**: `d - 5 < 0` for `d` in `0..4`, so the first candidate owns five of the six possible values, and only `d = 5` survives to the second candidate, where `5 - 5 = 0` is not yet negative and `0 - 1 = -1` is. Five chances in six, one in six, with no rounding anywhere, because both weights are already integers.

That subtraction is also why a zero weight is unreachable rather than merely unlikely: `remaining - 0` is never negative on its own, so a zero-weighted entry can never be the first to cross below zero — it does not even get the "only if everything before it is skipped" chance it looks like it has.

And it is why the two example lists disagree at seed `1`. **The bound of the draw is the total**, so a 1:1 list takes `nextInt(2)` and a 5:1 list takes `nextInt(6)` — two different calls into the same stream, returning two unrelated integers. Changing a weight changes the number that comes out, not just which band it falls in.

This is the same weighted pick a [single block feature](./single_block_feature.md#random-draws)'s `places_block` array uses, entry for entry, choosing between whole features instead of block descriptors.

The fixtures behind this page are committed under [`docs/wiki/tools/fixtures/features/`](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures/features): `weighted_pick_feature.json`, `weighted_pick_lopsided.json` and their `weighted_pick_alt.json` candidate, with `single_block_pumpkin.json`'s `wiki:pumpkin_patch_block` as the other.

## See also

- [Single block feature](./single_block_feature.md#random-draws) — the type whose `places_block` array uses this very same weighted pick, one level down, to choose a block instead of a feature. The two nest, and the example on this page shows them doing it.
- [Conditional list](./conditional_list.md) — the other "choose between delegates" Proxy type, gating each candidate on a Molang condition instead of on luck, and under its default placing *every* candidate that qualifies.
- [Aggregate](./aggregate_feature.md) and [sequence](./sequence_feature.md) features — the Proxy types that delegate to every listed feature in order, which is the contrast that usually settles which type you wanted.
- [Feature delegation and composite features](./feature_delegation.md) — what a wrapper hands its delegate and what it does not, and why the recursion guard is keyed on the wrapper.
- [RNG and determinism](./rng_and_determinism.md) — why a list that picks nothing still changes what comes after it.
- [Feature rules](./feature_rules.md) — how any of this reaches a world; a weighted random feature on its own is inert until something invokes it.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — its one key and both accepted entry shapes — and its behaviour are identical in both.

The pick, its order relative to resolution and the guard, and the whole-number arithmetic are stated as facts about the game. Every number on the page was read back out of `featurelab generate`: the worked example's single gold block at `(0, 63, 0)`, the lopsided list's jack o'lantern at the same position, and both twelve-seed tallies, which are counts of twenty-four real runs — one seed at a time — and far too small a sample to be a measurement of the probability. The image was rendered from the first of those results by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine against [the fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) with a fixed seed and a deterministic camera, so re-running it reproduces the picture byte for byte. The fractional, `1.6`, zero-weight and empty-array cases were each reproduced by running a file written for them: `0.5` and `0.5` place nothing and report `Feature could not be selected`; `1.6` and `1.6` place, behaving as `1` and `1`; a zero-weighted first entry never wins; and `"features": []` fails to build the file at all.

What is uncertain is named where it is relevant: the `[ref, weight]` tuple is the shape real packs use, while the object-shaped entry is accepted defensively here and is **not** known to be accepted by the game.
