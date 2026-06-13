// Tests for follow-on suggestion + provenance generation.
// Run: node --test tests/unit/followOns.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFollowOns, vfbReportUrl, stripMarkdown, buildTermLinks, linkifyKnownTerms, buildCountLinks, linkifyCounts } from '../../lib/followOns.mjs'
import { createLedger, recordTermId } from '../../lib/ledger.mjs'

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
  assert.equal(terms.length, 1)
  assert.equal(terms[0].name, 'mushroom body')
  assert.equal(terms[0].id, 'FBbt_00005801')
  assert.equal(terms[0].label, 'mushroom body')
  // source links to the term report (provenance for "(vfb)")
  assert.deepEqual(sources, [{ label: 'mushroom body', url: 'https://www.virtualflybrain.org/reports/FBbt_00005801', id: 'FBbt_00005801', superseded: null }])
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

test('buildFollowOns carries a superseded note from a deprecated->replacement redirect', () => {
  const ledger = ledgerWith({
    name: 'adult lateral horn', id: 'FBbt_00007053', label: 'adult lateral horn',
    digest: { name: 'adult lateral horn', queries: [] },
    superseded: { fromId: 'FBbt_00099999', fromLabel: 'old lateral horn' }
  })
  const { terms, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms[0].superseded, { fromId: 'FBbt_00099999', fromLabel: 'old lateral horn' })
  assert.deepEqual(sources[0].superseded, { fromId: 'FBbt_00099999', fromLabel: 'old lateral horn' })
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

test('buildTermLinks uses the authoritative registry, never pins a label to the wrong id', () => {
  // Registry holds VFB's own labels: "mushroom body" -> region; the MBON term's
  // VFB Name is "mushroom body output neuron". A label must map to ITS id only.
  const ledger = createLedger('q')
  recordTermId(ledger, 'mushroom body', 'FBbt_00005801', { canonical: true })
  ledger.terms = { 'mushroom body output neurons': { id: 'FBbt_00047953', digest: { name: 'mushroom body output neuron', queries: [] } } }
  const links = buildTermLinks(ledger)
  const mb = links.find(l => l.name.toLowerCase() === 'mushroom body')
  const mbon = links.find(l => l.name.toLowerCase() === 'mushroom body output neuron')
  assert.equal(mb.id, 'FBbt_00005801', 'mushroom body must map to the region, not the MBON')
  assert.equal(mbon.id, 'FBbt_00047953')
  // there is NO "mushroom body" -> MBON entry
  assert.ok(!links.some(l => l.name.toLowerCase() === 'mushroom body' && l.id === 'FBbt_00047953'))
})

test('buildCountLinks + linkifyCounts turn quoted counts into VFB query links', () => {
  const ledger = { terms: { medulla: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [
    { query_type: 'ImagesNeurons', label: 'Images of neurons with some part in medulla', count: 226524, examples: [] },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in medulla', count: 471, examples: [] }
  ] } } } }
  const counts = buildCountLinks(ledger)
  assert.equal(counts[0].count, 226524) // largest first
  // query links RUN the query in the v2 browser and carry a quote-free title
  assert.equal(counts[0].url, 'https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=FBbt_00003748,ImagesNeurons')
  assert.ok(!/"/.test(counts[0].title), 'title must not contain double quotes')
  const out = linkifyCounts('There are 226,524 images and 471 neurons; also 999 unrelated.', counts)
  assert.match(out, /\[226,524\]\(https:\/\/v2\.virtualflybrain\.org\/org\.geppetto\.frontend\/geppetto\?q=FBbt_00003748,ImagesNeurons "Run in VFB: [^"]*"\)/)
  assert.match(out, /\[471\]\(/)
  // a number that is not a known count is left alone
  assert.match(out, /also 999 unrelated/)
  assert.ok(!/\[999\]/.test(out))
})

test('linkifyCounts leaves counts inside existing links/code alone and links each once', () => {
  const counts = [{ count: 471, url: 'https://x/FBbt_1', title: 'View x in VFB' }]
  const out = linkifyCounts('See [471](http://keep) and `471` and 471 plus 471 again.', counts)
  assert.match(out, /\[471\]\(http:\/\/keep\)/)   // untouched
  assert.match(out, /`471`/)                        // untouched
  assert.equal((out.match(/FBbt_1/g) || []).length, 1) // linked once only
})

test('unresolved terms (no id) produce nothing', () => {
  const ledger = ledgerWith({ name: 'wibble', id: null })
  const { terms, chips, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms, [])
  assert.deepEqual(chips, [])
  assert.deepEqual(sources, [])
})
