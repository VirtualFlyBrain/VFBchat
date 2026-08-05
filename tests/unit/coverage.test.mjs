// The shelf: per-QUERY coverage, and the four states an answer is scored against.
//
// The bug this module was written for is worth restating, because every test
// below is a face of it. Coverage used to be tracked per TERM. A term with five
// queries, one of which had run, read as "looked at" — so the catalogue that
// would have stopped a denial was suppressed, the sufficiency check declined to
// fire, and the answer went on to deny the four queries nobody had run. Eight of
// twenty workshop answers ended in a false "VFB does not …" that way.
//
// A term is not a unit of coverage. A query is. And a query is in one of four
// states, not two, because "ran and returned nothing" and "the lookup fell over"
// arrive at the same place in the pipeline (markStepNotFound) and license
// opposite sentences.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN, EMPTY, FAILED, UNRUN,
  buildShelf, coveredKinds, unansweredAsks, renderShelf, countPhrase
} from '../../lib/coverage.mjs'

/** A ledger with one term, its digest queries, a plan and the evidence rows. */
function ledgerWith(queries, plan = [], evidence = [], question = 'q') {
  return {
    question,
    plan,
    evidence,
    terms: {
      't': {
        id: 'FBbt_0000001',
        label: 'mushroom body',
        digest: { name: 'mushroom body', queries }
      }
    }
  }
}

const Q = (query_type, label, count = 10) => ({ query_type, label, count })

test('a query nobody planned is UNRUN, and that is not an absence', () => {
  const shelf = buildShelf(ledgerWith([Q('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in mushroom body', 366)]))
  assert.equal(shelf.length, 1)
  assert.equal(shelf[0].state, UNRUN)
  assert.equal(shelf[0].planned, false)
})

test('a query whose step produced evidence is RUN', () => {
  const plan = [{ id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_0000001', query_type: 'NeuronsPresynapticHere' } }]
  const shelf = buildShelf(ledgerWith([Q('NeuronsPresynapticHere', 'presynaptic', 366)], plan, [{ stepId: 's1' }]))
  assert.equal(shelf[0].state, RUN)
})

test('EMPTY and FAILED are distinguished, because they license opposite sentences', () => {
  // Both land on markStepNotFound. Only the one that definitively returned zero
  // rows may become "VFB does not currently hold …"; conflating them either
  // hedges a real absence into "not yet run" or reports a crashed lookup as a
  // gap in the database.
  const plan = [
    { id: 's1', tool: 'vfb_run_query', status: 'not_found', empty_result: true, args: { id: 'FBbt_0000001', query_type: 'PartsOf' } },
    { id: 's2', tool: 'vfb_run_query', status: 'not_found', args: { id: 'FBbt_0000001', query_type: 'SubclassesOf' } }
  ]
  const shelf = buildShelf(ledgerWith([Q('PartsOf', 'parts'), Q('SubclassesOf', 'subclasses')], plan))
  assert.equal(shelf.find(e => e.query_type === 'PartsOf').state, EMPTY)
  assert.equal(shelf.find(e => e.query_type === 'SubclassesOf').state, FAILED)
})

test('a macro tool covers by KIND, since it names no query_type', () => {
  // vfb_find_similar_neurons does not run SimilarMorphologyTo, it runs NBLAST,
  // so its evidence can never be matched to a shelf entry by name. Without the
  // kind mapping the shelf reports "similarity: not yet run" underneath an
  // answer full of NBLAST scores — the mirror of the denial bug.
  const plan = [{ id: 's1', tool: 'vfb_find_similar_neurons', args: { id: 'FBbt_0000001' } }]
  const shelf = buildShelf(ledgerWith(
    [Q('SimilarMorphologyTo', 'similar neurons'), Q('PartsOf', 'parts')],
    plan, [{ stepId: 's1' }]
  ))
  assert.equal(shelf.find(e => e.query_type === 'SimilarMorphologyTo').state, RUN)
  assert.equal(shelf.find(e => e.query_type === 'PartsOf').state, UNRUN, 'and covers only its own kind')
})

test('a macro that produced nothing covers nothing', () => {
  // A pending or failed macro leaves its kinds exactly as unrun as they were.
  const plan = [{ id: 's1', tool: 'vfb_find_similar_neurons', args: { id: 'FBbt_0000001' } }]
  const shelf = buildShelf(ledgerWith([Q('SimilarMorphologyTo', 'similar neurons')], plan, []))
  assert.equal(shelf[0].state, UNRUN)
})

test('unansweredAsks is what the question asked for and nothing ran', () => {
  const shelf = buildShelf(ledgerWith([
    Q('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in mushroom body', 366),
    Q('FindStocks', 'Fly stocks', 4)
  ], [], [], 'what neurons are presynaptic in the mushroom body?'))
  const asks = unansweredAsks(shelf)
  assert.equal(asks.length, 1, 'the stocks query is not what was asked')
  assert.equal(asks[0].query_type, 'NeuronsPresynapticHere')
})

test('a query already planned is not an unanswered ask — the loop must not go round again', () => {
  const plan = [{ id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_0000001', query_type: 'NeuronsPresynapticHere' } }]
  const shelf = buildShelf(ledgerWith(
    [Q('NeuronsPresynapticHere', 'Neurons with presynaptic terminals in mushroom body', 366)],
    plan, [], 'what neurons are presynaptic in the mushroom body?'
  ))
  assert.equal(shelf[0].state, UNRUN, 'still unrun...')
  assert.equal(shelf[0].planned, true, '...but on its way')
  assert.equal(unansweredAsks(shelf).length, 0)
  assert.ok(coveredKinds(shelf).has('FBbt_0000001::class_list'))
})

test('THE REGRESSION: one step answering does not make the rest deniable', () => {
  // This is the whole defect in one assertion. "How many DA1 lPN neurons does
  // VFB hold in each connectome dataset?" ran a connectivity query, and because
  // SOMETHING had run against the term, the catalogue — and with it the ban on
  // denying what it lists — was withheld. ListAllAvailableImages, the query that
  // actually answers the question, was never run and was then denied outright.
  const plan = [{ id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_0000001', query_type: 'DownstreamClassConnectivity' } }]
  const shelf = buildShelf(ledgerWith([
    Q('DownstreamClassConnectivity', 'downstream partners', 30),
    Q('ListAllAvailableImages', 'Images of DA1 lPN', 102)
  ], plan, [{ stepId: 's1' }], 'how many images does VFB hold in each connectome dataset?'))

  assert.equal(shelf.find(e => e.query_type === 'DownstreamClassConnectivity').state, RUN)
  assert.equal(shelf.find(e => e.query_type === 'ListAllAvailableImages').state, UNRUN)

  const out = renderShelf(shelf)
  assert.match(out, /AVAILABLE VFB DATA/, 'the block survives a step having answered')
  assert.match(out, /Images of DA1 lPN \(102\)/, 'and still names what VFB is holding')
  assert.match(out, /FORBIDDEN/, 'under an explicit ban on calling it absent')
})

test('the prohibition is unconditional; the licence to recite is not', () => {
  // The guard this replaces existed for a real defect: supplied as a licence,
  // the catalogue became a tail on every answer ("VFB holds various data related
  // to LPLC2, including available images, splits targeting it, …"). The block
  // was doing two jobs and only one of them pads, so they are now separate.
  const offTopic = buildShelf(ledgerWith([Q('FindStocks', 'Fly stocks', 4)], [], [], 'what neurons are similar to LPLC2?'))
  const out = renderShelf(offTopic)
  assert.match(out, /FORBIDDEN/, 'still forbidden to deny it')
  assert.ok(!/WORTH SAYING/.test(out), 'but nothing here answers the question, so nothing may be named')
  assert.match(out, /Do not list the HELD group back to the reader/)

  const onTopic = buildShelf(ledgerWith([Q('FindStocks', 'Fly stocks', 4)], [], [], 'what fly stocks are available?'))
  assert.match(renderShelf(onTopic), /WORTH SAYING/, 'a query the question DID ask for may be offered')
})

test('the held list is relevance-ranked, so a cap drops the least likely first', () => {
  const many = []
  for (let i = 0; i < 20; i++) many.push(Q(`Unknown${i}`, `filler query ${i}`, i))
  many.push(Q('ListAllAvailableImages', 'Images of the mushroom body', 99))
  const shelf = buildShelf(ledgerWith(many, [], [], 'what images does VFB have?'))
  const out = renderShelf(shelf)
  assert.match(out, /Images of the mushroom body \(99\)/, 'the relevant query survives the cap')
  assert.match(out, /and \d+ further queries for these terms, equally unrun and equally not absent/,
    'and the tail is declared, not silently dropped')
})

test('countPhrase never emits a bare -1', () => {
  // -1 means "run the query to find out", not "zero" — the same error as the
  // denial bug, one layer down in VFBquery.
  assert.equal(countPhrase({ count: 12 }), '12')
  assert.match(countPhrase({ count: -1 }), /run this query for the count/)
  assert.match(countPhrase({ count: 1000, countKind: 'many' }), /more than 1000/)
})

test('a ledger with no resolved terms yields an empty shelf and no block', () => {
  // "No opinion" must never render as "nothing available" — an empty shelf is
  // the state where the model is least entitled to deny anything.
  assert.deepEqual(buildShelf({ terms: {}, plan: [], evidence: [] }), [])
  assert.equal(renderShelf([]), '')
})
