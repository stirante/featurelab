// pixelContrast.ts -- WCAG contrast measured off RENDERED PIXELS.
//
// WHY THIS EXISTS AND WHY getComputedStyle IS NOT ENOUGH.
// The previous round of contrast work in this panel was verified by resolving
// getComputedStyle(el).color, compositing its alpha over the first opaque ancestor background,
// and running the WCAG formula on the two. That is a good check and it caught real bugs, but it
// is blind to the two things that actually painted these surfaces:
//
//   1. `opacity`. An element's own `opacity` never appears in its computed `color`, and it does
//      not composite into any ancestor's `background-color` either -- it is a compositing step
//      that happens after both. .fl-diag-type (`opacity: 0.7`) and .fl-diag-file
//      (`opacity: 0.55`) were therefore reported as passing at their parent row's 5.06:1 while
//      they were really painting 2.89:1 and 2.23:1.
//   2. A <canvas>. The viewport overlay's gizmo sits on the 3D view, which has no CSS
//      background at all, so an ancestor walk bottoms out on the page and measures the label
//      against a colour that is nowhere on screen. What is actually behind it is whatever the
//      scene rendered -- measured at #759077, a grass-green block.
//
// A screenshot has no such blind spots: it is the composited result, opacity, canvas and all.
//
// WHAT IT MEASURES. Inside one element's own screenshot, the background is the most common
// pixel colour and the foreground is the pixel colour furthest from it in luminance. Text
// antialiasing only ever produces colours BETWEEN the two, so the extreme pixel is the best
// available estimate of the declared text colour and can never overshoot it -- the measurement
// errs low, never high.
//
// CAPTURE AT deviceScaleFactor: 2. At 1x, a thin glyph can have no fully-covered pixel at all:
// the `›` between two chain segments measured 3.48:1 while the segments either side of it, in
// the identical colour, measured 5.06:1. That is a fact about hinting a 9px chevron, not about
// the stylesheet, and doubling the capture density removes it (the same `›` then measures
// 4.85:1, within rounding of its siblings). Pass `deviceScaleFactor: 2` when creating the page.
import zlib from 'node:zlib'

export interface DecodedImage {
  width: number
  height: number
  /** Bytes per pixel: 4 for RGBA (colour type 6), 3 for RGB (colour type 2). */
  bpp: number
  data: Buffer
}

/** Decodes the 8-bit non-interlaced PNG that Playwright's `screenshot()` returns. Deliberately
 * hand-rolled rather than pulling in a decoder dependency: this is ~40 lines of the PNG spec's
 * five filter types, and the alternative is a new runtime dependency for two test files. */
export function decodePng(buf: Buffer): DecodedImage {
  let off = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += len + 12
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bit depth ${String(bitDepth)}, colour type ${String(colorType)})`)
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0
      const b = prev ? prev[x]! : 0
      const c = prev && x >= bpp ? prev[x - bpp]! : 0
      let v = line[x]!
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, bpp, data: out }
}

type Rgb = readonly [number, number, number]

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance. */
export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/** WCAG 2.x contrast ratio. COMPUTED from the two colours, never compared against a remembered
 * hex: a token swapped for a different but equally unreadable colour still fails here. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export interface PixelContrast {
  fg: string
  bg: string
  ratio: number
}

/** Background and foreground of one element's own screenshot, and the ratio between them. See
 * this file's header for the modal-background / extreme-foreground rule and why it errs low. */
export function contrastOfImage(png: DecodedImage): PixelContrast | null {
  const counts = new Map<number, number>()
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = y * png.width * png.bpp + x * png.bpp
      const key = (png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return null
  const toRgb = (k: number): Rgb => [(k >> 16) & 255, (k >> 8) & 255, k & 255]
  let bgKey = 0
  let bgCount = -1
  for (const [k, n] of counts) {
    if (n > bgCount) {
      bgCount = n
      bgKey = k
    }
  }
  const bg = toRgb(bgKey)
  const bgLum = luminance(bg)
  let fg: Rgb = bg
  let furthest = -1
  for (const k of counts.keys()) {
    const d = Math.abs(luminance(toRgb(k)) - bgLum)
    if (d > furthest) {
      furthest = d
      fg = toRgb(k)
    }
  }
  return { fg: toHex(fg), bg: toHex(bg), ratio: Math.round(contrastRatio(fg, bg) * 100) / 100 }
}

/** What WCAG AA asks of text of this size and weight: 3:1 for large text (>=24px, or >=18.66px
 * bold), 4.5:1 otherwise. */
export function requiredRatio(fontSizePx: number, fontWeight: string): number {
  const bold = Number(fontWeight) >= 700 || fontWeight === 'bold'
  return fontSizePx >= 24 || (bold && fontSizePx >= 18.66) ? 3 : 4.5
}

/** The colour tokens VS Code injects into a webview, as Dark Modern and Light Modern actually
 * ship them. Only the ones panel.css reads are listed; anything absent falls through to the
 * stylesheet's own literal, exactly as it does in a real webview that omits a token. */
export const DARK_MODERN: Readonly<Record<string, string>> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-disabledForeground': '#9d9d9d',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-sideBar-background': '#181818',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-editorWidget-foreground': '#cccccc',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-errorForeground': '#f85149',
  '--vscode-inputValidation-warningBackground': '#352a05',
  '--vscode-inputValidation-warningBorder': '#966c1e',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-textLink-foreground': '#4daafc',
}

export const LIGHT_MODERN: Readonly<Record<string, string>> = {
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': 'rgba(59, 59, 59, 0.6)',
  '--vscode-disabledForeground': 'rgba(59, 59, 59, 0.5)',
  '--vscode-editor-background': '#ffffff',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-editorWidget-foreground': '#3b3b3b',
  '--vscode-widget-border': '#e5e5e5',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-input-border': '#cecece',
  '--vscode-list-hoverBackground': '#f2f2f2',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-errorForeground': '#f85149',
  '--vscode-inputValidation-warningBackground': '#f6f5d2',
  '--vscode-inputValidation-warningBorder': '#b89500',
  '--vscode-badge-background': '#cccccc',
  '--vscode-badge-foreground': '#3b3b3b',
  '--vscode-textLink-foreground': '#005fb8',
}
