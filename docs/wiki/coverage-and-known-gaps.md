# Coverage and Known Gaps

This page is a statement about **Minecraft Bedrock 1.26.50.24**
specifically. Worldgen internals move between releases; nothing here should be assumed to hold
for a different build without checking.

Every other page in this set describes the game. This one describes *how far the checking
goes* — which claims were reproduced against a running implementation, which are less certain,
and where the tool used to write these pages knowingly does something different
from the game. It exists so that the silences elsewhere are legible: a page that does not
mention a field is not the same as a page that mentions it and says it was never exercised.

## How claims on these pages are backed

Three different kinds of statement appear across the set, and they are not equally strong:

- **Stated as fact.** A default, an order of operations, a key that does or does not exist,
  described plainly.
- **Reproduced.** Shown by running an implementation of the same behaviour against a
  pack and comparing what came out. Pages that give a command and a table of resulting
  coordinates are in this class; you can re-run them.
- **Uncertain.** Stated with a note saying so, or left out. Where a page says a detail is
  assumed, not certain, or "this project's interpretation", it means exactly that.

The tool behind the reproduced class is **featurelab**, a bench that loads a behaviour pack,
runs one feature or one feature rule in a controlled volume, and reports the blocks. Everything
below is about the distance between that bench and the game.

## Type coverage

The game accepts **29** JSON feature types in this version. Of those the bench implements
**22 fully**, **5 partially**, and deliberately does not implement **2**.

The two it does not implement are `minecraft:beards_and_shavers` and `minecraft:rect_layout`,
both of which Microsoft's own reference classifies as internal and not for custom content. A
pack using either gets a diagnostic saying so. Their behaviour is summarised on the [index
page](./index.md) so an existing pack that uses one can still be read.

The five partial ones, and the specific thing each one is missing:

| Type | What is not modelled |
|---|---|
| [Single Block](./single-block-feature.md) | Rotation now rewrites the placed block's directional state the way the game does, for all sixteen state families. What is left is the *test* the game uses to decide whether a state is rewritten: it asks the block's **type** whether it can carry that state, while the bench can only see the states `places_block` actually spells out. `places_block: "minecraft:torch"` is placed unrotated here and turned in the game; write the state out and the preview is right. The gap only ever under-rotates. Separately, for ten of the sixteen families the direction is exact but the state name it is written under is taken from vanilla block definitions and less certain; those ten warn when you use them, and the families real packs use are not among them. |
| [Snap-to-Surface](./snap-to-surface-feature.md) | The per-face support test is now the real one — a floor scan accepts a top slab and refuses a bottom one — so what is left is narrower. What is left is `allowed_surface_blocks`, where the game compares each side's full block state (name plus every state at its concrete value) and completes both sides to the block's full state set first. Two consequences: a `{"tags": ...}` entry matches NOTHING in the game — it logs an error and substitutes `minecraft:unknown` — while the bench evaluates the predicate and accepts surfaces, and a partly-spelled state map matches more in the game than here, because the bench compares the written maps literally. |
| [Geode](./geode-feature.md) | Whether a bud may attach to a cavity wall runs through a per-block check whose last step consults a data-driven component the bench has no representation for. It cannot affect the four vanilla amethyst blocks, so the warning fires only for an `inner_placements` block outside that set. |
| Sculk Patch (no page — see Scope below) | The spread/growth simulation runs on the game's per-block behaviour system. A feature configured to actually run it refuses at build time rather than placing a patch missing everything the spread would add. |
| [Horizontal Tree Decoration](./horizontal-tree-decoration-feature.md) | The game first checks that `places_block`'s *type* declares both a `cardinal_direction` and a `growth` state. The bench has no per-block-type state registry, so it assumes the check passes and says so. A block missing either state looks like it works on the bench and places nothing in the game. |

## Bench-wide approximations

These are not per-type gaps; they affect any page whose claims were checked by running
something.

**Block predicates.** The game asks questions like "is this block solid-blocking", "can it
support a face", "is it motion-blocking". Three of those now carry the game's own per-block
answer: face support, motion-blocking, and solid-blocking. What is left is custom blocks — a
block a pack defines itself is treated as an ordinary full cube for all three, because the bench
does not read a custom block's material or collision box, so one with its collision removed still
counts as blocking. A handful of internal checks elsewhere in the bench (the geode anchor test,
the sculk-patch neighbour scan) still answer from the bench's own block classification, which is
a different question and is right for those uses.

**No per-block-type state registry.** The bench knows the states of a block it placed, not the
states a block *type* declares. Every check of the form "does this block have state X at all" is
therefore assumed rather than performed, with a warning. Horizontal Tree Decoration above is the
case where this is load-bearing.

**Directional block states are rewritten only where you wrote them.** The bench applies the
game's own rotation table — all sixteen state families, on both [Single
Block](./single-block-feature.md) and [Multi Block](./multi-block-feature.md) — but decides
*whether* a state gets rewritten by looking at the states the JSON spells out, where the game
asks the block's type what it can carry. So a block written as a bare name is placed unrotated
where the game would turn it (this is the "no per-block-type state registry" limitation above,
seen from the placement side). The one exception is a multi-block's own
`minecraft:cardinal_direction`, which the bench does read from the block's traits and so rotates
even when the descriptor left it unwritten. The draws happen in the same order either way, so this
changes appearance, not sequence.

**Blocks that land outside the bench's volume are lost, and one type reports that as a failure.**
The bench generates a finite area; the game writes into a chunk column with no such edge. Every
type simply loses writes that fall outside, but [Fossil](./fossil-feature.md) also *fails* the
placement when it loses all of them, where the game reports success without ever looking. A
fossil is buried 15 to 24 blocks below the surface and its anchor is never put lower than ten
blocks above the bottom of the generated area, so an area ten blocks tall or less fails on every
seed, and one narrower than about thirty-two blocks loses some placements off its east and south
edge. It costs no draws, so nothing downstream shifts — generate a taller or wider area.

**Surface height is finished terrain, not the game's pre-generation estimate.** The bench
looks it up at the same 4×4 granularity the game uses, but the value is the height of the
terrain it built, where the game consults an estimate made before generation. Affects the
height-relative gate types.

**One feature at a time, in an empty bench.** The bench places the feature under test in a world
built from a preset, with no other features, no structures, and no neighbouring chunk content.
Anything the game decides by consulting *other* generated content — a fossil skipped because a
mineshaft already claims the spot — cannot happen there. That is a property of previewing one
feature in isolation, not an approximation of the feature.

**An unresolved Molang read stops the expression in the game; the bench reads it as 0 and carries
on.** Reading a `variable.`/`temp.`/`context.` slot that nothing has written ends the expression
where it stands in the game — the read is `0`, and no assignment or `math.random` after it runs
(see [Molang in World Generation](./molang-in-world-generation.md#reading-a-slot-nothing-has-written)).
The bench does not do that, anywhere, and the reason is the entry below this one: it places one
feature in isolation with an empty scope, so a slot that a parent feature earlier in the delegation
chain — or the feature rule's own scatter walk — would have written is unset *here* and set *there*.
Faithfully stopping would end a large share of a typical pack's chains at their first read, showing
nothing, for a reason belonging to the bench rather than to the pack. So the read yields `0`, evaluation
continues, and every single swallowed read is reported by name with the count of how often it
happened. Read such a diagnostic as a question rather than a verdict: if something upstream really
does write that slot, the preview is right and the message is noise; if nothing does, the game
stops there and the feature places nothing. Guarding the read with `?? <default>` settles it either
way, and is what the guard is for. The same substitution applies inside a `{"tags": ...}` block
predicate, where the scope is empty by construction and the diagnostic is raised once, when the
pack loads, rather than once per block tested.

**Two random sources the game does not make reproducible.** The cave carvers'
`width_modifier` and the multiface spread order both draw, in the game, from generators with
no world seed behind them — so no two runs of the *game* agree either. The bench substitutes
seed-derived values so a preview stays stable while you edit, and warns when it does. See [RNG
and Determinism](./rng-and-determinism.md) for which Molang randoms are reproducible and why.

**The string that names a decoration entry from a feature rule** is the rule's own
`description.identifier`, not its `places_feature`. See the [RNG page](./rng-and-determinism.md#2-each-decoration-entry-in-the-chunk-gets-its-own-seed).

## What has, and has not, been checked against real content

Most types on these pages were checked against a large behaviour pack that is not part of this
repository — thousands of feature files, placed and compared block for block against a recorded baseline, so a change in
behaviour anywhere shows up as a difference. That is the strongest evidence in this set, and it
covers the types packs actually use heavily: scatter, single block, trees, aggregates and
sequences, ores, and the rest of the common vocabulary.

Three groups fall outside it:

- **The carvers.** The behaviour pack behind the paragraph above does not use any of the three
  carver types, so the [Cave
  Carver](./cave-carver-feature.md), [Underwater Cave
  Carver](./underwater-cave-carver-feature.md) and [Nether Cave
  Carver](./nether-cave-carver-feature.md) pages rest on the bench's own
  tests, without a differential check against real content behind them. What they do now have is
  the smaller, committed baseline: one worked example per type, each pinned block for block and
  draw for draw, so a change in any of the three shows up as a difference even though no pack in
  the wild is watching. Their pages say which numbers came from which.
- **The types new in this version.** `multi_block`, `multipart_block_column` and
  `horizontal_tree_decoration` post-date every pack there is to check against.
- **Anything a pack does not happen to use.** Coverage by usage is not coverage by field: a type
  can be heavily exercised and still have one key nothing in that pack sets. The
  `structure_template` `leveled` constraint was exactly that case — real, documented, and used
  by nothing, so nothing would have noticed it being wrong.

## Deliberate scope decisions

- The two internal types above are not implemented and are not queued.
- `minecraft:scan_surface` carries the same internal classification but *is* documented, because
  packs in the wild already use it. `minecraft:sculk_patch_feature` does not have a page — see
  the table above.
- Bit-for-bit reproduction of the game's random stream is not a goal of the bench. Draw kinds,
  draw counts and draw order are modelled exactly, because those are behaviour; the exact
  sequence of values is not chased where the two disagree, and where it is deliberately
  different the page says so.

## See also

- [Index](./index.md) — the full type list, including the ones without pages.
- [RNG and Determinism in World Generation](./rng-and-determinism.md) — the seeding chain, and
  which parts of it are less certain.
- [Feature Delegation and Composite Features](./feature-delegation.md) — the three limits the
  bench adds that the game has no concept of.
