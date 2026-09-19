# Feature Lab

A project aiming to reimplement the Minecraft Bedrock world generation feature generation in Go.

## What it's made of

- **The engine** — a Go module (`pack`, `session`, `features`, `env`,
  `biomes`, `random`, `wgen`, `wire`, ...) that loads a pack, builds a bench
  world, and runs a feature or rule in it.
- **`cmd/featurelab`** — the headless CLI/protocol binary: `generate` (run
  one feature/rule, print JSON), `serve` (newline-delimited JSON
  request/response loop over stdin/stdout), `check` (load a pack, print
  diagnostics, non-zero exit on error), `types` (print the feature-type
  coverage table), `textures` (get this machine to a state where the preview
  can draw real block textures — see below) and `blocktable` (print how a
  pack's own blocks resolve to textures and shapes).
- **`apps/vscode`** — a VS Code extension: preview a feature/rule next to
  its JSON, live-reloading on save. See
  [`apps/vscode/README.md`](apps/vscode/README.md) for the panel, the
  diagnostics and the settings.
- **`apps/desktop`** — a Wails desktop app wrapping the same viewer in a
  standalone window, watching a pack directory on disk. See
  [`apps/desktop/README.md`](apps/desktop/README.md) for how it differs from
  the extension and what the Wails build needs.
- **`frontend`** — the three.js voxel viewer and its control panel, shared
  by the extension and the desktop app. It only ever consumes the JSON
  `generate`/`serve` emit — it never reaches into the engine's internals, and
  the wire format is the whole contract between them.

## Building and running

Requirements: Go 1.26.4+ and Node 22. Go dependencies, including
[`molang-go`](#molang-go), are fetched normally.

### CLI

```
go build ./cmd/featurelab
./featurelab generate --pack <path-to-pack> --feature <id> --env plains
```

`<path-to-pack>` is a behaviour pack root containing `features/`,
`structures/`, `feature_rules/` and `biomes/` (each independently
overridable with `--features`/`--structures`/`--rules`/`--biomes`). Run against
the fixture pack committed in this repo, so the output below is reproducible:

```
$ go run ./cmd/featurelab generate --pack docs/wiki/tools/fixtures       --feature wiki:cave_demo --env underground_stone --seed 1 --origin 0,32,0
{
  "bounds": { "minX": -16, "minY": 8, "minZ": -16, "sizeX": 32, "sizeY": 48, "sizeZ": 32 },
  "featureSeed": 1,
  "environmentSeed": 12345,
  "blocks": { "rle": [ 5, 409, 19, 1, 5, 30, 19, 3, ... ] },
  ...
}
```

The per-cell arrays (`blocks`, `baseline`, `changed`, `removed`, and
`profile.touchCounts`) are run-length encoded as value/run-length pairs: a
bench volume is mostly untouched environment, so the dense form spends
megabytes of JSON on repeated values. Re-run the command above at
`--size 96x384x96` and `blocks` alone is 3,538,944 cells: 7.08 MB as a dense
array, **44.9 KB** encoded, in 9,145 runs. A denser pack encodes less well —
the ratio is a property of the volume, not a constant — but the order holds. `wire`'s package doc comment carries the
full field-by-field spec.

`check` loads a pack, prints every diagnostic as a table and a summary line,
and exits non-zero if any of them is an error — including a delegation whose
`places_feature` names something the pack does not define, which is invisible
in any single file:

```
$ go run ./cmd/featurelab check --pack <path-to-pack>
LEVEL    FILE                       MESSAGE
error    features/scatter.json      wiki:scatter: $.minecraft:scatter_feature.places_feature: delegates to "wiki:gold_blok", which no loaded file defines. ... -- did you mean "wiki:gold_block"?

1 error, 0 warnings, 4 notes
```

Add `--json` for the machine-readable array (the levels are `error`,
`warning` and `info`; a conventional directory the pack simply does not have
is `info`, not a warning):

```
go run ./cmd/featurelab check --pack <path-to-pack> --json
```

`serve` speaks one JSON object per line on stdin, one back on stdout — the
protocol the VS Code extension and `check` both drive:

```
$ echo '{"method":"loadPack","params":{"dir":"docs/wiki/tools/fixtures"}}' | go run ./cmd/featurelab serve
{"id":null,"result":{"warnings":[...],"featureCount":55,"structureCount":1,"ruleCount":2,"biomeCount":0,"fileCounts":{"features":55,...},"diagnostics":[...]}}
```

The counts are what the pack can **use**; `fileCounts` is what was read off
disk. A pack with one unparseable feature file answers `"featureCount":55`
beside `"fileCounts":{"features":56}` and a `diagnostics` entry naming that
file — with `line`/`column` when the parser knew them — rather than counting
the broken file as a feature and saying nothing. Each diagnostic carries a
`scope`: `"pack"` for something wrong with the files on disk (identical for
every run), `"run"` for what happened in the `generate` being answered. A
`generate` response carries both; `loadPack` and `check` only ever carry
`"pack"`.

A long call — `generate`, `generateGrown`, `graph` — can be stopped part-way by
sending `{"method":"cancel","params":{"id":<that request's id>}}` on the same
stream. The cancelled request answers with an error carrying
`"code":"cancelled"` rather than a half-finished result, and cancelling an id
that has already finished (or never existed) is a no-op that answers
`{"cancelled":false}`.

### Block textures

The preview draws every block as a flat colour until it has a block atlas, and
building one needs Mojang's own textures, which this repository does not ship:
they are Mojang's, published in their `bedrock-samples` repository under that
repository's licence.

**[`docs/wiki/block-textures.md`](docs/wiki/block-textures.md) is the whole
story** — a side-by-side of the same tree flat and textured, the first-run flow
on all three hosts, and what is drawn accurately versus approximated. What
follows here is the short version.

The editor extension and the desktop app both offer to fetch them **once**, on
the first preview, naming what is being downloaded and from where; declining is
remembered and nothing asks again. From a terminal the same flow is:

```
go run ./cmd/featurelab textures --status              # what state this machine is in
go run ./cmd/featurelab textures --download            # fetch, then build (asks first)
go run ./cmd/featurelab textures --pack <path-to-pack> # ...including that pack's own blocks
go run ./cmd/featurelab textures --decline             # never offer again on this machine
```

Nothing is transferred without an explicit yes. About 150 MB is transferred and
about 6 MB kept, in a per-user cache directory (`os.UserCacheDir()/featurelab`),
never inside this repository and never inside a pack. Already have a
`bedrock-samples` checkout, or no usable network? Point `FEATURELAB_VANILLA_PACK`
at its `resource_pack` directory and nothing is ever fetched.

**A pack's own blocks are drawn too**, from the same sheet — resolved through
that pack's own resource pack, found by the manifest `dependencies[]` UUID link
rather than by path. That is worth more than it sounds: in a large add-on a big
share of the distinct block names its features place can be the pack's own, and
untextured those are the blocks a preview tells you the least about.
`featurelab blocktable --pack <dir>` prints the resolved table without building
anything.

That resolution follows `terrain_texture.json` into a `.texture_set.json` when a
path names one, and it reads a block's `permutations` as well as its top-level
components — so a block whose art depends on a block state is drawn per state
rather than always in its default faces. One entry it cannot read costs that
entry only, and a `variations` list resolves to its first entry (the game rolls
a weighted die per block; a preview that did the same would change on every
reload). The wiki page above has the whole of it.

Textures are an enhancement: offline, declined, or switched off — either by the
setting that prepares them (`featurelab.blockTextures` in VS Code,
`FEATURELAB_BLOCK_TEXTURES=0` for the desktop app) or by the preview sidebar's
own **Block textures** switch, which decides whether an atlas that exists is
drawn — the preview draws the flat colours it has always drawn and says why. Every committed image that contains blocks — `docs/wiki/images/` and
`apps/vscode/docs/panel-*.png` — is rendered with textures pinned OFF, and both
pipelines assert it rather than trusting a default, so what they look like never
depends on whether the machine that regenerated them happens to have an atlas.
(`apps/vscode/docs/graph-*.png` are of the node editor, which draws no blocks.)
The single exception is the before/after figure on the wiki page above, which
needs both halves by definition and has its own script
(`docs/wiki/tools/generate-texture-figure.mjs`).

### VS Code extension

```
npm ci
npm run --workspace frontend build          # shared viewer, a workspace dependency of the extension
npm run --workspace apps/vscode typecheck
npm run --workspace apps/vscode compile     # esbuild -> apps/vscode/dist/{extension,webview}.js
npm run --workspace apps/vscode test        # vitest
npm run --workspace apps/vscode package     # builds cmd/featurelab for the host, packages featurelab.vsix
```

`package` builds the engine binary into `apps/vscode/bin/` and bundles it
into the VSIX — the extension never requires the engine to be on `PATH`.
Set `featurelab.binaryPath` in VS Code settings to point at a locally built
`cmd/featurelab` binary during development instead.

The listing's own material is regenerated, not hand-maintained:

```
node scripts/capture-screenshots.mjs        # apps/vscode/docs/panel-*.png
node scripts/capture-graph-screenshots.mjs  # apps/vscode/docs/graph-*.png (needs `compile` first)
node scripts/make-icon.mjs --check          # apps/vscode/media/icon.png, plus a 32px legibility copy
```

All three take `--out <dir>` so a change can be looked at without overwriting
what is committed. The graph capture asserts, per shot, that the overlay
surfaces the filename claims are open and that every other one is closed —
without that, an overlay left up by an earlier step is photographed under the
next shot's name and nothing fails. `apps/vscode/CHANGELOG.md` is the
user-facing history.

### Desktop app

```
npm run --workspace frontend build
cd apps/desktop
wails build -platform windows/amd64   # or darwin/universal, linux/amd64
```

Produces `apps/desktop/build/bin/featurelab-desktop.exe` (or platform
equivalent). The desktop app drives the engine's `session`/`pack`/`env`
packages directly in-process — no `featurelab` subprocess. It watches the
loaded pack directory and regenerates on save, the same "don't lose the
camera" contract the extension implements independently.

Wails CLI must be pinned to **v2.13.0** — 2.8.2 fails to build against Go
1.26.4. On Linux, Wails' cgo WebKitGTK backend needs `-tags webkit2_41`
against `libwebkit2gtk-4.1-dev` (Ubuntu 24.04 dropped the 4.0 package Wails
defaults to); see `.github/workflows/ci.yml`/`release.yml` and
`scripts/release/build-desktop.sh` for the exact invocation.

### Shared viewer only

```
npm run --workspace frontend typecheck
npm run --workspace frontend build
npm run --workspace frontend test
```

### molang-go

The Molang implementation this project runs on lives in its own repository,
[github.com/stirante/molang-go](https://github.com/stirante/molang-go), and
is an ordinary module dependency — `go.mod` pins a version and `go build`
fetches it. Nothing has to be cloned beside this repo.

It used to be a sibling checkout wired up with `replace molang-go =>
../molang-go`, which is why the CI jobs still nest their checkout under
`featurelab/`.

To develop against a local checkout of it, add a `replace` yourself and keep
it out of commits:

```
go mod edit -replace github.com/stirante/molang-go=../molang-go
go mod edit -dropreplace github.com/stirante/molang-go     # undo
```

### Tests

```
go test ./...
```

A handful of suites (`goldentest`, `apps/desktop/identifier_test.go`, and
any local tests you add) need a behaviour pack supplied through
`FEATURELAB_PACK_DIR`, which is not included in this repository; they call
`tb.Skipf` when it's absent. CI hits this on every run — a CI script
scans the `go test -v` log for that skip convention and posts a warning to
the job summary so a green CI check is never mistaken for having run the
external-pack suites. `TestFixtureDigest` -- the public placement baseline --
does run there; see "The golden baseline" below for what it covers and what
it does not.

## What you get

- **Environments** — `void`, `underground_stone`, `underground_deepslate`,
  `underground_mixed` (the y=0 stone/deepslate transition), `plains`,
  `forest`, `desert`, `ocean`, `nether` and `end` (a floating island). Each
  is deterministic from its seed. The preset picks the *landform*; the
  blocks it's built from come from a material slot set (`top_material`,
  `mid_material`, `foundation_material`, the sea materials) which a loaded
  pack biome fills in, and which `generate --top-material`/etc. (or the
  panel, in the extension/desktop app) can then override by hand.
- **Features and rules** — preview a single feature at one origin, or a
  whole `minecraft:feature_rules` entry running its real distribution across
  every chunk the bench covers, once per chunk from that chunk's own corner,
  the way the game applies it. Terraform-style features only make sense the
  second way: they build one column and rely on the rule to invoke them 256
  times. A rule's `biome_filter` is enforced, so a rule that would not apply
  says so rather than placing nothing — as do the quieter ways a rule can be
  inert (an unknown `placement_pass`, a missing `distribution`).
- **The game's own seeding, in rule mode** — each chunk decorates from the
  seed the engine would derive for it from the world seed and the chunk
  coordinates, each rule from its own seed derived from that plus its
  identifier, and the positions and the placed feature's own draws come from
  two independent streams, as they do in game. Renaming a rule moves what it
  places, here and there alike. `docs/wiki/rng-and-determinism.md` is the
  whole chain.
- **Inspection** — orbit, and a max-Y slider that peels the world away from
  the top so you can look straight down into a structure. Blocks the
  feature wrote are drawn solid; the environment can be shown solid,
  ghosted or hidden. Cells the feature *removed* are drawn as a translucent
  carved volume — without that, an excavating feature looks like it did
  nothing.
- **Honest reporting** — the result's block count is split into
  `blocksPlaced` (baseline air → non-air), `blocksCarved` (baseline non-air
  → air) and `blocksReplaced` (non-air → different non-air), because those
  three read very differently and one of them is invisible. Placement
  refusals surface as diagnostics (`level: "error"|"warning"`, a file/chain
  identifier, a message) instead of leaving you with a blank preview and no
  explanation.
- **Grow-and-regenerate** (`generate --grow`) — if a run captures writes
  outside the bench volume, expand the bench to contain them and place
  *again* at the larger size: a genuinely different run (different reads,
  possibly different RNG outcomes), not a wider view of the first. See
  `wire`'s package doc comment for the full contract.

## Accuracy

The point of this tool is to match the real game's placement behaviour
exactly, not approximately.

- **Target version**: Bedrock **1.26.50.24**. This tool targets
  that version and only that version — worldgen behaviour moves between
  releases, so a statement here is a statement about 1.26.50.24, not about
  Bedrock in general. The previous target was 1.26.40.26, which had 26
  feature types against this one's 29; an algorithm can change behind an
  unchanged set of JSON keys, so a version bump is checked for behaviour
  changes, not only for schema changes.
- **Gaps are left as gaps.** Behaviour that is not known exactly is not
  guessed at in code.
- **Anything not known exactly fails loudly**, as a diagnostic, rather than being
  quietly approximated. The RNG (MT19937) and `query.noise` are both
  byte-exact; a regression in either fails a unit test at build time. There
  is deliberately no runtime self-check for them — a generator that has
  drifted cannot be trusted to notice, and a warning nobody reads is worse
  than a build that does not ship.

### Current known-inexact areas

- **`math.cos`/`math.sin`/`math.pow`.** The game evaluates these in single
  precision with the platform's own maths library (`cosf`/`sinf`/`powf`),
  whose exact implementation is not available here, so `molang-go`'s
  `eval/mathf32.go` rounds the argument to float32 (including the
  float32 degree→radian constant), computes in float64, and rounds back
  to float32 — the standard "double-then-round" construction. That
  construction is provably bit-exact for `+`/`-`/`*`/`/`, but there is no
  equivalent guarantee for a transcendental function: a platform's
  `cosf`/`sinf`/`powf` may disagree by a handful of ULP on some inputs. Very
  close, not proven bit-exact.
- **`minecraft:ore_feature`'s vein geometry.** Computed here in 64-bit
  floating point where the game is believed to use 32-bit. The randomness
  is unaffected -- same draws, same order -- so nothing placed after a vein
  moves; only the vein's own boundary can differ, and only in about
  0.05-0.35% of seeds at large counts far from the origin, never at small
  ones near it. Left alone deliberately: 32-bit arithmetic there is not
  certain, and changing the arithmetic on an uncertain premise trades a
  measured small error for an unmeasured one. The type is still marked
  `implemented`, because this is a precision gap rather than a missing
  behaviour -- `features/coverage.go`'s entry states it in full.
- **Whatever `features/coverage.go` marks `partial`.** Which types those are,
  and exactly what is approximated or refused in each, changes as work lands,
  so this README deliberately does not name them: run `featurelab types` or
  read `features/coverage.go` for the live, authoritative answer. Every entry
  there says in plain terms what the gap means for a pack, and the file is
  asserted against the feature registry by `features/coverage_test.go`, so it
  can't drift out of sync with what's actually implemented — which a list
  copied into prose here always eventually would.
- **Environment presets' landform is deliberately not accurate**, and never
  intended to be. A preset's terrain, ore blobs and filler scenery use a
  separate RNG (`env.EnvRandom`) from the one features run on, precisely so
  the two can't be confused. Only a preset's *materials* can be made
  faithful, by loading a pack biome; the landform itself cannot. That
  matters for terraform features, which read the existing surface: they'll
  behave sensibly here but won't reproduce the terrain the real world
  generator would have handed them.
- **Whatever `features/coverage.go` marks `missing` or `out_of_scope`** —
  a type the game accepts, not implemented in this repo, either because it
  hasn't been ported yet (`missing`) or because it's deliberately not
  going to be (`out_of_scope`, see below). Loading a pack that uses one says
  so specifically, rather than leaving you unsure whether you mistyped the
  id.

### Feature type coverage

The game accepts 29 JSON feature types; this tool implements some of
them. `features/coverage.go` is the single source of truth for exactly
which — status (`implemented`/`partial`/`missing`/`out_of_scope`), and
for every gap, what the gap is — and
`features/coverage_test.go` holds it against the live builder registry in
both directions, so a type can't be implemented without the table saying
so, or claimed without a builder behind it.

`out_of_scope` is a policy, not a per-type judgment call: a type gets it
when Microsoft's own public feature-type reference classifies it under
"Internal/Deprecated Components" AND this tool doesn't already implement
it. That second condition matters — several names in that same reference
group are types this tool genuinely implements, and real packs
use them, so the label alone was never a reason to remove working
code. `out_of_scope` only ever moves a type OUT of future-work priority
(from `missing`); it never demotes something already `implemented` or
`partial`. See `features/coverage.go`'s `StatusOutOfScope` doc comment for
the exact rule and which types it currently applies to — deliberately not
repeated here as a name list, which would just go stale the next time the
policy is applied.

```
featurelab types           # text table
featurelab types --json    # the same data as JSON
```

Don't trust a count written in prose anywhere else (including older
versions of this paragraph) over that command's live output — coverage
changes as types get ported, and stale numbers are worse than no numbers.

### The golden baseline

`goldentest/` pins the write/draw outcome of every placement chain a pack
exercises, where a "chain" is in scope only if its ENTIRE delegation chain
is one of the seventeen feature types the suite covers. There are two
baselines, and they are regenerated separately and deliberately:

```
go run ./goldentest/cmd/goldengen -pack external   # TestGoldenDigest
go run ./goldentest/cmd/goldengen -pack fixture    # TestFixtureDigest
```

The **external** one runs over a behaviour pack supplied through
`FEATURELAB_PACK_DIR`, which is not included in this repository. It cannot
run without that pack, so it skips on CI and wherever the variable is unset.

The **fixture** one runs over `docs/wiki/tools/fixtures`, which is
committed here, so it runs everywhere including CI. It is much smaller --
tens of chains, not thousands -- and it says so out loud on every run,
printing how many chains it compared and which of the seventeen types each
one reached. Do not read it as the big one. The one thing it does better:
it pins `conditional_list`, `scan_surface`, `surface_relative_threshold`
and the three carvers, which the external baseline is not guaranteed to exercise.

This is a **regression baseline generated from this engine itself** — it
has never been checked against Minecraft, only against this Go engine's own
prior output. A green `TestGoldenDigest` proves a change didn't alter
placement behaviour for any in-scope chain relative to the last deliberate
re-pin; it does not, and has never, proven that this engine matches real
Bedrock world generation. Known-wrong-vs-the-real-engine behaviour can be
(and has been) pinned as "correct" by this baseline until someone
deliberately re-pins it — see `goldentest/golden_test.go`'s package doc
comment for a concrete instance (the digest briefly stayed pinned to
float64 Molang behaviour after `molang-go` itself moved to float32,
specifically so the re-pin could be a reviewable, explained diff rather
than a silent side effect of an unrelated fix). All of that applies to
both baselines equally.

Regenerating the baseline is a deliberate act, never a side effect of
running tests: capture the before/after summary, diff the digest JSON, and
be able to name exactly which chains changed and why before committing a
re-pin.

## Repo layout

```
cmd/featurelab/     CLI: generate, serve, check, types, textures, blocktable
pack/               loads a behaviour pack's features/structures/rules/biomes
session/            build a bench world -> run a feature or rule -> diff -> result
features/           per-type JSON builders and place() ports; coverage.go is the coverage table
env/                environment presets, material slots
biomes/             pack biome definitions -> material slots and tags
random/             the feature RNG -- MT19937
wgen/               core placement contracts (BlockPos, world access, features) and the
                    molang-go bridge wiring query.heightmap/above_top_solid/noise/biome tags
wire/               the generate/serve JSON wire contract, shared by every caller
block/, volume/, structures/, nbt/, rules/, profiler/
                    block palette/tags, the finite world volume + diff, .mcstructure
                    loading, NBT, minecraft:feature_rules, placement profiling
noise/, jsonc/, rle/
                    the noise functions Molang's query.noise resolves to, a JSON-with-comments
                    reader (pack JSON carries them), and the run-length codec every per-cell
                    array on the wire goes through
internal/, bin/     internals with no external callers, and built binaries (bin/ is ignored)
goldentest/         the regression baseline and its digest + generator
docs/wiki/          a documentation set on Bedrock's own worldgen feature system: one page per
                    feature type, plus guides on RNG/determinism, delegation, feature rules and
                    what this tool can and cannot verify. Its examples are generated from the
                    committed fixture pack under docs/wiki/tools/fixtures/ and its images from
                    the real viewer -- see docs/wiki/index.md
apps/vscode/        VS Code extension
apps/desktop/       Wails v2 desktop app
frontend/           shared three.js voxel viewer + control panel, consumed by both apps
scripts/release/    cross-platform build scripts CI's release workflow drives
.github/workflows/  ci.yml (build/vet/test all four surfaces), release.yml (tagged builds)
```

## Conventions

- Anything under `features/` that ports game code keeps the original
  control flow and the **order of RNG calls**, even where a tidier
  formulation exists — call order is the whole ballgame for
  reproducibility, and it's exactly what the golden baseline checks.
- Anything not known exactly is marked as such
  rather than guessed at in code — see "Current known-inexact areas" above
  for what that looks like in practice.
