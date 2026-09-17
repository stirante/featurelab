# Vegetation Patch Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. This type's JSON surface — every key, enum value and default — and its behaviour
are unchanged between 1.26.40.26 and 1.26.50.24, so everything here describes
both versions. Worldgen internals move between releases; nothing here should be assumed to hold
for a different build without checking.

`minecraft:vegetation_patch_feature` is a **Scene feature**: a footprint search across a
rectangular area (finding real ground — or a real ceiling — under an irregular vertical offset
per column) combined with delegated content placement (one more feature, run once per found
column) in a single call. Unlike [Geode Features](./geode-feature.md), it doesn't write its
vegetation itself — `vegetation_feature` names another feature (almost always a
[Single Block Feature](./single-block-feature.md)) that this type delegates to, once per kept
column, the same delegation shape every [Proxy feature](./scatter-feature.md) on this doc set
uses, layered underneath a genuine footprint search.

## What it does

1. If `waterlogged` is `true`, place **nothing** — see the warning below.
2. Otherwise, draw two independent [horizontal_radius](#depth-and-horizontal_radius-ranges)
   values, one for X and one for Z — a non-square footprint is possible whenever
   `horizontal_radius` is a genuine range rather than a fixed number, since the two draws are
   independent. **Each drawn value is then widened by one**: a `horizontal_radius` of 4 walks
   `dx` from -5 to 5, an 11×11 rectangle, not 9×9.
3. Walk every `(dx, dz)` offset inside that X/Z rectangle. **Corner** cells (both `dx` and `dz`
   at their own extreme) are always dropped, no roll. Cells on exactly **one** edge (`dx` or `dz`
   at its extreme, not both) are *also* dropped, unless `extra_edge_column_chance` is set above
   `0` and a roll against it succeeds — with `extra_edge_column_chance` left at its default of
   `0`, this means the **entire outer ring** — the widened one from step 2 — is dropped
   unconditionally, and only the interior survives to the next step (see the note below).
4. For each surviving column, find the surface, in up to two phases. Starting at the origin's own
   Y: while the cell is air, step *toward* the surface (`floor`: downward; `ceiling`: upward), at
   most `vertical_range` times. Then, if the cell it stopped on is **not** air — which is what a
   column whose origin started buried inside the ground looks like — step back the other way while
   the cell is not air, again at most `vertical_range` times. A column that ends on a non-air cell
   after all that is dropped.
5. The **ground cell** is the one immediately past that air cell, in the scan direction: the
   floor block under it, or the ceiling block over it. That block has to be able to support the
   face the scan arrived from (its top face for `floor`, its bottom face for `ceiling`), or the
   column is dropped — most full blocks can; open shapes like fences, torches and rails cannot.
6. Write `ground_block` into that ground cell and into `depth - 1` further cells past it (plus
   one more, with probability `extra_deep_block_chance`), continuing *into* the solid
   ground/ceiling. A cell already holding `ground_block` counts without being rewritten; a cell
   listed in `replaceable_blocks` is overwritten; anything else stops the walk there, and drops
   the whole column **only if that happened on the very first cell**. `depth: 0` writes nothing
   at all and still keeps the column — which is exactly how vanilla-shaped patches that only want
   to plant something on existing ground are written.
7. For every column still kept after all of that, roll `vegetation_chance`; on success, delegate
   to `vegetation_feature` at the air cell from step 4 — one block *above* the ground cell for
   `surface: "floor"`, one block *below* it for `surface: "ceiling"`.
8. Report success (the position of the *last* kept ground cell) if at least one column survived;
   otherwise fail with `"Vegetation could not be placed"` — the same message a
   `waterlogged: true` call fails with, see below.

::: warning
**`replaceable_blocks` is about the ground, not the air above it.** Step 6 writes into the solid
surface, so a patch whose `replaceable_blocks` lists only `minecraft:air` can never replace
anything: its first cell is the ground block itself, which is not air, so every column is dropped
unless the ground already happens to be `ground_block`. List the terrain materials the patch is
meant to eat into — `minecraft:stone`, `minecraft:dirt`, `minecraft:grass_block` and so on.
:::

::: note
**The widening in step 2 and the default `extra_edge_column_chance` of `0` cancel out — almost.**
A `horizontal_radius: 4` patch walks an 11×11 rectangle (`2×(4+1) + 1` per axis), but with
`extra_edge_column_chance` left unset, the entire outer ring of that rectangle is dropped in
step 3, leaving a 9×9 interior (`2×4 + 1` per axis) actually eligible for ground/vegetation.
The same JSON with `horizontal_radius: 4` and no `extra_edge_column_chance`
keeps exactly 81 columns against flat terrain — `9 × 9`, not `11 × 11` or a rounded circle. Set
`extra_edge_column_chance` above `0` if the outer ring should be eligible at all; at `1` the
footprint is the full 11×11 minus its four corners.
:::

## `surface: "floor"` vs. `surface: "ceiling"`

Both paths share the exact same logic above; only the direction of "up" flips. `surface`
(default `"floor"`) accepts exactly two values — anything else is a build-time error mirroring
the game's own content-log line verbatim: `"Bad value for surface - should be 'ceiling' or
'floor'"`.

| `surface` | Ground scan direction | Depth fill direction | Vegetation growth direction |
|---|---|---|---|
| `"floor"` (default) | downward, through air, looking for solid ground below | further down, into the solid ground | upward, away from the ground |
| `"ceiling"` | upward, through air, looking for a solid ceiling above | further up, into the solid ceiling | downward, away from the ceiling |

A `"ceiling"` patch is exactly what lush-cave-style hanging vegetation is built from: the bottom
layer of a stone ceiling is *replaced* by `ground_block` (typically `minecraft:moss_block`), and
the delegated `vegetation_feature` — typically a
[Single Block Feature](./single-block-feature.md) with `may_attach_to.top` naming that same
ground block — grows downward from the newly coated surface into the open space below it. Note
"replaced", not "coated underneath": for that to work, `replaceable_blocks` has to list whatever
the ceiling is actually made of.

## `waterlogged`

::: warning
**`waterlogged: true` places nothing here, silently.** The game still walks the whole
patch and writes its `ground_block` cells; what it discards is the column list, handing it to a
separate water-surface placement path this tool does not implement at all, after which its own
return value is indeterminate. This tool models the visible outcome — no vegetation — and skips
the ground writes with it, which is a real, disclosed gap in this project's own coverage rather
than a guess about what the real game does. Any `vegetation_patch_feature` with `waterlogged: true` reports failure
(`"Vegetation could not be placed"`) with **zero** blocks changed in this project's own tooling. If your patch needs to work underwater, leave `waterlogged` unset (or
`false`) and gate placement some other way — a delegated feature with its own `may_replace`
including `minecraft:water`, for instance.
:::

## `depth` and `horizontal_radius` ranges

Both fields are range objects, so they accept a bare number, a 2-element `[min, max]` array, or
a `{range_min, range_max}` object. Note the object's key names: the game reads only `range_min`
and `range_max`, and given `min`/`max` it logs an error and silently substitutes a zero-width range
instead of rejecting the field. When the range is
genuinely non-degenerate (`min < max - 1`), the drawn value is uniform over `[min, max - 1]` —
**`max` is exclusive** once a real draw happens, one `NextIntBound(max - min)` call. When
`min >= max - 1` (a bare number, or any range spanning at most one distinct value, like `[3, 3]`
or `[3, 4]`), the result is always exactly `min`, with **zero** `Random` draws spent — that is the
contract of the game's integer ranges, which genuinely differ from
[Geode Features](./geode-feature.md#minmax_distribution_points-minmax_outer_wall_distance-minmax_point_offset)'
own `min`/`max` ranges; the two disagree at exactly this boundary.

## `vegetation_chance`, `extra_deep_block_chance`, `extra_edge_column_chance`

All three are plain `0`–`1` probabilities, each defaulting to `0` (never), each costing zero
`Random` draws whenever left at that default (or any value `<= 0`).

::: warning
**Omitting `vegetation_chance` builds the ground patch but plants nothing on it.** This is easy
to miss precisely because the *ground* patch still writes real blocks — a `vegetation_chance`-less
`vegetation_patch_feature` visibly does something, just not the vegetation part its own name
promises. The floor example below with `vegetation_chance` omitted writes 13
`minecraft:grass_block` cells and exactly zero of whatever `vegetation_feature` names. Set
`vegetation_chance` above `0` if you want any vegetation to actually grow.
:::

## Example — `surface: "floor"`

```json title="vegetation_patch_feature -- a re-grassed patch with pumpkins on top"
{
  "format_version": "1.21.110",
  "minecraft:vegetation_patch_feature": {
    "description": { "identifier": "wiki:vegetation_patch_floor" },
    "replaceable_blocks": ["minecraft:grass_block", "minecraft:dirt", "minecraft:stone"],
    "ground_block": "minecraft:grass_block",
    "vegetation_feature": "wiki:pumpkin_patch_block",
    "depth": 1,
    "extra_deep_block_chance": 0.1,
    "vertical_range": 3,
    "vegetation_chance": 0.6,
    "horizontal_radius": 4,
    "extra_edge_column_chance": 0.3,
    "waterlogged": false,
    "surface": "floor"
  }
}
```

`vegetation_feature` names `wiki:pumpkin_patch_block`, [the same single_block_feature from the
first page in this set](./single-block-feature.md#example) (pumpkin/jack o'lantern, attached to
grass) — by the time this delegate runs, `ground_block` has made the cell underneath it real
`minecraft:grass_block`, so `may_attach_to.bottom: "minecraft:grass_block"` succeeds. Run against
`plains` with feature seed `1`, this patch re-surfaces the columns it kept — only 13 cells
actually change, since most of the plains surface is already `minecraft:grass_block` and a cell
that already holds `ground_block` is counted rather than rewritten — and grows pumpkins or jack
o'lanterns on 53 of them:

![A patch of pumpkins and jack o'lanterns scattered across flat grassland, rendered by featurelab's voxel viewer](./images/vegetation-patch-feature-floor-pumpkins.png)

```
featurelab generate --pack <pack> --feature wiki:vegetation_patch_floor --env plains --seed 1
```

## Example — `surface: "ceiling"`

```json title="vegetation_patch_feature -- moss-coated ceiling with hanging roots"
{
  "format_version": "1.21.110",
  "minecraft:vegetation_patch_feature": {
    "description": { "identifier": "wiki:vegetation_patch_ceiling" },
    "replaceable_blocks": ["minecraft:stone"],
    "ground_block": "minecraft:moss_block",
    "vegetation_feature": "wiki:hanging_roots_ceiling_block",
    "depth": 1,
    "extra_deep_block_chance": 0.1,
    "vertical_range": 6,
    "vegetation_chance": 0.8,
    "horizontal_radius": 4,
    "extra_edge_column_chance": 0.3,
    "waterlogged": false,
    "surface": "ceiling"
  }
}
```

`vegetation_feature` names a new `single_block_feature` for this page,
`wiki:hanging_roots_ceiling_block` — `minecraft:hanging_roots`, `may_attach_to.top:
"minecraft:moss_block"`, `may_replace: ["minecraft:air"]` — the ceiling-path counterpart to the
floor example's own `wiki:pumpkin_patch_block`. The image below wraps this JSON in a small
`aggregate_feature` together with a helper `scatter_feature` that first scatters plain
`minecraft:stone` five blocks above the origin, purely so this screenshot has a real stone
overhang to patch — that scatter is scaffolding for the illustration, not part of
`vegetation_patch_feature` itself. Run against `void` (so nothing but this feature's own output
is visible) with feature seed `1` and origin `(0, 10, 0)`, the ceiling scan finds the stone
overhang, turns 57 of its blocks into `minecraft:moss_block` (`replaceable_blocks` lists
`minecraft:stone` for exactly this reason — six stone blocks the scan never reached stay stone),
and grows `minecraft:hanging_roots` downward from 42 of the kept columns:

![A stone overhang whose underside has been replaced by green moss, with reddish hanging roots dangling down, rendered by featurelab's voxel viewer](./images/vegetation-patch-feature-ceiling-roots.png)

```
featurelab generate --pack <pack> --feature wiki:vegetation_patch_ceiling_demo --env void --seed 1 --origin 0,10,0
```

## Field reference

| Field | Required | Shape | Default |
|---|---|---|---|
| `replaceable_blocks` | yes | non-empty array of block descriptors | — |
| `ground_block` | yes | block descriptor | — |
| `vegetation_feature` | yes | feature identifier string | — |
| `depth` | yes | number, 2-element `[min, max]` array, or `{range_min, range_max}` object (int range, `max` exclusive) | — |
| `horizontal_radius` | yes | same int-range shape as `depth` | — |
| `vertical_range` | yes | number `>= 1` | — |
| `extra_deep_block_chance` | no | number, `0`–`1` probability | `0` — never |
| `vegetation_chance` | no | number, `0`–`1` probability | `0` — never, see warning above |
| `extra_edge_column_chance` | no | number, `0`–`1` probability | `0` — never, see note above |
| `waterlogged` | no | boolean | `false` |
| `surface` | no | `"floor"` or `"ceiling"` | `"floor"` |

## See also

- [Single Block Features](./single-block-feature.md) — the delegate type this page's own two
  examples both use, and the most common `vegetation_feature` target in real packs.
- [Scatter Features](./scatter-feature.md) — a Proxy feature whose own footprint (a random
  offset per iteration) contrasts with this page's own real ground/ceiling search per column.
- [Geode Features](./geode-feature.md) — the other Scene feature in this version, contrasted
  by writing its own content directly instead of delegating.

## Version and verification notes

Everything above is a statement about 1.26.50.24 specifically, and holds
for 1.26.40.26 as well: this type's JSON surface and its behaviour are unchanged between the two
versions.

Four details are easy to get wrong: the drawn `horizontal_radius` is widened by one before the
walk; the column walk has a second phase that climbs back out of solid ground; the cell
`ground_block` is written into is the solid one *past* the air cell the walk stops in, not the air
cell itself (so `replaceable_blocks` is about ground materials, not air — a patch naming only
`minecraft:air` as replaceable can never replace anything); and `depth: 0` keeps its column rather
than dropping it. `features/vegetation_patch.go`'s own header comment carries the details.

The two footprint gotchas documented above — the default `extra_edge_column_chance` leaving a
`horizontal_radius: 4` patch its 9×9 interior, and an omitted `vegetation_chance` planting
nothing — can be checked by running the described
JSON bodies through this project's own worldgen tooling (`featurelab check` and `featurelab
generate`) and reading the written-cell counts back out of each result. That is the part a reader can
reproduce directly. Both JSON examples on this page were run end to end the same way and produced the
described results; the accompanying images were rendered from those exact results by this doc set's
own image pipeline (see [`docs/wiki/tools/`](./tools/generate-images.mjs)).
