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

// --- structured URLs -------------------------------------------------------
//
// The prose sanitiser above reads text. Image thumbnails and result-row links
// arrive as structured tool DATA, never appear in prose, and used to reach the
// reader's browser as <img src> without meeting this list at all.

import { filterStructuredImages, scrubStructuredTables, isAllowedStructuredUrl } from '../../lib/policy.js'

const vfbThumb = 'https://www.virtualflybrain.org/data/VFB/i/0010/14uq/VFB_00110000/thumbnail.png'

test('an allow-listed thumbnail passes untouched', () => {
  const r = filterStructuredImages([{ id: 'VFB_00110000', thumbnail: vfbThumb, label: 'brain' }], ALLOW)
  assert.equal(r.images.length, 1)
  assert.deepEqual(r.blockedDomains, [])
})

test('a thumbnail from an unapproved host never reaches the browser', () => {
  const r = filterStructuredImages([
    { id: 'a', thumbnail: vfbThumb },
    { id: 'b', thumbnail: 'https://evil.example/track.png' }
  ], ALLOW)
  assert.deepEqual(r.images.map(i => i.id), ['a'])
  assert.deepEqual(r.blockedDomains, ['evil.example'])
})

test('an image is dropped whole when any one of its addresses is off the list', () => {
  // An allowed thumbnail beside an off-list mesh is still a channel to that host.
  const r = filterStructuredImages([
    { id: 'a', thumbnail: vfbThumb, obj: 'https://evil.example/volume_man.obj' }
  ], ALLOW)
  assert.deepEqual(r.images, [])
  assert.deepEqual(r.blockedDomains, ['evil.example'])
})

test('only http(s) and same-origin paths are structured URLs at all', () => {
  assert.equal(isAllowedStructuredUrl('/data/VFB/i/x/thumbnail.png', ALLOW), true)
  assert.equal(isAllowedStructuredUrl('', ALLOW), true)
  assert.equal(isAllowedStructuredUrl(vfbThumb, ALLOW), true)
  // A thumbnail field has one legitimate shape, so these get no benefit of the doubt.
  assert.equal(isAllowedStructuredUrl('//evil.example/x.png', ALLOW), false)
  assert.equal(isAllowedStructuredUrl('javascript:alert(1)', ALLOW), false)
  assert.equal(isAllowedStructuredUrl('data:image/png;base64,AAAA', ALLOW), false)
  assert.equal(isAllowedStructuredUrl('http://evil.example/x.png', ALLOW), false)
})

test('a subdomain of an allow-listed wildcard is fine', () => {
  assert.equal(isAllowedStructuredUrl('https://vfb3-mcp.virtualflybrain.org/x.png', ALLOW), true)
})

test('a bad row thumbnail loses the field, not the row', () => {
  // The row is mostly not a URL: it is the name and id that answer the question.
  const { tables, blockedDomains } = scrubStructuredTables([{
    title: 'Neurons with some part in brain',
    rows: [
      { name: 'KCg', id: 'FBbt_1', reportUrl: 'https://virtualflybrain.org/reports/FBbt_1', thumbnail: vfbThumb },
      { name: 'KCab', id: 'FBbt_2', reportUrl: 'https://evil.example/r', thumbnail: 'https://evil.example/t.png' }
    ]
  }], ALLOW)
  assert.deepEqual(tables[0].rows.map(r => r.name), ['KCg', 'KCab'], 'no evidence is deleted to enforce a link policy')
  assert.equal(tables[0].rows[1].reportUrl, undefined)
  assert.equal(tables[0].rows[1].thumbnail, undefined)
  assert.equal(tables[0].rows[0].thumbnail, vfbThumb)
  assert.deepEqual(blockedDomains, ['evil.example'])
})

test('tables and images with nothing to block are returned unchanged', () => {
  const tables = [{ title: 't', rows: [{ name: 'x', id: 'y', thumbnail: vfbThumb }] }]
  const r = scrubStructuredTables(tables, ALLOW)
  assert.deepEqual(r.blockedDomains, [])
  assert.equal(r.tables[0].rows[0], tables[0].rows[0], 'an untouched row is the same object')
})

test('junk in the images list is skipped rather than crashing the answer', () => {
  const r = filterStructuredImages([null, 'not an object', undefined, { id: 'a', thumbnail: vfbThumb }], ALLOW)
  assert.deepEqual(r.images.map(i => i.id), ['a'])
  assert.deepEqual(scrubStructuredTables(null, ALLOW).tables, [])
})
