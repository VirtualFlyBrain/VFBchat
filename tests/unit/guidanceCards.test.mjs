// Tests for the intent-scoped guidance card registry.
// Run: node --test tests/unit/guidanceCards.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectCards, plannerGuidance, synthGuidance, classifyComplexity, CARDS } from '../../lib/guidanceCards.mjs'

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

test('extended cards fire on their battery-style intents with the right tools', () => {
  const id = (q) => selectCards(q).map(c => c.id)
  const g = (q) => plannerGuidance(q)
  assert.ok(id('Give me a comprehensive profile of the giant fiber neuron').includes('neuron-profile'))
  assert.match(g('comprehensive profile of the giant fiber neuron'), /vfb_summarize_neuron_profile/)
  assert.ok(id('Trace a pathway from olfactory receptor neurons to the lateral horn').includes('pathway'))
  assert.match(g('trace a pathway from ORNs to the lateral horn'), /vfb_find_pathway_evidence/)
  assert.ok(id('Do alpha/beta and gamma Kenyon cells converge on the same MBON types?').includes('comparison'))
  assert.match(g('compare the downstream targets of s-LNv and l-LNv'), /vfb_compare_downstream_targets/)
  assert.ok(id('Approximately how many neurons are in the adult central brain?').includes('neuron-count'))
  assert.match(g('how many neurons are in the central complex'), /vfb_get_region_neuron_count/)
  assert.ok(id('Trace the containment hierarchy from the DA1 glomerulus up to the top-level structure').includes('containment'))
  assert.ok(id('What neurotransmitter do Kenyon cells use?').includes('neurotransmitter'))
  assert.match(g('what neurotransmitter do Kenyon cells use'), /vfb_get_neurotransmitter_profile/)
})

test('neuron-count card carries synth guidance to separate annotated vs biological counts', () => {
  const s = synthGuidance('Approximately how many neurons are in the adult central brain?')
  assert.match(s, /annotated|not the biological total/i)
  // not injected for unrelated questions
  assert.equal(synthGuidance('What is the central complex?'), '')
})

test('scrnaseq card fires for gene/receptor-expression questions', () => {
  assert.ok(selectCards('which dopamine receptor genes do Kenyon cells express?').some(c => c.id === 'scrnaseq'))
  assert.ok(selectCards('single-cell transcriptomic profile of MBONs').some(c => c.id === 'scrnaseq'))
  assert.match(plannerGuidance('what genes do Kenyon cells express'), /vfb_scrnaseq_gene_expression/)
  // a driver-line question should not be treated as a gene-expression question
  assert.ok(!selectCards('what GAL4 driver lines label the mushroom body?').some(c => c.id === 'scrnaseq'))
})

test('classifyComplexity scales effort: simple < standard < complex', () => {
  // simple definitional lookup -> one planner vote, shallow budget
  const simple = classifyComplexity('What is the mushroom body?')
  assert.equal(simple.tier, 'simple')
  assert.equal(simple.plannerVotes, 1)
  // standard single-tool intent
  const standard = classifyComplexity('What GAL4 driver lines label the mushroom body?')
  assert.equal(standard.tier, 'standard')
  assert.equal(standard.plannerVotes, 2)
  // complex: connectivity / scRNAseq / comparison / pathway / count
  for (const q of [
    'What does the giant fiber neuron connect to downstream?',
    'which dopamine receptor genes do Kenyon cells express?',
    'how many neurons are in the central brain?',
    'trace a pathway from ORNs to the lateral horn',
    'compare the downstream targets of s-LNv and l-LNv'
  ]) {
    const c = classifyComplexity(q)
    assert.equal(c.tier, 'complex', `expected complex for: ${q}`)
    assert.equal(c.plannerVotes, 3)
    assert.equal(c.maxToolRounds, 24)
  }
})

test('cards do not over-fire on a plain definitional question', () => {
  assert.deepEqual(selectCards('What is the mushroom body?').map(c => c.id), [])
  assert.deepEqual(selectCards('Where is the medulla located?').map(c => c.id), [])
})

test('similarity card fires for morphology questions, not for homology', () => {
  const ids = (q) => selectCards(q).map(c => c.id)
  for (const q of [
    'What neurons are similar to LPLC2?',
    'NBLAST matches for LPLC2',
    'Which cell types are morphologically similar to LPLC2?',
    'What does LPLC2 most closely resemble?'
  ]) assert.ok(ids(q).includes('similarity'), q)
  // "the larval equivalent of X" is homology; NBLAST does not answer it.
  assert.ok(!ids('What is the larval equivalent of LPLC2?').includes('similarity'))
  assert.ok(!ids('What is the mushroom body?').includes('similarity'))
})

test('similarity synth guidance demands the self-class figure first', () => {
  // Dropping it inverts the answer: LPLC2's own neurons are both the most common
  // and the highest-scoring neighbours, so a list of OTHER types read alone says
  // "LPLC2 most resembles VPNd1", which the data does not say.
  const g = synthGuidance('What neurons are similar to LPLC2?')
  assert.match(g, /same cell type/)
  assert.match(g, /per registered neuron/)
})
