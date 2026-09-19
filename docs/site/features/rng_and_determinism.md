---
title: RNG and determinism
description: Worldgen is deterministic from a seed. Where a feature's seed comes from, why renaming one moves everything it places, which situations skip their random draw entirely, and why draw order is part of a feature's contract — measured against Minecraft Bedrock 1.26.50.24.
category: guide
game: 1.26.50.24
scope: game
---

# RNG and determinism

<VersionBadge />

**Worldgen is not random. It is deterministic from a seed**: the same world seed, the same pack and the same chunk produce the same blocks, every time, on every device. Everything a feature does that looks random is a **draw** from a generator whose starting value the engine derived from that seed — and the whole system only works because every draw happens in a fixed order, the same order, every run.

That has a consequence pack authors meet the hard way: **changing one feature can move another one**, and adding a field that "shouldn't matter" can repaint a whole biome. This page is about which changes do that, which do not, and why.

## What is on this page, and what is on the type pages {#the-split}

This page is the **model**: where a seed comes from, which streams exist, what advances them, and which situations return a value without touching one at all. It is the same for every feature type.

The **numbers** are on the type pages, next to the fields they are about. Each type page's `## Advanced` section states how many draws that type spends, on what, and in which order — the [scatter feature](./scatter_feature.md#random-draws) is the worked example, and every table in this page's [no-draw catalogue](#the-no-draw-catalogue) links to the page that owns its numbers. Nothing is repeated in both places: if you want to know what `gaussian` costs, the scatter page says; if you want to know why a skipped draw moves everything after it, this page says.

## What this means when you are authoring {#what-this-means-when-you-are-authoring}

Four rules follow from everything below, and they are the part you act on:

**Test at several seeds before believing a placement is broken.** A feature that places nothing at one seed may be unlucky rather than misconfigured — a `scatter_chance` that did not roll, an `iterations` expression that evaluated to zero, an attach condition that happened to face the wrong way. The failure that matters is the one that reproduces across seeds.

**Expect a layout change when you rename anything a decoration list refers to.** If a rename must not move existing content, it is not a rename you can make.

**Don't read a moved feature as a broken one.** If a patch shifts after you edit a *different* feature in the same chain, that is the seeding doing its job, not a bug — and that includes *where* things sit, whenever the chain contains a scatter below the entry, since its offsets come off the same generator as its delegate's values. What would be a bug is an unrelated feature in the same chunk moving — that one can only happen through the name hash, i.e. a rename.

**Guard patterns rely on ordering.** The idiomatic "test, then act" shape — a probe feature at the front of a [sequence](./sequence_feature.md#where-the-list-stops) — depends on the sequence stopping at the first failure while nothing has succeeded yet. That contract is about control flow, but its *cost* is about the stream: a sequence that stops early has run only the entries it actually reached.

## Where a feature's seed comes from {#where-a-features-seed-comes-from}

A feature never picks its own seed. The engine derives one in three steps, and each step exists to make a specific kind of change *not* disturb everything else.

### 1. The chunk gets a decoration seed {#1-the-chunk-gets-a-decoration-seed}

Before decorating a chunk, the engine derives a seed for it from the world seed and the chunk's own coordinates. Two multipliers are drawn once from the world seed and forced odd; the chunk's x and z are multiplied by them, summed, and mixed back against the world seed.

The practical consequences:

- **Chunks are independent.** Chunk (10, 4) decorates the same way whether or not chunk (9, 4) was ever generated, and in whatever order the game happens to load them. Nothing accumulates across a chunk boundary.
- **A world seed genuinely reseeds everything.** Testing a feature at several seeds tests it against genuinely different chunks, not against the same layout at a different offset.

### 2. Each decoration entry in the chunk gets its own seed {#2-each-decoration-entry-in-the-chunk-gets-its-own-seed}

A chunk's decoration list — every feature a biome places, and every [feature rule](./feature_rules.md) that applies there — is not run off one shared source. Each entry's seed comes from combining the chunk seed with a **hash of the entry's name**.

That detail is worth dwelling on, because it is the one that surprises people:

- **Adding, removing or reordering entries does not disturb the others.** A new feature in a biome gets its own sequence of values. The features that were already there keep placing exactly where they placed before. (Contrast the alternative — one source per chunk — where inserting one entry would shift every entry after it.)
- **Renaming a feature moves it.** The name is an input to the seed, so `wiki:my_flowers` and `wiki:my_flowers_v2`, identical in every other respect, scatter differently in the same chunk of the same world. Renaming is not a cosmetic change to worldgen output.

::: note
For a **feature rule**, the name that gets hashed is the rule's own `description.identifier` — not the feature it places. So renaming a rule moves everything that rule places, and renaming the feature it points at moves nothing. [What moves a rule's output](./feature_rules.md#seeding) is the same fact from the rule file's side.
:::

### 3. That seed is used twice, for two independent streams {#3-that-seed-is-used-twice-for-two-independent-streams}

From the entry's seed the engine builds **two** generators, both starting at that same value:

- one the entry's own **distribution** draws positions from,
- one the entry's **delegated feature** — and everything below it — draws from.

They advance separately. That split happens **once, at the decoration entry**, and the word *entry* is load-bearing: an entry is a feature rule, or a feature a biome names directly. The split is not a property of the distribution machinery in general, so a [`minecraft:scatter_feature`](./scatter_feature.md) sitting inside a feature does not get one — it hands its delegate the very generator it drew its own offsets from.

**At the entry, the two streams are independent:**

- **The delegated feature's own values never move the positions the entry picked for it.** Give the delegate a `randomize_rotation`, or swap a one-block delegate for a whole tree, and the entry's *positions* stay exactly where they were.
- **Conversely, changing the entry's distribution does not change what each placement rolls internally** beyond moving it — the delegate's generator starts from the same seed either way.

**Below the entry there is one stream, and a delegate does move positions.** A scatter nested inside a feature works in iteration order — offset, delegate, offset, delegate — from the one generator it also hands down, so a delegate that draws one more time shifts every offset that scatter picks *after* it. That same `randomize_rotation` is inert one level up and layout-changing here: at a fixed seed, adding it to the delegate of a nested scatter moves the cells the scatter chooses, while adding it to the delegate of a feature rule leaves them identical. When a patch moves after an edit that "only" changed a block deep in the chain, this is usually why.

Within one entry, the delegate's stream is shared across *all* of that entry's placements, in order: the second position's feature continues where the first one left off. So a change that makes the first placement draw more (a taller tree, an extra weighted candidate) does still change what the second placement rolls. Independence is between the two streams, not between positions.

## Order is part of a feature's contract {#draw-order-is-part-of-a-features-contract}

Because a generator produces a sequence, *when* a feature takes a value from it matters as much as how often. Two rules follow, both of which show up in real packs:

**A failed placement is not free.** The clearest case is [horizontal tree decoration](./horizontal_tree_decoration_feature.md#random-draws): it picks its direction *first*, then checks whether that side is free — so a refusal has already taken a value and shifted everything after it, while a success takes two. Several types work this way, and each type page's `## Advanced` section says where its values are taken relative to its checks.

**Gates that pass without taking a value are common and deliberate.** A `scatter_chance` of `100` (the default) takes nothing; a fraction whose numerator equals its denominator takes nothing; a weighted list whose weights sum to zero takes nothing and picks nothing. Those are the catalogue below, and they are why "I changed something harmless and the whole patch moved" happens at all.

## The no-draw catalogue {#the-no-draw-catalogue}

Everything below returns a value **without advancing the stream**. That is the question this page exists to answer, because a draw that does not happen is exactly what shifts every later value in the same chain — and the situations are not obvious from the JSON. What each one *costs* when it is not degenerate is on the type page named beside it, never here.

| Situation | Result | Where its accounting is |
|---|---|---|
| the bounded integer draw with a bound of `0` | `0` | [the generator](#the-generator-and-its-five-draw-kinds), below |
| the inclusive bounded draw with `max < min` — **strictly** less | `min` | [the generator](#the-generator-and-its-five-draw-kinds), below |
| `gaussian` axis narrower than 2 | its half is `0`, so neither half draws | [scatter](./scatter_feature.md#random-draws) |
| `uniform` axis with `max <= min` | the fixed value, like a bare number | [scatter](./scatter_feature.md#a-degenerate-uniform-axis-draws-nothing) |
| `fixed_grid` axis (any step) | walks a grid index, never draws | [scatter](./scatter_feature.md#random-draws) |
| `jittered_grid` axis with `step_size < 2` | no jitter to draw | [scatter](./scatter_feature.md#random-draws) |
| a bare number or Molang string as an axis | evaluated, never drawn | [scatter](./scatter_feature.md#random-draws) |
| `scatter_chance` >= 100 | always, decided without a draw | [scatter](./scatter_feature.md#scatter-chance) |
| a constant `scatter_chance` <= 0 | **always** — the value is out of range, so the game reports it and uses 100; no draw | [scatter](./scatter_feature.md#scatter-chance) |
| a Molang `scatter_chance` that evaluates to <= 0 | never, decided without a draw | [scatter](./scatter_feature.md#scatter-chance) |
| `scatter_chance` fraction with `numerator == denominator` | always, no draw | [scatter](./scatter_feature.md#scatter-chance) |
| weighted pick whose weights sum to zero | nothing is picked, no draw | [single block](./single_block_feature.md#random-draws) |
| a weighted list of *features* whose weights sum to zero | nothing is picked, no draw | [weighted random](./weighted_random_feature.md#random-draws) |

::: warning `inverse_gaussian` is the one kind with no free case
It is not in the table above, and its absence is the point. Narrowing an `inverse_gaussian` axis to less than 2 zeroes both of its halves, exactly as it does for `gaussian` — but the two halves then tie, and a tie is what triggers the kind's boolean tie-break. So a degenerate `inverse_gaussian` axis still spends **one** draw where a degenerate `gaussian` spends none, and pinning one is not free. See [the scatter page's draw table](./scatter_feature.md#random-draws), which states the same thing as "this kind never spends zero".
:::

::: warning A degenerate axis is the commonest way to move a patch by accident
`{"distribution": "uniform", "extent": [5, 5]}` looks like a random axis and behaves exactly like the bare number `5`, including spending **no** draw — so every later position in that feature comes out somewhere else than it would have if the axis had been a real range. The scatter page reproduces it with three fixture features and their resulting coordinates: [a degenerate `uniform` axis draws nothing](./scatter_feature.md#a-degenerate-uniform-axis-draws-nothing).
:::

::: note
Weights are summed as integers, truncating **after every entry**. Two entries weighted `0.5` sum to zero — so nothing is picked, and no draw is spent. Fractional weights are not a finer grain of control; below `1` they are simply zero. See [the single block feature's weighted pick](./single_block_feature.md#random-draws) and [weighted random features](./weighted_random_feature.md#random-draws), whose whole type is that one pick. An *empty* list never gets that far: both `places_block` and a weighted random's `features` are refused when the file loads, so the zero total always comes from the weights themselves.
:::

## The generator, and its five draw kinds {#the-generator-and-its-five-draw-kinds}

Every feature draws from the same kind of generator: a seeded pseudo-random source with 32-bit state. You do not need its internals to author a pack — what the type pages' `## Advanced` sections name, and what the two "draws nothing" rows above come from, is the five operations features actually use, because each one has a different range and a different failure mode:

| Draw | Range | Notes |
|---|---|---|
| the unbounded integer draw | the full non-negative 31-bit range | Used where a value is immediately reduced (`% n`) or compared. |
| the bounded integer draw | `[0, bound)` | **`bound == 0` returns 0 and draws nothing at all.** |
| the inclusive bounded draw | `[min, max]` — inclusive at the top | **`max < min` returns `min` and draws nothing** — strictly less than. `max == min` still draws, with a bound of 1. |
| the float draw | `[0, 1)` | Percent gates compare the drawn float times 100 against the percentage. |
| the raw unsigned draw | `[0, n)` from a raw 32-bit value | A different, wider value than the unbounded integer draw, used for rotation. |

Which of the five a given key uses is part of that type's contract, because it decides the range of values as well as the position in the sequence — and that is stated per type, in the type page's `## Advanced` section rather than here.

## Molang randoms are the feature's own — where a seeded source is installed

`math.random`, `math.die_roll` and their variants are draws like any other, taken from the placing feature's own generator in the order the expression is evaluated. That is because the distribution path *installs* that generator as the expression's random source before evaluating anything.

Not every path does. The random source is a property of the evaluation parameters, and its default is a process-global generator with no world seed behind it — a path that installs nothing gets that instead, and its `math.random` does not repeat from run to run even at a fixed world seed, in the real game. The known case is the cave carvers' `width_modifier`. So "is this Molang random reproducible?" is a question about *where the expression sits*, not about the function it calls. See [Molang in world generation](./molang.md#random-numbers) for the detail, and for what each of the four random functions actually returns.

## Reproducing the seeding rules yourself {#reproducing-the-seeding-rules-yourself}

The fixture pack this documentation set uses carries two feature rules that differ in exactly one thing: their identifiers. They place the same feature, through identical distributions, at the same seed, in the same four chunks.

```
featurelab generate --pack docs/wiki/tools/fixtures --rule wiki:rng_rule_a.fr   --env void --seed 42 --size 32x16x32 --min-y 0
featurelab generate --pack docs/wiki/tools/fixtures --rule wiki:rng_rule_b.fr   --env void --seed 42 --size 32x16x32 --min-y 0
```

Eight iterations per chunk, four chunks, 32 attempts each — and no coordinate in common:

| Rule | first four cells (x, z) | placed |
|---|---|---|
| `wiki:rng_rule_a.fr` | `(-16, 5)`, `(-16, 10)`, `(-15, -6)`, `(-14, -7)` | 32 |
| `wiki:rng_rule_b.fr` | `(-15, -10)`, `(-14, -16)`, `(-14, -13)`, `(-14, -11)` | 31 |

The two files ([`rng_rule_a.fr.json`](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/fixtures/feature_rules/rng_rule_a.fr.json), [`rng_rule_b.fr.json`](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/fixtures/feature_rules/rng_rule_b.fr.json)) are byte-identical apart from that identifier, and both place [`rng_marker.json`](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/fixtures/features/rng_marker.json). The layout difference is the identifier's hash and nothing else. (Rule B places 31 rather than 32 because two of its 32 attempts landed on the same cell — a coincidence of its own stream, not a rule about anything.)

Both runs also spread their work evenly across all four chunks — eight attempts in each, never a chunk that got the whole rule and three that got nothing — which is the per-chunk half of the derivation showing through.

## What the bench does differently

The seeding chain above is the game's. Two things about running it on the bench are not:

- **Two random sources the game does not make reproducible** — the cave carvers' `width_modifier` and the multiface spread order — draw, in the game, from generators with no world seed behind them, so no two runs of the *game* agree either. The bench substitutes seed-derived values so a preview stays stable while you edit, and says so in its diagnostics.
- **Bit-for-bit reproduction of the game's sequence of values is not a goal of the bench.** Which situations draw, how often and in what order are modelled exactly, because those are behaviour and this page is about them; the exact values are not chased where the two disagree, and where a page knows they differ it says so. See [coverage and known gaps](../engine/coverage.md#deliberate-scope-decisions).

## See also

- [Scatter feature](./scatter_feature.md) — the type most of this page's examples are about, and whose `## Advanced` section holds the per-kind accounting this page deliberately does not repeat.
- [Feature rules](./feature_rules.md) — a rule *is* a decoration entry, so steps 2 and 3 above are its whole seeding story; the page reproduces the rename effect from two committed fixtures.
- [Delegation and composite features](./feature_delegation.md#the-random-stream) — what "below the entry there is one stream" means for a chain of Proxy features.
- [Molang in world generation](./molang.md) — `math.random` and `math.die_roll` come from the placing feature's own generator, so an expression evaluated mid-distribution is not a side channel.
- [Single block features](./single_block_feature.md#random-draws) — the weighted pick, the one draw almost every pack spends.
- [Horizontal tree decoration features](./horizontal_tree_decoration_feature.md#random-draws) — the clearest example of a refusal that has already taken a value.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**. The three-step derivation, the two-stream split and the five draw kinds are stated as facts about the game. The per-chunk spread and the rename effect are reproduced from the two committed rule fixtures and the commands above, whose counts and coordinates were read back out of `featurelab generate`'s result; the same two runs back [the feature rules page](./feature_rules.md#reproducing-it). The degenerate-`uniform` claim is reproduced on [the scatter page](./scatter_feature.md#a-degenerate-uniform-axis-draws-nothing) from three fixture features, not here, so that the numbers sit with the type that owns them. What is *not* claimed: the exact hash the entry name goes through, and the reason `pregeneration_pass` sits outside the ordered passes — neither is needed to predict what moves and what does not.
