#!/usr/bin/env node
// Measure a synthesis-prompt change against the live model, before shipping it.
//
// WHY THIS EXISTS
//
// The code-handoff rule in lib/orchestrator.mjs took three releases to get
// right, and each iteration cost an edit, a production build, a server restart
// and a two-turn live conversation — several minutes to observe ONE sample of a
// stochastic behaviour. That instrument is wrong twice over: too slow to
// iterate on, and n=1 on something that varies run to run, so "my fix worked"
// and "this run happened not to fail" are indistinguishable. All three of those
// iterations were shipped on a single sample each.
//
// Run through this harness afterwards, the same variants measured:
//
//   no rule at all ................................  2/8   clean
//   prohibitions only (all three shipped rounds) .. 16/20  clean
//   positive framing, NO worked example ...........  0/20  clean
//   positive framing WITH a placeholder example ... 20/20  clean
//
// The version that took three releases to write was not the best one; the
// prohibitions were never the mechanism; and the worked example — which looked
// like decoration — was carrying the entire effect. None of that is visible at
// n=1, and all of it took about four minutes to establish here.
//
// TWO THINGS THAT MAKE OR BREAK THE MEASUREMENT
//
// 1. Build the prompt through runHarness, never by hand. A hand-written fixture
//    scored one variant 20/20 that the live service was visibly failing. The
//    real prompt is ~4.7k characters of competing instructions, and a rule that
//    wins in a short prompt loses in a long one — competing with the rest of the
//    prompt IS the thing being measured.
//
// 2. Mirror the role's sampling exactly, including enable_thinking. Left to
//    think, a reasoning model spends the whole token budget on its chain of
//    thought and returns empty `content` — which the first version of this
//    scored as a perfect result, five times running. A measurement that cannot
//    tell silence from success is worse than no measurement.
//
// USAGE
//   node scripts/prompt-lab.mjs [runsPerVariant]
//   LAB_TERM="Kenyon cell" node scripts/prompt-lab.mjs 10
//
// Reads .env.local when ELM_API_KEY is not already in the environment. Costs one
// model call per variant per run.

import fs from 'node:fs'
import { runHarness } from '../lib/orchestrator.mjs'

const env = process.env.ELM_API_KEY ? process.env : Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
// The model PRODUCTION runs, which is not necessarily the one .env.local names:
// that file still lists Llama 3.3 and the deployment overrides it to Qwen. A
// first version of this read ELM_MODEL and quietly measured the wrong model —
// the shipped rule dropped from 20/20 to 4/10 and nothing in the output said
// why. Override with LAB_MODEL when testing a different one deliberately.
const MODEL = process.env.LAB_MODEL || 'Qwen/Qwen3.5-397B-A17B-FP8'
const RUNS = Number(process.argv[2] || 10)
const TERM = process.env.LAB_TERM || 'medulla'

async function ask(messages) {
  const res = await fetch(`${env.ELM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ELM_API_KEY}` },
    // The synth role's own sampling, from lib/roleProfiles.mjs. enable_thinking
    // false is not optional here — see the header.
    body: JSON.stringify({
      model: MODEL, messages, temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false }
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const m = (await res.json()).choices?.[0]?.message || {}
  const text = String(m.content || '')
  if (!text.trim()) throw new Error('empty content — is enable_thinking leaking back on?')
  return text
}

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'vfb_run_query', purpose: 'run a catalogue query', parameters: { type: 'object', required: ['id', 'query_type'], properties: { id: { type: 'string' }, query_type: { type: 'string' } } } }
]

// A reviewed-docs page showing a library method nobody asked about — the input
// that drove the worst production failure, where the answer explained what
// get_similar_neurons is for and contrasted it with the actual question.
const DOC_PAGE = "VFB_connect quickstart. Import the library with `from vfb_connect import vfb`. To find neurons of similar morphology use vfb.get_similar_neurons('VFB_00101567'), which returns NBLAST-scored matches."

/** The genuine synthesis messages, built through the real code path. */
async function realPrompt(question, term) {
  let messages = null
  const plan = {
    intent: 'connectivity', underspecified: false, clarifying_question: '',
    terms_to_resolve: [term],
    steps: [{ id: 's1', tool: 'vfb_run_query', answers: [question] }]
  }
  const deps = {
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 8,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') return { ok: true, value: plan }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: `VFB has annotated 471 neuron types with some part in the ${term}`, verbatim: '471 neuron types' } }
      if (schemaName?.endsWith('_args')) return { ok: true, value: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }
      return { ok: false }
    },
    async callText({ messages: m }) { messages = m; return 'ANSWER' },
    async runTool(name) {
      if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00003748', label: term, original_label: term, facets_annotation: ['Entity', 'Class', 'Anatomy'] }] } }
      if (name === 'vfb_get_term_info') {
        return { Id: 'FBbt_00003748', Name: term, Meta: { Description: `the ${term}` }, Publications: [],
          Queries: [{ label: 'NeuronsPartHere', count: 471, query: 'NeuronsPartHere' }, { label: 'ImagesNeurons', count: 12, query: 'ImagesNeurons' }] }
      }
      if (name === 'vfb_run_query') return { rows: [{ label: 'Dm8b' }, { label: 'Tm20' }], count: 471 }
      if (name === 'search_reviewed_docs') return { results: [{ id: 'p', title: 'VFB_connect quickstart', url: 'https://vfb-connect.readthedocs.io/en/stable/tutorials/overview.html' }] }
      if (name === 'get_reviewed_page') return DOC_PAGE
      return { ok: true }
    },
    searchReviewedDocs: async () => [{ id: 'p', title: 'VFB_connect quickstart', url: 'https://vfb-connect.readthedocs.io/en/stable/tutorials/overview.html' }],
    getReviewedPage: async () => DOC_PAGE
  }
  await runHarness(question, deps)
  if (!messages) throw new Error(`synthesis did not run for "${question}"`)
  return messages
}

// Every check is a failure mode taken from a real production answer.
const CHECKS = {
  wrote_code: t => /```/.test(t) || /\bvfb\.\w+\(|\bimport vfb|from vfb_connect/.test(t),
  named_method: t => /\b(get_similar_neurons|get_subclasses|get_instances|get_TermInfo|neo_query_wrapper|gen_short_form|vfb_id_2_xrefs|neuron_types_that_overlap)\b/.test(t),
  gestured: t => /\b(a |the )?VFB function\b|the relevant method|the appropriate (command|method|function)|using VFB with/i.test(t),
  capability_claim: t => /\b(cannot|can't|does not (show|support|provide|have)|no direct|not designed for|in one step|not possible|without prior)\b/i.test(t),
  contrasted_evidence: t => /similar[_ ]neurons/i.test(t),
  too_long: t => t.trim().split(/\n\s*\n/).length > 3,
  // Broader than `gestured`: any sentence whose subject is the MECHANISM rather
  // than the data. "is obtained by running the NeuronsPartHere query using
  // vfb_connect" names no function and still spends the answer on plumbing. The
  // narrow check missed it, which is how a variant scored clean while reading
  // exactly like the failure it was written against.
  mechanism_talk: t => /\b(run|running|use|using|call|calling|execute|executing|invoke|pass|passing)\b[^.]{0,60}\b(quer(y|ies)|command|function|method|api|wrapper|argument)\b/i.test(t)
}

const question = 'How would I get that same result with vfb_connect?'
const base = await realPrompt(question, TERM)
const userMsg = base[1].content
const idx = userMsg.indexOf('\n\nCODE IS ALREADY SUPPLIED FOR THIS ANSWER.')
if (idx < 0) throw new Error('the shipped code block is not in the real prompt — check its fire conditions')
const closingIdx = userMsg.indexOf('\n\nWrite the answer, never where the answer came from')
const shipped = userMsg.slice(idx, closingIdx)

console.log(`term: ${TERM} | real prompt ${userMsg.length} chars | shipped rule ${shipped.length} chars | ${RUNS} runs each\n`)

// The control, and the ablation that matters: the same rule with its worked
// example removed. Keep it — it is what stops anyone "tidying" the example away.
const noExample = shipped.replace(/ Like this:\n\n {2}"[^"]*"\n/, ' ')
const VARIANTS = { 'shipped': shipped, 'shipped minus example': noExample, 'no rule at all': '' }

const results = {}
for (const [name, rule] of Object.entries(VARIANTS)) {
  const messages = [base[0], { role: 'user', content: userMsg.slice(0, idx) + rule + userMsg.slice(closingIdx) }]
  const tally = Object.fromEntries(Object.keys(CHECKS).map(k => [k, 0]))
  const samples = []
  let errors = 0
  for (let i = 0; i < RUNS; i++) {
    let t
    try { t = await ask(messages) } catch { errors++; continue }
    samples.push(t)
    for (const [k, fn] of Object.entries(CHECKS)) if (fn(t)) tally[k]++
  }
  const clean = samples.filter(t => !Object.values(CHECKS).some(fn => fn(t))).length
  const words = samples.map(t => t.trim().split(/\s+/).length).sort((a, b) => a - b)
  results[name] = { clean, scored: samples.length, errors, tally, median: words[Math.floor(words.length / 2)] || 0, samples }
  const bad = Object.entries(tally).filter(([, v]) => v).map(([k, v]) => `${k}×${v}`).join(' ')
  console.log(`=== ${name} — clean ${clean}/${samples.length}${errors ? ` (${errors} errored)` : ''}, median ${results[name].median} words`)
  if (bad) console.log(`    ${bad}`)
  console.log(`    ${(samples[0] || '').replace(/\s+/g, ' ').slice(0, 180)}\n`)
}

console.log('================ SUMMARY ================')
for (const [n, r] of Object.entries(results)) console.log(`${String(r.clean).padStart(3)}/${r.scored}  ${n}`)
fs.writeFileSync('/tmp/prompt-lab-results.json', JSON.stringify(results, null, 1))
console.log('\nfull samples: /tmp/prompt-lab-results.json')
