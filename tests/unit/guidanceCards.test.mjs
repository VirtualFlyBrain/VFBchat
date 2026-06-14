// Tests for the intent-scoped guidance card registry.
// Run: node --test tests/unit/guidanceCards.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectCards, plannerGuidance, synthGuidance, CARDS } from '../../lib/guidanceCards.mjs'

test('connectivity card fires for connectivity/graph questions only', () => {
  const ids = (q) => selectCards(q).map(c => c.id)
  assert.ok(ids('What does the giant fiber neuron connect to downstream? Show a graph').includes('connectivity'))
  assert.ok(ids('inputs to MBON01').includes('connectivity'))
  assert.ok(!ids('What is the mushroom body?').includes('connectivity'))
})

test('genetic-tools and taxonomy cards fire on their intents', () => {
  assert.ok(selectCards('What GAL4 lines label mushroom body neurons?').some(c => c.id === 'genetic-tools'))
  assert.ok(selectCards('What types of Kenyon cells exist?').some(c => c.id === 'taxonomy'))
  assert.ok(selectCards('What fly stocks are available for dpp?').some(c => c.id === 'stocks'))
})

test('plannerGuidance only includes matched cards, empty for a plain lookup', () => {
  const g = plannerGuidance('What does Mi1 connect to?')
  assert.match(g, /CONNECTIVITY/)
  assert.doesNotMatch(g, /TAXONOMY/)            // taxonomy card did not match
  assert.equal(plannerGuidance('What is the medulla?'), '')   // no card -> no guidance bloat
})

test('connectivity card carries the data rules ported from the skills', () => {
  const card = CARDS.find(c => c.id === 'connectivity')
  assert.match(card.planner, /weight 5/)                  // weight default
  assert.match(card.planner, /hb.*fafb|fafb/)             // dataset exclusion
  assert.match(card.planner, /between X and Y|vfb_query_connectivity/) // two-endpoint mode
  assert.match(card.planner, /MUSCLE|SENSE ORGAN|INDIVIDUAL/)         // guardrails
})

test('synthGuidance returns the graph clause only for connectivity questions', () => {
  assert.match(synthGuidance('graph of giant fiber neuron downstream'), /graph.*attached|attached.*automatically/i)
  assert.equal(synthGuidance('What is the antennal lobe?'), '')
})
