// Morphological-similarity recipe (pure, offline-testable).
//
// "What neurons are similar to LPLC2?" is a question VFB can answer very well and
// the harness could not answer at all. The reason is a mismatch between how the
// question is asked and where the data lives:
//
//   NBLAST similarity in VFB is INDIVIDUAL-ONLY. SimilarMorphologyTo run against
//   the class FBbt_00111763 returns count 0, rows 0. Run against one registered
//   LPLC2 neuron (VFB_jrchk06p) it returns 131 scored neighbours.
//
// People ask about the CLASS. So the class's term-info digest carries no
// similarity query, pickQueriesByIntent found no candidate for the similarity
// rule, fell through to the broad class_list rule, found no unambiguous winner
// there either, and injected nothing — leaving the synthesiser with the digest's
// query catalogue, which it read back as "you can explore several avenues of
// data available in VFB". A catalogue read-back, for a question with a real,
// scored, citable answer sitting one hop away.
//
// The hop is: class --ListAllAvailableImages--> registered individuals
//             individual --SimilarMorphologyTo--> scored neighbours
//             neighbour.type --> the neighbour's own CLASS
//
// Grouping the neighbours by that type column is what turns a per-neuron result
// back into the class-level answer that was asked for. For LPLC2 over the top
// 100 hits that is: LPLC2 itself 69 (best 0.80), LC4 30 (best 0.46), LPLC1 and
// an adult dopaminergic neuron 1 each.
//
// Two things this module is careful about, because both are ways to be wrong:
//
//   - The self-class is reported SEPARATELY, never dropped and never mixed in.
//     A neuron's nearest morphological neighbours being mostly other neurons of
//     the same class is the single most informative fact in the result, and
//     silently filtering it out would make LC4 look like the top match.
//   - The answer is attributed to the individuals it was actually computed from.
//     VFB has no class-level NBLAST; claiming "LPLC2 is similar to LC4" without
//     saying it came from n seed neurons overstates what was measured.

import { splitMarkdownCell, parseMarkdownLinks } from './markdownLinks.mjs'

function rowsOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  return Array.isArray(payload.rows) ? payload.rows : []
}

/**
 * Registered individuals of a class, from a ListAllAvailableImages payload,
 * spread ACROSS datasets rather than taken from the top of the list.
 *
 * This is the difference between the tool working and the tool reporting "no
 * data". NBLAST registration is per-DATASET, not per-neuron: of LPLC2's five
 * source datasets, Hemibrain, FlyWire and Optic Lobe carry NBLAST scores while
 * MaleCNS/Berg2025 and BANC/Bates2025 carry none. ListAllAvailableImages returns
 * its rows GROUPED by dataset, and Berg2025 sorts first — so "the first three
 * individuals" is three neurons from the one dataset with no similarity data at
 * all, and the honest-looking answer is "VFB returned no NBLAST neighbours",
 * which is false about the class.
 *
 * Round-robining by dataset makes the candidate pool as informative per probe as
 * it can be, and leaves the caller to discard whichever come back empty.
 *
 * `parent` names the class the individual is typed as. When a classId is given,
 * only individuals actually typed as that class are returned — the query is
 * already scoped to it, but a row typed as something else is a poor seed for a
 * "similar to <class>" answer and the check is free.
 */
export function pickSeedIndividuals(payload, { classId = '', cap = 3 } = {}) {
  const want = String(classId || '').trim()
  const byDataset = new Map()
  const seen = new Set()
  for (const row of rowsOf(payload)) {
    const id = String(row?.id || '').trim()
    if (!/^VFB_/.test(id) || seen.has(id)) continue
    if (want) {
      const parents = parseMarkdownLinks(row?.parent || '').map(p => p.target)
      if (parents.length && !parents.includes(want)) continue
    }
    seen.add(id)
    const ds = splitMarkdownCell(row?.dataset || '')
    const key = ds.target || ds.text || ''
    if (!byDataset.has(key)) byDataset.set(key, [])
    byDataset.get(key).push({
      id,
      label: splitMarkdownCell(row?.label || row?.name || '').text || id,
      dataset: ds.text || ''
    })
  }
  const lanes = [...byDataset.values()]
  const out = []
  for (let i = 0; out.length < cap; i++) {
    let took = false
    for (const lane of lanes) {
      if (i >= lane.length) continue
      out.push(lane[i])
      took = true
      if (out.length >= cap) break
    }
    if (!took) break
  }
  return out
}

/**
 * Scored neighbours from a SimilarMorphologyTo payload.
 *
 * `score` arrives as a STRING ("0.8"); a non-numeric one is dropped rather than
 * coerced to 0, which would sort it alongside a genuinely dissimilar neuron.
 * `type` may name several classes for one neuron (a cell type and its lineage),
 * so every link in the cell is kept.
 */
export function parseSimilarityHits(payload, { seed = null } = {}) {
  const out = []
  for (const row of rowsOf(payload)) {
    const id = String(row?.id || '').trim()
    if (!id) continue
    // Number('') and Number(null) are BOTH 0, not NaN, so Number.isFinite alone
    // lets an unscored row through as a perfect-zero score — which then sorts
    // and groups as though VFB had measured it and found no resemblance.
    const raw = row?.score
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    const score = Number(raw)
    if (!Number.isFinite(score)) continue
    out.push({
      id,
      name: splitMarkdownCell(row?.name || row?.label || '').text || id,
      score,
      classes: parseMarkdownLinks(row?.type || '').filter(c => /^FBbt_/.test(c.target)),
      seedId: seed?.id || ''
    })
  }
  return out
}

/**
 * Collapse per-neuron hits into per-CLASS groups, sorted by best score.
 *
 * Hits are de-duplicated by neuron id first: seeding from several individuals of
 * the same class returns overlapping neighbourhoods, and counting one neuron
 * twice would inflate whichever class happens to sit between two seeds.
 *
 * The seeds themselves are excluded — a neuron is trivially its own best match,
 * and VFB does return the seed in its own result set.
 */
export function groupSimilarByClass(hits, { focusId = '', seedIds = [] } = {}) {
  const skip = new Set(seedIds.filter(Boolean))
  const byNeuron = new Map()
  for (const h of hits) {
    if (skip.has(h.id)) continue
    const prev = byNeuron.get(h.id)
    if (!prev || h.score > prev.score) byNeuron.set(h.id, h)
  }
  const groups = new Map()
  for (const h of byNeuron.values()) {
    for (const c of h.classes) {
      const g = groups.get(c.target) || { id: c.target, label: c.text, neurons: 0, bestScore: 0, example: null }
      g.neurons++
      if (h.score > g.bestScore) { g.bestScore = h.score; g.example = { id: h.id, name: h.name, score: h.score } }
      groups.set(c.target, g)
    }
  }
  const all = [...groups.values()].sort((a, b) => b.bestScore - a.bestScore || b.neurons - a.neurons)
  const focus = String(focusId || '')
  return {
    self: all.find(g => g.id === focus) || null,
    others: all.filter(g => g.id !== focus),
    neurons: byNeuron.size
  }
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * The deterministic claim for a similarity result, or null when there is nothing
 * to claim.
 *
 * Written as ONE claim rather than a table because the honest version of this
 * answer is a single sentence with a caveat attached, and splitting the caveat
 * off from the finding is how it gets dropped: "similar to LC4" without "NBLAST,
 * computed from N registered neurons, not from the class" is a stronger
 * statement than the data supports.
 *
 * No total is stated for the same reason the macro-tool claim states none — the
 * hit list is a page, and every count handed to the synthesiser has come back
 * out of it as a total. Per-class figures ARE stated, because they are counts of
 * what is in front of it, and each is qualified by "among the N nearest".
 */
export function summariseSimilarity(payload, { cap = 8 } = {}) {
  if (!payload || typeof payload !== 'object') return null
  const focus = payload.resolved || payload.focus_term || null
  const groups = payload.similar_classes
  if (!Array.isArray(groups)) return null
  const seeds = Array.isArray(payload.seed_neurons) ? payload.seed_neurons : []
  const self = payload.self_class || null
  const scored = Number(payload.neurons_compared) || 0
  const name = focus?.label || focus?.id || 'this neuron'

  if (!groups.length && !self) return null

  // The method statement LEADS. It was written as a trailing clause first, and
  // the synthesiser compressed it straight out — the same failure as the GAL4
  // answer, where a hedge at the end of a long claim simply did not survive. A
  // qualifier in the opening clause is one the summary has to carry, because
  // every sentence that follows is grammatically subordinate to it.
  // Seed NAMES only, no VFB_ ids. The synthesiser is instructed never to write an
  // ontology id (a weak model writes them into prose and mislinks), so ids handed
  // to it in a claim get stripped — and stripping "LPLC2_R (VFB_jrchk06p)" left
  // "3 registered neurons LPLC2", with the class link attached to what should
  // have named the individuals. The ids stay in the evidence verbatim.
  // The caveat only applies to a CLASS. Asked about an individual neuron, the
  // per-neuron computation is exactly what was asked for, and "measured from the
  // registered neuron LPLC2_R rather than from LPLC2_R as a whole" is gibberish —
  // it also misled the synthesiser into reporting the 100 neighbours as "100
  // registered neurons" the result came from.
  const seedNames = seeds.map(s => s.label).filter(Boolean)
  const isClass = /^FBbt_/i.test(String(focus?.id || ''))
  let via
  if (!isClass) {
    via = `These are NBLAST scores against the registered neuron ${name}`
  } else if (seedNames.length) {
    via = `NBLAST similarity in VFB is computed per registered neuron, not per class, so this is measured from ${seedNames.length === 1 ? 'the registered neuron' : `${seedNames.length} registered neurons`} (${seedNames.join(', ')}) rather than from ${name} as a whole`
  } else {
    via = `NBLAST similarity in VFB is computed per registered neuron, not per class, so this is measured from individual registered neurons rather than from ${name} as a whole`
  }

  const parts = [via]
  if (self) {
    parts.push(`Of the ${scored} nearest morphological neighbours, ${self.neurons} are themselves ${name} (best NBLAST score ${round2(self.bestScore)})`)
  }
  if (groups.length) {
    const listed = groups.slice(0, cap)
      .map(g => `${g.label}${g.id ? ` (${g.id})` : ''} — ${g.neurons} of the ${scored}, best score ${round2(g.bestScore)}`)
      .join('; ')
    parts.push(`${self ? 'The other' : 'The'} cell types among them are: ${listed}`)
  } else {
    parts.push(`No other cell type appears among them`)
  }

  return {
    claim: `${parts.join('. ')}.`,
    rows: groups.slice(0, cap).map(g => ({ name: g.label, id: g.id })),
    self,
    groups: groups.slice(0, cap)
  }
}
