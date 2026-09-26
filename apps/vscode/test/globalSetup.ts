// globalSetup.ts -- what the suite needs on disk, settled ONCE, before any test file starts.
//
// Two built artefacts are read by tests rather than built by them: apps/vscode's own dist/ (the
// bundles the journeys, scale.test.ts, bundleActivation and reachability load) and
// frontend/dist (tsc output that every bundle of webview/graph.ts and webview/main.ts pulls in
// through `featurelab-frontend`). Both used to be looked after per test FILE, and both went wrong
// in a way that looked like flakiness.
//
// 1. dist/ WAS REBUILT BY EVERY JOURNEY FILE. ensureBundleBuilt() ran esbuild "once per process",
//    and vitest runs each file in its own process -- so with the default pool, up to eleven
//    journeys rewrote dist/ while the others were serving it to Chromium. esbuild truncates and
//    rewrites in place; a reader in between gets a short or EMPTY file. Measured with two
//    rebuilders and one reader: 17 of 288 reads of dist/ came back 0 bytes in 20 s. An empty
//    graph.js is a page that never draws a card, which a journey reports 20 s later as
//    "waiting for locator('.flg-node')" -- nothing about a build at all. Built here, the bundle
//    is written before any file starts and never again during the run.
//
// 2. frontend/dist WAS CHECKED ONLY FOR PREVIEW JOURNEYS, but webview/graph.ts imports the same
//    package, so every graph journey and every Chromium test that bundles graph.ts was running a
//    stale viewer package without being told. Checked here, for the whole run, before anything
//    starts: a stale build fails the run in one line that says which command to type.
//
// The rebuild is skipped with FEATURELAB_SKIP_BUILD=1, as before, for iterating on a test against
// a bundle built by hand. The freshness check is not skippable: there is no run it makes better.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontendRoot = path.resolve(appRoot, '..', '..', 'frontend')

/** Refuses to run against a frontend/dist older than frontend/src.
 *
 * Checked rather than built: building it is a tsc run plus an asset copy, and belongs in the
 * command a developer already types. Compared on mtime, which is the only signal available without
 * reproducing tsc's own staleness logic. A clock-skewed checkout could false-positive; being told
 * to run a build you have already run is a far better failure than a green suite over a viewer
 * from before your change. */
export function staleFrontendReason(): string | null {
  const built = path.join(frontendRoot, 'dist', 'index.js')
  if (!fs.existsSync(built)) return 'frontend/dist is missing'
  const builtAt = fs.statSync(built).mtimeMs
  const newer: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (fs.statSync(full).mtimeMs > builtAt) newer.push(path.relative(frontendRoot, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(frontendRoot, 'src'))
  if (newer.length === 0) return null
  const more = newer.length > 3 ? ` (and ${String(newer.length - 3)} more)` : ''
  return `frontend/dist is older than ${newer.slice(0, 3).join(', ')}${more}`
}

export default function setup(): void {
  const stale = staleFrontendReason()
  if (stale !== null) {
    throw new Error(
      `${stale}, so every bundle this suite builds would contain a viewer from before your change. ` +
        `Run "npm run build" in frontend/ (or "npm run --workspace frontend build" from the repo root) first.`,
    )
  }
  if (process.env['FEATURELAB_SKIP_BUILD'] !== '1') {
    const result = spawnSync(process.execPath, ['esbuild.config.mjs'], { cwd: appRoot, encoding: 'utf8' })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `the extension bundles would not build, so there is nothing honest to test.\n` +
          `  ${result.error?.message ?? result.stderr ?? `exit ${String(result.status)}`}`,
      )
    }
  }
  // Read by the journey harness: the bundle is settled for this run, so no file rebuilds it. Set
  // here, in the main process, before the pools exist -- vitest hands the workers this process's
  // environment when it starts them.
  process.env['FEATURELAB_BUNDLE_SETTLED'] = '1'
}
