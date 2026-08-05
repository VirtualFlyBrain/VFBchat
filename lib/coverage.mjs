// Per-QUERY coverage — what was actually looked at, and what merely exists.
//
// THE ERROR THIS REPLACES
//
// Two places in this codebase asked "has this TERM been looked at?" when the
// question they needed answered was "has this QUERY been run?", and both got the
// same class of wrong answer from opposite directions.
//
//   orchestrator.mjs  suppressed the whole AVAILABLE VFB DATA catalogue — and
//                     with it the 3.7.0 prohibition against denying what it
//                     lists — the moment ANY planned step produced evidence.
//   sufficiency.mjs   counted a term as covered once ONE of its five queries had
//                     run, so the other four never triggered the check.
//
// "How many DA1 lPN neurons does VFB hold in each connectome dataset?" is the
// clean demonstration. One connectivity query ran and was attributed to the
// term; the catalogue vanished, the sufficiency pre-filter declined, and
// ListAllAvailableImages — the query that answers the question — never ran and
// was then denied. A term is not a unit of coverage. A query is.
//
// FOUR STATES, NOT TWO
//
// The obvious model is run/not-run. It is not enough, because "the query ran and
// came back with nothing" and "the lookup was attempted and blew up" arrive at
// the same place in this pipeline (markStepNotFound) and mean opposite things to
// a reader. Conflating them costs an answer in each direction: a genuine empty
// gets hedged into "the query has not been run yet", and a failed lookup gets
// reported as data VFB does not hold. So:
//
//   RUN      ran, produced evidence — answer from EVIDENCE, never call it unrun
//   EMPTY    ran, definitively zero rows — the ONLY state that licenses absence
//   FAILED   attempted, no usable result — licenses nothing; say the lookup
//            did not complete, or say nothing
//   UNRUN    never attempted — VFB holds these records; denying them is the bug
//
// WHY THE CATALOGUE CAN COME BACK
//
// The guard this replaces was added for a real defect: supplied unconditionally,
// the catalogue turned into a tail on every answer ("VFB holds various data
// related to LPLC2, including available images, splits targeting it, …"). But
// the block was doing two jobs at once — forbidding a denial, and licensing a
// recital — and only the second one pads. Separated, the prohibition can be
// always-on and complete while the recital is scoped to the queries the question
// actually asked for and nothing else covers. See renderShelf below.

import { querySemantics } from './queryTypes.mjs'
import { labelOverlapScore, listQueryWords } from './queryRelevance.mjs'
import { PREVIEW_COUNT_CAP } from './termInfoDigest.mjs'

export const RUN = 'run'
export const EMPTY = 'empty'
export const FAILED = 'failed'
export const UNRUN = 'unrun'

/** Strongest wins when two steps target the same query. */
const STATE_RANK = { [RUN]: 3, [EMPTY]: 2, [FAILED]: 1, [UNRUN]: 0 }

/**
 * The semantic kinds a MACRO tool covers.
 *
 * A macro names no query_type — vfb_find_similar_neurons does not run
 * SimilarMorphologyTo, it runs NBLAST — so its evidence cannot be matched to a
 * shelf entry by name. Matching by KIND is what stops the shelf reporting
 * "similarity: not yet run" underneath an answer full of NBLAST scores.
 */
function macroKinds(tool = '') {
  const t = String(tool)
  if (/similar|nblast|neuronbridge/i.test(t)) return ['similarity']
  if (/connectivity|connection|partner|downstream|upstream|reciprocal/i.test(t)) return ['connectivity']
  if (/scrnaseq|single_?cell|gene_expression/i.test(t)) return ['scrnaseq']
  if (/genetic|stock|transgene|combo/i.test(t)) return ['expression', 'stocks']
  if (/region_neuron_count|summarize_region|region_connections/i.test(t)) return ['class_list', 'connectivity']
  return []
}

/**
 * How a query's count should be described. Never emits a bare -1: 'many' becomes
 * a real lower bound, 'unknown' an instruction to run the query. Falls back to
 * the old count<0 test for digests built before countKind existed.
 */
export function countPhrase(q) {
  const kind = q?.countKind || (Number(q?.count) < 0 ? 'unknown' : 'exact')
  if (kind === 'many') return `more than ${PREVIEW_COUNT_CAP} — results exist, exact total not computed`
  if (kind === 'unknown') return 'available — run this query for the count'
  return String(q?.count)
}

/**
 * Every query every resolved term advertises, with the state it is in and how
 * relevant it is to the question.
 *
 * Returns [] when nothing resolved — callers treat an empty shelf as "no opinion",
 * never as "nothing available".
 */
export function buildShelf(ledger, question = ledger?.question) {
  const terms = Object.values(ledger?.terms || {}).filter(t => t?.id && Array.isArray(t?.digest?.queries) && t.digest.queries.length)
  if (!terms.length) return []

  const answeredSteps = new Set((ledger?.evidence || []).map(e => e.stepId).filter(Boolean))
  const plan = Array.isArray(ledger?.plan) ? ledger.plan : []

  // Named queries: a vfb_run_query step maps to exactly one shelf entry.
  const byKey = new Map()
  // Macro coverage: kind → set of term ids (or '*' when the macro named no term).
  const macroCovered = new Map()

  for (const s of plan) {
    const answered = answeredSteps.has(s.id)
    const id = s?.args?.id ? String(s.args.id) : ''
    if (s?.tool === 'vfb_run_query' && id && s?.args?.query_type) {
      const state = answered ? RUN
        : s.status === 'not_found' ? (s.empty_result ? EMPTY : FAILED)
          : UNRUN
      const key = `${id}::${String(s.args.query_type).toLowerCase()}`
      const prev = byKey.get(key)
      const next = { state, planned: true }
      if (!prev || STATE_RANK[state] > STATE_RANK[prev.state]) byKey.set(key, next)
      continue
    }
    // A macro only counts as coverage once it has actually produced something;
    // a pending or failed macro leaves its kinds exactly as unrun as they were.
    if (!answered) continue
    for (const kind of macroKinds(s?.tool)) {
      if (!macroCovered.has(kind)) macroCovered.set(kind, new Set())
      macroCovered.get(kind).add(id || '*')
    }
  }

  const out = []
  for (const t of terms) {
    const id = String(t.id)
    const termName = t.digest?.name || t.label || id
    for (const q of t.digest.queries) {
      if (!q?.query_type) continue
      const kind = querySemantics(q.query_type).kind
      const direct = byKey.get(`${id}::${String(q.query_type).toLowerCase()}`)
      const macro = macroCovered.get(kind)
      const state = direct ? direct.state
        : (macro && (macro.has(id) || macro.has('*'))) ? RUN
          : UNRUN
      out.push({
        id,
        termName,
        query_type: q.query_type,
        label: q.label || q.query_type,
        kind,
        count: q.count,
        countKind: q.countKind || (Number(q.count) < 0 ? 'unknown' : 'exact'),
        state,
        // A pending step is not coverage, but it is about to be — the sufficiency
        // pre-filter must not send the loop round again for a query already on
        // its way.
        planned: !!direct?.planned,
        relevance: labelOverlapScore(question, t.digest, q, listQueryWords)
      })
    }
  }
  return out
}

/** term::kind pairs that something has already run, or is about to. */
export function coveredKinds(shelf) {
  const out = new Set()
  for (const e of shelf) {
    if (e.state === UNRUN && !e.planned) continue
    out.add(`${e.id}::${e.kind}`)
  }
  return out
}

/**
 * Unrun queries the question asked for that nothing already run covers.
 *
 * This is the "we have not looked at what was asked" set, and it drives both the
 * sufficiency pre-filter and the one part of the shelf the answer is allowed to
 * recite.
 */
export function unansweredAsks(shelf) {
  const covered = coveredKinds(shelf)
  return shelf
    .filter(e => e.state === UNRUN && !e.planned && e.relevance > 0 && !covered.has(`${e.id}::${e.kind}`))
    .sort((a, b) => b.relevance - a.relevance)
}

// Per-group line caps. The shelf is ranked by relevance first, so a cap drops
// the queries least likely to be what was asked rather than an arbitrary tail.
const HELD_CAP = 12
const GROUP_CAP = 6
/** How many queries the answer may name out loud. */
const WORTH_SAYING_CAP = 2

function line(e, { withCount = true } = {}) {
  return `  ${e.termName} — ${e.label}${withCount ? ` (${countPhrase(e)})` : ''}`
}

function group(shelf, state, cap = GROUP_CAP) {
  return shelf
    .filter(e => e.state === state)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, cap)
}

/**
 * The AVAILABLE VFB DATA block, or '' when there is nothing worth saying.
 *
 * The heading is unchanged on purpose: the system prompt names it, and renaming
 * a heading the model has been told about is how a rule quietly stops applying.
 */
export function renderShelf(shelf) {
  if (!Array.isArray(shelf) || !shelf.length) return ''
  const ran = group(shelf, RUN)
  const empty = group(shelf, EMPTY)
  const failed = group(shelf, FAILED)
  const held = shelf.filter(e => e.state === UNRUN)
    .sort((a, b) => b.relevance - a.relevance)
  if (!ran.length && !empty.length && !failed.length && !held.length) return ''

  const asks = unansweredAsks(shelf).slice(0, WORTH_SAYING_CAP)
  const askKeys = new Set(asks.map(e => `${e.id}::${e.query_type}`))
  const heldShown = held.slice(0, HELD_CAP)
  const heldHidden = held.length - heldShown.length

  const parts = [
    '\n\nAVAILABLE VFB DATA for the resolved terms. Every query VFB offers for them is below, in one of four states.'
      + ' The states are not interchangeable: what you may write about a query depends entirely on which one it is in.'
  ]

  if (ran.length) {
    parts.push('\nRUN, WITH RESULTS — these ran in this session and their results are in EVIDENCE above.'
      + ' Answer from EVIDENCE. Never say one of these "has not been run".\n'
      + ran.map(e => line(e)).join('\n'))
  }
  if (empty.length) {
    parts.push('\nRUN, CAME BACK EMPTY — these ran and returned nothing.'
      + ' These, and only these, license an absence: for them write "VFB does not currently hold …" plainly,'
      + ' with no hedging and no suggestion that the query still needs running.\n'
      + empty.map(e => line(e, { withCount: false })).join('\n'))
  }
  if (failed.length) {
    // The counts stay on these lines. A lookup that fell over tells us nothing
    // about the holdings, and the holdings are still the honest thing to report:
    // "VFB holds 12 records here and the lookup for them did not complete" is an
    // answer, where "the lookup did not complete" alone is a shrug.
    parts.push('\nTRIED, NO RESULT — the lookup was attempted and did not complete. This is NOT an empty result and NOT an absence.'
      + ' You are FORBIDDEN to report one of these as data VFB lacks. The counts below are what VFB holds and are still true:'
      + ' say VFB holds them and that the lookup did not complete, or leave the query out entirely.\n'
      + failed.map(e => line(e)).join('\n'))
  }
  if (heldShown.length) {
    parts.push('\nHELD, NOT YET RUN — records VFB HOLDS, whose queries HAVE NOT BEEN RUN in this session.'
      + ' A query that was not run is not an empty query. You are FORBIDDEN to write "VFB does not currently hold data on …",'
      + ' "no data is available for …", or any other absence about anything in this group, however the question was worded'
      + ' — including when the question asks for exactly this and you have nothing else to say about it.\n'
      + heldShown.map(e => line(e)).join('\n')
      + (heldHidden > 0 ? `\n  …and ${heldHidden} further quer${heldHidden === 1 ? 'y' : 'ies'} for these terms, equally unrun and equally not absent.` : ''))
    // The recital licence, scoped. Supplied unconditionally this is what turned a
    // correct NBLAST answer into a catalogue read-back; withheld entirely, the
    // answer has nothing constructive to offer a question it could not run.
    if (asks.length) {
      parts.push('\nWORTH SAYING: the question asks for something in HELD, NOT YET RUN and nothing that ran covers it.'
        + ' For these, and only these, say VFB holds them, give the count, and say the query has not been run yet.'
        + ' Do not name any of the others: they are already shown beside the answer as clickable follow-up queries,'
        + ' and listing them in prose pads the answer without adding anything.\n'
        + asks.map(e => line(e)).join('\n'))
    } else {
      parts.push('\nDo not list the HELD group back to the reader: nothing in it is what was asked,'
        + ' and it is already shown beside the answer as clickable follow-up queries.'
        + ' It is here so you do not deny it, not so you can recite it.')
    }
  }
  // Suppress nothing else; askKeys exists only to keep the two lists consistent
  // if the caps are ever retuned.
  void askKeys
  return parts.join('\n')
}
