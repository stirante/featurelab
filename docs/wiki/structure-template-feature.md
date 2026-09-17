# Structure Template Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. This type's JSON surface — every key, enum value and default, constraints included —
and its behaviour are unchanged between 1.26.40.26 and 1.26.50.24, so the
page describes both versions. Worldgen internals move between releases; nothing here should be assumed
to hold for a different build without checking.

`minecraft:structure_template_feature` is a **Content feature**: it copies a pre-authored
`.mcstructure` file into the world, block by block, at a position it searches for near its
origin. Unlike [Single Block Features](./single-block-feature.md) and
[Ore Features](./ore-feature.md), what it places isn't described in the JSON at all — the shape,
size, and every block come from a separate structure file, and the JSON only configures how that
file gets oriented and where the search for a valid spot looks.

## What it does

1. If `facing_direction` is `"random"`, draw **one** `Random` value, `nextIntBound(4)`, to pick a
   0–3 rotation before anything else happens. Every other `facing_direction` value (including the
   `"south"` default when the field is omitted) costs **zero** draws: the rotation is simply the
   one you named.
2. Compute a horizontal center offset from `rotate_around_center` and a vertical offset from
   `ground_level` (clamped to `[0, structure height - 1]`) — pure arithmetic on the structure's
   own size, no RNG, no world reads.
3. Search for a valid position: starting at the origin, walk an `adjustment_radius`-sized spiral
   (origin cell first, then outward in `(2r+1)²` total cells) testing every configured constraint
   at each candidate. The first candidate where **every** constraint passes wins; `adjustment_radius`
   `0` means "only the origin itself is tried." This walk reads blocks (via constraints) but draws
   no RNG of its own.
4. If no candidate passed, fail with no blocks placed. Otherwise, copy every non-void cell of the
   structure's primary block layer into the world at the found position, rotated and offset as
   computed in step 2.

::: note
**The vein/tube-shaped RNG-order contract other Content features have doesn't apply here in the
same way.** The *entire* placement — the position search, every constraint check, the per-block
copy — draws nothing beyond that single, conditional rotation draw in step 1. A published pack
using an explicit `facing_direction` (not `"random"`) gets a byte-for-byte deterministic structure
placement with **zero** RNG cost at all. See `features/structure_template.go`'s
own header comment for the details.
:::

### `facing_direction` and `rotate_around_center`

`facing_direction` is one of `"south"` (rotation 0, the default), `"west"` (1), `"north"` (2),
`"east"` (3), or `"random"` (draw one `nextIntBound(4)`, see step 1 above). The structure's local
X/Z axes rotate around its own origin cell by that amount; Y is never touched.
`rotate_around_center` (default `false`) additionally offsets the structure horizontally by
`-floor(sizeX/2)`/`-floor(sizeZ/2)` **before** that rotation is applied, so the structure's
horizontal center — not its `(0,0)` corner — lands on the found position.

### `ground_level`

Which row of the structure (Y, local to the structure, clamped to `[0, sizeY-1]`) lands exactly
at the found position's own Y. `ground_level: 0` (the default) means the structure's bottom layer
sits at the target position — everything above it stacks upward from there, and nothing below it
exists to stack downward. A nonzero value pins some other row to the target instead, letting a
structure with a below-ground basement or an above-ground overhang be positioned by whichever row
is most natural to the caller.

### `adjustment_radius` and constraints

`adjustment_radius` (default `0`, meaning "only try the origin cell") widens the position search
to a spiral of up to `(2r+1)²` cells around the origin, tried origin-first, outward — the first
cell where every configured constraint passes wins. The game's schema restricts it to the range
`[0, 16]` and **nothing clamps it** afterwards: a value outside that range fails validation and
the file does not load.

`constraints` is **required** by the game's schema. An empty `constraints` object
means every candidate passes, and the spiral search stops at the origin cell on the first try.

**Four** constraints exist. Each one precomputes a set of relative points from the structure's own
block data when the feature loads, and then, per candidate position, rotates every point and tests
one predicate on the world block found there. All of them pass vacuously when their point set is
empty, and each fails the whole candidate on its first failing point:

| Constraint | Which points it checks | Per-point test |
|---|---|---|
| `constraints.grounded` | One row **below** the structure's `ground_level` row, for every column whose cell *on* that row is neither void nor air. | The world block is a **solid blocking block** — the game's own solid-blocking test, not a material comparison. |
| `constraints.unburied` | One row **above** the whole structure, for every column whose cell on the structure's **top row** is neither void nor air. Columns that stop short of the top row are not checked at all. | The world block **is exactly air** — a comparison against air's default block state, not a "passable" or material test. |
| `constraints.block_intersection.block_allowlist` (alias `block_whitelist`) | The structure's non-void cells are **split in two**: those the engine considers motion-blocking, and everything else (explicit air included). Only the motion-blocking half is checked unless `only_check_intersection_for_motion_blocking_blocks` is set to `false`, whose **default is `true`**. | The world block is in the given allow-list. |
| `constraints.leveled` | The same points as `grounded`. | Within a vertical window of `± max_steepness` (default **2**) around the point there is a solid-over-air transition — i.e. the ground under the footprint is level to within that tolerance. |

Two consequences of `unburied`'s point set are worth stating plainly, because they are easy to
assume the other way round: it checks a **single height** for the whole footprint (not each
column's own clearance), and a column whose blocks stop below the structure's top row is
**skipped entirely** rather than checked at its own top.

**"Empty" has two spellings, and for three of the four constraints they mean the same thing.**
`grounded`, `unburied` and `leveled` compare each sampled cell against air's default block state,
and a *void* cell reaches that same comparison because the engine substitutes the empty block —
air — for it. So a cell holding explicit `minecraft:air` contributes no point, exactly as a void
cell does. This matters because a `.mcstructure` saved from a structure block writes
**empty-but-selected cells as explicit air**, not as void: a structure that looks like it has an
open top in the editor may be full of air cells, and reading those as occupied makes the
constraint check columns the engine never looks at. `minecraft:structure_void` is *not* covered by
this — it is a real block with its own identity, so it does contribute a point.

::: note
**Which blocks count as motion-blocking** is easy to get wrong: stairs, single slabs, walls,
fences, panes, doors, trapdoors, buttons, pressure plates, signs, carpets and chests do **not**
count as motion-blocking, nor do snow layers, cactus, bamboo, ladders, scaffolding or powder snow.
A double slab does. A block a pack defines itself is taken to block motion, because this tool does
not read a custom block's own material. `constraints.leveled` is enforced over the window and
point set described above, so a bench run refuses a structure on ground the game would reject as
too steep.
:::

### What this version does not enforce

Structures in general support an integrity setting (a per-block random skip during the copy,
letting a structure look "worn down") — but it is **not exposed as a JSON key anywhere** in this
feature type. There is no field to set here; every placement behaves as if integrity were `100.0`
(keep every block, zero RNG spent on the copy), which is the game's own unconditional behavior for
this feature type, not an approximation this project made.

::: warning
**The in-world copy step itself is a documented deviation from what this version's worldgen-time
placement actually does.** During world generation, a structure-placement request from this
feature is refused unconditionally: **worldgen-time volumes do not support structure placement
at all** in this version. When the feature is placed in-game outside world generation, the copy
does happen. This project's `Place` mirrors that in-game placement rather than the
worldgen-time refusal, on the reasoning that a preview tool which always reports "nothing placed"
for a real, working feature type would defeat its own purpose — but this means the image and
example below show what `structure_template_feature` does **when actually placed**, not
byte-for-byte what this version's own worldgen pass would produce. This is
this project's own documented choice.
:::

## Example

```json title="structure_template_feature -- a small asymmetric structure, rotated"
{
  "format_version": "1.21.110",
  "minecraft:structure_template_feature": {
    "description": { "identifier": "wiki:lamp_post_structure" },
    "structure_name": "wiki:lamp_post",
    "facing_direction": "east",
    "constraints": {}
  }
}
```

`structure_name` resolves against a `.mcstructure` file loaded from this doc set's own
fixtures — [`fixtures/structures/wiki/lamp_post.mcstructure`](./tools/fixtures/structures/wiki/lamp_post.mcstructure),
a deliberately small (1×4×2) and **asymmetric** structure: a `minecraft:cobblestone` foundation,
a three-block `minecraft:oak_log` shaft, and a `minecraft:glowstone` lantern offset to one side —
asymmetric on purpose, so `facing_direction`'s rotation is actually visible in the result rather
than rotating into itself. Since `featurelab/nbt` is a reader only (no writer — see that
package's own doc comment), this fixture was hand-encoded by a small standalone script,
[`gen-fixture-structures.mjs`](./tools/gen-fixture-structures.mjs), rather than authored through
any in-game or third-party structure tool; it's committed binary source, the same as the JSON
fixtures are committed text source, not something `generate-images.mjs` regenerates on every run.

An empty `constraints` object — the schema requires the key, and every constraint inside it is
optional, so `{}` is the way to configure none — no `adjustment_radius`, no `rotate_around_center` — `ground_level` defaults to
`0`, so the structure's cobblestone foundation row lands exactly at the resolved origin. Run
against `plains` with feature seed `1`, the origin resolves to `(0, 63, 0)` — the same "top of the
terrain column at `(0, 0)`" default [the single_block_feature example](./single-block-feature.md#example)
resolves to — and
every one of the structure’s 5 painted cells copies in cleanly — no diagnostics of its own, no
failed constraint, since none were configured:

![A small asymmetric lamp post -- a gray cobblestone base, a brown oak_log shaft, and a warm-toned glowstone lantern offset to one side -- standing on a patch of grass, rendered by featurelab's voxel viewer](./images/structure-template-feature-lamp-post.png)

`facing_direction: "east"` rotates the structure's local +Z offset (where the lantern sits,
relative to the shaft) onto world +X — the lantern in the image sits east of the shaft, not
south, which is where it would sit with `facing_direction` left at its `"south"` default. Rotating
this same JSON through all four cardinal values and comparing the lantern's position is a quick
way to confirm the rotation math end to end.

```
featurelab generate --pack <pack> --feature wiki:lamp_post_structure --env plains --seed 1
```

## Constraints and the search, in practice

The example above configures no constraints and no search radius, so nothing in it exercises the
four-constraint table or the spiral. This second file does:

```json title="structure_template_feature -- the same lamp post, constrained, with a search radius"
{
  "format_version": "1.21.110",
  "minecraft:structure_template_feature": {
    "description": { "identifier": "wiki:lamp_post_constrained" },
    "structure_name": "wiki:lamp_post",
    "adjustment_radius": 2,
    "constraints": {
      "grounded": {},
      "unburied": {},
      "leveled": { "max_steepness": 1 }
    }
  }
}
```

The same 1×4×2 lamp post, with `facing_direction` left out entirely — so this one takes the
`"south"` default, rotation 0, the identity case the first example deliberately avoids — and with
three of the four constraints configured over a 5×5 search area.

Run against `plains` with feature seed `1`:

```
featurelab generate --pack <pack> --feature wiki:lamp_post_constrained --env plains --seed 1
```

all five of the structure's painted cells copy in, with no diagnostic of the feature's own:
`minecraft:cobblestone` at `(0, 63, 0)`, `minecraft:oak_log` at `(0, 64, 0)`, `(0, 65, 0)` and
`(0, 66, 0)`, and the `minecraft:glowstone` lantern at `(0, 66, 1)` — one block *south* of the
shaft, where the first example's `facing_direction: "east"` put it at `(1, 66, 0)`, one block east.
Same structure, same origin, same seed; only the rotation differs.

The spiral never leaves its first cell, because all three constraints already pass at the origin.
Each one checks fewer points than it looks like it should, which is worth tracing once against a
real structure:

- **`grounded`** samples the structure's `ground_level` row (row 0) per column and keeps only the
  columns that have a block there. This structure's `z = 1` column is empty on row 0 — the lantern
  is up at row 3 — so the constraint has exactly **one** point, one below the `z = 0` column, world
  `(0, 62, 0)`. That is the plains surface: solid, so it passes.
- **`unburied`** samples the fixed top row (row 3) instead, where *both* columns are occupied
  (log and lantern), giving **two** points one row above the structure: `(0, 67, 0)` and
  `(0, 67, 1)`. Both are open sky, so it passes.
- **`leveled`** reuses `grounded`'s single point and scans the consecutive rows from
  `62 - 1` to `62 + 1 + 1` for a solid-over-air transition. It finds solid at `62`, air at `63`,
  and passes.

Move the same JSON into the air and the whole thing fails:

```
featurelab generate --pack <pack> --feature wiki:lamp_post_constrained --env plains --seed 1 --origin 0,71,0
```

Nothing is placed, and the run reports one warning — `Structure could not be placed.` — with no
partial copy of any kind. Eight blocks of open air (`y 63`–`70`) sit between that origin and the
top solid block of the plains column at `y 62`, so `grounded` samples air at `y 70` and fails —
and it fails identically at every candidate the spiral offers.

::: warning
**`adjustment_radius` searches sideways only.** Every candidate keeps the *origin's own Y*: the
search is `(2r+1)²` cells in X and Z, never a column. A radius will slide a structure around an
obstacle, but it will never drop one onto the ground below it — raising `adjustment_radius` in the
failing run above changes nothing except how many candidates get rejected before the feature gives
up. Landing on terrain from a floating origin is what
[Snap-to-Surface Features](./snap-to-surface-feature.md) and
[Search Features](./search-feature.md) are for; wrap the structure feature in one of those rather
than widening the radius.
:::

## Field reference

| Field | Required | Shape | Default |
|---|---|---|---|
| `structure_name` | yes | string, resolved against loaded `.mcstructure` files | — |
| `facing_direction` | no | one of `south`/`west`/`north`/`east`/`random` | `south` (the enum's zero value) |
| `rotate_around_center` | no | boolean | `false` |
| `ground_level` | no | number, minimum **0** (schema-enforced); then clamped at place time to `[0, structure sizeY - 1]` | `0` |
| `adjustment_radius` | no | number in the range `[0, 16]`, schema-enforced and never clamped | `0` (origin cell only) |
| `constraints` | **yes** | object holding any of the four below | — (required; an empty object is legal) |
| `constraints.grounded` | no | `{}` | not configured |
| `constraints.unburied` | no | `{}` | not configured |
| `constraints.block_intersection.block_allowlist` (alias `block_whitelist`) | **yes**, when `block_intersection` is present | array of block descriptors | — (required; a `block_intersection` without it does not load) |
| `constraints.block_intersection.only_check_intersection_for_motion_blocking_blocks` | no | boolean | **`true`** — the narrow, motion-blocking-only check |
| `constraints.leveled.max_steepness` | no | number (integer; a fractional value truncates) | **2** |

## See also

- [Single Block Features](./single-block-feature.md) — a simpler Content feature; its own note on
  the `may_attach_to.<face>` single-descriptor shorthand applies to that field wherever it
  appears, not repeated here since this feature type has no `may_attach_to` field of its own.
- [Ore Features](./ore-feature.md) — another self-contained Content feature that places more than
  one block per call, contrasted with structure_template_feature's fixed, pre-authored shape.

## Version and verification notes

Everything above is a statement about 1.26.50.24 specifically, and holds
for 1.26.40.26 too: this type's JSON surface and its behaviour, constraints included, are
unchanged between the two versions.

The `facing_direction` enum's values are south=0, west=1, north=2, east=3, random=255. Each
constraint precomputes its point list from the structure's own palette using the linearization
`z + sizeZ*(y + x*sizeY)`. `block_allowlist` is marked required; that a `block_intersection`
without it fails to load follows from that flag rather than from an observed load failure.
`features/structure_template.go`'s header comment carries the details.

A few things on this page are less certain than the rest, and are marked as such rather than
smoothed over. The rotation math — what `facing_direction` and `rotate_around_center` do to a
structure's local offsets — is certain for the X half of each of the three non-identity rotation
cases and assumed for the paired Z half, from the standard self-consistent rotation-matrix
relationship. A pack's own custom blocks are assumed to block motion, as called out above. The
worldgen-time versus in-game deviation is this project's documented choice. The `.mcstructure`
file format is handled by parsing real files (see `nbt/nbt.go`'s own package doc comment).

Both JSON examples on this page were run end to end against this project's own worldgen tooling
(`featurelab check` and `featurelab generate`) and produced the described results — the part a
reader can rerun directly.
The constrained example's failing run is the same command with `--origin 0,71,0`, and its warning
text is quoted from that run verbatim.
The accompanying image was rendered from that exact result by this doc set's own image pipeline (see
[`docs/wiki/tools/`](./tools/generate-images.mjs)).
