// Query relevance — is this query even about the question?
//
// This scoring was a private helper inside orchestrator.mjs that answered one
// narrow question ("which single query should I auto-run?") as a winner-or-
// nothing. That discipline is right for INJECTION — running the wrong query is
// worse than running none — and useless for everything else, because a score
// only ever consulted through a tiebreak cannot rank, cap, or filter. The score
// is now a value; the winner-or-nothing rule is one consumer of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelOverlapScore, rankQueries, bestByLabelOverlap, countQueryWords, listQueryWords } from '../../lib/queryRelevance.mjs'

const DIGEST = { name: 'mushroom body' }

test("the term's own name is subtracted before scoring", () => {
  // Every query label for the mushroom body ends "… in mushroom body". Leaving
  // those words in scores all of them alike and tells us nothing.
  const q = { label: 'Parts of mushroom body' }
  assert.equal(labelOverlapScore('what parts does the mushroom body have?', DIGEST, q, listQueryWords), 1)
  assert.equal(labelOverlapScore('what neurons are in the mushroom body?', DIGEST, q, listQueryWords), 0)
})

test('rankQueries orders the whole pool, ties keeping input order', () => {
  const pool = [
    { label: 'Fly stocks' },
    { label: 'Neurons with presynaptic terminals in mushroom body' },
    { label: 'Subclasses of mushroom body' }
  ]
  const ranked = rankQueries('which neurons are presynaptic in the mushroom body?', DIGEST, pool, listQueryWords)
  assert.equal(ranked[0].query.label, 'Neurons with presynaptic terminals in mushroom body')
  assert.ok(ranked[0].score > ranked[1].score)
  assert.equal(ranked.length, 3, 'nothing is dropped — capping is the caller\'s decision')
})

test('bestByLabelOverlap still refuses to guess between equals', () => {
  const tied = [{ label: 'Neurons with presynaptic terminals here' }, { label: 'Neurons with postsynaptic terminals here' }]
  assert.equal(bestByLabelOverlap('which neurons are in the mushroom body?', DIGEST, tied, listQueryWords), null)
  assert.equal(bestByLabelOverlap('anything', DIGEST, [], listQueryWords), null)
})

test('an images question is narrowed to individual-image queries', () => {
  // An "images" count must come from an individual-image query. A class query
  // like PartsOf counts CLASSES, and answering "how many images" with a count of
  // ontology classes is a wrong answer, not a partial one.
  const pool = [
    { label: 'Images of mushroom body', query_type: 'ListAllAvailableImages' },
    { label: 'Images of neurons with a part here', query_type: 'PartsOf' }
  ]
  const best = bestByLabelOverlap('how many images of the mushroom body are there?', DIGEST, pool)
  assert.equal(best.query_type, 'ListAllAvailableImages')
})

test('"part" is signal in a list question and noise in a count question', () => {
  // "how many parts of X" — every candidate is a part of something, so the word
  // separates nothing. "what parts does X have" vs "which neurons have a part in
  // X" — there it is the entire distinction.
  assert.ok(!countQueryWords('how many parts of the medulla').includes('parts'))
  assert.ok(listQueryWords('what parts does the medulla have').includes('parts'))
})
