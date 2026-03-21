import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { checkAndIncrement } from '../../../lib/rateLimit.js'

// GA4 Analytics configuration
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || 'G-K7DDZVVXM7'
const GA_API_SECRET = process.env.GA_API_SECRET || ''
const GA_ENABLED = !!(GA_MEASUREMENT_ID && GA_API_SECRET)

log('GA Configuration', {
  measurementId: GA_MEASUREMENT_ID,
  apiSecretSet: !!GA_API_SECRET,
  enabled: GA_ENABLED
})

function log(message, data = {}) {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '')
}

// Track user queries and responses to Google Analytics
function trackQuery(query, responseLength, duration, sessionId) {
  if (!GA_ENABLED) {
    log('GA tracking disabled - missing GA_MEASUREMENT_ID or GA_API_SECRET')
    return
  }

  log('GA tracking enabled, sending event', { queryLength: query.length, responseLength, duration })

  // Truncate query for privacy and to avoid GA limits (500 char limit per parameter)
  const truncatedQuery = query.length > 200 ? query.substring(0, 200) + '...' : query

  const payload = {
    client_id: sessionId || 'anonymous',
    events: [{
      name: 'chat_query',
      params: {
        query_text: truncatedQuery,      // The actual query text (truncated)
        query_length: query.length,      // Original query length
        response_length: responseLength, // Length of the AI response
        duration_ms: duration,           // Processing time in milliseconds
        session_id: sessionId,           // Session identifier
        timestamp: new Date().toISOString() // ISO timestamp of the event
      }
    }]
  }

  axios.post(
    `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`,
    payload
  ).then(() => {
    log('GA event sent successfully')
  }).catch((error) => {
    log('GA event failed', { error: error.message, status: error.response?.status })
  })
}

// Sanitize API error responses – replace raw HTML (e.g. Cloudflare 5xx pages)
// with a concise, user-friendly message.
function sanitizeApiError(statusCode, rawText) {
  // Detect HTML error pages (Cloudflare, nginx, etc.)
  if (rawText && (rawText.trim().startsWith('<!DOCTYPE') || rawText.trim().startsWith('<html'))) {
    const titleMatch = rawText.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : `HTTP ${statusCode}`
    return `The AI service returned an error (${title}). This is usually a temporary issue — please try again in a moment.`
  }
  // Try to parse JSON errors and extract the message
  if (rawText && rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText)
      const msg = parsed?.error?.message
      if (msg) return msg
    } catch { /* fall through */ }
  }
  // Cap very long non-HTML errors to avoid flooding the UI
  if (rawText && rawText.length > 400) {
    return rawText.substring(0, 400) + '…'
  }
  return rawText || `HTTP ${statusCode}`
}

// Determine whether an HTTP status code is a transient server error worth retrying
function isTransientError(status) {
  return [429, 500, 502, 503, 504, 520, 521, 522, 524].includes(status)
}

// Pick the OpenAI model to use for LLM completions.
function getOpenAIModel() {
  const explicit = process.env.OPENAI_MODEL?.trim()
  if (explicit) return explicit

  const isProd = process.env.NODE_ENV === 'production'
  return isProd ? 'gpt-5.4-nano' : 'gpt-4o-mini'
}

// --- MCP client management (lazy initialization) ---

let vfbMcpClient = null
let biorxivMcpClient = null

const VFB_MCP_URL = 'https://vfb3-mcp.virtualflybrain.org/'
const BIORXIV_MCP_URL = 'https://mcp.deepsense.ai/biorxiv/mcp'

async function getVfbMcpClient() {
  if (vfbMcpClient) return vfbMcpClient
  try {
    log('Initializing VFB MCP client...')
    const transport = new StreamableHTTPClientTransport(new URL(VFB_MCP_URL))
    const client = new Client(
      { name: 'vfb-chat-client', version: '3.0.0' },
      { capabilities: {} }
    )
    await client.connect(transport)
    log('VFB MCP client connected')
    vfbMcpClient = client
    return client
  } catch (err) {
    log('VFB MCP client connection failed', { error: err.message })
    throw err
  }
}

async function getBiorxivMcpClient() {
  if (biorxivMcpClient) return biorxivMcpClient
  try {
    log('Initializing bioRxiv MCP client...')
    const transport = new StreamableHTTPClientTransport(new URL(BIORXIV_MCP_URL))
    const client = new Client(
      { name: 'vfb-chat-biorxiv', version: '3.0.0' },
      { capabilities: {} }
    )
    await client.connect(transport)
    log('bioRxiv MCP client connected')
    biorxivMcpClient = client
    return client
  } catch (err) {
    log('bioRxiv MCP client connection failed', { error: err.message })
    throw err
  }
}

// Build the tools array for the Responses API.
// All MCP tools are relayed as type: "function" through local MCP clients.
function getToolConfig() {
  const tools = []

  // --- VFB MCP tools (relayed via local MCP client) ---
  tools.push({
    type: 'function',
    name: 'vfb_search_terms',
    description: 'Search VFB terms by keywords, with optional filtering by entity type. Use specific filters to limit results. Always exclude ["deprecated"]. Use minimize_results: true for initial broad searches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query keywords' },
        filter_types: {
          type: 'array', items: { type: 'string' },
          description: 'Filter by entity types (e.g., ["neuron","adult","has_image"], ["dataset"], ["anatomy"], ["gene"])'
        },
        exclude_types: {
          type: 'array', items: { type: 'string' },
          description: 'Exclude types (e.g., ["deprecated"])'
        },
        boost_types: {
          type: 'array', items: { type: 'string' },
          description: 'Boost types to prioritize (e.g., ["has_image", "has_neuron_connectivity"])'
        },
        start: { type: 'number', description: 'Pagination start index (default 0)' },
        rows: { type: 'number', description: 'Number of results (default 10, max 50)' },
        minimize_results: { type: 'boolean', description: 'Return minimal fields for faster response (default false). Use true for initial broad searches.' },
        auto_fetch_term_info: { type: 'boolean', description: 'Automatically fetch full term info when searching for a specific term by name (default false)' }
      },
      required: ['query']
    }
  })

  tools.push({
    type: 'function',
    name: 'vfb_get_term_info',
    description: 'Get detailed information about a VFB term by ID, including definitions, relationships, images, queries, and references. Supports batch requests with arrays of IDs.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The VFB term ID (e.g., VFB_00102107, FBbt_00003748)' }
      },
      required: ['id']
    }
  })

  tools.push({
    type: 'function',
    name: 'vfb_run_query',
    description: 'Run analyses like PaintedDomains, NBLAST, Connectivity on a VFB entity. IMPORTANT: Only use query_type values returned in the Queries array from vfb_get_term_info.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The VFB term ID to query' },
        query_type: { type: 'string', description: 'Type of query (e.g., PaintedDomains, NBLAST, NeuronNeuronConnectivityQuery)' }
      },
      required: ['id', 'query_type']
    }
  })

  // --- bioRxiv MCP tools (relayed via local MCP client) ---
  tools.push({
    type: 'function',
    name: 'biorxiv_search_preprints',
    description: 'Search bioRxiv/medRxiv preprints by date range and category. No keyword search — filter by category and date only. Results are NOT peer-reviewed.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD (e.g., "2024-01-01")' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD' },
        category: { type: 'string', description: 'Subject category (e.g., "neuroscience", "genetics", "cell biology")' },
        recent_days: { type: 'number', description: 'Alternative: get preprints from last N days' },
        limit: { type: 'number', description: 'Max results (1-100, default 10)' },
        cursor: { type: 'number', description: 'Pagination cursor (default 0)' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'Server to query (default biorxiv)' }
      }
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_get_preprint',
    description: 'Get full metadata for a preprint by DOI: title, authors, abstract, PDF URL, published DOI if available.',
    parameters: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'DOI (e.g., "10.1101/2024.01.15.123456")' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'Server (default biorxiv)' }
      },
      required: ['doi']
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_search_published_preprints',
    description: 'Find preprints that were published in peer-reviewed journals. Filter by date, publisher DOI prefix.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD' },
        recent_days: { type: 'number', description: 'Alternative: last N days' },
        publisher: { type: 'string', description: 'Publisher DOI prefix (e.g., "10.1038" for Nature)' },
        limit: { type: 'number', description: 'Max results (1-100, default 10)' },
        cursor: { type: 'number', description: 'Pagination cursor (default 0)' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'Server (default biorxiv)' }
      }
    }
  })

  tools.push({
    type: 'function',
    name: 'biorxiv_get_categories',
    description: 'List all bioRxiv subject categories for filtering searches.',
    parameters: { type: 'object', properties: {} }
  })

  // --- Web search (native OpenAI tool, restricted to VFB domains) ---
  tools.push({
    type: 'web_search',
    search_context_size: 'medium',
    user_location: { type: 'approximate' }
  })

  // --- PubMed tools (direct NCBI E-utilities, no MCP) ---
  tools.push({
    type: 'function',
    name: 'search_pubmed',
    description: 'Search PubMed for published scientific articles. Returns titles, authors, abstracts, PMIDs, and DOIs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "Drosophila medulla neurons connectome")' },
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
        pmid: { type: 'string', description: 'PubMed ID (e.g., "12345678")' }
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
      authors: (article.authors || []).map(a => a.name).slice(0, 5).join(', '),
      journal: article.fulljournalname || article.source,
      pub_date: article.pubdate,
      doi: (article.articleids || []).find(id => id.idtype === 'doi')?.value || null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    }
  }).filter(Boolean)

  return JSON.stringify({
    results: articles,
    total_found: parseInt(searchData.esearchresult?.count || 0)
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
    let m
    while ((m = regex.exec(xmlText)) !== null) {
      matches.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    }
    return matches
  }

  const title = extract('ArticleTitle')
  const abstractText = extract('AbstractText') || extract('Abstract')
  const journal = extract('Title')
  const year = extract('Year')
  const doi = (() => {
    const doiMatch = xmlText.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/i)
    return doiMatch ? doiMatch[1] : null
  })()

  const authorBlocks = xmlText.match(/<Author[^>]*>[\s\S]*?<\/Author>/gi) || []
  const authors = authorBlocks.slice(0, 10).map(block => {
    const lastName = block.match(/<LastName>([^<]+)<\/LastName>/i)?.[1] || ''
    const firstName = block.match(/<ForeName>([^<]+)<\/ForeName>/i)?.[1] || ''
    return `${firstName} ${lastName}`.trim()
  }).filter(Boolean)

  const keywords = extractAll('Keyword').slice(0, 10)

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
    keywords
  })
}

// --- Function tool execution (routes to MCP clients or direct APIs) ---

// Map tool names to their MCP server and the actual MCP tool name
const MCP_TOOL_ROUTING = {
  // VFB tools — strip "vfb_" prefix to get the MCP tool name
  vfb_search_terms: { server: 'vfb', mcpName: 'search_terms' },
  vfb_get_term_info: { server: 'vfb', mcpName: 'get_term_info' },
  vfb_run_query: { server: 'vfb', mcpName: 'run_query' },
  // bioRxiv tools — strip "biorxiv_" prefix
  biorxiv_search_preprints: { server: 'biorxiv', mcpName: 'search_preprints' },
  biorxiv_get_preprint: { server: 'biorxiv', mcpName: 'get_preprint' },
  biorxiv_search_published_preprints: { server: 'biorxiv', mcpName: 'search_published_preprints' },
  biorxiv_get_categories: { server: 'biorxiv', mcpName: 'get_categories' }
}

async function executeFunctionTool(name, args) {
  // PubMed — direct API calls (no MCP)
  if (name === 'search_pubmed') {
    return await searchPubmed(args.query, args.max_results, args.sort)
  }
  if (name === 'get_pubmed_article') {
    return await getPubmedArticle(args.pmid)
  }

  // MCP-relayed tools
  const routing = MCP_TOOL_ROUTING[name]
  if (routing) {
    const client = routing.server === 'vfb'
      ? await getVfbMcpClient()
      : await getBiorxivMcpClient()

    // Remove undefined/null values from args to keep the MCP call clean
    const cleanArgs = {}
    for (const [k, v] of Object.entries(args || {})) {
      if (v !== undefined && v !== null) cleanArgs[k] = v
    }

    log('MCP relay call', { tool: routing.mcpName, server: routing.server, args: Object.keys(cleanArgs) })
    const result = await client.callTool({ name: routing.mcpName, arguments: cleanArgs })

    // MCP callTool returns { content: [{ type, text }] } — extract text
    if (result?.content) {
      const texts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
      return texts.join('\n') || JSON.stringify(result.content)
    }
    return JSON.stringify(result)
  }

  throw new Error(`Unknown function tool: ${name}`)
}

// Check for common jailbreak attempts
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
  let suspiciousCount = 0
  for (const word of suspiciousWords) {
    suspiciousCount += (lowerMessage.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length
  }
  if (suspiciousCount > 2) return true

  return false
}

// --- Lookup cache (read-only, loaded from static file) ---

let lookupCache = null
let reverseLookupCache = null
let normalizedLookupCache = null
const CACHE_FILE = path.join(process.cwd(), 'vfb_lookup_cache.json')

function loadLookupCache() {
  if (lookupCache) return

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      lookupCache = cacheData.lookup || {}
      reverseLookupCache = cacheData.reverseLookup || {}
      normalizedLookupCache = cacheData.normalizedLookup || {}
      log('Loaded lookup cache from file', { entries: Object.keys(lookupCache).length })
    } else {
      log('No lookup cache file found, initializing with essential terms')
      lookupCache = {}
      reverseLookupCache = {}
      normalizedLookupCache = {}
      seedEssentialTerms()
    }
  } catch (error) {
    log('Failed to load cache file', { error: error.message })
    lookupCache = {}
    reverseLookupCache = {}
    normalizedLookupCache = {}
    seedEssentialTerms()
  }
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

  Object.entries(essentialTerms).forEach(([term, id]) => {
    lookupCache[term] = id
    reverseLookupCache[id] = term
    const normalized = normalizeKey(term)
    if (!normalizedLookupCache[normalized]) {
      normalizedLookupCache[normalized] = id
    }
  })

  log('Seeded lookup cache with essential verified terms', { count: Object.keys(essentialTerms).length })
}

function normalizeKey(key) {
  let normalized = key.toLowerCase()
    .replace(/_/g, '')
    .replace(/-/g, '')
    .replace(/\s+/g, '')
    .replace(/:/g, '')
    .replace(/;/g, '')

  const prefixSubs = [
    ['adult', ''],
    ['larval', ''],
    ['pupal', ''],
    ['embryonic', ''],
    ['larva', ''],
    ['pupa', ''],
    ['embryo', '']
  ]

  for (const [prefix] of prefixSubs) {
    if (normalized.startsWith(prefix)) {
      const withoutPrefix = normalized.substring(prefix.length)
      if (withoutPrefix.length > 2) {
        normalized = withoutPrefix
        break
      }
    }
  }

  return normalized
}

function replaceTermsWithLinks(text) {
  if (!text || !lookupCache) return text

  const sortedTerms = Object.keys(lookupCache)
    .filter(term => term.length > 2)
    .sort((a, b) => b.length - a.length)

  let result = text
  const allLinks = []

  // Protect existing URLs (including those embedded in markdown/HTML) so we don't
  // accidentally rewrite IDs that are already part of a URL.
  const urlPlaceholders = []
  const URL_PLACEHOLDER = '\x00URL'
  result = result.replace(/https?:\/\/[^\s)]+/g, (url) => {
    urlPlaceholders.push(url)
    return `${URL_PLACEHOLDER}${urlPlaceholders.length - 1}\x00`
  })

  // Protect existing markdown links and images
  result = result.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (match) => {
    allLinks.push(match)
    return `\x00LINK${allLinks.length - 1}\x00`
  })

  const REPORT_BASE = 'https://virtualflybrain.org/reports/'

  for (const term of sortedTerms) {
    const id = lookupCache[term]
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi')
    result = result.replace(regex, (match) => {
      const link = `[${match}](${REPORT_BASE + encodeURIComponent(id)})`
      allLinks.push(link)
      return `\x00LINK${allLinks.length - 1}\x00`
    })
  }

  // Link raw VFB/FBbt IDs using their preferred short label when available.
  // This makes e.g. "VFB_00102107" render as "%label%" but still link to the report.
  result = result.replace(/\b(FBbt_\d{8}|VFB_\d{8})\b/g, (match) => {
    const label = reverseLookupCache?.[match]
    const display = label || match
    const link = `[${display}](${REPORT_BASE + encodeURIComponent(match)})`
    allLinks.push(link)
    return `\x00LINK${allLinks.length - 1}\x00`
  })

  result = result.replace(/\x00LINK(\d+)\x00/g, (_, idx) => allLinks[parseInt(idx)])
  result = result.replace(new RegExp(`${URL_PLACEHOLDER}(\\d+)\\x00`, 'g'), (_, idx) => urlPlaceholders[parseInt(idx)])

  return result
}

// System prompt
const systemPrompt = `You are a Virtual Fly Brain (VFB) assistant specialising in Drosophila melanogaster neuroanatomy, neuroscience, and related research.

SCOPE & GUARDRAILS:
You MUST only discuss topics related to:
- Drosophila neuroanatomy, neural circuits, brain regions, and cell types
- Gene expression, transgenes, and genetic tools used in Drosophila neuroscience
- Connectomics, morphological analysis (NBLAST), and neural connectivity data
- Research techniques and methodologies used in fly neuroscience (e.g., light microscopy, EM, calcium imaging, optogenetics)
- Published scientific papers and references relevant to Drosophila neuroscience
- VFB tools, data, and how to use the Virtual Fly Brain platform

You MUST politely decline any questions outside this scope, including general knowledge, non-Drosophila biology, medical advice, coding help, or any other unrelated topics.

TRUSTED SOURCES ONLY:
When referencing external resources, ONLY link to these trusted domains:
- virtualflybrain.org — VFB platform and documentation
- flybase.org — Drosophila gene and genome database
- catmaid.virtualflybrain.org — CATMAID neuronal reconstruction
- neuromorpho.org — neuron morphology database
- Published journal articles referenced in VFB data (identified by DOI or FBrf IDs)
- insectbraindb.org — Insect brain database
- flywire.ai — FlyWire connectome
- pubmed.ncbi.nlm.nih.gov — PubMed published articles
- biorxiv.org — bioRxiv preprints (note: preprints are NOT peer-reviewed)
Do NOT link to or reference any other websites. If a user asks you to visit, search, or retrieve content from websites outside this list, decline and explain you can only reference trusted Drosophila neuroscience resources.

ACCURACY:
- Always use VFB tools to look up information rather than relying on general knowledge. If tools return no results, say so rather than guessing.
- Clearly distinguish between data from VFB tools and your general scientific knowledge.
- When citing research, use FBrf reference IDs from VFB data where available, or DOIs/PMIDs from PubMed/bioRxiv searches.

CITATIONS:
- ONLY cite publications that are explicitly returned in VFB data Publications field or from PubMed/bioRxiv tool results
- Do NOT generate citations from general knowledge or invent DOIs
- If no publications are available in VFB data, do not include any citations
- For FlyBase references (FBrf IDs), use markdown link format with the citation as link text: [Nern et al., 2025](https://flybase.org/reports/FBrf0262545). Do NOT show the bare FBrf ID — use the author/year as the clickable link text.
- For DOIs, use markdown link format: [Paper Title](https://doi.org/XXXXXXX)
- For PubMed results, use markdown link format: [Paper Title](https://pubmed.ncbi.nlm.nih.gov/PMID/)
- Never show bare reference IDs (FBrf, PMID, DOI) when you have the author names and year — always make the human-readable citation the clickable link.
- Do not reference "common Drosophila neuroscience papers" unless they appear in the actual VFB data for the specific entity being discussed

VFB TOOLS:
The VFB tools are available as function tools with the "vfb_" prefix:
- vfb_search_terms(query, filter_types, exclude_types, boost_types, start, rows, minimize_results, auto_fetch_term_info): Search VFB terms with filters like ["dataset"] for datasets, ["neuron","adult","has_image"] for adult neurons, ["anatomy"] for brain regions, ["gene"] for genes. Always exclude ["deprecated"]. Use minimize_results: true for initial broad searches. Use auto_fetch_term_info: true when searching for a specific term by name.
- vfb_get_term_info(id): Get detailed info about a VFB entity by ID. Supports batch requests with arrays of IDs.
- vfb_run_query(id, query_type): Run analyses like PaintedDomains, NBLAST, Connectivity. IMPORTANT: Only use query_type values that are returned in the Queries array from vfb_get_term_info for the given id.

PUBLICATION TOOLS:
- biorxiv_search_preprints: Search bioRxiv/medRxiv preprints by date and category. Note: preprints are NOT peer-reviewed.
- biorxiv_get_preprint(doi): Get full preprint metadata by DOI.
- biorxiv_search_published_preprints: Find preprints published in peer-reviewed journals.
- biorxiv_get_categories: List bioRxiv subject categories.
- search_pubmed(query, max_results, sort): Search PubMed for peer-reviewed articles.
- get_pubmed_article(pmid): Get full PubMed article details by PMID.
When users ask about published research or recent findings, use these tools. Always format publication links as markdown links with the paper title as the link text:
- PubMed: [Paper Title](https://pubmed.ncbi.nlm.nih.gov/<PMID>/)
- DOI: [Paper Title](https://doi.org/<DOI>)
- FlyBase: [Paper Title](https://flybase.org/reports/<FBrf>)
Never output bare publication URLs — always use markdown link syntax with a descriptive title so users know what they are clicking on.

TOOL SELECTION — match the user's intent to the right tool:
- "Find papers/publications/research on X" → use search_pubmed FIRST (keyword search for peer-reviewed articles), optionally biorxiv_search_preprints for preprints
- "What is X? / Tell me about X" → use vfb_search_terms + vfb_get_term_info (VFB data lookup)
- "What neurons/genes/datasets in X?" → use vfb_search_terms with appropriate filters
- "What connectivity/queries for X?" → use vfb_get_term_info then vfb_run_query
- "When is NeuroFly? / VFB documentation" → web_search (searches the web including virtualflybrain.org)
- "Recent preprints on X" → biorxiv_search_preprints (filter by category like "neuroscience")
Do NOT use web_search as a substitute for search_pubmed when the user asks for papers — PubMed gives structured results with titles, authors, DOIs. Web search is for VFB website content and general Drosophila neuroscience information.

STRATEGY:
1. For anatomy/neurons: vfb_search_terms with specific filters → vfb_get_term_info → run relevant queries
2. Handle pagination if _truncation.canRequestMore=true
3. When you encounter a VFB term ID in user messages, call vfb_get_term_info to get detailed information about it
4. When displaying multiple neurons or creating scene links, use the IDs directly from search results without calling vfb_get_term_info unless you need additional metadata
5. ALWAYS call vfb_get_term_info before using vfb_run_query to see what query types are available for that entity.
6. For connectivity queries: If a neuron class (IsClass: true) doesn't have connectivity data, look at individual neuron instances from connectomes.
7. Construct VFB URLs: https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?id=<id>&i=<template_id>,<image_ids>

FORMATTING VFB REFERENCES:
When referencing VFB entities, ALWAYS use markdown links with the descriptive name as link text, NOT bare IDs in parentheses.
- CORRECT: [ME on JRC2018Unisex adult brain](https://virtualflybrain.org/reports/VFB_00102107)
- WRONG: ME on JRC2018Unisex adult brain (VFB_00102107)
- WRONG: ME on JRC2018Unisex adult brain ([VFB_00102107](https://virtualflybrain.org/reports/VFB_00102107))
The user wants to see human-readable names as clickable links, not cryptic IDs. The same applies to FBbt anatomy terms — use the term name as the link text: [medulla](https://virtualflybrain.org/reports/FBbt_00003748), not FBbt_00003748.

DISPLAYING IMAGES:
When vfb_get_term_info returns data with thumbnail URLs, you MUST include them in your response using markdown image syntax.
Format each VFB entity as: thumbnail image followed by a descriptive link — do NOT repeat the name as plain text. Example:
- ![ME on JRC2018Unisex](https://www.virtualflybrain.org/data/VFB/i/0010/2107/thumbnail.png) [ME on JRC2018Unisex adult brain](https://virtualflybrain.org/reports/VFB_00102107)
NOT:
- ME on JRC2018Unisex adult brain ![ME](thumbnail_url) [ME on JRC2018Unisex adult brain](url)
The name should appear ONLY ONCE as the link text next to the thumbnail. Do not write it as plain text before the image.
ONLY use thumbnail URLs that are actually present in the vfb_get_term_info response data. NEVER invent or guess thumbnail URLs.
The user's chat interface renders these as compact thumbnails that expand on hover — they are a key visual feature, so always include them when available.

SUGGESTED FOLLOW-UP QUESTIONS:
At the end of your responses, when appropriate (not always necessary), suggest 2-4 follow-up questions the user might want to ask next. Include these as plain-text URLs in one of these formats:

**Format 1 - Plain-text URLs in text (recommended):**
You might also want to explore:
- What neurons have presynaptic terminals in the medulla? https://chat.virtualflybrain.org?query=What%20neurons%20have%20presynaptic%20terminals%20in%20the%20medulla%3F
- Show me neuron morphologies https://chat.virtualflybrain.org?query=Show%20me%20neuron%20morphologies

**Format 2 - Markdown links (also works):**
[What is the lobula](https://chat.virtualflybrain.org?query=What%20is%20the%20lobula) or [Show me MB connectivity](https://chat.virtualflybrain.org?query=Show%20me%20mushroom%20body%20connectivity)

**Format 3 - Inline in sentences:**
If you want to explore further, you could ask about [layer-specific connectivity](https://chat.virtualflybrain.org?query=What%20is%20the%20layer-specific%20connectivity%20in%20the%20medulla) or [transgenic lines](https://chat.virtualflybrain.org?query=Which%20transgenic%20lines%20label%20medulla%20neurons).

**Important guidelines:**
- The question text in the URL MUST be properly URL-encoded (spaces as %20, ? as %3F, etc.)
- Keep questions concise and specific to the topic at hand
- Follow-up questions MUST be directly relevant to Drosophila neuroscience AND actionable using VFB tools. Only suggest questions that VFB tools can actually answer. Good examples: "What neurons have presynaptic terminals in the medulla?" (uses vfb_search_terms with neuron filters), "What are the subregions of the mushroom body?" (uses vfb_get_term_info), "Which GAL4 lines label Kenyon cells?" (searches for transgene expression patterns), "What connectivity data is available for this neuron?" (uses vfb_run_query with connectivity queries), "Find recent neuroscience preprints about Drosophila connectomics" (uses biorxiv/pubmed tools). Bad examples: "Show me morphologies" (too vague — NBLAST requires a specific neuron ID to compare against), generic biology questions, questions that VFB tools cannot answer.
- Only suggest when relevant — skip if the response already answers likely follow-ups
- Vary the question types: ask about connectivity, neuron types in a region, gene/transgene expression, substructures, available datasets, or related publications
- The user's chat interface automatically converts both plain URLs and markdown links to clickable buttons that submit the question
- Don't overuse: 2-3 well-chosen questions are better than 5 generic ones
- Do NOT include any instructional text like "you can click or copy-paste these into the chat", "use these as plain-text URLs", or similar meta-commentary — just present the links directly with a brief natural intro like "You might also want to explore:" or "Related questions:".`

export async function POST(request) {
  const startTime = Date.now()
  const xForwardedFor = request.headers.get('x-forwarded-for') || ''
  const clientIp = (xForwardedFor.split(',')[0] || '').trim() || request.headers.get('x-real-ip') || 'unknown'

  const rateCheck = checkAndIncrement(clientIp)
  if (!rateCheck.allowed) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        try {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: `Daily rate limit exceeded (${rateCheck.limit} requests per day). Please try again tomorrow.`, used: rateCheck.used, limit: rateCheck.limit })}\n\n`))
        } catch (e) { /* ignore */ }
        controller.close()
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

  const { messages, scene } = await request.json()

  const message = messages[messages.length - 1].content

  log('Chat API request received', {
    message: message.substring(0, 100),
    scene,
    clientIp,
    xForwardedFor
  })

  // Check for jailbreak attempts
  if (detectJailbreakAttempt(message)) {
    log('Jailbreak attempt detected', { message: message.substring(0, 200) })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const sendEvent = (event, data) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch (e) { /* Controller closed */ }
        }

        sendEvent('error', {
          message: 'I cannot assist with attempts to bypass safety restrictions or override my core instructions. Please ask questions related to Drosophila neuroscience and Virtual Fly Brain data.'
        })
        controller.close()
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  if (!process.env.OPENAI_API_KEY) {
    log('WARNING: OPENAI_API_KEY not set - API calls may fail')
  }

  // Load static lookup cache for user input term resolution
  loadLookupCache()

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch (e) { /* Controller closed */ }
      }

      try {
        // Resolve VFB terms in user input using static lookup cache
        const resolvedUserMessage = replaceTermsWithLinks(message)

        // Build conversation input for the Responses API
        const conversationInput = [
          ...messages.slice(0, -1).map(msg => ({ role: msg.role, content: msg.content })),
          { role: 'user', content: resolvedUserMessage }
        ]

        const apiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
        const apiKey = process.env.OPENAI_API_KEY
        const apiModel = getOpenAIModel()

        log('Calling Responses API', {
          messageCount: conversationInput.length,
          model: apiModel
        })

        sendEvent('status', { message: 'Thinking...', phase: 'llm' })

        const timeoutMs = 180000
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

        const apiStart = Date.now()

        const apiResponse = await fetch(`${apiBaseUrl}/responses`, {
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

        const apiDuration = Date.now() - apiStart
        log('Responses API initial response', { duration: `${apiDuration}ms`, status: apiResponse.status })

        if (!apiResponse.ok) {
          const errorText = await apiResponse.text()
          log('Responses API error', { status: apiResponse.status, error: errorText.substring(0, 500) })

          // Retry on transient errors
          if (isTransientError(apiResponse.status)) {
            const maxRetries = 2
            for (let retry = 1; retry <= maxRetries; retry++) {
              const backoffMs = retry * 3000
              log(`Retrying Responses API (attempt ${retry}/${maxRetries}) after ${backoffMs}ms`, { status: apiResponse.status })
              sendEvent('status', { message: `AI service temporarily unavailable — retrying (${retry}/${maxRetries})…` })
              await new Promise(resolve => setTimeout(resolve, backoffMs))

              try {
                const retryAbort = new AbortController()
                const retryTimeout = setTimeout(() => retryAbort.abort(), timeoutMs)

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
                clearTimeout(retryTimeout)

                if (retryResponse.ok) {
                  log('Responses API retry succeeded', { attempt: retry })
                  await processResponseStream(retryResponse, sendEvent, message, scene, startTime, conversationInput)
                  controller.close()
                  return
                } else {
                  const retryErrorText = await retryResponse.text()
                  log('Responses API retry failed', { attempt: retry, status: retryResponse.status, error: retryErrorText.substring(0, 300) })
                }
              } catch (retryErr) {
                log('Responses API retry exception', { attempt: retry, error: retryErr.message })
              }
            }

            const friendlyMsg = sanitizeApiError(apiResponse.status, errorText)
            sendEvent('error', { message: `Sorry, the AI service is temporarily unavailable. ${friendlyMsg}` })
            controller.close()
            return
          }

          const friendlyMsg = sanitizeApiError(apiResponse.status, errorText)
          sendEvent('error', { message: `Error: ${friendlyMsg}` })
          controller.close()
          return
        }

        // Process the streaming response
        await processResponseStream(apiResponse, sendEvent, message, scene, startTime, conversationInput)
        controller.close()

      } catch (error) {
        const totalDuration = Date.now() - startTime
        log('Chat API request failed', { totalDuration: `${totalDuration}ms`, error: error.message })

        console.error('Chat API error:', error)
        let userMessage = 'Sorry, something went wrong processing your request. Please try again.'
        if (error.name === 'AbortError' || error.message?.includes('abort')) {
          userMessage = 'The request timed out. The AI service may be under heavy load — please try again in a moment.'
        } else if (error.message?.includes('fetch') || error.message?.includes('ECONNREFUSED')) {
          userMessage = 'Unable to reach the AI service. Please check your connection and try again.'
        }
        sendEvent('error', { message: userMessage })
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

// Read and parse an SSE stream from the Responses API.
// Returns { textAccumulator, functionCalls, responseId, failed }.
async function readResponseStream(apiResponse, sendEvent) {
  const reader = apiResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let textAccumulator = ''
  let sentVfbStatus = false
  let sentBiorxivStatus = false
  let sentPubmedStatus = false
  const functionCalls = []
  let responseId = null
  let failed = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        if (line.startsWith('event: ')) continue

        if (!line.startsWith('data: ')) continue
        const dataStr = line.substring(6).trim()
        if (dataStr === '[DONE]') continue

        try {
          const event = JSON.parse(dataStr)
          const eventType = event.type

          switch (eventType) {
            case 'response.created':
              responseId = event.response?.id || null
              log('Response stream started', { responseId })
              break

            case 'response.output_item.added':
              if (event.item?.type === 'function_call') {
                const toolName = event.item?.name || ''
                if (toolName.startsWith('vfb_') && !sentVfbStatus) {
                  sendEvent('status', { message: 'Querying the fly hive mind', phase: 'mcp' })
                  sentVfbStatus = true
                } else if (toolName.startsWith('biorxiv_') && !sentBiorxivStatus) {
                  sendEvent('status', { message: 'Searching bioRxiv preprints', phase: 'biorxiv' })
                  sentBiorxivStatus = true
                } else if ((toolName === 'search_pubmed' || toolName === 'get_pubmed_article') && !sentPubmedStatus) {
                  sendEvent('status', { message: 'Searching publications', phase: 'pubmed' })
                  sentPubmedStatus = true
                }
                log('Function call initiated', { name: toolName })
              } else if (event.item?.type === 'web_search_call') {
                sendEvent('status', { message: 'Searching VFB website', phase: 'web_search' })
                log('Web search initiated')
              } else if (event.item?.type === 'message') {
                sendEvent('status', { message: 'Processing results', phase: 'llm' })
              }
              break

            case 'response.output_text.delta':
              if (event.delta) {
                textAccumulator += event.delta
              }
              break

            case 'response.content_part.done':
              break

            case 'response.output_item.done':
              if (event.item?.type === 'function_call') {
                functionCalls.push({
                  call_id: event.item.call_id,
                  name: event.item.name,
                  arguments: event.item.arguments
                })
                log('Function call collected', { name: event.item.name, call_id: event.item.call_id })
              } else if (event.item?.type === 'reasoning') {
                const reasoningText = event.item?.summary?.map(s => s.text).join('\n') || ''
                if (reasoningText) {
                  sendEvent('reasoning', { text: reasoningText })
                }
              }
              break

            case 'response.completed':
              responseId = event.response?.id || responseId
              log('Response stream completed', { responseId })
              break

            case 'response.failed':
              const errorMsg = event.response?.status_details?.error?.message || 'Unknown error'
              log('Response failed', { error: errorMsg })
              sendEvent('error', { message: `Error: ${errorMsg}` })
              failed = true
              return { textAccumulator, functionCalls, responseId, failed }

            case 'error':
              log('Stream error event', { error: event.message || event })
              sendEvent('error', { message: event.message || 'An error occurred' })
              failed = true
              return { textAccumulator, functionCalls, responseId, failed }
          }
        } catch (parseError) {
          log('Failed to parse SSE data', { error: parseError.message, data: dataStr.substring(0, 100) })
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { textAccumulator, functionCalls, responseId, failed }
}

// Process the Responses API stream, handling function tool calls via MCP relay.
// Uses inline conversation accumulation instead of previous_response_id
// (required for orgs with Zero Data Retention).
async function processResponseStream(apiResponse, sendEvent, message, scene, startTime, conversationInput) {
  const apiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const apiKey = process.env.OPENAI_API_KEY
  const apiModel = getOpenAIModel()
  const maxFunctionRounds = 5

  let currentResponse = apiResponse
  // Accumulate function call/output items to replay on subsequent rounds
  const accumulatedItems = []

  for (let round = 0; round <= maxFunctionRounds; round++) {
    const { textAccumulator, functionCalls, responseId, failed } = await readResponseStream(currentResponse, sendEvent)

    if (failed) return

    // If there are function calls, execute them and submit results
    if (functionCalls.length > 0) {
      log('Executing function tools via relay', { count: functionCalls.length, round })

      // Execute all function calls in parallel
      const toolOutputs = await Promise.all(functionCalls.map(async (fc) => {
        try {
          const args = typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : fc.arguments
          const result = await executeFunctionTool(fc.name, args)
          log('Function tool executed', { name: fc.name, resultLength: result?.length || 0 })
          return { call_id: fc.call_id, name: fc.name, arguments: fc.arguments, output: result }
        } catch (err) {
          log('Function tool failed', { name: fc.name, error: err.message })
          return { call_id: fc.call_id, name: fc.name, arguments: fc.arguments, output: JSON.stringify({ error: err.message }) }
        }
      }))

      // Accumulate the function_call items and their outputs for conversation replay
      for (const to of toolOutputs) {
        accumulatedItems.push({
          type: 'function_call',
          call_id: to.call_id,
          name: to.name,
          arguments: typeof to.arguments === 'string' ? to.arguments : JSON.stringify(to.arguments)
        })
        accumulatedItems.push({
          type: 'function_call_output',
          call_id: to.call_id,
          output: to.output
        })
      }

      // Resend the full conversation with accumulated tool interactions
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
        const errText = await submitResponse.text()
        log('Function tool result submission failed', { status: submitResponse.status, error: errText.substring(0, 300) })
        sendEvent('error', { message: 'Failed to process tool results. Please try again.' })
        return
      }

      currentResponse = submitResponse
      continue
    }

    // No function calls — we have the final text response
    const finalResponse = textAccumulator

    if (!finalResponse) {
      log('No text content in response')
      sendEvent('error', { message: 'The AI did not generate a response. Please try again.' })
      return
    }

    // Parse for VFB thumbnail images
    const thumbnailRegex = /https:\/\/www\.virtualflybrain\.org\/data\/VFB\/i\/([^/]+)\/([^/]+)\/thumbnail(?:T)?\.png/g
    const images = []
    let match
    while ((match = thumbnailRegex.exec(finalResponse)) !== null) {
      const templateId = match[1]
      const imageId = match[2]
      images.push({
        id: imageId,
        template: templateId,
        thumbnail: match[0],
        label: `VFB Image ${imageId}`
      })
    }

    const totalDuration = Date.now() - startTime
    log('Chat API request completed', {
      totalDuration: `${totalDuration}ms`,
      responseLength: finalResponse.length,
      imagesCount: images.length
    })

    trackQuery(message, finalResponse.length, totalDuration, `session_${Date.now()}`)

    sendEvent('result', { response: finalResponse, images, newScene: scene })
    return
  }

  log('Max function tool rounds exceeded')
  sendEvent('error', { message: 'The response required too many tool calls. Please try a simpler question.' })
}
