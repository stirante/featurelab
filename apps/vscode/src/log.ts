// log.ts -- the one "Feature Lab" output channel, and the one way this extension reports a
// failure to a person.
//
// WHY THIS EXISTS. Every command in this extension used to end one of three ways: a result, a
// message posted into a webview that may not have loaded yet, or nothing at all. "Nothing at
// all" was reachable from the openGraph command in one line (a file outside a pack threw past
// the handler), from every pre-warm, and from every engine failure that happened before a panel
// existed to post into. A user reported it as "I could not get the node editor to open", with
// no way to find out why, and the author could not tell a slow run from a dead one either.
//
// So there is exactly one channel, and every failure path ends in `fail()`: a SHORT sentence in
// a notification, a "Show log" button that reveals this channel, and the long-form detail -- the
// binary path, the pack root, the engine's own stderr, the timings -- written here rather than
// into the sentence. A person gets one line; the channel keeps the transcript.
//
// The channel is created at activation (extension.ts) so that a command which fails before it
// can open anything still has somewhere to write, and so "Feature Lab: Show Log" always has
// something to show.
import * as vscode from 'vscode'

/** The button on every error notification. One spelling, in one place, because it is also the
 * string the tests look for. */
export const SHOW_LOG = 'Show log'

/** The button that re-runs whatever just failed. One spelling, like SHOW_LOG, and for the same
 * reason: it is the string the tests press.
 *
 * It exists because a failed graph load used to leave nothing to act on. The panel stayed open and
 * dead, the command had returned, and the only route back was reloading the window -- which is a
 * thing a user has to be told to do, by somebody, somewhere. */
export const RETRY = 'Retry'

/** An extra button on a failure notification, beside "Show log".
 *
 * Deliberately narrow: a label and something to run. A notification is not a place to put a
 * workflow, and every failure in this extension still ends in the same one sentence and the same
 * log button whether or not it can offer this. */
export interface FailAction {
  readonly label: string
  readonly run: () => void
}

let channel: vscode.OutputChannel | undefined

/** The shared channel, created on first use. */
export function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Feature Lab')
  return channel
}

/** Drops the remembered channel. Called from deactivate(); also what a test uses to start from
 * a clean channel rather than one a previous test filled. */
export function disposeLog(): void {
  channel?.dispose()
  channel = undefined
}

function stamp(): string {
  const now = new Date()
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

/** One timestamped line. */
export function log(line: string): void {
  output().appendLine(`[${stamp()}] ${line}`)
}

/** Text produced by something that is not this extension -- the engine's stderr, a spawn error,
 * a stack -- written VERBATIM and indented, under a label saying whose it is.
 *
 * Verbatim is the whole point. A summarised stderr is a second-hand account of the only direct
 * evidence there is about why the engine refused, and the engine is the half of this tool that
 * knows what a pack actually contains. Empty input writes nothing rather than a label over
 * nothing. */
export function logVerbatim(label: string, text: string): void {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.length === 0) return
  log(`${label}:`)
  for (const line of trimmed.split(/\r?\n/)) output().appendLine(`    ${line}`)
}

/** Reveals the channel without stealing focus from the editor. */
export function showLog(): void {
  output().show(true)
}

/**
 * The end of every failure path: a short sentence the user sees, the detail in the channel, and
 * a button that takes them to it.
 *
 * `message` is ONE SENTENCE and is shown as-is. It should name the thing that failed and, where
 * a path is what someone needs (a missing binary, a file outside a pack), the path -- but not the
 * remedy, the stack or the engine's own words. Those go in `detail`, which is written to the
 * channel first so that a user who presses "Show log" finds the explanation already there rather
 * than an empty panel.
 *
 * Returns the notification's promise so a caller can await it in a test; nothing in the product
 * needs to.
 */
export function fail(message: string, detail?: string, action?: FailAction): Thenable<void> {
  if (detail !== undefined && detail.length > 0) log(detail)
  log(`shown to the user: ${message}`)
  // The recovery button goes FIRST, and "Show log" stays where it has always been. A failure that
  // can be retried is one a user should be able to act on without first reading anything.
  const buttons = action === undefined ? [SHOW_LOG] : [action.label, SHOW_LOG]
  return vscode.window.showErrorMessage(message, ...buttons).then((choice) => {
    if (choice === SHOW_LOG) {
      showLog()
      return
    }
    if (action !== undefined && choice === action.label) {
      log(`the user pressed "${action.label}".`)
      action.run()
    }
  })
}

/** `fail`'s non-fatal sibling: something degraded, the tool still works. Same channel, same
 * button, a warning rather than an error. */
export function warn(message: string, detail?: string): Thenable<void> {
  if (detail !== undefined && detail.length > 0) log(detail)
  log(`shown to the user: ${message}`)
  return vscode.window.showWarningMessage(message, SHOW_LOG).then((choice) => {
    if (choice === SHOW_LOG) showLog()
  })
}

/** An error's own text, for a message or a log line, without the "[object Object]" a raw
 * template interpolation produces for a thrown non-Error. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
