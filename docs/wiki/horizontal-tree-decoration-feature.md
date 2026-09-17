# Horizontal Tree Decoration Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. Worldgen internals move between releases; nothing here should be assumed to hold for a different version without checking. This type is **new in this version** — 1.26.40.26 does not have it at all.

`minecraft:horizontal_tree_decoration_feature` is a **Content feature**: it places **one decoration block against a horizontal side of the block at the origin**. It picks one of the four compass directions at random, steps one block that way, and — if the checks below pass — places `places_block` there, oriented back-to-front with a `minecraft:cardinal_direction` state and given a random `growth` value.

It does not delegate to another feature, and it has one of the smallest JSON surfaces in the system: one required field and two optional booleans.

The name says what it is for: decorating **tree trunks sideways**. Vanilla's own petal-carpet family of blocks — `minecraft:pink_petals`, `minecraft:wildflowers`, `minecraft:leaf_litter` — are exactly the blocks that carry both states this feature requires, and a leaf-litter tuft placed against a fallen log is the picture to keep in mind. But nothing ties it to trees: any origin block works (unless you turn on `bark_side_only`, which asks the origin for a `pillar_axis`).

## The block must carry two specific states

Before doing anything else, the engine inspects `places_block`'s block type and requires it to carry **both** of these block states:

- `minecraft:cardinal_direction` — the placed decoration is turned to face the direction it was placed toward.
- `growth` — the placed decoration gets a random growth stage.

If either state is missing, the feature places nothing and writes a content log error naming the missing state:

```
'<block>' did not have the required block state 'cardinal_direction'.
'<block>' did not have the expected block state 'growth'.
```

This is a property of the block **type**, not of the states you write in the descriptor — listing `"states": { "growth": 0 }` on a block whose type has no growth state does not help. In practice this restricts `places_block` to the petal-carpet family above (or a custom block that declares both states).

## Mechanics and placement sequence

Given an origin, the engine executes the following in exact order. The two random draws are called out because their order is the determinism contract: a placement that fails after step 2 has still consumed the first draw, and only a fully successful placement consumes the second.

1. **State check.** The two required block states above are verified. Failure logs and stops, having drawn **nothing**.
2. **Direction draw** — one of the four horizontal directions (north, south, west, east), uniformly. The **target cell** is one step from the origin in that direction, at the same height.
3. **Empty check.** The target cell must be air. (Water does not count — a submerged trunk side refuses.) The result is remembered but acted on together with the checks below.
4. **Adjacency check** (skipped when `allow_adjacent` is true). Ten positions are probed, and if **any** of them already holds a block of the same type as `places_block`, the placement refuses: the four horizontal neighbours of the *origin*, then all six neighbours of the *target cell*. This is what keeps decorations from clustering — without it, repeated placements along a trunk would stack tufts side by side and on top of each other.
5. **Bark check** (only when `bark_side_only` is true). The block at the *origin* must carry a `pillar_axis` state — if its type has none (dirt, stone, …), the placement refuses outright. If the log lies along **x**, the two x-facing sides (west/east) are its cut ends, and a draw of west or east refuses; if it lies along **z**, north/south refuse likewise. A vertical log (`pillar_axis: y`) shows bark on all four sides and never refuses here.
6. **Growth draw** — the decoration's `growth` state, **0 or 1**, uniformly. Note the narrow range: the `growth` state itself spans a wider domain, but this feature only ever places stage 0 or stage 1 (one or two petals/tufts).
7. **Write.** `places_block` is placed at the target cell with `minecraft:cardinal_direction` set to the drawn direction's name and `growth` set to the drawn value, on top of whatever other states your descriptor specified. The write is unconditional — no replace-list, no survivability rules: whatever the empty check accepted is simply overwritten.

Every refusal in steps 3–6 is **silent** — no content log, no message. Only the state check in step 1 speaks.

::: note
The direction draw comes **first**, before any world inspection. A placement that refuses because the drawn side happened to be blocked does *not* retry another side — one draw, one attempt. If you scatter this feature along a trunk, expect roughly the failure rate the local geometry implies, not a search for a free side.
:::

### `allow_adjacent`

Defaults to **false**, i.e. the ten-probe spacing rule above is active. Set it to true to allow decorations to touch each other (and the origin's other sides). Note the probes match on block *type* — a `pink_petals` with different states still counts as adjacent `pink_petals`.

### `bark_side_only`

Defaults to **false**. Turn it on when decorating **fallen (horizontal) trunks**, so tufts only appear along the bark and never hang off the sawn ends. It costs nothing on vertical logs, but remember that with it enabled the origin block must genuinely have a `pillar_axis` state — decorating anything that is not a pillar-family block will refuse every time.

## Example

```json title="horizontal_tree_decoration_feature -- leaf litter against a fallen log"
{
  "format_version": "1.21.110",
  "minecraft:horizontal_tree_decoration_feature": {
    "description": { "identifier": "wiki:log_leaf_litter" },
    "places_block": "minecraft:leaf_litter",
    "bark_side_only": true
  }
}
```

Run against an origin inside a horizontal log, this places a one- or two-segment leaf litter tuft on a random bark side of that log — or nothing, if the drawn side is blocked, already decorated, or the log's end.

A single call places at most one tuft, so the picture worth looking at is a whole trunk's worth of them. This one lays a seven-block oak trunk along **x** (`pillar_axis: x`) and then runs the feature above once per trunk block, at feature seed `1`:

![A fallen oak trunk with leaf litter tufts along its north and south sides, rendered by featurelab's voxel viewer](./images/horizontal-tree-decoration-feature-fallen-log.png)

Two of this page's rules are visible in it. Every tuft sits on a **north or south** side: `bark_side_only` refuses the two x-facing faces of an x-axis log, so the roughly half of the draws that came up west or east placed nothing. And the tufts do not touch — seven attempts produced five tufts, the rest refused by the ten-probe adjacency rule, which is exactly the spacing that rule exists to create.

## Field reference

| Field | Required | Shape | Default | Notes |
|---|---|---|---|---|
| `places_block` | **yes** | block descriptor | — | Must be a block whose type carries `minecraft:cardinal_direction` **and** `growth` (see above). |
| `allow_adjacent` | no | boolean | `false` | When false, refuses if a same-type block touches the origin horizontally or the target cell on any side. |
| `bark_side_only` | no | boolean | `false` | When true, the origin block must have a `pillar_axis` state, and the decoration never places against the pillar's two end faces. |

## Coverage note

This page documents the engine. Three things belong to the **featurelab** bench used to illustrate it, not to Bedrock:

- The bench has no per-block-type state registry, so it **cannot evaluate step 1**: it assumes `places_block` carries both required states, places it with both set, and says so in a build-time warning. Pointing it at a block the real engine would refuse (with the content log errors above) will place blocks here that the game would not place.
- For the same reason, step 5's "does the origin block's type have `pillar_axis` at all" question is approximated: the bench reads the `pillar_axis` state of the block actually at the origin. When that state is present its value is honoured exactly; when absent, the bench assumes `pillar_axis: y` (every vanilla log's default) and emits a warning — the real engine would instead refuse if the block type truly has no such state.
- "The target cell must be air" stands in for the engine's material-level emptiness test. For every block the bench models the two agree.

## See also

- [Tree Features](./tree-feature.md) — grows the trunks this type decorates, including the `fallen_trunk` shape `bark_side_only` is clearly designed around.
- [Multiface Features](./multiface-feature.md) — the other "grow something against a block face" type, for vines/lichen-style multi-face blocks.
- [Single Block Features](./single-block-feature.md) — placing one block with full placement/survivability rule enforcement instead of this type's fixed checks.
