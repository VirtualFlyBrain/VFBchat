// The backtick is excluded for the same reason as the quote and the bracket: it
// delimits, it is never part of a URL. Without it, `https://vfb3-mcp.virtualflybrain.org`
// matched WITH its closing backtick, the trailing character was carried into the
// hostname, and an allow-listed host was rewritten to "[External link removed]"
// purely because the answer had put it in inline code — which is exactly how a
// service address gets written when the answer is telling someone to copy it.
const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]`]+/gi
const HOST_REGEX = /\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/gi
const SEARCH_INTENT_REGEX = /\b(search|browse|look\s+up|lookup|find|open|visit|check|documentation|docs?|website|site|web\s?page|page)\b/i

function stripTrailingPunctuation(value) {
  return value.replace(/[),.;:!?]+$/, '')
}

// Generic TLDs a user might plausibly type. Two-letter labels are accepted as
// country codes without being listed, which is what keeps this short.
const KNOWN_GTLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro',
  'aero', 'coop', 'museum', 'jobs', 'mobi', 'travel', 'xxx', 'asia', 'cat', 'tel',
  'app', 'dev', 'page', 'site', 'online', 'tech', 'space', 'store', 'blog', 'wiki',
  'cloud', 'digital', 'network', 'science', 'academy', 'institute', 'university',
  'systems', 'software', 'tools', 'today', 'news', 'health', 'bio', 'life', 'ltd',
  'group', 'team', 'zone', 'world', 'live', 'media', 'press', 'email', 'link'
])

// Extensions people actually type at this service. A collision with a country
// code is resolved in favour of the extension: `.md`, `.sh`, `.is`, `.it`, `.io`
// and friends are far more often a file here than a domain, and the cost of
// being wrong is only that a domain is not treated as explicitly requested.
const FILE_EXTENSIONS = new Set([
  'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'txt', 'md', 'rst', 'log', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'tif', 'tiff', 'webp', 'ico',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'rar', '7z',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'ipynb', 'sh', 'bash', 'zsh', 'rb',
  'java', 'c', 'h', 'cpp', 'hpp', 'rs', 'go', 'php', 'sql', 'css', 'scss', 'html', 'htm',
  'nrrd', 'swc', 'obj', 'stl', 'ply', 'nwb', 'h5', 'hdf5', 'mat', 'npy', 'npz',
  'owl', 'obo', 'ttl', 'rdf', 'nt', 'exe', 'dll', 'so', 'dmg', 'pkg', 'bak', 'tmp'
])

/**
 * Is this bare (scheme-less) dotted token plausibly a hostname?
 *
 * Exported so the audit's own example cases can be asserted directly rather than
 * only through the extractor that uses it.
 */
export function looksLikeHostname(hostname) {
  if (!hostname || !hostname.includes('.')) return false
  const labels = hostname.split('.')
  const tld = labels[labels.length - 1]
  if (!tld || FILE_EXTENSIONS.has(tld)) return false
  return tld.length === 2 || KNOWN_GTLDS.has(tld)
}

export function normalizeHostCandidate(value) {
  if (!value) return null

  let candidate = stripTrailingPunctuation(value.trim().toLowerCase())
  if (!candidate) return null
  if (candidate.startsWith('mailto:')) return null
  if (candidate.includes('@') && !candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    return null
  }

  try {
    const url = candidate.startsWith('http://') || candidate.startsWith('https://')
      ? new URL(candidate)
      : new URL(`https://${candidate}`)
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')

    if (!hostname || !hostname.includes('.')) return null

    // A token the user wrote with an explicit scheme is a URL and is taken at
    // its word — including odd or new TLDs, which is what the scheme is for. A
    // bare token has to look like a hostname before we treat it as one.
    const hadScheme = candidate.startsWith('http://') || candidate.startsWith('https://')
    if (!hadScheme && !looksLikeHostname(hostname)) return null

    return hostname
  } catch {
    return null
  }
}

export function extractExplicitDomains(text = '') {
  const domains = new Set()

  for (const match of text.matchAll(URL_REGEX)) {
    const hostname = normalizeHostCandidate(match[0])
    if (hostname) domains.add(hostname)
  }

  for (const match of text.matchAll(HOST_REGEX)) {
    const hostname = normalizeHostCandidate(match[0])
    if (hostname) domains.add(hostname)
  }

  return Array.from(domains).sort()
}

export function isAllowedHost(hostname, allowList) {
  const normalizedHost = normalizeHostCandidate(hostname)
  if (!normalizedHost) return false

  return allowList.some(entry => {
    const normalizedEntry = entry.trim().toLowerCase()
    if (!normalizedEntry) return false

    if (normalizedEntry.startsWith('*.')) {
      const suffix = normalizedEntry.slice(2)
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)
    }

    return normalizedHost === normalizedEntry
  })
}

export function requestMentionsSearchIntent(text = '') {
  return SEARCH_INTENT_REGEX.test(text)
}

export function findBlockedRequestedDomains(text, allowList) {
  return extractExplicitDomains(text).filter(hostname => !isAllowedHost(hostname, allowList))
}

function withPlaceholders(text, regex, replaceMatch) {
  const placeholders = []
  const placeholderPrefix = '\u0000PLACEHOLDER'

  const replaced = text.replace(regex, (...args) => {
    const replacement = replaceMatch(...args)
    placeholders.push(replacement)
    return `${placeholderPrefix}${placeholders.length - 1}\u0000`
  })

  const restored = replaced.replace(new RegExp(`${placeholderPrefix}(\\d+)\\u0000`, 'g'), (_, index) => placeholders[Number(index)])
  return restored
}

export function sanitizeAssistantOutput(text, allowList) {
  const blockedDomains = new Set()

  const replaceUrl = (url, allowedValue, blockedValue) => {
    const hostname = normalizeHostCandidate(url)
    if (!hostname || isAllowedHost(hostname, allowList)) {
      return allowedValue
    }

    blockedDomains.add(hostname)
    return blockedValue
  }

  let sanitized = withPlaceholders(
    text,
    /!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (match, altText, target) => {
      const url = target.trim().split(/\s+/)[0]
      return replaceUrl(
        url,
        match,
        altText ? `[Image removed: ${altText}]` : '[Image removed from an unapproved domain]'
      )
    }
  )

  sanitized = withPlaceholders(
    sanitized,
    /(?<!!)\[([^\]]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (match, label, target) => {
      const url = target.trim().split(/\s+/)[0]
      return replaceUrl(
        url,
        match,
        label || '[External link removed]'
      )
    }
  )

  sanitized = sanitized.replace(URL_REGEX, (match) => {
    const cleanMatch = stripTrailingPunctuation(match)
    const trailing = match.slice(cleanMatch.length)

    return `${replaceUrl(cleanMatch, cleanMatch, '[External link removed]')}${trailing}`
  })

  return {
    sanitizedText: sanitized,
    blockedDomains: Array.from(blockedDomains).sort()
  }
}

export function countCitationLinks(text = '') {
  const citationDomains = [
    'doi.org',
    'pubmed.ncbi.nlm.nih.gov',
    'flybase.org',
    'biorxiv.org',
    'medrxiv.org'
  ]

  let count = 0
  for (const match of text.matchAll(URL_REGEX)) {
    const hostname = normalizeHostCandidate(match[0])
    if (hostname && citationDomains.includes(hostname)) {
      count += 1
    }
  }

  return count
}

export function extractVfbTermIds(text = '', limit = 10) {
  const matches = text.match(/\b(?:VFB|FBbt)_\d{8}\b/g) || []
  return Array.from(new Set(matches)).slice(0, limit)
}

// --- structured URLs -------------------------------------------------------
//
// sanitizeAssistantOutput reads PROSE. It is the last thing to touch the answer
// text and it catches every link and image the model wrote. It cannot catch the
// URLs that never appear in prose: image thumbnails and row links harvested from
// structured tool output and attached to the result event as data. Those went to
// the reader's browser — as <img src> — without ever meeting the allow-list the
// governance pack says every outbound address meets.
//
// In practice the thumbnails come from VFB's own MCP and are virtualflybrain.org
// addresses, so nothing has escaped. That is a property of today's upstream, not
// a control: the same field would carry whatever a compromised or misconfigured
// upstream put in it, and the reader's browser would fetch it. The boundary is
// only complete if the structured path meets the same list.

/** The fields on an image or table row that carry a fetchable address. */
export const STRUCTURED_URL_FIELDS = [
  'url', 'thumbnail', 'thumbnail_transparent', 'thumbnailT',
  'nrrd', 'wlz', 'obj', 'swc', 'reportUrl', 'href'
]

/**
 * May this structured value be handed to the reader's browser?
 *
 * Stricter than the prose sanitiser, deliberately. Prose is written by a model
 * and full of things that merely look like addresses, so there the benefit of
 * the doubt goes to the text. A thumbnail field has exactly one legitimate
 * shape — an http(s) URL, or a same-origin absolute path — so anything else
 * (protocol-relative "//host/x", data:, javascript:, a bare hostname) is not
 * given the benefit of the doubt.
 */
export function isAllowedStructuredUrl(value, allowList) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return true                       // nothing to fetch
  if (/^\/(?!\/)/.test(raw)) return true      // same-origin absolute path
  if (!/^https?:\/\//i.test(raw)) return false
  const hostname = normalizeHostCandidate(raw)
  return hostname ? isAllowedHost(hostname, allowList) : false
}

/**
 * Images whose every address is on the list, and the hosts of those dropped.
 *
 * An image is dropped WHOLE when any one of its addresses fails. An image card
 * with an allowed thumbnail and an off-list mesh is still a channel to an
 * off-list host, and there is nothing worth salvaging in half a card.
 */
export function filterStructuredImages(images, allowList) {
  const blockedDomains = new Set()
  const kept = []
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || typeof image !== 'object') continue
    let allowed = true
    for (const field of STRUCTURED_URL_FIELDS) {
      const value = image[field]
      if (value == null || value === '') continue
      if (isAllowedStructuredUrl(value, allowList)) continue
      allowed = false
      const hostname = normalizeHostCandidate(String(value))
      if (hostname) blockedDomains.add(hostname)
    }
    if (allowed) kept.push(image)
  }
  return { images: kept, blockedDomains: Array.from(blockedDomains).sort() }
}

/**
 * Table rows with off-list addresses removed FIELD BY FIELD, and the hosts
 * dropped.
 *
 * Unlike an image, a result row is mostly not a URL: it is a name, an id and
 * some tags that answer the question. Dropping the row to remove a bad
 * thumbnail would delete evidence to enforce a link policy. Dropping the field
 * leaves the row readable and the boundary intact.
 */
export function scrubStructuredTables(tables, allowList) {
  const blockedDomains = new Set()
  const scrubField = (row) => {
    let changed = false
    const out = { ...row }
    for (const field of STRUCTURED_URL_FIELDS) {
      const value = out[field]
      if (value == null || value === '') continue
      if (isAllowedStructuredUrl(value, allowList)) continue
      const hostname = normalizeHostCandidate(String(value))
      if (hostname) blockedDomains.add(hostname)
      delete out[field]
      changed = true
    }
    return changed ? out : row
  }
  const scrubbed = (Array.isArray(tables) ? tables : []).map(table => {
    if (!table || typeof table !== 'object' || !Array.isArray(table.rows)) return table
    return { ...table, rows: table.rows.map(row => (row && typeof row === 'object') ? scrubField(row) : row) }
  })
  return { tables: scrubbed, blockedDomains: Array.from(blockedDomains).sort() }
}
