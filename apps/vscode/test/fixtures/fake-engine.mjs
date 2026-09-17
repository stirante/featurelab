#!/usr/bin/env node
// fake-engine.mjs -- a minimal stand-in for `featurelab serve`, spawned as a real child
// process by engineProcess.test.ts. Exercises engineProcess.ts's real stdio plumbing (not a
// mocked child_process) against a handful of scripted scenarios a real engine binary would
// be awkward to force on demand: a clean round trip, a malformed (non-JSON) response line,
// and dying mid-request with no response at all.
import * as readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    process.stdout.write(JSON.stringify({ id: null, error: { message: 'malformed request' } }) + '\n')
    return
  }

  switch (req.method) {
    case 'echo':
      process.stdout.write(JSON.stringify({ id: req.id, result: req.params ?? null }) + '\n')
      break
    case 'malformed':
      // Not valid JSON at all -- this is the "engine sent garbage" scenario.
      process.stdout.write('this is not json\n')
      break
    case 'slow': {
      const delayMs = (req.params && req.params.delayMs) || 50
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ id: req.id, result: { waited: delayMs } }) + '\n')
      }, delayMs)
      break
    }
    case 'crash':
      // Dies with no response at all -- the "engine process dying mid-request" scenario.
      process.exit(7)
      break
    case 'error':
      process.stdout.write(JSON.stringify({ id: req.id, error: { message: 'boom' } }) + '\n')
      break
    default:
      process.stdout.write(JSON.stringify({ id: req.id, error: { message: `unknown method ${req.method}` } }) + '\n')
  }
})
