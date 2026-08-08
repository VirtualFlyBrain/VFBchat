// Answer-grounding guard (pure, offline-testable).
//
// The paper's main residual failure mode for the MCP condition is *partial
// fabrication*: an answer that is mostly grounded but stacks a free-form detail —
// an invented count, or an ontology id the model wrote from memory — on top of the
// correct scaffold. The role-harness already keeps ids out of prose by design
// (the synthesiser is told not to write them, and linking is deterministic), but a
// weak model occasionally leaks one, and large quantitative numbers can be
// invented. This module gives two cheap, deterministic checks:
//
//   1. strip ontology ids the model wrote into prose (they are re-linked
//      deterministically from labels, so removing them is safe and they should
//      never appear in the raw text); and
//   2. flag large numbers in the answer that do not trace to any tool-derived
//      value, for logging — so the fabrication rate is observable in the logs
//      rather than silently shipped.
//
// Ontology ids: FBbt_, VFB_, FBgn, FBlc, FBrf, FBal, FBti, FBtp, FBco, VFBexp_.
const ONTOLOGY_ID_RE = /\b(?:FBbt_\d{6,}|VFB_[0-9a-z]{6,}|VFBexp_\w+|FB(?:gn|lc|rf|al|ti|tp|co)\d{6,})\b/gi

/**
 * Normalised lookup set for the ids that are legitimately allowed in prose:
 * the ones the USER wrote in the question and the ones the tools actually
 * returned. Everything else is a candidate leak.
 */
function allowSet(allowed) {
  const out = new Set()
  for (const a of (allowed || [])) {
    const s = String(a || '').trim().toLowerCase()
    if (s) out.add(s)
  }
  return out
}

/**
 * Ontology ids present in the text (deduplicated), EXCLUDING any id in
 * `allowed`. An id the user typed, or one a tool returned, is grounded — it is
 * not a leak and must not be counted as one.
 */
export function findLeakedIds(text = '', allowed = []) {
  const ok = allowSet(allowed)
  return [...new Set((String(text).match(ONTOLOGY_ID_RE) || []))]
    .filter(id => !ok.has(id.toLowerCase()))
}

/**
 * Remove ontology ids the model INVENTED, leaving grounded ones in place. Run on
 * the RAW synthesiser output BEFORE deterministic linkification (which
 * legitimately puts ids inside report URLs). Drops a trailing "(FBbt_…)" after a
 * label and any bare id, then tidies whitespace — labels are re-linked from the
 * registry afterwards.
 *
 * `allowed` is the grounded id set: ids the user supplied in the question plus
 * ids the tools returned. Without it this function used to delete EVERY id,
 * including the one the user had just asked about, which shredded the sentence
 * around it — "the VFB ID of VFB_fw035286 is …" became "the VFB ID of is …".
 * A user-supplied id also has no registry label to re-link from, so stripping it
 * removed the identifier from the answer entirely; that is why "…and list the
 * VFB IDs" never produced any.
 */
export function stripLeakedIds(text = '', allowed = []) {
  const ok = allowSet(allowed)
  const keep = (id) => ok.has(String(id).toLowerCase())
  return String(text)
    .replace(/(\s*)\(((?:FBbt_\d{6,}|VFB_[0-9a-z]{6,}|VFBexp_\w+|FB(?:gn|lc|rf|al|ti|tp|co)\d{6,}))\)/gi,
      (m, sp, id) => (keep(id) ? m : ''))
    .replace(ONTOLOGY_ID_RE, (id) => (keep(id) ? id : ''))
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Every ontology id that is legitimately available to the answer: the ids the
 * user wrote in the question, the ids of resolved terms, the ids in the label
 * registry, the ids of the example entities / preview rows VFB returned, and the
 * ids in the VFB evidence rows themselves.
 * Passed to findLeakedIds/stripLeakedIds so grounded ids survive into the answer.
 */
export function collectGroundedIds(question = '', ledger = null) {
  const ids = new Set(String(question).match(ONTOLOGY_ID_RE) || [])
  for (const t of Object.values(ledger?.terms || {})) {
    if (t?.id) ids.add(t.id)
    if (t?.digest?.id) ids.add(t.digest.id)
    for (const q of (t?.digest?.queries || [])) {
      for (const e of (q?.exampleEntities || [])) if (e?.id) ids.add(e.id)
      for (const r of (q?.previewRows || [])) if (r?.id) ids.add(r.id)
    }
  }
  for (const r of Object.values(ledger?.registry || {})) if (r?.id) ids.add(r.id)
  // An id the synthesiser read off a VFB evidence row is grounded BY DEFINITION —
  // the row is what the tool returned. Only the digest was being harvested, so a
  // macro tool's rows counted as invented: "which GAL4 lines label the mushroom
  // body" had its twelve expression-pattern ids stripped back out of the answer,
  // leaving the names in bare brackets with nothing to link to.
  for (const e of (ledger?.evidence || [])) {
    if (e?.source !== 'vfb') continue
    for (const id of String(`${e.claim || ''}\n${e.verbatim || ''}`).match(ONTOLOGY_ID_RE) || []) ids.add(id)
  }
  return [...ids]
}

// Large numbers in the answer: 4+ digit integers (with optional thousands commas),
// optionally with a decimal. These are the count/weight/expression-level claims.
// Returns {value, raw} because the raw spelling matters: "1,924" carries a
// thousands separator and therefore cannot be a year, while "1924" can.
const LARGE_NUMBER_RE = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/g

function largeNumbersIn(text = '') {
  const out = []
  for (const m of String(text).matchAll(LARGE_NUMBER_RE)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.push({ value: n, raw: m[0] })
  }
  return out
}

/**
 * A number in the 1900-2099 window is usually a publication year, and flagging
 * every year as an invented count would drown the signal. But a count can land
 * there too — the production case was 1,934 records — so a spelling with a
 * thousands separator is never treated as a year. "In 2020" is; "1,924" is not.
 */
function looksLikeYear({ value, raw }) {
  return Number.isInteger(value) && value >= 1900 && value <= 2099 && !String(raw).includes(',')
}

/** Recursively collect every finite number from arbitrary tool-derived data. */
export function collectGroundedNumbers(...sources) {
  const out = []
  const add = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) { out.push(v); return }
    if (typeof v === 'string') {
      const t = v.trim()
      if (/^[\d,]+(?:\.\d+)?$/.test(t)) { const n = Number(t.replace(/,/g, '')); if (Number.isFinite(n)) out.push(n) }
    }
  }
  const walk = (x) => {
    if (x == null) return
    if (typeof x === 'number' || typeof x === 'string') { add(x); return }
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (typeof x === 'object') { Object.values(x).forEach(walk) }
  }
  sources.forEach(walk)
  return out
}

/** Trailing zeros in the integer part — a cheap proxy for "how rounded is this". */
function roundness(n) {
  const s = String(Math.trunc(Math.abs(n)))
  const m = s.match(/0+$/)
  return m ? m[0].length : 0
}

/**
 * Is `n` a legitimate ROUNDING of grounded value `g`, as opposed to a
 * mis-transcription of it?
 *
 * The distinction matters more than it looks. The original tolerance here was
 * "equal within 2% or ±2" in both directions, which is right for "roughly 1,900"
 * and catastrophically wrong for "1,924" — because 1,924 is within 2% of the
 * real 1,934, so a one-digit corruption of an exact count read as grounded and
 * shipped. That is exactly what production did, twice out of two, on
 * "what split-GAL4 lines label the lateral horn?".
 *
 * So: a small absolute slip (<= 2) is still rounding — 1200.5 written as 1,201
 * is fine. Beyond that, the answer's number has to be ROUNDER than the grounded
 * one to earn the percentage tolerance. "About 1,900" is rounder than 1,934 and
 * passes; "1,924" is not, and does not.
 */
function isRoundingOf(n, g) {
  const diff = Math.abs(g - n)
  if (g === n) return true
  if (diff <= 2) return true
  if (diff > Math.abs(g) * 0.02) return false
  return roundness(n) > roundness(g) || (Number.isInteger(n) && !Number.isInteger(g))
}

/**
 * Large numbers in the answer that do not match any grounded value. For logging,
 * not stripping — a false positive must never mangle a correct answer.
 */
export function findUngroundedNumbers(answerText = '', groundedNumbers = []) {
  const grounded = groundedNumbers.map(n => Number(n)).filter(Number.isFinite)
  const isGrounded = (n) => grounded.some(g => isRoundingOf(n, g))
  const seen = new Set()
  const out = []
  for (const hit of largeNumbersIn(answerText)) {
    const n = hit.value
    if (isGrounded(n) || seen.has(n)) continue
    if (looksLikeYear(hit)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]*\)/g
const digits = (n) => String(Math.trunc(Math.abs(n))).length

/**
 * Counts the synthesiser mis-typed: a number in the prose that is not grounded,
 * but is unambiguously a corrupted rendering of exactly one number this run
 * actually saw.
 *
 * The project's rule is that the model narrates and the deterministic layer
 * carries the numbers — every count rendered as a backend-built link was correct
 * on production, and both counts the model wrote in prose were wrong by one
 * digit. Nothing enforced the rule after synthesis. This is the enforcement, in
 * the same shape as stripLeakedIds: repair what is provably wrong, leave
 * everything else alone.
 *
 * Deliberately narrow, because a wrong "correction" is worse than the bug:
 *   - same number of digits as the grounded value (1,924 -> 1,934, never 100 -> 1,934);
 *   - within 2% of it, so it is a transcription slip rather than a different figure;
 *   - NOT rounder than it, so "about 1,900" is never rewritten to 1,934;
 *   - exactly ONE grounded candidate qualifies, so an ambiguous number is left;
 *   - numbers inside a markdown link are ignored — those are already the
 *     deterministic layer's own output.
 *
 * Returns [{ wrote, shouldBe }], empty when there is nothing provable.
 */
export function findMistranscribedCounts(answerText = '', groundedNumbers = []) {
  const grounded = [...new Set(groundedNumbers.map(n => Number(n)).filter(Number.isFinite))]
  if (!grounded.length) return []
  const masked = String(answerText).replace(MARKDOWN_LINK_RE, m => ' '.repeat(m.length))
  const out = []
  const seen = new Set()
  for (const hit of largeNumbersIn(masked)) {
    const n = hit.value
    if (seen.has(n)) continue
    seen.add(n)
    if (grounded.some(g => g === n)) continue
    if (looksLikeYear(hit)) continue
    const candidates = grounded.filter(g =>
      g !== n &&
      digits(g) === digits(n) &&
      Math.abs(g - n) <= Math.abs(g) * 0.02 &&
      roundness(n) <= roundness(g)
    )
    if (candidates.length === 1) out.push({ wrote: n, shouldBe: candidates[0] })
  }
  return out
}

const withSeparators = (n) => n.toLocaleString('en-GB')

/**
 * Apply findMistranscribedCounts to the text, preserving the thousands
 * separators the surrounding prose was written with and never touching a number
 * inside a markdown link.
 */
export function repairMistranscribedCounts(answerText = '', groundedNumbers = []) {
  const fixes = findMistranscribedCounts(answerText, groundedNumbers)
  if (!fixes.length) return { text: String(answerText), fixes: [] }
  const byValue = new Map(fixes.map(f => [f.wrote, f.shouldBe]))
  const applied = new Set()
  // One pass. A markdown link matches first and is returned verbatim, so its
  // digits are never candidates; only bare numbers reach the second branch.
  const text = String(answerText).replace(
    new RegExp(`${MARKDOWN_LINK_RE.source}|${LARGE_NUMBER_RE.source}`, 'g'),
    (match) => {
      if (match.startsWith('[')) return match
      const value = Number(match.replace(/,/g, ''))
      if (!byValue.has(value)) return match
      const target = byValue.get(value)
      applied.add(value)
      return match.includes(',') ? withSeparators(target) : String(target)
    }
  )
  return { text, fixes: fixes.filter(f => applied.has(f.wrote)) }
}
