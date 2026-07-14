// Offline unit tests for the schema-constrained tool relay.
// Run: node --test tests/unit/toolRelay.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolCallSchema, parseToolCalls } from '../../lib/toolRelay.mjs'

const TOOLS = [
  {
    name: 'vfb_search_terms',
    parameters: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string' }, rows: { type: 'integer' } }
    }
  },
  {
    name: 'vfb_get_term_info',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string' } }
    }
  }
]

test('buildToolCallSchema: envelope with oneOf over tools', () => {
  const s = buildToolCallSchema(TOOLS)
  assert.equal(s.type, 'object')
  assert.deepEqual(s.required, ['tool_calls'])
  assert.ok(Array.isArray(s.properties.tool_calls.items.oneOf))
  assert.equal(s.properties.tool_calls.items.oneOf.length, 2)
})

test('buildToolCallSchema: single tool collapses oneOf', () => {
  const s = buildToolCallSchema([TOOLS[0]])
  assert.equal(s.properties.tool_calls.items.oneOf, undefined)
  assert.equal(s.properties.tool_calls.items.type, 'object')
})

test('buildToolCallSchema: throws on empty', () => {
  assert.throws(() => buildToolCallSchema([]))
})

test('parseToolCalls: valid single call', () => {
  const reply = '{"tool_calls":[{"name":"vfb_search_terms","arguments":{"query":"medulla","rows":10}}]}'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, true)
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].name, 'vfb_search_terms')
})

test('parseToolCalls: recovers JSON from surrounding prose', () => {
  const reply = 'Let me look that up.\n{"tool_calls":[{"name":"vfb_get_term_info","arguments":{"id":"FBbt_00003748"}}]}\nThanks!'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, true)
  assert.equal(r.toolCalls[0].arguments.id, 'FBbt_00003748')
})

test('parseToolCalls: rejects unknown tool', () => {
  const reply = '{"tool_calls":[{"name":"made_up_tool","arguments":{}}]}'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /unknown tool/.test(e)))
})

test('parseToolCalls: rejects bad argument type', () => {
  const reply = '{"tool_calls":[{"name":"vfb_search_terms","arguments":{"query":"x","rows":"ten"}}]}'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /rows/.test(e)))
})

test('parseToolCalls: rejects missing required arg', () => {
  const reply = '{"tool_calls":[{"name":"vfb_get_term_info","arguments":{}}]}'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /required/.test(e)))
})

test('parseToolCalls: rejects additional args', () => {
  const reply = '{"tool_calls":[{"name":"vfb_get_term_info","arguments":{"id":"X","extra":1}}]}'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /additional property/.test(e)))
})

test('parseToolCalls: multiple calls', () => {
  const reply = JSON.stringify({ tool_calls: [
    { name: 'vfb_search_terms', arguments: { query: 'DA1' } },
    { name: 'vfb_get_term_info', arguments: { id: 'FBbt_1' } }
  ] })
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, true)
  assert.equal(r.toolCalls.length, 2)
})

test('parseToolCalls: accepts bare array form', () => {
  const reply = '[{"name":"vfb_search_terms","arguments":{"query":"x"}}]'
  const r = parseToolCalls(reply, TOOLS)
  assert.equal(r.ok, true)
})

test('parseToolCalls: no JSON at all', () => {
  const r = parseToolCalls('I cannot help with that.', TOOLS)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /no JSON/.test(e)))
})
