---
title: Molang in world generation
description: Molang is the expression language you can write into a feature's numbers. What each namespace can reach, what math.random actually returns (and why it is not an integer picker), how long a variable lives across a delegation chain, and the reads that stop an expression dead — measured against Minecraft Bedrock 1.26.50.24.
category: guide
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Molang in world generation

<VersionBadge />

**Anywhere a feature wants a number, you can write a Molang expression instead.** How many times a [scatter](./scatter_feature.md) repeats, how far one of its axes reaches, whether a [conditional list](./conditional_list.md) takes a branch — each of those is either a plain number in the JSON or a quoted string the game compiles and runs once per placement. That is the same language entity files and render controllers use, but it runs in a different host, with a different set of names to read and a different rule about how long a value you write lives.

Reach for an expression when a constant cannot say what you mean: *place four of these, but only above sea level*; *pick a trunk height here and let the feature below read it*; *thin this patch out where the noise is low*. Reach for a plain number the rest of the time — a number is not compiled, cannot fail to parse, and is the one the editor gives you a stepper for.

## Start here: a complete example

Two files. The scatter does no scattering at all — every axis is `0`, so it places once, on its own origin. Its `iterations` expression is there to *write a value*, and the feature it delegates to reads that value back, in a different file, in a different feature type, with nothing wiring them together but the name.

::: code-group

```json [features/mushroom_ring_root.json]
{
  "format_version": "1.21.110",
  "minecraft:scatter_feature": {
    "description": { "identifier": "example:mushroom_ring_root" },
    "places_feature": "example:mushroom_ring_gate",
    "distribution": {
      "iterations": "t.has_moss = query.noise(v.originx / 64, v.originz / 64) > 0; return 1;",
      "x": 0, "y": 0, "z": 0
    }
  }
}
```

```json [features/mushroom_ring_gate.json]
{
  "format_version": "1.21.110",
  "minecraft:conditional_list": {
    "description": { "identifier": "example:mushroom_ring_gate" },
    "conditional_features": [
      { "places_feature": "example:mushroom_ring_moss", "condition": "t.has_moss" },
      { "places_feature": "example:mushroom_ring_bare", "condition": "!t.has_moss" }
    ]
  }
}
```

:::

What each choice buys you:

- **`t.has_moss = …` is a side effect, not the answer.** The expression's *value* is what `iterations` uses, and an assignment would be a terrible count, so the expression ends with an unconditional `return 1;`. Only the assignment is doing real work.
- **`return 1;` is not optional.** A statement sequence that ends without one evaluates to `0`, and a scatter with zero iterations places nothing. This is the single commonest way a working expression produces an empty preview.
- **`v.originx` / `v.originz`, not `v.worldx` / `v.worldz`.** Inside a scatter's `iterations` the world coordinates have not been written yet — see [`query.noise` and the position variables](#query-noise).
- **The delegate reads `t.has_moss` with nothing forwarding it.** Both `temp.` and `variable.` are shared down a whole delegation chain, so a value written at the top is readable at the bottom. That is the point of the whole idiom, and [scope lifetime](#scope-lifetime-temp-versus-variable) is where its limits are.

```
featurelab generate --pack <pack> --feature example:mushroom_ring_root --env void --seed 1 --size 8x8x8
```

That run places **one block**, and it is the *bare* variant: at the preview's origin the noise argument is `query.noise(0, 0)`, which is exactly `0`, so `> 0` is false and the gate takes its second branch. The result's `molangScope` reports back what the run left behind — `temp.has_moss` at `0`, and `variable.originx/originy/originz` and `worldx/worldy/worldz` at the position it placed on. Change the comparison to `>= 0` and the same command places the moss variant instead, which is how you can see both halves of a gate without moving anything.

::: tip Reading the scope back is the fastest way to debug an expression
`molangScope` in a `featurelab generate` result is every `variable.` and `temp.` name the run ended up holding, with its value. When a gate is not firing, look there first: nine times out of ten the name is absent, which means nothing wrote it, which means [the game would have stopped at the read](#reading-a-slot-nothing-has-written).
:::

## Where an expression can go {#where-an-expression-can-go}

A key takes Molang when the schema says "a number or a Molang expression". Write a JSON number for a constant and a JSON **string** for an expression — the quotes are what tell the game to compile it.

| Where | Key | What the value means |
|---|---|---|
| [Scatter](./scatter_feature.md) | `distribution.iterations` | How many rounds. An expression that evaluates to zero places nothing at all. |
| [Scatter](./scatter_feature.md) | `distribution.x` / `y` / `z` | An axis, when written as a bare scalar rather than a distribution object. |
| [Scatter](./scatter_feature.md) | `distribution.<axis>.extent[0]` / `[1]` | Either end of a range. |
| [Scatter](./scatter_feature.md) | `distribution.scatter_chance` | A percentage. |
| [Conditional list](./conditional_list.md) | `conditional_features[].condition` | A gate. Anything non-zero takes the branch. |
| [Cave carvers](./cave_carver_feature.md) | `width_modifier` | A width multiplier — and the one slot whose randomness is [not reproducible](./rng_and_determinism.md). |
| Block predicates | a `{"tags": "…"}` predicate in `may_replace` / `may_attach_to` | A test over a block's tags. |

Everywhere else a number is a number. The editor marks the slots that accept an expression with a **`ƒ`** badge reading *"A number, or a Molang expression evaluated when the feature runs."*

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `math.random(0, 4)` for "0, 1, 2, 3 or 4" | You get a **decimal** somewhere from 0 up to 4 — `2.718…`, not `3`. A whole number comes up only by accident, and `4` effectively never does. | `math.random_integer(0, 4)`, which is whole and **does** include both ends. |
| `"iterations": "t.flag = query.noise(…) > 0;"` | The sequence ends without a `return`, so it evaluates to `0`, so the scatter places nothing. | End it with `return 1;` (or whatever count you meant). |
| `m.random_integer(0, 3)` | `m.` is not a Molang alias. The game rejects the token and **the file does not load** — not this expression, the file. | Write `math.` in full. Only `query.`, `variable.`, `temp.` and `context.` have short forms. |
| `v.trunk_height + 2`, with nothing upstream writing it | The read finds no value, and the expression **stops there**. It is worth `0`, and nothing after the read runs — no assignment, no randomness. | `(v.trunk_height ?? 4) + 2`, or write the slot in a feature above this one. |
| `q.nosie(v.originx, v.originz)` | A misspelt `query.` name is refused when the file is tokenised and **the whole pack fails to load**. It is not a silent zero — that is what a misspelt `variable.` gives you. | One of [the six queries](#the-six-queries). The editor underlines anything else. |
| `query.noise(0, 0) > 0` as a gate | `query.noise(0, 0)` is exactly `0`, so `> 0` is false at the origin, every time, in every world. | Compare against something the noise can actually clear, or offset the arguments. |
| `query.has_biome_tag('forest', x, z)` | The three-argument form leaves `y` at `0` — far underground, where the answer is about cave biomes rather than the surface. | Give it all four: `query.has_biome_tag('forest', x, query.above_top_solid(x, z) + 1, z)`. |
| `0 && 0 \|\| 1 && 1` in a pack whose `min_engine_version` is below 1.18.20 | It groups as `0 && (0 \|\| 1) && 1` and is **false**, the opposite of the C-style reading. | Parenthesise what you mean, or raise `min_engine_version`. See [the precedence change](#precedence). |
| `query.noise(…) > 0.3527`, tuned in a spreadsheet | The comparison happens in [32-bit floats](#float32). A value that sits safely on one side in double precision can land on the other. | Leave margin, or pick a round threshold. |
| `context.my_flag = 1` | `context.` is supplied by the host and cannot be assigned to. | `variable.` or `temp.`, which is what those two are for. |

## The five namespaces {#namespaces-and-short-aliases}

Every name in a worldgen expression belongs to one of five dotted namespaces. Four of them have a one-letter short form that means exactly the same thing.

| Namespace | Short form | What it holds |
|---|---|---|
| `math.` | **none** | The stateless function library — `math.sin`, `math.floor`, `math.clamp`, [the random draws](#random-numbers). There is no `m.`: it looks like it ought to work, and a file that uses it does not load. |
| `query.` | `q.` | Read-only values the engine computes. In world generation there are exactly [six](#the-six-queries), and asking for a seventh does not load. |
| `variable.` | `v.` | Read and write. Shared down a whole delegation chain. |
| `temp.` | `t.` | Read and write, and it lives [even longer than that](#scope-lifetime-temp-versus-variable). |
| `context.` | `c.` | Read-only, supplied by the host. Any name parses — `context.anything` is legal to write — but **nothing in world generation supplies one**, so every `context.` read is a read of a slot nothing has written, with [everything that implies](#reading-a-slot-nothing-has-written). |

### The six queries {#the-six-queries}

This is the whole list. It is much narrower than the query surface entity and render-controller Molang has, and unlike a misspelt variable, a name outside it is fatal to the file.

| Query | What it answers |
|---|---|
| `query.noise(x, z)` | Fixed-seed 2D noise at those two numbers — see [below](#query-noise). |
| `query.has_biome_tag('tag')` | Whether the biome here carries that tag. Also takes `('tag', x, y, z)` to ask somewhere else. |
| `query.any_tag('a', 'b', …)` | Whether the biome carries any of them. |
| `query.all_tags('a', 'b', …)` | Whether it carries all of them. |
| `query.heightmap(x, z)` | The height of the column there — the first free cell above anything that is not air. |
| `query.above_top_solid(x, z)` | The first free cell above the top *solid* block, skipping water and plants. Usually the one you want for "the surface". |

Anything else — `query.is_baby`, a typo, a query that exists for entities — is refused when the expression is tokenised, with `Failed to resolve query <name>. Either the query does not exist or it is not supported in this context.`, and the pack does not load. That is the opposite of what a misspelt `variable.` does, and it is why the two kinds of typo have completely different symptoms.

## Random numbers, and what each one returns {#random-numbers}

Four functions, and the difference between them is the difference between a decimal and a count. Getting this wrong is quiet: the expression works, the numbers are plausible, and the feature does something slightly other than what you meant.

| Call | Returns | Includes its top end? |
|---|---|---|
| `math.random(low, high)` | A **decimal** from `low` up to `high`. | **No, for practical purposes.** `low` comes up; `high` is a rounding accident that happens about once in thirty million calls. |
| `math.random_integer(low, high)` | A **whole number** from `low` to `high`. | **Yes, both ends.** This is the one that reaches its maximum. |
| `math.die_roll(n, low, high)` | `n` decimals from `math.random(low, high)`, added together: `n × low` up to `n × high`. | No, for the same reason. |
| `math.die_roll_integer(n, low, high)` | `n` whole numbers from `math.random_integer(low, high)`, added together: `n × low` to `n × high`. | Yes, both ends. |

Everything else about them:

- **The argument counts are exact.** `math.random` and `math.random_integer` take two, the die rolls take three. A bare `math.random`, or `math.random(3)`, does not compile — so a miscounted call is a file that does not load, not a value you have to go looking for.
- **`n` is rounded, not truncated.** `math.die_roll(2.5, 1, 6)` rolls three times. An `n` of zero or less rolls nothing and is worth `0`.
- **`math.random(5, 5)` is `5`.** A range with no width is not an error; it is a constant that still takes a value from the generator.
- **Where the randomness comes from is a property of the slot, not of the function.** Inside a distribution, these draw from the placing feature's own seeded generator — so they repeat exactly at a fixed world seed, and they share their position in the sequence with everything else that feature does. A slot that installs no seeded source gets a generator with no world seed behind it, and the known case is the cave carvers' `width_modifier`. [RNG and determinism](./rng_and_determinism.md) is the whole model.

::: warning Beware of dividing by something that might be zero
Division short-circuits: when the denominator is very close to zero the whole division is `0` and **the numerator is never evaluated**. Put a `math.random` in that numerator and it silently does not happen, which moves everything the feature does afterwards. If a denominator can be zero, guard it.
:::

## Scope lifetime: `temp.` versus `variable.` {#scope-lifetime-temp-versus-variable}

This is the single most useful — and least documented — fact about worldgen Molang.

::: warning `temp.` is never reset between features
A value written to `t.something` by one feature is still readable by name from the very next feature placed on that thread, even if that next feature is a completely different type, in a different file, with no wiring between them at all.
:::

That is a genuinely different rule from Molang's general-purpose behaviour. Outside world generation, `temp.` is commonly described as ephemeral — cleared once the current expression or loop finishes. That description does not hold here. Treat the two as separate contracts that happen to share a syntax, and do not assume a `t.` name is private just because you only meant to use it once.

`variable.` has a narrower, and much more useful, guarantee. It propagates **unconditionally within one placement chain** — a top-level feature and everything it delegates into, however many feature-type boundaries that crosses. Every placement shares one scope with the features below it rather than forking or clearing it. This holds for all eight Proxy types that delegate ([aggregate](./aggregate_feature.md), [sequence](./sequence_feature.md), [weighted random](./weighted_random_feature.md), [conditional list](./conditional_list.md), [scatter](./scatter_feature.md), [snap to surface](./snap_to_surface_feature.md), [surface relative threshold](./surface_relative_threshold_feature.md), [scan surface](./scan_surface.md)), and real packs lean on it hard: a value written in one file is commonly read in a file reachable through it, across intermediate features that neither write nor read it. The example at the top of this page is that shape at its smallest.

::: note What is not settled
Whether `variable.` resets at any boundary *above* a single top-level `places_feature` call tree — between two unrelated entries in a biome's decoration list, say, or between chunks. `temp.`'s behaviour is at least as permissive as `variable.`'s in-chain guarantee, but the upper bound for both is not known with certainty. Do not rely on either surviving between two features that are not in the same delegation chain without testing it.
:::

## Reading a slot nothing has written {#reading-a-slot-nothing-has-written}

A `variable.`, `temp.` or `context.` name that has **never been written** is not the number zero. The game keeps "this slot holds no value" and "this slot holds `0`" apart, and they behave completely differently.

::: warning An unresolved read stops the expression where it stands
The read itself is worth `0`, but nothing sequenced after it runs — not the rest of the expression, not the assignments, not the `math.random` calls. The expression's value is that `0`, so a `distribution` that reads an unset name does not fail loudly: it quietly evaluates to zero *and* skips every draw the rest of it would have taken.
:::

That last part is the one that bites. `v.unset + math.random(0, 4)` does not draw. Neither does anything later in the same expression, so an expression that both seeds a slot and draws can leave the whole chain reading from a different point in the random sequence than you expect — see [RNG and determinism](./rng_and_determinism.md#draw-order-is-part-of-a-features-contract) for why *position* matters as much as count.

("Unresolved" here is the game's word for a read with nothing behind it. It is not the same use as an **unresolved feature**, which is a `places_feature` naming something the pack does not define. Different problem, different fix.)

### `??` is a try/catch, not a null test {#the-guard}

`??` is the guard for exactly this. What it catches is "the read on my left found no value" — not falsiness, not `NaN`, not a null of any kind:

```json title="the idiom, and what each spelling means"
"t.cut_corner_chance = t.cut_corner_chance ?? 0.35; return t.cut_corner_chance;"
```

- `v.unset ?? 5` is **5** — the read found nothing, so the right side runs.
- `v.x = 0; return v.x ?? 5;` is **0** — a slot holding zero is resolved, and does not divert.
- `math.sqrt(-1) ?? 5` is **NaN** — `NaN` is a value; `??` never looks at it.
- `v.a ?? v.b`, both unset, ends the expression at `v.b`. The guard covers its **left side only**, and it is spent by the time the right side runs.
- `??` binds *looser* than `||`, so `a || b ?? 1` means `(a || b) ?? 1`. Parenthesise if you meant otherwise.

So the idiom above is how you write "default this if nobody upstream set it", and it is the only thing that makes an expression safe to read a slot a *parent* feature might or might not have written. Write the guard, or write the slot first.

`query.` does not take part in any of this, in either direction. A `query.` name the game does not recognise is rejected when the expression is compiled rather than at evaluation time, so a `query.` read that runs at all has a value — there is nothing for `??` to catch and nothing to stop the expression.

## `query.noise` and the position variables {#query-noise}

`query.noise(x, z)` is Bedrock's 2D noise query: a single-octave simplex noise on a **fixed seed of 2345**, evaluated purely as a function of the two numbers you hand it. Two consequences a pack author acts on:

- **It is not seeded from the world seed.** The same two arguments give the same value in every world, forever. It is a fixed landscape you sample, not a per-world one.
- **It is not positional.** Nothing reads the current placement position for you. `query.noise(0, 0)` is exactly `0` whatever is going on around it, which is why a gate written `query.noise(0, 0) > 0` never fires. Values run to roughly ±0.88, so a threshold above that never fires either.

The position you want comes from variables several feature types publish on your behalf: `variable.worldx` / `worldy` / `worldz`, holding the absolute coordinate, and `variable.originx` / `originy` / `originz`, holding the feature's own origin. So the common idiom is `query.noise(v.worldx, v.worldz)` — but divide them down first (`v.worldx / 64`), or neighbouring blocks land on unrelated samples and the result looks like static rather than terrain.

::: warning When those get written differs by feature type, and for a scatter it is not "before your expressions run"
A [conditional list](./conditional_list.md) writes all three `world*` — plus, as of 1.26.50.24, matching `origin*` with the same values — from its origin before evaluating any condition. A [scatter](./scatter_feature.md#molang-variables) does **not**: it writes `variable.originx/originy/originz` from its origin up front, and writes each `world*` component only as that axis is evaluated. So inside a scatter's `distribution`, `iterations` and `scatter_chance` read whatever `world*` an enclosing feature happened to leave there, an axis expression reads the axes evaluated before it in `coordinate_eval_order`, and `origin*` is the only reliable way to read the scatter's own position. The scatter page has the exact sequence.
:::

## The `&&` / `||` precedence change is versioned {#precedence}

Molang's `&&`/`||` precedence is not fixed — it is gated on the pack's declared `min_engine_version`, and the two rules produce genuinely different groupings, not just a style difference:

- **Before 1.18.20:** `||` binds tighter than `&&`. `A && B || C && D` groups as `A && (B || C) && D`.
- **From 1.18.20 on:** standard C/JS precedence — `&&` binds tighter than `||`. `A && B || C && D` groups as `(A && B) || (C && D)`.

These two groupings disagree on real inputs, not just in theory. With `A=0, B=0, C=1, D=1`:

```json title="place_condition — evaluates truthy under 1.18.20+ precedence"
"0 && 0 || 1 && 1"
```

Under the modern grouping, `(0 && 0) || (1 && 1)` = `0 || 1` = **1**, true. Under the legacy grouping, `0 && (0 || 1) && 1` = `0 && 1 && 1` = **0**, false. A pack whose `manifest.json` declares an engine version at or above 1.18.20 gets the modern grouping; anything older gets the legacy one. This is why a condition that looks obviously true or false by C-style reading can silently evaluate the other way in an older pack — the fix is not in your expression, it is in `min_engine_version`.

::: note
This is a real, versioned change, and it matches Microsoft's own published "Versioned Changes" note for 1.18.20. Comparison-before-equality precedence and right-associative ternary chaining do not change at any version — only `&&`/`||` actually changes.
:::

## Molang evaluates in float32, not double {#float32}

Every value a Molang expression touches during worldgen — literals, variable and temp reads, arithmetic, and the `math.` library — is a **32-bit float**, not a double. This is not an exotic edge case: every operation produces a 32-bit float, every intermediate value is held as 32 bits, and even a plain `+` is a 32-bit add. `math.sin` / `math.cos` / `math.pow` go further and use the platform's single-precision versions, including a degree-to-radian constant that is itself rounded to 32 bits *before* the call rather than computed in double and truncated after.

What you see if you look: `0.1 + 0.2` is `0.30000001…`, `1 / 3` is `0.33333334…`, and `math.pi` is `3.1415927…`.

::: warning
If you are tuning a threshold — `query.noise(…) > 0.3527`, say — by computing the comparison value in a double-precision calculator, spreadsheet or scripting REPL, do not assume the in-game result matches bit for bit near the boundary. Both the noise value and the comparison itself happen in 32-bit floats in game; a value that looks safely on one side of the threshold in double precision can land on the other once every intermediate has been rounded. This matters most for thresholds tuned to a precise-looking decimal rather than a round number.
:::

A few other rounding rules worth knowing, because each one has surprised somebody: `math.round` goes **away from zero**, so `math.round(-2.5)` is `-3`; `math.mod` takes its sign from the left operand, so `math.mod(-7, 4)` is `-3`; and `math.clamp` tests its **upper** bound first, so `math.clamp(-2, -1, -3)` is `-3` — bounds written the wrong way round are not repaired.

## Writing Molang in the editor {#in-the-editor}

Every slot in [the editor](../editor/index.md) that accepts an expression is the same control: a box that lays the expression out on screen and writes it back compact, and that tells you which of the two things you are looking at.

**Number or expression.** The box shows a small pill reading **NUMBER**, **EXPRESSION** or **EMPTY**. It is not a switch you throw — it is read off what you typed, every keystroke. A bare `4` is a number and gets a **−** / **+** stepper beside it; type an operator, a query or a variable and the same box becomes an expression, with nothing converted and nothing lost. Going back is a button, labelled **`Use a plain number`** until the box has held one and **`Back to 4`** afterwards, and <kbd>Escape</kbd> undoes it.

**It lays the expression out for you.** A real pack's `iterations` is one very long line. The box shows it as one statement per line, indented, and on save writes it back on a single line again — so reformatting alone is never counted as an edit, and a box you merely opened is not dirty. If you would rather the file kept the layout, the checkbox **`Keep the line breaks in the file`** (a **`keep the line breaks`** option in the node panel's row menu) records that choice in the file itself.

**Completion, with a sentence per name.** Typing offers what is actually reachable, and <kbd>Ctrl</kbd>+<kbd>Space</kbd> forces the list open anywhere. It offers the six queries with their signatures, the six published position variables, and the `math.` functions — and nothing else, deliberately: a `temp.` or `context.` name is yours to invent, so there is no list of them to offer. The highlighted row carries a paragraph explaining the name: what `query.noise`'s seed does, that the four random functions are *"re-rolled every run"*, and for a variable whether it is **`variable (published by the engine)`**, **`variable (written upstream)`** or **`variable (NOT set here)`** — that last one being the case this page's [unresolved reads](#reading-a-slot-nothing-has-written) section is about.

**It checks the shape of the expression, not its meaning.** There is no second copy of the game's grammar in there, on purpose. What it does catch is the small set of mistakes that are unambiguous: a string that is never closed, a bracket with no partner, an expression that ends on an operator, arithmetic on a string, a `query.` name outside the six (drawn with a wavy underline, the only one on the page), a call with the wrong number of arguments, a `has_biome_tag` asking at `y = 0`, a `world*` read from an `iterations` expression, and a statement sequence with no `return`. Each one appears as a block under the box beginning with the word **`Error: `** or **`Warning: `**, with a **`Show me where`** button that selects the part of the expression it is about and a **`Why this matters`** disclosure for the long version.

**If the file changes while you are typing.** A save in the text editor, an undo, another window — something writes the file under an open box. If you have not touched the box, the new value simply arrives. If you have, nothing is thrown away: your text stays exactly as typed and a warning appears naming the value now on disk, with three buttons — **`Use the file’s version`** (abandons your edit, writes nothing), **`Keep mine`** (stops warning; your next save still overwrites the file) and **`Show the JSON`** (opens the file, changes nothing). Nothing is written until you commit, so the choice costs nothing either way. That warning is always listed first, because it is the only one with an irreversible outcome behind it.

**The rest of the keyboard.** Typing never saves. <kbd>Tab</kbd> or clicking away saves; <kbd>Escape</kbd> puts back what the file holds (or, with the completion list open, just closes the list). On an `iterations` box, **`Insert a pattern…`** drops in a working gate or a working setup expression to edit rather than a blank line.

## What the bench does differently

featurelab models this page's rules; three of them it deliberately does not reproduce.

- **It does not stop on an unresolved read.** The bench places one feature in isolation with an empty scope, so a slot a parent feature would have written is unset *here* and set in a real chunk. It substitutes `0`, carries on, and reports every read it swallowed by name — the diagnostic says so in as many words, and tells you that the game would have stopped there. Read it as a question rather than a verdict; guarding the read with `?? <default>` settles it either way. See [coverage and known gaps](../engine/coverage.md#bench-wide-approximations).
- **An unregistered `query.*` is not fatal here.** The bench evaluates it through Molang's general unregistered-member fallback: the arguments are still evaluated left to right, so nested calls and randomness inside them still happen in order, and then the call is discarded and the name reads back as `0`. So an expression the game refuses outright previews as one that quietly does nothing. The editor is the half that does tell you — it marks the name as an error and lists the six that exist — but a CLI run stays silent unless the query sits in a block predicate, which is named when the pack loads.
- **`min_engine_version` does not change the grouping here.** The bench always applies the 1.18.20-and-later precedence. A pack that declares an older version is evaluated by the modern rule, so a legacy-grouping surprise is one this tool will not show you.

One more, which is a difference in values rather than in behaviour: `math.random_integer` reaches its result by a different route in the bench than in the game. Both are inclusive of both ends, which is what this page states; where the two part company is on arguments written the wrong way round — the game reads them as a low and a high whichever order you write them, and the bench does not, and produces a very large number instead. Write the low bound first and the two agree.

## See also

- [RNG and determinism](./rng_and_determinism.md) — where the generator a `math.random` draws from comes from, and why a draw that does not happen moves everything after it.
- [Scatter features](./scatter_feature.md#molang-variables) — the type with the most Molang slots, and the exact order in which it publishes `origin*` and `world*`.
- [Conditional list features](./conditional_list.md) — the type whose whole job is a Molang gate.
- [Delegation and composite features](./feature_delegation.md#what-crosses) — the scope this page's `variable.` and `temp.` rules travel in, alongside the other three things that cross a boundary.
- [Coverage and known gaps](../engine/coverage.md#bench-wide-approximations) — the bench's side of the unresolved-read divergence, in its own words.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: the worldgen Molang surface and its behaviour are unchanged between the two.

The precedence change is the finding a reader can most easily re-check outside this project, against Microsoft's own "Versioned Changes" reference table. The two JSON files in *Start here* were run end to end through `featurelab check` and the `featurelab generate` command shown beside them, and the placed block, the branch taken and the `molangScope` values quoted are that run's output. The [random bounds table](#random-numbers) was re-measured rather than carried over: each call was evaluated several thousand times from different seeds and the extremes recorded, which is what settles `math.random` excluding its top end while `math.random_integer` includes both. The `??` results, the `query.noise` range and its value at the origin, the 32-bit rounding examples and the two precedence groupings were measured the same way. The editor behaviour in [Writing Molang in the editor](#in-the-editor) is quoted from the shipping control and its tests.

What is **not** claimed: the upper boundary of `variable.` lifetime above one delegation chain (the note above says so), and the precise probability of `math.random` reaching its top end, which is stated as an order of magnitude because that is all a pack author needs from it.
