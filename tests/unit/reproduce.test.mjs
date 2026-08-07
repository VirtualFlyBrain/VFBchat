import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  VFBQUERY_FUNCTIONS,
  NO_ARG_QUERY_TYPES,
  UNREPRODUCIBLE_QUERY_TYPES,
  reproductionFor,
  ranQueries,
  buildReproduction,
  wantsReproduction,
  reproductionBlock, withReproduction, wantsVfbConnect, vfbConnectSnippet, VFB_CONNECT_PROPERTIES
} from '../../lib/reproduce.mjs'
import { createLedger, recordTermId } from '../../lib/ledger.mjs'
import { QUERY_SEMANTICS } from '../../lib/queryTypes.mjs'

// A ledger shaped the way the harness leaves one: resolved terms keyed by the
// name the planner used, a registry keyed by normalised label, and a plan whose
// run_query steps carry the (id, query_type) they were dispatched with.
function medullaLedger({ plan = [], terms = null, registry = null } = {}) {
  return {
    question: 'What is the medulla?',
    terms: terms || {
      medulla: { id: 'FBbt_00003748', label: 'medulla', digest: { name: 'medulla' } }
    },
    registry: registry || {
      medulla: { id: 'FBbt_00003748', label: 'medulla', canonical: true }
    },
    plan,
    evidence: []
  }
}

const runQuery = (id, query_type, stepId = 'q1') =>
  ({ id: stepId, tool: 'vfb_run_query', status: 'satisfied', args: { id, query_type } })

test('every query type the map claims resolves to a callable shape', () => {
  for (const [qt, fn] of Object.entries(VFBQUERY_FUNCTIONS)) {
    assert.match(fn, /^get_[a-z0-9_]+$/, `${qt} -> ${fn} is not a plausible VFBquery function name`)
  }
  // The map is derived from VFBquery's own schema declarations, so a duplicated
  // target would mean two query types were declared onto one function — worth
  // knowing about, but legitimate, so this only pins the ones we rely on being
  // distinct: the four region-membership queries answer four different questions
  // and must not collapse onto one call.
  const regionish = ['NeuronsPartHere', 'NeuronsSynaptic', 'NeuronsPresynapticHere', 'NeuronsPostsynapticHere']
    .map(q => VFBQUERY_FUNCTIONS[q])
  assert.equal(new Set(regionish).size, 4, 'the four region queries must map to four distinct functions')
})

test('an unknown query type is unmapped, never guessed', () => {
  // The guess would be easy — strip the caps, snake-case it, prefix get_ — and
  // it would be wrong often enough to hand users a snippet that raises
  // AttributeError on their machine. Offering nothing is better; the caller
  // falls back to a browser URL that reproduces the query exactly.
  assert.equal(reproductionFor('SomeQueryVFBAddedLastWeek'), null)
  assert.equal(reproductionFor(''), null)
  assert.equal(reproductionFor(undefined), null)
})

test('the two irregular query types are handled as irregular', () => {
  // AllDatasets is declared against a template id but its function takes none;
  // passing the id would raise.
  const all = reproductionFor('AllDatasets')
  assert.equal(all.fn, 'get_all_datasets')
  assert.equal(all.takesId, false)
  assert.ok(NO_ARG_QUERY_TYPES.has('AllDatasets'))

  // The user-data similarity query wants an upload handle from the VFB browser.
  // No chat session can produce one, so it is not offered at all.
  assert.equal(reproductionFor('SimilarMorphologyToUserData'), null)
  assert.ok(UNREPRODUCIBLE_QUERY_TYPES.has('SimilarMorphologyToUserData'))
})

test('coverage against the query types this codebase already reasons about', () => {
  // A drift guard with teeth: lib/queryTypes.mjs is the list of query types the
  // rest of the harness knows how to read a count from, so any of those that is
  // NOT reproducible is a hole the user will actually fall into. The expected
  // set is written out rather than counted so that adding a mapping makes this
  // test fail loudly and be updated deliberately.
  const known = Object.keys(QUERY_SEMANTICS)
  const missing = known.filter(qt => !VFBQUERY_FUNCTIONS[qt])
  assert.deepEqual(missing.sort(), [
    // Legacy alias whose modern VFBquery function runs the OTHER direction
    // (anatomy from an expression pattern, not expression from anatomy).
    // Mapping it would silently answer a different question.
    'ExpressionOverlapsHere',
    // The parameterised `ref_` variants. They are almost certainly the same
    // four connectivity queries under different names, but "almost certainly"
    // is the standard this file exists to refuse.
    'ref_downstream_class_connectivity_query',
    'ref_neuron_neuron_connectivity_query',
    'ref_neuron_region_connectivity_query',
    'ref_upstream_class_connectivity_query'
  ].sort())
})

test('ranQueries reads what was asked, from the plan, in order and once each', () => {
  const ledger = medullaLedger({
    plan: [
      { id: 's1', tool: 'vfb_search_terms', status: 'satisfied', args: { query: 'medulla' } },
      runQuery('FBbt_00003748', 'NeuronsPartHere', 'q1'),
      runQuery('FBbt_00003748', 'PartsOf', 'q2'),
      // the same pair twice — a retry, not a second question
      runQuery('FBbt_00003748', 'NeuronsPartHere', 'q3')
    ]
  })
  const ran = ranQueries(ledger)
  assert.deepEqual(ran.map(r => r.query_type), ['NeuronsPartHere', 'PartsOf'])
  assert.equal(ran[0].stepId, 'q1')
})

test('a step with no id, or a junk id, contributes nothing', () => {
  // An id-less run_query step happens (the planner names a query type with no
  // target). It is not evidence that any particular term was queried, so it
  // must not become a snippet line addressed to whatever term happens to be
  // first — that is how a reproduction stops reproducing.
  const ledger = medullaLedger({
    plan: [
      { id: 'q1', tool: 'vfb_run_query', status: 'satisfied', args: { query_type: 'PartsOf' } },
      { id: 'q2', tool: 'vfb_run_query', status: 'satisfied', args: { id: 'medulla', query_type: 'PartsOf' } }
    ]
  })
  assert.deepEqual(ranQueries(ledger), [])
})

test('the snippet carries the resolved id, not the term name', () => {
  // The whole point. "medulla" typed into a fresh Python search matches the
  // adult medulla, the larval one and the medulla of the optic lobe; the id
  // this conversation settled on matches one of them.
  const ledger = medullaLedger({ plan: [runQuery('FBbt_00003748', 'NeuronsPartHere')] })
  const rep = buildReproduction(ledger)
  assert.ok(rep)
  assert.match(rep.python, /^MEDULLA = 'FBbt_00003748'\s+# medulla$/m)
  assert.match(rep.python, /^neurons_part_here = vfbquery\.get_neurons_with_part_in\(MEDULLA\)$/m)
  assert.match(rep.python, /^import vfbquery$/m)
  assert.equal(rep.calls.length, 1)
  assert.equal(rep.calls[0].fn, 'get_neurons_with_part_in')
})

test('an unmapped query degrades to the URL that runs it, and says so', () => {
  const ledger = medullaLedger({ plan: [runQuery('FBbt_00003748', 'ExpressionOverlapsHere')] })
  const rep = buildReproduction(ledger)
  assert.equal(rep.calls.length, 0)
  assert.equal(rep.unmapped.length, 1)
  assert.match(rep.python, /No VFBquery entry point is known/)
  assert.match(rep.python, /q=FBbt_00003748,ExpressionOverlapsHere/)
  // and it must not have invented a call for it
  assert.doesNotMatch(rep.python, /^df = /m)
})

test('the no-argument query is emitted without an argument', () => {
  const ledger = medullaLedger({ plan: [runQuery('VFB_00101567', 'AllDatasets')] })
  const rep = buildReproduction(ledger)
  assert.match(rep.python, /^all_datasets = vfbquery\.get_all_datasets\(\)$/m)
})

test('two terms get two distinct constants, and a label collision does not shadow', () => {
  const ledger = {
    terms: {
      'protocerebral bridge': { id: 'FBbt_00003668', digest: { name: 'protocerebral bridge' } },
      'ellipsoid body': { id: 'FBbt_00003678', digest: { name: 'ellipsoid body' } },
      // a third entity whose label normalises onto the first
      'protocerebral-bridge': { id: 'FBbt_00099999', digest: { name: 'protocerebral (bridge)' } }
    },
    registry: {},
    plan: [],
    evidence: []
  }
  const rep = buildReproduction(ledger)
  const consts = rep.ids.map(t => t.const)
  assert.equal(new Set(consts).size, consts.length, 'constants must be unique')
  assert.deepEqual(consts, ['PROTOCEREBRAL_BRIDGE', 'ELLIPSOID_BODY', 'PROTOCEREBRAL_BRIDGE_2'])
})

test('a label is never allowed to break out of the string or the comment', () => {
  const ledger = {
    terms: {
      nasty: { id: 'FBbt_00000001', digest: { name: "med'ulla\n# rm -rf /" } }
    },
    registry: {},
    plan: [],
    evidence: []
  }
  const rep = buildReproduction(ledger)
  // the id is what gets quoted, and it is clean; the label only ever appears in
  // a comment, flattened to one line
  assert.match(rep.python, /^[A-Z0-9_]+ = 'FBbt_00000001'\s+# med'ulla # rm -rf \/$/m)
  assert.equal(rep.python.split('\n').filter(l => l.includes('rm -rf')).length, 1)
})

test('the authoritative registry label wins over a model-supplied term name', () => {
  // The same rule buildFollowOns applies. A snippet that comments an MBON id
  // with "mushroom body" is worse than one with no comment at all.
  const ledger = medullaLedger({
    terms: { 'mushroom body': { id: 'FBbt_00110945' } },
    registry: { 'mbon01': { id: 'FBbt_00110945', label: 'MBON01', canonical: true } },
    plan: []
  })
  const rep = buildReproduction(ledger)
  assert.equal(rep.ids[0].label, 'MBON01')
  assert.equal(rep.ids[0].const, 'MBON01')
})

test('nothing resolved and nothing run yields no handoff at all', () => {
  assert.equal(buildReproduction({ terms: {}, registry: {}, plan: [], evidence: [] }), null)
  assert.equal(buildReproduction({}), null)
})

test('the prose block is appended only when the user asked for it', () => {
  const ledger = medullaLedger({ plan: [runQuery('FBbt_00003748', 'PartsOf')] })
  const rep = buildReproduction(ledger)

  for (const q of [
    'What are the parts of the medulla, and list the VFB IDs?',
    'How do I get this in Python?',
    'Show me the vfb_connect code for that',
    'can you make that reproducible?',
    'give me a python snippet',
    'I want to do this programmatically'
  ]) {
    assert.ok(wantsReproduction(q), `should have matched: ${q}`)
    assert.match(reproductionBlock(rep, q), /^\n\n```python\n/)
  }

  for (const q of [
    'What are the parts of the medulla?',
    'Which neurons connect them?',
    // "id" as a bare word must not trigger it
    'What is the identity of this neuron?',
    'Tell me about the pythonic optic lobe'   // no such thing; the point is 'python' alone is not enough
  ]) {
    assert.equal(wantsReproduction(q), false, `should NOT have matched: ${q}`)
    assert.equal(reproductionBlock(rep, q), '')
  }
})

test('the block is empty when there is nothing to reproduce, however it was asked', () => {
  assert.equal(reproductionBlock(null, 'give me the python code'), '')
})

// --- drift guard against the real VFBquery, when it is on this machine ------
//
// The map in reproduce.mjs was derived by parsing VFBquery's own
// `<QueryType>_to_schema` declarations, but a derivation is only true on the day
// it was run. When a VFBquery checkout is available this re-derives the two
// facts the snippet depends on — the function exists, and it takes the number of
// positional arguments we pass — straight from the source. Where it is not
// available the check is skipped rather than faked: a green tick from a test
// that could not see VFBquery would be worse than no tick.
//
//   VFBQUERY_SRC=/path/to/vfbquery/src/vfbquery/vfb_queries.py node --test …
test('every mapped function exists in VFBquery and accepts the argument we pass', async t => {
  const src = process.env.VFBQUERY_SRC
  if (!src || !(await import('node:fs')).existsSync(src)) {
    t.skip('set VFBQUERY_SRC to a vfb_queries.py to run this check')
    return
  }
  const text = (await import('node:fs')).readFileSync(src, 'utf8')
  // Module-level `def name(args…):` only — a nested def is not importable as
  // `vfbquery.name`, which is exactly what the snippet writes.
  const defs = new Map()
  for (const m of text.matchAll(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm)) {
    const params = m[2].split(',').map(s => s.trim()).filter(Boolean)
      .filter(p => !p.startsWith('*') && !p.startsWith('**'))
    defs.set(m[1], {
      total: params.length,
      required: params.filter(p => !p.includes('=')).length
    })
  }
  assert.ok(defs.size > 10, 'failed to parse any function definitions — check VFBQUERY_SRC')

  const problems = []
  for (const [qt, fn] of Object.entries(VFBQUERY_FUNCTIONS)) {
    const d = defs.get(fn)
    if (!d) { problems.push(`${qt} -> ${fn}() does not exist in VFBquery`); continue }
    const passes = NO_ARG_QUERY_TYPES.has(qt) ? 0 : 1
    if (passes < d.required || passes > d.total) {
      problems.push(`${qt} -> ${fn}() takes ${d.required}..${d.total} positional args, the snippet passes ${passes}`)
    }
  }
  assert.deepEqual(problems, [])
})

// ---------------------------------------------------------------------------
// The measured live failure, C11 turn 2 (task battery, 4.1.0, 2026-08-07).
//
// Question: "How would I get that same result in Python with vfbquery?"
// The model answered with a snippet cribbed from a docs page — wrong library,
// undefined `vc`, a worked example about DA1 projection neurons — and the
// grounded block sat underneath it carrying the right id and no call at all.
// ---------------------------------------------------------------------------

const MODEL_ANSWER = `To retrieve the list of neuron types with parts in the medulla using Python and \`\`, you can query the VFB ontology.

The following code demonstrates how to query for a specific neuron type:

\`\`\`python
from.cross_server_tools import gen_short_form

def vfb_type_2_skids(vfb_type):
 ids_from_vfb = map(gen_short_form, vc.oc.get_instances(vfb_type, query_by_label=True))
 return list(ids_from_vfb)
\`\`\`

To apply this to your specific question about the medulla, replace the query string.`

test('a turn that runs no query still reproduces what the conversation ran', () => {
  // Turn 2 asks about code, not about flies, so its own plan is empty. The
  // queries travel on the context, which is what the context is for.
  const ledger = createLedger()
  const context = {
    v: 1,
    terms: [{
      name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
      queries: [
        { query_type: 'NeuronsPartHere', label: '', count: 471, countKind: 'exact', ran: true },
        { query_type: 'ImagesNeurons', label: '', count: 12, countKind: 'exact', ran: false }
      ]
    }],
    registry: []
  }
  const repro = buildReproduction(ledger, { question: 'How would I get that same result in Python with vfbquery?', context })
  assert.ok(repro, 'a carried conversation is enough to build a reproduction')
  assert.deepEqual(repro.calls.map(c => c.fn), ['get_neurons_with_part_in'],
    'the query the conversation ran is reproduced; the one it merely could run is not')
  assert.match(repro.python, /MEDULLA = 'FBbt_00003748'/, 'the carried label names the constant')
  assert.match(repro.python, /vfbquery\.get_neurons_with_part_in\(MEDULLA\)/)
})

test('a carried query is never reproduced twice when this turn ran it again', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const context = { v: 1, registry: [], terms: [{ name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
    queries: [{ query_type: 'NeuronsPartHere', label: '', count: -1, countKind: 'unknown', ran: true }] }] }
  const repro = buildReproduction(ledger, { question: 'give me the python', context })
  assert.equal(repro.calls.length, 1)
})

test('the grounded snippet replaces the model\'s snippet rather than trailing after it', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const q = 'How would I get that same result in Python with vfbquery?'
  const repro = buildReproduction(ledger, { question: q })
  const out = withReproduction(MODEL_ANSWER, repro, q)

  assert.ok(!out.includes('gen_short_form'), 'the invented snippet is gone')
  assert.ok(!out.includes('vc.oc.get_instances'), 'and so is the undefined variable')
  assert.match(out, /vfbquery\.get_neurons_with_part_in\(MEDULLA\)/, 'ours is there instead')
  assert.equal((out.match(/```python/g) || []).length, 1, 'exactly one code block survives')
  // The sentence that introduces code must still introduce code.
  const intro = out.indexOf('The following code demonstrates')
  assert.ok(intro >= 0 && intro < out.indexOf('```python'), 'ours took the place, not the end')
})

test('an answer with no code of its own simply gains the block', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'Kenyon cell', 'FBbt_00003686', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003686', query_type: 'SubclassesOf' } }]
  const q = 'list the VFB IDs so I can reproduce this'
  const repro = buildReproduction(ledger, { question: q })
  const out = withReproduction('There are seven subclasses of Kenyon cell.', repro, q)
  assert.match(out, /^There are seven subclasses of Kenyon cell\.\n\n```python/)
})

test('a code block that is not about VFB is left alone', () => {
  // Displacing code is only ever justified where the user might run it against
  // VFB and be misled about which snippet is authoritative.
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const q = 'show me the python'
  const repro = buildReproduction(ledger, { question: q })
  const answer = 'The id format looks like this:\n\n```\nFBbt_00003748\n```'
  const out = withReproduction(answer, repro, q)
  assert.ok(out.includes('```\nFBbt_00003748\n```'), 'the illustrative block survives')
  assert.match(out, /```python/)
})

test('nothing is removed when there is nothing to put in its place', () => {
  // An answer with a flawed example still beats an answer with a dangling colon.
  const out = withReproduction(MODEL_ANSWER, null, 'how would I do this in python?')
  assert.equal(out, MODEL_ANSWER)
  const noAsk = withReproduction(MODEL_ANSWER, { python: 'x = 1' }, 'what is the medulla?')
  assert.equal(noAsk, MODEL_ANSWER, 'an unrequested block never displaces anything')
})

test('a dropped code block takes its orphaned introduction with it', () => {
  // Live, C11 turn 2 on the patched build: the second block went and left behind
  // "...the documented approach uses a helper function to convert VFB types to
  // skeleton IDs:" with nothing after the colon.
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const q = 'how would I do that in python?'
  const repro = buildReproduction(ledger, { question: q })
  const answer = [
    'Here is one way:', '',
    '```python', 'import vfbquery', 'x = 1', '```', '',
    'For visualisation, the documented approach converts types to skeleton IDs:', '',
    '```python', 'import navis', 'y = 2', '```', '',
    'That is the whole workflow.'
  ].join('\n')
  const out = withReproduction(answer, repro, q)

  assert.equal((out.match(/```python/g) || []).length, 1, 'one block survives')
  assert.ok(!out.includes('import navis'), 'the second block is gone')
  assert.ok(!out.includes('skeleton IDs:'), 'and so is the sentence that promised it')
  assert.ok(out.includes('That is the whole workflow.'), 'ordinary prose after it survives')
  assert.ok(!/ /.test(out), 'no marker leaks into the answer')
  assert.ok(!/\n{3,}/.test(out), 'no gap left where it was')
  // The first block's own introduction is untouched — it still introduces code.
  assert.match(out, /Here is one way:\n\n```python/)
})

test('a colon sentence with a surviving block after it is left alone', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const q = 'show me the python'
  const repro = buildReproduction(ledger, { question: q })
  const answer = 'Run this:\n\n```python\nimport vfbquery\n```\n\nThe id looks like:\n\n```\nFBbt_00003748\n```'
  const out = withReproduction(answer, repro, q)
  assert.ok(out.includes('The id looks like:'), 'an intro to a block we kept survives')
  assert.ok(out.includes('```\nFBbt_00003748\n```'))
})

// ---------------------------------------------------------------------------
// VFB_connect: the modern idiom, not the model's memory of an old one
//
// Production emitted `vc.oc.get_instances`, `gen_short_form` and a
// `vfb_type_2_skids` helper. Of those, only `vfb_id_2_xrefs` exists in current
// VFB_connect at all — and the tutorials call it on `vfb` directly, never
// through `neo_query_wrapper`. `vfb_type_2_skids` appears nowhere in the
// repository. So the snippet was recalled, not retrieved.
// ---------------------------------------------------------------------------

test('asking for VFB-connect by name gets vfb.term(), not vfbquery', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const repro = buildReproduction(ledger, { question: 'x' })

  for (const q of ['How do I do that in vfb_connect?', 'show me the python with VFB-connect',
                   'how would I get this in vfb connect?']) {
    assert.equal(wantsVfbConnect(q), true, q)
    const block = reproductionBlock(repro, q)
    assert.match(block, /from vfb_connect import vfb/)
    assert.match(block, /medulla = vfb\.term\('FBbt_00003748'\)/)
    assert.match(block, /medulla\.neuron_types_that_overlap/)
    assert.ok(!block.includes('import vfbquery'), 'not both idioms at once')
  }
})

test('none of the legacy reach-through idioms can be emitted', () => {
  // The exact strings production produced. They must be unreachable by
  // construction, not merely unlikely.
  const src = readFileSync(new URL('../../lib/reproduce.mjs', import.meta.url), 'utf8')
  for (const legacy of ['neo_query_wrapper', '.oc.', 'gen_short_form', 'vfb_type_2_skids']) {
    assert.ok(!src.includes(legacy), `reproduce.mjs must never emit ${legacy}`)
  }
})

test('VFBquery stays the default when VFB-connect is not asked for', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'Kenyon cell', 'FBbt_00003686', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003686', query_type: 'SubclassesOf' } }]
  const repro = buildReproduction(ledger, { question: 'x' })
  const block = reproductionBlock(repro, 'how would I get that in python?')
  assert.match(block, /import vfbquery/)
  assert.ok(!block.includes('vfb.term('))
})

test('a run whose queries have no vouched-for property falls back rather than emitting an import and no work', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  // ListAllAvailableImages is mapped for VFBquery and deliberately absent from
  // VFB_CONNECT_PROPERTIES — close-but-not-equal is left out on purpose.
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'ListAllAvailableImages' } }]
  const repro = buildReproduction(ledger, { question: 'x' })
  assert.equal(vfbConnectSnippet(repro), null)
  const block = reproductionBlock(repro, 'in vfb_connect please')
  assert.match(block, /import vfbquery/, 'falls back to the idiom that maps it')
})

test('every result gets its own variable, in both idioms', () => {
  // Two queries used to produce two lines both assigning `df`, so copy-pasting
  // the block silently discarded the first result.
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.plan = [
    { id: 's1', tool: 'vfb_run_query', status: 'satisfied', args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } },
    { id: 's2', tool: 'vfb_run_query', status: 'satisfied', args: { id: 'FBbt_00003748', query_type: 'NeuronsPresynapticHere' } }
  ]
  const repro = buildReproduction(ledger, { question: 'x' })
  for (const q of ['in python', 'in vfb_connect']) {
    const assigns = reproductionBlock(repro, q).split('\n')
      .filter(l => /^[a-z][a-z0-9_]* = /.test(l)).map(l => l.split(' = ')[0])
    assert.equal(new Set(assigns).size, assigns.length, `duplicate variable in "${q}": ${assigns}`)
    assert.ok(assigns.length >= 2, `both results are kept in "${q}"`)
  }
})

test('the VFB_connect property mapping exists in the installed VFB_connect', async t => {
  // Same drift guard as the VFBquery one: re-derived from a real checkout, so
  // the day a property is renamed this suite says so rather than shipping an
  // AttributeError to a workshop attendee.
  const src = process.env.VFB_CONNECT_SRC
  const fs = await import('node:fs')
  if (!src || !fs.existsSync(src)) {
    t.skip('set VFB_CONNECT_SRC to a vfb_term.py to run this check')
    return
  }
  const text = fs.readFileSync(src, 'utf8')
  const defined = new Set()
  for (const m of text.matchAll(/@property\s*\n\s*def\s+(\w+)\s*\(self/g)) defined.add(m[1])
  assert.ok(defined.size > 20, 'failed to parse any properties — check VFB_CONNECT_SRC')
  const missing = Object.entries(VFB_CONNECT_PROPERTIES)
    .filter(([, prop]) => !defined.has(prop))
    .map(([qt, prop]) => `${qt} -> .${prop} is not a property of VFBTerm`)
  assert.deepEqual(missing, [])
})

// ---------------------------------------------------------------------------
// The digest fallback — CI's battery caught this as C12 turn 1 on v4.1.4.
//
// A step whose arguments cannot be determined is answered from the term-info
// preview instead of by dispatching. The answer is real and drawn from real VFB
// data under a named query type, but the run recorded neither, so the
// reproduction offered the id and no call: "the subclasses of Kenyon cell are …"
// followed by a snippet with nothing to run.
// ---------------------------------------------------------------------------

test('a query answered from the term-info preview is still working the user can reproduce', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'Kenyon cell', 'FBbt_00003686', { canonical: true })
  ledger.plan = []                       // nothing dispatched
  ledger.evidence = [{
    source: 'vfb', claim: 'VFB holds 37 subclasses of Kenyon cell', verbatim: '37',
    stepId: 's1', tool: 'vfb_get_term_info', via: 'digest',
    query_type: 'SubclassesOf', id: 'FBbt_00003686'
  }]
  assert.deepEqual(ranQueries(ledger).map(q => `${q.id}::${q.query_type}`),
    ['FBbt_00003686::SubclassesOf'])
  const repro = buildReproduction(ledger, { question: 'list the VFB ids so I can reproduce this' })
  assert.deepEqual(repro.calls.map(c => c.fn), ['get_subclasses_of'])
  assert.match(repro.python, /vfbquery\.get_subclasses_of\(KENYON_CELL\)/)
})

test('a digest answer that named no query type contributes no call', () => {
  // We would not know which of the term's catalogue queries the extractor read,
  // and a guessed line is a line nothing in the run stands behind.
  const ledger = createLedger()
  recordTermId(ledger, 'Kenyon cell', 'FBbt_00003686', { canonical: true })
  ledger.evidence = [{
    source: 'vfb', claim: 'a claim', verbatim: 'x',
    stepId: 's1', tool: 'vfb_get_term_info', via: 'digest', id: 'FBbt_00003686'
  }]
  assert.deepEqual(ranQueries(ledger), [])
})

test('non-digest evidence is never mined for calls', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'Kenyon cell', 'FBbt_00003686', { canonical: true })
  ledger.evidence = [
    { source: 'doc', claim: 'a page said something', verbatim: 'x', query_type: 'SubclassesOf', id: 'FBbt_00003686' },
    { source: 'vfb', claim: 'dispatched', verbatim: 'y', query_type: 'PartsOf', id: 'FBbt_00003686' }
  ]
  assert.deepEqual(ranQueries(ledger), [], 'only the digest-fallback path counts')
})

test('a query both dispatched and previewed keeps its dispatched status', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'Kenyon cell', 'FBbt_00003686', { canonical: true })
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'not_found',
    args: { id: 'FBbt_00003686', query_type: 'SubclassesOf' } }]
  ledger.evidence = [{ source: 'vfb', claim: 'c', verbatim: 'v', stepId: 's2',
    via: 'digest', query_type: 'SubclassesOf', id: 'FBbt_00003686' }]
  const ran = ranQueries(ledger)
  assert.equal(ran.length, 1)
  assert.equal(ran[0].status, 'not_found', 'the dispatched record wins')
})
