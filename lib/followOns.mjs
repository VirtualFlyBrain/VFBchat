// Follow-on suggestions + provenance (pure, offline-testable).
//
// After a term-anchored answer we offer the user two clearly-distinct actions:
//   - ASK chips: run a new chat query (deterministically derived from the term's
//     real VFB data — its term-info Queries catalogue — so we never invent a
//     follow-on the data can't answer).
//   - OPEN-IN-VFB chips / Sources: links to the VFB term report (the "term info
//     page or query containing the data") — this is the clickable provenance
//     that replaces the bare "(vfb)" tags.
//
// Generation is deterministic from `ledger.terms[*].digest`; nothing here depends
// on the weak model. See outputs/reports/vfbchat-live-eval-and-followons-2026-06-13.md.

const VFB_REPORT = 'https://www.virtualflybrain.org/reports/'

/** VFB term report URL for an FBbt_/VFB_ id. */
export function vfbReportUrl(id) {
  return id ? `${VFB_REPORT}${encodeURIComponent(id)}` : ''
}

/** VFB v2 browser URL that RUNS a query for a term, e.g. ?q=FBbt_00003748,NeuronsSynaptic */
export function vfbQueryUrl(id, queryType) {
  if (!id || !queryType) return ''
  return `https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=${encodeURIComponent(id)},${encodeURIComponent(queryType)}`
}

// Markdown link titles are wrapped in double quotes, so a title must not contain
// raw double quotes — that breaks [text](url "ti"tle") parsing. Swap them out.
function titleSafe(s = '') {
  return String(s).replace(/"/g, "'").trim()
}

/** Strip "[label](target)" markdown to "label" so chip text is plain. */
export function stripMarkdown(s = '') {
  return String(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

const VFB_ID_RE = /^(FBbt|VFB|FBgn|FBal|FBti|FBtp|FBco)/

// query_type -> natural follow-on question template ({term} is substituted).
// Only types that map to a sensible standalone question are listed; image/list
// types are surfaced as open-in-VFB instead.
const ASK_TEMPLATES = {
  NeuronsPresynapticHere: 'What neurons provide input to {term}?',
  NeuronsPostsynapticHere: 'What neurons receive output in {term}?',
  NeuronsPartHere: 'What neuron types are part of {term}?',
  NeuronsSynaptic: 'What neurons have synaptic terminals in {term}?',
  SubclassesOf: 'What are the subtypes of {term}?',
  PartsOf: 'What are the anatomical parts of {term}?',
  ExpressionOverlapsHere: 'What GAL4 / expression patterns label {term}?',
  TransgeneExpressionHere: 'What driver lines label {term}?',
  DownstreamClassConnectivity: 'What does {term} connect to downstream?',
  UpstreamClassConnectivity: 'What connects to {term} upstream?',
  NeuronInputsTo: 'What are the strongest inputs to {term}?'
}

/**
 * Build follow-on suggestions + sources from the ledger's resolved terms.
 * @returns {{ terms:Array, chips:Array, sources:Array }}
 *   chip = { kind:'ask'|'vfb', label, query?, url?, title }
 *   source = { label, url, id }
 */
export function buildFollowOns(ledger, { maxChips = 6 } = {}) {
  const terms = []
  const chips = []
  const sources = []
  const seenChip = new Set()
  const seenSource = new Set()

  // id -> authoritative VFB label (registry canonical entries; never a model name).
  const idLabel = {}
  for (const e of Object.values(ledger?.registry || {})) {
    if (e.canonical && e.id && !idLabel[e.id]) idLabel[e.id] = e.label
  }

  // Dedup resolved terms by id (the same entity can be reached under two names).
  const resolved = []
  const seenId = new Set()
  for (const [name, t] of Object.entries(ledger?.terms || {})) {
    if (!t || !t.id || seenId.has(t.id)) continue
    seenId.add(t.id)
    resolved.push([name, t])
  }
  for (const [name, t] of resolved) {
    // Authoritative label for the id (term-info Name / registry), NEVER the
    // planner/model term name — that mislabelled a MBON id as "mushroom body".
    const label = stripMarkdown(t.digest?.name || idLabel[t.id] || name)
    // `name` is the planner/search term; `label` is the authoritative display
    // name; digestName/registryLabel exposed for diagnostics.
    terms.push({ name, id: t.id, label, digestName: t.digest?.name || null, registryLabel: idLabel[t.id] || null, fetchedId: t.fetchedId || null })
    const url = vfbReportUrl(t.id)
    if (url && !seenSource.has(t.id)) { seenSource.add(t.id); sources.push({ label, url, id: t.id }) }

    // open-in-VFB chip per resolved term
    const vfbKey = `vfb:${t.id}`
    if (url && !seenChip.has(vfbKey)) {
      seenChip.add(vfbKey)
      chips.push({ kind: 'vfb', label: `Open ${label} in VFB`, url, title: `Open ${label} in Virtual Fly Brain (new tab)` })
    }

    // ask chips from the term's real available-data queries (highest count first)
    const queries = (t.digest?.queries || []).filter(q => q.count > 0 && ASK_TEMPLATES[q.query_type])
    queries.sort((a, b) => b.count - a.count)
    for (const q of queries) {
      const query = ASK_TEMPLATES[q.query_type].replace('{term}', label)
      const key = `ask:${query.toLowerCase()}`
      if (seenChip.has(key)) continue
      seenChip.add(key)
      chips.push({ kind: 'ask', label: `${query} (${q.count})`, query, title: `Ask VFB: ${query}` })
    }
  }

  // Trim ask chips but always keep at least one open-in-VFB per term where possible.
  const askChips = chips.filter(c => c.kind === 'ask').slice(0, maxChips)
  const vfbChips = chips.filter(c => c.kind === 'vfb').slice(0, 3)
  return { terms, chips: [...askChips, ...vfbChips], sources }
}

/**
 * Build a name -> {id, url} map of every VFB entity we can link in the answer:
 * the resolved terms plus the example neurons surfaced in each term's digest
 * queries (which carry their own ids). Longest names first so "ML-VPN2" wins
 * over "VPN" when linkifying.
 */
export function buildTermLinks(ledger) {
  const byKey = new Map()
  const add = (label, id, canonical) => {
    const name = stripMarkdown(label)
    if (!name || !id || !VFB_ID_RE.test(id)) return
    const key = name.toLowerCase()
    const existing = byKey.get(key)
    if (!existing || (canonical && !existing.canonical)) {
      byKey.set(key, { name, id, url: vfbReportUrl(id), canonical: Boolean(canonical) })
    }
  }
  // 1. authoritative registry (VFB's own labels -> ids)
  for (const e of Object.values(ledger?.registry || {})) add(e.label, e.id, e.canonical)
  // 2. resolved terms by their VFB term-info Name (canonical) + query-row entities.
  //    NEVER the planner/model-supplied term name — that is what pinned a label to
  //    the wrong id (e.g. "mushroom body" -> mushroom body output neuron).
  for (const t of Object.values(ledger?.terms || {})) {
    if (t?.id && t.digest?.name) add(t.digest.name, t.id, true)
    for (const q of (t?.digest?.queries || [])) {
      for (const e of (q.exampleEntities || [])) add(e.label, e.id, false)
    }
  }
  return [...byKey.values()].sort((a, b) => b.name.length - a.name.length)
}

const MD_LINK_OR_CODE = /(\[[^\]]*\]\([^)]*\)|`[^`]*`|https?:\/\/\S+)/g

/**
 * Linkify known VFB term names in answer prose to their report pages, with a
 * hover tooltip and nothing else. Only plain text is touched — existing markdown
 * links, code spans and URLs are left alone — and each term is linked once.
 */
export function linkifyKnownTerms(text, termLinks) {
  if (!text || !Array.isArray(termLinks) || !termLinks.length) return text || ''
  const linked = new Set()
  // Split out spans we must not touch, transform only the plain pieces.
  const parts = String(text).split(MD_LINK_OR_CODE)
  return parts.map((part, i) => {
    // odd indices are the captured (protected) spans
    if (i % 2 === 1) return part
    let out = part
    for (const t of termLinks) {
      if (linked.has(t.name.toLowerCase())) continue
      const re = new RegExp(`(?<![\\w-])(${escapeRe(t.name)})(?![\\w-])`)
      if (re.test(out)) {
        out = out.replace(re, `[$1](${t.url} "${titleSafe('Open ' + t.name + ' in Virtual Fly Brain')}")`)
        linked.add(t.name.toLowerCase())
      }
    }
    return out
  }).join('')
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Map each term-info query count -> {label, url, title} so figures quoted in the
 * answer ("226,524 images of neurons with some part in the medulla") can be
 * turned into links that open that query's data in VFB. Larger counts first so a
 * value that is a prefix of another isn't matched early.
 */
export function buildCountLinks(ledger) {
  const byCount = new Map()
  for (const [, t] of Object.entries(ledger?.terms || {})) {
    if (!t || !t.id || !t.digest?.queries?.length) continue
    for (const q of t.digest.queries) {
      if (!q.count || q.count < 1 || !q.query_type) continue
      if (!byCount.has(q.count)) {
        byCount.set(q.count, {
          count: q.count,
          url: vfbQueryUrl(t.id, q.query_type),   // RUNS the query in VFB
          title: titleSafe(`Run in VFB: ${q.label}`),
          label: q.label
        })
      }
    }
  }
  return [...byCount.values()].sort((a, b) => b.count - a.count)
}

/**
 * Linkify count figures in answer prose to the VFB query they came from. Matches
 * number tokens (with or without thousands commas) against known query counts;
 * each count is linked once; existing links/code are left untouched.
 */
export function linkifyCounts(text, countLinks) {
  if (!text || !Array.isArray(countLinks) || !countLinks.length) return text || ''
  const byCount = new Map(countLinks.map(c => [c.count, c]))
  const used = new Set()
  const parts = String(text).split(MD_LINK_OR_CODE)
  return parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part.replace(/\b\d[\d,]*\b/g, (m) => {
      const v = Number(m.replace(/,/g, ''))
      const link = byCount.get(v)
      if (!link || used.has(v)) return m
      used.add(v)
      return `[${m}](${link.url} "${link.title}")`
    })
  }).join('')
}
