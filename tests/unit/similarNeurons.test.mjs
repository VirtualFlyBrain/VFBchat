// Morphological similarity (NBLAST): the two-hop recipe, the deterministic
// claim, and the routing that used to answer the question with a catalogue.
//
// Fixtures are real shapes from v3-cached:
//   run_query?query_type=ListAllAvailableImages&id=FBbt_00111763
//   run_query?query_type=SimilarMorphologyTo&id=VFB_jrchk06p

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  pickSeedIndividuals, parseSimilarityHits, groupSimilarByClass, summariseSimilarity
} from '../../lib/similarNeurons.mjs'
import { parseMarkdownLinks } from '../../lib/markdownLinks.mjs'
import { pickQueriesByIntent, maybeInjectSimilarityStep } from '../../lib/orchestrator.mjs'
import { createLedger, addTerm } from '../../lib/ledger.mjs'

const LPLC2 = 'FBbt_00111763'
const LPLC2_LABEL = 'lobula plate-lobula columnar neuron LPLC2'
const LC4 = 'FBbt_00003874'
const VPND1 = 'FBbt_00050108'

const IMAGES = {
  count: 723,
  rows: [
    { id: 'VFB_jrmc23ut', label: `[LPLC2_L (MaleCNS:20799)](VFB_jrmc23ut)`, parent: `[${LPLC2_LABEL}](${LPLC2})` },
    { id: 'VFB_jrmc23us', label: `[LPLC2_L (MaleCNS:32737)](VFB_jrmc23us)`, parent: `[${LPLC2_LABEL}](${LPLC2})` },
    // A row typed as something else entirely — a poor seed for "similar to LPLC2".
    { id: 'VFB_zzz00001', label: '[LC4_R (FlyEM-HB:1)](VFB_zzz00001)', parent: `[lobula columnar neuron LC4](${LC4})` },
    { id: 'VFB_jrmc23ur', label: `[LPLC2_L (MaleCNS:23349)](VFB_jrmc23ur)`, parent: `[${LPLC2_LABEL}](${LPLC2})` }
  ]
}

const SIMILAR = {
  count: 131,
  rows: [
    // The seed comes back in its own result set, top of the list.
    { id: 'VFB_jrchk06p', name: '[LPLC2_R (FlyEM-HB:1)](VFB_jrchk06p)', score: '1.0', type: `[${LPLC2_LABEL}](${LPLC2})` },
    { id: 'VFB_jrchk05g', name: '[LPLC2_R (FlyEM-HB:1814777260)](VFB_jrchk05g)', score: '0.8', type: `[${LPLC2_LABEL}](${LPLC2})` },
    // Two classes in one cell: a cell type AND its lineage.
    { id: 'VFB_fw005582', name: '[LOP.PVLP.47 (FlyWire:720575940612462307)](VFB_fw005582)', score: '0.62', type: `[${LPLC2_LABEL}](${LPLC2}); [adult VPNd1 lineage neuron](${VPND1})` },
    { id: 'VFB_jrchk0aa', name: '[LC4 (FlyEM-HB:2)](VFB_jrchk0aa)', score: '0.46', type: `[lobula columnar neuron LC4](${LC4})` },
    { id: 'VFB_jrchk0bb', name: '[LC4 (FlyEM-HB:3)](VFB_jrchk0bb)', score: '0.41', type: `[lobula columnar neuron LC4](${LC4})` },
    // A row with no usable score is dropped, not coerced to zero.
    { id: 'VFB_jrchk0cc', name: '[LPLC1 (FlyEM-HB:4)](VFB_jrchk0cc)', score: '', type: `[lobula plate-lobula columnar neuron LPLC1](FBbt_00111762)` }
  ]
}

// ------------------------------------------------------------------ hop 1 ---

test('seeds are the class\'s own registered individuals', () => {
  const seeds = pickSeedIndividuals(IMAGES, { classId: LPLC2, cap: 3 })
  assert.deepEqual(seeds.map(s => s.id), ['VFB_jrmc23ut', 'VFB_jrmc23us', 'VFB_jrmc23ur'])
  assert.equal(seeds[0].label, 'LPLC2_L (MaleCNS:20799)')
})

test('seeds spread ACROSS datasets rather than taking the top of the list', () => {
  // The defect this catches made the tool answer "no similarity data for LPLC2".
  // NBLAST registration is per-dataset (MaleCNS/Berg2025 and BANC have none),
  // ListAllAvailableImages returns rows grouped by dataset, and MaleCNS sorts
  // first — so the first three rows are three neurons that cannot be scored.
  const grouped = {
    rows: [
      ...['a1', 'a2', 'a3', 'a4'].map(n => ({
        id: `VFB_${n}`, label: `[${n}](VFB_${n})`, parent: `[${LPLC2_LABEL}](${LPLC2})`,
        dataset: '[Male CNS version 0.9](Berg2025)'
      })),
      { id: 'VFB_b1', label: '[b1](VFB_b1)', parent: `[${LPLC2_LABEL}](${LPLC2})`, dataset: '[JRC_FlyEM_Hemibrain](Xu2020)' },
      { id: 'VFB_c1', label: '[c1](VFB_c1)', parent: `[${LPLC2_LABEL}](${LPLC2})`, dataset: '[FlyWire connectome neurons](Dorkenwald2023)' }
    ]
  }
  const seeds = pickSeedIndividuals(grouped, { classId: LPLC2, cap: 3 })
  assert.deepEqual(seeds.map(s => s.id), ['VFB_a1', 'VFB_b1', 'VFB_c1'])
  assert.equal(seeds[1].dataset, 'JRC_FlyEM_Hemibrain', 'the dataset travels with the seed, to name in a no-data note')
})

test('a class held in one dataset still yields seeds', () => {
  const one = { rows: ['x1', 'x2'].map(n => ({ id: `VFB_${n}`, label: `[${n}](VFB_${n})`, dataset: '[Only one](D1)' })) }
  assert.deepEqual(pickSeedIndividuals(one, { cap: 3 }).map(s => s.id), ['VFB_x1', 'VFB_x2'])
})

test('an individual typed as another class is not seeded from', () => {
  const seeds = pickSeedIndividuals(IMAGES, { classId: LPLC2, cap: 10 })
  assert.ok(!seeds.some(s => s.id === 'VFB_zzz00001'), JSON.stringify(seeds))
})

test('no images means no seeds, so the caller can say so rather than guess', () => {
  assert.deepEqual(pickSeedIndividuals({ count: 0, rows: [] }, { classId: LPLC2 }), [])
  assert.deepEqual(pickSeedIndividuals(null, { classId: LPLC2 }), [])
})

// ------------------------------------------------------------------ hop 2 ---

test('hits carry a numeric score and every class named in the type cell', () => {
  const hits = parseSimilarityHits(SIMILAR, { seed: { id: 'VFB_jrchk06p' } })
  assert.equal(hits.length, 5, 'the unscored row is dropped')
  assert.equal(hits[1].score, 0.8)
  assert.equal(hits[1].name, 'LPLC2_R (FlyEM-HB:1814777260)')
  assert.deepEqual(hits[2].classes.map(c => c.target), [LPLC2, VPND1])
})

test('a type cell holding several classes is split on the links, not on ";"', () => {
  // A label may contain a semicolon; splitting on one would invent a class.
  const cell = `[alpha/beta; posterior Kenyon cell](FBbt_00110945); [adult VPNd1 lineage neuron](${VPND1})`
  assert.deepEqual(parseMarkdownLinks(cell).map(c => c.text),
    ['alpha/beta; posterior Kenyon cell', 'adult VPNd1 lineage neuron'])
})

// --------------------------------------------------------------- grouping ---

test('the self-class is reported separately, never dropped and never mixed in', () => {
  // 69 of LPLC2's top 100 neighbours are LPLC2. Filtering that out would make LC4
  // look like the top match; merging it in would bury the other cell types.
  const hits = parseSimilarityHits(SIMILAR)
  const g = groupSimilarByClass(hits, { focusId: LPLC2, seedIds: ['VFB_jrchk06p'] })
  assert.equal(g.self.id, LPLC2)
  assert.equal(g.self.neurons, 2, 'the seed itself is excluded from its own result')
  assert.deepEqual(g.others.map(x => x.id), [VPND1, LC4])
  assert.equal(g.others[1].neurons, 2)
  assert.equal(g.others[1].bestScore, 0.46)
})

test('groups sort by best score, not by how many neurons carry the type', () => {
  const g = groupSimilarByClass(parseSimilarityHits(SIMILAR), { focusId: LPLC2, seedIds: [] })
  assert.ok(g.others[0].bestScore >= g.others[1].bestScore)
})

test('a neuron reached from two seeds is counted once', () => {
  const hits = [
    ...parseSimilarityHits(SIMILAR, { seed: { id: 'VFB_a' } }),
    ...parseSimilarityHits(SIMILAR, { seed: { id: 'VFB_b' } })
  ]
  const g = groupSimilarByClass(hits, { focusId: LPLC2, seedIds: [] })
  assert.equal(g.neurons, 5, 'de-duplicated by neuron id across seeds')
})

// ------------------------------------------------------------------ claim ---

function payload() {
  const hits = parseSimilarityHits(SIMILAR)
  const g = groupSimilarByClass(hits, { focusId: LPLC2, seedIds: ['VFB_jrchk06p'] })
  return {
    tool: 'vfb_find_similar_neurons',
    resolved: { id: LPLC2, label: LPLC2_LABEL },
    seed_neurons: [{ id: 'VFB_jrmc23ut', label: 'LPLC2_L (MaleCNS:20799)' }],
    neurons_compared: g.neurons,
    self_class: g.self,
    similar_classes: g.others
  }
}

test('the claim names the similar cell types with their scores', () => {
  const { claim, rows } = summariseSimilarity(payload())
  assert.match(claim, /lobula columnar neuron LC4 \(FBbt_00003874\)/)
  assert.match(claim, /best score 0\.46/)
  assert.deepEqual(rows.map(r => r.id), [VPND1, LC4])
})

test('the claim says the similarity was computed per neuron, not per class', () => {
  // Without this, "LPLC2 resembles LC4" reads as a property of the class, which
  // is not what VFB measured — there is no class-level NBLAST.
  const { claim } = summariseSimilarity(payload())
  assert.match(claim, /computed per registered neuron, not per class/)
  assert.match(claim, /LPLC2_L \(MaleCNS:20799\)/, 'the seed it actually came from is named')
  // …by NAME, not by id. The synthesiser is told never to write an ontology id,
  // so an id in the claim is stripped, and stripping it took the seed's name with
  // it — leaving the class link standing where the individual should have been.
  assert.ok(!/VFB_jrmc23ut/.test(claim), claim)
})

test('the method qualifier LEADS the claim so it cannot be compressed off the end', () => {
  // It was written as a trailing clause and the synthesiser dropped it outright,
  // publishing the scores with no indication they came from three neurons. A
  // qualifier in the first sentence is one the summary has to carry.
  const { claim } = summariseSimilarity(payload())
  assert.match(claim.split('. ')[0], /computed per registered neuron, not per class/)
})

test('the claim reports the self-class rather than hiding it', () => {
  const { claim } = summariseSimilarity(payload())
  assert.match(claim, /are themselves lobula plate-lobula columnar neuron LPLC2/)
})

test('asked about an INDIVIDUAL, the claim drops the per-class caveat', () => {
  // "measured from the registered neuron LPLC2_R rather than from LPLC2_R as a
  // whole" is gibberish — and it misled the synthesiser into reading the 100
  // neighbours as 100 seed neurons. When the query IS an individual, the
  // per-neuron computation is exactly what was asked for.
  const p = payload()
  p.resolved = { id: 'VFB_jrchk06p', label: 'LPLC2_R (FlyEM-HB:1722342048)' }
  p.seed_neurons = [{ id: 'VFB_jrchk06p', label: 'LPLC2_R (FlyEM-HB:1722342048)' }]
  const { claim } = summariseSimilarity(p)
  assert.ok(!/as a whole/.test(claim), claim)
  assert.ok(!/computed per registered neuron, not per class/.test(claim), claim)
  assert.match(claim.split('. ')[0], /NBLAST scores against the registered neuron LPLC2_R/)
})

test('a payload with nothing to report returns null so the caller can fall through', () => {
  assert.equal(summariseSimilarity(null), null)
  assert.equal(summariseSimilarity({ resolved: { id: LPLC2 } }), null)
  assert.equal(summariseSimilarity({ resolved: { id: LPLC2 }, similar_classes: [], self_class: null }), null)
})

// ---------------------------------------------------------------- routing ---

const CLASS_DIGEST = {
  name: LPLC2_LABEL,
  queries: [
    { query_type: 'SubclassesOf', label: 'Subclasses of LPLC2', countKind: 'unknown' },
    { query_type: 'ListAllAvailableImages', label: 'Images of LPLC2', countKind: 'unknown' },
    { query_type: 'NeuronsPartOf', label: 'Neurons with part in LPLC2', countKind: 'unknown' }
  ]
}

test('a similarity question never falls through to a taxonomy query', () => {
  // This is the defect: no similarity query exists on a class, the rule
  // `continue`d, and the broad class_list rule matched "what neurons" and would
  // have run SubclassesOf. Answering a morphology question with a subclass list
  // is a wrong answer, not a partial one.
  assert.deepEqual(pickQueriesByIntent('What neurons are similar to LPLC2?', CLASS_DIGEST), [])
})

test('an ordinary list question still reaches the class-list rule', () => {
  const picks = pickQueriesByIntent('What neurons are part of LPLC2?', CLASS_DIGEST)
  assert.ok(picks.length <= 1)
})

function neuronLedger(q) {
  const l = createLedger(q)
  addTerm(l, 'LPLC2', { id: LPLC2, label: LPLC2_LABEL, info: { SuperTypes: ['Neuron', 'Class'] } })
  return l
}

test('a similarity question injects the NBLAST step', () => {
  const l = neuronLedger('What neurons are similar to LPLC2?')
  maybeInjectSimilarityStep(l, l.question)
  assert.equal(l.plan.length, 1)
  assert.equal(l.plan[0].tool, 'vfb_find_similar_neurons')
  assert.equal(l.plan[0].similarity_query, true)
  assert.deepEqual(l.plan[0].args, { neuron_type: LPLC2 })
})

test('injection is idempotent', () => {
  const l = neuronLedger('Which neurons most closely resemble LPLC2?')
  maybeInjectSimilarityStep(l, l.question)
  maybeInjectSimilarityStep(l, l.question)
  assert.equal(l.plan.length, 1)
})

test('NBLAST and NeuronBridge phrasings all reach the step', () => {
  for (const q of [
    'NBLAST matches for LPLC2?',
    'What does LPLC2 look like most?',
    'Which cell types are morphologically similar to LPLC2?',
    'Show me the closest match to LPLC2'
  ]) {
    const l = neuronLedger(q)
    maybeInjectSimilarityStep(l, l.question)
    assert.equal(l.plan.length, 1, q)
  }
})

test('a homology question is not routed to NBLAST', () => {
  // "the larval equivalent of X" is a homology question; NBLAST does not answer
  // it, and three tool rounds spent to say so is three wasted rounds.
  const l = neuronLedger('What is the larval equivalent of LPLC2?')
  maybeInjectSimilarityStep(l, l.question)
  assert.equal(l.plan.length, 0)
})

test('a non-neuron term is not routed to NBLAST', () => {
  // NBLAST compares neuron skeletons; a neuropil has none.
  const l = createLedger('What regions are similar to the medulla?')
  addTerm(l, 'medulla', { id: 'FBbt_00003748', label: 'medulla', info: { SuperTypes: ['Anatomy', 'Synaptic_neuropil'] } })
  maybeInjectSimilarityStep(l, l.question)
  assert.equal(l.plan.length, 0)
})
