---
title: Jigsaw structures
description: How featurelab assembles a pack's jigsaw structures from worldgen/, what it reports, and which parts of the game's behaviour it does not model.
scope: bench
game: 1.26.70.21
---

# Jigsaw structures

<VersionBadge />

featurelab assembles one structure from a pack's `worldgen/` folders and places it in the bench. Run it from the command line or pick **Structure** in the preview.

```
featurelab generate --pack <dir> --structure ns:my_structure --seed 1 --size 256x300x256 --min-y=-64
```

`--seed` is the world seed. The origin only picks the chunk the structure starts in, because the game starts a structure at a chunk corner. A big structure needs a big `--size`; blocks outside the bench are counted as out-of-bounds writes.

`featurelab check` also validates the four folders: `start_pool`, `fallback`, `location`, processor lists, features and structure sets must exist, and a jigsaw block aiming at a missing pool is a warning.

## The files

A jigsaw structure is not a feature. It lives in its own folders of the behaviour pack:

| Folder | Top-level key | What it holds |
|---|---|---|
| `worldgen/structures/` | `minecraft:jigsaw` | One structure: its start pool, how deep it may grow, where it starts. |
| `worldgen/template_pools/` | `minecraft:template_pool` | A weighted list of pieces to pick from. |
| `worldgen/processors/` | `minecraft:processor_list` | Block changes applied to a piece as it is placed. |
| `worldgen/structure_sets/` | `minecraft:structure_set` | Which structures a world tries to place, and how far apart. |
| `structures/` | an `.mcstructure` file | The pieces. Jigsaw blocks inside them say what attaches where. |

## A complete example

A structure that starts from one pool and grows two levels. The piece `structures/fl/room_a.mcstructure` holds jigsaw blocks that aim at further pools.

`worldgen/structures/outpost.json`:

```json
{
  "format_version": "1.21.20",
  "minecraft:jigsaw": {
    "description": { "identifier": "fl:outpost" },
    "step": "surface_structures",
    "terrain_adaptation": "none",
    "start_pool": "fl:start",
    "max_depth": 2,
    "start_height": { "type": "constant", "value": { "absolute": 0 } },
    "heightmap_projection": "world_surface",
    "max_distance_from_center": { "horizontal": 64, "vertical": 64 },
    "liquid_settings": "ignore_waterlogging"
  }
}
```

`worldgen/template_pools/start.json`:

```json
{
  "format_version": "1.21.20",
  "minecraft:template_pool": {
    "description": { "identifier": "fl:start" },
    "elements": [
      {
        "weight": 1,
        "element": {
          "element_type": "minecraft:single_pool_element",
          "location": "fl:fl/room_a",
          "projection": "rigid",
          "processors": "fl:moss"
        }
      }
    ]
  }
}
```

`worldgen/processors/moss.json`:

```json
{
  "format_version": "1.21.20",
  "minecraft:processor_list": {
    "description": { "identifier": "fl:moss" },
    "processors": [
      {
        "processor_type": "minecraft:rule",
        "rules": [
          {
            "input_predicate": {
              "predicate_type": "minecraft:random_block_match",
              "block": "minecraft:stone_bricks",
              "probability": 0.3
            },
            "output_state": { "name": "minecraft:mossy_stone_bricks" }
          }
        ]
      }
    ]
  }
}
```

`worldgen/structure_sets/outposts.json`:

```json
{
  "format_version": "1.21.20",
  "minecraft:structure_set": {
    "description": { "identifier": "fl:outposts" },
    "placement": { "type": "minecraft:random_spread", "salt": 7, "spacing": 24, "separation": 6, "spread_type": "triangular" },
    "structures": [ { "structure": "fl:outpost", "weight": 1 } ]
  }
}
```

Then run it:

```
featurelab generate --pack <dir> --structure fl:outpost --env plains --seed 1 --size 128x300x128 --min-y=-64
```

## Fields the bench reads

The defaults are the bench's. Keys not listed here, such as the `placement` of a structure set, are not read.

### Structure

| Key | Value | Default | What it does |
|---|---|---|---|
| `start_pool` | pool name | required | The pool the first piece comes from. |
| `max_depth` | integer | `0` | How many levels of pieces may grow from the start. `0` places nothing. |
| `start_height` | `constant` with `value`, or `uniform` with `min` and `max` | `absolute` 0 | Each anchor is one of `absolute`, `above_bottom`, `below_top`. |
| `heightmap_projection` | `none`, `world_surface`, `ocean_floor` | `none` | Adds the surface height at the start to `start_height`. |
| `start_jigsaw_name` | jigsaw block name | none | Aligns the first piece on the jigsaw block with this name. A piece without one is an error. |
| `max_distance_from_center` | number, or `{horizontal, vertical}` | 80 horizontally, no vertical limit | How far pieces may reach from the start. A number sets the horizontal limit. |
| `dimension_padding` | number, or `{bottom, top}` | `0` | Keeps pieces this far from the world's bottom and top. |
| `pool_aliases` | list | none | Entries with `alias` and `target` replace one pool name with another. Random aliases are not modelled. |
| `terrain_adaptation`, `biome_filters`, `liquid_settings`, `step` | | | Read, not applied. See [What differs from the game](#what-differs-from-the-game). |

### Template pool

| Key | Value | Default | What it does |
|---|---|---|---|
| `elements` | list of `{weight, element}` | required | `weight` is 1 when left out. |
| `fallback` | pool name | `minecraft:empty` | The pool to use when nothing from this one fits. |

An `element` has an `element_type`, and a `projection` of `rigid` (the default) or `terrain_matching`:

| `element_type` | Keys |
|---|---|
| `minecraft:single_pool_element` | `location` (required), `processors` (the name of a processor list) |
| `minecraft:feature_pool_element` | `feature` (required). It attaches only to a jigsaw block facing up. |
| `minecraft:empty_pool_element` | none |

### Jigsaw blocks in a piece

These live in the block entity of each `minecraft:jigsaw` block in the `.mcstructure` file.

| Key | What it does |
|---|---|
| `target_pool` | The pool the next piece comes from. |
| `target` | Must equal the `name` of the jigsaw block it connects to. |
| `name` | This block's own name. |
| `joint` | With `aligned`, a pair facing up and down must also agree on their top faces. Any other value does not check them. Horizontal pairs never do. |
| `final_state` | The block left behind, such as `minecraft:stone_bricks`. Empty means air. `minecraft:structure_void` leaves the world's block in place. |
| `placement_priority`, `selection_priority` | The order in which connections are tried. |

The two blocks of a pair must face each other.

### Processors

| `processor_type` | What it does here |
|---|---|
| `minecraft:block_ignore` | Skips the listed blocks. |
| `minecraft:rule` | Applies the first matching rule. |
| `minecraft:protected_blocks` | Leaves blocks with the given tag in place. |
| `minecraft:capped` | Runs its delegate on every block, with no limit. |

The input and location predicates of a rule are `always_true`, `block_match`, `blockstate_match`, `random_block_match`, `random_blockstate_match` and `tag_match`, each with the `minecraft:` prefix. The position predicates are `always_true` and `axis_aligned_linear_pos`. Any other type stops the file from loading in the bench.

## What matches the game

Compared with two structures generated in a new world on Windows 1.26.70.21. 1904 of 1905 and 2094 of 2207 blocks matched. The kinds of difference we looked at point to terrain (a geode, caves, probably a dungeon and a clay patch), but they were judged by block type, not checked one by one:

- The random stream: `java.util.Random` seeded per chunk, with the start height, rotation, element and shuffle draws in the game's order.
- Placing children: priorities, shuffled connectors and rotations, whether two jigsaw blocks can attach, overlap spaces, `max_depth`, `max_distance_from_center` and `dimension_padding`.
- Processors `block_ignore`, `rule` and `protected_blocks`, with the game's per-block random.
- Turning block states in a rotated piece.
- `terrain_matching` pieces, and the `final_state` a jigsaw block leaves behind.

## What differs from the game

Each of these is reported as a warning in the run that hits it, except where noted.

| Setting | Here |
|---|---|
| `terrain_adaptation` | The terrain around the pieces stays as it is. |
| `biome_filters` | Not evaluated: the structure places in any biome. |
| `structure_sets` | Validated only. Selection and the placement grid are not modelled, so the bench builds the structure you name in the origin's chunk. Not warned. |
| `liquid_settings: apply_waterlogging` | The bench has one block layer. |
| `minecraft:capped` | The delegate runs on every block, with no limit. |
| Random `pool_aliases` | Each alias keeps its own pool name. Direct aliases work. |
| `block_entity_modifier` | Ignored: the bench has no block entities. Not warned. |

## Things worth knowing

- `/place structure` does not give the same result as world generation. It seeds its random from the position you give, so a bench run matches a structure that generated in the world, not one you placed with the command. Placing again at the same spot repeats the same result.
- `max_depth: 0` places nothing, not even the start piece. The run says so.
- A template pool declared in two files is a warning, because the game keeps the first one it loads. The game's load order is not known here, so this run may keep the other file.
- A pool name is registered in lowercase, so a reference spelled with capitals does not find it.
- A feature element attaches only to a jigsaw block facing up.
- The file lookup uses the path of `location` and ignores the namespace: `ns:ns/x/y` finds `structures/ns/x/y.mcstructure`.

## See also

- [The `featurelab` command](./cli.md): every `generate` option.
- [Structure template feature](../features/structure_template_feature.md): one `.mcstructure` file placed as a feature, without pools.
- [The VS Code extension](../editor/extension.md#the-preview): the preview, where **Structure** picks a jigsaw structure.

## How this page was checked

The field tables were read from the bench's parser. The example was run in the bench with `check` and `generate`, but this exact pack was not run in the game. The comparison with the game is described under [What matches the game](#what-matches-the-game).
