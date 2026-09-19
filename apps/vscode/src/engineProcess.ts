// engineProcess.ts -- the protocol client for cmd/featurelab's `serve` mode: newline-
// delimited JSON over stdio, {"id":..,"method":..,"params":{..}} out, {"id":..,"result":..}
// or {"id":..,"error":{"message":..}} in (see cmd\featurelab\serve.go,
// which this client was written directly against, not guessed at).
//
// The engine also writes lines that are NOT responses -- one readiness line at start-up and a
// progress line every second while a long method runs. They carry a "notification" member and
// NEVER an "id", which is exactly what makes them safe (cmd\featurelab\notify.go spells the
// contract out). They are handled BEFORE the id correlation, and an unknown kind is forwarded and
// otherwise ignored rather than treated as a fault.
//
// Owns exactly one child process for its whole lifetime -- "load the pack once and keep the
// process alive across regenerations; do not restart the binary per save" is enforced simply
// by this class never spawning more than one process and callers reusing one instance across
// every loadPack/generate call for a given preview.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface RpcErrorShape {
  message: string
  /** Optional machine-readable kind. Only "cancelled" is defined today; an engine older than
   * the field sends none, which is why nothing here may require it. */
  code?: string
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

/** Thrown when a request went QUIET for longer than its budget.
 *
 * Read the message carefully, because what the number measures changed. It used to be the whole
 * life of the request: a `graph` over an 11250-feature pack measured 42.8s and was killed at 30s
 * with "engine did not respond", while the engine was reading files normally and saying so once a
 * second. The deadline now runs from the last SIGN OF LIFE -- the response, or a progress
 * notification for this request's id (see notify.go's contract) -- so a request that is
 * demonstrably still working is never killed, and a request that is genuinely wedged still is,
 * within the same budget it always had.
 *
 * `sawProgress` is what lets the message say which of those two happened, since "the engine never
 * said anything at all" and "the engine was talking and then stopped" are different faults. */
export class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    readonly sawProgress = false,
  ) {
    super(
      sawProgress
        ? `engine stopped reporting progress on "${method}" for ${timeoutMs}ms`
        : `engine did not respond to "${method}" within ${timeoutMs}ms`,
    )
    this.name = 'RequestTimeoutError'
  }
}

/** Thrown for a request the CALLER stopped -- its AbortSignal fired, a `cancel` went to the
 * engine for its id, and this promise settled without waiting for the engine to unwind.
 *
 * It is not a failure and must never be reported as one. Nothing went wrong: a person pressed
 * Cancel and got what they asked for. Callers distinguish it from RpcError precisely so that the
 * difference between "the engine refused your pack" and "you stopped this" does not have to be
 * recovered by reading an error message. */
export class RequestCancelledError extends Error {
  constructor(readonly method: string) {
    super(`"${method}" was cancelled`)
    this.name = 'RequestCancelledError'
  }
}

/** The engine's ResponseError.code for a request it stopped because it was cancelled -- see
 * cmd/featurelab/serve.go's errCancelledCode. A response carrying it is the engine confirming
 * the cancel landed, and arrives after this side has already settled the promise, so normally
 * nobody is left to see it. It is matched here so the one case where somebody IS still waiting
 * -- a cancel raced with the response, or a second client cancelled this one's request -- ends
 * as a cancellation rather than as an error toast reading "request cancelled". */
const ENGINE_CANCELLED_CODE = 'cancelled'

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

/** One line the engine wrote that is NOT a response -- cmd/featurelab/notify.go.
 *
 * The contract in one sentence, and it is the reason these can exist at all: a line with an "id"
 * member is an answer to a request, a line with a "notification" member is not, and the two are
 * never the same line. A progress line therefore names its request in `requestId`, never in `id`
 * -- see notify.go's doc comment for why that spelling is load-bearing.
 *
 * Every field but `kind` is optional because the two kinds share one struct on the engine side,
 * and because a client must tolerate a kind it has never heard of rather than break on it. */
export interface EngineNotification {
  /** "ready", "progress", or something a later engine added. */
  kind: string
  /** ready: the engine is up, with its version and pid. */
  ready?: boolean
  version?: string
  pid?: number
  /** progress: the id of the request this is about, as that request spelled it. */
  requestId?: unknown
  method?: string
  /** Where inside the method the work is -- "features", "blocks", "graph", "diagnostics". */
  phase?: string
  /** Files read so far. ABSENT means "this phase does not count files", not zero. */
  files?: number
  /** How long the request has been running. Always present on a progress line. */
  elapsedMs?: number
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  /** Re-arms `timer` for another full budget. Called when the engine proves it is still working
   * on this request -- see RequestTimeoutError for what the budget now measures. */
  restartTimer?: () => void
  /** Whether a progress notification has ever arrived for this request. Only used to phrase the
   * timeout, which is a different sentence depending on it. */
  sawProgress: boolean
  /** Drops this request's abort listener. Called wherever the request settles, so a long-lived
   * signal (one panel's, reused across many requests) does not accumulate one listener per
   * request it outlived. */
  detach?: () => void
}

const STDERR_TAIL_MAX = 4000

export interface EngineProcessEvents {
  /** Fired once, the first time the process exits for any reason. After this, every method
   * on this instance rejects/no-ops -- a caller must construct a new EngineProcess (and
   * re-run loadPack) to recover, exactly like a fresh `serve` invocation would need to. */
  crash: [EngineCrashedError]
  /** Every chunk the engine writes to stderr, as it arrives and unaltered.
   *
   * Emitted as well as accumulated into `stderrTail`, because the tail is only ever read when
   * the process DIES -- so an engine that complained loudly and then went on working said its
   * piece to nobody. That is the whole of what this class knows about why a request was refused,
   * and a host that forwards it to a log turns "the preview is empty" into a sentence from the
   * engine itself. Chunks, not lines: a partial line reported late is still better than a
   * complete one reported never, and a listener that wants lines can split on them. */
  stderr: [string]
  /** Every notification line, whatever its kind, forwarded verbatim. A listener that wants to
   * log an unknown kind reads this; a listener that only wants progress reads `progress`. */
  notification: [EngineNotification]
  /** A `progress` notification the engine sent about one of THIS client's requests. Carrying the
   * whole notification rather than a formatted string, because the host decides the words. */
  progress: [EngineNotification]
  /** The one start-up line -- "the engine is up", with its version and pid. Nothing here needs
   * it; it is forwarded so a host can put it in a log, which is where a user asking "did the
   * engine even start" looks. */
  ready: [EngineNotification]
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
      // Forwarded as well as kept -- see EngineProcessEvents.stderr for why the tail alone was
      // not enough.
      this.emit('stderr', chunk)
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
   * MalformedResponseError (a non-JSON line arrived), RequestTimeoutError, or
   * RequestCancelledError (`signal` fired).
   *
   * `timeoutMs` is how long this request may go SILENT, not how long it may take. The engine
   * reports progress once a second on anything slow (notify.go), and every one of those lines
   * buys the request another full budget -- so a `graph` over a pack big enough to take 45s is
   * not killed at 30s while it is visibly working, and a request that really has wedged still
   * fails inside the same budget. Zero or less means no deadline at all, unchanged.
   *
   * `signal` is what makes Cancel mean something. When it fires this sends the engine a `cancel`
   * naming THIS request's id -- so the placement actually stops, rather than running to
   * completion into a promise nobody is holding any more -- and settles the promise as cancelled
   * without waiting for the engine to unwind. An AbortSignal rather than a vscode
   * CancellationToken on purpose: this file is the protocol layer and is driven by tests that do
   * not run inside a VS Code host, so it must not import `vscode`. */
  request(method: string, params?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    if (this.crashed) {
      return Promise.reject(this.crashInfo ?? new EngineCrashedError(null, null, 'process not running'))
    }
    const child = this.child
    if (!child) {
      return Promise.reject(new Error('EngineProcess.request() called before start()'))
    }
    if (signal?.aborted === true) {
      // Already cancelled before it was even sent. Nothing goes to the engine at all, which is
      // the cheapest possible honouring of the request and leaves no id for a cancel to chase.
      return Promise.reject(new RequestCancelledError(method))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + '\n'

    return new Promise<unknown>((resolve, reject) => {
      // The deadline is an IDLE deadline, re-armed by every progress notification for this id --
      // see RequestTimeoutError, and restartTimer below. `timeoutMs <= 0` still means "no
      // deadline at all", exactly as it did.
      const expire = (): void => {
        const entry = this.pending.get(id)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new RequestTimeoutError(method, timeoutMs, entry?.sawProgress === true))
      }
      const arm = (): ReturnType<typeof setTimeout> | null => {
        return timeoutMs > 0 ? setTimeout(expire, timeoutMs) : null
      }
      const timer = arm()
      const onAbort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return // already settled; the cancel would name a finished id
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        // Sent before settling, so the engine is already stopping while the caller is being told
        // it stopped. Errors are swallowed: the process dying is the one way this write fails,
        // and it has taken the request with it anyway.
        this.sendCancel(id)
        pending.reject(new RequestCancelledError(method))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const entry: PendingRequest = {
        method,
        resolve,
        reject,
        timer,
        sawProgress: false,
        detach: () => signal?.removeEventListener('abort', onAbort),
      }
      entry.restartTimer = () => {
        if (entry.timer !== null) clearTimeout(entry.timer)
        entry.timer = arm()
      }
      this.pending.set(id, entry)
      child.stdin.write(payload, (err) => {
        if (err) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            if (pending.timer) clearTimeout(pending.timer)
            pending.detach?.()
            pending.reject(err)
          }
        }
      })
    })
  }

  /** Tells the engine to stop the request with this id -- cmd/featurelab/serve.go's "cancel".
   *
   * FIRE AND FORGET, deliberately. The cancel gets an id of its own and the engine answers it
   * with {"cancelled":true|false}, but nothing here waits for that answer or acts on it: a false
   * means the request had already finished, which changes nothing this side wants to do, and a
   * caller that awaited the acknowledgement would be waiting again at exactly the moment it just
   * stopped waiting. The response is dropped by handleLine as an id with no pending entry. */
  private sendCancel(id: number): void {
    const child = this.child
    if (!child || this.crashed) return
    const cancelId = this.nextId++
    try {
      child.stdin.write(JSON.stringify({ id: cancelId, method: 'cancel', params: { id } }) + '\n', () => {})
    } catch {
      // The process died between the check above and the write. The request it would have
      // cancelled died with it.
    }
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
    let parsed: { id?: unknown; result?: unknown; error?: RpcErrorShape; notification?: unknown }
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
    // BEFORE the id check, which is the whole point. notify.go's contract is "a line with no id
    // member is not a response" -- and this client used to stop reading right there, so every
    // progress line the engine wrote went in the bin and a long wait showed one frozen sentence.
    if (typeof parsed.notification === 'string') {
      this.handleNotification(parsed as unknown as Record<string, unknown>, parsed.notification)
      return
    }
    if (typeof parsed.id !== 'number') return // blank-line/no-op response (serve.go's own ID:nil case)
    const pending = this.pending.get(parsed.id)
    if (!pending) return // unknown id (shouldn't happen; ignore rather than throw)
    this.pending.delete(parsed.id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.detach?.()
    if (parsed.error) {
      // A cancellation the engine reports for a caller still waiting -- see
      // ENGINE_CANCELLED_CODE. Settled as a cancellation, not as an RpcError, so the one thing
      // a user never sees is an error notification saying "request cancelled" after they pressed
      // Cancel.
      if (parsed.error.code === ENGINE_CANCELLED_CODE) {
        pending.reject(new RequestCancelledError(pending.method))
        return
      }
      pending.reject(new RpcError(parsed.error.message))
    } else {
      pending.resolve(parsed.result)
    }
  }

  /** Turns one notification line into events, and -- for a progress line naming a request this
   * client is waiting on -- into another full timeout budget for that request.
   *
   * AN UNKNOWN KIND IS NOT AN ERROR. notify.go says in as many words that a client must ignore a
   * kind it does not know, because that is what makes adding a third kind later a non-breaking
   * change. So everything here is shape-checked and nothing here throws: the worst a line the
   * future invents can do is raise a `notification` event nobody listens to. */
  private handleNotification(raw: Record<string, unknown>, kind: string): void {
    const note: EngineNotification = { kind }
    if (typeof raw.ready === 'boolean') note.ready = raw.ready
    if (typeof raw.version === 'string') note.version = raw.version
    if (typeof raw.pid === 'number') note.pid = raw.pid
    if (raw.requestId !== undefined) note.requestId = raw.requestId
    if (typeof raw.method === 'string') note.method = raw.method
    if (typeof raw.phase === 'string') note.phase = raw.phase
    // Left ABSENT when the engine omitted it: notify.go is explicit that a missing `files` means
    // "this phase does not count files" rather than "zero files read", and a host that printed
    // "0 files" for a phase that never counts any would be inventing a fact.
    if (typeof raw.files === 'number') note.files = raw.files
    if (typeof raw.elapsedMs === 'number') note.elapsedMs = raw.elapsedMs
    this.emit('notification', note)
    if (kind === 'ready') {
      this.emit('ready', note)
      return
    }
    if (kind !== 'progress') return // a kind from a newer engine: forwarded above, never fatal
    // The deadline moves because the engine proved it is still working -- see
    // RequestTimeoutError. A progress line for an id this client is not waiting on (a request
    // that just settled, or one belonging to nobody) still reaches listeners; it simply has no
    // timer to re-arm.
    if (typeof note.requestId === 'number') {
      const pending = this.pending.get(note.requestId)
      if (pending) {
        pending.sawProgress = true
        pending.restartTimer?.()
      }
    }
    this.emit('progress', note)
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
      pending.detach?.()
      pending.reject(err)
      this.pending.delete(id)
    }
  }
}
