# Feature Lab — desktop app

A standalone window around the same voxel viewer the VS Code extension uses.
Point it at a behaviour pack directory, pick a feature, and see what it places.

It is the same tool with a different front door: use the extension when you are
editing the JSON, and this when you want a preview window that is not tied to an
editor — on a second monitor beside whatever you are actually working in.

## Running it

```
wails dev            # from this directory, for development
wails build          # produces build/bin/
```

The Wails CLI must be **v2.13.0** — the version this repo pins. Older CLIs fail
against this Go toolchain with `internal error: package "context" without types
was imported`.

```
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
```

Release builds go through `scripts/release/build-desktop.sh`, which the release
workflow runs once per OS. That script's header comment carries the
platform-specific details, including the Linux WebKitGTK build tag.

## How it differs from the extension

Same viewer, same engine, three real differences:

- **In-process.** The extension spawns the `featurelab` binary and talks JSON
  over a pipe; this app links the engine's packages directly. There is no
  subprocess and no protocol between the window and the generator.
- **It watches the directory, not the editor.** The extension re-renders when
  *you* save a file; this app watches the pack root with a file watcher, so it
  also notices files changed by anything else — a build step, a generator, a
  file deleted in Explorer. Changes are debounced, and a batch it can account
  for reloads only the files that changed; anything else falls back to reloading
  the whole pack.
- **It opens a directory, not a document.** There is no "current file", so the
  feature you are previewing is always chosen in the panel.
- **A long load is silent here.** The extension talks to `featurelab serve`,
  which sends a `progress` notification on its two long methods (loading a
  pack, building the graph) once the request passes 750ms and then once a
  second, so the editor can say how far a big pack has got. A bound
  Wails call has no such channel, so opening a large pack in this window is one
  wait with nothing said about it. The texture build is the exception — it has
  its own `textures:progress` event, because a 150 MB download with no sign of
  life reads as a hang.

Everything about the panel itself — the sections, the diagnostics, the budgets,
the view controls — is shared with the extension and described in
[`apps/vscode/README.md`](../vscode/README.md).

## What a preview is, and is not

This is a bench, not the game. It places one feature into a world generated for
the purpose, so it can show a feature in isolation and say why a placement
failed. It does not generate a real chunk: nothing else runs beside your
feature, and nothing here proves the same JSON behaves identically in Minecraft.
Where the two are known to differ, the tool says so — in a diagnostic when the
difference affects your file, and in this project's documentation set otherwise.

## Layout

| Path | What it is |
|---|---|
| `main.go` | the Wails entry point and window options |
| `app.go` | every method the frontend can call, and the one loaded pack they share |
| `identifier.go` | how a file on disk becomes an entry in the feature/rule picker |
| `textures.go` | the block-texture first run — status, the native download question, the build |
| `watcher.go` | the debounced pack-directory watcher and the change batches it reports |
| `frontend/` | the built shared viewer, embedded into the binary |

## Block textures

Same atlas, same question, same cache as every other host — see [Block textures in the
preview](https://stirante.github.io/featurelab/engine/block_textures), which documents the whole
mechanism. The window's
own differences are that the "may I download Mojang's assets?" question is a native dialog
rather than a terminal prompt, and that this app has one switch instead of the extension's two:
`FEATURELAB_BLOCK_TEXTURES=0` turns both the preparation and the drawing off. Unset means on.
