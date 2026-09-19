#!/usr/bin/env node
// build-binary.mjs -- builds cmd/featurelab for the host platform straight from source and
// drops it into apps/vscode/bin/, the location binaryResolver.ts falls back to when
// "featurelab.binaryPath" isn't set. Run automatically by `npm run package` (see
// package.json) -- the binary is never committed (see the repo's .gitignore); packaging
// always builds a fresh one from whatever cmd/featurelab currently contains.
//
// Builds for the CURRENT host OS/arch only. A real release pipeline would matrix this over
// every target platform; that is CI/release-automation work, done by scripts/release/ rather
// than here.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(dirname(appRoot)) // apps/vscode -> apps -> repo root
const goModulePath = join(repoRoot, 'cmd', 'featurelab')
const binDir = join(appRoot, 'bin')
const binaryName = process.platform === 'win32' ? 'featurelab.exe' : 'featurelab'
const outPath = join(binDir, binaryName)

if (!existsSync(goModulePath)) {
  console.error(`build-binary: cmd/featurelab not found at ${goModulePath}`)
  process.exit(1)
}

mkdirSync(binDir, { recursive: true })

// The extension reports the engine's version in its log, and "unknown" there is a step backwards
// when someone is diagnosing a mismatched binary. The extension's own version is the honest answer
// for a bundled engine: they ship together.
const version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version
const ldflags = `-X main.buildVersion=${version}`

console.log(`build-binary: go build -ldflags "${ldflags}" -o ${outPath} ./cmd/featurelab  (cwd=${repoRoot})`)
const result = spawnSync('go', ['build', '-ldflags', ldflags, '-o', outPath, './cmd/featurelab'], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`build-binary: failed to run "go build" -- is Go installed and on PATH? (${result.error.message})`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`build-binary: "go build" exited with status ${result.status}`)
  process.exit(result.status ?? 1)
}
console.log(`build-binary: wrote ${outPath}`)
