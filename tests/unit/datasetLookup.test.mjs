// Regression tests for the dataset-index fallback in resolveTerms.
//
// The symptom: "How do I access the FANC dataset in CATMAID?" answered with a
// list of Fanconi anaemia genes. The question does not match the planner's
// DATASETS_INTENT (singular noun, leading "How"), so the bare acronym goes to
// the resolver, and VFB's lexical index ranks the dataset 318th of 321 behind
// three hundred gene records:
//
//   /search?query=FANC&rows=10    31 rows, every one a gene (FANCL, fanci, …)
//   /search?query=FANC&rows=300  321 rows, "EM FANC Phelps et al 2020" at 318
//
// The resolver's rows: 30 window cannot see it and could not be widened to
// where it can. So when the search and every variant have yielded no id at all,
// the dataset list — 135 rows, complete, already used by the planner — is
// consulted instead. It only runs where there was no resolution, so it cannot
// make a working resolution worse; the tests below are about what stops it
// matching things nobody asked for.
//
// Run: node --test tests/unit/datasetLookup.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  datasetDescribingWords,
  datasetNameTokens,
  matchDatasetIndex,
  __resetDatasetIndexCache,
  runHarness
} from '../../lib/orchestrator.mjs'
import { buildTermInfoDigest, digestToText } from '../../lib/termInfoDigest.mjs'

// Real rows from AllDatasets, verbatim except that the 26 "EM FAFB …" rows are
// cut to eight — enough to be over DATASET_CANDIDATE_CAP, which is the only
// thing their number is used for.
//
// The selection is not arbitrary. The capitalisation gate reads its vocabulary
// off the whole list (see datasetDescribingWords), so a fixture that is merely
// SMALL is also a fixture that has the wrong vocabulary: with no row writing
// "adult" in lower case, "Adult" in MANC's name looks like a naming token. The
// rows below are chosen so the vocabulary they yield agrees with the vocabulary
// the real 135 rows yield for every word these tests touch — Ito2013 and Yu2013
// are what put "adult", "brain", "lineage" and "clone" in lower case, and
// Bates2025 is what puts "version" there.
const DATASETS = [
  { id: 'Maniates_Selvin2020', name: 'EM FANC Phelps et al 2020' },
  { id: 'Takemura2023', name: 'Male Adult Nerve Cord (MANC) connectome neurons' },
  { id: 'Bates2025', name: 'Brain and Nerve Cord (BANC) version 626 connectome neurons from Bates et al. (2025).' },
  { id: 'Dorkenwald2023', name: 'FlyWire connectome neurons' },
  { id: 'Xu2020NeuronsV1point2point1', name: 'JRC_FlyEM_Hemibrain neurons Version 1.2.1' },
  { id: 'Xu2020roi', name: 'JRC_FlyEM_Hemibrain painted domains' },
  { id: 'Kuan2020', name: 'Millimeter-scale imaging of a Drosophila leg at single-neuron resolution' },
  { id: 'Dolan2019', name: 'GAL4 Split expression patterns from Dolan et al. 2019' },
  { id: 'Ito2013', name: 'Ito lab adult brain lineage clone image set' },
  { id: 'Yu2013', name: 'Lee lab adult brain lineage clone image set' },
  { id: 'Valdes_Aleman2021', name: 'Comparative Connectomics Reveals How Partner Identity, Location, and Activity Specify Synaptic Connectivity in Drosophila (Valdes-Aleman et al. 2021)' },
  { id: 'Zheng2018', name: 'EM FAFB Zheng et al 2018' },
  { id: 'BatesSchlegel2020', name: 'EM FAFB Bates and Schlegel et al 2020' },
  { id: 'Coates2020', name: 'EM FAFB Coates et al 2020' },
  { id: 'Marin2020', name: 'EM FAFB Marin et al 2020' },
  { id: 'Otto2020', name: 'EM FAFB Otto et al 2020' },
  { id: 'Sayin2019', name: 'EM FAFB Sayin et al 2019' },
  { id: 'Kim2020', name: 'EM FAFB Kim et al 2020' },
  { id: 'Shiu2022', name: 'EM FAFB Shiu et al. 2022' }
]

// What matchDatasetIndex derives internally. The unit tests below pass it
// explicitly because datasetNameTokens cannot be judged without it.
const DESCRIBING = datasetDescribingWords(DATASETS)

const idsOf = (m) => (m || []).map(r => r.id)

// --- datasetNameTokens -------------------------------------------------------

test('the describing vocabulary is read off the list, not hard-coded', () => {
  // The rule the gate rests on: a word VFB itself ever writes in lower case is a
  // word describing a dataset, not naming one. Nothing is enumerated by hand, so
  // the vocabulary follows the list as VFB adds to it.
  assert.ok(DESCRIBING.has('adult'), 'Ito2013 writes "adult" in lower case')
  assert.ok(DESCRIBING.has('brain'))
  assert.ok(DESCRIBING.has('version'), 'Bates2025 writes "version" in lower case')
  assert.ok(DESCRIBING.has('connectome'))
  assert.ok(DESCRIBING.has('neuron'), 'singularised, like every token the matcher compares')

  // The three kinds of naming token are exactly the words that never appear in
  // lower case anywhere in the list.
  for (const t of ['fanc', 'manc', 'banc', 'flywire', 'hemibrain', 'phelp', 'zheng']) {
    assert.ok(!DESCRIBING.has(t), `${t} is a name, and must not be in the describing vocabulary`)
  }
})

test('acronyms, run-together product names and surnames are naming tokens', () => {
  // These are the three ways people actually refer to a dataset, and VFB
  // capitalises all three in its own names while writing describing words in
  // lower case. That is the whole signal the gate rests on.
  // "phelp", not "phelps": every token on both sides of the match is singularised
  // by the same tokeniser the search ladder uses, so the query "Phelps" and the
  // name "Phelps" meet as "phelp" and match.
  const fanc = datasetNameTokens('EM FANC Phelps et al 2020', DESCRIBING)
  assert.deepEqual([...fanc].sort(), ['em', 'fanc', 'phelp'])

  const flywire = datasetNameTokens('FlyWire connectome neurons', DESCRIBING)
  assert.ok(flywire.has('flywire'))
  assert.ok(!flywire.has('connectome'), 'a lower-case describing word is not a name')
  assert.ok(!flywire.has('neuron'), 'nor is the category noun')
})

test('a lower-case describing word is never a naming token', () => {
  // The two measured accidents. Over the 135 real names "neuron" matches
  // exactly one dataset and "expression" exactly one, so uniqueness alone would
  // have resolved both confidently and wrongly.
  const leg = datasetNameTokens('Millimeter-scale imaging of a Drosophila leg at single-neuron resolution', DESCRIBING)
  for (const t of ['neuron', 'imaging', 'leg', 'resolution', 'scale']) {
    assert.ok(!leg.has(t), `${t} must not be a naming token`)
  }
  assert.ok(!datasetNameTokens('GAL4 Split expression patterns from Dolan et al. 2019', DESCRIBING).has('expression'))

  // Capitalised in one name and lower case in another is the interesting case,
  // and it is why the vocabulary is corpus-wide rather than per-name: "Adult"
  // and "Version" are capitalised where they appear below, and still refused.
  const manc = datasetNameTokens('Male Adult Nerve Cord (MANC) connectome neurons', DESCRIBING)
  assert.ok(!manc.has('adult'), 'capitalised here, lower case in Ito2013')
  assert.ok(!datasetNameTokens('JRC_FlyEM_Hemibrain neurons Version 1.2.1', DESCRIBING).has('version'))
})

test('a Title Case paper title yields only genuine all-caps acronyms', () => {
  // Title Case capitalises the describing words too, so capitalisation has
  // stopped carrying information and the surname rule would let "synaptic",
  // "connectivity" and even "how" resolve to this one dataset.
  const title = datasetNameTokens('Comparative Connectomics Reveals How Partner Identity, Location, and Activity Specify Synaptic Connectivity in Drosophila (Valdes-Aleman et al. 2021)', DESCRIBING)
  for (const t of ['how', 'synaptic', 'connectivity', 'identity', 'location', 'activity', 'partner', 'reveals']) {
    assert.ok(!title.has(t), `${t} leaked from a Title Case name`)
  }
  // The cost of the rule, stated so it is a decision rather than a surprise: the
  // author surname is inside the title, so this is the one dataset whose authors
  // cannot be looked up by name.
  assert.ok(!title.has('valde'))

  // Half-capitalised names are NOT titles, and must keep their naming tokens.
  // "Male Adult Nerve Cord (MANC) connectome neurons" is five of seven — the
  // acronym has to survive that, or the rule would cost more than it saves.
  const manc = datasetNameTokens('Male Adult Nerve Cord (MANC) connectome neurons', DESCRIBING)
  assert.deepEqual([...manc].sort(), ['cord', 'manc', 'nerve'])
  // "nerve" and "cord" are not accidents of this fixture: over all 135 real names
  // neither is ever written in lower case, and each names exactly the two nerve
  // cord datasets — MANC and BANC — so both are honestly ambiguous rather than
  // wrong. "Male" is dropped for its position, not its case: the first word of a
  // name is capitalised by convention and carries no evidence either way.
  assert.deepEqual(
    idsOf(matchDatasetIndex(DATASETS, 'nerve cord')).sort(),
    ['Bates2025', 'Takemura2023']
  )
})

test('a short name is never treated as a title, however capitalised', () => {
  // The word floor: without it "EM FANC Phelps" style names, which are mostly
  // capitalised by nature, would be read as titles and lose their surnames.
  assert.ok(datasetNameTokens('EM MANC Takemura', DESCRIBING).has('takemura'))
})

// --- matchDatasetIndex -------------------------------------------------------

test('a bare acronym resolves to exactly its dataset', () => {
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'FANC')), ['Maniates_Selvin2020'])
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'MANC')), ['Takemura2023'])
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'FlyWire')), ['Dorkenwald2023'])
  // Case is irrelevant on the query side; the capitalisation that matters is
  // VFB's, in the name being matched against.
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'fanc')), ['Maniates_Selvin2020'])
})

test('an author surname resolves the same way', () => {
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'Phelps')), ['Maniates_Selvin2020'])
})

test('a name that matches several datasets returns all of them, not a pick', () => {
  // Both Hemibrain rows are legitimately "the Hemibrain dataset" and there is
  // nothing in the word to choose between them, so the caller offers the
  // ambiguity rather than resolving one of them.
  assert.deepEqual(
    idsOf(matchDatasetIndex(DATASETS, 'Hemibrain')).sort(),
    ['Xu2020NeuronsV1point2point1', 'Xu2020roi']
  )
})

test('a word that names a category rather than a dataset returns them all, for the caller to decline', () => {
  // "FAFB" is a real naming token — it is just not the name of ONE dataset. The
  // count is what makes it undecidable, and it is returned rather than truncated
  // so the caller can say so.
  assert.ok(matchDatasetIndex(DATASETS, 'FAFB').length > 6)
})

test('a two-letter token is refused before it is even counted', () => {
  // "EM" is a naming token by every rule above and matches half the list, so it
  // would arrive as a large ambiguity. It never gets that far: the query must
  // carry a token of more than two characters to be distinctive enough to match
  // a dataset on at all, which is the same test the search ladder's weakest
  // stage applies. Cheaper than counting, and it also stops "3D", "CNS"-like
  // two-letter fragments and stray initials.
  assert.equal(matchDatasetIndex(DATASETS, 'EM'), null)
  // The same word inside a query that IS distinctive is fine — the gate is on
  // the query having something distinctive, not on every token being long.
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'EM FANC')), ['Maniates_Selvin2020'])
})

test('a describing word does not resolve, however unique it happens to be', () => {
  // "neuron" is stopped one step earlier than the others, by the same
  // content-token test the search ladder's weakest stage uses: a query made
  // entirely of category nouns has nothing distinctive to match on at all.
  assert.equal(matchDatasetIndex(DATASETS, 'neuron'), null)
  assert.equal(matchDatasetIndex(DATASETS, 'neurons'), null)
  // "expression" survives that test and is stopped by the capitalisation gate.
  assert.equal(matchDatasetIndex(DATASETS, 'expression'), null)
  // And the Title Case leak.
  assert.equal(matchDatasetIndex(DATASETS, 'connectivity'), null)
  assert.equal(matchDatasetIndex(DATASETS, 'synaptic connectivity'), null)
})

test('a generic or empty name is refused outright', () => {
  assert.equal(matchDatasetIndex(DATASETS, ''), null)
  assert.equal(matchDatasetIndex(DATASETS, 'the'), null)
  assert.equal(matchDatasetIndex(DATASETS, 'dataset'), null)
  assert.equal(matchDatasetIndex([], 'FANC'), null)
  assert.equal(matchDatasetIndex(null, 'FANC'), null)
})

test('every word of the query must be present, so a wrong pairing matches nothing', () => {
  // The acronym alone resolves; the acronym with a word that is not in that
  // dataset's name must not, or "FANC hemibrain" would resolve to FANC.
  assert.equal(matchDatasetIndex(DATASETS, 'FANC Hemibrain'), null)
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'FAFB Zheng')), ['Zheng2018'])
})

test('a leading article is grammar, not a word to be found in the name', () => {
  // No dataset is called "the ...", so "every query word appears in the name"
  // is the wrong test for an article. Dropping it only widens the superset
  // test; the distinctiveness gate is what still refuses a bare "the".
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'the FANC')), ['Maniates_Selvin2020'])
  assert.deepEqual(idsOf(matchDatasetIndex(DATASETS, 'The FlyWire')), ['Dorkenwald2023'])
  assert.equal(matchDatasetIndex(DATASETS, 'the'), null)
  // Only the article is forgiven. Every other word of the query still has to be
  // in the name, so an article cannot carry a wrong pairing through.
  assert.equal(matchDatasetIndex(DATASETS, 'the FANC Hemibrain'), null)
})

// --- the fallback inside resolveTerms ---------------------------------------

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'vfb_run_query', purpose: 'run query', parameters: { type: 'object', required: ['id', 'query_type'], properties: { id: { type: 'string' }, query_type: { type: 'string' } } } }
]

// What VFB really returns for "FANC": thirty-one gene records, none of them the
// dataset. Two are enough to prove the ladder declines rather than picking one.
const FANC_GENES = [
  { short_form: 'FBgn0038163', label: 'Fancl (FBgn0038163)', original_label: 'Fancl' },
  { short_form: 'FBgn0035603', label: 'fanci (FBgn0035603)', original_label: 'fanci' }
]

function makeDeps({ terms, hits = {}, datasets = DATASETS, termInfo = {} } = {}) {
  const calls = { searches: [], queries: [], infos: [] }
  return {
    calls,
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 4,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return { ok: true, value: {
          intent: 'term_info', underspecified: false, clarifying_question: '',
          terms_to_resolve: terms, steps: []
        } }
      }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') {
        calls.searches.push(args.query)
        return { response: { docs: hits[args.query] || FANC_GENES } }
      }
      if (name === 'vfb_run_query') {
        calls.queries.push(`${args.query_type}:${args.id}`)
        // AllDatasets declares its name column as markdown and sends it as a
        // link, which is why the index strips one.
        return { rows: datasets.map(d => ({ id: d.id, name: `[${d.name}](${d.id})` })), count: datasets.length }
      }
      if (name === 'vfb_get_term_info') {
        calls.infos.push(args.id)
        return termInfo[args.id] || { Id: args.id, Name: args.id, Publications: [] }
      }
      return { ok: true }
    }
  }
}

const FANC_TERM_INFO = {
  Maniates_Selvin2020: {
    Id: 'Maniates_Selvin2020',
    Name: 'EM FANC Phelps et al 2020',
    Meta: {
      Name: '[EM FANC Phelps et al 2020](Maniates_Selvin2020)',
      Description: 'FANC EM reconstructed neurons from Maniates-Selvin et al 2020',
      Link: '[https://fanc.catmaid.virtualflybrain.org](https://fanc.catmaid.virtualflybrain.org)'
    },
    SuperTypes: ['Entity', 'Individual', 'DataSet', 'has_image'],
    Publications: []
  }
}

test('the FANC acronym resolves to its dataset instead of offering genes', async () => {
  // The exact case that broke. Before this the term resolved to null with
  // "possible candidates including Fancl and FANCI".
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FANC'], termInfo: FANC_TERM_INFO })
  const r = await runHarness('How do I access the FANC dataset in CATMAID?', deps)

  const term = r.ledger.terms.FANC
  assert.equal(term.id, 'Maniates_Selvin2020')
  assert.deepEqual(deps.calls.queries, ['AllDatasets:VFB_00101567'])
  assert.ok(deps.calls.infos.includes('Maniates_Selvin2020'), 'term info was fetched for the dataset')
  assert.ok(
    r.trace.some(e => e.resolve_dataset === 'FANC' && e.id === 'Maniates_Selvin2020'),
    'the dataset resolution is recorded in the trace so it can be explained afterwards'
  )
})

test('the ledger holds VFB\'s own name for the dataset, not the acronym', async () => {
  // A dataset resolved from the index is not in the search documents at all —
  // that is the whole point of it — so its name has to come from the list. With
  // term-info the digest supplies it, and every consumer prefers the digest.
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FANC'], termInfo: FANC_TERM_INFO })
  const r = await runHarness('How do I access the FANC dataset in CATMAID?', deps)
  assert.equal(r.ledger.terms.FANC.digest.name, 'EM FANC Phelps et al 2020')
})

test('and still holds it when term-info cannot be read', async () => {
  // The case the label fallback exists for. Without it the ledger would call the
  // dataset "FANC" — the string the user typed — and the answer would name it
  // that way too, which is the acronym VFB's own search ranks 318th behind three
  // hundred genes. Note what is NOT claimed here: the label is not registered for
  // LINKING. recordTermId only accepts ontology-shaped ids (FBbt/VFB/FBgn/…) and
  // a dataset short_form has no shape to check against, so the pair is kept out
  // of the link registry deliberately rather than by oversight.
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FANC'] })
  deps.runTool = async (name, args) => {
    if (name === 'vfb_search_terms') return { response: { docs: FANC_GENES } }
    if (name === 'vfb_run_query') return { rows: DATASETS.map(d => ({ id: d.id, name: `[${d.name}](${d.id})` })), count: DATASETS.length }
    return { error: 'term info unavailable' }
  }
  const r = await runHarness('How do I access the FANC dataset in CATMAID?', deps)
  assert.equal(r.ledger.terms.FANC.id, 'Maniates_Selvin2020')
  assert.equal(r.ledger.terms.FANC.label, 'EM FANC Phelps et al 2020')
})

test('a category noun on the end does not stop the list matching', async () => {
  // "the FANC dataset" reaches the resolver with its category noun attached,
  // and no VFB dataset name contains the word "dataset". The same variant
  // ladder the search uses takes it off.
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FANC dataset'], termInfo: FANC_TERM_INFO })
  const r = await runHarness('How do I access the FANC dataset in CATMAID?', deps)
  assert.equal(r.ledger.terms['FANC dataset'].id, 'Maniates_Selvin2020')
})

test('and neither does a definite article in front of it', async () => {
  // The planner writes the term in its own words, so the same question can
  // arrive as "FANC dataset" or "the FANC dataset". Before the article was
  // dropped the second form matched nothing AND offered nothing, because the
  // superset test asked for a name containing the word "the".
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['the FANC dataset'], termInfo: FANC_TERM_INFO })
  const r = await runHarness('How do I access the FANC dataset in CATMAID?', deps)
  assert.equal(r.ledger.terms['the FANC dataset'].id, 'Maniates_Selvin2020')
})

test('an ambiguous name is offered as candidates rather than resolved', async () => {
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['Hemibrain'] })
  // Phrased so the deterministic fast path does not fire: "What is X?" is
  // captured by detectFastPath, which derives its own subject from the wording
  // and would resolve "in the Hemibrain" rather than the planner's term.
  const r = await runHarness('Tell me about the Hemibrain.', deps)

  const term = r.ledger.terms.Hemibrain
  assert.equal(term.id, null)
  assert.equal(term.attempted, true)
  assert.deepEqual(term.candidates.sort(), [
    'JRC_FlyEM_Hemibrain neurons Version 1.2.1',
    'JRC_FlyEM_Hemibrain painted domains'
  ])
  assert.ok(r.trace.some(e => e.resolve_dataset === 'Hemibrain' && e.id === null && e.matches === 2))
})

test('a name matching more datasets than the cap resolves nothing and offers nothing from the list', async () => {
  // Eight "EM FAFB …" rows here, twenty-six in the real list. At that point the
  // word named a whole imaging project rather than a dataset, and truncating to
  // six would imply the six were all of them.
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FAFB'] })
  const r = await runHarness('Tell me about FAFB.', deps)

  const term = r.ledger.terms.FAFB
  assert.equal(term.id, null)
  assert.ok(!term.candidates.some(c => c.startsWith('EM FAFB')), 'no truncated dataset list was offered')
  // The count is still traced, so the truncation is not silent.
  assert.ok(r.trace.some(e => e.resolve_dataset === 'FAFB' && e.id === null && e.matches > 6))
})

test('the list is not consulted when the search already resolved the name', async () => {
  // The fallback must be incapable of changing a working resolution.
  __resetDatasetIndexCache()
  const deps = makeDeps({
    terms: ['Kenyon cell'],
    hits: { 'Kenyon cell': [{ short_form: 'FBbt_00003686', label: 'Kenyon cell (FBbt_00003686)', original_label: 'Kenyon cell' }] }
  })
  const r = await runHarness('What is a Kenyon cell?', deps)

  assert.equal(r.ledger.terms['Kenyon cell'].id, 'FBbt_00003686')
  assert.deepEqual(deps.calls.queries, [], 'AllDatasets was never fetched')
})

test('a bare ontology id skips the list as well as the search', async () => {
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FBbt_00047736'] })
  const r = await runHarness('What is FBbt_00047736?', deps)

  assert.deepEqual(deps.calls.searches, [])
  assert.deepEqual(deps.calls.queries, [])
  assert.equal(r.ledger.terms.FBbt_00047736.id, 'FBbt_00047736')
})

test('two unresolved names in one question cost exactly one AllDatasets query', async () => {
  // resolveTerms fans out over the names in parallel, so the in-flight PROMISE
  // is what has to be cached; caching the rows would let two names race each
  // other into two identical queries.
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FANC', 'MANC'], termInfo: FANC_TERM_INFO })
  const r = await runHarness('How do FANC and MANC compare?', deps)

  assert.deepEqual(deps.calls.queries, ['AllDatasets:VFB_00101567'])
  assert.equal(r.ledger.terms.FANC.id, 'Maniates_Selvin2020')
  assert.equal(r.ledger.terms.MANC.id, 'Takemura2023')
})

test('a dataset list that cannot be read is not remembered, and abstains quietly', async () => {
  // A failed read must not poison the next hour of resolutions, and must not
  // turn into an exception either — the fallback exists to improve on an
  // abstention, so its own failure mode is that same abstention.
  __resetDatasetIndexCache()
  const deps = makeDeps({ terms: ['FANC'] })
  deps.runTool = async (name, args) => {
    if (name === 'vfb_search_terms') return { response: { docs: FANC_GENES } }
    if (name === 'vfb_run_query') { deps.calls.queries.push('boom'); throw new Error('AllDatasets unavailable') }
    return { Id: args.id, Publications: [] }
  }
  const r = await runHarness('How do I access the FANC dataset in CATMAID?', deps)
  assert.equal(r.ledger.terms.FANC.id, null)
  assert.equal(r.ledger.terms.FANC.attempted, true)

  // Second question, same process: the failure was not cached, so it is retried.
  const before = deps.calls.queries.length
  await runHarness('How do I access the FANC dataset in CATMAID?', deps)
  assert.ok(deps.calls.queries.length > before, 'a failed read is retried rather than cached for an hour')
})

// --- Meta.Link through the digest -------------------------------------------

test('a dataset\'s hosting link survives into the digest and its text', () => {
  // This is the other half of the FANC question. VFB carries the CATMAID URL on
  // the dataset's own term-info record as Meta.Link, and the digest was
  // dropping it — so "how do I access it" had to be answered out of the
  // website's hand-maintained table or not at all.
  const digest = buildTermInfoDigest(FANC_TERM_INFO.Maniates_Selvin2020)
  assert.equal(digest.link, 'https://fanc.catmaid.virtualflybrain.org')

  const text = digestToText(digest)
  assert.ok(text.includes('https://fanc.catmaid.virtualflybrain.org'), text)
})

test('a term with no link renders no line for one', () => {
  const digest = buildTermInfoDigest({ Id: 'FBbt_00003686', Meta: { Name: 'Kenyon cell', Description: 'A neuron.' } })
  assert.equal(digest.link, '')
  assert.ok(!digestToText(digest).includes('hosted or published'))
})
