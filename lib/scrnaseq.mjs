// scRNA-seq expression recipe (pure, offline-testable).
//
// The paper's flagship multi-hop example (T4.9) — "which dopamine-receptor genes
// do Kenyon cells express, by subtype?" — is a two-hop VFB chain that a weak local
// model cannot drive reliably:
//   term (hasScRNAseq)  --anatScRNAseqQuery-->  scRNAseq clusters (FBlc, with pubs)
//   cluster             --clusterExpression-->  per-gene expression table (~1000s rows)
// The clusterExpression payload is ~450 KB per cluster, so the value of a
// deterministic recipe is doing the chain AND filtering to the requested genes
// server-side, handing the model a small, cited matrix instead of a huge table.
//
// This module holds the pure parsing/filtering/assembly logic. The route layer
// performs the two run_query calls and renders the result; the harness routes
// scRNA-seq/expression-gene questions here via a guidance card + injected step.

function rowsOf(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload.rows)) return payload.rows
  if (Array.isArray(payload.preview_results?.rows)) return payload.preview_results.rows
  if (Array.isArray(payload)) return payload
  return []
}

// "[label](ID)" -> { label, id }; plain text -> { label, id:'' }.
function parseMarkdownEntity(s = '') {
  const m = String(s).match(/\[([^\]]+)\]\(([^)]+)\)/)
  if (m) return { label: m[1].trim(), id: m[2].trim() }
  return { label: String(s).trim(), id: '' }
}

function pubFrom(pubs) {
  // anatScRNAseqQuery rows carry pubs either as an array of {PubMed,DOI,FlyBase,core}
  // or as a markdown metadata string. Return the first real reference.
  if (Array.isArray(pubs)) {
    const p = pubs.find(Boolean)
    if (p) {
      return {
        label: p.core?.label || '',
        pmid: p.PubMed || '',
        doi: p.DOI || '',
        fbrf: p.FlyBase || p.core?.short_form || ''
      }
    }
  }
  if (typeof pubs === 'string' && pubs.trim()) {
    const ent = parseMarkdownEntity(pubs)
    return { label: ent.label, pmid: '', doi: '', fbrf: /^FBrf/.test(ent.id) ? ent.id : '' }
  }
  return null
}

/** Parse anatScRNAseqQuery output into clusters. */
export function parseScrnaseqClusters(payload) {
  return rowsOf(payload).map(r => {
    const name = parseMarkdownEntity(r.name || r.label || '')
    const dataset = parseMarkdownEntity(r.dataset || '')
    return {
      id: r.id || name.id || '',
      name: name.label,
      dataset: dataset.label,
      datasetId: dataset.id,
      tags: typeof r.tags === 'string' ? r.tags.split('|').map(t => t.trim()).filter(Boolean) : [],
      pub: pubFrom(r.pubs)
    }
  }).filter(c => c.id)
}

/** Parse clusterExpression output into gene rows. */
export function parseClusterExpression(payload) {
  return rowsOf(payload).map(r => {
    const gene = parseMarkdownEntity(r.name || '')
    const anatomy = parseMarkdownEntity(r.anatomy || '')
    const level = Number(r.expression_level)
    const extent = Number(r.expression_extent)
    return {
      fbgn: r.id || gene.id || '',
      symbol: gene.label,
      cellType: anatomy.label,
      cellTypeId: anatomy.id,
      expressionLevel: Number.isFinite(level) ? level : null,
      expressionExtent: Number.isFinite(extent) ? extent : null,
      function: typeof r.function === 'string' ? r.function : ''
    }
  }).filter(g => g.symbol)
}

// Named gene sets the user may ask about by description rather than symbol.
export const GENE_SETS = {
  'dopamine receptor': ['Dop1R1', 'Dop1R2', 'Dop2R', 'DopEcR'],
  'acetylcholine receptor': ['nAChRalpha1', 'nAChRalpha2', 'nAChRalpha3', 'nAChRalpha4', 'nAChRalpha5', 'nAChRalpha6', 'nAChRalpha7', 'nAChRbeta1', 'nAChRbeta2', 'nAChRbeta3', 'mAChR-A', 'mAChR-B', 'mAChR-C'],
  'gaba receptor': ['Rdl', 'Grd', 'Lcch3', 'GABA-B-R1', 'GABA-B-R2', 'GABA-B-R3'],
  'glutamate receptor': ['GluClalpha', 'GluRIA', 'GluRIB', 'mGluR', 'KaiR1D', 'clumsy', 'CG3822'],
  'serotonin receptor': ['5-HT1A', '5-HT1B', '5-HT2A', '5-HT2B', '5-HT7'],
  'octopamine receptor': ['Oamb', 'Octbeta1R', 'Octbeta2R', 'Octbeta3R', 'Oct-TyrR']
}

/**
 * Work out which genes the question is asking about: an explicit named gene set
 * (e.g. "dopamine receptors"), and/or explicit gene symbols written in the text.
 * Returns { set, symbols } — empty when the question names no specific genes
 * (the recipe then reports the top-expressed genes instead).
 */
export function extractRequestedGenes(question = '') {
  const q = String(question || '')
  const lower = q.toLowerCase()
  let symbols = []
  let set = null
  for (const [name, members] of Object.entries(GENE_SETS)) {
    // singular or plural ("dopamine receptor" / "dopamine receptors")
    if (new RegExp(`\\b${name}s?\\b`, 'i').test(lower)) { set = name; symbols = symbols.concat(members) }
  }
  // explicit gene-like symbols: letters+digits with a capital, e.g. Dop1R1, nAChRalpha7, 5-HT2A
  const explicit = q.match(/\b\d?[A-Za-z][A-Za-z0-9]*(?:-?[A-Za-z0-9]+)*\b/g) || []
  for (const tok of explicit) {
    if (/^(Dop[0-9]\w*|DopEcR|nAChR\w+|mAChR[\w-]+|GluR\w+|GluCl\w*|GABA[\w-]+|5-HT\w+|Oct\w+|Oamb|Rdl|mGluR|KaiR\w+)$/i.test(tok)) symbols.push(tok)
  }
  // dedup, case-insensitively
  const seen = new Set()
  const out = []
  for (const s of symbols) { const k = s.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(s) } }
  return { set, symbols: out }
}

function matchesGene(symbol, wanted) {
  const s = String(symbol).toLowerCase()
  return wanted.some(w => s === String(w).toLowerCase())
}

/**
 * Assemble a compact gene × cluster expression matrix for the requested genes.
 * @param clusters  parseScrnaseqClusters output
 * @param perCluster Map<clusterId, parseClusterExpression output>
 * @param requested { set, symbols } from extractRequestedGenes
 * @param opts { maxGenes, maxClusters } caps for an unfiltered (top-expressed) view
 */
export function buildExpressionMatrix(clusters, perCluster, requested = { symbols: [] }, opts = {}) {
  const maxGenes = opts.maxGenes || 20
  const wanted = (requested.symbols || [])
  const useClusters = clusters.filter(c => perCluster.has(c.id))
  const geneMap = new Map() // symbol -> { symbol, fbgn, function, perCluster:[{clusterId,clusterName,level,extent}] }

  for (const cluster of useClusters) {
    let rows = perCluster.get(cluster.id) || []
    if (wanted.length) rows = rows.filter(g => matchesGene(g.symbol, wanted))
    else rows = [...rows].sort((a, b) => (b.expressionLevel || 0) - (a.expressionLevel || 0)).slice(0, maxGenes)
    for (const g of rows) {
      if (!geneMap.has(g.symbol)) geneMap.set(g.symbol, { symbol: g.symbol, fbgn: g.fbgn, function: g.function, perCluster: [] })
      geneMap.get(g.symbol).perCluster.push({
        clusterId: cluster.id, clusterName: cluster.name, cellType: g.cellType,
        level: g.expressionLevel, extent: g.expressionExtent
      })
    }
  }

  const genes = [...geneMap.values()]
  // when the user named genes, keep that order; else rank by peak expression level
  if (!wanted.length) {
    genes.sort((a, b) => Math.max(...b.perCluster.map(p => p.level || 0), 0) - Math.max(...a.perCluster.map(p => p.level || 0), 0))
  }
  // citations: unique pubs across the clusters used
  const citations = []
  const seenPub = new Set()
  for (const c of useClusters) {
    const key = c.pub && (c.pub.pmid || c.pub.doi || c.pub.label)
    if (c.pub && key && !seenPub.has(key)) { seenPub.add(key); citations.push(c.pub) }
  }
  return {
    requested_genes: wanted,
    gene_set: requested.set || null,
    clusters: useClusters.map(c => ({ id: c.id, name: c.name, dataset: c.dataset })),
    genes: genes.slice(0, maxGenes),
    citations,
    note: wanted.length && genes.length === 0
      ? 'None of the requested genes were found in the scRNA-seq expression tables for these clusters.'
      : ''
  }
}
