#!/usr/bin/env node
// fake-engine.mjs -- a minimal stand-in for `featurelab serve`, spawned as a real child
// process by engineProcess.test.ts. Exercises engineProcess.ts's real stdio plumbing (not a
// mocked child_process) against a handful of scripted scenarios a real engine binary would
// be awkward to force on demand: a clean round trip, a malformed (non-JSON) response line,
// and dying mid-request with no response at all.
//
// It also models the real engine's "cancel" method, because the whole point of cancellation is
// that the ENGINE stops: a fake that only ever acknowledged a cancel and then delivered the
// original result anyway would let a broken client pass. Here a `slow` request is genuinely
// abandoned -- its timer is cleared, and it answers with the same {"code":"cancelled"} error
// serve.go sends.
import * as readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

/** The start-up line the real `serve` writes before it answers anything (notify.go's
 * readyNotification). Here as well as there, because "the first line this client ever reads is
 * not a response" is a property worth exercising on every single test in this file. */
process.stdout.write(JSON.stringify({ notification: 'ready', ready: true, version: '0.0.0-fake', pid: process.pid }) + '\n')

/** In-flight `slow` requests, by id, so `cancel` can reach one -- serve.go's own inflight map. */
const inflight = new Map()

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

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
      const timer = setTimeout(() => {
        inflight.delete(req.id)
        reply({ id: req.id, result: { waited: delayMs } })
      }, delayMs)
      inflight.set(req.id, () => {
        clearTimeout(timer)
        inflight.delete(req.id)
        // Exactly what serve.go answers a cancelled request with: an error, never a partial
        // result, carrying the machine-readable code a client keys its recovery off.
        reply({ id: req.id, error: { message: 'request cancelled', code: 'cancelled' } })
      })
      break
    }
    case 'cancel': {
      const target = req.params && req.params.id
      const stop = inflight.get(target)
      if (stop) stop()
      // False for an unknown or already-finished id -- a no-op, never an error.
      reply({ id: req.id, result: { cancelled: Boolean(stop) } })
      break
    }
    // A long request that KEEPS SAYING SO, the way serve.go's startProgress does: a progress
    // line every `everyMs`, each one naming this request in "requestId" and never in "id", then
    // the real response. The whole point of the shape is that a client correlating by id cannot
    // mistake one for an answer -- see notify.go's doc comment.
    case 'slowWithProgress': {
      const everyMs = (req.params && req.params.everyMs) || 20
      const ticks = (req.params && req.params.ticks) || 5
      let sent = 0
      const timer = setInterval(() => {
        sent++
        reply({
          notification: 'progress',
          requestId: req.id,
          method: 'slowWithProgress',
          phase: 'features',
          files: sent * 1000,
          elapsedMs: sent * everyMs,
        })
        if (sent >= ticks) {
          clearInterval(timer)
          inflight.delete(req.id)
          reply({ id: req.id, result: { ticks: sent } })
        }
      }, everyMs)
      inflight.set(req.id, () => {
        clearInterval(timer)
        inflight.delete(req.id)
        reply({ id: req.id, error: { message: 'request cancelled', code: 'cancelled' } })
      })
      break
    }
    // A notification of a kind this client has never heard of, followed by an ordinary answer.
    // notify.go promises that adding a kind is a non-breaking change; this is what proves it.
    case 'unknownNotification':
      reply({ notification: 'something-from-the-future', weather: 'fine' })
      reply({ id: req.id, result: { ok: true } })
      break
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
