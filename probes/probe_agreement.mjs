// Is self-consistency agreement a usable COMPLEXITY SIGNAL?
//
// VFBchat already runs the planner k=3 and majority-votes. callStructuredVoted
// returns `agreement` — and liveHarness throws it away. If agreement is low
// exactly on the questions where thinking changes the plan, then we get
// complexity routing for free, with no classifier, no prediction, and no
// second model: just re-plan with enable_thinking when the votes disagree.
import fs from 'node:fs'
import { buildPlannerMessages, PLAN_SCHEMA, normalizePlan } from '../lib/planner.mjs'
import { callStructured } from '../lib/elmClient.mjs'
import { majorityVote, canonicalKey } from '../lib/structuredOutput.mjs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'
const TOOLS = JSON.parse(fs.readFileSync('/tmp/tooldefs.json', 'utf8'))
  .map(t => ({ name: t.name, purpose: t.description || '' }))
const QWEN = 'Qwen/Qwen3.5-397B-A17B-FP8'
const NOTHINK = { chat_template_kwargs: { enable_thinking: false } }

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

// Vote at a NON-ZERO temperature. At temperature 0 three votes are three
// copies of the same generation, so agreement is always 1.0 and the signal is
// dead — which is exactly the state the shipped code is in.
const K = 3
const TEMP = 0.7

// Vote on the DECISION (intent + tool sequence), not on incidental string
// fields: two plans that differ only in step wording are not a disagreement.
const decisionKey = (v) => {
  const p = normalizePlan(v, '')
  return canonicalKey({ intent: p.intent, steps: (p.steps || []).map(s => s.tool) })
}

console.log(`k=${K} temperature=${TEMP} model=qwen thinking-OFF\n`)
for (const [tag, q] of QUESTIONS) {
  const messages = buildPlannerMessages(q, TOOLS, [])
  const t = Date.now()
  const runs = await Promise.all(Array.from({ length: K }, () => callStructured({
    baseUrl: BASE, apiKey: KEY, model: QWEN, messages,
    schema: PLAN_SCHEMA, schemaName: 'plan',
    temperature: TEMP, extraBody: { ...NOTHINK, top_p: 0.8, top_k: 20 }, timeoutMs: 240000
  })))
  const vals = runs.filter(r => r.ok).map(r => r.value)
  const vote = majorityVote(vals, decisionKey)
  const variants = [...new Set(vals.map(decisionKey))]
  const secs = ((Date.now() - t) / 1000).toFixed(1)
  console.log(`${tag.padEnd(6)} agreement=${vote.agreement?.toFixed(2)} (${vote.count}/${vote.total}) distinct=${variants.length} ${secs}s`)
  for (const v of variants) console.log(`        ${v}`)
}
