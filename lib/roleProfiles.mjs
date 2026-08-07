// Per-role model, sampling and reasoning configuration — the single source of
// truth for "which model, thinking on or off, at what temperature, with what
// budget" for every LLM call VFBchat makes.
//
// WHY THIS EXISTS
//
// v3.x sent every structured call at temperature 0 with no sampling controls and
// no way to reach vLLM's `chat_template_kwargs`. That was adequate for a single
// non-reasoning model. It is actively wrong for a reasoning model, where the
// same knob (`enable_thinking`) is the difference between a 6s planner that gets
// the question right and a 45s extractor that produces the identical answer it
// would have produced in 2s.
//
// The measured result behind this table (ADR 0003, evidence pack):
//   - Planner with thinking ON is the ONLY configuration that reads
//     "How many DA1 lPN neurons does VFB hold in each connectome dataset?"
//     as a count question rather than a connectivity question.
//   - Extraction and synthesis with thinking ON cost 24-73s and produce the
//     same content as thinking OFF.
// So: think in the planner, never in extract or synth. Reserve escalation for
// evidence of trouble, not prediction of it.
//
// MODEL-AWARENESS IS A SAFETY PROPERTY, NOT A NICETY
//
// `chat_template_kwargs.enable_thinking` and `top_k` are meaningful to Qwen and
// meaningless-to-harmful elsewhere: sending `enable_thinking` to the Llama 3.3
// Jinja template is an unknown-variable risk, not a no-op. Every emitter below
// is therefore gated on `supportsReasoning(model)`, so a fallback to Llama —
// whether by env override or by an operator pinning APPROVED_ELM_MODEL —
// degrades to plain v3.x behaviour instead of erroring.
//
// This module is PURE: no network, no imports from the request path. It is
// exercised directly by tests/unit/roleProfiles.test.mjs.

import { resolveRoleModel, modelCandidates, QWEN_MODEL, LLAMA_MODEL } from './structuredOutput.mjs'

export { QWEN_MODEL, LLAMA_MODEL }

/**
 * Does this model have a reasoning channel we can switch with
 * `chat_template_kwargs: { enable_thinking }`?
 *
 * Deliberately a name test rather than a hard-coded list: ELM's catalogue
 * changes under us, and a future Qwen 3.6 / 4 should inherit the behaviour
 * without a code change. Anything unrecognised is treated as NON-reasoning,
 * which is the safe direction — we simply omit the extra body fields.
 */
export function supportsReasoning(model = '') {
  return /\bqwen[-_.]?[3-9]/i.test(String(model))
}

/**
 * Per-role behaviour. Sampling values for the reasoning roles are Qwen's
 * published thinking preset (temp 0.6, top_p 0.95, top_k 20); the synth role
 * uses Qwen's published non-thinking preset (temp 0.7, top_p 0.8, top_k 20).
 * The model card is explicit that greedy decoding degrades this model and can
 * produce endless repetition, which is why no role that generates prose runs at
 * temperature 0.
 *
 * The two extraction roles DO run at temperature 0: they transcribe evidence
 * rather than compose it, determinism is worth more there than diversity, and
 * `validateAgainstSchema` + retry backstops any degenerate output.
 *
 * maxTokens matters more than it looks. A reasoning model spends the budget on
 * the reasoning channel FIRST; a planner call capped at 2,500 tokens returns
 * `content: null` having thought itself out of a reply. 16,384 is roughly
 * 4x the largest reasoning trace observed in the probes.
 *
 * TIMEOUT IS PER ATTEMPT; BUDGET IS PER CALL.
 *
 * `timeoutMs` bounds one HTTP attempt. It does NOT bound the call, because
 * callStructured retries up to three times and a timed-out attempt is
 * indistinguishable there from a fast failure — so a stalled gateway costs
 * 3 x timeoutMs, and on the planner that is 12 minutes for ONE of three parallel
 * votes, of which there can be two rounds. That is the 18-minute "Planning the
 * answer" that was actually observed in the wild.
 *
 * `budgetMs` is the wall clock for all attempts of one call together.
 * Deliberately larger than `timeoutMs` and smaller than `timeoutMs x
 * maxAttempts`: one full attempt still gets its whole ceiling, and what remains
 * funds the retries that are CHEAP (a 502, an unparseable reply, a schema miss)
 * and come back in seconds. Retrying those is the reason the loop exists;
 * re-asking a stalled gateway the identical question at full price is not.
 */
export const PROFILES = Object.freeze({
  // Reads the question and decides what to do. The one place thinking pays.
  planner: Object.freeze({
    think: true, temperature: 0.6, topP: 0.95, topK: 20,
    legacyTemperature: 0, timeoutMs: 240000, budgetMs: 300000, maxTokens: 16384
  }),
  // "Do we have enough to answer?" — a judgement call, made once per question.
  sufficiency: Object.freeze({
    think: true, temperature: 0.6, topP: 0.95, topK: 20,
    legacyTemperature: 0, timeoutMs: 240000, budgetMs: 300000, maxTokens: 16384
  }),
  // Pulls a claim + verbatim out of a tool result. Transcription, not thought.
  extract: Object.freeze({
    think: false, temperature: 0, topP: null, topK: null,
    legacyTemperature: 0, timeoutMs: 120000, budgetMs: 180000, maxTokens: 4096
  }),
  // Repairs malformed tool arguments against the tool's own JSON schema.
  args: Object.freeze({
    think: false, temperature: 0, topP: null, topK: null,
    legacyTemperature: 0, timeoutMs: 90000, budgetMs: 150000, maxTokens: 2048
  }),
  // Writes the user-visible answer, streamed. Thinking here is 34-73s of blank
  // pane for prose that measured no better, so it is off and stays off.
  // legacyTemperature null = send no temperature at all, which is exactly what
  // v3.x did on this path.
  synth: Object.freeze({
    think: false, temperature: 0.7, topP: 0.8, topK: 20,
    legacyTemperature: null, timeoutMs: 180000, budgetMs: 240000, maxTokens: 8192
  })
})

export const ROLES = Object.freeze(Object.keys(PROFILES))

/**
 * Map an orchestrator schemaName onto a role. The orchestrator names its
 * structured calls by schema (`plan`, `sufficiency`, `extract`,
 * `<tool>_args`), so this is the join between the call sites and this table
 * without touching any of them.
 */
export function roleForSchemaName(schemaName = '') {
  const s = String(schemaName || '')
  if (s === 'plan') return 'planner'
  if (s === 'sufficiency') return 'sufficiency'
  if (s === 'extract') return 'extract'
  if (/_args$/.test(s)) return 'args'
  return 'extract'
}

function envFlag(value) {
  if (value === undefined || value === null) return undefined
  const s = String(value).trim().toLowerCase()
  if (!s) return undefined
  if (['1', 'true', 'on', 'yes'].includes(s)) return true
  if (['0', 'false', 'off', 'no'].includes(s)) return false
  return undefined
}

function envNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Everything a call site needs for one role, resolved against env.
 *
 * @param {string} role  planner | sufficiency | extract | args | synth
 * @param {object} [o]
 * @param {object} [o.env=process.env]
 * @param {string|string[]} [o.fallback] model(s) to use when nothing is configured
 * @param {string} [o.model]     explicit model, wins over env resolution
 * @param {Set<string>} [o.available] models the gateway is serving; omit for
 *   "unknown", which does no filtering
 * @returns {{role,model,think,temperature,timeoutMs,budgetMs,maxTokens,extraBody}}
 *
 * `extraBody` is spread verbatim into the ELM request body by
 * `callStructured` / `streamSynthCompletion`. On a non-reasoning model it comes
 * back as an empty object, so the same call sites work unchanged against Llama.
 */
export function roleRequestOptions(role, o = {}) {
  const key = ROLES.includes(role) ? role : 'extract'
  const profile = PROFILES[key]
  const env = o.env || process.env
  const upper = key.toUpperCase()

  // `o.available` is the set of models the gateway is actually serving, passed
  // in by the request path (lib/modelCatalogue.mjs fetches it; this module stays
  // pure). Undefined means "unknown", which must not filter anything.
  const model = (typeof o.model === 'string' && o.model.trim())
    ? o.model.trim()
    : resolveRoleModel(key, env, o.fallback || QWEN_MODEL, { available: o.available })

  const reasoning = supportsReasoning(model)
  const thinkOverride = envFlag(env[`VFB_THINKING_${upper}`])
  const think = reasoning && (thinkOverride === undefined ? profile.think : thinkOverride)

  // The sampling presets above are Qwen's published ones, measured on Qwen. On
  // any other model they are an UNTESTED change, not a neutral default — the
  // planner would jump from v3.x's temperature 0 to 0.6 on a model nobody
  // measured there. So a non-reasoning model gets v3.x's sampling back, and this
  // module's promise of "degrades to plain v3.x behaviour" is true of the
  // temperature as well as of the body fields.
  //
  // This is not hypothetical: ELM_MODEL is set in the deployment environment and
  // outranks this module's default in resolveRoleModel, so a v4.0.0 rollout that
  // forgets to move ELM_MODEL lands here.
  const preset = reasoning
    ? profile.temperature
    : (profile.legacyTemperature === undefined ? profile.temperature : profile.legacyTemperature)
  const tempOverride = envNumber(env[`VFB_TEMPERATURE_${upper}`])
  let temperature = tempOverride === undefined ? preset : tempOverride
  // Qwen's own model card: "DO NOT use greedy decoding, as it can lead to
  // performance degradation and endless repetitions." That warning is about the
  // reasoning channel, so it binds only when thinking is actually on.
  if (think && temperature === 0) temperature = profile.temperature || 0.6

  const timeoutMs = envNumber(env[`VFB_TIMEOUT_${upper}`]) ?? profile.timeoutMs
  const budgetMs = envNumber(env[`VFB_BUDGET_${upper}`]) ?? profile.budgetMs
  const maxTokens = envNumber(env[`VFB_MAX_TOKENS_${upper}`]) ?? profile.maxTokens

  const extraBody = {}
  if (reasoning) {
    // Emitted in BOTH directions on purpose. vLLM's Qwen template defaults
    // thinking ON, so "off" must be stated; and stating "on" explicitly means a
    // future default flip upstream cannot silently change planner behaviour.
    extraBody.chat_template_kwargs = { enable_thinking: think }
    if (typeof profile.topP === 'number') extraBody.top_p = profile.topP
    if (typeof profile.topK === 'number') extraBody.top_k = profile.topK
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) extraBody.max_tokens = maxTokens

  // `sampling` is the whole request-shaping payload for call sites that build
  // their own body (the synth stream in route.js), with a non-numeric
  // temperature dropped rather than sent as `null` — vLLM rejects that, and it
  // is exactly what the synth role resolves to on a non-reasoning model.
  const sampling = { ...extraBody }
  if (typeof temperature === 'number') sampling.temperature = temperature

  return { role: key, model, think, temperature, timeoutMs, budgetMs, maxTokens, extraBody, sampling }
}

/**
 * Retrospective escalation policy for the planner.
 *
 * VFBchat already samples the planner k times and majority-votes; v3.x then
 * discarded the agreement score. Agreement is the one complexity signal we have
 * that costs nothing extra and is measured AFTER seeing the question rather than
 * guessed before it — the probe found it drops to 0.67 on exactly the questions
 * where the plan is contested (W1.B, W2.B, W4.C, W9.1) and sits at 1.00 on the
 * ones that are not.
 *
 * So: when the votes disagree, buy more votes and re-decide over the combined
 * pool. One round only — if 6 samples cannot agree, a 7th is not the fix, and
 * the sufficiency loop downstream is a better place to recover.
 */
export const PLANNER_ESCALATION = Object.freeze({
  minAgreement: 0.67,
  extraVotes: 3,
  maxRounds: 1,
  // Wall clock for the WHOLE planning phase, both rounds together. Sized from
  // the measurement: a healthy contested plan resolves round one in ~78s and the
  // escalation round in ~180s, so 420s leaves ordinary escalation completely
  // untouched and bites only when the gateway is stalling. When it does bite,
  // the plurality plan from round one is used — which is the plan v3.x would
  // have used anyway, having thrown the agreement score away.
  phaseBudgetMs: 420000,
  // Below this there is not enough clock left for a sampling round to return
  // anything but aborts, so the round is skipped rather than started.
  minRoundMs: 20000
})

/**
 * What model will every role ACTUALLY use, and is that the one this version was
 * measured on?
 *
 * This exists because of the specific way v4.0.0 could have gone wrong. The
 * deployment sets ELM_MODEL, which outranks the shipped default, so a rollout
 * that forgot to update it would have kept running Llama — and nothing would
 * have said so. The app would still answer; it would just answer worse, with a
 * planner that no longer reads "how many X in each dataset?" as a count. A bug
 * you cannot see is worse than a bug that breaks the build.
 *
 * Model LISTS remove the outage half of that problem (a dead name now falls
 * through to the next candidate). They deliberately do NOT remove this half:
 * if an operator names only Llama, we run Llama, because silently overriding
 * configuration is the same class of defect being fixed here. So the answer is
 * not to override it — it is to say so, out loud, at startup.
 *
 * Pure: takes the catalogue, returns a report. The caller decides how to log it.
 *
 * @returns {{roles: Array, warnings: string[]}}
 */
export function describeRoleModels(o = {}) {
  const env = o.env || process.env
  const available = o.available
  const expected = o.expected || QWEN_MODEL

  const roles = ROLES.map(role => {
    const opts = roleRequestOptions(role, { env, available, fallback: o.fallback })
    const candidates = modelCandidates(role, env, o.fallback || QWEN_MODEL)
    const skipped = (available && available.size)
      ? candidates.slice(0, candidates.indexOf(opts.model)).filter(c => !available.has(c))
      : []
    return {
      role,
      model: opts.model,
      think: opts.think,
      temperature: opts.temperature,
      reasoning: supportsReasoning(opts.model),
      candidates,
      skipped
    }
  })

  const warnings = []
  const offProfile = roles.filter(r => r.model !== expected)
  if (offProfile.length) {
    const detail = offProfile.map(r => `${r.role}=${r.model}`).join(', ')
    warnings.push(
      `Model resolution is off the measured profile (${detail}). This build was measured on ${expected}; ` +
      'roles on another model fall back to v3.x sampling and lose the reasoning planner. ' +
      'Check ELM_MODEL / APPROVED_ELM_MODEL / VFB_MODEL_* — a model list may name it first.'
    )
  }
  const dead = roles.flatMap(r => r.skipped)
  if (dead.length) {
    warnings.push(`Skipped models the gateway is not serving: ${[...new Set(dead)].join(', ')}.`)
  }
  if (!available || !available.size) {
    warnings.push('Gateway model catalogue is unknown; model lists resolve to their first entry unfiltered.')
  }
  return { roles, warnings }
}

export const __TEST__ = { envFlag, envNumber }
