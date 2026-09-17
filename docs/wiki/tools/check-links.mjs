// check-links.mjs -- verifies every relative link and every heading anchor across docs/wiki.
//
// Usage: node docs/wiki/tools/check-links.mjs        (exits non-zero on the first broken link)
//
// This exists because the set has 276 relative links across 29 pages and a broken one is
// invisible: the text still reads correctly, the link is still blue, and it lands on the top of
// the page instead of the section it names. Two anchors in this set were spelled `#...-1-26-50`
// while the other 274 used GitHub's own convention, and nothing noticed for weeks.
//
// The slug rule below IS GitHub's, and the details matter more than they look:
//   - dots are DELETED, not turned into hyphens, so `1.26.50` becomes `12650`
//   - each space becomes exactly one hyphen, with NO collapsing, so a heading containing an em
//     dash (` -- ` surrounded by spaces) leaves a DOUBLE hyphen behind once the dash is dropped
// Getting either of those wrong makes this script report ~13 false failures on a clean tree,
// which was the first thing it did. If you are about to "fix" a link this script rejects, check
// the rule against the real heading first.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const wikiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replaceAll(' ', '-')
}

const pages = readdirSync(wikiDir).filter((f) => f.endsWith('.md'))
const anchors = new Map()
const texts = new Map()
for (const page of pages) {
  const text = readFileSync(path.join(wikiDir, page), 'utf-8')
  texts.set(page, text)
  const set = new Set()
  for (const m of text.matchAll(/^#{1,6}\s+(.*)$/gm)) set.add(slug(m[1]))
  anchors.set(page, set)
}

const problems = []
let linkCount = 0
for (const page of pages) {
  const text = texts.get(page)
  for (const m of text.matchAll(/\]\((\.\/[^)\s]+)\)/g)) {
    linkCount++
    const target = m[1].slice(2)
    const [file, anchor] = target.split('#')
    const line = text.slice(0, m.index).split('\n').length
    const where = `${page}:${line}`
    if (file) {
      const onDisk = path.join(wikiDir, file)
      try {
        readdirSync(path.dirname(onDisk)).includes(path.basename(onDisk)) ||
          problems.push(`${where}  ${target}  -- file does not exist`)
      } catch {
        problems.push(`${where}  ${target}  -- directory does not exist`)
        continue
      }
      if (anchor && file.endsWith('.md')) {
        const known = anchors.get(path.basename(file))
        if (!known) problems.push(`${where}  ${target}  -- links into a file outside docs/wiki`)
        else if (!known.has(anchor)) problems.push(`${where}  ${target}  -- no heading slugs to "${anchor}"`)
      }
    } else if (anchor && !anchors.get(page).has(anchor)) {
      problems.push(`${where}  #${anchor}  -- no heading on this page slugs to it`)
    }
  }
}

if (problems.length > 0) {
  console.error(`docs/wiki: ${problems.length} broken link(s) of ${linkCount}:\n`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(`docs/wiki: ${linkCount} relative links across ${pages.length} pages, all resolving`)
