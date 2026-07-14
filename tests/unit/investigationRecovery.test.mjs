// Offline unit tests for investigation-mode recovery (pure logic).
// Run: node --test tests/unit/investigationRecovery.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInvestigationOutput, extractInvestigationCandidates, buildInvestigationDirective } from '../../lib/investigationRecovery.mjs'

test('isInvestigationOutput: detects both flags', () => {
  assert.equal(isInvestigationOutput({ requires_user_selection: true }), true)
  assert.equal(isInvestigationOutput({ investigation_mode: true }), true)
  assert.equal(isInvestigationOutput({ foo: 1 }), false)
  assert.equal(isInvestigationOutput(null), false)
})

test('extractInvestigationCandidates: from candidate_classes', () => {
  const parsed = { candidate_classes: [{ label: 'Kenyon cell', id: 'FBbt_00003686' }, { name: 'PN', short_form: 'FBbt_1' }] }
  assert.deepEqual(extractInvestigationCandidates(parsed), ['Kenyon cell FBbt_00003686', 'PN FBbt_1'])
})

test('extractInvestigationCandidates: from selections_needed[].candidates, deduped + capped', () => {
  const parsed = {
    selections_needed: [
      { candidates: [{ label: 'A', id: 'x1' }, { label: 'A', id: 'x1' }] },
      { candidates: [{ label: 'B', id: 'x2' }] }
    ]
  }
  assert.deepEqual(extractInvestigationCandidates(parsed), ['A x1', 'B x2'])
  const many = { candidates: Array.from({ length: 20 }, (_, i) => ({ label: 'n' + i, id: 'i' + i })) }
  assert.equal(extractInvestigationCandidates(many, 5).length, 5)
})

test('extractInvestigationCandidates: empty when none', () => {
  assert.deepEqual(extractInvestigationCandidates({}), [])
})

test('buildInvestigationDirective: carries directive, candidates, focus', () => {
  const parsed = {
    investigation_mode: true,
    candidate_classes: [{ label: 'MBON', id: 'FBbt_9' }],
    focus_region: { id: 'FBbt_00003924', name: 'antennal lobe', description: 'deutocerebral neuropil' }
  }
  const d = buildInvestigationDirective(parsed)
  assert.equal(d.investigation_mode, true)
  assert.match(d.answer_now_directive, /Do NOT call more tools/)
  assert.deepEqual(d.candidate_neuron_classes, ['MBON FBbt_9'])
  assert.equal(d.focus.name, 'antennal lobe')
})
