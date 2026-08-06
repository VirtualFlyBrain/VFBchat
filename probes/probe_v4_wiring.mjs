// v4.0.0 pre-commit smoke test: does the NEW wiring actually reach ELM?
//
// Unit tests prove the table is right. This proves the table is CONNECTED:
// roleProfiles -> callStructured extraBody -> vLLM chat_template_kwargs, and
// that the planner with its shipped profile still reads W9.1 as a count.
import { readFileSync } from 'node:fs'
import { callStructured } from '../lib/elmClient.mjs'
import { roleRequestOptions } from '../lib/roleProfiles.mjs'
import { buildPlannerMessages, PLAN_SCHEMA, normalizePlan } from '../lib/planner.mjs'

for (const line of readFileSync('/tmp/.elmenv', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// The point of the probe is the SHIPPED default, so clear the deployment's
// ELM_MODEL/APPROVED_ELM_MODEL unless the caller pins one explicitly.
if (!process.argv.includes('--as-deployed')) {
  delete process.env.ELM_MODEL
  delete process.env.APPROVED_ELM_MODEL
  delete process.env.OPENAI_MODEL
}
const baseUrl = process.env.ELM_API_BASE_URL || process.env.ELM_BASE_URL || 'https://elm.edina.ac.uk/api/v1'
const apiKey = process.env.ELM_API_KEY

const TOOLS = [
  { name: 'vfb_search_terms', purpose: 'search VFB for a term by name' },
  { name: 'vfb_get_term_info', purpose: 'full record for a resolved term' },
  { name: 'vfb_query_connectivity', purpose: 'synaptic partners between neuron classes' },
  { name: 'vfb_get_region_neuron_count', purpose: 'how many neurons are annotated in a region' },
  { name: 'vfb_run_query', purpose: 'run a named VFB query for a term' }
]

const QUESTIONS = [
  ['W9.1', 'How many DA1 lPN neurons does VFB hold in each connectome dataset?'],
  ['W4.C', 'What is the giant fiber neuron and what does it do?'],
  ['DOC', 'How do I connect Claude to the VFB MCP server?']
]

for (const [id, q] of QUESTIONS) {
  const opts = roleRequestOptions('planner', {})
  const t0 = Date.now()
  const r = await callStructured({
    baseUrl, apiKey,
    model: opts.model,
    messages: buildPlannerMessages(q, TOOLS),
    schema: PLAN_SCHEMA,
    schemaName: 'plan',
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    extraBody: opts.extraBody
  })
  const ms = Date.now() - t0
  if (!r.ok) { console.log(`${id}  FAILED after ${ms}ms: ${r.error}`); continue }
  const p = normalizePlan(r.value, q)
  console.log(`${id}  ${ms}ms  think=${opts.think} temp=${opts.temperature}  intent=${p.intent}  tools=${(p.steps || []).map(s => s.tool).join(',') || '(none)'}`)
}
console.log('model =', roleRequestOptions('planner', {}).model)
console.log('extraBody =', JSON.stringify(roleRequestOptions('planner', {}).extraBody))
console.log('extract extraBody =', JSON.stringify(roleRequestOptions('extract', {}).extraBody))
