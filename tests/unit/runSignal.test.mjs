// A request nobody is waiting for must stop.
//
// buildSseResponse had no cancel() handler and request.signal was never wired
// into the harness, the MCP client or the ELM client. A user who waited forty
// seconds and hit refresh three times left three complete working sets running
// to completion — up to 82 controller iterations and 24 MCP rounds each, every
// one holding its ledger, its term-info records and every tool payload. That is
// why observed concurrency was worse than actual concurrency.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunSignal, throwIfAborted, isRunAborted, RunAbortedError, DEFAULT_RUN_DEADLINE_MS } from '../../lib/runSignal.mjs'
import { callStructured } from '../../lib/elmClient.mjs'

test('the client going away aborts the run', () => {
  const client = new AbortController()
  const run = createRunSignal({ clientSignal: client.signal })
  assert.equal(run.signal.aborted, false)
  client.abort()
  assert.equal(run.signal.aborted, true)
  assert.equal(run.reason(), 'client-disconnected')
  run.dispose()
})

test('a client that is already gone aborts immediately', () => {
  const client = new AbortController()
  client.abort()
  const run = createRunSignal({ clientSignal: client.signal })
  assert.equal(run.signal.aborted, true)
  run.dispose()
})

test('the stream cancelling aborts the run', () => {
  const run = createRunSignal({})
  run.abort('stream-closed')
  assert.equal(run.signal.aborted, true)
  assert.equal(run.reason(), 'stream-closed')
  run.dispose()
})

test('a run that nobody cancels still has a deadline', async () => {
  const run = createRunSignal({ deadlineMs: 30000 })
  assert.equal(run.signal.aborted, false)
  run.dispose()
  // ...and the default is a real ceiling, not Infinity. The extract map-reduce
  // could hold the ELM gateway for hours on one oversized payload.
  assert.ok(DEFAULT_RUN_DEADLINE_MS > 0 && DEFAULT_RUN_DEADLINE_MS <= 1800000)
})

test('the deadline actually fires', async () => {
  const run = createRunSignal({ deadlineMs: 40 })
  await new Promise(r => setTimeout(r, 90))
  assert.equal(run.signal.aborted, true)
  assert.equal(run.reason(), 'deadline')
  run.dispose()
})

test('dispose clears the deadline so a finished request holds no timer', async () => {
  const run = createRunSignal({ deadlineMs: 40 })
  run.dispose()
  await new Promise(r => setTimeout(r, 90))
  assert.equal(run.signal.aborted, false)
})

test('throwIfAborted names where it stopped, and is recognisable', () => {
  const run = createRunSignal({})
  assert.doesNotThrow(() => throwIfAborted(run.signal, 'harness-loop'))
  run.abort('client-disconnected')
  let err = null
  try { throwIfAborted(run.signal, 'harness-loop') } catch (e) { err = e }
  assert.ok(err instanceof RunAbortedError)
  assert.match(err.message, /client-disconnected/)
  assert.match(err.message, /harness-loop/)
  assert.ok(isRunAborted(err))
  assert.ok(isRunAborted({ name: 'AbortError' }), 'a fetch abort counts too')
  assert.equal(isRunAborted(new Error('MCP down')), false)
  run.dispose()
})

test('an aborted signal stops an ELM call rather than only the next one', async () => {
  const run = createRunSignal({})
  let seenSignal = null
  const fetchImpl = (url, init) => {
    seenSignal = init.signal
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
  }
  const pending = callStructured({
    baseUrl: 'https://elm.invalid', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    schema: { type: 'object' },
    maxAttempts: 1, timeoutMs: 30000,
    fetchImpl, signal: run.signal
  })
  await new Promise(r => setTimeout(r, 10))
  assert.ok(seenSignal, 'the fetch should have been given a signal')
  run.abort('client-disconnected')
  const res = await pending
  assert.equal(res.ok, false, 'an aborted call must not report success')
  run.dispose()
})
