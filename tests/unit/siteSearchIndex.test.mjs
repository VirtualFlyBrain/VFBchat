// The site's own search index (/index.json) as a documentation source.
// Run: node --test tests/unit/siteSearchIndex.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSiteIndex, rankEntries, tokenizeQuery } from '../../lib/reviewedDocsSearch.js'

const ALLOW = ['virtualflybrain.org', 'www.virtualflybrain.org']
const BASE = 'https://www.virtualflybrain.org/index.json'
// Three records as the live file has them (2026-09-02), abridged.
const RECORDS = [
  { body: '', desc: 'Here you will find explanations and tutorial for the concepts and tools that are utilised by Virtual Fly Brain (VFB).', pinned: true, section: 'docs', title: 'Documentation', url: '/docs/' },
  { body: 'The VFB MCP server exposes search_terms, get_term_info, run_query and get_hierarchy to any MCP client. Configure Claude Desktop with the URL below.', desc: 'Connect an LLM client to Virtual Fly Brain over the Model Context Protocol.', pinned: false, section: 'docs', title: 'MCP', url: '/docs/apis/mcp/' },
  { body: 'Bridging registrations between JRC2018U and FAFB14 let you compare neurons across datasets.', desc: 'Electron microscopy datasets hosted by VFB.', pinned: false, section: 'docs', title: 'EM data', url: '/docs/data/em/' },
  { body: 'x', desc: 'off-site', section: 'docs', title: 'Elsewhere', url: 'https://example.org/page' },
  { title: 'no url' }
]

test('records become index entries with real titles, the site body as text, and section as a keyword', () => {
  const entries = parseSiteIndex(RECORDS, BASE, ALLOW)
  assert.deepEqual(entries.map(e => e.url), ['https://www.virtualflybrain.org/docs', 'https://www.virtualflybrain.org/docs/apis/mcp', 'https://www.virtualflybrain.org/docs/data/em'])
  const mcp = entries[1]
  assert.equal(mcp.title, 'MCP')
  assert.equal(mcp.summary, 'Connect an LLM client to Virtual Fly Brain over the Model Context Protocol.')
  assert.match(mcp.text, /get_hierarchy/)
  assert.ok(mcp.keywords.includes('docs'))
  assert.equal(mcp.section, 'docs')
  assert.equal(entries[0].pinned, true)
  assert.ok(entries[0].keywords.includes('pinned'))
  assert.deepEqual(parseSiteIndex(null, BASE, ALLOW), [])
})

test('a question about the MCP finds the MCP page on the site body alone, before any page has been crawled', () => {
  const entries = parseSiteIndex(RECORDS, BASE, ALLOW)
  const ranked = rankEntries(entries, tokenizeQuery('How do I configure Claude Desktop to use the VFB MCP server?'))
  assert.equal(ranked[0].url, 'https://www.virtualflybrain.org/docs/apis/mcp')
  const em = rankEntries(entries, tokenizeQuery('bridging registrations between JRC2018U and FAFB14'))
  assert.equal(em[0].url, 'https://www.virtualflybrain.org/docs/data/em')
})
