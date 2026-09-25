# docs/site

The VitePress documentation site. **[authoring.md](authoring.md)** is the guide for adding or
changing a page: the route contract, what is generated, how figures are made, how numbers are
verified, and what every check is for. **[TEMPLATE.md](TEMPLATE.md)** is the page template it
enforces.

```
cd docs/site
npm ci                    # this directory only; not part of the root workspace
npm run generate          # generated/coverage.json (needs Go) and generated/fields/*.md
npm run dev               # http://localhost:5173/featurelab/
npm run build             # .vitepress/dist
node tools/check-links.mjs --verify-dist
node tools/check-product-links.mjs
```

Nothing under `docs/wiki/` is read by the build except `docs/wiki/images/`, which pages reference
by relative path so the image pipeline (`docs/wiki/tools/`) stays exactly as it is, and the
fixture pack's feature files (`docs/wiki/tools/fixtures/features/`), which are the playground's
examples.

## The playground

`<Playground example="scatter" />` in a page, and the whole of [`/playground`](playground.md),
run the engine in the reader's browser. The engine is WebAssembly built from `cmd/playground`,
and it is not committed: build it into `public/playground/` before `dev`, `build` or `preview`.

```
# from the repository root; needs Go
bash scripts/build-playground.sh docs/site/public/playground
```

Without it the site still builds and every page works; the playground says the engine has not
been built and how to build it. Rebuild after changing anything the engine is made of. The
viewer and sidebar are `frontend/src`, compiled from source by this site's Vite (see the `vite`
block in `.vitepress/config.mts` for why not from `frontend/dist`), so a change there shows up
in `npm run dev` with no build step.

```
npm run build
node tools/playground-smoke.mjs --screenshot playground.png   # needs `npx playwright install chromium` once
```

The smoke test runs the built site in headless Chromium and prints how long the first result
took, cold and from the browser's cache.
