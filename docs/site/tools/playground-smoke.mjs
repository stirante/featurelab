#!/usr/bin/env node
// playground-smoke.mjs -- does the playground actually place a feature, in a real browser,
// against the BUILT site?
//
// The build proves the component compiles and the link checkers prove the page exists; neither
// proves that the engine loads from where the manifest says, that Go's loader matches the .wasm,
// that the worker starts, or that a result reaches the viewer. This does, against `vitepress
// preview` of .vitepress/dist, headless:
//
//   1. /playground, cold: press Run the moment the button is on screen -- the reader who clicks
//      before the engine is ready -- and wait for the result. Assert the example's preset and
//      seed were applied and that it placed what features/scatter_feature.md says it places
//      (12 blocks at seed 9 on plains). A playground that disagrees with the prose beside it is
//      a bug in one of them.
//   2. the same page reloaded: the engine now comes from Cache Storage.
//   3. a client-side navigation to the scatter page: its embedded playground must reuse the
//      engine already running (the .wasm is not fetched again) and give the same answer.
//   4. a syntax error typed into the editor is reported with its line.
//
// It prints how long each took, which is the number to watch: time-to-first-result is what a
// reader waits.
//
// Usage (after `npm run build`, with the engine built into public/playground/ first):
//   node tools/playground-smoke.mjs [--screenshot <file.png>]
// Needs Playwright's Chromium: `npx playwright install chromium` once.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.DOCS_BASE ?? '/featurelab/'
const port = Number(process.env.PLAYGROUND_SMOKE_PORT ?? 4179)
const origin = `http://localhost:${port}`
const shotAt = process.argv.indexOf('--screenshot')
const screenshot = shotAt > 0 ? process.argv[shotAt + 1] : null

/** What features/scatter_feature.md says the pumpkin patch places at seed 9 on plains. */
const EXPECTED_PLACED = 12

const failures = []
function check(ok, message) {
  if (!ok) failures.push(message)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
}

async function waitForServer(url, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`vitepress preview did not answer at ${url}`)
}

const server = spawn(process.execPath, [path.join(siteDir, 'node_modules', 'vitepress', 'bin', 'vitepress.js'), 'preview', '--port', String(port)], {
  cwd: siteDir,
  stdio: ['ignore', 'pipe', 'inherit'],
})

let browser
try {
  await waitForServer(`${origin}${base}`, 30_000)
  const manifest = await fetch(`${origin}${base}playground/manifest.json`)
  if (!manifest.ok) throw new Error('the built site has no playground/manifest.json -- run scripts/build-playground.sh docs/site/public/playground before `npm run build`')
  const { wasm, size } = await manifest.json()
  console.log(`engine: ${wasm} (${(size / 1e6).toFixed(1)} MB)`)

  // Software WebGL, the same switches the figure pipeline uses: CI has no GPU.
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  let wasmFetches = 0
  page.on('request', (req) => {
    if (req.url().endsWith('.wasm')) wasmFetches++
  })

  const pg = page.locator('.fl-pg').first()

  /** Loads `url`, clicks Run as soon as it can, and returns the timings. */
  async function coldRun(url) {
    const t0 = Date.now()
    await page.goto(url)
    const run = pg.locator('.fl-pg-run')
    await run.waitFor({ state: 'visible' })
    // The panel appears once the viewer chunk has loaded; Run before that is a no-op by design,
    // so wait for it -- it is part of what a reader waits for.
    await pg.locator('.fl-panel').waitFor({ state: 'attached', timeout: 30_000 })
    const tClick = Date.now()
    const engineAtClick = await pg.getAttribute('data-engine')
    await run.click()
    await page.waitForFunction(() => document.querySelector('.fl-pg')?.hasAttribute('data-placed'), null, { timeout: 120_000 })
    const tResult = Date.now()
    return {
      engineAtClick,
      toClickable: tClick - t0,
      toResult: tResult - t0,
      placed: Number(await pg.getAttribute('data-placed')),
      runMs: Number(await pg.getAttribute('data-run-ms')),
      tile: (await pg.locator('.fl-stat-placed .fl-stat-value').textContent())?.trim(),
      timings: await page.evaluate(() => document.querySelector('.fl-pg p.fl-pg-status')?.getAttribute('title') ?? ''),
    }
  }

  // 1. cold
  const cold = await coldRun(`${origin}${base}playground`)
  console.log(`cold: clickable after ${cold.toClickable} ms (engine ${cold.engineAtClick}), first result after ${cold.toResult} ms; generate ${cold.runMs} ms; ${cold.timings}`)
  check(cold.placed > 0, `the playground placed blocks (${cold.placed})`)
  check(cold.tile !== undefined && cold.tile !== '0', `the panel's Placed tile shows a non-zero count (${cold.tile})`)
  const preset = await pg.locator('.fl-panel select').evaluateAll((els) => els.map((e) => e.value))
  check(preset.includes('plains'), `the example's preset was selected (${preset.join(', ')})`)
  check(cold.placed === EXPECTED_PLACED, `seed 9 on plains places ${EXPECTED_PLACED}, as the scatter page says (got ${cold.placed})`)
  if (screenshot) {
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshot, fullPage: true })
    console.log(`screenshot: ${screenshot}`)
  }

  // 2. warm: the engine from Cache Storage
  const warm = await coldRun(`${origin}${base}playground`)
  console.log(`warm: clickable after ${warm.toClickable} ms (engine ${warm.engineAtClick}), first result after ${warm.toResult} ms; ${warm.timings}`)
  check(/ cache\)/.test(warm.timings),'a reload takes the engine from Cache Storage')

  // 3. client-side navigation to the scatter page; the engine must be the one already running
  const fetchesBefore = wasmFetches
  const tNav = Date.now()
  await page.evaluate((to) => {
    // VitePress routes a same-site link click without a page load.
    const a = document.createElement('a')
    a.href = to
    document.body.append(a)
    a.click()
  }, `${base}features/scatter_feature`)
  await page.waitForURL(/scatter_feature/)
  // The URL changes before the old page is swapped out; until the new heading is there, `.fl-pg`
  // is still the /playground one.
  await page.locator('h1', { hasText: 'Scatter feature' }).waitFor()
  const embed = page.locator('.fl-pg').first()
  await embed.scrollIntoViewIfNeeded()
  await embed.locator('.fl-panel').waitFor({ state: 'attached', timeout: 30_000 })
  await embed.locator('.fl-pg-run').click()
  await page.waitForFunction(() => document.querySelector('.fl-pg')?.hasAttribute('data-placed'), null, { timeout: 60_000 })
  const embedPlaced = Number(await embed.getAttribute('data-placed'))
  console.log(`scatter page (SPA navigation): result ${Date.now() - tNav} ms after navigating`)
  check(wasmFetches === fetchesBefore, 'the embedded playground reused the running engine (no second .wasm request)')
  check(embedPlaced === EXPECTED_PLACED, `the embedded playground agrees (${embedPlaced})`)

  // 4. a syntax error is reported with its line
  await embed.locator('.fl-pg-text').evaluate((ta) => {
    ta.value = ta.value.replace('"iterations": 14,', '"iterations": 14,,')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const problem = embed.locator('.fl-pg-problem')
  await problem.waitFor({ timeout: 5_000 })
  const problemText = (await problem.textContent())?.trim() ?? ''
  check(/Line \d+/.test(problemText), `a syntax error names its line ("${problemText}")`)

  check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`)
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err))
  console.error(err)
} finally {
  await browser?.close()
  server.kill()
}

if (failures.length > 0) {
  console.error(`playground-smoke: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('playground-smoke: all checks passed')
