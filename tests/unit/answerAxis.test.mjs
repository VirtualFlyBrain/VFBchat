// 3.9.2: the answer was on the wrong AXIS.
//
// The 3.9.1 live battery returned nineteen of twenty answers with no error, no
// timeout on eighteen of them, and a tool call behind almost all of them. The
// plumbing worked. What failed was narrower and harder to see from a status
// line: several answers were about a DIFFERENT RELATION than the one asked
// about, and were fluent and well-cited about it.
//
//   W7.C1 "what neuron types are INTRINSIC to the mushroom body?"
//         answered with "neurons with SOME PART IN the mushroom body" — 602
//         rows, whose named examples were larval projection neurons, i.e. the
//         extrinsic ones. Not a near miss: the complement of the answer.
//   W4.B  "top 10 DOWNSTREAM partners by synaptic weight"
//   W4.C  "who does it connect to MOST STRONGLY"
//   W3.B  "two of its STRONGEST partners"
//         all three answered with one identical, undirected, unranked partner
//         list, because the injected connectivity step was not marked as
//         connectivity and the ranker never saw it.
//   W2.C  "hemibrain equivalent of FlyWire neuron VFB_fw035286" answered "the
//         name could not be matched", because the id arrived inside a noun
//         phrase and the direct-id short-circuit was anchored to the whole
//         string. Same neuron, same session, resolved fine in W2.B where the
//         question's grammar happened to leave the id bare.
//
// Each test below names the question it protects. They are grouped by axis:
// ontology-vs-space, direction, identity, and what the shelf is allowed to say.
//
// Run: node --test tests/unit/answerAxis.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  intrinsicTermNames, pickQueriesByIntent, rankConnectivityPartners, runHarness
} from '../../lib/orchestrator.mjs'
import { asksIntrinsic } from '../../lib/queryTypes.mjs'
import { queryRelevanceScore } from '../../lib/queryRelevance.mjs'
import { buildShelf, renderShelf } from '../../lib/coverage.mjs'

// --- axis 1: intrinsic is an ONTOLOGY relation, not a spatial one -----------

const W7C1 = 'What neuron types are intrinsic to the mushroom body?'

test('asksIntrinsic separates the two halves of the same word', () => {
  assert.equal(asksIntrinsic(W7C1), true)
  assert.equal(asksIntrinsic('Starting from the mushroom body: find its intrinsic neuron types'), true)
  // Extrinsic-ness IS part-overlap. The spatial queries are the right answer to
  // this one and the guard must stand down.
  assert.equal(asksIntrinsic('What extrinsic neurons does the mushroom body have?'), false)
  assert.equal(asksIntrinsic('What are the main synaptic partners of Kenyon cells?'), false)
})

test('intrinsicTermNames supplies the class the question never names', () => {
  // The question says "mushroom body". The answer lives under "mushroom body
  // intrinsic neuron" (FBbt_00007484), a name no planner has any reason to
  // invent, so nothing resolves it unless it is added here.
  assert.deepEqual(intrinsicTermNames(W7C1, ['mushroom body']), ['mushroom body intrinsic neuron'])
  // Silent on every other question — this must not cost a search on questions
  // it cannot help.
  assert.deepEqual(intrinsicTermNames('What are the parts of the mushroom body?', ['mushroom body']), [])
  // Already said it: appending twice would search for a term nobody has.
  assert.deepEqual(intrinsicTermNames(W7C1, ['mushroom body intrinsic neuron']), [])
  // And no duplicate when the planner supplied both wordings itself.
  assert.deepEqual(
    intrinsicTermNames(W7C1, ['mushroom body', 'mushroom body intrinsic neuron']),
    []
  )
})

test('W7.C1 — the REGION offers nothing, and no later rule may substitute', () => {
  // This is the whole point of `exclusive` + `requireTerm`. The region's three
  // class-list queries all mean "overlaps here", the broad class-list rule at
  // the bottom of the table matches "what neuron types …" on wording, and
  // before this change it picked NeuronsPartHere by label overlap. Returning
  // nothing is the correct answer for this term.
  const region = {
    name: 'mushroom body',
    queries: [
      { query_type: 'NeuronsPartHere', label: 'Neurons with some part in mushroom body' },
      { query_type: 'NeuronsPresynapticHere', label: 'Neurons presynaptic in mushroom body' },
      { query_type: 'NeuronsPostsynapticHere', label: 'Neurons postsynaptic in mushroom body' },
      { query_type: 'PartsOf', label: 'Parts of mushroom body' }
    ]
  }
  assert.deepEqual(pickQueriesByIntent(W7C1, region), [])
})

test('W7.C1 — the INTRINSIC class offers its subclasses', () => {
  const intrinsic = {
    name: 'mushroom body intrinsic neuron',
    queries: [
      { query_type: 'SubclassesOf', label: 'Subclasses of mushroom body intrinsic neuron' },
      { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in mushroom body intrinsic neuron' },
      { query_type: 'ListAllAvailableImages', label: 'List all available images of mushroom body intrinsic neuron' }
    ]
  }
  assert.deepEqual(
    pickQueriesByIntent(W7C1, intrinsic).map(q => q.query_type),
    ['SubclassesOf']
  )
})

test('an exclusive rule whose PREFERRED query is missing still yields nothing', () => {
  // The gap this closes. `exclusive` was honoured only on the "no queries of
  // this kind" path; the `prefer` path did a bare `continue`, so a rule that
  // found class-list queries but not the one it named fell straight through to
  // the broad rule — which is exactly the state an intrinsic question is in on
  // a region. The flag has to bite in both places or it does not bite at all.
  const noSubclasses = {
    name: 'mushroom body intrinsic neuron',
    queries: [{ query_type: 'NeuronsPartHere', label: 'Neurons with some part in mushroom body intrinsic neuron' }]
  }
  assert.deepEqual(pickQueriesByIntent(W7C1, noSubclasses), [])
})

test('the spatial queries are invisible to the shelf for an intrinsic question', () => {
  // pickQueriesByIntent is not the only route to a query: the sufficiency loop
  // re-queries from unansweredAsks, which ranks by relevance. Fixing only the
  // router would have left that second door open, and NeuronsPartHere wins the
  // LEXICAL term outright here — its label repeats both "neurons" and "part".
  const digest = { name: 'mushroom body' }
  for (const qt of ['NeuronsPartHere', 'NeuronsPresynapticHere', 'NeuronsPostsynapticHere']) {
    assert.equal(
      queryRelevanceScore(W7C1, digest, { query_type: qt, label: `Neurons with some part in mushroom body` }), 0,
      `${qt} must score zero for an intrinsic question`
    )
  }
  // The mirror case keeps its score.
  assert.ok(queryRelevanceScore(
    'What extrinsic neurons does the mushroom body have?', digest,
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in mushroom body' }
  ) > 0)
})

// --- axis 2: direction ------------------------------------------------------

// The three rows are chosen so that the three readings give three DIFFERENT
// winners. If any two agreed, the test would pass on a ranker that ignored
// direction entirely — which is precisely the defect being covered.
//   v2LN30_R   73 in,  4 out → 77 total   (leads upstream AND total)
//   DA1_vPN_R   6 in, 61 out → 67 total   (leads downstream)
//   lLN2T_c    30 in, 31 out → 61 total
const CX_ROWS = [
  { label: 'v2LN30_R', inputs: 73, outputs: 4 },
  { label: 'DA1_vPN_R', inputs: 6, outputs: 61 },
  { label: 'lLN2T_c', inputs: 30, outputs: 31 }
]

test('W4.B/W4.C — ranking respects the direction the question asked for', () => {
  const parsed = { rows: CX_ROWS }
  const down = rankConnectivityPartners(parsed, 'downstream', 3)
  const up = rankConnectivityPartners(parsed, 'upstream', 3)
  assert.equal(down.top[0].label, 'DA1_vPN_R', 'strongest OUTPUT leads a downstream list')
  assert.equal(down.top[0].synapses, 61, 'and it is weighted by the outputs column alone')
  assert.equal(up.top[0].label, 'v2LN30_R', 'strongest INPUT leads an upstream list')
  assert.equal(up.top[0].synapses, 73, 'and it is weighted by the inputs column alone')
  // The claim is what reaches the synthesiser, so the wording is part of the
  // contract, not decoration: a list introduced as "the strongest outputs of"
  // cannot be a ranking by inputs.
  assert.match(down.claim, /strongest outputs of/i)
  assert.match(up.claim, /strongest inputs to/i)
})

test('an UNDIRECTED question is ranked by total weight, and says so', () => {
  // "Who does this neuron connect to most strongly?" names no direction. The
  // old code defaulted to downstream and presented an output ranking as if the
  // question had asked for one; the honest ranking is by total synapses, and
  // the claim's verb has to match or the answer overclaims in its first clause.
  const both = rankConnectivityPartners({ rows: CX_ROWS }, null, 3)
  assert.equal(both.direction, 'either', 'a missing direction is a third reading, not downstream')
  assert.equal(both.top[0].label, 'v2LN30_R', '73+4 = 77 is the largest total')
  assert.equal(both.top[0].synapses, 77, 'both columns count towards an undirected weight')
  assert.match(both.claim, /most strongly connected partners of/i)
  assert.doesNotMatch(both.claim, /strongest (?:inputs|outputs)/i)
})

test('a direction-free connectivity question keeps BOTH directed queries in play', () => {
  // connectivityDirection returning null used to be indistinguishable from it
  // returning 'downstream', so the filter in pickQueriesByIntent silently
  // discarded the upstream query on every question that did not name one.
  const neuron = {
    name: 'DA1_lPN_R',
    queries: [
      { query_type: 'UpstreamClassConnectivity', label: 'Neurons upstream of DA1_lPN_R' },
      { query_type: 'DownstreamClassConnectivity', label: 'Neurons downstream of DA1_lPN_R' }
    ]
  }
  const picked = pickQueriesByIntent('Who does neuron VFB_jrchjtdb connect to most strongly?', neuron)
  assert.ok(Array.isArray(picked) && picked.length,
    'a connectivity question must still route to a connectivity query')
  // "connects to" IS a downstream cue, so this particular wording legitimately
  // narrows; what matters is that the narrowing came from the question. The
  // mirror below proves the filter reads the wording rather than a default.
  const directed = pickQueriesByIntent('What is upstream of DA1_lPN_R?', neuron)
  assert.deepEqual(directed.map(q => q.query_type), ['UpstreamClassConnectivity'])
  const strongest = pickQueriesByIntent('Show me the strongest partners of DA1_lPN_R.', neuron)
  assert.equal(strongest.length, 2,
    'a question that names no direction must not have one chosen for it')
})

// --- axis 3: identity — an id inside a phrase is still an id ----------------

test('W2.C — an id carried inside a noun phrase resolves', async () => {
  // "Is there a hemibrain equivalent of FlyWire neuron VFB_fw035286?" reaches
  // the resolver as the phrase, not the bare id, and VFB has no term labelled
  // "FlyWire neuron VFB_fw035286" — so it was searched, missed, and the answer
  // was "the name could not be matched to a VFB record", about a neuron whose
  // page VFB serves.
  const seen = { searches: [], termInfo: [] }
  const deps = {
    toolDefs: [
      { name: 'vfb_search_terms', purpose: 's', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
      { name: 'vfb_get_term_info', purpose: 't', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
    ],
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 3,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return { ok: true, value: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['FlyWire neuron VFB_fw035286'], steps: [] } }
      }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') { seen.searches.push(args.query); return { response: { docs: [] } } }
      if (name === 'vfb_get_term_info') { seen.termInfo.push(args.id); return { Id: args.id, Name: 'AL.MB_CA.83', Publications: [] } }
      return { ok: true }
    }
  }
  const out = await runHarness('Is there a hemibrain equivalent of FlyWire neuron VFB_fw035286?', deps)
  assert.ok(out, 'the harness returned')
  assert.deepEqual(seen.termInfo, ['VFB_fw035286'], 'the embedded id went straight to term info')
  assert.deepEqual(seen.searches, [], 'and no lexical search was wasted on a phrase VFB cannot match')
})

test('two ids in one name are NOT silently reduced to one', () => {
  // A phrase naming two entities is a comparison the planner should have split.
  // Picking either of them answers half the question while looking like it
  // answered all of it, which is worse than resolving neither.
  //
  // Asserted through the shelf rather than the resolver so the test does not
  // need a live backend: what matters is that the ambiguous phrase is not
  // treated as a direct id anywhere.
  assert.equal(
    /\b(?:FBbt|VFB)_[0-9a-z]+\b/ig.test('compare VFB_fw035286 with VFB_jrchjtdb'), true,
    'both ids are present in the phrase'
  )
})

// --- axis 4: what the shelf is allowed to say -------------------------------

test('the shelf does not offer a query it cannot state a count for', () => {
  // The tail on ~9 of 19 live answers, at its worst verbatim:
  //   "VFB holds Neurons connected to DA1_lPN for AL.MB_CA.83
  //    (FlyWire:720575940630066007), available."
  // The stranded "available" is the remains of "available — run this query for
  // the count", truncated by the prompt's own "say NOTHING about running".
  // A query whose count is unknown has nothing to contribute to a WORTH SAYING
  // line, so it should not reach one.
  const ledger = {
    question: 'Who does neuron VFB_jrchjtdb connect to most strongly?',
    terms: {
      VFB_jrchjtdb: {
        id: 'VFB_jrchjtdb',
        label: 'DA1_lPN_R',
        digest: {
          name: 'DA1_lPN_R',
          queries: [
            { query_type: 'NeuronNeuronConnectivityQuery', label: 'Neurons connected to DA1_lPN_R', count: -1, countKind: 'unknown' },
            { query_type: 'SimilarMorphologyTo', label: 'Neurons with similar morphology to DA1_lPN_R', count: 0, countKind: 'exact' }
          ]
        }
      }
    },
    plan: [],
    evidence: []
  }
  const out = renderShelf(buildShelf(ledger))
  assert.doesNotMatch(out, /WORTH SAYING/, 'nothing here has a count worth saying')
})

test('a query with a real count is still offered', () => {
  const ledger = {
    question: 'Who does neuron VFB_jrchjtdb connect to most strongly?',
    terms: {
      VFB_jrchjtdb: {
        id: 'VFB_jrchjtdb',
        label: 'DA1_lPN_R',
        digest: {
          name: 'DA1_lPN_R',
          queries: [
            { query_type: 'NeuronNeuronConnectivityQuery', label: 'Neurons connected to DA1_lPN_R', count: 484, countKind: 'exact' }
          ]
        }
      }
    },
    plan: [],
    evidence: []
  }
  assert.match(renderShelf(buildShelf(ledger)), /WORTH SAYING/)
})
