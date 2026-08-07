// Offline unit tests for tool-call argument repair (pure logic).
// Run: node --test tests/unit/toolRepair.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMissingRequiredArgs, buildRepairMessages, mergeRepairedArgs, isEmptyArgValue, backfillIdArgs } from '../../lib/toolRepair.mjs'

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

// ---------------------------------------------------------------------------
// backfillIdArgs — look it up rather than infer it
// ---------------------------------------------------------------------------

test('backfillIdArgs: a missing id comes from the resolved term, not a model', () => {
  const { args, filled } = backfillIdArgs({}, ['id'], [{ id: 'FBbt_00003748', label: 'medulla' }])
  assert.deepEqual(filled, ['id'])
  assert.equal(args.id, 'FBbt_00003748')
})

test('backfillIdArgs: the first resolved term is the antecedent', () => {
  // Resolution order, not alphabetical or "best": on a subjectless turn the
  // orchestrator adopts the entity under discussion FIRST, so position carries
  // the meaning here.
  const { args } = backfillIdArgs({}, ['id'], [
    { id: 'FBbt_00003748', label: 'medulla' },
    { id: 'FBbt_00003852', label: 'lobula' }
  ])
  assert.equal(args.id, 'FBbt_00003748')
})

test('backfillIdArgs: never overwrites an id the step already carries', () => {
  // `missing` is what the caller found empty. An id that is present is not in it,
  // so a step targeting a specific term cannot be retargeted by this.
  const original = { id: 'FBbt_00003852', query_type: 'PartsOf' }
  const { args, filled } = backfillIdArgs(original, ['query_type'], [{ id: 'FBbt_00003748' }])
  assert.deepEqual(filled, [])
  assert.equal(args.id, 'FBbt_00003852')
})

test('backfillIdArgs: only the argument named exactly "id"', () => {
  // A dataset_id or template_id names a different KIND of thing. Filling an
  // anatomy term into one produces a call that runs, returns nothing, and reads
  // as data absence — the failure this fixes, one layer down.
  const { args, filled } = backfillIdArgs({}, ['dataset_id'], [{ id: 'FBbt_00003748' }])
  assert.deepEqual(filled, [])
  assert.deepEqual(args, {})
})

test('backfillIdArgs: nothing resolved, nothing filled', () => {
  for (const terms of [[], [{ id: null }], [{ label: 'medulla' }], [{ id: 'not-an-id' }], null]) {
    const { filled } = backfillIdArgs({}, ['id'], terms)
    assert.deepEqual(filled, [], JSON.stringify(terms))
  }
})

test('backfillIdArgs: an unresolved term is skipped, not used', () => {
  // A resolve attempt that failed leaves an entry with id null. Skipping to the
  // next one is right; using it would put `null` in a URL.
  const { args } = backfillIdArgs({}, ['id'], [{ id: null, label: 'gobbledegook' }, { id: 'FBbt_00003748' }])
  assert.equal(args.id, 'FBbt_00003748')
})

test('backfillIdArgs: the result is a copy, never a mutation', () => {
  // runStep holds `step.args` across retries; mutating it would make the second
  // attempt see arguments the plan never contained.
  const original = {}
  const { args } = backfillIdArgs(original, ['id'], [{ id: 'FBbt_00003748' }])
  assert.deepEqual(original, {})
  assert.notEqual(args, original)
})

test('backfillIdArgs: junk in, no throw', () => {
  for (const missing of [null, undefined, 'id', {}, []]) {
    assert.doesNotThrow(() => backfillIdArgs({}, missing, [{ id: 'FBbt_00003748' }]))
  }
})
