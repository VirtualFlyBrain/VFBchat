// Never describe the apparatus. Describe the subject.
//
// Two families of sentence keep reaching the reader, and they are the same
// mistake seen from two sides: the answer talks about the machinery that
// produced it instead of the thing it was asked about. The reader has no
// session, no queue, no evidence block and no way to run anything, so every one
// of these sentences is, to them, about nothing.
//
//   PENDING-QUERY framing — the answer narrates this program's work queue:
//     "VFB holds 602 records of Neurons with some part in mushroom body, but
//      the query to list them has not been run yet."          (W7.C1, whole answer)
//     "VFB also holds scRNAseq data for LPLC2, but this query has not been
//      run yet."                                              (W9.3, closing line)
//     "…with 92 records, which has not been run yet."         (W6.B, closing line)
//
//   INPUT framing — the answer describes what it was handed:
//     "Neuron VFB_jrchjtdb is not mentioned in the provided evidence."  (W4.C, opening line)
//
// Both are already forbidden in the synthesis prompt, in more than one place,
// and both were emitted anyway. A rule that has been broken in production is not
// a rule, it is a preference; this module is where it becomes a rule.
//
// THE TWO MECHANICS, AND WHY THEY DIFFER
//
// A pending-query mention is almost always a trailing SUBORDINATE CLAUSE hung
// off a sentence that is otherwise true and useful — "VFB holds 602 records of
// X" is exactly what the reader should be told. So the clause is cut and the
// clause alone; the holding survives. Only when the whole sentence is the
// pending note is the sentence dropped.
//
// Input framing is the opposite: "X is not mentioned in the provided evidence"
// has no salvageable core, because the claim it makes is about a text the reader
// cannot see, and rewriting it into a claim about VFB would invent an absence
// nobody verified. So that whole sentence goes, and the answer stands on the
// sentences around it.
//
// Deliberately NOT here: "the lookup did not complete". That one describes a
// real event the reader is affected by — it is why the answer is thinner than it
// should be — and suppressing it would turn a disclosed failure into a silent
// one.

/** Noun phrases naming the model's own input rather than anything in the world. */
const INPUT_NOUN = '(?:the\\s+)?(?:provided|supplied|given|available|above|preceding|foregoing)\\s+(?:evidence|information|data|context|documentation|results?|material)'
const INPUT_NOUN_ALT = '(?:the\\s+)?(?:evidence|information|documentation|context|data)\\s+(?:provided|supplied|given|shown|listed)(?:\\s+above)?'

/** Ways of saying a query is still queued. */
const NOT_RUN = '(?:ha(?:s|ve)\\s+not\\s+(?:yet\\s+)?been\\s+(?:run|executed|performed|carried\\s+out)(?:\\s+yet)?'
  + '|ha(?:s|ve)\\s+yet\\s+to\\s+be\\s+(?:run|executed|performed)'
  + '|w(?:as|ere)\\s+not\\s+(?:run|executed|performed)'
  + '|(?:still\\s+)?needs?\\s+to\\s+be\\s+run'
  + '|remains?\\s+unrun'
  + '|(?:is|are)\\s+(?:still\\s+)?pending)'

/** A noun phrase for the query itself, as the answer tends to name it. */
const QUERY_NOUN = '(?:this|that|the|a|an|its|such\\s+a)?\\s*(?:VFB\\s+)?(?:quer(?:y|ies)|lookup|search|listing|report)'
  + '(?:\\s+(?:to|for|of|that|which)[^,.;:]{0,60})?'

const CONNECTIVE = '(?:,|;|\\s+—|\\s+–)?\\s*(?:but|although|though|however|while|whereas|and|yet)?\\s*'

const CLAUSE_RULES = [
  // ", but the query to list them has not been run yet"
  new RegExp(`${CONNECTIVE}${QUERY_NOUN}\\s+${NOT_RUN}`, 'gi'),
  // ", which has not been run yet"  /  ", which VFB has not yet run"
  new RegExp('(?:,|;)?\\s*(?:but\\s+|although\\s+|though\\s+)?which\\s+' + NOT_RUN, 'gi'),
  // ", but it has not been run yet"
  new RegExp('(?:,|;)?\\s*(?:but|although|though|however)\\s+(?:it|these|those|they)\\s+' + NOT_RUN, 'gi'),
  // ", pending a query"  /  " (query not yet run)"
  /\s*\((?:query|lookup|search)\s+not\s+(?:yet\s+)?(?:run|executed)\)/gi
]

/** A sentence whose entire content is a note about a pending query. */
const PENDING_SENTENCE = new RegExp(
  `(^|[.!?)"'\\]]\\s+|\\n\\s*)(?:However,?\\s+|But\\s+|Note\\s+that\\s+)?${QUERY_NOUN}\\s+${NOT_RUN}[^.!?]*[.!?]\\s*`,
  'gi'
)

/** A sentence that only reports what the model's input did or did not contain. */
const INPUT_SENTENCE = new RegExp(
  `(^|[.!?)"'\\]]\\s+|\\n\\s*)(?:However,?\\s+|But\\s+|Note\\s+that\\s+)?[^.!?\\n]{0,120}?`
  + `\\b(?:not\\s+(?:mentioned|found|present|included|listed|specified|described|referenced|available|provided)`
  + `|(?:does|do|did)\\s+not\\s+(?:appear|contain|include|mention|specify))\\b`
  + `[^.!?\\n]{0,40}?\\bin\\s+(?:${INPUT_NOUN}|${INPUT_NOUN_ALT})\\b[^.!?\\n]*[.!?]\\s*`,
  'gi'
)

/** Whatever survives, the noun phrase itself must not reach the reader. */
const INPUT_NOUN_RULES = [
  [new RegExp(`\\b${INPUT_NOUN}\\b`, 'gi'), 'VFB evidence'],
  [new RegExp(`\\b${INPUT_NOUN_ALT}\\b`, 'gi'), 'VFB evidence']
]

/**
 * Tidy the punctuation a cut leaves behind.
 *
 * Cutting a trailing clause reliably strands the comma that introduced it and
 * can leave a doubled full stop or a sentence that now ends in a conjunction.
 * A visibly-edited sentence reads worse than the sentence that was wrong.
 */
function repunctuate(text) {
  return String(text)
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/,\s*\./g, '.')
    .replace(/\.{2,}(?!\.)/g, '.')
    .replace(/\s+(?:but|and|although|though|however|while|whereas|yet)\s*\./gi, '.')
    .replace(/,\s*(?=[.,;:!?])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Remove sentences and clauses that describe this program rather than VFB.
 *
 * Conservative by construction: a clause rule only ever DELETES a subordinate
 * clause, never rewrites the main one, so a sentence that carries a count keeps
 * its count. Returns the text unchanged when nothing matches.
 */
export function stripHarnessFraming(text = '') {
  const before = String(text || '')
  if (!before) return before
  let out = before

  out = out.replace(PENDING_SENTENCE, '$1')
  out = out.replace(INPUT_SENTENCE, '$1')
  for (const re of CLAUSE_RULES) out = out.replace(re, '')
  for (const [re, to] of INPUT_NOUN_RULES) out = out.replace(re, to)

  out = repunctuate(out)
  if (out.trim()) return out

  // Deleting the entire answer is always the wrong trade: a bad answer is
  // recoverable for the reader and a blank one is not. So when the whole reply
  // WAS the leak, keep it — but keep it with the input nouns renamed, so what
  // survives at least talks about VFB rather than about a text the reader was
  // never shown. This is a degraded case by definition; the real fix for it is
  // upstream, in never producing an answer with nothing else in it.
  let salvaged = before
  for (const [re, to] of INPUT_NOUN_RULES) salvaged = salvaged.replace(re, to)
  // repunctuate() exists to tidy up after a CUT — its dangling-conjunction rule
  // would happily eat the "yet" off "has not been run yet." if nothing was cut.
  // On this path nothing was cut, so it only earns its keep if a rename landed.
  return salvaged === before ? before : (repunctuate(salvaged) || before)
}

/**
 * True when `text` still describes the apparatus — used by the answer-quality
 * battery so a regression shows up as a failing detector rather than as a
 * silently-cleaned answer.
 */
export function hasHarnessFraming(text = '') {
  const s = String(text || '')
  if (!s) return false
  return new RegExp(`${QUERY_NOUN}\\s+${NOT_RUN}`, 'i').test(s)
    || new RegExp(`\\b(?:${INPUT_NOUN}|${INPUT_NOUN_ALT})\\b`, 'i').test(s)
}
