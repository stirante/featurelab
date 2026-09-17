# Molang in World Generation

This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically.
The worldgen Molang surface described here — every namespace, query and evaluation rule, and how
each behaves — is unchanged between 1.26.40.26 and 1.26.50.24, so this page describes both
versions. Worldgen internals move between releases; nothing
here should be assumed to hold for a different build without checking.

**Molang** is the expression language behind `distribution` ranges, `iterations` counts, and
gate conditions throughout the worldgen feature system — the same language used in entity
and render controllers, but running in a different host with different rules about what
persists and what doesn't. Most of what makes Molang genuinely useful for chaining worldgen
features together is undocumented anywhere public; this page exists to fix that.

## Namespaces and short aliases

Every Molang identifier in a worldgen expression belongs to one of five dotted namespaces,
each with a single-letter alias that's interchangeable with the full name:

| Namespace | Alias | Meaning in world generation |
|---|---|---|
| `math.` | `m.` | Stateless math functions (`math.sin`, `math.random`, …). |
| `query.` | `q.` | Read-only values the engine computes for you — `query.noise`, `query.has_biome_tag`, … |
| `variable.` | `v.` | Read-write values shared across a placement chain (see below). |
| `temp.` | `t.` | Read-write values shared even more broadly than `variable.` (see below). |
| `context.` | `c.` | A genuine namespace recognized by the parser — legal to write `context.anything` — but nothing in world generation ever populates it. It is a read-write namespace like `variable.`/`temp.`, not a query one, so a `context.*` read with nothing to read is an *unresolved read* and stops the expression (see [below](#reading-a-slot-nothing-has-written)). Since nothing in world generation writes one, that is every `context.*` read. |

`math.random`/`math.die_roll` (and their variants) draw from whichever random source the
evaluating path installed — and for the paths a pack normally cares about, that is the **same
seeded `Random`** the currently-placing feature draws from. A Molang expression evaluated
mid-`distribution` is not a side channel: it consumes draws from, and affects the order of, the
feature's own RNG stream. See [RNG and Determinism](./rng-and-determinism.md) for why draw
*order* matters as much as draw *count*.

::: warning
**That is a property of the path, not of `math.random`.** Unless a path supplies one, the random source
is a process-global generator with no world seed behind it at all — it is non-deterministic.
A scatter's distribution
installs the placing feature's seeded generator over that default before evaluating anything, so
everything inside a distribution is reproducible. A path that installs nothing is not: the known
case is the cave carvers' `width_modifier` (see [Cave Carver
Features](./cave-carver-feature.md)), where a `math.random` does not repeat from run to run even
at the same world seed, in the real game. If an expression's value has to be reproducible, keep
it where the seeded source is installed.
:::

## Scope lifetime: `temp.` versus `variable.`

This is the single most useful — and least documented — fact about worldgen Molang:

::: warning
**`temp.` is thread-local and is never reset between features.** A value written to
`t.something` by one feature is still readable by name from the very next feature placed on
that thread, even if that next feature is a completely different type, with no explicit
wiring between them at all.
:::

This is a genuinely different rule from Molang's general-purpose behaviour: outside world
generation (entity/animation-controller Molang), `temp.` is commonly described as pack-scoped
and ephemeral — cleared once the current expression or loop finishes. That description does
not hold for the worldgen host. Treat the two as separate contracts with the same syntax.

`variable.` has a narrower guarantee. It propagates
**unconditionally within one placement chain** — a top-level feature and everything it
delegates into, however many feature-type boundaries that crosses. Every placement shares one
variable scope with the features it delegates to, rather than forking or clearing it before
calling into a sub-feature. This holds for eight Proxy feature types (`aggregate_feature`,
`sequence_feature`, `weighted_random_feature`, `conditional_list`, `scatter_feature`,
`snap_to_surface_feature`, `surface_relative_threshold_feature`, `scan_surface`), and real
packs rely on it heavily: a value written in one file is commonly read in a file reachable
through it via `places_feature`/`features`, often across intermediate features that neither
write nor read it.

```json title="A published-pack idiom this makes possible"
{
  "format_version": "1.21.110",
  "minecraft:scatter_feature": {
    "description": { "identifier": "example:mushroom_ring_root" },
    "places_feature": "example:mushroom_ring_gate",
    "distribution": {
      "iterations": "t.has_moss = query.noise(v.worldx, v.worldz) > 0; return 1;",
      "x": 0, "y": 0, "z": 0
    }
  }
}
```

```json
{
  "format_version": "1.21.110",
  "minecraft:conditional_list": {
    "description": { "identifier": "example:mushroom_ring_gate" },
    "conditional_features": [
      { "places_feature": "example:mushroom_ring_moss", "condition": "t.has_moss" },
      { "places_feature": "example:mushroom_ring_bare",  "condition": "!t.has_moss" }
    ]
  }
}
```

The `scatter_feature` writes `t.has_moss` as a side effect inside its `iterations`
expression (using the assignment's own return value would be wrong here, which is why the
expression ends with an unconditional `return 1;` — it always wants exactly one iteration;
only the assignment is doing real work). The `conditional_list` it delegates to — a
different feature type, with no field that explicitly forwards the value — reads
`t.has_moss` straight back. This is not a contrived example: it's the general shape of a
real idiom common in published packs, used specifically because
`variable.`/`temp.` survive exactly this kind of hop.

::: note
**What's *not* settled:** whether `variable.` resets at any boundary *above* a single
top-level `places_feature` call tree — e.g. between two unrelated entries in a biome's
decoration list, or between chunks. `temp.`'s thread-local, never-reset behaviour is at
least as permissive as `variable.`'s in-chain guarantee, but the upper boundary
for both is not known with certainty. Don't rely on either surviving between two
features that aren't in the same delegation chain without testing it.
:::

## Reading a slot nothing has written

A `variable.`/`temp.`/`context.` name that has **never been written** is not the number zero.
The game keeps "this slot holds no value" and "this slot holds `0`" apart, and they behave
completely differently:

::: warning
**An unresolved read stops the expression where it stands.** The read itself yields `0`, but
nothing sequenced after it runs — not the rest of the expression, not the assignments, not the
`math.random` calls. The expression's value is that `0`, so a `distribution` that reads an unset
name does not fail loudly; it quietly evaluates to zero *and* skips every draw the rest of the
expression would have taken.
:::

That last part is the one that bites. `v.unset + math.random(0, 4)` does not draw. Neither does
anything later in the same expression, so an expression that both seeds a slot and draws can
leave the whole chain reading from a different point in the random stream than you expect — see
[RNG and Determinism](./rng-and-determinism.md) for why the *position* in the stream matters as
much as the count.

### `??` is a try/catch, not a null test

`??` is the guard for exactly this. What it catches is "the read on my left found no value" —
not falsiness, not `NaN`, not a null of any kind:

```json title="the idiom, and what each spelling means"
"t.cut_corner_chance = t.cut_corner_chance ?? 0.35; return t.cut_corner_chance;"
```

- `v.unset ?? 5` is **5** — the read found nothing, so the right side runs.
- `v.x = 0; return v.x ?? 5;` is **0** — a slot holding zero is resolved, and does *not* divert.
- `math.sqrt(-1) ?? 5` is **NaN** — `NaN` is a value; `??` never looks at it.
- `v.a ?? v.b`, both unset, ends the expression at `v.b`. The guard covers its **left side only**,
  and it is spent by the time the right side runs.

So the idiom above is the way to write "default this if nobody upstream set it", and it is the
only thing that makes an expression safe to read a slot a *parent* feature might or might not
have written. Write the guard, or write the slot first.

`query.` does not take part in any of this, in either direction. A `query.` name the game does
not recognize is rejected when the expression is compiled rather than at evaluation time, so a
`query.` read that runs at all has a value — there is nothing for `??` to catch and nothing to
stop the expression.

::: note
**The bench does not stop.** featurelab, the tool used to check these pages, places one feature in
isolation with an empty scope, so a slot a parent feature would have written is unset there and
set in a real chunk. It substitutes `0`, carries on, and reports every read it swallowed by name.
That is a deliberate, disclosed divergence from the behaviour above — see [Coverage and Known
Gaps](./coverage-and-known-gaps.md#bench-wide-approximations). If you are reading a preview and a
diagnostic names an unset variable, the game would have stopped there.
:::

## The `&&` / `||` precedence change is versioned

Molang's `&&`/`||` precedence is not fixed — it's gated on the pack's declared
`min_engine_version`, and the two rules produce genuinely different groupings, not just a
style difference:

- **Before 1.18.20:** `||` binds tighter than `&&`. `A && B || C && D` groups as
  `A && (B || C) && D`.
- **From 1.18.20 on:** standard C/JS precedence — `&&` binds tighter than `||`.
  `A && B || C && D` groups as `(A && B) || (C && D)`.

These two groupings disagree on real inputs, not just in theory: with `A=0, B=0, C=1, D=1`,
the pre-1.18.20 grouping evaluates to `0` and the 1.18.20+ grouping evaluates to `1`.

```json title="place_condition — evaluates truthy under 1.18.20+ precedence"
"0 && 0 || 1 && 1"
```

Under the modern grouping, `(0 && 0) || (1 && 1)` = `0 || 1` = true. Under the legacy
grouping, `0 && (0 || 1) && 1` = `0 && 1 && 1` = false. A pack whose `manifest.json`
declares an engine version at or above 1.18.20 gets the modern grouping; anything older gets
the legacy one. This is why a condition that looks obviously true or false by C-style reading
can silently evaluate the other way in an older pack — the fix isn't in your expression, it's
in `min_engine_version`.

::: note
This is a real, versioned change, and it matches Microsoft's own published "Versioned Changes"
note for 1.18.20. Comparison-before-equality precedence and right-associative ternary chaining
do not change at any version — only `&&`/`||` actually changes.
:::

## Molang evaluates in float32, not double

Every value a Molang expression touches during worldgen — literals, variable/temp reads,
arithmetic, and the `math.*` library — is a **32-bit float**, not a double. This isn't a
detail that only matters for exotic edge cases: every operation produces a 32-bit float, every
intermediate value is held as 32 bits, and even a plain `+` is a
32-bit float add, never a 64-bit one. `math.sin`/`math.cos`/`math.pow` go further — they use the
platform's single-precision `sinf`/`cosf`/`powf`, including a degree-to-radian constant that
is itself rounded to float32 *before* the call, not computed in double and truncated after.

::: warning
If you're tuning a threshold — `query.noise(...) > 0.3527`, say — by computing the comparison
value in a double-precision calculator, spreadsheet, or scripting REPL, don't assume the
in-game result matches bit-for-bit near the boundary. Both the noise value and the
comparison itself happen in float32 in-game; a value that looks safely on one side of the
threshold in double precision can land on the other side once every intermediate value has
been rounded to float32. This matters most for thresholds you've tuned to a precise-looking
decimal rather than a round number.
:::

## `query.noise` and what's actually available during worldgen

`query.noise(x, z)` is Bedrock's 2D value-noise query — a single-octave, hardcoded-seed
(`2345`) simplex noise, evaluated purely as a function of the two arguments you pass it. It
is **not** seeded from the world seed and **not** implicitly positional — nothing reads the
current placement position for you; the common idiom is `query.noise(v.worldx, v.worldz)`,
using the `worldx`/`worldy`/`worldz` variables that several feature types write into
`variable.` on your behalf.

::: warning
**When those variables get written differs by feature type, and for `scatter_feature` it is
not "before your expressions run."** A [Conditional List
Feature](./conditional-list-feature.md) writes all three — plus, as of 1.26.50.24, matching
`originx`/`originy`/`originz` with the same values — from its origin before evaluating any
condition. A [Scatter Feature](./scatter-feature.md#molang-variables) does **not**: it writes
`variable.originx`/`originy`/`originz` from its origin up front, and writes each
`world*` component only as that axis is evaluated, holding the *absolute* coordinate. So inside
a scatter's `distribution`, `iterations` and `scatter_chance` read whatever `world*` an
enclosing feature happened to leave there, an axis expression reads the axes evaluated before it
in `coordinate_eval_order`, and `origin*` is the only reliable way to read the scatter's own
origin. The scatter page documents the exact sequence.
:::

Beyond `noise`, the queries actually reachable from a worldgen Molang expression are narrow
compared to the full entity/render query surface documented elsewhere:

- `query.noise(x, z)`
- `query.has_biome_tag(tag)`, `query.any_tag(tag, …)`, `query.all_tags(tag, …)`
- `query.heightmap(x, z)`, `query.above_top_solid(x, z)`
- `math.random(min, max)`, `math.die_roll(...)` and their variants — draw from the placing
  feature's own `Random`, not a separate stream

Any other `query.*` name **is refused when the expression is tokenised**, and the whole file
fails to load: `Failed to resolve query <name>. Either the query does not exist or it is not
supported in this context.` A misspelled query is not a silent zero — it is a pack that does not
load, which is worth knowing because it is the opposite of what happens for a misspelled
`variable.` or `temp.` name.

This is one place the bench is deliberately more forgiving than the game. featurelab evaluates an
unregistered `query.*` using Molang's general unregistered-member fallback — the arguments are
still evaluated left to right, so RNG draws and nested calls inside them still happen in order,
and then the call is discarded and the name reads back as 0. So an expression the game would
refuse outright previews here as one that quietly does nothing. Where a misspelling is detectable
the bench says so at load time; see the block-predicate diagnostic, which names the query and says
the game refuses the file.

## Version and verification notes

Everything above is a statement about 1.26.50.24 specifically, and holds
for 1.26.40.26 too: the worldgen Molang surface and its behaviour are unchanged between the
two versions.

The precedence change is the finding a reader can most easily re-check outside this project,
against Microsoft's own "Versioned Changes" reference table. The two JSON examples on this page were run end to end
against this project's own worldgen tooling (`featurelab check` and `featurelab generate`) and
produced the described results.
