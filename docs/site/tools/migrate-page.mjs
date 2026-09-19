#!/usr/bin/env node
// migrate-page.mjs -- turns a docs/wiki page into a DRAFT site page, mechanically. It does the
// part of a migration that is tedious and error-prone by hand, and none of the part that needs
// judgement:
//
//   done here                                    left to the author
//   ----------------------------------------     -----------------------------------------------
//   front matter skeleton (title, game, scope)   the task-first opening
//   <VersionBadge> under the H1                  restructuring to TEMPLATE.md's section order
//   `./x.md#a` -> local page + VitePress anchor  the "Common mistakes" table
//     (or a GitHub blob URL if x has not moved)  the "How this page was checked" section
//   `./images/x.png` -> ../../wiki/images/x.png  replacing the hand-written field table with the
//   `./tools/...` -> GitHub tree/blob URL          generated include
//   the pinned "This page is a statement..."     re-reading every measured claim
//     paragraph -> removed (the badge says it)
//
// Usage:  node docs/site/tools/migrate-page.mjs <wiki page name> <site path>
//         node docs/site/tools/migrate-page.mjs single-block-feature features/single_block_feature
//
// It refuses to overwrite an existing site page. Every link whose anchor it could not map is
// listed on stderr, and left as a GitHub blob URL so the draft still builds.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { githubSlug, vitepressSlug } from './lib/anchors.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(siteDir, '..', '..')
const wikiDir = path.join(repoRoot, 'docs', 'wiki')
const BLOB = 'https://github.com/stirante/featurelab/blob/main/docs/wiki/'
const TREE = 'https://github.com/stirante/featurelab/tree/main/docs/wiki/'

const [, , wikiName, sitePath] = process.argv
if (!wikiName || !sitePath) {
  console.error('usage: migrate-page.mjs <wiki page name without .md> <site path without .md>')
  process.exit(2)
}
const src = path.join(wikiDir, `${wikiName}.md`)
const dst = path.join(siteDir, `${sitePath}.md`)
if (!fs.existsSync(src)) throw new Error(`${src} does not exist`)
if (fs.existsSync(dst)) throw new Error(`${dst} already exists; refusing to overwrite`)

const redirects = JSON.parse(fs.readFileSync(path.join(siteDir, 'redirects.json'), 'utf-8'))
/** wiki page name -> site route, for pages that have moved (their redirect entry is gone, or
 * points at a local route). Built from what exists on disk under docs/site. */
function siteRouteFor(page) {
  for (const [route, target] of Object.entries(redirects)) {
    if (target.startsWith(BLOB + page + '.md')) return undefined // still on GitHub
  }
  // Convention: the route is the type id; a guide keeps its own name. Look for either.
  const guesses = [
    `features/${page.replace(/-/g, '_')}`,
    `features/${page.replace(/-feature$/, '_feature').replace(/-/g, '_')}`,
    `engine/${page.replace(/-/g, '_')}`,
    `editor/${page.replace(/-/g, '_')}`,
  ]
  return guesses.find((g) => fs.existsSync(path.join(siteDir, `${g}.md`)))
}

/** GitHub anchor -> VitePress anchor, by finding the heading in the wiki page that GitHub's
 * rule slugs to it and re-slugging that heading's text with VitePress's rule. */
function headingsOf(page) {
  const text = fs.readFileSync(path.join(wikiDir, `${page}.md`), 'utf-8')
  const out = []
  for (const m of text.matchAll(/^#{1,6}\s+(.*)$/gm)) out.push(m[1])
  return out
}
function mapAnchor(page, anchor) {
  const heading = headingsOf(page).find((h) => githubSlug(h) === anchor)
  if (heading === undefined) return undefined
  const clean = heading.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  return vitepressSlug(clean)
}

let text = fs.readFileSync(src, 'utf-8')
const unmapped = []

// Title and the pinned-version paragraph.
const title = /^#\s+(.*)$/m.exec(text)?.[1] ?? wikiName
const isBench = /This page is about the bench, not the game|describes the \*\*bench\*\*/.test(text.slice(0, 800))
text = text.replace(/^#\s+.*$/m, `# ${title}\n\n<VersionBadge>${sitePath.startsWith('features/') ? '<CoverageBadge />' : ''}</VersionBadge>`)
text = text.replace(/\n(?:This page is a statement about \*\*Minecraft Bedrock 1\.26\.50\.24\*\*[^\n]*(?:\n(?!\n)[^\n]*)*)\n/, '\n')

// Links.
text = text.replace(/\]\((\.\/[^)\s]+)\)/g, (whole, target) => {
  const rel = target.slice(2)
  if (rel.startsWith('images/')) return `](../../wiki/${rel})`
  if (rel.startsWith('tools/')) return `](${(rel.endsWith('/') || !path.extname(rel) ? TREE : BLOB) + rel})`
  const [file, anchor] = rel.split('#')
  const page = file.replace(/\.md$/, '')
  const local = siteRouteFor(page)
  const fromDir = path.posix.dirname(sitePath)
  if (local) {
    const relPath = path.posix.relative(fromDir, local) + '.md'
    if (!anchor) return `](./${relPath.replace(/^\.\//, '')})`
    const mapped = mapAnchor(page, anchor)
    if (mapped) return `](./${relPath.replace(/^\.\//, '')}#${mapped})`
    unmapped.push(`${target} -- ${page} has a site page but no heading slugs to "${anchor}" on GitHub`)
    return `](./${relPath.replace(/^\.\//, '')})`
  }
  return `](${BLOB}${file}${anchor ? '#' + anchor : ''})`
})

const frontMatter = [
  '---',
  `title: ${title}`,
  'description: TODO one sentence for search and the meta tag',
  ...(sitePath.startsWith('features/') ? [`typeId: minecraft:${path.posix.basename(sitePath)}`, 'category: TODO content | proxy | scene | carver | guide'] : []),
  ...(isBench ? ['scope: bench'] : ['game: 1.26.50.24', 'scope: game']),
  '---',
  '',
].join('\n')

fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.writeFileSync(dst, frontMatter + text)
console.log(`wrote ${path.relative(repoRoot, dst)} (draft -- restructure to TEMPLATE.md before it is a page)`)
if (unmapped.length > 0) {
  console.error(`${unmapped.length} anchor(s) could not be mapped and were dropped to the page:`)
  for (const u of unmapped) console.error('  ' + u)
}
