// Offline end-to-end tests for the role-loop orchestrator, with mocked ELM/MCP.
// Run: node --test tests/unit/orchestrator_run.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHarness, pickBestTermId } from '../../lib/orchestrator.mjs'

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
  // unknown query falls back to the top-ranked valid id
  assert.equal(pickBestTermId(search, 'zzz'), 'FBbt_00005801')
})

test('pickBestTermId resolves a stage-prefixed region, not a containing-phrase neuron', () => {
  // "lateral horn" has no exact VFB label (they are stage-qualified). The neuron
  // is ranked first, but we must pick the region "adult lateral horn".
  const search = { response: { docs: [
    { short_form: 'FBbt_00110058', label: 'adult lateral horn Leucokinin neuron', synonym: [] },
    { short_form: 'FBbt_00007647', label: 'cell body rind of adult lateral horn', synonym: ['rLH'] },
    { short_form: 'FBbt_00007053', label: 'adult lateral horn', synonym: ['LH'] },
    { short_form: 'FBbt_00048293', label: 'adult lateral horn neuron', synonym: ['LHN'] }
  ] } }
  // region: shortest label containing {lateral, horn}
  assert.equal(pickBestTermId(search, 'lateral horn'), 'FBbt_00007053')
  // multi-word: "lateral horn neurons" (plural) -> the neuron class, not the
  // cell body rind or the Leucokinin neuron
  assert.equal(pickBestTermId(search, 'lateral horn neurons'), 'FBbt_00048293')
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
