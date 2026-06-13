// Tests for result tables + thumbnail parsing.
// Run: node --test tests/unit/resultTables.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseThumbnailUrl, parseTableRow } from '../../lib/termInfoDigest.mjs'
import { buildTables, galleryThumbnails } from '../../lib/resultTables.mjs'

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

test('galleryThumbnails collects unique row thumbnails', () => {
  const urls = galleryThumbnails(ledgerWithRows())
  assert.deepEqual(urls, ['https://x/a/b/c/thumbnail.png', 'https://y/a/b/c/thumbnail.png'])
})
