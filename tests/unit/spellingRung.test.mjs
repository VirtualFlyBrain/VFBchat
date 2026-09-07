// Regression tests for the resolver's spelling rung.
//
// The symptom (2026-09-07 feedback, rated wrong): "What does the anterior optic
// tubercule look like?" answered 'The name "anterior optic tubercule" could not
// be matched to a specific term in the VFB database' — and then, in the same
// answer, suggested searching for "anterior optic tubercle", the class VFB holds
// as FBbt_00007059. Nothing is called "tubercule": it is a misspelling, not a
// synonym, and Solr stems it differently from "tubercle". Measured live:
//
//   "anterior optic tubercule"   0 hits, and 0 for every variant
//   "anterior optic"            82 hits, FBbt_00007059 at rank 7
//
// Run: node --test tests/unit/spellingRung.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { editDistance, spellingProbes, spellingMatchId, runHarness } from '../../lib/orchestrator.mjs'

// --- editDistance ------------------------------------------------------------

test('editDistance is Levenshtein, and stops early past the bound', () => {
  assert.equal(editDistance('tubercule', 'tubercle'), 1)
  assert.equal(editDistance('tubercle', 'tubercle'), 0)
  assert.equal(editDistance('medula', 'medulla'), 1)
  assert.equal(editDistance('tubercule', 'tract'), 7)
  assert.equal(editDistance('tubercule', 'tract', 2), 3, 'bounded: anything over max reads as max+1')
})

// --- spellingProbes ----------------------------------------------------------

test('each probe is the name with one candidate word removed, longest first', () => {
  assert.deepEqual(spellingProbes('anterior optic tubercule'), [
    'anterior optic', 'optic tubercule', 'anterior tubercule'
  ])
})

test('short words are never the suspect, and a one-word name has no probe', () => {
  // "of" and "the" cannot be what went wrong in a way the rest can recover;
  // dropping them just re-runs a search that already failed.
  assert.deepEqual(spellingProbes('cortex of tubercule'), ['cortex of', 'of tubercule'])
  assert.deepEqual(spellingProbes('tubercule'), [])
  assert.deepEqual(spellingProbes(''), [])
  assert.deepEqual(spellingProbes(), [])
})

test('probes are capped so a long name cannot cost a search per word', () => {
  const probes = spellingProbes('lateral zone of anterior optic tubercule primordium')
  assert.equal(probes.length, 3)
})

// --- spellingMatchId ---------------------------------------------------------

const AOTU = { short_form: 'FBbt_00007059', label: 'OTU (anterior optic tubercle)', original_label: 'anterior optic tubercle', facets_annotation: ['Anatomy', 'Class'] }
const AOT = { short_form: 'FBbt_00100337', label: 'AOT (adult anterior optic tract)', original_label: 'adult anterior optic tract', facets_annotation: ['Anatomy', 'Class'] }
const LATERAL = { short_form: 'FBbt_00047046', label: 'lateral zone of anterior optic tubercle', original_label: 'lateral zone of anterior optic tubercle', facets_annotation: ['Anatomy', 'Class'] }

test('one word within a couple of edits, everything else identical, matches', () => {
  const hit = spellingMatchId({ response: { docs: [LATERAL, AOT, AOTU] } }, 'anterior optic tubercule')
  assert.equal(hit?.id, 'FBbt_00007059')
  assert.equal(hit?.dist, 1)
})

test('a same-shaped neighbour whose differing word is far away is refused', () => {
  // "anterior optic tract" has the three-word shape but "tract" is not a
  // misspelling of anything; without the class in the set there is no match.
  const tract = { ...AOT, original_label: 'anterior optic tract' }
  assert.equal(spellingMatchId({ response: { docs: [tract, LATERAL] } }, 'anterior optic tubercule'), null)
})

test('a name that already matches exactly is not a spelling match', () => {
  // Zero edits is the ladder's business, not this rung's: it must never claim
  // an exact match as a correction.
  assert.equal(spellingMatchId({ response: { docs: [AOTU] } }, 'anterior optic tubercle'), null)
})

test('two words wrong, or a different word count, is not a correction', () => {
  assert.equal(spellingMatchId({ response: { docs: [AOTU] } }, 'anterio optic tubercule'), null)
  assert.equal(spellingMatchId({ response: { docs: [AOTU] } }, 'optic tubercule'), null)
})

test('a short word is never corrected, so "lobe" cannot become "lobula"', () => {
  const lobula = { short_form: 'FBbt_00003852', label: 'lobula', original_label: 'lobula' }
  const optic = { short_form: 'FBbt_x', label: 'optic lobula', original_label: 'optic lobula' }
  assert.equal(spellingMatchId({ response: { docs: [lobula, optic] } }, 'optic lobe'), null)
})

test('a synonym can be the corrected spelling', () => {
  const doc = { short_form: 'FBbt_00007059', label: 'anterior optic tubercle', original_label: 'anterior optic tubercle', synonym: ['anterior optic tubercle', 'AOTU'] }
  assert.equal(spellingMatchId({ response: { docs: [doc] } }, 'anterior optic tubercule')?.id, 'FBbt_00007059')
})

// --- the rung inside resolveTerms -------------------------------------------

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

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
        const docs = hits[args.query]
        return docs ? { response: { docs } } : { response: { docs: [] } }
      }
      if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'anterior optic tubercle', Publications: [] }
      return { ok: true }
    }
  }
}

test('the feedback case: a misspelt word is corrected via the rest of the name', async () => {
  const deps = makeDeps({ 'anterior optic': [LATERAL, AOT, AOTU] }, 'anterior optic tubercule')
  const r = await runHarness('What does the anterior optic tubercule look like?', deps)

  assert.equal(r.ledger.terms['anterior optic tubercule'].id, 'FBbt_00007059')
  assert.ok(deps.calls.searches.includes('anterior optic'), 'the probe without the suspect word was searched')
  assert.ok(
    r.trace.some(e => e.resolve_spelling === 'anterior optic tubercule' && e.as === 'anterior optic tubercle' && e.edits === 1),
    'the correction is recorded in the trace'
  )
})

test('the rung never runs when the search already found documents', async () => {
  // A name with candidates has something to show the user; the probes are for
  // the case where the alternative is an abstention with nothing.
  const deps = makeDeps({ 'anterior optic tubercule': [AOT] }, 'anterior optic tubercule')
  await runHarness('What does the anterior optic tubercule look like?', deps)
  assert.ok(!deps.calls.searches.includes('anterior optic'), 'no probe was searched')
})

test('when no probe yields a correction, the term abstains as before', async () => {
  const deps = makeDeps({ 'anterior optic': [LATERAL, AOT] }, 'anterior optic tubercule')
  const r = await runHarness('What does the anterior optic tubercule look like?', deps)
  const term = r.ledger.terms['anterior optic tubercule']
  assert.equal(term.id, null)
  assert.equal(term.attempted, true)
})
