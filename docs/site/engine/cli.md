---
title: The featurelab command
description: The engine's headless CLI — generate, check, serve, types, textures and blocktable — what each one answers, the levels check reports and what only it can see, and the newline-delimited JSON protocol serve speaks.
scope: bench
---

# The `featurelab` command

<VersionBadge />

**One binary, and every host on this site is a front end for it.** The [VS Code extension](../editor/extension.md) ships a copy inside the VSIX and drives it over a pipe; the [desktop app](../editor/desktop.md) links the same Go packages in-process and never spawns anything. You reach for the command yourself when you want a pack checked in CI, a result you can diff, or a host of your own.

**This page is about the tool, not the game.** What to put in a feature file, and what each key does when the game reads it, is on the [feature type pages](../features/index.md) — one page per type id. Nothing here repeats them.

## What each command answers {#what-each-command-answers}

| Command | The question it answers | Output |
|---|---|---|
| `generate` | What does this one feature or rule place, here, at this seed? | one JSON object |
| `check` | Does this pack load, and does every delegation in it resolve? | a table and a summary line; `--json` for the array |
| `serve` | *(for a host)* — a long-lived session that loads the pack once and answers many requests | one JSON object per line |
| `types` | Which feature types does the bench implement, and what is each gap? | a table; `--json` for the same data |
| `textures` | Can the preview draw real block textures on this machine, and may it fetch them? | prose; `--json` for the editor |
| `blocktable` | How do *this pack's own* blocks resolve to textures and shapes? | JSON |

Two more exist and are not on this page: `graph`, which prints the same node-and-connection graph the editor's canvas draws, and `version`, the one-line start-up check a host runs before its first request. `featurelab <subcommand> -h` prints that subcommand's flags.

Every command that reads a pack takes `--pack <dir>`, a behaviour pack root holding `features/`, `structures/`, `feature_rules/` and `biomes/`. `generate` and `check` can override any of those four subdirectories independently with `--features` / `--structures` / `--rules` / `--biomes`. Every example below runs against the fixture pack committed in this repository, [`docs/wiki/tools/fixtures`](https://github.com/stirante/featurelab/tree/main/docs/wiki/tools/fixtures), which is also where the examples on the type pages come from.

## `generate` — run one feature {#generate}

```
featurelab generate --pack docs/wiki/tools/fixtures \
  --feature wiki:cave_demo --env underground_stone --seed 1 --origin 0,32,0
```

What comes back is one JSON object on stdout: the volume's `bounds`, the seeds actually used, the block `palette`, the cells as they ended up (`blocks`) and as they started (`baseline`), which ones `changed` and were `removed`, the split counts `blocksPlaced` / `blocksCarved` / `blocksReplaced`, every `placements` entry, and `diagnostics`. That object is the whole contract between the engine and every viewer — `wire`'s package documentation is the field-by-field spec.

Three things about it are worth knowing before you parse it:

- **The per-cell arrays are run-length encoded** as value / run-length pairs, because a bench volume is mostly untouched environment. The same run at `--size 96x384x96` covers 3,538,944 cells: 7.08 MB as a dense array, **44.9 KB** encoded, in 9,145 runs. A denser pack encodes less well — the ratio is a property of the volume, not a constant.
- **The three block counts are not one number.** `blocksPlaced` is air → non-air, `blocksCarved` is non-air → air, `blocksReplaced` is one non-air block for another. A carving feature reports `blocksPlaced: 0` and has done a great deal; the run above carves 3,229 cells and places none.
- **An `error` diagnostic makes the process exit non-zero**, the same gate `check` uses. `--feature` naming something the pack does not define is an error diagnostic, so a script cannot mistake a typo'd id for a feature that placed nothing.

`--env` picks the landform, `--seed` the feature seed, `--origin` and `--size` the volume, `--repeat` how many times to place. `--grow` re-runs at a larger size when writes landed outside the volume — a genuinely different run, not a wider view of the first. The surrounding model — where a seed comes from and why renaming something moves it — is [RNG and determinism](../features/rng_and_determinism.md).

## `check` — does the pack load {#check}

`check` loads a pack, prints every finding, and exits non-zero if any of them is an error. It never runs a placement, so it has nothing to say about a lost roll or a surface that was not there.

```
$ featurelab check --pack docs/wiki/tools/fixtures
LEVEL    FILE                                     MESSAGE
info     (pack)                                   biomes directory "…\fixtures\biomes" does not exist -- 0 biomes files loaded (fine if this pack has none)
info     (pack)                                   blocks directory "…\fixtures\blocks" does not exist -- 0 pack-specific block files loaded (…)
warning  features/single_block_pumpkin.json       "minecraft:jack_o_lantern" is not a block this engine knows: …
warning  features/tree_acacia_branching.json      may_grow_through is set, but this trunk kind does not consult it in this tool …
warning  features/tree_fancy_oak.json             may_grow_through is set, but this trunk kind does not consult it in this tool …

0 errors, 3 warnings, 2 notes
```

The table and the summary are the **default**; `--json` prints the same findings as an array, for a program. The exit code does not depend on the format. A row's FILE column carries `file:line:col` when the parser knew them, which is the form every editor and every terminal already knows how to jump to.

The three levels, and what earns each:

| Level | Summary word | What it means | Exit code |
|---|---|---|---|
| `error` | errors | The pack is wrong in a way that places nothing. A `places_feature` naming something no loaded file defines is the one you meet most, and it is reported with a near-match suggestion. | non-zero |
| `warning` | warnings | Something real that still loads and still runs — a block name the engine does not know, a field this tool does not consult. | 0 |
| `info` | notes | True, worth seeing, not a defect. A **conventional directory the pack simply does not have** is this, not a warning: a channel that is noisy on every pack ever opened is one people stop reading. A directory an explicit `--features`/`--biomes` override *named* and that is not there stays a warning, because that is a typo'd path. | 0 |

**Two findings only `check` can make**, because they are about how two files relate rather than about either one of them:

- **A dangling delegation is an `error`.** `places_feature: "wiki:gold_blok"` is valid JSON in a valid file; nothing is wrong with the file you are looking at. It becomes visible only when the whole pack is in front of you.
- **A delegation cycle is a `warning`.** `a → b → a` loads and generates — the recursion guard stops the loop at run time — but the guard works by *dropping* the re-entry, so one of those delegations places nothing at every origin and under every seed, and says nothing when it does. See [delegation and composite features](../features/feature_delegation.md#the-recursion-guard).

**A pack root that does not exist is a failure, not a clean pack.** `check --pack <a path that is not there>` prints `featurelab: pack: pack root "…" does not exist` on stderr and exits 1, with no table and no empty JSON array. A typo in a CI script therefore fails the job instead of reporting that a pack nobody loaded is fine.

::: warning Wiring `check` into a build can fail a pack nobody has touched
A pack with an unresolved delegation used to pass and now fails, so a job that gates on the exit code can start failing on a pack that has not changed. The finding is real in every such case — the branch places nothing in game either — but it is a new failure, not a new breakage.
:::

## `serve` — the protocol a host drives {#serve}

`serve` speaks **newline-delimited JSON**: one JSON object per line on stdin, one back on stdout. A pack is loaded once with `loadPack` and every later `generate` reuses it; `reloadFile` re-reads one file and nothing else, which is what makes the edit-save-look loop cost one file instead of a pack.

```
$ echo '{"id":1,"method":"loadPack","params":{"dir":"docs/wiki/tools/fixtures"}}' | featurelab serve
{"notification":"ready","ready":true,"version":"…","pid":…}
{"id":1,"result":{"warnings":[…],"featureCount":…,"structureCount":2,"ruleCount":2,"biomeCount":0,"fileCounts":{…},"diagnostics":[…]}}
```

### A line without an `id` member is not a response {#the-line-contract}

That is the whole contract, and it is what makes everything below safe to add.

- A **response** has an `id` member — the request's id, echoed verbatim, possibly `null` — and exactly one of `result` or `error`.
- A **notification** has a `notification` member naming its kind, and never an `id`, a `result` or an `error`.

So a client that correlates by id can never match a notification to an outstanding request. A progress line names its request in `requestId`, deliberately *not* in `id`: the obvious spelling is exactly the one that would resolve a caller's pending promise and hand it a response with neither a result nor an error. A client that cannot tolerate extra lines at all runs `serve --quiet`, which emits none of them.

Two kinds exist today, and a client must ignore a kind it does not know rather than treat it as an error — that is what makes a third one a non-breaking change.

| Notification | When | Carries |
|---|---|---|
| `ready` | once, at start-up, before anything is asked | `ready`, `version`, `pid` |
| `progress` | on the two methods that can run for a minute — `loadPack` and `graph` — once the request passes 750 ms, then once a second | `requestId`, `method`, `phase`, `files`, `elapsedMs` |

```json
{"notification":"progress","requestId":1,"method":"loadPack","phase":"features","files":3165,"elapsedMs":758}
```


The readiness line exists because a host that spawned the process had no way to tell *still starting* from *hung* except by sending a request and waiting out a timeout — and the first request a host sends is usually `loadPack`, the slowest thing the engine does. The progress lines exist because the engine is not always the reason a request is slow: a freshly written pack of 12,500 files measured 102 s on first touch against 2.3 s warm, the difference being the machine's own on-access virus scanning reading every file once. `elapsedMs` is always present on a progress line, because it is the field that says *alive* even when nothing else changed.

The extension's [`featurelab.requestTimeoutMs`](../editor/extension.md#settings) is built on exactly this: it is an **idle** deadline, re-armed by every progress line, not a cap on how long a request may take.

### `cancel` {#cancel}

A long call — `generate`, `generateGrown`, `graph` — can be stopped part-way:

```json
{"method":"cancel","params":{"id":7}}
```

It is answered immediately and out of turn with `{"cancelled":true|false}`, `true` meaning the signal reached a request that was still running. The **cancelled** request then answers, whenever it actually unwinds, with `{"error":{"message":"request cancelled","code":"cancelled"}}` and never with a half-finished result. Cancelling an id that has already finished, or one that never existed, is a harmless `{"cancelled":false}` — a client that raced a response cannot know that before it sends, so it is not an error and never becomes one.

The methods that build the workspace (`loadPack`, `reloadFile`) and the ones that write files are deliberately *not* interruptible: stopping either half way leaves a partially rebuilt library or a rename applied to some of a pack's files, which is a worse answer to "I changed my mind" than waiting.

### What the counts mean {#load-pack-counts}

`loadPack`'s `featureCount` and its friends are what the pack can **use**; `fileCounts` is what was read off disk. Add one unparseable file to a pack of 124 features and it answers `"featureCount": 124` beside `"fileCounts": {"features": 125}`, with an `error` diagnostic naming that file — `features/oops.json`, line 2, column 1 — rather than counting a broken file as a feature and saying nothing.

Each diagnostic carries a `scope`: `"pack"` for something wrong with the files on disk, identical for every run, and `"run"` for what happened in the `generate` being answered. A `generate` response carries both; `loadPack` only ever carries `"pack"`.

## `types`, `textures` and `blocktable` {#the-other-three}

**`types`** prints the coverage table — every registered feature type, its status, and in plain terms what each gap means for a pack. It is the live, authoritative answer, and nothing on this site types those counts by hand: [coverage and known gaps](./coverage.md) reads `featurelab types --json` at build time. Do not trust a count written in prose anywhere — including here — over that command's output.

**`textures`** is the machine's side of the block atlas. `--status` reports what state this machine is in and changes nothing; with no flags it builds straight away if Mojang's sample resource pack is already present and otherwise asks once before fetching it. `--vanilla-pack` (or `FEATURELAB_VANILLA_PACK`) points at a `bedrock-samples` checkout you already have, so nothing is ever fetched; `--decline` records that this machine does not want the download and nothing asks again. Nothing is transferred without an explicit yes. [Block textures in the preview](./block_textures.md) is the whole story.

**`blocktable`** prints how a pack's own blocks resolve to textures and shapes without building anything — the table behind "why is my block a flat colour". It says out loud when it could not find the pack's resource pack, and by what route it looked.

## See also

- [Coverage and known gaps](./coverage.md) — what `types` reports, with the prose on what each gap means; and the bench-wide approximations that apply to every `generate` run.
- [Block textures in the preview](./block_textures.md) — what `textures` and `blocktable` are for, on all three hosts.
- [The VS Code extension](../editor/extension.md) — the host that drives `serve`, and the settings built on this page's protocol.
- [The desktop app](../editor/desktop.md) — the host that drives none of it, and what that costs.
- [When the preview shows nothing](../editor/preview_shows_nothing.md) — reading a run that wrote no cells, whichever host produced it.
- [Feature types](../features/index.md) — what goes in the files all of the above read.

## How this page was checked

Every command on this page was run against the committed fixture pack, and every number and transcript came out of that run: `check`'s table and its `0 errors, 3 warnings, 2 notes` summary, the exit code for a pack root that does not exist, the `generate` run's 3,229 carved cells, and the encoded and dense sizes and 9,145 runs at `96x384x96` (7.08 MB and 44.9 KB are decimal megabytes and kilobytes). Message texts are abridged with `…` where a row would not fit, and nothing is reworded.

Three things came from somewhere else, on purpose, and each says where:

- The `error` and `warning` levels for a **dangling delegation** and a **delegation cycle** were reproduced on a two-file scratch pack, because the fixture pack deliberately contains neither.
- The **`progress`** line is a verbatim capture from a scratch pack of several thousand feature files: the fixture pack loads in well under the 750 ms delay, so it never emits one. The `ready` line is from the fixture run, with its version and pid elided.
- The **counts** a `loadPack` reports are deliberately not on this page: the fixture pack grows as pages are written, so any number typed here would be wrong within the week — the [coverage page's](./coverage.md#how-this-page-was-checked) rule applied to a different table. The broken-file example's 124 and 125 are from a scratch copy, which is why they can be exact. For the same reason, read `check`'s `0 errors, 3 warnings, 2 notes` as one run's answer rather than as a property of the pack: what the page claims is the *shape* of the output and the level each kind of finding gets, and those were reproduced separately.
