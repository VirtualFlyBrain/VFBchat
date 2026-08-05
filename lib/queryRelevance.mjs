// How well a term-info query matches the question that was asked.
//
// This was a private helper inside orchestrator.mjs that answered one question —
// "which single query should I auto-run?" — and answered it as a winner-or-
// nothing: unless one candidate beat every other outright, it returned null and
// nothing ran. That discipline is right for INJECTION (running the wrong query
// is worse than running none) and wrong for everything else, because a score
// that is only ever consulted through a tiebreak cannot be used to rank, to cap,
// or to ask "is this query even about the question?".
//
// So the score is now a first-class value and the winner-or-nothing rule is one
// consumer of it. Nothing about bestByLabelOverlap's behaviour changes; what
// changes is that lib/coverage.mjs can now order a term's whole shelf by
// relevance instead of the arbitrary order VFB returned it in.

import { excludedKinds, isIndividualImageQuery, questionKinds, querySemantics, asksIntrinsic, INTRINSIC_RE } from './queryTypes.mjs'

// --- stemming --------------------------------------------------------------
//
// The scorer compares words literally, so "expressed" and "expression" were two
// different words and a question that asked about one scored zero against a
// label that said the other. That is not a near miss — see unansweredAsks, where
// a zero is the difference between a query running and a query being denied.
//
// Deliberately a stemmer and not a lemmatiser: it runs on BOTH sides of every
// comparison, so it does not have to produce a real word, only the SAME
// non-word for words that mean the same thing. "morphology" and "morphological"
// both becoming "morpholog" is a correct outcome here.
//
// Longest first, and the -ogy family before the bare -ical: "morphology" strips
// to "morphol" via -ogy, so "morphological" must strip the whole of -ogical or
// the two land on different stems and the family does not collapse — which is
// the entire point of stemming here.
const SUFFIXES = [
  'ogically', 'ogical', 'ically', 'ation', 'ical', 'ivity', 'ities',
  'ement', 'ity', 'ing', 'ion', 'ive', 'ogy', 'ed', 'al'
]

export function stemWord(word = '') {
  let w = String(word)
  if (w.length <= 4) return w
  // Plurals first, so "expressions" reaches the suffix table as "expression".
  if (w.endsWith('ies') && w.length > 5) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1)
  for (const suffix of SUFFIXES) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, -suffix.length)
  }
  return w
}

// Words that carry no signal in "how many X of Y" — every candidate query is a
// count of something, so counting them as matches would score every query alike.
const COUNT_STOPWORDS = new Set([
  'how', 'many', 'much', 'number', 'count', 'available', 'there', 'the', 'and', 'for',
  'with', 'some', 'part', 'parts', 'that', 'this', 'which', 'what', 'are', 'have', 'has'
])

export function countQueryWords(s = '') {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(w => w.length > 2 && !COUNT_STOPWORDS.has(w))
}

// "part"/"parts" carry no signal in "how many parts of X" — every candidate
// query is a part of something — so the count matcher drops them. In a LIST
// question they are the whole distinction ("what parts does the medulla have"
// vs "which neurons have a part in the medulla"), so keep them here.
const LIST_STOPWORDS = new Set([...COUNT_STOPWORDS].filter(w => w !== 'part' && w !== 'parts'))

export function listQueryWords(s = '') {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(w => w.length > 2 && !LIST_STOPWORDS.has(w))
}

/**
 * How many of the question's distinctive words this query's label repeats.
 *
 * The term's OWN name is subtracted first: every query label for the mushroom
 * body ends "… in mushroom body", so leaving those words in would score all of
 * them equally and tell us nothing about which one was asked for.
 */
export function labelOverlapScore(question, digest, query, words = countQueryWords) {
  const qWords = new Set(words(question))
  if (!qWords.size) return 0
  const termWords = new Set(words(digest?.name || ''))
  const seen = new Set()
  let score = 0
  for (const w of words(query?.label)) {
    if (termWords.has(w)) continue
    // Stemming can collapse two label words onto one stem ("expression" and
    // "expressed" in the same label); scoring it twice would inflate that label
    // above one that says the thing once.
    if (seen.has(w)) continue
    if (qWords.has(w)) { seen.add(w); score++ }
  }
  return score
}

/**
 * How relevant a query is to the question: what its LABEL repeats, plus what
 * its KIND matches.
 *
 * The two terms answer different questions and neither subsumes the other.
 * Lexical overlap discriminates WITHIN a kind — which of a region's six
 * class-list queries was asked for — and is the only signal that can, because
 * every one of them is the same kind. Kind match discriminates ACROSS kinds and
 * survives VFB and the reader choosing different words for the same thing,
 * which lexical overlap cannot.
 *
 * So the kind match is worth more than one shared word and less than a label
 * that genuinely echoes the question: a query of the right kind always outranks
 * a query of the wrong kind that happens to share a word, and a query of the
 * right kind whose label also matches outranks one that only has the kind.
 */
export const KIND_MATCH_WEIGHT = 2

/**
 * Stemming as a DECORATOR on the word extractor, not baked into the scorer.
 *
 * bestByLabelOverlap must keep comparing words literally. It is winner-take-all
 * — it runs a query or runs nothing — and there the singular/plural distinction
 * is signal, not noise: "What PARTS does the medulla have?" asks for `PartsOf`,
 * and `NeuronsPartHere`'s boilerplate "with some PART in medulla" is not an
 * answer to it. Stem both and the two tie, the router abstains, and a question
 * that used to be answered stops being answered.
 *
 * The shelf has the opposite failure mode — a zero there means a query is never
 * offered and may then be denied — so it gets the stems.
 */
const stemming = (words) => (s) => words(s).map(stemWord)

// A region's spatial-overlap queries: "some part in here", "presynaptic here",
// "postsynaptic here". All three are true of extrinsic neurons, so all three
// are wrong answers to "what is intrinsic to <region>" — and NeuronsPartHere is
// the WORST of them, because its label repeats "neurons" and "part" and so wins
// the lexical term outright. This veto is at query_type granularity, not kind:
// an intrinsic question does want a class_list, just not one of these. See
// asksIntrinsic in queryTypes.mjs for why the distinction matters.
const SPATIAL_OVERLAP_QUERIES = new Set([
  'neuronsparthere', 'neuronspresynaptichere', 'neuronspostsynaptichere'
])

export function queryRelevanceScore(question, digest, query, words = listQueryWords, kinds = null) {
  const wanted = kinds?.wanted || kinds || questionKinds(question)
  const barred = kinds?.excluded || excludedKinds(question)
  const kind = querySemantics(query?.query_type || '').kind
  if (barred.has(kind)) return 0
  // On a term that IS an intrinsic-neuron class the veto would be pointless —
  // such a class has no spatial queries — so the guard is written on the
  // question and the term together rather than on the question alone, and stays
  // inert for the "extrinsic neurons of the mushroom body" case, which is a
  // part-overlap question and should keep these queries.
  if (asksIntrinsic(question) && !INTRINSIC_RE.test(String(digest?.name || '')) &&
    SPATIAL_OVERLAP_QUERIES.has(String(query?.query_type || '').toLowerCase())) return 0
  const lexical = labelOverlapScore(question, digest, query, stemming(words))
  return lexical + (wanted.has(kind) ? KIND_MATCH_WEIGHT : 0)
}

/** Both kind sets for a question, computed once for a whole shelf. */
export function questionKindSets(question) {
  return { wanted: questionKinds(question), excluded: excludedKinds(question) }
}

/**
 * Every query in `pool`, scored and sorted best first. Ties keep their input
 * order, so a caller that cares about ambiguity can still detect it by
 * comparing the top two scores.
 */
export function rankQueries(question, digest, pool, words = countQueryWords) {
  const all = Array.isArray(pool) ? pool : []
  return all
    .map((query, i) => ({ query, score: labelOverlapScore(question, digest, query, words), i }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map(({ query, score }) => ({ query, score }))
}

/**
 * The single query in `pool` whose label best matches the question, or null when
 * there is no UNAMBIGUOUS winner — used by the intent router, where picking the
 * wrong one of a region's half-dozen class-list queries is worse than picking
 * none at all.
 */
export function bestByLabelOverlap(question, digest, pool, words = countQueryWords) {
  const all = Array.isArray(pool) ? pool : []
  if (!all.length) return null
  // An "images" question must be answered by an individual-image query (count =
  // images), never a class query like PartsOf/NeuronsPartHere (count = classes).
  // Restrict the candidate pool when the user asks about images and any
  // individual-image query is available for this term.
  let queries = all
  if (/\bimages?\b/i.test(String(question || ''))) {
    const imageQueries = all.filter(q => isIndividualImageQuery(q.query_type))
    if (imageQueries.length) queries = imageQueries
  }
  const ranked = rankQueries(question, digest, queries, words)
  if (!ranked.length) return null
  const best = ranked[0]
  const second = ranked.length > 1 ? ranked[1].score : 0
  return (best.score >= 1 && best.score > second) ? best.query : null
}
