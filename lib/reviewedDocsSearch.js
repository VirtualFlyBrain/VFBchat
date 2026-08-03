import fs from 'fs'

import { APP_USER_AGENT } from './appVersion.mjs'
import { isAllowedHost, normalizeHostCandidate } from './policy.js'
import {
  getReviewedDocsCacheTtlMs,
  getReviewedDocsDiscoveryUrls,
  getReviewedDocsFetchTimeoutMs,
  getReviewedDocsIndexFile,
  getReviewedDocsMaxUrls,
  getSearchAllowList
} from './runtimeConfig.js'

const MAX_SITEMAP_FILES = 25
const MAX_SEARCH_RESULTS_TO_ENRICH = 3
const MAX_PAGE_HEADINGS = 6
const MAX_PAGE_PARAGRAPHS = 5
const MAX_PAGE_BLOCKS = 24
const MAX_PAGE_CONTENT_CHARS = 6000

const SEARCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'in',
  'is',
  'of',
  'on',
  'or',
  'site',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why'
])

const BLOCKED_PAGE_PATH_PATTERNS = [
  /\/wp-content\//i,
  /\/wp-json\//i,
  /\/feed\/?$/i,
  /\/comments\/?$/i,
  /\/data\//i,
  /\/reports\/(?:vfb_|fbbt_|fbrf)/i,
  /\.(?:png|jpe?g|gif|svg|webp|ico|json|xml|txt|zip|gz|csv|tsv|mp3|mp4|mov|avi|wmv|docx?|xlsx?|pptx?)$/i
]

let cachedSeedFile = null
let cachedSeedIndex = []

let dynamicIndexCache = {
  key: '',
  loadedAt: 0,
  entries: []
}

const pageCache = new Map()

function ensureString(value) {
  return typeof value === 'string' ? value : ''
}

function normalizeUrlForStorage(value) {
  if (!value) return null

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.search = ''

    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }

    return url.toString()
  } catch {
    return null
  }
}

function decodeHtmlEntities(value = '') {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      const numericCode = Number.parseInt(code, 16)
      return Number.isFinite(numericCode) ? String.fromCodePoint(numericCode) : match
    })
    .replace(/&#(\d+);/g, (match, code) => {
      const numericCode = Number.parseInt(code, 10)
      return Number.isFinite(numericCode) ? String.fromCodePoint(numericCode) : match
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  }

function collapseWhitespace(value = '') {
  return decodeHtmlEntities(value)
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeBlockText(value = '') {
  return decodeHtmlEntities(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripTags(value = '') {
  return collapseWhitespace(value.replace(/<[^>]+>/g, ' '))
}

function stripNonContentHtml(html = '') {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function tokenize(value) {
  return ensureString(value)
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !SEARCH_STOPWORDS.has(token))
}

function titleCaseWords(value) {
  return value
    .split(/\s+/g)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function humanizeUrlSegment(segment = '') {
  const cleaned = collapseWhitespace(
    segment
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
  )

  return cleaned ? titleCaseWords(cleaned) : ''
}

function getPathKeywords(url) {
  const pathname = ensureString(url.pathname || '')
  return uniqueStrings(
    pathname
      .split('/')
      .flatMap(segment => segment.split(/[-_]+/g))
      .map(token => token.trim().toLowerCase())
      .filter(token => token.length > 1)
  )
}

function buildGeneratedTitle(url) {
  const segments = ensureString(url.pathname || '')
    .split('/')
    .filter(Boolean)

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const title = humanizeUrlSegment(segments[index])
    if (title && title.toLowerCase() !== 'index') {
      return title
    }
  }

  if (url.pathname === '/' || !url.pathname) {
    return titleCaseWords(url.hostname.replace(/^www\./, '').replace(/\./g, ' '))
  }

  return titleCaseWords(url.hostname.replace(/^www\./, '').replace(/\./g, ' '))
}

function buildGeneratedSummary(url) {
  if (url.pathname === '/' || !url.pathname) {
    return `Approved page on ${url.hostname}.`
  }

  return `Approved page on ${url.hostname} at ${url.pathname}.`
}

function isIndexableReviewedUrl(value, allowList) {
  const normalizedUrl = normalizeUrlForStorage(value)
  if (!normalizedUrl) return false

  try {
    const url = new URL(normalizedUrl)
    const hostname = normalizeHostCandidate(url.hostname)
    if (!hostname || !isAllowedHost(hostname, allowList)) return false

    return !BLOCKED_PAGE_PATH_PATTERNS.some(pattern => pattern.test(url.pathname))
  } catch {
    return false
  }
}

function createEntryFromUrl(urlString, extras = {}) {
  const normalizedUrl = normalizeUrlForStorage(urlString)
  if (!normalizedUrl) return null

  const url = new URL(normalizedUrl)
  const title = collapseWhitespace(extras.title) || buildGeneratedTitle(url)
  const summary = collapseWhitespace(extras.summary) || buildGeneratedSummary(url)
  const keywords = uniqueStrings([
    ...getPathKeywords(url),
    ...(Array.isArray(extras.keywords) ? extras.keywords.map(item => collapseWhitespace(String(item).toLowerCase())) : [])
  ])

  return {
    id: ensureString(extras.id) || normalizedUrl,
    title,
    url: normalizedUrl,
    domain: url.hostname.toLowerCase(),
    summary,
    keywords,
    pathname: url.pathname,
    publishedAt: collapseWhitespace(extras.publishedAt) || null
  }
}

function mergeEntries(preferredEntry, fallbackEntry) {
  if (!fallbackEntry) return preferredEntry
  if (!preferredEntry) return fallbackEntry

  return {
    ...fallbackEntry,
    ...preferredEntry,
    keywords: uniqueStrings([...(preferredEntry.keywords || []), ...(fallbackEntry.keywords || [])]),
    publishedAt: preferredEntry.publishedAt || fallbackEntry.publishedAt || null
  }
}

function loadSeedIndex() {
  const indexFile = getReviewedDocsIndexFile()
  if (cachedSeedFile === indexFile) {
    return cachedSeedIndex
  }

  const allowList = getSearchAllowList()

  try {
    const raw = fs.readFileSync(indexFile, 'utf8')
    const parsed = JSON.parse(raw)

    cachedSeedIndex = Array.isArray(parsed)
      ? parsed
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => createEntryFromUrl(entry.url || '', {
          id: entry.id,
          title: entry.title,
          summary: entry.summary,
          keywords: entry.keywords
        }))
        .filter(entry => entry && isAllowedHost(entry.domain, allowList))
      : []
  } catch {
    cachedSeedIndex = []
  }

  cachedSeedFile = indexFile
  return cachedSeedIndex
}

function extractXmlLocs(xml = '') {
  return uniqueStrings(
    [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
      .map(match => collapseWhitespace(match[1]))
  )
}

function extractRobotSitemaps(text = '') {
  return uniqueStrings(
    text
      .split(/\r?\n/g)
      .map(line => line.trim())
      .filter(line => /^sitemap:/i.test(line))
      .map(line => line.replace(/^sitemap:\s*/i, '').trim())
      .filter(Boolean)
  )
}

async function fetchText(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), getReviewedDocsFetchTimeoutMs())

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8',
        'User-Agent': APP_USER_AGENT
      },
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`Fetch failed for ${url}: HTTP ${response.status}`)
    }

    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

async function discoverDynamicSiteEntries(allowList) {
  const discoveryUrls = getReviewedDocsDiscoveryUrls()
  const maxUrls = getReviewedDocsMaxUrls()
  const sitemapQueue = []
  const visitedSitemaps = new Set()
  const pageUrls = new Set()

  for (const discoveryUrl of discoveryUrls) {
    const normalizedDiscoveryUrl = normalizeUrlForStorage(discoveryUrl)
    if (!normalizedDiscoveryUrl) continue

    try {
      const discovery = new URL(normalizedDiscoveryUrl)
      if (!isAllowedHost(discovery.hostname, allowList)) continue

      if (discovery.pathname.endsWith('/robots.txt')) {
        try {
          const robotsText = await fetchText(normalizedDiscoveryUrl)
          for (const sitemapUrl of extractRobotSitemaps(robotsText)) {
            const normalizedSitemapUrl = normalizeUrlForStorage(sitemapUrl)
            if (!normalizedSitemapUrl) continue

            const sitemapHost = normalizeHostCandidate(normalizedSitemapUrl)
            if (sitemapHost && isAllowedHost(sitemapHost, allowList)) {
              sitemapQueue.push(normalizedSitemapUrl)
            }
          }
        } catch {
          // Robots discovery is best-effort only.
        }
      } else {
        sitemapQueue.push(normalizedDiscoveryUrl)
      }
    } catch {
      // Ignore malformed discovery URLs.
    }
  }

  while (sitemapQueue.length > 0 && visitedSitemaps.size < MAX_SITEMAP_FILES && pageUrls.size < maxUrls) {
    const sitemapUrl = sitemapQueue.shift()
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) continue
    visitedSitemaps.add(sitemapUrl)

    try {
      const xml = await fetchText(sitemapUrl)
      const locs = extractXmlLocs(xml)

      if (/<sitemapindex[\s>]/i.test(xml)) {
        for (const nestedSitemapUrl of locs) {
          const normalizedNestedSitemapUrl = normalizeUrlForStorage(nestedSitemapUrl)
          if (!normalizedNestedSitemapUrl || visitedSitemaps.has(normalizedNestedSitemapUrl)) continue

          const sitemapHost = normalizeHostCandidate(normalizedNestedSitemapUrl)
          if (sitemapHost && isAllowedHost(sitemapHost, allowList)) {
            sitemapQueue.push(normalizedNestedSitemapUrl)
          }
        }
        continue
      }

      for (const pageUrl of locs) {
        if (pageUrls.size >= maxUrls) break
        if (isIndexableReviewedUrl(pageUrl, allowList)) {
          pageUrls.add(normalizeUrlForStorage(pageUrl))
        }
      }
    } catch {
      // Individual sitemap failures should not break overall search.
    }
  }

  return Array.from(pageUrls)
    .map(url => createEntryFromUrl(url))
    .filter(Boolean)
}

async function loadDynamicIndex() {
  const allowList = getSearchAllowList()
  const cacheKey = [
    getReviewedDocsDiscoveryUrls().join('|'),
    allowList.join('|'),
    getReviewedDocsMaxUrls()
  ].join('::')

  if (
    dynamicIndexCache.key === cacheKey
    && dynamicIndexCache.loadedAt > 0
    && (Date.now() - dynamicIndexCache.loadedAt) < getReviewedDocsCacheTtlMs()
  ) {
    return dynamicIndexCache.entries
  }

  const entries = await discoverDynamicSiteEntries(allowList)
  dynamicIndexCache = {
    key: cacheKey,
    loadedAt: Date.now(),
    entries
  }

  return entries
}

function combineIndexes(seedEntries, dynamicEntries) {
  const merged = new Map()

  for (const entry of dynamicEntries) {
    if (!entry) continue
    merged.set(entry.url, entry)
  }

  for (const entry of seedEntries) {
    if (!entry) continue
    merged.set(entry.url, mergeEntries(entry, merged.get(entry.url)))
  }

  return Array.from(merged.values())
}

function entryFields(entry) {
  const title = ensureString(entry.title).toLowerCase()
  const summary = ensureString(entry.summary).toLowerCase()
  const pathname = ensureString(entry.pathname).toLowerCase()
  const domain = ensureString(entry.domain).toLowerCase()
  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords.map(keyword => ensureString(keyword).toLowerCase())
    : []

  return { title, summary, pathname, domain, keywords, haystack: [title, summary, pathname, domain, ...keywords].join(' ') }
}

/**
 * How much each query token should count, from how rare it is in the corpus.
 *
 * Every page in this index lives on virtualflybrain.org, so "virtual", "fly",
 * "brain" and "vfb" match the domain of essentially every entry. Under a flat
 * per-token score, a question that merely NAMES the site outscored every page
 * that is actually ABOUT the thing being asked: "How do I use the Virtual Fly
 * Brain Model Context Protocol (MCP) tool?" ranked the site homepage first and
 * never reached /docs/tutorials/vfb-mcp-guide, the one page that answers it.
 * Dropping the product words from the same query surfaced that page at once.
 *
 * So weight by inverse document frequency, normalised to (0,1]: a token no
 * other page carries keeps its full weight and decides the ranking; a token
 * almost every page carries is worth almost nothing. The floor is deliberately
 * non-zero so a query made ENTIRELY of product words still ranks something.
 */
function tokenWeights(tokens, fieldsList) {
  const total = fieldsList.length || 1
  const weights = new Map()

  for (const token of new Set(tokens)) {
    let df = 0
    for (const fields of fieldsList) if (fields.haystack.includes(token)) df += 1
    const idf = Math.log((total + 1) / (df + 1)) / Math.log(total + 1)
    weights.set(token, Math.max(0.05, idf))
  }

  return weights
}

function scoreEntry(entry, tokens, weights = null, fields = null) {
  if (tokens.length === 0) return 0

  const f = fields || entryFields(entry)
  let score = 0

  for (const token of tokens) {
    const weight = weights ? (weights.get(token) ?? 1) : 1
    let raw = 0
    if (f.title.includes(token)) raw += 6
    if (f.pathname.includes(token)) raw += 4
    if (f.keywords.some(keyword => keyword.includes(token))) raw += 3
    if (f.summary.includes(token)) raw += 2
    if (f.haystack.includes(token)) raw += 1
    score += raw * weight
  }

  return score
}

/**
 * Reviewed-doc entries that match `tokens`, best first. Exported so the ranking
 * can be tested without touching the index files or the network.
 */
export function rankEntries(entries, tokens) {
  const list = Array.isArray(entries) ? entries : []
  const fieldsList = list.map(entryFields)
  const weights = tokenWeights(tokens, fieldsList)

  return list
    .map((entry, index) => ({ entry, score: scoreEntry(entry, tokens, weights, fieldsList[index]) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .map(item => item.entry)
}

export function tokenizeQuery(query) {
  return tokenize(query || '')
}

function extractMetaContent(html, attrName, attrValue) {
  const patterns = [
    new RegExp(`<meta[^>]*${attrName}=["']${attrValue}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${attrValue}["'][^>]*>`, 'i')
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) {
      return collapseWhitespace(match[1])
    }
  }

  return ''
}

function extractTagTexts(html, tagName, maxCount) {
  const matches = [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi'))]

  return uniqueStrings(
    matches
      .map(match => stripTags(match[1]))
      .filter(Boolean)
      .slice(0, maxCount)
  )
}

/**
 * Content blocks in document order: headings, paragraphs, and code/command
 * blocks. Order matters — "It can be installed via PyPi:" and the
 * "pip install vfb-connect" that follows it only mean anything together.
 *
 * <pre> used to be dropped altogether, so any page whose answer is a command
 * or a config snippet lost precisely the part that answered. The vfb-connect
 * docs came back as "It can be installed via PyPi :" with nothing after the
 * colon, and the answer to "how do I install vfb-connect" was that sentence
 * and no command; the MCP guide lost all four client configurations.
 *
 * <li> stays out. It looks like content and is overwhelmingly navigation:
 * pages on the site carry 500-1300 list items each, nearly all menu links.
 */
export function extractContentBlocks(html, { skip = '' } = {}) {
  const blocks = []
  const seen = new Set()

  for (const match of html.matchAll(/<(h1|h2|h3|p|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = match[1].toLowerCase()
    // Code keeps its line breaks; prose gets collapsed to a single line.
    const text = tag === 'pre'
      ? normalizeBlockText(match[2].replace(/<[^>]+>/g, ''))
      : stripTags(match[2])

    // Prose is length-filtered to drop captions, labels and stray fragments.
    // A code block is short by nature — "pip install x" IS the answer.
    if (!text || (tag === 'p' && text.length < 40)) continue
    if (text === skip || seen.has(text)) continue

    seen.add(text)
    blocks.push(text)
    if (blocks.length >= MAX_PAGE_BLOCKS) break
  }

  return blocks
}

function extractPublishedAt(html) {
  const candidates = [
    extractMetaContent(html, 'property', 'article:published_time'),
    extractMetaContent(html, 'name', 'article:published_time'),
    extractMetaContent(html, 'property', 'og:updated_time'),
    extractMetaContent(html, 'name', 'pubdate')
  ]

  const timeMatch = html.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i)
  if (timeMatch?.[1]) {
    candidates.push(collapseWhitespace(timeMatch[1]))
  }

  return candidates.find(Boolean) || null
}

async function loadReviewedPageData(url) {
  const allowList = getSearchAllowList()
  const normalizedUrl = normalizeUrlForStorage(url)

  if (!normalizedUrl || !isIndexableReviewedUrl(normalizedUrl, allowList)) {
    throw new Error('The requested page is not on the approved reviewed-doc allow-list.')
  }

  const cached = pageCache.get(normalizedUrl)
  if (cached && (Date.now() - cached.loadedAt) < getReviewedDocsCacheTtlMs()) {
    return cached.value
  }

  const html = stripNonContentHtml(await fetchText(normalizedUrl))
  const pageUrl = new URL(normalizedUrl)

  const title = uniqueStrings([
    extractMetaContent(html, 'property', 'og:title'),
    extractMetaContent(html, 'name', 'twitter:title'),
    stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    ...extractTagTexts(html, 'h1', 1)
  ])[0] || buildGeneratedTitle(pageUrl)

  const headings = uniqueStrings([
    ...extractTagTexts(html, 'h1', 2),
    ...extractTagTexts(html, 'h2', MAX_PAGE_HEADINGS),
    ...extractTagTexts(html, 'h3', MAX_PAGE_HEADINGS)
  ]).slice(0, MAX_PAGE_HEADINGS)

  const paragraphs = extractTagTexts(html, 'p', 12)
    .filter(paragraph => paragraph.length >= 40)
    .slice(0, MAX_PAGE_PARAGRAPHS)

  const summary = uniqueStrings([
    extractMetaContent(html, 'name', 'description'),
    extractMetaContent(html, 'property', 'og:description'),
    paragraphs[0] || ''
  ])[0] || buildGeneratedSummary(pageUrl)

  const contentBlocks = extractContentBlocks(html, { skip: title })

  const content = normalizeBlockText(contentBlocks.join('\n\n')).slice(0, MAX_PAGE_CONTENT_CHARS)
  const excerpt = normalizeBlockText([summary, ...contentBlocks.slice(0, 2)].join('\n\n')).slice(0, 1200)

  const pageData = {
    source: 'approved_reviewed_page',
    url: normalizedUrl,
    domain: pageUrl.hostname.toLowerCase(),
    title,
    summary,
    published_at: extractPublishedAt(html),
    headings,
    excerpt,
    content
  }

  pageCache.set(normalizedUrl, {
    loadedAt: Date.now(),
    value: pageData
  })

  return pageData
}

async function enrichSearchResult(entry) {
  try {
    const pageData = await loadReviewedPageData(entry.url)
    return {
      id: entry.id,
      title: pageData.title || entry.title,
      url: entry.url,
      domain: entry.domain,
      summary: pageData.summary || entry.summary,
      published_at: pageData.published_at || entry.publishedAt || null
    }
  } catch {
    return {
      id: entry.id,
      title: entry.title,
      url: entry.url,
      domain: entry.domain,
      summary: entry.summary,
      published_at: entry.publishedAt || null
    }
  }
}

export async function searchReviewedDocs(query, maxResults = 5) {
  const cappedResults = Math.min(Math.max(Number(maxResults) || 5, 1), 10)
  const tokens = tokenize(query || '')

  const seedEntries = loadSeedIndex()
  const dynamicEntries = await loadDynamicIndex()
  const combinedEntries = combineIndexes(seedEntries, dynamicEntries)

  const ranked = rankEntries(combinedEntries, tokens)
  const selectedEntries = ranked.slice(0, cappedResults)
  const enrichedLimit = Math.min(selectedEntries.length, MAX_SEARCH_RESULTS_TO_ENRICH)
  const enrichedResults = await Promise.all(
    selectedEntries.map((entry, index) => (
      index < enrichedLimit
        ? enrichSearchResult(entry)
        : Promise.resolve({
          id: entry.id,
          title: entry.title,
          url: entry.url,
          domain: entry.domain,
          summary: entry.summary,
          published_at: entry.publishedAt || null
        })
    ))
  )

  return JSON.stringify({
    source: 'reviewed_seed_plus_dynamic_site_index',
    page_fetch_available: true,
    results: enrichedResults,
    total_found: ranked.length
  })
}

export async function getReviewedPage(url) {
  return JSON.stringify(await loadReviewedPageData(url))
}
