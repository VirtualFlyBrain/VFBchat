// The answer must describe VFB, not the program that produced it.
//
// Every fixture below is a VERBATIM line from the 3.8.0 live battery. All of
// them were already forbidden by the synthesis prompt when they were emitted,
// which is the whole argument for enforcing them deterministically instead.
//
// Run: node --test tests/unit/harnessFraming.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripHarnessFraming, hasHarnessFraming } from '../../lib/harnessFraming.mjs'

// --- pending-query framing: cut the clause, keep the holding ----------------

test('a trailing pending-query clause is cut and the count survives', () => {
  const cases = [
    [
      'VFB holds 602 records of Neurons with some part in mushroom body, but the query to list them has not been run yet.',
      'VFB holds 602 records of Neurons with some part in mushroom body.'
    ],
    [
      'VFB also holds scRNAseq data for LPLC2, but this query has not been run yet.',
      'VFB also holds scRNAseq data for LPLC2.'
    ],
    [
      'VFB also holds Transgene expression in Kenyon cell data, with 92 records, which has not been run yet.',
      'VFB also holds Transgene expression in Kenyon cell data, with 92 records.'
    ],
    [
      'VFB holds 32,328 images of Kenyon cell, although the query has yet to be run.',
      'VFB holds 32,328 images of Kenyon cell.'
    ],
    [
      'VFB has annotated 79 scRNAseq clusters for Kenyon cell; that lookup still needs to be run.',
      'VFB has annotated 79 scRNAseq clusters for Kenyon cell.'
    ]
  ]
  for (const [input, want] of cases) {
    assert.equal(stripHarnessFraming(input), want)
  }
})

test('a sentence that is nothing but a pending note is dropped whole', () => {
  const input = 'VFB records 45 DA1 lPN neurons in FAFB. This query has not been run yet. '
    + 'The FlyWire dataset holds 30.'
  assert.equal(
    stripHarnessFraming(input),
    'VFB records 45 DA1 lPN neurons in FAFB. The FlyWire dataset holds 30.'
  )
})

// --- input framing: drop the sentence, do not invent an absence -------------

test('a sentence reporting what the input contained is dropped, not rewritten', () => {
  // W4.C, verbatim. Rewriting this into "VFB does not hold data on VFB_jrchjtdb"
  // would assert an absence nobody checked — the neuron exists.
  const input = 'Neuron VFB_jrchjtdb is not mentioned in the provided evidence. '
    + 'The strongest outputs of DA1_lPN_R are to Kenyon cells.'
  assert.equal(stripHarnessFraming(input), 'The strongest outputs of DA1_lPN_R are to Kenyon cells.')
})

test('input nouns that survive in a longer sentence are renamed, not left', () => {
  const out = stripHarnessFraming('The provided evidence lists three connectome datasets.')
  assert.ok(!/provided evidence/i.test(out), out)
  assert.ok(/VFB evidence/i.test(out), out)
})

// --- what must NOT be touched ----------------------------------------------

test('a disclosed lookup failure is left alone', () => {
  // This describes a real event the reader is affected by. Suppressing it turns
  // a disclosed failure into a silent one.
  const input = 'VFB holds 92 transgene expression reports for Kenyon cell and the lookup for them did not complete.'
  assert.equal(stripHarnessFraming(input), input)
})

test('a genuine VFB absence is left alone', () => {
  const input = 'VFB does not currently hold data on transgene expression for this neuron.'
  assert.equal(stripHarnessFraming(input), input)
})

test('ordinary prose passes through unchanged', () => {
  const input = 'DA1 lPN is a projection neuron of the antennal lobe. '
    + 'VFB records 45 individuals in FAFB, 30 in FlyWire and 14 in the hemibrain.'
  assert.equal(stripHarnessFraming(input), input)
})

test('a run that produced results is never described as unrun', () => {
  const input = 'The NBLAST query returned 12 neurons with similar morphology.'
  assert.equal(stripHarnessFraming(input), input)
})

// --- safety -----------------------------------------------------------------

test('a rule that would delete the whole answer returns the original', () => {
  const input = 'This query has not been run yet.'
  // Wrong is recoverable for the reader; blank is not.
  assert.equal(stripHarnessFraming(input), input)
})

test('empty and non-string inputs are safe', () => {
  assert.equal(stripHarnessFraming(''), '')
  assert.equal(stripHarnessFraming(null), '')
  assert.equal(stripHarnessFraming(undefined), '')
})

// --- the detector -----------------------------------------------------------

test('the detector fires on exactly what the stripper removes', () => {
  for (const bad of [
    'VFB holds 602 records, but the query to list them has not been run yet.',
    'Neuron VFB_jrchjtdb is not mentioned in the provided evidence.',
    'This is not specified in the available information.'
  ]) {
    assert.equal(hasHarnessFraming(bad), true, bad)
    assert.equal(hasHarnessFraming(stripHarnessFraming(bad)), false, `still framed after strip: ${bad}`)
  }
  for (const ok of [
    'VFB holds 602 records of Neurons with some part in mushroom body.',
    'VFB does not currently hold data on this.',
    'The lookup for them did not complete.'
  ]) {
    assert.equal(hasHarnessFraming(ok), false, ok)
  }
})
