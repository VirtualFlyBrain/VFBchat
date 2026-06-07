// Offline unit tests for the structured-output foundation.
// Run: node --test tests/unit/structuredOutput.test.mjs
// No network required.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRoleModel,
  buildSchemaResponseFormat,
  extractFirstJson,
  validateAgainstSchema,
  majorityVote,
  canonicalKey,
  __DEFAULT_MODEL
} from '../../lib/structuredOutput.mjs'

test('resolveRoleModel: role override wins', () => {
  const env = { VFB_MODEL_PLANNER: 'GPT 5.4', ELM_MODEL: 'Llama 3.3' }
  assert.equal(resolveRoleModel('planner', env), 'GPT 5.4')
})

test('resolveRoleModel: falls back through default then ELM_MODEL', () => {
  assert.equal(resolveRoleModel('extract', { VFB_MODEL_DEFAULT: 'EuroLLM' }), 'EuroLLM')
  assert.equal(resolveRoleModel('extract', { ELM_MODEL: 'Llama 3.3' }), 'Llama 3.3')
})

test('resolveRoleModel: hard default when nothing set', () => {
  assert.equal(resolveRoleModel('synth', {}), __DEFAULT_MODEL)
})

test('buildSchemaResponseFormat: strict json_schema shape', () => {
  const rf = buildSchemaResponseFormat('plan', { type: 'object' })
  assert.deepEqual(rf, { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: { type: 'object' } } })
  assert.throws(() => buildSchemaResponseFormat('', {}))
})

test('extractFirstJson: direct parse', () => {
  assert.deepEqual(extractFirstJson('{"a":1}'), { a: 1 })
})

test('extractFirstJson: strips ```json fence', () => {
  assert.deepEqual(extractFirstJson('```json\n{"a":2}\n```'), { a: 2 })
})

test('extractFirstJson: pulls object from surrounding prose', () => {
  const txt = 'Sure! Here is the result: {"name":"DA1","weight":42} — hope that helps.'
  assert.deepEqual(extractFirstJson(txt), { name: 'DA1', weight: 42 })
})

test('extractFirstJson: brace inside string does not break balance', () => {
  assert.deepEqual(extractFirstJson('{"note":"a } brace"}'), { note: 'a } brace' })
})

test('extractFirstJson: arrays', () => {
  assert.deepEqual(extractFirstJson('prefix [1,2,3] suffix'), [1, 2, 3])
})

test('extractFirstJson: returns undefined on garbage', () => {
  assert.equal(extractFirstJson('no json here'), undefined)
})

test('validateAgainstSchema: required + additionalProperties false', () => {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { capital: { type: 'string' }, pop: { type: 'number' } },
    required: ['capital', 'pop']
  }
  assert.equal(validateAgainstSchema({ capital: 'Paris', pop: 11 }, schema).valid, true)
  assert.equal(validateAgainstSchema({ capital: 'Paris' }, schema).valid, false) // missing
  assert.equal(validateAgainstSchema({ capital: 'Paris', pop: 11, x: 1 }, schema).valid, false) // extra
  assert.equal(validateAgainstSchema({ capital: 5, pop: 11 }, schema).valid, false) // wrong type
})

test('validateAgainstSchema: integer vs number', () => {
  assert.equal(validateAgainstSchema(3, { type: 'integer' }).valid, true)
  assert.equal(validateAgainstSchema(3.5, { type: 'integer' }).valid, false)
  assert.equal(validateAgainstSchema(3.5, { type: 'number' }).valid, true)
})

test('validateAgainstSchema: enum', () => {
  const s = { enum: ['answered', 'partial', 'not_answered'] }
  assert.equal(validateAgainstSchema('partial', s).valid, true)
  assert.equal(validateAgainstSchema('maybe', s).valid, false)
})

test('validateAgainstSchema: nested array items', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['rows'],
    properties: {
      rows: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } } }
    }
  }
  assert.equal(validateAgainstSchema({ rows: [{ id: 'a' }, { id: 'b' }] }, schema).valid, true)
  assert.equal(validateAgainstSchema({ rows: [{ id: 1 }] }, schema).valid, false)
})

test('validateAgainstSchema: oneOf', () => {
  const s = { oneOf: [{ type: 'string' }, { type: 'number' }] }
  assert.equal(validateAgainstSchema('x', s).valid, true)
  assert.equal(validateAgainstSchema(5, s).valid, true)
  assert.equal(validateAgainstSchema(true, s).valid, false)
})

test('majorityVote: picks the most common value', () => {
  const v = majorityVote([{ a: 1 }, { a: 1 }, { a: 2 }])
  assert.deepEqual(v.value, { a: 1 })
  assert.equal(v.count, 2)
  assert.equal(v.total, 3)
  assert.ok(Math.abs(v.agreement - 2 / 3) < 1e-9)
})

test('majorityVote: key order does not matter', () => {
  const v = majorityVote([{ a: 1, b: 2 }, { b: 2, a: 1 }])
  assert.equal(v.count, 2)
})

test('majorityVote: empty input', () => {
  assert.deepEqual(majorityVote([]), { value: undefined, count: 0, total: 0, agreement: 0 })
})

test('canonicalKey: stable across key order', () => {
  assert.equal(canonicalKey({ a: 1, b: [3, { y: 1, x: 2 }] }), canonicalKey({ b: [3, { x: 2, y: 1 }], a: 1 }))
})
