#!/usr/bin/env node
// check-product-links.mjs -- the product -> docs direction. A diagnostic, a README, a hover card
// or a Marketplace listing that points at a documentation page is a promise the docs have to
// keep, and renaming a page keeps it silently broken: the link is still blue, and it 404s. This
// makes that a build failure instead.
//
// Usage:  node docs/site/tools/check-product-links.mjs
//
// Scans every tracked file outside docs/ (git ls-files, so ignored and untracked files are not
// read) for three kinds of reference, and fails on any that does not resolve:
//
//   1. https://github.com/stirante/featurelab/blob/<ref>/<path>[#anchor]
//        The path exists in the tree, and it is not a docs/wiki markdown page. Those 33 pages
//        are the documentation's old home; every one of them migrated to docs/site and was
//        deleted at the cut-over, so a blob link to one is a link the product ships broken. It
//        was a warning while they still existed and is an ERROR now.
//   2. https://stirante.github.io/featurelab/<route>[#anchor]
//        The route is a page under docs/site (or an entry in redirects.json), and the anchor is
//        one the page defines under VITEPRESS's rule, includes expanded.
//   3. A relative markdown link to docs/wiki/*.md or docs/site/*.md from a README
//        (apps/desktop/README.md does this today): the file exists and the anchor resolves.
//
// And one contract check that does not depend on any link existing yet:
//
//   4. Every feature type the engine registers (generated/coverage.json, i.e. `featurelab types
//      --json`) has a site route: docs/site/features/<typeId minus "minecraft:">.md exists, or
//      redirects.json maps that route to another SITE route that exists. This is what lets the editor's `?`
//      pane and the engine's diagnostics build a link from a type id alone and be sure it lands.
//      The route for a rule file is features/feature_rules (its root key), the one alias.
//
// The field-anchor half of that contract -- /features/<type>#<path with non-[A-Za-z0-9_-] as ->
// -- is checked when a product link actually uses one (case 2), against generated/fields/*.json.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorsOf, pageAnchors } from './lib/anchors.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(siteDir, '..', '..')

const SITE_ORIGIN = 'https://stirante.github.io/featurelab/'
const REPO_BLOB = /https:\/\/github\.com\/stirante\/featurelab\/blob\/[^/\s"'`)]+\/([^\s"'`)#]+)(?:#([^\s"'`)]*))?/g
const SITE_URL = /https:\/\/stirante\.github\.io\/featurelab\/([^\s"'`)#]*)(?:#([^\s"'`)]*))?/g
const REL_DOC = /\]\(((?:\.\.\/)+docs\/(?:wiki|site)\/[^)\s#]+\.md)(?:#([^)\s]*))?\)/g

const redirects = JSON.parse(fs.readFileSync(path.join(siteDir, 'redirects.json'), 'utf-8'))

function routeToFile(route) {
  // A redirect target may carry a fragment (`engine/coverage#type-coverage`): the stub keeps it,
  // but the page it names is the part before the `#`.
  const clean = route.replace(/#.*$/, '').replace(/^\//, '').replace(/\/$/, '').replace(/\.html$/, '')
  const candidates = clean === '' ? ['index.md'] : [`${clean}.md`, path.join(clean, 'index.md')]
  for (const c of candidates) {
    const f = path.join(siteDir, c)
    if (fs.existsSync(f)) return f
  }
  return undefined
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf-8' })
  .split('\0')
  .filter((f) => f && !f.startsWith('docs/') && !f.startsWith('research/') && /\.(ts|js|mjs|go|md|json|yml|yaml|vue|html)$/.test(f))

const problems = []
let refs = 0

function checkAnchorOnSitePage(file, anchor, where, url) {
  if (!anchor) return
  if (!pageAnchors(file).has(anchor)) problems.push(`${where}  ${url}  -- ${path.relative(siteDir, file)} has no anchor "${anchor}"`)
}

for (const rel of files) {
  const abs = path.join(repoRoot, rel)
  let text
  try {
    text = fs.readFileSync(abs, 'utf-8')
  } catch {
    continue
  }
  const lineOf = (index) => text.slice(0, index).split('\n').length

  for (const m of text.matchAll(REPO_BLOB)) {
    refs++
    const [url, repoPath] = m
    const where = `${rel}:${lineOf(m.index)}`
    const onDisk = path.join(repoRoot, repoPath)
    if (!fs.existsSync(onDisk)) {
      problems.push(`${where}  ${url}  -- ${repoPath} is not in this repository`)
      continue
    }
    if (repoPath.startsWith('docs/wiki/') && repoPath.endsWith('.md')) {
      // An ERROR since the cut-over. It was a warning for as long as the wiki page still existed
      // -- the link worked, and retargeting the READMEs one page at a time would have churned
      // them thirty-three times -- but every page has moved and been deleted, so a blob link to
      // one is a 404 the moment it ships. The existence check above catches a link to a page
      // that is gone; this catches one to a path somebody restored or spelled speculatively, and
      // says what to write instead.
      problems.push(`${where}  ${url}  -- docs/wiki carries no pages; link ${SITE_ORIGIN}features/<type id minus minecraft:> instead`)
    }
  }

  for (const m of text.matchAll(SITE_URL)) {
    refs++
    const [url, route, anchor] = m
    const where = `${rel}:${lineOf(m.index)}`
    const file = routeToFile(route)
    if (file) {
      checkAnchorOnSitePage(file, anchor, where, url)
      continue
    }
    const key = route.replace(/\/$/, '')
    if (redirects[key] !== undefined) continue // lands on a redirect stub, which is a page
    problems.push(`${where}  ${url}  -- no site page or redirect for route "${route}"`)
  }

  for (const m of text.matchAll(REL_DOC)) {
    refs++
    const [, relTarget, anchor] = m
    const where = `${rel}:${lineOf(m.index)}`
    const file = path.resolve(path.dirname(abs), relTarget)
    if (!fs.existsSync(file)) {
      problems.push(`${where}  ${relTarget}  -- file does not exist`)
      continue
    }
    if (anchor) {
      const rule = file.includes(`${path.sep}wiki${path.sep}`) ? 'github' : 'vitepress'
      if (!anchorsOf(fs.readFileSync(file, 'utf-8'), rule).has(anchor)) {
        problems.push(`${where}  ${relTarget}#${anchor}  -- no heading slugs to that anchor`)
      }
    }
  }
}

// 4. The type-id contract.
const coverage = JSON.parse(fs.readFileSync(path.join(siteDir, 'generated', 'coverage.json'), 'utf-8'))
const TYPE_ALIASES = { 'minecraft:feature_rule': 'minecraft:feature_rules' }
const typeIds = [...coverage.types.map((t) => t.typeId), 'minecraft:feature_rules']
let contractOk = 0
for (const typeId of typeIds) {
  const route = 'features/' + (TYPE_ALIASES[typeId] ?? typeId).replace(/^minecraft:/, '')
  if (routeToFile(route)) {
    contractOk++
    continue
  }
  const target = redirects[route]
  if (target === undefined) {
    problems.push(`type contract: ${typeId} -- no page at docs/site/${route}.md and no redirects.json entry for "${route}"`)
    continue
  }
  // Every redirect target is a SITE route now. While the migration was running, a route could
  // redirect to the page's GitHub blob URL instead -- that is what "has not migrated yet" meant,
  // and what told both link checkers to leave a product blob link alone. The cut-over deleted
  // the last of those pages, so an off-site target is a redirect to nothing and is rejected here
  // rather than discovered by a reader.
  if (/^https?:\/\//.test(target)) {
    problems.push(`type contract: ${typeId} -- redirects.json sends "${route}" off-site, to ${target}; a redirect target is a site route`)
    continue
  }
  if (!routeToFile(target)) {
    problems.push(`type contract: ${typeId} -- redirects.json sends "${route}" to "${target}", which is not a site page`)
    continue
  }
  contractOk++
}

if (problems.length > 0) {
  console.error(`product -> docs: ${problems.length} problem(s) across ${refs} reference(s):\n`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(`product -> docs: ${refs} reference(s) in ${files.length} tracked files resolve; ${contractOk}/${typeIds.length} type ids have a route`)
