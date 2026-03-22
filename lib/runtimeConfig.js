import path from 'path'

const DEFAULT_SEARCH_ALLOWLIST = [
  'virtualflybrain.org',
  '*.virtualflybrain.org',
  'flybase.org'
]

const DEFAULT_OUTBOUND_ALLOWLIST = [
  'virtualflybrain.org',
  '*.virtualflybrain.org',
  'flybase.org',
  'doi.org',
  'pubmed.ncbi.nlm.nih.gov',
  'biorxiv.org',
  'medrxiv.org'
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

export function getConfiguredApiBaseUrl() {
  const value = trimEnv('OPENAI_BASE_URL')
  if (!value) {
    throw new Error('OPENAI_BASE_URL must be configured.')
  }

  return normalizeBaseUrl(value)
}

export function getConfiguredModel() {
  const explicit = trimEnv('OPENAI_MODEL')
  if (explicit) return explicit

  const approved = trimEnv('APPROVED_ELM_MODEL')
  if (approved) return approved

  if (isProduction()) {
    throw new Error('OPENAI_MODEL must be configured in production.')
  }

  return 'gpt-4o-mini'
}

export function validateProductionCompliance() {
  if (!isProduction()) return

  const configuredBaseUrl = getConfiguredApiBaseUrl()
  const approvedBaseUrl = trimEnv('APPROVED_ELM_BASE_URL')
  if (!approvedBaseUrl) {
    throw new Error('APPROVED_ELM_BASE_URL must be configured in production.')
  }

  if (configuredBaseUrl !== normalizeBaseUrl(approvedBaseUrl)) {
    throw new Error('OPENAI_BASE_URL must match the approved ELM gateway in production.')
  }

  const configuredModel = trimEnv('OPENAI_MODEL')
  if (!configuredModel) {
    throw new Error('OPENAI_MODEL must be configured in production.')
  }

  const approvedModel = trimEnv('APPROVED_ELM_MODEL')
  if (!approvedModel) {
    throw new Error('APPROVED_ELM_MODEL must be configured in production.')
  }

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
