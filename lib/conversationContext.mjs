// Conversation context that survives the turn boundary (pure, offline-testable).
//
// The defect this exists to fix, in one trace:
//
//   turn 1  "what is the medulla?"        -> resolves FBbt_00003748, answers well,
//                                            offers "Which neurons receive output
//                                            from the medulla?" as a chip
//   turn 2  (that chip, clicked)          -> "The term 'medulla' was not matched to
//                                            a specific VFB entity in this session"
//
// Nothing was wrong with turn 2's question. What was wrong is that turn 1's
// ANSWER was the only thing carried forward. The client posted `{messages, scene}`
// and nothing else, so every id the previous turn established — the very ids that
// generated the chip the user clicked — was thrown away at the boundary, and turn
// 2 had to re-guess "medulla" from prose. When the guess missed, the synthesiser
// hedged ("cannot list the exact downstream neurons by name here") over an
// evidence block that still held the names, and contradicted itself in one
// paragraph.
//
// So this module carries two things across a turn, which is exactly what the
// request asked for:
//
//   1. RESOLVED INFO — the ids, authoritative labels and available-query
//      catalogue the conversation has already established. `buildTurnContext`
//      extracts it from the ledger; `mergeContext` folds it into what earlier
//      turns established.
//   2. MINIMIZED HISTORY — the prose, with everything that is expensive and
//      nothing that is load-bearing removed. `minimizeHistory`.
//
// ## Why the client echoes it back
//
// The server is stateless and there is no session store. Adding one would make
// every request depend on shared mutable state that has to be evicted, sized and
// kept consistent across replicas — a large amount of new failure surface to
// solve a problem that is really about one JSON object. Instead the server
// returns the merged context with its answer and the client posts it back
// verbatim on the next turn. Statelessness is preserved; the context lives
// exactly where the conversation does.
//
// ## Which means it is UNTRUSTED INPUT
//
// A client-echoed object is an object anyone can write. Everything here is
// therefore validated on the way in, not on the way out: ids must match VFB's own
// id grammar, labels are clipped, arrays are capped, unknown fields are dropped.
// The blast radius of a forged context is then bounded to "a label points at a
// real-looking VFB id that is not the right one" — the same failure the lexical
// search can already produce on its own, and never a link off virtualflybrain.org
// or an unbounded payload. `sanitizeContext` is the only door in, and every
// consumer here goes through it.
//
// ## What it is deliberately NOT
//
// Not a summary. Summarising is lossy in exactly the dimension that matters here:
// an id survives a summary only by luck, and a nearly-right id is worse than a
// missing one. The structured half of this module never passes through a model.
// The existing LLM history compaction still exists for genuinely long
// conversations; this runs on every turn, underneath it, and is deterministic.

import { stripMarkdownLinks } from './markdownLinks.mjs'
import { registryKey } from './ledger.mjs'

/** Bump when the shape changes; an older/newer context is dropped, not guessed at. */
export const CONTEXT_VERSION = 1

// VFB's id grammar. A carried id that does not match is not sanitised into
// something safe — it is dropped, because we have no idea what it is.
const VFB_ID_RE = /^(?:FBbt|FBgn|FBal|FBti|FBtp|FBco|FBlc|FBrf|VFBexp|VFB)_[0-9a-zA-Z]+$/

// Caps. These bound the round-tripped payload, which the user's browser has to
// carry and we have to parse on every turn. Generous enough that a normal
// conversation never notices, small enough that a hostile one cannot grow.
const MAX_TERMS = 24
const MAX_QUERIES_PER_TERM = 14
const MAX_REGISTRY = 300
const MAX_LABEL_CHARS = 160

const COUNT_KINDS = new Set(['exact', 'many', 'unknown'])

function clip(s, max = MAX_LABEL_CHARS) {
  const t = stripMarkdownLinks(String(s ?? '')).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max).trim() : t
}

/**
 * Normalised key for matching a name the planner wrote against a name a previous
 * turn resolved. Deliberately forgiving in the ways English is — case, spacing,
 * a leading article, a trailing plural or full stop — and deliberately unforgiving
 * everywhere else. This decides whether we SKIP a search, so a false match spends
 * the whole turn answering about the wrong entity.
 */
export function normName(s = '') {
  return stripMarkdownLinks(String(s ?? ''))
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^\s*the\s+/, '')
    .replace(/[.,;:!?]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Both the name as written and its singular form, so "medullas" finds "medulla". */
export function nameKeys(s = '') {
  const k = normName(s)
  if (!k) return []
  const keys = [k]
  if (/[^s]s$/.test(k)) keys.push(k.slice(0, -1))
  return keys
}

/**
 * Extract this turn's resolved info from the ledger.
 *
 * Only VFB-derived facts are taken: the id, the term-info Name (never the
 * planner's wording for it — that is what once pinned "mushroom body" to a MBON
 * id), and the query catalogue with its counts. `name` is kept alongside `label`
 * because the next turn's planner will write the user's wording, not VFB's, and
 * matching on both is what lets a carried id be found at all.
 */
export function buildTurnContext(ledger, { maxTerms = MAX_TERMS, maxQueries = MAX_QUERIES_PER_TERM } = {}) {
  const terms = []
  const seenId = new Set()

  // id -> authoritative VFB label, from canonical registry entries only.
  const idLabel = {}
  for (const e of Object.values(ledger?.registry || {})) {
    if (e?.canonical && e.id && !idLabel[e.id]) idLabel[e.id] = e.label
  }

  for (const [name, t] of Object.entries(ledger?.terms || {})) {
    if (!t?.id || !VFB_ID_RE.test(t.id) || seenId.has(t.id)) continue
    seenId.add(t.id)
    const queries = (t.digest?.queries || [])
      .filter(q => q?.query_type)
      .map(q => ({
        query_type: String(q.query_type),
        label: clip(q.label || ''),
        count: Number.isFinite(Number(q.count)) ? Number(q.count) : -1,
        countKind: COUNT_KINDS.has(q.countKind) ? q.countKind : (Number(q.count) < 0 ? 'unknown' : 'exact')
      }))
      .slice(0, maxQueries)
    terms.push({
      name: clip(name),
      label: clip(t.digest?.name || idLabel[t.id] || name),
      id: t.id,
      queries
    })
    if (terms.length >= maxTerms) break
  }

  // The registry is what makes a term stay a link on a turn that resolves nothing
  // new. Carried as pairs rather than an object: half the bytes, and it cannot
  // arrive back with a prototype-polluting key.
  const registry = []
  for (const [key, e] of Object.entries(ledger?.registry || {})) {
    if (!e?.id || !VFB_ID_RE.test(e.id)) continue
    registry.push([clip(key, 80), e.id, clip(e.label, 80)])
    if (registry.length >= MAX_REGISTRY) break
  }

  return { v: CONTEXT_VERSION, terms, registry }
}

/**
 * Validate a context that arrived from the client. Anything malformed is dropped
 * rather than repaired — see the header. Always returns a well-formed context,
 * possibly an empty one, so no caller needs a null check.
 */
export function sanitizeContext(raw) {
  const empty = { v: CONTEXT_VERSION, terms: [], registry: [] }
  if (!raw || typeof raw !== 'object') return empty
  // A context from a different version of this shape is not partially usable.
  if (Number(raw.v) !== CONTEXT_VERSION) return empty

  const terms = []
  const seenId = new Set()
  for (const t of (Array.isArray(raw.terms) ? raw.terms : [])) {
    const id = typeof t?.id === 'string' ? t.id.trim() : ''
    if (!VFB_ID_RE.test(id) || seenId.has(id)) continue
    seenId.add(id)
    const queries = []
    for (const q of (Array.isArray(t.queries) ? t.queries : [])) {
      const qt = typeof q?.query_type === 'string' ? q.query_type.trim() : ''
      // A query type reaches a URL, so it is restricted to the identifier shape
      // VFB's own query types use rather than merely escaped.
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(qt)) continue
      const count = Number(q.count)
      queries.push({
        query_type: qt,
        label: clip(q.label || ''),
        count: Number.isFinite(count) ? count : -1,
        countKind: COUNT_KINDS.has(q.countKind) ? q.countKind : (Number.isFinite(count) && count >= 0 ? 'exact' : 'unknown')
      })
      if (queries.length >= MAX_QUERIES_PER_TERM) break
    }
    const label = clip(t.label || '')
    const name = clip(t.name || '') || label
    if (!label && !name) continue
    terms.push({ name, label: label || name, id, queries })
    if (terms.length >= MAX_TERMS) break
  }

  const registry = []
  const seenKey = new Set()
  for (const row of (Array.isArray(raw.registry) ? raw.registry : [])) {
    if (!Array.isArray(row)) continue
    const key = clip(row[0], 80).toLowerCase()
    const id = typeof row[1] === 'string' ? row[1].trim() : ''
    if (!key || !VFB_ID_RE.test(id) || seenKey.has(key)) continue
    seenKey.add(key)
    registry.push([key, id, clip(row[2] || key, 80)])
    if (registry.length >= MAX_REGISTRY) break
  }

  return { v: CONTEXT_VERSION, terms, registry }
}

/**
 * Fold this turn's context into the conversation's. Most-recent-first, deduped by
 * id, capped.
 *
 * Recency ordering is the whole eviction policy, and it is the right one for a
 * conversation: the entity under discussion is the one most recently resolved,
 * and when the cap bites it is the entity nobody has mentioned for twenty turns
 * that should go. A term re-resolved this turn moves back to the front AND takes
 * this turn's counts, because a count is a fact with an age.
 */
export function mergeContext(prev, turn, { maxTerms = MAX_TERMS, maxRegistry = MAX_REGISTRY } = {}) {
  const a = sanitizeContext(prev)
  const b = sanitizeContext(turn)

  const terms = []
  const seenId = new Set()
  for (const t of [...b.terms, ...a.terms]) {
    if (seenId.has(t.id)) continue
    seenId.add(t.id)
    // A re-resolved term keeps the fresher entry (b comes first) but inherits the
    // older query catalogue if this turn produced none — a turn that reached the
    // term through a query result rather than term-info has the id and no digest,
    // and dropping the catalogue would silently disarm the follow-on chips.
    if (!t.queries.length) {
      const older = a.terms.find(o => o.id === t.id && o.queries.length)
      if (older) { terms.push({ ...t, queries: older.queries }); continue }
    }
    terms.push(t)
    if (terms.length >= maxTerms) break
  }

  const registry = []
  const seenKey = new Set()
  for (const row of [...b.registry, ...a.registry]) {
    if (seenKey.has(row[0])) continue
    seenKey.add(row[0])
    registry.push(row)
    if (registry.length >= maxRegistry) break
  }

  return { v: CONTEXT_VERSION, terms: terms.slice(0, maxTerms), registry }
}

/**
 * The id a previous turn already resolved for this name, or null.
 *
 * Matched against the user's wording first and VFB's own label second. This is
 * the value that becomes `directId` in `resolveTerms`, reusing the short-circuit
 * that already exists there for an id written into the question — so a carried id
 * skips only the GUESSING. The term-info fetch still happens and the digest is
 * still rebuilt fresh, because a count from four turns ago is not evidence about
 * now.
 *
 * Deliberately restricted to `terms` — the entities a previous turn set out to
 * resolve and did. The registry is not consulted, although it is larger and would
 * match more names, because most of it is incidental: labels harvested from query
 * result rows, one of which could be a generic word that a later question happens
 * to use in a different sense. Letting one of those skip a search would trade a
 * cheap lookup for a silently wrong subject, and this whole module exists because
 * a silently wrong subject is expensive. The registry earns its keep in
 * `seedLedgerFromContext`, where a wrong entry costs at most a wrong hyperlink on
 * a word — visible, and not load-bearing for the answer.
 */
export function priorTermId(context, name) {
  const ctx = sanitizeContext(context)
  const keys = nameKeys(name)
  if (!keys.length) return null
  for (const key of keys) {
    for (const t of ctx.terms) if (nameKeys(t.name).includes(key)) return t.id
    for (const t of ctx.terms) if (nameKeys(t.label).includes(key)) return t.id
  }
  return null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A whole-word matcher for a term name, built to survive real VFB labels.
 *
 * `\b` asks "is there a word/non-word transition here?", which is the wrong
 * question at both ends. A label like "GAL4 (attP2)" ends in ")", so a trailing
 * `\b` demands a word character immediately after the bracket — something no
 * sentence supplies, and the label could never match itself. The lookarounds ask
 * the question that was actually meant: is the NEIGHBOURING character part of a
 * word? That holds whatever the label's own edge character happens to be.
 *
 * The optional plural closes the other half of the asymmetry. `nameKeys`
 * singularises a stored "medullas" so it can be found by "medulla", but nothing
 * pluralises a stored "medulla" to meet a user who typed "medullas" — and the
 * user's wording is the side we do not control. Added only where the key does not
 * already end in "s", which is the same guard `nameKeys` applies in reverse.
 */
function nameMatcher(key) {
  const plural = /[^s]$/.test(key) ? 's?' : ''
  return new RegExp(`(?<!\\w)${escapeRe(key)}${plural}(?!\\w)`)
}

/**
 * The carried terms the CURRENT question actually names.
 *
 * The success of `contextPromptBlock` created the problem this solves. Once the
 * planner can see "medulla = FBbt_00003748" it stops asking for the name to be
 * resolved — which is the whole point, and which also means `terms_to_resolve` is
 * empty, `resolveTerms` never runs, and `ledger.terms` ends the turn empty. Every
 * deterministic thing built from resolved terms is then built from nothing:
 * `buildFollowOns` returns no chips, no sources and no term links. Turn 1 offered
 * the user six follow-ups; turn 2, having answered BETTER because of the carried
 * context, offered none and dead-ended the conversation.
 *
 * So the carried id has to re-enter the turn as a name to resolve, not as a fact
 * to trust. What comes back from `resolveTerms` is then a fresh digest with fresh
 * counts down the `directId` short-circuit — no search, one term-info fetch, and
 * nothing stale reaches the synthesiser. Adopting the carried digest directly
 * would have been cheaper and wrong: a count is a fact with an age, and this
 * module already refuses to carry counts forward as evidence anywhere else.
 *
 * Matching is whole-word (see `nameMatcher`) on both the user's earlier wording
 * and VFB's label, so "the medulla" in turn 1 is found by "output from the
 * medulla" in turn 2 while "medullary" is not. Capped, because a long
 * conversation accumulates entities and every one adopted costs a term-info
 * round trip.
 */
export function contextTermsNamedIn(context, question, { max = 3 } = {}) {
  const ctx = sanitizeContext(context)
  const q = normName(question)
  if (!q || !ctx.terms.length) return []
  const out = []
  for (const t of ctx.terms) {
    const keys = new Set([...nameKeys(t.name), ...nameKeys(t.label)].filter(Boolean))
    let named = false
    for (const key of keys) {
      if (nameMatcher(key).test(q)) { named = true; break }
    }
    if (!named) continue
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/**
 * The query catalogue a previous turn established for an id — used to validate a
 * follow-on chip's `{id, query_type}` before it is run. A chip claiming a query
 * the term never advertised is not honoured.
 */
export function priorTermQueries(context, id) {
  const ctx = sanitizeContext(context)
  return ctx.terms.find(t => t.id === id)?.queries || []
}

/**
 * Seed a fresh ledger with what the conversation already knows.
 *
 * Two distinct effects, and the second is easy to miss:
 *   - the registry is prefilled, so a term resolved three turns ago is still
 *     linkified in this turn's prose. Without this, a follow-up answer about the
 *     medulla mentions "medulla" as flat text purely because this turn happened
 *     not to re-resolve it, and the conversation visibly degrades as it goes on.
 *   - `_priorContext` is attached for `resolveTerms` to consult.
 *
 * Seeded registry entries are NON-canonical on purpose. `recordTermId` lets a
 * canonical source upgrade a non-canonical one, so anything VFB says THIS turn
 * outranks anything carried in — the carried mapping holds the fort and never
 * outvotes fresh data.
 *
 * The key must be `recordTermId`'s key, not `normName`'s. That upgrade is the
 * only reason seeding is safe, and it is a plain object-key comparison: seed
 * "the medulla" under a prettier key than the one recordTermId will compute and
 * the upgrade silently stops happening, leaving a carried mapping outranking
 * live VFB data — the exact inversion this design promises never to make.
 */
export function seedLedgerFromContext(ledger, context) {
  const ctx = sanitizeContext(context)
  if (!ledger) return ledger
  ledger._priorContext = ctx
  if (!ctx.terms.length && !ctx.registry.length) return ledger
  if (!ledger.registry) ledger.registry = {}
  const put = (label, id) => {
    // registryKey, imported from the ledger, rather than a look-alike computed
    // here — a look-alike is how this drifts.
    const key = registryKey(label)
    if (!key || !VFB_ID_RE.test(id)) return
    if (!ledger.registry[key]) {
      ledger.registry[key] = { id, label: stripMarkdownLinks(String(label)), canonical: false, carried: true }
    }
  }
  for (const [key, id, label] of ctx.registry) put(label || key, id)
  for (const t of ctx.terms) put(t.label, t.id)
  return ledger
}

/**
 * The block handed to the planner. Deliberately terse and deliberately
 * imperative: the planner's job here is not to reason about the conversation but
 * to stop re-deriving something already known.
 *
 * Query types are listed because the commonest follow-up in this product is "now
 * run one of the things you just offered me", and a planner that can see the
 * catalogue picks from it instead of inventing a tool call for data that does not
 * exist.
 */
export function contextPromptBlock(context, { maxTerms = 8, maxQueries = 8 } = {}) {
  const ctx = sanitizeContext(context)
  if (!ctx.terms.length) return ''
  const lines = ctx.terms.slice(0, maxTerms).map(t => {
    const qs = t.queries.slice(0, maxQueries).map(q => q.query_type).join(', ')
    const alias = normName(t.name) && normName(t.name) !== normName(t.label) ? ` (asked about as "${t.name}")` : ''
    return `- ${t.label} = ${t.id}${alias}${qs ? `; available queries: ${qs}` : ''}`
  })
  return [
    'ALREADY RESOLVED IN THIS CONVERSATION (use these ids; do not re-search these names):',
    ...lines,
    'If the current question is about one of these, reuse its id directly rather than searching for the name again.'
  ].join('\n')
}

// --- minimized history ---------------------------------------------------

const HISTORY_DEFAULTS = {
  maxChars: 6000,        // total budget for the whole minimized history
  maxPerMessage: 900,    // no single turn may crowd out the rest
  keepRecent: 8          // full-fidelity window; older turns are dropped, not summarised
}

/**
 * Reduce one message to the part that carries meaning across a turn.
 *
 * An assistant answer in this product is mostly apparatus: markdown links whose
 * targets are 90-character VFB URLs with hover titles, image embeds, and result
 * tables of twenty rows. None of it helps the next turn's planner — the ids are
 * carried structurally now, which is precisely what frees the prose to be cut —
 * and all of it is paid for on every subsequent request, forever.
 *
 * Links become their own text, which is the important asymmetry: the sentence
 * stays readable and stays about the same entity, it just stops carrying the URL.
 */
export function minimizeMessage(text = '', { maxPerMessage = HISTORY_DEFAULTS.maxPerMessage } = {}) {
  let s = String(text ?? '')
  if (!s.trim()) return ''
  s = s.replace(/```[\s\S]*?```/g, ' ')          // fenced blocks
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // image embeds
  s = stripMarkdownLinks(s)                       // [text](url "title") -> text
  s = s.replace(/^\s*\|.*\|\s*$/gm, '')           // table rows (incl. separators)
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')        // heading markers
  s = s.replace(/[*_`]+/g, '')                    // emphasis / code ticks
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n{2,}/g, '\n').trim()
  if (s.length <= maxPerMessage) return s
  // Cut at a sentence end where one is near the limit, so the tail is not a
  // half-sentence the planner has to guess the end of.
  const head = s.slice(0, maxPerMessage)
  const stop = head.lastIndexOf('. ')
  return (stop > maxPerMessage * 0.6 ? head.slice(0, stop + 1) : head.trim()) + ' …'
}

/**
 * The history the client sends. Recent turns first-class, older ones dropped
 * whole, everything stripped of apparatus, total capped.
 *
 * Dropping the oldest turns rather than compressing them is the honest failure
 * mode: what the old turns established is carried structurally in the context
 * object, which does not decay, so what is lost here is phrasing rather than
 * fact. The existing LLM compaction still sits above this for the conversations
 * long enough to need it — this just means it is reached far later and, when it
 * is reached, it is summarising prose that is already lean.
 */
export function minimizeHistory(messages, opts = {}) {
  const { maxChars, maxPerMessage, keepRecent } = { ...HISTORY_DEFAULTS, ...opts }
  const all = (Array.isArray(messages) ? messages : []).filter(m =>
    m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
  const recent = all.slice(-keepRecent)
  const dropped = all.length - recent.length

  const out = []
  let used = 0
  // Fill from the most recent backwards: when the budget runs out it is the
  // oldest turn that is lost, never the one being answered.
  for (let i = recent.length - 1; i >= 0; i--) {
    const content = minimizeMessage(recent[i].content, { maxPerMessage })
    if (!content) continue
    if (used + content.length > maxChars && out.length) break
    used += content.length
    out.unshift({ role: recent[i].role, content })
  }
  return { messages: out, dropped: dropped + (recent.length - out.length), chars: used }
}
