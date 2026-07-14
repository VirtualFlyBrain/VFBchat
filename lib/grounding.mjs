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

/** Ontology ids present in the text (deduplicated). */
export function findLeakedIds(text = '') {
  return [...new Set((String(text).match(ONTOLOGY_ID_RE) || []))]
}

/**
 * Remove ontology ids the model wrote into prose. Run on the RAW synthesiser
 * output BEFORE deterministic linkification (which legitimately puts ids inside
 * report URLs). Drops a trailing "(FBbt_…)" after a label and any bare id, then
 * tidies whitespace — labels are re-linked from the registry afterwards.
 */
export function stripLeakedIds(text = '') {
  return String(text)
    .replace(/\s*\((?:FBbt_\d{6,}|VFB_[0-9a-z]{6,}|VFBexp_\w+|FB(?:gn|lc|rf|al|ti|tp|co)\d{6,})\)/gi, '')
    .replace(ONTOLOGY_ID_RE, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
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
