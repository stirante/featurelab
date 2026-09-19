// binaryResolver.ts -- finds the featurelab engine executable. Per this package's charter:
// "the extension resolves the featurelab executable from its own bundled location, with a
// configurable override for development."
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as vscode from 'vscode'

/** No engine executable where this extension looked.
 *
 * Split into a SHORT `message` and a longer `detail` on purpose. The message is what goes in a
 * notification, and a notification is one line wide: a sentence carrying the path AND two
 * remedies was truncated exactly where the path was, which is the only part a user needs to read
 * before they can act. The remedies go to the output channel, behind the "Show log" button every
 * failure notification carries. `triedPath` is exposed so a caller can phrase its own sentence
 * around the path without re-deriving it. */
export class BinaryNotFoundError extends Error {
  readonly detail: string
  constructor(readonly triedPath: string) {
    super(`featurelab engine executable not found at "${triedPath}"`)
    this.name = 'BinaryNotFoundError'
    this.detail =
      `No featurelab engine executable at "${triedPath}".\n` +
      `This extension ships its own copy under bin/. If you built or installed it from source, run ` +
      `"npm run build:binary" in apps/vscode; otherwise reinstall the extension, or set ` +
      `"featurelab.binaryPath" in your settings to a featurelab executable built for this machine.`
  }
}

/** The bundled binary's platform-specific filename, matching scripts/build-binary.mjs's own
 * output naming (which just uses `go build`'s default binary name for the host GOOS). */
function bundledBinaryName(): string {
  return process.platform === 'win32' ? 'featurelab.exe' : 'featurelab'
}

/** The other spelling -- what build-binary.mjs would have written on the OTHER kind of host.
 * Both can be sitting in one bin/ at once: the same checkout opened locally on Windows and
 * again over Remote-WSL builds into the same directory under two names, and only one of them is
 * ever rebuilt by the host that is running. See staleSiblingNote. */
function otherBinaryName(): string {
  return process.platform === 'win32' ? 'featurelab' : 'featurelab.exe'
}

/** WHERE the engine came from. It decides one thing and only one: whether this extension is
 * entitled to have an opinion about the binary's VERSION.
 *
 * A bundled engine ships with the extension and is stamped with the extension's own version
 * (scripts/build-binary.mjs passes `-X main.buildVersion=<package.json version>`), so a
 * disagreement there is a fact, not a guess. A `featurelab.binaryPath` is the opposite: pointing
 * at an older engine on purpose is the documented reason the setting exists, and refusing --
 * or nagging about -- a deliberately pinned build would break the one workflow the setting is
 * for. Nothing in this module or in engineCheck's freshness rule applies to 'setting'. */
export type BinarySource = 'setting' | 'bundled'

export interface ResolvedBinary {
  readonly path: string
  readonly source: BinarySource
}

/**
 * Resolves the featurelab executable this extension should drive, and says where it came from:
 *   1. the `featurelab.binaryPath` setting, if non-empty (development override) -- used
 *      verbatim, not required to live under the extension at all, and never second-guessed.
 *   2. otherwise, `<extension>/bin/<platform-name>` -- the copy `npm run package` builds
 *      into the VSIX (see scripts/build-binary.mjs; never committed, see the repo's
 *      .gitignore).
 * Throws BinaryNotFoundError if the resolved path does not exist, so a caller can surface a
 * clear, actionable message instead of a spawn() ENOENT with no context.
 */
export function resolveEngineBinary(context: vscode.ExtensionContext): ResolvedBinary {
  const override = vscode.workspace.getConfiguration('featurelab').get<string>('binaryPath', '').trim()
  const resolved: ResolvedBinary =
    override.length > 0
      ? { path: override, source: 'setting' }
      : { path: path.join(context.extensionPath, 'bin', bundledBinaryName()), source: 'bundled' }
  if (!fs.existsSync(resolved.path)) {
    throw new BinaryNotFoundError(resolved.path)
  }
  return resolved
}

/** resolveEngineBinary's path alone, for the callers that have no use for where it came from. */
export function resolveBinaryPath(context: vscode.ExtensionContext): string {
  return resolveEngineBinary(context).path
}

/** The version this extension SHIPS -- the number build-binary.mjs stamps into the engine it
 * builds, read back from the same package.json it reads it from.
 *
 * Read off disk rather than bundled in, because the answer has to be the manifest that actually
 * shipped: an esbuild-time constant would keep asserting the version of whatever checkout
 * produced the bundle. Null when it cannot be read at all, and a null means the freshness check
 * is SKIPPED -- an extension that cannot find its own manifest has no standing to call anything
 * else stale. */
export function extensionVersion(context: vscode.ExtensionContext): string | null {
  try {
    const raw = fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}

/** "There is a newer engine sitting next to the one that was chosen, under the other spelling."
 *
 * bin/ is picked from `process.platform` and nothing else, which is correct -- a Linux host
 * cannot run featurelab.exe -- but it means a directory holding both spellings hands each host a
 * different file, and only the host that last ran `npm run build:binary` has a current one. Open
 * the same checkout over Remote-WSL after building on Windows and the engine you get is whatever
 * the last Linux build left behind, which can be weeks old.
 *
 * Returns null unless the sibling really is newer, so this never speaks up in the ordinary case
 * of one binary in bin/. It is a SENTENCE FOR THE LOG, not a decision: the sibling is unrunnable
 * on this host, so there is nothing to switch to -- what a person needs is to be told why their
 * engine is behind. */
export function staleSiblingNote(binaryPath: string): string | null {
  try {
    const sibling = path.join(path.dirname(binaryPath), otherBinaryName())
    const mine = fs.statSync(binaryPath).mtimeMs
    const theirs = fs.statSync(sibling).mtimeMs
    if (theirs <= mine) return null
    return (
      `There is a newer engine beside it at ${sibling} (built ${new Date(theirs).toISOString()}, against ` +
      `${new Date(mine).toISOString()} for the one in use). That one is for the other kind of host and cannot run here; ` +
      `run "npm run build:binary" on THIS host to refresh the one that can.`
    )
  } catch {
    // No sibling, or a bin/ that cannot be stat'd. Both mean "nothing to report".
    return null
  }
}
