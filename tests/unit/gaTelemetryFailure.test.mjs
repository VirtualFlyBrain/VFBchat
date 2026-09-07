// Regression test for the 7 September check-in: real chat traffic ran all day
// and GA4 showed exactly one event — a synthetic one sent by hand to prove the
// credentials and payload were fine. sendStructuredTelemetry's fetch was wrapped
// in a bare try/catch that discarded every outcome, so a production-side failure
// (a DNS block on google-analytics.com specifically, since the same container
// reaches OpenAI/ELM/NCBI without trouble; or a non-2xx from Google) had nothing
// written anywhere, ever — indistinguishable from there being no traffic to
// report at all.
//
// Run: node --test tests/unit/gaTelemetryFailure.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendStructuredTelemetry } from '../../lib/governance.js'

function withGaEnv(fn) {
  const prev = { id: process.env.GA_MEASUREMENT_ID, secret: process.env.GA_API_SECRET }
  process.env.GA_MEASUREMENT_ID = 'G-TESTID123'
  process.env.GA_API_SECRET = 'test-secret-do-not-leak'
  return fn().finally(() => {
    process.env.GA_MEASUREMENT_ID = prev.id
    process.env.GA_API_SECRET = prev.secret
  })
}

async function withMockedFetch(impl, fn) {
  const prevFetch = global.fetch
  global.fetch = impl
  const written = []
  const prevError = console.error
  console.error = (...args) => written.push(args.join(' '))
  try {
    await fn()
  } finally {
    global.fetch = prevFetch
    console.error = prevError
  }
  return written.join('\n')
}

test('a network failure is logged, by error name, with the secret never in it', async () => {
  const out = await withGaEnv(() => withMockedFetch(
    async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND www.google-analytics.com') },
    () => sendStructuredTelemetry({ requestId: 'r1' })
  ))
  assert.match(out, /GA telemetry unreachable/)
  assert.match(out, /TypeError/)
  assert.ok(!out.includes('test-secret-do-not-leak'), 'the api_secret must never reach the log')
})

test('a non-2xx response is logged with its status, not silently accepted', async () => {
  const out = await withGaEnv(() => withMockedFetch(
    async () => ({ ok: false, status: 403 }),
    () => sendStructuredTelemetry({ requestId: 'r1' })
  ))
  assert.match(out, /GA telemetry rejected: HTTP 403/)
})

test('a successful response logs nothing', async () => {
  const out = await withGaEnv(() => withMockedFetch(
    async () => ({ ok: true, status: 204 }),
    () => sendStructuredTelemetry({ requestId: 'r1' })
  ))
  assert.equal(out, '')
})

test('an error whose message embeds the request URL still never leaks the secret', async () => {
  // Some runtimes fold the request URL (which carries api_secret in its query
  // string) into the thrown error's own message. The log must not repeat it.
  const out = await withGaEnv(() => withMockedFetch(
    async (url) => { throw new Error(`request to ${url} failed`) },
    () => sendStructuredTelemetry({ requestId: 'r1' })
  ))
  assert.ok(!out.includes('test-secret-do-not-leak'), 'a URL-embedding error message must not be logged verbatim')
})

test('telemetry is a no-op, and logs nothing, when GA is not configured', async () => {
  process.env.GA_MEASUREMENT_ID = ''
  process.env.GA_API_SECRET = ''
  const out = await withMockedFetch(
    async () => { throw new Error('fetch must not be called') },
    () => sendStructuredTelemetry({ requestId: 'r1' })
  )
  assert.equal(out, '')
})
