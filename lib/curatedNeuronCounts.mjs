// Curated published neuron counts, read in process.
//
// This replaces two PMIDs hard-coded behind a test for the literal string
// "central brain", with the headline figures written into a prompt hint. That
// arrangement was wrong three ways: one of the PMIDs was a computational MODEL
// paper whose "central brain … more than 125,000 neurons" sentence is background
// citing someone else's whole-brain count; the other figure, 139,255, was in no
// fetched source at all; and a regex over an abstract cannot carry the things
// that make a neuron count mean anything — which specimen, which sex, which
// stage, which release, and what that paper's methods counted as a neuron.
//
// WHY THE DATA SHIPS IN THE IMAGE rather than being fetched from the website
// copy at config.canonical_url. Three reasons, and they are the same reasons
// lib/serviceIdentity.mjs builds from in-process functions instead of calling
// /api/version over HTTP:
//
//   1. A fetch turns a fact into a maybe. The reviewed-docs path is a live call
//      with a timeout, and what comes back is text a model may or may not read
//      correctly. A figure that must always be right cannot depend on that.
//   2. The renderer needs the data in process. renderNeuronCountEstimate builds
//      its block from a tool result, deterministically, so the number reaches the
//      reader whether or not the model chose to mention it.
//   3. Provenance. 09-change-control-and-provenance.md ties an answer to a
//      release via the image digest. A remote file can change without a VFBchat
//      release, which would break exactly that property.
//
// The website copy is the mirror, for humans and for the MCP. If the two drift,
// that is a release-process bug and belongs in CI, not at runtime.

import { readFileSync } from 'node:fs'
import path from 'node:path'

let cache = null

/** Load and memoise the curated data. Returns null if it is unreadable. */
export function curatedData(overridePath = null) {
  if (cache !== null && !overridePath) return cache
  try {
    const file = overridePath || path.join(process.cwd(), 'config', 'fly-neuron-counts.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!overridePath) cache = parsed
    return parsed
  } catch {
    // A missing or malformed data file must not take the chat route down. The
    // caller renders nothing, which is the same behaviour as having no figure —
    // and is why this returns null rather than throwing.
    if (!overridePath) cache = null
    return null
  }
}

/** Reset the memo. Tests only. */
export function resetCuratedCache() { cache = null }

const norm = (s = '') => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * The region_map key that best matches a resolved region label.
 *
 * Longest key first, so "adult central brain" wins over "central brain" and
 * "brain". Exact match beats containment; a bare "brain" never captures
 * "mushroom body" because the map is consulted by key, not by token.
 */
export function matchRegionKey(label = '', data = curatedData()) {
  const map = data?.region_map
  if (!map) return null
  const want = norm(label)
  if (!want) return null
  const keys = Object.keys(map).sort((a, b) => b.length - a.length)
  for (const k of keys) if (norm(k) === want) return k
  for (const k of keys) {
    const nk = norm(k)
    // Whole-word containment only: "brain" must not match "forebrain".
    if (new RegExp(`(^|\\s)${nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`).test(want)) return k
  }
  return null
}

/**
 * Published counts for a region, in the shape renderNeuronCountEstimate expects:
 * { count_numeric, scope, source_pmid, source_title }.
 *
 * `scope` carries the specimen and the caveat, not just the anatomy, because the
 * anatomy alone is what made the old hint wrong. A reader seeing "139,255" needs
 * "whole adult brain, one female, FlyWire v783" attached to it or the number is
 * no better than the one it replaced.
 */
export function curatedCountsForRegion(label = '', data = curatedData()) {
  const key = matchRegionKey(label, data)
  if (!key) return []
  const entry = data.region_map[key]
  const byKey = new Map((data.connectomes || []).map(c => [c.key, c]))
  const out = []
  for (const ck of entry.connectomes || []) {
    const c = byKey.get(ck)
    if (!c) continue
    const useSub = entry.subcount && c.subcounts && Number.isFinite(c.subcounts[entry.subcount])
    const n = useSub ? c.subcounts[entry.subcount] : c.neurons
    if (!Number.isFinite(n)) continue
    const spec = c.specimen || {}
    const bits = [spec.sex, spec.stage].filter(Boolean).join(' ')
    const scope = [
      useSub ? `${c.scope} Subcount: ${entry.subcount.replace(/_/g, ' ')}.` : c.scope,
      bits ? `One ${bits}.` : '',
      c.version ? `Dataset: ${c.vfb_label || c.key}, ${c.version}.` : '',
      c.peer_reviewed === false ? 'Preprint — no peer-reviewed version of record.' : ''
    ].filter(Boolean).join(' ')
    out.push({
      count_numeric: n,
      exact: c.exact !== false,
      scope,
      source_pmid: c.pmid || null,
      source_doi: c.doi || null,
      source_title: c.citation || null
    })
  }
  return out
}

/** The note attached to a region, if the curators wrote one. */
export function curatedNoteForRegion(label = '', data = curatedData()) {
  const key = matchRegionKey(label, data)
  return (key && data.region_map[key].note) || null
}

/** The answer rules, for the tool's evidence payload. */
export function curatedAnswerRules(data = curatedData()) {
  return Array.isArray(data?.answer_rules) ? data.answer_rules : []
}
