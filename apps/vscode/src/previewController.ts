// previewController.ts -- owns the one live EngineProcess for this extension session and the
// "load a pack once, reuse it for every regenerate" policy on top of it (EngineProcess itself
// only knows request/response plumbing, not loadPack/generate semantics).
import { EngineProcess } from './engineProcess.js'
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
 * put a message beside the node it belongs to. */
export interface GraphDiagnostic {
  level: string
  fileId: string
  message: string
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
    const { level, fileId, message } = entry as Partial<GraphDiagnostic>
    if (typeof level !== 'string' || typeof fileId !== 'string' || typeof message !== 'string') continue
    out.push({ level, fileId, message })
  }
  return out
}

// One step of an `annotateBatch`. Spelled in graph/groups.ts, the pure module that plans them, so
// the webview bundle can import the type without importing this file's Node dependencies.
export type { AnnotateOp } from './graph/groups.js'
import type { AnnotateOp } from './graph/groups.js'

export interface LoadPackResult {
  warnings: string[]
  featureCount: number
  structureCount: number
  ruleCount: number
  biomeCount: number
}

export class PreviewController {
  private engine: EngineProcess | null = null
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

  /** The engine binary every request on this controller runs against. Public because the
   * first-run texture flow (src/textures.ts) runs the SAME binary as a separate, short-lived
   * process -- a minutes-long download issued down this controller's one request channel
   * would block every generate behind it. */
  constructor(readonly binaryPath: string) {}

  private ensureEngine(): EngineProcess {
    if (this.engine && !this.engine.isCrashed()) return this.engine
    // Either never started, or the previous process crashed -- either way a fresh process
    // has no pack loaded, so the next generate() must go through loadPack again. In-flight
    // loads belong to the dead engine (their promises are already rejecting); dropping the map
    // entries now keeps a new caller from awaiting a dead engine's rejection instead of just
    // issuing a fresh loadPack against the new process.
    this.engine?.dispose()
    this.loadedPackRoot = null
    this.inflightLoads.clear()
    const engine = new EngineProcess(this.binaryPath, ['serve'])
    engine.start()
    this.engine = engine
    return engine
  }

  /** Issues the actual loadPack request and registers it in inflightLoads for the duration --
   * the single funnel both ensurePackLoaded and reloadPack put their requests through, so any
   * two concurrent loads of the same root collapse into one engine request. */
  private startLoad(engine: EngineProcess, packRoot: string, timeoutMs: number): Promise<LoadPackResult> {
    const load = (async () => {
      try {
        const result = (await engine.request('loadPack', { dir: packRoot }, timeoutMs)) as LoadPackResult
        this.loadedPackRoot = packRoot
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
      return result
    } catch {
      return this.reloadPack(packRoot, timeoutMs)
    }
  }

  async generate(packRoot: string, params: GenerateParams, timeoutMs: number): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    const engine = this.ensureEngine()
    return this.withCatalogs((p) => engine.request('generate', p, timeoutMs), params)
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
  async generateGrown(packRoot: string, params: GenerateParams, timeoutMs: number): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    const engine = this.ensureEngine()
    return this.withCatalogs((p) => engine.request('generateGrown', p, timeoutMs), params)
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
  async graph(packRoot: string, timeoutMs: number): Promise<unknown> {
    await this.ensurePackLoaded(packRoot, timeoutMs)
    return this.ensureEngine().request('graph', undefined, timeoutMs)
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

  dispose(): void {
    this.engine?.dispose()
    this.engine = null
    this.loadedPackRoot = null
  }
}
