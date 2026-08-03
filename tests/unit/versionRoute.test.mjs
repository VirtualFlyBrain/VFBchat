// GET /api/version — the endpoint that says what is actually deployed.
//
// Run: node --test tests/unit/versionRoute.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { GET } from '../../app/api/version/route.js'
import { APP_CLIENT_NAME } from '../../lib/appVersion.mjs'

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))

test('reports the deployed version, client name and MCP target', async () => {
  const res = await GET()
  // Uncached on purpose: an intermediary serving the previous version would say
  // exactly the wrong thing to the question this endpoint exists to answer.
  assert.match(res.headers.get('cache-control') || '', /no-store/)
  const body = await res.json()
  assert.equal(body.name, APP_CLIENT_NAME)
  assert.equal(body.version, pkg.version)
  assert.equal(body.user_agent, `${APP_CLIENT_NAME}/${pkg.version}`)
  assert.equal(body.version_resolved, true)
  assert.match(body.mcp_url, /^https?:\/\//)
  assert.equal(body.node, process.version)
})

test('leaks nothing beyond the documented fields', async () => {
  // An unauthenticated endpoint is worth probing only if it answers something
  // interesting. Keep the answer boring, and fail loudly if a field is added
  // without someone deciding it is safe to expose.
  const body = await (await GET()).json()
  assert.deepEqual(Object.keys(body).sort(), [
    'mcp_url', 'name', 'node', 'user_agent', 'version', 'version_resolved'
  ])
  const serialised = JSON.stringify(body)
  assert.ok(!/key|token|secret|password|authorization/i.test(serialised))
})

test('honours VFB_MCP_URL when the deployment overrides the default', async () => {
  const previous = process.env.VFB_MCP_URL
  process.env.VFB_MCP_URL = 'https://vfb3-mcp.example.org/'
  try {
    // Read at request time, not module load: a redeploy that changes only the
    // env must be reflected without a rebuild.
    const body = await (await GET()).json()
    assert.equal(body.mcp_url, 'https://vfb3-mcp.example.org/')
  } finally {
    if (previous === undefined) delete process.env.VFB_MCP_URL
    else process.env.VFB_MCP_URL = previous
  }
})
