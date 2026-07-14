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

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
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
    const cite = c.source_title
      ? `${c.source_title}${c.source_pmid ? ` — PMID ${c.source_pmid}` : ''}`
      : (c.source_pmid ? `PMID ${c.source_pmid}` : '')
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
  return `**Published neuron-count estimates — ${region}** (from the literature):\n\n${lines.join('\n')}${annotatedNote}`
}
