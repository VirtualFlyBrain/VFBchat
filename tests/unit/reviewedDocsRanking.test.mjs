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
import { rankEntries, tokenizeQuery } from '../../lib/reviewedDocsSearch.js'
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
