// Ledger sufficiency check — "did we actually look?" before we answer.
//
// THE FAILURE THIS EXISTS FOR
//
// The synthesis prompt's absence gate says: only claim VFB lacks something if
// AVAILABLE VFB DATA shows nothing relevant. Nothing in that gate distinguishes
// QUERIED AND EMPTY from NEVER QUERIED. When the planner stops after resolving
// terms and reading term info, the evidence block is empty, the gate is
// satisfied, and the model writes a confident false denial — "VFB does not
// currently hold data on the input and output neurons of the mushroom body" —
// about a term whose digest is sitting there advertising 366 presynaptic and
// 304 postsynaptic neuron records.
//
// This is the same class of error as VFBquery's count -1, one layer up: -1 means
// "run the query to find out", not "zero". A lookup that did not happen is not
// evidence of anything.
//
// Every deterministic injector in orchestrator.mjs is a patch for one shape of
// this bug (connectivity questions, region counts, scRNAseq, similarity, count
// questions, intent-matched uncounted queries). Each is keyed on the QUESTION's
// wording, so each misses whenever a question is worded outside its pattern —
// "what are its main input and output neurons" matches the connectivity rule's
// wording but a region's synaptic queries are semantic kind class_list, so the
// rule finds no candidate, falls through, and nothing runs.
//
// So this module asks the question the regexes cannot: given what we gathered
// and what is still on the shelf unrun, does this answer the question yet? It
// runs on the LEDGER, before synthesis — not on the finished prose — because
// synthesis is streamed (liveHarness has no non-streaming path) and because a
// verdict at this point can still DO something about it: name the query and
// re-plan, rather than rephrase after the fact.
//
// COST CONTROL. Two hard limits, because the latency tail is already 90–300s:
//   1. A deterministic pre-filter (shouldCheckSufficiency) — the LLM call only
//      fires when the ledger is thin AND there are unrun queries that could
//      change that. A well-fed ledger never pays for this.
//   2. One shot. `_sufficiencyChecked` is set before any step is injected, so
//      the check can never fire twice on one question and cannot loop.

import { querySemantics } from './queryTypes.mjs'
import { buildShelf, unansweredAsks } from './coverage.mjs'

export const SUFFICIENCY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answerable', 'picks'],
  properties: {
    answerable: {
      type: 'boolean',
      description: 'true if the evidence already answers the question, or if nothing in the offered list would help'
    },
    picks: {
      type: 'array',
      maxItems: 3,
      items: { type: 'integer' },
      description: 'numbers of the offered queries to run, best first; empty when answerable is true'
    },
    reason: { type: 'string', description: 'one short clause naming what is missing' }
  }
}

/** How many unrun queries to offer the checker. Keeps the prompt small. */
const CANDIDATE_CAP = 24
/** How many steps one check may inject. */
export const MAX_INJECTED = 3

/**
 * Words that make a question about DATA rather than about a definition.
 *
 * "What is the mushroom body?" is answered by the term description alone and
 * must not pay for a check. "What are the main input and output neurons of the
 * mushroom body?" opens the same way and is a data question. The difference is
 * whether the question names something VFB stores records of.
 */
const DATA_NOUN_RE = /\b(neurons?|cells?|neurotransmitters?|cholinergic|gabaergic|glutamatergic|dopaminergic|serotonergic|octopaminergic|peptidergic|images?|pictures?|thumbnails?|datasets?|connectomes?|connectivity|partners?|inputs?|outputs?|upstream|downstream|presynaptic|postsynaptic|synapses?|express\w*|transcriptom\w*|scrnaseq|single[- ]cell|driver lines?|gal4|lexa|split[- ]?gal4|stocks?|alleles?|transgen\w*|subclass\w*|subtypes?|types?|classes|parts?|components?|subparts?|lineages?|tracts?|nerves?|templates?|registrations?|similar\w*|nblast|neuronbridge|how many|count\w*|list|enumerate|which|records?)\b/i

/** A definitional question that names no data noun — the description answers it. */
export function isDefinitionalQuestion(question) {
  const q = String(question || '')
  if (!/^\s*(?:what|who)\s+(?:is|are|was|were)\b/i.test(q) && !/^\s*(?:tell me about|describe|define)\b/i.test(q)) return false
  return !DATA_NOUN_RE.test(q)
}

/** query_types already planned (in any state) against a given term id. */
function plannedTypesFor(ledger, id) {
  const out = new Set()
  for (const s of ledger.plan || []) {
    if (s.tool !== 'vfb_run_query') continue
    if (String(s.args?.id || '') !== String(id)) continue
    if (s.args?.query_type) out.add(String(s.args.query_type).toLowerCase())
  }
  return out
}

/**
 * Queries the resolved terms advertise that no step has run or planned.
 *
 * Deliberately NOT filtered by countKind. injectIntentQuerySteps only runs
 * uncounted queries — right for a count question, since a counted query already
 * has its number in the digest — but "what ARE its input neurons" wants the
 * LIST, and the digest carries at most five preview rows. A counted query can
 * still be the missing one.
 */
export function unrunQueries(ledger, cap = CANDIDATE_CAP) {
  const out = []
  for (const t of Object.values(ledger?.terms || {})) {
    if (!t?.id || !Array.isArray(t?.digest?.queries) || !t.digest.queries.length) continue
    const planned = plannedTypesFor(ledger, t.id)
    for (const q of t.digest.queries) {
      if (!q?.query_type) continue
      if (planned.has(String(q.query_type).toLowerCase())) continue
      out.push({
        id: t.id,
        termName: t.digest?.name || t.label || t.id,
        query_type: q.query_type,
        label: q.label || q.query_type,
        count: q.count,
        countKind: q.countKind || (Number(q.count) < 0 ? 'unknown' : 'exact')
      })
      if (out.length >= cap) return out
    }
  }
  return out
}

/**
 * The ledger has not looked at something the question asked for.
 *
 * This used to be a per-TERM test — map each evidence row back to the term its
 * step named, then ask whether any term with unrun queries went untouched. That
 * is the wrong unit twice over. A term with one of its five queries run counted
 * as covered, so the other four never triggered the check ("How many DA1 lPN
 * neurons does VFB hold in each connectome dataset?" ran a connectivity query
 * against the term, and ListAllAvailableImages — the query that answers it —
 * was never offered). And a step that produced evidence without naming a term
 * made the whole ledger read as covered, whatever was left on the shelf.
 *
 * The unit is a QUERY, and unansweredAsks is the same set the synthesiser is
 * shown as WORTH SAYING: unrun, unplanned, and about this question, with
 * anything a macro tool already covered by semantic kind subtracted. So the
 * check fires exactly when there is something to run, and the answer names
 * exactly what could not be run — the two can no longer disagree.
 *
 * The first two early-outs are unchanged: the test is stepId, not
 * source === 'vfb', because resolving a term contributes vfb evidence (its
 * description) without answering anything, and a ledger holding only that is
 * exactly the case where a false denial gets written.
 */
export function ledgerIsThin(ledger) {
  const ev = ledger?.evidence || []
  if (!ev.length) return true
  if (!ev.some(e => e.stepId)) return true
  const shelf = buildShelf(ledger)
  if (!shelf.length) return false
  return unansweredAsks(shelf).length > 0
}

/**
 * Should we spend an LLM call asking whether this ledger answers the question?
 *
 * All five must hold. Each one is a case where the check would cost latency and
 * change nothing.
 */
export function shouldCheckSufficiency(ledger) {
  if (!ledger || ledger._sufficiencyChecked) return false
  // A doc page answered it. The absence rule for documentation questions is
  // already handled by docBlock/docMissBlock, and a VFB data query would not
  // improve an answer about the website.
  if ((ledger.evidence || []).some(e => e.source === 'doc')) return false
  if (!ledgerIsThin(ledger)) return false
  if (isDefinitionalQuestion(ledger.question)) return false
  return unrunQueries(ledger).length > 0
}

/** One offered line: "3. mushroom body — Neurons with presynaptic terminals in mushroom body [NeuronsPresynapticHere; 366 records]" */
function candidateLine(c, i) {
  const kind = querySemantics(c.query_type).kind
  const count = c.countKind === 'exact' ? `${c.count} records`
    : c.countKind === 'many' ? 'many records (exact total not computed)'
      : 'count not yet computed — running it is the only way to know'
  return `${i + 1}. ${c.termName} — ${c.label} [${c.query_type}; ${kind}; ${count}]`
}

export function buildSufficiencyMessages(ledger, candidates) {
  const evidence = (ledger.evidence || []).map(e => ({
    claim: e.claim, source: e.source, fromStep: !!e.stepId
  }))
  return [
    {
      role: 'system',
      content: 'You are a query planner for Virtual Fly Brain. You do NOT write answers. Your only job is to say whether the evidence gathered so far actually answers the user\'s question, and if it does not, to name which of the offered VFB queries should be run first.\n'
        + 'Be strict about one thing: evidence that merely DESCRIBES a term (its definition, its place in the ontology) does not answer a question asking for its data — the neurons in it, its images, its partners, its expression, its subtypes, a count. If the question asks for data and no query has run, it is not answerable yet.\n'
        + 'Be equally strict the other way: if the offered queries are about something else, set answerable true. A wrong query is worse than none. Never guess a number that is not on the list.'
    },
    {
      role: 'user',
      content: `QUESTION:\n${ledger.question}\n\n`
        + `EVIDENCE GATHERED SO FAR (JSON; fromStep=false means it came from merely looking the term up, not from querying anything):\n${JSON.stringify(evidence)}\n\n`
        + `VFB QUERIES AVAILABLE FOR THE RESOLVED TERMS, NOT YET RUN:\n${candidates.map(candidateLine).join('\n')}\n\n`
        + 'Does the evidence answer the QUESTION?\n'
        + '- If yes, answerable=true, picks=[].\n'
        + `- If no, answerable=false and picks = up to ${MAX_INJECTED} numbers from the list above whose results would answer it, best first.\n`
        + '- If no, but nothing on the list would answer it either, answerable=true, picks=[]. Do not pick a query that is merely adjacent to the question.'
    }
  ]
}

/** Map the checker's picks back to real candidates, dropping anything invented. */
export function selectPicks(verdict, candidates) {
  if (!verdict || verdict.answerable) return []
  const picks = Array.isArray(verdict.picks) ? verdict.picks : []
  const seen = new Set()
  const out = []
  for (const n of picks) {
    const i = Number(n) - 1
    const c = candidates[i]
    if (!c) continue
    const key = `${c.id}::${String(c.query_type).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= MAX_INJECTED) break
  }
  return out
}

/** Push the chosen queries onto the plan as pending steps. Returns how many. */
export function injectSufficiencySteps(ledger, picks, question, log = () => {}) {
  let n = 0
  for (const c of picks) {
    ledger.plan.push({
      id: `sq${ledger.plan.length + 1}`,
      tool: 'vfb_run_query',
      answers: [String(question || ledger.question)],
      args: { id: c.id, query_type: c.query_type },
      status: 'pending',
      list_label: c.label || '',
      sufficiency_query: true,
      note: `auto-injected sufficiency step (ledger did not answer the question → run ${c.query_type})`
    })
    n++
    log({ inject: 'vfb_run_query', query_type: c.query_type, id: c.id, reason: 'sufficiency-check' })
  }
  return n
}

/**
 * The whole check. Returns true when steps were injected and the caller should
 * loop again instead of synthesising.
 *
 * Marks the ledger checked BEFORE doing anything else, so a failure, a timeout
 * or an injected step that comes back empty all land in synthesis on the next
 * pass rather than asking again.
 */
export async function maybeInjectSufficiencyQueries(ledger, deps, models = {}, log = () => {}) {
  if (!shouldCheckSufficiency(ledger)) return false
  if (typeof deps?.callStructured !== 'function') return false
  ledger._sufficiencyChecked = true
  const candidates = unrunQueries(ledger)
  let res
  try {
    res = await deps.callStructured({
      messages: buildSufficiencyMessages(ledger, candidates),
      schema: SUFFICIENCY_SCHEMA,
      schemaName: 'sufficiency',
      model: models.planner
    })
  } catch (err) {
    log({ step: 'sufficiency', ok: false, error: String(err?.message || err) })
    return false
  }
  if (!res?.ok) { log({ step: 'sufficiency', ok: false }); return false }
  const picks = selectPicks(res.value, candidates)
  log({
    step: 'sufficiency',
    ok: true,
    answerable: !!res.value?.answerable,
    reason: String(res.value?.reason || '').slice(0, 120),
    injected: picks.length
  })
  if (!picks.length) return false
  injectSufficiencySteps(ledger, picks, ledger.question, log)
  ledger._sufficiencyInjected = picks.map(c => c.query_type)
  return true
}
