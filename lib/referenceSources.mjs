// Non-term provenance: the documentation pages and publications an answer was
// built on, in the shape the Sources line already renders.
//
// WHY THIS EXISTS.
//
// The synthesiser is forbidden to write URLs — "do NOT write ontology ids
// (FBbt_/VFB_), URLs, or markdown links — entity names and figures are turned
// into links automatically afterwards". That rule is right: a model that writes
// its own links invents them. But the automatic linking it promises only ever
// covered VFB TERM reports and query counts, so anything that was not an
// ontology term could not be referenced at all.
//
// The visible symptom was a neuron-count answer whose first sentence — there is
// no single figure, it depends on the boundaries, the specimen and the method —
// is drawn straight from VFB's own reviewed article on neuron counts, and cited
// nothing. The tool payload carried the URL under `evidence_summary.reference`
// and the answer_hint told the model to "point them at Virtual Fly Brain's
// reference on neuron counts"; the model was simultaneously told never to write
// a URL. The two instructions cancelled, every time.
//
// So the reference is emitted from here instead, deterministically, exactly as
// the term sources are. The model is never asked to produce a link.
//
// WHAT IS AND IS NOT A SOURCE. Only material the answer actually drew on: a
// documentation page that was fetched and extracted from, a publication whose
// figure or claim is quoted in the answer. A term's full Publications list is
// NOT included — twenty references a reader was never shown are provenance for
// nothing, and would bury the two that matter.

import { bestRefUrl } from './literatureRefs.mjs'

/** Trim and collapse whitespace; '' for anything that is not a usable string. */
function text(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Compare URLs the way a reader would: the same page reached with and without a
 * trailing slash, or over http and https, is one source and must not be listed
 * twice. Falls back to the raw string for anything unparseable.
 */
export function sourceKey(url = '') {
  const raw = text(url)
  if (!raw) return ''
  try {
    const u = new URL(raw)
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${u.search}`
  } catch { return raw.toLowerCase() }
}

/** A publication's display label: its citation, else whichever identifier it has. */
function publicationLabel(ref) {
  const citation = text(ref?.citation) || text(ref?.title)
  if (citation) return citation
  if (text(ref?.pmid)) return `PMID ${text(ref.pmid)}`
  if (text(ref?.doi)) return `DOI ${text(ref.doi)}`
  if (text(ref?.fbrf)) return `FlyBase ${text(ref.fbrf)}`
  return ''
}

/**
 * Where a publication link lands, for the hover text. The reader is about to
 * leave the site, so say where to.
 */
function publicationHost(url = '') {
  try {
    const h = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    if (h === 'doi.org') return 'via DOI'
    if (h === 'pubmed.ncbi.nlm.nih.gov') return 'on PubMed'
    if (h === 'flybase.org') return 'on FlyBase'
    if (h.endsWith('biorxiv.org')) return 'on bioRxiv'
    if (h.endsWith('medrxiv.org')) return 'on medRxiv'
    return `on ${h}`
  } catch { return '' }
}

/**
 * Publication sources from the ledger's literature evidence rows.
 *
 * These rows are written only when the extractor read the article and found it
 * answered something, so every one of them is a reference the answer stands on.
 */
export function publicationSourcesFromEvidence(ledger) {
  const out = []
  for (const e of (ledger?.evidence || [])) {
    if (e?.source !== 'literature') continue
    const ref = { pmid: text(e.pmid), doi: text(e.doi), fbrf: text(e.fbrf), citation: text(e.citation) }
    const url = bestRefUrl(ref)
    const label = publicationLabel(ref)
    if (!url || !label) continue
    out.push({ kind: 'publication', label, url })
  }
  return out
}

/**
 * Documentation and publication sources carried by a region-neuron-count tool
 * result: the reviewed article the framing comes from, and the primary paper
 * behind every figure the deterministic block prints.
 *
 * Reads the payload rather than the config so a count estimate that arrived
 * with no curated entry contributes nothing, which is the honest answer.
 */
export function referenceSourcesFromCountEstimate(out) {
  if (!out || typeof out !== 'object') return []
  const sources = []
  const summary = out.evidence_summary || {}
  const article = text(summary.reference)
  if (article) {
    sources.push({
      kind: 'doc',
      label: text(summary.reference_title) || 'How many neurons are in the fly brain?',
      url: article
    })
  }
  for (const c of (Array.isArray(out.count_candidates) ? out.count_candidates : [])) {
    const ref = { pmid: text(c?.source_pmid), doi: text(c?.source_doi), citation: text(c?.source_title) }
    const url = bestRefUrl(ref)
    const label = publicationLabel(ref)
    if (!url || !label) continue
    sources.push({ kind: 'publication', label, url })
  }
  return sources
}

/**
 * Hover text for a source link. Kept here so the prose block and the Sources
 * line describe the same link the same way.
 */
export function sourceTitle(source) {
  const label = text(source?.label) || 'this source'
  if (source?.kind === 'vfb') return `Open ${label} term info in Virtual Fly Brain (new tab)`
  if (source?.kind === 'doc') return `Open “${label}” — Virtual Fly Brain documentation (new tab)`
  if (source?.kind === 'publication') {
    const where = publicationHost(source.url)
    return `Open ${label}${where ? ` ${where}` : ''} (new tab)`
  }
  return `Open ${label} (new tab)`
}

/**
 * Every non-term source for a turn, deduped and capped, in reading order:
 * documentation first (it frames the answer), then publications (they carry the
 * figures).
 *
 * `seen` lets the caller pass the keys of sources it has already emitted — the
 * VFB term reports — so a page that is already listed is not repeated.
 */
export function buildReferenceSources(ledger, countEstimates = [], { max = 8, seen = new Set() } = {}) {
  const collected = [
    ...(Array.isArray(countEstimates) ? countEstimates : []).flatMap(referenceSourcesFromCountEstimate),
    ...publicationSourcesFromEvidence(ledger)
  ]
  const out = []
  const keys = new Set(seen)
  for (const kind of ['doc', 'publication']) {
    for (const s of collected) {
      if (s.kind !== kind) continue
      const key = sourceKey(s.url)
      if (!key || keys.has(key)) continue
      keys.add(key)
      out.push({ ...s, id: null, title: sourceTitle(s) })
      if (out.length >= max) return out
    }
  }
  return out
}
