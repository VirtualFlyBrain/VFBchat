// Pure presentation helpers for the connectivity graph in app/page.js.
//
// They live here rather than in the component so they can be unit tested: the
// decisions they encode (which nodes share a colour, whether an edge counts as
// a strong connection) are the ones most likely to be got subtly wrong, and
// they are the ones a reader of a rendered graph will believe.

export const GRAPH_PALETTE = [
  '#4a9eff', '#4ade80', '#f59e0b', '#f472b6', '#22d3ee', '#a78bfa',
  '#f87171', '#34d399', '#e879f9', '#fb923c', '#67e8f9', '#fde047'
]

export const GRAPH_ROLE_STYLES = {
  source: { label: 'Source side', color: '#4a9eff' },
  target: { label: 'Target side', color: '#4ade80' },
  bridge: { label: 'Intermediate', color: '#f59e0b' },
  isolated: { label: 'Other', color: '#94a3b8' }
}

// Neutral edge colour, used whenever the weights carry no information to show.
export const GRAPH_EDGE_NEUTRAL = '#4b5563'

// Structural (containment) edges — the SUBCLASSOF relation from a rolled-up
// class-connectivity graph. Muted + dashed so they read as hierarchy, distinct
// from the weighted synapsed_to connectivity edges.
export const GRAPH_SUBCLASS_COLOR = '#9aa4b2'
export const GRAPH_SUBCLASS_WIDTH = 1.5
export const GRAPH_SUBCLASS_DASH = '6 4'

// Relative-weight bands, ordered strongest first. Only applied when the edges
// actually differ in weight — see shouldColorEdgesByWeight.
export const GRAPH_EDGE_WEIGHT_BANDS = [
  { key: 'strong', label: 'Stronger', threshold: 0.7, color: '#f87171' },
  { key: 'medium', label: 'Moderate', threshold: 0.4, color: '#fbbf24' },
  { key: 'weak', label: 'Weaker', threshold: 0, color: '#60a5fa' }
]

/**
 * Which weight band an edge falls into, as a fraction of the heaviest edge in
 * the same graph. Bands are relative, not absolute: 40 synapses is "stronger"
 * in a graph that tops out at 50 and "weaker" in one that tops out at 500.
 */
export function getEdgeWeightBand(weight, maxWeight) {
  const ratio = Math.min(1, (Number(weight) || 0) / Math.max(1, Number(maxWeight) || 1))
  return GRAPH_EDGE_WEIGHT_BANDS.find(band => ratio > band.threshold)
    || GRAPH_EDGE_WEIGHT_BANDS[GRAPH_EDGE_WEIGHT_BANDS.length - 1]
}

/**
 * Whether weight colouring says anything. On a graph where every edge is the
 * same weight — or carries no weight at all, which normalises to 1 — a
 * ratio-based band would paint the whole graph "stronger", which reads as a
 * claim about the data that the data does not make.
 */
export function shouldColorEdgesByWeight(weights = []) {
  const normalized = weights.map(weight => Number(weight) || 1)
  return new Set(normalized).size > 1
}

/**
 * Decide whether to colour nodes by connectivity role rather than by the group
 * the model supplied.
 *
 * In the directional layout, position already says which side a node is on
 * (source column left, target column right), so spending colour on the same
 * fact is redundant. Provided groups are therefore preferred whenever they
 * actually cluster: at least two of them, no more than the palette holds, and
 * at least one group with more than one member. Everything outside that — no
 * groups, one group, a group per node, or more groups than distinct colours —
 * falls back to role colouring, which stays readable at any size.
 */
export function shouldUseStructuralColoring({
  providedGroupCount = 0,
  largestProvidedGroup = 0,
  nodeCount = 0,
  isDirected = true,
  hasDirectionalStructure = false,
  paletteSize = GRAPH_PALETTE.length
} = {}) {
  const hasUsableProvidedGroups = providedGroupCount >= 2
    && providedGroupCount <= paletteSize
    && largestProvidedGroup >= 2
  return !hasUsableProvidedGroups
    && Boolean(isDirected)
    && nodeCount >= 3
    && Boolean(hasDirectionalStructure)
}

/**
 * min/max/mean/median over the edge weights, for the summary strip under the
 * legend. Zero and non-numeric weights are excluded rather than counted as 0,
 * because an unweighted edge is an unknown weight, not a weight of nothing.
 * Returns null when there is nothing to summarise.
 */
export function summariseEdgeWeights(edges = []) {
  const weights = (Array.isArray(edges) ? edges : [])
    .map(edge => Number(edge?.weight))
    .filter(weight => Number.isFinite(weight) && weight > 0)
  if (weights.length === 0) return null
  const sorted = weights.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return {
    edges: weights.length,
    total,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: total / weights.length,
    median: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }
}

/**
 * Synapse weights are whole numbers; the mean and median are the only values
 * in the summary that can be fractional, and one decimal place is enough.
 */
export function formatGraphWeight(value) {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Hover text for an edge. The drawn weight label is 9px and sits at the
 * midpoint, so on a dense graph it can land under a node or under another
 * edge's label; the tooltip states the same fact somewhere it cannot collide.
 *
 * A weight label that is purely numeric is read as a synapse count, which is
 * what the connectivity queries return. Anything else — a relation name, a
 * qualifier — is passed through as the model wrote it rather than guessing at
 * units it may not have.
 */
export function formatEdgeTooltip({
  sourceLabel = '',
  targetLabel = '',
  label = '',
  bandLabel = '',
  directed = true
} = {}) {
  const ends = sourceLabel && targetLabel
    ? `${sourceLabel} ${directed ? '→' : '—'} ${targetLabel}`
    : ''
  const text = String(label ?? '').trim()
  const detail = /^\d+(\.\d+)?$/.test(text) ? `${text} synapses` : text
  const withBand = detail && bandLabel ? `${detail} (${String(bandLabel).toLowerCase()})` : detail
  return [ends, withBand].filter(Boolean).join('\n')
}

/**
 * Hover text for a node. Long labels are wrapped and then truncated with an
 * ellipsis in the drawn graph, so without this the full name of a node is
 * simply unavailable. The group is only worth repeating when it says something
 * the label does not.
 */
export function formatNodeTooltip({ label = '', group = '' } = {}) {
  const name = String(label ?? '').trim()
  const groupName = String(group ?? '').trim()
  if (!groupName || groupName.toLowerCase() === name.toLowerCase()) return name
  return name ? `${name}\n${groupName}` : groupName
}
