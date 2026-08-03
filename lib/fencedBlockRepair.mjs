// Close a fenced code block that the synthesiser truncated, using the source it
// was copied from.
//
// The evidence reaching the synthesiser is now the WHOLE configuration block
// (see completeQuoteFromSource), and the prompt tells it to transcribe that
// block character for character. It mostly does. But on roughly two runs in five
// it re-indents the JSON as it copies — and a block the model has reformatted is
// a block it can silently truncate. What the reader got was six perfect lines
// and a missing final brace: JSON that does not parse, which is worse than none
// because it looks complete.
//
// A prompt cannot make that reliable, and the answer is streamed token by token,
// so there is nothing to fix up afterwards — by the time the text is complete it
// has already been shown. So the repair happens IN the stream: fenced-block
// content is held back until its closing fence arrives, and released repaired.
// Holding back a code block costs a moment; everything outside a fence streams
// through untouched.
//
// The repair itself never invents. It delegates to completeQuoteFromSource,
// which only ever appends characters taken from the source quote, and only when
// the block is actually FOUND in that quote. A code block that came from
// somewhere else — a Python snippet, a Cypher query, a deliberate fragment —
// matches no documentation quote and is passed through exactly as written.

import { completeQuoteFromSource } from './externalEvidence.mjs'

const FENCE = '```'

// The other thing that reaches the reader as a fenced block and should not: the
// synthesiser's own input. Asked to reproduce a snippet verbatim, it sometimes
// reproduces the record CARRYING the snippet instead —
//   {"claim":"NeuroFly 2026 will be held …","source":"doc","verbatim":"…","ref":"…"}
// — or, on a question about mushroom body diagrams, the whole query catalogue it
// was handed, {"tool":"VFB","key":"Queries","rows":[…]}. Both are plumbing. The
// prompt has been told twice not to do this and does it anyway on some runs, so
// the rule is enforced here instead, where it cannot be argued with: a fenced
// block shaped like an internal record is dropped whole, fences and all.
//
// Shape, not content — a real configuration has none of these key combinations,
// and the test is only ever applied to something already inside a code fence.
function isInternalRecord(block = '') {
  const t = String(block || '').trim()
  if (!t || !(t.startsWith('{') || t.startsWith('['))) return false
  let parsed = null
  try { parsed = JSON.parse(t) } catch { parsed = null }
  if (parsed) {
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.some(o => o && typeof o === 'object' && !Array.isArray(o) && (
      ('claim' in o && ('source' in o || 'verbatim' in o || 'ref' in o)) ||
      ('verbatim' in o && 'ref' in o) ||
      ('tool' in o && ('rows' in o || 'key' in o))
    ))
  }
  // Truncated mid-record — still recognisable, and still not for the reader.
  if (/"(?:claim|verbatim)"\s*:/.test(t) && /"(?:source|ref)"\s*:/.test(t)) return true
  return /"tool"\s*:/.test(t) && /"(?:rows|key)"\s*:/.test(t)
}

/**
 * A stateful filter over a stream of text deltas.
 *
 * @param {string[]} sourceQuotes  the verbatim documentation quotes this answer
 *   was written from; a block is only ever completed from one of these.
 * @returns {{push:(delta:string)=>string, flush:()=>string}}  text to emit
 */
export function createFenceRepairer(sourceQuotes = []) {
  const sources = (Array.isArray(sourceQuotes) ? sourceQuotes : []).map(String).filter(Boolean)
  let buffer = ''
  let inFence = false
  // The opening fence line is held with the block rather than streamed ahead of
  // it: a block that turns out to be an internal record is dropped whole, and it
  // cannot be if its fence has already been shown. Costs nothing — the block's
  // contents were being withheld until the closing fence anyway.
  let opener = ''

  // The trailing newline and indentation before the closing fence belong to the
  // markdown, not to the block, and completeQuoteFromSource would have to match
  // through them. Split them off, repair the block, put them back.
  const repairBlock = block => {
    const m = /\n[ \t]*$/.exec(block)
    const core = m ? block.slice(0, m.index) : block
    const tail = m ? m[0] : ''
    if (!core.trim()) return block
    for (const src of sources) {
      const fixed = completeQuoteFromSource(core, src)
      if (fixed !== core) return fixed + tail
    }
    return block
  }

  // Backticks at the very end of a chunk may be the start of a fence that has
  // not finished arriving. Hold them rather than emitting half a marker.
  const heldBackTicks = text => {
    let n = 0
    while (n < 2 && n < text.length && text[text.length - 1 - n] === '`') n++
    return n === text.length ? n : (text[text.length - 1] === '`' ? n : 0)
  }

  const drain = () => {
    let out = ''
    for (;;) {
      if (!inFence) {
        const i = buffer.indexOf(FENCE)
        if (i < 0) {
          const keep = heldBackTicks(buffer)
          out += buffer.slice(0, buffer.length - keep)
          buffer = buffer.slice(buffer.length - keep)
          return out
        }
        // Everything up to the fence streams through; the fence itself and its
        // info string ("```json") are held with the block they open.
        const nl = buffer.indexOf('\n', i)
        if (nl < 0) { out += buffer.slice(0, i); buffer = buffer.slice(i); return out }
        out += buffer.slice(0, i)
        opener = buffer.slice(i, nl + 1)
        buffer = buffer.slice(nl + 1)
        inFence = true
      } else {
        const j = buffer.indexOf(FENCE)
        if (j < 0) return out
        const block = repairBlock(buffer.slice(0, j))
        if (!isInternalRecord(block)) out += opener + block + FENCE
        opener = ''
        buffer = buffer.slice(j + FENCE.length)
        inFence = false
      }
    }
  }

  return {
    push(delta = '') { buffer += String(delta || ''); return drain() },
    /** Whatever is still held when the stream ends — repaired if mid-block. */
    flush() {
      let rest = buffer
      if (inFence) {
        const block = repairBlock(buffer)
        rest = isInternalRecord(block) ? '' : opener + block
      }
      buffer = ''
      opener = ''
      inFence = false
      return rest
    }
  }
}
