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

const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct'

/**
 * Resolve the model for a named role from env, with sensible fallbacks.
 * Role "planner" → VFB_MODEL_PLANNER, then VFB_MODEL_DEFAULT, then
 * ELM_MODEL / OPENAI_MODEL, then the hard default. Keeps the local-only build
 * working out of the box while allowing a per-role override later.
 */
export function resolveRoleModel(role, env = process.env, fallback = DEFAULT_MODEL) {
  const key = `VFB_MODEL_${String(role || '').toUpperCase()}`
  const candidates = [
    env[key],
    env.VFB_MODEL_DEFAULT,
    env.ELM_MODEL,
    env.OPENAI_MODEL,
    env.APPROVED_ELM_MODEL,
    fallback
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return DEFAULT_MODEL
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
