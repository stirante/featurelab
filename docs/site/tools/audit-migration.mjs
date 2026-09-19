#!/usr/bin/env node
// audit-migration.mjs -- did a migrated page keep the wiki page's measured claims?
//
// The wiki's rigour lives in its numbers and its literals: "3,229 cells", "seed 42", "(-16, 5)",
// `nextInt(half + 1)`, `extent: [5, 5]`. A restyle that reads well and quietly drops one of them
// is the failure mode this project cares about most, and a diff cannot show it once the page has
// been restructured. So this compares the SETS: every number token and every inline code span in
// the wiki page must appear somewhere in the site page (includes expanded). It is deliberately
// insensitive to order and prose.
//
// Usage:  node docs/site/tools/audit-migration.mjs <wiki page name> <site path>
//         node docs/site/tools/audit-migration.mjs scatter-feature features/scatter_feature
//
// Exit 1 when something is missing. A missing item is not always wrong -- a number in a sentence
// the author deliberately cut, a code span that moved into the generated field reference under a
// different spelling -- so the output is a list to read, not a verdict; but every item on it was
// a claim once, and dropping it should be a decision.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandIncludes } from './lib/anchors.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(siteDir, '..', '..')

const [, , wikiName, sitePath] = process.argv
if (!wikiName || !sitePath) {
  console.error('usage: audit-migration.mjs <wiki page name> <site path>')
  process.exit(2)
}
const wiki = fs.readFileSync(path.join(repoRoot, 'docs', 'wiki', `${wikiName}.md`), 'utf-8')
const siteFile = path.join(siteDir, `${sitePath}.md`)
const site = expandIncludes(siteFile, fs.readFileSync(siteFile, 'utf-8')).text

const strip = (s) => s.replace(/\]\([^)]*\)/g, ']').replace(/^---[\s\S]*?---/, '')
// A number token is digits with optional thousands separators and a fraction: `3,229`, `0.35`,
// `42`. A comma followed by fewer than three digits is list punctuation, not part of the number.
const numbers = (s) => new Set([...strip(s).matchAll(/(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w])/g)].map((m) => m[0]).filter((n) => !['0', '1', '2', '3', '4'].includes(n)))
const spans = (s) => new Set([...strip(s).matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()))

const missingNumbers = [...numbers(wiki)].filter((n) => !site.includes(n))
const missingSpans = [...spans(wiki)].filter((c) => !site.includes(c))

console.log(`${wikiName} -> ${sitePath}: ${numbers(wiki).size} number tokens, ${spans(wiki).size} code spans in the wiki page`)
if (missingNumbers.length) console.log(`  numbers not found on the site page: ${missingNumbers.join(', ')}`)
if (missingSpans.length) {
  console.log(`  code spans not found on the site page:`)
  for (const c of missingSpans) console.log(`    \`${c}\``)
}
if (missingNumbers.length === 0 && missingSpans.length === 0) console.log('  every number and code span carried over')
process.exitCode = missingNumbers.length + missingSpans.length > 0 ? 1 : 0
