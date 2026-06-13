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
const LIST_CUE = /\b(which|what|list|show|all|every|driver|drivers|gal4|line|lines|stock|stocks|neuron|neurons|partner|partners|input|inputs|output|outputs|image|images|subtype|subtypes|subclass|subclasses|part|parts|express|expression|clone|clones|type|types)\b/i

const STOP = new Set(['what', 'which', 'with', 'this', 'that', 'have', 'does', 'the', 'and', 'for', 'are', 'has', 'from', 'into', 'some', 'all', 'list', 'show', 'in', 'of', 'to', 'a'])

function words(s = '') {
  return String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) || []
}

/** Keyword overlap between the question and a query label. */
function relevance(question, label) {
  const q = new Set(words(question))
  let n = 0
  for (const w of words(label)) if (q.has(w)) n++
  return n
}

/**
 * Build up to `maxTables` result tables for the resolved terms whose query
 * results best match the question. Each table:
 *   { title, queryType, termId, termLabel, count, queryUrl,
 *     rows: [{ name, id, reportUrl, thumbnail, tags }] }
 */
export function buildTables(ledger, question = '', { maxTables = 2 } = {}) {
  const listy = LIST_CUE.test(question)
  const candidates = []
  for (const t of Object.values(ledger?.terms || {})) {
    if (!t || !t.id || !t.digest?.queries?.length) continue
    const termLabel = t.digest.name
    for (const q of t.digest.queries) {
      const rows = q.previewRows || []
      if (!rows.length) continue
      const score = relevance(question, q.label)
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

/** Every unique row thumbnail across the resolved terms' query previews. */
export function galleryThumbnails(ledger, { max = 24 } = {}) {
  const seen = new Set()
  const urls = []
  for (const t of Object.values(ledger?.terms || {})) {
    for (const q of (t?.digest?.queries || [])) {
      for (const r of (q.previewRows || [])) {
        if (r.thumbnail && !seen.has(r.thumbnail)) { seen.add(r.thumbnail); urls.push(r.thumbnail) }
      }
    }
  }
  return urls.slice(0, max)
}
