// packContents.ts -- what the engine's answer about a LOADED PACK means, in words.
//
// A pure module with no `vscode` import, for the same reason graph/emptyState.ts is one: every
// function here produces a sentence somebody reads at the moment they have decided the tool is
// lying to them, and a sentence is worth asserting directly rather than through a panel.
//
// WHY IT EXISTS AT ALL. The engine used to answer `loadPack` with four counts that meant "files
// found on disk". A pack with one truncated feature file therefore reported exactly the same
// reassuring `featureCount` as the same pack with that file intact -- the feature was gone, the
// number said it was not, and the only thing that knew otherwise was a diagnostic nobody was
// shown until they ran a generate and read past three unrelated paragraphs. The host repeated
// that number in its log, in a notification, and (by counting diagnostics) on the canvas.
//
// The engine now answers both numbers -- `featureCount` etc. are what BUILT, `fileCounts.*` is
// what was READ -- plus the pack-scoped diagnostics that explain the difference, each with a
// pack-relative `fileId` and a 1-based line/column when the JSON parser knew one. This module is
// the single place that turns that pair into "55 of 56 feature file(s) loaded" and into a list of
// broken files that names where in each file the problem is. One place, because the graph panel,
// the preview panel, the empty canvas and the activation log all have to say the same thing about
// the same pack, and four independent phrasings of it is how "56 features" survived in three of
// them after the fourth was fixed.

/** How many files of each kind the engine READ off disk, whether or not they then built --
 * `loadPack`/`reloadFile`'s `fileCounts`.
 *
 * Every member optional so a response from an engine build that predates the field decodes into
 * "this engine did not say" rather than into zeros, which would read as "your pack is empty" --
 * the exact wrong answer, and the one this whole module exists to stop being given. */
export interface PackFileCounts {
  features?: number
  structures?: number
  rules?: number
  biomes?: number
}

/** One diagnostic, as much of it as anything in this module needs.
 *
 * Structurally a subset of BOTH wire shapes the engine sends, which are not the same shape:
 * `loadPack` sends `{level, fileId, scope, line?, column?, message}` with a PACK-RELATIVE fileId
 * ("features/x.json"), while `generate` sends the full session diagnostic -- identifier, chain,
 * count, position -- with a kind-relative fileId ("x.json") or, for a placement failure, the
 * requested identifier. Nothing here reads fileId as a path; it is printed, and the one place that
 * turns it into something to open (graphPanel.ts's openNodeFile) only ever honours a spelling the
 * host itself just reported. */
export interface PackDiagnosticLike {
  level: string
  fileId: string
  message: string
  /** "pack" or "run"; see session.Diagnostic.Scope. Absent from an engine that predates the
   * field, and absence counts as the RUN's -- the same rule the frontend's own decoder applies
   * (protocol.ts's DecodedDiagnostic.scope), so the two halves of this tool never disagree about
   * which half of the list a diagnostic belongs in. */
  scope?: string
  /** 1-based, and absent whenever the loader knew no single place to point at -- which is most
   * diagnostics, since a refused placement is about a feature rather than about a character. */
  line?: number
  column?: number
}

/** The counts the pack actually BUILT, beside the files it read. Mirrors `loadPack`'s answer
 * closely enough that a LoadPackResult can be passed straight in. */
export interface PackContents {
  featureCount?: number
  structureCount?: number
  ruleCount?: number
  biomeCount?: number
  fileCounts?: PackFileCounts
  diagnostics?: readonly PackDiagnosticLike[]
}

/** Whether a diagnostic is about the PACK (a file that would not parse) rather than about the run
 * that just happened.
 *
 * Only an explicit "pack" counts. An engine that sends no scope at all is an engine older than
 * this extension -- the extension runs whatever `featurelab` it resolves -- and treating its
 * silence as "pack" would move every diagnostic it ever sends behind a disclosure, which is the
 * one outcome worse than showing them all. */
export function isPackScoped(d: PackDiagnosticLike): boolean {
  return d.scope === 'pack'
}

/** isPackScoped's complement, spelled out because it is the one the preview filters ON and
 * "not pack" is easy to write as "=== 'run'" by accident -- which would hide every diagnostic
 * from an engine that does not send the field. */
export function isRunScoped(d: PackDiagnosticLike): boolean {
  return !isPackScoped(d)
}

/** Where a diagnostic is, as one token: `features/x.json 4:57`, or `features/x.json 4` when only
 * a line is known, or the bare file when neither is.
 *
 * `line:column` rather than a sentence, because this is printed inside lists and log lines where
 * it sits beside a message that usually spells the same position out in prose anyway ("invalid
 * JSON at line 4, column 57: ..."). The short form is what a reader scans; the prose is what they
 * read once they have found the row. */
export function diagnosticLocation(d: PackDiagnosticLike): string {
  const file = d.fileId.length > 0 ? d.fileId : '(no file)'
  if (typeof d.line !== 'number' || !Number.isFinite(d.line) || d.line <= 0) return file
  if (typeof d.column !== 'number' || !Number.isFinite(d.column) || d.column <= 0) return `${file} ${String(d.line)}`
  return `${file} ${String(d.line)}:${String(d.column)}`
}

/** The files the engine REFUSED, one entry per file, in the order the engine reported them.
 *
 * Error level only: a warning is a file that loaded and has something odd about it, and folding
 * those in would turn "3 files could not be read" into a number nobody can reconcile with what
 * they can see in the editor. Deduplicated by fileId because a single unparseable file can raise
 * one diagnostic per kind that tried to read it, and "2 files could not be read" about one file is
 * a message that destroys its own credibility.
 *
 * Run-scoped entries are excluded. A run-scoped error is a placement that was refused -- the file
 * is fine, the feature simply did nothing -- and counting it as a broken file would send an author
 * to go and fix a file that has nothing wrong with it. */
export function brokenFiles(diagnostics: readonly PackDiagnosticLike[] | undefined): PackDiagnosticLike[] {
  if (!diagnostics) return []
  const seen = new Set<string>()
  const out: PackDiagnosticLike[] = []
  for (const d of diagnostics) {
    if (d.level !== 'error') continue
    if (d.scope === 'run') continue
    if (seen.has(d.fileId)) continue
    seen.add(d.fileId)
    out.push(d)
  }
  return out
}

/** How many broken files to NAME before falling back to "and N more".
 *
 * Four, because this string lands in the middle of a canvas and in a notification, and a list
 * long enough to wrap three times stops being a sentence and becomes the wall the diagnostics
 * list already is. The count is always exact; only the naming is capped. */
const NAMED_BROKEN_FILES = 4

/** The broken files, named, with their positions: `features/a.json 4:57, features/b.json`.
 *
 * Empty string for none, so a caller can test the string itself rather than remembering whether
 * this returns null. */
export function nameBrokenFiles(diagnostics: readonly PackDiagnosticLike[] | undefined): string {
  const broken = brokenFiles(diagnostics)
  if (broken.length === 0) return ''
  const named = broken.slice(0, NAMED_BROKEN_FILES).map(diagnosticLocation)
  const rest = broken.length - named.length
  return rest > 0 ? `${named.join(', ')}, and ${String(rest)} more` : named.join(', ')
}

/** The one sentence that says a pack has files in it the engine could not read, or null when it
 * has none.
 *
 * NAMED, ALWAYS. The earlier behaviour was that a file which failed to parse inflated a count by
 * one and produced nothing else anywhere in the extension -- so the sentence that replaces it has
 * to carry the thing that was missing, which is WHICH file and WHERE in it. A count on its own
 * would be the same silence with a number in front of it. */
export function describeBrokenFiles(diagnostics: readonly PackDiagnosticLike[] | undefined): string | null {
  const broken = brokenFiles(diagnostics)
  if (broken.length === 0) return null
  return `${String(broken.length)} file(s) in this pack could not be read: ${nameBrokenFiles(diagnostics)}.`
}

/** "55 of 56 feature file(s) loaded", or "56 feature file(s) loaded" when nothing failed.
 *
 * THE "OF" IS THE WHOLE POINT. `featureCount` now means what built and `fileCounts.features`
 * means what was read, and the gap between them is precisely the fact that used to be invisible.
 * Reported as one phrase rather than two numbers in two places so that no caller can print the
 * loaded count on its own and call it "56 features" again.
 *
 * `read` is optional: an engine that does not send `fileCounts` has no second number, and this
 * then says exactly what the host always said. It never invents the gap. */
export function describeFilesLoaded(noun: string, loaded: number | undefined, read: number | undefined): string {
  const built = typeof loaded === 'number' && Number.isFinite(loaded) ? loaded : 0
  const onDisk = typeof read === 'number' && Number.isFinite(read) ? read : undefined
  if (onDisk === undefined || onDisk <= built) return `${String(built)} ${noun} file(s) loaded`
  return `${String(built)} of ${String(onDisk)} ${noun} file(s) loaded`
}

/** Every kind, in one line, for the log: "55 of 56 feature file(s) loaded, 12 feature rule
 * file(s) loaded, ...".
 *
 * The four kinds always appear, including the zeros. A log line that omitted the empty kinds
 * would make "this pack has no biomes" and "this build of the extension stopped reporting
 * biomes" look identical to the person reading the transcript afterwards. */
export function describePackContents(contents: PackContents): string {
  const counts = contents.fileCounts ?? {}
  return [
    describeFilesLoaded('feature', contents.featureCount, counts.features),
    describeFilesLoaded('feature rule', contents.ruleCount, counts.rules),
    describeFilesLoaded('structure', contents.structureCount, counts.structures),
    describeFilesLoaded('biome', contents.biomeCount, counts.biomes),
  ].join(', ')
}

/** The kinds a NODE GRAPH is drawn from, in the order the canvas would miss them.
 *
 * Structures and biomes are deliberately not here. They are read off the same pack and counted in
 * the same `fileCounts`, and neither of them is a node: a sentence on the node editor's canvas
 * about a kind that would never have appeared on it is a fact about nothing on screen, said at
 * the moment somebody is trying to work out what IS on screen. `describePackContents` still logs
 * all four, including the zeros, because a log line is a different reader. */
const GRAPH_KINDS: readonly [key: keyof PackFileCounts, noun: string, missing: string][] = [
  ['features', 'feature', 'features'],
  ['rules', 'feature rule', 'feature_rules'],
]

/** The one sentence for a pack whose graph is drawn from a kind the engine read NOTHING of, or
 * null when every kind the canvas draws from has files in it.
 *
 * WHY A NON-EMPTY GRAPH NEEDS THIS. `emptyGraphMessage` answers the canvas that drew no nodes,
 * and that is not the shape this is about. Rename a pack's `features/` to `features_old/` and the
 * engine still reads `feature_rules/`: the graph comes back with the rules and the dangling
 * references they point at -- three nodes where there were fifty-seven -- so the canvas draws
 * something, the empty state stays hidden, and the status line says "Showing the whole graph."
 * That sentence is true about the graph and false about the pack, and it is the most confident
 * thing on the screen. Measured stable at 1s, 3s, 6s and 10s, so nobody reading it is going to
 * wait it out either.
 *
 * `fileCounts` is what makes the answer available at all: it is what the engine READ, so a zero
 * in it is a directory that was empty or was not there, said by the only half of this tool that
 * looked. An engine that does not send the field reports nothing here rather than four zeros --
 * the same rule every other reader of `PackFileCounts` follows, for the same reason. */
export function describeEmptyGraphKinds(counts: PackFileCounts | undefined): string | null {
  if (!counts) return null
  const empty = GRAPH_KINDS.filter(([key]) => counts[key] === 0)
  if (empty.length === 0) return null
  // Named as DIRECTORIES, because the fix is a directory: the file count being nought means the
  // engine looked where the pack format says to look and found nothing to read.
  const named = empty.map(([, , dir]) => `${dir}/`).join(' or ')
  const nouns = empty.map(([, noun]) => `${noun} files`).join(' or no ')
  return (
    `This pack has no ${nouns}. Nothing was read from ${named}, so whatever is drawn here is the ` +
    'whole of what loaded, not the whole of the pack. Check that the directory is where the pack ' +
    'root expects it.'
  )
}

/** Whether this pack read any file at all, of any kind -- "is there anything here?", answered
 * from `fileCounts` rather than inferred from prose.
 *
 * Undefined, not false, for an engine that sends no `fileCounts`: the honest answer is that this
 * engine did not say, and every caller here treats not-knowing differently from knowing-zero. */
export function readAnyFiles(counts: PackFileCounts | undefined): boolean | undefined {
  if (!counts) return undefined
  const kinds = [counts.features, counts.structures, counts.rules, counts.biomes]
  if (kinds.every((n) => typeof n !== 'number')) return undefined
  return kinds.some((n) => typeof n === 'number' && n > 0)
}

/** The fileId a host-written summary row carries when it is about the pack rather than about any
 * one file in it.
 *
 * Parenthesised so it cannot collide with a pack-relative path, and identical to the identifier
 * the summary row also carries -- the preview's Diagnostics section suppresses a fileId that is
 * textually the same as the identifier beside it (frontend/src/ui/panel.ts's renderDiagnostics),
 * so the row shows this once rather than twice. */
export const PACK_WIDE_FILE_ID = '(this pack)'

/** Folds every PACK-scoped diagnostic into ONE row for the preview's Diagnostics section, or null
 * when there are none.
 *
 * WHY THE PREVIEW NEEDS THIS AT ALL. A generate response carries the pack's whole build-diagnostic
 * set ahead of the run's own -- two to four several-hundred-character paragraphs about files the
 * author is not looking at -- and the one line explaining why THIS preview is empty was underneath
 * them. Both halves matter, and they are not equally urgent: the run's line is why the panel looks
 * like that right now; the pack's are a standing condition that will still be true on the next run.
 *
 * So the pack's half is not dropped -- dropping it would recreate, in the preview, the silence
 * this change is removing everywhere else -- it is COLLAPSED. The first line is a label with the
 * count on it; the rest of the text is every pack-scoped message, whole, verbatim, below a blank
 * line. Because the message contains newlines, the panel clamps it to its first line and offers
 * "Show more" (panel.ts's isLongDiagnostic keys on exactly that), which is the count-plus-expand
 * affordance without the webview needing to learn a new message type.
 *
 * `level` follows the worst thing inside it, so a pack with a refused file gets the error styling
 * and sorts above the run's warnings, and a pack with only warnings does not shout. */
export function packWideSummary(diagnostics: readonly PackDiagnosticLike[]): (PackDiagnosticLike & { identifier: string; count: number }) | null {
  const packWide = diagnostics.filter(isPackScoped)
  if (packWide.length === 0) return null
  const worst = packWide.some((d) => d.level === 'error') ? 'error' : 'warning'
  const lines = packWide.map((d) => `${diagnosticLocation(d)} -- ${d.message}`)
  return {
    level: worst,
    fileId: PACK_WIDE_FILE_ID,
    identifier: PACK_WIDE_FILE_ID,
    scope: 'pack',
    count: packWide.length,
    message:
      `${String(packWide.length)} pack-wide problem(s) -- about this pack, not about this run. ` +
      `Show more to read them.\n\n${lines.join('\n')}`,
  }
}

/** The `diagnostics` a preview should actually be handed: this run's, unchanged and in order,
 * followed by the one summary row standing in for the pack's.
 *
 * Order matters and is the reverse of the engine's. The engine emits pack-scoped diagnostics
 * first because that is the order it builds things in; a reader wants the run first, because the
 * run is the thing they just asked for and are looking at. */
export function scopedForPreview(diagnostics: readonly PackDiagnosticLike[]): PackDiagnosticLike[] {
  const out: PackDiagnosticLike[] = diagnostics.filter(isRunScoped)
  const summary = packWideSummary(diagnostics)
  if (summary !== null) out.push(summary)
  return out
}
