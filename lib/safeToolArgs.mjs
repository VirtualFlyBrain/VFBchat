// Tool arguments, rendered for a container log without the user's question in them.
//
// The privacy notice, and `route.js`'s own comment at the end of every request
// ("No user text and no tool payloads are logged"), both promise this. It has
// been broken three times. The first two were fixed at the call site; this one
// arrived through a different path: `startDocSearch` passes the WHOLE user
// question as `search_reviewed_docs`'s `query`, on every non-underspecified
// turn, and the tool-failure handler logged `JSON.stringify(args)` with no gate.
// One reviewed-docs network blip therefore wrote the question verbatim to
// stdout — which goes to the cluster log aggregator, outside the 0600 file mode
// in governance.js and outside the 30-day pruneRetention.
//
// So the shape is logged and the values are not, unless VFB_HARNESS_TRACE=true.
// Ids, query types and counts are safe and are the ones worth having: they are
// what tells you which call failed. Anything free-text is replaced by its
// length, which is enough to tell an empty arg from a long one.

// Argument names whose values are drawn from VFB's own vocabulary, not from the
// user's prose, and are therefore safe to print.
const SAFE_KEYS = new Set([
  'id', 'ids', 'query_type', 'query_types', 'limit', 'offset', 'max_results',
  'direction', 'weight', 'template', 'dataset', 'short_form', 'neuron_type',
  'upstream_type', 'downstream_type', 'endpoint_type', 'include_images',
  'force_refresh', 'relationship', 'gene', 'genes'
])

// No whitespace. An id, a query type and a template name have none; a sentence
// does. A safe KEY carrying a sentence is still a sentence — "the neuron I was
// looking at earlier" arriving as `id` is the user's prose, not an identifier.
const SAFE_VALUE_RE = /^[\w.,:/-]{0,80}$/

/**
 * A free-text value rendered for a container log: its length, not its content.
 *
 * safeToolArgs solved this for tool ARGUMENTS. The same rule applies to every
 * other free-text value a diagnostic wants to print, and those arrived
 * separately and were not covered: the term name in the term-info failure
 * report, and the verbatim absence sentence in the escalation and gate lines.
 * A term name is often the user's own phrase, and an absence sentence is prose
 * the model wrote by restating the question — "VFB does not currently hold data
 * on the line from Kyoto that labels PAM neurons" puts the question in the
 * cluster log aggregator, outside governance.js's 0600 file mode and outside
 * the 30-day pruneRetention.
 *
 * Under VFB_HARNESS_TRACE the value is printed in full, exactly as safeToolArgs
 * does, so the diagnostic loses nothing when someone is actually debugging.
 */
export function safeText(value, { trace = process.env.VFB_HARNESS_TRACE === 'true', max = 200 } = {}) {
  const s = value === null || value === undefined ? '' : String(value)
  if (trace) return s.slice(0, max)
  return `<text:${s.length}>`
}

/**
 * A one-line, log-safe rendering of a tool's arguments.
 * `{ query: 'does the mutant line from Kyoto label PAM neurons?', max_results: 5 }`
 * becomes `{query:<text:52>, max_results:5}`.
 */
export function safeToolArgs(args, { trace = process.env.VFB_HARNESS_TRACE === 'true' } = {}) {
  if (trace) {
    try { return JSON.stringify(args).slice(0, 400) } catch { return '<unserialisable>' }
  }
  if (!args || typeof args !== 'object') return '{}'
  const parts = []
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) { parts.push(`${k}:null`); continue }
    if (typeof v === 'number' || typeof v === 'boolean') { parts.push(`${k}:${v}`); continue }
    if (Array.isArray(v)) { parts.push(`${k}:[${v.length}]`); continue }
    if (typeof v === 'object') { parts.push(`${k}:{…}`); continue }
    const s = String(v)
    if (SAFE_KEYS.has(k) && SAFE_VALUE_RE.test(s)) { parts.push(`${k}:${s}`); continue }
    parts.push(`${k}:<text:${s.length}>`)
  }
  return `{${parts.join(', ')}}`
}
