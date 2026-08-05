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

import { isIndividualImageQuery } from './queryTypes.mjs'

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
  let score = 0
  for (const w of words(query?.label)) {
    if (termWords.has(w)) continue
    if (qWords.has(w)) score++
  }
  return score
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
