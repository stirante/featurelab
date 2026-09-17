// identifier.test.ts -- resolvePackRoot's own regression coverage for the "pack root
// mis-resolved for files under feature_rules/" bug: the previous implementation only ever
// walked up looking for a directory named exactly "features", so a file opened from
// feature_rules/ (or biomes/, structures/, blocks/) fell through to path.dirname(filePath) --
// handing loadPack the feature_rules directory itself as the "pack root". Nothing loaded, and
// the panel reported "<identifier>" not found in loaded rule files with empty pickers. The
// reported repro was a rule file opened straight out of a built pack,
// `.../ExampleAddon_bp/feature_rules/example_rule.main.json`; this suite replicates that
// layout (manifest.json at the pack root, feature_rules/ one level below it) in a temp
// directory rather than against any pack checked out on disk.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PackRootError, isEngineLoadedPackFile, resolvePackRoot } from '../src/identifier.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'featurelab-packroot-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Builds `<root>/<packName>` as a real behaviour pack: a manifest.json at its root plus
 * whichever of the conventional subdirectories `subdirs` names (each populated with one
 * placeholder file, since resolvePackRoot only checks the subdirectory exists, not its
 * contents). Returns the pack's own root path. */
function makePack(packName: string, subdirs: string[]): string {
  const packRoot = path.join(root, packName)
  mkdirSync(packRoot, { recursive: true })
  writeFileSync(path.join(packRoot, 'manifest.json'), '{}', 'utf-8')
  for (const subdir of subdirs) {
    mkdirSync(path.join(packRoot, subdir), { recursive: true })
  }
  return packRoot
}

describe('resolvePackRoot: manifest.json + conventional subdirectories', () => {
  it('resolves correctly for a file directly in features/', () => {
    const packRoot = makePack('AddonBp', ['features', 'feature_rules', 'biomes'])
    const file = path.join(packRoot, 'features', 'poplar_tree.json')
    writeFileSync(file, '{}', 'utf-8')
    expect(resolvePackRoot(file)).toBe(packRoot)
  })

  it('resolves correctly for a file in feature_rules/ -- the reported repro shape', () => {
    // Mirrors a built behaviour pack's own layout exactly: manifest.json
    // at the pack root, feature_rules/ one level below it, no ancestor directory named
    // "features" anywhere -- which is exactly what made the old features-only walk fail here.
    const packRoot = makePack('ExampleAddon_bp', ['features', 'feature_rules', 'biomes', 'structures', 'blocks'])
    const file = path.join(packRoot, 'feature_rules', 'example_rule.main.json')
    writeFileSync(file, '{}', 'utf-8')
    expect(resolvePackRoot(file)).toBe(packRoot)
  })

  it('resolves correctly for a file in biomes/', () => {
    const packRoot = makePack('ExampleAddon_bp', ['biomes', 'feature_rules'])
    const file = path.join(packRoot, 'biomes', 'crater.json')
    writeFileSync(file, '{}', 'utf-8')
    expect(resolvePackRoot(file)).toBe(packRoot)
  })

  it('resolves correctly for a file nested inside a subdirectory of feature_rules/', () => {
    const packRoot = makePack('AddonBp', ['feature_rules'])
    const file = path.join(packRoot, 'feature_rules', 'trees', 'poplar.fr.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{}', 'utf-8')
    expect(resolvePackRoot(file)).toBe(packRoot)
  })

  it('still resolves via corroborating subdirectories alone when manifest.json is missing (best-effort fallback)', () => {
    const packRoot = path.join(root, 'NoManifestBp')
    mkdirSync(path.join(packRoot, 'feature_rules'), { recursive: true })
    const file = path.join(packRoot, 'feature_rules', 'example_rule.main.json')
    writeFileSync(file, '{}', 'utf-8')
    expect(resolvePackRoot(file)).toBe(packRoot)
  })

  it('throws a clear PackRootError for a file genuinely outside any pack', () => {
    const outside = path.join(root, 'just_some_folder', 'not_a_pack')
    mkdirSync(outside, { recursive: true })
    const file = path.join(outside, 'random.json')
    writeFileSync(file, '{}', 'utf-8')
    expect(() => resolvePackRoot(file)).toThrow(PackRootError)
    expect(() => resolvePackRoot(file)).toThrow(/does not look like it's inside a behaviour pack/)
  })

  // A folder holding several unrelated packs can have a differently-cased "Biomes" sibling
  // folder (one of those projects, not any pack's own biomes/ subdirectory). On a
  // case-insensitive filesystem (the Windows/macOS default), a naive fs.existsSync/statSync
  // check for a "biomes" child directory resolves through the OS's own case-insensitive path
  // lookup and matches "Biomes" too -- corroborating a pack root that isn't one. This is why
  // resolvePackRoot reads the directory's real entries and compares names exactly instead.
  it('does not corroborate a pack root off a differently-cased sibling directory (case-sensitive marker matching)', () => {
    const outside = path.join(root, 'packs')
    mkdirSync(path.join(outside, 'Biomes'), { recursive: true }) // capital B -- not a "biomes" marker match
    const file = path.join(outside, 'probe.json')
    writeFileSync(file, '{}', 'utf-8')
    expect(() => resolvePackRoot(file)).toThrow(PackRootError)
  })
})

// The save-listener filter (see isEngineLoadedPackFile's own doc comment): a save must trigger
// a pack reload exactly when the engine actually loaded the file, i.e. it lives under one of
// the five conventional subdirectories pack.Load reads -- and never for a file outside the
// pack, or a pack-root file (manifest.json, README) the engine ignores.
describe('isEngineLoadedPackFile', () => {
  const packRoot = path.join('C:', 'packs', 'AddonBp')

  it.each([
    ['features', 'poplar_tree.json'],
    ['feature_rules', 'example_rule.main.json'],
    ['structures', 'well.mcstructure'],
    ['biomes', 'crater.json'],
    ['blocks', 'mossy_log.json'],
  ])('accepts a file under %s/', (dir, name) => {
    expect(isEngineLoadedPackFile(packRoot, path.join(packRoot, dir, name))).toBe(true)
  })

  it('accepts a file nested deeper inside features/', () => {
    expect(isEngineLoadedPackFile(packRoot, path.join(packRoot, 'features', 'trees', 'oak.json'))).toBe(true)
  })

  it('rejects a pack-root file the engine never loads (manifest.json)', () => {
    expect(isEngineLoadedPackFile(packRoot, path.join(packRoot, 'manifest.json'))).toBe(false)
  })

  it('rejects a file in a pack subdirectory the engine does not read (texts/)', () => {
    expect(isEngineLoadedPackFile(packRoot, path.join(packRoot, 'texts', 'en_US.lang'))).toBe(false)
  })

  it('rejects a file outside the pack entirely, even under a features/ of a DIFFERENT pack', () => {
    expect(isEngineLoadedPackFile(packRoot, path.join('C:', 'packs', 'OtherBp', 'features', 'a.json'))).toBe(false)
  })

  it('rejects the pack root itself', () => {
    expect(isEngineLoadedPackFile(packRoot, packRoot)).toBe(false)
  })
})
