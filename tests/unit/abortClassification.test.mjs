import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RunAbortedError, isRunAborted, isAbortLike, isRunAbortedWith, NOBODY_WAITING, createRunSignal
} from '../../lib/runSignal.mjs'

const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

// The defect: any upstream fetch timing out counted as the user abandoning the
// run, so route.js returned before emitting an error event or writing a
// governance record. Every upstream timeout was invisible in the analytics.
test('an upstream AbortError is NOT this run aborting', () => {
  assert.equal(isRunAborted(abortError()), false)
  assert.equal(isRunAbortedWith(abortError(), null), false)
  assert.equal(isRunAbortedWith(abortError(), { aborted: false }), false)
})

test('a real run abort is recognised however it is thrown', () => {
  assert.equal(isRunAborted(new RunAbortedError('deadline')), true)
  assert.equal(isRunAborted({ name: 'RunAbortedError' }), true)
})

// A fetch cancelled BY the run signal rejects with AbortError, not
// RunAbortedError, so the signal is the only reliable discriminator.
test('an AbortError with an aborted signal behind it IS the run stopping', () => {
  assert.equal(isRunAbortedWith(abortError(), { aborted: true }), true)
})

test('isAbortLike covers both, and is not used alone to decide', () => {
  assert.equal(isAbortLike(abortError()), true)
  assert.equal(isAbortLike(new RunAbortedError('x')), true)
  assert.equal(isAbortLike(new Error('boom')), false)
})

test('an ordinary failure is never mistaken for an abort', () => {
  const e = new Error('PubMed fetch failed: 500')
  assert.equal(isRunAborted(e), false)
  assert.equal(isRunAbortedWith(e, { aborted: true }), false)
})

// Only reasons meaning nobody is listening earn silence. A deadline does not:
// that client is still waiting and deserves to be told.
test('deadline is not in the silence set', () => {
  assert.ok(NOBODY_WAITING.has('client-disconnected'))
  assert.ok(NOBODY_WAITING.has('stream-closed'))
  assert.ok(NOBODY_WAITING.has('cancelled'))
  assert.equal(NOBODY_WAITING.has('deadline'), false)
})

test('the signal carries its reason so the catch site can branch on it', () => {
  const run = createRunSignal({ deadlineMs: 0 })
  run.abort('deadline')
  assert.equal(run.signal.reason?.reason, 'deadline')
  assert.equal(isRunAbortedWith(abortError(), run.signal), true)
  run.dispose()
})
