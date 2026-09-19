// engineCheck.ts -- "does the engine this extension is about to drive actually run on this
// machine?", asked once, before a command needs the answer.
//
// WHY IT IS A SEPARATE PROBE. binaryResolver.ts only checks that a FILE is there. Everything
// else that can be wrong with an engine binary -- a VSIX built for another platform, a file
// without the execute bit, a `featurelab.binaryPath` pointing at a stale build or at a
// directory, a Gatekeeper/AV quarantine -- produces a file that exists and a spawn that fails.
// Until this existed, every one of those surfaced as the FIRST engine request hanging until the
// request timeout and then being reported as a crashed engine, or as nothing at all when the
// failing call was the background pre-warm. "The extension does nothing" is what all of them
// looked like.
//
// So a command asks here first, gets a yes/no plus the engine's own words, and can say exactly
// which of those it is, naming the path it tried.
//
// A SUCCESS IS REMEMBERED, A FAILURE IS NOT. Re-probing a working engine on every command is a
// process spawn nobody needs; re-probing a broken one is the cheapest possible way to notice
// that the user has just fixed it, which is precisely what they are doing while the error is on
// screen.
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process'

/** Matches node:child_process' spawn closely enough for this file, the same seam
 * engineProcess.ts and textures.ts already use to run against a fake engine in tests. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface EngineProbe {
  /** Whether the binary ran at all. Not "whether it understood the probe": see `version`. */
  readonly ok: boolean
  /** The path that was tried, always -- it is the single most useful fact in a failure and the
   * thing a user has to change. */
  readonly binaryPath: string
  /** What the engine calls itself, or '' when it could not be asked. An engine older than the
   * `version` subcommand answers "unknown subcommand" on stderr and exits non-zero; that is a
   * WORKING engine and is reported as ok with an empty version, never as a failure -- the
   * extension resolves whatever `featurelab` it is pointed at, and refusing to run against one
   * that predates a diagnostic subcommand would be this check breaking the tool it exists to
   * make debuggable. */
  readonly version: string
  /** The `version` FIELD alone, exactly as the engine printed it ("0.1.1"), with none of the
   * revision/Go/platform decoration `version` above carries for a human reader. Empty when the
   * engine reported none. This is the only spelling it is safe to compare, which is what the
   * freshness rule below does. */
  readonly rawVersion: string
  /** One paragraph for the log: what was run, what it answered, and -- on failure -- what to do
   * about it. */
  readonly detail: string
}

/** How long the probe waits. Generous: this is one process start plus a `fmt.Println`, so a
 * machine that cannot do it in ten seconds has a problem worth reporting as one. */
const PROBE_TIMEOUT_MS = 10_000

const passed = new Map<string, EngineProbe>()

/** Forgets remembered results. Called by tests; nothing in the product needs it. */
export function forgetEngineProbes(): void {
  passed.clear()
}

/** Runs `<binary> version --json`, or returns the remembered answer for a binary that has
 * already passed this session. */
export async function probeEngine(binaryPath: string, spawnFn: SpawnFn = spawn as unknown as SpawnFn): Promise<EngineProbe> {
  const remembered = passed.get(binaryPath)
  if (remembered !== undefined) return remembered
  const probe = await runProbe(binaryPath, spawnFn)
  if (probe.ok) passed.set(binaryPath, probe)
  return probe
}

/** Whether the BUNDLED engine is the one this extension shipped with, and what to say if not. */
export interface EngineFreshness {
  readonly stale: boolean
  /** One paragraph for the log and the notification. Empty when nothing is wrong. */
  readonly detail: string
}

const FRESH: EngineFreshness = { stale: false, detail: '' }

/** WHAT "TOO OLD" MEANS, and why it is this and not a version comparison.
 *
 * The bundled engine is not a dependency with a compatible range -- it is a file `npm run
 * package` builds from the source sitting beside this extension, stamped with the extension's
 * OWN version (`-X main.buildVersion=<package.json version>`, scripts/build-binary.mjs). The two
 * ship together and are released together, so there is exactly one version a bundled engine can
 * honestly report: this extension's. Anything else -- older, newer, or absent -- means the file
 * in bin/ is not the one that belongs to this build, and "not the one that belongs to this
 * build" is the whole of the fault. So the rule is EQUALITY, not "older than".
 *
 * Deliberately not a semver comparison. A comparison needs a minimum to compare against, a
 * minimum is a number somebody has to remember to raise, and the failure mode of forgetting is
 * silence -- which is the bug this exists to end. Equality has nothing to maintain and cannot
 * drift.
 *
 * NOTHING HERE REFUSES ANYTHING. A mismatched bundled engine is reported and then driven: it is
 * a real featurelab that answered a real probe, it is very likely to work, and an extension that
 * declined to start over a version string would be worse than the silence it replaced. Every
 * other version-tolerance rule in this file (an engine that predates `version`, a field this
 * build has never seen) exists for the same reason and is untouched.
 *
 * ONLY EVER ASKED ABOUT A BUNDLED ENGINE. A `featurelab.binaryPath` is somebody pointing this
 * extension at a specific build on purpose, frequently an older one -- see BinarySource. The
 * caller does not call this for those, and this function has no way to know the difference, so
 * that restriction lives at the call site and is written down in both places. */
export function bundledEngineFreshness(probe: EngineProbe, extensionVersion: string | null): EngineFreshness {
  if (!probe.ok) return FRESH
  // No manifest version to compare against -- see binaryResolver's extensionVersion. Saying
  // nothing is the only honest answer.
  if (extensionVersion === null || extensionVersion.length === 0) return FRESH
  if (probe.rawVersion === extensionVersion) return FRESH
  const shipped = `This extension is version ${extensionVersion}, and the engine it ships is stamped with that same version when it is built.`
  if (probe.rawVersion === '') {
    return {
      stale: true,
      detail:
        `The bundled engine at ${probe.binaryPath} does not report a version. ${shipped}\n` +
        `An unstamped binary is one left behind by a plain "go build" or by an earlier packaging run, not the copy ` +
        `this extension shipped -- it may be any age, and this extension has no way to tell. Run "npm run build:binary" ` +
        `in apps/vscode to replace it, reinstall the extension, or set "featurelab.binaryPath" to the engine you mean to use.`,
    }
  }
  return {
    stale: true,
    detail:
      `The bundled engine at ${probe.binaryPath} reports version ${probe.rawVersion}. ${shipped}\n` +
      `So the file in bin/ is left over from a different build of this extension, and features this version expects ` +
      `may be missing from it. Run "npm run build:binary" in apps/vscode to replace it, reinstall the extension, or set ` +
      `"featurelab.binaryPath" to the engine you mean to use.`,
  }
}

interface ProbeOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  spawnError: string | null
  timedOut: boolean
}

async function runProbe(binaryPath: string, spawnFn: SpawnFn): Promise<EngineProbe> {
  const started = Date.now()
  const outcome = await collect(binaryPath, spawnFn)
  const took = `${String(Date.now() - started)}ms`

  if (outcome.spawnError !== null) {
    return {
      ok: false,
      binaryPath,
      version: '',
      rawVersion: '',
      detail:
        `The engine at ${binaryPath} could not be started (${outcome.spawnError}).\n` +
        `A file that is present but will not start is usually one of: a VSIX built for another ` +
        `platform or architecture, a file without the execute bit, or a "featurelab.binaryPath" ` +
        `setting pointing at a directory or a stale build. Set "featurelab.binaryPath" to a ` +
        `featurelab executable for this machine, or reinstall the extension.`,
    }
  }
  if (outcome.timedOut) {
    return {
      ok: false,
      binaryPath,
      version: '',
      rawVersion: '',
      detail:
        `The engine at ${binaryPath} did not answer "version" within ${String(PROBE_TIMEOUT_MS)}ms and was killed.\n` +
        `Something is holding the process up before it writes a line -- an antivirus or code-signing ` +
        `check on first run is the usual cause. Running it once from a terminal is the quickest way to find out.`,
    }
  }

  const version = readVersion(outcome.stdout)
  if (outcome.code === 0) {
    return {
      ok: true,
      binaryPath,
      version: version === '' ? 'unreported' : version,
      rawVersion: readRawVersion(outcome.stdout),
      detail: `Engine at ${binaryPath} answered "version" in ${took}: ${version === '' ? outcome.stdout.trim() : version}`,
    }
  }
  // It ran, and refused. An engine that predates `version` exits 2 with "unknown subcommand" --
  // which proves exactly what this probe is for, so it passes. See EngineProbe.version.
  return {
    ok: true,
    binaryPath,
    version: '',
    rawVersion: '',
    detail:
      `Engine at ${binaryPath} ran in ${took} but did not understand "version" ` +
      `(exit ${String(outcome.code)}). It is older than this extension; everything else should still work. ` +
      `Its answer was: ${outcome.stderr.trim() || outcome.stdout.trim() || '(nothing)'}`,
  }
}

function collect(binaryPath: string, spawnFn: SpawnFn): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnFn(binaryPath, ['version', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      // spawn() throws synchronously for a few argument-shaped failures rather than emitting
      // 'error'. Both mean the same thing here and must not escape as an exception from a
      // function whose whole job is to answer the question calmly.
      resolve({ code: null, signal: null, stdout: '', stderr: '', spawnError: err instanceof Error ? err.message : String(err), timedOut: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => (stderr += chunk))
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, signal: null, stdout, stderr, spawnError: null, timedOut: true })
    }, PROBE_TIMEOUT_MS)
    child.on('error', (err: Error) => finish({ code: null, signal: null, stdout, stderr, spawnError: err.message, timedOut: false }))
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, spawnError: null, timedOut: false }))
  })
}

/** Reads the version out of `featurelab version --json`'s answer, tolerating an engine that
 * prints a plain line instead. Anything unreadable is reported as no version rather than as a
 * failure: the probe is about whether the process RAN. */
/** The `version` field on its own, undecorated, for comparing. Empty whenever the engine did not
 * print a JSON object with a string `version` in it -- including a plain prose line, which is
 * readable for a log and is not something to compare against a manifest.
 *
 * SO IS A BUILD THAT REPORTS NO VERSION, and these are the exact words it uses. cmd/featurelab/
 * version.go answers "(devel)" for a `go build` that -ldflags stamped nothing, and "unknown" when
 * it has no build information at all; both are named constants there with a comment pointing back
 * here. They are the ABSENCE of a version, and treating either as one would let an unstamped
 * build claim to be whatever it liked -- so they come back empty, and the caller's freshness rule
 * reports the "does not report a version" fault, which is the accurate one and the one whose
 * remedy (`npm run build:binary`) is the remedy that works.
 *
 * "devel" without the brackets is Go's older spelling of the same thing, kept for an engine built
 * by a toolchain that used it. */
function readRawVersion(stdout: string): string {
  const text = stdout.trim()
  if (text.length === 0) return ''
  try {
    const parsed = JSON.parse(text) as { version?: unknown }
    if (typeof parsed.version !== 'string') return ''
    const version = parsed.version.trim()
    return version === 'unknown' || version === '(devel)' || version === 'devel' ? '' : version
  } catch {
    return ''
  }
}

function readVersion(stdout: string): string {
  const text = stdout.trim()
  if (text.length === 0) return ''
  try {
    const parsed = JSON.parse(text) as { version?: unknown; revision?: unknown; go?: unknown; os?: unknown; arch?: unknown }
    if (typeof parsed.version !== 'string') return text.split('\n')[0] ?? ''
    const parts = [parsed.version]
    if (typeof parsed.revision === 'string' && parsed.revision.length > 0) parts.push(`(${parsed.revision.slice(0, 12)})`)
    if (typeof parsed.go === 'string' && parsed.go.length > 0) parts.push(parsed.go)
    if (typeof parsed.os === 'string' && typeof parsed.arch === 'string') parts.push(`${parsed.os}/${parsed.arch}`)
    return parts.join(' ')
  } catch {
    return text.split('\n')[0] ?? ''
  }
}
