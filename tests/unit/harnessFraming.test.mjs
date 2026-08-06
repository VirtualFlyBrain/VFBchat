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

// --- W4.C: the opener the cut left behind -----------------------------------
//
// The whole answer, verbatim from the 3.9.1 live battery. INPUT_SENTENCE
// already removed the first sentence in 3.9.0; what shipped was the seam.

test('an orphaned contrastive opener is removed and the next word recapitalised', () => {
  const input = 'Neuron VFB_jrchjtdb is not mentioned in the provided evidence. '
    + 'However, they include v2LN30_R with 73 synapses.'
  assert.equal(stripHarnessFraming(input), 'They include v2LN30_R with 73 synapses.')
})

test('every orphaned opener form is handled', () => {
  for (const opener of ['However,', 'But', 'Yet', 'Additionally,', 'Also,', 'Moreover,',
    'Furthermore,', 'Nevertheless,', 'Nonetheless,', 'In addition,', 'That said,',
    'Even so,', 'On the other hand,', 'Instead,', 'Still,']) {
    const input = `This is not mentioned in the provided evidence. ${opener} DA1_lPN_R has 73 synapses.`
    assert.equal(stripHarnessFraming(input), 'DA1_lPN_R has 73 synapses.', opener)
  }
})

test('a connective that still has a sentence in front of it is left alone', () => {
  const input = 'VFB records 73 synapses onto v2LN30_R. However, the totals differ by dataset. '
    + 'This query has not been run yet.'
  assert.equal(
    stripHarnessFraming(input),
    'VFB records 73 synapses onto v2LN30_R. However, the totals differ by dataset.'
  )
})

test('an opener the model wrote itself, with nothing cut, is not touched', () => {
  // This module edits its own wreckage and nothing else.
  const input = 'However, DA1_lPN_R has 73 synapses onto v2LN30_R.'
  assert.equal(stripHarnessFraming(input), input)
})

// --- W4.C: the input promoted to subject ------------------------------------

test('evidence-as-subject hands the verb back to VFB', () => {
  const cases = [
    [
      'However, the evidence does provide information on the strongest outputs of a neuron, '
      + 'which are: v2LN30_R (FlyEM-HB:1671620613) with 73 synapses.',
      'VFB records the strongest outputs of a neuron, which are: '
      + 'v2LN30_R (FlyEM-HB:1671620613) with 73 synapses.'
    ],
    [
      'The evidence provides details about Kenyon cell partners.',
      'VFB records Kenyon cell partners.'
    ],
    [
      'This evidence shows that Kenyon cells synapse onto MBONs.',
      'VFB records that Kenyon cells synapse onto MBONs.'
    ]
  ]
  for (const [input, want] of cases) assert.equal(stripHarnessFraming(input), want)
})

test('a negative evidence claim is never rewritten into a claim about VFB', () => {
  // "the evidence does not provide X" is a fact about this answer's reach.
  // "VFB does not record X" is a fact about the database, and nobody checked it.
  const input = 'The evidence does not provide information on its lineage.'
  const out = stripHarnessFraming(input)
  assert.ok(!/VFB records/.test(out), out)
  assert.ok(!/VFB does not/.test(out), out)
})

test('the W4.C answer, end to end', () => {
  const input = 'However, the evidence does provide information on the strongest outputs of a '
    + 'neuron, which are: v2LN30_R (FlyEM-HB:1671620613) with 73 synapses, DA1_vPN_R '
    + '(FlyEM-HB:733316908) with 61 synapses, and lLN2T_c(Tortuous)_R (FlyEM-HB:1704347707) '
    + 'with 61 synapses.'
  const out = stripHarnessFraming(input)
  assert.ok(out.startsWith('VFB records the strongest outputs'), out)
  assert.ok(!/^However/.test(out), out)
  assert.ok(out.includes('73 synapses'), out)
  assert.equal(hasHarnessFraming(out), false, out)
})
