// Conversation context across the turn boundary.
//
// The defect under test is a two-turn one, so most of these tests are shaped as
// "what turn 1 produced" -> "what turn 2 can therefore do". A single-turn
// assertion cannot see this bug at all: everything turn 1 did was correct.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_VERSION, normName, buildTurnContext, sanitizeContext, mergeContext,
  priorTermId, priorTermQueries, seedLedgerFromContext, contextPromptBlock,
  minimizeMessage, minimizeHistory, contextTermsNamedIn
} from '../../lib/conversationContext.mjs'
import { recordTermId, createLedger } from '../../lib/ledger.mjs'

// A ledger shaped like the one turn 1 of the medulla trace produced.
function medullaLedger() {
  return {
    terms: {
      medulla: {
        id: 'FBbt_00003748',
        digest: {
          name: 'medulla',
          queries: [
            { query_type: 'ImagesHere', label: 'Images of medulla', count: 2342, countKind: 'exact' },
            { query_type: 'NeuronsWithPartHere', label: 'Neurons with some part here', count: 471, countKind: 'exact' },
            { query_type: 'NeuronsPostsynapticHere', label: 'Neurons with postsynaptic terminals here', count: 333, countKind: 'exact' }
          ]
        }
      }
    },
    registry: {
      medulla: { id: 'FBbt_00003748', label: 'medulla', canonical: true },
      'dm7': { id: 'FBbt_00003785', label: 'Dm7', canonical: false }
    }
  }
}

test('buildTurnContext carries id, label and the query catalogue', () => {
  const ctx = buildTurnContext(medullaLedger())
  assert.equal(ctx.v, CONTEXT_VERSION)
  assert.equal(ctx.terms.length, 1)
  assert.equal(ctx.terms[0].id, 'FBbt_00003748')
  assert.equal(ctx.terms[0].label, 'medulla')
  assert.deepEqual(ctx.terms[0].queries.map(q => q.query_type),
    ['ImagesHere', 'NeuronsWithPartHere', 'NeuronsPostsynapticHere'])
  assert.equal(ctx.terms[0].queries[2].count, 333)
  assert.ok(ctx.registry.some(([, id]) => id === 'FBbt_00003785'))
})

test('buildTurnContext ignores a term with no id and one with a bogus id', () => {
  const ctx = buildTurnContext({
    terms: {
      good: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [] } },
      unresolved: { attempted: true },
      forged: { id: 'javascript:alert(1)', digest: { name: 'x', queries: [] } }
    },
    registry: {}
  })
  assert.deepEqual(ctx.terms.map(t => t.id), ['FBbt_00003748'])
})

// --- the actual regression -------------------------------------------------

test('turn 2 finds the id turn 1 resolved, which is the whole bug', () => {
  const carried = buildTurnContext(medullaLedger())
  assert.equal(priorTermId(carried, 'medulla'), 'FBbt_00003748')
  // The planner writes the user's wording, not VFB's.
  assert.equal(priorTermId(carried, 'the medulla'), 'FBbt_00003748')
  assert.equal(priorTermId(carried, 'Medulla.'), 'FBbt_00003748')
  assert.equal(priorTermId(carried, 'medullas'), 'FBbt_00003748')
  // And does NOT invent one for something the conversation never resolved.
  assert.equal(priorTermId(carried, 'lobula plate'), null)
})

test('priorTermId does not answer from the registry', () => {
  // Dm7 is in the registry (harvested from a result row) but was never a term
  // the conversation set out to resolve. Skipping a search on the strength of a
  // harvested row label is how a later question about a different sense of a
  // generic word gets silently answered about the wrong entity.
  const carried = buildTurnContext(medullaLedger())
  assert.ok(carried.registry.some(([, id]) => id === 'FBbt_00003785'))
  assert.equal(priorTermId(carried, 'Dm7'), null)
})

test('priorTermQueries gates a follow-on chip to queries the term advertised', () => {
  const carried = buildTurnContext(medullaLedger())
  const qs = priorTermQueries(carried, 'FBbt_00003748').map(q => q.query_type)
  assert.ok(qs.includes('NeuronsPostsynapticHere'))
  assert.ok(!qs.includes('SomethingElse'))
  assert.deepEqual(priorTermQueries(carried, 'FBbt_99999999'), [])
})

// --- untrusted input -------------------------------------------------------

test('sanitizeContext drops a forged id rather than repairing it', () => {
  const out = sanitizeContext({
    v: CONTEXT_VERSION,
    terms: [
      { name: 'medulla', label: 'medulla', id: 'FBbt_00003748', queries: [] },
      { name: 'evil', label: 'evil', id: '../../etc/passwd', queries: [] },
      { name: 'evil2', label: 'evil2', id: 'FBbt_0000 3748', queries: [] }
    ],
    registry: []
  })
  assert.deepEqual(out.terms.map(t => t.id), ['FBbt_00003748'])
})

test('sanitizeContext rejects a query_type that is not an identifier', () => {
  const out = sanitizeContext({
    v: CONTEXT_VERSION,
    terms: [{
      name: 'm', label: 'm', id: 'FBbt_00003748',
      queries: [
        { query_type: 'ImagesHere', count: 3 },
        { query_type: 'Images Here', count: 3 },
        { query_type: 'a"onerror=x', count: 3 },
        { query_type: '../Other', count: 3 }
      ]
    }],
    registry: []
  })
  assert.deepEqual(out.terms[0].queries.map(q => q.query_type), ['ImagesHere'])
})

test('sanitizeContext drops a context from another version wholesale', () => {
  const good = buildTurnContext(medullaLedger())
  assert.equal(sanitizeContext({ ...good, v: CONTEXT_VERSION + 1 }).terms.length, 0)
  assert.equal(sanitizeContext({ ...good, v: undefined }).terms.length, 0)
  assert.equal(sanitizeContext(null).terms.length, 0)
  assert.equal(sanitizeContext('nope').terms.length, 0)
})

test('sanitizeContext caps a hostile payload', () => {
  const terms = Array.from({ length: 500 }, (_, i) => ({
    name: `n${i}`, label: 'x'.repeat(5000), id: `FBbt_${String(i).padStart(8, '0')}`,
    queries: Array.from({ length: 500 }, (_, j) => ({ query_type: `Q${j}`, count: j }))
  }))
  const out = sanitizeContext({ v: CONTEXT_VERSION, terms, registry: [] })
  assert.ok(out.terms.length <= 24, `terms capped, got ${out.terms.length}`)
  assert.ok(out.terms[0].queries.length <= 14)
  assert.ok(out.terms[0].label.length <= 160)
})

test('a registry row cannot arrive as a prototype-polluting key', () => {
  const out = sanitizeContext({
    v: CONTEXT_VERSION, terms: [],
    registry: [['__proto__', 'FBbt_00003748', 'x'], ['constructor', 'FBbt_00003749', 'y']]
  })
  // Carried as pairs, so nothing is ever assigned as an object key here...
  assert.ok(Array.isArray(out.registry))
  // ...and seeding does not let one through either.
  const led = seedLedgerFromContext(createLedger('q'), out)
  assert.equal(Object.getPrototypeOf({}).polluted, undefined)
  assert.ok(!('polluted' in {}))
  assert.ok(led.registry)
})

// --- merge -----------------------------------------------------------------

test('mergeContext puts the freshest term first and dedupes by id', () => {
  const t1 = buildTurnContext(medullaLedger())
  const t2 = buildTurnContext({
    terms: { 'lobula plate': { id: 'FBbt_00003852', digest: { name: 'lobula plate', queries: [] } } },
    registry: {}
  })
  const merged = mergeContext(t1, t2)
  assert.deepEqual(merged.terms.map(t => t.id), ['FBbt_00003852', 'FBbt_00003748'])
})

test('a re-resolved term takes this turn counts but keeps an older catalogue if this turn had none', () => {
  const t1 = buildTurnContext(medullaLedger())
  // Turn 2 reached the medulla through a query result row: id, no digest.
  const t2 = buildTurnContext({
    terms: { medulla: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [] } } },
    registry: {}
  })
  const merged = mergeContext(t1, t2)
  assert.equal(merged.terms.length, 1)
  assert.ok(merged.terms[0].queries.length, 'catalogue must survive a digest-less turn')

  // But a turn that DID produce a catalogue overwrites the stale counts.
  const t3 = buildTurnContext({
    terms: {
      medulla: {
        id: 'FBbt_00003748',
        digest: { name: 'medulla', queries: [{ query_type: 'ImagesHere', label: 'Images', count: 9999, countKind: 'exact' }] }
      }
    },
    registry: {}
  })
  const merged2 = mergeContext(t1, t3)
  assert.equal(merged2.terms[0].queries.length, 1)
  assert.equal(merged2.terms[0].queries[0].count, 9999)
})

test('mergeContext of two empties is a valid empty context', () => {
  const m = mergeContext(null, null)
  assert.equal(m.v, CONTEXT_VERSION)
  assert.deepEqual(m.terms, [])
})

// --- seeding ---------------------------------------------------------------

test('seeded entries use recordTermId key so live VFB data can upgrade them', () => {
  const carried = buildTurnContext(medullaLedger())
  const led = seedLedgerFromContext(createLedger('q'), carried)
  assert.equal(led.registry['medulla'].id, 'FBbt_00003748')
  assert.equal(led.registry['medulla'].canonical, false)
  // A canonical write this turn must land on the SAME key and win.
  recordTermId(led, 'medulla', 'FBbt_00099999', { canonical: true })
  assert.equal(led.registry['medulla'].id, 'FBbt_00099999',
    'a canonical source must be able to overwrite a carried mapping')
  assert.equal(led.registry['medulla'].canonical, true)
})

test('the seed key IS recordTermId key, for every label shape the two treat differently', () => {
  // Deliberately synthetic labels. `medulla` cannot catch a key-convention drift
  // because every reasonable normalisation agrees on it — which is exactly how a
  // drift would ship unnoticed. These are the shapes where the conventions can
  // disagree (a leading article, trailing punctuation, doubled spacing), and the
  // property under test is structural: seeding then writing canonically must
  // leave ONE registry entry, holding THIS turn's id. Two entries means the
  // canonical write missed the seeded key, which leaves a carried mapping
  // outranking live VFB data — the one inversion this design promises never to
  // make.
  for (const label of ['the medulla', 'medulla.', 'Optic  Lobe', 'T4 neurons']) {
    const carried = buildTurnContext({
      terms: { x: { id: 'FBbt_00000001', digest: { name: label, queries: [] } } },
      registry: {}
    })
    const led = seedLedgerFromContext(createLedger('q'), carried)
    recordTermId(led, label, 'FBbt_00000002', { canonical: true })
    const rows = Object.entries(led.registry)
    assert.equal(rows.length, 1, `${label}: expected one key, got ${JSON.stringify(rows.map(r => r[0]))}`)
    assert.equal(rows[0][1].id, 'FBbt_00000002', `${label}: canonical write must win`)
  }
})

test('seedLedgerFromContext attaches the sanitized context for resolveTerms', () => {
  const led = seedLedgerFromContext(createLedger('q'), { v: CONTEXT_VERSION, terms: [], registry: [] })
  assert.ok(led._priorContext)
  assert.equal(led._priorContext.v, CONTEXT_VERSION)
})

// --- planner block ---------------------------------------------------------

test('contextPromptBlock names the id and the available queries, or says nothing', () => {
  const block = contextPromptBlock(buildTurnContext(medullaLedger()))
  assert.match(block, /medulla = FBbt_00003748/)
  assert.match(block, /NeuronsPostsynapticHere/)
  assert.equal(contextPromptBlock(null), '')
  assert.equal(contextPromptBlock({ v: CONTEXT_VERSION, terms: [], registry: [] }), '')
})

// --- minimized history -----------------------------------------------------

test('minimizeMessage keeps the sentence and drops the apparatus', () => {
  const src = [
    '## The medulla',
    'The [medulla](https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?id=FBbt_00003748 "medulla") is a **neuropil**.',
    '![thumb](http://www.virtualflybrain.org/data/VFB/i/jrmc/20bn/VFB_00101567/thumbnail.png)',
    '| Name | Id |',
    '| --- | --- |',
    '| Dm7 | FBbt_00003785 |',
    '```json',
    '{"a": 1}',
    '```'
  ].join('\n')
  const out = minimizeMessage(src)
  assert.match(out, /The medulla is a neuropil\./)
  assert.ok(!out.includes('http'), 'no URLs survive')
  assert.ok(!out.includes('|'), 'no table rows survive')
  assert.ok(!out.includes('{"a"'), 'no fenced block survives')
  assert.ok(!out.includes('##'))
  assert.ok(out.length < src.length / 2)
})

test('minimizeMessage clips a long turn at a sentence boundary', () => {
  const long = ('The medulla is a neuropil of the optic lobe. ').repeat(60)
  const out = minimizeMessage(long, { maxPerMessage: 300 })
  assert.ok(out.length <= 320, `got ${out.length}`)
  assert.match(out, /…$/)
  assert.match(out, /neuropil of the optic lobe\. …$/)
})

test('minimizeHistory keeps the most recent turns and reports what it dropped', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `turn ${i} about the [medulla](https://example.org/x "t")`
  }))
  const out = minimizeHistory(messages, { keepRecent: 4 })
  assert.equal(out.messages.length, 4)
  assert.equal(out.dropped, 16)
  assert.equal(out.messages[3].content, 'turn 19 about the medulla')
  assert.ok(!JSON.stringify(out.messages).includes('example.org'))
})

test('minimizeHistory drops the OLDEST when the char budget bites', () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({
    role: 'assistant', content: `${i} ` + 'x'.repeat(400)
  }))
  const out = minimizeHistory(messages, { keepRecent: 6, maxChars: 900, maxPerMessage: 500 })
  assert.ok(out.messages.length < 6)
  assert.ok(out.messages[out.messages.length - 1].content.startsWith('5 '),
    'the newest turn must always survive')
  assert.ok(out.chars <= 900)
})

test('minimizeHistory tolerates junk entries', () => {
  const out = minimizeHistory([null, { role: 'user' }, { role: 'tool', content: 'x' }, { role: 'user', content: 'hi' }])
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }])
  assert.deepEqual(minimizeHistory(null).messages, [])
})

test('normName is forgiving about English and unforgiving about identity', () => {
  assert.equal(normName('  The Medulla.  '), 'medulla')
  assert.equal(normName('MEDULLA'), 'medulla')
  assert.notEqual(normName('medulla'), normName('lobula'))
  assert.notEqual(normName('medulla'), normName('accessory medulla'))
})

// --- adoption: the carried id has to come back as a name to resolve ----------
//
// These guard the second-order defect. Once the planner can see the carried id it
// stops asking for the name, `resolveTerms` never runs, and the turn that used
// the context BEST is the one that ends with an empty `ledger.terms` — no chips,
// no sources, no term links. The medulla trace showed it exactly: turn 1 offered
// six follow-ups, turn 2 offered none.

test('contextTermsNamedIn finds the carried term the question still names', () => {
  const ctx = buildTurnContext(medullaLedger())
  for (const q of [
    'Which neurons receive output from the medulla?',
    'the medulla, please',
    'What about MEDULLA layers?',
    'tell me about medullas'
  ]) {
    const hit = contextTermsNamedIn(ctx, q)
    assert.equal(hit.length, 1, q)
    assert.equal(hit[0].id, 'FBbt_00003748', q)
  }
})

test('contextTermsNamedIn does not adopt a term the question never mentions', () => {
  const ctx = buildTurnContext(medullaLedger())
  for (const q of [
    'Which neurons are in the lobula?',
    // A word-boundary match, not a substring one: adopting the medulla here would
    // spend a term-info round trip on an entity the user did not ask about, and
    // hang its follow-on chips off an unrelated answer.
    'what is medullary tissue?',
    'premedulla',
    ''
  ]) {
    assert.deepEqual(contextTermsNamedIn(ctx, q), [], q)
  }
})

test('contextTermsNamedIn matches VFB\'s label as well as the user\'s wording', () => {
  // Turn 1 asked about "the second optic neuropil"; VFB called it "medulla".
  // Either wording in turn 2 has to find the same carried id.
  const ctx = sanitizeContext({
    v: CONTEXT_VERSION,
    terms: [{ name: 'second optic neuropil', label: 'medulla', id: 'FBbt_00003748', queries: [] }],
    registry: []
  })
  assert.equal(contextTermsNamedIn(ctx, 'what projects from the medulla?')[0]?.id, 'FBbt_00003748')
  assert.equal(contextTermsNamedIn(ctx, 'is the second optic neuropil layered?')[0]?.id, 'FBbt_00003748')
})

test('contextTermsNamedIn is capped and survives junk', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `region ${'abcdefghi'[i]}`, label: `region ${'abcdefghi'[i]}`, id: `FBbt_0000000${i}`, queries: []
  }))
  const ctx = sanitizeContext({ v: CONTEXT_VERSION, terms: many, registry: [] })
  const q = many.map(t => t.name).join(' and ')
  assert.equal(contextTermsNamedIn(ctx, q).length, 3)
  assert.equal(contextTermsNamedIn(ctx, q, { max: 5 }).length, 5)
  assert.deepEqual(contextTermsNamedIn(null, 'medulla'), [])
  assert.deepEqual(contextTermsNamedIn(ctx, null), [])
})

test('contextTermsNamedIn treats a regex-special label as text, not a pattern', () => {
  // Labels like "5-HT1A" and "GAL4 (attP2)" reach a RegExp constructor. Unescaped,
  // one of these throws and takes the whole turn down; worse, "." would match any
  // character and adopt an entity the user never named.
  const ctx = sanitizeContext({
    v: CONTEXT_VERSION,
    terms: [{ name: 'GAL4 (attP2)', label: 'GAL4 (attP2)', id: 'FBtp_00000001', queries: [] }],
    registry: []
  })
  assert.doesNotThrow(() => contextTermsNamedIn(ctx, 'what does GAL4 (attP2) label?'))
  assert.equal(contextTermsNamedIn(ctx, 'what does GAL4 (attP2) label?')[0]?.id, 'FBtp_00000001')
  assert.deepEqual(contextTermsNamedIn(ctx, 'what does GAL4 XXattP2Y label?'), [])
})

// --- which queries the conversation ran ------------------------------------
// Counts deliberately do not travel: a count is a fact with an age. "We ran this
// query" has no age, and it is what lets a later turn hand back the working for a
// result an earlier turn produced.

test('a query the turn ran is marked ran; one it merely could run is not', () => {
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.terms = { medulla: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [
    { query_type: 'NeuronsPartHere', label: 'Neurons with part here', count: 471 },
    { query_type: 'ImagesNeurons', label: 'Images', count: 12 }
  ] } } }
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'NeuronsPartHere' } }]
  const ctx = buildTurnContext(ledger)
  const qs = Object.fromEntries(ctx.terms[0].queries.map(q => [q.query_type, q.ran]))
  assert.equal(qs.NeuronsPartHere, true)
  assert.equal(qs.ImagesNeurons, false)
})

test('a query the turn ran that the digest never advertised is kept anyway', () => {
  // We just ran it, which is the strongest evidence it works for this term.
  const ledger = createLedger()
  recordTermId(ledger, 'medulla', 'FBbt_00003748', { canonical: true })
  ledger.terms = { medulla: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [] } } }
  ledger.plan = [{ id: 's1', tool: 'vfb_run_query', status: 'satisfied',
    args: { id: 'FBbt_00003748', query_type: 'SubclassesOf' } }]
  const ctx = buildTurnContext(ledger)
  assert.deepEqual(ctx.terms[0].queries.map(q => [q.query_type, q.ran]), [['SubclassesOf', true]])
})

test('a later turn does not forget what an earlier turn ran', () => {
  // The failure this prevents: turn 2 re-resolves the term through term-info, the
  // fresh catalogue overwrites the carried one, and the reproduction for "how
  // would I get that same result in Python?" loses every call it had.
  const prev = { v: 1, registry: [], terms: [{ name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
    queries: [{ query_type: 'NeuronsPartHere', label: '', count: 471, countKind: 'exact', ran: true }] }] }
  const turn = { v: 1, registry: [], terms: [{ name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
    queries: [{ query_type: 'NeuronsPartHere', label: 'Neurons with part here', count: 471, countKind: 'exact', ran: false },
              { query_type: 'ImagesNeurons', label: 'Images', count: 12, countKind: 'exact', ran: false }] }] }
  const merged = mergeContext(prev, turn)
  const qs = Object.fromEntries(merged.terms[0].queries.map(q => [q.query_type, q.ran]))
  assert.equal(qs.NeuronsPartHere, true, 'still ran, however many turns ago')
  assert.equal(qs.ImagesNeurons, false)
  assert.equal(merged.terms[0].queries.find(q => q.query_type === 'NeuronsPartHere').label,
    'Neurons with part here', 'the fresher catalogue still wins on everything else')
})

test('a ran query dropped from the fresher catalogue is carried back in', () => {
  const prev = { v: 1, registry: [], terms: [{ name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
    queries: [{ query_type: 'SubclassesOf', label: '', count: -1, countKind: 'unknown', ran: true }] }] }
  const turn = { v: 1, registry: [], terms: [{ name: 'medulla', label: 'medulla', id: 'FBbt_00003748',
    queries: [{ query_type: 'ImagesNeurons', label: 'Images', count: 12, countKind: 'exact', ran: false }] }] }
  const merged = mergeContext(prev, turn)
  assert.ok(merged.terms[0].queries.some(q => q.query_type === 'SubclassesOf' && q.ran))
})

test('ran is a boolean, never whatever the client sent', () => {
  // It becomes a line of code we tell the user reproduces their answer.
  const dirty = { v: 1, registry: [], terms: [{ name: 'm', label: 'm', id: 'FBbt_00003748',
    queries: [{ query_type: 'SubclassesOf', ran: 'yes' }, { query_type: 'PartsOf', ran: 1 }] }] }
  const clean = sanitizeContext(dirty)
  assert.deepEqual(clean.terms[0].queries.map(q => q.ran), [false, false])
})
