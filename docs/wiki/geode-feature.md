# Geode Features

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. This feature type's JSON surface — every key, its bounds and its required/optional
status — and its placement are unchanged between 1.26.40.26 and 1.26.50.24, so the page
describes both versions. Worldgen internals move between releases; nothing
here should be assumed to hold for a different build without checking.

`minecraft:geode_feature` is a **Scene feature**: a footprint search (a handful of randomly
placed "distribution points" that together define a lumpy, noise-perturbed sphere) combined with
content placement (five concentric density bands, each written with its own block, plus
budding-amethyst-style decorations on the innermost solid shell) in one self-contained call. It
never delegates to another feature — the whole geode, shells and all, is placed directly by this
one type, the same "leaf, no `places_feature`" shape [Ore Features](./ore-feature.md) has.

## The concentric-shell model

A geode is not a stack of literal spheres. Every cell within `max_radius` of the origin gets a
single **density** value — the sum of `1/sqrt(distance² + offset)` over every one of the geode's
own randomly-placed distribution points, plus a coherent-noise sample scaled by `noise_multiplier`
and by how many points the geode drew — and that one number decides which shell the cell falls
into. Because density rises as a cell gets closer to *any* distribution point (not just the
nearest one), the resulting shape is an irregular, lumpy blob loosely centered on the origin, not
a perfect sphere: a handful of points, offset from each other and from the origin, is what
actually produces the recognizable "geode" silhouette instead of one clean ball.

Two things about that formula are worth knowing before you try to predict a boundary by hand. The
`1/sqrt(...)` is the game's *fast approximate* reciprocal square root rather than an exact one, and
the whole cascade — the running total, the noise term, every threshold it is compared against — is
computed in single precision. Each is a small effect per term, but they accumulate across the sum
and the comparison at the end is a hard threshold, so a cell sitting right on a shell boundary can
fall on either side of it. The formula tells you the shape; it will not let you name the block at a
particular cell without running it.

Five bands, checked in this order (loosest/lowest-density band first — "too far away" always wins
before anything else is considered). The three thresholds separating "nothing" from `outer_layer`,
`middle_layer` and layer0 are computed from the geode's own point count divided by
`max_outer_wall_distance`, so more points, or a smaller wall distance, tightens them; the innermost
one — the `filler` threshold — is a fixed constant that no field moves:

| Density band | Result |
|---|---|
| below the loosest threshold | nothing — outside the geode entirely |
| next band up | `outer_layer` |
| next band up | `middle_layer` |
| next band up | **layer0** — `inner_layer` or `alternate_inner_layer`, plus a possible `inner_placements` bud (see below) |
| at or above the tightest threshold | `filler` — the hollow interior |

In a vanilla-style amethyst geode, `filler` is `minecraft:air` (a hollow center), `inner_layer`/
`alternate_inner_layer` is `minecraft:amethyst_block`/`minecraft:calcite`, `middle_layer` is
`minecraft:calcite`, and `outer_layer` is `minecraft:smooth_basalt` — read top to bottom in the
table above, that is exactly "hollow center, amethyst-or-calcite shell, calcite shell,
basalt shell, then open air again" — a real geode's cross-section.

### `min`/`max_distribution_points`, `min`/`max_outer_wall_distance`, `min`/`max_point_offset`

These four ranges control the blob's own shape, not a literal formula the reader needs to
reproduce by hand:

- `min`/`max_distribution_points` — how many seed points the density field sums over (vanilla:
  3–4). More points make a lumpier, less spherical geode; fewer make a cleaner ball.
- `min`/`max_outer_wall_distance` — each point is offset from the origin by an independently
  drawn X, Y, and Z distance in this range (vanilla: 4–6). This is the dominant control on the
  geode's overall size.
- `min`/`max_point_offset` — an extra per-point jitter added directly into that point's own
  density contribution (vanilla: 1–2), distorting the shells further without moving the point
  itself.

`max_radius` (vanilla: 16) is separate from all of the above: it is only the traversal bound —
the cube around the origin that actually gets scanned for candidate cells. It does not, by
itself, make the geode bigger; a `max_radius` smaller than the blob the other fields describe
will simply clip it.

### `invalid_blocks_threshold`

The distribution points are drawn one at a time, and each one's own position is checked against a
short list of blocks a geode can never anchor in — `minecraft:bedrock`, `minecraft:packed_ice`,
`minecraft:blue_ice`. A point that lands on one of those while the tolerance still has room is kept
anyway: it is not discarded, moved or redrawn, and it goes on to contribute to the density field
like any other point. The moment a point lands on one of the three with the tolerance already used
up, the *whole* geode stops right there and writes nothing.

So **more than** `invalid_blocks_threshold` bad points is what aborts, and
`invalid_blocks_threshold: 1` tolerates exactly one of them, not zero. The abort is immediate
rather than end-of-loop: the geode does not go on to draw the points it had left. That is visible
from outside the geode, because a feature shares one random stream with everything else placed in
the same chunk — an aborted geode consumes only the random numbers it got as far as spending, not a
full set, so what follows it is not shifted the way a full set would shift it.

## `generate_crack_chance` and `base_crack_size` — what the crack actually looks like

::: warning
**Neither field controls what its name suggests.** Both are required by the JSON schema and
range-validated at build time (`generate_crack_chance` in `[0.0, 1.0]`, `base_crack_size` in
`[0.0, 5.0]`), but at placement time:

- The roll that decides *whether* a crack forms at all is against a **fixed 0.95**, not against
  `generate_crack_chance`'s own value. Setting `generate_crack_chance` to `0.1` or `1.0` has **no
  effect** on how often a crack appears; it fires roughly 95% of the time regardless.
- `base_crack_size` has no effect on placement either. The crack's width comes from the geode's
  own point count instead. The difference between the two is worth knowing if you are deciding how
  much to trust this: the `0.95` above is a concrete value, while this one is the absence of
  any use of the field, which is harder to be certain of.

This is behaviour of the game, not a limitation of this tool, and it is specific to the version
this project targets rather than a permanent fact about the format.
:::

The crack itself, when it fires, has a fixed geometry, not a configurable one: a 3-point line
running from `origin.Y + 7` down to `origin.Y + 1` (three fixed Y offsets), with a random draw
(0–3) choosing one of four fixed X/Z shapes for that line — offset along X only, along Z only,
diagonally along both, or not offset at all (straight up through the origin). How far that offset
reaches is not configurable either: it is an odd number derived from the geode's own point count.

A cell is carved to air when its own distance sum to that 3-point line clears a threshold *and* its
density is below the `filler` threshold — a crack never carves through the hollow center. The
result reads as a visible notch through the outer shells, cut where the density field alone would
have placed solid material. Two things feed that test besides the line:

- `crack_point_offset` enters the line-distance sum exactly the way each distribution point's own
  offset enters the shell density, so it does have a real, visible effect on how wide the crack
  reads — even though the two "chance"/"size" fields next to it in the schema do not.
- The same point-count-scaled noise term the shell density carries is added to the crack sum too,
  so `noise_multiplier` roughens the crack's edges as well as the shell boundaries. The threshold
  that sum is compared against also carries a small random component drawn once per geode, so two
  geodes with identical fields do not crack to identical widths.

## `inner_placements` — budding blocks

`inner_placements` is a plain array of block descriptors, picked from with a **uniform** index
draw (`NextIntBound(len(inner_placements))`) — there is no weight field here, unlike
[Weighted Random Features](./weighted-random-feature.md) or `places_block`'s own weighted list;
vanilla's own amethyst geode config (small/medium/large bud, cluster) lists its four candidates
the same unweighted way. A pick is only attempted for a layer0 cell that also passes two more
rolls:

- `use_alternate_layer0_chance` decides, per layer0 cell, whether that cell resolves to
  `alternate_inner_layer` (roll succeeds) or `inner_layer` (roll fails).
- If `placements_require_layer0_alternate` is `true`, a bud is only even attempted on a cell that
  resolved to `alternate_inner_layer` — cells that resolved to plain `inner_layer` never get a
  bud at all. If `false`, every layer0 cell gets a chance regardless of which block it resolved
  to. This matches Microsoft's own documented wording for this field ("potential placement
  blocks will only be placed on the alternate layer0 blocks that get placed") exactly.
- `use_potential_placements_chance` is the actual per-cell roll for whether a bud is attempted at
  all, once the two gates above allow it.

A cell that passes all of that becomes a **potential placement position**, not an immediate bud —
budding is resolved afterward, once per potential position, by scanning that position's six
neighbors (in a fixed Up/Down/North/South/West/East order) for the first one that is air or
water. The picked `inner_placements` block is written at *that neighbor*, not at the layer0 cell
itself, facing back toward the cell it budded from — the same "grows toward open space" behavior
real budding amethyst has.

::: warning
**The face search and the game's own gate on top of it are both real; one last step of that
gate is not modelled.** On top of the air/water face scan, the game runs its own placement check on
the candidate — a per-block-type check — and only buds where that also passes. Both of the steps
that check does for an amethyst cluster are implemented here: the anchor-support test on the
cell the bud grows from, and the block's own placement filter (which face it accepts, and what it
requires the anchor to be). A face that fails either is skipped, not budded.

What is *not* modelled is that gate's final step, a data-driven multi-block component — the thing
that lets a block declare itself one part of a larger structure. None of the four blocks the game
registers as amethyst clusters carries one, so for a vanilla `inner_placements` list the gap
cannot change a single placement.

That is why the disclosure is narrow rather than constant. The tooling warns only when a pick
resolves to a block **outside** that set of four, names the block, and says it at most **once per
geode placed** — not once per bud, and not at all for a vanilla config:

> `inner_placements block "<the picked block>" is not one of the four vanilla amethyst bud
> blocks. The rules this tool uses to decide whether a bud can attach to a wall, and which way
> it faces, are the ones the game applies to those four; a different block may legally carry its
> own placement rules that this tool does not read, so where its buds end up here may not be
> where the game puts them. The four vanilla buds preview accurately.`
:::

## Noise-driven distribution

Before any of the schema-gated logic above runs, `Place` unconditionally constructs a
`NormalNoise` generator from the placement's own `Random` stream — a real cost every single geode
pays regardless of its own field values, spending a large, fixed number of RNG draws up front.
That noise generator is what the density formula's `noise_multiplier` term samples per cell,
which is what keeps the shell boundaries from reading as perfectly smooth spherical bands. The
sample is scaled by `noise_multiplier` and then again by the number of distribution points the
geode drew, so at the same `noise_multiplier` a four-point geode is roughened a third more than a
three-point one. A `noise_multiplier` of `0` (or very small) makes the shells read as clean,
mathematically regular bands; vanilla's own `0.05` adds a visible amount of roughness without
disguising the underlying shape.

## Example

```json title="geode_feature -- a vanilla-config amethyst geode"
{
  "format_version": "1.21.110",
  "minecraft:geode_feature": {
    "description": { "identifier": "wiki:amethyst_geode" },
    "filler": "minecraft:air",
    "inner_layer": "minecraft:amethyst_block",
    "alternate_inner_layer": "minecraft:calcite",
    "middle_layer": "minecraft:calcite",
    "outer_layer": "minecraft:smooth_basalt",
    "inner_placements": ["minecraft:amethyst_cluster"],
    "min_outer_wall_distance": 4,
    "max_outer_wall_distance": 6,
    "min_distribution_points": 3,
    "max_distribution_points": 4,
    "min_point_offset": 1,
    "max_point_offset": 2,
    "max_radius": 16,
    "crack_point_offset": 2,
    "generate_crack_chance": 0.95,
    "base_crack_size": 2.0,
    "noise_multiplier": 0.05,
    "use_potential_placements_chance": 0.35,
    "use_alternate_layer0_chance": 0.083,
    "placements_require_layer0_alternate": true,
    "invalid_blocks_threshold": 1
  }
}
```

Every numeric field here is vanilla's own amethyst geode configuration verbatim, except
`inner_placements`, simplified to one entry (`minecraft:amethyst_cluster`) instead of vanilla's
own four-entry small/medium/large-bud/cluster list, so a rendered image reads as one consistent
block rather than four different bud sizes competing for attention. Run against this project's
`underground_stone` environment preset (solid stone, no caves) with feature seed `4` and origin
`(0, 32, 0)`, this geode's own changed cells span roughly world `(-1..11, 30..42, -2..12)` — 383
`smooth_basalt`, 319 `calcite`, 206 `amethyst_block`, 434 hollow-center/crack `air`, and 11
`amethyst_cluster` buds this seed:

![A cutaway of a stone block revealing a geode's concentric shells -- a reddish-brown outer band, a white middle band, and a purple amethyst band around a hollow center, rendered by featurelab's voxel viewer](./images/geode-feature-amethyst.png)

```
featurelab generate --pack <pack> --feature wiki:amethyst_geode --env underground_stone --seed 4 --origin 0,32,0
```

::: note
Like the [Ore Features](./ore-feature.md#example) diamond vein, a geode this deep in solid stone
is fully face-occluded from outside — every one of its own cells borders either more geode or
solid stone, so an unsliced render would show nothing but the opaque `outer_layer` shell. The
image above is sliced at the geode's own vertical midpoint (world Y 36) and rendered with the
surrounding rock **solid**, the same cutaway convention the ore vein page established: it exposes
a horizontal cross-section straight through the shell structure — hollow center, `inner_layer`
ring, `middle_layer` ring, `outer_layer` ring, from the center out — the same "cut it in half"
view real geode photographs use. This is a viewing choice for the screenshot, not a change to
what the feature actually placed.
:::

## Field reference

Every field below is **required** — `buildGeodeFeature` returns a build error for any of them
that is missing — with the sole exception of `inner_placements`, which this tool treats as
optional (an omitted or empty list simply means no buds are ever attempted; whether the game
requires this specific field is not known with certainty, so this is stated as
this tool's own accepted behavior, not a claim about the game).

| Field | Required | Shape | Bounds |
|---|---|---|---|
| `filler` | yes | block descriptor | — |
| `inner_layer` | yes | block descriptor | — |
| `alternate_inner_layer` | yes | block descriptor | — |
| `middle_layer` | yes | block descriptor | — |
| `outer_layer` | yes | block descriptor | — |
| `inner_placements` | no (this port) | array of block descriptors, uniform pick | empty — no buds |
| `min_outer_wall_distance` | yes | integer | `[1, 10]` |
| `max_outer_wall_distance` | yes | integer | `[1, 20]` |
| `min_distribution_points` | yes | integer | `[1, 10]` |
| `max_distribution_points` | yes | integer | `[1, 20]` |
| `min_point_offset` | yes | integer | `[0, 10]` |
| `max_point_offset` | yes | integer | `[0, 10]` |
| `max_radius` | yes | integer | none checked |
| `crack_point_offset` | yes | integer | `[0, 10]` |
| `generate_crack_chance` | yes | number | `[0.0, 1.0]` — validated but not read by placement, see above |
| `base_crack_size` | yes | number | `[0.0, 5.0]` — validated, but nothing in placement uses it, see above |
| `noise_multiplier` | yes | number | none checked |
| `use_potential_placements_chance` | yes | number | `[0.0, 1.0]` |
| `use_alternate_layer0_chance` | yes | number | `[0.0, 1.0]` |
| `placements_require_layer0_alternate` | yes | boolean | — |
| `invalid_blocks_threshold` | yes | integer | none checked |

Every `min`/`max` pair above draws with the same rule: zero `Random` draws when `max <= min` (the
value is always exactly `min`), otherwise exactly one `NextIntBound(max - min)` draw added to
`min` — **not** the "max exclusive" convention
[Vegetation Patch Features](./vegetation-patch-feature.md#depth-and-horizontal_radius-ranges)
uses for its own int ranges; this is the bounded integer draw's own inclusive-of-`max` shape, which
genuinely differs from the range sampler that page describes, and the two disagree at
`max - min == 1`.

## See also

- [Ore Features](./ore-feature.md) — another self-contained Scene/Content leaf that places a
  whole structure in one call with no delegation, contrasted here by shape (ellipsoidal vein vs.
  concentric shells) rather than mechanism.
- [Vegetation Patch Features](./vegetation-patch-feature.md) — the other Scene feature in this
  version, combining a footprint search with delegated content placement instead of this page's
  own direct block writes.
- [Cave Carver Features](./cave-carver-feature.md) — a Carver feature that, like this one,
  constructs a noise/ellipsoid-driven shape from a handful of RNG-placed anchor points,
  contrasted by what it does with that shape (removes blocks, rather than layering them).

## Version and verification notes

Everything above is a statement about 1.26.50.24, and holds equally for
1.26.40.26: this type's JSON surface and its whole placement are unchanged between the two
versions, so nothing on this page splits between them.

What the page states as fact: the full 21-field schema; the order the random draws come out
in (the point count, then the noise generator's own unconditional construction, then the thresholds
and the crack roll, then each distribution point's position and offset, then the crack-shape
selector, then the per-cell classification with its layer0 rolls, then one pick per bud position);
the immediate abort described under `invalid_blocks_threshold`; the fixed `0.95` the crack roll is
really against; the crack line's own fixed geometry; and the face search and facing derivation
behind `inner_placements`.

What it deliberately does not claim: `base_crack_size` having no effect is an absence of any use of
the field rather than a concrete value, and the warning above says so in those terms;
`inner_placements`' required-or-optional status in the game's own schema is not known, so the
field reference above states what this tool accepts rather than what the game demands.

The JSON example on this page was run end to end against this project's own worldgen tooling
(`featurelab check` and `featurelab generate`, 1.26.50.24 target) and produced the described
result — the block names and counts quoted with it come from that run. The accompanying image was rendered from that exact result by this doc set's own image
pipeline (see [`docs/wiki/tools/`](./tools/generate-images.mjs)), sliced for visibility as
described above.
