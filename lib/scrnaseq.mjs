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

import { splitMarkdownCell } from './markdownLinks.mjs'

function rowsOf(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload.rows)) return payload.rows
  if (Array.isArray(payload.preview_results?.rows)) return payload.preview_results.rows
  if (Array.isArray(payload)) return payload
  return []
}

// "[label](ID)" -> { label, id }; plain text -> { label, id:'' }.
function parseMarkdownEntity(s = '') {
  const { text, target } = splitMarkdownCell(s)
  return { label: text, id: target }
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

// The clusterExpression table tags every gene with FlyBase's function
// vocabulary — "Receptor", "Neurotransmitter_receptor", "Dopamine_receptor",
// "Transcription_factor", "Ion_channel", "GPCR", "Transporter", "Enzyme",
// "Neuropeptide", … — so a question that names a FUNCTION ("which receptor
// genes", "transcription factors") is answered by filtering on the tag rather
// than by a hand-kept symbol list. "Which receptor genes are most highly
// expressed in Kenyon cells?" was answered with the top genes of any kind —
// ribosomal RNAs first — because only the symbol lists existed (issue #45).
// A question phrase maps to the tag it names; "receptor" alone matches every
// tag that contains the word, so "dopamine receptor" and "GABA receptor"
// genes are receptors too.
const FUNCTION_CUES = [
  [/\b(neurotransmitter|transmitter)\s+receptors?\b/i, 'neurotransmitter receptor'],
  [/\bdopamine\s+receptors?\b/i, 'dopamine receptor'],
  [/\b(acetylcholine|cholinergic|nicotinic|muscarinic)\s+receptors?\b/i, 'acetylcholine receptor'],
  [/\bgaba\s+receptors?\b/i, 'gaba receptor'],
  [/\bglutamate\s+receptors?\b/i, 'glutamate receptor'],
  [/\bserotonin\s+receptors?\b/i, 'serotonin receptor'],
  [/\boctopamine\s+receptors?\b/i, 'octopamine receptor'],
  [/\btyramine\s+receptors?\b/i, 'tyramine receptor'],
  [/\b(olfactory|odorant)\s+receptors?\b/i, 'olfactory receptor'],
  [/\bgustatory\s+receptors?\b/i, 'gustatory receptor'],
  [/\b(peptide|hormone)\s+receptors?\b/i, 'hormone receptor'],
  [/\breceptors?\b/i, 'receptor'],
  [/\bgpcrs?\b|\bg[- ]protein[- ]coupled\b/i, 'gpcr'],
  [/\btranscription\s+factors?\b|\btfs?\b/i, 'transcription factor'],
  [/\bion\s+channels?\b|\bchannels?\b/i, 'ion channel'],
  [/\btransporters?\b/i, 'transporter'],
  [/\benzymes?\b/i, 'enzyme'],
  [/\bneuropeptides?\b/i, 'neuropeptide'],
  [/\bhormones?\b/i, 'hormone'],
  [/\bcell[- ]adhesion\b|\badhesion\s+molecules?\b/i, 'cell adhesion'],
  [/\bkinases?\b/i, 'kinase'],
  [/\bchaperones?\b/i, 'chaperone']
]

/** Normalise a FlyBase function tag or a question phrase for matching. */
function normFunction(s = '') {
  return String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The function classes a question asks for, most specific first. */
export function extractRequestedFunctions(question = '') {
  const q = String(question || '')
  const out = []
  for (const [re, tag] of FUNCTION_CUES) {
    if (re.test(q) && !out.includes(tag)) out.push(tag)
  }
  // "receptor" is implied by every specific receptor class; keep it only when
  // it is the most specific thing asked, so a "dopamine receptor" question is
  // not widened to every receptor.
  if (out.length > 1 && out.includes('receptor') && out.some(t => t !== 'receptor' && t.endsWith('receptor'))) {
    return out.filter(t => t !== 'receptor')
  }
  return out
}

/** True when a gene's function tags satisfy any of the requested classes. */
export function geneMatchesFunction(functionText = '', wantedFunctions = []) {
  if (!wantedFunctions.length) return false
  const tags = String(functionText || '').split(';').map(normFunction).filter(Boolean)
  if (!tags.length) return false
  return wantedFunctions.some(w => {
    const want = normFunction(w)
    return tags.some(t => t === want || (want === 'receptor' && /\breceptor\b/.test(t)) || t.endsWith(` ${want}`))
  })
}

/**
 * Work out which genes the question is asking about: an explicit named gene set
 * (e.g. "dopamine receptors"), a FUNCTION class ("receptor genes",
 * "transcription factors"), and/or explicit gene symbols written in the text.
 * Returns { set, symbols, functions } — all empty when the question names no
 * specific genes (the recipe then reports the top-expressed genes instead).
 */
export function extractRequestedGenes(question = '') {
  const q = String(question || '')
  const lower = q.toLowerCase()
  let symbols = []
  let set = null
  const functions = extractRequestedFunctions(q)
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
  return { set: set || (functions.length ? functions[0] : null), symbols: out, functions }
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
  const wantedFunctions = (requested.functions || [])
  const useClusters = clusters.filter(c => perCluster.has(c.id))
  const geneMap = new Map() // symbol -> { symbol, fbgn, function, perCluster:[{clusterId,clusterName,level,extent}] }

  // Explicit symbols are kept whole. A function class is a FILTER on the
  // table, ranked by level and capped like the unfiltered view — "the most
  // highly expressed receptor genes" is the top of the receptor rows, not
  // every receptor the cluster expresses.
  const byLevel = (a, b) => (b.expressionLevel || 0) - (a.expressionLevel || 0)
  for (const cluster of useClusters) {
    let rows = perCluster.get(cluster.id) || []
    if (wanted.length || wantedFunctions.length) {
      const explicit = wanted.length ? rows.filter(g => matchesGene(g.symbol, wanted)) : []
      const byFunction = wantedFunctions.length
        ? rows.filter(g => geneMatchesFunction(g.function, wantedFunctions) && !matchesGene(g.symbol, wanted)).sort(byLevel).slice(0, maxGenes)
        : []
      rows = [...explicit, ...byFunction]
    } else rows = [...rows].sort(byLevel).slice(0, maxGenes)
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
  if (!wanted.length || wantedFunctions.length) {
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
    requested_functions: wantedFunctions,
    gene_set: requested.set || null,
    clusters: useClusters.map(c => ({ id: c.id, name: c.name, dataset: c.dataset })),
    genes: genes.slice(0, maxGenes),
    citations,
    note: (wanted.length || wantedFunctions.length) && genes.length === 0
      ? `None of the requested ${wantedFunctions.length && !wanted.length ? `${wantedFunctions.join('/')} genes` : 'genes'} were found in the scRNA-seq expression tables for these clusters.`
      : ''
  }
}

// Shorten a cluster/cell-type label for a column header, e.g.
// "scRNAseq_2018_Davie_FULL_seq_clustering_gamma_Kenyon_cells" or
// "adult gamma Kenyon cell" -> "gamma Kenyon cell".
function shortClusterLabel(perClusterEntry) {
  const cell = String(perClusterEntry.cellType || '').replace(/^adult\s+/i, '').trim()
  if (cell) return cell
  const name = String(perClusterEntry.clusterName || perClusterEntry.clusterId || '')
  const m = name.match(/clustering_(.+)$/i)
  return (m ? m[1] : name).replace(/_/g, ' ').replace(/\bKenyon cells?\b/i, 'KC').trim()
}

function fmtLevel(level, extent) {
  if (!Number.isFinite(level)) return '–'
  const lvl = level >= 1000 ? Math.round(level).toLocaleString('en-GB') : (Math.round(level * 10) / 10).toString()
  const ext = Number.isFinite(extent) ? ` (${Math.round(extent * 100)}%)` : ''
  return `${lvl}${ext}`
}

/**
 * Render the expression matrix as a deterministic markdown table so the precise
 * per-subtype numbers reach the user regardless of what the weak synthesiser keeps.
 * Columns are clusters/subtypes, rows are genes, cells are "level (percent cells)".
 * Returns '' when there is nothing quantitative to show.
 */
export function renderExpressionMarkdown(matrix, termLabel = '') {
  if (!matrix || !Array.isArray(matrix.genes) || matrix.genes.length === 0) return ''
  // Unique columns, in first-seen order, keyed by clusterId.
  const cols = []
  const seen = new Set()
  for (const g of matrix.genes) {
    for (const p of (g.perCluster || [])) {
      if (!seen.has(p.clusterId)) { seen.add(p.clusterId); cols.push({ id: p.clusterId, label: shortClusterLabel(p) }) }
    }
  }
  if (cols.length === 0) return ''
  const header = `| Gene | ${cols.map(c => c.label).join(' | ')} |`
  const sep = `| --- | ${cols.map(() => '---').join(' | ')} |`
  const lines = [header, sep]
  for (const g of matrix.genes) {
    const byCol = new Map((g.perCluster || []).map(p => [p.clusterId, p]))
    const cells = cols.map(c => { const p = byCol.get(c.id); return p ? fmtLevel(p.level, p.extent) : '–' })
    lines.push(`| ${g.symbol} | ${cells.join(' | ')} |`)
  }
  const scope = Array.isArray(matrix.requested_functions) && matrix.requested_functions.length && !(matrix.requested_genes || []).length
    ? ` — ${matrix.requested_functions.join(', ')} genes, by expression level`
    : ''
  const title = `**scRNA-seq expression${termLabel ? ` — ${termLabel}` : ''}${scope}** (expression level; % = fraction of cells expressing)`
  const cite = (matrix.citations || []).map(c => c.label || (c.pmid ? `PMID ${c.pmid}` : '')).filter(Boolean)
  const citeLine = cite.length ? `\n\n_Source: ${cite.join('; ')}_` : ''
  return `${title}\n\n${lines.join('\n')}${citeLine}`
}
