import fs from 'fs'

import { APP_USER_AGENT } from './appVersion.mjs'
import { isAllowedHost, normalizeHostCandidate } from './policy.js'
import {
  getReviewedDocsCacheTtlMs,
  getReviewedDocsDiscoveryUrls,
  getReviewedDocsFetchTimeoutMs,
  getReviewedDocsIndexFile,
  getReviewedDocsMaxUrls,
  getReviewedDocsSiteIndexUrl,
  getOutboundAllowList,
  getSearchAllowList
} from './runtimeConfig.js'

const MAX_SITEMAP_FILES = 25
const MAX_SEARCH_RESULTS_TO_ENRICH = 3
const MAX_PAGE_HEADINGS = 6
const MAX_PAGE_PARAGRAPHS = 5
// Raised alongside table and list-item extraction: /docs/data/em/ alone is a
// 9-row comparison table, which at the old cap would have consumed a third of
// the budget and pushed the prose after it off the end.
// …and raised again for the reference tables: /docs/data/stages/ is 210
// dataset rows under stage headings, and an answer that counts them needs
// all of them. The extractor's own window (MAX_EXTRACT_CHARS, 48k) is the
// outer bound; the page cap only needs to stay under it.
const MAX_PAGE_BLOCKS = 400
const MAX_PAGE_CONTENT_CHARS = 40000
// What the INDEX reads, as opposed to what the answer shows: the whole article
// as plain text. Ranking needs every word on the page; the answer needs the
// readable blocks. Conflating the two is what made the index blind.
const MAX_INDEX_TEXT_CHARS = 12000
// Pages fetched at once while building the enriched index. The whole corpus is
// ~96 pages per cache period, so this is politeness, not throughput.
const MAX_INDEX_ENRICH_CONCURRENCY = 4

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
  'many',
  'much',
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
  // Anchored. Unanchored, this blocked /docs/data/ as well as a top-level asset
  // directory — the whole documented-datasets tree, seven pages, including
  // /docs/data/em/ ("Electron Microscopy Data"), which is the one page that
  // says where the FAFB and FANC CATMAID instances live. The question "where
  // can I access the FAFB or FANC CATMAID datasets?" could not be answered
  // because its answer had been excluded from the index by an asset filter.
  /^\/data\//i,
  // readthedocs keeps every released version at /en/vX.Y.Z/. Ninety-one of the
  // 187 discovered URLs were those archives: near-duplicate stale copies that
  // put the document frequency of every vfb-connect term above ninety, which
  // drove its IDF weight to the floor and so actively SUPPRESSED vfb-connect
  // pages for vfb-connect questions. They are also versions nobody should be
  // sent to. /en/stable/ and /en/latest/ survive; the archives do not.
  /^\/en\/v\d/i,
  /\/reports\/(?:vfb_|fbbt_|fbrf)/i,
  /\.(?:png|jpe?g|gif|svg|webp|ico|json|xml|txt|zip|gz|csv|tsv|mp3|mp4|mov|avi|wmv|docx?|xlsx?|pptx?)$/i
]

let cachedSeedFile = null
let cachedSeedIndex = []

let dynamicIndexCache = {
  key: '',
  loadedAt: 0,
  entries: [],
  enriching: false
}

// Bounded, and stale entries are actually removed. Entries were TTL-checked on
// read and never deleted, so a stale one stayed resident until the same URL was
// requested again — and the reviewed-docs index carries up to
// REVIEWED_DOCS_MAX_URLS (2,500) of them, each holding up to 20 KB of page text.
// Over a long-lived container that is ~60 MB of permanently resident baseline
// that no request will ever free, on top of every request's own peak.
const pageCache = new Map()
const MAX_PAGE_CACHE_ENTRIES = (() => {
  const raw = Number(process.env.VFB_REVIEWED_DOCS_CACHE_ENTRIES)
  return Number.isFinite(raw) && raw >= 8 ? raw : 200
})()

/** Insertion-ordered, so the oldest entry is the first key. */
function setPageCache(key, value) {
  if (pageCache.has(key)) pageCache.delete(key)
  pageCache.set(key, value)
  while (pageCache.size > MAX_PAGE_CACHE_ENTRIES) {
    const oldest = pageCache.keys().next().value
    if (oldest === undefined) break
    pageCache.delete(oldest)
  }
}

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
    // The typographic set Hugo's Goldmark writes into every page.
    .replace(/&(rsquo|lsquo|apos);/gi, "'")
    .replace(/&(rdquo|ldquo);/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&times;/gi, '×')
    .replace(/&(micro|mu);/gi, 'µ')
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

const CHROME_TAGS = ['nav', 'aside', 'header', 'footer']

/**
 * The end of the element opened at `openIndex`, counting nesting.
 *
 * A non-greedy regex closes on the FIRST matching end tag, which is wrong for
 * anything that nests: the docs sidebar is <aside> wrapping <nav> wrapping more
 * <ul>, and closing early leaves half the menu behind. Returns the index just
 * past the closing tag, or -1 if the element never closes.
 */
function findElementEnd(html, tagName, openIndex) {
  const pattern = new RegExp(`<(/)?${tagName}\\b[^>]*>`, 'gi')
  pattern.lastIndex = openIndex
  let depth = 0
  let match = pattern.exec(html)

  while (match) {
    depth += match[1] ? -1 : 1
    if (depth === 0) return match.index + match[0].length
    match = pattern.exec(html)
  }

  return -1
}

function removeElements(html, tagName) {
  let result = html
  const opening = new RegExp(`<${tagName}\\b[^>]*>`, 'i')

  for (let guard = 0; guard < 50; guard += 1) {
    const start = result.search(opening)
    if (start < 0) break
    const end = findElementEnd(result, tagName, start)
    if (end < 0) {
      result = `${result.slice(0, start)} `
      break
    }
    result = `${result.slice(0, start)} ${result.slice(end)}`
  }

  return result
}

/**
 * The part of the page that is the page, with the site furniture taken off.
 *
 * Every host in the index marks its article: virtualflybrain.org and
 * neurofly.org with <main role="main">, readthedocs with <div role="main">.
 * Isolating it is what makes <li> safe to read as content — the reason list
 * items were excluded outright is that a docs page carries 400-plus of them and
 * nearly all are menu links, but nearly all of those sit OUTSIDE the article.
 *
 * `isolated` is false when no such marker exists (an older page, a bare
 * template). Callers use it to stay conservative there rather than guess.
 */
function extractMainRegion(html = '') {
  const markers = [/<main\b[^>]*>/i, /<(?:div|section|article)\b[^>]*role=["']main["'][^>]*>/i]

  for (const marker of markers) {
    const start = html.search(marker)
    if (start < 0) continue

    const tagName = html.slice(start + 1).match(/^[a-z0-9]+/i)?.[0]
    if (!tagName) continue

    const end = findElementEnd(html, tagName, start)
    if (end < 0) continue

    let region = html.slice(start, end)
    // Inside <main>, an <article> is the page and everything beside it is
    // furniture. virtualflybrain.org's docs layout puts the section tree — a
    // <details> of 100-odd <li> links — inside <main> ahead of
    // <article class="doc__main">, and with <li> readable in an isolated
    // region those links filled the block cap before the article's first
    // paragraph: get_reviewed_page on /docs/data/stages/ returned the sidebar
    // and nothing of the page, and "how many larval datasets" was answered
    // from thin air. The article wins when there is exactly one.
    const articles = [...region.matchAll(/<article\b[^>]*>/gi)]
    if (articles.length === 1) {
      const aStart = articles[0].index
      const aEnd = findElementEnd(region, 'article', aStart)
      if (aEnd > aStart) region = region.slice(aStart, aEnd)
    }
    for (const chromeTag of CHROME_TAGS) region = removeElements(region, chromeTag)
    return { html: region, isolated: true }
  }

  let region = html
  for (const chromeTag of CHROME_TAGS) region = removeElements(region, chromeTag)
  return { html: region, isolated: false }
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

/**
 * Whether a URL is one this index is allowed to carry. Exported so the path
 * blockers can be tested directly — an over-broad blocker is invisible from the
 * outside, it just quietly makes a page unanswerable.
 */
export function isIndexableReviewedUrl(value, allowList) {
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
    // Empty until the entry has been enriched from the page itself. Ranking
    // reads them; a placeholder entry simply scores on less.
    headings: Array.isArray(extras.headings) ? extras.headings.filter(Boolean) : [],
    text: ensureString(extras.text),
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
    // The seed file wins on title and summary — that is what curating them is
    // for — but it has no page content, and a plain spread would let its empty
    // fields erase the enriched body text of the twelve pages it covers, which
    // are the twelve pages that matter most.
    headings: (preferredEntry.headings?.length ? preferredEntry.headings : fallbackEntry.headings) || [],
    text: preferredEntry.text || fallbackEntry.text || '',
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

const MAX_REDIRECTS = 5

/**
 * Fetch an allow-listed URL, re-checking the allow-list at every hop.
 *
 * The default `redirect: 'follow'` checks the host once, before the request, and
 * then trusts whatever the response says. An allow-listed host — or anything
 * able to answer for one — could therefore send the fetcher anywhere, which
 * turns a documentation reader into a general-purpose outbound request.
 *
 * Following manually keeps the allow-list a property of every hop rather than
 * only of the first one. `allowList` is required: a caller that does not have
 * one has not established that the first hop is allowed either.
 */
async function fetchText(url, allowList) {
  if (!Array.isArray(allowList) || !allowList.length) {
    throw new Error('fetchText requires the reviewed-doc allow-list')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), getReviewedDocsFetchTimeoutMs())

  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current, {
        headers: {
          Accept: 'text/html,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8',
          'User-Agent': APP_USER_AGENT
        },
        redirect: 'manual',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`Fetch failed for ${current}: HTTP ${response.status} with no Location`)
        // Resolve relative to the hop we are on, so a bare path stays on the
        // host we already trusted and an absolute URL is judged on its own host.
        const next = new URL(location, current)
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          throw new Error(`Refusing to follow ${current} to a non-HTTP scheme`)
        }
        if (!isAllowedHost(next.hostname, allowList)) {
          throw new Error(`Refusing to follow ${current} to off-allow-list host ${next.hostname}`)
        }
        current = next.toString()
        continue
      }

      if (!response.ok) {
        throw new Error(`Fetch failed for ${current}: HTTP ${response.status}`)
      }

      return await response.text()
    }
    throw new Error(`Fetch failed for ${url}: more than ${MAX_REDIRECTS} redirects`)
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
          const robotsText = await fetchText(normalizedDiscoveryUrl, allowList)
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
      const xml = await fetchText(sitemapUrl, allowList)
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

/**
 * Replace URL-shaped guesses with what the pages actually say.
 *
 * A sitemap gives a URL and nothing else, so every discovered entry was titled
 * by Title-Casing its last path segment and summarised as "Approved page on
 * virtualflybrain.org at /docs/data/em/". Ranking ran on THOSE — enrichment
 * happened afterwards, on the three entries that had already won, so it only
 * ever changed what was displayed, never what was found. A page could not be
 * retrieved for anything its URL did not already say.
 *
 * Fetching is bounded and best-effort: a page that fails keeps its placeholder
 * entry rather than dropping out of the index.
 */
async function enrichIndexEntries(entries) {
  const enriched = entries.slice()
  let cursor = 0

  const worker = async () => {
    while (cursor < entries.length) {
      const index = cursor
      cursor += 1
      const entry = entries[index]
      if (!entry) continue

      try {
        const page = await loadReviewedPageData(entry.url)
        enriched[index] = {
          ...entry,
          title: page.title || entry.title,
          summary: page.summary || entry.summary,
          headings: page.headings || [],
          text: page.search_text || '',
          publishedAt: page.published_at || entry.publishedAt || null
        }
      } catch {
        // Keep the placeholder. A page we cannot read is still a page we are
        // allowed to link to.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_INDEX_ENRICH_CONCURRENCY, entries.length) }, worker)
  )

  return enriched
}

function startIndexEnrichment(cacheKey, entries) {
  if (dynamicIndexCache.enriching || entries.length === 0) return
  dynamicIndexCache.enriching = true

  enrichIndexEntries(entries)
    .then(enrichedEntries => {
      if (dynamicIndexCache.key !== cacheKey) return
      dynamicIndexCache.entries = enrichedEntries
    })
    .catch(() => {
      // The placeholder index stays in place.
    })
    .finally(() => {
      dynamicIndexCache.enriching = false
    })
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
    entries,
    enriching: false
  }

  // Enrichment is ~96 page fetches. Doing it inline would make the first
  // question after a cold start wait for all of them, so it runs behind the
  // placeholder index and swaps itself in when it is ready: early questions
  // rank on less, they do not hang. One run at a time, and only if this cache
  // generation is still the current one when it finishes.
  startIndexEnrichment(cacheKey, entries)

  return entries
}

// --- the site's own search index -------------------------------------------
//
// virtualflybrain.org/search/ is a client-side palette over /index.json — one
// record per page with the title, description, section (docs, blog, about,
// hosted), a pinned flag and the body text the site's own search ranks on. It
// is rebuilt with every site build, so it is never behind the sitemap, and one
// fetch of it gives the chat what the sitemap crawl below spends ~96 page
// fetches to approximate — which on a cold start it had not yet done, so early
// questions ranked on URL slugs. Terms are not in this file (the site queries
// Solr for those, and the chat already resolves terms through the MCP).

let siteIndexCache = { key: '', loadedAt: 0, entries: [] }

/**
 * Read the site index into entries. Exported for tests; pure.
 * @param {Array} records  the parsed /index.json
 * @param {string} baseUrl  the site the relative urls belong to
 * @param {string[]} allowList
 */
export function parseSiteIndex(records, baseUrl, allowList) {
  if (!Array.isArray(records)) return []
  const out = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    let absolute = ''
    try { absolute = new URL(ensureString(record.url), baseUrl).toString() } catch { continue }
    if (!isIndexableReviewedUrl(absolute, allowList)) continue
    const section = collapseWhitespace(ensureString(record.section)).toLowerCase()
    const entry = createEntryFromUrl(absolute, {
      title: record.title,
      summary: record.desc || record.description,
      // The body is HTML-escaped twice in the file (&amp;rsquo;); two passes.
      text: collapseWhitespace(collapseWhitespace(ensureString(record.body))).slice(0, MAX_INDEX_TEXT_CHARS),
      keywords: [section, record.pinned ? 'pinned' : ''].filter(Boolean)
    })
    if (!entry) continue
    entry.section = section
    entry.pinned = Boolean(record.pinned)
    out.push(entry)
  }
  return out
}

async function loadSiteIndex() {
  const url = getReviewedDocsSiteIndexUrl()
  const allowList = getSearchAllowList()
  if (!url) return []
  const cacheKey = `${url}::${allowList.join('|')}`
  if (
    siteIndexCache.key === cacheKey
    && siteIndexCache.loadedAt > 0
    && (Date.now() - siteIndexCache.loadedAt) < getReviewedDocsCacheTtlMs()
  ) {
    return siteIndexCache.entries
  }
  let entries = []
  try {
    let host = ''
    try { host = new URL(url).hostname } catch { host = '' }
    if (host && isAllowedHost(host, allowList)) {
      const text = await fetchText(url, allowList)
      entries = parseSiteIndex(JSON.parse(text), url, allowList)
    }
  } catch {
    // The site index is an accelerator, not a dependency: the seed file and
    // the sitemap crawl still serve. A failed fetch is retried next period.
    entries = siteIndexCache.key === cacheKey ? siteIndexCache.entries : []
  }
  siteIndexCache = { key: cacheKey, loadedAt: Date.now(), entries }
  return entries
}

function combineIndexes(seedEntries, dynamicEntries, siteEntries = []) {
  const merged = new Map()

  // The site index is the floor: real titles, descriptions and body text for
  // every page from the first question. A crawled entry for the same page is
  // preferred once it has been enriched (its text is the whole article), and
  // until then merges over it field by field, so a placeholder never erases
  // what the site index already said.
  for (const entry of siteEntries) {
    if (!entry) continue
    merged.set(entry.url, entry)
  }

  for (const entry of dynamicEntries) {
    if (!entry) continue
    const fromSite = merged.get(entry.url)
    // An enriched crawl entry (it has the article text) outranks the site
    // record; a placeholder (URL-derived title, no text) does not.
    merged.set(entry.url, entry.text ? mergeEntries(entry, fromSite) : mergeEntries(fromSite, entry))
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
  const headings = Array.isArray(entry.headings)
    ? entry.headings.map(heading => ensureString(heading).toLowerCase()).join(' \n ')
    : ''
  const text = ensureString(entry.text).toLowerCase()

  return {
    title,
    summary,
    pathname,
    domain,
    keywords,
    headings,
    text,
    haystack: [title, summary, pathname, domain, ...keywords, headings, text].join(' ')
  }
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

/**
 * How much of the question an entry actually covers, weighted by how much each
 * word matters — the share of the query's IDF mass this entry matches at all.
 *
 * Field weights alone let one word in a title outrank a page that answers the
 * whole question. "How do I report a problem or contribute data to VFB?" ranked
 * /reports first: it carries "report" in its title AND its path, which is worth
 * more than everything /about/contactus scores across "report", "contribute"
 * and "data" together — and /reports has nothing to say about either of the
 * other two. The word is the same; the sense is not, and matching only one word
 * out of three is the signal that says so.
 *
 * This is the classic coordination factor, and it is deliberately applied at
 * full strength rather than softened: half-strength leaves the title bonus
 * winning, which is the behaviour being corrected.
 */
function coverage(matchedMass, totalMass) {
  return totalMass > 0 ? matchedMass / totalMass : 0
}

function scoreEntry(entry, tokens, weights = null, fields = null) {
  if (tokens.length === 0) return 0

  const f = fields || entryFields(entry)
  let score = 0
  let matchedMass = 0
  let totalMass = 0

  for (const token of tokens) {
    const weight = weights ? (weights.get(token) ?? 1) : 1
    totalMass += weight
    let raw = 0
    if (f.title.includes(token)) raw += 6
    if (f.pathname.includes(token)) raw += 4
    if (f.keywords.some(keyword => keyword.includes(token))) raw += 3
    if (f.summary.includes(token)) raw += 2
    if (f.headings.includes(token)) raw += 2
    // Body text is the weakest field on purpose — a passing mention should not
    // outrank a page that is ABOUT the word. It earns its keep through
    // coverage: matching a third word nowhere but the body still lifts the
    // whole score, because coverage multiplies.
    if (f.text.includes(token)) raw += 1
    if (f.haystack.includes(token)) raw += 1
    if (raw > 0) matchedMass += weight
    score += raw * weight
  }

  return score * coverage(matchedMass, totalMass)
}

// Longest first, so "contributions" loses "ions" rather than "s".
const INFLECTIONS = ['ations', 'ation', 'ings', 'ions', 'ing', 'ion', 'ies', 'ied', 'es', 'ed', 's', 'e']
const MIN_STEM_LENGTH = 4

/**
 * The shortest form of a token that still means the thing.
 *
 * Matching is substring-based, so a query token only has to be reduced to a
 * prefix the indexed word starts with — the index itself never needs stemming.
 * That is what makes this safe to do in one place.
 *
 * The question "how do I contribute data to VFB?" scored zero on the one page
 * that answers it, whose summary offers "bug reports, data contributions":
 * "contribute" is not a substring of "contributions", so the single most
 * discriminating word in the question counted for nothing and /reports won on
 * the word "report" alone. Stemming to "contribut" matches both.
 *
 * The floor is what keeps this from over-reaching: a stem must be at least four
 * characters, so "used" stays "used" rather than becoming "us" and matching
 * every page on the site. Suffixes are tried longest-first and the first
 * acceptable one wins, so "types" -> "type" (via "s", since "typ" is too short)
 * while "contributions" -> "contribut" (via "ions").
 */
function stemToken(token) {
  for (const suffix of INFLECTIONS) {
    if (token.length - suffix.length >= MIN_STEM_LENGTH && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

/**
 * Reviewed-doc entries that match `tokens`, best first. Exported so the ranking
 * can be tested without touching the index files or the network.
 */
export function rankEntries(entries, tokens) {
  const list = Array.isArray(entries) ? entries : []
  const fieldsList = list.map(entryFields)
  // Stem here rather than in tokenize(): this is the one place both the scorer
  // and the IDF weighting read the tokens, so they cannot drift apart.
  const stems = Array.from(new Set((tokens || []).map(stemToken)))
  const weights = tokenWeights(stems, fieldsList)

  return list
    .map((entry, index) => ({ entry, score: scoreEntry(entry, stems, weights, fieldsList[index]) }))
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

const HAS_LINK = /<a\s[^>]*href=/i

/**
 * Put an absolute link target next to its text, so a block whose whole point is
 * where to go keeps the where. Skipped when the text already contains the
 * target (a mailto whose link text IS the address), and skipped for in-page
 * anchors and site-relative links, which say nothing on their own.
 *
 * A URL is only inlined if the answer is allowed to SHOW it. The output
 * sanitiser rewrites any off-allow-list URL to "[External link removed]", so
 * handing the model the GitHub issue address produced "submit an issue on
 * GitHub at [External link removed]" — a worse answer than not offering the
 * address at all. Mailto is always kept: an email address is not a URL and the
 * sanitiser leaves it alone, and support@ / data@ are the useful half of that
 * page anyway.
 */
function inlineLinkTargets(html = '', allowList = getOutboundAllowList()) {
  return html.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (whole, href, label) => {
    const target = collapseWhitespace(href)
    const text = stripTags(label)
    const isMail = /^mailto:/i.test(target)
    if (!isMail && !/^https?:/i.test(target)) return whole
    if (!isMail && !isAllowedHost(normalizeHostCandidate(target), allowList)) return whole

    const shown = target.replace(/^mailto:/i, '')
    if (!text || text.includes(shown)) return whole
    return `${text} (${shown})`
  })
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
 * Tables are read a row at a time, cells joined with " | ". "Where can I access
 * the FAFB or FANC CATMAID datasets?" was unanswerable while <td> was dropped:
 * on /docs/data/em/ the words FAFB and FANC appear ONLY inside the comparison
 * table, so the page that answers the question contained, as far as this
 * extractor could tell, neither of the two things being asked about.
 *
 * <li> is read only inside an isolated main region. It was excluded outright
 * because a docs page carries 400-1300 list items and nearly all are menu
 * links — but that is a statement about the sidebar, not about lists, and once
 * the sidebar is gone the remaining items are the page's own content ("Datasets
 * Hosted by VFB" is a list). Where no main region can be found the old
 * conservative behaviour stands.
 */
export function extractContentBlocks(html, { skip = '' } = {}) {
  const blocks = []
  const seen = new Set()
  const region = extractMainRegion(html)
  const tags = region.isolated ? 'h1|h2|h3|p|pre|tr|li' : 'h1|h2|h3|p|pre|tr'

  for (const match of region.html.matchAll(new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi'))) {
    const tag = match[1].toLowerCase()
    const inner = match[2]
    // Code keeps its line breaks; prose gets collapsed to a single line, with
    // link targets pulled inline — "Report an issue" is not an answer, the
    // address behind it is. A table row is its cells, in order, so a row that
    // only means anything read across ("FAFB | brain | CATMAID | dense") stays
    // readable as one line.
    const text = tag === 'pre'
      ? normalizeBlockText(inner.replace(/<[^>]+>/g, ''))
      : tag === 'tr'
        ? [...inner.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
          .map(cell => stripTags(inlineLinkTargets(cell[2])))
          .filter(Boolean)
          .join(' | ')
        : stripTags(inlineLinkTargets(inner))

    // Prose is length-filtered to drop captions, labels and stray fragments.
    // A code block is short by nature — "pip install x" IS the answer — and so
    // is a block that carries a link: the whole answer to "how do I report a
    // problem?" was three <p> of under 40 characters, "GitHub Issues: Report
    // an issue" and "Private Email: data@virtualflybrain.org" among them, and
    // all three were thrown away for being short. What survived was the page's
    // feedback widget, so the answer became "please tell them how they can
    // improve".
    const short = tag === 'p' && text.length < 40 && !HAS_LINK.test(inner)
    if (!text || short) continue
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
  if (cached) {
    if ((Date.now() - cached.loadedAt) < getReviewedDocsCacheTtlMs()) return cached.value
    // Expired. Drop it rather than leaving it resident until the same URL is
    // asked for again — which, for most of a 2,500-URL index, is never.
    pageCache.delete(normalizedUrl)
  }

  const html = stripNonContentHtml(await fetchText(normalizedUrl, allowList))
  const pageUrl = new URL(normalizedUrl)
  const articleHtml = extractMainRegion(html).html

  const title = uniqueStrings([
    extractMetaContent(html, 'property', 'og:title'),
    extractMetaContent(html, 'name', 'twitter:title'),
    stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    ...extractTagTexts(articleHtml, 'h1', 1)
  ])[0] || buildGeneratedTitle(pageUrl)

  const headings = uniqueStrings([
    ...extractTagTexts(articleHtml, 'h1', 2),
    ...extractTagTexts(articleHtml, 'h2', MAX_PAGE_HEADINGS),
    ...extractTagTexts(articleHtml, 'h3', MAX_PAGE_HEADINGS)
  ]).slice(0, MAX_PAGE_HEADINGS)

  const paragraphs = extractTagTexts(articleHtml, 'p', 12)
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
    content,
    // Not part of the answer — this is what the index ranks on. Kept separate
    // from `content` because the two want opposite things: the answer wants the
    // readable blocks in order and short, the index wants every word.
    search_text: stripTags(articleHtml).slice(0, MAX_INDEX_TEXT_CHARS)
  }

  setPageCache(normalizedUrl, {
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
  const [dynamicEntries, siteEntries] = await Promise.all([loadDynamicIndex(), loadSiteIndex()])
  const combinedEntries = combineIndexes(seedEntries, dynamicEntries, siteEntries)

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
    source: 'reviewed_seed_plus_site_search_index_plus_sitemap',
    page_fetch_available: true,
    results: enrichedResults,
    total_found: ranked.length
  })
}

export async function getReviewedPage(url) {
  return JSON.stringify(await loadReviewedPageData(url))
}
