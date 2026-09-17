// docsLanguage.test.ts -- the language guard on the hover documentation.
//
// This is deliberately a SEPARATE file from docsCatalog.test.ts, because the two failures mean
// completely different things and a maintainer should be able to tell them apart from the file name
// alone: docsCatalog failing means something is undocumented, and docsLanguage failing means
// something documented would leak.
//
// WHAT IT GUARDS. The engine side already has this guard. features/userfacing_strings_test.go scans
// every string a pack author can reach out of the Go code -- build errors, diagnostics, placement
// failures -- and fails when one of them talks about internal tooling rather than stating what the
// game does.
//
// Hover cards are a separate user-facing surface and that guard cannot see them: it walks .go files.
// So the same rule is applied here, on this side of the boundary.
//
// WHY IT READS THE GO FILE RATHER THAN RESTATING ITS LIST. Two copies of a banned-word list drift,
// and the copy that drifts is always the one nobody is looking at. So the vocabulary and both
// patterns are EXTRACTED from features/userfacing_strings_test.go at test time (see
// fixtures/languageGuard.ts): adding a word over there tightens this guard automatically, and
// renaming the variables over there fails this test loudly rather than quietly emptying it.
//
// It also mirrors that guard's last assertion, which is the one that matters most: a guard that
// silently inspected nothing looks exactly like a guard that passed.

import { describe, expect, it } from 'vitest'
import { allDocEntries } from '../src/graph/docs/catalog'
import {
  ABSOLUTE_PATH_PATTERN,
  EXTRA_BANNED_WORDS,
  REJECT_SAMPLES,
  SOURCE_FILE_PATTERN,
  TOOLING_WORDS,
  readGoGuard,
  word,
} from './fixtures/languageGuard'

// ---------------------------------------------------------------------------
// The vocabulary, read from the Go guard
// ---------------------------------------------------------------------------

// Tooling words that must never appear in user-facing text, plus the hex-token and qualified-name
// patterns, all read out of the Go guard. EXTRA_BANNED_WORDS adds the vocabulary specific to this
// surface -- additions, not a replacement.
const GO_GUARD = readGoGuard()
const BANNED_WORDS = GO_GUARD.words
const ADDRESS_PATTERN = GO_GUARD.address
const SYMBOL_PATTERN = GO_GUARD.qualifiedName

// ---------------------------------------------------------------------------
// The strings under guard
// ---------------------------------------------------------------------------

interface Scanned {
  location: string
  text: string
}

function scannedStrings(): Scanned[] {
  const out: Scanned[] = []
  for (const { location, entry } of allDocEntries()) {
    out.push({ location: `${location} (summary)`, text: entry.summary })
    if (entry.detail !== undefined) out.push({ location: `${location} (detail)`, text: entry.detail })
  }
  return out
}

const SCANNED = scannedStrings()

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('the guard is looking at something', () => {
  it('found the Go guard and read a real vocabulary out of it', () => {
    expect(BANNED_WORDS.length).toBeGreaterThanOrEqual(5)
    // Anchors. If the Go list is rewritten these may legitimately change, but a list that no longer
    // contains any of them is a list this test has stopped mirroring.
    expect(BANNED_WORDS).toContain(TOOLING_WORDS[0])
    expect(BANNED_WORDS).toContain(word('v', 'table'))
    expect(ADDRESS_PATTERN.source.length).toBeGreaterThan(10)
    expect(SYMBOL_PATTERN.source).toContain('::')
  })

  it('is scanning the whole catalogue and not an empty list', () => {
    // The Go guard fails when it parsed fewer than 50 files, for exactly this reason: a sweep that
    // quietly stops finding things is indistinguishable from a clean run.
    expect(SCANNED.length).toBeGreaterThanOrEqual(200)
    expect(SCANNED.every((s) => s.text.length > 0)).toBe(true)
  })

  it('actually rejects the things it is meant to reject', () => {
    // A guard nobody has seen fail is a guard nobody knows works. These are the four shapes the
    // real thing looks for, checked against the matchers this file will use on the catalogue.
    expect(BANNED_WORDS.some((w) => REJECT_SAMPLES.word.includes(w))).toBe(true)
    expect(ADDRESS_PATTERN.test(REJECT_SAMPLES.hexToken)).toBe(true)
    expect(ADDRESS_PATTERN.test(`offset ${'1234'}567`)).toBe(true)
    expect(SYMBOL_PATTERN.test('ScatterFeature::place')).toBe(true)
    expect(SOURCE_FILE_PATTERN.test('see distribution.go')).toBe(true)
    expect(ABSOLUTE_PATH_PATTERN.test('C:\\some\\path')).toBe(true)
    // And does not reject ordinary documentation prose.
    expect(ADDRESS_PATTERN.test('an extent of [0, 4] produces 0, 1, 2 or 3')).toBe(false)
    expect(SYMBOL_PATTERN.test('variable.worldx is written after each axis')).toBe(false)
    expect(SOURCE_FILE_PATTERN.test('the block one below the origin')).toBe(false)
  })
})

describe('hover strings state behaviour only', () => {
  it('uses none of the banned vocabulary', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      for (const word of [...BANNED_WORDS, ...EXTRA_BANNED_WORDS]) {
        if (text.includes(word)) leaks.push(`${location}: contains ${JSON.stringify(word)}`)
      }
    }
    expect(
      leaks,
      'a hover card must say what the engine DOES, never how that was established. Rewrite the\n' +
        'sentence in terms of the behaviour an author can see.',
    ).toEqual([])
  })

  it('carries no address-shaped token', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      const hit = ADDRESS_PATTERN.exec(text)
      if (hit !== null) leaks.push(`${location}: contains the address-shaped token ${JSON.stringify(hit[0])}`)
    }
    expect(leaks, 'state the behaviour alone; a pack author has nothing to do with a number of this shape.').toEqual([])
  })

  it('names no engine symbol', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      const hit = SYMBOL_PATTERN.exec(text)
      if (hit !== null) leaks.push(`${location}: names the symbol ${JSON.stringify(hit[0])}`)
    }
    expect(
      leaks,
      'describe the behaviour instead -- a pack author cannot look such a name up, and naming it\n' +
        'says how the behaviour was established rather than what it is.',
    ).toEqual([])
  })

  it('cites no source file and no path off this machine', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      const file = SOURCE_FILE_PATTERN.exec(text)
      if (file !== null) leaks.push(`${location}: cites the source file ${JSON.stringify(file[0])}`)
      const path = ABSOLUTE_PATH_PATTERN.exec(text)
      if (path !== null) leaks.push(`${location}: contains the path ${JSON.stringify(path[0])}`)
    }
    expect(leaks, 'a hover card ships to people who have none of these files.').toEqual([])
  })
})
