// Tests for the deterministic connectivity → graph builder.
// Run: node --test tests/unit/connectivityGraph.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConnectivityGraphs } from '../../lib/connectivityGraph.mjs'

test('builds a directed graph from endpoint + ranked partners (downstream)', () => {
  const out = {
    endpoint: { id: 'FBbt_00003748', label: 'medulla' },
    query: { direction: 'downstream' },
    top_partners: [
      { id: 'FBbt_1', label: 'Mi1', total_weight: 500 },
      { id: 'FBbt_2', label: 'Tm1', total_weight: 300 }
    ]
  }
  const [g] = buildConnectivityGraphs(out)
  assert.ok(g)
  assert.match(g.title, /Downstream partners of medulla/)
  assert.equal(g.directed, true)
  // edges go from endpoint -> partner
  assert.deepEqual(g.edges.map(e => [e.source, e.target]), [['FBbt_00003748', 'FBbt_1'], ['FBbt_00003748', 'FBbt_2']])
  assert.equal(g.edges[0].weight, 500)
  // endpoint node present and is the largest (highest incident weight)
  const labels = g.nodes.map(n => n.label)
  assert.ok(labels.includes('medulla') && labels.includes('Mi1') && labels.includes('Tm1'))
})

test('upstream direction reverses the arrows', () => {
  const out = {
    endpoint: { id: 'E', label: 'endpoint' }, query: { direction: 'upstream' },
    top_partners: [{ id: 'P', label: 'partner', total_weight: 10 }]
  }
  const [g] = buildConnectivityGraphs(out)
  assert.deepEqual(g.edges.map(e => [e.source, e.target]), [['P', 'E']])
})

test('builds from per_source_top_targets (comparison shape)', () => {
  const out = {
    per_source_top_targets: [
      { source_id: 'A', source_label: 'KCab', top_targets: [{ id: 'M1', label: 'MBON01', total_weight: 80 }] },
      { source_id: 'B', source_label: 'KCg', top_targets: [{ id: 'M1', label: 'MBON01', total_weight: 60 }] }
    ]
  }
  const [g] = buildConnectivityGraphs(out)
  assert.equal(g.edges.length, 2)
  // MBON01 is a shared target -> highest incident weight -> largest node
  const mbon = g.nodes.find(n => n.label === 'MBON01')
  const kcab = g.nodes.find(n => n.label === 'KCab')
  assert.ok(mbon.size >= kcab.size)
})

test('builds from raw connections rows', () => {
  const out = { connections: [
    { upstream_class: 'Mi1', downstream_class: 'T4', total_weight: 200 },
    { upstream_class: 'Mi1', downstream_class: 'Tm3', weight: 150 }
  ] }
  const [g] = buildConnectivityGraphs(out)
  assert.equal(g.edges.length, 2)
  assert.deepEqual(g.edges[0], { source: 'Mi1', target: 'T4', weight: 200, label: '200' })
})

test('no edge data -> no graph', () => {
  assert.deepEqual(buildConnectivityGraphs({ warnings: [], connections: [] }), [])
  assert.deepEqual(buildConnectivityGraphs({ Queries: [] }), [])
  assert.deepEqual(buildConnectivityGraphs(null), [])
  assert.deepEqual(buildConnectivityGraphs('not an object'), [])
})

test('caps to the strongest edges', () => {
  const connections = Array.from({ length: 40 }, (_, i) => ({ upstream_class: 'src', downstream_class: `t${i}`, total_weight: i }))
  const [g] = buildConnectivityGraphs({ connections }, { maxEdges: 24 })
  assert.equal(g.edges.length, 24)
  // strongest kept (t39 weight 39), weakest dropped (t0)
  assert.ok(g.edges.some(e => e.target === 't39'))
  assert.ok(!g.edges.some(e => e.target === 't0'))
})

// --- D. region connectivity summary (vfb_summarize_region_connections) --------
//
// VFB has no region-level connectivity query at all: medulla's term info offers
// NeuronsPresynapticHere / NeuronsPostsynapticHere and friends, and nothing like
// the DownstreamClassConnectivity a neuron CLASS exposes. The region-centred
// preview graph is therefore the only honest graph for "connectivity of the
// medulla in graph form" (task-battery G1). Rows below are real medulla rows.

const MEDULLA_REGION_SUMMARY = {
  query: { region: 'medulla', resolved_region: 'medulla', limit: 8 },
  focus_region: { id: 'FBbt_00003748', name: 'medulla' },
  focus_query_summaries: [
    { query_type: 'TractsNervesInnervatingHere', count: -1, count_status: 'unknown', preview_rows: [] },
    {
      query_type: 'NeuronsPresynapticHere',
      count: 262,
      count_status: 'exact',
      preview_rows: [
        { id: 'FBbt_00110069', label: 'Dm8b' },
        { id: 'FBbt_20001883', label: 'PS128' },
        { id: 'FBbt_00110070', label: 'Mi10b' }
      ]
    },
    {
      query_type: 'NeuronsPostsynapticHere',
      count: 240,
      count_status: 'exact',
      preview_rows: [
        { id: 'FBbt_00003774', label: 'Dm7' },
        { id: 'FBbt_00052643', label: 'TmY-ds' }
      ]
    }
  ]
}

test('builds a region-centred graph from a region connectivity summary', () => {
  const [g] = buildConnectivityGraphs(MEDULLA_REGION_SUMMARY)
  assert.ok(g, 'expected a graph')
  assert.equal(g.directed, true)
  assert.equal(g.layout, 'radial')
  assert.match(g.title, /medulla/i)

  // one central region node, sized above the neurons
  const region = g.nodes.find(n => n.id === 'FBbt_00003748')
  assert.ok(region)
  assert.equal(region.group, 'queried region')
  assert.ok(g.nodes.every(n => n.id === region.id || n.size < region.size))
  assert.equal(g.nodes.length, 6)

  // presynaptic neurons point INTO the region, postsynaptic ones are pointed AT
  assert.equal(g.edges.length, 5)
  assert.ok(g.edges.filter(e => e.target === 'FBbt_00003748').length === 3)
  assert.ok(g.edges.filter(e => e.source === 'FBbt_00003748').length === 2)
  const pre = g.edges.find(e => e.source === 'FBbt_00110069')
  assert.equal(pre.target, 'FBbt_00003748')
  assert.equal(pre.label, 'presynaptic sites in medulla')
  const post = g.edges.find(e => e.target === 'FBbt_00003774')
  assert.equal(post.source, 'FBbt_00003748')
  assert.equal(post.label, 'postsynaptic sites in medulla')

  // no weight column in these rows, so no weight on the edges: a literal 0 would
  // read as "no synapses" rather than "not counted"
  assert.ok(g.edges.every(e => e.weight === undefined))
})

test('a neuron on both sides of a region is grouped as both', () => {
  const both = {
    focus_region: { id: 'FBbt_00003748', name: 'medulla' },
    focus_query_summaries: [
      { query_type: 'NeuronsPresynapticHere', preview_rows: [{ id: 'FBbt_00003774', label: 'Dm7' }] },
      { query_type: 'NeuronsPostsynapticHere', preview_rows: [{ id: 'FBbt_00003774', label: 'Dm7' }] }
    ]
  }
  const [g] = buildConnectivityGraphs(both)
  assert.equal(g.nodes.length, 2)
  assert.equal(g.nodes.find(n => n.id === 'FBbt_00003774').group, 'presynaptic and postsynaptic neuron')
  assert.equal(g.edges.length, 2)
})

test('region summary is detected by the tool field too', () => {
  const payload = { tool: 'vfb_summarize_region_connections', ...MEDULLA_REGION_SUMMARY }
  assert.equal(buildConnectivityGraphs(payload).length, 1)
})

test('region summary with unpopulated previews yields no graph', () => {
  // Every preview empty is exactly what an unwarmed region looks like; drawing a
  // lone region node with no edges would assert an absence VFB has not established.
  const empty = {
    focus_region: { id: 'FBbt_00003748', name: 'medulla' },
    focus_query_summaries: [
      { query_type: 'NeuronsPresynapticHere', count: -1, count_status: 'unknown', preview_rows: [] },
      { query_type: 'NeuronsPostsynapticHere', count: -1, count_status: 'unknown', preview_rows: [] }
    ]
  }
  assert.deepEqual(buildConnectivityGraphs(empty), [])
})

test('region summary falls back to a slug id when focus_region has none', () => {
  const noId = {
    focus_region: { name: 'mushroom body' },
    focus_query_summaries: [
      { query_type: 'NeuronsPresynapticHere', preview_rows: [{ id: 'FBbt_00100247', label: 'KCab' }] }
    ]
  }
  const [g] = buildConnectivityGraphs(noId)
  assert.equal(g.edges[0].target, 'region:mushroom-body')
  assert.equal(g.nodes.find(n => n.id === 'region:mushroom-body').label, 'mushroom body')
})

test('an error payload from the region tool is not a graph', () => {
  assert.deepEqual(buildConnectivityGraphs({
    error: 'Could not resolve "nowhere" to a VFB anatomy region.',
    tool: 'vfb_summarize_region_connections',
    recoverable: true
  }), [])
})
