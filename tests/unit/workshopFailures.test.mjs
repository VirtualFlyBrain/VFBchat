// Regression tests for the four defects found by running the NeuroFly 2026
// workshop's no-code prompts against the live client (1 of 11 answered).
//
// Every fixture below is a REAL /get_term_info payload shape:
//   VFB_fw035286  — a FlyWire DA1 lPN INDIVIDUAL: Images present, its two
//                   queries uncounted (count -1, preview status "pending").
//   FBbt_00067363 — the DA1 lPN CLASS: Examples present (hemibrain, FlyWire,
//                   BANC individuals), all five queries uncounted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTermInfoDigest, digestToText } from '../../lib/termInfoDigest.mjs'
import {
  maybeInjectConnectivityStep, maybeInjectCountQueryStep, pickQueriesByIntent
} from '../../lib/orchestrator.mjs'
import { findLeakedIds, stripLeakedIds, collectGroundedIds } from '../../lib/grounding.mjs'

const pendingQuery = (query, label) => ({
  query, label, count: -1, output_format: 'table',
  preview_results: { status: 'pending', headers: {}, rows: [] }
})

const INDIVIDUAL = {
  Id: 'VFB_fw035286',
  Name: 'DA1_lPN',
  Meta: { Name: '[AL.MB_CA.83 (FlyWire:720575940630066007)](VFB_fw035286)' },
  SuperTypes: ['Entity', 'Individual', 'VFB', 'Neuron', 'Adult', 'Anatomy', 'Cell', 'has_image', 'has_neuron_connectivity', 'NBLAST'],
  Images: {
    VFB_00101567: [{
      id: 'VFB_fw035286', label: 'DA1_lPN',
      thumbnail: 'https://www.virtualflybrain.org/data/VFB/i/fw03/5286/VFB_00101567/thumbnail.png',
      nrrd: 'x.nrrd', obj: 'x.obj', swc: 'x.swc'
    }]
  },
  Examples: {},
  Queries: [
    pendingQuery('SimilarMorphologyTo', 'Neurons with similar morphology to DA1_lPN [NBLAST]'),
    pendingQuery('NeuronNeuronConnectivityQuery', 'Neurons connected to DA1_lPN')
  ]
}

const CLASS = {
  Id: 'FBbt_00067363',
  Name: 'adult antennal lobe projection neuron DA1 lPN',
  Meta: { Name: '[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363)' },
  SuperTypes: ['Entity', 'Class', 'Neuron', 'Adult', 'Anatomy', 'Cell'],
  Images: {},
  Examples: {
    VFB_00101567: [
      { id: 'VFB_jrchjtdb', label: 'DA1_lPN_R', thumbnail: 'https://x/thumbnail.png', obj: 'x.obj' },
      { id: 'VFB_fw035057', label: 'DA1_lPN', thumbnail: 'https://y/thumbnail.png' },
      { id: 'VFB_00106gzu', label: 'BANC_626:720575941416666396', thumbnail: 'https://z/thumbnail.png' }
    ]
  },
  Queries: [
    pendingQuery('ListAllAvailableImages', 'List all available images of DA1_lPN'),
    pendingQuery('TransgeneExpressionHere', 'Transgene expression in DA1_lPN'),
    pendingQuery('DownstreamClassConnectivity', 'Downstream connectivity classes for DA1_lPN'),
    pendingQuery('UpstreamClassConnectivity', 'Upstream connectivity classes for DA1_lPN')
  ]
}

const ledgerFor = (id, info) => ({
  plan: [{ id: 's1', tool: 'vfb_get_term_info', status: 'satisfied' }],
  terms: { [id]: { id, label: info.Name, info, digest: buildTermInfoDigest(info) } }
})

// --- Defect 1: grounded ids were stripped out of the answer -------------------

test('stripLeakedIds keeps ids the user supplied and ids VFB returned', () => {
  const allowed = ['VFB_fw035286']
  assert.equal(
    stripLeakedIds('The VFB ID of VFB_fw035286 is AL.MB_CA.83.', allowed),
    'The VFB ID of VFB_fw035286 is AL.MB_CA.83.')
  assert.equal(
    stripLeakedIds('VFB does not currently hold data on the appearance of VFB_fw035286.', allowed),
    'VFB does not currently hold data on the appearance of VFB_fw035286.')
  // an id the model INVENTED is still removed
  assert.equal(
    stripLeakedIds('Kenyon cell FBbt_00003686 expresses Dop1R1', allowed),
    'Kenyon cell expresses Dop1R1')
  // mixed: keep the grounded one, drop the invented one
  assert.equal(
    stripLeakedIds('VFB_fw035286 resembles FBbt_00003686 closely.', allowed),
    'VFB_fw035286 resembles closely.')
  assert.deepEqual(findLeakedIds('VFB_fw035286 and FBbt_00003686', allowed), ['FBbt_00003686'])
})

test('collectGroundedIds gathers the question id, resolved terms and preview entities', () => {
  const l = ledgerFor('VFB_fw035286', INDIVIDUAL)
  l.registry = { 'da1 lpn': { id: 'FBbt_00067363', label: 'DA1 lPN' } }
  const ids = collectGroundedIds('Show me VFB_00101567 and VFB_fw035286', l)
  assert.ok(ids.includes('VFB_00101567'), 'id typed by the user')
  assert.ok(ids.includes('VFB_fw035286'), 'resolved term id')
  assert.ok(ids.includes('FBbt_00067363'), 'registry id')
})

// --- Defect 2: an individual's display name sent as a class endpoint ----------

test('connectivity on an INDIVIDUAL runs its own query, not the class-level tool', () => {
  const l = ledgerFor('VFB_fw035286', INDIVIDUAL)
  maybeInjectConnectivityStep(l, 'Who does VFB_fw035286 connect to most strongly?')
  const inj = l.plan.find(s => s.tool === 'vfb_run_query')
  assert.ok(inj, 'a run_query step should be injected for an individual')
  // limit 0 because the partner rows come back in label order, so ranking by
  // synapse count needs the whole set (runStep sorts and truncates in code).
  assert.deepEqual(inj.args, { id: 'VFB_fw035286', query_type: 'NeuronNeuronConnectivityQuery', limit: 0 })
  assert.equal(inj.connectivity_query, true)
  assert.equal(l.plan.some(s => s.tool === 'vfb_find_connectivity_partners'), false,
    'the class-level tool must not receive an individual display name')
})

test('connectivity on a CLASS still uses the partner tool, with the accession stripped', () => {
  const l = {
    plan: [],
    terms: { x: { id: 'FBbt_X', label: 'giant fiber neuron', digest: { name: 'giant fiber neuron (FlyEM-HB:1234)' }, info: { SuperTypes: ['Class', 'Neuron'] } } }
  }
  maybeInjectConnectivityStep(l, 'what does the giant fiber neuron connect to downstream?')
  const inj = l.plan.find(s => s.tool === 'vfb_find_connectivity_partners')
  assert.ok(inj)
  assert.equal(inj.args.endpoint_type, 'giant fiber neuron')
})

// --- Defect 3: uncounted queries never ran unless the question said "how many" -

test('pickQueriesByIntent routes non-count questions to the right query kind', () => {
  const cd = buildTermInfoDigest(CLASS)
  const id = buildTermInfoDigest(INDIVIDUAL)
  assert.deepEqual(pickQueriesByIntent('Where do I find DA1 lPN, and which connectomes have them?', cd)
    .map(q => q.query_type), ['ListAllAvailableImages'])
  assert.deepEqual(pickQueriesByIntent('What neurons look most similar to this one?', id)
    .map(q => q.query_type), ['SimilarMorphologyTo'])
  assert.deepEqual(pickQueriesByIntent('What transgene expression is reported here?', cd)
    .map(q => q.query_type), ['TransgeneExpressionHere'])
  // connectivity direction disambiguates the two class-level queries
  assert.deepEqual(pickQueriesByIntent('what is upstream of DA1 lPN?', cd)
    .map(q => q.query_type), ['UpstreamClassConnectivity'])
  // no intent match → nothing
  assert.deepEqual(pickQueriesByIntent('what is a DA1 lPN?', cd), [])
})

test('maybeInjectCountQueryStep runs an uncounted query for a NON-count question', () => {
  const l = ledgerFor('FBbt_00067363', CLASS)
  maybeInjectCountQueryStep(l, 'Where do I find DA1 lPN neurons in VFB, and which connectomes have them?')
  const inj = l.plan.find(s => s.tool === 'vfb_run_query')
  assert.ok(inj, 'the image query must be run — the digest says "run this query"')
  assert.equal(inj.args.query_type, 'ListAllAvailableImages')
  assert.notEqual(inj.count_query, true, 'not a count question — no deterministic count metadata')
})

test('maybeInjectCountQueryStep leaves ALREADY-COUNTED queries alone', () => {
  const counted = JSON.parse(JSON.stringify(CLASS))
  counted.Queries[0] = { query: 'ListAllAvailableImages', label: 'List all available images of DA1_lPN', count: 68, preview_results: { status: 'complete', rows: [] } }
  const l = ledgerFor('FBbt_00067363', counted)
  maybeInjectCountQueryStep(l, 'Where do I find DA1 lPN neurons in VFB?')
  assert.equal(l.plan.some(s => s.tool === 'vfb_run_query'), false,
    'a resolved count is already in the digest — no tool round needed')
})

// --- Defect 4: registered images were never surfaced -------------------------

test('the digest surfaces an individual\'s registered images', () => {
  const d = buildTermInfoDigest(INDIVIDUAL)
  assert.equal(d.images.length, 1)
  assert.equal(d.images[0].id, 'VFB_fw035286')
  assert.equal(d.images[0].template, 'VFB_00101567')
  assert.deepEqual(d.images[0].formats, ['obj', 'swc', 'nrrd'])
  const text = digestToText(d)
  assert.match(text, /Registered images VFB holds for this term/)
  assert.match(text, /thumbnail\.png/)
})

test('the digest surfaces a class\'s example individuals, naming the connectomes', () => {
  const d = buildTermInfoDigest(CLASS)
  assert.equal(d.images.length, 3)
  const text = digestToText(d)
  // the hemibrain / FlyWire / BANC individuals ARE the answer to "which
  // connectomes have them" — they were previously dropped entirely
  for (const id of ['VFB_jrchjtdb', 'VFB_fw035057', 'VFB_00106gzu']) assert.ok(text.includes(id), id)
})
