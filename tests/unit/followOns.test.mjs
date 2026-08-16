// Tests for follow-on suggestion + provenance generation.
// Run: node --test tests/unit/followOns.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFollowOns, vfbReportUrl, stripMarkdown, buildTermLinks, linkifyKnownTerms, buildCountLinks, linkifyCounts } from '../../lib/followOns.mjs'
import { createLedger, recordTermId } from '../../lib/ledger.mjs'

function ledgerWith(term) {
  return { terms: { [term.name]: term } }
}

test('buildFollowOns surfaces documentation evidence pages as sources (with the page title)', () => {
  const ledger = {
    terms: {},
    evidence: [
      { source: 'doc', claim: 'NeuroFly 2026 is 7-11 Sept in Cologne', verbatim: '…', locator: { url: 'https://www.virtualflybrain.org/blog/2025/12/17/neurofly-2026', title: 'NeuroFly 2026: 21st Biennial European Drosophila Neurobiology Conference' } },
      { source: 'doc', claim: 'dup', verbatim: '', locator: { url: 'https://www.virtualflybrain.org/blog/2025/12/17/neurofly-2026', title: 'dup' } }
    ]
  }
  const { sources } = buildFollowOns(ledger)
  assert.equal(sources.length, 1)   // de-duplicated by url
  assert.match(sources[0].label, /NeuroFly 2026/)
  assert.equal(sources[0].url, 'https://www.virtualflybrain.org/blog/2025/12/17/neurofly-2026')
  assert.equal(sources[0].id, null) // doc sources carry no VFB id
})

test('buildFollowOns falls back to a readable label from the URL when a doc has no title', () => {
  const ledger = { terms: {}, evidence: [{ source: 'doc', claim: 'x', verbatim: '', locator: { url: 'https://vfb-connect.readthedocs.io/en/stable/installation-guide' } }] }
  const { sources } = buildFollowOns(ledger)
  assert.equal(sources[0].label, 'installation guide')
})

test('vfbReportUrl builds a VFB report link', () => {
  assert.equal(vfbReportUrl('FBbt_00005801'), 'https://www.virtualflybrain.org/reports/FBbt_00005801')
  assert.equal(vfbReportUrl(''), '')
})

test('buildFollowOns derives ask chips from real queries + an open-in-VFB chip + a source', () => {
  const ledger = ledgerWith({
    name: 'mushroom body', id: 'FBbt_00005801', label: 'mushroom body',
    digest: { name: 'mushroom body', queries: [
      { query_type: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in mushroom body', count: 367, examples: [] },
      { query_type: 'SubclassesOf', label: 'Subclasses', count: 2, examples: [] },
      { query_type: 'ListAllAvailableImages', label: 'Images', count: 0, examples: [] }
    ] }
  })
  const { terms, chips, sources } = buildFollowOns(ledger)
  assert.equal(terms.length, 1)
  assert.equal(terms[0].name, 'mushroom body')
  assert.equal(terms[0].id, 'FBbt_00005801')
  assert.equal(terms[0].label, 'mushroom body')
  // source links to the term report (provenance for "(vfb)"), tagged with what
  // is on the other side of the link so the Sources line can word its hover text
  assert.deepEqual(sources, [{
    kind: 'vfb',
    label: 'mushroom body',
    url: 'https://www.virtualflybrain.org/reports/FBbt_00005801',
    id: 'FBbt_00005801',
    superseded: null,
    title: 'Open mushroom body term info in Virtual Fly Brain (new tab)'
  }])
  // ask chip from the highest-count query, with a clear title and a runnable query
  const ask = chips.find(c => c.kind === 'ask')
  assert.match(ask.query, /input to the mushroom body/)
  assert.match(ask.label, /\(367\)$/)
  assert.match(ask.title, /^Ask VFB:/)
  // open-in-VFB chip with a "new tab" title
  const vfb = chips.find(c => c.kind === 'vfb')
  assert.equal(vfb.url, 'https://www.virtualflybrain.org/reports/FBbt_00005801')
  assert.match(vfb.title, /new tab/)
  // zero-count query (Images) produced no ask chip
  assert.ok(!chips.some(c => c.kind === 'ask' && /image/i.test(c.query || '')))
})

test('buildFollowOns carries a superseded note from a deprecated->replacement redirect', () => {
  const ledger = ledgerWith({
    name: 'adult lateral horn', id: 'FBbt_00007053', label: 'adult lateral horn',
    digest: { name: 'adult lateral horn', queries: [] },
    superseded: { fromId: 'FBbt_00099999', fromLabel: 'old lateral horn' }
  })
  const { terms, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms[0].superseded, { fromId: 'FBbt_00099999', fromLabel: 'old lateral horn' })
  assert.deepEqual(sources[0].superseded, { fromId: 'FBbt_00099999', fromLabel: 'old lateral horn' })
})

test('stripMarkdown turns "[label](url)" into plain "label"', () => {
  assert.equal(stripMarkdown('[medulla](https://x/FBbt_00003748)'), 'medulla')
  assert.equal(stripMarkdown('plain'), 'plain')
})

test('chip text is clean even when the resolved term label is markdown', () => {
  const ledger = { terms: { '[medulla](https://x/FBbt_00003748)': {
    id: 'FBbt_00003748', label: '[medulla](https://x/FBbt_00003748)',
    digest: { name: 'medulla', queries: [{ query_type: 'NeuronsPartHere', label: 'x', count: 5, examples: [] }] }
  } } }
  const { chips } = buildFollowOns(ledger)
  const ask = chips.find(c => c.kind === 'ask')
  assert.ok(!/\[|\]\(/.test(ask.label), `chip label must be markdown-free: ${ask.label}`)
  assert.match(ask.query, /in the medulla\?/)
})

test('buildTermLinks collects resolved terms + example neurons (longest first)', () => {
  const ledger = { terms: { medulla: {
    id: 'FBbt_00003748', digest: { name: 'medulla', queries: [
      { query_type: 'NeuronsPartHere', label: 'x', count: 2, examples: ['ML-VPN2', 'Mti'],
        exampleEntities: [{ label: 'ML-VPN2', id: 'FBbt_00100001' }, { label: 'Mti', id: 'FBbt_00100002' }] }
    ] }
  } } }
  const links = buildTermLinks(ledger)
  const names = links.map(l => l.name)
  assert.ok(names.includes('medulla') && names.includes('ML-VPN2') && names.includes('Mti'))
  // longest-first so multi-token names win during replacement
  assert.ok(links[0].name.length >= links[links.length - 1].name.length)
  assert.equal(links.find(l => l.name === 'ML-VPN2').url, 'https://www.virtualflybrain.org/reports/FBbt_00100001')
})

test('linkifyKnownTerms links each term once, with a tooltip, leaving existing links/code alone', () => {
  const links = [
    { name: 'ML-VPN2', id: 'FBbt_00100001', url: 'https://www.virtualflybrain.org/reports/FBbt_00100001' },
    { name: 'medulla', id: 'FBbt_00003748', url: 'https://www.virtualflybrain.org/reports/FBbt_00003748' }
  ]
  const out = linkifyKnownTerms('The medulla contains ML-VPN2; see [medulla](http://keep.me) and `medulla` code.', links)
  // first plain "medulla" linked with a title tooltip
  assert.match(out, /\[medulla\]\(https:\/\/www\.virtualflybrain\.org\/reports\/FBbt_00003748 "Open medulla in Virtual Fly Brain"\)/)
  // ML-VPN2 linked
  assert.match(out, /\[ML-VPN2\]\(https:\/\/www\.virtualflybrain\.org\/reports\/FBbt_00100001/)
  // the pre-existing [medulla](http://keep.me) link is untouched
  assert.match(out, /\[medulla\]\(http:\/\/keep\.me\)/)
  // the `medulla` code span is untouched
  assert.match(out, /`medulla`/)
  // medulla linked only once (the first plain occurrence)
  assert.equal((out.match(/reports\/FBbt_00003748/g) || []).length, 1)
})

test('buildTermLinks uses the authoritative registry, never pins a label to the wrong id', () => {
  // Registry holds VFB's own labels: "mushroom body" -> region; the MBON term's
  // VFB Name is "mushroom body output neuron". A label must map to ITS id only.
  const ledger = createLedger('q')
  recordTermId(ledger, 'mushroom body', 'FBbt_00005801', { canonical: true })
  ledger.terms = { 'mushroom body output neurons': { id: 'FBbt_00047953', digest: { name: 'mushroom body output neuron', queries: [] } } }
  const links = buildTermLinks(ledger)
  const mb = links.find(l => l.name.toLowerCase() === 'mushroom body')
  const mbon = links.find(l => l.name.toLowerCase() === 'mushroom body output neuron')
  assert.equal(mb.id, 'FBbt_00005801', 'mushroom body must map to the region, not the MBON')
  assert.equal(mbon.id, 'FBbt_00047953')
  // there is NO "mushroom body" -> MBON entry
  assert.ok(!links.some(l => l.name.toLowerCase() === 'mushroom body' && l.id === 'FBbt_00047953'))
})

test('buildCountLinks + linkifyCounts turn quoted counts into VFB query links', () => {
  const ledger = { terms: { medulla: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [
    { query_type: 'ImagesNeurons', label: 'Images of neurons with some part in medulla', count: 226524, examples: [] },
    { query_type: 'NeuronsPartHere', label: 'Neurons with some part in medulla', count: 471, examples: [] }
  ] } } } }
  const counts = buildCountLinks(ledger)
  assert.equal(counts[0].count, 226524) // largest first
  // query links RUN the query in the v2 browser and carry a quote-free title
  assert.equal(counts[0].url, 'https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=FBbt_00003748,ImagesNeurons')
  assert.ok(!/"/.test(counts[0].title), 'title must not contain double quotes')
  const out = linkifyCounts('There are 226,524 images and 471 neurons; also 999 unrelated.', counts)
  assert.match(out, /\[226,524\]\(https:\/\/v2\.virtualflybrain\.org\/org\.geppetto\.frontend\/geppetto\?q=FBbt_00003748,ImagesNeurons "Run in VFB: [^"]*"\)/)
  assert.match(out, /\[471\]\(/)
  // a number that is not a known count is left alone
  assert.match(out, /also 999 unrelated/)
  assert.ok(!/\[999\]/.test(out))
})

test('linkifyCounts leaves counts inside existing links/code alone and links each once', () => {
  const counts = [{ count: 471, url: 'https://x/FBbt_1', title: 'View x in VFB' }]
  const out = linkifyCounts('See [471](http://keep) and `471` and 471 plus 471 again.', counts)
  assert.match(out, /\[471\]\(http:\/\/keep\)/)   // untouched
  assert.match(out, /`471`/)                        // untouched
  assert.equal((out.match(/FBbt_1/g) || []).length, 1) // linked once only
})

test('unresolved terms (no id) produce nothing', () => {
  const ledger = ledgerWith({ name: 'wibble', id: null })
  const { terms, chips, sources } = buildFollowOns(ledger)
  assert.deepEqual(terms, [])
  assert.deepEqual(chips, [])
  assert.deepEqual(sources, [])
})

// --- a chip carries the address it was built from --------------------------

test('an ask chip carries the id and query_type it was generated from', () => {
  // The medulla regression, at its origin. This chip is built deterministically
  // from a specific term's id and a specific query in that term's own catalogue;
  // emitting only the English sentence meant clicking it posted a question the
  // next turn had to re-derive both facts from, by lexical search, from scratch.
  const ledger = ledgerWith({
    name: 'medulla', id: 'FBbt_00003748', label: 'medulla',
    digest: { name: 'medulla', queries: [
      { query_type: 'NeuronsPostsynapticHere', label: 'Neurons with postsynaptic terminals in medulla', count: 333, examples: [] }
    ] }
  })
  const ask = buildFollowOns(ledger).chips.find(c => c.kind === 'ask')
  assert.match(ask.query, /Which neurons receive output from the medulla\?/)
  assert.equal(ask.id, 'FBbt_00003748', 'the chip must carry the id it was built from')
  assert.equal(ask.query_type, 'NeuronsPostsynapticHere', 'and the query that answers it')
})

// --- the bare-numeral guard ------------------------------------------------

test('linkifyCounts does not claim an anatomical layer number', () => {
  // Robbie's live trace: an answer describing the medulla's ten layers wrote
  // "layer 7", and a query whose count happened to be 7 linked it — offering the
  // reader "Run in VFB: Lineage clones in the medulla" on an anatomy number.
  const ledger = { terms: { medulla: { id: 'FBbt_00003748', digest: { name: 'medulla', queries: [
    { query_type: 'LineageClonesIn', label: 'Lineage clones in medulla', count: 7, examples: [] }
  ] } } } }
  const counts = buildCountLinks(ledger)
  const out = linkifyCounts('The medulla has ten layers, and layer 7 receives input from Tm neurons.', counts)
  assert.equal(out, 'The medulla has ten layers, and layer 7 receives input from Tm neurons.')
})

test('the designator veto holds at every magnitude', () => {
  const counts = [{ count: 4130, url: 'https://x/q', title: 'Run in VFB: Images', label: 'Images of medulla', noun: 'images' }]
  assert.match(linkifyCounts('VFB holds 4130 images.', counts), /\[4130\]/)
  assert.equal(linkifyCounts('See figure 4130 for details.', counts), 'See figure 4130 for details.')
  assert.equal(linkifyCounts('Cluster 4130 is distinct.', counts), 'Cluster 4130 is distinct.')
})

test('a small figure is linked only when the prose corroborates what is counted', () => {
  const counts = [{ count: 28, url: 'https://x/q', title: 'Run in VFB: t', label: 'Neuron types with some part in medulla', noun: 'neuron types' }]
  // Corroborated: the figure is followed by the query's own vocabulary.
  assert.match(linkifyCounts('There are 28 neuron types with a part here.', counts), /\[28\]/)
  // Bare: nothing says this 28 is a quantity of neuron types.
  assert.equal(linkifyCounts('It is subdivided into 28 and further.', counts),
    'It is subdivided into 28 and further.')
})

test('a large figure needs no corroboration', () => {
  const counts = [{ count: 2342, url: 'https://x/q', title: 'Run in VFB: t', label: 'Images of medulla', noun: 'images' }]
  assert.match(linkifyCounts('VFB holds 2342 of these.', counts), /\[2342\]/)
})

// --- a follow-on is an offer of something new ---

const MEDULLA_TERM = {
  name: 'medulla', id: 'FBbt_00003748',
  digest: { name: 'medulla', queries: [
    { query_type: 'NeuronsPostsynapticHere', label: 'Neurons with postsynaptic terminals here', count: 333 },
    { query_type: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals here', count: 262 },
    { query_type: 'PartsOf', label: 'Parts', count: 28 }
  ] }
}

test('buildFollowOns does not offer back the query this turn just ran', () => {
  // The live medulla trace ended with "Which neurons receive output from the
  // medulla?" offered as a next step, directly beneath the answer to exactly that
  // question — the chip promised data the reader had just been given.
  const ledger = {
    terms: { medulla: MEDULLA_TERM },
    plan: [{ id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_00003748', query_type: 'NeuronsPostsynapticHere' }, status: 'satisfied' }]
  }
  const { chips } = buildFollowOns(ledger)
  const asked = chips.filter(c => c.kind === 'ask')
  assert.ok(!asked.some(c => c.query_type === 'NeuronsPostsynapticHere'), 'the answered query came back as a suggestion')
  // …and the space it freed goes to a query the reader has not seen.
  assert.deepEqual(asked.map(c => c.query_type), ['NeuronsPresynapticHere', 'PartsOf'])
})

test('suppression is per term, not per query type', () => {
  // Two regions in one answer routinely share a query_type. Muting by bare type
  // would silently drop the second region's genuinely unasked chip.
  const lobula = { ...MEDULLA_TERM, name: 'lobula', id: 'FBbt_00003852', digest: { name: 'lobula', queries: MEDULLA_TERM.digest.queries } }
  const ledger = {
    terms: { medulla: MEDULLA_TERM, lobula },
    plan: [{ id: 's1', tool: 'vfb_run_query', args: { id: 'FBbt_00003748', query_type: 'NeuronsPostsynapticHere' }, status: 'satisfied' }]
  }
  const asked = buildFollowOns(ledger).chips.filter(c => c.kind === 'ask')
  assert.ok(!asked.some(c => c.id === 'FBbt_00003748' && c.query_type === 'NeuronsPostsynapticHere'))
  assert.ok(asked.some(c => c.id === 'FBbt_00003852' && c.query_type === 'NeuronsPostsynapticHere'),
    'the lobula was never asked about — its chip must survive')
})

test('a planned query with no id suppresses nothing', () => {
  // `::type` steps exist (a planner step naming a query with no target). They must
  // not mute a chip for a term they may not even be about.
  const ledger = {
    terms: { medulla: MEDULLA_TERM },
    plan: [{ id: 's1', tool: 'vfb_run_query', args: { query_type: 'NeuronsPostsynapticHere' }, status: 'satisfied' }]
  }
  const asked = buildFollowOns(ledger).chips.filter(c => c.kind === 'ask')
  assert.ok(asked.some(c => c.query_type === 'NeuronsPostsynapticHere'))
})

// --- chip vocabulary: every query type VFB offers can become a follow-on -----

test('a query type with no hand-written template is offered in VFB\'s own words, not dropped', () => {
  // The real DA1_lPN catalogue. Before this, the 107-match NBLAST query was the
  // only one of the three with a template and the other two produced nothing —
  // a neuron page advertising 484 connected neurons offered the user no way to
  // see them.
  const ledger = ledgerWith({
    name: 'DA1_lPN_R', id: 'VFB_00000001', label: 'DA1_lPN_R',
    digest: { name: 'DA1_lPN_R', queries: [
      { query_type: 'SimilarMorphologyTo', label: 'Neurons with similar morphology to DA1_lPN_R [NBLAST]', count: 107, examples: [] },
      { query_type: 'SimilarMorphologyToNB', label: 'Expression patterns matching DA1_lPN_R [NeuronBridge]', count: 16, examples: [] }
    ] }
  })
  const chips = buildFollowOns(ledger).chips.filter(c => c.kind === 'ask')
  const nb = chips.find(c => c.query_type === 'SimilarMorphologyToNB')
  assert.ok(nb, 'the untemplated query type must still be offered')
  // Quoted from VFB, not invented: this codebase and VFB\'s own catalogue
  // disagree about whether this query returns neurons or expression patterns,
  // so the chip says what VFB says.
  assert.equal(nb.query, 'Show me: Expression patterns matching DA1_lPN_R (NeuronBridge)')
  // ...and it still carries the address, which is what actually runs.
  assert.equal(nb.id, 'VFB_00000001')
  assert.equal(nb.label, 'Show me: Expression patterns matching DA1_lPN_R (NeuronBridge) (16)')
})

test('a templated type is phrased as a question, and beats a quoted label at the same count', () => {
  const ledger = ledgerWith({
    name: 'medulla', id: 'FBbt_00003748', label: 'medulla',
    digest: { name: 'medulla', queries: [
      { query_type: 'SimilarMorphologyToNB', label: 'Expression patterns matching medulla', count: 5, examples: [] },
      { query_type: 'TractsNervesInnervatingHere', label: 'Tracts', count: 5, examples: [] }
    ] }
  })
  const chips = buildFollowOns(ledger).chips.filter(c => c.kind === 'ask')
  assert.equal(chips[0].query, 'Which tracts and nerves innervate the medulla?')
})

test('a term never fills its whole chip list with quoted labels', () => {
  const many = ['SimilarMorphologyToNB', 'SimilarMorphologyToNBexp', 'SimilarMorphologyToPartOf', 'ref_neuron_neuron_connectivity_query']
    .map((qt, i) => ({ query_type: qt, label: `Some VFB query ${i}`, count: 900 - i, examples: [] }))
  const ledger = ledgerWith({
    name: 'x', id: 'VFB_00000002', label: 'x',
    digest: { name: 'x', queries: [...many, { query_type: 'PartsOf', label: 'Parts', count: 3, examples: [] }] }
  })
  const chips = buildFollowOns(ledger).chips.filter(c => c.kind === 'ask')
  assert.equal(chips.filter(c => c.query.startsWith('Show me:')).length, 2)
  // and the templated one still gets in, despite being the smallest
  assert.ok(chips.some(c => c.query === 'What are the anatomical parts of the x?'))
})

test('a query VFB gave no label and this file cannot phrase is offered as nothing at all', () => {
  const ledger = ledgerWith({
    name: 'x', id: 'VFB_00000003', label: 'x',
    digest: { name: 'x', queries: [{ query_type: 'SomethingBrandNew', label: '', count: 12, examples: [] }] }
  })
  assert.deepEqual(buildFollowOns(ledger).chips.filter(c => c.kind === 'ask'), [])
})
