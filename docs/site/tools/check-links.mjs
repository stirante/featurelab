#!/usr/bin/env node
// check-links.mjs -- verifies every link and anchor across the site's pages, in the site's own
// terms: VitePress's slug rule, `<!--@include: -->` fragments expanded, page routes resolved the
// way .vitepress/config.mts rewrites them. The docs/wiki/tools/check-links.mjs it descends from
// keeps checking docs/wiki with GitHub's rule until the last page has moved; the two run side by
// side in CI and neither knows about the other's pages.
//
// Usage:  node docs/site/tools/check-links.mjs [--verify-dist]
//
//   --verify-dist   after `vitepress build`, also read every id="..." out of .vitepress/dist and
//                   fail if an anchor this script computed for a page is not one VitePress wrote.
//                   That is the proof that lib/anchors.mjs's port of the slugifier is exact;
//                   without it a drifted port would report links resolving that do not.
//
// What is checked, per page (every .md under docs/site outside node_modules, .vitepress and
// generated/, minus the authoring documents the config excludes from the build):
//   - a relative link to a .md page: the file exists, and its anchor (if any) is one the target
//     defines once its includes are expanded
//   - a site-absolute link (`/features/x`): resolved against the rewrites to a page file
//   - a `#fragment` link: an anchor on this page
//   - an image or other file: exists on disk (this is how a page reaching into
//     ../../wiki/images/ is kept honest against the image pipeline's output)
//   - a GitHub blob link into this repository: the path exists in the tree; and if it names a
//     docs/wiki page that HAS a site page now (redirects.json says which have not), it fails,
//     because a migrated page must be linked locally
//   - every `<!--@include: -->` target exists
// Plus the sidebar: every local link and every wiki('..', 'page') entry in config.mts resolves.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorsOf, expandIncludes, githubSlug, pageAnchors } from './lib/anchors.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(siteDir, '..', '..')
const verifyDist = process.argv.includes('--verify-dist')

const EXCLUDED = new Set(['authoring.md', 'TEMPLATE.md', 'README.md'])
const REPO_BLOB = /^https:\/\/github\.com\/stirante\/featurelab\/blob\/[^/]+\/([^#?]+)(?:#(.*))?$/

function listPages(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.vitepress', 'generated', '.cache', 'tools'].includes(entry.name)) continue
      listPages(p, out)
    } else if (entry.name.endsWith('.md') && !(dir === siteDir && EXCLUDED.has(entry.name))) {
      out.push(p)
    }
  }
  return out
}

/** A site route (`features/scatter_feature`, `features/`, `engine`) to the page file that
 * produces it, mirroring config.mts's rewrites and VitePress's own index rule. */
function routeToFile(route) {
  const clean = route.replace(/^\//, '').replace(/\/$/, '').replace(/\.html$/, '')
  const candidates = clean === '' ? ['index.md'] : [`${clean}.md`, path.join(clean, 'index.md')]
  for (const c of candidates) {
    const f = path.join(siteDir, c)
    if (fs.existsSync(f)) return f
  }
  return undefined
}

const redirects = JSON.parse(fs.readFileSync(path.join(siteDir, 'redirects.json'), 'utf-8'))
/** docs/wiki page name -> true when redirects.json still points its site route at GitHub, i.e.
 * the page has not migrated and a blob link to it is the right link. */
const unmigrated = new Set()
for (const target of Object.values(redirects)) {
  const m = REPO_BLOB.exec(target)
  if (m && m[1].startsWith('docs/wiki/')) unmigrated.add(m[1])
}

const problems = []
const anchorCache = new Map()
const anchorsFor = (file) => {
  if (!anchorCache.has(file)) anchorCache.set(file, pageAnchors(file))
  return anchorCache.get(file)
}
let linkCount = 0

function checkLink(page, raw, line) {
  const where = `${path.relative(repoRoot, page)}:${line}`
  const target = raw.trim().replace(/^<|>$/g, '')
  if (target.startsWith('mailto:')) return
  if (/^https?:\/\//.test(target)) {
    const m = REPO_BLOB.exec(target)
    if (!m) return // an external link; not this script's business
    linkCount++
    const [, repoPath, anchor] = m
    const onDisk = path.join(repoRoot, repoPath)
    if (!fs.existsSync(onDisk)) {
      problems.push(`${where}  ${target}  -- not in this repository`)
      return
    }
    if (repoPath.startsWith('docs/wiki/') && repoPath.endsWith('.md')) {
      if (!unmigrated.has(repoPath)) {
        problems.push(`${where}  ${target}  -- this wiki page has a site page now (redirects.json no longer points at GitHub); link it locally`)
      }
      if (anchor && !anchorsOf(fs.readFileSync(onDisk, 'utf-8'), 'github').has(anchor)) {
        problems.push(`${where}  ${target}  -- no heading on that wiki page slugs to "${anchor}" under GitHub's rule`)
      }
    }
    return
  }
  linkCount++
  const [pathPart, anchor] = target.split('#')
  if (pathPart === '') {
    if (!anchorsFor(page).has(anchor)) problems.push(`${where}  #${anchor}  -- no heading on this page has that anchor`)
    return
  }
  let file
  if (pathPart.startsWith('/')) {
    file = routeToFile(pathPart)
    if (!file) {
      problems.push(`${where}  ${target}  -- no page produces that route`)
      return
    }
  } else {
    const resolved = path.resolve(path.dirname(page), pathPart)
    if (pathPart.endsWith('.md')) file = resolved
    else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) file = path.join(resolved, 'index.md')
    else if (fs.existsSync(resolved)) return // an image or another file, present
    else file = resolved.endsWith('/') ? path.join(resolved, 'index.md') : `${resolved}.md`
    if (!fs.existsSync(file)) {
      problems.push(`${where}  ${target}  -- file does not exist`)
      return
    }
  }
  if (anchor !== undefined && anchor !== '' && !anchorsFor(file).has(anchor)) {
    problems.push(`${where}  ${target}  -- ${path.relative(siteDir, file)} has no anchor "${anchor}"`)
  }
}

const pages = listPages(siteDir)
for (const page of pages) {
  const raw = fs.readFileSync(page, 'utf-8')
  // Include targets must exist; then links are checked over the EXPANDED text, so a link inside
  // a generated fragment is checked in the context of the page that includes it.
  for (const m of raw.matchAll(/<!--\s*@include:\s*([^\s>]+)\s*-->/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(page), m[1]))) {
      problems.push(`${path.relative(repoRoot, page)}  @include ${m[1]}  -- file does not exist`)
    }
  }
  const { text } = expandIncludes(page, raw)
  let inFence = false
  text.split('\n').forEach((lineText, i) => {
    if (/^\s*(```|~~~)/.test(lineText)) inFence = !inFence
    if (inFence) return
    for (const m of lineText.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) checkLink(page, m[1], i + 1)
  })
}

// The sidebar and nav in config.mts.
const config = fs.readFileSync(path.join(siteDir, '.vitepress', 'config.mts'), 'utf-8')
for (const m of config.matchAll(/wiki\('[^']*',\s*'([^']+)'\)/g)) {
  linkCount++
  if (!fs.existsSync(path.join(repoRoot, 'docs', 'wiki', `${m[1]}.md`))) {
    problems.push(`.vitepress/config.mts  wiki(.., '${m[1]}')  -- docs/wiki/${m[1]}.md does not exist`)
  }
}
for (const m of config.matchAll(/link:\s*'(\/[^']*)'/g)) {
  linkCount++
  if (!routeToFile(m[1])) problems.push(`.vitepress/config.mts  link ${m[1]}  -- no page produces that route`)
}

// --verify-dist: the slug port against what VitePress wrote.
if (verifyDist) {
  const dist = path.join(siteDir, '.vitepress', 'dist')
  if (!fs.existsSync(dist)) {
    problems.push('--verify-dist: .vitepress/dist does not exist; run `vitepress build` first')
  } else {
    let checked = 0
    for (const page of pages) {
      const route = path.relative(siteDir, page).replace(/\\/g, '/').replace(/\.md$/, '')
      const html = [path.join(dist, route, 'index.html'), path.join(dist, `${route}.html`)].find((f) => fs.existsSync(f))
      if (!html) {
        problems.push(`--verify-dist: no built HTML for ${route}`)
        continue
      }
      const built = new Set([...fs.readFileSync(html, 'utf-8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
      for (const id of anchorsFor(page)) {
        checked++
        if (!built.has(id)) problems.push(`--verify-dist: ${route} -- computed anchor "${id}" is not an id in the built HTML`)
      }
    }
    console.log(`docs/site: --verify-dist compared ${checked} computed anchors against the built HTML`)
  }
}

if (problems.length > 0) {
  console.error(`docs/site: ${problems.length} broken link(s) of ${linkCount}:\n`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(`docs/site: ${linkCount} links across ${pages.length} pages (includes expanded), all resolving`)
