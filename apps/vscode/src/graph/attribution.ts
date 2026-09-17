// attribution.ts -- the two-way link between a graph node and the blocks it actually placed.
//
// The engine already records, for every write, which feature was innermost on the delegation
// stack at the time (profiler/profiler.go's RecordWrite). That arrives on the `generate`
// response as profile.attribution: three PARALLEL arrays, one row each, where row i means
// "feature featureIdentifiers[feature[i]] wrote cell cell[i], count[i] times". This module turns
// that table into the two lookups an editor needs and neither direction of the wire gives:
//
//   node id -> the cells that node wrote     (click a node, highlight its blocks)
//   cell    -> the node ids that wrote it    (click a block, find the node that placed it)
//
// Deliberately headless -- no DOM, no VS Code API, no file I/O -- so it runs in the extension
// host, in the webview, and in a test against a literal profile, the same way layout.ts does.
//
// # A node id IS a feature identifier
//
// wire/graph.go gives every GraphNode an ID of "namespace:identifier", and that is character-for-
// character the same string profiler.FeatureProfileStats.Identifier carries. No translation table
// is needed or wanted; this module joins the graph to the profile on that string directly.
//
// A feature RULE appears only when the run placed that rule: session.Generate pushes a frame for
// it (typeId "minecraft:feature_rules") around each placement, so its biome-filter and chance
// stops land on its row. A rule node absent from the profile means this run did not place it --
// see nodeStats.ts, which is where that is phrased.
//
// # What it costs, and why this shape
//
// The table is sparse: one row per distinct (cell, feature) pair, not one per cell. A run that
// carves 9 219 cells out of a 96x384x96 volume produces on the order of 9 000 rows, not 3.5
// million. But the worst case -- a feature that rewrites the whole volume -- is exactly the
// volume's cell count, and that is the size this is built for.
//
// The stored index is FIVE typed arrays and nothing else:
//
//	cell           Uint32Array(rows)     4 bytes/row
//	feature        Uint16Array(rows)     2 bytes/row
//	count          Uint32Array(rows)     4 bytes/row
//	byCell         Uint32Array(rows)     4 bytes/row   row indices in ascending cell order
//	featureOffsets Uint32Array(nodes+2)  ~0            span start per feature, plus two sentinels
//
// -- 14 bytes per row, so 3.5 million rows costs about 49 MB and a realistic preview costs well
// under a megabyte. `byteLength` reports the exact figure rather than an estimate.
//
// The alternative shapes were rejected on that number. A `Map<number, number[]>` from cell to
// writers is the obvious build, and at a million entries it costs somewhere north of 80 bytes an
// entry once the map's own slots and each array's object header are counted -- five to six times
// this, for a structure the garbage collector then has to walk. A dense `Int32Array(cellCount)`
// of "the node that wrote this cell" is cheap to look up and cannot answer the question that
// makes this module worth building, because it can only hold one writer per cell.
//
// So: the rows are sorted ONCE at build time into (feature, cell) order, which makes every cell a
// node wrote a contiguous, ascending run that needs no per-row index at all -- `featureOffsets`
// is the whole node->cells direction. The other direction gets one Uint32Array of row indices in
// cell order and a binary search over it. Sorting is two linear passes, not a comparator sort: an
// LSD radix sort on the 32-bit cell, then a stable counting sort on the feature (there are
// hundreds of features at most, so its bucket array is trivial). A comparator sort of 3.5 million
// rows would mean ~75 million calls into a JS closure; this is four byte passes and one bucket
// pass, and it is stable, which is what makes the two sorts compose into one ordering.
//
// Peak memory DURING the build is higher than the resident figure -- two index permutations and
// the radix scratch buffer, about 12 more bytes per row -- and all of it is dropped before the
// index is returned.
//
// Measured on the worst case that exists, 3 538 944 rows (every cell of a 96x384x96 volume
// written, 120 features, rows handed in deliberately unsorted): 667 ms to build, 49.5 MB
// resident, 10 000 cell lookups in 5 ms. The build cost is real and belongs on a `generate`
// response, not on a click; the lookups are what a click pays.
//
// # A cell written by several features
//
// This is the normal case, not a corner: a sequence feature whose second entry overwrites the
// first, a scatter that lands twice on one cell, a tree trunk and its decoration meeting. The
// wire table has one row per (cell, feature) pair, so all of those writers survive it, each with
// its own count.
//
// WHAT THIS MODULE REPORTS IS ALL OF THEM -- `writersOf` returns every feature that wrote the
// cell, with how many times each did, never a single "the" writer.
//
// That is not a UI preference, it is the only honest answer available. The block a viewer sees at
// that cell is whatever the LAST write put there, and the last writer is NOT recoverable from
// this contract: the engine accumulates into a map keyed on (cell, feature) and emits it in Go
// map order, so the table carries counts and no sequence whatsoever. Picking one row and calling
// it the placer would be a guess dressed as an answer, and it would be wrong precisely in the
// case a person clicked the block to understand -- two features fighting over one cell.
//
// The returned order is deterministic (ascending feature index, i.e. the order the features were
// first entered during the run) so a UI renders stably across reloads. That order is a fact about
// the whole run, not about this cell, and must not be presented as "first" or "last".

/** The generated volume's extent, as `generate` reports it (wire.Bounds). Accepted as the
 * structural subset this module reads, so a decoded GenerateOutput["bounds"] is assignable and a
 * six-field literal in a test is too. Optional throughout: a cell index is a perfectly good
 * handle on its own, and bounds are only needed to turn one into a world position. */
export interface CellBounds {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly sizeX: number
  readonly sizeY: number
  readonly sizeZ: number
}

/** A world-space block position (wgen.BlockPos). */
export interface BlockPosition {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Total cells in a volume. */
export function cellCount(bounds: CellBounds): number {
  return bounds.sizeX * bounds.sizeY * bounds.sizeZ
}

/** World position -> flat cell index, or -1 when the position is outside the volume.
 *
 * The layout is the engine's own (wire/wire.go, "Block array indexing"): Y is the OUTER axis,
 * then Z, then X fastest-varying. Every per-cell array on the response -- blocks, baseline, the
 * changed/removed masks, profile.touchCounts and this module's cell column -- indexes the same
 * way, so a cell index means the same thing to all of them.
 *
 * -1 rather than a throw because out of bounds is an ordinary thing for a click to be: the
 * preview camera can see past the generated volume, and the engine itself captures out-of-bounds
 * writes separately (GenerateOutput.overflowBlocks) rather than treating them as an error. */
export function cellIndexOf(bounds: CellBounds, pos: BlockPosition): number {
  const dx = pos.x - bounds.minX
  const dy = pos.y - bounds.minY
  const dz = pos.z - bounds.minZ
  if (dx < 0 || dy < 0 || dz < 0) return -1
  if (dx >= bounds.sizeX || dy >= bounds.sizeY || dz >= bounds.sizeZ) return -1
  return dy * bounds.sizeX * bounds.sizeZ + dz * bounds.sizeX + dx
}

/** Flat cell index -> world position, or null when the index is outside the volume. The exact
 * inverse of cellIndexOf. */
export function cellPositionOf(bounds: CellBounds, cell: number): BlockPosition | null {
  if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount(bounds)) return null
  const layer = bounds.sizeX * bounds.sizeZ
  const y = Math.floor(cell / layer)
  const rest = cell - y * layer
  const z = Math.floor(rest / bounds.sizeX)
  const x = rest - z * bounds.sizeX
  return { x: x + bounds.minX, y: y + bounds.minY, z: z + bounds.minZ }
}

// ---------------------------------------------------------------------------
// Run-length decoding
// ---------------------------------------------------------------------------

/** The cap `rle.expand` enforces on the Go side, mirrored here for the same reason: the encoding's
 * whole point is that a few bytes expand into millions of cells, so `{"rle":[0,999999999999]}` is
 * nine bytes that would otherwise ask for terabytes. 2^28 cells is a 640x640x640 volume, an order
 * of magnitude past anything this tool generates, so the cap can only fire on input that was
 * already wrong. */
export const RLE_MAX_CELLS = 1 << 28

/** Decodes one of the response's per-cell arrays, in any of the three shapes this contract has
 * emitted (see package featurelab-go/rle, which this mirrors exactly):
 *
 *   - `{"rle": [value, runLength, ...]}` -- what the engine emits now. Run lengths are >= 1 and
 *     the pairs are exhaustive, so the cell count is the sum of every second element.
 *   - `[v, v, v, ...]` -- the dense array it emitted before, still accepted so an older captured
 *     response decodes unchanged.
 *   - `"base64"` -- the old one-byte-per-cell encoding for the changed/removed masks.
 *
 * `null`/`undefined` decode to `null`, not to an empty array: an absent per-cell array is a
 * legitimate state (profile.touchCounts on an unprofiled run), and conflating "no array" with "a
 * volume of zero cells" would make a missing array look like a valid empty answer. A caller that
 * knows the volume's own cell count should check `decoded.length` against it -- a mismatch means a
 * truncated or hand-edited response, not a small volume.
 *
 * Int32Array because every array this encoding is used for on this contract fits it: blocks and
 * baseline are int32 block ids by the wire spec, the masks are 0/1, and a touch count is bounded
 * by the run's write budget (4 000 000 by default, session.DefaultWriteBudget).
 *
 * NOTE that profile.attribution is NOT run-length encoded -- it is sparse already, and carries
 * plain arrays. This function is for the DENSE per-cell arrays that share attribution's indexing,
 * touchCounts above all: it is what turns "this node wrote cell 91 020" into "and that cell was
 * written 3 times in total, by anyone". */
export function decodeCellArray(value: unknown): Int32Array | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'string') {
    // A Go []byte round-trips through encoding/json as a base64 string, so this is the standard
    // decoding of the old mask format rather than a hand-rolled one.
    const binary = decodeBase64(value)
    const out = new Int32Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary[i] as number
    return out
  }

  if (Array.isArray(value)) {
    const out = new Int32Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = toFiniteInteger(value[i], 'dense cell array')
    return out
  }

  if (typeof value === 'object') {
    const pairs = (value as { rle?: unknown }).rle
    if (!Array.isArray(pairs)) {
      throw new Error('rle: an object per-cell array must carry an "rle" array of value/run pairs')
    }
    return expandRuns(pairs)
  }

  throw new Error(`rle: expected an object, an array or a base64 string, got ${typeof value}`)
}

function expandRuns(pairs: readonly unknown[]): Int32Array {
  if (pairs.length % 2 !== 0) {
    throw new Error(`rle: ${pairs.length} pair elements, which is not a whole number of value/run pairs`)
  }
  // Two passes: total the run lengths first so the output is allocated once at its exact size.
  // Growing an Int32Array would mean copying millions of entries, which is the cost this encoding
  // exists to avoid paying in the first place.
  let total = 0
  for (let i = 1; i < pairs.length; i += 2) {
    const run = toFiniteInteger(pairs[i], 'rle run length')
    if (run < 1) throw new Error(`rle: run length ${run} at pair ${(i - 1) / 2} must be at least 1`)
    total += run
    if (total > RLE_MAX_CELLS) {
      throw new Error(`rle: run lengths sum past ${RLE_MAX_CELLS} cells, which is more than any real volume -- refusing to allocate`)
    }
  }
  const out = new Int32Array(total)
  let at = 0
  for (let i = 0; i < pairs.length; i += 2) {
    const value = toFiniteInteger(pairs[i], 'rle value')
    const run = toFiniteInteger(pairs[i + 1], 'rle run length')
    out.fill(value, at, at + run)
    at += run
  }
  return out
}

function toFiniteInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`rle: ${what} must be a finite number, got ${JSON.stringify(value)}`)
  }
  return Math.trunc(value)
}

/** Base64 without assuming a browser (`atob`) or Node (`Buffer`). Both are absent from one of the
 * three places this module runs, and this decoder is short enough not to be worth a branch on
 * which globals happen to exist. */
function decodeBase64(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = input.replace(/[\s=]+$/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let acc = 0
  let at = 0
  for (let i = 0; i < clean.length; i++) {
    const digit = alphabet.indexOf(clean[i] as string)
    if (digit < 0) throw new Error(`rle: ${JSON.stringify(clean[i])} is not a base64 digit`)
    acc = (acc << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}

// ---------------------------------------------------------------------------
// The wire subset this module reads
// ---------------------------------------------------------------------------

/** profiler.CellAttribution: three parallel arrays, one row each. */
export interface AttributionWire {
  readonly cell: readonly number[]
  readonly feature: readonly number[]
  readonly count: readonly number[]
}

/** profiler.FeatureProfileStats. Every counter is optional here although the contract always
 * writes it, so a hand-built fixture (and a future response that drops a field) reads as zero
 * rather than as NaN. */
export interface FeatureStatsWire {
  readonly identifier: string
  readonly typeId?: string | undefined
  readonly entered?: number | undefined
  readonly blocksWritten?: number | undefined
  readonly delegations?: number | undefined
  readonly selfMs?: number | undefined
  readonly inclusiveMs?: number | undefined
  /** Where this feature stopped short. Omitted when it never did. */
  readonly stops?: readonly StopStatWire[] | undefined
}

/** profiler.StopStat: one kind of early stop inside one feature, aggregated over the run.
 * `reason` is a stable code (iterations_zero, condition_false, ...), `detail` the FIRST
 * occurrence's evaluated value, `ordinal` the zero-based entry index it applies to (a
 * conditional_list entry, a sequence position) -- absent when it applies to the whole feature. */
export interface StopStatWire {
  readonly reason: string
  readonly detail: string
  readonly count: number
  readonly ordinal?: number | undefined
}

/** profiler.ProfileResult, as the subset these two modules read. `touchCounts` is left `unknown`
 * on purpose: it arrives run-length encoded and goes through decodeCellArray, so typing it as an
 * array here would invite a caller to index it before decoding. */
export interface ProfileWire {
  readonly featureIdentifiers?: readonly string[] | undefined
  readonly features?: readonly FeatureStatsWire[] | undefined
  readonly attribution?: AttributionWire | null | undefined
  readonly touchCounts?: unknown
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** One feature's contribution to one cell.
 *
 * `nodeId` is null only when the row's feature index is outside `featureIdentifiers` -- a
 * malformed or truncated response. Such a row is kept rather than dropped, because a cell that
 * was written by something is a different fact from a cell that was not written at all, and
 * silently discarding the row would turn the first into the second. */
export interface CellWriter {
  readonly nodeId: string | null
  readonly featureIndex: number
  /** How many times this feature wrote this cell. Always >= 1. */
  readonly writes: number
}

/** Everything known about one cell. `writers` is EVERY feature that wrote it -- see this module's
 * header on why no single one of them is reported as the placer. */
export interface CellAttributionEntry {
  readonly cell: number
  /** null when no bounds were given to the index, or the cell is outside them. */
  readonly position: BlockPosition | null
  readonly writers: readonly CellWriter[]
  /** Total writes to this cell across every feature -- the sum of `writers[].writes`. Equal to
   * profile.touchCounts[cell] except for writes made outside any feature frame (a one-off
   * environment build runs before the first frame is pushed and is counted there, not here). */
  readonly writes: number
}

const NO_WRITERS: readonly CellWriter[] = Object.freeze([])
const NO_CELLS = new Uint32Array(0)

/** Both directions of the attribution table, built once from a `generate` response's profile.
 *
 * Immutable after construction and safe to hold across renders: nothing here reads a clock, a
 * global, or the DOM, and the same profile always builds the same index. */
export class AttributionIndex {
  /** Node ids in feature-index order -- profile.featureIdentifiers verbatim, which is the order
   * the features were first ENTERED during the run. Not a ranking. */
  readonly nodeIds: readonly string[]
  /** The volume these cells index into, when the caller supplied it. */
  readonly bounds: CellBounds | null
  /** Distinct (cell, feature) pairs. */
  readonly rowCount: number

  // Rows sorted by (feature, cell); see the header for why this ordering carries both lookups.
  private readonly cell: Uint32Array
  private readonly feature: Uint16Array
  private readonly count: Uint32Array
  /** Row indices in ascending cell order, for the cell -> nodes direction. */
  private readonly byCell: Uint32Array
  /** Rows for bucket b are [featureOffsets[b], featureOffsets[b + 1]). Bucket `nodeIds.length` is
   * the unattributable one (a feature index the response's own identifier list does not cover),
   * which is why this is sized +2 rather than +1. */
  private readonly featureOffsets: Uint32Array
  private readonly bucketOfNode: ReadonlyMap<string, number>

  private constructor(
    nodeIds: readonly string[],
    bounds: CellBounds | null,
    cell: Uint32Array,
    feature: Uint16Array,
    count: Uint32Array,
    byCell: Uint32Array,
    featureOffsets: Uint32Array,
  ) {
    this.nodeIds = nodeIds
    this.bounds = bounds
    this.rowCount = cell.length
    this.cell = cell
    this.feature = feature
    this.count = count
    this.byCell = byCell
    this.featureOffsets = featureOffsets
    const buckets = new Map<string, number>()
    // First occurrence wins. The contract makes identifiers unique, but a duplicate must not
    // silently redirect every lookup to the later row span and leave the earlier one orphaned.
    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i] as string
      if (!buckets.has(id)) buckets.set(id, i)
    }
    this.bucketOfNode = buckets
  }

  /** An index over nothing -- what an unprofiled run, or a run that wrote no blocks, yields.
   * Every query answers emptily rather than throwing, because "this node wrote nothing" is an
   * ordinary answer and callers should not have to null-check the index itself. */
  static empty(bounds: CellBounds | null = null): AttributionIndex {
    return new AttributionIndex([], bounds, new Uint32Array(0), new Uint16Array(0), new Uint32Array(0), new Uint32Array(0), new Uint32Array(2))
  }

  /** Builds the index from a decoded `generate` response's `profile`.
   *
   * A null/absent profile, or an absent attribution table, gives the empty index: the request
   * simply did not ask for profiling (GenerateParams.profile), which is not an error condition.
   *
   * Throws only on a table that cannot mean anything -- parallel arrays of differing lengths.
   * That is a broken response rather than a possible run, and swallowing it would surface later
   * as blocks highlighted under the wrong node, which is far harder to trace back to here. */
  static fromProfile(profile: ProfileWire | null | undefined, bounds: CellBounds | null = null): AttributionIndex {
    const attribution = profile?.attribution
    const nodeIds = profile?.featureIdentifiers ?? []
    if (!attribution) return new AttributionIndex(nodeIds.slice(), bounds, new Uint32Array(0), new Uint16Array(0), new Uint32Array(0), new Uint32Array(0), new Uint32Array(nodeIds.length + 2))

    const cellIn = attribution.cell ?? []
    const featureIn = attribution.feature ?? []
    const countIn = attribution.count ?? []
    if (cellIn.length !== featureIn.length || cellIn.length !== countIn.length) {
      throw new Error(
        `attribution: cell/feature/count are parallel arrays and must be the same length, got ${cellIn.length}/${featureIn.length}/${countIn.length}`,
      )
    }

    const rows = cellIn.length
    const unknownBucket = nodeIds.length
    const bucketCount = unknownBucket + 1

    // Copy into typed arrays up front. A decoded JSON array of a million numbers is an array of
    // boxed-or-unboxed doubles the engine has to keep boxed-capable; these three views are the
    // resident cost quoted in the header, and the input array can be released right after.
    const rawCell = new Uint32Array(rows)
    const rawBucket = new Uint32Array(rows)
    const rawCount = new Uint32Array(rows)
    for (let i = 0; i < rows; i++) {
      rawCell[i] = (cellIn[i] as number) >>> 0
      const f = featureIn[i] as number
      rawBucket[i] = f >= 0 && f < unknownBucket ? f : unknownBucket
      rawCount[i] = (countIn[i] as number) >>> 0
    }

    // Two stable passes compose into (feature, cell) order: sort by cell first, then by feature.
    const byCellOfRaw = sortRowsByUint32Key(rawCell)
    const order = stableSortByBucket(byCellOfRaw, rawBucket, bucketCount)

    const cell = new Uint32Array(rows)
    const feature = new Uint16Array(rows)
    const count = new Uint32Array(rows)
    const featureOffsets = new Uint32Array(bucketCount + 1)
    for (let i = 0; i < rows; i++) {
      const r = order[i] as number
      cell[i] = rawCell[r] as number
      const bucket = rawBucket[r] as number
      feature[i] = bucket
      count[i] = rawCount[r] as number
      featureOffsets[bucket + 1] = (featureOffsets[bucket + 1] as number) + 1
    }
    for (let b = 0; b < bucketCount; b++) {
      featureOffsets[b + 1] = (featureOffsets[b + 1] as number) + (featureOffsets[b] as number)
    }

    // Re-derived from the FINAL row order rather than reused from above, so its row indices point
    // at the arrays a caller will actually read. Stable, so ties on one cell come out in feature
    // order -- deterministic, and documented in the header as not meaning "first" or "last".
    const byCell = sortRowsByUint32Key(cell)

    return new AttributionIndex(nodeIds.slice(), bounds, cell, feature, count, byCell, featureOffsets)
  }

  /** True when nothing was attributed -- an unprofiled run, or a run in which no feature wrote a
   * block. Not an error state; see nodeStats.ts for how to say so out loud. */
  get isEmpty(): boolean {
    return this.rowCount === 0
  }

  /** Exact resident size of the index's arrays, in bytes. Measured, not estimated -- a caller
   * deciding whether to keep an index for every open preview should be reading a real number. */
  get byteLength(): number {
    return this.cell.byteLength + this.feature.byteLength + this.count.byteLength + this.byCell.byteLength + this.featureOffsets.byteLength
  }

  /** Whether the profile has a row span for this node at all. False for a node that did not run,
   * for a node that ran and wrote nothing, and for a feature rule this run did not place --
   * three different things that nodeStats.ts tells apart. */
  has(nodeId: string): boolean {
    return this.bucketOfNode.has(nodeId)
  }

  /** The cells this node wrote, ascending, as a VIEW into the index's own storage -- no copy, so
   * highlighting a node that wrote a million cells costs nothing beyond the iteration.
   *
   * Do not mutate the result. It is a subarray of the live index; a typed array has no readonly
   * form to return instead, so this is a contract rather than a type. Empty for a node that wrote
   * nothing, which is the ordinary state of a filter or an aggregate. */
  cellsWrittenBy(nodeId: string): Uint32Array {
    const bucket = this.bucketOfNode.get(nodeId)
    if (bucket === undefined) return NO_CELLS
    const start = this.featureOffsets[bucket] as number
    const end = this.featureOffsets[bucket + 1] as number
    return this.cell.subarray(start, end)
  }

  /** How many DISTINCT cells this node wrote -- which is not how many blocks it wrote. A scatter
   * that places 400 blocks into 300 cells (100 of them twice) reports 300 here and 400 from
   * `writesBy`. The first is what a highlight covers; the second is what the write budget spent. */
  distinctCellsWrittenBy(nodeId: string): number {
    return this.cellsWrittenBy(nodeId).length
  }

  /** Total writes this node made, summed over the cells it wrote. Matches the node's own
   * FeatureProfileStats.blocksWritten on a complete run; nodeStats.ts reads that field directly
   * rather than this, since a node can have stats without having written anything. */
  writesBy(nodeId: string): number {
    const bucket = this.bucketOfNode.get(nodeId)
    if (bucket === undefined) return 0
    const start = this.featureOffsets[bucket] as number
    const end = this.featureOffsets[bucket + 1] as number
    let total = 0
    for (let i = start; i < end; i++) total += this.count[i] as number
    return total
  }

  /** Walks the cells this node wrote in ascending cell order, without allocating. `visit` gets the
   * cell index and how many times this node wrote it. */
  forEachCellWrittenBy(nodeId: string, visit: (cell: number, writes: number) => void): void {
    const bucket = this.bucketOfNode.get(nodeId)
    if (bucket === undefined) return
    const start = this.featureOffsets[bucket] as number
    const end = this.featureOffsets[bucket + 1] as number
    for (let i = start; i < end; i++) visit(this.cell[i] as number, this.count[i] as number)
  }

  /** Every feature that wrote this cell, with its own write count, in ascending feature-index
   * order. Empty for a cell nothing wrote -- the overwhelming majority of any volume.
   *
   * ALL writers, never one: the block a viewer sees is the last write's, and which row that was
   * is not in this contract. See the module header. */
  writersOf(cell: number): readonly CellWriter[] {
    if (this.rowCount === 0 || !Number.isInteger(cell) || cell < 0) return NO_WRITERS
    let at = this.lowerBoundByCell(cell)
    if (at >= this.rowCount) return NO_WRITERS
    const out: CellWriter[] = []
    while (at < this.rowCount) {
      const row = this.byCell[at] as number
      if ((this.cell[row] as number) !== cell) break
      const featureIndex = this.feature[row] as number
      out.push({
        nodeId: featureIndex < this.nodeIds.length ? (this.nodeIds[featureIndex] as string) : null,
        featureIndex,
        writes: this.count[row] as number,
      })
      at++
    }
    return out
  }

  /** writersOf for a world position. Empty when no bounds were given, or the position is outside
   * them -- a click past the previewed volume is an ordinary thing, not an error. */
  writersAt(pos: BlockPosition): readonly CellWriter[] {
    if (!this.bounds) return NO_WRITERS
    const cell = cellIndexOf(this.bounds, pos)
    if (cell < 0) return NO_WRITERS
    return this.writersOf(cell)
  }

  /** Everything known about one cell, position included when bounds are available. */
  entryOf(cell: number): CellAttributionEntry {
    const writers = this.writersOf(cell)
    let writes = 0
    for (const w of writers) writes += w.writes
    return {
      cell,
      position: this.bounds ? cellPositionOf(this.bounds, cell) : null,
      writers,
      writes,
    }
  }

  /** entryOf for a world position. The cell is reported as -1 when the position is outside the
   * volume, so a caller can tell "outside the preview" from "inside and untouched". */
  entryAt(pos: BlockPosition): CellAttributionEntry {
    const cell = this.bounds ? cellIndexOf(this.bounds, pos) : -1
    if (cell < 0) return { cell: -1, position: pos, writers: NO_WRITERS, writes: 0 }
    return this.entryOf(cell)
  }

  /** First position in `byCell` whose row's cell is >= `cell`. */
  private lowerBoundByCell(cell: number): number {
    let lo = 0
    let hi = this.rowCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const row = this.byCell[mid] as number
      if ((this.cell[row] as number) < cell) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Row indices sorted by a 32-bit key, stably, in four byte passes (LSD radix). Linear in the row
 * count with no comparator callback -- see the module header for why that matters at three and a
 * half million rows. A pass whose byte is identical across every row is skipped, which is the
 * common case for the top byte of a cell index. */
function sortRowsByUint32Key(keys: Uint32Array): Uint32Array {
  const n = keys.length
  let src = new Uint32Array(n)
  for (let i = 0; i < n; i++) src[i] = i
  if (n < 2) return src
  let dst = new Uint32Array(n)
  const counts = new Uint32Array(256)
  for (let shift = 0; shift < 32; shift += 8) {
    counts.fill(0)
    for (let i = 0; i < n; i++) {
      const digit = ((keys[src[i] as number] as number) >>> shift) & 0xff
      counts[digit] = (counts[digit] as number) + 1
    }
    let uniform = false
    for (let b = 0; b < 256; b++) {
      if ((counts[b] as number) === n) {
        uniform = true
        break
      }
    }
    if (uniform) continue
    let total = 0
    for (let b = 0; b < 256; b++) {
      const c = counts[b] as number
      counts[b] = total
      total += c
    }
    for (let i = 0; i < n; i++) {
      const row = src[i] as number
      const digit = ((keys[row] as number) >>> shift) & 0xff
      dst[counts[digit] as number] = row
      counts[digit] = (counts[digit] as number) + 1
    }
    const swap = src
    src = dst
    dst = swap
  }
  return src
}

/** Reorders an existing row order by bucket, stably -- one counting-sort pass. Stability is what
 * makes this compose with sortRowsByUint32Key: rows already in cell order stay in cell order
 * within each bucket, so one pass of each yields (bucket, key) order. */
function stableSortByBucket(order: Uint32Array, buckets: Uint32Array, bucketCount: number): Uint32Array {
  const n = order.length
  const starts = new Uint32Array(bucketCount + 1)
  for (let i = 0; i < n; i++) {
    const bucket = (buckets[order[i] as number] as number) + 1
    starts[bucket] = (starts[bucket] as number) + 1
  }
  for (let b = 0; b < bucketCount; b++) starts[b + 1] = (starts[b + 1] as number) + (starts[b] as number)
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const row = order[i] as number
    const bucket = buckets[row] as number
    out[starts[bucket] as number] = row
    starts[bucket] = (starts[bucket] as number) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Selection bridge
// ---------------------------------------------------------------------------

/** What a selection in either direction resolves to. `null` is a real value -- the user
 * deselected -- not "nothing happened", matching how render.ts's own GraphSelection uses it. */
export type AttributionSelection =
  | {
      readonly kind: 'node'
      readonly nodeId: string
      /** The cells this node wrote, ascending. A view into the index; do not mutate. Empty is an
       * ordinary result, not a failure -- see nodeStats.ts for how to say that to a person. */
      readonly cells: Uint32Array
      /** Total writes, which is >= cells.length when the node wrote a cell more than once. */
      readonly writes: number
    }
  | {
      readonly kind: 'cell'
      readonly cell: number
      readonly position: BlockPosition | null
      /** EVERY feature that wrote this cell. Never narrowed to one. */
      readonly writers: readonly CellWriter[]
      readonly writes: number
    }
  | null

/** The headless half of "the preview and the graph select each other".
 *
 * Holds the current selection, resolves it through the index, and emits. It touches no DOM and
 * imports no renderer: a host wires `graphView.onSelect` into `selectNode` and this bridge's
 * `onSelect` back into `graphView.setSelection`, which is exactly why render.ts's setSelection
 * does NOT emit -- that asymmetry is what keeps the two sides from ping-ponging a selection
 * between each other forever. This side breaks the same loop from its own end by not re-emitting
 * an identical selection. */
export interface AttributionBridge {
  readonly index: AttributionIndex
  /** Selects a node and emits. Pass null to clear. A node with no attributed cells still selects
   * -- an empty highlight IS the answer for a filter, and refusing to select would read as the
   * click having missed. */
  selectNode(nodeId: string | null): AttributionSelection
  /** Selects a cell by flat index and emits. A cell nothing wrote still selects, with an empty
   * `writers`: "nothing placed this block, it is environment" is an answer. */
  selectCell(cell: number): AttributionSelection
  /** selectCell for a world position. Clears the selection when the position is outside the
   * previewed volume. */
  selectPosition(pos: BlockPosition): AttributionSelection
  /** Applies a selection WITHOUT emitting -- for the side of the loop being driven from outside. */
  setSelection(selection: AttributionSelection): void
  getSelection(): AttributionSelection
  /** Returns an unsubscribe, matching render.ts's subscription shape. */
  onSelect(listener: (selection: AttributionSelection) => void): () => void
  dispose(): void
}

export function createAttributionBridge(index: AttributionIndex): AttributionBridge {
  const listeners = new Set<(selection: AttributionSelection) => void>()
  let current: AttributionSelection = null

  const resolveNode = (nodeId: string): AttributionSelection => {
    const cells = index.cellsWrittenBy(nodeId)
    return { kind: 'node', nodeId, cells, writes: index.writesBy(nodeId) }
  }

  const emit = (next: AttributionSelection): AttributionSelection => {
    if (sameSelection(current, next)) return current
    current = next
    // Snapshot the listener set: a listener that unsubscribes (or subscribes) while being
    // notified must not change who else hears about THIS selection.
    for (const listener of [...listeners]) listener(current)
    return current
  }

  return {
    index,
    selectNode(nodeId) {
      return emit(nodeId === null ? null : resolveNode(nodeId))
    },
    selectCell(cell) {
      const entry = index.entryOf(cell)
      return emit({ kind: 'cell', cell: entry.cell, position: entry.position, writers: entry.writers, writes: entry.writes })
    },
    selectPosition(pos) {
      const entry = index.entryAt(pos)
      if (entry.cell < 0) return emit(null)
      return emit({ kind: 'cell', cell: entry.cell, position: entry.position, writers: entry.writers, writes: entry.writes })
    },
    setSelection(selection) {
      current = selection
    },
    getSelection() {
      return current
    },
    onSelect(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      current = null
    },
  }
}

/** Identity for the loop-breaking check above. Compares what a selection MEANS -- which node, or
 * which cell -- rather than the object, because every resolve builds a fresh one. */
function sameSelection(a: AttributionSelection, b: AttributionSelection): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'node' && b.kind === 'node') return a.nodeId === b.nodeId
  if (a.kind === 'cell' && b.kind === 'cell') return a.cell === b.cell
  return false
}
