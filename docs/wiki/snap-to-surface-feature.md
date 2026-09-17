# Snap-to-Surface Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically — and for this feature type the version matters more than usual:
`snap_to_surface_feature` changed substantially between 1.26.40.26 and 1.26.50.24. This version
renamed `vertical_search_range` to `search_range` (gated on your file's `format_version` — see
below), added a `wall` value to `surface`, added `allow_non_air_placement`, and reworked the
column scan itself. Each change is called out in place; the [changes section](#what-changed-in-12650)
at the end collects them.

`minecraft:snap_to_surface_feature` is a **Proxy feature**: it places nothing itself. It scans a
straight line of blocks from its own origin looking for a floor, a ceiling, a wall, or (randomly)
either vertical surface, and delegates to another feature — named by `feature_to_snap`, exactly
like [Scatter Features](./scatter-feature.md)' `places_feature` — at whatever position it finds.
Where a scatter_feature spreads a delegate sideways across an area, this snaps it *onto whatever
surface is actually there*: cave ceilings, floating floors, terrain under an overhang, and now
cave walls.

## What it does

1. **Pick a scan direction.** `"floor"` scans down, `"ceiling"` scans up, at no RNG cost.
   `"random_horizontal"` draws **one** `Random` boolean and becomes floor (even draw) or ceiling
   (odd draw). `"wall"` shuffles the four horizontal directions — north, east, south, west — with
   exactly **three** bounded `Random` draws (bounds 2, 3, 4, always, in that order, whether or not
   any wall is ultimately found) and then tries each direction in shuffled order, keeping the
   first that succeeds.
2. **Classify the starting block.** If the origin cell is air or water, this is an ordinary
   *open-start* scan. If it is anything else — stone, sand, even lava — it is a *buried-start*
   scan, which is only allowed at all when [`allow_non_air_placement`](#allow_non_air_placement)
   is set, and which walks in the **opposite** direction: snapping a buried origin to a floor
   means walking *up* out of the ground, and to a ceiling means walking *down* out of it.
3. **Walk the line.** Starting from the cell next to the origin, advance while the cells stay
   *passable* (see the two definitions below), up to `search_range - 1` steps — so the scan can
   examine cells up to `search_range` blocks away. A range below 2 walks no cells at all but
   still examines the origin's immediate neighbour.
4. **Confirm the surface.** The cell the walk stopped at must either match
   `allowed_surface_blocks` (if given) or, absent that: for an open start, be able to provide
   support on the face the scan arrived at; for a buried start, be an air or water cell the
   `allow_air_placement`/`allow_underwater_placement` gates accept (the scan is confirming the
   *opening* it escaped into). An unconfirmed surface fails that direction — and for every mode
   except `wall`, that fails the whole feature: no delegation, no RNG beyond step 1.
5. **Delegate** to `feature_to_snap` at the snapped position — by default the open cell adjacent
   to the surface, or the surface block itself with [`embed_in_surface`](#embed_in_surface) —
   with the same origin-substitution/recursion-guard/Molang-scope-forwarding contract every other
   Proxy feature in this doc set uses.

### `search_range` / `vertical_search_range` — one field, renamed at 1.26.50

1.26.50 renamed `vertical_search_range` to `search_range` (it is no longer purely vertical, now
that `wall` exists). The game picks which name your file may use from the file's own declared
`format_version`, and the schema only ever contains **one** of them:

| Your file's `format_version` | Accepted name | The other name |
|---|---|---|
| below `1.26.50` | `vertical_search_range` | rejected: "not present in the Schema", value dropped |
| `1.26.50` and newer | `search_range` | rejected the same way |

There is **no** version at which both are accepted, and the wrong name is not silently ignored —
the game raises a schema diagnostic and then, because the accepted name is *required*, refuses
the file for missing it. Updating a pack's `format_version` across 1.26.50 therefore requires
renaming this field in every snap_to_surface_feature at the same time.

There is no third row for a file that declares **no** `format_version`: the key is required by
every version band's schema, so such a file matches no schema and does not load in the game at
all — nothing in it, this field included, ever gets read. (The featurelab bench is deliberately
more forgiving; see the [coverage note](#coverage-note).)

The field itself is unchanged in meaning: a positive integer, required, bounding how far the scan
reaches. Two scan subtleties are worth knowing:

- The surface can be found up to **`search_range` blocks** from the origin. (In 1.26.40.26 the
  reach was one block shorter, `vertical_search_range - 1`; a surface at exactly the maximum
  distance snaps in this version and did not in the previous one.)
- The cell at maximum distance is confirmed **without being tested for passability** — a solid
  block exactly `search_range` away counts as a found surface even though the walk never got to
  ask whether it could pass through it. Closer surfaces are found by the walk stopping on them.

### `allow_air_placement` / `allow_underwater_placement` — open-start passability

For a scan that starts in air or water, a cell counts as *passable* (safe for the scan to keep
walking through) when `allow_air_placement` is true and the cell is air, **or**
`allow_underwater_placement` is true and the cell is water. Both gates apply per cell, every step,
including the origin cell itself.

::: note
**`allow_air_placement` defaults to `true` — an absent key does NOT mean "never scan through
air."** Air is passable by default and the key is optional, so an absent key keeps that
default. **Without
air passability, a snap_to_surface_feature cannot scan through the open air above its own origin
at all** — omit the key and the scan already can; set it explicitly to `false` and a floating
origin above open ground stops working.
:::

::: note
`allow_underwater_placement` (default `false`) means **water**, not "any liquid": a lava-filled
column is never passable, no matter what is set. In fact a lava *origin* is not even an open
start — lava is neither air nor water, so starting inside it takes the buried-start path below.
:::

### `allow_non_air_placement`

New in 1.26.50.24, default `false`. If the snap **starts inside a block that is not water or
air**, this field decides whether the feature can snap *out* of it:

- **false (default)** — a buried origin fails immediately, exactly as it did in 1.26.40.26.
- **true** — the scan walks the *opposite* direction through the solid (up for `floor`, down for
  `ceiling`, outward for `wall`), keeps going while the cells stay non-air/non-water, and
  confirms the first open cell it escapes into — which must itself pass the
  `allow_air_placement`/`allow_underwater_placement` gates. The delegate is then placed in that
  opening (or, with `embed_in_surface`, in the last solid cell before it).

The direction inversion is why this is called *snapping out*: a feature buried below a field
that asks for a `floor` surface comes out standing on that field's surface, precisely where an
open-start scan falling from above would have put it.

### `surface`

One of four values:

- `"floor"` — **the default** — scan downward, delegate just above the found floor.
- `"ceiling"` — scan upward, delegate just below the found ceiling.
- `"random_horizontal"` — draw once per call (the one-boolean draw from step 1) and act as
  whichever *vertical* direction the draw picked — despite the name, this has always chosen
  between floor and ceiling, never a horizontal direction.
- `"wall"` — new in 1.26.50.24 — try the four horizontal directions in a random order (the
  three-draw shuffle from step 1) and snap to the first wall found; the delegate is placed in
  the open cell beside the wall, facing it.

::: note
**`floor` is the default, not `ceiling`** — omitting `surface` snaps *downward*, in this version
and in 1.26.40.26 alike.
:::

::: note
A `surface` value outside these four does **not** fail the file. The game logs
`Bad value for surface - should be 'ceiling', 'floor', 'random_horizontal', or `wall`` as a
content error and carries on with the default (`floor`).
:::

### `allowed_surface_blocks`

When non-empty, the confirmed surface must be one of these block descriptors specifically —
this replaces *both* no-list confirmations (the can-provide-support test of an open start and
the escaped-into-open-cell test of a buried start). Left empty (the default), any block that can
provide support confirms an open-start scan. See
[Single Block Features](./single-block-feature.md#attach-conditions--nine-keys-two-different-kinds-of-check) for the same
single-descriptor-shorthand caveat on `may_attach_to`; this field, like `may_replace`, only
accepts an array, not the bare-descriptor shorthand.

Note the interaction with `allow_non_air_placement`: a buried-start scan confirms the **open
cell** it escapes into, so a non-empty allow-list would have to contain that opening's block
(air, or water) — listing the solid blocks around it fails the scan. Buried starts and
`allowed_surface_blocks` rarely make sense together.

### `embed_in_surface`

An optional boolean, default **false**, that moves the delegate's position by exactly one cell
along the scan direction:

- **false (default)** — the delegate is placed in the open cell *adjacent* to the confirmed
  surface: one above a floor, one below a ceiling, one beside a wall — or, for a buried start,
  the first open cell past the solid.
- **true** — the delegate is placed **on the surface block itself**, replacing it (subject to
  the delegate's own `may_replace`) — or, for a buried start, the last solid cell before the
  opening.

The position is `origin + direction × (steps + (embed_in_surface XOR buried))`,
where `steps` is how many passable cells the walk crossed — one formula covering all four
combinations above.

## RNG cost

This feature type spends random draws only on direction selection, before any scanning:

| `surface` | Draws |
|---|---|
| `floor`, `ceiling` | none |
| `random_horizontal` | one boolean |
| `wall` | three bounded integer draws (bounds 2, 3, 4) — always three, found or not |

The draws happen unconditionally for their mode — a `wall` snap that fails in all four
directions has still consumed exactly three draws, so downstream features in the same pass see
the same stream either way.

## Example

```json title="snap_to_surface_feature -- scanning down through open air to reach the floor"
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

This file declares `format_version` `1.21.110` — below the 1.26.50 rename — so it must (and
does) use the old field name `vertical_search_range`. The same file redeclared at
`format_version` `1.26.50` or newer would have to say `search_range: 12` instead.

`feature_to_snap` names [the single_block_feature from the first page in this
set](./single-block-feature.md#example) verbatim — this JSON reuses its weighted pumpkin/jack
o'lantern pick and `may_attach_to.bottom` check unmodified. `allow_air_placement` is **left out
of this JSON entirely**, relying on the true default documented above; `surface: "floor"` scans
downward. Run against `plains` with feature seed `1` and origin explicitly floated at
`(0, 71, 0)` — well above open ground at this column — the downward walk crosses 8 passable
(air) cells before stopping on the grass block at world Y 62, confirms it as a supporting
surface, and delegates the pumpkin pick one cell above it, at `(0, 63, 0)` — the exact same
auto-resolved origin [the single_block_feature](./single-block-feature.md#example) and
[the structure_template_feature](./structure-template-feature.md#example) examples both land on
by default elsewhere in this doc set, reached here by an explicit downward scan instead:

![A single pumpkin sitting on a patch of grass, having been reached by scanning downward through open air, rendered by featurelab's voxel viewer](./images/snap-to-surface-feature-pumpkin.png)

```
featurelab generate --pack <pack> --feature wiki:snap_pumpkin_to_floor --env plains --seed 1 --origin 0,71,0
```

::: tip
**Setting `allow_air_placement: false` on this exact JSON breaks it**, and running that variant
through `featurelab check`/`generate` confirms it concretely rather than just in theory: with the
flag forced off, the origin cell (open air) is no longer passable, the scan fails before taking a
single step, and the whole feature fails with **zero** blocks placed — one warning diagnostic
reporting that no surface snap position was found, and no placements at all. The committed
fixture behind this is
[`fixtures/features/snap_pumpkin_air_disallowed.json`](./tools/fixtures/features/snap_pumpkin_air_disallowed.json),
identical to the example above except for that one explicit `false`.
:::

## Field reference

| Field | Required | Shape | Default |
|---|---|---|---|
| `feature_to_snap` | yes | feature identifier string | — |
| `search_range` (`format_version` ≥ 1.26.50) / `vertical_search_range` (older) | **yes** | positive number | — (required; a range below 2 walks no cells but still checks the adjacent one) |
| `surface` | no | one of `ceiling`/`floor`/`random_horizontal`/`wall` | **`floor`** (see note above) |
| `allowed_surface_blocks` | no | array of block descriptors | any block that can provide support confirms |
| `allow_air_placement` | no | boolean | **`true`** (see note above) |
| `allow_non_air_placement` | no | boolean | `false` — a buried origin fails without it |
| `allow_underwater_placement` | no | boolean | `false` — and it means **water**, not lava |
| `embed_in_surface` | no | boolean | `false` (see above) |

## What changed in 1.26.50

Relative to 1.26.40.26:

- **`vertical_search_range` was renamed to `search_range`**, gated on the file's declared
  `format_version` against 1.26.50 — exclusively, both required, never both accepted (see the
  [field's own section](#search_range--vertical_search_range--one-field-renamed-at-12650)).
- **`surface: "wall"` is new**, with its three-draw direction shuffle. `random_horizontal` kept
  its behaviour.
- **`allow_non_air_placement` is new**, and with it the whole buried-start path: a start inside
  a solid block used to fail unconditionally; now it can walk out of the solid, in the inverted
  direction. The new key is *not* format_version-gated — any file may use it.
- **The scan reaches one block further**: a surface at exactly `search_range` blocks away now
  snaps; previously the effective reach was `vertical_search_range - 1`. Likewise a range below
  2 now examines the origin's *neighbour*, where it previously examined the origin cell itself.
- The scan is now a single directional walk. 1.26.40.26 always computed both an upward and a
  downward candidate and then used one; the visible behaviour of plain floor/ceiling snaps is
  the same, but the old both-ways description of this page no longer applies.

Unchanged: the `allow_air_placement`/`allow_underwater_placement` defaults and semantics, the
water-not-lava rule, `embed_in_surface`, `allowed_surface_blocks`, the single boolean draw for
`random_horizontal` (even → floor, odd → ceiling), and `feature_to_snap`'s required-ness.

## Coverage note

This page documents the game. A few things belong to the **featurelab** bench used to
illustrate it, not to Bedrock:

- The game's no-allow-list confirmation asks whether the surface block *can provide support on
  the face the scan arrived at*, and the bench now asks the same question rather than the older,
  coarser "is this block solid". So a floor scan accepts a top slab, a right-way-up stair, a
  fence, a wall, a pane and glass, and refuses a bottom slab, farmland, a dirt path, a chest,
  leaves, a carpet, a torch, and a snow layer below full height. Blocks a pack defines itself are
  treated as supporting every face, which is what the game does with anything that does not opt
  out — naming a block `..._stairs` does not give it a stair's behaviour, here or in the game.
  Still approximate: a handful of enum states (a stair's or shelf's facing, a chain's axis, a
  grindstone's attachment) are matched by their documented value names rather than by the numbers
  the game stores, so an unusual spelling falls back to that block's default orientation.
- With an `allowed_surface_blocks` list the game compares each side's **full block state** —
  the block's name together with every one of its states at its concrete value. That is finer than block-type identity: two states of one block do not match each other.
  The bench compares the block name and the state map *as written*, which differs in two specific
  ways:
  - **A `{"tags": ...}` entry matches nothing in the game.** Resolving a tag descriptor to a block
    is not something the game supports here; it logs `It's not valid to get a block reference
    that is described by tags` and substitutes `minecraft:unknown`, which matches no real block,
    so every snap fails. The bench evaluates the tag predicate for real and accepts matching
    surfaces — looser than the game, and the one case where a working preview means a feature
    that does nothing in the world.
  - **A partly-spelled state map is stricter here.** The game completes *both* sides to the
    block's full state set before comparing, so `{"name": "minecraft:oak_log"}` matches an oak log
    standing on its default axis. The bench compares the written maps literally, so the same entry
    does not match a surface whose palette entry spells `pillar_axis` out. Spell the states the
    same way on both sides and the two agree.
- The bench applies the `format_version` rename gate exactly as described above — the wrong name
  for the declared version is dropped with a diagnostic naming the rename, and the file then
  warns about the missing required field instead of refusing to load outright (the bench
  prefers a loud, explained load over a game-faithful hard failure here, so the rest of the
  pack stays inspectable). A file that declares no `format_version` at all — which the game
  would not load in the first place — is loaded too, with a warning saying exactly that, and
  this field is then read under whichever of the two spellings the file actually wrote rather
  than being judged against a version band its author never picked.

## See also

- [Single Block Features](./single-block-feature.md) — the delegate type this page's example
  reuses verbatim, and the page with the canonical `may_attach_to.<face>` single-descriptor
  shorthand note that also applies to this feature's own `allowed_surface_blocks` caveat above.
- [Scatter Features](./scatter-feature.md) — another Proxy feature naming its delegate via a
  feature-reference field (`places_feature` there, `feature_to_snap` here), with its own
  independent offset mechanism instead of a surface scan.
- [Sequence Features](./aggregate-and-sequence-feature.md#sequence_feature) — this page's example
  is itself reused as the first step of a sequence_feature chain, precisely because
  snap_to_surface_feature's *returned* position (not its input origin) is what makes that page's
  origin-threading example meaningful.
