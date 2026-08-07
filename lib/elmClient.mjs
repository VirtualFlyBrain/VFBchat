// Thin ELM client for schema-constrained generation used by harness roles.
//
// Wraps POST {baseUrl}/chat/completions with response_format json_schema, then
// validates + retries on non-conformance, with optional self-consistency voting.
// Network layer is deliberately thin; all decision logic lives in
// structuredOutput.mjs so it can be unit-tested offline. The API key is never
// logged.

import {
  buildSchemaResponseFormat,
  extractFirstJson,
  validateAgainstSchema,
  majorityVote
} from './structuredOutput.mjs'

const CHAT_COMPLETIONS = '/chat/completions'

/**
 * The least time worth giving a retry. Below this the attempt can only end in
 * another abort, so spending it buys a slower failure and nothing else.
 */
export const MIN_RETRY_MS = 5000

/**
 * One schema-constrained generation with validate-and-retry.
 *
 * @param {object} o
 * @param {string} o.baseUrl   ELM base, e.g. https://elm.edina.ac.uk/api/v1
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {Array}  o.messages  OpenAI chat messages
 * @param {object} o.schema    JSON schema for the output
 * @param {string} [o.schemaName]
 * @param {number} [o.maxAttempts=3]
 * @param {number} [o.timeoutMs=60000]   ceiling for ONE attempt
 * @param {number} [o.budgetMs]          ceiling for ALL attempts together
 * @param {number} [o.temperature]
 * @param {boolean}[o.useGuidedJson=false]  vLLM fallback (local Llama only)
 * @param {object} [o.extraBody]            merged into the request body verbatim
 * @param {function}[o.fetchImpl=fetch]     injectable for testing
 * @returns {Promise<{ok:boolean, value?:any, attempts:number, error?:string, raw?:string}>}
 */
export async function callStructured(o) {
  const {
    baseUrl, apiKey, model, messages, schema,
    schemaName = 'result', maxAttempts = 3, timeoutMs = 60000,
    temperature, useGuidedJson = false, extraBody = null, fetchImpl = fetch,
    now = Date.now
  } = o
  if (!baseUrl || !model || !Array.isArray(messages) || !schema) {
    return { ok: false, attempts: 0, error: 'baseUrl, model, messages, schema are required' }
  }

  // `timeoutMs` bounds ONE attempt; without a second bound the retry loop
  // multiplies it. That is not theoretical: the planner runs at 240000ms x 3
  // attempts, and an attempt that ABORTS on the timeout is indistinguishable
  // here from an attempt that failed fast — postJson catches AbortError and
  // returns {ok:false,status:0} — so a gateway that has simply stalled is asked
  // the identical question twice more at full price. 12 minutes, for one of
  // three parallel votes, of which there may be two rounds.
  //
  // The fix is a wall clock rather than "do not retry timeouts", because retries
  // after a FAST failure (a 502, an unparseable reply, a schema miss) are cheap
  // and are the reason this loop exists. So: keep retrying, but only inside a
  // total budget, and never hand an attempt more time than the budget has left.
  // Default preserves the historical worst case exactly, so this is inert until
  // a caller opts in.
  const budgetMs = Number.isFinite(o.budgetMs) && o.budgetMs > 0
    ? o.budgetMs
    : timeoutMs * Math.max(1, maxAttempts)
  const startedAt = now()
  const remainingMs = () => budgetMs - (now() - startedAt)

  let convo = messages
  let lastErr = 'no attempt made'
  let lastRaw

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const left = remainingMs()
    if (attempt > 1 && left < MIN_RETRY_MS) {
      return { ok: false, attempts: attempt - 1, error: `${lastErr} (budget ${budgetMs}ms exhausted)`, raw: lastRaw, budgetExhausted: true }
    }
    const attemptTimeoutMs = Math.max(MIN_RETRY_MS, Math.min(timeoutMs, left))
    const body = {
      model,
      messages: convo,
      stream: false
    }
    if (useGuidedJson) {
      // vLLM guided decoding: constrains output to the schema without the strict
      // json_schema compliance rules (all-required + additionalProperties:false),
      // so it accepts ordinary tool-parameter schemas. Use json_object to keep
      // the reply a JSON object.
      body.guided_json = schema
      body.response_format = { type: 'json_object' }
    } else {
      body.response_format = buildSchemaResponseFormat(schemaName, schema)
    }
    if (typeof temperature === 'number') body.temperature = temperature
    if (extraBody && typeof extraBody === 'object') Object.assign(body, extraBody)

    const res = await postJson(`${baseUrl.replace(/\/$/, '')}${CHAT_COMPLETIONS}`, body, apiKey, attemptTimeoutMs, fetchImpl)
    if (!res.ok) { lastErr = `HTTP ${res.status}`; lastRaw = res.text; continue }

    const content = pickContent(res.text)
    lastRaw = content ?? res.text
    const value = extractFirstJson(content ?? '')
    if (value === undefined) { lastErr = 'no JSON in response'; convo = withCorrection(convo, content, 'Your reply was not valid JSON. Return only the JSON object.'); continue }

    const { valid, errors } = validateAgainstSchema(value, schema)
    if (valid) return { ok: true, value, attempts: attempt, raw: lastRaw }

    lastErr = `schema validation failed: ${errors.slice(0, 3).join('; ')}`
    convo = withCorrection(convo, content, `Your JSON did not match the schema (${errors.slice(0, 3).join('; ')}). Return corrected JSON only.`)
  }

  return { ok: false, attempts: maxAttempts, error: lastErr, raw: lastRaw }
}

/**
 * Self-consistency: run callStructured k times and majority-vote the result.
 * Use for high-leverage steps (planner, pivotal extraction). Free, since ELM
 * usage is currently unpaid.
 * @returns {{ok:boolean, value?:any, agreement?:number, votes:number, results:Array}}
 */
export async function callStructuredVoted(o) {
  const k = Math.max(1, o.k || 3)
  const runs = await Promise.all(Array.from({ length: k }, () => callStructured(o)))
  const values = runs.filter(r => r.ok).map(r => r.value)
  if (values.length === 0) {
    return { ok: false, votes: 0, results: runs, error: runs[0]?.error || 'all attempts failed' }
  }
  const vote = majorityVote(values, o.voteKeyFn)
  return { ok: true, value: vote.value, agreement: vote.agreement, votes: values.length, results: runs }
}

// ---- internals ----

async function postJson(url, body, apiKey, timeoutMs, fetchImpl) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (err) {
    return { ok: false, status: 0, text: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

function pickContent(text) {
  try { return JSON.parse(text)?.choices?.[0]?.message?.content ?? null } catch { return null }
}

function withCorrection(convo, assistantText, instruction) {
  const next = convo.slice()
  if (assistantText) next.push({ role: 'assistant', content: assistantText })
  next.push({ role: 'user', content: instruction })
  return next
}
