// changeJournal.ts -- undo and redo for the file writes the node editor makes.
//
// WHY THIS EXISTS. Typing in an inspector field and pressing Tab rewrites a .json on disk. There
// is no dirty state, no save step and, until this module, no history: the edit was final the
// moment the field lost focus, and Ctrl+Z did nothing at all. graph/palette.ts says in its header
// that "the host owns naming, writing and undo"; two of those were true.
//
// WHY NOT vscode.WorkspaceEdit. VS Code gives native, free undo for a change applied through
// `workspace.applyEdit` -- but only for a change the EXTENSION composed. Every write this panel
// makes is performed by the engine process: it owns the comment-preserving JSONC round-trip
// writer, and reproducing that in TypeScript purely to route the result through applyEdit would
// mean two writers that have to agree on every file in the pack forever. There is also nothing to
// undo INTO: `undo` acts on the focused text editor, and when the graph panel has focus there
// isn't one, so VS Code's own Ctrl+Z is a no-op over a webview however the write was made. And a
// WorkspaceEdit's undo only reaches files that are open as documents, while most of a pack is not
// open at all.
//
// So the history is kept here, as BYTES: what the file was, what it became, and one line saying
// what the author did. That costs memory (bounded below) and it does not join VS Code's own undo
// stack -- an author who undoes in Feature Lab and then presses Ctrl+Z in a text editor is working
// two separate histories. In exchange it covers files that are not open, files the extension never
// composed, and creations and deletions, which is the whole of what the panel actually does.
//
// THE ONE THING IT WILL NOT DO IS CLOBBER. A file that changed on disk since the entry was
// recorded, and a file with unsaved changes in an editor, are both refusals naming the file --
// never a write. Putting back a remembered `before` over somebody else's newer work would be a
// data-loss bug wearing the word "undo".
import * as fs from 'node:fs'

/** A file's contents, or null for "the file was not there". Null is a real state on both sides of
 * an entry: creating a feature has `before: null`, and the `remove` half of a compound rewrite has
 * `after: null`. */
export type FileBytes = Buffer | null

/** One file's part in one change. */
export interface JournalledFile {
  /** Absolute path. The journal never resolves anything; callers hand it resolved paths. */
  readonly file: string
  readonly before: FileBytes
  readonly after: FileBytes
}

/** One thing the author did, which is usually one file and occasionally several.
 *
 * `files` is empty for a BARRIER -- an operation whose file set the host cannot enumerate. See
 * ChangeJournal.recordBarrier. */
export interface JournalEntry {
  /** One line, in the author's terms: "gaussian: extent 1". */
  readonly label: string
  readonly files: readonly JournalledFile[]
  /** False for a barrier: the entry is here to be REFUSED over, not to be replayed. */
  readonly undoable: boolean
}

/** How many entries are kept. Beyond this the oldest is dropped, which is a real limit and is
 * said out loud rather than presented as infinite history. */
export const JOURNAL_LIMIT = 50

/** The most one entry may hold before it is kept as a barrier instead. A compound rewrite can
 * touch a lot of files at once, and a node editor that grows to hold tens of megabytes of old
 * file contents is a worse problem than a missing undo step. */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024

/** A refusal phrased for a person: it names the file and says nothing was written.
 *
 * Its own class so a caller can tell "the author asked for something this journal will not do"
 * apart from "the filesystem failed", and report them differently. */
export class UndoRefused extends Error {
  /** True for the two refusals that are not refusals of anything: an empty undo stack and an
   * empty redo stack.
   *
   * "The file changed underneath" is news -- something the author asked for did not happen, and
   * the pack is not where they think it is. "There is nothing in the history" is a NO-OP, and a
   * no-op reported as a failed command (a red notification carrying a Show log button) teaches
   * people that this editor's notifications are noise. Callers that put a refusal in front of
   * somebody read this to tell the two apart; see runHistoryCommand. */
  readonly empty: boolean

  constructor(message: string, empty = false) {
    super(message)
    this.name = 'UndoRefused'
    this.empty = empty
  }
}

/** Reads every named file, tolerating the ones that are not there. */
export function snapshot(files: Iterable<string>): Map<string, FileBytes> {
  const out = new Map<string, FileBytes>()
  for (const file of files) out.set(file, readOrNull(file))
  return out
}

function readOrNull(file: string): FileBytes {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function same(a: FileBytes, b: FileBytes): boolean {
  if (a === null || b === null) return a === b
  return a.equals(b)
}

function sizeOf(bytes: FileBytes): number {
  return bytes === null ? 0 : bytes.length
}

/** What the journal is allowed to ask about the editor's unsaved state. Injected rather than
 * imported so this module stays testable without a running VS Code, and so the one place that
 * knows about text documents is the panel. */
export interface JournalHooks {
  /** True when VS Code is holding unsaved changes for this path. Restoring bytes underneath such
   * a buffer is not an undo -- the next save puts the edit straight back, and the author's typing
   * is what gets lost. */
  readonly isDirty?: (file: string) => boolean
}

/** A bounded history of the file writes one graph panel caused.
 *
 * One per panel, because the entries are about one pack and a panel is how a pack is open. */
export class ChangeJournal {
  private readonly undoStack: JournalEntry[] = []
  private readonly redoStack: JournalEntry[] = []

  constructor(
    private readonly hooks: JournalHooks = {},
    private readonly limit: number = JOURNAL_LIMIT,
  ) {}

  /** Records what changed between two snapshots of the SAME set of files.
   *
   * Returns the entry, or null when nothing actually changed -- which is the ordinary answer for
   * an operation the engine refused, and the reason callers can record unconditionally in a
   * `finally` rather than having to know whether the write landed.
   *
   * A new change drops the redo stack, as every editor's does: the history has forked, and
   * offering to redo a branch the author has left is offering to overwrite what they just did. */
  record(label: string, before: ReadonlyMap<string, FileBytes>, after: ReadonlyMap<string, FileBytes>): JournalEntry | null {
    const files: JournalledFile[] = []
    let bytes = 0
    for (const [file, was] of before) {
      const now = after.get(file) ?? null
      if (same(was, now)) continue
      files.push({ file, before: was, after: now })
      bytes += sizeOf(was) + sizeOf(now)
    }
    if (files.length === 0) return null
    if (bytes > MAX_ENTRY_BYTES) return this.recordBarrier(label)
    return this.push({ label, files, undoable: true })
  }

  /** Records an operation that CANNOT be undone, so that undo refuses over it by name instead of
   * quietly reverting whatever happened before it.
   *
   * Deleting or renaming a feature rewrites every file that referred to it, and this panel cannot
   * list those files in advance -- so there is no honest `before` to keep. Skipping the entry
   * altogether would be worse than useless: the next Ctrl+Z would undo an unrelated earlier field
   * edit, which is the surprise this whole module exists to remove. A barrier stays on the stack
   * when it is refused, so undo does not walk past it on the second press either. */
  recordBarrier(label: string): JournalEntry {
    return this.push({ label, files: [], undoable: false })
  }

  private push(entry: JournalEntry): JournalEntry {
    this.undoStack.push(entry)
    while (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack.length = 0
    return entry
  }

  /** The label the next undo would revert, or null when there is nothing to revert. Includes a
   * barrier: it is something to say, not something to do. */
  undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null
  }

  redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null
  }

  /** Puts the last change back, or refuses in words.
   *
   * Returns the entry it reverted, so a caller can name it and can tell which files to re-read. */
  undo(): JournalEntry {
    const entry = this.undoStack[this.undoStack.length - 1]
    if (entry === undefined) throw new UndoRefused(NOTHING_TO_UNDO, true)
    if (!entry.undoable) throw new UndoRefused(barrierRefusal(entry.label))
    this.verify(entry, 'after')
    this.apply(entry, 'before')
    this.undoStack.pop()
    this.redoStack.push(entry)
    return entry
  }

  /** Throws the top entry away WITHOUT touching a file, and returns it -- or null when there is
   * nothing on the stack.
   *
   * THE HISTORY MUST NOT BE ABLE TO WEDGE. `undo` refuses over an entry whose files have moved on,
   * and it refuses BEFORE popping, on purpose: a refusal is not an undo, and walking past the
   * entry would revert an older change while the author was told nothing happened. But that makes
   * the refusal permanent -- the file it names is never going back to what the entry remembers, so
   * every later press hits the same sentence and everything under it is unreachable for the rest
   * of the session.
   *
   * This is the way out, and it is deliberately NOT automatic: nothing here decides on the
   * author's behalf that a step they cannot undo should stop being offered. The caller asks, once,
   * having shown them the refusal. Nothing is written and nothing is put back -- the step simply
   * stops being something this panel claims it can revert.
   *
   * The redo stack is dropped with it. A redo is the other half of an undo that happened; there is
   * no such half here. */
  drop(): JournalEntry | null {
    const entry = this.undoStack.pop() ?? null
    if (entry !== null) this.redoStack.length = 0
    return entry
  }

  /** Re-applies the last undone change, under exactly the same guard. */
  redo(): JournalEntry {
    const entry = this.redoStack[this.redoStack.length - 1]
    if (entry === undefined) throw new UndoRefused(NOTHING_TO_REDO, true)
    this.verify(entry, 'before')
    this.apply(entry, 'after')
    this.redoStack.pop()
    this.undoStack.push(entry)
    return entry
  }

  /** Refuses unless every file is still exactly as this entry left it.
   *
   * ALL of them are checked before ANY of them is written. An entry is one intention spread over
   * several files, and reverting half of it because the fourth file had moved on would leave the
   * pack in a state nobody ever authored. */
  private verify(entry: JournalEntry, side: 'before' | 'after'): void {
    for (const f of entry.files) {
      if (this.hooks.isDirty?.(f.file) === true) throw new UndoRefused(unsavedRefusal(entry.label, f.file))
      if (!same(readOrNull(f.file), f[side])) throw new UndoRefused(changedRefusal(entry.label, f.file))
    }
  }

  private apply(entry: JournalEntry, side: 'before' | 'after'): void {
    for (const f of entry.files) {
      const target = f[side]
      if (target === null) {
        fs.rmSync(f.file, { force: true })
        continue
      }
      fs.writeFileSync(f.file, target)
    }
  }
}

/** ONE SENTENCE FOR ONE STATE, and the toolbar says it too.
 *
 * The panel had two of these. The Undo button's tooltip read "Nothing this panel has written is
 * waiting to be put back."; Ctrl+Z, which reaches the same empty stack by another road, answered
 * "There is nothing to undo in this feature graph." Two sentences for one state in one panel read
 * as two different states -- and the tooltip's is the true one, because what this journal holds is
 * what THIS PANEL wrote, not everything that ever happened to the pack.
 *
 * webview/graph.ts holds the same literals for the tooltips; it cannot import this module (the
 * webview bundle has no `node:fs`), so changeJournal.test.ts pins the two copies together. */
export const NOTHING_TO_UNDO = 'Nothing this panel has written is waiting to be put back.'
export const NOTHING_TO_REDO = 'Nothing has been undone here yet.'

/** What the author is told when the file moved on underneath the entry.
 *
 * It names the file, because "which one" is the only question the sentence raises, and it says
 * nothing was written, because after a refusal the state of the pack is the thing they need to
 * know. */
export function changedRefusal(label: string, file: string): string {
  return `"${label}" cannot be undone: ${file} has changed since then. Nothing was written.`
}

export function unsavedRefusal(label: string, file: string): string {
  return `"${label}" cannot be undone: ${file} has unsaved changes in an editor. Save or revert it first. Nothing was written.`
}

export function barrierRefusal(label: string): string {
  return (
    `"${label}" cannot be undone from Feature Lab: it rewrote files this panel cannot list, so there is nothing ` +
    'to put back. Nothing was written.'
  )
}
