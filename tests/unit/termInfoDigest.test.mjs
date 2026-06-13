// Tests for the term-info digest — the P0 fix that surfaces Queries[] previews
// (label + count + examples) so region/connectivity/genetic questions are
// answerable from data the harness already fetches.
// Run: node --test tests/unit/termInfoDigest.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTermInfo, buildTermInfoDigest, digestToText, termInfoToDigestText } from '../../lib/termInfoDigest.mjs'

// Trimmed mushroom-body-shaped fixture (mirrors the live MCP payload).
const MB = {
  Name: 'mushroom body',
  Id: 'FBbt_00005801',
  Meta: {
    Name: '[mushroom body](FBbt_00005801)',
    Description: 'Bilaterally paired neuropil ... divided into the calyx, the pedunculus, and the mushroom body lobe system (Ito et al., 2014).',
    Relationships: '[capable_of_part_of](RO_0002216): [memory](GO_0007613); [is part of](BFO_0000050): [protocerebrum](FBbt_00003627)'
  },
  Synonyms: [{ label: 'corpora pedunculata' }, { label: 'MB' }],
  Queries: [
    { query: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in mushroom body', count: 367,
      preview_results: { rows: [{ label: '[Li38](FBbt_20011419)' }, { label: '[Li39](FBbt_20011420)' }] } },
    { query: 'ExpressionOverlapsHere', label: 'Expression patterns overlapping mushroom body', count: 23,
      preview_results: { rows: [{ name: '[P{GMR21B11-GAL4} expression pattern](VFBexp_FBtp0058304)' }] } },
    { query: 'SubclassesOf', label: 'Subclasses of mushroom body', count: 2,
      preview_results: { rows: [{ label: '[adult mushroom body](FBbt_00003684)' }, { label: '[embryonic/larval mushroom body](FBbt_00011929)' }] } },
    { query: 'Empty', label: 'Nothing here', count: 0, preview_results: { rows: [] } }
  ],
  Publications: [
    { core: { label: 'Mao and Davis, 2009, Front. Neural Circuits' }, PubMed: '20011144', DOI: '', FlyBase: 'FBrf0210000' }
  ]
}

test('isTermInfo detects a term-info payload, rejects others', () => {
  assert.equal(isTermInfo(MB), true)
  assert.equal(isTermInfo({ response: { docs: [] } }), false)
  assert.equal(isTermInfo('a string'), false)
  assert.equal(isTermInfo([1, 2]), false)
})

test('buildTermInfoDigest extracts description, queries (count+examples), pubs', () => {
  const d = buildTermInfoDigest(MB)
  assert.equal(d.id, 'FBbt_00005801')
  assert.equal(d.name, 'mushroom body')
  assert.match(d.description, /calyx, the pedunculus/)
  assert.match(d.relationships, /is part of.*protocerebrum/)
  assert.deepEqual(d.synonyms, ['corpora pedunculata', 'MB'])
  // empty-count query dropped; the rest kept, links stripped from examples
  const labels = d.queries.map(q => q.label)
  assert.ok(labels.includes('Neurons with presynaptic terminals in mushroom body'))
  assert.ok(!labels.includes('Nothing here'))
  const pre = d.queries.find(q => q.query_type === 'NeuronsPresynapticHere')
  assert.equal(pre.count, 367)
  assert.deepEqual(pre.examples, ['Li38', 'Li39'])
  assert.equal(d.publications[0].pmid, '20011144')
})

test('digest name uses the full canonical label, not a short symbol', () => {
  // VFB sometimes returns a short symbol in Name (e.g. "LHN"); the displayed
  // label must be the full term so it matches the resolved id.
  const d = buildTermInfoDigest({
    Name: 'LHN', Id: 'FBbt_00048293',
    Meta: { Name: '[adult lateral horn neuron](FBbt_00048293)', Description: 'x' },
    Queries: []
  })
  assert.equal(d.name, 'adult lateral horn neuron')
})

test('digestToText renders the available-data block with counts (answers "inputs to X")', () => {
  const text = termInfoToDigestText(MB)
  assert.match(text, /Available VFB data/)
  assert.match(text, /Neurons with presynaptic terminals in mushroom body: 367 \(e\.g\. Li38, Li39\)/)
  assert.match(text, /Expression patterns overlapping mushroom body: 23/)
  assert.match(text, /Subclasses of mushroom body: 2/)
  // compact: must be far smaller than a raw 25 KB payload
  assert.ok(text.length < 4000, `digest should be compact, got ${text.length}`)
})
