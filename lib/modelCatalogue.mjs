// What is the ELM gateway ACTUALLY serving right now?
//
// WHY THIS EXISTS
//
// v3.x pinned one model name in one env var and hoped. That is a single point
// of failure in two directions at once:
//
//   1. Forwards. The deployment's ELM_MODEL outranks the shipped default, so a
//      release that changes the default model silently does nothing unless a
//      human remembers to change the env too. This is not hypothetical — it is
//      exactly the trap found while wiring v4.0.0, and the failure mode was
//      *invisible*: the app kept answering, just on the old model, at sampling
//      settings nobody had measured there.
//   2. Backwards. ELM's catalogue moves. Qwen 3.5 only appeared on it recently;
//      anything that appears can also be retired or renamed. A pinned name that
//      vanishes is not a degradation, it is a total outage — every request 404s.
//
// v4.0.0 makes every model variable a preference-ordered LIST (see
// structuredOutput.parseModelList) and this module supplies the other half:
// which of those candidates the gateway is really serving, so resolution can
// skip the dead ones.
//
// FAIL OPEN, ALWAYS
//
// The catalogue is an OPTIMISATION, never a gate. If the probe fails, times
// out, or has never run, the snapshot is `null` and resolution does no
// filtering at all — i.e. it behaves exactly as v3.x did. A flaky /v1/models
// endpoint must never be able to change which model answers a question, and
// must certainly never be able to take the service down. Every error path here
// therefore ends in "keep the last good snapshot and carry on".

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5000

let snapshot = null        // Set<string> | null  — null means "unknown"
let snapshotAt = 0
let lastError = null
let lastAttemptAt = 0
let inflight = null

/**
 * The last good catalogue, readable synchronously.
 *
 * Synchronous on purpose: model resolution happens deep inside a pure, sync
 * call path (roleProfiles.roleRequestOptions). Making that async to await a
 * cache lookup would be a large change to buy nothing — the refresh is
 * background work, and a request that races it simply uses the previous
 * snapshot, which is the correct answer approximately always.
 */
export function servedModelsSnapshot() {
  return snapshot
}

/** Age/health of the snapshot, for the startup log and the debug payload. */
export function catalogueStatus(now = Date.now()) {
  return {
    known: snapshot !== null,
    count: snapshot ? snapshot.size : 0,
    ageMs: snapshot === null ? null : Math.max(0, now - snapshotAt),
    lastError,
    lastAttemptAt: lastAttemptAt || null
  }
}

function parseCatalogue(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : null
  if (!rows) return null
  const ids = new Set()
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row?.id
    if (typeof id === 'string' && id.trim()) ids.add(id.trim())
  }
  // An empty catalogue is indistinguishable from a broken one at this layer,
  // and "the gateway serves nothing" would filter every candidate away. Treat
  // it as unknown so we fail open rather than resolving against an empty set.
  return ids.size ? ids : null
}

/**
 * Refresh the snapshot from `GET {baseUrl}/models`.
 *
 * Never throws. Returns the snapshot (possibly the previous one, possibly
 * null). Concurrent callers share one in-flight request; callers inside the TTL
 * get the cached value without touching the network.
 */
export async function refreshServedModels(o = {}) {
  const now = typeof o.now === 'function' ? o.now : Date.now
  const ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : DEFAULT_TTL_MS
  const t = now()

  if (!o.force && snapshot !== null && (t - snapshotAt) < ttlMs) return snapshot
  // Do not hammer a gateway that is failing: a failed attempt also starts the
  // clock, so an outage costs one probe per TTL rather than one per request.
  if (!o.force && snapshot === null && lastAttemptAt && (t - lastAttemptAt) < ttlMs) return snapshot
  if (inflight) return inflight

  const baseUrl = String(o.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) return snapshot

  const fetchImpl = o.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') return snapshot

  lastAttemptAt = t
  inflight = (async () => {
    const controller = new AbortController()
    const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = { accept: 'application/json' }
      if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`
      const res = await fetchImpl(`${baseUrl}/models`, { headers, signal: controller.signal })
      if (!res || !res.ok) throw new Error(`models probe HTTP ${res ? res.status : 'no response'}`)
      const parsed = parseCatalogue(await res.json())
      if (!parsed) throw new Error('models probe returned no usable ids')
      snapshot = parsed
      snapshotAt = now()
      lastError = null
    } catch (err) {
      // Keep the previous snapshot. A transient probe failure is not evidence
      // that a model went away.
      lastError = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err)
    } finally {
      clearTimeout(timer)
      inflight = null
    }
    return snapshot
  })()

  return inflight
}

/**
 * Fire-and-forget refresh for the request path.
 *
 * The caller wants the CURRENT snapshot synchronously and does not want to pay
 * for the probe; the probe only has to be finished in time for some LATER
 * request. Returns the snapshot as it stands right now.
 */
export function primeServedModels(o = {}) {
  try {
    const pending = refreshServedModels(o)
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  } catch { /* priming is best-effort by definition */ }
  return snapshot
}

/** Test seam: reset all module state. */
export function __resetModelCatalogue() {
  snapshot = null
  snapshotAt = 0
  lastError = null
  lastAttemptAt = 0
  inflight = null
}

/** Test seam: install a known catalogue without touching the network. */
export function __setServedModels(ids, now = Date.now()) {
  snapshot = ids === null ? null : new Set(ids)
  snapshotAt = now
  lastError = null
}
