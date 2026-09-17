# Underwater Cave Carver Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**.
This carver behaves identically in 1.26.40.26 and 1.26.50.24, so the page holds for
either. Worldgen internals do move between releases; nothing here should be assumed to hold for a
build outside those two without checking.

`minecraft:underwater_cave_carver_feature` is a **Carver feature**, and it is the odd one of the
three. The other two subtract: they overwrite terrain with `fill_with`, which is normally
`minecraft:air`, so the result is a hole. This one is built to leave a *flooded* cave under a sea,
and the blocks it writes — water, lava, magma, obsidian — are ordinary solid or liquid cells. A
run of it usually reports zero `blocksCarved` and thousands of `blocksReplaced`, because
`featurelab generate` counts a cell as carved only when what replaced it was air.

It shares its whole front door with the [Cave Carver](./cave-carver-feature.md): the same 17×17
neighbouring-chunk window, the same per-neighbour seed mixing, the same room-and-tunnel walk, the
same eight configuration fields with the same defaults. Read that page first — everything it says
about the per-chunk carve architecture, about `skip_carve_chance` counting *up* rather than down,
and about `height_limit`'s degenerate default applies here word for word. What is different is
everything that happens once a tunnel step has decided which cells its ellipsoid reaches, and
that is what this page is about.

## The ocean tag, and the fixture that proves it

**This carver asks the biome it is generating in whether it is tagged `ocean`, and if the answer
is no it gives up on the whole column.** Not on that one cell — on the entire remaining downward
run of that column. So a carver placed in a biome with no `ocean` tag writes nothing at all,
anywhere, no matter how well configured it is, and reports success while doing it.

The check stops being asked as soon as it succeeds once. The first position anywhere in the call
that finds the tag latches it for the rest of that placement, and no later cell asks again; until
then, every column that reaches the question and is refused is abandoned on the spot.

::: warning
**A biome with no `ocean` tag makes this feature silently inert.** This is the single most common
way to get nothing out of it, and it looks exactly like a broken feature: the file loads with no
diagnostics, `place()` reports success, and `blocksChanged` is `0`.

Measured with this page's own fixture, at the same seed, in the same solid-stone bench, changing
nothing but the biome's tags:

| Biome tags | Cells written |
|---|---|
| the bench's own default overworld/plains set | **0** |
| `ocean` (`--biome-tags ocean`) | **3,405** |

If you are testing one of these in `featurelab`, use the `ocean` environment preset (its biome
carries the tag) or pass `--biome-tags ocean` explicitly. If you are testing in a real world,
attach the rule to an ocean biome; a `feature_rule` pointed at a plains biome will run this
feature every chunk forever and never place a block.
:::

## Where it is allowed to write: the water line

The carver only ever touches positions **strictly below the dimension's sea level**, which is
**63** in the overworld. A cell at Y 63 or above is skipped before anything else about it is
considered — before the diggable test, before the ocean tag question, before any fill.

The sea level is not sampled per position. It is a single number the dimension carries, so the
water line is flat across the entire carve, and it does not follow the terrain: a seabed that
rises to Y 70 is simply out of reach, and a bench whose floor sits above 63 gets nothing.

::: note
This tool models the sea level as that flat 63 for every placement, which is what the overworld
really does — but a custom dimension with a different sea level is not modelled, and this bench
has no dimension concept to carry one. That is a limitation of the preview, not of the game.
:::

## The three depth bands

Below the water line, what gets written depends only on how deep the cell is, in three bands
defined as offsets from sea level. With the overworld's 63 they land on fixed rows:

| Cell's Y | What is written | RNG |
|---|---|---|
| **11 – 62** | `replace_air_with` if the cell is already air, otherwise `fill_with` | no draw |
| **exactly 10** | `minecraft:magma` on a draw below 0.25, otherwise `minecraft:obsidian` | **one draw** |
| **9 and below** | `minecraft:lava` | no draw |

The magma/obsidian row is one block thick — sea level minus 53, and nothing else — and the lava
band is everything from sea level minus 54 down. Neither is configurable: `fill_with` does not
apply to either of them, and there is no field that moves the offsets.

That draw on the magma row is the **only** per-cell RNG this carver spends, and it is the one
thing that makes it different from its two siblings in draw cadence rather than in outcome. The
base and Nether carvers write their cells without drawing anything; this one advances the stream
once for every cell that lands on that single row, so two otherwise identical carves diverge from
the first time one of them reaches Y 10.

This page's own fixture, at seed 3, produces all four blocks in one run: 2,728 water, 47 magma
and 47 obsidian (on Y 10 and no other row), and 146 lava below them.

::: note
**You will see more magma than one cell in four, and the reason is not the draw.** The draw
really is 25%, but `minecraft:obsidian` is on this carver's own diggable list and
`minecraft:magma` is not. A second ellipsoid crossing the same row therefore re-rolls every
obsidian cell it reaches and cannot touch a magma one, so repeated passes ratchet the finished
floor towards magma.

Measured over the same 60 seeds of this page's fixture: with `skip_carve_chance: 1` (every
neighbouring chunk carves, so ellipsoids overlap heavily) the finished result is **1,939 magma to
1,705 obsidian**, 53%. Raising `skip_carve_chance` to `30` so that most chunks skip and few
ellipsoids overlap brings it to **92 to 145**, 39% — the same draw, fewer second passes, and the
ratio moves back towards it.
:::

## `replace_air_with`, and why it is usually inert

`replace_air_with` is the ninth field, and the only one the other two carver types do not have.
It is the block written instead of `fill_with` when the cell being carved **is already air**.

Two things about that are easy to get backwards:

- The test is on the block that is *there now*, not on what the carve is about to leave behind.
  "Would otherwise be air" is the wrong reading — a solid cell that `fill_with` is about to turn
  into air still gets `fill_with`.
- The test only runs at all if at least one of the cell's four horizontal neighbours (north,
  south, west, east — Y is never varied) is inside the region being generated. At a chunk's edge
  during real generation that is a live constraint; inside a preview bench, at least one always
  is.

The practical consequence is that in an ordinary flooded seabed **`replace_air_with` never
fires**, because below sea level there is no air: everything is rock, sediment or water. This page's fixture with `replace_air_with` set to `minecraft:gold_block` produces the
same 2,968 cells at the same positions and not one gold block among them.

Where it earns its place is a seabed that already has open air in it — an air pocket left below
the water line by anything that ran earlier in the same chunk. Those cells get `replace_air_with`
and the solid ground around them gets `fill_with`, which is the only situation in which the two
values can produce a visible difference. Set both to `minecraft:water` unless you specifically
want that difference.

## What it will and will not dig

The diggable list is **not** the base carver's list with water added. It is a genuinely different
set, and it disagrees with the dry carver in both directions.

**It digs, and the dry carver does not:** `minecraft:water`, `minecraft:flowing_water`,
`minecraft:lava`, `minecraft:flowing_lava`, `minecraft:obsidian`, and **air** — so it will carve
straight through an existing cave, a lava pocket or an ocean column and rewrite them.

**It refuses, and the dry carver digs:** `minecraft:deepslate`, `minecraft:calcite`,
`minecraft:tuff`, `minecraft:packed_ice`, `minecraft:snow_layer`, and the iron and copper ore
family (`iron_ore`, `deepslate_iron_ore`, `raw_iron_block`, `copper_ore`, `deepslate_copper_ore`,
`raw_copper_block`).

Deepslate is the one that costs authors real time, because it is exactly what a deep seabed turns
into. Measured on the same bench at the same seed, with the ocean tag supplied so the gate above is
not what is being seen, and with nothing changed but the block the bench is made of:

| Bench material | Cave Carver | Underwater Cave Carver |
|---|---|---|
| `minecraft:stone` | 3,329 cells | 3,405 cells |
| `minecraft:deepslate` | 3,329 cells | **0 cells** |

The base carver does not notice the swap at all. The underwater carver stops entirely.

Both carvers also dig `minecraft:stone`, the dirt family, `minecraft:gravel`,
`minecraft:podzol`, `minecraft:grass_block`, `minecraft:mycelium`, `minecraft:dirt_with_roots`,
`minecraft:hardened_clay`, and the sand and sandstone families. The one remaining disagreement is
terracotta: where the dry carver's own entries are the sixteen **glazed** terracotta blocks, this
one's are the sixteen **plain** coloured ones. The two really do consult different families, and
this tool reproduces that disagreement rather than smoothing it over.

Anything not on the list is left completely untouched even where the carve geometry reaches it.

::: note
**Two things the base carver does at every carved cell, this one does not do at all.** It never
caps a sand column with sandstone, and it never relocates a grass block down onto the dirt below
it. Those two effects belong to the base carver's own per-cell behaviour, which this type replaces
outright rather than extending. A `grass_block` or a sand column inside an underwater carve is
simply overwritten.
:::

## Field reference

Nine fields, all optional to the game's own loader. The first eight are shared with the
[Cave Carver](./cave-carver-feature.md#field-reference) and behave identically — including
`height_limit`, whose real default of `0` clamps every carve down to just above the world floor
and is the second-most-common way to get an empty result out of one of these.

| Field | Required | Shape | Default |
|---|---|---|---|
| `fill_with` | no, but **set it** | block descriptor | none — those cells are left alone, see below |
| `replace_air_with` | no | block descriptor | none — those cells are left alone, see below |
| `width_modifier` | no | number or Molang expression string | `0.0` |
| `skip_carve_chance` | no | non-negative integer, exclusive upper bound | `0` — never skips |
| `height_limit` | no | integer | `0` — degenerate, clamps carving to the world floor |
| `y_scale` | no | number, 2-element `[min, max]` array, or `{range_min, range_max}` object | `{0, 0}` — room-only |
| `horizontal_radius_multiplier` | no | same three shapes | `{0, 0}` — room-only |
| `vertical_radius_multiplier` | no | same three shapes | `{0, 0}` — room-only |
| `floor_level` | no | same three shapes | `{0, 0}` — rooms and tunnels |

::: warning
**Set `fill_with` and `replace_air_with` explicitly on this type**, even though the loader does not
make you. Omit one and the cells that would have received it are simply left alone — the carve
still runs, still costs the same random draws, and still writes everything else, but that part of
the result is missing, which looks far more like "the carver did nothing here" than like "a field
is unset".

That skip is what the [Cave Carver](./cave-carver-feature.md) does for a missing `fill_with`, and
for that type it is known to be what the game does. For *this* type the write path is a different
one and the game's own behaviour with an omitted value has not been established, so treat the
preview as this tool's best answer rather than as a promise. Writing both fields makes the question
moot; `minecraft:water` for both is the ordinary answer.
:::

::: warning
**Range fields are spelled `range_min` / `range_max`.** `{ "min": …, "max": … }` is not rejected —
it logs an error and substitutes a zero-width `{0, 0}` range, which collapses the multipliers to
zero and makes the carver dig nothing while looking perfectly well-formed. `featurelab check`
refuses the wrong spelling per field rather than quietly accepting it. See the Cave Carver page's
own [note on this](./cave-carver-feature.md#field-reference) for the fields on other types that
genuinely do use `min`/`max`.
:::

## Example

```json title="underwater_cave_carver_feature -- a flooded cave network through a seabed"
{
  "format_version": "1.21.110",
  "minecraft:underwater_cave_carver_feature": {
    "description": { "identifier": "wiki:underwater_cave_demo" },
    "fill_with": "minecraft:water",
    "replace_air_with": "minecraft:water",
    "width_modifier": 0.0,
    "height_limit": 128,
    "skip_carve_chance": 1,
    "y_scale": { "range_min": 1.0, "range_max": 1.0 },
    "horizontal_radius_multiplier": { "range_min": 1.0, "range_max": 1.0 },
    "vertical_radius_multiplier": { "range_min": 0.7, "range_max": 1.4 },
    "floor_level": { "range_min": -1.0, "range_max": -0.7 }
  }
}
```

Run against this project's `ocean` environment preset with feature seed `3`, this writes 2,968
cells inside the origin's own 16×16 chunk column (world X/Z `0..15`), spanning world Y `2..50` —
2,728 water, 47 magma and 47 obsidian on world Y 10, and 146 lava below that:

![A cutaway of a stone seabed revealing a network of water-filled tunnels, with a band of magma, obsidian and lava at the bottom, rendered by featurelab's voxel viewer](./images/underwater-cave-carver-feature-flooded-tunnels.png)

```
featurelab generate --pack <pack> --feature wiki:underwater_cave_demo --env ocean --seed 3 --origin 0,48,0 --min-y 0 --size 32x64x32
```

::: note
The `--min-y 0 --size 32x64x32` on that command is not framing. The `ocean` preset's own default
bench starts at world Y 30, and this seed's ellipsoids reach down to Y 2 — so at the preset
default most of the carve falls outside the bench and is reported as thousands of out-of-bounds
writes rather than drawn. Dropping the floor to 0 and giving the volume 64 rows brings the whole
carve inside it (0 out-of-bounds writes) and still reaches the sea, which sits on top of the
seabed at around world Y 49–62.

Like the [Cave Carver](./cave-carver-feature.md#example) and [Ore](./ore-feature.md#example)
pages, the image is a cutaway: a cave sealed inside rock is fully face-occluded from outside, and
a water-filled cave is occluded exactly like an air-filled one. The slice is cut at world Y 27,
which is why the top face shows a floor-plan cross-section through the flooded network. The lava
and the magma/obsidian row are not in that cut plane at all — they are visible because the carve
runs flush to the bench's own edges, and a face at the edge of the preview is never occluded.
:::

## See also

- [Cave Carver Features](./cave-carver-feature.md) — the base carver, whose placement, room and
  tunnel routines this type inherits unchanged; read it for the per-chunk architecture and for
  the eight shared fields.
- [Nether Cave Carver Features](./nether-cave-carver-feature.md) — the third carver, which shares
  the front door and nothing else, and whose divergences are the opposite kind: it has fewer
  behaviours than the base carver where this one has more.
- [Feature Rules](./feature-rules.md) — how a carver reaches a world at all. Carvers are the only
  feature type accepted in the `pregeneration_pass`, and a carver placed by hand on
  already-generated terrain does nothing at all.

## Version and verification notes

Everything above holds for **1.26.50.24** and, because this type is behaviourally
identical between the two versions, for 1.26.40.26 as well. Note that the four neighbours vary
**north/south/west/east** — Y is never the varied axis.

Every number quoted on this page — the 0-versus-3,405 ocean-tag table, the deepslate table, the
magma/obsidian ratios, the 2,968-cell example and its per-block breakdown — was produced by
running the exact JSON above through this project's own tooling and reading the counts and
coordinates back out of the result. That is the part of this page a reader can reproduce, and it
is worth doing if you are relying on a number here. The accompanying image was rendered from that
same result by this doc set's own image pipeline (see
[`docs/wiki/tools/`](./tools/generate-images.mjs)), sliced as described above.

The one accuracy caveat belongs to the **tooling**, not the game, and it is the flat sea level
described above. Everything else on this page is modelled as the game does it.
