// A GAL4 line is not a gene.
//
// Live failure this covers (workshop prompt P6): "What genes are expressed in
// cell type T?" was answered with driver lines. Every matcher in the stack keyed
// on the single word "express", which both questions share and nothing else
// does, so a transcriptomics question was routed, planned and tabulated as a
// genetic-reagent one. Three layers had to agree, so all three are covered here.
//
// Run: node --test tests/unit/geneVsDriver.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGeneExpressionQuestion, isDriverLineQuestion } from '../../lib/queryTypes.mjs'
import { pickQueriesByIntent } from '../../lib/orchestrator.mjs'
import { selectCards } from '../../lib/guidanceCards.mjs'
import { buildTables } from '../../lib/resultTables.mjs'

// --- the discriminator ------------------------------------------------------

test('gene vocabulary without reagent vocabulary is a transcriptomics question', () => {
  for (const q of [
    'What genes are expressed in cell type T?',
    'Which marker genes are associated with Kenyon cells?',
    'What receptors does the MBON express?',
    'What scRNAseq data does VFB have for this cell type?',
    'Show me the single-cell transcriptome of T'
  ]) {
    assert.equal(isGeneExpressionQuestion(q), true, q)
    assert.equal(isDriverLineQuestion(q), false, q)
  }
})

test('reagent vocabulary without gene vocabulary is a genetic-tools question', () => {
  for (const q of [
    'Which GAL4 lines label the mushroom body?',
    'What driver lines are available for T?',
    'Show me split-GAL4 combinations for this neuron',
    'Which LexA reporters express in the antennal lobe?'
  ]) {
    assert.equal(isDriverLineQuestion(q), true, q)
    assert.equal(isGeneExpressionQuestion(q), false, q)
  }
})

test('naming a gene is not asking about its expression', () => {
  // "What is the gene ort?" is a definitional lookup. Routing it to single-cell
  // cluster queries would be its own wrong answer, so a bare gene word needs an
  // expression cue beside it.
  assert.equal(isGeneExpressionQuestion('What is the gene ort?'), false)
  assert.equal(isGeneExpressionQuestion('Tell me about the receptor Or22a'), false)
  assert.equal(isGeneExpressionQuestion('Which genes are expressed in T?'), true)
})

test('a question carrying both vocabularies is claimed by neither', () => {
  // "Which drivers label the cells expressing gene X" really is both. Forcing it
  // either way would drop half the answer, so it falls through to the broader
  // rules that offer both kinds.
  const q = 'Which GAL4 drivers label the cells expressing the gene ort?'
  assert.equal(isGeneExpressionQuestion(q), false)
  assert.equal(isDriverLineQuestion(q), false)
})

// --- layer 1: which term-info query gets run --------------------------------

// A cell type that has BOTH kinds of data — the case where getting it wrong is
// invisible, because a plausible-looking table comes back either way.
const CELL_TYPE = {
  name: 'Kenyon cell',
  queries: [
    { query_type: 'anatScRNAseqQuery', label: 'Single cell transcriptomics data for Kenyon cell', countKind: 'unknown' },
    { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in Kenyon cell', countKind: 'unknown' },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in Kenyon cell', countKind: 'unknown' }
  ]
}
const routed = (q) => pickQueriesByIntent(q, CELL_TYPE).map(x => x.query_type)

test('a genes question runs the single-cell query and NOT the transgene one', () => {
  assert.deepEqual(routed('What genes are expressed in Kenyon cells?'), ['anatScRNAseqQuery'])
  assert.deepEqual(routed('Which marker genes are associated with Kenyon cells?'), ['anatScRNAseqQuery'])
})

test('a driver question runs the transgene query and NOT the single-cell one', () => {
  assert.deepEqual(routed('Which GAL4 lines label Kenyon cells?'), ['TransgeneExpressionHere'])
  assert.deepEqual(routed('What driver lines are available for Kenyon cells?'), ['TransgeneExpressionHere'])
})

test('a question about both still gets both', () => {
  const out = routed('Which GAL4 drivers label the Kenyon cells expressing the gene ort?')
  assert.deepEqual(out.sort(), ['TransgeneExpressionHere', 'anatScRNAseqQuery'])
})

test('a genes question runs nothing rather than the transgene query when there is no single-cell data', () => {
  // The important half of the fix. With no scRNAseq query on the term the old
  // code fell back to the transgene query and answered a question about genes
  // with a list of driver lines. Running nothing is correct: the digest still
  // tells the synthesiser what VFB does hold, without miscalling it genes.
  const noSc = { name: 'medulla', queries: CELL_TYPE.queries.filter(q => q.query_type !== 'anatScRNAseqQuery') }
  assert.deepEqual(pickQueriesByIntent('What genes are expressed in the medulla?', noSc), [])
})

// --- layer 2: what the planner is told --------------------------------------

const cardIds = (q) => selectCards(q).map(c => c.id)

test('the genetic-tools card does not fire on a transcriptomics question', () => {
  // P6-B says "expression" and "marker genes" in one breath; the tools card
  // matched on the first and told the planner to read TransgeneExpressionHere.
  const q = 'For cell type T, what scRNAseq / expression data does VFB have, and which marker genes are associated with it?'
  assert.ok(!cardIds(q).includes('genetic-tools'), 'tools card must stay out of it')
  assert.ok(cardIds(q).includes('scrnaseq'), 'the single-cell card takes it')
})

test('the genetic-tools card still fires on a real driver question', () => {
  const ids = cardIds('Which GAL4 driver lines label the mushroom body?')
  assert.ok(ids.includes('genetic-tools'))
  assert.ok(!ids.includes('scrnaseq'))
})

test('the two cards can never both claim a pure gene question', () => {
  for (const q of ['What genes are expressed in T?', 'Which receptors does T express?']) {
    const ids = cardIds(q)
    assert.ok(!(ids.includes('genetic-tools') && ids.includes('scrnaseq')), q)
  }
})

test('the single-cell card warns the synthesiser that a driver line is not a gene', () => {
  const card = selectCards('What genes are expressed in T?').find(c => c.id === 'scrnaseq')
  assert.match(card.synth, /genetic REAGENTS, not genes/)
  assert.match(card.synth, /never list them as genes/)
})

// --- layer 3: which table the user is shown ---------------------------------

function ledgerWithBoth() {
  return {
    terms: {
      'Kenyon cell': {
        id: 'FBbt_00003686', label: 'Kenyon cell',
        digest: {
          name: 'Kenyon cell',
          queries: [
            { query_type: 'TransgeneExpressionHere', label: 'Transgene expression in Kenyon cell', count: 40, output_format: 'table',
              previewRows: [{ name: 'MB247-GAL4', id: 'VFB_1', thumbnail: '', tags: [] }] },
            { query_type: 'NeuronsPartHere', label: 'Neurons with some part in Kenyon cell', count: 9, output_format: 'table',
              previewRows: [{ name: 'KCg', id: 'FBbt_2', thumbnail: '', tags: [] }] }
          ]
        }
      }
    }
  }
}

test('a genes question is never shown the driver table', () => {
  const tables = buildTables(ledgerWithBoth(), 'What genes are expressed in Kenyon cells?')
  assert.ok(!tables.some(t => /Transgene expression/i.test(t.title)),
    'a list of GAL4 lines under a question about genes reads as the answer, and is not one')
})

test('a driver question is still shown the driver table, and only that', () => {
  const tables = buildTables(ledgerWithBoth(), 'Which GAL4 lines label Kenyon cells?')
  assert.ok(tables.length)
  assert.match(tables[0].title, /Transgene expression/i)
  assert.ok(!tables.some(t => /Neurons with some part/i.test(t.title)), 'the cells labelled are not the reagents')
})
