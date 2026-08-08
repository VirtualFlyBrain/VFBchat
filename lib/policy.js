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
