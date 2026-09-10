// Translate a finished answer into the user's language — and prove nothing
// load-bearing was lost on the way.
//
// The answer is written in English whatever language the question came in.
// That is deliberate: every safety layer behind an answer — the absence gate,
// the count repair, the grounding audit, the term and count linkers — reads
// English, and a Hungarian sentence goes straight past all of them. The photo
// that settled the design (Cologne, 10 September 2026) had the prose saying
// 327 driver lines above a table that said 392, in Hungarian, with no links at
// all, because nothing could read the sentence the number sat in.
//
// So the English pipeline runs unchanged, and translation is the LAST step, on
// the final markdown, under rules a machine can check afterwards:
//
//   - every markdown link target survives verbatim (the linkers' work);
//   - every number survives (the grounding layer's work);
//   - every VFB identifier survives;
//
// and a translation that fails the check is not shipped. One retry with the
// failures named, then the English answer goes out with a one-line note. The
// reader gets a verified answer in their language, or a verified answer in
// English — never an unverified one.
//
// Entity names stay English inside the translation, with the local name in
// brackets on first mention. VFB's labels are English, the links open English
// pages, and a reader who wants to find "ellipsoid body" in VFB needs the
// English string in front of them.

import { languageName, isEnglish } from './language.mjs'

const VFB_ID_RE = /\b(?:FBbt|FBgn|FBal|FBti|FBtp|FBco|FBlc|FBrf|VFBexp|VFB)_[0-9a-zA-Z]+\b/g

// Every decimal-digit block Unicode defines (general category Nd), by the code
// point of its zero: each block runs 0-9 contiguously from there. The check
// normalises the OUTPUT through this before comparing, so a translation that
// wrote ۳۹۲ for 392, or ๓๙๒, or ৩৯২, still passes — the prompt asks for 0-9,
// but a reader of any of those is reading the same number. Generated from
// /\p{Nd}/u over the whole code space; regenerate if Unicode adds a script.
const DIGIT_ZEROS = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0,
  0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
  0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136,
  0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0,
  0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce,
  0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0
]
const DIGIT_VALUE = new Map()
for (const zero of DIGIT_ZEROS) for (let d = 0; d <= 9; d++) DIGIT_VALUE.set(zero + d, String(d))

export function asciiDigits(s = '') {
  return String(s).replace(/\p{Nd}/gu, ch => DIGIT_VALUE.get(ch.codePointAt(0)) ?? ch)
}

/**
 * Every markdown link target and bare URL in the text, in order of appearance.
 * Reads `](` … `)` by hand so a title in quotes and a `)` inside the title do
 * not truncate the target.
 */
export function linkTargets(text = '') {
  const out = []
  const s = String(text)
  let i = 0
  while (i < s.length) {
    const at = s.indexOf('](', i)
    if (at === -1) break
    let j = at + 2
    // Target runs to whitespace or the closing paren.
    let url = ''
    while (j < s.length && !/[\s)]/.test(s[j])) url += s[j++]
    if (url) out.push(url)
    i = j
  }
  for (const m of s.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

/** Text with every markdown link target (and bare URL) blanked out. */
function withoutUrls(text = '') {
  let s = String(text)
  for (const url of linkTargets(s)) s = s.split(url).join(' ')
  return s
}

/**
 * The numbers the prose states, as canonical digit strings ("1,335" and
 * "1 335" are both "1335"). Taken from the text with the URLs removed, so a
 * query parameter's digits are not demanded of the prose.
 */
// Thousands and decimal separators a number may carry, in the scripts above:
// comma, full stop, narrow and ordinary no-break spaces, the Arabic thousands
// (U+066C) and decimal (U+066B) separators, and the apostrophe some locales use.
const SEPARATORS = ',.\\u202f\\u00a0 \\u066c\\u066b\\u2019\''
const NUMBER_RE = new RegExp(`(?<![A-Za-z_\\d])\\d(?:[\\d${SEPARATORS}]*\\d)?`, 'g')
const SEPARATOR_BEFORE_DIGIT_RE = new RegExp(`[${SEPARATORS}](?=\\d)`, 'g')

export function proseNumbers(text = '') {
  const s = asciiDigits(withoutUrls(text))
  const out = new Set()
  // A digit run inside an identifier or a symbol (FBbt_00003678, R66A08, GAL4)
  // is not a number the prose states; the ids are checked on their own.
  for (const m of s.matchAll(NUMBER_RE)) {
    const canon = m[0].replace(/[^\d]/g, '')
    if (canon) out.add(canon)
  }
  return [...out]
}

export function vfbIds(text = '') {
  return [...new Set(String(text).match(VFB_ID_RE) || [])]
}

/**
 * What the translation must preserve from the source, and what it did not.
 * Pure, so the rule is testable without a model.
 *
 * @returns {{ ok: boolean, missing: { urls: string[], numbers: string[], ids: string[] }, reason: string }}
 */
export function checkTranslation(source = '', translated = '') {
  const src = String(source)
  const out = String(translated)
  const missing = { urls: [], numbers: [], ids: [] }
  if (!out.trim()) return { ok: false, missing, reason: 'empty' }
  const ratio = out.length / Math.max(1, src.length)
  // A translation is never a tenth of its source or five times it. Either is a
  // summary, a refusal, or the model talking about the text instead of
  // translating it.
  if (src.length > 200 && (ratio < 0.3 || ratio > 5)) {
    return { ok: false, missing, reason: `length ratio ${ratio.toFixed(2)}` }
  }
  for (const url of linkTargets(src)) if (!out.includes(url)) missing.urls.push(url)
  const outCanon = asciiDigits(withoutUrls(out)).replace(SEPARATOR_BEFORE_DIGIT_RE, '')
  for (const n of proseNumbers(src)) if (!outCanon.includes(n)) missing.numbers.push(n)
  // Ids the PROSE states must survive in the prose; an id that only lives in a
  // link target is covered by the link check.
  const outProse = withoutUrls(out)
  for (const id of vfbIds(withoutUrls(src))) if (!outProse.includes(id)) missing.ids.push(id)
  const ok = !missing.urls.length && !missing.numbers.length && !missing.ids.length
  return {
    ok,
    missing,
    reason: ok ? '' : [
      missing.urls.length && `${missing.urls.length} link(s)`,
      missing.numbers.length && `${missing.numbers.length} number(s)`,
      missing.ids.length && `${missing.ids.length} id(s)`
    ].filter(Boolean).join(', ')
  }
}

const KEEP_RULES = `Keep EXACTLY as written, character for character: every markdown link — the text inside [ ] and everything inside the ( ) after it, including any quoted title; every number, written with the digits 0-9 (never localised digits, never spelled out); every identifier such as FBbt_00003682 or VFB_00101567; gene symbols, GAL4 and split-GAL4 line names, allele names, and dataset names (FlyWire, hemibrain, MANC, BANC, FAFB, FANC, neuprint, CATMAID). Keep the English names of anatomical structures, neuron types and cell types exactly as written wherever they appear — they are Virtual Fly Brain's labels and they are what the links open — and you may add the translated name in parentheses immediately after the FIRST mention of each. Keep the markdown structure unchanged: headings, list markers, tables (translate the header row only, never a cell value), emphasis, inline code and fenced blocks.`

/**
 * Messages for one translation call.
 *
 * @param {object} o
 * @param {string} o.text        finished English markdown
 * @param {string} o.language    target code
 * @param {'answer'|'clarification'} [o.kind='answer']
 * @param {{urls:string[],numbers:string[],ids:string[]}} [o.missing]  what a
 *   previous attempt dropped, named so the retry can fix it
 */
export function translationMessages({ text, language, kind = 'answer', missing = null }) {
  const lang = languageName(language)
  const what = kind === 'clarification' ? 'a short clarifying question' : 'an answer'
  // "Whatever language it is in": the text is English on an ordinary turn, but
  // a "reply in X" turn re-renders the previous answer, which may already be
  // in a third language.
  const system = `You are translating ${what} from a Virtual Fly Brain (VFB) chat assistant into ${lang}, from English or from whatever language it is currently written in. Translate the prose faithfully into natural, standard written ${lang}: do not add, drop, reorder or summarise information, do not answer the question yourself, and do not comment on the text. ${KEEP_RULES} Output only the translated markdown — no preamble, no notes, no code fence around it.`
  const complaint = missing && (missing.urls.length || missing.numbers.length || missing.ids.length)
    ? `\n\nYour previous translation dropped or altered: ${[
        ...missing.urls.map(u => `the link ${u}`),
        ...missing.numbers.map(n => `the number ${n}`),
        ...missing.ids.map(i => `the identifier ${i}`)
      ].join('; ')}. Translate again keeping each of these exactly as in the English.`
    : ''
  return [
    { role: 'system', content: system },
    { role: 'user', content: `ENGLISH:\n${text}${complaint}\n\nTranslate into ${lang}.` }
  ]
}

/**
 * Translate finished markdown, verify it, retry once, or give up honestly.
 *
 * @param {object} o
 * @param {string} o.text
 * @param {string} o.language
 * @param {'answer'|'clarification'} [o.kind]
 * @param {(o:{messages:object[], attempt:number}) => Promise<string>} o.call
 *   runs one translation and returns the full text (it may stream as it goes)
 * @param {(reason:string) => void} [o.onDiscard]  called before a retry when the
 *   previous attempt was already shown — the client must drop it
 * @param {number} [o.maxAttempts=2]
 * @returns {Promise<{ ok: boolean, text: string, attempts: number, reason: string }>}
 */
export async function translateMarkdown({ text, language, kind = 'answer', call, onDiscard, maxAttempts = 2 }) {
  if (isEnglish(language) || !String(text || '').trim()) {
    return { ok: true, text: String(text || ''), attempts: 0, reason: 'not needed' }
  }
  let missing = null
  let reason = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) { try { onDiscard?.(reason) } catch { /* best-effort */ } }
    let out = ''
    try {
      out = await call({ messages: translationMessages({ text, language, kind, missing }), attempt })
    } catch (err) {
      reason = `call failed: ${String(err?.message || err)}`
      continue
    }
    const check = checkTranslation(text, out)
    if (check.ok) return { ok: true, text: String(out).trim(), attempts: attempt, reason: '' }
    missing = check.missing
    reason = check.reason
  }
  return { ok: false, text: String(text || ''), attempts: maxAttempts, reason }
}

/**
 * The line that goes under an English answer when the translation could not be
 * verified. In English on purpose: a translated note would itself be an
 * unverified translation.
 */
export function translationFallbackNote(language) {
  return `_This answer is shown in English: a ${languageName(language)} translation could not be verified against the data it cites._`
}

export const CHIP_LABELS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['labels'],
  properties: { labels: { type: 'array', items: { type: 'string' } } }
}

export function chipLabelMessages(labels, language) {
  const lang = languageName(language)
  return [
    {
      role: 'system',
      content: `Translate these short follow-up questions from a Virtual Fly Brain chat into ${lang}, one for one, same order, same count. Keep the English names of anatomical structures, neuron types and cell types exactly as written (they are VFB's labels), keep any number in parentheses at the end exactly as written, and keep gene symbols, line names and dataset names unchanged. Return JSON: {"labels": [...]}.`
    },
    { role: 'user', content: JSON.stringify({ labels }) }
  ]
}

/**
 * Translate follow-on chip labels. The QUERY behind each chip stays English —
 * it is what runs when the chip is clicked, and the harness reads English —
 * only the visible label changes. Returns the original labels on any failure
 * or shape mismatch, so a chip can never lose its text.
 *
 * @param {object} o
 * @param {string[]} o.labels
 * @param {string} o.language
 * @param {(o:{messages:object[], schema:object, schemaName:string}) => Promise<{ok:boolean, value?:any}>} o.callStructured
 */
export async function translateChipLabels({ labels, language, callStructured }) {
  const src = (labels || []).map(l => String(l || ''))
  if (isEnglish(language) || !src.length || typeof callStructured !== 'function') return src
  try {
    const r = await callStructured({ messages: chipLabelMessages(src, language), schema: CHIP_LABELS_SCHEMA, schemaName: 'chip_labels' })
    const out = r?.ok && Array.isArray(r.value?.labels) ? r.value.labels.map(l => String(l || '').trim()) : null
    if (!out || out.length !== src.length || out.some(l => !l)) return src
    // A label's count "(392)" is data; a translation that lost it is rejected
    // for that label alone.
    return out.map((l, i) => {
      const n = src[i].match(/\((\d[\d,]*)\)\s*$/)
      return n && !asciiDigits(l).includes(n[1]) ? src[i] : l
    })
  } catch {
    return src
  }
}
