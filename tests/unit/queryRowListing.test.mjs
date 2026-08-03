// Deterministic listing of run_query rows, and folding a run result back into
// the term-info digest.
//
// Both exist for one live failure: "Which neurons are presynaptic in the
// medulla? List them." ran the right query, got 262 rows, and answered
// "Running the query 'Neurons with presynaptic terminals in medulla' would
// provide the list of neurons". Two independent gaps produced that — nothing
// read the rows, and nothing populated the result table — so both are covered
// here.
//
// Run: node --test tests/unit/queryRowListing.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summariseQueryRows, backfillDigestPreview, pickQueriesByIntent } from '../../lib/orchestrator.mjs'

// Row shape as v3-cached actually returns it: label is a markdown link carrying
// the id a second time, tags are pipe-delimited, thumbnail is markdown too.
function row(id, label, extra = {}) {
  return {
    id,
    label: `[${label}](${id})`,
    tags: 'Adult|Nervous_system|Neuron',
    template: '[JRC2018U](VFB_00101567)',
    // Real VFB thumbnail shape: /i/<e1>/<e2>/<TEMPLATE>/thumbnail.png, wrapped in
    // a markdown image inside a markdown link. http on purpose — the parser must
    // upgrade it, since Chrome blocks mixed content on the https chat page.
    thumbnail: `[![${label}](http://virtualflybrain.org/data/VFB/i/0010/29eo/VFB_00101567/thumbnail.png '${label}')](VFB_001029eo)`,
    ...extra
  }
}

test('names the rows and reports the total when more results exist than are listed', () => {
  const parsed = {
    count: 262,
    count_status: 'exact',
    rows: Array.from({ length: 20 }, (_, i) => row(`FBbt_000${i}`, `Dm${i}`))
  }
  const out = summariseQueryRows(parsed, { label: 'Neurons with presynaptic terminals in medulla' })
  assert.ok(out)
  assert.equal(out.total, 262)
  // Capped, not truncated arbitrarily downstream.
  assert.equal(out.rows.length, 12)
  assert.match(out.claim, /262 results/)
  assert.match(out.claim, /The first 12/)
  // The names AND the ids must both be in the claim — "give me the VFB IDs" is
  // one of the workshop prompts this fixes.
  assert.match(out.claim, /Dm0 \(FBbt_0000\)/)
  assert.match(out.claim, /Dm11 \(FBbt_00011\)/)
  assert.equal(out.rows[0].name, 'Dm0')
  assert.equal(out.rows[0].id, 'FBbt_0000')
})

test('says the total is unknown — and quotes no figure — when the query did not count', () => {
  // count -1 means "not established", never zero and never a number to state.
  // Claiming "returns 0 results" here is the false-absence failure mode.
  const parsed = { count: -1, count_status: 'unavailable', rows: [row('FBbt_1', 'Mi1'), row('FBbt_2', 'Tm3')] }
  const out = summariseQueryRows(parsed)
  assert.ok(out)
  assert.equal(out.total, null)
  assert.match(out.claim, /did not establish the total/)
  assert.match(out.claim, /there may be more/)
  assert.ok(!/-1/.test(out.claim), 'must not quote the -1 sentinel')
  assert.ok(!/\b0 result/.test(out.claim), 'must not turn an uncounted query into a zero')
  assert.match(out.claim, /Mi1 \(FBbt_1\); Tm3 \(FBbt_2\)/)
})

test('says "in full" when the listed rows are the whole result set', () => {
  const parsed = { count: 2, count_status: 'exact', rows: [row('FBbt_1', 'Mi1'), row('FBbt_2', 'Tm3')] }
  const out = summariseQueryRows(parsed)
  assert.match(out.claim, /2 results, in full/)
})

test('uses the human query label when one is threaded through, the query_type otherwise', () => {
  const parsed = { count: 1, count_status: 'exact', rows: [row('FBbt_1', 'Mi1')] }
  assert.match(summariseQueryRows(parsed, { label: 'Neurons with presynaptic terminals in medulla' }).claim,
    /VFB's "Neurons with presynaptic terminals in medulla" query/)
  assert.match(summariseQueryRows(parsed).claim, /^This VFB query/)
})

test('returns null on anything unlistable, so the caller falls through to the extractor', () => {
  // Asserting nothing is the correct behaviour here: a null lets runStep try the
  // extractor and then the digest fallback, rather than manufacturing a claim.
  assert.equal(summariseQueryRows({ count: 0, count_status: 'exact', rows: [] }), null)
  assert.equal(summariseQueryRows({ count: 5 }), null)
  assert.equal(summariseQueryRows(null), null)
  assert.equal(summariseQueryRows({ rows: [{ id: '', label: '' }] }), null, 'rows with no readable label')
})

// --- backfillDigestPreview -------------------------------------------------

function ledgerWith(query) {
  return { terms: { medulla: { id: 'FBbt_00003748', label: 'medulla', digest: { name: 'medulla', queries: [query] } } } }
}
const EMPTY_PREVIEW = {
  query_type: 'NeuronsPresynapticHere',
  label: 'Neurons with presynaptic terminals in medulla',
  count: -1, countKind: 'unknown', previewRows: [], examples: [], exampleEntities: []
}

test('populates an empty preview from the rows the query actually returned', () => {
  // This is the medulla case: every one of its twelve previews comes back
  // rows [] / count -1 / pending, so buildTables skipped the query entirely and
  // the user got no result table for a question that had 262 answers.
  const ledger = ledgerWith({ ...EMPTY_PREVIEW })
  const parsed = { count: 262, count_status: 'exact', rows: [row('FBbt_1', 'Mi1'), row('FBbt_2', 'Tm3')] }
  assert.equal(backfillDigestPreview(ledger, { id: 'FBbt_00003748', query_type: 'NeuronsPresynapticHere' }, parsed), true)
  const q = ledger.terms.medulla.digest.queries[0]
  assert.equal(q.previewRows.length, 2)
  assert.equal(q.previewRows[0].name, 'Mi1')
  assert.equal(q.previewRows[0].id, 'FBbt_1')
  assert.match(q.previewRows[0].thumbnail, /^https:\/\//)
  assert.deepEqual(q.examples, ['Mi1', 'Tm3'])
  assert.deepEqual(q.exampleEntities, [{ id: 'FBbt_1', label: 'Mi1' }, { id: 'FBbt_2', label: 'Tm3' }])
  // The count link stops saying "unknown" too.
  assert.equal(q.count, 262)
  assert.equal(q.countKind, 'exact')
})

test('caps how many rows land in the digest', () => {
  const ledger = ledgerWith({ ...EMPTY_PREVIEW })
  const parsed = { count: 262, count_status: 'exact', rows: Array.from({ length: 60 }, (_, i) => row(`FBbt_${i}`, `Dm${i}`)) }
  backfillDigestPreview(ledger, { id: 'FBbt_00003748', query_type: 'NeuronsPresynapticHere' }, parsed)
  const q = ledger.terms.medulla.digest.queries[0]
  assert.equal(q.previewRows.length, 25)
  // examples feeds the digest TEXT, which is prompt budget — it stays at 5.
  assert.equal(q.examples.length, 5)
  assert.equal(q.exampleEntities.length, 5)
})

test('never downgrades a preview that already has rows or an exact count', () => {
  const existingRows = [{ name: 'already here', id: 'FBbt_9', thumbnail: '', tags: [] }]
  const ledger = ledgerWith({
    ...EMPTY_PREVIEW, previewRows: existingRows, examples: ['already here'], count: 7, countKind: 'exact'
  })
  const parsed = { count: 262, count_status: 'exact', rows: [row('FBbt_1', 'Mi1')] }
  assert.equal(backfillDigestPreview(ledger, { id: 'FBbt_00003748', query_type: 'NeuronsPresynapticHere' }, parsed), false)
  const q = ledger.terms.medulla.digest.queries[0]
  assert.deepEqual(q.previewRows, existingRows)
  assert.equal(q.count, 7)
})

test('an uncounted run populates the rows but leaves the count unresolved', () => {
  const ledger = ledgerWith({ ...EMPTY_PREVIEW })
  const parsed = { count: -1, count_status: 'unavailable', rows: [row('FBbt_1', 'Mi1')] }
  assert.equal(backfillDigestPreview(ledger, { id: 'FBbt_00003748', query_type: 'NeuronsPresynapticHere' }, parsed), true)
  const q = ledger.terms.medulla.digest.queries[0]
  assert.equal(q.previewRows.length, 1)
  assert.equal(q.countKind, 'unknown', '-1 is "not run/not counted", never an exact 0')
  assert.equal(q.count, -1)
})

// --- routing a list question to a class-list query ------------------------

// medulla's real catalogue, trimmed: several class-list queries differing by a
// word or two, all repeating the region's own name.
const MEDULLA = {
  name: 'medulla',
  queries: [
    { query_type: 'PartsOf', label: 'Parts of medulla', countKind: 'unknown' },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in medulla', countKind: 'unknown' },
    { query_type: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in medulla', countKind: 'unknown' },
    { query_type: 'NeuronsPostsynapticHere', label: 'Neurons with postsynaptic terminals in medulla', countKind: 'unknown' },
    { query_type: 'ImagesNeurons', label: 'Images of neurons with some part in medulla', countKind: 'unknown' }
  ]
}
const kinds = (q) => pickQueriesByIntent(q, MEDULLA).map(x => x.query_type)

test('a list question routes to the class-list query its wording picks out', () => {
  // Before this rule nothing matched: the query kind is class_list, not
  // connectivity, so the presynaptic question fell through every intent rule and
  // no query was ever run.
  assert.deepEqual(kinds('Which neurons are presynaptic in the medulla? List them.'), ['NeuronsPresynapticHere'])
  assert.deepEqual(kinds('List the neurons with postsynaptic terminals in the medulla'), ['NeuronsPostsynapticHere'])
  assert.deepEqual(kinds('What parts does the medulla have?'), ['PartsOf'])
})

test('an images question still routes to images, not to a class list', () => {
  // Rule order matters: "show me images of neurons in the medulla" must not be
  // captured by the broader list rule, because a class count is not an image count.
  assert.deepEqual(kinds('Show me images of neurons in the medulla'), ['ImagesNeurons'])
})

test('an ambiguous list question runs nothing rather than the wrong query', () => {
  // "which neurons" alone does not distinguish presynaptic from postsynaptic from
  // "some part". Guessing here would produce a confidently wrong answer.
  assert.deepEqual(kinds('Which neurons are in the medulla?'), [])
})

test('writes nothing when the target term, query or rows are missing', () => {
  const parsed = { count: 5, count_status: 'exact', rows: [row('FBbt_1', 'Mi1')] }
  assert.equal(backfillDigestPreview(ledgerWith({ ...EMPTY_PREVIEW }), { id: 'FBbt_OTHER', query_type: 'NeuronsPresynapticHere' }, parsed), false)
  assert.equal(backfillDigestPreview(ledgerWith({ ...EMPTY_PREVIEW }), { id: 'FBbt_00003748', query_type: 'SomethingElse' }, parsed), false)
  assert.equal(backfillDigestPreview(ledgerWith({ ...EMPTY_PREVIEW }), {}, parsed), false)
  assert.equal(backfillDigestPreview(ledgerWith({ ...EMPTY_PREVIEW }), { id: 'FBbt_00003748', query_type: 'NeuronsPresynapticHere' }, { rows: [] }), false)
})
