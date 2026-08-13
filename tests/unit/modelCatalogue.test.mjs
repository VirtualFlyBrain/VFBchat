// Model preference LISTS and the served-model catalogue (v4.0.0).
//
// The property under test throughout is the one that makes this change safe to
// ship: a list of one behaves EXACTLY as v3.x's single pinned name did, and an
// unavailable catalogue behaves exactly as no catalogue at all. Everything else
// this file checks is a pure addition on top of that floor.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseModelList,
  modelCandidates,
  resolveRoleModel,
  QWEN_MODEL,
  LLAMA_MODEL
} from '../../lib/structuredOutput.mjs'
import {
  refreshServedModels,
  primeServedModels,
  ensureServedModels,
  servedModelsSnapshot,
  catalogueStatus,
  __resetModelCatalogue,
  __setServedModels
} from '../../lib/modelCatalogue.mjs'
import { describeRoleModels, roleRequestOptions } from '../../lib/roleProfiles.mjs'
import { validateProductionCompliance, getConfiguredModel, getConfiguredModelList } from '../../lib/runtimeConfig.js'

const OTHER = 'some/other-model'

// ---------------------------------------------------------------- parsing ---

test('a bare model name parses as a one-element list', () => {
  assert.deepEqual(parseModelList(LLAMA_MODEL), [LLAMA_MODEL])
})

test('lists split on commas and newlines, trim, and drop blanks', () => {
  assert.deepEqual(parseModelList(` ${QWEN_MODEL} ,\n\n  ${LLAMA_MODEL} ,, `), [QWEN_MODEL, LLAMA_MODEL])
})

test('duplicates collapse but ORDER is preserved, because order is the preference', () => {
  assert.deepEqual(parseModelList(`${LLAMA_MODEL},${QWEN_MODEL},${LLAMA_MODEL}`), [LLAMA_MODEL, QWEN_MODEL])
})

test('junk parses to an empty list rather than to a bogus model name', () => {
  for (const junk of [undefined, null, '', '   ', ',,,', 42, {}, true]) {
    assert.deepEqual(parseModelList(junk), [], `${JSON.stringify(junk)} must yield []`)
  }
})

// ------------------------------------------------- v3.x behaviour preserved ---

test('single-valued env vars resolve exactly as they did in v3.x', () => {
  // This is the compatibility floor: no deployment has to change to keep working.
  assert.equal(resolveRoleModel('planner', { ELM_MODEL: LLAMA_MODEL }), LLAMA_MODEL)
  assert.equal(resolveRoleModel('planner', { OPENAI_MODEL: LLAMA_MODEL }), LLAMA_MODEL)
  assert.equal(resolveRoleModel('planner', { APPROVED_ELM_MODEL: LLAMA_MODEL }), LLAMA_MODEL)
  assert.equal(resolveRoleModel('planner', {}), QWEN_MODEL)
})

test('the precedence order between sources is unchanged', () => {
  const env = {
    VFB_MODEL_PLANNER: 'a', VFB_MODEL_DEFAULT: 'b', ELM_MODEL: 'c',
    OPENAI_MODEL: 'd', APPROVED_ELM_MODEL: 'e'
  }
  assert.equal(resolveRoleModel('planner', env), 'a')
  assert.equal(resolveRoleModel('extract', env), 'b')
  assert.deepEqual(modelCandidates('planner', env), ['a', 'b', 'c', 'd', 'e', QWEN_MODEL])
})

test('the candidate chain is FLATTENED, so a dead first source falls through', () => {
  // v3.x returned the first source that was set, full stop — so a first source
  // naming a retired model was a total outage, not a degradation.
  const env = { ELM_MODEL: OTHER, APPROVED_ELM_MODEL: LLAMA_MODEL }
  assert.equal(resolveRoleModel('planner', env), OTHER)
  assert.equal(
    resolveRoleModel('planner', env, undefined, { available: new Set([LLAMA_MODEL]) }),
    LLAMA_MODEL
  )
})

// ------------------------------------------------------------ availability ---

test('the head of the list wins when the gateway serves it', () => {
  const env = { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }
  const available = new Set([QWEN_MODEL, LLAMA_MODEL])
  assert.equal(resolveRoleModel('planner', env, undefined, { available }), QWEN_MODEL)
})

test('an unserved head falls through to the next candidate', () => {
  const env = { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }
  assert.equal(
    resolveRoleModel('planner', env, undefined, { available: new Set([LLAMA_MODEL]) }),
    LLAMA_MODEL
  )
})

test('an UNKNOWN catalogue never filters — the probe must not pick the model', () => {
  // Fail open. A flaky /v1/models endpoint changing which model answers a
  // question would be a far worse bug than the one lists are here to fix.
  const env = { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }
  for (const available of [undefined, null, new Set()]) {
    assert.equal(resolveRoleModel('planner', env, undefined, { available }), QWEN_MODEL)
  }
})

test('when NO candidate is served we return the first, not something invented', () => {
  // Better to fail with the gateway's own error naming the missing model than
  // to silently answer on a model nobody configured.
  const env = { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }
  assert.equal(
    resolveRoleModel('planner', env, undefined, { available: new Set([OTHER]) }),
    QWEN_MODEL
  )
})

test('an explicit per-role list is still consulted before the shared one', () => {
  const env = { VFB_MODEL_PLANNER: `${OTHER},${LLAMA_MODEL}`, ELM_MODEL: QWEN_MODEL }
  const available = new Set([LLAMA_MODEL, QWEN_MODEL])
  assert.equal(resolveRoleModel('planner', env, undefined, { available }), LLAMA_MODEL)
  assert.equal(resolveRoleModel('extract', env, undefined, { available }), QWEN_MODEL)
})

// -------------------------------------------- falling back is fully coherent ---

test('falling back to Llama also restores v3.x sampling and disables thinking', () => {
  // The point of the whole design: a Qwen outage degrades to a CORRECT Llama
  // configuration with no human in the loop. Model lists pick the model,
  // supportsReasoning drops the Qwen-only body fields, and legacyTemperature
  // puts the sampling back. If any one of the three regressed, this fails.
  const env = { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }
  const available = new Set([LLAMA_MODEL])
  const planner = roleRequestOptions('planner', { env, available })
  assert.equal(planner.model, LLAMA_MODEL)
  assert.equal(planner.think, false)
  assert.equal(planner.temperature, 0)
  assert.deepEqual(planner.extraBody.chat_template_kwargs, undefined)
  assert.equal('top_k' in planner.extraBody, false)

  const onQwen = roleRequestOptions('planner', { env, available: new Set([QWEN_MODEL]) })
  assert.equal(onQwen.model, QWEN_MODEL)
  assert.equal(onQwen.think, true)
  assert.equal(onQwen.temperature, 0.6)
})

// -------------------------------------------------------------- visibility ---

test('a resolution off the measured profile is reported as a warning', () => {
  const report = describeRoleModels({ env: { ELM_MODEL: LLAMA_MODEL }, available: new Set([LLAMA_MODEL]) })
  assert.equal(report.roles.length, 5)
  assert.ok(report.roles.every(r => r.model === LLAMA_MODEL))
  assert.ok(report.warnings.some(w => w.includes(LLAMA_MODEL)), 'must name the model actually in use')
  assert.ok(report.warnings.some(w => w.includes('ELM_MODEL')), 'must name the variable to fix')
})

test('the on-profile case warns about nothing except an unknown catalogue', () => {
  const report = describeRoleModels({ env: { ELM_MODEL: QWEN_MODEL }, available: new Set([QWEN_MODEL]) })
  assert.deepEqual(report.warnings, [])
  assert.ok(report.roles.every(r => r.reasoning))
})

test('skipped-because-unserved models are named, not swallowed', () => {
  const report = describeRoleModels({
    env: { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` },
    available: new Set([LLAMA_MODEL])
  })
  assert.ok(report.warnings.some(w => w.includes('not serving') && w.includes(QWEN_MODEL)))
})

// ---------------------------------------------------------------- catalogue ---

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

test('a successful probe builds the served-model set', async () => {
  __resetModelCatalogue()
  const got = await refreshServedModels({
    baseUrl: 'https://elm.example/api/v1/',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://elm.example/api/v1/models')
      assert.equal(init.headers.authorization, 'Bearer k')
      return jsonResponse({ data: [{ id: QWEN_MODEL }, { id: LLAMA_MODEL }, { id: '  ' }] })
    }
  })
  assert.deepEqual([...got], [QWEN_MODEL, LLAMA_MODEL])
  assert.equal(servedModelsSnapshot().size, 2)
  assert.equal(catalogueStatus().known, true)
  __resetModelCatalogue()
})

test('a failing probe keeps the last good snapshot', async () => {
  // A transient 502 is not evidence that a model went away.
  __resetModelCatalogue()
  __setServedModels([QWEN_MODEL])
  const got = await refreshServedModels({
    baseUrl: 'https://elm.example/api/v1',
    force: true,
    fetchImpl: async () => jsonResponse({}, false, 502)
  })
  assert.deepEqual([...got], [QWEN_MODEL])
  assert.match(catalogueStatus().lastError, /502/)
  __resetModelCatalogue()
})

test('a probe that throws is swallowed, not propagated', async () => {
  __resetModelCatalogue()
  const got = await refreshServedModels({
    baseUrl: 'https://elm.example/api/v1',
    fetchImpl: async () => { throw new Error('ECONNREFUSED') }
  })
  assert.equal(got, null)
  assert.equal(catalogueStatus().known, false)
  __resetModelCatalogue()
})

test('an EMPTY catalogue counts as unknown, so it cannot filter everything away', async () => {
  __resetModelCatalogue()
  const got = await refreshServedModels({
    baseUrl: 'https://elm.example/api/v1',
    fetchImpl: async () => jsonResponse({ data: [] })
  })
  assert.equal(got, null, 'an empty set would filter out every candidate')
  __resetModelCatalogue()
})

test('a fresh snapshot is served from cache without touching the network', async () => {
  __resetModelCatalogue()
  let calls = 0
  const fetchImpl = async () => { calls++; return jsonResponse({ data: [{ id: QWEN_MODEL }] }) }
  const o = { baseUrl: 'https://elm.example/api/v1', fetchImpl, ttlMs: 60000 }
  await refreshServedModels(o)
  await refreshServedModels(o)
  await refreshServedModels(o)
  assert.equal(calls, 1)
  __resetModelCatalogue()
})

test('a failing gateway is probed once per TTL, not once per request', async () => {
  __resetModelCatalogue()
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('down') }
  const o = { baseUrl: 'https://elm.example/api/v1', fetchImpl, ttlMs: 60000 }
  await refreshServedModels(o)
  await refreshServedModels(o)
  assert.equal(calls, 1, 'a down gateway must not be hammered on every question')
  __resetModelCatalogue()
})

test('priming never throws and hands back the snapshot synchronously', () => {
  __resetModelCatalogue()
  assert.equal(primeServedModels({ baseUrl: '', fetchImpl: null }), null)
  __setServedModels([QWEN_MODEL])
  assert.deepEqual([...primeServedModels({ baseUrl: 'https://elm.example/api/v1', ttlMs: 60000 })], [QWEN_MODEL])
  __resetModelCatalogue()
})

// ------------------------------------------------------------- cold start ---
//
// One minute after the v4.2.6 container started the catalogue read
// {"known":false,"count":0} and every model list resolved to its first entry
// unfiltered, so the Llama fallback could not engage. The Jenkins job replaces
// the container monthly, so the window recurs by design.

test('the first request waits for the catalogue rather than guessing', async () => {
  __resetModelCatalogue()
  let calls = 0
  const got = await ensureServedModels({
    baseUrl: 'https://elm.example/api/v1',
    fetchImpl: async () => { calls++; return jsonResponse({ data: [{ id: LLAMA_MODEL }] }) }
  })
  assert.equal(calls, 1)
  assert.deepEqual([...got], [LLAMA_MODEL])
  // …and that is what makes the fallback work: Qwen heads the list, the gateway
  // serves only Llama, and resolution now knows it.
  assert.equal(resolveRoleModel('synth', { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }, QWEN_MODEL, { available: got }), LLAMA_MODEL)
  __resetModelCatalogue()
})

test('a known catalogue is never waited for — the probe stays background work', async () => {
  __resetModelCatalogue()
  __setServedModels([QWEN_MODEL])
  let calls = 0
  const got = await ensureServedModels({
    baseUrl: 'https://elm.example/api/v1', ttlMs: 60000,
    fetchImpl: async () => { calls++; return jsonResponse({ data: [{ id: LLAMA_MODEL }] }) }
  })
  assert.equal(calls, 0, 'a fresh snapshot must not cost a round trip')
  assert.deepEqual([...got], [QWEN_MODEL])
  __resetModelCatalogue()
})

test('a dead gateway is waited for once per TTL, then failed open', async () => {
  // The wait must not become a per-request tax when the probe cannot succeed,
  // and it must not become a gate: unknown still resolves unfiltered.
  __resetModelCatalogue()
  let calls = 0
  const o = {
    baseUrl: 'https://elm.example/api/v1', ttlMs: 60000,
    fetchImpl: async () => { calls++; throw new Error('down') }
  }
  assert.equal(await ensureServedModels(o), null)
  assert.equal(await ensureServedModels(o), null)
  assert.equal(await ensureServedModels(o), null)
  assert.equal(calls, 1, 'a down gateway costs one wait per TTL, not one per question')
  assert.equal(catalogueStatus().known, false)
  assert.equal(resolveRoleModel('synth', { ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}` }, QWEN_MODEL, { available: null }), QWEN_MODEL)
  __resetModelCatalogue()
})

test('concurrent cold-start requests share one probe', async () => {
  __resetModelCatalogue()
  let calls = 0
  const o = {
    baseUrl: 'https://elm.example/api/v1',
    fetchImpl: async () => { calls++; return jsonResponse({ data: [{ id: QWEN_MODEL }] }) }
  }
  const all = await Promise.all([ensureServedModels(o), ensureServedModels(o), ensureServedModels(o)])
  assert.equal(calls, 1)
  for (const got of all) assert.deepEqual([...got], [QWEN_MODEL])
  __resetModelCatalogue()
})

test('a missing baseUrl or fetch implementation is a no-op, not a crash', async () => {
  __resetModelCatalogue()
  assert.equal(await refreshServedModels({ baseUrl: '' }), null)
  assert.equal(await refreshServedModels({ baseUrl: 'https://x/api', fetchImpl: 'not a function' }), null)
  __resetModelCatalogue()
})

// --------------------------------------------------------------- compliance ---

function withEnv(vars, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { return fn() } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const PROD_BASE = {
  NODE_ENV: 'production',
  ELM_API_KEY: 'test-key',
  ELM_BASE_URL: 'https://elm.example/api/v1',
  APPROVED_ELM_BASE_URL: 'https://elm.example/api/v1',
  VFB_MODEL_PLANNER: undefined,
  VFB_MODEL_DEFAULT: undefined,
  OPENAI_MODEL: undefined
}

test('production accepts a configured list that is a SUBSET of the approved list', () => {
  withEnv({
    ...PROD_BASE,
    ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}`,
    APPROVED_ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL},${OTHER}`
  }, () => {
    assert.doesNotThrow(() => validateProductionCompliance())
    assert.equal(getConfiguredModel(), QWEN_MODEL)
    assert.deepEqual(getConfiguredModelList(), [QWEN_MODEL, LLAMA_MODEL])
  })
})

test('production rejects ANY configured model that is not approved', () => {
  // Stronger than v3.x's equality check: it is no longer possible to smuggle an
  // unapproved model in as the second entry of an otherwise-approved list.
  withEnv({
    ...PROD_BASE,
    ELM_MODEL: `${QWEN_MODEL},${OTHER}`,
    APPROVED_ELM_MODEL: QWEN_MODEL
  }, () => {
    assert.throws(() => validateProductionCompliance(), /must be approved in production.*other-model/s)
  })
})

test('production rejects an unapproved model hidden in a per-role override', () => {
  withEnv({
    ...PROD_BASE,
    ELM_MODEL: QWEN_MODEL,
    APPROVED_ELM_MODEL: QWEN_MODEL,
    VFB_MODEL_PLANNER: `${QWEN_MODEL},${OTHER}`
  }, () => {
    assert.throws(() => validateProductionCompliance(), /VFB_MODEL_PLANNER/)
  })
})

test('production refuses to start when APPROVED_ELM_MODEL is unset', () => {
  // This test used to assert the opposite, and that is the point. An unset
  // APPROVED_ELM_MODEL made the approved list fall back to the configured one,
  // so the deployment approved itself and every check downstream passed by
  // construction. Recommended addition 7.3 of 10-evaluation-plan.md.
  withEnv({
    ...PROD_BASE,
    ELM_MODEL: `${QWEN_MODEL},${LLAMA_MODEL}`,
    APPROVED_ELM_MODEL: undefined
  }, () => {
    assert.throws(() => validateProductionCompliance(), /APPROVED_ELM_MODEL must be set/)
  })
})

test('production refuses to start when APPROVED_ELM_BASE_URL is unset', () => {
  withEnv({
    ...PROD_BASE,
    ELM_MODEL: QWEN_MODEL,
    APPROVED_ELM_MODEL: QWEN_MODEL,
    APPROVED_ELM_BASE_URL: undefined
  }, () => {
    assert.throws(() => validateProductionCompliance(), /APPROVED_ELM_BASE_URL must be set/)
  })
})
