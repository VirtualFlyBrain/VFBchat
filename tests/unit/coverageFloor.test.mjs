// The prohibition must survive having nothing to prohibit with.
//
// THE LIVE FAILURE THIS COVERS
//
// W1.B — "Search VFB for the neuron type 'DA1 lPN' and list every individual
// neuron across all datasets, with their dataset and VFB ID." — was answered in
// THREE SECONDS with "VFB does not currently hold data on individual neurons of
// type 'DA1 lPN'." VFB holds 45 in FAFB, 30 in FlyWire, 14 in the hemibrain and
// 13 in MaleCNS.
//
// Three seconds is the tell. Nothing was looked up, because two independent
// mechanisms failed in series:
//
//   1. detectFastPath saw "list … datasets" and hijacked the question into the
//      AllDatasets enumeration. "datasets" was a SCOPE ("across all datasets"),
//      not the subject. No term was ever resolved.
//   2. With no term resolved, buildShelf returned [] and renderShelf returned
//      '' — so the synthesis prompt carried NO absence rule at all. The model
//      was at its least informed and its least constrained simultaneously.
//
// The second is the deeper bug: every prohibition in this system was conditional
// on having a catalogue to attach it to, which is precisely backwards. An absent
// catalogue is absent EVIDENCE, never evidence of absence — the same reading
// error as VFBquery's count -1 meaning "run the query", not "zero".
//
// Run: node --test tests/unit/coverageFloor.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderShelf, buildShelf, renderNoCoverageFloor, renderCoverageBlock } from '../../lib/coverage.mjs'
import { detectFastPath } from '../../lib/planner.mjs'
import { ledgerIsThin, shouldCheckSufficiency } from '../../lib/sufficiency.mjs'

// --- the floor itself --------------------------------------------------------

const EMPTY_LEDGER = { question: "list every individual neuron of type 'DA1 lPN'", terms: {}, plan: [], evidence: [] }

test('a ledger with no catalogue still forbids an absence', () => {
  assert.equal(renderShelf(buildShelf(EMPTY_LEDGER)), '', 'the precondition: there is no shelf')
  const out = renderCoverageBlock(EMPTY_LEDGER)
  assert.ok(out.trim(), 'a block must still be produced')
  assert.match(out, /FORBIDDEN/)
  assert.match(out, /VFB does not currently hold/, 'it must quote the exact sentence it is banning')
  assert.match(out, /never evidence of absence/i)
})

test('the floor offers the honest alternative instead of just saying no', () => {
  // A rule that only forbids leaves the model to invent a way round it. This one
  // names what MAY be said: the lookup did not land, which is a fact about VFB's
  // index rather than about its holdings.
  const out = renderNoCoverageFloor(EMPTY_LEDGER)
  assert.match(out, /could not be matched/i)
  assert.match(out, /EVIDENCE/, 'answering from what did arrive is still the first instruction')
})

test('the floor never invites the framing the stripper exists to remove', () => {
  // renderShelf's old WORTH SAYING paragraph told the model to say a query "has
  // not been run yet" and it obediently did, as a whole answer. The floor must
  // not reopen that door in a block that fires when the model has least to say.
  const out = renderNoCoverageFloor(EMPTY_LEDGER)
  assert.ok(!/has not been run yet|still needs to be run|yet to be run/i.test(out), out)
  assert.match(out, /reader has no session/i)
})

test('the floor says which way the ledger is empty', () => {
  const nothingResolved = renderNoCoverageFloor(EMPTY_LEDGER)
  assert.match(nothingResolved, /Nothing in this question resolved to a VFB term/)

  // A term resolved but advertises no query list — a different fact, and telling
  // the model the wrong one costs it the one true thing it could have written.
  const resolvedNoQueries = renderNoCoverageFloor({
    ...EMPTY_LEDGER,
    terms: { FBbt_00003686: { id: 'FBbt_00003686', label: 'Kenyon cell', digest: { name: 'Kenyon cell', queries: [] } } }
  })
  assert.match(resolvedNoQueries, /terms that resolved advertise no query catalogue/)
})

test('the floor distinguishes "nothing ran" from "something ran"', () => {
  assert.match(renderNoCoverageFloor(EMPTY_LEDGER), /NOTHING was looked at/)
  const ran = renderNoCoverageFloor({ ...EMPTY_LEDGER, evidence: [{ claim: 'x', source: 'vfb', stepId: 's1' }] })
  assert.match(ran, /NOTHING ELSE was looked at/)
})

test('a real shelf still wins, and the floor never doubles up on it', () => {
  const ledger = {
    question: 'What images does VFB have for DA1 lPN?',
    terms: {
      FBbt_00067363: {
        id: 'FBbt_00067363',
        label: 'DA1 lPN',
        digest: {
          name: 'DA1 lPN',
          queries: [{ query_type: 'ListAllAvailableImages', label: 'List all available images of DA1 lPN', count: 102, countKind: 'exact' }]
        }
      }
    },
    plan: [],
    evidence: []
  }
  const out = renderCoverageBlock(ledger)
  assert.match(out, /AVAILABLE VFB DATA for the resolved terms/)
  assert.ok(!/Nothing in this question resolved/.test(out), 'the two blocks must never both appear')
})

test('floor:false suppresses it for question shapes with their own absence wording', () => {
  // A documentation question resolves no term BY DESIGN, so it would collect the
  // floor every time — and the floor's advice is nonsense for "how do I connect
  // to the MCP server?". docBlock/docMissBlock redirect that absence to VFB's
  // DOCUMENTATION, which is both true and more useful; two blocks legislating
  // one sentence is how they end up contradicting each other.
  assert.equal(renderCoverageBlock(EMPTY_LEDGER, { floor: false }), '')
})

// --- the sufficiency predicate ----------------------------------------------

test('no catalogue reads as thin, not as sufficient', () => {
  const l = { question: 'anything', terms: {}, plan: [], evidence: [{ claim: 'a', source: 'vfb', stepId: 's1' }] }
  assert.equal(ledgerIsThin(l), true)
  // …but it must not buy a model call: the last gate reads the same digests.
  assert.equal(shouldCheckSufficiency(l), false)
})

// --- the fast-path hijacks ---------------------------------------------------

test('a dataset SCOPE does not hijack the question into a dataset enumeration', () => {
  const hijacked = [
    "Search VFB for the neuron type 'DA1 lPN' and list every individual neuron across all datasets, with their dataset and VFB ID.",
    'List every LPLC2 neuron in each dataset.',
    'Show me all images of DA1 lPN across the connectome datasets.',
    // Issue #39 — the NeuroFly workshop's original discovery prompt: the scope
    // preposition is stranded after the noun, and the subject is an unquoted
    // symbol ("DA1 lPN neurons"), so neither of the two original vetoes fired.
    "List all DA1 lPN neurons in VFB with their VFB IDs and which datasets they're in (FlyWire, hemibrain, BANC, etc).",
    "List all adult antennal lobe projection neuron DA1 lPN neurons in VFB with their VFB IDs and which datasets they're in (FlyWire, hemibrain, BANC, etc).",
    'How many DA1 lPN (FBbt:00067363) neurons are in VFB? List them with VFB IDs and which dataset each comes from.',
    'Which datasets contain Kenyon cells?'
  ]
  for (const q of hijacked) {
    assert.equal(detectFastPath(q), null, `must reach the planner: ${q}`)
  }
})

test('the genuine dataset enumeration still fast-paths', () => {
  // The veto must not cost the case the fast path was built for — that trade
  // would swap one wrong answer for another.
  for (const q of [
    'What datasets are available in VFB?',
    'Which connectome datasets does VFB have?',
    'List the datasets.',
    'What datasets does VFB have?',
    'Which datasets are in VFB?',
    'Which datasets in VFB have data from FlyWire?'
  ]) {
    const fp = detectFastPath(q)
    assert.equal(fp?.steps?.[0]?.args?.query_type, 'AllDatasets', q)
  }
})

test('the synaptic vocabulary vetoes the generic term-info fast path', () => {
  // W7.C3 matched "^what are X" and resolved "main synaptic partners of Kenyon
  // cells" as if it were a term name. One term-info lookup, no VFB connectivity,
  // and the answer came out of the literature — for a term whose digest
  // advertises the connectivity queries that answer it properly.
  for (const q of [
    'What are the main synaptic partners of Kenyon cells?',
    'What are the presynaptic partners of LPLC2?',
    'What is the postsynaptic target of DA1 lPN?',
    'What are the afferents of the mushroom body?',
    'What neurons innervate the fan-shaped body?'
  ]) {
    assert.equal(detectFastPath(q), null, `must reach the planner: ${q}`)
  }
})

test('the veto does not swallow a plain definitional lookup', () => {
  for (const [q, term] of [
    ['What is the mushroom body?', 'mushroom body'],
    ['What is a Kenyon cell?', 'Kenyon cell'],
    ['What is the fan-shaped body?', 'fan-shaped body']
  ]) {
    const fp = detectFastPath(q)
    assert.equal(fp?.intent, 'term_info', q)
    assert.deepEqual(fp?.terms_to_resolve, [term])
  }
})
