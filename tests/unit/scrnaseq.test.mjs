// Tests for the scRNA-seq expression recipe (pure core).
// Run: node --test tests/unit/scrnaseq.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScrnaseqClusters, parseClusterExpression, extractRequestedGenes,
  buildExpressionMatrix, renderExpressionMarkdown, GENE_SETS, describeCluster, clusterDatasetLabel
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

test('renderExpressionMarkdown builds a gene × subtype table with levels, percent and a citation', () => {
  const clusters = parseScrnaseqClusters(CLUSTERS)
  const perCluster = new Map([
    ['FBlc0006127', parseClusterExpression(GAMMA_EXPR)],
    ['FBlc0006141', parseClusterExpression(AB_EXPR)]
  ])
  const m = buildExpressionMatrix(clusters, perCluster, extractRequestedGenes('dopamine receptors in Kenyon cells'))
  const md = renderExpressionMarkdown(m, 'Kenyon cell')
  assert.match(md, /scRNA-seq expression — Kenyon cell/)
  assert.match(md, /\| Gene \|/)
  assert.match(md, /gamma Kenyon cell/)          // column header from cell type
  assert.match(md, /Dop1R1 \|[^|]*\(81%\)/)      // level + fraction of cells
  assert.match(md, /Source:.*Davie/)             // citation line
  // empty matrix -> no table
  assert.equal(renderExpressionMarkdown({ genes: [] }), '')
})

test('buildExpressionMatrix notes when requested genes are absent', () => {
  const clusters = parseScrnaseqClusters(CLUSTERS)
  const perCluster = new Map([['FBlc0006127', parseClusterExpression(GAMMA_EXPR)]])
  const m = buildExpressionMatrix(clusters, perCluster, { symbols: ['NotAGene'] })
  assert.equal(m.genes.length, 0)
  assert.match(m.note, /None of the requested genes/)
})

// Issue #45: "which receptor genes are most highly expressed" is a FUNCTION
// filter on the clusterExpression table's function column, not a symbol list.
test('a function class in the question filters the expression table by FlyBase function tag', async () => {
  const { extractRequestedGenes, extractRequestedFunctions, geneMatchesFunction, buildExpressionMatrix, renderExpressionMarkdown } = await import('../../lib/scrnaseq.mjs')
  assert.deepEqual(extractRequestedFunctions('Which receptor genes are most highly expressed in Kenyon cells?'), ['receptor'])
  assert.deepEqual(extractRequestedFunctions('which dopamine receptors do Kenyon cells express?'), ['dopamine receptor'])
  assert.deepEqual(extractRequestedFunctions('which transcription factors and ion channels are expressed?'), ['transcription factor', 'ion channel'])
  assert.deepEqual(extractRequestedFunctions('top marker genes with expression levels'), [])
  assert.equal(geneMatchesFunction('GABA_receptor; Ion_channel; Receptor', ['receptor']), true)
  assert.equal(geneMatchesFunction('Dopamine_receptor; GPCR', ['receptor']), true)
  assert.equal(geneMatchesFunction('DNA_binding; Transcription_factor', ['receptor']), false)
  assert.equal(geneMatchesFunction('Dopamine_receptor; GPCR', ['gaba receptor']), false)
  assert.equal(geneMatchesFunction('', ['receptor']), false)

  const clusters = [{ id: 'c1', name: 'alpha_beta_KC', dataset: 'Davie', pub: { label: 'Davie et al., 2018' } }]
  const rows = [
    { symbol: '18SrRNA', fbgn: 'FBgn1', expressionLevel: 31752, expressionExtent: 1, function: '' },
    { symbol: 'pros', fbgn: 'FBgn2', expressionLevel: 13181, expressionExtent: 0.99, function: 'DNA_binding; Transcription_factor' },
    { symbol: 'Rdl', fbgn: 'FBgn3', expressionLevel: 4101, expressionExtent: 0.99, function: 'GABA_receptor; Ion_channel; Neurotransmitter_receptor; Receptor' },
    { symbol: 'Dop2R', fbgn: 'FBgn4', expressionLevel: 2500, expressionExtent: 0.9, function: 'Dopamine_receptor; GPCR; Receptor' }
  ]
  const perCluster = new Map([['c1', rows]])
  const req = extractRequestedGenes('Which receptor genes are most highly expressed in Kenyon cells?')
  const m = buildExpressionMatrix(clusters, perCluster, req)
  assert.deepEqual(m.genes.map(g => g.symbol), ['Rdl', 'Dop2R'], 'receptors only, strongest first')
  assert.deepEqual(m.requested_functions, ['receptor'])
  assert.match(renderExpressionMarkdown(m, 'Kenyon cell'), /receptor genes, by expression level/)
  // No function asked: the top genes of any kind, as before.
  const all = buildExpressionMatrix(clusters, perCluster, extractRequestedGenes('top marker genes for Kenyon cells'))
  assert.equal(all.genes[0].symbol, '18SrRNA')
  // Nothing matches: an honest note naming the class asked for.
  const none = buildExpressionMatrix(clusters, perCluster, extractRequestedGenes('which neuropeptides do Kenyon cells express?'))
  assert.match(none.note, /None of the requested neuropeptide genes/)
})

// Issue #58: four columns all headed "gamma Kenyon cell". What differs between
// the columns is the DATASET — study, year, sex, tissue — and that is what the
// header must say.
test('cluster names decode to study, year, condition, sex and tissue', () => {
  assert.equal(clusterDatasetLabel('scRNAseq_2018_Davie_FULL_seq_clustering_gamma_Kenyon_cells'), 'Davie 2018 · whole fly')
  assert.equal(clusterDatasetLabel('scRNAseq_2022_FCA_FEMALE_HEAD_seq_clustering_gamma_Kenyon_cells'), 'FCA 2022 · female head')
  assert.equal(clusterDatasetLabel('scRNAseq_2023_AFCA_D30_MALE_FULL_seq_clustering_gamma_Kenyon_cells'), 'AFCA 2023 D30 · male whole fly')
  assert.equal(clusterDatasetLabel('not a cluster name'), '')
  assert.deepEqual(describeCluster('scRNAseq_2022_FCA_MIXED_ANT_seq_clustering_Gr21a_ORNs'),
    { study: 'FCA', year: '2022', condition: '', sex: 'mixed', tissue: 'antenna', cell: 'Gr21a ORNs' })
})

test('column headers carry the dataset, and the cell type only when it varies', () => {
  const genes = [{ symbol: 'mub', perCluster: [
    { clusterId: 'a', clusterName: 'scRNAseq_2018_Davie_FULL_seq_clustering_gamma_Kenyon_cells', cellType: 'adult gamma Kenyon cell', level: 100, extent: 1 },
    { clusterId: 'b', clusterName: 'scRNAseq_2022_FCA_FEMALE_HEAD_seq_clustering_gamma_Kenyon_cells', cellType: 'adult gamma Kenyon cell', level: 90, extent: 0.9 },
    { clusterId: 'c', clusterName: 'scRNAseq_2022_FCA_FEMALE_HEAD_seq_clustering_gamma_Kenyon_cells', cellType: 'adult gamma Kenyon cell', level: 80, extent: 0.8 }
  ] }]
  const same = renderExpressionMarkdown({ genes, citations: [] }, 'gamma Kenyon cell')
  assert.match(same, /\| Gene \| Davie 2018 · whole fly \| FCA 2022 · female head \(1\) \| FCA 2022 · female head \(2\) \|/)
  assert.match(same, /columns are the gamma Kenyon cell clusters in each dataset/)
  assert.doesNotMatch(same, /gamma Kenyon cell — /)
  const mixed = renderExpressionMarkdown({ genes: [{ symbol: 'mub', perCluster: [
    { clusterId: 'a', clusterName: 'scRNAseq_2018_Davie_FULL_seq_clustering_gamma_Kenyon_cells', cellType: 'adult gamma Kenyon cell', level: 100, extent: 1 },
    { clusterId: 'b', clusterName: 'scRNAseq_2018_Davie_FULL_seq_clustering_alpha_beta_Kenyon_cells', cellType: 'adult alpha/beta Kenyon cell', level: 90, extent: 0.9 }
  ] }], citations: [] }, 'Kenyon cell')
  assert.match(mixed, /\| gamma Kenyon cell — Davie 2018 · whole fly \| alpha\/beta Kenyon cell — Davie 2018 · whole fly \|/)
})
