// Planner (pure) — one structured call that turns a user question into a typed
// plan the deterministic controller executes. Replaces the in-loop tool-policy
// guesswork. The plan is advisory DATA for the controller (validated against
// guardrails), not instructions another agent executes. See design report §4.3.
//
// The network call uses callStructured() from elmClient.mjs with PLAN_SCHEMA;
// everything here (schema, prompt, normalisation, fast-path) is offline-testable.

import { plannerGuidance } from './guidanceCards.mjs'

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
- underspecified: true only if you genuinely cannot proceed without a clarifying detail; then put one short clarifying_question (else empty string). If the question uses a pronoun or back-reference ("it", "they", "them", "those", "these", "that one") that clearly points to an entity named in PRIOR CONVERSATION, resolve it from there — do NOT mark underspecified or ask which entity.
- terms_to_resolve: anatomy / neuron / gene names mentioned that need resolving to VFB ids (use the user's natural-language names, not ids). When the current question refers back to an entity by pronoun, put that entity's full name here (taken from the prior conversation), not the pronoun.
- steps: the minimal ordered tool calls needed. Each step has an id (s1, s2, …), one tool name from the catalogue, and "answers" — the specific sub-questions that step must satisfy. Prefer one macro tool over chaining primitives. Keep the plan as short as possible.
VFB-FIRST: for "what is / function of / where is / what is known about X" questions, use vfb_get_term_info — its Description and Relationships (e.g. capable_of, is_part_of, synaptic regions) usually answer function/anatomy/containment directly. Use specialised tools (connectivity, neurotransmitter, taxonomy, genetic tools) only for their specific purpose. Do NOT plan a literature/PubMed step: papers are a last resort the controller adds only if VFB data and the available queries cannot answer.
Output JSON only, matching the schema.`

/** Build planner messages: system + (prior conversation) + question + tool catalogue. */
export function buildPlannerMessages(question, toolCatalogue = [], history = []) {
  const catalogue = (toolCatalogue || [])
    .map(t => `- ${t.name}: ${t.purpose || t.description || ''}`.trim())
    .join('\n')
  // Prior turns let the planner resolve pronouns/back-references to the entity the
  // user already named, instead of asking which entity they mean.
  const historyBlock = Array.isArray(history) && history.length
    ? `PRIOR CONVERSATION (resolve pronouns/back-references from this; do not invent facts):\n${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000)}\n\n`
    : ''
  // Intent-scoped guidance: only the cards whose matcher fires for THIS question
  // are injected, so the prompt stays short and on-point instead of carrying every
  // domain rule at once.
  const cards = plannerGuidance(question)
  const guidanceBlock = cards ? `\n\nGUIDANCE FOR THIS QUESTION:\n${cards}` : ''
  return [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: `${historyBlock}QUESTION:\n${question}\n\nTOOL CATALOGUE:\n${catalogue}${guidanceBlock}\n\nReturn the plan as JSON.` }
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
  // Simple "what is / what are X" single-subject lookups. Resolve the subject and
  // mine vfb_get_term_info (Description + Relationships) — far richer than a thin
  // search_terms list, which rarely contains the actual answer.
  const m = q.match(/^what (?:is|are)\s+(?:the\s+)?(.+?)\??$/i)
  const subject = m ? cleanSubject(m[1]) : ''
  // A bare pronoun/back-reference ("what are they?") names no entity on its own —
  // it must reach the history-aware planner, not fast-path "they" into a search.
  if (/^(it|they|them|those|these|that|this|one|ones)$/i.test(subject)) return null
  if (subject && q.length < 120) {
    return {
      intent: 'term_info',
      underspecified: false,
      clarifying_question: '',
      terms_to_resolve: [subject],
      steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: [q], args: { id: `$term:${subject}` } }]
    }
  }
  // "which / where is X" still benefit from a resolved lookup but are less regular;
  // fall through to the planner for those.
  return null
}

/** Trim a captured subject phrase to a clean term name for resolution. */
function cleanSubject(s = '') {
  return String(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                                      // strip "[label](url)" markdown
    // "(major) subdivisions/parts/components of (the) X" -> "X" (resolve the entity,
    // not the descriptor — "major subdivisions of the mushroom body" -> "mushroom body").
    .replace(/^\s*(?:the\s+)?(?:major|minor|main|principal|key)?\s*(?:subdivisions?|sub-?parts?|parts?|components?|sub-?components?|substructures?|structures?|divisions?|sections?|segments?|subregions?)\s+of\s+(?:the\s+)?/i, '')
    // drop species/common-name qualifiers (the WORD only — keep the entity after it).
    .replace(/\b(?:drosophila|melanogaster|fruit\s*fly|fruitfly|flies|fly)\b/ig, '')
    // drop a trailing scope qualifier like "in the adult brain / CNS".
    .replace(/\bin\s+(?:the\s+)?(?:adult|larval|embryonic)?\s*(?:brain|cns|nervous system)\b.*$/i, '')
    .replace(/[?.!,;:]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
