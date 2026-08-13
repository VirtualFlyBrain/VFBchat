// "VFB does not currently hold data on X" — who is allowed to write that, and
// when.
//
// THE RULE ALREADY EXISTS. NOTHING ENFORCED IT.
//
// coverage.mjs states the contract in its own header: of its four states, EMPTY
// — a query that ran and came back with nothing — is "the ONLY state that
// licenses absence". The prompt says so too, three times, in capitals. And in a
// blind evaluation of thirteen questions against production v4.2.1, eight of the
// thirteen answers asserted an absence anyway, every one of them without a
// single EMPTY query behind it:
//
//   S7   "VFB does not currently hold data describing the specific anatomical
//         layers, developmental origins, or synaptic terminal counts for the
//         lobula" — the lobula was never queried. Only the medulla was.
//   S14  "VFB does not currently hold data identifying any cholinergic mushroom
//         body output neurons" — the subclasses were never enumerated.
//   S23  "VFB does not currently hold data on whether DA1 lPN connectivity is
//         symmetric between the left and right hemispheres" — one connectivity
//         query had run; the hemisphere breakdown was never asked for.
//   S26, S46, S9 — the same shape again.
//
// The instruction is not weak. It is repeated, capitalised, and correct. It is
// simply an instruction, and a 397B model under a long prompt with a thin
// evidence block will still write the most fluent sentence available to it —
// and the most fluent sentence available to a model that has nothing to say
// about X is that there is nothing to say about X. The project already learned
// this lesson for counts (grounding.mjs: "the model narrates and the
// deterministic layer carries the numbers") and fixed it the same way: repair
// what is provably wrong after the fact, and leave everything else alone.
//
// WHAT THIS MODULE IS AND IS NOT
//
// It is not a fact-checker. It cannot tell whether VFB holds cholinergic MBONs.
// It answers one narrow, decidable question — DID ANY QUERY IN THIS RUN COME
// BACK EMPTY? — and if none did, then no sentence in the answer is entitled to
// claim VFB lacks anything, whatever the sentence is about. That is a statement
// about this run's evidence, not about fly neuroanatomy, and it needs no
// domain knowledge to be certain of.
//
// The asymmetry is the point. A false absence is a lie about the database that
// the reader has no way to detect and will act on — closing a line of enquiry
// that VFB could in fact have answered. A missing absence is a hedge. Trading
// the first for the second is worth doing even when the guard is sometimes
// unnecessary.

import { buildShelf, unmatchedNames, EMPTY, FAILED, UNRUN } from './coverage.mjs'

/**
 * How promising a query looks purely from its advertised count.
 *
 * 'many' outranks any exact figure — it means the count was capped rather than
 * small. An unknown count is worth more than a known zero, because a zero is the
 * one figure that guarantees the query cannot produce an answer.
 */
function countRank(e) {
  const kind = e?.countKind || (Number(e?.count) < 0 ? 'unknown' : 'exact')
  if (kind === 'many') return 3
  if (kind === 'unknown') return 1
  return Number(e?.count) > 0 ? 2 : 0
}

/**
 * What this ledger does and does not entitle the answer to say.
 *
 * `licensed` is the whole decision: true when at least one query reached EMPTY.
 * Everything else on the object exists so the caller can say something TRUE in
 * place of what it removes, and so the escalation path knows what is left to
 * try.
 */
export function absenceLicence(ledger) {
  const shelf = buildShelf(ledger)
  // A QUERY THIS GUARD CHOSE CANNOT LICENSE THE CLAIM IT WAS CHOSEN TO CHECK.
  //
  // Measured, and it is the failure that survived the first pass. S23 asks
  // whether DA1 lPN connectivity is symmetric between hemispheres. The draft
  // denied it; the escalation fired; nothing on the shelf scored above zero, so
  // the ranking fell back to the advertised counts and ran ListAllAvailableImages,
  // SplitsTargeting and TransgeneExpressionHere. One came back empty — and that
  // empty licensed EVERY absence sentence in the answer, including the one about
  // hemisphere symmetry, which no image query has anything to say about.
  //
  // So the guard manufactured its own permission. That is worse than the bug it
  // replaces, because the denial now ships with something that looks like
  // evidence behind it.
  //
  // The rule is narrow and deliberately conservative: an empty from a query the
  // ESCALATION picked does not license absence. These are speculative
  // alternatives chosen by a ranking that had nothing to rank on — that is the
  // situation they exist for — and an empty from a query nobody asked for is not
  // evidence about the thing the answer denied. A query the PLANNER ran, or one
  // the sufficiency check named, licenses absence exactly as it always did.
  //
  // The cost is real and is the right way round: a run where escalation genuinely
  // proves an absence gets it hedged rather than stated flatly. Hedging a true
  // absence is a worse answer; asserting a false one is a wrong answer.
  const speculative = new Set(
    (Array.isArray(ledger?.plan) ? ledger.plan : [])
      .filter(s => s?.absence_query && s?.args?.id && s?.args?.query_type)
      .map(s => `${s.args.id}::${String(s.args.query_type).toLowerCase()}`)
  )
  const isSpeculative = (e) => speculative.has(`${e.id}::${String(e.query_type).toLowerCase()}`)

  const empty = shelf.filter(e => e.state === EMPTY && !isSpeculative(e))
  const failed = shelf.filter(e => e.state === FAILED)
  // RANKED BY RELEVANCE, NOT FILTERED BY IT.
  //
  // The obvious rule is the shelf's own: only queries with some overlap with the
  // question are real alternatives, the rest are noise. Measured against the
  // question that motivated this module, that rule escalates nothing at all.
  // "Are any mushroom body output neurons cholinergic?" scores every query the
  // class advertises at relevance ZERO, because relevance measures a query
  // label's words against the question's and no label contains the word
  // "cholinergic" — while SubClasses, scoring zero, is precisely the query that
  // answers it, by enumerating the 34 subtypes and their transmitters.
  //
  // The shelf is right to filter, because its job is deciding what an answer may
  // SAY, and speaking about an unasked-for query is padding. This is a different
  // decision with a different cost: the alternative to running a poorly-scoring
  // query here is telling a researcher that a public database holds nothing.
  // Three round trips is the cheaper mistake, so relevance orders the attempts
  // instead of vetoing them.
  //
  // Count is the tiebreak, and a query advertising zero records sorts last
  // rather than being dropped: running it produces a genuine EMPTY, which turns
  // an unlicensed denial into a licensed one. That is a good outcome, just not
  // the one to spend the first attempt on.
  const unrun = shelf
    .filter(e => e.state === UNRUN && !e.planned)
    .sort((a, b) => (b.relevance - a.relevance) || (countRank(b) - countRank(a)))
  const unmatched = unmatchedNames(ledger)
  return {
    licensed: empty.length > 0,
    empty,
    failed,
    unrun,
    unmatched,
    // Is there anything left to do about it? This is the question the harness
    // asks before deciding whether to concede or to go round again.
    escalable: failed.length > 0 || unrun.length > 0 || unmatched.length > 0
  }
}

// --- detecting the claim -----------------------------------------------------
//
// Harvested from what production actually wrote, not from what an absence could
// in principle look like. The dominant form by a wide margin is the exact
// sentence the coverage prompt supplies as the licensed wording — "VFB does not
// currently hold …" — which is not a coincidence: the model is copying the
// sentence it was given, into contexts that did not earn it.
//
// Each pattern needs a SUBJECT that is VFB or its data. "The neuron has no
// presynaptic terminals in the calyx" is a fact about a neuron and must survive;
// "VFB has no data on the calyx" is a claim about the database and must not.
// That distinction is carried by requiring one of the database words within a
// short window before the negation, rather than by matching the negation alone.

const DB = '(?:VFB|Virtual Fly Brain|the database|the current data|VFB\'s (?:records|data|holdings))'
const GAP = '[^.!?\\n]{0,30}'

/** One absence pattern and the short, stable name it is logged under. */
const entry = (slug, re) => ({ slug, re })

// EACH PATTERN CARRIES A SLUG, AND THE SLUG IS WHAT GETS LOGGED.
//
// The escalation and gate lines used to print the matched sentence itself. That
// sentence is prose the model wrote, and the model writes an absence by
// restating the question — so the user's wording came back out of it and into
// the cluster log aggregator, outside governance.js's file mode and outside
// pruneRetention. Logging the sentence's LENGTH would have closed that and left
// nothing behind; logging which pattern matched keeps the more useful half. The
// rate at which each SHAPE of denial fires is a property of the deployment, it
// is countable across runs in a way a free-text sentence never was, and it
// contains nothing of the user's.
const ABSENCE_PATTERNS = [
  // VFB does not (currently) hold / have / contain / include / provide / list …
  entry('does-not-hold', new RegExp(`${DB}${GAP}\\b(?:does not|doesn't|do not|don't)\\b[^.!?\\n]{0,20}\\b(?:hold|have|contain|include|provide|list|store|offer|record)s?\\b`, 'i')),
  // VFB has no … / there are no records in VFB … / no data is available in VFB
  entry('has-no', new RegExp(`${DB}${GAP}\\b(?:has|have|holds?|contains?)\\s+no\\b`, 'i')),
  entry('no-data-in', new RegExp(`\\bno\\s+(?:data|records?|information|images?|entries|annotations?)\\b${GAP}\\b(?:in|for|from|within)\\s+${DB}`, 'i')),
  entry('lacks', new RegExp(`${DB}${GAP}\\b(?:lacks|is missing|are missing)\\b`, 'i')),
  // … are not present in / not available in / not provided in the current data.
  //
  // "provided", "listed" and "given" were not in this list and a live run walked
  // straight through the gap: "specific counts for neurons with synaptic,
  // presynaptic, or postsynaptic terminals in the medulla, as well as the total
  // number of lineage clones, are not provided in the current data" — every one
  // of which VFB holds and advertises a query for. The verb a model reaches for
  // is not fixed, so the list has to cover the family rather than the instance.
  entry('is-not-present-in', new RegExp(`\\b(?:is|are|were|was)\\s+not\\s+(?:present|available|found|included|recorded|annotated|provided|listed|given|shown|reported|captured|specified|detailed)\\b${GAP}\\b(?:in|for|within|by)\\s+${DB}`, 'i')),
  // "no such records exist" / "there is no record of X" with VFB nearby
  entry('there-is-no', new RegExp(`\\bthere (?:is|are) no\\b${GAP}\\b(?:record|data|entry|entries|image)s?\\b`, 'i')),
  // THE EVIDENCE BLOCK, TALKING ABOUT ITSELF, IN VFB'S NAME.
  //
  // harnessFraming rewrites "the provided evidence" to "VFB evidence", which
  // reads to a user as a statement about the database. Its author deliberately
  // declined to rewrite the NEGATIVE forms — turning "the evidence does not
  // provide X" into "VFB does not record X" would upgrade a limit of this answer
  // into a claim about VFB, which is the invention that module exists to stop.
  // Correct, and it leaves the sentence in place:
  //
  //   "VFB evidence lists queries for subclasses ... but it does not include a
  //    completed query or result set identifying specific types lacking images."
  //
  // Deleting it is the move neither module was making. It is not a claim about
  // fly anatomy that a reader loses, it is a description of this program's
  // working set, and the gap between subject and negation is long here — the
  // sentence recites a whole catalogue first — so this pattern gets a long window
  // that the specificity of its subject pays for.
  entry('evidence-does-not', new RegExp('\\b(?:VFB|the|this)\\s+evidence\\b[^.!?\\n]{0,160}?\\b(?:does not|doesn\'t|do not)\\s+(?:include|contain|provide|list|show|specify|report)\\b', 'i'))
]

/** Split into sentences, keeping each sentence's offset so a repair can be spliced back. */
function sentences(text = '') {
  const out = []
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g
  for (const m of String(text).matchAll(re)) {
    if (m[0].trim()) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * Sentences claiming VFB lacks something.
 *
 * Markdown links are masked before matching. A linkified term name can run to
 * two hundred characters of URL and would otherwise blow past every {0,30}
 * window in the patterns above — which is exactly what happened to three of the
 * production sentences, where the absence and its object were separated by a
 * report URL.
 */
export function findAbsenceClaims(text = '') {
  const src = String(text)
  const masked = src.replace(/\[([^\]]*)\]\([^)]*\)/g, (m, label) => label + ' '.repeat(m.length - label.length))
  return sentences(masked)
    .map(s => ({ s, hit: ABSENCE_PATTERNS.find(p => p.re.test(s.text)) }))
    .filter(({ hit }) => Boolean(hit))
    // `pattern` is the slug of the FIRST pattern that matched. First rather than
    // all of them: the patterns overlap by design and a list of three slugs says
    // less than the most specific one that fired.
    .map(({ s, hit }) => ({ ...s, text: src.slice(s.start, s.end), pattern: hit.slug }))
}

// --- saying something true instead -------------------------------------------

/**
 * The replacement sentence for an unlicensed absence.
 *
 * Three cases, in the order they are worth telling the reader about:
 *
 *  - a name never matched: the honest, actionable statement, and the one the
 *    reader can do something with, because the candidate list is right there.
 *  - a lookup failed: a fact about the lookup, which we may state, as opposed to
 *    a fact about the holdings, which we may not.
 *  - nothing else: say that it was not established, in the first person.
 *
 * Note what none of these say. "The query has not been run yet" is banned
 * project-wide as harness framing and it is banned here for the same reason:
 * the reader has no session and cannot run anything, so that sentence describes
 * this program rather than VFB. "I could not confirm X" is a statement about
 * what this answer established, which is true, useful, and about the answer.
 */
function replacementFor(licence) {
  const named = licence.unmatched.filter(u => !u.truncated)
  if (named.length) {
    const list = named.slice(0, 2).map(u => `"${u.name}"`).join(' or ')
    const near = named[0].candidates.slice(0, 3).filter(Boolean)
    return near.length
      ? `I could not match ${list} to a VFB term; the closest records found were ${near.join(', ')}.`
      : `I could not match ${list} to a VFB term, so I cannot speak to what VFB holds for it.`
  }
  if (licence.failed.length) {
    return 'That lookup did not complete, so this answer cannot say what VFB holds there.'
  }
  return 'I could not establish that from the VFB records consulted here.'
}

/**
 * Is the replacement worth saying, or should the sentence just go?
 *
 * Measured on the first live run of this guard. The answer was a good one —
 * 7,283 images, 8 split-GAL4 patterns, 10 named subclasses — with one
 * unlicensed sentence in the middle of it about a count VFB had not
 * pre-computed. Spliced in, the replacement read:
 *
 *   "...KCg-s1, KCg-s2, KCg, and KCg-s3.
 *    I could not establish that from the VFB records consulted here.
 *    The term "γ Kenyon cells" refers to the same entity as gamma Kenyon cell."
 *
 * "That" has no referent once the sentence it referred to is gone, so the
 * replacement reads as a non-sequitur dropped into a paragraph it has nothing to
 * do with — and it tells the reader nothing they can act on.
 *
 * An unmatched NAME is different, and is the one case worth interrupting for:
 * it is specific, it explains why a subject is missing from the answer, and the
 * near-matches beside it are the reader's next move. So the rule is: say
 * something only when there is something to say. Otherwise take the false
 * sentence out and let the answer stand on what it got right.
 */
function replacementIsWorthSaying(licence) {
  return licence.unmatched.some(u => !u.truncated)
}

/**
 * Replace unlicensed absence claims with a truthful statement, or drop them.
 *
 * DROPPING VS REPLACING
 *
 * A replacement is spliced in only for the FIRST unlicensed absence. The rest
 * are removed. Three sentences in a row all saying "I could not establish that"
 * reads worse than the false version did and buries whatever the answer got
 * right — and S14 and S46 both wrote the same denial three times in one answer,
 * so this is the common case rather than a corner.
 *
 * If removing them would leave nothing at all, the replacement is kept as the
 * whole answer. A short honest answer is a worse answer than a good one and a
 * better answer than a confident false one.
 *
 * Returns { text, repairs } where repairs is what was taken out, for the log.
 */
export function repairUnlicensedAbsences(answerText = '', licence) {
  const src = String(answerText)
  if (!licence || licence.licensed) return { text: src, repairs: [] }
  const claims = findAbsenceClaims(src)
  if (!claims.length) return { text: src, repairs: [] }

  const replacement = replacementFor(licence)
  const splice = replacementIsWorthSaying(licence)
  let out = ''
  let cursor = 0
  let first = true
  for (const c of claims) {
    out += src.slice(cursor, c.start)
    if (first && splice) {
      // Carry the matched sentence's trailing whitespace so paragraph breaks in
      // the surrounding prose survive the splice.
      out += replacement + (c.text.match(/\s*$/)?.[0] || '')
    }
    first = false
    cursor = c.end
  }
  out += src.slice(cursor)

  const cleaned = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .trimEnd()

  return {
    text: cleaned.trim() ? cleaned : replacement,
    repairs: claims.map(c => c.text.trim()),
    // The same repairs named by pattern rather than quoted. Callers that write
    // to the container log use these; the strings above are for the trace, which
    // is off unless VFB_HARNESS_TRACE is set.
    patterns: claims.map(c => c.pattern)
  }
}

// --- doing something about it instead ----------------------------------------

/**
 * How many extra queries an about-to-deny answer may buy itself.
 *
 * Three, matching sufficiency's MAX_INJECTED, and for the same reason: it is
 * enough to cover a question with two subjects and one missing axis, and it is
 * few enough that the round budget and the run deadline still mean something.
 * The escalation fires at most once per question.
 */
export const MAX_ESCALATION_STEPS = 3

/**
 * The queries to run before conceding that VFB holds nothing.
 *
 * ORDER IS THE POLICY, and it is ordered by what the failure most likely was.
 *
 *  1. FAILED first. A lookup that fell over is the one case where we have
 *     positive evidence that the absence is an artefact — VFB's own catalogue
 *     says the records are there and the fetch for them did not land. Retrying
 *     it is the cheapest possible way to turn a denial into an answer, and if it
 *     fails twice the shelf still forbids denying it.
 *
 *  2. Then the most relevant UNRUN queries. This is the S14/S23/S46 shape: the
 *     term resolved, one query ran, the question asked about an axis nothing
 *     covered, and the answer denied the axis rather than the term. VFB is
 *     advertising the query that answers it in the same digest the answer was
 *     written from.
 *
 * Deduplicated by term-and-query so a query already queued twice does not eat
 * two of the three slots.
 */
export function planAbsenceEscalation(licence, cap = MAX_ESCALATION_STEPS) {
  const out = []
  const seen = new Set()
  for (const e of [...licence.failed, ...licence.unrun]) {
    const key = `${e.id}::${String(e.query_type).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: e.id, query_type: e.query_type, label: e.label, termName: e.termName, wasFailed: e.state === FAILED })
    if (out.length >= cap) break
  }
  return out
}
