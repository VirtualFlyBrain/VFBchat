// Rank the biology, not the ontology.
//
// The fixture is the live DownstreamClassConnectivity table for Kenyon cell
// (FBbt_00003686), recorded from
//   /run_query?query_type=DownstreamClassConnectivity&id=FBbt_00003686&limit=60
// which reports count 10073. Labels and all five numeric columns are the real
// values. Only the FBbt ids are stand-ins (except neuron and Kenyon cell, which
// are real) — nothing asserted here depends on an id being the true one.
//
// Run: node --test tests/unit/classPartners.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePartnerLabel,
  isAggregateClassPartner,
  parseClassPartnerRows,
  collapseOntologyChains,
  rankClassPartners,
  summariseClassPartners,
  isClassConnectivityPayload
} from '../../lib/classPartners.mjs'

// [label, id, total_weight, pairwise, connected, percent, avg_weight]
const LIVE = [
  ['neuron', 'FBbt_00005106', 2058877, 630396, 10216, 64, 3.27],
  ['CNS neuron', 'FBbt_90000002', 2056495, 628633, 10215, 64, 3.27],
  ['adult neuron', 'FBbt_90000003', 2021360, 622375, 10044, 63, 3.25],
  ['adult CNS neuron', 'FBbt_90000004', 2019368, 620778, 10043, 63, 3.25],
  ['interneuron', 'FBbt_90000005', 1979940, 608249, 10188, 64, 3.26],
  ['adult interneuron', 'FBbt_90000006', 1942792, 600384, 10016, 63, 3.24],
  ['supraesophageal ganglion neuron', 'FBbt_90000007', 1522236, 580939, 10027, 63, 2.62],
  ['aminergic neuron', 'FBbt_90000008', 1220414, 518086, 8638, 54, 2.36],
  ['adult aminergic neuron', 'FBbt_90000009', 1215525, 516885, 8500, 53, 2.35],
  ['dopaminergic neuron', 'FBbt_90000010', 1217607, 516633, 8610, 54, 2.36],
  ['mushroom body dopaminergic neuron', 'FBbt_90000011', 1217339, 516416, 8606, 54, 2.36],
  ['cholinergic neuron', 'FBbt_90000012', 1012958, 444014, 9588, 60, 2.28],
  ['mushroom body intrinsic neuron', 'FBbt_90000013', 1194247, 424465, 9403, 59, 2.81],
  ['Kenyon cell', 'FBbt_00003686', 815441, 408985, 9132, 57, 1.99],
  ['adult central brain intrinsic neuron', 'FBbt_90000015', 802434, 405125, 8955, 56, 1.98],
  ['adult MBp lineage neuron', 'FBbt_90000016', 802435, 405125, 8955, 56, 1.98],
  ['adult Kenyon cell', 'FBbt_90000017', 802431, 405124, 8955, 56, 1.98],
  ['adult peptidergic neuron', 'FBbt_90000018', 662320, 350422, 7728, 48, 1.89],
  ['peptidergic neuron', 'FBbt_90000019', 662321, 350422, 7728, 48, 1.89],
  ['neurosecretory neuron', 'FBbt_90000020', 662300, 350406, 7728, 48, 1.89],
  ['adult neurosecretory neuron', 'FBbt_90000021', 662299, 350406, 7728, 48, 1.89],
  ['neurosecretory cell of brain', 'FBbt_90000022', 662298, 350405, 7728, 48, 1.89],
  ['neurosecretory cell of adult brain', 'FBbt_90000023', 662297, 350405, 7728, 48, 1.89],
  ['sNPF neuron', 'FBbt_90000024', 662286, 350184, 7728, 48, 1.89],
  ['input/output neuron', 'FBbt_90000025', 779791, 179516, 9525, 60, 4.34],
  ['mushroom body extrinsic neuron', 'FBbt_90000026', 770535, 175125, 9504, 59, 4.40],
  ['secondary neuron', 'FBbt_90000027', 487258, 121529, 8299, 52, 4.01],
  ['mushroom body modulatory input neuron', 'FBbt_90000028', 171671, 87691, 6853, 43, 1.96],
  ['mushroom body output neuron', 'FBbt_90000029', 591432, 83379, 9441, 59, 7.09],
  ['Notch ON hemilineage neuron', 'FBbt_90000030', 154505, 81197, 6299, 39, 1.90],
  ['adult dopaminergic mushroom body input neuron', 'FBbt_90000031', 154337, 81070, 6288, 39, 1.90],
  ['adult dopaminergic PAM neuron', 'FBbt_90000032', 154331, 81068, 6286, 39, 1.90]
]

const QUERY_ID = 'FBbt_00003686'

function downstreamPayload(rows = LIVE) {
  return {
    count: 10073,
    rows: rows.map(([label, id, w, pw, cn, pc, avg]) => ({
      id,
      query_id: QUERY_ID,
      total_n: 15994,
      connected_n: cn,
      percent_connected: pc,
      pairwise_connections: pw,
      total_weight: w,
      avg_weight: avg,
      downstream_class: `[${label}](${id})`,
      upstream_class: `[Kenyon cell](${QUERY_ID})`
    }))
  }
}

// The same table with the columns swapped, which is what UpstreamClassConnectivity
// returns: the partner moves to `upstream_class` and Kenyon cell to `downstream_class`.
function upstreamPayload(rows = LIVE) {
  return {
    count: 10073,
    rows: rows.map(([label, id, w, pw, cn, pc, avg]) => ({
      id,
      query_id: QUERY_ID,
      total_n: 15994,
      connected_n: cn,
      percent_connected: pc,
      pairwise_connections: pw,
      total_weight: w,
      avg_weight: avg,
      upstream_class: `[${label}](${id})`,
      downstream_class: `[Kenyon cell](${QUERY_ID})`
    }))
  }
}

const labelsOf = list => list.map(r => r.label)

// --- recognising the payload -------------------------------------------------

test('a class-connectivity table is recognised, and other payloads are not', () => {
  assert.equal(isClassConnectivityPayload(downstreamPayload()), true)
  assert.equal(isClassConnectivityPayload(upstreamPayload()), true)
  assert.equal(isClassConnectivityPayload({ rows: [] }), false)
  assert.equal(isClassConnectivityPayload({ rows: [{ id: 'x', name: 'y' }] }), false)
  // An individual-level connectivity table names neurons, not classes.
  assert.equal(isClassConnectivityPayload({
    rows: [{ id: 'VFB_001', weight: 73, target_neuron: '[v2LN30_R](VFB_002)' }]
  }), false)
  assert.equal(isClassConnectivityPayload(null), false)
})

// --- parsing -----------------------------------------------------------------

test('the partner column is found whichever direction ran', () => {
  const down = parseClassPartnerRows(downstreamPayload())
  assert.equal(down.direction, 'downstream')
  assert.equal(down.queryId, QUERY_ID)
  assert.equal(down.queryLabel, 'Kenyon cell')
  assert.equal(down.total, 10073, 'the table total, not the page size')
  assert.equal(down.totalIndividuals, 15994)
  assert.equal(down.rows.length, LIVE.length)
  assert.equal(down.rows[0].label, 'neuron')
  assert.equal(down.rows[0].id, 'FBbt_00005106')

  const up = parseClassPartnerRows(upstreamPayload())
  assert.equal(up.direction, 'upstream')
  assert.equal(up.queryLabel, 'Kenyon cell')
  assert.deepEqual(labelsOf(up.rows), labelsOf(down.rows))
})

test('avg_weight is derived when the column is missing', () => {
  const p = parseClassPartnerRows({
    count: 1,
    rows: [{
      id: 'FBbt_1', query_id: QUERY_ID, total_weight: 1000, pairwise_connections: 250,
      connected_n: 10, percent_connected: 5,
      downstream_class: '[thing](FBbt_1)', upstream_class: `[Kenyon cell](${QUERY_ID})`
    }]
  })
  assert.equal(p.rows[0].avgWeight, 4)
})

test('a payload with no usable rows parses to null', () => {
  assert.equal(parseClassPartnerRows(null), null)
  assert.equal(parseClassPartnerRows({ rows: [] }), null)
  assert.equal(parseClassPartnerRows({ rows: [{ id: 'x' }] }), null)
})

// --- which labels name a level of the ontology -------------------------------

test('the roll-up classes are recognised as roll-ups', () => {
  for (const label of [
    'neuron', 'CNS neuron', 'adult neuron', 'adult CNS neuron', 'interneuron',
    'adult interneuron', 'supraesophageal ganglion neuron', 'subesophageal ganglion neuron',
    'aminergic neuron', 'dopaminergic neuron', 'cholinergic neuron', 'peptidergic neuron',
    'mushroom body intrinsic neuron', 'mushroom body extrinsic neuron',
    'input/output neuron', 'secondary neuron', 'adult MBp lineage neuron',
    'Notch ON hemilineage neuron', 'neurosecretory neuron', 'neurosecretory cell of brain'
  ]) {
    assert.equal(isAggregateClassPartner(label), true, label)
  }
})

test('a real cell class is not mistaken for a roll-up', () => {
  for (const label of [
    'mushroom body output neuron',
    'adult dopaminergic PAM neuron',
    'adult dopaminergic mushroom body input neuron',
    'mushroom body modulatory input neuron',
    'Kenyon cell',
    'adult Kenyon cell',
    'DA1 lPN',
    'sNPF neuron'
  ]) {
    assert.equal(isAggregateClassPartner(label), false, label)
  }
})

test('the transmitter class the user asked about is still a roll-up to them', () => {
  // "Which dopaminergic neurons target Kenyon cells?" cannot be answered with
  // "dopaminergic neurons" — that is the set they are asking to see inside.
  assert.equal(isAggregateClassPartner('dopaminergic neuron', 'dopaminergic partners'), true)
  assert.equal(isAggregateClassPartner('mushroom body dopaminergic neuron', 'DANs'), true)
  assert.equal(isAggregateClassPartner('adult dopaminergic PAM neuron', 'dopaminergic partners'), false)
  // With a dopaminergic filter in play, an unrelated transmitter class is not
  // what they asked to look inside, so it keeps its own footing.
  assert.equal(isAggregateClassPartner('cholinergic neuron', 'dopaminergic partners'), false)
})

test('a row object is accepted as well as a bare string', () => {
  assert.equal(isAggregateClassPartner({ label: 'CNS neuron' }), true)
  assert.equal(isAggregateClassPartner({ label: 'mushroom body output neuron' }), false)
  assert.equal(isAggregateClassPartner(''), false)
  assert.equal(isAggregateClassPartner(null), false)
})

test('normalisation flattens the punctuation the labels actually carry', () => {
  assert.equal(normalizePartnerLabel('  Input/Output  Neuron '), 'input output neuron')
  assert.equal(normalizePartnerLabel('adult MBp lineage neuron'), 'adult mbp lineage neuron')
})

// --- arithmetic collapse -----------------------------------------------------

test('four names for one set of connections collapse to the most specific', () => {
  const chain = parseClassPartnerRows(downstreamPayload(LIVE.filter(
    r => ['Kenyon cell', 'adult central brain intrinsic neuron', 'adult MBp lineage neuron', 'adult Kenyon cell'].includes(r[0])
  )))
  const kept = collapseOntologyChains(chain.rows)
  assert.deepEqual(labelsOf(kept), ['adult Kenyon cell'],
    'fewest connections wins: a subclass connects to a subset of what its superclass does')
  assert.deepEqual(kept[0].alsoNamed.sort(), [
    'Kenyon cell', 'adult MBp lineage neuron', 'adult central brain intrinsic neuron'
  ], 'the names it stands in for are recorded, not discarded')
})

test('rows that merely rank next to each other are not collapsed', () => {
  const pair = parseClassPartnerRows(downstreamPayload(LIVE.filter(
    r => ['mushroom body modulatory input neuron', 'mushroom body output neuron'].includes(r[0])
  )))
  assert.equal(collapseOntologyChains(pair.rows).length, 2,
    '87691 vs 83379 is a 5% gap — different sets of connections')
})

test('collapsing preserves the original order', () => {
  const table = parseClassPartnerRows(downstreamPayload())
  const kept = collapseOntologyChains(table.rows)
  assert.ok(kept.length < table.rows.length)
  assert.equal(kept[0].label, 'adult CNS neuron', 'the top group keeps the top position')
  const pos = l => kept.findIndex(r => r.label === l)
  assert.ok(pos('adult CNS neuron') < pos('adult interneuron'))
  assert.ok(pos('adult interneuron') < pos('mushroom body output neuron'))
})

// --- the ranking -------------------------------------------------------------

test('the MBONs come first, where a fly neuroscientist would put them', () => {
  const ranked = rankClassPartners(parseClassPartnerRows(downstreamPayload()))
  assert.equal(ranked.partners[0].label, 'mushroom body output neuron',
    'rank 37 by total weight, rank 1 by synapses per connected pair')
  assert.equal(ranked.direction, 'downstream')
  assert.equal(ranked.total, 10073)
})

test('no roll-up class survives into the ranked partners', () => {
  const ranked = rankClassPartners(parseClassPartnerRows(downstreamPayload()))
  for (const r of ranked.partners) {
    assert.equal(isAggregateClassPartner(r), false, `${r.label} should not be a ranked partner`)
  }
  assert.ok(!labelsOf(ranked.partners).includes('Kenyon cell'))
  assert.ok(!labelsOf(ranked.partners).includes('adult Kenyon cell'), 'self is not a partner')
})

test('the roll-ups are reported rather than hidden', () => {
  const ranked = rankClassPartners(parseClassPartnerRows(downstreamPayload()))
  assert.ok(ranked.aggregates.length >= 1)
  for (const r of ranked.aggregates) assert.equal(isAggregateClassPartner(r), true, r.label)
  assert.equal(ranked.aggregates[0].label, 'adult CNS neuron',
    'the biggest roll-up VFB put at the top, under its most specific name')
})

test('self-connection is separated out and kept', () => {
  const ranked = rankClassPartners(parseClassPartnerRows(downstreamPayload()))
  assert.equal(ranked.self.length, 1)
  assert.equal(ranked.self[0].label, 'adult Kenyon cell')
})

test('the ranking is by an intensive quantity, so generality cannot buy a place', () => {
  const ranked = rankClassPartners(parseClassPartnerRows(downstreamPayload()), { topN: 4 })
  const avgs = ranked.partners.map(r => r.avgWeight)
  assert.deepEqual(avgs, [...avgs].sort((a, b) => b - a))
  assert.ok(ranked.partners.length <= 4)
  // Every surviving specific partner, in order.
  assert.deepEqual(labelsOf(ranked.partners), [
    'mushroom body output neuron',
    'mushroom body modulatory input neuron',
    'adult dopaminergic PAM neuron',
    'sNPF neuron'
  ])
})

test('a class barely any individuals reach is not a main partner', () => {
  const table = parseClassPartnerRows(downstreamPayload([
    ['mushroom body output neuron', 'FBbt_90000029', 591432, 83379, 9441, 59, 7.09],
    ['freak class', 'FBbt_90000099', 900, 1, 1, 0, 900]
  ]))
  const ranked = rankClassPartners(table)
  assert.deepEqual(labelsOf(ranked.partners), ['mushroom body output neuron'],
    'one enormous connection from one individual is not a population fact')
})

test('the floor is relaxed rather than returning nothing', () => {
  const table = parseClassPartnerRows(downstreamPayload([
    ['freak class', 'FBbt_90000099', 900, 1, 1, 0, 900]
  ]))
  assert.deepEqual(labelsOf(rankClassPartners(table).partners), ['freak class'])
})

test('an upstream table ranks the same way and says so', () => {
  const ranked = rankClassPartners(parseClassPartnerRows(upstreamPayload()))
  assert.equal(ranked.direction, 'upstream')
  assert.equal(ranked.partners[0].label, 'mushroom body output neuron')
})

// --- the claim ---------------------------------------------------------------

test('the claim answers the question that was asked', () => {
  const s = summariseClassPartners(downstreamPayload(), { label: 'Kenyon cell' })
  assert.ok(s, 'a summary was produced')
  const c = s.claim

  // The answer.
  assert.ok(c.includes('mushroom body output neuron'), c)
  assert.ok(/7\.09 synapses per connected pair/.test(c), c)
  assert.ok(/59% of individuals connected/.test(c), c)

  // Why this is not the order VFB returned — the reader is entitled to know.
  assert.ok(/ranked by total synaptic weight/.test(c), c)
  assert.ok(/mean synaptic weight per connected pair/.test(c), c)

  // The roll-ups are named, not quietly dropped.
  assert.ok(/roll-up classes/.test(c), c)
  assert.ok(c.includes('adult CNS neuron'), c)

  // Self-connection is stated rather than passed off as a partner.
  assert.ok(/connects to itself/.test(c), c)

  assert.ok(/10,073 downstream classes/.test(c), c)
  assert.equal(s.rows[0].name, 'mushroom body output neuron')
  assert.equal(s.rows[0].id, 'FBbt_90000029')
})

test('the collapsed names are surfaced in the claim, not swallowed', () => {
  const c = summariseClassPartners(downstreamPayload(), { label: 'Kenyon cell' }).claim
  assert.ok(/VFB lists the same connections under/.test(c), c)
  assert.ok(c.includes('adult peptidergic neuron'), c)
})

test('near-tied partners are separated to a place the reader can check', () => {
  // 1.96 / 1.90 / 1.89 all round to 1.9, which would print three ties in an
  // order nothing in the answer justifies.
  const c = summariseClassPartners(downstreamPayload(), { label: 'Kenyon cell' }).claim
  assert.ok(/1\.96 synapses/.test(c), c)
  assert.ok(/1\.89 synapses/.test(c), c)
})

test('an upstream claim says input to, not targets of', () => {
  const c = summariseClassPartners(upstreamPayload(), { label: 'Kenyon cell' }).claim
  assert.ok(/strongest specific input to Kenyon cell/.test(c), c)
  const d = summariseClassPartners(downstreamPayload(), { label: 'Kenyon cell' }).claim
  assert.ok(/strongest specific targets of Kenyon cell/.test(d), d)
})

test('a table with nothing but roll-ups yields no claim rather than a bad one', () => {
  const onlyAggregates = downstreamPayload(LIVE.filter(r => isAggregateClassPartner(r[0])))
  assert.equal(summariseClassPartners(onlyAggregates, { label: 'Kenyon cell' }), null)
  assert.equal(summariseClassPartners({ rows: [] }, { label: 'Kenyon cell' }), null)
  assert.equal(summariseClassPartners(null), null)
})

test('the label falls back to the caller when the payload does not name the query class', () => {
  const payload = downstreamPayload([LIVE[28]])
  for (const r of payload.rows) r.upstream_class = ''
  const s = summariseClassPartners(payload, { label: 'Kenyon cell' })
  assert.ok(s.claim.includes('Kenyon cell'), s.claim)
})
