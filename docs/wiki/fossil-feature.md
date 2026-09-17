# Fossil Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. This feature type's JSON surface — both its keys and their required status — and its whole behaviour, from the placement sequence through the structure stamp, the empty-corner test and the structure-feature check, are unchanged between 1.26.40.26 and 1.26.50.24, so the page describes both versions. Worldgen internals move between releases; nothing here should be assumed to hold for a different build without checking.

`minecraft:fossil_feature` places one of the game's **eight prebuilt fossil structures** — four spines and four skulls — buried in the terrain, with a fraction of its bone blocks swapped for an ore block of your choosing. It has the smallest JSON surface of any feature type in the system: two fields, both required.

It does not delegate to another feature. Structurally it sits between the Content and Scene groups: it places fixed, pre-authored content the way [Structure Template Features](./structure-template-feature.md) do, but it chooses its own footprint and burial depth rather than taking a position from you.

## The eight structures are game assets, not JSON

This is the part that surprises people. `fossil_feature` has no field naming a structure, because the set is fixed: the feature picks one of eight structures that ship inside the vanilla behaviour pack, under `structures/fossils/`:

```
fossils/fossil_spine_01   fossils/fossil_skull_01
fossils/fossil_spine_02   fossils/fossil_skull_02
fossils/fossil_spine_03   fossils/fossil_skull_03
fossils/fossil_spine_04   fossils/fossil_skull_04
```

They are legacy-format `.nbt` structure files, and every block in every one of them is a `minecraft:bone_block` with a `pillar_axis` state. That uniformity is what makes the ore-swap pass below work on a simple block match.

::: note
You cannot substitute your own structures here, and you cannot rename these. If you want an arbitrary buried structure, that is [Structure Template Features](./structure-template-feature.md), not this type.
:::

## Mechanics and placement sequence

Given an origin, the engine executes the following in exact order. The random draws are called out because their order is the whole determinism contract: five draws, always the same five, and the failure paths below happen *after* all of them.

1. **Structure-feature check.** If a structure feature (a village, a mineshaft, and so on) already claims this position, placement stops immediately, having drawn **nothing**.
2. **Rotation draw** — one of four rotations.
3. **Structure draw** — one of the eight structures above. Indices 0–3 select the spines, 4–7 the skulls, so a fossil is equally likely to be a spine or a skull.
4. **Horizontal offset draws** — an X offset and then a Z offset, each within the room the rotated structure leaves inside the 16×16 chunk. A rotation of 1 or 3 swaps the structure's X and Z sizes first, so a wide fossil genuinely has less room to slide than a narrow one.
5. **Height scan.** The top solid block is found across the rotated footprint. No draws.
6. **Burial-depth draw** — a jitter that pushes the fossil below that surface, so fossils sit at varying depths rather than at a fixed one.
7. **Corner test.** The corners of the fossil's bounding box are examined, and if more than `max_empty_corners` of them are empty, placement **fails**. This is what keeps fossils inside rock instead of hanging out of a cliff face or into a cave.
8. **Two placement passes.** The structure is stamped twice: once at high integrity placing bone blocks, then again at low integrity where each surviving bone block is replaced by `ore_block`. The result is a mostly-bone fossil speckled with your ore.

There is no ninth step: the engine does not check whether either pass actually wrote anything, and its own per-block clipping is switched off, so a fossil that lands somewhere the world does not keep is still reported as a success. The bench cannot copy that — see the coverage note at the bottom of this page.

::: note
Both placement passes draw from their own freshly seeded random source, not from the world-generation stream — so the speckle pattern does not shift the draws that later features in the same chunk see. Only the five draws listed above come out of the shared stream.
:::

### `max_empty_corners` is what controls the "buried" look

This field is the only real tuning knob the type has. A low value demands the fossil be almost fully enclosed and makes fossils rare; a high value lets them break the surface or protrude into caves. Because the check runs *after* all five draws, a rejected fossil still costs the same random numbers as an accepted one — a pack that sets this low will not desynchronise anything downstream, it will just place fewer fossils.

::: note
**A negative value disables the check entirely.** The comparison is unsigned, so a negative
`max_empty_corners` becomes an enormous bound and no corner count can ever exceed it: every fossil
is accepted, including ones hanging in open air. If you want fossils everywhere this is technically
how, but `8` (every corner may be empty) says the same thing without relying on the quirk.
:::

## Example

```json title="fossil_feature -- a diamond-speckled fossil"
{
  "format_version": "1.21.110",
  "minecraft:fossil_feature": {
    "description": { "identifier": "wiki:diamond_fossil" },
    "ore_block": "minecraft:diamond_ore",
    "max_empty_corners": 4
  }
}
```

That is the entire feature. Everything else — which of the eight structures, how deep, which way round — is decided per placement by the engine.

## Field reference

| Field | Required | Shape | Notes |
|---|---|---|---|
| `ore_block` | **yes** | block descriptor | The block that replaces bone in the second pass. |
| `max_empty_corners` | **yes** | integer | Maximum number of empty bounding-box corners tolerated; exceeding it fails the placement. A negative value disables the check (see above). |

There are no optional fields, no structure name, and no depth or rotation controls.

## Coverage note

This page documents the engine. Two things belong to the **featurelab** bench used to illustrate it, not to Bedrock:

- The bench has no model of structure features at all, so step 1 above never fires here: a fossil can be placed where the real engine would have skipped the position. This affects every fossil placement equally rather than particular packs.
- **A preview area that is too small makes every fossil fail, and it is worth knowing why.** A fossil is buried 15 to 24 blocks below the surface, and its anchor is never put lower than ten blocks above the bottom of the area being generated. So an area **ten blocks tall or less has nowhere to put one at all** — every seed reports `No blocks could be placed`. The horizontal offsets are drawn as up to fifteen blocks east and south of the origin, so an area **narrower than about thirty-two blocks** loses some placements off that edge too. Neither is anything about your JSON: the game writes into a whole chunk column and reports success regardless of where the blocks land, so this failure is the bench speaking. The message names the sizes that caused it. Generate a taller or wider area.
- The bench does not ship the eight `.nbt` files — they are game assets. To run this feature type, point the pack loader at a pack that provides them under `structures/fossils/` using exactly the names listed above; otherwise the feature reports which ones are missing and refuses to load rather than placing something wrong.

## See also

- [Structure Template Features](./structure-template-feature.md) — for placing your own pre-authored structures, with position and rotation under your control.
- [Ore Features](./ore-feature.md) — the ordinary way to scatter an ore block through stone.
- [Cave Carver Features](./cave-carver-feature.md) — the carvers whose cavities `max_empty_corners` is implicitly guarding against.
