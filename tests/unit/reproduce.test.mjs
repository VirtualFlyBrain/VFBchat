import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VFBQUERY_FUNCTIONS,
  NO_ARG_QUERY_TYPES,
  UNREPRODUCIBLE_QUERY_TYPES,
  reproductionFor,
  ranQueries,
  buildReproduction,
  wantsReproduction,
  reproductionBlock
} from '../../lib/reproduce.mjs'
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
  assert.match(rep.python, /^df = vfbquery\.get_neurons_with_part_in\(MEDULLA\)$/m)
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
  assert.match(rep.python, /^df = vfbquery\.get_all_datasets\(\)$/m)
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
