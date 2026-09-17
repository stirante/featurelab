# Multipart Block Column Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. `minecraft:multipart_block_column_feature` is **new in that version** — it does not exist in 1.26.40 or earlier, so nothing here applies to older versions.

`minecraft:multipart_block_column_feature` places one straight column of blocks with **four distinct roles** — `base_block`, `middle_block`, `frustum_block`, `tip_block` — arranged bottom-to-top along a configurable direction. Think dripstone-like spikes, icicles, pillars, stalks: one block for the root, a repeating shaft, a tapering block, and a point.

It does not delegate to another feature. Compared to [Growing Plant Features](./growing-plant-feature.md), the other block-column type: growing plants pick every layer's block by weighted draw and probe the world layer by layer; a multipart column has fixed per-role blocks, draws its height **once**, and stands or falls on two predicate lists.

## The four roles depend on the column's height

The column's cells are filled by role, and the roles that actually appear depend on the height the placement ends up with:

| Height | Layout, from the origin outward |
|---|---|
| 1 | `tip_block` |
| 2 | `frustum_block`, `tip_block` |
| 3 | `base_block`, `frustum_block`, `tip_block` |
| 4+ | `base_block`, `middle_block` × (height−3), `frustum_block`, `tip_block` |

So the tip always survives, the frustum joins at height 2, the base at height 3, and only columns of height 4 or more contain any `middle_block` at all. All four fields are **required** in the JSON regardless — a column that never grows past 2 still must declare a `middle_block` it will never place.

## Two ways to give the height — exactly one of them

The height comes from either `height_range` or `weighted_heights`:

- **`height_range`** — an integer range `[min, max]`. The height is uniform over `[min, max-1]`: the *maximum is exclusive* (this is the engine's standard integer-range draw; `[2, 7]` produces 2..6). A degenerate range like `[4, 4]` always produces its minimum, without consuming a random draw.
- **`weighted_heights`** — an array of `{ "value": int, "weight": int }` objects. One weighted pick selects an entry; that entry's `value` is the height. Weights are plain integers; an entry's missing `weight` (or `value`) counts as `0`.

Giving **both** logs the engine's content-log error *"height_range and weighted_heights can't be given at the same time"*; giving **neither** logs *"height_range or weighted_heights has to be given"*. Note that in both cases the feature still loads and still runs — these are diagnostics, not rejections. With both present, `weighted_heights` wins; with neither, the column height evaluates below 1 and the feature places nothing (see the quirk below).

::: note
The "given at the same time" check looks at the parsed **values**, not at which keys appear in the file: `height_range` counts as "given" only when neither of its bounds is `-1` (the internal not-set marker). An explicit `"height_range": [-1, -1]` is treated exactly like omitting the field.
:::

## Mechanics and placement sequence

Given an origin, the engine executes the following in exact order. This type consumes **at most one random draw** per placement, and the order of the gates around it matters for anything sharing the random stream:

1. **Surface check (`may_place_on`) — no draws.** The block **one step behind the origin** (below it for `direction: "up"`, above it for `"down"`, and so on) must match the `may_place_on` list. An omitted or empty list allows any surface. Failure stops placement immediately, before the height draw.
2. **Height draw — the only draw.** From `weighted_heights` (one bounded draw against the summed weights — skipped entirely if the weights sum to 0) or from `height_range` (one bounded draw — skipped if the range is degenerate).
3. **Obstruction scan (`may_replace`) — no draws.** Starting **at the origin itself** and stepping along `direction`, cells are checked against `may_replace` one by one. The scan stops at the first non-matching cell or once it has cleared `height` cells. An omitted or empty list lets the column replace anything. The column is then **truncated** to the number of consecutive clear cells.
4. **Minimum-height gate.** The truncated height must still reach a minimum: `height_range`'s `min`, or — on the weighted path — the **smallest `value` across all `weighted_heights` entries** (not the value that was picked!). Falling short fails the placement, with nothing placed.
5. **Placement — no draws.** The surviving cells are written unconditionally per the role table above. The reported success position is the **tip cell**.

Two consequences worth spelling out:

- A partially-obstructed column does not fail outright; it shrinks. With `weighted_heights` of `[{value: 7, weight: 9}, {value: 2, weight: 1}]`, a ceiling three cells up truncates a drawn 7 down to 3 — and 3 ≥ 2 (the smallest configured value), so a short base/frustum/tip column places happily. Use the minimum entry as your "shortest acceptable spike" knob.
- The scan includes the origin cell, so the origin itself must satisfy `may_replace`. A column standing on stone and growing through air wants `"may_place_on": ["minecraft:stone"]` and `"may_replace": ["minecraft:air"]`.

### `direction` takes all six directions

`direction` accepts `"down"`, `"up"`, `"north"`, `"south"`, `"west"`, `"east"` (matched case-insensitively), and defaults to `"up"`. Horizontal columns are perfectly legal — a sideways spike growing out of a wall is just `"direction": "east"` with `may_place_on` naming the wall material.

::: note
An unrecognized `direction` string does not error — the engine silently uses the default `"up"`. Check your spelling; the bench raises a warning where the engine says nothing.
:::

### The place-nothing success

If the effective height ends up below 1 — most easily by giving neither height source, or a `weighted_heights` entry with `value: 0` — the feature places **no blocks at all yet still reports success**, with a position behind the origin. Nothing downstream of a composite will notice anything wrong. If a pack "works" but no columns appear, check that a real height source is present before suspecting the predicates.

## `format_version` gates this whole type

The engine keeps a separate schema per `format_version` band, and this type belongs to the
**1.26.40** band and newer. A file declaring an older `format_version` cannot name
`minecraft:multipart_block_column_feature` at all: the schema it is matched against has no such
type, so the file does not load — no diagnostic about any individual key, just a file the game
will not take. Give the file a `format_version` of `1.26.40` or newer.

## Example

```json title="multipart_block_column_feature -- a dripstone-like floor spike"
{
  "format_version": "1.26.50",
  "minecraft:multipart_block_column_feature": {
    "description": { "identifier": "wiki:dripstone_spike" },
    "direction": "up",
    "base_block": "minecraft:dripstone_block",
    "middle_block": "minecraft:dripstone_block",
    "frustum_block": "minecraft:pointed_dripstone",
    "tip_block": "minecraft:pointed_dripstone",
    "weighted_heights": [
      { "value": 2, "weight": 3 },
      { "value": 4, "weight": 4 },
      { "value": 7, "weight": 1 }
    ],
    "may_replace": [ "minecraft:air" ]
  }
}
```

Short spikes twice as often as tall ones, growing only through air, shrinking gracefully under low ceilings as long as at least 2 cells fit.

`may_place_on` is deliberately left out. Adding it — `[ "minecraft:dripstone_block", "minecraft:stone" ]` would be the natural choice — is what a real cave pack would do, and it is also why this example would place nothing here: `may_place_on` is checked against the block below the origin, and none of this doc set's environment presets offers a stone floor with open air above it at the height this example runs at. That is a property of the bench's presets, not of the feature; see the field reference below for what the check actually tests.

At feature seed `7` the height draw lands on the rarest of the three weights — the only one that shows the whole role vocabulary at once:

![A seven-block dripstone column: five dripstone blocks below two pointed dripstone blocks, rendered by featurelab's voxel viewer](./images/multipart-block-column-feature-dripstone-spike.png)

Bottom to top that is `base_block`, four repeats of `middle_block`, then `frustum_block` and `tip_block`. The two commoner draws — 2 and 4 — place a column that contains no `middle_block` at all, which is worth remembering when a pack's middle role looks like it is being ignored: at those heights it genuinely is not placed.

## Field reference

| Field | Required | Shape | Notes |
|---|---|---|---|
| `tip_block` | **yes** | block descriptor | The outermost cell — the only role present at every height. |
| `frustum_block` | **yes** | block descriptor | The second-from-tip cell, from height 2 up. |
| `middle_block` | **yes** | block descriptor | The repeating shaft, only at heights ≥ 4. |
| `base_block` | **yes** | block descriptor | The origin cell, from height 3 up. |
| `height_range` | one of the two | integer range | Height uniform over `[min, max-1]` (max exclusive). Mutually exclusive with `weighted_heights`. |
| `weighted_heights` | one of the two | array of `{value, weight}` | One weighted pick; the picked `value` is the height. Integer weights; a missing `value`/`weight` counts as 0. The smallest `value` doubles as the minimum acceptable truncated height. |
| `direction` | no | string, default `"up"` | `down` / `up` / `north` / `south` / `west` / `east`, case-insensitive. Unrecognized strings silently mean `"up"`. |
| `may_place_on` | no | array of block descriptors | The block one step behind the origin must match. Omit to allow any surface. |
| `may_replace` | no | array of block descriptors | Every column cell must match to be replaced; the first mismatch truncates the column. Omit to allow replacing anything. |

## Coverage note

This page documents the engine. Two bench-side details:

- When the engine matches `may_place_on`/`may_replace` candidates, it first clears the candidate block's `update_bit` and `persistent_bit` states, so listed descriptors match those blocks regardless of either bit. The bench matches block identity directly and does not model that normalization; the difference is only observable for descriptors distinguished solely by one of those two states.
- Weights in `weighted_heights` should be positive. Configurations whose weights are all zero or negative put the game's own pick into undefined territory; the bench refuses the placement with a diagnostic instead of guessing.

## See also

- [Growing Plant Features](./growing-plant-feature.md) — the per-layer randomized block column (cave vines, kelp), with body/head weighted picks per placement.
- [Single Block Features](./single-block-feature.md) — one block with attach conditions, for when a "column" of height 1 is really all you need.
- [Ore Features](./ore-feature.md) — the other prominent `may_replace` consumer.
