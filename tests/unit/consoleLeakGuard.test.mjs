// The container log must not contain the user's text. Asserted, not reviewed.
//
// Finding A1b was closed by lib/safeToolArgs.mjs, which renders tool arguments
// by shape rather than by value. Nothing asserted it stayed closed, and the
// surface had already been widened three times by diagnostics added for good
// reasons — each one caught by somebody reading the code rather than by a
// failing test. A guard nobody can regress past is worth more than a guard that
// was correct on the day it was written.
//
// WHAT THIS ACTUALLY TESTS
//
// Every path below is driven for real — runHarness with mocked ELM and MCP, the
// absence escalation, the absence gate, the tool-failure reporter — with a
// canary string planted where the user's text enters. The assertion is that the
// canary never reaches console.log/warn/error. It is a behavioural test, not a
// grep over the source, so a NEW diagnostic that interpolates user text fails it
// without anyone having to remember this file exists.
//
// The second half asserts the other direction: under VFB_HARNESS_TRACE the same
// values ARE printed. A privacy guard that cannot be switched off for debugging
// gets switched off by deleting it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { runHarness, maybeEscalateBeforeAbsence, gateAbsence } from '../../lib/orchestrator.mjs'
import { createLedger, addTerm } from '../../lib/ledger.mjs'
import { buildLiveDeps } from '../../lib/liveHarness.mjs'
import { safeText, safeToolArgs } from '../../lib/safeToolArgs.mjs'

// Distinctive enough that no legitimate diagnostic could produce it by accident,
// and shaped like the things users actually type: a phrase with spaces in it.
const CANARY = 'CANARY7Q'
const QUESTION = `does the ${CANARY} line from Kyoto label PAM neurons?`
const TERM_NAME = `${CANARY} expression pattern`

/** Run fn with all three console writers captured. Returns everything written. */
async function captureConsole(fn) {
  const written = []
  const originals = { log: console.log, warn: console.warn, error: console.error }
  const grab = (...args) => {
    written.push(args.map(a => {
      if (typeof a === 'string') return a
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' '))
  }
  console.log = grab; console.warn = grab; console.error = grab
  try { await fn() } finally { Object.assign(console, originals) }
  return written.join('\n')
}

/** Assert the canary is nowhere in what was written, quoting the log if it is. */
function assertNoLeak(output, what) {
  assert.ok(!output.includes(CANARY), `${what} wrote user text to the console:\n${output}`)
}

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

function harnessDeps({ termInfo }) {
  return {
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 6,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return {
          ok: true,
          value: {
            intent: 'term_info', underspecified: false, clarifying_question: '',
            terms_to_resolve: [TERM_NAME],
            steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: [QUESTION] }]
          }
        }
      }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      if (schemaName && schemaName.endsWith('_args')) return { ok: true, value: { id: 'FBbt_00000001' } }
      return { ok: false }
    },
    async callText() { return 'An answer.' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00000001', label: args.query }] } }
      if (name === 'vfb_get_term_info') return termInfo(args)
      return { ok: true }
    }
  }
}

// --- the request path ------------------------------------------------------

test('a term-info failure names the id, never the name the user typed', async () => {
  // The report exists to say WHICH lookup failed, and the ontology id says that
  // precisely. The requested name is often the user's own phrase.
  const output = await captureConsole(() => runHarness(QUESTION, harnessDeps({
    termInfo: () => ({ error: 'upstream 502' })
  })))
  assertNoLeak(output, 'the term-info failure report')
  assert.match(output, /get_term_info FAILED/, 'the diagnostic still fires')
  assert.match(output, /requested_id=FBbt_00000001/, 'and still says which lookup it was')
})

test('a deprecated-term redirect names both ids, never the name', async () => {
  const output = await captureConsole(() => runHarness(QUESTION, harnessDeps({
    termInfo: (args) => args.id === 'FBbt_00000001'
      ? { Id: args.id, Name: 'obsolete thing', SuperTypes: ['Class'], replaced_by: 'FBbt_00009999', Publications: [] }
      : { Id: args.id, Name: 'current thing', SuperTypes: ['Class', 'Anatomy'], Publications: [] }
  })))
  assertNoLeak(output, 'the deprecated-term redirect')
  assert.match(output, /deprecated term redirected \| term=<text:\d+> FBbt_00000001 -> FBbt_00009999/)
})

test('a whole harness run leaks nothing, on the ordinary path', async () => {
  const output = await captureConsole(() => runHarness(QUESTION, harnessDeps({
    termInfo: (args) => ({ Id: args.id, Name: 'medulla', SuperTypes: ['Class', 'Anatomy'], Publications: [] })
  })))
  assertNoLeak(output, 'an ordinary run')
})

// --- the absence pair ------------------------------------------------------
//
// Both of these print a sentence the MODEL wrote. That is not the user's typed
// text, which is exactly why it was not treated as one — but the model writes an
// absence by restating the question, so the question comes back out in it.

function absenceLedger() {
  const ledger = createLedger(QUESTION)
  // Queries the term advertises and nothing ran: the commonest way to arrive at
  // a denial, and the state the escalation exists for.
  addTerm(ledger, TERM_NAME, {
    id: 'FBbt_00000001', label: TERM_NAME,
    digest: {
      id: 'FBbt_00000001',
      name: 'expression pattern',
      queries: [
        { query_type: 'SubClasses', label: 'Subclasses of expression pattern', count: 34 },
        { query_type: 'TransgeneExpressionHere', label: 'Transgene expression here', count: 88 }
      ]
    },
    attempted: true
  })
  ledger.budget.toolRoundsLeft = 0
  return ledger
}

const DENIAL = `VFB does not currently hold data on the ${CANARY} line from Kyoto.`

test('the absence escalation reports its queries, not the sentence it read', async () => {
  const output = await captureConsole(() => maybeEscalateBeforeAbsence(absenceLedger(), DENIAL, {}, () => {}))
  assertNoLeak(output, 'the absence escalation')
  assert.match(output, /ABSENCE ESCALATION \| queries=/, 'the useful half survives')
  assert.match(output, /claimed=<text:\d+>/)
})

test('the absence gate reports how many it removed, not what they said', async () => {
  const ledger = absenceLedger()
  const output = await captureConsole(() => { gateAbsence(ledger, DENIAL, () => {}) })
  assertNoLeak(output, 'the absence gate')
  assert.match(output, /ABSENCE GATE \| removed=\d+/)
})

// --- tool failures ---------------------------------------------------------

test('a failing tool reports its arguments by shape', async () => {
  // startDocSearch passes the WHOLE user question as search_reviewed_docs'
  // `query`, on every non-underspecified turn. This is the path that broke the
  // promise the third time.
  const { deps } = buildLiveDeps({
    toolDefs: TOOL_DEFS,
    apiBaseUrl: 'https://elm.example/api/v1',
    apiKey: 'k',
    defaultModel: 'm',
    streamText: async () => 'x',
    collectGraphs: () => [],
    executeTool: async () => { throw new Error('reviewed docs unreachable') }
  })
  const output = await captureConsole(() => deps.runTool('search_reviewed_docs', { query: QUESTION, max_results: 5 }))
  assertNoLeak(output, 'the tool-failure report')
  assert.match(output, /TOOL FAILED \| tool=search_reviewed_docs/)
  assert.match(output, /query:<text:\d+>/)
  assert.match(output, /max_results:5/, 'the safe arguments are still legible')
})

// --- the escape hatch ------------------------------------------------------

test('VFB_HARNESS_TRACE prints the values in full, so the guard survives debugging', () => {
  // A privacy guard that cannot be switched off for debugging gets switched off
  // by deleting it. Both renderers take the flag the same way.
  assert.equal(safeText(QUESTION, { trace: true }), QUESTION)
  assert.equal(safeText(QUESTION, { trace: false }), `<text:${QUESTION.length}>`)
  assert.match(safeToolArgs({ query: QUESTION }, { trace: true }), /Kyoto/)
  assert.ok(!safeToolArgs({ query: QUESTION }, { trace: false }).includes('Kyoto'))
})

test('safeText reports a length for every shape of nothing', () => {
  assert.equal(safeText('', { trace: false }), '<text:0>')
  assert.equal(safeText(null, { trace: false }), '<text:0>')
  assert.equal(safeText(undefined, { trace: false }), '<text:0>')
  // The length is the WHOLE length, so a truncated preview cannot be mistaken
  // for the whole value when the flag is on.
  const long = 'x'.repeat(500)
  assert.equal(safeText(long, { trace: false }), '<text:500>')
  assert.equal(safeText(long, { trace: true, max: 10 }).length, 10)
})
