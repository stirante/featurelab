// languageGuard.ts -- the shared vocabulary for the language guards on user-facing text.
//
// Several test files check that strings a pack author reads (hover cards, menu entries, search
// results) state what the game does in a pack author's terms. The engine side has the
// same guard in features/userfacing_strings_test.go, and its word list and patterns are READ from
// that file at test time rather than restated here, so the two surfaces cannot drift apart.
//
// The words are assembled from fragments so that searching the repository for one of them finds
// real notes and not this list.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Joins fragments into one word, so the guarded words do not match a search of the source. */
export function word(...parts: string[]): string {
  return parts.join('')
}

/** Working-note markers that must never appear in user-facing text -- the same list the Go guard holds. */
export const NOTE_WORDS: readonly string[] = [
  word('TO', 'DO'),
  word('FIX', 'ME'),
  word('X', 'XX'),
  word('HA', 'CK'),
  word('T', 'BD'),
]

/** Vocabulary specific to the editor's surfaces rather than to Go strings: words describing the
 * work behind the catalogue rather than the behaviour it documents. Additions to the Go list,
 * not a replacement for it. */
export const EXTRA_BANNED_WORDS: readonly string[] = [
  'corpus',
  word('test ', 'pack'),
  'research',
  'this pass',
  'prior pass',
  'golden baseline',
]

/** Sample inputs the guards must reject, so a guard that silently stopped matching fails loudly. */
export const REJECT_SAMPLES = {
  word: `the ${word('FIX', 'ME')} note on it`,
  hexToken: `at ${word('0', 'x')}1234ABCD5`,
} as const

/** A source-file citation, and an absolute path off a developer's machine. */
export const SOURCE_FILE_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\.(?:go|ts)\b/
export const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/])|(?:^|\s)\/(?:home|users|mnt|tmp)\//i

/** Walks up to the module root (the directory holding go.mod). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'go.mod'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('no go.mod above the test directory')
    dir = parent
  }
}

export const GO_GUARD_PATH = join(repoRoot(), 'features', 'userfacing_strings_test.go')

/** The Go guard's word list: a `banned := []string{...}` literal or a `noteWords()` function. */
function extractGoWords(source: string): string[] {
  const fn = /func\s+noteWords\(\)\s*\[\]string\s*\{\s*return\s*\[\]string\{([\s\S]*?)\}\s*\}/.exec(source)
  const literal = /banned\s*:=\s*\[\]string\{([\s\S]*?)\}/.exec(source)
  const body = fn?.[1] ?? literal?.[1]
  if (body === undefined) throw new Error(`${GO_GUARD_PATH}: no word list found -- has it been renamed?`)
  const out: string[] = []
  for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(m[1] as string)
  return out
}

/** A `<name> := regexp.MustCompile(`...`)` pattern from the Go guard; the first name found wins. */
function extractGoPattern(source: string, names: readonly string[]): RegExp {
  for (const name of names) {
    const m = new RegExp(`\\b${name}\\s*:=\\s*regexp\\.MustCompile\\(\`([^\`]*)\``).exec(source)
    if (m !== null) return new RegExp(m[1] as string)
  }
  throw new Error(`${GO_GUARD_PATH}: no ${names.join('/')} pattern found -- has it been renamed?`)
}

export interface GoGuard {
  /** The Go guard's word list. */
  words: string[]
  /** Hex or long-number tokens. */
  numberToken: RegExp
  /** Qualified names (Foo::bar). */
  qualifiedName: RegExp
}

/** Reads the vocabulary and both patterns out of features/userfacing_strings_test.go. */
export function readGoGuard(): GoGuard {
  const source = readFileSync(GO_GUARD_PATH, 'utf8')
  return {
    words: extractGoWords(source),
    numberToken: extractGoPattern(source, ['addr']),
    qualifiedName: extractGoPattern(source, ['qualifiedName', 'symbol']),
  }
}
