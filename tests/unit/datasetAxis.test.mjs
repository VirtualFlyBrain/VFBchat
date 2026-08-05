// The dataset axis, against the two payloads the workshop questions actually hit.
//
// The fixtures are real v3-cached responses, trimmed to the columns the axis
// reads: ListAllAvailableImages for the class DA1 lPN (FBbt_00067363, 68 rows)
// and SimilarMorphologyTo for the FlyWire individual VFB_fw035286 (64 rows). The
// numbers asserted here — 68 distinct individuals summing to 91 across 8
// datasets, 15 of them multiply annotated in 2 to 4 FAFB tracing datasets — are
// the ground truth those questions have to be answered against, so a change that
// silently alters them should fail here rather than in front of a workshop room.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  parseDatasetCell,
  rowDatasets,
  groupRowsByDataset,
  summariseDatasetBreakdown,
  datasetAsked,
  isDatasetBreakdownQuestion,
  matchesDataset,
  rowMatchesDataset,
  groupHitsByDataset,
  bestHitInDataset,
  withoutDatasetSenseConnectome
} from '../../lib/datasetAxis.mjs'
import { parseSimilarityHits, summariseSimilarity } from '../../lib/similarNeurons.mjs'
import { parseMarkdownLinks } from '../../lib/markdownLinks.mjs'
import { parseTableRow } from '../../lib/termInfoDigest.mjs'
import { queryRelevanceScore, labelOverlapScore, listQueryWords, stemWord, KIND_MATCH_WEIGHT } from '../../lib/queryRelevance.mjs'
import { questionKinds } from '../../lib/queryTypes.mjs'
import { runHarness, maybeInjectConnectivityStep } from '../../lib/orchestrator.mjs'
import { createLedger, addTerm } from '../../lib/ledger.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const LAI = fixture('listAllAvailableImages_DA1lPN.json')
const SIM = fixture('similarMorphologyTo_VFB_fw035286.json')

const FAFB_MULTI = '[EM FAFB Taisz and Galili et al., 2022](TaiszGalili2022), [EM FAFB Baltruschat et al 2021](Baltruschat2021), [EM FAFB Zheng et al 2018](Zheng2018), [EM FAFB Bates and Schlegel et al 2020](BatesSchlegel2020)'

// --- the cell ---------------------------------------------------------------

test('a multi-valued dataset cell parses as several datasets, not as one blob', () => {
  const got = parseDatasetCell(FAFB_MULTI)
  assert.equal(got.length, 4)
  assert.deepEqual(got.map(d => d.id), ['TaiszGalili2022', 'Baltruschat2021', 'Zheng2018', 'BatesSchlegel2020'])
  assert.equal(got[0].label, 'EM FAFB Taisz and Galili et al., 2022')
})

test('a single-link cell parses as one dataset', () => {
  const got = parseDatasetCell('[Male CNS version 0.9 connectome neurons from Berg et al. (2025).](Berg2025)')
  assert.deepEqual(got.map(d => d.id), ['Berg2025'])
})

test('a cell VFB names but does not link is kept, not dropped', () => {
  assert.deepEqual(parseDatasetCell('Some unlinked dataset'), [{ label: 'Some unlinked dataset', id: '' }])
  assert.deepEqual(parseDatasetCell(''), [])
})

test('rowDatasets falls back to `source` when there is no dataset column', () => {
  // SimilarMorphologyTo's shape: the dataset signal lives in `source`.
  assert.deepEqual(rowDatasets({ source: '[FlyWire web interface v783](flywire783)' }).map(d => d.id), ['flywire783'])
  // ...and `dataset` wins where both are present.
  assert.deepEqual(rowDatasets({ dataset: '[a](Berg2025)', source: '[b](flywire783)' }).map(d => d.id), ['Berg2025'])
})

// --- the breakdown ----------------------------------------------------------

test('DA1 lPN groups into 8 datasets over 68 distinct individuals', () => {
  const g = groupRowsByDataset(LAI)
  assert.equal(g.total, 68)
  assert.equal(g.datasets.length, 8)
  assert.deepEqual(
    g.datasets.map(d => [d.id, d.count]),
    [
      ['Bates2025', 18],
      ['BatesSchlegel2020', 15],
      ['TaiszGalili2022', 15],
      ['Dorkenwald2023', 15],
      ['Berg2025', 13],
      ['Zheng2018', 7],
      ['Xu2020NeuronsV1point2point1', 7],
      ['Baltruschat2021', 1]
    ]
  )
})

test('the per-dataset counts sum to more than the total, and the overlap explains exactly how much', () => {
  const g = groupRowsByDataset(LAI)
  assert.equal(g.sum, 91)
  assert.equal(g.multiDataset, 15)
  const overlapping = g.clusters.filter(c => c.datasets.length > 1)
  assert.equal(overlapping.length, 1, 'the four FAFB tracing datasets are one connected component')
  assert.equal(overlapping[0].datasets.length, 4)
  assert.equal(overlapping[0].individuals, 15)
  // NOT "all four" — the distribution is {2:8, 3:6, 4:1}, and claiming all four
  // is an overstatement the reader can falsify in one click.
  assert.deepEqual(overlapping[0].spread, { min: 2, max: 4 })
})

test('an individual registered against several templates is counted once', () => {
  const payload = {
    rows: [
      { id: 'VFB_a', label: 'n1', dataset: '[D1](D1)', template: '[JRC2018U](VFB_00101567)' },
      { id: 'VFB_a', label: 'n1', dataset: '[D1](D1)', template: '[JFRC2](VFB_00101384)' },
      { id: 'VFB_b', label: 'n2', dataset: '[D1](D1)' }
    ]
  }
  const g = groupRowsByDataset(payload)
  assert.equal(g.total, 2)
  assert.equal(g.datasets[0].count, 2)
})

test('the breakdown claim states the total, every dataset, and why the figures do not sum', () => {
  const s = summariseDatasetBreakdown(LAI, { label: 'DA1 lPN' })
  assert.equal(s.total, 68)
  assert.match(s.claim, /VFB holds 68 registered individuals of DA1 lPN/)
  assert.match(s.claim, /Male CNS version 0\.9 connectome neurons from Berg et al\. \(2025\)\. — 13/)
  assert.match(s.claim, /do not sum to 68 \(they total 91\)/)
  assert.match(s.claim, /each annotated in 2 to 4 of them/)
  // Every dataset the data holds is named, so "which connectomes have them"
  // (W1.C, answered in 3.9.2 with MaleCNS alone) cannot be answered short.
  for (const label of ['BANC', 'FlyWire', 'FAFB', 'Hemibrain', 'Male CNS']) {
    assert.ok(s.claim.includes(label), `claim should name ${label}`)
  }
})

test('the breakdown carries the individuals W1.B asks to list, with their datasets', () => {
  const s = summariseDatasetBreakdown(LAI, { label: 'DA1 lPN' })
  assert.equal(s.individuals.length, 68)
  const one = s.individuals.find(i => i.id === 'VFB_jrmc37ha')
  assert.ok(one, 'a known MaleCNS DA1 lPN individual is listed')
  assert.equal(one.label, 'DA1_lPN_L (MaleCNS:12314)', 'the label is unwrapped, not raw markdown')
  assert.deepEqual(one.datasets, ['Male CNS version 0.9 connectome neurons from Berg et al. (2025).'])
  const multi = s.individuals.filter(i => i.datasets.length > 1)
  assert.equal(multi.length, 15)
})

test('a payload with no dataset information yields no claim rather than an empty one', () => {
  assert.equal(summariseDatasetBreakdown({ rows: [] }), null)
  assert.equal(summariseDatasetBreakdown({ rows: [{ id: 'VFB_a', label: 'n' }] }), null)
})

test('a single-dataset breakdown says nothing about overlap', () => {
  const s = summariseDatasetBreakdown({ rows: [{ id: 'VFB_a', dataset: '[D1](D1)' }, { id: 'VFB_b', dataset: '[D1](D1)' }] }, { label: 'X' })
  assert.match(s.claim, /VFB holds 2 registered individuals of X/)
  assert.ok(!/do not sum/.test(s.claim))
})

// --- the question side ------------------------------------------------------

test('a named dataset behind a locative preposition beats one that merely describes the input', () => {
  // W2.B names FlyWire first and hemibrain second; the hemibrain is what is
  // being asked FOR. Taking the first mention is how 3.9.2 answered with the
  // FlyWire query neuron itself.
  const w2b = datasetAsked("Here's a FlyWire neuron VFB_fw035286. Find the morphologically closest neuron in the hemibrain and tell me if they're annotated as the same type.")
  assert.equal(w2b.key, 'hemibrain')
  assert.equal(w2b.locative, true)
})

test('W2.C resolves to the hemibrain even though neither mention is locative', () => {
  // "Is there a HEMIBRAIN equivalent OF FLYWIRE neuron ...". "of" is excluded
  // from the locative set precisely so this falls through to earliest-mention,
  // which here is the right answer.
  assert.equal(datasetAsked('Is there a hemibrain equivalent of FlyWire neuron VFB_fw035286, and do they share a cell type?').key, 'hemibrain')
})

test('a question naming no dataset asks for no filter', () => {
  assert.equal(datasetAsked('How many DA1 lPN neurons does VFB hold in each connectome dataset?'), null)
  assert.equal(datasetAsked('Where do I find DA1 lPN neurons in VFB, and which connectomes have them?'), null)
  assert.equal(datasetAsked('What neurons look most similar to LPLC2?'), null)
  assert.equal(datasetAsked(''), null)
})

test('the four dataset-axis workshop questions all register as breakdown questions', () => {
  for (const q of [
    'How many DA1 lPN neurons does VFB hold in each connectome dataset?',
    'Where do I find DA1 lPN neurons in VFB, and which connectomes have them?',
    'Search VFB for the neuron type DA1 lPN and list every individual neuron across all datasets, with their dataset and VFB ID.',
    'Run an NBLAST similarity query for neuron VFB_fw035286 and tell me the top hits, their scores, and which datasets they come from.'
  ]) assert.ok(isDatasetBreakdownQuestion(q), q)
})

test('questions that are not about the dataset axis are not treated as breakdowns', () => {
  for (const q of [
    'Show me what neuron VFB_jrchjtdb looks like.',
    'What are the main synaptic partners of Kenyon cells?',
    'What genes are expressed in Kenyon cells?'
  ]) assert.ok(!isDatasetBreakdownQuestion(q), q)
})

test('a dataset filter matches on label or id, whichever carries the common name', () => {
  const hemibrain = datasetAsked('closest neuron in the hemibrain')
  // "Hemibrain" is in Xu2020's label...
  assert.ok(matchesDataset('JRC_FlyEM_Hemibrain neurons Version 1.2.1 Xu2020NeuronsV1point2point1', hemibrain))
  // ...and in neuprint's id.
  assert.ok(matchesDataset('Neuprint web interface - hemibrain:v1.2.1 neuprint_JRC_Hemibrain_1point2point1', hemibrain))
  assert.ok(!matchesDataset('FlyWire connectome neurons Dorkenwald2023', hemibrain))
  // No filter is not the same as a filter that matches nothing.
  assert.ok(matchesDataset('anything at all', null))
})

test('a row matches its dataset through the label when it is registered via a third party', () => {
  const hemibrain = datasetAsked('in the hemibrain')
  const row = { id: 'VFB_x', label: '[DA1_lPN_R (FlyEM-HB:754534424)](VFB_x)', source: '[NeuronBridge](neuronbridge)', dataset: '' }
  assert.ok(rowMatchesDataset(row, hemibrain), 'FlyEM-HB in the label is the tag that survives')
})

// --- similarity hits --------------------------------------------------------

const hits = parseSimilarityHits(SIM)

test('similarity hits carry the source their dataset lives in', () => {
  assert.equal(hits.length, 64)
  const fw = hits.find(h => h.id === 'VFB_fw013615')
  assert.equal(fw.source, 'FlyWire web interface v783')
  assert.equal(fw.sourceId, 'flywire783')
})

test('the neighbours group into four datasets, best score first', () => {
  const byDataset = groupHitsByDataset(hits)
  assert.deepEqual(
    byDataset.map(d => [d.id, d.count, d.bestScore]),
    [
      ['flywire783', 30, 0.79],
      ['catmaid_fafb', 4, 0.66],
      ['neuprint_JRC_Hemibrain_1point2point1', 23, 0.64],
      ['FlyCircuit', 7, 0.6]
    ]
  )
  assert.equal(byDataset.reduce((n, d) => n + d.count, 0), 64)
})

test('W2.B: the closest hemibrain neuron is named, scored, and typed against the seed', () => {
  const seedClasses = parseMarkdownLinks('[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363); [adult fruitless aDT-e (female) neuron](FBbt_00110423)')
  const best = bestHitInDataset(hits, datasetAsked('Find the morphologically closest neuron in the hemibrain'), { seedClasses })
  assert.equal(best.hit.id, 'VFB_jrchjtde')
  assert.equal(best.hit.name, 'DA1_lPN_R (FlyEM-HB:754534424)')
  assert.equal(best.hit.score, 0.64)
  assert.equal(best.considered, 23, 'ranked within the hemibrain, not within the whole result set')
  assert.equal(best.seedKnown, true)
  assert.deepEqual(best.sharedClasses.map(c => c.target).sort(), ['FBbt_00067363', 'FBbt_00110423'])
})

test('the seed is not in its own neighbourhood, so its types must come from term-info', () => {
  // The comment in groupSimilarByClass assumed the opposite. If VFB ever starts
  // returning the seed, this test says so rather than the answer quietly gaining
  // a perfect self-match.
  assert.equal(hits.some(h => h.id === 'VFB_fw035286'), false)
})

test('with no seed types known the verdict reports the match type instead of asserting sameness', () => {
  const best = bestHitInDataset(hits, datasetAsked('in the hemibrain'), { seedClasses: [] })
  assert.equal(best.seedKnown, false)
  assert.deepEqual(best.sharedClasses, [])
})

test('bestHitInDataset returns null for a dataset with no neighbours, and for no filter', () => {
  assert.equal(bestHitInDataset(hits, datasetAsked('in the male CNS connectome')), null, 'NBLAST is not registered for Berg2025')
  assert.equal(bestHitInDataset(hits, datasetAsked('in BANC')), null, 'nor for Bates2025')
  assert.equal(bestHitInDataset(hits, null), null)
})

// --- the claim the synthesiser sees -----------------------------------------

const similarityPayload = (extra = {}) => ({
  tool: 'vfb_find_similar_neurons',
  resolved: { id: 'VFB_fw035286', label: 'AL.MB_CA.83 (FlyWire:720575940630066007)' },
  seed_neurons: [{ id: 'VFB_fw035286', label: 'AL.MB_CA.83' }],
  neurons_compared: 64,
  self_class: null,
  similar_classes: [],
  by_dataset: groupHitsByDataset(hits).map(d => ({ id: d.id, label: d.label, count: d.count, bestScore: d.bestScore })),
  ...extra
})

test('W5.B: the similarity claim names which datasets the hits come from, with counts and best scores', () => {
  const s = summariseSimilarity(similarityPayload())
  assert.match(s.claim, /The neighbours come from 4 datasets/)
  assert.match(s.claim, /FlyWire web interface v783 — 30, best score 0\.79/)
  assert.match(s.claim, /Neuprint web interface - hemibrain:v1\.2\.1 — 23, best score 0\.64/)
})

test('W2.B: the asked-for dataset leads the claim and the type verdict is explicit', () => {
  const seedClasses = parseMarkdownLinks('[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363); [adult fruitless aDT-e (female) neuron](FBbt_00110423)')
  const best = bestHitInDataset(hits, datasetAsked('closest neuron in the hemibrain'), { seedClasses })
  const s = summariseSimilarity(similarityPayload({
    requested_dataset: {
      ...best,
      label: 'the hemibrain',
      seedTypes: seedClasses.map(c => c.text),
      hit: { id: best.hit.id, name: best.hit.name, score: best.hit.score, type: best.hit.classes.map(c => c.text).join('; ') }
    }
  }))
  assert.ok(s.claim.startsWith('The closest neuron to'), 'the question leads; the method statement follows')
  assert.match(s.claim, /in the hemibrain is DA1_lPN_R \(FlyEM-HB:754534424\) \(NBLAST score 0\.64\)/)
  assert.match(s.claim, /the best of 23 neighbours returned from that dataset/)
  assert.match(s.claim, /so yes — they are the same type/)
})

test('an empty dataset filter is reported as a finding about the dataset, not silently dropped', () => {
  const s = summariseSimilarity(similarityPayload({
    requested_dataset: { label: 'the male CNS connectome', hit: null, considered: 0, empty: true }
  }))
  assert.match(s.claim, /None of the NBLAST neighbours .* come from the male CNS connectome/)
  assert.match(s.claim, /NBLAST is registered per dataset/)
  // And it must NOT reach for the top of the unfiltered list.
  assert.ok(!/AL\.MB_CA\.133/.test(s.claim))
})

// --- the plumbing that has to carry it --------------------------------------

test('parseTableRow keeps the provenance columns it used to discard', () => {
  const row = parseTableRow(LAI.rows.find(r => r.id === 'VFB_jrmc37ha'))
  assert.equal(row.id, 'VFB_jrmc37ha')
  assert.equal(row.dataset, '[Male CNS version 0.9 connectome neurons from Berg et al. (2025).](Berg2025)')
  assert.match(row.source, /male_cns_v0_9/)
  assert.match(row.template, /VFB_00101567/)
  // The raw markdown is preserved, so a multi-valued cell survives the trip.
  assert.equal(rowDatasets(row).length, 1)
})

test('parseTableRow leaves a row without provenance columns exactly as it was', () => {
  const row = parseTableRow({ id: '[x](VFB_x)', label: '[n](VFB_x)' })
  assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'tags', 'thumbnail'])
})

test('a multi-valued dataset cell survives parseTableRow intact', () => {
  const row = parseTableRow({ id: '[x](VFB_x)', label: '[n](VFB_x)', dataset: FAFB_MULTI })
  assert.equal(rowDatasets(row).length, 4)
})

// The routing bug that made W9.1 unanswerable: questionKinds of a per-dataset
// count question is {dataset}, ListAllAvailableImages is typed individual_images,
// so the one query that can answer it scored zero on kind match and was filtered
// out of the shelf before it could be offered. The `carries` declaration is what
// makes it visible.
test('a dataset question can see the image query that carries the dataset column', () => {
  const q = 'How many DA1 lPN neurons does VFB hold in each connectome dataset?'
  assert.ok(questionKinds(q).has('dataset'), 'precondition: the question asks for the dataset kind')
  const digest = { name: 'adult antennal lobe projection neuron DA1 lPN' }
  const query = { query_type: 'ListAllAvailableImages', label: 'Neurons with images of adult antennal lobe projection neuron DA1 lPN' }
  assert.ok(queryRelevanceScore(q, digest, query) > 0, 'must be offerable, or it never runs')
})

// W9.1 end to end, offline. The unit tests above prove the pieces; this proves
// they are actually wired together, which the 3.9.2 W7.C1 episode showed is a
// separate question — a suite can go green on a behaviour change that never
// reached the code path the question travels.
test('W9.1 end to end: the per-dataset breakdown reaches the evidence ledger', async () => {
  const termInfo = {
    Name: 'DA1 lPN', Id: 'FBbt_00067363',
    SuperTypes: ['Class', 'Anatomy', 'Neuron'],
    Meta: { Name: '[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363)', Description: 'A uniglomerular projection neuron of the DA1 glomerulus.' },
    Queries: [
      { query: 'ListAllAvailableImages', label: 'Neurons with images of adult antennal lobe projection neuron DA1 lPN', count: -1, preview_results: { rows: [] } }
    ],
    Publications: []
  }
  const deps = {
    toolDefs: [
      { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
      { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      { name: 'vfb_run_query', purpose: 'run query', parameters: { type: 'object', required: ['id', 'query_type'], properties: { id: { type: 'string' }, query_type: { type: 'string' } } } }
    ],
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 8,
    calls: { tools: [] },
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return { ok: true, value: { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['DA1 lPN'], steps: [] } }
      }
      // If the extractor is ever consulted for this step it produces the exact
      // 3.9.1 failure, so a passing test proves it was bypassed.
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'The specific counts per dataset are not provided.', verbatim: '' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      deps.calls.tools.push({ name, args })
      if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00067363', label: 'adult antennal lobe projection neuron DA1 lPN' }] } }
      if (name === 'vfb_get_term_info') return termInfo
      if (name === 'vfb_run_query') return LAI
      return { ok: true }
    }
  }
  const r = await runHarness('How many DA1 lPN neurons does VFB hold in each connectome dataset?', deps)

  const ran = deps.calls.tools.filter(t => t.name === 'vfb_run_query').map(t => t.args.query_type)
  assert.ok(ran.includes('ListAllAvailableImages'),
    `the only query that can answer this must actually run; ran: ${JSON.stringify(ran)}`)

  const fromQuery = r.ledger.evidence.filter(e => e.tool === 'vfb_run_query').map(e => e.claim)
  assert.ok(fromQuery.length, 'the run_query step must produce evidence')
  const claim = fromQuery.find(c => /registered individuals/.test(c))
  assert.ok(claim, `expected a per-dataset breakdown claim, got: ${JSON.stringify(fromQuery)}`)
  assert.ok(!/are not provided/.test(claim), 'extractor answer leaked through')
  assert.match(claim, /68 registered individuals/)
  assert.match(claim, /do not sum to 68 \(they total 91\)/)
  for (const label of ['BANC', 'FlyWire', 'Hemibrain', 'Male CNS']) {
    assert.ok(claim.includes(label), `claim should name ${label}`)
  }
})

test('matching on both the primary and the carried kind is worth one kind match, not two', () => {
  // "images ... in each dataset" wants BOTH kinds, and ListAllAvailableImages is
  // one of them and carries the other. Letting the weights stack would float it
  // above a query whose primary kind is the one that was asked for.
  const q = 'What images of DA1 lPN does VFB have in each dataset?'
  const kinds = questionKinds(q)
  assert.ok(kinds.has('individual_images') && kinds.has('dataset'), 'precondition: both kinds are wanted')
  const digest = { name: 'adult antennal lobe projection neuron DA1 lPN' }
  const query = { query_type: 'ListAllAvailableImages', label: 'Neurons with images of DA1 lPN' }
  const lexical = labelOverlapScore(q, digest, query, (s) => listQueryWords(s).map(stemWord))
  assert.equal(queryRelevanceScore(q, digest, query), lexical + KIND_MATCH_WEIGHT)
})

// ---------------------------------------------------------------------------
// "connectome" the data source vs "connectome" the wiring diagram.
//
// This is the routing layer of the dataset axis, and it is where W9.1 actually
// died: `connectom\w*` is a connectivity cue, so "in each connectome dataset"
// injected a DownstreamPartners step, that step took the one connectivity slot,
// and the images query that carries the dataset column was never planned at all.
// The harness then answered honestly from partner rows — a different question.
//
// The narrowing is a REMOVAL of behaviour, so it needs pinning from both sides:
// the dataset sense must stop firing and the wiring sense must not.
// ---------------------------------------------------------------------------

test('a dataset-position "connectome" is not a connectivity cue', () => {
  for (const q of [
    'How many DA1 lPN neurons does VFB hold in each connectome dataset?',
    'Where do I find DA1 lPN neurons in VFB, and which connectomes have them?',
    'Is DA1 lPN present across all of the connectomes?',
    'Compare the two connectome releases for DA1 lPN',
    'How many connectomes hold this neuron?'
  ]) {
    assert.ok(!/connectom/i.test(withoutDatasetSenseConnectome(q)),
      `dataset-sense connectome should be blanked in: ${q}`)
  }
})

test('a wiring-sense "connectome" survives untouched', () => {
  for (const q of [
    'What is DA1 lPN connected to across the connectome?',
    'Show me the connectome of the mushroom body',
    'What does connectomic analysis say about DA1 lPN?',
    'Summarise connectomics findings for the antennal lobe'
  ]) {
    assert.match(withoutDatasetSenseConnectome(q), /connectom/i,
      `wiring-sense connectome must not be blanked in: ${q}`)
  }
})

test('a question asking for both keeps its connectivity intent through the other cue', () => {
  // The blanking removes only the provenance half. "which connectomes" goes,
  // "downstream" stays, so the connectivity injector still fires — which is the
  // correct reading of a question that genuinely asks for both.
  const stripped = withoutDatasetSenseConnectome(
    'Which connectomes have DA1 lPN, and what is it downstream of?')
  assert.ok(!/connectomes/i.test(stripped))
  assert.match(stripped, /\bdownstream\b/)
})

test('withoutDatasetSenseConnectome is a no-op on questions that never say it', () => {
  const q = 'What are the strongest downstream partners of DA1 lPN?'
  assert.equal(withoutDatasetSenseConnectome(q), q)
})

test('W1.C: a "which connectomes have them" question plans no connectivity step', () => {
  const ledger = createLedger('Where do I find DA1 lPN neurons in VFB, and which connectomes have them?')
  addTerm(ledger, 'DA1 lPN', {
    id: 'FBbt_00067363',
    label: 'DA1 lPN',
    info: { SuperTypes: ['Class', 'Anatomy', 'Neuron'] },
    digest: { name: 'adult antennal lobe projection neuron DA1 lPN', queries: [] }
  })
  maybeInjectConnectivityStep(ledger, ledger.question)
  assert.deepEqual(ledger.plan.map(s => s.tool), [],
    'a provenance question must not spend the connectivity slot')
})

test('the wiring question that shares its shape still gets its connectivity step', () => {
  const ledger = createLedger('What is DA1 lPN downstream of in the hemibrain connectome?')
  addTerm(ledger, 'DA1 lPN', {
    id: 'FBbt_00067363',
    label: 'DA1 lPN',
    info: { SuperTypes: ['Class', 'Anatomy', 'Neuron'] },
    digest: { name: 'adult antennal lobe projection neuron DA1 lPN', queries: [] }
  })
  maybeInjectConnectivityStep(ledger, ledger.question)
  assert.deepEqual(ledger.plan.map(s => s.tool), ['vfb_find_connectivity_partners'])
  assert.equal(ledger.plan[0].args.direction, 'upstream')
})

// A direction-axis case 3.9.2 did not reach, found by writing the test above.
// "What is X downstream of?" and "what is downstream of X?" differ only in
// whether the preposition has an object, and reading both as 'downstream'
// answers one of them with the exact opposite half of the circuit.
test('a dangling "downstream of" flips the direction', () => {
  const mk = (q) => {
    const ledger = createLedger(q)
    addTerm(ledger, 'DA1 lPN', {
      id: 'FBbt_00067363',
      label: 'DA1 lPN',
      info: { SuperTypes: ['Class', 'Anatomy', 'Neuron'] },
      digest: { name: 'adult antennal lobe projection neuron DA1 lPN', queries: [] }
    })
    maybeInjectConnectivityStep(ledger, q)
    return ledger.plan[0]?.args?.direction
  }
  assert.equal(mk('What is DA1 lPN downstream of?'), 'upstream')
  assert.equal(mk('What is DA1 lPN downstream of in the hemibrain?'), 'upstream')
  assert.equal(mk('What is DA1 lPN upstream of?'), 'downstream')
  // ...and the ordinary readings are unchanged.
  assert.equal(mk('What is downstream of DA1 lPN?'), 'downstream')
  assert.equal(mk('What is upstream of DA1 lPN?'), 'upstream')
  assert.equal(mk('What are the downstream partners of DA1 lPN?'), 'downstream')
})

// The same two readings of "connectome", one layer up. questionKinds feeds the
// shelf ranking AND the sufficiency pre-filter, and it typed both of the
// workshop's dataset questions as `connectivity` — so connectivity queries took
// the kind-match weight in a question that never asked about synapses. The two
// cues are now mirror images of one decision: the connectivity cue does not see
// a dataset-position "connectome", and the dataset cue sees ONLY one.
test('questionKinds reads the two senses of "connectome" apart', () => {
  const kinds = (q) => [...questionKinds(q)].sort()
  assert.deepEqual(kinds('How many DA1 lPN neurons does VFB hold in each connectome dataset?'), ['dataset'])
  assert.deepEqual(kinds('Where do I find DA1 lPN neurons in VFB, and which connectomes have them?'), ['dataset'])
  assert.deepEqual(kinds('What is DA1 lPN connected to across the connectome?'), ['connectivity'])
  assert.deepEqual(kinds('What are the downstream partners of DA1 lPN?'), ['connectivity'])
  // Both, when the question genuinely asks for both.
  assert.deepEqual(kinds('Which connectomes have DA1 lPN, and what is it downstream of?'),
    ['connectivity', 'dataset'])
})

test('the dataset kind still fires on the plain vocabulary', () => {
  for (const q of ['Which datasets have DA1 lPN?', 'What EM volumes is it in?', 'Break it down by data set']) {
    assert.ok(questionKinds(q).has('dataset'), q)
  }
})

// W1.C end to end. Same fixture, same wiring, different question shape: this one
// is not count-shaped, so it travels the INTENT route rather than the count
// route. Both routes were blocked by the same cue, and a fix that only unblocked
// one of them would leave half the dataset axis where 3.9.2 left it.
test('W1.C end to end: "which connectomes have them" runs the query that knows', async () => {
  const termInfo = {
    Name: 'DA1 lPN', Id: 'FBbt_00067363',
    SuperTypes: ['Class', 'Anatomy', 'Neuron'],
    Meta: { Name: '[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363)', Description: 'A uniglomerular projection neuron of the DA1 glomerulus.' },
    Queries: [
      { query: 'ListAllAvailableImages', label: 'Neurons with images of adult antennal lobe projection neuron DA1 lPN', count: -1, preview_results: { rows: [] } },
      { query: 'DownstreamPartners', label: 'Neurons downstream of adult antennal lobe projection neuron DA1 lPN', count: -1, preview_results: { rows: [] } }
    ],
    Publications: []
  }
  const deps = {
    toolDefs: [
      { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
      { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      { name: 'vfb_run_query', purpose: 'run query', parameters: { type: 'object', required: ['id', 'query_type'], properties: { id: { type: 'string' }, query_type: { type: 'string' } } } },
      { name: 'vfb_find_connectivity_partners', purpose: 'partners', parameters: { type: 'object', required: ['endpoint_type'], properties: { endpoint_type: { type: 'string' }, direction: { type: 'string' } } } }
    ],
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 8,
    calls: { tools: [] },
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') return { ok: true, value: { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['DA1 lPN'], steps: [] } }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'MaleCNS.', verbatim: '' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      deps.calls.tools.push({ name, args })
      if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00067363', label: 'adult antennal lobe projection neuron DA1 lPN' }] } }
      if (name === 'vfb_get_term_info') return termInfo
      if (name === 'vfb_run_query') return LAI
      return { ok: true }
    }
  }
  const r = await runHarness('Where do I find DA1 lPN neurons in VFB, and which connectomes have them?', deps)

  const tools = deps.calls.tools.map(t => t.name)
  assert.ok(!tools.includes('vfb_find_connectivity_partners'),
    'a provenance question must not be routed to a connectivity tool')
  const ran = deps.calls.tools.filter(t => t.name === 'vfb_run_query').map(t => t.args.query_type)
  assert.deepEqual(ran, ['ListAllAvailableImages'])

  const claim = r.ledger.evidence.filter(e => e.tool === 'vfb_run_query').map(e => e.claim)
    .find(c => /registered individuals/.test(c))
  assert.ok(claim, 'the breakdown must reach the ledger for the intent route too')
  // 3.9.2 named MaleCNS and stopped. All eight have to be nameable.
  for (const label of ['BANC', 'FlyWire', 'Hemibrain', 'Male CNS', 'FAFB']) {
    assert.ok(claim.includes(label), `claim should name ${label}; got: ${claim}`)
  }
})
