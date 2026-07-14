// Offline unit tests for the ELM client request shaping (mocked fetch).
// Run: node --test tests/unit/elmClient.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callStructured } from '../../lib/elmClient.mjs'

function mockFetch(content, capture) {
  return async (url, opts) => {
    if (capture) { capture.url = url; capture.body = JSON.parse(opts.body) }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] })
    }
  }
}

const SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }

test('callStructured: strict json_schema by default', async () => {
  const cap = {}
  const r = await callStructured({
    baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }], schema: SCHEMA, schemaName: 'args',
    fetchImpl: mockFetch('{"id":"FBbt_1"}', cap)
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { id: 'FBbt_1' })
  assert.equal(cap.body.response_format.type, 'json_schema')
  assert.equal(cap.body.response_format.json_schema.strict, true)
  assert.equal(cap.body.guided_json, undefined)
})

test('callStructured: guided_json mode uses json_object + guided_json', async () => {
  const cap = {}
  const r = await callStructured({
    baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }], schema: SCHEMA, useGuidedJson: true,
    fetchImpl: mockFetch('{"id":"FBbt_2"}', cap)
  })
  assert.equal(r.ok, true)
  assert.equal(cap.body.response_format.type, 'json_object')
  assert.deepEqual(cap.body.guided_json, SCHEMA)
})

test('callStructured: retries then fails on non-conformant output', async () => {
  const r = await callStructured({
    baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }], schema: SCHEMA, maxAttempts: 2,
    fetchImpl: mockFetch('{"wrong":1}')
  })
  assert.equal(r.ok, false)
  assert.equal(r.attempts, 2)
})

test('callStructured: recovers JSON embedded in prose', async () => {
  const r = await callStructured({
    baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'go' }], schema: SCHEMA,
    fetchImpl: mockFetch('Here you go: {"id":"FBbt_3"} done')
  })
  assert.equal(r.ok, true)
  assert.equal(r.value.id, 'FBbt_3')
})

test('callStructured: missing required inputs returns error, no throw', async () => {
  const r = await callStructured({ baseUrl: '', apiKey: '', model: '', messages: null, schema: null })
  assert.equal(r.ok, false)
  assert.match(r.error, /required/)
})
