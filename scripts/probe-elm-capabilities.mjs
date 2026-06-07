#!/usr/bin/env node
// Probe ELM gateway capabilities to settle harness design decisions.
//
// Runs read-only inference calls against the configured ELM /chat/completions
// endpoint and reports which structured-output / tool-calling features actually
// work. Decides the reliability strategy for the role-based harness
// (see outputs/reports/vfbchat-harness-design.md, §9 / §11.B).
//
// Usage:
//   node scripts/probe-elm-capabilities.mjs
//   node scripts/probe-elm-capabilities.mjs --json   # machine-readable summary
//
// Reads ELM_BASE_URL / ELM_API_KEY / ELM_MODEL from the environment or .env.local.
// The API key is never printed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 60000)

// ---- env loading (minimal .env.local parser; does not overwrite real env) ----
function loadDotEnv() {
  const file = path.join(REPO_ROOT, '.env.local')
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}
loadDotEnv()

const BASE = (process.env.ELM_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/$/, '')
const KEY = process.env.ELM_API_KEY || process.env.OPENAI_API_KEY || ''
const MODEL = process.env.ELM_MODEL || process.env.OPENAI_MODEL || ''

if (!BASE || !KEY || !MODEL) {
  console.error('Missing ELM_BASE_URL / ELM_API_KEY / ELM_MODEL (checked env and .env.local).')
  process.exit(2)
}

const HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }

// Strict schema reused across structured-output probes.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    capital: { type: 'string' },
    population_millions: { type: 'number' }
  },
  required: ['capital', 'population_millions']
}
const SCHEMA_PROMPT = [
  { role: 'system', content: 'You output only the requested JSON object. No prose.' },
  { role: 'user', content: 'Give the capital of France and its metro population in millions, as JSON with keys "capital" (string) and "population_millions" (number).' }
]

async function post(body, { stream = false } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: ctrl.signal
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, stream }
  } catch (err) {
    return { ok: false, status: 0, text: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

function contentFrom(text) {
  try {
    const j = JSON.parse(text)
    return j?.choices?.[0]?.message?.content ?? null
  } catch { return null }
}
function toolCallsFrom(text) {
  try {
    const j = JSON.parse(text)
    return j?.choices?.[0]?.message?.tool_calls ?? null
  } catch { return null }
}
function schemaConforms(str) {
  if (typeof str !== 'string') return { parsed: false }
  let obj
  try { obj = JSON.parse(str) } catch { return { parsed: false } }
  const keys = Object.keys(obj)
  const hasReq = SCHEMA.required.every(k => k in obj)
  const noExtra = keys.every(k => SCHEMA.required.includes(k))
  const typesOk = typeof obj.capital === 'string' && typeof obj.population_millions === 'number'
  return { parsed: true, conforms: hasReq && noExtra && typesOk, obj }
}
function snippet(s, n = 160) {
  return (s || '').replace(/\s+/g, ' ').slice(0, n)
}

const results = []
function record(name, status, detail) {
  results.push({ name, status, detail })
  if (!JSON_OUT) {
    const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
      : status === 'PARTIAL' ? '\x1b[33mPART\x1b[0m'
      : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m' : '\x1b[90m----\x1b[0m'
    console.log(`  [${tag}] ${name} — ${detail}`)
  }
}

async function main() {
  if (!JSON_OUT) {
    console.log(`ELM capability probe`)
    console.log(`  host:  ${BASE.replace(/(https?:\/\/[^/]+).*/, '$1')}`)
    console.log(`  model: ${MODEL}`)
    console.log(`  (api key: present, not shown)\n`)
  }

  // 1. Baseline non-streaming
  {
    const r = await post({ model: MODEL, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 10, stream: false })
    const c = contentFrom(r.text)
    if (r.ok && c) record('baseline_nonstream', 'PASS', `HTTP ${r.status}, content="${snippet(c, 40)}"`)
    else record('baseline_nonstream', 'FAIL', `HTTP ${r.status} — ${snippet(r.text)}`)
  }

  // 2. Streaming
  {
    const r = await post({ model: MODEL, messages: [{ role: 'user', content: 'Reply with: pong' }], max_tokens: 10, stream: true }, { stream: true })
    const looksSse = /data:\s*\{/.test(r.text) || /data:\s*\[DONE\]/.test(r.text)
    if (r.ok && looksSse) record('streaming_sse', 'PASS', `HTTP ${r.status}, SSE chunks observed`)
    else if (r.ok) record('streaming_sse', 'PARTIAL', `HTTP ${r.status} but no SSE framing — ${snippet(r.text)}`)
    else record('streaming_sse', 'FAIL', `HTTP ${r.status} — ${snippet(r.text)}`)
  }

  // 3. JSON mode (response_format: json_object)
  {
    const r = await post({ model: MODEL, messages: SCHEMA_PROMPT, max_tokens: 200, stream: false, response_format: { type: 'json_object' } })
    const c = contentFrom(r.text)
    const v = schemaConforms(c)
    if (r.ok && v.parsed) record('json_object_mode', 'PASS', `valid JSON returned (conforms=${!!v.conforms})`)
    else if (r.ok) record('json_object_mode', 'PARTIAL', `accepted but output not valid JSON — "${snippet(c)}"`)
    else record('json_object_mode', 'FAIL', `HTTP ${r.status} — ${snippet(r.text)}`)
  }

  // 4. Strict structured outputs (response_format: json_schema, strict)
  {
    const r = await post({
      model: MODEL, messages: SCHEMA_PROMPT, max_tokens: 200, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'capital_fact', strict: true, schema: SCHEMA } }
    })
    const c = contentFrom(r.text)
    const v = schemaConforms(c)
    if (r.ok && v.conforms) record('response_format_json_schema', 'PASS', `schema-conformant output (constrained decoding works)`)
    else if (r.ok && v.parsed) record('response_format_json_schema', 'PARTIAL', `JSON returned but not strictly schema-conformant — keys=${Object.keys(v.obj || {})}`)
    else if (r.ok) record('response_format_json_schema', 'PARTIAL', `accepted, output not JSON — "${snippet(c)}"`)
    else record('response_format_json_schema', 'FAIL', `HTTP ${r.status} — likely unsupported param — ${snippet(r.text)}`)
  }

  // 5. vLLM guided_json (top-level extra param)
  {
    const r = await post({ model: MODEL, messages: SCHEMA_PROMPT, max_tokens: 200, stream: false, guided_json: SCHEMA })
    const c = contentFrom(r.text)
    const v = schemaConforms(c)
    if (r.ok && v.conforms) record('vllm_guided_json', 'PASS', `schema-conformant (vLLM guided decoding works)`)
    else if (r.ok && v.parsed) record('vllm_guided_json', 'PARTIAL', `JSON but not conformant`)
    else if (r.ok) record('vllm_guided_json', 'PARTIAL', `accepted, output not JSON — param may be ignored`)
    else record('vllm_guided_json', 'FAIL', `HTTP ${r.status} — ${snippet(r.text)}`)
  }

  // 6. Native tool calling (auto)
  {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_capital', description: 'Return the capital city of a country',
        parameters: { type: 'object', additionalProperties: false, properties: { country: { type: 'string' } }, required: ['country'] }
      }
    }]
    const r = await post({ model: MODEL, messages: [{ role: 'user', content: 'What is the capital of France? Use the tool.' }], max_tokens: 200, stream: false, tools, tool_choice: 'auto' })
    const tc = toolCallsFrom(r.text)
    if (r.ok && Array.isArray(tc) && tc.length) record('native_tool_calling_auto', 'PASS', `tool_calls returned: ${tc.map(t => t?.function?.name).join(',')}`)
    else if (r.ok) record('native_tool_calling_auto', 'PARTIAL', `accepted but no tool_calls (model answered inline) — "${snippet(contentFrom(r.text))}"`)
    else record('native_tool_calling_auto', 'FAIL', `HTTP ${r.status} — params may be unsupported — ${snippet(r.text)}`)
  }

  // 7. Forced tool calling
  {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_capital', description: 'Return the capital city of a country',
        parameters: { type: 'object', additionalProperties: false, properties: { country: { type: 'string' } }, required: ['country'] }
      }
    }]
    const r = await post({
      model: MODEL, messages: [{ role: 'user', content: 'Capital of France?' }], max_tokens: 200, stream: false,
      tools, tool_choice: { type: 'function', function: { name: 'get_capital' } }
    })
    const tc = toolCallsFrom(r.text)
    if (r.ok && Array.isArray(tc) && tc.length) record('native_tool_calling_forced', 'PASS', `forced tool_call honoured`)
    else if (r.ok) record('native_tool_calling_forced', 'PARTIAL', `accepted, no tool_calls`)
    else record('native_tool_calling_forced', 'FAIL', `HTTP ${r.status} — ${snippet(r.text)}`)
  }

  // 8. Models list
  {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      const res = await fetch(`${BASE}/models`, { headers: HEADERS, signal: ctrl.signal }); clearTimeout(t)
      const text = await res.text()
      let ids = []
      try { ids = (JSON.parse(text)?.data || []).map(m => m.id) } catch {}
      if (res.ok && ids.length) record('models_list', 'PASS', `${ids.length} models: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? '…' : ''}`)
      else if (res.ok) record('models_list', 'PARTIAL', `HTTP ${res.status}, unparsed — ${snippet(text)}`)
      else record('models_list', 'FAIL', `HTTP ${res.status} — ${snippet(text)}`)
    } catch (e) { record('models_list', 'FAIL', String(e?.message || e)) }
  }

  // ---- recommendation ----
  const by = Object.fromEntries(results.map(r => [r.name, r.status]))
  const structured =
    by.response_format_json_schema === 'PASS' ? 'response_format:json_schema (strict) — use everywhere structured output is needed'
    : by.vllm_guided_json === 'PASS' ? 'vLLM guided_json — use as the constrained-decoding path'
    : by.json_object_mode === 'PASS' ? 'json_object mode only — no schema guarantee; keep JSON-repair + schema validation + self-consistency'
    : 'no server-side structured output — rely on prompt relay + robust JSON extraction + validate-and-retry + self-consistency voting'
  const tooling =
    (by.native_tool_calling_auto === 'PASS' || by.native_tool_calling_forced === 'PASS')
      ? 'native tool calling available — consider it for tool-arg steps (compare reliability vs the existing prompt relay)'
      : 'native tool calling NOT reliable — keep the prompt-instructed JSON relay'

  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, model: MODEL, results: by, recommendation: { structured_output: structured, tool_calling: tooling } }, null, 2))
  } else {
    console.log(`\nRecommendation`)
    console.log(`  structured output: ${structured}`)
    console.log(`  tool calling:      ${tooling}`)
    console.log(`\nFeed these results back into outputs/reports/vfbchat-harness-design.md §9.`)
  }

  const hardFail = results.find(r => r.name === 'baseline_nonstream' && r.status === 'FAIL')
  process.exit(hardFail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
