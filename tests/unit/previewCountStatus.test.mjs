// VFBquery reports count -1 for three different situations. Before VFBquery
// 1.22.37 they were indistinguishable; preview_results.status now tells them
// apart. These tests pin the resulting semantics end to end — digest, prose,
// chips and tables — including the legacy no-status shape that v3-cached will
// keep serving from its six-month cache slots for a while yet.
//
// Run: node --test tests/unit/previewCountStatus.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildTermInfoDigest, digestToText, previewIsResolved, classifyCount, PREVIEW_COUNT_CAP
} from '../../lib/termInfoDigest.mjs'
import { buildFollowOns, buildCountLinks, linkifyCounts } from '../../lib/followOns.mjs'
import { buildTables } from '../../lib/resultTables.mjs'

const liveFixture = JSON.parse(
  readFileSync(new URL('../fixtures/termInfo_1_22_37.json', import.meta.url), 'utf8')
)

// A term-info record with one query per case we care about.
function record({ queries }) {
  return {
    Id: 'FBbt_00003748',
    Name: 'medulla',
    Meta: { Name: '[medulla](FBbt_00003748)', Description: 'A neuropil.' },
    Queries: queries
  }
}
function query(label, queryName, count, status, rows = []) {
  const preview_results = { headers: { id: {}, label: {} }, rows }
  if (status) preview_results.status = status
  return { query: queryName, label, count, output_format: 'table', preview_results }
}

// ---------------------------------------------------------------- primitives

test('previewIsResolved prefers status and falls back to count >= 0', () => {
  assert.equal(previewIsResolved({ count: 5, preview_results: { status: 'complete' } }), true)
  assert.equal(previewIsResolved({ count: 0, preview_results: { status: 'complete' } }), true)
  // the case that only status can settle: complete, but the total blew the cap
  assert.equal(previewIsResolved({ count: -1, preview_results: { status: 'complete' } }), true)
  assert.equal(previewIsResolved({ count: -1, preview_results: { status: 'pending' } }), false)
  // legacy entries carry no status at all — absence must keep meaning complete
  assert.equal(previewIsResolved({ count: 7, preview_results: { rows: [] } }), true)
  assert.equal(previewIsResolved({ count: -1, preview_results: { rows: [] } }), false)
  // no preview block at all — the count itself is the only evidence, so the
  // pre-1.22.37 rule applies unchanged
  assert.equal(previewIsResolved({ count: 7 }), true)
  assert.equal(previewIsResolved({ count: -1 }), false)
  assert.equal(previewIsResolved({}), false)
})

test('classifyCount separates exact, many and unknown', () => {
  assert.equal(classifyCount(5, true), 'exact')
  assert.equal(classifyCount(0, true), 'exact')
  assert.equal(classifyCount(-1, true), 'many')
  assert.equal(classifyCount(-1, false), 'unknown')
})

// -------------------------------------------------------------------- digest

test('digest tags each query with the right countKind', () => {
  const d = buildTermInfoDigest(record({
    queries: [
      query('Exact', 'SubclassesOf', 12, 'complete', [{ id: 'A', label: 'a' }]),
      query('Capped', 'NeuronsPartHere', -1, 'complete', [{ id: 'B', label: 'b' }]),
      query('Pending', 'ExpressionOverlapsHere', -1, 'pending', []),
      query('Legacy exact', 'PartsOf', 4, null, [{ id: 'C', label: 'c' }]),
      query('Legacy uncounted', 'ListAllAvailableImages', -1, null, [])
    ]
  }))
  const kinds = Object.fromEntries(d.queries.map(q => [q.label, q.countKind]))
  assert.deepEqual(kinds, {
    Exact: 'exact',
    Capped: 'many',
    Pending: 'unknown',
    'Legacy exact': 'exact',
    'Legacy uncounted': 'unknown'
  })
})

test('a genuinely empty query is dropped; an uncounted one is kept', () => {
  const d = buildTermInfoDigest(record({
    queries: [
      query('Really empty', 'SubclassesOf', 0, 'complete', []),
      query('Not counted', 'NeuronsPartHere', -1, 'pending', [])
    ]
  }))
  assert.deepEqual(d.queries.map(q => q.label), ['Not counted'])
})

test('a query with no count at all becomes unknown, not zero', () => {
  // Regression: count was coerced to rows.length, which is 0 for an empty
  // preview, and the query was then dropped as "counted empty" — the exact
  // "no data" misreading the -1 sentinel exists to prevent.
  const d = buildTermInfoDigest(record({
    queries: [{ query: 'PartsOf', label: 'No count', output_format: 'table' }]
  }))
  assert.equal(d.queries.length, 1)
  assert.equal(d.queries[0].countKind, 'unknown')
  assert.equal(d.queries[0].count, -1)
})

test('a resolved query with no count falls back to its row count', () => {
  const d = buildTermInfoDigest(record({
    queries: [{
      query: 'PartsOf',
      label: 'Rows only',
      output_format: 'table',
      preview_results: { status: 'complete', headers: {}, rows: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }] }
    }]
  }))
  assert.equal(d.queries[0].count, 2)
  assert.equal(d.queries[0].countKind, 'exact')
})

// ------------------------------------------------------------- digest → text

test('digest text distinguishes "more than N" from "not pre-counted"', () => {
  const d = buildTermInfoDigest(record({
    queries: [
      query('Capped', 'NeuronsPartHere', -1, 'complete', [{ id: 'B', label: 'bee' }]),
      query('Pending', 'ExpressionOverlapsHere', -1, 'pending', [])
    ]
  }))
  const text = digestToText(d)
  assert.match(text, new RegExp(`Capped: more than ${PREVIEW_COUNT_CAP}`))
  assert.match(text, /Pending: not pre-counted — run this query/)
  // and never a bare -1 anywhere in what the model reads
  assert.doesNotMatch(text, /-1/)
})

// --------------------------------------------------------------------- chips

function ledgerFor(rec) {
  const digest = buildTermInfoDigest(rec)
  return {
    terms: { medulla: { id: digest.id, label: digest.name, digest } },
    evidence: []
  }
}

test('capped queries are offered as chips and sort above exact ones', () => {
  const led = ledgerFor(record({
    queries: [
      query('Subclasses', 'SubclassesOf', 12, 'complete', [{ id: 'A', label: 'a' }]),
      query('Neurons here', 'NeuronsPartHere', -1, 'complete', [{ id: 'B', label: 'b' }])
    ]
  }))
  const { chips } = buildFollowOns(led)
  const ask = chips.filter(c => c.kind === 'ask')
  assert.ok(ask.length >= 2, 'both queries should produce ask chips')
  // "many" outranks any exact count
  assert.match(ask[0].label, new RegExp(`\\(${PREVIEW_COUNT_CAP}\\+\\)`))
  assert.ok(ask.some(c => /\(12\)/.test(c.label)))
  // no chip ever shows a -1
  assert.ok(!chips.some(c => /-1/.test(c.label)))
})

test('a pending query still produces a chip, with no number on it', () => {
  const led = ledgerFor(record({
    queries: [query('Neurons here', 'NeuronsPartHere', -1, 'pending', [])]
  }))
  const ask = buildFollowOns(led).chips.filter(c => c.kind === 'ask')
  assert.equal(ask.length, 1)
  assert.doesNotMatch(ask[0].label, /\d/)
})

test('an exactly-zero query produces no chip', () => {
  const led = ledgerFor(record({
    queries: [query('Neurons here', 'NeuronsPartHere', 0, 'complete', [])]
  }))
  assert.equal(buildFollowOns(led).chips.filter(c => c.kind === 'ask').length, 0)
})

// --------------------------------------------------------------- count links

test('only exact counts become linkable figures', () => {
  const led = ledgerFor(record({
    queries: [
      query('Subclasses', 'SubclassesOf', 12, 'complete', [{ id: 'A', label: 'a' }]),
      query('Neurons here', 'NeuronsPartHere', -1, 'complete', [{ id: 'B', label: 'b' }])
    ]
  }))
  assert.deepEqual(buildCountLinks(led).map(c => c.count), [12])
})

test('a lower bound is not linkified to a same-valued query', () => {
  const links = [{ count: PREVIEW_COUNT_CAP, url: 'https://example.org/q', title: 'Some other query' }]
  const out = linkifyCounts(`VFB holds more than ${PREVIEW_COUNT_CAP} images.`, links)
  assert.equal(out, `VFB holds more than ${PREVIEW_COUNT_CAP} images.`)
  // an ordinary figure is still linked
  assert.match(linkifyCounts(`VFB holds ${PREVIEW_COUNT_CAP} images.`, links), /\]\(https:\/\/example\.org\/q/)
})

// -------------------------------------------------------------- result table

test('a capped table reports a bound, never -1', () => {
  const led = ledgerFor(record({
    queries: [query('Neurons with some part here', 'NeuronsPartHere', -1, 'complete',
      [{ id: 'VFB_0001', label: 'neuron one' }])]
  }))
  const [tbl] = buildTables(led, 'list the neurons in the medulla')
  assert.ok(tbl, 'expected a result table')
  assert.equal(tbl.countKind, 'many')
  assert.equal(tbl.countCap, PREVIEW_COUNT_CAP)
})

// ------------------------------------------------------- real live payload

test('the live 1.22.37 payload carries status and digests to exact counts', () => {
  const statuses = liveFixture.Queries.map(q => q.preview_results.status)
  assert.deepEqual(statuses, ['complete', 'complete', 'complete'])
  const d = buildTermInfoDigest(liveFixture)
  assert.ok(d.queries.length >= 3)
  assert.ok(d.queries.every(q => q.countKind === 'exact'))
  assert.doesNotMatch(digestToText(d), /-1/)
})

test('the same payload with status stripped (the 1.22.36 shape) digests identically', () => {
  // v3-cached will serve status-less entries for months. Absence of status must
  // change nothing for an ordinary, exactly-counted term.
  const legacy = JSON.parse(JSON.stringify(liveFixture))
  for (const q of legacy.Queries) delete q.preview_results.status
  assert.deepEqual(
    buildTermInfoDigest(legacy).queries.map(q => [q.label, q.count, q.countKind]),
    buildTermInfoDigest(liveFixture).queries.map(q => [q.label, q.count, q.countKind])
  )
})
