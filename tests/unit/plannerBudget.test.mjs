// Tests for the wall-clock budget: the thing that turns the pathological
// planner turn from unbounded into bounded.
// Run: node --test tests/unit/plannerBudget.test.mjs
//
// The measured defect: the planner profile is timeoutMs 240000 with maxAttempts
// 3, and an attempt that ABORTS on its timeout is indistinguishable inside
// callStructured from one that failed fast — postJson catches AbortError and
// returns {ok:false, status:0} — so a stalled gateway gets asked the identical
// question twice more at full price. 12 minutes for ONE of three parallel votes,
// of which there can be two rounds. Nothing anywhere bounded the phase.
//
// Two bounds fix it and both are tested here, because both are load-bearing:
//   1. per CALL  — callStructured stops retrying when the budget is gone, and
//      never hands an attempt more clock than the budget has left;
//   2. per PHASE — votePlanWithEscalation refuses to START an escalation round
//      it cannot finish, and passes what is LEFT into the round rather than a
//      fresh budget. Bounding when escalation begins is not a bound.
//
// Time is injected (`now`) rather than slept, so the suite asserts on 5-minute
// budgets in microseconds.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callStructured, MIN_RETRY_MS } from '../../lib/elmClient.mjs'
import { votePlanWithEscalation } from '../../lib/planner.mjs'
import { majorityVote } from '../../lib/structuredOutput.mjs'
import { PROFILES, ROLES, PLANNER_ESCALATION, roleRequestOptions } from '../../lib/roleProfiles.mjs'

const SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
const BASE = {
  baseUrl: 'http://x/v1',
  apiKey: 'k',
  model: 'm',
  messages: [{ role: 'user', content: 'go' }],
  schema: SCHEMA
}

function makeClock(start = 0) {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}

/**
 * Runs `fn` with global setTimeout replaced by one that records the requested
 * delay and then fires on the next tick.
 *
 * This is the only way to observe the per-attempt timeout without adding an
 * injection seam to production code for the test's benefit: postJson's
 * AbortController deadline IS the value under test, and firing it immediately
 * lets a stalled-gateway attempt be simulated in no real time at all.
 */
async function withCapturedTimers(fn) {
  const real = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (cb, ms, ...rest) => { delays.push(ms); return real(cb, 0, ...rest) }
  try {
    return await fn(delays)
  } finally {
    globalThis.setTimeout = real
  }
}

/** A gateway that accepts the request and then never answers: aborts only. */
function stalledFetch(clock, delays) {
  return (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      // The attempt burned exactly the clock it was granted.
      clock.advance(delays[delays.length - 1])
      reject(new Error('The operation was aborted'))
    })
  })
}

function jsonFetch(content) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) })
}

test('a stalled gateway costs the budget, not maxAttempts x timeoutMs', async () => {
  const clock = makeClock()
  const r = await withCapturedTimers(delays => callStructured({
    ...BASE,
    maxAttempts: 3,
    timeoutMs: 240000,
    budgetMs: 300000,
    now: clock.now,
    fetchImpl: stalledFetch(clock, delays)
  }).then(res => ({ res, delays })))

  assert.equal(r.res.ok, false)
  assert.equal(r.res.budgetExhausted, true)
  assert.equal(r.res.attempts, 2, 'the third attempt is not started, not started-and-aborted')
  assert.match(r.res.error, /budget 300000ms exhausted/)
  // The second attempt is clamped to what is LEFT (60s), not given a fresh 240s.
  // Without the clamp this call costs 720s; with it, 300s exactly.
  assert.deepEqual(r.delays, [240000, 60000])
})

test('fast failures still get every retry — the budget is not a retry cap', async () => {
  // The loop exists for cheap failures: a 502, a truncated reply, a schema miss.
  // Those cost no wall clock, so the budget must not touch them.
  const clock = makeClock()
  const r = await callStructured({
    ...BASE,
    maxAttempts: 3,
    timeoutMs: 240000,
    budgetMs: 300000,
    now: clock.now,
    fetchImpl: jsonFetch('{"wrong":1}')
  })
  assert.equal(r.ok, false)
  assert.equal(r.attempts, 3)
  assert.ok(!r.budgetExhausted)
})

test('omitting budgetMs reproduces the historical worst case exactly', async () => {
  // The change has to be inert for every caller that has not opted in, or it is
  // a behaviour change dressed as a bug fix.
  const clock = makeClock()
  const r = await withCapturedTimers(delays => callStructured({
    ...BASE,
    maxAttempts: 3,
    timeoutMs: 60000,
    now: clock.now,
    fetchImpl: stalledFetch(clock, delays)
  }).then(res => ({ res, delays })))

  assert.equal(r.res.ok, false)
  assert.equal(r.res.attempts, 3)
  assert.ok(!r.res.budgetExhausted)
  assert.deepEqual(r.delays, [60000, 60000, 60000])
})

test('the first attempt always happens, even under an absurd budget', async () => {
  // A budget below the floor must not mean "make no call at all" — one attempt
  // is what the caller asked for. It is the RETRY that the floor governs.
  const clock = makeClock()
  const r = await withCapturedTimers(delays => callStructured({
    ...BASE,
    maxAttempts: 3,
    timeoutMs: 240000,
    budgetMs: 1000,
    now: clock.now,
    fetchImpl: stalledFetch(clock, delays)
  }).then(res => ({ res, delays })))

  assert.equal(r.delays.length, 1)
  assert.equal(r.delays[0], MIN_RETRY_MS)
  assert.equal(r.res.attempts, 1)
  assert.equal(r.res.budgetExhausted, true)
})

// ---- phase budget ----

const plan = (intent, tools) => ({ intent, steps: tools.map(tool => ({ tool, args: {} })) })
const A = plan('a', ['t1'])
const B = plan('b', ['t2'])

test('the escalation round receives what is LEFT, not a fresh budget', async () => {
  // The half that is easy to miss: bounding when the second round STARTS bounds
  // nothing, because the round itself is where the 12 minutes live.
  const clock = makeClock()
  const seen = []
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: { minAgreement: 0.9, extraVotes: 3, maxRounds: 1, phaseBudgetMs: 420000, minRoundMs: 20000 },
    vote: majorityVote,
    now: clock.now,
    sample: async (k, budgetMs) => {
      seen.push(budgetMs)
      // The measured shape: round one contests at 78s, round two settles it.
      clock.advance(seen.length === 1 ? 78000 : 180000)
      return seen.length === 1 ? [A, A, B] : Array.from({ length: k }, () => A)
    }
  })

  assert.deepEqual(seen, [420000, 342000])
  assert.equal(r.escalated, true)
  assert.ok(!r.budgetExhausted, 'a healthy contested plan must be completely untouched by the budget')
  assert.equal(r.value.intent, 'a')
})

test('a round that cannot finish is not started, and round one still ships', async () => {
  const clock = makeClock()
  let contested = 0
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: { minAgreement: 0.9, extraVotes: 3, maxRounds: 1, phaseBudgetMs: 100000, minRoundMs: 20000 },
    vote: majorityVote,
    now: clock.now,
    onContested: () => { contested++ },
    sample: async () => { clock.advance(90000); return [A, A, B] }
  })

  assert.equal(r.ok, true, 'out of clock is not out of plan')
  assert.equal(r.budgetExhausted, true)
  assert.equal(r.escalated, false)
  assert.equal(r.votes, 3)
  // The plurality of round one — which is precisely the plan v3.x shipped, it
  // having discarded the agreement score without ever reading it.
  assert.equal(r.value.intent, 'a')
  assert.equal(r.rounds.length, 2)
  assert.equal(r.rounds[1].skipped, 'budget')
  assert.equal(contested, 0, 'do not announce a second round that will not happen')
})

test('no phaseBudgetMs means no bound, and the sampler is told so', async () => {
  const seen = []
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: { minAgreement: 0.9, extraVotes: 3, maxRounds: 1 },
    vote: majorityVote,
    sample: async (k, budgetMs) => {
      seen.push(budgetMs)
      return seen.length === 1 ? [A, A, B] : Array.from({ length: k }, () => A)
    }
  })
  assert.deepEqual(seen, [Infinity, Infinity])
  assert.equal(r.escalated, true)
})

test('the shipped policy leaves a healthy escalation entirely alone', async () => {
  // Sized from the live measurement, not from taste: round one contested at 78s,
  // the escalation round at ~180s. If the budget bit at those numbers it would
  // be degrading good turns to fix bad ones.
  assert.ok(PLANNER_ESCALATION.phaseBudgetMs >= 78000 + 180000 + 60000)
  assert.ok(PLANNER_ESCALATION.minRoundMs >= MIN_RETRY_MS)
  assert.ok(Object.isFrozen(PLANNER_ESCALATION))
})

test('every role profile budgets more than one attempt but less than three', async () => {
  // A budget below timeoutMs would cut the FIRST attempt short, which is a
  // regression, not a bound. A budget at or above maxAttempts x timeoutMs is the
  // old unbounded behaviour with extra words.
  for (const role of ROLES) {
    const p = PROFILES[role]
    assert.ok(p.budgetMs > p.timeoutMs, `${role}: budget must survive one full attempt`)
    assert.ok(p.budgetMs < p.timeoutMs * 3, `${role}: budget must bite before 3 x timeout`)
  }
})

test('VFB_BUDGET_<ROLE> overrides the table without touching the timeout', async () => {
  const o = roleRequestOptions('planner', { env: { VFB_BUDGET_PLANNER: '90000' } })
  assert.equal(o.budgetMs, 90000)
  assert.equal(o.timeoutMs, PROFILES.planner.timeoutMs)
  const d = roleRequestOptions('planner', { env: {} })
  assert.equal(d.budgetMs, PROFILES.planner.budgetMs)
})
