---
title: The VS Code extension
description: Feature Lab in VS Code — the two commands, the feature graph and its keyboard interface, the preview sidebar's eight sections, where a failure is reported, and what each setting actually governs.
scope: bench
---

# The VS Code extension

<VersionBadge />

**Feature Lab shows you what a worldgen feature actually does.** Open a `features/` or `feature_rules/` JSON file and it renders the blocks that file would place, in 3D, beside your code — or draws your whole pack as a graph of cards you can read, search and edit. The engine ships inside the extension, so there is nothing else to install.

**This page is about the editor, not the game.** What to write in a feature file is on the [feature type pages](../features/index.md), one per type id; what the engine does when you drive it yourself is [the `featurelab` command](../engine/cli.md). This page is the host: what it puts on screen, what it calls things, and which of its knobs does what.

## Two commands {#two-commands}

Both are in the Command Palette from the moment the extension is installed.

| Command | Needs | What you get |
|---|---|---|
| **Feature Lab: Open Feature Graph** | The pack folder open | Every feature and rule in the pack, as connected cards you can edit |
| **Feature Lab: Preview Feature** (`Ctrl+Alt+P` / `Cmd+Alt+P`) | A feature JSON open in the editor | The blocks that feature places, in a rotatable 3D panel |

Five more are in the palette: **Show Log**, **Retry Loading the Feature Graph**, **Refresh Block Textures**, and **Undo Last Change** / **Redo Last Change**, which are also bound inside the graph panel (below).

Open the **pack folder itself**, not the parent that holds both packs — though if you do open the parent, the graph still finds the pack inside it. A preview is of one feature, so it needs a file open or a card clicked; the graph is about the pack, so it needs neither.

## The feature graph {#the-graph}

Every feature and rule in the pack is a **card**; every `places_feature` is a **connection**. Cards are coloured by what the delegation *is* — a scatter, a weighted pick, a sequence — so the shape of a pack is visible before you read a line of it. Select a card and the side panel becomes a form for that feature, built from the type's real schema; editing the form writes the file, with your comments, key order and indentation left alone.

- **Search** (`Ctrl+F`) matches identifiers, types and filenames, and says what is wrong with a hit before you click it.
- **Right-click empty canvas** to create a feature. The menu only offers what the engine can build at your pack's `format_version`, and its categories are grouped by what a type *does* rather than by what it is called.
- **Patterns**, in that same menu, place several features wired together in one step — a loop, a column, a placement guard — for shapes the type list has no single entry for.
- **Groups**: select several cards, `Ctrl+G`, name it, and they become one card you can fold and unfold. The grouping lives in the pack files, so it is yours and your team's rather than a local setting, and a group exists only because somebody made one — none are guessed at.
- Every section of the form has a **`?`** that opens what that field does in plain words. That text and this site's [field references](../features/index.md) come from the same catalogue, so they cannot disagree about what a key is.

A feature the pack does not define is drawn as an **unresolved** stub card. One the *game* provides is **external** — correct in game, invisible here, and not an error anywhere. The canvas counts cards; the graph counts **writes**, which is a different number from the preview's **cells**. See [the editor's words](./index.md#words-the-editor-uses).

### The canvas from the keyboard {#keyboard}

The canvas is a single tab stop with a roving focus, so `Tab` gets you to it and past it and everything below happens inside it. Press **`?`** on the canvas for the product's own copy of this table — it is generated from the same list, and a test holds the two together, so it cannot drift from the bindings.

| Keys | What they do |
|---|---|
| `Arrows` | On a card, moves to the nearest card that way. On the background, pans the view. |
| `Alt+Arrow` | Moves the focused card itself, a step at a time. Hold `Shift` for a longer step. |
| `Home` / `End` | The first and the last card in **reading order** — rows top to bottom, left to right within a row. That is where the cards are on screen, not what the graph connects to what. |
| `Enter` | Selects the focused card on its own and opens it in the panel beside the canvas. On a folded group, unfolds it. |
| `Ctrl+Space` | Adds the focused card to the selection, or takes it back out. This is how a selection is built without a mouse. |
| `F2` | Steps into the focused card's own controls — its connector handle, its chevron, each outgoing connection — one per press, and wraps back to the card. `Escape` steps back out. |
| `Escape` | Drops the selection, or abandons a connection being drawn. |
| `Ctrl+F` | The search box, which teaches its own filters once it is open. |
| `Ctrl+G` | Groups what is selected, and names it. `Ctrl+Shift+G` takes a group apart again. |
| `+` / `-` | Zooms in and out around the middle of the view. |
| `0` | Fit: zooms out until every card is on screen at once. |
| `?` | Opens and closes the key panel. |

`Ctrl+Z` and `Ctrl+Shift+Z` (`Ctrl+Y` on Windows and Linux) undo and redo the **pack** — but only while you are not typing into a field, where they are left to the text box so your half-written Molang is not what gets undone. `Delete` removes the selected card; on a multi-selection it stages a confirmation first. Moving focus to a card brings the camera with it if the card is off screen.

## The 3D preview {#the-preview}

`Ctrl+Alt+P` runs the feature into a small world generated for the purpose and shows the result; saving the file re-renders it. Blocks the feature wrote are drawn solid, the environment can be solid, ghosted or hidden, and cells the feature **removed** are drawn as a translucent carved volume — without which an excavating feature looks like it did nothing.

The sidebar has eight sections. The first four decide what the *next* run does; the last four decide how you look at the run you already have.

| Section | What it is for |
|---|---|
| **Feature / Rule** | Which feature to place, where, and how many times. A rule preview runs the rule's own distribution across the chunks it would decorate, the way the game applies it — see [feature rules](../features/feature_rules.md). |
| **Environment** | The world to place into: ten terrain presets, from `plains` to `nether` to an empty `void`, and the size of the volume. |
| **Materials** | What the terrain is made of, so a feature that only attaches to one block can be tested without editing the pack. The three sea slots are inert under a preset that builds no sea, and say so. |
| **Biome** | A pack biome to run under, or a hand-written tag list, for features gated on biome tags. |
| **Budget** | Limits on writes, delegations and wall-clock time, so a feature that references itself truncates instead of hanging. Raising the time limit raises the extension's own wait with it. |
| **View** | Slice by height, hide the surrounding terrain, colour cells by write count, frame the camera — and the **Block textures** switch, which is what decides whether textures are *drawn*. |
| **Diagnostics** | Everything the run declined to do and why, with the delegation chain that reached it and a button that moves the camera there. |
| **Profiler** | Off by default. A machine-readable stop code per feature, and the only way to see the refusals that are deliberately silent. |

If the preview comes back empty, **Diagnostics** is where the reason is — and when Diagnostics is empty too, the Profiler is the next place. [When the preview shows nothing](./preview_shows_nothing.md) is the index of every message either one can give you.

Ctrl+click (Cmd+click) a `places_feature` or `features` entry in the JSON to jump to the file that defines it.

## When something goes wrong {#when-something-goes-wrong}

Every command shows what step it is on and leaves a spinner in the status bar while it runs. On a big pack the engine's own [progress reports](../engine/cli.md#the-line-contract) join that line — the phase it is in, how many files it has read, and a second count that keeps moving — so a long load reads as work rather than as a hang. Every failure ends in a short message with a **Show log** button.

Run **Feature Lab: Show Log** for the whole story: which engine executable was chosen and its version, the pack root it worked out, how long each step took, and everything the engine wrote, verbatim.

Problems with the file you are previewing also appear as **squiggles in the JSON and in the Problems panel**. A finding the engine gave a line and column for is marked at that character — `invalid JSON at line 4, column 57` lands on the comma — and everything else spans the whole document, which is all that can honestly be said about a placement that was refused: it is about a feature, not a character.

The findings that are about how two files *relate* are the graph's, not the panel's: a delegation that resolves to nothing is an unresolved stub card, and a cycle is drawn as one. To have every one of them in a list at once, across the whole pack and without previewing anything, run [`featurelab check`](../engine/cli.md#check).

## Settings {#settings}

| Setting | Default | What it does |
|---|---|---|
| `featurelab.binaryPath` | *(empty)* | Path to the engine executable. Empty uses the copy bundled in the extension; set it at a local build during development. |
| `featurelab.env` | `plains` | Which environment preset a new panel starts on. |
| `featurelab.requestTimeoutMs` | `30000` | How long the engine may go **silent** before a request is given up on — **not** how long the request may take. |
| `featurelab.blockTextures` | `true` | Whether block textures are **prepared**. Not whether they are drawn. |

Those last two are the ones people read as something they are not.

**`requestTimeoutMs` is an idle deadline.** The engine reports progress once a second on anything slow, and every report buys another full wait, so a pack that needs a minute to load is never cut off while it is visibly working. What gets cut off is a request that stops saying anything for this long. For `generate` it is also a *floor*: raise the panel's Budget placement time limit above it and the extension waits longer, and shows the raised wait there. Raising this number to "let a big pack finish" is therefore treating a symptom that does not exist.

**`blockTextures` governs preparation.** With it on, the first preview asks **once** whether to fetch Mojang's sample resource pack — about 150 MB, cached outside your pack — and declining is remembered. With it off, nothing is ever fetched, built or asked about. Whether textures are actually *drawn* once an atlas exists is the preview sidebar's own **Block textures** switch, in the View section, which remembers what you choose. Either one off leaves the preview in the flat block colours it has always drawn, and it says which one. [Block textures in the preview](../engine/block_textures.md) is the whole mechanism.

## What a preview is, and is not {#what-a-preview-is}

The preview is a **bench**, not the game. It places one feature into a world it generated for the purpose, so it can show that feature in isolation and say why a placement failed. It does not generate a real chunk: no other feature runs beside yours, nothing that would have been there already is, and nothing here proves the same JSON behaves identically in Minecraft.

Where the two are known to differ the tool says so — in a diagnostic when it affects your file, and on [coverage and known gaps](../engine/coverage.md) otherwise, which lists every type-specific gap and the bench-wide approximations that cut across all of them. That page is the honest place to start when a preview and the game disagree.

Requirements: VS Code 1.85 or newer. Nothing else.

## See also

- [When the preview shows nothing](./preview_shows_nothing.md) — every message an empty run can give you, findable by the sentence you are reading.
- [The `featurelab` command](../engine/cli.md) — the engine the extension drives, and the protocol the settings above are built on.
- [The desktop app](./desktop.md) — the same viewer without an editor around it, and the three places that changes something.
- [Coverage and known gaps](../engine/coverage.md) — how far the preview's agreement with the game goes.
- [Feature types](../features/index.md) — one page per type id, which is where the `?` pane's text is also from.
- [The extension on the Marketplace ↗](https://github.com/stirante/featurelab/blob/main/apps/vscode/README.md) — the listing, with screenshots of everything above.

## How this page was checked

The commands, their keybindings and their `when` clauses, and every setting's name, default and description, are read from the extension's own manifest rather than retyped. The keyboard table is the product's own key legend, which the canvas publishes as `aria-keyshortcuts` and a test holds against the panel, so it cannot drift from the bindings; the `Enter`-unfolds-a-group behaviour is from the handler and is the one row the legend does not spell out. The sidebar's eight sections and the **Block textures** switch's place among them are read from the panel. Everything about the engine underneath — the progress reports, the `check` findings, the three levels — was reproduced by running the binary and is on [the CLI page](../engine/cli.md#how-this-page-was-checked).

The screenshots are deliberately not here. They belong to the Marketplace listing, which has its own capture pipeline and must read as a standalone page; duplicating them would mean two sets to keep in step with one product.
