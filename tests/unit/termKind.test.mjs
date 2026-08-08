// An Individual is one specific example of a Type, and the two answer different
// questions.
//
// Real payloads, copied from the live MCP. VFB_fw004661 is one reconstructed
// FlyWire neuron; it offers SimilarMorphologyTo and NeuronNeuronConnectivityQuery
// and nothing else. Every type-level question about it — what neurotransmitter
// does this kind of neuron use, what is this type downstream of, which split-GAL4
// lines target it — has to be asked of FBbt_00067363, which the individual names
// in Meta.Types and which nothing in the app was reading.

import test from 'node:test'
import assert from 'node:assert/strict'
import { termKind, parentClassesOf, termFlagsOf, offersQuery } from '../../lib/termKind.mjs'

const INDIVIDUAL = {
  Name: 'DA1_lPN',
  Id: 'VFB_fw004661',
  SuperTypes: ['Entity', 'Individual', 'VFB', 'Neuron', 'Adult', 'Anatomy', 'Cell', 'Cholinergic', 'has_image', 'NBLAST'],
  Tags: ['Adult', 'Cholinergic'],
  Meta: {
    Types: '[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363); [adult fruitless aDT-e (female) neuron](FBbt_00110423)',
    Relationships: '83% [capable of](RO_0002215): [acetylcholine secretion, neurotransmission](GO_0014055); [develops from](RO_0002202): [neuroblast BAlc](FBbt_00067347); [is part of](BFO_0000050): [adult brain](FBbt_00003624)'
  },
  Queries: [{ query: 'SimilarMorphologyTo' }, { query: 'NeuronNeuronConnectivityQuery' }],
  IsIndividual: true,
  IsClass: false,
  IsTemplate: false,
  IsPaintedDomain: false
}

const NEURON_CLASS = {
  Name: 'Kenyon cell',
  Id: 'FBbt_00003686',
  SuperTypes: ['Entity', 'Class', 'Nervous_system', 'Neuron', 'Cell', 'Anatomy'],
  Tags: [],
  Meta: {},
  Queries: [{ query: 'SplitsTargeting' }, { query: 'SubclassesOf' }, { query: 'UpstreamClassConnectivity' }],
  IsIndividual: false,
  IsClass: true,
  IsTemplate: false,
  IsPaintedDomain: false
}

const REGION = {
  Name: 'adult lateral horn',
  Id: 'FBbt_00007053',
  SuperTypes: ['Entity', 'Class', 'Anatomy', 'Synaptic_neuropil', 'Adult', 'Nervous_system'],
  Tags: ['Adult'],
  Meta: {},
  Queries: [{ query: 'NeuronsPartHere' }, { query: 'TransgeneExpressionHere' }],
  IsIndividual: false,
  IsClass: true,
  IsTemplate: false,
  IsPaintedDomain: false
}

test('an individual is recognised as an individual, not as its neuron class', () => {
  assert.equal(termKind(INDIVIDUAL), 'individual')
  assert.equal(termKind(NEURON_CLASS), 'class')
})

test('a synaptic neuropil is a region even though it is also an ontology class', () => {
  // It IS IsClass: true. But the class-connectivity tools have no region
  // endpoints, so calling it a class is the mistake that produces a false
  // "VFB does not currently hold connectivity for the lateral horn".
  assert.equal(termKind(REGION), 'region')
})

test('an individual names the classes it is an example of', () => {
  assert.deepEqual(parentClassesOf(INDIVIDUAL), [
    { id: 'FBbt_00067363', label: 'adult antennal lobe projection neuron DA1 lPN' },
    { id: 'FBbt_00110423', label: 'adult fruitless aDT-e (female) neuron' }
  ])
})

test('relationships are not mistaken for types', () => {
  // The existing parser in route.js concatenated Meta.Types, Meta.Type AND
  // Meta.Relationships and took the first FBbt id. On this record that risks
  // returning "neuroblast BAlc" or "adult brain" as the neuron's own type —
  // and "is part of adult brain" is true of every neuron in the dataset.
  const parents = parentClassesOf(INDIVIDUAL).map(p => p.id)
  assert.ok(!parents.includes('FBbt_00067347'), 'neuroblast BAlc is what it develops from, not what it is')
  assert.ok(!parents.includes('FBbt_00003624'), 'adult brain is what it is part of, not what it is')
})

test('a class is not an example of anything', () => {
  assert.deepEqual(parentClassesOf(NEURON_CLASS), [])
  assert.deepEqual(parentClassesOf(REGION), [])
  assert.deepEqual(parentClassesOf(null), [])
})

test('the type-level query the individual lacks is on its parent class', () => {
  // This is the whole point. The question "which split-GAL4 lines target this
  // neuron?" cannot be answered of VFB_fw004661 and can be answered of its type.
  assert.equal(offersQuery(INDIVIDUAL.Queries, 'SplitsTargeting'), false)
  assert.equal(offersQuery(NEURON_CLASS.Queries, 'SplitsTargeting'), true)
  assert.equal(offersQuery(INDIVIDUAL.Queries, 'SimilarMorphologyTo'), true)
  // Case- and field-name-insensitive: digests use query_type, records use query.
  assert.equal(offersQuery([{ query_type: 'SubclassesOf' }], 'subclassesof'), true)
})

test('records without the explicit flags still classify from SuperTypes', () => {
  assert.equal(termKind({ SuperTypes: ['Individual', 'Neuron'] }), 'individual')
  assert.equal(termKind({ SuperTypes: ['Class', 'Neuron'] }), 'class')
  assert.equal(termKind({ SuperTypes: ['Class', 'Anatomy', 'Synaptic_neuropil'] }), 'region')
  assert.equal(termKind({ SuperTypes: [] }), null)
  assert.equal(termKind(null), null)
})

test('templates and painted domains are not confused with either', () => {
  assert.equal(termKind({ IsTemplate: true, IsClass: false, IsIndividual: true }), 'template')
  assert.equal(termKind({ IsPaintedDomain: true, IsIndividual: true }), 'region')
})

test('termFlagsOf merges SuperTypes and Tags, lower-cased', () => {
  assert.ok(termFlagsOf(INDIVIDUAL).includes('cholinergic'))
  assert.ok(termFlagsOf(INDIVIDUAL).includes('individual'))
  assert.deepEqual(termFlagsOf(null), [])
})
