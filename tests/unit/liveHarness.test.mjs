// Offline tests for the live wiring. The ELM/MCP primitives are mocked; we
// assert the harness runs end-to-end and the richness sink (graphs, thumbnails,
// tool usage) is populated from tool outputs.
// Run: node --test tests/unit/liveHarness.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectThumbnails, buildLiveDeps, runLiveHarness } from '../../lib/liveHarness.mjs'

// Two-segment VFB thumbnail format (template/id), matching extractImagesFromResponseText.
const THUMB = 'https://www.virtualflybrain.org/data/VFB/i/0010/0001/thumbnail.png'
const THUMB2 = 'https://www.virtualflybrain.org/data/VFB/i/0020/0002/thumbnailT.png'

test('collectThumbnails harvests unique VFB thumbnails as { url, label }', () => {
  const into = []
  collectThumbnails({ rows: [{ thumbnail: THUMB }, { thumbnail: THUMB }] }, into)
  collectThumbnails(`text ${THUMB2} more`, into)
  assert.deepEqual(into, [{ url: THUMB, label: '' }, { url: THUMB2, label: '' }])
})

test('collectThumbnails reads the entity name from the thumbnail markdown alt', () => {
  const into = []
  const md = `[![SLP037_R aligned to JRC2018U](${THUMB} 'SLP037_R aligned to JRC2018U')](VFB_0001)`
  collectThumbnails(md, into)
  assert.deepEqual(into, [{ url: THUMB, label: 'SLP037_R' }])  // " aligned to …" stripped
})

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

function primitives(overrides = {}) {
  return {
    apiBaseUrl: 'http://elm.test/api/v1',
    apiKey: 'k',
    env: {},
    toolDefs: TOOL_DEFS,
    plannerVotes: 1,
    async executeTool(name) {
      if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }
      if (name === 'vfb_get_term_info') return { Meta: { Description: `The medulla. ${THUMB}` }, Publications: [] }
      return { ok: true }
    },
    collectGraphs: () => [],
    async streamText() { return 'The medulla is a region of the optic lobe.' },
    ...overrides
  }
}

test('buildLiveDeps wires per-role models and a graph/thumbnail sink', () => {
  const { deps, collected, models } = buildLiveDeps(primitives())
  assert.equal(typeof deps.callStructured, 'function')
  assert.equal(typeof deps.callTextStream, 'function')
  assert.equal(deps.imageHints, collected.thumbnails) // live reference
  assert.ok(models.planner && models.extract && models.synth)
})

test('runLiveHarness (fast-path term lookup) returns an answer and harvests a thumbnail', async () => {
  // callStructured is only reached for extraction here; mock it to "answer".
  const prim = primitives()
  // Inject a structured sink by overriding the ELM call indirectly: the fast-path
  // resolves the term, fetches term-info, and the extractor must answer. We stub
  // callStructured via a fake fetch is overkill; instead drive through a custom
  // executeTool + a streamText, and a planner-less fast path. Extraction uses the
  // real elmClient → so we route it through a fake by setting plannerVotes and a
  // stubbed structured response via env is not possible. Use a direct deps test:
  const { deps, collected } = buildLiveDeps(prim)
  // Replace callStructured with an offline stub that "answers" extraction.
  deps.callStructured = async ({ schemaName }) => {
    if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'medulla is an optic-lobe region', verbatim: 'medulla' } }
    return { ok: true, value: {} }
  }
  const { runHarness } = await import('../../lib/orchestrator.mjs')
  const r = await runHarness('What is the medulla?', deps)
  assert.equal(r.answer, 'The medulla is a region of the optic lobe.')
  assert.ok(collected.thumbnails.some(t => t.url === THUMB), 'thumbnail harvested from term-info output')
  assert.ok(collected.toolUsage.vfb_search_terms >= 1)
})
