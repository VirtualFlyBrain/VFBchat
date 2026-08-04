// Offline end-to-end tests for the role-loop orchestrator, with mocked ELM/MCP.
// Run: node --test tests/unit/orchestrator_run.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHarness, pickBestTermId, maybeInjectConnectivityStep, maybeInjectRegionNeuronCountStep, maybeInjectRegionGraphStep, maybeInjectScrnaseqStep } from '../../lib/orchestrator.mjs'

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'vfb_query_connectivity', purpose: 'class connectivity', parameters: { type: 'object', required: ['upstream_type', 'downstream_type'], properties: { upstream_type: { type: 'string' }, downstream_type: { type: 'string' } } } },
  { name: 'vfb_get_neurotransmitter_profile', purpose: 'NT profile', parameters: { type: 'object', required: ['neuron_type'], properties: { neuron_type: { type: 'string' } } } },
  { name: 'search_pubmed', purpose: 'pubmed', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'get_pubmed_article', purpose: 'pubmed article', parameters: { type: 'object', required: ['pmid'], properties: { pmid: { type: 'string' } } } }
]

// Configurable mock deps. structuredByName routes callStructured by schemaName.
function makeDeps({ plan, structured = {}, tools = {}, text = 'FINAL ANSWER' } = {}) {
  const calls = { structured: [], tools: [], text: 0 }
  return {
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 8,
    calls,
    async callStructured({ schemaName, messages }) {
      calls.structured.push(schemaName)
      if (schemaName === 'plan') return { ok: true, value: plan }
      if (schemaName === 'extract') return structured.extract ? structured.extract(messages) : { ok: true, value: { relevant: true, answered: true, claim: 'extracted', verbatim: 'q' } }
      // tool-arg repair (schemaName ends with _args)
      if (schemaName && schemaName.endsWith('_args')) {
        const tool = schemaName.replace(/_args$/, '')
        return structured.repair ? structured.repair(tool) : { ok: true, value: defaultArgs(tool) }
      }
      return { ok: false }
    },
    async callText() { calls.text++; return text },
    async runTool(name, args) {
      calls.tools.push({ name, args })
      if (tools[name]) return tools[name](args)
      if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00003932', label: args.query }] } }
      if (name === 'vfb_get_term_info') return { Name: 'x', Publications: [] }
      return { ok: true, result: `${name} result` }
    }
  }
}
function defaultArgs(tool) {
  if (tool === 'vfb_query_connectivity') return { upstream_type: 'FBbt_1', downstream_type: 'FBbt_2' }
  if (tool === 'vfb_search_terms') return { query: 'mushroom body' }
  if (tool === 'vfb_get_neurotransmitter_profile') return { neuron_type: 'Kenyon cell' }
  return {}
}

test('resolveTerms: a bare VFB/FBbt id is fetched directly, skipping the lexical search', async () => {
  // The planner handed us the actual id (e.g. user typed "VFB_00200000"); the
  // resolver must call get_term_info on it directly, never route it through
  // vfb_search_terms (which can miss a short_form and wrongly abstain).
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['VFB_00200000'],
    steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['what is VFB_00200000'] }]
  }
  const deps = makeDeps({ plan, tools: {
    vfb_get_term_info: (a) => ({ Id: a.id, Name: 'JRC2018UnisexVNC', Meta: { Description: 'VNC template' }, Publications: [] })
  } })
  const r = await runHarness('What is VFB_00200000?', deps)
  assert.equal(r.ledger.terms['VFB_00200000'].id, 'VFB_00200000')
  assert.ok(!deps.calls.tools.some(t => t.name === 'vfb_search_terms'), 'must not run lexical search for a bare id')
  assert.ok(deps.calls.tools.some(t => t.name === 'vfb_get_term_info' && t.args.id === 'VFB_00200000'), 'must fetch the id directly')
})

test('parallel doc-search: a relevant reviewed-docs hit is folded into the answer for any question', async () => {
  // VFB has no events/news data; the parallel reviewed-docs search must surface a
  // relevant blog/conference hit and feed it to the synthesiser, even though no
  // documentation keyword routed there.
  const plan = {
    intent: 'other', underspecified: false, clarifying_question: '',
    terms_to_resolve: [], steps: []
  }
  const deps = makeDeps({ plan, structured: {
    extract: () => ({ ok: true, value: { relevant: true, answered: true, claim: 'NeuroFly 2026 is 7-11 September in Cologne', verbatim: '7-11 September 2026, University of Cologne' } })
  }, tools: {
    search_reviewed_docs: () => ({ results: [{ id: 'vfb-neurofly-2026', title: 'NeuroFly 2026: 21st Biennial European Drosophila Neurobiology Conference', url: 'https://www.virtualflybrain.org/blog/2025/12/17/neurofly-2026' }] }),
    get_reviewed_page: () => 'NeuroFly 2026 will be held 7-11 September 2026 at the University of Cologne.'
  } })
  const r = await runHarness('When and where is NeuroFly 2026?', deps)
  assert.ok(deps.calls.tools.some(t => t.name === 'search_reviewed_docs'), 'doc search ran')
  assert.ok(deps.calls.tools.some(t => t.name === 'get_reviewed_page'), 'relevant hit was fetched')
  assert.ok(r.ledger.evidence.some(e => e.source === 'doc'), 'doc evidence added for synthesis')
})

test('parallel doc-search: an irrelevant hit is NOT fetched (no per-query page cost)', async () => {
  const plan = { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['medulla'], steps: [] }
  const deps = makeDeps({ plan, tools: {
    // doc index returns something unrelated to "medulla" — must be skipped before fetch
    search_reviewed_docs: () => ({ results: [{ id: 'x', title: 'How to install vfb-connect in Python', url: 'https://vfb-connect.readthedocs.io/install' }] })
  } })
  await runHarness('What is the medulla?', deps)
  assert.ok(deps.calls.tools.some(t => t.name === 'search_reviewed_docs'), 'doc search still runs in parallel')
  assert.ok(!deps.calls.tools.some(t => t.name === 'get_reviewed_page'), 'irrelevant page not fetched')
})

test('end-to-end connectivity: plan → resolve → step → evidence → synthesise', async () => {
  const plan = {
    intent: 'connectivity', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['DA1 glomerulus', 'lateral horn'],
    steps: [{ id: 's1', tool: 'vfb_query_connectivity', answers: ['which neurons connect DA1 to LH'] }]
  }
  const deps = makeDeps({ plan })
  const r = await runHarness('What connects DA1 glomerulus to the lateral horn?', deps)

  assert.equal(r.answer, 'FINAL ANSWER')
  assert.equal(r.complete, true)
  assert.equal(r.ledger.plan[0].status, 'satisfied')
  assert.equal(r.ledger.evidence[0].source, 'vfb')
  // both terms resolved
  assert.equal(r.ledger.terms['DA1 glomerulus'].id, 'FBbt_00003932')
  // planner + repair + extract structured calls happened; synth text call once
  assert.ok(deps.calls.structured.includes('plan'))
  assert.ok(deps.calls.structured.includes('extract'))
  assert.equal(deps.calls.text, 1)
})

test('underspecified plan returns a clarifying question, no tools run', async () => {
  const plan = { intent: 'other', underspecified: true, clarifying_question: 'Which dataset?', terms_to_resolve: [], steps: [] }
  const deps = makeDeps({ plan })
  const r = await runHarness('compare connectivity', deps)
  assert.equal(r.clarify, true)
  assert.equal(r.answer, 'Which dataset?')
  assert.equal(deps.calls.tools.length, 0)
})

test('VFB-empty function question → literature fallback adds literature evidence', async () => {
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['PPL1'],
    steps: [{ id: 's1', tool: 'vfb_get_neurotransmitter_profile', answers: ['function of PPL1'] }]
  }
  const deps = makeDeps({
    plan,
    structured: {
      // VFB extract fails to answer (no data); literature extract answers.
      extract: (messages) => {
        const isLit = /PAPER \(/.test(messages[1].content)
        if (isLit) return { ok: true, value: { relevant: true, answered: true, claim: 'PPL1 drives aversive memory', verbatim: 'aversive memory' } }
        return { ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } }
      }
    },
    tools: {
      // term has a publication so literature ref is available
      vfb_get_term_info: () => ({ Publications: [{ microref: 'Aso 2010', PubMed: '20637624', DOI: '', FlyBase: '' }] }),
      vfb_get_neurotransmitter_profile: () => ({ error: 'no data' }),
      get_pubmed_article: () => ({ title: 'aversive memory', abstract: 'PPL1 ...' })
    }
  })
  const r = await runHarness('What is the function of PPL1?', deps)
  const sources = r.ledger.evidence.map(e => e.source)
  assert.ok(sources.includes('literature'), `expected literature evidence, got ${JSON.stringify(sources)}`)
  assert.ok(r.ledger.plan[0].status === 'not_found') // VFB step exhausted
  assert.ok(deps.calls.tools.some(t => t.name === 'get_pubmed_article'))
})

test('term-info Description/Relationships answers function → no literature', async () => {
  const PPL1_DESC = 'A dopaminergic neuron whose cell body is located in a cluster of approximately 12 cell bodies in the cortex of the posterior inferior lateral protocerebrum of the adult brain, immediately lateral to the mushroom body calyx. Members project to various parts of the mushroom body (Mao and Davis, 2009).'
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['PPL1'],
    steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['function/anatomy of PPL1'] }]
  }
  const deps = makeDeps({
    plan,
    structured: {
      // any VFB extract (not a paper) answers from the Description
      extract: (messages) => /PAPER \(/.test(messages[1].content)
        ? { ok: true, value: { relevant: true, answered: true, claim: 'paper claim', verbatim: 'x' } }
        : { ok: true, value: { relevant: true, answered: true, claim: 'PPL1 is a dopaminergic MB neuron', verbatim: 'dopaminergic neuron' } },
      repair: (tool) => ({ ok: true, value: tool === 'vfb_get_term_info' ? { id: 'FBbt_00047509' } : {} })
    },
    tools: {
      vfb_get_term_info: () => ({ Meta: { Description: PPL1_DESC, Relationships: ['capable of: dopaminergic signalling'] }, Publications: [{ PubMed: '19although', microref: 'Mao 2009' }] })
    }
  })
  const r = await runHarness('What is the function of PPL1?', deps)
  const sources = r.ledger.evidence.map(e => e.source)
  assert.ok(sources.includes('vfb'), 'should have VFB evidence from term-info')
  assert.ok(!sources.includes('literature'), 'must NOT escalate to literature when VFB answered')
  assert.ok(!deps.calls.tools.some(t => t.name === 'get_pubmed_article'), 'no paper fetch')
})

test('large result: question-aware map-reduce finds an answer past the first chunk', async () => {
  // Result is > MAX_EXTRACT_CHARS; the answer sits after ~7000 chars of padding,
  // so a blind first-chunk truncation would miss it. The map step must read each
  // chunk given the question and still find it.
  const bigResult = { padding: 'x'.repeat(7000), tail: 'ANSWER_MARKER the medulla has 10 layers M1-M10' }
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: [],
    steps: [{ id: 's1', tool: 'vfb_query_connectivity', answers: ['how many medulla layers'] }]
  }
  const deps = makeDeps({
    plan,
    structured: {
      // extractor only "answers" for the chunk that actually contains the marker
      extract: (messages) => /ANSWER_MARKER/.test(messages[1].content)
        ? { ok: true, value: { relevant: true, answered: true, claim: 'medulla has 10 layers', verbatim: 'M1-M10' } }
        : { ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } }
    },
    tools: { vfb_query_connectivity: () => bigResult }
  })
  const r = await runHarness('How many layers does the medulla have?', deps)
  assert.equal(r.ledger.plan[0].status, 'satisfied', 'late-chunk answer should satisfy the step')
  assert.ok(r.ledger.evidence.some(e => /10 layers/.test(e.claim)))
  // proves more than one extract call happened (chunked)
  assert.ok(deps.calls.structured.filter(s => s === 'extract').length >= 2)
})

test('fast-path definitional question skips the planner call', async () => {
  const deps = makeDeps({ plan: null })
  const r = await runHarness('What is the mushroom body?', deps)
  assert.ok(!deps.calls.structured.includes('plan')) // no planner LLM call
  assert.equal(r.answer, 'FINAL ANSWER')
  assert.ok(deps.calls.tools.some(t => t.name === 'vfb_search_terms'))
})

test('count question: auto-runs the individual-image query and reports the count deterministically', async () => {
  // The exact failing case (deliberate "medualla" typo). The digest offers both
  // ImagesNeurons (images, count -1) and PartsOf (class, 28). The chat must run
  // ImagesNeurons and state its count — never PartsOf, never "you can run it".
  const termInfo = {
    Name: 'medulla', Id: 'FBbt_00003748',
    SuperTypes: ['Class', 'Anatomy', 'Synaptic_neuropil'],
    Meta: { Name: '[medulla](FBbt_00003748)', Description: 'Optic-lobe neuropil.' },
    Queries: [
      { query: 'ImagesNeurons', label: 'Images of neurons with some part in medulla', count: -1, preview_results: { rows: [] } },
      { query: 'PartsOf', label: 'Parts of medulla', count: 28, preview_results: { rows: [] } }
    ],
    Publications: []
  }
  const plan = { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['medulla'], steps: [] }
  const deps = makeDeps({
    plan,
    tools: {
      vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }),
      vfb_get_term_info: () => termInfo,
      vfb_run_query: (a) => ({ count: a.query_type === 'ImagesNeurons' ? 226524 : 28, headers: {}, rows: [] })
    }
  })
  const r = await runHarness('how many images of neurons with a part in the medualla are available?', deps)
  const ran = deps.calls.tools.filter(t => t.name === 'vfb_run_query').map(t => t.args.query_type)
  assert.ok(ran.includes('ImagesNeurons'), `expected ImagesNeurons to run, ran: ${ran.join(',') || 'none'}`)
  assert.ok(!ran.includes('PartsOf'), 'must never run the class query PartsOf for an images question')
  const claims = r.ledger.evidence.map(e => e.claim).join(' | ')
  assert.match(claims, /226,524 images/)
})

test('list question: names the returned rows deterministically, never the extractor', async () => {
  // The exact failing case: "Which neurons are presynaptic in the medulla? List
  // them." ran NeuronsPresynapticHere, got a page of rows, and answered "Running
  // the query … would provide the list of neurons" — the weak extractor
  // describing the query instead of reading it. The rows must be read in code.
  //
  // Note every preview here is EMPTY with count -1: that is medulla's real
  // term-info shape, and it is why the result table was blank too.
  const termInfo = {
    Name: 'medulla', Id: 'FBbt_00003748',
    SuperTypes: ['Class', 'Anatomy', 'Synaptic_neuropil'],
    Meta: { Name: '[medulla](FBbt_00003748)', Description: 'Optic-lobe neuropil.' },
    Queries: [
      { query: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in medulla', count: -1, preview_results: { rows: [] } }
    ],
    Publications: []
  }
  const names = ['Dm8b', 'Mi1', 'Tm3', 'L1', 'T4a']
  const plan = { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['medulla'], steps: [] }
  const deps = makeDeps({
    plan,
    structured: {
      // If the extractor is ever consulted for this step, it produces the exact
      // useless answer we are fixing — so a passing test proves it was bypassed.
      extract: () => ({ ok: true, value: { relevant: true, answered: true, claim: 'Running the query would provide the list of neurons.', verbatim: '' } })
    },
    tools: {
      vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }),
      vfb_get_term_info: () => termInfo,
      vfb_run_query: () => ({
        count: 262, count_status: 'exact', headers: {},
        rows: names.map((n, i) => ({ id: `FBbt_0011006${i}`, label: `[${n}](FBbt_0011006${i})`, tags: 'Adult|Neuron' }))
      })
    }
  })
  const r = await runHarness('Which neurons are presynaptic in the medulla? List them.', deps)
  const ran = deps.calls.tools.filter(t => t.name === 'vfb_run_query').map(t => t.args.query_type)
  assert.deepEqual(ran, ['NeuronsPresynapticHere'], 'the list question must run exactly the presynaptic query')
  // Judge only the evidence the run_query step produced: other steps legitimately
  // go through the (here, deliberately useless) extractor.
  const fromQuery = r.ledger.evidence.filter(e => e.tool === 'vfb_run_query').map(e => e.claim)
  assert.equal(fromQuery.length, 1)
  const claim = fromQuery[0]
  assert.ok(!/would provide the list/.test(claim), `extractor answer leaked through: ${claim}`)
  assert.match(claim, /262 results/)
  for (const n of names) assert.ok(claim.includes(n), `expected ${n} to be named, got: ${claim}`)
  assert.match(claim, /Dm8b \(FBbt_00110060\)/, 'ids must be named alongside the labels')

  // …and the run must have been folded back into the digest, so the result table
  // has something to render for a query whose preview came back empty.
  const q = Object.values(r.ledger.terms).find(t => t.digest)?.digest.queries
    .find(x => x.query_type === 'NeuronsPresynapticHere')
  assert.ok(q, 'the query should still be in the digest')
  assert.equal(q.previewRows.length, names.length)
  assert.equal(q.countKind, 'exact')
  assert.equal(q.count, 262)
})

test('pickBestTermId prefers exact synonym/label over the first fuzzy hit', () => {
  // "DAN" must bind to dopaminergic neuron (which carries the synonym), not the
  // first fuzzy result (mushroom body) — the bug seen live.
  const search = { response: { docs: [
    { short_form: 'FBbt_00005801', label: 'mushroom body', synonym: ['corpora pedunculata'] },
    { short_form: 'FBbt_00049373', label: 'dopaminergic neuron', synonym: ['DAN'] }
  ] } }
  assert.equal(pickBestTermId(search, 'DAN'), 'FBbt_00049373')
  // exact label still wins
  assert.equal(pickBestTermId(search, 'mushroom body'), 'FBbt_00005801')
  // a query token that matches NO candidate returns null rather than a spurious
  // top hit — the guarded fallback prevents citing an unrelated term.
  assert.equal(pickBestTermId(search, 'zzz'), null)
  // a fuzzy query that still shares a real word resolves via the guarded fallback
  assert.equal(pickBestTermId(search, 'mushroom zzz'), 'FBbt_00005801')
})

test('pickBestTermId resolves a stage-prefixed region, not a containing-phrase neuron', () => {
  // "lateral horn" has no exact VFB label (they are stage-qualified). The neuron
  // is ranked first, but we must pick the region "adult lateral horn".
  const search = { response: { docs: [
    { short_form: 'FBbt_00110058', label: 'adult lateral horn Leucokinin neuron', synonym: [], facets_annotation: ['Anatomy', 'Neuron', 'Cell'] },
    { short_form: 'FBbt_00007647', label: 'cell body rind of adult lateral horn', synonym: ['rLH'], facets_annotation: ['Anatomy'] },
    { short_form: 'FBbt_00007053', label: 'adult lateral horn', synonym: ['LH'], facets_annotation: ['Anatomy', 'Synaptic_neuropil'] },
    { short_form: 'FBbt_00048293', label: 'adult lateral horn neuron', synonym: ['LHN'], facets_annotation: ['Anatomy', 'Neuron', 'Cell'] }
  ] } }
  // region: shortest label containing {lateral, horn}
  assert.equal(pickBestTermId(search, 'lateral horn'), 'FBbt_00007053')
  // PLURAL "lateral horn neurons" = the result set -> resolve the REGION (its
  // neuron query is surfaced via chips/tables), not a single neuron class
  assert.equal(pickBestTermId(search, 'lateral horn neurons'), 'FBbt_00007053')
  // SINGULAR "lateral horn neuron" = the class
  assert.equal(pickBestTermId(search, 'lateral horn neuron'), 'FBbt_00048293')
  // STAGE-QUALIFIED PLURAL "adult lateral horn neurons" matches the named class
  // "adult lateral horn neuron" once singularised -> the class wins over the
  // region rule (the user asked about the neuron type, not the region).
  assert.equal(pickBestTermId(search, 'adult lateral horn neurons'), 'FBbt_00048293')
  // and the singular stage-qualified form is the same class
  assert.equal(pickBestTermId(search, 'adult lateral horn neuron'), 'FBbt_00048293')
  // while the stage-qualified region itself still resolves to the region
  assert.equal(pickBestTermId(search, 'adult lateral horn'), 'FBbt_00007053')
})

test('pickBestTermId drops species qualifiers so "Drosophila X" resolves like "X"', () => {
  // "adult Drosophila central brain" — VFB labels never contain "Drosophila", and
  // the glial cell ranks above the region in Solr. Must still pick the region.
  const search = { response: { docs: [
    { short_form: 'FBbt_00047885', label: 'adult central brain astrocyte-like glial cell', synonym: ['adult central brain astrocyte'] },
    { short_form: 'FBbt_00047887', label: 'adult central brain', synonym: ['midbrain'] }
  ] } }
  assert.equal(pickBestTermId(search, 'adult Drosophila central brain'), 'FBbt_00047887')
  assert.equal(pickBestTermId(search, 'Drosophila central brain'), 'FBbt_00047887')
})

test('pickBestTermId returns null for a generic descriptor phrase (no spurious top hit)', () => {
  // "major subdivisions" names no entity; Solr still returns "major mitochondrial
  // derivative" (shares only "major"). The resolver must NOT cite it.
  const search = { response: { docs: [
    { short_form: 'FBbt_00004952', label: 'major mitochondrial derivative', synonym: [], facets_annotation: ['Anatomy'] },
    { short_form: 'GENO_0000498', label: 'major polymorphic allele', synonym: [] }
  ] } }
  assert.equal(pickBestTermId(search, 'major subdivisions'), null)
  assert.equal(pickBestTermId(search, 'the main structure'), null)
  // but a real entity token still resolves via the guarded fallback (synonym match)
  const search2 = { response: { docs: [
    { short_form: 'FBbt_00003687', label: 'mushroom body pedunculus', synonym: ['peduncle'], facets_annotation: ['Anatomy'] }
  ] } }
  assert.equal(pickBestTermId(search2, 'peduncle'), 'FBbt_00003687')
})

test('maybeInjectConnectivityStep adds a connectivity step for a neuron + graph question', () => {
  const ledger = {
    plan: [{ id: 's1', tool: 'vfb_get_term_info', status: 'satisfied' }],
    terms: { 'giant fiber neuron': { id: 'FBbt_X', label: 'giant fiber neuron',
      digest: { name: 'giant fiber neuron' }, info: { SuperTypes: ['Class', 'Neuron', 'Adult'] } } }
  }
  maybeInjectConnectivityStep(ledger, 'What does the giant fiber neuron connect to downstream? Show a graph')
  const injected = ledger.plan.find(s => s.tool === 'vfb_find_connectivity_partners')
  assert.ok(injected, 'a connectivity step should be injected')
  assert.equal(injected.args.endpoint_type, 'giant fiber neuron')
  assert.equal(injected.args.direction, 'downstream')
})

test('maybeInjectScrnaseqStep injects the expression macro for a gene-expression question on a scRNAseq term', () => {
  const ledger = { plan: [{ id: 's1', tool: 'vfb_get_term_info', status: 'satisfied' }],
    terms: { 'Kenyon cell': { id: 'FBbt_00003686', label: 'Kenyon cell',
      digest: { name: 'Kenyon cell' }, info: { SuperTypes: ['Neuron', 'Anatomy', 'hasScRNAseq'] } } } }
  maybeInjectScrnaseqStep(ledger, 'which dopamine receptor genes do adult Kenyon cells express?')
  const inj = ledger.plan.find(s => s.tool === 'vfb_scrnaseq_gene_expression')
  assert.ok(inj, 'scRNAseq step injected')
  assert.equal(inj.args.neuron_type, 'Kenyon cell')
  // not for a term without scRNAseq data, and not for a non-expression question
  const noSc = { plan: [], terms: { x: { id: 'i', label: 'medulla', digest: { name: 'medulla' }, info: { SuperTypes: ['Anatomy'] } } } }
  maybeInjectScrnaseqStep(noSc, 'which genes does the medulla express?')
  assert.equal(noSc.plan.length, 0)
  const notExpr = { plan: [], terms: { x: { id: 'i', label: 'KC', digest: { name: 'Kenyon cell' }, info: { SuperTypes: ['Neuron', 'hasScRNAseq'] } } } }
  maybeInjectScrnaseqStep(notExpr, 'what is a Kenyon cell?')
  assert.equal(notExpr.plan.length, 0)
})

test('maybeInjectRegionNeuronCountStep injects the count tool for a region count question', () => {
  const ledger = { plan: [{ id: 's1', tool: 'vfb_get_term_info', status: 'satisfied' }],
    terms: { 'adult central brain': { id: 'FBbt_00047887', label: 'adult central brain',
      digest: { name: 'adult central brain' }, info: { SuperTypes: ['Anatomy', 'Synaptic_neuropil'] } } } }
  maybeInjectRegionNeuronCountStep(ledger, 'Approximately how many neurons are in the adult central brain?')
  const inj = ledger.plan.find(s => s.tool === 'vfb_get_region_neuron_count')
  assert.ok(inj, 'count step injected')
  assert.equal(inj.args.region, 'adult central brain')
  assert.equal(inj.args.include_literature, true)
  // not for a neuron type, and not for a non-count question
  const neuron = { plan: [], terms: { x: { id: 'i', label: 'x', digest: { name: 'KC' }, info: { SuperTypes: ['Neuron'] } } } }
  maybeInjectRegionNeuronCountStep(neuron, 'how many neurons connect to KC?')
  assert.equal(neuron.plan.length, 0)
  const noCount = { plan: [], terms: { r: { id: 'i', label: 'medulla', digest: { name: 'medulla' }, info: { SuperTypes: ['Anatomy'] } } } }
  maybeInjectRegionNeuronCountStep(noCount, 'What is the medulla?')
  assert.equal(noCount.plan.length, 0)
})

test('maybeInjectConnectivityStep: upstream wording, no double-inject, regions excluded', () => {
  // upstream
  const up = { plan: [], terms: { x: { id: 'i', label: 'x', digest: { name: 'MBON01' }, info: { Tags: ['Neuron'] } } } }
  maybeInjectConnectivityStep(up, 'what provides input to MBON01 upstream?')
  assert.equal(up.plan.find(s => s.tool === 'vfb_find_connectivity_partners').args.direction, 'upstream')
  // does not double-inject when a connectivity tool is already planned
  const has = { plan: [{ id: 's1', tool: 'vfb_query_connectivity', status: 'pending' }],
    terms: { x: { id: 'i', label: 'x', digest: { name: 'n' }, info: { SuperTypes: ['Neuron'] } } } }
  maybeInjectConnectivityStep(has, 'graph of connectivity')
  assert.equal(has.plan.filter(s => /connect/i.test(s.tool)).length, 1)
  // a REGION endpoint is not routed to the connectivity tool
  const region = { plan: [], terms: { medulla: { id: 'm', label: 'medulla', digest: { name: 'medulla' }, info: { SuperTypes: ['Anatomy', 'Synaptic_neuropil'] } } } }
  maybeInjectConnectivityStep(region, 'connectivity from the medulla in graph form')
  assert.equal(region.plan.length, 0)
  // no connectivity intent -> no injection
  const plain = { plan: [], terms: { x: { id: 'i', label: 'x', digest: { name: 'Kenyon cell' }, info: { SuperTypes: ['Neuron'] } } } }
  maybeInjectConnectivityStep(plain, 'what is a Kenyon cell?')
  assert.equal(plain.plan.length, 0)
})

test('plural cell phrase with no matching region resolves to the cell class', () => {
  const search = { response: { docs: [
    { short_form: 'FBbt_00003686', label: 'Kenyon cell', synonym: ['KC'], facets_annotation: ['Anatomy', 'Neuron', 'Cell'] },
    { short_form: 'FBbt_00100247', label: 'gamma Kenyon cell', synonym: [], facets_annotation: ['Anatomy', 'Neuron', 'Cell'] }
  ] } }
  // no region named "Kenyon", so "Kenyon cells" -> the cell class
  assert.equal(pickBestTermId(search, 'Kenyon cells'), 'FBbt_00003686')
})

test('synthesiser is given an AVAILABLE VFB DATA block from the term digest', async () => {
  const plan = {
    intent: 'region_connections', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['medulla'], steps: []
  }
  let synthMessages = null
  const deps = makeDeps({ plan })
  deps.tools = undefined
  // override runTool + callText to capture the synth prompt
  const baseRunTool = deps.runTool
  deps.runTool = async (name, args) => {
    if (name === 'vfb_get_term_info') return { Name: 'medulla', Id: 'FBbt_00003748', Meta: { Description: 'x' },
      Queries: [{ query: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in medulla', count: 262, preview_results: { rows: [] } }] }
    if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }
    return baseRunTool(name, args)
  }
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('Tell me about the medulla', deps)
  assert.ok(synthMessages, 'synth ran')
  assert.match(synthMessages[1].content, /AVAILABLE VFB DATA/)
  assert.match(synthMessages[1].content, /Neurons with presynaptic terminals in medulla \(262\)/)
  // the synthesiser must NOT be given the resolved id — a weak model writes ids
  // and mislinks. Linking is done deterministically by the backend registry.
  assert.ok(!/FBbt_00003748/.test(synthMessages[1].content), 'synth prompt must not contain ontology ids')
})

test('a step that ANSWERED suppresses the AVAILABLE VFB DATA fallback', async () => {
  // The block is a rescue for a thin ledger. Supplied alongside a real answer, the
  // system prompt's "point to the follow-up queries" appends the query catalogue
  // as a tail — which is the read-back defect, re-entering through the back door.
  // The follow-ons are already shown as chips beside the answer.
  const plan = {
    intent: 'neuron_profile', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['LPLC2'],
    steps: [{ id: 's1', tool: 'vfb_find_similar_neurons', answers: ['x'], args: { neuron_type: 'LPLC2' } }]
  }
  let synthMessages = null
  const deps = makeDeps({ plan })
  deps.toolDefs = [...TOOL_DEFS, { name: 'vfb_find_similar_neurons', purpose: 'nblast', parameters: { type: 'object', required: ['neuron_type'], properties: { neuron_type: { type: 'string' } } } }]
  const base = deps.runTool
  deps.runTool = async (name, args) => {
    if (name === 'vfb_get_term_info') return { Name: 'LPLC2', Id: 'FBbt_00111763',
      Queries: [{ query: 'ListAllAvailableImages', label: 'Images of LPLC2', count: 723, preview_results: { rows: [] } }] }
    if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00111763', label: 'LPLC2' }] } }
    if (name === 'vfb_find_similar_neurons') {
      return { tool: 'vfb_find_similar_neurons', resolved: { id: 'FBbt_00111763', label: 'LPLC2' },
        seed_neurons: [{ id: 'VFB_jrchk06p', label: 'LPLC2_R' }], neurons_compared: 100,
        self_class: { id: 'FBbt_00111763', label: 'LPLC2', neurons: 69, bestScore: 0.8 },
        similar_classes: [{ id: 'FBbt_00003874', label: 'lobula columnar neuron LC4', neurons: 30, bestScore: 0.46 }] }
    }
    return base(name, args)
  }
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('What neurons are similar to LPLC2?', deps)
  assert.ok(synthMessages, 'synth ran')
  assert.ok(!/AVAILABLE VFB DATA/.test(synthMessages[1].content), synthMessages[1].content.slice(0, 400))
})

test('a planner-chosen similarity step still gets the deterministic claim', async () => {
  // The injector sets step.similarity_query, but the planner picks this tool from
  // the catalogue on its own. That step used to reach the generic macro branch,
  // which read seed_neurons as the answer and reported the neurons compared FROM
  // as the neurons LPLC2 is similar TO — backwards, and confidently so.
  const plan = {
    intent: 'neuron_profile', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['LPLC2'],
    steps: [{ id: 's1', tool: 'vfb_find_similar_neurons', answers: ['x'], args: { neuron_type: 'LPLC2' } }]
  }
  let synthMessages = null
  const deps = makeDeps({ plan })
  deps.toolDefs = [...TOOL_DEFS, { name: 'vfb_find_similar_neurons', purpose: 'nblast', parameters: { type: 'object', required: ['neuron_type'], properties: { neuron_type: { type: 'string' } } } }]
  const base = deps.runTool
  deps.runTool = async (name, args) => {
    if (name === 'vfb_search_terms') return { response: { docs: [{ short_form: 'FBbt_00111763', label: 'LPLC2' }] } }
    if (name === 'vfb_get_term_info') return { Name: 'LPLC2', Id: 'FBbt_00111763', Queries: [] }
    if (name === 'vfb_find_similar_neurons') {
      return { tool: 'vfb_find_similar_neurons', resolved: { id: 'FBbt_00111763', label: 'LPLC2' },
        seed_neurons: [{ id: 'VFB_jrchk06p', label: 'LPLC2_R' }], neurons_compared: 100,
        self_class: { id: 'FBbt_00111763', label: 'LPLC2', neurons: 69, bestScore: 0.8 },
        similar_classes: [{ id: 'FBbt_00003874', label: 'lobula columnar neuron LC4', neurons: 30, bestScore: 0.46 }] }
    }
    return base(name, args)
  }
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('What neurons are similar to LPLC2?', deps)
  const ev = synthMessages[1].content
  assert.match(ev, /computed per registered neuron, not per class/)
  assert.match(ev, /lobula columnar neuron LC4/)
})

// --- unmatched names must not become false absences -------------------------

// Shared setup: a name the picker refuses to bind. "MBON-a1" shares no token
// with the spelled-out labels VFB returns, so pickBestTermId abstains — and
// before this fix the search result was discarded, the ledger stayed empty, and
// NEVER OVERCLAIM turned that emptiness into "VFB does not currently hold data
// on MBON-a1" about a term VFB very much holds under another name.
function unmatchedDeps(docs) {
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['MBON-a1'], steps: []
  }
  return makeDeps({ plan, tools: { vfb_search_terms: () => ({ response: { docs } }) } })
}

test('an unmatched name reaches the synthesiser as a failed lookup, with the candidates VFB offered', async () => {
  const deps = unmatchedDeps([
    { short_form: 'FBbt_00100234', label: 'mushroom body output neuron' },
    { short_form: 'FBbt_00100235', label: 'adult mushroom body' }
  ])
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  const r = await runHarness('What is MBON-a1?', deps)
  assert.equal(r.ledger.terms['MBON-a1'].id, null, 'the term stayed unresolved')
  assert.deepEqual(r.ledger.terms['MBON-a1'].candidates,
    ['mushroom body output neuron', 'adult mushroom body'], 'the near misses were kept')
  assert.ok(synthMessages, 'synth ran')
  const prompt = synthMessages[1].content
  assert.match(prompt, /UNMATCHED NAMES/)
  assert.match(prompt, /"MBON-a1" — not matched automatically/)
  assert.match(prompt, /mushroom body output neuron; adult mushroom body/)
  // The two instructions that stop the false absence: don't claim VFB lacks it,
  // and don't answer it from the model's own knowledge either.
  assert.match(prompt, /must NOT say VFB holds no data on them/)
  assert.match(prompt, /must NOT answer the question about them from your own knowledge/)
  // Candidate labels are prompt hints, not resolved entities — the id must still
  // never reach the synthesiser (it writes ids and mislinks).
  assert.ok(!/FBbt_00100234/.test(prompt), 'no ontology ids in the synth prompt')
})

test('a name VFB\'s search knows nothing about is worded differently from an ambiguous one', async () => {
  // [] candidates means the search itself came back empty. That is still a
  // failed lookup, not evidence of absence, but the synthesiser must be able to
  // tell the two apart — "no confident match among these" reads very
  // differently from "no hits for this wording".
  const deps = unmatchedDeps([])
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('What is MBON-a1?', deps)
  const prompt = synthMessages[1].content
  assert.match(prompt, /UNMATCHED NAMES/)
  assert.match(prompt, /"MBON-a1" — VFB's search returned nothing at all for this wording/)
  assert.ok(!/not matched automatically/.test(prompt), 'must not imply candidates were offered')
  // T2.7 showed that "differently worded" is not enough on its own. With two
  // unmatched names, one carrying candidates and one not, the model merged them
  // into a single sentence and filled the candidate slot for the name that had
  // none: "with search candidates including no relevant matches", "with
  // candidates including zero matching terms". So the empty branch has to deny
  // the slot outright rather than merely decline to open it.
  assert.match(prompt, /NO candidate list for this name/)
  // One unmatched name cannot be merged with another, so the merge instruction
  // is not paid for here.
  assert.ok(!/SEPARATE finding/.test(prompt), 'the multi-name rule stays out of a single-name prompt')
})

test('an unmatched name does not veto an answer the documentation already gave', async () => {
  // "How do I use the Virtual Fly Brain MCP tool?" came back as a request to
  // clarify which VFB term "Virtual Fly Brain MCP" meant — while the doc search
  // sat beside it. The instruction to ask which was meant is unconditional and
  // outranked the evidence. An unresolved name is a reason not to claim absence,
  // not a reason to withhold an answer found some other way.
  const plan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['the MCP tool'], steps: []
  }
  const deps = makeDeps({ plan, structured: {
    extract: () => ({ ok: true, value: { relevant: true, answered: true, claim: 'The MCP server is at mcp.virtualflybrain.org', verbatim: 'mcp.virtualflybrain.org' } })
  }, tools: {
    vfb_search_terms: () => ({ response: { docs: [] } }),
    search_reviewed_docs: () => ({ results: [{ id: 'mcp', title: 'VFB MCP', url: 'https://www.virtualflybrain.org/docs/mcp' }] }),
    get_reviewed_page: () => 'Point your MCP client at mcp.virtualflybrain.org.'
  } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('How do I use the VFB MCP tool?', deps)
  const prompt = synthMessages[1].content
  assert.match(prompt, /UNMATCHED NAMES/, 'still warned not to claim absence')
  assert.match(prompt, /must NOT say VFB holds no data on them/)
  assert.match(prompt, /Answer the question from the EVIDENCE above/)
  assert.ok(!/ask which was meant/.test(prompt), prompt)
})

test('the doc retrieve reads past a top hit that does not answer', async () => {
  // Search ranking is a keyword heuristic: for "How do I use the VFB MCP tool?"
  // it puts the Term Context page first (the word "context") and the MCP guide
  // second. Reading only the top hit turned a page that answers the question
  // into "consult the documentation".
  const plan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: [], steps: []
  }
  const fetched = []
  const deps = makeDeps({ plan, structured: {
    // Only the MCP guide answers; the first two pages are relevant-looking noise.
    extract: messages => /vfb-mcp-guide/.test(messages[1].content)
      ? { ok: true, value: { relevant: true, answered: true, claim: 'The MCP server is at mcp.virtualflybrain.org', verbatim: 'mcp.virtualflybrain.org' } }
      : { ok: true, value: { relevant: true, answered: false, claim: '', verbatim: '' } }
  }, tools: {
    search_reviewed_docs: () => ({ results: [
      { id: 'termcontext', title: 'The Term Context tab', url: 'https://www.virtualflybrain.org/docs/website-features/termcontext' },
      { id: 'mcp', title: 'VFB Model Context Protocol (MCP) Tool Guide', url: 'https://www.virtualflybrain.org/docs/tutorials/vfb-mcp-guide' },
      { id: 'tools', title: 'Tool landscape', url: 'https://www.virtualflybrain.org/docs/past-workshops/connectome/tools' }
    ] }),
    get_reviewed_page: ({ url }) => { fetched.push(url); return `page body for ${url}` }
  } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('How do I use the VFB MCP tool?', deps)
  assert.deepEqual(fetched.slice(0, 2), [
    'https://www.virtualflybrain.org/docs/website-features/termcontext',
    'https://www.virtualflybrain.org/docs/tutorials/vfb-mcp-guide'
  ])
  assert.ok(!fetched.includes('https://www.virtualflybrain.org/docs/past-workshops/connectome/tools'), 'stops at the first page that answers')
  assert.match(synthMessages[1].content, /mcp\.virtualflybrain\.org/)
  // …and having answered from a doc page, the synthesiser is told not to close
  // with "VFB does not currently hold instructions on this".
  assert.match(synthMessages[1].content, /DOCUMENTATION ANSWERED THIS/)
})

test('a docs question whose phrase is not an ontology term does not answer with the name failure', async () => {
  // "What do confidence values mean on VFB?" answered "The term 'confidence
  // values' could not be matched to a Virtual Fly Brain term ... I suggest
  // searching for it on virtualflybrain.org" — an ontology-lookup report for a
  // question about a UI feature, which was never going to have an ontology entry.
  const plan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['confidence values'], steps: []
  }
  const deps = makeDeps({ plan, structured: {
    extract: () => ({ ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } })
  }, tools: {
    vfb_search_terms: () => ({ response: { docs: [] } }),
    search_reviewed_docs: () => ({ results: [{ id: 'home', title: 'Virtual Fly Brain', url: 'https://virtualflybrain.org/' }] }),
    get_reviewed_page: () => 'Virtual Fly Brain is an interactive atlas.'
  } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('What do confidence values mean on Virtual Fly Brain?', deps)
  const prompt = synthMessages[1].content
  assert.match(prompt, /UNMATCHED NAMES/)
  assert.match(prompt, /not ontology terms VFB was ever going to hold/)
  assert.match(prompt, /documentation does not appear to cover this/)
  assert.ok(!/ask which was meant/.test(prompt), prompt)
})

test('a non-docs question with an unmatched name still asks which was meant', async () => {
  // The softer wording is scoped to documentation intent: for an anatomy
  // question a misspelt neuron name IS the thing to raise with the user.
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['MBON-a1'], steps: []
  }
  const deps = makeDeps({ plan, tools: { vfb_search_terms: () => ({ response: { docs: [] } }) } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('Tell me about MBON-a1', deps)
  assert.match(synthMessages[1].content, /ask which was meant/)
})

test('no documentation disclaimer block when nothing came from the docs', async () => {
  // The block contradicts the standing absence rule, so it must appear only
  // when a documentation page actually answered.
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['medulla'], steps: []
  }
  const deps = makeDeps({ plan, tools: {
    vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }),
    vfb_get_term_info: () => ({ Name: 'medulla', Id: 'FBbt_00003748', Meta: { Description: 'The second optic neuropil.' }, Queries: [] })
  } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('Tell me about the medulla', deps)
  assert.ok(!/DOCUMENTATION ANSWERED THIS/.test(synthMessages[1].content))
})

const MCP_PAGE = [
  'Quick start: use the hosted service, which requires no installation or setup.',
  '',
  '```json',
  '{',
  '  "mcpServers": {',
  '    "virtual-fly-brain": {',
  '      "type": "http",',
  '      "url": "https://vfb3-mcp.virtualflybrain.org"',
  '    }',
  '  }',
  '}',
  '```'
].join('\n')

function copyableDeps(question, quote) {
  const plan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: [], steps: []
  }
  return makeDeps({ plan, structured: {
    extract: () => ({ ok: true, value: { relevant: true, answered: true, claim: 'The hosted service needs no setup.', verbatim: quote } })
  }, tools: {
    search_reviewed_docs: () => ({ results: [{ id: 'mcp', title: 'VFB MCP tool guide', url: 'https://www.virtualflybrain.org/docs/tutorials/vfb-mcp-guide' }] }),
    get_reviewed_page: () => MCP_PAGE
  } })
}

test('a how-to page\'s block reaches the synthesiser even when the extractor quoted the prose', async () => {
  // The extractor returns one quote per page, and on a page carrying both a
  // prose quick-start and the configuration it describes, which one it picks is
  // a coin toss. Two runs in three quoted "use the hosted service, which
  // requires no installation" and the block never reached the synthesiser at
  // all — so the answer could not have included it however it was prompted.
  const deps = copyableDeps('How do I use the Virtual Fly Brain MCP tool?', 'use the hosted service, which requires no installation or setup')
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  const r = await runHarness('How do I use the Virtual Fly Brain MCP tool?', deps)
  const blocks = r.ledger.evidence.filter(e => /mcpServers/.test(e.verbatim || ''))
  assert.equal(blocks.length, 1, 'the block was added once, beside the extractor\'s quote')
  assert.match(blocks[0].verbatim, /"url": "https:\/\/vfb3-mcp\.virtualflybrain\.org"/)
  assert.equal(blocks[0].url, 'https://www.virtualflybrain.org/docs/tutorials/vfb-mcp-guide', 'attributed to the page it came from')
  // …and having a block in evidence is what turns on the instruction to fence it.
  assert.match(synthMessages[1].content, /fenced code block on its own lines/)
})

test('the page block is not added when the quote already carries one, nor to a question that did not ask how', async () => {
  const quoted = copyableDeps('How do I use the Virtual Fly Brain MCP tool?', '{\n  "mcpServers": {\n    "virtual-fly-brain": {}\n  }\n}')
  const rq = await runHarness('How do I use the Virtual Fly Brain MCP tool?', quoted)
  assert.equal(rq.ledger.evidence.filter(e => /mcpServers/.test(e.verbatim || '')).length, 1, 'not duplicated')

  // "What materials are available from the workshop?" is answered by the prose
  // on the page; a code sample lifted out of it answers a question nobody asked.
  const asked = copyableDeps('What materials are available from the VFB workshop?', 'the recorded introduction session and the workshop notebooks')
  const ra = await runHarness('What materials are available from the VFB workshop?', asked)
  assert.equal(ra.ledger.evidence.filter(e => /mcpServers/.test(e.verbatim || '')).length, 0)
})

test('a documentation question no page answered reports a DOCUMENTATION absence, not a data one', async () => {
  // "What are bridging registrations between brain templates in VFB?" and "When
  // did predicted neurotransmitters for EM data become available on VFB?" both
  // answered "VFB does not currently hold data on …" — a claim about the
  // ontology and the connectome, made about two questions that were never about
  // VFB's data holdings. Both are real gaps in the site's content; saying so is
  // true and useful, saying VFB holds no data on them is neither.
  const plan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: [], steps: []
  }
  const deps = makeDeps({ plan, structured: {
    extract: () => ({ ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } })
  }, tools: {
    search_reviewed_docs: () => ({ results: [{ id: 'home', title: 'Registration templates', url: 'https://www.virtualflybrain.org/docs/templates' }] }),
    get_reviewed_page: () => 'Virtual Fly Brain is an interactive atlas.'
  } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('What are bridging registrations between brain templates in VFB?', deps)
  const prompt = synthMessages[1].content
  assert.match(prompt, /NO PAGE ANSWERED THIS/)
  assert.match(prompt, /documentation does not appear to cover/)
  assert.match(prompt, /never "VFB does not currently hold data on/)
})

test('the documentation-absence wording survives a documentation question that resolved a term', async () => {
  // The bridging-registrations question resolves "brain templates" and reads its
  // term info, so a gate of "nothing retrieved and no term data" missed the very
  // answer it was written for. The block is conditional on an absence being
  // reported, not on there being nothing to say, so it is safe to keep here.
  const plan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['brain templates'], steps: []
  }
  const deps = makeDeps({ plan, structured: {
    extract: () => ({ ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } })
  }, tools: {
    vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003624', label: 'adult brain' }] } }),
    vfb_get_term_info: () => ({ Name: 'adult brain', Id: 'FBbt_00003624', Meta: { Description: 'The brain of the adult fly.' }, Queries: [{ query_type: 'PartsOf', label: 'Parts of adult brain', count: 28 }] }),
    search_reviewed_docs: () => ({ results: [{ id: 'templates', title: 'Templates', url: 'https://www.virtualflybrain.org/docs/templates' }] }),
    get_reviewed_page: () => 'Virtual Fly Brain is an interactive atlas.'
  } })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('What are bridging registrations between brain templates in VFB?', deps)
  assert.match(synthMessages[1].content, /NO PAGE ANSWERED THIS/)
})

test('the documentation-absence block stays away from questions that were answered', async () => {
  // Gated hard on purpose: it fires only when the answer was going to be an
  // absence in any case, so there is nothing here for it to talk out of a good
  // answer. A page that answered, or term data to be constructive with, is
  // enough to keep it out.
  const answeredPlan = {
    intent: 'documentation', underspecified: false, clarifying_question: '',
    terms_to_resolve: [], steps: []
  }
  const answered = makeDeps({ plan: answeredPlan, structured: {
    extract: () => ({ ok: true, value: { relevant: true, answered: true, claim: 'The MCP server is at mcp.virtualflybrain.org', verbatim: 'mcp.virtualflybrain.org' } })
  }, tools: {
    search_reviewed_docs: () => ({ results: [{ id: 'mcp', title: 'VFB MCP tool guide', url: 'https://www.virtualflybrain.org/docs/mcp' }] }),
    get_reviewed_page: () => 'Point your MCP client at mcp.virtualflybrain.org.'
  } })
  let answeredMessages = null
  answered.callText = async ({ messages }) => { answeredMessages = messages; return 'ANSWER' }
  await runHarness('How do I use the VFB MCP tool?', answered)
  assert.ok(!/NO PAGE ANSWERED THIS/.test(answeredMessages[1].content), 'a page answered')

  const dataPlan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['medulla'], steps: []
  }
  const data = makeDeps({ plan: dataPlan, tools: {
    vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }),
    vfb_get_term_info: () => ({ Name: 'medulla', Id: 'FBbt_00003748', Meta: { Description: 'The second optic neuropil.' }, Queries: [] })
  } })
  let dataMessages = null
  data.callText = async ({ messages }) => { dataMessages = messages; return 'ANSWER' }
  await runHarness('Tell me about the medulla', data)
  assert.ok(!/NO PAGE ANSWERED THIS/.test(dataMessages[1].content), 'not a documentation question')
})

test('no UNMATCHED NAMES block when every name resolved', async () => {
  // The block is a warning about a specific failure. Emitting it on a healthy
  // run would spend prompt budget and invite hedging on a well-grounded answer.
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['medulla'], steps: []
  }
  const deps = makeDeps({
    plan,
    tools: {
      vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }),
      vfb_get_term_info: () => ({ Name: 'medulla', Id: 'FBbt_00003748', Meta: { Description: 'The second optic neuropil.' }, Queries: [] })
    }
  })
  let synthMessages = null
  deps.callText = async ({ messages }) => { synthMessages = messages; return 'ANSWER' }
  await runHarness('Tell me about the medulla', deps)
  assert.ok(!/UNMATCHED NAMES/.test(synthMessages[1].content))
})

test('term-info returned for the WRONG id is discarded (no poisoned digest)', async () => {
  const plan = {
    intent: 'term_info', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['lateral horn'], steps: []
  }
  const deps = makeDeps({
    plan,
    tools: {
      vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00007053', label: 'adult lateral horn', facets_annotation: ['Anatomy', 'Synaptic_neuropil'] }] } }),
      // VFB returns a DIFFERENT term's info (the cell-body-rind, FBbt_00007647)
      vfb_get_term_info: () => ({ Name: 'cell body rind of adult lateral horn', Id: 'FBbt_00007647', Meta: { Name: '[cell body rind of adult lateral horn](FBbt_00007647)', Description: 'x' }, Queries: [{ query: 'NeuronsPartHere', label: 'wrong', count: 9, preview_results: { rows: [] } }] })
    }
  })
  const r = await runHarness('Tell me about the lateral horn', deps)
  const t = r.ledger.terms['lateral horn']
  assert.equal(t.id, 'FBbt_00007053', 'id from the search is kept')
  assert.equal(t.digest, null, 'mismatched term-info digest is discarded')
})

test('broaden ladder: a failing connectivity tool is recovered from the term digest', async () => {
  const MEDULLA = {
    Name: 'medulla', Id: 'FBbt_00003748', Meta: { Description: 'The second optic neuropil.' },
    Queries: [{ query: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in medulla', count: 120,
      preview_results: { rows: [{ label: '[Tm1](FBbt_1)' }, { label: '[Tm2](FBbt_2)' }] } }]
  }
  const plan = {
    intent: 'region_connections', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['medulla'],
    steps: [{ id: 's1', tool: 'vfb_query_connectivity', answers: ['what connects in the medulla'] }]
  }
  const deps = makeDeps({
    plan,
    structured: {
      // answer only when shown the digest (Available VFB data); never for an error blob
      extract: (messages) => /Available VFB data/.test(messages[1].content)
        ? { ok: true, value: { relevant: true, answered: true, claim: 'medulla has 120 presynaptic neuron types', verbatim: 'Tm1, Tm2' } }
        : { ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } },
      repair: () => ({ ok: true, value: { upstream_type: 'medulla' } })
    },
    tools: {
      vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00003748', label: 'medulla' }] } }),
      vfb_get_term_info: () => MEDULLA,
      vfb_query_connectivity: () => ({ error: 'anatomical regions are not accepted' })
    }
  })
  const r = await runHarness('What does the medulla connect to?', deps)
  assert.equal(r.ledger.plan[0].status, 'satisfied', 'step should be satisfied via the digest fallback')
  assert.ok(r.ledger.evidence.some(e => e.via === 'digest'), 'evidence should be tagged as recovered via digest')
})

test('region "inputs" question: term-info Queries digest reaches the extractor with counts', async () => {
  // P0 regression: "main input neurons to X" must be answerable from the
  // term-info NeuronsPresynapticHere preview (count + examples), not dead-end.
  const TERM_INFO = {
    Name: 'mushroom body', Id: 'FBbt_00005801',
    Meta: { Description: 'A neuropil ...' },
    Queries: [{ query: 'NeuronsPresynapticHere', label: 'Neurons with presynaptic terminals in mushroom body', count: 367,
      preview_results: { rows: [{ label: '[Li38](FBbt_20011419)' }, { label: '[Li39](FBbt_20011420)' }] } }]
  }
  const plan = {
    intent: 'region_connections', underspecified: false, clarifying_question: '',
    terms_to_resolve: ['mushroom body'],
    steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['main input neurons to the mushroom body'] }]
  }
  let sawDigest = false
  const deps = makeDeps({
    plan,
    structured: {
      // only "answer" when the extractor is shown the digest with the 367 count
      extract: (messages) => {
        if (/Neurons with presynaptic terminals in mushroom body: 367/.test(messages[1].content)) {
          sawDigest = true
          return { ok: true, value: { relevant: true, answered: true, claim: '367 neurons provide input', verbatim: 'Li38, Li39' } }
        }
        return { ok: true, value: { relevant: false, answered: false, claim: '', verbatim: '' } }
      },
      repair: () => ({ ok: true, value: { id: 'FBbt_00005801' } })
    },
    tools: {
      vfb_search_terms: () => ({ response: { docs: [{ short_form: 'FBbt_00005801', label: 'mushroom body' }] } }),
      vfb_get_term_info: () => TERM_INFO
    }
  })
  const r = await runHarness('What are the main input neurons to the mushroom body?', deps)
  assert.ok(sawDigest, 'extractor must see the digest with the 367 count')
  assert.ok(r.ledger.evidence.some(e => /input/.test(e.claim)), 'should have VFB evidence, not dead-end')
})

test('maybeInjectRegionGraphStep routes a region GRAPH request to the region summary tool', () => {
  // Task-battery G1. VFB has no region-level connectivity query, so left to itself
  // the planner reaches for vfb_run_query, gets the query catalogue back, and the
  // answer recites the list of available queries with zero graphs produced.
  const region = () => ({
    plan: [{ id: 's1', tool: 'vfb_get_term_info', status: 'satisfied' }],
    terms: { medulla: { id: 'FBbt_00003748', label: 'medulla', digest: { name: 'medulla' },
      info: { SuperTypes: ['Anatomy', 'Synaptic_neuropil'] } } }
  })

  const ledger = region()
  maybeInjectRegionGraphStep(ledger, 'what are the class summarised connectivity from the medulla in graph form')
  const inj = ledger.plan.find(s => s.tool === 'vfb_summarize_region_connections')
  assert.ok(inj, 'region summary step injected')
  assert.equal(inj.args.region, 'medulla')
  assert.equal(inj.status, 'pending')

  // idempotent
  maybeInjectRegionGraphStep(ledger, 'what are the class summarised connectivity from the medulla in graph form')
  assert.equal(ledger.plan.filter(s => s.tool === 'vfb_summarize_region_connections').length, 1)

  // needs BOTH graph intent and connectivity intent
  const noGraph = region()
  maybeInjectRegionGraphStep(noGraph, 'what connects to the medulla?')
  assert.equal(noGraph.plan.length, 1)
  const noConn = region()
  maybeInjectRegionGraphStep(noConn, 'show me the medulla in graph form')
  assert.equal(noConn.plan.length, 1)

  // and a region, not a neuron type (those go to maybeInjectConnectivityStep)
  const neuron = { plan: [], terms: { x: { id: 'i', label: 'Tm1', digest: { name: 'Tm1' }, info: { SuperTypes: ['Neuron', 'Anatomy'] } } } }
  maybeInjectRegionGraphStep(neuron, 'graph the connectivity of Tm1')
  assert.equal(neuron.plan.length, 0)
})
