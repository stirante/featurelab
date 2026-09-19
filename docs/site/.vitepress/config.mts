// VitePress configuration for the Feature Lab documentation site.
//
// This is the documentation. The 33 pages that used to live under docs/wiki/ were migrated here
// one wave at a time (see authoring.md) and deleted at the cut-over; what remains under
// docs/wiki/ is the image pipeline (tools/), its fixture pack (tools/fixtures/) and its
// committed renders (images/). The only things this config reads from outside its own directory
// are docs/wiki/images/ -- referenced by relative path from each page, so the pipeline stays
// untouched -- and the extension's catalogue modules, through tools/extract-catalog.mjs, which
// runs before the build and never during it.
import { defineConfig } from 'vitepress'
import container from 'markdown-it-container'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The site's root on the host. GitHub Pages serves a project site under /<repo>/, so links,
 * assets and the deep-link contract all carry this prefix; DOCS_BASE lets a custom domain (base
 * `/`) be tried without editing this file. The product's deep links carry the full origin plus
 * base (see authoring.md, "The route contract"), so a change here is a change there too. */
const base = process.env.DOCS_BASE ?? '/featurelab/'

/** The Bedrock version every page is a statement about, exactly as the wiki index pins it.
 * A page's own front matter (`game:`) may pin a different one; this is only the default the
 * version badge falls back to, and the one the site title advertises. */
const targetGame = '1.26.50.24'

/** Old page -> new page. Two uses: VitePress `rewrites` below, and `buildEnd`, which writes a
 * redirect stub at each old route so a deep link to a page that has not migrated yet (or that
 * has been renamed) lands somewhere instead of on a 404. Kept as a file so the product-link
 * checker can read it without importing this config. */
const redirects: Record<string, string> = JSON.parse(fs.readFileSync(path.join(siteDir, 'redirects.json'), 'utf-8'))

export default defineConfig({
  title: 'Feature Lab',
  description: `Minecraft Bedrock worldgen features, measured against ${targetGame}, and the tool that measures them.`,
  base,
  lang: 'en',
  lastUpdated: true,

  // `features/scatter_feature.md` is served at `/features/scatter_feature` -- no `.html`, no
  // trailing slash. That is the deep-link contract (authoring.md), and it is the plain one: the route
  // is the file path. GitHub Pages serves `scatter_feature.html` for that URL. (The alternative,
  // rewriting every page into `<page>/index.md`, was tried first: it makes VitePress resolve a
  // page's relative links against the rewritten directory, so `./feature_rules.md` from
  // scatter_feature.md pointed at features/scatter_feature/feature_rules and every sibling link
  // was dead. Directory routes would need every page written as `<page>/index.md` by hand.)
  cleanUrls: true,

  // Not pages: the generated fragments (included into pages, never built on their own), the
  // documents addressed to whoever writes the site rather than to a pack author, and this
  // directory's own README.
  srcExclude: ['generated/**', 'node_modules/**', 'authoring.md', 'TEMPLATE.md', 'README.md', '.cache/**'],

  // A dead link to a page fails the build. Anchors are NOT checked by VitePress -- that is what
  // tools/check-links.mjs is for, and why the Pages workflow runs it as well.
  ignoreDeadLinks: false,

  sitemap: { hostname: 'https://stirante.github.io' + base },

  markdown: {
    // h2 and h3 in the right-hand outline; the generated field reference uses h4 so that a type
    // with forty fields does not have forty outline entries.
    // (`outline` on themeConfig, below, is what the default theme reads; this is the level the
    // headers plugin extracts.)
    headers: { level: [2, 3] },
    config(md) {
      // The wiki's `::: note` container. VitePress ships tip/info/warning/danger/details and no
      // `note`; without this the pages' 60-odd notes render as literal `:::` lines.
      md.use(container, 'note', {
        render(tokens: any[], idx: number) {
          const token = tokens[idx]
          if (token.nesting === 1) {
            const title = token.info.trim().slice('note'.length).trim() || 'Note'
            return `<div class="custom-block note"><p class="custom-block-title">${md.utils.escapeHtml(title)}</p>\n`
          }
          return '</div>\n'
        },
      })
      // The wiki's fence titles: ```json title="feature_rules/x.json". VitePress has no title on
      // a standalone fence (its `[label]` syntax is read only inside a code group), so the
      // title= form is silently dropped. This renders it as a caption line above the block,
      // and strips it from the info string so highlighting still sees a bare language.
      md.core.ruler.push('fl-fence-title', (state) => {
        for (let i = 0; i < state.tokens.length; i++) {
          const token = state.tokens[i]
          if (token.type !== 'fence') continue
          const m = /^(\S+)\s+title="([^"]*)"\s*(.*)$/.exec(token.info)
          if (!m) continue
          token.info = `${m[1]}${m[3] ? ' ' + m[3] : ''}`
          const caption = new state.Token('html_block', '', 0)
          caption.content = `<div class="fl-fence-title"><code>${md.utils.escapeHtml(m[2])}</code></div>\n`
          state.tokens.splice(i, 0, caption)
          i++
        }
      })
    },
  },

  themeConfig: {
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/stirante/featurelab/edit/main/docs/site/:path',
      text: 'Edit this page on GitHub',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/stirante/featurelab' }],
    footer: {
      message: `Every page is a statement about Minecraft Bedrock ${targetGame} unless its badge says otherwise.`,
    },

    nav: [
      { text: 'Features', link: '/features/', activeMatch: '^/features/' },
      { text: 'Engine & CLI', link: '/engine/', activeMatch: '^/engine/' },
      { text: 'Editor', link: '/editor/', activeMatch: '^/editor/' },
    ],

    // The sidebar is the information architecture, so it is written out rather than generated:
    // the feature types are grouped by wiki.bedrock.dev's four categories (the grouping the wiki
    // index already uses), the guides sit with them because they are about the game, and the two
    // supporting audiences get their own trees. Entries whose page has not migrated yet link to
    // the wiki page on GitHub, marked ↗, so the tree is complete from day one and a reader is
    // never sent to a page that does not exist. As pages migrate, the ↗ entries become local.
    sidebar: {
      '/features/': [
        {
          text: 'Feature types',
          items: [{ text: 'Overview and taxonomy', link: '/features/' }],
        },
        {
          text: 'Content features',
          collapsed: false,
          items: [
            { text: 'Single block', link: '/features/single_block_feature' },
            { text: 'Ore', link: '/features/ore_feature' },
            { text: 'Tree', link: '/features/tree_feature' },
            { text: 'Growing plant', link: '/features/growing_plant_feature' },
            { text: 'Structure template', link: '/features/structure_template_feature' },
            { text: 'Multiface', link: '/features/multiface_feature' },
            { text: 'Fossil', link: '/features/fossil_feature' },
            { text: 'Multipart block column', link: '/features/multipart_block_column_feature' },
            { text: 'Horizontal tree decoration', link: '/features/horizontal_tree_decoration_feature' },
            { text: 'Multi block', link: '/features/multi_block_feature' },
          ],
        },
        {
          text: 'Proxy features',
          collapsed: false,
          items: [
            { text: 'Scatter', link: '/features/scatter_feature' },
            { text: 'Aggregate', link: '/features/aggregate_feature' },
            { text: 'Sequence', link: '/features/sequence_feature' },
            { text: 'Weighted random', link: '/features/weighted_random_feature' },
            { text: 'Search', link: '/features/search_feature' },
            { text: 'Snap to surface', link: '/features/snap_to_surface_feature' },
            { text: 'Conditional list', link: '/features/conditional_list' },
            { text: 'Scan surface', link: '/features/scan_surface' },
            { text: 'Surface relative threshold', link: '/features/surface_relative_threshold_feature' },
            { text: 'Height difference filter', link: '/features/height_difference_filter_feature' },
          ],
        },
        {
          text: 'Scene features',
          collapsed: false,
          items: [
            { text: 'Geode', link: '/features/geode_feature' },
            { text: 'Vegetation patch', link: '/features/vegetation_patch_feature' },
            { text: 'Partially exposed blob', link: '/features/partially_exposed_blob_feature' },
          ],
        },
        {
          text: 'Carver features',
          collapsed: false,
          items: [
            { text: 'Cave carver', link: '/features/cave_carver_feature' },
            { text: 'Underwater cave carver', link: '/features/underwater_cave_carver_feature' },
            { text: 'Nether cave carver', link: '/features/nether_cave_carver_feature' },
          ],
        },
        {
          text: 'How features reach a world',
          collapsed: false,
          items: [
            { text: 'Feature rules', link: '/features/feature_rules' },
            { text: 'Delegation and composite features', link: '/features/feature_delegation' },
            { text: 'RNG and determinism', link: '/features/rng_and_determinism' },
            { text: 'Molang in world generation', link: '/features/molang' },
          ],
        },
      ],
      '/engine/': [
        {
          text: 'Engine & CLI',
          items: [
            { text: 'Overview', link: '/engine/' },
            { text: 'The featurelab command', link: '/engine/cli' },
            { text: 'Coverage and known gaps', link: '/engine/coverage' },
            { text: 'Block textures in the preview', link: '/engine/block_textures' },
            { text: 'Repository README ↗', link: 'https://github.com/stirante/featurelab#readme' },
          ],
        },
      ],
      '/editor/': [
        {
          text: 'Editor',
          items: [
            { text: 'Overview', link: '/editor/' },
            { text: 'The VS Code extension', link: '/editor/extension' },
            { text: 'The desktop app', link: '/editor/desktop' },
            { text: 'When the preview shows nothing', link: '/editor/preview_shows_nothing' },
          ],
        },
      ],
    },
  },

  // Redirect stubs for old routes. Written after the build so they sit in the output beside
  // the real pages; a stub is a meta-refresh to the new URL (relative to base, or absolute
  // when the target is still on GitHub).
  buildEnd(siteConfig) {
    for (const [from, to] of Object.entries(redirects)) {
      const target = /^https?:\/\//.test(to) ? to : base + to.replace(/^\//, '')
      const stub = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${target}"><link rel="canonical" href="${target}"><title>Redirecting</title><p>This page moved to <a href="${target}">${target}</a>.</p>\n`
      // Both spellings a host might resolve `/from` to: `from.html` (clean URLs on GitHub Pages)
      // and `from/index.html` (a host that only maps directories).
      fs.mkdirSync(path.join(siteConfig.outDir, from), { recursive: true })
      fs.writeFileSync(path.join(siteConfig.outDir, `${from}.html`), stub)
      fs.writeFileSync(path.join(siteConfig.outDir, from, 'index.html'), stub)
    }
  },
})
