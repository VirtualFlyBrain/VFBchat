// Markdown-link parsing that survives a label containing its own square brackets.
//
// Every markdown reader in this codebase was written as `\[([^\]]+)\]\(([^)]*)\)`,
// which is correct right up until VFB returns an expression pattern:
//
//   [PBac{602.P.SVS-1}Fas2[CPTI000483] expression pattern](VFBexp_FBti0144014)
//
// `[^\]]+` stops dead at the "]" inside "Fas2[CPTI000483]", so the link neither
// matches nor strips. The consequence was not cosmetic: summariseMacroToolRows
// registered the whole markdown string as the term's NAME, buildTermLinks carried
// that string into termLinks, and linkifyKnownTerms could then never match the
// plain name the synthesiser had written — so twelve GAL4 expression patterns
// came back in the answer as literal "[Name]" brackets with nothing behind them.
//
// Scanning for the balance point instead of the first "]" costs a few lines and
// makes the whole family of labels work. When a span is NOT a well-formed link
// (an unbalanced "[", no "(" after the close, no closing ")") every function here
// leaves the text exactly as it found it — a half-parsed genotype is worse than
// an unparsed one.

/**
 * Parse the markdown link that starts at `from` (where `str[from]` must be "[").
 *
 * Square brackets inside the link TEXT are tolerated by counting depth; the link
 * ends at the "]" that returns depth to zero, which must be followed immediately
 * by "(...)".
 *
 * The TARGET is scanned the same way, because the comment that used to sit here —
 * "the ids and URLs we emit never contain one" — was true of the URL and false of
 * the link as a whole. Every link this codebase writes carries a hover title, and
 * that title is built from a VFB label:
 *
 *   [KCab-c(i)](https://…/FBbt_00049111 "Open KCab-c(i) in Virtual Fly Brain")
 *
 * Stopping at the first ")" ended the link in the middle of its own title, so the
 * rest of the title was handed back to the linkifiers as ordinary prose and came
 * back with a second link nested inside the first. Parentheses in a target are
 * balanced, and anything inside a double-quoted run is skipped, so a title may
 * contain an unbalanced bracket of its own.
 *
 * @returns {{text:string, target:string, end:number}|null} `end` is the index one
 *   past the closing ")". null when this is not a well-formed link.
 */
export function matchMarkdownLinkAt(str, from = 0) {
  const s = String(str)
  if (s[from] !== '[') return null
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth > 0) continue
      if (s[i + 1] !== '(') return null
      const close = endOfTarget(s, i + 2)
      if (close === -1) return null
      return { text: s.slice(from + 1, i), target: s.slice(i + 2, close), end: close + 1 }
    }
  }
  return null
}

/** Index of the ")" that closes a target opened at `from`, or -1. */
function endOfTarget(s, from) {
  let depth = 1
  let quoted = false
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Replace every well-formed "[text](target)" in `s` with just its text. */
export function stripMarkdownLinks(s = '') {
  const str = String(s)
  let out = ''
  for (let i = 0; i < str.length;) {
    if (str[i] === '[') {
      const m = matchMarkdownLinkAt(str, i)
      if (m) { out += m.text; i = m.end; continue }
    }
    out += str[i]
    i++
  }
  return out.trim()
}

/**
 * A VFB table cell, which is either a whole markdown link or plain text.
 * @returns {{text:string, target:string}} target is "" when the cell is plain.
 */
export function splitMarkdownCell(cell = '') {
  const s = String(cell).trim()
  if (s.startsWith('[')) {
    const m = matchMarkdownLinkAt(s, 0)
    // Anchored: a cell that is a link PLUS trailing prose is prose, not a link.
    if (m && m.end === s.length) return { text: m.text.trim(), target: m.target.trim() }
  }
  return { text: s, target: '' }
}

/**
 * Every well-formed link in a string, in order, as {text, target}.
 *
 * Some VFB columns hold a LIST of links in one cell rather than a single entity:
 * SimilarMorphologyTo's "type" column reads
 *   "[lobula plate-lobula columnar neuron LPLC2](FBbt_00111763); [adult VPNd1 lineage neuron](FBbt_00050108)"
 * when a neuron is typed as more than one class. splitMarkdownCell is anchored
 * and returns such a cell as plain text (correctly — it is not one link), so a
 * caller that wants each class needs this instead. Splitting on ";" first would
 * be wrong: a label may contain one.
 */
export function parseMarkdownLinks(s = '') {
  const str = String(s)
  const out = []
  for (let i = 0; i < str.length;) {
    if (str[i] === '[') {
      const m = matchMarkdownLinkAt(str, i)
      if (m) {
        out.push({ text: m.text.trim(), target: m.target.trim() })
        i = m.end
        continue
      }
    }
    i++
  }
  return out
}

// Code spans and bare URLs need no balancing; only links do.
const CODE_OR_URL = /^(?:`[^`]*`|https?:\/\/\S+)/

// A fenced block has to be matched as one span, before the single-backtick rule
// gets a look at it. Until this existed a ```python fence was protected only by
// accident: the opening ``` parsed as an empty `` span plus a stray backtick,
// and the arithmetic happened to come out even. One backtick anywhere inside
// the fence — a docstring, a shell snippet, a nested span — flipped the parity
// and left the code open to linkification, so a term name inside a code block
// could be rewritten into a markdown link. Unterminated fences run to the end
// of the string, which is what a truncated stream produces.
const FENCE = /^```[\s\S]*?(?:\n```|```|$)/

/**
 * Split prose into alternating [plain, protected, plain, protected, …] segments —
 * the shape the linkifiers already expect from String.split with a capturing
 * regex, but with links matched by balance rather than by `[^\]]*`.
 *
 * Protected = an existing markdown link, a fenced code block, a code span, or a
 * bare URL. A linkifier
 * that rewrites a protected span would nest a link inside a link, or linkify the
 * number inside a URL.
 *
 * Always returns an odd number of segments, starting and ending with a plain one
 * (possibly empty), so `i % 2 === 1` identifies the protected spans.
 */
export function splitProtectedSpans(text = '') {
  const s = String(text)
  const parts = []
  let plain = ''
  for (let i = 0; i < s.length;) {
    let span = null
    if (s[i] === '[') {
      const m = matchMarkdownLinkAt(s, i)
      if (m) span = s.slice(i, m.end)
    }
    if (!span && s.startsWith('```', i)) {
      const m = FENCE.exec(s.slice(i))
      if (m) span = m[0]
    }
    if (!span) {
      const m = CODE_OR_URL.exec(s.slice(i))
      if (m) span = m[0]
    }
    if (span) {
      parts.push(plain, span)
      plain = ''
      i += span.length
      continue
    }
    plain += s[i]
    i++
  }
  parts.push(plain)
  return parts
}
