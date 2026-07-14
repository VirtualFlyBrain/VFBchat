#!/usr/bin/env node
// Grade an existing task-battery results JSON with an LLM-as-judge.
//
// Adds the correctness signal the runner lacks, WITHOUT re-running the (slow)
// battery: it grades the recorded responses. Run after a battery run, or on the
// committed baseline, to get pass/partial/fail + mean correctness.
//
// Usage:
//   node scripts/grade-battery.mjs                         # grades test-results/task-battery/latest.json
//   node scripts/grade-battery.mjs <results.json>
//   node scripts/grade-battery.mjs --json                  # machine-readable summary
//
// Judge model: VFB_MODEL_JUDGE → ELM_MODEL (default local Llama). A stronger
// model (e.g. gpt-4.1) grades domain correctness better but is proxied off-site
// — a data-governance choice. Reads ELM_* from env or .env.local. Key never logged.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callStructured } from '../lib/elmClient.mjs'
import { resolveRoleModel } from '../lib/structuredOutput.mjs'
import { JUDGE_SCHEMA, buildJudgeMessages, aggregate } from '../lib/battery/grade.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const fileArg = process.argv.slice(2).find(a => !a.startsWith('--'))
const RESULTS_FILE = path.resolve(fileArg || path.join(REPO_ROOT, 'test-results/task-battery/latest.json'))

function loadDotEnv() {
  const file = path.join(REPO_ROOT, '.env.local')
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('='); if (eq === -1) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!(k in process.env)) process.env[k] = v
  }
}
loadDotEnv()

const BASE = (process.env.ELM_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/$/, '')
const KEY = process.env.ELM_API_KEY || process.env.OPENAI_API_KEY || ''
const MODEL = resolveRoleModel('judge')

async function main() {
  if (!BASE || !KEY) { console.error('Missing ELM_BASE_URL / ELM_API_KEY (env or .env.local).'); process.exit(2) }
  if (!fs.existsSync(RESULTS_FILE)) { console.error(`Results file not found: ${RESULTS_FILE}`); process.exit(2) }

  const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'))
  const results = Array.isArray(data) ? data : (data.results || [])
  if (!results.length) { console.error('No results to grade.'); process.exit(2) }

  if (!JSON_OUT) {
    console.log(`Grading ${results.length} responses from ${path.basename(RESULTS_FILE)}`)
    console.log(`  judge model: ${MODEL}\n`)
  }

  const graded = []
  for (const r of results) {
    const res = await callStructured({
      baseUrl: BASE, apiKey: KEY, model: MODEL,
      messages: buildJudgeMessages(r), schema: JUDGE_SCHEMA, schemaName: 'verdict',
      maxAttempts: 2, temperature: 0
    })
    const v = res.ok ? res.value : { answered: false, grounded: false, gave_up_or_errored: true, correctness: 0, verdict: 'fail', reason: `judge failed: ${res.error}` }
    const row = { task_id: r.task_id, tier: r.tier, duration_ms: r.duration_ms, ...v }
    graded.push(row)
    if (!JSON_OUT) {
      const tag = v.verdict === 'pass' ? '\x1b[32mPASS\x1b[0m' : v.verdict === 'partial' ? '\x1b[33mPART\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
      console.log(`  [${tag}] ${r.task_id} corr=${(v.correctness ?? 0).toFixed(2)} — ${v.reason}`)
    }
  }

  const summary = aggregate(graded)
  const out = { source: path.basename(RESULTS_FILE), judge_model: MODEL, generated: new Date().toISOString(), summary, graded }
  const outPath = RESULTS_FILE.replace(/\.json$/, '.graded.json')
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))

  if (JSON_OUT) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log(`\nSummary: ${summary.pass}/${summary.total} pass, ${summary.partial} partial, ${summary.fail} fail`)
    console.log(`  pass rate: ${(summary.pass_rate * 100).toFixed(0)}%   mean correctness: ${summary.mean_correctness.toFixed(2)}   gave-up/errored: ${summary.gave_up_or_errored}`)
    if (summary.failures.length) {
      console.log('  not passing:')
      for (const f of summary.failures) console.log(`    ${f.task_id} (${f.verdict}): ${f.reason}`)
    }
    console.log(`\nWrote ${outPath}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
