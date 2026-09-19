---
title: Delegation and composite features
description: Most of what a pack places, it places through something else. What crosses a delegation boundary and what does not — the origin, the shared random stream, the Molang scope, the world — plus the recursion guard, what a delegate hands back, and why most failures are silent. Measured against Minecraft Bedrock 1.26.50.24.
category: guide
game: 1.26.50.24
scope: game
---

# Delegation and composite features

<VersionBadge />

**Most of what a pack places, it places through something else.** A scatter picks positions and hands each one to another feature; a snap-to-surface finds a floor and hands the position on; a sequence walks a list. The feature that finally writes a block is usually three or four delegations deep, and the interesting behaviour lives in the *boundaries* between them rather than at either end.

This page is about those boundaries: what crosses one, what does not, and what a delegate hands back. Each Proxy feature's own page describes what it does; this is the part they all share, so they do not each have to re-explain it.

## What crosses a delegation boundary {#what-crosses}

A delegating feature calls the delegate with a placement context. Four things travel in it, and they behave differently from each other:

| Travels | Behaviour |
|---|---|
| **The origin** | Either substituted by the delegator or passed through unchanged — see [the table below](#the-origin). It is the *only* field several Proxy types touch at all. |
| **The random stream** | Shared, by reference, down the entire chain — including the stream a scatter *inside* the chain draws its own offsets from. A delegate's draws advance the same stream its siblings and its parent draw from. |
| **The Molang scope** | Shared, by reference, down the entire chain — `variable.` and `temp.` written anywhere are visible everywhere. |
| **The world** | The same world view, except inside [search features](./search_feature.md), which point their delegate at a transactional buffer instead. |

And one thing blocks the boundary rather than crossing it: the [recursion guard](#the-recursion-guard), below.

## The origin: substituted or passed through {#the-origin}

Half the point of a Proxy feature is *where* it delegates. The other half is deciding *whether* — and the types that only decide whether pass the origin through untouched:

| Feature | Origin the delegate receives |
|---|---|
| [Scatter](./scatter_feature.md) | `origin + this iteration's offset`, once per iteration |
| [Search](./search_feature.md) | `origin + the candidate offset` currently being tried |
| [Snap-to-surface](./snap_to_surface_feature.md) | Wherever the scan landed — the open cell next to the surface, or the surface block itself with `embed_in_surface` |
| [Sequence](./sequence_feature.md) | The position the previous *successful* entry returned; the original origin until something succeeds |
| [Aggregate](./aggregate_feature.md) | Unmodified, for every entry — literally the same context object |
| [Weighted random](./weighted_random_feature.md) | Unmodified |
| [Conditional list](./conditional_list.md) | Unmodified, for every entry whose condition passed |
| [Surface relative threshold](./surface_relative_threshold_feature.md) | Unmodified — a pure gate |
| [Height difference filter](./height_difference_filter_feature.md) | Unmodified — a pure gate |
| [Scan surface](./scan_surface.md) | One origin per column of the chunk, 256 delegations |

Two consequences worth stating plainly:

- **Aggregate really does mean "same cell".** Two entries that both place a block at the origin contend for it; the last one wins. Entries that offset themselves internally do not collide, because *they* move — the shared origin does not.
- **Sequence is a chain, not a list.** Because each entry runs at the previous one's *returned* position, a delegate that returns somewhere far away (a snap-to-surface returning wherever it landed) relocates everything after it. That is the mechanism behind the common "find a floor, then build on it" pattern.

## The random stream: shared, and in order {#the-random-stream}

Everything in a delegation chain draws from one stream, and draws happen in the order the chain executes. So the second entry of an aggregate sees whatever the first entry left the stream at: make the first entry draw one more time and the second entry places differently.

That is not a flaw to design around; it is what makes a whole chain reproducible from a seed. But it does mean **a change to one delegate is not local to that delegate.**

There is one boundary where that stops being true, and it sits *above* the chain rather than inside it. A **decoration entry** — a feature rule, or a feature a biome names directly — draws its positions from a second generator, seeded identically to the delegate's but advancing separately. So a delegate's draws cannot move the positions the **entry** picked for it: that is a property of the entry, not of scattering.

Everything below that boundary is on the one shared stream, nested `minecraft:scatter_feature`s included. A scatter inside a chain draws offset, delegate, offset, delegate from a single generator, so **a delegate that draws more does move the offsets that scatter picks after it** — the same edit that is inert against a feature rule's positions changes them one level down. See [RNG and determinism](./rng_and_determinism.md#3-that-seed-is-used-twice-for-two-independent-streams) for where the two streams come from and what else follows.

::: note A failure is not free either
It is easy to read "the first entry placed nothing, so it cost nothing" into this, and it is not true. Several types take their random values *before* the check that turns them down — a single block feature picks its block before it tests the neighbours, and a horizontal tree decoration picks its direction before it checks whether that side is open. A refused placement can therefore shift everything after it exactly as a successful one would. [The conditional list's own measurements](./conditional_list.md#random-draws) show a refused entry and a successful one moving a later scatter to precisely the same cells.
:::

## The Molang scope: one object, shared by everyone {#the-molang-scope}

A chain shares one Molang scope, by reference, from top to bottom. A `variable.` written by a scatter is readable by the feature it delegates to, and by that feature's own delegates, and it stays written after they return.

The most common use of this is not something a pack writes at all: a scatter publishes `variable.originx/originy/originz` once per call, and each axis's own coordinate into `variable.worldx/worldy/worldz` as that axis is evaluated. A delegate down the chain can read them — and a [conditional list](./conditional_list.md#condition-scope) further down the same chain reads them in its conditions, which is why `origin*` and `world*` can disagree by the time a condition sees them. See [Molang in world generation](./molang.md#scope-lifetime-temp-versus-variable) for the lifetime rules, including the sharp edge that `temp.` outlives the feature that wrote it.

## The recursion guard, and what "Cannot place internal feature" means {#the-recursion-guard}

Before delegating, a Proxy feature asks whether it is allowed to. The answer is no while **that same feature instance** is already inside a delegation of its own — the guard is keyed on the delegator, not on the delegate.

That phrasing matters, because it is easy to assume the opposite (a guard on the *callee*, i.e. "this feature is already being placed"). Keyed the way it actually is, a cycle is stopped at the point where it would repeat: `A → B → A` is refused at A's second delegation, since A is still inside its first.

A refused delegation is not silent — it content-logs `Cannot place internal feature`, and a feature rule's own path logs `Feature rule <name> can't place internal feature`. If a composite mysteriously places nothing, that line is the first thing to look for; it usually means a reference loop that looked innocent across three files.

::: note One type words it differently, which matters if you are searching a log
[`minecraft:conditional_list`](./conditional_list.md) logs `Cannot place an internal feature!` — with the article and the exclamation mark — where every other type logs the bare phrase above. Searching for the short form will not find it.
:::

The refusal also has a state effect inside [aggregate](./aggregate_feature.md) and [sequence](./sequence_feature.md) features: a guard denial *clears* the running result rather than leaving it alone, which is what a failed delegate does. So a denial mid-list both stops a `first_failure` sequence and resets the origin the next entry would have run at. A [conditional list](./conditional_list.md) ends its walk on a denial too, but keeps what earlier entries already placed.

## What a delegate hands back {#what-a-delegate-hands-back}

Every delegation returns either a position or nothing. "Nothing" means the feature declined; a position means it did something — and *what* the position means is up to the type. A snap-to-surface returns where it landed. A scatter returns its last iteration's result. A single-block returns the cell it wrote.

Two rules for reading that value:

- **A returned position is not a promise that blocks were written.** A composite can succeed having placed nothing at all, when the thing it delegated to succeeded that way in turn.
- **Only some callers care.** Sequence threads the value into the next entry's origin; aggregate keeps it only as the "did anything succeed yet" flag its `early_out` tests; most types ignore it beyond success/failure.

## Failure is normal, and mostly quiet {#failure-is-normal}

A delegation that declines is not an error, and most of the time nothing is logged: a gate that did not pass, an attach condition that did not match, a chance that did not roll. That is by design — a chunk runs hundreds of these per pass and a log line per refusal would be unusable.

The practical consequence is that "nothing appeared" is rarely one cause. Work down the chain: did the rule's biome filter match, did the distribution produce iterations, did each gate pass, did the final content feature find a legal cell. The per-type pages state which of those steps say something out loud and which stay quiet.

## What the bench does differently

featurelab reports each refusal it can attribute, including the ones the engine passes over in silence, and adds three limits the engine has no concept of — a delegation count budget, a write budget and a wall-clock placement deadline — so a run that would not finish truncates the preview instead of hanging it. All three are tooling, not engine behaviour: a real chunk has none of them. Each is a flag (`--delegation-budget`, `--write-budget`, `--placement-time-limit-ms`), and hitting any of them marks the result partial rather than failing it.

They do not overlap, so it is worth knowing which one catches what. The **delegation budget** counts nested placements, so it catches a reference loop — a chain that keeps delegating without converging — and only that. The **write budget** counts block-write attempts, so it catches a chain that writes without end; a loop that spends its time deciding *not* to write is invisible to it. Both are counts, which makes them reproducible: the same seed and the same pack hit them at the same point on any machine, every run.

The **placement deadline** is the one that covers a single feature's own work. A tree, a carver, a geode, an ore vein or a growing plant delegates to nothing and can decline every cell it looks at, so neither count above can see it — and several of their fields (`max_radius`, `count`, `search_radius`, `height_range`, most canopy dimensions) have no upper limit in the engine, so this bench does not invent one either. What bounds them is the clock. When it fires, the diagnostic names the loop and the field driving it, rather than only saying that time ran out. Being wall-clock, it is the one limit here that is **not** reproducible: where it cuts off depends on how fast that particular run happened to be, so a preview that changed between runs may have changed for that reason and nothing else. Its own message says so. If you need a truncation that reproduces for a given seed, lower `--delegation-budget` instead.

## See also

- [RNG and determinism](./rng_and_determinism.md) — where the shared stream comes from, and the second stream a decoration entry's positions come from.
- [Aggregate features](./aggregate_feature.md) and [sequence features](./sequence_feature.md) — the two types whose whole behaviour is this page's subject matter, and the pair that shows the substituted-origin rule at its clearest.
- [Scatter features](./scatter_feature.md) — the most common delegator in real packs.
- [Weighted random](./weighted_random_feature.md) and [conditional list](./conditional_list.md) — the two types that choose *which* delegate rather than *where*, by luck and by condition respectively.
- [Search features](./search_feature.md) — the one type that changes the world a delegate sees, not just the position.
- [Snap-to-surface features](./snap_to_surface_feature.md) — the origin substitution that most often ends up in the middle of a chain.
- [Feature rules](./feature_rules.md) — the decoration entry above every chain, and the boundary where the two streams split.
- [Molang in world generation](./molang.md) — what the shared scope means for expressions evaluated anywhere in the chain.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**. What crosses a boundary, which types substitute the origin, how the recursion guard is keyed, and what a denial does to an aggregate's running result are stated as facts about the game; each was read against the type it is about, and each per-type row is repeated — with its own measurements — on that type's own page. The two log wordings are quoted exactly as the game emits them, which is the only reason the difference between them is worth a paragraph.

The three limits in [what the bench does differently](#what-the-bench-does-differently) are statements about featurelab and about nothing else: the game has no delegation budget, no write budget and no placement deadline, and the wall-clock one is explicitly not reproducible. What is *not* claimed here is any per-type accounting — how much any one type spends, and in what order, is on that type's own page, under its `## Advanced` heading, next to the fields it is about.
