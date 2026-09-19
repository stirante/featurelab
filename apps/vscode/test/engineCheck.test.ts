// engineCheck.test.ts -- the start-up question "does this engine binary actually run here?",
// against real child processes.
//
// REAL PROCESSES, not a mocked spawn. Every failure this module exists to catch is a property of
// the operating system's loader -- a file that is not executable, a binary for another platform,
// a path that is a directory -- and a fake spawn would be a test of the fake's opinion about
// those. The one case that needs standing in for (an engine that answers `version --json`
// properly) is supplied by running node with a script, which is still a real process with real
// stdio and a real exit code.
//
// The distinction the whole module turns on, and the one most likely to be broken by a
// well-meaning edit: an engine that RAN and did not understand `version` is a WORKING engine
// that predates the subcommand, and must pass. Failing it would mean this extension refusing to
// drive any engine older than itself -- the check breaking the tool it exists to make
// debuggable.
import { describe, expect, it, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { bundledEngineFreshness, forgetEngineProbes, probeEngine, type EngineProbe, type SpawnFn } from '../src/engineCheck.js'

/** A spawn that runs `node -e <script>` instead of the binary, so a test can decide exactly
 * what the "engine" prints and exits with. The binary path is still carried through, because
 * naming it is most of what the probe's answer is for. */
function fakeEngine(script: string): SpawnFn {
  return (_command, args, options) => spawn(process.execPath, ['-e', script, ...args], options)
}

beforeEach(() => {
  forgetEngineProbes()
})

describe('an engine that answers', () => {
  it('reports the version it printed, and names the path in the detail', async () => {
    const probe = await probeEngine(
      '/pretend/featurelab',
      fakeEngine('process.stdout.write(JSON.stringify({version:"v0.1.1",revision:"abcdef0123456789",go:"go1.23.0",os:"linux",arch:"amd64"}))'),
    )
    expect(probe.ok).toBe(true)
    expect(probe.version).toContain('v0.1.1')
    expect(probe.version).toContain('go1.23.0')
    expect(probe.version).toContain('linux/amd64')
    expect(probe.detail).toContain('/pretend/featurelab')
  })

  it('passes an engine too old to know the subcommand, because it demonstrably ran', async () => {
    const probe = await probeEngine(
      '/pretend/featurelab',
      fakeEngine('process.stderr.write("featurelab: unknown subcommand \\"version\\"\\n"); process.exit(2)'),
    )
    expect(probe.ok, 'an older engine was reported as broken').toBe(true)
    expect(probe.version).toBe('')
    // The log has to say why the version is blank, or a reader concludes the probe is broken.
    expect(probe.detail).toMatch(/older than this extension/)
    expect(probe.detail).toContain('unknown subcommand')
  })

  it('survives an engine that prints something other than JSON', async () => {
    const probe = await probeEngine('/pretend/featurelab', fakeEngine('console.log("featurelab v0.1.1 dev build")'))
    expect(probe.ok).toBe(true)
    expect(probe.version).toContain('featurelab v0.1.1 dev build')
  })
})

describe('an engine that does not run', () => {
  it('fails, names the path, and points at the setting that changes it', async () => {
    const missing = path.join(os.tmpdir(), 'featurelab-does-not-exist-' + String(process.pid))
    const probe = await probeEngine(missing)
    expect(probe.ok).toBe(false)
    expect(probe.binaryPath).toBe(missing)
    expect(probe.detail).toContain(missing)
    expect(probe.detail).toMatch(/featurelab\.binaryPath/)
    // The three things this actually is, in the words somebody can check themselves.
    expect(probe.detail).toMatch(/another platform or architecture/)
  })

  it('fails for a path that is a directory rather than a program', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-notabinary-'))
    try {
      const probe = await probeEngine(dir)
      expect(probe.ok).toBe(false)
      expect(probe.detail).toContain(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('what is remembered', () => {
  it('asks once for an engine that passed, and again for one that did not', async () => {
    let runs = 0
    const counting: SpawnFn = (command, args, options) => {
      runs++
      return fakeEngine('process.stdout.write(JSON.stringify({version:"v1",go:"go1",os:"x",arch:"y"}))')(command, args, options)
    }
    await probeEngine('/pretend/good', counting)
    await probeEngine('/pretend/good', counting)
    expect(runs, 'a working engine was re-probed on every command').toBe(1)

    let failing = 0
    const failingSpawn: SpawnFn = (command, args, options) => {
      failing++
      return fakeEngine('process.exit(0)')(command, args, options)
    }
    // A broken engine is the one somebody is fixing WHILE the error is on screen, so the answer
    // must not be cached -- otherwise the fix appears not to work until the window is reloaded.
    const missing = path.join(os.tmpdir(), 'featurelab-absent-' + String(process.pid))
    await probeEngine(missing)
    await probeEngine(missing)
    expect(failing).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// "Is the engine in bin/ the one this extension shipped with?"
//
// WHY THERE IS A RULE AT ALL. bin/ is chosen by process.platform and nothing else, and one
// checkout opened on two kinds of host builds two differently-spelled binaries into the same
// directory. Open a Windows checkout over Remote-WSL and you get `bin/featurelab`, which is
// whatever an older Linux build left there; it runs, it answers the probe, and until this rule
// existed nothing anywhere said a word about it. Every missing engine feature after that reads
// as a broken editor.
//
// WHAT "TOO OLD" MEANS. Equality with the extension's own version -- see bundledEngineFreshness
// for why a comparison would be the wrong shape. The stamp is not a guess: build-binary.mjs
// passes `-X main.buildVersion=<package.json version>`, so a bundled engine has exactly one
// version it can honestly report.
// ---------------------------------------------------------------------------
describe('whether the bundled engine is the one this extension shipped', () => {
  const probeWith = (rawVersion: string, ok = true): EngineProbe => ({
    ok,
    binaryPath: '/ext/bin/featurelab',
    version: rawVersion === '' ? 'unreported' : rawVersion,
    rawVersion,
    detail: 'probe detail',
  })

  it('passes the engine stamped with this extension\'s own version', () => {
    expect(bundledEngineFreshness(probeWith('0.1.1'), '0.1.1').stale).toBe(false)
  })

  it('flags one stamped with a different version, and says which two they are', () => {
    const freshness = bundledEngineFreshness(probeWith('0.0.9'), '0.1.1')
    expect(freshness.stale).toBe(true)
    // Both numbers, because a message carrying only one of them cannot be acted on.
    expect(freshness.detail).toContain('0.0.9')
    expect(freshness.detail).toContain('0.1.1')
    expect(freshness.detail).toContain('/ext/bin/featurelab')
    // And the remedy, which is not obvious: the binary is not committed, so "reinstall" is not
    // the only answer and is not the one a developer wants.
    expect(freshness.detail).toMatch(/npm run build:binary/)
  })

  it('flags one NEWER than this extension too, because it is equally not the one that shipped', () => {
    // Deliberately not "older than". A bin/ holding a future build is the same fault -- a file
    // that does not belong to this build -- and a rule that only looked downwards would call it
    // fine.
    expect(bundledEngineFreshness(probeWith('9.9.9'), '0.1.1').stale).toBe(true)
  })

  it('flags one that reports no version at all, rather than assuming it is current', () => {
    // An unstamped `go build`, or an engine so old it predates the subcommand. Either may be any
    // age whatsoever and this extension has no way to tell -- which is the case that most needs
    // saying, not the one to give the benefit of the doubt to.
    const freshness = bundledEngineFreshness(probeWith(''), '0.1.1')
    expect(freshness.stale).toBe(true)
    expect(freshness.detail).toMatch(/does not report a version/i)
  })

  it('says nothing when the extension cannot read its own version', () => {
    // No manifest, no standing. Guessing here would produce a warning about every engine on
    // every machine where package.json could not be read.
    expect(bundledEngineFreshness(probeWith('0.0.9'), null).stale).toBe(false)
    expect(bundledEngineFreshness(probeWith('0.0.9'), '').stale).toBe(false)
  })

  it('says nothing about an engine that did not run, because that is already being reported', () => {
    expect(bundledEngineFreshness(probeWith('', false), '0.1.1').stale).toBe(false)
  })

  it('reads the raw version off the probe undecorated, so the comparison is against a version', () => {
    // The human-readable `version` carries the revision, the Go version and the platform. Only
    // `rawVersion` is comparable, and this is the test that keeps the two from being confused.
    const probe = probeWith('0.1.1')
    expect(probe.rawVersion).toBe('0.1.1')
    expect(bundledEngineFreshness({ ...probe, version: '0.1.1 (abcdef012345) go1.23.0 linux/amd64' }, '0.1.1').stale).toBe(false)
  })
})

describe('the raw version a probe reports', () => {
  it('is the version field alone, not the decorated line', async () => {
    const probe = await probeEngine(
      '/pretend/featurelab',
      fakeEngine('process.stdout.write(JSON.stringify({version:"0.1.1",revision:"abcdef0123456789",go:"go1.23.0",os:"linux",arch:"amd64"}))'),
    )
    expect(probe.rawVersion).toBe('0.1.1')
    // The decorated one still carries everything it always did.
    expect(probe.version).toContain('go1.23.0')
  })

  it('is empty for an engine that prints prose, which is not something to compare', async () => {
    const probe = await probeEngine('/pretend/featurelab', fakeEngine('console.log("featurelab v0.1.1 dev build")'))
    expect(probe.rawVersion).toBe('')
  })

  it('is empty for an unstamped build, which calls itself "(devel)"', async () => {
    // THIS IS THE CASE THE FILTER EXISTS FOR, and for a while nothing could produce it. A plain
    // `go build` used to report whatever debug.ReadBuildInfo held, which since Go 1.24 is derived
    // from the checkout -- "v0.1.1+dirty" here. That walked straight past a filter written to
    // catch exactly this build, and the extension then told a developer that bin/ held an engine
    // left over from a different release: a thing that had not happened, with a remedy that was
    // not the remedy. cmd/featurelab/version.go now answers "(devel)" for it (resolveVersion).
    const probe = await probeEngine('/pretend/featurelab', fakeEngine('process.stdout.write(JSON.stringify({version:"(devel)",go:"go1.23.0"}))'))
    expect(probe.rawVersion).toBe('')
  })

  it('is empty for a build with no build information, which calls itself "unknown"', async () => {
    // The engine's other no-version answer -- not "this is a dev build" but "this binary cannot
    // tell you what it is". Same conclusion here: not something to compare against a manifest.
    const probe = await probeEngine('/pretend/featurelab', fakeEngine('process.stdout.write(JSON.stringify({version:"unknown",go:"go1.23.0"}))'))
    expect(probe.rawVersion).toBe('')
  })

  it('is empty for Go\'s older bracket-less "devel" spelling too', async () => {
    const probe = await probeEngine('/pretend/featurelab', fakeEngine('process.stdout.write(JSON.stringify({version:"devel",go:"go1.23.0"}))'))
    expect(probe.rawVersion).toBe('')
  })

  // And the end-to-end shape of the fix: an unstamped engine reaches the freshness rule as "no
  // version", so the fault it reports is the unstamped one rather than a wrong-release one.
  it('makes an unstamped bundled engine report the unstamped fault, not a wrong-version one', async () => {
    const probe = await probeEngine('/pretend/featurelab', fakeEngine('process.stdout.write(JSON.stringify({version:"(devel)",revision:"abcdef0123456789",go:"go1.23.0"}))'))
    const freshness = bundledEngineFreshness(probe, '0.1.1')
    expect(freshness.stale).toBe(true)
    expect(freshness.detail).toMatch(/does not report a version/i)
    expect(freshness.detail).toMatch(/npm run build:binary/)
    // Not the "left over from a different build" wording, which would be a true-sounding sentence
    // about something that did not happen.
    expect(freshness.detail).not.toMatch(/reports version/)
  })
})
