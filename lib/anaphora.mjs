// The question the user typed that a chip had already offered.
//
// ## The measurement this exists to fix
//
//   turn 1  "what is the medulla?"                    10s   (fast-path, no planner)
//           ...offers the chip "Which neurons receive output from the medulla?"
//   turn 2  "which neurons receive output from it?"  381s
//
// Turn 2 is turn 1's own chip, retyped with a pronoun. Clicking it costs one
// deterministic query. Typing it costs a planner call — and on a follow-up the
// planner is CONTESTED (the three votes disagree, because "it" is genuinely
// ambiguous to a model reading the question cold), which buys a second sampling
// round: 78s, then 180s more, before any VFB query has run at all. Worse has been
// seen: a run where the escalation round's samples each burned the full 240s
// per-attempt budget three times over sat at "Planning the answer" for 18 minutes.
//
// The information needed to skip all of that was already in hand. The previous
// turn resolved `medulla` to FBbt_00003748 and carried its query catalogue across
// the boundary in `context.terms`. `NeuronsPostsynapticHere` is in that catalogue,
// and lib/followOns.mjs generated the chip's English from a template. So the
// question "which neurons receive output from it?" can be matched back to the
// (id, query_type) that produced it WITHOUT a model, by the same table that wrote
// it in the first place.
//
// ## Why matching, not "resolve the pronoun and re-plan"
//
// Substituting the antecedent and re-planning would still cost the planner call,
// and the planner is the slow, contested, occasionally-wrong part. The point here
// is not to help the planner; it is to notice that this particular question does
// not need one, because we generated it.
//
// ## Precision over recall, deliberately
//
// A false positive answers a different question than the one asked, silently and
// confidently — much worse than the 381s it saves. So every rule below is a veto,
// and anything that is not an unambiguous match falls through to the planner,
// which is exactly as good as it is today. In particular:
//
//   - the question must be SHORT and SINGLE-CLAUSE (no "and", "compare", "why",
//     "how many"): a compound question is not a chip, whatever it contains;
//   - the content words must match ONE query signature exactly, or be a subset of
//     exactly one — two candidates means we do not know, so we do not guess;
//   - the query_type must be in THAT TERM'S OWN carried catalogue, so we never
//     route to a query VFB does not hold for the entity;
//   - a catalogue entry known to be exactly zero is not a match, for the same
//     reason lib/followOns.mjs will not offer it as a chip.
//
// Pure and offline-testable: no network, no model, no ledger.

/** Words that carry no discriminating meaning in a chip-shaped question. */
const STOP = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'from', 'for', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'has', 'have', 'had',
  'what', 'which', 'who', 'whom', 'whose', 'show', 'me', 'list', 'tell', 'give',
  'there', 'here', 'any', 'all', 'its', 'their', 'it', 'them', 'they', 'this',
  'that', 'these', 'those', 'one', 'ones', 'please', 'can', 'you', 'i', 'about',
  's', 'and2'
])

/** Pronouns and deictics that stand in for a term established earlier. */
const ANAPHOR_RE =
  /(?<!\w)(it|its|them|they|their|there|this|that|these|those|the (?:same|region|neuropil|area|structure|term|cell type|neuron type|type)|the one)(?!\w)/i

/**
 * Pro-forms that commit to MORE THAN ONE antecedent.
 *
 * Deliberately narrower than ANAPHOR_RE, and the omissions are the point.
 * "their" and "these" are plural but they are not evidence of a plural
 * ANTECEDENT: in "which neurons have part of their arbour there?" the possessor
 * of the arbour is the answer set, not the thing being asked about, and reading
 * "their" as "two carried terms" would drag an unrelated earlier entity into a
 * question about one region. Only the forms that can stand alone as the OBJECT
 * of the question count — "connect them", "compare those" — because those are
 * the ones whose referent must already exist.
 */
const PLURAL_ANAPHOR_RE = /(?<!\w)(them|they|both|those two|the two|these two)(?!\w)/i

/** A question that writes an id outright is not pointing at anything. */
const EXPLICIT_ID_RE = /(?<!\w)(?:FBbt|FBgn|FBal|FBti|FBtp|FBco|FBlc|FBrf|VFBexp|VFB)_[0-9a-zA-Z]+/

/**
 * Compound / non-chip cues. A question containing one of these is asking for
 * something a single typed query cannot deliver, so it belongs to the planner
 * even when its content words happen to line up with a template.
 *
 * "how many" is here on purpose: the count path has its own deterministic router
 * (maybeInjectCountQueryStep) and its own type-vs-token semantics, and quietly
 * turning a count question into a list query would answer the wrong one of the
 * three questions "how many" can mean.
 */
const NOT_A_CHIP_RE =
  /(?<!\w)(and|or|but|also|compare|comparison|versus|vs\.?|difference|differ|both|why|how many|how much|number of|count|explain|instead|except|without|rather|then|after that|each)(?!\w)/i

/**
 * Content signatures per query type: the discriminating words a user writes when
 * they mean this query, with the term itself and the stop words removed.
 *
 * The FIRST signature of each entry is the one lib/followOns.mjs' own ASK_TEMPLATE
 * reduces to, so a chip retyped verbatim always matches. The rest are the ordinary
 * paraphrases of it. They are written out rather than inferred because a wrong
 * synonym here silently reroutes a question, and a table can be reviewed.
 */
const SIGNATURES = {
  NeuronsPresynapticHere: [
    ['neurons', 'provide', 'input'],
    ['neurons', 'input'],
    ['neurons', 'presynaptic'],
    ['neurons', 'send', 'input'],
    ['neurons', 'project', 'into'],
    ['neurons', 'innervate'],
    ['neurons', 'upstream']
  ],
  NeuronsPostsynapticHere: [
    ['neurons', 'receive', 'output'],
    ['neurons', 'output'],
    ['neurons', 'postsynaptic'],
    ['neurons', 'receive', 'input'],
    ['neurons', 'downstream'],
    ['neurons', 'read', 'out']
  ],
  NeuronsPartHere: [
    ['neurons', 'part', 'arbour'],
    ['neurons', 'arbour'],
    ['neurons', 'arborise'],
    ['neurons', 'arborize'],
    ['neurons', 'branch']
  ],
  NeuronsSynaptic: [
    ['neurons', 'synaptic', 'terminals'],
    ['neurons', 'synapse'],
    ['neurons', 'terminals']
  ],
  SubclassesOf: [
    ['subtypes'],
    ['subclasses'],
    ['types'],
    ['kinds'],
    ['sorts'],
    ['varieties']
  ],
  PartsOf: [
    ['anatomical', 'parts'],
    ['parts'],
    ['subregions'],
    ['subdivisions'],
    ['components'],
    ['compartments'],
    ['layers'],
    ['made', 'up']
  ],
  ExpressionOverlapsHere: [
    ['gal4', 'expression', 'patterns', 'label'],
    ['gal4', 'expression', 'patterns'],
    ['expression', 'patterns', 'label'],
    ['expression', 'patterns'],
    ['gal4', 'patterns'],
    ['expression', 'overlaps']
  ],
  TransgeneExpressionHere: [
    ['driver', 'lines', 'label'],
    ['driver', 'lines'],
    ['drivers'],
    ['gal4', 'lines', 'label'],
    ['gal4', 'lines'],
    ['lines', 'label'],
    ['split', 'gal4', 'lines'],
    ['transgenes']
  ],
  DownstreamClassConnectivity: [
    ['connect', 'downstream'],
    ['downstream', 'partners'],
    ['downstream', 'targets'],
    ['targets'],
    ['project', 'onto'],
    ['outputs', 'go']
  ],
  UpstreamClassConnectivity: [
    ['connect', 'upstream'],
    ['upstream', 'partners'],
    ['upstream', 'sources'],
    ['sources'],
    ['feeds', 'into']
  ],
  NeuronInputsTo: [
    ['strongest', 'inputs'],
    ['main', 'inputs'],
    ['principal', 'inputs'],
    ['biggest', 'inputs']
  ]
}

/**
 * Light stemming: enough for English plurals and -ing/-ed, no more.
 *
 * The property that matters is not linguistic correctness but SYMMETRY: a word
 * and its inflections must land on the same stem, because the signature table is
 * stemmed by this same function. That is why the trailing -e is dropped
 * unconditionally rather than restored after -ing/-ed: "innervate", "innervates"
 * and "innervating" all have to reduce to "innervat", or the table matches only
 * the tense the table happens to be written in.
 */
function undouble(w) {
  const n = w.length
  if (n > 3 && w[n - 1] === w[n - 2] && !'aeiou'.includes(w[n - 1])) return w.slice(0, -1)
  return w
}

function stem(word) {
  let w = word
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (w.length > 4 && (w.endsWith('ses') || w.endsWith('ches') || w.endsWith('shes'))) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3))
  else if (w.length > 4 && w.endsWith('ed')) w = undouble(w.slice(0, -2))
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

/** Words of a phrase, lowercased, stemmed, stop words dropped. */
function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]+/g, ' ')
    .split(/[\s/-]+/)
    .filter(Boolean)
    .filter(w => !STOP.has(w))
    .map(stem)
    .filter(Boolean)
}

const setOf = (words) => new Set(words)
const isSubset = (a, b) => [...a].every(w => b.has(w))
const sameSet = (a, b) => a.size === b.size && isSubset(a, b)

/** Precomputed, stemmed signature sets — built once, not per request. */
const SIGNATURE_SETS = Object.freeze(Object.fromEntries(
  Object.entries(SIGNATURES).map(([qt, sigs]) => [qt, sigs.map(s => setOf(s.flatMap(contentWords)))])
))

/** Every query type this module can recognise — used by tests and by callers. */
export const RECOGNISED_QUERY_TYPES = Object.freeze(Object.keys(SIGNATURES))

/**
 * A catalogue entry is a live option unless it is known to hold exactly nothing.
 * Mirrors lib/followOns.mjs: a -1 means "the total is not known exactly", never
 * "the data is absent", so it stays offerable.
 */
function catalogueHas(term, queryType) {
  const q = (term?.queries || []).find(x => x?.query_type === queryType)
  if (!q) return false
  if (q.countKind === 'exact' && !(Number(q.count) > 0)) return false
  return true
}

/**
 * Strip the words of a term's own names out of the question's content words, so
 * "which neurons receive output from the medulla?" and "...from it?" reduce to the
 * same signature. Only the named term's words are removed — never another term's,
 * or a question about the lobula would reduce like a question about the medulla.
 */
function withoutTermWords(questionWords, term) {
  const termWords = new Set([
    ...contentWords(term?.label || ''),
    ...contentWords(term?.name || '')
  ])
  return questionWords.filter(w => !termWords.has(w))
}

/** Does the question name this term outright? */
function questionNamesTerm(questionWords, term) {
  const names = [term?.label, term?.name].filter(Boolean)
  const asked = new Set(questionWords)
  return names.some(n => {
    const words = contentWords(n)
    return words.length > 0 && words.every(w => asked.has(w))
  })
}

/**
 * Match one term's catalogue against the question, returning the query types that
 * fit. Exact signature matches are returned in preference to subset matches: a
 * subset is a weaker reading and should never outvote a question that lines up
 * word for word.
 */
function candidatesForTerm(question, term) {
  const asked = setOf(withoutTermWords(contentWords(question), term))
  if (asked.size === 0) return { exact: [], subset: [] }

  const exact = []
  const subset = []
  for (const queryType of RECOGNISED_QUERY_TYPES) {
    if (!catalogueHas(term, queryType)) continue
    const sigs = SIGNATURE_SETS[queryType]
    if (sigs.some(sig => sameSet(asked, sig))) exact.push(queryType)
    else if (sigs.some(sig => isSubset(asked, sig))) subset.push(queryType)
  }
  return { exact, subset }
}

/**
 * Resolve a typed question against what earlier turns established.
 *
 * @param {string} question         what the user typed this turn
 * @param {object} priorContext     a SANITIZED context (lib/conversationContext.mjs)
 * @returns {{id, query_type, label, via}|null}  the chip this question is, or null
 *
 * `via` records which of the two readings fired, so the trace says why:
 *   'named'   the question names the term outright — it is that term's chip
 *   'anaphor' the question points back ("it", "them") — it is the most recently
 *             resolved term's chip, and only when there is no competing reading
 */
export function resolveQuestionToChip(question, priorContext) {
  const text = String(question || '').trim()
  if (!text) return null

  // Cheap vetoes first, in cost order.
  const words = text.split(/\s+/)
  if (words.length > 14) return null
  if (NOT_A_CHIP_RE.test(text)) return null

  const terms = Array.isArray(priorContext?.terms) ? priorContext.terms : []
  if (terms.length === 0) return null

  const questionWords = contentWords(text)
  if (questionWords.length === 0) return null

  // Reading 1: the question names one of the carried terms. That term wins
  // outright — an explicit name is not ambiguous, whatever else is in context.
  const named = terms.filter(t => questionNamesTerm(questionWords, t))
  if (named.length === 1) {
    const hit = pickSingle(candidatesForTerm(text, named[0]))
    return hit ? { id: named[0].id, query_type: hit, label: named[0].label, via: 'named' } : null
  }
  // Two carried terms both named in one short question is a comparison, not a
  // chip. Fall through rather than picking a side.
  if (named.length > 1) return null

  // Reading 2: the question points back at something. `terms` is most-recent-first
  // (see mergeContext), so the antecedent of "it" is terms[0] — the entity the
  // conversation is currently about.
  if (!ANAPHOR_RE.test(text)) return null
  const hit = pickSingle(candidatesForTerm(text, terms[0]))
  return hit ? { id: terms[0].id, query_type: hit, label: terms[0].label, via: 'anaphor' } : null
}

/** One unambiguous winner, or nothing. Exact beats subset; ties lose. */
function pickSingle({ exact, subset }) {
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  if (subset.length === 1) return subset[0]
  return null
}

// ---------------------------------------------------------------------------
// The subject that exists only in the conversation
// ---------------------------------------------------------------------------
//
// resolveQuestionToChip above is the FAST path: it recognises a question as one
// of our own chips and answers it with a single query. This is the SAFETY NET
// underneath it, and it exists because of a failure that is worse than slowness.
//
//   turn 1  "What are the anatomical parts of the medulla? List them."
//   turn 2  "And which neurons have part of their arbour there?"
//
//     The term "medulla" from your question could not be matched to a specific
//     VFB record in this session, so no list of neurons with arbours in that
//     region can be generated from the database.
//
// — with "medulla" rendered, in that same sentence, as a working hyperlink to
// FBbt_00003748. The answer denies knowing an id it is simultaneously printing.
//
// The mechanism is a chain of individually reasonable steps. The question names
// no term, so the planner honestly returns terms_to_resolve: [] and steps with
// no args. contextTermsNamedIn adopts only terms the question LITERALLY NAMES,
// and "there" names nothing, so nothing is adopted. The steps dispatch with
// args:{}, the tool errors, the steps are marked not_found — and not_found is
// read downstream as "VFB holds nothing", which is a claim about the database
// made on the strength of a call that was never made. The link renderer,
// working from the carried registry rather than from this turn's steps, resolves
// the term perfectly. Hence the contradiction inside one sentence.
//
// So: when a turn would otherwise have NO subject at all, the subject is the one
// the conversation is already about. That is not a guess — `terms` is
// most-recent-first (see mergeContext), so terms[0] is the entity under
// discussion, exactly as resolveQuestionToChip's anaphor reading already assumes.
//
// Names, not ids, are returned, for the same reason contextTermsNamedIn returns
// names: adopting the carried DIGEST would carry stale counts into a fresh
// answer, whereas re-resolving takes the directId short-circuit and costs one
// term-info fetch for this turn's numbers.

/**
 * The carried terms a subjectless follow-up is about.
 *
 * @param {string} question      what the user typed this turn
 * @param {object} priorContext  a SANITIZED context (lib/conversationContext.mjs)
 * @param {{max?: number}} opts
 * @returns {Array} carried context terms, most-recent-first; empty if none apply
 *
 * The caller must have established that the turn has no subject of its own —
 * see the guard in lib/orchestrator.mjs. This function re-checks what it cheaply
 * can (an id written out, a carried term named outright) so that it is safe to
 * call standalone, but it cannot see the plan and does not try to.
 */
export function contextTermsForAnaphor(question, priorContext, { max = 2 } = {}) {
  const text = String(question || '').trim()
  if (!text) return []

  const terms = Array.isArray(priorContext?.terms) ? priorContext.terms : []
  if (terms.length === 0) return []

  // A question carrying an id is not pointing back at anything; it says what it
  // means and the ordinary path can resolve it.
  if (EXPLICIT_ID_RE.test(text)) return []

  // Nor is one that names a carried term outright — that is contextTermsNamedIn's
  // job, and it matches on the term's own wording rather than on recency.
  const questionWords = contentWords(text)
  if (terms.some(t => questionNamesTerm(questionWords, t))) return []

  // There must be something standing in for the subject. Without this, EVERY
  // question the planner failed to extract a term from would adopt the last
  // entity discussed, including a genuine change of topic the planner merely
  // mishandled — and answering about the wrong entity is the failure this whole
  // module refuses to trade latency for.
  if (!ANAPHOR_RE.test(text)) return []

  // How many the pro-form commits to. Capped at what the conversation actually
  // holds: "connect them" after a single-term conversation is still about that
  // one term, and inventing a second antecedent to satisfy the grammar would be
  // answering a question nobody asked.
  const wanted = PLURAL_ANAPHOR_RE.test(text) ? Math.min(2, max) : 1
  return terms.slice(0, Math.max(1, Math.min(wanted, max)))
}

// ---------------------------------------------------------------------------
// The same question with no conversation behind it
// ---------------------------------------------------------------------------
//
// resolveQuestionToChip needs a previous turn, because it resolves the ANTECEDENT
// from one. But the templates are ours whether or not a conversation exists, and
// the cold case was measurably worse than the warm one:
//
//   "What are the anatomical parts of the medulla?"   (turn 1, no context)
//     -> "The name 'anatomical parts of the medulla' could not be matched to a
//         VFB term. No candidate terms were found for this wording."   9s, 0 chips
//
// That is lib/followOns.mjs' own PartsOf chip, typed as the first thing a user
// says — and detectFastPath read the whole noun phrase as the entity and searched
// VFB for it. The question was never ambiguous: the template names the query type
// and everything left over is the term.
//
// So: subtract the template's words from the question and see what remains. If
// what remains is a single contiguous run of content words, that run IS the term
// name, and the query type is the template it was subtracted from. The term still
// has to be resolved against VFB (unlike the warm path, which already holds an
// id), so this returns a NAME, and the caller resolves it exactly as the ordinary
// fast path resolves its subject.
//
// The contiguity requirement is the whole safety argument. "Which neurons receive
// output from the medulla?" leaves {medulla}: one run, accepted. Match the same
// question against the weaker signature ['neurons','output'] and the leftovers are
// {receive, medulla} — which are NOT adjacent, because "output" sits between them,
// so that reading is discarded without needing a tie-break rule. A term name is a
// noun phrase; a noun phrase is contiguous; anything scattered through the
// sentence is a verb the template did not account for, and the planner should see
// it instead.

/** Word tokens with their positions, so "contiguous" can mean something. */
function tokensWithPositions(text) {
  const out = []
  const re = /[A-Za-z0-9]+/g
  let m
  while ((m = re.exec(text)) !== null) {
    const lower = m[0].toLowerCase()
    out.push({ lower, stem: stem(lower), start: m.index, end: m.index + m[0].length, stop: STOP.has(lower) })
  }
  return out
}

/** Leading grammar that is never part of a VFB label. */
const TERM_LEAD_RE = /^\s*(?:the|a|an|any|all|each|every|some)\s+/i
const MAX_TERM_WORDS = 5
const MAX_TERM_CHARS = 60

/**
 * Placeholder nouns that stand in for an entity instead of naming one.
 *
 * These exist because the anaphor veto had to go: "Which neurons have part of
 * their arbour in the {term}?" is one of our own templates and contains "their",
 * so vetoing on any anaphor would have refused the chip this module was written
 * to recognise. Pronouns need no veto — they are stop words, so they never reach
 * the residual — but "that structure" and "the same region" leave a noun behind,
 * and searching VFB for "structure" is how a wrong answer starts.
 */
const PLACEHOLDER_TERM_RE =
  /^(?:same|other|another|one|ones|thing|things|region|regions|area|areas|structure|structures|term|terms|type|types|kind|kinds|sort|sorts)$/i

/**
 * Everything the signature did not claim, if it is one contiguous noun phrase.
 * @returns {string|null} the term name as the user wrote it, or null
 */
function residualTerm(text, contentTokens, signature) {
  const residual = []
  for (let i = 0; i < contentTokens.length; i++) {
    if (!signature.has(contentTokens[i].stem)) residual.push(i)
  }
  if (residual.length === 0 || residual.length > MAX_TERM_WORDS) return null
  // Contiguous in CONTENT tokens: stop words ("of", "the") may sit inside the
  // span, other signature words may not.
  for (let i = 1; i < residual.length; i++) {
    if (residual[i] !== residual[i - 1] + 1) return null
  }
  const first = contentTokens[residual[0]]
  const last = contentTokens[residual[residual.length - 1]]
  const raw = text.slice(first.start, last.end)
  const name = raw.replace(TERM_LEAD_RE, '').replace(/\s{2,}/g, ' ').trim()
  if (!name || name.length > MAX_TERM_CHARS) return null
  // A number on its own is a quantity, not an entity.
  if (!/[A-Za-z]/.test(name)) return null
  if (name.split(/\s+/).every(w => PLACEHOLDER_TERM_RE.test(w))) return null
  return name
}

/**
 * Read a question as one of our own chip templates applied to a named term.
 *
 * @param {string} question
 * @returns {{query_type:string, term:string, via:'template'}|null}
 *
 * Needs no context and does no I/O. Returns null for anything that is not an
 * exact template reading with exactly one plausible term, because the fallback —
 * the ordinary fast path, then the planner — is no worse than today.
 */
export function resolveQuestionToTemplate(question) {
  const text = String(question || '').trim()
  if (!text) return null
  if (text.split(/\s+/).length > MAX_QUESTION_WORDS) return null
  if (NOT_A_CHIP_RE.test(text)) return null

  // Sentence by sentence, because a residual must never cross a full stop.
  //
  // "Which neurons provide input to the medulla? give me a table" is one
  // question and one presentation directive. Read as a single string the
  // signature claims {neuron, provide, input} and the contiguous remainder is
  // "medulla? give me a table" — which VFB is then asked to resolve as a term
  // name. Segmenting first costs nothing and makes the trailing directive
  // simply a sentence with no template in it.
  const hits = []
  for (const segment of text.split(/[.?!;\n]+/)) {
    const seg = segment.trim()
    if (!seg || seg.split(/\s+/).length > MAX_SEGMENT_WORDS) continue
    const hit = templateInSegment(seg)
    if (hit) hits.push(hit)
  }
  // Two sentences that each name a template are two questions, and this module
  // answers exactly one.
  const distinctHits = new Set(hits.map(h => `${h.query_type} :: ${h.term.toLowerCase()}`))
  if (distinctHits.size !== 1) return null
  if (!COLD_TEMPLATE_QUERY_TYPES.has(hits[0].query_type)) return null
  return { query_type: hits[0].query_type, term: hits[0].term, via: 'template' }
}

/**
 * The chips whose query IS the whole answer path, and which may therefore be
 * recognised with no conversation behind them.
 *
 * The other five recognised types have a specialist route that does strictly
 * more than running their query, and taking a shortcut past it makes the answer
 * worse, not faster:
 *
 *   TransgeneExpressionHere, ExpressionOverlapsHere — vfb_find_genetic_tools
 *     ranks the driver lines. "Which GAL4 lines label the mushroom body?"
 *     answered by TransgeneExpressionHere is 4130 unranked rows.
 *   DownstreamClassConnectivity, UpstreamClassConnectivity, NeuronInputsTo —
 *     maybeInjectConnectivityStep routes a neuron endpoint to the partner tool
 *     and flags the step so the deterministic weight ranker runs. An unflagged
 *     run_query returns the first page in VFB's LABEL order, which is exactly
 *     the bug that made "strongest partners" an alphabetical list.
 *
 * The warm path (resolveQuestionToChip) keeps all eleven, because there the user
 * is following a chip we offered on a term we already resolved: they asked for
 * that query by name, and the id in hand proves the term offers it.
 */
const COLD_TEMPLATE_QUERY_TYPES = new Set([
  'NeuronsPresynapticHere', 'NeuronsPostsynapticHere', 'NeuronsPartHere',
  'NeuronsSynaptic', 'SubclassesOf', 'PartsOf'
])

const MAX_SEGMENT_WORDS = 14
const MAX_QUESTION_WORDS = 40

/** The recogniser proper, over one sentence. */
function templateInSegment(text) {
  const contentTokens = tokensWithPositions(text).filter(t => !t.stop)
  if (contentTokens.length < 2) return null

  // Only the MOST SPECIFIC signature the sentence contains may name a term, and
  // if that one cannot, nobody can.
  //
  // Falling back to a weaker signature is how this goes wrong, and it is not
  // hypothetical - the tests caught both of these before the module ran anywhere.
  // "Which neurons provide input?" contains the full three-word signature and
  // leaves NOTHING over, which means the user named no entity; drop to
  // ["neurons","input"] and the leftover is {provide}, so VFB gets asked about a
  // term called "provide". "Which neurons in the medulla receive strong output?"
  // leaves {medulla, strong} against the full signature - not adjacent, correctly
  // refused - but drop to ["neurons","output"] and the leftovers become the
  // contiguous run "medulla receive strong". A weaker template match is not a
  // second opinion; it is the same sentence with more of it left unexplained.
  const present = new Set(contentTokens.map(t => t.stem))
  const eligible = []
  let top = 0
  for (const queryType of RECOGNISED_QUERY_TYPES) {
    for (const sig of SIGNATURE_SETS[queryType]) {
      // Every signature word must actually be present, or we would be subtracting
      // words the user never wrote and calling the remainder a term name.
      if (![...sig].every(w => present.has(w))) continue
      if (sig.size > top) { top = sig.size; eligible.length = 0 }
      if (sig.size === top) eligible.push({ queryType, sig })
    }
  }
  if (eligible.length === 0) return null

  const candidates = []
  for (const { queryType, sig } of eligible) {
    const term = residualTerm(text, contentTokens, sig)
    if (term) candidates.push({ query_type: queryType, term })
  }
  // Two equally specific readings mean we do not know which question was asked,
  // so we answer neither.
  const distinct = new Set(candidates.map(c => `${c.query_type} :: ${c.term.toLowerCase()}`))
  if (distinct.size !== 1) return null
  return { query_type: candidates[0].query_type, term: candidates[0].term }
}
