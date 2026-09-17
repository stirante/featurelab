# Multi Block Features

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically. Worldgen internals move between releases; nothing here should be assumed to hold for a different version without checking. This feature type is **new in this version** — earlier versions do not have it at all.

`minecraft:multi_block_feature` places a **multi-block**: a custom block whose `minecraft:multi_block` block trait makes one logical block occupy two, three or four cells in a straight line. You give it the multi-block's *starting part* in `places_block`, and the feature stamps the entire line of parts in one placement — every cell filled, every cell knowing which part of the whole it is.

It does not delegate to another feature. It is the multi-block counterpart of [Single Block Features](./single-block-feature.md): same `places_block`/`may_replace`/`randomize_rotation` vocabulary, but the thing being placed is bigger than one cell and the engine refuses to place it partially.

## The block comes first: the `minecraft:multi_block` trait

This feature can only place blocks that declare the trait in the behaviour pack's own `blocks/**/*.json`. No vanilla block qualifies — a multi-block is always a pack-defined custom block. The trait looks like this:

```json title="blocks/totem.json -- a three-part vertical block"
{
  "format_version": "1.26.50",
  "minecraft:block": {
    "description": {
      "identifier": "wiki:totem",
      "traits": {
        "minecraft:multi_block": {
          "enabled_states": ["minecraft:multi_block_part"],
          "parts": 3,
          "direction": "up"
        }
      }
    },
    "components": { }
  }
}
```

The trait adds a `minecraft:multi_block_part` block state to the type, with exactly `parts` legal values: `0` is the **starting part**, and the rest number the cells outward along `direction`.

| Trait field | Required | Default | Notes |
|---|---|---|---|
| `enabled_states` | **yes** | — | Must be exactly `["minecraft:multi_block_part"]` — one entry, that entry. Anything else disables the trait with a content-log complaint. |
| `parts` | no | `2` | How many cells the block occupies. **2 to 4.** |
| `direction` | no | `"up"` | Which way parts 1..n-1 extend from the starting part: `up`, `down`, `north`, `south`, `east` or `west`. |

::: note
**An invalid `direction` does not fall back to `"up"` — it disables the whole trait.** The block then loads as an ordinary one-cell block, and any `multi_block_feature` naming it fails every placement. The content log line is `Invalid value for 'direction': ...`; if you see it, the block is not a multi-block until you fix the spelling.
:::

## `places_block` must name the starting part

A plain block name is the normal, correct thing to write: the block's default permutation *is* the starting part (`minecraft:multi_block_part` = 0). If you spell out states and set `minecraft:multi_block_part` to anything other than `0`, or if you name a block that is not a multi-block at all, the engine does **not** reject the file — it logs the complaint at load time (`Must place a multi-block in a 'minecraft:multi_block_feature'`, or `If trying to place a multi-block ... only the starting part may be used in field 'places_block'`) and quietly swaps in a placeholder. The feature then exists but fails **every** placement with `Invalid 'places_block'`.

::: note
A feature that "loads fine" and never places anything is the signature of this fallback. Check the content log for the two lines above before suspecting your placement rules.
:::

## Mechanics and placement sequence

Given an origin, the engine executes the following in exact order. There is at most **one** random draw. It happens before every check *except* the first one — the `places_block` validity check in step 1, which fails having drawn nothing at all. Past that point a rejected placement costs the same random number an accepted one does, so downstream features stay in sync either way; a feature whose `places_block` never resolved is the one case that does not draw.

1. **Validity check.** If `places_block` fell back to the placeholder above, placement fails (`Invalid 'places_block'`) having drawn nothing.
2. **Rotation draw** — only when `randomize_rotation` is in effect: one draw of four picks north, east, south or west, and the block is put through the engine's general block-state rotation before any part is written. This rotates *the block's facing*, not the line: the parts still extend along the trait's fixed `direction`. See [What the rotation actually turns](#what-the-rotation-actually-turns) below — it is more than `minecraft:cardinal_direction`.
3. **Replace check, per cell.** Walking from the origin outward along `direction`, every cell the line would occupy is examined first. A cell fails if it already holds **any** multi-block part (yours or another's — overlap is never allowed, even when `may_replace` would permit that block), or if `may_replace` is non-empty and the occupant is not in it. Any failing cell rejects the whole placement (`Target location does not contain a block from the replace list`) before a single block is written.
4. **Write, per cell.** The parts are stamped in order — origin gets part `0`, the next cell part `1`, and so on. If a cell cannot be written (it falls outside the generated area), the parts already written are **erased back to air** — not restored to what stood there — and the placement fails with `Block could not be placed`. A multi-block is never left half-placed.
5. **Success** returns the origin: the starting part's position.

### What the rotation actually turns

The rotation is not a `minecraft:cardinal_direction` rewrite with a special case for this feature. It is the game's one general block-state rotation, the same one `single_block_feature` uses, and it is a flat list of **sixteen** directional state families with no dispatch between them:

`portal_axis`, `minecraft:cardinal_direction`, `minecraft:facing_direction`, `minecraft:block_face`, `direction`, `facing_direction`, `rail_direction`, `torch_facing_direction`, `ground_sign_direction`, `weirdo_direction`, `coral_direction`, `lever_direction`, `pillar_axis`, `vine_direction_bits`, `multi_face_direction_bits`, `orientation`.

Three things follow, and they are the things that surprise people:

- **Every family your block carries is turned, all of them, by the same draw.** If your `places_block` descriptor writes `pillar_axis` as well as having the cardinal state, both come out rotated. There is no "first match wins" between families.
- **Each one is set outright, not turned by a quarter.** The value written depends only on the draw; whatever the state held before is never read. You cannot express "rotate this by 90° from where it was".
- **Your `minecraft:multi_block_part` is left alone.** The part index is not one of the sixteen, so the line still numbers 0, 1, 2 outward from the origin exactly as it would unrotated.

A block carrying none of the sixteen comes back untouched, which is the ordinary case: a plain multi-block with only the cardinal state gets only that state turned.

::: note
For ten of the sixteen families the *direction* is exact, but the spelling the value is written under is taken from vanilla block definitions and less certain. If your `places_block` carries one of those, this tool says so at load time. `minecraft:cardinal_direction` — the one this feature always turns — is not among them.
:::

### `randomize_rotation` needs a facing to rotate

The rotation rewrites the block's `minecraft:cardinal_direction` state, so the block has to have one — which for a custom block means the `minecraft:placement_direction` trait with `"minecraft:cardinal_direction"` in *its* `enabled_states`. Setting `randomize_rotation: true` on a block without it does not fail the file: the engine logs `Block '...' does not have a cardinal direction state and cannot be randomly rotated.` at load time and switches the flag off — placements then proceed unrotated and draw nothing.

### `enforce_placement_rules` does nothing during world generation

The key parses and is stored, but the placement-rule hooks it gates are unconditional "yes" in the world-generation pathway, for every block, in this version. This is the same situation [Single Block Features](./single-block-feature.md) documents for its `enforce_*` pair. Set it or don't; worldgen output is identical.

## `format_version` gates this whole type

The engine keeps a separate schema per `format_version` band, and this type belongs to the
**1.26.40** band and newer. Two consequences, which are really one:

- A file declaring an older `format_version` cannot name `minecraft:multi_block_feature` at all.
  The schema it is matched against has no such type, so the file does not load.
- Every key below — including the required `places_block` — is registered only in that band and
  newer, so there is no version at which the type is known but its keys are not.

The practical advice is simply: give the file a current `format_version`.

## Example

```json title="multi_block_feature -- place the three-part totem"
{
  "format_version": "1.26.50",
  "minecraft:multi_block_feature": {
    "description": { "identifier": "wiki:totem_feature" },
    "places_block": "wiki:totem",
    "may_replace": ["minecraft:air"],
    "randomize_rotation": false
  }
}
```

Placed at an origin, this writes `wiki:totem` with `minecraft:multi_block_part` 0, 1, 2 at the origin and the two cells above it — provided all three cells hold air.

## Field reference

| Field | Required | Shape | Notes |
|---|---|---|---|
| `places_block` | **yes** | block descriptor | The multi-block's **starting part**. A plain name is correct; an explicit `minecraft:multi_block_part` other than 0, or a non-multi-block, makes every placement fail (see above). |
| `enforce_placement_rules` | no | boolean, default `false` | Parsed and stored; no effect during world generation in this version. |
| `randomize_rotation` | no | boolean, default `false` | One draw of four; turns every directional state the block carries (see [What the rotation actually turns](#what-the-rotation-actually-turns)), on every part. Requires the block to carry `minecraft:cardinal_direction`, else it is switched off at load with a warning. |
| `may_replace` | no | array of block descriptors | Cells the line may overwrite. Empty or absent means anything goes — except cells already holding a multi-block part, which always reject. |

## Coverage note

This page documents the engine. A few things belong to the **featurelab** bench used to illustrate it, not to Bedrock:

- The bench reads the `minecraft:multi_block` and `minecraft:placement_direction` traits from the loaded pack's own `blocks/**/*.json`. A multi-block defined anywhere else (another pack layer the bench was not pointed at) will look like a non-multi-block here and hit the `Invalid 'places_block'` path.
- A `parts` value outside 2–4 violates the trait's declared range; exactly how the game handles that edge is not known with certainty, so the bench takes the conservative reading — it warns and treats the trait as disabled — rather than clamping to a value the author never wrote.
- Load-time complaints the game sends to the content log (the wrong-part, not-a-multi-block, and cannot-rotate lines) surface here as build warnings on the feature file, with the game's wording embedded.
- The game asks the block *type* whether it can ever carry a directional state; the bench asks the *permutation* your `places_block` descriptor actually resolved to. The two differ in one direction only, and it is the safe one: a state your block's traits enable but your descriptor never wrote is filled in for `minecraft:cardinal_direction` (the bench reads that from the trait) and otherwise left unrotated rather than guessed at.

## See also

- [Single Block Features](./single-block-feature.md) — the one-cell counterpart, and the fuller story on `enforce_*` keys being worldgen no-ops.
- [Multipart Block Column Features](./multipart-block-column-feature.md) — a column of *different* block roles along a direction; superficially similar, but its blocks are ordinary one-cell blocks.
- [Structure Template Features](./structure-template-feature.md) — for pre-authored shapes bigger than a straight line.
