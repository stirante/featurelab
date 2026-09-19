// binaryResolver.test.ts -- WHICH featurelab executable this extension drives, and the two
// facts about it a caller needs in order to say anything useful when it is the wrong one.
//
// The module only ever proved that a FILE was there. That is exactly enough to pick up a stale
// binary in silence: bin/ is chosen by `process.platform` and nothing else, and a checkout
// opened on two kinds of host ends up with BOTH spellings in one bin/ -- `featurelab.exe` from
// the Windows window and `featurelab` from the Remote-WSL one. Only whichever host last ran
// "npm run build:binary" has a current engine; the other picks up whatever its spelling last
// pointed at, runs it, and nothing anywhere says a word. This checkout has exactly that shape.
//
// So the resolver now also answers WHERE the binary came from, because that decides whether this
// extension is entitled to an opinion about its version at all -- a `featurelab.binaryPath` is
// somebody pinning a build on purpose (the documented reason the setting exists) and is never
// second-guessed. The freshness rule itself lives in engineCheck.ts and is tested there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { vi } from 'vitest'
vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { BinaryNotFoundError, extensionVersion, resolveBinaryPath, resolveEngineBinary, staleSiblingNote } from '../src/binaryResolver.js'

const temporary: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

function context(extensionPath: string): import('vscode').ExtensionContext {
  return { extensionPath, extensionUri: new vscodeMock.MockUri(extensionPath) } as unknown as import('vscode').ExtensionContext
}

/** An extension directory with a bin/ in it. `names` are the binary spellings to create, in
 * order -- created one at a time with distinct mtimes, because "which of these is newer" is the
 * whole subject of the sibling case below. */
function extensionWithBinaries(names: string[], version?: string): string {
  const root = tempDir('fl-ext-')
  if (version !== undefined) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'featurelab', version }), 'utf8')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  let when = Date.now() - names.length * 86_400_000
  for (const name of names) {
    const file = path.join(root, 'bin', name)
    fs.writeFileSync(file, 'not really an engine\n', 'utf8')
    fs.utimesSync(file, new Date(when), new Date(when))
    when += 86_400_000
  }
  return root
}

const BUNDLED_NAME = process.platform === 'win32' ? 'featurelab.exe' : 'featurelab'
const OTHER_NAME = process.platform === 'win32' ? 'featurelab' : 'featurelab.exe'

beforeEach(() => {
  vscodeMock.resetMock()
  vscodeMock.mockConfig['binaryPath'] = ''
})

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('where the engine came from', () => {
  it('reports the bundled copy as bundled, so its version can be held to the manifest', () => {
    const root = extensionWithBinaries([BUNDLED_NAME])
    const resolved = resolveEngineBinary(context(root))
    expect(resolved.path).toBe(path.join(root, 'bin', BUNDLED_NAME))
    expect(resolved.source).toBe('bundled')
  })

  it('reports a featurelab.binaryPath as a setting, which is what exempts it from every check', () => {
    // THE CASE THIS PROTECTS. Pointing at an older engine on purpose is the documented reason
    // the setting exists, and a freshness rule applied to it would break the one workflow it is
    // for. The exemption has to be visible in the resolver's own answer, or the call site has
    // nothing to branch on.
    const pinned = path.join(tempDir('fl-bin-'), 'featurelab-0.0.9')
    fs.writeFileSync(pinned, 'an older engine, on purpose\n', 'utf8')
    vscodeMock.mockConfig['binaryPath'] = pinned

    const resolved = resolveEngineBinary(context(extensionWithBinaries([BUNDLED_NAME])))

    expect(resolved.path).toBe(pinned)
    expect(resolved.source).toBe('setting')
  })

  it('takes the setting verbatim, whatever the file is called', () => {
    // Neither of the two bundled spellings, and it must still work: the setting is a path, not a
    // naming convention, and a resolver that insisted on a name would refuse the local builds
    // developers actually keep.
    const odd = path.join(tempDir('fl-bin-'), 'featurelab-linux-arm64-debug')
    fs.writeFileSync(odd, 'still an engine\n', 'utf8')
    vscodeMock.mockConfig['binaryPath'] = odd

    expect(resolveBinaryPath(context(extensionWithBinaries([BUNDLED_NAME])))).toBe(odd)
  })

  it('still throws BinaryNotFoundError, naming the path it tried', () => {
    const root = tempDir('fl-ext-')
    expect(() => resolveEngineBinary(context(root))).toThrow(BinaryNotFoundError)
    try {
      resolveEngineBinary(context(root))
    } catch (err) {
      expect((err as BinaryNotFoundError).triedPath).toBe(path.join(root, 'bin', BUNDLED_NAME))
    }
  })
})

describe('the version this extension ships', () => {
  it('is read from the manifest the engine build stamps from', () => {
    // build-binary.mjs reads the version out of this same file and passes it as
    // -X main.buildVersion, so this is the only number a bundled engine can honestly report.
    expect(extensionVersion(context(extensionWithBinaries([BUNDLED_NAME], '1.2.3')))).toBe('1.2.3')
  })

  it('is null when there is no manifest, which is what skips the whole check', () => {
    expect(extensionVersion(context(extensionWithBinaries([BUNDLED_NAME])))).toBeNull()
  })

  it('is null for a manifest that is not JSON, rather than throwing into a command', () => {
    const root = extensionWithBinaries([BUNDLED_NAME])
    fs.writeFileSync(path.join(root, 'package.json'), '{ this is not json', 'utf8')
    expect(extensionVersion(context(root))).toBeNull()
  })
})

describe('a newer engine sitting beside the one that was chosen', () => {
  it('is reported, because the chosen one cannot be swapped for it and the user has to be told why', () => {
    // The real shape: `featurelab` from an old Linux build and `featurelab.exe` from yesterday's
    // Windows one, in the same bin/. Whichever host is running picks its own spelling and has no
    // way to run the other, so this is a SENTENCE, not a decision.
    const root = extensionWithBinaries([BUNDLED_NAME, OTHER_NAME])
    const note = staleSiblingNote(path.join(root, 'bin', BUNDLED_NAME))
    expect(note).not.toBeNull()
    expect(note).toContain(OTHER_NAME)
    expect(note).toMatch(/npm run build:binary/)
  })

  it('says nothing when the chosen one is the newer of the two', () => {
    const root = extensionWithBinaries([OTHER_NAME, BUNDLED_NAME])
    expect(staleSiblingNote(path.join(root, 'bin', BUNDLED_NAME))).toBeNull()
  })

  it('says nothing about the ordinary bin/ with one binary in it', () => {
    const root = extensionWithBinaries([BUNDLED_NAME])
    expect(staleSiblingNote(path.join(root, 'bin', BUNDLED_NAME))).toBeNull()
  })

  it('says nothing about a path with no directory to look in', () => {
    expect(staleSiblingNote(path.join(tempDir('fl-bin-'), 'nothing', 'featurelab'))).toBeNull()
  })
})
