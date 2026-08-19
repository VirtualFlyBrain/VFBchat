import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

import { getGoogleAnalyticsConfig, getLogRootDir } from './runtimeConfig.js'

const RAW_RETENTION_DAYS = 30
const AGGREGATE_RETENTION_MONTHS = 26
const MAX_TRACKED_IDS = 25

let initialized = false

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

function isoNow() {
  return new Date().toISOString()
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallbackValue
  }
}

// Raw security logs carry IP addresses and attached transcripts carry whatever
// a user chose to send us. Owner-only on creation, so access to them is enforced
// by the filesystem rather than only by who has a shell on the host.
const FILE_MODE = 0o600

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  const tempFile = `${filePath}.tmp`
  // Written on the temp file, because the rename carries the mode with it and a
  // chmod after the rename would leave a window where it is world-readable.
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: FILE_MODE })
  fs.renameSync(tempFile, filePath)
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath))
  // `mode` applies only when append creates the file; an existing file keeps
  // whatever it has, so tighten it once we know it is there.
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: FILE_MODE })
  try {
    if ((fs.statSync(filePath).mode & 0o777) !== FILE_MODE) fs.chmodSync(filePath, FILE_MODE)
  } catch {
    // A log that cannot be chmodded is still a log worth having.
  }
}

function daysAgo(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

function monthsAgo(months) {
  const date = new Date()
  date.setUTCMonth(date.getUTCMonth() - months)
  return date
}

function parseDayFileName(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})\.(json|jsonl)$/)
  if (!match) return null
  return new Date(`${match[1]}T00:00:00.000Z`)
}

function parseMonthFileName(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2})\.(json|jsonl)$/)
  if (!match) return null
  return new Date(`${match[1]}-01T00:00:00.000Z`)
}

function pruneDirectoryByDate(dirPath, cutoffDate, parseFileDate) {
  if (!fs.existsSync(dirPath)) return

  for (const fileName of fs.readdirSync(dirPath)) {
    const fileDate = parseFileDate(fileName)
    if (fileDate && fileDate < cutoffDate) {
      fs.rmSync(path.join(dirPath, fileName), { force: true })
    }
  }
}

function normalizeCountMap(source = {}) {
  return Object.fromEntries(
    Object.entries(source)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TRACKED_IDS)
  )
}

function incrementMap(map, key, count = 1) {
  if (!key) return
  map[key] = (map[key] || 0) + count
}

// How often the retention sweep may run, and how often buffered analytics are
// written. Both are request-path costs that do not need to be paid per request.
const PRUNE_INTERVAL_MS = (() => {
  const raw = Number(process.env.VFB_PRUNE_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 60 * 60 * 1000
})()
const ANALYTICS_FLUSH_INTERVAL_MS = 2000
let lastPruneAt = 0

export function createRequestId() {
  return randomUUID()
}

export function getGovernancePaths() {
  const logRoot = getLogRootDir()

  return {
    logRoot,
    securityDir: path.join(logRoot, 'security'),
    securityEventsDir: path.join(logRoot, 'security', 'events'),
    blockedSearchDir: path.join(logRoot, 'security', 'blocked-searches'),
    securityStateDir: path.join(logRoot, 'security', 'state'),
    analyticsDir: path.join(logRoot, 'analytics'),
    feedbackDir: path.join(logRoot, 'feedback'),
    feedbackTranscriptDir: path.join(logRoot, 'feedback-transcripts')
  }
}

export function ensureGovernanceStorage() {
  // Directory creation is idempotent and only worth doing once.
  if (!initialized) {
    const paths = getGovernancePaths()
    ensureDir(paths.securityEventsDir)
    ensureDir(paths.blockedSearchDir)
    ensureDir(paths.securityStateDir)
    ensureDir(paths.analyticsDir)
    ensureDir(paths.feedbackDir)
    ensureDir(paths.feedbackTranscriptDir)
    initialized = true
  }

  // Retention deletion is NOT. It used to sit inside the initialized guard,
  // which meant it ran once per process — at the first request after start — so
  // a container that stayed up for two months kept IP addresses for two months
  // while the privacy notice promised thirty days. A published commitment and
  // the implemented behaviour must not be allowed to diverge on a technicality
  // of where a call sits relative to a boolean.
  //
  // Running it per request reads a handful of small directories, which is
  // nothing next to a model call, and it needs no cron, no timer and no leader
  // election: it survives restarts, redeploys and any number of replicas.
  //
  // Throttled, though. It is five readdirSync calls on the request path, and
  // under concurrency every synchronous disk touch stalls every other request
  // sharing the event loop. A 30-day and a 26-month cutoff do not need
  // re-evaluating more than once an hour, and the property that matters — that
  // it runs on a long-lived container rather than once per process — is kept.
  const now = Date.now()
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now
    pruneRetention()
  }
}

export function pruneRetention() {
  const paths = getGovernancePaths()

  pruneDirectoryByDate(paths.securityEventsDir, daysAgo(RAW_RETENTION_DAYS), parseDayFileName)
  pruneDirectoryByDate(paths.blockedSearchDir, daysAgo(RAW_RETENTION_DAYS), parseDayFileName)
  pruneDirectoryByDate(paths.analyticsDir, monthsAgo(AGGREGATE_RETENTION_MONTHS), parseDayFileName)
  pruneDirectoryByDate(paths.feedbackDir, monthsAgo(AGGREGATE_RETENTION_MONTHS), parseMonthFileName)
  pruneDirectoryByDate(paths.feedbackTranscriptDir, daysAgo(RAW_RETENTION_DAYS), parseDayFileName)
}

export function logSecurityEvent(event) {
  ensureGovernanceStorage()
  const paths = getGovernancePaths()
  const record = {
    timestamp: isoNow(),
    event_type: event.eventType,
    request_id: event.requestId || null,
    response_id: event.responseId || null,
    ip: event.ip || 'unknown',
    route: event.route || '/api/chat',
    rate_limit: event.rateLimit || null,
    abuse_flag: Boolean(event.abuseFlag),
    reason_code: event.reasonCode || null,
    error_category: event.errorCategory || null,
    error_status: event.errorStatus ?? null,
    blocked_requested_domains: Array.isArray(event.blockedRequestedDomains) ? event.blockedRequestedDomains : [],
    blocked_response_domains: Array.isArray(event.blockedResponseDomains) ? event.blockedResponseDomains : [],
    latency_ms: Number(event.latencyMs) || 0
  }

  appendJsonLine(path.join(paths.securityEventsDir, `${todayKey()}.jsonl`), record)
}

export function logBlockedSearchAudit(event) {
  if (!Array.isArray(event.blockedDomains) || event.blockedDomains.length === 0) return

  ensureGovernanceStorage()
  const paths = getGovernancePaths()

  appendJsonLine(path.join(paths.blockedSearchDir, `${todayKey()}.jsonl`), {
    timestamp: isoNow(),
    event_type: 'blocked_search_request',
    request_id: event.requestId || null,
    ip: event.ip || 'unknown',
    blocked_requested_domains: event.blockedDomains
  })
}

// The day's aggregate, held in memory between flushes.
//
// This function used to readFileSync + JSON.parse the whole day's bucket file,
// mutate it, then JSON.stringify + writeFileSync + renameSync it back — on EVERY
// request, synchronously, on the shared event loop. Under the four-concurrent
// load where peak RSS goes super-linear, every request ends by blocking the
// other three on disk I/O and full JSON serialisation, which extends how long
// each of them holds its payloads. The numbers are aggregate counters, so losing
// at most FLUSH_INTERVAL_MS of them to a hard crash is an acceptable trade for
// not stalling the loop; anything with a legal retention requirement (security
// events, feedback transcripts) is still appended synchronously, line by line.
let analyticsDay = null
let analyticsData = null
let analyticsDirty = false
let analyticsFlushTimer = null

function flushAnalytics() {
  if (!analyticsDirty || !analyticsData || !analyticsDay) return
  const paths = getGovernancePaths()
  writeJson(path.join(paths.analyticsDir, `${analyticsDay}.json`), analyticsData)
  analyticsDirty = false
}

function scheduleAnalyticsFlush() {
  analyticsDirty = true
  if (analyticsFlushTimer) return
  analyticsFlushTimer = setTimeout(() => {
    analyticsFlushTimer = null
    try { flushAnalytics() } catch { /* a lost aggregate must not fail a request */ }
  }, ANALYTICS_FLUSH_INTERVAL_MS)
  if (typeof analyticsFlushTimer.unref === 'function') analyticsFlushTimer.unref()
}

/** Write any buffered aggregate now. Exported so a shutdown hook can call it. */
export function flushAnalyticsNow() {
  if (analyticsFlushTimer) { clearTimeout(analyticsFlushTimer); analyticsFlushTimer = null }
  flushAnalytics()
}

export function recordAnalyticsEvent(event) {
  ensureGovernanceStorage()
  const paths = getGovernancePaths()
  const day = todayKey()
  const filePath = path.join(paths.analyticsDir, `${day}.json`)
  if (analyticsDay !== day) {
    // Day rolled over: flush yesterday before adopting today.
    flushAnalyticsNow()
    analyticsDay = day
    analyticsData = readJson(filePath, { version: 1, date_bucket: day, buckets: {} })
  }
  const data = analyticsData

  const institutionBucket = event.institutionBucket || 'unknown'
  const topicCategory = event.topicCategory || 'anatomy'
  const outcomeType = event.outcomeType || 'success'
  const bucketKey = [institutionBucket, topicCategory, outcomeType].join('::')

  const bucket = data.buckets[bucketKey] || {
    institution_bucket: institutionBucket,
    topic_category: topicCategory,
    outcome_type: outcomeType,
    request_count: 0,
    blocked_search_attempt_count: 0,
    total_latency_ms: 0,
    total_response_length: 0,
    total_tool_rounds: 0,
    total_images: 0,
    total_citations: 0,
    tool_usage: {},
    // Counts only. The hostnames themselves are NOT kept here.
    //
    // A blocked "requested" domain is a hostname the user typed into a question,
    // extracted by regex before any outbound call is made. This store is the
    // 26-month tier, and a fragment of what someone wrote does not belong in it —
    // the 30-day security and blocked-search logs already hold the names, which
    // is where an abuse investigation would look anyway.
    blocked_requested_domain_count: 0,
    blocked_response_domain_count: 0,
    vfb_term_ids: {}
  }

  bucket.request_count += 1
  bucket.total_latency_ms += Number(event.latencyMs) || 0
  bucket.total_response_length += Number(event.responseLength) || 0
  bucket.total_tool_rounds += Number(event.toolRounds) || 0
  bucket.total_images += Number(event.imagesCount) || 0
  bucket.total_citations += Number(event.citationCount) || 0

  const blockedRequested = Array.isArray(event.blockedRequestedDomains) ? event.blockedRequestedDomains : []
  const blockedResponse = Array.isArray(event.blockedResponseDomains) ? event.blockedResponseDomains : []
  if (blockedRequested.length > 0) {
    bucket.blocked_search_attempt_count += 1
  }

  for (const [toolName, count] of Object.entries(event.toolUsage || {})) {
    incrementMap(bucket.tool_usage, toolName, Number(count) || 0)
  }

  bucket.blocked_requested_domain_count += blockedRequested.length
  bucket.blocked_response_domain_count += blockedResponse.length

  for (const termId of event.vfbTermIds || []) {
    incrementMap(bucket.vfb_term_ids, termId, 1)
  }

  bucket.tool_usage = normalizeCountMap(bucket.tool_usage)
  bucket.vfb_term_ids = normalizeCountMap(bucket.vfb_term_ids)

  data.buckets[bucketKey] = bucket
  scheduleAnalyticsFlush()
}

export function recordFeedbackEvent(event) {
  ensureGovernanceStorage()
  const paths = getGovernancePaths()

  appendJsonLine(path.join(paths.feedbackDir, `${monthKey()}.jsonl`), {
    timestamp: isoNow(),
    request_id: event.requestId,
    response_id: event.responseId,
    rating: event.rating,
    reason_code: event.reasonCode,
    conversation_attached: Boolean(event.conversationAttached),
    conversation_message_count: Number(event.conversationMessageCount) || 0
  })
}

export function recordFeedbackTranscript(event) {
  ensureGovernanceStorage()
  const paths = getGovernancePaths()

  appendJsonLine(path.join(paths.feedbackTranscriptDir, `${todayKey()}.jsonl`), {
    timestamp: isoNow(),
    request_id: event.requestId,
    response_id: event.responseId,
    rating: event.rating,
    reason_code: event.reasonCode,
    conversation: event.conversation
  })
}

function serializeToolUsage(toolUsage = {}) {
  return Object.entries(toolUsage)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([toolName, count]) => `${toolName}:${count}`)
    .join('|')
}

export async function sendStructuredTelemetry(event) {
  const gaConfig = getGoogleAnalyticsConfig()
  if (!gaConfig.enabled) return

  // Everything here is generalised or drawn from VFB's own published vocabulary.
  // Nothing a user typed reaches this payload.
  //
  // Two fields are worth being explicit about, because they look like content
  // and are not. `topic_category` is a classification into one of six fixed
  // values — anatomy, connectivity, gene expression, images, publications,
  // how-to — so no text can travel through it. `vfb_term_ids` is matched out of
  // the ANSWER, not the question, by /\b(?:VFB|FBbt)_\d{8}\b/: VFB and FlyBase
  // ontology identifiers from VFB's own public data, and structurally incapable
  // of carrying anything else.
  const payload = {
    client_id: event.requestId || createRequestId(),
    events: [{
      name: 'chat_query',
      params: {
        duration_ms: Number(event.latencyMs) || 0,
        response_length: Number(event.responseLength) || 0,
        topic_category: event.topicCategory || 'anatomy',
        tools_used: serializeToolUsage(event.toolUsage),
        vfb_term_ids: (event.vfbTermIds || []).slice(0, 5).join('|'),
        outcome_type: event.outcomeType || 'success',
        images_count: Number(event.imagesCount) || 0,
        citation_count: Number(event.citationCount) || 0,
        tool_round_count: Number(event.toolRounds) || 0,
        blocked_requested_domain_count: Array.isArray(event.blockedRequestedDomains) ? event.blockedRequestedDomains.length : 0,
        blocked_response_domain_count: Array.isArray(event.blockedResponseDomains) ? event.blockedResponseDomains.length : 0
      }
    }]
  }

  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${gaConfig.measurementId}&api_secret=${gaConfig.apiSecret}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    )
  } catch {
    // Ignore telemetry failures to avoid leaking details into console logs.
  }
}
