// Issue #59: "what information does VFB have about EPG neurons" resolved to
// EPG-5L#3 (FAFB:4087066), one reconstructed cell, and the answer described that
// cell's partners as what VFB knows about EPG neurons. "EPG" is the class's
// symbol; the individuals carry it too, and "EPG neuron" matches their
// synonyms first. A name of the shape <symbol> <category noun> is a name for a
// type, so a resolution to an individual is lifted to the class the symbol
// names exactly.
//
// Run: node --test tests/unit/classLift.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runHarness, namesAType, stripEntityNoun, docIsIndividual } from '../../lib/orchestrator.mjs'

test('a symbol with a category noun after it names a type', () => {
  assert.equal(namesAType('EPG neurons'), true)
  assert.equal(namesAType('the EPG neuron'), true)
  assert.equal(namesAType('Kenyon cell types'), true)
  assert.equal(namesAType('EPG-5L#3 (FAFB:4087066)'), false)
  assert.equal(namesAType('medulla'), false)
  assert.equal(stripEntityNoun('EPG neurons'), 'EPG')
  assert.equal(stripEntityNoun('DA1 lPN cells'), 'DA1 lPN')
})

test('docIsIndividual reads the facets', () => {
  assert.equal(docIsIndividual({ facets_annotation: ['Entity', 'Individual', 'Neuron'] }), true)
  assert.equal(docIsIndividual({ facets_annotation: ['Entity', 'Class', 'Neuron'] }), false)
  assert.equal(docIsIndividual({}), false)
})

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' }, filter_types: { type: 'array' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]
const INSTANCE = { short_form: 'VFB_001012bq', label: 'EPG-5L#3 (FAFB:4087066)', original_label: 'EPG-5L#3 (FAFB:4087066)', synonym: ['PBG5-EBw-gall (left) neuron', 'EPG neuron'], facets_annotation: ['Entity', 'Individual', 'Neuron', 'Adult'] }
const CLASS = { short_form: 'FBbt_00047030', label: 'EPG (adult ellipsoid body-protocerebral bridge 1 glomerulus-dorsal/ventral gall neuron)', original_label: 'adult ellipsoid body-protocerebral bridge 1 glomerulus-dorsal/ventral gall neuron', synonym: ['EPG', 'E-PG neuron'], facets_annotation: ['Entity', 'Class', 'Neuron', 'Adult'] }

function makeDeps(question, term) {
  const calls = []
  return {
    calls, toolDefs: TOOL_DEFS, models: { planner: 'm', extract: 'm', synth: 'm' }, maxToolRounds: 4,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') return { ok: true, value: { intent: 'neuron_profile', underspecified: false, clarifying_question: '', terms_to_resolve: [term], steps: [] } }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') {
        calls.push({ q: args.query, filter: args.filter_types || null })
        // VFB's index: the plural finds nothing; the singular finds the FAFB
        // instances on their synonym; the bare symbol among classes finds the class.
        if (args.query === 'EPG neurons') return { response: { docs: [] } }
        if (args.query === 'EPG neuron') return { response: { docs: [INSTANCE] } }
        if (args.query === 'EPG' && (args.filter_types || []).includes('class')) return { response: { docs: [CLASS] } }
        if (args.query === 'EPG') return { response: { docs: [CLASS, INSTANCE] } }
        return { response: { docs: [] } }
      }
      if (name === 'vfb_get_term_info') {
        return args.id === 'FBbt_00047030'
          ? { Id: args.id, Name: 'adult ellipsoid body-protocerebral bridge 1 glomerulus-dorsal/ventral gall neuron', IsClass: true, SuperTypes: ['Class', 'Neuron'], Publications: [], Queries: [] }
          : { Id: args.id, Name: 'EPG-5L#3 (FAFB:4087066)', IsIndividual: true, SuperTypes: ['Individual', 'Neuron'], Publications: [], Queries: [] }
      }
      return { ok: true }
    }
  }
}

test('"EPG neurons" is lifted from the instance the singular found to the class the symbol names', async () => {
  const deps = makeDeps('what information does VFB have about EPG neurons', 'EPG neurons')
  const r = await runHarness('what information does VFB have about EPG neurons', deps)
  assert.equal(r.ledger.terms['EPG neurons'].id, 'FBbt_00047030')
  assert.ok(r.trace.some(e => e.resolve_lift_to_class === 'EPG neurons' && e.to === 'FBbt_00047030'), 'lift logged')
  assert.deepEqual(deps.calls.map(c => c.q), ['EPG neurons', 'EPG neuron', 'EPG'])
  assert.deepEqual(deps.calls[2].filter, ['class'])
})

// Issue #66: "what cell types are downstream of KCg?" resolved the bare symbol
// to KCg-d_R (FlyEM-HB:1003837184). VFB's index ranks hundreds of KCg-*
// individuals above the class whose symbol is "KCg", so the class never
// reached the rows the ladder saw and the token-superset guess took the first
// individual. No document matched "KCg" exactly; the class does, so it wins.
const KCG_INSTANCES = ['1003837184', '1004514584', '1004514714'].map((acc, i) => ({
  short_form: `VFB_jrchjw0${i}`,
  label: `KCg-d_R (KCg-d_R (FlyEM-HB:${acc}))`,
  original_label: `KCg-d_R (FlyEM-HB:${acc})`,
  facets_annotation: ['Entity', 'Individual', 'Neuron', 'Adult', 'has_neuron_connectivity']
}))
const KCG_CLASS = { short_form: 'FBbt_00100247', label: 'KCg (gamma Kenyon cell)', original_label: 'gamma Kenyon cell', synonym: ['KCg', 'gamma KC'], facets_annotation: ['Entity', 'Class', 'Neuron'] }

test('a bare symbol that landed on an instance by guess is lifted to the class the symbol names exactly (#66)', async () => {
  const deps = makeDeps('what cell types are downstream of KCg?', 'KCg')
  deps.runTool = (orig => async (name, args) => {
    if (name === 'vfb_search_terms') {
      deps.calls.push({ q: args.query, filter: args.filter_types || null })
      if ((args.filter_types || []).includes('class')) return { results: args.query === 'KCg' ? [KCG_CLASS] : [] }
      return { results: KCG_INSTANCES }
    }
    if (name === 'vfb_get_term_info') {
      return args.id === 'FBbt_00100247'
        ? { Id: args.id, Name: 'gamma Kenyon cell', IsClass: true, SuperTypes: ['Class', 'Neuron'], Publications: [], Queries: [] }
        : { Id: args.id, Name: 'KCg-d_R (FlyEM-HB:1003837184)', IsIndividual: true, SuperTypes: ['Individual', 'Neuron'], Publications: [], Queries: [] }
    }
    return orig(name, args)
  })(deps.runTool)
  const r = await runHarness('what cell types are downstream of KCg?', deps)
  assert.equal(r.ledger.terms.KCg.id, 'FBbt_00100247')
  assert.ok(r.trace.some(e => e.resolve_lift_to_class === 'KCg' && e.from === 'VFB_jrchjw00' && e.to === 'FBbt_00100247'), 'lift logged')
  const classCall = deps.calls.find(c => c.filter && c.filter.includes('class'))
  assert.ok(classCall && classCall.q === 'KCg', 'the symbol was searched among classes')
})

test('a bare name that matches an instance exactly (label sans accession) is not lifted', async () => {
  const deps = makeDeps('what is downstream of KCg-d_R?', 'KCg-d_R')
  deps.runTool = (orig => async (name, args) => {
    if (name === 'vfb_search_terms') {
      deps.calls.push({ q: args.query, filter: args.filter_types || null })
      // A class search would find a sibling symbol; it must never be made.
      if ((args.filter_types || []).includes('class')) return { results: [{ short_form: 'FBbt_00110932', label: 'KCg-d (gamma dorsal Kenyon cell)', original_label: 'gamma dorsal Kenyon cell', synonym: ['KCg-d'], facets_annotation: ['Entity', 'Class', 'Neuron'] }] }
      return { results: KCG_INSTANCES }
    }
    if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'KCg-d_R (FlyEM-HB:1003837184)', IsIndividual: true, SuperTypes: ['Individual', 'Neuron'], Publications: [], Queries: [] }
    return orig(name, args)
  })(deps.runTool)
  const r = await runHarness('what is downstream of KCg-d_R?', deps)
  assert.equal(r.ledger.terms['KCg-d_R'].id, 'VFB_jrchjw00')
  assert.ok(!r.trace.some(e => e.resolve_lift_to_class), 'no lift')
  assert.ok(!deps.calls.some(c => c.filter && c.filter.includes('class')), 'no class search')
})

test('a name that IS the instance label is left on the instance', async () => {
  const deps = makeDeps('what is EPG-5L#3 (FAFB:4087066) connected to?', 'EPG-5L#3 (FAFB:4087066)')
  deps.runTool = (orig => async (name, args) => {
    if (name === 'vfb_search_terms') { deps.calls.push({ q: args.query, filter: args.filter_types || null }); return { response: { docs: [INSTANCE] } } }
    return orig(name, args)
  })(deps.runTool)
  const r = await runHarness('what is EPG-5L#3 (FAFB:4087066) connected to?', deps)
  assert.equal(r.ledger.terms['EPG-5L#3 (FAFB:4087066)'].id, 'VFB_001012bq')
  assert.ok(!r.trace.some(e => e.resolve_lift_to_class), 'no lift')
})

// --- tied exact readings ------------------------------------------------------
//
// "KCg" is the symbol of BOTH "adult gamma Kenyon cell" and "gamma Kenyon cell".
// The question decides when it names a stage; the model is asked whether the
// question decides otherwise; and when neither can, the USER is asked, with the
// readings as options, rather than answered about VFB's first-ranked one.

import { exactTermMatchDocs, decideTiedReadingFromQuestion, askWhichReading } from '../../lib/orchestrator.mjs'

const KCG_ADULT = { short_form: 'FBbt_00049828', label: 'KCg (adult gamma Kenyon cell)', original_label: 'adult gamma Kenyon cell', synonym: ['KCg'], facets_annotation: ['Entity', 'Class', 'Neuron', 'Adult'] }
const KCG_ANY = { short_form: 'FBbt_00100247', label: 'KCg (gamma Kenyon cell)', original_label: 'gamma Kenyon cell', synonym: ['KCg', 'gamma KC'], facets_annotation: ['Entity', 'Class', 'Neuron'] }
const KCG_D = { short_form: 'FBbt_00110932', label: 'KCg-d (gamma dorsal Kenyon cell)', original_label: 'gamma dorsal Kenyon cell', synonym: ['KCg-d'], facets_annotation: ['Entity', 'Class', 'Neuron'] }

test('exactTermMatchDocs returns every document on the strongest rung, and nothing weaker', () => {
  const search = { results: [KCG_ADULT, KCG_ANY, KCG_D] }
  assert.deepEqual(exactTermMatchDocs(search, 'KCg').map(d => d.short_form), ['FBbt_00049828', 'FBbt_00100247'])
  // A label match outranks the synonym matches: no tie.
  assert.deepEqual(exactTermMatchDocs({ results: [KCG_ANY, { ...KCG_D, original_label: 'KCg', label: 'KCg (FBbt_x)', short_form: 'FBbt_x' }] }, 'KCg').map(d => d.short_form), ['FBbt_x'])
  assert.deepEqual(exactTermMatchDocs(search, 'KCg-d').map(d => d.short_form), ['FBbt_00110932'])
  assert.deepEqual(exactTermMatchDocs(search, 'nothing'), [])
})

test('a stage word in the question decides a tie; no stage word decides nothing', () => {
  assert.equal(decideTiedReadingFromQuestion('what is downstream of adult KCg?', [KCG_ADULT, KCG_ANY])?.short_form, 'FBbt_00049828')
  assert.equal(decideTiedReadingFromQuestion('larval KCg outputs', [KCG_ADULT, KCG_ANY]), null)
  assert.equal(decideTiedReadingFromQuestion('what cell types are downstream of KCg?', [KCG_ADULT, KCG_ANY]), null)
})

test('askWhichReading writes the clarifying question and the options', () => {
  const ledger = {}
  askWhichReading(ledger, 'KCg', [{ id: 'FBbt_00049828', label: 'adult gamma Kenyon cell' }, { id: 'FBbt_00100247', label: 'gamma Kenyon cell' }])
  assert.equal(ledger.underspecified, true)
  assert.equal(ledger.clarifyingQuestion, '"KCg" matches more than one VFB term: adult gamma Kenyon cell or gamma Kenyon cell. Which did you mean?')
  assert.deepEqual(ledger.clarifyOptions.map(o => o.id), ['FBbt_00049828', 'FBbt_00100247'])
  assert.ok(!/FBbt_/.test(ledger.clarifyingQuestion), 'no ids in the question')
})

function tiedDeps(question, { decide = -1 } = {}) {
  const deps = makeDeps(question, 'KCg')
  const orig = deps.callStructured
  deps.callStructured = async (req) => {
    if (req.schemaName === 'tied_term_reading') { deps.calls.push({ tie: JSON.parse(req.messages[1].content) }); return { ok: true, value: { choice: decide } } }
    return orig(req)
  }
  deps.runTool = async (name, args) => {
    if (name === 'vfb_search_terms') {
      deps.calls.push({ q: args.query, filter: args.filter_types || null })
      if ((args.filter_types || []).includes('class')) return { results: [KCG_ADULT, KCG_ANY, KCG_D] }
      return { results: KCG_INSTANCES }
    }
    if (name === 'vfb_get_term_info') return { Id: args.id, Name: args.id === 'FBbt_00049828' ? 'adult gamma Kenyon cell' : 'gamma Kenyon cell', IsClass: true, SuperTypes: ['Class', 'Neuron'], Publications: [], Queries: [] }
    return { ok: true }
  }
  return deps
}

test('a tie the question and the model cannot break asks the user, with the readings as options', async () => {
  const deps = tiedDeps('what cell types are downstream of KCg?')
  const r = await runHarness('what cell types are downstream of KCg?', deps)
  assert.equal(r.clarify, true)
  assert.equal(r.answer, '"KCg" matches more than one VFB term: adult gamma Kenyon cell or gamma Kenyon cell. Which did you mean?')
  assert.deepEqual(r.ledger.clarifyOptions.map(o => o.id), ['FBbt_00049828', 'FBbt_00100247'])
  assert.equal(r.ledger.terms.KCg.id, null)
  assert.equal(r.ledger.terms.KCg.ambiguous, true)
  const tie = deps.calls.find(c => c.tie)
  assert.ok(tie, 'the model was consulted')
  assert.deepEqual(tie.tie.candidates.map(c => c.label), ['adult gamma Kenyon cell', 'gamma Kenyon cell'])
  assert.ok(r.trace.some(e => e.resolve_ambiguous === 'KCg'), 'ambiguity logged')
  assert.ok(!r.trace.some(e => e.run_step), 'no step ran against an unchosen term')
})

test('a tie the model can break from the question is not asked about', async () => {
  const deps = tiedDeps('what cell types are downstream of KCg in the hemibrain?', { decide: 0 })
  const r = await runHarness('what cell types are downstream of KCg in the hemibrain?', deps)
  assert.ok(!r.clarify)
  assert.equal(r.ledger.terms.KCg.id, 'FBbt_00049828')
  assert.ok(r.trace.some(e => e.resolve_disambiguated === 'KCg' && e.via === 'model'), 'model decision logged')
})

test('a stage word settles the tie before the model is consulted', async () => {
  const deps = tiedDeps('what cell types are downstream of adult KCg?')
  const r = await runHarness('what cell types are downstream of adult KCg?', deps)
  assert.ok(!r.clarify)
  assert.equal(r.ledger.terms.KCg.id, 'FBbt_00049828')
  assert.ok(r.trace.some(e => e.resolve_disambiguated === 'KCg' && e.via === 'question'))
  assert.ok(!deps.calls.some(c => c.tie), 'model not consulted')
})
