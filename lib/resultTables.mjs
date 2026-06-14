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
export function buildTables(ledger, question = '', { maxTables = 2 } = {}) {
  const listy = LIST_CUE.test(question)
  const toolsIntent = TOOLS_INTENT.test(question)
  const candidates = []
  for (const t of Object.values(ledger?.terms || {})) {
    if (!t || !t.id || !t.digest?.queries?.length) continue
    const termLabel = t.digest.name
    const termWords = new Set(words(termLabel))
    for (const q of t.digest.queries) {
      const rows = q.previewRows || []
      if (!rows.length) continue
      const family = queryFamily(q)
      // Tools/driver question: never surface neuron/image tables — the user wants
      // the labelling reagents, not the cells being labelled.
      if (toolsIntent && family === 'neuron') continue
      let score = relevance(question, q.label, termWords)
      // …and boost the expression/driver query so it wins even though "genetic
      // tools" shares no surface words with "expression patterns".
      if (toolsIntent && family === 'expression') score += 3
      // include only queries the user is plausibly asking about
      if (score <= 0 && !(listy && q.output_format === 'table')) continue
      candidates.push({
        score,
        title: q.label,
        queryType: q.query_type,
        termId: t.id,
        termLabel,
        count: q.count,
        queryUrl: vfbQueryUrl(t.id, q.query_type),
        rows: rows.map(r => ({
          name: r.name, id: r.id, reportUrl: vfbReportUrl(r.id), thumbnail: r.thumbnail, tags: r.tags
        }))
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.count - a.count)
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
