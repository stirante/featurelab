import { describe, expect, it, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  EngineCrashedError,
  EngineProcess,
  MalformedResponseError,
  RequestTimeoutError,
  RpcError,
  type EngineNotification,
} from '../src/engineProcess.js'

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url))

function startFakeEngine(): EngineProcess {
  const proc = new EngineProcess(process.execPath, [FAKE_ENGINE])
  proc.start()
  return proc
}

/** An engine whose every line this test WRITES, and whose clock this test controls.
 *
 * The two tests about the deadline cannot use a real child process: what they assert is the
 * relationship between when the engine last spoke and when the request is given up on, and a
 * spawned node process on a loaded machine decides that relationship itself -- start-up alone
 * can outlast the budget. EngineProcess already takes its spawn function as a parameter, so this
 * hands it a child whose stdout is an EventEmitter and nothing else changes: the parsing, the
 * correlation and the timers under test are the real ones. */
function scriptedEngine(): { proc: EngineProcess; say: (line: unknown) => void } {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void }
  stdout.setEncoding = () => {}
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void }
  stderr.setEncoding = () => {}
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.stdout = stdout
  child.stderr = stderr
  child.stdin = { write: (_payload: string, callback?: (err?: Error | null) => void) => callback?.(null) }
  child.kill = () => {}
  const proc = new EngineProcess('engine', ['serve'], (() => child) as unknown as typeof spawn)
  proc.start()
  const LINE_END = String.fromCharCode(10)
  return { proc, say: (line) => stdout.emit('data', JSON.stringify(line) + LINE_END) }
}

let current: EngineProcess | null = null
afterEach(() => {
  current?.dispose()
  current = null
})

describe('EngineProcess', () => {
  it('completes a normal request/response round trip', async () => {
    const proc = startFakeEngine()
    current = proc
    const result = await proc.request('echo', { foo: 'bar' })
    expect(result).toEqual({ foo: 'bar' })
  })

  it('correlates multiple concurrent requests to their own responses by id', async () => {
    const proc = startFakeEngine()
    current = proc
    const [a, b, c] = await Promise.all([
      proc.request('echo', { n: 1 }),
      proc.request('echo', { n: 2 }),
      proc.request('echo', { n: 3 }),
    ])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 2 })
    expect(c).toEqual({ n: 3 })
  })

  it('rejects with RpcError when the engine answers with an {"error":...} response', async () => {
    const proc = startFakeEngine()
    current = proc
    await expect(proc.request('error')).rejects.toBeInstanceOf(RpcError)
    await expect(proc.request('error')).rejects.toThrow('boom')
  })

  // Required scenario 2/3: a malformed (non-JSON) response line.
  it('rejects in-flight requests with MalformedResponseError when the engine writes a non-JSON line', async () => {
    const proc = startFakeEngine()
    current = proc
    await expect(proc.request('malformed')).rejects.toBeInstanceOf(MalformedResponseError)
  })

  // Required scenario 3/3: the engine process dying mid-request.
  it('rejects the in-flight request with EngineCrashedError when the engine process exits unexpectedly', async () => {
    const proc = startFakeEngine()
    current = proc
    await expect(proc.request('crash')).rejects.toBeInstanceOf(EngineCrashedError)
    expect(proc.isCrashed()).toBe(true)
  })

  it('fires a "crash" event exactly once when the process dies', async () => {
    const proc = startFakeEngine()
    current = proc
    const crashes: unknown[] = []
    proc.on('crash', (err) => crashes.push(err))
    await proc.request('crash').catch(() => {})
    // give the 'exit' event a tick to propagate
    await new Promise((r) => setTimeout(r, 20))
    expect(crashes.length).toBe(1)
  })

  it('rejects immediately (no hang) for any request made after the process has already crashed', async () => {
    const proc = startFakeEngine()
    current = proc
    await proc.request('crash').catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    await expect(proc.request('echo', {})).rejects.toBeInstanceOf(EngineCrashedError)
  })

  it('times out a request the engine never answers within the given budget', async () => {
    const proc = startFakeEngine()
    current = proc
    await expect(proc.request('slow', { delayMs: 500 }, 30)).rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it('a later, in-time response is unaffected by an earlier request timing out', async () => {
    const proc = startFakeEngine()
    current = proc
    await expect(proc.request('slow', { delayMs: 500 }, 30)).rejects.toBeInstanceOf(RequestTimeoutError)
    const result = await proc.request('echo', { ok: true })
    expect(result).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// The lines that are NOT responses -- cmd/featurelab/notify.go.
//
// This client used to discard every one of them on a single line (`if (typeof parsed.id !==
// 'number') return`), which had two costs and they are the two findings below. The engine reports
// a phase, a file count and an elapsed time once a second on anything slow, and NONE of it reached
// the host: a 45-second pack load showed one frozen sentence. And the request timeout, having no
// evidence of life to key off, killed requests that were working -- measured: a `graph` over an
// 11250-feature pack takes 42.8s and died at 30s.
// ---------------------------------------------------------------------------
describe('notifications', () => {
  it('reads the readiness line without mistaking it for a response', async () => {
    // The fake engine writes it before anything else, exactly as `serve` does. The old client
    // dropped it silently; the failure mode being guarded is the opposite one -- a client that
    // correlated it would resolve request id... nothing, or worse, throw on the way past.
    const proc = startFakeEngine()
    current = proc
    const ready: EngineNotification[] = []
    proc.on('ready', (note) => ready.push(note))
    // A round trip proves the ordinary channel still works with a non-response line ahead of it.
    await expect(proc.request('echo', { n: 1 })).resolves.toEqual({ n: 1 })
    expect(ready).toHaveLength(1)
    expect(ready[0]?.version).toBe('0.0.0-fake')
    expect(ready[0]?.pid).toBeGreaterThan(0)
  })

  it('delivers every progress line for a running request, and still resolves it', async () => {
    const proc = startFakeEngine()
    current = proc
    const seen: EngineNotification[] = []
    proc.on('progress', (note) => seen.push(note))

    const result = await proc.request('slowWithProgress', { everyMs: 10, ticks: 4 }, 5_000)

    expect(result).toEqual({ ticks: 4 })
    expect(seen.length).toBeGreaterThanOrEqual(4)
    // The three fields a host has anything to say with. `phase` and `files` describe the work;
    // `elapsedMs` is the one that MOVES, which is what distinguishes working from wedged.
    expect(seen[0]?.phase).toBe('features')
    expect(seen[0]?.method).toBe('slowWithProgress')
    expect(seen[0]?.files).toBe(1000)
    expect(seen[3]?.files).toBe(4000)
    expect((seen[3]?.elapsedMs ?? 0) > (seen[0]?.elapsedMs ?? 0)).toBe(true)
  })

  it('keeps a request alive as long as the engine reports progress on it', async () => {
    // THE FINDING, as a test, in the shape of the real measurement: a `graph` over an
    // 11250-feature pack runs 42.8s against a 30s budget while reporting once a second, and was
    // killed at 30s with "engine did not respond" while the engine was working normally.
    //
    // Here: a 30s budget, a response at 42s, and a progress line every second in between. Under
    // the old fixed deadline this rejects at 30s. Under an idle deadline it cannot: the engine
    // never goes quiet for more than a second.
    vi.useFakeTimers()
    try {
      const { proc, say } = scriptedEngine()
      current = proc
      const pending = proc.request('graph', undefined, 30_000)
      let settled: unknown = 'still waiting'
      void pending.then((v) => (settled = v))

      for (let second = 1; second <= 42; second++) {
        await vi.advanceTimersByTimeAsync(1_000)
        say({ notification: 'progress', requestId: 1, method: 'graph', phase: 'graph', elapsedMs: second * 1_000 })
      }
      // Well past the budget, and still waiting rather than rejected.
      expect(settled).toBe('still waiting')

      say({ id: 1, result: { nodes: 11_250 } })
      await expect(pending).resolves.toEqual({ nodes: 11_250 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still times out a request that went quiet after reporting progress, and says which', async () => {
    // The other half, and the reason this is not simply "remove the timeout": an engine that
    // spoke and then stopped IS wedged, and must still fail inside its own budget, measured from
    // the last thing it said.
    vi.useFakeTimers()
    try {
      const { proc, say } = scriptedEngine()
      current = proc
      const pending = proc.request('graph', undefined, 30_000)
      const outcome = pending.then(
        () => null,
        (err: unknown) => err,
      )

      await vi.advanceTimersByTimeAsync(25_000)
      say({ notification: 'progress', requestId: 1, method: 'graph', phase: 'features', files: 8070, elapsedMs: 25_000 })
      // Another 25 seconds of silence. Measured from the start that is 50s and the old deadline
      // had long since fired; measured from the last line it is 25s, so the request is still
      // alive -- and then it is not.
      await vi.advanceTimersByTimeAsync(25_000)
      await vi.advanceTimersByTimeAsync(5_001)

      const err = await outcome
      expect(err).toBeInstanceOf(RequestTimeoutError)
      // The sentence names what really happened. "did not respond" would be a lie about an
      // engine that responded.
      expect((err as RequestTimeoutError).sawProgress).toBe(true)
      expect(String(err)).toMatch(/stopped reporting progress/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a notification kind it has never heard of, rather than breaking on it', async () => {
    // notify.go promises in as many words that a client must ignore an unknown kind, because that
    // is what makes adding a third kind a non-breaking change. The line is still forwarded -- a
    // host that wants to log it can -- but it settles nothing and breaks nothing.
    const proc = startFakeEngine()
    current = proc
    const kinds: string[] = []
    proc.on('notification', (note) => kinds.push(note.kind))

    await expect(proc.request('unknownNotification', {}, 5_000)).resolves.toEqual({ ok: true })

    expect(kinds).toContain('something-from-the-future')
  })
})
