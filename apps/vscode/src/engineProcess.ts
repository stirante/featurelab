// engineProcess.ts -- the protocol client for cmd/featurelab's `serve` mode: newline-
// delimited JSON over stdio, {"id":..,"method":..,"params":{..}} out, {"id":..,"result":..}
// or {"id":..,"error":{"message":..}} in (see cmd\featurelab\serve.go,
// which this client was written directly against, not guessed at).
//
// Owns exactly one child process for its whole lifetime -- "load the pack once and keep the
// process alive across regenerations; do not restart the binary per save" is enforced simply
// by this class never spawning more than one process and callers reusing one instance across
// every loadPack/generate call for a given preview.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface RpcErrorShape {
  message: string
}

export class RpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcError'
  }
}

/** Thrown for a request whose in-flight promise was rejected because the engine process
 * exited (crashed, was killed, or closed its stdout) before a response arrived. */
export class EngineCrashedError extends Error {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderrTail: string
  constructor(code: number | null, signal: NodeJS.Signals | null, stderrTail: string) {
    super(
      `featurelab engine process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
        (stderrTail ? `: ${stderrTail}` : ''),
    )
    this.name = 'EngineCrashedError'
    this.code = code
    this.signal = signal
    this.stderrTail = stderrTail
  }
}

/** Thrown when a line arrives on the engine's stdout that isn't valid JSON. Per serve.go's
 * own contract this should never happen (a malformed REQUEST still gets a well-formed JSON
 * error RESPONSE) -- if it does, something is badly wrong (wrong binary, corrupted stdout,
 * the process writing something else to stdout), and every currently in-flight request is
 * rejected rather than left to hang, since there is no reliable way to tell which request
 * (if any) the bad line was meant to answer. */
export class MalformedResponseError extends Error {
  readonly rawLine: string
  constructor(rawLine: string, parseError: unknown) {
    super(`engine sent a non-JSON response line: ${String(parseError)} (line: ${truncate(rawLine, 200)})`)
    this.name = 'MalformedResponseError'
    this.rawLine = rawLine
  }
}

export class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`engine did not respond to "${method}" within ${timeoutMs}ms`)
    this.name = 'RequestTimeoutError'
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

const STDERR_TAIL_MAX = 4000

export interface EngineProcessEvents {
  /** Fired once, the first time the process exits for any reason. After this, every method
   * on this instance rejects/no-ops -- a caller must construct a new EngineProcess (and
   * re-run loadPack) to recover, exactly like a fresh `serve` invocation would need to. */
  crash: [EngineCrashedError]
}

/**
 * One live `featurelab serve` process plus request/response correlation. Not itself aware of
 * loadPack/generate semantics -- see previewController.ts for the "load once, reuse for every
 * regenerate" policy built on top of this.
 */
/** The line terminator the engine writes between responses. */
const LINE_END = String.fromCharCode(10)

export class EngineProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stderrTail = ''
  private crashed = false
  private crashInfo: EngineCrashedError | null = null

  constructor(
    private readonly binaryPath: string,
    private readonly args: string[] = ['serve'],
    private readonly spawnFn: typeof spawn = spawn,
  ) {
    super()
  }

  start(): void {
    if (this.child) throw new Error('EngineProcess.start() called twice')
    const child = this.spawnFn(this.binaryPath, this.args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    this.child = child

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk))

    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = truncate(this.stderrTail + chunk, STDERR_TAIL_MAX)
    })

    child.on('error', (err) => this.handleExit(null, null, err.message))
    child.on('exit', (code, signal) => this.handleExit(code, signal, null))
  }

  /** True once the process has exited (or failed to start) -- callers should treat the
   * preview as stale/frozen and surface this visibly rather than let requests hang. */
  isCrashed(): boolean {
    return this.crashed
  }

  lastCrash(): EngineCrashedError | null {
    return this.crashInfo
  }

  /** Sends one request and resolves with its `result`, or rejects with RpcError (the engine
   * answered with an {"error":...}), EngineCrashedError (the process died first),
   * MalformedResponseError (a non-JSON line arrived), or RequestTimeoutError. */
  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.crashed) {
      return Promise.reject(this.crashInfo ?? new EngineCrashedError(null, null, 'process not running'))
    }
    const child = this.child
    if (!child) {
      return Promise.reject(new Error('EngineProcess.request() called before start()'))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + '\n'

    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new RequestTimeoutError(method, timeoutMs))
            }, timeoutMs)
          : null
      this.pending.set(id, { method, resolve, reject, timer })
      child.stdin.write(payload, (err) => {
        if (err) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            if (pending.timer) clearTimeout(pending.timer)
            pending.reject(err)
          }
        }
      })
    })
  }

  dispose(): void {
    if (this.child) {
      this.child.removeAllListeners()
      this.child.kill()
      this.child = null
    }
    this.failAllPending(new EngineCrashedError(null, null, 'disposed'))
  }

  private handleStdout(chunk: string): void {
    // The scan RESUMES where the last one stopped rather than starting over.
    //
    // This was quadratic in the number of chunks: every arrival re-scanned the whole accumulated
    // buffer from zero for a newline it had already looked for. A graph response for a large pack
    // can be 8.8 MB, and measured over the pipe the whole path cost 200ms -- of which parsing the
    // JSON was 15ms and most of the rest was re-reading the same bytes. Simulated at 8 KB chunks
    // rather than this machine s 64 KB, the same response took 1.1 SECONDS.
    //
    // A response is one line, so the buffer only ever holds a partial one, and the offset only
    // resets when a whole line has been taken out of it.
    const searchFrom = Math.max(0, this.stdoutBuffer.length - 1)
    this.stdoutBuffer += chunk
    let cursor = searchFrom
    let lineStart = 0
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf(LINE_END, cursor)
      if (newlineIndex === -1) break
      const trimmed = this.stdoutBuffer.slice(lineStart, newlineIndex).trim()
      lineStart = newlineIndex + 1
      cursor = lineStart
      if (trimmed.length !== 0) this.handleLine(trimmed)
    }
    // One slice per chunk instead of one per line, and none at all when no line completed.
    if (lineStart > 0) this.stdoutBuffer = this.stdoutBuffer.slice(lineStart)
  }

  private handleLine(line: string): void {
    let parsed: { id?: unknown; result?: unknown; error?: RpcErrorShape }
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      // Per this class's own doc comment: cannot tell which pending request (if any) this
      // line was meant to answer, so fail every one of them rather than let some hang
      // forever waiting for a response that will never parse.
      const malformed = new MalformedResponseError(line, err)
      this.failAllPending(malformed)
      this.emit('malformedResponse', malformed)
      return
    }
    if (typeof parsed.id !== 'number') return // blank-line/no-op response (serve.go's own ID:nil case)
    const pending = this.pending.get(parsed.id)
    if (!pending) return // unknown id (shouldn't happen; ignore rather than throw)
    this.pending.delete(parsed.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (parsed.error) {
      pending.reject(new RpcError(parsed.error.message))
    } else {
      pending.resolve(parsed.result)
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, extra: string | null): void {
    if (this.crashed) return
    this.crashed = true
    const stderrTail = extra ? `${extra}${this.stderrTail ? ': ' + this.stderrTail : ''}` : this.stderrTail
    const err = new EngineCrashedError(code, signal, stderrTail)
    this.crashInfo = err
    this.failAllPending(err)
    this.emit('crash', err)
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(err)
      this.pending.delete(id)
    }
  }
}
