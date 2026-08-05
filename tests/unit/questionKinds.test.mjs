// Relevance has to survive the reader and VFB choosing different words.
//
// THE LIVE FAILURE THIS COVERS
//
// Three of the twenty workshop questions were answered with a flat denial of
// data VFB demonstrably holds, and all three failed the same way: the query that
// answers the question scored ZERO on lexical label overlap, because VFB's label
// and the reader's question said the same thing in different words.
//
//   W2.C "Is there a hemibrain equivalent of FlyWire neuron VFB_fw035286,
//         and do they share a cell type?"
//        vs "Neurons with similar morphology to DA1_lPN [NBLAST]"        → 0
//   W6.C "What genes are expressed in Kenyon cells?"
//        vs "Single cell transcriptomics data for Kenyon cell"           → 0
//   W7.C1 "What neuron types are intrinsic to the mushroom body?"
//        vs "Subclasses of mushroom body intrinsic neuron"               → 0
//
// The W7.C1 fixture originally paired that question with "Neurons with some
// part in mushroom body", because that was the query the shelf was ranking to
// the top. Making it VISIBLE was still the right fix; making it the ANSWER was
// not. "Some part in" is a spatial-overlap relation that holds of every MBON,
// DAN and projection neuron crossing the calyx — the extrinsic neurons — so it
// returned 602 rows to a question whose answer is one class, with extrinsic
// examples named. The intrinsic route is ontological: the class "mushroom body
// intrinsic neuron" (FBbt_00007484) and its SubclassesOf. Same defect, same
// zero, corrected object.
//
// A zero is not "a bit less relevant". unansweredAsks filters on relevance > 0,
// so a zero makes the query invisible BOTH to the sufficiency pre-filter (it
// never runs) and to the shelf ranking (it sinks below the cap) — and the answer
// then denies the concept.
//
// The fix types the QUESTION into the same kind vocabulary the queries were
// already typed with, so the match no longer depends on shared nouns.
//
// Run: node --test tests/unit/questionKinds.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { questionKinds, excludedKinds } from '../../lib/queryTypes.mjs'
import {
  stemWord, labelOverlapScore, queryRelevanceScore, questionKindSets,
  listQueryWords, bestByLabelOverlap
} from '../../lib/queryRelevance.mjs'
import { buildShelf, unansweredAsks } from '../../lib/coverage.mjs'

// --- the demand-side classifier --------------------------------------------

test('a question is classified into the kind vocabulary the queries use', () => {
  const cases = [
    ['Show me what neuron VFB_jrchjtdb looks like.', 'individual_images'],
    ['What images does VFB have for the DA1 lPN neuron type?', 'individual_images'],
    ['What neuron types are intrinsic to the mushroom body?', 'class_list'],
    ['What parts does the medulla have?', 'class_list'],
    ['Who does neuron VFB_jrchjtdb connect to most strongly?', 'connectivity'],
    ['What are the main synaptic partners of Kenyon cells?', 'connectivity'],
    ['What neurons look most similar to LPLC2?', 'similarity'],
    ['Is there a hemibrain equivalent of FlyWire neuron VFB_fw035286?', 'similarity'],
    ['What genes are expressed in Kenyon cells?', 'scrnaseq'],
    ['Does VFB have any transgene expression data for LPLC2?', 'expression'],
    ['Which connectomes does VFB hold?', 'dataset'],
    ['What fly stocks carry this transgene?', 'stocks'],
    ['Which publications describe this neuron?', 'publications']
  ]
  for (const [q, kind] of cases) {
    assert.ok(questionKinds(q).has(kind), `${q} → expected ${kind}, got [${[...questionKinds(q)]}]`)
  }
})

test('a question can want more than one kind, and none is not an error', () => {
  const both = questionKinds('How many DA1 lPN images are in each connectome dataset?')
  assert.ok(both.has('individual_images'))
  assert.ok(both.has('dataset'))
  // No cue at all is a real answer, not a failure — callers fall back to lexical.
  assert.equal(questionKinds('Tell me about the mushroom body').size, 0)
  assert.equal(questionKinds('').size, 0)
})

// --- the veto ---------------------------------------------------------------
//
// The gene/driver split, one layer down: "expressed" and "expression" share a
// stem, so the reagent query scores on the very word that proves the question is
// not about reagents.

test('a transcriptomics question rules out reagent reports, and vice versa', () => {
  assert.deepEqual([...excludedKinds('What genes are expressed in Kenyon cells?')], ['expression'])
  assert.deepEqual([...excludedKinds('Does VFB have any transgene expression data for LPLC2?')], ['scrnaseq'])
  assert.equal(excludedKinds('What images does VFB have for DA1 lPN?').size, 0)
  assert.equal(excludedKinds('').size, 0)
})

test('a vetoed kind scores zero however well its label reads', () => {
  const digest = { name: 'Kenyon cell' }
  const transgene = { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in Kenyon cell' }
  const q = 'What genes are expressed in Kenyon cells?'
  // The label genuinely shares a stem — this is not a case the lexical scorer
  // gets right on its own.
  assert.ok(labelOverlapScore(q, digest, transgene, (s) => listQueryWords(s).map(stemWord)) > 0)
  assert.equal(queryRelevanceScore(q, digest, transgene), 0)
})

// --- stemming ---------------------------------------------------------------

test('stemming maps a word family onto one stem without needing real words', () => {
  assert.equal(stemWord('expressed'), stemWord('expression'))
  assert.equal(stemWord('morphology'), stemWord('morphological'))
  assert.equal(stemWord('connectivity'), stemWord('connective'))
  assert.equal(stemWord('images'), stemWord('image'))
  // Short words are left alone rather than mangled.
  assert.equal(stemWord('cell'), 'cell')
  assert.equal(stemWord('gene'), 'gene')
  // -ss and -us must not lose their last letter.
  assert.equal(stemWord('class'), 'class')
  assert.equal(stemWord('nucleus'), 'nucleus')
})

test('the router still compares literally, so singular and plural stay distinct', () => {
  // bestByLabelOverlap is winner-take-all: it runs one query or none. Stemming
  // there collapses PartsOf and NeuronsPartHere onto the same score, the router
  // abstains, and a question that used to be answered stops being answered.
  const digest = { name: 'medulla' }
  const pool = [
    { query_type: 'PartsOf', label: 'Parts of medulla' },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in medulla' }
  ]
  const picked = bestByLabelOverlap('What parts does the medulla have?', digest, pool, listQueryWords)
  assert.equal(picked?.query_type, 'PartsOf')
})

// --- the three live failures ------------------------------------------------

const CASES = [
  {
    name: 'W2.C — a similarity question finds the NBLAST query',
    q: 'Is there a hemibrain equivalent of FlyWire neuron VFB_fw035286, and do they share a cell type?',
    digest: { name: 'DA1_lPN' },
    query: { query_type: 'SimilarMorphologyTo', label: 'Neurons with similar morphology to DA1_lPN [NBLAST]' }
  },
  {
    name: 'W6.C — a gene question finds the single-cell query',
    q: 'What genes are expressed in Kenyon cells?',
    digest: { name: 'Kenyon cell' },
    query: { query_type: 'anatScRNAseqQuery', label: 'Single cell transcriptomics data for Kenyon cell' }
  },
  {
    name: 'W7.C1 — an intrinsic question finds the intrinsic class’s subclasses',
    q: 'What neuron types are intrinsic to the mushroom body?',
    digest: { name: 'mushroom body intrinsic neuron' },
    query: { query_type: 'SubclassesOf', label: 'Subclasses of mushroom body intrinsic neuron' }
  },
  {
    name: 'W3.C — a "looks like" question finds the images query',
    q: 'Show me what neuron VFB_jrchjtdb looks like.',
    digest: { name: 'DA1_lPN_R' },
    query: { query_type: 'ListAllAvailableImages', label: 'List all available images of DA1_lPN_R' }
  },
  {
    name: 'W4.C — a "connects to" question finds the connectivity query',
    q: 'Who does neuron VFB_jrchjtdb connect to most strongly?',
    digest: { name: 'DA1_lPN_R' },
    query: { query_type: 'NeuronNeuronConnectivityQuery', label: 'Neurons connected to DA1_lPN_R' }
  }
]

for (const c of CASES) {
  test(c.name, () => {
    assert.equal(labelOverlapScore(c.q, c.digest, c.query, listQueryWords), 0,
      'fixture is only meaningful while the old scorer still returns zero')
    assert.ok(queryRelevanceScore(c.q, c.digest, c.query) > 0, 'must no longer be invisible')
  })
}

// --- the consequence, end to end -------------------------------------------

test('the query that answers the question is now the top unanswered ask', () => {
  const ledger = {
    question: 'What neuron types are intrinsic to the mushroom body?',
    terms: {
      FBbt_00005801: {
        id: 'FBbt_00005801',
        label: 'mushroom body',
        digest: {
          name: 'mushroom body',
          queries: [
            { query_type: 'anatScRNAseqQuery', label: 'Single cell transcriptomics data for mushroom body', count: 3, countKind: 'exact' },
            { query_type: 'NeuronsPartHere', label: 'Neurons with some part in mushroom body', count: 602, countKind: 'exact' },
            { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in mushroom body', count: 40, countKind: 'exact' }
          ]
        }
      },
      // The term intrinsicTermNames adds. The planner never writes this name —
      // the question does not contain it — which is exactly why the injection
      // exists.
      FBbt_00007484: {
        id: 'FBbt_00007484',
        label: 'mushroom body intrinsic neuron',
        digest: {
          name: 'mushroom body intrinsic neuron',
          queries: [
            { query_type: 'SubclassesOf', label: 'Subclasses of mushroom body intrinsic neuron', count: -1, countKind: 'unknown' },
            { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in mushroom body intrinsic neuron', count: -1, countKind: 'unknown' }
          ]
        }
      }
    },
    plan: [],
    evidence: []
  }
  const asks = unansweredAsks(buildShelf(ledger))
  assert.ok(asks.length, 'the class-list query must be asked for, not silently dropped')
  assert.equal(asks[0].query_type, 'SubclassesOf')
  assert.ok(!asks.some(a => a.query_type === 'NeuronsPartHere'),
    'a spatial-overlap query must not be offered as the answer to an intrinsic question')
})

test('“extrinsic neurons of the mushroom body” keeps the spatial query', () => {
  // The mirror case, and the reason the veto reads the whole phrase rather than
  // the word "intrinsic": extrinsic-ness IS part-overlap, so NeuronsPartHere is
  // the right query here and must survive.
  const ledger = {
    question: 'What extrinsic neurons does the mushroom body have?',
    terms: {
      FBbt_00005801: {
        id: 'FBbt_00005801',
        label: 'mushroom body',
        digest: {
          name: 'mushroom body',
          queries: [
            { query_type: 'NeuronsPartHere', label: 'Neurons with some part in mushroom body', count: 602, countKind: 'exact' }
          ]
        }
      }
    },
    plan: [],
    evidence: []
  }
  const asks = unansweredAsks(buildShelf(ledger))
  assert.equal(asks[0]?.query_type, 'NeuronsPartHere')
})

test('a kind set computed once matches one computed per query', () => {
  const q = 'What genes are expressed in Kenyon cells?'
  const digest = { name: 'Kenyon cell' }
  const sets = questionKindSets(q)
  for (const query of [
    { query_type: 'anatScRNAseqQuery', label: 'Single cell transcriptomics data for Kenyon cell' },
    { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in Kenyon cell' },
    { query_type: 'ListAllAvailableImages', label: 'List all available images of Kenyon cell' }
  ]) {
    assert.equal(
      queryRelevanceScore(q, digest, query, listQueryWords, sets),
      queryRelevanceScore(q, digest, query),
      query.query_type
    )
  }
})
