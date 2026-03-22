const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]]+/gi
const HOST_REGEX = /\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/gi
const SEARCH_INTENT_REGEX = /\b(search|browse|look\s+up|lookup|find|open|visit|check|documentation|docs?|website|site|web\s?page|page)\b/i

function stripTrailingPunctuation(value) {
  return value.replace(/[),.;:!?]+$/, '')
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
