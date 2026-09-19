# The page template

The shape every feature-type page takes on the site, and most guide pages too. It is the Bedrock
Wiki's shape — task-first opening, a complete example before any theory, the fields in tables,
a common-mistakes block, cross-links — carrying everything the wiki pages already do that the
Bedrock Wiki does not: a version pin, measured claims with the command that reproduces them, and
an explicit account of what the bench does differently. The two pilot pages,
[`features/scatter_feature.md`](features/scatter_feature.md) and
[`features/feature_rules.md`](features/feature_rules.md), are the template filled in; read them
before this.

## The rule

**Write for the person returning a feature, not for the person writing an engine.**

A reader arrives with a JSON file open and a question — *what do I write here, what does this
key do, why is nothing placed*. Every page answers that first: the task, a complete example, the
fields in tables, the mistakes. Anything a reader needs only to reproduce the engine — how many
random draws a kind spends, which bound a draw uses, the order two streams advance in — is
**not** part of that answer. It stays on the page, because it is measured and it is why these
pages are worth reading, but it goes **below** everything a pack author needs, under one heading
that says so, or off the page to the RNG guide.

The test for a sentence: *could a pack author act on this?* "Uniform never produces its high end"
— yes, they change the extent. "Uniform spends one bounded draw with bound `max − min`" — no,
that is for the advanced section. The section order below enforces this mechanically, and
`tools/check-template.mjs` fails the build when a page breaks it.

## Front matter

```yaml
---
title: Scatter feature                  # the sidebar and <title>; a name, not a sentence
description: One sentence for search engines and the meta tag, naming the type id.
typeId: minecraft:scatter_feature       # drives the coverage badge and the type-id contract
category: proxy                         # content | proxy | scene | carver | guide
game: 1.26.50.24                        # the version every claim is a statement about
alsoHolds: ["1.26.40.26"]               # versions checked and found identical (optional)
recheck: true                           # written against an older target, not yet re-checked (optional)
scope: game                             # game | bench -- a bench page's badge says so instead of naming a version
---
```

`game` replaces the "This page is a statement about **Minecraft Bedrock 1.26.50.24** specifically…"
paragraph every wiki page opens with. The badge carries the same sentence as its hover text, so
nothing is lost; what is gained is that the version is data, and a page that has not been
re-checked after a target bump can say so with `recheck: true` instead of quietly staying wrong.

## Sections, in this order

The order is required, not suggested. `tools/check-template.mjs` reads every page with a
`typeId` and fails on a required section that is missing or out of place, on an optional section
in the wrong place, and on engine-internals language above the line where it is allowed.

| # | Heading | Required | What goes in it |
|---|---|---|---|
| 1 | `# Title` + `<VersionBadge><CoverageBadge /></VersionBadge>` | yes | |
| 2 | *the opening* (no heading) | yes | Three to six sentences. First sentence in bold: what the type *does*, in the reader's terms. Then when you reach for it, what category it is, and when you *don't* need it. |
| 3 | `## Start here: a complete example` | yes | Every file the example needs, complete, with `format_version`, in a `::: code-group` when there is more than one. Never a fragment: an author pastes this. Then *what each choice buys you*, keyed by field. Then the image, the exact `featurelab generate` command behind it, and the **measured** result in prose. A tip block here is the place to say why a failure in the picture is not a bug. |
| 4 | `## Fields` | yes | **Tables, not paragraphs.** One table per JSON object level — the feature body, then each nested object — with columns *Key / Required / Value / Default / What it does*. Every key the generated reference knows appears in a row; the checker compares. A row says what to write and what happens; it links down to a per-topic section for anything longer than a sentence. When a key's values are *kinds* or *modes* (a distribution kind, a placement pass, a surface), they get their own table with a *Reach for it when* column — and a figure showing them side by side with identical parameters, when a picture would carry more than the prose (see *Figures* below). |
| 5 | `## Common mistakes` | yes | A three-column table: *You wrote* / *What happens* / *Do instead*. Every row is a real failure the page's warnings describe, findable by symptom. The wiki's "Why nothing was placed" tables are this section by another name. |
| 6 | `## How it runs` | yes | The ordered mechanics, numbered, in the reader's terms: what is resolved, what is rolled, what runs, what is returned. **No draw counts here** — "rolls `scatter_chance` once", not "spends one bounded draw". |
| 7 | *per-topic sections* | as needed | One `##` per field or behaviour that needs more than a table row: the warnings, the user-facing consequences, the reproduction commands. Give a heading an explicit id (`{#scatter-chance}`) when another page will link it. A measured table belongs here only if a pack author acts on it; otherwise it goes to section 11. |
| 8 | `## Field reference` | yes | One sentence saying it is generated from the editor's catalogue, that the tables in section 4 are the summary, then `<!--@include: ../generated/fields/<type>.md-->`. The long-form text, never a hand-written table. |
| 9 | *version sections* | as needed | "Older `format_version`s", "What changed in 1.26.50" — kept from the wiki page verbatim where they exist. |
| 10 | `## What the bench does differently` | yes | The wiki's "Coverage note". Present on every type page, even when the answer is "nothing type-specific", because absence would be ambiguous. Bench limitations live *here* and only here; nowhere else on the page is a tool's limit phrased as a fact about the game. |
| 11 | `## Advanced: …` | as needed | **The only place engine-internals material may appear**: per-kind draw counts, which bound a draw uses, draw order, the exact coordinate tables behind a "placements move" claim, index arithmetic. Opens with one sentence saying who it is for and that the reader does not need it to use the type. Links to the RNG guide as the model these numbers fit into. Everything the wiki page measured stays on the page — here. |
| 12 | `## See also` | yes | Cross-links, each with the one-line reason to follow it. |
| 13 | `## How this page was checked` | yes | The wiki's "Version and verification notes": what is stated as fact, what was reproduced and from which fixtures, what is uncertain. What makes the version badge more than decoration. |

Guide pages (`category: guide`) that document a JSON root — `feature_rules` — follow the same
order. Guide pages about a cross-cutting subject (RNG, Molang, delegation) are exempt from the
order but not from the rule: their subject *is* the mechanism, so the test is "is this what a
pack author needs to know about the mechanism", and per-type draw accounting still lives on the
type pages, in section 11, where it is next to the fields it is about.

## Figures

A figure is required, not optional, wherever a key's values are *kinds* and the difference
between them is spatial: a scatter's six distribution kinds, a vegetation patch's floor versus
ceiling, a tree's trunk kinds, a carver's shapes. Prose says "bunches towards the middle"; the
picture shows it, and it also shows what prose cannot — that two kinds look alike at a given
scale, which is itself the thing to say.

Every figure goes through `docs/wiki/tools/images.manifest.mjs` as an entry with `panels`: one
panel per kind, **identical parameters** (iterations, extents, seed, volume, camera) with the one
word that differs named in the manifest, labels drawn by the pipeline, and the pipeline's own
refusal to write a figure whose panels come out nearly identical. A one-off screenshot is not a
figure. If two kinds are indistinguishable at the chosen parameters, the page says so and the
parameters are changed until the difference shows — a figure that demonstrates nothing is worse
than no figure. The fixtures behind a figure are committed with the others and named on the page.

## Rules the template does not relax

- **Pinned version, measured numbers, named gaps.** A rewritten page keeps every number and every
  reproduction command the wiki page had; `tools/audit-migration.mjs` lists the ones it cannot
  find and each drop is a decision. Moving a number into section 11 is not dropping it.
- **Game and bench never blur.** "The game does X" and "featurelab does Y" are different
  sentences in different sections.
- **The product's words.** A feature the pack does not define is *unresolved*. The canvas has
  *cards* and connections. The preview counts *cells*; the graph counts *writes*.
- **Nothing about how a fact was learned.** What the game does, never how anyone found out.
- **Links to un-migrated pages are GitHub blob URLs**, so the page builds today and the link
  checker turns them into errors the day the target page moves.
