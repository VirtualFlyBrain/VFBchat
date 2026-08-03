// Regression tests for the plural search retry.
//
// The symptom: "How are visual system neurons classified in VFB?" answered "The
// name 'visual system neurons' could not be matched to a VFB term. There are no
// candidate matches listed." — about FBbt_00047736, a class VFB holds.
//
// The cause is upstream of anything this repo controls: VFB's Solr index does
// not stem multi-word phrases, so the plural scores zero where the singular
// scores many. Measured against v3-cached:
//
//   "visual system neurons"     0    "visual system neuron"      1
//   "medulla intrinsic neurons" 0    "medulla intrinsic neuron"  17
//
// Zero hits is the worst case for the harness, worse than a wrong match: with no
// documents at all searchCandidateLabels returns [] and the answer abstains with
// nothing to offer, which is the exact failure the candidate list was added to
// prevent. So a name that finds nothing gets one singularised retry.
//
// Run: node --test tests/unit/pluralSearchRetry.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { singularisePhrase, searchIsEmpty, runHarness } from '../../lib/orchestrator.mjs'

// --- singularisePhrase -------------------------------------------------------

test('every trailing-s word longer than three characters is singularised', () => {
  assert.equal(singularisePhrase('visual system neurons'), 'visual system neuron')
  assert.equal(singularisePhrase('medulla intrinsic neurons'), 'medulla intrinsic neuron')
  assert.equal(singularisePhrase('Kenyon cells'), 'Kenyon cell')
  // More than one plural word in the phrase: all of them go.
  assert.equal(singularisePhrase('optic lobe neurons cells'), 'optic lobe neuron cell')
})

test('returns null when there is nothing to singularise, so no retry is issued', () => {
  // The caller keys off null: a phrase the rule cannot change must not cost a
  // second identical search.
  assert.equal(singularisePhrase('visual system neuron'), null)
  assert.equal(singularisePhrase('medulla'), null)
  assert.equal(singularisePhrase(''), null)
  assert.equal(singularisePhrase(), null)
})

test('short words ending in s are left alone', () => {
  // The four-character floor is what keeps the rule off real names. "gas" and
  // "PNs" must survive; "eyes" is over the floor and is allowed to change.
  assert.equal(singularisePhrase('gas'), null)
  assert.equal(singularisePhrase('ALs'), null)
  assert.equal(singularisePhrase('eyes'), 'eye')
})

test('words that are not plain alphabetic are left alone', () => {
  // Ids, hyphenated names and anything carrying digits or punctuation are not
  // English plurals and must not be mangled into a search for a different thing.
  assert.equal(singularisePhrase('FBbt_00047736'), null)
  assert.equal(singularisePhrase('P-ENs'), null)
  assert.equal(singularisePhrase('5-HT7 neurons'), '5-HT7 neuron')
})

test('the original spacing is preserved exactly', () => {
  // The retry is a search query, so runs of whitespace must come back as they
  // went in rather than being collapsed.
  assert.equal(singularisePhrase('visual  system\tneurons'), 'visual  system\tneuron')
})

// --- searchIsEmpty -----------------------------------------------------------

test('searchIsEmpty recognises every envelope shape the resolver reads', () => {
  // These are the three shapes pickBestTermId and searchCandidateLabels accept;
  // the guard has to agree with them or it will retry a search that did find
  // something, or fail to retry one that did not.
  for (const empty of [{ response: { docs: [] } }, { docs: [] }, { results: [] }]) {
    assert.equal(searchIsEmpty(empty), true, JSON.stringify(empty))
  }
  const doc = { short_form: 'FBbt_00047736', label: 'visual system neuron' }
  for (const full of [{ response: { docs: [doc] } }, { docs: [doc] }, { results: [doc] }]) {
    assert.equal(searchIsEmpty(full), false, JSON.stringify(full))
  }
})

test('searchIsEmpty treats a missing or unparseable envelope as empty', () => {
  // parseMaybe hands back null when the tool errored or returned prose; that is
  // no documents, which is what the retry is for.
  assert.equal(searchIsEmpty(null), true)
  assert.equal(searchIsEmpty(undefined), true)
  assert.equal(searchIsEmpty({}), true)
  assert.equal(searchIsEmpty('not json'), true)
})

// --- the retry inside resolveTerms ------------------------------------------

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

// A harness whose search behaves like VFB's index: the exact strings in `hits`
// return documents, everything else returns an empty envelope.
function makeDeps(hits, term = 'visual system neurons') {
  const calls = { searches: [] }
  return {
    calls,
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 4,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return { ok: true, value: {
          intent: 'term_info', underspecified: false, clarifying_question: '',
          terms_to_resolve: [term], steps: []
        } }
      }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') {
        calls.searches.push(args.query)
        const doc = hits[args.query]
        return doc ? { response: { docs: [doc] } } : { response: { docs: [] } }
      }
      if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'visual system neuron', Publications: [] }
      return { ok: true }
    }
  }
}

const VISUAL_SYSTEM_NEURON = { short_form: 'FBbt_00047736', label: 'visual system neuron' }

test('a plural that finds nothing is retried in the singular and resolves', async () => {
  // The exact case that broke. Before the retry this term resolved to null with
  // an empty candidate list.
  const deps = makeDeps({ 'visual system neuron': VISUAL_SYSTEM_NEURON })
  const r = await runHarness('How are visual system neurons classified in VFB?', deps)

  assert.deepEqual(deps.calls.searches, ['visual system neurons', 'visual system neuron'])
  assert.equal(r.ledger.terms['visual system neurons'].id, 'FBbt_00047736')
  assert.ok(
    r.trace.some(e => e.resolve_retry === 'visual system neurons' && e.as === 'visual system neuron'),
    'the retry is recorded in the trace so a resolution can be explained afterwards'
  )
})

test('a search that already found something is never retried', async () => {
  // The retry must be incapable of changing or reordering a working resolution:
  // one search in, one search out.
  const deps = makeDeps({ 'visual system neurons': VISUAL_SYSTEM_NEURON })
  const r = await runHarness('How are visual system neurons classified in VFB?', deps)

  assert.deepEqual(deps.calls.searches, ['visual system neurons'])
  assert.equal(r.ledger.terms['visual system neurons'].id, 'FBbt_00047736')
  assert.ok(!r.trace.some(e => e.resolve_retry), 'no retry was logged')
})

test('when the singular finds nothing either, the term abstains as before', async () => {
  // The retry adds a chance, not a guarantee. A name VFB really does not hold
  // must still come back unresolved and attempted, so the controller does not
  // send it round the resolve loop again.
  const deps = makeDeps({})
  const r = await runHarness('How are visual system neurons classified in VFB?', deps)

  assert.deepEqual(deps.calls.searches, ['visual system neurons', 'visual system neuron'])
  const term = r.ledger.terms['visual system neurons']
  assert.equal(term.id, null)
  assert.equal(term.attempted, true)
})

test('a name with no plural to strip costs only the one search', async () => {
  const deps = makeDeps({}, 'medulla')
  await runHarness('What is the medulla?', deps)
  assert.deepEqual(deps.calls.searches, ['medulla'])
})

test('a bare ontology id still skips the search entirely', async () => {
  // The direct-id short-circuit runs before the retry; an id must never be
  // singularised or searched.
  const deps = makeDeps({}, 'FBbt_00047736')
  const r = await runHarness('What is FBbt_00047736?', deps)
  assert.deepEqual(deps.calls.searches, [])
  assert.equal(r.ledger.terms['FBbt_00047736'].id, 'FBbt_00047736')
})
