// The characters a fly neuroanatomist types, and the characters VFB's index
// answers to.
//
// THE MEASUREMENT
//
// Against the live VFB MCP, on names the ontology definitely holds:
//
//   "γ Kenyon cell"          0 hits    "gamma Kenyon cell"          FBbt_00100247, exact label
//   "α/β Kenyon cell"        0 hits    "alpha/beta Kenyon cell"     FBbt_00100248, exact label
//   "MBON-γ1pedc>α/β"        0 hits    "MBON-gamma1pedc>alpha/beta" FBbt_00100246, rank 1
//   "MBON-α′1"              80 hits, the term NOT among the top ten
//                                     "MBON-alpha'1"               FBbt_00111010, rank 1
//
// Every one of those zero-hit rows was reported to a user as "VFB does not
// currently hold data on …". The ontology holds all three classes. The search
// index stores the ASCII spelling — FlyBase's convention — and the literature,
// the slides and the people all use the Greek letter, so the wording a person
// types and the wording the index answers to are different strings for the same
// class. That is a transliteration problem, not an absence.
//
// The last row is the one worth dwelling on, because it does not look like a
// failure: eighty hits came back. A search that returns eighty wrong documents
// is more dangerous than one that returns none, because the resolver has
// something to pick from and no signal that it should not. Normalising is what
// puts the right term at rank one.
//
// WHY A SEPARATE STEP AND NOT A SEARCH-TIME FLAG
//
// VFB's Solr is not going to grow a transliteration filter to suit this client,
// and it should not have to: the ontology's spelling is the ontology's business.
// The fix belongs where the other wording alternatives already live — the
// resolve ladder's variant list — so it costs one extra search on the names that
// need it and nothing at all on the names that do not.

/**
 * Greek letters as FlyBase and the FBbt ontology spell them.
 *
 * Both cases map to the same lowercase word on purpose. VFB writes
 * "alpha/beta Kenyon cell" and "MBON-gamma1pedc>alpha/beta" — lowercase
 * throughout, whatever case the Greek was written in — and a name is matched
 * case-insensitively anyway, so "Alpha" would only add a second spelling that
 * behaves identically.
 *
 * Sigma has two lowercase forms (σ, final ς); both are here. Omicron and
 * upsilon are included for completeness rather than because anything is named
 * after them.
 */
const GREEK = {
  α: 'alpha', Α: 'alpha', β: 'beta', Β: 'beta', γ: 'gamma', Γ: 'gamma',
  δ: 'delta', Δ: 'delta', ε: 'epsilon', Ε: 'epsilon', ζ: 'zeta', Ζ: 'zeta',
  η: 'eta', Η: 'eta', θ: 'theta', Θ: 'theta', ϑ: 'theta', ι: 'iota', Ι: 'iota',
  κ: 'kappa', Κ: 'kappa', λ: 'lambda', Λ: 'lambda', μ: 'mu', Μ: 'mu', µ: 'mu',
  ν: 'nu', Ν: 'nu', ξ: 'xi', Ξ: 'xi', ο: 'omicron', Ο: 'omicron',
  π: 'pi', Π: 'pi', ρ: 'rho', Ρ: 'rho', σ: 'sigma', ς: 'sigma', Σ: 'sigma',
  τ: 'tau', Τ: 'tau', υ: 'upsilon', Υ: 'upsilon', φ: 'phi', Φ: 'phi', ϕ: 'phi',
  χ: 'chi', Χ: 'chi', ψ: 'psi', Ψ: 'psi', ω: 'omega', Ω: 'omega'
}

const GREEK_RE = new RegExp(`[${Object.keys(GREEK).join('')}]`, 'g')

/** True when the string contains a Greek letter at all — cheap pre-test. */
export function hasGreek(text = '') {
  GREEK_RE.lastIndex = 0
  return GREEK_RE.test(String(text))
}

/**
 * Greek letters replaced by their FlyBase spellings.
 *
 * No separator is inserted. "γ1pedc" must become "gamma1pedc", not
 * "gamma 1pedc" or "gamma-1pedc": the ontology label is
 * "MBON-gamma1pedc>alpha/beta", and a space there costs the exact match that is
 * the whole point of the rung.
 */
export function transliterateGreek(text = '') {
  return String(text).replace(GREEK_RE, (c) => GREEK[c] || c)
}

/**
 * Typographic characters replaced by the ASCII the ontology uses.
 *
 * PRIME is the one that earns its place. MBON compartment names are written
 * α′1, α'1 and α’1 by different people and stored as "alpha'1" — a plain
 * apostrophe — so a prime or a curly quote is a miss on a term VFB holds.
 *
 * The arrow is here for the same reason: "MBON-γ1pedc→α/β" is how the
 * projection is drawn in a figure legend, and FBbt writes it ">".
 *
 * Dashes and non-breaking spaces are the usual copy-paste damage from a PDF.
 * They are worth normalising and they are not worth a separate rung, so they
 * ride along with the prime.
 */
const TYPOGRAPHY = [
  [/[′‵ʹʼ‘’]/g, "'"],   // primes and curly single quotes
  [/[″‶“”]/g, '"'],               // double primes and curly doubles
  [/[→⇒⟶⟹]/g, '>'],               // arrows -> the ontology's ">"
  [/[‐-―−]/g, '-'],                    // hyphens, dashes, minus
  [/[    ]/g, ' ']                // non-breaking / thin spaces
]

export function normaliseTypography(text = '') {
  let out = String(text)
  for (const [re, to] of TYPOGRAPHY) out = out.replace(re, to)
  return out
}

/**
 * The ASCII spelling of a name, or '' when the name was already ASCII in every
 * respect this function cares about.
 *
 * Returning '' rather than the unchanged string is deliberate: the caller is
 * building a list of ALTERNATIVE wordings to search, and an alternative
 * identical to the original is a wasted round trip against a backend that has
 * already proved it is the slow part of a lookup.
 */
export function asciiSpelling(name = '') {
  const raw = String(name || '').trim()
  if (!raw) return ''
  const out = normaliseTypography(transliterateGreek(raw)).replace(/\s+/g, ' ').trim()
  return out === raw ? '' : out
}
