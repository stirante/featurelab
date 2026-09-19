---
title: Editor
description: The Feature Lab VS Code extension and desktop app — the feature graph, the 3D preview, the diagnostics, and what to do when the preview shows nothing.
scope: bench
---

# Editor

<VersionBadge />

Two hosts around one viewer. The **VS Code extension** draws your whole pack as a graph of cards you can search and edit, and previews the feature under your cursor in 3D beside its JSON, re-rendering on save. The **desktop app** is the same preview in a standalone window that watches a pack directory on disk.

| Page | What it covers | Today |
|---|---|---|
| [The VS Code extension](./extension.md) | First run, the feature graph (cards, connections, groups, patterns, the `?` pane, the keyboard interface), the 3D preview and its eight sidebar sections, the settings | On this site |
| [The desktop app](./desktop.md) | How it differs from the extension: an in-process engine, a silent long load, a watched directory instead of an editor, one texture switch instead of two | On this site |
| [When the preview shows nothing](./preview_shows_nothing.md) | Every reason a run writes no cells and where each one is reported; the refusals that are deliberately silent; the separate reasons a feature rule decorates no chunks | On this site |

## Words the editor uses

The product's own vocabulary, so a page and a panel never disagree:

- A feature the pack does not define is **unresolved**. The graph draws it as a stub card labelled `unresolved`; `featurelab check` reports it as an error with a near-match suggestion. A reference the *game* provides (a vanilla feature) is **external**, not unresolved, and is not an error anywhere.
- The graph canvas counts **cards** — one per feature or rule — and draws every `places_feature` as a connection between them.
- The preview counts **cells** it placed, carved or replaced; the graph counts **writes**, the block-write attempts a chain makes. A feature can write the same cell more than once, so the two numbers are different things and are never compared to each other.
