import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Test files that drive a real Chromium: every file that imports playwright, and every journey
 * (which get theirs through test/journeys/harness.ts). Found by reading the files rather than
 * listed, so a new Chromium test cannot land in the wrong pool by being forgotten here. */
function chromiumFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(here, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.test.ts')) {
        const text = fs.readFileSync(path.join(here, rel), 'utf8')
        if (/from 'playwright'|from '\.\/harness\.js'/.test(text)) found.push(rel)
      }
    }
  }
  walk('test')
  return found
}

/** How many Chromium test files may run at once.
 *
 * NOT the default. Vitest runs `availableParallelism() - 1` files at once -- 11 on a 12-thread
 * desktop -- and 29 of this suite's files each launch a Chromium that rasterises in software
 * (SwiftShader), most of them beside a real engine process. Eleven of those at once put forty-odd
 * browser processes on twelve hardware threads and ran the machine out of memory headroom (under
 * 2 GB free of 32), and what failed was never the same test twice: an afterAll's browser.close()
 * past the 10 s hook timeout, a journey's first card past its 20 s wait, a 300 ms keyboard settle
 * window firing between two keypresses. Every one of them passed alone. With four at once the
 * suite finished SOONER (409 s against ~500 s), because a Chromium that is not fighting ten
 * others for a core is faster than the time it spends waiting its turn.
 *
 * A third of the hardware threads, at least two, and FEATURELAB_TEST_BROWSERS overrides it --
 * for a machine that is busy with other work, set it lower. The rest of the suite is Node-only
 * and keeps the default parallelism in its own pool: it is 52 files and under a minute of work. */
function browserSlots(): number {
  const override = Number(process.env['FEATURELAB_TEST_BROWSERS'])
  if (Number.isInteger(override) && override > 0) return override
  return Math.max(2, Math.floor(os.availableParallelism() / 3))
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Builds dist/ once and refuses a stale frontend/dist, before any file starts. See the file.
    globalSetup: ['test/globalSetup.ts'],
    // Everything Node-only runs in forks, as it always has. The Chromium files run in their own
    // pool so that pool can be capped (browserSlots) without slowing the rest down.
    pool: 'forks',
    // Absolute paths rather than `**/` globs: `**` does not cross a dot directory, and a checkout
    // under one (an agent worktree in .claude/, say) would silently match nothing.
    poolMatchGlobs: chromiumFiles().map((file) => [path.join(here, file).replace(/\\/g, '/'), 'threads'] as [string, 'threads']),
    poolOptions: {
      threads: { maxThreads: browserSlots(), minThreads: 1 },
    },
    // A test's timeout is a hang detector, not a performance claim -- claims about time live in
    // scale.test.ts, where they say so. 10 s was a claim: commandFeedback.test.ts spawns the real
    // engine three times in one test and took longer than that on a loaded machine. Hooks get
    // longer again because they launch and close browsers, and closing a Chromium on a busy
    // machine has been measured past 10 s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
