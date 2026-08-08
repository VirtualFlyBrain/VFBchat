// The rate-limit state file is a per-IP, per-day request count. That is personal
// data under UK GDPR, and it sits in the same log volume as the security events
// governance.js deliberately locks to 0600 — with a comment explaining that
// access to IP-bearing files is enforced by the filesystem, not only by who has
// a shell on the host. This file was written at the process umask.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('the state file carrying client IPs is not world-readable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfb-rl-'))
  process.env.LOG_ROOT_DIR = dir
  process.env.RATE_LIMIT_PER_IP = '5'
  // Write through immediately: the limiter buffers in memory and flushes on a
  // timer, because a synchronous read-modify-write of the whole 30-day state
  // before every request stalls every other request on the event loop.
  process.env.VFB_RATE_LIMIT_FLUSH_MS = '0'
  // Fresh import so the module picks up the log root.
  const { checkAndIncrement, flushState } = await import('../../lib/rateLimit.js?mode-test=' + Date.now())
  checkAndIncrement('203.0.113.7')
  flushState()

  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.includes('rate-limit')) found.push(full)
    }
  }
  walk(dir)
  assert.ok(found.length, 'expected a rate-limit state file to have been written')
  for (const f of found) {
    const mode = fs.statSync(f).mode & 0o777
    assert.equal(mode & 0o077, 0, `${f} is mode ${mode.toString(8)} — group/other must have no access`)
  }
  delete process.env.VFB_RATE_LIMIT_FLUSH_MS
})

test('a forged X-Forwarded-For cannot grow the state without bound', async () => {
  // The key is the leftmost value of a header the client controls, so a script
  // sending a fresh one each time both defeats the limit and grows the day's map
  // — after which every legitimate request pays the parse and serialise of a
  // multi-megabyte JSON before any work starts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfb-rl-keys-'))
  process.env.LOG_ROOT_DIR = dir
  process.env.VFB_RATE_LIMIT_MAX_KEYS = '100'
  process.env.VFB_RATE_LIMIT_FLUSH_MS = '0'
  const { checkAndIncrement, flushState } = await import('../../lib/rateLimit.js?keys-test=' + Date.now())

  for (let i = 0; i < 500; i++) checkAndIncrement(`198.51.100.${i}`)
  flushState()

  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === 'rate-limit-state.json') found.push(full)
    }
  }
  walk(dir)
  const state = JSON.parse(fs.readFileSync(found[0], 'utf8'))
  const day = Object.values(state.by_day)[0] || {}
  assert.ok(Object.keys(day).length <= 100, `tracked ${Object.keys(day).length} keys, cap is 100`)

  // ...and a client already being tracked is still limited correctly.
  const known = checkAndIncrement('198.51.100.0')
  assert.ok(known.used >= 1)

  delete process.env.VFB_RATE_LIMIT_MAX_KEYS
  delete process.env.VFB_RATE_LIMIT_FLUSH_MS
  delete process.env.LOG_ROOT_DIR
})
