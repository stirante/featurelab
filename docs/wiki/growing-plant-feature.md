# Growing Plant Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. This feature type's JSON surface — every key, its bounds and its required/optional status — and its placement are unchanged between 1.26.40.26 and 1.26.50.24, so the page describes both versions. Worldgen internals move between releases; nothing here should be assumed to hold for a different build without checking.

`minecraft:growing_plant_feature` is a **Content feature**: it places a vertically-growing column of blocks (cave vines, weeping vines, kelp, twisting vines) starting at the origin, with weighted selection for body and head blocks, a randomized column height, and an optional growing plant age injected into the head block. It does not delegate to another feature.

## Mechanics and placement loop

Given an origin, `Place` executes the following sequence in exact order:

1. **Height distribution pick**: Performs a weighted random pick over `height_distribution` to select a height range entry (`[IntRange, weight]`). This consumes 0 or 1 float draw from `ctx.Random`.
2. **Height draw**: Samples the selected height range. If `min >= max - 1`, this draws 0 random numbers and returns `min`. Otherwise, it draws 1 `nextIntBound(max - min)` and adds `min`. Note the `- 1`: a range whose max is exactly one above its min, such as `[3, 4]`, is *also* degenerate and takes no draw — writing the rule as `min >= max` predicts a draw there that never happens.
3. **Age draw**: Samples `age` unconditionally. This draw happens **before** checking if `height < 1`, and occurs whether `age` is specified or omitted (omitted `age` defaults to `{min: 0, max: 0}`, which takes 0 draws and returns 0).
4. **Height check**: If `height < 1`, placement fails immediately (logging `"No air or water blocks at target location"` if `allow_water` is true, or `"No air blocks at target location"` if `false`). Zero further RNG draws or block writes occur.
5. **Column traversal**: Loops over `i` from `0` to `height - 1`. The vertical offset for step `i` is `+i` if `growth_direction` is `"up"`, or `-i` if `"down"`.
   - **Position validity**: Checks if `pos = origin + (0, offset(i), 0)` is air (or empty water if `allow_water` is true).
   - **Obstruction skip**: If `pos` is neither air nor valid water, the loop skips this layer silently (`continue`). It does NOT abort the feature placement or stop the search.
   - **Lookahead peek**: If `pos` is valid, it peeks at `nextPos = origin + (0, offset(i+1), 0)`. The peek check **only** tests for air (`pal.IsAir(nextPos)`) and **never** consults `allow_water`. If `i == height - 1` OR `nextPos` is not air, traversal ends: `pos` is designated as the head position, and the loop breaks.
   - **Body block placement**: Otherwise, a weighted random pick over `body_blocks` selects a body block descriptor, which is placed at `pos`.
6. **Head block placement and age fallback**: If traversal breaks with a valid head position, a weighted random pick over `head_blocks` selects the head block.
   - If `age.max != 0`, the engine attempts to set the `growing_plant_age` state on the selected head block using the `age` value drawn in step 3.
   - **Fallback behavior**: If the selected head block has no `growing_plant_age` state definition at all (or if the drawn age is out of valid state bounds `[0, 25]`), the engine falls back gracefully and places the head block unchanged.
   - Returns the head block position on success.
7. **Column failure condition**: The loop only reaches failure if **every** position in the configured height column fails `positionOk`. A single valid position anywhere in the column guarantees that traversal breaks and a head block is placed.

::: note
**Water check vs Peek check**: While `allow_water: true` allows body blocks and head blocks to place in existing water blocks, the lookahead peek for `nextPos` strictly checks `pal.IsAir(nextPos)`. Therefore, growing through water into another water block will treat each water layer as non-air during lookahead, causing column growth to terminate early at the first water block and place the head block there.
:::

## Example

```json title="growing_plant_feature -- cave vines growing down with age range 17..25"
{
  "format_version": "1.21.110",
  "minecraft:growing_plant_feature": {
    "description": { "identifier": "wiki:cave_vines" },
    "height_distribution": [
      [[1, 13], 2],
      [[2, 7], 3],
      [[3, 5], 1]
    ],
    "growth_direction": "down",
    "body_blocks": [
      ["minecraft:cave_vines", 1]
    ],
    "head_blocks": [
      ["minecraft:cave_vines", 1]
    ],
    "age": { "range_min": 17, "range_max": 25 },
    "allow_water": false
  }
}
```

Running this feature in a `void` environment with seed `1` and origin `(0, 10, 0)` generates a 12-block downward cave vine column, from the origin at `Y 10` down to `Y -1`:

![Cave vines growing downward in open space, rendered by featurelab's voxel viewer](./images/growing-plant-feature-cave-vines.png)

```
featurelab generate --pack <pack> --feature wiki:cave_vines --env void --seed 1 --origin 0,10,0
```

## Field reference

| Field | Required | Shape | Bounds / Values | Default |
|---|---|---|---|---|
| `height_distribution` | yes | array of `[[min, max], weight]` | min 1 entry | — |
| `growth_direction` | yes | string | `"up"` or `"down"` | — |
| `body_blocks` | yes | array of `[block_descriptor, weight]` | min 1 entry | — |
| `head_blocks` | yes | array of `[block_descriptor, weight]` | min 1 entry | — |
| `age` | no | IntRange — number, 2-element `[min, max]` array, or `{range_min, range_max}` object | `[0, 25]` valid state range | `{ "range_min": 0, "range_max": 0 }` |
| `allow_water` | no | boolean | `true` or `false` | `false` |

### `height_distribution`
An array of weighted height range tuples. Each entry specifies a height range `[min, max]` (or a single number / object) and a floating-point selection weight.

### `growth_direction`
Controls the vertical direction of growth. `"up"` increments Y for each layer; `"down"` decrements Y.

### `body_blocks` and `head_blocks`
Weighted lists of block descriptors used for the stem (body) and tip (head) of the growing plant column.

### `age` and head block fallback
`age` is optional. When present and `age.max > 0`, the engine injects the drawn age integer into the head block's `growing_plant_age` state (valid values 0 to 25). If the head block descriptor points to a block type that does not possess the `growing_plant_age` state property, the state cannot be set and the game falls back to placing the head block unchanged.

### `allow_water`
When `true`, permits placement in existing water blocks in addition to air blocks.

## See also

- [Single Block Features](./single-block-feature.md) — simple single-block placement without column expansion.
- [Vegetation Patch Features](./vegetation-patch-feature.md) — places ground/ceiling patches and optionally delegates to vegetation placement features.
