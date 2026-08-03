// A name the resolver could not bind to a VFB term is a FAILED LOOKUP, not an
// absence of data.
//
// Live failure this covers: the direct-lookup path asked about a term whose
// wording VFB indexes slightly differently, pickBestTermId declined to guess,
// the search result was thrown away, and synthesis saw an empty ledger. The
// NEVER OVERCLAIM rule then rendered that emptiness as "VFB does not currently
// hold data on X" — a confident false absence about a term VFB does hold.
//
// Run: node --test tests/unit/unmatchedTerms.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchCandidateLabels, pickBestTermId } from '../../lib/orchestrator.mjs'

const solr = (docs) => ({ response: { docs } })

test('returns the labels VFB did offer, in search-rank order', () => {
  const out = searchCandidateLabels(solr([
    { short_form: 'FBbt_00003885', label: 'lobula plate' },
    { short_form: 'FBbt_00003882', label: 'lobula plate tangential neuron' },
    { short_form: 'VFB_00102345', label: 'LPTC image' }
  ]))
  assert.deepEqual(out, ['lobula plate', 'lobula plate tangential neuron', 'LPTC image'])
})

test('accepts the flat MCP envelope as well as the Solr one', () => {
  // VFB3-MCP returns { results: [...] }; reading only the Solr shape is what
  // made every search look empty in an earlier bug, so both shapes are tested.
  const docs = [{ short_form: 'FBbt_1', label: 'medulla' }]
  assert.deepEqual(searchCandidateLabels({ results: docs }), ['medulla'])
  assert.deepEqual(searchCandidateLabels({ docs }), ['medulla'])
})

test('skips docs with no usable ontology id or no label', () => {
  // A doc without a VFB-shaped short_form is not something the user can be
  // pointed at, so naming it in the prompt would just be noise.
  const out = searchCandidateLabels(solr([
    { short_form: 'GO_0005634', label: 'nucleus' },
    { label: 'no id at all' },
    { short_form: 'FBbt_2', label: '   ' },
    { short_form: 'FBgn_3', label: 'ort' }
  ]))
  assert.deepEqual(out, ['ort'])
})

test('de-duplicates labels case-insensitively', () => {
  const out = searchCandidateLabels(solr([
    { short_form: 'FBbt_1', label: 'Medulla' },
    { short_form: 'FBbt_2', label: 'medulla' },
    { short_form: 'FBbt_3', label: 'lobula' }
  ]))
  assert.deepEqual(out, ['Medulla', 'lobula'])
})

test('caps the list — the prompt gets a hint, not the whole result page', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ short_form: `FBbt_${i}`, label: `neuron ${i}` }))
  assert.equal(searchCandidateLabels(solr(many)).length, 6)
  assert.equal(searchCandidateLabels(solr(many), 2).length, 2)
})

test('an empty search returns [] — which means something different from a non-empty list', () => {
  // [] says VFB's search found nothing for this wording. A non-empty list says
  // VFB has these and none was close enough to bind automatically. The
  // synthesiser is given different wording for each, so they must stay distinct.
  assert.deepEqual(searchCandidateLabels(solr([])), [])
  assert.deepEqual(searchCandidateLabels(null), [])
  assert.deepEqual(searchCandidateLabels(undefined), [])
  assert.deepEqual(searchCandidateLabels({}), [])
})

test('the candidates are exactly the near misses pickBestTermId refused to bind', () => {
  // The two functions must agree: whenever the picker abstains, the candidate
  // list is the evidence for WHY, and it must not be empty when docs came back.
  // An abbreviation shares no token with the spelled-out label, so the picker
  // correctly refuses to guess — and that is precisely the case where saying
  // "VFB does not currently hold data on MBON-a1" would be a false absence.
  const search = solr([
    { short_form: 'FBbt_00100234', label: 'mushroom body output neuron' },
    { short_form: 'FBbt_00100235', label: 'adult mushroom body' }
  ])
  assert.equal(pickBestTermId(search, 'MBON-a1'), null, 'picker abstains')
  assert.deepEqual(searchCandidateLabels(search),
    ['mushroom body output neuron', 'adult mushroom body'], 'but the near misses survive')
})
