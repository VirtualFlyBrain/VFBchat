// Offline unit tests for the planner + typed ledger + controller (pure logic).
// Run: node --test tests/unit/orchestrator.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLedger, setPlan, addTerm, getTermId, resolveArgs, ledgerHasRefs,
  addEvidence, markStepNotFound, recordToolRound, outOfBudget,
  vfbAnswered, vfbHasData, isComplete, pendingSteps
} from '../../lib/ledger.mjs'
import { PLAN_SCHEMA, INTENTS, buildPlannerMessages, normalizePlan, detectFastPath } from '../../lib/planner.mjs'
import { nextAction, decideRetrieval, statusSummary } from '../../lib/controller.mjs'
import { validateAgainstSchema } from '../../lib/structuredOutput.mjs'

const PLAN = {
  intent: 'connectivity',
  underspecified: false,
  clarifying_question: '',
  terms_to_resolve: ['DA1 glomerulus', 'lateral horn'],
  steps: [{ id: 's1', tool: 'vfb_query_connectivity', answers: ['which neurons connect DA1 to LH'] }]
}

// ---- ledger ----

test('createLedger + setPlan: derives steps and open questions', () => {
  const l = setPlan(createLedger('connect DA1 to LH?'), PLAN)
  assert.equal(l.intent, 'connectivity')
  assert.equal(l.plan.length, 1)
  assert.equal(l.plan[0].status, 'pending')
  assert.deepEqual(l.openQuestions, ['which neurons connect DA1 to LH'])
  assert.deepEqual(l.termsToResolve, ['DA1 glomerulus', 'lateral horn'])
})

test('addTerm / getTermId / resolveArgs: placeholder substitution', () => {
  const l = createLedger('q')
  addTerm(l, 'DA1 glomerulus', { id: 'FBbt_00003932', kind: 'class' })
  assert.equal(getTermId(l, 'DA1 glomerulus'), 'FBbt_00003932')
  assert.equal(getTermId(l, '$term:DA1 glomerulus'), 'FBbt_00003932')
  assert.deepEqual(resolveArgs(l, { upstream: '$term:DA1 glomerulus', weight: 5 }), { upstream: 'FBbt_00003932', weight: 5 })
  // unresolved placeholder falls back to the bare name
  assert.deepEqual(resolveArgs(l, { x: '$term:unknown' }), { x: 'unknown' })
})

test('addEvidence: satisfies its step; isComplete flips', () => {
  const l = setPlan(createLedger('q'), PLAN)
  assert.equal(isComplete(l), false)
  addEvidence(l, { source: 'vfb', claim: 'PN→LH', verbatim: '...', stepId: 's1' })
  assert.equal(l.plan[0].status, 'satisfied')
  assert.equal(vfbAnswered(l), true)
  assert.equal(vfbHasData(l), true)
  assert.equal(isComplete(l), true)
  assert.deepEqual(l.openQuestions, [])
})

test('markStepNotFound: counts as resolved for completion', () => {
  const l = setPlan(createLedger('q'), PLAN)
  markStepNotFound(l, 's1', 'no data')
  assert.equal(isComplete(l), true)        // exhausted, not pending
  assert.equal(vfbAnswered(l), false)      // but not actually answered
})

test('addEvidence: requires a source', () => {
  assert.throws(() => addEvidence(createLedger('q'), { claim: 'x' }))
})

test('budget: recordToolRound / outOfBudget', () => {
  const l = createLedger('q', { maxToolRounds: 2 })
  assert.equal(outOfBudget(l), false)
  recordToolRound(l); recordToolRound(l)
  assert.equal(outOfBudget(l), true)
})

test('ledgerHasRefs: true when a term carries publications', () => {
  const l = createLedger('q')
  addTerm(l, 'PPL1', { id: 'FBbt_x', publications: [{ pmid: '20637624' }] })
  assert.equal(ledgerHasRefs(l), true)
})

test('underspecified plan is never complete', () => {
  const l = setPlan(createLedger('q'), { ...PLAN, underspecified: true, clarifying_question: 'which dataset?' })
  assert.equal(isComplete(l), false)
})

// ---- planner ----

test('PLAN_SCHEMA: a normalised plan validates', () => {
  const normalised = normalizePlan(PLAN)
  // normalizePlan strips status; the schema wants intent/underspecified/etc.
  const full = { ...normalised }
  assert.equal(validateAgainstSchema(full, PLAN_SCHEMA).valid, true)
})

test('normalizePlan: bad intent → other; dedupes step ids; drops toolless steps', () => {
  const p = normalizePlan({
    intent: 'nonsense', underspecified: false,
    steps: [{ id: 's1', tool: 'a', answers: ['x'] }, { id: 's1', tool: 'b', answers: [] }, { tool: '', answers: [] }]
  })
  assert.equal(p.intent, 'other')
  assert.equal(p.steps.length, 2)
  assert.notEqual(p.steps[0].id, p.steps[1].id)
})

test('buildPlannerMessages: includes question + catalogue, instructs not to answer', () => {
  const m = buildPlannerMessages('what connects to DA1?', [{ name: 'vfb_query_connectivity', purpose: 'class-to-class connectivity' }])
  assert.match(m[0].content, /Do NOT answer/)
  assert.match(m[1].content, /what connects to DA1\?/)
  assert.match(m[1].content, /vfb_query_connectivity/)
})

test('detectFastPath: definitional lookup yes; tool-specific / multi-step no', () => {
  assert.ok(detectFastPath('What is the mushroom body?'))
  assert.ok(detectFastPath('What are the subdivisions of the central complex?'))
  // needs a specific tool (neurotransmitter profile), not the generic fast path
  assert.equal(detectFastPath('What neurotransmitter do Kenyon cells use?'), null)
  assert.equal(detectFastPath('What connects the antennal lobe to the lateral horn?'), null)
  assert.equal(detectFastPath('Trace a pathway from ORNs to the lateral horn'), null)
})

test('INTENTS covers documentation and literature', () => {
  assert.ok(INTENTS.includes('documentation') && INTENTS.includes('literature'))
})

// ---- controller ----

test('nextAction: clarify → resolve_terms → run_step → synthesise', () => {
  // clarify
  let l = setPlan(createLedger('q'), { ...PLAN, underspecified: true, clarifying_question: 'which?' })
  assert.equal(nextAction(l).action, 'clarify')

  // resolve terms
  l = setPlan(createLedger('q'), PLAN)
  assert.equal(nextAction(l).action, 'resolve_terms')

  // run step (terms resolved)
  addTerm(l, 'DA1 glomerulus', { id: 'FBbt_1' })
  addTerm(l, 'lateral horn', { id: 'FBbt_2' })
  const a = nextAction(l)
  assert.equal(a.action, 'run_step')
  assert.equal(a.step.id, 's1')

  // synthesise once satisfied
  addEvidence(l, { source: 'vfb', claim: '...', stepId: 's1' })
  assert.equal(nextAction(l).action, 'synthesise')
})

test('nextAction: budget exhausted → synthesise', () => {
  const l = setPlan(createLedger('q', { maxToolRounds: 1 }), PLAN)
  addTerm(l, 'DA1 glomerulus', { id: 'FBbt_1' }); addTerm(l, 'lateral horn', { id: 'FBbt_2' })
  recordToolRound(l)
  assert.equal(nextAction(l).action, 'synthesise')
})

test('nextAction: VFB empty → retrieve (literature fallback) before synthesise', () => {
  const l = setPlan(createLedger('What is the function of PPL1?'), {
    intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: [],
    steps: [{ id: 's1', tool: 'vfb_get_neurotransmitter_profile', answers: ['function of PPL1'] }]
  })
  markStepNotFound(l, 's1', 'no VFB data')   // VFB returned nothing usable
  const a = nextAction(l)
  assert.equal(a.action, 'retrieve')
  assert.equal(a.retrieval.literature, true)
})

test('decideRetrieval: VFB answered + no external ask → skip', () => {
  const l = setPlan(createLedger('What NT do Kenyon cells use?'), {
    intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: [],
    steps: [{ id: 's1', tool: 'vfb_get_neurotransmitter_profile', answers: ['NT'] }]
  })
  addEvidence(l, { source: 'vfb', claim: 'acetylcholine', stepId: 's1' })
  const r = decideRetrieval(l)
  assert.equal(r.documentation, false)
  assert.equal(r.literature, false)
})

test('statusSummary: compact and complete flag', () => {
  const l = setPlan(createLedger('q'), PLAN)
  addTerm(l, 'DA1 glomerulus', { id: 'FBbt_1' }); addTerm(l, 'lateral horn', { id: 'FBbt_2' })
  addEvidence(l, { source: 'vfb', claim: '...', stepId: 's1' })
  const s = statusSummary(l)
  assert.equal(s.complete, true)
  assert.equal(s.evidence, 1)
  assert.match(s.steps, /s1:satisfied/)
})
