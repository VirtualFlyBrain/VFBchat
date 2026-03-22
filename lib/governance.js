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

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  const tempFile = `${filePath}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tempFile, filePath)
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8')
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
  if (initialized) return

  const paths = getGovernancePaths()
  ensureDir(paths.securityEventsDir)
  ensureDir(paths.blockedSearchDir)
  ensureDir(paths.securityStateDir)
  ensureDir(paths.analyticsDir)
  ensureDir(paths.feedbackDir)
  ensureDir(paths.feedbackTranscriptDir)

  pruneRetention()
  initialized = true
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

export function recordAnalyticsEvent(event) {
  ensureGovernanceStorage()
  const paths = getGovernancePaths()
  const day = todayKey()
  const filePath = path.join(paths.analyticsDir, `${day}.json`)
  const data = readJson(filePath, {
    version: 1,
    date_bucket: day,
    buckets: {}
  })

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
    blocked_requested_domains: {},
    blocked_response_domains: {},
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

  for (const hostname of blockedRequested) {
    incrementMap(bucket.blocked_requested_domains, hostname, 1)
  }

  for (const hostname of blockedResponse) {
    incrementMap(bucket.blocked_response_domains, hostname, 1)
  }

  for (const termId of event.vfbTermIds || []) {
    incrementMap(bucket.vfb_term_ids, termId, 1)
  }

  bucket.tool_usage = normalizeCountMap(bucket.tool_usage)
  bucket.blocked_requested_domains = normalizeCountMap(bucket.blocked_requested_domains)
  bucket.blocked_response_domains = normalizeCountMap(bucket.blocked_response_domains)
  bucket.vfb_term_ids = normalizeCountMap(bucket.vfb_term_ids)

  data.buckets[bucketKey] = bucket
  writeJson(filePath, data)
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
