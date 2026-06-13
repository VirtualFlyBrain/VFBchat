// Tests for follow-on suggestion + provenance generation.
// Run: node --test tests/unit/followOns.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFollowOns, vfbReportUrl, stripMarkdown, buildTermLinks, linkifyKnownTerms } from '../../lib/followOns.mjs'

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

test('stripMarkdown turns "[label](url)" into plain "label"', () => {
  assert.equal(stripMarkdown('[medulla](https://x/FBbt_00003748)'), 'medulla')
  assert.equal(stripMarkdown('plain'), 'plain')
})

test('chip text is clean even when the resolved term label is markdown', () => {
  const ledger = { terms: { '[medulla](https://x/FBbt_00003748)': {
    id: 'FBbt_00003748', label: '[medulla](https://x/FBbt_00003748)',
    digest: { name: 'medulla', queries: [{ query_type: 'NeuronsPartHere', label: 'x', count: 5, examples: [] }] }
  } } }
  const { chips } = buildFollowOns(ledger)
  const ask = chips.find(c => c.kind === 'ask')
  assert.ok(!/\[|\]\(/.test(ask.label), `chip label must be markdown-free: ${ask.label}`)
  assert.match(ask.query, /part of medulla/)
})

test('buildTermLinks collects resolved terms + example neurons (longest first)', () => {
  const ledger = { terms: { medulla: {
    id: 'FBbt_00003748', digest: { name: 'medulla', queries: [
      { query_type: 'NeuronsPartHere', label: 'x', count: 2, examples: ['ML-VPN2', 'Mti'],
        exampleEntities: [{ label: 'ML-VPN2', id: 'FBbt_00100001' }, { label: 'Mti', id: 'FBbt_00100002' }] }
    ] }
  } } }
  const links = buildTermLinks(ledger)
  const names = links.map(l => l.name)
  assert.ok(names.includes('medulla') && names.includes('ML-VPN2') && names.includes('Mti'))
  // longest-first so multi-token names win during replacement
  assert.ok(links[0].name.length >= links[links.length - 1].name.length)
  assert.equal(links.find(l => l.name === 'ML-VPN2').url, 'https://www.virtualflybrain.org/reports/FBbt_00100001')
})

test('linkifyKnownTerms links each term once, with a tooltip, leaving existing links/code alone', () => {
  const links = [
    { name: 'ML-VPN2', id: 'FBbt_00100001', url: 'https://www.virtualflybrain.org/reports/FBbt_00100001' },
    { name: 'medulla', id: 'FBbt_00003748', url: 'https://www.virtualflybrain.org/reports/FBbt_00003748' }
  ]
  const out = linkifyKnownTerms('The medulla contains ML-VPN2; see [medulla](http://keep.me) and `medulla` code.', links)
  // first plain "medulla" linked with a title tooltip
  assert.match(out, /\[medulla\]\(https:\/\/www\.virtualflybrain\.org\/reports\/FBbt_00003748 "Open medulla in Virtual Fly Brain"\)/)
  // ML-VPN2 linked
  assert.match(out, /\[ML-VPN2\]\(https:\/\/www\.virtualflybrain\.org\/reports\/FBbt_00100001/)
  // the pre-existing [medulla](http://keep.me) link is untouched
  assert.match(out, /\[medulla\]\(http:\/\/keep\.me\)/)
  // the `medulla` code span is untouched
  assert.match(out, /`medulla`/)
  // medulla linked only once (the first plain occurrence)
  assert.equal((out.match(/reports\/FBbt_00003748/g) || []).length, 1)
})

test('unresolved terms (no id) produce nothing', () => {
  const ledger = ledgerWith({ name: 'wibble', id: null })
  const { terms, chips, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms, [])
  assert.deepEqual(chips, [])
  assert.deepEqual(sources, [])
})
