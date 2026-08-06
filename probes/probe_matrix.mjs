// Planner-role config matrix. The question this answers:
// does turning thinking OFF (which we must do for latency) cost us the plan
// quality that made Qwen attractive in the first place?
//
// Uses the REAL planner prompt, the REAL PLAN_SCHEMA and the REAL client
// (now with an extraBody escape hatch) so the result transfers to production.
import fs from 'node:fs'
import { buildPlannerMessages, PLAN_SCHEMA, normalizePlan } from '../lib/planner.mjs'
import { callStructured } from '../lib/elmClient.mjs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'
const TOOLS = JSON.parse(fs.readFileSync('/tmp/tooldefs.json', 'utf8'))
  .map(t => ({ name: t.name, purpose: t.description || '' }))

const QWEN = 'Qwen/Qwen3.5-397B-A17B-FP8'
const LLAMA = 'meta-llama/Llama-3.3-70B-Instruct'

const NOTHINK = { chat_template_kwargs: { enable_thinking: false } }

// Qwen's published best practice for non-thinking mode; note DO NOT use greedy.
const QWEN_NOTHINK_SAMPLING = { top_p: 0.8, top_k: 20, presence_penalty: 1.5 }

const CONFIGS = [
  { id: 'llama-t0',            model: LLAMA, temperature: 0 },
  { id: 'qwen-think-t0',       model: QWEN,  temperature: 0 },
  { id: 'qwen-nothink-t0',     model: QWEN,  temperature: 0,   extraBody: NOTHINK },
  { id: 'qwen-nothink-rec',    model: QWEN,  temperature: 0.7, extraBody: { ...NOTHINK, ...QWEN_NOTHINK_SAMPLING } }
]

const QUESTIONS = [
  ['W1.B', "Search VFB for the neuron type 'DA1 lPN' and list every individual neuron across all datasets, with their dataset and VFB ID."],
  ['W2.B', "Here's a FlyWire neuron VFB_fw035286. Find the morphologically closest neuron in the hemibrain and tell me if they're annotated as the same type."],
  ['W4.C', 'Who does neuron VFB_jrchjtdb connect to most strongly?'],
  ['W5.C', 'What neurons look most similar to LPLC2?'],
  ['W7.C3', 'What are the main synaptic partners of Kenyon cells?'],
  ['W7.C4', 'What expression data does VFB have for Kenyon cells?'],
  ['W9.1', 'How many DA1 lPN neurons does VFB hold in each connectome dataset?'],
  ['DOC', 'How do I use the Virtual Fly Brain MCP tool?']
]

const out = []
for (const cfg of CONFIGS) {
  for (const [tag, q] of QUESTIONS) {
    const messages = buildPlannerMessages(q, TOOLS, [])
    const t = Date.now()
    const r = await callStructured({
      baseUrl: BASE, apiKey: KEY, model: cfg.model, messages,
      schema: PLAN_SCHEMA, schemaName: 'plan',
      temperature: cfg.temperature, extraBody: cfg.extraBody,
      timeoutMs: 240000
    })
    const secs = +((Date.now() - t) / 1000).toFixed(1)
    const plan = r.ok ? normalizePlan(r.value, q) : null
    const rec = {
      config: cfg.id, tag, ok: r.ok, attempts: r.attempts, secs,
      intent: plan?.intent, under: plan?.underspecified,
      terms: plan?.terms_to_resolve, steps: plan?.steps?.map(s => s.tool), error: r.error
    }
    out.push(rec)
    console.log(`${cfg.id.padEnd(18)} ${tag.padEnd(6)} ok=${rec.ok} ${String(secs).padStart(6)}s att=${rec.attempts} intent=${rec.intent} steps=${JSON.stringify(rec.steps)}`)
    fs.writeFileSync('/tmp/matrix.json', JSON.stringify(out, null, 1))
  }
  console.log('')
}
