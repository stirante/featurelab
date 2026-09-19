# Authoring the documentation site

For whoever adds a page, changes a page, or adds a figure. It is the contract the site keeps with
the product and with its readers — the parts a checker cannot explain to you, and the parts that
were learned by getting them wrong. [`TEMPLATE.md`](TEMPLATE.md) is the page spec and is enforced;
this document is why, plus the four things the spec does not cover: routes, generated files,
figures, and how a number gets onto a page.

## The rule you are writing under

> **The documentation is written for users, not for developers.**

That is the owner's review of the first draft of the scatter page, and it is the site's whole
structure. A reader arrives with a JSON file open and a question — *what do I write here, what
does this key do, why is nothing placed*. Answer that first. Anything needed only to reproduce
the engine — draw counts, which bound a draw uses, the order two streams advance in — stays on
the page, because it is measured and it is why these pages are worth reading, but it goes below
everything a pack author needs, under one `## Advanced: …` heading that says so.

`tools/check-template.mjs` polices that line. It fails a page on a required section missing or out
of order, an H2 where the order allows none, an `Advanced` section anywhere but between the bench
section and See also, a key the generated reference knows with no row in the Fields tables, and
draw-count language above the Advanced heading. Read [`TEMPLATE.md`](TEMPLATE.md) for the section
order and front matter; read [`features/scatter_feature.md`](features/scatter_feature.md) and
[`features/feature_rules.md`](features/feature_rules.md) as the template filled in.

## The route contract

**A page's route is its type id, minus `minecraft:`, with no suffix the type id does not have.**

```
minecraft:scatter_feature   → /features/scatter_feature
minecraft:conditional_list  → /features/conditional_list      (no "_feature" — the id has none)
minecraft:feature_rules     → /features/feature_rules
minecraft:feature_rule      → the same page: the ONE alias, spelled out in extract-catalog.mjs
                              and check-product-links.mjs
```

**A field's anchor is its JSON path**, every character outside `[A-Za-z0-9_-]` replaced by a
hyphen: `$.minecraft:scatter_feature.distribution.scatter_chance` → `#distribution-scatter_chance`.
The generated headings carry that as an explicit `{#id}`, not as slugified text, so rewording a
heading cannot break it. Give a prose heading an explicit id too when another page links it.

This exists so that a diagnostic and the editor's `?` pane can build a deep link from a type id
and a path **with no lookup table**. Ignore it and there is nothing to notice the damage: a
renamed page turns every product link into a 404, and a reworded heading turns a field link into a
silent landing at the top of the page. `tools/check-product-links.mjs` is what makes that a build
failure — every type id in `generated/coverage.json` must resolve to a page or a `redirects.json`
entry, and every product-side site URL is checked page *and* anchor. When the engine registers a
new type, it gets a page named after its id or a `redirects.json` entry the same day.

The product's half of the contract is
[`apps/vscode/src/graph/docs/url.ts`](https://github.com/stirante/featurelab/blob/main/apps/vscode/src/graph/docs/url.ts)
— `docsUrl(typeId, jsonPath?)`, twenty lines because the contract does the work. The `?` pane's
"Read the full page" link and every typed diagnostic's Problems-panel link are built with it.
Nothing else in the product may hand-write a documentation URL: `check-product-links.mjs` cannot
see a URL built at run time, so `apps/vscode/test/docsUrl.test.ts` holds the helper against this
site's own committed files — the base URL against `.vitepress/config.mts`, every anchor against
`generated/fields/*.json`. **A redirect target is a site route.** The blob URLs that stood in for
un-migrated pages during the migration are gone, and a blob link to a `docs/wiki` page is now an
error in both checkers rather than a warning.

## Files you must never hand-edit

| Path | Source | Regenerate with |
|---|---|---|
| `generated/fields/*.md`, `*.json` | the extension's catalogue (`apps/vscode/src/graph/typeCatalog.ts`, `graph/docs/catalog.ts`) | `node tools/extract-catalog.mjs` |
| `generated/coverage.json` | `go run ./cmd/featurelab types --json` | `node tools/extract-coverage.mjs` |

`npm run generate` runs both, and the docs workflow fails if the committed `generated/` differs
from a fresh run — so a page a reviewer reads can never be behind the catalogue or the engine.

The consequence worth internalising: **a wrong bound in the field reference is a product defect,
not a docs one.** Fix it in the catalogue, where three test suites already hold it to the Go
builders, and regenerate. Editing the fragment "just for the page" puts the site one `npm run
generate` away from reverting itself and leaves the editor's hover still wrong.

One part of the generated reference *is* hand-maintained and says so in its own comment: the
`EDGE_KEYS` supplement in `tools/extract-catalog.mjs`. The editor draws `places_feature` and
scatter's `iterations` as connections, so the catalogue deliberately omits them — and they are the
keys an author writes first. Add a type's entry there, verified against its builder like any other
claim, when you add its page.

## Figures

A figure is required wherever a key's values are *kinds* and the difference between them is
spatial. Not a screenshot: an entry with `panels` in
[`docs/wiki/tools/images.manifest.mjs`](../wiki/tools/images.manifest.mjs), one panel per kind,
identical parameters with the one word that differs named in the manifest, `framing: 'volume'` so
every panel shares a camera, and labels drawn by the pipeline in a bitmap font so no machine's
installed fonts can change a committed image. Render with
`node docs/wiki/tools/generate-images.mjs --only <id>`; it is deterministic and re-renders byte
for byte. The pipeline refuses to write a figure if any two panels differ over less than **2%** of
their pixels.

Four lessons, each paid for with rejected renders:

- **Whatever is *shared* between panels is usually what blocks the view.** A canopy hid the trunks
  it was supposed to frame; a ceiling plate hid everything under it; a water row at the slice
  height hid the whole difference beneath it (0.43% differing); a structure's own origin column
  held four of five cells still in all four rotations (1.84%). When panels come out too close,
  look first at what they have in common, not at the thing that varies.
- **Scale is part of the comparison.** With a subject at about 2% of its panel, "the same shape"
  and "the same picture" are indistinguishable — the tree figure had six pairs under the gate
  until the volume was tightened to `12x19x10`. Tighten the volume before you enlarge the subject.
- **Choose the scene for legibility, not realism.** The tree canopy is cut to ten cells because an
  ordinary crown is a green blob; the structure figure uses a purpose-built five-cell post instead
  of the page's own lamp post. A fixture that exists only to make a difference visible is the
  right fixture, and it is committed and named on the page.
- **The gate is not proof.** It proves two panels differ; it cannot prove either one shows the
  subject. Two figures cleared it and were rejected by eye anyway — one at **5.9%** (two ghosted
  boxes, every face of the subject culled by its neighbours) and one at **6.9%** (a correct
  quarter-turn nobody could write a caption for). **Look at every render before you write its
  caption.**

## Verify numbers by running them

A sweep of the finished pages checked 913 claims and found **25 wrong — twelve of them in the
product catalogue**, not on the pages. Assume the same rate applies to whatever you carry over.

The dominant class is **range bounds**, and it is not a docs problem: the engine is genuinely
inconsistent. Thirteen `tree_feature` keys sample inclusive of their maximum; geode's `min`/`max`
pairs are exclusive; most of the rest are exclusive. There is no rule to apply, so **measure**.

Measuring means `featurelab generate` against the committed fixture pack — the way every number on
this site was checked:

```sh
featurelab generate --pack docs/wiki/tools/fixtures --feature wiki:<id> --env void --seed 42 --size 32x16x32
```

Add the fixture and commit it, put the exact command on the page, and say what it produced in
*How this page was checked*. A claim with no command behind it is a claim nobody can re-check when
the target version moves.

## The checks

All from `docs/site`.

| Command | What it is for |
|---|---|
| `npm run generate` | Refresh `generated/`. Run it before anything else; CI fails if the committed copy differs. |
| `npm run check` | `check-template.mjs` (section order, a Fields row per key, internals below the Advanced line), `check-links.mjs` (every link and anchor, includes expanded, and no blob link to a `docs/wiki` page), `check-product-links.mjs` (product → docs, and every type id has a route). |
| `npm run build` | VitePress. A dead link *to a page* fails the build; anchors are not checked here. |
| `node tools/check-links.mjs --verify-dist` | After a build: every anchor this site computed must be an id VitePress actually wrote. This is the proof that `lib/anchors.mjs`'s port of the slugifier is exact — without it, a drifted port reports links resolving that do not. |
| `node tools/audit-migration.mjs <wiki page> <site path>` | Every number and code span of a wiki page that is not on the site page. **A list, not a gate**: an item may be a spelling variant or a deliberate cut. It is there so a dropped measurement is a decision rather than an accident. Kept with `migrate-page.mjs` for re-running an old wave out of git history; neither has an input in the working tree any more. |

Two things no check makes: whether a restructured page still *reads*, and whether a figure
demonstrates what its caption claims.

## Deliberately still open

**Two figures recommended and not built**, each because it needs a fixture that does not exist
yet: scatter against scan surface (the same delegate placed by a spread and by a surface scan),
and multiface's three spread modes.
