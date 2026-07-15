// Tests for the query-type semantics map.
// Run: node --test tests/unit/queryTypes.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { querySemantics, isIndividualImageQuery, QUERY_SEMANTICS } from '../../lib/queryTypes.mjs'

test('individual-image queries are classified as image queries (count = images)', () => {
  for (const qt of ['ImagesNeurons', 'ListAllAvailableImages', 'AllAlignedImages']) {
    assert.equal(isIndividualImageQuery(qt), true, qt)
    assert.match(querySemantics(qt).countNoun, /image/)
  }
})

test('class-list queries are NOT image queries, with class count nouns', () => {
  assert.equal(isIndividualImageQuery('NeuronsPartHere'), false)
  assert.equal(querySemantics('NeuronsPartHere').countNoun, 'neuron types')
  assert.equal(isIndividualImageQuery('PartsOf'), false)
  assert.equal(querySemantics('PartsOf').countNoun, 'subparts')
  assert.equal(querySemantics('SubclassesOf').countNoun, 'subclasses')
})

test('unknown query types get a safe default (not an image query)', () => {
  const s = querySemantics('SomethingNew')
  assert.equal(s.kind, 'other')
  assert.equal(s.countNoun, 'results')
  assert.equal(isIndividualImageQuery('SomethingNew'), false)
})

test('every entry has a kind and a countNoun', () => {
  for (const [qt, s] of Object.entries(QUERY_SEMANTICS)) {
    assert.ok(s.kind, `${qt} missing kind`)
    assert.ok(s.countNoun, `${qt} missing countNoun`)
  }
})
