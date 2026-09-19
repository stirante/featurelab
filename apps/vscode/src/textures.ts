// textures.ts -- the extension's half of the first run: finding out whether this machine can
// draw block textures, offering to fetch Mojang's sample resource pack if it cannot, and
// building the atlas.
//
// EVERY DECISION IS THE ENGINE'S. What is downloaded, from where, how big it is, where it is
// cached, when a "no" is remembered and what sentence to show in each state all come from
// featurelab/blocktextures via `featurelab textures --json`. This file spawns that command
// and reads its answer; it does not have its own opinion about any of it, because three hosts
// with three opinions about a download is exactly what the shared flow exists to prevent.
//
// WHY A SECOND PROCESS AND NOT THE LIVE ENGINE. `serve` answers one request line at a time, so
// a first-run download -- minutes, on a slow line -- issued down that channel would block every
// generate behind it and freeze the preview it is meant to improve. A short-lived process costs
// one spawn and leaves the engine free; the atlas it writes is picked up by the ordinary
// `atlas` method afterwards, which is the seam that was already there.
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

/** One `featurelab textures --status --json` answer: featurelab/blocktextures' Status. */
export interface TextureStatusWire {
  /** 'ready' (draw them), 'missing' (nothing built here yet), 'stale' (built from another
   * bedrock-samples tag, or without this pack's own blocks), 'broken' (present, unreadable),
   * 'declined' (this machine was asked once and said no -- never ask again). */
  state: 'ready' | 'missing' | 'stale' | 'broken' | 'declined'
  dir: string
  tag?: string
  wantTag: string
  pack?: string
  /** True when enabling textures would have to reach the network. The ONLY reason to ask the
   * user anything: a machine that already has the assets is not being asked for permission to
   * use its own disk. */
  needsDownload: boolean
  /** The engine's own description of that download -- what, from where, how large, whose, and
   * where it lands. Shown verbatim; a shorter paraphrase written here would be the vague
   * "featurelab wants to download something" the notice exists to avoid. */
  notice?: string
  /** One sentence for a person, in every state. */
  detail: string
  reason?: string
}

/** One per-block note: what a block draws as, when that is not what the pack declared. */
export interface TextureNoteWire {
  block: string
  fileId: string
  message: string
}

/** One block face whose texture key produced no image -- featurelab/blocktextures'
 * UnresolvedTexture, and wire.AtlasUnresolved, which are the same row. Named here rather than
 * spelled inline twice because the SAME rows arrive by two routes: on a build
 * (TextureResultWire.pack below) and on the atlas itself (unresolvedFromAtlas below), and a host
 * that reported them differently depending on which route they came in by would be telling the
 * same author two stories about one pack. */
export interface UnresolvedTextureWire {
  block: string
  face: string
  texture: string
  /** The sentence to show, when there is nothing better to group by. */
  reason: string
  /** The same finding as one stable token -- internal/packrender's vocabulary, listed in
   * UNRESOLVED_CODE_PHRASES below. Absent on an atlas built before codes existed. Grouping keys
   * off THIS, never off `reason`: matching on the prose would key this extension to an English
   * sentence the engine is free to reword. */
  code?: string
}

/** What each unresolved code MEANS to somebody who has to fix it -- one phrase per token, and
 * they are one phrase per DIFFERENT ACTION, which is the whole reason the codes are separate
 * from one another (see internal/packrender's own vocabulary comment).
 *
 * An unknown token is "unresolved, reason unclassified", never an error: that tolerance is what
 * lets the engine name a new failure mode without breaking a host, and this extension resolves
 * whatever `featurelab` binary it finds on disk. Such a row falls back to its own prose. */
const UNRESOLVED_CODE_PHRASES: Readonly<Record<string, string>> = {
  'no-resource-pack': 'no resource pack was found for this pack, so no texture key could resolve at all',
  'not-vanilla-no-resource-pack': 'the key is not one of vanilla’s, and this pack’s own resource pack was not found',
  'key-not-declared': 'the key is missing from the resource pack’s terrain_texture.json',
  'key-skipped': 'the key is in terrain_texture.json and that entry could not be read',
  'no-texture-path': 'the key is declared and names no path',
  'image-missing': 'the key names a path and there is no image behind it -- usually a PNG that was never exported',
  'no-texture-root': 'the key resolves to a path and this build was given no root to look it up in',
}

/** One `featurelab textures --json` build answer: featurelab/blocktextures' Result. */
export interface TextureResultWire {
  status: TextureStatusWire
  pack?: {
    dir: string
    resourcePack?: string
    how?: string
    blocks: number
    fully: number
    shapeCube: number
    untextured: number
    textures: number
    reused: number
    /** Per block face, WHY a texture key produced no image (featurelab/blocktextures'
     * PackSummary.Unresolved -- truncated, see `unresolvedTotal`). Without it `untextured` is a
     * bare number against blocks the preview is drawing as flat colours, which is the same thing
     * a machine with no atlas at all draws: the count alone cannot tell those two apart. */
    unresolved?: UnresolvedTextureWire[]
    unresolvedTotal?: number
  }
  notes?: TextureNoteWire[]
}

/** Injected in tests. Matches node:child_process' spawn closely enough for this file's use,
 * the same seam EngineProcess uses for the engine itself. */
export type SpawnFn = typeof spawn

export interface BuildOptions {
  /** The pack under test. Its own blocks go into the same atlas vanilla's do -- without it,
   * the blocks a pack defines itself stay flat hash colours, which on a large pack can be 40% of
   * the distinct block names a preview places. */
  packRoot?: string
  /** Permission to fetch. False never touches the network: an atlas is built only if the
   * assets are already on the machine. */
  download: boolean
  /** Receives the engine's progress lines (the download announcement, byte counts, the coarse
   * steps) as they arrive on stderr. */
  onProgress?: (line: string) => void
}

/** Thrown when the command exits non-zero. `detail` is what the engine said, already a
 * complete sentence -- offline, a proxy that broke TLS, an unwritable cache. */
export class TextureCommandError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message)
    this.name = 'TextureCommandError'
  }
}

export class TextureBuilder {
  constructor(
    private readonly binaryPath: string,
    private readonly spawnFn: SpawnFn = spawn,
  ) {}

  /** Reports what state this machine is in. Never downloads, never builds, never prompts --
   * `--json` also makes the engine's own terminal prompt unreachable, so this can never block
   * on a question nobody can see. */
  async status(packRoot?: string): Promise<TextureStatusWire> {
    const args = ['textures', '--status', '--json']
    if (packRoot) args.push('--pack', packRoot)
    return JSON.parse(await this.run(args)) as TextureStatusWire
  }

  /** Builds the atlas, downloading first when `download` says the user agreed to that. */
  async build(opts: BuildOptions): Promise<TextureResultWire> {
    const args = ['textures', '--json', '--yes']
    if (opts.packRoot) args.push('--pack', opts.packRoot)
    if (opts.download) args.push('--download')
    return JSON.parse(await this.run(args, opts.onProgress)) as TextureResultWire
  }

  /** Records that this machine said no, so no host -- this one, the desktop app, or the CLI --
   * asks again. */
  async decline(): Promise<void> {
    await this.run(['textures', '--decline', '--json'])
  }

  private run(args: string[], onProgress?: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>
      try {
        // stdin is closed, not piped: `--json` never prompts, and a command that cannot ask a
        // question cannot hang waiting for an answer no webview can type.
        child = this.spawnFn(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(new TextureCommandError('could not run the featurelab engine', err instanceof Error ? err.message : String(err)))
        return
      }
      let stdout = ''
      let stderr = ''
      let carry = ''
      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
        if (!onProgress) return
        // Progress arrives as whole lines; a chunk boundary can land mid-line, so the tail is
        // carried rather than reported as a truncated sentence.
        carry += chunk
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed) onProgress(trimmed.replace(/^featurelab:\s*/, ''))
        }
      })
      child.on('error', (err) => {
        reject(new TextureCommandError('could not run the featurelab engine', err.message))
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout)
          return
        }
        // The engine prints one sentence for every failure it has. Prefer it over an exit code
        // nobody can act on.
        const detail = stderr.trim() || stdout.trim() || `exit code ${String(code)}`
        reject(new TextureCommandError('block textures could not be built', detail.replace(/^featurelab:\s*/, '')))
      })
    })
  }
}

/** Collects the per-block "this is not quite what you declared" notes out of an atlas table.
 *
 * They ride in the table itself (internal/atlas' Block.Note) rather than in a separate report
 * for one reason: the table is what reaches the thing that draws the block, so the note is
 * available whether the atlas was built a moment ago or a week ago. Reads the wire shape
 * loosely -- this module never decodes an atlas, it only mines one field out of it. */
export function notesFromAtlas(atlas: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const blocks = (atlas as { table?: { blocks?: unknown } } | null)?.table?.blocks
  if (!blocks || typeof blocks !== 'object') return out
  for (const [name, entry] of Object.entries(blocks as Record<string, unknown>)) {
    const note = (entry as { note?: unknown })?.note
    if (typeof note === 'string' && note !== '') out.set(name, note)
  }
  return out
}

/** The unresolved-texture rows an ATLAS response carries, when it carries any --
 * wire.AtlasOutput's own `unresolved` / `unresolvedTotal`, both at the TOP LEVEL beside `table`
 * and `png`.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BUILD RESULT. The rows above (TextureResultWire.pack
 * .unresolved) only exist on a run that BUILT the atlas, and the ordinary case is the opposite
 * one: the atlas was built last week, this preview finds it ready, builds nothing, and every
 * pack block whose texture key never resolved draws as a flat colour with nothing anywhere
 * saying which ones or why. Carrying the same rows on the atlas closes that gap, because the
 * atlas is the thing that is still there a week later.
 *
 * ABSENCE MEANS "NOTHING UNRESOLVED", NOT "OLD ENGINE". Both fields are omitempty on the Go
 * side, so an atlas that textured everything is byte-for-byte the response it always was -- and
 * an engine too old to record any of this is indistinguishable from a pack with nothing wrong
 * with it, which is the right way round: this is extra information about a preview and must
 * never be the reason one looks broken.
 *
 * THE TOTAL IS NOT THE LENGTH. `unresolved` is capped (20 rows, blocktextures.UnresolvedLimit)
 * and `unresolvedTotal` is the real count -- a pack that ships no resource pack at all has one
 * row per face of every block it defines. Reading the total off the array would tell somebody
 * with 57 broken faces that they have 20.
 *
 * Read loosely, and malformed entries are dropped one by one rather than throwing the atlas
 * away -- a bad row in a diagnostic list must never cost somebody their preview. */
export function unresolvedFromAtlas(atlas: unknown): { rows: UnresolvedTextureWire[]; total: number } {
  const root = atlas as { unresolved?: unknown; unresolvedTotal?: unknown } | null | undefined
  if (typeof root !== 'object' || root === null) return { rows: [], total: 0 }
  const rows = unresolvedRows(root.unresolved)
  return { rows, total: unresolvedTotal(root.unresolvedTotal, rows.length) }
}

/** The rows of an `unresolved` array that are actually rows. `code` is carried through when the
 * engine sent one and simply absent when it did not -- an empty string would look like a token
 * to every grouping downstream. */
export function unresolvedRows(value: unknown): UnresolvedTextureWire[] {
  if (!Array.isArray(value)) return []
  const rows: UnresolvedTextureWire[] = []
  for (const entry of value) {
    const { block, face, texture, reason, code } = (entry ?? {}) as Partial<UnresolvedTextureWire>
    if (typeof block !== 'string' || typeof face !== 'string' || typeof texture !== 'string' || typeof reason !== 'string') continue
    rows.push({ block, face, texture, reason, ...(typeof code === 'string' && code.length > 0 ? { code } : {}) })
  }
  return rows
}

/** The engine's own count, or the number of rows that arrived when it did not send one. Never
 * less than the rows in hand: a total below what is already on screen would print a negative
 * remainder. */
export function unresolvedTotal(value: unknown, rowCount: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > rowCount ? Math.trunc(value) : rowCount
}

/** What to write in the output channel about the faces this atlas could not texture: a headline
 * carrying the REAL total, then the sample grouped by what an author would have to do about it.
 *
 * GROUPED BY CODE, NOT BY PROSE. The codes are a closed vocabulary and each one names a
 * different fix (see UNRESOLVED_CODE_PHRASES); the sentences are English the engine is free to
 * reword. A row whose code this build does not recognise -- or that carries none at all -- keeps
 * its own sentence as its heading, so a new failure mode reads as one more group rather than as
 * nothing at all.
 *
 * The headline says the total and the sample says it is a sample, because those are two
 * different numbers and the one somebody needs is the one the engine counted: twenty lines under
 * a heading that says twenty is how a pack with fifty-seven broken faces looks fixed. */
export function summarizeUnresolved(rows: readonly UnresolvedTextureWire[], total: number): string[] {
  if (rows.length === 0 && total === 0) return []
  const capped = total > rows.length
  const out: string[] = [
    capped
      ? `Block textures: ${String(total)} block face(s) in this pack have no image in the atlas and draw as a flat colour. The ${String(rows.length)} below are a sample; run "featurelab blocktable" for the full list.`
      : `Block textures: ${String(total)} block face(s) in this pack have no image in the atlas and draw as a flat colour.`,
  ]
  // Insertion-ordered, so the groups come out in the order the engine reported them rather than
  // in an order this file invented.
  const groups = new Map<string, { heading: string; rows: UnresolvedTextureWire[] }>()
  for (const row of rows) {
    const phrase = row.code === undefined ? undefined : UNRESOLVED_CODE_PHRASES[row.code]
    const key = phrase === undefined ? `reason:${row.reason}` : `code:${row.code ?? ''}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { heading: phrase ?? row.reason, rows: [row] })
    else group.rows.push(row)
  }
  for (const group of groups.values()) {
    out.push(`  ${group.heading} (${String(group.rows.length)}):`)
    for (const row of group.rows) out.push(`    ${row.block} (${row.face} face, texture "${row.texture}")`)
  }
  if (capped) out.push(`  ... and ${String(total - rows.length)} more not shown.`)
  return out
}

/** Picks out the notes for the blocks a given preview actually PLACED.
 *
 * A pack can define two hundred blocks and a preview place a handful of them, so the whole
 * note list is noise: the ones worth telling someone about are the ones they are looking at.
 * `palette` is a generate response's own palette array (`[{name}, ...]`), read loosely on
 * purpose -- this module never decodes a result, it only filters against it. */
export function notesForPalette(notes: ReadonlyMap<string, string>, palette: unknown): { block: string; message: string }[] {
  if (notes.size === 0 || !Array.isArray(palette)) return []
  const seen = new Set<string>()
  const out: { block: string; message: string }[] = []
  for (const entry of palette as { name?: unknown }[]) {
    const name = entry && typeof entry.name === 'string' ? entry.name : null
    if (name === null || seen.has(name)) continue
    seen.add(name)
    const message = notes.get(name)
    if (message !== undefined) out.push({ block: name, message })
  }
  return out.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
}
