#!/usr/bin/env node
// release.mjs -- cuts a release of the VS Code extension: bumps its version, commits, and tags.
//
//   npm run release -- patch        (or minor, major, or an exact version like 0.3.0)
//
// It stops at the tag. Pushing is what publishes -- .github/workflows/release.yml builds a VSIX
// per platform on a `v*` tag and attaches them to a GitHub release (its Marketplace / Open VSX
// job is commented out while those are published by hand) -- so the push is left to a person,
// who gets the exact command.
//
// The version is bumped with `npm version --workspace`, not by editing package.json, because the
// root package-lock.json records the workspace's version too and `npm ci` in CI refuses a lock
// file that disagrees with the package it describes.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(dirname(appRoot))
const bump = process.argv[2]

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32' && command === 'npm',
  })
  if (result.error) fail(`could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with status ${result.status}`)
  return capture ? result.stdout.trim() : ''
}

if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  fail('usage: npm run release -- <patch|minor|major|x.y.z>')
}

// A release is a snapshot of what is committed. Uncommitted work would either be left out of the
// tag silently or swept into the release commit, and neither is what somebody cutting a release
// means.
if (run('git', ['status', '--porcelain'], { capture: true }) !== '') {
  fail('the working tree has uncommitted changes; commit or stash them first')
}
const branch = run('git', ['branch', '--show-current'], { capture: true })
if (branch !== 'main') fail(`releases are cut from main, and this is ${branch || 'a detached HEAD'}`)

run('npm', ['version', bump, '--workspace', 'apps/vscode', '--no-git-tag-version'])

const version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version
const tag = `v${version}`
if (run('git', ['tag', '--list', tag], { capture: true }) !== '') fail(`tag ${tag} already exists`)

run('git', ['add', 'apps/vscode/package.json', 'package-lock.json'])
run('git', ['commit', '-m', `Release ${tag}`])
run('git', ['tag', '-a', tag, '-m', `Release ${tag}`])

console.log(`\nrelease: committed and tagged ${tag}. Nothing has been pushed.`)
console.log(`release: to publish, run:  git push origin main ${tag}`)
