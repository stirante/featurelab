# Changelog

All notable changes to the Feature Lab extension. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-09-20

### Added

- **The graph canvas can be driven entirely from the keyboard.** Tab used to enter the canvas and
  send focus somewhere off screen, and crossing a pack took 128 presses because every card, port
  and chip was its own tab stop. There is now a single roving stop, arrows that navigate by what is
  next on screen, `Alt`+arrow to nudge a card, `F2` for a card's own ring of handle, chevron and
  chips, and `Ctrl`+`Space` to add to a selection. Crossing the canvas is 3 presses, search to the
  first inspector field 8, and grouping three cards went from impossible to 12. The Key panel
  lists keys.
- **Undo and Redo for the edits the panel makes, and a session you can come back to.** Edits made
  through the inspector could not be taken back at all. A host-side journal (50 entries, 4 MiB)
  now backs both, refuses by name when the file changed underneath rather than writing over
  somebody else's work, and offers to skip a wedged step instead of blocking the rest of the
  history. Writes are serialised, so a snapshot can no longer be taken halfway through another
  write. A restored window used to point its camera at whatever had been selected even when that
  feature had since been renamed or deleted.
- **Feature groups, declared in the pack.** A group is a `@featurelab:group` comment directive in
  the pack files themselves, so it travels in version control and is never guessed at: a group
  exists because somebody made it. The directive is honoured wherever it sits in the file and
  whatever its case, every step of making one is reachable without a shortcut, and a formatter that
  drops comments — Format Document does — now reports every group it destroyed, by the name its
  author gave it, instead of letting the grouping vanish in silence.
- **A Molang editor in every slot that accepts Molang**, whatever spelling the file uses for it.
  The number/expression mode is visible and reversible, and bracket, string and operator mistakes
  are caught in the box before they reach the pack.
- **A documentation site, at <https://stirante.github.io/featurelab/>.** The thirty-three wiki
  pages are now a site with a table of contents and search, joined by pages for the engine's CLI,
  the extension and the desktop app. Each page leads with what the type is for, a complete example
  and field tables, with draw accounting and sampling order below an Advanced line, because that
  material is for somebody writing an engine rather than somebody writing a feature. Every number
  was re-measured by running the engine rather than carried across, which is how 25 wrong claims
  were found in 913 checked — mostly range bounds, wrong in both directions. The node editor's
  documentation pane links out to the full page at the group you have open, and a diagnostic
  carries its type's page along with it.
- **A run that stops early says where it stopped and why**, so the canvas and the preview can mark
  the node it stopped at instead of showing an empty result with no reason.
- **Near-match suggestions.** An unknown feature id used to say only that it was unknown; an id
  that does not resolve — feature, rule, biome or structure — now names the closest thing there is.
  Unknown block names are checked against the real block table, and a literal `iterations: 0` is
  reported.
- **The extension says what it is doing.** Every command now runs behind a progress notification
  naming the step it is on — checking the engine, loading the pack, building the graph — and
  leaves a spinner in the status bar for as long as any run is in flight, including the background
  re-renders a save triggers. The spinner is clickable and opens the log. Long placements can be
  cancelled.
- **`Feature Lab: Show Log`**, and a shared **Feature Lab** output channel behind it. It records
  the engine executable that was chosen and its version, the pack root that was worked out, the
  file each command was asked about, how long each step took, and everything the engine wrote,
  verbatim. Every failure notification now carries a **Show log** button that opens the same place.
- **A start-up check on the engine binary.** A VSIX built for another platform, a file without the
  execute bit, a `featurelab.binaryPath` pointing at a stale build or at a directory — all of these
  used to surface as the first request hanging until the timeout, or as nothing happening at all.
  They are now reported before a command needs the engine, naming the path that was tried and
  quoting the engine's own words.
- **`featurelab version --json`**, which is what that check reads.
- **A real empty state on the graph canvas.** An empty canvas used to be the single appearance of
  four different situations: a pack with nothing in it, a pack whose files all failed to load, a
  folder that is not a pack root, and a webview whose script never ran. Each now says which one it
  is, and what to do about it.
- **An extension icon**, generated by `scripts/make-icon.mjs`.

### Changed

- **The pack is laid out so it can be read.** 77% of the canvas was packing waste between
  components, with five oversize components each taking a full-width band. A skyline pass that
  keeps input order takes ink from 4.3% of the canvas to 11.2%, and the whole-pack fit zoom from
  0.019 to 0.047. The opening camera lands on a root from Starts here rather than on the densest
  blob, and snaps so cards are not sliced at either edge.
- **A click on the canvas costs 35 ms, not 270.** The classes that quiet the canvas during an
  interaction were written on its root element, where one class write invalidated all 3,531 cards.
  Selection is now 35 ms and starting a search 17 ms.
- **The preview is honest about what it drew.** It used to draw flat colours without ever saying
  why, attribute a whole run to one writer, and leave the previous run's mesh on screen after a
  cancellation with nothing to mark it stale. Each inert state now carries its reason, attribution
  names every writer that contributed — in colours at least 25 dE apart under protan, deutan and
  tritan simulation — and picking, the empty result and the cancellation all report in the viewport
  rather than only in the sidebar. The panel uses the host's theme in light mode instead of its own
  colours, announces a run once instead of ten times a second, and can be driven from the keyboard.
- **Body text clears 4.5:1 against its background in both the light and dark themes.**
- **`featurelab check` prints a table.** It printed raw JSON with no summary; it now prints a
  LEVEL/FILE/MESSAGE table and a count that matches what is above it, with `--json` for the array.
  A delegation that points at nothing is an error, and a conventional directory the pack does not
  have is a note.
- **`featurelab.requestTimeoutMs` is an idle deadline, not a limit on how long a request may take.**
  It is how long the engine may go silent, re-armed by every progress line, so a pack that needs a
  minute to load is never cut off while it is visibly working. Long waits now show the engine's own
  phase and the elapsed time instead of one frozen sentence.
- **Cancelling a preview actually cancels it.** The engine's `cancel` now interrupts a placement
  in flight rather than being noticed after it finishes, and the next request still works.

### Fixed

- **Three ways your work could disappear without a word.** Creating a group with the mouse wrote a
  second, differently named group over both of the member files; an expression box that had gone
  stale wrote its old text back over a file somebody else had changed; and the inspector discarded
  what you were typing when a profiled preview finished. All three are fixed. A Molang box that is
  clean now adopts what the file says, and one you have edited keeps your text and tells you what
  changed, with three ways out.
- **`Feature Lab: Open Feature Graph` works with a pack folder open and no file in the editor.** It
  was gated on the language of the active editor, so in that state it was both hidden from the
  command palette and broken if you reached it another way — which is what a user reported. It now
  resolves the pack root from the workspace, including the BP/RP parent layout.
- **A trailing comma is reported against the comma**, not against the brace on the line below it.
  Syntax errors carry a column as well as a line, wrong-type errors have a position at all, and a
  duplicate key is now reported: the game keeps the last one, so the earlier write has no effect.
- **A file that begins with a UTF-8 BOM parses.** The byte-order mark some editors write no longer
  makes the whole file fail to load. Worth knowing that the 1.26.50 client's own parser does not
  skip it either.
- **A pack root that is not there fails.** A typo in `--pack` reported a clean pack and exited 0,
  which is the worst available outcome for a command whose job is to fail; a root that is a file
  gets its own wording. A root that exists but holds none of the five pack directories stays a
  warning at exit 0, because the loader cannot tell it from an ordinary pack with no worldgen
  content.
- **An empty block name is rejected.** An empty name inside a weighted entry passed every check
  while placing nothing. The fix sits at the one point every parse funnels through, so it covers
  `places_block`, `may_replace`, `may_grow_on`, attach faces, `base_block` and the tree blocks at
  once.
- **Thirteen wrong bounds in the field documentation**, each of which misled twice, since that text
  is what the node editor's documentation pane shows and what the site's field reference is
  generated from. Geode's maxima are exclusive, so `[3, 4]` points is always 3; `sculk_patch`'s
  `central_block` was marked required while the engine accepts its absence; four minima were
  documented that nothing enforces; cherry trunks no longer share acacia's interval wording.
  `search_radius` has no lower bound — `-5` loads with no diagnostic — and the height difference
  filter is new in 1.26.40, not in this version. Each was measured by running the engine, which is
  genuinely inconsistent about whether a maximum is inclusive.
- **The documentation screenshots.** `docs/graph-compound.png` contained no compound, and several
  images showed a toolbar button that no longer exists. `scripts/capture-graph-screenshots.mjs`
  drove all eight captures from one long-lived page and closed each overlay by pressing Escape,
  which the documentation panel ignores unless it has focus — so that panel stayed open over the
  canvas and was photographed under two other filenames, with nothing failing. Each capture now
  gets its own page, and each one asserts that the surfaces its filename claims are open and that
  every other one is closed.

## [0.1.1] — 2026-09-18

### Added

- **Texture sets.** A `terrain_texture.json` path may now name a `.texture_set.json`, whose colour
  channel is read whether it is another texture, a hex colour or an RGBA array.
- **Per-block-state textures.** A block's `permutations` can give it different textures and
  geometry per state; the viewer now looks a face set up by block name *and* states, so a pack
  author's state-specific art appears instead of the block's default faces.
- **Textures smaller than a cell.** An 8×8 or 4×4 texture is now upscaled into the atlas instead
  of being rejected — pack blocks routinely ship them, and rejecting one dropped that block to a
  flat colour while every vanilla block beside it kept its picture.

### Changed

- **The atlas is restaled by content, not by file stats.** Block definitions used to be
  fingerprinted by file count, total size and newest modification time, so an edit that preserved
  all three was missed until the next rebuild. The fingerprint now hashes content, including the
  `.texture_set.json` behind each texture path.
- `featurelab textures --yes`' help text now matches what the flag does: it permits the download.

### Fixed

- **One bad `terrain_texture` entry no longer costs the pack every texture.** The entry is skipped,
  the rest of the file loads, and the reason is reported against every block face that wanted it
  (up to twenty; `featurelab blocktable` lists the rest).
- **`variations` entries load.** A `terrain_texture` entry whose value is a `variations` array
  resolves to its first entry rather than failing to parse. The game picks among the variations at
  random; the preview pins the first, so a block with variations draws one consistent face.
- Packs with no linked resource pack now say so, and say how to link one, instead of silently
  drawing flat colours.

## [0.1.0] — 2026-09-18

First release.

- **Preview a feature or a feature rule** (`Ctrl+Alt+P`): the whole behaviour pack is loaded around
  the file you are on, the one feature you asked for is placed into a generated world, and the
  result is drawn in a rotatable 3D panel beside the JSON. Saving re-reads only the file you saved.
- **The feature graph** (`Feature Lab: Open Feature Graph`): every feature and rule in the pack as
  connected, colour-coded cards, with a schema-driven form for the selected node, search across
  identifiers and types, a create menu built from the engine's own type table, author-declared
  groups, and compound patterns that place several wired-together features in one step.
- **Diagnostics.** Placements that leave no visible trace — an attach condition that did not match,
  a `may_replace` that rejected a position, a delegate that declined — are listed with the
  delegation chain that reached them, a count, and a button that moves the camera to where it
  happened. Load-time problems appear as squiggles in the JSON and in the Problems panel.
- **Block textures**, drawn from Mojang's sample resource pack after a single opt-in prompt, and
  from the pack's own resource pack for its own blocks. Declining leaves flat per-block colours.
- Ten environment presets, editable terrain materials, biome and biome-tag selection, per-run
  budgets on writes/delegations/time, height slicing and write-count colouring, and an optional
  per-feature profiler.
- Ctrl+click a `places_feature` or `features` entry to jump to the file that defines it.

[Unreleased]: https://github.com/stirante/featurelab/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/stirante/featurelab/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/stirante/featurelab/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stirante/featurelab/releases/tag/v0.1.0
