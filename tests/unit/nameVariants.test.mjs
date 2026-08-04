// Regression tests for the resolver's variant ladder and its two new stages.
//
// The symptom, three battery runs in a row, was T2.7 — "Are there neurons in the
// Hemibrain dataset that are morphologically similar to the fru+ mAL neurons
// described in light microscopy studies?" — answered entirely as a naming
// failure:
//
//   'The name "Hemibrain dataset" could not be matched to a VFB term. The name
//    "fru+ mAL neurons" could not be matched to a VFB term, with possible
//    candidates including SMC6 and nonC.'
//
// Both names name things VFB holds. Measured against v3-cached:
//
//   "fru+ mAL neurons"   33 hits, every one a gene record — the "+" poisons it
//   "fru+ mAL neuron"    37 hits, same junk
//   "fru mAL neurons"     0 hits
//   "fru mAL neuron"    305 hits, FBbt_00052693 first, matched on its synonym
//   "Hemibrain dataset"   0 hits
//   "Hemibrain"         440 hits, the two DataSet records at ranks 436 and 439
//
// Run: node --test tests/unit/nameVariants.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  stripGenotypeMarkers, stripCategoryNoun, nameVariants, categoryCandidates,
  pickBestTermId, searchCandidateLabels, runHarness
} from '../../lib/orchestrator.mjs'

// --- stripGenotypeMarkers ----------------------------------------------------

test('a genotype marker attached to the end of a word is dropped', () => {
  assert.equal(stripGenotypeMarkers('fru+ mAL neurons'), 'fru mAL neurons')
  assert.equal(stripGenotypeMarkers('elav- cells'), 'elav cells')
  assert.equal(stripGenotypeMarkers('GAL4+'), 'GAL4')
})

test('a hyphen inside a name is not a marker and survives', () => {
  // These are the names the strip would destroy if it treated every hyphen as a
  // marker: two of them are the very terms this fix exists to reach.
  assert.equal(stripGenotypeMarkers('fru-mAL neuron'), null)
  assert.equal(stripGenotypeMarkers('P-EN neurons'), null)
  assert.equal(stripGenotypeMarkers('adult fruitless aDT-b neuron'), null)
  assert.equal(stripGenotypeMarkers('JRC_FlyEM_Hemibrain'), null)
})

test('returns null when nothing changed, so no retry is issued', () => {
  assert.equal(stripGenotypeMarkers('Kenyon cells'), null)
  assert.equal(stripGenotypeMarkers(''), null)
  assert.equal(stripGenotypeMarkers(), null)
})

// --- stripCategoryNoun -------------------------------------------------------

test('a trailing category noun is removed, singular or plural', () => {
  assert.equal(stripCategoryNoun('Hemibrain dataset'), 'Hemibrain')
  assert.equal(stripCategoryNoun('Hemibrain datasets'), 'Hemibrain')
  assert.equal(stripCategoryNoun('Hemibrain data set'), 'Hemibrain')
  assert.equal(stripCategoryNoun('JRC2018U template'), 'JRC2018U')
  assert.equal(stripCategoryNoun('JRC2018U template brain'), 'JRC2018U')
})

test('the noun is only a category noun at the END, and never on its own', () => {
  // "dataset images" is asking about something else, and a bare "dataset" has no
  // remainder to search for — stripping it would search for the empty string.
  assert.equal(stripCategoryNoun('dataset images'), null)
  assert.equal(stripCategoryNoun('dataset'), null)
  assert.equal(stripCategoryNoun('templates'), null)
  assert.equal(stripCategoryNoun('Kenyon cells'), null)
})

// --- nameVariants ------------------------------------------------------------

test('the two transformations compose, because neither alone reaches the term', () => {
  // "fru mAL neurons" is 0 hits and "fru+ mAL neuron" is 37 junk hits. Only the
  // pair gets to the 305-hit search, so both must be on the list and the
  // composed form must be there too.
  assert.deepEqual(nameVariants('fru+ mAL neurons'),
    ['fru+ mAL neuron', 'fru mAL neurons', 'fru mAL neuron'])
})

test('a plain plural still yields exactly one variant', () => {
  // The common case must not become more expensive: one extra search, as before.
  assert.deepEqual(nameVariants('visual system neurons'), ['visual system neuron'])
  assert.deepEqual(nameVariants('Kenyon cells'), ['Kenyon cell'])
})

test('a name with no variant costs no search at all', () => {
  assert.deepEqual(nameVariants('medulla'), [])
  assert.deepEqual(nameVariants('FBbt_00047736'), [])
  assert.deepEqual(nameVariants(''), [])
})

test('a category name falls back to the thing without its category noun', () => {
  assert.deepEqual(nameVariants('Hemibrain dataset'), ['Hemibrain'])
})

test('no variant repeats the name it came from, or another variant', () => {
  for (const name of ['fru+ mAL neurons', 'Hemibrain datasets', 'Kenyon cells']) {
    const v = nameVariants(name)
    assert.equal(new Set(v.map(s => s.toLowerCase())).size, v.length, name)
    assert.ok(!v.some(s => s.toLowerCase() === name.toLowerCase()), name)
  }
})

// --- the category stage ------------------------------------------------------

const DS_ROI = {
  short_form: 'Xu2020roi',
  original_label: 'JRC_FlyEM_Hemibrain painted domains',
  label: 'JRC_FlyEM_Hemibrain painted domains (Xu2020roi)',
  facets_annotation: ['DataSet', 'Entity', 'Individual']
}
const DS_NEURONS = {
  short_form: 'Xu2020NeuronsV1point2point1',
  original_label: 'JRC_FlyEM_Hemibrain neurons Version 1.2.1',
  label: 'JRC_FlyEM_Hemibrain neurons Version 1.2.1 (Xu2020NeuronsV1point2point1)',
  facets_annotation: ['DataSet', 'Entity', 'Individual']
}
// What VFB's own ranking actually puts first for "Hemibrain": neuropil domains.
const NEUROPIL = {
  short_form: 'VFB_00101399',
  original_label: 'AB(R) on JRC_FlyEM_Hemibrain',
  label: 'ABR JRC_FlyEM_Hemibrain (AB(R) on JRC_FlyEM_Hemibrain)',
  facets_annotation: ['Entity', 'Individual', 'VFB', 'Adult', 'Anatomy', 'Synaptic_neuropil_domain']
}

const search = (docs) => ({ results: docs })

test('a dataset record is admissible even though its id is not an ontology id', () => {
  // VFB's datasets are named after their publications — Xu2020roi, Takemura2023,
  // Berg2025 — so the old "short_form starts with FBbt/VFB/FBgn/FBal/FBti" rule
  // dropped every one of them before any stage of the ladder saw it. That is why
  // "the Hemibrain dataset" could not resolve to the Hemibrain dataset.
  assert.deepEqual(searchCandidateLabels(search([DS_ROI, DS_NEURONS])), [
    'JRC_FlyEM_Hemibrain painted domains',
    'JRC_FlyEM_Hemibrain neurons Version 1.2.1'
  ])
})

test('a document with neither an ontology id nor an Entity facet is still dropped', () => {
  assert.deepEqual(searchCandidateLabels(search([
    { short_form: 'not an id', original_label: 'junk' },
    { short_form: 'lucene_shard_7', original_label: 'internal', facets_annotation: ['Shard'] }
  ])), [])
})

test('"<X> dataset" resolves to the dataset when exactly one matches', () => {
  const id = pickBestTermId(search([NEUROPIL, DS_NEURONS]), 'Hemibrain dataset')
  assert.equal(id, 'Xu2020NeuronsV1point2point1')
})

test('"<X> dataset" abstains rather than guess between two datasets', () => {
  // Both are legitimately "the Hemibrain dataset". VFB's own ranking puts the
  // painted-domains one first and the shortest-label tiebreak the region rule
  // uses picks the same one — and for a question about neurons that is the wrong
  // answer. There is nothing in the name to choose on, so nothing chooses.
  assert.equal(pickBestTermId(search([NEUROPIL, DS_ROI, DS_NEURONS]), 'Hemibrain dataset'), null)
})

test('a category name never falls through to a record of the wrong kind', () => {
  // This is the failure the stage exists to prevent. Without it the token-superset
  // rule finds no label carrying "dataset", and the top-hit fallback then returns
  // a synaptic neuropil domain because it shares the word "Hemibrain" — a
  // confident answer about the wrong kind of record.
  assert.equal(pickBestTermId(search([NEUROPIL]), 'Hemibrain dataset'), null)
})

test('the candidates offered for an ambiguous category name are the matching ones', () => {
  // Searching "Hemibrain" returns 440 documents whose first six are all neuropil
  // domains, so the generic candidate list would offer six things that are not
  // datasets while the two that are sit at ranks 436 and 439.
  const cat = categoryCandidates(search([NEUROPIL, DS_ROI, DS_NEURONS]), 'Hemibrain dataset')
  assert.equal(cat.facet, 'dataset')
  assert.deepEqual(cat.matches.map(d => d.short_form), ['Xu2020roi', 'Xu2020NeuronsV1point2point1'])
})

test('a name that is not a category reference is left entirely to the other stages', () => {
  assert.equal(categoryCandidates(search([NEUROPIL]), 'Kenyon cells'), null)
  // …and the ladder below stage 2c is unaffected by any of this.
  const kc = { short_form: 'FBbt_00003686', original_label: 'Kenyon cell', label: 'Kenyon cell (FBbt_00003686)' }
  assert.equal(pickBestTermId(search([kc]), 'Kenyon cell'), 'FBbt_00003686')
})

// --- the ladder end to end ---------------------------------------------------

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

// A harness whose search behaves like VFB's index: `hits` maps an exact query
// string to the documents it returns, and everything else returns nothing.
function makeDeps(hits, term) {
  const calls = { searches: [] }
  return {
    calls,
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 4,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return { ok: true, value: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: [term], steps: [] } }
      }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') {
        calls.searches.push(args.query)
        return { results: hits[args.query] || [] }
      }
      if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'x', Publications: [] }
      return { ok: true }
    }
  }
}

// The real result sets, trimmed to their first document. The junk rows are gene
// records, which ARE admissible documents (FBgn is an ontology id) — so the old
// "empty search?" guard saw a non-empty search and never retried at all.
const JUNK = [{ short_form: 'FBgn0266282', original_label: 'SMC6', label: 'SMC6 (FBgn0266282)' }]
const MAL = [{
  short_form: 'FBbt_00052693',
  original_label: 'adult fruitless aDT-b neuron',
  label: 'adult fru-mAL neuron (adult fruitless aDT-b neuron)'
}]

test('a name whose search returns only junk is retried, not accepted', async () => {
  const deps = makeDeps({
    'fru+ mAL neurons': JUNK,
    'fru+ mAL neuron': JUNK,
    'fru mAL neuron': MAL
  }, 'fru+ mAL neurons')
  const r = await runHarness('What are fru+ mAL neurons?', deps)

  assert.deepEqual(deps.calls.searches,
    ['fru+ mAL neurons', 'fru+ mAL neuron', 'fru mAL neurons', 'fru mAL neuron'])
  assert.equal(r.ledger.terms['fru+ mAL neurons'].id, 'FBbt_00052693')
  assert.ok(r.trace.some(e => e.resolve_retry === 'fru+ mAL neurons' && e.as === 'fru mAL neuron'
    && e.reason === 'no-match-for-wording'))
})

test('a variant is rejected when the ladder still finds nothing in it', async () => {
  // The junk variant is tried and discarded. If "non-empty" were the acceptance
  // test, the harness would have bound this name to the gene SMC6.
  const deps = makeDeps({ 'fru+ mAL neurons': JUNK, 'fru+ mAL neuron': JUNK }, 'fru+ mAL neurons')
  const r = await runHarness('What are fru+ mAL neurons?', deps)
  const t = r.ledger.terms['fru+ mAL neurons']
  assert.equal(t.id, null)
  assert.equal(t.attempted, true)
  assert.deepEqual(t.candidates, ['SMC6'], 'the junk is still offered as a candidate, not as an answer')
})

test('a category name resolves through its variant and reports dataset candidates when ambiguous', async () => {
  const deps = makeDeps({ Hemibrain: [NEUROPIL, DS_ROI, DS_NEURONS] }, 'Hemibrain dataset')
  // Not a "what is X" question, so the fast path stands down and the planner
  // stub above is what names the term — which is the point here: the name under
  // test has to arrive as written, not as a subject the fast path carved out.
  const r = await runHarness('Which neurons are in the Hemibrain dataset?', deps)

  assert.deepEqual(deps.calls.searches, ['Hemibrain dataset', 'Hemibrain'])
  const t = r.ledger.terms['Hemibrain dataset']
  assert.equal(t.id, null, 'two datasets tie, so nothing is picked')
  // The point of the whole exercise: the original search was EMPTY, so before
  // this the user was told VFB returned nothing, about two records VFB holds.
  assert.deepEqual(t.candidates, [
    'JRC_FlyEM_Hemibrain painted domains',
    'JRC_FlyEM_Hemibrain neurons Version 1.2.1'
  ])
})

test('a category name with one dataset resolves to it', async () => {
  const deps = makeDeps({ Hemibrain: [NEUROPIL, DS_NEURONS] }, 'Hemibrain dataset')
  // Not a "what is X" question, so the fast path stands down and the planner
  // stub above is what names the term — which is the point here: the name under
  // test has to arrive as written, not as a subject the fast path carved out.
  const r = await runHarness('Which neurons are in the Hemibrain dataset?', deps)
  assert.equal(r.ledger.terms['Hemibrain dataset'].id, 'Xu2020NeuronsV1point2point1')
})

test('an exact match is never disturbed by the ladder', async () => {
  // The whole change is additive or it is nothing: a name that already resolves
  // exactly must cost one search and take the same id it always did.
  const kc = { short_form: 'FBbt_00003686', original_label: 'Kenyon cell', label: 'Kenyon cell (FBbt_00003686)' }
  const deps = makeDeps({ 'Kenyon cell': [kc] }, 'Kenyon cell')
  const r = await runHarness('What is a Kenyon cell?', deps)
  // Two invariants at once: the name that reaches VFB is "Kenyon cell" and not
  // "a Kenyon cell" (the fast path drops the article), and it is searched for
  // exactly once — an exact hit never enters the variant ladder.
  assert.deepEqual(deps.calls.searches, ['Kenyon cell'])
  assert.equal(r.ledger.terms['Kenyon cell'].id, 'FBbt_00003686')
})
