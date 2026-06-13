// Term-info digest (pure, offline-testable).
//
// A VFB get_term_info payload is large (~25 KB) and buries the answer to most
// region / connectivity / genetic / taxonomy questions inside its `Queries`
// array — each query carries a human label, a total `count`, and up to ~5
// `preview_results.rows`. The bounded extractor on a weak model struggles to
// find these in raw JSON, so the harness dead-ended on questions VFB can answer.
//
// This module distils the payload into a compact, high-signal summary:
//   - Description + Relationships + Synonyms (the prose answer to "what is X")
//   - Available VFB data: each query as "label: count (example, example, …)"
//     — this is what answers "inputs to X", "parts of X", "subclasses of X",
//       "expression/GAL4 in X", etc., deterministically.
//   - Publications.
// The same `queries` list later drives the follow-on suggestion chips.
//
// See outputs/reports/vfbchat-live-eval-and-followons-2026-06-13.md.

/** Does this object look like a VFB get_term_info payload? */
export function isTermInfo(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (Array.isArray(obj)) return false
  return Boolean(obj.Queries || obj.Meta || (obj.Id && (obj.SuperTypes || obj.Tags)))
}

function stripMarkdownLinks(s = '') {
  // "[label](ID)" -> "label"; leave plain text untouched.
  return String(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

function rowLabel(row) {
  if (!row || typeof row !== 'object') return ''
  const raw = row.label || row.name || row.id || ''
  return stripMarkdownLinks(String(raw)).trim()
}

// Parse a preview row into { label, id }. Labels arrive as "[label](ID)"; the id
// is also exposed separately (row.id) — prefer the markdown id so the label and
// its VFB id stay paired for inline linking.
function rowEntity(row) {
  if (!row || typeof row !== 'object') return null
  const raw = String(row.label || row.name || '')
  const m = raw.match(/\[([^\]]+)\]\(([^)]+)\)/)
  const label = m ? m[1].trim() : stripMarkdownLinks(raw).trim()
  const id = (m && m[2]) || row.id || ''
  if (!label) return null
  return { label, id: String(id).trim() }
}

// VFB thumbnail field is markdown "[![alt](URL 'title')](template,id)" — pull the
// PNG URL. Real URLs are http(s) with a sharded path, e.g.
// http://www.virtualflybrain.org/data/VFB/i/jrmc/20bn/VFB_00101567/thumbnail.png
export function parseThumbnailUrl(s = '') {
  const m = String(s).match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+thumbnail[^)\s]*\.png)/i)
  // Force https — VFB returns http URLs which Chrome blocks as mixed content on
  // the https chat page.
  return m ? m[1].replace(/^http:/i, 'https:') : ''
}

// Parse a full table row -> { name, id, thumbnail, tags[] } for result tables.
export function parseTableRow(row) {
  if (!row || typeof row !== 'object') return null
  const ent = rowEntity(row)
  if (!ent) return null
  const tags = typeof row.tags === 'string' ? row.tags.split('|').map(t => t.trim()).filter(Boolean) : []
  return { name: ent.label, id: ent.id, thumbnail: parseThumbnailUrl(row.thumbnail || ''), tags }
}

/** Build a structured digest from a term-info payload. */
export function buildTermInfoDigest(info = {}) {
  const meta = info.Meta || {}
  const id = info.Id || info.id || (meta.Name && (meta.Name.match(/\(([^)]+)\)/)?.[1])) || ''
  const name = info.Name || (meta.Name && stripMarkdownLinks(meta.Name)) || ''
  const description = stripMarkdownLinks(meta.Description || '')
  const relationships = stripMarkdownLinks(meta.Relationships || '')
  const synonyms = Array.isArray(info.Synonyms)
    ? info.Synonyms.map(s => (typeof s === 'string' ? s : s?.label)).filter(Boolean)
    : []

  const queries = (Array.isArray(info.Queries) ? info.Queries : []).map(q => {
    const rows = q?.preview_results?.rows || []
    const parsed = rows.map(parseTableRow).filter(Boolean)
    return {
      query_type: q.query || q.query_type || '',
      label: q.label || '',
      count: typeof q.count === 'number' ? q.count : (rows.length || 0),
      output_format: q.output_format || '',
      examples: rows.map(rowLabel).filter(Boolean).slice(0, 5),
      // example entities keep their VFB id so neuron names in the answer can be linked
      exampleEntities: rows.map(rowEntity).filter(e => e && e.id).slice(0, 5),
      // full parsed preview rows (name, id, thumbnail, tags) for result tables
      previewRows: parsed.slice(0, 5)
    }
  }).filter(q => q.label && (q.count > 0 || q.examples.length > 0))

  const publications = (Array.isArray(info.Publications) ? info.Publications : [])
    .map(p => {
      const core = p?.core || {}
      return {
        label: stripMarkdownLinks(core.label || p.label || ''),
        pmid: p.PubMed || '',
        doi: p.DOI || '',
        fbrf: p.FlyBase || core.short_form || ''
      }
    })
    .filter(p => p.label || p.pmid || p.doi || p.fbrf)

  return { id, name, description, relationships, synonyms, queries, publications }
}

/**
 * Render the digest as compact, question-relevant text for the extractor /
 * synthesiser. Keeps it small (a few KB) and high-signal so a weak model can
 * actually find the answer. `maxQueries`/`maxExamples` bound the size.
 */
export function digestToText(digest, { maxQueries = 16, maxExamples = 5 } = {}) {
  if (!digest) return ''
  const lines = []
  const header = digest.name ? `${digest.name}${digest.id ? ` (${digest.id})` : ''}` : (digest.id || '')
  if (header) lines.push(header)
  if (digest.description) lines.push(`Description: ${digest.description}`)
  if (digest.relationships) lines.push(`Relationships: ${digest.relationships}`)
  if (digest.synonyms?.length) lines.push(`Synonyms: ${digest.synonyms.join(', ')}`)
  if (digest.queries?.length) {
    lines.push('Available VFB data for this term (query result: total count — examples):')
    for (const q of digest.queries.slice(0, maxQueries)) {
      const ex = q.examples.slice(0, maxExamples).join(', ')
      lines.push(`- ${q.label}: ${q.count}${ex ? ` (e.g. ${ex})` : ''}`)
    }
  }
  if (digest.publications?.length) {
    const pubs = digest.publications.slice(0, 8)
      .map(p => p.label || p.pmid || p.doi || p.fbrf).filter(Boolean)
    if (pubs.length) lines.push(`Publications: ${pubs.join('; ')}`)
  }
  return lines.join('\n')
}

/** Convenience: digest a term-info payload straight to text (or '' if not term-info). */
export function termInfoToDigestText(info, opts) {
  if (!isTermInfo(info)) return ''
  return digestToText(buildTermInfoDigest(info), opts)
}
