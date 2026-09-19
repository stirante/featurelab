---
title: Multi block
description: minecraft:multi_block_feature stamps a custom block that occupies two, three or four cells in a line as its complete set of parts, all or nothing. Every key in a table, the block trait that has to come first, what randomize_rotation really turns, and the two load-time complaints behind a feature that places nothing — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:multi_block_feature
category: content
game: 1.26.50.24
scope: game
---

# Multi block

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:multi_block_feature` places a custom block that occupies two, three or four cells in a straight line, writing every one of its parts in a single placement.** You reach for it for anything your pack defines that is taller or longer than one cell and has to be whole: a totem, a standing stone, a two-block statue, a chimney. You name its *starting part* and the feature stamps the entire line, every cell knowing which part of the whole it is.

It delegates to nothing and it is the multi-block counterpart of [single block](./single_block_feature.md): the same `places_block` / `may_replace` / `randomize_rotation` vocabulary, applied to something bigger than one cell — and refused outright rather than written partially when any cell of the line will not take it.

Two things need saying before anything else. **This type only ever places a block your own pack defines**: no vanilla block is a multi-block, so the block and its trait have to exist before the feature can do anything — see [the block comes first](#the-block). And a feature whose `places_block` is wrong does not fail to load; it loads and then fails every single placement, which is the one symptom to learn.

## Start here: a complete example

Two files, both complete: a three-part totem block, and the feature that places it. The block goes in the pack's `blocks/` directory, not its `features/` one.

::: code-group

```json [blocks/totem.json]
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
    "components": {}
  }
}
```

```json [features/totem_feature.json]
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

:::

What each choice buys you:

- **`parts: 3` and `direction: "up"`** on the *block* decide the shape. The feature has no say in either: it cannot stretch the line, shorten it or turn it.
- **`places_block: "wiki:totem"`, a plain name with no states**, is the correct and normal thing to write. A block's default permutation *is* its starting part, and spelling the part out is how this goes wrong — see [`places_block`](#places-block).
- **`may_replace: ["minecraft:air"]`** makes the whole line refuse unless all three cells are open. Leaving the key out lets it overwrite anything, which for a three-cell line is usually not what you want.
- **`format_version: "1.26.50"`** on the feature file matters: this type does not exist in schemas older than 1.26.40, and a file declaring an older version cannot name it at all. See [`format_version`](#format-version).

```
featurelab generate --pack <pack> --feature wiki:totem_feature --env plains --seed 1 --origin 0,70,0
```

Run with the origin at `(0, 70, 0)` — open air above the plains surface — this changes **3 cells**: `wiki:totem` with `minecraft:multi_block_part` `0` at `(0, 70, 0)`, part `1` at `(0, 71, 0)` and part `2` at `(0, 72, 0)`. The call hands back `(0, 70, 0)`, the starting part's own position, not the end of the line.

::: tip All three cells, or none of them
Move the same origin to `(0, 90, 0)` in the default 48-block-tall bench volume, where the third part would fall outside it, and **0 cells change**. Not two cells and a warning — zero. The parts already written are erased before the placement reports failure, so a multi-block is never left half-built. Worth knowing when a feature places nothing near the top or the edge of a chunk.
:::

## Fields

Four keys, all on the feature body, and that is the entire type. "Default" is what the game uses when the key is absent. The long-form account of every key, in the editor's own words, is the [field reference](#field-reference) further down.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `places_block` | **yes** | block descriptor | — | The multi-block's **starting part**. A plain name is correct. Anything else — a part index other than `0`, or a block without the trait — loads with a complaint and then fails every placement. See [`places_block`](#places-block). |
| `may_replace` | no | array of block descriptors | anything | The blocks every cell of the line may overwrite. Absent or empty means no constraint. A cell already holding **any** multi-block part always refuses, whatever this says. |
| `randomize_rotation` | no | boolean | `false` | Turns the block to a random one of the four horizontal directions before writing it — the same turn on every part. The line's direction is unaffected. Needs the block to carry a cardinal-direction state. See [rotation](#rotation). |
| `enforce_placement_rules` | no | boolean | `false` | Parses and is stored, and does nothing during world generation in this version. Set it or leave it out; the output is identical. |

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `places_block` naming a vanilla block | It is not a multi-block, so the file loads and **every** placement fails with `Invalid 'places_block'`. | Define a block with the `minecraft:multi_block` trait and name that. |
| `places_block` spelling out `"minecraft:multi_block_part": 1` | The same: only the starting part may be named. The complaint is `If trying to place a multi-block ... only the starting part may be used in field 'places_block'`. | Write the plain block name; its default permutation is part `0`. |
| A trait with `"parts": 5` | Out of the 2–4 range, so the **trait** is disabled — and the feature then reports a block that "is not a multi-block". | Split it into something four cells or shorter, or use a [structure template](./structure_template_feature.md). |
| A trait with `"direction": "upward"` | Not one of the six names, so the trait is disabled. It does **not** fall back to `up`. | One of `up`, `down`, `north`, `south`, `east`, `west`. |
| A feature that loads cleanly and never places anything | The signature of the `places_block` fallback above. The two complaints are on the *block*, at load time, not on the placement. | Read the load-time log before suspecting your placement rules. |
| `randomize_rotation: true` on a block with no cardinal-direction state | Not an error: the flag is switched **off** when the file loads, with a complaint, and placements run unrotated. | Give the block the `minecraft:placement_direction` trait with `"minecraft:cardinal_direction"` in its `enabled_states`. |
| Expecting `randomize_rotation` to turn the *line* | It turns the block's facing. The parts still extend along the trait's fixed `direction`. | If you need lines in different directions, define a block per direction. |
| Expecting `randomize_rotation` to turn a block by 90° from where it was | Each directional state is **set** outright from the roll; whatever it held before is never read. | There is no way to express a relative turn here. |
| Two multi-blocks whose lines cross | The second refuses the whole placement, even when `may_replace` lists the first one's block. Overlap is never allowed. | Space them, or place them from one feature that controls the spacing. |
| `may_replace` left out, near the ground | Every cell of the line overwrites whatever it lands on, terrain included. | List what it may replace — `["minecraft:air"]` for a line that needs open space. |
| A line that would leave the generated area | **Nothing** is placed, and the cells already written are erased back to air rather than restored. | Keep the origin far enough inside the area for the whole line. |
| `"format_version": "1.21.110"` on the feature file | The type does not exist in that schema, so the file does not load at all. | `1.26.40` or newer. See [`format_version`](#format-version). |

## How it runs

1. **Check `places_block`.** If it fell back to the placeholder — because the block is not a multi-block, or the part named was not the starting one — the placement fails with `Invalid 'places_block'` and nothing else happens.
2. **Roll the rotation**, when `randomize_rotation` survived loading: one of north, east, south or west, applied to the block's directional states before any cell is written. This happens *before* every check below, so a placement that later fails has still rolled it.
3. **Work out the line.** The trait's `direction` and `parts` give the cells: the origin, then one step along `direction` per further part.
4. **Check every cell first.** A cell refuses if it already holds any multi-block part — yours or another's — or if `may_replace` is non-empty and what is there is not in it. One refusing cell rejects the whole placement with `Target location does not contain a block from the replace list`, before anything is written.
5. **Write the parts in order**: part `0` at the origin, part `1` at the next cell, and so on. All of them carry the same rotation; only the part index differs.
6. **Roll back on a failed write.** A cell that cannot be written — outside the generated area — erases every part already written back to **air**, not back to what was there, and the placement fails with `Block could not be placed`.
7. **Succeed**, handing back the origin: the starting part's position.

## The block comes first: the `minecraft:multi_block` trait {#the-block}

This feature can only place blocks that declare the trait, in your own pack's `blocks/**/*.json`. **No vanilla block qualifies** — the trait is the only thing in the game that makes a block a multi-block, and nothing shipped with the game carries it. The trait adds a `minecraft:multi_block_part` state to the block, with exactly `parts` legal values: `0` is the starting part and the rest number outward along `direction`.

| Trait field | Required | Value | Default | What it does |
|---|---|---|---|---|
| `enabled_states` | **yes** | array with exactly one entry | — | Must be exactly `["minecraft:multi_block_part"]`. One entry, that entry: any other list disables the trait. |
| `parts` | no | whole number, **2 to 4 inclusive** | `2` | How many cells the block occupies. A value outside that range, or a fractional one, disables the trait. |
| `direction` | no | `up`, `down`, `north`, `south`, `east` or `west` | `"up"` | Which way parts `1`…`n−1` extend from the starting part. Matched without regard to case, so `"UP"` works. |

::: warning A trait that fails to validate does not fall back — it switches itself off
An invalid `direction`, a `parts` outside 2–4, a wrong `enabled_states`: none of them is corrected to the default. The trait is **disabled**, the block loads as an ordinary one-cell block, and any `multi_block_feature` naming it then fails every placement with `Invalid 'places_block'`. The complaint appears when the *block* loads — `Invalid value for 'direction': ...` is the one to search for — and not when the feature does.
:::

## `places_block` names the starting part, and nothing else {#places-block}

Write the plain block name. A block's default permutation carries `minecraft:multi_block_part` `0`, which is the starting part, so a bare name is already right and is the only spelling that cannot go wrong.

Two ways to get it wrong, and they behave identically:

- **Naming a block that is not a multi-block** — a vanilla block, or one of your own whose trait failed to validate. The complaint is `Must place a multi-block in a 'minecraft:multi_block_feature'`.
- **Spelling out a part index other than `0`.** The complaint is `If trying to place a multi-block in a 'minecraft:multi_block_feature' only the starting part may be used in field 'places_block'`.

In both cases the file is **not** rejected. A placeholder is substituted, the feature loads, and every placement it is ever asked for fails with `Invalid 'places_block'`. A feature that loads cleanly and never places anything is nearly always this.

## Rotation: what `randomize_rotation` actually turns {#rotation}

With `randomize_rotation: true`, one of the four horizontal directions is picked and applied to the block before it is written — the **same** direction for every part of the line, so the parts never disagree.

What it is not:

- **It is not a rewrite of one state.** It is the game's one general block-state rotation, shared with [single block](./single_block_feature.md#rotation), and it is a flat list of **sixteen** directional state families with no dispatch between them: `portal_axis`, `minecraft:cardinal_direction`, `minecraft:facing_direction`, `minecraft:block_face`, `direction`, `facing_direction`, `rail_direction`, `torch_facing_direction`, `ground_sign_direction`, `weirdo_direction`, `coral_direction`, `lever_direction`, `pillar_axis`, `vine_direction_bits`, `multi_face_direction_bits`, `orientation`. **Every one of them your block carries is turned**, by the same roll. There is no first-match-wins.
- **It is not a relative turn.** Each state is set outright from the roll; the value it held before is never read. "Rotate this by 90° from where it was" cannot be expressed.
- **It does not touch `minecraft:multi_block_part`.** The part index is not one of the sixteen, so the line still numbers `0`, `1`, `2` outward from the origin exactly as it would unrotated.
- **It does not turn the line.** `direction` belongs to the trait and is fixed; a totem whose parts go up goes up whichever way it faces.

A block carrying none of the sixteen comes back untouched, which is the ordinary case for a simple multi-block.

### It needs a facing to turn {#rotation-requires-a-facing}

The rotation rewrites the block's `minecraft:cardinal_direction` state, so the block has to have one — which for a custom block means the `minecraft:placement_direction` trait with `"minecraft:cardinal_direction"` in *its* `enabled_states`:

```json
"traits": {
  "minecraft:multi_block": {
    "enabled_states": ["minecraft:multi_block_part"],
    "parts": 2,
    "direction": "up"
  },
  "minecraft:placement_direction": {
    "enabled_states": ["minecraft:cardinal_direction"]
  }
}
```

Setting `randomize_rotation: true` without it does not fail the file. The flag is switched **off** when the file loads, with the complaint `Block '...' does not have a cardinal direction state and cannot be randomly rotated.`, and placements then run unrotated.

## `enforce_placement_rules` does nothing during world generation {#enforce}

The key parses and is stored, and the checks it gates answer "yes" unconditionally in the world-generation path, for every block, in this version. This is the same situation [single block](./single_block_feature.md#enforce-keys) documents for its own pair of `enforce_*` keys. Setting it changes nothing about what is written.

## Your `format_version` decides whether this type exists {#format-version}

The game keeps a separate schema per `format_version` band, and this type belongs to the **1.26.40** band and newer. Two consequences, which are really one:

- A file declaring an older `format_version` cannot name `minecraft:multi_block_feature` at all: the schema it is matched against has no such type, so the file does not load.
- Every key above is registered only in that band and newer, so there is no version at which the type is known but its keys are not.

The practical advice is simply to give the file a current `format_version`. Note that this is a statement about the *file's declared version*, not about the game: the type itself is new in 1.26.50.24 and does not exist in 1.26.40.26 whatever a file declares.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default) the editor's forms are built from. The [table above](#fields) is the summary.

<!--@include: ../generated/fields/multi_block_feature.md-->

## New in 1.26.50.24 {#new-in-this-version}

This type does not exist in 1.26.40.26 — not with different behaviour, not under another name: the game has no such feature type, and neither does it have the `minecraft:multi_block` block trait the type depends on. Both arrived together in 1.26.50.24. It is one of three feature types new in this version, alongside `minecraft:multipart_block_column_feature` and `minecraft:horizontal_tree_decoration_feature`.

Microsoft's public reference documented this type before the game had it, which is why a pack written against the reference alone may contain files that never worked.

## What the bench does differently

This page documents the game. Four things belong to the **featurelab** bench used to illustrate it:

- **The bench reads the `minecraft:multi_block` and `minecraft:placement_direction` traits from the loaded pack's own `blocks/**/*.json` only.** A multi-block defined in another pack layer the bench was not pointed at looks like an ordinary block here and takes the `Invalid 'places_block'` path.
- **A `parts` value outside 2–4 is treated conservatively.** That is a violation of the trait's declared range and exactly what the game does with one is not known, so the bench warns and disables the trait rather than clamping to a value the author never wrote.
- **The block-trait complaints appear in `featurelab check`, not in `featurelab generate`.** The wrong-part, not-a-multi-block and cannot-rotate lines surface as build warnings on the file that caused them, with the game's own wording embedded; `generate` shows only the resulting `Invalid 'places_block'` at placement time. Run `check` first when a multi-block places nothing.
- **Ten of the sixteen rotation families have an exact direction but a less certain spelling.** The value each rotated state is written under is taken from vanilla block definitions rather than from the game's own table. A `places_block` carrying one of those states is flagged when the file loads. `minecraft:cardinal_direction` — the one this feature always turns — is not among them. The bench also asks the *permutation* your descriptor resolved to whether it carries a directional state, where the game asks the block *type*; the two differ only in the safe direction, leaving a state unrotated rather than guessing at one.

## Advanced: what this type costs the random stream {#random-draws}

You do not need this section to use a multi block feature. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

The whole accounting is one row:

| `randomize_rotation` | Cost | Which kind |
|---|---|---|
| absent, `false`, or switched off at load for want of a cardinal state | 0 | Nothing is rolled. |
| in effect | **1** | One raw unsigned draw with a bound of 4. |

It is spent **before every check except the first**. The `places_block` validity check in step 1 fails having drawn nothing at all; past that point a rejected placement costs exactly what an accepted one does, so a line refused by `may_replace`, a line that would leave the area, and a line that went down all leave the stream in the same place. A feature whose `places_block` never resolved is the one case that does not draw — and it is a permanent property of that feature, not a per-position one, so it does not put a pack out of step from one placement to the next.

The draw maps to a direction as `0 → north`, `1 → east`, `2 → south`, `3 → west`, and the resulting direction is then pushed through the sixteen-family rotation described [above](#rotation): every family the block carries is set, cumulatively, from that one value.

Part `i`'s position is `origin + offset(direction) × i`, where `offset` is the trait's fixed facing step — so parts run `0`, `1`, `2` outward from the origin and the returned position is always part `0`'s. The write itself is a plain bounds-checked write with no on-place hook and no delayed-placement queue; that queue belongs to live gameplay and is never reached from world generation.

## See also

- [Single block feature](./single_block_feature.md) — the one-cell counterpart, the same `places_block` vocabulary, the fuller account of the sixteen-family rotation, and the same finding about the `enforce_*` keys being world-generation no-ops.
- [Multipart block column feature](./multipart_block_column_feature.md) — a column of *different* block roles along a direction. It looks similar and is not: its blocks are ordinary one-cell blocks and it has no all-or-nothing rule.
- [Structure template feature](./structure_template_feature.md) — for a pre-authored shape that is more than a straight line.
- [Scatter feature](./scatter_feature.md) — the usual way to place several of these across an area, and the page that explains why the spacing matters when overlap is never allowed.
- [Feature rules](./feature_rules.md) — how any of this reaches a world: a feature file is inert until a rule attaches it to the chunks of the biomes it belongs in.
- [RNG and determinism](./rng_and_determinism.md) — the model the rotation roll above fits into.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24** specifically. There is no companion claim for 1.26.40.26, because [the type does not exist there](#new-in-this-version).

The trait's field list and its ranges, the disable-rather-than-default rule for an invalid `direction` or `parts`, the two `places_block` complaints and the placeholder behind them, the sixteen rotation families and their absolute-set semantics, the untouched part index, the overlap rule, the all-or-nothing write with its erase-to-air rollback, and the `enforce_placement_rules` no-op are stated as facts about the game.

The example and every behaviour on this page were run end to end against `featurelab generate` from the files printed above, extended with one block per case: a three-part `up` totem placing parts `0`, `1` and `2` at `(0, 70, 0)`, `(0, 71, 0)` and `(0, 72, 0)`; a four-part `east` totem placing them at `(0, 70, 0)` through `(3, 70, 0)`; a two-part totem carrying the `minecraft:placement_direction` trait, which with `randomize_rotation: true` came back with `minecraft:cardinal_direction` `east` on **both** parts and the part index untouched; the same block with the trait's `direction` written `"UP"`, which placed identically and is what pins the case-insensitive match; the same feature without the `placement_direction` trait, which loaded with the cannot-rotate complaint and placed unrotated; a `parts: 5` block and an `"upward"` block, both of which `featurelab check` reported at the *block* file and whose features then failed every placement; two multi-blocks run from one aggregate at the same origin, where the second was refused entirely; and the same feature at `(0, 90, 0)` against the 48-block-tall bench volume, which changed zero cells rather than two. These files are printed on this page rather than committed to the fixture pack, which has no `blocks/` directory of its own.

What is uncertain is collected in [what the bench does differently](#what-the-bench-does-differently): the out-of-range `parts` reading, the ten rotation families whose value spelling is inferred, and the bench's permutation-rather-than-type question about directional states.
