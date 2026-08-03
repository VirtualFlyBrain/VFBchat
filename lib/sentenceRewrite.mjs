// Anchoring for rewrite rules that swap a whole SENTENCE in for a matched claim.
//
// The assistant-output cleanup chain in the chat route is mostly phrase-level:
// "the tool suggests" becomes "VFB suggests" and reads correctly wherever it
// lands. A handful of rules are not like that. They match a complete claim and
// substitute a differently-worded, capitalised, self-contained sentence — and
// those only read correctly if the thing they matched was itself standing at
// the start of a sentence.
//
// Unanchored, one of them turned this answer:
//
//   "Without a matched term, it is not possible to determine if the Hemibrain
//    dataset contains neurons that are morphologically similar to the fru+ mAL
//    neurons described in light microscopy studies."
//
// into this one:
//
//   "Without a matched term, it is not possible to determine if This bounded
//    VFB pass did not confirm Hemibrain neurons morphologically similar to the
//    fru+ mAL neurons."
//
// The rule was written against the affirmative claim, which is a false claim
// worth suppressing. What it actually caught was the same words appearing as a
// subordinate clause inside a hedge — where the sentence already says the thing
// is unconfirmed, so there was nothing to suppress and every reason to leave it
// alone. Splicing a capital-letter sentence into the middle of another is worse
// than the problem it was fixing.
//
// So: match only at a sentence boundary. The preceding boundary is captured as
// group 1 and must be written back by the replacement as "$1", because a rule
// that consumes the full stop before its match would join two sentences.

/** Closing punctuation that may sit between a full stop and the following space. */
const CLOSERS = '"\'”’)\\]'

/**
 * Build a regex that matches `source` only where a sentence starts — at the
 * start of the string, after terminal punctuation and whitespace, or after a
 * line break.
 *
 * Note the absence of an "i" flag by default. A claim that genuinely opens a
 * sentence is capitalised, so case-sensitivity is a second, independent guard
 * against catching the same words mid-sentence; pass flags explicitly if a rule
 * really does need to be case-insensitive.
 *
 * @param {string} source regex source for the claim, WITHOUT anchors.
 * @param {string} [flags] defaults to "g".
 * @returns {RegExp} whose group 1 is the boundary — replacements must start "$1".
 */
export function sentenceStart(source, flags = 'g') {
  return new RegExp(`(^|[.!?][${CLOSERS}]*[ \\t]+|\\n[ \\t]*)(?:${source})`, flags)
}
