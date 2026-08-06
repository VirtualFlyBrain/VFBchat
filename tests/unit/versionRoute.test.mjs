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
    'catalogue', 'mcp_url', 'models', 'name', 'node', 'user_agent', 'version', 'version_resolved'
  ])
  const serialised = JSON.stringify(body)
  assert.ok(!/token|secret|password|authorization/i.test(serialised))
  // "key" on its own is too common a substring to ban outright once nested
  // objects are in the payload, so ban the things that actually matter: the
  // NAMES of the secret-bearing variables, and their VALUES.
  for (const name of ['ELM_API_KEY', 'GA_API_SECRET', 'NCBI_API_KEY', 'MCP_PRIVATE_KEY', 'MCP_REGISTRY_AUTH', 'ELM_API_URL']) {
    assert.doesNotMatch(serialised, new RegExp(name), `${name} must not be named in the payload`)
    const value = process.env[name]
    if (value && value.length > 6) {
      assert.equal(serialised.includes(value), false, `${name}'s value must not appear in the payload`)
    }
  }
})

test('says which model each role resolved to, and whether that is the measured profile', async () => {
  // v4.0.0's gap. The endpoint proved the IMAGE was fresh and said nothing about
  // which model was answering — the one thing a per-role model configuration
  // makes it possible to get wrong while still serving every request
  // successfully. Confirming it took a behavioural probe: ask a question, judge
  // the prose, guess. That is the same confusion between "the deployment is
  // stale" and "the model wrote something different this time" that this
  // endpoint exists to end.
  const { __setServedModels, __resetModelCatalogue } = await import('../../lib/modelCatalogue.mjs')
  __resetModelCatalogue()
  const cold = await (await GET()).json()

  assert.ok(Array.isArray(cold.models?.roles) && cold.models.roles.length, 'every role must be reported')
  for (const r of cold.models.roles) {
    assert.equal(typeof r.role, 'string')
    assert.ok(r.model, `${r.role} must resolve to a model`)
    assert.ok(Array.isArray(r.skipped))
  }
  // An unwarmed catalogue is reported, not hidden: the roles above are then the
  // UNFILTERED first choice of each preference list — what would run, but not
  // proof the gateway serves it. Telling those two apart is the point.
  assert.equal(cold.catalogue?.known, false)
  assert.ok(cold.models.warnings.some(w => /catalogue/i.test(w)))
  assert.equal(cold.models.on_profile, false)

  // Warmed with exactly what the roles asked for: nothing to warn about.
  __setServedModels(cold.models.roles.map(r => r.model))
  const warm = await (await GET()).json()
  assert.equal(warm.catalogue?.known, true)
  assert.deepEqual(warm.models.warnings, [], 'a correctly-configured deployment warns about nothing')
  assert.equal(warm.models.on_profile, true)
  __resetModelCatalogue()
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
