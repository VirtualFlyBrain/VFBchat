// Offline unit tests for the outbound-link sanitiser.
// Run: node --test tests/unit/outboundLinks.test.mjs
//
// The sanitiser is the last thing to touch an answer, so a false positive here
// is invisible everywhere else: the model writes a correct, allow-listed address
// and the reader is shown "[External link removed]". That is worse than a
// missing link, because the answer around it still reads as if the address were
// there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAssistantOutput } from '../../lib/policy.js'

const ALLOW = ['virtualflybrain.org', '*.virtualflybrain.org', 'doi.org']

const clean = text => sanitizeAssistantOutput(text, ALLOW)

test('an allow-listed address survives inline code', () => {
  // The failing case: an MCP service address, which is only ever written in
  // backticks because the reader is meant to copy it. The URL pattern did not
  // treat a backtick as a delimiter, so the closing one was carried into the
  // hostname and "vfb3-mcp.virtualflybrain.org`" matched nothing on the list.
  const r = clean('Point the client at `https://vfb3-mcp.virtualflybrain.org` to connect.')
  assert.equal(r.sanitizedText, 'Point the client at `https://vfb3-mcp.virtualflybrain.org` to connect.')
  assert.deepEqual(r.blockedDomains, [])
})

test('an allow-listed address survives a fenced block', () => {
  const src = '```\n{\n  "url": "https://vfb3-mcp.virtualflybrain.org"\n}\n```'
  assert.equal(clean(src).sanitizedText, src)
})

test('a host that is off the list is still removed, backticks or not', () => {
  const r = clean('Open `https://example.com/x` or https://example.com/y.')
  assert.ok(!r.sanitizedText.includes('example.com'), r.sanitizedText)
  assert.deepEqual(r.blockedDomains, ['example.com'])
})

test('trailing sentence punctuation is not part of the host', () => {
  const r = clean('See https://virtualflybrain.org/reports.')
  assert.equal(r.sanitizedText, 'See https://virtualflybrain.org/reports.')
  assert.deepEqual(r.blockedDomains, [])
})
