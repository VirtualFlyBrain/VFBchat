// Routing tests for classification/taxonomy questions.
//
// The symptom: "How are visual system neurons classified in VFB?" resolved
// FBbt_00047736 correctly and then answered with the digest catalogue read back
// — "you can run queries for the counts of these records" — about a class whose
// subclasses VFB holds. No query ran because no intent rule matched: the
// question has no list/which/what-neurons wording, so it fell past the broad
// class-list rule and off the end.
//
// The correction has two halves that have to be judged together. Routing
// classification questions to SubclassesOf is the fix; NOT routing spatial
// questions there is what stops the fix from re-creating #79, where a region's
// NeuronsPartHere was replaced by SubclassesOf and medulla has no subclasses.
//
// Run: node --test tests/unit/taxonomyIntent.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickQueriesByIntent, namesAnatomicalScope } from '../../lib/orchestrator.mjs'

const Q = (query_type, label) => ({ query_type, label, count: -1, countKind: 'unknown' })

// The real catalogue of visual system neuron (FBbt_00047736). Note that four of
// these are kind class_list — the three synaptic queries and SubclassesOf — so
// the semantic kind alone cannot choose, and they share no word with the
// question, so label overlap cannot either.
const NEURON_CLASS = { name: 'visual system neuron', queries: [
  Q('ListAllAvailableImages', 'List all available images of visual system neuron'),
  Q('SplitsTargeting', 'Splits targeting visual system neuron'),
  Q('NeuronsSynaptic', 'Neurons with synaptic terminals in visual system neuron'),
  Q('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in visual system neuron'),
  Q('NeuronsPostsynapticHere', 'Neurons with postsynaptic terminals in visual system neuron'),
  Q('SubclassesOf', 'Subclasses of visual system neuron'),
  Q('anatScRNAseqQuery', 'scRNAseq data for visual system neuron'),
  Q('TransgeneExpressionHere', 'Transgene expression in visual system neuron'),
  Q('DownstreamClassConnectivity', 'Downstream connectivity classes for visual system neuron'),
  Q('UpstreamClassConnectivity', 'Upstream connectivity classes for visual system neuron')
] }

// The real catalogue of medulla (FBbt_00003748), the term from #79. SubclassesOf
// is listed here too — being listed is not the same as returning rows, which is
// what made the original rewrite look safe.
const REGION = { name: 'medulla', queries: [
  Q('NeuronsPartHere', 'Neurons with some part in medulla'),
  Q('NeuronsSynaptic', 'Neurons with synaptic terminals in medulla'),
  Q('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in medulla'),
  Q('NeuronsPostsynapticHere', 'Neurons with postsynaptic terminals in medulla'),
  Q('PartsOf', 'Parts of medulla'),
  Q('SubclassesOf', 'Subclasses of medulla'),
  Q('ListAllAvailableImages', 'List all available images of medulla')
] }

const types = (picks) => picks.map(p => p.query_type)

// --- the questions that must now route ---------------------------------------

test('a classification question about a class runs SubclassesOf', () => {
  // The exact case that broke. Before this rule it picked nothing at all.
  assert.deepEqual(
    types(pickQueriesByIntent('How are visual system neurons classified in VFB?', NEURON_CLASS)),
    ['SubclassesOf']
  )
})

test('the rest of the classification vocabulary routes the same way', () => {
  for (const q of [
    'What is the taxonomy of visual system neurons?',
    // Not "show me the hierarchy": "show me" is the images trigger and it is an
    // earlier rule, which is the right precedence — see the specific-intent test
    // below. Rule order, not this rule, decides that.
    'Where does visual system neuron sit in the VFB hierarchy?',
    'What are the subclasses of visual system neuron?',
    'What subtypes of visual system neuron does VFB have?',
    'What kinds of visual system neuron are there?',
    'How is the visual system neuron class organised hierarchically?'
  ]) {
    assert.deepEqual(types(pickQueriesByIntent(q, NEURON_CLASS)), ['SubclassesOf'], q)
  }
})

test('the named preference is honoured in order when SubclassesOf is absent', () => {
  // A region with no SubclassesOf still has a meaningful "what is this made of"
  // answer; the rule falls to PartsOf, then ComponentsOf, then declines.
  const partsOnly = { name: 'x', queries: [Q('NeuronsPartHere', 'Neurons with some part in x'), Q('PartsOf', 'Parts of x')] }
  assert.deepEqual(types(pickQueriesByIntent('What kinds of subdivision does x have?', partsOnly)), ['PartsOf'])

  const componentsOnly = { name: 'x', queries: [Q('ComponentsOf', 'Components of x')] }
  assert.deepEqual(types(pickQueriesByIntent('What kinds of component does x have?', componentsOnly)), ['ComponentsOf'])
})

test('no taxonomy query available means the rule declines rather than substituting', () => {
  // Falling through to "some other class_list query" would answer a question
  // about structure with a question about connectivity.
  const noTaxonomy = { name: 'x', queries: [Q('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in x')] }
  assert.deepEqual(types(pickQueriesByIntent('How is x classified?', noTaxonomy)), [])
})

// --- the questions that must NOT route here (the #79 guard) ------------------

test('a spatial list question is untouched, even carrying the word "types"', () => {
  // #79 verbatim. "neuron types" must not be read as taxonomy vocabulary; the
  // right answer is the region's spatial query, which returns 471 rows.
  assert.deepEqual(
    types(pickQueriesByIntent('List the neuron types that have some part in the medulla', REGION)),
    ['NeuronsPartHere']
  )
})

test('a classification question scoped to a region does not get the region\'s subclasses', () => {
  // medulla has no subclasses, so SubclassesOf here is a confidently empty
  // answer. Declining leaves today's behaviour, which is merely unhelpful.
  for (const q of [
    'How are the neurons in the medulla classified?',
    'What subtypes of neuron are found within the antennal lobe?'
  ]) {
    assert.ok(!types(pickQueriesByIntent(q, REGION)).includes('SubclassesOf'), q)
  }
})

test('taxonomy wording does not outrank a more specific intent', () => {
  // The rule sits after similarity, images, expression and connectivity, so a
  // question that is really about one of those keeps its own routing.
  assert.deepEqual(
    types(pickQueriesByIntent('What genes are expressed in the subtypes of visual system neuron?', NEURON_CLASS)),
    ['anatScRNAseqQuery']
  )
  assert.deepEqual(
    types(pickQueriesByIntent('Show me images of the subtypes of visual system neuron', NEURON_CLASS)),
    ['ListAllAvailableImages']
  )
})

// --- namesAnatomicalScope ----------------------------------------------------

test('naming VFB itself is not naming a place', () => {
  // "classified in VFB" is the target case; vetoing it would undo the whole fix.
  for (const q of [
    'How are visual system neurons classified in VFB?',
    'How are visual system neurons classified in the VFB ontology?',
    'How are visual system neurons classified in virtual fly brain?',
    'How is this classified in the database?',
    'How are neurons classified in general?'
  ]) {
    assert.equal(namesAnatomicalScope(q), false, q)
  }
})

test('naming an anatomical structure is naming a place', () => {
  for (const q of [
    'How are the neurons in the medulla classified?',
    'What subtypes are found within the antennal lobe?',
    'Which neurons have some part in the mushroom body?',
    'Which neurons have presynaptic terminals in the lobula?',
    'Which tracts innervate the central complex?',
    'What projects to the fan-shaped body?'
  ]) {
    assert.equal(namesAnatomicalScope(q), true, q)
  }
})

test('a question naming no scope at all is not vetoed', () => {
  assert.equal(namesAnatomicalScope('What are the subclasses of Kenyon cell?'), false)
  assert.equal(namesAnatomicalScope(''), false)
  assert.equal(namesAnatomicalScope(), false)
})
