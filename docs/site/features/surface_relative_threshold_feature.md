---
title: Surface relative threshold
description: minecraft:surface_relative_threshold_feature places another feature only where the position is deep enough below the surface. Both keys in a table, the strictly-below rule that costs one block, the coarse grid the surface is read on, the two failures that report the same thing, and the values the field accepts without complaint — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:surface_relative_threshold_feature
category: proxy
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Surface relative threshold

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:surface_relative_threshold_feature` places another feature only where the position it was given is deep enough below the surface.** You reach for it to keep something underground: an ore body that must not break out of a hillside, a dungeon decoration that has to stay buried, a cave dressing that should never appear in daylight. It places nothing itself and moves nothing, which makes it a **Proxy feature** — it says yes or no, and hands the position on untouched.

Where a [snap-to-surface feature](./snap_to_surface_feature.md) goes looking for the surface and moves its delegate to it, this one never moves anything: it measures where the position already is and gates on the answer. And where a [height difference filter](./height_difference_filter_feature.md) asks how the ground *varies* around a position, this one asks a single, simpler question about the ground directly above it.

Two things need saying before anything else. The test is **strictly** below, so a position exactly `minimum_distance_below_surface` blocks under the surface fails and needs one more block of depth — see [the depth test](#depth-test). And the surface is read on a coarse grid, one value for each 4×4 patch of columns, so moving a block or two sideways usually changes nothing.

## Start here: a complete example

Two files, both complete. The gate asks for more than 5 blocks of cover; the delegate is a bare single block that places unconditionally, so that the only thing being tested is the gate.

::: code-group

```json [features/surface_relative_threshold_deep.json]
{
  "format_version": "1.21.110",
  "minecraft:surface_relative_threshold_feature": {
    "description": { "identifier": "wiki:threshold_deep" },
    "feature_to_place": "wiki:threshold_marker",
    "minimum_distance_below_surface": 5
  }
}
```

```json [features/threshold_marker.json]
{
  "format_version": "1.21.110",
  "minecraft:single_block_feature": {
    "description": { "identifier": "wiki:threshold_marker" },
    "enforce_placement_rules": false,
    "enforce_survivability_rules": false,
    "places_block": "minecraft:gold_block"
  }
}
```

:::

What each choice buys you:

- **`feature_to_place`, and not `places_feature`.** This type is the one in its family that does not use the common spelling, and the near-misses are all refused — see [the two keys](#fields).
- **`minimum_distance_below_surface: 5`** means *more than* five blocks of cover, not five or more. At exactly five it refuses.
- **The delegate has no `may_replace` and no `may_attach_to`**, on purpose: it places wherever it is put. That way a run that places nothing is the gate's doing and nothing else's.
- **The delegate is given this feature's own position**, unchanged. Nothing is offset and nothing is searched for; the gold block lands exactly where the gate was asked about.

![A single gold block embedded in the corner of a solid gray stone cutaway block, rendered by featurelab's voxel viewer](../../wiki/images/surface-relative-threshold-feature-gold.png)

```
featurelab generate --pack <pack> --feature wiki:threshold_deep --env plains --seed 1 --origin 0,50,0
```

Run against the `plains` preset with feature seed `1` and the origin at `(0, 50, 0)`, the surface above that column reads `63`, so the deepest level the gate will refuse is `63 - 5` = `58`. The origin is at `50`, and `50 < 63 - 5` holds, so the gate passes and the gold block lands exactly at the origin. One cell changes.

::: tip The same file, two origins, and the block-by-block boundary
Raise the origin to `(0, 60, 0)` — only three blocks of cover — and `60 < 63 - 5` (`60 < 58`) does not hold, so the same file places nothing at all and reports one `"level":"warning"` diagnostic, `"Target location is not within the minimum distance to surface"`:

```
featurelab generate --pack <pack> --feature wiki:threshold_deep --env plains --seed 1 --origin 0,60,0
```

The interesting origin is `(0, 58, 0)`: exactly five blocks below the surface, exactly what the file asked for — and it **also** places nothing. `(0, 57, 0)` places the block. That one-block gap is the whole of [the depth test](#depth-test), and it is the single most common surprise on this page.
:::

## Fields

Two keys, both on the feature body, and that is the entire type. "Default" is what the game uses when the key is absent. The long-form account of every key, in the editor's own words, is the [field reference](#field-reference) further down.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `feature_to_place` | **yes** | feature identifier | — | The feature placed when the gate passes, at this feature's own position, unchanged. Not `places_feature` — see below. |
| `minimum_distance_below_surface` | no | whole number | `0` | How much cover the position must have. The test is *more than* this, so `0` still demands at least one block. Written as a fraction, it is cut down, not rounded. See [the depth test](#depth-test). |

### There are exactly two keys, and four near-misses that do not load {#near-misses}

The reference field is `feature_to_place`. `places_feature` — the name [scatter](./scatter_feature.md), [scan surface](./scan_surface.md) and [height difference filter](./height_difference_filter_feature.md) all use — is **not** an alias here, and neither are `feature`, `wrapped_feature` or `min_distance_below_surface`. A file using one of those names a field this type does not have, and does not load in the game.

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `"places_feature": "…"` out of habit | The file does not load: this type's reference field has a different name from every other gate's. | `"feature_to_place"`. |
| `"min_distance_below_surface": 5` | The same — a near-miss spelling, not an alias. | `"minimum_distance_below_surface"`. |
| Expecting a position exactly `n` blocks down to pass with `minimum_distance_below_surface: n` | It refuses. The test is strictly more than `n`. | Ask for `n − 1`, or aim one block deeper. |
| `"minimum_distance_below_surface": 0` expecting "anywhere" | Still refuses anything at or above the surface: `0` means at least one block of cover. | There is no value that places at the surface. Drop the gate instead. |
| `"minimum_distance_below_surface": 10.9` expecting 11 blocks of cover | Cut down to `10`, with no complaint of any kind. | Write the whole number you mean. |
| A **negative** `minimum_distance_below_surface` | Accepted in silence, and it inverts the gate: `−5` lets the delegate place up to five blocks *above* the surface. | Use `0` if you meant "as shallow as possible". |
| Moving the feature one or two blocks sideways to get past a refusal | Usually changes nothing: one surface value covers a 4×4 patch of columns. | Move at least four blocks, or move down. |
| Expecting the delegate to be told *why* it was skipped | Nothing at all is reported on the refusing path in the game. | Test the same origin with the gate removed. |
| A mistyped `feature_to_place` and a refusing gate in the same file | The refusal happens first, so the bad name is never reported on the runs where the gate says no — and where it says yes, the message blames the depth. | Check the spelling against the delegate's `description.identifier`. |
| Expecting the gate to look at the block above the origin | It does not read blocks at all. It compares heights, and the height it reads is the terrain surface, not the first solid cell above the position. | Use a [snap-to-surface feature](./snap_to_surface_feature.md) if you need an actual surface block. |

## How it runs

1. **Read the surface height** for the origin's 4×4 patch of columns. If there is no value for that patch, the feature fails with `"Surface level could not be found"` and nothing is placed.
2. **Compare.** The position must be **strictly below** `surface − minimum_distance_below_surface`. At or above it, the feature fails with `Target location is not within the minimum distance to surface` and nothing else happens — the delegate is not even looked up.
3. **Resolve `feature_to_place`.** A name no loaded file defines fails with the *same* message as step 2, which is worth knowing when reading a log. See [the two failures that read alike](#same-message).
4. **Check the recursion guard.** If this feature is already running somewhere up the chain, the call is refused silently — no message at all. The guard is on this wrapper, not on the delegate.
5. **Place `feature_to_place`** at the unchanged position, with the same Molang scope. The delegate runs its own checks there and may still refuse.

## The depth test, block by block {#depth-test}

The rule is one line: the position passes when it is **strictly** below `surface − minimum_distance_below_surface`. Everything surprising about this type follows from the word *strictly*.

With the surface at `63` and `minimum_distance_below_surface` at `5`:

| Position | Cover above it | Result |
|---|---|---|
| `y 59` and up | 4 blocks or less | refused |
| `y 58` | exactly 5 | **refused** — this is the one that surprises people |
| `y 57` | 6 | placed |
| `y 50` | 13 | placed |

So the field reads as "the depth this must *exceed*", not "the depth this must reach". If you want a position with exactly `n` blocks of cover to qualify, write `n − 1`.

The default, `0`, is the same rule with nothing subtracted: the position must be strictly below the surface, which is at least one block of cover. There is no value of this field that lets the delegate place at the surface itself.

Two things about the value:

- **A fraction is cut towards zero, never rounded**, and nothing is reported. `10.9` behaves exactly as `10` — a file that looks like it demands eleven blocks of cover demands ten.
- **A negative value is accepted in silence and inverts the gate.** `−5` makes the threshold `surface + 5`, so the delegate places anywhere up to five blocks *above* the ground. Nothing warns about this; it is a depth field that will happily express a height.

## What "the surface" means here, and how coarse it is {#surface-height}

The height this gate compares against is the game's own terrain surface estimate, and it is read on a **quarter-resolution grid**: the lookup is taken once per 4×4 patch of columns, not per column. Two consequences for authoring:

- **Small sideways moves usually change nothing.** Shifting a feature one, two or three blocks can leave it inside the same patch, reading the same surface value it read before. Crossing a patch boundary can change it abruptly.
- **Near a cliff or a steep bank the gate measures the patch, not the column.** A position tucked under an overhang may be judged against the high ground four blocks away, or the low ground, depending on which patch it falls in — and the answer does not change smoothly as you move.

The lookup can also come back with no value at all, which fails the feature with its own distinct message rather than the depth one.

## The two failures that read alike {#same-message}

`Target location is not within the minimum distance to surface` is reported for **two** different problems: a position that is not deep enough, and a `feature_to_place` that names nothing the pack defines. The message says the first even when the cause is the second.

They are still distinguishable, because the order is fixed: the depth is tested first, so the reference is only ever looked up on runs where the depth passed. If a feature reports that message at *every* origin you try, including ones you know are deep enough, check the delegate's name. If it reports it only as you move upwards, it means what it says.

The third failure path — the recursion guard refusing a feature that is already running — reports nothing whatsoever. A chain that goes quiet with no diagnostic anywhere is a candidate for that.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [table above](#fields) is the summary.

<!--@include: ../generated/fields/surface_relative_threshold_feature.md-->

## What the bench does differently

This page documents the game. Three things belong to the **featurelab** bench used to illustrate it:

- **The surface *value* is the bench's substitution; the coarse grid is the game's.** The game reads a height estimate computed before a chunk's blocks are written. A bench has no such estimate, so it reads its own finished terrain instead — sampled at the same 4×4 patch anchor, so the one-value-per-patch behaviour is faithful even though the number's provenance is not. On a flat preset the two coincide. Whether they diverge mid-generation on real terrain is not known here.
- **The four near-miss field names are refused with an error that names the real key.** An earlier revision of this bench accepted them; it no longer does, because a file using one would not load in the game and quietly working would hide that. The game simply does not load such a file, without the helpful message.
- **A negative or fractional `minimum_distance_below_surface` is accepted here exactly as described above, with no diagnostic.** That is a faithful reproduction of the game's own silence, not a bench convenience — but it does mean neither tool will tell you about it.

## Advanced: what this type costs the random stream {#random-draws}

You do not need this section to use a surface relative threshold feature. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

**This type spends nothing at all.** Not when it passes, not when it refuses, not when the reference is unresolved, not when the guard refuses it. A position it rejects and a position it accepts leave the stream identically placed, so a gate that flips from yes to no between two runs shifts nothing downstream by itself — everything spent belongs to the delegate.

The comparison, exactly, with `y` the position's own height:

```
threshold = surfaceHeight - minimum_distance_below_surface
fail  when  threshold <= y
```

Integer arithmetic throughout: the field is stored as a 32-bit integer, which is where the truncation comes from, and the surface is a whole number of blocks. The surface lookup itself is taken at `(x >> 2, z >> 2)` — an arithmetic shift, so it rounds down for negative coordinates too, which is what makes the 4×4 patches line up on multiples of four on both sides of the origin.

The delegate is called with the **same context object**: the same position, and the same Molang scope, not a child of it. A variable the delegate writes is visible to whatever runs after this feature.

## See also

- [Height difference filter](./height_difference_filter_feature.md) — the other pure gate, asking about the shape of the ground around a position rather than the depth below it; the two compose well.
- [Snap-to-surface feature](./snap_to_surface_feature.md) — the active counterpart: it searches for a surface and moves the delegate to it, where this one judges a position in place.
- [Single block feature](./single_block_feature.md) — the delegate this page's example uses, and the page that explains why an absent `may_replace` matches anything.
- [Scan surface feature](./scan_surface.md) — the type that generates one position per column and relies on the same surface reading this page documents.
- [Feature delegation](./feature_delegation.md) — what a wrapper does and does not change about the position, the Molang scope and the random stream.
- [Feature rules](./feature_rules.md) — how any of this reaches a world: a feature file is inert until a rule attaches it to the chunks of the biomes it belongs in.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and it holds for **1.26.40.26** too: this type's two keys, their shapes, the default and the behaviour are unchanged between the two.

The strictly-below rule, the fixed order of the depth test and the reference lookup, the shared failure message, the silent recursion-guard path, the quarter-resolution lookup and the unchanged delegate position are stated as facts about the game.

The worked example was run end to end from the committed fixtures [`surface_relative_threshold_deep.json`](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/fixtures/features/surface_relative_threshold_deep.json) and [`threshold_marker.json`](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures/features), at four origins rather than one: `(0, 50, 0)` and `(0, 57, 0)` place a block, `(0, 58, 0)` and `(0, 60, 0)` place nothing and report `Target location is not within the minimum distance to surface`. The `58`/`57` pair is what pins the word *strictly*; reading the rule off the field name would have got it wrong by one block. The image was rendered from the `(0, 50, 0)` result by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), as a solid cutaway for the same buried-feature reason [the ore page](./ore_feature.md)'s vein is.

The truncation and the negative value were measured the same way: with `10.9` written, `(0, 52, 0)` places and `(0, 53, 0)` does not, which puts the threshold at `53` and the effective distance at `10`. With `−5` written, `(0, 62, 0)` places and `(0, 68, 0)` does not, which puts the threshold at `68` — five blocks above the surface. Neither file produced a diagnostic from `featurelab check` or `featurelab generate`.

What is uncertain is collected in [what the bench does differently](#what-the-bench-does-differently): the surface value standing in for the game's pre-generation estimate, and the bench's deliberately louder treatment of the four near-miss field names.
