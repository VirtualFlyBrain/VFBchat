// Battery correctness grading (LLM-as-judge) — pure logic only.
//
// The task-battery runner records responses and a "ok" completion flag, but no
// correctness signal. This module supplies the judge schema, prompt builder and
// aggregation so harness changes can be measured (pass/partial/fail + score).
// The network call lives in scripts/grade-battery.mjs; everything here is
// offline-testable.
//
// Judge dimensions are chosen so even a weaker local judge is reliable:
// "answered / grounded / gave-up-or-errored" are robust observations; the
// numeric correctness is best-effort and improves with a stronger judge model.
// See outputs/reports/vfbchat-harness-design.md §8 (LLM-as-judge).

export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answered', 'grounded', 'gave_up_or_errored', 'correctness', 'verdict', 'reason'],
  properties: {
    answered: { type: 'boolean' },
    grounded: { type: 'boolean' },
    gave_up_or_errored: { type: 'boolean' },
    correctness: { type: 'number' },
    verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },
    reason: { type: 'string' }
  }
}

const JUDGE_SYSTEM = `You are a strict grader for a Drosophila neuroscience assistant that answers from Virtual Fly Brain (VFB) data.
Grade ONLY the assistant's answer to the user question. Return JSON matching the schema. Definitions:
- answered: true if the answer substantively addresses the question (not a deflection, not "I cannot answer").
- grounded: true if claims are attributed to VFB/tool evidence rather than apparent general knowledge.
- gave_up_or_errored: true if the answer reports a tool failure, timeout, empty/zero result, or otherwise abandons the question.
- correctness: 0.0-1.0 best estimate of factual correctness for Drosophila neuroanatomy/connectomics.
- verdict: "pass" only if the question is correctly and substantively answered and grounded; "fail" if wrong, ungrounded, or abandoned; otherwise "partial".
- reason: one concise sentence.
Be strict: an answer that says VFB returned an error or zero results and does not otherwise answer is a "fail" with gave_up_or_errored=true.`

/** Build chat messages to grade a single battery result. */
export function buildJudgeMessages(task) {
  const question = task?.question ?? ''
  const answer = task?.response ?? ''
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: `QUESTION:\n${question}\n\nASSISTANT ANSWER:\n${answer}\n\nGrade it. JSON only.` }
  ]
}

/**
 * Aggregate graded results into a summary.
 * @param {Array<{task_id, tier, duration_ms, verdict, correctness, gave_up_or_errored, grounded, answered, reason}>} graded
 */
export function aggregate(graded) {
  const rows = graded || []
  const n = rows.length
  const counts = { pass: 0, partial: 0, fail: 0 }
  let scoreSum = 0
  let durSum = 0
  let gaveUp = 0
  let ungrounded = 0
  const failures = []
  const byTier = {}

  for (const r of rows) {
    const v = counts[r.verdict] !== undefined ? r.verdict : 'fail'
    counts[v]++
    scoreSum += typeof r.correctness === 'number' ? r.correctness : 0
    durSum += typeof r.duration_ms === 'number' ? r.duration_ms : 0
    if (r.gave_up_or_errored) gaveUp++
    if (r.grounded === false) ungrounded++
    if (v !== 'pass') failures.push({ task_id: r.task_id, verdict: v, reason: r.reason })
    const tier = `T${r.tier ?? '?'}`
    byTier[tier] = byTier[tier] || { total: 0, pass: 0, partial: 0, fail: 0 }
    byTier[tier].total++
    byTier[tier][v]++
  }

  return {
    total: n,
    pass: counts.pass,
    partial: counts.partial,
    fail: counts.fail,
    pass_rate: n ? counts.pass / n : 0,
    mean_correctness: n ? scoreSum / n : 0,
    gave_up_or_errored: gaveUp,
    ungrounded,
    mean_duration_ms: n ? Math.round(durSum / n) : 0,
    by_tier: byTier,
    failures
  }
}
