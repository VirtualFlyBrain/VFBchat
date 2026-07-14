// Offline unit tests for the battery grader's pure logic.
// Run: node --test tests/unit/grade.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JUDGE_SCHEMA, buildJudgeMessages, aggregate } from '../../lib/battery/grade.mjs'
import { validateAgainstSchema } from '../../lib/structuredOutput.mjs'

test('JUDGE_SCHEMA: a conformant verdict validates', () => {
  const v = { answered: true, grounded: true, gave_up_or_errored: false, correctness: 0.9, verdict: 'pass', reason: 'ok' }
  assert.equal(validateAgainstSchema(v, JUDGE_SCHEMA).valid, true)
})

test('JUDGE_SCHEMA: rejects bad verdict enum and extra keys', () => {
  assert.equal(validateAgainstSchema({ answered: true, grounded: true, gave_up_or_errored: false, correctness: 1, verdict: 'great', reason: 'x' }, JUDGE_SCHEMA).valid, false)
  assert.equal(validateAgainstSchema({ answered: true, grounded: true, gave_up_or_errored: false, correctness: 1, verdict: 'pass', reason: 'x', extra: 1 }, JUDGE_SCHEMA).valid, false)
})

test('buildJudgeMessages: includes question and answer', () => {
  const m = buildJudgeMessages({ question: 'What NT do KCs use?', response: 'Acetylcholine.' })
  assert.equal(m.length, 2)
  assert.equal(m[0].role, 'system')
  assert.match(m[1].content, /What NT do KCs use\?/)
  assert.match(m[1].content, /Acetylcholine\./)
})

test('buildJudgeMessages: tolerates missing fields', () => {
  const m = buildJudgeMessages({})
  assert.equal(m.length, 2)
  assert.match(m[1].content, /QUESTION:/)
})

test('aggregate: counts verdicts, rate, mean correctness', () => {
  const graded = [
    { task_id: 'T1.1', tier: 1, duration_ms: 1000, verdict: 'pass', correctness: 1.0, gave_up_or_errored: false, grounded: true },
    { task_id: 'T1.2', tier: 1, duration_ms: 3000, verdict: 'fail', correctness: 0.0, gave_up_or_errored: true, grounded: false },
    { task_id: 'T1.3', tier: 1, duration_ms: 2000, verdict: 'partial', correctness: 0.5, gave_up_or_errored: false, grounded: true }
  ]
  const s = aggregate(graded)
  assert.equal(s.total, 3)
  assert.equal(s.pass, 1)
  assert.equal(s.partial, 1)
  assert.equal(s.fail, 1)
  assert.ok(Math.abs(s.pass_rate - 1 / 3) < 1e-9)
  assert.ok(Math.abs(s.mean_correctness - 0.5) < 1e-9)
  assert.equal(s.gave_up_or_errored, 1)
  assert.equal(s.ungrounded, 1)
  assert.equal(s.mean_duration_ms, 2000)
  assert.equal(s.failures.length, 2)
  assert.equal(s.by_tier.T1.total, 3)
})

test('aggregate: unknown verdict counts as fail', () => {
  const s = aggregate([{ task_id: 'X', tier: 2, verdict: 'weird', correctness: 0 }])
  assert.equal(s.fail, 1)
})

test('aggregate: empty input', () => {
  const s = aggregate([])
  assert.equal(s.total, 0)
  assert.equal(s.pass_rate, 0)
  assert.equal(s.mean_correctness, 0)
})
