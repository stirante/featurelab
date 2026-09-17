# Conditional List Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. Worldgen internals move between releases; nothing here should be assumed to hold
for a different version without checking. This type changed materially in this version — see the
[version notes](#version-and-verification-notes) if you wrote against 1.26.40.26.

`minecraft:conditional_list` places features based on a collection of conditions evaluated in
order. As of 1.26.50.24 it is an officially documented public feature type (Mojang's changelog
for this version lists it as added); earlier versions carried it as an internal component. It walks a
list of `{places_feature, condition}` entries in order, and `early_out_scheme` decides how far
the walk goes: the default `none` evaluates **every** entry — each one whose condition is true
places — while `condition_success` and `placement_success` turn it into a selector that stops at
the first qualifying entry. Where [Weighted Random Features](./weighted-random-feature.md) pick
one delegate by RNG, this type gates each delegate by condition.

::: note
**The id is `minecraft:conditional_list` — no `_feature` suffix.** There is exactly one id for
this type; there is no `minecraft:conditional_list_feature` alias to fall back
on if you type the suffix out of habit. (Confusingly, the game's placement-failure log messages
use the suffixed name — but that name does not resolve as an id.)
:::

## What it does

1. Push the origin's own `(x, y, z)` into the shared Molang scope twice over: as
   `variable.worldx` / `variable.worldy` / `variable.worldz` AND (new in this version) as
   `variable.originx` / `variable.originy` / `variable.originz` — the two triples carry the same
   values. All six are visible to this call's own condition expressions and to every feature
   placed from this point forward in the chain, since the Molang scope is shared, unchanged, by
   every feature in the chain.
2. Walk `conditional_features` **in order**. For each entry:
   - Resolve its `places_feature` reference. An unresolved reference logs `Feature not found!`
     and **ends the whole list** — entries after it are never evaluated. (This is a change: in
     1.26.40.26 an unresolved reference skipped just that entry.) Successes already recorded by
     the default `none` scheme survive the abort and are still returned.
   - If this wrapper is not allowed to place its target (the standard internal-feature guard),
     log `Cannot place an internal feature!` and end the whole list the same way.
   - Evaluate `condition` as Molang against the scope from step 1. A plain number or boolean in
     the JSON is treated as an already-evaluated constant (no RNG, no query touched) — the same
     rule every Molang-typed field on this doc set follows (see [Molang in World
     Generation](./molang-in-world-generation.md)). An **omitted** `condition` counts as the
     constant `1.0` — the entry always places.
   - If the condition is zero, skip to the next entry.
   - If the condition is nonzero, delegate to the resolved feature **at the origin, unmodified**
     — and now `early_out_scheme` decides what happens next (see below).
3. When the walk ends, the feature's own result depends on the scheme: under `none` it is the
   **last successful** placement (engaged if at least one entry placed, empty otherwise); under
   the other two schemes it is whatever the terminating entry returned, or empty if the walk fell
   off the end.

::: warning
**The default now runs every match.** With the default `none`, a conditional_list with two
always-true entries delegates to BOTH, in order, sharing one origin and one `Random` stream —
earlier entries' draws shift later entries' results. If you want the old "pick the first that
qualifies" behavior from 1.26.40.26 (where it was the default), you must now say
`"early_out_scheme": "condition_success"` explicitly.
:::

### `early_out_scheme`

Optional; decides when evaluation stops:

| `early_out_scheme` | Behavior |
|---|---|
| `"none"` (default) | **Never stops early.** Every entry whose condition is true places; the feature's own result is the last successful placement, engaged if at least one entry placed. |
| `"condition_success"` | Stop at the **first entry whose condition is true** — that entry's placement result is returned as-is, engaged or not. A failed placement still ends the list. |
| `"placement_success"` | Keep walking past failed placements: every true-condition entry gets attempted until one **actually places**, and that result returns. |

The default really is `none`.

## Example

```json title="conditional_list -- a Molang condition skipping one entry, letting the other run"
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

Two entries, same shared origin: `wiki:weighted_pick_alt` (a plain `single_block_feature` placing
`minecraft:gold_block`, reused from [the Weighted Random Features
page](./weighted-random-feature.md#example)) gated on `variable.worldx > 100`, and
`wiki:pumpkin_patch` (the 14-iteration `scatter_feature` from [the Scatter Features
page](./scatter-feature.md#example)) gated on the constant `1` — always true. Run against `plains`
with feature seed `9` and the default origin (auto-resolved to `(0, 63, 0)`, `worldx` is `0`), the
first entry's condition is false — `0 > 100` does not hold — so it's skipped entirely, no gold
block anywhere in the result; the second entry's condition is true, so the scatter runs,
succeeding on 12 of its 14 iterations this time:

![A scattered patch of pumpkins and jack o'lanterns on rolling grass, with no gold block anywhere in the shot -- the first conditional_list entry's Molang condition was false and it was skipped, rendered by featurelab's voxel viewer](./images/conditional-list-feature-scattered-pumpkins.png)

```
featurelab generate --pack <pack> --feature wiki:conditional_list_example --env plains --seed 9
```

::: tip
Flip the first entry's condition to the constant `1` (both entries now always-true,
`wiki:conditional_list_both_true` in the committed fixtures) and the new default shows itself:
**both entries place** — `8` blocks changed, the gold block from entry one plus a 7-of-14 pumpkin
scatter from entry two (a different split from the flagship's 12 because the gold placement's
weighted-pick draw consumed from the same shared `Random` stream first). To see a selector scheme
stop early instead, `wiki:conditional_list_early_out` sets
`"early_out_scheme": "placement_success"` and puts a deliberately blocked single_block first (its
`may_replace` only allows `minecraft:stone`, and the origin holds air): the first entry's
condition passes, its placement fails, the walk continues, and the pumpkin scatter runs — `7`
blocks changed, and having found its first success the list ends there:

```
featurelab generate --pack <pack> --feature wiki:conditional_list_both_true --env plains --seed 9
featurelab generate --pack <pack> --feature wiki:conditional_list_early_out --env plains --seed 9
```
:::

## Field reference

| Field | Required | Shape | Default |
|---|---|---|---|
| `conditional_features` | yes | array of `{places_feature, condition}` entries | — |
| `conditional_features[].places_feature` | yes | feature identifier string | — |
| `conditional_features[].condition` | no | number, boolean, or Molang string | `1.0` (always places) |
| `early_out_scheme` | no | `"none"` / `"condition_success"` / `"placement_success"` | `"none"` |

`condition`'s Molang is registered under the `world_gen` namespace, like every other
worldgen-evaluated expression.

## See also

- [Weighted Random Features](./weighted-random-feature.md) — picks exactly ONE delegate by a
  single `Random` draw; this type gates each delegate by condition instead.
- [Aggregate and Sequence Features](./aggregate-and-sequence-feature.md) — the other Proxy
  features that walk their whole list; note their `early_out` vocabulary (`none`/
  `first_success`/`first_failure`) is a different enum from this type's `early_out_scheme`
  (`none`/`condition_success`/`placement_success`) and the two are not interchangeable, even
  though both spell a value `none`.
- [Molang in World Generation](./molang-in-world-generation.md) — the namespace/precedence/
  evaluation rules `condition`'s Molang strings follow.

## Version and verification notes

Everything above is a statement about 1.26.50.24 specifically, and this
version changed the type in three user-visible ways versus 1.26.40.26, so a page (or a pack)
written against the older version needs updating:

1. **The default `early_out_scheme` changed.** 1.26.40.26 had no `none` value and defaulted to
   `condition_success` — the type was a pure selector, at most one entry ever placed. 1.26.50.24
   adds `none`, makes it the default, and under it every true-condition entry places. A pack that
   relied on the old implicit "stop at first true condition" must now spell
   `"early_out_scheme": "condition_success"` out.
2. **`condition` became optional** (it was required), defaulting to the constant `1.0` — an
   entry without a condition always places.
3. **An unresolved `places_feature` reference now aborts the whole list** (with a
   `Feature not found!` log) instead of skipping just that entry, and the placement scope gains
   `variable.originx`/`originy`/`originz` alongside the existing `worldx`/`worldy`/`worldz`
   (same values).

All three JSON examples on this page were run end to end against this project's own worldgen
tooling (`featurelab check` and `featurelab generate`, 1.26.50.24 target) and produced the
described results (12, 8 and 7 placed blocks); the accompanying image was rendered from the
flagship result by this doc set's own image
pipeline (see [`docs/wiki/tools/`](./tools/generate-images.mjs)). Mojang's changelog for this
version documents the `early_out_scheme` semantics, and this page agrees with it.
