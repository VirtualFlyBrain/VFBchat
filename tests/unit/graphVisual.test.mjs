import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GRAPH_PALETTE,
  GRAPH_EDGE_WEIGHT_BANDS,
  getEdgeWeightBand,
  shouldColorEdgesByWeight,
  shouldUseStructuralColoring,
  summariseEdgeWeights,
  formatGraphWeight,
  formatEdgeTooltip,
  formatNodeTooltip
} from '../../lib/graphVisual.mjs'

// ── palette ──────────────────────────────────────────────────────────

test('every palette colour is distinct, so two groups never share one', () => {
  assert.equal(new Set(GRAPH_PALETTE).size, GRAPH_PALETTE.length)
  for (const color of GRAPH_PALETTE) {
    assert.match(color, /^#[0-9a-f]{6}$/i)
  }
})

// ── edge weight bands ────────────────────────────────────────────────

test('the heaviest edge in a graph is always in the strongest band', () => {
  assert.equal(getEdgeWeightBand(500, 500).key, 'strong')
  assert.equal(getEdgeWeightBand(9, 9).key, 'strong')
})

test('bands are relative to the graph, not to an absolute synapse count', () => {
  // 40 synapses is the top of a small graph and the bottom of a large one.
  assert.equal(getEdgeWeightBand(40, 50).key, 'strong')
  assert.equal(getEdgeWeightBand(40, 500).key, 'weak')
})

test('band thresholds fall where the definitions say they do', () => {
  assert.equal(getEdgeWeightBand(71, 100).key, 'strong')
  assert.equal(getEdgeWeightBand(70, 100).key, 'medium')
  assert.equal(getEdgeWeightBand(41, 100).key, 'medium')
  assert.equal(getEdgeWeightBand(40, 100).key, 'weak')
  assert.equal(getEdgeWeightBand(1, 100).key, 'weak')
})

test('a missing or unparseable weight lands in the weakest band, never the strongest', () => {
  assert.equal(getEdgeWeightBand(undefined, 100).key, 'weak')
  assert.equal(getEdgeWeightBand(null, 100).key, 'weak')
  assert.equal(getEdgeWeightBand('not a number', 100).key, 'weak')
  assert.equal(getEdgeWeightBand(0, 100).key, 'weak')
})

test('a zero or missing maxWeight does not divide by zero into a strong band', () => {
  assert.equal(getEdgeWeightBand(0, 0).key, 'weak')
  assert.equal(getEdgeWeightBand(1, 0).key, 'strong')
})

test('the bands cover the whole 0..1 range with no gap', () => {
  for (let i = 0; i <= 100; i += 1) {
    assert.ok(getEdgeWeightBand(i, 100), `no band for ratio ${i / 100}`)
  }
})

// ── when weight colouring applies at all ─────────────────────────────

test('uniform weights are not coloured — every edge would read as "stronger"', () => {
  assert.equal(shouldColorEdgesByWeight([5, 5, 5]), false)
  assert.equal(shouldColorEdgesByWeight([1]), false)
  assert.equal(shouldColorEdgesByWeight([]), false)
})

test('unweighted edges normalise to the same weight and stay neutral', () => {
  assert.equal(shouldColorEdgesByWeight([undefined, null, 0]), false)
})

test('edges that genuinely differ in weight are coloured', () => {
  assert.equal(shouldColorEdgesByWeight([1, 146]), true)
  assert.equal(shouldColorEdgesByWeight([undefined, 12]), true)
})

// ── node colouring: provided groups vs connectivity role ─────────────

const directional = { nodeCount: 8, isDirected: true, hasDirectionalStructure: true }

test('no provided groups falls back to role colouring', () => {
  assert.equal(shouldUseStructuralColoring({
    ...directional, providedGroupCount: 0, largestProvidedGroup: 0
  }), true)
})

test('a single provided group falls back to role colouring', () => {
  // One group means one colour for everything, which says less than the roles do.
  assert.equal(shouldUseStructuralColoring({
    ...directional, providedGroupCount: 1, largestProvidedGroup: 8
  }), true)
})

test('a distinct group per node falls back to role colouring', () => {
  assert.equal(shouldUseStructuralColoring({
    ...directional, providedGroupCount: 8, largestProvidedGroup: 1
  }), true)
})

test('more groups than the palette holds falls back to role colouring', () => {
  assert.equal(shouldUseStructuralColoring({
    ...directional,
    nodeCount: 40,
    providedGroupCount: GRAPH_PALETTE.length + 1,
    largestProvidedGroup: 4
  }), true)
})

test('groups that actually cluster are kept, even when there are more than three', () => {
  // This is the behaviour change: the previous rule discarded any grouping with
  // more than three groups, which threw away most real connectivity groupings.
  for (const count of [2, 4, 6, 8, GRAPH_PALETTE.length]) {
    assert.equal(
      shouldUseStructuralColoring({
        ...directional, nodeCount: 40, providedGroupCount: count, largestProvidedGroup: 5
      }),
      false,
      `${count} clustering groups should have been kept`
    )
  }
})

test('an undirected graph never uses role colouring, whatever the groups', () => {
  assert.equal(shouldUseStructuralColoring({
    ...directional, isDirected: false, providedGroupCount: 0, largestProvidedGroup: 0
  }), false)
})

test('a graph with no source/target split never uses role colouring', () => {
  assert.equal(shouldUseStructuralColoring({
    ...directional, hasDirectionalStructure: false, providedGroupCount: 0, largestProvidedGroup: 0
  }), false)
})

test('a two-node graph never uses role colouring', () => {
  assert.equal(shouldUseStructuralColoring({
    ...directional, nodeCount: 2, providedGroupCount: 0, largestProvidedGroup: 0
  }), false)
})

test('called with no arguments it does not throw', () => {
  assert.equal(shouldUseStructuralColoring(), false)
})

// ── weight summary ───────────────────────────────────────────────────

test('the summary reports the real min, max, mean and median', () => {
  const stats = summariseEdgeWeights([
    { weight: 10 }, { weight: 20 }, { weight: 30 }, { weight: 100 }
  ])
  assert.equal(stats.edges, 4)
  assert.equal(stats.total, 160)
  assert.equal(stats.min, 10)
  assert.equal(stats.max, 100)
  assert.equal(stats.mean, 40)
  assert.equal(stats.median, 25)
})

test('the median of an odd-length set is the middle value, not an average', () => {
  const stats = summariseEdgeWeights([{ weight: 1 }, { weight: 2 }, { weight: 90 }])
  assert.equal(stats.median, 2)
})

test('the summary does not depend on the order the edges arrive in', () => {
  const ordered = summariseEdgeWeights([{ weight: 1 }, { weight: 5 }, { weight: 9 }])
  const shuffled = summariseEdgeWeights([{ weight: 9 }, { weight: 1 }, { weight: 5 }])
  assert.deepEqual(ordered, shuffled)
})

test('unweighted edges are excluded rather than counted as zero', () => {
  // Counting an unknown weight as 0 would drag the mean down and report a
  // minimum of 0 synapses, which is a connection that does not exist.
  const stats = summariseEdgeWeights([
    { weight: 10 }, { weight: 20 }, { weight: null }, { label: 'no weight' }
  ])
  assert.equal(stats.edges, 2)
  assert.equal(stats.min, 10)
  assert.equal(stats.mean, 15)
})

test('a graph with no weights at all summarises to nothing', () => {
  assert.equal(summariseEdgeWeights([{ label: 'a' }, { weight: 0 }]), null)
  assert.equal(summariseEdgeWeights([]), null)
  assert.equal(summariseEdgeWeights(), null)
  assert.equal(summariseEdgeWeights(null), null)
})

// ── formatting ───────────────────────────────────────────────────────

test('whole synapse counts are shown without a decimal point', () => {
  assert.equal(formatGraphWeight(146), '146')
  assert.equal(formatGraphWeight(0), '0')
})

test('a fractional mean or median is shown to one decimal place', () => {
  assert.equal(formatGraphWeight(15.5), '15.5')
  assert.equal(formatGraphWeight(1 / 3), '0.3')
})

test('a value that is not a number renders as a dash rather than NaN', () => {
  assert.equal(formatGraphWeight(NaN), '—')
  assert.equal(formatGraphWeight(Infinity), '—')
  assert.equal(formatGraphWeight(undefined), '—')
})

// ── band definitions stay usable by the legend ───────────────────────

test('every band has a label and a distinct colour for the legend', () => {
  const colors = GRAPH_EDGE_WEIGHT_BANDS.map(band => band.color)
  assert.equal(new Set(colors).size, colors.length)
  for (const band of GRAPH_EDGE_WEIGHT_BANDS) {
    assert.ok(band.label, `band ${band.key} has no label`)
    assert.match(band.color, /^#[0-9a-f]{6}$/i)
  }
})

test('bands are ordered strongest first, which is what the lookup relies on', () => {
  const thresholds = GRAPH_EDGE_WEIGHT_BANDS.map(band => band.threshold)
  assert.deepEqual(thresholds, thresholds.slice().sort((a, b) => b - a))
})

// ── hover text ───────────────────────────────────────────────────────

test('an edge tooltip names both ends and reads the weight as synapses', () => {
  assert.equal(
    formatEdgeTooltip({
      sourceLabel: 'DA1 lPN', targetLabel: 'Kenyon cell', label: '15', bandLabel: 'Weaker'
    }),
    'DA1 lPN → Kenyon cell\n15 synapses (weaker)'
  )
})

test('an undirected edge tooltip does not claim a direction', () => {
  const tip = formatEdgeTooltip({
    sourceLabel: 'A', targetLabel: 'B', label: '5', directed: false
  })
  assert.ok(!tip.includes('→'))
  assert.ok(tip.includes('A — B'))
})

test('a non-numeric edge label is passed through rather than called synapses', () => {
  // The label is whatever the model wrote; only a bare number is a synapse count.
  assert.equal(
    formatEdgeTooltip({ sourceLabel: 'A', targetLabel: 'B', label: 'innervates' }),
    'A → B\ninnervates'
  )
})

test('an edge with no band still gets a tooltip, without a strength claim', () => {
  const tip = formatEdgeTooltip({ sourceLabel: 'A', targetLabel: 'B', label: '5' })
  assert.equal(tip, 'A → B\n5 synapses')
})

test('an edge with no label falls back to naming its ends', () => {
  assert.equal(formatEdgeTooltip({ sourceLabel: 'A', targetLabel: 'B' }), 'A → B')
})

test('an edge tooltip with nothing to say is empty, not a stray arrow', () => {
  assert.equal(formatEdgeTooltip({}), '')
  assert.equal(formatEdgeTooltip(), '')
  assert.equal(formatEdgeTooltip({ sourceLabel: 'A', label: '' }), '')
})

test('a node tooltip carries the full label, which the drawn one may truncate', () => {
  assert.equal(
    formatNodeTooltip({ label: 'adult ellipsoid body extrinsic ring neuron ExR5', group: 'ellipsoid body' }),
    'adult ellipsoid body extrinsic ring neuron ExR5\nellipsoid body'
  )
})

test('a node tooltip does not repeat the label back as its own group', () => {
  assert.equal(formatNodeTooltip({ label: 'Kenyon cell', group: 'Kenyon cell' }), 'Kenyon cell')
  assert.equal(formatNodeTooltip({ label: 'Kenyon cell', group: 'kenyon CELL' }), 'Kenyon cell')
  assert.equal(formatNodeTooltip({ label: 'Kenyon cell' }), 'Kenyon cell')
})

test('a node tooltip handles missing pieces without printing undefined', () => {
  assert.equal(formatNodeTooltip({}), '')
  assert.equal(formatNodeTooltip(), '')
  assert.equal(formatNodeTooltip({ group: 'mushroom body' }), 'mushroom body')
})
