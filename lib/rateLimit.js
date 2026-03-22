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

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tempFile = `${STATE_FILE}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(pruneState(state), null, 2), 'utf8')
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
