// Retention, and the guard that keeps question text off container stdout.
//
// Both of these exist because a published commitment and the implemented
// behaviour had diverged. The privacy notice promises raw security logs are kept
// for up to 30 days; `pruneRetention()` sat inside the `initialized` guard, so on
// a container that stayed up it ran exactly once, at the first request after
// start, and then never again. And the v4 planner diagnostic put the first 120
// characters of every question onto stdout — outside the three governed layers,
// never pruned — reintroducing a pattern the March 2026 checklist had removed.
//
// Recommended additions §7.1 and §7.2 of 10-evaluation-plan.md. §7.2 is the one
// that matters most: it is the guard that stops a diagnostic quietly widening the
// data surface for a third time.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const ROUTE = new URL('../../app/api/chat/route.js', import.meta.url)

function isoDaysAgo(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

// ------------------------------------------------------- §7.1 retention ----

test('the retention prune deletes a security log outside the 30-day window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfb-retention-'))
  process.env.LOG_ROOT_DIR = root
  // Imported after the env var is set: the log root is read through
  // runtimeConfig, and these modules cache nothing across a fresh import.
  const { ensureGovernanceStorage, getGovernancePaths, pruneRetention } =
    await import(`../../lib/governance.js?retention=${Date.now()}`)

  ensureGovernanceStorage()
  const { securityEventsDir } = getGovernancePaths()

  const stale = path.join(securityEventsDir, `${isoDaysAgo(45)}.jsonl`)
  const fresh = path.join(securityEventsDir, `${isoDaysAgo(2)}.jsonl`)
  fs.writeFileSync(stale, '{"ip":"203.0.113.7"}\n')
  fs.writeFileSync(fresh, '{"ip":"203.0.113.8"}\n')

  pruneRetention()

  assert.equal(fs.existsSync(stale), false, 'a 45-day-old raw security log must be gone')
  assert.equal(fs.existsSync(fresh), true, 'a 2-day-old one must not be')
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.LOG_ROOT_DIR
})

test('retention keeps running on a long-lived process, not once at startup', async () => {
  // The defect exactly: a file that ages past the window while the container is
  // up was never revisited, because the prune sat behind the initialized flag.
  //
  // The sweep is now throttled — five readdirSync calls per request stall every
  // other request sharing the event loop — so the property under test is that it
  // runs AGAIN, not that it runs on literally every call. VFB_PRUNE_INTERVAL_MS=0
  // makes "again" immediate here; production leaves it at an hour, which is
  // ample for a 30-day cutoff.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfb-retention2-'))
  process.env.LOG_ROOT_DIR = root
  process.env.VFB_PRUNE_INTERVAL_MS = '0'
  const { ensureGovernanceStorage, getGovernancePaths } =
    await import(`../../lib/governance.js?retention2=${Date.now()}`)

  ensureGovernanceStorage()                       // first request of the process
  const { securityEventsDir } = getGovernancePaths()
  const stale = path.join(securityEventsDir, `${isoDaysAgo(60)}.jsonl`)
  fs.writeFileSync(stale, '{"ip":"203.0.113.9"}\n')

  ensureGovernanceStorage()                       // a later request, same process
  assert.equal(fs.existsSync(stale), false,
    'a later request must prune; otherwise a long-lived container keeps IPs forever')

  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.LOG_ROOT_DIR
  delete process.env.VFB_PRUNE_INTERVAL_MS
})

test('the retention sweep is throttled off the per-request path', async () => {
  // Five readdirSync calls per request is a synchronous disk touch on the shared
  // event loop, and under concurrency that is every request stalling every other.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfb-retention3-'))
  process.env.LOG_ROOT_DIR = root
  process.env.VFB_PRUNE_INTERVAL_MS = '3600000'
  const { ensureGovernanceStorage, getGovernancePaths } =
    await import(`../../lib/governance.js?retention3=${Date.now()}`)

  ensureGovernanceStorage()
  const { securityEventsDir } = getGovernancePaths()
  const stale = path.join(securityEventsDir, `${isoDaysAgo(60)}.jsonl`)
  fs.writeFileSync(stale, '{"ip":"203.0.113.9"}\n')

  ensureGovernanceStorage()
  assert.equal(fs.existsSync(stale), true,
    'within the interval the sweep should not re-run')

  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.LOG_ROOT_DIR
  delete process.env.VFB_PRUNE_INTERVAL_MS
})

test('governance files are created owner-only', async () => {
  if (process.platform === 'win32') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfb-mode-'))
  process.env.LOG_ROOT_DIR = root
  const { logSecurityEvent, getGovernancePaths } =
    await import(`../../lib/governance.js?mode=${Date.now()}`)

  logSecurityEvent({ type: 'test', detail: 'mode check' })
  const { securityEventsDir } = getGovernancePaths()
  const files = fs.readdirSync(securityEventsDir).map(f => path.join(securityEventsDir, f))
  assert.ok(files.length, 'the event was written somewhere')
  for (const f of files) {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${path.basename(f)} must be owner-only`)
  }
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.LOG_ROOT_DIR
})

// --------------------------------------------------- §7.2 stdout guard -----

test('nothing in the request path writes the user question to console outside the trace flag', () => {
  const src = readFileSync(ROUTE, 'utf8')
  const lines = src.split('\n')

  // A console.* line is "guarded" if the nearest enclosing `if` within a few
  // lines above it tests VFB_HARNESS_TRACE. Deliberately crude: a diagnostic
  // that is hard for this check to see is also hard for a reviewer to see.
  const guarded = new Set()
  lines.forEach((line, i) => {
    if (!/VFB_HARNESS_TRACE\s*===\s*'true'/.test(line)) return
    for (let j = i; j < Math.min(lines.length, i + 40); j++) guarded.add(j)
  })

  const QUESTION_SOURCES = /\buserMessage\b|\bquestion\b|\bcleanArgs\.(upstream|downstream)_type\b/
  const offenders = []
  lines.forEach((line, i) => {
    if (!/console\.(log|error|warn|info|debug)\s*\(/.test(line)) return
    if (!QUESTION_SOURCES.test(line)) return
    if (guarded.has(i)) return
    offenders.push(`${i + 1}: ${line.trim().slice(0, 120)}`)
  })

  assert.deepEqual(offenders, [],
    'question text must not reach container stdout: it is outside the governed layers and is never pruned')
})

test('the planner and grounding diagnostics still log something correlatable', () => {
  // Removing the question must not have removed the diagnostic. The request id
  // is what correlation is for, and it is what should be there instead.
  const src = readFileSync(ROUTE, 'utf8')
  assert.match(src, /\[VFBchat\] PLAN \| tier=/, 'the planner diagnostic survives')
  assert.match(src, /\[VFBchat\] GROUNDING \| leaked_ids=/, 'the grounding audit survives')
  assert.ok(!/\[VFBchat\] PLAN[^\n]*\| q=\$/.test(src), 'but without the question')
  assert.ok(!/\[VFBchat\] GROUNDING[^\n]*\| q=\$/.test(src), 'and neither does the grounding line')
})
