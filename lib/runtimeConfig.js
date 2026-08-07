import path from 'path'
import { QWEN_MODEL, parseModelList } from './structuredOutput.mjs'

const DEFAULT_SEARCH_ALLOWLIST = [
  'virtualflybrain.org',
  '*.virtualflybrain.org',
  'flybase.org',
  'neurofly.org',
  '*.neurofly.org',
  'vfb-connect.readthedocs.io'
]

const DEFAULT_OUTBOUND_ALLOWLIST = [
  'virtualflybrain.org',
  '*.virtualflybrain.org',
  'flybase.org',
  'neurofly.org',
  '*.neurofly.org',
  'vfb-connect.readthedocs.io',
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
  'https://neurofly.org/sitemap_index.xml',
  'https://vfb-connect.readthedocs.io/robots.txt',
  'https://vfb-connect.readthedocs.io/sitemap.xml'
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
  const explicitElm = trimEnv('ELM_BASE_URL')
  if (explicitElm) return normalizeBaseUrl(explicitElm)

  const explicit = trimEnv('OPENAI_BASE_URL')
  if (explicit) return normalizeBaseUrl(explicit)

  const approved = trimEnv('APPROVED_ELM_BASE_URL')
  if (approved) return normalizeBaseUrl(approved)

  throw new Error('ELM_BASE_URL, OPENAI_BASE_URL, or APPROVED_ELM_BASE_URL must be configured.')
}

function getApprovedApiBaseUrl() {
  const approved = trimEnv('APPROVED_ELM_BASE_URL')
  if (approved) return normalizeBaseUrl(approved)

  return getConfiguredApiBaseUrl()
}

/**
 * The configured model preference LIST, in order.
 *
 * v4.0.0 made these variables lists (comma or newline separated); a single
 * value is a one-element list, so every existing deployment reads the same as
 * it did before. See structuredOutput.parseModelList for why.
 */
export function getConfiguredModelList() {
  const explicitElm = parseModelList(trimEnv('ELM_MODEL'))
  if (explicitElm.length) return explicitElm

  const explicit = parseModelList(trimEnv('OPENAI_MODEL'))
  if (explicit.length) return explicit

  const approved = parseModelList(trimEnv('APPROVED_ELM_MODEL'))
  if (approved.length) return approved

  if (isProduction()) {
    throw new Error('ELM_MODEL, OPENAI_MODEL, or APPROVED_ELM_MODEL must be configured in production.')
  }

  // Non-production convenience default only; production still requires an
  // explicit ELM_MODEL / OPENAI_MODEL / APPROVED_ELM_MODEL (thrown above).
  return [QWEN_MODEL]
}

/**
 * The single model this deployment would prefer — the head of the list.
 * Kept for every caller that only wants a name to put in a log line or a
 * response header; actual per-role resolution goes through resolveRoleModel,
 * which can pick a later candidate when the head is not being served.
 */
export function getConfiguredModel() {
  return getConfiguredModelList()[0]
}

export function getConfiguredApiKey() {
  const elmApiKey = trimEnv('ELM_API_KEY')
  if (elmApiKey) return elmApiKey

  const openAiApiKey = trimEnv('OPENAI_API_KEY')
  if (openAiApiKey) return openAiApiKey

  if (isProduction()) {
    throw new Error('ELM_API_KEY or OPENAI_API_KEY must be configured in production.')
  }

  return ''
}

function getApprovedModelList() {
  const approved = parseModelList(trimEnv('APPROVED_ELM_MODEL'))
  if (approved.length) return approved

  return getConfiguredModelList()
}

function getApprovedModel() {
  return getApprovedModelList()[0]
}

export function validateProductionCompliance() {
  if (!isProduction()) return

  // Ensure an API key is configured in production.
  getConfiguredApiKey()

  // The approval variables must be SET, not merely satisfied.
  //
  // Every check below compares the configured values against the approved ones,
  // and both approved getters fall back to the configured value when their
  // variable is unset. So an unset APPROVED_ELM_MODEL did not fail the gate — it
  // made the deployment approve itself, and every assertion after this point
  // passed by construction. A control that cannot fail is not a control, and
  // this one is load-bearing in the ELM approval we cite to the University.
  //
  // Failing loudly at startup is the right direction: a deployment missing its
  // approval variables should not serve, and the operator finds out immediately
  // rather than an assessor finding out later.
  if (!trimEnv('APPROVED_ELM_BASE_URL')) {
    throw new Error('APPROVED_ELM_BASE_URL must be set in production: without it the compliance check approves whatever is configured.')
  }
  if (!trimEnv('APPROVED_ELM_MODEL')) {
    throw new Error('APPROVED_ELM_MODEL must be set in production: without it the compliance check approves whatever is configured.')
  }

  const configuredBaseUrl = getConfiguredApiBaseUrl()
  const approvedBaseUrl = getApprovedApiBaseUrl()

  if (configuredBaseUrl !== approvedBaseUrl) {
    throw new Error('Configured base URL must match the approved ELM gateway in production.')
  }

  // Model variables are LISTS in v4.0.0, so the production rule is no longer
  // "configured equals approved" but the strictly stronger "every model this
  // deployment could possibly select is one somebody approved". Equality was
  // never the property we wanted — it was a proxy for it that happened to work
  // while each variable held exactly one name.
  const approvedList = getApprovedModelList()
  const approved = new Set(approvedList)
  const unapproved = getConfiguredModelList().filter(m => !approved.has(m))

  if (unapproved.length) {
    throw new Error(
      `Configured model(s) must be approved in production: ${unapproved.join(', ')} ` +
      `not in APPROVED_ELM_MODEL (${approvedList.join(', ')}).`
    )
  }

  // v4.0.0 introduced per-role model overrides (VFB_MODEL_PLANNER and friends).
  // Without this loop they would be a hole straight through the compliance
  // gate: APPROVED_ELM_MODEL could name the approved model while every actual
  // request went somewhere else. Any role override present in production must
  // draw from the approved list too.
  for (const role of ['PLANNER', 'SUFFICIENCY', 'EXTRACT', 'ARGS', 'SYNTH', 'DEFAULT']) {
    const override = parseModelList(trimEnv(`VFB_MODEL_${role}`)).filter(m => !approved.has(m))
    if (override.length) {
      throw new Error(`VFB_MODEL_${role} must name approved ELM model(s) in production: ${override.join(', ')} not approved.`)
    }
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
