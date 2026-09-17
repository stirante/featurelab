// stubAtlas.ts -- a hand-drawn block atlas, used by the renderer's own tests and by the
// screenshot harness that checks what those tests cannot: whether the picture is right.
//
// EVERY PIXEL HERE IS OURS. Not one byte comes from a Mojang resource pack, and none may: this
// file is committed, and the vanilla textures the real atlas is built from are Mojang's and live
// only in a per-user cache directory.
// The point of a stub is not to look like Minecraft -- it is to be an atlas whose every cell is
// unmistakable at a glance, so a mis-mapped UV, a mirrored face, a missing tint or a bleeding
// cell edge is visible rather than plausible.
//
// Six 16x16 cells in a 4x2 grid with a 1px duplicated border (stride 18, image 72x36), which is
// the "1px border" half of the two anti-bleed schemes the contract allows -- the half-texel
// inset half is exercised by building the same table with border 0.
//
// The PNG is encoded here rather than committed as a binary, with STORED (uncompressed) deflate
// blocks so there is no dependency on node:zlib -- the same module then works unchanged inside a
// browser page, which is what the screenshot harness needs.

import type { AtlasTableWire, AtlasWire } from '../../src/protocol.js'

export const STUB_CELL = 16
export const STUB_COLS = 4
export const STUB_ROWS = 2

/** Cell indices, named. Cell 5 is an all-white cell -- the real builder does not pack one and
 * the renderer synthesizes its own, so this is here only for the "a builder that DID pack one"
 * branch (stubAtlasTableWithWhite). Cells 6 and 7 are
 * deliberately loud magenta and pure black, so a UV that bleeds or overshoots lands somewhere
 * that cannot be mistaken for a real texture. */
export const CELL_GREY_CHECKER = 0 // "grass top": greyscale, meant to be tinted
export const CELL_TWO_BAND = 1 // "grass side": light band across the TOP quarter only
export const CELL_BROWN = 2 // "dirt"
export const CELL_HOLED = 3 // "leaves": greyscale with alpha-0 holes
export const CELL_BLUE = 4 // "water"
export const CELL_WHITE = 5
export const CELL_MAGENTA = 6
export const CELL_BLACK = 7

type RGBA = readonly [number, number, number, number]

/** Paints one 16x16 cell as a flat function of its own (x, y). Kept as plain functions rather
 * than data so the intent of each pattern is legible next to the assertion that reads it. */
const CELL_PAINTERS: ReadonlyArray<(x: number, y: number) => RGBA> = [
  // 0 -- greyscale checkerboard, 4px squares. Greyscale on purpose: rendered untinted it is
  // grey, which is exactly the failure the tint channel exists to prevent.
  (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? [200, 200, 200, 255] : [150, 150, 150, 255]),
  // 1 -- a light band across the top 4 rows, dark below. Asymmetric top-to-bottom, so a face
  // whose UVs are flipped vertically puts the band at the BOTTOM and is obvious.
  (_x, y) => (y < 4 ? [220, 220, 220, 255] : [90, 70, 50, 255]),
  // 2 -- flat brown.
  () => [120, 85, 55, 255],
  // 3 -- greyscale with a regular grid of fully transparent holes: an alpha test that is not
  // running shows a solid square, one that is shows a lattice.
  (x, y) => (x % 4 === 0 && y % 4 === 0 ? [0, 0, 0, 0] : [180, 180, 180, 255]),
  // 4 -- flat blue.
  () => [60, 110, 210, 255],
  // 5 -- an all-white cell: opaque and exactly white, so `white * flatColour` is the
  // flat colour, unchanged.
  () => [255, 255, 255, 255],
  // 6, 7 -- never referenced by the table below; they exist so bleeding has somewhere loud to
  // come from.
  () => [255, 0, 255, 255],
  () => [0, 0, 0, 255],
]

/** Renders the atlas image into a flat RGBA buffer, duplicating each cell's edge pixels into
 * its 1px border exactly as a real atlas builder must. */
function paintAtlas(border: number): { width: number; height: number; rgba: Uint8Array } {
  const stride = STUB_CELL + 2 * border
  const width = STUB_COLS * stride
  const height = STUB_ROWS * stride
  const rgba = new Uint8Array(width * height * 4)
  for (let cell = 0; cell < STUB_COLS * STUB_ROWS; cell++) {
    const paint = CELL_PAINTERS[cell] as (x: number, y: number) => RGBA
    const cx = (cell % STUB_COLS) * stride
    const cy = Math.floor(cell / STUB_COLS) * stride
    for (let py = 0; py < stride; py++) {
      for (let px = 0; px < stride; px++) {
        // Clamping into the cell is what duplicates the edge pixel outward into the border.
        const sx = Math.min(STUB_CELL - 1, Math.max(0, px - border))
        const sy = Math.min(STUB_CELL - 1, Math.max(0, py - border))
        const [r, g, b, a] = paint(sx, sy)
        const at = ((cy + py) * width + (cx + px)) * 4
        rgba[at] = r
        rgba[at + 1] = g
        rgba[at + 2] = b
        rgba[at + 3] = a
      }
    }
  }
  return { width, height, rgba }
}

// --- a minimal PNG encoder (RGBA, filter 0, stored deflate) ---------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + (bytes[i] as number)) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** zlib stream wrapping STORED deflate blocks -- no compression, no node:zlib, works in a
 * browser page. The atlas is a few kilobytes; the size does not matter, the portability does. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = []
  const MAX = 65535
  for (let at = 0; at < raw.length || at === 0; at += MAX) {
    const len = Math.min(MAX, raw.length - at)
    const final = at + len >= raw.length ? 1 : 0
    const header = new Uint8Array(5)
    header[0] = final
    header[1] = len & 0xff
    header[2] = (len >> 8) & 0xff
    header[3] = ~len & 0xff
    header[4] = (~len >> 8) & 0xff
    blocks.push(header, raw.subarray(at, at + len))
    if (final === 1) break
  }
  const body = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(2 + body + 4)
  out[0] = 0x78
  out[1] = 0x01
  let at = 2
  for (const b of blocks) {
    out.set(b, at)
    at += b.length
  }
  new DataView(out.buffer).setUint32(at, adler32(raw))
  return out
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter type 0 (None)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number)
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }
  if (typeof g.btoa === 'function') return g.btoa(binary)
  if (g.Buffer) return g.Buffer.from(binary, 'binary').toString('base64')
  throw new Error('stubAtlas: no btoa or Buffer available to base64-encode the PNG')
}

/** The stub table, in the shape the real atlas builder emits (internal/atlas's Table):
 * explicit per-cell x/y, a named inset, per-face cell maps with no "*" for vanilla blocks, and
 * measured `tint_color` multipliers alongside the channel names.
 *
 * Deliberately covers everything a first textured pass has to get right:
 *  - grass_block: a DIFFERENT cell per face (up / down / the four sides), tinted on `up` only
 *  - oak_leaves:  a cutout block whose texture has holes, tinted on every face
 *  - water:       a translucent block
 *  - dirt:        one face resolved and the rest ABSENT, which is how the builder records a
 *                 texture it could not resolve -- those faces must fall back to white
 *  - stone:       absent from the table entirely, which is how every pack-defined block looks
 *                 until it has an atlas entry of its own
 *
 * NOTE there is no `white` cell: the real builder does not pack one, so the stub does not
 * either, and the renderer's own synthesis path (viewer.ts's prepareAtlas) is what the tests
 * and the screenshot harness actually exercise. `stubAtlasTableWithWhite` covers the other
 * branch. */
export function stubAtlasTable(border = 1): AtlasTableWire {
  const stride = STUB_CELL + 2 * border
  const cells = []
  for (let i = 0; i < STUB_COLS * STUB_ROWS; i++) {
    cells.push({
      path: `stub/cell_${i}`,
      x: (i % STUB_COLS) * stride + border,
      y: Math.floor(i / STUB_COLS) * stride + border,
      render: i === CELL_HOLED ? ('cutout' as const) : ('opaque' as const),
      color: '#808080',
      grey: i === CELL_GREY_CHECKER || i === CELL_HOLED,
    })
  }
  return {
    version: 1,
    tag: 'stub',
    source: 'stub',
    cell: STUB_CELL,
    border,
    stride,
    inset: border > 0 ? 0 : 0.5,
    width: STUB_COLS * stride,
    height: STUB_ROWS * stride,
    cols: STUB_COLS,
    rows: STUB_ROWS,
    cells,
    textures: { grey_checker: 0, two_band: 1, brown: 2, holed: 3, blue: 4, white: 5 },
    blocks: {
      'minecraft:grass_block': {
        faces: { up: CELL_GREY_CHECKER, down: CELL_BROWN, north: CELL_TWO_BAND, south: CELL_TWO_BAND, east: CELL_TWO_BAND, west: CELL_TWO_BAND },
        tint: { up: 'grass', down: 'none', north: 'none', south: 'none', east: 'none', west: 'none' },
        tint_color: { up: '#79c05a' },
        render: 'opaque',
      },
      // Only `up` resolved -- the other five faces are absent, which is how the builder records
      // a texture key it could not resolve.
      'minecraft:dirt': { faces: { up: CELL_BROWN }, render: 'opaque' },
      'minecraft:oak_leaves': {
        faces: { up: CELL_HOLED, down: CELL_HOLED, north: CELL_HOLED, south: CELL_HOLED, east: CELL_HOLED, west: CELL_HOLED },
        tint: { up: 'foliage', down: 'foliage', north: 'foliage', south: 'foliage', east: 'foliage', west: 'foliage' },
        render: 'cutout',
      },
      'minecraft:water': {
        faces: { up: CELL_BLUE, down: CELL_BLUE, north: CELL_BLUE, south: CELL_BLUE, east: CELL_BLUE, west: CELL_BLUE },
        tint: { up: 'water', down: 'water', north: 'water', south: 'water', east: 'water', west: 'water' },
        render: 'translucent',
      },
    },
    // The channel documentation the real table carries -- `foliage` has no measured per-face
    // multiplier above, so this is what the renderer must fall back to for leaves.
    tints: {
      none: { default: '#ffffff', source: 'the texture is already the colour it should be' },
      grass: { default: '#79c05a', source: 'stub' },
      foliage: { default: '#77ab2f', source: 'stub' },
      water: { default: '#44aff5', source: 'stub' },
    },
  }
}

/** The same table with the white cell packed rather than synthesized -- the branch a builder
 * that does the renderer this favour would take. */
export function stubAtlasTableWithWhite(border = 1): AtlasTableWire {
  return { ...stubAtlasTable(border), white: CELL_WHITE }
}

/** The full `atlas` method response: table plus base64 PNG, exactly the shape decodeAtlas
 * consumes. */
export function stubAtlasWire(border = 1, withWhite = false): AtlasWire {
  const { width, height, rgba } = paintAtlas(border)
  return { table: withWhite ? stubAtlasTableWithWhite(border) : stubAtlasTable(border), png: toBase64(encodePng(width, height, rgba)) }
}
