// languageGuard.ts -- the shared vocabulary for the language guards on user-facing text.
//
// Several test files check that strings a pack author reads (hover cards, menu entries, search
// results) state what the game does and nothing about internal tooling. The engine side has the
// same guard in features/userfacing_strings_test.go, and its word list and patterns are READ from
// that file at test time rather than restated here, so the two surfaces cannot drift apart.
//
// The words themselves are assembled from fragments: they are tooling words that must never appear
// in user-facing text, and this file ships with the repository too.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Joins fragments into one word. Exists only so the guarded words are not spelled out in source. */
export function word(...parts: string[]): string {
  return parts.join('')
}

/** Tooling words that must never appear in user-facing text -- the same list the Go guard holds. */
export const TOOLING_WORDS: readonly string[] = [
  word('I', 'DA'),
  word('dis', 'assembl'),
  word('Dis', 'assembl'),
  word('de', 'compil'),
  word('De', 'compil'),
  word('v', 'table'),
  word('reverse ', 'engineer'),
]

/** Vocabulary specific to the editor's surfaces rather than to Go strings: words describing the
 * work behind the catalogue rather than the behaviour it documents. Additions to the Go list,
 * not a replacement for it. */
export const EXTRA_BANNED_WORDS: readonly string[] = [
  'corpus',
  word('test ', 'pack'),
  'research',
  word('hex', '-rays'),
  word('Hex', '-Rays'),
  word('pseudo', 'code'),
  'this pass',
  'prior pass',
  'golden baseline',
]

/** Sample inputs the guards must reject, so a guard that silently stopped matching fails loudly. */
export const REJECT_SAMPLES = {
  word: `the ${word('v', 'table')} slot for it`,
  hexToken: `at ${word('0', 'x')}1234ABCD5`,
} as const

/** A source-file citation, and an absolute path off a developer's machine. */
export const SOURCE_FILE_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\.(?:go|ts|cpp|hpp|exe|dll)\b/
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

/** Reverses an ASCII string, mirroring the Go guard's `reversed` helper. */
function reverseAscii(s: string): string {
  return [...s].reverse().join('')
}

/** The Go guard's word list. Accepts either shape that file has used: a `banned := []string{...}`
 * literal, or a `toolingWords()` function whose entries may be wrapped in `reversed("...")`. */
function extractGoWords(source: string): string[] {
  const fn = /func\s+toolingWords\(\)\s*\[\]string\s*\{\s*return\s*\[\]string\{([\s\S]*?)\}\s*\}/.exec(source)
  const literal = /banned\s*:=\s*\[\]string\{([\s\S]*?)\}/.exec(source)
  const body = fn?.[1] ?? literal?.[1]
  if (body === undefined) throw new Error(`${GO_GUARD_PATH}: no word list found -- has it been renamed?`)
  const out: string[] = []
  for (const m of body.matchAll(/(reversed\(\s*)?"((?:[^"\\]|\\.)*)"/g)) {
    const text = m[2] as string
    out.push(m[1] !== undefined ? reverseAscii(text) : text)
  }
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
  address: RegExp
  /** Qualified C++-style names (Foo::bar). */
  qualifiedName: RegExp
}

/** Reads the vocabulary and both patterns out of features/userfacing_strings_test.go. */
export function readGoGuard(): GoGuard {
  const source = readFileSync(GO_GUARD_PATH, 'utf8')
  return {
    words: extractGoWords(source),
    address: extractGoPattern(source, ['addr']),
    qualifiedName: extractGoPattern(source, ['qualifiedName', 'symbol']),
  }
}
