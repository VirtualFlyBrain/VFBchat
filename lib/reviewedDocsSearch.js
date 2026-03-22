import fs from 'fs'

import { isAllowedHost, normalizeHostCandidate } from './policy.js'
import { getReviewedDocsIndexFile, getSearchAllowList } from './runtimeConfig.js'

let cachedFile = null
let cachedIndex = []

function loadIndex() {
  const indexFile = getReviewedDocsIndexFile()
  if (cachedFile === indexFile) {
    return cachedIndex
  }

  try {
    const raw = fs.readFileSync(indexFile, 'utf8')
    const parsed = JSON.parse(raw)
    const allowList = getSearchAllowList()

    cachedIndex = Array.isArray(parsed)
      ? parsed
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => {
          const hostname = normalizeHostCandidate(entry.url || '')
          return {
            id: String(entry.id || ''),
            title: String(entry.title || ''),
            url: String(entry.url || ''),
            domain: hostname || String(entry.domain || ''),
            summary: String(entry.summary || ''),
            keywords: Array.isArray(entry.keywords) ? entry.keywords.map(item => String(item)) : []
          }
        })
        .filter(entry => entry.id && entry.title && entry.url && entry.domain && isAllowedHost(entry.domain, allowList))
      : []
  } catch {
    cachedIndex = []
  }

  cachedFile = indexFile
  return cachedIndex
}

function tokenize(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map(token => token.trim())
    .filter(token => token.length > 1)
}

function scoreEntry(entry, tokens) {
  if (tokens.length === 0) return 0

  const haystack = [
    entry.title,
    entry.summary,
    entry.domain,
    ...(entry.keywords || [])
  ].join(' ').toLowerCase()

  let score = 0
  for (const token of tokens) {
    if (entry.title.toLowerCase().includes(token)) score += 5
    if ((entry.keywords || []).some(keyword => keyword.toLowerCase().includes(token))) score += 3
    if (haystack.includes(token)) score += 1
  }

  return score
}

export function searchReviewedDocs(query, maxResults = 5) {
  const index = loadIndex()
  const cappedResults = Math.min(Math.max(Number(maxResults) || 5, 1), 10)
  const tokens = tokenize(query || '')

  const ranked = index
    .map(entry => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))

  return JSON.stringify({
    source: 'reviewed_local_index',
    results: ranked.slice(0, cappedResults).map(({ entry }) => ({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      domain: entry.domain,
      summary: entry.summary
    })),
    total_found: ranked.length
  })
}
