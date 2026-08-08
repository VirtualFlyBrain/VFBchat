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
import fs from 'node:fs'
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

test('an abandoned run is not recorded as a service error', () => {
  // It used to fall into the generic catch, which wrote an errored=true
  // governance record and emitted an error event to a client that had already
  // gone — so the analytics would have shown a rising error rate that was
  // nothing but people changing their minds.
  const src = fs.readFileSync(new URL('../../app/api/chat/route.js', import.meta.url), 'utf8')
  const catchStart = src.indexOf("let errorCategory = 'unexpected_error'")
  assert.ok(catchStart > 0, 'generic request catch not found')
  const branch = src.slice(catchStart - 900, catchStart + 1200)
  assert.match(branch, /isRunAborted\(error\)/, 'the generic catch must recognise an abandoned run')
  assert.ok(branch.indexOf('isRunAborted') < branch.indexOf('finalizeGovernanceEvent'),
    'and must return before writing an errored governance record')
})

test('the cancellation hooks the deployment actually provides are both wired', () => {
  // Measured, not assumed: with a probe in place, `next start` fired BOTH
  // request.signal abort and the stream cancel() when a client went away. Four
  // abandoned questions then produced four RUN ABANDONED lines and zero
  // completed answers in four and a half minutes, against a 90-210 s answer.
  const src = fs.readFileSync(new URL('../../app/api/chat/route.js', import.meta.url), 'utf8')
  assert.match(src, /cancel \(reason\) \{/, 'the ReadableStream needs a cancel handler')
  assert.match(src, /clientSignal: request\.signal/, 'and the request signal must be passed in')
})
