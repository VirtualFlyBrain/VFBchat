// Planner (pure) — one structured call that turns a user question into a typed
// plan the deterministic controller executes. Replaces the in-loop tool-policy
// guesswork. The plan is advisory DATA for the controller (validated against
// guardrails), not instructions another agent executes. See design report §4.3.
//
// The network call uses callStructured() from elmClient.mjs with PLAN_SCHEMA;
// everything here (schema, prompt, normalisation, fast-path) is offline-testable.

import { plannerGuidance } from './guidanceCards.mjs'
import { stripMarkdownLinks } from './markdownLinks.mjs'
import { contextPromptBlock } from './conversationContext.mjs'

// "What datasets are available?" / "list the datasets" — a request to enumerate
// VFB's datasets (plural). Deliberately requires the PLURAL so a specific
// "what's in the FAFB dataset" doesn't match.
const DATASETS_INTENT = /\b(what|which|list|show|available|all)\b[\s\S]{0,40}\bdata\s?sets\b|\bdata\s?sets\b[\s\S]{0,40}\b(available|are there|exist|do you have|does vfb|in vfb|on vfb)\b/i

// …but "datasets" is not always the SUBJECT. In "list every individual neuron
// across all datasets" it is a SCOPE, and DATASETS_INTENT matched it anyway on
// "list … datasets" — so the question about DA1 lPN neurons was answered, in
// three seconds, with the full list of VFB datasets and then a denial that VFB
// holds any DA1 lPN individuals. It holds 45 in FAFB alone.
//
// Two vetoes, either one enough. A dataset phrase governed by a preposition is a
// scope ("across all datasets", "in each dataset", "per connectome dataset"); and
// a question that also names a specific subject — a quoted name, a VFB id, a
// "neuron type" — is asking about that subject, whatever else it mentions.
const DATASET_SCOPE_RE = /\b(?:across|within|in|from|for|per|by|throughout|between|among)\s+(?:all\s+|each\s+|every\s+|the\s+|both\s+|these\s+|those\s+|any\s+)*(?:connectome\s+|em\s+)?data\s?sets?\b/i
const NAMED_SUBJECT_RE = /'[^']{2,}'|"[^"]{2,}"|\bVFB_[0-9a-z]+\b|\bFBbt_\d+\b|\b(?:neuron|cell|gene|transgene|region|body|lineage)\s+types?\b/i
// AllDatasets run against any template returns the full dataset list; the template
// is just an anchor. JRC2018Unisex (the default adult-brain template) is fine.
const ALL_DATASETS_TEMPLATE = 'VFB_00101567'

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
- underspecified: true only if you genuinely cannot proceed without a clarifying detail; then put one short clarifying_question (else empty string). If the question uses a pronoun or back-reference ("it", "they", "them", "those", "these", "that one") that clearly points to an entity named in PRIOR CONVERSATION, resolve it from there — do NOT mark underspecified or ask which entity. A broad question about a named subject is NOT underspecified: "how do I use X", "what was in the latest release", "what is X for" are answerable as asked, and VFB documentation can be read for them. Never ask which "aspect", "part" or "details" of a subject the user wants — answer broadly instead. Ask only when you cannot tell WHICH ENTITY is meant.
- terms_to_resolve: anatomy / neuron / gene names mentioned that need resolving to VFB ids (use the user's natural-language names, not ids). When the current question refers back to an entity by pronoun, put that entity's full name here (taken from the prior conversation), not the pronoun.
- steps: the minimal ordered tool calls needed. Each step has an id (s1, s2, …), one tool name from the catalogue, and "answers" — the specific sub-questions that step must satisfy. Prefer one macro tool over chaining primitives. Keep the plan as short as possible.
VFB-FIRST: for "what is / function of / where is / what is known about X" questions, use vfb_get_term_info — its Description and Relationships (e.g. capable_of, is_part_of, synaptic regions) usually answer function/anatomy/containment directly. Use specialised tools (connectivity, neurotransmitter, taxonomy, genetic tools) only for their specific purpose. Do NOT plan a literature/PubMed step: papers are a last resort the controller adds only if VFB data and the available queries cannot answer.
Output JSON only, matching the schema.`

/** Build planner messages: system + (resolved context) + (prior conversation) + question + tool catalogue. */
export function buildPlannerMessages(question, toolCatalogue = [], history = [], context = null) {
  const catalogue = (toolCatalogue || [])
    .map(t => `- ${t.name}: ${t.purpose || t.description || ''}`.trim())
    .join('\n')
  // What the conversation has already RESOLVED, as ids rather than as prose.
  // This sits above the history deliberately: the history is where the planner
  // guesses what the user meant, and this is where it does not have to. It is
  // also the half that survives the 2000-char slice below, which the ids the
  // conversation depends on previously did not.
  const resolvedBlock = contextPromptBlock(context)
  const contextBlock = resolvedBlock ? `${resolvedBlock}\n\n` : ''
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
    { role: 'user', content: `${contextBlock}${historyBlock}QUESTION:\n${question}\n\nTOOL CATALOGUE:\n${catalogue}${guidanceBlock}\n\nReturn the plan as JSON.` }
  ]
}

// A clarifying question that only asks WHICH ASPECT of an already-named subject
// the user wants. It is not a clarification: the planner has nothing concrete it
// is missing, so there is nothing the user could say that it could not have
// worked out itself.
//
// This is what "How do I use the Virtual Fly Brain MCP tool?" and "What was
// included in the latest Virtual Fly Brain release?" both came back with — "What
// specific aspect … do you need help with?" — and it cost more than one turn:
// underspecified also suppresses the concurrent documentation search, so the two
// questions that most obviously have a documentation answer were the two that
// never went looking for one. Asked the same way, "How do I use the 3D Viewer on
// the VFB website?" reads the docs and answers in full.
//
// Deliberately anchored and narrow. A clarification that names what is MISSING —
// "Which neuron do you mean?", "Which dataset?" — is a real question about an
// entity the planner cannot pick, and passes through untouched. That is why the
// noun list below names facets of the QUESTION and never an entity: the veto
// turns on "what kind of problem", not on "what kind of neuron".
const STALL_NOUN = '(?:aspects?|parts?|areas?|topics?|details?|information|info|problems?|issues?|data|help|support|feedback|contributions?)'

// "What specific type of problem or data are you trying to report?" — the D5
// form, and the same stall wearing a different noun. The earlier version only
// knew "kinds? of" followed by four fixed words, so it let this one through.
const ASPECT_ONLY_CLARIFICATION = new RegExp(
  '^\\s*(?:could you |can you |please )?(?:be more specific|clarify what|specify what|' +
  `(?:what|which)\\s+(?:specific\\s+|particular\\s+)?(?:(?:kinds?|sorts?|types?)\\s+of\\s+)?${STALL_NOUN})\\b`,
  'i'
)

// A question that asks how to DO something. There is always something to do for
// one of these — search the documentation — so there is never a reason to answer
// it with a question back.
//
// The intent veto above is only as good as the intent classifier, and the
// classifier is the unreliable link. "How do I connect Claude to the Virtual Fly
// Brain MCP server?" is as plainly a documentation question as any, but "Claude"
// reads as an entity name, so it was not classified as one — and the answer came
// back "What is Claude in the context of Virtual Fly Brain?", asking the user to
// define a word they had just used. The grammar of the QUESTION says what the
// intent field failed to: this is a how-to, and a how-to has a documentation
// search waiting for it whether or not anything was named correctly.
//
// Erring here is cheap in the same way the fast-path vetoes are. Worst case a
// genuinely vague how-to gets a general answer instead of a question back, which
// is still a turn the reader can use; and if the docs cover nothing, the answer
// is allowed to say so.
const HOW_TO_QUESTION = new RegExp(
  '^\\s*(?:how\\s+(?:do|can|could|would|should)\\s+(?:i|we|you|one)\\b' +
  '|how\\s+to\\b' +
  '|what(?:\'s|\\s+is|\\s+are)\\s+the\\s+(?:best\\s+)?(?:way|ways|steps?)\\s+to\\b)',
  'i'
)

// The SERVICE, not an entity in it. VFB's ontology holds fly anatomy; it does not
// hold "Virtual Fly Brain", and asking it to is not a lookup that can succeed.
//
// It was being asked anyway. "What was included in the latest Virtual Fly Brain
// release?" put "Virtual Fly Brain" in terms_to_resolve, VFB's search returned
// VFB_SYMBOL, term-info on that answered nothing, and the answer became "VFB does
// not currently hold data on the latest Virtual Fly Brain release". "How do I use
// the Virtual Fly Brain Model Context Protocol (MCP) tool?" fared worse: nothing
// matched, so the UNMATCHED NAMES block fired and the whole answer became a
// request to clarify which VFB term "Virtual Fly Brain MCP" meant. Neither is a
// naming failure. Both are questions about the software, with a documentation
// answer, and dropping the name lets them reach it.
//
// Matched only when the name IS the product, alone or qualified by a software
// noun — "Virtual Fly Brain" and "VFB MCP" are dropped, "mushroom body" and any
// VFB_/FBbt_ id are not (an id has no word boundary before its underscore).
const SERVICE_NOUN = /\b(?:web ?site|site|portal|platform|database|db|server|api|mcp|model context protocol|connect|tool|tools|viewer|browser|interface|app|application|software|service|releases?|versions?|docs?|documentation|project|consortium|team|home ?page)\b/i
const SERVICE_NAME = /^\s*(?:the\s+)?(?:vfb|virtual\s*fly\s*brain)\b[\s\-–—:,]*(.*?)\s*$/i

/** Is this "term" the VFB service itself rather than something VFB holds? */
export function isServiceName(name = '') {
  const m = SERVICE_NAME.exec(String(name))
  if (!m) return false
  const rest = m[1].replace(/[()]/g, ' ').trim()
  return !rest || SERVICE_NOUN.test(rest)
}

// The OTHER end of the connection. "How do I connect Claude to the VFB MCP
// server?" names two pieces of software; VFB holds neither, and the MCP guide is
// largely a list of these clients, so the whole class recurs.
//
// Looking one up is not merely useless, it is actively wrong, and silently so.
// VFB's search for "Claude" returns a FAFB neuron: its matched synonym is
// "LHPV5d3#1 5807250 Jean-Claude ARJ", the tracer's own name recorded in the
// annotation. The token is real, so no lexical guard in the resolver can reject
// it — pickBestTermId's last-resort rule asks only that the hit share a
// distinctive word with the query, and a person's given name is as distinctive
// as words get. The answer then carried a link and a thumbnail for a lateral
// horn neuron, and one run went on to compute its connectivity.
//
// Nothing in the search result says which "Claude" was meant. The question does,
// and this is where the question is still in view. Anchored whole-string: these
// are names the planner extracted as terms, so "cursor" here is the editor, not
// a word inside a sentence about something else.
const LLM_CLIENT_NAME = new RegExp(
  '^\\s*(?:the\\s+)?(?:anthropic\\s+|openai\\s+|google\\s+|github\\s+)?(?:' +
  'claude(?:\\s+(?:desktop|code|ai))?|chat\\s?gpt|openai|gpt-?[0-9.]*|' +
  'gemini(?:\\s+cli)?|copilot|cursor|windsurf|cline|goose|' +
  'vs\\s?code|visual\\s+studio\\s+code|lm\\s?studio|ollama|librechat|msty|' +
  'llm|large\\s+language\\s+model|ai\\s+assistant' +
  ')\\s*$',
  'i'
)

/** Is this "term" the LLM client at the other end, rather than something VFB holds? */
export function isLlmClientName(name = '') {
  return LLM_CLIENT_NAME.test(String(name))
}

/**
 * Coerce a raw planner output into a safe, normalised plan.
 *
 * `underspecified` is vetoed when the clarifying question is a stalling one (see
 * above): the plan proceeds with whatever steps it has, and an empty plan reaches
 * the controller's documentation/literature escalation instead of dead-ending on
 * a question back to the user.
 *
 * `question` is optional because eight call sites in the tests pass a raw plan
 * and nothing else; the only veto that reads it is the how-to one, which simply
 * does not fire without it.
 */
export function normalizePlan(raw = {}, question = '') {
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'other'
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s, i) => ({
    id: (s && s.id) ? String(s.id) : `s${i + 1}`,
    tool: (s && s.tool) ? String(s.tool) : '',
    answers: Array.isArray(s?.answers) ? s.answers.map(String).filter(Boolean) : []
  })).filter(s => s.tool)
  // de-duplicate step ids
  const seen = new Set()
  steps.forEach((s, i) => { if (seen.has(s.id)) s.id = `s${i + 1}`; seen.add(s.id) })
  const asked = String(raw.clarifying_question || '').trim()
  // An "underspecified" with no question to ask is not a clarification either —
  // the controller needs BOTH to clarify, so leaving the flag set would only
  // suppress the doc search and then fall through anyway.
  // A question about VFB itself is never clarified. There is always something
  // to do — search the documentation — and if nothing covers it the answer can
  // say so, which is a better turn than a question back. Clarifying also
  // suppresses the concurrent documentation search, so the cost of a wrong
  // clarify here is two turns, not one.
  //
  // Every clarify observed on a documentation question was a stall, and they
  // kept arriving in new grammar: "What specific aspect …?", then "What
  // specific type of problem or data …?", then "Are you looking to report a
  // problem or contribute new data?" — the last one offering a choice between
  // the two halves of a question that had already asked for both. Chasing the
  // phrasing is a losing game; the intent is the reliable signal.
  //
  // The same argument, made against the question rather than the intent, because
  // the intent classifier is what missed "How do I connect Claude to the VFB MCP
  // server?" — see HOW_TO_QUESTION above.
  const underspecified = Boolean(raw.underspecified) && Boolean(asked) &&
    intent !== 'documentation' &&
    !HOW_TO_QUESTION.test(String(question || '')) &&
    !ASPECT_ONLY_CLARIFICATION.test(asked)
  return {
    intent,
    underspecified,
    clarifying_question: underspecified ? asked : '',
    terms_to_resolve: (Array.isArray(raw.terms_to_resolve) ? raw.terms_to_resolve.map(String) : [])
      .filter(Boolean).filter(n => !isServiceName(n) && !isLlmClientName(n)),
    steps
  }
}

// The two cue lists that hold the fast path back. Both are written with their
// inflections spelled out, because bare stems inside \b(...)\b do not have any:
// \binput\b does not match "inputs", so "What are the main inputs to MBON-a1?"
// reached the fast path, had its whole phrase handed to search_terms as if it
// were a term name, matched nothing, and answered that the name could not be
// matched to a VFB term. Routed to the planner it answers properly, naming
// MBON-a1's strongest presynaptic partners.
//
// \bmorpholog\b was worse: there is no word boundary between "g" and "y", so
// that alternative could never match anything at all.
//
// Erring towards the veto is cheap. A vetoed question goes to the planner, which
// is strictly more capable than this path — the cost is one model call. A missed
// veto is a confidently wrong answer.
// "partners" was missing, and with it the whole synaptic vocabulary that does
// not contain the string "connect". "What are the main synaptic partners of
// Kenyon cells?" therefore matched the generic `^what (is|are) X` fast path,
// resolved "main synaptic partners of Kenyon cells" as if it were a term name,
// ran one term-info lookup, found no VFB connectivity and answered out of the
// literature: "…are projection neuron boutons." Correct, and not from VFB, for a
// term whose digest advertises the connectivity queries that answer it properly.
// The veto is the cheap side of this trade — see the note above.
/**
 * Vote key for planner self-consistency.
 *
 * `callStructuredVoted` defaults to hashing the WHOLE plan object, which was
 * harmless while the harness voted at temperature 0 (three identical greedy
 * generations, agreement always 1.00, signal always dead) and is actively
 * useless once sampling is on: two plans that reach the same intent through the
 * same tools but phrase `answers[]` differently are not a disagreement, yet a
 * whole-object key scores them 1/k every time.
 *
 * So vote on the DECISION — the intent and the ordered sequence of tools — and
 * let the wording vary. This is the key `probe_agreement.mjs` measured, and the
 * reason its agreement scores (0.67 on contested questions, 1.00 on settled
 * ones) mean anything at all.
 */
export function planVoteKey(raw = {}) {
  const p = normalizePlan(raw, '')
  return JSON.stringify({
    intent: p.intent,
    clarify: Boolean(p.underspecified && p.clarifying_question),
    tools: (p.steps || []).map(s => s.tool)
  })
}

/**
 * Vote the planner, and buy more votes when the votes disagree.
 *
 * This is complexity routing WITHOUT a complexity classifier. The alternative —
 * predicting which questions are hard from their wording and picking a bigger
 * model for those — needs a classifier that is right about difficulty before
 * seeing any evidence, and is wrong in the expensive direction whenever it
 * under-calls. Planner agreement is the same signal measured AFTER the fact: it
 * costs nothing extra on questions that are easy (the votes were already being
 * cast, v3.x simply threw the score away), and it is measured on THIS question
 * rather than on a guess about questions like it.
 *
 * One escalation round only. If six samples cannot agree on intent and tool
 * sequence, a seventh is not the fix; the sufficiency loop downstream is a
 * better place to recover, and it has evidence to work with.
 *
 * PURE and fully injected, so the policy is unit-testable offline:
 * @param {object}   o
 * ## The escalation has to be AFFORDABLE, not merely justified
 *
 * Buying a second round is the right call on a contested plan and the wrong call
 * on a stalled gateway — and from inside the vote those look identical, because
 * both present as "round one did not agree". The difference is the clock. A
 * contested round comes back in 78s with three plans that disagree; a stalled one
 * comes back at the full per-attempt ceiling having produced nothing to disagree
 * about. So the phase carries a wall-clock budget: escalation is skipped when
 * there is no longer time to spend on it, and when it does run it is handed only
 * the time that is ACTUALLY LEFT rather than a fresh full budget of its own.
 * Without that second half the budget bounds when escalation starts and not when
 * it ends, which is not a bound.
 *
 * Skipping degrades gracefully rather than failing: the plurality plan from round
 * one is still returned, and `rounds` records the skip and its reason, so a slow
 * deployment appears in the trace as budget pressure instead of as an
 * unexplained drop in agreement.
 *
 * @param {object}   o
 * @param {number}   o.votes          votes to cast in the first round (k)
 * @param {function} o.sample         async (k, budgetMs) => Array<plan>
 * @param {function} o.vote           (values, keyFn) => {value,count,total,agreement}
 * @param {function} [o.voteKeyFn]    decision key, defaults to planVoteKey
 * @param {object}   o.policy         {minAgreement, extraVotes, maxRounds, phaseBudgetMs, minRoundMs}
 * @param {function} [o.onContested]  called once, before the extra round is bought
 * @param {function} [o.now=Date.now] injectable clock, so the budget is testable
 * @returns {Promise<{ok, value, agreement, votes, escalated, budgetExhausted, rounds}>}
 */
export async function votePlanWithEscalation(o = {}) {
  const voteKeyFn = o.voteKeyFn || planVoteKey
  const policy = o.policy || {}
  const maxRounds = Number.isFinite(policy.maxRounds) ? policy.maxRounds : 1
  const extraVotes = Number.isFinite(policy.extraVotes) ? policy.extraVotes : 0
  const minAgreement = Number.isFinite(policy.minAgreement) ? policy.minAgreement : 0
  const phaseBudgetMs = Number.isFinite(policy.phaseBudgetMs) && policy.phaseBudgetMs > 0
    ? policy.phaseBudgetMs
    : Infinity
  const minRoundMs = Number.isFinite(policy.minRoundMs) ? policy.minRoundMs : 20000

  const now = typeof o.now === 'function' ? o.now : Date.now
  const startedAt = now()
  const remainingMs = () => (phaseBudgetMs === Infinity ? Infinity : phaseBudgetMs - (now() - startedAt))

  let pool = (await o.sample(Math.max(1, o.votes || 1), remainingMs())) || []
  if (!pool.length) return { ok: false, error: 'planner produced no valid plans', rounds: [] }

  let tally = o.vote(pool, voteKeyFn)
  const rounds = [{ agreement: tally.agreement ?? null, votes: pool.length, escalated: false }]
  let escalated = false
  let budgetExhausted = false

  for (let round = 0; round < maxRounds; round++) {
    if (extraVotes <= 0) break
    if ((tally.agreement ?? 1) >= minAgreement) break
    const left = remainingMs()
    if (left < minRoundMs) {
      budgetExhausted = true
      rounds.push({ agreement: tally.agreement ?? null, votes: pool.length, escalated: false, skipped: 'budget' })
      break
    }
    if (round === 0 && typeof o.onContested === 'function') {
      try { o.onContested(tally) } catch { /* status is best-effort */ }
    }
    const more = (await o.sample(extraVotes, left)) || []
    if (!more.length) break
    pool = pool.concat(more)
    tally = o.vote(pool, voteKeyFn)
    escalated = true
    rounds.push({ agreement: tally.agreement ?? null, votes: pool.length, escalated: true })
  }

  return {
    ok: true,
    value: tally.value,
    agreement: tally.agreement ?? null,
    votes: pool.length,
    escalated,
    budgetExhausted,
    rounds
  }
}

const MULTI_STEP_CUE = /\b(?:connect(?:s|ed|ing|ions?|ivity)?|partners?|synap(?:se|ses|tic)|pre-?synaptic|post-?synaptic|afferents?|efferents?|innervat\w*|projects?\s+to|circuits?|upstream|downstream|between|compar(?:e|es|ed|ing|isons?)|pathways?|trac(?:e|es|ed|ing)|reciprocal|converg(?:e|es|ent|ence)|vs\.?|versus|and the|both)\b/i
const SPECIFIC_ROLE_CUE = /\b(?:functions?|roles?|mechanisms?|evidence|(?:neuro)?transmitters?|express(?:es|ed|ing|ion)?|drivers?|gal4|splits?|stocks?|publications?|papers?|how many|counts?|inputs?|outputs?|similar(?:ity|ities)?|morpholog(?:y|ies|ical))\b/i

/**
 * Cheap deterministic fast-path: a single-term factual lookup doesn't need a
 * full planner call. Returns a minimal plan, or null if the planner should run.
 * Conservative — only fires on clearly simple single-subject questions.
 */
/**
 * The plan for a question the user did not type but CLICKED.
 *
 * A follow-on chip is not a guess about what VFB might hold — it was generated
 * from a specific term's own query catalogue, and it carries the id and the
 * query_type that produced it. Re-planning that from the chip's English sentence
 * throws away a certainty and replaces it with a lexical search: exactly the
 * round trip that answered "Which neurons receive output from the medulla?" with
 * "the term 'medulla' was not matched to a specific VFB entity in this session".
 *
 * So a validated focus becomes the plan directly. The id is put through
 * terms_to_resolve as well as into the step args, because the term-info fetch is
 * what rebuilds the digest — which is what gives THIS turn's answer its links,
 * its sources, and its next set of chips. resolveTerms' existing embedded-id
 * short-circuit recognises a bare id and skips the search, so this costs one
 * lookup and no guessing.
 *
 * Returns null unless both halves are present and well-formed; a malformed focus
 * falls through to the ordinary planner rather than failing the turn, because
 * this arrives from the client and the client can be wrong.
 */
export function detectFocusPlan(question = '', focus = null) {
  const id = typeof focus?.id === 'string' ? focus.id.trim() : ''
  const queryType = typeof focus?.query_type === 'string' ? focus.query_type.trim() : ''
  if (!/^(?:FBbt|FBgn|FBal|FBti|FBtp|FBco|FBlc|FBrf|VFBexp|VFB)_[0-9a-zA-Z]+$/.test(id)) return null
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(queryType)) return null
  const q = String(question || '').trim()
  return {
    intent: 'other',
    underspecified: false,
    clarifying_question: '',
    terms_to_resolve: [id],
    steps: [{ id: 's1', tool: 'vfb_run_query', answers: [q], args: { id, query_type: queryType } }]
  }
}

export function detectFastPath(question = '') {
  const q = String(question).trim()
  if (!q) return null
  // "What datasets are available?" — list ALL VFB datasets deterministically
  // instead of letting the weak planner abstain (and the empty-VFB literature
  // fallback pull an irrelevant paper). Special case: the AllDatasets query run
  // against ANY template returns the complete dataset list (the template is
  // irrelevant — it just anchors the query), so we hard-wire JRC2018Unisex.
  // The step's result is real VFB evidence, so the literature fallback won't fire.
  if (DATASETS_INTENT.test(q) && !DATASET_SCOPE_RE.test(q) && !NAMED_SUBJECT_RE.test(q)) {
    return {
      intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: [],
      steps: [{ id: 's1', tool: 'vfb_run_query', answers: [q], args: { id: ALL_DATASETS_TEMPLATE, query_type: 'AllDatasets' } }]
    }
  }
  // Multi-step / comparative / connectivity cues → not a fast path.
  if (MULTI_STEP_CUE.test(q)) return null
  // Function/evidence or tool-specific cues need a specific role, not the generic lookup.
  if (SPECIFIC_ROLE_CUE.test(q)) return null
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
  return stripMarkdownLinks(s)
    // "(major) subdivisions/parts/components of (the) X" -> "X" (resolve the entity,
    // not the descriptor — "major subdivisions of the mushroom body" -> "mushroom body").
    // "anatomical" is in the adjective list because lib/followOns.mjs' own PartsOf
    // template reads "What are the anatomical parts of the {term}?" — leaving it
    // out meant our own chip, typed rather than clicked, went to VFB as the term
    // "anatomical parts of the medulla".
    .replace(/^\s*(?:the\s+)?(?:major|minor|main|principal|key|anatomical|gross|internal|external)?\s*(?:subdivisions?|sub-?parts?|parts?|components?|sub-?components?|substructures?|structures?|divisions?|sections?|segments?|subregions?)\s+of\s+(?:the\s+)?/i, '')
    // drop species/common-name qualifiers (the WORD only — keep the entity after it).
    .replace(/\b(?:drosophila|melanogaster|fruit\s*fly|fruitfly|flies|fly)\b/ig, '')
    // drop a trailing scope qualifier like "in the adult brain / CNS".
    .replace(/\bin\s+(?:the\s+)?(?:adult|larval|embryonic)?\s*(?:brain|cns|nervous system)\b.*$/i, '')
    // A leading indefinite article is grammar, not part of the name: "What is a
    // Kenyon cell?" asks about the Kenyon cell, and searching VFB for "a Kenyon
    // cell" costs the exact-label match — the term then has to be recovered by
    // the weakest stage of the ladder, on a shared distinctive token. The
    // capture in detectFastPath already drops a leading "the"; this is the other
    // half of it. Deliberately case-SENSITIVE and lowercase-only: "AN" is the
    // abbreviation for ascending neuron ("What are AN neurons?"), and a
    // case-insensitive strip would send that question to VFB as "neurons".
    .replace(/^(?:an?)\s+/, '')
    .replace(/[?.!,;:]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
