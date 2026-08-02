// Recovering from a failed VFB query, without telling the model it can.
//
// VFBquery signals "this query did not run" by returning count -1 with an empty
// rows array, and it does so over HTTP 200. The cache in front of it therefore
// treats the failure as a perfectly good answer and can serve it for months.
// Two consequences follow, and this module handles both:
//
//   1. A -1 must never reach the model looking like an empty result. "count: 0,
//      rows: []" and "count: -1, rows: []" are one character apart and mean
//      opposite things — no matching rows, versus we have no idea. Left
//      unannotated, the model reports "there are none", which is a confident
//      wrong answer rather than a visible failure.
//
//   2. The retry that fixes it needs X-Force-Refresh, which is expensive: it
//      makes the upstream recompute. So it is a capped internal recovery, NOT a
//      tool parameter. Deliberately, force_refresh appears nowhere in the tool
//      schemas the model sees: a model that can ask for a cache bypass will ask
//      for one whenever an answer merely looks surprising, and the cost lands on
//      a shared service. The retry happens here, once, or it does not happen.
//
// The annotation is belt-and-braces with the MCP's own count_status handling: a
// deployment may point at an older MCP that still returns a bare -1, and this
// is the layer that stops that reaching the user as "no results".

/** At most this many forced re-runs per chat request, whatever goes wrong. */
export const DEFAULT_FORCE_REFRESH_BUDGET = 2

export const RUN_QUERY_FAILED_NOTE =
  'QUERY FAILED: the VFB query service returned an error indication (count -1) rather than a result set. ' +
  'This is NOT an empty result. It does NOT mean there are no matching rows, and it must never be reported ' +
  'as "0", "none" or "no results". Tell the user this VFB query is temporarily unavailable and offer the ' +
  'query link, rather than answering from memory or implying the data does not exist.'

function parsePayload(text) {
  if (text && typeof text === 'object') return text
  if (typeof text !== 'string') return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Did this payload come back as an upstream failure rather than a result set?
 *
 * Only a negative count qualifies. count 0 is a genuine empty result — VFBquery
 * returns it both for a real empty set and for a 400 Bad Request — and treating
 * it as a failure would burn the retry budget on queries that are working fine.
 */
export function isFailedRunQueryPayload(text) {
  const parsed = parsePayload(text)
  if (!parsed) return false
  if (parsed.count_status === 'unavailable') return true
  const count = Number(parsed.count)
  return Number.isFinite(count) && count < 0
}

/**
 * Add the failure explanation to a payload, leaving any existing note in place.
 * Returns the text unchanged if it is not a recognisable failed payload, so this
 * is safe to call on anything.
 */
export function annotateFailedRunQuery(text) {
  const parsed = parsePayload(text)
  if (!parsed || !isFailedRunQueryPayload(parsed)) return text

  const existing = typeof parsed._note === 'string' ? parsed._note.trim() : ''
  if (existing.includes(RUN_QUERY_FAILED_NOTE)) return text

  return JSON.stringify({
    ...parsed,
    count_status: 'unavailable',
    _note: existing ? `${existing} ${RUN_QUERY_FAILED_NOTE}` : RUN_QUERY_FAILED_NOTE
  })
}

/** Stable identity for a call, so the same failing call is only retried once. */
export function forceRefreshKey(toolName, args = {}) {
  const stable = Object.keys(args)
    .filter(key => key !== 'force_refresh')
    .sort()
    .map(key => `${key}=${JSON.stringify(args[key])}`)
    .join('&')
  return `${toolName}|${stable}`
}

/**
 * A per-request allowance for forced re-runs. Two limits, both needed: the same
 * call is never forced twice (a query that fails twice is down, not stale), and
 * a request that fails in many different ways still cannot stampede the
 * upstream with recomputes.
 */
export function createForceRefreshBudget(max = DEFAULT_FORCE_REFRESH_BUDGET) {
  const spent = new Set()
  let remaining = Math.max(0, Number.isFinite(Number(max)) ? Number(max) : 0)

  return {
    get remaining() { return remaining },
    tryConsume(key) {
      if (remaining <= 0 || spent.has(key)) return false
      spent.add(key)
      remaining -= 1
      return true
    }
  }
}
