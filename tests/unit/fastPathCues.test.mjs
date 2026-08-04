// Tests for the cue lists that hold detectFastPath back.
//
// The symptom: "What are the main inputs to MBON-a1?" answered "The name 'main
// inputs to MBON-a1' could not be matched to a VFB term. There are no candidate
// matches listed." Asked the same thing as "What neurons are presynaptic to
// MBON-a1?" it answers properly, naming the strongest partners and their synapse
// counts, so nothing was missing from VFB — the question never got there.
//
// detectFastPath is meant to veto exactly this. Its cue list carried "input",
// and inside \b(...)\b a bare stem has no inflections: \binput\b does not match
// "inputs", because the boundary it wants is occupied by the "s". So the veto
// missed, the question took the single-subject path, and cleanSubject handed
// "main inputs to MBON-a1" to search_terms as though it were the name of a term.
//
// The same flaw sat on nearly every cue in both lists — "function"/"functions",
// "paper"/"papers", "connect"/"connections" — and "morpholog" could not match
// anything at all, there being no word boundary between "g" and "y".
//
// The direction of error matters here. A vetoed question falls through to the
// planner, which is strictly more capable than this path; the cost is one model
// call. A missed veto is a confidently wrong answer, as above. So these tests
// assert the veto broadly and the fast path only on the shapes it exists for.
//
// Run: node --test tests/unit/fastPathCues.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectFastPath } from '../../lib/planner.mjs'

test('the question that exposed this is vetoed', () => {
  assert.equal(detectFastPath('What are the main inputs to MBON-a1?'), null)
})

test('plural cues veto exactly as their singulars do', () => {
  // Each pair is the same question in both numbers. Before the inflections were
  // spelled out only the left-hand member of each pair was vetoed.
  const pairs = [
    ['What is the input to MBON-a1?', 'What are the inputs to MBON-a1?'],
    ['What is the output of the mushroom body?', 'What are the outputs of the mushroom body?'],
    ['What is the function of PPL1?', 'What are the functions of PPL1?'],
    ['What is the role of the fan-shaped body?', 'What are the roles of the fan-shaped body?'],
    ['What is the driver for Kenyon cells?', 'What are the drivers for Kenyon cells?'],
    ['What is the paper describing the medulla?', 'What are the papers describing the medulla?'],
    ['What is the publication for FAFB?', 'What are the publications for FAFB?'],
    ['What is the stock for this line?', 'What are the stocks for this line?'],
    ['What is the split line for MBON-a1?', 'What are the split lines for MBON-a1?'],
    ['What is the mechanism of this circuit?', 'What are the mechanisms of this circuit?'],
    ['What is the pathway from ORNs to the lateral horn?', 'What are the pathways from ORNs to the lateral horn?']
  ]
  for (const [singular, plural] of pairs) {
    assert.equal(detectFastPath(singular), null, singular)
    assert.equal(detectFastPath(plural), null, plural)
  }
})

test('a stem cue matches the words it is a stem OF', () => {
  // "morpholog" was written as a stem but sat inside \b...\b, which needs a
  // boundary between "g" and "y" — so it matched neither "morphology" nor
  // anything else. It was dead text.
  for (const q of [
    'What is the morphology of PPL1?',
    'What are the morphological features of PPL1?',
    'What is the similarity between these two neurons?',
    'What are the similarities between these two neurons?',
    'What are the connections of the medulla?',
    'What is connected to the medulla?',
    'What is the expression of Rdl here?',
    'What is expressed in Kenyon cells?',
    'What is the comparison of these two?',
    'What are the neurotransmitters used by Kenyon cells?',
    'What is the transmitter of this neuron?'
  ]) {
    assert.equal(detectFastPath(q), null, q)
  }
})

test('the definitional lookups the fast path exists for still take it', () => {
  // The veto got broader, so this is the half that has to be re-checked: none of
  // these should have started costing a planner call.
  for (const q of [
    'What is the mushroom body?',
    'What are the subdivisions of the central complex?',
    'What are the parts of the antennal lobe?',
    'What is the medulla?',
    'What are the major subdivisions of the Drosophila mushroom body?'
  ]) {
    assert.ok(detectFastPath(q), q)
  }
})

test('a leading indefinite article is not part of the name', () => {
  // "a Kenyon cell" went to VFB verbatim, which costs the exact-label match and
  // leaves the term to be recovered by the weakest stage of the resolver.
  assert.deepEqual(detectFastPath('What is a Kenyon cell?').terms_to_resolve, ['Kenyon cell'])
  assert.deepEqual(detectFastPath('What is an olfactory projection neuron?').terms_to_resolve,
    ['olfactory projection neuron'])
})

test('an abbreviation that looks like an article survives', () => {
  // AN is the abbreviation for ascending neuron. Stripping articles
  // case-insensitively would send this question to VFB as "neurons", so the
  // strip is lowercase-only and this is the test that says why.
  assert.deepEqual(detectFastPath('What are AN neurons?').terms_to_resolve, ['AN neurons'])
})

test('a vetoed question is vetoed, not merely unresolved', () => {
  // Both are null, but for different reasons, and the distinction is the point:
  // the first has a perfectly good subject and is held back on its cue, the
  // second never matched the "what is/are" shape at all. If the cue check were
  // removed the first would silently start fast-pathing again.
  assert.equal(detectFastPath('What are the inputs to MBON-a1?'), null)
  assert.equal(detectFastPath('Which neurons are presynaptic to MBON-a1?'), null)
})
