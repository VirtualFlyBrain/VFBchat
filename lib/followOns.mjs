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

  const resolved = Object.entries(ledger?.terms || {}).filter(([, t]) => t && t.id)
  for (const [name, t] of resolved) {
    const label = t.label || t.digest?.name || name
    terms.push({ name, id: t.id, label })
    const url = vfbReportUrl(t.id)
    if (url) sources.push({ label, url, id: t.id })

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
