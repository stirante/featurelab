# Scan Surface Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. This type's JSON surface — every key, enum value and default — and its behaviour
are unchanged between 1.26.40.26 and 1.26.50.24, so the page holds for both
versions. Worldgen internals move between releases; nothing here should be assumed to hold
for a different build without checking.

`minecraft:scan_surface` is a **Proxy feature** Microsoft's own official Bedrock Creator reference
classifies as an internal/deprecated component not meant for custom content — the same caveat as
[Conditional List Features](./conditional-list-feature.md). Real, published packs use it anyway,
and it works exactly like any other feature type in this version. It delegates to one
wrapped feature **once per column** across the entire 16×16 chunk containing the origin — every
column gets a real, side-effecting placement attempt, not a sample or a search.

::: note
**The id is `minecraft:scan_surface` — no `_feature` suffix.** There is no alias:
`"scan_surface_feature"` is not a JSON type id and will never work as a component key.
:::

## What it does

1. Resolve the wrapped feature (`places_feature`). Unresolved, or the standard recursion guard
   (keyed on this wrapper) denying it, fails the whole call with no delegation at all.
2. Compute the 16×16 chunk containing the origin's own `(x, z)` — `floor(originX / 16) * 16` and
   `floor(originZ / 16) * 16` through `+15` on each axis, ordinary chunk-local math.
3. Walk **every** column in that chunk, outer loop `x` ascending, inner loop `z` ascending, no
   skipping and no early exit. For each column: read its height (this project's `GetHeight`
   stand-in for the game's own "surface" concept — see [Surface Relative Threshold
   Features](./surface-relative-threshold-feature.md)'s own caveat on that same substitution),
   build a placement context at `(x, height, z)`, and delegate the wrapped feature there under the
   recursion guard. The Molang scope is the **same** shared object forwarded into every one of the
   256 column calls, not forked per column.
4. Remember the **last** column's successful result — overwritten, not accumulated, exactly like
   [Conditional List Features'](./conditional-list-feature.md) own "last success wins" return
   value. Return that, or `null` if every column failed.

No RNG is drawn directly by this feature type itself — all 256 columns' worth of draws belong to
whatever the wrapped feature does at each one.

## Example

```json title="scan_surface -- one placement attempt per column across the whole chunk"
{
  "format_version": "1.21.110",
  "minecraft:scan_surface": {
    "description": { "identifier": "wiki:scan_surface_pumpkins" },
    "places_feature": "wiki:pumpkin_patch_block"
  }
}
```

`places_feature` names [the same single_block_feature from the first page in this
set](./single-block-feature.md#example) — a weighted pumpkin/jack o'lantern pick attached to
grass below. Run against `plains` with feature seed `1` and the default origin, this attempts all
256 columns of the chunk `(0..15, 0..15)`; plains' unbroken grass means every single one succeeds
— `256` blocks changed. The last column visited, `(15, *, 15)`, is the position the result reports as this call's
own return value, matching the fixed `x` ascending / `z` ascending walk order above:

![A full 16x16 chunk of the plains terrain edge-to-edge covered in pumpkins and jack o'lanterns following the rolling terrain height, with ghosted terrain around it for context, rendered by featurelab's voxel viewer](./images/scan-surface-feature-pumpkins.png)

```
featurelab generate --pack <pack> --feature wiki:scan_surface_pumpkins --env plains --seed 1
```

Contrast this with [the Scatter Features page's own pumpkin
patch](./scatter-feature.md#example): 14 *randomly offset* attempts, 12 succeeding with visible
gaps between them, versus this feature's 256 *exhaustive, column-by-column* attempts filling the
chunk edge-to-edge. Neither type is "better" — they're built for different jobs (a naturally
sparse patch vs. a genuinely wall-to-wall cover).

## Field reference

| Field | Required | Shape | Default |
|---|---|---|---|
| `places_feature` | yes | feature identifier string | — |

::: warning
**`places_feature` is a best-effort field name, not a certain one.** The placement only needs a
single wrapped-feature reference, and the exact JSON key for it is not known with certainty.
`places_feature` was chosen to match [Scatter Features'](./scatter-feature.md) own field of the
identical purpose, for consistency across this doc set. `feature` and `feature_to_scan` are
accepted defensively as plausible aliases. The exhaustive-per-column walk algorithm above, by
contrast, is not in question.
:::

## See also

- [Conditional List Features](./conditional-list-feature.md) — the other feature type on this doc
  set carrying the same "Microsoft calls this internal/deprecated, real packs use it anyway"
  caveat, and sharing the same "last success wins, not first or accumulated" return-value rule.
- [Scatter Features](./scatter-feature.md) — the random, gap-leaving alternative to this type's
  exhaustive column coverage, directly contrasted above.
- [Surface Relative Threshold Features](./surface-relative-threshold-feature.md) — documents this
  same project's `GetHeight` substitution for whatever "surface" concept the game actually uses, which this page's own per-column height read relies on identically.

## Version and verification notes

Everything above is a statement about 1.26.50.24 specifically, and holds
for 1.26.40.26 too: the type's JSON surface and its placement are unchanged between the two
versions.

`features/scan_surface.go`'s own header comment carries the details. The one thing on this
page that is **not** certain is the `places_feature` field name, flagged in its own
warning above; nothing else on the page depends on it.

The JSON example was run end to end against this project's own worldgen tooling (`featurelab
check` and `featurelab generate`) and produced the described result — the `blocksChanged` count
and the last-column return position — which is also how a reader can re-run it. The accompanying image was
rendered from that exact result by this doc set's own image pipeline (see
[`docs/wiki/tools/`](./tools/generate-images.mjs)).
