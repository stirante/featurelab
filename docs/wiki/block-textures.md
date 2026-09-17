# Block Textures in the Preview

Every other page in this set describes the Minecraft Bedrock engine. This one, like [Coverage
and Known Gaps](./coverage-and-known-gaps.md), describes the **bench** — featurelab, the tool
these pages' examples and images are generated with — and specifically how it draws what a
feature placed.

By default the preview draws every block as one flat colour. It can instead draw Minecraft's
real block textures, and once it does, a preview stops being a diagram of where blocks went and
starts being a picture of what you built.

![The same tree feature rendered twice side by side: on the left every block is a flat colour, so the canopy is a pale green step pyramid and the trunk is a stack of dull cubes; on the right the same tree is drawn with real Minecraft textures, with cutout oak leaves, bark grain running up the trunk, and vines hanging as thin blades against it](./images/block-textures-flat-vs-textured.png)

Both halves of that picture are the same feature, the same seed and the same camera. The only
difference is the block atlas. It is `wiki:plain_trunk_tree` from this set's own [fixture
pack](./tools/fixtures/) — the same tree the [Tree Features](./tree-feature.md) page illustrates
its bare `trunk` key with.

Look at the trunk in the left half. Those chunky green-and-brown cubes are the vines the feature
rolled onto all four sides of every log; flat-colour mode draws a vine as a full cube, because
flat-colour mode draws *everything* as a full cube. On the right they are the thin blades they
are in game, and the trunk behind them is visible for the first time.

::: warning
The textures are **Mojang's**, not this project's. They are not shipped with the tool and are
never copied into your pack — they are fetched, once, on request, from Mojang's own public
`bedrock-samples` repository, and cached outside both. Nothing is transferred without an explicit
yes. That is the whole reason this is a download and not a bundled folder.
:::

## Turning it on

Textures need a **block atlas** — one image containing every block texture, plus a table saying
which cell each block face reads. Building one needs Mojang's textures on the machine, so the
first time a preview would need them, you get asked once:

| Host | What the ask looks like | If you say no |
|---|---|---|
| **VS Code extension** | A modal dialog on the first preview, carrying the download notice verbatim, with **Download** and **Never**. The build then runs behind a progress notification. | **Never** is remembered. Dismissing the dialog decides nothing and it comes back next preview. |
| **Desktop app** | A native dialog at start-up, **Download** / **Not now**, with progress and any failure in the toolbar's notice line. | Nothing is fetched; the preview draws flat colours. |
| **CLI** | A `[y/N]` question on the terminal from `featurelab textures`. | A typed "no" is remembered. Stdin simply ending is not — nobody saw the question. |

Two things about that ask are worth knowing before you go looking for it:

- **It only happens when a download would happen.** The question is about using your network
  connection. A machine that already has Mojang's assets — cached from an earlier run, or
  `FEATURELAB_VANILLA_PACK` pointing at a `bedrock-samples` checkout you already have — is never
  interrupted, and simply builds the atlas.
- **A "no" is one answer for the whole machine.** It lands in a file beside the atlas, so
  declining in the terminal is also a decline in the editor. Any successful build clears it:
  asking for the thing is a better answer than the last "not now".

## `featurelab textures`

The CLI subcommand behind all of it. With no flags it reports what state the machine is in and
then, if Mojang's assets are already here, just builds the atlas — no question, because there is
no network in that path and so nothing to consent to. It only ever asks when a download is what
would happen next.

```
featurelab textures --status                    # what state this machine is in; changes nothing
featurelab textures --download                  # permit the fetch, then build
featurelab textures --pack <path-to-pack>       # ...including that pack's own blocks
featurelab textures --rebuild                   # build again even if it looks up to date
featurelab textures --decline                   # record a no, so nothing asks again
featurelab textures --status --json             # the machine-readable form the editor reads
```

Three more flags reach the vanilla assets themselves, and are spelled the same in every
subcommand that can touch a resource pack:

| Flag | Environment variable | Effect |
|---|---|---|
| `--vanilla-pack <dir>` | `FEATURELAB_VANILLA_PACK` | Use a `bedrock-samples` `resource_pack` directory you already have. No network access is possible on this path. Wins over everything. |
| `--vanilla-download` | `FEATURELAB_VANILLA_DOWNLOAD` | Permission to fetch. The environment variable is a tri-state: `1` permits, `0` **forbids even when a flag asked**, which is how a machine or a CI image is configured to never reach out. |
| `--vanilla-tag <tag>` | — | A different `bedrock-samples` release than the pinned one. |

`--download` is the short spelling of `--vanilla-download`, for the one subcommand whose whole
subject is the download.

::: warning
There is also a `--yes` flag, and **it is not a safe way to script this**. Its own help text says
it answers the build prompt and "does NOT by itself permit a download"; measured behaviour is the
opposite — `featurelab textures --yes` on a machine with nothing cached prints the notice and
then fetches the whole 150 MB, with or without a terminal. Only `FEATURELAB_VANILLA_DOWNLOAD=0`
reliably stops it. Use `--status` to find out where a machine stands and `--download` when you
actually mean it; treat `--yes` as "download, quietly" until that flag and its help agree.
:::

::: warning
`featurelab textures` with `--json`, or with anything other than a terminal on stdin, **never
prompts**. It prints what it would have asked and exits 0 without downloading. A build script
that cannot have textures is not a failed build script, and a question nobody can see is a hang.
:::

## What is downloaded, and where it goes

| | |
|---|---|
| **What** | Mojang's sample resource pack, from their public `bedrock-samples` repository, as a source archive of one **pinned release tag** — never a branch, so an atlas built on Tuesday and one built on Wednesday cannot differ with nothing having changed. |
| **How much** | About **150 MB transferred**. About **6 MB kept** — 3,845 files: the block textures, the biome colour maps and the resource pack's JSON. Everything else in the archive is dropped on the wire. |
| **Where** | `<your user cache directory>/featurelab/vanilla/<tag>/`. Overridable with `FEATURELAB_VANILLA_CACHE`. Never inside the tool, never inside your pack. |
| **The atlas built from it** | `<your user cache directory>/featurelab/atlas/`, as `atlas.png` plus `atlas.json`. Overridable with `FEATURELAB_ATLAS_DIR`. |

Measured on the pinned tag: **1,207 vanilla textures packed**, covering **1,164 of the vanilla
catalogue's 1,238 blocks with all six faces each** and none partially — the remaining 74 have no
resource-pack binding at all, and are the education-edition blocks and placeholders. The sheet is
630×630 and holds 1,208 cells: 351 KB of PNG and 636 KB of table. A pack's own textures are
packed into the same sheet on top of that, so naming one makes it bigger. Delete either cache
directory and nothing breaks; the next run offers to build it again.

## When it can't

Textures are an **enhancement**. Nothing in the tool stops working without them, and every way of
not having them produces a sentence rather than a silence — a preview that draws flat colours and
says nothing is indistinguishable from a broken feature, and being offline is a normal case, not
an edge one.

| State | What you see | The fix |
|---|---|---|
| Nothing built yet | Flat colours, and the offer. | Accept it, or `featurelab textures --download`. |
| Declined | Flat colours, no further questions. | `featurelab textures --download`, or delete `.featurelab-textures-declined.json` from the atlas directory. |
| Offline, or a proxy that breaks TLS | One ordinary error, said once. Nothing half-written is left behind. | Point `FEATURELAB_VANILLA_PACK` at a checkout. |
| Built from an older pinned tag | A "rebuilding will pick up the newer textures" note. | Rebuild. It needs no network if the assets are cached. |
| An atlas that exists and cannot be read | A "could not be read" note naming the directory. | `featurelab textures --rebuild`. |

In VS Code those land as a warning plus a **Feature Lab** output channel; in the desktop app in
the toolbar notice line; in the CLI on stdout.

## Your own blocks

A behaviour pack's own blocks are drawn from the same sheet as vanilla's, which matters more than
it sounds: in a large add-on, **a big share of the distinct block names features
actually place can be the pack's own**. Untextured, those are the blocks a preview can tell you the
least about.

The tool resolves them the way the game does:

- **`minecraft:material_instances`** gives the per-face (or `"*"`) texture names, plus a
  `render_method`. Those names resolve through **your pack's own** `terrain_texture.json`, not
  vanilla's — though a key you merely reuse from vanilla (`dirt`, a stained glass) resolves for
  free out of the cells already in the sheet.
- **`minecraft:geometry`** decides the shape. `minecraft:geometry.full_block` and
  `minecraft:geometry.cross` are drawn as what they say. Legacy `minecraft:block_shape` is read
  too.
- The **resource pack is found by the manifest UUID link**, not by path: your behaviour pack's
  `dependencies[]` names your resource pack's `header.uuid`. Sibling directories and the
  `com.mojang/development_{behavior,resource}_packs` layout are both searched, with directory
  naming as a fallback and `--resource-pack <dir>` as an override. Finding nothing is not an
  error — those blocks simply stay flat.

::: warning
**A block whose `minecraft:geometry` names a real resource-pack model draws as a textured full
cube**, not as that model. The textures are right; the silhouette is not. This is reported rather
than hidden: the note rides on the block in the atlas table, and a host shows only the notes for
blocks *this preview actually placed* — a pack with 202 blocks and 120 such notes has nothing to
say about a preview that placed neither of them.

Many of those fallbacks name a model called `…full_block`, for which the cube is in fact right.
:::

`featurelab blocktable --pack <dir>` prints the whole resolved table for a pack without building
anything, which is the fastest way to find out why one of your blocks is not drawing the way you
expect.

## What is drawn, and what is approximated

**Six shapes, and everything else is a cube.** The vanilla block names features commonly place
resolve to a full cube, a cross-shaped plant, leaves (a cube, but with cutout alpha and a biome
tint), a carpet or layer, a vine, a torch, or a cactus. **Slabs, stairs, fences, walls, panes,
doors and trapdoors are rarely placed by features**, so those are not
modelled: they draw as full cubes, which is what they did before textures existed and is never
worse than that.

**One block state changes the drawing: `pillar_axis`.** A log lying on its side gets its end
grain on the faces it actually lies on, and its bark turns with it. That one is driven because a
log with its rings on the wrong faces is wrong in a way anyone can see. The rest —
`top_slot_bit`, `weirdo_direction`/`upside_down_bit`, `cardinal_direction` /
`facing_direction` / `minecraft:block_face`, `height`, `growth`/`age` — are not, each because
features rarely place a block carrying it. `vine_direction_bits` is driven for vines; a
vine placed with no bits at all is drawn on all four sides, which is a deliberate choice — a
preview must show that something is there.

**Grass and leaves are tinted, not baked.** Vanilla ships those textures greyscale, to be
multiplied by a biome colour at runtime; drawn untinted they look grey and wrong. Each face
carries a tint channel — `grass`, `foliage`, `water` or `none` — and a multiplier measured from
the pack's own art. A grass block's sides are a *fringe overlay*, not a whole texture (they are
211 transparent pixels out of 256), so the block's own `dirt` face is composited behind them.

Approximations, stated rather than hidden:

- **Tint colours are fixed plains-like values, not biome-driven.** The bench previews one
  feature in one environment and carries no biome colour, so leaves are the same green
  everywhere.
- **No mipmaps, nearest-neighbour filtering both ways.** Minecraft textures are pixel art and
  linear filtering makes them mush; the cost is some shimmer on distant blocks.
- **Translucent blocks use one flat opacity** rather than vanilla's per-block water/ice alpha,
  and they are ordered per mesh rather than per triangle. Occlusion *by* solid geometry is
  correct.
- **A block the atlas has never heard of draws in its flat palette colour**, in the same pass as
  everything else. That is not a failure mode you need to do anything about — it is flat-colour
  mode, for that one block.
- **The carved, heatmap and overflow overlays stay flat-coloured on purpose.** Their whole job is
  to read as *not* ordinary geometry.

## Turning it off

| Host | Switch | Default |
|---|---|---|
| VS Code extension | `featurelab.blockTextures` | on — and setting it to `false` also stops it ever asking anything |
| Desktop app | `FEATURELAB_BLOCK_TEXTURES` | unset means on; `0` turns it off |

Textures come on as soon as an atlas exists, which is what makes this a feature rather than a
setting nobody finds. One thing is deliberately excluded from that, and it is the reason the
default used to be the other way round: **every image committed in this documentation set except
the figure at the top of this page is rendered with textures pinned OFF**, by a pipeline that
asserts it rather than trusting a default (see
[`docs/wiki/tools/generate-images.mjs`](./tools/generate-images.mjs)). A committed screenshot
must not change appearance depending on whether the machine that regenerated it happens to have
built an atlas. This page's figure needs both halves by definition, so it has [its own
script](./tools/generate-texture-figure.mjs) rather than a flag on that one — which keeps the
assertion over there unconditional.

## Pitfalls

- **Editing a block's JSON does not always restale the atlas.** A pack's block definitions are
  fingerprinted by file count, total size and newest modification time — not by content — so an
  edit that preserves all three is missed until the next rebuild. `featurelab textures --pack
  <dir> --rebuild` settles it.
- **A pack must be named for its own blocks to be in the sheet.** `featurelab textures` with no
  `--pack` builds a vanilla-only atlas. The editor and the desktop app pass the pack they have
  open; the CLI does not guess.
- **The pinned tag is not the game version these pages document.** Block textures do not move
  between point releases the way worldgen internals do, so the mismatch costs nothing — but if a
  block's art changed in a release newer than the pin, the preview shows the older art.
- **Textures change how blocks are drawn and never which blocks are placed.** If a preview places
  something different with textures on, that is a bug worth reporting, not a rendering choice.
- **`featurelab textures` exits non-zero when it fails**, unlike every other subcommand, where
  textures are an enhancement and not having them changes nothing. That command's whole job is
  the thing that failed.

## See also

- [Coverage and Known Gaps](./coverage-and-known-gaps.md) — the other page in this set about the
  bench rather than the engine: which claims were checked how, and where the bench knowingly
  differs from the game.
- [Tree Features](./tree-feature.md) — the feature the figure at the top of this page renders.
