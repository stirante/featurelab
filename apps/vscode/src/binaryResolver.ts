// binaryResolver.ts -- finds the featurelab engine executable. Per this package's charter:
// "the extension resolves the featurelab executable from its own bundled location, with a
// configurable override for development."
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as vscode from 'vscode'

export class BinaryNotFoundError extends Error {
  constructor(triedPath: string) {
    super(
      `featurelab engine executable not found at "${triedPath}". This extension ships its own copy under bin/ ` +
        `-- if you built/installed it from source, run "npm run build:binary" in apps/vscode, or set ` +
        `"featurelab.binaryPath" in your settings to point at a locally built cmd/featurelab binary.`,
    )
    this.name = 'BinaryNotFoundError'
  }
}

/** The bundled binary's platform-specific filename, matching scripts/build-binary.mjs's own
 * output naming (which just uses `go build`'s default binary name for the host GOOS). */
function bundledBinaryName(): string {
  return process.platform === 'win32' ? 'featurelab.exe' : 'featurelab'
}

/**
 * Resolves the path to the featurelab executable this extension should drive:
 *   1. the `featurelab.binaryPath` setting, if non-empty (development override) -- used
 *      verbatim, not required to live under the extension at all.
 *   2. otherwise, `<extension>/bin/<platform-name>` -- the copy `npm run package` builds
 *      into the VSIX (see scripts/build-binary.mjs; never committed, see the repo's
 *      .gitignore).
 * Throws BinaryNotFoundError if the resolved path does not exist, so a caller can surface a
 * clear, actionable message instead of a spawn() ENOENT with no context.
 */
export function resolveBinaryPath(context: vscode.ExtensionContext): string {
  const override = vscode.workspace.getConfiguration('featurelab').get<string>('binaryPath', '').trim()
  const candidate = override.length > 0 ? override : path.join(context.extensionPath, 'bin', bundledBinaryName())
  if (!fs.existsSync(candidate)) {
    throw new BinaryNotFoundError(candidate)
  }
  return candidate
}
