// Tests for result tables + thumbnail parsing.
// Run: node --test tests/unit/resultTables.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseThumbnailUrl, parseTableRow } from '../../lib/termInfoDigest.mjs'
import { buildTables, galleryThumbnails, isListQuestion } from '../../lib/resultTables.mjs'

const THUMB_MD = "[![MBON33 aligned to JRC2018U](http://www.virtualflybrain.org/data/VFB/i/jrmc/20bn/VFB_00101567/thumbnail.png 'MBON33 aligned')](VFB_00101567,VFB_jrmc20bn)"

test('parseThumbnailUrl extracts the PNG and upgrades http -> https', () => {
  assert.equal(parseThumbnailUrl(THUMB_MD), 'https://www.virtualflybrain.org/data/VFB/i/jrmc/20bn/VFB_00101567/thumbnail.png')
  assert.equal(parseThumbnailUrl('no image here'), '')
})

test('parseTableRow yields name/id/thumbnail/tags', () => {
  const r = parseTableRow({ id: 'VFB_jrmc20bn', label: '[MBON33(y2y3)_R](VFB_jrmc20bn)', tags: 'Nervous_system|Adult|Cholinergic', thumbnail: THUMB_MD })
  assert.equal(r.name, 'MBON33(y2y3)_R')
  assert.equal(r.id, 'VFB_jrmc20bn')
  assert.match(r.thumbnail, /^https:.*thumbnail\.png$/)
  assert.deepEqual(r.tags, ['Nervous_system', 'Adult', 'Cholinergic'])
})

function ledgerWithRows() {
  return { terms: { 'lateral horn': { id: 'FBbt_00007053', digest: { name: 'lateral horn', queries: [
    { query_type: 'ExpressionOverlapsHere', label: 'Expression patterns overlapping lateral horn', count: 1935, output_format: 'table',
      previewRows: [
        { name: 'GMR12A11', id: 'VFBexp_1', thumbnail: 'https://x/a/b/c/thumbnail.png', tags: ['Adult'] },
        { name: 'GMR20B05', id: 'VFBexp_2', thumbnail: '', tags: [] }
      ] },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in lateral horn', count: 1661, output_format: 'table',
      previewRows: [{ name: 'LHN1', id: 'VFB_n1', thumbnail: 'https://y/a/b/c/thumbnail.png', tags: [] }] }
  ] } } } }
}

test('buildTables surfaces the query matching the question, with rows + run-query link', () => {
  const tables = buildTables(ledgerWithRows(), 'What driver lines / expression patterns label the lateral horn?')
  assert.ok(tables.length >= 1)
  const t = tables[0]
  assert.match(t.title, /Expression patterns/)
  assert.equal(t.count, 1935)
  assert.match(t.queryUrl, /\?q=FBbt_00007053,ExpressionOverlapsHere/)
  assert.equal(t.rows[0].name, 'GMR12A11')
  assert.match(t.rows[0].reportUrl, /reports\/VFBexp_1/)
})

test('buildTables stays empty for a definitional question (no list intent / no overlap)', () => {
  const tables = buildTables(ledgerWithRows(), 'Where is it located')
  assert.equal(tables.length, 0)
})

test('buildTables ignores term-name words: "What is the lateral horn" gets no tables', () => {
  // Every query label repeats the term name ("… lateral horn"); a definitional
  // question must not score against those shared words and surface result tables.
  const tables = buildTables(ledgerWithRows(), 'What is the lateral horn')
  assert.equal(tables.length, 0)
})

test('buildTables still surfaces a table when the question names the query (expression)', () => {
  const tables = buildTables(ledgerWithRows(), 'Which expression patterns label the lateral horn?')
  assert.ok(tables.length >= 1)
  assert.match(tables[0].title, /Expression patterns/)
})

test('buildTables: a genetic-tools question surfaces the expression table, not neuron/image', () => {
  // "neurons" lexically matches the neuron query, but the intent is drivers — the
  // expression/transgene table must win and the neuron table must be dropped.
  const tables = buildTables(ledgerWithRows(), 'What genetic tools / GAL4 lines label mushroom body neurons?')
  assert.ok(tables.length >= 1)
  assert.match(tables[0].title, /Expression patterns/)
  assert.ok(!tables.some(t => /Neurons with some part/.test(t.title)), 'neuron list must be suppressed for a tools question')
})

test('buildTables suppresses a secondary gene (FBgn) term\'s tables alongside a non-gene subject', () => {
  const ledger = { terms: {
    'Kenyon cell': { id: 'FBbt_00003686', digest: { name: 'Kenyon cell', queries: [
      { query_type: 'SubclassesOf', label: 'Subclasses of Kenyon cell', count: 37, output_format: 'table',
        previewRows: [{ name: 'gamma KC', id: 'FBbt_1', thumbnail: '', tags: [] }] }
    ] } },
    'Dop1R1': { id: 'FBgn0011582', digest: { name: 'Dop1R1', queries: [
      { query_type: 'ClustersExpressingHere', label: 'Clusters expressing Dop1R1', count: 437, output_format: 'table',
        previewRows: [{ name: 'optic chiasma glia', id: 'FBlc_1', thumbnail: '', tags: [] }] }
    ] } }
  } }
  const tables = buildTables(ledger, 'which genes do Kenyon cells express?')
  // the gene's "clusters expressing" table is suppressed; only the subject's tables remain
  assert.ok(!tables.some(t => /Clusters expressing/i.test(t.title)), 'gene term tables suppressed')
})

test('buildTables maps input->presynaptic and output->postsynaptic for a region', () => {
  const ledger = { terms: { 'mushroom body': { id: 'FBbt_00005801', digest: { name: 'mushroom body', queries: [
    { query_type: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in mushroom body', count: 367, output_format: 'table',
      previewRows: [{ name: 'Li38', id: 'FBbt_a', thumbnail: '', tags: [] }] },
    { query_type: 'NeuronsPostsynapticHere', label: 'Neurons with postsynaptic terminals in mushroom body', count: 301, output_format: 'table',
      previewRows: [{ name: 'LT34', id: 'FBbt_b', thumbnail: '', tags: [] }] },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in mushroom body', count: 602, output_format: 'table',
      previewRows: [{ name: 'CB2311', id: 'FBbt_c', thumbnail: '', tags: [] }] }
  ] } } } }
  // "input neurons to X" -> presynaptic table is top, postsynaptic suppressed
  const inputT = buildTables(ledger, 'What are the main input neurons to the mushroom body?')
  assert.match(inputT[0].title, /presynaptic/i)
  assert.ok(!inputT.some(t => /postsynaptic/i.test(t.title)), 'postsynaptic suppressed for an input question')
  // "output neurons of X" -> postsynaptic table is top, presynaptic suppressed
  const outputT = buildTables(ledger, 'What neurons receive output from the mushroom body?')
  assert.match(outputT[0].title, /postsynaptic/i)
  assert.ok(!outputT.some(t => /presynaptic/i.test(t.title)), 'presynaptic suppressed for an output question')
})

test('isListQuestion distinguishes list/image questions from definitional ones', () => {
  assert.equal(isListQuestion('What neurons are in the lateral horn?'), true)
  assert.equal(isListQuestion('Show me images of the medulla'), true)
  assert.equal(isListQuestion('What is the adult lateral horn'), false)
  assert.equal(isListQuestion('Where is it located'), false)
})

test('galleryThumbnails collects { url, label, id } for a list question, none for a definitional one', () => {
  const expected = [
    { url: 'https://x/a/b/c/thumbnail.png', label: 'GMR12A11', id: 'VFBexp_1' },
    { url: 'https://y/a/b/c/thumbnail.png', label: 'LHN1', id: 'VFB_n1' }
  ]
  // unconditional (no question) — collects everything, each with its row name as label
  assert.deepEqual(galleryThumbnails(ledgerWithRows()), expected)
  // list/image question — collects
  assert.deepEqual(galleryThumbnails(ledgerWithRows(), 'Show me images of the lateral horn'), expected)
  // definitional question — suppressed
  assert.deepEqual(galleryThumbnails(ledgerWithRows(), 'What is the lateral horn'), [])
})
