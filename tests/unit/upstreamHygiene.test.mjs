// Things that leaked upstream, or into the log volume, one request at a time.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createForceRefreshBudget } from '../../lib/runQueryRetry.mjs'
import { getClientIp } from '../../lib/clientIp.mjs'

const routeSrc = fs.readFileSync(new URL('../../app/api/chat/route.js', import.meta.url), 'utf8')
const feedbackSrc = fs.readFileSync(new URL('../../app/api/feedback/route.js', import.meta.url), 'utf8')

test('the MCP client map holds the promise, so concurrent resolves share one session', () => {
  // resolveTerms fans out over names with Promise.all. Check-then-await-then-set
  // meant every branch missed on the first round, opened its own
  // StreamableHTTPClientTransport session, and each `set` overwrote the last —
  // so closeMcpClients closed one and the rest stayed open upstream until the
  // server timed them out.
  const fn = routeSrc.slice(
    routeSrc.indexOf('async function getMcpClientForContext'),
    routeSrc.indexOf('async function closeMcpClient(')
  )
  assert.ok(!/const client = await createMcpClient\(server\)\s*\n\s*context\.mcpClients\.set/.test(fn),
    'awaiting before set is the race')
  assert.ok(/context\.mcpClients\.set\(server, pending\)/.test(fn),
    'the pending promise must be stored before it resolves')
  assert.ok(/\.catch\(/.test(fn), 'a failed connect must not stay cached')
})

test('the force-refresh allowance is shared, not created fresh per call', () => {
  // 26 of the 27 callVfbToolTextWithFallback sites passed no budget, so each fell
  // back to createForceRefreshBudget(1) created per call. One
  // vfb_find_reciprocal_connectivity is 1 endpoint query + up to 6 partner
  // queries: seven recomputes against a shared upstream instead of two.
  const fn = routeSrc.slice(
    routeSrc.indexOf('async function callMcpToolTextWithForceRefresh'),
    routeSrc.indexOf('// The version sent here is what the MCP server records')
  )
  assert.match(fn, /client\?\.\[FORCE_REFRESH_BUDGET\]/,
    'the request allowance should ride on the client so every call site gets it')
})

test('a shared allowance really does stop the second recompute', () => {
  const budget = createForceRefreshBudget()
  const keys = ['run_query:a', 'run_query:b', 'run_query:c', 'run_query:d']
  const allowed = keys.filter(k => budget.tryConsume(k))
  assert.ok(allowed.length <= 2, `allowed ${allowed.length} recomputes, documented maximum is 2`)
})

test('the feedback endpoint is rate limited like every other write path', () => {
  assert.match(feedbackSrc, /checkAndIncrement/, 'no rate limit at all before this')
  assert.match(feedbackSrc, /status: 429/)
  assert.match(feedbackSrc, /getClientIp/)
})

test('client IP is read one way, by every route that needs it', () => {
  const headers = new Map([['x-forwarded-for', '203.0.113.7, 10.0.0.1']])
  const request = { headers: { get: (k) => headers.get(k) || null } }
  assert.equal(getClientIp(request), '203.0.113.7')
  assert.equal(getClientIp({ headers: { get: () => null } }), 'unknown')
})

test('the controller has no unreachable stop action', () => {
  const controller = fs.readFileSync(new URL('../../lib/controller.mjs', import.meta.url), 'utf8')
  const orchestrator = fs.readFileSync(new URL('../../lib/orchestrator.mjs', import.meta.url), 'utf8')
  const returnsStop = /return\s*\{\s*action:\s*'stop'/.test(controller)
  const handlesStop = /action\.action === 'stop'/.test(orchestrator)
  assert.equal(handlesStop, returnsStop,
    'a handler with no producer is not a graceful dead stop, it is dead code that reads like one')
})
