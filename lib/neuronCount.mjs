// Region neuron-count literature render (pure, offline-testable).
//
// vfb_get_region_neuron_count returns the VFB-annotated query counts AND, where
// available, published whole-region/whole-brain neuron estimates extracted from
// the literature (count_candidates: { count_numeric, scope, source_pmid,
// source_title }). The weak synthesiser tends to either drop the cited biological
// figure or restate the annotated count as the total. Surfacing the literature
// estimate deterministically — WITH its citation — lets the user see the
// biological number without the model fabricating or omitting it, and keeps the
// annotated count clearly separate.

import { bestRefUrl } from './literatureRefs.mjs'
import { sourceTitle } from './referenceSources.mjs'

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

/**
 * A markdown link with hover text, or the bare label when there is nothing to
 * link to. Written here rather than by the model, which is forbidden URLs.
 *
 * Every host reachable from this function — doi.org, pubmed, flybase, biorxiv,
 * medrxiv, virtualflybrain.org — is on the default outbound allow-list, so the
 * link survives sanitizeAssistantOutput rather than being rewritten to
 * "[External link removed]" after the reader has been promised a citation.
 */
function link(label, url, kind) {
  const text = str(label)
  const href = str(url)
  if (!text) return ''
  if (!href) return text
  return `[${text}](${href} "${sourceTitle({ kind, label: text, url: href })}")`
}

/**
 * Render the published neuron-count estimates as a short cited block, plus a note
 * distinguishing the VFB-annotated count. Returns '' when there is no literature
 * estimate to show.
 */
export function renderNeuronCountEstimate(out, regionLabel = '') {
  if (!out || typeof out !== 'object') return ''
  const candidates = Array.isArray(out.count_candidates) ? out.count_candidates : []
  const seen = new Set()
  const lines = []
  for (const c of candidates) {
    // Claims are either an exact count (count_numeric, from "NNNNN neurons") or a
    // floor (count_numeric_floor, from "more than N neurons" — e.g. the central
    // brain's "more than 125,000").
    const exact = num(c.count_numeric)
    const floor = num(c.count_numeric_floor)
    const n = exact != null ? exact : floor
    if (n == null) continue
    const isFloor = exact == null
    const key = `${n}|${isFloor}|${c.scope || ''}|${c.source_pmid || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const scope = c.scope ? ` (${c.scope})` : ''
    // The citation becomes a link. It was plain text, so a reader who wanted the
    // paper behind a figure had to copy a PMID into a search box — for the one
    // part of the answer that is explicitly someone else's claim rather than
    // VFB's data. DOI first, PubMed second: bestRefUrl already encodes that.
    const refUrl = bestRefUrl({ pmid: str(c.source_pmid), doi: str(c.source_doi) })
    const citeLabel = str(c.source_title)
      ? `${str(c.source_title)}${str(c.source_pmid) ? ` — PMID ${str(c.source_pmid)}` : ''}`
      : (str(c.source_pmid) ? `PMID ${str(c.source_pmid)}` : '')
    const cite = link(citeLabel, refUrl, 'publication')
    const prefix = isFloor ? 'more than ' : '~'
    lines.push(`- ${prefix}${n.toLocaleString('en-GB')} neurons${scope}${cite ? ` — ${cite}` : ''}`)
  }
  if (lines.length === 0) return ''
  const region = regionLabel || out.query?.resolved_region || 'this region'
  const annotated = (Array.isArray(out.vfb_query_summaries) ? out.vfb_query_summaries : [])
    .find(s => s && s.query_type === 'NeuronsPartHere')
  const annN = annotated ? num(annotated.count) : null
  const annotatedNote = annN != null
    ? `\n\n_VFB has annotated ${annN.toLocaleString('en-GB')} neuron types with some part in ${region} — a curated annotation count, not the biological total._`
    : ''

  const summary = out.evidence_summary || {}

  // The curator's note on this region, which until now reached the model as
  // evidence and reached the reader only if the model chose to repeat it. For
  // the central brain it is the difference between a number and a misreading:
  // FlyWire's 32,388 counts neurons FULLY CONTAINED in the central brain, so it
  // is a lower bound on "neurons in the central brain", not a census of them.
  // A caveat that qualifies a figure printed deterministically has to be printed
  // deterministically too, or the figure travels without it.
  const curatedNote = str(summary.curated_note)
  const noteLine = curatedNote ? `\n\n_${curatedNote}_` : ''

  // The reviewed article the framing is drawn from. This is the reference the
  // answer's opening claim — that there is no single number, and that a figure
  // means nothing without its specimen, release and scope — has always rested on
  // and never cited.
  const ref = link(str(summary.reference_title) || 'How many neurons are in the fly brain?',
    str(summary.reference), 'doc')
  const refLine = str(summary.reference) ? `\n\nReference: ${ref}` : ''

  return `**Published neuron-count estimates — ${region}** (from the literature):\n\n${lines.join('\n')}${noteLine}${annotatedNote}${refLine}`
}
