// Tests for the answer-grounding guard.
// Run: node --test tests/unit/grounding.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLeakedIds, stripLeakedIds, collectGroundedNumbers, findUngroundedNumbers } from '../../lib/grounding.mjs'

test('findLeakedIds detects ontology ids written into prose', () => {
  assert.deepEqual(findLeakedIds('the mushroom body (FBbt_00005801) and Dop1R1 FBgn0011582'), ['FBbt_00005801', 'FBgn0011582'])
  assert.deepEqual(findLeakedIds('no ids here'), [])
})

test('stripLeakedIds removes ids (and trailing parens) so labels can be re-linked', () => {
  assert.equal(stripLeakedIds('the mushroom body (FBbt_00005801) is a neuropil'), 'the mushroom body is a neuropil')
  assert.equal(stripLeakedIds('Kenyon cell FBbt_00003686 expresses Dop1R1'), 'Kenyon cell expresses Dop1R1')
  // leaves ordinary text and small numbers untouched
  assert.equal(stripLeakedIds('there are about 2 lobes'), 'there are about 2 lobes')
})

test('collectGroundedNumbers walks nested tool data for numbers', () => {
  const g = collectGroundedNumbers(
    { queries: [{ count: 9413 }, { count: 462 }] },
    [{ level: '1200.5' }, { weight: 2553 }]
  )
  assert.ok(g.includes(9413) && g.includes(462) && g.includes(1200.5) && g.includes(2553))
})

test('findUngroundedNumbers flags invented counts but allows grounded and rounded values', () => {
  const grounded = [9413, 1200.5]
  // 139255 is not in evidence -> flagged
  assert.deepEqual(findUngroundedNumbers('the brain has 139,255 neurons; VFB annotates 9413', grounded), [139255])
  // rounded grounded value passes (1200.5 -> 1,201)
  assert.deepEqual(findUngroundedNumbers('Dop1R1 at 1,201', grounded), [])
  // small numbers (years, counts < 1000) are never flagged
  assert.deepEqual(findUngroundedNumbers('in 2020 there were 37 subtypes', grounded), [])
})
