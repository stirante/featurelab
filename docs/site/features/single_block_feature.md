---
title: Single block feature
description: minecraft:single_block_feature places exactly one block at the origin it is given. Every key in a table, the nine attach faces and the two different checks they run, what rotation rewrites and what it leaves alone, and why a refusal is usually the file working — measured against Minecraft Bedrock 1.26.50.24.
typeId: minecraft:single_block_feature
category: content
game: 1.26.50.24
alsoHolds: ["1.26.40.26"]
scope: game
---

# Single block feature

<VersionBadge><CoverageBadge /></VersionBadge>

**`minecraft:single_block_feature` places exactly one block, at the origin it is given, and nothing else.** It has no footprint search, no loop and no delegation: it picks one block from a weighted list, checks that the neighbours and the cell itself allow it, and writes it. That makes it a **Content feature**, and the one almost every pack authors at least once — everything more elaborate than "one block here" (patches, veins, columns, rings) is another feature type built *around* this one, most often a [scatter feature](./scatter_feature.md) delegating to it over and over.

You do not reach for it to place a *vein* or a *patch* — those are [ore](./ore_feature.md) and scatter respectively — and you do not need it at all if the block you want is already the delegate of something else. What you do need it for is the far end of almost every delegation chain, and a rule pointing at the chain's root is what gets any of it into a world: see [feature rules](./feature_rules.md).

## Start here: a complete example

One file, complete. It picks a pumpkin three times out of four and a jack o'lantern the fourth, refuses any position that is not air, and refuses any position whose block below is not grass. This is `wiki:pumpkin_patch_block`, the delegate every other example on this site reuses unchanged:

```json title="features/pumpkin_patch_block.json"
{
  "format_version": "1.21.110",
  "minecraft:single_block_feature": {
    "description": { "identifier": "wiki:pumpkin_patch_block" },
    "enforce_placement_rules": false,
    "enforce_survivability_rules": false,
    "places_block": [
      { "block": "minecraft:pumpkin", "weight": 3 },
      { "block": "minecraft:jack_o_lantern", "weight": 1 }
    ],
    "may_replace": ["minecraft:air"],
    "may_attach_to": { "bottom": "minecraft:grass_block" }
  }
}
```

What each choice buys you:

- **The weighted `places_block` array** makes the pick a per-placement probability, not a quota: weight 3 against weight 1 of a total of 4 means three chances in four, every time, with no memory of the last one. A single block descriptor — a bare name — is the shorthand for "always this block".
- **`may_replace: ["minecraft:air"]`** keeps the pumpkin from overwriting terrain. Leave the key out and the feature happily writes over whatever is already there.
- **`may_attach_to: { "bottom": "minecraft:grass_block" }`** is the hard gate that pins each pumpkin to the surface. `bottom` uses the single-descriptor shorthand — a bare name where a list is accepted — which is specific to the attach keys; `may_replace` above it must be an array.
- **Both `enforce_` keys** are there because the schema demands them, not because they do anything: during world generation both are inert whatever you set. See [the two `enforce_` keys](#enforce-keys).

![A single pumpkin sitting on a patch of grass, rendered by featurelab's voxel viewer](../../wiki/images/single-block-feature-pumpkin.png)

```
featurelab generate --pack <pack> --feature wiki:pumpkin_patch_block --env plains --seed 1
```

Run against the `plains` preset (grass over dirt over stone) with feature seed `1`, the weighted pick lands on `minecraft:pumpkin`, the origin resolves to the first free cell above the terrain column at `(0, 0)` — world `(0, 63, 0)`, with grass at `y 62` directly below it — and every check passes: one block written. Because `may_attach_to` is configured, the default-true `auto_rotate` applies too, and the pumpkin comes out carrying `minecraft:cardinal_direction: "west"` — no side list is configured, so all four sides match for free and the last one wins. See [rotation](#rotation).

::: tip A single block feature that reports a failure is usually not a problem
This type refuses far more often than it places, and that is the point of it. When the same file is reached fourteen times through a scatter, a couple of the offsets land where the block below is not grass, and `may_attach_to` turns each of those down — exactly as written. The refusal is reported, by position and by which check turned it down, in `featurelab generate`'s `diagnostics`; it is not an error, and raising the caller's `iterations` to "get them all back" is usually the wrong fix. Count the refusals you did not intend, not the refusals.

What is worth checking is the *kind* of refusal. "`may_replace` rejected this position: it holds …" means the cell was occupied; an attach refusal means the neighbours were wrong. `featurelab check` will not show you either — it never runs a placement — so a per-position refusal is something only `generate` has.
:::

## Fields

Seven keys sit on the feature body, and two of them open objects of their own. "Default" is what the game uses when the key is absent. The long-form account of every key, in the editor's own words, is the [field reference](#field-reference) further down; these tables are the short version.

### On the feature body

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `places_block` | yes | a block descriptor, or an array of `{block, weight}` | — | The block written at the origin. A bare name, `{name, states}` or `{tags}` all work at every version; the weighted array arrived in the **1.21.40** band — see [what your `format_version` decides](#format-version). |
| `enforce_placement_rules` | **yes** | boolean | — | Required by the schema and inert during world generation, whatever you set. See [the two `enforce_` keys](#enforce-keys). |
| `enforce_survivability_rules` | **yes** | boolean | — | The same: required, and inert during world generation. |
| `randomize_rotation` | no | boolean | `false` | Turns the block toward a random horizontal direction, after the `may_replace` check, and switches `auto_rotate` off. From **1.21.40**; below it the block is always placed unrotated. |
| `may_replace` | no | array of block descriptors | no constraint — the feature overwrites whatever is there | Which blocks the feature is allowed to overwrite; `["minecraft:air"]` is the usual answer. **Only an array**: the single-descriptor shorthand the attach keys have does not exist here, and a bare string is an error. |
| `may_attach_to` | no | object — [the faces below](#attach-conditions) | the attach test does not run | Neighbours that make this a valid position. Writing the key at all — even as a bare `{}` — switches the whole attach test on, and with it `auto_rotate`. |
| `may_not_attach_to` | no | object — the same nine faces | nothing is denied | Neighbours that make this an *invalid* position. From **1.21.40**; below it there is no deny list at all. |

### Inside a `places_block` array entry

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `block` | yes | a block descriptor | — | One candidate. A bare name, `{name, states}`, or `{tags: "<Molang query>"}`. |
| `weight` | yes | number | — | This entry's share of the pick, relative to the total of every weight in the list. The weights need not add up to anything in particular. |

### Inside `may_attach_to`: nine faces, two kinds of check {#attach-conditions}

The nine face keys do not all behave the same way, and which kind a face is decides whether `min_sides_must_attach` can rescue it. Each takes a block descriptor **or** an array of them.

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| `top` | no | descriptor or array | not checked | **Hard gate.** Configured and unmatched, the placement fails outright. Never counted. |
| `bottom` | no | descriptor or array | not checked | **Hard gate.** The key most files use: "must sit on grass". |
| `north`, `east`, `south`, `west` | no | descriptor or array | not checked — **counts as matching, for free** | **Counted.** Each cardinal side matches or it does not, and the number that match must reach `min_sides_must_attach`. |
| `all` | no | descriptor or array | not checked | A group key, not a direction: it applies to all **ten** neighbours at once — the six faces plus the four horizontal diagonals — in addition to whatever the specific key says. |
| `sides` | no | descriptor or array | not checked | A group key for the four cardinal sides only, consulted in addition to each of them. Counted, as they are. |
| `diagonal` | no | descriptor or array | not checked | **Hard gate** on the four horizontal diagonal neighbours (`x±1, z±1`). From **1.21.40**; below it those four are not tested. |
| `min_sides_must_attach` | no | integer — **no minimum is enforced**, and a negative one loads | **`4`** — not 1 | How many of the four cardinal sides must match. Free matches count, so a file that configures no side list meets it trivially; a file that configures two side lists needs **both**. A fraction truncates toward zero and a negative value makes the side count pass everywhere. See [the warning below](#min-sides). |
| `auto_rotate` | no | boolean | **`true`** | Turns the block toward the last cardinal side that matched. Active whenever the attach test is on — including a bare `{}`. See [rotation](#rotation). |

### Inside `may_not_attach_to`

| Key | Required | Value | Default | What it does |
|---|---|---|---|---|
| the same nine faces: `top`, `bottom`, `north`, `east`, `south`, `west`, `all`, `sides`, `diagonal` | no | descriptor or array | nothing is denied | The mirror image, and blunter: if any configured list matches its neighbour, the placement fails. No counting, no minimum, no free pass for an unconfigured direction. One match kills it. |
| `min_sides_must_attach`, `auto_rotate` | no | as above | — | **Accepted here, and what they do in this object is not established.** The copies that are certainly read are the ones inside `may_attach_to`; write them there, where the effect is known. |

## Common mistakes

| You wrote | What happens | Do instead |
|---|---|---|
| `"east": "minecraft:dirt"` **and** `"west": "minecraft:dirt"`, meaning "either side will do" | The default `min_sides_must_attach` of 4 needs 2 free matches plus **both** of those, so both must match. There is no "how many of the configured faces, default 1" model — it does not exist. | Lower `min_sides_must_attach` to the number you actually mean. |
| `"may_attach_to": {}` to turn something off, or as a placeholder | It turns the attach test **on**, and with it the default-true `auto_rotate` — so the block comes out facing west, in the game as much as in a preview. | Remove the key entirely if you want neither. |
| `"may_replace": "minecraft:air"` | Refused at load: `may_replace must be an array`. The single-descriptor shorthand belongs to the attach faces only. | `["minecraft:air"]`. |
| `{ "name": "minecraft:oak_log", "states": { "pillar_axis": "y" } }` in a list, out of a wish to be precise | Only the states you wrote are compared — which *narrows* the match. A bare name would have matched the block in any state. | Write the bare name unless you mean to narrow it. See [which blocks a list matches](#block-matching). |
| `"randomize_rotation": true` in a file whose `format_version` is below `1.21.40` | The key does not exist in that band: it is reported by name, dropped, and the block is placed unrotated. | Check the `format_version` before anything else — see [what your `format_version` decides](#format-version). |
| An array `places_block` in a file below `1.21.40` | The array cannot satisfy the single-descriptor shape, the required key is left unset, and the whole file fails to load. | Raise the `format_version`, or write one descriptor. |
| `"places_block": { "name": "…", "states": { "pillar_axis": "y" } }` expecting the `y` to survive a rotation | Rotation is an absolute **set**, not a turn: it never reads the state you wrote. The block comes out `x` or `z`. | Do not configure a rotation for a block whose orientation you wrote by hand. |
| `"min_sides_must_attach": 1` written inside `may_not_attach_to` | Accepted, and not established to do anything there. The deny list does no counting at all. | Write it inside `may_attach_to`. |
| Expecting a rotation to turn a standing banner or a slab | `rotation` and `minecraft:vertical_half` are not among the sixteen states a rotation rewrites, despite looking directional. | Nothing to do — those two are untouched. |
| Expecting a rail to point somewhere after a rotation | `rail_direction` has no entry for any horizontal direction, so a rail caught by a rotation comes out `rail_direction: 0` whichever way the rotation points. | Nothing to do; that is the game's behaviour, not a rounding of it. |
| Reading a refusal as a bug | Most of what this type does is refuse. | Check which check refused, and whether you meant it to. |

## How it runs

Given an origin, the feature runs these steps in this order, and stops at the first one that fails:

1. **Check the neighbours against `may_not_attach_to`**, if it is configured. Any configured list that matches its neighbour ends the call here.
2. **Pick one candidate from `places_block`** by weight.
3. **Check the neighbours against `may_attach_to`**, if it is configured: the hard gates individually, the four cardinal sides against `min_sides_must_attach`. With `auto_rotate` on, this is also where the block's orientation is taken from the matching side.
4. **Check the target cell against `may_replace`**, if it is configured.
5. **With `randomize_rotation`**, roll a random horizontal direction and turn the block toward it.
6. **Write the block at the origin.**

Nothing here reads or writes any position other than the origin itself and, for steps 1 and 3, the origin's immediate neighbours. This feature never touches a second block, and it returns the origin it was handed.

## Attach conditions: hard gates and counted sides {#min-sides}

`may_attach_to` restricts placement to positions whose neighbours already match specific blocks — the mechanism behind torches, vines, and anything else that must be stuck to something. Nine face keys, and the game treats them as **two different kinds of check**:

- **`top`, `bottom` and the four diagonals are hard gates.** Each one that is configured — through its own key, or through `all` — must match its neighbour, individually, or the placement fails outright. They are not counted, and `min_sides_must_attach` has no effect on them.
- **The four cardinal sides are counted.** Each side — checked against its own key, against `sides`, and against `all` — either matches or does not, and the number of matching sides must reach `min_sides_must_attach`. A side with **nothing configured for it counts as matching, for free.**

::: warning Configuring several side lists means ALL of them must match by default
`min_sides_must_attach` defaults to **4**, not 1. With `"east": "minecraft:dirt"` alone, three free matches plus east make four, so east must match. With east *and* west configured, both must. This is the opposite of a "how many of the configured faces must match, default 1" model — that model does not exist in the game, and a file written against it will place almost nothing.

The same two facts are why simple packs never notice the setting at all: a `may_attach_to` that configures no side list — only `bottom`, say, or nothing but `{}` — passes the count trivially on four free matches.
:::

::: note `may_attach_to.<face>` takes a single block descriptor as shorthand for a one-element list
A bare name string, or a `{name, states?}` / `{tags}` object, not wrapped in an array. This is specific to `may_attach_to` and `may_not_attach_to`'s per-face fields — it is **not** a general rule for every "list of block descriptors" field in the worldgen JSON schema. `may_replace` and `allowed_surface_blocks`, for example, accept only arrays.
:::

`may_not_attach_to` is the mirror image: the same nine face keys as a **deny list**. If any configured list matches its corresponding neighbour, the placement fails before the block is even picked. There is no counting and no minimum here; one match kills the placement, and `all` again covers the six faces plus the four horizontal diagonals.

## Rotation: `auto_rotate` and `randomize_rotation` {#rotation}

Two fields turn the placed block's directional states, and they do not stack:

- **`auto_rotate`** — inside `may_attach_to`, default **true**, active whenever the attach test is configured at all — turns the block toward the **last matching cardinal side** during the attach check. Sides are checked north, east, south, west, and each match re-derives the orientation from the *original* block, so the last match wins. For a fully unconfigured side set, that is west, which is why a file with a bare `may_attach_to: {}` always comes out facing west.
- **`randomize_rotation`** — on the feature body, default false — rolls a random horizontal direction after the `may_replace` check and turns the block toward it. When it is set, `auto_rotate` is ignored.

Rotation only changes blocks that carry one of **sixteen** directional states; a stone or dirt block passes through unchanged. The full list: `portal_axis`, `minecraft:cardinal_direction`, `minecraft:facing_direction`, `minecraft:block_face`, `direction`, `facing_direction`, `rail_direction`, `torch_facing_direction`, `ground_sign_direction`, `weirdo_direction`, `coral_direction`, `lever_direction`, `pillar_axis`, `vine_direction_bits`, `multi_face_direction_bits`, `orientation`. Note what is *not* there: `rotation` — standing banners and signs — and `minecraft:vertical_half` are untouched, despite being directional-looking.

Three things about the transform surprise people:

- **It is an absolute set, not a turn.** The rotation never reads the state you wrote. Whatever `places_block` said, the direction the rotation names replaces it — a block written as `pillar_axis: y` comes out as `x` or `z`, not left alone.
- **Every state the block carries is rewritten, in one pass.** A block carrying both `minecraft:block_face` and `pillar_axis` gets both set. There is no "first match wins".
- **`rail_direction` is a special case, and it looks like a bug.** Its mapping has no entry for any horizontal direction at all, so a rail caught by a rotation is set to `rail_direction: 0` whichever way the rotation points. That is the game's behaviour, not a rounding of it.

For each of the sixteen, the value the game picks for a given direction is known. For the **six** families real packs actually use — `minecraft:block_face`, `minecraft:cardinal_direction`, `pillar_axis`, `ground_sign_direction`, `vine_direction_bits` and `multi_face_direction_bits` — the *name* that value is written under is known too. For the other **ten** it is taken from vanilla block definitions and is less certain; `featurelab check` says so when a file uses one.

## Which blocks a list matches {#block-matching}

::: tip A bare block name matches that block in **any** state
`"minecraft:oak_log"` in a `may_replace` matches an oak log lying on its side just as well as one standing upright — the comparison is on the block *type*, and every state of one block shares one type. Write states out only when you mean to narrow the match:

```json
{ "name": "minecraft:oak_log", "states": { "pillar_axis": "y" } }
```

and then **only the states you wrote are compared.** A candidate carrying `pillar_axis: "y"` matches whatever else it happens to carry; one carrying `pillar_axis: "x"` does not. This is worth knowing because it is easy to write states out of a wish to be precise and end up matching nothing: in practice nearly all block descriptors in real packs are bare names, and that is usually the right call.
:::

Two fields do **not** work this way, and both are documented on their own pages:

| Field | Comparison |
|---|---|
| `may_replace`, `may_attach_to`, `may_grow_on`, `replaceable_blocks`, `block_allowlist`, tree lists… | block type for a bare name; name **plus only the states you wrote** otherwise |
| [`ore_feature`'s `replace_rules[].may_replace`](./ore_feature.md#replace-rules) | block type **always** — states you write there are discarded |
| [`scatter_feature`'s `allowed_surface_blocks`](./scatter_feature.md) | the **whole** block: name and *every* state at its concrete value |

The last row is the one that surprises people. A bare `minecraft:oak_log` in `allowed_surface_blocks` is completed to that block's default state before the comparison, so it does **not** match a log that some other feature placed on its side.

## `enforce_placement_rules` and `enforce_survivability_rules` {#enforce-keys}

Both keys are **required** by the schema — a `single_block_feature` file without them does not load. And yet, during world generation, they do nothing: each one gates a "may this block be placed here" / "can this block survive here" check, and during chunk generation both of those checks always pass. Outside chunk generation the same two checks are real, so the fields presumably matter somewhere beyond world generation — but for feature placement in generated chunks, both are inert regardless of their value.

Write them, write either value, and do not spend time on them.

## Field reference

The long-form account of every key, generated from the editor's own catalogue — the same text the Feature Lab node editor shows in its `?` pane and on hover, with the schema facts (required, kind, absent-key default, `format_version` gates) the editor's forms are built from. The [tables above](#fields) are the summary.

<!--@include: ../generated/fields/single_block_feature.md-->

## Your `format_version` decides which of these keys exist {#format-version}

The game keeps a separate schema per `format_version` band, and four parts of this feature's JSON surface arrived in the **1.21.40** band. In a file declaring anything older they are not "ignored" — they are not keys at all, so the game reports each one by name ("this member was found in the input, but is not present in the Schema") and drops the value:

| Key | Available from |
|---|---|
| `places_block` as an **array** of `{block, weight}` | `1.21.40` — below it, `places_block` is a single block descriptor, and an array fails to parse. Since the key is required, the file then does not load at all. |
| `randomize_rotation` | `1.21.40` — below it, the block is always placed unrotated. |
| `may_not_attach_to` | `1.21.40` — below it, there is no deny list. Note this also means the key cannot switch the attach test on, so `auto_rotate` has nothing to orient from unless `may_attach_to` is present too. |
| `may_attach_to.diagonal` / `may_not_attach_to.diagonal` | `1.21.40` — below it, the four horizontal diagonal neighbours are not tested. The other eight face keys exist at every version. |

Everything else on this page — both `enforce_*` keys, `may_replace`, the other eight faces, `min_sides_must_attach` and `auto_rotate` — is in the schema at every `format_version` a feature file can legally declare, and `auto_rotate` behaves identically at every version.

The practical consequence: raising a pack's `format_version` can *add* working keys to files that already contained them, and lowering it silently removes them. If a `single_block_feature` places an unrotated block when you asked for `randomize_rotation`, check the file's `format_version` before anything else.

## What the bench does differently

Rotation is where the bench and the game can still differ, and the gap is narrower than it used to be. For the vanilla block types the bench's own state catalogue knows, it asks the block's **type** whether it can carry a directional state — the same test the game makes — so a bare `"places_block": "minecraft:torch"` is rotated here exactly as it is in the game, `torch_facing_direction` and all, without the state being spelled out. Two things are left:

- **A block the catalogue does not know** — one another add-on defines, or a name the vanilla tables have no entry for — falls back to "whatever states `places_block` actually wrote". A custom block placed by bare name is placed unrotated here where the game may turn it; the same block placed as `{"name": "…", "states": {"pillar_axis": "y"}}` rotates correctly. Spell the state out if you want the preview to be right. The gap only ever *under*-rotates; it never invents a rotation the game does not perform.
- **Naming, for ten of the sixteen families.** The direction the game picks is exact; the word or number that direction is written under is taken from vanilla block definitions rather than from anything the game publishes. `featurelab check` warns when a file leans on one of those ten and says exactly that: the direction is right, the spelling may not be. The families real packs use in practice are not among them.

This is not a rare corner. Real packs commonly write `may_attach_to` — often as a bare `{}` — so the default-true `auto_rotate` is active, and every such block is rotated toward the last freely-matching side.

Two more differences worth knowing when you read a preview of this type:

- **Blocks are coloured, not textured.** `minecraft:pumpkin` has no hand-written entry in the viewer's block-colour table; its colour is averaged from the block's actual textures per face, so it is in the right family rather than deliberately accurate. A block that reaches neither the curated nor the generated table falls through to a deterministic hash-derived colour, which is unrelated to how the block looks. Read every image here as "which cells did this feature touch, and what shape do they form", not as a texture-accurate preview. This is the same viewer the VS Code extension embeds, not a documentation-only rendering path.
- **When you spell states out and the candidate cell was written *without* them**, the cell stands for its block type's default state, and the match test has no per-block registry to complete it with. It reports **no match** rather than guess, which can make such a list look narrower here than in game, and it warns when a list contains a stated entry so the difference is never silent. A bare entry avoids the question entirely. Two committed fixtures pin the common case — `wiki:matchmode_stated_log`, which places a log with `pillar_axis: "x"`, and `wiki:matchmode_bare_may_replace`, whose bare `may_replace` then replaces it — run together by `wiki:matchmode_bare_vs_stated`:

  ```
  featurelab generate --pack <pack> --feature wiki:matchmode_bare_vs_stated --env void --seed 42
  ```

  One cell changes, and it ends up holding `minecraft:gold_block`: the stated log is written first, then the bare `may_replace` matches it and the gold block takes its place. If a bare name did *not* match a log carrying a non-default `pillar_axis`, that cell would hold the log instead and the run would report `may_replace rejected this position: it holds minecraft:oak_log` — which is precisely the shape of the mistake this warning exists to describe.

## Advanced: how the random values are spent {#random-draws}

You do not need this section to use a single block feature. It is for reading a preview value for value against the game, or for reproducing the engine exactly. [RNG and determinism](./rng_and_determinism.md) is the model these numbers fit into; this is this type's row in it.

A call spends **one** random value in the ordinary case and **two** with `randomize_rotation`, and they are not the same kind:

| Step | Cost | Which kind |
|---|---|---|
| The `may_not_attach_to` check (step 1) | 0 | — |
| The `places_block` weighted pick (step 2) | **1**, always | One bounded draw over `[0, total)`, where `total` is the sum of every candidate's weight. It is one draw however many candidates are listed: the weights are summed once, the draw lands somewhere in the total, and the first candidate whose cumulative weight passes that point wins. A single block descriptor — the non-array spelling — still costs it. |
| The `may_attach_to` check and `auto_rotate` (step 3) | 0 | Attachment and its rotation are decided by the neighbours, not by the stream. |
| The `may_replace` check (step 4) | 0 | — |
| `randomize_rotation` (step 5) | **1**, when set | A *raw* 32-bit draw taken modulo 4 — a different draw kind from the weighted pick's bounded one, and taken unconditionally at that point rather than folded into the pick. |

The order matters as much as the count: the weighted pick happens **before** the attach and replace checks, so a call that is going to be refused has already taken its value from the stream by the time it is refused. Adding a `may_attach_to` to a file therefore does not shift what is placed after it in the same chain; changing how many entries `places_block` has does not either, since the count is one regardless. What does shift it is turning `randomize_rotation` on or off, which adds or removes a value per call.

## See also

- [Scatter feature](./scatter_feature.md) — the type that most often delegates to this one, repeatedly, across an area. Its worked example is this page's file, unchanged.
- [Ore feature](./ore_feature.md) — the other Content feature that writes blocks directly, but a whole vein per call instead of one block per delegated call, and with its own, blunter match rule.
- [Feature rules](./feature_rules.md) — how any of this reaches a world: a feature file on its own is inert until a rule attaches it to the chunks of the biomes it belongs in.
- [Snap-to-surface](./snap_to_surface_feature.md), [weighted random](./weighted_random_feature.md) and [aggregate](./aggregate_feature.md) and [sequence](./sequence_feature.md) features — three more Proxy types whose own examples reuse this page's `wiki:pumpkin_patch_block` verbatim as their delegate.
- [Vegetation patch feature](./vegetation_patch_feature.md) — a Scene feature that also reuses it as its `vegetation_feature` delegate, layered under a real ground-patch footprint search instead of a bare offset.
- [Feature delegation and composite features](./feature_delegation.md) — what a delegating feature does and does not hand this one, which is the other half of every chain that ends here.

## How this page was checked

Everything above is a statement about Bedrock **1.26.50.24**, and holds for **1.26.40.26** too: this type's JSON surface — every key, enum value and default — and its behaviour are identical in both.

The attach semantics, the nine faces, the two kinds of check, `min_sides_must_attach`'s default of 4 and the sixteen rotated state families are stated as facts about the game. The worked example was run end to end, and its result — one `minecraft:pumpkin` at `(0, 63, 0)` over grass at `y 62`, carrying `minecraft:cardinal_direction: "west"` — was read back out of `featurelab generate`; the image was rendered from that exact result by the documentation's own [image pipeline](https://github.com/stirante/featurelab/blob/main/docs/wiki/tools/generate-images.mjs), which runs the real engine against [the fixtures](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures) with a fixed seed and a deterministic camera, so re-running it reproduces the picture byte for byte. The `may_replace must be an array` refusal and the bare-versus-stated match result were reproduced the same way.

What is uncertain is named where it is relevant: `min_sides_must_attach` and `auto_rotate` written inside `may_not_attach_to` are accepted and their effect there is **not established**; for ten of the sixteen rotated families the direction is exact but its spelling is inferred; and the rotation gap the bench still has is a statement about the bench, in [what the bench does differently](#what-the-bench-does-differently), not about the game.
