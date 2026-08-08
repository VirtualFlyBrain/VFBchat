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

import { querySemantics, queryTypeTag } from './queryTypes.mjs'
import { stripMarkdownLinks, splitMarkdownCell } from './markdownLinks.mjs'
import { termKind, parentClassesOf } from './termKind.mjs'

/** Does this object look like a single (flat) VFB get_term_info record? */
export function isTermInfo(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (Array.isArray(obj)) return false
  return Boolean(obj.Queries || obj.Meta || (obj.Id && (obj.SuperTypes || obj.Tags)))
}

function shortFormId(s = '') {
  const m = String(s).match(/(FBbt|VFB|FBgn|FBal|FBti|FBtp|FBco)_\w+/)
  return m ? m[0] : String(s)
}
function recordId(r) {
  if (!r || typeof r !== 'object') return ''
  return r.Id || r.id || (r.Meta?.Name && (r.Meta.Name.match(/\(([^)]+)\)/)?.[1])) || ''
}

/**
 * Unwrap a get_term_info payload to a single flat record. The multi-id-capable
 * VFB MCP returns a batch-keyed object ({ "<id>": {record} }) — or an array —
 * even for a single id, so a flat-only parser would miss it. Prefer the record
 * whose id matches the request.
 */
export function unwrapTermInfo(payload, preferredId = '') {
  if (!payload || typeof payload !== 'object') return null
  if (isTermInfo(payload)) return payload
  const want = shortFormId(preferredId)
  if (Array.isArray(payload)) {
    return payload.find(r => isTermInfo(r) && shortFormId(recordId(r)) === want) ||
           payload.find(isTermInfo) || null
  }
  if (preferredId && isTermInfo(payload[preferredId])) return payload[preferredId]
  for (const v of Object.values(payload)) {
    if (isTermInfo(v) && shortFormId(recordId(v)) === want) return v
  }
  for (const v of Object.values(payload)) if (isTermInfo(v)) return v
  return null
}

// A deprecated/obsolete VFB class may carry a pointer to its replacement. VFB's
// term-info API mostly omits obsolete classes entirely (get_term_info returns an
// error), but when a record IS returned and marked obsolete it can expose the
// successor via a `replaced_by`/`consider` field or an IAO_0100001 ("term
// replaced by") entry inside Meta.Relationships. Parse whichever is present so
// the harness can point the user at the current term rather than dead-ending.
const REPLACED_BY_REL_RE = /(?:term\s+replaced\s+by|replaced[_\s]by|IAO_0100001|\bconsider\b)[^[]*\[([^\]]+)\]\(([^)]+)\)/i

export function parseReplacedBy(info) {
  if (!info || typeof info !== 'object') return null
  const direct = info.replaced_by ?? info.replacedBy ?? info.Meta?.replaced_by ?? info.Meta?.replacedBy
  if (direct) {
    if (typeof direct === 'string') {
      const m = direct.match(/\[([^\]]+)\]\(([^)]+)\)/)
      if (m) return { label: m[1].trim(), id: m[2].trim() }
      const idm = direct.match(/(FBbt|VFB|FBgn|FBal|FBti|FBtp|FBco)_\w+/)
      if (idm) return { label: '', id: idm[0] }
    } else if (typeof direct === 'object') {
      const id = direct.id || direct.short_form || direct.Id || ''
      const label = direct.label || direct.Name || ''
      if (id) return { label: String(label).trim(), id: String(id).trim() }
    }
  }
  const rel = String(info.Meta?.Relationships || '')
  const m = rel.match(REPLACED_BY_REL_RE)
  if (m) return { label: m[1].trim(), id: m[2].trim() }
  return null
}

/** Does this term-info record describe a deprecated/obsolete entity? */
export function isDeprecatedRecord(info) {
  if (!info || typeof info !== 'object') return false
  const flags = [].concat(info.SuperTypes || [], info.Tags || []).map(x => String(x).toLowerCase())
  if (flags.includes('deprecated') || flags.includes('obsolete')) return true
  if (info.is_obsolete === true || info.deprecated === true || info.owl_deprecated === true) return true
  const prose = `${info.Meta?.Description || ''} ${info.Meta?.Comment || ''}`
  if (/\b(obsolete|deprecated)\b/i.test(prose)) return true
  // A replacement pointer is itself a strong deprecation signal.
  return Boolean(parseReplacedBy(info))
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
  const cell = splitMarkdownCell(String(row.label || row.name || ''))
  const label = cell.text
  const id = cell.target || row.id || ''
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

// Pull the entity id + template id out of a VFB thumbnail URL. Real URLs shard
// the path as /i/<e1>/<e2>/<TEMPLATE>/thumbnail.png, where the DEPICTED ENTITY is
// VFB_<e1><e2> (its 8-char id split into two 4-char directories) and the final
// segment is the TEMPLATE it is aligned to. Confirmed from the live term-info
// Images field, e.g. .../i/0010/29eo/VFB_00101567/thumbnail.png is entity
// VFB_001029eo (a neuron) on template VFB_00101567 (JRC2018U).
//
// The old callers assumed a 2-segment path and mis-read the template (or, on a
// failed match, the whole URL) as the entity id, producing broken
// reports/<png-url> links. Returns '' for id when the URL isn't a recognisable
// VFB thumbnail, so callers omit the link rather than linking to garbage.
export function parseThumbnailEntity(url = '') {
  const m = String(url).match(/\/i\/([^/]+)\/([^/]+)\/([^/]+)\/thumbnail(?:T)?\.png/i)
  if (!m) return { id: '', template: '' }
  return { id: `VFB_${m[1]}${m[2]}`, template: m[3] }
}

// VFBquery's counting cap. Beyond this it stops counting exactly and reports
// count -1 with preview_results.status 'complete', meaning "more than this",
// not "unknown" (VFBQUERY_COUNT_CAP, default 1000 — vfb_queries.py:38).
export const PREVIEW_COUNT_CAP = 1000

// VFBquery reports count -1 for three different situations and, before
// VFBquery 1.22.37, they were indistinguishable. preview_results.status tells
// them apart:
//
//   count -1 + status 'pending'   the query has not been run for this term yet
//                                 (or timed out). Not counted — NOT zero.
//   count -1 + status 'complete'  the rows are final; only the exact total was
//                                 too expensive, so there are more than
//                                 PREVIEW_COUNT_CAP matches.
//   count >= 0                    exact.
//   count -1 + no status          a cache entry written before 1.22.37. The key
//                                 is optional and always has been, so ABSENCE
//                                 MUST KEEP MEANING "complete" and we fall back
//                                 to the old count >= 0 rule. v3-cached holds
//                                 six-month slots, so this is still the common
//                                 case and will be for a while.
//
// This mirrors VFBquery's own preview_is_resolved() (solr_result_cache.py:159)
// deliberately — if the server-side rule changes, this is the one place to
// follow it.
export const PREVIEW_STATUS_PENDING = 'pending'
export const PREVIEW_STATUS_COMPLETE = 'complete'

/** True when a query's preview holds a final answer. */
export function previewIsResolved(query) {
  const pr = query?.preview_results
  const status = (pr && typeof pr === 'object') ? pr.status : undefined
  if (status === PREVIEW_STATUS_COMPLETE) return true
  if (status === PREVIEW_STATUS_PENDING) return false
  return Number(query?.count) >= 0
}

/**
 * Classify a query's count into the three cases callers actually need to
 * render differently:
 *   'exact'   — count is a real number, use it
 *   'many'    — resolved but uncounted: more than PREVIEW_COUNT_CAP
 *   'unknown' — pending: the query must be run to know anything
 */
export function classifyCount(count, resolved) {
  if (Number.isFinite(count) && count >= 0) return 'exact'
  return resolved ? 'many' : 'unknown'
}

/**
 * Human phrase for a count, for prose and chips alike, so "more than 1000"
 * never gets rendered as "-1" or flattened into "run this query".
 */
export function countPhrase(q) {
  if (q?.countKind === 'exact') return String(q.count)
  if (q?.countKind === 'many') return `more than ${PREVIEW_COUNT_CAP}`
  return 'not pre-counted'
}

// Parse a full table row -> { name, id, thumbnail, tags[], dataset, source,
// template } for result tables.
//
// The provenance columns used to be dropped here. That is one function upstream
// of every dataset question in the workshop set — "which connectomes have them",
// "which datasets do these come from", "list every individual with its dataset
// and VFB id" — and a column discarded during parsing cannot be recovered by any
// amount of care further down. They are kept RAW (markdown links intact) because
// a dataset cell is frequently a comma-separated LIST of links; see
// lib/datasetAxis.mjs for why flattening it here would be lossy.
export function parseTableRow(row) {
  if (!row || typeof row !== 'object') return null
  const ent = rowEntity(row)
  if (!ent) return null
  const tags = typeof row.tags === 'string' ? row.tags.split('|').map(t => t.trim()).filter(Boolean) : []
  const out = { name: ent.label, id: ent.id, thumbnail: parseThumbnailUrl(row.thumbnail || ''), tags }
  // Only when present, so a row without them keeps the exact shape it had.
  for (const k of ['dataset', 'source', 'template']) {
    const v = typeof row[k] === 'string' ? row[k].trim() : ''
    if (v) out[k] = v
  }
  return out
}

// How many registered images to keep in the digest. Enough to name the
// datasets/templates a neuron appears in without bloating the prompt.
export const IMAGE_LIMIT = 8

/**
 * Flatten VFB's template-keyed image map ({ "<templateId>": [ {id,label,
 * thumbnail,obj,swc,nrrd}, … ] }) into a flat list. Used for both the Images
 * field (an individual's own registrations) and the Examples field (a class's
 * example individuals).
 */
export function collectImageEntries(field) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return []
  const out = []
  for (const [template, entries] of Object.entries(field)) {
    for (const e of (Array.isArray(entries) ? entries : [])) {
      if (!e || typeof e !== 'object') continue
      const thumbnail = e.thumbnail || e.thumbnail_transparent || ''
      if (!e.id && !thumbnail) continue
      out.push({
        id: e.id || '',
        label: stripMarkdownLinks(e.label || ''),
        template,
        thumbnail,
        // 3D assets, when VFB has them — the honest answer to "can I see it?"
        formats: ['obj', 'swc', 'nrrd', 'wlz'].filter(k => e[k])
      })
      if (out.length >= IMAGE_LIMIT) return out
    }
  }
  return out
}

/** Build a structured digest from a term-info payload. */
export function buildTermInfoDigest(info = {}) {
  const meta = info.Meta || {}
  const id = info.Id || info.id || (meta.Name && (meta.Name.match(/\(([^)]+)\)/)?.[1])) || ''
  // Prefer the FULL canonical label in Meta.Name ("[adult lateral horn neuron](id)")
  // over info.Name, which is sometimes a short symbol (e.g. "MBON") — so the
  // displayed label always matches the resolved entity, not an abbreviation.
  const name = (meta.Name && stripMarkdownLinks(meta.Name)) || info.Name || ''
  const description = stripMarkdownLinks(meta.Description || '')
  // Where the data itself lives. VFB carries this on a DataSet as Meta.Link, and
  // it is the only machine-readable statement of it anywhere in the graph: the
  // FANC record links https://fanc.catmaid.virtualflybrain.org, FAFB/Zheng2018
  // links https://fafb.catmaid.virtualflybrain.org, and a dataset with no
  // browser of its own links its paper instead. The AllDatasets table — all 135
  // rows of it — carries no such column, so this was previously reachable only
  // from the website's hand-maintained table, and "How do I access the FANC
  // dataset in CATMAID?" had to be answered out of documentation retrieval or
  // not at all. Dropping it here was the last step of that gap.
  const link = stripMarkdownLinks(meta.Link || '')
  const relationships = stripMarkdownLinks(meta.Relationships || '')
  const synonyms = Array.isArray(info.Synonyms)
    ? info.Synonyms.map(s => (typeof s === 'string' ? s : s?.label)).filter(Boolean)
    : []

  // Registered images VFB actually holds for this term. An INDIVIDUAL carries
  // them under Images (its own registrations, keyed by template); a CLASS
  // carries example individuals under Examples (also keyed by template). Both
  // are direct evidence that VFB has a picture of the thing, and both were
  // previously dropped on the floor — so "show me what this neuron looks like"
  // was answered "VFB does not currently hold specific data on the appearance
  // of …" for a record that ships a thumbnail, an OBJ mesh and an SWC skeleton.
  const images = collectImageEntries(info.Images).concat(collectImageEntries(info.Examples)).slice(0, IMAGE_LIMIT)

  const queries = (Array.isArray(info.Queries) ? info.Queries : []).map(q => {
    const rows = q?.preview_results?.rows || []
    const parsed = rows.map(parseTableRow).filter(Boolean)
    const resolved = previewIsResolved(q)
    // A missing count used to fall back to rows.length, which is 0 for a
    // pending preview (rows is []) — and the filter below then dropped the
    // query as "counted empty", i.e. exactly the "no data" misreading the
    // comment there warns against. Fall back to -1 (unknown) instead, and only
    // trust rows.length when the preview is actually resolved.
    const rawCount = Number(q?.count)
    const count = Number.isFinite(rawCount)
      ? rawCount
      : (resolved ? rows.length : -1)
    return {
      query_type: q.query || q.query_type || '',
      label: q.label || '',
      count,
      // 'exact' | 'many' | 'unknown' — see classifyCount above. Downstream code
      // should branch on this rather than re-deriving the -1 semantics.
      countKind: classifyCount(count, resolved),
      // VFBquery's human-readable explanation of a -1, when it sends one.
      countMessage: (q?.preview_results && typeof q.preview_results === 'object'
        ? (q.preview_results.message || '') : ''),
      output_format: q.output_format || '',
      examples: rows.map(rowLabel).filter(Boolean).slice(0, 5),
      // example entities keep their VFB id so neuron names in the answer can be linked
      exampleEntities: rows.map(rowEntity).filter(e => e && e.id).slice(0, 5),
      // full parsed preview rows (name, id, thumbnail, tags) for result tables
      previewRows: parsed.slice(0, 5)
    }
  // Keep a query unless it was ACTUALLY counted as empty. count -1 means the
  // total is not known exactly — either the query has not been run yet
  // ('unknown') or it blew the counting cap ('many') — and in both cases the
  // data IS available. Only an exact count of 0 with no preview rows is
  // genuine absence.
  }).filter(q => q.label &&
    !(q.countKind === 'exact' && q.count === 0 && q.examples.length === 0))

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

  // kind and parents travel with the digest because every consumer downstream of
  // this point — coverage, sufficiency, the follow-on chips, the next turn's
  // context — sees only the digest. Dropping them here is why an INDIVIDUAL was
  // indistinguishable from the CLASS it is an example of, and why a type-level
  // question asked of a specific neuron had nowhere to go: `parents` is the
  // route from "this one reconstructed cell" to "this kind of cell".
  return {
    id,
    name,
    description,
    link,
    relationships,
    synonyms,
    images,
    queries,
    publications,
    kind: termKind(info),
    parents: parentClassesOf(info)
  }
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
  // VFB's own statement of where this record's data lives. On a DataSet this is
  // the browsable host — the FANC dataset carries fanc.catmaid.virtualflybrain.org,
  // FAFB/Zheng2018 carries fafb.catmaid.virtualflybrain.org — and on a dataset
  // with no browser of its own it is the paper instead. It is a real URL from the
  // graph, so it may be quoted verbatim; it is NOT a guarantee that this
  // particular link is a CATMAID instance, hence the neutral wording.
  if (digest.link) lines.push(`Where this record's data is hosted or published (VFB's own link for it, safe to quote): ${digest.link}`)
  if (digest.relationships) lines.push(`Relationships: ${digest.relationships}`)
  if (digest.synonyms?.length) lines.push(`Synonyms: ${digest.synonyms.join(', ')}`)
  if (digest.images?.length) {
    const shown = digest.images.slice(0, maxExamples)
    const formats = [...new Set(digest.images.flatMap(i => i.formats || []))]
    lines.push(`Registered images VFB holds for this term (${digest.images.length}${digest.images.length >= IMAGE_LIMIT ? '+' : ''} shown): ${
      shown.map(i => `${i.label || i.id}${i.id ? ` (${i.id})` : ''} aligned to ${i.template}`).join('; ')
    }.${formats.length ? ` Downloadable formats: ${formats.join(', ')}.` : ''} VFB DOES hold imagery for this term — answer "what does it look like" / "show me" from these, and NEVER as an absence. Thumbnail: ${shown[0]?.thumbnail || '(none)'}`)
  }
  if (digest.queries?.length) {
    lines.push('Available VFB data for this term. Each line ends with its query typing [query_type — kind; count = unit; use for …]. "individual images" ⇒ the count is a number of IMAGES; "ontology classes" ⇒ the count is a number of types/subparts/subclasses and any thumbnail is just ONE example — NEVER report a class count as an image count. Answer an "images" question only from an individual-image query. "run this query" = the total was not precomputed; call vfb_run_query with that query_type to get it. "more than N" = the results ARE known and there really are that many or more; report it as "more than N", never as unknown and never as an exact figure:')
    for (const q of digest.queries.slice(0, maxQueries)) {
      const ex = q.examples.slice(0, maxExamples).join(', ')
      const noun = querySemantics(q.query_type).countNoun
      const tag = queryTypeTag(q.query_type)
      if (q.countKind === 'many') {
        // Resolved, but the exact total blew VFBquery's counting cap. The rows
        // are real and the answer is "lots" — say so, rather than pretending
        // nothing is known.
        lines.push(`- ${q.label}: more than ${PREVIEW_COUNT_CAP} ${noun} (exact total not computed)${ex ? ` (e.g. ${ex})` : ''} [${tag}]`)
      } else if (q.countKind === 'unknown') {
        // Count not precomputed by get_term_info — the data is available; the
        // query must be run to get the count/results (do NOT read this as "no data").
        lines.push(`- ${q.label}: not pre-counted — run this query to get its count of ${noun} [${tag}]`)
      } else {
        lines.push(`- ${q.label}: ${q.count} ${noun}${ex ? ` (e.g. ${ex})` : ''} [${tag}]`)
      }
    }
  }
  if (digest.publications?.length) {
    const pubs = digest.publications.slice(0, 8)
      .map(p => p.label || p.pmid || p.doi || p.fbrf).filter(Boolean)
    if (pubs.length) lines.push(`Publications: ${pubs.join('; ')}`)
  }
  return lines.join('\n')
}

/** Convenience: digest a term-info payload straight to text (or '' if not term-info).
 *  Unwraps batch-keyed / array payloads first. */
export function termInfoToDigestText(info, opts) {
  const rec = unwrapTermInfo(info)
  if (!rec) return ''
  return digestToText(buildTermInfoDigest(rec), opts)
}
