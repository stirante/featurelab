# Feature Rules

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. Worldgen internals move between releases; nothing here should be assumed to hold
for a different build without checking.

Every other page in this set describes something that places blocks *when it is called*. This
one is about what calls them. A `minecraft:feature_rules` file — one JSON file per rule, under a
behaviour pack's `feature_rules/` folder — is how a feature reaches a world at all: it names a
feature, names the biomes it applies to, and says where in each of those biomes' chunks to try
it. Without a rule pointing at it, a perfectly correct feature file is inert.

A rule is also the one worldgen object that is *not* a feature, which is the source of most of
the confusion around it. It cannot be delegated to, it cannot be named by any `places_feature`
anywhere, and it has no `place()` of its own that another file could reach. It exists only at the
top: the engine attaches it to chunks, and nothing below it can see it.

## What a feature rule is, mechanically

A rule is a `{distribution, places_feature}` pair added to a chunk's **decoration list** — the
same list that holds the features a biome names directly. When the chunk is decorated, that entry
runs the **exact same scatter machinery** `minecraft:scatter_feature` uses: the same distribution
kinds, the same per-axis draws in the same order, the same `scatter_chance` gate, the same
`variable.originx`/`worldx` Molang writes. There is no separate "rule placement algorithm" to
learn.

Two things differ from a scatter, and both matter:

- **The origin is the chunk's minimum corner**, not an arbitrary position handed down by a
  caller. Every decoration entry in a chunk — a rule's included — scatters from that same base
  point, so a rule's `distribution.x`/`z` are effectively chunk-relative offsets.
- **It runs once per chunk, of every biome whose filter matches.** A rule is not invoked by
  anything; it is attached, and then it fires for each chunk it applies to. "How many times does
  my rule run?" is answered by "how many chunks", not by any count in the file.

::: note
Because a rule and a scatter share one implementation, everything the [Scatter
Features](./scatter-feature.md) page establishes about distributions applies here verbatim —
including which kinds draw and which silently do not. The
[no-draw catalogue](./rng-and-determinism.md#the-no-draw-catalogue) is the same catalogue.
:::

## File shape

```json title="feature_rules/pumpkin_patch.fr.json"
{
  "format_version": "1.21.110",
  "minecraft:feature_rules": {
    "description": {
      "identifier": "wiki:pumpkin_patch.fr",
      "places_feature": "wiki:pumpkin_patch"
    },
    "conditions": {
      "placement_pass": "surface_pass",
      "minecraft:biome_filter": { "test": "has_biome_tag", "value": "overworld" }
    },
    "distribution": {
      "iterations": 4,
      "x": { "distribution": "uniform", "extent": [0, 15] },
      "y": 0,
      "z": { "distribution": "uniform", "extent": [0, 15] }
    }
  }
}
```

The body has three members, and nothing else in it is read:

| Member | Required | Contents |
|---|---|---|
| `description.identifier` | yes | This rule's own name. Not a feature reference — nothing can name it. |
| `description.places_feature` | yes | The feature this rule places. Note it sits under `description`, unlike a scatter's, which sits on the feature body. |
| `conditions` | yes | The wrapper below is required even when it holds only the pass. |
| `conditions.placement_pass` | **yes** | Which pass over the chunk this rule's entry attaches to. See below — the value is checked, and a wrong one is not the same as a missing one. |
| `conditions.minecraft:biome_filter` | no | Which biomes the rule applies to. Absent or `{}` means all of them. |
| `distribution` | **no** | Identical in shape to a scatter's `distribution` object — but optional, with a consequence worth knowing (below). |

Those six keys and `description` itself are the whole accepted surface. Anything else written at
any of those levels is an unrecognised member: the engine names it and drops it unread, so a
misspelled key is silently inert rather than an error.

::: warning
**`distribution` is optional, and leaving it out is worse than an error.** The file loads. The
rule is inserted, attached to its pass and to every biome its filter matches — and then places
nothing, in every chunk, forever, because a rule with no distribution gets a default-constructed
one whose `iterations` is 0. Nothing is logged at generation time. If a rule appears to do
nothing at all, checking that it *has* a `distribution` is the first thing to do.

The four keys marked required are required in the stronger sense: a file missing any of them
fails to load and the rule is never inserted at all.
:::

`distribution` takes `iterations` (required), `x`/`y`/`z`, `coordinate_eval_order` and
`scatter_chance`, in exactly the value shapes the scatter page's [field
reference](./scatter-feature.md#field-reference) lists — that table is not repeated here because
it is the same table. The per-kind draw counts are in [`distribution.x`/`y`/`z` and
`coordinate_eval_order`](./scatter-feature.md#distributionxyz-and-coordinate_eval_order); the
gate's two JSON spellings and its RNG-free short-circuits are in
[`scatter_chance`](./scatter-feature.md#scatter_chance).

::: note
A rule body carries no `project_input_to_floor`. That key lives on a `scatter_feature`'s body,
*outside* its `distribution`, and a rule has no feature body to put it on — a rule **is** the
distribution. When placements need to find ground, the thing to reach for is a
[Snap-to-Surface Feature](./snap-to-surface-feature.md) inside the chain the rule places, not a
key on the rule.
:::

### Coordinates are chunk-relative, so `x`/`z` usually want `[0, 15]`

Because the origin is the chunk's minimum corner, an `extent` of `[0, 15]` on `x` and `z` covers
exactly that chunk and nothing else. Ranges that reach outside it are not illegal — they place
into neighbouring chunks — but they make the output depend on which chunk is being decorated as
well as where, and two adjacent chunks then spill into each other, which is harder to reason
about than it looks.

The Molang side follows from the same fact: `variable.originx`/`originy`/`originz` hold the
**chunk corner**, written once before any axis is evaluated, and `variable.worldx`/`worldy`/
`worldz` hold each axis's absolute coordinate the moment that axis is computed. Both behave
exactly as [Molang variables](./scatter-feature.md#molang-variables) describes for a scatter,
including the rule that `iterations` and `scatter_chance` are evaluated *before* any axis and so
cannot read this call's `world*`.

## `minecraft:biome_filter`

The filter decides which biomes the rule is attached to. Five shapes:

| Shape | Matches |
|---|---|
| absent, or `{}` | Always — every biome. |
| `{"test": "has_biome_tag", "value": "<tag>"}` | Biomes carrying that tag. |
| `{"any_of": [ … ]}` | At least one child matches. |
| `{"all_of": [ … ]}` | Every child matches. |
| `{"none_of": [ … ]}` | No child matches. |

The combinators nest: a child of `any_of` is itself any of these shapes, including another
combinator. `has_biome_tag` is the test this documentation set covers; other test names
are not covered here, and a rule that depends on one is outside what this page can vouch for.

::: warning
**A filter that matches nothing is the commonest reason a pack appears to do nothing at all.** It
is silent in the game — a rule that was never attached to a biome has nothing to report, because
from the chunk's point of view it does not exist. Before debugging the feature, check the tag: a
mistyped `value`, or a tag the target biome does not actually carry, produces exactly the same
empty world as a broken feature does.
:::

## `placement_pass`

Chunks are not decorated in one sweep. The engine registers **eleven passes, in a fixed order**,
and `placement_pass` chooses which one a rule's entry is attached to:

| # | Pass |
|---|---|
| 1 | `first_pass` |
| 2 | `before_underground_pass` |
| 3 | `underground_pass` |
| 4 | `after_underground_pass` |
| 5 | `before_surface_pass` |
| 6 | `surface_pass` |
| 7 | `after_surface_pass` |
| 8 | `before_sky_pass` |
| 9 | `sky_pass` |
| 10 | `after_sky_pass` |
| 11 | `final_pass` |

That is the complete ordered list. The three-way `before_`/plain/`after_` grouping around
*underground*, *surface* and *sky* is the useful part of its shape: two hook points around each
of the three regions, so an author never has to guess an ordinal to get in front of or behind
something.

**What the ordering buys you is a guarantee about the world your rule sees.** A rule in an
earlier pass runs against a world that every later pass has not touched yet. That is what makes
the terraform-then-decorate shape work: a rule that reshapes ground — flattening, filling,
laying a platform — placed in `before_surface_pass` has finished before anything in
`surface_pass` starts looking for a surface to attach to, so the decorations land on what the
first rule built rather than on what was there before it. Run the two in the other order and the
decoration attaches to the old terrain and then gets buried by the new.

The converse is the cleanup case: a rule in `after_surface_pass` or `final_pass` sees everything
the surface decorations placed, and can react to it.

::: note
`pregeneration_pass` is a twelfth accepted value, kept in its own separate list rather than in
the ordered eleven — and **only cave carvers may run in it**. Any other feature type paired with
it is refused with `"cave_carver_feature" is the only valid feature in "pregeneration_pass"
placement pass.` and places nothing, however well the rest of the rule is written. What that pass
is for beyond carving, and where it sits relative to the eleven, is not known with certainty.
:::

::: warning
**`placement_pass` is required, and a wrong value fails differently from a missing one.**

- *Missing*: the file does not load. Nothing is inserted, and the whole rule is gone.
- *Unrecognised*: the engine logs `Feature rule identifier '<id>' specifies unknown pass
  '<pass>'.` — and then **keeps the value as written**. It does not fall back to a default. The
  rule is inserted and attached to its biomes, chunk decoration only ever visits the passes it
  knows, and so the rule is never reached. Nothing is logged again, in any chunk, ever.

The second is the one that costs an afternoon: everything about the file looks right, the rule is
"loaded", and it simply never runs. Check the spelling against the table above.
:::

::: note
Two rules may share an identifier as long as their passes differ — the engine keys its store by
pass first and then by identifier, so both are kept and both run. Two rules with the same
identifier in the SAME pass are not: the first one loaded wins, and the second is dropped
silently.
:::

## Seeding: per chunk, and per rule

A rule does not carry a seed and cannot be given one. Two facts decide what its distribution
actually draws, and both come from [RNG and
Determinism](./rng-and-determinism.md#where-a-features-seed-comes-from), which is where the
derivations live:

1. **Every chunk decorates from its own seed**, derived from the world seed and that chunk's
   coordinates. Chunks are independent of each other and of the order they happen to be
   generated in, so a rule produces the same layout in chunk (10, 4) whether or not its
   neighbours ever existed.
2. **Every entry in a chunk's decoration list gets its own seed**, derived from the chunk seed
   plus a hash of the entry's name. Rules therefore do not share a stream with each other, and
   do not share one with the features a biome places directly. Adding a rule to a pack does not
   move the rules already in it.

The corollary of (2) is that **a rename moves a rule's output**, and it is the RULE's own
`description.identifier` that is hashed — not the feature it places. So renaming a rule relocates
everything it places, while renaming its `places_feature` target (and updating the reference)
changes nothing about where that rule puts things.

From that per-entry seed the engine builds **two** generators: one the distribution draws
positions from, one every delegated feature draws from. So a change *inside* the placed feature
never moves the positions the rule picked for it — see [that seed is used twice, for two
independent
streams](./rng-and-determinism.md#3-that-seed-is-used-twice-for-two-independent-streams).

## Reproducing it

The fixture pack behind this set carries two rules that are identical except for their
identifiers: [`rng_rule_a.fr.json`](./tools/fixtures/feature_rules/rng_rule_a.fr.json) and
[`rng_rule_b.fr.json`](./tools/fixtures/feature_rules/rng_rule_b.fr.json), both placing the same
feature through eight iterations of a `uniform` `[0, 15]` x/z distribution with `y: 0`.

```
featurelab generate --pack docs/wiki/tools/fixtures --rule wiki:rng_rule_a.fr   --env void --seed 42 --size 32x16x32 --min-y 0
featurelab generate --pack docs/wiki/tools/fixtures --rule wiki:rng_rule_b.fr   --env void --seed 42 --size 32x16x32 --min-y 0
```

A 32×16×32 volume starting at `-16, 0, -16` spans exactly four chunks, and each run reports
**four** rule invocations — at origins `(-16, 0, -16)`, `(0, 0, -16)`, `(-16, 0, 0)` and
`(0, 0, 0)`. Those are the four chunks' minimum corners: once per chunk, rooted at the corner,
which is the top of this page showing up directly in the output.

Both runs make 32 attempts (8 iterations × 4 chunks), eight in each chunk rather than
concentrated in one — that even spread is the per-chunk half of the seeding. Their *coordinates*
share nothing: rule A's first four cells are `(-16, 5)`, `(-16, 10)`, `(-15, -6)`, `(-14, -7)`
and it places all 32; rule B's are `(-15, -10)`, `(-14, -16)`, `(-14, -13)`, `(-14, -11)` and it
places 31, two of its attempts having landed on the same cell. Only the rule identifier differs
between the two files, so its hash is the whole of the difference. [Reproducing the seeding rules
yourself](./rng-and-determinism.md#reproducing-the-seeding-rules-yourself) walks the same two
runs from the seeding side.

![Thirty-two stone markers scattered across a 32x32 area over empty space, rendered by featurelab's voxel viewer](./images/feature-rules-per-chunk.png)

That is rule A's own output at seed 42, on the `void` preset so nothing but the rule is visible:
eight markers inside each of the four chunks, none of them wandering into a neighbour's 16×16.
A feature scattering over the same footprint would have come from ONE call with a wider
distribution; this is four calls that never see each other, which is what "once per chunk" looks
like from above.

::: note
The per-cell arrays in that JSON are run-length encoded as `{"rle": [value, run, value, run, …]}`
— expand them before indexing if you decode the block grid yourself. The counts and coordinates
above come from exactly these two runs.
:::

## Why nothing was placed

Seven distinct failures produce the same empty chunk. An author can tell them apart — but not all
of them from the game alone.

| Cause | How you tell | Fix |
|---|---|---|
| **The pass name is not one the engine knows.** | The rule loaded, one line was logged at load, and it has never run since. | Correct the spelling against the pass table above. |
| **No `distribution`.** | Loads, attaches, places nothing, in every chunk, forever. Silent after load. | Give it one. A rule without a distribution has `iterations` 0. |
| **`pregeneration_pass` with a non-carver.** | Nothing places, and the engine says so once. | Move the rule to one of the eleven decoration passes. |
| **The biome filter did not match.** | The rule never ran at all, in any chunk. Silent in the game. | Correct the tag, or use `{}` while testing. |
| **`iterations` evaluated to zero.** | The rule ran and did nothing, at every seed. | Fix the expression — this is not luck. |
| **`scatter_chance` did not roll.** | Another seed places. | Nothing, if the odds were intended. A bare number here is a **percent**: `1.5` means 1.5%, not 150%. |
| **`places_feature` did not resolve.** | Constant across every seed and every biome. | Fix the identifier — and check its CASE only if you are comparing against a tool: the game lower-cases both sides of this lookup, so a case mismatch resolves in game. |

The first three are the ones a rule file can get wrong while looking entirely correct: in each
case the file loads, the rule exists, and nothing ever runs it.

Of the remaining four, the biome filter and an unresolved reference will never place anything at
any seed in any world; the middle two look identical to each other in-game and are separated only
by retrying, since a chance rejection eventually places and a zero `iterations` never does. [Test at several
seeds before believing a placement is
broken](./rng-and-determinism.md#what-this-means-when-you-are-authoring) is the habit this table
exists to make concrete.

One failure is *not* quiet: a rule whose delegation is refused by the recursion guard
content-logs `Feature rule <name> can't place internal feature`. If a rule places nothing and
that line appears, the problem is a reference loop, not the filter — see [the recursion
guard](./feature-delegation.md#the-recursion-guard-and-what-cannot-place-internal-feature-means).

Everything else stays silent by design; a chunk runs hundreds of refusals per pass and a log line
each would be unusable. [Failure is normal, and mostly
quiet](./feature-delegation.md#failure-is-normal-and-mostly-quiet) covers why, and how to work
down a chain instead of guessing.

::: note
featurelab names all four causes above in its diagnostics — including the biome-filter rejection
the game has no reason to mention — because an unfiltered "nothing happened" is indistinguishable
from a bug. That is bench tooling, not engine behaviour: the game does not print these lines. See
[how claims on these pages are
backed](./coverage-and-known-gaps.md#how-claims-on-these-pages-are-backed).
:::

## See also

- [Scatter Features](./scatter-feature.md) — the distribution block a rule uses, kind for kind
  and draw for draw. Read that page's distribution sections as if they were this one's.
- [RNG and Determinism in World Generation](./rng-and-determinism.md) — where a rule's seed comes
  from, why renaming one moves it, and the two independent streams every decoration entry gets.
- [Feature Delegation and Composite Features](./feature-delegation.md) — what happens below a
  rule: the shared stream and Molang scope, the recursion guard, and why most refusals are quiet.
- [Single Block Features](./single-block-feature.md) — the far end of almost every rule's chain.
