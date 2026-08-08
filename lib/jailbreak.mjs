// Pre-filter for attempts to reconfigure the assistant rather than ask it about flies.
//
// A false positive here is expensive, not safe. The caller refuses the question
// outright, runs no query, tells the user they tried to "bypass safety
// restrictions", and writes their IP to the security log with abuseFlag set. A
// researcher who gets that has been accused of an attack for asking about
// neurons, and — because a refused question never reaches the task battery or
// answer-lab — nobody finds out.
//
// It happened. On production v4.2.0 all four of these were refused in under two
// seconds:
//
//   "Does the ellipsoid body act as an integrator in the fly brain?"
//   "Which DAN subtypes are modelled in the hemibrain?"
//   "Which term acts as root of the DAO hierarchy?"
//   "Which neurons act as inputs to the central complex in the adult brain?"
//
// Two rules did it. /\bact as\b.*ai/i had no word boundary on `ai`, so it matched
// br·AI·n — and domain, chain, explain, remaining, maintain, available. And
// /\bdan\b.*mode/i matched DAN (the standard abbreviation for a dopaminergic
// neuron) followed anywhere by "model" or "modelled".
//
// Drosophila vocabulary collides with jailbreak vocabulary much more than it
// looks: "act as", "functions as", "model", "root", "admin", "pretend", "brain".
// So this module holds to two rules:
//
//   1. NO UNBOUNDED WILDCARD. Every gap is CLAUSE — at most 40 characters and
//      never across a sentence boundary. A jailbreak instruction is one
//      imperative. Letting a pattern span three clauses of a real question is
//      what produced every false positive above.
//   2. EVERY ALPHABETIC FRAGMENT IS WORD-ANCHORED. `ai` means the word "ai",
//      never the middle of "brain".
//
// Verified as a rate rather than a sample, in tests/unit/jailbreak.test.mjs:
// 216 legitimate questions must all pass, and an attack corpus must all be
// caught. Both directions matter — a filter that never fires is not a fix.

/** One clause. Bounded, and never across `.`, `?`, `!`, `;` or a newline. */
const CLAUSE = '[^.?!;\\n]{0,40}'

const clauseRe = (...parts) => new RegExp(parts.join(CLAUSE), 'i')

/**
 * Each rule is named so a refusal can be diagnosed later from the security log
 * without logging the question itself. An unexplained refusal is how the two
 * bugs above survived to production.
 */
export const JAILBREAK_RULES = [
  // --- Named modes. Whole phrases: no wildcard, nothing to over-reach. --------
  ['named_mode', /\b(developer|unrestricted|debug|maintenance|god|administrator) mode\b/i],
  // "admin mode" is deliberately NOT here. VFB has a curation admin interface,
  // so "what is the admin mode for curation?" is an ordinary question, and
  // "admin mode" on its own is a weak jailbreak signal next to god/developer/
  // unrestricted mode. Refusing a curator costs more than this rule is worth.
  ['do_anything_now', /\bdo anything now\b/i],
  ['uncensored', /\b(uncensored|unfiltered)\b/i],
  ['jailbreak_named', /\bjailbreak(s|ing|ed)?\b/i],
  ['anti_woke', /\banti[- ]?woke\b/i],

  // --- Overriding the instructions. Target noun must be in the same clause. ---
  ['override_instructions', clauseRe(
    '\\b(ignore|override|forget|discard|disregard|bypass|circumvent)\\b',
    '\\b(instructions?|rules?|prompts?|guidelines?|restrictions?|guardrails?)\\b'
  )],
  ['system_prompt', clauseRe(
    '\\b(change|alter|modify|rewrite|reveal|repeat|print|show|output|leak)\\b',
    '\\bsystem\\s+prompt\\b'
  )],
  // Asking for it needs no verb — "what is your system prompt?" has none. No
  // Drosophila question refers to the assistant's own system prompt or to its
  // original instructions, so this can be a plain phrase match.
  ['system_prompt_disclosure', /\b(your|the)\s+(system\s+prompt|(initial|original|hidden)\s+instructions)\b/i],
  ['break_rules', clauseRe('\\byou must\\b', '\\bbreak\\b', '\\brules?\\b')],

  // --- Persona reassignment. `ai` is word-anchored; that one missing \b is -----
  // --- what refused "act as an integrator in the fly brain". ------------------
  // The target must be the assistant ITSELF, so it is read as a noun, not as an
  // adjective. "an integrator for AI-style computation" and "neurons that act as
  // AI-like gates" are questions about flies; the lookahead is what keeps them.
  ['persona_swap', clauseRe(
    '\\b(you are now|act as|acting as|pretend to be|become|role[- ]?play(ing)? as)\\b',
    '\\b(an?|the)?\\s*(ai|a\\.i\\.|assistant|chatbot|language model|llm|dan)\\b(?![-–\\s]?(style|like|based|driven|powered|inspired|assisted|generated|era|research))'
  )],
  ['pretend_you_are', clauseRe('\\bpretend\\b', '\\byou (are|were|have no|do not have)\\b')],
  ['from_now_on', clauseRe('\\bfrom now on\\b', '\\byou (are|will|must|shall)\\b')],
  ['uncensored_persona', clauseRe(
    '\\b(create|adopt|assume|become)\\b',
    '\\b(uncensored|unrestricted|unfiltered|evil|amoral)\\b',
    '\\b(persona|character|mode|version)\\b'
  )],

  // --- Privilege and smuggling. ----------------------------------------------
  // Bare /\bsudo\b/ used to fire here. "do I need sudo to install VFB_connect?"
  // is an ordinary question, so it must be aimed at the assistant to count.
  ['root_privilege', clauseRe(
    '\\b(you|your|assistant|run|execute|operate)\\b',
    '\\b(as root|as sudo|in sudo mode|root mode)\\b'
  )],
  ['smuggled_payload', clauseRe(
    '\\b(base64|encoded|encrypted|obfuscated|hidden|secret)\\b',
    '\\b(prompt|message|instructions?|payload|command)\\b'
  )]
]

/**
 * Returns the name of the rule that fired, or null. Truthy/falsy so existing
 * `if (detectJailbreakAttempt(m))` call sites keep working, but a caller that
 * wants to know WHICH rule fired can have it.
 */
export function detectJailbreakRule (message) {
  const text = String(message || '')
  for (const [name, pattern] of JAILBREAK_RULES) {
    if (pattern.test(text)) return name
  }

  // A last-resort density signal, kept from the original. Any one of these words
  // is ordinary English ("we can ignore the noise"); three of them together in
  // one message is not a question about flies.
  const suspicious = ['ignore', 'override', 'forget', 'unrestricted', 'uncensored', 'jailbreak', 'disregard']
  const count = suspicious.reduce(
    (n, word) => n + (text.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length, 0
  )
  return count > 2 ? 'suspicious_word_density' : null
}

/** Back-compatible boolean form. */
export function detectJailbreakAttempt (message) {
  return detectJailbreakRule(message) !== null
}
