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
