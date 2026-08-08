// Audit items A2 and §7.4.
//
// A2   — an allow-listed host could redirect the reviewed-docs fetcher anywhere,
//        because the allow-list was checked once, before the request, and
//        `redirect: 'follow'` then trusted whatever came back.
// §7.4 — a filename is not a domain and neither is a person's name. Treating
//        `patient.smith` as a requested domain refused the user's question AND
//        wrote a personal name into a blocked-search audit record next to their
//        IP address, which is the opposite of data minimisation.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  extractExplicitDomains, findBlockedRequestedDomains, looksLikeHostname, isAllowedHost
} from '../../lib/policy.js'

const ALLOW = ['virtualflybrain.org', '*.virtualflybrain.org', 'flybase.org', 'vfb-connect.readthedocs.io']

// ------------------------------------------------------------- §7.4 --------

test('a filename is not a requested domain', () => {
  for (const text of ['load neurons.csv', 'my file is data.json and image.png',
                      'open report.md', 'run analysis.py', 'the mesh is brain.nrrd']) {
    assert.deepEqual(extractExplicitDomains(text), [], text)
  }
})

test('a person\'s name is not a requested domain, and never reaches the audit log', () => {
  // The consequence this prevents: `patient.smith` in a blocked-search record
  // alongside the client IP.
  assert.deepEqual(extractExplicitDomains('contact patient.smith about it'), [])
  assert.deepEqual(findBlockedRequestedDomains('please look up patient.smith', ALLOW), [],
    'nothing to log means nothing to retain')
  assert.deepEqual(extractExplicitDomains('ask dr.jones'), [])
})

test('real domains are still detected, including multi-label and hyphenated ones', () => {
  assert.deepEqual(extractExplicitDomains('see virtualflybrain.org'), ['virtualflybrain.org'])
  assert.deepEqual(extractExplicitDomains('see vfb-connect.readthedocs.io'), ['vfb-connect.readthedocs.io'])
  assert.deepEqual(extractExplicitDomains('check pubmed.ncbi.nlm.nih.gov'), ['pubmed.ncbi.nlm.nih.gov'])
  assert.deepEqual(extractExplicitDomains('visit example.co.uk'), ['example.co.uk'])
})

test('an explicit scheme is taken at its word, whatever the TLD', () => {
  // The scheme is the user saying "this is a URL". Refusing to see it would let
  // an off-list host through the blocked-domain check unnoticed, which is the
  // one direction this function must never fail in.
  assert.deepEqual(extractExplicitDomains('go to https://weird.internal/x'), ['weird.internal'])
  assert.deepEqual(findBlockedRequestedDomains('please open https://evil.example.zzz/page', ALLOW),
    ['evil.example.zzz'])
})

test('looksLikeHostname draws the line where the audit said it should', () => {
  for (const yes of ['virtualflybrain.org', 'example.co.uk', 'a.io', 'x.museum']) {
    assert.equal(looksLikeHostname(yes), true, yes)
  }
  for (const no of ['neurons.csv', 'patient.smith', 'report.md', 'notes.txt', 'nodots']) {
    assert.equal(looksLikeHostname(no), false, no)
  }
})

test('an off-list domain is still refused and still audited', () => {
  // The fix must not have bought privacy by blinding the control.
  const blocked = findBlockedRequestedDomains('please search evil.com for me', ALLOW)
  assert.deepEqual(blocked, ['evil.com'])
  assert.equal(isAllowedHost('evil.com', ALLOW), false)
  assert.equal(isAllowedHost('vfb-connect.readthedocs.io', ALLOW), true)
})

// --------------------------------------------------------------- A2 --------

test('the reviewed-docs fetcher follows redirects manually and re-checks each hop', () => {
  // Asserted against the source: `fetchText` is module-private, and the property
  // that matters is structural — the allow-list must be consulted per hop, not
  // once before the request.
  const src = readFileSync(new URL('../../lib/reviewedDocsSearch.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function fetchText'), src.indexOf('async function discoverDynamicSiteEntries'))

  assert.match(fn, /redirect: 'manual'/, 'redirects must not be followed by the runtime')
  assert.match(fn, /isAllowedHost\(next\.hostname, allowList\)/, 'each hop is re-checked')
  assert.match(fn, /new URL\(location, current\)/, 'a relative Location resolves against the hop we are on')
  assert.match(fn, /MAX_REDIRECTS/, 'the redirect chain is bounded')
  assert.match(fn, /non-HTTP scheme/, 'a redirect to file:// or data:// is refused')

  // Every call site passes the allow-list; a caller without one has not
  // established that the first hop was allowed either.
  for (const call of src.matchAll(/await fetchText\(([^)]*)\)/g)) {
    assert.match(call[1], /,\s*allowList\s*$/, `fetchText call missing allowList: ${call[0]}`)
  }
})

test('the fetcher refuses to run without an allow-list at all', async () => {
  const src = readFileSync(new URL('../../lib/reviewedDocsSearch.js', import.meta.url), 'utf8')
  assert.match(src, /fetchText requires the reviewed-doc allow-list/)
})
