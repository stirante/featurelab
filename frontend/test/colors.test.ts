import { describe, expect, it } from 'vitest'

import { attributionColorPacked, ATTRIBUTION_SERIES_LENGTH, colorForBlockName } from '../src/colors.js'

describe('colorForBlockName', () => {
  it('keeps a curated colour when the generated table also contains the block', () => {
    // The generated texture average is grey (#9a9a9a), but water is runtime-tinted blue.
    expect(colorForBlockName('minecraft:water')).toBe(0x3f76e4)
  })

  it('uses a generated colour for a block absent from the curated table', () => {
    expect(colorForBlockName('minecraft:acacia_button')).toBe(0xa85a32)
  })

  it('uses the generated up face as the representative mesher colour', () => {
    expect(colorForBlockName('minecraft:acacia_door')).toBe(0x8a6c3e)
  })

  it('keeps the stable hash fallback for a block absent from both tables', () => {
    expect(colorForBlockName('minecraft:future_test_block')).toBe(0xb06f4f)
  })
})

// --- the write-attribution series, under colour vision ------------------------------------
//
// The first version of ATTRIBUTION_SERIES was picked to sit out of the way of the other
// overlays and to look distinct SIDE BY SIDE IN NORMAL VISION, which two of its six entries did
// not even manage: #6b73ff and #b07bff were CIE76 ΔE 17.7 apart normally and 10.3 apart under
// simulated protanopia -- and #6b73ff is not an arbitrary entry, it is always the node the user
// clicked (previewPanel.ts assigns the selected writer first), so the one row that has to be
// findable in the picture was the one row that dissolved into another.
//
// So the separation is now a TESTED PROPERTY rather than a design intention: every pair, in
// normal vision and under each of the three dichromacies, at CIE76 ΔE 25 or better. A palette
// change that quietly reintroduces a collision fails here rather than in somebody's eyes.
//
// The maths is written out here rather than imported because it is the independent check:
// colors.ts ships six numbers and no opinion about how far apart they are, and a shared helper
// would be a second thing to get wrong in the same direction.

/** Machado, Oliveira & Fernandes (2009) severity-1.0 simulation matrices, applied to LINEAR
 * RGB. Identity for 'normal', so the four cases run through one code path. */
const CVD_MATRICES: Readonly<Record<string, readonly (readonly [number, number, number])[]>> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
}

/** The smallest CIE76 ΔE that still reads as "two different colours" in a swatch this size.
 * Well above the ~2.3 just-noticeable-difference, because the question here is not "can these
 * be told apart when adjacent" but "can a row of the legend be matched to a patch of blocks
 * across the viewport". */
const MIN_DELTA_E = 25

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

function labUnder(packed: number, simulation: string): [number, number, number] {
  const matrix = CVD_MATRICES[simulation]!
  const rgb = [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff].map((c) => srgbToLinear(c / 255))
  const seen = matrix.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0]! + row[1] * rgb[1]! + row[2] * rgb[2]!)))
  const [r, g, b] = [seen[0]!, seen[1]!, seen[2]!]
  // Linear sRGB -> CIE XYZ (D65) -> CIE L*a*b*.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function deltaE76(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

describe('the write-attribution colour series is legible to colour-blind eyes', () => {
  const series = Array.from({ length: ATTRIBUTION_SERIES_LENGTH }, (_, i) => attributionColorPacked(i))

  it('has six distinct colours', () => {
    expect(ATTRIBUTION_SERIES_LENGTH).toBe(6)
    expect(new Set(series).size).toBe(series.length)
  })

  for (const simulation of Object.keys(CVD_MATRICES)) {
    it(`keeps every pair at least ΔE ${String(MIN_DELTA_E)} apart under ${simulation}`, () => {
      const labs = series.map((c) => labUnder(c, simulation))
      const tooClose: string[] = []
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
          const distance = deltaE76(labs[i]!, labs[j]!)
          if (distance < MIN_DELTA_E) {
            tooClose.push(`#${series[i]!.toString(16).padStart(6, '0')} vs #${series[j]!.toString(16).padStart(6, '0')} = ${distance.toFixed(1)}`)
          }
        }
      }
      expect(tooClose).toEqual([])
    })
  }

  it('puts the furthest-apart colours first, because most runs have two or three writers', () => {
    // Writers are coloured in list order with the selected node first, so the first two entries
    // are the pair most previews actually show. They should be the easiest pair, not an
    // arbitrary one -- see ATTRIBUTION_SERIES's own comment.
    const worstAmong = (count: number): number => {
      let worst = Infinity
      for (const simulation of Object.keys(CVD_MATRICES)) {
        const labs = series.slice(0, count).map((c) => labUnder(c, simulation))
        for (let i = 0; i < labs.length; i++) {
          for (let j = i + 1; j < labs.length; j++) worst = Math.min(worst, deltaE76(labs[i]!, labs[j]!))
        }
      }
      return worst
    }
    // Monotonically harder as writers are added, and comfortably clear of the bar at the sizes
    // that occur most.
    expect(worstAmong(2)).toBeGreaterThan(worstAmong(6))
    expect(worstAmong(3)).toBeGreaterThan(35)
  })

  it('still gives a lone writer the blue-violet it has always had', () => {
    // A preview with exactly one attributed writer must look the way it did before the series
    // existed at all.
    expect(attributionColorPacked(0)).toBe(0x6b73ff)
  })
})
