/// <reference lib="webworker" />
// The playground's engine runs here, off the page's main thread.
//
// Why a worker: the engine is the same Go code the CLI runs, compiled to WebAssembly, and Go's
// wasm runtime is single-threaded and synchronous. On the main thread its start-up (package
// initialisation, the vanilla block table) and every generate would freeze scrolling, the
// "Loading engine…" line and the viewer's own busy pill for as long as they take. Here they
// cost the reader nothing until they ask for a result, which is the point of fetching early.
//
// The page talks to this file only through engine.ts; the protocol is four messages:
//   in:  {type:'init', wasmUrl, wasmExecUrl, cacheName}
//        {type:'call', id, method:'generate'|'environments', files?, params?}
//   out: {type:'ready', version, timings} | {type:'failed', message}
//        {type:'reply', id, ok, value|message} | {type:'exited', message}
export {}

declare const self: DedicatedWorkerGlobalScope & {
  Go?: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
  featurelab?: { version?: string; generate(files: Record<string, string>, paramsJSON: string): string; environments(): string }
  featurelabOnReady?: () => void
  fs?: { writeSync(fd: number, buf: Uint8Array): number }
}

interface InitMessage {
  type: 'init'
  wasmUrl: string
  wasmExecUrl: string
  cacheName: string
  cachePrefix: string
}
interface CallMessage {
  type: 'call'
  id: number
  method: 'generate' | 'environments'
  files?: Record<string, string>
  params?: string
}

/** The last lines Go wrote to stdout/stderr. A panic prints its message and stack there and
 * nowhere else, so this is what turns "the engine stopped" into a sentence someone can act on. */
const output: string[] = []
let exited = false

type Source = 'cache' | 'network' | 'network (no cache)'

/** Fetches `url`, preferring Cache Storage.
 *
 * GitHub Pages sends a ten-minute max-age on everything and cannot be told otherwise, so without
 * this a returning reader downloads a 9 MB engine again after ten minutes. The file names carry
 * a content hash (scripts/build-playground.sh writes them into manifest.json), so a cached entry
 * is valid for as long as its name is current: there is nothing to revalidate. Anything in the
 * cache that is not one of the names in use right now is an older engine and is deleted, as are
 * whole caches from an older version of this scheme.
 *
 * Every Cache Storage step is optional. `caches` is missing on plain http and throws in some
 * private-browsing modes; a full quota refuses the put. In each case the reader still gets the
 * engine, fetched from the network, and the only cost is doing it again next time. */
async function fetchCached(url: string, cacheName: string): Promise<{ response: Response; source: Source }> {
  let cache: Cache | null = null
  try {
    if (typeof caches !== 'undefined') cache = await caches.open(cacheName)
  } catch {
    cache = null
  }
  if (cache) {
    try {
      const hit = await cache.match(url)
      if (hit) return { response: hit, source: 'cache' }
    } catch {
      // A broken cache is a cache miss.
    }
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  if (cache) {
    // Not awaited: the body is teed, so the engine compiles from one branch while the other is
    // written to the cache.
    const c = cache
    void c.put(url, response.clone()).catch(() => undefined)
  }
  return { response, source: cache ? 'network' : 'network (no cache)' }
}

async function evictStale(keep: string[], cacheName: string, cachePrefix: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    for (const name of await caches.keys()) {
      if (name !== cacheName && name.startsWith(cachePrefix)) await caches.delete(name)
    }
    const cache = await caches.open(cacheName)
    for (const request of await cache.keys()) {
      if (!keep.includes(request.url)) await cache.delete(request)
    }
  } catch {
    // Eviction is housekeeping; failing it leaves an old engine on disk, nothing more.
  }
}

async function init(msg: InitMessage): Promise<void> {
  const t0 = performance.now()

  // wasm_exec.js is Go's own loader and must match the Go version the .wasm was built with,
  // which is why it is published next to it rather than bundled here. It is a classic script
  // that defines globalThis.Go; a module worker has no importScripts, so it is evaluated in
  // global scope instead.
  const execFetch = await fetchCached(msg.wasmExecUrl, msg.cacheName)
  const execSource = await execFetch.response.text()
  ;(0, eval)(execSource)
  if (typeof self.Go !== 'function') throw new Error('wasm_exec.js did not define Go')

  // Keep what the Go runtime prints: wasm_exec.js routes stdout and stderr through fs.writeSync.
  const fs = self.fs
  if (fs && typeof fs.writeSync === 'function') {
    const original = fs.writeSync.bind(fs)
    const decoder = new TextDecoder()
    fs.writeSync = (fd: number, buf: Uint8Array): number => {
      output.push(decoder.decode(buf))
      if (output.length > 200) output.splice(0, output.length - 200)
      return original(fd, buf)
    }
  }

  const tFetch0 = performance.now()
  const { response, source } = await fetchCached(msg.wasmUrl, msg.cacheName)
  const go = new self.Go()
  let instance: WebAssembly.Instance
  const type = response.headers.get('content-type') ?? ''
  let tFetched: number
  if (typeof WebAssembly.instantiateStreaming === 'function' && type.startsWith('application/wasm')) {
    // Download and compile overlap; the split between them is not observable here.
    instance = (await WebAssembly.instantiateStreaming(response, go.importObject)).instance
    tFetched = performance.now()
  } else {
    const bytes = await response.arrayBuffer()
    tFetched = performance.now()
    instance = (await WebAssembly.instantiate(bytes, go.importObject)).instance
  }
  const tCompiled = performance.now()
  void evictStale([msg.wasmUrl, msg.wasmExecUrl], msg.cacheName, msg.cachePrefix)

  const ready = new Promise<void>((resolve) => {
    self.featurelabOnReady = () => resolve()
  })
  go.run(instance)
    .then(() => {
      exited = true
      self.postMessage({ type: 'exited', message: describeExit() })
    })
    .catch((err: unknown) => {
      exited = true
      self.postMessage({ type: 'exited', message: describeExit(err) })
    })
  // main() installs the API and calls featurelabOnReady before it blocks; the check after is for
  // an engine that installs it without calling back.
  if (!self.featurelab) await ready
  const tReady = performance.now()

  self.postMessage({
    type: 'ready',
    version: self.featurelab?.version ?? '',
    timings: {
      source,
      execMs: Math.round(tFetch0 - t0),
      fetchMs: Math.round(tFetched - tFetch0),
      compileMs: Math.round(tCompiled - tFetched),
      initMs: Math.round(tReady - tCompiled),
      totalMs: Math.round(tReady - t0),
    },
  })
}

function describeExit(err?: unknown): string {
  const tail = output.join('').trim().split('\n').slice(-12).join('\n')
  const reason = err instanceof Error ? err.message : err ? String(err) : 'the engine stopped'
  return tail ? `${reason}\n${tail}` : reason
}

function call(msg: CallMessage): void {
  const api = self.featurelab
  try {
    if (exited || !api) throw new Error(exited ? describeExit() : 'the engine is not running')
    const value = msg.method === 'generate' ? api.generate(msg.files ?? {}, msg.params ?? '{}') : api.environments()
    self.postMessage({ type: 'reply', id: msg.id, ok: true, value })
  } catch (err) {
    self.postMessage({ type: 'reply', id: msg.id, ok: false, message: exited ? describeExit(err) : err instanceof Error ? err.message : String(err) })
  }
}

self.onmessage = (ev: MessageEvent<InitMessage | CallMessage>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    init(msg).catch((err: unknown) => {
      self.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) })
    })
  } else if (msg.type === 'call') {
    call(msg)
  }
}
