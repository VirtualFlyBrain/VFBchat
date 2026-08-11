import test from 'node:test'
import assert from 'node:assert/strict'
import { stripSpeciesWords, nameVariants } from '../../lib/orchestrator.mjs'

// The reviewer's question. Searching VFB for "fly brain" returns documents that
// are essentially all "… on JRC_FlyEM_Hemibrain" individuals — FlyEM carries
// "fly", Hemibrain carries "brain" — and the `brain` class is absent from the
// result set. Searching "brain" returns FBbt_00005095 at rank one.
test('strips the species word that hijacks the search', () => {
  assert.equal(stripSpeciesWords('fly brain'), 'brain')
  assert.equal(stripSpeciesWords('fruit fly brain'), 'brain')
  assert.equal(stripSpeciesWords('Drosophila brain'), 'brain')
  assert.equal(stripSpeciesWords('adult Drosophila central brain'), 'adult central brain')
  assert.equal(stripSpeciesWords('flies brain'), 'brain')
})

test('costs nothing for a name with no species word', () => {
  assert.equal(stripSpeciesWords('mushroom body'), '')
  assert.equal(stripSpeciesWords('gamma Kenyon cell'), '')
  assert.equal(stripSpeciesWords(''), '')
})

test('never strips a name down to nothing', () => {
  // "fly" alone is not a request for the empty string.
  assert.equal(stripSpeciesWords('fly'), '')
  assert.equal(stripSpeciesWords('Drosophila'), '')
})

test('punctuation does not hide a species word', () => {
  assert.equal(stripSpeciesWords('fly, brain'), 'brain')
})

test('the de-specied form is the FIRST variant tried', () => {
  // Ordering is load-bearing: every later rung is wasted while the hijacking
  // word is still in the string.
  const variants = nameVariants('fly brains')
  assert.ok(variants.length > 0)
  assert.equal(variants[0], 'brains')
  assert.ok(variants.includes('brain'))
})

test('a name with no species word is unaffected by the new rung', () => {
  assert.deepEqual(nameVariants('mushroom body'), [])
})
