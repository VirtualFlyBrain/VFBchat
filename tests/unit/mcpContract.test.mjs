// Regression tests for the VFBchat ↔ VFB3-MCP contract break that made the
// client answer "VFB does not currently hold data on …" for almost every
// question, even ones VFB answers well.
//
// Three independent defects, each individually fatal:
//   5. Every search_terms call carried exclude_types: ['deprecated']. The
//      current VFB3-MCP has no such facet (list_search_facets returns 233
//      facets, none named `deprecated`) and rejects the WHOLE search with a
//      plain-text "Search rejected: …" string. So every label search failed.
//   6. VFB3-MCP returns a flat { results: [...], total, … } envelope, but this
//      client was written against Solr's { response: { docs, numFound } }. Even
//      a successful search therefore looked empty to pickBestTermId.
//   7. controller.nextAction re-issued resolve_terms for any term whose id was
//      null — and a failed resolution records exactly that — so one unmatched
//      term span the loop until the round budget ran out, after which the
//      synthesiser wrote a confident false absence from an empty ledger.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeVfbSearchPayloadShape,
  stripUnsupportedVfbSearchFacets,
  planVfbSearchFacetRetry
} from '../../app/api/chat/route.js'
import { pickBestTermId } from '../../lib/orchestrator.mjs'
import { nextAction } from '../../lib/controller.mjs'
import { createLedger, addTerm } from '../../lib/ledger.mjs'

// The shape VFB3-MCP actually returns for search_terms.
const MCP_ENVELOPE = {
  query: 'DA1 lPN',
  unique: true,
  start: 0,
  returned: 2,
  total: 17,
  distinct_terms: 17,
  results: [
    { id: 'FBbt_00067363', short_form: 'FBbt_00067363', label: 'adult antennal lobe projection neuron DA1 lPN' },
    { id: 'VFB_fw035286', short_form: 'VFB_fw035286', label: 'DA1_lPN (FlyWire)' }
  ]
}

// ── Defect 6: response envelope ─────────────────────────────────────────────

test('normalizeVfbSearchPayloadShape bridges the MCP flat envelope to the Solr shape', () => {
  const out = normalizeVfbSearchPayloadShape(JSON.parse(JSON.stringify(MCP_ENVELOPE)))
  assert.ok(Array.isArray(out.response?.docs), 'response.docs must exist after normalising')
  assert.equal(out.response.docs.length, 2)
  assert.equal(out.response.docs[0].short_form, 'FBbt_00067363')
  assert.equal(out.response.numFound, 17, 'numFound comes from total, not the page size')
  assert.equal(out.response.start, 0)
  assert.ok(Array.isArray(out.results), 'the original flat key is left in place for any reader that wants it')
})

test('normalizeVfbSearchPayloadShape leaves an already-Solr-shaped payload untouched', () => {
  const solr = { response: { docs: [{ short_form: 'FBbt_00067363' }], numFound: 1 } }
  const out = normalizeVfbSearchPayloadShape(solr)
  assert.equal(out, solr)
  assert.equal(out.response.numFound, 1)
})

test('normalizeVfbSearchPayloadShape is a no-op on non-search payloads', () => {
  assert.equal(normalizeVfbSearchPayloadShape(null), null)
  assert.equal(normalizeVfbSearchPayloadShape('some text'), 'some text')
  const noResults = { error: 'boom' }
  assert.equal(normalizeVfbSearchPayloadShape(noResults), noResults)
})

test('pickBestTermId reads the flat MCP envelope, not only the Solr shape', () => {
  // The pre-fix code read search?.response?.docs only, so this returned null and
  // no term ever resolved.
  const id = pickBestTermId(MCP_ENVELOPE, 'DA1 lPN')
  assert.ok(id, 'a match must be found in a flat { results: [...] } payload')
  assert.match(id, /^(FBbt_00067363|VFB_fw035286)$/)
})

test('pickBestTermId still reads the Solr shape', () => {
  const solr = { response: { docs: MCP_ENVELOPE.results, numFound: 2 } }
  assert.equal(pickBestTermId(solr, 'DA1 lPN'), pickBestTermId(MCP_ENVELOPE, 'DA1 lPN'))
})

// ── Defect 5: retired search facet ──────────────────────────────────────────

test('stripUnsupportedVfbSearchFacets drops the retired `deprecated` facet entirely', () => {
  const out = stripUnsupportedVfbSearchFacets({ query: 'DA1 lPN', rows: 10, exclude_types: ['deprecated'] })
  assert.equal('exclude_types' in out, false, 'a now-empty facet list must be removed, not sent as []')
  assert.equal(out.query, 'DA1 lPN')
  assert.equal(out.rows, 10)
})

test('stripUnsupportedVfbSearchFacets keeps the facet values the server still knows', () => {
  const out = stripUnsupportedVfbSearchFacets({ exclude_types: ['deprecated', 'expression_pattern'], filter_types: ['neuron'] })
  assert.deepEqual(out.exclude_types, ['expression_pattern'])
  assert.deepEqual(out.filter_types, ['neuron'])
})

test('stripUnsupportedVfbSearchFacets returns the original object when nothing needs stripping', () => {
  const args = { query: 'DA1 lPN', filter_types: ['neuron'] }
  assert.equal(stripUnsupportedVfbSearchFacets(args), args)
})

test('planVfbSearchFacetRetry drops the value the server names in its rejection', () => {
  const args = { query: 'DA1 lPN', exclude_types: ['expression_pattern', 'something_retired'] }
  const rejection = "Search rejected: exclude_types: unknown type 'something_retired'. GET /facets lists every type name."
  const retry = planVfbSearchFacetRetry(args, rejection)
  assert.deepEqual(retry.exclude_types, ['expression_pattern'])
  assert.equal(retry.query, 'DA1 lPN')
  assert.notEqual(retry, args, 'the retry must be a copy, not a mutation of the given args')
  assert.deepEqual(args.exclude_types, ['expression_pattern', 'something_retired'], 'original args untouched')
})

test('planVfbSearchFacetRetry removes the key when the last value goes', () => {
  const retry = planVfbSearchFacetRetry(
    { query: 'x', boost_types: ['gone'] },
    "Search rejected: boost_types: unknown type 'gone'."
  )
  assert.equal('boost_types' in retry, false)
})

test('planVfbSearchFacetRetry returns null for a normal (non-rejection) response', () => {
  assert.equal(planVfbSearchFacetRetry({ exclude_types: ['x'] }, JSON.stringify(MCP_ENVELOPE)), null)
  assert.equal(planVfbSearchFacetRetry({}, ''), null)
})

test('planVfbSearchFacetRetry does not loop when the named value is not in the args', () => {
  // Guards against an infinite retry if the server ever names something we did
  // not send: no change is possible, so do not retry.
  assert.equal(
    planVfbSearchFacetRetry({ exclude_types: ['kept'] }, "Search rejected: exclude_types: unknown type 'other'."),
    null
  )
})

// ── Defect 7: the resolve_terms livelock ────────────────────────────────────

function ledgerNeeding(name) {
  const ledger = createLedger('where are DA1 lPN neurons?')
  ledger.termsToResolve = [name]
  ledger.plan = []
  return ledger
}

test('a term VFB cannot match is attempted exactly once', () => {
  const ledger = ledgerNeeding('not a real neuron')
  assert.equal(nextAction(ledger).action, 'resolve_terms', 'first pass must try to resolve')

  // This is what resolveTerms records on a failed search.
  addTerm(ledger, 'not a real neuron', { id: null, attempted: true })

  const after = nextAction(ledger)
  assert.notEqual(after.action, 'resolve_terms',
    'a second identical search cannot succeed — re-issuing it burned the whole round budget')
  // It moves on: with no VFB match the controller escalates to doc/literature
  // retrieval, or writes up what it has. Either is progress; resolve_terms is not.
  assert.ok(['retrieve', 'synthesise'].includes(after.action), `unexpected action ${after.action}`)
})

test('a term that has not been attempted is still resolved', () => {
  const ledger = ledgerNeeding('DA1 lPN')
  addTerm(ledger, 'DA1 lPN', { id: null })
  const action = nextAction(ledger)
  assert.equal(action.action, 'resolve_terms')
  assert.deepEqual(action.terms, ['DA1 lPN'])
})

test('a successfully resolved term is not re-resolved', () => {
  const ledger = ledgerNeeding('DA1 lPN')
  addTerm(ledger, 'DA1 lPN', { id: 'FBbt_00067363', attempted: true })
  assert.notEqual(nextAction(ledger).action, 'resolve_terms')
})
