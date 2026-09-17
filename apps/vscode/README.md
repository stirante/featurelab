# Feature Lab

Live preview for Minecraft Bedrock worldgen JSON, inside the editor. Open a
`features/` or `feature_rules/` file, press a key, and see the blocks that file
would place — in a rotatable 3D view, next to the JSON that produced them.

## What it does

- **Previews a feature or a feature rule.** Point it at a file and it loads the
  whole behaviour pack around it — features, feature rules, structures, biomes
  and any block definitions the pack ships — then places the one feature you
  asked for into a small generated world and renders the result.
- **Re-renders when you save.** Saving re-reads only the file you saved, so the
  preview comes back in tens of milliseconds rather than re-reading the pack.
- **Explains what it refused to do.** Placement failures that leave no visible
  trace — an attach condition that did not match, a `may_replace` list that
  rejected a position, a delegate that declined — are listed in the panel's
  Diagnostics section with the delegation chain that reached them, a count, and
  a button that moves the camera to the position it happened at. Load-time
  problems also appear as squiggles in the JSON.
- **Follows references.** Ctrl+click (Cmd+click) a `places_feature` or a
  `features` entry to jump to the file that defines it.

## Getting started

1. Open a folder containing a behaviour pack — anything with a `features/`
   directory in it.
2. Open a feature or feature rule JSON file.
3. Run **Feature Lab: Preview Feature** (`Ctrl+Alt+P`, `Cmd+Alt+P` on macOS),
   from the editor title bar, or from the right-click menu.

The panel opens beside the file. Everything in it is per-preview and lives only
as long as the panel does.

## The panel

| Section | What it is for |
|---|---|
| **Feature / Rule** | Which feature or rule to place, where to place it, and how many times. A rule preview runs the rule's own distribution across the chunks it would decorate, instead of placing one feature at one point. |
| **Environment** | The generated world to place into — a terrain preset and the size of the volume. Ten presets: `plains`, `forest`, `desert`, `ocean`, `nether`, `end`, three underground fills and an empty `void`. |
| **Materials** | Which blocks the preset's terrain is made of, so a feature that only attaches to a specific block can be tested without editing the pack. |
| **Biome** | A pack biome to run under, or a hand-written tag list, for features gated on biome tags. |
| **Budget** | Per-run limits on writes, delegations and wall-clock time. These are the bench's own guard rails, not the game's: a feature that references itself in a loop truncates the preview instead of hanging it. |
| **View** | Slice the volume by height, show or hide the surrounding terrain, colour cells by how many times they were written, and frame the camera. |
| **Diagnostics** | Everything the run declined to do, and why. |
| **Profiler** | Optional per-feature timing and write counts for a delegation chain, off by default. |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `featurelab.binaryPath` | *(empty)* | Path to the engine executable. Leave empty to use the copy bundled with the extension. |
| `featurelab.blockTextures` | `true` | Draw blocks with real Minecraft textures instead of flat per-block colours. The first preview offers **once** to fetch Mojang's sample resource pack (about 150 MB transferred, cached outside your pack); nothing is downloaded without an explicit yes, and declining is remembered. Set to `false` for flat colours and no question. See the project wiki's *Block Textures in the Preview* page for what gets downloaded, where it is cached, and how to remove it. |
| `featurelab.env` | `plains` | Which environment preset a new panel starts on. |
| `featurelab.requestTimeoutMs` | `30000` | How long to wait for the engine before treating a request as failed. |

## What a preview is, and is not

The preview is a **bench**, not the game. It places one feature into a world it
generated for the purpose, so it can show you a feature in isolation and tell
you why a placement failed. It does not generate a real chunk: no other feature
runs beside yours, and nothing in the panel proves the same JSON behaves
identically in Minecraft.

Where the two are known to differ, the tool says so — in a diagnostic when the
difference affects your file, and in this project's documentation set
otherwise. That set carries a page per feature type describing what every field
does, plus a coverage page listing each known gap and what it means for a pack.
It is the honest place to start when a preview and the game disagree.

## Requirements

VS Code 1.85 or newer. The engine binary is bundled; nothing else to install.
