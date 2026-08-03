// Controller decisions (pure) — the deterministic brain.
//
// The controller is CODE, not an LLM: it owns the loop, decides the next action
// from the ledger state, and judges completion via a checklist (never by asking
// a model "are you done?"). This module holds those decision functions so they
// are offline-testable; the async orchestration (calling roles, MCP, ELM) wraps
// these in route.js / a new orchestrator. See design report §4.2.

import { isComplete, pendingSteps, outOfBudget, vfbAnswered, vfbHasData, ledgerHasRefs } from './ledger.mjs'
import { planRetrieval } from './externalEvidence.mjs'

/**
 * Decide the next action for the controller loop. Pure function of ledger state.
 * @returns {{ action:string, step?:object, retrieval?:object, reason:string }}
 *   action ∈ 'clarify' | 'resolve_terms' | 'run_step' | 'retrieve' | 'synthesise' | 'stop'
 */
export function nextAction(ledger) {
  // 1. Planner flagged it needs a clarifying question → ask the user once.
  if (ledger.underspecified && ledger.clarifyingQuestion) {
    return { action: 'clarify', reason: 'planner-underspecified' }
  }

  // 2. Out of budget → stop and synthesise whatever we have.
  if (outOfBudget(ledger)) {
    return { action: 'synthesise', reason: 'budget-exhausted' }
  }

  // 3. Unresolved terms the plan needs → resolve them (fan-out happens in code).
  //    `attempted` matters: a term VFB genuinely cannot match is recorded with
  //    id null, and testing only `!…?.id` re-issued resolve_terms on every pass.
  //    Term resolution is deterministic, so a second identical search cannot
  //    succeed — the loop just burned the whole round budget on repeat searches
  //    and then synthesised from an empty ledger ("VFB does not currently hold
  //    data on …"). One attempt per term, then move on.
  const unresolved = (ledger.termsToResolve || [])
    .filter(name => !ledger.terms[name]?.id && !ledger.terms[name]?.attempted)
  if (unresolved.length > 0) {
    return { action: 'resolve_terms', terms: unresolved, reason: 'terms-unresolved' }
  }

  // 4. Pending plan steps → run the next one.
  const pending = pendingSteps(ledger)
  if (pending.length > 0) {
    return { action: 'run_step', step: pending[0], reason: 'pending-step' }
  }

  // 5. All VFB steps done — consider conditional doc/literature escalation.
  const retrieval = decideRetrieval(ledger)
  if ((retrieval.documentation || retrieval.literature) && !ledger._retrievalDone) {
    return { action: 'retrieve', retrieval, reason: retrieval.reasons.join(',') || 'escalation' }
  }

  // 6. Complete, or there is something to write up (steps ran, or term
  //    resolution already gathered evidence) → synthesise. Gathering evidence
  //    with an empty plan (e.g. a "tell me about X" term lookup) must still
  //    produce an answer, not dead-stop.
  if (isComplete(ledger) || ledger.plan.length > 0 || ledger.evidence.length > 0) {
    return { action: 'synthesise', reason: isComplete(ledger) ? 'complete' : 'have-evidence-or-steps' }
  }

  // 7. Nothing resolved and nothing to say → synthesise a transparent answer
  //    from whatever the ledger has (the synthesiser handles the empty case).
  return { action: 'synthesise', reason: 'nothing-gathered' }
}

/**
 * Decide whether to escalate to documentation/literature retrieval, gated on
 * VFB-first (these are additional steps, not primary roles). Wraps planRetrieval
 * with ledger-derived signals.
 */
export function decideRetrieval(ledger) {
  return planRetrieval({
    question: ledger.question,
    vfbAnswered: vfbAnswered(ledger),
    vfbHasData: vfbHasData(ledger),
    hasRefs: ledgerHasRefs(ledger)
  })
}

/** A compact, loggable snapshot of why the controller is doing what it is. */
export function statusSummary(ledger) {
  const steps = ledger.plan.map(s => `${s.id}:${s.status}`).join(' ')
  return {
    intent: ledger.intent,
    steps,
    evidence: ledger.evidence.length,
    terms_resolved: Object.values(ledger.terms).filter(t => t.id).length,
    rounds_left: ledger.budget.toolRoundsLeft,
    complete: isComplete(ledger)
  }
}
