// Asking a type-level question when the user named one specific example.
//
// VFB_fw004661 is a single reconstructed FlyWire neuron. Its whole query
// catalogue is SimilarMorphologyTo and NeuronNeuronConnectivityQuery. The class
// it names in Meta.Types — adult antennal lobe projection neuron DA1 lPN,
// FBbt_00067363 — is where SubclassesOf, the class-connectivity queries,
// TransgeneExpressionHere and SplitsTargeting live.
//
// So "which split-GAL4 lines target this neuron?" asked with that individual
// selected is a good question the term in hand cannot answer. Every recovery in
// the harness retried the SAME term — forced cache bypass, different reader,
// different query_type — and the step ended as TRIED, NO RESULT.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedger, setPlan, addTerm } from '../../lib/ledger.mjs'
import { liftStepsToOfferingType } from '../../lib/orchestrator.mjs'

const INDIVIDUAL_RECORD = {
  Name: 'DA1_lPN',
  Id: 'VFB_fw004661',
  SuperTypes: ['Entity', 'Individual', 'VFB', 'Neuron', 'Cholinergic'],
  Tags: ['Cholinergic'],
  Meta: {
    Types: '[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363)',
    Relationships: '[develops from](RO_0002202): [neuroblast BAlc](FBbt_00067347); [is part of](BFO_0000050): [adult brain](FBbt_00003624)'
  },
  Queries: [
    { query: 'SimilarMorphologyTo', label: 'Neurons with similar morphology to DA1_lPN [NBLAST]', count: -1 },
    { query: 'NeuronNeuronConnectivityQuery', label: 'Neurons connected to DA1_lPN', count: -1 }
  ],
  IsIndividual: true,
  IsClass: false
}

const CLASS_RECORD = {
  Name: 'adult antennal lobe projection neuron DA1 lPN',
  Id: 'FBbt_00067363',
  SuperTypes: ['Entity', 'Class', 'Neuron'],
  Tags: [],
  Meta: {},
  Queries: [
    { query: 'SplitsTargeting', label: 'Splits targeting adult antennal lobe projection neuron DA1 lPN', count: 4 },
    { query: 'SubclassesOf', label: 'Subclasses of adult antennal lobe projection neuron DA1 lPN', count: 0 },
    { query: 'UpstreamClassConnectivity', label: 'Upstream connectivity classes', count: 312 }
  ],
  IsIndividual: false,
  IsClass: true
}

function ledgerWithIndividual (queryType = 'SplitsTargeting') {
  const ledger = createLedger('which split-GAL4 lines target this neuron?')
  addTerm(ledger, 'DA1_lPN', {
    id: 'VFB_fw004661',
    label: 'DA1_lPN',
    info: INDIVIDUAL_RECORD,
    kind: 'individual',
    parents: [{ id: 'FBbt_00067363', label: 'adult antennal lobe projection neuron DA1 lPN' }],
    digest: { id: 'VFB_fw004661', name: 'DA1_lPN', queries: [{ query_type: 'SimilarMorphologyTo' }, { query_type: 'NeuronNeuronConnectivityQuery' }] },
    attempted: true
  })
  setPlan(ledger, { steps: [{ id: 's1', tool: 'vfb_run_query', args: { id: 'VFB_fw004661', query_type: queryType }, answers: ['which splits'] }] })
  return ledger
}

function depsReturning (record, calls = []) {
  return {
    runTool: async (tool, args) => {
      calls.push({ tool, args })
      if (tool !== 'vfb_get_term_info') throw new Error('unexpected tool ' + tool)
      return JSON.stringify({ [args.id]: record })
    }
  }
}

test('a type-level query asked of an individual is asked of its type instead', async () => {
  const calls = []
  const ledger = ledgerWithIndividual('SplitsTargeting')
  await liftStepsToOfferingType(ledger, depsReturning(CLASS_RECORD, calls))

  const step = ledger.plan[0]
  assert.equal(step.args.id, 'FBbt_00067363', 'the step should now target the type')
  assert.equal(step.status, 'pending', 'the step is retargeted, not withdrawn')
  assert.deepEqual(calls.map(c => c.args.id), ['FBbt_00067363'])
  assert.deepEqual(step.type_lift, {
    fromId: 'VFB_fw004661',
    fromLabel: 'DA1_lPN',
    toId: 'FBbt_00067363',
    toLabel: 'adult antennal lobe projection neuron DA1 lPN',
    query_type: 'SplitsTargeting'
  })
})

test('the type is registered as a real resolved term, not a silent substitution', async () => {
  const ledger = ledgerWithIndividual('SplitsTargeting')
  await liftStepsToOfferingType(ledger, depsReturning(CLASS_RECORD))

  const parent = ledger.terms['adult antennal lobe projection neuron DA1 lPN']
  assert.ok(parent, 'the type should be on the ledger so links and chips can use it')
  assert.equal(parent.id, 'FBbt_00067363')
  assert.equal(parent.kind, 'class')
  assert.deepEqual(parent.liftedFrom, { id: 'VFB_fw004661', label: 'DA1_lPN' })
  // ...and linkable, so the answer can name the type rather than an id.
  const registered = Object.values(ledger.registry).find(r => r.id === 'FBbt_00067363')
  assert.ok(registered, 'the type must be in the link registry')
})

test('a query the individual DOES offer is left exactly where it is', async () => {
  const calls = []
  const ledger = ledgerWithIndividual('SimilarMorphologyTo')
  await liftStepsToOfferingType(ledger, depsReturning(CLASS_RECORD, calls))
  assert.equal(ledger.plan[0].args.id, 'VFB_fw004661')
  assert.equal(ledger.plan[0].type_lift, undefined)
  assert.equal(calls.length, 0, 'no lookup should be spent when the term can already answer')
})

test('a class that lacks a query is not lifted — it genuinely lacks it', async () => {
  const calls = []
  const ledger = createLedger('what is downstream of the lateral horn?')
  addTerm(ledger, 'adult lateral horn', {
    id: 'FBbt_00007053',
    label: 'adult lateral horn',
    kind: 'region',
    parents: [{ id: 'FBbt_00003624', label: 'adult brain' }],
    digest: { id: 'FBbt_00007053', name: 'adult lateral horn', queries: [{ query_type: 'NeuronsPartHere' }] },
    attempted: true
  })
  setPlan(ledger, { steps: [{ id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_00007053', query_type: 'DownstreamClassConnectivity' }, answers: ['x'] }] })
  await liftStepsToOfferingType(ledger, depsReturning(CLASS_RECORD, calls))
  assert.equal(ledger.plan[0].args.id, 'FBbt_00007053')
  assert.equal(calls.length, 0, 'a region is not an instance of anything worth climbing to')
})

test('the type is not used when it does not offer the query either', async () => {
  const ledger = ledgerWithIndividual('anatScRNAseqQuery')
  await liftStepsToOfferingType(ledger, depsReturning(CLASS_RECORD))
  assert.equal(ledger.plan[0].args.id, 'VFB_fw004661', 'no lift when the type cannot answer either')
  assert.equal(ledger.plan[0].type_lift, undefined)
})

test('a failed lookup degrades quietly and changes nothing', async () => {
  const ledger = ledgerWithIndividual('SplitsTargeting')
  await liftStepsToOfferingType(ledger, { runTool: async () => { throw new Error('MCP down') } })
  assert.equal(ledger.plan[0].args.id, 'VFB_fw004661')
  assert.equal(ledger.plan[0].type_lift, undefined)
})

test('lookups are capped so a bad plan cannot fan out', async () => {
  const calls = []
  const ledger = createLedger('lots of type questions')
  const mkIndividual = (n) => {
    addTerm(ledger, `ind${n}`, {
      id: `VFB_fw00000${n}`,
      label: `ind${n}`,
      kind: 'individual',
      parents: [{ id: `FBbt_0000000${n}`, label: `class${n}` }],
      digest: { id: `VFB_fw00000${n}`, name: `ind${n}`, queries: [{ query_type: 'SimilarMorphologyTo' }] },
      attempted: true
    })
  }
  ;[1, 2, 3, 4, 5].forEach(mkIndividual)
  setPlan(ledger, { steps: [1, 2, 3, 4, 5].map(n => ({
    id: `s${n}`, tool: 'vfb_run_query', args: { id: `VFB_fw00000${n}`, query_type: 'SplitsTargeting' }, answers: ['x']
  })) })
  await liftStepsToOfferingType(ledger, {
    runTool: async (tool, args) => {
      calls.push(args.id)
      return JSON.stringify({ [args.id]: { ...CLASS_RECORD, Id: args.id, Name: `class ${args.id}` } })
    }
  })
  assert.ok(calls.length <= 2, `expected at most 2 lookups, made ${calls.length}`)
})
