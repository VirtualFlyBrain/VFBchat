// The super-linear memory, in the four places it was actually coming from.
//
// Peak RSS went 88 MB to 6.8 GB between one and four concurrent questions. It
// was described as "not a leak", which is true and was where the diagnosis
// stopped. The mechanism is amplification: one MCP result string was
// materialised five times with every copy alive at once, and there was no size
// cap on a result anywhere — `mcpCallOptions` sets only timeouts, and
// ListAllAvailableImages on the medulla returns 226k rows.

import test from 'node:test'
import assert from 'node:assert/strict'
import { collectThumbnails, MAX_COLLECTED_THUMBNAILS, MAX_TOOL_RESULT_CHARS } from '../../lib/liveHarness.mjs'
import { backfillDigestPreview, MAX_EXTRACT_CHUNKS } from '../../lib/orchestrator.mjs'
import { createLedger, addTerm } from '../../lib/ledger.mjs'

const thumb = (n) => `![Neuron ${n}](https://www.virtualflybrain.org/data/VFB/i/0010/${String(n).padStart(4, '0')}/VFB_00101567/thumbnail.png)`

test('thumbnails are capped — eight reach the user, not 226k', () => {
  const payload = Array.from({ length: 5000 }, (_, i) => thumb(i)).join('\n')
  const into = []
  collectThumbnails(payload, into, new Set())
  assert.ok(into.length <= MAX_COLLECTED_THUMBNAILS, `collected ${into.length}`)
  assert.ok(into.length > 0, 'and it still collects some')
})

test('the dedupe set is carried, not rebuilt from the whole array each call', () => {
  // Rebuilding it was O(rounds x thumbnails): every one of ~24 tool rounds
  // re-walked and re-hashed everything collected so far.
  const seen = new Set()
  const into = []
  collectThumbnails(thumb(1), into, seen)
  collectThumbnails(thumb(1), into, seen)
  collectThumbnails(thumb(2), into, seen)
  assert.equal(into.length, 2, 'the same URL twice is one thumbnail')
  assert.equal(seen.size, 2)
})

test('there is a ceiling on what gets turned into an object graph', () => {
  assert.ok(Number.isFinite(MAX_TOOL_RESULT_CHARS))
  assert.ok(MAX_TOOL_RESULT_CHARS >= 100000, 'not so small it breaks real queries')
  assert.ok(MAX_TOOL_RESULT_CHARS <= 64 * 1024 * 1024, 'and not effectively unbounded')
})

test('the extract map-reduce is bounded', () => {
  // ceil(5 MB / 48000) is 105 sequential ELM calls, each with a three-minute
  // budget, for one plan step.
  assert.ok(MAX_EXTRACT_CHUNKS >= 1 && MAX_EXTRACT_CHUNKS <= 50)
})

test('backfillDigestPreview does not parse every row to keep five', () => {
  const ledger = createLedger('q')
  addTerm(ledger, 'medulla', {
    id: 'FBbt_00003748',
    label: 'medulla',
    digest: { id: 'FBbt_00003748', name: 'medulla', queries: [{ query_type: 'NeuronsPartHere', label: 'x', count: -1 }] },
    attempted: true
  })
  let parsedCalls = 0
  const rows = Array.from({ length: 50000 }, (_, i) => {
    // A getter counts how many rows are actually read.
    return { get name () { parsedCalls++; return `| [Neuron ${i}](FBbt_0000${i}) |` }, toString () { parsedCalls++; return `| [Neuron ${i}](FBbt_0000${i}) |` } }
  })
  backfillDigestPreview(ledger, { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' }, { rows })
  assert.ok(parsedCalls < 1000, `read ${parsedCalls} of 50000 rows to keep five`)
  const q = ledger.terms.medulla.digest.queries[0]
  assert.ok((q.previewRows || []).length <= 25, 'the preview stays a preview')
})
