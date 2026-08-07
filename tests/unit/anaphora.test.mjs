import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveQuestionToChip, resolveQuestionToTemplate, contextTermsForAnaphor, RECOGNISED_QUERY_TYPES } from '../../lib/anaphora.mjs'

/** The catalogue the live medulla turn actually carried across the boundary. */
function medullaContext(overrides = {}) {
  return {
    v: 1,
    terms: [
      {
        name: 'medulla',
        label: 'medulla',
        id: 'FBbt_00003748',
        queries: [
          { query_type: 'TransgeneExpressionHere', label: 'Driver lines', count: 92, countKind: 'exact' },
          { query_type: 'NeuronsPartHere', label: 'Neurons with part here', count: 613, countKind: 'exact' },
          { query_type: 'NeuronsSynaptic', label: 'Neurons synaptic here', count: 595, countKind: 'exact' },
          { query_type: 'NeuronsPostsynapticHere', label: 'Neurons postsynaptic here', count: 333, countKind: 'exact' },
          { query_type: 'NeuronsPresynapticHere', label: 'Neurons presynaptic here', count: 262, countKind: 'exact' },
          { query_type: 'PartsOf', label: 'Parts', count: 21, countKind: 'exact' }
        ],
        ...overrides
      }
    ],
    registry: [['medulla', 'FBbt_00003748', 'medulla']]
  }
}

/** medulla most-recent, lobula behind it — the C3 shape. */
function twoTermContext() {
  const ctx = medullaContext()
  ctx.terms.push({
    name: 'lobula',
    label: 'lobula',
    id: 'FBbt_00003852',
    queries: [
      { query_type: 'NeuronsSynaptic', label: 'Neurons synaptic here', count: 528, countKind: 'exact' },
      { query_type: 'PartsOf', label: 'Parts', count: 8, countKind: 'exact' },
      { query_type: 'SubclassesOf', label: 'Subclasses', count: 4, countKind: 'exact' }
    ]
  })
  return ctx
}

// ---------------------------------------------------------------------------
// The measured defect: the 381-second turn.
// ---------------------------------------------------------------------------

test('the live 381s follow-up resolves to the chip that produced it', () => {
  const hit = resolveQuestionToChip('which neurons receive output from it?', medullaContext())
  assert.deepEqual(hit, {
    id: 'FBbt_00003748',
    query_type: 'NeuronsPostsynapticHere',
    label: 'medulla',
    via: 'anaphor'
  })
})

test('every ASK_TEMPLATE chip, retyped verbatim, matches its own query type', () => {
  // Mirrors lib/followOns.mjs ASK_TEMPLATES. The contract: a user who copies a
  // chip's own English back into the box must never pay for a planner call.
  const TEMPLATES = {
    NeuronsPresynapticHere: 'Which neurons provide input to the medulla?',
    NeuronsPostsynapticHere: 'Which neurons receive output from the medulla?',
    NeuronsPartHere: 'Which neurons have part of their arbour in the medulla?',
    NeuronsSynaptic: 'Which neurons have synaptic terminals in the medulla?',
    SubclassesOf: 'What are the subtypes of the medulla?',
    PartsOf: 'What are the anatomical parts of the medulla?',
    ExpressionOverlapsHere: 'Which GAL4 / expression patterns label the medulla?',
    TransgeneExpressionHere: 'Which driver lines label the medulla?',
    DownstreamClassConnectivity: 'What does the medulla connect to downstream?',
    UpstreamClassConnectivity: 'What connects to the medulla upstream?',
    NeuronInputsTo: 'What are the strongest inputs to the medulla?'
  }
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [...RECOGNISED_QUERY_TYPES].sort())

  for (const [queryType, question] of Object.entries(TEMPLATES)) {
    const ctx = medullaContext()
    // Offer only this query type, so the assertion is about the template text.
    ctx.terms[0].queries = [{ query_type: queryType, label: queryType, count: 5, countKind: 'exact' }]
    const hit = resolveQuestionToChip(question, ctx)
    assert.ok(hit, `no match for ${queryType}: ${question}`)
    assert.equal(hit.query_type, queryType, `wrong route for ${question}`)
    assert.equal(hit.via, 'named')
  }
})

test('paraphrases of the pronoun follow-up resolve the same way', () => {
  const cases = [
    ['which neurons are postsynaptic there?', 'NeuronsPostsynapticHere'],
    ['what neurons provide input to it?', 'NeuronsPresynapticHere'],
    ['which neurons innervate it?', 'NeuronsPresynapticHere'],
    ['what are its parts?', 'PartsOf'],
    ['show me its layers', 'PartsOf'],
    ['which driver lines label it?', 'TransgeneExpressionHere'],
    ['what neurons have synaptic terminals there?', 'NeuronsSynaptic']
  ]
  for (const [question, queryType] of cases) {
    const hit = resolveQuestionToChip(question, medullaContext())
    assert.ok(hit, `no match: ${question}`)
    assert.equal(hit.query_type, queryType, `wrong route for "${question}"`)
    assert.equal(hit.id, 'FBbt_00003748')
    assert.equal(hit.via, 'anaphor')
  }
})

// ---------------------------------------------------------------------------
// Reading 1 — the question names its own term.
// ---------------------------------------------------------------------------

test('a named term wins over the more recent one', () => {
  const hit = resolveQuestionToChip('what are the subtypes of the lobula?', twoTermContext())
  assert.equal(hit.id, 'FBbt_00003852')
  assert.equal(hit.query_type, 'SubclassesOf')
  assert.equal(hit.via, 'named')
})

test('an anaphor with two terms in context takes the most recent', () => {
  const hit = resolveQuestionToChip('what are its anatomical parts?', twoTermContext())
  assert.equal(hit.id, 'FBbt_00003748', 'terms[0] is the antecedent')
})

test('naming two carried terms is a comparison, not a chip', () => {
  assert.equal(resolveQuestionToChip('parts of the medulla lobula', twoTermContext()), null)
})

// ---------------------------------------------------------------------------
// The catalogue gate — never route to a query VFB does not hold.
// ---------------------------------------------------------------------------

test('a query type absent from the catalogue is not routed', () => {
  const ctx = medullaContext()
  ctx.terms[0].queries = ctx.terms[0].queries.filter(q => q.query_type !== 'NeuronsPostsynapticHere')
  assert.equal(resolveQuestionToChip('which neurons receive output from it?', ctx), null)
})

test('an exact-zero catalogue entry is not offerable', () => {
  const ctx = medullaContext()
  ctx.terms[0].queries = [{ query_type: 'PartsOf', count: 0, countKind: 'exact' }]
  assert.equal(resolveQuestionToChip('what are its parts?', ctx), null)
})

test('a -1 count means "total unknown", not "absent", so it stays offerable', () => {
  const ctx = medullaContext()
  ctx.terms[0].queries = [{ query_type: 'PartsOf', count: -1, countKind: 'many' }]
  const hit = resolveQuestionToChip('what are its parts?', ctx)
  assert.equal(hit?.query_type, 'PartsOf')
})

// ---------------------------------------------------------------------------
// Vetoes. Every one of these must fall through to the planner.
// ---------------------------------------------------------------------------

test('compound and analytical questions fall through', () => {
  const veto = [
    'which neurons receive output from it and which provide input?',
    'compare it to the lobula',
    'why do neurons receive output from it?',
    'how many neurons receive output from it?',
    'what is the number of neurons that receive output from it?',
    'which neurons receive output from it, but not the lobula?',
    'explain which neurons receive output from it',
    'which neurons receive output from it versus the lobula?'
  ]
  for (const question of veto) {
    assert.equal(resolveQuestionToChip(question, medullaContext()), null, `should not match: ${question}`)
  }
})

test('"how many" stays with the count router', () => {
  // The count path has its own type-vs-token semantics; silently turning a count
  // into a list would answer a different question than the one asked.
  assert.equal(resolveQuestionToChip('how many neurons are postsynaptic there?', medullaContext()), null)
})

test('long questions fall through even when they contain a signature', () => {
  const long = 'I would really like to know which neurons receive output from it in the adult brain please'
  assert.ok(long.split(/\s+/).length > 14)
  assert.equal(resolveQuestionToChip(long, medullaContext()), null)
})

test('an unrelated question does not match anything', () => {
  for (const q of ['what is the medulla?', 'hello', 'show me an image of it', 'is it in the optic lobe?']) {
    assert.equal(resolveQuestionToChip(q, medullaContext()), null, `should not match: ${q}`)
  }
})

test('a bare anaphor with no signature words falls through', () => {
  assert.equal(resolveQuestionToChip('what about it?', medullaContext()), null)
})

test('no context, no match', () => {
  assert.equal(resolveQuestionToChip('which neurons receive output from it?', null), null)
  assert.equal(resolveQuestionToChip('which neurons receive output from it?', { terms: [] }), null)
  assert.equal(resolveQuestionToChip('', medullaContext()), null)
  assert.equal(resolveQuestionToChip(null, medullaContext()), null)
})

test('a signature match with no anaphor and no named term falls through', () => {
  // "which neurons receive output from the lobula?" while only medulla is carried:
  // the lobula is not in context, so this must go to the planner, not silently
  // answer about the medulla.
  assert.equal(resolveQuestionToChip('which neurons receive output from the lobula?', medullaContext()), null)
})

// ---------------------------------------------------------------------------
// Ambiguity: two candidate query types means we do not know.
// ---------------------------------------------------------------------------

test('a question matching two catalogue query types is refused', () => {
  const ctx = medullaContext()
  // Both are reachable from the bare word "input".
  ctx.terms[0].queries = [
    { query_type: 'NeuronsPresynapticHere', count: 5, countKind: 'exact' },
    { query_type: 'NeuronInputsTo', count: 5, countKind: 'exact' }
  ]
  const hit = resolveQuestionToChip('which neurons provide input to it?', ctx)
  // Exact beats subset, so this one still resolves — the exact signature wins.
  assert.equal(hit?.query_type, 'NeuronsPresynapticHere')

  // But a bare subset that fits two signatures equally must be refused.
  ctx.terms[0].queries = [
    { query_type: 'SubclassesOf', count: 5, countKind: 'exact' },
    { query_type: 'PartsOf', count: 5, countKind: 'exact' }
  ]
  assert.equal(resolveQuestionToChip('its subtypes parts', ctx), null)
})

// ---------------------------------------------------------------------------
// Word edges and stemming.
// ---------------------------------------------------------------------------

test('anaphors match on word boundaries, not substrings', () => {
  // "transmit" contains "it"; "database" contains "that" only as letters. Neither
  // should count as an anaphor on its own.
  const ctx = medullaContext()
  assert.equal(resolveQuestionToChip('which neurons transmit output', ctx), null)
})

test('stemming makes singular and plural equivalent', () => {
  const ctx = medullaContext()
  ctx.terms[0].queries = [{ query_type: 'PartsOf', count: 5, countKind: 'exact' }]
  for (const q of ['what is its part?', 'what are its parts?']) {
    assert.equal(resolveQuestionToChip(q, ctx)?.query_type, 'PartsOf', q)
  }
})

test('British and American arbour/arborise spellings both route', () => {
  const ctx = medullaContext()
  ctx.terms[0].queries = [{ query_type: 'NeuronsPartHere', count: 5, countKind: 'exact' }]
  for (const q of ['which neurons arborise there?', 'which neurons arborize there?', 'which neurons have arbours there?']) {
    assert.equal(resolveQuestionToChip(q, ctx)?.query_type, 'NeuronsPartHere', q)
  }
})

test('tense and inflection do not change the route', () => {
  const ctx = medullaContext()
  ctx.terms[0].queries = [{ query_type: 'NeuronsPresynapticHere', count: 5, countKind: 'exact' }]
  for (const q of [
    'which neurons innervate it?',
    'which neurons innervates it?',
    'which neurons are innervating it?',
    'which neurons innervated it?'
  ]) {
    assert.equal(resolveQuestionToChip(q, ctx)?.query_type, 'NeuronsPresynapticHere', q)
  }
})

test('a malformed context never throws', () => {
  const junk = [
    { terms: null },
    { terms: [null] },
    { terms: [{}] },
    { terms: [{ id: 'FBbt_00003748', queries: null }] },
    { terms: [{ id: 'FBbt_00003748', queries: [null] }] },
    { terms: [{ id: 'x', label: 42, queries: [{ query_type: 7 }] }] }
  ]
  for (const ctx of junk) {
    assert.doesNotThrow(() => resolveQuestionToChip('what are its parts?', ctx))
  }
})

// ---------------------------------------------------------------------------
// resolveQuestionToTemplate — the same chip typed with no conversation behind it
// ---------------------------------------------------------------------------

test('the live C5 failure: our own PartsOf chip, typed cold', () => {
  // Measured against live 4.0.2, turn 1, no context:
  //   "The name 'anatomical parts of the medulla' could not be matched to a VFB
  //    term. No candidate terms were found for this wording."   9s, 0 chips
  const hit = resolveQuestionToTemplate('What are the anatomical parts of the medulla?')
  assert.deepEqual(hit, { query_type: 'PartsOf', term: 'medulla', via: 'template' })
})

test('every ASK_TEMPLATE chip, typed cold, names its query type and its term', () => {
  const TEMPLATES = {
    NeuronsPresynapticHere: 'Which neurons provide input to the medulla?',
    NeuronsPostsynapticHere: 'Which neurons receive output from the medulla?',
    NeuronsPartHere: 'Which neurons have part of their arbour in the medulla?',
    NeuronsSynaptic: 'Which neurons have synaptic terminals in the medulla?',
    SubclassesOf: 'What are the subtypes of the medulla?',
    PartsOf: 'What are the anatomical parts of the medulla?',
    ExpressionOverlapsHere: 'Which GAL4 / expression patterns label the medulla?',
    TransgeneExpressionHere: 'Which driver lines label the medulla?',
    DownstreamClassConnectivity: 'What does the medulla connect to downstream?',
    UpstreamClassConnectivity: 'What connects to the medulla upstream?',
    NeuronInputsTo: 'What are the strongest inputs to the medulla?'
  }
  // The five deliberately NOT taken cold, each because a specialist route does
  // strictly more than running the query: the two expression chips (ranked
  // driver lines from vfb_find_genetic_tools, against 4130 unranked rows) and
  // the three connectivity chips (the partner tool plus the deterministic weight
  // ranker, against a first page in VFB's own label order — the bug that made
  // "strongest partners" an alphabetical list). Warm, all eleven still route,
  // because there the user asked for that query by name off a term we resolved.
  const COLD_DEFERS = new Set([
    'ExpressionOverlapsHere', 'TransgeneExpressionHere',
    'DownstreamClassConnectivity', 'UpstreamClassConnectivity', 'NeuronInputsTo'
  ])
  for (const [queryType, question] of Object.entries(TEMPLATES)) {
    const hit = resolveQuestionToTemplate(question)
    if (COLD_DEFERS.has(queryType)) {
      assert.equal(hit, null, `${queryType} must defer to its specialist route when typed cold`)
      continue
    }
    assert.ok(hit, `no cold match for ${queryType}: ${question}`)
    assert.equal(hit.query_type, queryType, `wrong route for ${question}`)
    assert.equal(hit.term, 'medulla', `wrong term for ${question}`)
  }

  const ctx = {
    terms: [{
      name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
      queries: Object.keys(TEMPLATES).map(query_type => ({ query_type, label: query_type, count: 5, countKind: 'exact' }))
    }]
  }
  for (const [queryType, question] of Object.entries(TEMPLATES)) {
    const warm = resolveQuestionToChip(question.replace(/\bthe medulla\b/, 'it'), ctx)
    assert.equal(warm?.query_type, queryType, `warm path lost ${queryType}`)
  }
})

test('multi-word term names survive intact', () => {
  for (const [q, term] of [
    ['Which neurons innervate the mushroom body?', 'mushroom body'],
    ['What are the parts of the antennal lobe?', 'antennal lobe'],
    ['Which neurons have synaptic terminals in the fan-shaped body?', 'fan-shaped body'],
    ['What are the subtypes of Kenyon cell?', 'Kenyon cell']
  ]) {
    assert.equal(resolveQuestionToTemplate(q)?.term, term, q)
  }
})

test('a scattered remainder is a verb we did not model, not a term name', () => {
  // The safety property. If the leftover words are not adjacent, the sentence
  // contains something the template did not account for, so hand it to the
  // planner rather than inventing an entity out of the fragments.
  assert.equal(resolveQuestionToTemplate('which neurons in the medulla receive strong output?'), null)
  assert.equal(resolveQuestionToTemplate('what are the parts that make up the largest subregions?'), null)
})

test('a residual never crosses a full stop', () => {
  // Found by the orchestrator suite, not by inspection: "Which neurons are
  // presynaptic in the medulla? List them." is one question plus one
  // presentation directive, and read as a single string the contiguous remainder
  // after {neuron, presynaptic} is "medulla? List them" — which VFB would then be
  // asked to resolve as a term name. Sentence by sentence, the directive is
  // simply a sentence with no template in it.
  assert.deepEqual(
    resolveQuestionToTemplate('Which neurons are presynaptic in the medulla? List them.'),
    { query_type: 'NeuronsPresynapticHere', term: 'medulla', via: 'template' }
  )
  assert.equal(resolveQuestionToTemplate('What are the parts of the medulla? give me a table')?.term, 'medulla')
  assert.equal(resolveQuestionToTemplate('What are the parts of the medulla. Please list them all.')?.term, 'medulla')
  // Two sentences that each name a template are two questions, and this module
  // answers exactly one.
  assert.equal(
    resolveQuestionToTemplate('What are the subtypes of the mushroom body? And what are the parts of the medulla?'),
    null
  )
})

test('cold recognition declines everything the warm path declines', () => {
  for (const q of [
    'which neurons receive output from it?',                       // anaphor: warm path's job
    'which neurons receive output from the medulla and the lobula?', // compound
    'how many neurons provide input to the medulla?',              // count router
    'why do neurons provide input to the medulla?',                // explanation
    'compare the parts of the medulla and the lobula',             // comparison
    'what is the medulla?',                                        // no template
    'hello',
    ''
  ]) {
    assert.equal(resolveQuestionToTemplate(q), null, q)
  }
})

test('a template with nothing left over names no term', () => {
  // "Which neurons provide input?" is the template with the term deleted. There
  // is no entity to resolve, so there is no query to run.
  assert.equal(resolveQuestionToTemplate('which neurons provide input?'), null)
  assert.equal(resolveQuestionToTemplate('what are the anatomical parts?'), null)
})

test('cold recognition never throws on junk', () => {
  for (const q of [null, undefined, 42, {}, '???', '   ', '12345']) {
    assert.doesNotThrow(() => resolveQuestionToTemplate(q))
  }
})

// ---------------------------------------------------------------------------
// contextTermsForAnaphor — the subject that exists only in the conversation
// ---------------------------------------------------------------------------

test('a pro-form with no other subject adopts the entity under discussion', () => {
  // The measured C5 failure: turn 2 named nothing, so the planner asked for
  // nothing, the steps ran with empty args, and the answer denied a term it was
  // simultaneously hyperlinking.
  const got = contextTermsForAnaphor(
    'And which neurons have part of their arbour there?',
    medullaContext()
  )
  assert.deepEqual(got.map(t => t.id), ['FBbt_00003748'])
})

test('a plural pro-form adopts both of the last two entities', () => {
  // C10 turn 3, after protocerebral bridge and ellipsoid body. `terms` is
  // most-recent-first, so this is "the two we have been discussing".
  const got = contextTermsForAnaphor('Which neurons connect them?', twoTermContext())
  assert.deepEqual(got.map(t => t.id), ['FBbt_00003748', 'FBbt_00003852'])
})

test('"their" is not evidence of a plural antecedent', () => {
  // "which neurons have part of THEIR arbour there" — the possessor is the answer
  // set, not the thing being asked about. Reading it as plural would drag an
  // unrelated earlier entity into a question about one region.
  const got = contextTermsForAnaphor(
    'And which neurons have part of their arbour there?',
    twoTermContext()
  )
  assert.deepEqual(got.map(t => t.id), ['FBbt_00003748'])
})

test('a plural pro-form never invents a second antecedent', () => {
  // One term in the conversation means one term, whatever the grammar wants.
  const got = contextTermsForAnaphor('Which neurons connect them?', medullaContext())
  assert.equal(got.length, 1)
})

test('a question that names its own subject is left to the named path', () => {
  // contextTermsNamedIn matches on the term's own wording; recency is the wrong
  // tie-break when the user said which one they meant.
  assert.deepEqual(contextTermsForAnaphor('Which neurons innervate the lobula?', twoTermContext()), [])
  // ...including when a pro-form is also present.
  assert.deepEqual(contextTermsForAnaphor('Is the lobula bigger than it?', twoTermContext()), [])
})

test('a question carrying an id outright is not pointing at anything', () => {
  assert.deepEqual(
    contextTermsForAnaphor('What are the parts of FBbt_00003852 and its subclasses?', twoTermContext()),
    []
  )
})

test('no pro-form means no adoption, however subjectless the question', () => {
  // This is the veto that keeps a genuine change of topic from being answered
  // about the previous entity. A question the planner merely failed to extract a
  // term from is NOT the same as a question that points backwards.
  for (const q of [
    'What connectomics datasets does VFB hold?',
    'How do I cite VFB?',
    'Which neurons are cholinergic?'
  ]) {
    assert.deepEqual(contextTermsForAnaphor(q, medullaContext()), [], q)
  }
})

test('no conversation means nothing to inherit', () => {
  assert.deepEqual(contextTermsForAnaphor('which neurons innervate it?', { v: 1, terms: [], registry: [] }), [])
  assert.deepEqual(contextTermsForAnaphor('which neurons innervate it?', null), [])
})

test('anaphor adoption never throws on junk', () => {
  for (const q of [null, undefined, 42, {}, '   ']) {
    assert.doesNotThrow(() => contextTermsForAnaphor(q, medullaContext()))
  }
  for (const ctx of [null, undefined, 42, { terms: 'no' }, { terms: [null] }]) {
    assert.doesNotThrow(() => contextTermsForAnaphor('what about it?', ctx))
  }
})

test('the fast chip path and the safety net do not disagree about the antecedent', () => {
  // Both read "it" as terms[0]. If they ever picked differently, a question would
  // be answered about one entity when recognised and another when not — a
  // difference no user could predict or see.
  const ctx = twoTermContext()
  const chip = resolveQuestionToChip('which neurons receive output from it?', ctx)
  const inherited = contextTermsForAnaphor('which neurons receive output from it?', ctx)
  assert.ok(chip, 'expected the warm chip route to recognise this question')
  assert.equal(inherited[0].id, chip.id)
})
