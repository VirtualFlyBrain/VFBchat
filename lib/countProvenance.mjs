// An advertisement is not an observation.
//
// A VFB term-info record ships a Queries[] block: a menu of the queries that can
// be run against this term, each carrying a count so the UI can render "42
// images" beside the button. That count is an ADVERTISEMENT. Run the query and
// the payload comes back with its own count — an OBSERVATION.
//
// They are usually equal. When they are not, the observation is right, and the
// advertisement is right about nothing at all:
//
//   GET /get_term_info?id=FBbt_00003686
//     Queries[] -> TransgeneExpressionHere, count 92
//   GET /run_query?query_type=TransgeneExpressionHere&id=FBbt_00003686
//     count 42, 42 rows, capped false
//
// W7.C4 shipped both numbers in one answer:
//
//   "VFB also holds transgene expression reports for Kenyon cell, with 42
//    results returned … However, it is also stated that VFB has 92 transgene
//    expression reports for Kenyon cell."
//
// Note what the model did NOT do wrong. It did not hallucinate 92; it was told
// 92, by us, in the same context window as the 42, and then did the only honest
// thing available to it, which was to report the disagreement. The defect is
// that we let a stale menu entry stay in the evidence after the query behind it
// had actually been run. A harness that has observed a count and still shows the
// model the advertised one is asking to be contradicted.
//
// So: when a run_query result disagrees with the term-info entry that advertised
// it, the entry is overwritten, the old figure is kept as `advertisedCount` for
// provenance, and any sentence still quoting the old figure is removed from the
// prose on the way out. The last of those three is a backstop, not the fix —
// the fix is the overwrite, which also corrects the count links, the ask chips
// and the coverage shelf, all of which read the same field.
//
// WHY THE OVERWRITE NEEDS ITS OWN RULE
//
// backfillDigestPreview already copied observed counts into the digest, but only
// `if (q.countKind !== 'exact')` — i.e. only when the advertisement had no
// number to begin with. That guard is right for a preview (do not clobber a
// known total with a page of rows) and exactly backwards for a total: 92 was
// 'exact', so it was defended against the observation that disproved it.

/** Nothing here is a claim about the world, so nothing here invents a number. */
const CAP_HINTS = ['capped', 'truncated', 'limited']

/**
 * True when a run_query payload's `count` is a trustworthy total rather than a
 * page size or a placeholder.
 *
 * A capped result counts up to the cap and stops, so it is a floor. A payload
 * that says its count is unavailable is not counted at all. Either way it
 * cannot overrule an advertised total, however wrong that total may be.
 */
export function isObservedTotal(parsed) {
  if (!parsed || typeof parsed !== 'object') return false
  if (parsed.count_status === 'unavailable') return false
  for (const k of CAP_HINTS) {
    const v = parsed[k]
    if (v === true || v === 'true' || v === 'True') return false
  }
  const n = Number(parsed.count)
  return Number.isFinite(n) && n >= 0
}

/**
 * Overwrite an advertised count with an observed one, keeping the old figure.
 *
 * Returns true when something changed. Idempotent: re-running the same query
 * with the same result changes nothing, and `advertisedCount` is only ever set
 * once, so a third run cannot make the original advertisement disappear.
 *
 * @param {object} q a digest query entry (mutated in place)
 * @param {object} parsed the run_query payload
 */
export function recordObservedCount(q, parsed) {
  if (!q || typeof q !== 'object') return false
  if (!isObservedTotal(parsed)) return false
  const observed = Number(parsed.count)
  const previous = Number(q.count)
  const hadExact = q.countKind === 'exact' && Number.isFinite(previous) && previous >= 0
  if (hadExact && previous === observed) {
    q.countObserved = true
    return false
  }
  if (hadExact && !Object.prototype.hasOwnProperty.call(q, 'advertisedCount')) {
    q.advertisedCount = previous
  }
  q.count = observed
  q.countKind = 'exact'
  q.countObserved = true
  return true
}

/**
 * Every advertised figure this run has since disproved.
 *
 * @returns {Array<{queryType:string,label:string,termId:string,advertised:number,observed:number}>}
 */
export function supersededCounts(ledger) {
  const out = []
  for (const t of Object.values(ledger?.terms || {})) {
    for (const q of (t?.digest?.queries || [])) {
      const advertised = Number(q?.advertisedCount)
      const observed = Number(q?.count)
      if (!Number.isFinite(advertised) || !Number.isFinite(observed)) continue
      if (advertised === observed) continue
      out.push({
        queryType: String(q.query_type || ''),
        label: String(q.label || ''),
        termId: String(t?.id || ''),
        advertised,
        observed
      })
    }
  }
  return out
}

const STOPWORDS = new Set(['this', 'that', 'they', 'them', 'with', 'from', 'here', 'there',
  'have', 'has', 'the', 'and', 'for', 'are', 'was', 'were', 'some', 'all', 'any',
  'data', 'query', 'queries', 'results', 'result', 'records', 'record'])

/** Content words of a query label, used to tie a sentence to that query. */
function labelKeywords(label) {
  return [...new Set(String(label).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])]
    .filter(w => !STOPWORDS.has(w))
}

/** Match a figure as its own token, with or without thousands separators. */
function figureRe(n) {
  const plain = String(n)
  const grouped = Number(n).toLocaleString('en-US')
  const alts = [...new Set([plain, grouped])].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\w,.])(?:${alts.join('|')})(?![\\w,.]?\\d)`)
}

/** Split into sentences, keeping their trailing punctuation and spacing. */
function sentences(text) {
  return String(text).match(/[^.!?\n]*(?:[.!?]+["'”’)\]]*\s*|\n+|$)/g)?.filter(s => s !== '') || []
}

/**
 * Remove — or, failing that, correct — prose that still quotes a figure the run
 * disproved.
 *
 * Two outcomes, and which one applies is decided by what the reader is left
 * with. If the true figure already appears somewhere in the answer, the stale
 * sentence is redundant as well as wrong, so it goes. If it does not, deleting
 * would take the reader's only number away, so the figure is corrected in place
 * instead. Never leave a hole where a count was.
 *
 * A sentence is only touched when it quotes the stale figure as its own token
 * AND shares a content word with the query that figure came from. Numbers are
 * ambiguous — 92 is a count, a synapse weight and part of an id — and the label
 * tie is what stops this from editing a sentence about something else entirely.
 */
export function stripSupersededFigures(text, supersessions = []) {
  let out = String(text || '')
  if (!out || !Array.isArray(supersessions) || !supersessions.length) return out

  for (const s of supersessions) {
    const advertised = Number(s?.advertised)
    const observed = Number(s?.observed)
    if (!Number.isFinite(advertised) || !Number.isFinite(observed)) continue
    const staleRe = figureRe(advertised)
    if (!staleRe.test(out)) continue

    const keywords = labelKeywords(s?.label)
    const trueRe = figureRe(observed)
    const observedIsPresent = trueRe.test(out)

    const parts = sentences(out)
    let changed = false
    const kept = parts.map(part => {
      if (!staleRe.test(part)) return part
      if (trueRe.test(part)) return part          // the sentence already carries the truth
      const lower = part.toLowerCase()
      if (keywords.length && !keywords.some(w => lower.includes(w))) return part
      changed = true
      if (observedIsPresent) return ''            // redundant AND wrong -> drop it
      return part.replace(staleRe, Number(observed).toLocaleString('en-US'))
    })
    if (changed) out = kept.join('')
  }

  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
