---
title: Conditional list
description: minecraft:conditional_list walks a list of features in order and places the ones whose Molang condition holds. Every key in a table, the three early_out_scheme values side by side, the six variables a condition can read, and what changed when 1.26.50 made the type public — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:conditional_list
category: proxy
game: 1.26.50.24
scope: game
---

# Conditional list

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:conditional_list` walks a list of features in order and places the ones whose condition holds.** You reach for it when *where you are* should decide what goes down: sand above a height, ice below one, one decoration in the open and another under an overhang. Each entry pairs a feature with a Molang condition, and `early_out_scheme` decides how far the walk goes — by default all the way, so **every** entry that qualifies places. It places nothing itself and moves nothing, which makes it a **Proxy feature**.

It is the wrong type when the choice should be luck rather than circumstance: that is a [weighted random feature](./weighted_random_feature.md), which picks exactly one candidate by weight. And you do not need it to place several things unconditionally — an [aggregate feature](./aggregate_feature.md) does that with no conditions to write.

::: note The id is `minecraft:conditional_list` — no `_feature` suffix
There is exactly one id for this type, and there is no `minecraft:conditional_list_feature` to fall back on if you type the suffix out of habit. Confusingly, the game's own placement-failure log messages are stamped with the suffixed name — but that name does not resolve as an id, and a file that uses it does not load.
:::

## Start here: a complete example

One file, complete. Two entries at the same origin: a gold block gated on a condition that is false where this runs, and a pumpkin patch gated on the constant `1`, which is always true.

```json title="features/conditional_list_example.json"
{
  "format_version": "1.21.110",
  "minecraft:conditional_list": {
    "description": { "identifier": "wiki:conditional_list_example" },
    "conditional_features": [
      { "places_feature": "wiki:weighted_pick_alt", "condition": "variable.worldx > 100" },
      { "places_feature": "wiki:pumpkin_patch", "condition": 1 }
    ]
  }
}
```

What each choice buys you:

- **`"condition": "variable.worldx > 100"`** is the point of the type: a Molang string, evaluated against the position this feature was handed. `wiki:weighted_pick_alt` is the plain `single_block_feature` placing `minecraft:gold_block` from [the weighted random page](./weighted_random_feature.md#start-here-a-complete-example).
- **`"condition": 1`** is a constant, not an expression — a plain number or boolean in the JSON is taken as already evaluated. It is the ordinary way to write "always". `wiki:pumpkin_patch` is the 14-iteration [scatter feature](./scatter_feature.md#start-here-a-complete-example), unchanged.
- **No `early_out_scheme`**, so the default applies and the walk never stops early. Here that is invisible, because only one entry qualifies — but with two true conditions it is the whole behaviour of the file. See [what ends the walk](#early-out).

![A scattered patch of pumpkins and jack o'lanterns on rolling grass, with no gold block anywhere in the shot -- the first conditional_list entry's Molang condition was false and it was skipped, rendered by featurelab's voxel viewer](../../wiki/images/conditional-list-feature-scattered-pumpkins.png)

```
featurelab generate --pack <pack> --feature wiki:conditional_list_example --env plains --seed 9
```

Run against the `plains` preset with feature seed `9` and the default origin — auto-resolved to `(0, 63, 0)`, so `variable.worldx` is `0` — the first entry's condition is false, `0 > 100` does not hold, and it is skipped entirely: no gold block anywhere in the result. The second entry's condition is true, the scatter runs, and 12 of its 14 iterations find a legal cell. Twelve blocks changed.

::: tip Two more files show the parts the flagship hides
Flip the first entry's condition to the constant `1` — `wiki:conditional_list_both_true` in the committed fixtures — and the default shows itself: **both entries place**. Eight blocks changed: the gold block from entry one, plus a 7-of-14 pumpkin scatter from entry two. The scatter's split differs from the flagship's 12 because the gold placement ran first and moved everything the scatter went on to roll.

To watch a selector scheme stop early instead, `wiki:conditional_list_early_out` sets `"early_out_scheme": "placement_success"` and puts a deliberately blocked one-block feature first — its `may_replace` allows only `minecraft:stone`, and the origin holds air. The first entry's condition passes, its placement fails, the walk carries on, the pumpkin scatter runs, and having found its first success the list ends there: seven blocks changed, and no gold.

```
featurelab generate --pack <pack> --feature wiki:conditional_list_both_true --env plains --seed 9
featurelab generate --pack <pack> --feature wiki:conditional_list_early_out --env plains --seed 9
```
:::

## Fields

Two keys on the feature body, one of which opens a list of entries. "Default" is what the game uses when the key is absent. The long-form account is the [field reference](#field-reference) further down; these tables are the short version.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `conditional_features` | yes | array of entry objects — [below](#inside-a-conditional_features-entry) | — | The entries, walked in the order they are written. Each one that qualifies delegates at this feature's own unmodified origin. |
| `early_out_scheme` | no | one of three values — [below](#the-three-early_out_scheme-values) | **`"none"`** — the walk never stops early | Where the walk stops. This is the switch between "an aggregate" and "a selector", and its default changed in this version. See [what ends the walk](#early-out). |

### Inside a `conditional_features` entry {#inside-a-conditional_features-entry}

Written out in full these are `conditional_features[].places_feature` and `conditional_features[].condition`, which is how a diagnostic will name them.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `places_feature` | yes | feature identifier string | — | The feature this entry places. **An unresolved reference ends the whole list**, not just this entry — the entries after it are never looked at. |
| `condition` | no | number, boolean, or Molang string | **`1.0`** — always places | What decides whether this entry runs. Anything other than exactly zero counts as true. A plain number or boolean is a constant, not an expression. See [what a condition can read](#condition-scope). |

### The three `early_out_scheme` values {#the-three-early_out_scheme-values}

| Value | What it does | Reach for it when |
|---|---|---|
| `"none"` (the default) | **Never stops early.** Every entry whose condition is true places, in order. The feature's own result is the last placement that succeeded. | You want a set of independent rules — "sand here, ice there, moss everywhere" — each judged on its own. |
| `"condition_success"` | Stops at the **first entry whose condition is true**, and returns that entry's result as it stands, placed or not. A true condition over a feature that then fails ends the list with nothing placed. | You want a strict priority list where the *condition* is the whole decision: the first match wins and nothing below it is considered. |
| `"placement_success"` | Keeps walking past entries that failed to place: every true-condition entry is attempted until one **actually places**, and that result returns. | You want a fallback chain — "try the big version, and if it will not fit, the small one". |

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| A list of two always-true entries, expecting the first to win | Both place, at the same origin, in order. The default `early_out_scheme` is `none`, which never stops. | `"early_out_scheme": "condition_success"` if you meant a selector. This is the change from 1.26.40.26 that catches most packs — see [what changed](#what-changed). |
| `"minecraft:conditional_list_feature"` as the root key | The file does not load: there is no such type id, whatever the game's log messages are stamped with. | `"minecraft:conditional_list"`. |
| A typo in one entry's `places_feature`, expecting the other entries to carry on | The whole list ends at that entry with `Feature not found!`. Entries below it never run — so one typo silently removes several features' worth of output. | `featurelab check` reports an unresolved reference, with a near-match suggestion, without needing the right seed or origin. |
| `"early_out": "first_success"`, borrowed from an aggregate feature | Not a key of this type; it is dropped, and the list runs under the default `none`. The two enums share the word `none` and nothing else. | `"early_out_scheme"`, with one of `condition_success` / `placement_success` / `none`. |
| `"condition": "variable.worldy > 60"` on a list that is delegated to by a scatter, expecting the scatter's current position | `variable.worldy` is whatever the chain last wrote into it, which for a scatter is its most recently resolved axis. | Read `variable.originy` for *this* feature's own origin — see [what a condition can read](#condition-scope). |
| `"condition": 0` to disable an entry temporarily | It works, but it is easy to leave behind and hard to spot in a long list; nothing reports it. | Remove the entry, or comment the file, so the next reader is not hunting for it. |
| Expecting a false condition to cost something | A skipped entry places nothing and reports nothing — it is not an error and not a warning. | Nothing to fix; check the condition itself against the origin with `featurelab generate`, whose result carries the scope the conditions were evaluated against. |

## How it runs

Given an origin, the feature runs these steps in this order:

1. **Publish the origin's own `(x, y, z)` into the shared Molang scope**, as six variables — `variable.worldx` / `worldy` / `worldz` and `variable.originx` / `originy` / `originz`. All six hold the same three numbers. They are visible to this call's own conditions and to every feature placed from here on down the chain.
2. **Walk `conditional_features` in order.** For each entry:
   - **Resolve `places_feature`.** Unresolved, the game reports `Feature not found!` and the whole list ends here.
   - **Check that this feature is allowed to place an internal feature** — the [recursion guard](./feature_delegation.md#the-recursion-guard). Refused, it reports `Cannot place an internal feature!` and the whole list ends here too.
   - **Evaluate `condition`.** Exactly zero means skip to the next entry; anything else means run.
   - **Delegate, at the origin, unmodified** — and then `early_out_scheme` decides whether the walk continues.
3. **Return a result.** Under `none` it is the last placement that succeeded, or nothing if no entry placed. Under the other two schemes it is whatever the entry that ended the walk returned, or nothing if the walk ran off the end.

Both ways of ending the list early — an unresolved reference and a refused guard — keep whatever earlier entries already placed. The blocks stay; only the rest of the walk is lost.

## What ends the walk, and why the default is the one to check {#early-out}

`early_out_scheme` is the field that decides whether this type behaves like a selector or like an aggregate, and it is optional, so most files never write it — which means most files get `none`, and `none` places everything that qualifies.

::: warning The default runs every match
A conditional list with two always-true entries delegates to **both**, in order, at one shared origin. If you want the "pick the first that qualifies" behaviour — which is what this type did by default in 1.26.40.26 — you have to spell `"early_out_scheme": "condition_success"` out. A pack written against the older version and left alone will place more than it used to.
:::

The two selector schemes differ only in what counts as "done":

- **`condition_success` judges on the condition.** The first true condition ends the list. Whether that entry actually placed anything is not consulted, so a true condition over a feature that fails leaves the list empty-handed and the rest of the list unvisited.
- **`placement_success` judges on the placement.** A true condition whose feature fails falls through to the next entry. That is the difference, and it is usually the one people want out of a fallback chain.

::: note This enum is not the aggregate feature's
[Aggregate](./aggregate_feature.md) and [sequence](./sequence_feature.md) features have an `early_out` — `none` / `first_success` / `first_failure` — which is a different key with different values on a different type. The two share the word `none` and nothing else, and writing one where the other belongs gets you the other type's default.
:::

## What a condition can read {#condition-scope}

A `condition` is evaluated in the `world_gen` Molang namespace, like every other worldgen expression, against the scope the whole delegation chain shares. The six variables this type publishes before the walk are the useful ones:

| Variable | Holds |
|---|---|
| `variable.originx`, `variable.originy`, `variable.originz` | This feature's own origin, the position it was handed. |
| `variable.worldx`, `variable.worldy`, `variable.worldz` | The same three numbers — *when this feature writes them*. |

The two triples are the same at the moment they are written, and they stop being the same as soon as something below writes over one of them. A [scatter feature](./scatter_feature.md#molang-variables) fills `variable.worldx`/`worldy`/`worldz` in one axis at a time as it resolves each coordinate, so a condition further down a chain that reads `world*` may be reading a scatter's working value rather than any origin at all. **Read `origin*` when you mean "where this feature is".**

Because the scope is one object shared by reference, anything a condition — or any feature above this one — writes with `variable.` stays written for everything below. That is what makes "set a flag up here, test it down there" work at all; see [the shared Molang scope](./feature_delegation.md#the-molang-scope).

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [tables above](#fields) are the summary. The two entry keys come first because the editor carries them on the connections rather than in a form.

<!--@include: ../generated/fields/conditional_list.md-->

## What changed in 1.26.50 {#what-changed}

1.26.50.24 is the version that made this type public — Mojang's changelog for it lists `minecraft:conditional_list` as added, where earlier versions carried it as an internal component — and it changed the type in three ways a pack written against 1.26.40.26 will feel:

| Change | 1.26.40.26 | 1.26.50.24 |
|---|---|---|
| The default `early_out_scheme` | No `none` value existed; the default was `condition_success`, so the type was a pure selector and at most one entry ever placed. | `none` exists, and is the default. **Every** true-condition entry places. A pack that relied on the old implicit behaviour must now write `"early_out_scheme": "condition_success"`. |
| `condition` | Required on every entry. | Optional, defaulting to the constant `1.0` — an entry without one always places. |
| An unresolved `places_feature` | Skipped just that entry; the walk carried on. | Ends the whole list, with `Feature not found!`. |

The same version also added `variable.originx` / `originy` / `originz` alongside the existing `worldx` / `worldy` / `worldz`, holding the same values.

## What the bench does differently

Nothing specific to this type: featurelab implements `minecraft:conditional_list` in full, including the 1.26.50 semantics above and the two ways a walk ends early. Two bench-wide behaviours are worth knowing when you read a preview of one:

- **An unresolved Molang read stops the expression in the game; the bench reads it as `0` and carries on**, reporting every swallowed read by name. A condition that reads a slot nothing in the chain has written previews as false — which is what the game would have done too, but for a different reason, and the diagnostic is the only thing that tells the two apart. See [bench-wide approximations](../engine/coverage.md#bench-wide-approximations).
- **`featurelab check` never runs a placement**, so it reports an unresolved `places_feature` in any entry — with a near-match suggestion — but says nothing about which conditions were true. Skipped entries are in `featurelab generate`'s `diagnostics`, one per entry, and in the preview panel's Diagnostics section.

## Advanced: what this type spends, and what it moves {#random-draws}

You do not need this section to use a conditional list. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

**This type takes no random value of its own, at any step.** Publishing the six variables costs nothing, a condition's evaluation costs nothing unless the expression itself calls `math.random` or `math.die_roll`, and neither scheme's decision to stop is a roll. Every value spent under a conditional list is spent by a delegate.

| Step | Cost |
|---|---|
| Publishing the six `variable.` slots | 0 |
| Resolving an entry's `places_feature`, and the recursion guard | 0 |
| Evaluating `condition` | 0, unless the expression calls a Molang random itself — and that one is taken from the placing feature's own generator, in the order the expression is evaluated |
| Delegating to an entry | the delegate's own cost |
| Deciding whether to continue | 0 |

What it does do is **order** those costs, and under the default that matters more than it looks. All the entries share one stream, in the order they are written, so an earlier entry's delegate advances it for every entry after it. That is the whole explanation of the two fixtures above: `wiki:conditional_list_example` skips its first entry and its scatter places 12 of 14, while `wiki:conditional_list_both_true` — the same scatter, the same seed, the same origin — places only 7 of 14, because the gold block's own weighted pick took a value first.

| fixture | entry one | the scatter's result |
|---|---|---|
| `wiki:conditional_list_example` | skipped, condition false | 12 of 14 |
| `wiki:conditional_list_both_true` | placed a gold block | 7 of 14 |
| `wiki:conditional_list_early_out` | attempted, refused by `may_replace` | 7 of 14 |

The third row is the one worth reading twice: a *failed* placement is not free. `wiki:blocked_gold_block` places nothing — its `may_replace` allows only `minecraft:stone` and the origin holds air — yet its weighted pick happened before the check that turned it down, so the scatter after it lands exactly where it does in the both-true run. A refusal shifts what comes next just as a success does.

The fixtures behind this page are committed under [`docs/wiki/tools/fixtures/features/`](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures/features): `conditional_list_example.json`, `conditional_list_both_true.json` and `conditional_list_early_out.json`, with `weighted_pick_alt.json`, `blocked_gold_block.json` and the scatter's `scatter_pumpkin_patch.json` as their delegates.

## See also

- [Weighted random feature](./weighted_random_feature.md) — the other "choose between delegates" Proxy type: exactly one candidate, by weight rather than by condition, and never more than one.
- [Aggregate](./aggregate_feature.md) and [sequence](./sequence_feature.md) features — the Proxy types that walk their whole list unconditionally, and whose `early_out` vocabulary is a different enum from this type's `early_out_scheme`.
- [Molang in world generation](./molang.md) — the namespace, precedence and evaluation rules a `condition` follows, and the lifetime of everything it can read.
- [Feature delegation and composite features](./feature_delegation.md) — the shared origin, the shared scope and the recursion guard, which are three quarters of this page's behaviour.
- [Scatter feature](./scatter_feature.md) — the delegate in the example, and the type most likely to have overwritten `variable.world*` before a condition reads it.
- [RNG and determinism](./rng_and_determinism.md) — why an entry that places changes what the entries after it do.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24** specifically. This is the version that changed the type, so — unusually for these pages — nothing here should be read as also holding for **1.26.40.26**: the three differences are in [what changed](#what-changed), and a page or a pack written against the older version needs all three.

The walk, its order, the six variables and both ways a list ends early are stated as facts about the game, and Mojang's changelog for this version documents the `early_out_scheme` semantics this page describes. All three JSON examples were run end to end, and their results — 12, 8 and 7 blocks changed — were read back out of `featurelab generate`, as were the per-fixture scatter splits in the Advanced section and the Molang scope each run finished with. The image was rendered from the first of those results by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine against [the fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) with a fixed seed and a deterministic camera, so re-running it reproduces the picture byte for byte.
