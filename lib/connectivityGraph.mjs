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
//   D. vfb_summarize_region_connections: { focus_region:{id,name}, focus_query_summaries:[{query_type, preview_rows}] }
//
// Shape D exists because VFB has NO region-level connectivity query at all — a
// brain region's term info advertises NeuronsPresynapticHere / NeuronsPostsynapticHere
// and friends, but nothing like the class-summarised connectivity a neuron class
// exposes. So the only honest graph for "connectivity of <region> in graph form"
// is a region-centred preview built from those per-query rows. The legacy
// tool-calling loop built this in route.js (buildRegionConnectivityPreviewGraph);
// it lives here too so the role harness, whose synthesiser cannot call tools,
// gets the same graph.

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

function isRegionSummaryPayload(parsed = {}) {
  if (parsed.tool === 'vfb_summarize_region_connections') return true
  return Boolean(parsed.focus_region) && Array.isArray(parsed.focus_query_summaries)
}

function regionSummaryRows(parsed = {}, queryType = '') {
  const summaries = Array.isArray(parsed.focus_query_summaries) ? parsed.focus_query_summaries : []
  const summary = summaries.find(entry => entry?.query_type === queryType)
  return Array.isArray(summary?.preview_rows) ? summary.preview_rows : []
}

function regionRowNode(row = {}, group = '') {
  const id = String(row?.id || row?.short_form || row?.label || row?.name || '').trim()
  if (!id) return null
  const label = cleanClassLabel(row?.label || row?.name || row?.symbol || id) || id
  return { id, label, group, size: 1.15 }
}

// D. region connectivity preview — one central region node, presynaptic neurons
// pointing in, postsynaptic neurons pointed at.
function buildRegionSummaryGraph(parsed = {}, { maxPerSide = 6 } = {}) {
  const focus = parsed.focus_region || {}
  const regionName = cleanClassLabel(focus.name || focus.label || parsed.query?.resolved_region || parsed.query?.region || '')
  const regionId = String(focus.id || '').trim() ||
    (regionName ? `region:${regionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : '')
  if (!regionId) return []

  const presynaptic = regionSummaryRows(parsed, 'NeuronsPresynapticHere').slice(0, maxPerSide)
  const postsynaptic = regionSummaryRows(parsed, 'NeuronsPostsynapticHere').slice(0, maxPerSide)
  if (!presynaptic.length && !postsynaptic.length) return []

  const label = regionName || regionId
  const nodesById = new Map([[regionId, { id: regionId, label, group: 'queried region', size: 2.4 }]])
  const edges = []

  // No weight on these edges: these rows carry no synapse counts, and an explicit
  // zero would read as "no synapses" rather than "not counted".
  for (const row of presynaptic) {
    const node = regionRowNode(row, 'presynaptic neuron')
    if (!node || node.id === regionId) continue
    if (!nodesById.has(node.id)) nodesById.set(node.id, node)
    edges.push({ source: node.id, target: regionId, label: `presynaptic sites in ${label}` })
  }
  for (const row of postsynaptic) {
    const node = regionRowNode(row, 'postsynaptic neuron')
    if (!node || node.id === regionId) continue
    const existing = nodesById.get(node.id)
    // Plenty of neuron classes have both pre- and postsynaptic terminals in the same
    // region; grouping such a node as purely presynaptic would misdescribe it.
    if (existing) existing.group = 'presynaptic and postsynaptic neuron'
    else nodesById.set(node.id, node)
    edges.push({ source: regionId, target: node.id, label: `postsynaptic sites in ${label}` })
  }
  if (!edges.length) return []

  return [{
    nodes: [...nodesById.values()],
    edges,
    directed: true,
    layout: 'radial',
    title: `${label} region connectivity preview`
  }]
}

/**
 * Build connectivity graph spec(s) from a parsed connectivity tool output.
 * Returns an array of raw specs ({ nodes, edges, directed, layout, title }) — the
 * caller normalises them. Empty array when there is no edge data.
 */
export function buildConnectivityGraphs(parsed, { maxEdges = 24 } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  if (isRegionSummaryPayload(parsed)) return buildRegionSummaryGraph(parsed)
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
        // Roll-up superclasses (neuron, adult neuron, …) are context rows, not
        // partners; drawn, they crowd out the cell types the reader asked for.
        if (p.aggregate_class === true) continue
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
