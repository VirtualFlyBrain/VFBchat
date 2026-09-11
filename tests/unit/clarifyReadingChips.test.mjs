// When the resolver asks which of several exact readings a name meant, the
// readings are offered as chips that re-ask the question about exactly that
// term. No model, no network.
//
// Run: node --test tests/unit/clarifyReadingChips.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clarifyReadingChips } from '../../app/api/chat/route.js'

const OPTIONS = [
  { name: 'KCg', id: 'FBbt_00049828', label: 'adult gamma Kenyon cell' },
  { name: 'KCg', id: 'FBbt_00100247', label: 'gamma Kenyon cell' }
]

test('each reading becomes a chip that re-asks the question with the label in place of the name', () => {
  const chips = clarifyReadingChips('what cell types are downstream of KCg?', OPTIONS)
  assert.deepEqual(chips.map(c => c.kind), ['ask', 'ask'])
  assert.deepEqual(chips.map(c => c.label), ['adult gamma Kenyon cell', 'gamma Kenyon cell'])
  assert.deepEqual(chips.map(c => c.query), [
    'what cell types are downstream of adult gamma Kenyon cell?',
    'what cell types are downstream of gamma Kenyon cell?'
  ])
})

test('the name is replaced as a whole word only; a paraphrased question gets the label appended', () => {
  const chips = clarifyReadingChips('what is downstream of KCg-d?', OPTIONS)
  assert.equal(chips[0].query, 'what is downstream of KCg-d? (I mean adult gamma Kenyon cell)')
  assert.equal(clarifyReadingChips('', OPTIONS)[1].query, 'gamma Kenyon cell')
})

test('duplicates and empties are dropped; nothing without options', () => {
  assert.equal(clarifyReadingChips('q', [...OPTIONS, OPTIONS[0], { label: '' }]).length, 2)
  assert.deepEqual(clarifyReadingChips('q', undefined), [])
})
