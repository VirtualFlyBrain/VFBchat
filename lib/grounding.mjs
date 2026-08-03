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
 * registry, and the ids of the example entities / preview rows VFB returned.
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
  return [...ids]
}

// Large numbers in the answer: 4+ digit integers (with optional thousands commas),
// optionally with a decimal. These are the count/weight/expression-level claims.
function largeNumbersIn(text = '') {
  const out = []
  for (const m of String(text).matchAll(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/g)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
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

/**
 * Large numbers in the answer that do not match any grounded value (allowing for
 * the synthesiser rounding: equal within 2% or ±2). For logging, not stripping —
 * a false positive must never mangle a correct answer.
 */
export function findUngroundedNumbers(answerText = '', groundedNumbers = []) {
  const grounded = groundedNumbers.map(n => Number(n)).filter(Number.isFinite)
  const isGrounded = (n) => grounded.some(g => g === n || Math.abs(g - n) <= Math.max(2, Math.abs(g) * 0.02))
  const seen = new Set()
  const out = []
  for (const n of largeNumbersIn(answerText)) {
    if (isGrounded(n) || seen.has(n)) continue
    if (Number.isInteger(n) && n >= 1900 && n <= 2099) continue   // a year, not a count
    seen.add(n)
    out.push(n)
  }
  return out
}
