// Offline unit tests for tool-call argument repair (pure logic).
// Run: node --test tests/unit/toolRepair.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMissingRequiredArgs, buildRepairMessages, mergeRepairedArgs, isEmptyArgValue } from '../../lib/toolRepair.mjs'

const PARAMS = new Map([
  ['vfb_get_term_info', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }],
  ['vfb_run_query', { type: 'object', properties: { id: { type: 'string' }, query_type: { type: 'string' } }, required: ['id', 'query_type'] }],
  ['vfb_search_terms', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }]
])

test('isEmptyArgValue', () => {
  for (const v of [undefined, null, '', '   ', []]) assert.equal(isEmptyArgValue(v), true)
  for (const v of ['x', 0, false, ['a'], { a: 1 }]) assert.equal(isEmptyArgValue(v), false)
})

test('getMissingRequiredArgs: empty call reports all required', () => {
  assert.deepEqual(getMissingRequiredArgs({ name: 'vfb_get_term_info', arguments: {} }, PARAMS), ['id'])
  assert.deepEqual(getMissingRequiredArgs({ name: 'vfb_run_query', arguments: {} }, PARAMS), ['id', 'query_type'])
})

test('getMissingRequiredArgs: partial call reports the gap', () => {
  assert.deepEqual(getMissingRequiredArgs({ name: 'vfb_run_query', arguments: { id: 'FBbt_1' } }, PARAMS), ['query_type'])
})

test('getMissingRequiredArgs: complete call reports none', () => {
  assert.deepEqual(getMissingRequiredArgs({ name: 'vfb_get_term_info', arguments: { id: 'FBbt_1' } }, PARAMS), [])
})

test('getMissingRequiredArgs: empty string counts as missing', () => {
  assert.deepEqual(getMissingRequiredArgs({ name: 'vfb_search_terms', arguments: { query: '  ' } }, PARAMS), ['query'])
})

test('getMissingRequiredArgs: unknown tool → none (no schema)', () => {
  assert.deepEqual(getMissingRequiredArgs({ name: 'unknown', arguments: {} }, PARAMS), [])
})

test('getMissingRequiredArgs: works with plain object map too', () => {
  const obj = { vfb_get_term_info: { required: ['id'] } }
  assert.deepEqual(getMissingRequiredArgs({ name: 'vfb_get_term_info', arguments: {} }, obj), ['id'])
})

test('buildRepairMessages: includes tool, schema, question, evidence', () => {
  const m = buildRepairMessages({
    toolCall: { name: 'vfb_get_term_info', arguments: {} },
    params: PARAMS.get('vfb_get_term_info'),
    userQuestion: 'What is the mushroom body?',
    evidenceContext: 'mushroom body = FBbt_00005801'
  })
  assert.equal(m.length, 2)
  assert.match(m[0].content, /vfb_get_term_info/)
  assert.match(m[1].content, /What is the mushroom body\?/)
  assert.match(m[1].content, /FBbt_00005801/)
  assert.match(m[1].content, /PARAMETER SCHEMA/)
})

test('buildRepairMessages: instructs name-for-region, id-only-from-evidence', () => {
  const m = buildRepairMessages({
    toolCall: { name: 'vfb_summarize_region_connections', arguments: {} },
    params: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
    userQuestion: 'What regions does the antennal lobe connect to?'
  })
  assert.match(m[0].content, /natural-language term/)
  assert.match(m[0].content, /never invent ids/)
})

test('mergeRepairedArgs: non-empty repaired values win, empties ignored', () => {
  assert.deepEqual(mergeRepairedArgs({ id: '' }, { id: 'FBbt_1' }), { id: 'FBbt_1' })
  assert.deepEqual(mergeRepairedArgs({ id: 'X', rows: 10 }, { id: '' }), { id: 'X', rows: 10 })
  assert.deepEqual(mergeRepairedArgs({}, { id: 'A', query_type: 'B' }), { id: 'A', query_type: 'B' })
})
