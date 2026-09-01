// Rank the biology, not the ontology.
//
// W7.C3 — "What are the main synaptic partners of Kenyon cells?" — shipped:
//
//   "The main synaptic partners of Kenyon cells include various types of neurons
//    such as interneurons, adult interneurons, dopaminergic neurons, and
//    mushroom body intrinsic neurons. Additionally, they include adult central
//    brain intrinsic neurons, peptidergic neurons, neurosecretory neurons, and
//    other Kenyon cells."
//
// Every one of those is a class that Kenyon cell is itself a member of, or an
// abstraction so broad it is true of almost any neuron. The answer is not wrong
// — a Kenyon cell really does synapse onto things that are interneurons — it is
// answering at the wrong GRANULARITY, which is the same failure as answering on
// the wrong axis, one level up.
//
// AND IT IS NOT A ROUTING BUG. This was my first hypothesis and it was wrong.
// DownstreamClassConnectivity and UpstreamClassConnectivity are typed as kind
// 'connectivity' in queryTypes.mjs, and QUERY_INTENT_RULES routes connectivity
// questions straight to them. The right query ran. Live, against
// /run_query?query_type=DownstreamClassConnectivity&id=FBbt_00003686:
//
//   neuron                              total_weight 2058877  pairwise 630396  avg 3.27
//   CNS neuron                                       2056495           628633       3.27
//   adult neuron                                     2021360           622375       3.25
//   interneuron                                      1979940           608249       3.26
//   …
//   mushroom body output neuron                       591432            83379       7.09
//
// The table is ranked by aggregate weight, and aggregate weight is an EXTENSIVE
// quantity: a superclass inherits every connection of every subclass, so the
// biggest number belongs to the biggest class, which is the root of the
// ontology. Ranking that table by weight ranks the ontology. The one row that
// is the textbook answer — mushroom body output neuron, the MBONs — sits at
// rank 37.
//
// Two things follow, and this module does both.
//
// FIRST, rank by an INTENSIVE quantity. avg_weight is total_weight divided by
// pairwise_connections: the mean number of synapses in a connected pair. It does
// not grow when a class gets bigger, so it cannot be gamed by generality. On the
// live table it puts mushroom body output neuron (7.09) first, ahead of every
// abstraction (neuron is 3.27) — which is the answer a fly neuroscientist would
// give. A floor on percent_connected keeps a two-member class with one enormous
// synapse from winning on a rounding artefact.
//
// SECOND, demote the abstractions explicitly, because an intensive ranking alone
// still lets broad structural groupings through (mushroom body extrinsic neuron,
// 4.40; input/output neuron, 4.34). Two mechanisms:
//
//   - LABEL. Classes whose name says they are a grouping — a bare "neuron" or
//     "interneuron" with region and stage qualifiers, a transmitter class, a
//     lineage, a region's intrinsic or extrinsic population. This is the same
//     rule the vfb_find_connectivity_partners tool has used in production since
//     3.5; it lived in app/api/chat/route.js and is shared from here now, so the
//     tool path and the harness path cannot drift apart.
//
//   - ARITHMETIC. An ontology chain betrays itself in the numbers. Kenyon cell,
//     adult central brain intrinsic neuron, adult MBp lineage neuron and adult
//     Kenyon cell report 408985 / 405125 / 405125 / 405124 pairwise connections
//     over 9132 / 8955 / 8955 / 8955 partners — four rows describing one set of
//     connections, because they are four names for very nearly the same
//     neurons. Rows whose figures agree to within a whisker are collapsed to the
//     most specific member, which is the one with the FEWEST connections: a
//     descendant's connections are always a subset of its ancestor's.
//
// No new outbound dependency. An owlery superclass closure was tried and
// rejected: it works, but its answer for Kenyon cell omits CNS neuron, adult
// neuron, adult interneuron, supraesophageal ganglion neuron and cholinergic
// neuron — five of the six rows this is meant to demote — so it would have added
// a host, a timeout and a failure mode in exchange for less coverage than a
// regex.
//
// WHAT THIS MODULE WILL NOT DO
//
// It will not silently drop the abstractions. They are true, they are what VFB
// actually ranked first, and an answer that quietly omits the top of the table
// is lying by selection. They are reported, after the specific partners, as
// what they are: the roll-up rows.

import { splitMarkdownCell } from './markdownLinks.mjs'

/** Lower-case, punctuation-flattened form used by every label rule here. */
export function normalizePartnerLabel(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// High-level neuron superclasses that every neuron rolls up into. Anchored, so
// a specific type like "mushroom body output neuron" is NOT caught.
export const GENERIC_NEURON_SUPERCLASS_RE = /^(adult |larval |embryonic |juvenile )?(cns |central nervous system |central brain |peripheral nervous system |nervous system |brain |supr?aesophageal ganglion |sub[o]?esophageal ganglion |gnathal ganglion )?(neuron|interneuron|cns neuron)$/

// Groupings named after where a neuron lives, where it came from, or what it
// secretes — never after what it does. Each is a bag of unlike neurons, so
// naming one as a partner tells the reader nothing they did not already know.
//
// "<region> output neuron" is deliberately absent. Mushroom body output neuron
// is the MBONs: a real, specific, well-studied cell class, and the correct
// answer to the question that produced this module. "input/output neuron" is
// listed literally because it is the union of both and names neither.
const STRUCTURAL_ROLLUP_RES = [
  /^input\s*\/?\s*output neuron$/,
  /^(adult |larval |embryonic |juvenile )?secondary neuron$/,
  /\bintrinsic neuron$/,
  /\bextrinsic neuron$/,
  /\b(hemi)?lineage neuron$/,
  /^neurosecretory (neuron|cell)( of .*)?$/,
  /^(adult |larval )?neurosecretory (neuron|cell)( of .*)?$/
]

const TRANSMITTER_CLASS_RE = /\b(adult|larval)?\s*(cholinergic|gabaergic|glutamatergic|dopaminergic|serotonergic|peptidergic|octopaminergic|tyraminergic|aminergic|monoaminergic)\s+neuron\b/

/**
 * True when a partner label names a level of the ontology rather than a kind of
 * neuron.
 *
 * @param {string|{label:string}} labelOrSummary raw label, or a row carrying one.
 * @param {string} [partnerFilter] the user's own words for what they wanted, if
 *   any. When they asked for dopaminergic partners, "dopaminergic neuron" is the
 *   abstraction they are trying to see INSIDE, so it is demoted rather than
 *   returned as the answer to their own question.
 */
export function isAggregateClassPartner(labelOrSummary, partnerFilter = '') {
  const raw = typeof labelOrSummary === 'string' ? labelOrSummary : (labelOrSummary?.label || '')
  const label = normalizePartnerLabel(raw)
  if (!label) return false

  if (GENERIC_NEURON_SUPERCLASS_RE.test(label)) return true
  if (STRUCTURAL_ROLLUP_RES.some(re => re.test(label))) return true

  const filter = normalizePartnerLabel(partnerFilter)
  if (filter.includes('dopaminergic') || /\bdans?\b/.test(filter)) {
    return label === 'adult dopaminergic neuron' ||
      label === 'dopaminergic neuron' ||
      label === 'mushroom body dopaminergic neuron'
  }

  return TRANSMITTER_CLASS_RE.test(label)
}

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse a DownstreamClassConnectivity / UpstreamClassConnectivity payload.
 *
 * Each row names both ends — `upstream_class` and `downstream_class`, both as
 * markdown links — and one of them is the class that was queried. The partner is
 * identified by its link target matching the row's own `id`, with `query_id` as
 * the fallback discriminator, because which column holds the partner depends on
 * which of the two query types ran and the payload does not say which that was.
 *
 * @returns {null|{direction:'downstream'|'upstream', queryId:string, queryLabel:string,
 *   total:number, totalIndividuals:number, rows:Array}}
 */
export function parseClassPartnerRows(parsed, { queryId: wantedId = '' } = {}) {
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : null
  if (!rows || !rows.length) return null

  const out = []
  let direction = ''
  let queryId = ''
  let queryLabel = ''
  let totalIndividuals = 0

  // The live table carries rows for the queried class AND for each of its
  // subclasses (query_id differs per row): UpstreamClassConnectivity on KCg-s
  // returns 1,170 rows for 332 partner classes, because every partner appears
  // once for KCg-s and once more for KCg-s1, KCg-s2… Read as one list, a partner
  // is counted up to five times and a subclass's figures are reported as the
  // parent's. Keep the rows about the class that was asked for; when the caller
  // cannot say which that is, the largest query_id group is the parent, since a
  // parent's partner set is a superset of each child's.
  const ownRows = selectQueriedRows(rows, wantedId)

  for (const r of ownRows) {
    if (!r || typeof r !== 'object') continue
    const down = splitMarkdownCell(r.downstream_class || '')
    const up = splitMarkdownCell(r.upstream_class || '')
    if (!down.text && !up.text) continue
    const rowId = String(r.id || '').trim()
    const qid = String(r.query_id || '').trim()

    let partner = null
    let self = null
    let dir = ''
    if (rowId && down.target === rowId) { partner = down; self = up; dir = 'downstream' } else if (rowId && up.target === rowId) { partner = up; self = down; dir = 'upstream' } else if (qid && up.target === qid) { partner = down; self = up; dir = 'downstream' } else if (qid && down.target === qid) { partner = up; self = down; dir = 'upstream' } else continue
    if (!partner.text) continue

    if (!direction) direction = dir
    if (!queryId) queryId = qid || self.target || ''
    if (!queryLabel) queryLabel = self.text || ''
    if (!totalIndividuals) totalIndividuals = num(r.total_n)

    out.push({
      id: partner.target || rowId,
      label: partner.text,
      totalWeight: num(r.total_weight),
      pairwise: num(r.pairwise_connections),
      connected: num(r.connected_n),
      percentConnected: num(r.percent_connected),
      avgWeight: num(r.avg_weight) || (num(r.pairwise_connections) ? num(r.total_weight) / num(r.pairwise_connections) : 0)
    })
  }

  if (!out.length) return null
  const rawTotal = Number(parsed?.count)
  return {
    direction: direction || 'downstream',
    queryId,
    queryLabel,
    totalIndividuals,
    total: Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : out.length,
    rows: out
  }
}

function selectQueriedRows(rows, wantedId = '') {
  const qidOf = r => String(r?.query_id || '').trim()
  const withQid = rows.filter(r => r && typeof r === 'object' && qidOf(r))
  if (!withQid.length) return rows
  const wanted = String(wantedId || '').trim()
  if (wanted) {
    const own = withQid.filter(r => qidOf(r) === wanted)
    if (own.length) return own
  }
  const counts = new Map()
  for (const r of withQid) counts.set(qidOf(r), (counts.get(qidOf(r)) || 0) + 1)
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return withQid.filter(r => qidOf(r) === top[0])
}

/**
 * Read the output of the vfb_find_connectivity_partners tool into the same
 * shape parseClassPartnerRows produces, so one ranker serves both routes. The
 * tool pre-ranks by total weight and truncates, so what reaches here is only
 * ever its top slice; the harness prefers the raw class table when the term
 * offers one, and uses this when the planner chose the tool on its own.
 */
export function parseConnectivityToolPartners(parsed) {
  const partners = Array.isArray(parsed?.top_partners) ? parsed.top_partners : null
  if (!partners || !partners.length || !parsed?.endpoint) return null
  const direction = String(parsed.query?.direction || parsed.direction || 'downstream').toLowerCase() === 'upstream' ? 'upstream' : 'downstream'
  const rows = []
  for (const p of partners) {
    const label = String(p?.label || '').trim()
    if (!label) continue
    const pairwise = num(p.pairwise_connections)
    rows.push({
      id: String(p.id || '').trim(),
      label,
      totalWeight: num(p.total_weight),
      pairwise,
      connected: num(p.connected_n),
      percentConnected: num(p.percent_connected),
      avgWeight: num(p.avg_weight) || (pairwise ? num(p.total_weight) / pairwise : 0)
    })
  }
  if (!rows.length) return null
  const total = num(parsed.partner_count) || num(parsed.endpoint?.total_rows) || rows.length
  return {
    direction,
    queryId: String(parsed.endpoint.id || '').trim(),
    queryLabel: String(parsed.endpoint.label || '').trim(),
    totalIndividuals: 0,
    total,
    rows
  }
}

/** True when a payload is the vfb_find_connectivity_partners tool's output. */
export function isConnectivityToolPayload(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && parsed.endpoint && Array.isArray(parsed.top_partners) && parsed.top_partners.length)
}

/** Two rows describe the same connections when their figures barely differ. */
const SAME_CONNECTIONS = 0.98

/**
 * Collapse rows that are the same set of connections under different names.
 *
 * Keeps the member with the FEWEST pairwise connections: a subclass's
 * connections are a subset of its superclass's, so within a near-identical group
 * the smallest figure is the most specific name for it. Ties go to the longest
 * label, on the same reasoning — "adult Kenyon cell" says more than "Kenyon
 * cell".
 *
 * Order is preserved: the survivor keeps the position of the highest-ranked
 * member it replaced, so this never reshuffles the table, it only thins it.
 */
export function collapseOntologyChains(rows = []) {
  const sorted = [...rows].map((r, i) => ({ r, i })).sort((a, b) => b.r.pairwise - a.r.pairwise)
  const groups = []
  for (const entry of sorted) {
    const g = groups.find(grp => {
      const head = grp[0].r
      if (!head.pairwise || !entry.r.pairwise) return false
      const pw = Math.min(head.pairwise, entry.r.pairwise) / Math.max(head.pairwise, entry.r.pairwise)
      if (pw < SAME_CONNECTIONS) return false
      if (!head.connected || !entry.r.connected) return pw >= SAME_CONNECTIONS
      const cn = Math.min(head.connected, entry.r.connected) / Math.max(head.connected, entry.r.connected)
      return cn >= SAME_CONNECTIONS
    })
    if (g) g.push(entry); else groups.push([entry])
  }
  const kept = groups.map(grp => {
    const best = grp.reduce((a, b) => {
      if (b.r.pairwise !== a.r.pairwise) return b.r.pairwise < a.r.pairwise ? b : a
      return String(b.r.label).length > String(a.r.label).length ? b : a
    })
    const position = Math.min(...grp.map(e => e.i))
    const alsoNamed = grp.filter(e => e !== best).map(e => e.r.label)
    return { i: position, r: alsoNamed.length ? { ...best.r, alsoNamed } : best.r }
  })
  return kept.sort((a, b) => a.i - b.i).map(e => e.r)
}

/** A class must reach this share of the query class's individuals to be ranked. */
const MIN_PERCENT_CONNECTED = 1

/**
 * Split a parsed class-connectivity table into specific partners, roll-up
 * classes and self-connections, ranking the specific ones by mean synaptic
 * weight per connected pair.
 *
 * @param {object} parsedTable output of parseClassPartnerRows
 * @param {{topN?:number, aggregateN?:number, partnerFilter?:string}} [opts]
 */
export function rankClassPartners(parsedTable, opts = {}) {
  if (!parsedTable?.rows?.length) return null
  const topN = Number.isFinite(opts.topN) ? opts.topN : 8
  const aggregateN = Number.isFinite(opts.aggregateN) ? opts.aggregateN : 3
  const partnerFilter = opts.partnerFilter || ''

  const selfLabel = normalizePartnerLabel(parsedTable.queryLabel)
  const isSelf = r => Boolean(selfLabel) && (
    normalizePartnerLabel(r.label) === selfLabel ||
    normalizePartnerLabel(r.label).endsWith(` ${selfLabel}`) ||
    (r.id && parsedTable.queryId && r.id === parsedTable.queryId)
  )

  const rows = collapseOntologyChains(parsedTable.rows)
  const selfRows = rows.filter(isSelf)
  const rest = rows.filter(r => !isSelf(r))
  const aggregate = rest.filter(r => isAggregateClassPartner(r, partnerFilter))
  const specific = rest.filter(r => !isAggregateClassPartner(r, partnerFilter))

  // Ranked by an intensive quantity, so generality cannot buy a place. The floor
  // is on reach, not on weight: a class two Kenyon cells happen to hit hard is
  // not a main partner of Kenyon cells.
  const byStrength = (a, b) => (b.avgWeight - a.avgWeight) || (b.totalWeight - a.totalWeight)
  const eligible = specific.filter(r => r.percentConnected >= MIN_PERCENT_CONNECTED || r.pairwise >= 3)
  const ranked = (eligible.length ? eligible : specific).sort(byStrength).slice(0, topN)

  return {
    direction: parsedTable.direction,
    queryLabel: parsedTable.queryLabel,
    total: parsedTable.total,
    totalIndividuals: parsedTable.totalIndividuals,
    partners: ranked,
    aggregates: aggregate.sort((a, b) => b.pairwise - a.pairwise).slice(0, aggregateN),
    self: selfRows.sort((a, b) => b.pairwise - a.pairwise).slice(0, 1),
    collapsed: parsedTable.rows.length - rows.length
  }
}

// Mean synapses per pair is the number the ranking turns on, and near the bottom
// of a table it separates partners by hundredths (1.96 / 1.90 / 1.89). Rounding
// those to one place prints three ties in an order the reader cannot check, so
// small figures keep two places and large ones — where the second place is
// noise — keep one.
const weight = n => (n < 10 ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10).toLocaleString('en-US')
const int = n => Math.round(n).toLocaleString('en-US')

function describe(r) {
  const bits = [`${weight(r.avgWeight)} synapses per connected pair`]
  if (r.percentConnected) bits.push(`${int(r.percentConnected)}% of individuals connected`)
  // Named, not dropped: these rows are why the table looked like an ontology,
  // and a reader who saw them in VFB's own listing needs to know where they went.
  const also = r.alsoNamed?.length
    ? ` [VFB lists the same connections under ${r.alsoNamed.slice(0, 3).join(', ')}]`
    : ''
  return `${r.label}${r.id ? ` (${r.id})` : ''} — ${bits.join(', ')}${also}`
}

/**
 * A deterministic claim for a class-connectivity table.
 *
 * Says what it ranked by and why, because the reader is entitled to know that
 * this is not the order VFB returned. The roll-up classes are named rather than
 * hidden: they are what the table actually ranks first, and an answer that drops
 * them without saying so is selecting its evidence.
 */
export function summariseClassPartners(parsed, { label = '', partnerFilter = '', topN = 8, queryId = '' } = {}) {
  const table = isConnectivityToolPayload(parsed)
    ? parseConnectivityToolPartners(parsed)
    : parseClassPartnerRows(parsed, { queryId })
  if (!table) return null
  if (label && !table.queryLabel) table.queryLabel = label
  const ranked = rankClassPartners(table, { topN, partnerFilter })
  if (!ranked || !ranked.partners.length) return null

  const subject = ranked.queryLabel || label || 'this class'
  const verb = ranked.direction === 'upstream' ? 'input to' : 'targets of'
  const parts = []

  parts.push(
    `VFB's class-level connectivity table for ${subject} lists ${int(ranked.total)} `
    + `${ranked.direction} classes, ranked by total synaptic weight — a total that grows with `
    + `class size, so its top rows are the broad classes ${subject} itself belongs to rather than `
    + `its partners`
  )
  parts.push(
    `Ranked instead by mean synaptic weight per connected pair, which does not grow with class `
    + `size, the strongest specific ${verb} ${subject} are: ${ranked.partners.map(describe).join('; ')}`
  )
  if (ranked.aggregates.length) {
    parts.push(
      `The roll-up classes VFB ranks above these — ${ranked.aggregates.map(r => r.label).join(', ')} — `
      + `are superclasses that aggregate their members' connections, not distinct partner types`
    )
  }
  if (ranked.self.length) {
    const s = ranked.self[0]
    parts.push(`${subject} also connects to itself (${s.label}, ${weight(s.avgWeight)} synapses per connected pair)`)
  }

  return {
    claim: `${parts.join('. ')}.`,
    direction: ranked.direction,
    queryId: table.queryId,
    queryLabel: subject,
    total: ranked.total,
    partners: ranked.partners,
    aggregates: ranked.aggregates,
    self: ranked.self,
    rows: ranked.partners.map(r => ({ name: r.label, id: r.id }))
  }
}

// --- display -----------------------------------------------------------------
//
// The reader needs the cell-type NAMES and the numbers the ranking turned on,
// side by side and sortable — a graph of fifteen overlapping labels showed
// neither (issue #50). The table is the primary display; the graph is the
// optional follow-up, and it draws only the ranked specific partners so its
// labels have room.

const VFB_REPORT = 'https://www.virtualflybrain.org/reports/'

export const PARTNER_TABLE_COLUMNS = [
  { key: 'avgWeight', label: 'Synapses per connected pair', align: 'right', hint: 'total synaptic weight ÷ connected pairs — the ranking column; it does not grow with class size' },
  { key: 'percentConnected', label: '% connected', align: 'right', hint: 'share of the presynaptic class\'s individuals that make the connection' },
  { key: 'pairwise', label: 'Connected pairs', align: 'right', hint: 'individual neuron pairs with at least one synapse' },
  { key: 'totalWeight', label: 'Total synapses', align: 'right', hint: 'summed synaptic weight across all pairs — grows with class size, so broad classes lead on it' }
]

const round2 = n => (n < 10 ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10)

function partnerTableRow(r, { rollup = false, self = false } = {}) {
  const tags = []
  if (rollup) tags.push('roll-up class')
  if (self) tags.push('self-connection')
  if (r.alsoNamed?.length) tags.push(`also listed as ${r.alsoNamed.slice(0, 3).join(', ')}`)
  return {
    name: r.label,
    id: r.id || '',
    reportUrl: r.id ? `${VFB_REPORT}${r.id}` : '',
    tags,
    cells: {
      avgWeight: round2(r.avgWeight),
      percentConnected: Math.round(r.percentConnected),
      pairwise: Math.round(r.pairwise),
      totalWeight: Math.round(r.totalWeight)
    }
  }
}

/**
 * A column table of the ranked partners, in the shape the client's result-table
 * widget renders (name + link + tags per row) plus `columns`/`cells` for the
 * numeric columns. Roll-up classes and the self-row are appended and tagged, so
 * nothing VFB ranked first is hidden — only ordered.
 */
export function partnerTable(summary, { queryUrl = '' } = {}) {
  if (!summary?.partners?.length) return null
  const subject = summary.queryLabel || 'this class'
  const rows = [
    ...summary.partners.map(r => partnerTableRow(r)),
    ...(summary.aggregates || []).map(r => partnerTableRow(r, { rollup: true })),
    ...(summary.self || []).map(r => partnerTableRow(r, { self: true }))
  ]
  return {
    kind: 'partners',
    title: `${summary.direction === 'upstream' ? 'Upstream' : 'Downstream'} partner classes of ${subject}`,
    subtitle: 'ranked by synapses per connected pair; click a column to re-sort',
    direction: summary.direction,
    termId: summary.queryId || '',
    termLabel: subject,
    count: summary.total,
    countKind: 'exact',
    countNoun: 'partner classes',
    sortKey: 'avgWeight',
    columns: PARTNER_TABLE_COLUMNS,
    queryUrl: queryUrl || '',
    rows
  }
}

/**
 * A graph of the ranked specific partners only — no roll-ups, no self-loop —
 * so every node is a cell type the reader asked about and its label has room.
 * Edge weight is the ranking quantity, so edge width and colour agree with the
 * table's order rather than with the ontology.
 */
export function partnerGraph(summary, { maxPartners = 8 } = {}) {
  if (!summary?.partners?.length) return null
  const epId = summary.queryId || summary.queryLabel
  if (!epId) return null
  const epLabel = summary.queryLabel || epId
  const upstream = summary.direction === 'upstream'
  const partners = summary.partners.slice(0, maxPartners).filter(r => r.id && r.id !== epId)
  if (!partners.length) return null
  const maxW = Math.max(1, ...partners.map(r => r.avgWeight || 0))
  const nodes = [
    { id: epId, label: epLabel, group: 'queried class', size: 2.4 },
    ...partners.map(r => ({
      id: r.id,
      label: r.label,
      group: upstream ? 'upstream partner' : 'downstream partner',
      size: Math.round((1 + 2 * ((r.avgWeight || 0) / maxW)) * 100) / 100
    }))
  ]
  const edges = partners.map(r => ({
    source: upstream ? r.id : epId,
    target: upstream ? epId : r.id,
    weight: round2(r.avgWeight || 0),
    label: `${round2(r.avgWeight || 0)} per pair`
  }))
  return {
    nodes,
    edges,
    directed: true,
    layout: 'radial',
    title: `${upstream ? 'Upstream' : 'Downstream'} partners of ${epLabel} (top ${partners.length} by synapses per connected pair)`
  }
}

/** True when a run_query payload is a class-level connectivity table. */
export function isClassConnectivityPayload(parsed) {
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : null
  if (!rows || !rows.length) return false
  return rows.some(r => r && typeof r === 'object' &&
    (r.downstream_class || r.upstream_class) &&
    (r.total_weight !== undefined || r.pairwise_connections !== undefined))
}
