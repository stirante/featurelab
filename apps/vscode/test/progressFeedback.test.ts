// progressFeedback.test.ts -- the machinery behind "something is happening", on its own.
//
// commandFeedback.test.ts proves the COMMANDS use it. This proves it does what a person needs
// while a slow engine is thinking: the notification and the spinner are up for the whole wait
// and not a moment after it, the step says what it is doing, and a wait somebody abandons is
// recorded rather than dropped.
//
// A deferred promise stands in for the slow engine, and it is not a shortcut: "slow" here means
// "has not answered yet", and a real sleep would be testing the clock. Every assertion is made
// WHILE the work is unfinished, which is the only moment any of this is visible.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { CancelledError, describeEngineProgress, disposeProgress, reportEngineProgress, runWithProgress, showBusy } from '../src/progress.js'
import { disposeLog } from '../src/log.js'

/** A promise a test settles by hand -- "the engine has not answered yet". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets already-queued continuations run, without pretending time passed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

beforeEach(() => {
  vscodeMock.resetMock()
})

afterEach(() => {
  disposeProgress()
  disposeLog()
})

describe('a step that has not finished yet', () => {
  it('keeps a notification and the status-bar spinner up, naming what it is doing', async () => {
    const engine = deferred<string>()
    const run = runWithProgress('building the graph', async (report) => {
      report('loading the pack')
      return engine.promise
    })
    await settle()

    // While it is still working: the notification exists, says which command, and has been told
    // which step is running.
    expect(vscodeMock.progressCalls.map((c) => c.title)).toEqual(['Feature Lab: building the graph'])
    expect(vscodeMock.progressReports).toEqual(['loading the pack'])
    const spinner = vscodeMock.statusBarItems[0]
    expect(spinner?.visible, 'the spinner is not up while the engine is thinking').toBe(true)
    expect(spinner?.tooltip).toContain('building the graph')
    // Clicking it is how somebody gets from "this is slow" to "here is what it is doing".
    expect(spinner?.command).toBe('featurelab.showLog')

    engine.resolve('done')
    await run
    expect(spinner?.visible, 'the spinner is still up after the work finished').toBe(false)
  })

  it('leaves the spinner up for the second of two overlapping steps', async () => {
    // A save can reload the pack while the graph is still rebuilding. The first one finishing
    // must not take the indicator away from the second.
    const first = deferred<void>()
    const second = deferred<void>()
    const a = runWithProgress('reloading the pack', () => first.promise)
    const b = runWithProgress('building the graph', () => second.promise)
    await settle()

    const spinner = vscodeMock.statusBarItems[0]
    expect(vscodeMock.statusBarItems, 'a second item was created instead of sharing one').toHaveLength(1)
    first.resolve()
    await a
    expect(spinner?.visible, 'the first step finishing hid the indicator the second still needs').toBe(true)

    second.resolve()
    await b
    expect(spinner?.visible).toBe(false)
  })

  it('reports the failure and takes the spinner down when the step throws', async () => {
    const run = runWithProgress('building the graph', () => Promise.reject(new Error('the engine said no')))
    await expect(run).rejects.toThrow('the engine said no')
    expect(vscodeMock.statusBarItems[0]?.visible).toBe(false)
    expect(vscodeMock.outputLines.join('\n')).toMatch(/building the graph: failed after \d+ms/)
  })
})

describe('a wait somebody gives up on', () => {
  it('stops waiting, says so, and does not claim the engine was stopped', async () => {
    const engine = deferred<string>()
    const run = runWithProgress('building the graph', () => engine.promise, { cancellable: true })
    await settle()

    expect(vscodeMock.progressCalls[0]?.cancellable).toBe(true)
    vscodeMock.progressTokens[0]?.cancel()

    await expect(run).rejects.toBeInstanceOf(CancelledError)
    expect(vscodeMock.statusBarItems[0]?.visible).toBe(false)
    expect(vscodeMock.outputLines.join('\n')).toMatch(/cancelled by the user/)
  })

  it('records what the abandoned request eventually did, instead of dropping it', async () => {
    const engine = deferred<string>()
    const run = runWithProgress('building the graph', () => engine.promise, { cancellable: true })
    await settle()
    vscodeMock.progressTokens[0]?.cancel()
    await expect(run).rejects.toBeInstanceOf(CancelledError)

    // The engine answers after nobody is watching. That outcome is the thing somebody looks for
    // afterwards when they wonder whether cancelling broke something, so it goes in the log
    // rather than into a swallowed promise.
    engine.reject(new Error('loadPack: no such directory'))
    await settle()
    expect(vscodeMock.outputLines.join('\n')).toContain('loadPack: no such directory')
  })
})

describe('the spinner on its own', () => {
  it('is what a background regenerate uses, and raises no notification', async () => {
    const busy = showBusy('generating the preview')
    expect(vscodeMock.statusBarItems[0]?.visible).toBe(true)
    // A save fires a regenerate. A notification per save is how people learn to dismiss
    // notifications without reading them.
    expect(vscodeMock.progressCalls).toHaveLength(0)
    busy.dispose()
    expect(vscodeMock.statusBarItems[0]?.visible).toBe(false)
    // Disposing twice must not drive the reference count negative and strand the indicator.
    busy.dispose()
    const other = showBusy('reloading the pack')
    expect(vscodeMock.statusBarItems[0]?.visible).toBe(true)
    other.dispose()
    expect(vscodeMock.statusBarItems[0]?.visible).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// What the ENGINE says while the step waits on it.
//
// The engine reports a phase, a file count and an elapsed time once a second on anything slow
// (cmd/featurelab/notify.go). Every one of those lines used to be thrown away by the protocol
// client, so a 45-second pack load showed "loading the pack" for 45 seconds and was
// indistinguishable from a hang. These are about the words on the notification, because the words
// are the entire feature.
// ---------------------------------------------------------------------------
describe('the engine\'s own progress, on the notification of the step waiting for it', () => {
  it('adds the phase, the count and a moving elapsed time to the step\'s own line', async () => {
    const engine = deferred<string>()
    const run = runWithProgress('opening the feature graph', async (report) => {
      report('loading the pack')
      return engine.promise
    })
    await settle()

    reportEngineProgress({ kind: 'progress', method: 'loadPack', phase: 'features', files: 8070, elapsedMs: 1755 })
    reportEngineProgress({ kind: 'progress', method: 'loadPack', phase: 'blocks', files: 9002, elapsedMs: 12_400 })

    // The step's own words are KEPT. "features, 8,070 files, 2s" alone does not say what is being
    // done, and "loading the pack" alone is what went stale at second 31.
    expect(vscodeMock.progressReports).toEqual([
      'loading the pack',
      'loading the pack -- features, 8,070 files, 2s',
      'loading the pack -- blocks, 9,002 files, 12s',
    ])

    engine.resolve('done')
    await run
  })

  it('goes nowhere once the step has finished, so a stray line cannot revive a closed notification', async () => {
    const engine = deferred<string>()
    const run = runWithProgress('opening the feature graph', async (report) => {
      report('loading the pack')
      return engine.promise
    })
    await settle()
    engine.resolve('done')
    await run
    const before = vscodeMock.progressReports.length

    // A pre-warm's progress, or a line that arrived after the response it belonged to. Nothing is
    // on screen for it, and inventing somewhere to put it would be worse than dropping it.
    reportEngineProgress({ kind: 'progress', phase: 'features', files: 10, elapsedMs: 900 })

    expect(vscodeMock.progressReports).toHaveLength(before)
  })

  it('says nothing rather than blanking the step\'s line, when the notification carries nothing', async () => {
    const engine = deferred<string>()
    const run = runWithProgress('opening the feature graph', async (report) => {
      report('loading the pack')
      return engine.promise
    })
    await settle()

    reportEngineProgress({ kind: 'progress', method: 'graph' })

    expect(vscodeMock.progressReports).toEqual(['loading the pack'])
    engine.resolve('done')
    await run
  })

  describe('the words themselves', () => {
    it('omits a file count the engine did not send, instead of printing zero', () => {
      // notify.go is explicit: an absent `files` means "this phase does not count files", not
      // "zero files read". Printing "0 files" would be inventing a fact about the engine.
      expect(describeEngineProgress({ kind: 'progress', phase: 'graph', elapsedMs: 3_200 })).toBe('graph, 3s')
    })

    it('keeps the elapsed time even with nothing else to say, because that is the part that moves', () => {
      expect(describeEngineProgress({ kind: 'progress', elapsedMs: 41_800 })).toBe('42s')
    })

    it('groups a big file count, because six digits run together are unreadable at a glance', () => {
      expect(describeEngineProgress({ kind: 'progress', phase: 'features', files: 11_250, elapsedMs: 1_000 })).toBe(
        'features, 11,250 files, 1s',
      )
    })
  })
})
