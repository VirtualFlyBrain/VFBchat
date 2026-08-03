// Tests for the query-type semantics map.
// Run: node --test tests/unit/queryTypes.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { querySemantics, isIndividualImageQuery, queryTypeTag, QUERY_SEMANTICS, isAboutVfbItself } from '../../lib/queryTypes.mjs'

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

test('queryTypeTag types a query: kind + count meaning (+ use when defined)', () => {
  const img = queryTypeTag('ImagesNeurons')
  assert.match(img, /^ImagesNeurons — individual images; count = images of neurons; use for /)
  const cls = queryTypeTag('PartsOf')
  assert.match(cls, /^PartsOf — ontology classes; thumbnails are examples; count = subparts/)
  // unknown types still tag safely
  assert.match(queryTypeTag('Mystery'), /^Mystery — results; count = results$/)
})

// ---- isAboutVfbItself ----
//
// A failed name lookup should only ever become the answer when the question
// named something to look up. "What do confidence values mean on Virtual Fly
// Brain?" and "When did predicted neurotransmitters for EM data become
// available on VFB?" both came back as nothing but "the name could not be
// matched to a VFB term ... try rephrasing your query".

test('isAboutVfbItself: true for questions about VFB itself', () => {
  for (const q of [
    'What do confidence values mean on Virtual Fly Brain?',
    'When did predicted neurotransmitters for EM data become available on VFB?',
    'Since when has the FlyWire data been available on VFB?',
    'Who funds Virtual Fly Brain and since when?',
    "What is Virtual Fly Brain's accessibility statement?"
  ]) assert.equal(isAboutVfbItself(q), true, q)
})

test('isAboutVfbItself: false when the question names an entity to resolve', () => {
  // These MUST stay false: if the name fails to resolve here, the reader does
  // need to be asked which one was meant.
  for (const q of [
    'How do I find the downstream partners of DA1 lPN in VFB?',
    'Show me the Kenyon cells on Virtual Fly Brain',
    'Where can I access the FAFB CATMAID dataset via Virtual Fly Brain?',
    'What neurotransmitter do Kenyon cells use?',
    'What does the mushroom body do?',
    ''
  ]) assert.equal(isAboutVfbItself(q), false, q)
})

test('isAboutVfbItself: requires VFB to be the subject', () => {
  // The same grammar about something else is not a question about VFB.
  assert.equal(isAboutVfbItself('When did the hemibrain connectome become available?'), false)
  assert.equal(isAboutVfbItself('What do confidence values mean?'), false)
})
