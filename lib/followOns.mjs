// Follow-on suggestions + provenance (pure, offline-testable).
//
// After a term-anchored answer we offer the user two clearly-distinct actions:
//   - ASK chips: run a new chat query (deterministically derived from the term's
//     real VFB data — its term-info Queries catalogue — so we never invent a
//     follow-on the data can't answer).
//   - OPEN-IN-VFB chips / Sources: links to the VFB term report (the "term info
//     page or query containing the data") — this is the clickable provenance
//     that replaces the bare "(vfb)" tags.
//
// Generation is deterministic from `ledger.terms[*].digest`; nothing here depends
// on the weak model. See outputs/reports/vfbchat-live-eval-and-followons-2026-06-13.md.

import { PREVIEW_COUNT_CAP } from './termInfoDigest.mjs'
import { stripMarkdownLinks, splitProtectedSpans } from './markdownLinks.mjs'
import { querySemantics } from './queryTypes.mjs'

// A digest query's count as it should appear on a chip, and as it should sort.
// 'many' (count -1, preview resolved) means MORE than the cap, so it belongs at
// the top of the chip list, not excluded from it — previously every -1 query was
// silently dropped, which hid exactly the largest and most interesting queries.
// 'unknown' (count -1, preview pending) is still offerable; it just carries no
// number.
function countKindOf(q) {
  return q?.countKind || (Number(q?.count) < 0 ? 'unknown' : 'exact')
}
function chipCountSuffix(q) {
  const kind = countKindOf(q)
  if (kind === 'many') return ` (${PREVIEW_COUNT_CAP}+)`
  if (kind === 'unknown') return ''
  return ` (${q.count})`
}
function chipSortValue(q) {
  const kind = countKindOf(q)
  if (kind === 'many') return Number.MAX_SAFE_INTEGER
  if (kind === 'unknown') return 0
  return Number(q.count) || 0
}

const VFB_REPORT = 'https://www.virtualflybrain.org/reports/'

/** VFB term report URL for an FBbt_/VFB_ id. */
export function vfbReportUrl(id) {
  return id ? `${VFB_REPORT}${encodeURIComponent(id)}` : ''
}

/** VFB v2 browser URL that RUNS a query for a term, e.g. ?q=FBbt_00003748,NeuronsSynaptic */
export function vfbQueryUrl(id, queryType) {
  if (!id || !queryType) return ''
  return `https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=${encodeURIComponent(id)},${encodeURIComponent(queryType)}`
}

// Markdown link titles are wrapped in double quotes, so a title must not contain
// raw double quotes — that breaks [text](url "ti"tle") parsing. Swap them out.
function titleSafe(s = '') {
  return String(s).replace(/"/g, "'").trim()
}

/** Strip "[label](target)" markdown to "label" so chip text is plain. */
export function stripMarkdown(s = '') {
  return stripMarkdownLinks(s)
}

const VFB_ID_RE = /^(FBbt|VFB|FBgn|FBal|FBti|FBtp|FBco)/

// query_type -> natural follow-on question template ({term} is substituted).
//
// A term's term-info catalogue routinely offers twenty or more query types with
// real, non-zero counts. This table used to hold eleven, and a query type absent
// from it was not "shown differently" — it was DROPPED. So a neuron whose
// catalogue advertised 107 NBLAST matches and 484 connected neurons offered
// neither as a follow-on, and the data VFB was volunteering went unmentioned
// because this file had no sentence for it.
//
// Two things fixed that. First, the table below now covers every type whose
// question I can state exactly. Second — and this is what makes the rest safe —
// a chip carries its ADDRESS (id, query_type) as well as its prose, so clicking
// one runs the query the catalogue named, not a re-reading of the sentence. The
// prose therefore has to be honest and readable; it does not have to be the sole
// carrier of meaning. That lets everything still unlisted fall back to VFB's OWN
// label for the query (see askPrompt), which is grounded by construction, rather
// than to a guess or to silence.
const ASK_TEMPLATES = {
  // region membership
  NeuronsPresynapticHere: 'Which neurons provide input to the {term}?',
  NeuronsPostsynapticHere: 'Which neurons receive output from the {term}?',
  NeuronsPartHere: 'Which neurons have part of their arbour in the {term}?',
  NeuronsSynaptic: 'Which neurons have synaptic terminals in the {term}?',
  NeuronClassesFasciculatingHere: 'Which neuron types fasciculate in the {term}?',
  TractsNervesInnervatingHere: 'Which tracts and nerves innervate the {term}?',
  LineageClonesIn: 'Which lineage clones are found in the {term}?',

  // ontology structure
  SubclassesOf: 'What are the subtypes of the {term}?',
  PartsOf: 'What are the anatomical parts of the {term}?',
  ComponentsOf: 'What are the components of the {term}?',

  // reagents and expression
  ExpressionOverlapsHere: 'Which GAL4 / expression patterns label the {term}?',
  TransgeneExpressionHere: 'Which driver lines label the {term}?',
  SplitsTargeting: 'Which split-GAL4 lines target the {term}?',
  TargetNeurons: 'Which neurons does {term} target?',

  // connectivity
  DownstreamClassConnectivity: 'What does the {term} connect to downstream?',
  UpstreamClassConnectivity: 'What connects to the {term} upstream?',
  NeuronInputsTo: 'What are the strongest inputs to the {term}?',
  NeuronNeuronConnectivityQuery: 'Which individual neurons is {term} connected to?',
  NeuronRegionConnectivityQuery: 'How is {term} connected to each brain region?',

  // morphological similarity. Only the plain NBLAST query is phrased here: the
  // four qualified variants disagree between VFB's catalogue labels and this
  // codebase's own typing about whether they return neurons or expression
  // patterns, and a chip that promises the wrong one is worse than a chip
  // phrased in VFB's words. They take the label fallback.
  SimilarMorphologyTo: 'Which neurons have a similar morphology to {term}?',

  // images
  ListAllAvailableImages: 'Which images of {term} does VFB have?',
  ImagesNeurons: 'Which neuron images have a part in the {term}?',
  ImagesThatDevelopFrom: 'Which neurons develop from the {term}?',
  AllAlignedImages: 'Which images are aligned to {term}?',
  DatasetImages: 'Which images are in {term}?',
  PaintedDomains: 'Which painted domains are available for {term}?',
  epFrag: 'Which expression pattern fragments are available for {term}?',

  // single-cell transcriptomics
  anatScRNAseqQuery: 'What single-cell transcriptomic clusters are there for {term}?',
  clusterExpression: 'Which genes are expressed in {term}?',

  // datasets, stocks, publications
  AlignedDatasets: 'Which datasets are aligned to {term}?',
  AllDatasets: 'Which datasets does VFB hold?',
  FindStocks: 'Which fly stocks are available for {term}?',
  TermsForPub: 'Which VFB terms does {term} report?'
}

// VFB writes each catalogue entry a label of its own — "Neurons with similar
// morphology to DA1_lPN_R [NBLAST]" — which names the term, the relation and
// often the method. Offering that back is not a guess about what the query does;
// it is a quotation of what VFB says it does. The bracketed method qualifier is
// re-bracketed to parentheses only so the chip does not read like a stray
// markdown link.
const MAX_LABEL_CHIPS_PER_TERM = 2

function labelPrompt(q) {
  const label = stripMarkdown(String(q?.label || ''))
    .replace(/\[([^\]]+)\]\s*$/, '($1)')
    .replace(/\s+/g, ' ')
    .trim()
  if (!label || label.length > 120) return ''
  return `Show me: ${label}`
}

/**
 * The prose for a chip offering query `q` on `term`, or '' if it cannot be
 * phrased at all — which now means only that VFB gave the query no label and
 * this file has no template, not merely that the type is unfamiliar.
 */
export function askPrompt(q, term = '') {
  const tpl = ASK_TEMPLATES[q?.query_type]
  if (tpl) return tpl.replace('{term}', term)
  return labelPrompt(q)
}

/**
 * Build follow-on suggestions + sources from the ledger's resolved terms.
 * @returns {{ terms:Array, chips:Array, sources:Array }}
 *   chip = { kind:'ask'|'vfb', label, query?, url?, title }
 *   source = { label, url, id }
 */
export function buildFollowOns(ledger, { maxChips = 6 } = {}) {
  const terms = []
  const chips = []
  const sources = []
  const seenChip = new Set()
  const seenSource = new Set()

  // What this turn already ran, as `id::query_type`. A follow-on is an offer of
  // something NEW, so the query the answer above was built from must not come
  // back as a suggestion — the medulla trace ended with the chip "Which neurons
  // receive output from the medulla?" sitting directly under the answer to that
  // exact question. Keyed by id as well as type because two terms in one answer
  // routinely share a query_type, and a bare type would silently mute the other
  // term's genuinely unasked chip. A step that named a query with no target
  // therefore suppresses nothing, which is the right answer rather than a missing
  // guard: every chip is built from a resolved id, so an id-less key cannot match
  // one, and a query whose target is unknown is no evidence that any particular
  // term's question was answered.
  const ranThisTurn = new Set((ledger?.plan || [])
    .filter(s => s.tool === 'vfb_run_query' && s.args?.query_type)
    .map(s => `${s.args.id}::${String(s.args.query_type).toLowerCase()}`))

  // id -> authoritative VFB label (registry canonical entries; never a model name).
  const idLabel = {}
  for (const e of Object.values(ledger?.registry || {})) {
    if (e.canonical && e.id && !idLabel[e.id]) idLabel[e.id] = e.label
  }

  // Dedup resolved terms by id (the same entity can be reached under two names).
  const resolved = []
  const seenId = new Set()
  for (const [name, t] of Object.entries(ledger?.terms || {})) {
    if (!t || !t.id || seenId.has(t.id)) continue
    seenId.add(t.id)
    resolved.push([name, t])
  }
  for (const [name, t] of resolved) {
    // Authoritative label for the id (term-info Name / registry), NEVER the
    // planner/model term name — that mislabelled a MBON id as "mushroom body".
    const label = stripMarkdown(t.digest?.name || idLabel[t.id] || name)
    // `name` is the planner/search term; `label` is the authoritative display name.
    // superseded: if this term replaced a deprecated one the user asked for, carry
    // the old id/label so the answer can note "X is deprecated — now <label>".
    const superseded = t.superseded && t.superseded.fromId ? t.superseded : null
    terms.push({ name, id: t.id, label, superseded })
    const url = vfbReportUrl(t.id)
    if (url && !seenSource.has(t.id)) { seenSource.add(t.id); sources.push({ label, url, id: t.id, superseded }) }

    // open-in-VFB chip per resolved term
    const vfbKey = `vfb:${t.id}`
    if (url && !seenChip.has(vfbKey)) {
      seenChip.add(vfbKey)
      chips.push({ kind: 'vfb', label: `Open ${label} in VFB`, url, title: `Open ${label} in Virtual Fly Brain (new tab)` })
    }

    // ask chips from the term's real available-data queries (largest first).
    // Keep anything that is not an exact zero: a -1 means the total is not known
    // exactly, never that the data is absent.
    const queries = (t.digest?.queries || []).filter(q =>
      askPrompt(q, label) && !(countKindOf(q) === 'exact' && !(q.count > 0)) &&
      !ranThisTurn.has(`${t.id}::${String(q.query_type).toLowerCase()}`))
    // Largest first — the count is VFB's own statement of how much data is
    // behind the offer, and my phrasing quality is not a reason to overrule it.
    // Ties go to a type this file can phrase exactly.
    queries.sort((a, b) =>
      chipSortValue(b) - chipSortValue(a) ||
      (ASK_TEMPLATES[b.query_type] ? 1 : 0) - (ASK_TEMPLATES[a.query_type] ? 1 : 0))
    // ...but a term whose whole chip list reads "Show me: …" has stopped
    // sounding like a conversation. Two quoted-label chips per term is enough to
    // surface the specialist data without the list losing its voice.
    let fallbacksUsed = 0
    for (const q of queries) {
      const templated = Boolean(ASK_TEMPLATES[q.query_type])
      if (!templated && fallbacksUsed >= MAX_LABEL_CHIPS_PER_TERM) continue
      const query = askPrompt(q, label)
      const key = `ask:${query.toLowerCase()}`
      if (seenChip.has(key)) continue
      seenChip.add(key)
      if (!templated) fallbacksUsed++
      // Carry the ADDRESS, not just the prose. This chip was generated from
      // `t.id` and `q.query_type` — the exact pair that answers it — and used to
      // emit neither, so clicking it posted a sentence and the next turn had to
      // re-derive from natural language the two facts this line already had in
      // hand. When that re-derivation missed, the answer opened "the term was not
      // matched to a specific VFB entity in this session" about a term the
      // session had matched one turn earlier. A chip is a promise that the data
      // exists; it should carry the coordinates of the data it is promising.
      chips.push({
        kind: 'ask',
        label: `${query}${chipCountSuffix(q)}`,
        query,
        title: `Ask VFB: ${query}`,
        id: t.id,
        query_type: q.query_type
      })
    }
  }

  // Documentation pages used as evidence become sources too, so the answer links
  // the page it drew on (e.g. a VFB blog/news/docs page), not only term reports.
  const seenDoc = new Set()
  for (const e of (ledger?.evidence || [])) {
    if (e.source !== 'doc') continue
    const url = e.locator?.url
    if (!url || seenSource.has(url) || seenDoc.has(url)) continue
    seenDoc.add(url)
    sources.push({ label: stripMarkdown(e.locator?.title || docLabelFromUrl(url)), url, id: null })
  }

  // Trim ask chips but always keep at least one open-in-VFB per term where possible.
  const askChips = chips.filter(c => c.kind === 'ask').slice(0, maxChips)
  const vfbChips = chips.filter(c => c.kind === 'vfb').slice(0, 3)
  return { terms, chips: [...askChips, ...vfbChips], sources }
}

/** Readable fallback label for a documentation URL when no page title is known. */
function docLabelFromUrl(url = '') {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname
    return seg.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim() || u.hostname
  } catch { return 'documentation' }
}

/**
 * Build a name -> {id, url} map of every VFB entity we can link in the answer:
 * the resolved terms plus the example neurons surfaced in each term's digest
 * queries (which carry their own ids). Longest names first so "ML-VPN2" wins
 * over "VPN" when linkifying.
 */
export function buildTermLinks(ledger) {
  const byKey = new Map()
  const add = (label, id, canonical) => {
    const name = stripMarkdown(label)
    if (!name || !id || !VFB_ID_RE.test(id)) return
    const key = name.toLowerCase()
    const existing = byKey.get(key)
    if (!existing || (canonical && !existing.canonical)) {
      byKey.set(key, { name, id, url: vfbReportUrl(id), canonical: Boolean(canonical) })
    }
  }
  // 1. authoritative registry (VFB's own labels -> ids)
  for (const e of Object.values(ledger?.registry || {})) add(e.label, e.id, e.canonical)
  // 2. resolved terms by their VFB term-info Name (canonical) + query-row entities.
  //    NEVER the planner/model-supplied term name — that is what pinned a label to
  //    the wrong id (e.g. "mushroom body" -> mushroom body output neuron).
  for (const t of Object.values(ledger?.terms || {})) {
    if (t?.id && t.digest?.name) add(t.digest.name, t.id, true)
    for (const q of (t?.digest?.queries || [])) {
      for (const e of (q.exampleEntities || [])) add(e.label, e.id, false)
    }
  }
  return [...byKey.values()].sort((a, b) => b.name.length - a.name.length)
}

/**
 * Linkify known VFB term names in answer prose to their report pages, with a
 * hover tooltip and nothing else. Only plain text is touched — existing markdown
 * links, code spans and URLs are left alone — and each term is linked once.
 *
 * A name the model wrapped in bare square brackets is linked as the whole
 * bracketed span, brackets included. The synthesiser is told to write names
 * plainly because links are added here, and it half-complies: told not to write a
 * URL, it writes "[PBac{544.SVS-1}Bsg[CPTI100062] expression pattern]" — markdown
 * link syntax with the target left off, which renders as literal brackets. Only a
 * name we recognise is unwrapped this way; a blanket unwrap would eat the real
 * brackets inside a genotype like Fas2[CPTI000483].
 */
export function linkifyKnownTerms(text, termLinks) {
  if (!text || !Array.isArray(termLinks) || !termLinks.length) return text || ''
  const linked = new Set()
  // Split out spans we must not touch, transform only the plain pieces.
  const parts = splitProtectedSpans(text)
  return parts.map((part, i) => {
    // odd indices are the captured (protected) spans
    if (i % 2 === 1) return part
    // The protected spans were worked out once, before any link existed. A link
    // this loop INSERTS is prose to every term after it, and the terms are sorted
    // longest-first, so the next name along is very often a substring of the one
    // just written — into the hover title, where it reads as ordinary text:
    //
    //   [KCab-c(i)](…/FBbt_00049111 "Open [KCab-c](…/FBbt_00110929 "Open KCab-c
    //   in Virtual Fly Brain")(i) in Virtual Fly Brain")
    //
    // — a link nested inside another link's title, which renders as garbage. So
    // an inserted link becomes a segment of its own that nothing further touches,
    // and each remaining term is matched only against what is still prose.
    const segs = [{ text: part, done: false }]
    for (const t of termLinks) {
      if (linked.has(t.name.toLowerCase())) continue
      const esc = escapeRe(t.name)
      // Either the whole "[name]" span or the bare name — but the bare-name arm
      // refuses a preceding "[", so an unmatched bracket is left entirely alone
      // rather than becoming "[[name](url)", which reads as a broken link.
      const re = new RegExp(`(?<![\\w-])(?:\\[${esc}\\]|(?<!\\[)${esc})(?![\\w-])`)
      for (let s = 0; s < segs.length; s++) {
        if (segs[s].done) continue
        const m = re.exec(segs[s].text)
        if (!m) continue
        const before = segs[s].text.slice(0, m.index)
        const after = segs[s].text.slice(m.index + m[0].length)
        const url = `[${t.name}](${t.url} "${titleSafe('Open ' + t.name + ' in Virtual Fly Brain')}")`
        segs.splice(s, 1, { text: before, done: false }, { text: url, done: true }, { text: after, done: false })
        linked.add(t.name.toLowerCase())
        break
      }
    }
    return segs.map(s => s.text).join('')
  }).join('')
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Map each term-info query count -> {label, url, title} so figures quoted in the
 * answer ("226,524 images of neurons with some part in the medulla") can be
 * turned into links that open that query's data in VFB. Larger counts first so a
 * value that is a prefix of another isn't matched early.
 *
 * Only exactly-counted queries take part. A -1 query is never printed as a
 * figure — it appears as "more than 1000" or as an offer to run the query — so
 * there is no number to linkify, and inventing one would misattribute the link.
 * Those queries reach the user through the ask chips instead.
 */
export function buildCountLinks(ledger) {
  const byCount = new Map()
  for (const [, t] of Object.entries(ledger?.terms || {})) {
    if (!t || !t.id || !t.digest?.queries?.length) continue
    for (const q of t.digest.queries) {
      if (!q.count || q.count < 1 || !q.query_type) continue
      if (!byCount.has(q.count)) {
        byCount.set(q.count, {
          count: q.count,
          url: vfbQueryUrl(t.id, q.query_type),   // RUNS the query in VFB
          title: titleSafe(`Run in VFB: ${q.label}`),
          label: q.label,
          // What one unit of this count IS ("neuron types", "images"). Carried so
          // linkifyCounts can ask whether the figure it found in the prose is
          // plausibly a quantity of this — see the small-figure guard there.
          noun: querySemantics(q.query_type).countNoun || ''
        })
      }
    }
  }
  return [...byCount.values()].sort((a, b) => b.count - a.count)
}

/**
 * Linkify count figures in answer prose to the VFB query they came from. Matches
 * number tokens (with or without thousands commas) against known query counts;
 * each count is linked once; existing links/code are left untouched.
 *
 * A number written as a lower bound ("more than 1000 images") is skipped: it is
 * the counting cap, not a query's total, so linking it to whichever query
 * happens to hold exactly that count would point the user at the wrong data.
 *
 * A number must also stand as its OWN token, which \b is far too weak to
 * establish. In "PBac{602.P.SVS-1}Fas2[CPTI000483] expression pattern" there is a
 * boundary on each side of "602" — brace before, dot after — so the answer came
 * back naming that transgene "PBac{[602](…NeuronsPartHere…).P.SVS-1}…", a query
 * link buried inside a genotype. The figure must therefore begin after whitespace
 * or "(", and must not run straight into a word character, a hyphen, a bracket,
 * or a dot/comma followed by non-space. A figure ending a sentence keeps its stop.
 */
export function linkifyCounts(text, countLinks) {
  if (!text || !Array.isArray(countLinks) || !countLinks.length) return text || ''
  const byCount = new Map(countLinks.map(c => [c.count, c]))
  const used = new Set()
  const parts = splitProtectedSpans(text)
  return parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part.replace(/(?<![^\s(])(more than\s+|over\s+|at least\s+)?\b\d[\d,]*\b(?![\w\-[\]{}]|[.,]\S)/gi, (m, bound, offset, whole) => {
      if (bound) return m
      const v = Number(m.replace(/,/g, ''))
      const link = byCount.get(v)
      if (!link || used.has(v)) return m
      if (!figureIsAQuantity(whole, offset, m, link)) return m
      used.add(v)
      return `[${m}](${link.url} "${link.title}")`
    })
  }).join('')
}

// Words that make the number after them a NAME rather than a quantity. "layer 7"
// is the seventh layer, not seven of anything, and no amount of context after it
// changes that — so this guard is absolute and applies at every magnitude.
const DESIGNATOR_BEFORE = /\b(layer|layers|lamina|laminae|stratum|strata|sublayer|level|tier|column|segment|neuromere|type|class|group|cluster|zone|domain|glomerulus|figure|fig|table|panel|plate|step|stage|instar|part|section|chapter|page|row|item|question|version|number|no|num|id|chr|chromosome)\.?\s*$/i

// Below this, a figure needs corroboration; at or above it, the coincidence of a
// query holding exactly that count is no longer plausible. Nothing magic about
// the value — it is chosen so that every count in a term's chip list that a
// reader would recognise as a real total ("471 neuron types") clears it, while
// the small integers that anatomy prose is full of (layer numbers, ordinals,
// counts of lobes and layers) do not.
const SMALL_FIGURE = 100

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'to', 'for', 'and', 'or', 'with', 'that', 'this',
  'there', 'are', 'is', 'has', 'have', 'from', 'some', 'here', 'its', 'their', 'which', 'vfb', 'holds'])

function contentWords(s = '') {
  return String(s).toLowerCase().match(/[a-z][a-z-]{2,}/g) || []
}
// Crude singular so "neurons" in prose matches "neuron" in a query label. Crude is
// correct here: this only ever widens what counts as corroboration, and the
// designator guard above is what does the actual refusing.
function stem(w) { return w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w }

/**
 * Is this figure plausibly a QUANTITY OF THE THING this query counts?
 *
 * The bug that motivates the question: an answer describing the medulla's ten
 * layers wrote "layer 7", and a query whose count happened to be 7 claimed it —
 * so the reader was offered a link labelled "Run in VFB: Lineage clones in the
 * medulla" sitting on an anatomical layer number. Nothing about that link is
 * recoverable by the reader: it looks authoritative, it goes somewhere real, and
 * it is about something else entirely.
 *
 * The asymmetry that decides the rule: a MISSING count link costs a convenience —
 * the same query is one click away on a chip, and the Sources list carries it too.
 * A WRONG count link costs trust, and it costs it silently. So the guard is
 * deliberately biased towards refusing.
 *
 * Two tests. Any figure directly after a designator word is refused outright. A
 * figure below SMALL_FIGURE must additionally be followed by a word the query
 * itself uses — its label or its count noun — which is what separates "28 neuron
 * types have some part in the medulla" from a bare "7".
 */
function figureIsAQuantity(whole, offset, matched, link) {
  const before = String(whole).slice(Math.max(0, offset - 40), offset)
  if (DESIGNATOR_BEFORE.test(before)) return false
  if (link.count >= SMALL_FIGURE) return true
  const after = String(whole).slice(offset + matched.length, offset + matched.length + 60)
  const vocabulary = new Set([...contentWords(link.label), ...contentWords(link.noun)]
    .filter(w => !STOPWORDS.has(w)).map(stem))
  if (!vocabulary.size) return false
  return contentWords(after).map(stem).some(w => vocabulary.has(w))
}
