// Planner (pure) — one structured call that turns a user question into a typed
// plan the deterministic controller executes. Replaces the in-loop tool-policy
// guesswork. The plan is advisory DATA for the controller (validated against
// guardrails), not instructions another agent executes. See design report §4.3.
//
// The network call uses callStructured() from elmClient.mjs with PLAN_SCHEMA;
// everything here (schema, prompt, normalisation, fast-path) is offline-testable.

export const INTENTS = [
  'term_info', 'taxonomy', 'connectivity', 'region_connections', 'neuron_profile',
  'genetic_tools', 'pathway', 'comparison', 'neuron_count', 'containment',
  'documentation', 'literature', 'other'
]

// Strict json_schema (works with ELM response_format / guided_json). All
// properties required + additionalProperties:false per strict-mode rules.
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'underspecified', 'clarifying_question', 'terms_to_resolve', 'steps'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    underspecified: { type: 'boolean' },
    clarifying_question: { type: 'string' },
    terms_to_resolve: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'tool', 'answers'],
        properties: {
          id: { type: 'string' },
          tool: { type: 'string' },
          answers: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

const PLANNER_SYSTEM = `You are the planner for a Virtual Fly Brain (VFB) assistant.
Turn the user's question into a JSON plan. Do NOT answer the question.
- intent: the single best category from the allowed list.
- underspecified: true only if you genuinely cannot proceed without a clarifying detail; then put one short clarifying_question (else empty string).
- terms_to_resolve: anatomy / neuron / gene names mentioned that need resolving to VFB ids (use the user's natural-language names, not ids).
- steps: the minimal ordered tool calls needed. Each step has an id (s1, s2, …), one tool name from the catalogue, and "answers" — the specific sub-questions that step must satisfy. Prefer one macro tool over chaining primitives. Keep the plan as short as possible.
VFB-FIRST: for "what is / function of / where is / what is known about X" questions, use vfb_get_term_info — its Description and Relationships (e.g. capable_of, is_part_of, synaptic regions) usually answer function/anatomy/containment directly. Use specialised tools (connectivity, neurotransmitter, taxonomy, genetic tools) only for their specific purpose. Do NOT plan a literature/PubMed step: papers are a last resort the controller adds only if VFB data and the available queries cannot answer.
Output JSON only, matching the schema.`

/** Build planner messages: system + question + compact tool catalogue. */
export function buildPlannerMessages(question, toolCatalogue = []) {
  const catalogue = (toolCatalogue || [])
    .map(t => `- ${t.name}: ${t.purpose || t.description || ''}`.trim())
    .join('\n')
  return [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: `QUESTION:\n${question}\n\nTOOL CATALOGUE:\n${catalogue}\n\nReturn the plan as JSON.` }
  ]
}

/** Coerce a raw planner output into a safe, normalised plan. */
export function normalizePlan(raw = {}) {
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'other'
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s, i) => ({
    id: (s && s.id) ? String(s.id) : `s${i + 1}`,
    tool: (s && s.tool) ? String(s.tool) : '',
    answers: Array.isArray(s?.answers) ? s.answers.map(String).filter(Boolean) : []
  })).filter(s => s.tool)
  // de-duplicate step ids
  const seen = new Set()
  steps.forEach((s, i) => { if (seen.has(s.id)) s.id = `s${i + 1}`; seen.add(s.id) })
  return {
    intent,
    underspecified: Boolean(raw.underspecified),
    clarifying_question: raw.underspecified ? String(raw.clarifying_question || '') : '',
    terms_to_resolve: Array.isArray(raw.terms_to_resolve) ? raw.terms_to_resolve.map(String).filter(Boolean) : [],
    steps
  }
}

/**
 * Cheap deterministic fast-path: a single-term factual lookup doesn't need a
 * full planner call. Returns a minimal plan, or null if the planner should run.
 * Conservative — only fires on clearly simple single-subject questions.
 */
export function detectFastPath(question = '') {
  const q = String(question).trim()
  if (!q) return null
  // Multi-step / comparative / connectivity cues → not a fast path.
  if (/\b(connect|connectivity|upstream|downstream|between|compare|pathway|trace|reciprocal|converge|vs\.?|versus|and the|both)\b/i.test(q)) return null
  // Function/evidence or tool-specific cues need a specific role, not the generic lookup.
  if (/\b(function|role|mechanism|evidence|neurotransmitter|transmitter|express|expression|driver|gal4|split|stock|publication|paper|how many|count|input|output|similar|morpholog)\b/i.test(q)) return null
  // Simple "what is / what are X" or "what NT does X use" single-subject lookups.
  if (/^(what (is|are)\b|which\b|where (is|are)\b)/i.test(q) && q.length < 120) {
    return {
      intent: 'term_info',
      underspecified: false,
      clarifying_question: '',
      terms_to_resolve: [],
      steps: [{ id: 's1', tool: 'vfb_search_terms', answers: [q] }]
    }
  }
  return null
}
