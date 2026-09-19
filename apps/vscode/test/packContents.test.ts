// packContents.test.ts -- the numbers and the sentences the host says about a loaded pack.
//
// THE BUG THIS IS ABOUT had a number in front of it, which is worse than no message at all. A
// pack with one truncated feature file used to report `featureCount: 56` -- the same reassuring
// figure as the same pack with the file intact -- because the count meant "files found on disk".
// The feature was gone, the panel said nothing, the canvas said nothing, and the only thing that
// knew was a diagnostic nobody saw until they ran a generate and read past three unrelated
// paragraphs about other people's files.
//
// The engine now sends both numbers (`featureCount` = what BUILT, `fileCounts.features` = what
// was READ) and the pack-scoped diagnostics that explain the gap, each with a pack-relative path
// and a 1-based line/column. This file pins what the host does with that pair: the honest
// phrasing ("55 of 56"), the naming of the files with their positions, and the split that keeps a
// preview's own explanation above the pack's standing problems instead of under them.
//
// A pure module, so no vscode mock and no panel: these are sentences, asserted as sentences.
import { describe, expect, it } from 'vitest'

import {
  PACK_WIDE_FILE_ID,
  brokenFiles,
  describeBrokenFiles,
  describeEmptyGraphKinds,
  describeFilesLoaded,
  describePackContents,
  diagnosticLocation,
  isPackScoped,
  isRunScoped,
  nameBrokenFiles,
  packWideSummary,
  readAnyFiles,
  scopedForPreview,
  type PackDiagnosticLike,
} from '../src/packContents.js'

/** What the engine reports for a feature file that was cut off mid-write -- the exact shape and
 * the exact message, position in the prose AND in the structured fields. */
const TRUNCATED: PackDiagnosticLike = {
  level: 'error',
  fileId: 'features/poplar_tree.json',
  scope: 'pack',
  line: 4,
  column: 57,
  message: 'invalid JSON at line 4, column 57: unexpected end of JSON input',
}

/** A file that LOADED and has something odd about it. Not a broken file, and the difference
 * matters: one of these sends nobody anywhere. */
const ODD: PackDiagnosticLike = {
  level: 'warning',
  fileId: 'features/pumpkin_patch.json',
  scope: 'pack',
  message: 'places_block[0] carries a directional state, which this preview draws unrotated',
}

/** A placement this run declined. Scope "run": the file is fine. */
const REFUSED_PLACEMENT: PackDiagnosticLike = {
  level: 'error',
  fileId: 'wiki:pumpkin_patch',
  scope: 'run',
  message: 'iterations evaluated to zero, so nothing was placed',
}

describe('where a diagnostic is', () => {
  it('prints line and column when the loader knew both', () => {
    expect(diagnosticLocation(TRUNCATED)).toBe('features/poplar_tree.json 4:57')
  })

  it('prints the line alone when that is all there is', () => {
    expect(diagnosticLocation({ level: 'error', fileId: 'features/a.json', line: 9, message: 'x' })).toBe('features/a.json 9')
  })

  it('prints the bare file when there is no single place to point at', () => {
    // Most diagnostics. A refused placement is about a feature, not about a character, and
    // inventing a 1:1 for it would put a squiggle on somebody's opening brace.
    expect(diagnosticLocation(REFUSED_PLACEMENT)).toBe('wiki:pumpkin_patch')
  })

  it('ignores a zero line, which is how the engine spells "no position"', () => {
    // `omitempty` on the Go side means a zero never reaches the wire -- but a hand-built object,
    // an older engine, or a JSON round trip through something less careful can produce one, and
    // 0 decremented to a 0-based line is line -1.
    expect(diagnosticLocation({ level: 'error', fileId: 'features/a.json', line: 0, column: 0, message: 'x' })).toBe('features/a.json')
  })
})

describe('which files are broken', () => {
  it('counts errors and not warnings', () => {
    expect(brokenFiles([TRUNCATED, ODD]).map((d) => d.fileId)).toEqual(['features/poplar_tree.json'])
  })

  it('counts one file once however many diagnostics it raised', () => {
    const second: PackDiagnosticLike = { ...TRUNCATED, line: undefined, column: undefined, message: 'nothing in this file built' }
    expect(brokenFiles([TRUNCATED, second])).toHaveLength(1)
    // And it keeps the FIRST, which is where reading actually stopped -- the one with the position.
    expect(brokenFiles([TRUNCATED, second])[0]!.line).toBe(4)
  })

  it('does not count a refused placement as a broken file', () => {
    expect(brokenFiles([REFUSED_PLACEMENT])).toEqual([])
  })

  it('answers [] for an engine that sent no diagnostics at all', () => {
    expect(brokenFiles(undefined)).toEqual([])
    expect(nameBrokenFiles(undefined)).toBe('')
    expect(describeBrokenFiles(undefined)).toBeNull()
  })

  it('names the file AND the position, because a count on its own is the old silence', () => {
    expect(describeBrokenFiles([TRUNCATED])).toBe('1 file(s) in this pack could not be read: features/poplar_tree.json 4:57.')
  })

  it('names the first few and then says how many more', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...TRUNCATED, fileId: `features/b${String(i)}.json` }))
    const said = describeBrokenFiles(many)
    expect(said).toContain('6 file(s)')
    expect(said).toContain('features/b0.json 4:57')
    expect(said).toContain('and 2 more')
    // The COUNT is exact even though the naming is capped -- a capped count would be a second
    // number nobody can reconcile with the list beside it.
    expect(said).not.toContain('4 file(s)')
  })
})

describe('how many files loaded', () => {
  it('says "55 of 56" when a file failed', () => {
    expect(describeFilesLoaded('feature', 55, 56)).toBe('55 of 56 feature file(s) loaded')
  })

  it('says one number when nothing failed', () => {
    // "56 of 56" invites the reader to look for the missing one.
    expect(describeFilesLoaded('feature', 56, 56)).toBe('56 feature file(s) loaded')
  })

  it('says one number for an engine that does not send fileCounts', () => {
    // It never invents the gap: an absent second number is "this engine did not say", and the
    // sentence is exactly the one the host gave before the field existed.
    expect(describeFilesLoaded('feature', 56, undefined)).toBe('56 feature file(s) loaded')
  })

  it('reports every kind, including the zeros', () => {
    const line = describePackContents({
      featureCount: 55,
      ruleCount: 12,
      structureCount: 0,
      biomeCount: 0,
      fileCounts: { features: 56, rules: 12, structures: 0, biomes: 0 },
    })
    expect(line).toBe('55 of 56 feature file(s) loaded, 12 feature rule file(s) loaded, 0 structure file(s) loaded, 0 biome file(s) loaded')
  })

  it('answers "did this pack have anything at all" from the counts, and "do not know" without them', () => {
    expect(readAnyFiles({ features: 0, rules: 0, structures: 0, biomes: 0 })).toBe(false)
    expect(readAnyFiles({ features: 0, rules: 0, structures: 3, biomes: 0 })).toBe(true)
    // Not false. A pack the engine said nothing about is not a pack with nothing in it, and the
    // difference is the whole reason this returns three values.
    expect(readAnyFiles(undefined)).toBeUndefined()
    expect(readAnyFiles({})).toBeUndefined()
  })
})

describe('what a preview is handed', () => {
  // The engine emits pack-scoped diagnostics FIRST, because that is the order it builds libraries
  // in. So every preview of every feature opened with two to four several-hundred-character
  // paragraphs about files the author was not looking at, and the one line explaining why THIS
  // preview was empty sat underneath them.

  it('puts this run\'s diagnostics first and keeps them whole', () => {
    const out = scopedForPreview([ODD, TRUNCATED, REFUSED_PLACEMENT])
    expect(out[0]).toEqual(REFUSED_PLACEMENT)
  })

  it('folds every pack-scoped one into a single row', () => {
    const out = scopedForPreview([ODD, TRUNCATED, REFUSED_PLACEMENT])
    expect(out).toHaveLength(2)
    expect(out[1]!.fileId).toBe(PACK_WIDE_FILE_ID)
  })

  it('labels that row with the count, so it is an affordance and not a mystery', () => {
    const summary = packWideSummary([ODD, TRUNCATED])
    expect(summary).not.toBeNull()
    expect(summary!.message.split('\n')[0]).toBe(
      '2 pack-wide problem(s) -- about this pack, not about this run. Show more to read them.',
    )
    expect(summary!.count).toBe(2)
  })

  it('reveals the pack-wide text on demand rather than dropping it', () => {
    // The panel clamps a message to one line and offers "Show more" as soon as it contains a
    // newline (frontend/src/ui/panel.ts's isLongDiagnostic), so the newline is load-bearing: it
    // IS the disclosure. Without it the summary would be a count with nothing behind it, which
    // is the silence this change exists to remove, relabelled.
    const summary = packWideSummary([ODD, TRUNCATED])!
    expect(summary.message).toContain('\n')
    expect(summary.message).toContain('features/poplar_tree.json 4:57 -- invalid JSON at line 4, column 57: unexpected end of JSON input')
    expect(summary.message).toContain(ODD.message)
  })

  it('takes the worst level inside it, so a refused file still reads as an error', () => {
    expect(packWideSummary([ODD, TRUNCATED])!.level).toBe('error')
    expect(packWideSummary([ODD])!.level).toBe('warning')
  })

  it('carries the same string as fileId and identifier, so the row does not print it twice', () => {
    // renderDiagnostics suppresses a fileId textually identical to the identifier beside it.
    const summary = packWideSummary([TRUNCATED])!
    expect(summary.fileId).toBe(summary.identifier)
  })

  it('adds nothing at all when the pack is clean', () => {
    expect(packWideSummary([REFUSED_PLACEMENT])).toBeNull()
    expect(scopedForPreview([REFUSED_PLACEMENT])).toEqual([REFUSED_PLACEMENT])
    expect(scopedForPreview([])).toEqual([])
  })

  it('treats an absent scope as this run\'s, exactly as the frontend does', () => {
    // An engine older than this extension sends no scope. Counting its silence as "pack" would
    // move every diagnostic it will ever send behind a disclosure -- the one outcome worse than
    // showing them all.
    const old: PackDiagnosticLike = { level: 'warning', fileId: 'poplar_tree.json', message: 'something' }
    expect(isRunScoped(old)).toBe(true)
    expect(isPackScoped(old)).toBe(false)
    expect(scopedForPreview([old])).toEqual([old])
  })
})

describe('a kind the engine read nothing of', () => {
  // WHY THIS IS NOT THE EMPTY STATE'S JOB. `emptyGraphMessage` answers the canvas that drew NO
  // nodes. Rename a pack's `features/` to `features_old/` and the engine still reads
  // `feature_rules/`, so the graph comes back with the rules and the references they now dangle
  // at -- three nodes where there were fifty-seven. The canvas draws, the empty state stays
  // hidden, and the status line says "Showing the whole graph": true about the graph, false about
  // the pack, and the most confident sentence on the screen. Measured stable at 1s, 3s, 6s and
  // 10s, so it is not a loading state anybody can wait out.

  it('names the directory nothing was read from', () => {
    const said = describeEmptyGraphKinds({ features: 0, rules: 2, structures: 0, biomes: 0 })
    expect(said).not.toBeNull()
    expect(said!).toMatch(/no feature files/)
    expect(said!).toMatch(/features\//)
    // The whole of what LOADED, which is the claim the status line was making about the pack.
    expect(said!).toMatch(/whole of what loaded/)
  })

  it('says nothing about structures or biomes, which this graph never draws', () => {
    // They are read off the same pack and counted in the same fileCounts, and neither is a node.
    // A sentence on the node editor's canvas about a kind that would never have appeared on it is
    // a fact about nothing on screen, said to somebody working out what IS on screen -- and it
    // would fire on the great many perfectly ordinary packs that have no biomes.
    expect(describeEmptyGraphKinds({ features: 57, rules: 2, structures: 0, biomes: 0 })).toBeNull()
  })

  it('reports both kinds together when both are empty', () => {
    const said = describeEmptyGraphKinds({ features: 0, rules: 0 })
    expect(said!).toMatch(/features\/ or feature_rules\//)
  })

  it('says nothing for an engine that sends no counts, which is not the same as counting zero', () => {
    // The rule every other reader of PackFileCounts follows: absence is "this engine did not
    // say", and treating it as four zeros would put a warning about a missing features/ directory
    // on every pack opened with an older binary.
    expect(describeEmptyGraphKinds(undefined)).toBeNull()
    expect(describeEmptyGraphKinds({})).toBeNull()
  })
})
