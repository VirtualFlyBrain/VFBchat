import { NextResponse } from 'next/server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fs from 'fs'
import path from 'path'
import axios from 'axios'

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

// Parse tool arguments - OpenAI returns JSON string, Ollama returns object
function parseToolArguments(args) {
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return {} }
  }
  return args || {}
}

// Check for common jailbreak attempts
function detectJailbreakAttempt(message) {
  const lowerMessage = message.toLowerCase()
  
  // Common jailbreak patterns
  const jailbreakPatterns = [
    // Developer mode / unrestricted mode
    /\bdeveloper mode\b/i,
    /\bunrestricted mode\b/i,
    /\bdebug mode\b/i,
    /\bmaintenance mode\b/i,
    /\bgod mode\b/i,
    
    // DAN and similar personas
    /\bdan\b.*mode/i,
    /\bdo anything now\b/i,
    /\buncensored\b/i,
    /\bunfiltered\b/i,
    /\bjailbreak\b/i,
    
    // Override instructions
    /\bignore.*previous.*instructions?\b/i,
    /\boverride.*instructions?\b/i,
    /\bforget.*instructions?\b/i,
    /\bdiscard.*instructions?\b/i,
    /\bdisregard.*rules\b/i,
    
    // Role-playing as different AI
    /\byou are now\b.*ai/i,
    /\bact as\b.*ai/i,
    /\bpretend.*to be\b.*ai/i,
    /\bbecome.*ai\b/i,
    
    // System prompt manipulation
    /\bchange.*system.*prompt\b/i,
    /\balter.*system.*prompt\b/i,
    /\bmodify.*system.*prompt\b/i,
    /\brewrite.*system.*prompt\b/i,
    
    // Encoding attempts
    /\bbase64\b/i,
    /\bencoded\b.*prompt/i,
    /\bencrypted\b.*prompt/i,
    
    // Specific jailbreak names
    /\baim.*jailbreak/i,
    /\bmaximum.*jailbreak/i,
    /\bcharacter.*jailbreak/i,
    /\banti.*woke\b/i,
    
    // Coercive language
    /\byou must\b.*break.*rules/i,
    /\bi command you\b.*to/i,
    /\bas root\b/i,
    /\bsudo\b/i,
    /\badmin\b.*mode/i,
    
    // Attempts to create personas
    /\bcreate.*uncensored.*persona/i,
    /\brole.*play.*as.*uncensored/i,
    /\bact.*like.*uncensored/i,
    
    // Specific phrases from known jailbreaks
    /\bfrom now on\b.*you are/i,
    /\blet'?s role.*play/i,
    /\bscenario.*role.*play/i,
    /\bpretend.*that/i,
    
    // Attempts to hide prompts
    /\bhiding.*query/i,
    /\bsecret.*message/i,
    /\bencoded.*message/i
  ]
  
  // Check for patterns
  for (const pattern of jailbreakPatterns) {
    if (pattern.test(lowerMessage)) {
      return true
    }
  }
  
  // Check for repeated attempts to override
  const overrideCount = (lowerMessage.match(/\b(ignore|override|forget|discard|disregard)\b.*\b(instructions?|rules?|prompt)\b/gi) || []).length
  if (overrideCount > 1) {
    return true
  }
  
  // Check for suspicious repetition of keywords
  const suspiciousWords = ['ignore', 'override', 'forget', 'unrestricted', 'uncensored', 'jailbreak']
  let suspiciousCount = 0
  for (const word of suspiciousWords) {
    suspiciousCount += (lowerMessage.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length
  }
  if (suspiciousCount > 2) {
    return true
  }
  
  return false
}

// Validate if a thumbnail URL actually exists
async function validateThumbnailUrl(url) {
  try {
    const response = await axios.head(url, { 
      timeout: 2000, // 2 second timeout
      headers: {
        'User-Agent': 'VFBchat-Thumbnail-Validator/1.0'
      }
    })
    return response.status === 200
  } catch (error) {
    log('Thumbnail validation failed', { url, error: error.message })
    return false
  }
}

// Global lookup cache (persists across requests)
let lookupCache = null
let reverseLookupCache = null
let normalizedLookupCache = null
const CACHE_FILE = path.join(process.cwd(), 'vfb_lookup_cache.json')

// Load lookup cache from file or fetch from MCP
async function getLookupCache(mcpClient) {
  if (lookupCache) {
    return lookupCache
  }

  // Try to load from cache file first
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      lookupCache = cacheData.lookup
      reverseLookupCache = cacheData.reverseLookup
      normalizedLookupCache = cacheData.normalizedLookup
      log('Loaded lookup cache from file', { entries: Object.keys(lookupCache).length })
      return lookupCache
    }
  } catch (error) {
    log('Failed to load cache file', { error: error.message })
  }

  // Fetch comprehensive lookup data from VFB (following VFB_connect approach)
  try {
    log('Fetching comprehensive lookup data from VFB...')

    // Initialize empty caches
    lookupCache = {}
    reverseLookupCache = {}
    normalizedLookupCache = {}

    // Get comprehensive lookup from VFB database via MCP
    await loadVfbLookupTable(mcpClient)

    // If we got minimal data, seed with essential terms as fallback
    if (Object.keys(lookupCache).length < 100) {
      log('Limited lookup data received, adding essential seed terms')
      seedEssentialTerms()
    }

    // Save cache
    saveLookupCache()
    log('Initialized lookup cache', { entries: Object.keys(lookupCache).length })
    return lookupCache
  } catch (error) {
    log('Failed to fetch lookup data, using essential seed terms only', { error: error.message })

    // Fallback: initialize with essential terms only
    lookupCache = {}
    reverseLookupCache = {}
    normalizedLookupCache = {}
    seedEssentialTerms()
    saveLookupCache()
    return lookupCache
  }
}

// Load comprehensive lookup table from VFB (following VFB_connect approach)
async function loadVfbLookupTable(mcpClient) {
  try {
    // Use MCP to get a comprehensive lookup table from VFB
    // This simulates what VFB_connect does with Neo4jConnect.get_lookup()
    const toolResult = await mcpClient.callTool({
      name: 'mcp_virtual-fly-b_search_terms',
      arguments: {
        query: 'medulla OR protocerebrum OR mushroom OR central OR brain',  // Search for key anatomical terms
        rows: 1000  // Get substantial data
      }
    })

    if (toolResult?.content?.[0]?.text) {
      const parsedResult = JSON.parse(toolResult.content[0].text)

      if (parsedResult?.response?.docs) {
        let addedCount = 0
        for (const doc of parsedResult.response.docs) {
          if (doc.label && doc.short_form) {
            addToLookupCache(doc.label, doc.short_form)
            addedCount++

            // Also add synonyms if available
            if (doc.synonym && Array.isArray(doc.synonym)) {
              for (const syn of doc.synonym) {
                if (syn && typeof syn === 'string') {
                  addToLookupCache(syn, doc.short_form)
                  addedCount++
                }
              }
            }
          }
        }
        log('Loaded comprehensive lookup from VFB', { termsAdded: addedCount })
      }
    }
  } catch (error) {
    log('Failed to load comprehensive lookup, will use incremental approach', { error: error.message })
  }
}

// Seed with only essential, verified terms (much smaller set than before)
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
    addToLookupCache(term, id)
  })

  log('Seeded lookup cache with essential verified terms', { count: Object.keys(essentialTerms).length })
}

// Save lookup cache to file
function saveLookupCache() {
  try {
    const cacheData = {
      lookup: lookupCache || {},
      reverseLookup: reverseLookupCache || {},
      normalizedLookup: normalizedLookupCache || {},
      lastUpdated: new Date().toISOString()
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2))
  } catch (error) {
    log('Failed to save lookup cache', { error: error.message })
  }
}

// Add entries to lookup cache
function addToLookupCache(label, id) {
  if (!lookupCache) return

  lookupCache[label] = id
  reverseLookupCache[id] = label

  // Create normalized version for fuzzy matching
  const normalized = normalizeKey(label)
  if (!normalizedLookupCache[normalized]) {
    normalizedLookupCache[normalized] = id
  }

  // Save periodically (every 100 additions)
  if (Object.keys(lookupCache).length % 100 === 0) {
    saveLookupCache()
  }
}

// Normalize key for fuzzy matching (VFB_connect style with prefix substitutions)
function normalizeKey(key) {
  let normalized = key.toLowerCase()
    .replace(/_/g, '')
    .replace(/-/g, '')
    .replace(/\s+/g, '')
    .replace(/:/g, '')
    .replace(/;/g, '')

  // VFB_connect style prefix substitutions for developmental stages
  const prefixSubs = [
    ['adult', ''],
    ['larval', ''],
    ['pupal', ''],
    ['embryonic', ''],
    ['larva', ''],
    ['pupa', ''],
    ['embryo', '']
  ]

  // Apply prefix substitutions
  for (const [prefix, replacement] of prefixSubs) {
    if (normalized.startsWith(prefix)) {
      const withoutPrefix = normalized.substring(prefix.length)
      if (withoutPrefix.length > 2) { // Avoid too short terms
        normalized = withoutPrefix
        break // Only apply first matching prefix
      }
    }
  }

  return normalized
}

// Replace VFB terms in text with markdown links
function replaceTermsWithLinks(text) {
  if (!text || !lookupCache) return text

  // Sort terms by length (longest first) to avoid partial matches
  const sortedTerms = Object.keys(lookupCache)
    .filter(term => term.length > 2) // Skip very short terms
    .sort((a, b) => b.length - a.length)

  let result = text
  const allLinks = []

  // First, protect existing markdown links and images by replacing with placeholders
  result = result.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (match) => {
    allLinks.push(match)
    return `\x00LINK${allLinks.length - 1}\x00`
  })

  // Replace each term with markdown link (longest first)
  // After each replacement, protect the new link with a placeholder too
  for (const term of sortedTerms) {
    const id = lookupCache[term]
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi')
    result = result.replace(regex, (match) => {
      const link = `[${match}](${id})`
      allLinks.push(link)
      return `\x00LINK${allLinks.length - 1}\x00`
    })
  }

  // Restore all links (both existing and newly created) from placeholders
  result = result.replace(/\x00LINK(\d+)\x00/g, (_, idx) => allLinks[parseInt(idx)])

  return result
}

// Extract term IDs from a message containing markdown links like [term](id)
function extractTermIds(text) {
  const idSet = new Set()
  // Match markdown links and extract the URL part
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let match
  while ((match = linkRegex.exec(text)) !== null) {
    const id = match[2]
    // Only include VFB IDs (start with VFB or FBbt)
    if (id.startsWith('VFB') || id.startsWith('FBbt')) {
      idSet.add(id)
    }
  }
  return Array.from(idSet)
}

// Summarize term info to reduce prompt length
async function summarizeTermInfo(termInfoText) {
  try {
    const data = JSON.parse(termInfoText)
    
    // Extract key information based on actual VFB response structure
    const isClass = data.IsClass || false
    const hasImage = data.SuperTypes?.includes('has_image') || false
    
    // Extract publications from both Publications field and Synonyms field
    let publications = [...(data.Publications || [])]
    
    // Extract FBrf IDs from synonyms
    if (data.Synonyms && Array.isArray(data.Synonyms)) {
      data.Synonyms.forEach(synonym => {
        if (synonym.publication && typeof synonym.publication === 'string') {
          // Extract FBrf IDs from publication strings like "[Bates et al., 2020](FBrf0246460)"
          const fbrfMatch = synonym.publication.match(/FBrf\d+/g)
          if (fbrfMatch) {
            publications.push(...fbrfMatch)
          }
        }
      })
    }
    
    // Remove duplicates
    publications = [...new Set(publications)]
    
    const summary = {
      id: data.Id || data.id,
      name: data.Name || data.name,
      definition: data.Meta?.Description || data.description,
      type: data.Types || data.type,
      superTypes: data.SuperTypes?.slice(0, 3) || [],
      tags: data.Tags?.slice(0, 5) || [],
      isClass: isClass,
      hasImage: hasImage,
      // Use appropriate field based on entity type
      visualData: isClass ? (data.Examples || {}) : (hasImage ? (data.Images || {}) : {}),
      publications: publications
    }
    
    // Format as concise text
    let result = `${summary.id}: ${summary.name || 'Unknown'}`
    if (summary.definition) result += ` - ${summary.definition.substring(0, 300)}${summary.definition.length > 300 ? '...' : ''}`
    if (summary.superTypes.length > 0) result += ` (SuperTypes: ${summary.superTypes.join(', ')})`
    if (summary.tags.length > 0) result += ` (Tags: ${summary.tags.join(', ')})`
    
    // Include image information if available
    const visualEntries = Object.entries(summary.visualData || {})
    if (visualEntries.length > 0) {
      const totalImages = visualEntries.reduce((sum, [_, images]) => sum + (images?.length || 0), 0)
      const dataType = summary.isClass ? 'example' : 'aligned'
      result += ` (Has ${totalImages} ${dataType} image(s))`
      
      // Prioritize certain templates: JRC2018Unisex (VFB_00101567), then JFRC2 (VFB_00017894), then others
      const templatePriority = ['VFB_00101567', 'VFB_00017894', 'VFB_00030786', 'VFB_00101384']
      const sortedEntries = visualEntries.sort(([a], [b]) => {
        const aIndex = templatePriority.indexOf(a)
        const bIndex = templatePriority.indexOf(b)
        const aPriority = aIndex === -1 ? templatePriority.length : aIndex
        const bPriority = bIndex === -1 ? templatePriority.length : bIndex
        return aPriority - bPriority
      })
      
      // Include first available thumbnail URL as example (validate it exists)
      for (const [templateId, images] of sortedEntries) {
        if (images && Array.isArray(images) && images.length > 0 && images[0]?.thumbnail) {
          try {
            const isValid = await validateThumbnailUrl(images[0].thumbnail)
            if (isValid) {
              result += `\nThumbnail example: ${images[0].thumbnail}`
              break
            } else {
              log('Skipping invalid thumbnail URL', { url: images[0].thumbnail })
            }
          } catch (error) {
            log('Thumbnail validation error, skipping', { url: images[0].thumbnail, error: error.message })
          }
        }
      }
    }
    
    // Include publication information if available
    if (summary.publications.length > 0) {
      result += `\nPublications: ${summary.publications.slice(0, 3).join(', ')}${summary.publications.length > 3 ? '...' : ''}`
    }
  } catch (error) {
    // If parsing fails, return a truncated version of the original text
    return termInfoText.substring(0, 300) + (termInfoText.length > 300 ? '...' : '')
  }
}

// Initialize cache with common VFB terms
function seedLookupCache() {
  // This function is now deprecated - use seedEssentialTerms instead
  seedEssentialTerms()
}

// Local term resolution (fast lookup with VFB_connect style fuzzy matching)
function resolveTermLocally(term) {
  if (!lookupCache) return null

  // Exact match
  if (lookupCache[term]) {
    return lookupCache[term]
  }

  // Reverse lookup (if it's already an ID)
  if (reverseLookupCache[term]) {
    return term
  }

  // Normalized fuzzy match
  const normalized = normalizeKey(term)
  if (normalizedLookupCache[normalized]) {
    return normalizedLookupCache[normalized]
  }

  // Try with developmental prefixes removed (VFB_connect style)
  const prefixes = ['adult ', 'larval ', 'pupal ', 'embryonic ', 'larva ', 'pupa ', 'embryo ']
  for (const prefix of prefixes) {
    if (term.toLowerCase().startsWith(prefix)) {
      const withoutPrefix = term.substring(prefix.length).trim()
      if (lookupCache[withoutPrefix]) {
        return lookupCache[withoutPrefix]
      }
      const normalizedWithoutPrefix = normalizeKey(withoutPrefix)
      if (normalizedLookupCache[normalizedWithoutPrefix]) {
        return normalizedLookupCache[normalizedWithoutPrefix]
      }
    }
  }

  // Partial matches (longest first)
  const partialMatches = Object.keys(lookupCache)
    .filter(key => key.toLowerCase().includes(term.toLowerCase()))
    .sort((a, b) => b.length - a.length)

  if (partialMatches.length > 0) {
    return lookupCache[partialMatches[0]]
  }

  return null
}

export async function POST(request) {
  const startTime = Date.now()
  const { messages, scene } = await request.json()
  
  const message = messages[messages.length - 1].content // Last message is the current user input
  
  log('Chat API request received', { message: message.substring(0, 100), scene })

  // Check for jailbreak attempts
  if (detectJailbreakAttempt(message)) {
    log('Jailbreak attempt detected', { message: message.substring(0, 200) })
    
    // Return a streaming error response
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const sendEvent = (event, data) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch (e) {
            // Controller is closed, ignore
          }
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

  // Create a streaming response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch (e) {
          // Controller is closed, ignore to prevent errors
        }
      }

      try {
        // Initialize MCP client and transport
        let mcpTransport
        let mcpClient

        try {
          log('Initializing MCP client...')
          mcpTransport = new StreamableHTTPClientTransport(new URL('https://vfb3-mcp.virtualflybrain.org/'))
          mcpClient = new Client(
            { name: 'vfb-chat-client', version: '1.0.0' },
            { capabilities: {} }
          )

          log('Connecting to MCP server...')
          await mcpClient.connect(mcpTransport)
          log('MCP client connected successfully')

          // Initialize lookup cache for fast term resolution
          await getLookupCache(mcpClient)
        } catch (connectError) {
          log('MCP client connection failed', { error: connectError.message })
          // Continue without MCP - the LLM will handle it gracefully
        }
        const tools = [
          {
            type: 'function',
            function: {
              name: 'get_term_info',
              description: 'Get detailed information about a VFB term by ID, including definitions, relationships, images, and references',
              parameters: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'The VFB term ID (e.g., VFB_00102107, FBbt_00003748)'
                  }
                },
                required: ['id']
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'search_terms',
              description: 'Search for VFB terms by keywords, with optional filtering by entity type. Results are limited to 10 by default for performance - use pagination to get more.',
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query keywords'
                  },
                  filter_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional filter by entity types (e.g., ["neuron"], ["gene"], ["anatomy"], ["adult"], ["has_image"]) - use specific filters to limit results'
                  },
                  exclude_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional exclude types (e.g., ["deprecated"]) to remove unwanted results'
                  },
                  boost_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional boost types to prioritize results (e.g., ["has_image", "has_neuron_connectivity"])'
                  },
                  start: {
                    type: 'number',
                    description: 'Optional pagination start index (default 0) - use to get more results beyond the first 10'
                  },
                  rows: {
                    type: 'number',
                    description: 'Optional number of results to return (default 10, max 50) - use smaller numbers for focused searches'
                  }
                },
                required: ['query']
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'run_query',
              description: 'Execute specific queries like morphological similarity (NBLAST) analysis',
              parameters: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'The VFB term ID to query'
                  },
                  query_type: {
                    type: 'string',
                    description: 'Type of query to run (e.g., PaintedDomains, NBLAST)'
                  }
                },
                required: ['id', 'query_type']
              }
            }
          }
        ]

        // System prompt with comprehensive guardrailing based on VFB LLM guidance
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
Do NOT link to or reference any other websites. If a user asks you to visit, search, or retrieve content from websites outside this list, decline and explain you can only reference trusted Drosophila neuroscience resources.

ACCURACY:
- Always use VFB tools to look up information rather than relying on general knowledge. If tools return no results, say so rather than guessing.
- Clearly distinguish between data from VFB tools and your general scientific knowledge.
- When citing research, use FBrf reference IDs from VFB data where available.

CITATIONS:
- ONLY cite publications that are explicitly returned in VFB data Publications field
- Do NOT generate citations from general knowledge or invent DOIs
- If no publications are available in VFB data, do not include any citations
- For publications from VFB data, convert DOI or FBrf IDs to proper links:
  - DOI format: https://doi.org/XXXXXXX
  - FBrf format: https://flybase.org/reports/FBrfXXXXXXX
- Do not reference "common Drosophila neuroscience papers" unless they appear in the actual VFB data for the specific entity being discussed

TOOLS:
- search_terms(query, filter_types, exclude_types, boost_types, start, rows): Search VFB terms with filters like ["dataset"] for datasets, ["neuron","adult","has_image"] for adult neurons, ["anatomy"] for brain regions, ["gene"] for genes. Always exclude ["deprecated"].
- get_term_info(id): Get detailed info about a VFB entity by ID
- run_query(id, query_type): Run analyses like PaintedDomains, NBLAST, Connectivity. IMPORTANT: Only use query_type values that are returned in the Queries array from get_term_info for the given id. Do not guess or invent query types. For connectivity, individual neurons from connectomes often have "NeuronNeuronConnectivityQuery" available.

STRATEGY:
1. For anatomy/neurons: search_terms with specific filters → get_term_info → run relevant queries
2. Handle pagination if _truncation.canRequestMore=true
3. When you encounter a VFB term ID in user messages, call get_term_info to get detailed information about it
4. When displaying multiple neurons or creating scene links, use the IDs directly from search results without calling get_term_info unless you need additional metadata like descriptions or images
5. ALWAYS call get_term_info before using run_query to see what query types are available for that entity. Only use query types that appear in the Queries array returned by get_term_info.
6. For connectivity queries: If a neuron class (IsClass: true) doesn't have connectivity data, look at individual neuron instances from connectomes. Use "ListAllAvailableImages" to find individual neurons, then check those individuals for connectivity queries like "NeuronNeuronConnectivityQuery".
7. Construct VFB URLs: https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?id=<id>&i=<template_id>,<image_ids>

DISPLAYING IMAGES:
ONLY show thumbnail images when they are actually available AND validated to exist in the VFB data. NEVER make up or invent thumbnail URLs.
When get_term_info returns visual data, include thumbnail URLs in your response using markdown image syntax:
![label](thumbnail_url)
Do NOT show any images if no validated thumbnail URLs are available in the data. The user's chat interface renders these as compact thumbnails that expand on hover.

SUGGESTED FOLLOW-UP QUESTIONS:
At the end of your responses, when appropriate (not always necessary), suggest 2-4 follow-up questions the user might want to ask next. Include these as plain-text URLs in one of these formats:

**Format 1 - Plain-text URLs in text (recommended):**
You might also want to explore:
- What neurons have presynaptic terminals in the medulla? https://chat.virtualflybrain.org?query=What%20neurons%20have%20presynaptic%20terminals%20in%20the%20medulla%3F
- Show me neuron morphologies https://chat.virtualflybrain.org?query=Show%20me%20neuron%20morphologies

**Format 2 - Markdown links (also works):**
[What is the lomula](https://chat.virtualflybrain.org?query=What%20is%20the%20lobula) or [Show me MB connectivity](https://chat.virtualflybrain.org?query=Show%20me%20mushroom%20body%20connectivity)

**Format 3 - Inline in sentences:**
If you want to explore further, you could ask about [layer-specific connectivity](https://chat.virtualflybrain.org?query=What%20is%20the%20layer-specific%20connectivity%20in%20the%20medulla) or [transgenic lines](https://chat.virtualflybrain.org?query=Which%20transgenic%20lines%20label%20medulla%20neurons).

**Important guidelines:**
- The question text in the URL MUST be properly URL-encoded (spaces as %20, ? as %3F, etc.)
- Keep questions concise and specific to the topic at hand
- Only suggest when relevant — skip if the response already answers likely follow-ups
- Vary the question types: ask about connectivity, morphology, genetics, layers, comparisons, etc.
- The user's chat interface automatically converts both plain URLs and markdown links to clickable buttons that submit the question
- Don't overuse: 2-3 well-chosen questions are better than 5 generic ones
- Do NOT include any instructional text like "you can click or copy-paste these into the chat" or "copy and paste" — the links are already clickable, so such instructions are unnecessary and redundant. Just present the links directly with a brief natural intro like "You might also want to explore:" or "Related questions:".`

        // Term resolution happens during conversation via tool calls

        // Initial messages - prepend system prompt to conversation history
        const resolvedUserMessage = replaceTermsWithLinks(message)
        const conversationMessages = [
          { role: 'system', content: systemPrompt },
          ...messages.slice(0, -1).map(msg => ({ role: msg.role, content: msg.content })), // Previous messages
          { role: 'user', content: resolvedUserMessage } // Current user message
        ]

        let finalResponse = ''
        const maxIterations = 3

        for (let iteration = 0; iteration < maxIterations; iteration++) {
          log(`Starting iteration ${iteration + 1}/${maxIterations}`)
          
          // Call OpenAI-compatible API
          const apiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
          const apiKey = process.env.OPENAI_API_KEY
          const apiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini'
          const apiStart = Date.now()

          // Set up timeout (shorter for cloud API)
          const hasToolResults = conversationMessages.some(msg => msg.role === 'tool')
          const timeoutMs = hasToolResults ? 120000 : 60000 // 2 min with tool results, 1 min without
          const abortController = new AbortController()
          const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

          log('Calling LLM API', {
            iteration: iteration + 1,
            messageCount: conversationMessages.length,
            model: apiModel,
            timeoutMs,
            hasToolResults
          })

          const apiResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
            },
            body: JSON.stringify({
              model: apiModel,
              messages: conversationMessages,
              tools: tools,
              stream: false
            }),
            signal: abortController.signal
          })

          clearTimeout(timeoutId)

          const apiDuration = Date.now() - apiStart
          log('LLM API response received', { duration: `${apiDuration}ms`, status: apiResponse.status })

          if (!apiResponse.ok) {
            const errorText = await apiResponse.text()
            log('LLM API error', { error: errorText })
            sendEvent('error', { message: `Error: LLM API error - ${errorText}` })
            controller.close()
            return
          }

          const apiData = await apiResponse.json()
          const assistantMessage = apiData.choices?.[0]?.message

          if (!assistantMessage) {
            log('No assistant message in LLM response')
            break
          }

          log('Assistant message received', { 
            hasContent: !!assistantMessage.content,
            toolCallsCount: assistantMessage.tool_calls?.length || 0,
            contentLength: assistantMessage.content?.length || 0
          })

          // Note: We no longer run replaceTermsWithLinks on LLM responses.
          // The LLM now has full data and system prompt instructions to create its own markdown links.
          // Running replacement on LLM output caused nested link corruption.

          conversationMessages.push(assistantMessage)

          // Check for tool calls
          if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            // Send intermediate reasoning to user in smaller font
            if (assistantMessage.content) {
              sendEvent('reasoning', { text: assistantMessage.content })
            }
            
            log('Processing tool calls', { count: assistantMessage.tool_calls.length })
            
            // Update status immediately when MCP calls are initiated
            sendEvent('status', { message: 'Querying the fly hive mind', phase: 'mcp' })
            
            for (const toolCall of assistantMessage.tool_calls) {
                const toolStart = Date.now()
                
                // Parse tool arguments (OpenAI returns JSON string, Ollama returned object)
                const parsedArgs = parseToolArguments(toolCall.function.arguments)
                
                log('Executing tool call', { 
                  name: toolCall.function.name, 
                  args: toolCall.function.name === 'get_term_info' && parsedArgs?.id ? 
                    `pulling info on ${parsedArgs.id}` : 
                    JSON.stringify(toolCall.function.arguments).substring(0, 200) 
                })
                
                try {
                  let toolResult = null

                  // FAST LOCAL TERM RESOLUTION: Try local cache first for get_term_info
                  if (toolCall.function.name === 'get_term_info' && parsedArgs?.id) {
                    const localId = resolveTermLocally(parsedArgs.id)
                    if (localId && localId !== parsedArgs.id) {
                      log('Local term resolution', {
                        input: parsedArgs.id,
                        resolved: localId
                      })
                      // Update the arguments with resolved ID
                      parsedArgs.id = localId
                    }
                  }

                  // Modify arguments for search_terms to limit results
                  let callArgs = parsedArgs
                  if (toolCall.function.name === 'search_terms') {
                    callArgs = { ...callArgs }
                    if (callArgs.rows === undefined) callArgs.rows = 10
                    if (callArgs.start === undefined) callArgs.start = 0
                    
                    // Fix case sensitivity for filter_types - VFB uses capitalized facet names
                    if (callArgs.filter_types && Array.isArray(callArgs.filter_types)) {
                      callArgs.filter_types = callArgs.filter_types.map(type => {
                        const lowerType = type.toLowerCase()
                        // Map common lowercase filters to proper capitalized VFB facets
                        const facetMap = {
                          'dataset': 'DataSet',
                          'neuron': 'Neuron',
                          'anatomy': 'Anatomy',
                          'gene': 'Gene',
                          'adult': 'Adult',
                          'has_image': 'has_image',
                          'deprecated': 'Deprecated'
                        }
                        return facetMap[lowerType] || type
                      })
                    }
                    
                    // Also fix exclude_types
                    if (callArgs.exclude_types && Array.isArray(callArgs.exclude_types)) {
                      callArgs.exclude_types = callArgs.exclude_types.map(type => {
                        const lowerType = type.toLowerCase()
                        const facetMap = {
                          'dataset': 'DataSet',
                          'neuron': 'Neuron',
                          'anatomy': 'Anatomy',
                          'gene': 'Gene',
                          'adult': 'Adult',
                          'has_image': 'has_image',
                          'deprecated': 'Deprecated'
                        }
                        return facetMap[lowerType] || type
                      })
                    }
                  }

                  // Use MCP client to call the tool
                  if (mcpClient.getServerCapabilities()?.tools) {
                    const result = await mcpClient.callTool({
                      name: toolCall.function.name,
                      arguments: callArgs
                    })
                    toolResult = result
                  } else {
                    throw new Error('MCP server does not support tools')
                  }

                  const toolDuration = Date.now() - toolStart
                  log('Tool call completed', { 
                    name: toolCall.function.name, 
                    duration: `${toolDuration}ms`,
                    resultSize: JSON.stringify(toolResult).length 
                  })

                  // DEBUG: Log raw MCP result
                  console.log('🔍 MCP RAW RESULT:', JSON.stringify(toolResult, null, 2))

                  // Process search results to minimize response size
                  if (toolCall.function.name === 'search_terms' && toolResult?.content?.[0]?.text) {
                    try {
                      const parsedResult = JSON.parse(toolResult.content[0].text)
                      
                      // Filter results based on filter_types if specified
                      if (parsedResult?.response?.docs && callArgs?.filter_types?.length > 0) {
                        const filterTypes = callArgs.filter_types
                        parsedResult.response.docs = parsedResult.response.docs.filter(doc => {
                          if (!doc.facets_annotation || !Array.isArray(doc.facets_annotation)) {
                            return false
                          }
                          // Check if the doc has any of the required filter types
                          return filterTypes.some(filterType => 
                            doc.facets_annotation.includes(filterType)
                          )
                        })
                        // Update numFound to reflect filtered count
                        parsedResult.response.numFound = parsedResult.response.docs.length
                        log('Filtered search results by facets', { 
                          filterTypes, 
                          originalCount: parsedResult.response.numFound,
                          filteredCount: parsedResult.response.docs.length 
                        })
                      }
                      
                      // POPULATE CACHE: Add label->ID mappings from search results
                      if (parsedResult?.response?.docs) {
                        parsedResult.response.docs.forEach(doc => {
                          if (doc.label && doc.short_form) {
                            addToLookupCache(doc.label, doc.short_form)
                          }
                          // Also add synonyms if available
                          if (doc.synonym && Array.isArray(doc.synonym)) {
                            doc.synonym.forEach(syn => {
                              if (syn && doc.short_form) {
                                addToLookupCache(syn, doc.short_form)
                              }
                            })
                          }
                        })
                        log('Added search results to lookup cache', { count: parsedResult.response.docs.length })
                      }
                      
                      if (parsedResult?.response?.docs) {
                        const query = parsedArgs?.query?.toLowerCase() || ''
                        const originalCount = parsedResult.response.numFound

                        const start = parsedArgs?.start || 0
                        const rows = parsedArgs?.rows || 10
                        const isPaginatedRequest = start > 0 || (rows && rows !== 10)
                        
                        // Check for exact label match first (only for initial searches)
                        const exactMatch = !isPaginatedRequest ? parsedResult.response.docs.find(doc => 
                          doc.label?.toLowerCase() === query
                        ) : null
                        
                        let minimizedDocs
                        let truncationInfo = {}
                        
                        if (exactMatch) {
                          // If exact match found in initial search, return just that one
                          minimizedDocs = [exactMatch]
                          truncationInfo = { exactMatch: true, totalAvailable: originalCount }
                          log('Found exact label match, returning single result', { label: exactMatch.label })
                          
                          // Pre-fetch term info for the exact match
                          try {
                            const termInfoResult = await mcpClient.callTool({
                              name: 'get_term_info',
                              arguments: { id: exactMatch.short_form }
                            })
                            parsedResult._term_info = termInfoResult
                            log('Pre-fetched term info for exact match', { id: exactMatch.short_form })
                          } catch (termInfoError) {
                            log('Failed to pre-fetch term info', { error: termInfoError.message, id: exactMatch.short_form })
                          }
                        } else if (isPaginatedRequest) {
                          // For paginated requests, return all requested results (up to reasonable limit)
                          minimizedDocs = parsedResult.response.docs.slice(0, Math.min(rows, 50))
                          truncationInfo = { 
                            paginated: true, 
                            requested: rows, 
                            returned: minimizedDocs.length,
                            totalAvailable: originalCount
                          }
                        } else {
                          // For initial searches without pagination, limit to top 10
                          minimizedDocs = parsedResult.response.docs.slice(0, 10)
                          truncationInfo = { 
                            truncated: originalCount > 10, 
                            shown: minimizedDocs.length, 
                            totalAvailable: originalCount,
                            canRequestMore: originalCount > 10
                          }
                        }
                        
                        // Keep only essential fields
                        minimizedDocs = minimizedDocs.map(doc => ({
                          short_form: doc.short_form,
                          label: doc.label,
                          synonym: Array.isArray(doc.synonym) ? doc.synonym[0] : doc.synonym // Keep only first synonym
                        }))
                        
                        parsedResult.response.docs = minimizedDocs
                        parsedResult.response.numFound = minimizedDocs.length // Update count
                        
                        // Add truncation metadata
                        parsedResult.response._truncation = truncationInfo
                        
                        // Put back as text
                        toolResult.content[0].text = JSON.stringify(parsedResult)
                        
                        log('Minimized search results', { 
                          originalCount,
                          minimizedCount: minimizedDocs.length,
                          exactMatch: !!exactMatch,
                          paginated: isPaginatedRequest,
                          resultSize: toolResult.content[0].text.length
                        })

                        // DEBUG: Log minimized result
                        console.log('🔍 MINIMIZED RESULT:', toolResult.content[0].text.substring(0, 500) + '...')
                      }
                    } catch (error) {
                      log('Failed to parse search result for minimization', { error: error.message })
                    }
                  }

                  // POPULATE CACHE: Add additional mappings from get_term_info results
                  if (toolCall.function.name === 'get_term_info' && toolResult?.content?.[0]?.text) {
                    try {
                      const termInfo = JSON.parse(toolResult.content[0].text)
                      if (termInfo && termInfo.term && termInfo.term.core) {
                        const core = termInfo.term.core
                        const id = core.short_form
                        
                        // Add label
                        if (core.label) {
                          addToLookupCache(core.label, id)
                        }
                        
                        // Add synonyms
                        if (core.synonyms && Array.isArray(core.synonyms)) {
                          core.synonyms.forEach(syn => {
                            if (syn && syn.label) {
                              addToLookupCache(syn.label, id)
                            }
                          })
                        }
                        
                        log('Added term info to lookup cache', { id, label: core.label })
                      }
                    } catch (error) {
                      log('Failed to parse term info for cache', { error: error.message })
                    }
                  }

                  const toolContent = JSON.stringify(toolResult)

                  // Add tool result to conversation
                  conversationMessages.push({
                    role: 'tool',
                    content: toolContent,
                    tool_call_id: toolCall.id
                  })

                } catch (toolError) {
                  const toolDuration = Date.now() - toolStart
                  log('Tool call failed', { 
                    name: toolCall.function.name, 
                    duration: `${toolDuration}ms`,
                    error: toolError.message 
                  })
                  
                  // Update status when MCP call fails
                  sendEvent('status', { message: 'MCP service unavailable, using knowledge base', phase: 'fallback' })
                  
                  conversationMessages.push({
                    role: 'tool',
                    content: `Error executing ${toolCall.function.name}: ${toolError.message}`,
                    tool_call_id: toolCall.id
                  })
                }
              }
              
            // Switch back to thinking for next LLM call after MCP processing
            sendEvent('status', { message: 'Processing results', phase: 'llm' })
          } else {
            // No tool calls - this is the final response
            finalResponse = assistantMessage.content || ''
            // Note: No replaceTermsWithLinks here - LLM creates its own links
            log('Final response generated', { length: finalResponse.length })
            break
          }
        }
        if (!finalResponse) {
          log('No final response after max iterations, making fallback call')
          sendEvent('status', { message: 'Generating final response', phase: 'fallback' })
          const fallbackBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
          const fallbackApiKey = process.env.OPENAI_API_KEY
          const fallbackModel = process.env.OPENAI_MODEL || 'gpt-4o-mini'
          const fallbackStart = Date.now()

          // Set up timeout for fallback call
          const fallbackController = new AbortController()
          const fallbackTimeoutMs = 120000 // 2 minutes
          const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), fallbackTimeoutMs)

          const finalApiResponse = await fetch(`${fallbackBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(fallbackApiKey ? { 'Authorization': `Bearer ${fallbackApiKey}` } : {})
            },
            body: JSON.stringify({
              model: fallbackModel,
              messages: conversationMessages,
              stream: false
            }),
            signal: fallbackController.signal
          })

          clearTimeout(fallbackTimeoutId)
          const fallbackDuration = Date.now() - fallbackStart
          log('Fallback LLM call completed', { duration: `${fallbackDuration}ms`, status: finalApiResponse.status })

          if (finalApiResponse.ok) {
            const finalData = await finalApiResponse.json()
            finalResponse = finalData.choices?.[0]?.message?.content || 'I apologize, but I was unable to generate a complete response. Please try rephrasing your question.'
            // Note: No replaceTermsWithLinks here - LLM creates its own links
            log('Fallback response generated', { length: finalResponse.length })
          } else {
            finalResponse = 'I apologize, but there was an error generating the response. Please try again.'
            log('Fallback call failed, using error message')
          }
        }

        // Parse for images
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

        // Track query for analytics
        trackQuery(message, finalResponse.length, totalDuration, `session_${Date.now()}`)

        // Send final result
        sendEvent('result', { response: finalResponse, images, newScene: scene })
        
        // Clean up MCP client
        try {
          if (mcpClient) await mcpClient.close()
          if (mcpTransport) await mcpTransport.close()
        } catch (cleanupError) {
          log('MCP cleanup error', { error: cleanupError.message })
        }
        
        controller.close()

      } catch (error) {
        const totalDuration = Date.now() - startTime
        log('Chat API request failed', { totalDuration: `${totalDuration}ms`, error: error.message })
        
        console.error('Chat API error:', error)
        sendEvent('error', { message: `Error: ${error.message}` })
        
        // Clean up MCP client
        try {
          if (mcpClient) await mcpClient.close()
          if (mcpTransport) await mcpTransport.close()
        } catch (cleanupError) {
          log('MCP cleanup error', { error: cleanupError.message })
        }
        
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
