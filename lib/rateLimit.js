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

// Held in memory, written through on a timer.
//
// Every request used to readFileSync + JSON.parse + JSON.stringify +
// writeFileSync the ENTIRE 30-day state, synchronously, before any work started.
// With the day's map unbounded and keyed on a header the client controls, a
// script sending a fresh X-Forwarded-For each time both defeated the limit and
// grew the file — after which every legitimate request paid the parse and the
// serialise of a multi-megabyte JSON on the shared event loop.
let cachedState = null
let stateDirty = false
let flushTimer = null

const FLUSH_INTERVAL_MS = (() => {
  const raw = Number(process.env.VFB_RATE_LIMIT_FLUSH_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1000
})()

// A ceiling on distinct client keys per day. Past it the limiter stops learning
// new keys rather than growing without bound; the keys already tracked keep
// being counted, so a real user who has been seen is still limited correctly.
const MAX_KEYS_PER_DAY = (() => {
  const raw = Number(process.env.VFB_RATE_LIMIT_MAX_KEYS)
  return Number.isFinite(raw) && raw >= 100 ? raw : 50000
})()

function getState() {
  if (!cachedState) cachedState = readState()
  return cachedState
}

function scheduleFlush() {
  stateDirty = true
  if (FLUSH_INTERVAL_MS === 0) { flushState(); return }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try { flushState() } catch { /* a lost count must not fail a request */ }
  }, FLUSH_INTERVAL_MS)
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

/** Write the buffered state now. Exported so a shutdown hook can call it. */
export function flushState() {
  if (!stateDirty || !cachedState) return
  writeState(cachedState)
  stateDirty = false
}

export function checkAndIncrement(clientIp) {
  const state = getState()
  const dayKey = todayKey()

  state.by_day[dayKey] = state.by_day[dayKey] || {}
  const today = state.by_day[dayKey]
  const known = Object.prototype.hasOwnProperty.call(today, clientIp)
  const used = today[clientIp] || 0

  if (used >= RATE_LIMIT) {
    return { allowed: false, used, limit: RATE_LIMIT }
  }

  if (!known && Object.keys(today).length >= MAX_KEYS_PER_DAY) {
    // Do not add another key. Allowing the request is the safe failure: the
    // limiter's job is to stop one client hammering the service, not to become
    // the thing that exhausts memory when someone forges the header.
    return { allowed: true, used: used + 1, limit: RATE_LIMIT, untracked: true }
  }

  today[clientIp] = used + 1
  scheduleFlush()

  return { allowed: true, used: used + 1, limit: RATE_LIMIT }
}

export function getRateInfo(clientIp) {
  const state = getState()
  const dayKey = todayKey()
  const used = state.by_day?.[dayKey]?.[clientIp] || 0

  return {
    used,
    limit: RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - used)
  }
}
