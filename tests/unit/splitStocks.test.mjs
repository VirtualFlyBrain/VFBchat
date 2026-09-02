// Fly stocks for the split-GAL4 lines targeting a neuron class (issue #46).
// Fixture figures are verbatim from the live MCP: SplitsTargeting on gamma
// dorsal Kenyon cell (FBbt_00110932) and FindStocks on its first split's two
// constructs. Run: node --test tests/unit/splitStocks.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSplitRows, parseStockRows, intersectSplitStocks, summariseSplitStocks, describeStock } from '../../lib/splitStocks.mjs'
import { maybeInjectSplitStocksStep } from '../../lib/orchestrator.mjs'
import { isSplitGal4Question, questionKinds } from '../../lib/queryTypes.mjs'

const SPLITS = { count: 9, rows: [
  { id: 'VFBexp_FBtp0099464FBtp0117485', label: '[P{R21B06-GAL4.DBD} ∩ P{R13F02-p65.AD} expression pattern](VFBexp_FBtp0099464FBtp0117485)', tags: 'Split' },
  { id: 'VFBexp_FBtp0099471FBtp0099525', label: '[P{R26E07-GAL4.DBD} ∩ P{R19B03-p65.AD} expression pattern](VFBexp_FBtp0099471FBtp0099525)', tags: 'Split' },
  { id: 'VFBexp_single', label: '[not a split](VFBexp_single)', tags: 'Split' }
] }
const DBD = { count: 4, rows: [
  { id: 'FBst0602932', stock_id: 'FBst0602932', stock_number: '602932', genotype: 'w[1118]; P{VT043086-p65.AD}attP40; P{R21B06-GAL4.DBD}attP2', collection: 'Bloomington Drosophila Stock Center' },
  { id: 'FBst0068318', stock_id: 'FBst0068318', stock_number: '68318', genotype: 'w[1118]; P{R13F02-p65.AD}attP40; P{R21B06-GAL4.DBD}attP2', collection: 'Bloomington Drosophila Stock Center' }
] }
const AD = { count: 11, rows: [
  { id: 'FBst0604442', stock_id: 'FBst0604442', stock_number: '604442', genotype: 'w[1118]; P{R13F02-p65.AD}attP40; P{R30A06-GAL4.DBD}attP2', collection: 'Bloomington Drosophila Stock Center' },
  { id: 'FBst0068318', stock_id: 'FBst0068318', stock_number: '68318', genotype: 'w[1118]; P{R13F02-p65.AD}attP40; P{R21B06-GAL4.DBD}attP2', collection: 'Bloomington Drosophila Stock Center' }
] }

test('a split row names its two constructs; a row that does not is skipped', () => {
  const rows = parseSplitRows(SPLITS)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].constructs, ['FBtp0099464', 'FBtp0117485'])
  assert.equal(rows[0].label, 'P{R21B06-GAL4.DBD} ∩ P{R13F02-p65.AD}')
})

test('the stock carrying both hemidrivers is the intersection, and only that', () => {
  const splits = parseSplitRows(SPLITS)
  const by = new Map([['FBtp0099464', parseStockRows(DBD)], ['FBtp0117485', parseStockRows(AD)]])
  const out = intersectSplitStocks(splits, by)
  assert.deepEqual(out[0].stocks.map(s => s.number), ['68318'])
  assert.equal(describeStock(out[0].stocks[0]), 'BDSC 68318')
  // The second split's constructs were not looked up: no stocks, not a claim.
  assert.deepEqual(out[1].stocks, [])
  assert.equal(out[1].constructs_checked, 0)
})

test('the claim names each stock, and the table links it', () => {
  const splits = intersectSplitStocks(parseSplitRows(SPLITS), new Map([['FBtp0099464', parseStockRows(DBD)], ['FBtp0117485', parseStockRows(AD)]]))
  const s = summariseSplitStocks({ resolved: { id: 'FBbt_00110932', label: 'gamma dorsal Kenyon cell' }, split_count: 9, splits })
  assert.match(s.claim, /2 of 9 checked for stocks/)
  assert.match(s.claim, /P\{R21B06-GAL4\.DBD\} ∩ P\{R13F02-p65\.AD\} — BDSC 68318/)
  assert.match(s.claim, /No stock carrying both hemidrivers is recorded in FlyBase for P\{R26E07/)
  assert.equal(s.table.kind, 'split-stocks')
  assert.equal(s.table.rows[0].tags[0], 'BDSC 68318')
  assert.equal(s.table.rows[0].links[0].url, 'https://flybase.org/reports/FBst0068318')
  assert.deepEqual(s.table.rows[1].tags, ['no combined stock in FlyBase'])
  assert.equal(summariseSplitStocks({ splits: [] }), null)
})

test('"split drivers" is a split-GAL4 question, and a splits kind', () => {
  assert.equal(isSplitGal4Question('find me fly stocks for split drivers expressed in gamma dorsal KCs'), true)
  assert.equal(isSplitGal4Question('which driver lines label KCs?'), false)
  assert.ok(questionKinds('find me fly stocks for split drivers expressed in gamma dorsal KCs').has('splits'))
  assert.ok(questionKinds('find me fly stocks for split drivers expressed in gamma dorsal KCs').has('stocks'))
})

test('a stocks question on a neuron class injects the split-stocks macro and drops the feature-id step', () => {
  const term = { id: 'FBbt_00110932', label: 'gamma dorsal Kenyon cell', digest: { name: 'gamma dorsal Kenyon cell', queries: [{ query_type: 'SplitsTargeting' }, { query_type: 'TransgeneExpressionHere' }] }, info: { SuperTypes: ['Class', 'Neuron'] } }
  const ledger = { plan: [{ id: 's1', tool: 'vfb_find_stocks', status: 'pending', args: { feature_id: 'gamma dorsal Kenyon cell' } }], terms: { x: term } }
  maybeInjectSplitStocksStep(ledger, 'find me fly stocks for split drivers expressed in gamma dorsal KCs')
  assert.deepEqual(ledger.plan.map(s => s.tool), ['vfb_find_split_stocks'])
  assert.deepEqual(ledger.plan[0].args, { neuron_type: 'FBbt_00110932' })
  // Not a stocks question: nothing.
  const quiet = { plan: [], terms: { x: term } }
  maybeInjectSplitStocksStep(quiet, 'which split-GAL4 lines target gamma dorsal Kenyon cells?')
  assert.equal(quiet.plan.length, 0)
  // A class with no SplitsTargeting query: nothing.
  const none = { plan: [], terms: { x: { ...term, digest: { name: 'x', queries: [{ query_type: 'ListAllAvailableImages' }] } } } }
  maybeInjectSplitStocksStep(none, 'fly stocks for x?')
  assert.equal(none.plan.length, 0)
  // A gene is not a neuron class; its own FindStocks query serves it.
  const gene = { plan: [], terms: { x: { id: 'FBgn0000490', label: 'dpp', digest: { name: 'dpp', queries: [{ query_type: 'FindStocks' }] }, info: { SuperTypes: ['Gene'] } } } }
  maybeInjectSplitStocksStep(gene, 'fly stocks for dpp?')
  assert.equal(gene.plan.length, 0)
})
