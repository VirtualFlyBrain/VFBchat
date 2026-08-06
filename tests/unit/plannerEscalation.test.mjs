// Tests for the planner's vote key and its retrospective escalation policy.
// Run: node --test tests/unit/plannerEscalation.test.mjs
//
// The v3.x defect these guard against was silent and total: the harness voted
// the planner k=3 times with `temperature: 0` hard-coded, so it scored three
// identical greedy generations, recorded agreement 1.00 every time, and threw
// the score away regardless. Both halves — that the key measures the DECISION,
// and that a low score actually buys another round — are tested here without a
// network, because the live path is the one place we cannot assert on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planVoteKey, votePlanWithEscalation } from '../../lib/planner.mjs'
import { majorityVote } from '../../lib/structuredOutput.mjs'
import { PLANNER_ESCALATION } from '../../lib/roleProfiles.mjs'

const plan = (intent, tools, extra = {}) => ({
  intent,
  steps: tools.map(tool => ({ tool, args: {} })),
  ...extra
})

test('planVoteKey ignores wording and tracks intent + tool sequence', () => {
  const a = plan('neuron_count', ['vfb_search_terms', 'vfb_get_region_neuron_count'])
  const b = plan('neuron_count', ['vfb_search_terms', 'vfb_get_region_neuron_count'])
  // Same decision, different prose in a field the key must not look at.
  b.answers = ['count the DA1 lPNs per dataset']
  b.rationale = 'phrased completely differently'
  assert.equal(planVoteKey(a), planVoteKey(b))

  // Different intent is a real disagreement…
  assert.notEqual(
    planVoteKey(plan('neuron_count', ['vfb_search_terms'])),
    planVoteKey(plan('connectivity', ['vfb_search_terms']))
  )
  // …and so is a different tool sequence, including mere ORDER.
  assert.notEqual(
    planVoteKey(plan('connectivity', ['vfb_search_terms', 'vfb_query_connectivity'])),
    planVoteKey(plan('connectivity', ['vfb_query_connectivity', 'vfb_search_terms']))
  )
})

test('planVoteKey treats "ask the user" as its own decision', () => {
  const answer = plan('connectivity', ['vfb_query_connectivity'])
  const clarify = plan('connectivity', ['vfb_query_connectivity'], {
    underspecified: true,
    clarifying_question: 'Which dataset did you mean?'
  })
  assert.notEqual(planVoteKey(answer), planVoteKey(clarify))
})

test('unanimous votes commit immediately and buy nothing extra', async () => {
  const sizes = []
  const settled = plan('term_info', ['vfb_get_term_info'])
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: PLANNER_ESCALATION,
    vote: majorityVote,
    sample: async (k) => { sizes.push(k); return Array.from({ length: k }, () => settled) }
  })
  assert.equal(r.ok, true)
  assert.equal(r.agreement, 1)
  assert.equal(r.escalated, false)
  assert.equal(r.votes, 3)
  assert.deepEqual(sizes, [3], 'a settled plan must cost exactly one round')
  assert.equal(r.rounds.length, 1)
  assert.equal(r.value.intent, 'term_info')
})

test('a contested plan buys one extra round and re-decides over the pool', async () => {
  // The measured shape of W9.1: two samples read it as a count, one as
  // connectivity -> agreement 0.67, which is BELOW the threshold.
  const count = plan('neuron_count', ['vfb_get_region_neuron_count'])
  const conn = plan('connectivity', ['vfb_query_connectivity'])
  const sizes = []
  let contested = 0

  const r = await votePlanWithEscalation({
    votes: 3,
    policy: { minAgreement: 0.9, extraVotes: 3, maxRounds: 1 },
    vote: majorityVote,
    onContested: () => { contested++ },
    sample: async (k) => {
      sizes.push(k)
      // round 1: 2 count / 1 conn. round 2: all count.
      return sizes.length === 1 ? [count, count, conn] : Array.from({ length: k }, () => count)
    }
  })

  assert.equal(r.ok, true)
  assert.deepEqual(sizes, [3, 3])
  assert.equal(contested, 1, 'the user is told once, before the extra spend')
  assert.equal(r.escalated, true)
  assert.equal(r.votes, 6)
  // 5 of 6 now agree — the re-decision is over the COMBINED pool, not just the
  // new samples, so the first round's evidence is not thrown away.
  assert.equal(Math.round(r.agreement * 100) / 100, 0.83)
  assert.equal(r.value.intent, 'neuron_count')
  assert.equal(r.rounds.length, 2)
  assert.equal(r.rounds[0].escalated, false)
  assert.equal(r.rounds[1].escalated, true)
})

test('escalation is capped at one round even when disagreement persists', async () => {
  const a = plan('a', ['t1'])
  const b = plan('b', ['t2'])
  let calls = 0
  const r = await votePlanWithEscalation({
    votes: 2,
    policy: { minAgreement: 0.99, extraVotes: 2, maxRounds: 1 },
    vote: majorityVote,
    sample: async () => { calls++; return [a, b] }
  })
  assert.equal(calls, 2, 'never more than 1 + maxRounds sampling rounds')
  assert.equal(r.ok, true)
  assert.equal(r.votes, 4)
  // Still contested, but we commit anyway: a 5th sample is not the fix, and the
  // sufficiency loop downstream recovers with evidence rather than by guessing.
  assert.equal(r.agreement, 0.5)
})

test('the real policy escalates at the agreement the probes actually measured', async () => {
  // probe_agreement.mjs: 0.67 on the contested workshop questions (W1.B, W2.B,
  // W4.C, W9.1) and 1.00 on the settled ones. A threshold that does not fire at
  // 0.67 makes the whole mechanism decorative, so pin it.
  assert.ok(PLANNER_ESCALATION.minAgreement > 2 / 3)
  const a = plan('a', ['t1'])
  const b = plan('b', ['t2'])
  let rounds = 0
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: PLANNER_ESCALATION,
    vote: majorityVote,
    sample: async (k) => {
      rounds++
      return rounds === 1 ? [a, a, b] : Array.from({ length: k }, () => a)
    }
  })
  assert.equal(rounds, 2, 'agreement 0.67 must trigger the extra round')
  assert.equal(r.escalated, true)
  assert.equal(r.value.intent, 'a')
})

test('a failed first round reports failure rather than committing to nothing', async () => {
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: PLANNER_ESCALATION,
    vote: majorityVote,
    sample: async () => []
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /no valid plans/i)
})

test('a failed EXTRA round keeps the first round rather than losing the plan', async () => {
  // Escalation is an optimisation. If the second sampling call fails — timeout,
  // ELM hiccup — the contested-but-usable plan from round 1 still ships.
  const a = plan('a', ['t1'])
  const b = plan('b', ['t2'])
  let calls = 0
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: PLANNER_ESCALATION,
    vote: majorityVote,
    sample: async () => { calls++; return calls === 1 ? [a, a, b] : [] }
  })
  assert.equal(r.ok, true)
  assert.equal(r.escalated, false)
  assert.equal(r.votes, 3)
  assert.equal(r.value.intent, 'a')
})

test('votes<=1 and a zero-extraVotes policy both degrade to a single round', async () => {
  const a = plan('a', ['t1'])
  const b = plan('b', ['t2'])
  let calls = 0
  const single = await votePlanWithEscalation({
    votes: 1, policy: PLANNER_ESCALATION, vote: majorityVote,
    sample: async (k) => { calls++; assert.equal(k, 1); return [a] }
  })
  assert.equal(single.ok, true)
  assert.equal(single.agreement, 1)
  assert.equal(calls, 1)

  calls = 0
  const disabled = await votePlanWithEscalation({
    votes: 2, policy: { minAgreement: 1, extraVotes: 0, maxRounds: 1 }, vote: majorityVote,
    sample: async () => { calls++; return [a, b] }
  })
  assert.equal(calls, 1, 'extraVotes: 0 is the off switch')
  assert.equal(disabled.escalated, false)
})
