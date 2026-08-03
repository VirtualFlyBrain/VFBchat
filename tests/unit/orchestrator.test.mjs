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
import { pickBestQueryForQuestion, maybeInjectCountQueryStep } from '../../lib/orchestrator.mjs'

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

test('normalizePlan: "what specific aspect" is an abstention, not a clarification', () => {
  // Both of these are verbatim from the task battery. "How do I use the VFB MCP
  // tool?" and "What was included in the latest VFB release?" each came back
  // underspecified, and underspecified ALSO suppresses the concurrent doc search
  // — so the two questions most obviously answerable from documentation were the
  // two that never looked at any. Vetoing the flag drops them into the
  // controller's documentation escalation instead.
  for (const q of [
    'What specific aspect of the latest Virtual Fly Brain release are you interested in?',
    'What specific aspect of the Virtual Fly Brain Model Context Protocol tool do you need help with?',
    'Which parts of the 3D viewer do you mean?',
    'Could you be more specific?',
    'What kind of information are you looking for?',
    // D5, verbatim: "How do I report a problem or contribute data to VFB?" is
    // a whole question already. The same stall in a different noun.
    'What specific type of problem or data are you trying to report or contribute to Virtual Fly Brain?',
    'What sort of help do you need?'
  ]) {
    const p = normalizePlan({ intent: 'documentation', underspecified: true, clarifying_question: q, steps: [] })
    assert.equal(p.underspecified, false, q)
    assert.equal(p.clarifying_question, '', q)
  }
})

test('normalizePlan: a question about VFB itself is never clarified', () => {
  // The stalls kept arriving in new grammar. This one offers a choice between
  // the two halves of a question that had already asked for both, so it slips
  // past a phrasing rule anchored on "what"/"which" — but a documentation
  // question always has something to do, and clarifying suppresses the doc
  // search on top of costing a turn.
  const q = 'Are you looking to report a problem with Virtual Fly Brain or contribute new data?'
  const p = normalizePlan({ intent: 'documentation', underspecified: true, clarifying_question: q, steps: [] })
  assert.equal(p.underspecified, false)
  assert.equal(p.clarifying_question, '')

  // The same question under an intent that can genuinely be blocked on a name.
  const q2 = normalizePlan({ intent: 'term_info', underspecified: true, clarifying_question: 'Which neuron do you mean?', steps: [] })
  assert.equal(q2.underspecified, true)
})

test('normalizePlan: a how-to question is never clarified, whatever the intent', () => {
  // Verbatim, and the clarify it came back with. The intent veto did not fire:
  // "Claude" reads as an entity name, so this was not classified as a
  // documentation question — and the clarification asks the user to define a
  // word the question had just used.
  const q = 'How do I connect Claude to the Virtual Fly Brain MCP server?'
  const asked = 'What is Claude in the context of Virtual Fly Brain?'
  const p = normalizePlan({ intent: 'term_info', underspecified: true, clarifying_question: asked, steps: [] }, q)
  assert.equal(p.underspecified, false)
  assert.equal(p.clarifying_question, '')

  for (const howTo of [
    'How can we install vfb-connect?',
    'How to cite Virtual Fly Brain',
    'What is the best way to download a neuron mesh?',
    'What are the steps to load a scene in the 3D viewer?'
  ]) {
    const r = normalizePlan({ intent: 'other', underspecified: true, clarifying_question: asked, steps: [] }, howTo)
    assert.equal(r.underspecified, false, howTo)
  }
})

test('normalizePlan: the how-to veto reads the question, not the clarification', () => {
  // A question that is not a how-to keeps a clarification that names what is
  // missing, even though the clarification itself would read as one.
  const p = normalizePlan(
    { intent: 'term_info', underspecified: true, clarifying_question: 'Which neuron do you mean?', steps: [] },
    'Show me the inputs to it.'
  )
  assert.equal(p.underspecified, true)

  // And with no question threaded in at all — the eight older call sites — the
  // veto is simply absent rather than firing on an empty string.
  const q = normalizePlan({ intent: 'term_info', underspecified: true, clarifying_question: 'Which dataset?', steps: [] })
  assert.equal(q.underspecified, true)
})

test('normalizePlan: the LLM client at the other end is not a term to resolve', () => {
  // VFB's search for "Claude" returns a FAFB neuron whose matched synonym is
  // "LHPV5d3#1 5807250 Jean-Claude ARJ" — the tracer's name in the annotation.
  // The resolver cannot tell those apart lexically, so the name is dropped here.
  const p = normalizePlan({
    intent: 'documentation',
    terms_to_resolve: ['Claude', 'Claude Desktop', 'ChatGPT', 'Gemini', 'VS Code', 'Virtual Fly Brain MCP', 'lateral horn neuron'],
    steps: []
  }, 'How do I connect Claude to the Virtual Fly Brain MCP server?')
  assert.deepEqual(p.terms_to_resolve, ['lateral horn neuron'])
})

test('normalizePlan: a real term is not mistaken for a client name', () => {
  // The client list is anchored whole-string, so a term that merely contains one
  // of those words survives. "Claude" the tracer is why this matters: the point
  // is to drop the software, not every neuron a person's name touches.
  const p = normalizePlan({
    intent: 'term_info',
    terms_to_resolve: ['cursor neuron', 'gemini gene', 'LHPV5d3#1'],
    steps: []
  }, 'What is a cursor neuron?')
  assert.deepEqual(p.terms_to_resolve, ['cursor neuron', 'gemini gene', 'LHPV5d3#1'])
})

test('normalizePlan: a clarification that names the missing ENTITY survives', () => {
  for (const q of [
    'Which neuron do you mean?',
    'Which dataset should I compare against?',
    'What is the name of the neuron you are asking about?',
    // The noun is what separates a stall from a real question: "what kind of
    // problem" is a stall, "what kind of neuron" names the thing that is missing.
    'What kind of neuron are you asking about?'
  ]) {
    const p = normalizePlan({ intent: 'other', underspecified: true, clarifying_question: q, steps: [] })
    assert.equal(p.underspecified, true, q)
    assert.equal(p.clarifying_question, q, q)
  }
})

test('normalizePlan: the VFB service itself is not a term to resolve', () => {
  // VFB's ontology holds fly anatomy; it does not hold "Virtual Fly Brain".
  // Asking anyway returned VFB_SYMBOL for the release question and nothing at all
  // for the MCP one, and the latter turned the whole answer into "the name could
  // not be matched to a VFB term".
  const p = normalizePlan({
    intent: 'documentation', underspecified: false,
    terms_to_resolve: [
      'Virtual Fly Brain',
      'the VFB website',
      'Virtual Fly Brain Model Context Protocol (MCP)',
      'VFB-connect',
      'mushroom body'
    ],
    steps: []
  })
  assert.deepEqual(p.terms_to_resolve, ['mushroom body'])
})

test('normalizePlan: a real term that merely mentions VFB is kept', () => {
  const p = normalizePlan({
    intent: 'term_info', underspecified: false,
    terms_to_resolve: ['VFB_00101567', 'Kenyon cell', 'adult brain template'],
    steps: []
  })
  assert.deepEqual(p.terms_to_resolve, ['VFB_00101567', 'Kenyon cell', 'adult brain template'])
})

test('normalizePlan: underspecified with no question to ask is dropped', () => {
  // The controller needs both to clarify, so keeping the flag alone would only
  // suppress the doc search and then fall through unanswered anyway.
  const p = normalizePlan({ intent: 'other', underspecified: true, clarifying_question: '   ', steps: [] })
  assert.equal(p.underspecified, false)
})

test('buildPlannerMessages: includes question + catalogue, instructs not to answer', () => {
  const m = buildPlannerMessages('what connects to DA1?', [{ name: 'vfb_query_connectivity', purpose: 'class-to-class connectivity' }])
  assert.match(m[0].content, /Do NOT answer/)
  assert.match(m[1].content, /what connects to DA1\?/)
  assert.match(m[1].content, /vfb_query_connectivity/)
})

test('buildPlannerMessages: includes prior conversation for pronoun resolution', () => {
  const history = [
    { role: 'user', content: 'What are adult lateral horn neurons' },
    { role: 'assistant', content: 'Adult lateral horn neurons are ...' }
  ]
  const m = buildPlannerMessages('What do they connect to downstream?', [], history)
  assert.match(m[1].content, /PRIOR CONVERSATION/)
  assert.match(m[1].content, /adult lateral horn neurons/)
  // the system prompt instructs resolving pronouns from history rather than clarifying
  assert.match(m[0].content, /pronoun|back-reference/i)
  // no history -> no prior-conversation block
  const m2 = buildPlannerMessages('What is the medulla?', [])
  assert.doesNotMatch(m2[1].content, /PRIOR CONVERSATION/)
})

test('detectFastPath: definitional lookup yes; tool-specific / multi-step no', () => {
  assert.ok(detectFastPath('What is the mushroom body?'))
  assert.ok(detectFastPath('What are the subdivisions of the central complex?'))
  // needs a specific tool / role, not the generic fast path
  assert.equal(detectFastPath('What neurotransmitter do Kenyon cells use?'), null)
  assert.equal(detectFastPath('What is the function of PPL1?'), null)
  assert.equal(detectFastPath('What connects the antennal lobe to the lateral horn?'), null)
  assert.equal(detectFastPath('Trace a pathway from ORNs to the lateral horn'), null)
  // bare pronoun must NOT fast-path (needs the history-aware planner)
  assert.equal(detectFastPath('What are they?'), null)
  assert.equal(detectFastPath('What is it?'), null)
  // "(major) subdivisions of the Drosophila X" resolves the ENTITY X, not the descriptor
  const subs = detectFastPath('What are the major subdivisions of the Drosophila mushroom body?')
  assert.ok(subs, 'subdivisions question should fast-path')
  assert.deepEqual(subs.terms_to_resolve, ['mushroom body'])
  const parts = detectFastPath('What are the parts of the antennal lobe?')
  assert.deepEqual(parts.terms_to_resolve, ['antennal lobe'])
})

test('detectFastPath: "what datasets are available" runs AllDatasets; a specific dataset does not', () => {
  for (const q of ['What datasets are available?', 'list the datasets in VFB', 'which datasets does VFB have?']) {
    const p = detectFastPath(q)
    const step = p?.steps?.[0]
    assert.equal(step?.tool, 'vfb_run_query', `should run a query for: ${q}`)
    assert.equal(step?.args?.query_type, 'AllDatasets')
    assert.equal(step?.args?.id, 'VFB_00101567')
    assert.deepEqual(p.terms_to_resolve, [])
  }
  // a specific/singular dataset question is NOT the listing route
  assert.notEqual(detectFastPath('what is in the FAFB dataset')?.steps?.[0]?.args?.query_type, 'AllDatasets')
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

// ---- count-question auto-run (surface the number, don't tell the user to run it) ----

// PartsOf (28 subparts, a CLASS query) is the trap: the deployed chat picked it
// for "how many images …" and reported "28 images". The image-aware routing must
// pick the individual-image query (ImagesNeurons) and never a class query.
const MEDULLA_DIGEST = {
  name: 'medulla',
  queries: [
    { query_type: 'ImagesNeurons', label: 'Images of neurons with some part in medulla', count: -1 },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in medulla', count: -1 },
    { query_type: 'PartsOf', label: 'Parts of medulla', count: 28 },
    { query_type: 'SubclassesOf', label: 'Subclasses of medulla', count: 4 }
  ]
}

// The user's exact question — the "medualla" misspelling is deliberate: the term
// still resolves to the medulla, and query matching keys off "images"/"neurons",
// not the (mis-spelled) term word.
const MEDULLA_Q = 'how many images of neurons with a part in the medualla are available?'

test('pickBestQueryForQuestion: image question picks the individual-image query, never a class query', () => {
  const picked = pickBestQueryForQuestion(MEDULLA_Q, MEDULLA_DIGEST)
  assert.equal(picked?.query_type, 'ImagesNeurons')
  assert.notEqual(picked?.query_type, 'PartsOf')
  // a non-image count question is unrestricted and picks the unique match
  assert.equal(pickBestQueryForQuestion('how many subclasses of the medulla?', MEDULLA_DIGEST)?.query_type, 'SubclassesOf')
  // no distinctive overlap → null (don't guess)
  assert.equal(pickBestQueryForQuestion('how many kittens of the medulla?', MEDULLA_DIGEST), null)
})

test('maybeInjectCountQueryStep: auto-runs ImagesNeurons for the medulla image question (deliberate typo)', () => {
  const l = setPlan(createLedger('q'), { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['medulla'], steps: [] })
  addTerm(l, 'medulla', { id: 'FBbt_00003748', digest: MEDULLA_DIGEST })
  maybeInjectCountQueryStep(l, MEDULLA_Q)
  assert.equal(l.plan.length, 1)
  assert.equal(l.plan[0].tool, 'vfb_run_query')
  assert.deepEqual(l.plan[0].args, { id: 'FBbt_00003748', query_type: 'ImagesNeurons' })
})

test('maybeInjectCountQueryStep: no-op for non-count questions and when a run_query step already exists', () => {
  // not a count question
  const l1 = setPlan(createLedger('q'), { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['medulla'], steps: [] })
  addTerm(l1, 'medulla', { id: 'FBbt_00003748', digest: MEDULLA_DIGEST })
  maybeInjectCountQueryStep(l1, 'what is the medulla?')
  assert.equal(l1.plan.length, 0)
  // a planner run_query with the WRONG query_type is RETARGETED (not duplicated)
  // to the semantically-correct one — this is the "28 images" (PartsOf) fix.
  const l2 = setPlan(createLedger('q'), { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['medulla'], steps: [{ id: 's1', tool: 'vfb_run_query', answers: ['x'], args: { id: 'FBbt_00003748', query_type: 'PartsOf' } }] })
  addTerm(l2, 'medulla', { id: 'FBbt_00003748', digest: MEDULLA_DIGEST })
  maybeInjectCountQueryStep(l2, MEDULLA_Q)
  assert.equal(l2.plan.length, 1)
  assert.equal(l2.plan[0].tool, 'vfb_run_query')
  assert.equal(l2.plan[0].args.query_type, 'ImagesNeurons')
  assert.equal(l2.plan[0].count_query, true)
})
