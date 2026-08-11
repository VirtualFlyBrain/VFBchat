import test from 'node:test'
import assert from 'node:assert/strict'
import {
  curatedData, matchRegionKey, curatedCountsForRegion, curatedNoteForRegion, curatedAnswerRules
} from '../../lib/curatedNeuronCounts.mjs'
import { renderNeuronCountEstimate } from '../../lib/neuronCount.mjs'

test('the curated data file loads and every figure carries provenance', () => {
  const d = curatedData()
  assert.ok(d, 'config/fly-neuron-counts.json must be readable')
  for (const c of d.connectomes) {
    if (c.neurons == null) continue
    assert.ok(c.citation, `${c.key} needs a citation`)
    assert.ok(c.specimen?.sex && c.specimen?.stage, `${c.key} needs sex and stage`)
    assert.ok(c.scope && c.scope.length > 20, `${c.key} needs a real scope statement`)
    assert.equal(typeof c.verified, 'boolean', `${c.key} needs a verified flag`)
  }
})

test('longest region key wins, so central brain is not answered as whole brain', () => {
  assert.equal(matchRegionKey('adult central brain'), 'adult central brain')
  assert.equal(matchRegionKey('adult brain'), 'adult brain')
  assert.equal(matchRegionKey('brain'), 'brain')
})

test('a region with no curated entry yields nothing rather than something', () => {
  assert.equal(matchRegionKey('mushroom body'), null)
  assert.deepEqual(curatedCountsForRegion('mushroom body'), [])
  assert.deepEqual(curatedCountsForRegion(''), [])
})

test('containment is whole-word, so brain does not capture forebrain', () => {
  assert.equal(matchRegionKey('forebrain'), null)
})

test('the whole adult brain resolves to FlyWire with its qualifiers attached', () => {
  const [c, ...rest] = curatedCountsForRegion('adult brain')
  assert.equal(rest.length, 0)
  assert.equal(c.count_numeric, 139255)
  assert.equal(c.source_pmid, '39358518')
  assert.match(c.scope, /female/)
  assert.match(c.scope, /v783/)
  // The thing that made the old hint wrong was a number with no scope on it.
  assert.match(c.scope, /optic lobes/i)
})

test('the central brain uses the fully-contained subcount, not the whole brain', () => {
  const [c] = curatedCountsForRegion('adult central brain')
  assert.equal(c.count_numeric, 32388)
  assert.match(c.scope, /Subcount/)
  assert.match(curatedNoteForRegion('adult central brain'), /lower bound/)
})

test('the whole CNS offers both one-animal datasets, not a sum', () => {
  const cs = curatedCountsForRegion('adult central nervous system')
  assert.equal(cs.length, 2)
  const ns = cs.map(c => c.count_numeric).sort((a, b) => a - b)
  assert.deepEqual(ns, [155916, 166691])
})

test('a preprint figure says so in its scope', () => {
  const cs = curatedCountsForRegion('adult central nervous system')
  const male = cs.find(c => c.count_numeric === 166691)
  assert.match(male.scope, /Preprint/)
})

test('the renderer produces a cited block from curated candidates', () => {
  const out = renderNeuronCountEstimate(
    { count_candidates: curatedCountsForRegion('adult brain') },
    'adult brain'
  )
  assert.match(out, /139,255/)
  assert.match(out, /PMID 39358518/)
  assert.match(out, /Dorkenwald/)
})

// The specific defect this replaced: Shiu et al. is a computational model paper
// whose "central brain" figure is FlyWire's whole-brain count, quoted in its
// introduction. Nothing curated may cite it, and no remembered number may appear.
test('the retired miscitation cannot come back', () => {
  const d = curatedData()
  // It may — and should — appear in known_miscitations. It must not appear as
  // the source of any figure.
  assert.ok(d.known_miscitations.some(m => /39358519/.test(m.cited_to)),
    'the miscitation should stay documented so it is not reintroduced')
  for (const c of d.connectomes) {
    assert.notEqual(c.pmid, '39358519', `${c.key} must not cite the model paper`)
  }
  for (const e of d.non_connectome_estimates || []) {
    assert.ok(!/39358519/.test(JSON.stringify(e)))
  }
  for (const region of ['brain', 'adult brain', 'central brain', 'adult central brain']) {
    for (const c of curatedCountsForRegion(region)) {
      assert.notEqual(c.count_numeric, 125000)
      assert.ok(c.source_pmid !== '39358519')
    }
  }
})

test('answer rules travel with the data', () => {
  const rules = curatedAnswerRules()
  assert.ok(rules.length >= 5)
  assert.ok(rules.some(r => /no single species-level neuron count/i.test(r)))
})
