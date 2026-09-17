import { describe, expect, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EngineCrashedError, EngineProcess, MalformedResponseError, RequestTimeoutError, RpcError } from '../src/engineProcess.js'

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url))

function startFakeEngine(): EngineProcess {
  const proc = new EngineProcess(process.execPath, [FAKE_ENGINE])
  proc.start()
  return proc
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
