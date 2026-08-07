// Typed request ledger (pure) — the controller's shared state.
//
// This is the single growing state for a request. Roles never talk to each
// other; they read/write the ledger via the controller. It holds extracted
// facts and handles, NOT raw payloads. Completion is a deterministic checklist
// over the plan's steps, not a model judgement. See design report §4.1–§4.2.

import { stripMarkdownLinks } from './markdownLinks.mjs'

/** Create an empty ledger for a user question. */
export function createLedger(question, { maxToolRounds = 24 } = {}) {
  return {
    question: String(question || ''),
    intent: null,
    underspecified: false,
    clarifyingQuestion: '',
    termsToResolve: [],          // names the planner asked to resolve
    terms: {},                   // name -> { id, label, kind, confidence, publications:[] }
    plan: [],                    // [{ id, tool, answers:[], status:'pending'|'satisfied'|'not_found', note? }]
    evidence: [],                // [{ claim, source, verbatim, stepId?, ...locator }]
    resources: [],               // data_resource handles (lightweight)
    retrieval: [],               // [{ kind:'doc'|'literature', reasons:[], ... }]
    budget: { toolRoundsLeft: maxToolRounds, tokenEstimate: 0 },
    openQuestions: [],           // sub-questions still uncovered (derived from plan)
    registry: {}                 // authoritative normalised-label -> id, from VFB data only
  }
}

/**
 * Record an authoritative label -> id mapping seen in VFB data (a search doc
 * label, a term-info Name, or a query-result row). The id's own VFB label is the
 * key — never a model/planner-supplied name — so links can never pin a label to
 * the wrong id. Canonical sources (term_info/search) win over row mentions.
 */
/**
 * The registry's key for a label. Exported because it is a CONTRACT, not an
 * implementation detail: anything that pre-seeds the registry (see
 * lib/conversationContext.mjs) must key entries identically, or the
 * canonical-upgrade rule below silently stops applying to them and a carried
 * mapping outranks live VFB data. One function, so the two can never drift.
 */
export function registryKey(label) {
  // Whitespace is collapsed as well as case. Two spellings of a label that
  // differ only in spacing are the same label — VFB's own data has both, since
  // some come from term-info Names and some from table cells — and keying them
  // apart splits one term into two entries, of which only one can then be
  // upgraded by a canonical source.
  return stripMarkdownLinks(label).replace(/\s+/g, ' ').trim().toLowerCase()
}

export function recordTermId(ledger, label, id, { canonical = false } = {}) {
  const name = stripMarkdownLinks(label)
  const key = registryKey(label)
  if (!ledger.registry) ledger.registry = {}
  if (!name || !id || !/^(FBbt|VFB|FBgn|FBal|FBti|FBtp|FBco)/.test(id)) return ledger
  const existing = ledger.registry[key]
  // First write wins, but a canonical (term-info/search label) source upgrades a
  // non-canonical one.
  if (!existing || (canonical && !existing.canonical)) {
    ledger.registry[key] = { id, label: name, canonical: Boolean(canonical) }
  }
  return ledger
}

const STEP_STATUS = new Set(['pending', 'satisfied', 'not_found'])

/** Install a (normalised) plan into the ledger and derive open questions. */
export function setPlan(ledger, plan) {
  ledger.intent = plan?.intent ?? ledger.intent
  ledger.underspecified = Boolean(plan?.underspecified)
  ledger.clarifyingQuestion = plan?.clarifying_question || ''
  ledger.termsToResolve = Array.isArray(plan?.terms_to_resolve) ? [...plan.terms_to_resolve] : []
  ledger.plan = (Array.isArray(plan?.steps) ? plan.steps : []).map((s, i) => ({
    id: s.id || `s${i + 1}`,
    tool: s.tool || '',
    answers: Array.isArray(s.answers) ? s.answers.filter(Boolean) : [],
    // Preserve any planner/fast-path arg template (e.g. { id: '$term:medulla' }).
    // The planner LLM schema omits args, but the deterministic fast-path supplies
    // them so a tier-1 lookup can target vfb_get_term_info directly.
    args: (s.args && typeof s.args === 'object') ? { ...s.args } : {},
    status: STEP_STATUS.has(s.status) ? s.status : 'pending',
    note: s.note || '',
    // Provenance, not decoration: a step recognised from a chip template was
    // written before any term was resolved, so it is the one kind of step that
    // may have to be WITHDRAWN once the term is known (see
    // dropUnofferedTemplateSteps). Everything else here is dropped on purpose —
    // this normalisation is what keeps a model-authored plan to known fields —
    // so the flag has to be named to survive, and only ever set by this codebase.
    ...(s.via_template ? { via_template: true } : {})
  }))
  recomputeOpenQuestions(ledger)
  return ledger
}

/** Record a resolved term (and any publication refs) on the ledger. */
export function addTerm(ledger, name, term = {}) {
  if (!name) return ledger
  ledger.terms[name] = {
    id: term.id || null,
    label: term.label || name,
    kind: term.kind || null,
    confidence: typeof term.confidence === 'number' ? term.confidence : null,
    publications: Array.isArray(term.publications) ? term.publications : [],
    ...term
  }
  return ledger
}

/** Resolve a term id by name (or by the "$term:NAME" placeholder). */
export function getTermId(ledger, nameOrPlaceholder = '') {
  const name = String(nameOrPlaceholder).replace(/^\$term:/, '')
  return ledger.terms[name]?.id || null
}

/** Replace "$term:NAME" placeholders in a tool-args object with resolved ids. */
export function resolveArgs(ledger, args = {}) {
  const out = {}
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.startsWith('$term:')) {
      out[k] = getTermId(ledger, v) || v.replace(/^\$term:/, '')
    } else {
      out[k] = v
    }
  }
  return out
}

/** Any resolved term carry publication refs? (drives the literature escalation.) */
export function ledgerHasRefs(ledger) {
  return Object.values(ledger.terms).some(t => Array.isArray(t.publications) && t.publications.length > 0)
}

/**
 * Add a source-tagged evidence row. If it names a stepId, that step is marked
 * satisfied. Returns the ledger.
 */
export function addEvidence(ledger, row) {
  if (!row || !row.source) throw new Error('evidence row needs a source')
  ledger.evidence.push(row)
  if (row.stepId) {
    const step = ledger.plan.find(s => s.id === row.stepId)
    if (step && step.status === 'pending') step.status = 'satisfied'
  }
  recomputeOpenQuestions(ledger)
  return ledger
}

/**
 * Remove a step that was never asked, as distinct from one that was asked and
 * came back empty.
 *
 * `not_found` is a claim about VFB: it says the database was consulted and had
 * nothing. That claim reaches the user's answer more or less verbatim, and the
 * synthesiser has no way to tell it apart from a call that never left the
 * building. So a step we decline to dispatch — because its subject could not be
 * addressed, or because the resolved term does not offer the query — must not
 * be left in the plan wearing a status that means something else. It is
 * withdrawn: struck from the plan entirely, so completion is computed over the
 * steps that actually ran.
 *
 * Note the status is set before the filter rather than instead of it. Nothing
 * downstream ever sees 'withdrawn' (it is deliberately not in STEP_STATUS), but
 * a caller holding a reference to the step object can read why it went, and the
 * trace line is built from it.
 */
export function withdrawStep(ledger, stepId, note = '') {
  const step = (ledger.plan || []).find(s => s.id === stepId)
  if (!step) return ledger
  step.status = 'withdrawn'
  step.note = note
  ledger.plan = (ledger.plan || []).filter(s => s.status !== 'withdrawn')
  recomputeOpenQuestions(ledger)
  return ledger
}

/** Mark a step exhausted (no evidence after the retry/broaden ladder). */
export function markStepNotFound(ledger, stepId, note = '') {
  const step = ledger.plan.find(s => s.id === stepId)
  if (step) { step.status = 'not_found'; step.note = note }
  recomputeOpenQuestions(ledger)
  return ledger
}

/** Decrement the tool-round budget; returns remaining. */
export function recordToolRound(ledger) {
  ledger.budget.toolRoundsLeft = Math.max(0, ledger.budget.toolRoundsLeft - 1)
  return ledger.budget.toolRoundsLeft
}

export function outOfBudget(ledger) {
  return ledger.budget.toolRoundsLeft <= 0
}

/** Has VFB evidence answered the question? (any non-empty plan, all steps satisfied) */
export function vfbAnswered(ledger) {
  return ledger.plan.length > 0 && ledger.plan.every(s => s.status === 'satisfied')
}

/** Did VFB return anything usable at all? (any evidence rows tagged vfb) */
export function vfbHasData(ledger) {
  return ledger.evidence.some(e => e.source === 'vfb')
}

/**
 * Is the request complete? Every plan step is satisfied or exhausted, and the
 * planner did not flag the question as needing clarification. Completion is a
 * code checklist, never a model "are you done?" call.
 */
export function isComplete(ledger) {
  if (ledger.underspecified) return false
  if (ledger.plan.length === 0) return false
  return ledger.plan.every(s => s.status === 'satisfied' || s.status === 'not_found')
}

/** Steps still needing work, earliest first (controller picks the next one). */
export function pendingSteps(ledger) {
  return ledger.plan.filter(s => s.status === 'pending')
}

function recomputeOpenQuestions(ledger) {
  ledger.openQuestions = ledger.plan
    .filter(s => s.status === 'pending')
    .flatMap(s => s.answers)
}
