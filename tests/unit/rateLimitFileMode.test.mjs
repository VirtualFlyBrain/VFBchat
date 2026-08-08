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
  // Fresh import so the module picks up the log root.
  const { checkAndIncrement } = await import('../../lib/rateLimit.js?mode-test=' + Date.now())
  checkAndIncrement('203.0.113.7')

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
})
