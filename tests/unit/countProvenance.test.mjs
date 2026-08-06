// An advertisement is not an observation.
//
// Fixtures are the live W7.C4 numbers: term-info advertises 92
// TransgeneExpressionHere records for Kenyon cell (FBbt_00003686); running the
// query returns count 42, 42 rows, capped false.
//
// Run: node --test tests/unit/countProvenance.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isObservedTotal, recordObservedCount, supersededCounts, stripSupersededFigures
} from '../../lib/countProvenance.mjs'

const advertised = () => ({
  query_type: 'TransgeneExpressionHere',
  label: 'Transgene expression in Kenyon cell',
  count: 92,
  countKind: 'exact'
})

const observed = { count: 42, count_status: 'exact', capped: false, rows: new Array(42) }

// --- what counts as an observation ------------------------------------------

test('an uncapped, counted payload is an observation', () => {
  assert.equal(isObservedTotal(observed), true)
  assert.equal(isObservedTotal({ count: 0, count_status: 'exact' }), true)
})

test('a floor is not an observation', () => {
  assert.equal(isObservedTotal({ count: 1000, capped: true }), false)
  assert.equal(isObservedTotal({ count: 1000, truncated: true }), false)
  assert.equal(isObservedTotal({ count: -1 }), false)
  assert.equal(isObservedTotal({ count: 42, count_status: 'unavailable' }), false)
  assert.equal(isObservedTotal(null), false)
  assert.equal(isObservedTotal({}), false)
})

// --- the overwrite ----------------------------------------------------------

test('the observed count wins and the advertised one is kept for provenance', () => {
  const q = advertised()
  assert.equal(recordObservedCount(q, observed), true)
  assert.equal(q.count, 42)
  assert.equal(q.countKind, 'exact')
  assert.equal(q.advertisedCount, 92)
  assert.equal(q.countObserved, true)
})

test('agreement changes nothing but is still marked observed', () => {
  const q = advertised()
  assert.equal(recordObservedCount(q, { count: 92, count_status: 'exact' }), false)
  assert.equal(q.count, 92)
  assert.equal(q.countObserved, true)
  assert.ok(!('advertisedCount' in q))
})

test('a second run cannot erase the original advertisement', () => {
  const q = advertised()
  recordObservedCount(q, observed)
  recordObservedCount(q, { count: 40, count_status: 'exact' })
  assert.equal(q.count, 40)
  assert.equal(q.advertisedCount, 92, 'still the figure the answer might be quoting')
})

test('an unknown count is filled in without claiming it was ever advertised', () => {
  const q = { query_type: 'X', label: 'X', count: -1, countKind: 'unknown' }
  assert.equal(recordObservedCount(q, observed), true)
  assert.equal(q.count, 42)
  assert.equal(q.countKind, 'exact')
  assert.ok(!('advertisedCount' in q), '-1 was never a claim, so nothing was superseded')
})

// --- reading them back off the ledger ---------------------------------------

const ledgerWith = q => ({ terms: { kc: { id: 'FBbt_00003686', digest: { queries: [q] } } } })

test('supersededCounts reports only genuine disagreements', () => {
  const q = advertised()
  recordObservedCount(q, observed)
  assert.deepEqual(supersededCounts(ledgerWith(q)), [{
    queryType: 'TransgeneExpressionHere',
    label: 'Transgene expression in Kenyon cell',
    termId: 'FBbt_00003686',
    advertised: 92,
    observed: 42
  }])
  assert.deepEqual(supersededCounts(ledgerWith(advertised())), [])
  assert.deepEqual(supersededCounts({}), [])
  assert.deepEqual(supersededCounts(null), [])
})

// --- the prose backstop -----------------------------------------------------

const SUP = [{ queryType: 'TransgeneExpressionHere', label: 'Transgene expression in Kenyon cell', advertised: 92, observed: 42 }]

test('the W7.C4 answer stops contradicting itself', () => {
  const input = 'VFB also holds transgene expression reports for Kenyon cell, with 42 results '
    + 'returned. However, it is also stated that VFB has 92 transgene expression reports for '
    + 'Kenyon cell.'
  assert.equal(
    stripSupersededFigures(input, SUP),
    'VFB also holds transgene expression reports for Kenyon cell, with 42 results returned.'
  )
})

test('it works whichever order the two figures appear in', () => {
  const input = 'VFB has 92 transgene expression reports for Kenyon cell. '
    + 'Running the transgene expression query returned 42.'
  assert.equal(
    stripSupersededFigures(input, SUP),
    'Running the transgene expression query returned 42.'
  )
})

test('with no true figure in the prose, the stale one is corrected, not deleted', () => {
  // Deleting here would take the reader's only number away.
  const input = 'VFB holds 92 transgene expression reports for Kenyon cell.'
  assert.equal(
    stripSupersededFigures(input, SUP),
    'VFB holds 42 transgene expression reports for Kenyon cell.'
  )
})

test('a sentence about something else keeps its number', () => {
  // 92 is also a synapse weight, a cluster size and part of an id.
  const input = 'DA1_lPN_R makes 92 synapses onto v2LN30_R.'
  assert.equal(stripSupersededFigures(input, SUP), input)
  assert.equal(stripSupersededFigures('See VFB_00000092 for the registration.', SUP),
    'See VFB_00000092 for the registration.')
  assert.equal(stripSupersededFigures('VFB holds 1,923 expression records.', SUP),
    'VFB holds 1,923 expression records.')
})

test('a sentence carrying both figures is left for the reader to see', () => {
  const input = 'The transgene expression preview advertises 92 but the query returns 42.'
  assert.equal(stripSupersededFigures(input, SUP), input)
})

test('thousands separators are matched either way round', () => {
  const sup = [{ label: 'Images of Kenyon cell', advertised: 32328, observed: 31000 }]
  assert.equal(
    stripSupersededFigures('VFB holds 32,328 images of Kenyon cell.', sup),
    'VFB holds 31,000 images of Kenyon cell.'
  )
  assert.equal(
    stripSupersededFigures('VFB holds 32328 images of Kenyon cell.', sup),
    'VFB holds 31,000 images of Kenyon cell.'
  )
})

test('nothing to do is a no-op', () => {
  const input = 'VFB records 42 transgene expression reports for Kenyon cell.'
  assert.equal(stripSupersededFigures(input, SUP), input)
  assert.equal(stripSupersededFigures(input, []), input)
  assert.equal(stripSupersededFigures('', SUP), '')
  assert.equal(stripSupersededFigures(null, SUP), '')
})

test('markdown structure survives a deletion', () => {
  const input = '## Expression\n\nVFB records 42 transgene expression reports for Kenyon cell.\n'
    + 'It is also stated that VFB has 92 transgene expression reports.\n\n- one\n- two\n'
  const out = stripSupersededFigures(input, SUP)
  assert.ok(out.startsWith('## Expression'), out)
  assert.ok(out.includes('- one\n- two'), out)
  assert.ok(!/\b92\b/.test(out), out)
})
