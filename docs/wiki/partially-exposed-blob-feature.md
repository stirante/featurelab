# Partially Exposed Blob Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. This feature type's JSON surface — every key, enum value, bound and default — and its behaviour are unchanged between 1.26.40.26 and 1.26.50.24, so the page describes both versions. Worldgen internals move between releases; nothing here should be assumed to hold for a different build without checking.

`minecraft:partially_exposed_blob_feature` is a **Scene feature**: it generates a 3D blob of blocks centered around a floor position (one block below origin), gating placement on each position and 5 of its 6 face neighbors not being submerged in water. The one excluded face — specified by `exposed_face` — is allowed to touch water or air, creating blobs embedded in ground/walls with a single face exposed (e.g. underwater magma blobs). It does not delegate to another feature.

## Mechanics and search order

Given an origin, `Place` executes the following sequence:

1. **Center calculation**: Sets `center = (origin.X, origin.Y - 1, origin.Z)` — one block below the placement origin (the floor).
2. **Ring-by-ring iteration**: Iterates over candidate positions within the bounding cube `[-radius, +radius]` centered on `center`, using the engine's center-outward block-position walk.
   - Enumerates positions ring-by-ring in increasing Manhattan distance ($L_1 = |dx| + |dy| + |dz|$) from `(0, 0, 0)` up to $3 \times \text{radius}$.
   - Offset `(0, 0, 0)` (the center floor position itself) is checked first.
3. **Probability roll and validity check**: For every position in the iterator:
   - Performs **one unconditional RNG draw**: `roll = ctx.Random.NextFloat()`.
   - If `roll <= placement_probability_per_valid_position` AND the placement gate below accepts `pos`, places `places_block` at `pos`.
4. **Placement condition (the placement gate)**:
   - The gate is deterministic (0 RNG calls).
   - `pos` itself must **not** be water (`minecraft:water` or `minecraft:flowing_water`).
   - 5 of the 6 face neighbors around `pos` (Down, Up, North, South, West, East) must **not** be water.
   - The face neighbor corresponding to `exposed_face` is **skipped** from the water check.
5. **Result**: If at least 1 block was placed, returns success (`origin`). Otherwise, logs `"No blocks could be placed"` and fails (`nil`).

::: note
**Unconditional RNG draw**: The probability roll occurs for *every* candidate offset in the bounding cube before the placement gate is consulted at all. This means changing `placement_radius_around_floor` changes the number of RNG draws made during placement, advancing `ctx.Random` accordingly.
:::

## Example

```json title="partially_exposed_blob_feature -- magma blob exposed upward"
{
  "format_version": "1.21.110",
  "minecraft:partially_exposed_blob_feature": {
    "description": { "identifier": "wiki:magma_blob" },
    "placement_radius_around_floor": 3,
    "placement_probability_per_valid_position": 0.5,
    "exposed_face": "up",
    "places_block": "minecraft:magma"
  }
}
```

Running this feature in an `underground_stone` environment with seed `1` and origin `(0, 32, 0)` replaces 174 stone blocks with magma blocks:

![Magma blob embedded in stone with top face exposed, rendered by featurelab's voxel viewer](./images/partially-exposed-blob-feature-magma.png)

```
featurelab generate --pack <pack> --feature wiki:magma_blob --env underground_stone --seed 1 --origin 0,32,0
```

## Field reference

| Field | Required | Shape | Bounds / Values | Default |
|---|---|---|---|---|
| `placement_radius_around_floor` | yes | integer | `[1, 8]` | — |
| `placement_probability_per_valid_position` | yes | float | `[0.0, 1.0]` | — |
| `places_block` | yes | block descriptor | — | — |
| `exposed_face` | no | string | `"down"`, `"up"`, `"north"`, `"south"`, `"west"`, `"east"` | `"up"` |

### `placement_radius_around_floor`
The search radius (in blocks) around `(origin.X, origin.Y - 1, origin.Z)`. Bounded to `[1, 8]` by the engine schema.

### `placement_probability_per_valid_position`
The probability `[0.0, 1.0]` that a candidate cell will be filled if the placement gate passes.

### `places_block`
The block descriptor placed at valid candidate positions.

### `exposed_face`
The face direction excluded from the non-submerged water check. The default is `"up"` (Facing 1), and it applies even when the key is absent from JSON.

## See also

- [Ore Features](./ore-feature.md) — places ellipsoidal veins of replacement blocks.
- [Geode Features](./geode-feature.md) — places multi-layer concentric spherical blobs with hollow interiors.
