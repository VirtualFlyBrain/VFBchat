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
