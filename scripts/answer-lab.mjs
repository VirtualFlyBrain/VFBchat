#!/usr/bin/env node
// Score whole ANSWERS, not one prompt block, against the live model.
//
// scripts/prompt-lab.mjs measures one conditional block in isolation. This runs
// real questions through the real pipeline — planner, tools, synthesiser — and
// scores what comes back, so a change can be judged on "did answers get better"
// rather than "did the block I edited behave".
//
// Two kinds of check, deliberately kept apart:
//
//   DETERMINISTIC   pattern checks for failure modes seen in production. Cheap,
//                   exact, no model, no disagreement about what they mean.
//   JUDGED          a rubric scored by the same model, which is the only way to
//                   ask "does this answer the question". Judged scores are
//                   reported separately and never folded into the deterministic
//                   count, because a model marking its own homework is evidence,
//                   not proof.
//
// The judge is given the ANSWER and the SOURCES the run actually cited, and is
// asked to name specific unsupported sentences rather than award a vibe score.
// A critique that names a sentence can be acted on; a number out of ten cannot.
//
//   node scripts/answer-lab.mjs                      # the default question set
//   ANSWER_LAB_N=3 node scripts/answer-lab.mjs       # 3 samples per question
//   ANSWER_LAB_BASE=http://127.0.0.1:3210 node scripts/answer-lab.mjs
//   ANSWER_LAB_JSONL=/tmp/run.jsonl node scripts/answer-lab.mjs   # rows appended as they land

import fs from 'node:fs'

// .env.local is a convenience, not a requirement. It used to be read
// unconditionally at import, so the whole script threw on any machine without
// it — including the deterministic half, which needs no credentials at all.
function readEnvFile() {
  try {
    return Object.fromEntries(
      fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    )
  } catch { return {} }
}
const env = process.env.ELM_API_KEY ? process.env : { ...readEnvFile(), ...process.env }
const BASE = process.env.ANSWER_LAB_BASE || 'http://127.0.0.1:3210'
// The model production runs, not the one .env.local names — see prompt-lab.mjs.
const MODEL = process.env.LAB_MODEL || 'Qwen/Qwen3.5-397B-A17B-FP8'
const N = Number(process.env.ANSWER_LAB_N || 1)
const JSONL = process.env.ANSWER_LAB_JSONL || '/tmp/answer-lab.jsonl'

// A spread of shapes, each of which has failed differently at some point.
const QUESTIONS = (process.env.ANSWER_LAB_QUESTIONS || '').trim()
  ? JSON.parse(process.env.ANSWER_LAB_QUESTIONS)
  : [
      { id: 'Q1', q: 'What is the ellipsoid body?', shape: 'definition' },
      { id: 'Q2', q: 'Which neurons have part of them in the medulla?', shape: 'region membership' },
      { id: 'Q3', q: 'What neurotransmitter do Kenyon cells use?', shape: 'data-derived fact' },
      { id: 'Q4', q: 'What split-GAL4 lines label the lateral horn?', shape: 'reagents' },
      { id: 'Q5', q: 'How many neurons are in the adult central brain?', shape: 'count' },
      { id: 'Q6', q: 'What does the ellipsoid body do?', shape: 'function — the ungrounded-claim trap' }
    ]

async function ask(question) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.96.0.7' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }], scene: {} })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', result = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const ev = JSON.parse(line.slice(5).trim())
          if (ev.response || ev.sources || ev.context) result = ev
        } catch {}
      }
    }
  }
  return result || {}
}

async function judge(question, answer, sources) {
  // No credentials: the deterministic half still runs and the rows still land.
  // Judged fields come back null rather than the run failing.
  if (!env.ELM_API_KEY || !env.ELM_BASE_URL) return null
  const messages = [
    { role: 'system', content: 'You assess answers from a Drosophila neuroanatomy assistant. Be exacting and concrete. Reply ONLY with JSON.' },
    { role: 'user', content: `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\nSOURCES THE ANSWER WAS ALLOWED TO USE (documentation pages, and the VFB catalogue queries this run actually ran - a figure or list of names attributable to one of those queries IS supported):\n${JSON.stringify(sources)}\n\nReturn JSON with exactly these keys:
{"answers_the_question": true|false,
 "unsupported": ["verbatim sentence from the answer that the sources do not support", ...],
 "hedging": ["verbatim sentence that promises or defers rather than answering", ...],
 "would_a_researcher_act_on_this": true|false}

Rules. "unsupported" means a factual claim about flies, VFB's holdings, or a library's behaviour that nothing in SOURCES establishes — quote it verbatim, do not paraphrase, and return an empty list if there is none. Background biology stated as background is not unsupported; the same biology asserted as a VFB record is. Do not reward length.` }
  ]
  const res = await fetch(`${env.ELM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ELM_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 900,
      chat_template_kwargs: { enable_thinking: false } })
  })
  const txt = String((await res.json()).choices?.[0]?.message?.content || '')
  const m = txt.match(/\{[\s\S]*\}/)
  try { return m ? JSON.parse(m[0]) : { parse_error: txt.slice(0, 120) } } catch { return { parse_error: txt.slice(0, 120) } }
}

// Failure modes with a production example behind each one.
// Each check takes (answer, ctx). ctx.vfbQueries is how many VFB queries the run
// actually ran, which is the difference between an honest absence statement and
// the failure mode this check was written for.
const CHECKS = {
  empty: a => !a.trim(),
  // "VFB does not currently hold data on X" about a query NOTHING RAN.
  //
  // The phrasing alone is not the defect — it is the phrasing the integrity
  // rules REQUIRE, and saying it after running the query is exactly right. This
  // check used to match on the words only, so on the production baseline it
  // fired on four of the five runs of "what does the ellipsoid body do?", every
  // one of which had behaved correctly: given the anatomy, declined to assert
  // function, said so in the mandated words. Penalising correct behaviour is
  // worse than not checking, and it made the headline number wrong in the
  // reassuring direction.
  // What the run had to go on is `vfbEvidence`: queries it ran PLUS terms it
  // resolved. A resolved term's catalogue is itself evidence of absence — "VFB
  // has no split-GAL4 query for this region" is established by reading what the
  // region offers, without running anything. So the flag is reserved for the
  // case that is always wrong: asserting what VFB does not hold having looked
  // at nothing.
  absence_claim: (a, ctx) =>
    /\b(does not (currently )?hold|no data (is )?available|are no )\b/i.test(a) &&
    !(ctx && ctx.vfbEvidence > 0),
  // Narrating the plumbing instead of the data.
  mechanism_talk: a => /\b(run|running|use|using|call|calling)\b[^.]{0,60}\b(quer(y|ies)|command|function|method|api|wrapper)\b/i.test(a),
  // A code block nobody asked for.
  unrequested_code: a => /```/.test(a),
  // Describing the input rather than the world.
  names_its_input: a => /\b(the provided|the supplied|available information|based on the (evidence|information)|according to the documentation)\b/i.test(a),
  // Sending the reader somewhere else for the actual answer.
  defers: a => /\b(consult the|refer to the|see the .{0,20}(guide|documentation|page)|for (more )?details,? (see|refer))\b/i.test(a)
}

const rows = []
for (const item of QUESTIONS) {
  for (let rep = 1; rep <= N; rep++) {
    const t0 = Date.now()
    let r, err = null
    try { r = await ask(item.q) } catch (e) { err = e.message; r = {} }
    const answer = String(r.response || '')
    // The judge must see the VFB QUERIES the run made, not only the
    // documentation pages it cited. The first version passed `sources` alone and
    // duly flagged "VFB holds data on 471 neuron types in the medulla" as
    // unsupported - a figure that came straight from a NeuronsPartHere query the
    // judge had no way to know about. An instrument that scores grounded facts
    // as hallucinations would make any "quality improved" claim worthless, which
    // is the exact failure this whole approach exists to prevent.
    const sources = [
      ...(r.sources || []).map(s => s.title || s.url || s),
      ...((r.reproduction?.calls || []).map(c => `VFB query ${c.query_type} on ${c.id} (${c.label})`)),
      // The COUNTS, not only the query names. Shown the name alone, the judge
      // marked "VFB has annotated 471 neuron types that have some part in the
      // medulla" as unsupported — a figure that came straight from the
      // NeuronsPartHere query it was being told about, because nothing told it
      // what that query returned. An instrument that scores grounded facts as
      // hallucinations makes any "quality improved" claim worthless, which is
      // the exact failure this whole approach exists to prevent.
      ...((r.tables || []).map(t =>
        `VFB query ${t.queryType} on ${t.termLabel || t.termId} returned count ${t.count}` +
        (t.countKind ? ` (${t.countKind})` : '') +
        (Array.isArray(t.rows) ? `, ${t.rows.length} preview rows` : '')))
    ]
    const vfbQueries = (r.reproduction?.calls || []).length
    const vfbEvidence = vfbQueries + (r.terms || []).length
    const failed = Object.entries(CHECKS).filter(([, fn]) => fn(answer, { vfbQueries, vfbEvidence })).map(([k]) => k)
    const verdict = (err || !answer) ? null : await judge(item.q, answer, sources)
    const row = {
      id: item.id, rep, shape: item.shape, question: item.q, err,
      seconds: Math.round((Date.now() - t0) / 1000),
      chars: answer.length, sources: sources.length, vfbQueries, vfbEvidence,
      terms: (r.terms || []).length, flags: failed, verdict, answer
    }
    rows.push(row)
    // Append as it lands. A production run of this script was killed after ten
    // completed answers and left nothing behind, because the JSON was only
    // written at the end — an hour of live inference with no evidence.
    try { fs.appendFileSync(JSONL, JSON.stringify(row) + '\n') } catch { /* best effort */ }
    const v = verdict || {}
    console.log(`${item.id}.${rep} ${String(rows.at(-1).seconds).padStart(3)}s ` +
      `${String(answer.length).padStart(5)}ch src:${sources.length} ` +
      `| flags: ${failed.join(',') || '-'} ` +
      `| answers:${v.answers_the_question ?? '?'} actionable:${v.would_a_researcher_act_on_this ?? '?'} ` +
      `unsupported:${(v.unsupported || []).length} hedging:${(v.hedging || []).length}`)
    for (const u of (v.unsupported || []).slice(0, 2)) console.log(`      unsupported: ${String(u).slice(0, 150)}`)
  }
}

const scored = rows.filter(r => r.verdict && !r.err)
const pct = (n) => `${Math.round(100 * n / (scored.length || 1))}%`
console.log(`\n${'='.repeat(64)}`)
console.log(`answers scored: ${scored.length}/${rows.length}`)
console.log(`  answers the question         ${pct(scored.filter(r => r.verdict.answers_the_question).length)}`)
console.log(`  a researcher would act on it ${pct(scored.filter(r => r.verdict.would_a_researcher_act_on_this).length)}`)
console.log(`  carries an unsupported claim ${pct(scored.filter(r => (r.verdict.unsupported || []).length).length)}`)
console.log(`  hedges                       ${pct(scored.filter(r => (r.verdict.hedging || []).length).length)}`)
console.log(`  clean on deterministic checks ${pct(scored.filter(r => !r.flags.length).length)}`)
console.log(`  median seconds ${rows.map(r => r.seconds).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}`)
console.log('\nJudged scores are the same model marking its own homework: evidence,')
console.log('not proof. The deterministic flags are the part that cannot argue back.')

const out = process.env.ANSWER_LAB_JSON || '/tmp/answer-lab.json'
fs.writeFileSync(out, JSON.stringify(rows, null, 1))
console.log(`\nfull answers: ${out}`)
