// Tests for follow-on suggestion + provenance generation.
// Run: node --test tests/unit/followOns.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFollowOns, vfbReportUrl } from '../../lib/followOns.mjs'

function ledgerWith(term) {
  return { terms: { [term.name]: term } }
}

test('vfbReportUrl builds a VFB report link', () => {
  assert.equal(vfbReportUrl('FBbt_00005801'), 'https://www.virtualflybrain.org/reports/FBbt_00005801')
  assert.equal(vfbReportUrl(''), '')
})

test('buildFollowOns derives ask chips from real queries + an open-in-VFB chip + a source', () => {
  const ledger = ledgerWith({
    name: 'mushroom body', id: 'FBbt_00005801', label: 'mushroom body',
    digest: { name: 'mushroom body', queries: [
      { query_type: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in mushroom body', count: 367, examples: [] },
      { query_type: 'SubclassesOf', label: 'Subclasses', count: 2, examples: [] },
      { query_type: 'ListAllAvailableImages', label: 'Images', count: 0, examples: [] }
    ] }
  })
  const { terms, chips, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms, [{ name: 'mushroom body', id: 'FBbt_00005801', label: 'mushroom body' }])
  // source links to the term report (provenance for "(vfb)")
  assert.deepEqual(sources, [{ label: 'mushroom body', url: 'https://www.virtualflybrain.org/reports/FBbt_00005801', id: 'FBbt_00005801' }])
  // ask chip from the highest-count query, with a clear title and a runnable query
  const ask = chips.find(c => c.kind === 'ask')
  assert.match(ask.query, /input to mushroom body/)
  assert.match(ask.label, /\(367\)$/)
  assert.match(ask.title, /^Ask VFB:/)
  // open-in-VFB chip with a "new tab" title
  const vfb = chips.find(c => c.kind === 'vfb')
  assert.equal(vfb.url, 'https://www.virtualflybrain.org/reports/FBbt_00005801')
  assert.match(vfb.title, /new tab/)
  // zero-count query (Images) produced no ask chip
  assert.ok(!chips.some(c => c.kind === 'ask' && /image/i.test(c.query || '')))
})

test('unresolved terms (no id) produce nothing', () => {
  const ledger = ledgerWith({ name: 'wibble', id: null })
  const { terms, chips, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms, [])
  assert.deepEqual(chips, [])
  assert.deepEqual(sources, [])
})
