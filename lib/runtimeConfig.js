import path from 'path'

const DEFAULT_SEARCH_ALLOWLIST = [
  'virtualflybrain.org',
  '*.virtualflybrain.org',
  'flybase.org',
  'neurofly.org',
  '*.neurofly.org'
]

const DEFAULT_OUTBOUND_ALLOWLIST = [
  'virtualflybrain.org',
  '*.virtualflybrain.org',
  'flybase.org',
  'neurofly.org',
  '*.neurofly.org',
  'doi.org',
  'pubmed.ncbi.nlm.nih.gov',
  'biorxiv.org',
  'medrxiv.org'
]

const DEFAULT_REVIEWED_DOCS_DISCOVERY_URLS = [
  'https://www.virtualflybrain.org/robots.txt',
  'https://www.virtualflybrain.org/sitemap.xml',
  'https://www.virtualflybrain.org/sitemap_index.xml',
  'https://virtualflybrain.org/robots.txt',
  'https://virtualflybrain.org/sitemap.xml',
  'https://virtualflybrain.org/sitemap_index.xml',
  'https://www.neurofly.org/robots.txt',
  'https://www.neurofly.org/sitemap.xml',
  'https://www.neurofly.org/sitemap_index.xml',
  'https://neurofly.org/robots.txt',
  'https://neurofly.org/sitemap.xml',
  'https://neurofly.org/sitemap_index.xml'
]

function trimEnv(name) {
  return process.env[name]?.trim() || ''
}

function parseCsvList(value, defaults) {
  const source = value
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : defaults

  return Array.from(new Set(source.map(item => item.toLowerCase())))
}

function parseList(value, defaults) {
  const source = value
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : defaults

  return Array.from(new Set(source))
}

function parseIntEnv(name, defaultValue, min, max) {
  const rawValue = trimEnv(name)
  if (!rawValue) return defaultValue

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed)) return defaultValue

  return Math.min(Math.max(parsed, min), max)
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '')
}

export function isProduction() {
  return process.env.NODE_ENV === 'production'
}

export function getLogRootDir() {
  const configured = trimEnv('LOG_ROOT_DIR')
  if (configured) return configured

  return isProduction()
    ? '/logs'
    : path.join(process.cwd(), 'logs')
}

export function getSearchAllowList() {
  return parseCsvList(trimEnv('SEARCH_ALLOWLIST'), DEFAULT_SEARCH_ALLOWLIST)
}

export function getOutboundAllowList() {
  return parseCsvList(trimEnv('OUTBOUND_ALLOWLIST'), DEFAULT_OUTBOUND_ALLOWLIST)
}

export function getReviewedDocsIndexFile() {
  return trimEnv('REVIEWED_DOCS_INDEX_FILE')
    || path.join(process.cwd(), 'config', 'reviewed-docs-index.json')
}

export function getReviewedDocsDiscoveryUrls() {
  return parseList(trimEnv('REVIEWED_DOCS_DISCOVERY_URLS'), DEFAULT_REVIEWED_DOCS_DISCOVERY_URLS)
}

export function getReviewedDocsCacheTtlMs() {
  return parseIntEnv('REVIEWED_DOCS_CACHE_MINUTES', 60, 1, 1440) * 60 * 1000
}

export function getReviewedDocsMaxUrls() {
  return parseIntEnv('REVIEWED_DOCS_MAX_URLS', 2500, 100, 10000)
}

export function getReviewedDocsFetchTimeoutMs() {
  return parseIntEnv('REVIEWED_DOCS_FETCH_TIMEOUT_MS', 10000, 1000, 60000)
}

export function getConfiguredApiBaseUrl() {
  const explicit = trimEnv('OPENAI_BASE_URL')
  if (explicit) return normalizeBaseUrl(explicit)

  const approved = trimEnv('APPROVED_ELM_BASE_URL')
  if (approved) return normalizeBaseUrl(approved)

  throw new Error('OPENAI_BASE_URL or APPROVED_ELM_BASE_URL must be configured.')
}

function getApprovedApiBaseUrl() {
  const approved = trimEnv('APPROVED_ELM_BASE_URL')
  if (approved) return normalizeBaseUrl(approved)

  return getConfiguredApiBaseUrl()
}

export function getConfiguredModel() {
  const explicit = trimEnv('OPENAI_MODEL')
  if (explicit) return explicit

  const approved = trimEnv('APPROVED_ELM_MODEL')
  if (approved) return approved

  if (isProduction()) {
    throw new Error('OPENAI_MODEL or APPROVED_ELM_MODEL must be configured in production.')
  }

  return 'gpt-4o-mini'
}

function getApprovedModel() {
  const approved = trimEnv('APPROVED_ELM_MODEL')
  if (approved) return approved

  return getConfiguredModel()
}

export function validateProductionCompliance() {
  if (!isProduction()) return

  const configuredBaseUrl = getConfiguredApiBaseUrl()
  const approvedBaseUrl = getApprovedApiBaseUrl()

  if (configuredBaseUrl !== approvedBaseUrl) {
    throw new Error('OPENAI_BASE_URL must match the approved ELM gateway in production.')
  }

  const configuredModel = getConfiguredModel()
  const approvedModel = getApprovedModel()

  if (configuredModel !== approvedModel) {
    throw new Error('OPENAI_MODEL must match the approved ELM model in production.')
  }
}

export function getGoogleAnalyticsConfig() {
  const measurementId = trimEnv('GA_MEASUREMENT_ID')
  const apiSecret = trimEnv('GA_API_SECRET')

  return {
    measurementId,
    apiSecret,
    enabled: Boolean(measurementId && apiSecret)
  }
}
