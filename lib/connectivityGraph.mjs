// Deterministic connectivity → graph builder (pure, offline-testable).
//
// In the role-harness the synthesiser is a plain text stream, so it can never
// call the create_basic_graph tool the old loop relied on. Graphs must therefore
// be built deterministically from whatever a connectivity tool returned. This
// module recognises the canonical shapes the VFB connectivity tools emit and
// turns the strongest edges into a graph spec (the route layer then runs it
// through normalizeGraphSpec for sanitising / capping).
//
// Recognised shapes:
//   A. find_connectivity_partners: { endpoint:{id,label}, query:{direction}, top_partners:[{id,label,total_weight}] }
//   B. compare_downstream_targets: { per_source_top_targets:[{source_id,source_label,top_targets:[{id,label,total_weight}]}] }
//   C. raw query_connectivity:     { connections:[{upstream_class|source_label, downstream_class|target_label, total_weight|weight}] }

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// VFB class labels can be pipe-separated when a neuron belongs to several classes
// (e.g. "Kenyon cell|γ Kenyon cell") — take the first (primary) class for a clean
// node label rather than rendering the raw pipe string.
function cleanClassLabel(s = '') {
  const str = String(s).trim()
  const first = str.split('|')[0].trim()
  return first || str
}

function weightOf(row = {}) {
  return num(row.total_weight) ?? num(row.weight) ?? num(row.summed_total_weight) ??
         num(row.synapse_count) ?? num(row.synapses) ?? num(row.pairwise_connections)
}

/**
 * Build connectivity graph spec(s) from a parsed connectivity tool output.
 * Returns an array of raw specs ({ nodes, edges, directed, layout, title }) — the
 * caller normalises them. Empty array when there is no edge data.
 */
export function buildConnectivityGraphs(parsed, { maxEdges = 24 } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const edges = []
  let title = ''

  // A. endpoint + ranked partners (direction decides arrow orientation)
  const partners = Array.isArray(parsed.top_partners) ? parsed.top_partners
    : Array.isArray(parsed.aggregate_partners) ? parsed.aggregate_partners : null
  if (parsed.endpoint && partners && partners.length) {
    const epId = String(parsed.endpoint.id || parsed.endpoint.label || '').trim()
    const epLabel = String(parsed.endpoint.label || parsed.endpoint.id || '').trim()
    const direction = String(parsed.query?.direction || parsed.direction || 'downstream').toLowerCase()
    const downstream = direction !== 'upstream'
    if (epId) {
      title = `${downstream ? 'Downstream' : 'Upstream'} partners of ${epLabel || epId}`
      for (const p of partners) {
        const pid = String(p.id || p.label || '').trim()
        if (!pid) continue
        const pLabel = String(p.label || p.id || pid).trim()
        const w = weightOf(p)
        edges.push(downstream
          ? { source: epId, sLabel: epLabel || epId, target: pid, tLabel: pLabel, weight: w }
          : { source: pid, sLabel: pLabel, target: epId, tLabel: epLabel || epId, weight: w })
      }
    }
  }

  // B. per-source top targets (comparison tools)
  if (Array.isArray(parsed.per_source_top_targets)) {
    if (!title) title = 'Downstream targets by source class'
    for (const s of parsed.per_source_top_targets) {
      const sid = String(s.source_id || s.source_label || '').trim()
      if (!sid) continue
      const sLabel = String(s.source_label || s.source_id || sid).trim()
      for (const t of (Array.isArray(s.top_targets) ? s.top_targets : [])) {
        const tid = String(t.id || t.label || '').trim()
        if (!tid) continue
        edges.push({ source: sid, sLabel, target: tid, tLabel: String(t.label || t.id || tid).trim(), weight: weightOf(t) })
      }
    }
  }

  // C. raw connections rows
  if (Array.isArray(parsed.connections)) {
    if (!title) title = 'Class connectivity'
    for (const c of parsed.connections) {
      if (!c || typeof c !== 'object') continue
      const s = c.upstream_class ?? c.upstream_label ?? c.source_label ?? c.source_id ?? c.upstream
      const t = c.downstream_class ?? c.downstream_label ?? c.target_label ?? c.target_id ?? c.downstream
      if (!s || !t) continue
      edges.push({ source: String(s), sLabel: String(s), target: String(t), tLabel: String(t), weight: weightOf(c) })
    }
  }

  if (!edges.length) return []

  // Keep the strongest edges; size nodes by total incident weight.
  edges.sort((a, b) => (b.weight || 0) - (a.weight || 0))
  const top = edges.slice(0, maxEdges)
  const nodeMap = new Map()
  const touch = (id, label) => {
    if (!nodeMap.has(id)) nodeMap.set(id, { id, label: label || id, w: 0 })
    return nodeMap.get(id)
  }
  for (const e of top) {
    touch(e.source, cleanClassLabel(e.sLabel)).w += (e.weight || 1)
    touch(e.target, cleanClassLabel(e.tLabel)).w += (e.weight || 1)
  }
  const maxW = Math.max(1, ...[...nodeMap.values()].map(n => n.w))
  const nodes = [...nodeMap.values()].map(n => ({
    id: n.id, label: n.label, size: Math.round((1 + 3 * (n.w / maxW)) * 100) / 100
  }))
  const graphEdges = top.map(e => ({
    source: e.source, target: e.target,
    weight: Number.isFinite(e.weight) ? e.weight : null,
    label: Number.isFinite(e.weight) ? String(e.weight) : null
  }))
  return [{ nodes, edges: graphEdges, directed: true, layout: 'circle', title: title || 'Connectivity' }]
}
