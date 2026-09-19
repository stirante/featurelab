#!/usr/bin/env node
// check-template.mjs -- does every type page follow TEMPLATE.md, mechanically?
//
// TEMPLATE.md's rule is "write for the person returning a feature, not for the person writing an
// engine", and its section order is how that rule is enforced: task, example, field tables and
// mistakes first; engine internals only under an "Advanced" heading below the bench section, or
// off the page. A rule that lives only in a template is a rule the next writer skims past, so
// this reads every page with a `typeId` in its front matter and fails on:
//
//   1. a required section missing, or present in the wrong order;
//   2. an H2 where the order allows none (inside Fields, between Common mistakes and How it
//      runs, after See also), or an "Advanced" section anywhere but between the bench section
//      and See also;
//   3. a key the generated field reference knows that has no row in the page's Fields tables --
//      the tables are the summary a reader came for, and a key missing from them is a key they
//      will not find until the long-form reference at the bottom;
//   4. engine-internals language above the first Advanced heading: draw counts, draw bounds,
//      draw order, "the stream". The patterns are deliberately narrow (a page may say "twelve
//      draws are far too few" about a delegate's weighted pick, and does), so this catches the
//      phrasing that only an engine writer needs, not the word.
//
// Usage:  node docs/site/tools/check-template.mjs          (from anywhere)
// Exit 1 when any page fails. Pages without a `typeId` -- guides, engine and editor pages -- are
// not checked; TEMPLATE.md says which of them the order applies to and which are exempt.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(toolsDir, '..')

const REQUIRED = [
  { id: 'example', name: '## Start here: a complete example', test: (h) => /^Start here\b/.test(h) },
  { id: 'fields', name: '## Fields', test: (h) => h === 'Fields' },
  { id: 'mistakes', name: '## Common mistakes', test: (h) => /^Common mistakes\b/.test(h) },
  { id: 'runs', name: '## How it runs', test: (h) => /^How\b.*\bruns\b/.test(h) },
  { id: 'reference', name: '## Field reference', test: (h) => h === 'Field reference' },
  { id: 'bench', name: '## What the bench does differently', test: (h) => h === 'What the bench does differently' },
  { id: 'seealso', name: '## See also', test: (h) => h === 'See also' },
  { id: 'checked', name: '## How this page was checked', test: (h) => h === 'How this page was checked' },
]

// What an H2 that is NOT one of the required ones may be, by which required section precedes
// it. `null` means no H2 is allowed there at all.
const BETWEEN = {
  start: null, // before "Start here": the opening has no heading
  example: null, // between the example and Fields
  fields: null, // inside Fields: subsections are ###, never ##
  mistakes: null,
  runs: (h) => !isAdvanced(h), // per-topic sections
  reference: (h) => !isAdvanced(h), // version sections
  bench: (h) => isAdvanced(h), // the ONLY place an Advanced section may be
  seealso: null,
  checked: null,
}

const isAdvanced = (h) => /^Advanced\b/.test(h)

const INTERNALS = [
  /\bnextInt\w*/,
  /\b(spend|spends|spent|spending|cost|costs|costing|consume|consumes|consumed|consuming)\b[^.\n]{0,40}\bdraws?\b/i,
  /\bdraws? (nothing|zero|one|two|three|no)\b/i,
  /\b(zero|one|two|three|\d+) draws?\b(?! are far too few)/i,
  /\bdraw[- ]order\b/i,
  /\bdraw-free\b/i,
  /\bthe stream\b/i,
  /\bbounded (integer )?draw\b/i,
]

function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

/** H2 headings with line numbers, skipping fenced code. */
function headings(lines) {
  const out = []
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) return
    const m = line.match(/^## (.+?)\s*(\{#[^}]+\})?\s*$/)
    if (m) out.push({ line: i + 1, text: m[1].trim() })
  })
  return out
}

function checkPage(file, index) {
  const problems = []
  const text = fs.readFileSync(file, 'utf-8')
  const fm = frontMatter(text)
  if (!fm.typeId) return null
  const lines = text.split(/\r?\n/)
  const rel = path.relative(siteDir, file).replace(/\\/g, '/')
  const say = (line, msg) => problems.push(`${rel}:${line}: ${msg}`)

  // 1. The H1 and the badge.
  const h1 = lines.findIndex((l) => /^# /.test(l))
  if (h1 < 0) say(1, 'no `# Title` heading')
  else {
    const next = lines.slice(h1 + 1).find((l) => l.trim() !== '')
    if (!next || !/<VersionBadge/.test(next)) say(h1 + 1, 'the line after `# Title` must be the <VersionBadge>')
  }

  // 2. Required sections, in order; other H2s only where the order allows them.
  const h2 = headings(lines)
  const found = REQUIRED.map((r) => ({ ...r, at: h2.findIndex((h) => r.test(h.text)) }))
  for (const r of found) if (r.at < 0) say(0, `missing required section ${r.name}`)
  let lastAt = -1
  for (const r of found) {
    if (r.at < 0) continue
    if (r.at < lastAt) say(h2[r.at].line, `${r.name} is out of order (TEMPLATE.md's "Sections, in this order")`)
    lastAt = Math.max(lastAt, r.at)
  }
  let region = 'start'
  h2.forEach((h, i) => {
    const req = found.find((r) => r.at === i)
    if (req) {
      region = req.id
      return
    }
    const allowed = BETWEEN[region]
    if (allowed === null) {
      say(h.line, `"## ${h.text}" is not allowed here: no H2 belongs ${region === 'start' ? 'before "Start here"' : region === 'fields' ? 'inside Fields (use ###)' : `directly after "${found.find((r) => r.id === region)?.name}"`}`)
    } else if (!allowed(h.text)) {
      say(h.line, isAdvanced(h.text) ? `"## ${h.text}" must sit between "What the bench does differently" and "See also"` : `"## ${h.text}" is not allowed between the bench section and See also -- only "Advanced: …" sections go there`)
    }
  })

  // 3. Every key the generated reference knows has a row in the Fields tables.
  const entry = index[fm.typeId]
  const fieldsAt = found.find((r) => r.id === 'fields').at
  if (entry && fieldsAt >= 0) {
    const from = h2[fieldsAt].line
    const to = h2[fieldsAt + 1]?.line ?? lines.length + 1
    const fields = lines.slice(from, to - 1).join('\n')
    const anchorsFile = path.join(siteDir, 'generated', 'fields', `${entry.slug}.json`)
    if (fs.existsSync(anchorsFile)) {
      const { anchors } = JSON.parse(fs.readFileSync(anchorsFile, 'utf-8'))
      const segments = new Set(anchors.map((a) => a.path.split('.').pop()))
      for (const seg of segments) {
        const re = new RegExp('`(?:[\\w:.-]+\\.)?' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`')
        if (!re.test(fields)) say(from, `Fields has no row for \`${seg}\` (the generated reference has it -- add a row, even a one-line one)`)
      }
    }
  }

  // 4. Internals language above the first Advanced section.
  const advancedAt = h2.find((h) => isAdvanced(h.text))?.line ?? lines.length + 1
  let inFence = false
  for (let i = 0; i < advancedAt - 1; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    for (const re of INTERNALS) {
      const m = line.match(re)
      if (m) {
        say(i + 1, `engine-internals language above the Advanced section: "${m[0]}" -- move it under "## Advanced: …", or say what a pack author would act on instead`)
        break
      }
    }
  }

  return problems
}

function main() {
  const index = JSON.parse(fs.readFileSync(path.join(siteDir, 'generated', 'fields', 'index.json'), 'utf-8'))
  const pages = []
  for (const dir of ['features', 'engine', 'editor']) {
    const full = path.join(siteDir, dir)
    if (!fs.existsSync(full)) continue
    for (const name of fs.readdirSync(full)) if (name.endsWith('.md')) pages.push(path.join(full, name))
  }
  let checked = 0
  let failed = 0
  for (const file of pages.sort()) {
    const problems = checkPage(file, index)
    if (problems === null) continue
    checked++
    if (problems.length > 0) {
      failed++
      for (const p of problems) console.error(p)
    }
  }
  console.log(`check-template: ${checked} page(s) with a typeId checked, ${failed} failing`)
  if (failed > 0) process.exit(1)
}

main()
