// Structured-output foundation for the role-based harness.
//
// Pure helpers (no network) so they are unit-testable offline:
//   - resolveRoleModel:     per-role model selection (VFB_MODEL_<ROLE> → ELM_MODEL → fallback)
//   - buildSchemaResponseFormat: OpenAI-style strict json_schema response_format
//   - extractFirstJson:     robust JSON recovery from a model reply (belt-and-braces)
//   - validateAgainstSchema: minimal JSON-schema validator for the subset we use
//   - majorityVote:         self-consistency vote over k generations
//
// ELM's strict constrained decoding is the primary guarantee (probed working on
// the local Llama backend); validation + retry + voting are the fallback layer.
// See outputs/reports/vfbchat-harness-design.md §9 and ADR 0001.

// Model identifiers live here, at the bottom of the dependency graph, so
// roleProfiles.mjs and runtimeConfig.js share one definition rather than three
// copies of a string that must never drift apart.
//
// v4.0.0 moved the default from Llama 3.3 70B to Qwen 3.5 397B-A17B. Both are
// locally hosted by ELM (`owned_by: elm`); the MoE architecture means the 397B
// model activates ~17B parameters per token, so it answers at roughly Llama's
// speed and is measurably FASTER on long inputs. See ADR 0003.
export const QWEN_MODEL = 'Qwen/Qwen3.5-397B-A17B-FP8'
export const LLAMA_MODEL = 'meta-llama/Llama-3.3-70B-Instruct'

const DEFAULT_MODEL = QWEN_MODEL

/**
 * Parse a model env var into a preference-ordered list.
 *
 * v4.0.0 made every model variable a LIST rather than a single name. A single
 * value is simply a one-element list, so `ELM_MODEL=meta-llama/Llama-3.3-70B-Instruct`
 * keeps behaving exactly as it did in v3.x and no deployment has to change to
 * keep working.
 *
 * Why a list at all: a pinned name is a single point of failure in two
 * directions at once. Forwards, a stale value silently downgrades the app — the
 * deployment's ELM_MODEL outranks this module's default, so a v4 rollout that
 * forgot to move it would quietly keep running Llama. Backwards, ELM's
 * catalogue changes under us (Qwen 3.5 only appeared there recently), so the
 * day a name is retired every single request 404s. A list survives both.
 *
 * Separators are comma or newline so the value can be written inline in a
 * compose file or as a multi-line secret. Order is preserved and duplicates are
 * dropped, because the order IS the preference.
 */
export function parseModelList(value) {
  const out = []
  const push = (v) => {
    if (Array.isArray(v)) { v.forEach(push); return }
    if (typeof v !== 'string') return
    for (const part of v.split(/[,\n]/)) {
      const s = part.trim()
      if (s && !out.includes(s)) out.push(s)
    }
  }
  push(value)
  return out
}

/**
 * The full preference-ordered candidate list for a role.
 *
 * The v3.x chain was "first source that is set wins, and that is the answer".
 * That is fine until the winning source names a model the gateway no longer
 * serves, at which point there is no answer at all. Here the chain is FLATTENED
 * instead: every source contributes its models in precedence order to one
 * deduped list, so a dead first choice falls through to the next rather than
 * taking the service down with it.
 *
 * When nothing is filtered out (the catalogue is unknown, or every candidate is
 * live) the head of this list is exactly what v3.x would have returned.
 */
export function modelCandidates(role, env = process.env, fallback = DEFAULT_MODEL) {
  const key = `VFB_MODEL_${String(role || '').toUpperCase()}`
  return parseModelList([
    env[key],
    env.VFB_MODEL_DEFAULT,
    env.ELM_MODEL,
    env.OPENAI_MODEL,
    env.APPROVED_ELM_MODEL,
    fallback,
    DEFAULT_MODEL
  ])
}

/**
 * Resolve the model for a named role from env, with sensible fallbacks.
 *
 * @param {string} role
 * @param {object} [env=process.env]
 * @param {string|string[]} [fallback]
 * @param {object} [o]
 * @param {Set<string>|null} [o.available]  models the gateway is actually
 *   serving. Injected rather than fetched — this module stays pure and
 *   synchronous. `null`/`undefined`/empty means "unknown", and unknown must
 *   NEVER filter: a flaky /v1/models probe is not a reason to change which
 *   model answers the question.
 *
 * If the catalogue is known and NONE of the candidates are in it, we return the
 * first candidate anyway. Inventing a model nobody configured would be worse
 * than letting the request fail with the gateway's own error message, which at
 * least names the model that is missing.
 */
export function resolveRoleModel(role, env = process.env, fallback = DEFAULT_MODEL, o = {}) {
  const candidates = modelCandidates(role, env, fallback)
  const available = o && o.available
  if (available && typeof available.has === 'function' && available.size > 0) {
    const live = candidates.find(c => available.has(c))
    if (live) return live
  }
  return candidates[0] || DEFAULT_MODEL
}

/** Build the OpenAI-compatible strict json_schema response_format block. */
export function buildSchemaResponseFormat(name, schema) {
  if (!name || typeof name !== 'string') throw new Error('schema name required')
  if (!schema || typeof schema !== 'object') throw new Error('schema object required')
  return { type: 'json_schema', json_schema: { name, strict: true, schema } }
}

/**
 * Recover the first complete JSON value from text. Tries a direct parse first,
 * then scans for the first balanced {...} or [...] (string/escape aware).
 * Returns the parsed value or undefined.
 */
export function extractFirstJson(text = '') {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  // Strip a leading ```json fence if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : trimmed
  try { return JSON.parse(body) } catch { /* fall through */ }

  const start = body.search(/[{[]/)
  if (start === -1) return undefined
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        const slice = body.slice(start, i + 1)
        try { return JSON.parse(slice) } catch { return undefined }
      }
    }
  }
  return undefined
}

/**
 * Minimal validator for the JSON-schema subset the harness uses:
 * type (object/array/string/number/integer/boolean/null), properties, required,
 * additionalProperties:false, enum, items, oneOf. Returns { valid, errors }.
 * Not a full JSON-schema implementation — a guard, not a spec engine.
 */
export function validateAgainstSchema(value, schema, path = '$') {
  const errors = []
  walk(value, schema, path, errors)
  return { valid: errors.length === 0, errors }
}

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v // object, string, number, boolean
}

function walk(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return

  if (Array.isArray(schema.oneOf)) {
    const ok = schema.oneOf.some(s => validateAgainstSchema(value, s, path).valid)
    if (!ok) errors.push(`${path}: does not match any oneOf option`)
    return
  }

  if (schema.type) {
    const t = typeOf(value)
    const want = schema.type
    const numericOk = want === 'number' && t === 'number'
    const intOk = want === 'integer' && t === 'number' && Number.isInteger(value)
    if (want !== t && !numericOk && !intOk) {
      errors.push(`${path}: expected ${want}, got ${t}`)
      return
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(e => e === value)) {
    errors.push(`${path}: value not in enum`)
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {}
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}.${req}: required property missing`)
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${path}.${k}: additional property not allowed`)
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) walk(value[k], sub, `${path}.${k}`, errors)
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors))
  }
}

/**
 * Self-consistency vote over k generations. Groups by a canonical key
 * (default: stable JSON stringify) and returns the most common value.
 * Ties resolve to the earliest-seen value. Returns
 * { value, count, total, agreement }.
 */
export function majorityVote(values, keyFn = canonicalKey) {
  const list = (values || []).filter(v => v !== undefined && v !== null)
  if (list.length === 0) return { value: undefined, count: 0, total: 0, agreement: 0 }
  const buckets = new Map()
  for (const v of list) {
    const k = keyFn(v)
    if (!buckets.has(k)) buckets.set(k, { value: v, count: 0 })
    buckets.get(k).count++
  }
  let best = null
  for (const b of buckets.values()) {
    if (!best || b.count > best.count) best = b
  }
  return { value: best.value, count: best.count, total: list.length, agreement: best.count / list.length }
}

/** Stable stringify (sorted keys) so equal objects hash equally for voting. */
export function canonicalKey(v) {
  return JSON.stringify(sortKeys(v))
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc }, {})
  }
  return v
}

export const __DEFAULT_MODEL = DEFAULT_MODEL
