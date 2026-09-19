---
title: Coverage and known gaps
description: How far featurelab's checking goes — which feature types the bench implements fully, which partially and what each gap means for a pack, the approximations that cut across every page, and what has and has not been checked against real content.
scope: bench
game: 1.26.50.24
---

# Coverage and known gaps

<VersionBadge />

<script setup>
import { withBase } from 'vitepress'
import coverage from '../generated/coverage.json'

// Every count and every type name in the "Type coverage" section below comes from this file,
// which is `featurelab types --json` written out by `npm run generate` before each build. The
// wiki page this one replaces typed the counts into prose ("22 fully, 5 partially, 2"), which
// was correct on the day it was written and wrong the day features/coverage.go changed. Nothing
// here can go stale that way: what is hand-written is the PROSE about each gap, below, which is
// worth more than the engine's own note and cannot be derived from it.
const s = coverage.summary
const partial = coverage.types.filter((t) => t.status === 'partial')
const outOfScope = coverage.types.filter((t) => t.status === 'out_of_scope')
const missing = coverage.types.filter((t) => t.status === 'missing')

// The hand-written half: one line per partial type, and the section on this page that explains
// it. A type the engine moves to `partial` without a write-up here still appears in the table,
// carrying the engine's own note, marked as not yet written up -- so the page reports a new gap
// rather than hiding it.
const gaps = {
  'minecraft:single_block_feature': { anchor: 'gap-single-block', summary: 'Whether a directional state is rewritten, not the rotation itself' },
  'minecraft:snap_to_surface_feature': { anchor: 'gap-snap-to-surface', summary: 'How the allowed-surface-blocks list compares block states' },
  'minecraft:geode_feature': { anchor: 'gap-geode', summary: 'Whether a bud may attach to a cavity wall, for non-vanilla blocks' },
  'minecraft:sculk_patch_feature': { anchor: 'gap-sculk-patch', summary: 'The spread and growth simulation, which refuses rather than approximating' },
  'minecraft:horizontal_tree_decoration_feature': { anchor: 'gap-horizontal-tree-decoration', summary: 'The check that the block declares the two states it needs' },
}
const routeOf = (typeId) => withBase('/features/' + typeId.replace(/^minecraft:/, ''))
</script>

**This page describes how far the checking goes, not what the game does.** Every other page in this set describes Minecraft Bedrock **1.26.50.24**; this one says which of those claims were reproduced against a running implementation, which are less certain, and where the tool used to write them knowingly does something different from the game. It exists so that the silences elsewhere are legible: a page that does not mention a field is not the same as a page that mentions it and says it was never exercised.

The tool is **featurelab**, a bench that loads a behaviour pack, runs one feature or one feature rule in a controlled volume, and reports the cells it wrote. Everything below is about the distance between that bench and the game.

## Type coverage {#type-coverage}

<p>
  The game accepts <strong>{{ s.total }}</strong> JSON feature types in this version. Of those the bench
  implements <strong>{{ s.implemented }}</strong> fully and <strong>{{ s.partial }}</strong> partially, and
  deliberately does not implement <strong>{{ s.outOfScope }}</strong><span v-if="s.missing > 0">; <strong>{{ s.missing }}</strong>
  are neither implemented nor out of scope</span>.
</p>

<p>
  The <span v-if="outOfScope.length === 2">two</span><span v-else>{{ outOfScope.length }}</span> it does not implement are<template v-for="(t, i) in outOfScope" :key="t.typeId"><span v-if="i > 0 && i === outOfScope.length - 1"> and</span><span v-else-if="i > 0">,</span> <code>{{ t.typeId }}</code></template>, all of which Microsoft's own reference classifies as internal and not for custom content. A pack using one gets a diagnostic saying so. What each of them does, so that an existing pack using one can still be read, is summarised on the <a :href="withBase('/features/')">type list</a>.
</p>

Every count and every type id in this section is read from the engine's own coverage table at build time — `featurelab types --json` — so it cannot drift from what the bench actually does. The prose under each heading below is written by hand, because "what this gap means for your pack" is not something the table knows.

The partial ones, and the specific thing each one is missing:

<table>
  <thead><tr><th>Type</th><th>What is not modelled</th></tr></thead>
  <tbody>
    <tr v-for="t in partial" :key="t.typeId">
      <td><a :href="routeOf(t.typeId)"><code>{{ t.typeId }}</code></a></td>
      <td v-if="gaps[t.typeId]"><a :href="'#' + gaps[t.typeId].anchor">{{ gaps[t.typeId].summary }}</a></td>
      <td v-else><em>Not yet written up on this page. The engine's own note:</em> {{ t.note }}</td>
    </tr>
  </tbody>
</table>

A type with no page of its own — `minecraft:sculk_patch_feature` is the one today — still has a route, and it lands back on this section.

### Single block: whether a state is rewritten, not the rotation {#gap-single-block}

Rotation rewrites the placed block's directional state the way the game does, for all sixteen state families. What is left is the *test* the game uses to decide whether a state is rewritten at all: it asks the block's **type** whether it can carry that state, while the bench can only see the states `places_block` actually spells out. `places_block: "minecraft:torch"` is placed unrotated here and turned in the game; write the state out and the preview is right. The gap only ever under-rotates.

Separately, for ten of the sixteen families the direction is exact but the state name it is written under is taken from vanilla block definitions and less certain; those ten warn when you use them, and the families real packs use are not among them.

### Snap to surface: how `allowed_surface_blocks` compares {#gap-snap-to-surface}

The per-face support test is the real one — a floor scan accepts a top slab and refuses a bottom one — so what is left is narrower. It is `allowed_surface_blocks`, where the game compares each side's full block state (name plus every state at its concrete value) and completes both sides to the block's full state set first. Two consequences:

- a `{"tags": ...}` entry matches **nothing** in the game — it logs an error and substitutes `minecraft:unknown` — while the bench evaluates the predicate and accepts surfaces;
- a partly-spelled state map matches more in the game than here, because the bench compares the written maps literally.

### Geode: whether a bud may attach {#gap-geode}

Whether a bud may attach to a cavity wall runs through a per-block check whose last step consults a data-driven component the bench has no representation for. It cannot affect the four vanilla amethyst blocks, so the warning fires only for an `inner_placements` block outside that set.

### Sculk patch: the spread simulation refuses rather than approximating {#gap-sculk-patch}

The spread and growth simulation runs on the game's per-block behaviour system. A feature configured to actually run it refuses at build time rather than placing a patch missing everything the spread would add. This type has no page of its own; see [deliberate scope decisions](#deliberate-scope-decisions).

### Horizontal tree decoration: the state declaration check {#gap-horizontal-tree-decoration}

The game first checks that `places_block`'s *type* declares both a `cardinal_direction` and a `growth` state. The bench has no per-block-type state registry, so it assumes the check passes and says so. A block missing either state looks like it works on the bench and places nothing in the game.

## Bench-wide approximations {#bench-wide-approximations}

These are not per-type gaps; they affect any page whose claims were checked by running something.

**Block predicates.** The game asks questions like "is this block solid-blocking", "can it support a face", "is it motion-blocking". Three of those carry the game's own per-block answer: face support, motion-blocking, and solid-blocking. What is left is custom blocks — a block a pack defines itself is treated as an ordinary full cube for all three, because the bench does not read a custom block's material or collision box, so one with its collision removed still counts as blocking. A handful of internal checks elsewhere in the bench (the geode anchor test, the sculk-patch neighbour scan) still answer from the bench's own block classification, which is a different question and is right for those uses.

**No per-block-type state registry, for placement.** On the *placement* path the bench knows the states of a block it placed, not the states a block *type* declares. Every check of the form "does this block have state X at all" is therefore assumed rather than performed, with a warning. [Horizontal tree decoration](#gap-horizontal-tree-decoration) above is the case where this is load-bearing.

For *appearance* this is no longer true of a pack's own blocks: the renderer reads each block's `description.states` and enumerates the concrete state sets its `permutations` conditions distinguish, so a pack block's state-specific art is drawn. That registry is used for drawing only — nothing on the placement path consults it. See [block textures in the preview](./block_textures.md#your-own-blocks).

**Textures approximate several things too.** The list here is about placement; the rendering approximations are listed on their own page, and one of them is a real bench-vs-game divergence worth knowing here: **a `terrain_texture` entry with `variations` is pinned to its first entry**, where the game rolls a weighted die per placed block. See [block textures in the preview](./block_textures.md#what-is-drawn-and-what-is-approximated) for that and the other four.

**Directional block states are rewritten only where you wrote them.** The bench applies the game's own rotation table — all sixteen state families, on both [single block](../features/single_block_feature.md) and [multi block](../features/multi_block_feature.md) — but decides *whether* a state gets rewritten by looking at the states the JSON spells out, where the game asks the block's type what it can carry. So a block written as a bare name is placed unrotated where the game would turn it (this is the "no per-block-type state registry" limitation above, seen from the placement side). The one exception is a multi-block's own `minecraft:cardinal_direction`, which the bench does read from the block's traits and so rotates even when the descriptor left it unwritten. This changes appearance, not sequence: the same values are drawn in the same order either way.

**Cells that land outside the bench's volume are lost, and one type reports that as a failure.** The bench generates a finite area; the game writes into a chunk column with no such edge. Every type simply loses writes that fall outside, but [fossil](../features/fossil_feature.md) also *fails* the placement when it loses all of them, where the game reports success without ever looking. A fossil is buried 15 to 24 blocks below the surface and its anchor is never put lower than ten blocks above the bottom of the generated area, so an area ten blocks tall or less fails on every seed, and one narrower than about thirty-two blocks loses some placements off its east and south edge. Nothing downstream shifts — generate a taller or wider area.

**Surface height is finished terrain, not the game's pre-generation estimate.** The bench looks it up at the same 4×4 granularity the game uses, but the value is the height of the terrain it built, where the game consults an estimate made before generation. Affects the height-relative gate types.

**One feature at a time, in an empty bench.** The bench places the feature under test in a world built from a preset, with no other features, no structures, and no neighbouring chunk content. Anything the game decides by consulting *other* generated content — a fossil skipped because a mineshaft already claims the spot — cannot happen there. That is a property of previewing one feature in isolation, not an approximation of the feature.

**An unresolved Molang read stops the expression in the game; the bench reads it as 0 and carries on.** Reading a `variable.`/`temp.`/`context.` slot that nothing has written ends the expression where it stands in the game — the read is `0`, and no assignment or `math.random` after it runs (see [Molang in world generation](../features/molang.md#reading-a-slot-nothing-has-written)). The bench does not do that, anywhere, and the reason is the entry above: it places one feature in isolation with an empty scope, so a slot that a parent feature earlier in the delegation chain — or the feature rule's own distribution — would have written is unset *here* and set *there*. Faithfully stopping would end a large share of a typical pack's chains at their first read, showing nothing, for a reason belonging to the bench rather than to the pack. So the read yields `0`, evaluation continues, and every single swallowed read is reported by name with the count of how often it happened.

Read such a diagnostic as a question rather than a verdict: if something upstream really does write that slot, the preview is right and the message is noise; if nothing does, the game stops there and the feature places nothing. Guarding the read with `?? <default>` settles it either way, and is what the guard is for. The same substitution applies inside a `{"tags": ...}` block predicate, where the scope is empty by construction and the diagnostic is raised once, when the pack loads, rather than once per block tested.

**Two random sources the game does not make reproducible.** The cave carvers' `width_modifier` and the multiface spread order both draw, in the game, from generators with no world seed behind them — so no two runs of the *game* agree either. The bench substitutes seed-derived values so a preview stays stable while you edit, and warns when it does. See [RNG and determinism](../features/rng_and_determinism.md) for which Molang randoms are reproducible and why.

**The string that names a decoration entry from a feature rule** is the rule's own `description.identifier`, not its `places_feature`. See [each decoration entry gets its own seed](../features/rng_and_determinism.md#2-each-decoration-entry-in-the-chunk-gets-its-own-seed).

## What has, and has not, been checked against real content

Most types on these pages were checked differentially against a large body of real add-on content — thousands of feature files, placed and compared cell for cell against a recorded baseline, so a change in behaviour anywhere shows up as a difference. That is the strongest evidence in this set, and it covers the types packs actually use heavily: scatter, single block, trees, aggregates and sequences, ores, and the rest of the common vocabulary.

Three groups fall outside it:

- **The carvers.** The content behind the paragraph above does not use any of the three carver types, so the [cave carver](../features/cave_carver_feature.md), [underwater cave carver](../features/underwater_cave_carver_feature.md) and [nether cave carver](../features/nether_cave_carver_feature.md) pages rest on the bench's own tests, without a differential check against real content behind them. What they do have is the smaller, committed baseline: one worked example per type, each pinned cell for cell and value for value, so a change in any of the three shows up as a difference even though no pack in the wild is watching. Their pages say which numbers came from which.
- **The types new in this version.** `multi_block`, `multipart_block_column` and `horizontal_tree_decoration` post-date every pack there is to check against.
- **Anything a pack does not happen to use.** Coverage by usage is not coverage by field: a type can be heavily exercised and still have one key nothing in that pack sets. The `structure_template` `leveled` constraint was exactly that case — real, documented, and used by nothing, so nothing would have noticed it being wrong.

## Deliberate scope decisions {#deliberate-scope-decisions}

- The internal types listed as out of scope above are not implemented and are not queued. Their routes land on this page so that a deep link from a diagnostic still arrives somewhere.
- `minecraft:scan_surface` carries the same internal classification but *is* documented, because packs in the wild already use it. `minecraft:sculk_patch_feature` does not have a page — see [its gap](#gap-sculk-patch).
- Bit-for-bit reproduction of the game's random stream is not a goal of the bench. Which situations draw, how often and in what order are modelled exactly, because those are behaviour; the exact sequence of values is not chased where the two disagree, and where it is deliberately different the page says so.

## How claims on these pages are backed {#how-claims-on-these-pages-are-backed}

Three different kinds of statement appear across the set, and they are not equally strong:

- **Stated as fact.** A default, an order of operations, a key that does or does not exist, described plainly.
- **Reproduced.** Shown by running an implementation of the same behaviour against a pack and comparing what came out. Pages that give a command and a table of resulting coordinates are in this class; you can re-run them.
- **Uncertain.** Stated with a note saying so, or left out. Where a page says a detail is assumed, not certain, or "this project's interpretation", it means exactly that.

Each page's own *How this page was checked* section says which of its claims fall in which class. A page's *What the bench does differently* section is where a tool limitation may be stated; nowhere else on a page is one phrased as a fact about the game.

## See also

- [Feature types](../features/index.md) — the full type list, including the ones without pages.
- [RNG and determinism](../features/rng_and_determinism.md) — the seeding chain, and which parts of it are less certain.
- [When the preview shows nothing](../editor/preview_shows_nothing.md) — what the bench says when a run writes no cells, which is the other half of reading a preview honestly.
- [Delegation and composite features](../features/feature_delegation.md#what-the-bench-does-differently) — the three limits the bench adds that the game has no concept of.
- [Block textures in the preview](./block_textures.md) — the rendering half of the same question.

## How this page was checked

The counts, the type ids and the per-type status in [type coverage](#type-coverage) are not written on this page at all: they are interpolated at build time from `generated/coverage.json`, which `npm run generate` writes from `featurelab types --json`, and the docs workflow fails if the committed copy differs from a fresh run. So the numbers here are the engine's, on the build that produced this page, and the wiki page's hand-typed counts cannot recur.

Everything else is hand-written and is a claim about the bench: each gap above was read off the behaviour it describes, and each is stated as what the bench does *not* do rather than as something the game cannot do. The version pin — Bedrock 1.26.50.24 — matters here because the type list itself is version-specific: a type that does not exist in a build cannot be covered or missing in it.
