---
title: The desktop app
description: Feature Lab as a standalone window — the same viewer and the same engine, linked in-process, watching a pack directory instead of an editor, and the four places that changes what you see.
scope: bench
---

# The desktop app

<VersionBadge />

**The same voxel viewer, in a window of its own.** Point it at a behaviour pack directory, pick a feature, and see what it places. It is the same tool with a different front door: use [the VS Code extension](./extension.md) when you are editing the JSON, and this when you want a preview that is not tied to an editor — on a second monitor, beside whatever you are actually working in.

Everything about the panel itself — the eight sidebar sections, the diagnostics, the budgets, the view controls, what a card and a cell and a write are — is shared with the extension and is [described there](./extension.md#the-preview). This page is only the four things that are different here, and what each one costs.

## Four differences {#four-differences}

### It links the engine, rather than running it {#in-process}

The extension spawns the `featurelab` binary and talks [newline-delimited JSON](../engine/cli.md#serve) over a pipe. This app links the engine's packages directly: there is no subprocess, no protocol between the window and the generator, and nothing to find on `PATH` or configure.

What that buys is one fewer moving part. What it costs is the next difference.

### A long load is silent {#silent-load}

`serve` sends a [`progress` notification](../engine/cli.md#the-line-contract) on its two long methods — loading a pack and building the graph — once the request passes 750 ms and then once a second, so the editor can say how far a big pack has got. A bound Wails call has no such channel, so opening a large pack in this window is one wait with nothing said about it. On a pack of a few hundred files that is imperceptible; on one of twelve thousand, on a machine whose virus scanner is reading each of them for the first time, it is the difference between a progress line and a window that looks wedged.

The texture build is the exception, because it has its own event: a 150 MB download with no sign of life reads as a hang more surely than anything else this app does.

### It watches the directory, not the editor {#the-watcher}

The extension re-renders when *you* save a file. This app watches the pack root with a file watcher, so it also notices files changed by anything else — a build step, a generator, a file deleted in Explorer. Changes are debounced into batches, and a batch it can account for reloads only the files that changed; anything else falls back to reloading the whole pack. Either way the camera stays where you put it.

There is no "current file" here, either, so the feature you are previewing is always chosen in the panel rather than inferred from what has focus.

### It reports what `check` reports {#diagnostics}

Opening a pack raises one banner with everything worth raising it for, and that list is now the same set of findings [`featurelab check`](../engine/cli.md#check) makes — including the two that are visible only with the whole pack in front of you: **a delegation that resolves to nothing**, and **a delegation cycle**. A pack with one letter wrong in one `places_feature` is made of perfectly well-formed files, so every loader loads it without a word; the one host whose entire window is a preview used to open such a pack, paint nothing, generate nothing, and leave you without a clue.

Two consequences of having exactly one banner and one colour:

- **The level is not shown.** `check` calls a dangling delegation an error and a cycle a warning; here they are both simply in the list.
- **A conventional directory the pack does not have raises nothing at all.** It is a note rather than a warning, decided from the same structured fact `check` decides it from, so the banner no longer fires on every minimal pack. A directory an explicit override *named* and that is not there still raises it, because that is a typo'd path.

A diagnostic also spells a file the way every other host spells it — `features/broken.json`, relative to the pack root — rather than under the loader's own shorter id.

## Block textures {#block-textures}

Same atlas, same question, same cache as every other host; [block textures in the preview](../engine/block_textures.md) documents the whole mechanism. Two things are this window's own:

- The "may I download Mojang's assets?" question is a **native dialog** rather than a terminal prompt or an editor notification.
- This app has **one switch where the extension has two**. `FEATURELAB_BLOCK_TEXTURES=0` turns off both the preparation and the drawing; unset means on. In the extension, [`featurelab.blockTextures`](./extension.md#settings) governs preparation and the sidebar's own switch governs drawing.

## Building and running it {#running-it}

```
wails dev            # from apps/desktop, for development
wails build          # produces apps/desktop/build/bin/
```

The Wails CLI must be **v2.13.0**, the version this repository pins; older CLIs fail against this Go toolchain with `internal error: package "context" without types was imported`.

```
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
```

Release builds go through `scripts/release/build-desktop.sh`, which the release workflow runs once per OS, and whose header comment carries the platform-specific details including the Linux WebKitGTK build tag.

## What a preview is, and is not {#what-a-preview-is}

This is a bench, not the game. It places one feature into a world generated for the purpose, so it can show that feature in isolation and say why a placement failed. It does not generate a real chunk: nothing else runs beside your feature, and nothing here proves the same JSON behaves identically in Minecraft. Where the two are known to differ the tool says so — in a diagnostic when it affects your file, and on [coverage and known gaps](../engine/coverage.md) otherwise.

## See also

- [The VS Code extension](./extension.md) — the panel this window wraps, described once, there.
- [When the preview shows nothing](./preview_shows_nothing.md) — every message an empty run can give you, in either host.
- [The `featurelab` command](../engine/cli.md) — the engine this app links, and the protocol it deliberately does without.
- [Coverage and known gaps](../engine/coverage.md) — how far the preview's agreement with the game goes.
- [Feature types](../features/index.md) — what to put in the files this window watches.
- [The desktop README ↗](https://github.com/stirante/featurelab/blob/main/apps/desktop/README.md) — the build details and the file-by-file layout of the app itself.

## How this page was checked

The four differences are read from the app's own source: the in-process `wire` calls rather than a subprocess, the absence of a progress channel against `serve`'s two reporting methods, the debounced watcher and its partial-reload batches, and the two graph findings the pack banner now carries. The Wails pin and its failure message are the repository's, and `github.com/wailsapp/wails/v2 v2.13.0` is what `go.mod` requires. The engine behaviour underneath — the `progress` notification's 750 ms delay and one-second heartbeat, and the levels `check` gives a dangling delegation and a cycle — was reproduced by running the binary; see [the CLI page](../engine/cli.md#how-this-page-was-checked).

Nothing on this page was measured *in* the window. What it draws is the shared viewer, and what it draws it from is the engine, both of which are checked where they live.
