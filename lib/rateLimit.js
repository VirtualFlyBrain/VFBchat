import fs from 'fs'
import path from 'path'

import { getLogRootDir } from './runtimeConfig.js'

const RAW_RETENTION_DAYS = 30
const STATE_DIR = path.join(getLogRootDir(), 'security', 'state')
const STATE_FILE = path.join(STATE_DIR, 'rate-limit-state.json')
export const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_IP || '50', 10) || 50

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

function pruneState(state) {
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - RAW_RETENTION_DAYS)

  const byDay = state.by_day || {}
  for (const dayKey of Object.keys(byDay)) {
    const dayDate = new Date(`${dayKey}T00:00:00.000Z`)
    if (Number.isNaN(dayDate.getTime()) || dayDate < cutoff) {
      delete byDay[dayKey]
    }
  }

  state.by_day = byDay
  return state
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    return pruneState(JSON.parse(raw))
  } catch {
    return { by_day: {} }
  }
}

// This file is a per-IP, per-day request count: personal data under UK GDPR, the
// same class governance.js locks to 0600 with a comment explaining that access
// to IP-bearing files is enforced by the filesystem and not only by who has a
// shell on the host. This one was written at the process umask, typically 0644,
// in the same log volume. The mode goes on the TEMP file so the rename carries
// it — setting it afterwards leaves a window where it is world-readable.
const FILE_MODE = 0o600
const DIR_MODE = 0o700

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: DIR_MODE })
  const tempFile = `${STATE_FILE}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(pruneState(state), null, 2), { encoding: 'utf8', mode: FILE_MODE })
  fs.renameSync(tempFile, STATE_FILE)
}

export function checkAndIncrement(clientIp) {
  const state = readState()
  const dayKey = todayKey()

  state.by_day[dayKey] = state.by_day[dayKey] || {}
  const used = state.by_day[dayKey][clientIp] || 0

  if (used >= RATE_LIMIT) {
    return { allowed: false, used, limit: RATE_LIMIT }
  }

  state.by_day[dayKey][clientIp] = used + 1
  writeState(state)

  return { allowed: true, used: used + 1, limit: RATE_LIMIT }
}

export function getRateInfo(clientIp) {
  const state = readState()
  const dayKey = todayKey()
  const used = state.by_day?.[dayKey]?.[clientIp] || 0

  return {
    used,
    limit: RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - used)
  }
}
