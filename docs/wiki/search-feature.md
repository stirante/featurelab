# Search Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. `search_feature`'s JSON surface — every key, enum value and default — and its
behaviour are unchanged between 1.26.40.26 and 1.26.50.24, so the page
describes both versions. Worldgen internals move between releases; nothing here should be assumed to
hold for a different build without checking.

`minecraft:search_feature` is a **Proxy feature**: it places nothing itself. It searches a 3D
volume of candidate offsets from its own origin, along a configurable axis order, delegating a
wrapped feature to each candidate **transactionally** — every write a candidate's delegation makes
is buffered, not applied to the real world, until enough candidates have succeeded. An exhausted
search discards every buffered write; nothing partial is ever left behind. Where [Snap-to-Surface
Features](./snap-to-surface-feature.md) scan a single column for a floor or ceiling, this type
searches a full box along any of six axis directions, and only commits once, at the end.

## What it does

1. Resolve the wrapped feature (`places_feature`). Unresolved, or the recursion guard denying this
   wrapper (both report the same message),
   fails immediately with no search at all.
2. Wrap the real block-writing API in a transactional buffer: reads see the buffer's own prior
   writes layered over the real world (so a multi-step delegate sees its own earlier writes within
   the same search attempt), but nothing is written to the real API until the whole search
   commits.
3. Walk `search_volume` (a `[min, max]` box of **offsets** from the origin, inclusive on every
   axis) as a triple-nested loop whose axis roles and iteration direction are fixed entirely by
   `search_axis` — see the table below. For each candidate offset: build a placement context at
   `origin + offset`, pointed at the transactional buffer instead of the real API, and delegate
   the wrapped feature there under the standard recursion guard.
4. Every successful candidate increments a counter and is remembered as the latest result. Once
   the counter reaches `required_successes`, **stop searching immediately**, flush every buffered
   write to the real API in the order they were made, and return that latest result.
5. If the loop runs out of candidates before reaching `required_successes`, discard the whole
   transaction — nothing buffered is ever applied — and fail with `"Could not find a valid
   position for the feature"`.

Zero RNG is drawn directly by this feature type — every draw belongs to whatever the delegated
target does at each candidate.

### `search_axis` and loop order

`search_axis` picks which of the search volume's three axes is the outer, middle, and inner loop,
and which direction each one iterates:

| `search_axis` | outer | mid | inner |
|---|---|---|---|
| `-x` | x, descending | z, descending | y, ascending |
| `+x` | x, ascending | z, ascending | y, ascending |
| `-y` | y, descending | x, descending | z, ascending |
| `+y` | y, ascending | x, ascending | z, ascending |
| `-z` | z, descending | x, **ascending** | y, ascending |
| `+z` | z, ascending | x, **descending** | y, ascending |

Two patterns in that table are worth naming, because neither is the obvious one:

- **The innermost loop always ascends**, whichever axis it is.
- **The middle loop follows the outer loop's direction for the x and y families, but inverts it
  for the z family.** A `-z` search walks z downward while walking x *upward*, and a `+z` search
  does the opposite.

`search_axis` is **required** — the game's schema marks it so, and a file omitting it does not
load. (For completeness: there is an internal default of `+y`, but no JSON can reach it.)

::: warning
The loop order is only observable when the search volume spans more than one cell on more than one
axis. A **fully degenerate** search volume (`min` equal to `max` on all three axes, i.e. a single
candidate cell) — common in real packs — hides it completely.
:::

## Example

```json title="search_feature -- scanning downward for a floor to delegate to"
{
  "format_version": "1.21.110",
  "minecraft:search_feature": {
    "description": { "identifier": "wiki:search_pumpkin_down" },
    "places_feature": "wiki:pumpkin_patch_block",
    "search_volume": { "min": [0, -10, 0], "max": [0, 0, 0] },
    "search_axis": "-y",
    "required_successes": 1
  }
}
```

::: note
**`search_volume` really does use `min` and `max`, and that is not the range spelling.** Other
feature types have range fields — `depth`, `age`, `y_scale`, `trunk_height` and so on — whose object
form is `{ "range_min": …, "range_max": … }`, and writing `min`/`max` there fails silently in-game.
`search_volume` is a different thing: a pair of positions describing a box, not a numeric range, so
its two members are genuinely named `min` and `max` and take `[x, y, z]` arrays. Mojang's own files
use both conventions side by side; which one applies follows the field's type.
:::

`places_feature` names [the same single_block_feature from the first page in this
set](./single-block-feature.md#example) — a weighted pumpkin/jack o'lantern pick that needs grass
directly below to attach to. `search_volume` fixes `x`/`z` at the origin and searches only `y`,
from `0` down to `-10` relative to it; `search_axis: "-y"` makes that the (sole meaningful) outer
loop, descending. Run against `plains` (surface height `63`) with feature seed `1` and origin
`(0, 70, 0)` — floating 7 blocks above the ground, the same setup [the Snap-to-Surface Features
page's own example](./snap-to-surface-feature.md#example) uses — the first 7 candidates
(`y` 70 down to 64, all open air with nothing to attach to) fail; the 8th, `(0, 63, 0)`, succeeds —
one cell above the real ground (grass at `y=62`), exactly where the delegate's own
`may_attach_to.bottom` check needs to be — and `required_successes: 1` commits immediately:

![A single pumpkin sitting on a patch of grass, found by a search_feature scanning downward through open air one candidate at a time, rendered by featurelab's voxel viewer](./images/search-feature-pumpkin-down.png)

```
featurelab generate --pack <pack> --feature wiki:search_pumpkin_down --env plains --seed 1 --origin 0,70,0
```

::: tip
Shrink `search_volume.min` to `[0, -3, 0]` on the same JSON (`wiki:search_pumpkin_too_shallow` in
the committed fixtures) and the search never reaches the ground: all 4 candidates (`y` 70 down to
67) fail, the loop exhausts, and — because the whole attempt is transactional — the result is
**exactly** as if nothing had ever been tried, not a partial write:

```
featurelab generate --pack <pack> --feature wiki:search_pumpkin_too_shallow --env plains --seed 1 --origin 0,70,0
```

produces `"level":"warning"`, `"message":"Could not find a valid position for the feature"`, and
zero blocks changed. (This
particular delegate has nothing to roll back mid-attempt — a single_block_feature either writes
its one block or writes nothing — so this example demonstrates the exhaustion/failure path
precisely, but not the buffered-multi-write rollback the transactional design exists for; that
would need a delegate that writes more than one cell per candidate to actually observe.)
:::

## Field reference

| Field | Required | Shape | Default |
|---|---|---|---|
| `places_feature` | yes | feature identifier string | — |
| `search_volume` | yes | `{min: [x,y,z], max: [x,y,z]}`, integer offsets from the origin | — |
| `search_axis` | yes | one of `-x`/`+x`/`-y`/`+y`/`-z`/`+z` | — (schema-required; the unreachable internal default is `+y`) |
| `required_successes` | no | positive integer | `1` |

## See also

- [Snap-to-Surface Features](./snap-to-surface-feature.md) — a narrower, single-column floor/
  ceiling scan; this page's example reaches the same kind of result (a floating origin resolving
  to real ground) through a general-purpose volume search instead.
- [Single Block Features](./single-block-feature.md) — the delegate type this page's example
  uses.

## Version and verification notes

Everything above is a statement about 1.26.50.24 specifically, and holds
for 1.26.40.26 too: this type's JSON surface and its behaviour are unchanged between the two
versions. `features/search_feature.go`'s own header comment carries the details.

Both JSON examples on this page (the successful
downward search and the deliberately-too-shallow failing variant) were run end to end against this
project's own worldgen tooling (`featurelab check` and `featurelab generate`)
and produced the described results, which is also how a reader can re-check them. The accompanying image was
rendered from the successful result by this doc set's own image pipeline (see
[`docs/wiki/tools/`](./tools/generate-images.mjs)).
