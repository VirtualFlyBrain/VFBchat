// The answer is not allowed to say VFB has nothing until somebody has looked.
//
// Every positive case below is a string production actually produced, at
// v4.2.1, against chat.virtualflybrain.org, in a blind evaluation of thirteen
// questions. Eight of the thirteen asserted an absence. None of the eight had a
// query behind it that had run and come back empty — which is the one state
// coverage.mjs says licenses an absence, in a header that has said so since the
// four-state model was introduced.
//
// The Greek cases are measured too. Against the live VFB MCP:
//
//   "γ Kenyon cell"    0 documents    "gamma Kenyon cell"    FBbt_00100247 exact
//   "α/β Kenyon cell"  0 documents    "alpha/beta Kenyon cell" FBbt_00100248 exact
//   "MBON-γ1pedc>α/β"  0 documents    "MBON-gamma1pedc>alpha/beta" FBbt_00100246 rank 1
//   "MBON-α′1"        80 documents, the term not among the first ten
//                                    "MBON-alpha'1"          FBbt_00111010 rank 1

import test from 'node:test'
import assert from 'node:assert/strict'
import { asciiSpelling, transliterateGreek, normaliseTypography, hasGreek } from '../../lib/nameNormalise.mjs'
import { nameVariants, maybeEscalateBeforeAbsence, gateAbsence, ABSENCE_ESCALATION_DEADLINE_MS } from '../../lib/orchestrator.mjs'
import { nextAction } from '../../lib/controller.mjs'
import {
  absenceLicence, findAbsenceClaims, repairUnlicensedAbsences,
  planAbsenceEscalation, MAX_ESCALATION_STEPS
} from '../../lib/absence.mjs'
import { unmatchedNames, renderShelf, buildShelf, renderCoverageBlock } from '../../lib/coverage.mjs'
import { createLedger, addTerm, setPlan, addEvidence } from '../../lib/ledger.mjs'

// --- the names that could not be found ---------------------------------------

test('the Greek spellings VFB stores are reachable from the ones people type', () => {
  assert.equal(asciiSpelling('γ Kenyon cells'), 'gamma Kenyon cells')
  assert.equal(asciiSpelling('α/β Kenyon cells'), 'alpha/beta Kenyon cells')
  assert.equal(asciiSpelling('MBON-γ1pedc>α/β'), 'MBON-gamma1pedc>alpha/beta')
})

test('no separator is inserted — the ontology label has none', () => {
  // "gamma 1pedc" and "gamma-1pedc" both lose the exact match that is the whole
  // point of the rung. FBbt_00100246 is labelled MBON-gamma1pedc>alpha/beta.
  assert.equal(transliterateGreek('γ1pedc'), 'gamma1pedc')
})

test('a prime is an apostrophe, and an arrow is a greater-than', () => {
  // MBON compartment names are written α′1, α'1 and α’1 by different people and
  // stored as alpha'1. "MBON-α′1" returns eighty documents without the term.
  assert.equal(asciiSpelling('MBON-α′1'), "MBON-alpha'1")
  assert.equal(asciiSpelling('MBON-α’1'), "MBON-alpha'1")
  assert.equal(asciiSpelling('MBON-γ1pedc→α/β'), 'MBON-gamma1pedc>alpha/beta')
})

test('an ASCII name produces no transliteration variant at all', () => {
  // The rung must be free where it is not needed: a variant identical to the
  // original is a wasted round trip against the slowest part of a lookup.
  assert.equal(asciiSpelling('gamma Kenyon cell'), '')
  assert.equal(asciiSpelling('medulla'), '')
  assert.equal(hasGreek('medulla'), false)
})

test('em dashes and non-breaking spaces from a pasted PDF are normalised', () => {
  assert.equal(normaliseTypography('MBON–2'), 'MBON-2')
  assert.equal(normaliseTypography('Kenyon cell'), 'Kenyon cell')
})

test('the resolve ladder tries the ASCII spelling FIRST for a Greek name', () => {
  // Singularising "γ Kenyon cells" gives "γ Kenyon cell", which VFB answers with
  // zero documents exactly as the plural did — the γ is what it cannot match.
  const v = nameVariants('γ Kenyon cells')
  assert.equal(v[0], 'gamma Kenyon cells')
  assert.ok(v.includes('gamma Kenyon cell'), 'and the singular of the ASCII form is there too')
})

test('an ASCII plural still costs exactly one extra search, as before', () => {
  const v = nameVariants('lateral horn neurons')
  assert.equal(v[0], 'lateral horn neuron', 'the plural rung must still lead for an ASCII name')
})

// --- what a ledger licenses --------------------------------------------------

function ledgerWith (queries, { stepStatus = null, evidence = false } = {}) {
  const ledger = createLedger('are any mushroom body output neurons cholinergic?')
  addTerm(ledger, 'mushroom body output neuron', {
    id: 'FBbt_00100247',
    label: 'mushroom body output neuron',
    digest: { id: 'FBbt_00100247', name: 'mushroom body output neuron', queries },
    attempted: true
  })
  if (stepStatus) {
    setPlan(ledger, {
      steps: [{
        id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_00100247', query_type: queries[0].query_type },
        status: stepStatus.status
      }]
    })
    // setPlan normalises a plan down to its known fields, and empty_result is
    // written by the runner afterwards — it is the flag that separates "ran and
    // returned nothing" from "fell over", so it has to be set the same way here.
    ledger.plan[0].empty_result = stepStatus.empty
    if (evidence) addEvidence(ledger, { stepId: 's1', source: 'vfb', claim: 'x' })
  }
  return ledger
}

const Q = [
  { query_type: 'SubClasses', label: 'Subclasses of mushroom body output neuron', count: 34 },
  { query_type: 'NeuronsPresynapticHere', label: 'Neurons presynaptic in mushroom body output neuron', count: 88 }
]

test('a query that ran and came back empty is the one thing that licenses absence', () => {
  const licence = absenceLicence(ledgerWith(Q, { stepStatus: { status: 'not_found', empty: true } }))
  assert.equal(licence.licensed, true)
  assert.equal(licence.empty.length, 1)
})

test('a query this guard chose cannot license the claim it was chosen to check', () => {
  // The failure that survived the first pass. S23 asks whether DA1 lPN
  // connectivity is symmetric between hemispheres. The draft denied it, the
  // escalation fired, nothing scored above zero, so the ranking ran
  // ListAllAvailableImages / SplitsTargeting / TransgeneExpressionHere — and one
  // empty licensed every absence in the answer, including the one about
  // hemisphere symmetry, which no image query speaks to. The guard had
  // manufactured its own permission.
  const ledger = ledgerWith(Q, { stepStatus: { status: 'not_found', empty: true } })
  ledger.plan[0].absence_query = true
  assert.equal(absenceLicence(ledger).licensed, false)
  // The same empty from a query the planner ran licenses it, exactly as before.
  ledger.plan[0].absence_query = false
  assert.equal(absenceLicence(ledger).licensed, true)
})

test('a query that FAILED licenses nothing — that is the state it exists to distinguish', () => {
  const licence = absenceLicence(ledgerWith(Q, { stepStatus: { status: 'not_found', empty: false } }))
  assert.equal(licence.licensed, false)
  assert.equal(licence.failed.length, 1)
  assert.ok(licence.escalable, 'and a failed lookup is the cheapest thing to retry')
})

test('a query nobody ran licenses nothing, and is the commonest case', () => {
  // S14, S23 and S46 in full: the term resolved, one query ran, the question
  // asked about an axis nothing covered, and the answer denied the axis.
  const licence = absenceLicence(ledgerWith(Q))
  assert.equal(licence.licensed, false)
  assert.ok(licence.unrun.length > 0)
  assert.ok(licence.escalable)
})

test('a query scoring zero relevance is still escalated to', () => {
  // The rule that nearly shipped: filter escalation on relevance, as the shelf
  // does. "Are any mushroom body output neurons cholinergic?" scores EVERY query
  // the class advertises at zero — no label contains "cholinergic" — and
  // SubClasses, scoring zero, is the query that answers it. Filtering here would
  // escalate nothing in exactly the case this module exists for.
  const licence = absenceLicence(ledgerWith(Q))
  assert.ok(licence.unrun.every(e => e.relevance === 0), 'the fixture really is the zero-relevance case')
  assert.equal(planAbsenceEscalation(licence).length, 2)
})

test('a query advertising zero records sorts last but is not dropped', () => {
  // Running it produces a genuine EMPTY, which turns an unlicensed denial into a
  // licensed one. A good outcome, just not worth the first attempt.
  const licence = absenceLicence(ledgerWith([
    { query_type: 'NoneHere', label: 'Nothing here', count: 0, countKind: 'exact' },
    { query_type: 'SubClasses', label: 'Subclasses', count: 34, countKind: 'exact' }
  ]))
  assert.equal(licence.unrun[0].query_type, 'SubClasses')
  assert.equal(licence.unrun.at(-1).query_type, 'NoneHere')
})

test('a name that never matched is reported, and a name we invented is not', () => {
  const ledger = createLedger('how does the lobula compare with the medulla?')
  addTerm(ledger, 'medulla', { id: 'FBbt_00003748', attempted: true, digest: { id: 'FBbt_00003748', name: 'medulla', queries: Q } })
  addTerm(ledger, 'lobula', { id: null, attempted: true, candidates: ['lobula plate', 'lobula columnar neuron'] })
  addTerm(ledger, 'lobula intrinsic neuron', { id: null, attempted: true, speculative: true, candidates: [] })
  const names = unmatchedNames(ledger).map(u => u.name)
  assert.deepEqual(names, ['lobula'], 'the speculative name is the harness apologising for its own guess')
})

// --- detecting the claim -----------------------------------------------------

test('the sentences production actually wrote are all detected', () => {
  const real = [
    'VFB does not currently hold data describing the specific anatomical layers, developmental origins, or synaptic terminal counts for the lobula in the same detail as the medulla.',
    'VFB does not currently hold data comparing DA1 lPN connectivity between the hemibrain and FlyWire datasets.',
    'VFB does not currently hold data identifying any cholinergic mushroom body output neurons.',
    'VFB does not currently hold data on whether DA1 lPN connectivity is symmetric between the left and right hemispheres.',
    'The specific comparative anatomical descriptions distinguishing the lobula\'s internal organization are not present in the current data.'
  ]
  for (const s of real) assert.equal(findAbsenceClaims(s).length, 1, `missed: ${s.slice(0, 60)}`)
})

test('the verb a model reaches for is not fixed, so the family is covered', () => {
  // A live run walked straight through a list that had "present", "available"
  // and "found" but not "provided": "specific counts for neurons with synaptic,
  // presynaptic, or postsynaptic terminals in the medulla, as well as the total
  // number of lineage clones, are not provided in the current data." VFB holds
  // every one of those and advertises a query for each.
  const s = 'Specific counts for neurons with presynaptic terminals in the medulla are not provided in the current data.'
  assert.equal(findAbsenceClaims(s).length, 1)
  for (const v of ['listed', 'given', 'shown', 'reported', 'detailed']) {
    assert.equal(findAbsenceClaims(`The layer subdivisions are not ${v} in the current data.`).length, 1, v)
  }
})

test('a linkified term name does not hide the absence behind two hundred characters of URL', () => {
  // Three of the production sentences had a report URL sitting between the
  // denial and its object, which is past every window in the patterns.
  const s = 'VFB does not currently hold data on which [mushroom body output neuron](https://www.virtualflybrain.org/reports/FBbt_00100247) types have images available.'
  assert.equal(findAbsenceClaims(s).length, 1)
})

test('a fact about a neuron is not a claim about the database', () => {
  const keep = [
    'The neuron has no presynaptic terminals in the calyx.',
    'MBON-gamma1pedc>alpha/beta is GABAergic and has 1,934 postsynaptic sites.',
    'VFB holds 92 transgene expression reports for Kenyon cell.',
    'Of the 34 subclasses returned, none is annotated as cholinergic.',
    'The medulla has 10 layers, M1 to M10.',
    'I could not match "gamma Kenyon cells" to a VFB term.',
    // The widened verb list must not start eating claims about the WORLD. None
    // of these says anything about what the database holds.
    'Serotonin is not present in these neurons.',
    'The lineage is not given a name in the original publication.',
    'Layer M10 is not shown in the figure.'
  ]
  for (const s of keep) assert.equal(findAbsenceClaims(s).length, 0, `false positive: ${s.slice(0, 60)}`)
})

// --- the repair --------------------------------------------------------------

test('an unlicensed absence is removed, and the rest of the answer survives', () => {
  const answer = 'VFB does not currently hold data identifying any cholinergic mushroom body output neurons.'
    + ' The available neurotransmitter profiles in VFB annotate instances of this class as either glutamatergic or GABAergic.'
  const { text, repairs } = repairUnlicensedAbsences(answer, absenceLicence(ledgerWith(Q)))
  assert.equal(repairs.length, 1)
  assert.ok(!/does not currently hold/.test(text), 'the false claim must be gone')
  assert.ok(/glutamatergic or GABAergic/.test(text), 'and the true half must survive intact')
})

test('nothing is spliced into a good answer that has nothing useful to say instead', () => {
  // The first live run of this guard, verbatim. A good answer — 7,283 images, 8
  // split-GAL4 patterns, 10 named subclasses — with one unlicensed sentence in
  // the middle about a count VFB had not pre-computed. The generic replacement
  // landed as "I could not establish that", whose "that" no longer had a
  // referent, in a paragraph it had nothing to do with.
  const answer = 'VFB holds 7,283 registered images annotated to gamma Kenyon cell.'
    + ' Regarding the total number of individual gamma Kenyon cells, VFB does not currently hold a pre-computed count for this term.'
    + ' The database also records 8 split-GAL4 expression patterns targeting this cell type.'
  const { text } = repairUnlicensedAbsences(answer, absenceLicence(ledgerWith(Q)))
  assert.ok(!/could not establish/.test(text), 'a non-sequitur is not an improvement on a deletion')
  assert.match(text, /7,283 registered images/)
  assert.match(text, /8 split-GAL4/)
})

test('the replacement names the unmatched term, because that is what the reader can act on', () => {
  const ledger = createLedger('how does the lobula compare with the medulla?')
  addTerm(ledger, 'medulla', { id: 'FBbt_00003748', attempted: true, digest: { id: 'FBbt_00003748', name: 'medulla', queries: Q } })
  addTerm(ledger, 'lobula', { id: null, attempted: true, candidates: ['lobula plate', 'lobula columnar neuron'] })
  const { text } = repairUnlicensedAbsences(
    'VFB does not currently hold data describing the anatomical layers of the lobula.',
    absenceLicence(ledger)
  )
  assert.match(text, /could not match "lobula"/)
  assert.match(text, /lobula plate/, 'and offers the closest thing that was found')
})

test('the replacement never describes this program — no sessions, no queries, no "not yet run"', () => {
  for (const ledger of [ledgerWith(Q), ledgerWith(Q, { stepStatus: { status: 'not_found', empty: false } })]) {
    const { text } = repairUnlicensedAbsences('VFB has no data on that.', absenceLicence(ledger))
    assert.ok(!/\bsession\b|has not been run|not yet run|in this run|the harness/i.test(text), `harness framing leaked: ${text}`)
  }
})

test('three denials in one answer become one honest sentence, not three', () => {
  // S14 and S46 both wrote the same denial three times, so this is the common
  // case rather than a corner.
  const answer = 'VFB does not currently hold data identifying any cholinergic MBONs.'
    + ' VFB does not currently hold data identifying any mushroom body output neurons as cholinergic.'
    + ' VFB has no records of cholinergic annotation for this class.'
  const { text, repairs } = repairUnlicensedAbsences(answer, absenceLicence(ledgerWith(Q)))
  assert.equal(repairs.length, 3)
  assert.equal(findAbsenceClaims(text).length, 0)
  assert.ok(text.split(/[.!?]/).filter(s => s.trim()).length <= 2, `still repetitive: ${text}`)
})

test('an answer that was nothing but a false denial does not become an empty answer', () => {
  const { text } = repairUnlicensedAbsences('VFB does not currently hold data on that.', absenceLicence(ledgerWith(Q)))
  assert.ok(text.trim().length > 20)
})

test('a licensed absence is left exactly as written', () => {
  const answer = 'VFB does not currently hold images of this neuron.'
  const licence = absenceLicence(ledgerWith(Q, { stepStatus: { status: 'not_found', empty: true } }))
  const { text, repairs } = repairUnlicensedAbsences(answer, licence)
  assert.equal(repairs.length, 0)
  assert.equal(text, answer, 'a query that ran and came back empty has earned its sentence')
})

// --- escalation --------------------------------------------------------------

test('a failed lookup is retried before an unrun query is tried', () => {
  // The one case with positive evidence that the absence is an artefact: VFB's
  // own catalogue says the records are there and the fetch did not land.
  const licence = {
    failed: [{ id: 'A', query_type: 'SubClasses', state: 'failed', label: 'l', termName: 't' }],
    unrun: [{ id: 'A', query_type: 'NeuronsPresynapticHere', state: 'unrun', label: 'l', termName: 't' }],
    unmatched: []
  }
  const picks = planAbsenceEscalation(licence)
  assert.equal(picks[0].query_type, 'SubClasses')
  assert.equal(picks[0].wasFailed, true)
})

test('escalation is bounded — the run deadline still has to mean something', () => {
  const unrun = Array.from({ length: 20 }, (_, i) => ({ id: 'A', query_type: `Q${i}`, state: 'unrun' }))
  assert.equal(planAbsenceEscalation({ failed: [], unrun, unmatched: [] }).length, MAX_ESCALATION_STEPS)
})

test('the same query queued twice does not eat two of the three slots', () => {
  const e = { id: 'A', query_type: 'SubClasses', state: 'unrun' }
  assert.equal(planAbsenceEscalation({ failed: [], unrun: [e, { ...e }, { ...e }], unmatched: [] }).length, 1)
})

// --- the harness path --------------------------------------------------------

test('a draft that denies data sends the loop round again, with rounds to do it', async () => {
  const ledger = ledgerWith(Q)
  ledger.budget.toolRoundsLeft = 0   // the common way to arrive at an empty answer
  const went = await maybeEscalateBeforeAbsence(
    ledger,
    'VFB does not currently hold data identifying any cholinergic mushroom body output neurons.',
    {}, () => {}
  )
  assert.equal(went, true)
  const injected = ledger.plan.filter(s => s.absence_query)
  assert.equal(injected.length, MAX_ESCALATION_STEPS - 1)
  // nextAction tests the budget BEFORE it looks for pending steps, so without
  // the grant these steps would never run and the loop would buy a second
  // identical synthesis for nothing.
  assert.ok(ledger.budget.toolRoundsLeft >= injected.length)
  assert.equal(nextAction(ledger).action, 'run_step')
})

// THE ANSWER MUST NOT BE WRITTEN OUT TWICE.
//
// Synthesis streams into a single live bubble on the client and only the final
// `result` event ends it, so the second synthesis this escalation buys is
// APPENDED to the draft it replaces. Production, 11 August, on "How many neurons
// are in the fly brain?": the same paragraph twice, in two slightly different
// wordings, one after the other. The tokens are already sent, so the server
// cannot unsend them — the client is told to drop them instead.
test('escalating tells the caller to discard the draft it already streamed', async () => {
  const ledger = ledgerWith(Q)
  ledger.budget.toolRoundsLeft = 0
  const discarded = []
  const went = await maybeEscalateBeforeAbsence(
    ledger,
    'VFB does not currently hold data identifying any cholinergic mushroom body output neurons.',
    { onDraftDiscarded: (info) => discarded.push(info) }, () => {}
  )
  assert.equal(went, true)
  assert.equal(discarded.length, 1, 'the streamed draft is withdrawn exactly once')
  assert.equal(discarded[0].reason, 'absence-escalation')
})

test('a run that does not escalate leaves the streamed draft alone', async () => {
  const ledger = ledgerWith(Q)
  ledger.startedAt = Date.now() - (ABSENCE_ESCALATION_DEADLINE_MS + 1000)
  const discarded = []
  const went = await maybeEscalateBeforeAbsence(
    ledger, 'VFB does not currently hold data on that.',
    { onDraftDiscarded: () => discarded.push(1) }, () => {}
  )
  assert.equal(went, false)
  assert.deepEqual(discarded, [], 'nothing was rewritten, so nothing is withdrawn')
})

test('a caller that never wired the discard hook still gets its escalation', async () => {
  // Best-effort, like onStatus: an unwired or throwing hook must not cost the run.
  const ledger = ledgerWith(Q)
  ledger.budget.toolRoundsLeft = 0
  const went = await maybeEscalateBeforeAbsence(
    ledger, 'VFB does not currently hold data on that.',
    { onDraftDiscarded: () => { throw new Error('client gone') } }, () => {}
  )
  assert.equal(went, true)
})

test('a run with no time left hedges instead of turning slow into nothing', async () => {
  // The first CI run of this branch: 63 of 64 tasks passed and the 64th was
  // "Timed out after 240000 ms". The escalation buys a second synthesis costing
  // 60-90 s, so one started late cannot finish — and it takes the first answer
  // down with it. A false absence is worse than a hedge; it is not worse than no
  // answer.
  const ledger = ledgerWith(Q)
  ledger.startedAt = Date.now() - (ABSENCE_ESCALATION_DEADLINE_MS + 1000)
  const went = await maybeEscalateBeforeAbsence(ledger, 'VFB does not currently hold data on that.', {}, () => {})
  assert.equal(went, false)
  assert.equal(ledger.plan.filter(s => s.absence_query).length, 0)
  // The gate costs no model call, so it still runs and the denial still cannot ship.
  assert.ok(!/does not currently hold/.test(gateAbsence(ledger, 'VFB does not currently hold data on that.', () => {})))
})

test('the escalation window fits under the tighter of the two ceilings', () => {
  // 600 s is the run deadline; 240 s is TASK_BATTERY_TIMEOUT_MS, the project's
  // own recorded opinion about when an answer has taken too long. The second
  // pass costs up to 90 s, so starting it must leave that much margin under 240.
  assert.ok(ABSENCE_ESCALATION_DEADLINE_MS + 90000 < 240000)
})

test('a draft that claims nothing is left alone, however thin the ledger', async () => {
  const ledger = ledgerWith(Q)
  const went = await maybeEscalateBeforeAbsence(ledger, 'The medulla has 10 layers, M1 to M10.', {}, () => {})
  assert.equal(went, false)
  assert.equal(ledger.plan.filter(s => s.absence_query).length, 0)
})

test('escalation happens once — a second pass must be allowed to write its answer', async () => {
  const ledger = ledgerWith(Q)
  const denial = 'VFB does not currently hold data on that.'
  assert.equal(await maybeEscalateBeforeAbsence(ledger, denial, {}, () => {}), true)
  assert.equal(await maybeEscalateBeforeAbsence(ledger, denial, {}, () => {}), false,
    'or a question VFB genuinely cannot answer would loop until the budget stopped it')
})

test('the gate is the floor under the escalation, not a replacement for it', () => {
  const ledger = ledgerWith(Q)
  const out = gateAbsence(ledger, 'VFB does not currently hold data on that. The class has 34 subtypes.', () => {})
  assert.ok(!/does not currently hold/.test(out))
  assert.match(out, /34 subtypes/)
})

test('a gate that throws costs a log line, never the answer', () => {
  const answer = 'VFB does not currently hold data on that.'
  assert.equal(gateAbsence({ get terms () { throw new Error('boom') } }, answer, () => {}), answer)
})

test('no ledger at all licenses no absence either', () => {
  // Not the same as the case above, and worth pinning separately. A missing
  // ledger does not throw, it simply knows nothing — and renderNoCoverageFloor
  // already settles what nothing is worth: "an absent catalogue is absent
  // EVIDENCE, never evidence of absence." Letting a null ledger through would
  // make the guard weakest exactly where the run is least informed.
  const out = gateAbsence(null, 'VFB does not currently hold data on that.', () => {})
  assert.ok(!/does not currently hold/.test(out))
})

// --- the half-resolved question ----------------------------------------------

test('a name that did not match appears in the prompt even when another term did', () => {
  // S7: the shelf is non-empty so renderNoCoverageFloor never fires, and the
  // unmatched name appeared nowhere — so nothing distinguished "never looked
  // at" from "checked and found wanting".
  const ledger = createLedger('how does the lobula compare with the medulla?')
  addTerm(ledger, 'medulla', { id: 'FBbt_00003748', attempted: true, digest: { id: 'FBbt_00003748', name: 'medulla', queries: Q } })
  addTerm(ledger, 'lobula', { id: null, attempted: true, candidates: ['lobula plate'] })
  const block = renderCoverageBlock(ledger)
  assert.ok(block.includes('NAMES THAT DID NOT MATCH'))
  assert.match(block, /lobula/)
  assert.match(block, /FORBIDDEN/, 'and it carries its own prohibition, like every other state')
})

test('the unmatched block is absent when every name resolved', () => {
  const ledger = ledgerWith(Q)
  assert.ok(!renderCoverageBlock(ledger).includes('NAMES THAT DID NOT MATCH'))
  assert.ok(!renderShelf(buildShelf(ledger)).includes('NAMES THAT DID NOT MATCH'), 'and the default is still no block')
})
