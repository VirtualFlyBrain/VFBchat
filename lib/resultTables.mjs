// Result tables + thumbnail gathering (pure, offline-testable).
//
// Each VFB term-info query is itself a table (id, label, tags, thumbnail). When
// the user is asking for a list/results ("which neurons...", "driver lines...",
// "images of..."), we surface that query's rows as a scrollable table with name
// links and thumbnails, plus a "view all N in VFB" run-query link. We also gather
// every row thumbnail so the result gallery can show real images.
//
// See outputs/reports/vfbchat-live-eval-and-followons-2026-06-13.md.

import { vfbReportUrl, vfbQueryUrl } from './followOns.mjs'
import { PREVIEW_COUNT_CAP } from './termInfoDigest.mjs'
import { isGeneExpressionQuestion } from './queryTypes.mjs'

// Rank value for a query whose exact total is unavailable. 'many' means more
// than the counting cap, so it must sort ABOVE every exactly-counted query
// rather than below them all as a raw -1 did; 'unknown' stays last.
function sortableCount(q) {
  const kind = q?.countKind || (Number(q?.count) < 0 ? 'unknown' : 'exact')
  if (kind === 'many') return PREVIEW_COUNT_CAP
  if (kind === 'unknown') return -1
  return Number(q?.count) || 0
}

// Question cues that indicate the user wants a list of results (so a table helps).
// Deliberately excludes bare "what"/"which" — "What is X" is definitional, not a
// request for result rows; list intent must come from an explicit list verb
// (list/show/all/every) or a result-type noun (neurons, images, drivers, …).
const LIST_CUE = /\b(list|show|all|every|driver|drivers|gal4|line|lines|stock|stocks|neuron|neurons|partner|partners|input|inputs|output|outputs|image|images|subtype|subtypes|subclass|subclasses|part|parts|express|expression|clone|clones)\b/i

const STOP = new Set(['what', 'which', 'with', 'this', 'that', 'have', 'does', 'the', 'and', 'for', 'are', 'has', 'from', 'into', 'some', 'all', 'list', 'show', 'in', 'of', 'to', 'a'])

function words(s = '') {
  return String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) || []
}

/** Does the question ask for a list/results (so tables/galleries help)? */
export function isListQuestion(question = '') {
  return LIST_CUE.test(String(question))
}

/**
 * Keyword overlap between the question and a query label, IGNORING the term's own
 * name words. Every query label for a term repeats that term's name (e.g. every
 * "… in adult lateral horn" query), so counting those words made a definitional
 * "What is the adult lateral horn" score against all of them and wrongly surface
 * the biggest result tables. Only the query-distinctive words (neurons, images,
 * expression, subclasses, …) should decide relevance.
 */
function relevance(question, label, termWords) {
  const q = new Set(words(question))
  let n = 0
  for (const w of words(label)) {
    if (termWords && termWords.has(w)) continue
    if (q.has(w)) n++
  }
  return n
}

// Intent → query family. A question about genetic tools/drivers ("what GAL4 lines
// label X neurons") must surface the EXPRESSION/transgene query, not the neuron or
// image lists that the word "neurons" lexically matches. Map the question's intent
// to a query family so the right table wins and the wrong ones are dropped.
const TOOLS_INTENT = /\b(genetic|driver|drivers|gal4|lexa|split|transgene|reporter|expression|express|label|labell?ed|labell?ing|construct|intersectional)\b/i
function queryFamily(q) {
  const s = `${q.query_type || ''} ${q.label || ''}`.toLowerCase()
  if (/expression|transgene|gal4|driver/.test(s)) return 'expression'
  if (/neuron|image/.test(s)) return 'neuron'
  return 'other'
}

/**
 * Build up to `maxTables` result tables for the resolved terms whose query
 * results best match the question. Each table:
 *   { title, queryType, termId, termLabel, count, queryUrl,
 *     rows: [{ name, id, reportUrl, thumbnail, tags }] }
 */
// VFB convention (confirmed from the query labels): neurons with PRESYNAPTIC
// terminals in a region PROVIDE INPUT to it (NeuronsPresynapticHere = "provide
// input"); neurons with POSTSYNAPTIC terminals RECEIVE its OUTPUT
// (NeuronsPostsynapticHere = "receive output"). So a user asking for a region's
// "input neurons" wants the presynaptic table, and "output neurons" the
// postsynaptic table — but those words share no surface form, so map them here.
function directionIntent(question = '') {
  const q = String(question)
  const inWord = /\b(inputs?|afferent|presynaptic|provides? input|feeding into|innervat\w*)\b/i.test(q)
  const outWord = /\b(outputs?|efferent|postsynaptic|receives? output|projects? to|targets? of)\b/i.test(q)
  if (inWord && !outWord) return 'input'
  if (outWord && !inWord) return 'output'
  return null
}

export function buildTables(ledger, question = '', { maxTables = 2 } = {}) {
  const listy = LIST_CUE.test(question)
  // A transcriptomics question is NOT a tools question, however much the word
  // "expression" suggests otherwise: boosting the transgene table for "what
  // genes are expressed in T" put a list of GAL4 lines under a question about
  // genes, which reads as the answer and is not one.
  const geneIntent = isGeneExpressionQuestion(question)
  const toolsIntent = TOOLS_INTENT.test(question) && !geneIntent
  const direction = directionIntent(question)
  // When a gene (FBgn) is resolved alongside a non-gene subject (e.g. "which genes
  // does Kenyon cell express"), the gene is a filter, not the subject — its own
  // "clusters expressing X" tables are off-topic noise, so suppress them.
  const resolved = Object.values(ledger?.terms || {}).filter(t => t && t.id)
  const hasNonGeneTerm = resolved.some(t => !/^FBgn/i.test(t.id))
  const candidates = []
  for (const t of resolved) {
    if (!t.digest?.queries?.length) continue
    if (hasNonGeneTerm && /^FBgn/i.test(t.id)) continue
    const termLabel = t.digest.name
    const termWords = new Set(words(termLabel))
    for (const q of t.digest.queries) {
      const rows = q.previewRows || []
      if (!rows.length) continue
      const family = queryFamily(q)
      // Tools/driver question: never surface neuron/image tables — the user wants
      // the labelling reagents, not the cells being labelled.
      if (toolsIntent && family === 'neuron') continue
      // …and the mirror image: a genes question must never surface the driver
      // table. "Transgene expression in T" shares the word "expression" with the
      // question and would otherwise score its way in.
      if (geneIntent && family === 'expression') continue
      let score = relevance(question, q.label, termWords)
      // …and boost the expression/driver query so it wins even though "genetic
      // tools" shares no surface words with "expression patterns".
      if (toolsIntent && family === 'expression') score += 3
      // Direction intent: surface the presynaptic ("input") / postsynaptic
      // ("output") table even though those words don't overlap the labels.
      const qt = q.query_type || ''
      // …and never show the opposite-direction synaptic table.
      if (direction === 'input' && /Postsynaptic/i.test(qt)) continue
      if (direction === 'output' && /Presynaptic/i.test(qt)) continue
      if (direction === 'input' && /Presynaptic/i.test(qt)) score += 4
      if (direction === 'output' && /Postsynaptic/i.test(qt)) score += 4
      // include only queries the user is plausibly asking about
      if (score <= 0 && !(listy && q.output_format === 'table')) continue
      candidates.push({
        score,
        title: q.label,
        queryType: q.query_type,
        termId: t.id,
        termLabel,
        count: q.count,
        // 'exact' | 'many' | 'unknown' — the renderer needs this to avoid
        // printing a raw -1 as a result total.
        countKind: q.countKind || (Number(q.count) < 0 ? 'unknown' : 'exact'),
        countCap: PREVIEW_COUNT_CAP,
        sortCount: sortableCount(q),
        queryUrl: vfbQueryUrl(t.id, q.query_type),
        rows: rows.map(r => ({
          name: r.name, id: r.id, reportUrl: vfbReportUrl(r.id), thumbnail: r.thumbnail, tags: r.tags
        }))
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.sortCount - a.sortCount)
  // de-dup by query type+term, keep the strongest, drop pure zero-score noise
  const seen = new Set()
  const out = []
  for (const c of candidates) {
    if (c.score <= 0 && out.length) break
    const key = `${c.termId}:${c.queryType}`
    if (seen.has(key)) continue
    seen.add(key)
    const { score, ...table } = c
    out.push(table)
    if (out.length >= maxTables) break
  }
  return out
}

// VFB template ids in default display-preference order: JRC2018Unisex (brain),
// then JRC2018UnisexVNC (ventral nerve cord). When a request arrives deep-linked
// to a specific template we prefer that one first, so an entity's image in the
// template the user is already viewing is shown ahead of the same entity aligned
// to a different template.
export const JRC2018U = 'VFB_00101567'
export const JRC2018UVNC = 'VFB_00200000'
const DEFAULT_TEMPLATE_PRIORITY = [JRC2018U, JRC2018UVNC]

/** Pull the template id out of a scene's `i` param ("<TEMPLATE>,<img>,…"). */
export function requestedTemplateFromScene(scene) {
  const i = scene && typeof scene.i === 'string' ? scene.i : ''
  const first = i.split(',')[0].trim()
  return /^VFB_[0-9a-z]+$/i.test(first) ? first : ''
}

/**
 * Order gallery images by template preference and keep ONE image per entity (the
 * highest-priority template available for it). Preference: the request's own
 * template (if any) → JRC2018U → JRC2018UVNC → anything else. Stable within a
 * rank, so arrival order is preserved among equally-ranked images.
 */
export function orderImagesByTemplate(images = [], preferredTemplateId = '') {
  const priority = [...new Set([preferredTemplateId, ...DEFAULT_TEMPLATE_PRIORITY].filter(Boolean))]
  const rank = (tmpl) => { const i = priority.indexOf(tmpl); return i === -1 ? priority.length : i }
  // Dedup by entity, keeping the best-ranked template for each.
  const byEntity = new Map()
  images.forEach((img, idx) => {
    const key = img.id || img.thumbnail
    const cur = byEntity.get(key)
    if (!cur || rank(img.template) < rank(cur.img.template)) byEntity.set(key, { img, idx })
  })
  return [...byEntity.values()]
    .sort((a, b) => rank(a.img.template) - rank(b.img.template) || a.idx - b.idx)
    .map(e => e.img)
}

/**
 * Every unique row thumbnail across the resolved terms' query previews. Gated on
 * list intent: a definitional "What is X" gets no gallery (its preview rows are
 * images of OTHER entities — neurons in the region — which only confuse the
 * answer). Pass the question; omit it (or pass '') to collect unconditionally.
 */
export function galleryThumbnails(ledger, question = '', { max = 24 } = {}) {
  if (question && !isListQuestion(question)) return []
  const seen = new Set()
  const out = []
  for (const t of Object.values(ledger?.terms || {})) {
    for (const q of (t?.digest?.queries || [])) {
      for (const r of (q.previewRows || [])) {
        // Pair each thumbnail with its row name so the gallery shows a real label
        // (the neuron/term name) instead of a generic "VFB image".
        if (r.thumbnail && !seen.has(r.thumbnail)) {
          seen.add(r.thumbnail)
          out.push({ url: r.thumbnail, label: r.name || '', id: r.id || '' })
        }
      }
    }
  }
  return out.slice(0, max)
}

/**
 * The resolved terms' OWN registered/example images (an individual's
 * registrations, a class's example individuals), for a question about the
 * thing itself — "what is X", "tell me about X". These are pictures of the
 * entity asked about, not of its query results, so they are the honest
 * gallery for a definitional answer and never the same strip for every term.
 */
export function termExampleThumbnails(ledger, { max = 8, perTerm = 4 } = {}) {
  const out = []
  const seen = new Set()
  for (const t of Object.values(ledger?.terms || {})) {
    if (!t?.id) continue
    let n = 0
    for (const img of (t?.digest?.images || [])) {
      if (!img?.thumbnail || seen.has(img.thumbnail)) continue
      seen.add(img.thumbnail)
      out.push({ url: img.thumbnail, label: img.label || t.digest?.name || t.label || '', id: img.id || '', template: img.template || '' })
      if (++n >= perTerm) break
    }
  }
  return out.slice(0, max)
}
