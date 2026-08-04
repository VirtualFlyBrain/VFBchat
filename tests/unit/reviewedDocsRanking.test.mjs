// Offline unit tests for reviewed-docs ranking and candidate selection.
// Run: node --test tests/unit/reviewedDocsRanking.test.mjs
//
// Every page in the reviewed index lives on virtualflybrain.org, so the words
// "virtual", "fly" and "brain" are worth nothing as discriminators — and yet a
// flat per-token score let a question that merely NAMES the site outrank every
// page that was actually ABOUT the thing asked. Two battery questions failed
// this way ("What was included in the latest Virtual Fly Brain release?" and
// "How do I use the Virtual Fly Brain MCP tool?"): both had a page on the site
// that answers them, and neither ever reached it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankEntries, tokenizeQuery, isIndexableReviewedUrl } from '../../lib/reviewedDocsSearch.js'
import { pickDocCandidates } from '../../lib/orchestrator.mjs'

// A miniature stand-in for the real index: one page per topic, all on the same
// domain, plus the generic homepage that used to win every VFB-shaped query.
const ENTRIES = [
  { id: 'home', title: 'Virtual Fly Brain', url: 'https://virtualflybrain.org/', domain: 'virtualflybrain.org', pathname: '/', summary: 'Virtual Fly Brain is a tool for neurobiologists.', keywords: [] },
  { id: 'news', title: 'Virtual Fly Brain News', url: 'https://www.virtualflybrain.org/blog/news', domain: 'www.virtualflybrain.org', pathname: '/blog/news', summary: 'News from Virtual Fly Brain.', keywords: [] },
  { id: 'releases', title: 'Release Information', url: 'https://www.virtualflybrain.org/blog/releases', domain: 'www.virtualflybrain.org', pathname: '/blog/releases', summary: 'What changed in each Virtual Fly Brain release.', keywords: [] },
  { id: 'mcp', title: 'VFB Model Context Protocol (MCP) Tool Guide', url: 'https://www.virtualflybrain.org/docs/tutorials/vfb-mcp-guide', domain: 'www.virtualflybrain.org', pathname: '/docs/tutorials/vfb-mcp-guide', summary: 'How to connect an LLM client to the VFB MCP server.', keywords: [] },
  { id: 'cite', title: 'How to cite us', url: 'https://www.virtualflybrain.org/about/citeus', domain: 'www.virtualflybrain.org', pathname: '/about/citeus', summary: 'Citing Virtual Fly Brain in a publication.', keywords: [] },
  // The /reports vs /about/contactus pair from battery question D5: the same
  // word "report" in two senses, and only one of the two pages has anything to
  // say about the rest of the question.
  { id: 'reports', title: 'Virtual Fly Brain reports', url: 'https://virtualflybrain.org/reports', domain: 'virtualflybrain.org', pathname: '/reports', summary: 'Entry point for Virtual Fly Brain report pages covering terms, anatomy classes and neurons.', keywords: ['reports'] },
  { id: 'contact', title: 'Contact and support', url: 'https://www.virtualflybrain.org/about/contactus', domain: 'www.virtualflybrain.org', pathname: '/about/contactus', summary: 'How to report a problem to Virtual Fly Brain, and how to contribute new data.', keywords: [] }
]

const rank = q => rankEntries(ENTRIES, tokenizeQuery(q)).map(e => e.id)

test('naming the site does not outrank the page that answers the question', () => {
  // Verbatim battery question D12. Before inverse-document-frequency weighting,
  // "virtual" + "fly" + "brain" matched the homepage's title three times over
  // and it took first place; the release page was fifth and never read.
  assert.equal(rank('What was included in the latest Virtual Fly Brain release?')[0], 'releases')
})

test('the MCP guide is reachable for a question that names the site', () => {
  // Verbatim battery question D16.
  const top3 = rank('How do I use the Virtual Fly Brain Model Context Protocol (MCP) tool?').slice(0, 3)
  assert.ok(top3.includes('mcp'), top3.join(','))
})

test('a question made ENTIRELY of product words still ranks something', () => {
  // The weight floor exists for this: every token is near-useless, but "what is
  // Virtual Fly Brain" should still return the homepage rather than nothing.
  const r = rank('What is Virtual Fly Brain?')
  assert.ok(r.length > 0)
  assert.equal(r[0], 'home')
})

test('the one distinctive word in the question decides the ranking', () => {
  // "cite" appears on exactly one page; the other four words appear on all of
  // them. The rare word has to carry the query on its own.
  assert.equal(rank('How should I cite Virtual Fly Brain?')[0], 'cite')
})

test('an inflected form of the question word still matches', () => {
  // "contribute" is not a substring of "contributions", so before stemming the
  // single most discriminating word in battery question D5 scored zero on the
  // page that answers it.
  assert.equal(rank('How do I contribute data?')[0], 'contact')
  assert.equal(rank('Where are the release notes?')[0], 'releases')
})

test('a short word is not stemmed down to a fragment that matches everything', () => {
  // The four-character floor: "used" must not become "us".
  assert.equal(rank('Which tool is used by neurobiologists?')[0], 'home')
})

test('answering more of the question beats matching one word louder', () => {
  // /reports carries "report" in its title AND its path, which outscores
  // everything /about/contactus has to say about "report", "contribute" and
  // "data" together — and /reports answers none of the rest of the question.
  const r = rank('How do I report a problem or contribute data to Virtual Fly Brain?')
  assert.equal(r[0], 'contact', r.join(','))
  assert.ok(r.indexOf('contact') < r.indexOf('reports'), r.join(','))
})

// The EM page as the index now holds it, versus the same page as the index used
// to hold it. A sitemap gives a URL and nothing else, so every discovered entry
// was titled by Title-Casing its last path segment and summarised as "Approved
// page on ... at ...". Ranking ran on THOSE; the real page was fetched
// afterwards, for the three entries that had already won. So enrichment only
// ever changed what was displayed, never what was found.
const EM_URL = 'https://www.virtualflybrain.org/docs/data/em/'
const EM_PLACEHOLDER = {
  id: 'em',
  title: 'Em',
  url: EM_URL,
  domain: 'www.virtualflybrain.org',
  pathname: '/docs/data/em/',
  summary: 'Approved page on www.virtualflybrain.org at /docs/data/em/.',
  keywords: ['docs', 'data', 'em'],
  headings: [],
  text: ''
}
// Titles, headings and body text as they come off the live page. FAFB, FANC and
// CATMAID appear nowhere in the title or the meta description — they are cells
// in the "Comparison Table of Integrated Datasets" and items in the "Datasets
// Hosted by VFB" list, which is why capturing <title> and meta description at
// discovery time was not enough on its own.
const EM_ENRICHED = {
  ...EM_PLACEHOLDER,
  title: 'Electron Microscopy Data',
  summary: 'Connectomics datasets integrated into Virtual Fly Brain.',
  headings: ['Datasets Hosted by VFB', 'Comparison Table of Integrated Datasets', 'Accessing the data'],
  text: [
    'FAFB (FlyWire) | fw | Full brain (adult female) | Dense | Codex | Dorkenwald et al. (2024)',
    'FANC | N/A | Full VNS (adult female) | Sparse | CATMAID | Phelps et al. (2021)',
    'Hemibrain | hb | Central brain (adult female) | Dense | neuPrint | Scheffer et al. (2020)',
    'The FAFB and FANC datasets are served from CATMAID instances hosted by VFB.'
  ].join(' \n ')
}

// The three plausible distractors that beat the EM page before this change:
// a page whose path stems to "acces" (so it matched "access"), a blog post
// naming both "datasets" and the site, and the site root.
const ACCESSIBILITY = { id: 'accessibility', title: 'Accessibility', url: 'https://www.virtualflybrain.org/about/accessibility', domain: 'www.virtualflybrain.org', pathname: '/about/accessibility', summary: 'Approved page on www.virtualflybrain.org at /about/accessibility.', keywords: ['about', 'accessibility'], headings: [], text: '' }
const BLOG = { id: 'blog', title: 'Ontologies And Datasets', url: 'https://www.virtualflybrain.org/blog/ontologies/datasets', domain: 'www.virtualflybrain.org', pathname: '/blog/ontologies/datasets', summary: 'Approved page on www.virtualflybrain.org at /blog/ontologies/datasets.', keywords: ['blog', 'ontologies', 'datasets'], headings: [], text: '' }

const D20 = 'Where can I access the FAFB or FANC CATMAID datasets via Virtual Fly Brain?'
const rankIds = (entries, q) => rankEntries(entries, tokenizeQuery(q)).map(e => e.id)

test('D20: a URL-shaped placeholder cannot be found by the words that answer it', () => {
  // The failing state, pinned so the fix cannot silently regress into it. The
  // page that answers the question is in the index and is not returned at all,
  // because nothing in its indexed fields says FAFB, FANC or CATMAID.
  const ranked = rankIds([EM_PLACEHOLDER, ACCESSIBILITY, BLOG, ...ENTRIES], D20)
  assert.notEqual(ranked[0], 'em', ranked.join(','))
})

test('D20: the enriched page wins on the words that only its body carries', () => {
  const ranked = rankIds([EM_ENRICHED, ACCESSIBILITY, BLOG, ...ENTRIES], D20)
  assert.equal(ranked[0], 'em', ranked.join(','))
})

test('body text is the weakest field, not a louder one', () => {
  // Body text scores 1 against a title's 6 on purpose: a page that merely
  // MENTIONS a word must not outrank a page that is ABOUT it. It earns its keep
  // through coverage instead — matching a further word anywhere lifts the whole
  // score, because coverage multiplies.
  const mentions = { id: 'mentions', title: 'Release Notes', url: 'https://www.virtualflybrain.org/blog/notes', domain: 'www.virtualflybrain.org', pathname: '/blog/notes', summary: 'Recent changes.', keywords: [], headings: [], text: 'We added a link to the new MCP guide this month.' }
  const about = ENTRIES.find(e => e.id === 'mcp')
  const ranked = rankIds([mentions, about], 'MCP')
  assert.equal(ranked[0], 'mcp', ranked.join(','))
})

test('the asset-path blocker does not exclude the documentation tree', () => {
  // One unanchored regex, /\/data\//, was the largest single cause of D20: it
  // was meant to keep a top-level asset directory out of the index and instead
  // excluded all seven pages under /docs/data/ — including the one page that
  // says where the FAFB and FANC CATMAID instances live. An over-broad blocker
  // is invisible from the outside; it just quietly makes a page unanswerable.
  const allow = ['www.virtualflybrain.org', 'vfb-connect.readthedocs.io']
  assert.equal(isIndexableReviewedUrl(EM_URL, allow), true)
  assert.equal(isIndexableReviewedUrl('https://www.virtualflybrain.org/docs/data/templates/', allow), true)
  assert.equal(isIndexableReviewedUrl('https://www.virtualflybrain.org/data/logo-set/', allow), false)
})

test('readthedocs version archives stay out, stable and latest stay in', () => {
  // Ninety-one of 187 discovered URLs were /en/vX.Y.Z/ archives: near-duplicate
  // stale copies that pushed the document frequency of every vfb-connect term
  // above ninety, driving its weight to the floor and so actively SUPPRESSING
  // vfb-connect pages for vfb-connect questions.
  const allow = ['vfb-connect.readthedocs.io']
  assert.equal(isIndexableReviewedUrl('https://vfb-connect.readthedocs.io/en/stable/', allow), true)
  assert.equal(isIndexableReviewedUrl('https://vfb-connect.readthedocs.io/en/latest/tutorials.html', allow), true)
  assert.equal(isIndexableReviewedUrl('https://vfb-connect.readthedocs.io/en/v2.1.3/', allow), false)
})

test('an off-allow-list host is never indexable, whatever its path', () => {
  assert.equal(isIndexableReviewedUrl('https://github.com/VirtualFlyBrain/VFB2', ['www.virtualflybrain.org']), false)
  assert.equal(isIndexableReviewedUrl('not a url', ['www.virtualflybrain.org']), false)
})

test('pickDocCandidates: ranked, de-duplicated, capped, url-or-link', () => {
  const search = {
    results: [
      { title: 'A', url: 'https://x/a' },
      { title: 'dup', url: 'https://x/a' },
      { title: 'no url' },
      { title: 'B', link: 'https://x/b' },
      { title: 'C', url: 'https://x/c' },
      { title: 'D', url: 'https://x/d' }
    ]
  }
  assert.deepEqual(pickDocCandidates(search, 3).map(c => c.url), ['https://x/a', 'https://x/b', 'https://x/c'])
  assert.equal(pickDocCandidates(search, 1)[0].title, 'A')
})

test('pickDocCandidates: nothing to pick from is an empty list, not a throw', () => {
  assert.deepEqual(pickDocCandidates(null), [])
  assert.deepEqual(pickDocCandidates({}), [])
  assert.deepEqual(pickDocCandidates({ results: 'nope' }), [])
})
