// previewController.test.ts -- exercises PreviewController's loadPack/reloadPack/generate
// policy against the same fake `serve` engine engineProcess.test.ts already uses (a real child
// process, not a mocked one), proving:
//   - a pack is loaded on the first generate() for a given root, and NOT reloaded on a second
//     generate() for the SAME root ("load once, reuse it for every regenerate" -- must not
//     restart/reload the engine per change)
//   - reloadPack() (wired to panel.ts's "Reload files" button via previewPanel.ts) DOES
//     unconditionally re-issue loadPack even when the root hasn't changed
//   - reloadPackFile() (the save path) re-reads ONLY the saved file, invalidates the catalogue
//     cache exactly as a full load does, and falls back to a full loadPack the moment the
//     engine cannot do the single-file update -- the fallback being the thing that makes the
//     whole fast path safe to have
//   - generate() forwards whatever GenerateParamsWire it's given verbatim to the engine's
//     "generate" method -- this is the seam previewPanel.ts's lastParams fallback logic feeds
//     into, so a param object built by panel.ts (minY/biomeId/biomeTags/materials included)
//     reaches the wire unmodified.
import { describe, expect, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EngineDisposedError, PreviewController } from '../src/previewController.js'
import { EngineProcess, type EngineNotification } from '../src/engineProcess.js'

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/loadpack-fake-engine.mjs', import.meta.url))

let current: PreviewController | null = null
afterEach(() => {
  current?.dispose()
  current = null
})

/** Builds a PreviewController wired at the EngineProcess level to the fake engine -- there is
 * no public seam to inject a binary path other than "the real executable to spawn", so this
 * subclasses just enough to redirect spawning at construction, mirroring how
 * engineProcess.test.ts drives its own fake engine (process.execPath + a script arg). */
class TestPreviewController extends PreviewController {
  constructor() {
    super(process.execPath)
  }
}

// PreviewController.ensureEngine hardcodes `new EngineProcess(this.binaryPath, ['serve'])` --
// binaryPath is the real featurelab.exe path in production. Passing process.execPath (node)
// with the fake engine as ['serve'] wouldn't work (node doesn't understand 'serve' as a
// script). Instead this test constructs EngineProcess directly against the fake engine and
// drives loadPack/generate through it, then separately verifies PreviewController's OWN policy
// (cache/reload/forwarding) using a controller built with a stub binaryPath is not viable
// without a spawn seam -- so this file tests the two layers at the level each actually offers
// a seam: EngineProcess directly (already covered by engineProcess.test.ts) plus
// PreviewController's request-shaping/caching logic against a real EngineProcess pointed at the
// fake engine via the same spawnFn override EngineProcess itself exposes for tests.
function makeController(onProgress?: (note: EngineNotification) => void): PreviewController {
  const ctl = new PreviewController(process.execPath, () => {}, onProgress)
  // Monkeypatch: replace the lazily-constructed engine with one driving the fake script, by
  // handing it to the controller's own attachEngine via a cast -- avoids needing a second
  // constructor parameter in production code just for tests, while still going through the
  // production code that decides which of the engine's events the host hears. See ensureEngine()'s
  // own "either never started, or crashed" contract: as long as this engine reports
  // !isCrashed(), ensureEngine() reuses it verbatim, which is exactly what every assertion below
  // needs to hold.
  const engine = new EngineProcess(process.execPath, [FAKE_ENGINE])
  engine.start()
  ;(ctl as unknown as { attachEngine(engine: EngineProcess): void }).attachEngine(engine)
  return ctl
}

describe('PreviewController', () => {
  // The response assertions below use toMatchObject rather than toEqual: the fake engine also
  // returns the three pack catalogues (see its own `catalogs` helper), and whether those are
  // present or spliced back in from the controller's cache is the subject of the catalogue
  // tests at the bottom of this file, not of the forwarding tests up here.
  it('loads a pack on the first generate() for a root', async () => {
    const ctl = makeController()
    current = ctl
    const result = await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    expect(result).toMatchObject({ echo: 'generate', params: { feature: 'f1' } })
  })

  it('does not re-issue loadPack for a second generate() against the SAME root', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    const second = await ctl.generate('/pack/a', { feature: 'f2' }, 2000)
    expect(second).toMatchObject({ echo: 'generate', params: { feature: 'f2' } })
    // The fake engine's loadPack call counter is exposed via a dedicated method below.
    const loadCount = await requestLoadCount(ctl)
    expect(loadCount).toBe(1)
  })

  it('reloadPack() re-issues loadPack even when the root has not changed', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    await ctl.reloadPack('/pack/a', 2000)
    const loadCount = await requestLoadCount(ctl)
    expect(loadCount).toBe(2)
  })

  // The pre-warm seam (extension.ts's maybePrewarm) makes "two callers ask for the same
  // not-yet-loaded root at once" the NORMAL first-preview shape: the background warm-up and the
  // user's actual preview command race. Without in-flight coalescing each issues its own full
  // loadPack (~730ms measured on a real pack), serialized on the same engine -- the pre-warm
  // would then make the first preview SLOWER, not faster.
  it('coalesces two concurrent loads of the SAME root into one loadPack request', async () => {
    const ctl = makeController()
    current = ctl
    const [a, b] = await Promise.all([ctl.generate('/pack/a', { feature: 'f1' }, 2000), ctl.generate('/pack/a', { feature: 'f2' }, 2000)])
    expect(a).toMatchObject({ echo: 'generate', params: { feature: 'f1' } })
    expect(b).toMatchObject({ echo: 'generate', params: { feature: 'f2' } })
    const loadCount = await requestLoadCount(ctl)
    expect(loadCount).toBe(1)
  })

  it('coalesces a reloadPack() racing an ensurePackLoaded() for the same root', async () => {
    const ctl = makeController()
    current = ctl
    const [ensured, reloaded] = await Promise.all([ctl.ensurePackLoaded('/pack/a', 2000), ctl.reloadPack('/pack/a', 2000)])
    // reloadPack rode the in-flight load; ensurePackLoaded initiated it, so IT carries the result.
    expect(ensured?.featureCount).toBe(1)
    expect(reloaded.featureCount).toBe(1)
    const loadCount = await requestLoadCount(ctl)
    expect(loadCount).toBe(1)
  })

  it('loads a NEW pack when generate() is called against a different root', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    await ctl.generate('/pack/b', { feature: 'f2' }, 2000)
    const loadCount = await requestLoadCount(ctl)
    expect(loadCount).toBe(2)
  })

  it('forwards a full GenerateParamsWire (minY/biomeId/biomeTags/materials) to the engine unmodified', async () => {
    const ctl = makeController()
    current = ctl
    const params = {
      feature: 'wiki:poplar_tree',
      env: 'plains',
      minY: -64,
      biomeId: 'wiki:crater',
      biomeTags: ['overworld', 'forest'],
      materials: { topMaterial: 'minecraft:diamond_block', seaFloorDepth: 5 },
    }
    const result = await ctl.generate('/pack/a', params, 2000)
    expect(result).toMatchObject({ echo: 'generate', params })
  })

  it('generateGrown() calls the engine’s "generateGrown" method (not "generate"), forwarding params verbatim', async () => {
    const ctl = makeController()
    current = ctl
    const params = { feature: 'test:root', env: 'void', origin: '0,0,0', size: '8x8x8' }
    const result = await ctl.generateGrown('/pack/a', params, 2000)
    expect(result).toMatchObject({ echo: 'generateGrown', params, grown: true, preGrowBounds: { minX: -4, minY: 0, minZ: -4, sizeX: 8, sizeY: 8, sizeZ: 8 } })
  })

  it('generateGrown() shares the same "load once per root" pack-loading policy as generate()', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    await ctl.generateGrown('/pack/a', { feature: 'f1' }, 2000)
    const loadCount = await requestLoadCount(ctl)
    expect(loadCount).toBe(1) // second call reused the already-loaded pack for the SAME root
  })


  // --- the save path: reloadPackFile() ---------------------------------------------------
  //
  // A full reloadPack of a real 3.5k-feature pack measures ~680ms warm; the same save routed
  // through reloadPackFile measures ~70ms. These cases pin the three things that make that
  // trade honest rather than merely fast.

  it('reloadPackFile() re-reads only the saved file, without re-issuing loadPack', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    await ctl.reloadPackFile('/pack/a', '/pack/a/features/f1.json', 2000)
    const counts = await requestCounts(ctl)
    expect(counts.reloadFileCount).toBe(1)
    expect(counts.loadCount).toBe(1) // still just the original load
  })

  it('falls back to a full loadPack whenever the engine refuses the single-file update', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    // The fixture refuses any path containing 'refuse', standing in for every reason the real
    // engine gives one (outside the pack, another pack's file, a kind it never loaded).
    const result = await ctl.reloadPackFile('/pack/a', '/pack/a/refuse/me.json', 2000)
    // The caller gets a real LoadPackResult, not a rejection -- the fallback is the answer,
    // not an error to be handled again upstream.
    expect(result.featureCount).toBe(1)
    const counts = await requestCounts(ctl)
    expect(counts.reloadFileCount).toBe(1)
    expect(counts.loadCount).toBe(2)
  })

  it('a refused single-file reload still leaves the catalogues re-fetched, like the full load it became', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'x' }, 2000)
    await ctl.reloadPackFile('/pack/a', '/pack/a/refuse/me.json', 2000)
    const after = (await ctl.generate('/pack/a', { feature: 'x' }, 2000)) as { params: Record<string, unknown> }
    expect(after.params.omitCatalogs).toBeUndefined()
  })

  it('re-fetches the catalogues after a single-file reload, since the saved file may have added or removed a feature', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'x' }, 2000)
    await ctl.reloadPackFile('/pack/a', '/pack/a/features/x.json', 2000)
    const after = (await ctl.generate('/pack/a', { feature: 'x' }, 2000)) as { params: Record<string, unknown>; entries: unknown }
    expect(after.params.omitCatalogs).toBeUndefined()
    expect(after.entries).toEqual([{ fileId: 'a.json', identifier: 'test:a', typeId: 'minecraft:single_block_feature' }])
  })

  it('does a full load instead when the file belongs to a pack that is not the loaded one', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)
    await ctl.reloadPackFile('/pack/b', '/pack/b/features/f1.json', 2000)
    const counts = await requestCounts(ctl)
    expect(counts.reloadFileCount).toBe(0)
    expect(counts.loadCount).toBe(2)
  })

  it('does a full load instead when nothing has been loaded yet (a freshly started or restarted engine)', async () => {
    const ctl = makeController()
    current = ctl
    // No generate()/ensurePackLoaded() first -- the same state ensureEngine() leaves behind
    // after a crash, where the new process holds no pack at all.
    await ctl.reloadPackFile('/pack/a', '/pack/a/features/f1.json', 2000)
    const counts = await requestCounts(ctl)
    expect(counts.reloadFileCount).toBe(0)
    expect(counts.loadCount).toBe(1)
  })

  it('listEnvironments() returns the engine’s own preset list, and needs no pack loaded first', async () => {
    const ctl = makeController()
    current = ctl
    // Deliberately no generate()/loadPack() call before this -- see PreviewController.
    // listEnvironments's own doc comment: environments is pack-independent, static data.
    const environments = await ctl.listEnvironments(2000)
    expect(environments.map((e) => e.id)).toEqual(['plains', 'void'])
    const plains = environments.find((e) => e.id === 'plains')!
    expect(plains.defaults).toEqual({ sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 })
    expect(plains.materials.topMaterial).toBe('minecraft:grass_block')
    expect(plains.biomeTags).toContain('plains')
    // buildsSea rides along on the same response -- it is what the panel's Materials section
    // gates its three sea slots on (see frontend/src/ui/panel.ts), so it has to survive the
    // round trip like every other field, not just exist on the Go side.
    expect(plains.buildsSea).toBe(false)
  })
  // The pack catalogues -- entries/ruleEntries/biomeEntries -- describe the loaded pack, not the
  // run, and they dominate a repeated preview: on a real pack a response is around 976 KB of
  // compact JSON and `entries` alone is 531 KB, re-sent on every save. PreviewController fetches
  // them once per load and asks the engine to omit them after that, splicing its cached copy
  // back in so nothing downstream can tell the difference. These four cases pin all of that,
  // including the part that matters most: the caller's result shape never changes.
  it('fetches the pack catalogues once and omits them from every later generate', async () => {
    const ctl = makeController()
    current = ctl
    const first = (await ctl.generate('/pack', { feature: 'x' }, 2000)) as { params: Record<string, unknown>; entries: unknown }
    expect(first.params.omitCatalogs).toBeUndefined()
    expect(first.entries).toEqual([{ fileId: 'a.json', identifier: 'test:a', typeId: 'minecraft:single_block_feature' }])

    const second = (await ctl.generate('/pack', { feature: 'x' }, 2000)) as { params: Record<string, unknown>; entries: unknown; ruleEntries: unknown; biomeEntries: unknown }
    expect(second.params.omitCatalogs).toBe(true)
    // ...and the caller still sees them, because the controller put its cached copy back.
    expect(second.entries).toEqual(first.entries)
    expect(second.ruleEntries).toEqual([{ fileId: 'r.json', identifier: 'test:r.fr', rule: null }])
    expect(second.biomeEntries).toEqual([{ fileId: 'b.json', identifier: 'test:b', biome: null }])
  })

  it('re-fetches the catalogues after a reload, since that is when they can change', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack', { feature: 'x' }, 2000)
    await ctl.reloadPack('/pack', 2000)
    const afterReload = (await ctl.generate('/pack', { feature: 'x' }, 2000)) as { params: Record<string, unknown> }
    expect(afterReload.params.omitCatalogs).toBeUndefined()
  })

  it('re-fetches the catalogues when a different pack is loaded', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack-a', { feature: 'x' }, 2000)
    const other = (await ctl.generate('/pack-b', { feature: 'x' }, 2000)) as { params: Record<string, unknown> }
    expect(other.params.omitCatalogs).toBeUndefined()
  })

  it('shares the cache between generate() and generateGrown()', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack', { feature: 'x' }, 2000)
    const grown = (await (ctl as unknown as { generateGrown(root: string, params: unknown, ms: number): Promise<unknown> }).generateGrown('/pack', { feature: 'x' }, 2000)) as {
      params: Record<string, unknown>
      entries: unknown
      grown: boolean
    }
    expect(grown.params.omitCatalogs).toBe(true)
    expect(grown.entries).toEqual([{ fileId: 'a.json', identifier: 'test:a', typeId: 'minecraft:single_block_feature' }])
    expect(grown.grown).toBe(true)
  })
})

async function requestLoadCount(ctl: PreviewController): Promise<number> {
  return (await requestCounts(ctl)).loadCount
}

/** Both of the fake engine's own request counters: how many full loadPacks it has been asked
 * for, and how many single-file reloadFiles. Which of the two a call turned into is the entire
 * subject of the reloadPackFile cases below -- a fallback that quietly stopped falling back,
 * or a save that quietly stopped being incremental, both show up here and nowhere else. */
async function requestCounts(ctl: PreviewController): Promise<{ loadCount: number; reloadFileCount: number }> {
  const engine = (ctl as unknown as { engine: EngineProcess }).engine
  return (await engine.request('loadCount')) as { loadCount: number; reloadFileCount: number }
}

// ---------------------------------------------------------------------------
// The engine's own progress, on its way to the host.
//
// EngineProcess raises it and progress.ts turns it into words; this is the link between them,
// and it is the link that did not exist. Until it did, a loadPack that the engine was reporting
// on once a second reached the host as nothing at all.
// ---------------------------------------------------------------------------
describe('progress notifications', () => {
  it('forwards a progress line for a running request to the host, without disturbing the response', async () => {
    const seen: EngineNotification[] = []
    const ctl = makeController((note) => seen.push(note))
    current = ctl

    const summary = await ctl.loadPackSummary('/pack/a', 2000)

    // The response is exactly what it always was -- the notification is an extra line in front
    // of it, not a change to it.
    expect(summary).toMatchObject({ featureCount: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'progress', method: 'loadPack', phase: 'features', files: 8070, elapsedMs: 1755 })
  })

  it('costs a controller with nobody listening nothing at all', async () => {
    // Every caller that predates this -- and every test above -- passes no sink. The default has
    // to be a no-op rather than a requirement, or adding progress would have been a breaking
    // change to a constructor half the extension uses.
    const ctl = makeController()
    current = ctl
    await expect(ctl.loadPackSummary('/pack/a', 2000)).resolves.toMatchObject({ featureCount: 1 })
  })
})

// ---------------------------------------------------------------------------
// A disposed controller stays disposed.
//
// THE BUG THIS PINS, in the words of the person who hit it: "I changed
// featurelab.binaryPath and the preview kept running the old engine." dispose() nulled `engine`,
// and ensureEngine() reads a null `engine` as "never started" and spawns `binaryPath` again -- so
// the controller extension.ts had just thrown away rebuilt itself on the next request, against
// the OLD binary, with its own copy of the pack loaded and no probe ever run against it. A panel
// captures its controller at construction and cannot be re-bound, so this was silent and
// permanent for that panel: the run succeeded, the picture updated, and the engine answering was
// the one the user believed they had stopped using.
//
// Measured before the fix, in this same harness: dispose() followed by generate() spawned a
// second process. That is what the first case below now forbids.
// ---------------------------------------------------------------------------
describe('a disposed PreviewController', () => {
  it('refuses the next generate instead of restarting the old binary', async () => {
    const ctl = makeController()
    current = ctl
    await ctl.generate('/pack/a', { feature: 'f1' }, 2000)

    ctl.dispose()

    await expect(ctl.generate('/pack/a', { feature: 'f2' }, 2000)).rejects.toThrow(EngineDisposedError)
    // And it did not quietly start one on the way to refusing.
    expect((ctl as unknown as { engine: EngineProcess | null }).engine).toBeNull()
  })

  it('names the binary and the remedy, because the panel holding it cannot do anything else', async () => {
    const ctl = makeController()
    current = ctl
    ctl.dispose()

    const err: Error = await ctl.generate('/pack/a', { feature: 'f1' }, 2000).then(
      () => new Error('the disposed controller answered instead of refusing'),
      (e: unknown) => e as Error,
    )

    // The path, because "which engine is this" is the question somebody who just changed the
    // setting is actually asking.
    expect(err.message).toContain(process.execPath)
    expect(err.message).toMatch(/binaryPath/)
    // And a thing to DO. A panel cannot swap its own controller, so the only honest instruction
    // is to open a new one.
    expect(err.message).toMatch(/open it again|reopen/i)
  })

  it('refuses every other request on the same object, not only generate', async () => {
    const ctl = makeController()
    current = ctl
    ctl.dispose()

    await expect(ctl.loadPackSummary('/pack/a', 2000)).rejects.toThrow(EngineDisposedError)
    await expect(ctl.reloadPack('/pack/a', 2000)).rejects.toThrow(EngineDisposedError)
    await expect(ctl.reloadPackFile('/pack/a', 'features/x.json', 2000)).rejects.toThrow(EngineDisposedError)
    await expect(ctl.graph('/pack/a', 2000)).rejects.toThrow(EngineDisposedError)
    await expect(ctl.listTypes(2000)).rejects.toThrow(EngineDisposedError)
    await expect(ctl.loadAtlas(2000)).rejects.toThrow(EngineDisposedError)
    await expect(ctl.listEnvironments(2000)).rejects.toThrow(EngineDisposedError)
  })

  it('says so before it is asked, so a holder can report it rather than wait to fail', async () => {
    const ctl = makeController()
    current = ctl
    expect(ctl.isDisposed()).toBe(false)
    ctl.dispose()
    expect(ctl.isDisposed()).toBe(true)
  })

  it('tolerates being disposed twice, which is what a torn-down window does', () => {
    const ctl = makeController()
    current = ctl
    ctl.dispose()
    expect(() => ctl.dispose()).not.toThrow()
  })
})
