// The resolve ladder under a wall-clock allowance.
//
// The ladder is a sequence of increasingly speculative attempts at one name:
// search it, search its spelling variants, sweep the dataset index, then fetch
// its term info. The rungs are NOT of equal value. The first search and the
// term-info fetch are what the answer is made of; the variants and the dataset
// sweep are extra chances at a name that has not matched yet.
//
// When VFB is healthy the whole descent costs a second or two and the allowance
// never binds — which is most of what these tests check, because a latency guard
// that quietly changes behaviour on a fast day is worse than no guard.
//
// When VFB is slow, the optional rungs are where the minutes went (W9.2: 181 s
// inside resolve, before any data query ran) and they are also the rungs it
// costs least to abandon. So they are skipped — and the abandonment is RECORDED,
// because "we stopped looking" and "VFB's search returned nothing" are different
// facts and only one of them is about VFB.
//
// A NOTE ON THE QUESTION USED THROUGHOUT. It is "How are Kenyon cells classified
// in VFB?" rather than the shorter "What is a Kenyon cell?" because the latter is
// caught by the definitional FAST PATH, which takes its term straight from the
// question text and never consults the plan. The term resolved would then be
// "Kenyon cell" — already singular — so the variant rung these tests exist to
// exercise would never fire at all, and every assertion here would pass or fail
// for reasons having nothing to do with the budget. Do not shorten it.
//
// Run: node --test tests/unit/resolveBudget.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHarness } from '../../lib/orchestrator.mjs'

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

// `resolveBudgetMs: 1` means "already spent": remaining is 1 ms, which is under
// the attempt floor from the first instant, so every optional rung is skipped.
// It exercises the exhausted path without a test that actually waits a minute —
// a test too slow to run is a test that stops being run.
function makeDeps(hits, { term = 'Kenyon cells', resolveBudgetMs } = {}) {
  const calls = { searches: [], datasets: 0 }
  return {
    calls,
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 4,
    ...(resolveBudgetMs === undefined ? {} : { resolveBudgetMs }),
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
      if (name === 'vfb_run_query' || name === 'vfb_get_all_datasets') {
        calls.datasets += 1
        return { rows: [] }
      }
      if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'Kenyon cell', Publications: [] }
      return { ok: true }
    }
  }
}

const KENYON_CELL = { short_form: 'FBbt_00003686', label: 'Kenyon cell' }

// --- the allowance must be invisible on a healthy backend --------------------

test('a generous budget changes nothing: the variant retry still runs and resolves', async () => {
  // The measured case the retry exists for. "Kenyon cells" returns 51 subtype
  // documents with the general class absent; "Kenyon cell" returns it at rank 6.
  const deps = makeDeps({ 'Kenyon cell': KENYON_CELL }, { resolveBudgetMs: 60000 })
  const r = await runHarness('How are Kenyon cells classified in VFB?', deps)

  assert.deepEqual(deps.calls.searches, ['Kenyon cells', 'Kenyon cell'])
  assert.equal(r.ledger.terms['Kenyon cells'].id, 'FBbt_00003686')
  assert.ok(!r.trace.some(e => e.resolve_budget_spent), 'nothing was skipped')
})

test('the default budget is generous enough that no test above ever notices it', async () => {
  // No override at all — the production path. Sixty seconds is not a limit any
  // healthy lookup approaches, and this pins that the guard is off by default
  // rather than merely large.
  const deps = makeDeps({ 'Kenyon cell': KENYON_CELL })
  const r = await runHarness('How are Kenyon cells classified in VFB?', deps)
  assert.deepEqual(deps.calls.searches, ['Kenyon cells', 'Kenyon cell'])
  assert.equal(r.ledger.terms['Kenyon cells'].id, 'FBbt_00003686')
})

// --- the allowance biting -----------------------------------------------------

test('a spent budget skips the variant searches and says so in the trace', async () => {
  const deps = makeDeps({ 'Kenyon cell': KENYON_CELL }, { resolveBudgetMs: 1 })
  const r = await runHarness('How are Kenyon cells classified in VFB?', deps)

  assert.deepEqual(deps.calls.searches, ['Kenyon cells'], 'only the mandatory first search ran')
  const skipped = r.trace.find(e => e.resolve_budget_spent === 'Kenyon cells')
  assert.ok(skipped, 'the abandonment is recorded, not silent')
  assert.equal(skipped.at, 'variants')
})

test('the mandatory rungs are NOT skipped — a spent budget still resolves what it can', async () => {
  // The allowance governs the SPECULATIVE rungs. If the first search already
  // found the term, cutting the ladder short must cost nothing at all: the
  // resolution stands and the term info is still fetched.
  const deps = makeDeps({ 'Kenyon cells': KENYON_CELL }, { resolveBudgetMs: 1 })
  const r = await runHarness('How are Kenyon cells classified in VFB?', deps)

  assert.deepEqual(deps.calls.searches, ['Kenyon cells'])
  assert.equal(r.ledger.terms['Kenyon cells'].id, 'FBbt_00003686')
  assert.ok(!r.trace.some(e => e.resolve_budget_spent), 'a resolution needs no extra chances')
})

test('a cut-short lookup is marked truncated, and a completed one is not', async () => {
  // This flag is the whole point: it is what stops the synthesis prompt saying
  // "VFB's search returned nothing for this wording" about wordings that were
  // never searched.
  const cut = makeDeps({}, { resolveBudgetMs: 1 })
  const cutRun = await runHarness('How are Kenyon cells classified in VFB?', cut)
  const cutTerm = cutRun.ledger.terms['Kenyon cells']
  assert.equal(cutTerm.id, null)
  assert.equal(cutTerm.attempted, true, 'still attempted, so the controller does not loop on it')
  assert.equal(cutTerm.truncated, true)

  const full = makeDeps({}, { resolveBudgetMs: 60000 })
  const fullRun = await runHarness('How are Kenyon cells classified in VFB?', full)
  const fullTerm = fullRun.ledger.terms['Kenyon cells']
  assert.equal(fullTerm.id, null)
  assert.equal(fullTerm.truncated, false, 'a search that finished really did come back empty')
})

test('the user is told the lookup is slow rather than left watching a spinner', async () => {
  const statuses = []
  const deps = makeDeps({}, { resolveBudgetMs: 1 })
  deps.onStatus = ({ message }) => statuses.push(message)
  await runHarness('How are Kenyon cells classified in VFB?', deps)
  assert.ok(statuses.some(m => /slow/i.test(m)), statuses.join(' | '))
})

// --- what the synthesiser is told --------------------------------------------

test('a truncated lookup is reported as an abandoned search, never as an empty one', async () => {
  // The two sentences are not interchangeable. "The search returned nothing" is
  // a claim about VFB's index and is FALSE here, because the skipped wordings
  // are exactly the ones that resolve plurals and acronyms.
  const messages = []
  const deps = makeDeps({}, { resolveBudgetMs: 1 })
  deps.callText = async (o) => { messages.push(o.messages.map(m => m.content).join('\n')); return 'FINAL ANSWER' }
  await runHarness('How are Kenyon cells classified in VFB?', deps)

  const prompt = messages.join('\n')
  assert.match(prompt, /too slow to finish/)
  assert.match(prompt, /says NOTHING about whether VFB holds this term/)
  assert.ok(!/returned nothing at all for this wording/.test(prompt),
    'the completed-and-empty wording must not appear for a lookup that did not complete')
  // …and the advice must not blame the name, which was never rejected.
  assert.match(prompt, /asking again is likely to work/)
})

test('a genuinely empty search keeps its own wording', async () => {
  // The new branch must be additive. When the ladder DID finish and found
  // nothing, that is a real observation and it should still be reported as one.
  const messages = []
  const deps = makeDeps({}, { resolveBudgetMs: 60000 })
  deps.callText = async (o) => { messages.push(o.messages.map(m => m.content).join('\n')); return 'FINAL ANSWER' }
  await runHarness('How are Kenyon cells classified in VFB?', deps)

  const prompt = messages.join('\n')
  assert.match(prompt, /returned nothing at all for this wording/)
  assert.ok(!/too slow to finish/.test(prompt))
  assert.ok(!/asking again is likely to work/.test(prompt))
})
