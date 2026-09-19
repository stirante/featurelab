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
by relative path so the image pipeline (`docs/wiki/tools/`) stays exactly as it is.
