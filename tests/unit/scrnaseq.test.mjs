// Tests for the scRNA-seq expression recipe (pure core).
// Run: node --test tests/unit/scrnaseq.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScrnaseqClusters, parseClusterExpression, extractRequestedGenes,
  buildExpressionMatrix, GENE_SETS
} from '../../lib/scrnaseq.mjs'

// Shapes mirror the live VFB anatScRNAseqQuery / clusterExpression output.
const CLUSTERS = {
  rows: [
    { id: 'FBlc0006127', name: '[scRNAseq_2018_Davie_gamma_Kenyon_cells](FBlc0006127)', dataset: '[scRNAseq_2018_Davie](FBlc0006090)', tags: 'Adult|Cluster',
      pubs: [{ core: { label: 'Davie et al., 2018, Cell' }, PubMed: '29909982', DOI: '10.1016/j.cell.2018.05.057', FlyBase: 'FBrf0239740' }] },
    { id: 'FBlc0006141', name: '[scRNAseq_2018_Davie_alpha_beta_Kenyon_cells](FBlc0006141)', dataset: '[scRNAseq_2018_Davie](FBlc0006090)', tags: 'Adult|Cluster',
      pubs: [{ core: { label: 'Davie et al., 2018, Cell' }, PubMed: '29909982', DOI: '10.1016/j.cell.2018.05.057', FlyBase: 'FBrf0239740' }] }
  ]
}

const expr = (sym, fbgn, cell, level, extent, fn = '') => ({
  id: fbgn, name: `[${sym}](${fbgn})`, anatomy: `[${cell}](FBbt_x)`,
  expression_level: String(level), expression_extent: extent, tags: 'Gene', function: fn
})
const GAMMA_EXPR = { headers: {}, rows: [
  expr('Dop1R1', 'FBgn0011582', 'adult gamma Kenyon cell', 1200.5, 0.81, 'GPCR'),
  expr('Dop2R', 'FBgn0053517', 'adult gamma Kenyon cell', 640.2, 0.55),
  expr('jdp', 'FBgn0027654', 'adult gamma Kenyon cell', 15079.3, 0.99, 'Chaperone')
] }
const AB_EXPR = { headers: {}, rows: [
  expr('Dop1R1', 'FBgn0011582', 'adult alpha/beta Kenyon cell', 980.0, 0.74, 'GPCR'),
  expr('DopEcR', 'FBgn0035538', 'adult alpha/beta Kenyon cell', 210.0, 0.30)
] }

test('parseScrnaseqClusters pulls id, name, dataset and the publication', () => {
  const cs = parseScrnaseqClusters(CLUSTERS)
  assert.equal(cs.length, 2)
  assert.equal(cs[0].id, 'FBlc0006127')
  assert.match(cs[0].name, /gamma_Kenyon/)
  assert.equal(cs[0].dataset, 'scRNAseq_2018_Davie')
  assert.equal(cs[0].pub.pmid, '29909982')
})

test('parseClusterExpression yields symbol/fbgn/level/extent', () => {
  const g = parseClusterExpression(GAMMA_EXPR)
  assert.equal(g.length, 3)
  const dop1 = g.find(x => x.symbol === 'Dop1R1')
  assert.equal(dop1.fbgn, 'FBgn0011582')
  assert.equal(dop1.expressionLevel, 1200.5)
  assert.equal(dop1.expressionExtent, 0.81)
})

test('extractRequestedGenes recognises a named gene set and explicit symbols', () => {
  const r1 = extractRequestedGenes('which dopamine receptor genes do adult Kenyon cells express?')
  assert.equal(r1.set, 'dopamine receptor')
  assert.deepEqual(r1.symbols, GENE_SETS['dopamine receptor'])
  const r2 = extractRequestedGenes('does the Kenyon cell express Dop1R1 and Rdl?')
  assert.ok(r2.symbols.includes('Dop1R1') && r2.symbols.includes('Rdl'))
  const r3 = extractRequestedGenes('what is the mushroom body?')
  assert.equal(r3.set, null)
  assert.equal(r3.symbols.length, 0)
})

test('buildExpressionMatrix filters to requested genes across clusters, with citations', () => {
  const clusters = parseScrnaseqClusters(CLUSTERS)
  const perCluster = new Map([
    ['FBlc0006127', parseClusterExpression(GAMMA_EXPR)],
    ['FBlc0006141', parseClusterExpression(AB_EXPR)]
  ])
  const requested = extractRequestedGenes('dopamine receptor expression in Kenyon cells')
  const m = buildExpressionMatrix(clusters, perCluster, requested)
  // only DA receptors kept (jdp dropped), present across both clusters
  const syms = m.genes.map(g => g.symbol).sort()
  assert.deepEqual(syms, ['Dop1R1', 'Dop2R', 'DopEcR'])
  const dop1 = m.genes.find(g => g.symbol === 'Dop1R1')
  assert.equal(dop1.perCluster.length, 2)           // γ and α/β
  assert.ok(!m.genes.some(g => g.symbol === 'jdp'))  // non-receptor filtered out
  assert.equal(m.citations[0].pmid, '29909982')      // Davie 2018 cited
  assert.equal(m.gene_set, 'dopamine receptor')
})

test('buildExpressionMatrix returns a top-expressed view when no genes named', () => {
  const clusters = parseScrnaseqClusters(CLUSTERS)
  const perCluster = new Map([['FBlc0006127', parseClusterExpression(GAMMA_EXPR)]])
  const m = buildExpressionMatrix(clusters, perCluster, { symbols: [] }, { maxGenes: 2 })
  // ranked by expression level: jdp (15079) then Dop1R1 (1200)
  assert.deepEqual(m.genes.map(g => g.symbol), ['jdp', 'Dop1R1'])
})

test('buildExpressionMatrix notes when requested genes are absent', () => {
  const clusters = parseScrnaseqClusters(CLUSTERS)
  const perCluster = new Map([['FBlc0006127', parseClusterExpression(GAMMA_EXPR)]])
  const m = buildExpressionMatrix(clusters, perCluster, { symbols: ['NotAGene'] })
  assert.equal(m.genes.length, 0)
  assert.match(m.note, /None of the requested genes/)
})
