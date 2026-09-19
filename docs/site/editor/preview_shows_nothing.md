---
title: When the preview shows nothing
description: A blank preview is an answer, not a silence — where featurelab reports it, every reason a run writes no cells and what each one's message means, the refusals that are deliberately silent, and the separate reasons a feature rule decorates no chunks.
scope: bench
---

# When the preview shows nothing

<VersionBadge />

**A blank preview is an answer, not a silence.** The run happened; something declined. The tool's job is to say which thing declined and where, and it almost always does — the difficulty is that "the panel is empty" and "the panel is empty *because*" look identical until you know where to look. This page is the index of the second kind: every message the preview can give you for an empty result, in the tool's own words, so that you can find yours by searching for what you are reading.

**This page is about the bench, not the game.** Every page under [Feature types](../features/index.md) describes Minecraft Bedrock; this one describes what the preview does and which of its own sentences means what. Nothing here should be read as a statement about Minecraft. Its companions are [coverage and known gaps](../engine/coverage.md) and [block textures in the preview](../engine/block_textures.md).

## Where the answer is {#where-the-answer-is}

1. **The panel's Diagnostics section.** Everything the run declined to do, with the delegation chain that reached it, how many times it happened, and a button that moves the camera to the position it happened at. This is the first place to look and usually the only one.
2. **The Problems panel**, for anything that went wrong while the files were being read rather than while the feature was being placed.
3. **The log** — `Feature Lab: Show Log` in VS Code, stdout in the CLI — for the engine's own output verbatim, including which executable ran and what the pack root was worked out to be.

A diagnostic names the feature it is about separately from the one you asked to preview. A nested refusal says which feature in the chain refused; the file you opened is only where the chain started. A diagnostic that is about a *file* spells it relative to the pack root (`features/broken.json`), which is the same string the graph canvas and `featurelab check` use for that file — one name per file, wherever you meet it.

### The pass that answers without previewing anything {#featurelab-check}

```
featurelab check --pack <pack>
```

It loads the pack, prints one `LEVEL / FILE:line:col / MESSAGE` row per finding and a summary line (`1 error, 0 warnings, 4 notes`), and exits non-zero if any row is an `error`. The three levels are `error`, `warning` and `info` — and a conventional directory this pack simply does not have is `info`, not a warning, which is why the summary counts four notes and no warnings above. `--json` gives the same findings as an array instead, for a program.

It never runs a placement, so it has nothing to say about a lost `scatter_chance` roll or a surface that was not there — what it answers is whether the files load and whether **every delegation in the pack resolves to something**. A `places_feature` naming a file nobody wrote is an error there, with a near-match suggestion, and it is an error found *between* two files rather than in either one, which is why no amount of reading the file you are looking at finds it.

::: warning Wiring `check` into a build can fail a pack nobody has touched
A pack with an unresolved delegation used to pass `check` and now fails it, so a job that gates on the exit code can start failing on a pack that has not changed. The finding is real in every such case — the branch places nothing in game either — but it is a new failure, not a new breakage.
:::

## The reasons a feature writes no cells {#the-reasons-a-feature-places-nothing}

Find the sentence you are looking at in the middle column.

| What happened | What you see | What to do |
|---|---|---|
| **`iterations` evaluated to zero** | "iterations evaluated to zero, so nothing was placed. Unlike a chance rejection this is not luck — a different seed will not help unless the expression is itself random." | Read the expression. This is configuration, not luck: re-running changes nothing. See [scatter features](../features/scatter_feature.md). |
| **`scatter_chance` did not roll** | "scatter_chance did not roll this time… this is luck, not configuration. A different seed may place." | Re-run, or raise the chance. **A bare number is a percent**: `scatter_chance: 1.5` means 1.5%, not 150% — the single commonest cause of "it almost never places". |
| **`scatter_chance` can never pass** | The same sentence as above. | The prose does not distinguish a lost roll from a chance of zero; turn the profiler on ([below](#the-ones-that-say-nothing)) to tell them apart. |
| **No surface to snap to** | "no surface found searching down (to a floor) from a position holding …" and the search range it used. | A fully solid or fully empty column has no surface. Move the origin, widen `search_range`, or pick an environment with ground where you are looking. See [snap-to-surface features](../features/snap_to_surface_feature.md). |
| **A search ran out of positions** | "Could not find a valid position for the feature." | The delegate refused everywhere in the volume. Preview the delegate on its own — its refusal is the real reason. See [search features](../features/search_feature.md). |
| **An unresolved reference** | "delegates to *x*, which no loaded file defines. Nothing resolves this reference at run time, so this branch places nothing." — followed by "did you mean …?" when something in the pack is close. **This sentence comes from the graph, not from the run**: it is what the graph canvas and `featurelab check` say. The run itself reports only that nothing was placed; the name that is wrong is in the profiler's `unresolved_reference` stop (`wiki:pumpkin_patch_blok not found -- did you mean "wiki:pumpkin_patch_block"?`). | Check the namespace and the spelling, or add the file — and run `featurelab check`, which finds every one of these in the pack at once without previewing anything. Case is *not* the problem — identifiers match without regard to it, exactly as the game matches them. |
| **A reference the game provides** | Wording to the effect of "the game provides this one; it works in game, and this tool cannot preview it" — on the card itself in the graph canvas. Deliberately **not** an error anywhere, and `featurelab check` says nothing at all about it: a vanilla name is not a typo, and treating it as one sends authors to correct spellings that were already right. | Nothing. This one is correct in game and simply invisible here. |
| **The recursion guard** | "Cannot place internal feature." | A feature reached itself through its own delegation chain. Loops are legal and the engine stops them; if you did not mean one, follow the chain in the diagnostic. See [feature delegation](../features/feature_delegation.md#the-recursion-guard). |
| **Nothing to pick** | "Feature could not be selected." | A `weighted_random`'s weights come to zero — every entry is `0`, or they are fractions that round away — or the entry it did pick names something no file defines. A zero-weight entry is never picked: not with another seed, not at another origin. See [weighted random features](../features/weighted_random_feature.md#weights). |
| **`may_replace` rejected the position** | "may_replace rejected this position: it holds *block*, which is not in the replace list." | Add that block, or place somewhere that holds one you listed. |
| **A block could not attach** | "Block could not attach to the given location." | The attach face had nothing to attach to. |
| **A budget stopped the run** | "write budget hit at *n* of *m* block writes" (or delegation, or wall-clock), and the panel marks the result partial. | Usually a chain that expands without converging. Raise the budget in the panel only once you are sure the expansion is intended. |

::: note An unresolved reference and an external one are different things
A feature **the pack does not define** is *unresolved*, and it is an error: nothing resolves it at run time, in the game or here. A feature **the game provides** is external — correct in game, invisible in the preview, and not an error anywhere.
:::

## The ones that say nothing {#the-ones-that-say-nothing}

A few refusals are deliberately silent, because the game is silent about them too:

- **`height_difference_filter_feature`** and **`surface_relative_threshold_feature`** rejecting the origin.
- A **`conditional_list`** entry whose condition evaluated to 0 — the list simply moves on.
- A **`sequence_feature`** stopping because an earlier entry placed nothing.
- **`minecraft:scan_surface`** failing to resolve its wrapped feature, or being denied by the recursion guard. This one is a genuine reporting hole in the *preview* rather than a deliberate silence: a `scan_surface` wrapping a misspelled `places_feature` still produces a blank preview with only the generic fallback below. You no longer have to find it from the preview, though — `featurelab check` names it, at error level, with the file and the suggestion, because a delegation is a delegation whatever type wrote it.

When the Diagnostics section is empty and the preview still is too, **turn the profiler on**. It records a machine-readable stop code per feature — `chance_zero`, `chance_failed`, `iterations_zero`, `condition_false`, `biome_filter_rejected`, `height_difference_rejected`, `surface_threshold_rejected`, `search_exhausted`, `no_surface`, `no_selection`, `sequence_first_failure`, `unresolved_reference`, `recursion_guard` — and it is the only way to see the silent ones, and the only way to tell `chance_zero` from `chance_failed`.

## When nothing above applies {#when-nothing-above-applies}

Two fallbacks fire only when no other diagnostic did:

- **"placed successfully but wrote no blocks — every candidate position was rejected, or a nested feature placed nothing."** The chain ran to the end and every leaf declined.
- **"placement returned no result and wrote no blocks."** The leaf refused without explaining itself.

And one that is about the bench's own window rather than your feature:

- **"all *n* writes landed outside the previewed volume…"**, with the bounds it used. That is expected for a feature that works on neighbouring chunks. Otherwise grow the volume or move the origin.

::: note Writes and cells are not the same count
The graph counts **writes** — the block-write attempts a chain makes. The preview counts the **cells** it placed, carved or replaced. A feature can write the same cell more than once, so a run can report writes and still show you fewer cells than you expected; the two are never compared to each other.
:::

## Two traps worth knowing by name {#two-traps-worth-knowing-by-name}

**A legacy block alias matches nothing.** A descriptor like `minecraft:leaves`, whose modern block depends on a state the descriptor does not set, is kept verbatim rather than guessed at — so a `may_replace: ["minecraft:leaves"]` matches nothing at all and every position is rejected. Write the flattened block (`minecraft:oak_leaves`), or add the state that selects one. The tool warns when it sees one.

**Your environment may not be what you think.** The feature may be correct and the preset wrong: `plains` has no ceiling to hang from, `void` has no ground to stand on, and a feature gated on a block only your pack defines needs the **Materials** section changed or a biome selected. Check those before you change the JSON.

## Why a feature rule decorates no chunks {#why-a-feature-rule-decorates-no-chunks}

A rule preview runs the rule's own distribution once per chunk the bench covers, so it has its own reasons — see [feature rules](../features/feature_rules.md#why-nothing-was-placed) for the full set:

| What happened | What you see |
|---|---|
| **The biome filter rejected the biome** | "biome filter rejected biome *x* — …", with the filter described. Select a biome the rule accepts, or edit the filter. |
| **`places_feature` did not resolve** | The same unresolved-reference message as above, with the spelling advice — and `featurelab check` reports it as an error against the rule file, naming `$.minecraft:feature_rules.description.places_feature`. A rule's delegation is checked exactly like a feature's. |
| **`scatter_chance` did not roll**, or **`distribution.iterations` was zero** | The same two sentences as above, worded for a rule. |
| **The `placement_pass` is wrong for the feature** | A **warning**, not a refusal: the rule is a guaranteed no-op in game however well it is written, and the tool still runs it. So the preview shows cells the game would *not* place. Move the rule to a decoration pass. |

That last row is the one case on this page where a preview showing *something* is the problem.

## See also

- [Feature rules](../features/feature_rules.md) — the seven ways a rule places nothing while looking entirely correct, in the game's terms rather than the panel's.
- [Coverage and known gaps](../engine/coverage.md) — where the bench knowingly differs from the game, which is the other reason a preview and a world can disagree.
- [Scatter feature](../features/scatter_feature.md) — `iterations`, `scatter_chance` and the delegate refusals behind most empty previews.
- [RNG and determinism](../features/rng_and_determinism.md) — why a chance rejection is worth re-rolling and a zero `iterations` never is.
- [Block textures in the preview](../engine/block_textures.md) — when the preview shows something, but not in the colours you expected.

## How this page was checked

Every quoted sentence on this page is the tool's own wording, copied from what it emits rather than paraphrased, because the reason to arrive here is usually having read one of them. The stop codes are the profiler's own set. Nothing on this page is a statement about Minecraft Bedrock: where a row says what the game would do — the vanilla reference that works in game, the `placement_pass` that is a no-op there — that claim belongs to the page it links to, and is pinned there. The tool's behaviour is that of the build this site was generated from; a message that changes wording is a bug against this page.
