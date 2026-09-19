// emptyState.ts -- what the node editor's canvas says when there is nothing drawn on it.
//
// A pure module, and in src/graph rather than in webview/graph.ts, for the reason every other
// module here is: these are sentences somebody reads at the worst possible moment -- the moment
// they have decided the editor is broken -- and a sentence is worth testing directly rather than
// through a browser, where the assertion ends up being about layout instead of about words.
//
// WHY THERE IS ANYTHING TO SAY AT ALL. An empty canvas is what a pack with nothing in it looks
// like. It is also what a pack whose files all failed to load looks like, what a webview whose
// script never ran looks like, and what a broken editor looks like. Those are four completely
// different situations with four different fixes and one appearance, and the appearance is the
// one people reported: "I could not get the node editor to open."
//
// And a fifth, which is really the most common of them: the path was wrong. A directory that is
// not a pack root loads perfectly -- zero features, zero rules, zero diagnostics -- and the
// editor used to greet it with "this pack has no features and no feature rules yet", which is a
// sentence about a NEW pack and simply false about somebody who opened the wrong folder. The
// engine already knows: `pack.Load` warns, per asset kind, that the directory does not exist.
// Those warnings are what tells the two apart, so they are an input here.
//
// WHAT CHANGED. The engine now answers a load with `fileCounts` -- how many files of each kind it
// READ off disk -- and with the pack-scoped diagnostics explaining every one it then refused,
// each carrying a pack-relative path and a 1-based line/column. So the two hardest branches are
// no longer inferred: "files failed" is decided by the diagnostics themselves and NAMES the files
// with their positions, and "nothing was there to read at all" is decided by fileCounts rather
// than by counting diagnostics. The warnings are still what tells a MISSING features/ directory
// from an empty one -- nothing on the wire says whether a directory exists -- so they stay, now
// as the narrow question they are good at rather than as the evidence for everything.

import { brokenFiles, nameBrokenFiles, readAnyFiles, type PackDiagnosticLike, type PackFileCounts } from '../packContents.js'

/** What the host now sends beside a graph, as the `packContents` field of the `graph` message --
 * the engine's own answer about the pack the graph was built from.
 *
 * Both members optional, and the whole object optional at the call site: this file has to keep
 * answering for a webview bundle that predates the field and for an engine binary that predates
 * the wire fields behind it. */
export interface EmptyStatePackContents {
  fileCounts?: PackFileCounts
  diagnostics?: readonly PackDiagnosticLike[]
}

/** Whether a pack-load warning says `kind`'s directory is not on disk.
 *
 * Matched on the two parts that carry the meaning -- the asset kind, and a phrase that means the
 * directory is not there -- rather than on a whole sentence, because there are two writers of
 * these warnings and neither of them is this module. The engine says `<kind> directory "<dir>"
 * does not exist -- 0 <kind> files loaded (fine if this pack has none)`; the host says `There is
 * no "features" directory under <packRoot>`. Pinning either one exactly would mean the other
 * silently stopped being recognised, and the symptom of that is not an error -- it is the wrong
 * sentence on the canvas, which is the bug being fixed. The engine's own spelling has already
 * moved once (it used to print the path where the kind now goes, and then print the path again
 * Go-quoted beside it), which is the case for matching on meaning rather than on the sentence.
 *
 * Deliberately tolerant in the same direction throughout: a warning list that never arrives, or
 * one phrased a third way, costs the third sentence and never produces a wrong one.
 */
function warnsDirectoryMissing(warnings: readonly string[], kind: 'features' | 'feature_rules'): boolean {
  // `features` must not match inside `feature_rules`, so the boundary is explicit on both sides.
  // Quotes count as boundaries, which is how the host's `"features"` is matched.
  const named = kind === 'features' ? /(^|[^_a-z])features([^_a-z]|$)/ : /feature_rules/
  const absent = /does not exist|there is no|no such|missing/i
  return warnings.some((w) => absent.test(w) && named.test(w))
}

/** How the canvas explains a graph that drew no nodes, or null when it drew some.
 *
 * The four cases are answered differently because they need different actions from the reader. A
 * pack the engine REFUSED files from is not empty, it is broken: the files are NAMED, with the
 * line and column where the loader stopped whenever it knew one, because a message about a file
 * you cannot reach from the message is most of the way to no message at all -- and the behaviour
 * this replaces was that such a file inflated a count by one and produced nothing else anywhere.
 * A pack root the engine read no file of any kind from had nothing to draw a graph of, whatever
 * else is true of it. A directory with neither of the two directories a pack is made of is almost
 * never a pack at all, so it is told to check the path rather than invited to create its first
 * feature there. A pack that genuinely has nothing in it is a NEW pack, and the only useful thing
 * to say is how to put the first node in it.
 *
 * `packWarnings` is optional and defaults to none: an older host, or one mid-refactor, simply
 * does not send it, and the answer then is the one this function always gave.
 *
 * `contents` is the newer, better evidence and is optional for the same reason -- a webview
 * running against a host that does not send it, or a host running against an engine that does not
 * send `fileCounts`/`diagnostics`, falls back to `diagnosticCount` exactly as before. Where it IS
 * present it outranks the count, because it can say WHICH files rather than only how many.
 */
export function emptyGraphMessage(
  nodeCount: number,
  diagnosticCount: number,
  packWarnings: readonly string[] = [],
  contents?: EmptyStatePackContents,
): string | null {
  if (nodeCount > 0) return null
  const named = nameBrokenFiles(contents?.diagnostics)
  if (named.length > 0) {
    const count = brokenFiles(contents?.diagnostics).length
    return (
      `Nothing to draw: ${String(count)} file(s) in this pack could not be read, so no feature in them ` +
      `reached the graph: ${named}. The list beside this canvas says why.`
    )
  }
  if (diagnosticCount > 0) {
    return (
      `Nothing to draw: ${String(diagnosticCount)} file(s) in this pack could not be read, so no feature in them ` +
      'reached the graph. The list beside this canvas says which files and why.'
    )
  }
  // Decided from `fileCounts` rather than guessed: the engine read nothing at all, of any kind,
  // from this pack root. That is true of a wrong path AND of a pack whose directories are all
  // empty, so it does not by itself pick between the two sentences below -- it only rules out
  // every explanation that involves a file. Left to fall through when the engine did not say.
  const readSomething = readAnyFiles(contents?.fileCounts)
  // WHICH ones are missing, named. `features/` is the one that decides: a pack whose features
  // directory is not on disk had nothing to read whatever else is there, and a folder that is not
  // a pack at all is overwhelmingly the reason for it. A pack that HAS features/ and merely lacks
  // feature_rules/ is the ordinary shape of a young pack, and gets the new-pack sentence below --
  // telling that author to check their path would be worse than the bug this replaces.
  if (warnsDirectoryMissing(packWarnings, 'features')) {
    const also = warnsDirectoryMissing(packWarnings, 'feature_rules') ? ' and no feature_rules/ directory' : ''
    return (
      `Nothing to draw: this pack has no features/ directory${also}, so there was nothing to read. ` +
      'Check that the path points at the pack root.'
    )
  }
  // Files WERE read and none of them became a node. Nothing refused them -- that is the first
  // branch -- so this is a pack whose files hold structures, biomes or blocks and no feature at
  // all, or one whose features are all still drafts the engine built without complaint. Either
  // way "this pack has no features YET, right-click to create one" is the wrong sentence: it says
  // the pack is empty to somebody looking at a directory full of their own files, which is the
  // fastest way to make them stop believing the canvas.
  if (readSomething === true) {
    return (
      'Nothing to draw: the files in this pack were read, but none of them defines a feature or a feature rule. ' +
      'The list beside this canvas says what the engine made of them.'
    )
  }
  return 'This pack has no features and no feature rules yet. Right-click anywhere on this canvas to create one.'
}

/** How the canvas explains a graph the user themselves cancelled.
 *
 * It is NOT phrased as a failure and does not offer the log: nothing went wrong, and sending
 * somebody to an output channel to read about a button they pressed on purpose is the kind of
 * thing that makes people stop trusting what a panel tells them. What it does say is how to get
 * the graph after all, because the state this leaves behind -- a panel with nothing drawn on it
 * -- is otherwise indistinguishable from the broken editor this whole module exists to rule out.
 */
export function graphCancelledMessage(): string {
  return (
    'Building the feature graph was cancelled. Nothing in the pack was changed. Press Retry, or run ' +
    '"Feature Lab: Open Feature Graph" again, to build it.'
  )
}

/** How the canvas explains a pack that could not be read at all -- a `graphError`.
 *
 * It repeats the engine's own words rather than paraphrasing them, and then names the command
 * that opens the full detail. The status line says the same thing, and that is not a duplicate:
 * the status line is one row of small text at the bottom edge of the panel, which is exactly
 * where somebody who believes the panel is broken is not looking.
 */
export function graphErrorMessage(reason: string): string {
  const why = reason.trim().length > 0 ? reason.trim() : 'The pack could not be read.'
  const stop = /[.!?]$/.test(why) ? '' : '.'
  return `The feature graph could not be built: ${why}${stop} Run "Feature Lab: Show Log" for the full detail.`
}
