// Documentation pages and publications must be referenceable.
//
// The synthesiser is forbidden to write URLs, and the automatic linking that
// rule promises only ever covered VFB term reports. So an answer whose framing
// came from a reviewed VFB article, or whose figure came from a paper, cited
// nothing — the reference sat in the evidence payload and could not reach the
// reader by any route. These tests pin the route that now carries it.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReferenceSources,
  referenceSourcesFromCountEstimate,
  publicationSourcesFromEvidence,
  sourceKey,
  sourceTitle
} from '../../lib/referenceSources.mjs'
import { buildEvidenceRow } from '../../lib/externalEvidence.mjs'
import { buildFollowOns } from '../../lib/followOns.mjs'
import { renderNeuronCountEstimate } from '../../lib/neuronCount.mjs'
import { curatedArticle } from '../../lib/curatedNeuronCounts.mjs'
import { sanitizeAssistantOutput, isAllowedStructuredUrl } from '../../lib/policy.js'
import { getOutboundAllowList } from '../../lib/runtimeConfig.js'
import { readFileSync } from 'node:fs'

const ARTICLE = 'https://www.virtualflybrain.org/docs/concepts/neuron-counts/'

/** A region-neuron-count payload shaped like the real tool result. */
function countEstimate(overrides = {}) {
  return {
    tool: 'vfb_get_region_neuron_count',
    query: { resolved_region: 'adult central brain' },
    count_candidates: [{
      count_numeric: 32388,
      scope: 'Whole adult brain. Subcount: fully in central brain.',
      source_pmid: '39358518',
      source_doi: '10.1038/s41586-024-07558-y',
      source_title: 'Dorkenwald S et al. (2024) Nature 634(8032):124-138'
    }],
    vfb_query_summaries: [{ query_type: 'NeuronsPartHere', count: 9413 }],
    evidence_summary: {
      reference: ARTICLE,
      reference_title: 'How many neurons are in the fly brain?',
      curated_note: 'FlyWire reports 32,388 neurons FULLY CONTAINED in the central brain out of 139,255 in the whole brain.'
    },
    ...overrides
  }
}

test('a count estimate yields the reviewed article as a doc source and its paper as a publication', () => {
  const sources = referenceSourcesFromCountEstimate(countEstimate())
  assert.deepEqual(sources.map(s => s.kind), ['doc', 'publication'])
  assert.equal(sources[0].url, ARTICLE)
  assert.equal(sources[0].label, 'How many neurons are in the fly brain?')
  // DOI is preferred over PubMed when both are present.
  assert.equal(sources[1].url, 'https://doi.org/10.1038/s41586-024-07558-y')
})

test('a count estimate with no curated entry contributes no sources', () => {
  const sources = referenceSourcesFromCountEstimate({
    tool: 'vfb_get_region_neuron_count', count_candidates: [], evidence_summary: {}
  })
  assert.deepEqual(sources, [])
})

test('literature evidence rows become publication sources, read off the FLAT row shape', () => {
  // buildEvidenceRow spreads the locator, so the row has no `.locator`. Building
  // the fixture through it is the point of this test: the doc-source path was
  // written against a nested locator that the builder has never produced, and a
  // hand-made fixture agreed with the code instead of with production.
  const ledger = {
    evidence: [
      buildEvidenceRow({
        source: 'literature',
        claim: 'the mushroom body is required for olfactory memory',
        locator: { pmid: '12345678', doi: '', citation: 'Heisenberg M (2003) Nat Rev Neurosci' }
      }),
      buildEvidenceRow({ source: 'vfb', claim: 'not a publication', locator: { term: 'brain' } })
    ]
  }
  const pubs = publicationSourcesFromEvidence(ledger)
  assert.equal(pubs.length, 1)
  assert.equal(pubs[0].url, 'https://pubmed.ncbi.nlm.nih.gov/12345678/')
  assert.equal(pubs[0].label, 'Heisenberg M (2003) Nat Rev Neurosci')
})

test('a publication with no resolvable identifier is dropped rather than listed unlinked', () => {
  const ledger = {
    evidence: [buildEvidenceRow({ source: 'literature', claim: 'x', locator: { citation: 'Someone et al.' } })]
  }
  assert.deepEqual(publicationSourcesFromEvidence(ledger), [])
})

test('sources are deduped across trailing slash, www and scheme', () => {
  assert.equal(sourceKey('https://www.virtualflybrain.org/docs/concepts/neuron-counts/'),
    sourceKey('http://virtualflybrain.org/docs/concepts/neuron-counts'))
  const sources = buildReferenceSources({}, [countEstimate(), countEstimate({
    evidence_summary: { reference: 'http://virtualflybrain.org/docs/concepts/neuron-counts', reference_title: 'dup' }
  })])
  assert.equal(sources.filter(s => s.kind === 'doc').length, 1)
})

test('documentation is listed before publications, and each carries its own hover text', () => {
  const ledger = {
    evidence: [buildEvidenceRow({ source: 'literature', claim: 'x', locator: { pmid: '111', citation: 'A et al.' } })]
  }
  const sources = buildReferenceSources(ledger, [countEstimate()])
  assert.deepEqual(sources.map(s => s.kind), ['doc', 'publication', 'publication'])
  assert.match(sources[0].title, /Virtual Fly Brain documentation \(new tab\)$/)
  assert.match(sources.at(-1).title, /on PubMed \(new tab\)$/)
})

test('a source already listed by the caller is not repeated', () => {
  const seen = new Set([sourceKey(ARTICLE)])
  const sources = buildReferenceSources({}, [countEstimate()], { seen })
  assert.equal(sources.some(s => s.kind === 'doc'), false)
})

test('sourceTitle words each kind differently', () => {
  assert.match(sourceTitle({ kind: 'vfb', label: 'brain' }), /term info in Virtual Fly Brain/)
  assert.match(sourceTitle({ kind: 'doc', label: 'X' }), /Virtual Fly Brain documentation/)
  assert.match(sourceTitle({ kind: 'publication', label: 'Y', url: 'https://doi.org/10.1/2' }), /via DOI/)
})

// ---- end to end through buildFollowOns ----

test('buildFollowOns puts term reports first, then documentation, then publications', () => {
  const ledger = {
    terms: { brain: { id: 'FBbt_00005095', digest: { name: 'brain' } } },
    registry: {},
    plan: [],
    evidence: [
      buildEvidenceRow({
        source: 'doc',
        claim: 'a page answered this',
        locator: { url: 'https://www.virtualflybrain.org/blog/2025/12/17/neurofly-2026', title: 'NeuroFly 2026' }
      })
    ]
  }
  const { sources } = buildFollowOns(ledger, { countEstimates: [countEstimate()] })
  assert.deepEqual(sources.map(s => s.kind), ['vfb', 'doc', 'doc', 'publication'])
  assert.equal(sources[0].id, 'FBbt_00005095')
  assert.equal(sources[1].label, 'NeuroFly 2026')
  assert.equal(sources[2].url, ARTICLE)
  // Every source is hoverable, including the term reports.
  assert.ok(sources.every(s => typeof s.title === 'string' && s.title.length > 0))
})

// ---- the prose block ----

test('the count block links each figure to its paper and closes with the reviewed article', () => {
  const md = renderNeuronCountEstimate(countEstimate(), 'adult central brain')
  assert.match(md, /\[Dorkenwald S et al\. \(2024\)[^\]]*\]\(https:\/\/doi\.org\/10\.1038\/s41586-024-07558-y "[^"]+"\)/)
  assert.match(md, /Reference: \[How many neurons are in the fly brain\?\]\(https:\/\/www\.virtualflybrain\.org\/docs\/concepts\/neuron-counts\/ "[^"]+"\)/)
})

test('the curated note is printed, not left to the model', () => {
  const md = renderNeuronCountEstimate(countEstimate(), 'adult central brain')
  assert.match(md, /_FlyWire reports 32,388 neurons FULLY CONTAINED in the central brain[^_]*_/)
})

test('a payload with no reference prints no Reference line', () => {
  const md = renderNeuronCountEstimate(countEstimate({ evidence_summary: {} }), 'adult central brain')
  assert.ok(md.length > 0)
  assert.equal(/Reference:/.test(md), false)
})

test('an unlinkable citation still renders as text rather than an empty link', () => {
  const md = renderNeuronCountEstimate(countEstimate({
    count_candidates: [{ count_numeric: 100, scope: 's', source_title: 'Nobody et al.' }]
  }), 'region')
  assert.match(md, /Nobody et al\./)
  assert.equal(/\]\(\s*"/.test(md), false)
})

test('every link the block writes survives the outbound allow-list', () => {
  // A citation the sanitiser rewrites to "[External link removed]" is worse than
  // no citation: the reader is promised a reference and handed a hole. The block
  // only ever emits doi.org, pubmed and virtualflybrain.org, and this asserts
  // that against the real default allow-list rather than against a guess.
  const md = renderNeuronCountEstimate(countEstimate(), 'adult central brain')
  const { sanitizedText, blockedDomains } = sanitizeAssistantOutput(md, getOutboundAllowList())
  assert.deepEqual(blockedDomains, [])
  assert.equal(sanitizedText, md)
  for (const s of buildReferenceSources({}, [countEstimate()])) {
    assert.ok(isAllowedStructuredUrl(s.url, getOutboundAllowList()), `blocked source url: ${s.url}`)
  }
})

// ---- the config is the single source of truth for the article ----

test('curatedArticle reads the shipped config, and the page is a virtualflybrain.org URL', () => {
  const a = curatedArticle()
  assert.ok(a && a.url.startsWith('https://'))
  assert.match(new URL(a.url).hostname, /virtualflybrain\.org$/)
  assert.ok(a.title.length > 0)
})

// ---- the NCBI contact address is a role address ----

test('the NCBI contact address defaults to a role address, never a person', () => {
  // It rides on every E-utilities request as `tool=vfbchat&email=…`, so whatever
  // is set here is disclosed to a US federal agency on every literature lookup
  // for as long as the service runs. Nothing else in the literature path carries
  // personal data — the tools send a DOI, a PMID or a search string — so a named
  // member of staff in this field would be the only such point, and one added by
  // configuration rather than by anyone's choice. Read from source: the constant
  // lives in the chat route, which cannot be imported without standing up the
  // whole handler.
  const src = readFileSync(new URL('../../app/api/chat/route.js', import.meta.url), 'utf8')
  const m = src.match(/const NCBI_CONTACT_EMAIL = '([^']+)'/)
  assert.ok(m, 'NCBI_CONTACT_EMAIL is not declared as a literal any more — re-point this test')
  const [local, domain] = m[1].split('@')
  assert.equal(domain, 'virtualflybrain.org')
  // Only the addresses this application actually publishes to its own users, in
  // the privacy notice, the terms and the accessibility statement. `vfb@` is
  // deliberately NOT here: it was the previous default and appeared exactly once
  // in the whole repository — on that line — with no sign it was ever a routed
  // alias. An address NCBI cannot reach is worse than none, because their
  // practice is to warn by email before they throttle.
  assert.ok(['data', 'support'].includes(local),
    `NCBI contact "${m[1]}" is not an address VFB publishes as a contact`)
})
