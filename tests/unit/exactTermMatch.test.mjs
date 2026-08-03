// Tests for reading VFB search results as names rather than as display strings,
// and for the retry that follows from being able to tell an exact match apart
// from a guess.
//
// The symptom: "What genes are expressed in Kenyon cells?" answered about
// FBbt_00100247, "gamma Kenyon cell" — one arbitrary subtype of the thing that
// was asked about — and the earlier version of the same bug answered "VFB does
// not currently hold scRNA-seq expression data for KCab-p".
//
// Two causes, and the first is the interesting one.
//
// 1. VFB's search does not return a term's NAME in `label`. It returns a display
//    string: the string that matched, then the term's own label in parentheses,
//    or the term's short_form when the string that matched WAS the label:
//
//      label "Kenyon cell (FBbt_00003686)"   original_label "Kenyon cell"
//      label "Kenyon cell (ACA) (alpha/beta posterior Kenyon cell)"
//                                            original_label "alpha/beta posterior Kenyon cell"
//
//    Matching against `label` therefore could not fire the exact-label or
//    exact-synonym stages for ANY term — nothing is called "Kenyon cell
//    (FBbt_00003686)" — so every name in every question fell through to the
//    token-superset guess, with the parenthesised id contributing junk tokens to
//    that guess as well.
//
// 2. VFB's index does not stem multi-word phrases, so "Kenyon cells" returns 51
//    subtype documents with the general class absent ENTIRELY, while "Kenyon
//    cell" returns it at rank 6. Fixing (1) alone is not enough: the right
//    document is not in the result set to be matched.
//
// Run: node --test tests/unit/exactTermMatch.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  exactTermMatchId,
  pickBestTermId,
  searchCandidateLabels,
  runHarness
} from '../../lib/orchestrator.mjs'

// Verbatim from VFB3-MCP's search_terms for "Kenyon cell", trimmed to the fields
// the resolver reads. Note that the general class is NOT first.
const KENYON_SINGULAR = { results: [
  { label: 'Kenyon cell (ACA) (alpha/beta posterior Kenyon cell)', short_form: 'FBbt_00110931', original_label: 'alpha/beta posterior Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] },
  { label: "Kenyon cell (alpha'/beta' lobe anterior) (alpha'/beta' anterior-posterior Kenyon cell)", short_form: 'FBbt_00100250', original_label: "alpha'/beta' anterior-posterior Kenyon cell", facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] },
  { label: 'Kenyon cell (FBbt_00003686)', short_form: 'FBbt_00003686', original_label: 'Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell', 'hasScRNAseq'] },
  { label: 'Kenyon cells (gamma lobe) (gamma Kenyon cell)', short_form: 'FBbt_00100247', original_label: 'gamma Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] },
  { label: 'alpha/beta c(i) Kenyon cell (alpha/beta inner-core Kenyon cell)', short_form: 'FBbt_00049111', original_label: 'alpha/beta inner-core Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
] }

// The same search for the PLURAL. 51 documents in reality; the point is that
// FBbt_00003686 is not one of them.
const KENYON_PLURAL = { results: [
  { label: 'Kenyon cells (alpha/beta lobe core) (alpha/beta core Kenyon cell)', short_form: 'FBbt_00110929', original_label: 'alpha/beta core Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] },
  { label: 'Kenyon cells (gamma lobe) (gamma Kenyon cell)', short_form: 'FBbt_00100247', original_label: 'gamma Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] },
  { label: 'alpha/beta s Kenyon cell (alpha/beta surface Kenyon cell)', short_form: 'FBbt_00110930', original_label: 'alpha/beta surface Kenyon cell', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
] }

// --- reading the display string ---------------------------------------------

test('a term is matched on its own name, not on the display string', () => {
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'Kenyon cell'), 'FBbt_00003686')
  // The display string itself is not a name and must not match.
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'Kenyon cell (FBbt_00003686)'), null)
})

test('the string that matched counts as a synonym', () => {
  // "Kenyon cell (ACA)" is how FlyBase writes that subtype; it is what the user
  // typed, and the display string is the only place it appears.
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'Kenyon cell (ACA)'), 'FBbt_00110931')
  // A label whose parenthetical is the short_form contributes no synonym — that
  // parenthetical is not something anyone would type.
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'FBbt_00003686'), null)
})

test('a label containing its own brackets survives synonym extraction', () => {
  // "alpha/beta c(i) Kenyon cell" ends in a bracket that is NOT the display
  // suffix; stripping the wrong one would invent the synonym "alpha/beta c".
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'alpha/beta c(i) Kenyon cell'), 'FBbt_00049111')
})

test('a plural name matches the singular class once both are singularised', () => {
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'Kenyon cells'), 'FBbt_00003686')
})

test('exactTermMatchId returns null rather than guessing', () => {
  // These are all things the ladder below it would happily answer. This function
  // exists precisely so the retry can tell "VFB named it" from "VFB offered
  // something shaped like it".
  assert.equal(exactTermMatchId(KENYON_PLURAL, 'Kenyon cells'), null)
  assert.equal(exactTermMatchId(KENYON_SINGULAR, 'mushroom body'), null)
  assert.equal(exactTermMatchId(KENYON_SINGULAR, ''), null)
  assert.equal(exactTermMatchId(null, 'Kenyon cell'), null)
})

test('the full ladder prefers the exactly named class over its subtypes', () => {
  // Before the display string was read correctly this returned FBbt_00110931 —
  // the first document — because no exact stage could fire and the token rules
  // were comparing against "Kenyon cell (ACA) (alpha/beta posterior Kenyon cell)".
  assert.equal(pickBestTermId(KENYON_SINGULAR, 'Kenyon cell'), 'FBbt_00003686')
  assert.equal(pickBestTermId(KENYON_SINGULAR, 'Kenyon cells'), 'FBbt_00003686')
})

test('candidate labels offered to the user are names, not display strings', () => {
  // These are read out in the answer when nothing resolves. "Kenyon cells (gamma
  // lobe) (gamma Kenyon cell)" is not a thing to offer someone.
  assert.deepEqual(searchCandidateLabels(KENYON_PLURAL), [
    'alpha/beta core Kenyon cell',
    'gamma Kenyon cell',
    'alpha/beta surface Kenyon cell'
  ])
})

// --- the no-exact-match retry ------------------------------------------------

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

function makeDeps(byQuery, term) {
  const calls = { searches: [] }
  return {
    calls,
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 4,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') {
        return { ok: true, value: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: [term], steps: [] } }
      }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText() { return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') {
        calls.searches.push(args.query)
        return byQuery[args.query] || { results: [] }
      }
      if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'Kenyon cell', Publications: [] }
      return { ok: true }
    }
  }
}

test('a plural whose results omit the class is retried and resolves to the class', async () => {
  // The case that broke. The plural search is NOT empty — 51 documents — so the
  // no-hits retry cannot help; what is missing is the term itself.
  const deps = makeDeps({ 'Kenyon cells': KENYON_PLURAL, 'Kenyon cell': KENYON_SINGULAR }, 'Kenyon cells')
  const r = await runHarness('What genes are expressed in Kenyon cells?', deps)

  assert.deepEqual(deps.calls.searches, ['Kenyon cells', 'Kenyon cell'])
  assert.equal(r.ledger.terms['Kenyon cells'].id, 'FBbt_00003686')
  assert.ok(r.trace.some(e => e.resolve_retry === 'Kenyon cells' && e.reason === 'no-exact-match'))
})

test('a plural that already names the class exactly is not retried', async () => {
  // The guard is the ladder's own definition of an exact match, so a search that
  // has one must cost exactly one call and be decided by the ladder alone.
  const deps = makeDeps({ 'Kenyon cells': KENYON_SINGULAR }, 'Kenyon cells')
  const r = await runHarness('What genes are expressed in Kenyon cells?', deps)

  assert.deepEqual(deps.calls.searches, ['Kenyon cells'])
  assert.equal(r.ledger.terms['Kenyon cells'].id, 'FBbt_00003686')
  assert.ok(!r.trace.some(e => e.resolve_retry))
})

test('a retry that finds no exact match either is discarded, not preferred', async () => {
  // This is what keeps the region rule intact: "medulla neurons" has no
  // singular class called "medulla neuron", so the retry must leave the original
  // resolution — the region whose neurons were asked about — exactly as it was.
  const MEDULLA_PLURAL = { results: [
    { label: 'medulla (FBbt_00003748)', short_form: 'FBbt_00003748', original_label: 'medulla', facets_annotation: ['Entity', 'Class', 'Anatomy', 'Synaptic_neuropil'] },
    { label: 'medulla intrinsic neuron (FBbt_00003770)', short_form: 'FBbt_00003770', original_label: 'medulla intrinsic neuron', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
  ] }
  const MEDULLA_SINGULAR = { results: [
    { label: 'medulla intrinsic neuron (FBbt_00003770)', short_form: 'FBbt_00003770', original_label: 'medulla intrinsic neuron', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
  ] }
  const deps = makeDeps({ 'medulla neurons': MEDULLA_PLURAL, 'medulla neuron': MEDULLA_SINGULAR }, 'medulla neurons')
  const r = await runHarness('Which neurons are in the medulla?', deps)

  assert.deepEqual(deps.calls.searches, ['medulla neurons', 'medulla neuron'])
  assert.equal(r.ledger.terms['medulla neurons'].id, 'FBbt_00003748')
  assert.ok(!r.trace.some(e => e.resolve_retry))
})

// --- database accessions are provenance, not name ----------------------------

// Verbatim shape of what search_terms returns for "FANC": four unrelated human
// FANC-family genes, and one VFB individual whose label carries the string only
// inside its accession. The neuron is the ONLY document any token rule can bind
// "FANC" to, which is exactly why it used to win.
const FANC_SEARCH = { results: [
  { label: 'Fancl (FBgn0037781)', short_form: 'FBgn0037781', original_label: 'Fancl', facets_annotation: ['Entity', 'Gene'] },
  { label: 'FANCI (FBgn0033354)', short_form: 'FBgn0033354', original_label: 'FANCI', facets_annotation: ['Entity', 'Gene'] },
  { label: 'neuron 464 (FANC:494748)', short_form: 'VFB_001027ns', original_label: 'neuron 464 (FANC:494748)', facets_annotation: ['Entity', 'Individual', 'Neuron', 'Anatomy'] }
] }

test('a dataset acronym does not resolve to a neuron that carries it in an accession', () => {
  // "Where can I access the FAFB or FANC CATMAID datasets?" answered "Virtual
  // Fly Brain has detailed information available on neuron 464 (FANC:494748)".
  // Nobody who types FANC means neuron 494748.
  assert.equal(pickBestTermId(FANC_SEARCH, 'FANC'), null)
  assert.equal(pickBestTermId(FANC_SEARCH, 'FANC CATMAID'), null)
})

test('the same trap set by a tracer name embedded in a FAFB annotation', () => {
  // VFB's FAFB annotations carry the human tracer's name, so a search for a
  // forename returns a neuron. The accession is not what matches here — the
  // rule that saves this one is stage 4's distinctive-token gate — but the
  // neuron's own numbers must not be matchable either.
  const TRACER = { results: [
    { label: 'LHPV5d3#1 5807250 Jean-Claude ARJ (LHPV5d3#1 (FAFB:5807249))', short_form: 'VFB_0010128f', original_label: 'LHPV5d3#1 (FAFB:5807249)', facets_annotation: ['Entity', 'Individual', 'Neuron'] }
  ] }
  assert.equal(pickBestTermId(TRACER, 'FAFB'), null)
  assert.equal(pickBestTermId(TRACER, '5807249'), null)
})

test('an individual is still resolvable by its own name, accession and all', () => {
  // The strip is for matching only. A user who pastes the label back in, or who
  // names the neuron without its accession, must still land on it.
  assert.equal(pickBestTermId(FANC_SEARCH, 'neuron 464 (FANC:494748)'), 'VFB_001027ns')
  assert.equal(pickBestTermId(FANC_SEARCH, 'neuron 464'), 'VFB_001027ns')
  // And an ordinary class is untouched by any of this.
  assert.equal(pickBestTermId(KENYON_SINGULAR, 'Kenyon cell'), 'FBbt_00003686')
  assert.equal(pickBestTermId(FANC_SEARCH, 'Fancl'), 'FBgn0037781')
})
