// The 181-second resolve stall, and the arithmetic that ends it.
//
// W9.2 — "What images does VFB have for the DA1 lPN neuron type?" — errored
// after 300 s, 181 of them inside the resolve step, before a single data query
// ran. Nothing failed except patience: a 30 s per-call timeout with 2 retries
// costs 30 + ~2 + 30 + ~3 + 30 ≈ 95 s for ONE fast lookup, because a timeout is
// classified transient (correctly) and the retry is then granted the same full
// 30 s (incorrectly — the first attempt already measured this call).
//
// So the budget becomes a TOTAL for the whole attempt sequence. These tests pin
// the arithmetic; the wiring that consumes it is in route.js's
// callMcpToolWithRetry and the orchestrator's resolve ladder.
//
// Run: node --test tests/unit/callBudget.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTEMPT_FLOOR_MS, backoffMs, remainingMs, planNextAttempt, createDeadline, envInt
} from '../../lib/callBudget.mjs'

// --- the shape of the old bug ------------------------------------------------

test('the retry sequence can no longer exceed its stated total', () => {
  // Walk the exact production numbers: 30 s attempts, 45 s total, 2 retries,
  // every attempt timing out. Under the old rule this summed to ~95 s.
  const perAttemptMs = 30000
  const totalMs = 45000
  let elapsedMs = 0
  let attempts = 1
  elapsedMs += perAttemptMs                       // first attempt times out

  for (let attempt = 0; attempt < 3; attempt++) {
    const next = planNextAttempt({
      attempt, retries: 2, transient: true, perAttemptMs, totalMs, elapsedMs, jitterMs: 2000
    })
    if (!next.retry) break
    attempts += 1
    elapsedMs += next.waitMs + next.timeoutMs
  }

  assert.ok(elapsedMs <= totalMs, `spent ${elapsedMs}ms of a ${totalMs}ms budget`)
  assert.ok(attempts >= 2, 'a transient failure must still buy at least one retry')
})

test('a retry is given what is LEFT, not the full per-attempt allowance', () => {
  // The correction in one assertion. 30 s of a 45 s budget is gone and the
  // backoff will take 3 s more, so the second attempt gets 12 s — the honest
  // amount of time remaining, rather than another 30 s nobody has.
  const next = planNextAttempt({
    attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 45000, elapsedMs: 30000, jitterMs: 2000
  })
  assert.equal(next.retry, true)
  assert.equal(next.waitMs, 3000)               // backoff 1000 + jitter 2000
  assert.equal(next.timeoutMs, 12000)           // 45000 - 30000 - 3000
})

test('a fast first attempt still gets the full per-attempt allowance next time', () => {
  // The budget must not punish a call that failed QUICKLY — a dropped socket at
  // 300 ms is the case retries exist for, and there is plenty of time left.
  const next = planNextAttempt({
    attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 45000, elapsedMs: 300, jitterMs: 0
  })
  assert.equal(next.timeoutMs, 30000)
})

// --- when NOT to retry -------------------------------------------------------

test('the three refusals are distinguishable', () => {
  const base = { attempt: 0, retries: 2, perAttemptMs: 30000, totalMs: 45000, elapsedMs: 0 }
  // A real client error — a bad query_type — is not made true by repetition.
  assert.deepEqual(planNextAttempt({ ...base, transient: false }), { retry: false, reason: 'permanent' })
  assert.equal(planNextAttempt({ ...base, transient: true, attempt: 2 }).reason, 'retries-exhausted')
  assert.equal(planNextAttempt({ ...base, transient: true, elapsedMs: 44900 }).reason, 'budget-spent')
  // These are three different log lines on purpose: a stall that is really a
  // budget exhaustion must never be read afterwards as a server refusing thrice.
})

test('the budget is never spent entirely on sleeping', () => {
  // 8 s left, a 3 s backoff wanted: waiting is fine because an attempt still
  // fits behind it, and the attempt gets the 5 s that remain.
  const fits = planNextAttempt({
    attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 45000, elapsedMs: 37000, jitterMs: 2000
  })
  assert.equal(fits.retry, true)
  assert.equal(fits.waitMs, 3000)
  assert.equal(fits.timeoutMs, 5000)

  // 2.5 s left and the same 3 s backoff wanted: the wait is CUT to 0.5 s rather
  // than the retry being abandoned, because the floor is reserved for the
  // attempt. Sleeping is the part that gets squeezed — it is the part that
  // cannot succeed.
  const squeezed = planNextAttempt({
    attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 45000, elapsedMs: 42500, jitterMs: 2000
  })
  assert.equal(squeezed.retry, true)
  assert.equal(squeezed.waitMs, 500)
  assert.equal(squeezed.timeoutMs, ATTEMPT_FLOOR_MS)
  assert.ok(42500 + squeezed.waitMs + squeezed.timeoutMs <= 45000, 'and it still fits')
})

test('an attempt shorter than the floor is not worth starting', () => {
  // Under ATTEMPT_FLOOR_MS the round trip alone spends the allowance, so the
  // only thing such an attempt reliably produces is a LATER failure than the
  // one already in hand. At exactly the floor it IS worth starting — that is
  // what the floor means — so the boundary is pinned from both sides.
  const atTheFloor = planNextAttempt({
    attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 45000,
    elapsedMs: 45000 - ATTEMPT_FLOOR_MS, jitterMs: 0
  })
  assert.equal(atTheFloor.retry, true)
  assert.equal(atTheFloor.waitMs, 0, 'no room for a backoff, so none is taken')
  assert.equal(atTheFloor.timeoutMs, ATTEMPT_FLOOR_MS)

  const belowIt = planNextAttempt({
    attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 45000,
    elapsedMs: 45000 - ATTEMPT_FLOOR_MS + 1, jitterMs: 0
  })
  assert.equal(belowIt.retry, false)
  assert.equal(belowIt.reason, 'budget-spent')
})

test('no total means no ceiling, not a zero budget', () => {
  // The degradation direction matters: an accounting bug must fall back to the
  // old unbounded behaviour, never to a state where every call is refused.
  assert.equal(remainingMs(0, 10), Infinity)
  assert.equal(remainingMs(undefined, 10), Infinity)
  assert.equal(remainingMs(NaN, 10), Infinity)
  const next = planNextAttempt({ attempt: 0, retries: 2, transient: true, perAttemptMs: 30000, totalMs: 0, elapsedMs: 999999 })
  assert.equal(next.retry, true)
  assert.equal(next.timeoutMs, 30000)
})

test('backoff still grows, and jitter is charged for', () => {
  assert.equal(backoffMs(0), 1000)
  assert.equal(backoffMs(1), 2000)
  assert.equal(backoffMs(2), 3000)
  // Jitter is part of the wait, so it is part of what the wait is charged.
  const a = planNextAttempt({ attempt: 1, retries: 3, transient: true, perAttemptMs: 30000, totalMs: 45000, elapsedMs: 0, jitterMs: 1500 })
  assert.equal(a.waitMs, 3500)
  assert.equal(a.timeoutMs, 30000)
})

// --- the deadline the resolve ladder consults --------------------------------

test('createDeadline reports spend and expiry against an injected clock', () => {
  let now = 1000
  const d = createDeadline(10000, () => now)
  assert.equal(d.spent(), 0)
  assert.equal(d.remaining(), 10000)
  assert.equal(d.expired(), false)

  now = 6000
  assert.equal(d.spent(), 5000)
  assert.equal(d.remaining(), 5000)
  assert.equal(d.expired(), false, 'half spent is not spent')

  now = 9500
  assert.equal(d.expired(), true, 'under the floor there is no room for another round trip')
  // The floor is a parameter because "worth starting" depends on what is being
  // started — a cached index read deserves a shorter runway than a search.
  assert.equal(d.expired(400), false)
})

test('a deadline with no total never expires', () => {
  let now = 0
  const d = createDeadline(0, () => now)
  now = 10_000_000
  assert.equal(d.expired(), false)
  assert.equal(d.remaining(), Infinity)
})

test('envInt clamps rather than trusting the environment', () => {
  assert.equal(envInt('30000', 60000, 5000, 300000), 30000)
  assert.equal(envInt('1', 60000, 5000, 300000), 5000)
  assert.equal(envInt('9999999', 60000, 5000, 300000), 300000)
  assert.equal(envInt('', 60000, 5000, 300000), 60000)
  assert.equal(envInt(undefined, 60000, 5000, 300000), 60000)
  assert.equal(envInt('not a number', 60000, 5000, 300000), 60000)
})
