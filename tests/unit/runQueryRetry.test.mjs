// What the model is allowed to conclude from a failed VFB query, and how often
// we are allowed to make the upstream recompute one.
//
// Run: node --test tests/unit/runQueryRetry.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  annotateFailedRunQuery,
  createForceRefreshBudget,
  DEFAULT_FORCE_REFRESH_BUDGET,
  forceRefreshKey,
  isFailedRunQueryPayload,
  RUN_QUERY_FAILED_NOTE
} from '../../lib/runQueryRetry.mjs'

// ------------------------------------------------------------- detection

test('a negative count is a failure, whatever else the payload says', () => {
  assert.equal(isFailedRunQueryPayload('{"count":-1,"rows":[]}'), true)
  assert.equal(isFailedRunQueryPayload({ count: -1, rows: [] }), true)
  assert.equal(isFailedRunQueryPayload('{"count_status":"unavailable","count":-1}'), true)
})

test('count 0 is a genuine empty result and must not burn the retry budget', () => {
  // VFBquery returns 0 both for a real empty set and for a 400 Bad Request.
  // Neither is fixed by recomputing, and both are honest answers.
  assert.equal(isFailedRunQueryPayload('{"count":0,"rows":[]}'), false)
  assert.equal(isFailedRunQueryPayload('{"count":12,"rows":[{}]}'), false)
})

test('anything unparseable is left alone rather than guessed at', () => {
  assert.equal(isFailedRunQueryPayload('not json at all'), false)
  assert.equal(isFailedRunQueryPayload('[1,2,3]'), false)
  assert.equal(isFailedRunQueryPayload(''), false)
  assert.equal(isFailedRunQueryPayload(null), false)
  assert.equal(isFailedRunQueryPayload(undefined), false)
})

// ------------------------------------------------------------ annotation

test('a failed payload never reaches the model without its explanation', () => {
  const parsed = JSON.parse(annotateFailedRunQuery('{"count":-1,"rows":[]}'))
  assert.equal(parsed.count_status, 'unavailable')
  assert.ok(parsed._note.includes(RUN_QUERY_FAILED_NOTE))
  assert.match(parsed._note, /NOT an empty result/)
  assert.equal(parsed.count, -1, 'the raw -1 survives for existing count >= 0 guards')
})

test('an upstream note is kept, not overwritten', () => {
  const parsed = JSON.parse(annotateFailedRunQuery('{"count":-1,"_note":"upstream said this"}'))
  assert.match(parsed._note, /^upstream said this/)
  assert.ok(parsed._note.includes(RUN_QUERY_FAILED_NOTE))
})

test('annotating twice does not duplicate the note', () => {
  const once = annotateFailedRunQuery('{"count":-1,"rows":[]}')
  const twice = annotateFailedRunQuery(once)
  assert.equal(JSON.parse(twice)._note, JSON.parse(once)._note)
})

test('a healthy or unrecognisable payload passes through byte for byte', () => {
  const healthy = '{"count":3,"rows":[{"id":"a"}]}'
  assert.equal(annotateFailedRunQuery(healthy), healthy)
  assert.equal(annotateFailedRunQuery('not json'), 'not json')
})

// ---------------------------------------------------------------- budget

test('the same failing call is only ever forced once', () => {
  const budget = createForceRefreshBudget(5)
  const key = forceRefreshKey('run_query', { id: 'VFB_001', query_type: 'X' })
  assert.equal(budget.tryConsume(key), true)
  assert.equal(budget.tryConsume(key), false, 'a query that fails twice is down, not stale')
})

test('argument order does not create a second identity for the same call', () => {
  assert.equal(
    forceRefreshKey('run_query', { id: 'VFB_001', query_type: 'X' }),
    forceRefreshKey('run_query', { query_type: 'X', id: 'VFB_001' })
  )
})

test('force_refresh itself is excluded from the identity', () => {
  // Otherwise the retried call would look like a different call and could be
  // retried again, which is exactly the loop the budget exists to prevent.
  assert.equal(
    forceRefreshKey('run_query', { id: 'A' }),
    forceRefreshKey('run_query', { id: 'A', force_refresh: true })
  )
})

test('different calls are distinct, but the request-wide cap still holds', () => {
  const budget = createForceRefreshBudget(2)
  assert.equal(budget.tryConsume(forceRefreshKey('run_query', { id: 'A' })), true)
  assert.equal(budget.tryConsume(forceRefreshKey('run_query', { id: 'B' })), true)
  assert.equal(budget.tryConsume(forceRefreshKey('run_query', { id: 'C' })), false,
    'a request that fails in many ways must not stampede the upstream')
  assert.equal(budget.remaining, 0)
})

test('a zero or nonsense budget forces nothing', () => {
  assert.equal(createForceRefreshBudget(0).tryConsume('k'), false)
  assert.equal(createForceRefreshBudget(-3).tryConsume('k'), false)
  assert.equal(createForceRefreshBudget('nope').tryConsume('k'), false)
})

test('the default allowance is small and positive', () => {
  assert.ok(DEFAULT_FORCE_REFRESH_BUDGET > 0 && DEFAULT_FORCE_REFRESH_BUDGET <= 3)
  assert.equal(createForceRefreshBudget().remaining, DEFAULT_FORCE_REFRESH_BUDGET)
})
