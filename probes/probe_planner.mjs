// Head-to-head planner probe: the REAL planner prompt, the REAL PLAN_SCHEMA and
// the REAL elmClient path, run against each candidate model.
import fs from 'node:fs'
import { buildPlannerMessages, PLAN_SCHEMA, normalizePlan } from '../lib/planner.mjs'
import { callStructured } from '../lib/elmClient.mjs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'
const TOOLS = JSON.parse(fs.readFileSync('/tmp/tooldefs.json', 'utf8'))
  .map(t => ({ name: t.name, purpose: t.description || '' }))

const QUESTIONS = [
  ['W1.B', "Search VFB for the neuron type 'DA1 lPN' and list every individual neuron across all datasets, with their dataset and VFB ID."],
  ['W2.B', 'Here\'s a FlyWire neuron VFB_fw035286. Find the morphologically closest neuron in the hemibrain and tell me if they\'re annotated as the same type.'],
  ['W4.C', 'Who does neuron VFB_jrchjtdb connect to most strongly?'],
  ['W5.C', 'What neurons look most similar to LPLC2?'],
  ['W7.C3', 'What are the main synaptic partners of Kenyon cells?'],
  ['W7.C4', 'What expression data does VFB have for Kenyon cells?'],
  ['W9.1', 'How many DA1 lPN neurons does VFB hold in each connectome dataset?'],
  ['DOC', 'How do I use the Virtual Fly Brain MCP tool?']
]

const MODELS = process.argv.slice(2)

const out = []
for (const model of MODELS) {
  for (const [tag, q] of QUESTIONS) {
    const messages = buildPlannerMessages(q, TOOLS, [])
    const promptChars = messages.map(m => m.content).join('').length
    const t = Date.now()
    const r = await callStructured({
      baseUrl: BASE, apiKey: KEY, model, messages,
      schema: PLAN_SCHEMA, schemaName: 'plan', temperature: 0, timeoutMs: 240000
    })
    const dt = (Date.now() - t) / 1000
    const plan = r.ok ? normalizePlan(r.value, q) : null
    out.push({
      model, tag, ok: r.ok, attempts: r.attempts, secs: +dt.toFixed(1),
      promptChars,
      intent: plan?.intent, under: plan?.underspecified,
      terms: plan?.terms_to_resolve,
      steps: plan?.steps?.map(s => s.tool),
      error: r.error
    })
    const last = out[out.length - 1]
    console.log(`${model.split('/').pop().slice(0, 18).padEnd(18)} ${tag.padEnd(6)} ok=${last.ok} ${String(last.secs).padStart(6)}s att=${last.attempts} intent=${last.intent} steps=${JSON.stringify(last.steps)}`)
  }
}
fs.writeFileSync('/tmp/planner_probe.json', JSON.stringify(out, null, 1))
