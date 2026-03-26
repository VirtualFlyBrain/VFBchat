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
import { getReviewedPage, searchReviewedDocs } from '../../../lib/reviewedDocsSearch.js'
import {
  getConfiguredApiBaseUrl,
  getConfiguredApiKey,
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

function summarizeToolUsage(toolUsage = {}) {
  const entries = Object.entries(toolUsage)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  if (entries.length === 0) return 'No tool results were gathered.'

  return entries
    .map(([toolName, count]) => `- ${toolName}: ${count}`)
    .join('\n')
}

function buildClarifyingQuestions(message = '') {
  const lowerMessage = message.toLowerCase()
  const questions = []

  if (/\bdataset\b/i.test(lowerMessage)) {
    questions.push('- Which single dataset should I focus on first?')
  }

  if (/\b(gabaergic|cholinergic|glutamatergic|transmitter|neurotransmitter)\b/i.test(lowerMessage)) {
    questions.push('- Do you want one transmitter class at a time, or a short mixed summary across all classes?')
  }

  if (/\b(gal4|driver|label)\b/i.test(lowerMessage)) {
    questions.push('- Do you want pan-labeling lines, subtype-specific lines, or just a short list of the best-known examples?')
  }

  if (/\b(connectome|connectivity|presynaptic|postsynaptic|synapse|synaptic)\b/i.test(lowerMessage)) {
    questions.push('- Should I focus on one connectivity question at a time, such as inputs, outputs, or one specific neuron class?')
  }

  if (/\b(medulla|lobula|lamina|mushroom body|antennal lobe|central complex)\b/i.test(lowerMessage)) {
    questions.push('- Should I keep this to one brain region and one question type first?')
  }

  questions.push('- Would you like a capped result, such as the first 5 or 10 matches, instead of an exhaustive list?')
  questions.push('- Would you prefer a short partial summary first, then we can drill into one branch together?')

  return Array.from(new Set(questions)).slice(0, 4)
}

function linkifyFollowUpQueryItems(text = '') {
  if (!text) return text

  const lines = text.split('\n')
  const linkedLines = lines.map((line) => {
    const listMatch = line.match(/^(\s*(?:[-*]|\d+\.)\s+)(.+)$/)
    if (!listMatch) return line

    const prefix = listMatch[1]
    const rawItem = listMatch[2].trim()

    // Skip lines that are already markdown links or contain explicit URLs.
    if (!rawItem || rawItem.includes('](') || /https?:\/\//i.test(rawItem)) {
      return line
    }

    const questionMatch = rawItem.match(/^(.+?\?)\s*$/)
    if (!questionMatch) return line

    const question = questionMatch[1].trim()
    if (question.length < 6 || question.length > 220) return line

    const queryUrl = `https://chat.virtualflybrain.org?query=${encodeURIComponent(question)}`
    return `${prefix}[${question}](${queryUrl})`
  })

  return linkedLines.join('\n')
}

function extractImagesFromResponseText(responseText = '') {
  const thumbnailRegex = /https:\/\/www\.virtualflybrain\.org\/data\/VFB\/i\/([^/]+)\/([^/]+)\/thumbnail(?:T)?\.png/g
  const images = []
  let match

  while ((match = thumbnailRegex.exec(responseText)) !== null) {
    images.push({
      id: match[2],
      template: match[1],
      thumbnail: match[0],
      label: `VFB Image ${match[2]}`
    })
  }

  return images
}

function buildSuccessfulTextResult({ responseText, responseId, toolUsage, toolRounds, outboundAllowList }) {
  const { sanitizedText, blockedDomains } = sanitizeAssistantOutput(responseText, outboundAllowList)
  const linkedResponseText = linkifyFollowUpQueryItems(sanitizedText)
  const images = extractImagesFromResponseText(linkedResponseText)

  return {
    ok: true,
    responseId,
    toolUsage,
    toolRounds,
    responseText: linkedResponseText,
    images,
    blockedResponseDomains: blockedDomains
  }
}

function buildToolRoundLimitMessage({ message, toolUsage, toolRounds, maxToolRounds }) {
  const questions = buildClarifyingQuestions(message)

  return `I found some relevant results, but answering this fully would require more than the current tool-step budget, so I stopped before the query turned into a long tool loop.

What happened:
- Tool rounds used: ${toolRounds} of ${maxToolRounds}
- Tools used so far:
${summarizeToolUsage(toolUsage)}

To help me continue in a focused way, please tell me:
${questions.join('\n')}`
}

function looksLikeEmptyResult(text = '') {
  return /\b(no results|did not find|didn't find|could not find|couldn't find|no matching|no reviewed page|no reviewed pages)\b/i.test(text)
}

function classifyTopicCategory(message = '', toolUsage = {}) {
  const lowerMessage = message.toLowerCase()

  if (toolUsage.search_reviewed_docs || toolUsage.get_reviewed_page || /\b(documentation|docs?|how do i|how to|website|site|page|blog|news|conference|event|workshop)\b/i.test(lowerMessage)) {
    return 'how-to'
  }

  if (/\b(paper|papers|publication|publications|preprint|preprints|pubmed|doi|research)\b/i.test(lowerMessage)) {
    return 'publications'
  }

  if (/\b(gene|expression|transgene|gal4|driver|reporter)\b/i.test(lowerMessage)) {
    return 'gene expression'
  }

  if (toolUsage.vfb_run_query || /\b(connectivity|connectome|synapse|synaptic|nblast|projection|presynaptic|postsynaptic)\b/i.test(lowerMessage)) {
    return 'connectivity'
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
    { name: 'vfb-chat-client', version: '3.2.3' },
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
    { name: 'vfb-chat-biorxiv', version: '3.2.3' },
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
    description: 'Search approved Virtual Fly Brain, NeuroFly, VFB Connect documentation, and reviewed FlyBase pages using a server-side site index. Use this for documentation, news or blog posts, conference or event questions, and approved Python usage guidance pages.',
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
    name: 'get_reviewed_page',
    description: 'Fetch and extract content from an approved Virtual Fly Brain, NeuroFly, VFB Connect documentation, or reviewed FlyBase page URL returned by search_reviewed_docs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Approved page URL to fetch and extract' }
      },
      required: ['url']
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

  if (name === 'get_reviewed_page') {
    return getReviewedPage(args.url)
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

const VFB_QUERY_LINK_BASE = 'https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q='

const VFB_QUERY_SHORT_NAMES = [
  { name: 'ListAllAvailableImages', description: 'List all available images of $NAME' },
  { name: 'TransgeneExpressionHere', description: 'Reports of transgene expression in $NAME' },
  { name: 'ExpressionOverlapsHere', description: 'Anatomy $NAME is expressed in' },
  { name: 'NeuronClassesFasciculatingHere', description: 'Neurons fasciculating in $NAME' },
  { name: 'ImagesNeurons', description: 'Images of neurons with some part in $NAME' },
  { name: 'NeuronsPartHere', description: 'Neurons with some part in $NAME' },
  { name: 'epFrag', description: 'Images of fragments of $NAME' },
  { name: 'NeuronsSynaptic', description: 'Neurons with synaptic terminals in $NAME' },
  { name: 'NeuronsPresynapticHere', description: 'Neurons with presynaptic terminals in $NAME' },
  { name: 'NeuronsPostsynapticHere', description: 'Neurons with postsynaptic terminals in $NAME' },
  { name: 'PaintedDomains', description: 'List all painted anatomy available for $NAME' },
  { name: 'DatasetImages', description: 'List all images included in $NAME' },
  { name: 'TractsNervesInnervatingHere', description: 'Tracts/nerves innervating $NAME' },
  { name: 'ComponentsOf', description: 'Components of $NAME' },
  { name: 'LineageClonesIn', description: 'Lineage clones found in $NAME' },
  { name: 'AllAlignedImages', description: 'List all images aligned to $NAME' },
  { name: 'PartsOf', description: 'Parts of $NAME' },
  { name: 'SubclassesOf', description: 'Subclasses of $NAME' },
  { name: 'AlignedDatasets', description: 'List all datasets aligned to $NAME' },
  { name: 'AllDatasets', description: 'List all datasets' },
  { name: 'ref_neuron_region_connectivity_query', description: 'Show connectivity per region for $NAME' },
  { name: 'ref_neuron_neuron_connectivity_query', description: 'Show neurons connected to $NAME' },
  { name: 'ref_downstream_class_connectivity_query', description: 'Show downstream connectivity by class for $NAME' },
  { name: 'ref_upstream_class_connectivity_query', description: 'Show upstream connectivity by class for $NAME' },
  { name: 'SimilarMorphologyTo', description: 'Neurons with similar morphology to $NAME [NBLAST mean score]' },
  { name: 'SimilarMorphologyToPartOf', description: 'Expression patterns with some similar morphology to $NAME [NBLAST mean score]' },
  { name: 'TermsForPub', description: 'List all terms that reference $NAME' },
  { name: 'SimilarMorphologyToPartOfexp', description: 'Neurons with similar morphology to part of $NAME [NBLAST mean score]' },
  { name: 'SimilarMorphologyToNB', description: 'Neurons that overlap with $NAME [NeuronBridge]' },
  { name: 'SimilarMorphologyToNBexp', description: 'Expression patterns that overlap with $NAME [NeuronBridge]' },
  { name: 'anatScRNAseqQuery', description: 'Single cell transcriptomics data for $NAME' },
  { name: 'clusterExpression', description: 'Genes expressed in $NAME' },
  { name: 'scRNAdatasetData', description: 'List all Clusters for $NAME' },
  { name: 'expressionCluster', description: 'scRNAseq clusters expressing $NAME' },
  { name: 'SimilarMorphologyToUserData', description: 'Neurons with similar morphology to your upload $NAME [NBLAST mean score]' },
  { name: 'ImagesThatDevelopFrom', description: 'List images of neurons that develop from $NAME' }
]

function buildVfbQueryLinkSkill() {
  const queryLines = VFB_QUERY_SHORT_NAMES
    .map(({ name, description }) => `- ${name}: ${description}`)
    .join('\n')

  return `VFB QUERY LINK SKILL:
- Build direct VFB query-result links so users can open the full results list.
- Link format: ${VFB_QUERY_LINK_BASE}<TERM_ID>,<QUERY_SHORT_NAME>
- Construct links from the exact pair: term_id + query_name.
- URL-encode TERM_ID and QUERY_SHORT_NAME independently before concatenating.
- Only use query names returned by vfb_get_term_info for that specific term.
- In term-info JSON, read short names from Queries[].query and user-facing descriptions from Queries[].label.
- Treat Queries[] from vfb_get_term_info as authoritative for the current term; use the static list below as a fallback reference.
- When you answer with query findings, include matching query-result links when useful.
- Examples:
  - ${VFB_QUERY_LINK_BASE}FBbt_00100482,ListAllAvailableImages
  - ${VFB_QUERY_LINK_BASE}FBbt_00100482,SubclassesOf
  - ${VFB_QUERY_LINK_BASE}FBbt_00100482,ref_upstream_class_connectivity_query
- Query short names and descriptions (from geppetto-vfb/model):
${queryLines}`
}

const VFB_QUERY_LINK_SKILL = buildVfbQueryLinkSkill()

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
- neurofly.org and subdomains
- vfb-connect.readthedocs.io
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
- search_reviewed_docs: search approved VFB, NeuroFly, VFB Connect docs, and reviewed FlyBase pages using a server-side site index
- get_reviewed_page: fetch and extract content from an approved page returned by search_reviewed_docs
- search_pubmed / get_pubmed_article: search and fetch peer-reviewed publications
- biorxiv_search_preprints / biorxiv_get_preprint / biorxiv_search_published_preprints / biorxiv_get_categories: preprint discovery

${VFB_QUERY_LINK_SKILL}

TOOL SELECTION:
- Questions about VFB terms, anatomy, neurons, genes, or datasets: use VFB tools
- Questions about published papers or recent literature: use PubMed first, optionally bioRxiv/medRxiv for preprints
- Questions about VFB, NeuroFly, VFB Connect Python documentation, or approved FlyBase documentation pages, news posts, workshops, conference pages, or event dates: use search_reviewed_docs, then use get_reviewed_page when you need page details
- For questions about how to run VFB queries in Python or how to use vfb-connect, prioritize search_reviewed_docs/get_reviewed_page on vfb-connect.readthedocs.io alongside VFB tool outputs when useful.
- For connectivity, synaptic, or NBLAST questions, and especially when the user explicitly asks for vfb_run_query, do not use reviewed-doc search first; use VFB tools (vfb_search_terms/vfb_get_term_info/vfb_run_query).
- Do not attempt general web search or browsing outside the approved reviewed-doc index

TOOL ECONOMY:
- Prefer the fewest tool steps needed to produce a useful answer.
- Do not keep calling tools just to exhaustively enumerate large result sets.
- If the question is broad or combinatorial, stop once you have enough evidence to give a partial answer.
- For broad gene-expression or transgene-pattern requests, prefer a short representative list (about 3-5 items) and ask how the user wants to narrow further instead of trying to enumerate everything in one turn.
- If the question is broad or underspecified, it is good to ask 1-3 short clarifying questions instead of trying to enumerate everything immediately.
- When stopping early, clearly summarize what you found so far and end with 2-4 direct clarifying questions the user can answer to narrow the query (for example: one dataset, one transmitter class, one neuron subtype, one brain region, or a capped number of results).

CITATIONS:
- Only cite publications returned by VFB, PubMed, or bioRxiv/medRxiv tools
- Use markdown links with human-readable titles, not bare URLs or raw IDs when a title is available
- For FlyBase references, prefer author/year or paper title as the link text

FORMATTING VFB REFERENCES:
- Use markdown links with descriptive names, not bare VFB or FBbt IDs
- When thumbnail URLs are present in tool output, include them using markdown image syntax
- Only use thumbnail URLs that actually appear in tool results

TOOL RELAY:
- You can request server-side tool execution using the tool relay protocol.
- If tool results are available, use them directly and do not invent missing values.
- If a question needs data and no results are available yet, request tools first, then answer after results arrive.

FOLLOW-UP QUESTIONS:
When useful, suggest 2-3 short follow-up questions relevant to Drosophila neuroscience and actionable in this chat.`

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

  if (toolName === 'get_reviewed_page') {
    return { message: 'Reading approved VFB page', phase: 'docs' }
  }

  return { message: 'Processing results', phase: 'llm' }
}

const CHAT_COMPLETIONS_ENDPOINT = '/chat/completions'
const CHAT_COMPLETION_ALLOWED_ROLES = new Set(['system', 'user', 'assistant'])
const TOOL_DEFINITIONS = getToolConfig()
const TOOL_NAME_SET = new Set(TOOL_DEFINITIONS.map(tool => tool.name))

function normalizeChatRole(role) {
  if (role === 'reasoning') return 'assistant'
  if (typeof role !== 'string') return 'assistant'
  return CHAT_COMPLETION_ALLOWED_ROLES.has(role) ? role : 'assistant'
}

function normalizeChatMessage(message) {
  if (!message || typeof message.content !== 'string') return null
  return {
    role: normalizeChatRole(message.role),
    content: message.content
  }
}

function buildToolRelaySystemPrompt() {
  const toolSchemas = TOOL_DEFINITIONS.map(tool => ({
    name: tool.name,
    required: tool.parameters?.required || [],
    parameters: Object.entries(tool.parameters?.properties || {}).reduce((acc, [key, value]) => {
      acc[key] = {
        type: value?.type || 'any',
        enum: Array.isArray(value?.enum) ? value.enum : undefined
      }
      return acc
    }, {})
  }))

  return `TOOL RELAY PROTOCOL:
- When you need tools, respond with JSON only, with no markdown and no extra text.
- Valid JSON format:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}
- "name" must be one of the available tool names.
- "arguments" must be a JSON object matching that tool schema.
- You may request multiple tool calls in one response.
- After server tool execution, you will receive a user message starting with "TOOL_RESULTS_JSON:".
- If more data is needed, emit another JSON tool call payload.
- When you are ready to answer the user, return a normal assistant response (not JSON).

AVAILABLE TOOL SCHEMAS (JSON):
${JSON.stringify(toolSchemas)}`
}

const TOOL_RELAY_SYSTEM_PROMPT = buildToolRelaySystemPrompt()

function extractJsonCandidates(text = '') {
  const trimmed = text.trim()
  if (!trimmed) return []

  const candidates = [trimmed]
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi
  let match

  while ((match = fenceRegex.exec(trimmed)) !== null) {
    const candidate = match[1]?.trim()
    if (candidate) candidates.push(candidate)
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1).trim())
  }

  return Array.from(new Set(candidates))
}

function normalizeRelayedToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null

  const name = typeof toolCall.name === 'string' ? toolCall.name.trim() : ''
  if (!name || !TOOL_NAME_SET.has(name)) return null

  let args = toolCall.arguments
  if (args === undefined || args === null) args = {}

  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return { name, arguments: {} }
    }
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    args = {}
  }

  return { name, arguments: args }
}

function parseRelayedToolCalls(responseText = '') {
  const candidates = extractJsonCandidates(responseText)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const rawCalls = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.tool_calls)
          ? parsed.tool_calls
          : parsed?.tool_call
            ? [parsed.tool_call]
            : []

      const normalizedCalls = rawCalls
        .map(normalizeRelayedToolCall)
        .filter(Boolean)

      if (normalizedCalls.length > 0) {
        return normalizedCalls
      }
    } catch {
      // Keep checking other JSON candidates.
    }
  }

  return []
}

function truncateToolOutput(output = '', maxChars = 12000) {
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`
}

function buildRelayedToolResultsMessage(toolOutputs = []) {
  const payload = toolOutputs.map(item => ({
    name: item.name,
    arguments: item.arguments,
    output: truncateToolOutput(item.output)
  }))

  return `TOOL_RESULTS_JSON:
${JSON.stringify(payload)}

Use these results to continue. If more tools are needed, send another JSON tool call payload. Otherwise, provide the final answer to the user.`
}

function hasExplicitVfbRunQueryRequest(message = '') {
  return /\bvfb_run_query\b/i.test(message)
}

function hasConnectivityIntent(message = '') {
  return /\b(connectome|connectivity|connection|connections|synapse|synaptic|presynaptic|postsynaptic|input|inputs|output|outputs|nblast)\b/i.test(message)
}

function isDocsOnlyToolCallSet(toolCalls = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false
  return toolCalls.every(call => call.name === 'search_reviewed_docs' || call.name === 'get_reviewed_page')
}

function buildToolPolicyCorrectionMessage({
  userMessage = '',
  explicitRunQueryRequested = false,
  connectivityIntent = false,
  missingRunQueryExecution = false
}) {
  const policyBullets = [
    '- For this request, prioritize VFB tools over reviewed-doc search.',
    '- Use vfb_search_terms and/or vfb_get_term_info to identify the target entity and valid query types.',
    '- Use vfb_run_query when a relevant query_type is available.'
  ]

  if (explicitRunQueryRequested) {
    policyBullets.push('- The user explicitly asked for vfb_run_query, so include a plan that leads to vfb_run_query.')
  }

  if (connectivityIntent) {
    policyBullets.push('- This is a connectivity-style request; do not default to search_reviewed_docs first.')
  }

  if (missingRunQueryExecution) {
    policyBullets.push('- You have not executed vfb_run_query yet in this turn; correct that now if feasible.')
  }

  return `TOOL_POLICY_CORRECTION:
The original user request was:
"${userMessage}"

${policyBullets.join('\n')}

Return JSON only using the tool relay format:
{"tool_calls":[{"name":"tool_name","arguments":{}}}

Do not provide a final prose answer until tool calls are executed.`
}

function buildChatCompletionMessages(conversationInput = [], extraMessages = [], allowToolRelay = false) {
  const normalizedConversation = conversationInput
    .map(normalizeChatMessage)
    .filter(Boolean)

  const normalizedExtras = extraMessages
    .map(normalizeChatMessage)
    .filter(Boolean)

  return [
    { role: 'system', content: systemPrompt },
    ...(allowToolRelay ? [{ role: 'system', content: TOOL_RELAY_SYSTEM_PROMPT }] : []),
    ...normalizedConversation,
    ...normalizedExtras
  ]
}

function createChatCompletionsRequestBody({
  apiModel,
  conversationInput,
  extraMessages = [],
  allowToolRelay = false
}) {
  return {
    model: apiModel,
    messages: buildChatCompletionMessages(conversationInput, extraMessages, allowToolRelay),
    stream: true
  }
}

async function readResponseStream(apiResponse, sendEvent) {
  if (!apiResponse?.body) {
    return {
      textAccumulator: '',
      functionCalls: [],
      responseId: null,
      failed: true,
      errorMessage: 'The AI service returned an empty stream response.'
    }
  }

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
        if (!dataStr) continue
        if (dataStr === '[DONE]') continue

        try {
          const event = JSON.parse(dataStr)

          if (event?.error?.message) {
            failed = true
            errorMessage = event.error.message
            return { textAccumulator, functionCalls, responseId, failed, errorMessage }
          }

          // OpenAI-compatible /chat/completions streaming chunks:
          // { id, choices: [{ delta: { content } }] }
          if (Array.isArray(event?.choices)) {
            responseId = event.id || responseId

            const firstChoice = event.choices[0]
            const deltaContent = firstChoice?.delta?.content
            const messageContent = firstChoice?.message?.content

            if (typeof deltaContent === 'string' && deltaContent.length > 0) {
              textAccumulator += deltaContent
            } else if (typeof messageContent === 'string' && messageContent.length > 0) {
              textAccumulator += messageContent
            }

            continue
          }

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

async function requestNoToolFallbackResponse({
  sendEvent,
  conversationInput,
  accumulatedItems,
  partialAssistantText = '',
  apiBaseUrl,
  apiKey,
  apiModel,
  outboundAllowList,
  toolUsage,
  toolRounds,
  statusMessage,
  instruction
}) {
  sendEvent('status', { message: statusMessage, phase: 'llm' })

  const fallbackInput = [
    ...conversationInput,
    ...accumulatedItems
  ]

  if (partialAssistantText.trim()) {
    fallbackInput.push({ role: 'assistant', content: partialAssistantText.trim() })
  }

  const fallbackExtraMessages = [{ role: 'user', content: instruction }]

  const fallbackResponse = await fetch(`${apiBaseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(createChatCompletionsRequestBody({
      apiModel,
      conversationInput: fallbackInput,
      extraMessages: fallbackExtraMessages,
      allowToolRelay: false
    }))
  })

  if (!fallbackResponse.ok) {
    return null
  }

  const { textAccumulator, responseId, failed } = await readResponseStream(fallbackResponse, sendEvent)
  if (failed || !textAccumulator) {
    return null
  }

  return buildSuccessfulTextResult({
    responseText: textAccumulator,
    responseId,
    toolUsage,
    toolRounds,
    outboundAllowList
  })
}

async function requestToolLimitSummary({
  sendEvent,
  conversationInput,
  accumulatedItems,
  apiBaseUrl,
  apiKey,
  apiModel,
  outboundAllowList,
  toolUsage,
  toolRounds,
  maxToolRounds,
  userMessage
}) {
  if (accumulatedItems.length === 0) return null

  const summaryInstruction = `The original user request was:
"${userMessage}"

The request hit the tool-round limit after ${toolRounds} rounds (current budget: ${maxToolRounds}).

Using only the gathered tool outputs already provided in this conversation:
- give the best partial answer you can
- clearly say that the answer is partial because the request branched into too many tool steps
- summarize the strongest findings you already have
- end with 2-4 direct clarification questions the user can answer so you can continue in a narrower, lower-tool way

Do not call tools. Do not ask to browse the web.`

  return requestNoToolFallbackResponse({
    sendEvent,
    conversationInput,
    accumulatedItems,
    apiBaseUrl,
    apiKey,
    apiModel,
    outboundAllowList,
    toolUsage,
    toolRounds,
    statusMessage: 'Summarizing partial results',
    instruction: summaryInstruction
  })
}

async function requestClarifyingFollowUp({
  sendEvent,
  conversationInput,
  accumulatedItems,
  partialAssistantText = '',
  apiBaseUrl,
  apiKey,
  apiModel,
  outboundAllowList,
  toolUsage,
  toolRounds,
  userMessage,
  reason
}) {
  const clarificationInstruction = `The original user request was:
"${userMessage}"

The previous attempt did not produce a stable final answer.
Reason: ${reason}.

Using only the existing conversation and any tool outputs already provided:
- give a brief summary of what direction is available so far
- do not invent missing facts
- ask 2-4 short clarifying questions the user can answer so the next turn can be narrower and easier to resolve

Do not call tools. Do not ask to browse the web.`

  return requestNoToolFallbackResponse({
    sendEvent,
    conversationInput,
    accumulatedItems,
    partialAssistantText,
    apiBaseUrl,
    apiKey,
    apiModel,
    outboundAllowList,
    toolUsage,
    toolRounds,
    statusMessage: 'Clarifying next step',
    instruction: clarificationInstruction
  })
}

async function requestStreamFailureRecovery({
  sendEvent,
  conversationInput,
  accumulatedItems,
  partialAssistantText = '',
  apiBaseUrl,
  apiKey,
  apiModel,
  outboundAllowList,
  toolUsage,
  toolRounds,
  userMessage,
  reason
}) {
  if (accumulatedItems.length === 0 && !partialAssistantText.trim()) return null

  const recoveryInstruction = `The original user request was:
"${userMessage}"

The previous attempt ended unexpectedly before a stable final answer was produced.
Reason: ${reason}.

Using only the existing conversation, any tool outputs already provided, and any partial answer text already shown above:
- give the best partial answer you can
- if the evidence is still too incomplete, say that briefly and ask 2-4 short clarifying questions
- prefer a short concrete answer over more questions if the available evidence already supports one
- do not invent missing facts

Do not call tools. Do not ask to browse the web.`

  return requestNoToolFallbackResponse({
    sendEvent,
    conversationInput,
    accumulatedItems,
    partialAssistantText,
    apiBaseUrl,
    apiKey,
    apiModel,
    outboundAllowList,
    toolUsage,
    toolRounds,
    statusMessage: 'Recovering partial answer',
    instruction: recoveryInstruction
  })
}

async function processResponseStream({
  apiResponse,
  sendEvent,
  conversationInput,
  apiBaseUrl,
  apiKey,
  apiModel,
  userMessage
}) {
  const outboundAllowList = getOutboundAllowList()
  const toolUsage = {}
  const accumulatedItems = []
  const maxToolRounds = 10
  const maxToolPolicyCorrections = 3
  const explicitRunQueryRequested = hasExplicitVfbRunQueryRequest(userMessage)
  const connectivityIntent = hasConnectivityIntent(userMessage)
  let currentResponse = apiResponse
  let latestResponseId = null
  let toolRounds = 0
  let toolPolicyCorrections = 0

  for (let round = 0; round < maxToolRounds; round++) {
    const { textAccumulator, functionCalls, responseId, failed, errorMessage } = await readResponseStream(currentResponse, sendEvent)
    if (responseId) latestResponseId = responseId

    if (failed) {
      const recovery = await requestStreamFailureRecovery({
        sendEvent,
        conversationInput,
        accumulatedItems,
        partialAssistantText: textAccumulator,
        apiBaseUrl,
        apiKey,
        apiModel,
        outboundAllowList,
        toolUsage,
        toolRounds,
        userMessage,
        reason: errorMessage || 'The AI service returned an unexpected stream error.'
      })

      if (recovery) {
        return recovery
      }

      return {
        ok: false,
        responseId: latestResponseId,
        toolUsage,
        toolRounds,
        errorMessage: errorMessage || 'The AI service failed to complete the request.',
        errorCategory: 'upstream_stream_error'
      }
    }

    const relayedToolCalls = parseRelayedToolCalls(textAccumulator)
    const legacyFunctionCalls = functionCalls
      .map(functionCall => {
        let args = {}

        if (typeof functionCall?.arguments === 'string') {
          try {
            args = JSON.parse(functionCall.arguments)
          } catch {
            args = {}
          }
        } else if (functionCall?.arguments && typeof functionCall.arguments === 'object' && !Array.isArray(functionCall.arguments)) {
          args = functionCall.arguments
        }

        return normalizeRelayedToolCall({
          name: functionCall?.name,
          arguments: args
        })
      })
      .filter(Boolean)

    const requestedToolCalls = relayedToolCalls.length > 0
      ? relayedToolCalls
      : legacyFunctionCalls

    if (requestedToolCalls.length > 0) {
      const hasVfbToolCall = requestedToolCalls.some(toolCall => toolCall.name.startsWith('vfb_'))
      const docsOnlyToolCalls = isDocsOnlyToolCallSet(requestedToolCalls)
      const shouldCorrectToolChoice = toolPolicyCorrections < maxToolPolicyCorrections && (
        (explicitRunQueryRequested && !hasVfbToolCall) ||
        (connectivityIntent && docsOnlyToolCalls)
      )

      if (shouldCorrectToolChoice) {
        sendEvent('status', { message: 'Refining tool choice for VFB query', phase: 'llm' })

        if (textAccumulator.trim()) {
          accumulatedItems.push({ role: 'assistant', content: textAccumulator.trim() })
        }

        accumulatedItems.push({
          role: 'user',
          content: buildToolPolicyCorrectionMessage({
            userMessage,
            explicitRunQueryRequested,
            connectivityIntent
          })
        })

        const correctionResponse = await fetch(`${apiBaseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(createChatCompletionsRequestBody({
            apiModel,
            conversationInput: [...conversationInput, ...accumulatedItems],
            allowToolRelay: true
          }))
        })

        if (!correctionResponse.ok) {
          const correctionErrorText = await correctionResponse.text()
          return {
            ok: false,
            responseId: latestResponseId,
            toolUsage,
            toolRounds,
            errorMessage: `Failed to apply tool policy correction. ${sanitizeApiError(correctionResponse.status, correctionErrorText)}`,
            errorCategory: 'tool_policy_correction_failed',
            errorStatus: correctionResponse.status
          }
        }

        toolPolicyCorrections += 1
        currentResponse = correctionResponse
        continue
      }

      toolRounds += 1

      const announcedStatuses = new Set()
      for (const toolCall of requestedToolCalls) {
        if (!announcedStatuses.has(toolCall.name)) {
          sendEvent('status', getStatusForTool(toolCall.name))
          announcedStatuses.add(toolCall.name)
        }
      }

      const toolOutputs = await Promise.all(requestedToolCalls.map(async (toolCall) => {
        toolUsage[toolCall.name] = (toolUsage[toolCall.name] || 0) + 1

        try {
          return {
            name: toolCall.name,
            arguments: toolCall.arguments,
            output: await executeFunctionTool(toolCall.name, toolCall.arguments)
          }
        } catch (error) {
          return {
            name: toolCall.name,
            arguments: toolCall.arguments,
            output: JSON.stringify({ error: error.message })
          }
        }
      }))

      if (textAccumulator.trim()) {
        accumulatedItems.push({ role: 'assistant', content: textAccumulator.trim() })
      }

      accumulatedItems.push({
        role: 'user',
        content: buildRelayedToolResultsMessage(toolOutputs)
      })

      const submitResponse = await fetch(`${apiBaseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(createChatCompletionsRequestBody({
          apiModel,
          conversationInput: [...conversationInput, ...accumulatedItems],
          allowToolRelay: true
        }))
      })

      if (!submitResponse.ok) {
        const submitErrorText = await submitResponse.text()
        return {
          ok: false,
          responseId: latestResponseId,
          toolUsage,
          toolRounds,
          errorMessage: `Failed to process tool results. ${sanitizeApiError(submitResponse.status, submitErrorText)}`,
          errorCategory: 'tool_submission_failed',
          errorStatus: submitResponse.status
        }
      }

      currentResponse = submitResponse
      continue
    }

    if (explicitRunQueryRequested && (toolUsage.vfb_run_query || 0) === 0 && toolPolicyCorrections < maxToolPolicyCorrections) {
      sendEvent('status', { message: 'Honoring requested vfb_run_query workflow', phase: 'llm' })

      if (textAccumulator.trim()) {
        accumulatedItems.push({ role: 'assistant', content: textAccumulator.trim() })
      }

      accumulatedItems.push({
        role: 'user',
        content: buildToolPolicyCorrectionMessage({
          userMessage,
          explicitRunQueryRequested,
          connectivityIntent,
          missingRunQueryExecution: true
        })
      })

      const correctionResponse = await fetch(`${apiBaseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(createChatCompletionsRequestBody({
          apiModel,
          conversationInput: [...conversationInput, ...accumulatedItems],
          allowToolRelay: true
        }))
      })

      if (!correctionResponse.ok) {
        const correctionErrorText = await correctionResponse.text()
        return {
          ok: false,
          responseId: latestResponseId,
          toolUsage,
          toolRounds,
          errorMessage: `Failed to honor requested vfb_run_query flow. ${sanitizeApiError(correctionResponse.status, correctionErrorText)}`,
          errorCategory: 'vfb_run_query_enforcement_failed',
          errorStatus: correctionResponse.status
        }
      }

      toolPolicyCorrections += 1
      currentResponse = correctionResponse
      continue
    }

    if (!textAccumulator.trim()) {
      const clarification = await requestClarifyingFollowUp({
        sendEvent,
        conversationInput,
        accumulatedItems,
        partialAssistantText: textAccumulator,
        apiBaseUrl,
        apiKey,
        apiModel,
        outboundAllowList,
        toolUsage,
        toolRounds,
        userMessage,
        reason: 'empty_response'
      })

      if (clarification) {
        return clarification
      }

      return {
        ok: false,
        responseId: latestResponseId,
        toolUsage,
        toolRounds,
        errorMessage: 'The AI did not generate a response. Please try again.',
        errorCategory: 'empty_response'
      }
    }

    const trimmedResponseText = textAccumulator.trim()
    const looksLikeToolPayload = trimmedResponseText.startsWith('{') || trimmedResponseText.startsWith('```')

    if (looksLikeToolPayload && /"tool_calls"\s*:/.test(trimmedResponseText) && relayedToolCalls.length === 0) {
      const clarification = await requestClarifyingFollowUp({
        sendEvent,
        conversationInput,
        accumulatedItems,
        partialAssistantText: textAccumulator,
        apiBaseUrl,
        apiKey,
        apiModel,
        outboundAllowList,
        toolUsage,
        toolRounds,
        userMessage,
        reason: 'invalid_tool_call_payload'
      })

      if (clarification) {
        return clarification
      }

      return {
        ok: false,
        responseId: latestResponseId,
        toolUsage,
        toolRounds,
        errorMessage: 'The AI returned an invalid tool-call payload. Please try again.',
        errorCategory: 'invalid_tool_call_payload'
      }
    }

    return buildSuccessfulTextResult({
      responseText: textAccumulator,
      responseId: latestResponseId,
      toolUsage,
      toolRounds,
      outboundAllowList
    })
  }

  const partialSummary = await requestToolLimitSummary({
    sendEvent,
    conversationInput,
    accumulatedItems,
    apiBaseUrl,
    apiKey,
    apiModel,
    outboundAllowList,
    toolUsage,
    toolRounds,
    maxToolRounds,
    userMessage
  })

  if (partialSummary) {
    return partialSummary
  }

  return {
    ok: false,
    responseId: latestResponseId,
    toolUsage,
    toolRounds,
    errorMessage: buildToolRoundLimitMessage({
      message: userMessage,
      toolUsage,
      toolRounds,
      maxToolRounds
    }),
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
    const refusalMessage = `I can only search reviewed Virtual Fly Brain, NeuroFly, VFB Connect docs, and FlyBase pages. The requested domain${blockedRequestedDomains.length === 1 ? '' : 's'} ${blockedRequestedDomains.join(', ')} ${blockedRequestedDomains.length === 1 ? 'is' : 'are'} not approved for search in this service.`

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
    const priorMessages = messages
      .slice(0, -1)
      .map(normalizeChatMessage)
      .filter(Boolean)

    const conversationInput = [
      ...priorMessages,
      { role: 'user', content: resolvedUserMessage }
    ]

    const apiBaseUrl = getConfiguredApiBaseUrl()
    const apiKey = getConfiguredApiKey()
    const apiModel = getConfiguredModel()

    sendEvent('status', { message: 'Thinking...', phase: 'llm' })

    let apiResponse
    try {
      const timeoutMs = 180000
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

      apiResponse = await fetch(`${apiBaseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(createChatCompletionsRequestBody({
          apiModel,
          conversationInput,
          allowToolRelay: true
        })),
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
              const retryResponse = await fetch(`${apiBaseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify(createChatCompletionsRequestBody({
                  apiModel,
                  conversationInput,
                  allowToolRelay: true
                })),
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
        apiModel,
        userMessage: message
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
