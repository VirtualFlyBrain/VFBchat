// The synthesiser mis-typing a count it was handed.
//
// Production, v4.2.0, "What split-GAL4 lines label the lateral horn?", five
// repetitions. Three rendered the count as a backend-built link and said
// 1,934 — the true TransgeneExpressionHere total for FBbt_00007053. Two wrote
// it in prose and said 1,924. The project's rule is that the model narrates and
// the deterministic layer carries the numbers; nothing enforced it after
// synthesis, and the grounding audit could not see the error because 1,924 is
// within the 2% rounding tolerance of 1,934.
//
// A wrong "correction" would be worse than the bug, so the repair only fires
// when the corruption is provable: same digit count, within 2%, not rounder,
// and exactly one candidate.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findUngroundedNumbers,
  findMistranscribedCounts,
  repairMistranscribedCounts
} from '../../lib/grounding.mjs'

const LATERAL_HORN_COUNTS = [1934, 1661, 1658, 816, 1375, 17792]

test('the production case: 1,924 is repaired to 1,934', () => {
  const answer = 'VFB holds 1,924 records of transgene expression in the adult lateral horn.'
  const { text, fixes } = repairMistranscribedCounts(answer, LATERAL_HORN_COUNTS)
  assert.equal(text, 'VFB holds 1,934 records of transgene expression in the adult lateral horn.')
  assert.deepEqual(fixes, [{ wrote: 1924, shouldBe: 1934 }])
})

test('the audit now sees it too — it used to read as grounded', () => {
  // This is the regression that let it ship: |1934 - 1924| = 10, and
  // 2% of 1934 is 38.7, so the old tolerance called it grounded.
  assert.deepEqual(findUngroundedNumbers('VFB holds 1,924 records', LATERAL_HORN_COUNTS), [1924])
})

test('a genuine rounding is left alone, in prose and in the audit', () => {
  assert.deepEqual(findMistranscribedCounts('VFB holds about 1,900 records', LATERAL_HORN_COUNTS), [])
  assert.deepEqual(findUngroundedNumbers('VFB holds about 1,900 records', LATERAL_HORN_COUNTS), [])
})

test('a rounding outside tolerance is audited but never rewritten', () => {
  // "roughly 2,000" is 3.4% above the real 1,934 — past the tolerance, so the
  // audit says so, but repair still declines because it cannot prove which
  // number was meant. Audit and repair are deliberately different thresholds:
  // logging a doubtful figure is free, rewriting one is not.
  assert.deepEqual(findMistranscribedCounts('roughly 2,000 expression patterns', LATERAL_HORN_COUNTS), [])
  assert.deepEqual(findUngroundedNumbers('roughly 2,000 expression patterns', LATERAL_HORN_COUNTS), [2000])
  // A bare year keeps its exemption; only a thousands separator removes it.
  assert.deepEqual(findUngroundedNumbers('published in 2000', LATERAL_HORN_COUNTS), [])
})

test('the existing rounding contract still holds', () => {
  // 1200.5 written as 1,201 — a small absolute slip is rounding, not corruption.
  assert.deepEqual(findUngroundedNumbers('Dop1R1 at 1,201', [9413, 1200.5]), [])
  assert.deepEqual(findUngroundedNumbers('the brain has 139,255 neurons; VFB annotates 9413', [9413, 1200.5]), [139255])
  assert.deepEqual(findUngroundedNumbers('in 2020 there were 37 subtypes', [9413]), [])
})

test('a number of a different magnitude is never rewritten', () => {
  // The dangerous shape: "about 100" next to a grounded 190 differs by one
  // digit. Different digit counts and roundness both veto it.
  assert.deepEqual(findMistranscribedCounts('about 1,000 neurons', [1934]), [])
  assert.deepEqual(findMistranscribedCounts('12 neurons', [1934]), [])
  assert.deepEqual(findMistranscribedCounts('190,000 synapses', [1934]), [])
})

test('an ambiguous number is left alone rather than guessed at', () => {
  // 1,930 sits within 2% of both 1,934 and 1,929 — two candidates, no repair.
  assert.deepEqual(findMistranscribedCounts('VFB holds 1,931 records', [1934, 1929]), [])
})

test('numbers already inside a deterministic link are never touched', () => {
  const answer = 'VFB holds [1,934](https://v2.example/q "Run in VFB") records, and 1,924 elsewhere.'
  const { text, fixes } = repairMistranscribedCounts(answer, LATERAL_HORN_COUNTS)
  assert.match(text, /\[1,934\]\(https:\/\/v2\.example\/q "Run in VFB"\)/)
  assert.match(text, /and 1,934 elsewhere/)
  assert.deepEqual(fixes, [{ wrote: 1924, shouldBe: 1934 }])
})

test('a PMID adjacent to another PMID is not "corrected" into it', () => {
  // 39358518 and 39358519 are both real, both grounded, one digit apart.
  const grounded = [39358518, 39358519, 9413]
  assert.deepEqual(findMistranscribedCounts('PMID 39358519 and PMID 39358518', grounded), [])
})

test('an answer with nothing to repair is returned unchanged and untouched', () => {
  const answer = 'VFB holds 1,934 records.'
  const { text, fixes } = repairMistranscribedCounts(answer, LATERAL_HORN_COUNTS)
  assert.equal(text, answer)
  assert.deepEqual(fixes, [])
  assert.deepEqual(repairMistranscribedCounts(answer, []).fixes, [])
})
