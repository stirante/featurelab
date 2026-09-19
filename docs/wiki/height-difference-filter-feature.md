# Height Difference Filter Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. This feature type's JSON surface — every key, its bounds and its required/optional status — and its behaviour are unchanged between 1.26.40.26 and 1.26.50.24, so the page describes both versions. Worldgen internals move between releases; nothing here should be assumed to hold for a different build without checking.

`minecraft:height_difference_filter_feature` is a **Proxy feature**: it acts as a spatial terrain gate that evaluates surface height variation around the origin before delegating to `places_feature`.

::: important
**This feature type makes NO RNG calls.** It is a pure, deterministic gate — not a placer. It does not alter coordinates or draw from the random stream. If the terrain height condition is satisfied, it delegates to `places_feature` with the exact, unmodified origin; if unsatisfied, it silently returns without placing anything.
:::

## How the height gate works

Given a placement context, `Place` executes as follows:

1. **Feature resolution**: Resolves `places_feature`. If the referenced feature does not exist, logs `` `height_difference_filter_feature` could not find feature `places_feature`. `` and fails.
2. **Gate evaluation**:
   - If `search_radius < 1`, passes if and only if neither `min_required_upward_height_diff` nor `max_allowed_upward_height_diff` is set.
   - Scans outward along the four horizontal cardinal directions (North, East, South, West) for steps `1` through `search_radius`.
   - At each step position $(x, z)$, queries the surface height $h = \text{GetHeight}(x, z)$.
   - **Hard failure checks** (aborts immediately if violated by any column):
     - If `min_required_downward_height_diff` is set and $\text{min\_down} + \text{origin.Y} < h$, returns `false`.
     - If `max_allowed_downward_height_diff` is set and $\text{origin.Y} - \text{max\_down} > h$, returns `false`.
   - **Accumulated upward checks** (each needs only one satisfying column anywhere in the scan):
     - The **upward-minimum** check passes once at least one column satisfies $\text{min\_up} + \text{origin.Y} \le h$.
     - The **upward-bound** check passes once at least one column satisfies $\text{origin.Y} - \text{max\_up} \ge h$.
     - Fields that are omitted are considered automatically satisfied (`true`).
   - Returns `true` if both of those checks hold.
3. **Delegation**: If the gate returns `true`, delegates to `places_feature` at the unmodified origin. If `false`, silently returns `nil` (0 blocks placed, 0 logs in the engine).

## Worked example: why zero blocks place on flat plains

Consider this configuration requiring a minimum upward height difference of 3 blocks within a search radius of 4:

```json title="height_difference_filter_feature -- requiring slope/cliff elevation change"
{
  "format_version": "1.21.110",
  "minecraft:height_difference_filter_feature": {
    "description": { "identifier": "wiki:height_diff_gate" },
    "places_feature": "wiki:pumpkin_patch_block",
    "search_radius": 4,
    "min_required_upward_height_diff": 3
  }
}
```

When executed on flat terrain (such as the `plains` environment preset, where the surface height is uniformly $h = 63$ across all surrounding columns and origin Y is 63):

- The upward threshold is $3 + 63 = 66$.
- Every sampled column within search radius 4 reports height $h = 63$.
- Because no column reaches $h \ge 66$, the upward-minimum check never passes.
- The gate returns `false` and the feature places **0 blocks**:

```
featurelab generate --pack <pack> --feature wiki:height_diff_gate --env plains --seed 1
```

```json
{
  "blocksChanged": 0,
  "blocksPlaced": 0,
  "diagnostics": [
    {
      "level": "warning",
      "message": "placement returned no result and wrote no blocks"
    }
  ]
}
```

::: note
**Zero blocks placed is correct behaviour on flat terrain.** If you test a height difference filter on flat ground and see zero blocks placed, the tool is not broken — the filter is performing as intended by rejecting flat terrain that lacks the required elevation change.
:::

## Field reference

| Field | Required | Shape | Bounds | Default |
|---|---|---|---|---|
| `places_feature` | yes | string (feature identifier) | non-empty | — |
| `search_radius` | yes | integer | none enforced — a fractional value truncates (`4.9` behaves as `4`) and a negative value loads without a diagnostic | — |
| `min_required_upward_height_diff` | no | integer | — | unconstrained |
| `min_required_downward_height_diff` | no | integer | — | unconstrained |
| `max_allowed_upward_height_diff` | no | integer | — | unconstrained |
| `max_allowed_downward_height_diff` | no | integer | — | unconstrained |

### `places_feature`
The identifier of the feature to delegate to when the height condition passes.

### `search_radius`
The distance in blocks scanned along North, East, South, and West axes from the origin column.

### Height difference constraints
- `min_required_upward_height_diff`: Minimum height elevation ($h \ge \text{origin.Y} + \text{diff}$) required in at least one sampled column.
- `min_required_downward_height_diff`: Hard limit; fails if any sampled column exceeds $\text{origin.Y} + \text{diff}$.
- `max_allowed_upward_height_diff`: Requires at least one sampled column to have $h \le \text{origin.Y} - \text{diff}$.
- `max_allowed_downward_height_diff`: Hard limit; fails if any sampled column has $h < \text{origin.Y} - \text{diff}$.

## See also

- [Surface Relative Threshold Features](./surface-relative-threshold-feature.md) — gates placement based on absolute depth below the surface.
- [Snap-to-Surface Features](./snap-to-surface-feature.md) — finds surface boundaries along a vertical column.
