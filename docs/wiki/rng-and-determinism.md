# RNG and Determinism in World Generation

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. Worldgen internals move between releases; nothing here should be assumed to hold
for a different build without checking.

Worldgen is not random. It is *deterministic from a seed*: the same world seed, the same pack,
and the same chunk produce the same blocks, every time, on every device. Everything a feature
does that looks random is a **draw** from a generator whose starting value the engine derived
from that seed — and the whole system only works because every draw happens in a fixed order,
the same order, every run.

That has a consequence pack authors meet the hard way: **changing one feature can move another
one**, and adding a field that "shouldn't matter" can repaint a whole biome. This page is about
which changes do that, which don't, and why.

The individual feature pages state how many draws each type spends and in what order — this
page is the model those statements fit into.

## The generator, and its five draw kinds

Every feature draws from the same kind of generator: a seeded pseudo-random source with 32-bit
state. What matters for authoring is not its internals but the five operations features actually
use, because each one has a different range and a different failure mode:

| Draw | Range | Notes |
|---|---|---|
| the unbounded integer draw | the full non-negative 31-bit range | Used where a value is immediately reduced (`% n`) or compared. |
| the bounded integer draw | `[0, bound)` | **`bound == 0` returns 0 and draws nothing at all.** |
| the inclusive bounded draw | `[min, max]` — inclusive at the top | **`max < min` returns `min` and draws nothing** — strictly less than. `max == min` still draws, with a bound of 1. |
| the float draw | `[0, 1)` | Percent gates compare the drawn float times 100 against the percentage. |
| the raw unsigned draw | `[0, n)` from a raw 32-bit value | A different, wider value than the unbounded integer draw, used for rotation. |

The two "draws nothing" rows are not trivia. A draw that does not happen does not advance the
stream, so every later draw in that feature — and every feature downstream of it in the same
delegation chain — gets a different value than it would have if the draw had happened. This is
the single most common source of "I changed something harmless and the whole patch moved":

::: warning
`{"distribution": "uniform", "extent": [5, 5]}` looks like a random axis and behaves exactly like
the bare number `5`, including spending **no** draw. See [Scatter
Features](./scatter-feature.md#distributionxyz-and-coordinate_eval_order) for a reproducible
demonstration with three fixture features and their resulting coordinates.
:::

## Where a feature's seed comes from

A feature never picks its own seed. The engine derives one in three steps, and each step exists
to make a specific kind of change *not* disturb everything else.

### 1. The chunk gets a decoration seed

Before decorating a chunk, the engine derives a seed for it from the world seed and the chunk's
own coordinates. Two multipliers are drawn once from the world seed and forced odd; the chunk's
x and z are multiplied by them, summed, and mixed back against the world seed.

The practical consequences:

- **Chunks are independent.** Chunk (10, 4) decorates the same way whether or not chunk (9, 4)
  was ever generated, and in whatever order the game happens to load them. Nothing accumulates
  across a chunk boundary.
- **A world seed genuinely reseeds everything.** Testing a feature at several seeds tests it
  against genuinely different chunk streams, not against the same stream at a different offset.

### 2. Each decoration entry in the chunk gets its own seed

A chunk's decoration list — every feature a biome places, and every feature rule that applies
there — is not run off one shared stream. Each entry's seed comes from combining the chunk seed
with a **hash of the entry's name**.

That detail is worth dwelling on, because it is the one that surprises people:

- **Adding, removing or reordering entries does not disturb the others.** A new feature in a
  biome gets its own stream. The features that were already there keep placing exactly where
  they placed before. (Contrast the alternative — one stream per chunk — where inserting one
  entry would shift every entry after it.)
- **Renaming a feature moves it.** The name is an input to the seed, so `wiki:my_flowers` and
  `wiki:my_flowers_v2`, identical in every other respect, scatter differently in the same chunk
  of the same world. Renaming is not a cosmetic change to worldgen output.

::: note
For a **feature rule**, the name that gets hashed is the rule's own `description.identifier` —
not the feature it places. So renaming a
rule moves everything that rule places, and renaming the feature it points at moves nothing.
:::

### 3. That seed is used twice, for two independent streams

From the entry's seed the engine builds **two** generators, both starting at that same value:

- one the entry's own **distribution** draws positions from,
- one the entry's **delegated feature** — and everything below it — draws from.

They advance separately. That split happens **once, at the decoration entry**, and the word
*entry* is load-bearing: an entry is a feature rule, or a feature a biome names directly. The
split is not a property of the distribution machinery in general, so a
`minecraft:scatter_feature` sitting inside a feature does not get one — it hands its delegate the
very generator it drew its own offsets from.

**At the entry, the two streams are independent:**

- **The delegated feature's own draws never move the positions the entry picked for it.** Give
  the delegate a `randomize_rotation`, or swap a one-block delegate for a whole tree, and the
  entry's *positions* stay exactly where they were.
- **Conversely, changing the entry's distribution does not change what each placement rolls
  internally** beyond moving it — the delegate's stream starts from the same seed either way.

**Below the entry there is one stream, and a delegate's draws do move positions.** A scatter
nested inside a feature draws in iteration order — offset, delegate, offset, delegate — from the
one generator it also hands down, so a delegate that draws one more time shifts every offset
that scatter picks *after* it. That same `randomize_rotation` is inert one level up and
layout-changing here: at a fixed seed, adding it to the delegate of a nested scatter moves the
cells the scatter chooses, while adding it to the delegate of a feature rule leaves them
identical. When a patch moves after an edit that "only" changed a block deep in the chain, this
is usually why.

Within one entry, the delegate's stream is shared across *all* of that entry's placements, in
order: the second position's feature continues where the first one left off. So a change that
makes the first placement draw more (a taller tree, an extra weighted candidate) does still
change what the second placement rolls. Independence is between the two streams, not between
positions.

## Draw order is part of a feature's contract

Because a stream is a sequence, *when* a feature draws matters as much as how often. Two rules
follow from that, both of which show up in real packs:

**A failed placement can still have spent draws.** Refusal is not free. The clearest case is
[Horizontal Tree Decoration](./horizontal-tree-decoration-feature.md): it draws its direction
*first*, then checks whether that side is free — so a refusal has consumed a draw and shifted
everything after it, while a success consumes two. Several types work this way; each page's
"Mechanics and placement sequence" section calls out where its draws sit relative to its checks.

**Gates that pass without drawing are common and deliberate.** A `scatter_chance` of `100` (the
default) spends nothing; a fraction whose numerator equals its denominator spends nothing; a
weighted list whose weights sum to zero spends nothing and picks nothing. These are the same
"no draw" cases as the table above, one level up.

## The no-draw catalogue

Everything below returns a value without touching the stream. Each is documented on its own
page; collected here because "does this spend a draw?" is the question this page exists to
answer.

| Situation | Result |
|---|---|
| the bounded integer draw with a bound of `0` | `0` |
| the inclusive bounded draw with `max < min` — **strictly** less | `min` |
| `gaussian` or `inverse_gaussian` axis narrower than 2 | its half is `0`, so neither half draws |
| `uniform` axis with `max <= min` | the fixed value, like a bare number |
| `fixed_grid` axis (any step) | walks a grid index, never draws |
| `jittered_grid` axis with `step_size < 2` | no jitter to draw |
| a bare number or Molang string as an axis | evaluated, never drawn |
| `scatter_chance` >= 100 | always, decided without a draw |
| a constant `scatter_chance` <= 0 | **always** — the value is out of range, so the game reports it and uses 100; no draw |
| a Molang `scatter_chance` that evaluates to <= 0 | never, decided without a draw |
| `scatter_chance` fraction with `numerator == denominator` | always, no draw |
| weighted pick whose weights sum to zero | nothing is picked, no draw |
| weighted pick over an empty list | nothing is picked, no draw |

::: note
Weights are summed as integers, truncating **after every entry**. Two entries weighted `0.5`
sum to zero — so nothing is picked, and no draw is spent. Fractional weights are not a finer
grain of control; below `1` they are simply zero. See [Single Block
Features](./single-block-feature.md#weighted-candidate-list) and [Weighted Random
Features](./weighted-random-feature.md).
:::

## Molang draws are the feature's draws — where a seeded source is installed

`math.random`, `math.die_roll` and their variants are draws like any other, spent from the
placing feature's own stream in the order the expression is evaluated. That is because the
distribution path *installs* that stream as the expression's random source before evaluating
anything.

Not every path does. The random source is a property of the evaluation parameters, and its
default is a process-global generator with no world seed behind it — a path that installs
nothing gets that instead, and its `math.random` does not repeat from run to run even at a fixed
world seed, in the real game. The known case is the cave carvers' `width_modifier`. So "is this
Molang random reproducible?" is a question about *where the expression sits*, not about the
function it calls. See [Molang in World
Generation](./molang-in-world-generation.md#namespaces-and-short-aliases) for the
detail.

## What this means when you are authoring

**Test at several seeds before believing a placement is broken.** A feature that places nothing
at one seed may be unlucky rather than misconfigured — a `scatter_chance` that did not roll, an
`iterations` expression that evaluated to zero, an attach condition that happened to face the
wrong way. The failure that matters is the one that reproduces across seeds.

**Expect a layout change when you rename anything a decoration list refers to.** If a rename
must not move existing content, it is not a rename you can make.

**Don't read a moved feature as a broken one.** If a patch shifts after you edit a *different*
feature in the same entry chain, that is the stream doing its job, not a bug — and that
includes *where* things sit, whenever the chain contains a scatter below the entry, since its
offsets come off the same stream as its delegate's draws. What would be a bug is an unrelated
feature in the same chunk moving — that one can only happen through the name hash, i.e. a
rename.

**Guard patterns rely on draw order.** The idiomatic "test, then act" shape — a probe feature at
the front of a [Sequence](./aggregate-and-sequence-feature.md#sequence_feature) — depends on the
sequence stopping at the first failure while nothing has succeeded yet. That contract is about
control flow, but its *cost* is about draws: a sequence that stops early has spent only the
draws of the entries it actually ran.

## Reproducing the seeding rules yourself

The fixture pack this documentation set uses carries two feature rules that differ in exactly one
thing: their identifiers. They place the same feature, through identical distributions, at the
same seed, in the same four chunks.

```
featurelab generate --pack docs/wiki/tools/fixtures --rule wiki:rng_rule_a.fr   --env void --seed 42 --size 32x16x32 --min-y 0
featurelab generate --pack docs/wiki/tools/fixtures --rule wiki:rng_rule_b.fr   --env void --seed 42 --size 32x16x32 --min-y 0
```

Eight iterations per chunk, four chunks, 32 attempts each — and no coordinate in common:

| Rule | first four cells (x, z) | placed |
|---|---|---|
| `wiki:rng_rule_a.fr` | `(-16, 5)`, `(-16, 10)`, `(-15, -6)`, `(-14, -7)` | 32 |
| `wiki:rng_rule_b.fr` | `(-15, -10)`, `(-14, -16)`, `(-14, -13)`, `(-14, -11)` | 31 |

The two files ([`rng_rule_a.fr.json`](./tools/fixtures/feature_rules/rng_rule_a.fr.json),
[`rng_rule_b.fr.json`](./tools/fixtures/feature_rules/rng_rule_b.fr.json)) are byte-identical
apart from that identifier, and both place
[`rng_marker.json`](./tools/fixtures/features/rng_marker.json). The layout difference is the
identifier's hash and nothing else. (Rule B places 31 rather than 32 because two of its 32
attempts landed on the same cell — a coincidence of its own stream, not a rule about anything.)

Both runs also spread their work evenly across all four chunks — eight attempts in each, never
a chunk that got the whole rule and three that got nothing — which is the per-chunk half of the
derivation showing through.

## See also

- [Scatter Features](./scatter-feature.md) — the per-distribution draw table, and the
  degenerate-`uniform` demonstration.
- [Molang in World Generation](./molang-in-world-generation.md) — `math.random` and
  `math.die_roll` draw from the placing feature's own stream, so an expression evaluated
  mid-distribution is not a side channel: it spends draws like everything else here.
- [Single Block Features](./single-block-feature.md) — the weighted pick, the one draw almost
  every pack spends.
- [Horizontal Tree Decoration Features](./horizontal-tree-decoration-feature.md) — the clearest
  example of a refusal that has already spent a draw.
