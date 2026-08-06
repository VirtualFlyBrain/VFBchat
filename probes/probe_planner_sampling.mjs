// Controlled A/B/C on the PLANNER's sampling, holding everything else fixed:
// same real tool catalogue, same real prompt, same schema, same model.
//
// Why: probe_planner.mjs measured "Qwen thinking ON" with temperature 0 and NO
// top_p/top_k, and that config was the only one that read W9.1 as a count. The
// v4 profile then adopted Qwen's PUBLISHED thinking preset (0.6/0.95/20) on the
// strength of the model card rather than on a measurement. The wiring probe
// suggests that swap made things worse. Settle it.
import fs from 'node:fs'
import { buildPlannerMessages, PLAN_SCHEMA, normalizePlan } from '../lib/planner.mjs'
import { callStructured } from '../lib/elmClient.mjs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'
const MODEL = 'Qwen/Qwen3.5-397B-A17B-FP8'
const TOOLS = JSON.parse(fs.readFileSync('/tmp/tooldefs.json', 'utf8'))
  .map(t => ({ name: t.name, purpose: t.description || '' }))

const CONFIGS = [
  ['greedy-think', 0, { chat_template_kwargs: { enable_thinking: true }, max_tokens: 16384 }],
  ['preset-think', 0.6, { chat_template_kwargs: { enable_thinking: true }, top_p: 0.95, top_k: 20, max_tokens: 16384 }],
  ['lowtemp-think', 0.2, { chat_template_kwargs: { enable_thinking: true }, top_p: 0.95, top_k: 20, max_tokens: 16384 }]
]

// The four questions probe_agreement.mjs found contested, plus the two settled
// controls, so a config cannot win by simply being more decisive.
const QUESTIONS = [
  ['W9.1', 'How many DA1 lPN neurons does VFB hold in each connectome dataset?', 'neuron_count'],
  ['W4.C', 'Who does neuron VFB_jrchjtdb connect to most strongly?', 'connectivity'],
  ['W1.B', "Search VFB for the neuron type 'DA1 lPN' and list every individual neuron across all datasets, with their dataset and VFB ID.", null],
  ['W5.C', 'What neurons look most similar to LPLC2?', 'similarity'],
  ['W7.C3', 'What are the main synaptic partners of Kenyon cells?', 'connectivity'],
  ['DOC', 'How do I use the Virtual Fly Brain MCP tool?', 'documentation']
]

const out = []
for (const [name, temperature, extraBody] of CONFIGS) {
  for (const [tag, q, want] of QUESTIONS) {
    const t = Date.now()
    const r = await callStructured({
      baseUrl: BASE, apiKey: KEY, model: MODEL,
      messages: buildPlannerMessages(q, TOOLS, []),
      schema: PLAN_SCHEMA, schemaName: 'plan',
      temperature, timeoutMs: 240000, extraBody
    })
    const secs = +((Date.now() - t) / 1000).toFixed(1)
    const plan = r.ok ? normalizePlan(r.value, q) : null
    const row = {
      config: name, tag, ok: r.ok, secs, attempts: r.attempts,
      intent: plan?.intent, want,
      hit: want ? plan?.intent === want : null,
      steps: plan?.steps?.map(s => s.tool), error: r.error
    }
    out.push(row)
    console.log(`${name.padEnd(14)} ${tag.padEnd(6)} ok=${r.ok} ${String(secs).padStart(6)}s intent=${String(row.intent).padEnd(16)} want=${want ?? '-'} ${row.hit === null ? '' : (row.hit ? 'HIT' : 'MISS')} steps=${JSON.stringify(row.steps)}`)
    fs.writeFileSync('/tmp/planner_sampling.json', JSON.stringify(out, null, 1))
  }
  const mine = out.filter(r => r.config === name)
  const hits = mine.filter(r => r.hit === true).length
  const scored = mine.filter(r => r.hit !== null).length
  const total = mine.reduce((a, r) => a + r.secs, 0)
  console.log(`>>> ${name}: ${hits}/${scored} correct intents, ${total.toFixed(1)}s total\n`)
}
