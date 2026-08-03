// Regression tests for the query_type rewrite that silently defeated the
// list-question fix (#79).
//
// The symptom: "List the neuron types that have some part in the medulla"
// returned no table and prose telling the user to go and run the query. Routing
// was provably correct — offline, pickQueriesByIntent picked NeuronsPartHere, and
// that query returns 471 rows against FBbt_00003748. The break was downstream, in
// the executor: validateVfbRunQueryTypes saw "neuron types" in the question,
// decided this was a taxonomy question, and rewrote NeuronsPartHere to
// SubclassesOf. medulla is a region and has no subclasses, so the query came back
// count 0 / rows [], the deterministic list branch in runStep had nothing to name,
// and the synthesiser fell back to describing the query catalogue.
//
// The rewrite is a keyword guess. It earns its keep on the legacy relay loop,
// where the model picks a query_type freehand. It must never fire on the role
// harness, which picks deterministically from the term's own Queries[].
//
// Run: node --test tests/unit/taxonomyQueryOverride.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickTaxonomyQueryTypeOverride } from '../../app/api/chat/route.js'

// The real Queries[] catalogue of medulla (FBbt_00003748), trimmed to the names
// that matter here. Note SubclassesOf IS listed — being listed is not the same as
// returning rows, which is exactly what made the rewrite look safe.
const MEDULLA_QUERIES = [
  'NeuronsPartHere', 'NeuronsSynaptic', 'NeuronsPresynapticHere',
  'NeuronsPostsynapticHere', 'PartsOf', 'SubclassesOf', 'TractsNervesInnervating',
  'LineageClonesFound', 'ImagesOfNeuronsPartHere'
]

const MEDULLA_QUESTION = 'List the neuron types that have some part in the medulla'

test('the harness choice is never rewritten', () => {
  // The exact case that broke. Without the veto this returns 'SubclassesOf'.
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: MEDULLA_QUERIES,
    userMessage: MEDULLA_QUESTION,
    fromHarness: true
  }), null)
})

test('the legacy relay path keeps the taxonomy preference', () => {
  // The behaviour the override exists for is untouched: same inputs, no veto.
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: MEDULLA_QUERIES,
    userMessage: MEDULLA_QUESTION,
    fromHarness: false
  }), 'SubclassesOf')
})

test('fromHarness defaults to false, so omitting it does not silently disable the override', () => {
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: MEDULLA_QUERIES,
    userMessage: MEDULLA_QUESTION
  }), 'SubclassesOf')
})

test('a query type named outright in the question is an instruction, not a hint', () => {
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: MEDULLA_QUERIES,
    userMessage: 'Run NeuronsPartHere on medulla and list the neuron types',
    fromHarness: false
  }), null)
})

test('a question with no taxonomy wording is left alone', () => {
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: MEDULLA_QUERIES,
    userMessage: 'Which neurons have some part in the medulla?',
    fromHarness: false
  }), null)
})

test('only spatial query types are overridable', () => {
  // A connectivity or image query is not a mis-picked taxonomy query, so the
  // wording must not drag it to SubclassesOf.
  for (const queryType of ['ImagesOfNeuronsPartHere', 'TractsNervesInnervating', 'LineageClonesFound']) {
    assert.equal(pickTaxonomyQueryTypeOverride({
      currentQueryType: queryType,
      availableQueryTypes: MEDULLA_QUERIES,
      userMessage: MEDULLA_QUESTION,
      fromHarness: false
    }), null, `${queryType} should not be overridable`)
  }
})

test('no rewrite when the preferred taxonomy query is not available for the term', () => {
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: ['NeuronsPartHere', 'NeuronsSynaptic'],
    userMessage: MEDULLA_QUESTION,
    fromHarness: false
  }), null)
})

test('no rewrite when the chosen query already IS the preferred taxonomy query', () => {
  // PartsOf is both overridable and a preference candidate; it must not be
  // "replaced" by itself, which would look like a change that never happened.
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'PartsOf',
    availableQueryTypes: ['PartsOf', 'ComponentsOf'],
    userMessage: MEDULLA_QUESTION,
    fromHarness: false
  }), null)
})

test('preference order is SubclassesOf, then PartsOf, then ComponentsOf', () => {
  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: ['ComponentsOf', 'PartsOf', 'SubclassesOf'],
    userMessage: MEDULLA_QUESTION,
    fromHarness: false
  }), 'SubclassesOf')

  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: ['ComponentsOf', 'PartsOf'],
    userMessage: MEDULLA_QUESTION,
    fromHarness: false
  }), 'PartsOf')

  assert.equal(pickTaxonomyQueryTypeOverride({
    currentQueryType: 'NeuronsPartHere',
    availableQueryTypes: ['ComponentsOf'],
    userMessage: MEDULLA_QUESTION,
    fromHarness: false
  }), 'ComponentsOf')
})

test('called with nothing at all, it declines rather than throwing', () => {
  assert.equal(pickTaxonomyQueryTypeOverride(), null)
})
