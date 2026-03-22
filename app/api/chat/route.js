import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fs from 'fs'
import path from 'path'

import {
  createRequestId,
  ensureGovernanceStorage,
  logBlockedSearchAudit,
  logSecurityEvent,
  recordAnalyticsEvent,
  sendStructuredTelemetry
} from '../../../lib/governance.js'
import {
  countCitationLinks,
  extractVfbTermIds,
  findBlockedRequestedDomains,
  requestMentionsSearchIntent,
  sanitizeAssistantOutput
} from '../../../lib/policy.js'
import { checkAndIncrement } from '../../../lib/rateLimit.js'
import { searchReviewedDocs } from '../../../lib/reviewedDocsSearch.js'
import {
  getConfiguredApiBaseUrl,
  getConfiguredModel,
  getOutboundAllowList,
  getSearchAllowList,
  validateProductionCompliance
} from '../../../lib/runtimeConfig.js'

// Sanitize API error responses – replace raw HTML (e.g. proxy 5xx pages)
// with a concise, user-friendly message.
function sanitizeApiError(statusCode, rawText) {
  if (rawText && (rawText.trim().startsWith('<!DOCTYPE') || rawText.trim().startsWith('<html'))) {
    const titleMatch = rawText.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : `HTTP ${statusCode}`
    return `The AI service returned an error (${title}). This is usually temporary, so please try again in a moment.`
  }

  if (rawText && rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText)
      const message = parsed?.error?.message
      if (message) return message
    } catch {
      // Fall through to the generic message below.
    }
  }

  return `HTTP ${statusCode}`
}

function isTransientError(status) {
  return [429, 500, 502, 503, 504, 520, 521, 522, 524].includes(status)
}

function buildSseResponse(startHandler) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // The client disconnected; there is nothing else to do here.
        }
      }

      try {
        await startHandler(sendEvent)
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  })
}

function createImmediateErrorResponse(message, requestId, responseId) {
  return buildSseResponse(async (sendEvent) => {
    sendEvent('error', { message, requestId, responseId })
  })
}

function getClientIp(request) {
  const xForwardedFor = request.headers.get('x-forwarded-for') || ''
  return (xForwardedFor.split(',')[0] || '').trim() || request.headers.get('x-real-ip') || 'unknown'
}

function buildRateLimitDetails(rateCheck) {
  if (!rateCheck) return null

  return {
    allowed: Boolean(rateCheck.allowed),
    used: Number(rateCheck.used) || 0,
    limit: Number(rateCheck.limit) || 0
  }
}

function looksLikeEmptyResult(text = '') {
  return /\b(no results|did not find|didn't find|could not find|couldn't find|no matching|no reviewed page|no reviewed pages)\b/i.test(text)
}

function classifyTopicCategory(message = '', toolUsage = {}) {
  const lowerMessage = message.toLowerCase()

  if (toolUsage.search_reviewed_docs || /\b(documentation|docs?|how do i|how to|website|site|page)\b/i.test(lowerMessage)) {
    return 'how-to'
  }

  if (/\b(paper|papers|publication|publications|preprint|preprints|pubmed|doi|research)\b/i.test(lowerMessage)) {
    return 'publications'
  }

  if (toolUsage.vfb_run_query || /\b(connectivity|connectome|synapse|synaptic|nblast|projection|presynaptic|postsynaptic)\b/i.test(lowerMessage)) {
    return 'connectivity'
  }

  if (/\b(gene|expression|transgene|gal4|driver|reporter)\b/i.test(lowerMessage)) {
    return 'gene expression'
  }

  if (/\b(image|images|thumbnail|picture|pictures|visuali[sz]e|3d|scene)\b/i.test(lowerMessage)) {
    return 'images'
  }

  return 'anatomy'
}

function deriveOutcomeType({ responseText = '', refusal = false, errored = false }) {
  if (errored) return 'error'
  if (refusal) return 'refusal'
  if (looksLikeEmptyResult(responseText)) return 'empty-result'
  return 'success'
}

async function finalizeGovernanceEvent({
  requestId,
  responseId,
  clientIp,
  route = '/api/chat',
  startTime,
  rateCheck,
  message,
  responseText = '',
  toolUsage = {},
  toolRounds = 0,
  imagesCount = 0,
  blockedRequestedDomains = [],
  blockedResponseDomains = [],
  abuseFlag = false,
  reasonCode = null,
  errorCategory = null,
  errorStatus = null,
  refusal = false,
  errored = false
}) {
  const latencyMs = Date.now() - startTime
  const topicCategory = classifyTopicCategory(message, toolUsage)
  const outcomeType = deriveOutcomeType({ responseText, refusal, errored })
  const citationCount = countCitationLinks(responseText)
  const vfbTermIds = extractVfbTermIds(responseText)

  logSecurityEvent({
    eventType: outcomeType === 'error'
      ? 'chat_error'
      : outcomeType === 'refusal'
        ? 'chat_refusal'
        : 'chat_completed',
    requestId,
    responseId,
    ip: clientIp,
    route,
    rateLimit: buildRateLimitDetails(rateCheck),
    abuseFlag,
    reasonCode,
    errorCategory,
    errorStatus,
    blockedRequestedDomains,
    blockedResponseDomains,
    latencyMs
  })

  recordAnalyticsEvent({
    institutionBucket: 'unknown',
    topicCategory,
    outcomeType,
    latencyMs,
    responseLength: responseText.length,
    toolRounds,
    imagesCount,
    citationCount,
    toolUsage,
    blockedRequestedDomains,
    blockedResponseDomains,
    vfbTermIds
  })

  await sendStructuredTelemetry({
    requestId,
    topicCategory,
    outcomeType,
    latencyMs,
    responseLength: responseText.length,
    toolRounds,
    imagesCount,
    citationCount,
    toolUsage,
    blockedRequestedDomains,
    blockedResponseDomains,
    vfbTermIds
  })
}

// --- MCP client management (lazy initialization) ---

let vfbMcpClient = null
let biorxivMcpClient = null

const VFB_MCP_URL = 'https://vfb3-mcp.virtualflybrain.org/'
const BIORXIV_MCP_URL = 'https://mcp.deepsense.ai/biorxiv/mcp'

async function getVfbMcpClient() {
  if (vfbMcpClient) return vfbMcpClient

  const transport = new StreamableHTTPClientTransport(new URL(VFB_MCP_URL))
  const client = new Client(
    { name: 'vfb-chat-client', version: '3.2.0' },
    { capabilities: {} }
  )
  await client.connect(transport)
  vfbMcpClient = client
  return client
}

async function getBiorxivMcpClient() {
  if (biorxivMcpClient) return biorxivMcpClient

  const transport = new StreamableHTTPClientTransport(new URL(BIORXIV_MCP_URL))
  const client = new Client(
    { name: 'vfb-chat-biorxiv', version: '3.2.0' },
    { capabilities: {} }
  )
  await client.connect(transport)
  biorxivMcpClient = client
  return client
}

function getToolConfig() {
  const tools = []

  tools.push({
    type: 'function',
    name: 'vfb_search_terms',
    description: 'Search VFB terms by keywords, with optional filtering by entity type. Always exclude ["deprecated"]. Use minimize_results: true for initial broad searches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query keywords' },
        filter_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by entity types such as ["neuron","adult","has_image"], ["dataset"], ["anatomy"], or ["gene"]'
        },
        exclude_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude types such as ["deprecated"]'
        },
        boost_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Boost result types such as ["has_image", "has_neuron_connectivity"]'
        },
        start: { type: 'number', description: 'Pagination start index (default 0)' },
        rows: { type: 'number', description: 'Number of results (default 10, max 50)' },
        minimize_results: { type: 'boolean', description: 'Return minimal fields for faster response (default false)' },
        auto_fetch_term_info: { type: 'boolean', description: 'Automatically fetch full term info when searching for a specific term by name' }
      },
      required: ['query']
    }
  })

  tools.push({
    type: 'function',
    name: 'vfb_get_term_info',
    description: 'Get detailed information about a VFB term by ID, including definitions, relationships, images, queries, and references.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The VFB term ID such as VFB_00102107 or FBbt_00003748' }
      },
      required: ['id']
    }
  })

  tools.push({
    type: 'function',
    name: 'vfb_run_query',
    description: 'Run analyses such as PaintedDomains, NBLAST, or connectivity on a VFB entity. Only use query types returned by vfb_get_term_info.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The VFB term ID to query' },
        query_type: { type: 'string', description: 'A query type returned for the term by vfb_get_term_info' }
      },
      required: ['id', 'query_type']
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_search_preprints',
    description: 'Search bioRxiv or medRxiv preprints by date range and category. Results are not peer reviewed.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD' },
        category: { type: 'string', description: 'Subject category such as neuroscience or genetics' },
        recent_days: { type: 'number', description: 'Alternative: get preprints from the last N days' },
        limit: { type: 'number', description: 'Max results (1-100, default 10)' },
        cursor: { type: 'number', description: 'Pagination cursor (default 0)' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'Server to query (default biorxiv)' }
      }
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_get_preprint',
    description: 'Get full metadata for a preprint by DOI.',
    parameters: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'Preprint DOI' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'Server to query (default biorxiv)' }
      },
      required: ['doi']
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_search_published_preprints',
    description: 'Find preprints that were published in peer-reviewed journals.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD' },
        recent_days: { type: 'number', description: 'Alternative: last N days' },
        publisher: { type: 'string', description: 'Publisher DOI prefix such as 10.1038 for Nature' },
        limit: { type: 'number', description: 'Max results (1-100, default 10)' },
        cursor: { type: 'number', description: 'Pagination cursor (default 0)' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'Server to query (default biorxiv)' }
      }
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_get_categories',
    description: 'List all bioRxiv subject categories for filtering searches.',
    parameters: {
      type: 'object',
      properties: {}
    }
  })

  tools.push({
    type: 'function',
    name: 'search_reviewed_docs',
    description: 'Search a reviewed local index of approved Virtual Fly Brain and FlyBase pages only. Use this for site documentation or approved website questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Documentation search query' },
        max_results: { type: 'number', description: 'Maximum results to return (default 5, max 10)' }
      },
      required: ['query']
    }
  })

  tools.push({
    type: 'function',
    name: 'search_pubmed',
    description: 'Search PubMed for published scientific articles. Returns titles, authors, abstracts, PMIDs, and DOIs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query such as "Drosophila medulla neurons connectome"' },
        max_results: { type: 'number', description: 'Maximum results (default 5, max 20)' },
        sort: { type: 'string', enum: ['relevance', 'date'], description: 'Sort order (default relevance)' }
      },
      required: ['query']
    }
  })

  tools.push({
    type: 'function',
    name: 'get_pubmed_article',
    description: 'Get detailed information about a specific PubMed article by PMID.',
    parameters: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'PubMed ID such as 12345678' }
      },
      required: ['pmid']
    }
  })

  return tools
}

// --- PubMed E-utilities integration ---

const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

async function searchPubmed(query, maxResults = 5, sort = 'relevance') {
  maxResults = Math.min(Math.max(1, maxResults || 5), 20)
  const sortParam = sort === 'date' ? 'date' : 'relevance'

  const searchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&sort=${sortParam}&retmode=json`
  const searchRes = await fetch(searchUrl)
  if (!searchRes.ok) throw new Error(`PubMed search failed: ${searchRes.status}`)
  const searchData = await searchRes.json()
  const pmids = searchData.esearchresult?.idlist || []

  if (pmids.length === 0) {
    return JSON.stringify({ results: [], total_found: searchData.esearchresult?.count || 0 })
  }

  const summaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`
  const summaryRes = await fetch(summaryUrl)
  if (!summaryRes.ok) throw new Error(`PubMed summary fetch failed: ${summaryRes.status}`)
  const summaryData = await summaryRes.json()

  const articles = pmids.map(pmid => {
    const article = summaryData.result?.[pmid]
    if (!article) return null

    return {
      pmid,
      title: article.title,
      authors: (article.authors || []).map(author => author.name).slice(0, 5).join(', '),
      journal: article.fulljournalname || article.source,
      pub_date: article.pubdate,
      doi: (article.articleids || []).find(id => id.idtype === 'doi')?.value || null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    }
  }).filter(Boolean)

  return JSON.stringify({
    results: articles,
    total_found: parseInt(searchData.esearchresult?.count || 0, 10)
  })
}

async function getPubmedArticle(pmid) {
  const fetchUrl = `${NCBI_BASE}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=xml`
  const fetchRes = await fetch(fetchUrl)
  if (!fetchRes.ok) throw new Error(`PubMed fetch failed: ${fetchRes.status}`)
  const xmlText = await fetchRes.text()

  const extract = (tag) => {
    const match = xmlText.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null
  }

  const extractAll = (tag) => {
    const matches = []
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
    let match

    while ((match = regex.exec(xmlText)) !== null) {
      matches.push(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    }

    return matches
  }

  const title = extract('ArticleTitle')
  const abstractText = extract('AbstractText') || extract('Abstract')
  const journal = extract('Title')
  const year = extract('Year')
  const doi = (() => {
    const match = xmlText.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/i)
    return match ? match[1] : null
  })()

  const authorBlocks = xmlText.match(/<Author[^>]*>[\s\S]*?<\/Author>/gi) || []
  const authors = authorBlocks.slice(0, 10).map(block => {
    const lastName = block.match(/<LastName>([^<]+)<\/LastName>/i)?.[1] || ''
    const firstName = block.match(/<ForeName>([^<]+)<\/ForeName>/i)?.[1] || ''
    return `${firstName} ${lastName}`.trim()
  }).filter(Boolean)

  return JSON.stringify({
    pmid,
    title,
    authors,
    abstract: abstractText,
    journal,
    year,
    doi,
    doi_url: doi ? `https://doi.org/${doi}` : null,
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    keywords: extractAll('Keyword').slice(0, 10)
  })
}

// --- Function tool execution (routes to MCP clients or direct APIs) ---

const MCP_TOOL_ROUTING = {
  vfb_search_terms: { server: 'vfb', mcpName: 'search_terms' },
  vfb_get_term_info: { server: 'vfb', mcpName: 'get_term_info' },
  vfb_run_query: { server: 'vfb', mcpName: 'run_query' },
  biorxiv_search_preprints: { server: 'biorxiv', mcpName: 'search_preprints' },
  biorxiv_get_preprint: { server: 'biorxiv', mcpName: 'get_preprint' },
  biorxiv_search_published_preprints: { server: 'biorxiv', mcpName: 'search_published_preprints' },
  biorxiv_get_categories: { server: 'biorxiv', mcpName: 'get_categories' }
}

async function executeFunctionTool(name, args) {
  if (name === 'search_pubmed') {
    return searchPubmed(args.query, args.max_results, args.sort)
  }

  if (name === 'get_pubmed_article') {
    return getPubmedArticle(args.pmid)
  }

  if (name === 'search_reviewed_docs') {
    return searchReviewedDocs(args.query, args.max_results)
  }

  const routing = MCP_TOOL_ROUTING[name]
  if (routing) {
    const client = routing.server === 'vfb'
      ? await getVfbMcpClient()
      : await getBiorxivMcpClient()

    const cleanArgs = {}
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) cleanArgs[key] = value
    }

    const result = await client.callTool({ name: routing.mcpName, arguments: cleanArgs })
    if (result?.content) {
      const texts = result.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
      return texts.join('\n') || JSON.stringify(result.content)
    }

    return JSON.stringify(result)
  }

  throw new Error(`Unknown function tool: ${name}`)
}

function detectJailbreakAttempt(message) {
  const lowerMessage = message.toLowerCase()

  const jailbreakPatterns = [
    /\bdeveloper mode\b/i,
    /\bunrestricted mode\b/i,
    /\bdebug mode\b/i,
    /\bmaintenance mode\b/i,
    /\bgod mode\b/i,
    /\bdan\b.*mode/i,
    /\bdo anything now\b/i,
    /\buncensored\b/i,
    /\bunfiltered\b/i,
    /\bjailbreak\b/i,
    /\bignore.*previous.*instructions?\b/i,
    /\boverride.*instructions?\b/i,
    /\bforget.*instructions?\b/i,
    /\bdiscard.*instructions?\b/i,
    /\bdisregard.*rules\b/i,
    /\byou are now\b.*ai/i,
    /\bact as\b.*ai/i,
    /\bpretend.*to be\b.*ai/i,
    /\bbecome.*ai\b/i,
    /\bchange.*system.*prompt\b/i,
    /\balter.*system.*prompt\b/i,
    /\bmodify.*system.*prompt\b/i,
    /\brewrite.*system.*prompt\b/i,
    /\bbase64\b/i,
    /\bencoded\b.*prompt/i,
    /\bencrypted\b.*prompt/i,
    /\baim.*jailbreak/i,
    /\bmaximum.*jailbreak/i,
    /\bcharacter.*jailbreak/i,
    /\banti.*woke\b/i,
    /\byou must\b.*break.*rules/i,
    /\bi command you\b.*to/i,
    /\bas root\b/i,
    /\bsudo\b/i,
    /\badmin\b.*mode/i,
    /\bcreate.*uncensored.*persona/i,
    /\brole.*play.*as.*uncensored/i,
    /\bact.*like.*uncensored/i,
    /\bfrom now on\b.*you are/i,
    /\blet'?s role.*play/i,
    /\bscenario.*role.*play/i,
    /\bpretend.*that/i,
    /\bhiding.*query/i,
    /\bsecret.*message/i,
    /\bencoded.*message/i
  ]

  for (const pattern of jailbreakPatterns) {
    if (pattern.test(lowerMessage)) return true
  }

  const overrideCount = (lowerMessage.match(/\b(ignore|override|forget|discard|disregard)\b.*\b(instructions?|rules?|prompt)\b/gi) || []).length
  if (overrideCount > 1) return true

  const suspiciousWords = ['ignore', 'override', 'forget', 'unrestricted', 'uncensored', 'jailbreak']
  const suspiciousCount = suspiciousWords.reduce((count, word) => count + (lowerMessage.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length, 0)
  return suspiciousCount > 2
}

// --- Lookup cache (read-only, loaded from static file) ---

let lookupCache = null
let reverseLookupCache = null
const CACHE_FILE = path.join(process.cwd(), 'vfb_lookup_cache.json')

function loadLookupCache() {
  if (lookupCache) return

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      lookupCache = cacheData.lookup || {}
      reverseLookupCache = cacheData.reverseLookup || {}
      return
    }
  } catch {
    // Fall back to a small seeded cache below.
  }

  lookupCache = {}
  reverseLookupCache = {}
  seedEssentialTerms()
}

function seedEssentialTerms() {
  const essentialTerms = {
    'medulla': 'FBbt_00003748',
    'adult brain': 'FBbt_00003624',
    'central complex': 'FBbt_00003632',
    'mushroom body': 'FBbt_00005801',
    'protocerebrum': 'FBbt_00003627',
    'deutocerebrum': 'FBbt_00003923',
    'tritocerebrum': 'FBbt_00003633'
  }

  for (const [term, id] of Object.entries(essentialTerms)) {
    lookupCache[term] = id
    reverseLookupCache[id] = term
  }
}

function replaceTermsWithLinks(text) {
  if (!text || !lookupCache) return text

  const sortedTerms = Object.keys(lookupCache)
    .filter(term => term.length > 2)
    .sort((a, b) => b.length - a.length)

  const protectedLinks = []
  const protectedUrls = []
  const URL_PLACEHOLDER = '\u0000URL'
  let result = text.replace(/https?:\/\/[^\s)]+/g, (url) => {
    protectedUrls.push(url)
    return `${URL_PLACEHOLDER}${protectedUrls.length - 1}\u0000`
  })

  result = result.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (match) => {
    protectedLinks.push(match)
    return `\u0000LINK${protectedLinks.length - 1}\u0000`
  })

  const reportBase = 'https://virtualflybrain.org/reports/'
  for (const term of sortedTerms) {
    const id = lookupCache[term]
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi')
    result = result.replace(regex, (match) => {
      protectedLinks.push(`[${match}](${reportBase + encodeURIComponent(id)})`)
      return `\u0000LINK${protectedLinks.length - 1}\u0000`
    })
  }

  result = result.replace(/\b(FBbt_\d{8}|VFB_\d{8})\b/g, (match) => {
    const label = reverseLookupCache?.[match]
    const display = label || match
    protectedLinks.push(`[${display}](${reportBase + encodeURIComponent(match)})`)
    return `\u0000LINK${protectedLinks.length - 1}\u0000`
  })

  result = result.replace(/\u0000LINK(\d+)\u0000/g, (_, index) => protectedLinks[Number(index)])
  result = result.replace(new RegExp(`${URL_PLACEHOLDER}(\\d+)\\u0000`, 'g'), (_, index) => protectedUrls[Number(index)])
  return result
}

const systemPrompt = `You are a Virtual Fly Brain (VFB) assistant specialising in Drosophila melanogaster neuroanatomy, neuroscience, and related research.

SCOPE:
You may only discuss:
- Drosophila neuroanatomy, neural circuits, brain regions, and cell types
- Gene expression, transgenes, and genetic tools used in Drosophila neuroscience
- Connectomics, morphological analysis (including NBLAST), and neural connectivity data
- VFB tools, data, approved documentation pages, and related peer-reviewed or preprint literature

Decline unrelated questions, including general web browsing, non-Drosophila topics, coding help, or other off-topic requests.

APPROVED OUTPUT LINKS ONLY:
You may only output links or images from these approved domains:
- virtualflybrain.org and subdomains
- flybase.org
- doi.org
- pubmed.ncbi.nlm.nih.gov
- biorxiv.org
- medrxiv.org
If a source is not on this list, do not cite or link to it.

ACCURACY:
- Use VFB and publication tools rather than answering from memory when data is available.
- If tools return no results, say so instead of guessing.
- Distinguish clearly between VFB-derived facts and broader scientific context.

TOOLS:
- vfb_search_terms: search VFB terms with filters
- vfb_get_term_info: fetch detailed VFB term information
- vfb_run_query: run VFB analyses returned by vfb_get_term_info
- search_reviewed_docs: search a reviewed local index of approved VFB and FlyBase pages only
- search_pubmed / get_pubmed_article: search and fetch peer-reviewed publications
- biorxiv_search_preprints / biorxiv_get_preprint / biorxiv_search_published_preprints / biorxiv_get_categories: preprint discovery

TOOL SELECTION:
- Questions about VFB terms, anatomy, neurons, genes, or datasets: use VFB tools
- Questions about published papers or recent literature: use PubMed first, optionally bioRxiv/medRxiv for preprints
- Questions about VFB or approved FlyBase documentation pages: use search_reviewed_docs
- Do not attempt general web search or browsing outside the approved reviewed-doc index

CITATIONS:
- Only cite publications returned by VFB, PubMed, or bioRxiv/medRxiv tools
- Use markdown links with human-readable titles, not bare URLs or raw IDs when a title is available
- For FlyBase references, prefer author/year or paper title as the link text

FORMATTING VFB REFERENCES:
- Use markdown links with descriptive names, not bare VFB or FBbt IDs
- When thumbnail URLs are present in tool output, include them using markdown image syntax
- Only use thumbnail URLs that actually appear in tool results

FOLLOW-UP QUESTIONS:
When useful, suggest 2-3 short follow-up questions relevant to Drosophila neuroscience and actionable with the available tools.`

function getStatusForTool(toolName) {
  if (toolName.startsWith('vfb_')) {
    return { message: 'Querying the fly hive mind', phase: 'mcp' }
  }

  if (toolName.startsWith('biorxiv_')) {
    return { message: 'Searching preprints', phase: 'biorxiv' }
  }

  if (toolName === 'search_pubmed' || toolName === 'get_pubmed_article') {
    return { message: 'Searching publications', phase: 'pubmed' }
  }

  if (toolName === 'search_reviewed_docs') {
    return { message: 'Searching reviewed VFB docs', phase: 'docs' }
  }

  return { message: 'Processing results', phase: 'llm' }
}

async function readResponseStream(apiResponse, sendEvent) {
  const reader = apiResponse.body.getReader()
  const decoder = new TextDecoder()
  const functionCalls = []
  let buffer = ''
  let textAccumulator = ''
  let responseId = null
  let failed = false
  let errorMessage = null
  const announcedStatuses = new Set()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('event: ')) continue
        if (!line.startsWith('data: ')) continue

        const dataStr = line.slice(6).trim()
        if (dataStr === '[DONE]') continue

        try {
          const event = JSON.parse(dataStr)
          const eventType = event.type

          switch (eventType) {
            case 'response.created':
              responseId = event.response?.id || responseId
              break

            case 'response.output_item.added':
              if (event.item?.type === 'function_call') {
                const toolName = event.item?.name || ''
                if (toolName && !announcedStatuses.has(toolName)) {
                  sendEvent('status', getStatusForTool(toolName))
                  announcedStatuses.add(toolName)
                }
              } else if (event.item?.type === 'message') {
                sendEvent('status', { message: 'Processing results', phase: 'llm' })
              }
              break

            case 'response.output_text.delta':
              if (event.delta) {
                textAccumulator += event.delta
              }
              break

            case 'response.output_item.done':
              if (event.item?.type === 'function_call') {
                functionCalls.push({
                  call_id: event.item.call_id,
                  name: event.item.name,
                  arguments: event.item.arguments
                })
              } else if (event.item?.type === 'reasoning') {
                const reasoningText = event.item?.summary?.map(summary => summary.text).join('\n') || ''
                if (reasoningText) {
                  sendEvent('reasoning', { text: reasoningText })
                }
              }
              break

            case 'response.completed':
              responseId = event.response?.id || responseId
              break

            case 'response.failed':
              failed = true
              errorMessage = event.response?.status_details?.error?.message || 'The AI service failed to complete the request.'
              return { textAccumulator, functionCalls, responseId, failed, errorMessage }

            case 'error':
              failed = true
              errorMessage = event.message || 'The AI service returned an unexpected stream error.'
              return { textAccumulator, functionCalls, responseId, failed, errorMessage }
          }
        } catch {
          // Skip malformed stream chunks without logging raw payload content.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { textAccumulator, functionCalls, responseId, failed, errorMessage }
}

async function processResponseStream({ apiResponse, sendEvent, conversationInput, apiBaseUrl, apiKey, apiModel }) {
  const outboundAllowList = getOutboundAllowList()
  const toolUsage = {}
  const accumulatedItems = []
  const maxFunctionRounds = 5
  let currentResponse = apiResponse
  let latestResponseId = null
  let toolRounds = 0

  for (let round = 0; round <= maxFunctionRounds; round++) {
    const { textAccumulator, functionCalls, responseId, failed, errorMessage } = await readResponseStream(currentResponse, sendEvent)
    if (responseId) latestResponseId = responseId

    if (failed) {
      return {
        ok: false,
        responseId: latestResponseId,
        toolUsage,
        toolRounds,
        errorMessage: errorMessage || 'The AI service failed to complete the request.',
        errorCategory: 'upstream_stream_error'
      }
    }

    if (functionCalls.length > 0) {
      toolRounds += 1

      const toolOutputs = await Promise.all(functionCalls.map(async (functionCall) => {
        try {
          const args = typeof functionCall.arguments === 'string'
            ? JSON.parse(functionCall.arguments)
            : functionCall.arguments

          toolUsage[functionCall.name] = (toolUsage[functionCall.name] || 0) + 1

          return {
            call_id: functionCall.call_id,
            name: functionCall.name,
            arguments: functionCall.arguments,
            output: await executeFunctionTool(functionCall.name, args)
          }
        } catch (error) {
          toolUsage[functionCall.name] = (toolUsage[functionCall.name] || 0) + 1

          return {
            call_id: functionCall.call_id,
            name: functionCall.name,
            arguments: functionCall.arguments,
            output: JSON.stringify({ error: error.message })
          }
        }
      }))

      for (const toolOutput of toolOutputs) {
        accumulatedItems.push({
          type: 'function_call',
          call_id: toolOutput.call_id,
          name: toolOutput.name,
          arguments: typeof toolOutput.arguments === 'string'
            ? toolOutput.arguments
            : JSON.stringify(toolOutput.arguments)
        })
        accumulatedItems.push({
          type: 'function_call_output',
          call_id: toolOutput.call_id,
          output: toolOutput.output
        })
      }

      const submitResponse = await fetch(`${apiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: apiModel,
          instructions: systemPrompt,
          input: [...conversationInput, ...accumulatedItems],
          tools: getToolConfig(),
          stream: true
        })
      })

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text()
        return {
          ok: false,
          responseId: latestResponseId,
          toolUsage,
          toolRounds,
          errorMessage: `Failed to process tool results. ${sanitizeApiError(submitResponse.status, errorText)}`,
          errorCategory: 'tool_submission_failed',
          errorStatus: submitResponse.status
        }
      }

      currentResponse = submitResponse
      continue
    }

    if (!textAccumulator) {
      return {
        ok: false,
        responseId: latestResponseId,
        toolUsage,
        toolRounds,
        errorMessage: 'The AI did not generate a response. Please try again.',
        errorCategory: 'empty_response'
      }
    }

    const { sanitizedText, blockedDomains } = sanitizeAssistantOutput(textAccumulator, outboundAllowList)
    const thumbnailRegex = /https:\/\/www\.virtualflybrain\.org\/data\/VFB\/i\/([^/]+)\/([^/]+)\/thumbnail(?:T)?\.png/g
    const images = []
    let match
    while ((match = thumbnailRegex.exec(sanitizedText)) !== null) {
      images.push({
        id: match[2],
        template: match[1],
        thumbnail: match[0],
        label: `VFB Image ${match[2]}`
      })
    }

    return {
      ok: true,
      responseId: latestResponseId,
      toolUsage,
      toolRounds,
      responseText: sanitizedText,
      images,
      blockedResponseDomains: blockedDomains
    }
  }

  return {
    ok: false,
    responseId: latestResponseId,
    toolUsage,
    toolRounds,
    errorMessage: 'The response required too many tool calls. Please try a simpler question.',
    errorCategory: 'tool_round_limit_exceeded'
  }
}

export async function POST(request) {
  ensureGovernanceStorage()
  const startTime = Date.now()
  const requestId = createRequestId()
  const clientIp = getClientIp(request)
  let rateCheck = null
  let blockedRequestedDomains = []

  try {
    validateProductionCompliance()
  } catch (error) {
    const responseId = `local-${requestId}`
    await finalizeGovernanceEvent({
      requestId,
      responseId,
      clientIp,
      startTime,
      rateCheck,
      message: '',
      responseText: '',
      refusal: true,
      errored: true,
      reasonCode: 'production_configuration',
      errorCategory: 'production_configuration'
    })

    return createImmediateErrorResponse(
      'The service is not correctly configured for production use. Please contact the VFB team.',
      requestId,
      responseId
    )
  }

  rateCheck = checkAndIncrement(clientIp)
  if (!rateCheck.allowed) {
    const responseId = `local-${requestId}`
    const message = `Daily rate limit exceeded (${rateCheck.limit} requests per day). Please try again tomorrow.`

    await finalizeGovernanceEvent({
      requestId,
      responseId,
      clientIp,
      startTime,
      rateCheck,
      message: '',
      responseText: message,
      refusal: true,
      reasonCode: 'rate_limit_exceeded'
    })

    return createImmediateErrorResponse(message, requestId, responseId)
  }

  const body = await request.json()
  const messages = Array.isArray(body.messages) ? body.messages : []
  const scene = body.scene || {}
  const message = typeof messages[messages.length - 1]?.content === 'string'
    ? messages[messages.length - 1].content
    : ''

  if (!message.trim()) {
    const responseId = `local-${requestId}`
    const errorMessage = 'Please enter a question before sending.'

    await finalizeGovernanceEvent({
      requestId,
      responseId,
      clientIp,
      startTime,
      rateCheck,
      message,
      responseText: errorMessage,
      refusal: true,
      reasonCode: 'empty_message'
    })

    return createImmediateErrorResponse(errorMessage, requestId, responseId)
  }

  if (detectJailbreakAttempt(message)) {
    const responseId = `local-${requestId}`
    const refusalMessage = 'I cannot assist with attempts to bypass safety restrictions or override my core instructions. Please ask questions related to Drosophila neuroscience and Virtual Fly Brain data.'

    await finalizeGovernanceEvent({
      requestId,
      responseId,
      clientIp,
      startTime,
      rateCheck,
      message,
      responseText: refusalMessage,
      refusal: true,
      abuseFlag: true,
      reasonCode: 'jailbreak_attempt'
    })

    return createImmediateErrorResponse(refusalMessage, requestId, responseId)
  }

  if (requestMentionsSearchIntent(message)) {
    blockedRequestedDomains = findBlockedRequestedDomains(message, getSearchAllowList())
  }

  if (blockedRequestedDomains.length > 0) {
    logBlockedSearchAudit({
      requestId,
      ip: clientIp,
      blockedDomains: blockedRequestedDomains
    })

    const responseId = `local-${requestId}`
    const refusalMessage = `I can only search reviewed Virtual Fly Brain and FlyBase pages. The requested domain${blockedRequestedDomains.length === 1 ? '' : 's'} ${blockedRequestedDomains.join(', ')} ${blockedRequestedDomains.length === 1 ? 'is' : 'are'} not approved for search in this service.`

    await finalizeGovernanceEvent({
      requestId,
      responseId,
      clientIp,
      startTime,
      rateCheck,
      message,
      responseText: refusalMessage,
      blockedRequestedDomains,
      refusal: true,
      reasonCode: 'blocked_requested_domain'
    })

    return createImmediateErrorResponse(refusalMessage, requestId, responseId)
  }

  loadLookupCache()

  return buildSseResponse(async (sendEvent) => {
    const resolvedUserMessage = replaceTermsWithLinks(message)
    const conversationInput = [
      ...messages.slice(0, -1).map(item => ({ role: item.role, content: item.content })),
      { role: 'user', content: resolvedUserMessage }
    ]

    const apiBaseUrl = getConfiguredApiBaseUrl()
    const apiKey = process.env.OPENAI_API_KEY?.trim() || ''
    const apiModel = getConfiguredModel()

    sendEvent('status', { message: 'Thinking...', phase: 'llm' })

    let apiResponse
    try {
      const timeoutMs = 180000
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

      apiResponse = await fetch(`${apiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: apiModel,
          instructions: systemPrompt,
          input: conversationInput,
          tools: getToolConfig(),
          stream: true
        }),
        signal: abortController.signal
      })

      clearTimeout(timeoutId)

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text()

        if (isTransientError(apiResponse.status)) {
          const maxRetries = 2

          for (let retry = 1; retry <= maxRetries; retry++) {
            sendEvent('status', { message: `AI service temporarily unavailable, retrying (${retry}/${maxRetries})...`, phase: 'llm' })
            await new Promise(resolve => setTimeout(resolve, retry * 3000))

            const retryAbort = new AbortController()
            const retryTimeoutId = setTimeout(() => retryAbort.abort(), timeoutMs)

            try {
              const retryResponse = await fetch(`${apiBaseUrl}/responses`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify({
                  model: apiModel,
                  instructions: systemPrompt,
                  input: conversationInput,
                  tools: getToolConfig(),
                  stream: true
                }),
                signal: retryAbort.signal
              })

              clearTimeout(retryTimeoutId)
              if (retryResponse.ok) {
                apiResponse = retryResponse
                break
              }
            } catch {
              clearTimeout(retryTimeoutId)
            }
          }
        }

        if (!apiResponse.ok) {
          const responseId = `local-${requestId}`
          const friendlyMessage = sanitizeApiError(apiResponse.status, errorText)
          const userMessage = `Sorry, the AI service is temporarily unavailable. ${friendlyMessage}`

          await finalizeGovernanceEvent({
            requestId,
            responseId,
            clientIp,
            startTime,
            rateCheck,
            message,
            responseText: userMessage,
            blockedRequestedDomains,
            refusal: false,
            errored: true,
            reasonCode: 'upstream_http_error',
            errorCategory: 'upstream_http_error',
            errorStatus: apiResponse.status
          })

          sendEvent('error', { message: userMessage, requestId, responseId })
          return
        }
      }

      const result = await processResponseStream({
        apiResponse,
        sendEvent,
        conversationInput,
        apiBaseUrl,
        apiKey,
        apiModel
      })

      if (!result.ok) {
        const responseId = result.responseId || `local-${requestId}`

        await finalizeGovernanceEvent({
          requestId,
          responseId,
          clientIp,
          startTime,
          rateCheck,
          message,
          responseText: result.errorMessage,
          toolUsage: result.toolUsage,
          toolRounds: result.toolRounds,
          blockedRequestedDomains,
          refusal: false,
          errored: true,
          reasonCode: result.errorCategory,
          errorCategory: result.errorCategory,
          errorStatus: result.errorStatus
        })

        sendEvent('error', { message: result.errorMessage, requestId, responseId })
        return
      }

      const responseId = result.responseId || `local-${requestId}`
      await finalizeGovernanceEvent({
        requestId,
        responseId,
        clientIp,
        startTime,
        rateCheck,
        message,
        responseText: result.responseText,
        toolUsage: result.toolUsage,
        toolRounds: result.toolRounds,
        imagesCount: result.images.length,
        blockedRequestedDomains,
        blockedResponseDomains: result.blockedResponseDomains
      })

      sendEvent('result', {
        response: result.responseText,
        images: result.images,
        newScene: scene,
        requestId,
        responseId
      })
    } catch (error) {
      const responseId = `local-${requestId}`
      let userMessage = 'Sorry, something went wrong processing your request. Please try again.'
      let errorCategory = 'unexpected_error'

      if (error.name === 'AbortError' || error.message?.includes('abort')) {
        userMessage = 'The request timed out. The AI service may be under heavy load, so please try again in a moment.'
        errorCategory = 'timeout'
      } else if (error.message?.includes('fetch') || error.message?.includes('ECONNREFUSED')) {
        userMessage = 'Unable to reach the AI service. Please check your connection and try again.'
        errorCategory = 'connectivity'
      }

      await finalizeGovernanceEvent({
        requestId,
        responseId,
        clientIp,
        startTime,
        rateCheck,
        message,
        responseText: userMessage,
        blockedRequestedDomains,
        refusal: false,
        errored: true,
        reasonCode: errorCategory,
        errorCategory
      })

      sendEvent('error', { message: userMessage, requestId, responseId })
    }
  })
}
