---
title: Playground
description: Edit a Minecraft Bedrock worldgen feature's JSON and see what it places, in your browser, with the same engine and 3D preview as the Feature Lab editor.
layout: page
pageClass: fl-playground-page
---

<div class="vp-doc fl-playground-intro">

# Playground

Try a feature without installing anything. Pick an example, change its JSON, and press **Run preview**: the feature is placed into a small bench world right here in your browser, by the same engine the [VS Code extension](./editor/extension.md) and the [`featurelab` command](./engine/cli.md) use, and drawn in the same 3D view.

- **The editor holds one feature file.** If it places other features by identifier — a scatter's `places_feature`, say — and those are examples on this site too, they are loaded with it and listed under the editor. Rename one and it is *unresolved*, exactly as it would be in your pack.
- **The sidebar is the extension's.** Change the environment preset, the bench size or the seed there and the preview runs again. The Diagnostics section lists everything the engine had to say about the run; when nothing is placed, start there and then at [When the preview shows nothing](./editor/preview_shows_nothing.md).
- **Nothing you type leaves your browser.** The engine is a download of about 9 MB, fetched once while you read and kept by your browser for your next visit.

It runs one file and the examples it names. Your own pack — its blocks, biomes, structure files and the rest of its features — needs the extension or the CLI, and blocks here are drawn in flat colours rather than with their textures.

</div>

<div class="fl-playground-wide">
  <Playground example="scatter" choose />
</div>
