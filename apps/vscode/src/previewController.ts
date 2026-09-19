// previewController.ts -- owns the one live EngineProcess for this extension session and the
// "load a pack once, reuse it for every regenerate" policy on top of it (EngineProcess itself
// only knows request/response plumbing, not loadPack/generate semantics).
import { EngineProcess, type EngineNotification } from './engineProcess.js'
import type { PackDiagnosticLike, PackFileCounts } from './packContents.js'
import type { AtlasWire, EnvironmentOptionWire, GenerateParamsWire } from 'featurelab-frontend'

// GenerateParams used to be its own hand-rolled interface here, independent of the real wire
// contract (featurelab/wire's GenerateParams) -- exactly the kind of copy that drifted out
// of sync with the engine once panel.ts started restoring minY/biomeId/biomeTags/materials
// (see that file's own header comment). Re-exported under the old name so previewPanel.ts and
// its tests don't need to change their imports, but it is now the SAME type protocol.ts
// declares, not a second declaration of it.
export type GenerateParams = GenerateParamsWire

/** The three pack-describing arrays a `generate` response carries. Typed loosely on purpose:
 * this class never reads inside them, it only carries them across requests, and giving them
 * real shapes here would duplicate the wire contract that frontend/src/protocol.ts already
 * owns. */
interface PackCatalogs {
  entries: unknown
  ruleEntries: unknown
  biomeEntries: unknown
}

/** One problem the engine reported about one file while loading the pack -- wire.
 * GraphDiagnostic, mirrored here because this is the module that owns what a `graph` response
 * looks like on this side.
 *
 * `level` is "error" or "warning". An error means the engine REFUSED the file, so nothing in it
 * reached the graph at all: the node the author was looking for is not missing because they
 * mistyped a reference, it is missing because the file did not load. That case is the reason the
 * engine sends these -- without them the graph silently draws a pack minus the file someone just
 * wrote, and the only way to find out why is to run `check` from a terminal.
 *
 * `fileId` is pack-relative, the same spelling a graph node's `file` carries, so a renderer can
 * put a message beside the node it belongs to.
 *
 * `scope`, `line` and `column` are all OPTIONAL here and all pass straight through: the engine
 * now says whether a diagnostic is about the pack or about a run, and where in the file it is
 * (1-based), but a user can be running a `featurelab` older than this extension -- the binary is
 * resolved from disk, not shipped with it -- and a missing field has to mean "this engine did not
 * say" rather than a wrong guess. Nothing here fills one in. */
export interface GraphDiagnostic {
  level: string
  fileId: string
  message: string
  /** "pack" or "run"; see session.Diagnostic.Scope and packContents.ts's isPackScoped. */
  scope?: string
  /** 1-based, from the JSON loader that knew it -- what lets the host put a cursor on the comma
   * rather than only opening the file. */
  line?: number
  column?: number
}

/** The diagnostics carried by a `graph` response, defensively: anything that is not a
 * well-formed entry is dropped rather than passed on half-shaped.
 *
 * An engine that predates the field sends no `diagnostics` at all, and that is not an error --
 * a user can be running a binary older than the extension (the extension resolves whatever
 * `featurelab` it finds; see binaryResolver.ts). It reads as "this engine reports none", which
 * is the same thing the old behaviour said, rather than as a crash in the panel that would make
 * an out-of-date binary look like a broken editor. */
export function graphDiagnostics(graph: unknown): GraphDiagnostic[] {
  const raw = (graph as { diagnostics?: unknown } | null | undefined)?.diagnostics
  if (!Array.isArray(raw)) return []
  const out: GraphDiagnostic[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { level, fileId, message, scope, line, column } = entry as Partial<GraphDiagnostic>
    if (typeof level !== 'string' || typeof fileId !== 'string' || typeof message !== 'string') continue
    // The three newer fields are SPREAD IN only when the engine actually sent them. Writing
    // `scope: undefined` instead would look identical to a reader of this file and different to
    // every structural comparison downstream -- including the tests that pin what the webview is
    // handed -- so an old engine's payload stays byte-for-byte what it always was.
    out.push({
      level,
      fileId,
      message,
      ...(typeof scope === 'string' && scope.length > 0 ? { scope } : {}),
      ...(typeof line === 'number' && line > 0 ? { line } : {}),
      ...(typeof column === 'number' && column > 0 ? { column } : {}),
    })
  }
  return out
}

// One step of an `annotateBatch`. Spelled in graph/groups.ts, the pure module that plans them, so
// the webview bundle can import the type without importing this file's Node dependencies.
export type { AnnotateOp } from './graph/groups.js'
import type { AnnotateOp } from './graph/groups.js'

/** What `loadPack` and `reloadFile` both answer with -- cmd/featurelab/serve.go's loadPackResult.
 *
 * READ THE COUNTS CAREFULLY, because their meaning CHANGED and the old meaning is still on the
 * wire under another name. The four `*Count` fields are how many items of that kind actually
 * BUILT; `fileCounts` is how many files were read off disk. They used to be the same number,
 * which is why a pack with one truncated feature file reported the same reassuring count as the
 * same pack intact -- the file was gone and nothing said so. The honest phrasing of the pair is
 * "55 of 56 feature file(s) loaded", and packContents.ts is the one place that writes it.
 *
 * `fileCounts` and `diagnostics` are OPTIONAL here, not because the current engine omits them --
 * it always sends both -- but because the extension resolves whatever `featurelab` binary it
 * finds, which can predate them. Absent means "this engine did not say", which every caller
 * distinguishes from zero. */
export interface LoadPackResult {
  warnings: string[]
  featureCount: number
  structureCount: number
  ruleCount: number
  biomeCount: number
  fileCounts?: PackFileCounts
  /** Every pack-scoped diagnostic the loaded libraries hold -- the same set `check` reports,
   * available at LOAD time, with a pack-relative fileId and a 1-based line/column where the JSON
   * loader knew one. This is what makes a file that cannot be parsed impossible to load in
   * silence. */
  diagnostics?: PackDiagnosticLike[]
}

/** This controller has been shut down for good, and whoever is still holding it is holding the
 * PREVIOUS engine.
 *
 * It exists because dispose() used to be undoable by accident. It nulled `engine`, and
 * ensureEngine() reads a null `engine` as "never started" and spawns `this.binaryPath` again --
 * so a panel that captured a controller at construction went on running the OLD binary after
 * extension.ts had already replaced it (`featurelab.binaryPath` changed, controllerFor disposed
 * the old controller and built a new one). The user believed they had switched engines; every
 * generate in that panel was answered by the engine they thought they had left, silently, with
 * its own copy of the pack loaded and no probe having been run against it.
 *
 * The message is the remedy, because there is nothing the panel itself can do: the controller is
 * gone, and a panel is bound to the one it was constructed with. */
export class EngineDisposedError extends Error {
  constructor(readonly binaryPath: string) {
    super(
      `this panel is still running the previous engine (${binaryPath}), which has been shut down -- ` +
        'usually because "featurelab.binaryPath" changed. Close this panel and open it again to use the new engine.',
    )
    this.name = 'EngineDisposedError'
  }
}

export class PreviewController {
  private engine: EngineProcess | null = null
  /** The tombstone. Set by dispose() and never cleared: a disposed controller stays disposed.
   * See EngineDisposedError for what went wrong without it. */
  private tombstoned = false
  private loadedPackRoot: string | null = null
  /** One in-flight `loadPack` promise per pack root. Exists because loadPack is now reachable
   * from TWO independent callers at once -- extension.ts's background pre-warm (fired when a
   * previewable file becomes the active editor) and an actual preview command racing it -- and
   * without coalescing each of them would issue its own full loadPack (measured ~730ms on a
   * 3.5k-feature pack), serialized behind each other on the same engine, doubling exactly the
   * latency the pre-warm exists to remove. Entries remove themselves when the request settles
   * either way, so a failed load never poisons the next attempt. */
  private readonly inflightLoads = new Map<string, Promise<LoadPackResult>>()
  /** The last `generate` response's pack CATALOGUES -- entries/ruleEntries/biomeEntries, the
   * three lists describing what the loaded pack contains rather than anything about the run.
   *
   * They are the dominant cost of a repeated preview: on a large pack a response measures around
   * 976 KB of compact JSON and `entries` alone is 531 KB, one row per features/*.json file,
   * re-serialised by the engine and re-parsed by the webview on every save even though the set
   * can only change when the pack is loaded again. So the first generate after a load fetches
   * them, every generate after that asks the engine to omit them (wire.GenerateParams.
   * OmitCatalogs), and this cache is spliced back into the response before anything downstream
   * sees it -- which is why previewPanel.ts and the webview need to know nothing about any of
   * this: the result they are handed has the same shape it always had.
   *
   * Cleared whenever a pack is loaded or reloaded, since that is exactly when the catalogues
   * can change. */
  private catalogs: PackCatalogs | null = null
  /** The last successful `loadPack`/`reloadFile` answer, and which root it was about.
   *
   * Kept so a caller can ask what the loaded pack actually CONTAINS without issuing a second
   * load -- which is what turns "the panel opened empty" into "this pack declares no features
   * and no feature rules", said before the panel is even drawn. ensurePackLoaded deliberately
   * answers null for a pack that was already loaded (it did not initiate the load, so it has no
   * result to hand back), and that null is exactly the case somebody needs the counts in. */
  private lastLoad: { packRoot: string; result: LoadPackResult } | null = null

  /** The engine binary every request on this controller runs against. Public because the
   * first-run texture flow (src/textures.ts) runs the SAME binary as a separate, short-lived
   * process -- a minutes-long download issued down this controller's one request channel
   * would block every generate behind it.
   *
   * `onEngineOutput` receives the engine's own stderr, verbatim, as it arrives, plus one line
   * when the process dies. INJECTED rather than imported: this file is driven by tests that do
   * not run inside a VS Code host at all, and reaching for `vscode` here to write to an output
   * channel would make the whole protocol layer unloadable outside one. The host passes a
   * function that writes to its log; everything else passes nothing and loses nothing. */
  constructor(
    readonly binaryPath: string,
    private readonly onEngineOutput: (text: string) => void = () => {},
    /** Every `progress` notification the engine sends about a request on this controller --
     * cmd/featurelab/notify.go. INJECTED for the same reason onEngineOutput is: this file is
     * driven by tests with no VS Code host, and the host is what decides whether a phase and an
     * elapsed time become a notification, a status bar or nothing. Defaults to nothing, so every
     * caller that does not care is unaffected. */
    private readonly onEngineProgress: (note: EngineNotification) => void = () => {},
  ) {}

  private ensureEngine(): EngineProcess {
    // BEFORE the null check, because a disposed controller has a null engine and "never started"
    // and "shut down on purpose" must not take the same branch -- that identical shape is exactly
    // what resurrected the old binary. See EngineDisposedError.
    if (this.tombstoned) throw new EngineDisposedError(this.binaryPath)
    if (this.engine && !this.engine.isCrashed()) return this.engine
    // Either never started, or the previous process crashed -- either way a fresh process
    // has no pack loaded, so the next generate() must go through loadPack again. In-flight
    // loads belong to the dead engine (their promises are already rejecting); dropping the map
    // entries now keeps a new caller from awaiting a dead engine's rejection instead of just
    // issuing a fresh loadPack against the new process.
    this.engine?.dispose()
    this.loadedPackRoot = null
    this.lastLoad = null
    this.inflightLoads.clear()
    const engine = new EngineProcess(this.binaryPath, ['serve'])
    // Wired BEFORE start(), so nothing the engine says while coming up is missed -- which is
    // precisely when a binary that cannot run says the one useful thing it will ever say.
    this.attachEngine(engine)
    engine.start()
    return engine
  }

  /** Adopts `engine` as this controller's process and subscribes to everything it says.
   *
   * Its own method rather than four lines inside ensureEngine because this is the only place the
   * controller decides what the host hears, and because previewController.test.ts drives a fake
   * `serve` by handing one in -- a test that assigned the field directly would prove the plumbing
   * it bypassed. */
  private attachEngine(engine: EngineProcess): void {
    engine.on('stderr', (chunk: string) => this.onEngineOutput(chunk))
    engine.on('crash', (err: Error) => this.onEngineOutput(`engine process ended: ${err.message}`))
    // "The engine is still working, and here is what on." Without this the host has elapsed time
    // and nothing else, which is precisely the frozen-sentence wait these notifications exist to
    // end.
    engine.on('progress', (note: EngineNotification) => this.onEngineProgress(note))
    engine.on('ready', (note: EngineNotification) =>
      this.onEngineOutput(`engine ready (version ${note.version ?? 'unknown'}, pid ${String(note.pid ?? 0)})`),
    )
    this.engine = engine
  }

  /** Issues the actual loadPack request and registers it in inflightLoads for the duration --
   * the single funnel both ensurePackLoaded and reloadPack put their requests through, so any
   * two concurrent loads of the same root collapse into one engine request. */
  private startLoad(engine: EngineProcess, packRoot: string, timeoutMs: number): Promise<LoadPackResult> {
    const load = (async () => {
      try {
        const result = (await engine.request('loadPack', { dir: packRoot }, timeoutMs)) as LoadPackResult
        this.loadedPackRoot = packRoot
        this.lastLoad = { packRoot, result }
        // A load is the only thing that can change what the catalogues contain, so this is the
        // one place they have to be dropped -- see the field's own comment.
        this.catalogs = null
        return result
      } finally {
        this.inflightLoads.delete(packRoot)
      }
    })()
    this.inflightLoads.set(packRoot, load)
    return load
  }

  isCrashed(): boolean {
    return this.engine?.isCrashed() ?? false
  }

  /** Whether this controller has been shut down for good. A holder that wants to say so BEFORE
   * its next request fails -- previewPanel.ts's notifyEngineDisposed -- asks here. */
  isDisposed(): boolean {
    return this.tombstoned
  }

  /** Loads `packRoot` if it isn't already the currently-loaded pack on a live engine -- this
   * is the "do not restart the binary per save" / "load once, regenerate repeatedly"
   * requirement: a save-triggered regenerate for the SAME pack never re-hits loadPack. */
  async ensurePackLoaded(packRoot: string, timeoutMs: number): Promise<LoadPackResult | null> {
    const engine = this.ensureEngine()
    if (this.loadedPackRoot === packRoot) return null
    const inflight = this.inflightLoads.get(packRoot)
    if (inflight) {
      // A pre-warm (or a sibling panel) already has this exact load running -- ride it rather
      // than queueing a second full loadPack behind it. Null, not the shared result: this
      // caller didn't initiate the load, same as the already-loaded fast path above.
      await inflight
      return null
    }
    return this.startLoad(engine, packRoot, timeoutMs)
  }

  /** What the loaded pack CONTAINS -- ensurePackLoaded's answer for a caller that needs the
   * counts rather than only the side effect.
   *
   * It exists because "the panel opened and there was nothing in it" has two completely
   * different causes -- a pack with no features in it, and a pack whose files all failed to load
   * -- and neither is distinguishable from a broken editor without these numbers. A command asks
   * for them before it opens anything, so the emptiness can be said in words.
   *
   * Never issues a second load: an already-loaded pack answers from the remembered result, a
   * load already in flight is ridden, and only a pack this controller has not loaded costs a
   * request. */
  async loadPackSummary(packRoot: string, timeoutMs: number): Promise<LoadPackResult> {
    const engine = this.ensureEngine()
    const remembered = this.lastLoad
    if (this.loadedPackRoot === packRoot && remembered !== null && remembered.packRoot === packRoot) {
      return remembered.result
    }
    const inflight = this.inflightLoads.get(packRoot)
    if (inflight) return inflight
    return this.startLoad(engine, packRoot, timeoutMs)
  }

  /** Unconditionally re-runs `loadPack` against `packRoot`, even if it is already the loaded
   * pack -- wired to the panel's "Reload files" button (panel.ts's onReloadFiles). serve.go's
   * own loadPack always re-reads every file from disk and only rebuilds the kinds whose
   * content actually changed (session.Workspace.Update's content-hash check), so this is cheap
   * to call on demand rather than something that needs its own file watcher here. */
  async reloadPack(packRoot: string, timeoutMs: number): Promise<LoadPackResult> {
    const engine = this.ensureEngine()
    const inflight = this.inflightLoads.get(packRoot)
    // An in-flight load already re-reads every file from disk (serve.go's loadPack always
    // does), so a reload requested while one is running gains nothing from issuing a second --
    // this matters since save-triggered reloads from several panels on the same pack land in
    // the same tick. The theoretical loss: a reload racing a load that started BEFORE the
    // triggering save could return pre-save data -- but that window is one sub-second loadPack,
    // and the user cannot activate a file, edit and save it inside it, so it isn't worth a
    // load-then-load-again chain here.
    if (inflight) return inflight
    return this.startLoad(engine, packRoot, timeoutMs)
  }

  /** reloadPack's single-file counterpart, and the one the SAVE path uses: re-reads only the
   * file that was just saved (the engine's `reloadFile` -- see cmd/featurelab/serve.go's
   * methodReloadFile) instead of re-walking the whole pack to discover it. A full reloadPack of
   * a real 3.5k-feature pack measures ~680ms warm; the same save through here measures ~70ms,
   * nearly all of it the feature-library rebuild the edit genuinely requires. That difference IS
   * the edit-save-look loop.
   *
   * Every failure falls back to a full reloadPack, and the fallback is the only exit from the
   * incremental path other than success -- no error is inspected, no message is matched. The
   * engine refuses a path it cannot account for (outside the pack, belonging to another pack,
   * a kind it never loaded), and it can also simply be a fresh process with nothing loaded yet
   * after a crash; every one of those means "reload properly", and treating anything else as a
   * reason to keep the old picture on screen is exactly how a preview goes stale. An
   * incremental reload is an optimisation, and the safe answer whenever an optimisation cannot
   * run is to do the slow thing.
   *
   * The catalogues are dropped here just as a full load drops them (see the field's own
   * comment): the saved file may have added, renamed or deleted a feature, so the picker lists
   * that a client caches can change on exactly this call. */
  async reloadPackFile(packRoot: string, filePath: string, timeoutMs: number): Promise<LoadPackResult> {
    const engine = this.ensureEngine()
    // Same coalescing posture as reloadPack, for the same reason -- see its comment: an
    // in-flight full load already re-reads this file among all the others.
    const inflight = this.inflightLoads.get(packRoot)
    if (inflight) return inflight
    // Nothing incremental to do to a pack that isn't the loaded one -- including the case
    // ensureEngine() just created a fresh process for, where nothing is loaded at all.
    if (this.loadedPackRoot !== packRoot) return this.startLoad(engine, packRoot, timeoutMs)
    try {
      const result = (await engine.request('reloadFile', { dir: packRoot, path: filePath }, timeoutMs)) as LoadPackResult
      this.catalogs = null
      // The counts can change on exactly this call -- the saved file may have added, renamed or
      // deleted a feature -- so the remembered summary has to move with them, for the same
      // reason the catalogues do.
      this.lastLoad = { packRoot, result }
      return result
    } catch {
      return this.reloadPack(packRoot, timeoutMs)
    }
  }

  /** `signal`, on this and the other two long methods below, is what carries a user's Cancel all
   * the way to the engine: EngineProcess sends a `cancel` for this request's id and settles the
   * promise as a RequestCancelledError rather than leaving the placement running for a result
   * nobody will look at. Optional everywhere, because most callers (a save-triggered regenerate,
   * a pre-warm) have nothing that could cancel them.
   *
   * The pack load is deliberately NOT covered by it: it is shared state every later request
   * reads, and the engine will not interrupt a loadPack anyway (see serve.go's dispatch). */
  async generate(packRoot: string, params: GenerateParams, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    const engine = this.ensureEngine()
    return this.withCatalogs((p) => engine.request('generate', p, timeoutMs, signal), params)
  }

  /** Runs one generate-shaped request with the pack catalogues fetched at most once per load.
   *
   * On the first call after a load the request goes out unchanged and whatever comes back is
   * remembered; after that the request carries `omitCatalogs` and the remembered arrays are
   * spliced into the response. A response that unexpectedly carries its own catalogues (an
   * older engine that does not know the flag, say) wins over the cache rather than being
   * overwritten by it -- the engine is the authority, the cache is only an optimisation.
   *
   * Anything unexpected here degrades to "send the full request": if the response is not an
   * object, or the splice cannot be done, the caller still gets exactly what the engine said. */
  private async withCatalogs(send: (params: GenerateParams) => Promise<unknown>, params: GenerateParams): Promise<unknown> {
    const cached = this.catalogs
    const response = await send(cached ? { ...params, omitCatalogs: true } : params)
    if (typeof response !== 'object' || response === null) return response
    const record = response as Record<string, unknown>
    if (cached) {
      for (const key of ['entries', 'ruleEntries', 'biomeEntries'] as const) {
        if (record[key] === null || record[key] === undefined) record[key] = cached[key]
      }
      return response
    }
    if ('entries' in record) {
      this.catalogs = { entries: record.entries, ruleEntries: record.ruleEntries, biomeEntries: record.biomeEntries }
    }
    return response
  }

  /** generate()'s "grow to fit and regenerate" counterpart -- calls the engine's
   * "generateGrown" method (cmd/featurelab/serve.go, wire.RunGenerateGrownFromWorkspace; see
   * that package's doc comment, "Grow-and-regenerate") instead of "generate". Same
   * ensurePackLoaded policy, same params shape; the response is a superset of a plain generate
   * response (adds `grown`/`preGrowBounds` -- see wire.GrownGenerateOutput's own doc comment),
   * which frontend/src/protocol.ts's decodeGenerateResult already decodes without needing a
   * separate wire-level type on this side. */
  async generateGrown(packRoot: string, params: GenerateParams, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    const engine = this.ensureEngine()
    return this.withCatalogs((p) => engine.request('generateGrown', p, timeoutMs, signal), params)
  }

  /** Fetches the pack's feature graph -- cmd/featurelab's "graph" method, the same builder the
   * `graph` subcommand runs, over the pack this session already has open.
   *
   * It calls ensurePackLoaded because a graph is built from the loaded source files, and it does
   * NOT go through withCatalogs: a graph response carries no entries/ruleEntries/biomeEntries, so
   * the splice would have nothing to do and the `omitCatalogs` flag nothing to mean.
   *
   * Note the engine returns a graph for a pack with unresolved references rather than an error --
   * a dangling reference arrives as a node with `unresolved` set. That is deliberate on the
   * engine side and this method must not second-guess it: an editor opens half-written packs
   * constantly, and refusing the graph would hide exactly what someone needs to see.
   *
   * The same goes one step further for a file the engine REFUSED, which has no node at all: the
   * response carries a `diagnostics` array saying so -- see graphDiagnostics above, and
   * wire.Graph.Diagnostics for why it is on the graph rather than left to `check`. */
  async graph(packRoot: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('graph', undefined, timeoutMs, signal)
  }

  /** Writes whole new pack files and re-reads the pack -- cmd/featurelab's "createFiles".
   *
   * Separate from applyEdits because the two have to fail differently: editing a file that is
   * absent is one mistake and creating over a file that is present is another, and a single
   * operation would have to pick one wrong answer. The engine refuses to overwrite, and checks
   * the whole batch before writing any of it -- one compound node is several files, and half a
   * compound is not a thing the graph can describe. */
  async createFiles(
    packRoot: string,
    files: readonly { path: string; contents: string }[],
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('createFiles', { files }, timeoutMs)
  }

  /** Rewrites a compound's generated files after its parameters changed, and removes the ones
   * the new parameters no longer produce -- cmd/featurelab's "regenerate".
   *
   * Not createFiles with a flag. createFiles refuses to overwrite, and that refusal is what
   * makes it safe to point at a path the editor composed: a file in the way is a collision to
   * report, not a thing to replace. Regeneration is the opposite situation and says so in its
   * own name. The engine additionally refuses to delete a path whose file does not declare one
   * of the owner's own generated identifiers, so a wrong id cannot take somebody's features
   * with it. */
  async regenerate(
    packRoot: string,
    owner: string,
    files: readonly { path: string; contents: string }[],
    remove: readonly string[],
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('regenerate', { owner, files, delete: remove }, timeoutMs)
  }

  /** Renames a feature and every reference to it -- cmd/featurelab's "renameFeature".
   *
   * The engine re-derives the whole operation from its own view of the pack and re-reads every
   * file before writing; the plan the editor computed is advisory. That is deliberate: a path
   * that has gone stale usually still RESOLVES, so writing through it would silently retarget
   * somebody else's delegation rather than fail. */
  async renameFeature(packRoot: string, from: string, to: string, timeoutMs: number): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('renameFeature', { from, to }, timeoutMs)
  }

  /** Deletes a feature -- cmd/featurelab's "deleteFeature".
   *
   * Refuses by default while anything still delegates to it, and NAMES the referrers: that
   * refusal is the product, not an obstacle to it. `detachReferences` opts into removing those
   * delegating entries too, and still refuses rather than break a pack -- a required delegation
   * or a list the engine will not accept empty stops the whole operation. */
  async deleteFeature(
    packRoot: string,
    id: string,
    detachReferences: boolean,
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('deleteFeature', { id, detachReferences }, timeoutMs)
  }

  /** Fetches the engine's own feature-type coverage table -- cmd/featurelab's "types" method,
   * the same rows `featurelab types --json` prints.
   *
   * Static and pack-independent, so unlike graph() this never loads a pack first. It is the
   * authority on which types this tool can build: a creation menu that carried its own copy
   * would offer a type the engine cannot place the first time the two drifted. */
  async listTypes(timeoutMs: number): Promise<unknown> {
    return this.ensureEngine().request('types', undefined, timeoutMs)
  }

  /** Records one `@featurelab:` directive in a pack file's comments -- cmd/featurelab's
   * "annotate".
   *
   * Separate from applyEdits because a directive is not an edit to the JSON: it goes in a COMMENT,
   * at a position derived from the path rather than at the path, and the engine rewrites an
   * existing directive of the same name in place instead of adding a second one. None of that is
   * expressible as a value written to a JSONPath, which is all applyEdits can say.
   *
   * `path` names what the directive is ABOUT (an edge, a member), not where the comment goes. */
  async annotate(
    packRoot: string,
    file: string,
    path: string,
    name: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('annotate', { file, path, name, args: [...args] }, timeoutMs)
  }

  /** Records or removes several directives across several files as ONE operation --
   * cmd/featurelab's "annotateBatch".
   *
   * A feature group is one fact written into every member's file, so renaming or collapsing one
   * is a rewrite of N files. Sent as N `annotate` calls that is N reloads and N chances to stop
   * half way with the members disagreeing about their own group; the batch is validated whole on
   * the engine before anything is written, and reloads each changed file once. */
  async annotateBatch(packRoot: string, ops: readonly AnnotateOp[], timeoutMs: number): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request(
      'annotateBatch',
      {
        ops: ops.map((op) => ({
          file: op.file,
          path: op.path,
          name: op.name,
          ...(op.remove ? { remove: true } : { args: [...(op.args ?? [])] }),
        })),
      },
      timeoutMs,
    )
  }

  /** Applies a batch of edits to one pack file and re-reads it -- cmd/featurelab's "applyEdits".
   *
   * The whole batch goes in ONE call because the engine resolves every edit's span against the
   * original bytes; sent one at a time, the second edit's offsets would be computed against a
   * file the first had already moved. It is also all-or-nothing there, so a rejected batch
   * leaves the file exactly as it was rather than half-written. */
  async applyEdits(
    packRoot: string,
    file: string,
    edits: readonly { path: string; value?: string; delete?: boolean }[],
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request(
      'applyEdits',
      {
        file,
        // `value` is sent as RAW JSON text, never as a decoded object: a round trip through a
        // decoded value hands key order to the serialiser, which sorts map keys, and every
        // object an author wrote would come back reordered.
        edits: edits.map((e) => ({
          path: e.path,
          ...(e.delete ? { delete: true } : { value: e.value === undefined ? undefined : JSON.parse(e.value) }),
        })),
      },
      timeoutMs,
    )
  }

  /** Fetches the engine's own environment preset list (cmd/featurelab's `environments` method,
   * see that file's own doc comment) -- static, pack-independent data, so unlike generate() this
   * never calls ensurePackLoaded first. Populates panel.ts's Preset dropdown (see
   * previewPanel.ts's tryPostEnvironments) the same live-engine way entries/ruleEntries already
   * populate the Feature/Rule pickers, replacing the hand-transcribed STOPGAP_ENVIRONMENTS mirror
   * frontend/src/ui/environments.ts used to be. */
  async listEnvironments(timeoutMs: number): Promise<EnvironmentOptionWire[]> {
    const engine = this.ensureEngine()
    return (await engine.request('environments', {}, timeoutMs)) as EnvironmentOptionWire[]
  }

  /** Fetches the block-texture atlas (cmd/featurelab's `atlas` method, wire/atlas.go) -- the
   * table plus a base64 PNG, delivered over this same JSON-RPC channel rather than as a webview
   * asset, because the atlas is a runtime artifact in the user's cache directory and the
   * webview's localResourceRoots cannot reach it. Pack-independent like listEnvironments, so no
   * ensurePackLoaded.
   *
   * REJECTS ORDINARILY. "No atlas has been built" is the state every machine starts in and comes
   * back as a plain RpcError; the caller's recovery is to leave the preview on flat block
   * colours, which is what it draws by default anyway. */
  async loadAtlas(timeoutMs: number): Promise<AtlasWire> {
    const engine = this.ensureEngine()
    return (await engine.request('atlas', {}, timeoutMs)) as AtlasWire
  }

  /** Shuts the engine down for good. NOT reversible, and that irreversibility is the point --
   * see EngineDisposedError. Every later request on this object rejects with one rather than
   * quietly starting `binaryPath` over again. */
  dispose(): void {
    this.tombstoned = true
    this.engine?.dispose()
    this.engine = null
    this.loadedPackRoot = null
    this.lastLoad = null
    // Nothing can ride these any more: their engine is gone and a new caller must be refused,
    // not made to await a promise belonging to a dead process.
    this.inflightLoads.clear()
  }
}
