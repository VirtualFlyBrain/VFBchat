// Tests for the term-info digest — the P0 fix that surfaces Queries[] previews
// (label + count + examples) so region/connectivity/genetic questions are
// answerable from data the harness already fetches.
// Run: node --test tests/unit/termInfoDigest.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTermInfo, buildTermInfoDigest, digestToText, termInfoToDigestText, unwrapTermInfo, parseReplacedBy, isDeprecatedRecord, parseThumbnailEntity } from '../../lib/termInfoDigest.mjs'

test('parseThumbnailEntity reads the depicted entity from the first two shards, template from the last segment', () => {
  // /i/<e1>/<e2>/<TEMPLATE>/thumbnail.png — entity VFB_001029eo (the neuron) on
  // template VFB_00101567 (JRC2018U). Confirmed against the live Images field.
  assert.deepEqual(
    parseThumbnailEntity('https://www.virtualflybrain.org/data/VFB/i/0010/29eo/VFB_00101567/thumbnail.png'),
    { id: 'VFB_001029eo', template: 'VFB_00101567' })
  // http + thumbnailT variant resolves the same entity.
  assert.equal(parseThumbnailEntity('http://www.virtualflybrain.org/data/VFB/i/jrmc/20bn/VFB_00101567/thumbnailT.png').id, 'VFB_jrmc20bn')
  // A non-thumbnail / unparseable URL yields no id (so callers omit the link
  // rather than building reports/<png-url>).
  assert.deepEqual(parseThumbnailEntity('https://example.com/foo.png'), { id: '', template: '' })
  assert.equal(parseThumbnailEntity('').id, '')
})

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

test('unwrapTermInfo handles the multi-id MCP batch-keyed and array formats', () => {
  const rec = { Name: 'adult lateral horn', Id: 'FBbt_00007053', SuperTypes: ['Class'], Meta: { Name: '[adult lateral horn](FBbt_00007053)' }, Queries: [] }
  assert.equal(unwrapTermInfo(rec), rec)                                    // already flat
  assert.equal(unwrapTermInfo({ FBbt_00007053: rec }, 'FBbt_00007053'), rec) // batch-keyed
  assert.equal(unwrapTermInfo([rec], 'FBbt_00007053'), rec)                  // array
  // keyed with several entries: prefer the requested id
  const other = { Name: 'x', Id: 'FBbt_00009999', Meta: {}, Queries: [] }
  assert.equal(unwrapTermInfo({ FBbt_00009999: other, FBbt_00007053: rec }, 'FBbt_00007053'), rec)
  assert.equal(unwrapTermInfo({ response: { docs: [] } }), null)             // not term-info
  // the digest builds correctly from a keyed payload
  assert.equal(termInfoToDigestText({ FBbt_00007053: rec }).startsWith('adult lateral horn'), true)
})

test('parseReplacedBy reads replacement from field variants and Relationships', () => {
  // string markdown field
  assert.deepEqual(parseReplacedBy({ replaced_by: '[adult lateral horn](FBbt_00007053)' }), { label: 'adult lateral horn', id: 'FBbt_00007053' })
  // bare id string
  assert.deepEqual(parseReplacedBy({ replacedBy: 'FBbt_00007053' }), { label: '', id: 'FBbt_00007053' })
  // object form
  assert.deepEqual(parseReplacedBy({ replaced_by: { id: 'FBbt_00007053', label: 'adult lateral horn' } }), { label: 'adult lateral horn', id: 'FBbt_00007053' })
  // IAO_0100001 inside Meta.Relationships
  assert.deepEqual(
    parseReplacedBy({ Meta: { Relationships: '[term replaced by](IAO_0100001): [adult lateral horn](FBbt_00007053)' } }),
    { label: 'adult lateral horn', id: 'FBbt_00007053' }
  )
  // a live term with ordinary relationships yields no replacement
  assert.equal(parseReplacedBy({ Meta: { Relationships: '[continuous with](RO_0002150): [adult lateral horn](FBbt_00007053)' } }), null)
  assert.equal(parseReplacedBy({}), null)
})

test('isDeprecatedRecord flags obsolete records, not live ones', () => {
  assert.equal(isDeprecatedRecord({ SuperTypes: ['Class', 'Deprecated'] }), true)
  assert.equal(isDeprecatedRecord({ Meta: { Description: 'This term is obsolete.' } }), true)
  assert.equal(isDeprecatedRecord({ replaced_by: 'FBbt_00007053' }), true)
  // a normal live record (the FBbt_00007647 shape) is not flagged
  assert.equal(isDeprecatedRecord({
    SuperTypes: ['Entity', 'Class', 'Adult', 'Anatomy', 'Nervous_system'],
    Meta: { Description: 'The region of the adult brain cell body rind that overlies the lateral horn.', Relationships: '[continuous with](RO_0002150): [adult lateral horn](FBbt_00007053)' }
  }), false)
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
  // each count carries its unit (countNoun) so the model words it correctly
  assert.match(text, /Neurons with presynaptic terminals in mushroom body: 367 neuron types \(e\.g\. Li38, Li39\)/)
  assert.match(text, /Expression patterns overlapping mushroom body: 23 anatomy terms/)
  assert.match(text, /Subclasses of mushroom body: 2 subclasses/)
  // compact: must be far smaller than a raw 25 KB payload
  assert.ok(text.length < 4000, `digest should be compact, got ${text.length}`)
})

// A large query type (e.g. ImagesNeurons on a big region like the medulla) comes
// back from get_term_info with count -1 and no preview rows. That means the data
// EXISTS but was not pre-counted — it must be RUN. Regression guard for the bug
// where such queries were dropped from the digest and the assistant then wrongly
// answered "VFB does not currently hold data".
const UNCOUNTED = {
  Name: 'medulla',
  Id: 'FBbt_00003748',
  Meta: { Name: '[medulla](FBbt_00003748)', Description: 'Optic-lobe neuropil.' },
  Queries: [
    { query: 'ImagesNeurons', label: 'Images of neurons with some part in the medulla', count: -1, preview_results: { rows: [] } },
    { query: 'SubclassesOf', label: 'Subclasses of medulla', count: 4, preview_results: { rows: [{ label: '[medulla layer](FBbt_00003749)' }] } },
    { query: 'Empty', label: 'Nothing here', count: 0, preview_results: { rows: [] } }
  ]
}

test('uncounted (-1) queries are kept and flagged to be run, not dropped as "no data"', () => {
  const d = buildTermInfoDigest(UNCOUNTED)
  const labels = d.queries.map(q => q.label)
  // -1 query kept; genuinely empty (count 0, no examples) still dropped
  assert.ok(labels.includes('Images of neurons with some part in the medulla'))
  assert.ok(!labels.includes('Nothing here'))

  const text = termInfoToDigestText(UNCOUNTED)
  // The image query is surfaced (not hidden / bare -1) and typed as an individual-
  // image query so the model reads its count as images, not classes.
  assert.match(text, /Images of neurons with some part in the medulla: not pre-counted — run this query to get its count of images of neurons \[ImagesNeurons — individual images/)
  assert.doesNotMatch(text, /-1/)
  // the counted CLASS query is typed as ontology classes, so its count can't be
  // mistaken for an image count — this is the "28 images" fix at source
  assert.match(text, /Subclasses of medulla: 4 subclasses/)
  assert.match(text, /\[SubclassesOf — ontology classes; thumbnails are examples; count = subclasses/)
})

test('digest typing distinguishes an image query from a class query on the same term', () => {
  const term = {
    Name: 'medulla', Id: 'FBbt_00003748', Meta: { Name: '[medulla](FBbt_00003748)' },
    Queries: [
      { query: 'ImagesNeurons', label: 'Images of neurons with some part in medulla', count: 226524, preview_results: { rows: [] } },
      { query: 'PartsOf', label: 'Parts of medulla', count: 28, preview_results: { rows: [] } }
    ]
  }
  const text = termInfoToDigestText(term)
  assert.match(text, /Images of neurons with some part in medulla: 226524 images of neurons \[ImagesNeurons — individual images/)
  // PartsOf's 28 is explicitly typed as classes/subparts, not images
  assert.match(text, /Parts of medulla: 28 subparts \[PartsOf — ontology classes; thumbnails are examples; count = subparts/)
})
