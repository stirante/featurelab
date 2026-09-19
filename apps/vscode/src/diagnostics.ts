// diagnostics.ts -- projects the engine's Diagnostic[] (level/fileId/message, see
// featurelab/session's Diagnostic) onto VS Code's own Diagnostics API for the file
// currently being previewed. The webview's own Diagnostics section (frontend/src/ui/panel.ts)
// shows the full list unfiltered; this narrows to the one file VS Code diagnostics can
// meaningfully attach to.
import * as vscode from 'vscode'
import { docsUrl } from './graph/docs/url.js'

/** identifier/typeId/chain/count are optional here purely so this file tolerates a response
 * from an engine build that predates them (the old {level,fileId,message}-only Diagnostic) --
 * see updateDiagnostics's own use of them below and featurelab-frontend's protocol.ts
 * DiagnosticWire doc comment for the full contract these mirror. */
export interface DiagnosticWireLike {
  level: string
  fileId: string
  identifier?: string
  typeId?: string
  chain?: string[]
  count?: number
  message: string
  /** "pack" or "run" -- see session.Diagnostic.Scope. Not read here: the Problems view is the
   * durable place, which is exactly where a pack-scoped problem belongs, and a run-scoped one
   * about the same file is no less worth marking. Declared so this interface stays a superset of
   * what the engine sends and callers can pass one list to both consumers. */
  scope?: string
  /** The 1-based line and column in `fileId`, when the loader knew one -- see
   * jsonc.ErrorPosition. Absent for most diagnostics: a refused placement is about a feature, not
   * about a character. */
  line?: number
  column?: number
}

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection('featurelab')
}

/** Sets (replacing any previous set) the VS Code diagnostics for `document` from the
 * engine's diagnostics whose `fileId` matches any of `fileIds`.
 *
 * WHERE THE SQUIGGLE GOES. A diagnostic the engine gave a 1-based line (and, usually, column) for
 * is marked AT that position -- the rest of that line from the column onwards -- so "invalid JSON
 * at line 4, column 57" puts the Problems-panel entry, and the editor's squiggle, on the comma
 * rather than on the file. Everything else still spans the whole document, which is all that can
 * honestly be said about a placement that was refused: it is about a feature, not a character.
 * Whole-document is also the fallback for a line the document does not have, which a stale
 * diagnostic against a file edited since the run can easily name.
 *
 * `fileIds` is a LIST because the engine populates fileId two different ways, and matching only
 * one of them silently hid an entire class of diagnostic:
 *
 *   - build/parse-time diagnostics carry the pack loader's file id, i.e. the basename
 *     ("poplar_tree.json");
 *   - placement-time diagnostics carry the IDENTIFIER of whatever the caller asked to run
 *     ("wiki:pumpkin_patch", "wiki:floating_isle.main") -- see featurelab/session's Diagnostic.FileID
 *     doc comment, which is explicit that this is the root request, not the failing file.
 *
 * Passing only the basename therefore matched build-time problems and dropped every
 * placement-time one, so a run that legitimately placed nothing showed an EMPTY Problems panel
 * -- exactly the case where the user most needs the explanation. Pass both the basename and the
 * requested identifier. */
export function updateDiagnostics(
  collection: vscode.DiagnosticCollection,
  document: vscode.TextDocument,
  fileIds: readonly string[],
  diagnostics: readonly DiagnosticWireLike[],
): void {
  const accepted = new Set(fileIds.filter((id) => id.length > 0))
  const relevant = diagnostics.filter((d) => accepted.has(d.fileId))
  if (relevant.length === 0) {
    collection.delete(document.uri)
    return
  }
  const lastLine = Math.max(0, document.lineCount - 1)
  const whole = new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length)
  const vsDiagnostics = relevant.map((d) => {
    const severity = d.level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
    const diag = new vscode.Diagnostic(rangeFor(document, d, whole), formatMessage(d), severity)
    diag.source = 'featurelab'
    // WHERE TO READ MORE. A diagnostic explains what the engine declined to do; the feature
    // type's page explains why the rule is what it is and what to write instead. VS Code renders
    // a `code` with a `target` as a link in the Problems panel and on the hover, so the type id
    // the engine already sends turns into one click without adding a word to the message.
    //
    // The link is built from the type id alone -- that IS the site's route (graph/docs/url.ts)
    // -- and only when the engine named one: a diagnostic about malformed JSON has no type, and
    // a made-up link is worse than none. Where a diagnostic names a field, it does so inside its
    // message, not as a structured path, so this deliberately stops at the page.
    if (d.typeId !== undefined && d.typeId.length > 0) {
      diag.code = { value: d.typeId, target: vscode.Uri.parse(docsUrl(d.typeId)) }
    }
    return diag
  })
  collection.set(document.uri, vsDiagnostics)
}

/** The span to mark for one diagnostic: the engine's own position when it gave one and the
 * document still has that line, otherwise `whole`.
 *
 * The engine counts from 1 and VS Code counts from 0, which is the only arithmetic here and the
 * only thing that can be got wrong silently -- an off-by-one puts the squiggle on the line above
 * the problem, which is worse than putting it on the file, because it looks authoritative.
 *
 * The span runs from the column to the END of that line rather than covering a single character:
 * the loader reports where it stopped reading, not how much of what follows is wrong, and a
 * one-character mark on a line of JSON is hard to see and easy to mistake for a rendering
 * artefact. */
function rangeFor(document: vscode.TextDocument, d: DiagnosticWireLike, whole: vscode.Range): vscode.Range {
  const line = typeof d.line === 'number' && Number.isFinite(d.line) ? Math.trunc(d.line) - 1 : -1
  if (line < 0 || line >= document.lineCount) return whole
  const text = document.lineAt(line).text
  const column = typeof d.column === 'number' && Number.isFinite(d.column) ? Math.trunc(d.column) - 1 : 0
  const start = Math.max(0, Math.min(column, text.length))
  return new vscode.Range(line, start, line, text.length)
}

/** Prefixes a Problems-panel message with the CHAIN down to the feature that actually failed
 * (root-first, e.g. "wiki:floating_isle.main › wiki:floating_isle.waterfall") whenever that's known
 * and actually differs from the plain message -- otherwise this file's Problems-panel entry
 * would repeat the bug the webview panel already avoids: it named this document's own
 * file, not the (possibly nested) feature the failure actually happened in. Falls back to the
 * bare message for a response that predates chain/identifier (see DiagnosticWireLike's own doc
 * comment), and appends a "(x count)" suffix once a diagnostic fired more than once this run. */
function formatMessage(d: DiagnosticWireLike): string {
  const chain = d.chain && d.chain.length > 1 ? d.chain.join(' › ') : d.identifier && d.identifier.length > 0 ? d.identifier : null
  const withTypeAndChain = chain ? (d.typeId ? `${chain} (${d.typeId}): ${d.message}` : `${chain}: ${d.message}`) : d.message
  return d.count && d.count > 1 ? `${withTypeAndChain} (×${d.count})` : withTypeAndChain
}
