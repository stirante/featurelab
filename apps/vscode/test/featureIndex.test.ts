// featureIndex.test.ts -- covers FeatureIndexData's identifier<->file bookkeeping: duplicates
// (source pack + build output declaring the same identifier -- a normal workspace shape, see
// the class's own doc comment), re-index on change, and un-indexing when an edit turns a
// feature file into something that no longer declares one.
import { describe, expect, it } from 'vitest'
import { FeatureIndexData } from '../src/featureIndex.js'

function featureJson(identifier: string): string {
  return JSON.stringify({
    format_version: '1.21.110',
    'minecraft:single_block_feature': { description: { identifier }, places_block: 'minecraft:stone' },
  })
}

describe('FeatureIndexData', () => {
  it('indexes a feature file and resolves its identifier', () => {
    const index = new FeatureIndexData()
    index.setFile('file:///pack/features/a.json', featureJson('wiki:a'))
    expect(index.lookup('wiki:a')).toEqual(['file:///pack/features/a.json'])
    expect(index.lookup('wiki:missing')).toEqual([])
  })

  it('keeps BOTH files when two declare the same identifier (source pack + build output)', () => {
    const index = new FeatureIndexData()
    index.setFile('file:///src/features/a.json', featureJson('wiki:a'))
    index.setFile('file:///build/features/a.json', featureJson('wiki:a'))
    expect(index.lookup('wiki:a').sort()).toEqual(['file:///build/features/a.json', 'file:///src/features/a.json'])
  })

  it('re-indexing a file under a NEW identifier removes the old mapping', () => {
    const index = new FeatureIndexData()
    index.setFile('file:///pack/features/a.json', featureJson('wiki:old'))
    index.setFile('file:///pack/features/a.json', featureJson('wiki:new'))
    expect(index.lookup('wiki:old')).toEqual([])
    expect(index.lookup('wiki:new')).toEqual(['file:///pack/features/a.json'])
  })

  it('an edit that breaks the file (invalid JSON / no identifier) un-indexes it', () => {
    const index = new FeatureIndexData()
    index.setFile('file:///pack/features/a.json', featureJson('wiki:a'))
    index.setFile('file:///pack/features/a.json', '{ not json')
    expect(index.lookup('wiki:a')).toEqual([])
    expect(index.size).toBe(0)
  })

  it('does not index a feature_rules file -- rules are never reference targets', () => {
    const index = new FeatureIndexData()
    const rule = JSON.stringify({
      format_version: '1.21.110',
      'minecraft:feature_rules': { description: { identifier: 'wiki:rule_id', places_feature: 'wiki:a' } },
    })
    index.setFile('file:///pack/feature_rules/r.json', rule)
    expect(index.lookup('wiki:rule_id')).toEqual([])
  })

  it('removeFile drops the mapping and leaves siblings with the same identifier intact', () => {
    const index = new FeatureIndexData()
    index.setFile('file:///src/features/a.json', featureJson('wiki:a'))
    index.setFile('file:///build/features/a.json', featureJson('wiki:a'))
    index.removeFile('file:///src/features/a.json')
    expect(index.lookup('wiki:a')).toEqual(['file:///build/features/a.json'])
  })
})
