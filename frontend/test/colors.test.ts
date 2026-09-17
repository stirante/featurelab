import { describe, expect, it } from 'vitest'

import { colorForBlockName } from '../src/colors.js'

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
