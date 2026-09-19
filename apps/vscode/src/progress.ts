// progress.ts -- "something is happening", said twice: a notification for the step a person
// just asked for, and a status-bar item for as long as any step is in flight.
//
// The two are not redundant. A notification answers "did my keystroke do anything" and goes
// away; the status-bar item answers "is it still working" for the whole run, including the
// background regenerates a save triggers, where a notification per save would be unbearable.
// Both name the step, and the status-bar item is clickable and opens the log -- so the path from
// "this is taking a while" to "here is what it is doing" is one click with no menu hunting.
import * as vscode from 'vscode'
import { RequestCancelledError, type EngineNotification } from './engineProcess.js'
import { log } from './log.js'

/** Thrown when the user pressed Cancel on a cancellable progress notification. Carries the step
 * name so a caller's own message can say WHAT was cancelled. */
export class CancelledError extends Error {
  constructor(readonly step: string) {
    super(`${step} was cancelled`)
    this.name = 'CancelledError'
  }
}

// ---------------------------------------------------------------------------
// The status-bar item
// ---------------------------------------------------------------------------

let item: vscode.StatusBarItem | undefined
/** How many steps are in flight. Ref-counted rather than a boolean: a save can reload the pack
 * while the graph is rebuilding, and the first of the two finishing must not take the indicator
 * away from the second. */
let depth = 0

/** Shows the spinner for as long as the returned disposable is held. Use it directly for work
 * that should NOT raise a notification -- a save-triggered regenerate, a background reload. */
export function showBusy(step: string): vscode.Disposable {
  depth++
  // Created on first use, not at activation: a session that never runs a command should not put
  // anything in anybody's status bar.
  item ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  item.text = '$(sync~spin) Feature Lab'
  item.tooltip = `Feature Lab: ${step} -- click to open the log`
  item.command = 'featurelab.showLog'
  item.show()
  let released = false
  return {
    dispose: () => {
      if (released) return
      released = true
      depth--
      if (depth <= 0) {
        depth = 0
        item?.hide()
      }
    },
  }
}

/** Drops the status-bar item. Called from deactivate(). */
export function disposeProgress(): void {
  item?.dispose()
  item = undefined
  depth = 0
  // Module state, so a step left registered by a test (or by a deactivate mid-run) would go on
  // receiving engine progress into a notification that is no longer on screen.
  liveSteps.clear()
}

// ---------------------------------------------------------------------------
// The notification
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Whether the notification offers a Cancel button.
   *
   * Cancelling REACHES THE ENGINE. The step is handed an AbortSignal (see `run` below); pressing
   * Cancel fires it, and every engine request made under it sends a `cancel` for its own id, so
   * the placement or graph build actually stops instead of running to completion into a promise
   * nobody is holding. A step that ignores the signal still cancels its WAIT, exactly as before
   * -- so offering Cancel is never a lie, it is only less effective. */
  cancellable?: boolean
}

// ---------------------------------------------------------------------------
// What the ENGINE says while a step is waiting on it
// ---------------------------------------------------------------------------

/** One step that currently has a notification on screen.
 *
 * `detail` is the last thing the step itself said ("loading the pack"); `show` is how to put a
 * line on that notification. Both are needed because an engine progress line is an ADDITION to
 * the step's own words, not a replacement: "loading the pack" alone goes stale at 30 seconds, and
 * "features, 8070 files, 42s" alone does not say what is being done. */
interface LiveStep {
  detail: string
  show: (message: string) => void
}

/** Every step with a notification up right now. Ordinarily one -- a person runs one command and
 * waits for it. A list rather than a single slot because two commands CAN overlap (a graph
 * opening while a preview regenerates), and the alternative is one of them silently losing its
 * detail line to the other. */
const liveSteps = new Set<LiveStep>()

/** Turns one `progress` notification into the words a notification shows.
 *
 * Exported because it is a sentence somebody reads, and those are worth testing by their words.
 *
 * Everything in it is conditional, because everything in it is optional on the wire: a phase that
 * does not count files omits `files` entirely and must NOT be printed as "0 files" (notify.go says
 * so in as many words), and a kind of progress with no phase still has an elapsed time -- which is
 * the one field that is always there and the one that does the actual work here, because a number
 * that moves is what distinguishes "working" from "wedged". */
export function describeEngineProgress(note: EngineNotification): string {
  const parts: string[] = []
  if (typeof note.phase === 'string' && note.phase.length > 0) parts.push(note.phase)
  if (typeof note.files === 'number' && note.files > 0) parts.push(`${note.files.toLocaleString('en-US')} files`)
  if (typeof note.elapsedMs === 'number' && note.elapsedMs > 0) parts.push(`${Math.round(note.elapsedMs / 1000)}s`)
  return parts.join(', ')
}

/** The engine's own progress, onto whatever notifications are up.
 *
 * Wired in extension.ts, from EngineProcess's `progress` event by way of PreviewController. It is
 * a no-op when nothing is on screen -- a background pre-warm raises no notification, and its
 * progress lines have nowhere to go and nothing to say.
 *
 * A notification with nothing quotable in it (no phase, no files, no elapsed) is dropped rather
 * than used to blank the step's own detail line: replacing "loading the pack" with an empty
 * string would be strictly worse than saying nothing. */
export function reportEngineProgress(note: EngineNotification): void {
  const described = describeEngineProgress(note)
  if (described.length === 0) return
  for (const step of liveSteps) {
    step.show(step.detail.length > 0 ? `${step.detail} -- ${described}` : described)
  }
}

/**
 * Runs one user-visible step behind a progress notification and the status-bar spinner, logs its
 * start, its duration and its outcome, and rethrows whatever it threw.
 *
 * `report` hands the step a way to add detail to the notification while it runs ("loading the
 * pack", "building the graph"), which is what turns a 5-second wait from a hang into a sequence.
 * While it is running, the ENGINE can add to that line too -- see reportEngineProgress -- which is
 * what keeps a 45-second pack load from looking like a hang at second 31.
 */
export async function runWithProgress<T>(
  step: string,
  run: (report: (message: string) => void, signal: AbortSignal) => Promise<T>,
  options: RunOptions = {},
): Promise<T> {
  const started = Date.now()
  log(`${step}: started`)
  const busy = showBusy(step)
  // One controller per run, created whether or not the step is cancellable, so `run` always
  // receives a real signal and never has to test for one. A non-cancellable step simply gets a
  // signal that never fires.
  const controller = new AbortController()
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Feature Lab: ${step}`,
        cancellable: options.cancellable === true,
      },
      async (progress, token) => {
        // Registered for exactly as long as this notification is on screen, so an engine progress
        // line lands on the notification of the step that is waiting for it and on no other.
        const live: LiveStep = { detail: '', show: (message) => progress.report({ message }) }
        liveSteps.add(live)
        const report = (message: string): void => {
          live.detail = message
          live.show(message)
        }
        try {
          const work = run(report, controller.signal)
          if (options.cancellable !== true) return await work
          return await raceCancellation(work, token, step, controller)
        } finally {
          liveSteps.delete(live)
        }
      },
    )
    log(`${step}: finished in ${String(Date.now() - started)}ms`)
    return result
  } catch (err) {
    if (err instanceof CancelledError) log(`${step}: cancelled by the user after ${String(Date.now() - started)}ms`)
    else log(`${step}: failed after ${String(Date.now() - started)}ms`)
    throw err
  } finally {
    busy.dispose()
  }
}

/** Resolves with `work`, or rejects with CancelledError the moment `token` fires -- and fires
 * `controller` first, so the engine is told to stop before this side stops listening.
 *
 * ORDER MATTERS in that sentence. Aborting first means the `cancel` is already on its way down
 * the pipe by the time the notification goes away, rather than a tick later behind whatever the
 * rejection handlers do.
 *
 * The abandoned work is NOT dropped on the floor: its eventual outcome is written to the log.
 * That is the difference between abandoning a wait and swallowing a promise -- a request that
 * fails after the user stopped watching still leaves a trace of why, which is exactly what
 * somebody looks for afterwards when they wonder whether cancelling broke something. */
function raceCancellation<T>(
  work: Promise<T>,
  token: vscode.CancellationToken,
  step: string,
  controller: AbortController,
): Promise<T> {
  if (token.isCancellationRequested) {
    controller.abort()
    recordAbandoned(work, step)
    return Promise.reject(new CancelledError(step))
  }
  return new Promise<T>((resolve, reject) => {
    const subscription = token.onCancellationRequested(() => {
      log(`${step}: Cancel pressed -- telling the engine to stop.`)
      controller.abort()
      recordAbandoned(work, step)
      reject(new CancelledError(step))
    })
    void work.then(
      (value) => {
        subscription.dispose()
        resolve(value)
      },
      (err: unknown) => {
        subscription.dispose()
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

function recordAbandoned<T>(work: Promise<T>, step: string): void {
  void work.then(
    () => log(`${step}: the cancelled request finished anyway; its result was discarded.`),
    (err: unknown) => {
      // The expected outcome, not a failure: the engine acknowledged the cancel and the request
      // settled as cancelled. Logged as what it is, so nobody reading the channel after pressing
      // Cancel finds a line that looks like something broke.
      if (err instanceof RequestCancelledError) {
        log(`${step}: the engine confirmed it stopped.`)
        return
      }
      log(`${step}: the cancelled request then failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  )
}
