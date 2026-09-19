---
title: Engine & CLI
description: The Go engine behind Feature Lab and its featurelab command — generate, check, serve, types, textures, blocktable — and the pages on how far the bench matches the game.
scope: bench
---

# Engine & CLI

<VersionBadge />

The engine is a Go module that loads a behaviour pack, builds a bench world from a preset, and runs one feature or one feature rule in it, reporting every block it placed, carved or replaced and every placement it declined. `cmd/featurelab` is the headless binary around it.

::: info One page still to come
The wire format has no page of its own yet; `wire`'s package documentation is the field-by-field spec, and [the CLI page](./cli.md) covers what a caller needs.
:::

| Page | What it covers | Today |
|---|---|---|
| [The `featurelab` command](./cli.md) | `generate`, `check`, `serve`, `types`, `textures`, `blocktable`; the run-length-encoded result; cancellation | On this site |
| [Coverage and known gaps](./coverage.md) | Which types the bench implements fully, which partially and what each gap means for a pack; the bench-wide approximations that cut across every page; what has and has not been checked against real content | On this site |
| [Block textures in the preview](./block_textures.md) | Where Mojang's textures come from and what the first run asks; how a pack's own blocks are resolved through its resource pack; what is drawn accurately and what is approximated | On this site |
| The wire format | The JSON `generate` and `serve` emit, which is the whole contract between the engine and every viewer | `wire`'s package documentation ↗ (not yet a page) |

## Coverage, live

The engine's own coverage table, as `featurelab types --json` reports it at the time this site was built. Counts are read from the engine, never typed into a page.

<script setup>
import coverage from '../generated/coverage.json'
const s = coverage.summary
const byStatus = (status) => coverage.types.filter((t) => t.status === status).map((t) => t.typeId)
</script>

<p>
  <strong>{{ s.total }}</strong> registered types:
  <strong>{{ s.implemented }}</strong> implemented,
  <strong>{{ s.partial }}</strong> partial,
  <strong>{{ s.missing }}</strong> missing,
  <strong>{{ s.outOfScope }}</strong> out of scope.
</p>

<details>
  <summary>Partial</summary>
  <ul><li v-for="t in byStatus('partial')" :key="t"><code>{{ t }}</code></li></ul>
</details>
<details>
  <summary>Out of scope</summary>
  <ul><li v-for="t in byStatus('out_of_scope')" :key="t"><code>{{ t }}</code></li></ul>
</details>
