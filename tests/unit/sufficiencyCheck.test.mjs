// Seven of twenty workshop questions were answered with a false denial — "VFB
// does not currently hold data on the input and output neurons of the mushroom
// body" about a term whose own digest advertises 366 presynaptic and 304
// postsynaptic records. In every case a query sat available and un-run: the
// deterministic injectors are keyed on the QUESTION's wording, so each one
// misses whenever a question is phrased outside its pattern, and a miss reaches
// synthesis as an empty evidence block that the absence rule renders as an
// absence.
//
// Two halves are covered here. The deterministic layer, widened to reach three
// cases it was missing (a region asked about connectivity, a counted query
// asked for its members, a question resolving two terms). And the ledger-level
// sufficiency check, which catches what no regex will: before synthesis it asks
// the model whether the evidence answers the question and, if not, WHICH of the
// un-run queries to run — so it can name the query and send the loop round
// again, rather than criticising prose the reader has already been streamed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTermInfoDigest } from '../../lib/termInfoDigest.mjs'
import { maybeInjectCountQueryStep, pickQueriesByIntent, runHarness } from '../../lib/orchestrator.mjs'
import {
  shouldCheckSufficiency, unrunQueries, ledgerIsThin, isDefinitionalQuestion,
  selectPicks, maybeInjectSufficiencyQueries
} from '../../lib/sufficiency.mjs'

const countedQuery = (query, label, count) => ({
  query, label, count, output_format: 'table',
  preview_results: { status: 'complete', headers: {}, rows: [] }
})
const pendingQuery = (query, label) => ({
  query, label, count: -1, output_format: 'table',
  preview_results: { status: 'pending', headers: {}, rows: [] }
})

// A synaptic neuropil: its neuron queries are COUNTED (VFB knows it holds 366)
// and their semantic kind is class_list, not connectivity — the two facts that
// between them defeated every injector.
const REGION = {
  Id: 'FBbt_00005801', Name: 'mushroom body',
  Meta: { Name: '[mushroom body](FBbt_00005801)' },
  SuperTypes: ['Entity', 'Class', 'Anatomy', 'Synaptic_neuropil'],
  Images: {}, Examples: {},
  Queries: [
    countedQuery('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in mushroom body', 366),
    countedQuery('NeuronsPostsynapticHere', 'Neurons with postsynaptic terminals in mushroom body', 304),
    pendingQuery('PartsOf', 'Parts of mushroom body'),
    pendingQuery('NeuronsPartHere', 'Neurons with some part in mushroom body')
  ]
}

const NT_CLASS = {
  Id: 'FBbt_00058205', Name: 'cholinergic neuron',
  Meta: { Name: '[cholinergic neuron](FBbt_00058205)' },
  SuperTypes: ['Entity', 'Class', 'Neuron', 'Cell', 'Anatomy'],
  Images: {}, Examples: {},
  Queries: [pendingQuery('SubclassesOf', 'Subclasses of cholinergic neuron')]
}

const termFor = (info) => ({ id: info.Id, label: info.Name, info, digest: buildTermInfoDigest(info) })

// The shape the harness reaches synthesis with when it resolved its terms, read
// their descriptions, and stopped: evidence exists, but no STEP produced any.
const ledgerFor = (question, ...infos) => ({
  question,
  plan: [{ id: 's1', tool: 'vfb_get_term_info', status: 'satisfied' }],
  evidence: [{ claim: 'mushroom body is a paired neuropil …', source: 'vfb' }],
  terms: Object.fromEntries(infos.map(i => [i.Name, termFor(i)]))
})

// ---------------------------------------------------------------------------
// The deterministic layer
// ---------------------------------------------------------------------------

test('a region asked a connectivity question routes to its class-list synaptic queries', () => {
  // The connectivity rule matches this wording, but a region has no
  // connectivity-KIND query — its synaptic queries return neurons, so their
  // kind is class_list. Not being exclusive, the rule fell through, and nothing
  // else claimed the question. No query ran.
  const picks = pickQueriesByIntent(
    'What are the main input and output neurons of the mushroom body?',
    buildTermInfoDigest(REGION)
  )
  assert.deepEqual(picks.map(p => p.query_type), ['NeuronsPresynapticHere', 'NeuronsPostsynapticHere'])
})

test('a question naming ONE direction still gets one query, not both', () => {
  const picks = pickQueriesByIntent(
    'Which neurons are presynaptic in the mushroom body?',
    buildTermInfoDigest(REGION)
  )
  assert.deepEqual(picks.map(p => p.query_type), ['NeuronsPresynapticHere'])
})

test('a COUNTED query still runs when the question wants the members, not the count', () => {
  // countKind === 'unknown' was the old gate. A counted query is exactly the
  // case where VFB knows it holds 366 records and has fetched none of them.
  const ledger = ledgerFor('Which neurons are presynaptic in the mushroom body? List them.', REGION)
  maybeInjectCountQueryStep(ledger, ledger.question)
  const injected = ledger.plan.filter(s => s.tool === 'vfb_run_query')
  assert.equal(injected.length, 1)
  assert.equal(injected[0].args.query_type, 'NeuronsPresynapticHere')
})

test('a counted query with the whole list already in the preview needs no round', () => {
  const small = {
    ...REGION,
    Queries: [{
      query: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in mushroom body',
      count: 1, output_format: 'table',
      preview_results: { status: 'complete', headers: {}, rows: [{ label: '[KCg](VFB_1)' }] }
    }]
  }
  const ledger = ledgerFor('Which neurons are presynaptic in the mushroom body? List them.', small)
  maybeInjectCountQueryStep(ledger, ledger.question)
  assert.equal(ledger.plan.filter(s => s.tool === 'vfb_run_query').length, 0)
})

test('TWO resolved terms no longer abandon the question entirely', () => {
  // The old `terms.length !== 1` bail ran no query at all for a question that
  // resolved two perfectly good terms, each with queries waiting. The region's
  // four class-list queries tie on this phrasing so label overlap declines for
  // it — which is precisely the residue the sufficiency check exists to cover.
  const ledger = ledgerFor('Which neurons in the mushroom body are cholinergic? List them.', REGION, NT_CLASS)
  maybeInjectCountQueryStep(ledger, ledger.question)
  const injected = ledger.plan.filter(s => s.tool === 'vfb_run_query')
  assert.ok(injected.length >= 1, 'at least one term must now be queried')
  assert.deepEqual(injected.map(s => s.args.id), ['FBbt_00058205'])
})

test('one term answered does not count as looking at the other', () => {
  // ledgerIsThin was whole-ledger: any answered step made the ledger read
  // "fed", suppressing the check for a term nobody had queried at all.
  const l = ledgerFor('Which neurons in the mushroom body are cholinergic? List them.', REGION, NT_CLASS)
  maybeInjectCountQueryStep(l, l.question)
  const step = l.plan.find(s => s.tool === 'vfb_run_query')
  step.status = 'satisfied'
  l.evidence.push({ claim: 'VFB lists 41 subclasses of cholinergic neuron', source: 'vfb', stepId: step.id })

  assert.equal(ledgerIsThin(l), true, 'the region is still unlooked-at')
  assert.equal(shouldCheckSufficiency(l), true)
  assert.ok(unrunQueries(l).some(c => c.id === 'FBbt_00005801'))

  l.plan.push({ id: 's9', tool: 'vfb_run_query', args: { id: 'FBbt_00005801', query_type: 'NeuronsPresynapticHere' }, status: 'satisfied' })
  l.evidence.push({ claim: '366 neurons presynaptic here', source: 'vfb', stepId: 's9' })
  assert.equal(ledgerIsThin(l), false, 'now both terms have been looked at')
  assert.equal(shouldCheckSufficiency(l), false)
})

test('an unattributable step counts as covering the ledger', () => {
  // A macro step carries no args.id, so we cannot say which term it covered.
  // Evidence from a step we cannot place is evidence all the same — better to
  // skip a check than to re-query on top of work already done.
  const l = ledgerFor('What is similar to KCg?', REGION)
  l.plan.push({ id: 's2', tool: 'vfb_find_similar_neurons', args: {}, status: 'satisfied' })
  l.evidence.push({ claim: 'NBLAST returned 20 hits', source: 'vfb', stepId: 's2' })
  assert.equal(ledgerIsThin(l), false)
})

test('a count question with two resolved terms still declines — which one is being counted?', () => {
  const ledger = ledgerFor('How many neurons are in the mushroom body and cholinergic neuron?', REGION, NT_CLASS)
  maybeInjectCountQueryStep(ledger, ledger.question)
  assert.equal(ledger.plan.filter(s => s.tool === 'vfb_run_query').length, 0)
})

// ---------------------------------------------------------------------------
// The pre-filter: who gets a check at all
// ---------------------------------------------------------------------------

test('ledgerIsThin is about STEPS, not about evidence existing', () => {
  assert.equal(ledgerIsThin({ evidence: [] }), true)
  assert.equal(ledgerIsThin({ evidence: [{ claim: 'a', source: 'vfb' }] }), true,
    'term-info evidence carries no stepId — resolving a term is not answering a question')
  assert.equal(ledgerIsThin({ evidence: [{ claim: 'a', source: 'vfb', stepId: 's2' }] }), false)
})

test('isDefinitionalQuestion separates "what IS it" from "what data does it have"', () => {
  assert.equal(isDefinitionalQuestion('What is the mushroom body?'), true)
  assert.equal(isDefinitionalQuestion('Tell me about KCg'), true)
  assert.equal(isDefinitionalQuestion('What are the input neurons of the mushroom body?'), false)
  assert.equal(isDefinitionalQuestion('What is the neurotransmitter of KCg?'), false,
    'a neurotransmitter is data VFB holds, not a definition')
  assert.equal(isDefinitionalQuestion('Which GAL4 lines label the mushroom body?'), false)
})

test('the pre-filter fires on a thin ledger with queries left unrun', () => {
  const ledger = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)
  assert.equal(shouldCheckSufficiency(ledger), true)
})

test('the pre-filter declines wherever a check could not help', () => {
  const base = () => ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)

  const fed = base()
  fed.plan.push({ id: 's2', tool: 'vfb_run_query', args: { id: 'FBbt_00005801', query_type: 'NeuronsPresynapticHere' }, status: 'satisfied' })
  fed.evidence.push({ claim: '366 rows', source: 'vfb', stepId: 's2' })
  assert.equal(shouldCheckSufficiency(fed), false, 'a step already answered')

  const doc = base()
  doc.evidence.push({ claim: 'the docs explain this', source: 'doc' })
  assert.equal(shouldCheckSufficiency(doc), false, 'documentation answered it')

  const def = ledgerFor('What is the mushroom body?', REGION)
  assert.equal(shouldCheckSufficiency(def), false, 'definitional')

  const done = base()
  done._sufficiencyChecked = true
  assert.equal(shouldCheckSufficiency(done), false, 'already checked once')

  const all = base()
  for (const q of ['NeuronsPresynapticHere', 'NeuronsPostsynapticHere', 'PartsOf', 'NeuronsPartHere']) {
    all.plan.push({ id: `p${q}`, tool: 'vfb_run_query', args: { id: 'FBbt_00005801', query_type: q }, status: 'pending' })
  }
  assert.equal(shouldCheckSufficiency(all), false, 'nothing left to offer')
})

test('unrunQueries excludes what is already planned, per term', () => {
  const ledger = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION, NT_CLASS)
  ledger.plan.push({ id: 's2', tool: 'vfb_run_query', args: { id: 'FBbt_00005801', query_type: 'NeuronsPresynapticHere' }, status: 'pending' })
  const types = unrunQueries(ledger).map(c => c.query_type)
  assert.ok(!types.includes('NeuronsPresynapticHere'), 'the planned one is gone')
  assert.ok(types.includes('NeuronsPostsynapticHere'))
  assert.ok(types.includes('SubclassesOf'), 'the other term is untouched by that plan step')
})

test('selectPicks maps numbers back to queries and drops anything invented', () => {
  const candidates = [
    { id: 'A', query_type: 'One' }, { id: 'A', query_type: 'Two' },
    { id: 'B', query_type: 'One' }, { id: 'B', query_type: 'Three' }
  ]
  assert.deepEqual(selectPicks({ picks: [3, 1] }, candidates).map(c => `${c.id}:${c.query_type}`), ['B:One', 'A:One'])
  assert.deepEqual(selectPicks({ picks: [99, 0, -2] }, candidates), [], 'out-of-range numbers are dropped')
  assert.deepEqual(selectPicks({ picks: [2, 2, 2] }, candidates).length, 1, 'deduped')
  assert.equal(selectPicks({ picks: [1, 2, 3, 4] }, candidates).length, 3, 'capped')
  assert.deepEqual(selectPicks({ answerable: true, picks: [] }, candidates), [])
})

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

const structuredMock = (verdict, seen = {}) => ({
  callStructured: async ({ messages, schemaName }) => {
    seen.calls = (seen.calls || 0) + 1
    seen.prompt = messages.map(m => m.content).join('\n')
    seen.schemaName = schemaName
    return { ok: true, value: verdict }
  }
})

test('the check injects the query it names, and only ever runs once', async () => {
  const ledger = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)
  const seen = {}
  const deps = structuredMock({ answerable: false, picks: [1], reason: 'no synaptic partners retrieved' }, seen)

  assert.equal(await maybeInjectSufficiencyQueries(ledger, deps), true)
  assert.equal(seen.calls, 1)
  assert.match(seen.prompt, /NOT YET RUN/, 'the offer must be framed as queries that have not run')

  const injected = ledger.plan.filter(s => s.sufficiency_query)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].status, 'pending')
  assert.equal(injected[0].tool, 'vfb_run_query')
  assert.equal(injected[0].args.query_type, 'NeuronsPresynapticHere')

  // One shot per question: it cannot compound the latency tail.
  assert.equal(await maybeInjectSufficiencyQueries(ledger, deps), false)
  assert.equal(seen.calls, 1)
})

test('an "answerable" verdict costs one call and changes nothing', async () => {
  const ledger = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)
  const seen = {}
  const deps = structuredMock({ answerable: true, picks: [] }, seen)
  assert.equal(await maybeInjectSufficiencyQueries(ledger, deps), false)
  assert.equal(seen.calls, 1)
  assert.equal(ledger.plan.filter(s => s.sufficiency_query).length, 0)
})

test('a failed or malformed check falls through to synthesis rather than blocking', async () => {
  const thrown = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)
  assert.equal(await maybeInjectSufficiencyQueries(thrown, {
    callStructured: async () => { throw new Error('model unavailable') }
  }), false)
  assert.equal(thrown._sufficiencyChecked, true, 'a failure still spends the one shot')

  const refused = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)
  assert.equal(await maybeInjectSufficiencyQueries(refused, { callStructured: async () => ({ ok: false }) }), false)
  assert.equal(refused._sufficiencyChecked, true)
})

test('a well-fed ledger never reaches the model at all', async () => {
  const ledger = ledgerFor('What are the main input and output neurons of the mushroom body?', REGION)
  ledger.plan.push({ id: 's2', tool: 'vfb_run_query', args: { id: 'FBbt_00005801', query_type: 'NeuronsPresynapticHere' }, status: 'satisfied' })
  ledger.evidence.push({ claim: '366 rows', source: 'vfb', stepId: 's2' })
  let called = 0
  await maybeInjectSufficiencyQueries(ledger, { callStructured: async () => { called++; return { ok: true, value: {} } } })
  assert.equal(called, 0)
})

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('the harness runs the check before synthesising, and runs what it names', async () => {
  let sufficiencyAsked = 0
  const runQueryCalls = []

  const deps = {
    toolDefs: [
      { name: 'vfb_search_terms', purpose: 'search', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
      { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      { name: 'vfb_run_query', purpose: 'run a query', parameters: { type: 'object', required: ['id', 'query_type'], properties: { id: { type: 'string' }, query_type: { type: 'string' } } } },
      { name: 'vfb_find_genetic_tools', purpose: 'genetic tools', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
    ],
    callStructured: async ({ messages, schemaName }) => {
      if (schemaName === 'plan') {
        return { ok: true, value: { intent: 'genetic_tools', underspecified: false, clarifying_question: '', terms_to_resolve: ['mushroom body'], steps: [{ id: 's1', tool: 'vfb_find_genetic_tools', answers: ['gal4 lines'] }] } }
      }
      if (schemaName === 'sufficiency') {
        sufficiencyAsked++
        assert.match(messages.map(m => m.content).join('\n'), /NOT YET RUN/)
        return { ok: true, value: { answerable: false, picks: [1], reason: 'nothing about synaptic partners' } }
      }
      if (schemaName && schemaName.endsWith('_args')) return { ok: true, value: { id: REGION.Id, query: 'mushroom body', query_type: 'NeuronsPresynapticHere' } }
      return { ok: false }
    },
    callText: async () => 'An answer citing the retrieved rows.',
    runTool: async (name, args) => {
      if (name === 'vfb_search_terms') {
        return { response: { docs: [{ short_form: REGION.Id, label: REGION.Name, original_label: REGION.Name, facets_annotation: ['Entity', 'Class', 'Anatomy', 'Synaptic_neuropil'] }] } }
      }
      if (name === 'vfb_get_term_info') return REGION
      if (name === 'vfb_run_query') { runQueryCalls.push(args); return { rows: [{ label: '[KCg](VFB_1)' }, { label: '[MBON01](VFB_2)' }], count: 2 } }
      if (name === 'vfb_find_genetic_tools') return { results: [] }
      return {}
    },
    searchReviewedDocs: async () => [],
    getReviewedPage: async () => ''
  }

  // Deliberately a question NO deterministic injector claims: the region's four
  // class-list queries tie on this wording and label overlap declines, so
  // without the check nothing is queried and synthesis sees an empty block.
  const { ledger } = await runHarness('Which neurons in the mushroom body are cholinergic? List them.', deps, {})

  assert.equal(sufficiencyAsked, 1, 'the check runs exactly once, before synthesis')
  assert.equal(runQueryCalls.length, 1, 'and the query it named actually ran')
  const step = ledger.plan.find(s => s.sufficiency_query)
  assert.ok(step, 'the injected step is on the plan')
  assert.equal(step.status, 'satisfied')
  assert.ok(ledger.evidence.some(e => e.stepId === step.id), 'its rows reached the evidence')
})
