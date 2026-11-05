---
title: Crevasse feature
description: minecraft:crevasse_feature carves a winding trench into natural terrain, with an optional surface lining and a liquid or solid fill. Every key, the carver block list, and the order of its random draws.
typeId: minecraft:crevasse_feature
category: content
game: 1.26.70.21
scope: game
---

# Crevasse feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:crevasse_feature` carves a winding trench into terrain, starting at its origin and running out in two opposite directions.** It narrows and gets shallower toward both ends. It can line the trench with one block and fill its bottom with another.

It is new in game version 1.26.70 and needs `format_version` 1.26.50 or newer. It delegates to nothing.

## Start here: a complete example

A trench with a gravel rim and a lava floor:

```json
{
  "format_version": "1.26.50",
  "minecraft:crevasse_feature": {
    "description": { "identifier": "wiki:lava_crevasse" },
    "max_length": 12,
    "max_width": 4,
    "min_footprint": 10,
    "twistiness": 4.0,
    "carve_depth": { "range_min": 6, "range_max": 10 },
    "fill_depth": { "range_min": 4, "range_max": 6 },
    "surface_block": "minecraft:gravel",
    "fill_block": "minecraft:lava"
  }
}
```

Place it on the ground: the origin should be at or within four blocks of the terrain surface.

## Fields

All keys are optional.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `max_length` | no | integer 4 to 16 | `16` | The total walk. Each of the two sides takes half of it, in steps of one block. |
| `max_width` | no | integer 2 to 8 | `4` | The width at the origin. It tapers to 40% at the far ends. |
| `min_footprint` | no | integer 1 to 32 | `10` | The fewest connected columns the trench may have. With fewer, the feature fails and changes nothing. |
| `twistiness` | no | number 0 to 16 | `4.0` | How much the walk bends. `0` walks straight. |
| `carve_depth` | no | range 4 to 32 | `{6, 10}` | How deep the trench is at the origin, drawn once per placement. |
| `fill_depth` | no | range 0 to 32 | `{4, 6}` | How far below the origin the fill starts. It starts at least one block below the lowest surface. |
| `surface_block` | no | block descriptor | none | Written on top of each column once it is carved. `minecraft:air` counts as none. |
| `fill_block` | no | block descriptor | none | Written instead of air at and below the fill level. `minecraft:air` counts as none. |

## Common mistakes

| You wrote | What happens | Fix |
|---|---|---|
| An origin high in the air | The search looks only four blocks up and down from the origin, so the feature fails and nothing changes. | Put it through `snap_to_surface_feature` or give it a surface height. |
| A trench through planks, ice or concrete | Only [the carver list](#carver-list) can be carved. Plain `ice` is not on it, `packed_ice` is. | Use terrain from the list. |
| `min_footprint` above what `max_length` and `max_width` can reach | The feature fails every time. | Lower it, or widen the trench. |
| `format_version` below 1.26.50 | The game does not know the type in that file. | Declare 1.26.50 or newer. |

## How it runs

1. **Draw `carve_depth`.** If the origin is at or below the world's bottom plus that depth, the feature fails.
2. **Draw the angle and `fill_depth`.**
3. **Walk both sides.** Each step moves one block along the heading and bends it. Where a surface is found, a disc of columns is recorded, narrower and shallower the further out it is. These draws happen at every step, whether a surface is found or not.
4. **Check the origin.** It must have a column, and no neighbouring column may differ from it by more than one block.
5. **Keep what is connected.** Columns reached from the origin through neighbours that are not steep stay. With fewer than `min_footprint`, the feature fails.
6. **Carve, column by column.** Each column is carved from its top down, in order of x, then z.

Nothing is written before step 6, so a failed placement leaves the world untouched.

### Carving one column

- At or below the fill level, with a `fill_block`: the cell gets the fill block.
- Otherwise, if a horizontal neighbour is a liquid, the column stops there.
- Otherwise the cell becomes air.

Before a cell changes, each horizontal neighbour that is not solid and is not part of the trench at that height becomes the column's original surface block. This keeps water and sand out of the trench and keeps the fill in. A neighbour that already is the incoming block stays.

After the column, `surface_block` goes on its top cell, unless the column stopped at that very cell.

## The carver list {#carver-list}

A column's surface and every block carved below it must be on this list:

`stone`, `granite`, `diorite`, `andesite`, `tuff`, `deepslate`, `calcite`, `dirt`, `coarse_dirt`, `mud`, `podzol`, `mycelium`, `grass_block`, `dirt_with_roots`, `hardened_clay`, all 16 colored terracottas, `sandstone`, `chiseled_sandstone`, `cut_sandstone`, `smooth_sandstone`, `red_sandstone`, `chiseled_red_sandstone`, `cut_red_sandstone`, `smooth_red_sandstone`, `sand`, `red_sand`, `suspicious_sand`, `iron_ore`, `deepslate_iron_ore`, `raw_iron_block`, `copper_ore`, `deepslate_copper_ore`, `raw_copper_block`, `snow`, `snow_layer`, `packed_ice`, `gravel`, `sulfur`, `cinnabar`.

The carve of a column ends at the first block below its surface that is not solid or not on the list.

## Field reference

The [Fields](#fields) table covers every key. The ranges are the game's limits, and a value outside them is refused when the file loads.

## What the bench does differently

- **`not_feature_replaceable`.** The game never overwrites a block with this tag, such as a chest or bedrock. The bench honours it on a pack's own blocks and on a list of vanilla blocks from game version 1.26.50. A vanilla block added later that carries the tag can still be overwritten here.

How a `carve_depth` or `fill_depth` range is checked against its limits is less certain: the bench requires both ends to be inside.

## Advanced: what this type costs the random stream {#random-draws}

In order:

1. `carve_depth`: one bounded draw, none when both ends are equal.
2. The base angle: one float.
3. `fill_depth`: one bounded draw, none when both ends are equal.
4. For each of the two sides, `max_length / 2` steps of three floats each. The first two are subtracted to give a bend, and the third scales it.

If step 1 fails the origin check, nothing after it is drawn. The walk uses standard sine and cosine, not a lookup table.

## See also

- [Snap to surface](./snap_to_surface_feature.md) to find the ground first.
- [Scatter](./scatter_feature.md) for where and how often it runs.
- [RNG and determinism](./rng_and_determinism.md) for why draw order matters.

## How this page was checked

Stated for 1.26.70.21, a beta build. The engine's behaviour is pinned by tests in `features/crevasse_test.go`, and 30 placements were compared with the game in a world and agreed.
