// The dataset axis (pure, offline-testable).
//
// Four workshop questions failed the same way in 3.9.1 and 3.9.2, and it is the
// last of the four confused axes:
//
//   W9.1 "How many DA1 lPN neurons does VFB hold in EACH CONNECTOME DATASET?"
//        -> "the specific counts ... are not provided"
//   W1.C "Where do I find DA1 lPN neurons, and WHICH CONNECTOMES have them?"
//        -> named MaleCNS and stopped
//   W5.B "...the top hits, their scores, and WHICH DATASETS THEY COME FROM"
//        -> scores, no datasets
//   W2.B "Find the morphologically closest neuron IN THE HEMIBRAIN"
//        -> handed back the FlyWire query neuron itself
//
// In every case the harness ran the right query, read the rows honestly, and
// answered as though the dataset clause were not in the question. Same shape as
// the ontology/space, direction and identity axes fixed in 3.9.2: the answer is
// about the right entity, on the wrong axis.
//
// WHERE THE DATA ACTUALLY IS. Established against live v3-cached, because the
// obvious sources are all dead ends:
//
//   - term-info for a class offers ListAllAvailableImages with count -1 and NO
//     preview rows, so the catalogue cannot be counted from; the query has to be
//     run.
//   - term-info's Examples map is keyed by TEMPLATE (VFB_00101567, VFB_00101384)
//     and capped, so it cannot be grouped by dataset either.
//   - run_query?query_type=ListAllAvailableImages returns rows keyed
//     [id,label,tags,parent,source,source_id,template,DATASET,license,thumbnail].
//     The `dataset` column is the whole axis, and parseTableRow was discarding it.
//   - SimilarMorphologyTo rows carry NO dataset column at all. Their dataset
//     signal is the `source` column ("[FlyWire web interface v783](flywire783)",
//     "[Neuprint web interface - hemibrain:v1.2.1](neuprint_JRC_Hemibrain_1point2point1)").
//     So the two halves of the axis read different columns, and a module that
//     only knew about `dataset` would still answer W5.B and W2.B with nothing.
//
// THE THING THAT MAKES A NAIVE ANSWER WRONG. A `dataset` cell is not one link.
// It is a LIST of links, because an individual can be annotated in several
// datasets at once. For DA1 lPN, 15 of the 68 individuals carry between two and
// four FAFB tracing datasets each:
//
//   "[EM FAFB Taisz and Galili et al., 2022](TaiszGalili2022), [EM FAFB Baltruschat
//    et al 2021](Baltruschat2021), [EM FAFB Zheng et al 2018](Zheng2018), [EM FAFB
//    Bates and Schlegel et al 2020](BatesSchlegel2020)"
//
// splitMarkdownCell is deliberately anchored, so it hands such a cell back as
// plain text with target "" — correct for what it promises, wrong for this
// column, and the reason a first pass over this data looked like malformed
// markdown. parseMarkdownLinks is the right tool. (This matters beyond the
// counts: pickSeedIndividuals keyed its round-robin lanes on splitMarkdownCell's
// output, so the FAFB neurons fragmented into seven lanes — one per distinct
// combination of dataset annotations — and biased seed selection towards FAFB.)
//
// The consequence for the answer is arithmetic the reader will otherwise catch
// us on: the per-dataset counts SUM TO MORE THAN THE TOTAL. 18 + 15 + 15 + 13 +
// 7 + 7 + 1 = 91 for 68 distinct neurons. Reporting the eight figures and a
// total of 68 without saying why is a self-contradiction of exactly the W7.C4
// kind. So the breakdown states the overlap in the same claim, and derives which
// datasets overlap FROM THE DATA — datasets that share individuals are collapsed
// into connected components — rather than from a hard-coded list of what we
// happen to know is FAFB.

import { parseMarkdownLinks, splitMarkdownCell } from './markdownLinks.mjs'

function rowsOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  return Array.isArray(payload.rows) ? payload.rows : []
}

/**
 * Every dataset named in one table cell, in order.
 *
 * A cell is usually one markdown link and sometimes a comma-separated list of
 * them. A cell with no link at all is kept as a single unlinked entry rather
 * than dropped, so a dataset VFB names but does not link still gets counted.
 *
 * @returns {{label:string,id:string}[]}
 */
export function parseDatasetCell(cell = '') {
  const raw = String(cell || '').trim()
  if (!raw) return []
  const links = parseMarkdownLinks(raw)
  if (links.length) return links.map(l => ({ label: l.text, id: l.target }))
  const flat = splitMarkdownCell(raw)
  return flat.text ? [{ label: flat.text, id: '' }] : []
}

/** The searchable text for a dataset — its label and its id together, because
 * the common name lives in one or the other depending on the dataset. "BANC" is
 * only in Bates2025's label; "Hemibrain" is in both Xu2020NeuronsV1point2point1's
 * label and neuprint_JRC_Hemibrain_1point2point1's id. */
const dsText = (d) => `${d?.label || ''} ${d?.id || ''}`

/**
 * Which datasets a row belongs to, reading whichever column carries them.
 *
 * `dataset` where the payload has one (ListAllAvailableImages and friends);
 * `source` where it does not (SimilarMorphologyTo). Both are consulted rather
 * than one being preferred outright, because they are not redundant: two DA1 lPN
 * rows share dataset Dorkenwald2023 while one has source flywire783 and the
 * other neuronbridge, and a question naming either word should match.
 */
export function rowDatasets(row) {
  const primary = parseDatasetCell(row?.dataset || '')
  if (primary.length) return primary
  return parseDatasetCell(row?.source || '')
}

/**
 * Group a rows payload by dataset.
 *
 * Individuals are de-duplicated by id first — a row list may repeat one neuron
 * once per template it is registered against, and counting registrations as
 * neurons is how "how many neurons" turns into a number nobody can reproduce.
 *
 * `clusters` are the connected components of the "shares an individual with"
 * relation over datasets. A component of size 1 is an ordinary dataset; a
 * component larger than 1 is a set of datasets annotating the same neurons, and
 * is what the overlap sentence is built from.
 */
export function groupRowsByDataset(payload) {
  const seen = new Map() // id -> dataset ids
  const meta = new Map() // dataset id -> {id,label,count}
  const order = []
  const individuals = []
  for (const row of rowsOf(payload)) {
    const id = String(row?.id || '').trim()
    if (!id || seen.has(id)) continue
    const datasets = rowDatasets(row)
    individuals.push({
      id,
      label: splitMarkdownCell(row?.label || row?.name || '').text || id,
      datasets: datasets.map(d => d.label || d.id).filter(Boolean)
    })
    const keys = []
    for (const d of datasets) {
      const key = d.id || d.label
      if (!key || keys.includes(key)) continue
      keys.push(key)
      if (!meta.has(key)) { meta.set(key, { id: d.id, label: d.label || d.id, count: 0 }); order.push(key) }
      meta.get(key).count++
    }
    seen.set(id, keys)
  }

  // Union-find over datasets that co-occur on an individual.
  const parent = new Map(order.map(k => [k, k]))
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k) } return k }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  let multiDataset = 0
  for (const keys of seen.values()) {
    if (keys.length > 1) multiDataset++
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i])
  }
  const byRoot = new Map()
  for (const k of order) {
    const r = find(k)
    if (!byRoot.has(r)) byRoot.set(r, { datasets: [], individuals: 0, spread: { min: Infinity, max: 0 } })
    byRoot.get(r).datasets.push(meta.get(k))
  }
  for (const keys of seen.values()) {
    const roots = new Set(keys.map(find))
    for (const r of roots) {
      const c = byRoot.get(r)
      if (!c) continue
      c.individuals++
      // How many of the component's datasets THIS individual carries. Reported
      // as a range, because "15 neurons across 4 datasets" is true of both "each
      // in all four" and "each in two of the four", and only the second is the
      // case for FAFB. Saying "all of" when it is "two to four of" is the kind
      // of small overstatement a reader can falsify in one click.
      const n = keys.filter(k => find(k) === r).length
      if (n < c.spread.min) c.spread.min = n
      if (n > c.spread.max) c.spread.max = n
    }
  }

  const datasets = order.map(k => meta.get(k)).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const clusters = [...byRoot.values()]
    .map(c => ({ ...c, spread: { min: c.spread.min === Infinity ? 0 : c.spread.min, max: c.spread.max }, datasets: c.datasets.slice().sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.individuals - a.individuals)
  return {
    total: seen.size,
    datasets,
    clusters,
    individuals,
    multiDataset,
    sum: datasets.reduce((n, d) => n + d.count, 0),
    unassigned: [...seen.values()].filter(k => !k.length).length
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * The deterministic per-dataset claim, or null when there is nothing to say.
 *
 * One claim, not a table plus a caveat, for the reason summariseSimilarity gives
 * at length: a qualifier that is not grammatically part of the finding does not
 * survive synthesis. The overlap sentence in particular MUST travel with the
 * numbers, because without it the numbers contradict the total out loud.
 */
export function summariseDatasetBreakdown(payload, { label = 'this cell type', cap = 10 } = {}) {
  const g = groupRowsByDataset(payload)
  if (!g.total || !g.datasets.length) return null

  const listed = g.datasets.slice(0, cap)
  const parts = [
    `VFB holds ${plural(g.total, 'registered individual', 'registered individuals')} of ${label}`,
    `By dataset: ${listed.map(d => `${d.label} — ${d.count}`).join('; ')}${g.datasets.length > cap ? `; and ${g.datasets.length - cap} further dataset(s)` : ''}`
  ]

  if (g.multiDataset > 0) {
    const how = g.clusters.filter(c => c.datasets.length > 1).map(c => {
      const range = c.spread.min === c.spread.max ? `all ${c.spread.max}` : `${c.spread.min} to ${c.spread.max}`
      return `${c.individuals} of them are the same neurons traced into ${c.datasets.length} overlapping datasets (${c.datasets.map(d => d.label).join(', ')}), each annotated in ${range} of them`
    }).join('; ')
    parts.push(
      `These figures deliberately do not sum to ${g.total} (they total ${g.sum}), because ${how || `${plural(g.multiDataset, 'individual is', 'individuals are')} annotated in more than one dataset`} — so a neuron is counted once per dataset it belongs to, and the ${g.total} is the count of distinct neurons`
    )
  }

  return {
    claim: `${parts.join('. ')}.`,
    total: g.total,
    datasets: g.datasets,
    clusters: g.clusters,
    // W1.B asks to LIST the individuals with their dataset and VFB id, not to
    // count them. The list travels with the counts rather than in a second
    // claim, because the two are one query's worth of evidence and splitting
    // them is how the listing got dropped in favour of a code snippet.
    individuals: g.individuals,
    rows: listed.map(d => ({ name: d.label, id: '' }))
  }
}

// ---------------------------------------------------------------------------
// The question side.
// ---------------------------------------------------------------------------

// Matching is against label AND id together (see dsText), so these patterns are
// written in the words people use, not in VFB's short_forms. Ordered
// longest-cue-first only where two could both fire on one phrase.
const DATASET_CUES = [
  { key: 'hemibrain', label: 'the hemibrain', re: /\bhemi\s?brain\b|\bflyem[-\s_]*hb\b|\bjrc[-_\s]*flyem\b/i },
  { key: 'flywire', label: 'FlyWire', re: /\bfly\s?wire\b|\bcodex\b/i },
  { key: 'fafb', label: 'FAFB', re: /\bfafb\b|\bfull\s+adult\s+fly\s+brain\b|\bcatmaid\b/i },
  { key: 'banc', label: 'BANC', re: /\bbanc\b|\bbrain\s+and\s+nerve\s+cord\b/i },
  { key: 'malecns', label: 'the male CNS connectome', re: /\bmale[\s_-]*cns\b|\bmalecns\b/i },
  { key: 'manc', label: 'MANC', re: /\bmanc\b|\bmale\s+adult\s+nerve\s+cord\b/i },
  { key: 'opticlobe', label: 'the optic lobe connectome', re: /\boptic\s+lobe\s+(?:connectome|dataset|em)\b/i },
  { key: 'flycircuit', label: 'FlyCircuit', re: /\bfly\s?circuit\b/i },
  { key: 'neuronbridge', label: 'NeuronBridge', re: /\bneuron\s?bridge\b/i },
  { key: 'larval', label: 'the larval connectome', re: /\bl1em\b|\blarval\s+connectome\b/i }
]

/**
 * The dataset a question names, or null.
 *
 * Only a NAMED dataset counts. "which connectomes have them" names none — that
 * is a breakdown question, handled by isDatasetBreakdownQuestion — and treating
 * it as a filter would silently drop every dataset from the answer.
 */
// A question routinely names TWO datasets, one of which is not the filter:
//
//   "Here's a FlyWire neuron VFB_fw035286. Find the morphologically closest
//    neuron IN THE HEMIBRAIN and tell me if they're annotated as the same type."
//
// Taking the first mention answers with FlyWire's own neighbourhood, which is
// how 3.9.2 came to hand back the query neuron as its own hemibrain match. The
// distinguishing signal is grammatical: the dataset being asked FOR sits behind
// a locative preposition, the one describing the input does not. "of" is
// excluded deliberately — "of FlyWire neuron VFB_fw035286" would otherwise
// re-select the input in W2.C.
const LOCATIVE = /\b(?:in|from|within|against|inside|across)\s+(?:the\s+)?$/i

export function datasetAsked(question = '') {
  const q = String(question || '')
  if (!q.trim()) return null
  let best = null
  for (const cue of DATASET_CUES) {
    const m = q.match(cue.re)
    if (!m) continue
    const locative = LOCATIVE.test(q.slice(Math.max(0, m.index - 16), m.index))
    const cand = { key: cue.key, label: cue.label, re: cue.re, index: m.index, locative }
    if (!best || (cand.locative && !best.locative) || (cand.locative === best.locative && cand.index < best.index)) best = cand
  }
  return best
}

// VFB's short_forms and several of its labels join words with underscores
// ("JRC_FlyEM_Hemibrain_1point2point1", "male_cns_v0_9"), and `_` is a WORD
// character — so `\bhemibrain\b` does not match inside "JRC_FlyEM_Hemibrain" and
// `\bjrc[-_\s]*flyem\b` does not match either, because the `\b` after "FlyEM"
// falls between two word characters. Every cue would then have to be written
// twice, once for prose and once for short_forms, and the ones that were not
// would fail silently on exactly the datasets people name most. Normalising the
// haystack instead keeps the cues readable and fixes all of them at once.
const separated = (s) => String(s || '').replace(/_/g, ' ')

/** Does this dataset/source descriptor match the asked-for dataset? */
export function matchesDataset(descriptor, filter) {
  if (!filter?.re) return true
  return filter.re.test(separated(descriptor))
}

/** Does this ROW belong to the asked-for dataset? Checks the dataset column, the
 * source column, and the label — FAFB/FlyWire/FlyEM individuals carry their
 * source accession inside the label ("DA1_lPN_R (FlyEM-HB:754534424)"), which is
 * the most reliable tag of the three when a row is registered through
 * neuronbridge rather than through its own connectome's interface. */
export function rowMatchesDataset(row, filter) {
  if (!filter?.re) return true
  const hay = [
    ...rowDatasets(row).map(dsText),
    String(row?.source || ''),
    String(row?.label || row?.name || '')
  ].join(' ')
  return filter.re.test(separated(hay))
}

// "in each dataset", "which connectomes", "across all datasets", "by dataset" —
// the question wants the axis broken out rather than filtered.
const BREAKDOWN_RE = /\b(?:each|every|per|by|across(?:\s+all)?|which|what|all)\b[^.?!]{0,40}\b(?:data\s?sets?|connectomes?|em\s+volumes?)\b|\b(?:data\s?sets?|connectomes?)\b[^.?!]{0,30}\b(?:each|breakdown|broken\s+down)\b/i

/** Is this question asking for the dataset axis to be broken out? */
export function isDatasetBreakdownQuestion(question = '') {
  return BREAKDOWN_RE.test(String(question || ''))
}

// "connectome" is two different words. In "what is DA1 lPN's connectome?" it
// means the wiring diagram; in "in each connectome dataset" and "which
// connectomes have them" it names a DATA SOURCE and says nothing about synapses
// at all. Every connectivity cue in the orchestrator matched `connectom\w*`
// unconditionally, so both of the workshop's dataset-provenance questions were
// routed to a connectivity tool — W9.1 ran DownstreamPartners and lost the
// catalogue that could have answered it, W1.C the same. That is the same
// four-axes confusion as the rest of 3.9.3, one layer earlier: the router picked
// the tool for a different question before any evidence was read.
//
// Only DATASET-POSITION occurrences are blanked, and deliberately conservatively
// — a false positive here silences a real connectivity question, which is a far
// worse failure than a missed one. An enumerator in front ("each/which/per/across
// ... connectomes"), or a data noun behind ("connectome dataset/volume/release"),
// is the whole of it. Bare "the connectome", "connectomic", and "connectomics"
// are left alone.
const CONNECTOME_AS_DATASET_RE = new RegExp(
  [
    // A data noun behind: "connectome dataset", "connectome volumes",
    // "connectome release v783".
    /connectomes?\s+(?:data\s?sets?|volumes?|releases?|versions?|sources?)/.source,
    // An ENUMERATOR in front — a word that can only be counting discrete things,
    // so it reads as provenance with the singular too: "each connectome",
    // "which connectomes", "how many connectomes".
    /(?:each|every|per|which|what|all|both|any|these|those|several|multiple|different|other|how\s+many)\s+(?:of\s+)?(?:the\s+)?connectomes?/.source,
    // A POSITIONAL preposition in front, plural ONLY. "across the connectome" is
    // the wiring diagram — one graph, traversed — and blanking it silenced a
    // real connectivity question in test. "across all of the connectomes" is
    // several data sources, and the plural is the whole of the difference.
    /(?:across|among|amongst|between|throughout)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?connectomes\b/.source
  ].join('|'),
  'gi'
)

/**
 * The question with its dataset-sense "connectome" mentions removed, for use by
 * connectivity intent tests. Returns the string unchanged when there are none,
 * so the overwhelmingly common case costs one regex test.
 */
export function withoutDatasetSenseConnectome(question = '') {
  const q = String(question || '')
  if (!/connectome/i.test(q)) return q
  return q.replace(CONNECTOME_AS_DATASET_RE, ' ')
}

/**
 * The mirror of the above: does this question use "connectome" to name a DATA
 * SOURCE? The two are deliberately one implementation, so the connectivity side
 * and the dataset side can never drift into disagreeing about the same sentence
 * — which is precisely how the four axes got confused in the first place.
 */
export function connectomeMeansDataset(question = '') {
  const q = String(question || '')
  return /connectome/i.test(q) && withoutDatasetSenseConnectome(q) !== q
}

// ---------------------------------------------------------------------------
// Similarity hits, which read `source` rather than `dataset`.
// ---------------------------------------------------------------------------

/**
 * Similarity hits grouped by the dataset they come from, best score first.
 *
 * This is the whole of W5.B's missing half: "the top hits, their scores, and
 * which datasets they come from". The grouping is by the source LINK TARGET
 * where there is one, so "FlyWire web interface v783" does not split from itself
 * across a version bump within one result set.
 */
export function groupHitsByDataset(hits = []) {
  const groups = new Map()
  for (const h of hits) {
    const key = h?.sourceId || h?.source || 'unknown'
    const g = groups.get(key) || { id: h?.sourceId || '', label: h?.source || 'unrecorded source', count: 0, bestScore: -Infinity, best: null }
    g.count++
    if (Number(h?.score) > g.bestScore) { g.bestScore = Number(h.score); g.best = h }
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(g => ({ ...g, bestScore: g.bestScore === -Infinity ? 0 : g.bestScore }))
    .sort((a, b) => b.bestScore - a.bestScore || b.count - a.count)
}

/**
 * The best hit from the named dataset, and whether it shares a type with the
 * seed — W2.B and W2.C in one shape.
 *
 * `sharedClasses` is the intersection of the hit's type column with the seed's,
 * by FBbt id rather than by label, so "adult antennal lobe projection neuron DA1
 * lPN" and a synonym of it do not read as different types. Returning the
 * intersection rather than a boolean lets the claim NAME the shared type, which
 * is what "tell me if they're annotated as the same type" is actually asking.
 */
export function bestHitInDataset(hits = [], filter, { seedClasses = [] } = {}) {
  if (!filter) return null
  const inSet = hits
    .filter(h => matchesDataset(`${h?.source || ''} ${h?.sourceId || ''} ${h?.name || ''}`, filter))
    .sort((a, b) => Number(b.score) - Number(a.score))
  if (!inSet.length) return null
  const hit = inSet[0]
  const seedIds = new Set(seedClasses.map(c => c?.target || c?.id).filter(Boolean))
  const sharedClasses = (hit.classes || []).filter(c => seedIds.has(c.target))
  return { hit, rank: 1, considered: inSet.length, sharedClasses, seedKnown: seedIds.size > 0 }
}
